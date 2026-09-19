/* Explicit, user-requested model assistance. Never runs from notifier hooks. */
(function(root){
 'use strict';
 function endpoint(value){const s=String(value||'').trim();if(!/^https:\/\/[a-z0-9.-]+(?::\d+)?\/[^\s]*$/i.test(s)&&!/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/[^\s]*$/i.test(s))throw new Error('설정에서 HTTPS AI endpoint 또는 localhost 주소를 입력하세요.');return s;}
 function create({Zotero,runtime}){
  let active=true;const jobs=new Set();
  async function run(task,item,{language='Korean'}={}){
   if(!active)throw new Error('플러그인이 비활성화되어 있습니다.');
   const prompts={translate:`Translate the supplied title into ${language}. Preserve scientific names, identifiers, negation and numbers. Return only the translation.`,summary:`Summarize only the supplied abstract in ${language}, up to 5 short bullet points. Preserve uncertainty and do not invent findings.`,tags:'Suggest 3-6 concise topical tags for this abstract. Return only a JSON array of strings.',remark:`Write a concise research reading remark in ${language}, based solely on the provided title and abstract. Separate findings from limitations.`};
   /* Several papers side by side: what each one claims, how it gets there,
      and where they pull against each other. The model is asked to keep to
      the abstracts given, to mark what it is unsure of, and to name the
      evidence that would settle each dispute -- an outline for the reader's
      own judgement, not a verdict. */
   prompts.compare=`You are helping a researcher read ${Array.isArray(item)?item.length:'several'} papers together. Using ONLY the supplied titles, abstracts and notes, write in ${language} (translate the section headings too), in Markdown:
## Each paper
For each paper (its number and a short title): **Core claim** (1-2 lines) · **Line of argument** (premise → evidence/method → conclusion, as an arrow chain) · **Strength and limits of the evidence** (be specific: sample, model system, controls, what the abstract does not show).
## Common ground
What the papers agree on or build on together.
## Points of contention
Every point where they conflict or would conflict: claim vs claim, assumption vs assumption, interpretation vs interpretation. For each: which papers, what each side rests on, and **the deciding evidence** — the experiment or data that would settle it.
## Open questions
What none of them answers.
Do not invent findings; where the abstracts are silent, say so. Preserve numbers, organisms, identifiers and negation.`;
   if(!prompts[task])throw new Error('Unknown assistance task');
   const capability={tags:'AIGenerateTags',remark:'AIGenerateRemark',summary:'tldr'}[task];if(capability&&runtime.featureEnabled?.(capability)===false)throw new Error('설정에서 이 기능을 켜세요.');
   if(task==='tags')prompts.tags=String(runtime.pref('aiTagsPrompt',prompts.tags)||prompts.tags);
   if(task==='remark')prompts.remark=String(runtime.pref('aiRemarkPrompt',prompts.remark)||prompts.remark)+'\nOutput language: '+language;
   const model=String(runtime.pref('aiModel','')).trim();if(!model)throw new Error('설정에서 AI 모델을 지정하세요.');
   const url=endpoint(runtime.pref('aiEndpoint',''));
   if(task==='compare'){
    const list=Array.isArray(item)?item:[];
    if(list.length<2)throw new Error('비교하려면 문헌을 둘 이상 선택하세요.');
    if(list.length>6)throw new Error('한 번에 여섯 편까지 비교할 수 있습니다.');
    const missing=list.filter(paper=>!String(paper.abstract||'').trim());
    if(missing.length)throw new Error(`초록이 없는 문헌이 있습니다: ${missing.map(paper=>String(paper.title||'').slice(0,40)).join(' · ')}`);
   }
   const content=task==='translate'?String(item.title||'')
    :task==='compare'?JSON.stringify(item.map((paper,index)=>({n:index+1,title:paper.title||'',year:paper.year||'',venue:paper.venue||'',abstract:paper.abstract||'',notes:[paper.remark,paper.summary].filter(Boolean).join('\n')||undefined})))
    :JSON.stringify({title:item.title||'',abstract:item.abstract||''});
   if(!content||task!=='translate'&&task!=='compare'&&!String(item.abstract||'').trim())throw new Error('먼저 논문의 제목과 초록을 가져오세요.');
   if(content.length>50000)throw new Error('선택한 텍스트가 너무 깁니다. 50,000자 이하로 줄이세요.');
   const headers={'Content-Type':'application/json'},key=runtime.pref('aiKey','');if(key)headers.Authorization='Bearer '+key;
   const job={cancel:null,cancelled:false,transportCancelled:false};jobs.add(job);
   const cancelTransport=()=>{if(job.cancel&&!job.transportCancelled){job.transportCancelled=true;try{job.cancel();}catch(_){}}};
   try{
    const result=await new Promise((resolve,reject)=>{
     let settled=false;
     const finish=(fn,value)=>{if(settled)return;settled=true;fn(value);};
     job.abort=()=>{job.cancelled=true;cancelTransport();finish(reject,new Error('요청이 중지되었습니다.'));};
     try{
      Promise.resolve(Zotero.HTTP.request('POST',url,{headers,body:JSON.stringify({model,messages:[{role:'system',content:prompts[task]},{role:'user',content}],store:false}),responseType:'json',timeout:60000,successCodes:false,errorDelayMax:0,cancellerReceiver:fn=>{job.cancel=fn;if(!active||job.cancelled)cancelTransport();}}))
       .then(value=>finish(resolve,value),error=>finish(reject,error));
     }catch(error){finish(reject,error);}
    });
    if(!active||job.cancelled)throw new Error('요청이 중지되었습니다.');
    if(result.status<200||result.status>=300)throw new Error('AI 서비스 응답 오류: HTTP '+result.status);
    const output=result.response?.choices?.[0]?.message?.content;if(typeof output!=='string'||!output.trim())throw new Error('AI 서비스가 텍스트를 반환하지 않았습니다.');
    if(output.length>100000)throw new Error('AI 서비스 응답이 너무 깁니다.');
    if(task==='tags'){let parsed;try{parsed=JSON.parse(output.replace(/^```(?:json)?\s*|\s*```$/g,''));}catch(_){throw new Error('태그 응답이 JSON 목록이 아닙니다.');}if(!Array.isArray(parsed)||!parsed.length||parsed.length>20||parsed.some(t=>typeof t!=='string'||!t.trim()||t.length>100||/[\r\n]/.test(t)))throw new Error('올바른 태그 목록이 아닙니다.');return [...new Set(parsed.map(t=>t.trim()))];}
    return output.trim();
   }catch(error){if(/^AI 서비스|요청|태그|올바른/.test(error.message))throw error;throw new Error('AI 요청을 완료하지 못했습니다. 연결 설정을 확인하세요.');}
   finally{jobs.delete(job);}
  }
  function cancel(){for(const job of jobs)job.abort?.();}
  function stop(){active=false;cancel();jobs.clear();}
  return {run,cancel,stop};
 }
 const api={create,endpoint};root.CustomStyleAssist=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);

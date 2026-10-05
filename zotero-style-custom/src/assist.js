/* Explicit, user-requested model assistance. Never runs from notifier hooks. */
(function(root){
 'use strict';
 function endpoint(value){const s=String(value||'').trim();if(!/^https:\/\/[a-z0-9.-]+(?::\d+)?\/[^\s]*$/i.test(s)&&!/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/[^\s]*$/i.test(s))throw new Error('설정에서 https로 시작하는 AI 서버 주소나 localhost 주소를 입력하세요.');return s;}
 /* Seconds without a byte before a paper request is given up. Not a total: a slow local model that keeps
    streaming is never cut off mid-answer, and one that is still thinking about a long prompt gets minutes. */
 const QUIET_STREAM_MS=180000,QUIET_WHOLE_MS=300000;
 /* The local AI bridge (bridge/ai-bridge.mjs): with no address in settings, the plugin looks for
    ~/Library/Application Support/StyleCustomBridge/bridge.json and talks to 127.0.0.1:<port> with the
    token kept there. The bridge answers with the Claude account first and the ChatGPT account when Claude
    cannot, and says which one answered in the x-bridge-provider header. An address in settings always wins. */
 const BRIDGE_LABEL={claude:'Claude 계정 (이 Mac)',codex:'ChatGPT 계정 (이 Mac)'};
 const BRIDGE_MODELS=/^(?:claude|sonnet|opus|haiku|fable|chatgpt)$/i;
 const BRIDGE_RECHECK_MS=30000;
 function bridgeConfig(text){
  let json;try{json=JSON.parse(String(text||''));}catch(_){return null;}
  const port=Number(json&&json.port),token=json&&json.token;
  if(!Number.isInteger(port)||port<1024||port>65535||typeof token!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(token))return null;
  return {port,token,url:`http://127.0.0.1:${port}/v1/chat/completions`};
 }
 function providerOf(response){
  try{const value=String(response&&response.getResponseHeader&&response.getResponseHeader('x-bridge-provider')||'').trim().toLowerCase();return value==='codex'||value==='claude'?value:null;}catch(_){return null;}
 }
 function create({Zotero,runtime,timers=null,io=null,paths=null}){
  let active=true;const jobs=new Set();
  const timer=timers||{set:(fn,ms)=>setTimeout(fn,ms),clear:id=>clearTimeout(id)};
  /* ---- bridge detection: read on every request (cheap), cached for the synchronous available() ---- */
  const bridgeState={config:null,checkedAt:0,loading:null,provider:null};let cancelEpoch=0;
  const fileIO=()=>io||runtime.io||(typeof IOUtils!=='undefined'?IOUtils:null);
  const pathTools=()=>paths||runtime.paths||(typeof PathUtils!=='undefined'?PathUtils:null);
  const explicitEndpoint=()=>String(runtime.pref('aiEndpoint','')||'').trim();
  function bridgePath(){
   const p=pathTools();if(!p)return null;
   /* PathUtils.homeDir is not there in every Gecko the plugin runs on (Zotero 9 measured: the bridge was
      never found), so the directory service's "Home" is the fallback, then $HOME. */
   let home=null;try{home=p.homeDir;}catch(_){}
   if(!home){try{const S=runtime.Services||(typeof Services!=='undefined'?Services:null),C=typeof Ci!=='undefined'?Ci:(typeof Components!=='undefined'?Components.interfaces:null);if(S&&C)home=S.dirsvc.get('Home',C.nsIFile).path;}catch(_){}}
   if(!home){try{const S=runtime.Services||(typeof Services!=='undefined'?Services:null);home=S?.env?.get?.('HOME')||null;}catch(_){}}
   if(!home)return null;
   return p.join(home,'Library','Application Support','StyleCustomBridge','bridge.json');
  }
  function detectBridge(){
   if(bridgeState.loading)return bridgeState.loading;
   bridgeState.loading=(async()=>{
    let config=null;
    try{
     const file=fileIO(),where=bridgePath();
     if(file&&where&&(!file.exists||await file.exists(where)))config=bridgeConfig(file.readUTF8?await file.readUTF8(where):new TextDecoder().decode(await file.read(where)));
    }catch(_){config=null;}
    if(!config||!bridgeState.config||bridgeState.config.port!==config.port)bridgeState.provider=null;
    bridgeState.config=config;bridgeState.checkedAt=Date.now();
    return config;
   })().finally(()=>{bridgeState.loading=null;});
   return bridgeState.loading;
  }
  // Look once at start, so the panel knows before the first request; failures stay silent.
  try{if(!explicitEndpoint())detectBridge().catch(()=>{});}catch(_){}
  async function run(task,item,{language='Korean'}={}){
   if(!active)throw new Error('플러그인이 꺼져 있습니다. 도구 → 부가 기능에서 Style Custom을 켜세요.');
   if(task==='paperSummary')return paperSummary(item,{language});
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
   // The user's own outline replaces the default, with the language kept.
   if(task==='compare'){const own=String(runtime.pref('aiComparePrompt','')||'').trim();if(own)prompts.compare=own+`\nWrite in ${language}. Use ONLY the supplied titles, abstracts and notes; do not invent findings.`;}
   if(!prompts[task])throw new Error('Unknown assistance task');
   const capability={tags:'AIGenerateTags',remark:'AIGenerateRemark',summary:'tldr'}[task];if(capability&&runtime.featureEnabled?.(capability)===false)throw new Error('설정에서 이 기능을 켜세요.');
   if(task==='tags')prompts.tags=String(runtime.pref('aiTagsPrompt',prompts.tags)||prompts.tags);
   if(task==='remark')prompts.remark=String(runtime.pref('aiRemarkPrompt',prompts.remark)||prompts.remark)+'\nOutput language: '+language;
   let target=resolve();if(typeof target.then==='function')target=await target;
   const {model,url,headers,bridge}=target;
   if(task==='compare'){
    const list=Array.isArray(item)?item:[];
    if(list.length<2)throw new Error('비교하려면 문헌을 둘 이상 선택하세요.');
    if(list.length>6)throw new Error('한 번에 여섯 편까지 비교할 수 있습니다. 몇 편을 빼고 다시 실행하세요.');
    const missing=list.filter(paper=>!String(paper.abstract||'').trim());
    if(missing.length)throw new Error(`초록이 없는 문헌이 있습니다: ${missing.map(paper=>String(paper.title||'').slice(0,40)).join(' · ')}`);
   }
   const content=task==='translate'?String(item.title||'')
    :task==='compare'?JSON.stringify(item.map((paper,index)=>({n:index+1,title:paper.title||'',year:paper.year||'',venue:paper.venue||'',abstract:paper.abstract||'',notes:[paper.remark,paper.summary].filter(Boolean).join('\n')||undefined})))
    :JSON.stringify({title:item.title||'',abstract:item.abstract||''});
   if(!content||task!=='translate'&&task!=='compare'&&!String(item.abstract||'').trim())throw new Error('먼저 논문의 제목과 초록을 가져오세요.');
   if(content.length>50000)throw new Error('선택한 텍스트가 너무 깁니다. 50,000자 이하로 줄이세요.');
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
    if(bridge)noteProvider(result);
    if(result.status<200||result.status>=300)throw statusError(result.status,bridge);
    const output=result.response?.choices?.[0]?.message?.content;if(typeof output!=='string'||!output.trim())throw new Error('AI 서버가 아무 내용도 보내지 않았습니다. 모델 이름을 확인하고 다시 시도하세요.');
    if(output.length>100000)throw new Error('AI 서버 응답이 너무 깁니다. 더 짧은 글을 고르거나 모델을 바꾸세요.');
    if(task==='tags'){let parsed;try{parsed=JSON.parse(output.replace(/^```(?:json)?\s*|\s*```$/g,''));}catch(_){throw new Error('AI가 태그를 목록으로 주지 않았습니다. 다시 시도하거나 다른 모델을 쓰세요.');}if(!Array.isArray(parsed)||!parsed.length||parsed.length>20||parsed.some(t=>typeof t!=='string'||!t.trim()||t.length>100||/[\r\n]/.test(t)))throw new Error('태그 목록으로 읽을 수 없는 답이 왔습니다. 다시 시도하세요.');return [...new Set(parsed.map(t=>t.trim()))];}
    return output.trim();
   }catch(error){if(error?.own||/^AI 서|요청|태그|올바른/.test(error.message))throw error;throw unreachable(bridge);}
   finally{jobs.delete(job);}
  }
  /* The paper itself, not just its abstract: three tasks that share one transport.
     paperSummary  one request, the summary of a paper from the text prepared by paper-chat.js
     chat          a conversation turn; streams when the server does (SSE), waits when it does not
     translateParagraphs  paragraph batches, for when DeepL is not set up
     Same rules as run(): only on an explicit call, only to the configured endpoint, the key only
     in the Authorization header, localhost or https only. */
  const chatTools=()=>root.CustomStylePaperChat||(typeof require==='function'?require('./paper-chat.js'):null);
  /* Where a request goes. An address in settings wins and needs a model; without one, the local bridge
     (if installed) answers, with its own token and never the API key from settings. */
  function explicitConfig(){
   const model=String(runtime.pref('aiModel','')).trim();if(!model)throw new Error('설정에서 AI 모델을 지정하세요.');
   const url=endpoint(runtime.pref('aiEndpoint',''));
   const headers={'Content-Type':'application/json'},key=runtime.pref('aiKey','');if(key)headers.Authorization='Bearer '+key;
   return {model,url,headers,bridge:false};
  }
  function bridgeRequest(config){
   const chosen=String(runtime.pref('aiModel','')||'').trim();
   return {model:BRIDGE_MODELS.test(chosen)?chosen.toLowerCase():'claude',url:config.url,headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.token},bridge:true};
  }
  /* Synchronous for an address in settings, so a request starts in the same tick as the call (cancel() right
     after run() must find it). The bridge needs one file read; a cancel() during that read still counts. */
  function resolve(){
   if(!active)throw new Error('플러그인이 꺼져 있습니다. 도구 → 부가 기능에서 Style Custom을 켜세요.');
   if(explicitEndpoint())return explicitConfig();
   return resolveBridge();
  }
  async function resolveBridge(){
   const epoch=cancelEpoch;
   const config=await detectBridge();
   if(epoch!==cancelEpoch||!active)throw new Error('요청이 중지되었습니다.');
   if(!config)throw new Error('설정에서 AI 서버 주소와 모델을 먼저 입력하세요. 이 Mac의 Claude·ChatGPT 계정을 쓰려면 bridge/install.sh로 AI 브리지를 설치하세요.');
   return bridgeRequest(config);
  }
  function noteProvider(response){const provider=providerOf(response);if(provider)bridgeState.provider=provider;}
  function statusError(code,bridge){
   if(bridge&&code===429){const e=new Error('이 Mac의 Claude·ChatGPT 계정 모두 사용 한도에 도달했습니다. 한도가 풀린 뒤 다시 시도하세요.');e.own=true;return e;}
   if(bridge&&(code===401||code===403)){bridgeState.checkedAt=0;const e=new Error('AI 브리지가 요청을 거절했습니다. 터미널에서 bridge/install.sh를 다시 실행하세요.');e.own=true;return e;}
   if(bridge&&code===502){const e=new Error('이 Mac의 Claude·ChatGPT 계정이 모두 답하지 못했습니다. 터미널에서 claude와 codex에 로그인되어 있는지 확인하세요.');e.own=true;return e;}
   return new Error('AI 서비스 응답 오류: HTTP '+code);
  }
  function unreachable(bridge){
   if(bridge){const e=new Error('이 Mac의 AI 브리지가 응답하지 않습니다. 터미널에서 bridge/install.sh를 다시 실행하세요.');e.own=true;return e;}
   return new Error('AI 요청을 완료하지 못했습니다. 연결 설정을 확인하세요.');
  }
  /* Synchronous, for the panels: an address in settings, or a bridge seen by the last look (refreshed in
     the background every 30 s, so a bridge installed while Zotero runs shows up without a restart). */
  function available(){return status().available;}
  function status(){
   if(!active)return {available:false,source:'none',provider:null,label:null};
   if(explicitEndpoint()){
    try{const {url}=explicitConfig();let host='';try{host=new URL(url).host;}catch(_){}return {available:true,source:'endpoint',provider:null,label:host||null};}
    catch(_){return {available:false,source:'endpoint',provider:null,label:null};}
   }
   if(!bridgeState.loading&&Date.now()-bridgeState.checkedAt>BRIDGE_RECHECK_MS){try{detectBridge().catch(()=>{});}catch(_){}}
   if(!bridgeState.config)return {available:false,source:'none',provider:null,label:null};
   const provider=bridgeState.provider||'claude';
   return {available:true,source:'bridge',provider,label:BRIDGE_LABEL[provider]};
  }
  /* `signal` is the caller's own cancel token ({cancelled, onCancel(fn)}): Stop on one chat cancels that request
     only, not a summary or a translation running beside it. `quietMs` is the inactivity limit (see QUIET_*). */
  async function transport(messages,{stream=false,onDelta=null,signal=null,quietMs=stream?QUIET_STREAM_MS:QUIET_WHOLE_MS}={}){
   let target=resolve();if(typeof target.then==='function')target=await target;
   const {model,url,headers,bridge}=target;
   const total=messages.reduce((n,m)=>n+String(m.content||'').length,0);
   if(total>120000)throw new Error('선택한 텍스트가 너무 깁니다. 50,000자 이하로 줄이세요.');
   if(signal&&signal.cancelled)throw new Error('요청이 중지되었습니다.');
   const job={cancel:null,cancelled:false,transportCancelled:false,quiet:null,timedOut:false};jobs.add(job);
   const cancelTransport=()=>{if(job.cancel&&!job.transportCancelled){job.transportCancelled=true;try{job.cancel();}catch(_){}}};
   const reader=stream?chatTools().streamReader((piece,all)=>{if(!job.cancelled&&onDelta)onDelta(piece,all);}):null;
   let eventStream=false,sniffed=false,off=()=>{};
   const stopQuiet=()=>{if(job.quiet!==null){timer.clear(job.quiet);job.quiet=null;}};
   try{
    const result=await new Promise((resolve,reject)=>{
     let settled=false;const finish=(fn,value)=>{if(settled)return;settled=true;stopQuiet();fn(value);};
     job.abort=()=>{job.cancelled=true;cancelTransport();finish(reject,new Error('요청이 중지되었습니다.'));};
     const quiet=()=>{stopQuiet();if(!quietMs||settled)return;job.quiet=timer.set(()=>{job.quiet=null;job.timedOut=true;job.cancelled=true;cancelTransport();
      const e=new Error('AI 서버가 한동안 아무것도 보내지 않아 중단했습니다. 서버가 켜져 있는지, 모델이 너무 크지 않은지 확인하세요.');e.own=true;finish(reject,e);},quietMs);};
     if(signal)off=signal.onCancel(()=>job.abort());
     // timeout 0: no limit on the whole request; the quiet timer above is the limit, reset by every byte that arrives.
     const options={headers,body:JSON.stringify({model,messages,store:false,...(stream?{stream:true}:{})}),timeout:0,successCodes:false,errorDelayMax:0,
      cancellerReceiver:fn=>{job.cancel=fn;if(!active||job.cancelled)cancelTransport();}};
     options.requestObserver=xhr=>{
      const read=()=>{
       quiet();
       if(!stream)return;
       try{
        if(!sniffed&&xhr.readyState>=2){sniffed=true;eventStream=chatTools().isEventStream(xhr.getResponseHeader&&xhr.getResponseHeader('Content-Type'));if(bridge)noteProvider(xhr);}
        if(eventStream&&xhr.readyState>=3)reader.update(xhr.responseText);
       }catch(_){}
      };
      try{xhr.addEventListener('progress',read);xhr.addEventListener('readystatechange',read);}catch(_){}
     };
     if(!stream)options.responseType='json';
     quiet();
     try{Promise.resolve(Zotero.HTTP.request('POST',url,options)).then(value=>finish(resolve,value),error=>finish(reject,error));}catch(error){finish(reject,error);}
    });
    if(!active||job.cancelled)throw new Error('요청이 중지되었습니다.');
    if(bridge)noteProvider(result);
    if(result.status<200||result.status>=300)throw statusError(result.status,bridge);
    let output;
    if(stream){
     const type=eventStream||/text\/event-stream/i.test(String(result.getResponseHeader&&result.getResponseHeader('Content-Type')||''));
     if(type){reader.update(result.responseText);output=reader.end();}
     else{
      // The server ignored stream:true and answered with one JSON document.
      let json=result.response;if(typeof json==='string'||json==null){try{json=JSON.parse(result.responseText||json);}catch(_){json=null;}}
      output=json&&json.choices&&json.choices[0]&&json.choices[0].message&&json.choices[0].message.content;
      if(typeof output==='string'&&output&&onDelta)onDelta(output,output);
     }
    }else output=result.response&&result.response.choices&&result.response.choices[0]&&result.response.choices[0].message&&result.response.choices[0].message.content;
    if(typeof output!=='string'||!output.trim())throw new Error('AI 서버가 아무 내용도 보내지 않았습니다. 모델 이름을 확인하고 다시 시도하세요.');
    if(output.length>100000)throw new Error('AI 서버 응답이 너무 깁니다. 더 짧은 글을 고르거나 모델을 바꾸세요.');
    return output.trim();
   }catch(error){if(error?.own||/^AI 서|요청|태그|올바른|설정|플러그인|선택한/.test(error.message))throw error;throw unreachable(bridge);}
   finally{stopQuiet();off();jobs.delete(job);}
  }
  async function paperSummary(input,{language='Korean',signal=null}={}){
   if(runtime.featureEnabled?.('tldr')===false)throw new Error('설정에서 이 기능을 켜세요.');
   const text=String(input&&input.text||'').trim();
   if(!text||!String(input.abstract||input.title||'').trim())throw new Error('먼저 논문의 제목과 초록을 가져오세요.');
   return transport([{role:'system',content:chatTools().summaryPrompt(language)},{role:'user',content:text}],{signal});
  }
  /* `messages` come from paper-chat.chatMessages(); onDelta(piece, all) is called as text arrives. */
  async function chat(messages,{onDelta=null,stream=true,signal=null}={}){
   if(!Array.isArray(messages)||!messages.length)throw new Error('질문을 입력하세요.');
   return transport(messages,{stream,onDelta,signal});
  }
  function parseTranslations(output,count){
   let parsed;try{parsed=JSON.parse(String(output).replace(/^```(?:json)?\s*|\s*```$/g,''));}catch(_){return null;}
   if(!Array.isArray(parsed)||parsed.length!==count)return null;
   const texts=parsed.map(x=>typeof x==='string'?x:x&&typeof x.text==='string'?x.text:null);
   return texts.some(x=>x===null||!x.trim())?null:texts.map(x=>x.trim());
  }
  async function translateParagraphs(texts,{language='Korean',signal=null}={}){
   const stopped=()=>{if(signal&&signal.cancelled)throw new Error('요청이 중지되었습니다.');};
   if(!Array.isArray(texts)||!texts.length)return [];
   const out=[];let group=[],size=0;const groups=[];
   for(const t of texts){if(group.length&&(size+t.length>6000||group.length>=8)){groups.push(group);group=[];size=0;}group.push(t);size+=t.length;}
   if(group.length)groups.push(group);
   const single=`Translate the supplied paragraph into ${language}. Keep numbers, units, DOIs, gene, species and chemical names and abbreviations as written. Return only the translation.`;
   for(const g of groups){
    stopped();
    if(g.length>1){
     const reply=await transport([{role:'system',content:`Translate each numbered paragraph into ${language}. Keep numbers, units, DOIs, gene, species and chemical names and abbreviations as written. Return ONLY a JSON array of ${g.length} strings, in the same order, nothing else.`},{role:'user',content:JSON.stringify(g.map((text,i)=>({n:i+1,text})))}],{signal});
     const parsed=parseTranslations(reply,g.length);if(parsed){out.push(...parsed);continue;}
    }
    for(const text of g){stopped();out.push(await transport([{role:'system',content:single},{role:'user',content:text}],{signal}));}
   }
   return out;
  }
  function cancel(){cancelEpoch++;for(const job of jobs)job.abort?.();}
  function stop(){active=false;cancel();jobs.clear();}
  // An explicit look, for callers that can wait (the self-check, a settings page opening).
  async function refresh(){if(explicitEndpoint())return status();await detectBridge().catch(()=>null);return status();}
  return {run,chat,paperSummary,translateParagraphs,available,status,refresh,cancel,stop};
 }
 const api={create,endpoint,bridgeConfig,BRIDGE_LABEL};root.CustomStyleAssist=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);

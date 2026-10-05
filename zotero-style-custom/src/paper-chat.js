/* What the AI is shown of a paper, and how an answer is read back.

   Pure: no DOM, no network, no Zotero. Everything here takes the structured
   paper ({title, abstract, sections:[{heading, page, paragraphs:[{sentences}]}],
   captions, references}) and returns text, a ranking or segments.

   Efficient context, no embeddings: the paper is cut once into section-level
   chunks; a question picks the few chunks that share its words (BM25 over
   lightly stemmed tokens, character bigrams for Korean), plus the abstract and
   the section on screen. A summary reads the abstract, the first paragraph of
   every section and more of the conclusion and discussion, inside a budget. */
(function(root){
 'use strict';
 const clean=text=>String(text==null?'':text).replace(/\s+/g,' ').trim();
 const SUMMARY_BUDGET=24000;            // characters, about 6,000 tokens
 const CHUNK_TARGET=900,CHUNK_MIN=220,TOP_CHUNKS=6,HISTORY_TURNS=6,EXCERPT_CHARS=1400;

 /* ---- tokens ----------------------------------------------------------- */
 const STOP=new Set('a an and are as at be been but by can could did do does for from had has have how if in into is it its may might more most no not of on or our so such than that the their then there these they this those to was we were what when where which while who why will with would you your also both each other some any all via per et al fig figure table'.split(' '));
 function stem(word){
  let w=word;
  if(w.length>5&&/ies$/.test(w))return w.slice(0,-3)+'y';
  for(const suffix of ['ations','ation','ingly','ings','ing','edly','ed','ly','es','s'])if(w.length>suffix.length+3&&w.endsWith(suffix))return w.slice(0,-suffix.length);
  return w;
 }
 function tokenize(text){
  const out=[];
  for(const m of String(text||'').toLowerCase().matchAll(/[가-힣]+|[\p{L}\p{N}][\p{L}\p{N}-]*/gu)){
   const raw=m[0];
   if(/^[가-힣]+$/.test(raw)){if(raw.length===1)out.push(raw);for(let i=0;i<raw.length-1;i++)out.push(raw.slice(i,i+2));continue;}
   if(raw.length<2||STOP.has(raw))continue;
   out.push(stem(raw));
  }
  return out;
 }

 /* ---- bilingual research terms ------------------------------------------
    A Korean question about an English paper shares no words with it. The common
    research terms are added in English, so "방법" finds Methods and "한계" finds
    the limitation in the Discussion. */
 const TERMS=[
  [/방법|방식|절차|프로토콜/,'method methods materials procedure protocol approach'],[/실험/,'experiment experimental assay'],
  [/결과|성과/,'result results finding findings'],[/한계|제한|약점/,'limitation limitations limit caveat weakness'],
  [/결론/,'conclusion conclusions'],[/논의|고찰|토의/,'discussion'],[/서론|도입|배경/,'introduction background'],
  [/그림|도표|도식/,'figure fig'],[/표\b|테이블/,'table'],[/데이터|자료/,'data dataset'],[/통계|유의/,'statistical statistics significance'],
  [/샘플|표본|시료/,'sample samples'],[/대조군|대조/,'control controls'],[/가설/,'hypothesis'],[/모델|모형/,'model'],
  [/성능|정확도/,'performance accuracy'],[/오차|오류/,'error'],[/재현/,'reproducibility replicate'],[/기여|의의|시사/,'contribution implication significance'],
  [/향후|후속|미래/,'future'],[/주장|핵심/,'claim main conclusion'],[/분석/,'analysis'],[/측정/,'measurement measured'],[/균주|세포주/,'strain strains cell line'],
  [/서열|시퀀싱/,'sequencing sequence'],[/요약|초록/,'abstract summary']
 ];
 const expandQuery=text=>{const s=String(text||'');const extra=TERMS.filter(([re])=>re.test(s)).map(([,en])=>en);return extra.length?s+' '+extra.join(' '):s;};

 /* ---- the part of the paper a section belongs to ----------------------- */
 const PART_HEAD=[
  ['methods',/^(?:(?:materials?|patients?|subjects?)\s+and\s+methods?|methods?(?:\s+(?:summary|details))?|online methods|experimental(?:\s+(?:procedures?|section|methods?|design))?|methodology|star\s*methods|방법|재료 및 방법|실험 방법)\b/i],
  ['results',/^(?:results?(?:\s+and\s+discussion)?|findings|결과)\b/i],
  ['discussion',/^(?:discussion|conclusions?|concluding remarks|summary and (?:outlook|conclusions?)|outlook|limitations?|perspectives?|논의|고찰|결론)\b/i],
  ['intro',/^(?:introduction|background|서론|배경)\b/i]
 ];
 /* Everything after these is the journal's own back matter (Nature's reporting summary, licences). */
 const BACK_HEAD=/^(?:acknowledge?ments?|references|bibliography|literature cited|funding|author contributions?|author information|competing interests?|conflicts? of interest|declarations?|data availability|code availability|data and code availability|online content|reporting summary|peer review(?: information)?|additional information|open access|ethics(?: declarations?)?|supplementary information|extended data|change history|rights and permissions|publisher.?s note|참고문헌|감사의 글|사사)\b/i;
 const isBackSection=s=>!!s&&(s.kind==='back'||s.kind==='references'||s.level==='back'||s.back===true||s.part==='back');
 function partsOf(structured){
  const sections=(structured&&structured.sections)||[];const out=[];let current=null,afterReporting=false;
  sections.forEach((s,i)=>{
   const heading=clean(s.heading).replace(/^(?:\d+(?:\.\d+)*|[IVX]+)[.)]?\s+/,'');
   if(/^reporting summary\b/i.test(heading))afterReporting=true;
   if(afterReporting||isBackSection(s)||BACK_HEAD.test(heading)){out.push('back');if(!afterReporting&&current&&current.level!==undefined)current=null;return;}
   // The extraction module's own part, where it is specific ("methods", "back"); "main" says only that it is body text.
   if(s.part==='methods'||s.part==='back'){out.push(s.part);current={part:s.part,level:Number(s.level)||1};return;}
   if(s.kind==='abstract'){out.push('abstract');current=null;return;}
   const hit=PART_HEAD.find(([,re])=>re.test(heading));
   const level=Number(s.level)||1;
   if(hit){out.push(hit[0]);current={part:hit[0],level,empty:!(s.paragraphs||[]).length};return;}
   // A subsection inherits its parent's part: deeper level, or the same level under an empty "Methods" header (Nature's layout).
   if(current&&(level>current.level||current.empty&&level===current.level)){out.push(current.part);return;}
   current=null;out.push('body');
  });
  return out;
 }

 /* ---- chunks ----------------------------------------------------------- */
 const textOf=p=>clean((p&&p.sentences||[]).map(s=>s.text).join(' '));
 const pageOf=p=>{const s=(p&&p.sentences||[]).find(x=>Number.isFinite(Number(x.page)));return s?Number(s.page):null;};
 function splitLong(text,max){
  if(text.length<=max)return [text];
  const sentences=text.split(/(?<=[.!?。])\s+/),out=[];let current='';
  for(const s of sentences){if(current&&(current+' '+s).length>max){out.push(current);current=s;}else current=current?current+' '+s:s;}
  if(current)out.push(current);
  return out.flatMap(piece=>{if(piece.length<=max*1.5)return [piece];const parts=[];for(let i=0;i<piece.length;i+=max)parts.push(piece.slice(i,i+max));return parts;});
 }
 /* One chunk is a paragraph or a few short ones from the same section. */
 function buildChunks(structured,{target=CHUNK_TARGET,pageBase=0}={}){
  const chunks=[];if(!structured)return chunks;
  const parts=partsOf(structured);
  const add=(section,sectionIndex,page,text,kind='body',part='body')=>{
   const body=clean(text);if(!body)return;
   const tokens=tokenize(section+' '+body),tf=new Map();for(const t of tokens)tf.set(t,(tf.get(t)||0)+1);
   chunks.push({id:chunks.length,section:clean(section),sectionIndex,page:Number.isFinite(Number(page))?Number(page)+pageBase:null,text:body,tf,length:tokens.length||1,kind,part});
  };
  if(clean(structured.abstract))add('Abstract',-1,1-pageBase,structured.abstract,'abstract','abstract');
  (structured.sections||[]).forEach((section,sectionIndex)=>{
   const part=parts[sectionIndex]||'body';
   if(part==='abstract'&&clean(structured.abstract))return;      // already in, once
   let buffer='',bufferPage=null;
   const flush=()=>{if(buffer){add(section.heading||'',sectionIndex,bufferPage??section.page,buffer,part==='abstract'?'abstract':'body',part);}buffer='';bufferPage=null;};
   for(const paragraph of section.paragraphs||[]){
    const text=textOf(paragraph);if(!text)continue;
    for(const piece of splitLong(text,target)){
     if(!buffer)bufferPage=pageOf(paragraph);
     if(buffer&&(buffer+' '+piece).length>target){flush();bufferPage=pageOf(paragraph);}
     buffer=buffer?buffer+' '+piece:piece;
     if(buffer.length>=CHUNK_MIN)flush();
    }
   }
   flush();
  });
  (structured.captions||[]).forEach(c=>{const text=clean(c&&c.text||(c&&c.sentences?textOf(c):c));if(text)add(c&&c.kind==='table'?'Table':'Caption',-3,c&&c.page,text,c&&c.kind==='table'?'table':'caption','caption');});
  const tables=Array.isArray(structured.tables)?structured.tables:(structured.skipped&&Array.isArray(structured.skipped.tables)?structured.skipped.tables:[]);
  tables.forEach(tb=>{const text=clean(tb&&(tb.text||tb.caption)||'');if(text)add('Table',-4,tb&&tb.page,text.slice(0,2000),'table','caption');});
  return chunks;
 }
 /* The section a page belongs to: the last one that starts on or before it. */
 function sectionAtPage(structured,page,{pageBase=0}={}){
  const sections=(structured&&structured.sections)||[];let found=-1;
  sections.forEach((s,i)=>{if(Number.isFinite(Number(s.page))&&Number(s.page)+pageBase<=page&&(s.paragraphs||[]).length)found=i;});
  return found;
 }

 /* ---- retrieval -------------------------------------------------------- */
 function rank(chunks,query,{k=TOP_CHUNKS,page=null,sectionIndex=-1,forcePage=false,intent=null}={}){
  if(!chunks.length)return [];
  const q=tokenize(expandQuery(query)),N=chunks.length,avg=chunks.reduce((n,c)=>n+c.length,0)/N||1;
  const df=new Map();for(const t of new Set(q))df.set(t,chunks.filter(c=>c.tf.has(t)).length);
  const K1=1.5,B=0.75;
  const scored=chunks.map(c=>{
   let score=0;
   for(const t of q){const f=c.tf.get(t);if(!f)continue;const n=df.get(t),idf=Math.log(1+(N-n+0.5)/(n+0.5));score+=idf*f*(K1+1)/(f+K1*(1-B+B*c.length/avg));}
   if(score>0&&sectionIndex>=0&&c.sectionIndex===sectionIndex)score*=1.25;
   if(score>0&&page&&c.page===page)score*=1.15;
   return {chunk:c,score};
  });
  const picked=new Map();
  const take=c=>{if(c&&!picked.has(c.id))picked.set(c.id,c);};
  const byScore=list=>list.slice().sort((a,b)=>b.score-a.score||a.chunk.id-b.chunk.id);
  take(chunks.find(c=>c.kind==='abstract'));
  // "This figure": the captions and tables of the page on screen first, then the body there.
  if(forcePage&&page){
   for(const c of chunks.filter(c=>c.page===page&&(c.kind==='caption'||c.kind==='table')).slice(0,4))take(c);
   for(const c of chunks.filter(c=>c.page===page&&c.kind==='body').slice(0,2))take(c);
  }
  if(sectionIndex>=0){
   const here=byScore(scored.filter(s=>s.chunk.sectionIndex===sectionIndex))[0];
   if(here)take(here.chunk);
  }
  // A quick prompt says which part of the paper it is about: the best chunks of that part, whatever language the question is in.
  const wanted=intent&&Array.isArray(intent.parts)?intent.parts:[];
  if(wanted.length){
   const room=Math.max(2,k-picked.size);let n=0;
   const near=c=>!(forcePage&&page)||c.page!==null&&Math.abs(c.page-page)<=1;   // "this figure" means a figure on or beside this page
   for(const s of byScore(scored.filter(s=>wanted.includes(s.chunk.part)&&near(s.chunk)))){if(n>=room)break;if(!picked.has(s.chunk.id)){take(s.chunk);n++;}}
  }
  const any=scored.some(s=>s.score>0);
  for(const s of byScore(scored)){
   if(picked.size>=k)break;if(s.score<=0)break;take(s.chunk);
  }
  // Nothing matched: the section on screen, the abstract (above) and the discussion, rather than two chunks.
  if(!any||picked.size<Math.min(3,chunks.length)){
   for(const c of chunks.filter(c=>sectionIndex>=0&&c.sectionIndex===sectionIndex).slice(0,2))if(picked.size<k)take(c);
   for(const part of ['discussion','results','intro'])if(picked.size<k)take(chunks.find(c=>c.part===part));
  }
  // Captions first when the page was asked about; otherwise document order.
  const out=[...picked.values()];
  return forcePage&&page?out:out.sort((a,b)=>a.id-b.id);
 }
 const where=c=>(c.section||'')+(c.page?(c.section?', ':'')+'p. '+c.page:'');
 const excerpt=(c,i)=>`[E${i+1}] (${where(c)}) ${c.text.slice(0,EXCERPT_CHARS)}`;

 /* ---- summary input ---------------------------------------------------- */
 const WIDE=/^(conclusions?|discussion|conclusions? and (?:outlook|future)|summary|results? and discussion|outlook|limitations?|결론|논의|고찰)\b/i;
 const SKIP=/^(acknowledge?ments?|references|bibliography|funding|author contributions?|competing interests?|conflicts? of interest|참고문헌|감사)/i;
 /* The budget goes to what a reader decides with: title, abstract and the list of sections always fit; back
    matter (availability statements, reporting summaries, licences) is left out; the methods get at most 15%. */
 function summaryInput(structured,{budget=SUMMARY_BUDGET,meta={},pageBase=0}={}){
  const title=clean(structured&&structured.title||meta.title).slice(0,400);
  const parts=partsOf(structured);
  const sections=((structured&&structured.sections)||[]).map((s,i)=>({...s,i,part:parts[i]})).filter(s=>(s.paragraphs||[]).length&&s.part!=='back'&&s.part!=='abstract'&&!SKIP.test(clean(s.heading)));
  const headings=sections.map(s=>({heading:clean(s.heading)||'(untitled)',page:Number.isFinite(Number(s.page))?Number(s.page)+pageBase:null}));
  let abstract=clean(structured&&structured.abstract||meta.abstract);
  if(abstract.length>budget*0.25)abstract=abstract.slice(0,Math.floor(budget*0.25))+'…';
  let list=headings.map(h=>h.heading.slice(0,90)+(h.page?' (p. '+h.page+')':''));
  const listRoom=Math.floor(budget*0.15);
  while(list.length>1&&list.join(' | ').length>listRoom)list=list.slice(0,-1);
  const listText=list.join(' | ')+(list.length<headings.length?' | …':'');
  const head=['TITLE: '+title,'ABSTRACT: '+(abstract||'(none)'),'SECTIONS: '+listText].join('\n');
  let pieces=sections.map(s=>{
   const wide=WIDE.test(clean(s.heading))||s.part==='discussion';
   const take=wide?Math.min(3,s.paragraphs.length):1,limit=wide?2400:900;
   const text=clean(s.paragraphs.slice(0,take).map(textOf).join(' ')).slice(0,limit);
   const rawPage=pageOf(s.paragraphs[0])??s.page,page=Number.isFinite(Number(rawPage))?Number(rawPage)+pageBase:null;
   return {label:`[${clean(s.heading)||'Text'}${page?', p. '+page:''}]`,text,wide,part:s.part};
  }).filter(p=>p.text);
  const lead='\n\nEXCERPTS (first paragraph of each section; more of the conclusion and discussion):\n';
  let room=Math.max(0,budget-head.length-lead.length),truncated=false;
  const size=list=>list.reduce((n,p)=>n+p.label.length+1+p.text.length+1,0);
  // The methods share at most 15% of the budget, cut evenly.
  const methods=pieces.filter(p=>p.part==='methods'),methodsRoom=Math.floor(budget*0.15);
  if(size(methods)>methodsRoom){truncated=true;const per=Math.max(60,Math.floor(methodsRoom/Math.max(1,methods.length))-20);let used=0;
   pieces=pieces.filter(p=>{if(p.part!=='methods')return true;if(used>=methodsRoom)return false;p.text=p.text.slice(0,Math.max(0,Math.min(per,methodsRoom-used-p.label.length-2)));used+=p.label.length+2+p.text.length;return p.text.length>0;});}
  if(size(pieces)>room){
   truncated=true;const scale=Math.max(0.2,room/size(pieces));
   pieces=pieces.map(p=>({...p,text:p.text.slice(0,Math.max(120,Math.floor(p.text.length*scale)))}));
   while(pieces.length&&size(pieces)>room){const last=pieces[pieces.length-1];if(last.text.length>160)last.text=last.text.slice(0,last.text.length-Math.max(40,size(pieces)-room));else pieces.pop();}
  }
  const body=pieces.map(p=>p.label+' '+p.text).join('\n');
  const text=(head+lead+body).slice(0,budget);
  return {text,title,abstract,headings,chars:text.length,truncated,sectionCount:pieces.length,parts:pieces.map(p=>({label:p.label,part:p.part,text:p.text}))};
 }
 const LANG_HEADINGS={Korean:['요약','핵심 결과','방법','한계','확인할 점'],English:['Summary','Key findings','Methods','Limitations','What to check']};
 function summaryPrompt(language='Korean'){
  const h=LANG_HEADINGS[language]||LANG_HEADINGS.English;
  return `You are helping a researcher decide how to read one paper. Use ONLY the supplied title, abstract, section headings and excerpts (each excerpt starts with [Section, p. N]). Write in ${language}. Output Markdown with exactly these five sections, headings as written:
## ${h[0]}
3 to 5 sentences: the question, the approach, the main result.
## ${h[1]}
Bullets. Each ends with (Section, p. N) naming where in the paper it comes from, copied from the excerpt markers.
## ${h[2]}
Two lines: the system or data used and how it was tested.
## ${h[3]}
Bullets: what the authors state, and what the excerpts suggest is not shown (mark the second kind "(inferred)").
## ${h[4]}
3 to 5 questions to check against the full text (controls, sample size, statistics, scope of the claim).
Do not invent numbers, results or citations. If the excerpts do not say something, write that they do not. Keep gene, species and chemical names and numbers exactly as given.`;
 }

 /* ---- chat ------------------------------------------------------------- */
 function chatSystemPrompt(language='Korean'){
  return `You answer questions about ONE paper for the researcher reading it. Answer only from the excerpts supplied below (each starts with [E#] (Section, p. N)) and the summary. After each claim cite where it comes from as (Section, p. N), copying the section and page from the excerpt. If the excerpts do not answer the question, say plainly that the paper, as far as supplied, does not say, and suggest where to look; never fill the gap from general knowledge without labelling it "(general knowledge, not from this paper)". Quote numbers exactly. Answer in ${language}; keep it short unless asked for detail.`;
 }
 /* The Korean text is the dictionary key (see i18n.js); `translate` turns it
    into the panel's language, so a button and the question it sends agree. */
 /* Each quick prompt carries the part of the paper it is about (its retrieval intent). */
 const QUICK={
  claim:{label:'핵심 주장',question:'이 논문의 핵심 주장은 무엇이고, 어떤 증거로 뒷받침하나요?',intent:{parts:['results','discussion']}},
  methods:{label:'방법 요약',question:'이 논문의 방법을 단계별로 요약해 주세요.',intent:{parts:['methods']}},
  limits:{label:'한계',question:'이 논문의 한계와 결과를 그대로 믿기 전에 확인할 점은 무엇인가요?',intent:{parts:['discussion','methods']}},
  figure:{label:'이 그림 설명해줘(현재 페이지)',question:'지금 보고 있는 쪽의 그림이나 표를 설명해 주세요. 무엇을 보여주고 어떻게 읽어야 하나요?',forcePage:true,intent:{parts:['caption']}},
  mine:{label:'내 연구와 관련?',question:'제 메모와 태그를 보면 이 논문이 제 연구와 어떻게 관련되나요?',mine:true,intent:null}
 };
 function quickPrompt(id,translate=x=>x){
  const q=QUICK[id];if(!q)return null;
  return {id,question:translate(q.question),forcePage:!!q.forcePage,mine:!!q.mine,intent:q.intent||null};
 }
 /* The messages for one question: system rules with the excerpts, the last few
    turns, and the question. The user's own notes go in only when asked for. */
 function chatMessages({question,history=[],chunks=[],summary='',language='Korean',viewing={},mine=null,forcePage=false,intent=null,turns=HISTORY_TURNS,k=TOP_CHUNKS}){
  const picked=rank(chunks,question+(mine?' '+(mine.tags||[]).join(' '):''),{k,page:viewing.page||null,sectionIndex:Number.isInteger(viewing.sectionIndex)?viewing.sectionIndex:-1,forcePage,intent});
  const parts=[chatSystemPrompt(language)];
  if(viewing.page)parts.push(`The reader is looking at page ${viewing.page}${viewing.section?' ('+viewing.section+')':''}.`);
  if(clean(summary))parts.push('SUMMARY OF THE PAPER (generated earlier):\n'+String(summary).slice(0,3000));
  parts.push('EXCERPTS:\n'+(picked.length?picked.map(excerpt).join('\n\n'):'(none matched)'));
  if(mine&&(clean(mine.memo)||(mine.tags||[]).length))parts.push('THE USER\'S OWN NOTES ON THIS PAPER (not part of the paper):\nTags: '+(mine.tags||[]).join(', ')+'\nMemo: '+clean(mine.memo).slice(0,2000));
  const kept=history.filter(m=>m&&(m.role==='user'||m.role==='assistant')&&clean(m.content)&&!m.error).slice(-turns*2).map(m=>({role:m.role,content:String(m.content).slice(0,4000)}));
  return {messages:[{role:'system',content:parts.join('\n\n')},...kept,{role:'user',content:String(question)}],picked:picked.map(c=>({id:c.id,section:c.section,page:c.page}))};
 }

 /* ---- page links in an answer ------------------------------------------ */
 /* "(Methods, p. 4; Results, pp. 6-7)" becomes text and cite segments; only
    a number inside parentheses counts, and only a real page of this paper. */
 function linkCitations(text,{pages=0}={}){
  const source=String(text==null?'':text),segments=[];let last=0;
  const group=/\([^()\n]{0,160}\)/g,ref=/\bpp?\.\s*(\d{1,4})(?:\s*[–-]\s*\d{1,4})?|(\d{1,4})\s*쪽(?:\s*[–-]\s*\d{1,4}\s*쪽)?/g;
  const push=(type,value,page)=>{if(!value)return;const prev=segments[segments.length-1];if(type==='text'&&prev&&prev.type==='text')prev.text+=value;else segments.push(type==='cite'?{type,text:value,page}:{type,text:value});};
  for(const g of source.matchAll(group)){
   if(!/\bpp?\.\s*\d|\d\s*쪽/.test(g[0]))continue;
   push('text',source.slice(last,g.index));
   let inner=0;const body=g[0];
   for(const r of body.matchAll(ref)){
    const page=Number(r[1]||r[2]);
    push('text',body.slice(inner,r.index));
    if(page>=1&&(!pages||page<=pages))push('cite',r[0],page);else push('text',r[0]);
    inner=r.index+r[0].length;
   }
   push('text',body.slice(inner));last=g.index+g[0].length;
  }
  push('text',source.slice(last));
  return segments;
 }

 /* ---- streaming -------------------------------------------------------- */
 /* Server-sent events from a Chat Completions server: lines "data: {json}"
    carrying choices[0].delta.content, ended by "data: [DONE]". update() takes
    the whole text received so far, as an XHR gives it, and reports only what is
    new. A plain JSON answer (a server that ignored stream:true) is read too. */
 function streamReader(onDelta){
  let seen=0,buffer='',text='',done=false,plain='';
  const line=raw=>{
   const s=raw.trim();if(!s||s.startsWith(':')||s.startsWith('event:'))return;
   const data=s.startsWith('data:')?s.slice(5).trim():s;
   if(data==='[DONE]'){done=true;return;}
   let json;try{json=JSON.parse(data);}catch(_){return;}
   const piece=json&&json.choices&&json.choices[0]&&(json.choices[0].delta&&json.choices[0].delta.content||json.choices[0].message&&json.choices[0].message.content)||json&&json.message&&json.message.content||'';
   if(typeof piece==='string'&&piece){text+=piece;onDelta&&onDelta(piece,text);}
  };
  return {
   update(full){
    const all=String(full||'');if(all.length<seen)return text;
    plain=all;buffer+=all.slice(seen);seen=all.length;
    const lines=buffer.split(/\r?\n/);buffer=lines.pop();for(const l of lines)line(l);
    return text;
   },
   /* The stream is over: the last line may have had no newline; a body that was
      one JSON document (not events) is parsed whole. */
   end(){
    if(buffer){line(buffer);buffer='';}
    if(!text&&plain.trim().startsWith('{')){try{const json=JSON.parse(plain);const piece=json.choices&&json.choices[0]&&json.choices[0].message&&json.choices[0].message.content;if(typeof piece==='string'){text=piece;onDelta&&onDelta(piece,text);}}catch(_){}}
    return text;
   },
   get text(){return text;},get done(){return done;}
  };
 }
 const isEventStream=contentType=>/text\/event-stream/i.test(String(contentType||''));

 const api={tokenize,stem,expandQuery,partsOf,buildChunks,sectionAtPage,rank,summaryInput,summaryPrompt,chatSystemPrompt,quickPrompt,chatMessages,linkCitations,streamReader,isEventStream,QUICK,SUMMARY_BUDGET,TOP_CHUNKS,HISTORY_TURNS,excerpt};
 root.CustomStylePaperChat=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);

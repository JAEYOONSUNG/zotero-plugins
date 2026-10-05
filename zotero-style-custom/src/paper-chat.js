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
  const add=(section,sectionIndex,page,text,kind='body')=>{
   const body=clean(text);if(!body)return;
   const tokens=tokenize(section+' '+body),tf=new Map();for(const t of tokens)tf.set(t,(tf.get(t)||0)+1);
   chunks.push({id:chunks.length,section:clean(section),sectionIndex,page:Number.isFinite(Number(page))?Number(page)+pageBase:null,text:body,tf,length:tokens.length||1,kind});
  };
  if(clean(structured.abstract))add('Abstract',-1,1-pageBase,structured.abstract,'abstract');
  (structured.sections||[]).forEach((section,sectionIndex)=>{
   let buffer='',bufferPage=null;
   const flush=()=>{if(buffer){add(section.heading||'',sectionIndex,bufferPage??section.page,buffer);}buffer='';bufferPage=null;};
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
  (structured.captions||[]).forEach(c=>{const text=clean(c&&c.text||(c&&c.sentences?textOf(c):c));if(text)add('Caption',-3,c&&c.page,text,'caption');});
  return chunks;
 }
 /* The section a page belongs to: the last one that starts on or before it. */
 function sectionAtPage(structured,page,{pageBase=0}={}){
  const sections=(structured&&structured.sections)||[];let found=-1;
  sections.forEach((s,i)=>{if(Number.isFinite(Number(s.page))&&Number(s.page)+pageBase<=page&&(s.paragraphs||[]).length)found=i;});
  return found;
 }

 /* ---- retrieval -------------------------------------------------------- */
 function rank(chunks,query,{k=TOP_CHUNKS,page=null,sectionIndex=-1,forcePage=false}={}){
  if(!chunks.length)return [];
  const q=tokenize(query),N=chunks.length,avg=chunks.reduce((n,c)=>n+c.length,0)/N||1;
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
  take(chunks.find(c=>c.kind==='abstract'));
  if(forcePage&&page)for(const c of chunks.filter(c=>c.page===page).slice(0,3))take(c);
  if(sectionIndex>=0){
   const here=scored.filter(s=>s.chunk.sectionIndex===sectionIndex).sort((a,b)=>b.score-a.score||a.chunk.id-b.chunk.id)[0];
   if(here)take(here.chunk);
  }
  for(const s of scored.slice().sort((a,b)=>b.score-a.score||a.chunk.id-b.chunk.id)){
   if(picked.size>=k)break;if(s.score<=0&&picked.size>=2)break;take(s.chunk);
  }
  return [...picked.values()].sort((a,b)=>a.id-b.id).slice(0,Math.max(k,picked.size));
 }
 const where=c=>(c.section||'')+(c.page?(c.section?', ':'')+'p. '+c.page:'');
 const excerpt=(c,i)=>`[E${i+1}] (${where(c)}) ${c.text.slice(0,EXCERPT_CHARS)}`;

 /* ---- summary input ---------------------------------------------------- */
 const WIDE=/^(conclusions?|discussion|conclusions? and (?:outlook|future)|summary|results? and discussion|outlook|limitations?|결론|논의|고찰)\b/i;
 const SKIP=/^(acknowledge?ments?|references|bibliography|funding|author contributions?|competing interests?|conflicts? of interest|참고문헌|감사)/i;
 function summaryInput(structured,{budget=SUMMARY_BUDGET,meta={},pageBase=0}={}){
  const title=clean(structured&&structured.title||meta.title),abstract=clean(structured&&structured.abstract||meta.abstract);
  const sections=((structured&&structured.sections)||[]).map((s,i)=>({...s,i})).filter(s=>(s.paragraphs||[]).length&&!SKIP.test(clean(s.heading)));
  const headings=sections.map(s=>({heading:clean(s.heading)||'(untitled)',page:Number.isFinite(Number(s.page))?Number(s.page)+pageBase:null}));
  const head=['TITLE: '+title,'ABSTRACT: '+(abstract||'(none)'),'SECTIONS: '+headings.map(h=>h.heading+(h.page?' (p. '+h.page+')':'')).join(' | ')].join('\n');
  const parts=sections.map(s=>{
   const wide=WIDE.test(clean(s.heading));
   const take=wide?Math.min(3,s.paragraphs.length):1,limit=wide?2400:900;
   const text=clean(s.paragraphs.slice(0,take).map(textOf).join(' ')).slice(0,limit);
   const rawPage=pageOf(s.paragraphs[0])??s.page,page=Number.isFinite(Number(rawPage))?Number(rawPage)+pageBase:null;
   return {label:`[${clean(s.heading)||'Text'}${page?', p. '+page:''}]`,text,wide};
  }).filter(p=>p.text);
  let body=parts.map(p=>p.label+' '+p.text).join('\n');
  const lead='\n\nEXCERPTS (first paragraph of each section; more of the conclusion and discussion):\n';
  let truncated=false,room=budget-head.length-lead.length;
  if(body.length>room){
   truncated=true;const scale=Math.max(0.2,room/body.length);
   body=parts.map(p=>{const cut=Math.max(160,Math.floor(p.text.length*scale));return p.label+' '+p.text.slice(0,cut);}).join('\n').slice(0,Math.max(0,room));
  }
  const text=head+lead+body;
  return {text,title,abstract,headings,chars:text.length,truncated,sectionCount:parts.length};
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
 const QUICK={
  claim:{label:'핵심 주장',question:'이 논문의 핵심 주장은 무엇이고, 어떤 증거로 뒷받침하나요?'},
  methods:{label:'방법 요약',question:'이 논문의 방법을 단계별로 요약해 주세요.'},
  limits:{label:'한계',question:'이 논문의 한계와 결과를 그대로 믿기 전에 확인할 점은 무엇인가요?'},
  figure:{label:'이 그림 설명해줘(현재 페이지)',question:'지금 보고 있는 쪽의 그림이나 표를 설명해 주세요. 무엇을 보여주고 어떻게 읽어야 하나요?',forcePage:true},
  mine:{label:'내 연구와 관련?',question:'제 메모와 태그를 보면 이 논문이 제 연구와 어떻게 관련되나요?',mine:true}
 };
 function quickPrompt(id,translate=x=>x){
  const q=QUICK[id];if(!q)return null;
  return {id,question:translate(q.question),forcePage:!!q.forcePage,mine:!!q.mine};
 }
 /* The messages for one question: system rules with the excerpts, the last few
    turns, and the question. The user's own notes go in only when asked for. */
 function chatMessages({question,history=[],chunks=[],summary='',language='Korean',viewing={},mine=null,forcePage=false,turns=HISTORY_TURNS,k=TOP_CHUNKS}){
  const picked=rank(chunks,question+(mine?' '+(mine.tags||[]).join(' '):''),{k,page:viewing.page||null,sectionIndex:Number.isInteger(viewing.sectionIndex)?viewing.sectionIndex:-1,forcePage});
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

 const api={tokenize,stem,buildChunks,sectionAtPage,rank,summaryInput,summaryPrompt,chatSystemPrompt,quickPrompt,chatMessages,linkCitations,streamReader,isEventStream,QUICK,SUMMARY_BUDGET,TOP_CHUNKS,HISTORY_TURNS,excerpt};
 root.CustomStylePaperChat=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);

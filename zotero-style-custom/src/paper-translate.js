/* Translating a paper paragraph by paragraph, in reading order.

   DeepL first (a key in the settings), then Translate for Zotero when it is
   installed, then the AI endpoint the reader configured. Nothing here starts by
   itself: translateAll() runs only when the panel calls it from a button press.

   A run is one job with its own cancel token: Stop (or closing the reader)
   cancels the request in flight, the back-off sleep between retries, and every
   paragraph still to go. The target language, the formality and the provider
   are fixed when the job starts, so changing the menu mid-run cannot file one
   language's text under another's key.
   The key is sent only to DeepL, in the Authorization header; nothing about the
   reader (no e-mail, no library data) is ever in a request.

   Pure and injectable: the HTTP call, the clock, the sleep, the cache and the
   usage counter all arrive from outside, so the tests run with none of them
   real. */
(function(root){
 'use strict';
 const FREE_URL='https://api-free.deepl.com/v2/translate',PRO_URL='https://api.deepl.com/v2/translate';
 const MAX_PARAGRAPH=3000,MAX_BATCH_COUNT=50,MAX_BATCH_BYTES=100*1024,FREE_LIMIT=500000;
 const clean=text=>String(text==null?'':text).replace(/\s+/g,' ').trim();
 const bytes=text=>{let n=0;for(const ch of String(text)){const c=ch.codePointAt(0);n+=c<0x80?1:c<0x800?2:c<0x10000?3:4;}return n;};

 /* ---- endpoint, language ------------------------------------------------ */
 const isFreeKey=key=>/:fx\s*$/i.test(String(key||'').trim());
 const deeplEndpoint=key=>isFreeKey(key)?FREE_URL:PRO_URL;
 const usageEndpoint=key=>deeplEndpoint(key).replace(/\/translate$/,'/usage');
 /* The panel's target choices. DeepL wants EN-US or EN-GB and ZH-HANS for the
    simplified script; the other names are how Translate for Zotero spells them. */
 const TARGETS=[
  {code:'KO',pdft:'ko-KR',ai:'Korean',label:'한국어',formality:false},{code:'EN-US',pdft:'en-US',ai:'English',label:'English',formality:false},
  {code:'JA',pdft:'ja-JP',ai:'Japanese',label:'日本語',formality:true},{code:'ZH-HANS',pdft:'zh-CN',ai:'Simplified Chinese',label:'中文(简体)',formality:false},
  {code:'DE',pdft:'de-DE',ai:'German',label:'Deutsch',formality:true},{code:'FR',pdft:'fr-FR',ai:'French',label:'Français',formality:true},{code:'ES',pdft:'es-ES',ai:'Spanish',label:'Español',formality:true}
 ];
 const targetOf=(setting,uiKorean)=>{
  const wanted=String(setting||'auto').toUpperCase();
  return TARGETS.find(t=>t.code===wanted)||(uiKorean?TARGETS[0]:TARGETS[1]);
 };
 /* Hash of a source paragraph: the cache key. FNV-1a over UTF-16 units, twice with different seeds. */
 function hash(text){
  const s=String(text);let a=0x811c9dc5,b=0x01000193^0xdeadbeef;
  for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);a^=c;a=Math.imul(a,0x01000193)>>>0;b^=c+i;b=Math.imul(b,0x85ebca6b)>>>0;}
  return a.toString(16).padStart(8,'0')+b.toString(16).padStart(8,'0')+s.length.toString(16);
 }
 /* The key also carries a revision of the settings that change the result (provider, target, formality, and for the
    AI provider its model and endpoint), never a secret: a new model or a formal register is a new translation. */
 const cacheKey=(provider,target,text,revision='')=>provider+'|'+target+'|'+(revision?revision+'|':'')+hash(clean(text));
 function settingsRevision({provider,target,formality='',model='',endpoint=''}){
  const parts=[provider,target,formality&&formality!=='default'?formality:''];
  if(provider==='ai')parts.push(String(model||'').trim(),String(endpoint||'').trim());
  return hash(parts.join('\u0001')).slice(0,10);
 }
 /* A cancel token: cancel() runs every registered canceller once; a sleep or a request that sees it cancelled stops. */
 function token(){
  const cancellers=new Set();
  const t={cancelled:false,
   onCancel(fn){if(t.cancelled){try{fn();}catch(_){}return ()=>{};}cancellers.add(fn);return ()=>cancellers.delete(fn);},
   cancel(){if(t.cancelled)return;t.cancelled=true;for(const fn of [...cancellers]){try{fn();}catch(_){}}cancellers.clear();}};
  return t;
 }
 const cancelledError=()=>{const e=new Error('중지했습니다.');e.code='cancelled';e.own=true;return e;};

 /* ---- paragraphs --------------------------------------------------------- */
 /* The body of the paper as paragraphs in reading order: one row per paragraph
    with its section, page and the rectangle to scroll to. Captions, the
    references and footnotes are not translated here. */
 function paragraphsOf(structured,{pageBase=0}={}){
  const out=[];if(!structured)return out;
  (structured.sections||[]).forEach((section,sectionIndex)=>{
   if(section.kind==='back'||section.kind==='references'||section.back===true)return;
   (section.paragraphs||[]).forEach((paragraph,paragraphIndex)=>{
    const sentences=(paragraph.sentences||[]).filter(s=>s&&clean(s.text));if(!sentences.length)return;
    const first=sentences.find(s=>Number.isFinite(Number(s.page)));
    const rects=sentences.flatMap(s=>s.rects||[]).filter(r=>Array.isArray(r)&&r.length>=4);
    out.push({id:sectionIndex+'.'+paragraphIndex,sectionIndex,heading:clean(section.heading),page:first?Number(first.page)+pageBase:(Number.isFinite(Number(section.page))?Number(section.page)+pageBase:null),rects:rects.slice(0,8),text:clean(sentences.map(s=>s.text).join(' '))});
   });
  });
  return out;
 }
 /* A paragraph over the limit is cut at sentence ends and put back together. */
 function splitParagraph(text,max=MAX_PARAGRAPH){
  const source=clean(text);if(source.length<=max)return [source];
  const parts=[];let current='';
  for(const sentence of source.split(/(?<=[.!?。])\s+/)){
   if(sentence.length>max){if(current){parts.push(current);current='';}for(let i=0;i<sentence.length;i+=max)parts.push(sentence.slice(i,i+max));continue;}
   if(current&&(current+' '+sentence).length>max){parts.push(current);current=sentence;}else current=current?current+' '+sentence:sentence;
  }
  if(current)parts.push(current);return parts;
 }
 /* Requests of at most 50 texts and 100 KB. `parts` are {key, text}. */
 function planBatches(parts,{maxCount=MAX_BATCH_COUNT,maxBytes=MAX_BATCH_BYTES}={}){
  const batches=[];let current=[],size=0;
  for(const part of parts){
   const n=bytes(part.text);
   if(current.length&&(current.length>=maxCount||size+n>maxBytes)){batches.push(current);current=[];size=0;}
   current.push(part);size+=n;
  }
  if(current.length)batches.push(current);return batches;
 }

 /* ---- DeepL ------------------------------------------------------------- */
 function buildRequest(key,texts,{target,formality='',source=''}={}){
  const body={text:texts,target_lang:target.code,split_sentences:'nonewlines',preserve_formatting:true};
  if(source)body.source_lang=source;
  if(formality&&formality!=='default'&&target.formality)body.formality=formality;   // refused for languages without a formal register
  return {url:deeplEndpoint(key),headers:{'Content-Type':'application/json','Authorization':'DeepL-Auth-Key '+String(key).trim()},body:JSON.stringify(body)};
 }
 function deeplError(status,json){
  const message=String(json&&json.message||'').slice(0,160);
  const make=(code,text,retry=false)=>{const e=new Error(text);e.code=code;e.status=status;e.retry=retry;e.own=true;return e;};
  if(status===456)return make('quota','DeepL 무료 한도를 다 썼습니다. 다음 달에 다시 시도하거나 설정에서 다른 번역기를 고르세요.');
  // Too many requests in a short time, not the monthly quota (that is 456): it clears in a moment.
  if(status===429)return make('rate','DeepL에 요청이 잠시 몰렸습니다. 잠시 후 다시 시도하세요.',true);
  if(status===403||status===401)return make('key','DeepL 키가 올바르지 않거나 이 주소에서 쓸 수 없습니다. 설정에서 키를 확인하세요. 무료 키는 :fx로 끝납니다.');
  if(status===400){const e=make('bad','DeepL이 요청을 받지 않았습니다.');e.detail=message;return e;}
  if(status===413||status===414)return make('big','DeepL에 보낸 글이 너무 큽니다.');
  if(status>=500||status===0)return make('server','DeepL 서버가 응답하지 않습니다. 잠시 뒤 다시 시도합니다.',true);
  return make('failed','DeepL 응답 오류: HTTP '+status);
 }

 /* ---- the translator -------------------------------------------------------- */
 function create({http,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=()=>new Date(),pref=()=>'',cache=null,usageStore=null,pdfTranslate=()=>null,ai=null,uiKorean=true,retries=3}={}){
  const memory=new Map(),store=cache||{get:k=>memory.get(k),set:(k,v)=>memory.set(k,v),save:async()=>{}};
  let running=null;const tokens=new Set();
  const monthKey=()=>{const d=now();return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');};
  // A paid key has whatever limit its plan has: unknown until DeepL says, never assumed to be the free 500,000.
  const defaultLimit=()=>isFreeKey(deeplKey())?FREE_LIMIT:null;
  const usageLoad=()=>{const u=(usageStore&&usageStore.get&&usageStore.get())||null;return u&&u.month===monthKey()?{...u}:{month:monthKey(),chars:0,limit:defaultLimit(),fromServer:false};};
  const usageSave=u=>{if(usageStore&&usageStore.set)usageStore.set(u);};
  const deeplKey=()=>String(pref('deeplApiKey')||'').trim();
  const target=()=>targetOf(pref('translateTarget'),uiKorean);
  const formality=()=>String(pref('translateFormality')||'');
  /* DeepL, then Translate for Zotero, then the AI endpoint (which may cost per token). */
  const providers=()=>{
   const out=[];if(deeplKey())out.push('deepl');
   const api=pdfTranslate();if(api&&typeof api.translate==='function')out.push('pdftranslate');
   if(ai&&ai.available&&ai.available())out.push('ai');
   return out;
  };
  /* What a job is fixed to when it starts. */
  const settingsFor=(provider,targetCode)=>{
   const t=TARGETS.find(x=>x.code===targetCode)||target(),f=formality();
   return {provider,target:t,formality:f,revision:settingsRevision({provider,target:t.code,formality:f,model:pref('aiModel'),endpoint:pref('aiEndpoint')})};
  };
  const keyFor=(settings,text)=>cacheKey(settings.provider,settings.target.code,text,settings.revision);
  const providerLabel=id=>({deepl:isFreeKey(deeplKey())?'DeepL Free':'DeepL',pdftranslate:'Translate for Zotero',ai:'AI'}[id]||id);
  /* The usage the panel shows: what this plugin counted this month, or what DeepL said when last asked. */
  const usage=()=>{const u=usageLoad(),limit=Number(u.limit)>0?Number(u.limit):defaultLimit();return {month:u.month,chars:u.chars,limit,remaining:limit===null?null:Math.max(0,limit-u.chars),fromServer:!!u.fromServer,free:isFreeKey(deeplKey())};};
  /* DeepL's own count and limit (free of charge to ask). */
  async function refreshUsage({signal=null}={}){
   const key=deeplKey();if(!key){const e=new Error('설정에서 DeepL 키를 먼저 입력하세요.');e.code='nokey';e.own=true;throw e;}
   const response=await http('GET',usageEndpoint(key),{headers:{'Authorization':'DeepL-Auth-Key '+key},signal});
   if(response.status<200||response.status>=300)throw deeplError(response.status,response.json);
   const json=response.json||{};
   const limit=Number(json.character_limit)>0?Number(json.character_limit):defaultLimit();
   const u={month:monthKey(),chars:Number(json.character_count)||0,limit,fromServer:true};usageSave(u);return usage();
  }
  const addUsage=n=>{const u=usageLoad();u.chars+=n;u.fromServer=false;usageSave(u);};

  /* What a run would cost before it starts: only paragraphs not already cached count. */
  /* For the AI provider, also the tokens it will be billed for: about four characters a token going in, and the
     translation coming back about as long again (more for Korean and Japanese, so it is rounded up). */
  function estimate(paragraphs,provider=providers()[0],targetCode=null){
   const settings=settingsFor(provider||'x',targetCode||target().code);let chars=0,cached=0,fresh=0;
   for(const p of paragraphs){if(store.get(keyFor(settings,p.text))){cached++;continue;}fresh++;chars+=clean(p.text).length;}
   const u=usage();
   const tokens=provider==='ai'?Math.ceil(chars/4)+Math.ceil(chars/4*1.5):0;
   return {provider,paragraphs:paragraphs.length,cached,fresh,chars,tokens,limit:u.limit,remaining:u.remaining,free:u.free,fits:provider!=='deepl'||u.remaining===null||chars<=u.remaining};
  }
  /* A sleep that a cancel ends early. */
  const sleepFor=(ms,signal)=>new Promise((resolve,reject)=>{
   if(signal&&signal.cancelled){reject(cancelledError());return;}
   let off=()=>{};const done=()=>{off();resolve();};
   Promise.resolve(sleep(ms)).then(done,done);
   if(signal)off=signal.onCancel(()=>reject(cancelledError()));
  });
  const check=signal=>{if(signal&&signal.cancelled)throw cancelledError();};
  /* A wait that Stop ends at once, for a call that cannot itself be aborted. */
  const orCancel=(promise,signal)=>{
   if(!signal)return Promise.resolve(promise);
   return new Promise((resolve,reject)=>{
    if(signal.cancelled){reject(cancelledError());return;}
    const off=signal.onCancel(()=>reject(cancelledError()));
    Promise.resolve(promise).then(v=>{off();resolve(v);},e=>{off();reject(e);});
   });
  };
  /* A job token that also stops when the caller's own token does (the panel makes its token at the click). */
  const linked=signal=>{const job=token();if(signal){if(signal.cancelled)job.cancel();else{const off=signal.onCancel(()=>job.cancel());job.onCancel(off);}}return job;};

  async function deeplBatch(texts,settings,signal,sourceLang=''){
   const key=deeplKey(),t=settings.target;
   let lastError=null;
   for(let attempt=0;attempt<=retries;attempt++){
    check(signal);
    const request=buildRequest(key,texts,{target:t,formality:settings.formality,source:sourceLang});
    let response;
    try{response=await http('POST',request.url,{headers:request.headers,body:request.body,signal});}
    catch(error){response={status:0,json:null};}
    check(signal);
    if(response.status>=200&&response.status<300){
     const list=response.json&&response.json.translations;
     if(!Array.isArray(list)||list.length!==texts.length||list.some(x=>typeof x.text!=='string')){const e=new Error('DeepL이 예상과 다른 답을 보냈습니다.');e.code='shape';e.own=true;throw e;}
     return list.map(x=>x.text);
    }
    const error=deeplError(response.status,response.json);lastError=error;
    if(!error.retry||attempt===retries)throw error;
    const wait=Math.min(30000,Number(response.retryAfter)>0?Number(response.retryAfter)*1000:1000*2**attempt);
    await sleepFor(wait,signal);
   }
   throw lastError;
  }
  async function viaPdfTranslate(texts,settings,signal){
   const api=pdfTranslate();const out=[];
   for(const text of texts){
    check(signal);
    // Translate for Zotero has no way to abort a request: Stop ends our wait at once (the reply, when it comes, is
    // dropped) and no further paragraph is sent. The plugin's own request may still finish in the background.
    const reply=await orCancel(api.translate(text,{langto:settings.target.pdft,pluginID:'style-custom@sungjaeyoon.dev'}),signal);
    check(signal);
    const value=typeof reply==='string'?reply:reply&&(reply.result||reply.text||reply.translation);
    if(typeof value!=='string'||!value.trim()){const e=new Error('번역 플러그인이 아무 내용도 보내지 않았습니다.');e.code='empty';e.own=true;throw e;}
    out.push(value.trim());
   }
   return out;
  }
  async function viaAI(texts,settings,signal){check(signal);const out=await ai.translate(texts,{language:settings.target.ai,signal});check(signal);return out;}
  async function runBatch(settings,texts,signal){
   const provider=settings.provider;
   if(provider==='deepl')return deeplBatch(texts,settings,signal);
   if(provider==='pdftranslate')return viaPdfTranslate(texts,settings,signal);
   if(provider==='ai')return viaAI(texts,settings,signal);
   throw new Error('Unknown translation provider');
  }
  /* DeepL, then Translate for Zotero, then the AI endpoint. After a stop the panel offers the next one. */
  const nextProvider=current=>{const list=providers(),at=list.indexOf(current);return at>=0?list[at+1]||null:list[0]||null;};
  function pickProvider(requested){
   const available=providers();
   if(requested&&available.includes(requested))return requested;
   return available[0]||null;
  }

  /* One paragraph's translation, cached; `force` bypasses the cache for 다시 번역. */
  async function translateOne(paragraph,{provider,force=false,target:targetCode=null,signal:outer=null}={}){
   const chosen=pickProvider(provider);if(!chosen){const e=new Error('번역기가 없습니다. 설정 → 번역·AI에서 DeepL 키를 넣으세요.');e.code='none';e.own=true;throw e;}
   const settings=settingsFor(chosen,targetCode||target().code),key=keyFor(settings,paragraph.text);
   if(!force){const hit=store.get(key);if(hit)return {text:hit,provider:chosen,target:settings.target.code,cached:true};}
   const signal=linked(outer);tokens.add(signal);
   try{
    check(signal);
    const parts=splitParagraph(paragraph.text),out=await runBatch(settings,parts,signal);
    check(signal);
    const text=out.join(' ');store.set(key,text);if(chosen==='deepl')addUsage(clean(paragraph.text).length);await store.save();
    return {text,provider:chosen,target:settings.target.code,cached:false};
   }finally{tokens.delete(signal);}
  }

  /* Translate from `start` to the end (or `limit` paragraphs) in reading order.
     Cached paragraphs are used as they are. Resolves with a summary; never throws
     for a stop (quota, cancel): the summary says why. */
  async function translateAll(paragraphs,{start=0,limit=Infinity,provider,target:targetCode=null,signal=null,onParagraph=()=>{},onProgress=()=>{}}={}){
   if(running)throw Object.assign(new Error('이미 번역하는 중입니다.'),{code:'busy',own:true});
   const chosen=pickProvider(provider);if(!chosen){const e=new Error('번역기가 없습니다. 설정 → 번역·AI에서 DeepL 키를 넣으세요.');e.code='none';e.own=true;throw e;}
   const settings=settingsFor(chosen,targetCode||target().code),job=linked(signal);job.target=settings.target.code;running=job;tokens.add(job);
   const summary={provider:chosen,target:settings.target.code,done:0,cached:0,total:0,chars:0,stopped:'',error:null};
   try{
    const slice=paragraphs.slice(Math.max(0,start),Number.isFinite(limit)?Math.max(0,start)+limit:undefined);summary.total=slice.length;
    const todo=[];
    for(const p of slice){
     const hit=store.get(keyFor(settings,p.text));
     if(hit){summary.cached++;summary.done++;onParagraph(p,hit,{cached:true,target:settings.target.code});}else todo.push(p);
    }
    onProgress({...summary});
    const parts=[];for(const p of todo)splitParagraph(p.text).forEach((text,i,all)=>parts.push({paragraph:p,i,n:all.length,text}));
    const results=new Map();
    if(job.cancelled&&todo.length)summary.stopped='cancelled';
    for(const batch of planBatches(parts.map((part,index)=>({...part,index})))){
     if(job.cancelled){summary.stopped='cancelled';break;}
     let out;
     try{out=await runBatch(settings,batch.map(b=>b.text),job);}
     catch(error){
      if(job.cancelled||error.code==='cancelled'){summary.stopped='cancelled';break;}
      summary.error=error;summary.stopped=error.code==='quota'?'quota':error.code||'failed';break;
     }
     if(job.cancelled){summary.stopped='cancelled';break;}
     if(chosen==='deepl')addUsage(batch.reduce((n,b)=>n+b.text.length,0));
     summary.chars+=batch.reduce((n,b)=>n+b.text.length,0);
     batch.forEach((b,i)=>{
      const entry=results.get(b.paragraph.id)||{parts:[],n:b.n};entry.parts[b.i]=out[i];results.set(b.paragraph.id,entry);
      if(entry.parts.filter(x=>x!==undefined).length===entry.n){
       const text=entry.parts.join(' ');store.set(keyFor(settings,b.paragraph.text),text);summary.done++;onParagraph(b.paragraph,text,{cached:false,target:settings.target.code});
      }
     });
     await store.save();onProgress({...summary});
    }
   }finally{running=null;tokens.delete(job);}
   return summary;
  }
  /* The translation shown for each paragraph in one language: the first provider (in the order above) whose
     cached result was made under the current settings. A result made under other settings (another AI model, a
     formality) is not current and is not returned. Map id -> {text, provider}. */
  function resolved(paragraphs,targetCode=null){
   const code=targetCode||target().code,out=new Map(),list=providers();
   const all=['deepl','pdftranslate','ai'].filter(p=>list.includes(p));
   const settings=all.map(p=>settingsFor(p,code));
   for(const p of paragraphs||[])for(const s of settings){const hit=store.get(keyFor(s,p.text));if(hit){out.set(p.id,{text:hit,provider:s.provider});break;}}
   return out;
  }
  /* Stops the run and any single re-translation: the request in flight, a back-off sleep, and everything after. */
  const cancel=()=>{for(const t of [...tokens])t.cancel();};
  return {providers,providerLabel,pickProvider,nextProvider,usage,refreshUsage,estimate,translateOne,translateAll,cancel,target,formality,resolved,
   get busy(){return !!running;},get runningTarget(){return running?running.target:null;},
   cached:(provider,text,targetCode=null)=>store.get(keyFor(settingsFor(provider,targetCode||target().code),text))};
 }

 /* Which provider made which paragraphs, as 1-based runs in reading order: [{provider, ranges:[[from,to],...]}],
    providers in the order they first appear. */
 function providerSpans(paragraphs,found){
  const by=new Map();
  (paragraphs||[]).forEach((p,i)=>{
   const hit=found&&found.get(p.id);if(!hit)return;
   const ranges=by.get(hit.provider)||[];const last=ranges[ranges.length-1];
   if(last&&last[1]===i)last[1]=i+1;else ranges.push([i+1,i+1]);
   by.set(hit.provider,ranges);
  });
  return [...by].map(([provider,ranges])=>({provider,ranges}));
 }
 const rangeText=ranges=>ranges.map(([a,b])=>a===b?String(a):a+'–'+b).join(', ');
 /* The paragraphs of one language that no provider has finished: what "continue with another translator" sends. */
 const unfinished=(paragraphs,found)=>(paragraphs||[]).filter(p=>!(found&&found.has(p.id)));

 /* ---- the bilingual note ------------------------------------------------- */
 const esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
 /* Original and translation, paragraph by paragraph under the section headings.
    Only paragraphs that have a translation are written; the note says how many. */
 function noteHTML({title,target,provider,date,paragraphs,translations,sources=null}){
  const lines=[`<h1>${esc(title||'')} (${esc(target)})</h1>`,`<p><em>${esc(provider)} · ${esc(date||'')}</em></p>`];
  let heading=null,count=0;
  // Each paragraph names its translator only when more than one made the note.
  const mixed=!!sources&&new Set([...paragraphs].map(p=>sources.get(p.id)).filter(Boolean)).size>1;
  for(const p of paragraphs){
   const text=translations.get?translations.get(p.id):translations[p.id];if(!text)continue;
   if(p.heading!==heading){heading=p.heading;if(heading)lines.push(`<h2>${esc(heading)}${p.page?' (p. '+esc(p.page)+')':''}</h2>`);}
   lines.push(`<p>${esc(p.text)}</p>`,`<blockquote><p>${esc(text)}</p>${mixed&&sources.get(p.id)?`<p><em>${esc(sources.get(p.id))}</em></p>`:''}</blockquote>`);count++;
  }
  return {html:'<div>'+lines.join('')+'</div>',count};
 }

 const api={create,hash,cacheKey,settingsRevision,token,deeplEndpoint,usageEndpoint,isFreeKey,buildRequest,deeplError,paragraphsOf,splitParagraph,planBatches,noteHTML,providerSpans,rangeText,unfinished,targetOf,TARGETS,FREE_LIMIT,MAX_PARAGRAPH,MAX_BATCH_COUNT,MAX_BATCH_BYTES,bytes};
 root.CustomStylePaperTranslate=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);

/* Translating a paper paragraph by paragraph, in reading order.

   DeepL first (a key in the settings), then Translate for Zotero when it is
   installed, then the AI endpoint the reader configured. Nothing here starts by
   itself: translateAll() runs only when the panel calls it from a button press.
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
 const cacheKey=(provider,target,text)=>provider+'|'+target+'|'+hash(clean(text));

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
  if(status===429)return make('rate','DeepL이 요청이 너무 많다고 합니다. 잠시 뒤 다시 시도합니다.',true);
  if(status===403||status===401)return make('key','DeepL 키가 올바르지 않거나 이 주소에서 쓸 수 없습니다. 설정에서 키를 확인하세요. 무료 키는 :fx로 끝납니다.');
  if(status===400){const e=make('bad','DeepL이 요청을 받지 않았습니다.');e.detail=message;return e;}
  if(status===413||status===414)return make('big','DeepL에 보낸 글이 너무 큽니다.');
  if(status>=500||status===0)return make('server','DeepL 서버가 응답하지 않습니다. 잠시 뒤 다시 시도합니다.',true);
  return make('failed','DeepL 응답 오류: HTTP '+status);
 }

 /* ---- the translator -------------------------------------------------------- */
 function create({http,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=()=>new Date(),pref=()=>'',cache=null,usageStore=null,pdfTranslate=()=>null,ai=null,uiKorean=true,retries=3}={}){
  const memory=new Map(),store=cache||{get:k=>memory.get(k),set:(k,v)=>memory.set(k,v),save:async()=>{}};
  let running=null;
  const monthKey=()=>{const d=now();return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');};
  const usageLoad=()=>{const u=(usageStore&&usageStore.get&&usageStore.get())||null;return u&&u.month===monthKey()?{...u}:{month:monthKey(),chars:0,limit:FREE_LIMIT,fromServer:false};};
  const usageSave=u=>{if(usageStore&&usageStore.set)usageStore.set(u);};
  const deeplKey=()=>String(pref('deeplApiKey')||'').trim();
  const target=()=>targetOf(pref('translateTarget'),uiKorean);
  const providers=()=>{
   const out=[];if(deeplKey())out.push('deepl');
   if(ai&&ai.available&&ai.available())out.push('ai');
   const api=pdfTranslate();if(api&&typeof api.translate==='function')out.push('pdftranslate');return out;
  };
  const providerLabel=id=>({deepl:isFreeKey(deeplKey())?'DeepL Free':'DeepL',pdftranslate:'Translate for Zotero',ai:'AI'}[id]||id);
  /* The usage the panel shows: what this plugin counted this month, or what DeepL said when last asked. */
  const usage=()=>{const u=usageLoad(),limit=u.limit||FREE_LIMIT;return {month:u.month,chars:u.chars,limit,remaining:Math.max(0,limit-u.chars),fromServer:!!u.fromServer,free:isFreeKey(deeplKey())};};
  async function refreshUsage(){
   const key=deeplKey();if(!key){const e=new Error('설정에서 DeepL 키를 먼저 입력하세요.');e.code='nokey';e.own=true;throw e;}
   const response=await http('GET',usageEndpoint(key),{headers:{'Authorization':'DeepL-Auth-Key '+key}});
   if(response.status<200||response.status>=300)throw deeplError(response.status,response.json);
   const json=response.json||{};
   const u={month:monthKey(),chars:Number(json.character_count)||0,limit:Number(json.character_limit)||FREE_LIMIT,fromServer:true};usageSave(u);return usage();
  }
  const addUsage=n=>{const u=usageLoad();u.chars+=n;u.fromServer=false;usageSave(u);};

  /* What a run would cost before it starts: only paragraphs not already cached count. */
  function estimate(paragraphs,provider=providers()[0]){
   const target_=target();let chars=0,cached=0,fresh=0;
   for(const p of paragraphs){if(store.get(cacheKey(provider||'x',target_.code,p.text))){cached++;continue;}fresh++;chars+=clean(p.text).length;}
   const u=usage();
   return {provider,paragraphs:paragraphs.length,cached,fresh,chars,limit:u.limit,remaining:u.remaining,free:u.free,fits:provider!=='deepl'||chars<=u.remaining};
  }

  async function deeplBatch(texts,sourceLang=''){
   const key=deeplKey(),t=target();
   let lastError=null;
   for(let attempt=0;attempt<=retries;attempt++){
    const request=buildRequest(key,texts,{target:t,formality:String(pref('translateFormality')||''),source:sourceLang});
    let response;
    try{response=await http('POST',request.url,{headers:request.headers,body:request.body});}
    catch(error){response={status:0,json:null};}
    if(response.status>=200&&response.status<300){
     const list=response.json&&response.json.translations;
     if(!Array.isArray(list)||list.length!==texts.length||list.some(x=>typeof x.text!=='string')){const e=new Error('DeepL이 예상과 다른 답을 보냈습니다.');e.code='shape';e.own=true;throw e;}
     return list.map(x=>x.text);
    }
    const error=deeplError(response.status,response.json);lastError=error;
    if(!error.retry||attempt===retries)throw error;
    const wait=Math.min(30000,Number(response.retryAfter)>0?Number(response.retryAfter)*1000:1000*2**attempt);
    await sleep(wait);
   }
   throw lastError;
  }
  async function viaPdfTranslate(texts){
   const api=pdfTranslate();const out=[];
   for(const text of texts){
    const reply=await api.translate(text,{langto:target().pdft,pluginID:'style-custom@sungjaeyoon.dev'});
    const value=typeof reply==='string'?reply:reply&&(reply.result||reply.text||reply.translation);
    if(typeof value!=='string'||!value.trim()){const e=new Error('번역 플러그인이 아무 내용도 보내지 않았습니다.');e.code='empty';e.own=true;throw e;}
    out.push(value.trim());
   }
   return out;
  }
  async function viaAI(texts){return ai.translate(texts,{language:target().ai});}
  async function runBatch(provider,texts){
   if(provider==='deepl')return deeplBatch(texts);
   if(provider==='pdftranslate')return viaPdfTranslate(texts);
   if(provider==='ai')return viaAI(texts);
   throw new Error('Unknown translation provider');
  }
  /* DeepL, then the AI endpoint, then Translate for Zotero. After a stop the panel offers the next one. */
  const nextProvider=current=>{const list=providers(),at=list.indexOf(current);return at>=0?list[at+1]||null:list[0]||null;};
  function pickProvider(requested){
   const available=providers();
   if(requested&&available.includes(requested))return requested;
   return available[0]||null;
  }

  /* One paragraph's translation, cached; `force` bypasses the cache for 다시 번역. */
  async function translateOne(paragraph,{provider,force=false}={}){
   const chosen=pickProvider(provider);if(!chosen){const e=new Error('번역기가 없습니다. 설정 → 번역·AI에서 DeepL 키를 넣으세요.');e.code='none';e.own=true;throw e;}
   const key=cacheKey(chosen,target().code,paragraph.text);
   if(!force){const hit=store.get(key);if(hit)return {text:hit,provider:chosen,cached:true};}
   const parts=splitParagraph(paragraph.text),out=await runBatch(chosen,parts);
   const text=out.join(' ');store.set(key,text);if(chosen==='deepl')addUsage(clean(paragraph.text).length);await store.save();
   return {text,provider:chosen,cached:false};
  }

  /* Translate from `start` to the end (or `limit` paragraphs) in reading order.
     Cached paragraphs are used as they are. Resolves with a summary; never throws
     for a stop (quota, cancel): the summary says why. */
  async function translateAll(paragraphs,{start=0,limit=Infinity,provider,onParagraph=()=>{},onProgress=()=>{}}={}){
   if(running)throw Object.assign(new Error('이미 번역하는 중입니다.'),{code:'busy',own:true});
   const chosen=pickProvider(provider);if(!chosen){const e=new Error('번역기가 없습니다. 설정 → 번역·AI에서 DeepL 키를 넣으세요.');e.code='none';e.own=true;throw e;}
   const t=target(),job={cancelled:false};running=job;
   const summary={provider:chosen,done:0,cached:0,total:0,chars:0,stopped:'',error:null};
   try{
    const slice=paragraphs.slice(Math.max(0,start),Number.isFinite(limit)?Math.max(0,start)+limit:undefined);summary.total=slice.length;
    const todo=[];
    for(const p of slice){
     const hit=store.get(cacheKey(chosen,t.code,p.text));
     if(hit){summary.cached++;summary.done++;onParagraph(p,hit,{cached:true});}else todo.push(p);
    }
    onProgress({...summary});
    const parts=[];for(const p of todo)splitParagraph(p.text).forEach((text,i,all)=>parts.push({paragraph:p,i,n:all.length,text}));
    const results=new Map();
    for(const batch of planBatches(parts.map((part,index)=>({...part,index})))){
     if(job.cancelled){summary.stopped='cancelled';break;}
     let out;
     try{out=await runBatch(chosen,batch.map(b=>b.text));}
     catch(error){summary.error=error;summary.stopped=error.code==='quota'?'quota':error.code||'failed';break;}
     if(chosen==='deepl')addUsage(batch.reduce((n,b)=>n+b.text.length,0));
     summary.chars+=batch.reduce((n,b)=>n+b.text.length,0);
     batch.forEach((b,i)=>{
      const entry=results.get(b.paragraph.id)||{parts:[],n:b.n};entry.parts[b.i]=out[i];results.set(b.paragraph.id,entry);
      if(entry.parts.filter(x=>x!==undefined).length===entry.n){
       const text=entry.parts.join(' ');store.set(cacheKey(chosen,t.code,b.paragraph.text),text);summary.done++;onParagraph(b.paragraph,text,{cached:false});
      }
     });
     await store.save();onProgress({...summary});
    }
   }finally{running=null;}
   return summary;
  }
  const cancel=()=>{if(running)running.cancelled=true;};
  return {providers,providerLabel,pickProvider,nextProvider,usage,refreshUsage,estimate,translateOne,translateAll,cancel,target,get busy(){return !!running;},cached:(provider,text)=>store.get(cacheKey(provider,target().code,text))};
 }

 /* ---- the bilingual note ------------------------------------------------- */
 const esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
 /* Original and translation, paragraph by paragraph under the section headings.
    Only paragraphs that have a translation are written; the note says how many. */
 function noteHTML({title,target,provider,date,paragraphs,translations}){
  const lines=[`<h1>${esc(title||'')} (${esc(target)})</h1>`,`<p><em>${esc(provider)} · ${esc(date||'')}</em></p>`];
  let heading=null,count=0;
  for(const p of paragraphs){
   const text=translations.get?translations.get(p.id):translations[p.id];if(!text)continue;
   if(p.heading!==heading){heading=p.heading;if(heading)lines.push(`<h2>${esc(heading)}${p.page?' (p. '+esc(p.page)+')':''}</h2>`);}
   lines.push(`<p>${esc(p.text)}</p>`,`<blockquote><p>${esc(text)}</p></blockquote>`);count++;
  }
  return {html:'<div>'+lines.join('')+'</div>',count};
 }

 const api={create,hash,cacheKey,deeplEndpoint,usageEndpoint,isFreeKey,buildRequest,deeplError,paragraphsOf,splitParagraph,planBatches,noteHTML,targetOf,TARGETS,FREE_LIMIT,MAX_PARAGRAPH,MAX_BATCH_COUNT,MAX_BATCH_BYTES,bytes};
 root.CustomStylePaperTranslate=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);

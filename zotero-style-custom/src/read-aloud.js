/* Read the paper aloud: free, local, no network.

   Two engines sit behind one small contract, and one player drives either:

     engine.speak({text, lang, voiceURI, rate, onstart, onend, onerror})
     engine.cancel()          drop everything queued or speaking
     engine.pause()/resume()  only when engine.supportsPause
     engine.voices()          [{voiceURI, name, lang, localService, default}]

   - speechSynthesis of the reader's own window. Gecko on macOS speaks with the
     system voices (free). Utterances are queued by the engine itself, so the
     player can hand it the next sentence before the current one ends and there
     is no gap.
   - macOS `say`, when speechSynthesis has no voices. `say` cannot be paused, so
     the player pauses by killing the process and resumes by speaking again from
     the START OF THE CURRENT SENTENCE (never from the middle of a word). That is
     the whole reason the player works one sentence at a time.

   The player is a plain state machine over a list of sentence units:
   {text, page, rects, sectionIndex, sentenceIndex, kind, sectionLabel}. It
   never touches the DOM, the network or a library item: the caller supplies the
   engine, the clock, and what to do when a sentence has been spoken. */
(function(root){
 'use strict';
 const RATE_MIN=0.8,RATE_MAX=1.8,CHUNK_MAX=200,CREDIT_MAX_SECONDS=120;
 const clamp=(value,low,high,fallback)=>{const n=Number(value);return Number.isFinite(n)?Math.min(high,Math.max(low,n)):fallback;};
 const clean=text=>String(text==null?'':text).replace(/\s+/g,' ').trim();

 /* ---- sentences -------------------------------------------------------- */
 const ABBREVIATION=/(?:^|[\s(])(?:e\.g|i\.e|et al|fig|figs|eq|eqs|ref|refs|vs|cf|approx|dr|prof|no|vol|sec|tab|resp|ca|mr|ms|mrs|st|inc|ltd|co|al|sp|spp|var|subsp)\.$/i;
 function splitSentences(text){
  const source=clean(text);if(!source)return [];
  const out=[];let start=0;const boundary=/[.!?。？！…]+["'”’)\]]*(?=\s)/g;let m;
  while((m=boundary.exec(source))){
   const end=m.index+m[0].length,head=source.slice(start,end),tail=source.slice(end).trimStart();
   if(!tail)break;
   if(ABBREVIATION.test(head))continue;
   if(/(?:^|\s)[A-Z]\.$/.test(head))continue;               // an initial: "J. Smith"
   if(/^[a-z(\[]/.test(tail)&&/[.]$/.test(m[0]))continue;     // "...fig. shows" keeps going; "다." and "?" do not
   out.push(head.trim());start=end;
  }
  const rest=source.slice(start).trim();if(rest)out.push(rest);
  return out;
 }
 /* The engine gets pieces of at most CHUNK_MAX characters, cut at a clause
    comma where there is one, so a very long sentence is not one 40-second
    utterance that cannot be skipped. The caller still highlights the whole. */
 function splitForEngine(text,max=CHUNK_MAX){
  const source=clean(text);if(!source)return [];if(source.length<=max)return [source];
  const pieces=source.split(/(?<=[,;:，、；：])\s+/);const out=[];let current='';
  const push=value=>{if(value)out.push(value);};
  for(const piece of pieces){
   if(piece.length>max){push(current);current='';let rest=piece;while(rest.length>max){let cut=rest.lastIndexOf(' ',max);if(cut<max/2)cut=max;push(rest.slice(0,cut).trim());rest=rest.slice(cut).trim();}current=rest;continue;}
   if(current&&(current+' '+piece).length>max){push(current);current=piece;}else current=current?current+' '+piece:piece;
  }
  push(current);return out;
 }
 function detectLanguage(text){
  const sample=String(text||'').slice(0,4000),letters=sample.match(/\p{L}/gu)||[];if(!letters.length)return 'en';
  const count=re=>(sample.match(re)||[]).length;
  const hangul=count(/[가-힣]/g),kana=count(/[぀-ヿ]/g),han=count(/[一-鿿]/g);
  if(hangul/letters.length>0.15)return 'ko';if(kana/letters.length>0.1)return 'ja';if(han/letters.length>0.2)return 'zh';return 'en';
 }
 /* The saved voice when it still exists; otherwise the best installed voice
    for the language: a local voice, an enhanced/premium one, the default. */
 function pickVoice(voices,lang,savedURI){
  const list=Array.isArray(voices)?voices:[];
  if(savedURI){const keep=list.find(v=>v.voiceURI===savedURI);if(keep)return keep;}
  const code=String(lang||'en').toLowerCase().split(/[-_]/)[0];
  const same=list.filter(v=>String(v.lang||'').toLowerCase().replace('_','-').split('-')[0]===code);
  if(!same.length)return null;
  const score=v=>(v.localService?4:0)+(/enhanced|premium|siri|neural/i.test(v.name||'')?3:0)+(v.default?2:0)+(/novelty|bad news|bubbles|whisper|zarvox|trinoids|albert|jester|organ|cellos|bells|boing/i.test(v.name||'')?-10:0);
  return same.slice().sort((a,b)=>score(b)-score(a))[0];
 }

 /* ---- engines ---------------------------------------------------------- */
 function speechEngine(win){
  const synth=win&&win.speechSynthesis,Utterance=win&&win.SpeechSynthesisUtterance;const live=new Set();
  const voices=()=>{try{return Array.from(synth.getVoices()||[]);}catch(_){return [];}};
  return {name:'speechSynthesis',supportsPause:true,
   available(){return !!synth&&typeof Utterance==='function'&&voices().length>0;},
   voices(){return voices().map(v=>({voiceURI:v.voiceURI,name:v.name,lang:v.lang,localService:!!v.localService,default:!!v.default}));},
   speak({text,lang,voiceURI,rate,onstart,onend,onerror}){
    const u=new Utterance(text);u.lang=lang||'';u.rate=rate||1;
    if(voiceURI){const voice=voices().find(v=>v.voiceURI===voiceURI);if(voice)u.voice=voice;}
    // Gecko drops an utterance nobody holds a reference to, and its end event with it.
    live.add(u);const done=()=>live.delete(u);
    u.onstart=()=>{onstart&&onstart();};u.onend=()=>{done();onend&&onend();};
    u.onerror=event=>{done();if(event&&(event.error==='canceled'||event.error==='interrupted'))return;onerror&&onerror(event&&event.error||'error');};
    synth.speak(u);
   },
   cancel(){try{synth.cancel();}catch(_){}live.clear();},
   pause(){try{synth.pause();}catch(_){}},resume(){try{synth.resume();}catch(_){}}};
 }
 /* macOS `say`. `spawn(args, onexit)` starts /usr/bin/say with an argument
    array (no shell, so nothing in the paper text can become a command) and
    returns {kill()}; onexit receives the exit status. Plain Zotero.Utilities
    .Internal.exec cannot be stopped, which is why the runtime supplies a spawn
    built on nsIProcess. */
 const SAY_VOICES={ko:'Yuna',en:'Samantha',ja:'Kyoko',zh:'Tingting',de:'Anna',fr:'Thomas',es:'Monica',it:'Alice'};
 function sayEngine({spawn,voiceNames=SAY_VOICES}){
  const queue=[];let current=null,generation=0;const broken=new Set();
  function run(){
   if(current||!queue.length)return;
   const utt=queue.shift(),mine=++generation;current={utt,mine};
   const short=String(utt.lang||'').split(/[-_]/)[0],fallbackName=voiceNames[short];
   const name=utt.voiceURI&&!broken.has(utt.voiceURI)?utt.voiceURI:(fallbackName&&!broken.has(fallbackName)?fallbackName:'');
   const args=[];if(name)args.push('-v',name);args.push('-r',String(Math.round(175*(utt.rate||1))),'--',utt.text);
   utt.onstart&&utt.onstart();
   let proc;
   try{proc=spawn(args,status=>{
    if(!current||current.mine!==mine)return;       // killed on purpose
    current=null;
    if(status!==0&&name){broken.add(name);queue.unshift(utt);utt.onstart=null;run();return;}   // that voice is not installed: once more with the system voice
    if(status!==0){utt.onerror&&utt.onerror('say-failed');return;}
    utt.onend&&utt.onend();run();
   });}catch(error){current=null;utt.onerror&&utt.onerror(String(error&&error.message||error));return;}
   current.proc=proc;
  }
  return {name:'say',supportsPause:false,available(){return typeof spawn==='function';},
   voices(){return Object.entries(voiceNames).map(([lang,name])=>({voiceURI:name,name,lang,localService:true,default:false}));},
   speak(utt){queue.push(utt);run();},
   cancel(){queue.length=0;if(current){const proc=current.proc;current=null;generation++;try{proc&&proc.kill();}catch(_){}}},
   pause(){this.cancel();},resume(){}};
 }

 /* ---- composing what is read -------------------------------------------- */
 const sentencesOf=entry=>{
  if(!entry)return [];
  if(Array.isArray(entry.sentences))return entry.sentences.filter(s=>s&&clean(s.text)).map(s=>({text:clean(s.text),page:s.page??entry.page,rects:s.rects||entry.rects||[]}));
  const text=clean(entry.text||entry.caption||entry);
  return typeof entry==='string'||text?[{text:clean(typeof entry==='string'?entry:text),page:entry.page,rects:entry.rects||[]}]:[];
 };
 const isBack=section=>!!section&&(section.kind==='back'||section.kind==='references'||section.back===true);
 /* The body in reading order, with the captions and the reference list added
    only when asked. Captions go after the last sentence on their page. */
 function composeUnits(structured,{captions=false,references=false}={},paperText=root.StyleCustomPaperText){
  if(!structured||!paperText)return [];
  const sections=Array.isArray(structured.sections)?structured.sections:[];
  const ordered=(paperText.readingOrder?paperText.readingOrder(structured):[])||[];
  let body=ordered.map((u,i)=>({...u,kind:isBack(sections[u.sectionIndex])?'back':'body',order:i,sectionLabel:clean(sections[u.sectionIndex]&&sections[u.sectionIndex].heading)}));
  if(!references)body=body.filter(u=>u.kind!=='back');
  const extra=[];
  if(captions)for(const c of structured.captions||[])for(const s of sentencesOf(c).flatMap(x=>splitSentences(x.text).map(text=>({...x,text}))))extra.push({text:s.text,page:s.page,rects:s.rects,sectionIndex:-1,sentenceIndex:0,kind:'caption',sectionLabel:'caption'});
  const out=[];const pageOf=u=>Number.isFinite(Number(u.page))?Number(u.page):-1;
  const pending=extra.slice().sort((a,b)=>pageOf(a)-pageOf(b));
  for(let i=0;i<body.length;i++){
   out.push(body[i]);
   const last=i===body.length-1||pageOf(body[i+1])!==pageOf(body[i]);
   if(last)while(pending.length&&pageOf(pending[0])<=pageOf(body[i]))out.push(pending.shift());
  }
  out.push(...pending);
  if(references)for(const r of structured.references||[])for(const s of sentencesOf(r))out.push({text:s.text,page:s.page,rects:s.rects,sectionIndex:-2,sentenceIndex:0,kind:'reference',sectionLabel:'references'});
  return out.map((u,i)=>({...u,order:i}));
 }
 const sectionKey=u=>u?u.kind+':'+u.sectionIndex:'';
 const signature=u=>u?clean(u.text).slice(0,48)+'|'+(u.page??''):'';

 /* ---- plain text fallback (no extraction module) ------------------------
   Pages are 0-based indexes here, as in the extraction module's output. */
 const HEADING=/^(?:(?:\d+(?:\.\d+){0,3}|[IVX]+)[.)]?\s+)?(abstract|introduction|background|related work|methods?|materials and methods|experimental(?: procedures)?|results?(?: and discussion)?|discussion|conclusions?|acknowledge?ments?|limitations?|references|bibliography|supplementary(?: information)?|초록|서론|방법|결과|논의|결론|참고문헌)\b[\s:.]*$/i;
 const REFERENCES=/^(?:\d+[.)]?\s+)?(references|bibliography|literature cited|참고문헌)[\s:.]*$/i;
 function plainTextStructure(text,{title=''}={}){
  const raw=String(text||'').replace(/\r/g,'');
  const pageTexts=raw.includes('\f')?raw.split('\f'):[raw];
  const sections=[{heading:'',level:1,page:0,paragraphs:[]}],references=[];let inRefs=false;
  pageTexts.forEach((pageText,pageIndex)=>{
   const paragraphs=pageText.split(/\n\s*\n/);
   for(const block of paragraphs){
    const lines=block.split('\n').map(l=>l.trim()).filter(Boolean);if(!lines.length)continue;
    if(lines.length===1&&lines[0].length<80&&HEADING.test(lines[0])){
     if(REFERENCES.test(lines[0])){inRefs=true;continue;}
     inRefs=false;sections.push({heading:lines[0].replace(/^\d+(?:\.\d+)*[.)]?\s+/,''),level:1,page:pageIndex,paragraphs:[]});continue;
    }
    const joined=lines.join(' ').replace(/(\w)- (\w)/g,'$1$2').replace(/\s+/g,' ').trim();if(!joined||joined.length<3)continue;
    const sentences=splitSentences(joined).map(s=>({text:s,page:pageIndex,rects:[]}));
    if(inRefs){for(const s of sentences)references.push({text:s.text,page:s.page});continue;}
    sections[sections.length-1].paragraphs.push({sentences});
   }
  });
  const kept=sections.filter((s,i)=>i>0||s.paragraphs.length);
  const abstractSection=kept.find(s=>/^(abstract|초록)$/i.test(s.heading));
  return {title:title||'',abstract:abstractSection?abstractSection.paragraphs.map(p=>p.sentences.map(s=>s.text).join(' ')).join('\n'):'',sections:kept,captions:[],references,footnotes:[],skipped:[],stats:{fallback:true,pages:pageTexts.length}};
 }
 /* The four functions of the extraction module, built from plain text. Used
    only when StyleCustomPaperText is not loaded. */
 const fallbackPaperText=Object.freeze({
  structure:({text,meta}={})=>plainTextStructure(text,{title:meta&&meta.title}),
  readingOrder(structured){const out=[];(structured.sections||[]).forEach((section,sectionIndex)=>{let n=0;for(const p of section.paragraphs||[])for(const s of p.sentences||[])out.push({text:s.text,page:s.page,rects:s.rects||[],sectionIndex,sentenceIndex:n++});});return out;},
  pageFromPdfjs:()=>null,
  debug:structured=>'plain text fallback: no extraction module, '+((structured&&structured.sections)||[]).length+' sections'
 });

 /* ---- the player -------------------------------------------------------- */
 function create({engine,now=()=>Date.now(),timers=null,onChange=()=>{},onCredit=()=>{},lang='en',voiceURI='',rate=1,filters={},watchdogMs=6000}={}){
  if(!engine)throw new Error('A speech engine is required');
  const timer=timers||{set:(fn,ms)=>setTimeout(fn,ms),clear:id=>clearTimeout(id)};
  let all=[],list=[],index=0,status='idle',gen=0,queuedTo=-1,entered=-1,queueLive=false,dead=false,watch=null,error='';
  let speakRate=clamp(rate,RATE_MIN,RATE_MAX,1),speakVoice=voiceURI||'',speakLang=lang||'en';
  const filter={captions:filters.captions===true,references:filters.references===true};
  const clock={since:null,accum:0};
  const emit=type=>{if(dead)return;try{onChange({type,state:snapshot()});}catch(_){}};
  const snapshot=()=>({status,index,total:list.length,unit:list[index]||null,rate:speakRate,voiceURI:speakVoice,lang:speakLang,filters:{...filter},error,engine:engine.name,supportsPause:engine.supportsPause!==false});
  const clearWatch=()=>{if(watch!==null){timer.clear(watch);watch=null;}};
  const armWatch=g=>{clearWatch();if(!watchdogMs)return;watch=timer.set(()=>{watch=null;if(g!==gen||status!=='playing')return;fail(g,'no-audio');},watchdogMs);};
  function fail(g,reason){if(g!==gen)return;gen++;clearWatch();try{engine.cancel();}catch(_){}queueLive=false;status='error';error=String(reason||'error');emit('error');}
  function enqueue(u,g){
   const unit=list[u];if(!unit)return;
   const chunks=splitForEngine(unit.text);if(!chunks.length)chunks.push(clean(unit.text)||'.');
   queuedTo=u;
   chunks.forEach((chunk,k)=>engine.speak({text:chunk,lang:speakLang,voiceURI:speakVoice,rate:speakRate,
    onstart:()=>onStart(g,u,k),onend:()=>onEnd(g,u,k===chunks.length-1),onerror:reason=>fail(g,reason)}));
  }
  function enter(u,g){
   if(entered===u)return;
   entered=u;index=u;clock.accum=0;clock.since=now();status='playing';error='';
   if(u+1<list.length&&queuedTo<u+1)enqueue(u+1,g);
   emit('sentence');
  }
  function onStart(g,u,k){if(g!==gen||dead)return;clearWatch();if(k===0)enter(u,g);}
  function onEnd(g,u,last){
   if(g!==gen||dead||!last)return;
   const spent=(clock.accum+(clock.since!==null?now()-clock.since:0))/1000;clock.since=null;
   if(entered===u){try{onCredit(list[u],Math.min(CREDIT_MAX_SECONDS,Math.max(0,spent)));}catch(_){}}
   if(u+1>=list.length){queueLive=false;status='done';emit('done');return;}
   enter(u+1,g);
  }
  function startAt(i){
   gen++;const g=gen;clearWatch();try{engine.cancel();}catch(_){}
   index=Math.max(0,Math.min(list.length-1,i));entered=-1;queuedTo=index-1;queueLive=true;status='playing';error='';clock.accum=0;clock.since=null;
   emit('status');armWatch(g);enqueue(index,g);
  }
  function rebuild(keep){
   const before=keep&&list[index];
   list=all.filter(u=>(u.kind!=='caption'||filter.captions)&&(u.kind!=='reference'&&u.kind!=='back'||filter.references));
   if(before){const at=list.findIndex(u=>u.order===before.order);index=at>=0?at:Math.min(list.length?list.length-1:0,Math.max(0,list.findIndex(u=>u.order>before.order)));if(index<0)index=0;}
   else index=Math.min(index,Math.max(0,list.length-1));
  }
  const api={
   load(units,{resume=null}={}){
    api.stop(true);all=(Array.isArray(units)?units:[]).map((u,i)=>({...u,order:u.order??i}));rebuild(false);index=0;
    if(resume){const at=typeof resume==='number'?resume:list.findIndex(u=>signature(u)===resume.sig);if(Number.isInteger(at)&&at>=0&&at<list.length)index=at;else if(resume.index>=0&&resume.index<list.length)index=resume.index;}
    entered=-1;status='idle';emit('status');return snapshot();
   },
   state:snapshot,units:()=>list,
   /* What to store to come back to this sentence: its text, its page, its index. */
   position:()=>({index,sig:signature(list[index]),page:list[index]&&list[index].page,total:list.length}),
   play(from){if(!list.length)return snapshot();startAt(from===undefined?(status==='done'?0:index):from);return snapshot();},
   pause(){
    if(status!=='playing')return snapshot();
    clearWatch();
    if(clock.since!==null){clock.accum+=now()-clock.since;clock.since=null;}
    if(engine.supportsPause===false){gen++;try{engine.cancel();}catch(_){}queueLive=false;entered=-1;}else engine.pause();
    status='paused';emit('status');return snapshot();
   },
   resume(){
    if(status!=='paused')return snapshot();
    if(engine.supportsPause===false||!queueLive){startAt(index);return snapshot();}
    status='playing';clock.since=now();engine.resume();emit('status');return snapshot();
   },
   toggle(){return status==='playing'?api.pause():status==='paused'?api.resume():api.play();},
   stop(silent){gen++;clearWatch();try{engine.cancel();}catch(_){}queueLive=false;entered=-1;queuedTo=-1;clock.since=null;clock.accum=0;if(status!=='idle'){status='idle';if(!silent)emit('status');}return snapshot();},
   seek(i){
    if(!list.length)return snapshot();
    const target=Math.max(0,Math.min(list.length-1,Math.round(Number(i)||0)));
    if(status==='playing'){startAt(target);return snapshot();}
    gen++;clearWatch();try{engine.cancel();}catch(_){}queueLive=false;entered=-1;index=target;
    if(status!=='paused')status='paused';
    emit('sentence');return snapshot();
   },
   next(){return api.seek(Math.min(list.length-1,index+1));},
   prev(){return api.seek(Math.max(0,index-1));},
   nextSection(){const key=sectionKey(list[index]);let i=index+1;while(i<list.length&&sectionKey(list[i])===key)i++;return api.seek(Math.min(i,list.length-1));},
   prevSection(){
    const key=sectionKey(list[index]);let start=index;while(start>0&&sectionKey(list[start-1])===key)start--;
    if(index>start)return api.seek(start);
    if(start===0)return api.seek(0);
    const before=sectionKey(list[start-1]);let i=start-1;while(i>0&&sectionKey(list[i-1])===before)i--;return api.seek(i);
   },
   setRate(value){speakRate=clamp(value,RATE_MIN,RATE_MAX,speakRate);if(status==='playing')startAt(index);else{queueLive=false;emit('settings');}return speakRate;},
   setVoice(uri,language){speakVoice=uri||'';if(language)speakLang=language;if(status==='playing')startAt(index);else{queueLive=false;emit('settings');}return speakVoice;},
   setLanguage(language){speakLang=language||speakLang;},
   setFilters(next={}){
    if('captions' in next)filter.captions=next.captions===true;if('references' in next)filter.references=next.references===true;
    const was=status;rebuild(true);if(was==='playing')startAt(index);else{queueLive=false;entered=-1;emit('settings');}return snapshot();
   },
   /* A position on the page (found by the caller) becomes the sentence to start from. */
   /* Rectangles are [x, y, w, h] in the page's top-left coordinates, as the extraction module gives them. */
   indexNear(page,x,y){
    let best=-1,bestScore=Infinity;
    list.forEach((u,i)=>{
     if(Number(u.page)!==Number(page))return;
     for(const r of u.rects||[]){
      if(!Array.isArray(r)||r.length<4)continue;
      const x1=r[0],y1=r[1],x2=r[0]+r[2],y2=r[1]+r[3],dx=x<x1?x1-x:x>x2?x-x2:0,dy=y<y1?y1-y:y>y2?y-y2:0,d=Math.hypot(dx,dy);
      if(d<bestScore){bestScore=d;best=i;}
     }
    });
    if(best<0)return list.findIndex(u=>Number(u.page)===Number(page));
    return best;
   },
   destroy(){if(dead)return;api.stop(true);dead=true;}
  };
  return api;
 }
 const api={create,speechEngine,sayEngine,splitSentences,splitForEngine,detectLanguage,pickVoice,composeUnits,plainTextStructure,fallbackPaperText,signature,RATE_MIN,RATE_MAX,CHUNK_MAX};
 root.CustomStyleReadAloud=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);

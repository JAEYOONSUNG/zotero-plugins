/* The reader panel: listen to the paper, a summary when it opens, a chat about
   it, and a paragraph-by-paragraph translation, all inside the Zotero reader.

   Where things live
   - The panel is an <aside> fixed to the right of the reader's own document
     (the same document the toolbar hook receives). Opening it moves #split-view
     over by the panel width; closing puts that back.
   - Text comes from pdf.js inside the reader (primary view's PDFViewerApplication)
     through StyleCustomPaperText, once per attachment, cached in the plugin's
     own folder keyed by file size and modification time. Without the extraction
     module, or when pdf.js cannot be reached, Zotero.PDFWorker.getFullText and the
     plain-text fallback in read-aloud.js stand in (no rectangles, so no highlight
     on the page; everything else works).
   - Nothing runs by itself except the opt-in summary (aiSummaryOnOpen). Every
     button that plays audio, calls an AI or a translator, or writes (memo, note,
     cache) says so with data-opens / data-writes; a button that only changes the
     view says data-safe="view". The self-check probe only measures: it presses
     nothing. unmarkedButtons() is the test of that contract. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;root.CustomStyleReaderAssist=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
 'use strict';
 const HTML='http://www.w3.org/1999/xhtml',SVG='http://www.w3.org/2000/svg';
 const WIDTH=372,TOP=41,MAX_CHAT=20,CHAT_LIMIT=4000;
 const need=(name,file)=>root[name]||(typeof require==='function'?require(file):null);
 const clean=text=>String(text==null?'':text).replace(/\s+/g,' ').trim();
 // The extraction module (and the plain-text fallback) number pages from 0 and give rectangles as [x, y, w, h] from the top left of the page at scale 1.
 const PAGES_ARE_INDEXES=true;
 const PAGE_BASE=PAGES_ARE_INDEXES?1:0;
 const pageNumberOf=unit=>{const n=Number(unit&&unit.page);return Number.isFinite(n)?n+PAGE_BASE:null;};

 /* ---- small DOM helpers ------------------------------------------------- */
 const ICONS={
  play:['M8 5.5v13l10-6.5z'],pause:['M9 6v12','M15 6v12'],prev:['M15 6l-6 6 6 6'],next:['M9 6l6 6-6 6'],
  sectionPrev:['M12 6l-6 6 6 6','M19 6l-6 6 6 6'],sectionNext:['M5 6l6 6-6 6','M12 6l6 6-6 6'],
  close:['M6 6l12 12','M18 6L6 18'],copy:['M9 9h11v11H9z','M5 15V5h10'],note:['M6 4h9l3 3v13H6z','M9 12h6','M9 16h6'],
  refresh:['M20 12a8 8 0 1 1-2.3-5.6','M20 4v5h-5'],send:['M4 12l16-8-6 16-3-7z'],stop:['M7 7h10v10H7z'],trash:['M5 7h14','M10 7V5h4v2','M7 7l1 12h8l1-12'],
  headphones:['M4 14v-2a8 8 0 0 1 16 0v2','M4 14h3v5H5a1 1 0 0 1-1-1z','M20 14h-3v5h2a1 1 0 0 0 1-1z'],
  translate:['M4 6h9','M8.5 4v2','M6 6c0 4 3 7 6 8','M12 6c-1 4-4 7-7 8','M13 20l4-9 4 9','M14.5 17h5'],
  message:['M5 5h14v10H10l-4 4v-4H5z'],list:['M5 7h14','M5 12h14','M5 17h9'],caret:['M7 10l5 5 5-5'],panel:['M4 5h16v14H4z','M15 5v14']
 };
 function icon(doc,name,size=16){
  const svg=doc.createElementNS(SVG,'svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width',String(size));svg.setAttribute('height',String(size));
  svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.8');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');
  for(const d of ICONS[name]||[]){const p=doc.createElementNS(SVG,'path');p.setAttribute('d',d);svg.appendChild(p);}
  return svg;
 }
 function el(doc,tag,props={},parent=null){
  const n=doc.createElementNS(HTML,tag);
  for(const[k,v]of Object.entries(props)){
   if(v===undefined||v===null||v===false)continue;
   if(k==='class')n.setAttribute('class',v);else if(k==='text')n.textContent=v;else n.setAttribute(k,v===true?'':String(v));
  }
  if(parent)parent.appendChild(n);return n;
 }
 /* Every button says what pressing it does to the world. */
 const MARKS=['data-safe','data-opens','data-writes'];
 const unmarkedButtons=container=>[...container.querySelectorAll('button')].filter(b=>!MARKS.some(m=>b.hasAttribute(m)));
 const pressable=container=>[...container.querySelectorAll('button')].filter(b=>b.hasAttribute('data-opens')||b.hasAttribute('data-writes'));

 /* A short Markdown (headings, bullets, **bold**) as DOM nodes, never as HTML. A
    "(Results, p. 4)" becomes a button that calls onPage(4). */
 function renderMarkdown(doc,parent,text,{pages=0,onPage=null}={}){
  const PC=need('CustomStylePaperChat','./paper-chat.js');
  parent.replaceChildren();
  const inline=(host,source)=>{
   const parts=String(source).split(/(\*\*[^*]+\*\*)/);
   for(const part of parts){
    const bold=/^\*\*([^*]+)\*\*$/.exec(part),body=bold?bold[1]:part;if(!body)continue;
    const holder=bold?el(doc,'strong',{},host):host;
    for(const seg of PC.linkCitations(body,{pages})){
     if(seg.type==='cite'&&onPage){const b=el(doc,'button',{type:'button','class':'sc-ra-cite','data-safe':'view','data-page':seg.page,text:seg.text,title:'p. '+seg.page},holder);b.addEventListener('click',()=>onPage(seg.page));}
     else holder.appendChild(doc.createTextNode(seg.text));
    }
   }
  };
  let list=null;
  for(const raw of String(text==null?'':text).split(/\r?\n/)){
   const line=raw.trimEnd();if(!line.trim()){list=null;continue;}
   let m;
   if((m=/^\s{0,3}#{1,4}\s+(.*)$/.exec(line))){list=null;inline(el(doc,'h4',{'class':'sc-ra-h'},parent),m[1].replace(/\*+/g,''));}
   else if((m=/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line))){if(!list)list=el(doc,'ul',{'class':'sc-ra-list'},parent);inline(el(doc,'li',{},list),m[1]);}
   else{list=null;inline(el(doc,'p',{},parent),line.trim());}
  }
  return parent;
 }

 function create({Zotero:Z,runtime}){
  const RA=need('CustomStyleReadAloud','./read-aloud.js'),PC=need('CustomStylePaperChat','./paper-chat.js'),TR=need('CustomStylePaperTranslate','./paper-translate.js');
  const t=value=>typeof runtime.t==='function'?runtime.t(value):value;
  const T=(key,...values)=>t(key).replace(/\{(\d+)\}/g,(m,i)=>values[Number(i)]);
  const log=error=>{try{Z.logError?.(error);}catch(_){}};
  const describe=error=>{const fail=root.CustomStyleFailures;return t(fail?fail.describe(error):String(error&&error.message||error));};
  const paperText=()=>root.StyleCustomPaperText||RA.fallbackPaperText;
  const sessions=new Map();let stopped=false,cssPromise=null,sequence=0;
  const setting=(key,fallback)=>{try{const v=runtime.getSetting(key);return v===undefined||v===null?fallback:v;}catch(_){return fallback;}};
  const language=()=>setting('aiLanguage','Korean');
  const owner=(runtime.id||'style-custom')+'/reader-assist-'+Math.random().toString(36).slice(2);

  /* ---- the plugin's own cache folder ------------------------------------ */
  const io=()=>runtime.io||(typeof IOUtils!=='undefined'?IOUtils:null);
  const paths=()=>runtime.paths||(typeof PathUtils!=='undefined'?PathUtils:null);
  const folder=()=>paths().join(Z.DataDirectory.dir,'style-custom-reader');
  const safeName=name=>/^[\w.-]{1,80}$/.test(name)?name:null;
  const store={
   async read(name){
    try{
     const file=safeName(name)&&paths().join(folder(),name+'.json');if(!file||!await io().exists(file))return null;
     if((await io().stat(file)).size>16*1024*1024)return null;
     return JSON.parse(await io().readUTF8(file));
    }catch(error){log(error);return null;}
   },
   async write(name,value){
    try{
     const file=safeName(name)&&paths().join(folder(),name+'.json');if(!file)return false;
     const text=JSON.stringify(value);if(text.length>14*1024*1024)return false;
     await io().makeDirectory?.(folder(),{ignoreExisting:true,createAncestors:true});
     await io().writeUTF8(file,text,{tmpPath:file+'.tmp'});return true;
    }catch(error){log(error);return false;}
   },
   async remove(name){try{const file=safeName(name)&&paths().join(folder(),name+'.json');if(file&&await io().exists(file))await io().remove(file);}catch(error){log(error);}}
  };
  const uiState=()=>runtime.cache.readerAssist||(runtime.cache.readerAssist={});
  const persistUI=()=>{runtime.dirty=true;try{runtime.scheduleFlush?.(3000);}catch(_){}};

  /* ---- what the reader is showing --------------------------------------- */
  const coreOf=reader=>reader&&reader._internalReader;
  const stats=reader=>coreOf(reader)?._state?.primaryViewStats||{};
  const currentPage=reader=>{const p=stats(reader).pageIndex;return Number.isInteger(p)&&p>=0?p+1:null;};
  const pageCount=reader=>{const n=stats(reader).pagesCount;return Number.isInteger(n)&&n>0?n:0;};
  const viewerWindow=reader=>{const w=coreOf(reader)?._primaryView?._iframeWindow;return w?(w.wrappedJSObject||w):null;};
  const viewerDoc=reader=>{try{return coreOf(reader)?._primaryView?._iframeWindow?.document||null;}catch(_){return null;}};
  const attachmentOf=reader=>Z.Items.get(reader.itemID);
  const itemOf=reader=>{const a=attachmentOf(reader);return a&&a.parentID?Z.Items.get(a.parentID):a;};
  const fieldOf=(item,name)=>{try{return clean(item&&item.getField(name));}catch(_){return '';}};

  /* A rectangle in the extraction module's page space (top left, scale 1) as the reader wants it: PDF user space, bottom left. */
  function toPdfRects(session,pageIndex,rects){
   const size=session.pageSizes&&session.pageSizes[pageIndex];
   if(!size||!Array.isArray(size.transform)||!Array.isArray(rects))return null;
   const [a,b,c,d,e,f]=size.transform,det=a*d-b*c;if(!det)return null;
   const back=(vx,vy)=>[(d*(vx-e)-c*(vy-f))/det,(-b*(vx-e)+a*(vy-f))/det];
   return rects.filter(r=>Array.isArray(r)&&r.length>=4).slice(0,1).map(([x,y,w,h])=>{const p=back(x,y),q=back(x+w,y+h);return [Math.min(p[0],q[0]),Math.min(p[1],q[1]),Math.max(p[0],q[0]),Math.max(p[1],q[1])];});
  }
  function goToPage(session,page,rects){
   const pageIndex=Math.max(0,Number(page)-1);if(!Number.isFinite(pageIndex))return;
   const location={pageIndex},pdf=toPdfRects(session,pageIndex,rects);
   if(pdf&&pdf.length)location.position={pageIndex,rects:pdf};
   try{Promise.resolve(session.reader.navigate(location)).catch(log);}catch(error){log(error);}
  }

  /* ---- the paper's text, once per attachment ------------------------------ */
  const sleepIn=(win,ms)=>new Promise(resolve=>(win&&win.setTimeout?win:globalThis).setTimeout(resolve,ms));
  const plainContent=content=>({items:(content.items||[]).map(i=>({str:String(i.str||''),dir:i.dir,transform:Array.from(i.transform||[]),width:Number(i.width)||0,height:Number(i.height)||0,fontName:i.fontName,hasEOL:!!i.hasEOL})),styles:JSON.parse(JSON.stringify(content.styles||{}))});
  async function extractWithPdfjs(session,progress){
   const win=session.doc.defaultView,reader=session.reader;
   const wait=async()=>{for(let i=0;i<60;i++){const app=viewerWindow(reader)?.PDFViewerApplication;if(app&&app.pdfDocument)return app.pdfDocument;await sleepIn(win,250);}return null;};
   const pdf=await wait();if(!pdf)return null;
   const pages=[],sizes=[];
   for(let i=1;i<=pdf.numPages;i++){
    if(session.destroyed)return null;
    const page=await pdf.getPage(i),viewport=page.getViewport({scale:1}),content=await page.getTextContent();
    // Bold and italic come from the fonts pdf.js has loaded for the page; without them the extractor infers headings from glyph widths.
    const fonts={};
    if(pdf.numPages<=60)try{await page.getOperatorList();for(const id of Object.keys(content.styles||{})){try{const font=page.commonObjs.get(id);fonts[id]={name:font.name,bold:!!font.bold||!!font.black,italic:!!font.italic};}catch(_){}}}catch(_){}
    const transform=Array.from(viewport.transform||[1,0,0,-1,0,viewport.height]);
    const plainViewport={width:viewport.width,height:viewport.height,rotation:viewport.rotation||0,scale:1,transform};
    pages.push(paperText().pageFromPdfjs(i-1,plainViewport,plainContent(content),{fonts}));
    sizes.push({width:viewport.width,height:viewport.height,transform,rotation:viewport.rotation||0});
    progress&&progress(i,pdf.numPages);
    if(i%3===0)await sleepIn(win,0);
   }
   return {pages,sizes};
  }
  async function loadStructure(session){
   const attachment=attachmentOf(session.reader),item=itemOf(session.reader);
   const meta={title:fieldOf(item,'title'),abstract:fieldOf(item,'abstractNote')};
   let sig='';
   try{const path=await attachment.getFilePathAsync();if(path){const s=await io().stat(path);sig=s.size+':'+(s.lastModified||s.lastModifiedMs||0);}}catch(_){}
   const name=session.name+'.struct';
   const saved=await store.read(name);
   // A structure made from plain text is not kept once the real extractor is there to do better.
   if(saved&&sig&&saved.sig===sig&&saved.structured&&saved.v===1&&(!saved.fallback||!root.StyleCustomPaperText)){session.pageSizes=saved.sizes||[];return {structured:saved.structured,fallback:!!saved.fallback,fromCache:true};}
   let structured=null,fallback=false,sizes=[];
   const setProgress=(i,n)=>{session.extracting={i,n};session.onProgress&&session.onProgress();};
   try{
    if(root.StyleCustomPaperText){
     const got=await extractWithPdfjs(session,setProgress);
     if(got&&got.pages.length){structured=root.StyleCustomPaperText.structure({pages:got.pages,meta});sizes=got.sizes;}
    }
   }catch(error){log(error);}
   session.extracting=null;
   if(!structured){
    // Zotero's own text index: no positions, so no highlight on the page, but the rest works.
    let text='';
    try{const full=await Z.PDFWorker.getFullText(attachment.id);text=full&&full.text||'';}catch(error){log(error);}
    if(!text)throw new Error('이 PDF에서 본문을 읽지 못했습니다. 스캔한 이미지일 수 있습니다.');
    structured=RA.fallbackPaperText.structure({text,meta});fallback=true;
    if(!structured.title)structured.title=meta.title;if(!structured.abstract)structured.abstract=meta.abstract;
   }
   session.pageSizes=sizes;
   if(sig)store.write(name,{v:1,sig,structured,sizes,fallback,at:Date.now()});
   return {structured,fallback,fromCache:false};
  }
  const structure=session=>session.structurePromise||(session.structurePromise=loadStructure(session).then(result=>{session.structured=result.structured;session.fallback=result.fallback;session.chunks=null;return result;},error=>{session.structureError=error;session.structurePromise=null;throw error;}));
  const tools=session=>session.fallback?RA.fallbackPaperText:paperText();

  /* ---- per-paper saved state -------------------------------------------- */
  async function loadData(session){
   const saved=await store.read(session.name+'.state');
   if(saved&&saved.v===1)Object.assign(session.data,saved);
   if(!session.data.summary||typeof session.data.summary!=='object')session.data.summary={};
   if(!Array.isArray(session.data.chat))session.data.chat=[];
   if(!session.data.tr||typeof session.data.tr!=='object')session.data.tr={};
   return session.data;
  }
  function saveSoon(session){
   if(session.saveTimer||session.destroyed)return;
   const win=session.doc.defaultView;
   session.saveTimer=win.setTimeout(()=>{session.saveTimer=null;store.write(session.name+'.state',session.data);},800);
  }
  async function saveNow(session){
   if(session.saveTimer){try{session.doc.defaultView.clearTimeout(session.saveTimer);}catch(_){}session.saveTimer=null;}
   if(session.data)await store.write(session.name+'.state',session.data);
  }

  /* ---- styles ------------------------------------------------------------ */
  function stylesheet(){
   if(!cssPromise)cssPromise=Promise.resolve().then(async()=>{
    try{const r=await Z.HTTP.request('GET',runtime.rootURI+'content/reader-assist.css',{responseType:'text',successCodes:[200,0]});return String(r.response??r.responseText??'');}
    catch(error){log(error);return '';}
   });
   return cssPromise;
  }

  /* ---- the panel ------------------------------------------------------------ */
  function button(session,parent,{label,title,iconName,cls='',mark,onClick,disabled=false}){
   const doc=session.doc;
   const b=el(doc,'button',{type:'button','class':'sc-ra-btn '+cls,title:title?t(title):(label?t(label):undefined),'aria-label':t(title||label||'')},parent);
   // The mark is one of: view | audio | ai | network | memo | note | cache
   if(['view'].includes(mark))b.setAttribute('data-safe','view');
   else if(['memo','note','cache'].includes(mark))b.setAttribute('data-writes',mark);
   else b.setAttribute('data-opens',mark);
   if(iconName)b.appendChild(icon(doc,iconName));
   if(label){const s=el(doc,'span',{'class':'sc-ra-btn-text'},b);s.textContent=t(label);}
   if(disabled)b.disabled=true;
   if(onClick)b.addEventListener('click',event=>{event.stopPropagation();if(b.disabled)return;Promise.resolve().then(()=>onClick(event)).catch(error=>{log(error);session.say&&session.say(describe(error),true);});});
   return b;
  }
  /* A menu drawn inside the panel with an opaque background: a native <select> popup is
     unreliable over some surfaces (see the XHTML window notes), and this is drivable and testable. */
  function menu(session,parent,{label,items,current,onPick,mark='view',ariaLabel}){
   const doc=session.doc,wrap=el(doc,'span',{'class':'sc-ra-menu-wrap'},parent);
   const toggle=el(doc,'button',{type:'button','class':'sc-ra-pill','data-safe':'view','aria-haspopup':'menu','aria-expanded':'false','aria-label':t(ariaLabel||label)},wrap);
   const text=el(doc,'span',{'class':'sc-ra-pill-text'},toggle);toggle.appendChild(icon(doc,'caret',12));
   const list=el(doc,'div',{'class':'sc-ra-menu',role:'menu',hidden:true},wrap);
   const handle={toggle,list,text,close(){list.hidden=true;toggle.setAttribute('aria-expanded','false');},
    set(next){
     handle.items=next.items||handle.items;handle.current=next.current!==undefined?next.current:handle.current;
     text.textContent=next.label!==undefined?next.label:(handle.items.find(i=>i.value===handle.current)||{}).label||t(label);
     list.replaceChildren();
     for(const item of handle.items){
      const b=el(doc,'button',{type:'button',role:'menuitemradio','aria-checked':String(item.value===handle.current),'class':'sc-ra-menu-item'},list);
      mark==='view'?b.setAttribute('data-safe','view'):b.setAttribute('data-opens',mark);
      b.textContent=item.label;
      b.addEventListener('click',event=>{event.stopPropagation();handle.close();Promise.resolve().then(()=>onPick(item.value,item)).catch(log);});
     }
    }};
   handle.items=items||[];handle.set({items,current});
   toggle.addEventListener('click',event=>{
    event.stopPropagation();const open=list.hidden;for(const other of session.menus)other.close();
    list.hidden=!open;toggle.setAttribute('aria-expanded',String(open));
   });
   session.menus.add(handle);return handle;
  }

  function buildPanel(session){
   const doc=session.doc,ui=session.ui={};
   const rootEl=el(doc,'aside',{'class':'sc-ra','data-sc-ra':'1','aria-label':t('논문 도우미'),role:'complementary',hidden:true});
   ui.root=rootEl;
   const head=el(doc,'header',{'class':'sc-ra-head'},rootEl);
   el(doc,'strong',{'class':'sc-ra-title',text:t('논문 도우미')},head);
   ui.status=el(doc,'span',{'class':'sc-ra-status',role:'status','aria-live':'polite'},head);
   button(session,head,{title:'패널 닫기',iconName:'close',cls:'sc-ra-icon',mark:'view',onClick:()=>setOpen(session,false)});
   buildPlayer(session,rootEl);
   const tabs=el(doc,'nav',{'class':'sc-ra-tabs',role:'tablist','aria-label':t('도우미 메뉴')},rootEl);ui.tabs={};
   for(const[id,label,ic]of [['ask','요약·대화','message'],['translate','번역','translate'],['listen','듣기 목록','list']]){
    const b=el(doc,'button',{type:'button',role:'tab','class':'sc-ra-tab','data-safe':'view','data-tab':id,'aria-selected':'false'},tabs);
    b.appendChild(icon(doc,ic,14));el(doc,'span',{'class':'sc-ra-tab-text',text:t(label)},b);ui.tabs[id]={button:b,badge:el(doc,'span',{'class':'sc-ra-badge',hidden:true},b)};
    b.addEventListener('click',event=>{event.stopPropagation();showTab(session,id);});
   }
   const body=el(doc,'div',{'class':'sc-ra-body'},rootEl);ui.body=body;ui.panes={};
   for(const id of ['ask','translate','listen'])ui.panes[id]=el(doc,'div',{'class':'sc-ra-pane',role:'tabpanel','data-pane':id,hidden:true},body);
   buildAsk(session,ui.panes.ask);buildTranslate(session,ui.panes.translate);buildListen(session,ui.panes.listen);
   // A click anywhere else closes an open menu.
   session.onDocClick=()=>{for(const m of session.menus)m.close();};doc.addEventListener('click',session.onDocClick);
   session.onKey=event=>{if(event.key==='Escape')for(const m of session.menus)m.close();};doc.addEventListener('keydown',session.onKey);
   return rootEl;
  }

  /* -- the player bar -- */
  function buildPlayer(session,parent){
   const doc=session.doc,ui=session.ui;
   const bar=el(doc,'section',{'class':'sc-ra-card sc-ra-player','aria-label':t('읽어주기')},parent);
   const row=el(doc,'div',{'class':'sc-ra-row'},bar);
   ui.sectionPrev=button(session,row,{title:'이전 섹션',iconName:'sectionPrev',cls:'sc-ra-icon',mark:'audio',onClick:()=>withPlayer(session,p=>p.prevSection())});
   ui.prev=button(session,row,{title:'이전 문장',iconName:'prev',cls:'sc-ra-icon',mark:'audio',onClick:()=>withPlayer(session,p=>p.prev())});
   ui.play=button(session,row,{title:'읽어주기',iconName:'play',cls:'sc-ra-icon sc-ra-play',mark:'audio',onClick:()=>togglePlay(session)});
   ui.next=button(session,row,{title:'다음 문장',iconName:'next',cls:'sc-ra-icon',mark:'audio',onClick:()=>withPlayer(session,p=>p.next())});
   ui.sectionNext=button(session,row,{title:'다음 섹션',iconName:'sectionNext',cls:'sc-ra-icon',mark:'audio',onClick:()=>withPlayer(session,p=>p.nextSection())});
   ui.progress=el(doc,'span',{'class':'sc-ra-progress',text:''},row);
   const opts=el(doc,'div',{'class':'sc-ra-row sc-ra-opts'},bar);
   const rateWrap=el(doc,'label',{'class':'sc-ra-rate'},opts);el(doc,'span',{text:t('속도')},rateWrap);
   ui.rate=el(doc,'input',{type:'range',min:'80',max:'180',step:'10',value:String(setting('readAloudSpeed',100)),'aria-label':t('읽는 속도'),'data-opens':'audio'},rateWrap);
   ui.rateText=el(doc,'span',{'class':'sc-ra-rate-text'},rateWrap);
   ui.rate.addEventListener('input',()=>{const pct=Number(ui.rate.value);ui.rateText.textContent=(pct/100).toFixed(1)+'×';});
   ui.rate.addEventListener('change',()=>setRate(session,Number(ui.rate.value)/100));
   ui.rateText.textContent=(Number(ui.rate.value)/100).toFixed(1)+'×';
   ui.voice=menu(session,opts,{label:'목소리',ariaLabel:'목소리 고르기',items:[{value:'',label:t('자동')}],current:'',mark:'audio',onPick:value=>setVoice(session,value)});
   const filters=el(doc,'div',{'class':'sc-ra-seg',role:'group','aria-label':t('읽을 범위')},bar);ui.filters={};
   for(const[id,label]of [['body','본문만'],['captions','캡션 포함'],['references','참고문헌 포함']]){
    const b=el(doc,'button',{type:'button','class':'sc-ra-seg-btn','data-opens':'audio','data-filter':id,'aria-pressed':String(id==='body')},filters);b.textContent=t(label);ui.filters[id]=b;
    b.addEventListener('click',event=>{event.stopPropagation();setFilter(session,id);});
   }
   const more=el(doc,'div',{'class':'sc-ra-row sc-ra-more'},bar);
   ui.resume=button(session,more,{label:'이어서 듣기',iconName:'play',cls:'sc-ra-link',mark:'audio',onClick:()=>resumeListening(session)});ui.resume.hidden=true;
   const why=el(doc,'details',{'class':'sc-ra-why'},bar);
   const sum=el(doc,'summary',{text:t('왜 건너뛰었나')},why);void sum;
   ui.why=el(doc,'pre',{'class':'sc-ra-pre'},why);
   why.addEventListener('toggle',()=>{if(why.open)fillWhy(session);});
  }
  async function fillWhy(session){
   try{
    const {structured}=await structure(session);
    session.ui.why.textContent=String(tools(session).debug?tools(session).debug(structured):'')||t('건너뛴 부분이 없습니다.');
   }catch(error){session.ui.why.textContent=describe(error);}
  }

  /* -- summary and chat -- */
  function buildAsk(session,pane){
   const doc=session.doc,ui=session.ui;
   const card=el(doc,'section',{'class':'sc-ra-card sc-ra-summary','aria-label':t('AI 요약')},pane);
   const head=el(doc,'div',{'class':'sc-ra-card-head'},card);el(doc,'h3',{'class':'sc-ra-h3',text:t('AI 요약')},head);
   ui.summaryActions=el(doc,'div',{'class':'sc-ra-actions'},head);
   ui.summaryCopy=button(session,ui.summaryActions,{title:'요약 복사',iconName:'copy',cls:'sc-ra-icon',mark:'view',onClick:()=>copyText(session,summaryEntry(session)?.text||'')});
   ui.summaryMemo=button(session,ui.summaryActions,{title:'메모에 넣기',iconName:'note',cls:'sc-ra-icon',mark:'memo',onClick:()=>toMemo(session,summaryEntry(session)?.text||'',t('AI 요약'))});
   ui.summaryAgain=button(session,ui.summaryActions,{title:'다시 만들기',iconName:'refresh',cls:'sc-ra-icon',mark:'ai',onClick:()=>runSummary(session,{force:true})});
   ui.summaryBody=el(doc,'div',{'class':'sc-ra-md'},card);
   ui.summaryStart=button(session,card,{label:'요약 만들기',cls:'sc-ra-primary',mark:'ai',onClick:()=>runSummary(session,{})});
   ui.summaryNote=el(doc,'p',{'class':'sc-ra-note'},card);
   const chat=el(doc,'section',{'class':'sc-ra-card sc-ra-chat','aria-label':t('논문과 대화')},pane);
   const chead=el(doc,'div',{'class':'sc-ra-card-head'},chat);el(doc,'h3',{'class':'sc-ra-h3',text:t('논문과 대화')},chead);
   const cactions=el(doc,'div',{'class':'sc-ra-actions'},chead);
   ui.chatClear=button(session,cactions,{title:'대화 지우기',iconName:'trash',cls:'sc-ra-icon',mark:'cache',onClick:()=>clearChat(session)});
   const chips=el(doc,'div',{'class':'sc-ra-chips'},chat);
   for(const id of Object.keys(PC.QUICK)){
    const q=PC.QUICK[id];button(session,chips,{label:q.label,cls:'sc-ra-chip',mark:'ai',onClick:()=>sendQuick(session,id)});
   }
   ui.chatList=el(doc,'div',{'class':'sc-ra-messages',role:'log','aria-live':'polite'},chat);
   const composer=el(doc,'div',{'class':'sc-ra-composer'},chat);
   ui.input=el(doc,'textarea',{'class':'sc-ra-input',rows:'2',placeholder:t('이 논문에 대해 물어보세요'),'aria-label':t('질문 입력')},composer);
   ui.send=button(session,composer,{title:'보내기',iconName:'send',cls:'sc-ra-send',mark:'ai',onClick:()=>sendTyped(session)});
   ui.stop=button(session,composer,{title:'중지',iconName:'stop',cls:'sc-ra-send',mark:'view',onClick:()=>{runtime.assist?.cancel?.();}});ui.stop.hidden=true;
   ui.input.addEventListener('keydown',event=>{
    // Enter sends; Shift+Enter is a new line; Enter that confirms a Korean/Japanese composition does not send.
    if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();sendTyped(session);}
   });
   ui.chatNote=el(doc,'p',{'class':'sc-ra-note'},chat);
  }
  const summaryKey=()=>String(runtime.pref('aiModel','')).trim()+'|'+language();
  const summaryEntry=session=>session.data&&session.data.summary[summaryKey()]||null;
  function renderSummary(session){
   const ui=session.ui,entry=summaryEntry(session),state=session.summaryState||'idle';
   const configured=!!runtime.assist?.available?.();
   ui.summaryBody.replaceChildren();ui.summaryNote.textContent='';
   const has=!!entry&&state!=='loading';
   for(const b of [ui.summaryCopy,ui.summaryMemo,ui.summaryAgain])b.hidden=!has;
   ui.summaryStart.hidden=has||state==='loading';
   if(state==='loading'){el(session.doc,'p',{'class':'sc-ra-muted',text:t('요약하는 중…')},ui.summaryBody);}
   else if(entry){
    renderMarkdown(session.doc,ui.summaryBody,entry.text,{pages:pageCount(session.reader),onPage:page=>goToPage(session,page)});
    ui.summaryNote.textContent=T('{0} · {1}',entry.model||t('모델 미표기'),new Date(entry.at).toLocaleDateString())+(entry.truncated?' · '+t('긴 논문이라 일부만 읽혔습니다'):'');
   }else if(state==='error'){el(session.doc,'p',{'class':'sc-ra-error',text:session.summaryError||''},ui.summaryBody);}
   else ui.summaryNote.textContent=configured?t('눌러야 AI 서버로 보냅니다. 본문 일부와 제목·초록만 전송합니다.'):t('설정 → 번역·AI에서 AI 서버 주소와 모델을 넣으세요. 내 컴퓨터의 로컬 모델도 됩니다.');
  }
  async function runSummary(session,{force=false,auto=false}={}){
   if(session.summaryState==='loading')return;
   if(!force&&summaryEntry(session)){renderSummary(session);return;}
   session.summaryState='loading';session.summaryError='';renderSummary(session);
   try{
    let structured=null;try{structured=(await structure(session)).structured;}catch(error){log(error);}
    const item=itemOf(session.reader),meta={title:fieldOf(item,'title'),abstract:fieldOf(item,'abstractNote')};
    const input=PC.summaryInput(structured||{},{meta,pageBase:PAGE_BASE});
    const text=await runtime.assist.run('paperSummary',{title:input.title,abstract:input.abstract,text:input.text},{language:language()});
    session.data.summary[summaryKey()]={text,at:Date.now(),model:String(runtime.pref('aiModel','')).trim(),language:language(),truncated:input.truncated};
    const keys=Object.keys(session.data.summary);if(keys.length>6)delete session.data.summary[keys[0]];
    session.summaryState='done';saveSoon(session);
   }catch(error){session.summaryState='error';session.summaryError=describe(error);}
   if(!session.destroyed)renderSummary(session);
  }

  /* -- chat -- */
  const MESSAGE_ROLE={user:'user',assistant:'assistant'};
  function renderChat(session){
   const ui=session.ui,doc=session.doc,list=ui.chatList;
   list.replaceChildren();
   const messages=session.data.chat;
   if(!messages.length){el(doc,'p',{'class':'sc-ra-muted',text:t('아직 대화가 없습니다. 아래 버튼을 누르거나 질문을 입력하세요.')},list);}
   messages.forEach((m,index)=>{
    const bubble=el(doc,'article',{'class':'sc-ra-msg sc-ra-msg-'+(MESSAGE_ROLE[m.role]||'assistant'),'data-index':index},list);
    const body=el(doc,'div',{'class':'sc-ra-md'},bubble);
    if(m.role==='assistant')renderMarkdown(doc,body,m.content||(m.streaming?'…':''),{pages:pageCount(session.reader),onPage:page=>goToPage(session,page)});
    else body.textContent=m.content;
    if(m.error)el(doc,'p',{'class':'sc-ra-error',text:m.error},bubble);
    if(m.role==='assistant'&&!m.streaming&&m.content){
     const actions=el(doc,'div',{'class':'sc-ra-actions sc-ra-msg-actions'},bubble);
     button(session,actions,{title:'답변 복사',iconName:'copy',cls:'sc-ra-icon',mark:'view',onClick:()=>copyText(session,m.content)});
     button(session,actions,{title:'메모에 넣기',iconName:'note',cls:'sc-ra-icon',mark:'memo',onClick:()=>toMemo(session,m.content,t('AI 답변'))});
    }
   });
   const busy=!!session.chatBusy;
   ui.send.hidden=busy;ui.stop.hidden=!busy;ui.input.disabled=false;
   setBadge(session,'ask',messages.length);
   if(list.scrollTo)try{list.scrollTop=list.scrollHeight;}catch(_){}
  }
  function trimChat(session){
   const clean_=session.data.chat.filter(m=>!m.streaming);
   session.data.chat=clean_.slice(-MAX_CHAT).map(m=>({role:m.role,content:String(m.content||'').slice(0,CHAT_LIMIT*3),at:m.at,error:m.error||undefined}));
  }
  const sendTyped=session=>{const q=clean(session.ui.input.value);if(!q)return;session.ui.input.value='';return sendQuestion(session,q,{});};
  const sendQuick=(session,id)=>{const q=PC.quickPrompt(id,t);return sendQuestion(session,q.question,{forcePage:q.forcePage,mine:q.mine});};
  async function sendQuestion(session,question,{forcePage=false,mine=false}={}){
   if(session.chatBusy)return;
   const history=session.data.chat.filter(m=>!m.error).slice();
   const user={role:'user',content:question.slice(0,CHAT_LIMIT),at:Date.now()},answer={role:'assistant',content:'',streaming:true,at:Date.now()};
   session.data.chat.push(user,answer);session.chatBusy=true;renderChat(session);
   let timer=null;const refresh=()=>{timer=null;if(!session.destroyed)renderChat(session);};
   try{
    if(!runtime.assist?.available?.())throw new Error('설정에서 AI 서버 주소와 모델을 먼저 입력하세요.');
    let structured=null,notice='';
    try{structured=(await structure(session)).structured;}catch(error){log(error);notice=t('본문을 읽지 못해 초록만 참고했습니다.');}
    const item=itemOf(session.reader);
    const doc=structured||{title:fieldOf(item,'title'),abstract:fieldOf(item,'abstractNote'),sections:[]};
    session.chunks=session.chunks||PC.buildChunks(doc,{pageBase:PAGE_BASE});
    const page=currentPage(session.reader),sectionIndex=structured?PC.sectionAtPage(structured,page||1,{pageBase:PAGE_BASE}):-1;
    const viewing={page,sectionIndex,section:sectionIndex>=0?clean(structured.sections[sectionIndex].heading):''};
    const own=mine?{memo:String(runtime.entry?.(item)?.remark||''),tags:(item?.getTags?.()||[]).map(x=>String(x.tag||x))}:null;
    const entry=summaryEntry(session);
    const {messages}=PC.chatMessages({question,history,chunks:session.chunks,summary:entry?entry.text:'',language:language(),viewing,mine:own,forcePage});
    session.ui.chatNote.textContent=notice;
    const text=await runtime.assist.chat(messages,{onDelta:(piece,all)=>{answer.content=all;if(timer===null&&session.doc.defaultView)timer=session.doc.defaultView.setTimeout(refresh,90);}});
    answer.content=text;
   }catch(error){answer.error=describe(error);}
   answer.streaming=false;session.chatBusy=false;if(timer!==null){try{session.doc.defaultView.clearTimeout(timer);}catch(_){}}
   if(!answer.content&&answer.error){session.data.chat.splice(session.data.chat.indexOf(answer),1);session.data.chat.splice(session.data.chat.indexOf(user),1);session.ui.chatNote.textContent=answer.error;session.ui.input.value=question;}
   trimChat(session);saveSoon(session);if(!session.destroyed)renderChat(session);
  }
  function clearChat(session){session.data.chat=[];saveSoon(session);renderChat(session);}

  /* -- the memo and the clipboard -- */
  async function toMemo(session,text,heading){
   const item=itemOf(session.reader);if(!item||!clean(text))return;
   const library=runtime.libraryService;if(!library?.setRemark)throw new Error('Remark storage is unavailable');
   const base=String(runtime.entry?.(item)?.remark||'');
   const stamp=new Date().toISOString().slice(0,10);
   const next=(base?base.replace(/\s+$/,'')+'\n\n':'')+'--- '+heading+' · '+stamp+' ---\n'+String(text).trim()+'\n';
   const result=await library.setRemark(item.id,next,{base});
   if(result&&result.stale){say(session,t('메모가 그 사이 바뀌었습니다. 연구 작업 패널에서 확인한 뒤 다시 눌러 주세요.'),true);return;}
   say(session,t('메모에 넣었습니다.'));
  }
  async function copyText(session,text){
   if(!text)return;
   try{
    const helper=Z.Utilities?.Internal?.copyTextToClipboard;
    if(typeof helper==='function')helper.call(Z.Utilities.Internal,text);
    else await session.doc.defaultView.navigator.clipboard.writeText(text);
    say(session,t('복사했습니다.'));
   }catch(error){log(error);say(session,t('복사하지 못했습니다.'),true);}
  }
  function say(session,message,isError=false){
   const s=session.ui&&session.ui.status;if(!s)return;
   s.textContent=message||'';s.dataset.error=isError?'true':'false';
   if(session.sayTimer)session.doc.defaultView.clearTimeout(session.sayTimer);
   if(message)session.sayTimer=session.doc.defaultView.setTimeout(()=>{s.textContent='';},isError?9000:3500);
  }

  /* -- translation -- */
  function buildTranslate(session,pane){
   const doc=session.doc,ui=session.ui;
   const card=el(doc,'section',{'class':'sc-ra-card sc-ra-tr','aria-label':t('번역')},pane);
   const head=el(doc,'div',{'class':'sc-ra-card-head'},card);el(doc,'h3',{'class':'sc-ra-h3',text:t('문단별 번역')},head);
   const bar=el(doc,'div',{'class':'sc-ra-actions'},head);
   ui.trTarget=menu(session,bar,{label:'번역 언어',ariaLabel:'번역할 언어 고르기',items:[],current:'',mark:'view',onPick:value=>setTarget(session,value)});
   ui.trProvider=el(doc,'p',{'class':'sc-ra-note'},card);
   ui.trEstimate=el(doc,'p',{'class':'sc-ra-note'},card);
   const row=el(doc,'div',{'class':'sc-ra-row sc-ra-wrap'},card);
   ui.trPage=button(session,row,{label:'현재 페이지부터',cls:'sc-ra-primary',mark:'ai',onClick:()=>runTranslate(session,'page')});
   ui.trAll=button(session,row,{label:'전체 번역',cls:'sc-ra-secondary',mark:'ai',onClick:()=>runTranslate(session,'all')});
   ui.trStop=button(session,row,{label:'중지',cls:'sc-ra-secondary',mark:'view',onClick:()=>session.tr&&session.tr.service.cancel()});ui.trStop.hidden=true;
   ui.trNext=button(session,row,{label:'다른 번역기로 이어서',cls:'sc-ra-secondary',mark:'ai',onClick:()=>runTranslate(session,'resume',{next:true})});ui.trNext.hidden=true;
   const row2=el(doc,'div',{'class':'sc-ra-row sc-ra-wrap'},card);
   ui.trUsage=button(session,row2,{label:'사용량 새로고침',iconName:'refresh',cls:'sc-ra-link',mark:'network',onClick:()=>refreshUsage(session)});
   ui.trNote=button(session,row2,{label:'노트로 저장',iconName:'note',cls:'sc-ra-link',mark:'note',onClick:()=>saveTranslationNote(session)});
   ui.trProgress=el(doc,'p',{'class':'sc-ra-note',role:'status'},card);
   ui.trRows=el(doc,'div',{'class':'sc-ra-rows'},pane);
  }
  function translator(session){
   if(session.tr)return session.tr;
   const data=session.data;
   const cache={get:k=>data.tr[k],set:(k,v)=>{data.tr[k]=v;const keys=Object.keys(data.tr);if(keys.length>4000)delete data.tr[keys[0]];},save:async()=>{saveSoon(session);}};
   const http=async(method,url,{headers,body})=>{
    try{
     const r=await Z.HTTP.request(method,url,{headers,body,responseType:'json',timeout:60000,successCodes:false,errorDelayMax:0});
     return {status:r.status,json:r.response,retryAfter:Number(r.getResponseHeader&&r.getResponseHeader('Retry-After'))||0};
    }catch(_){return {status:0,json:null};}
   };
   const service=TR.create({http,now:()=>new Date(),pref:key=>runtime.pref(key,''),cache,
    usageStore:{get:()=>runtime.cache.deeplUsage,set:v=>{runtime.cache.deeplUsage=v;persistUI();}},
    pdfTranslate:()=>Z.PDFTranslate&&Z.PDFTranslate.api,
    ai:{available:()=>!!runtime.assist?.available?.(),translate:(texts,o)=>runtime.assist.translateParagraphs(texts,o)},
    uiKorean:runtime.i18n?.isKorean?.()!==false});
   return session.tr={service,paragraphs:[],texts:new Map()};
  }
  async function prepareTranslate(session){
   const tr=translator(session);
   try{
    const {structured}=await structure(session);
    tr.paragraphs=TR.paragraphsOf(structured,{pageBase:PAGE_BASE});
   }catch(error){tr.paragraphs=[];session.ui.trProgress.textContent=describe(error);}
   renderTranslate(session);
  }
  function renderTranslate(session){
   const ui=session.ui,tr=translator(session),doc=session.doc,service=tr.service;
   const providers=service.providers(),current=service.pickProvider(),target=service.target();
   ui.trTarget.set({items:TR.TARGETS.map(x=>({value:x.code,label:x.label})),current:target.code,label:target.label});
   ui.trProvider.textContent=current?T('번역기: {0}',service.providerLabel(current))+(providers.length>1?' · '+T('대체: {0}',providers.slice(providers.indexOf(current)+1).map(service.providerLabel).join(', ')||'—'):''):t('번역기가 없습니다. 설정 → 번역·AI에서 DeepL 키를 넣으세요. DeepL 무료 키는 한 달 50만 자까지 쓸 수 있습니다.');
   const usage=service.usage();
   const start=Math.max(0,tr.paragraphs.findIndex(p=>(p.page||0)>=(currentPage(session.reader)||1)));
   const est=service.estimate(tr.paragraphs,current);
   const pageEst=service.estimate(tr.paragraphs.slice(start),current);
   ui.trEstimate.textContent=!tr.paragraphs.length?t('번역할 본문을 아직 읽지 못했습니다.'):
    T('전체 약 {0}자 · 이미 번역한 {1}문단은 제외',est.chars.toLocaleString(),est.cached)+' · '+T('현재 페이지부터 약 {0}자',pageEst.chars.toLocaleString())
    +(current==='deepl'?' · '+T('이번 달 {0} / {1}자 사용',usage.chars.toLocaleString(),usage.limit.toLocaleString())+(usage.free?'':' · '+t('유료 키')):'')
    +(current==='deepl'&&!est.fits?' · '+t('전체는 남은 한도를 넘습니다. 한도에 닿으면 거기서 멈추고 번역한 부분은 남습니다.'):'');
   for(const b of [ui.trPage,ui.trAll])b.disabled=!current||!tr.paragraphs.length||service.busy;
   ui.trStop.hidden=!service.busy;ui.trUsage.hidden=!service.providers().includes('deepl');ui.trNote.disabled=!tr.paragraphs.length;
   // rows
   ui.trRows.replaceChildren();let done=0;
   tr.paragraphs.forEach((p,i)=>{
    const text=current?service.cached(current,p.text)||tr.texts.get(p.id)||'':tr.texts.get(p.id)||'';
    if(text){tr.texts.set(p.id,text);done++;}
    const row=el(doc,'article',{'class':'sc-ra-row-card','data-id':p.id,'data-state':text?'done':'todo'},ui.trRows);
    const meta=el(doc,'button',{type:'button','class':'sc-ra-row-meta','data-safe':'view',title:t('이 문단으로 이동')},row);
    meta.textContent=(p.heading||'—')+(p.page?' · p. '+p.page:'');
    meta.addEventListener('click',()=>goToPage(session,p.page,p.rects));
    const body=el(doc,'p',{'class':'sc-ra-tr-text'},row);body.textContent=text||'—';
    const orig=el(doc,'details',{'class':'sc-ra-orig'},row);el(doc,'summary',{text:t('원문')},orig);el(doc,'p',{'class':'sc-ra-orig-text'},orig).textContent=p.text;
    const again=button(session,row,{label:'다시 번역',cls:'sc-ra-link',mark:'ai',onClick:()=>retranslate(session,p)});
    void i;void again;
   });
   setBadge(session,'translate',tr.paragraphs.length?done+'/'+tr.paragraphs.length:0);
  }
  function paintParagraph(session,p,text){
   const tr=translator(session);tr.texts.set(p.id,text);
   const row=session.ui.trRows.querySelector('[data-id="'+p.id+'"]');
   if(row){row.setAttribute('data-state','done');const body=row.querySelector('.sc-ra-tr-text');if(body)body.textContent=text;}
  }
  async function runTranslate(session,mode,{next=false}={}){
   const tr=translator(session),service=tr.service,ui=session.ui;
   if(service.busy)return;
   if(!tr.paragraphs.length)await prepareTranslate(session);
   let provider=service.pickProvider();
   if(next)provider=service.nextProvider(session.trProvider||provider)||provider;
   if(!provider){ui.trProgress.textContent=t('번역기가 없습니다. 설정 → 번역·AI에서 DeepL 키를 넣으세요.');return;}
   session.trProvider=provider;ui.trNext.hidden=true;
   let start=0;
   if(mode==='page')start=Math.max(0,tr.paragraphs.findIndex(p=>(p.page||0)>=(currentPage(session.reader)||1)));
   ui.trStop.hidden=false;for(const b of [ui.trPage,ui.trAll])b.disabled=true;
   const summary=await service.translateAll(tr.paragraphs,{start,provider,
    onParagraph:(p,text)=>paintParagraph(session,p,text),
    onProgress:p=>{const u=service.usage();ui.trProgress.textContent=T('번역 {0}/{1}문단 · {2}',p.done,p.total,service.providerLabel(provider))+(provider==='deepl'?' · '+T('이번 달 {0} / {1}자 사용',u.chars.toLocaleString(),u.limit.toLocaleString()):'');}}).catch(error=>({provider,done:0,total:0,stopped:error.code||'failed',error}));
   if(session.destroyed)return;
   ui.trProgress.textContent=summary.stopped==='cancelled'?T('중지했습니다. {0}문단 번역됨',summary.done):summary.stopped?describe(summary.error)+(summary.error&&summary.error.detail?' ('+summary.error.detail+')':'')+' · '+T('{0}문단 번역됨',summary.done):T('{0}문단 번역을 마쳤습니다.',summary.done);
   if(summary.stopped&&['quota','key','rate','server','failed','shape'].includes(summary.stopped)&&service.nextProvider(provider))ui.trNext.hidden=false;
   renderTranslate(session);
  }
  async function retranslate(session,paragraph){
   const tr=translator(session);
   const result=await tr.service.translateOne(paragraph,{provider:tr.service.pickProvider(),force:true});
   paintParagraph(session,paragraph,result.text);session.ui.trProgress.textContent=T('다시 번역했습니다 · {0}',tr.service.providerLabel(result.provider));
  }
  async function refreshUsage(session){
   const tr=translator(session);const u=await tr.service.refreshUsage();
   session.ui.trProgress.textContent=T('DeepL 사용량 {0} / {1}자',u.chars.toLocaleString(),u.limit.toLocaleString());renderTranslate(session);
  }
  async function setTarget(session,code){
   try{await runtime.setSetting('translateTarget',code,{apply:false});}catch(error){log(error);}
   renderTranslate(session);
  }
  async function saveTranslationNote(session){
   const tr=translator(session),item=itemOf(session.reader),library=runtime.libraryService;
   if(!item||!library?.createNoteHTML)throw new Error('Note creation is unavailable');
   const provider=tr.service.pickProvider()||'';
   const made=TR.noteHTML({title:fieldOf(item,'title'),target:tr.service.target().code,provider:tr.service.providerLabel(provider),date:new Date().toISOString().slice(0,10),paragraphs:tr.paragraphs,translations:tr.texts});
   if(!made.count){say(session,t('저장할 번역이 아직 없습니다.'),true);return;}
   await library.createNoteHTML(item.id,made.html);
   say(session,T('원문·번역 {0}문단을 노트로 저장했습니다.',made.count));
  }

  /* -- listen -- */
  function buildListen(session,pane){
   const doc=session.doc,ui=session.ui;
   const card=el(doc,'section',{'class':'sc-ra-card sc-ra-listen','aria-label':t('듣기 목록')},pane);
   const head=el(doc,'div',{'class':'sc-ra-card-head'},card);el(doc,'h3',{'class':'sc-ra-h3',text:t('듣기 목록')},head);
   const follow=el(doc,'label',{'class':'sc-ra-check'},head);
   ui.follow=el(doc,'input',{type:'checkbox','data-safe':'view','aria-label':t('PDF에서 따라가기')},follow);ui.follow.checked=uiState().follow!==false;
   el(doc,'span',{text:t('PDF에서 따라가기')},follow);
   ui.follow.addEventListener('change',()=>{uiState().follow=ui.follow.checked;persistUI();if(!ui.follow.checked)clearHighlight(session);});
   ui.listenNote=el(doc,'p',{'class':'sc-ra-note'},card);
   ui.transcript=el(doc,'div',{'class':'sc-ra-transcript'},pane);
  }
  function renderTranscript(session){
   const ui=session.ui,doc=session.doc,player=session.player;
   ui.transcript.replaceChildren();
   if(!player){ui.listenNote.textContent=t('▶를 누르면 문장 목록이 여기에 나타납니다. 문장을 누르면 그 문장부터 읽습니다.');return;}
   const units=player.units();let label=null,group=null;
   ui.listenNote.textContent=T('{0}문장 · 문장을 누르면 거기서부터 읽습니다.',units.length);
   units.forEach((u,i)=>{
    const name=u.kind==='caption'?t('캡션'):u.kind==='reference'?t('참고문헌'):u.sectionLabel||t('본문');
    if(name!==label||!group){label=name;const h=el(doc,'h4',{'class':'sc-ra-h'},ui.transcript);h.textContent=name;group=el(doc,'div',{'class':'sc-ra-group'},ui.transcript);}
    const b=el(doc,'button',{type:'button','class':'sc-ra-sentence','data-opens':'audio','data-index':i},group);
    b.textContent=u.text;b.addEventListener('click',()=>{player.play(i);});
   });
   markCurrent(session);setBadge(session,'listen',units.length);
  }
  function markCurrent(session){
   const list=session.ui.transcript;if(!list||!session.player)return;
   const state=session.player.state();
   const prev=list.querySelector('[aria-current="true"]');if(prev)prev.removeAttribute('aria-current');
   const now=list.querySelector('[data-index="'+state.index+'"]');
   if(now&&state.status!=='idle'){now.setAttribute('aria-current','true');if(session.tab==='listen'&&now.scrollIntoView)try{now.scrollIntoView({block:'nearest'});}catch(_){}}
  }

  /* ---- the player ------------------------------------------------------- */
  function setBadge(session,tab,count){
   const b=session.ui.tabs[tab].badge;if(!b)return;
   b.textContent=String(count);b.hidden=!count;
  }
  function spawnSay(args,onexit){
   const C=root.Components||globalThis.Components;
   const file=C.classes['@mozilla.org/file/local;1'].createInstance(C.interfaces.nsIFile);file.initWithPath('/usr/bin/say');
   const proc=C.classes['@mozilla.org/process/util;1'].createInstance(C.interfaces.nsIProcess);proc.init(file);
   proc.runwAsync(args,args.length,{observe(subject,topic){let status=-1;try{if(topic==='process-finished')status=proc.exitValue;}catch(_){}onexit(status);}});
   return {kill(){try{proc.kill();}catch(_){}}};
  }
  async function pickEngine(session){
   const win=session.reader._iframeWindow||session.doc.defaultView;
   const speech=RA.speechEngine(win);
   if(speech.available())return speech;
   // Voices load late in Gecko: give them a moment, as the reader's own read-aloud does.
   try{
    if(win.speechSynthesis&&win.speechSynthesis.addEventListener)await new Promise(resolve=>{const done=()=>resolve();win.speechSynthesis.addEventListener('voiceschanged',done,{once:true});win.setTimeout(done,1500);});
   }catch(_){}
   if(speech.available())return speech;
   const mac=Z.isMac||/Mac/i.test(String(win.navigator&&win.navigator.platform||''));
   if(mac&&typeof io()?.exists==='function'&&await io().exists('/usr/bin/say').catch(()=>false))return RA.sayEngine({spawn:spawnSay});
   throw new Error('이 컴퓨터에서 쓸 수 있는 음성이 없습니다. 시스템 설정 → 접근성 → 음성 콘텐츠에서 음성을 내려받으세요.');
  }
  async function ensurePlayer(session){
   if(session.player)return session.player;
   if(session.playerPromise)return session.playerPromise;
   session.playerPromise=(async()=>{
    const {structured}=await structure(session);
    const engine=await pickEngine(session);
    const filters=session.filters||{captions:false,references:false};
    // Everything is composed once; the player's own switches decide what is read.
    const units=RA.composeUnits(structured,{captions:true,references:true},tools(session));
    if(!units.length)throw new Error('읽을 본문이 없습니다. 아래 ‘왜 건너뛰었나’를 열어 보세요.');
    const lang=RA.detectLanguage(units.slice(0,60).map(u=>u.text).join(' '));
    const voices=engine.voices();
    const saved=String(setting('readAloudVoice','')||'');
    const savedVoice=voices.find(v=>v.voiceURI===saved);
    const voice=RA.pickVoice(voices,lang,savedVoice&&String(savedVoice.lang||'').toLowerCase().startsWith(lang)?saved:'');
    const player=RA.create({engine,lang:voice&&voice.lang||lang,voiceURI:voice?voice.voiceURI:'',rate:Number(setting('readAloudSpeed',100))/100,filters,
     onChange:event=>onPlayerEvent(session,event),onCredit:(unit,seconds)=>credit(session,unit,seconds)});
    const resume=session.data.position&&session.data.position.sig?session.data.position:null;
    player.load(units,{resume:null});
    session.player=player;session.engine=engine;session.langCode=lang;session.resumePosition=resume;
    fillVoices(session,voices,lang,voice);
    renderTranscript(session);renderPlayer(session);
    return player;
   })();
   try{return await session.playerPromise;}finally{session.playerPromise=null;}
  }
  function fillVoices(session,voices,lang,current){
   const same=voices.filter(v=>String(v.lang||'').toLowerCase().startsWith(lang));
   const items=[{value:'',label:t('자동')},...(same.length?same:voices).slice(0,60).map(v=>({value:v.voiceURI,label:v.name+(v.lang?' · '+v.lang:'')}))];
   session.ui.voice.set({items,current:setting('readAloudVoice','')&&items.some(i=>i.value===setting('readAloudVoice',''))?setting('readAloudVoice',''):'',label:current?current.name:t('목소리')});
  }
  async function withPlayer(session,fn){const p=await ensurePlayer(session);fn(p);}
  async function togglePlay(session){
   const p=await ensurePlayer(session),status=p.state().status;
   // From the top of the page being read when nothing is playing; "이어서 듣기" is the way back to the saved sentence.
   if(status==='idle'||status==='done'||status==='error')p.play(startIndexForPage(session,p));else p.toggle();
  }
  function startIndexForPage(session,player){
   const page=currentPage(session.reader);
   if(!page)return 0;
   const at=player.units().findIndex(u=>pageNumberOf(u)>=page);
   return at>=0?at:0;
  }
  async function resumeListening(session){
   const p=await ensurePlayer(session),pos=session.data.position;
   let index=pos&&pos.sig?p.units().findIndex(u=>RA.signature(u)===pos.sig):-1;
   if(index<0&&pos&&Number.isInteger(pos.index)&&pos.index<p.units().length)index=pos.index;
   p.play(Math.max(0,index));
  }
  function setRate(session,rate){
   setSettingQuiet('readAloudSpeed',Math.round(rate*100));
   if(session.player)session.player.setRate(rate);
   session.ui.rateText.textContent=rate.toFixed(1)+'×';
  }
  function setVoice(session,uri){
   setSettingQuiet('readAloudVoice',uri);
   const p=session.player;if(!p)return;
   const v=(session.engine.voices()||[]).find(x=>x.voiceURI===uri);
   p.setVoice(uri,v?v.lang:session.langCode);
   session.ui.voice.set({current:uri,label:v?v.name:t('목소리')});
  }
  function setSettingQuiet(key,value){try{Promise.resolve(runtime.setSetting(key,value,{apply:false})).catch(log);}catch(error){log(error);}}
  function setFilter(session,id){
   session.filters={captions:id!=='body',references:id==='references'};
   const p=session.player;
   if(p){
    const wasPlaying=p.state().status==='playing';
    p.setFilters(session.filters);       // keeps the position on the same sentence, restarts it if it was playing
    renderTranscript(session);
    if(!wasPlaying)markCurrent(session);
   }
   renderPlayer(session);
  }
  function onPlayerEvent(session,{type,state}){
   if(session.destroyed)return;
   renderPlayer(session);
   if(type==='sentence'||type==='status'&&state.status==='playing'){
    if(state.unit)markCurrent(session);
    if(type==='sentence'){
     if(state.unit)highlight(session,state.unit);session.data.position={index:state.index,sig:RA.signature(state.unit),page:pageNumberOf(state.unit),at:Date.now()};saveSoon(session);}
   }
   if(state.status==='idle'||state.status==='done')clearHighlight(session);
   if(state.status==='error')say(session,state.error==='no-audio'?t('소리가 나지 않습니다. 시스템 음성 설정을 확인하세요.'):T('읽기를 멈췄습니다: {0}',state.error),true);
  }
  function renderPlayer(session){
   const ui=session.ui,p=session.player,state=p?p.state():null,playing=state&&state.status==='playing';
   const playBtn=ui.play;
   playBtn.replaceChildren(icon(session.doc,playing?'pause':'play'));
   const label=playing?t('일시정지'):state&&state.status==='paused'?t('이어 읽기'):t('읽어주기');
   playBtn.setAttribute('aria-label',label);playBtn.title=label;
   const has=!!state&&state.total>0;
   for(const b of [ui.prev,ui.next,ui.sectionPrev,ui.sectionNext])b.disabled=!has;
   if(state&&state.unit){
    const where=state.unit.kind==='caption'?t('캡션'):state.unit.kind==='reference'?t('참고문헌'):state.unit.sectionLabel;
    ui.progress.textContent=T('문장 {0}/{1}',state.index+1,state.total)+(where?' · '+where:'');
   }else ui.progress.textContent=has?'':t('아직 시작하지 않았습니다');
   const pos=session.data&&session.data.position;
   const idle=!state||state.status==='idle';
   ui.resume.hidden=!(pos&&pos.sig&&idle);
   if(!ui.resume.hidden){const text=ui.resume.querySelector('.sc-ra-btn-text');if(text)text.textContent=pos.page?T('이어서 듣기 · p. {0}',pos.page):t('이어서 듣기');}
   for(const[name,b]of Object.entries(ui.filters)){const f_=session.filters||{captions:false,references:false};b.setAttribute('aria-pressed',String(name==='body'?!f_.captions:name==='captions'?f_.captions&&!f_.references:f_.references));}
  }

  /* -- following along in the PDF -- */
  function clearHighlight(session){
   for(const n of session.marks||[]){try{n.remove();}catch(_){}}session.marks=[];session.markedPage=null;
  }
  function highlight(session,unit){
   if(uiState().follow===false)return;
   clearHighlight(session);
   const page=pageNumberOf(unit);if(!page)return;
   const size=session.pageSizes&&session.pageSizes[page-1];
   if(size&&size.width>0&&size.height>0&&Array.isArray(unit.rects)&&unit.rects.length){
    const doc=viewerDoc(session.reader),pageEl=doc&&doc.querySelector('.page[data-page-number="'+page+'"]');
    if(pageEl){
     const W=size.width,H=size.height;
     for(const r of unit.rects.slice(0,12)){
      if(!Array.isArray(r)||r.length<4)continue;
      const mark=doc.createElementNS(HTML,'div');mark.setAttribute('data-sc-ra-hl','1');
      // Percentages of the page, so the box follows every zoom level.
      mark.style.cssText=`position:absolute;left:${r[0]/W*100}%;top:${r[1]/H*100}%;width:${r[2]/W*100}%;height:${r[3]/H*100}%;background:rgba(255,212,0,0.32);border-radius:3px;box-shadow:0 0 0 1px rgba(204,146,0,0.55);pointer-events:none;z-index:6;`;
      pageEl.appendChild(mark);session.marks.push(mark);
     }
    }
    session.markedPage=page;
   }
   // Scroll only when the sentence is not on screen, or is on another page.
   const shown=currentPage(session.reader);
   let visible=false;
   try{
    const first=session.marks[0],win=viewerDoc(session.reader)?.defaultView;
    if(first&&win&&first.getBoundingClientRect){const r=first.getBoundingClientRect();visible=r.top>=48&&r.bottom<=win.innerHeight-48&&r.height>0;}
   }catch(_){}
   if(!visible||shown!==page)goToPage(session,page,unit.rects);
  }
  function credit(session,unit,seconds){
   if(session.destroyed||setting('readAloudCredit',true)===false||!(seconds>0))return;
   // The reading clock already counts a person who is touching the reader; this counts only the listening in between.
   if(Date.now()-(session.lastActivity||0)<4000)return;
   const reader=session.reader,item=itemOf(reader);if(!item||typeof runtime.addReading!=='function')return;
   const page=pageNumberOf(unit),total=pageCount(reader);
   if(!page||!total||page>total)return;
   const location={attachmentID:reader.itemID,pageIndex:page-1,totalPages:total};
   Promise.resolve(runtime.addReading(item,seconds,location,location)).catch(log);
  }
  function onDoubleClick(session,event){
   if(!session.open)return;
   try{
    const target=event.target,pageEl=target&&target.closest&&target.closest('.page[data-page-number]');if(!pageEl||!pageEl.getBoundingClientRect)return;
    const page=Number(pageEl.getAttribute('data-page-number')),rect=pageEl.getBoundingClientRect();
    if(!(rect.width>0&&rect.height>0))return;
    const fx=(event.clientX-rect.left)/rect.width,fy=(event.clientY-rect.top)/rect.height;
    // The text may not have been read yet: the first double-click waits for it, then starts there.
    structure(session).then(()=>{
     const size=session.pageSizes&&session.pageSizes[page-1];if(!size||!(size.width>0))return null;
     return ensurePlayer(session).then(p=>{const at=p.indexNear(page-1,fx*size.width,fy*size.height);if(at>=0)p.play(at);});
    }).catch(error=>say(session,describe(error),true));
   }catch(error){log(error);}
  }

  /* ---- open, close, tabs ---------------------------------------------------- */
  function applyLayout(session,open){
   const doc=session.doc,split=doc.querySelector&&doc.querySelector('#split-view');
   if(split&&split.style){if(open)split.style.setProperty('inset-inline-end',WIDTH+'px');else split.style.removeProperty('inset-inline-end');}
   session.ui.root.hidden=!open;
  }
  function setOpen(session,open,{remember=true}={}){
   session.open=!!open;applyLayout(session,session.open);
   if(session.toolbarState)session.toolbarState.panel.setAttribute('aria-pressed',String(session.open));
   if(remember){uiState().open=session.open;persistUI();}
   if(session.open){showTab(session,session.tab||uiState().tab||'ask');ensureReady(session);}
  }
  function showTab(session,id){
   session.tab=id;if(remember(id)){uiState().tab=id;persistUI();}
   for(const[name,pane]of Object.entries(session.ui.panes))pane.hidden=name!==id;
   for(const[name,t_]of Object.entries(session.ui.tabs))t_.button.setAttribute('aria-selected',String(name===id));
   if(id==='translate')prepareTranslate(session);
   if(id==='listen')markCurrent(session);
  }
  const remember=id=>['ask','translate','listen'].includes(id);
  async function ensureReady(session){
   if(session.ready||session.destroyed)return;
   session.ready=true;
   try{
    await loadData(session);
    session.loaded=true;
    renderSummary(session);renderChat(session);renderPlayer(session);renderTranscript(session);
    // Translations already made for this paper are shown without asking for anything.
    if(session.tab==='translate')prepareTranslate(session);
    const pos=session.data.position;if(pos&&pos.sig)renderPlayer(session);
   }catch(error){log(error);}
  }

  /* ---- sessions per reader ------------------------------------------------- */
  function createSession(reader){
   const doc=reader._iframeWindow&&reader._iframeWindow.document;if(!doc||!doc.documentElement)return null;
   const attachment=attachmentOf(reader);if(!attachment)return null;
   const session={reader,doc,id:++sequence,name:attachment.libraryID+'-'+attachment.key,menus:new Set(),filters:{captions:false,references:false},tab:uiState().tab||'ask',open:false,destroyed:false,marks:[],data:{v:1,summary:{},chat:[],tr:{}},ready:false};
   buildPanel(session);
   (doc.body||doc.documentElement).appendChild(session.ui.root);
   stylesheet().then(css=>{if(session.destroyed||!css)return;const style=doc.createElementNS(HTML,'style');style.setAttribute('data-sc-ra-style','1');style.textContent=css;(doc.head||doc.documentElement).appendChild(style);session.style=style;});
   // Let the panel know the reader's pointer activity, so listening is credited only when the person is not already being counted.
   session.onActivity=()=>{session.lastActivity=Date.now();};
   for(const name of ['pointermove','pointerdown','keydown','wheel'])doc.addEventListener(name,session.onActivity,{capture:true,passive:true});
   const vdoc=viewerDoc(reader);if(vdoc){session.onDbl=event=>onDoubleClick(session,event);vdoc.addEventListener('dblclick',session.onDbl,true);session.vdoc=vdoc;
    for(const name of ['pointermove','pointerdown','keydown','wheel'])vdoc.addEventListener(name,session.onActivity,{capture:true,passive:true});}
   session.say=(m,e)=>say(session,m,e);
   sessions.set(reader,session);
   ensureReady(session).then(()=>{
    const want=uiState().open===true||(uiState().open===undefined&&setting('aiSummaryOnOpen',false)===true);
    if(want)setOpen(session,true,{remember:false});
   });
   return session;
  }
  function destroySession(session){
   if(session.destroyed)return;
   session.destroyed=true;sessions.delete(session.reader);
   try{session.player&&session.player.destroy();}catch(_){}
   try{session.tr&&session.tr.service.cancel();}catch(_){}
   try{saveNow(session);}catch(_){}
   clearHighlight(session);
   try{applyLayout(session,false);}catch(_){}
   try{session.ui.root.remove();}catch(_){}try{session.style&&session.style.remove();}catch(_){}
   try{session.doc.removeEventListener('click',session.onDocClick);session.doc.removeEventListener('keydown',session.onKey);for(const name of ['pointermove','pointerdown','keydown','wheel'])session.doc.removeEventListener(name,session.onActivity,true);}catch(_){}
   try{if(session.vdoc){session.vdoc.removeEventListener('dblclick',session.onDbl,true);for(const name of ['pointermove','pointerdown','keydown','wheel'])session.vdoc.removeEventListener(name,session.onActivity,true);}}catch(_){}
   try{if(session.saveTimer)session.doc.defaultView.clearTimeout(session.saveTimer);if(session.sayTimer)session.doc.defaultView.clearTimeout(session.sayTimer);}catch(_){}
   try{session.toolbarState=null;}catch(_){}
  }
  /* Called by reader-tools every second with the PDF readers of one window and the selected tab. */
  function sync(win,readers,selectedTabID){
   if(stopped)return;
   const live=new Set(readers.filter(r=>r.type==='pdf'));
   for(const[reader,session]of [...sessions])if(reader._window===win&&!live.has(reader))destroySession(session);
   for(const reader of live){
    let session=sessions.get(reader);
    const doc=reader._iframeWindow&&reader._iframeWindow.document;
    if(session&&(session.doc!==doc||!session.ui.root.isConnected)){destroySession(session);session=null;}
    if(!session)session=createSession(reader);
    if(!session)continue;
    const shown=!selectedTabID||!reader.tabID||reader.tabID===selectedTabID;
    if(shown&&!session.autoChecked&&session.loaded){
      session.autoChecked=true;
      // The one thing that runs by itself, and only because the reader asked for it in the settings.
      if(setting('aiSummaryOnOpen',false)===true&&!summaryEntry(session)&&!session.data.autoSummary&&runtime.assist?.available?.()){
       session.data.autoSummary=true;saveSoon(session);runSummary(session,{auto:true});
      }
    }
   }
  }
  /* The two toolbar buttons: read aloud, and the panel. */
  function mountToolbar({reader,doc,container}){
   if(stopped)return null;
   const state={};
   const panel=el(doc,'button',{type:'button','class':'toolbar-button sc-ra-toolbar','data-safe':'view',title:t('논문 도우미 (요약·대화·번역)'),'aria-label':t('논문 도우미 (요약·대화·번역)'),'aria-pressed':'false'},container);
   panel.appendChild(icon(doc,'panel'));
   const listen=el(doc,'button',{type:'button','class':'toolbar-button sc-ra-toolbar','data-opens':'audio',title:t('읽어주기'),'aria-label':t('읽어주기')},container);
   listen.appendChild(icon(doc,'play'));
   state.panel=panel;state.listen=listen;
   const sessionOf=()=>sessions.get(reader)||createSession(reader);
   panel.addEventListener('click',()=>{const s=sessionOf();if(!s)return;s.toolbarState=state;setOpen(s,!s.open);});
   listen.addEventListener('click',async()=>{
    const s=sessionOf();if(!s)return;s.toolbarState=state;
    try{if(!s.open)setOpen(s,true);showTab(s,'listen');await togglePlay(s);}catch(error){log(error);say(s,describe(error),true);}
   });
   const s=sessions.get(reader);if(s){s.toolbarState=state;panel.setAttribute('aria-pressed',String(!!s.open));}
   return {remove(){panel.remove();listen.remove();const cur=sessions.get(reader);if(cur&&cur.toolbarState===state)cur.toolbarState=null;}};
  }
  function releaseWindow(win){for(const[reader,session]of [...sessions])if(reader._window===win)destroySession(session);}

  /* ---- the self-check probe: measure, press nothing --------------------- */
  const rgb=value=>{const m=/rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?\)/.exec(String(value||''));return m?[Number(m[1]),Number(m[2]),Number(m[3]),m[4]===undefined?1:Number(m[4])]:null;};
  const luminance=([r,g,b])=>{const c=[r,g,b].map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);});return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2];};
  const contrastOf=(a,b)=>{const l1=luminance(a),l2=luminance(b);return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);};
  function backdrop(win,node){
   // The colour behind text: composite translucent layers up to the first opaque one.
   const layers=[];for(let n=node;n&&n.nodeType===1;n=n.parentElement){const c=rgb(win.getComputedStyle(n).backgroundColor);if(c&&c[3]>0){layers.push(c);if(c[3]>=1)break;}}
   let base=[255,255,255];if(!layers.length||layers[layers.length-1][3]<1){const scheme=win.getComputedStyle(node).colorScheme||'';base=/dark/.test(scheme)&&!/light/.test(scheme)?[30,30,30]:[255,255,255];}
   for(const c of layers.reverse())base=[0,1,2].map(i=>c[i]*c[3]+base[i]*(1-c[3]));
   return base;
  }
  /* Measure the panel on one reader without clicking anything: open it, visit each tab, read sizes, colours and overflow, put it back. */
  async function probe(reader){
   const result={reader:reader.itemID,problems:[],checked:0,tabs:{}};
   const session=sessions.get(reader)||createSession(reader);if(!session){result.problems.push('no panel could be mounted');return result;}
   const win=session.doc.defaultView,wasOpen=session.open,wasTab=session.tab;
   await ensureReady(session);
   try{
    setOpen(session,true,{remember:false});
    const unmarked=unmarkedButtons(session.ui.root);if(unmarked.length)result.problems.push('buttons without data-safe/data-opens/data-writes: '+unmarked.map(b=>clean(b.textContent||b.getAttribute('aria-label'))).join(' | '));
    for(const id of ['ask','translate','listen']){
     session.tab=id;for(const[name,pane]of Object.entries(session.ui.panes))pane.hidden=name!==id;
     if(id==='translate')renderTranslate(session);
     await sleepIn(win,30);
     const rootRect=session.ui.root.getBoundingClientRect?session.ui.root.getBoundingClientRect():null;
     const found=[];
     const all=[session.ui.root,...session.ui.root.querySelectorAll('*')];
     for(const node of all){
      if(node.hidden||node.closest('[hidden]'))continue;
      const style=win.getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden')continue;
      const own=[...node.childNodes].some(n=>n.nodeType===3&&clean(n.textContent));
      result.checked++;
      if(own){
       const size=parseFloat(style.fontSize);if(size&&size<11)found.push(`${node.tagName.toLowerCase()}.${node.className||''}: ${size}px text under 11px`);
       const fg=rgb(style.color),bg=backdrop(win,node);
       if(fg){const eff=fg[3]<1?[0,1,2].map(i=>fg[i]*fg[3]+bg[i]*(1-fg[3])):fg;const ratio=contrastOf(eff,bg);if(ratio<4.5)found.push(`${node.tagName.toLowerCase()}.${node.className||''} "${clean(node.textContent).slice(0,24)}": contrast ${ratio.toFixed(2)}:1`);}
      }
      if(rootRect&&node!==session.ui.root&&node.getBoundingClientRect){
       const r=node.getBoundingClientRect();
       if(r.width>0&&r.right>rootRect.right+1&&!node.closest('.sc-ra-menu'))found.push(`${node.tagName.toLowerCase()}.${node.className||''} pokes out ${Math.round(r.right-rootRect.right)}px to the right`);
      }
      if(node.tagName==='BUTTON'&&node.getBoundingClientRect){const r=node.getBoundingClientRect();if(r.width>0&&(r.height<22||r.width<22))found.push(`button "${clean(node.textContent||node.getAttribute('aria-label')).slice(0,20)}" is ${Math.round(r.width)}x${Math.round(r.height)}px`);}
      if(style.overflowX==='hidden'&&node.scrollWidth>node.clientWidth+1&&node.clientWidth>0&&!/sc-ra-(sentence|row-meta|pill-text|progress)/.test(node.className||''))found.push(`${node.tagName.toLowerCase()}.${node.className||''} clips its text (${node.scrollWidth}>${node.clientWidth})`);
     }
     result.tabs[id]=found.length;result.problems.push(...found.map(x=>id+': '+x));
    }
    result.player=session.player?session.player.state().status:'idle';
    if(result.player==='playing')result.problems.push('the probe started audio');
   }finally{
    session.tab=wasTab;setOpen(session,wasOpen,{remember:false});if(wasOpen)showTab(session,wasTab);
   }
   return result;
  }
  async function probeAll(){
   const out=[];
   for(const reader of Z.Reader?._readers||[]){
    if(reader.type!=='pdf'||!reader._internalReader||!reader._iframeWindow||reader._iframeWindow.closed)continue;
    out.push(await probe(reader));
   }
   return out;
  }
  function stop(){
   if(stopped)return;stopped=true;
   for(const session of [...sessions.values()])destroySession(session);
   sessions.clear();
  }
  return Object.freeze({sync,mountToolbar,releaseWindow,probe,probeAll,stop,sessions:()=>[...sessions.values()],owner});
 }
 return Object.freeze({create,renderMarkdown,unmarkedButtons,pressable,icon,ICONS,WIDTH});
});

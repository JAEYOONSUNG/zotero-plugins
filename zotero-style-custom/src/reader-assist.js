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
 const WIDTH=372,MIN_WIDTH=280,RAIL_WIDTH=52,TOP=41,MAX_CHAT=200,CHAT_LIMIT=4000;
 // The PDF keeps at least this much of the reader's split area; below it the panel narrows, then folds to the rail.
 const MIN_PDF=360;
 // The panel's text buttons are pills; the button added to the reader's selection popup has the same corners.
 const BUTTON_RADIUS='999px';
 // The cached structure's own version: v2 is the extraction that reads the viewport itself (v1 often fell back to plain text).
 const STRUCT_VERSION=2,CACHE_PAPERS=200,CACHE_BYTES=100*1024*1024,STATE_PAPERS=5000,STATE_BYTES=300*1024*1024;
 const need=(name,file)=>root[name]||(typeof require==='function'?require(file):null);
 const clean=text=>String(text==null?'':text).replace(/\s+/g,' ').trim();
 // The extraction module (and the plain-text fallback) number pages from 0 and give rectangles as [x, y, w, h] from the top left of the page at scale 1.
 const PAGES_ARE_INDEXES=true;
 const PAGE_BASE=PAGES_ARE_INDEXES?1:0;
 const pageNumberOf=unit=>{const n=Number(unit&&unit.page);return Number.isFinite(n)?n+PAGE_BASE:null;};

 /* ---- talking to pdf.js in the reader's content compartment --------------
    pdf.js runs as content code; an object made here (chrome) cannot be read by it,
    so pdf.js destructuring {scale} from a chrome literal threw and every paper fell
    back to plain text. Nothing made here is handed to pdf.js any more except
    through toContent() (Cu.cloneInto, as Zotero's own reader code does), and the
    viewport is computed here from page.view and page.rotate instead of asking. */
 function toContent(value,win){
  const C=root.Components||globalThis.Components;
  try{if(C&&C.utils&&typeof C.utils.cloneInto==='function'&&win)return C.utils.cloneInto(value,win,{cloneFunctions:true});}catch(_){}
  return value;
 }
 /* What chrome code gets back from pdf.js is an Xray: a promise from content resolves, on the chrome side, to an
    Xray wrapper that shows none of pdf.js's own methods or fields (page.getTextContent was "not a function" in
    Zotero 9.0.6). Zotero's own reader code reaches content with .wrappedJSObject; Cu.waiveXrays does the same for
    any value. Everything read through a waived object is copied into plain chrome values before it is used. */
 function waive(value){
  if(value===null||value===undefined||(typeof value!=='object'&&typeof value!=='function'))return value;
  const C=root.Components||globalThis.Components;
  try{if(C&&C.utils&&typeof C.utils.waiveXrays==='function')return C.utils.waiveXrays(value);}catch(_){}
  try{return value.wrappedJSObject||value;}catch(_){return value;}
 }
 function contentFunction(fn,win){
  const C=root.Components||globalThis.Components;
  try{if(C&&C.utils&&typeof C.utils.exportFunction==='function'&&win)return C.utils.exportFunction(fn,win);}catch(_){}
  return fn;
 }
 /* pdf.js PageViewport at a scale, as numbers: the same matrix pdf.js builds (see PageViewport in pdf.mjs). */
 function viewportFor(view,rotate=0,{scale=1,userUnit=1}={}){
  const box=Array.from(view||[0,0,612,792]).map(Number),k=scale*(Number(userUnit)||1);
  const cx=(box[2]+box[0])/2,cy=(box[3]+box[1])/2;
  let r=((Number(rotate)||0)%360+360)%360;
  const [a,b,c,d]=r===90?[0,1,1,0]:r===180?[-1,0,0,1]:r===270?[0,-1,-1,0]:[1,0,0,-1];
  let ox,oy,width,height;
  if(a===0){ox=Math.abs(cy-box[1])*k;oy=Math.abs(cx-box[0])*k;width=(box[3]-box[1])*k;height=(box[2]-box[0])*k;}
  else{ox=Math.abs(cx-box[0])*k;oy=Math.abs(cy-box[1])*k;width=(box[2]-box[0])*k;height=(box[3]-box[1])*k;}
  return {width,height,rotation:r,scale,transform:[a*k,b*k,c*k,d*k,ox-a*k*cx-c*k*cy,oy-b*k*cx-d*k*cy]};
 }
 /* Rectangles from the extraction ([x, y, w, h], top left, scale 1, the page's own rotation) as boxes in percent
    of a live viewport (any zoom, any rotation the reader applies): back to PDF user space, then forward. */
 function overlayBoxes(rects,size,viewport){
  if(!size||!Array.isArray(size.transform)||!Array.isArray(rects))return [];
  const [a,b,c,d,e,f]=size.transform,det=a*d-b*c;if(!det)return [];
  const back=(vx,vy)=>[(d*(vx-e)-c*(vy-f))/det,(-b*(vx-e)+a*(vy-f))/det];
  const v=viewport&&Array.isArray(viewport.transform)&&viewport.width>0&&viewport.height>0?viewport:{transform:size.transform,width:size.width,height:size.height};
  const [A,B,C,D,E,F]=v.transform;
  const fwd=([x,y])=>[A*x+C*y+E,B*x+D*y+F];
  return rects.filter(r=>Array.isArray(r)&&r.length>=4).map(([x,y,w,h])=>{
   const pts=[[x,y],[x+w,y],[x,y+h],[x+w,y+h]].map(([px,py])=>fwd(back(px,py)));
   const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);
   const L=Math.min(...xs),T=Math.min(...ys),R=Math.max(...xs),Bm=Math.max(...ys);
   return {left:L/v.width*100,top:T/v.height*100,width:(R-L)/v.width*100,height:(Bm-T)/v.height*100};
  });
 }

 /* A point on the page element (fractions of its box) in the extraction's page space: the page element shows the
    live viewport (the reader's zoom and its own rotation), so the point goes back through that viewport to PDF user
    space and forward through the extraction's viewport. Without a live viewport the page is taken as unturned. */
 function pointToPage(fx,fy,live,size){
  if(!size||!(size.width>0))return null;
  const ok=v=>v&&Array.isArray(v.transform)&&v.transform.length>=6&&v.width>0&&v.height>0;
  if(!ok(live)||!Array.isArray(size.transform))return [fx*size.width,fy*size.height];
  const [a,b,c,d,e,f]=live.transform.map(Number),det=a*d-b*c;if(!det)return [fx*size.width,fy*size.height];
  const vx=fx*live.width,vy=fy*live.height;
  const ux=(d*(vx-e)-c*(vy-f))/det,uy=(-b*(vx-e)+a*(vy-f))/det;
  const [A,B,C,D,E,F]=size.transform.map(Number);
  return [A*ux+C*uy+E,B*ux+D*uy+F];
 }

 /* ---- small DOM helpers ------------------------------------------------- */
 const ICONS={
  play:['M8 5.5v13l10-6.5z'],pause:['M9 6v12','M15 6v12'],prev:['M15 6l-6 6 6 6'],next:['M9 6l6 6-6 6'],
  sectionPrev:['M12 6l-6 6 6 6','M19 6l-6 6 6 6'],sectionNext:['M5 6l6 6-6 6','M12 6l6 6-6 6'],
  close:['M6 6l12 12','M18 6L6 18'],copy:['M9 9h11v11H9z','M5 15V5h10'],note:['M6 4h9l3 3v13H6z','M9 12h6','M9 16h6'],
  refresh:['M20 12a8 8 0 1 1-2.3-5.6','M20 4v5h-5'],send:['M4 12l16-8-6 16-3-7z'],stop:['M7 7h10v10H7z'],trash:['M5 7h14','M10 7V5h4v2','M7 7l1 12h8l1-12'],
  headphones:['M4 14v-2a8 8 0 0 1 16 0v2','M4 14h3v5H5a1 1 0 0 1-1-1z','M20 14h-3v5h2a1 1 0 0 0 1-1z'],
  translate:['M4 6h9','M8.5 4v2','M6 6c0 4 3 7 6 8','M12 6c-1 4-4 7-7 8','M13 20l4-9 4 9','M14.5 17h5'],
  message:['M5 5h14v10H10l-4 4v-4H5z'],list:['M5 7h14','M5 12h14','M5 17h9'],caret:['M7 10l5 5 5-5'],panel:['M4 5h16v14H4z','M15 5v14'],
  collapse:['M13 6l6 6-6 6','M6 6l6 6-6 6'],expand:['M11 6l-6 6 6 6','M18 6l-6 6 6 6'],
  noteAdd:['M6 3h8l4 4v14H6z','M14 3v4h4','M12 11v6','M9 14h6']
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

 /* Keys for our player: Option(Alt)+Shift with K (play/pause; Space too), J (previous sentence) and L (next), the
    layout video players use. Zotero has no binding there (reader.js KeyboardManager takes R/L, H, S, digits, and
    Space and Alt(+Shift)+←/→ while its own Read Aloud runs; zoteroPane.js takes Cmd/Ctrl chords and Cmd+Option+←/→;
    its configurable keys are Cmd/Ctrl+Shift+letter). Matched by event.code, since Option changes event.key on a Mac.
    Never in a text box or a form control, and never while an input method is composing. */
 function shortcutOf(event){
  if(!event||event.repeat||event.isComposing||!event.altKey||!event.shiftKey||event.ctrlKey||event.metaKey)return null;
  const target=event.target;let tag='',editable=false;
  try{tag=String(target&&target.nodeName||'').toUpperCase();editable=!!(target&&typeof target.getAttribute==='function'&&target.getAttribute('contenteditable')==='true');}catch(_){}
  if(editable||/^(INPUT|TEXTAREA|SELECT)$/.test(tag))return null;
  return {KeyK:'toggle',Space:'toggle',KeyJ:'prev',KeyL:'next'}[String(event.code||'')]||null;
 }
 const KEY_HINTS={mac:{toggle:'⌥⇧K',prev:'⌥⇧J',next:'⌥⇧L'},other:{toggle:'Alt+Shift+K',prev:'Alt+Shift+J',next:'Alt+Shift+L'}};

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
  // A message this plugin wrote for its reader is shown as written; only transport errors go through the generic wording (whose 429 means a daily quota).
  const describe=error=>{if(error&&error.own)return t(String(error.message));const fail=root.CustomStyleFailures;return t(fail?fail.describe(error):String(error&&error.message||error));};
  const paperText=()=>root.StyleCustomPaperText||RA.fallbackPaperText;
  const sessions=new Map();let stopped=false,cssPromise=null,sequence=0,probing=0,guard=null;
  // Readers a live self-check opened for itself: sync() leaves them alone, so no ordinary session (one that may save) is made.
  const reserved=new WeakSet();
  const setting=(key,fallback)=>{try{const v=runtime.getSetting(key);return v===undefined||v===null?fallback:v;}catch(_){return fallback;}};
  /* The answer language: "auto" (the default) follows the panel's own language, so an English panel gets English
     summaries; a person who chose Korean or English keeps it. */
  const language=()=>{const v=setting('aiLanguage','auto');if(v&&v!=='auto')return v;try{return runtime.i18n&&typeof runtime.i18n.isKorean==='function'&&runtime.i18n.isKorean()?'Korean':'English';}catch(_){return 'English';}};
  /* A wait that the job's Stop ends at once. The work behind it (the paper's text, which other features share)
     goes on; only this job stops waiting for it. */
  const cancelledError=()=>Object.assign(new Error('중지했습니다.'),{code:'cancelled',own:true});
  const untilCancelled=(promise,tok)=>new Promise((resolve,reject)=>{
   if(tok&&tok.cancelled){reject(cancelledError());return;}
   const off=tok?tok.onCancel(()=>reject(cancelledError())):()=>{};
   Promise.resolve(promise).then(v=>{off();resolve(v);},e=>{off();reject(e);});
  });
  const isCancel=(error,tok)=>!!(tok&&tok.cancelled)||!!(error&&error.code==='cancelled');
  /* What an AI result was made with: model, language, server and prompt revision. Taken in the same tick as the
     request starts (assist.js resolves its own config synchronously then), and filed under it on completion. */
  const endpointTag=()=>{const e=String(runtime.pref('aiEndpoint','')||'').trim();return e?TR.hash(e).slice(0,8):'bridge';};
  const aiSettings=()=>({model:String(runtime.pref('aiModel','')).trim(),language:language(),endpoint:endpointTag(),rev:String(PC.PROMPT_REVISION||'1')});
  const summaryKeyOf=a=>[a.model,a.language,a.endpoint,a.rev].join('|');
  /* Which account of the local bridge answered (it says so in a header, assist.js keeps it): 'claude', 'codex' when
     Claude could not (its limit, or an error) and ChatGPT stood in, or null for an address in the settings. */
  const answeredBy=()=>{try{const s=runtime.assist&&typeof runtime.assist.status==='function'?runtime.assist.status():null;return s&&s.source==='bridge'&&(s.provider==='claude'||s.provider==='codex')?s.provider:null;}catch(_){return null;}};
  const BRIDGE_LABEL=(need('CustomStyleAssist','./assist.js')||{}).BRIDGE_LABEL||{claude:'Claude 계정 (이 Mac)',codex:'ChatGPT 계정 (이 Mac)'};
  const byLabel=by=>by&&BRIDGE_LABEL[by]?t(BRIDGE_LABEL[by]):'';
  const FALLBACK_NOTE='Claude가 답하지 못해 ChatGPT 계정이 대신 답했습니다';
  const owner=(runtime.id||'style-custom')+'/reader-assist-'+Math.random().toString(36).slice(2);

  /* ---- the plugin's own cache folder ------------------------------------ */
  const io=()=>runtime.io||(typeof IOUtils!=='undefined'?IOUtils:null);
  const paths=()=>runtime.paths||(typeof PathUtils!=='undefined'?PathUtils:null);
  const folder=()=>paths().join(Z.DataDirectory.dir,'style-custom-reader');
  const safeName=name=>/^[\w.-]{1,80}$/.test(name)?name:null;
  const store={
   async read(name,{touch=true}={}){
    try{
     const file=safeName(name)&&paths().join(folder(),name+'.json');if(!file||!await io().exists(file))return null;
     if((await io().stat(file)).size>16*1024*1024)return null;
     const value=JSON.parse(await io().readUTF8(file));
     // A read is a use: the cache drops the least recently used papers. A self-check's read is not a use and writes nothing.
     // A live check counts every write anyone makes, including the touch of a reader the user left open.
     if(touch&&!guard)try{if(io().setModificationTime)await io().setModificationTime(file);}catch(_){}
     return value;
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
  // The reader's views: the primary one, and the second pane of a split view.
  const viewOf=(reader,which='primary')=>coreOf(reader)?.[which==='secondary'?'_secondaryView':'_primaryView'];
  const viewerWindow=(reader,which='primary')=>{const w=viewOf(reader,which)?._iframeWindow;return w?waive(w):null;};
  const viewerDoc=(reader,which='primary')=>{try{return viewOf(reader,which)?._iframeWindow?.document||null;}catch(_){return null;}};
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
  const plainContent=content=>({items:Array.from(content.items||[]).map(raw=>{const i=waive(raw);return {str:String(i.str||''),dir:i.dir==null?undefined:String(i.dir),transform:Array.from(i.transform||[]).map(Number),width:Number(i.width)||0,height:Number(i.height)||0,fontName:i.fontName==null?undefined:String(i.fontName),hasEOL:!!i.hasEOL};}),styles:JSON.parse(JSON.stringify(waive(content.styles)||{}))});
  /* A font reaches commonObjs only once pdf.js has bound it, a moment after the operator list: wait a little, then go without its name. */
  async function fontsOf(page,content,win,{waitMs=400}={}){
   const fonts={},ids=Object.keys(content.styles||{});
   const has=id=>{try{const objs=waive(page.commonObjs);return typeof objs.has==='function'?!!objs.has(id):true;}catch(_){return false;}};
   for(let waited=0;ids.some(id=>!has(id))&&waited<waitMs;waited+=25)await sleepIn(win,25);
   for(const id of ids){if(!has(id))continue;try{const font=waive(waive(page.commonObjs).get(id));if(font)fonts[id]={name:String(font.name||''),bold:!!font.bold||!!font.black,italic:!!font.italic};}catch(_){}}
   return fonts;
  }
  async function pdfDocumentOf(session,{tries=60}={}){
   const win=session.doc.defaultView;
   for(let i=0;i<tries;i++){if(session.destroyed)return null;const app=waive(viewerWindow(session.reader)?.PDFViewerApplication);if(app&&app.pdfDocument)return waive(app.pdfDocument);await sleepIn(win,250);}
   return null;
  }
  /* One page through pdf.js into the extraction module's page shape, and its size. Nothing chrome-made is passed to pdf.js. */
  async function readPage(session,pdf,number,{fonts=true,stats=null}={}){
   const win=session.doc.defaultView;
   const page=waive(await waive(pdf).getPage(number));
   const viewport=viewportFor(Array.from(page.view||[0,0,612,792]).map(Number),Number(page.rotate)||0,{userUnit:Number(page.userUnit)||1});
   const content=waive(await page.getTextContent());
   // Bold and italic come from the fonts pdf.js has loaded for the page; without them the extractor infers headings from glyph widths.
   let fontMap={};
   if(fonts)try{await page.getOperatorList();fontMap=await fontsOf(page,content,win);}catch(_){}
   // The live self-check counts how many of the page's fonts pdf.js resolved to a name.
   if(stats){const ids=Object.keys(content.styles||{});stats.fonts+=ids.length;stats.named+=ids.filter(id=>fontMap[id]&&fontMap[id].name).length;stats.pages++;}
   return {page:paperText().pageFromPdfjs(number-1,viewport,plainContent(content),{fonts:fontMap}),size:{width:viewport.width,height:viewport.height,transform:viewport.transform,rotation:viewport.rotation}};
  }
  async function extractWithPdfjs(session,progress){
   const win=session.doc.defaultView;
   const pdf=await pdfDocumentOf(session);if(!pdf)return null;
   const pages=[],sizes=[];
   for(let i=1;i<=pdf.numPages;i++){
    if(session.destroyed)return null;
    const got=await readPage(session,pdf,i,{fonts:pdf.numPages<=60});
    pages.push(got.page);sizes.push(got.size);
    progress&&progress(i,pdf.numPages);
    if(i%3===0)await sleepIn(win,0);
   }
   return {pages,sizes};
  }
  /* The fingerprint of the file the derived data was made from: size and time, and the extractor that read it. */
  const extractorVersion=()=>String(paperText().VERSION||'1')+'.'+STRUCT_VERSION;
  function fileSignature(session){
   if(!session.sigPromise)session.sigPromise=(async()=>{
    try{const attachment=attachmentOf(session.reader);const path=await attachment.getFilePathAsync();if(path){const st=await io().stat(path);return st.size+':'+(st.lastModified||st.lastModifiedMs||0);}}catch(_){}
    return '';
   })();
   return session.sigPromise;
  }
  const fingerprintOf=sig=>sig?sig+'|'+extractorVersion():'';
  async function loadStructure(session){
   const attachment=attachmentOf(session.reader),item=itemOf(session.reader);
   const meta={title:fieldOf(item,'title'),abstract:fieldOf(item,'abstractNote')};
   const sig=await fileSignature(session);
   const name=session.name+'.struct';
   const saved=await store.read(name,{touch:!session.probing});
   // A structure made from plain text is not kept once the real extractor is there to do better.
   if(saved&&sig&&saved.sig===sig&&saved.structured&&saved.v===STRUCT_VERSION&&saved.extractor===extractorVersion()&&(!saved.fallback||saved.unreadable||!root.StyleCustomPaperText)){session.pageSizes=saved.sizes||[];session.unreadable=!!saved.unreadable;return {structured:saved.structured,fallback:!!saved.fallback,unreadable:!!saved.unreadable,fromCache:true};}
   let structured=null,fallback=false,sizes=[],unreadable=false;
   const setProgress=(i,n)=>{session.extracting={i,n};session.onProgress&&session.onProgress();};
   try{
    if(root.StyleCustomPaperText){
     const got=await extractWithPdfjs(session,setProgress);
     if(got&&got.pages.length){structured=root.StyleCustomPaperText.structure({pages:got.pages,meta});sizes=got.sizes;}
     // A broken text layer (a font without a usable map): the extractor says so and leaves the sections empty.
     if(structured&&structured.stats&&structured.stats.unreadable){unreadable=true;structured=null;}
    }
   }catch(error){log(error);}
   if(session.destroyed)throw new Error('The reader was closed');
   session.extracting=null;
   if(!structured){
    // Zotero's own text index: no positions, so no highlight on the page, but the rest works.
    let text='';
    try{const full=await Z.PDFWorker.getFullText(attachment.id);text=full&&full.text||'';}catch(error){log(error);}
    if(!text)throw new Error('이 PDF에서 본문을 읽지 못했습니다. 스캔한 이미지일 수 있습니다.');
    structured=RA.fallbackPaperText.structure({text,meta});fallback=true;
    if(!structured.title)structured.title=meta.title;if(!structured.abstract)structured.abstract=meta.abstract;
   }
   session.pageSizes=unreadable?[]:sizes;session.unreadable=unreadable;
   if(sig&&!session.probing)store.write(name,{v:STRUCT_VERSION,extractor:extractorVersion(),sig,structured,sizes:session.pageSizes,fallback,unreadable,at:Date.now()});
   return {structured,fallback,unreadable,fromCache:false};
  }
  const structure=session=>session.structurePromise||(session.structurePromise=loadStructure(session).then(result=>{session.structured=result.structured;session.fallback=result.fallback;session.unreadable=!!result.unreadable;session.chunks=null;if(result.unreadable)noteUnreadable(session);return result;},error=>{session.structureError=error;session.structurePromise=null;throw error;}));
  /* "본문 읽는 중… 12/30쪽" while the first extraction runs (once per paper; later it comes from the cache). */
  const readingText=session=>{const x=session.extracting;return x&&x.n?T('본문 읽는 중… {0}/{1}쪽',x.i,x.n):'';};
  function showReading(session){
   const ui=session.ui;if(session.destroyed||!ui)return;
   const text=readingText(session);
   if(!session.player&&ui.progress&&(text||session.preparing))ui.progress.textContent=text||t('준비하는 중…');
   if(ui.trEstimate&&session.tr&&!session.tr.paragraphs.length&&text)ui.trEstimate.textContent=text;
   const loading=ui.summaryBody&&session.summaryState==='loading'&&ui.summaryBody.querySelector('.sc-ra-muted');
   if(loading)loading.textContent=t('요약하는 중…')+(text?' '+text:'');
  }
  function noteUnreadable(session){
   if(session.destroyed||!session.ui)return;
   say(session,t('이 PDF는 글자층이 깨져 본문을 구분할 수 없습니다'),true);
   if(session.ui.unreadable)session.ui.unreadable.hidden=false;
  }
  const tools=session=>session.fallback?RA.fallbackPaperText:paperText();

  /* ---- per-paper saved state -------------------------------------------- */
  /* Summary, chat and translations belong to the file they were made from: a replaced PDF starts them over (the listening position stays; it finds its sentence by text). */
  async function loadData(session){
   const [saved,sig]=await Promise.all([store.read(session.name+'.state',{touch:!session.probing}),fileSignature(session)]);
   const fp=fingerprintOf(sig);
   if(saved&&saved.v===1){
    const stale=fp&&saved.fp&&saved.fp!==fp;
    Object.assign(session.data,saved);
    if(stale){session.data.summary={};session.data.chat=[];session.data.tr={};session.data.autoSummary=false;}
   }
   if(fp)session.data.fp=fp;
   if(!session.data.summary||typeof session.data.summary!=='object')session.data.summary={};
   if(!Array.isArray(session.data.chat))session.data.chat=[];
   if(!session.data.tr||typeof session.data.tr!=='object')session.data.tr={};
   return session.data;
  }
  function saveSoon(session){
   if(session.saveTimer||session.destroyed)return;
   const win=session.doc.defaultView;
   if(session.probing)return;
   session.saveTimer=win.setTimeout(()=>{session.saveTimer=null;store.write(session.name+'.state',session.data);},800);
  }
  async function saveNow(session){
   if(session.saveTimer){try{session.doc.defaultView.clearTimeout(session.saveTimer);}catch(_){}session.saveTimer=null;}
   if(session.data)await store.write(session.name+'.state',session.data);
  }

  /* ---- styles ------------------------------------------------------------ */
  function stylesheet(){
   if(!cssPromise)cssPromise=Promise.resolve().then(async()=>{
    try{return String(await Z.File.getResourceAsync(runtime.rootURI+'content/reader-assist.css'));}
    catch(error){log(error);return '';}
   });
   return cssPromise;
  }

  /* ---- the panel ------------------------------------------------------------ */
  function button(session,parent,{label,title,iconName,cls='',mark,onClick,disabled=false,keys=''}){
   const doc=session.doc;
   const b=el(doc,'button',{type:'button','class':'sc-ra-btn '+cls,title:title?t(title)+(keys?' ('+keys+')':''):(label?t(label):undefined),'aria-label':t(title||label||''),'aria-keyshortcuts':keys?keys.replace('⌥⇧','Alt+Shift+'):undefined},parent);
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

  /* Keyboard: the reader's FocusManager owns Tab (it calls preventDefault and moves between [data-tabstop] groups,
     then focuses the group's first [tabindex="-1"] item) and moves inside a group with the arrow keys. So the
     panel is built the same way: each visible block is a group, its controls are tabindex=-1, and nothing hidden
     is a stop (the FocusManager only skips `.hidden`, not [hidden]). Marked here, kept current by tabstops(). */
  const group=node=>{node.setAttribute('data-sc-ra-group','1');return node;};
  const ITEMS='button,input,summary,[contenteditable="true"]';
  function tabstops(session){
   const ui=session.ui,root_=ui&&ui.root;if(!root_)return;
   const folded=isFolded(session);
   const shown=node=>{
    if(!session.open||node.closest('[hidden]'))return false;
    return node.closest('.sc-ra-rail')?folded:!folded;          // the rail when folded; the panel and its edge otherwise
   };
   for(const g of root_.querySelectorAll('[data-sc-ra-group]')){
    if(shown(g)&&(g.hasAttribute('tabindex')||g.querySelector(ITEMS)))g.setAttribute('data-tabstop','1');else g.removeAttribute('data-tabstop');
   }
   for(const n of root_.querySelectorAll(ITEMS)){if(n===ui.resizer)continue;if(shown(n))n.setAttribute('tabindex','-1');else n.removeAttribute('tabindex');}
  }

  const TABS=[['ask','AI','message','요약과 논문에 대한 대화'],['translate','번역','translate','문단별 번역'],['listen','문장','list','읽을 문장 목록']];
  const validTab=id=>TABS.some(x=>x[0]===id)?id:'ask';
  function buildPanel(session){
   const doc=session.doc,ui=session.ui={};
   const rootEl=el(doc,'aside',{'class':'sc-ra','data-sc-ra':'1','aria-label':t('논문 도우미'),role:'complementary',hidden:true,'data-collapsed':'false'});
   ui.root=rootEl;
   // The left edge is a drag handle for the width (and arrow keys when it has focus).
   ui.resizer=group(el(doc,'div',{'class':'sc-ra-resizer',role:'separator','aria-orientation':'vertical','aria-label':t('패널 너비 조절'),title:t('끌어서 패널 너비 조절'),tabindex:'-1'},rootEl));
   wireResizer(session);
   // The slim rail when collapsed: the player and the two tabs stay one click away while the paper has the room.
   ui.rail=group(el(doc,'nav',{'class':'sc-ra-rail','aria-label':t('논문 도우미 접힘')},rootEl));
   ui.railExpand=button(session,ui.rail,{title:'패널 펼치기',iconName:'expand',cls:'sc-ra-icon',mark:'view',onClick:()=>setCollapsed(session,false)});
   ui.railPlay=button(session,ui.rail,{title:'본문만 읽기',iconName:'play',cls:'sc-ra-icon sc-ra-rail-play',mark:'audio',onClick:()=>togglePlay(session)});
   button(session,ui.rail,{title:'AI 요약·대화',iconName:'message',cls:'sc-ra-icon',mark:'view',onClick:()=>{setCollapsed(session,false);showTab(session,'ask');}});
   button(session,ui.rail,{title:'번역',iconName:'translate',cls:'sc-ra-icon',mark:'view',onClick:()=>{setCollapsed(session,false);showTab(session,'translate');}});
   const main=ui.main=el(doc,'div',{'class':'sc-ra-main'},rootEl);
   const head=group(el(doc,'header',{'class':'sc-ra-head'},main));
   el(doc,'strong',{'class':'sc-ra-title',text:t('논문 도우미')},head);
   ui.status=el(doc,'span',{'class':'sc-ra-status',role:'status','aria-live':'polite'},head);
   button(session,head,{title:'패널 접기',iconName:'collapse',cls:'sc-ra-icon',mark:'view',onClick:()=>setCollapsed(session,true)});
   button(session,head,{title:'패널 닫기',iconName:'close',cls:'sc-ra-icon',mark:'view',onClick:()=>setOpen(session,false)});
   ui.unreadable=el(doc,'p',{'class':'sc-ra-banner',hidden:true,text:t('이 PDF는 글자층이 깨져 본문을 구분할 수 없습니다')+' '+t('Zotero가 추출한 일반 텍스트를 사용합니다')},main);
   buildClash(session,main);
   buildPlayer(session,main);
   const tabs=group(el(doc,'nav',{'class':'sc-ra-tabs',role:'tablist','aria-label':t('도우미 메뉴')},main));ui.tabs={};
   for(const[id,label,ic,title]of TABS){
    const b=el(doc,'button',{type:'button',role:'tab','class':'sc-ra-tab','data-safe':'view','data-tab':id,'aria-selected':'false',title:t(title)},tabs);
    b.appendChild(icon(doc,ic,14));el(doc,'span',{'class':'sc-ra-tab-text',text:t(label)},b);ui.tabs[id]={button:b,badge:el(doc,'span',{'class':'sc-ra-badge',hidden:true},b)};
    b.addEventListener('click',event=>{event.stopPropagation();showTab(session,id);});
   }
   const body=el(doc,'div',{'class':'sc-ra-body'},main);ui.body=body;ui.panes={};
   // Someone scrolling the panel is reading something: the sentence list does not pull them back for a while.
   for(const name of ['wheel','touchmove'])body.addEventListener(name,()=>{session.scrolledAt=Date.now();});
   for(const[id]of TABS)ui.panes[id]=el(doc,'div',{'class':'sc-ra-pane',role:'tabpanel','data-pane':id,hidden:true},body);
   buildAsk(session,ui.panes.ask);buildTranslate(session,ui.panes.translate);buildListen(session,ui.panes.listen);
   // The remembered tab is drawn from the start, so an open panel is never an empty grey column.
   paintTab(session,validTab(session.tab));
   // A click anywhere else closes an open menu.
   session.onDocClick=()=>{for(const m of session.menus)m.close();};on(session,doc,'click',session.onDocClick);
   session.onKey=event=>{if(event.key==='Escape')for(const m of session.menus)m.close();};on(session,doc,'keydown',session.onKey);
   return rootEl;
  }
  /* Zotero 9's own Read Aloud shares the speech queue: offer to stop it rather than fight it. The reader where it
     plays is kept with the pending start, so the one that is stopped is that reader, not this one. */
  function buildClash(session,parent){
   const doc=session.doc,ui=session.ui;
   ui.clash=group(el(doc,'section',{'class':'sc-ra-card sc-ra-clash',hidden:true,role:'alert'},parent));
   el(doc,'p',{'class':'sc-ra-note',text:t('다른 읽어주기가 재생 중입니다. 중지하고 시작할까요?')},ui.clash);
   const row=el(doc,'div',{'class':'sc-ra-row sc-ra-wrap'},ui.clash);
   button(session,row,{label:'중지하고 시작',cls:'sc-ra-primary',mark:'audio',onClick:()=>{const pending=session.pendingPlay;session.pendingPlay=null;ui.clash.hidden=true;tabstops(session);if(!pending)return;stopBuiltIn(pending.reader);return pending.go();}});
   button(session,row,{label:'취소',cls:'sc-ra-secondary',mark:'view',onClick:()=>{session.pendingPlay=null;ui.clash.hidden=true;tabstops(session);}});
  }

  /* -- the player bar -- */
  /* Where the chosen voice is kept: Korean papers have their own. */
  const voiceKey=lang=>String(lang||'').toLowerCase().startsWith('ko')?'readAloudVoiceKo':'readAloudVoice';
  /* A breath at a paragraph end and a longer one before a section (ms at 1×), as a person reading aloud does. */
  const SPEECH_PAUSES={paragraph:450,section:900};
  const PLAY_TIP='본문만 읽어 줍니다. 그림·표 캡션, 참고문헌, 머리말·꼬리말·쪽 번호는 건너뜁니다(Zotero의 읽어주기는 페이지의 글을 모두 읽습니다). PDF에서 Alt(Option)+더블클릭하거나 글을 선택해 ‘여기서부터 듣기’를 누르면 그 문장부터 읽습니다.';
  function buildPlayer(session,parent){
   const doc=session.doc,ui=session.ui;
   const bar=group(el(doc,'section',{'class':'sc-ra-card sc-ra-player','aria-label':t('읽어주기')},parent));
   const row=el(doc,'div',{'class':'sc-ra-row sc-ra-transport'},bar);
   const keys=keyHints();
   ui.sectionPrev=button(session,row,{title:'이전 섹션',iconName:'sectionPrev',cls:'sc-ra-icon',mark:'audio',onClick:()=>withPlayer(session,p=>p.prevSection())});
   ui.prev=button(session,row,{title:'이전 문장',keys:keys.prev,iconName:'prev',cls:'sc-ra-icon',mark:'audio',onClick:()=>withPlayer(session,p=>p.prev())});
   ui.play=button(session,row,{label:'본문만 읽기',title:PLAY_TIP,keys:keys.toggle,iconName:'play',cls:'sc-ra-play',mark:'audio',onClick:()=>togglePlay(session)});
   ui.next=button(session,row,{title:'다음 문장',keys:keys.next,iconName:'next',cls:'sc-ra-icon',mark:'audio',onClick:()=>withPlayer(session,p=>p.next())});
   ui.sectionNext=button(session,row,{title:'다음 섹션',iconName:'sectionNext',cls:'sc-ra-icon',mark:'audio',onClick:()=>withPlayer(session,p=>p.nextSection())});
   ui.progress=el(doc,'p',{'class':'sc-ra-progress',text:''},bar);
   // How far into the paper the listening is: a plain track and fill, inside the card (no edge bar).
   ui.meter=el(doc,'div',{'class':'sc-ra-meter',role:'progressbar','aria-label':t('들은 분량'),'aria-valuemin':'0','aria-valuemax':'100','aria-valuenow':'0',hidden:true},bar);
   ui.meterFill=el(doc,'span',{'class':'sc-ra-meter-fill'},ui.meter);
   const opts=el(doc,'div',{'class':'sc-ra-row sc-ra-opts'},bar);
   const rateWrap=el(doc,'label',{'class':'sc-ra-rate'},opts);el(doc,'span',{text:t('속도')},rateWrap);
   ui.rate=el(doc,'input',{type:'range',min:'80',max:'180',step:'10',value:String(setting('readAloudSpeed',100)),'aria-label':t('읽는 속도'),'data-opens':'audio'},rateWrap);
   ui.rateText=el(doc,'span',{'class':'sc-ra-rate-text'},rateWrap);
   ui.rate.addEventListener('input',()=>{const pct=Number(ui.rate.value);ui.rateText.textContent=(pct/100).toFixed(1)+'×';});
   ui.rate.addEventListener('change',()=>setRate(session,Number(ui.rate.value)/100));
   ui.rateText.textContent=(Number(ui.rate.value)/100).toFixed(1)+'×';
   ui.voice=menu(session,opts,{label:'목소리',ariaLabel:'목소리 고르기',items:[{value:'',label:t('자동')}],current:'',mark:'audio',onPick:value=>setVoice(session,value)});
   // Short labels so the three fit side by side at any panel width; the full meaning is the tooltip.
   const filters=el(doc,'div',{'class':'sc-ra-seg',role:'group','aria-label':t('읽을 범위')},bar);ui.filters={};
   for(const[id,label,title]of [['body','본문','본문만 읽습니다'],['captions','+ 캡션','본문과 그림·표 캡션을 읽습니다'],['references','+ 참고문헌','본문, 캡션, 참고문헌까지 읽습니다']]){
    const b=el(doc,'button',{type:'button','class':'sc-ra-seg-btn','data-opens':'audio','data-filter':id,'aria-pressed':String(id==='body'),title:t(title)},filters);b.textContent=t(label);ui.filters[id]=b;
    b.addEventListener('click',event=>{event.stopPropagation();setFilter(session,id);});
   }
   ui.more=el(doc,'div',{'class':'sc-ra-row sc-ra-more',hidden:true},bar);
   ui.resume=button(session,ui.more,{label:'이어서 듣기',iconName:'play',cls:'sc-ra-link',mark:'audio',onClick:()=>resumeListening(session)});
   const why=el(doc,'details',{'class':'sc-ra-why'},bar);
   const sum=el(doc,'summary',{text:t('건너뛴 내용')},why);void sum;
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
   const card=group(el(doc,'section',{'class':'sc-ra-card sc-ra-summary','aria-label':t('AI 요약')},pane));
   const head=el(doc,'div',{'class':'sc-ra-card-head'},card);el(doc,'h3',{'class':'sc-ra-h3',text:t('AI 요약')},head);
   ui.summaryActions=el(doc,'div',{'class':'sc-ra-actions'},head);
   ui.summaryCopy=button(session,ui.summaryActions,{title:'요약 복사',iconName:'copy',cls:'sc-ra-icon',mark:'view',onClick:()=>copyText(session,summaryEntry(session)?.text||'')});
   ui.summaryMemo=button(session,ui.summaryActions,{title:'메모에 넣기',iconName:'note',cls:'sc-ra-icon',mark:'memo',onClick:()=>toMemo(session,summaryEntry(session)?.text||'',t('AI 요약'))});
   ui.summaryNoteSave=button(session,ui.summaryActions,{title:'하위 노트로 저장',iconName:'noteAdd',cls:'sc-ra-icon',mark:'note',onClick:()=>{const e=summaryEntry(session);return toNote(session,{heading:t('AI 요약'),text:e?.text||'',by:e?.by,model:e?.model});}});
   ui.summaryAgain=button(session,ui.summaryActions,{title:'다시 만들기',iconName:'refresh',cls:'sc-ra-icon',mark:'ai',onClick:()=>runSummary(session,{force:true})});
   // The language the summary is written in, switchable here; each language keeps its own summary.
   const langs=el(doc,'div',{'class':'sc-ra-seg sc-ra-lang',role:'group','aria-label':t('출력 언어')},card);ui.summaryLang={};
   for(const[id,label]of [['English','English'],['Korean','한국어']]){
    const b=el(doc,'button',{type:'button','class':'sc-ra-seg-btn','data-writes':'cache','data-lang':id,'aria-pressed':'false',title:t('AI 요약·대화를 이 언어로 씁니다')},langs);b.textContent=label;ui.summaryLang[id]=b;
    b.addEventListener('click',event=>{event.stopPropagation();setSummaryLanguage(session,id);});
   }
   ui.summaryBody=el(doc,'div',{'class':'sc-ra-md'},card);
   ui.summaryStart=button(session,card,{label:'요약 만들기',cls:'sc-ra-primary',mark:'ai',onClick:()=>runSummary(session,{})});
   ui.summaryNote=el(doc,'p',{'class':'sc-ra-note'},card);
   const chat=el(doc,'section',{'class':'sc-ra-card sc-ra-chat','aria-label':t('논문과 대화')},pane);
   const chead=el(doc,'div',{'class':'sc-ra-card-head'},chat);el(doc,'h3',{'class':'sc-ra-h3',text:t('논문과 대화')},chead);
   const cactions=group(el(doc,'div',{'class':'sc-ra-actions'},chead));
   ui.chatClear=button(session,cactions,{title:'대화 지우기',iconName:'trash',cls:'sc-ra-icon',mark:'cache',onClick:()=>clearChat(session)});
   const chips=group(el(doc,'div',{'class':'sc-ra-chips'},chat));
   for(const id of Object.keys(PC.QUICK)){
    const q=PC.QUICK[id];button(session,chips,{label:q.label,cls:'sc-ra-chip',mark:'ai',onClick:()=>sendQuick(session,id)});
   }
   ui.chatList=group(el(doc,'div',{'class':'sc-ra-messages',role:'log','aria-live':'polite'},chat));
   const composer=group(el(doc,'div',{'class':'sc-ra-composer'},chat));
   /* The question box is an editable <div>, not a <textarea>: the reader's KeyboardManager treats a key as a
      shortcut unless isTextBox(target) — <input type="text"> or contenteditable="true" — so in a textarea "r" or
      "l" started Zotero's Read Aloud and the arrows moved focus. Its window listeners run in the capture phase
      before anything on this panel, so the box has to be one Zotero recognises. */
   ui.input=el(doc,'div',{'class':'sc-ra-input',contenteditable:'true',role:'textbox','aria-multiline':'true',spellcheck:'false','data-placeholder':t('이 논문에 대해 물어보세요'),'aria-label':t('질문 입력')},composer);
   // Only plain text goes in: a paste or a drop of formatted text would otherwise bring its markup along.
   const plain=(event,data)=>{
    const text=data&&typeof data.getData==='function'?String(data.getData('text/plain')||''):'';
    event.preventDefault();if(!text)return;
    let done=false;try{done=!!doc.execCommand('insertText',false,text);}catch(_){}
    if(!done)ui.input.appendChild(doc.createTextNode(text));
   };
   ui.input.addEventListener('paste',event=>plain(event,event.clipboardData));
   ui.input.addEventListener('drop',event=>plain(event,event.dataTransfer));
   ui.send=button(session,composer,{title:'보내기',iconName:'send',cls:'sc-ra-send',mark:'ai',onClick:()=>sendTyped(session)});
   ui.stop=button(session,composer,{title:'중지',iconName:'stop',cls:'sc-ra-send',mark:'view',onClick:()=>{session.chatToken&&session.chatToken.cancel();}});ui.stop.hidden=true;
   ui.input.addEventListener('keydown',event=>{
    // Enter sends; Shift+Enter is a new line; Enter that confirms a Korean/Japanese composition does not send.
    if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();sendTyped(session);}
   });
   ui.chatNote=el(doc,'p',{'class':'sc-ra-note'},chat);
  }
  /* The summary for the current settings: model, language, server and prompt revision. A summary saved before
     0.59.24 (keyed "model|language" only) is still shown for the same model and language. */
  function summaryEntry(session){
   const all=session.data&&session.data.summary;if(!all)return null;
   const a=aiSettings(),legacy=all[a.model+'|'+a.language];
   return all[summaryKeyOf(a)]||(legacy&&!legacy.rev?legacy:null)||null;
  }
  /* What the reader already has around this paper (paper-chat.libraryBlock): its tags and memo, the collections it
     is in and up to 15 other papers there, those sharing the most tags first. Titles only; '' when there is none. */
  function libraryContext(item){
   try{
    if(!item)return '';
    const tags=(item.getTags?.()||[]).map(x=>String(x.tag||x)).filter(Boolean);
    const memo=String(runtime.entry?.(item)?.remark||'');
    const collections=[],seen=new Set([item.id]),pool=[];
    for(const id of (item.getCollections?.()||[]).slice(0,6)){
     const c=Z.Collections&&Z.Collections.get?Z.Collections.get(id):null;if(!c)continue;
     collections.push(String(c.name||''));
     for(const other of (c.getChildItems?.(false)||[]).slice(0,400)){
      if(!other||seen.has(other.id)||(other.isRegularItem&&!other.isRegularItem()))continue;seen.add(other.id);
      const theirs=new Set((other.getTags?.()||[]).map(x=>String(x.tag||x)));
      pool.push({other,shared:tags.filter(x=>theirs.has(x)).length,added:String(fieldOf(other,'dateAdded')||other.dateAdded||'')});
     }
    }
    pool.sort((a,b)=>b.shared-a.shared||(b.added>a.added?1:b.added<a.added?-1:0));
    const neighbours=pool.slice(0,15).map(({other})=>({title:fieldOf(other,'title'),year:(/\d{4}/.exec(fieldOf(other,'date'))||[''])[0]}));
    return PC.libraryBlock({memo,tags,collections,neighbours});
   }catch(error){log(error);return '';}
  }
  const NO_AI='설정에서 AI 서버 주소와 모델을 먼저 입력하세요. 이 Mac의 Claude·ChatGPT 계정을 쓰려면 bridge/install.sh로 AI 브리지를 설치하세요.';
  /* Where a press sends the paper: the bridge's account, or the server's host. */
  const aiPlace=()=>{try{const s=runtime.assist&&typeof runtime.assist.status==='function'?runtime.assist.status():null;if(!s||!s.available)return '';return s.source==='bridge'?byLabel(s.provider||'claude'):String(s.label||'');}catch(_){return '';}};
  function setSummaryLanguage(session,lang){
   if(session.summaryState==='loading'||language()===lang)return;
   Promise.resolve(runtime.setSetting('aiLanguage',lang,{apply:false})).then(()=>{if(!session.destroyed)renderSummary(session);}).catch(log);
  }
  function renderSummary(session){
   const ui=session.ui,entry=summaryEntry(session),state=session.summaryState||'idle';
   for(const[id,b]of Object.entries(ui.summaryLang||{})){b.setAttribute('aria-pressed',String(language()===id));b.disabled=state==='loading';}
   const configured=!!runtime.assist?.available?.();
   ui.summaryBody.replaceChildren();ui.summaryNote.textContent='';
   const has=!!entry&&state!=='loading';
   for(const b of [ui.summaryCopy,ui.summaryMemo,ui.summaryNoteSave,ui.summaryAgain])b.hidden=!has;
   ui.summaryStart.hidden=has||state==='loading';
   if(state==='loading'){
    // The summary as it streams in: what has arrived, then the line saying more is coming.
    const draft=String(session.summaryDraft||'');
    if(draft){const box=el(session.doc,'div',{},ui.summaryBody);renderMarkdown(session.doc,box,draft,{pages:pageCount(session.reader),onPage:page=>goToPage(session,page)});}
    el(session.doc,'p',{'class':'sc-ra-muted',text:t('요약하는 중…')},ui.summaryBody);
   }
   else if(entry){
    renderMarkdown(session.doc,ui.summaryBody,entry.text,{pages:pageCount(session.reader),onPage:page=>goToPage(session,page)});
    ui.summaryNote.textContent=T('{0} · {1}',byLabel(entry.by)||entry.model||t('모델 미표기'),new Date(entry.at).toLocaleDateString())+(entry.by==='codex'?' · '+t(FALLBACK_NOTE):'')+(entry.truncated?' · '+t('긴 논문이라 일부만 읽혔습니다'):'')+(entry.incomplete?' · '+t('요약이 중간에 끊겼습니다. 다시 만들어 보세요.'):'');
   }else if(state==='error'){el(session.doc,'p',{'class':'sc-ra-error',text:session.summaryError||''},ui.summaryBody);}
   else ui.summaryNote.textContent=configured?(aiPlace()?T('눌러야 보냅니다 · {0}. 본문 일부, 제목·초록, 이 논문의 태그·메모와 같은 컬렉션 논문 제목을 보냅니다.',aiPlace()):t('눌러야 AI 서버로 보냅니다. 본문 일부, 제목·초록, 이 논문의 태그·메모와 같은 컬렉션 논문 제목을 보냅니다.')):t(NO_AI);
  }
  async function runSummary(session,{force=false,auto=false}={}){
   if(session.summaryState==='loading')return;
   if(!force&&summaryEntry(session)){renderSummary(session);return;}
   // The job starts at the click: closing the reader cancels it through the extraction too.
   const token=session.summaryToken=TR.token();
   session.summaryState='loading';session.summaryError='';renderSummary(session);
   try{
    let structured=null;try{structured=(await untilCancelled(structure(session),token)).structured;}catch(error){if(isCancel(error,token))throw error;log(error);}
    const item=itemOf(session.reader),meta={title:fieldOf(item,'title'),abstract:fieldOf(item,'abstractNote')};
    const input=PC.summaryInput(structured||{},{meta,pageBase:PAGE_BASE});
    if(session.destroyed||token.cancelled)return;
    // Frozen as the request starts, and the key it is filed under when it returns, whatever the settings are by then.
    const frozen=aiSettings(),key=summaryKeyOf(frozen);
    session.summaryDraft='';let timer=null;
    const refresh=()=>{timer=null;if(!session.destroyed&&session.summaryState==='loading'&&session.summaryToken===token)renderSummary(session);};
    const onDelta=(piece,all)=>{if(token.cancelled)return;session.summaryDraft=all;if(timer===null&&!session.destroyed&&session.doc.defaultView)timer=session.doc.defaultView.setTimeout(refresh,90);};
    let text,incomplete=null;
    try{text=await runtime.assist.paperSummary({title:input.title,abstract:input.abstract,text:input.text,library:libraryContext(item)},{language:frozen.language,signal:token,onDelta,onFinish:f=>{incomplete=f&&f.incomplete||null;}});}
    finally{session.summaryDraft='';if(timer!==null){try{session.doc.defaultView.clearTimeout(timer);}catch(_){}}}
    if(session.destroyed)return;
    session.data.summary[key]={text,at:Date.now(),model:frozen.model,language:frozen.language,endpoint:frozen.endpoint,rev:frozen.rev,truncated:input.truncated,incomplete:incomplete||undefined,by:answeredBy()||undefined};
    const keys=Object.keys(session.data.summary);if(keys.length>6)delete session.data.summary[keys[0]];
    session.summaryState='done';saveSoon(session);
   }catch(error){session.summaryState='error';session.summaryError=describe(error);}
   if(!session.destroyed)renderSummary(session);
  }

  /* -- chat -- */
  const MESSAGE_ROLE={user:'user',assistant:'assistant'},LONG_ANSWER=900;
  /* scroll: 'keep' (the default) leaves the list where the reader put it, also while an answer streams in, so a long
     answer is read from its start; 'question' brings a question just sent to the top; 'bottom' is for a conversation
     shown again. An answer longer than LONG_ANSWER is folded unless it is the newest, with a button to unfold it. */
  function renderChat(session,{scroll='keep'}={}){
   const ui=session.ui,doc=session.doc,list=ui.chatList;
   let kept=0;try{kept=Number(list.scrollTop)||0;}catch(_){}
   list.replaceChildren();
   const messages=session.data.chat;
   if(!messages.length){el(doc,'p',{'class':'sc-ra-muted',text:t('아직 대화가 없습니다. 아래 버튼을 누르거나 질문을 입력하세요.')},list);}
   let newest=-1;messages.forEach((m,i)=>{if(m.role==='assistant')newest=i;});
   const open=session.unfolded||(session.unfolded=new Set());
   messages.forEach((m,index)=>{
    const bubble=el(doc,'article',{'class':'sc-ra-msg sc-ra-msg-'+(MESSAGE_ROLE[m.role]||'assistant'),'data-index':index},list);
    const long=m.role==='assistant'&&!m.streaming&&String(m.content||'').length>LONG_ANSWER;
    if(long)bubble.setAttribute('data-folded',String(index!==newest&&!open.has(m.at)));
    const body=el(doc,'div',{'class':'sc-ra-md'},bubble);
    if(m.role==='assistant')renderMarkdown(doc,body,(m.streaming?PC.splitFollowUps(m.content).body:m.content)||(m.streaming?'…':''),{pages:pageCount(session.reader),onPage:page=>goToPage(session,page)});
    else body.textContent=m.content;
    if(m.error)el(doc,'p',{'class':'sc-ra-error',text:m.error},bubble);
    else if(m.role==='assistant'&&m.incomplete&&!m.streaming)el(doc,'p',{'class':'sc-ra-error',text:t('답변이 중간에 끊겼습니다. 다시 물어보세요.')},bubble);
    if(m.role==='assistant'&&m.by==='codex'&&!m.streaming)el(doc,'p',{'class':'sc-ra-msg-by',text:t(FALLBACK_NOTE)},bubble);
    if(m.role==='assistant'&&!m.streaming&&m.content){
     const actions=el(doc,'div',{'class':'sc-ra-actions sc-ra-msg-actions'},bubble);
     if(long){
      const folded=()=>bubble.getAttribute('data-folded')==='true';
      const fold=button(session,actions,{label:folded()?'더 보기':'줄여 보기',cls:'sc-ra-link sc-ra-fold',mark:'view',onClick:()=>{
       const next=!folded();bubble.setAttribute('data-folded',String(next));if(next)open.delete(m.at);else open.add(m.at);
       const text=fold.querySelector('.sc-ra-btn-text');if(text)text.textContent=t(next?'더 보기':'줄여 보기');fold.setAttribute('aria-label',t(next?'더 보기':'줄여 보기'));
       fold.setAttribute('aria-expanded',String(!next));
      }});
      fold.setAttribute('aria-expanded',String(!folded()));
     }
     // Follow-up questions under the newest answer: one press asks it.
     if(index===newest&&Array.isArray(m.followUps)&&m.followUps.length){
      const next=group(el(doc,'div',{'class':'sc-ra-chips sc-ra-followups','aria-label':t('이어서 물어보기')},bubble));
      bubble.insertBefore(next,actions);
      for(const q of m.followUps)button(session,next,{label:q,cls:'sc-ra-chip',mark:'ai',onClick:()=>{if(session.chatBusy){say(session,t('답변이 끝나면 보낼 수 있습니다. 질문은 그대로 두었습니다.'));return;}return sendQuestion(session,q,{});}});
     }
     button(session,actions,{title:'답변 복사',iconName:'copy',cls:'sc-ra-icon',mark:'view',onClick:()=>copyText(session,m.content)});
     button(session,actions,{title:'메모에 넣기',iconName:'note',cls:'sc-ra-icon',mark:'memo',onClick:()=>toMemo(session,m.content,t('AI 답변'))});
     const asked=messages.slice(0,index).reverse().find(x=>x.role==='user');
     button(session,actions,{title:'하위 노트로 저장',iconName:'noteAdd',cls:'sc-ra-icon',mark:'note',onClick:()=>toNote(session,{heading:t('AI 답변'),question:asked?asked.content:'',text:m.content,by:m.by,model:m.model})});
    }
   });
   const busy=!!session.chatBusy;
   ui.send.hidden=busy;ui.stop.hidden=!busy;
   setBadge(session,'ask',messages.length);tabstops(session);
   try{
    if(scroll==='bottom')list.scrollTop=list.scrollHeight;
    else if(scroll==='question'){const q=[...list.querySelectorAll('.sc-ra-msg-user')].at(-1);list.scrollTop=q?Math.max(0,Number(q.offsetTop)||0):list.scrollHeight;}
    else list.scrollTop=kept;
   }catch(_){}
  }
  function trimChat(session){
   const clean_=session.data.chat.filter(m=>!m.streaming);
   session.data.chat=clean_.slice(-MAX_CHAT).map(m=>({role:m.role,content:String(m.content||'').slice(0,CHAT_LIMIT*3),at:m.at,error:m.error||undefined,model:m.model||undefined,by:m.by||undefined,incomplete:m.incomplete||undefined,picked:Array.isArray(m.picked)?m.picked.slice(0,12):undefined,followUps:Array.isArray(m.followUps)&&m.followUps.length?m.followUps.slice(0,3).map(q=>String(q).slice(0,200)):undefined}));
  }
  /* The question box is an editable <div> (see buildAsk): its text, line breaks included. */
  const inputText=session=>{const n=session.ui.input;const v=typeof n.innerText==='string'?n.innerText:n.textContent;return String(v||'');};
  const setInputText=(session,text)=>{session.ui.input.textContent=text||'';};
  // While an answer is still coming, Enter keeps the typed question in the box (it was emptied and then dropped).
  const sendTyped=session=>{const q=clean(inputText(session));if(!q)return;if(session.chatBusy){say(session,t('답변이 끝나면 보낼 수 있습니다. 질문은 그대로 두었습니다.'));return;}setInputText(session,'');return sendQuestion(session,q,{});};
  const sendQuick=(session,id)=>{const q=PC.quickPrompt(id,t);return sendQuestion(session,q.question,{forcePage:q.forcePage,mine:q.mine,intent:q.intent});};
  /* A passage selected in the PDF, asked about from the selection popup: the question names it, the model is given
     it whole with its page. While another answer is still coming, it waits rather than being lost. */
  function askPassage(session,text,page){
   const passage={text:clean(text).slice(0,2500),page};if(!passage.text)return;
   setOpen(session,true);showTab(session,'ask');
   if(session.chatBusy){say(session,t('답변이 끝나면 보낼 수 있습니다. 질문은 그대로 두었습니다.'));if(!clean(inputText(session)))setInputText(session,'“'+passage.text.slice(0,300)+'” ');return;}
   const q=PC.quickPrompt('passage',t);
   return sendQuestion(session,q.question,{passage,shown:'“'+passage.text.slice(0,240)+(passage.text.length>240?'…':'')+'”\n'+q.question});
  }
  async function sendQuestion(session,question,{forcePage=false,mine=false,intent=null,passage=null,shown=''}={}){
   if(session.chatBusy)return;
   // The conversation the question belongs to: the answer is written there, even if the panel's conversation is
   // cleared or replaced meanwhile.
   const thread=session.data.chat;
   const history=thread.filter(m=>!m.error).slice();
   // What the conversation shows and sends back later: the question, with the passage it was about.
   const user={role:'user',content:(shown||question).slice(0,CHAT_LIMIT),at:Date.now()},answer={role:'assistant',content:'',streaming:true,at:Date.now()};
   // The job and the busy state start at the click, so Stop works while the paper's text is still being read:
   // Stop cancels this question only, not a summary or a translation beside it.
   const chatToken=session.chatToken=TR.token();
   thread.push(user,answer);session.chatBusy=true;renderChat(session,{scroll:'question'});
   let timer=null;const refresh=()=>{timer=null;if(!session.destroyed)renderChat(session);};
   try{
    if(!runtime.assist?.available?.())throw Object.assign(new Error(NO_AI),{own:true});
    let structured=null,notice='';
    try{structured=(await untilCancelled(structure(session),chatToken)).structured;}catch(error){if(isCancel(error,chatToken))throw error;log(error);notice=t('본문을 읽지 못해 초록만 참고했습니다.');}
    if(chatToken.cancelled)throw cancelledError();
    const item=itemOf(session.reader);
    const doc=structured||{title:fieldOf(item,'title'),abstract:fieldOf(item,'abstractNote'),sections:[]};
    session.chunks=session.chunks||PC.buildChunks(doc,{pageBase:PAGE_BASE});
    const page=currentPage(session.reader),sectionIndex=structured?PC.sectionAtPage(structured,page||1,{pageBase:PAGE_BASE}):-1;
    const viewing={page,sectionIndex,section:sectionIndex>=0?clean(structured.sections[sectionIndex].heading):''};
    const own=mine?{memo:String(runtime.entry?.(item)?.remark||''),tags:(item?.getTags?.()||[]).map(x=>String(x.tag||x))}:null;
    const entry=summaryEntry(session);
    // Frozen as the request starts: the answer records the model and server it was asked of.
    const frozen=aiSettings();answer.model=frozen.model;
    const library=mine?libraryContext(item):'';
    const {messages,picked}=PC.chatMessages({question,history,chunks:session.chunks,summary:entry?entry.text:'',language:frozen.language,viewing,mine:own,forcePage,intent,passage,library});
    answer.picked=picked.map(c=>c.id);
    session.ui.chatNote.textContent=notice;
    if(session.destroyed||chatToken.cancelled)throw cancelledError();
    const text=await runtime.assist.chat(messages,{signal:chatToken,onFinish:f=>{if(f&&f.incomplete)answer.incomplete=f.incomplete;},onDelta:(piece,all)=>{answer.content=all;if(timer===null&&!session.destroyed&&session.doc.defaultView)timer=session.doc.defaultView.setTimeout(refresh,90);}});
    // The suggested follow-ups are kept apart from the answer: copied, saved and sent back without them.
    const split=PC.splitFollowUps(text);answer.content=split.body||text;if(split.followUps.length)answer.followUps=split.followUps;
    answer.by=answeredBy()||undefined;
   }catch(error){answer.error=describe(error);}
   answer.streaming=false;if(session.chatToken===chatToken){session.chatBusy=false;session.chatToken=null;}if(timer!==null){try{session.doc.defaultView.clearTimeout(timer);}catch(_){}}
   if(!answer.content&&answer.error){
    for(const m of [answer,user]){const i=thread.indexOf(m);if(i>=0)thread.splice(i,1);}
    session.ui.chatNote.textContent=answer.error;
    if(thread===session.data.chat&&!clean(inputText(session)))setInputText(session,question);
   }
   if(thread===session.data.chat)trimChat(session);
   saveSoon(session);if(!session.destroyed)renderChat(session);
  }
  function clearChat(session){
   // A question still running stays with the conversation it was asked in, which is the one being cleared.
   try{session.chatToken&&session.chatToken.cancel();}catch(_){}
   session.data.chat=[];session.chatBusy=false;session.chatToken=null;saveSoon(session);renderChat(session);
  }

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
  /* A summary or an answer as a child note of the paper (the memo is the other place, see toMemo). */
  async function toNote(session,{heading,text,question='',by=null,model=''}){
   const item=itemOf(session.reader),library=runtime.libraryService;if(!item||!clean(text))return;
   if(!library?.createNoteHTML)throw new Error('Note creation is unavailable');
   const html=PC.noteHTML({heading,title:fieldOf(item,'title'),question,text,source:byLabel(by)||model||'',date:new Date().toISOString().slice(0,10)});
   await library.createNoteHTML(item.id,html);
   say(session,t('하위 노트로 저장했습니다.'));
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
   const card=group(el(doc,'section',{'class':'sc-ra-card sc-ra-tr','aria-label':t('번역')},pane));
   const head=el(doc,'div',{'class':'sc-ra-card-head'},card);el(doc,'h3',{'class':'sc-ra-h3',text:t('문단별 번역')},head);
   const bar=el(doc,'div',{'class':'sc-ra-actions'},head);
   ui.trTarget=menu(session,bar,{label:'번역 언어',ariaLabel:'번역할 언어 고르기',items:[],current:'',mark:'view',onPick:value=>setTarget(session,value)});
   ui.trProvider=el(doc,'p',{'class':'sc-ra-note'},card);
   ui.trSources=el(doc,'p',{'class':'sc-ra-note',hidden:true},card);
   ui.trEstimate=el(doc,'p',{'class':'sc-ra-note'},card);
   const row=el(doc,'div',{'class':'sc-ra-row sc-ra-wrap'},card);
   ui.trHere=button(session,row,{label:'이 쪽만 번역',cls:'sc-ra-primary',mark:'ai',onClick:()=>runTranslate(session,'here')});
   ui.trPage=button(session,row,{label:'현재 페이지부터',cls:'sc-ra-secondary',mark:'ai',onClick:()=>runTranslate(session,'page')});
   ui.trAll=button(session,row,{label:'전체 번역',cls:'sc-ra-secondary',mark:'ai',onClick:()=>runTranslate(session,'all')});
   ui.trStop=button(session,row,{label:'중지',cls:'sc-ra-secondary',mark:'view',onClick:()=>{if(session.trJob)session.trJob.cancel();if(session.tr)session.tr.service.cancel();}});ui.trStop.hidden=true;
   ui.trNext=button(session,row,{label:'다른 번역기로 이어서',cls:'sc-ra-secondary',mark:'ai',onClick:()=>runTranslate(session,'resume',{next:true})});ui.trNext.hidden=true;
   const row2=el(doc,'div',{'class':'sc-ra-row sc-ra-wrap'},card);
   ui.trUsage=button(session,row2,{label:'사용량 새로고침',iconName:'refresh',cls:'sc-ra-link',mark:'network',onClick:()=>refreshUsage(session)});
   ui.trNote=button(session,row2,{label:'노트로 저장',iconName:'note',cls:'sc-ra-link',mark:'note',onClick:()=>saveTranslationNote(session)});
   // View choices, remembered: captions as rows, the originals open under each translation, the list following the PDF.
   const opts=el(doc,'div',{'class':'sc-ra-row sc-ra-wrap'},card);
   const check=(name,label,initial,onChange)=>{
    const wrap=el(doc,'label',{'class':'sc-ra-check'},opts);
    const box=el(doc,'input',{type:'checkbox','data-safe':'view','data-tr':name,'aria-label':t(label)},wrap);box.checked=initial;
    el(doc,'span',{text:t(label)},wrap);
    box.addEventListener('change',()=>{onChange(box.checked);persistUI();});
    return box;
   };
   ui.trCaptions=check('captions','그림·표 설명도 번역',uiState().trCaptions===true,on=>{uiState().trCaptions=on;if(session.tr)session.tr.paragraphs=[];prepareTranslate(session);});
   ui.trOriginals=check('originals','원문 함께 보기',uiState().trOriginals===true,on=>{uiState().trOriginals=on;for(const d of ui.trRows.querySelectorAll('.sc-ra-orig'))d.open=on;});
   ui.trSync=check('sync','PDF와 함께 스크롤',uiState().trSync!==false,on=>{uiState().trSync=on;if(on){session.trHere=null;followPage(session);}});
   ui.trProgress=el(doc,'p',{'class':'sc-ra-note',role:'status'},card);
   ui.trRows=group(el(doc,'div',{'class':'sc-ra-rows'},pane));
  }
  /* The list follows the PDF: after the reader scrolls (a wheel, a key, a drag in the page), the paragraph of the
     page on screen is marked and brought into the panel's view. Only while the translation tab is showing. */
  function followPage(session){
   if(session.destroyed||!session.open||session.tab!=='translate'||uiState().trSync===false||!session.tr)return;
   const page=currentPage(session.reader);if(!page||page===session.trHere)return;
   const rows=[...session.ui.trRows.querySelectorAll('.sc-ra-row-card')];
   const index=fromPage(session,session.tr.paragraphs);if(index<0)return;
   const id=session.tr.paragraphs[index].id;
   session.trHere=page;
   for(const row of rows){if(row.getAttribute('data-id')===id)row.setAttribute('data-here','true');else row.removeAttribute('data-here');}
   const row=rows.find(r=>r.getAttribute('data-id')===id);
   if(row&&row.scrollIntoView)try{row.scrollIntoView({block:'nearest'});}catch(_){}
  }
  function scheduleFollow(session){
   if(session.followTimer||session.tab!=='translate'||uiState().trSync===false)return;
   const win=session.doc.defaultView;
   session.followTimer=win.setTimeout(()=>{session.followTimer=null;followPage(session);},250);
  }
  function translator(session){
   if(session.tr)return session.tr;
   const data=session.data;
   const cache={get:k=>data.tr[k],set:(k,v)=>{data.tr[k]=v;const keys=Object.keys(data.tr);if(keys.length>4000)delete data.tr[keys[0]];},save:async()=>{saveSoon(session);}};
   // The job's cancel token aborts the request in flight (Zotero.HTTP's canceller).
   const http=async(method,url,{headers,body,signal=null})=>{
    let off=()=>{};
    try{
     if(signal&&signal.cancelled)return {status:0,json:null};
     const r=await Z.HTTP.request(method,url,{headers,body,responseType:'json',timeout:60000,successCodes:false,errorDelayMax:0,
      cancellerReceiver:cancel=>{if(!signal)return;off();off=signal.onCancel(()=>{try{cancel();}catch(_){}});}});
     return {status:r.status,json:r.response,retryAfter:Number(r.getResponseHeader&&r.getResponseHeader('Retry-After'))||0};
    }catch(_){return {status:0,json:null};}
    finally{off();}
   };
   const service=TR.create({http,now:()=>new Date(),pref:key=>runtime.pref(key,''),cache,
    usageStore:{get:()=>runtime.cache.deeplUsage,set:v=>{runtime.cache.deeplUsage=v;persistUI();}},
    pdfTranslate:()=>Z.PDFTranslate&&Z.PDFTranslate.api,
    // Translate for Zotero's own settings, read only: which service it is set to, and its target language.
    pdfTranslatePref:key=>{try{return Z.Prefs&&Z.Prefs.get('extensions.zotero.ZoteroPDFTranslate.'+key,true);}catch(_){return '';}},
    pdftUsageStore:{get:()=>runtime.cache.pdftUsage,set:v=>{runtime.cache.pdftUsage=v;persistUI();}},
    ai:{available:()=>!!runtime.assist?.available?.(),translate:(texts,o)=>runtime.assist.translateParagraphs(texts,o)},
    uiKorean:()=>runtime.i18n?.isKorean?.()!==false});
   // What is shown comes from the cache under the current settings (service.resolved): switching the language, the
   // formality or the AI model shows that setting's translations, never another's.
   return session.tr={service,paragraphs:[]};
  }
  async function prepareTranslate(session){
   if(session.probing)return;
   const tr=translator(session);
   try{
    const {structured}=await structure(session);
    tr.paragraphs=TR.paragraphsOf(structured,{pageBase:PAGE_BASE,captions:uiState().trCaptions===true});session.trHere=null;
   }catch(error){tr.paragraphs=[];session.ui.trProgress.textContent=describe(error);}
   renderTranslate(session);
  }
  /* "DeepL Free · 문단 1–12, Translate for Zotero · 문단 13–40": who translated which paragraphs. */
  function sourcesText(service,paragraphs,found){
   return TR.providerSpans(paragraphs,found).map(x=>T('{0} · 문단 {1}',service.providerLabel(x.provider),TR.rangeText(x.ranges))).join(', ');
  }
  /* The first paragraph on or after the page on screen; -1 past the last one (the references, the back pages). */
  const fromPage=(session,paragraphs)=>TR.firstOnOrAfter(paragraphs,currentPage(session.reader)||1);
  const trBusy=session=>!!session.trJob||!!(session.tr&&session.tr.service.busy);
  function renderTranslate(session){
   const ui=session.ui,tr=translator(session),doc=session.doc,service=tr.service;
   const providers=service.providers(),current=service.pickProvider(),target=service.target(),busy=trBusy(session);
   // "Automatic" first, naming what it resolves to now; the pill shows the language itself.
   const chosen=String(runtime.pref('translateTarget','auto')||'auto').toUpperCase(),explicit=TR.TARGETS.some(x=>x.code===chosen);
   ui.trTarget.set({items:[{value:'auto',label:T('자동 ({0})',service.autoTarget().label)},...TR.TARGETS.map(x=>({value:x.code,label:x.label}))],current:explicit?target.code:'auto',label:target.label});
   ui.trProvider.textContent=current?T('번역기: {0}',service.providerLabel(current))+(providers.length>1?' · '+T('대체: {0}',providers.slice(providers.indexOf(current)+1).map(service.providerLabel).join(', ')||'—'):'')
    +(service.targetOrigin()==='pdftranslate'?' · '+t('번역 언어는 Translate for Zotero 설정을 따릅니다'):''):t('번역기가 없습니다. 설정 → 번역·AI에서 DeepL 키를 넣거나 Translate for Zotero를 설치하세요. DeepL 무료 키는 한 달 50만 자까지 쓸 수 있습니다.');
   const usage=service.usage();
   const start=fromPage(session,tr.paragraphs);
   const est=service.estimate(tr.paragraphs,current);
   const pageEst=service.estimate(start<0?[]:tr.paragraphs.slice(start),current);
   const limitText=usage.limit===null?t('한도 미확인'):usage.limit.toLocaleString();
   ui.trEstimate.textContent=!tr.paragraphs.length?(readingText(session)||t('번역할 본문을 아직 읽지 못했습니다.')):
    T('전체 약 {0}자 · 이미 번역한 {1}문단은 제외',est.chars.toLocaleString(),est.cached)+' · '+T('현재 페이지부터 약 {0}자',pageEst.chars.toLocaleString())
    +(current==='deepl'?' · '+T('이번 달 {0} / {1}자 사용',usage.chars.toLocaleString(),limitText)+(usage.free?'':' · '+t('유료 키')):'')
    +(current==='pdftranslate'?' · '+pdftLine(service.pdftUsage()):'')
    +(current==='ai'&&est.chars?' · '+(isLocalAI()?T('AI 서버로 약 {0}토큰 (이 Mac에서 실행)',est.tokens.toLocaleString()):viaBridge()?T('AI 브리지로 약 {0}토큰 · {1}의 사용 한도에서 씁니다',est.tokens.toLocaleString(),aiPlace()):T('AI 서버로 약 {0}토큰을 보내고 받습니다. 모델 요금이 붙습니다.',est.tokens.toLocaleString())):'')
    +(current==='deepl'&&!est.fits?' · '+t('전체는 남은 한도를 넘습니다. 한도에 닿으면 거기서 멈추고 번역한 부분은 남습니다.'):'');
   for(const b of [ui.trHere,ui.trPage,ui.trAll])b.disabled=!current||!tr.paragraphs.length||busy;
   ui.trStop.hidden=!busy;ui.trUsage.hidden=!service.providers().includes('deepl');ui.trNote.disabled=!tr.paragraphs.length;
   if(busy)ui.trNext.hidden=true;
   // rows: each paragraph's current translation and the translator that made it
   const found=service.resolved(tr.paragraphs,target.code);
   const sources=sourcesText(service,tr.paragraphs,found);
   ui.trSources.textContent=sources?T('번역: {0}',sources):'';ui.trSources.hidden=!sources;
   ui.trRows.replaceChildren();let done=0;
   tr.paragraphs.forEach(p=>{
    const hit=found.get(p.id),text=hit?hit.text:'';
    if(text)done++;
    const row=el(doc,'article',{'class':'sc-ra-row-card','data-id':p.id,'data-state':text?'done':'todo','data-provider':hit?hit.provider:undefined},ui.trRows);
    const meta=el(doc,'button',{type:'button','class':'sc-ra-row-meta','data-safe':'view',title:(p.heading?p.heading+' — ':'')+t('이 문단으로 이동')},row);
    meta.textContent=(p.heading||'—')+(p.page?' · p. '+p.page:'');
    meta.addEventListener('click',()=>goToPage(session,p.page,p.rects));
    const body=el(doc,'p',{'class':'sc-ra-tr-text'},row);body.textContent=text||'—';
    const orig=el(doc,'details',{'class':'sc-ra-orig'},row);if(uiState().trOriginals===true)orig.open=true;el(doc,'summary',{text:hit?t('원문')+' · '+service.providerLabel(hit.provider):t('원문')},orig);el(doc,'p',{'class':'sc-ra-orig-text'},orig).textContent=p.text;
    const tools=el(doc,'div',{'class':'sc-ra-row sc-ra-row-tools'},row);
    const again=button(session,tools,{label:'다시 번역',cls:'sc-ra-link',mark:'ai',onClick:()=>retranslate(session,p)});
    again.disabled=busy||!current;
    const copy=button(session,tools,{title:'원문과 번역 복사',iconName:'copy',cls:'sc-ra-icon',mark:'view',onClick:()=>{const now=found.get(p.id)||translator(session).service.resolved([p],target.code).get(p.id);if(now)copyText(session,p.text+'\n\n'+now.text);}});
    copy.setAttribute('data-copy','paragraph');copy.disabled=!text;
   });
   setBadge(session,'translate',tr.paragraphs.length?done+'/'+tr.paragraphs.length:0);
   tabstops(session);
  }
  function paintParagraph(session,p,text,code,provider){
   const tr=translator(session);
   if(code!==tr.service.target().code)return;      // a run for another language: stored in the cache, not shown here
   const row=session.ui.trRows.querySelector('[data-id="'+p.id+'"]');
   if(row){row.setAttribute('data-state','done');if(provider)row.setAttribute('data-provider',provider);const body=row.querySelector('.sc-ra-tr-text');if(body)body.textContent=text;const copy=row.querySelector('[data-copy]');if(copy)copy.disabled=false;}
  }
  // The local bridge uses the Mac's own Claude/ChatGPT accounts: their allowance, not a per-token bill.
  const viaBridge=()=>{try{const st=runtime.assist&&typeof runtime.assist.status==='function'?runtime.assist.status():null;return !!(st&&st.available&&st.source==='bridge');}catch(_){return false;}};
  const isLocalAI=()=>/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//i.test(String(runtime.pref('aiEndpoint','')||'').trim());
  const usageLine=u=>T('이번 달 {0} / {1}자 사용',u.chars.toLocaleString(),u.limit===null?t('한도 미확인'):u.limit.toLocaleString());
  /* Through Translate for Zotero the key is its own: what this panel sent, against DeepL Free's monthly 500,000. */
  const pdftLine=u=>u.limit?T('이번 달 이 패널에서 보낸 양: {0} / {1}자 (Translate for Zotero의 다른 번역은 빠짐)',u.chars.toLocaleString(),u.limit.toLocaleString()):T('이번 달 이 패널에서 보낸 양: {0}자',u.chars.toLocaleString());
  /* One translation job at a time, whole paragraphs or one paragraph again. The job's token and the busy state are
     made at the click, so Stop works from the first moment: while the paper's text is read, while DeepL's usage is
     asked, and between every batch; each await is followed by a look at the token. */
  async function runTranslate(session,mode,{next=false}={}){
   const tr=translator(session),service=tr.service,ui=session.ui;
   if(trBusy(session))return;
   const job=session.trJob=TR.token();
   renderTranslate(session);
   let summary=null,provider=null;
   try{
    if(!tr.paragraphs.length)await untilCancelled(prepareTranslate(session),job);
    if(session.destroyed)return;
    if(job.cancelled)throw cancelledError();
    provider=service.pickProvider();
    if(next)provider=service.nextProvider(session.trProvider||provider)||provider;
    if(!provider){ui.trProgress.textContent=t('번역기가 없습니다. 설정 → 번역·AI에서 DeepL 키를 넣으세요.');return;}
    session.trProvider=provider;ui.trNext.hidden=true;
    // Fixed for this run: the language the menu shows now (a carry-on keeps the language of the run it continues).
    const code=next&&session.trCode?session.trCode:service.target().code,found=service.resolved(tr.paragraphs,code);
    let list;
    if(next){
     // Another translator carries on where the last one stopped: only what no translator has finished in this
     // language, within what that run was asked to do ('이 쪽만 번역' stays on its page). Nothing already
     // translated is sent (or paid for) twice.
     const scopeIDs=session.trScope?new Set(session.trScope):null;
     list=TR.unfinished(scopeIDs?tr.paragraphs.filter(p=>scopeIDs.has(p.id)):tr.paragraphs.slice(session.trStart||0),found);
    }else{
     const start=mode==='page'?fromPage(session,tr.paragraphs):mode==='here'?tr.paragraphs.indexOf(TR.onPage(tr.paragraphs,currentPage(session.reader)||1)[0]):0;
     if(start<0){ui.trProgress.textContent=mode==='here'?t('이 쪽에는 번역할 본문이 없습니다. 본문이 있는 쪽으로 가거나 ‘전체 번역’을 누르세요.'):t('이 쪽부터는 번역할 본문이 없습니다. 본문이 있는 쪽으로 가거나 ‘전체 번역’을 누르세요.');return;}
     session.trStart=start;
     const scope=mode==='here'?TR.onPage(tr.paragraphs,currentPage(session.reader)||1):tr.paragraphs.slice(start);
     session.trScope=scope.map(p=>p.id);session.trCode=code;
     // A paragraph another translator already finished is left as it is ("다시 번역" redoes one on purpose).
     list=scope.filter(p=>{const hit=found.get(p.id);return !hit||hit.provider===provider;});
    }
    // DeepL's own count (free to ask) before spending it; a failure here only means the local count is used.
    if(provider==='deepl'){try{await service.refreshUsage({signal:job});}catch(error){if(!job.cancelled)log(error);}}
    if(session.destroyed)return;
    if(job.cancelled)throw cancelledError();
    summary=await service.translateAll(list,{provider,target:code,signal:job,
     onParagraph:(p,text)=>{if(!session.destroyed)paintParagraph(session,p,text,code,provider);},
     onProgress:p=>{if(session.destroyed)return;ui.trProgress.textContent=T('번역 {0}/{1}문단 · {2}',p.done,p.total,service.providerLabel(provider))+(provider==='deepl'?' · '+usageLine(service.usage()):provider==='pdftranslate'?' · '+pdftLine(service.pdftUsage()):'');}}).catch(error=>({provider,done:0,total:0,stopped:error.code||'failed',error}));
   }catch(error){
    if(!isCancel(error,job))throw error;
    summary={provider,done:0,total:0,stopped:'cancelled'};
   }finally{
    if(session.trJob===job)session.trJob=null;
    if(!summary&&!session.destroyed)renderTranslate(session);
   }
   if(session.destroyed||!summary)return;
   ui.trProgress.textContent=summary.stopped==='cancelled'?T('중지했습니다. {0}문단 번역됨',summary.done):summary.stopped?describe(summary.error)+(summary.error&&summary.error.detail?' ('+summary.error.detail+')':'')+' · '+T('{0}문단 번역됨',summary.done):T('{0}문단 번역을 마쳤습니다.',summary.done);
   renderTranslate(session);
   if(summary.stopped&&['quota','key','rate','server','failed','shape','pdft','empty'].includes(summary.stopped)&&service.nextProvider(provider))ui.trNext.hidden=false;
   tabstops(session);
  }
  async function retranslate(session,paragraph){
   const tr=translator(session);
   if(trBusy(session))return;
   const job=session.trJob=TR.token(),code=tr.service.target().code;
   renderTranslate(session);
   try{
    const result=await tr.service.translateOne(paragraph,{provider:tr.service.pickProvider(),force:true,target:code,signal:job});
    if(session.destroyed)return;
    session.ui.trProgress.textContent=T('다시 번역했습니다 · {0}',tr.service.providerLabel(result.provider));
   }catch(error){
    if(session.destroyed)return;
    if(!isCancel(error,job))throw error;
    session.ui.trProgress.textContent=t('중지했습니다.');
   }finally{
    if(session.trJob===job)session.trJob=null;
    if(!session.destroyed)renderTranslate(session);
   }
  }
  async function refreshUsage(session){
   const tr=translator(session);const u=await tr.service.refreshUsage();
   if(session.destroyed)return;
   session.ui.trProgress.textContent=T('DeepL 사용량 {0} / {1}자',u.chars.toLocaleString(),u.limit===null?t('한도 미확인'):u.limit.toLocaleString());renderTranslate(session);
  }
  async function setTarget(session,code){
   try{await runtime.setSetting('translateTarget',code,{apply:false});}catch(error){log(error);}
   if(!session.destroyed)renderTranslate(session);
  }
  /* The note is the language the menu shows, with that language's current translations only, and says which
     translator made which paragraphs. */
  async function saveTranslationNote(session){
   const tr=translator(session),item=itemOf(session.reader),library=runtime.libraryService,service=tr.service;
   if(!item||!library?.createNoteHTML)throw new Error('Note creation is unavailable');
   const code=service.target().code,found=service.resolved(tr.paragraphs,code);
   const translations=new Map([...found].map(([id,v])=>[id,v.text])),sources=new Map([...found].map(([id,v])=>[id,service.providerLabel(v.provider)]));
   const made=TR.noteHTML({title:fieldOf(item,'title'),target:code,provider:sourcesText(service,tr.paragraphs,found)||service.providerLabel(service.pickProvider()||''),date:new Date().toISOString().slice(0,10),paragraphs:tr.paragraphs,translations,sources});
   if(!made.count){say(session,t('저장할 번역이 아직 없습니다.'),true);return;}
   await library.createNoteHTML(item.id,made.html);
   say(session,T('원문·번역 {0}문단을 노트로 저장했습니다.',made.count));
  }

  /* -- listen -- */
  function buildListen(session,pane){
   const doc=session.doc,ui=session.ui;
   const card=group(el(doc,'section',{'class':'sc-ra-card sc-ra-listen','aria-label':t('듣기 목록')},pane));
   const head=el(doc,'div',{'class':'sc-ra-card-head'},card);el(doc,'h3',{'class':'sc-ra-h3',text:t('듣기 목록')},head);
   const follow=el(doc,'label',{'class':'sc-ra-check'},head);
   ui.follow=el(doc,'input',{type:'checkbox','data-safe':'view','aria-label':t('PDF에서 따라가기')},follow);ui.follow.checked=uiState().follow!==false;
   el(doc,'span',{text:t('PDF에서 따라가기')},follow);
   ui.follow.addEventListener('change',()=>{uiState().follow=ui.follow.checked;persistUI();if(!ui.follow.checked)clearHighlight(session);});
   ui.listenNote=el(doc,'p',{'class':'sc-ra-note'},card);
   ui.transcript=group(el(doc,'div',{'class':'sc-ra-transcript'},pane));
  }
  function renderTranscript(session){
   const ui=session.ui,doc=session.doc,player=session.player;
   ui.transcript.replaceChildren();
   if(!player){ui.listenNote.textContent=t('▶를 누르면 문장 목록이 여기에 나타납니다. 문장을 누르면 그 문장부터 읽습니다.');return;}
   const units=player.units();let label=null,group=null;
   ui.listenNote.textContent=T('{0}문장 · 문장을 누르면 거기서부터 읽습니다.',units.length)+' '+keysLine();
   units.forEach((u,i)=>{
    const name=u.kind==='caption'?t('캡션'):u.kind==='reference'?t('참고문헌'):u.sectionLabel||t('본문');
    if(name!==label||!group){label=name;const h=el(doc,'h4',{'class':'sc-ra-h'},ui.transcript);h.textContent=name;group=el(doc,'div',{'class':'sc-ra-group'},ui.transcript);}
    const b=el(doc,'button',{type:'button','class':'sc-ra-sentence','data-opens':'audio','data-index':i},group);
    b.textContent=u.text;b.addEventListener('click',()=>{session.scrolledAt=0;playFrom(session,i,{jump:true});});
   });
   markCurrent(session);setBadge(session,'listen',units.length);
  }
  const FOLLOW_PAUSE_MS=8000;
  function markCurrent(session){
   const list=session.ui.transcript;if(!list||!session.player)return;
   const state=session.player.state();
   const prev=list.querySelector('[aria-current="true"]');if(prev)prev.removeAttribute('aria-current');
   const now=list.querySelector('[data-index="'+state.index+'"]');
   const resting=Date.now()-(session.scrolledAt||0)<FOLLOW_PAUSE_MS;
   if(now&&state.status!=='idle'){now.setAttribute('aria-current','true');if(session.tab==='listen'&&!resting&&now.scrollIntoView)try{now.scrollIntoView({block:'nearest'});}catch(_){}}
  }

  /* ---- the player ------------------------------------------------------- */
  function setBadge(session,tab,count){
   const b=session.ui.tabs[tab].badge;if(!b)return;
   b.textContent=String(count);b.hidden=!count;
  }
  function spawnSay(args,onexit){
   // The live self-check blocks every process launch while it runs, and counts the attempt.
   if(guard&&guard('nsIProcess /usr/bin/say'))return {kill(){}};
   const C=root.Components||globalThis.Components;
   const file=C.classes['@mozilla.org/file/local;1'].createInstance(C.interfaces.nsIFile);file.initWithPath('/usr/bin/say');
   const proc=C.classes['@mozilla.org/process/util;1'].createInstance(C.interfaces.nsIProcess);proc.init(file);
   proc.runwAsync(args,args.length,{observe(subject,topic){let status=-1;try{if(topic==='process-finished')status=proc.exitValue;}catch(_){}onexit(status);}});
   return {kill(){try{proc.kill();}catch(_){}}};
  }
  /* ---- natural voices ----
     1. The voice chosen in Zotero's own Read Aloud, for a language that has one: Zotero's server, the account's
        credits (about two free hours of standard voices), the same voice and the same quota as the reader's ▶.
     2. Supertonic 3 on this Mac through the AI bridge (bridge/tts): free, no quota. It also takes over for the rest
        of the paper when Zotero's credits run out or its server cannot be reached.
     3. The system voices (speechSynthesis, then `say`), below. */
  const QUOTA=/quota|limit/;
  // Voices the bridge or Zotero speaks (an audio element), as opposed to the system's own speech queue.
  const NATURAL_KINDS=['zotero','supertonic','kokoro'];
  function zoteroVoiceIDs(){
   let map={};try{map=JSON.parse(String(Z.Prefs.get('reader.readAloudVoices')||'{}'))||{};}catch(_){}
   const out={};
   for(const [lang,v] of Object.entries(map)){const id=v&&(v.voice||v.tierVoices&&(v.tierVoices.standard||v.tierVoices.premium));if(typeof id==='string'&&/^[\w-]+$/.test(id))out[lang]=id;}
   return out;
  }
  let bridgeVoiceCheck=null;
  async function bridgeVoices(){
   if(bridgeVoiceCheck&&Date.now()-bridgeVoiceCheck.at<60000)return bridgeVoiceCheck.value;
   let value=null;
   try{
    const config=runtime.assist&&typeof runtime.assist.bridge==='function'?await runtime.assist.bridge():null;
    if(config){
     const r=await Z.HTTP.request('GET',config.base+'/v1/audio/voices',{headers:{Authorization:'Bearer '+config.token},responseType:'json',timeout:4000,successCodes:false,errorDelayMax:0});
     const body=r&&r.status===200?r.response:null;
     if(body&&body.available&&Array.isArray(body.models)&&body.models.length)value={config,models:body.models};
    }
   }catch(_){value=null;}
   bridgeVoiceCheck={at:Date.now(),value};return value;
  }
  async function naturalEngine(session){
   const win=Z.getMainWindow?Z.getMainWindow():null;
   if(!win||typeof win.Audio!=='function'||typeof win.Blob!=='function')return null;
   let zotero={};
   try{if(await Z.Sync.Data.Local.getAPIKey())zotero=zoteroVoiceIDs();}catch(_){zotero={};}
   const bridge=await bridgeVoices();
   const voices=[];
   for(const [lang,id] of Object.entries(zotero))voices.push({voiceURI:`zotero:${lang}:${id}`,name:t('Zotero 읽어주기'),lang,localService:false,default:true,model:'zotero'});
   // Every local model the bridge has, for every language it speaks: one entry each, named by its model.
   for(const model of bridge?bridge.models:[]){
    for(const lang of model.langs&&model.langs.length?model.langs:['en'])for(const v of model.voices||[])
     voices.push({voiceURI:`${model.id}:${lang}:${v.id}`,name:`${model.label} · ${v.id}${v.style?' ('+v.style+')':''}`,lang,localService:true,default:!zotero[lang]&&v.id===model.default,model:model.id});
   }
   if(!voices.length)return null;
   const modelIDs=(bridge?bridge.models:[]).map(m=>m.id);
   const toURL=(blob,playbackRate=1)=>{const url=win.URL.createObjectURL(blob);return {url,playbackRate,release(){try{win.URL.revokeObjectURL(url);}catch(_){}}};};
   const local=({text,lang,model,voice,rate})=>{
    let cancel=null,aborted=false;
    const {config}=bridge;const code=String(lang||'en').toLowerCase().split(/[-_]/)[0];
    const promise=Promise.resolve(Z.HTTP.request('POST',config.base+'/v1/audio/speech',{headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.token},
     body:JSON.stringify({input:text,lang:code,model:model||modelIDs[0]||'',voice:voice||'',speed:rate}),responseType:'arraybuffer',timeout:60000,successCodes:false,errorDelayMax:0,
     cancellerReceiver:fn=>{cancel=fn;if(aborted)fn();}})).then(r=>{
      if(!r||r.status!==200||!r.response)throw Object.assign(new Error('이 Mac의 음성 모델이 응답하지 않습니다 ('+(r&&r.status)+'). 터미널에서 bridge/install.sh를 다시 실행해 보세요.'),{own:true});
      return toURL(new win.Blob([r.response],{type:'audio/wav'}));
     });
    return {promise,abort(){aborted=true;try{cancel&&cancel();}catch(_){}}};
   };
   const remote=({text,voice,rate})=>{
    let aborted=false;
    const promise=(async()=>{
     let result=null;
     const face=typeof session.reader._getReadAloudRemoteInterface==='function'?session.reader._getReadAloudRemoteInterface(win):null;
     if(face&&face.getAudio)result=await face.getAudio({text},{id:voice});
     else{const client=Z.Sync.Runner.getAPIClient({apiKey:await Z.Sync.Data.Local.getAPIKey()});result=await client.getReadAloudAudio({text},voice);}
     if(aborted)throw Object.assign(new Error('cancelled'),{code:'cancelled'});
     if(!result||!result.audio)throw Object.assign(new Error(String(result&&result.error||'unknown')),{zotero:true});
     return toURL(result.audio,rate);
    })();
    return {promise,abort(){aborted=true;}};
   };
   const synth=({text,lang,voiceURI,rate})=>{
    const [kind,voiceLang,id]=String(voiceURI||'').split(':');
    const code=voiceLang||lang;
    if(kind==='zotero'&&!session.zoteroVoiceOff){
     const job=remote({text,voice:id,rate});
     if(!bridge)return job;
     // Out of credits or offline: this piece and the rest of the paper are read by a model on this Mac.
     let inner=null;
     const promise=job.promise.catch(error=>{
      if(!error||!error.zotero)throw error;
      if(!session.zoteroVoiceOff){session.zoteroVoiceOff=QUOTA.test(error.message)?'quota':'error';try{renderPlayer(session);}catch(_){}}
      inner=local({text,lang:code,model:'',voice:'',rate});return inner.promise;
     });
     return {promise,abort(){job.abort();inner&&inner.abort();}};
    }
    if(bridge&&modelIDs.includes(kind))return local({text,lang:code,model:kind,voice:id,rate});
    if(bridge)return local({text,lang:code,model:'',voice:'',rate});
    return remote({text,voice:id,rate});
   };
   return RA.audioEngine({synth,makeAudio:url=>new win.Audio(url),voices});
  }
  /* Every engine this Mac can offer, in one list, so the panel's voice menu holds them all and switching from
     one model to another does not start the paper over. A live self-check speaks nothing and sends nothing, so
     it gets the system voices alone. */
  async function pickEngine(session){
   const win=session.reader._iframeWindow||session.doc.defaultView;
   const parts=[];
   if(!guard){
    try{const natural=await naturalEngine(session);if(natural&&natural.available())parts.push({kinds:NATURAL_KINDS.slice(),engine:natural});}catch(error){log(error);}
   }
   const speech=RA.speechEngine(win);
   if(!speech.available()){
    // Voices load late in Gecko: give them a moment, as the reader's own read-aloud does.
    try{
     if(win.speechSynthesis&&win.speechSynthesis.addEventListener)await new Promise(resolve=>{const done=()=>resolve();win.speechSynthesis.addEventListener('voiceschanged',done,{once:true});win.setTimeout(done,1500);});
    }catch(_){}
   }
   const system=speech.available()?speech:await sayFallback(win);
   if(system)parts.push({kinds:['system'],engine:system,fallback:true});
   if(!parts.length)throw new Error('이 컴퓨터에서 쓸 수 있는 음성이 없습니다. 시스템 설정 → 접근성 → 음성 콘텐츠에서 음성을 내려받으세요.');
   return parts.length===1?parts[0].engine:RA.multiEngine(parts);
  }
  async function sayFallback(win){
   const mac=Z.isMac||/Mac/i.test(String(win.navigator&&win.navigator.platform||''));
   if(mac&&typeof io()?.exists==='function'&&await io().exists('/usr/bin/say').catch(()=>false))return RA.sayEngine({spawn:spawnSay});
   return null;
  }
  /* The voices are in the menu before anything is read: an engine knows its voices without the paper's text,
     so the panel can offer them (and the models behind them) as soon as it opens. */
  async function ensureVoices(session){
   if(session.player||session.voicesPromise||session.destroyed||guard)return session.voicesPromise;
   session.voicesPromise=(async()=>{
    const engine=session.engine||await pickEngine(session);
    if(session.destroyed||session.player)return;
    session.engine=engine;
    const voices=engine.voices()||[];
    const lang=session.langCode||'en';
    const chosen=RA.pickVoice(voices,lang,String(setting(voiceKey(lang),'')||''));
    fillVoices(session,voices,lang,chosen);
    noteVoices(session,voices,lang,chosen);
   })().catch(error=>{log(error);}).finally(()=>{session.voicesPromise=null;});
   return session.voicesPromise;
  }
  /* What the voice menu ended up holding, beside the layout report: which engines answered and with how many
     voices, so the menu can be checked without opening it. */
  function noteVoices(session,voices,lang,chosen){
   try{
    const counts={};
    for(const v of voices){const kind=String(v.voiceURI||'').split(':')[0],id=NATURAL_KINDS.includes(kind)?kind:'system';counts[id]=(counts[id]||0)+1;}
    const shown=voices.filter(v=>String(v.lang||'').toLowerCase().startsWith(lang)).length;
    const line=`${new Date().toISOString()} voices lang=${lang} menu=${shown||voices.length} chosen=${chosen?chosen.name:'-'} `+
     Object.entries(counts).map(([k,n])=>k+'='+n).join(' ');
    writeReport(session,'voices',line);
   }catch(error){log(error);}
  }
  async function ensurePlayer(session){
   if(session.player)return session.player;
   if(session.playerPromise)return session.playerPromise;
   // Every await below may outlive the reader: a closed session makes no player, and a player made too late is destroyed.
   const alive=()=>{if(session.destroyed)throw Object.assign(new Error('The reader was closed'),{closed:true});};
   session.playerPromise=(async()=>{
    const {structured}=await structure(session);alive();
    const engine=session.engine||await pickEngine(session);alive();
    const filters=session.filters||{captions:false,references:false};
    // Everything is composed once; the player's own switches decide what is read.
    const units=RA.composeUnits(structured,{captions:true,references:true},tools(session));
    if(!units.length)throw new Error('읽을 본문이 없습니다. 아래 ‘건너뛴 내용’을 열어 보세요.');
    const lang=RA.paperLanguage(units);
    const voices=engine.voices();
    // Korean papers keep a voice of their own, so choosing Yuna for one does not replace Samantha for the rest
    const saved=String(setting(voiceKey(lang),'')||'');
    const savedVoice=voices.find(v=>v.voiceURI===saved);
    const voice=RA.pickVoice(voices,lang,savedVoice&&String(savedVoice.lang||'').toLowerCase().startsWith(lang)?saved:'');
    const headings=setting('readAloudHeadings',true)!==false;
    const player=RA.create({engine,lang:voice&&voice.lang||lang,voiceURI:voice?voice.voiceURI:'',rate:Number(setting('readAloudSpeed',100))/100,filters,
     headings,pauses:headings?SPEECH_PAUSES:{},
     onChange:event=>onPlayerEvent(session,event),onCredit:(unit,seconds)=>credit(session,unit,seconds)});
    const resume=session.data.position&&session.data.position.sig?session.data.position:null;
    player.load(units,{resume:null});
    if(session.destroyed){player.destroy();alive();}
    session.player=player;session.engine=engine;session.langCode=lang;session.resumePosition=resume;
    fillVoices(session,voices,lang,voice);
    renderTranscript(session);renderPlayer(session);
    return player;
   })();
   // The first ▶ on a paper reads its text and finds a voice: say so, instead of a still "not started yet".
   session.preparing=true;showReading(session);
   try{return await session.playerPromise;}finally{session.playerPromise=null;session.preparing=false;if(!session.destroyed&&session.ui)renderPlayer(session);}
  }
  /* The menu holds every voice of every engine for the paper's language, the models grouped and named, so the
     reader can hear the same paragraph in another one without losing their place. */
  const ENGINE_ORDER=['zotero','supertonic','kokoro','system'];
  const engineOf=v=>{const kind=String(v&&v.voiceURI||'').split(':')[0];return NATURAL_KINDS.includes(kind)?kind:'system';};
  function fillVoices(session,voices,lang,current){
   const same=voices.filter(v=>String(v.lang||'').toLowerCase().startsWith(lang));
   const list=(same.length?same:voices).slice();
   list.sort((a,b)=>ENGINE_ORDER.indexOf(engineOf(a))-ENGINE_ORDER.indexOf(engineOf(b)));
   const items=[{value:'',label:t('자동')},...list.slice(0,120).map(v=>({value:v.voiceURI,label:engineOf(v)==='system'?t('시스템')+' · '+v.name:v.name}))];
   const saved=setting(voiceKey(lang),'');
   session.ui.voice.set({items,current:saved&&items.some(i=>i.value===saved)?saved:'',label:current?current.name:t('목소리')});
  }
  async function withPlayer(session,fn){if(session.destroyed)return;const p=await ensurePlayer(session);if(!session.destroyed)fn(p);}
  const isMacOS=()=>{try{if(typeof Z.isMac==='boolean')return Z.isMac;}catch(_){}try{return /Mac/i.test(String(root.navigator&&root.navigator.platform||''));}catch(_){return true;}};
  const keyHints=()=>KEY_HINTS[isMacOS()?'mac':'other'];
  const keysLine=()=>{const k=keyHints();return T('단축키: {0} 재생·일시정지, {1} 이전 문장, {2} 다음 문장.',k.toggle,k.prev,k.next);};
  const playTip=()=>t(PLAY_TIP)+' '+keysLine();
  /* The player's keys (see shortcutOf), heard on the reader's document and on each PDF view in the capture phase,
     so they work with the panel closed. Play/pause starts from the page on screen like the toolbar ▶; the sentence
     keys act once the player has started. A start while Zotero's own Read Aloud plays goes through the same question
     as the ▶ button (startPlayback), never over it. */
  function onShortcut(session,event){
   if(session.destroyed||stopped)return;
   const action=shortcutOf(event);if(!action)return;
   if(action!=='toggle'&&(!session.player||session.player.state().status==='idle'))return;
   try{event.preventDefault();event.stopPropagation();}catch(_){}
   const run=action==='toggle'?togglePlay(session):withPlayer(session,p=>p[action]());
   Promise.resolve(run).catch(error=>{log(error);say(session,describe(error),true);});
  }
  /* Zotero 9's own Read Aloud (always on, the toolbar's #read-aloud) speaks through the same queue. Zotero 10 keeps
     active and paused on its read-aloud manager, not in the reader's state; without them a playing Zotero voice was
     never seen and ours would start over it. */
  const builtInState=reader=>{try{
   const core=coreOf(reader),st=core?._state?.readAloudState;if(!st)return null;
   if('active' in st)return st;
   const m=core._readAloudManager;return m?{...st,active:!!m.active,paused:!!m.paused}:st;
  }catch(_){return null;}};
  const builtInPlaying=reader=>{const st=builtInState(reader);return !!(st&&st.active&&!st.paused);};
  function stopBuiltIn(reader){
   const core=coreOf(reader);
   try{if(core&&typeof core.toggleReadAloudPopup==='function')core.toggleReadAloudPopup(false);else if(core&&typeof core.toggleReadAloudPaused==='function')core.toggleReadAloudPaused(true);}catch(error){log(error);}
  }
  /* Everything that starts sound goes through here: never after the reader closed, never over Zotero's own
     Read Aloud without asking, and only one of our players at a time across readers. */
  /* The reader whose own Read Aloud is playing, this one or any other open reader. */
  function clashingReader(skip){
   const readers=new Set([...sessions.values()].map(s=>s.reader));
   try{for(const r of Z.Reader?._readers||[])readers.add(r);}catch(_){}
   for(const r of readers)if(r!==skip&&builtInPlaying(r))return r;
   return null;
  }
  async function startPlayback(session,go,{ignore=null}={}){
   if(session.destroyed)return;
   const other=clashingReader(ignore);
   if(other){
    // Kept with the start: "중지하고 시작" stops the reader where it was found playing, then starts this one.
    session.pendingPlay={reader:other,go:()=>startPlayback(session,go,{ignore:other})};
    if(!session.open)setOpen(session,true,{remember:false});
    if(isFolded(session))setCollapsed(session,false,{remember:false});
    session.ui.clash.hidden=false;tabstops(session);return;
   }
   const p=await ensurePlayer(session);
   if(session.destroyed||p.destroyed)return;
   go(p);
  }
  function pauseOthers(session){for(const other of sessions.values())if(other!==session&&other.player&&other.player.state().status==='playing')other.player.pause();}
  async function playFrom(session,index,{jump=false}={}){
   return startPlayback(session,p=>{p.play(index);if(jump){const u=p.units()[index];if(u)goToPage(session,pageNumberOf(u),u.rects);}});
  }
  async function togglePlay(session){
   // A second press while the first is still reading the paper is the same press, not a second start.
   if(session.destroyed||session.playerPromise)return;
   const current=session.player?session.player.state().status:'idle';
   if(current==='playing'){session.player.pause();return;}
   // From the top of the page being read when nothing is playing; "이어서 듣기" is the way back to the saved sentence.
   return startPlayback(session,p=>{const status=p.state().status;if(status==='idle'||status==='done'||status==='error')p.play(startIndexForPage(session,p));else p.toggle();});
  }
  function startIndexForPage(session,player){
   const page=currentPage(session.reader);
   if(!page)return 0;
   const at=player.units().findIndex(u=>pageNumberOf(u)>=page);
   return at>=0?at:0;
  }
  const filterId=f=>f&&f.references?'references':f&&f.captions?'captions':'body';
  async function resumeListening(session){
   return startPlayback(session,p=>{
    const pos=session.data.position;
    // The range that was being listened to comes back first: a caption or a reference is found only in its own range,
    // and an index counts sentences of that range.
    if(pos&&pos.filter&&pos.filter!==filterId(session.filters))setFilter(session,pos.filter);
    let index=pos&&pos.sig?p.units().findIndex(u=>RA.signature(u)===pos.sig):-1;
    if(index<0&&pos&&Number.isInteger(pos.index)&&pos.index<p.units().length&&(pos.filter||'body')===filterId(session.filters))index=pos.index;
    p.play(Math.max(0,index));
   });
  }
  function setRate(session,rate){
   setSettingQuiet('readAloudSpeed',Math.round(rate*100));
   if(session.player)session.player.setRate(rate);
   session.ui.rateText.textContent=rate.toFixed(1)+'×';
  }
  function setVoice(session,uri){
   const voices=session.engine?session.engine.voices()||[]:[];
   const chosen=uri?voices.find(x=>x.voiceURI===uri):null;
   setSettingQuiet(voiceKey(chosen?String(chosen.lang||''):session.langCode||''),uri);
   const p=session.player;if(!p)return;
   // 자동 is the same choice the first ▶ makes, not whatever the system default voice happens to be
   const v=chosen||RA.pickVoice(voices,session.langCode,'');
   p.setVoice(v?v.voiceURI:'',v?v.lang:session.langCode);
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
   if(state.status==='playing'&&(type==='status'||type==='sentence'))pauseOthers(session);
   renderPlayer(session);
   if(type==='interrupted')say(session,t('다른 읽어주기가 시작되어 멈췄습니다'),true);
   if(type==='sentence'||type==='status'&&state.status==='playing'){
    if(state.unit)markCurrent(session);
    if(type==='sentence'){
     if(state.unit)highlight(session,state.unit);session.data.position={index:state.index,sig:RA.signature(state.unit),page:pageNumberOf(state.unit),filter:filterId(session.filters),at:Date.now()};saveSoon(session);}
   }
   if(state.status==='idle'||state.status==='done')clearHighlight(session);
   if(state.status==='error')say(session,state.error==='no-audio'?t('소리가 나지 않습니다. 시스템 음성 설정을 확인하세요.'):T('읽기를 멈췄습니다: {0}',state.error),true);
  }
  function renderPlayer(session){
   const ui=session.ui,p=session.player,state=p?p.state():null,playing=state&&state.status==='playing';
   const playBtn=ui.play,f0=session.filters||{captions:false,references:false};
   const label=playing?t('일시정지'):state&&state.status==='paused'?t('이어 읽기'):f0.captions?t('읽기 시작'):t('본문만 읽기');
   playBtn.replaceChildren(icon(session.doc,playing?'pause':'play'));el(session.doc,'span',{'class':'sc-ra-btn-text',text:label},playBtn);
   playBtn.setAttribute('aria-label',label);playBtn.title=playing?label+' ('+keyHints().toggle+')':label+' — '+playTip();
   ui.railPlay.replaceChildren(icon(session.doc,playing?'pause':'play'));ui.railPlay.setAttribute('aria-label',label);ui.railPlay.title=label;
   // The toolbar ▷ doubles as play/pause, so listening does not need the panel open.
   const tb=session.toolbarState&&session.toolbarState.listen;
   if(tb)try{tb.replaceChildren(icon(tb.ownerDocument,playing?'pause':'play'));tb.setAttribute('aria-label',playing?t('일시정지'):t('본문만 읽기'));tb.title=playing?t('일시정지')+' ('+keyHints().toggle+')':t('본문만 읽기')+' — '+playTip();}catch(_){}
   const has=!!state&&state.total>0;
   for(const b of [ui.prev,ui.next,ui.sectionPrev,ui.sectionNext])b.disabled=!has;
   if(state&&state.unit){
    const where=state.unit.kind==='caption'?t('캡션'):state.unit.kind==='reference'?t('참고문헌'):state.unit.sectionLabel;
    const left=RA.remainingSeconds(p.units(),state.index,state.rate);
    // The section name is last: it is the part that may be cut short in a narrow panel.
    ui.progress.textContent=T('문장 {0}/{1}',state.index+1,state.total)+' · '+(left<60?t('1분 안 남음'):T('약 {0}분 남음',Math.round(left/60)))+(where?' · '+where:'');
   }else ui.progress.textContent=has?'':session.preparing?(readingText(session)||t('준비하는 중…')):t('아직 시작하지 않았습니다');
   const pct=has?Math.round((state.index+(state.status==='done'?1:0))/state.total*100):0;
   ui.meter.hidden=!has;ui.meter.setAttribute('aria-valuenow',String(pct));ui.meterFill.style.width=pct+'%';
   const pos=session.data&&session.data.position;
   const idle=!state||state.status==='idle';
   ui.resume.hidden=!(pos&&pos.sig&&idle);ui.more.hidden=ui.resume.hidden;
   if(!ui.resume.hidden){const text=ui.resume.querySelector('.sc-ra-btn-text');if(text)text.textContent=pos.page?T('이어서 듣기 · p. {0}',pos.page):t('이어서 듣기');}
   for(const[name,b]of Object.entries(ui.filters)){const f_=session.filters||{captions:false,references:false};b.setAttribute('aria-pressed',String(name==='body'?!f_.captions:name==='captions'?f_.captions&&!f_.references:f_.references));}
  }

  /* -- following along in the PDF --
     The mark is an overlay in the page element, sized from the page's live viewport (zoom and rotation), and
     scrolled into view directly: reader.navigate() is kept for explicit jumps (a transcript line, a citation),
     because every navigate adds a Back entry, blinks for two seconds and centres the page. pdf.js empties a
     page when it re-renders (zoom, rotation), so the mark is put back on pagerendered / textlayerrendered. */
  function clearHighlight(session,{keepUnit=false}={}){
   for(const n of session.marks||[]){try{n.remove();}catch(_){}}session.marks=[];session.markedPage=null;
   if(!keepUnit)session.markedUnit=null;
  }
  function liveViewport(session,page,which='primary'){
   try{
    const app=waive(viewerWindow(session.reader,which)?.PDFViewerApplication),pv=app&&waive(app.pdfViewer),view=pv&&pv.getPageView&&waive(pv.getPageView(page-1));
    const v=view&&waive(view.viewport);if(!v||!(v.width>0))return null;
    return {width:Number(v.width),height:Number(v.height),transform:Array.from(v.transform||[]).map(Number)};
   }catch(_){return null;}
  }
  function drawMarks(session,unit){
   clearHighlight(session,{keepUnit:true});session.markedUnit=unit;
   const page=pageNumberOf(unit);if(!page)return false;
   const size=session.pageSizes&&session.pageSizes[page-1];
   if(!(size&&size.width>0&&size.height>0&&Array.isArray(unit.rects)&&unit.rects.length))return false;
   const doc=viewerDoc(session.reader),pageEl=doc&&doc.querySelector('.page[data-page-number="'+page+'"]');
   if(!pageEl)return false;
   for(const box of overlayBoxes(unit.rects.slice(0,12),size,liveViewport(session,page))){
    const mark=doc.createElementNS(HTML,'div');mark.setAttribute('data-sc-ra-hl','1');
    // Percentages of the page, so the box follows every zoom level until the next re-render redraws it.
    mark.style.cssText=`position:absolute;left:${box.left}%;top:${box.top}%;width:${box.width}%;height:${box.height}%;background:rgba(255,212,0,0.32);border-radius:3px;box-shadow:0 0 0 1px rgba(204,146,0,0.55);pointer-events:none;z-index:6;`;
    pageEl.appendChild(mark);session.marks.push(mark);
   }
   session.markedPage=page;
   return session.marks.length>0;
  }
  function highlight(session,unit){
   if(uiState().follow===false)return;
   drawMarks(session,unit);
   const first=session.marks[0];if(!first)return;
   // Scroll only when the sentence is not on screen.
   let visible=false;
   try{const win=viewerDoc(session.reader)?.defaultView,r=first.getBoundingClientRect();visible=r.height>0&&r.top>=48&&r.bottom<=win.innerHeight-48;}catch(_){}
   // The viewer document is content: the options go over as a content object, or pdf.js's page would jump to the top.
   if(!visible)try{first.scrollIntoView(toContent({block:'nearest',inline:'nearest'},viewerDoc(session.reader)?.defaultView));}catch(error){log(error);}
  }
  function redrawMarks(session){
   if(session.destroyed||!session.markedUnit||uiState().follow===false)return;
   if((session.marks||[]).length&&session.marks.every(m=>m.isConnected))return;
   drawMarks(session,session.markedUnit);
  }
  /* pdf.js's own events, through a function the content side may call. */
  function watchRendering(session){
   unwatchRendering(session);
   try{
    const vwin=viewerWindow(session.reader),bus=vwin&&vwin.PDFViewerApplication&&vwin.PDFViewerApplication.eventBus;
    if(!bus||typeof bus.on!=='function')return;
    const raw=coreOf(session.reader)?._primaryView?._iframeWindow;
    const fn=contentFunction(()=>{
     try{redrawMarks(session);}catch(error){log(error);}
     // The first page pdf.js paints is the first moment a deferred fit can be measured.
     try{if(session.open&&session.fitPending){session.fitPending=false;fitPage(session,true);}}catch(error){log(error);}
    },raw);
    for(const name of ['pagerendered','textlayerrendered'])bus.on(name,fn);
    session.renderWatch={bus,fn};
   }catch(error){log(error);}
  }
  function unwatchRendering(session){
   const w=session.renderWatch;session.renderWatch=null;if(!w)return;
   for(const name of ['pagerendered','textlayerrendered'])try{w.bus.off(name,w.fn);}catch(_){}
  }
  function credit(session,unit,seconds){
   if(session.destroyed||setting('readAloudCredit',true)===false||!(seconds>0))return;
   // The reading clock already counts a person who is touching the reader; this counts only the listening in between.
   /* The clock keeps counting for idleSeconds after the last touch (60 s by default); only the part of
      this sentence past that reach is listening the clock missed. With the clock off, all of it is. */
   // The clock also stops the moment Zotero loses focus (reading.js): listening from another app is all credit.
   const top=session.reader&&session.reader._window,focused=!(top&&top.document&&typeof top.document.hasFocus==='function')||top.document.hasFocus();
   if(setting('recordReading',true)!==false&&focused){
    const idle=Math.max(5,Number(setting('idleSeconds',60))||60)*1000,end=Date.now();
    seconds=Math.min(seconds,(end-((session.lastActivity||0)+idle))/1000);
    if(!(seconds>0))return;
   }
   const reader=session.reader,item=itemOf(reader);if(!item||typeof runtime.addReading!=='function')return;
   const page=pageNumberOf(unit),total=pageCount(reader);
   if(!page||!total||page>total)return;
   const location={attachmentID:reader.itemID,pageIndex:page-1,totalPages:total};
   Promise.resolve(runtime.addReading(item,seconds,location,location)).catch(log);
  }
  /* A start at a point of the page, in the extraction's page space. */
  function playAt(session,pageIndex,x,y){
   return structure(session).then(()=>{
    if(session.destroyed)return;
    const size=session.pageSizes&&session.pageSizes[pageIndex];if(!size||!(size.width>0))return;
    return startPlayback(session,p=>{const at=p.indexNear(pageIndex,x,y);if(at>=0)p.play(at);});
   }).catch(error=>say(session,describe(error),true));
  }
  /* Alt(Option)+double-click on the page starts reading there. A plain double-click is how people select a word, so it is left alone.
     The point goes through the view's live viewport, so a page the reader has turned still finds the sentence under the pointer. */
  function onDoubleClick(session,event,which='primary'){
   if(!session.open||!event||!event.altKey)return;
   try{
    const target=event.target,pageEl=target&&target.closest&&target.closest('.page[data-page-number]');if(!pageEl||!pageEl.getBoundingClientRect)return;
    const page=Number(pageEl.getAttribute('data-page-number')),rect=pageEl.getBoundingClientRect();
    if(!(rect.width>0&&rect.height>0))return;
    const fx=(event.clientX-rect.left)/rect.width,fy=(event.clientY-rect.top)/rect.height;
    const live=liveViewport(session,page,which);
    structure(session).then(()=>{
     const size=session.pageSizes&&session.pageSizes[page-1];if(!size||!(size.width>0))return;
     const at=pointToPage(fx,fy,live,size);if(!at)return;
     return playAt(session,page-1,at[0],at[1]);
    }).catch(error=>say(session,describe(error),true));
   }catch(error){log(error);}
  }
  /* "여기서부터 듣기" in the reader's text-selection popup. The selection's position is in PDF user space; the
     extraction's page space is that through the page's transform. */
  function selectionPopup({reader,doc,params,append}){
   if(stopped||!reader||reader.type!=='pdf'||typeof append!=='function')return;
   const position=params&&params.annotation&&params.annotation.position;
   if(!position||!Number.isInteger(position.pageIndex)||!position.rects||!position.rects.length)return;
   // Its own tab stop in the popup, as Zotero's "Add to note" is; the corners of the panel's buttons.
   const b=el(doc,'button',{type:'button','class':'sc-ra-selection-listen','data-opens':'audio','data-tabstop':'1',title:t(PLAY_TIP)});
   b.textContent=t('여기서부터 듣기');
   b.style.cssText=`display:block;width:100%;margin-top:4px;padding:4px 10px;border-radius:${BUTTON_RADIUS};text-align:center;color:var(--fill-primary);background:var(--material-button);box-shadow:0 .5px 2.5px rgba(0,0,0,.3),0 0 0 .5px rgba(0,0,0,.05);`;
   const r=Array.from(position.rects[0]).map(Number),pageIndex=position.pageIndex;
   /* "AI에게 묻기" beside it when text is selected: the passage goes to the chat with its page. */
   const selected=clean(params&&params.annotation&&params.annotation.text);
   let ask=null;
   if(selected){
    ask=el(doc,'button',{type:'button','class':'sc-ra-selection-ask','data-opens':'ai','data-tabstop':'1',title:t('선택한 부분을 AI에게 묻기')});
    ask.textContent=t('AI에게 묻기');ask.style.cssText=b.style.cssText;
    ask.addEventListener('click',()=>{
     const session=sessions.get(reader)||createSession(reader);if(!session)return;
     Promise.resolve(askPassage(session,selected,pageIndex+1)).catch(error=>say(session,describe(error),true));
    });
   }
   b.addEventListener('click',()=>{
    const session=sessions.get(reader)||createSession(reader);if(!session)return;
    structure(session).then(()=>{
     const size=session.pageSizes&&session.pageSizes[pageIndex];if(!size||!Array.isArray(size.transform))return;
     const [a,b_,c,d,e,f]=size.transform,x=(r[0]+r[2])/2,y=(r[1]+r[3])/2;
     return playAt(session,pageIndex,a*x+c*y+e,b_*x+d*y+f);
    }).catch(error=>say(session,describe(error),true));
   });
   if(ask)append(b,ask);else append(b);
  }

  /* ---- open, close, tabs ----------------------------------------------------
     The panel takes its own column: the reader's view containers (#split-view and the React .split-view) end
     where the panel begins, and pdf.js is told to fit again, so the paper is never under the panel. The width is
     the user's (dragged on the left edge, 280 px to half the reader), and the panel folds to a 52 px rail. */
  const docWidth=session=>{try{return Number(session.doc.documentElement.clientWidth)||Number(session.doc.defaultView.innerWidth)||0;}catch(_){return 0;}};
  const viewContainers=session=>{try{return [...session.doc.querySelectorAll('#split-view, .split-view')];}catch(_){return [];}};
  /* What the reader's own sidebar (annotations, thumbnails, outline) takes at the start of the split area: the view
     container begins after it. Our inset is at the other end, so this does not move as the panel opens. */
  function sidebarWidth(session){
   const total=docWidth(session),rtl=(()=>{try{return (session.doc.documentElement.getAttribute('dir')||'ltr')==='rtl';}catch(_){return false;}})();
   for(const node of viewContainers(session)){
    let r=null;try{r=node.getBoundingClientRect&&node.getBoundingClientRect();}catch(_){r=null;}
    if(!r||!(r.width>0||r.left>0||r.right>0))continue;
    const side=rtl?total-Number(r.right):Number(r.left);
    if(Number.isFinite(side))return Math.max(0,Math.min(total,side));
   }
   return 0;
  }
  /* The widest the panel may be: half the reader, and never so wide that the PDF gets less than MIN_PDF. */
  function maxPanelWidth(session){
   const total=docWidth(session);if(!(total>0))return Infinity;
   return Math.min(Math.floor(total*0.5),total-sidebarWidth(session)-MIN_PDF);
  }
  function panelWidth(session){
   const saved=Number(uiState().width)||WIDTH,max=maxPanelWidth(session);
   return Math.round(Math.min(Math.max(MIN_WIDTH,max),Math.max(MIN_WIDTH,saved)));
  }
  /* Folded: by the user, or by the window when even the narrowest panel would leave the PDF under MIN_PDF. The
     second is not remembered and undoes itself when the room comes back. */
  const isFolded=session=>!!(session.collapsed||session.autoFolded);
  const occupied=session=>!session.open?0:isFolded(session)?RAIL_WIDTH:panelWidth(session);
  /* Making the paper's own frame narrower, so the panel stands beside it instead of over it.
     inset-inline-end is what Zotero's context pane uses, and it only narrows a view that is positioned; a view
     laid out in flow ignores it and the paper stays under the panel, which is what the reader saw. So each way
     is applied and then measured, and the first one that really moves the view's right edge is kept for the
     session; the measurement runs again when the slide has settled, in case the first answer was the animation. */
  const PUSH_PROPS=['inset-inline-end','margin-inline-end','width','max-width'];
  const PUSH_WAYS=[
   {name:'inset',props:{'inset-inline-end':w=>w+'px'}},
   {name:'margin',props:{'margin-inline-end':w=>w+'px'}},
   {name:'width',props:{'width':w=>`calc(100% - ${w}px)`,'max-width':w=>`calc(100% - ${w}px)`}}
  ];
  function rememberLayout(session,node){
   if(!session.layoutOriginal)session.layoutOriginal=new Map();
   if(session.layoutOriginal.has(node))return;
   const saved={};
   for(const prop of PUSH_PROPS)saved[prop]={value:node.style.getPropertyValue(prop),priority:typeof node.style.getPropertyPriority==='function'?node.style.getPropertyPriority(prop):''};
   session.layoutOriginal.set(node,saved);
  }
  function restoreLayout(session,node,props){
   const saved=session.layoutOriginal&&session.layoutOriginal.get(node);if(!saved)return;
   for(const prop of props){const o=saved[prop];if(o&&o.value)node.style.setProperty(prop,o.value,o.priority);else node.style.removeProperty(prop);}
  }
  function applyWay(session,way,w){
   for(const node of viewContainers(session)){
    if(!node.style)continue;
    rememberLayout(session,node);
    restoreLayout(session,node,PUSH_PROPS.filter(prop=>!(prop in way.props)));
    for(const prop of Object.keys(way.props))node.style.setProperty(prop,way.props[prop](w),'important');
   }
  }
  /* Whether every view container now ends at or before the panel: true, false, or null when nothing in this
     document can be measured (a reader that has not been laid out yet), where the first way is kept. */
  function pushedAside(session,w){
   const total=docWidth(session);let seen=false;
   if(!(total>0))return null;
   for(const node of viewContainers(session)){
    const r=rectOf(node);if(!r||!(r.width>0))continue;
    seen=true;if(r.right>total-w+2)return false;
   }
   return seen?true:null;
  }
  /* The ways in the order to try: the one that worked for this session first. */
  const pushOrder=session=>{
   const at=session.pushWay?PUSH_WAYS.findIndex(way=>way.name===session.pushWay):-1;
   return at>0?[PUSH_WAYS[at],...PUSH_WAYS.filter((_,i)=>i!==at)]:PUSH_WAYS;
  };
  /* Narrow the view to leave w for the panel, trying each way until the measurement agrees. While the slide runs
     the measured edge is still on its way, so the transition is put on only after a way has been chosen. */
  function pushViews(session,w,{measure=true}={}){
   if(!(w>0)){
    for(const node of viewContainers(session))if(node.style)restoreLayout(session,node,PUSH_PROPS);
    session.layoutOriginal=null;session.pushedWidth=0;return true;
   }
   for(const node of viewContainers(session))if(node.style)try{node.style.removeProperty('transition');}catch(_){}
   let ok=false;
   for(const way of pushOrder(session)){
    applyWay(session,way,w);
    const told=measure?pushedAside(session,w):true;
    // Nothing to measure: the first way stays, and checkColumn looks again once the reader has been laid out.
    if(told===null){session.pushWay=session.pushWay||way.name;ok=true;break;}
    if(told){session.pushWay=way.name;ok=true;break;}
   }
   // None of them could be shown to work: keep the way Zotero's own context pane uses and let checkColumn look again.
   if(!ok){session.pushWay=null;applyWay(session,PUSH_WAYS[0],w);}
   session.pushedWidth=w;session.pushOK=ok;
   return ok;
  }
  function applyLayout(session,open){
   if(open!==undefined)session.open=!!open;
   session.autoFolded=!!(session.open&&!session.collapsed&&maxPanelWidth(session)<MIN_WIDTH);
   const w=occupied(session),root_=session.ui.root;
   // A self-check probe measures where the panel ends up, so it opens without the slide.
   const moving=session.appliedWidth!==undefined&&session.appliedWidth!==w&&(session.allowSlide||(!session.probing&&!probing))&&!reducedMotion(session);
   slidePanel(session,root_,moving);
   root_.setAttribute('data-collapsed',String(isFolded(session)));
   try{root_.style.setProperty('--sc-ra-w',(isFolded(session)?RAIL_WIDTH:panelWidth(session))+'px');}catch(_){}
   if(session.ui.railExpand)session.ui.railExpand.title=session.autoFolded?t('창이 좁아 접어 두었습니다. 창을 넓히면 다시 펼쳐집니다.'):t('패널 펼치기');
   pushViews(session,w);
   /* The way had to be chosen with no transition on, or the measurement would have read the animation instead of
      the result. Now that it is known, the edge is put back where it started and sent to its place again, this
      time with the transition: the paper's frame narrows as the panel slides in, like one door. */
   if(moving&&w>0){
    const way=PUSH_WAYS.find(x=>x.name===session.pushWay)||PUSH_WAYS[0];
    applyWay(session,way,0);
    for(const node of viewContainers(session))rectOf(node);                 // the reflow that makes 0 the start
    for(const node of viewContainers(session))if(node.style)try{node.style.setProperty('transition',SLIDE_PROPS);}catch(_){}
    applyWay(session,way,w);
   }else if(moving)for(const node of viewContainers(session))if(node.style)try{node.style.setProperty('transition',SLIDE_PROPS);}catch(_){}
   if(session.appliedWidth!==w){
    const was=session.appliedWidth||0;
    if(!was&&w>0&&!session.zoomAdjusted)noteZoom(session);
    session.fitPending=w>0;
    session.appliedWidth=w;refit(session);
    // Once the view has its new width: a page that fitted before is fitted again, and closing puts the zoom back.
    try{session.doc.defaultView.setTimeout(()=>{if(!session.destroyed)fitPage(session,w>0);},(moving?SLIDE_MS:0)+120);}catch(_){}
    // Again once the slide has ended and the view's edge is where it stays.
    if(moving){refit(session,SLIDE_MS+40);clearSlide(session);}
   }
   tabstops(session);
   // Measured once the slide (and Zotero's own resize after it) has settled.
   if(w>0)try{const win=session.doc.defaultView;if(session.columnTimer)win.clearTimeout(session.columnTimer);session.columnTimer=win.setTimeout(()=>{session.columnTimer=null;if(session.destroyed||!session.open)return;
    // Only after a width of ours changed: a zoom the reader set themselves while the panel stood still is theirs.
    if(session.fitPending){session.fitPending=false;fitPage(session,true);}
    checkColumn(session,occupied(session));},SLIDE_MS+600);}catch(_){}
  }
  /* A set zoom (a number, not page-width or auto, which pdf.js refits by itself) leaves the page as wide as it was:
     on a large screen it ran on under the narrowed view's edge and seemed not to move at all. When the page fitted
     the view before the panel opened and does not fit the narrower one, the zoom is brought down by as much as
     the view lost; closing the panel restores it, unless the reader changed it in the meantime. */
  function zoomState(session){
   try{
    const app=waive(viewerWindow(session.reader)?.PDFViewerApplication),pv=app&&waive(app.pdfViewer),c=pv&&waive(pv.container);
    if(!pv||!c)return null;
    const page=c.querySelector('.page');const width=page?page.getBoundingClientRect().width:0;
    return {pv,value:String(pv.currentScaleValue),scale:Number(pv.currentScale)||0,page:width,room:Number(c.clientWidth)||0};
   }catch(_){return null;}
  }
  const NAMED_ZOOM=/^(?:page-width|page-fit|auto|page-actual)$/;
  function noteZoom(session){
   const z=zoomState(session);
   session.zoomBefore=z&&!NAMED_ZOOM.test(z.value)?{value:z.value,scale:z.scale,fitted:z.page>0&&z.page<=z.room}:null;
  }
  /* The frame is narrower; the paper in it has to be too. A named zoom (page width, auto) is simply set again,
     which makes pdf.js lay the pages out for the width they now have. A fixed zoom is brought down by as much as
     the view lost, so the page that fitted the window still fits beside the panel. Closing puts the zoom back,
     unless the reader has changed it meanwhile. */
  function fitPage(session,open){
   const z=zoomState(session);
   // A reader restored into a window that is not on screen lays nothing out: fit it when pdf.js first paints.
   if(!z||!(z.room>0)||!(z.page>0)){if(open&&session.open)session.fitPending=true;return;}
   if(open){
    if(NAMED_ZOOM.test(z.value)){try{z.pv.currentScaleValue=z.value;}catch(error){log(error);}return;}
    if(!(z.page>z.room-1))return;
    const MARGIN=24,scale=Math.max(0.25,z.scale*(z.room-MARGIN)/z.page);
    if(Math.abs(scale-z.scale)<1e-3)return;
    // The zoom to come back to is the one from before the panel opened, or this one when that was never noted.
    const from=session.zoomAdjusted?session.zoomAdjusted.from:(session.zoomBefore&&session.zoomBefore.value)||z.value;
    try{z.pv.currentScale=scale;session.zoomAdjusted={from,to:scale};}catch(error){log(error);}
   }else{
    const a=session.zoomAdjusted;session.zoomAdjusted=null;session.zoomBefore=null;
    if(!a)return;
    if(Math.abs(z.scale-a.to)<1e-2)try{z.pv.currentScaleValue=a.from;}catch(error){log(error);}
   }
  }
  /* Opening and closing slide: the panel comes in from the right edge as the view's edge moves left with it,
     like a sliding door, and goes back the same way. Reduced motion: no slide. */
  const SLIDE_MS=240,SLIDE_EASE='cubic-bezier(.2,.8,.2,1)';
  const SLIDE_PROPS=`inset-inline-end ${SLIDE_MS}ms ${SLIDE_EASE}, margin-inline-end ${SLIDE_MS}ms ${SLIDE_EASE}, width ${SLIDE_MS}ms ${SLIDE_EASE}, max-width ${SLIDE_MS}ms ${SLIDE_EASE}`;
  // A window that cannot say (no matchMedia) gets no slide: it opens and closes at once.
  const reducedMotion=session=>{try{const w=session.doc.defaultView;return typeof w.matchMedia!=='function'||!!w.matchMedia('(prefers-reduced-motion: reduce)').matches;}catch(_){return true;}};
  function slidePanel(session,root_,moving){
   const win=session.doc.defaultView,rtl=(()=>{try{return (session.doc.documentElement.getAttribute('dir')||'ltr')==='rtl';}catch(_){return false;}})();
   const away=`translateX(${rtl?'-':''}100%)`;
   if(session.slideHide){try{win.clearTimeout(session.slideHide);}catch(_){}session.slideHide=null;}
   if(session.open){
    const wasHidden=root_.hidden;root_.hidden=false;
    if(moving&&wasHidden){
     root_.style.transition='none';root_.style.transform=away;
     void root_.getBoundingClientRect();
     root_.style.transition=`transform ${SLIDE_MS}ms ${SLIDE_EASE}`;root_.style.transform='';
    }
    else root_.style.transform='';
   }
   else if(moving&&!root_.hidden){
    root_.style.transition=`transform ${SLIDE_MS}ms ${SLIDE_EASE}`;root_.style.transform=away;
    session.slideHide=win.setTimeout(()=>{session.slideHide=null;if(!session.open){root_.hidden=true;root_.style.transform='';}},SLIDE_MS);
   }
   else{root_.hidden=true;root_.style.transform='';}
  }
  function clearSlide(session){
   const win=session.doc.defaultView;
   if(session.slideClear)try{win.clearTimeout(session.slideClear);}catch(_){}
   session.slideClear=win.setTimeout(()=>{session.slideClear=null;
    for(const node of viewContainers(session))try{node.style.removeProperty('transition');}catch(_){}
    try{session.ui.root.style.removeProperty('transition');}catch(_){}
   },SLIDE_MS+60);
  }
  /* The user saw the panel lying over the paper in a reader where the self-check found it beside it. When the
     view still reaches under the panel, what was found is left in a pref (readable without a window), once per
     change, for the next report. */
  /* One small file beside the self-check reports, rewritten (not appended) each time, holding the last layout
     measurement and the last voice list. Zotero's own file API is used: IOUtils is not a global in every window
     this runs in, and a write that quietly fails leaves nothing to look at. */
  const reportLines={};
  function writeReport(session,key,line){
   try{
    if(guard||session.probing)return;
    reportLines[key]=line;
    const text=Object.keys(reportLines).sort().map(k=>reportLines[k]).join('\n')+'\n';
    const where=Z.DataDirectory.dir+'/style-custom-reader-layout.txt';
    Promise.resolve(Z.File.putContentsAsync(where,text)).catch(error=>log(error));
   }catch(error){log(error);}
  }
  function checkColumn(session,w){
   try{
    const total=docWidth(session),nodes=viewContainers(session),view=session.doc.defaultView;
    const rows=nodes.map(node=>{const r=node.getBoundingClientRect(),cs=view.getComputedStyle(node);return `${node.id?'#'+node.id:'.'+String(node.className||'').split(/\s+/)[0]} right=${Math.round(r.right)} w=${Math.round(r.width)} pos=${cs.position} inset=${node.style.getPropertyValue('inset-inline-end')||'-'}/${cs.insetInlineEnd||cs.right} disp=${cs.display}`;});
    // The view's own iframe and its first visible page, in this document's coordinates, and pdf.js's zoom.
    let frame=null,pageNote='',scale='';
    try{const core=coreOf(session.reader),v=core&&waive(core._primaryView),fr=v&&v._iframe;if(fr){frame=fr.getBoundingClientRect();
     const app=waive(waive(fr.contentWindow).PDFViewerApplication),pv=app&&waive(app.pdfViewer),c=pv&&waive(pv.container);
     if(pv){scale=`${pv.currentScaleValue}`;const pg=c&&c.querySelector('.page');if(pg){const r=pg.getBoundingClientRect();pageNote=` page=${Math.round(frame.left+r.left)}..${Math.round(frame.left+r.right)} inner=${Math.round(c.clientWidth)} scroll=${Math.round(c.scrollLeft)}`;}}}}catch(_){}
    if(frame)rows.push(`iframe right=${Math.round(frame.right)} w=${Math.round(frame.width)} style.w=${(()=>{try{return waive(coreOf(session.reader)._primaryView)._iframe.style.width||'-';}catch(_){return '?';}})()} zoom=${scale}${pageNote}`);
    const under=!nodes.length||nodes.some(node=>{const r=node.getBoundingClientRect();return r.width>0&&r.right>total-w+2;})||!!(frame&&frame.width>0&&frame.right>total-w+2);
    const line=`${new Date().toISOString()} ${under?'UNDER':'beside'} total=${Math.round(total)} panel=${w} way=${session.pushWay||'none'} ${rows.join(' | ')||'no view container'}`;
    const key=line.replace(/^\S+ /,'');
    if(session.columnReport!==key){session.columnReport=key;Z.Prefs.set('extensions.style-custom.readerColumnLast',line,true);}
    // Written as a file too: a pref is only flushed now and then, and this is the one thing a reader reports.
    writeReport(session,'layout',line);
    /* Still under the panel after the slide: the way that was measured as working does not hold once Zotero has
       laid the reader out again. Try the next one and measure again. */
    if(under&&w>0&&!session.pushRetry){
     session.pushRetry=true;
     const tried=session.pushWay;
     session.pushWay=PUSH_WAYS[(Math.max(0,PUSH_WAYS.findIndex(way=>way.name===tried))+1)%PUSH_WAYS.length].name;
     for(const node of nodes)if(node.style)try{node.style.removeProperty('transition');}catch(_){}
     if(pushViews(session,w))refit(session,20);
     view.setTimeout(()=>{session.pushRetry=false;if(!session.destroyed&&session.open)checkColumn(session,occupied(session));},300);
    }else if(!under)session.pushRetry=false;
   }catch(_){}
  }
  /* pdf.js fits "page width" and "auto" again only when it hears a resize: say so to each view, after layout. */
  function refit(session,delay=0){
   const win=session.doc.defaultView;if(!win||!win.setTimeout)return;
   win.setTimeout(()=>{
    if(session.destroyed)return;
    const core=coreOf(session.reader);
    for(const view of [core&&core._primaryView,core&&core._secondaryView]){
     try{
      const w=view&&view._iframeWindow;if(!w)continue;
      /* Zotero 10 pins the view's iframe at a pixel width and re-measures it only from its own ResizeObserver;
         the paper stayed where it was and the panel cut it off. Its own resize sets the iframe to the container. */
      try{const v=waive(view);if(typeof v._resizeIframeImmediate==='function'&&v._iframe&&v._container&&Math.abs(v._iframe.getBoundingClientRect().width-v._container.clientWidth)>1)v._resizeIframeImmediate();}catch(error){log(error);}
      if(typeof w.dispatchEvent==='function'&&w.Event)w.dispatchEvent(new w.Event('resize'));
      const app=waive(waive(w).PDFViewerApplication),pv=app&&waive(app.pdfViewer);
      const scale=pv&&pv.currentScaleValue;
      if(typeof scale==='string'&&/^(?:page-width|page-fit|auto|page-actual)$/.test(scale))pv.currentScaleValue=scale;
     }catch(error){log(error);}
    }
   },delay);
  }
  function setCollapsed(session,collapsed,{remember=true}={}){
   session.collapsed=!!collapsed;applyLayout(session);
   if(!collapsed&&session.autoFolded)say(session,t('창이 좁아 접어 두었습니다. 창을 넓히면 다시 펼쳐집니다.'));
   if(remember&&!session.probing){uiState().collapsed=session.collapsed;persistUI();}
  }
  function wireResizer(session){
   const handle=session.ui.resizer,doc=session.doc;
   const setWidth=(w,save)=>{
    const max=maxPanelWidth(session);
    uiState().width=Math.round(Math.min(Math.max(MIN_WIDTH,max),Math.max(MIN_WIDTH,w)));
    handle.setAttribute('aria-valuenow',String(uiState().width));applyLayout(session);
    if(save)persistUI();
   };
   let drag=null;
   handle.addEventListener('pointerdown',event=>{
    if(event.button!==undefined&&event.button!==0)return;
    drag={x:event.clientX,width:panelWidth(session),pointer:event.pointerId};try{handle.setPointerCapture(event.pointerId);}catch(_){}
    event.preventDefault&&event.preventDefault();
   });
   handle.addEventListener('pointermove',event=>{if(!drag)return;const ltr=(doc.documentElement.getAttribute('dir')||'ltr')!=='rtl';setWidth(drag.width+(ltr?drag.x-event.clientX:event.clientX-drag.x),false);});
   // A drag ends on release, on a cancelled pointer, when the capture is lost (another window, a menu), when the
   // window loses focus, and when the panel goes: never a drag that keeps resizing on the next move.
   const end=()=>{if(!drag)return;const id=drag.pointer;drag=null;try{if(id!==undefined&&handle.hasPointerCapture&&handle.hasPointerCapture(id))handle.releasePointerCapture(id);}catch(_){}persistUI();};
   for(const name of ['pointerup','pointercancel','lostpointercapture'])handle.addEventListener(name,end);
   session.onBlur=end;on(session,doc.defaultView,'blur',session.onBlur);
   session.endDrag=end;
   handle.addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();setWidth(panelWidth(session)+(event.key==='ArrowLeft'?16:-16),true);}});
  }
  function setOpen(session,open,{remember=true}={}){
   session.open=!!open;
   if(session.open)paintTab(session,validTab(session.tab||uiState().tab));
   applyLayout(session);
   // The toolbar button may belong to a toolbar that was redrawn since: never let it stop the panel from opening.
   try{if(session.toolbarState)session.toolbarState.panel.setAttribute('aria-pressed',String(session.open));}catch(_){session.toolbarState=null;}
   if(remember&&!session.probing){uiState().open=session.open;persistUI();}
   if(session.open){showTab(session,validTab(session.tab||uiState().tab));ensureReady(session);ensureVoices(session);}
  }
  function paintTab(session,id){
   for(const[name,pane]of Object.entries(session.ui.panes))pane.hidden=name!==id;
   for(const[name,t_]of Object.entries(session.ui.tabs))t_.button.setAttribute('aria-selected',String(name===id));
   tabstops(session);
  }
  function showTab(session,id){
   id=validTab(id);session.tab=id;
   if(!session.probing){uiState().tab=id;persistUI();}
   paintTab(session,id);
   if(id==='translate')prepareTranslate(session);
   // The summary shown is the one for the settings now (another model or language may have been chosen meanwhile).
   if(id==='ask'&&session.loaded)renderSummary(session);
   if(id==='listen'){session.scrolledAt=0;markCurrent(session);}
  }
  async function ensureReady(session){
   if(session.ready||session.destroyed)return;
   session.ready=true;
   try{
    await loadData(session);
    if(session.destroyed)return;
    session.loaded=true;
    renderSummary(session);renderChat(session,{scroll:'bottom'});renderPlayer(session);renderTranscript(session);
    // Translations already made for this paper are shown without asking for anything.
    if(session.tab==='translate'&&session.open)prepareTranslate(session);
   }catch(error){log(error);}
  }

  /* ---- sessions per reader ------------------------------------------------- */
  const ACTIVITY=['pointermove','pointerdown','keydown','wheel'];
  /* Every listener on the reader's documents and window goes through on() and is removed by off() with the same
     function and the same capture flag. The capture flag is always a plain boolean: the viewer documents are reached
     through Zotero's waived _internalReader, so they are content, and a chrome options object such as
     {capture:true,passive:true} cannot be read there (it registered as capture=false, and removing it with
     capture=true left four activity listeners behind in the live check). Firefox already treats wheel listeners
     on a document as passive. */
  function on(session,target,type,fn,capture=false){
   if(!target||typeof fn!=='function')return;
   try{target.addEventListener(type,fn,!!capture);}catch(error){log(error);return;}
   (session.listening||(session.listening=[])).push({target,type,fn,capture:!!capture});
  }
  function off(session,target=null){
   session.listening=(session.listening||[]).filter(r=>{
    if(target&&r.target!==target)return true;
    try{r.target.removeEventListener(r.type,r.fn,r.capture);}catch(_){}
    return false;
   });
  }
  /* The viewer document is replaced when the reader reloads the file: listeners and the render watch follow it. */
  function attachViewer(session){
   const vdoc=viewerDoc(session.reader),second=viewerDoc(session.reader,'secondary');
   if(vdoc!==session.vdoc){
    detachPrimary(session);
    if(vdoc){
     session.onDbl=session.onDbl||(event=>onDoubleClick(session,event,'primary'));
     on(session,vdoc,'dblclick',session.onDbl,true);
     for(const name of ACTIVITY)on(session,vdoc,name,session.onActivity,true);
     if(session.onShortcut)on(session,vdoc,'keydown',session.onShortcut,true);
     session.vdoc=vdoc;session.marks=[];
     watchRendering(session);
    }
   }
   // The second pane of a split view takes the same gesture.
   if(second!==session.vdoc2){
    detachSecondary(session);
    if(second&&second!==vdoc){
     session.onDbl2=session.onDbl2||(event=>onDoubleClick(session,event,'secondary'));
     on(session,second,'dblclick',session.onDbl2,true);
     for(const name of ACTIVITY)on(session,second,name,session.onActivity,true);
     if(session.onShortcut)on(session,second,'keydown',session.onShortcut,true);
     session.vdoc2=second;
    }
   }
  }
  function detachPrimary(session){
   const vdoc=session.vdoc;session.vdoc=null;unwatchRendering(session);if(!vdoc)return;
   off(session,vdoc);
  }
  function detachSecondary(session){
   const vdoc=session.vdoc2;session.vdoc2=null;if(!vdoc)return;
   off(session,vdoc);
  }
  function detachViewer(session){detachPrimary(session);detachSecondary(session);}
  /* probe: a session the live self-check made for itself (never saves). quiet: made by a check on the user's reader;
     an ordinary session afterwards, but its first look at the cache touches no file time (probing until released). */
  function createSession(reader,{probe=false,quiet=false}={}){
   const doc=reader._iframeWindow&&reader._iframeWindow.document;if(!doc||!doc.documentElement)return null;
   const attachment=attachmentOf(reader);if(!attachment)return null;
   const session={probing:probe||quiet,noSave:probe,reader,doc,id:++sequence,name:attachment.libraryID+'-'+attachment.key,menus:new Set(),filters:{captions:false,references:false},tab:validTab(uiState().tab),open:false,collapsed:uiState().collapsed===true,destroyed:false,marks:[],data:{v:1,summary:{},chat:[],tr:{}},ready:false};
   buildPanel(session);
   (doc.body||doc.documentElement).appendChild(session.ui.root);
   stylesheet().then(css=>{if(session.destroyed||!css)return;const style=doc.createElementNS(HTML,'style');style.setAttribute('data-sc-ra-style','1');style.textContent=css;(doc.head||doc.documentElement).appendChild(style);session.style=style;});
   // Let the panel know the reader's pointer activity, so listening is credited only when the person is not already being counted.
   session.onActivity=()=>{session.lastActivity=Date.now();if(session.open&&session.tab==='translate')scheduleFollow(session);};
   for(const name of ACTIVITY)on(session,doc,name,session.onActivity,true);
   session.onShortcut=event=>onShortcut(session,event);
   on(session,doc,'keydown',session.onShortcut,true);
   attachViewer(session);
   // A window resize keeps the panel within half the reader.
   session.onResize=()=>{if(session.open)applyLayout(session);};
   on(session,doc.defaultView,'resize',session.onResize);
   session.say=(m,e)=>say(session,m,e);
   session.onProgress=()=>showReading(session);
   sessions.set(reader,session);
   ensureReady(session).then(()=>{
    if(session.destroyed||session.noSave)return;
    const want=uiState().open===true||(uiState().open===undefined&&setting('aiSummaryOnOpen',false)===true);
    if(want&&!session.open)setOpen(session,true,{remember:false});
   });
   return session;
  }
  function destroySession(session){
   if(session.destroyed)return;
   session.destroyed=true;sessions.delete(session.reader);
   try{session.player&&session.player.destroy();}catch(_){}
   for(const tok of [session.chatToken,session.summaryToken])try{tok&&tok.cancel();}catch(_){}
   try{session.tr&&session.tr.service.cancel();}catch(_){}
   if(session.followTimer)try{session.doc.defaultView.clearTimeout(session.followTimer);}catch(_){}session.followTimer=null;
   if(!session.noSave)try{saveNow(session);}catch(_){}
   clearHighlight(session);
   try{session.open=false;applyLayout(session);}catch(_){}
   try{session.ui.root.remove();}catch(_){}try{session.style&&session.style.remove();}catch(_){}
   try{session.endDrag&&session.endDrag();}catch(_){}
   detachViewer(session);
   off(session);          // everything else on the reader's document and window: click, keydown, activity, resize, blur
   try{if(session.saveTimer)session.doc.defaultView.clearTimeout(session.saveTimer);if(session.sayTimer)session.doc.defaultView.clearTimeout(session.sayTimer);}catch(_){}
   try{session.toolbarState=null;}catch(_){}
  }
  /* Started by a self-check (the pref is still set while this module is created): nothing runs by itself in that session. */
  const quietStart=(()=>{try{return !!(Z.Prefs&&Z.Prefs.get&&Z.Prefs.get('extensions.style-custom.selfCheck',true));}catch(_){return false;}})();
  /* Called by reader-tools every second with the PDF readers of one window and the selected tab. */
  function sync(win,readers,selectedTabID){
   if(stopped)return;
   const live=new Set(readers.filter(r=>r.type==='pdf'));
   for(const[reader,session]of [...sessions])if(reader._window===win&&!live.has(reader))destroySession(session);
   for(const reader of live){
    if(reserved.has(reader))continue;
    let session=sessions.get(reader);
    const doc=reader._iframeWindow&&reader._iframeWindow.document;
    if(session&&(session.doc!==doc||!session.ui.root.isConnected)){destroySession(session);session=null;}
    if(!session)session=createSession(reader);
    if(!session)continue;
    attachViewer(session);
    if(!session.renderWatch)watchRendering(session);   // pdf.js may not have been ready when the session began
    if(session.open)applyLayout(session);      // the reader may have re-rendered and dropped the column
    const shown=!selectedTabID||!reader.tabID||reader.tabID===selectedTabID;
    if(shown&&!session.autoChecked&&session.loaded&&!probing&&!quietStart){
      session.autoChecked=true;
      // The one thing that runs by itself, and only because the reader asked for it in the settings.
      if(setting('aiSummaryOnOpen',false)===true&&!summaryEntry(session)&&!session.data.autoSummary&&runtime.assist?.available?.()){
       session.data.autoSummary=true;saveSoon(session);runSummary(session,{auto:true});
      }
    }
   }
   pruneSoon();
  }
  /* The two toolbar buttons: the panel, and play/pause (which works with the panel closed or folded). */
  function mountToolbar({reader,doc,container}){
   if(stopped)return null;
   const state={};
   const panel=el(doc,'button',{type:'button','class':'toolbar-button sc-ra-toolbar','data-safe':'view',title:t('논문 도우미 (요약·대화·번역)'),'aria-label':t('논문 도우미 (요약·대화·번역)'),'aria-pressed':'false'},container);
   panel.appendChild(icon(doc,'panel'));
   const listen=el(doc,'button',{type:'button','class':'toolbar-button sc-ra-toolbar','data-opens':'audio',title:t('본문만 읽기')+' — '+playTip(),'aria-label':t('본문만 읽기')},container);
   listen.appendChild(icon(doc,'play'));
   state.panel=panel;state.listen=listen;
   const sessionOf=()=>sessions.get(reader)||createSession(reader);
   panel.addEventListener('click',()=>{const s=sessionOf();if(!s)return;s.toolbarState=state;setOpen(s,!s.open);});
   listen.addEventListener('click',async()=>{
    const s=sessionOf();if(!s)return;s.toolbarState=state;
    try{await togglePlay(s);}catch(error){log(error);if(!s.open)setOpen(s,true,{remember:false});say(s,describe(error),true);}
   });
   const s=sessions.get(reader);if(s){s.toolbarState=state;panel.setAttribute('aria-pressed',String(!!s.open));}
   return {remove(){panel.remove();listen.remove();const cur=sessions.get(reader);if(cur&&cur.toolbarState===state)cur.toolbarState=null;}};
  }
  function releaseWindow(win){for(const[reader,session]of [...sessions])if(reader._window===win)destroySession(session);}

  /* ---- the cache folder stays bounded ------------------------------------
     Extracted text for at most 200 papers or 100 MB in style-custom-reader/, least recently used first; the saved
     work per paper (.state) for up to 5,000 papers or 300 MB; both go when the item is gone. Once per run, a
     minute after the first reader is seen. */
  let pruneTimer=null,pruneWin=null,pruned=false;
  function pruneSoon(){
   if(stopped||pruned||pruneTimer!==null||quietStart)return;
   const win=[...sessions.values()][0]?.doc?.defaultView;if(!win||!win.setTimeout)return;
   pruneWin=win;
   pruneTimer=win.setTimeout(()=>{pruneTimer=null;pruneWin=null;if(stopped)return;pruned=true;pruneCache().catch(log);},60000);
  }
  function cancelPrune(){if(pruneTimer===null)return;try{pruneWin.clearTimeout(pruneTimer);}catch(_){}pruneTimer=null;pruneWin=null;}
  async function pruneCache({maxPapers=CACHE_PAPERS,maxBytes=CACHE_BYTES,maxStates=STATE_PAPERS,maxStateBytes=STATE_BYTES}={}){
   const fs=io(),dir=folder();if(!fs||!fs.getChildren)return {removed:0};
   let children;try{children=await fs.getChildren(dir);}catch(_){return {removed:0};}
   /* Two kinds of file per paper. The .struct is the extracted text: it can be made again, so it goes first, least
      recently used. The .state is the person's work (summary, conversation, translations, listening position): it
      stays until the item is gone, or until far more papers than any reading list hold one. */
   const kinds={struct:new Map(),state:new Map()};
   for(const file of children||[]){
    const m=/([^/\\]+?)\.(struct|state)\.json$/.exec(file);if(!m)continue;
    let st;try{st=await fs.stat(file);}catch(_){continue;}
    kinds[m[2]].set(m[1],{name:m[1],file,bytes:Number(st.size)||0,used:Number(st.lastModified||st.lastModifiedMs)||0});
   }
   const live=new Set([...sessions.values()].map(s=>s.name));
   const gone=name=>{const m=/^(\d+)-([A-Z0-9]{8})$/.exec(name);if(!m||live.has(name))return false;try{return Z.Items.getByLibraryAndKey(Number(m[1]),m[2])===false;}catch(_){return false;}};
   const drop=[];
   const bounded=(map,limit,bytesLimit)=>{
    const keep=[];for(const p of map.values())(gone(p.name)?drop:keep).push(p);
    // Open papers first (always kept), then the most recently used.
    keep.sort((a,b)=>(live.has(b.name)?1:0)-(live.has(a.name)?1:0)||b.used-a.used);
    let bytes=0,count=0;
    for(const p of keep){count++;bytes+=p.bytes;if(!live.has(p.name)&&(count>limit||bytes>bytesLimit))drop.push(p);}
   };
   bounded(kinds.struct,maxPapers,maxBytes);bounded(kinds.state,maxStates,maxStateBytes);
   for(const p of drop)try{await fs.remove(p.file);}catch(error){log(error);}
   return {removed:new Set(drop.map(p=>p.name)).size,files:drop.length};
  }

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
  /* Page 1 through the real pdf.js, read only (nothing is written to the cache): the check that extraction does not fall back. */
  async function probeExtraction(session){
   const out={fallback:true,rects:0,sentences:0,error:''};
   try{
    if(!root.StyleCustomPaperText){out.error='the extraction module is not loaded';return out;}
    const pdf=await pdfDocumentOf(session,{tries:20});if(!pdf){out.error='pdf.js has no document';return out;}
    const got=await readPage(session,pdf,1,{fonts:true});
    const structured=root.StyleCustomPaperText.structure({pages:[got.page],meta:{}});
    const units=(root.StyleCustomPaperText.readingOrder?root.StyleCustomPaperText.readingOrder(structured):[])||[];
    out.fallback=false;out.sentences=units.length;out.rects=units.filter(u=>Array.isArray(u.rects)&&u.rects.length).length;
   }catch(error){out.error=String(error&&error.message||error);}
   return out;
  }
  const rectOf=node=>{try{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};}catch(_){return null;}};
  /* Measure the panel on one reader without clicking anything: open it, visit each tab, read sizes, colours and
     overflow, check that the paper is beside the panel and not under it, put it back. While probing nothing is
     persisted, no translation is prepared and no summary starts by itself. */
  async function probe(reader){
   const result={reader:reader.itemID,problems:[],checked:0,tabs:{}};
   // A panel made for the probe reads the cache without touching any file's time (a read by a check is not a use).
   const session=sessions.get(reader)||createSession(reader,{quiet:true});if(!session){result.problems.push('no panel could be mounted');return result;}
   const win=session.doc.defaultView,wasOpen=session.open,wasTab=session.tab,wasCollapsed=session.collapsed;
   // Sound that was already playing is the user's, not the probe's: compare before with after.
   const audioBefore=audioOf(session);
   probing++;session.probing=true;
   try{
    await ensureReady(session);
    setOpen(session,true,{remember:false});session.collapsed=false;applyLayout(session);
    const unmarked=unmarkedButtons(session.ui.root);if(unmarked.length)result.problems.push('buttons without data-safe/data-opens/data-writes: '+unmarked.map(b=>clean(b.textContent||b.getAttribute('aria-label'))).join(' | '));
    await sleepIn(win,60);
    // The paper is beside the panel, never under it.
    const panelRect=rectOf(session.ui.root);
    for(const view of viewContainers(session)){
     const r=rectOf(view);if(!r||!panelRect||!(r.width>0))continue;
     if(r.right>panelRect.left+1)result.problems.push(`the PDF view (${view.id?'#'+view.id:'.'+view.className}) reaches ${Math.round(r.right)}px, under the panel that starts at ${Math.round(panelRect.left)}px`);
    }
    // Rows that must stay on one line inside their card.
    for(const sel of ['.sc-ra-seg','.sc-ra-tabs','.sc-ra-transport','.sc-ra-opts']){
     const node=session.ui.root.querySelector(sel),box=node&&rectOf(node);if(!box)continue;
     const card=node.closest('.sc-ra-card')||session.ui.root,cr=rectOf(card);
     for(const child of node.children){const r=rectOf(child);if(r&&r.width>0&&(r.right>box.right+1||(cr&&r.right>cr.right+1)))result.problems.push(`${sel}: "${clean(child.textContent||child.getAttribute('aria-label')).slice(0,20)}" overflows by ${Math.round(r.right-Math.min(box.right,cr?cr.right:box.right))}px`);}
     if(node.scrollWidth>node.clientWidth+1&&node.clientWidth>0)result.problems.push(`${sel} overflows (${node.scrollWidth}>${node.clientWidth})`);
    }
    for(const id of ['ask','translate','listen']){
     session.tab=id;paintTab(session,id);
     if(id==='translate')renderTranslate(session);
     await sleepIn(win,30);
     const rootRect=rectOf(session.ui.root);
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
      // An icon-only button: its stroke colour against its own background.
      if(node.tagName==='BUTTON'&&!own&&node.querySelector&&node.querySelector('svg')&&!node.disabled){
       const fg=rgb(style.color),bg=backdrop(win,node);
       if(fg){const eff=fg[3]<1?[0,1,2].map(i=>fg[i]*fg[3]+bg[i]*(1-fg[3])):fg;const ratio=contrastOf(eff,bg);if(ratio<3)found.push(`icon button "${clean(node.getAttribute('aria-label')).slice(0,20)}": contrast ${ratio.toFixed(2)}:1`);}
      }
      if(rootRect&&node!==session.ui.root&&node.getBoundingClientRect){
       const r=node.getBoundingClientRect();
       if(r.width>0&&r.right>rootRect.right+1&&!node.closest('.sc-ra-menu'))found.push(`${node.tagName.toLowerCase()}.${node.className||''} pokes out ${Math.round(r.right-rootRect.right)}px to the right`);
      }
      // A page link inside a sentence (.sc-ra-cite) is an inline target, sized by the line it sits in (WCAG 2.5.8 exempts it).
      if(node.tagName==='BUTTON'&&node.getBoundingClientRect&&!(node.classList&&node.classList.contains('sc-ra-cite'))){const r=node.getBoundingClientRect();if(r.width>0&&(r.height<22||r.width<22))found.push(`button "${clean(node.textContent||node.getAttribute('aria-label')).slice(0,20)}" is ${Math.round(r.width)}x${Math.round(r.height)}px`);}
      if(style.overflowX==='hidden'&&node.scrollWidth>node.clientWidth+1&&node.clientWidth>0&&!/sc-ra-(sentence|row-meta|pill-text|progress|tab-text|status)/.test(node.className||''))found.push(`${node.tagName.toLowerCase()}.${node.className||''} clips its text (${node.scrollWidth}>${node.clientWidth})`);
     }
     result.tabs[id]=found.length;result.problems.push(...found.map(x=>id+': '+x));
    }
    // The text of page 1 comes from pdf.js with positions, not from the plain-text fallback.
    result.extraction=await probeExtraction(session);
    if(result.extraction.fallback)result.problems.push('page 1 extraction fell back to plain text: '+(result.extraction.error||'unknown'));
    else if(result.extraction.sentences&&!result.extraction.rects)result.problems.push('page 1 extraction has no rectangles');
    const audioAfter=audioOf(session);result.player=audioAfter.player;result.audio={before:audioBefore,after:audioAfter};
    if(audioAfter.player==='playing'&&audioBefore.player!=='playing'||audioAfter.speaking&&!audioBefore.speaking)result.problems.push('the probe started audio');
   }finally{
    session.tab=wasTab;session.collapsed=wasCollapsed;setOpen(session,wasOpen,{remember:false});if(wasOpen)paintTab(session,validTab(wasTab));
    session.probing=false;probing--;
   }
   return result;
  }
  function audioOf(session){
   let speaking=false;try{const s=session.reader._iframeWindow&&session.reader._iframeWindow.speechSynthesis;speaking=!!(s&&s.speaking===true);}catch(_){}
   return {player:session.player?session.player.state().status:'idle',speaking};
  }
  async function probeAll(){
   const out=[];
   for(const reader of Z.Reader?._readers||[]){
    if(reader.type!=='pdf'||!reader._internalReader||!reader._iframeWindow||reader._iframeWindow.closed)continue;
    out.push(await probe(reader));
   }
   return out;
  }
  /* ---- the live reader self-check's handle ----------------------------------
     A handle on one reader for src/selfcheck-reader.js, which does the measuring. Everything here goes through the
     same functions the panel uses (readPage, extractWithPdfjs, overlayBoxes with the live viewport, setOpen,
     setCollapsed, selectionPopup), on a session in probe mode: nothing is persisted (no tab, width or open state,
     no .struct/.state file, no cache time touched), nothing is pressed, no summary starts by itself.
     fresh: the reader was opened by the check itself; any session sync() made for it is replaced by a probe session
     and release() destroys it (the leak check counts what is left). Otherwise the reader is the user's: release()
     only puts the panel back the way it was. */
  const OURS_IN_DOC='[data-sc-ra],[data-sc-ra-style],.sc-ra-selection-listen,.sc-ra-selection-ask',OURS_IN_VIEW='[data-sc-ra-hl]';
  const countIn=(doc,sel)=>{try{return doc?doc.querySelectorAll(sel).length:0;}catch(_){return 0;}};
  function diagnose(reader,{fresh=false}={}){
   if(stopped||!reader)return null;
   if(fresh){
    reserved.add(reader);
    const made=sessions.get(reader);if(made){made.noSave=true;destroySession(made);}
   }
   const doc=reader._iframeWindow&&reader._iframeWindow.document;
   const baseline={doc:countIn(doc,OURS_IN_DOC),view:countIn(viewerDoc(reader),OURS_IN_VIEW)};
   const existing=fresh?null:sessions.get(reader);
   // A user's reader without a panel yet gets the ordinary session sync() would have made; only the check's own is a probe session.
   const session=existing||createSession(reader,{probe:fresh,quiet:true});if(!session)return null;
   const was={open:session.open,tab:session.tab,collapsed:session.collapsed,probing:session.probing};
   session.probing=true;probing++;
   const vdoc=()=>viewerDoc(reader)||session.vdoc;
   let released=false,handlerRefs=null;
   const handlers=()=>handlerRefs||{doc:[session.onDocClick,session.onKey,session.onActivity,session.onShortcut].filter(Boolean),view:[session.onDbl,session.onActivity,session.onShortcut].filter(Boolean),win:[session.onResize].filter(Boolean),watch:session.renderWatch?session.renderWatch.fn:null};
   const handle={
    fresh,baseline,session,reader,doc:session.doc,
    get win(){return session.doc.defaultView;},
    viewerDoc:vdoc,
    viewerApp:()=>viewerWindow(reader)?.PDFViewerApplication||null,
    panel:()=>session.ui.root,
    viewContainers:()=>viewContainers(session),
    /* The panel as the reader meets it, after its saved state and its stylesheet are in. */
    async ready(){
     await ensureReady(session);await stylesheet();
     for(let i=0;i<40&&!session.style&&!session.destroyed;i++)await sleepIn(session.doc.defaultView,25);
     return !!session.style;
    },
    open(){setOpen(session,true,{remember:false});setCollapsed(session,false,{remember:false});},
    collapse(on=true){setCollapsed(session,on,{remember:false});},
    close(){setOpen(session,false,{remember:false});},
    /* The slide is off for a probe; the push check turns it on to measure what the reader sees. */
    slide(on){session.allowSlide=!!on;},
    showTab(id){session.tab=validTab(id);paintTab(session,session.tab);if(session.tab==='translate')renderTranslate(session);},
    /* Inline inset of each view container: the value and priority the panel must give back exactly. */
    layout:()=>viewContainers(session).map(node=>({id:node.id?'#'+node.id:'.'+String(node.className||'').split(/\s+/)[0],value:node.style?node.style.getPropertyValue('inset-inline-end'):'',priority:node.style&&typeof node.style.getPropertyPriority==='function'?node.style.getPropertyPriority('inset-inline-end'):''})),
    /* Pages through the panel's own reader of pdf.js, with timings and the fonts pdf.js named. */
    async readPages(numbers){
     const pdf=await pdfDocumentOf(session,{tries:40});if(!pdf)throw new Error('pdf.js has no document');
     const stats={fonts:0,named:0,pages:0},pages=[],sizes=[],ms=[];
     for(const n of numbers){if(n<1||n>pdf.numPages)continue;const t0=Date.now();const got=await readPage(session,pdf,n,{fonts:true,stats});ms.push(Date.now()-t0);pages.push(got.page);sizes[n-1]=got.size;}
     return {numPages:pdf.numPages,pages,sizes,ms,fonts:stats};
    },
    /* The whole document through the very function the panel uses (without its cache). */
    async extractAll(){const t0=Date.now();const got=await extractWithPdfjs(session);return got?{...got,ms:Date.now()-t0}:null;},
    structure(pages){const item=itemOf(reader);return paperText().structure({pages,meta:{title:fieldOf(item,'title'),abstract:fieldOf(item,'abstractNote')}});},
    units(structured,filters={captions:false,references:false}){return RA.composeUnits(structured,filters,paperText());},
    pageNumberOf,
    /* The follow-along mark's boxes for one sentence: what drawMarks() would put on the page, in percent of the page. */
    overlay(unit,sizes){
     const page=pageNumberOf(unit),size=page&&sizes&&sizes[page-1];
     if(!size||!Array.isArray(unit.rects)||!unit.rects.length)return {page,boxes:[]};
     return {page,boxes:overlayBoxes(unit.rects.slice(0,12),size,liveViewport(session,page))};
    },
    selectionPopup(params,append){return selectionPopup({reader,doc:session.doc,params,append});},
    readAloudState:()=>builtInState(reader),
    /* The AI round trip through the panel's own summary and chat code (runSummary, sendQuick, the Stop button), on
       the probe session: saveSoon() does nothing while probing, and restore() puts the session's summaries and
       conversation back as they were, so nothing made here outlives the check. The caller decides which AI calls
       may pass (selfcheck-reader.js keeps the guards on). */
    ai:(()=>{
     const saved={data:null};
     const keep=()=>{if(!saved.data)saved.data=JSON.stringify({summary:session.data.summary||{},chat:session.data.chat||[]});};
     const wait=ms=>sleepIn(session.doc.defaultView,ms);
     return {
      status:()=>{try{return runtime.assist&&typeof runtime.assist.status==='function'?runtime.assist.status():null;}catch(_){return null;}},
      refresh:async()=>{try{return runtime.assist&&typeof runtime.assist.refresh==='function'?await runtime.assist.refresh():null;}catch(_){return null;}},
      language:()=>aiSettings().language,
      pages:()=>pageCount(reader),
      /* One summary, exactly as the "요약 만들기" button makes it (force: an earlier one is not reused). firstMs: when
         the first streamed text reached the panel (null when the server sent it in one piece). */
      async summary({poll=20}={}){
       keep();await ensureReady(session);
       const t0=Date.now();let done=false,firstMs=null;
       const running=runSummary(session,{force:true});running.then(()=>{done=true;},()=>{done=true;});
       while(!done&&!session.destroyed&&firstMs===null){if(session.summaryDraft)firstMs=Date.now()-t0;else await wait(poll);}
       await running.catch(()=>{});
       const entry=summaryEntry(session);
       return {state:session.summaryState||'idle',error:session.summaryError||'',text:entry&&session.summaryState==='done'?String(entry.text||''):'',ms:Date.now()-t0,firstMs,truncated:!!(entry&&entry.truncated)};
      },
      /* One quick-prompt question, as its chip sends it. firstMs: when the first text reached the panel's answer.
         stopAfterFirst: the panel's Stop button is pressed as soon as that happens. */
      async ask(id,{stopAfterFirst=false,poll=20,settleMs=2000}={}){
       keep();await ensureReady(session);
       const t0=Date.now();
       const running=sendQuick(session,id);
       const answer=session.data.chat[session.data.chat.length-1];
       let done=false;running.then(()=>{done=true;},()=>{done=true;});
       const out={firstMs:null,ms:null,stopped:false,stopMs:null,endAfterStopMs:null,lengthAtStop:null,lengthAfter:null};
       while(!done&&!(answer&&answer.content)&&!session.destroyed)await wait(poll);
       if(answer&&answer.content)out.firstMs=Date.now()-t0;
       if(stopAfterFirst&&!done&&answer&&answer.content){
        out.lengthAtStop=answer.content.length;const at=Date.now();out.stopMs=at-t0;out.stopped=true;
        // The real button, as a press would reach it (it is a view-only control: data-safe="view").
        const stopButton=session.ui.stop;
        if(stopButton&&typeof stopButton.click==='function')stopButton.click();else if(session.chatToken)session.chatToken.cancel();
        await running.catch(()=>{});out.endAfterStopMs=Date.now()-at;
        await wait(settleMs);out.lengthAfter=answer.content.length;
       }else await running.catch(()=>{});
       out.ms=Date.now()-t0;
       out.content=answer?String(answer.content||''):'';out.error=answer?String(answer.error||''):'';
       out.busy=!!session.chatBusy;
       return out;
      },
      restore(){
       if(!saved.data)return;
       const back=JSON.parse(saved.data);saved.data=null;
       session.data.summary=back.summary;session.data.chat=back.chat;session.summaryState='idle';session.summaryError='';
       if(!session.destroyed&&session.ui){try{renderSummary(session);renderChat(session);}catch(error){log(error);}}
      }
     };
    })(),
    speech(){
     const win=reader._iframeWindow,s=win&&win.speechSynthesis;let voices=0;
     try{voices=s&&typeof s.getVoices==='function'?s.getVoices().length:0;}catch(_){}
     return {present:!!s,voices,speaking:!!(s&&s.speaking),pending:!!(s&&s.pending)};
    },
    player:()=>session.player?session.player.state():null,
    handlers,
    targets:()=>({doc:session.doc,view:vdoc(),win:session.doc.defaultView}),
    count:()=>({doc:countIn(session.doc,OURS_IN_DOC),view:countIn(vdoc(),OURS_IN_VIEW)}),
    alive:()=>sessions.get(reader)===session&&!session.destroyed,
    release(){
     if(released)return;released=true;
     handlerRefs=handlers();
     probing--;
     if(fresh){destroySession(session);return;}
     session.tab=was.tab;session.collapsed=was.collapsed;setOpen(session,was.open,{remember:false});if(was.open)paintTab(session,validTab(was.tab));
     session.probing=was.probing;
    }
   };
   return handle;
  }
  /* A reader the self-check opened stays out of sync() until it is closed (or the check lets it go). */
  function reserve(reader,on=true){if(!reader)return;if(on)reserved.add(reader);else reserved.delete(reader);}
  /* The live self-check's guard on side effects this module starts itself (the `say` process): fn(label) → true blocks. */
  function setGuard(fn){guard=typeof fn==='function'?fn:null;}
  function stop(){
   if(stopped)return;stopped=true;
   cancelPrune();
   for(const session of [...sessions.values()])destroySession(session);
   sessions.clear();
  }
  return Object.freeze({sync,mountToolbar,releaseWindow,selectionPopup,probe,probeAll,diagnose,reserve,setGuard,pruneCache,stop,sessions:()=>[...sessions.values()],owner});
 }
 return Object.freeze({create,renderMarkdown,unmarkedButtons,pressable,shortcutOf,KEY_HINTS,icon,ICONS,WIDTH,MIN_WIDTH,RAIL_WIDTH,MIN_PDF,BUTTON_RADIUS,viewportFor,overlayBoxes,pointToPage});
});

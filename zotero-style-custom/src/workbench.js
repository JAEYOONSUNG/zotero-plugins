/* User-opened, in-window research workspace. Never opens itself or another app. */
(function(root){
 'use strict';
 const HTML='http://www.w3.org/1999/xhtml',SVG='http://www.w3.org/2000/svg';
 /* The JCR catalog's own journals, indexed once by ISSN and by exact
    lower-cased title so a library venue can be matched without scanning
    every journal on every render. Only worth building for a catalog that is
    actually the official Clarivate JCR (jif/categoryMetrics populated); the
    shipped OpenAlex placeholder never fills those fields, so its journals
    would never match and the scan would be wasted. */
 const jcrCatalogIndex=new WeakMap();
 function jcrIndex(catalog){
  let entry=jcrCatalogIndex.get(catalog);
  if(entry)return entry;
  const byIssn=new Map(),byTitle=new Map();
  for(const journal of catalog.journals||[]){
   for(const raw of journal.issns||[]){
    const key=String(raw).replace(/[^0-9xX]/g,'').toUpperCase();
    if(key.length===8&&!byIssn.has(key))byIssn.set(key,journal);
   }
   const folded=String(journal.title||'').trim().toLowerCase();
   if(folded&&!byTitle.has(folded))byTitle.set(folded,journal);
  }
  entry={byIssn,byTitle};jcrCatalogIndex.set(catalog,entry);
  return entry;
 }
 // ISSNs first; an exact title is a last resort so two differently named
 // journals sharing an imprecise title are never merged into one standing.
 function jcrMatch(catalog,venue,issns){
  if(!catalog||!venue)return null;
  const {byIssn,byTitle}=jcrIndex(catalog);
  for(const raw of issns||[]){
   const key=String(raw||'').replace(/[^0-9xX]/g,'').toUpperCase();
   if(key.length===8&&byIssn.has(key))return byIssn.get(key);
  }
  return byTitle.get(String(venue).trim().toLowerCase())||null;
 }
 // The one category worth leading with: the best quartile, then, inside a
 // tie, the highest percentile -- Q1 8/140 says more than Q3 402/900 on the
 // same row, whichever order the categories happen to be captured in.
 function jcrBestStanding(journal){
  const rows=(journal.categoryMetrics||[]).filter(m=>m.quartile!=null||m.rank!=null);
  if(!rows.length)return null;
  return rows.slice().sort((a,b)=>(a.quartile??5)-(b.quartile??5)||(b.percentile??-1)-(a.percentile??-1))[0];
 }
 const TABS=[['explore','보유 문헌'],['recent','최근 문헌'],['related','관련 논문'],['authors','저자 추적'],['graph','관계 그래프'],['tags','중첩 태그'],['notes','노트'],['annotations','주석'],['backlinks','역링크'],['attachments','첨부 미리보기'],['reading','읽기 진행'],['tabs','탭 관리'],['views','뷰 그룹'],['canvas','캔버스'],['matrix','논문 비교'],['collections','컬렉션'],['journals','저널 지표'],['assist','번역·AI'],['appearance','스타일 편집']];
 const GROUPS=[['탐색',['explore','recent','related','authors','collections','journals']],['읽기',['reading','notes','annotations','attachments','backlinks']],['정리',['tags','graph','canvas','matrix']],['도구',['tabs','views','assist','appearance']]];
 const FILTER_TABS=new Set(['explore','recent','collections','journals','reading','notes','annotations','attachments','tags','graph']);
 // Windows whose workbench is open right now: a draft owned by one of them (other than this window) is live, not a leftover.
 const LIVE_DRAFT_WINDOWS=new Set();
 function attach(win,{runtime,library,reader,model,assist}){
  const doc=win.document;let pathAbort=null,freshAbort=null;let disposed=false,epoch=0,loadEpoch=0,previewEpoch=0,aiEpoch=0,preview=null,notifier=null,reloadTimer=null,draftTimer=null,jcrMount=null;
  // Every self-saving memo currently on screen, so an edit still inside its
  // one-second wait is written when the panel closes rather than lost.
  let memoFields=[];
  let observedContext=null;let draftContext='',draftCounters=new Map();const drafts=new Map(),visibleAnnotationIDs=new Set(),pageRanges=new Map(),openStrips=new Set(),readingFiles=new Map(),openAnnotGroups=new Set(),deletedCardSelections=new Map();
  // A45: annotations by page, per paper, shared between 쪽별 기록 (the marks
  // on the strip, and its own summary count) and 주석이 있는 쪽 -- whichever
  // fold loads first fills this in for the other, rather than each asking
  // Zotero for the same attachment's annotations separately. pageChosen is
  // which page's evidence a click last asked 쪽별 기록 to show under the strip.
  const pageAnnotations=new Map(),pageAnnotationLoads=new Map(),pageChosen=new Map();
  const ui=runtime.cache.workbenchUI&&typeof runtime.cache.workbenchUI==='object'?runtime.cache.workbenchUI:{};
  let returnFocus=null,commandFocus=null,commandIndex=0,commandMatches=[],navigationEpoch=0;const pendingActions=new Set();
  const state={tab:TABS.some(([id])=>id===ui.lastTab)?ui.lastTab:'explore',query:'',type:'',tag:'',status:'',ratingMin:'',yearFrom:'',yearTo:'',sort:'library',scope:'library',items:[],selected:new Set(),annotationIDs:new Set(),graphMode:'citations',boardID:null,cardIDs:new Set(),color:'',transpose:null,aiOutput:null,aiTask:null,aiItemID:null,libraryID:null,paletteID:null,focus:'',searchRecords:!!ui.searchRecords,rulesByTab:model.cleanRulesByTab?model.cleanRulesByTab(ui.filterRules):{}};
  /* Single-value filters saved before the rule builder become include rules on 보유 문헌. */
  if(ui.filters&&typeof ui.filters==='object'&&model.legacyRules){
   const moved=model.legacyRules(ui.filters),have=new Set((state.rulesByTab.explore||[]).map(r=>r.id));
   if(moved.length)state.rulesByTab={...state.rulesByTab,explore:[...(state.rulesByTab.explore||[]),...moved.filter(r=>!have.has(r.id))]};
   delete ui.filters;ui.filterRules=state.rulesByTab;runtime.cache.workbenchUI=ui;runtime.dirty=true;
  }
  // Only an explicit new choice enables OpenAlex. Old subject picks never
  // decide which taxonomy the journals tab opens with.
  state.graphKind=['library','collection','paper'].includes(ui.graphKind)?ui.graphKind:'library';state.graphPaper=ui.graphPaper?String(ui.graphPaper):null;state.graphCollection=ui.graphCollection?String(ui.graphCollection):null;state.graphSub=ui.graphSub!==false;state.graphDepth2=ui.graphDepth2===true;
  state.journalBrowser=ui.journalBrowser==='openalex'?'openalex':'jcr';
  state.jcrBrowserState=ui.jcrBrowserState&&typeof ui.jcrBrowserState==='object'?ui.jcrBrowserState:null;
  const enabled=id=>runtime.featureEnabled?.(id)!==false;
  const setting=(key,fallback)=>runtime.getSetting?runtime.getSetting(key):runtime.pref(key,fallback);
  const tabFeature={explore:'explore',recent:'Recent',graph:'graphView',tags:'tags',notes:'noteManager',annotations:'annotationManager',backlinks:'backlinks',attachments:'attachmentPreview',tabs:'tabManager',views:'viewManager',canvas:'canvas'};
  const actionFeature={'선택 주석 색상 변경':'annotationColors','선택 주석 색 바꾸기':'annotationColors','선택 주석 병합':'reader.mergeAnnotations','참조 노트 보기':'backlinks','참조 노트':'backlinks','밝은 PDF':'PDFStyles','어두운 PDF':'PDFStyles','세피아 PDF':'PDFStyles','사용자 PDF 테마 적용':'PDFStyles','주석 팔레트 적용':'annotationColors','주석 팔레트 삭제':'annotationColors','주석 팔레트 저장':'annotationColors','색상 이름 저장':'showAnnotationColorName','여백 주석 설정 적용':'marginAnnotation','관련 문헌으로 연결':'relatedItems','선택 문헌끼리 연결 해제':'relatedItems','선택 문헌에 태그 추가':'addTags','선택 문헌에서 태그 제거':'addTags','선택 문헌 태그 이름 변경':'addTags','초록 요약':'tldr','읽기 메모 제안':'AIGenerateRemark','태그 제안':'AIGenerateTags','앱 밝게/어둡게 전환':'darkLightButton'};
  /* Ordinary drafts are cut at DRAFT_LENGTH. A memo draft (it has an owner) is never cut: the reader's whole text is kept (up to MEMO_DRAFT_MAX, far beyond any memo). */
  const DRAFT_LIMIT=100,DRAFT_LENGTH=50000,DRAFT_TOTAL=500000,MEMO_TOTAL=20000000,MEMO_DRAFT_MAX=5000000;
  function cachedDrafts(){const saved=runtime.cache.workbenchDrafts;const map=new Map(saved?.version===1&&Array.isArray(saved.entries)?saved.entries.filter(entry=>Array.isArray(entry)&&entry.length===2&&typeof entry[0]==='string'&&entry[0].length<=1000&&!/password|secret|api.?key|access.?token|bearer/i.test(entry[0])&&typeof entry[1]==='string'&&entry[1].length<=MEMO_DRAFT_MAX).slice(-DRAFT_LIMIT):[]);trimDrafts(map);return map;}
  // Ordinary drafts and memo drafts (an owner sidecar marks them) are bounded separately: a memo draft is never evicted to make room for ordinary text.
  function trimDrafts(map,count=false){
   const isMemo=key=>key.includes('\u0001')||map.has(key+'\u0001own');
   const total=pred=>[...map].reduce((sum,[key,value])=>pred(key)?sum+value.length:sum,0);
   let ordinary=total(key=>!isMemo(key));
   for(const key of [...map.keys()]){if(ordinary<=DRAFT_TOTAL)break;if(!isMemo(key)){ordinary-=map.get(key).length;map.delete(key);}}
   let memo=total(isMemo);
   for(const key of [...map.keys()]){if(memo<=MEMO_TOTAL)break;if(isMemo(key)){memo-=map.get(key).length;map.delete(key);}}
   if(count)while(map.size>DRAFT_LIMIT){const key=[...map.keys()].find(k=>!isMemo(k))??map.keys().next().value;map.delete(key);}
  }
  for(const [key,value]of cachedDrafts())drafts.set(key,value);
  /* A memo draft remembers the stored memo the editor was loaded from (its base) under a second key: a draft restored
     later is only put back into an editor when that is still the stored memo; otherwise it waits as a conflict. */
  const DRAFT_BASE='\u0001base';
  /* Ownership of a shared memo draft: next to the text the cache keeps `owner|rev` (key+DRAFT_OWN). The owner is the id of the
     binding that wrote it (window id + binding id); rev counts the writes. Text equality never grants ownership. */
  const DRAFT_OWN='\u0001own';
  const WINDOW_ID=Math.random().toString(36).slice(2,10);let bindingSeq=0;LIVE_DRAFT_WINDOWS.add(WINDOW_ID);
  const DRAFT_TRUNC='\u0001trunc',DRAFT_BASETEXT='\u0001bt'; // bt: the stored memo a memo draft was typed over, as text
  // Bases are compared by hash (the stored base would otherwise be cut like the draft): length and a 32-bit FNV-1a.
  const hashOf=text=>{text=String(text);let h=2166136261;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619)>>>0;}return 'h'+text.length+'.'+h.toString(36);};
  // A base is stored only in the tagged form 'H1:'+hash; raw memo text is never compared with it, and a text that merely looks like a hash is just text.
  const BASE_TAG='H1:';
  const baseTag=text=>BASE_TAG+hashOf(text);
  const ownerWindow=owner=>String(owner).split('.')[0];
  /* Memo drafts are one record each in their own store (runtime.cache.memoDrafts, keyed by the editor's draft key), outside the
     generic draft list and its entry cap: {text, base (tagged hash), baseText, owner, rev, item, at}. Nothing is cut and nothing is
     dropped silently: a store over its caps moves the oldest drafts to the kept drafts of their paper first. */
  const MEMO_DRAFT_COUNT=400;
  // Reading never writes into the cache: the store is created by the first draft.
  function memoStore(forWrite=false){const m=runtime.cache.memoDrafts;if(m&&m.version===1&&m.drafts&&typeof m.drafts==='object'&&!Array.isArray(m.drafts))return m.drafts;return forWrite?(runtime.cache.memoDrafts={version:1,drafts:{}}).drafts:{};}
  const memoRecord=key=>{const r=memoStore()[key];return r&&typeof r.text==='string'?r:undefined;};
  const draftMeta=key=>{const r=memoRecord(key);return r?{owner:r.owner,rev:r.rev}:null;};
  // The text of a draft key: a memo draft's record, else an ordinary (or legacy plain) draft.
  const draftText=key=>{const r=memoRecord(key);return r?r.text:cachedDrafts().get(key);};
  // Earlier versions kept a memo draft as sidecar entries next to the text in the generic list: they become one record each.
  function migrateMemoDrafts(){
   const saved=runtime.cache.workbenchDrafts;if(!saved||saved.version!==1||!Array.isArray(saved.entries))return;
   const map=new Map(saved.entries.filter(e=>Array.isArray(e)&&e.length===2&&typeof e[0]==='string'&&typeof e[1]==='string'));
   const owners=[...map.keys()].filter(k=>k.endsWith(DRAFT_OWN));if(!owners.length)return;
   const store=memoStore(true);
   for(const ownKey of owners){
    const key=ownKey.slice(0,-DRAFT_OWN.length),raw=map.get(ownKey),cut=raw.lastIndexOf('|');
    // Nothing the old format knew is dropped: text, owner, revision, the tagged base, the base text, and the flag that the text was cut. A base that is not in the tagged form cannot be trusted and is left unknown.
    const oldBase=map.get(key+DRAFT_BASE);
    if(map.has(key)&&cut>0&&!store[key])store[key]={text:map.get(key),base:typeof oldBase==='string'&&oldBase.startsWith(BASE_TAG)?oldBase:undefined,baseText:map.get(key+DRAFT_BASETEXT),owner:raw.slice(0,cut),rev:Number(raw.slice(cut+1))||1,truncated:map.has(key+DRAFT_TRUNC)||undefined,item:undefined,at:Date.now()};
    for(const k of [key,key+DRAFT_BASE,key+DRAFT_OWN,key+DRAFT_TRUNC,key+DRAFT_BASETEXT])map.delete(k);
   }
   runtime.cache.workbenchDrafts={version:1,entries:[...map]};runtime.dirty=true;
  }
  function scheduleDraftFlush(){
   runtime.dirty=true;
   if(draftTimer)win.clearTimeout(draftTimer);
   draftTimer=win.setTimeout(()=>{draftTimer=null;Promise.resolve(runtime.flush()).catch(error=>runtime.Z.logError?.(error));},250);
  }
  migrateMemoDrafts();drafts.clear();for(const [key,value] of cachedDrafts())drafts.set(key,value);
  function putMemoDraft(key,value,base,owner,itemID){
   const store=memoStore(true),prev=store[key];
   const raw=typeof base==='string'?base:undefined,tagged=typeof base==='string'?baseTag(base):(base&&typeof base.tagged==='string'?base.tagged:undefined);
   store[key]={text:String(value),base:tagged,baseText:raw!==undefined?raw:(tagged!==undefined&&prev&&prev.base===tagged?prev.baseText:undefined),owner,rev:(prev?.rev||0)+1,item:itemID!==undefined?itemID:prev?.item,at:Date.now()};
   const saved=cachedDrafts();if(saved.has(key)){for(const k of [key,key+DRAFT_BASE,key+DRAFT_OWN,key+DRAFT_TRUNC,key+DRAFT_BASETEXT]){saved.delete(k);drafts.delete(k);}runtime.cache.workbenchDrafts={version:1,entries:[...saved]};}
   // Over a cap, the oldest drafts go to their paper's kept drafts first; one that cannot be kept stays.
   const keys=Object.keys(store);let total=keys.reduce((sum,k)=>sum+store[k].text.length,0);
   if(keys.length>MEMO_DRAFT_COUNT||total>MEMO_TOTAL){
    for(const k of keys.sort((x,y)=>(store[x].at||0)-(store[y].at||0))){
     if(Object.keys(store).length<=MEMO_DRAFT_COUNT&&total<=MEMO_TOTAL)break;
     if(k===key||store[k].item===undefined)continue;
     keepDraft(store[k].item,store[k].text,store[k].base,false,store[k].owner);total-=store[k].text.length;delete store[k];
    }
   }
   scheduleDraftFlush();
  }
  function updateDraft(key,value,base,owner,itemID){
   if(!key||key.length>1000||/password|secret|api.?key|access.?token|bearer/i.test(key))return;
   if(typeof owner==='string'&&value!==undefined)return putMemoDraft(key,value,base,owner,itemID);
   const store=memoStore();if(store[key])delete store[key];
   const saved=cachedDrafts();for(const k of [key,key+DRAFT_BASE,key+DRAFT_OWN,key+DRAFT_TRUNC,key+DRAFT_BASETEXT]){saved.delete(k);drafts.delete(k);}
   if(value!==undefined){value=String(value).slice(0,DRAFT_LENGTH);saved.set(key,value);drafts.set(key,value);}
   trimDrafts(saved,true);
   for(const existing of drafts.keys())if(!saved.has(existing))drafts.delete(existing);
   runtime.cache.workbenchDrafts={version:1,entries:[...saved]};
   scheduleDraftFlush();
  }
  const hiddenTabs=()=>new Set([...(Array.isArray(runtime.cache.hiddenWorkbenchTabs)?runtime.cache.hiddenWorkbenchTabs:[]).filter(id=>id!=='appearance'&&TABS.some(([key])=>key===id)),...Object.entries(tabFeature).filter(([,feature])=>!enabled(feature)).map(([id])=>id)]);
  const listeners=[];
  const i18n=runtime.i18n||{t:value=>value};
  const T=value=>i18n.t(value);
  // The attributes that carry text a person reads. Everything else is passed
  // through untouched: translating a class name or an id would be a bug.
  const TEXT_ATTRS=new Set(['title','placeholder','aria-label','tooltiptext','label','alt','value']);
  /* Titles arrive with the markup Zotero keeps in the field -- "<i>Bacillus
     subtilis</i>", "CO<sub>2</sub>" -- and used to show the tags as text.
     Six inline tags are drawn as what they mean; anything else stays
     literal, so a note with "<script>" in it prints "<script>". Attributes
     get the plain words. */
  const RICH=/<\/?(i|b|em|strong|sub|sup)>/i;
  const plain=value=>String(value).replace(/<\/?(i|b|em|strong|sub|sup)>/gi,'');
  function rich(parent,text){
   const parts=String(text).split(/(<\/?(?:i|b|em|strong|sub|sup)>)/i);
   const stack=[parent];
   for(const part of parts){
    if(!part)continue;
    const m=part.match(/^<(\/?)(i|b|em|strong|sub|sup)>$/i);
    if(!m){stack[stack.length-1].appendChild(doc.createTextNode(part));continue;}
    const tag=m[2].toLowerCase();
    if(m[1]){if(stack.length>1&&stack[stack.length-1].localName===tag)stack.pop();continue;}
    const el=doc.createElementNS(HTML,tag);stack[stack.length-1].appendChild(el);stack.push(el);
   }
  }
  const node=(tag,text,parent,attrs={})=>{const n=doc.createElementNS(HTML,tag);if(text!==null&&text!==undefined){const t=T(text);if(RICH.test(String(t)))rich(n,t);else n.textContent=t;}for(const[k,v]of Object.entries(attrs))n.setAttribute(k,TEXT_ATTRS.has(k)&&tag!=='input'?plain(T(v)):k==='placeholder'||k==='aria-label'||k==='title'?plain(T(v)):String(v));parent?.appendChild(n);if(draftContext&&['input','textarea'].includes(tag)&&attrs['aria-label']){const label=attrs['aria-label'],index=draftCounters.get(label)||0;draftCounters.set(label,index+1);n.dataset.draftKey=draftContext+'|'+label+'|'+index;}return n;};
  const panel=node('section',null,doc.documentElement,{id:'style-custom-workbench','aria-label':'Style Custom 연구 작업 패널'});panel.hidden=true;
  const sheet=node('link',null,doc.documentElement,{rel:'stylesheet',href:runtime.rootURI+'content/workbench.css'});
  const jcrSheet=node('link',null,doc.documentElement,{rel:'stylesheet',href:runtime.rootURI+'content/jcr-browser.css'});
  panel.dataset.density=ui.density==='compact'?'compact':'comfortable';panel.setAttribute('role','region');
  const head=node('header',null,panel,{class:'sc-header'}),brand=node('div',null,head,{class:'sc-brand'});node('img',null,brand,{src:runtime.rootURI+'content/icons/style-custom.svg',width:24,height:24,alt:'','aria-hidden':'true'});node('strong','Style Custom',brand);node('span','연구 작업 패널',brand,{class:'sc-subtitle'});const headerActions=node('div',null,head,{class:'sc-header-actions'});
  const status=node('div','준비',panel,{class:'sc-status',role:'status','aria-live':'polite'});
  function message(value,error=false){if(disposed)return;status.textContent=String(T(value));status.dataset.error=String(error);}
  /* An undo that outlives the redraw it follows: a small strip under the
     status line, kept eight seconds, one at a time. A second delete replaces
     the first strip (its undo is then gone, as the earlier one's time was up). */
  const toast=node('div',null,panel,{class:'sc-undo-toast',role:'status','data-role':'undo-toast'});toast.hidden=true;
  let toastTimer=null;
  // Letting an author go keeps a copy of the whole row for the undo strip.
  async function unfollow(person,after){
   const rows=runtime.watchedAuthors?.()||[],at=rows.findIndex(r=>r.id===person.id),row=at>=0?JSON.parse(JSON.stringify(rows[at])):null;
   await runtime.unwatchAuthor(person.id);
   if(row)undoToast(`${person.name||row.name}을(를) 관심 저자에서 뺐습니다.`,async()=>{
    if(typeof runtime.restoreWatchedAuthor==='function')await runtime.restoreWatchedAuthor(row,at);
    if(!disposed&&state.tab==='authors')await after?.();
    message(`${person.name||row.name}을(를) 다시 관심 저자로 넣었습니다.`);
   });
  }
  function dismissToast(){if(toastTimer){win.clearTimeout(toastTimer);toastTimer=null;}toast.hidden=true;toast.replaceChildren();}
  function undoToast(text,undo,ms=8000){
   if(disposed)return;dismissToast();
   node('span',text,toast,{class:'sc-undo-toast-text'});
   const b=node('button','되돌리기',toast,{type:'button',class:'sc-undo-toast-button','data-action':'undo'});
   b.addEventListener('click',()=>{if(b.disabled)return;b.disabled=true;run(async()=>{try{await undo();}finally{dismissToast();}});});
   toast.hidden=false;
   toastTimer=win.setTimeout(()=>{toastTimer=null;if(!disposed)dismissToast();},ms);
  }
  // The last three features shipped and then sat empty because they waited on a
  // context-menu item nobody had a reason to look for. Putting the new one in
  // the same place would repeat that, so the panel says what is missing, where
  // the user already is, and offers to fill it.
  const welcome=node('div',null,panel,{class:'sc-welcome',hidden:'hidden'});
  const notice=node('div',null,panel,{class:'sc-notice',hidden:'hidden'});
  /* Whether the row is open, remembered across sessions rather than reset to
     shown on every launch. noticeToggle is the small text button in the
     header that flips it and is created further down, once button() exists;
     refreshNotice only runs later, by which point it is there. */
  let noticeOpen=ui.noticeOpen===true;
  /* 프리프린트 -> 게재본: the one button for both rows and the 자료 점검 list.
     Not held yet: 게재본 가져와 연결 (imports, links, carries tags/status/memo);
     already held but not linked: 연결. The preprint is never removed. */
  function publishedButton(preprint,held,parent,done){
   const label=held?'연결':'게재본 가져와 연결';
   return button(label,()=>run(async()=>{
    message(held?'게재본을 연결하는 중…':'게재본을 가져오는 중…');
    const r=await runtime.connectPublished(preprint,{win});
    const title=String(r.item?.getField?.('title')||'').slice(0,60);
    message(r.imported?`게재본을 가져와 프리프린트와 연결했습니다 — ${title}`:r.linked?`이미 있던 게재본을 프리프린트와 연결했습니다 — ${title}`:'이미 연결되어 있습니다.');
    await done?.();
   }),parent,{class:'sc-published-connect',title:held?'보유한 게재본을 이 프리프린트의 관련 문헌으로 연결합니다 (아무것도 지우지 않음)':'게재본을 가져와 이 프리프린트와 연결하고 태그·읽기 상태·메모를 옮깁니다 (프리프린트는 그대로 둡니다)'});
  }
  async function refreshNotice(){
   if(disposed||typeof runtime.backfillPending!=='function'){noticeToggle.hidden=true;return;}
   let pending=null;
   // Counting means reading every item, and reading items is asynchronous in
   // Zotero; doing it synchronously is what broke every sweep in this plugin.
   try{pending=await runtime.backfillPending();}catch(error){return;}
   if(disposed)return;
   let unlinked=[];
   try{if(typeof runtime.unlinkedPublished==='function')unlinked=await runtime.unlinkedPublished();}catch(error){runtime.Z.logError?.(error);}
   if(disposed)return;
   const total=(pending?.signals||0)+(pending?.journals||0)+(pending?.authors||0)+(pending?.files||0)+unlinked.length;
   if(!total||runtime.backfilling){noticeToggle.hidden=true;notice.hidden=true;return;}
   // The header button says the count without opening anything; only a press opens the row itself.
   // Papers, journals and people do not add up: the button counts the kinds of gap, and names them on hover.
   const kinds=[pending.files&&T(`종류 미판별 첨부 ${pending.files}편`),pending.signals&&T(`철회 여부 미확인 ${pending.signals}편`),pending.journals&&T(`지표 없는 저널 ${pending.journals}종`),pending.authors&&T(`확인 안 한 관심 저자 ${pending.authors}명`),unlinked.length&&T(`게재본 연결 안 됨 ${unlinked.length}편`)].filter(Boolean);
   noticeToggle.hidden=false;noticeToggle.textContent=T(`자료 점검 ${kinds.length}가지`);noticeToggle.title=kinds.join(' · ');noticeToggle.setAttribute('aria-pressed',String(noticeOpen));
   if(!noticeOpen){notice.hidden=true;return;}
   notice.hidden=false;notice.replaceChildren();
   const parts=[];
   if(pending.files)parts.push(`종류 미판별 첨부 ${pending.files}편`);
   if(pending.signals)parts.push(`철회 여부 미확인 ${pending.signals}편`);
   if(pending.journals)parts.push(`지표 없는 저널 ${pending.journals}종`);
   if(pending.authors)parts.push(`확인 안 한 관심 저자 ${pending.authors}명`);
   if(unlinked.length)parts.push(`게재본 연결 안 됨 ${unlinked.length}편`);
   node('span',parts.join(' · '),notice,{class:'sc-notice-text'});
   const act=node('div',null,notice,{class:'sc-notice-actions'});
   if(pending.files||pending.signals||pending.journals||pending.authors)button('지금 채우기',()=>run(async()=>{
    notice.hidden=true;
    const report=await runtime.runBackfill({onProgress:({stage,done,total})=>
     message(`${({signals:'철회·공개접근 신호',journals:'저널 지표',authors:'관심 저자 새 논문'})[stage]||stage} 채우는 중 ${done+1}/${total}`)});
    if(disposed)return;
    message(runtime.backfillSummary(report),!!report.budgetGone);
    await refreshNotice();
   }),act);
   button('나중에',()=>{noticeOpen=false;notice.hidden=true;noticeToggle.setAttribute('aria-pressed','false');saveUI({noticeOpen});},act);
   // Preprints whose published version is known: five at a time, each with its one action.
   if(unlinked.length){
    const list=node('div',null,notice,{class:'sc-published-list'});
    for(const {item,published,held} of unlinked.slice(0,5)){
     const row=node('div',null,list,{class:'sc-published-row'});
     const title=String(item.getField?.('title')||T('제목 없음'));
     node('span',title,row,{class:'sc-published-title',title});
     node('span',[T('게재됨'),published.venue,published.year].filter(Boolean).join(' · '),row,{class:'sc-muted sc-published-venue'});
     publishedButton(item,held,row,()=>refreshNotice());
    }
    if(unlinked.length>5)node('span',T(`외 ${unlinked.length-5}편은 문헌 목록의 자세히에서 연결합니다`),list,{class:'sc-muted'});
   }
  }
  // A transport failure is not a sentence. The panel used to print the whole
  // OpenAlex URL with "failed with status code 429" on the end.
  const failures=root.CustomStyleFailures||{describe:error=>error?.message||String(error)};
  const readable=error=>failures.describe(error)||String(error?.message||error||'');
  async function run(fn){try{return await fn();}catch(error){if(!disposed)message(readable(error),true);return null;}}
  /* Every button whose handler writes to the library (items, notes, tags,
     collections, relations, the trash) is named here by its source label and
     carries data-writes. The self-check sweep skips by this attribute, so it
     holds in every language; a test scans the source for writers not listed. */
  let sweepJob=null;/* the running 모두 찾기, if any: {controller} */
  const WRITES_CACHE_HANDLER=/\b(saveUI|setSeen|setSeenMany|setReadingQueue|saveWatchOptions|importHere|save|setRulesFor|putQuick|dropQuick|switchBrowser)\(|runtime\.(dirty\s*=[^=]|flush\(|cache\.\w+(\.\w+|\[[^\]]*\])*\s*=[^=]|set[A-Z]\w*\()|\breader\.(apply|reset|set|save|select|close|move|restore|rename|update|delete|undelete)\w*\(|\bmodel\.(create|delete|restore|add|remove|link|unlink|rename|update|set)\w*\(/;
  const WRITES_LIBRARY_HANDLER=/library\.(setRemark|addTags|removeTags|restoreTags|noteFromAnnotations|createNote|unrelate|relate|trashItems|synthesisNote|saveToCollection|renameTagBranch|recolorAnnotations|mergeAnnotations|memoToNote)\(|runtime\.(importWork|trashAttachments|mergePreprintIntoPublished)\(/;
  const WRITES_LIBRARY=new Set(['만들고 담기','관련 문헌으로 연결','선택 문헌끼리 연결 해제','메모 저장','선택 문헌에 태그 추가','선택 문헌에서 태그 제거','선택 문헌 태그 이름 변경','새 노트 저장','이 문헌 주석에서 노트 만들기','휴지통으로','선택 주석 색 바꾸기','선택 주석을 노트로','선택 주석 병합','노트로 옮기기','게재본으로 옮기기','종합 노트 만들기','첫 문헌의 노트로 저장','선택 문헌에 적용']);
  /* A button the self-check may press: it only changes what is shown (in memory, or a remembered view choice) and writes no library, cache or setting data. Everything unmarked is left alone by the sweep. */
  const viewButton=(label,fn,parent,attrs={})=>button(label,fn,parent,{...attrs,'data-safe':'view'});
  const button=(label,fn,parent,attrs={})=>{
   if(WRITES_LIBRARY.has(label)&&!attrs['data-writes'])attrs={...attrs,'data-writes':'library'};
   /* Persistent plugin state (boards, cards, saved views, tab groups, the queue, filters, seen marks, settings) is written
      by a handler the sweep must not press either: the handler's own source says so, in any language and for a label
      built at run time. data-opens buttons keep their own contract. */
   if(!attrs['data-writes']&&!attrs['data-opens']&&!attrs['data-safe']&&typeof fn==='function'){let source='';try{source=Function.prototype.toString.call(fn);}catch(_){}if(WRITES_LIBRARY_HANDLER.test(source))attrs={...attrs,'data-writes':'library'};else if(WRITES_CACHE_HANDLER.test(source))attrs={...attrs,'data-writes':'cache'};}
   const b=node('button',label,parent,{type:'button',...attrs}),key=attrs['data-action-key'];
   const busy=(element,on)=>{element.disabled=on;if(on){element.dataset.busy='true';element.setAttribute('aria-busy','true');}else{delete element.dataset.busy;element.removeAttribute('aria-busy');}};
   if(actionFeature[label]&&!enabled(actionFeature[label])){b.hidden=true;b.disabled=true;}
   if(key&&pendingActions.has(key))busy(b,true);
   b.addEventListener('click',()=>{
    if(actionFeature[label]&&!enabled(actionFeature[label])||b.hidden||b.disabled||b.dataset.busy==='true'||key&&pendingActions.has(key))return;
    if(key)pendingActions.add(key);busy(b,true);
    run(fn).finally(()=>{if(key)pendingActions.delete(key);busy(b,false);if(!disposed){if(key)for(const current of panel.querySelectorAll('[data-action-key]'))if(current.dataset.actionKey===key)busy(current,false);updateSelectionUI();}});
   });return b;
  };
  function saveUI(patch){if(patch.density)runtime.Z.Prefs.set('extensions.style-custom.workbenchDensity',patch.density,true);runtime.cache.workbenchUI={...(runtime.cache.workbenchUI||{}),...patch};runtime.dirty=true;return runtime.flush();}
  /* 확인함: one store for 저자 추적's inbox and 새 논문. Kept for all libraries by
     normalised DOI, else OpenAlex work id (never by title), apart from the news
     and the answers themselves, which a later sweep replaces. Separate from the
     reading state: marking a paper seen never changes its status. */
  const seenWorkKey=work=>String(work.doi||'').toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//,'').trim()||String(work.id||'');
  // By work alone: the watchlist is global, so a paper marked seen in one library is seen in all of them.
  const seenKey=entry=>String(entry.key);
  /* Marks saved when the store was per library ("1:10.1/x") are folded into
     the bare key, the earlier mark date winning, the first time they are read. */
  const seenMemo={store:null};
  function seenAll(){
   const store=runtime.cache.workbenchUI?.inboxSeen||{};
   if(seenMemo.store===store)return store;
   let next=null;
   for(const k of Object.keys(store)){
    if(!/^\d*:/.test(k))continue;
    next||={...store};delete next[k];
    const bare=k.replace(/^\d*:/,'');
    if(!bare)continue;
    if(!next[bare]||String(store[k])<String(next[bare]))next[bare]=store[k];
   }
   if(next){runtime.cache.workbenchUI={...(runtime.cache.workbenchUI||{}),inboxSeen:next};runtime.dirty=true;}
   seenMemo.store=next||store;
   return next||store;
  }
  const isSeen=entry=>!!entry.key&&!!seenAll()[seenKey(entry)];
  function setSeen(entry,on){
   const next={...seenAll()};
   if(on)next[seenKey(entry)]=new Date().toISOString();else delete next[seenKey(entry)];
   // Oldest go first past a few thousand; a follow list turns over long before that.
   const keys=Object.keys(next);if(keys.length>3000)for(const k of keys.sort((x,y)=>String(next[x]).localeCompare(String(next[y]))).slice(0,keys.length-3000))delete next[k];
   return saveUI({inboxSeen:next});
  }
  // Many marks in one write (모두 확인함 and its undo), so one press is one save.
  // `evicted` collects the marks the 3,000 cap pushed out by this very write, and
  // `restore` (an earlier `evicted`) puts them back on undo, leaving every
  // change made since alone.
  function setSeenMany(keys,on,stamp=null,{evicted=null,restore=null}={}){
   const next={...seenAll()};
   for(const key of keys){if(on)next[key]=stamp?.[key]||new Date().toISOString();else delete next[key];}
   if(restore){const unmarked=new Set(keys);for(const [k,v] of Object.entries(restore))if(!(k in next)&&!unmarked.has(k))next[k]=v;}
   const all=Object.keys(next);if(all.length>3000)for(const k of all.sort((x,y)=>String(next[x]).localeCompare(String(next[y]))).slice(0,all.length-3000)){if(evicted)evicted[k]=next[k];delete next[k];}
   return saveUI({inboxSeen:next});
  }
  /* The two inboxes are worked through from the keyboard: inside the list,
     arrows or j/k walk the rows (each row's title, else its first button) and
     e marks the focused row 확인함 -- its own button does the marking and the
     refocus, so the shortcut cannot drift from the click. Typing in a field,
     or a modified key, is left alone. */
  const inboxKeys=box=>box.addEventListener('keydown',event=>{
   const target=event.target;
   if(event.ctrlKey||event.metaKey||event.altKey||/^(input|textarea|select)$/i.test(target?.localName||'')||target?.isContentEditable)return;
   const rows=[...box.children].filter(r=>r.querySelector?.('button'));
   const at=rows.findIndex(r=>r.contains(target));if(at<0)return;
   const key=event.key,step=key==='ArrowDown'||key==='j'?1:key==='ArrowUp'||key==='k'?-1:0;
   if(step){event.preventDefault();const row=rows[Math.min(rows.length-1,Math.max(0,at+step))];(row.querySelector('.sc-hit-title-link')||row.querySelector('button'))?.focus?.();}
   else if(key==='e'){const seen=rows[at].querySelector('.sc-inbox-seen');if(seen){event.preventDefault();seen.click();}}
  });
  const SVG_NS='http://www.w3.org/2000/svg';
  const ICONS={
   density:[['line',{x1:3,y1:5,x2:13,y2:5}],['line',{x1:3,y1:8,x2:13,y2:8}],['line',{x1:3,y1:11,x2:13,y2:11}]],
   matrixPrev:[['path',{d:'M9.8 3.5 5.3 8l4.5 4.5'}]],
   matrixNext:[['path',{d:'M6.2 3.5 10.7 8l-4.5 4.5'}]],
   like:[['path',{d:'M8 13.2 3.3 8.6a2.9 2.9 0 0 1 4.1-4.1L8 5.1l.6-.6a2.9 2.9 0 0 1 4.1 4.1z'}]],
   repost:[['path',{d:'M3 7V6a2 2 0 0 1 2-2h7.5M10.5 2l2 2-2 2M13 9v1a2 2 0 0 1-2 2H3.5M5.5 14l-2-2 2-2'}]],
   comment:[['path',{d:'M3 3.5h10v7H7.5L4.5 13v-2.5H3z'}]],
   search:[['circle',{cx:7.25,cy:7.25,r:4.25}],['line',{x1:10.5,y1:10.5,x2:13.5,y2:13.5}]],
   close:[['line',{x1:4,y1:4,x2:12,y2:12}],['line',{x1:12,y1:4,x2:4,y2:12}]],
   maximize:[['path',{d:'M9.5 3h3.5v3.5M13 3l-4 4M6.5 13H3V9.5M3 13l4-4'}]],
   tab:[['rect',{x:2.6,y:4.6,width:10.8,height:8.4,rx:1.2}],['path',{d:'M2.6 7.4h10.8M5.2 4.6V3h4.4v1.6'}]],
   window:[['rect',{x:2.8,y:3,width:10.4,height:10,rx:1.2}],['path',{d:'M2.8 6h10.4'}],['circle',{cx:4.6,cy:4.5,r:.5}]],
   restore:[['path',{d:'M13 7H9V3M9 7l4-4M3 9h4v4M7 9l-4 4'}]],
   // One drawn shape per tab. Nineteen identical lines of text is a list you
   // read; nineteen distinct silhouettes is a list you recognise, which is the
   // difference between finding a tab and scanning for it every time.
   filter:[['path',{d:'M2.5 4h11l-4.2 5v3.6l-2.6 1.2V9z'}]],
   explore:[['rect',{x:2.75,y:3,width:3,height:10,rx:.8}],['rect',{x:7.25,y:3,width:3,height:10,rx:.8}],
    ['path',{d:'M11.9 3.6l1.9.5-2.2 9.1-1.2-.3'}]],
   recent:[['circle',{cx:8,cy:8,r:5.25}],['path',{d:'M8 5.1V8l2.2 1.7'}]],
   related:[['circle',{cx:4.4,cy:11.4,r:2.1}],['circle',{cx:11.5,cy:4.6,r:2.1}],['line',{x1:6,y1:9.9,x2:10,y2:6.1}]],
   authors:[['circle',{cx:8,cy:5.6,r:2.5}],['path',{d:'M3.3 13.1c.7-2.5 2.5-3.8 4.7-3.8s4 1.3 4.7 3.8'}]],
   graph:[['circle',{cx:8,cy:3.6,r:1.7}],['circle',{cx:3.7,cy:11.8,r:1.7}],['circle',{cx:12.3,cy:11.8,r:1.7}],
    ['line',{x1:6.9,y1:5.1,x2:4.6,y2:10.2}],['line',{x1:9.1,y1:5.1,x2:11.4,y2:10.2}],['line',{x1:5.4,y1:11.8,x2:10.6,y2:11.8}]],
   tags:[['path',{d:'M8.4 2.6H13v4.6l-6 6a1.1 1.1 0 01-1.6 0L2.8 10.2a1.1 1.1 0 010-1.6z'}],
    ['circle',{cx:10.5,cy:5.1,r:.95}]],
   notes:[['path',{d:'M4 2.6h5.4L12.4 5.6v7.8H4z'}],['path',{d:'M9.2 2.7v3h3.1'}],
    ['line',{x1:6,y1:9,x2:10.4,y2:9}],['line',{x1:6,y1:11.2,x2:9,y2:11.2}]],
   annotations:[['rect',{x:2.6,y:9.6,width:10.8,height:2.6,rx:.9}],['path',{d:'M5.2 9.5l5.6-6 2.3 2.3-5.5 5.7'}]],
   backlinks:[['path',{d:'M13.2 11.6a4.2 4.2 0 00-4.2-4.2H3.5'}],['path',{d:'M6.2 4.6L3.2 7.4l3 2.8'}]],
   attachments:[['path',{d:'M11.5 7.2l-4.6 4.6a2.4 2.4 0 01-3.4-3.4l5.4-5.4a1.7 1.7 0 012.4 2.4l-5.2 5.2a.9.9 0 01-1.3-1.3l4.5-4.5'}]],
   reading:[['path',{d:'M8 4.8C6.7 3.7 5.1 3.2 3 3.2v8.6c2.1 0 3.7.5 5 1.6 1.3-1.1 2.9-1.6 5-1.6V3.2c-2.1 0-3.7.5-5 1.6z'}],
    ['line',{x1:8,y1:4.8,x2:8,y2:13.4}]],
   tabs:[['path',{d:'M2.6 12.6V6.2h4.1l1.3-1.8h5.4v8.2z'}],['path',{d:'M4.4 4.4h3.2'}]],
   views:[['rect',{x:2.8,y:2.8,width:4.6,height:4.6,rx:1}],['rect',{x:8.6,y:2.8,width:4.6,height:4.6,rx:1}],
    ['rect',{x:2.8,y:8.6,width:4.6,height:4.6,rx:1}],['rect',{x:8.6,y:8.6,width:4.6,height:4.6,rx:1}]],
   canvas:[['rect',{x:2.6,y:3.3,width:10.8,height:9.4,rx:1.4}],['circle',{cx:5.9,cy:6.6,r:1.1}],
    ['path',{d:'M3 11.6l3.1-3 2.2 2 2.1-2.4 2.6 3'}]],
   matrix:[['rect',{x:2.6,y:3.2,width:10.8,height:9.6,rx:1.2}],['line',{x1:8,y1:3.2,x2:8,y2:12.8}],
    ['line',{x1:2.6,y1:6.4,x2:13.4,y2:6.4}]],
   collections:[['path',{d:'M2.7 12.6V4.2h3.9l1.4 1.7h5.3v6.7z'}]],
   journals:[['line',{x1:4,y1:12.6,x2:4,y2:8.6}],['line',{x1:8,y1:12.6,x2:8,y2:5}],
    ['line',{x1:12,y1:12.6,x2:12,y2:10}],['line',{x1:2.4,y1:12.6,x2:13.6,y2:12.6}]],
   assist:[['path',{d:'M6 2.9l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z'}],
    ['path',{d:'M11.4 8.4l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z'}]],
   appearance:[['line',{x1:3,y1:5,x2:13,y2:5}],['line',{x1:3,y1:11,x2:13,y2:11}],
    ['circle',{cx:6.4,cy:5,r:1.6}],['circle',{cx:10,cy:11,r:1.6}]]
  };
  function svgShape(parent,tag,attrs){
   const shape=doc.createElementNS(SVG_NS,tag);
   for(const [name,value] of Object.entries(attrs))shape.setAttribute(name,String(value));
   parent.appendChild(shape);
   return shape;
  }
  // A brand mark, drawn node by node because innerHTML does not exist on
  // createElementNS elements in Gecko. Fill marks come from Academicons and
  // carry their own viewBox; stroke marks are this plugin's own glyphs.
  const brands=root.CustomStyleBrandIcons||null;
  function brandIcon(source,{size=14,title=''}={}){
   const name=brands?brands.iconFor(source):'';
   const drawn=name?brands.shape(name):null;
   if(!drawn)return null;
   const svg=doc.createElementNS(SVG,'svg');
   svg.setAttribute('viewBox',drawn.viewBox);
   svg.setAttribute('width',String(size));svg.setAttribute('height',String(size));
   svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');
   if(drawn.kind==='fill'){svg.setAttribute('fill','currentColor');}
   else{svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');
    svg.setAttribute('stroke-width','1.5');svg.setAttribute('stroke-linecap','round');
    svg.setAttribute('stroke-linejoin','round');}
   for(const [tag,attrs] of drawn.parts)svgShape(svg,tag,attrs);
   if(title)svg.setAttribute('aria-label',title);
   return svg;
  }
  // The mark plus the name, because a logo alone is a quiz for anyone who has
  // not memorised nine academic brands.
  function sourceChip(source,label,parent){
   const chip=node('span',null,parent,{class:'sc-source'});
   const mark=brandIcon(source,{title:label||source});
   if(mark)chip.appendChild(mark);
   node('span',label||source,chip,{class:'sc-source-name'});
   chip.title=label||source;
   return chip;
  }
  // Initials are what stands in for a face until one is found, and what stands
  // in permanently for someone who has no public portrait.
  function initials(name){
   /* A generational suffix is not a surname: "Michael B. Elowitz II" is ME, not MI. */
   const all=String(name||'').trim().split(/\s+/).filter(Boolean);
   const parts=all.filter((word,index)=>index===0||!/^(jr|sr|ii|iii|iv|v)\.?,?$/i.test(word));
   if(!parts.length)return '?';
   const first=parts[0][0]||'';
   const last=parts.length>1?parts[parts.length-1][0]:'';
   return (first+last).toUpperCase();
  }
  // A found photograph over the initials; the initials stay if it fails to load.
  function showFace(face,found,alt=''){
   if(disposed||!face||!found?.url)return;
   const img=doc.createElementNS(HTML,'img');
   img.src=found.url;img.alt=alt;if(!alt)img.setAttribute('aria-hidden','true');
   img.loading='lazy';img.decoding='async';img.width=28;img.height=28;
   img.addEventListener('error',()=>img.remove());
   img.addEventListener('load',()=>{face.dataset.hasPhoto='true';});
   face.appendChild(img);
   face.title=found.page?`사진 출처: ${found.page}`:'';
  }
  /* Country names for a tooltip, from the platform's own list when it has one. */
  function countryLabel(code){
   try{return new Intl.DisplayNames(['ko'],{type:'region'}).of(code)||code;}catch(error){return code;}
  }
  /* A followed author's round face: the photo the plugin already holds
     (never fetched for the sake of drawing), the initials otherwise. */
  function watchFace(person,parent){
   const face=node('span',null,parent,{class:'sc-face sc-watch-face'});
   if(!runtime.portraitOf?.(person.id))face.setAttribute('aria-hidden','true');
   node('span',initials(person.name),face,{class:'sc-face-text'});
   showFace(face,runtime.portraitOf?.(person.id),person.name);
   return face;
  }
  /* A journal's name in its own signature ink, the one treatment shared by the
     library cards and the inbox: the full name once, never beside a badge that
     spells the same journal again. Both themes' inks travel with it. */
  function inkJournal(element,venue){
   const J=runtime.journalIdentity,known=J?.identify?.(String(venue||'').trim());
   if(known&&typeof J.colours==='function'){const light=J.colours(known,{dark:false})||{},dark=J.colours(known,{dark:true})||{};if(light.ink&&dark.ink){element.style.setProperty('--j-ink-l',light.ink);element.style.setProperty('--j-ink-d',dark.ink);element.dataset.known='1';element.classList.add('sc-ink');}}
   return element;
  }
  function venueSpan(parent,venue){
   return inkJournal(node('span',venue,parent,{class:'sc-paper-venue'}),venue);
  }
  /* A preprint server as a reader names it: OpenAlex spells bioRxiv out as
     "bioRxiv (Cold Spring Harbor Laboratory)", a repository's collection after
     a middle dot. */
  const PREPRINT_SERVERS=[[/biorxiv/i,'bioRxiv'],[/medrxiv/i,'medRxiv'],[/chemrxiv/i,'ChemRxiv'],[/psyarxiv/i,'PsyArXiv'],[/arxiv/i,'arXiv'],[/research\s*square/i,'Research Square'],[/\bssrn\b/i,'SSRN'],[/preprints\.org/i,'Preprints.org'],[/osf\s*preprints/i,'OSF Preprints']];
  function serverName(venue){
   const text=String(venue||'').trim();
   for(const [pattern,name] of PREPRINT_SERVERS)if(pattern.test(text))return name;
   return text.replace(/\s*[(·|:].*$/,'').trim()||text;
  }
  const isPreprintWork=work=>!!(work.preprint||/preprint/i.test(String(work.type||''))||/rxiv|research square|\bssrn\b/i.test(String(work.venue||'')));
  /* Tier, flag and institution, as the items tree's 소속 column reads. T1 and T2
     are drawn firm, T3 and T4 quiet; what is not known is left out rather than guessed. */
  function placeLine(person,parent){
   const where=runtime.placeOf?.(person.institution)||null;
   const wrap=node('span',null,parent,{class:'sc-place'});
   if(where?.tier?.label)node('span',where.tier.label,wrap,{class:'sc-tier sc-tier-'+where.tier.key,title:where.tier.note});
   if(where?.flag)node('span',where.flag,wrap,{class:'sc-flag','aria-hidden':'true'});
   const name=person.institution?String(person.institution).replace(/\s*\([^)]+\)\s*$/,where?.flag?'':'$&').trim()||person.institution:'';
   node('span',name||'소속 미상',wrap,{class:'sc-place-name'+(name?'':' sc-none')});
   const notes=[person.institution||'소속 미상'];
   if(where?.country)notes.push(countryLabel(where.country));
   if(where?.hIndex)notes.push(`기관 h-index ${where.hIndex}`);
   wrap.title=notes.join(' · ');
   return wrap;
  }
  async function paintPortrait(face,person){
   if(!runtime.fetchPortrait||!person?.id)return;
   if(runtime.pref?.('authorPortraits',true)===false)return;
   const known=runtime.portraitOf?.(person.id);
   const draw=found=>{if(face.isConnected)showFace(face,found);};
   if(known){draw(known);return;}
   try{draw(await runtime.fetchPortrait(person));}catch(error){runtime.Z.logError?.(error);}
  }
  function setIcon(element,name){
   element.textContent='';
   const svg=doc.createElementNS(SVG_NS,'svg');
   svg.setAttribute('viewBox','0 0 16 16');
   svg.setAttribute('width','16');svg.setAttribute('height','16');
   svg.setAttribute('fill','none');svg.setAttribute('aria-hidden','true');
   svg.setAttribute('stroke','currentColor');
   svg.setAttribute('stroke-width','1.5');
   svg.setAttribute('stroke-linecap','round');
   for(const [tag,attrs] of ICONS[name])svgShape(svg,tag,attrs);
   element.appendChild(svg);
   return element;
  }
  // 자료 점검: a small neutral text button, not a row that sat under every
  // tab whether or not anyone was looking at it. It only says the count;
  // opening the row itself is a separate press, remembered afterwards. It
  // sits beside the window chrome but is not one of those icon buttons, so
  // it is a sibling in the header rather than another child of that group.
  const noticeToggle=button('',()=>{noticeOpen=!noticeOpen;saveUI({noticeOpen});refreshNotice().catch(error=>runtime.Z?.logError?.(error));},head,{class:'sc-notice-toggle','aria-pressed':String(noticeOpen)});
  noticeToggle.hidden=true;
  head.insertBefore(noticeToggle,headerActions);
  const density=button('',()=>{panel.dataset.density=panel.dataset.density==='compact'?'comfortable':'compact';syncDensity();return saveUI({density:panel.dataset.density});},headerActions,{'aria-label':'화면 밀도 전환',class:'sc-icon-button'});
  setIcon(density,'density');density.title=T('화면 밀도 전환');
  function syncDensity(){const compact=panel.dataset.density==='compact';density.title=T(compact?'간격 넓게':'간격 좁게');density.setAttribute('aria-pressed',String(compact));}syncDensity();
  /* The panel floats over the window at a size the user dragged out; on a
     laptop that leaves the list in a letterbox. One press fills the window
     edge to edge, the next puts it back where it was, and the choice is
     remembered. Double-clicking the title bar does the same, as windows do. */
  /* The panel can live in a Zotero tab instead of floating over the
     window: the same element, moved into the tab's container, with the
     tab bar as its handle. The user asked for this from the start; it needs
     only Zotero_Tabs.add, which the main window has and the tests mock.
     Closing the tab hides the panel; opening the panel again selects the
     tab; the choice is remembered, so the next open goes straight to a tab. */
  let tabID=null,closingSelf=false;
  const canDock=()=>!!(win.Zotero_Tabs&&typeof win.Zotero_Tabs.add==='function');
  function moveBack(){if(panel.parentNode!==doc.documentElement)doc.documentElement.appendChild(panel);delete panel.dataset.docked;syncDock();}
  let dockError='';
  function dock({save=true}={}){
   dockError='';
   if(tabID)return true;
   if(!canDock()){dockError='no tab bar';return false;}
   let added;
   try{added=win.Zotero_Tabs.add({type:'style-custom-workbench',title:T('연구 작업 패널'),data:{icon:'journalArticle'},select:true,
    onClose:()=>{tabID=null;moveBack();if(!closingSelf&&!panel.hidden)toggle(false);}});}
   catch(error){dockError=String(error?.message||error);runtime.Z.logError?.(error);return false;}
   if(!added||!added.container){dockError='Zotero_Tabs.add returned no container';return false;}
   tabID=added.id;
   added.container.appendChild(panel);
   panel.dataset.docked='tab';
   panel.hidden=false;
   syncDock();
   if(save)saveUI({docked:true});
   return true;
  }
  function undock({save=true}={}){
   if(!tabID)return;
   const id=tabID;tabID=null;closingSelf=true;
   moveBack();
   try{win.Zotero_Tabs.close(id);}catch(error){runtime.Z.logError?.(error);}
   closingSelf=false;
   if(save)saveUI({docked:false});
  }
  const dockButton=button('',()=>{if(tabID)undock();else if(!dock())message('이 창에서는 탭을 열 수 없습니다.',true);},headerActions,{'aria-label':'탭으로 열기 / 창으로 띄우기',title:T('탭으로 열기'),class:'sc-icon-button sc-dock','aria-pressed':'false'});
  function syncDock(){const docked=!!tabID;dockButton.setAttribute('aria-pressed',String(docked));dockButton.title=T(docked?'창으로 띄우기':'탭으로 열기');dockButton.replaceChildren();setIcon(dockButton,docked?'window':'tab');dockButton.hidden=!canDock();}
  syncDock();
  const maximize=button('',()=>setMaximized(panel.dataset.maximized!=='true'),headerActions,{'aria-label':'전체 화면 전환',title:T('전체 화면'),class:'sc-icon-button sc-maximize','aria-pressed':'false'});
  function setMaximized(on,{save=true}={}){
   panel.dataset.maximized=String(!!on);
   maximize.setAttribute('aria-pressed',String(!!on));
   maximize.title=T(on?'원래 크기로':'전체 화면');
   maximize.replaceChildren();setIcon(maximize,on?'restore':'maximize');
   return save?saveUI({maximized:!!on}):undefined;
  }
  setMaximized(ui.maximized===true,{save:false});
  brand.addEventListener('dblclick',()=>setMaximized(panel.dataset.maximized!=='true'));
  setIcon(button('',()=>openCommands(),headerActions,{'aria-keyshortcuts':'Meta+K Control+K','aria-label':'기능 찾기',title:'기능 찾기 · ⌘/Ctrl K',class:'sc-icon-button'}),'search');
  setIcon(button('',()=>toggle(false),headerActions,{'aria-label':'작업 패널 닫기',title:'닫기',class:'sc-icon-button sc-close'}),'close');
  const controls=node('div',null,panel,{class:'sc-controls sc-search-row'});
  const search=node('input',null,controls,{type:'search',placeholder:'제목·저자·태그·DOI·초록 검색','aria-label':'작업 패널 검색'});
  /* Every keystroke used to redraw the tab, and on the Notes tab a redraw
     reads the scope's notes back out of Zotero. A short wait costs nothing
     to the eye and turns a burst of typing into one pass. */
  let searchTimer=null;
  function applySearch(){
   if(searchTimer){win.clearTimeout(searchTimer);searchTimer=null;}
   if(disposed||state.query===search.value)return;
   state.query=search.value;
   return render();
  }
  const runSearch=()=>Promise.resolve(applySearch()).catch(error=>runtime.Z?.logError?.(error));
  search.addEventListener('input',()=>{
   if(searchTimer)win.clearTimeout(searchTimer);
   searchTimer=win.setTimeout(()=>{searchTimer=null;runSearch();},150);
  });
  // Enter, and the box's own clear cross, take effect at once instead of waiting.
  search.addEventListener('keydown',event=>{if(suggestKey(event))return;if(event.key==='Enter')runSearch();});
  /* 저널: in the search box offers the scope's journals right under it -- by name, abbreviation or acronym --
     and picking one adds a 저널 include rule (-저널: makes it 제외). Picks add to the same rule, so several
     journals OR together. ↑↓ move, Enter picks, Esc closes. */
  const suggest=node('div',null,controls,{class:'sc-suggest',role:'listbox','aria-label':'저널 제안',id:'sc-journal-suggest'});suggest.hidden=true;
  search.setAttribute('role','combobox');search.setAttribute('aria-autocomplete','list');search.setAttribute('aria-expanded','false');search.setAttribute('aria-controls','sc-journal-suggest');
  let suggestRows=[],suggestAt=-1,suggestToken=null;
  function journalToken(){
   if((RULE_HIDDEN[state.tab]||[]).includes('journal')||controls.hidden)return null;
   // Everything after 저널: to the end of the box is the name being typed, spaces included, until a quote closes or another field starts.
   const m=/(^|\s)(-?)(?:저널|journal|venue):(.*)$/i.exec(search.value);
   if(!m)return null;
   let text=m[3];
   if(text.startsWith('"')){text=text.slice(1);if(text.includes('"'))return null;}
   else if(/\s[^\s:"]+:/.test(' '+text))return null;
   return {neg:m[2]==='-',text:text.trim(),start:m.index+m[1].length};
  }
  function closeSuggest(){suggest.hidden=true;suggest.replaceChildren();suggestRows=[];suggestAt=-1;suggestToken=null;search.setAttribute('aria-expanded','false');search.removeAttribute('aria-activedescendant');}
  function drawSuggest(){
   const token=journalToken();if(!token){if(!suggest.hidden)closeSuggest();return;}
   const mode=token.neg?'ex':'in',taken=new Set(activeRules().filter(r=>r.kind==='journal'&&r.mode===mode).flatMap(r=>r.values));
   const rows=model.journalChoices(scoped(),token.text).filter(c=>!taken.has(c.venue)).slice(0,8);
   suggestToken=token;suggestRows=rows;suggest.replaceChildren();
   if(!rows.length){suggest.hidden=true;search.setAttribute('aria-expanded','false');search.removeAttribute('aria-activedescendant');return;}
   suggestAt=Math.min(Math.max(suggestAt,0),rows.length-1);
   rows.forEach((row,i)=>{
    const option=node('div',null,suggest,{class:'sc-suggest-option',role:'option',id:'sc-journal-suggest-'+i,'aria-selected':String(i===suggestAt)});
    node('span',null,option,{class:'sc-suggest-name',title:row.venue}).textContent=row.venue;
    if(row.abbreviation)node('span',null,option,{class:'sc-suggest-abbr'}).textContent=row.abbreviation;
    node('span',String(row.count),option,{class:'sc-count'});
    option.addEventListener('mousedown',event=>{event.preventDefault();pickJournal(row);});
   });
   try{if(Number.isFinite(search.offsetTop)&&search.offsetHeight){suggest.style.top=(search.offsetTop+search.offsetHeight+4)+'px';suggest.style.left=search.offsetLeft+'px';suggest.style.width=Math.max(240,search.offsetWidth)+'px';}}catch(_){}
   suggest.hidden=false;search.setAttribute('aria-expanded','true');search.setAttribute('aria-activedescendant','sc-journal-suggest-'+suggestAt);
  }
  function pickJournal(row){
   const token=suggestToken;if(!token)return;
   const mode=token.neg?'ex':'in',list=(state.rulesByTab[state.tab]||[]).slice(),at=list.findIndex(r=>r.kind==='journal'&&r.mode===mode&&model.ruleActive(r));
   if(at>=0){if(!list[at].values.includes(row.venue))list[at]={...list[at],values:[...list[at].values,row.venue]};}
   else list.push({id:newRuleID(),kind:'journal',mode,values:[row.venue]});
   if(searchTimer){win.clearTimeout(searchTimer);searchTimer=null;}
   search.value=search.value.slice(0,token.start).trimEnd();state.query=search.value;
   closeSuggest();setRules(list);
   Promise.resolve(render()).catch(error=>runtime.Z?.logError?.(error));
   search.focus?.();
  }
  function suggestKey(event){
   if(event.isComposing||suggest.hidden||!suggestRows.length)return false;
   const move=delta=>{suggestAt=(suggestAt+delta+suggestRows.length)%suggestRows.length;[...suggest.children].forEach((o,i)=>o.setAttribute('aria-selected',String(i===suggestAt)));search.setAttribute('aria-activedescendant','sc-journal-suggest-'+suggestAt);};
   if(event.key==='ArrowDown'){event.preventDefault();move(1);return true;}
   if(event.key==='ArrowUp'){event.preventDefault();move(-1);return true;}
   if(event.key==='Enter'){event.preventDefault();pickJournal(suggestRows[suggestAt]);return true;}
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeSuggest();return true;}
   return false;
  }
  search.addEventListener('input',drawSuggest);
  search.addEventListener('blur',()=>{if(!suggest.hidden)closeSuggest();});
  search.addEventListener('search',runSearch);
  /* A43: with something typed, 내 기록 포함 widens the match past the
     paper's own fields to what was written about it -- the memo, notes and
     annotation text -- so a search for a method finds the paper it was
     only ever mentioned on. Off by default and only shown with a query:
     nothing to widen with an empty box, and always-on made every search
     slower for a case most searches do not need. */
  const recordsCheck=check('내 기록 포함',!!ui.searchRecords,on=>{state.searchRecords=on;saveUI({searchRecords:on});render();},controls);
  const recordsWrap=recordsCheck.closest('label');recordsWrap.classList.add('sc-search-records');
  const scope=node('select',null,controls,{'aria-label':'표시 범위'});node('option','라이브러리',scope,{value:'library'});node('option','선택한 문헌',scope,{value:'selected'});node('option','현재 컬렉션',scope,{value:'collection'});node('option','현재 컬렉션과 하위 컬렉션',scope,{value:'collection-recursive'});
  scope.addEventListener('change',()=>{state.scope=scope.value;state.annotationIDs.clear();if(state.scope!=='selected'){restoreKept();state.selectionLabel='';}run(load);});
  const type=node('select',null,null,{'aria-label':'문헌 유형 필터'});node('option','모든 유형',type,{value:''});
  type.addEventListener('change',()=>{state.type=type.value;render();});
  button('현재 선택 가져오기',()=>{const picked=runtime.selected(win);if(!picked.length){message('Zotero 목록에서 선택한 문헌이 없습니다. 목록에서 먼저 고르세요.',true);return;}state.selected=new Set(picked.map(i=>String(i.id)));render();},controls);
  button('새로고침',load,controls);
  const filterPanel=node('details',null,panel,{class:'sc-filters'}),filterSummary=node('summary','상세 필터',filterPanel);
  const filters=node('div',null,filterPanel,{class:'sc-filter-fields','aria-label':'정렬과 초기화'});
  const filterChips=node('div',null,panel,{class:'sc-filter-chips','aria-label':'적용 중인 필터'});
  /* What kind of thing each item is, in words, and a row of chips that
     splits the library by kind with one click. The user asked for patents
     and theses to sit apart from the papers rather than blend in; the tree
     cannot group, so the panel does: 특허 6 · 학위논문 6 · 프리프린트 26. */
  const KIND_LABELS={journalArticle:'논문',preprint:'Preprint',patent:'특허',thesis:'학위논문',book:'책',bookSection:'책의 장',conferencePaper:'학회 논문',report:'보고서',dataset:'데이터셋',computerProgram:'소프트웨어',document:'문서',webpage:'웹페이지',magazineArticle:'잡지 기사',newspaperArticle:'신문 기사',manuscript:'원고',standard:'표준',presentation:'발표'};
  const kindLabel=type=>KIND_LABELS[type]||type||'';
  const kindChips=node('div',null,null,{class:'sc-kind-chips','aria-label':'문헌 종류'});
  function drawKindChips(){
   kindChips.replaceChildren();
   const counts=new Map();
   for(const item of state.items)if(item.itemType)counts.set(item.itemType,(counts.get(item.itemType)||0)+1);
   if(counts.size<2)return;
   const order=['journalArticle','preprint','conferencePaper','patent','thesis','book','bookSection','report'];
   const kinds=[...counts].sort((a,b)=>(order.indexOf(a[0])+1||99)-(order.indexOf(b[0])+1||99)||b[1]-a[1]);
   const chip=(label,value,count,title)=>{const b=node('button',null,kindChips,{class:'sc-chip sc-chip-button',type:'button','aria-pressed':String(state.type===value),title:T(title)+' · '+T(`라이브러리 전체 ${fmtN(count)}편 기준`)});withCount(b,label,count);b.dataset.kind=value;b.addEventListener('click',()=>{state.type=state.type===value?'':value;type.value=state.type;render();});return b;};
   chip('전체','',state.items.length,'모든 종류');
   for(const [kind,count] of kinds)chip(kindLabel(kind),kind,count,`${T(kindLabel(kind))}만 보기`);
  }
  const filterInputs=new Map();
  function selectFilter(key,label,choices){const input=node('select',null,filters,{'aria-label':label});for(const[value,title]of choices)node('option',title,input,{value});input.value=state[key];input.addEventListener('change',()=>{state[key]=input.value;render();});filterInputs.set(key,input);}
  node('span','정렬',filters,{class:'sc-filter-label'});
  selectFilter('sort','문헌 정렬',[['library','기본 순서'],['title','제목순'],['year-desc','최신 발행순'],['if-desc','IF 높은 순'],['citations-desc','인용 많은 순'],['rating-desc','별점 높은 순'],['time-desc','읽기 시간순']]);
  const resetFilters=button('필터 초기화',()=>{state.recentKind='';state.annotationPaperID='';for(const key of ['status','ratingMin','yearFrom','yearTo','tag'])state[key]='';state.query=search.value='';state.type=type.value='';state.color='';state.sort='library';filterInputs.get('sort').value='library';if(activeRules().length||ruleDraft){closeRuleEditor(false);setRules([]);}render();},filters);
  /* ===== 포함·제외 규칙 =====
     The old single-value row (유형, 읽기 상태, 별점, 연도) is folded into these
     rules; `type` stays only as the detached select the kind chips above write
     through. A rule says
     "has this" (포함) or "does not have this" (제외) about one aspect of a
     paper -- words in a field, a type, tags, status, a rating/year/IF/citation
     range, a collection, a journal, a PDF, annotations, notes, preprint or
     published. Rules AND together and are kept per tab. The option lists are
     counted from the library already in memory, given every other rule, so
     the number beside a value is what choosing it would leave. */
  const RULE_ORDER=['word','type','tag','status','rating','year','collection','journal','impact','citations','pdf','annotation','note','preprint'];
  const RULE_HIDDEN={journals:['journal'],tags:['tag'],reading:['status'],notes:['note'],annotations:['annotation'],attachments:['pdf']};
  const RULE_DATA_KINDS=new Set(['collection','pdf','note','word']);
  const RULE_LABEL=model.RULE_LABELS||{};
  const RULE_LIST_LIMIT=150;
  const activeRules=()=>(state.rulesByTab[state.tab]||[]).filter(r=>model.ruleActive?.(r));
  const keptRules=()=>Object.keys(state.rulesByTab).length?{rulesByTab:state.rulesByTab}:{};
  const legacyOptions=()=>({type:state.type,tag:state.tag,status:state.status,ratingMin:state.ratingMin,yearFrom:state.yearFrom,yearTo:state.yearTo});
  const ruleOptions=()=>{const list=activeRules();return list.length?{rules:list,context:state.ruleContext||{}}:{};};
  const needsRuleData=()=>activeRules().some(r=>RULE_DATA_KINDS.has(r.kind))||/(?:^|\s)-?(?:collection|컬렉션|note|노트|메모):/i.test(state.query||'')||(!!ruleDraft&&RULE_DATA_KINDS.has(ruleDraft.kind));
  let ruleMode='in',ruleDraft=null,ruleEditing=false,ruleTrigger=null,ruleSearchText='',ruleKindsTab='',ruleDataItems=null,ruleSeq=0;
  const newRuleID=()=>'r'+Date.now().toString(36)+(++ruleSeq);
  function saveRules(){const map={};for(const[tab,list]of Object.entries(state.rulesByTab))if(list.length)map[tab]=list;return Promise.resolve(saveUI({filterRules:map})).catch(error=>runtime.Z?.logError?.(error));}
  function setRulesFor(tab,list){const next={...state.rulesByTab};if(list.length)next[tab]=list;else delete next[tab];state.rulesByTab=next;return saveRules();}
  const setRules=list=>setRulesFor(state.tab,list);
  /* One-press shortcuts elsewhere in the panel (a status count, a tag's 안 읽음)
     are ordinary rules with a fixed id, so they show as chips and clear like any. */
  const quickTag=path=>({id:'q-tag',kind:'tag',mode:'in',values:[path],children:true});
  const quickStatus=status=>({id:'q-status',kind:'status',mode:'in',values:[status]});
  function putQuick(tab,rules){const ids=new Set(rules.map(r=>r.id));return setRulesFor(tab,[...(state.rulesByTab[tab]||[]).filter(r=>!ids.has(r.id)),...rules]);}
  function dropQuick(tab,...ids){return setRulesFor(tab,(state.rulesByTab[tab]||[]).filter(r=>!ids.includes(r.id)));}
  /* Collections, notes and PDFs are not part of the paper rows the panel
     starts from; they are read once, together, the first time a rule or a
     search term needs them, and read again only after the library reloads. */
  let ruleDataBusy=null;
  async function ensureRuleData(){
   const itemsNow=state.items;
   if(ruleDataItems===itemsNow)return;
   if(ruleDataBusy&&ruleDataBusy.items===itemsNow)return ruleDataBusy.promise;
   const libraryID=state.libraryID;
   const promise=(async()=>{
    const [cols,counts]=await Promise.all([typeof library.collections==='function'?library.collections(libraryID).catch(()=>[]):[],typeof library.childCounts==='function'?library.childCounts(itemsNow.map(i=>i.id)).catch(()=>({})):{}]);
    if(disposed||itemsNow!==state.items)return;
    const context=model.collectionContext?.(cols)||{},byItem=new Map();
    for(const c of cols)for(const id of c.itemIDs||[]){const key=String(id);if(!byItem.has(key))byItem.set(key,[]);byItem.get(key).push(String(c.id));}
    for(const item of itemsNow){const mine=byItem.get(String(item.id))||[],row=counts[item.id];item.collectionIDs=mine;item.collectionNames=mine.map(id=>context.names?.get(id)).filter(Boolean);item.noteCount=row?row.notes:0;item.pdfCount=row?row.pdfs:0;item.noteTitles=row?row.noteTitles:[];}
    state.ruleContext=context;state.ruleCollections=cols;ruleDataItems=itemsNow;
   })();
   ruleDataBusy={items:itemsNow,promise};
   try{await promise;}finally{if(ruleDataBusy?.promise===promise)ruleDataBusy=null;}
  }
  const filtersOpen=()=>filterPanel.hasAttribute('open');
  const setFiltersOpen=on=>{if(on)filterPanel.setAttribute('open','');else filterPanel.removeAttribute('open');};
  /* A journal is found by its title, by the abbreviations the library and the plugin's own journal table know
     ("Nat Methods", "Proc Natl Acad Sci"), and by its acronym (PNAS, NAR, JACS). Read from what is already
     in memory, once per distinct venue; no request is made. */
  function addVenueAbbreviations(items){
   const cache=new Map(),id=runtime.journalIdentity;
   for(const item of items){
    const venue=String(item.venue||'').trim();
    if(!venue){item.venueAbbrs=[];continue;}
    let found=cache.get(venue);
    if(!found){
     found=[];
     try{const known=id?.identify?.(venue);for(const a of [known?.abbreviation,known?.mark,id?.abbreviate?.(venue)])if(a&&a!==venue&&!found.includes(a))found.push(String(a));}catch(error){runtime.Z?.logError?.(error);}
     cache.set(venue,found);
    }
    item.venueAbbrs=found;
   }
  }
  const rulesBox=node('div',null,filterPanel,{class:'sc-rules',role:'group','aria-label':'포함·제외 규칙'});
  const rulesBar=node('div',null,rulesBox,{class:'sc-rules-bar'});
  node('span','규칙 추가',rulesBar,{class:'sc-rules-title'});
  const ruleKindsBox=node('div',null,rulesBar,{class:'sc-rule-kinds'});
  /* 포함 or 제외 is chosen once, in the editor that opens (it was asked twice: here and there). */
  const kindAria=kind=>`${T(RULE_LABEL[kind]||kind)} ${T('규칙 추가')}`;
  function ruleDefaults(kind){
   if(kind==='word')return {field:'all',text:'',phrase:true};
   if(kind==='tag')return {values:[],all:false,children:true};
   if(kind==='collection')return {values:[],sub:true};
   if(['type','status','journal'].includes(kind))return {values:[]};
   if(kind==='preprint')return {value:'preprint'};
   if(['rating','year','impact','citations'].includes(kind))return {min:'',max:''};
   return {};
  }
  function drawRuleKinds(){
   if(ruleKindsTab===state.tab)return;
   if(ruleKindsTab)closeRuleEditor(false);
   ruleKindsTab=state.tab;ruleKindsBox.replaceChildren();
   const hidden=RULE_HIDDEN[state.tab]||[];
   for(const kind of RULE_ORDER){if(hidden.includes(kind))continue;
    const b=button(RULE_LABEL[kind]||kind,()=>openRuleEditor({id:newRuleID(),kind,mode:ruleMode,...ruleDefaults(kind)},false,b),ruleKindsBox,{class:'sc-chip sc-chip-button sc-rule-kind','data-kind':kind,'aria-label':kindAria(kind)});}
  }
  const editor=node('div',null,rulesBox,{class:'sc-rule-editor',role:'group'});editor.hidden=true;
  {
   /* The search box's shorthand as code chips with a worked example each (a bare "태그:" said nothing). */
   const hint=node('p',null,rulesBox,{class:'sc-rules-hint'});
   node('span',T('검색창 빠른 문법'),hint,{class:'sc-rules-hint-label'});
   for(const [code,note] of [['-단어','제외'],['“구절”','문장 그대로'],['제목:단어',''],['-저자:김','제외'],['연도:2018-2022',''],['태그:methods',''],['저널:Nat Methods','이름·약어 제안'],['컬렉션:Review','']]){
    const entry=node('span',null,hint,{class:'sc-rules-hint-item'});
    node('code',code,entry,{class:'sc-rules-hint-code'});
    if(note)entry.appendChild(doc.createTextNode(' '+T(note)));
   }
  }
  let editorPool=[];
  async function openRuleEditor(rule,editing,trigger){
   const draft={...rule,...(rule.values?{values:[...rule.values]}:{})};
   ruleDraft=draft;ruleEditing=!!editing;ruleTrigger=trigger||null;ruleSearchText='';setFiltersOpen(true);
   if(needsRuleData()){try{await ensureRuleData();}catch(error){runtime.Z?.logError?.(error);}}
   if(disposed||ruleDraft!==draft)return;
   editorPool=model.filter(scoped(),{query:state.query,...legacyOptions()});
   drawRuleEditor(true);
  }
  function closeRuleEditor(restoreFocus=true){
   ruleDraft=null;ruleSearchText='';editor.hidden=true;editor.replaceChildren();
   if(restoreFocus){const target=ruleTrigger?.isConnected?ruleTrigger:ruleKindsBox.querySelector('button')||filterSummary;target?.focus?.();}
   ruleTrigger=null;
  }
  const ruleContextNow=()=>state.ruleContext||{};
  const collectionPath=id=>{const ctx=ruleContextNow();return [...(ctx.ancestors?.get(String(id))||[]).slice().reverse(),String(id)].map(x=>ctx.names?.get(x)||x).join(' / ');};
  function ruleOptionList(d){
   const base=scoped();
   if(d.kind==='type')return [...new Set(base.map(i=>i.itemType).filter(Boolean))].map(v=>[v,T(kindLabel(v))]);
   if(d.kind==='status')return ['unread','reading','done'].map(v=>[v,T(model.STATUS_LABELS[v])]);
   if(d.kind==='journal')return model.journalChoices(base,'').map(c=>[c.venue,c.venue,c.abbreviation]);
   if(d.kind==='tag')return [...new Set(base.flatMap(i=>i.tags||[]))].map(v=>[v,v]);
   if(d.kind==='collection')return (state.ruleCollections||[]).map(c=>[String(c.id),collectionPath(c.id)]);
   return [];
  }
  const kindNoun={type:'유형',tag:'태그',status:'읽기 상태',collection:'컬렉션',journal:'저널'};
  function drawRuleEditor(focus){
   editor.replaceChildren();
   const d=ruleDraft;if(!d){editor.hidden=true;return;}
   editor.hidden=false;
   const kindName=T(RULE_LABEL[d.kind]||d.kind);
   editor.setAttribute('aria-label',`${kindName} ${T(ruleEditing?'규칙 편집':'규칙 추가')}`);
   const head=node('div',null,editor,{class:'sc-rule-head'});
   node('strong',RULE_LABEL[d.kind]||d.kind,head,{class:'sc-rule-name'});
   const modeSeg=node('div',null,head,{class:'sc-segmented',role:'group','aria-label':'규칙 방식'});
   for(const[value,label]of [['in','포함'],['ex','제외']])button(label,()=>{d.mode=value;drawRuleEditor(false);editor.querySelector(`.sc-rule-head [data-mode="${value}"]`)?.focus?.();},modeSeg,{'aria-pressed':String(d.mode===value),'data-mode':value});
   const form=node('div',null,editor,{class:'sc-rule-body'});
   const preview=node('p',null,editor,{class:'sc-rule-preview',role:'status','aria-live':'polite'});
   const actions=node('div',null,editor,{class:'sc-rule-actions'});
   const apply=button(ruleEditing?'변경 적용':'규칙 적용',()=>commitRule(),actions,{'data-variant':'primary'});
   button('취소',()=>closeRuleEditor(true),actions);
   if(ruleEditing)button('규칙 삭제',()=>removeRule(d.id,true),actions);
   const ctx=ruleContextNow();
   const refresh=()=>{
    const ok=model.ruleActive(d);apply.disabled=!ok;
    const others=model.applyRules(editorPool,activeRules().filter(r=>r.id!==d.id),ctx);
    if(!ok){preview.textContent=T('조건을 고르면 남는 문헌 수가 여기에 표시됩니다.');return;}
    const after=model.applyRules(others,[d],ctx).length;
    preview.textContent=T(`다른 규칙을 적용한 ${others.length}편 중 ${after}편이 남습니다.`);
   };
   const seg=(parent,label,options,current,set)=>{const wrap=node('div',null,parent,{class:'sc-segmented',role:'group','aria-label':label});for(const[value,text]of options)button(text,()=>{set(value);for(const b of wrap.querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.value===String(value)));refresh();},wrap,{'aria-pressed':String(current===value),'data-value':String(value)});return wrap;};
   const field=(parent,label)=>{const row=node('label',null,parent,{class:'sc-rule-field'});node('span',label,row);return row;};
   const submitOn=input=>input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();commitRule();}});
   let focusTarget=null;
   if(d.kind==='word'){
    seg(form,'찾을 위치',model.RULE_FIELDS.map(f=>[f,model.FIELD_LABELS[f]]),d.field,v=>{d.field=v;});
    const row=field(form,'단어 또는 구절');const input=node('input',null,row,{type:'text','aria-label':'찾을 단어 또는 구절',placeholder:'예: deep learning',autocomplete:'off'});input.value=d.text||'';
    input.addEventListener('input',()=>{d.text=input.value;refresh();});submitOn(input);focusTarget=input;
    check('구절 그대로 일치',d.phrase!==false,on=>{d.phrase=on;refresh();},form);
    node('p','끄면 입력한 단어가 모두 들어 있으면 일치합니다.',form,{class:'sc-rule-note'});
   }else if(['type','tag','status','collection','journal'].includes(d.kind)){
    const noun=T(kindNoun[d.kind]);
    if(d.kind==='tag'){
     seg(form,'여러 태그의 결합',[[false,d.mode==='ex'?'하나라도 가진 문헌':'하나라도 포함'],[true,d.mode==='ex'?'모두 가진 문헌':'모두 포함']],!!d.all,v=>{d.all=v;});
     check('하위 태그 포함 (a는 a/b도)',d.children!==false,on=>{d.children=on;drawOptions();refresh();},form);
    }
    if(d.kind==='collection')check('하위 컬렉션 포함',d.sub!==false,on=>{d.sub=on;drawOptions();refresh();},form);
    let search=null;
    if(!['status','type'].includes(d.kind)){
     const row=field(form,`${noun} 찾기`);search=node('input',null,row,{type:'search','aria-label':`${noun} 목록 검색`,placeholder:d.kind==='journal'?'이름·약어·약칭으로 찾기 (예: Nat Methods, PNAS)':'목록에서 찾기',autocomplete:'off'});search.value=ruleSearchText;
     search.addEventListener('input',()=>{ruleSearchText=search.value;drawOptions();});focusTarget=search;
    }
    const list=node('div',null,form,{class:'sc-rule-options',role:'group','aria-label':`${noun} 선택`});
    const more=node('p',null,form,{class:'sc-rule-note'});
    function drawOptions(){
     list.replaceChildren();
     const counts=model.countOptions(editorPool,d.kind,{rules:activeRules(),ctx,skipID:d.id,children:d.kind==='collection'?d.sub!==false:d.children!==false});
     const needle=model.norm(ruleSearchText).trim(),chosen=new Set(d.values);
     // Journals match by name, abbreviation or acronym and rank exact > prefix > contains; the rest by substring.
     const scores=d.kind==='journal'?new Map(model.journalChoices(scoped(),ruleSearchText).map(c=>[c.venue,c.score])):null;
     const all=ruleOptionList(d).map(([value,label,abbr])=>({value,label,abbr,count:counts.get(value)||0,score:scores?scores.get(value)??null:0}))
      .filter(o=>chosen.has(o.value)||(scores?o.score!==null:(!needle||model.norm(o.label).includes(needle))))
      .sort((a,b)=>(chosen.has(b.value)-chosen.has(a.value))||((a.score??9)-(b.score??9))||(b.count-a.count)||String(a.label).localeCompare(String(b.label)));
     for(const o of all.slice(0,RULE_LIST_LIMIT)){
      const row=node('label',null,list,{class:'sc-rule-opt'});
      const box=node('input',null,row,{type:'checkbox','aria-label':o.label});box.checked=chosen.has(o.value);
      box.addEventListener('change',()=>{const at=d.values.indexOf(o.value);if(box.checked&&at<0)d.values.push(o.value);if(!box.checked&&at>=0)d.values.splice(at,1);refresh();});
      node('span',null,row,{class:'sc-rule-opt-name',title:o.abbr?`${o.label} · ${o.abbr}`:o.label}).textContent=o.label;
      if(o.abbr)node('span',null,row,{class:'sc-rule-opt-abbr'}).textContent=o.abbr;
      node('span',String(o.count),row,{class:'sc-count'});
      row.dataset.zero=String(!o.count);
     }
     if(!all.length)node('p','맞는 항목이 없습니다.',list,{class:'sc-rule-note'});
     more.textContent=all.length>RULE_LIST_LIMIT?T(`${all.length}개 중 ${RULE_LIST_LIMIT}개만 표시합니다. 위 검색으로 좁히세요.`):'';
     more.hidden=!more.textContent;
    }
    drawOptions();if(!focusTarget)focusTarget=list.querySelector('input');
    node('p','숫자는 지금 다른 규칙과 필터를 적용했을 때 그 값에 해당하는 문헌 수입니다.',form,{class:'sc-rule-note'});
   }else if(['rating','year','impact','citations'].includes(d.kind)){
    const spec={rating:{min:0,max:5,step:1,unit:'점'},year:{min:1,max:9999,step:1,unit:''},impact:{min:0,step:.1,unit:''},citations:{min:0,step:1,unit:''}}[d.kind];
    const pair=node('div',null,form,{class:'sc-rule-range'});
    for(const[key,label]of [['min','최소'],['max','최대']]){
     const row=field(pair,label);const input=node('input',null,row,{type:'number',min:spec.min,step:spec.step,'aria-label':`${kindName} ${label}`,placeholder:label,inputmode:'decimal'});if(spec.max!==undefined)input.setAttribute('max',spec.max);
     input.value=d[key]===''?'':String(d[key]);
     input.addEventListener('input',()=>{d[key]=input.value===''?'':Number(input.value);refresh();});submitOn(input);if(!focusTarget)focusTarget=input;
    }
    node('p',d.kind==='rating'?'별점을 매기지 않은 문헌은 0점으로 셉니다.':'값이 기록되지 않은 문헌은 이 범위에 들어가지 않습니다.',form,{class:'sc-rule-note'});
   }else if(d.kind==='preprint'){
    seg(form,'Preprint 또는 출판본',[['preprint','Preprint'],['published','출판본']],d.value,v=>{d.value=v;});
   }else{
    node('p',({pdf:'PDF 첨부가 하나라도 있는 문헌',annotation:'주석이 하나라도 달린 문헌',note:'내가 쓴 노트가 하나라도 있는 문헌'})[d.kind],form,{class:'sc-rule-note'});
    node('p','포함은 이런 문헌만 남기고, 제외는 이런 문헌을 뺍니다. 읽기 시간 기록용 노트는 세지 않습니다.',form,{class:'sc-rule-note'});
   }
   refresh();
   if(focus)(focusTarget||editor.querySelector('.sc-rule-actions button')||editor).focus?.();
  }
  async function commitRule(){
   const d=ruleDraft;if(!d||!model.ruleActive(d))return;
   const clean=model.cleanRules([d])[0];if(!clean)return;
   const list=(state.rulesByTab[state.tab]||[]).slice(),at=list.findIndex(r=>r.id===clean.id);
   if(at>=0)list[at]=clean;else list.push(clean);
   const trigger=ruleTrigger;closeRuleEditor(false);setRules(list);
   await render();
   const target=(trigger?.isConnected?trigger:null)||filterChips.querySelector(`[data-rule-id="${clean.id}"] .sc-rule-chip-main`)||filterSummary;target?.focus?.();
  }
  async function removeRule(id,fromEditor){
   if(fromEditor)closeRuleEditor(false);
   setRules((state.rulesByTab[state.tab]||[]).filter(r=>r.id!==id));
   await render();
   (filterChips.querySelector('.sc-rule-chip-main')||filterSummary).focus?.();
  }
  function ruleChip(rule){
   const group=node('span',null,filterChips,{class:'sc-rule-chip','data-mode':rule.mode,'data-rule-id':rule.id,'data-kind':rule.kind});
   const words=model.describeRule(rule,{kindLabel:k=>T(kindLabel(k)),collectionName:id=>state.ruleContext?.names?.get(String(id))||id,t:T});
   const prefix=rule.mode==='ex'?T('제외')+' · ':'';
   const main=button(prefix+words,()=>openRuleEditor(rule,true,main),group,{class:'sc-rule-chip-main','aria-label':`${prefix}${words} ${T('규칙 편집')}`,title:`${prefix}${words}`});
   button('×',()=>removeRule(rule.id,false),group,{class:'sc-rule-chip-x','aria-label':`${prefix}${words} ${T('규칙 삭제')}`,title:T('규칙 삭제')});
  }
  const shell=node('div',null,panel,{class:'sc-shell'}),nav=node('nav',null,shell,{'aria-label':'작업 종류'}),content=node('div',null,shell,{class:'sc-content'});
  const context=node('div',null,content,{class:'sc-context'}),sectionTitle=node('h2','보유 문헌',context,{class:'sc-section-title'}),contextDetail=node('span',null,context,{class:'sc-context-detail'});context.appendChild(kindChips);
  /* The search row and its filters belong to the page they narrow, so they sit
     inside the content column under its title. Above the shell, hiding them on
     a page that cannot be searched lifted the whole panel -- rail, title and
     all -- by the height of a row every time the reader changed tabs. */
  /* The page's own title is the first line of the column; a notice goes under
     it and its search row, so the title never moves when one appears. */
  /* The status line belongs to the page that wrote it, beside the notices; on
     top of the shell it moved the rail and the title every time a message
     appeared, which is the shake the banners were moved to stop. */
  // 상세 필터 opens from the search row itself rather than a row under it.
  controls.appendChild(filterPanel);
  content.append(controls,filterChips,status,welcome,notice);
  const body=node('div',null,content,{class:'sc-body',tabindex:'-1'});
  const navButtons=new Map();
  /* The rail scrolls only when the current section is actually out of sight. scrollIntoView honoured the rail's
     scroll padding, so an item inside the top 32px lifted the whole rail by 4px on that one tab. A strip that
     scrolls sideways (narrow panel) fades only the edge that has more behind it. */
  function syncNavFade(){
   const row=nav.scrollWidth>nav.clientWidth+2&&nav.scrollHeight<=nav.clientHeight+2;
   nav.dataset.fadeStart=String(row&&nav.scrollLeft>2);
   nav.dataset.fadeEnd=String(row&&nav.scrollLeft+nav.clientWidth<nav.scrollWidth-2);
  }
  function revealNav(button,center){
   if(!button||disposed)return;
   const a=button.getBoundingClientRect(),b=nav.getBoundingClientRect();
   if(!b.width||!b.height){syncNavFade();return;}
   const row=nav.scrollWidth>nav.clientWidth+2&&nav.scrollHeight<=nav.clientHeight+2;
   if(row){
    const out=a.left<b.left+24||a.right>b.right-24;
    if(out||center&&Math.abs((a.left+a.width/2)-(b.left+b.width/2))>b.width/3)nav.scrollLeft+=(a.left+a.width/2)-(b.left+b.width/2);
   }else if(a.top<b.top||a.bottom>b.bottom){
    nav.scrollTop+=a.top<b.top?a.top-b.top-12:a.bottom-b.bottom+12;
   }
   syncNavFade();
  }
  nav.addEventListener('scroll',syncNavFade,{passive:true});
  try{new win.ResizeObserver(()=>syncNavFade()).observe(nav);}catch{}
  async function navigate(id,{focus=false}={}){if(!TABS.some(([key])=>key===id)||hiddenTabs().has(id))return;const request=++navigationEpoch;
   /* An error belongs to the page that raised it. "OpenAlex에서 이 논문의 저자를
      찾지 못했습니다" followed the reader into reading, notes and comparison and
      sat there in red. */
   // A message belongs to the page that wrote it, error or not.
   message('');
   state.tab=id;await render();revealNav(navButtons.get(id),true);if(disposed||panel.hidden||request!==navigationEpoch||state.tab!==id)return;await saveUI({lastTab:id});if(focus&&!disposed&&!panel.hidden&&request===navigationEpoch&&state.tab===id&&commands.hidden)body.focus?.();}
  // The label stays: an icon alone would be a guessing game for nineteen tabs.
  // The icon is what makes the right one findable without reading all of them.
  function leadIcon(element,name){
   if(!ICONS[name])return element;
   const holder=doc.createElementNS(HTML,'span');
   holder.className='sc-nav-icon';
   setIcon(holder,name);
   element.insertBefore(holder,element.firstChild);
   return element;
  }
  /* Nineteen menu entries were nineteen Tab stops between the reader and the
     page. The rail is one stop, on the current entry, and the arrow keys walk
     it, as the settings window's own list does. */
  nav.addEventListener('keydown',event=>{
   if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
   const shown=[...navButtons.values()].filter(b=>!b.hidden);
   const at=shown.indexOf(doc.activeElement);if(at<0)return;
   event.preventDefault();
   const next=event.key==='Home'?0:event.key==='End'?shown.length-1:Math.max(0,Math.min(shown.length-1,at+(event.key==='ArrowDown'?1:-1)));
   for(const b of shown)b.setAttribute('tabindex',b===shown[next]?'0':'-1');
   shown[next].focus();
  });
  for(const [label,ids]of GROUPS){const group=node('div',null,nav,{class:'sc-nav-group'});node('div',label,group,{class:'sc-nav-heading'});for(const id of ids){const label=TABS.find(([key])=>key===id)[1];const nb=button('',()=>navigate(id),group,{'data-tab':id,title:T(label)});node('span',label,nb,{class:'sc-nav-label'});navButtons.set(id,leadIcon(nb,id));}}
  const footer=node('footer',null,panel,{class:'sc-selection-bar'});const selectionLabel=node('span','선택한 문헌 없음',footer,{class:'sc-selection-label'});
  const clearSelection=button('선택 해제',()=>{state.selected.clear();state.annotationIDs.clear();state.matrixUsingSelection=false;restoreKept();render();},footer);
  // Of the three, linking is what the selection is usually for; the other two
  // undo. Only one of them carries a fill.
  /* The bar is the way into the next task with what is chosen: one paper to
     its notes or annotations, several to the comparison table, exactly two
     to their annotations side by side. Linking, which is rarer, folds. */
  const tasks=node('span',null,footer,{class:'sc-selection-tasks'});
  const goNotes=button('노트',()=>navigateSelection('notes'),tasks);
  const goAnnots=button('주석',()=>navigateSelection('annotations'),tasks);
  const goCompare=button('논문 비교',()=>navigateSelection('matrix'),tasks,{'data-variant':'primary'});
  const goSide=button('주석 나란히',()=>{state.annotationCompareIDs=[...state.selected].slice(0,2).map(String);state.annotationCompare=true;return navigateSelection('annotations');},tasks);
  /* Three things to do with whatever is chosen, without leaving the panel for
     the Zotero window: copy the citations, put the papers in a new collection
     (named here, in the panel), or select them in Zotero's own list. */
  const chosenRefs=()=>[...state.selected].map(id=>runtime.Z.Items.get(Number(id))).filter(Boolean);
  const citeAction=button('인용 복사',()=>{const refs=chosenRefs();if(!refs.length)throw new Error('인용문을 만들 문헌을 먼저 선택하세요.');return runtime.citationPanel(win,refs);},tasks,{'data-opens':'dialog',title:T('선택한 문헌의 인용문을 APA·MLA·Vancouver 등 형식으로 만들어 복사합니다')});
  const pickAction=button('Zotero에서 선택',async()=>{
   const ids=[...state.selected].map(Number).filter(Number.isFinite);if(!ids.length)throw new Error('먼저 문헌을 선택하세요.');
   if(typeof win.ZoteroPane?.selectItems!=='function')throw new Error('Zotero 목록을 쓸 수 없습니다. Zotero를 다시 시작한 뒤 시도하세요.');
   await win.ZoteroPane.selectItems(ids);message(`Zotero 목록에서 ${ids.length}편을 선택했습니다.`);
  },tasks,{'data-opens':'pane',title:T('Zotero 목록에서 같은 문헌들을 선택합니다')});
  const collectRow=node('div',null,footer,{class:'sc-selection-collect'});collectRow.hidden=true;
  const collectName=node('input',null,collectRow,{'aria-label':'새 컬렉션 이름',placeholder:'새 컬렉션 이름'});
  const collectGo=button('만들고 담기',async()=>{
   const made=await library.saveToCollection(collectName.value,[...state.selected]);
   collectName.value='';collectRow.hidden=true;
   message(`컬렉션 “${made.name}”을 만들고 ${made.count}편을 담았습니다.`);
   await load();
  },collectRow);
  const collectToggle=button('컬렉션으로 저장',()=>{collectRow.hidden=!collectRow.hidden;if(!collectRow.hidden)collectName.focus?.();},tasks,{'aria-expanded':'false',title:T('선택한 문헌을 새 컬렉션으로 묶습니다')});
  collectToggle.addEventListener('click',()=>collectToggle.setAttribute('aria-expanded',String(!collectRow.hidden)));
  collectName.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();collectGo.click();}});
  const relations=node('details',null,footer,{class:'sc-selection-relations'});node('summary',T('연결 작업'),relations);
  const relatedAction=button('관련 문헌으로 연결',async()=>{const n=state.selected.size;await library.relate([...state.selected]);await load();message(`${n}개 문헌을 서로 관련 문헌으로 연결했습니다.`);},relations);
  const unlinkAction=button('선택 문헌끼리 연결 해제',async()=>{const changed=await library.unrelate([...state.selected]);await load();message(`${changed}개 문헌의 상호 연결을 해제했습니다.`);},relations);
  /* To the chosen papers on another tab: the scope becomes the selection,
     and a search or filter that would hide them is set aside -- kept, and
     given back by 전체 목록으로. */
  // The search and filters set aside for a selection come back when the selection is left, however it is left.
  function restoreKept(){
   const kept=state.keptFilters;if(!kept)return;state.keptFilters=null;
   Object.assign(state,kept);search.value=kept.query||'';type.value=kept.type||'';
   for(const [key,input] of filterInputs)if(key in kept)input.value=kept[key]||'';
   // Left some other way -- 다른 문헌 고르기, an emptied selection -- rather
   // than through 이전 목록으로: the remembered position is now stale.
   state.listOrigin=null;
  }
  /* 보유 문헌 remembers where it was, so a jump out through a row's 주석 n, a
     selection-bar task or a single-paper pick can be undone exactly: which
     page, what was checked and sorted, and which card sat at the top of the
     scroll area. Only leaving the list itself sets this -- a plain tab
     switch never does -- and it is read once, by 이전 목록으로. */
  function rememberListOrigin(){
   if(state.tab!=='explore')return;
   const cards=[...body.querySelectorAll('[data-item-id]')];
   const top=body.getBoundingClientRect?.().top||0;
   let anchorID=null;
   for(const c of cards){const rect=c.getBoundingClientRect?.();if(!rect||rect.top>=top-1){anchorID=c.dataset.itemId;break;}}
   state.listOrigin={tab:state.tab,scope:state.scope,sort:state.sort,pageIndex:state.pageIndex||0,pageKey:state.pageKey,
    selected:[...state.selected],expandedPaperID:state.expandedPaperID||'',
    scrollTop:body.scrollTop||0,anchorID,
    filters:{query:state.query,type:state.type,tag:state.tag,status:state.status,ratingMin:state.ratingMin,yearFrom:state.yearFrom,yearTo:state.yearTo,rulesByTab:state.rulesByTab}};
  }
  // The other half: everything rememberListOrigin kept, put back, then the
  // same card scrolled to the same offset and focused (or the nearest one left).
  async function restoreListOrigin(){
   const origin=state.listOrigin;if(!origin)return;
   state.listOrigin=null;
   Object.assign(state,origin.filters);
   search.value=origin.filters.query||'';type.value=origin.filters.type||'';
   for(const [key,input] of filterInputs)if(key in origin.filters)input.value=origin.filters[key]||'';
   state.scope=origin.scope;scope.value=origin.scope;
   state.sort=origin.sort;const sortInput=filterInputs.get('sort');if(sortInput)sortInput.value=origin.sort;
   state.pageIndex=origin.pageIndex;state.pageKey=origin.pageKey;state.selected=new Set(origin.selected);state.expandedPaperID=origin.expandedPaperID;
   await navigate(origin.tab);
   const anchor=(origin.anchorID&&body.querySelector(`[data-item-id="${origin.anchorID}"]`))||body.querySelector('[data-item-id]');
   if(anchor){body.scrollTop=origin.scrollTop||0;anchor.scrollIntoView?.({block:'nearest'});anchor.focus?.();}
  }
  function navigateSelection(tab,ids,label){
   rememberListOrigin();
   const kept={query:state.query,status:state.status,ratingMin:state.ratingMin,yearFrom:state.yearFrom,yearTo:state.yearTo,type:state.type,tag:state.tag,...keptRules()};
   if(Object.values(kept).some(Boolean))state.keptFilters=kept;
   state.query='';search.value='';for(const key of ['status','ratingMin','yearFrom','yearTo','type','tag'])state[key]='';state.rulesByTab={};
   for(const [,input] of filterInputs)input.value='';type.value='';
   // Called with an explicit id list (a journal's held papers, say) rather than
   // whatever the user last checked: that list becomes the selection.
   if(ids)state.selected=new Set(ids.map(String));
   // A short note on why this particular set: "#a ∩ #b" for two tags crossed
   // in 중첩 태그, say. updateChrome shows it beside the selection count.
   state.selectionLabel=label||'';
   state.scope='selected';scope.value='selected';
   return navigate(tab);
  }
  const commands=node('div',null,panel,{class:'sc-command-palette',role:'dialog','aria-modal':'true','aria-label':'기능 바로 찾기'});commands.hidden=true;
  const commandSearch=node('input',null,commands,{type:'search',class:'sc-command-search',placeholder:'예: 주석, 비교, 탭…',role:'combobox','aria-expanded':'false','aria-autocomplete':'list','aria-label':'찾을 기능 이름','aria-controls':'sc-command-results'});
  const commandResults=node('div',null,commands,{id:'sc-command-results',class:'sc-command-results',role:'listbox','aria-label':'검색된 기능'});
  node('p','↑↓ 이동 · Enter 열기 · Esc 닫기',commands,{class:'sc-muted'});
  function drawCommands(){
   const query=commandSearch.value.trim().toLocaleLowerCase();commandMatches=TABS.filter(([id,label])=>!hiddenTabs().has(id)&&(!query||(label+' '+T(label)+' '+id).toLocaleLowerCase().includes(query)));
   commandIndex=Math.max(0,Math.min(commandIndex,commandMatches.length-1));commandResults.replaceChildren();
   if(!commandMatches.length){node('p','일치하는 기능이 없습니다.',commandResults);commandSearch.removeAttribute('aria-activedescendant');return;}
   commandMatches.forEach(([id,label],index)=>{const option=button(label,()=>{closeCommands(false);return navigate(id,{focus:true});},commandResults,{class:'sc-command-option',id:'sc-command-'+id,role:'option','aria-selected':String(index===commandIndex),tabindex:-1});});
   commandSearch.setAttribute('aria-activedescendant','sc-command-'+commandMatches[commandIndex][0]);
   // The list scrolls; the chosen line is kept in view as the arrows move it.
   commandResults.children[commandIndex]?.scrollIntoView?.({block:'nearest'});
  }
  const inertBefore=new Map();
  function openCommands(){navigationEpoch++;commandFocus=doc.activeElement;for(const element of [head,status,controls,filterPanel,filterChips,shell,footer]){inertBefore.set(element,element.inert);element.inert=true;}commands.hidden=false;commandSearch.setAttribute('aria-expanded','true');commandSearch.value='';commandIndex=0;drawCommands();commandSearch.focus?.();}
  function closeCommands(restore=true){commands.hidden=true;commandSearch.setAttribute('aria-expanded','false');for(const[element,value]of inertBefore)element.inert=value;inertBefore.clear();if(restore&&commandFocus?.isConnected)commandFocus.focus?.();commandFocus=null;}
  commandSearch.addEventListener('input',()=>{commandIndex=0;drawCommands();});
  commands.addEventListener('keydown',event=>{
   if(event.isComposing)return;
   if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();event.stopPropagation();commandIndex=event.key==='Home'?0:event.key==='End'?commandMatches.length-1:commandIndex+(event.key==='ArrowDown'?1:-1);drawCommands();}
   else if(event.key==='Enter'){event.preventDefault();event.stopPropagation();const target=commandMatches[commandIndex];if(target){closeCommands(false);run(()=>navigate(target[0],{focus:true}));}}
   else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeCommands();}
   else if(event.key==='Tab'){event.preventDefault();commandSearch.focus?.();}
  });
  /* Where the button goes in the items toolbar.

     Appended, it landed at the very end -- past the spacer, the search box and
     the item-pane toggle -- sitting on its own at the far edge with nothing
     around it. It belongs with the other tools: new item, lookup, attachment,
     note. So it goes after the last of those and before the spacer, which is
     also where the other plugin's button already sits. */
  function placeInToolbar(bar,button){
    // After the other plugin's button when it is there, so the two keep a fixed
    // order instead of trading places depending on which loaded first.
    const anchor=bar.querySelector('#zotpop-toolbar-button')
      || bar.querySelector('#zotero-tb-note-add')
      || bar.querySelector('#zotero-tb-attachment-add')
      || [...bar.children].reverse().find(child=>child.localName==='toolbarbutton');
    const spacer=[...bar.children].find(child=>child.localName==='spacer'||child.localName==='toolbarspacer');
    // After the last tool; failing that, before the spacer; failing both, at the
    // end, because a button nobody can reach is worse than one badly placed.
    if(anchor&&anchor.parentNode===bar)bar.insertBefore(button,anchor.nextSibling);
    else if(spacer)bar.insertBefore(button,spacer);
    else bar.appendChild(button);
  }
  let toolbar;
  const target=doc.getElementById('zotero-items-toolbar');
  if(target){toolbar=doc.createXULElement?doc.createXULElement('toolbarbutton'):node('button');toolbar.id='style-custom-workbench-button';toolbar.className='zotero-tb-button';toolbar.setAttribute('image',runtime.rootURI+'content/icons/style-custom-toolbar.svg');
   // Painted in the toolbar's ink, as Zotero paints its own context-fill glyphs.
   toolbar.style?.setProperty?.('fill','currentColor');toolbar.style?.setProperty?.('-moz-context-properties','fill, fill-opacity');
   toolbar.setAttribute('tooltiptext',T('Style Custom 연구 작업 패널'));toolbar.setAttribute('label',T('연구 작업 패널'));toolbar.addEventListener('command',()=>run(()=>toggle()));toolbar.addEventListener('click',()=>{if(!doc.createXULElement)run(()=>toggle());});
   placeInToolbar(target,toolbar);}
  const selected=()=>state.items.filter(i=>state.selected.has(String(i.id)));
  function bindAI(itemID){if(state.aiItemID!==itemID){aiEpoch++;state.aiItemID=itemID;state.aiTask=null;state.aiOutput=null;}}
  const scoped=()=>state.scope==='selected'?selected():state.scope.startsWith('collection')?state.items.filter(i=>(state.collectionIDs||[]).includes(String(i.id))):state.items;
  /* With a search typed and no explicit order chosen, the paper whose title
     is what was typed comes first, then the ones that begin with it, then the
     ones that merely contain it. Any other sort the user picked still wins. */
  const rows=()=>{
   const found=model.filter(scoped(),{query:state.query,...parentOptions()});
   return state.query&&state.sort==='library'?model.rankByQuery(found,state.query):model.sortItems(found,state.sort);
  };
  /* 논문 비교's own scope: once the picker has committed to a chosen set --
     adding or removing a paper -- 0 chosen means "compare nothing", not
     "fall back to the whole list". updateChrome's header count has to agree
     with drawMatrix's scopeItems, or removing the last compared paper still
     reads "비교 중 N편" for the list behind it. */
  const matrixUsingPicker=()=>!!state.matrixUsingSelection||selected().length>0;
  const parentOptions=()=>({...legacyOptions(),...ruleOptions()});
  const ids=()=>Object.values(parentOptions()).some(Boolean)?model.filter(scoped(),parentOptions()).map(item=>String(item.id)):state.scope==='selected'?[...state.selected]:state.scope.startsWith('collection')?[...(state.collectionIDs||[])]:undefined;
  /* A43: 내 기록 포함. rows() answers what the title/authors/venue/DOI/
     abstract/tags/memo already say; this widens 보유 문헌's own list past
     that, to papers found only through a note or an annotation -- after the
     same scope and non-search filters rows() itself applies, so a status or
     year filter still narrows what widening can add back in.

     Returns {items, hits}: items is rows() with the extra papers appended,
     hits maps a paper id to where it matched (a memo already in the base
     row, or the note/annotation that pulled in an extra one) for the
     .sc-paper-search-hit line under its title. */
  async function exploreRows(){
   const base=rows();
   // The memo/note/annotation widening looks for the plain words; -word, field:value and the rules already acted in rows().
   const wide=model.plainQuery?model.plainQuery(state.query):state.query;
   if(!state.searchRecords||!wide.trim())return {items:base,hits:new Map()};
   const words=String(wide||'').toLowerCase().split(/\s+/).filter(Boolean);
   const excerptAround=text=>{const hay=String(text||'').replace(/\s+/g,' ').trim();
    const at=Math.min(...words.map(w=>hay.toLowerCase().indexOf(w)).filter(i=>i>=0));
    if(!Number.isFinite(at))return hay.slice(0,140);
    return (at>20?'…':'')+hay.slice(Math.max(0,at-20),at+120).trim();};
   const hits=new Map();
   // A base row already matched by title etc.; only a memo-only match is worth naming.
   for(const item of base){
    const own=[item.title,item.authors,item.venue,item.doi,item.abstract,item.year,item.itemType,item.issn,...(item.tags||[])].join(' ');
    if(model.matches(own,wide))continue;
    if(item.remark&&model.matches(item.remark,wide))hits.set(String(item.id),{kind:'memo',label:T('메모'),text:excerptAround(item.remark)});
   }
   const pool=model.filter(scoped(),{query:model.syntaxQuery?model.syntaxQuery(state.query):'',...parentOptions()});
   const poolIDs=pool.map(item=>String(item.id));
   const baseIDs=new Set(base.map(item=>String(item.id)));
   const [notes,annotations]=await Promise.all([scopeNotes(poolIDs),scopeAnnotations(poolIDs)]).catch(()=>[[],[]]);
   const extra=[];
   for(const item of pool){
    const id=String(item.id);
    if(baseIDs.has(id)||hits.has(id))continue;
    const myNotes=(notes||[]).filter(n=>String(n.parentID||'')===id);
    const noteHit=myNotes.find(n=>model.matches(String(n.title||'')+' '+String(n.text||''),wide));
    if(noteHit){hits.set(id,{kind:'note',label:T(`노트 ${myNotes.length}`),text:excerptAround(String(noteHit.title||'')+' '+String(noteHit.text||''))});extra.push(item);continue;}
    const myAnnotations=(annotations||[]).filter(a=>String(a.parentID||'')===id);
    const annotHit=myAnnotations.find(a=>model.matches(String(a.text||'')+' '+String(a.comment||''),wide));
    if(annotHit){hits.set(id,{kind:'annotation',label:T(`주석 ${myAnnotations.length}`),text:excerptAround(String(annotHit.text||'')+' '+String(annotHit.comment||''))});extra.push(item);}
   }
   // Merge before sorting: a paper pulled in only through a note ranks and
   // orders exactly as any other would, rather than trailing the base list
   // regardless of the chosen sort (or the median-sort facts, which count
   // whatever this returns).
   if(!extra.length)return {items:base,hits};
   const merged=[...base,...extra];
   return {items:state.query&&state.sort==='library'?model.rankByQuery(merged,state.query):model.sortItems(merged,state.sort),hits};
  }
  /* Searching notes re-ran the whole library's note read on every keystroke.
     The scope's notes only change when the library is reloaded or a note is
     written, so they are read once per load and kept until then. */
  let noteCache=null;
  function scopeNotes(scope){
   const key=scope===undefined?'*':[...scope].map(String).sort().join(',');
   if(noteCache&&noteCache.token===loadEpoch&&noteCache.key===key)return noteCache.promise;
   const promise=library.notes(scope);
   noteCache={token:loadEpoch,key,promise};
   promise.catch(()=>{if(noteCache&&noteCache.promise===promise)noteCache=null;});
   return promise;
  }
  // A43: the same cache-per-scope-per-load shape as scopeNotes, for
  // annotations -- 내 기록 포함 reads both to widen a search past the paper's
  // own fields, and neither should re-read Zotero on every keystroke.
  let annotationCache=null;
  function scopeAnnotations(scope){
   const key=scope===undefined?'*':[...scope].map(String).sort().join(',');
   if(annotationCache&&annotationCache.token===loadEpoch&&annotationCache.key===key)return annotationCache.promise;
   const promise=library.annotations(scope);
   annotationCache={token:loadEpoch,key,promise};
   promise.catch(()=>{if(annotationCache&&annotationCache.promise===promise)annotationCache=null;});
   return promise;
  }
  function updateSelectionUI(){
   const nativeJCR=state.tab==='journals'&&state.journalBrowser!=='openalex';
   /* On the JCR browser the selection actions cannot act on anything, and a bar
      of buttons that all refuse is worse than no bar. */
   // The selection bar belongs to the pages that act on papers; tabs, views and settings have none to act on.
   // Reading progress and author tracking link no papers to each other either; the bar there only took the bottom of the page.
   footer.hidden=nativeJCR||['collections','tabs','views','appearance','reading','authors'].includes(state.tab);
   const count=state.selected.size;footer.dataset.selected=String(count>0);const visible=new Set((['notes','annotations','attachments'].includes(state.tab)?model.filter(scoped(),parentOptions()):rows()).map(item=>String(item.id))),outside=[...state.selected].filter(id=>!visible.has(String(id))).length;
   selectionLabel.textContent=count?(count===1?T('문헌 1개 선택'):T(`${count}개 문헌 선택`))+(outside?' · '+T(`현재 결과 밖 ${outside}개 포함`):''):T('문헌을 선택하면 함께 비교하거나 연결할 수 있습니다.');
   selectionLabel.title=selected().slice(0,5).map(item=>item.title).join('\n');
   clearSelection.disabled=nativeJCR||!count||clearSelection.dataset.busy==='true';relatedAction.disabled=nativeJCR||count<2||relatedAction.dataset.busy==='true';unlinkAction.disabled=nativeJCR||count<2||unlinkAction.dataset.busy==='true';
   // Nothing chosen: no bar. The tasks offered follow how many are chosen.
   if(!count)footer.hidden=true;
   citeAction.hidden=pickAction.hidden=collectToggle.hidden=!count;if(!count)collectRow.hidden=true;goNotes.hidden=goAnnots.hidden=count!==1;goCompare.hidden=count<2;goSide.hidden=count!==2;relations.hidden=count<2;
   for(const task of [goNotes,goAnnots,goCompare,goSide,citeAction,pickAction,collectToggle,collectGo])task.disabled=nativeJCR;
   for(const card of body.querySelectorAll('[data-item-id]'))card.dataset.selected=String(state.selected.has(card.dataset.itemId));
  }
  /* What the search box actually matches, per tab: notes by title and body,
     annotations by text and memo, attachments by name and type. It used to
     promise "제목·저자·태그·DOI·초록" everywhere. */
  const SEARCH_WHAT={explore:'제목·저자·태그·DOI·초록·내 메모 검색',recent:'제목·저자·태그·DOI·초록·내 메모 검색',notes:'노트·문헌 제목·저자 검색',annotations:'주석·메모·문헌 제목·저자 검색',attachments:'첨부파일 이름·형식 검색'};
  function setNavBadge(value){
   const cur=navButtons.get(state.tab);if(!cur)return;
   state.tabCount=Number.isFinite(value)?value:null;
   let badge=cur.querySelector('.sc-nav-count');
   if(!Number.isFinite(value)){badge?.remove();return;}
   if(!badge)badge=node('span',null,cur,{class:'sc-nav-count'});
   badge.textContent=value>999?'999+':String(value);if(value>999)badge.title=value.toLocaleString('en-US');else badge.removeAttribute('title');
  }
  function updateChrome(){
   sectionTitle.textContent=T(TABS.find(([id])=>id===state.tab)?.[1]||'');
   search.placeholder=T(SEARCH_WHAT[state.tab]||'제목·저자·태그·DOI·초록 검색');search.title=search.placeholder;
   const nativeJCR=state.tab==='journals'&&state.journalBrowser!=='openalex';
   const applicable=!nativeJCR&&FILTER_TABS.has(state.tab)&&state.tab!=='collections';controls.hidden=!applicable;filterPanel.hidden=!applicable;kindChips.hidden=!applicable;
   // 보유 문헌's own widened-search checkbox: nothing to widen without a query,
   // and the memo/note/annotation match it turns on is 보유 문헌's, not every tab's.
   recordsWrap.hidden=!(applicable&&state.tab==='explore'&&state.query.trim());
   // While the list is narrowed to a selection, the way back is one button, not a menu.
   let back=context.querySelector('.sc-scope-back');
   if(applicable&&state.scope==='selected'){if(!back){
    const fromOrigin=!!state.listOrigin;
    back=button(fromOrigin?'이전 목록으로':'전체 목록으로',()=>{
     if(state.listOrigin)return run(restoreListOrigin);
     state.scope='library';scope.value='library';state.selectionLabel='';
     // The search and filters set aside for the selection come back with the whole list.
     restoreKept();
     render();
    },null,{class:'sc-scope-back'});context.insertBefore(back,contextDetail.nextSibling);}}
   else back?.remove();
   // A route that left 보유 문헌 without touching scope -- a row's 주석 n,
   // say -- gets its own small way back, since the spot above only shows
   // once the scope itself says "선택한 문헌".
   let originBack=context.querySelector('.sc-list-origin-back');
   if(state.listOrigin&&!(applicable&&state.scope==='selected')){
    if(!originBack){originBack=button('이전 목록으로',()=>run(restoreListOrigin),null,{class:'sc-list-origin-back'});context.insertBefore(originBack,contextDetail.nextSibling);}
   }else originBack?.remove();
   {const scopeName=T(({library:'라이브러리',selected:'선택한 문헌',collection:'현재 컬렉션','collection-recursive':'현재·하위 컬렉션'})[state.scope]||'라이브러리'),inside=['notes','annotations','attachments'].includes(state.tab),
    // 내 기록 포함 widens 보유 문헌 past rows(): once exploreRows has resolved,
    // the count here is the merged list it drew, not the plain search.
    n=inside?model.filter(scoped(),parentOptions()).length:(state.tab==='explore'&&Number.isFinite(state.exploreCount)?state.exploreCount:rows().length);
   // The detail line says something the title does not; naming the page twice
   // says nothing.
   // A short note on why this particular selection, set by navigateSelection
   // -- "#a ∩ #b" for two tags crossed in 중첩 태그, say -- rather than the
   // reader having to remember what they clicked.
   // Count badge on the current nav item (premium dashboard look, user direction 2026-10-01).
   // The badge is the page's own result count: the papers listed on 보유·최근 문헌; on the pages that list
   // something else (notes, annotations, files, reading records) the page reports that number itself through
   // setNavBadge. The paper-scope count never stands in for them, and a page with no natural count shows none.
   for(const b of navButtons.values()){const old=b.querySelector('.sc-nav-count');if(old&&b.dataset.tab!==state.tab)old.remove();}
   if(['explore','recent'].includes(state.tab)&&applicable&&Number.isFinite(n))setNavBadge(n);
   else if(!Number.isFinite(state.tabCount))setNavBadge(null);
   const originNote=state.scope==='selected'&&state.selectionLabel?' · '+state.selectionLabel:'';
   contextDetail.textContent=nativeJCR?[runtime.jcrCatalog?.source?.provider,runtime.jcrCatalog?.source?.product].filter(Boolean).join(' · '):applicable?(state.scope==='library'?scopeName:T(`${scopeName} · ${n}개 문헌`))+originNote
    :state.tab==='matrix'?(matrixUsingPicker()?T(`비교 중 ${selected().length}편`):T(`현재 목록 ${rows().length}편`)):state.tab==='collections'?''
    :['related','authors','backlinks'].includes(state.tab)&&selected().length===1?selected()[0].title
    :state.selected.size===1?T('선택한 문헌 1개'):state.selected.size?T(`선택한 문헌 ${state.selected.size}개`):'';
    /* The chip names the scope; the count lives in the kind chips and the nav badge, and in the tooltip. */
    contextDetail.title=applicable&&Number.isFinite(n)?T(`${scopeName} · ${n}개 문헌`)+(inside?' · '+T('내용 검색'):''):'';}
   filterChips.replaceChildren();const labels={query:'검색',type:'유형'};
   for(const[key,label]of Object.entries(labels))if(state[key]){const value=state[key];button(`${label}: ${value} ×`,()=>{state[key]='';if(key==='query')search.value='';else if(key==='type')type.value='';else if(filterInputs.has(key))filterInputs.get(key).value='';return render();},filterChips,{'aria-label':label+' 필터 해제'});}
   drawRuleKinds();
   const ruleList=applicable?activeRules():[];for(const rule of ruleList)ruleChip(rule);
   const count=Object.keys(labels).filter(key=>state[key]).length+ruleList.length;
   if(count>1)button('모두 지우기',()=>resetFilters.click(),filterChips,{class:'sc-rule-clear','aria-label':'적용 중인 필터 모두 지우기'});
   filterSummary.textContent=T('상세 필터')+(count?' · '+T(`${count}개 적용`):'');leadIcon(filterSummary,'filter');filterSummary.dataset.active=String(count>0);filterChips.hidden=!applicable||!count;
   for(const group of nav.querySelectorAll('.sc-nav-group'))group.hidden=[...group.querySelectorAll('[data-tab]')].every(button=>button.hidden);
   updateSelectionUI();
  }
  function check(label,checked,fn,parent){const wrap=node('label',null,parent,{class:'sc-check'});const input=node('input',null,wrap,{type:'checkbox','aria-label':label});input.checked=checked;input.addEventListener('change',()=>fn(input.checked));node('span',label,wrap);return input;}
  function selectItem(id,on){state.annotationIDs.clear();on?state.selected.add(String(id)):state.selected.delete(String(id));updateSelectionUI();}
  function one(){const list=selected();if(list.length!==1)throw new Error('문헌을 하나 선택하세요.');return list[0];}
  async function discardPreview(p){if(!p)return;try{await p.discard?.();}catch(error){runtime.Z.logError?.(error);}finally{p.remove();if(preview===p)preview=null;}}
  /* The draft key is shared by every window. A memo editor never overwrites a draft it did not write. Another binding of THIS
     window (a redraw) is the same logical editor, so its draft is replaceable; a draft of another window, or an old plain
     one, that differs from the new text and from the stored memo (an empty one included: the memo may have been cleared)
     is moved to the kept drafts first, with its base. */
  function writeMemoDraft(input){
   const binding=memoBindings.get(input),key=input.dataset.draftKey;
   if(binding&&binding.base!==undefined&&binding.itemID!==undefined){
    const record=memoRecord(key),existing=draftText(key),meta=draftMeta(key);
    // Foreign: any shared draft this binding did not write (its owner may be alive, closed, or unknown) that differs from the new text and
    // the stored memo goes to the kept drafts first. A closed owner only matters when a draft is claimed on restore, never for overwriting.
    const foreign=typeof existing==='string'&&(!meta||meta.owner!==binding.id)&&existing!==input.value&&(existing!==storedMemo(binding.itemID)||memoPendingNow(binding.itemID));
    if(foreign)keepDraft(binding.itemID,existing,record?record.base:undefined,false,record?record.owner:undefined);
    updateDraft(key,input.value,binding.base,binding.id,binding.itemID);
    if(foreign)binding.drawKept?.();
    return;
   }
   updateDraft(key,input.value,binding?.base);
  }
  function rememberDraft(event){const input=event.target;if(input?.dataset?.draftKey&&input.localName!=='select'&&!['checkbox','password'].includes(input.type))writeMemoDraft(input);}
  body.addEventListener('input',rememberDraft);body.addEventListener('change',rememberDraft);
  function finishDraft(input,submitted,clearValue=false,token){
   const key=input.dataset.draftKey;
   // A memo draft is deleted only by the binding that owns it (and, for a completed job, only if nothing wrote it since the job began).
   const memo=memoBindings.get(input);
   if(memo&&memo.base!==undefined){if(!memo.finishOwn(submitted,token))return;if(clearValue)input.value='';return;}
   // A memo editor with no binding (a stand-in object, a detached node) owns nothing: it never deletes a memo draft.
   if(input.dataset?.memoItem!==undefined)return;
   const latest=cachedDrafts().get(key)??drafts.get(key)??input.value;
   // The editor may have changed, or been replaced by a notifier redraw, while saving.
   if(latest!==submitted)return;
   updateDraft(key,undefined);if(clearValue)input.value='';
  }
  /* Applying a generated result needs a result: the button is off while the box is empty. */
  function syncAIApply(){const apply=body.querySelector('[data-ai-apply]'),copyBtn=body.querySelector('[data-ai-copy]'),out=body.querySelector('.sc-ai-output');if(out){if(apply)apply.disabled=!out.value.trim();if(copyBtn)copyBtn.disabled=!out.value.trim();}}
  body.addEventListener('input',syncAIApply);
  function restoreDrafts(){for(const input of body.querySelectorAll('[data-draft-key]')){const key=input.dataset.draftKey,binding=memoBindings.get(input);if(binding&&binding.base!==undefined){binding.restore();continue;}if(!drafts.has(key))continue;input.value=drafts.get(key);}syncAIApply();}
  function clear(){
   if(jcrMount){state.jcrBrowserState=jcrMount.state;jcrMount.destroy();jcrMount=null;}
   abortAround();aroundRow=null;previewEpoch++;const previous=preview;preview=null;if(previous){previous.remove();void discardPreview(previous);}body.replaceChildren();visibleAnnotationIDs.clear();
   // Editors that were just taken off the screen: their autosave timers are cancelled (their input is already a draft the new editor restores).
   memoFields=memoFields.filter(entry=>{if(entry.field.isConnected)return true;const gone=memoBindings.get(entry.field);gone?.preserveDetached?.();gone?.cancelTimer?.();return false;});
  }

  /* One empty state for every tab: the tab's own outline icon, a heading, a muted hint, and the actions the page
     offers inside the same card (callers append buttons to the returned element's .sc-empty-actions). */
  function emptyCard(parent,{title='',hint='',icon,role}={}){
   const card=node('div',null,parent,{class:'sc-empty',...(role?{role}:{})});
   const name=icon||state.tab;
   if(ICONS[name]){const holder=node('span',null,card,{class:'sc-empty-icon','aria-hidden':'true'});setIcon(holder,name);const svg=holder.firstChild;if(svg){svg.setAttribute('width','20');svg.setAttribute('height','20');}}
   if(title)node('strong',T(title),card,{class:'sc-empty-title'});
   if(hint)node('span',T(hint),card,{class:'sc-empty-hint'});
   return card;
  }
  /* Actions that belong to an empty state sit inside its card, centred. */
  function emptyActions(card){return node('div',null,card,{class:'sc-empty-actions'});}
  /* An empty page: one heading and, when the text has a second sentence, a muted hint. */
  function empty(text,parent=body){
   const said=String(T(text)),cut=said.search(/[.!?。]\s+\S/);
   if(cut<0)return emptyCard(parent,{title:said});
   return emptyCard(parent,{title:said.slice(0,cut+1),hint:said.slice(cut+1).trim()});
  }
  /* The one empty-value marker: a dash in the faint ink, laid out like the values around it. */
  const noneMark=parent=>node('span','—',parent,{class:'sc-none-mark'});
  /* A figure with thousands separators, the same in every locale: 198,432. */
  const fmtN=value=>{const n=Number(value);return Number.isFinite(n)?n.toLocaleString('en-US'):String(value??'');};
  /* The one stat-tile row: a value over a label, the same tile on every page. entries are
     {value,label,title,pressed,onClick,disabled}; a tile with onClick is a button. Label never truncates:
     long qualifiers go in the title. */
  function statTiles(parent,entries,{label:aria}={}){
   const row=node('div',null,parent,{class:'sc-overview-facts',role:'group',...(aria?{'aria-label':T(aria)}:{})});
   row.dataset.tiles=String(Math.min(8,entries.filter(e=>e&&e.value!=null&&e.value!=='').length));
   for(const entry of entries.filter(e=>e&&e.value!=null&&e.value!=='')){
    const tile=entry.onClick?button('',entry.onClick,row,{class:'sc-overview-fact',...(entry.pressed!=null?{'aria-pressed':String(!!entry.pressed)}:{})}):node('span',null,row,{class:'sc-overview-fact'});
    if(entry.title)tile.title=T(entry.title);
    if(entry.disabled&&entry.onClick)tile.disabled=true;
    node('b',String(entry.value),tile);tile.appendChild(doc.createTextNode(' '));node('span',T(entry.label),tile,{class:'sc-overview-fact-label'});
   }
   return row;
  }
  function bar(parent=body){return node('div',null,parent,{class:'sc-actions'});}
  // The headline and its detail go in their own block so that everything a
  // caller appends afterwards -- buttons, checkboxes, selects -- lands in one
  // row beside them instead of stacking into a ninety-pixel card.
  /* A section of a page: its name in the text's ink, the count beside it in
     grey, over a rule. Every tab used to make its own -- an 11px grey capital
     label on one, a 19px title on another, none on a third -- so no two pages
     could be read the same way. */
  function sectionHead(label,count,parent=body,extra='',tag='h3'){
   const h=node(tag,null,parent,{class:'sc-hit-group sc-section-head'+(extra?' '+extra:''),...(tag==='h3'?{}:{role:'heading','aria-level':'3'})});
   node('span',T(label),h,{class:'sc-section-head-name'});
   // A real space between name and count, not only the gap the layout draws:
   // read as text, "논문1" is one word.
   if(count!=null&&count!==''){h.appendChild(doc.createTextNode(' '));node('span',String(count),h,{class:'sc-section-head-count'});}
   return h;
  }
  /* Every heading and what follows it, up to the next heading, is one soft
     container (user direction 2026-10-01). Done once after a page is drawn, so
     the tab code keeps appending to its own parents and nothing in it depends
     on the wrapper. Headings inside a card or a settings part are already in a
     container and stay as they are. */
  function groupSections(root=body){
   for(const head of [...root.querySelectorAll('.sc-section-head,.sc-path-head')]){
    const parent=head.parentNode;
    if(!parent||head.closest('.sc-group,.sc-card,.sc-author-news,.sc-settings-part'))continue;
    const group=doc.createElement('section');group.className='sc-group';
    parent.insertBefore(group,head);group.appendChild(head);
    while(group.nextSibling&&!group.nextSibling.classList?.contains('sc-section-head')&&!group.nextSibling.classList?.contains('sc-path-head'))group.appendChild(group.nextSibling);
   }
  }
  /* A label and its count: the count is a small rounded badge everywhere, and
     the button's text still reads "전체 6" as one phrase. */
  function withCount(target,label,count){
   target.textContent='';target.appendChild(doc.createTextNode(T(label)+' '));
   node('span',String(count),target,{class:'sc-count'});
   return target;
  }
  function card(title,subtitle,parent=body){
   const c=node('article',null,parent,{class:'sc-card'});
   const text=node('div',null,c,{class:'sc-card-text'});
   node('h3',title||'제목 없음',text);
   if(subtitle)node('p',subtitle,text,{class:'sc-muted'});
   return c;
  }
  function copy(value){runtime.Z.Utilities.Internal.copyTextToClipboard(value);message('클립보드에 복사했습니다.');}
  const scopeContext=()=>JSON.stringify([win.ZoteroPane?.getSelectedLibraryID?.()||runtime.Z.Libraries.userLibraryID,state.scope,state.scope.startsWith('collection')?(win.ZoteroPane?.getSelectedCollection?.()?.id??null):null]);
  async function load(){const token=++loadEpoch,context=scopeContext();if(observedContext!==context){state.collectionIDs=[];epoch++;clear();}observedContext=context;pageAnnotations.clear();pageAnnotationLoads.clear();message('문헌을 읽는 중…');const libraryID=win.ZoteroPane?.getSelectedLibraryID?.()||runtime.Z.Libraries.userLibraryID;
   if(state.libraryID!==libraryID){state.libraryID=libraryID;state.items=[];state.annotationIDs.clear();bindAI(null);}
   const snapshot=await library.snapshot(libraryID);if(disposed||token!==loadEpoch||panel.hidden)return;if(context!==scopeContext())return load();
   if(state.scope.startsWith('collection')){state.collectionIDs=[];const collection=win.ZoteroPane?.getSelectedCollection?.();if(collection){const members=await library.collectionItems(collection.id,{libraryID,recursive:state.scope==='collection-recursive'});if(disposed||token!==loadEpoch||panel.hidden)return;if(context!==scopeContext())return load();state.collectionIDs=members;}}
   // The reader's memo rides with each paper, so the search finds a paper by what was written about it.
   state.items=snapshot.map(i=>{const ref=runtime.Z.Items.get(Number(i.id));return {...i,...(ref?runtime.state(ref):{}),remark:ref?String(runtime.entry?.(ref)?.remark||''):''};});
   addVenueAbbreviations(state.items);
   /* 주석 n on a row: one grouped count per load, not one lookup per row.
      Absent in an older or fake library, rows simply show nothing extra. */
   if(typeof library.annotationCounts==='function'){
    const counts=await library.annotationCounts(state.items.map(i=>i.id)).catch(()=>({}));
    if(disposed||token!==loadEpoch||panel.hidden)return;if(context!==scopeContext())return load();
    for(const item of state.items)item.annotations=Number(counts[item.id])||0;
   }
   const existing=new Set(state.items.map(i=>i.id));state.selected=new Set([...state.selected].filter(id=>existing.has(id)));
   type.replaceChildren();node('option','모든 유형',type,{value:''});for(const t of [...new Set(state.items.map(i=>i.itemType))].filter(Boolean).sort())node('option',kindLabel(t),type,{value:t});type.value=state.type;drawKindChips();
   message('');
   // The lookups above took time: an input typed meanwhile is not rebuilt under the reader. The reload starts over.
   if(notifierLoad){notifierLoad=false;if(memoBusy()){if(!reloadDeferSince)reloadDeferSince=Date.now();if(reloadTimer)win.clearTimeout(reloadTimer);reloadTimer=win.setTimeout(reloadAgain,300);return;}}
   await render();
  }
  async function toggle(show){const wasHidden=panel.hidden,open=show===undefined?wasHidden:!!show;
   // Read the pane's selection before docking moves the window to another tab.
   const fromPane=open?runtime.selected(win).map(i=>String(i.id)):[];
   if(open&&wasHidden){syncDock();if(!tabID&&runtime.cache.workbenchUI?.docked===true&&canDock())dock({save:false});}
   if(tabID&&open){try{win.Zotero_Tabs.select(tabID);}catch(error){runtime.Z.logError?.(error);}}
   if(tabID&&!open){const id=tabID;tabID=null;closingSelf=true;moveBack();try{win.Zotero_Tabs.close(id);}catch(error){runtime.Z.logError?.(error);}closingSelf=false;}
   if(open&&wasHidden)returnFocus=doc.activeElement;panel.hidden=!open;if(open){
    /* A paper ticked in the panel used to be thrown away the moment a tab was
       reached through the menu or ⌘K, because the pane's (empty) selection
       replaced it. The pane wins only when it has something to say. */
    if(fromPane.length||wasHidden)state.selected=new Set(fromPane);await load();
    if(!disposed&&!runtime.cache.workbenchUI?.welcomed&&!welcome.childNodes.length){
     // One line, once, on the first open: where the features are and how a paper gets in.
     node('span','처음 여셨네요. 왼쪽 탭이 기능이고 ⌘/Ctrl K로 기능을 찾습니다. 보유 문헌 맨 위 요약과 읽기 진행에서 읽을 것을 고르고, 저자 추적의 새 논문 목록은 ↑↓와 e로 넘기며 확인합니다.',welcome);
     button('알겠어요',()=>{welcome.hidden=true;welcome.replaceChildren();saveUI({welcomed:true});},welcome);welcome.hidden=false;
    }if(!disposed&&!panel.hidden)(controls.hidden?body:search).focus?.();}else{navigationEpoch++;closeCommands(false);epoch++;loadEpoch++;aiEpoch++;clear();if(returnFocus?.isConnected&&!win.closed)returnFocus.focus?.();returnFocus=null;}}
  /* 읽기 대기, one store for every place that adds to it: kept per library
     by item, with when and from whom it came. Adding again keeps the first
     date and source; finished or started papers are not added in bulk. */
  const itemKeyOf=(()=>{let src=null,size=-1,byID=null;return id=>{if(src!==state.items||size!==(state.items||[]).length){src=state.items;size=(state.items||[]).length;byID=new Map((state.items||[]).map(i=>[String(i.id),i]));}return byID.get(String(id))?.key||'';};})();
  // By the item's library key like the rest of the plugin's records (the numeric id is local to this profile).
  const queueKey=(id,key)=>`${state.libraryID||''}:${key||itemKeyOf(id)||id}`;
  /* Entries saved when the queue was keyed by numeric item id are moved to the
     item's key as soon as the items are known; nothing is lost, a key that
     already is one is left alone. */
  const queueMemo={store:null,items:null};
  function readingQueue(){
   const store=runtime.cache.workbenchUI?.readingQueue||{};
   if(!state.items?.length||(queueMemo.store===store&&queueMemo.items===state.items))return store;
   const prefix=`${state.libraryID||''}:`,keys=new Set(state.items.map(i=>i.key)),ids=new Map(state.items.map(i=>[String(i.id),i.key]));
   let next=null;
   for(const k of Object.keys(store)){
    if(!k.startsWith(prefix))continue;
    const tail=k.slice(prefix.length);if(keys.has(tail))continue;
    const key=ids.get(tail);if(!key)continue;
    next||={...store};delete next[k];if(!next[prefix+key])next[prefix+key]=store[k];
   }
   if(next){runtime.cache.workbenchUI={...(runtime.cache.workbenchUI||{}),readingQueue:next};runtime.dirty=true;}
   queueMemo.store=next||store;queueMemo.items=state.items;
   return next||store;
  }
  // A wait counts until reading starts after it was set; one used up by reading is no longer waiting.
  const waitUsed=(id,entry)=>{const ref=runtime.Z.Items.get(Number(id)),read=Date.parse((ref&&runtime.entry?.(ref)?.lastRead)||'');return Number.isFinite(read)&&read>Date.parse(entry?.at||'');};
  const isQueued=id=>{const entry=readingQueue()[queueKey(id)];return !!entry&&!waitUsed(id,entry);};
  /* 추가: where an imported paper goes is said before and after. The label
     names the collection selected behind the panel (the import lands there);
     the status line says whether it was imported or already held. */
  const importTarget=()=>{try{return String(win.ZoteroPane?.getSelectedCollection?.()?.name||'');}catch(_){return '';}};
  const importLabel=()=>{const name=importTarget();return name?`추가 → ${name}`:'추가';};
  const importTip=()=>{const name=importTarget();return name?`선택한 컬렉션 ‘${name}’에 가져옵니다`:'지금 보는 라이브러리에 가져옵니다 (선택한 컬렉션이 없습니다)';};
  async function importHere(work){
   message('가져오는 중… '+String(work.title||work.doi).slice(0,50));
   const saved=await runtime.importWork(work,win);
   const label=String(saved?.[0]?.getField?.('title')||work.title||work.doi);
   message(saved?.existing?`이미 보유하고 있어 다시 가져오지 않았습니다 — ${label}`
    :`추가했습니다 — ${label}${saved?.collectionName?` → ${saved.collectionName}`:''}`);
   return saved;
  }
  // The panel's own shape of a paper just taken in, so its row can be drawn as owned before the list reloads.
  function ownedRecord(saved,work){
   const item=saved?.[0];if(!item||item.id===undefined||item.id===null)return null;
   const known=state.items.find(i=>String(i.id)===String(item.id));if(known)return known;
   return {id:String(item.id),key:item.key,libraryID:item.libraryID,title:String(item.getField?.('title')||work.title||''),year:String(work.year||''),venue:String(work.venue||''),doi:String(work.doi||''),authors:'',tags:[],related:[],status:'unread',seconds:0};
  }
  function setReadingQueue(items,on,people=[],reason=null){
   const next={...readingQueue()};let changed=0;
   for(const item of items){
    const key=queueKey(item.id,item.key);
    if(on){
     // Being read or finished is past waiting; 이어 읽기 and the list have it.
     if(item.status==='done'||item.status==='reading')continue;
     // A wait that reading has already used up may be set again, fresh.
     if(next[key]&&!waitUsed(item.id,next[key]))continue;
     // Why it was put by, when it came from a citation: which read papers, and in which direction.
     next[key]={at:new Date().toISOString(),people,...(reason?{reason}:{})};changed++;}
    else if(next[key]){delete next[key];changed++;}
   }
   return changed?saveUI({readingQueue:next}).then(()=>changed):Promise.resolve(0);
  }
  /* A paper named in the summary opens where it sits in the list, under
     its row, when it is on this page; the list keeps its search, filters
     and selection. Off the page, it opens by itself as before. */
  // One paper, found whatever the search and filters were: they are cleared, and the paper opened on its own.
  function showPaper(id){
   rememberListOrigin();
   state.query='';search.value='';for(const key of ['status','ratingMin','yearFrom','yearTo','type','tag'])state[key]='';state.rulesByTab={};
   for(const [key,input] of filterInputs)input.value='';type.value='';
   state.selected=new Set([String(id)]);state.scope='selected';scope.value='selected';
   return state.tab==='explore'?render():navigate('explore');
  }
  function openInList(it){
   rememberListOrigin();
   const id=String(it.id);
   if(body.querySelector(`[data-item-id="${id}"]`)){state.expandedPaperID=id;state.focusPaper=id;return render();}
   state.selected=new Set([id]);state.scope='selected';scope.value='selected';return render();
  }
  // The memo line on a row follows a save made under it, or goes when the memo is emptied.
  function syncRemark(card,value){
   const held=state.items.find(i=>String(i.id)===card.dataset.itemId);if(held)held.remark=String(value||'');
   const text=String(value||'').trim(),identity=card.querySelector('.sc-paper-identity');if(!identity)return;
   let line=identity.querySelector('.sc-paper-remark');
   if(!text){line?.remove();return;}
   if(!line){line=node('span',null,identity,{class:'sc-paper-remark'});}
   remarkLine(line,text);
  }
  /* Searching, the memo line shows the part that matched -- wherever in the
     memo it is -- and says the match was in the memo; otherwise its first
     line. The row and a save under it draw it the same way. */
  function remarkLine(line,own){
   line.replaceChildren();line.title=own.slice(0,600);
   const words=String(state.query||'').toLowerCase().split(/\s+/).filter(Boolean);
   const at=words.length?Math.min(...words.map(w=>own.toLowerCase().indexOf(w)).filter(i=>i>=0)):Infinity;
   if(Number.isFinite(at)){node('span',T('메모 일치'),line,{class:'sc-paper-remark-label'});const from=Math.max(0,at-30);line.appendChild(doc.createTextNode((from?'…':'')+own.slice(from,from+160).replace(/\s+/g,' ')));}
   else{node('span',T('메모'),line,{class:'sc-paper-remark-label'});line.appendChild(doc.createTextNode(own.split('\n')[0].slice(0,160)));}
  }
  async function paperList(items,{why,hits,lead:weekHead}={}){
   if(!items.length){
    if(!state.items.length){empty('라이브러리에 문헌이 없습니다. ZotPoP으로 논문을 찾아 추가하세요.');if(typeof runtime.Z?.ZotPoP?.openSearch==='function')button('ZotPoP 열기',()=>runtime.Z.ZotPoP.openSearch(win),bar(),{'data-variant':'primary','data-opens':'window'});return;}
    empty('조건에 맞는 문헌이 없습니다. 검색어나 필터를 지우세요. 새 논문을 찾으려면 ZotPoP 논문 검색을 사용하세요.');
    // The summary that set a filter is gone with the papers; the way back stays on the page.
    const emptyBar=bar();
    if(state.query||state.status||Object.values(parentOptions()).some(Boolean))button('검색과 필터 지우기',()=>resetFilters.click(),emptyBar,{'data-variant':'primary'});
    // Nothing held matches: the same words, one press away in ZotPoP's search of the literature.
    if(String(state.query||'').trim()&&typeof runtime.Z?.ZotPoP?.openSearch==='function'){const typed=String(state.query).trim();button(`ZotPoP에서 ‘${typed.length>40?typed.slice(0,40)+'…':typed}’ 찾기`,()=>runtime.Z.ZotPoP.openSearch(win,{keywords:typed}),emptyBar,{'data-opens':'window',title:T('보유 문헌에 없는 논문을 ZotPoP에서 같은 검색어로 찾습니다')});}
    return;
   }
   const pageSize=setting('explorePageSize',100),key=JSON.stringify([state.tab,state.scope,items.map(i=>i.id)]);
   if(state.pageKey!==key){state.pageKey=key;state.pageIndex=0;}
   state.pageIndex=Math.max(0,Math.min(state.pageIndex||0,Math.ceil(items.length/pageSize)-1));
   /* One shared basis for every count of "unread papers the read/done ones
      cite": the strip above the list and the fold below it used to run this
      separately and could disagree once a retracted paper was in the mix
      (the fold excluded it, the strip did not). Same bases, same exclusion,
      one function. */
   const works=typeof runtime.paperWorks==='function'?runtime.paperWorks():{};
   const workOf=p=>works[p.libraryID+':'+p.key]||works[String(p.id)]||null;
   const bareOA=v=>String(v||'').split('/').pop().toUpperCase();
   const withdrawn=it=>{const ref=runtime.Z.Items.get(Number(it.id));return Number(ref&&runtime.signalsOf?.(ref)?.rank)>=3;};
   const refsOf=p=>{const w=workOf(p);return Array.isArray(w?.references)?w.references:null;};
   const bases=scoped().filter(p=>p.status==='done'||p.status==='reading');
   const recorded=bases.filter(p=>refsOf(p)?.length);
   const citedUnreadOf=pool=>{
    const unread=pool.filter(it=>it.status!=='done'&&it.status!=='reading'&&!withdrawn(it));
    const byOA=new Map();for(const it of unread){const oa=bareOA(workOf(it)?.openalex);if(oa)byOA.set(oa,{it,from:[]});}
    for(const base of recorded)for(const ref of new Set(refsOf(base).map(bareOA)))byOA.get(ref)?.from.push(base);
    return {unread,cited:[...byOA.values()].filter(x=>x.from.length).sort((a,b)=>b.from.length-a.from.length||(Number(b.it.citations)||0)-(Number(a.it.citations)||0))};
   };
   /* The list in one line before its first row: how much of it has been
      read, how long that took, what it is worth by citation and journal, and
      what came in this month. Read off the rows already in hand; the bar is
      the reading status in the status column's own three tones. */
   /* 오늘의 읽기: opening the library with nothing chosen and nothing
      narrowed, the one step the summary below does not say: the paper being
      read most recently, at its page. The other two it used to carry were
      duplicates -- the cited-unread count is the fold's own summary line, and
      the longest-waiting paper is the first row of 읽기 대기 (oldest first),
      one press from the 읽기 대기 fact. */
   let todayDraw=null;
   if(state.tab==='explore'&&!state.selected.size&&!state.query&&!state.status&&!Object.values(parentOptions()).some(Boolean)&&state.scope==='library'){
    const DAY_=864e5,stamp=v=>runtime.localStamp?runtime.localStamp(v)?.getTime():Date.parse(v||'');
    const recent=state.items.filter(i=>i.status!=='done').map(i=>{const ref=runtime.Z.Items.get(Number(i.id));const e=ref?runtime.entry(ref):{};return {i,ref,at:stamp(e.lastRead)};})
     .filter(x=>x.ref&&Number.isFinite(x.at)&&Date.now()-x.at<=14*DAY_).sort((a,b)=>b.at-a.at)[0];
    // Local calendar date, not UTC: dismissing at 11pm should not reappear at 8am the same evening in a +9 zone.
    const now_=new Date(),todayKey=now_.getFullYear()+'-'+String(now_.getMonth()+1).padStart(2,'0')+'-'+String(now_.getDate()).padStart(2,'0');
    if(recent&&runtime.cache.workbenchUI?.todayHidden!==todayKey){
     /* The strip is the head of the summary card when there is one (drawn below), else it stands alone. */
     todayDraw=parent=>{
     const strip=node('div',null,parent,{class:'sc-today',role:'group','aria-label':T('오늘의 읽기')});
     node('span',T('오늘의 읽기'),strip,{class:'sc-today-label'});
     if(recent){const p_=runtime.pageProgress(recent.ref);const next=Number.isInteger(p_.lastPageIndex)&&p_.lastPageIndex<(Number(p_.total)||0)?p_.lastPageIndex:null;
      button(T('이어 읽기')+' · '+String(recent.i.title||'').slice(0,48)+(next!=null?' · '+T(`${next+1}쪽`):''),()=>run(()=>library.openItem(p_.attachmentID||recent.i.id,next!=null?{pageIndex:next}:undefined)),strip,{class:'sc-today-item','data-opens':'window',title:recent.i.title||''});}
     // Dismissed for today only: it comes back once the local date turns over.
     button(T('오늘은 닫기'),()=>run(async()=>{await saveUI({todayHidden:todayKey});await render();}),strip,{class:'sc-today-item sc-today-close',title:T('오늘 하루만 이 줄을 숨깁니다')});
     };
    }
   }
   // Narrowed to one paper by a search or filter, the summary stays: it is the way back.
   if(items.length>1||state.status||state.query||Object.values(parentOptions()).some(Boolean)){
    const n={unread:0,reading:0,done:0};let seconds=0,thisMonth=0;const ifs=[],cites=[];
    const month=new Date();month.setDate(1);month.setHours(0,0,0,0);
    for(const it of items){n[it.status==='done'?'done':it.status==='reading'?'reading':'unread']++;seconds+=Number(it.seconds)||0;
     if(Number.isFinite(Number(it.impactFactor))&&it.impactFactor!==null&&it.impactFactor!=='')ifs.push(Number(it.impactFactor));
     if(Number.isFinite(Number(it.citations))&&it.citations!==null&&it.citations!=='')cites.push(Number(it.citations));
     const added=runtime.localStamp?runtime.localStamp(it.dateAdded)?.getTime():Date.parse(it.dateAdded||'');if(added>=month.getTime())thisMonth++;}
    const median=list=>{if(!list.length)return null;const v=[...list].sort((a,b)=>a-b),m=Math.floor(v.length/2);return v.length%2?v[m]:(v[m-1]+v[m])/2;};
    const box=node('div',null,body,{class:'sc-overview'+(weekHead?' sc-recent-week':''),role:'group','aria-label':T('이 목록 요약')});
    // 오늘의 읽기 is the head of this card, not a loose strip over it.
    if(todayDraw){todayDraw(box);todayDraw=null;}
    /* 최근 문헌 puts its week in this card's place: one row of tiles, not a second strip over a card. */
    if(weekHead){node('span',T(weekHead.label),box,{class:'sc-overview-picks-label'});statTiles(box,weekHead.tiles);weekHead.drawn=true;}
    else{
    const meter=node('div',null,box,{class:'sc-overview-meter','aria-hidden':'true'});
    for(const key of ['done','reading','unread'])if(n[key])node('span',null,meter,{class:'sc-overview-'+key}).style.flexGrow=String(n[key]);
    const tiles=[];
    /* The reading counts are the way to those papers: pressed, the list shows
       only them (the status filter above says so, and clears it); pressed
       again, all of them. */
    const statusTile=(label,key)=>{if(!n[key])return;const on=activeRules().some(r=>r.id==='q-status'&&r.values[0]===key);tiles.push({value:fmtN(n[key]),label,pressed:on,title:on?'다시 누르면 모두 보기':'이 상태만 보기',onClick:()=>{if(on)dropQuick(state.tab,'q-status');else putQuick(state.tab,[quickStatus(key)]);render();}});};
    statusTile('완료','done');statusTile('읽는 중','reading');statusTile('안 읽음','unread');
    if(seconds>0)tiles.push({value:runtime.formatReadTime?runtime.formatReadTime(seconds,{compact:true}):Math.round(seconds/60)+'분',label:'읽음',title:T('이 목록 문헌의 누적 읽기 시간')});
    const mi=median(ifs),mc=median(cites);
    // Sorts by the same figure it names -- pressing again goes back to 기본 순서, as the column heads do.
    const sortTile=(label,sort,value,basis)=>{if(value==null||value==='')return;const on=state.sort===sort;tiles.push({value,label,pressed:on,title:basis+' · '+T(on?'다시 누르면 기본 순서':'이 순서로 정렬'),onClick:()=>{state.sort=on?'library':sort;const select=filterInputs.get?.('sort');if(select)select.value=state.sort;render();}});};
    // With how many papers each median rests on (in the tooltip): a figure from two of three is not one from three.
    if(mi!=null)sortTile('IF 중앙값','if-desc',mi.toFixed(1),T(`${ifs.length}/${items.length}편 기준`));
    if(mc!=null)sortTile('인용 중앙값','citations-desc',fmtN(Math.round(mc)),T(`${cites.length}/${items.length}편 기준`));
    // Papers put by for later, still waiting in this library: the way onto 읽기 진행's own queue section.
    const queuedHere=state.items.filter(it=>it.status!=='done'&&it.status!=='reading'&&isQueued(it.id));
    // The count is whole-library, like the queue store itself; 읽기 진행's own
    // queue section only shows what the current search and filters let through,
    // so a plain navigate() here used to land on a page missing whatever this
    // search had hidden. navigateSelection carries the exact papers counted as
    // the selection and sets the conflicting search aside (되돌리기 by 전체
    // 목록으로), so the destination shows precisely the number just pressed.
    const facts=statTiles(box,tiles);
    // Not a figure but a way on: one quiet button beside the tiles, so the tile row stays at six.
    if(queuedHere.length)button(T(`읽기 대기 ${queuedHere.length}편`),()=>navigateSelection('reading',queuedHere.map(it=>it.id)).then(()=>body.querySelector('.sc-reading-queue')?.scrollIntoView?.({block:'nearest'})),facts,{class:'sc-overview-queue',title:T('읽기 진행의 읽기 대기로 이동합니다')});
    /* "이번 달 추가" is a fact about the list, not a way into one: a quiet line under the tiles. */
    if(thisMonth)node('p',T(`이번 달 추가 ${thisMonth}편`),box,{class:'sc-muted sc-overview-month'});
    }
    /* 먼저 읽을 만한: of the unread papers here, the three the field cites
       most for their age -- citations a year since publication, so a classic
       does not bury last year's paper. From the figures on the rows; each
       title opens that paper's detail. */
    const year=new Date().getFullYear();
    const picks=items.filter(it=>it.status!=='done'&&it.status!=='reading'&&Number(it.citations)>0&&Number(it.year)&&!withdrawn(it))
     .map(it=>({it,rate:Number(it.citations)/Math.max(1,year-Number(it.year))})).sort((a,b)=>b.rate-a.rate).slice(0,3);
    /* What the papers being read, or read, cite among the unread ones here:
       the reading this library's own work leans on, from the reference lists
       the citation map already keeps -- nothing is asked for. Direct
       citations only, each counted once per citing paper. */
    if(bases.length){
     /* Both directions, in one fold: the unread papers the read ones cite
        (the ground under them, via the shared citedUnreadOf above), and the
        unread papers that cite the read ones (what built on them -- often
        too new to have citations of their own). Direct citations only, each
        citing paper counted once. */
     const {unread,cited}=citedUnreadOf(items);
     const baseByOA=new Map(bases.map(p=>[bareOA(workOf(p)?.openalex),p]).filter(([k])=>k));
     const withRefs=unread.filter(it=>refsOf(it)?.length);
     const citing=withRefs.map(it=>({it,from:[...new Set(refsOf(it).map(bareOA))].map(k=>baseByOA.get(k)).filter(Boolean)})).filter(x=>x.from.length)
      .sort((a,b)=>b.from.length-a.from.length||(Number(b.it.year)||0)-(Number(a.it.year)||0));
     const anyRecord=recorded.length||withRefs.length;
     // Without a single reference list there is nothing to open: one plain line says so and where to get them.
     if(!anyRecord)node('p',T('읽는 중·완료 문헌의 참고문헌 기록 없음')+' · '+T('관계 그래프에서 인용 목록을 가져오면 늘어납니다'),box,{class:'sc-muted sc-local-reading-note'});
     else{
      const fold=node('details',null,box,{class:'sc-local-reading-links'});
      if(state.localLinksOpen)fold.open=true;
      fold.addEventListener('toggle',()=>{state.localLinksOpen=fold.open;});
      node('summary',T(`읽는 중·완료 문헌과 인용으로 이어진 안 읽은 문헌 ${new Set([...cited,...citing].map(x=>x.it.id)).size}편`),fold);
      const section=(title,list,verb,note,key)=>{
       node('p',title,fold,{class:'sc-local-reading-head'});
       node('p',note,fold,{class:'sc-muted sc-local-reading-note'});
       if(!list.length){node('p',T('해당 문헌 없음'),fold,{class:'sc-muted sc-local-reading-note'});return;}
       const all=state.localLinksAll?.[key];
       for(const {it,from} of list.slice(0,all?list.length:10)){
        const line=node('div',null,fold,{class:'sc-local-reading-link'});
        button(String(it.title||T('제목 없음')),()=>openInList(it),line,{class:'sc-hit-title-link',title:it.title||''});
        node('span',verb(from.length),line,{class:'sc-local-reading-count'});
        node('span',from.slice(0,3).map(b=>String(b.title||'').slice(0,48)).join(' · ')+(from.length>3?' …':''),line,{class:'sc-muted sc-local-reading-from',title:from.map(b=>b.title).join('\n')});
        const waiting=isQueued(it.id);
        button(waiting?'대기 중':'읽기 대기',()=>run(async()=>{await setReadingQueue([it],!waiting,[],{direction:key,paperIDs:from.map(b=>String(b.id))});render();}),line,{class:'sc-local-reading-queue','aria-pressed':String(waiting)});
       }
       if(list.length>10)viewButton(all?'10편만 보기':T(`${list.length}편 모두 보기`),()=>{state.localLinksAll={...(state.localLinksAll||{}),[key]:!all};render();},fold,{class:'sc-local-reading-more'});
      };
      section(T('읽는 중·완료 문헌이 인용한 안 읽은 문헌'),cited,n=>T(`${n}편에서 인용`),T(`기준 ${bases.length}편 중 참고문헌 기록 ${recorded.length}편`),'cited');
      section(T('읽는 중·완료 문헌을 인용한 안 읽은 문헌'),citing,n=>T(`읽는 중·완료 문헌 ${n}편 인용`),T(`안 읽은 ${unread.length}편 중 참고문헌 기록 ${withRefs.length}편`),'citing');
     }
    }
    if(picks.length&&n.unread>1){
     /* A label, then one paper a line: the title, and its yearly citation rate flush right in a tabular column. */
     const line=node('div',null,box,{class:'sc-overview-picks'});
     node('span',T('안 읽은 문헌 · 연도 보정 인용순'),line,{class:'sc-overview-picks-label',title:T('안 읽은 문헌 중 출판 후 해마다 가장 많이 인용된 순서입니다. 철회된 문헌은 뺐습니다.')});
     for(const {it,rate} of picks){
      const pick=node('span',null,line,{class:'sc-overview-pick'});
      button(String(it.title||T('제목 없음')),()=>openInList(it),pick,{class:'sc-hit-title-link',title:it.title||''});
      node('span',T(`연 ${fmtN(Math.round(rate))}회 인용`),pick,{class:'sc-muted sc-overview-pick-rate'});
     }
    }
   }
   if(weekHead&&!weekHead.drawn){const solo=node('div',null,body,{class:'sc-overview sc-recent-week',role:'group','aria-label':T(weekHead.label)});node('span',T(weekHead.label),solo,{class:'sc-overview-picks-label'});statTiles(solo,weekHead.tiles);weekHead.drawn=true;}
   const start=state.pageIndex*pageSize,page=items.slice(start,start+pageSize);
   // The list is one soft group headed "Name · n" (groupSections wraps this head and what follows it).
   sectionHead(state.tab==='recent'?'최근 문헌':'보유 문헌',fmtN(items.length),body,'sc-list-head','div');
   // One toolbar over the column heads: the selection verbs at the left, the pager at the right end.
   const toolbar=node('div',null,body,{class:'sc-list-toolbar'});
   const choose=(values,on)=>{state.annotationIDs.clear();for(const item of values)on?state.selected.add(String(item.id)):state.selected.delete(String(item.id));render();};
   /* Three selection buttons were a row of their own over every list; they
      fold into one, left as the reader left it. */
   /* ...and that one sits in the column header's empty lead, over the
      checkboxes it acts on, instead of on a row of its own. */
   const selecting=node('details',null,null,{class:'sc-selection-tools'});
   if(state.selectionToolsOpen)selecting.open=true;
   selecting.addEventListener('toggle',()=>{state.selectionToolsOpen=selecting.open;});
   node('summary',T('선택 작업'),selecting);
   const picks=node('span',null,selecting,{class:'sc-selection-tools-body'});
   button('현재 페이지 선택',()=>choose(page,true),picks);button('현재 페이지 선택 해제',()=>choose(page,false),picks);button('검색 결과 전체 선택',()=>choose(items,true),picks);
   const waitable=selected().filter(i=>i.status!=='done'&&i.status!=='reading'&&!isQueued(i.id));
   if(waitable.length)button(T(`안 읽은 문헌 ${waitable.length}편 읽기 대기에 추가`),()=>run(async()=>{const n=await setReadingQueue(waitable,true);message(T(`읽기 대기에 ${n}편을 넣었습니다.`));render();}),picks);
   toolbar.appendChild(selecting);
   if(items.length>pageSize){
    const paging=node('div',null,toolbar,{class:'sc-pager'});
    node('span',`${fmtN(start+1)}–${fmtN(start+page.length)} / ${fmtN(items.length)}개`,paging,{role:'status','aria-label':'문헌 페이지 범위'});
    button('이전 페이지',()=>{state.pageIndex--;render();},paging).disabled=state.pageIndex===0;
    button('다음 페이지',()=>{state.pageIndex++;render();},paging).disabled=start+pageSize>=items.length;
   }
   /* One header over the figures, so a column reads as a column and its name
      is said once rather than on every row; a name sorts by it, highest first,
      and pressed again goes back to the library's order. */
   const columns=node('div',null,body,{class:'sc-paper-columns',role:'group','aria-label':T('정렬할 열')});
   // Over the titles the lead is blank; at a narrow width, where the figures wrap under each title, the heads become one line that says what they do.
   const lead=node('span',null,columns,{class:'sc-paper-columns-lead'});
   node('span',T('제목'),lead,{class:'sc-paper-columns-title'});
   node('span',T('정렬'),lead,{class:'sc-paper-columns-sortlabel'});
   for(const [key,label,sort] of [['impact','IF','if-desc'],['citations','인용','citations-desc'],['rating','별점','rating-desc'],['time','읽기','time-desc']]){
    const on=state.sort===sort;
    const b=viewButton(label,()=>{state.sort=on?'library':sort;const select=filterInputs.get?.('sort');if(select)select.value=state.sort;render();},columns,{class:'sc-paper-column','data-metric':key,'aria-pressed':String(on),title:T(on?'다시 누르면 기본 순서':'높은 순으로 정렬')});
    if(on)b.textContent=T(label)+' ↓';
   }
   node('span',null,columns,{class:'sc-paper-columns-tail'});
   const list=node('div',null,body,{class:'sc-paper-list'}),details=[],generation=epoch;for(const item of page){
   const c=node('article',null,list,{class:'sc-card sc-paper-card','data-item-id':item.id,'data-status':['reading','done'].includes(item.status)?item.status:'unread','data-selected':String(state.selected.has(item.id))});
   const heading=node('div',null,c,{class:'sc-paper-heading'}),pick=check('선택',state.selected.has(item.id),on=>selectItem(item.id,on),heading);pick.setAttribute('aria-label',item.title+' 선택');
   // The whole card selects, as an annotation card does; the checkbox was 14px of it.
   c.tabIndex=0;c.addEventListener('click',e=>{if(e.target.closest('button,input,label,textarea,a,select,summary,details'))return;selectItem(item.id,!state.selected.has(item.id));});
   c.addEventListener('dblclick',e=>{if(e.target.closest('button,input,label,textarea,a,select,summary,details'))return;run(()=>library.openItem(item.id));});
   c.addEventListener('keydown',e=>{if(e.target!==c)return;if(e.key===' '||e.key==='Enter'){e.preventDefault();selectItem(item.id,!state.selected.has(item.id));}});
   // A paper carries whatever colour it has been given; otherwise its reading state.
   const marked=runtime.highlightOf?.(runtime.Z.Items.get(Number(item.id)));
   if(marked)c.dataset.mark=marked;
   const identity=node('div',null,heading,{class:'sc-paper-identity'});
   /* The title has the first line to itself, with only the two actions at
      its end; the journal line and the figures share the second. A long
      biology title was cut to half its width by the figures beside it. */
   const mainline=node('div',null,identity,{class:'sc-paper-mainline'});
   const h3=node('h3',null,mainline,{class:'sc-paper-title',title:item.title||''});
   rich(h3,item.title||T('제목 없음'));
   const meta=node('span',null,identity,{class:'sc-paper-meta',title:[item.authors,item.venue].filter(Boolean).join(' · ')});
   // A list that is in an order for a reason says the reason first: 최근 문헌 says what happened, and when.
   const reason=why?.(item);
   // The kind (Preprint, patent, thesis...) opens the meta line, so the title always starts at the same x.
   if(item.itemType&&item.itemType!=='journalArticle'&&KIND_LABELS[item.itemType])node('span',kindLabel(item.itemType),meta,{class:'sc-status-chip sc-kind',title:kindLabel(item.itemType),'data-tone':'lime'});
   if(reason)node('span',reason,meta,{class:'sc-paper-why'});
   /* Journal · year · authors, each told apart by how it is set: the journal's full name in its own
      signature colour (no abbreviation badge beside a name that is already spelled out), the year
      quiet, the authors plain. Both themes' inks travel with the name; the stylesheet picks one. */
   const metaText=node('span',null,meta,{class:'sc-paper-meta-text'});
   if(item.venue){
    venueSpan(metaText,item.venue);
   }
   if(item.year)node('span',String(item.year),metaText,{class:'sc-paper-year'});
   if(item.authors)node('span',item.authors,metaText,{class:'sc-paper-authors'});
   /* What the reader wrote about the paper, first line, under what it is:
      the note that says why it was kept is worth more on the row than a
      third line of authors. Only when there is one. */
   const noteRef=runtime.Z.Items.get(Number(item.id));
   const own=String((noteRef&&runtime.entry?.(noteRef)?.remark)||'').trim();
   if(own)remarkLine(node('span',null,identity,{class:'sc-paper-remark'}),own);
   /* A43: 내 기록 포함 named where this paper matched -- a memo already on
      the row above, or the note/annotation that pulled an otherwise-unmatched
      paper into the list. Pressing it goes where that was found. */
   const hit=hits?.get(String(item.id));
   if(hit){
    const hb=node('button',`${hit.label} · "${hit.text}"`,identity,{class:'sc-paper-search-hit',type:'button',title:T('눌러서 이동합니다')});
    hb.addEventListener('click',event=>{event.stopPropagation();
     if(hit.kind==='memo'){state.expandedPaperID=String(item.id);state.focusPaper=String(item.id);render();return;}
     // Straight to this paper's exact note or annotation, not just the tab:
     // narrow the scope to it and keep the query, so the tab's own search
     // filters down to the record that matched here.
     rememberListOrigin();state.selected=new Set([String(item.id)]);state.scope='selected';scope.value='selected';
     navigate(hit.kind==='note'?'notes':'annotations');});
   }
   const metrics=node('div',null,heading,{class:'sc-metrics'});
   metric(metrics,{unit:'IF',name:'impact',text:item.impactFactor??'',tone:impactTone(item.impactFactor),label:'저널 영향력 지수'});
   metric(metrics,{unit:'인용',name:'citations',text:item.citations==null||item.citations===''?'':fmtN(item.citations),label:item.citationSource?`인용 수 · ${item.citationSource}`:'인용 수 · 출처 미확인'});
   // Stars only once a paper has been rated: five hollow stars on every row were noise.
   // The slot is always there, so the figures line up down the list; it is
   // filled only once the paper has been rated.
   const stars=node('span',null,metrics,{class:'sc-metric sc-stars',title:item.rating?`별점 ${item.rating}/5`:'별점 없음'});stars.dataset.metric='rating';
   node('span',item.rating?'\u2605'.repeat(item.rating)+'\u2606'.repeat(5-item.rating):'',stars,{class:'sc-metric-value'});
   const timeCell=metric(metrics,{unit:'읽기',name:'time',text:Number(item.seconds)>0?(runtime.formatReadTime?runtime.formatReadTime(item.seconds,{compact:true}):Math.floor(Number(item.seconds))+'초'):'',label:'읽은 시간'});
   /* How far in, beside how long: twenty minutes on a paper says little
      until it is set against four of eight pages. A short grey meter, no
      colour: the pages read over the pages the PDF has. */
   let sub=null;
   {const ref=runtime.Z?.Items?.get?.(Number(item.id)),p=ref&&typeof runtime.pageProgress==='function'?runtime.pageProgress(ref):null;
    if(p?.total&&timeCell){sub=sub||node('span',null,timeCell,{class:'sc-metric-sub'});const meter=node('span',null,sub,{class:'sc-row-progress',role:'img','aria-label':T(`전체 ${p.total}쪽 중 ${p.visited}쪽 읽음`),title:T(`전체 ${p.total}쪽 중 ${p.visited}쪽 읽음`)});
     node('span',null,meter,{class:'sc-row-progress-fill'}).style.width=Math.round(100*p.visited/p.total)+'%';
     node('span',`${p.visited}/${p.total}`,sub,{class:'sc-row-progress-text','aria-hidden':'true'});}}
   // Loaded once per list, grouped by parent (see load()); a paper with no annotations shows nothing extra.
   // A count used to be all it said; a click now takes the reader straight to
   // just this paper's marks, the scope and everything else on the list kept.
   if(Number(item.annotations)>0&&timeCell){sub=sub||node('span',null,timeCell,{class:'sc-metric-sub'});button(T(`주석 ${fmtN(item.annotations)}`),()=>{rememberListOrigin();state.annotationPaperID=String(item.id);navigate('annotations');},sub,{class:'sc-row-annotations'});}
   const actions=bar(mainline);actions.classList.add('sc-paper-actions');button('열기',()=>library.openItem(item.id),actions,{'data-opens':'window','data-variant':'primary'});/* 자세히 opens the paper under its own row: the list keeps its search,
      filters, page, selection and place. One at a time; pressed again, it
      closes and the focus goes back to it. */
   const open_=state.expandedPaperID===String(item.id);
   viewButton(open_?'접기':'자세히',()=>{state.expandedPaperID=open_?'':String(item.id);state.focusPaper=String(item.id);render();},actions,{'aria-expanded':String(open_),'data-detail-for':String(item.id)});
   if(open_)c.dataset.expanded='true';
   const detailed=state.scope==='selected'||state.expandedPaperID===String(item.id);
   if(detailed&&item.status!=='done'&&item.status!=='reading'){
    // From any row, not only the inbox: the paper waits on 읽기 진행 until reading starts.
    const acts=node('div',null,c,{class:'sc-paper-detail-actions'});
    const waiting=isQueued(item.id);
    button(waiting?'읽기 대기에서 빼기':'읽기 대기',()=>run(async()=>{await setReadingQueue([item],!waiting);message(waiting?'읽기 대기에서 뺐습니다.':'읽기 진행의 읽기 대기에 넣었습니다.');render();}),acts,{'aria-pressed':String(waiting)});
   }
   if(detailed&&typeof runtime.publishedStatus==='function'){
    const pubRef=runtime.Z.Items.get(Number(item.id)),holder=node('div',null,c,{class:'sc-paper-published'});
    Promise.resolve(pubRef?runtime.publishedStatus(pubRef):null).then(st=>{
     if(!st||disposed||!holder.isConnected)return;
     const said=[T('게재됨'),st.published.venue,st.published.year].filter(Boolean).join(' · ');
     node('span',st.linked?said+' · '+T('연결됨'):said,holder,{class:'sc-muted'});
     if(!st.linked)publishedButton(pubRef,st.held,holder,()=>render());
    }).catch(error=>runtime.Z.logError?.(error));
   }
   if(detailed){node('p',item.abstract||'초록이 없습니다.',c,{class:'sc-paper-detail'});const ref=runtime.Z.Items.get(Number(item.id));
    /* Where this paper is filed, each path a door back to the same jump the
       item-tree menu offers -- the left pane's own selection, not a window. */
    const filedIn=typeof runtime.collectionEntries==='function'?runtime.collectionEntries(ref):[];
    if(filedIn.length){
     const line=node('div',T('컬렉션: '),c,{class:'sc-paper-collections'});
     filedIn.forEach((entry,index)=>{
      if(index)node('span',' · ',line);
      button(entry.path,()=>run(async()=>{
       await win.ZoteroPane.collectionsView.selectCollection(Number(entry.id));
       win.ZoteroPane.selectItem?.(Number(item.id));
      }),line,{class:'sc-paper-collection-link',title:T('클릭하면 왼쪽 컬렉션 트리에서 이 컬렉션으로 이동합니다')});
     });
    }
    const remark=node('textarea',null,c,{'aria-label':'읽기 메모',placeholder:'읽기 메모'});remark.dataset.draftKey=JSON.stringify(['remark',state.libraryID,item.id]);remark.dataset.memoItem=String(item.id);
    const loaded=String(runtime.entry(ref).remark||'');remark.value=loaded;
    const remarkBinding=bindMemo(remark,(value,base,answer)=>library.setRemark(item.id,value,{base,answer}),item.title||'문헌',{manual:true,memo:{itemID:item.id,base:loaded,host:c}});
    remarkBinding.restore();
    button('메모 저장',async()=>{const submitted=remark.value,token=remarkBinding.draftToken();const out=await remarkBinding.commit({force:true,throws:true});if(out.stale||!out.ok){message('저장된 메모가 그 사이 바뀌어 아무것도 덮어쓰지 않았습니다. 아래에서 고르세요.',true);return;}finishDraft(remark,submitted,false,token);syncRemark(c,remarkBinding.base);message('메모를 저장했습니다.');},c,{'data-writes':'library'});}
   if(detailed&&(state.scope!=='selected'||items.length===1))details.push((async()=>{
    const results=await Promise.allSettled([library.notes([item.id]),library.annotations([item.id])]);
    if(disposed||epoch!==generation||!c.isConnected)return;
    for(const [index,result]of results.entries()){
     if(!enabled(index?'renderItemAnnotations':'renderItemNotes'))continue;
     const label=index?'주석':'노트',section=node('details',null,c,{class:'sc-evidence'});node('summary',label+(result.status==='fulfilled'?' · '+result.value.length:' · 확인 필요'),section);
     if(result.status==='rejected'){node('p','불러오지 못했습니다. 새로고침으로 다시 시도하세요.',section);continue;}
     if(result.value.length<=setting('inlineEvidenceCount',5))section.setAttribute('open','');
     if(!result.value.length){node('p',index?'주석이 없습니다.':'노트가 없습니다.',section);continue;}
     const evidence=node('div',null,section);let visible=0,more;
     const append=amount=>{for(const value of result.value.slice(visible,visible+amount)){const detail=card(index?`p.${value.pageLabel||((value.pageIndex??0)+1)}`:value.title,null,evidence),text=String(value.text||'');const paragraph=node('p',text.length>setting('maxExcerptLength',1200)?text.slice(0,setting('maxExcerptLength',1200))+'…':text,detail);if(text.length>setting('maxExcerptLength',1200))button('전체 내용 보기',()=>{paragraph.textContent=text;},detail);if(index&&value.comment)node('p',value.comment,detail);button(index?'주석 원문 열기':'문헌 노트 편집',()=>library.openItem(value.id),detail,{'data-opens':'window'});}visible=Math.min(result.value.length,visible+amount);if(more){more.textContent=label+' 더 보기 · '+(result.value.length-visible)+'개 남음';if(visible>=result.value.length)more.remove();}};
     append(setting('inlineEvidenceCount',5));if(visible<result.value.length)more=viewButton(label+' 더 보기 · '+(result.value.length-visible)+'개 남음',()=>append(20),section);
    }
   })());
  }
   // Back to the 자세히 that was pressed, so the keyboard does not lose its place.
   if(state.focusPaper){body.querySelector(`[data-detail-for="${state.focusPaper}"]`)?.focus?.();state.focusPaper='';}
   await Promise.all(details);}
  async function drawRecent(){
   // Zotero's dates are UTC without a zone, the reading record's carry one: both are read as UTC, or a paper read this morning ranked below one added last night.
   const timestamp=value=>{if(typeof value==='number')return Number.isFinite(value)?value:0;const parsed=runtime.localStamp?runtime.localStamp(value)?.getTime():Date.parse(value||'');return Number.isFinite(parsed)?parsed:0;};
   const activity=item=>Math.max(timestamp(item.lastRead),timestamp(item.dateModified),timestamp(item.dateAdded));
   const cap=setting('recentCount',50);
   // A week fact pressed narrows the list to that kind of activity in the last seven days.
   const weekStart=Date.now()-7*864e5,kinds={read:'lastRead',added:'dateAdded',edited:'dateModified'};
   const kindField=kinds[state.recentKind];
   const recent=rows().filter(item=>activity(item)>0&&(!kindField||timestamp(item[kindField])>=weekStart)).sort((a,b)=>(kindField?timestamp(b[kindField])-timestamp(a[kindField]):activity(b)-activity(a))||String(a.id).localeCompare(String(b.id))).slice(0,cap);
   /* With nothing recent, "…최근인 순서로 0편입니다" sat over an empty-state
      message and the two read as a page that had failed. The order is said
      only when there is something in it. */
   if(recent.length)node('p',`마지막 읽기·수정·추가 시각이 최근인 순서로 ${recent.length}편입니다.`,body,{class:'sc-muted'});
   /* The week in one line: how many papers were read, added and edited in
      the last seven days, across the whole scope rather than the fifty shown. */
   const week=weekStart,all=rows();
   const inWeek=field=>all.filter(item=>timestamp(item[field])>=week).length;
   const weekRead=all.filter(item=>timestamp(item.lastRead)>=week);
   const weekSeconds=weekRead.reduce((n,item)=>n+(Number(item.seconds)||0),0);
   let weekLead=null;
   if(state.recentKind||(recent.length&&(weekRead.length||inWeek('dateAdded')||inWeek('dateModified')))){
    /* The week is one row of tiles (drawn as the head of the summary card by paperList): a figure and its verb. */
    const tile=(label,value,kind)=>{
     const on=state.recentKind===kind;
     return {value:T(`${fmtN(value)}편`),label,pressed:on,disabled:!value&&!on,title:on?'다시 누르면 모두 보기':'이것만 보기',onClick:()=>{state.recentKind=on?'':kind;render();}};
    };
    weekLead={label:'지난 7일',tiles:[tile('읽음',weekRead.length,'read'),tile('추가',inWeek('dateAdded'),'added'),tile('수정',inWeek('dateModified'),'edited')]};
    if(weekSeconds>0)weekLead.tiles.push({value:runtime.formatReadTime?runtime.formatReadTime(weekSeconds,{compact:true}):Math.round(weekSeconds/60)+'분',label:'읽은 시간',title:'이번 주에 읽은 문헌들이 지금까지 쌓은 전체 읽기 시간입니다'});
   }
   // Nothing recent in a scope that has papers is not a search that missed:
   // "검색어나 필터를 지우세요" pointed at filters that were not set.
   if(!recent.length&&rows().length){
    if(state.recentKind){empty('지난 7일에 이 활동이 있었던 문헌이 검색 결과에 없습니다.');button('모두 보기',()=>{state.recentKind='';render();},bar(),{'data-variant':'primary'});return;}
    empty('이 범위에는 최근 활동 시각이 기록된 문헌이 없습니다. 문헌을 열어 읽거나 추가·수정하면 여기에 표시됩니다.');return;}
   const today=new Date();today.setHours(0,0,0,0);
   const what=item=>{
    const read=timestamp(item.lastRead),added=timestamp(item.dateAdded),changed=timestamp(item.dateModified);
    // Narrowed to one kind, the row says that kind's date, not whichever came last.
    const at=kindField?timestamp(item[kindField]):Math.max(read,added,changed);
    const kind=kindField?{lastRead:'읽음',dateAdded:'추가',dateModified:'수정'}[kindField]:at===read?'읽음':at===added?'추가':'수정';
    const days=Math.max(0,Math.ceil((today.getTime()-at)/864e5));
    // Added this week and never opened: the stack that grows without being read.
    // Only what the record can say: no reading time, no reading date, not marked read -- no reading recorded.
    const unopened=kind==='추가'&&!read&&!(Number(item.seconds)>0)&&item.status!=='done'&&item.status!=='reading'&&Date.now()-added<7*864e5?' · '+T('읽기 기록 없음'):'';
    return T(kind)+' · '+(at>=today.getTime()?T('오늘'):T(`${days}일 전`))+unopened;
   };
   await paperList(recent,{why:what,lead:weekLead});
  }
  /* The citation map.

     The old graph joined papers that shared a tag or an author and drew every
     node as the same grey dot at the same size. Sharing a tag is a fact about
     how the library was filed, not about the papers, so the picture told you
     what you had already typed.

     This one is built from the citation record, the way the field's paper-map
     tools build one: a solid arrow where one paper cites another, a faint
     thread where two cite many of the same works, node size by how often the
     paper has been cited, and node colour by publisher, which is the same
     coding the journal column uses. */
  // The panel follows the system scheme unless the user has pinned one, and the
  // graph's marks have to be built for whichever is actually showing.
  function darkScheme(){
   const pinned=panel.getAttribute('data-theme');
   if(pinned==='dark')return true;
   if(pinned==='light')return false;
   try{return !!win.matchMedia&&win.matchMedia('(prefers-color-scheme: dark)').matches;}catch(error){return false;}
  }

  /* The frame follows the map: three papers do not need the height of thirty.
     Both drawing paths go through here, because the one that did not set the
     count fell back to twelve and drew taller than the fixed frame it replaced. */
  /* The drawing's own height follows the frame's. Shrinking only the frame
     left an 860x540 drawing fitted into 228 pixels, which scaled 11px labels to
     under 5px. Same formula as the CSS height, so the scale stays near one. */
  const graphHeight=nodes=>Math.max(220,Math.min(540,90+Math.max(1,nodes||0)*46));
  /* And its width follows the panel's. Laid out at 860 and fitted into a 640px
     narrow panel, an 11px label came out at 8px (Codex). A graph that scrolls
     sideways is worse to read than one laid out for the room it has. */
  let graphDrawnWidth=0;
  const graphWidth=()=>{
   const cs=win.getComputedStyle?.(body);
   const inner=(body.clientWidth||0)-(parseFloat(cs?.paddingLeft)||0)-(parseFloat(cs?.paddingRight)||0);
   // No layout (a test DOM, a hidden panel): the old fixed width.
   const width=inner>0?Math.max(280,Math.min(1100,Math.round(inner))):860;
   graphDrawnWidth=width;
   return width;
  };
  /* A graph is laid out for the width it was drawn at. Narrowing the panel
     afterwards scaled the drawing, and its 11px labels with it, down to 6px
     (Codex, round 2). When the body's width moves by more than a few pixels
     while the graph is showing, it is drawn again at the new width. */
  function syncNoteOverflow(){
   for(const text of body.querySelectorAll('.sc-note-text:not(.sc-note-open)')){
    const more=text.parentElement?.querySelector('.sc-note-more');
    if(!more)continue;
    // An excerpt is always part of a note, however short it looks once laid out.
    more.hidden=!(text.classList.contains('sc-note-excerpt')||text.dataset.excerpt==='true'||text.dataset.truncated==='true'||text.scrollHeight>text.clientHeight+1);
   }
  }
  let graphResize=null,graphResizeTimer=null;
  if(typeof win.ResizeObserver==='function'){
   graphResize=new win.ResizeObserver(()=>{
    if(disposed||panel.hidden)return;
    if(state.tab==='notes'){syncNoteOverflow();return;}
    if(state.tab!=='graph'||!graphDrawnWidth)return;
    const cs=win.getComputedStyle?.(body);
    const inner=Math.round((body.clientWidth||0)-(parseFloat(cs?.paddingLeft)||0)-(parseFloat(cs?.paddingRight)||0));
    if(inner<=0||Math.abs(Math.max(280,Math.min(1100,inner))-graphDrawnWidth)<24)return;
    if(graphResizeTimer)win.clearTimeout(graphResizeTimer);
    graphResizeTimer=win.setTimeout(()=>run(render),180);
   });
   graphResize.observe(body);
  }
  function graphCanvas(W,H,nodes,label){
   const svg=doc.createElementNS(SVG,'svg');
   svg.setAttribute('viewBox',`0 0 ${W} ${H}`);svg.setAttribute('class','sc-graph');
   // The frame takes the drawing's own height, so the two cannot disagree.
   svg.style.setProperty('--sc-graph-height',H+'px');
   svg.setAttribute('aria-label',label);body.appendChild(svg);
   return svg;
  }
  /* ---- 관계 그래프 범위: 라이브러리 · 컬렉션 · 논문 하나 ------------------
     The scope is chosen at the top of the tab and kept. Library is the whole
     shelf as before; 컬렉션 draws only the papers filed in one folder (and
     optionally below it); 논문 하나 draws one paper with what it cites and what
     cites it. Both read the reference lists already stored, so neither asks
     OpenAlex anything; the one request in this block is "외부 인용 논문도 보기",
     and it is made only when that button is pressed. */
  const GRAPH_KINDS=[['library','라이브러리'],['collection','컬렉션'],['paper','논문 하나']];
  const graphRecord=works=>item=>{
   const work=works[item.libraryID+':'+item.key]||works[String(item.id)]||null;
   return {id:String(item.id),title:item.title,year:Number(item.year)||null,citations:Number(item.citations)||0,venue:item.venue,
    openalex:bareWork(work&&work.openalex),references:work&&Array.isArray(work.references)?work.references.map(bareWork):[]};
  };
  const itemOf=id=>state.items.find(i=>String(i.id)===String(id))||null;
  const graphLibraryID=()=>win.ZoteroPane?.getSelectedLibraryID?.()||runtime.Z.Libraries?.userLibraryID||1;
  // The paper the one-paper graph is about: the reader's pick, else the first selected paper (kept from then on).
  function graphPaperID(){
   if(state.graphPaper&&itemOf(state.graphPaper))return String(state.graphPaper);
   const first=[...state.selected].find(id=>itemOf(id));
   if(first!=null){state.graphPaper=String(first);saveUI({graphPaper:state.graphPaper});return state.graphPaper;}
   return null;
  }
  // Collections come from the library service once, and again when the list is older than half a minute.
  function graphCollectionList(){
   const lib=graphLibraryID();
   /* The list belongs to one library; another library's is never shown, and an answer for a library the reader has left is dropped. */
   if(state.graphCollectionsLib!==lib){state.graphCollections=null;state.graphCollectionsAt=0;state.graphCollectionsLib=lib;}
   const fresh=state.graphCollections&&Date.now()-(state.graphCollectionsAt||0)<30000;
   if(fresh||state.graphCollectionsLoading===lib)return state.graphCollections||null;
   state.graphCollectionsLoading=lib;
   const settle=list=>{
    if(disposed||graphLibraryID()!==lib||state.graphCollectionsLib!==lib)return false;
    const changed=JSON.stringify(list)!==JSON.stringify(state.graphCollections);
    state.graphCollections=list;state.graphCollectionsAt=Date.now();return changed;
   };
   Promise.resolve().then(()=>library.collections(lib)).then(list=>settle(Array.isArray(list)?list:[]),error=>{runtime.Z.logError?.(error);return settle(state.graphCollections||[]);})
    .then(changed=>{if(state.graphCollectionsLoading===lib)state.graphCollectionsLoading=null;if(changed&&!disposed&&state.tab==='graph')run(render);else if(!disposed&&graphLibraryID()!==lib&&state.tab==='graph')run(render);});
   return state.graphCollections||null;
  }
  function graphCollectionOptions(query){
   const list=graphCollectionList()||[],q=String(query||'').trim().toLowerCase();
   const kids=new Map();for(const c of list){const k=c.parentID==null?'':String(c.parentID);if(!kids.has(k))kids.set(k,[]);kids.get(k).push(c);}
   const byID=new Map(list.map(c=>[String(c.id),c]));
   const pathOf=c=>{const parts=[c.name];let p=c.parentID!=null?byID.get(String(c.parentID)):null,guard=0;while(p&&guard++<20){parts.unshift(p.name);p=p.parentID!=null?byID.get(String(p.parentID)):null;}return parts;};
   const out=[],walk=(parent,depth)=>{for(const c of (kids.get(parent)||[]).slice().sort((a,b)=>String(a.name).localeCompare(String(b.name)))){
    if(q){if(String(c.name).toLowerCase().includes(q))out.push({id:String(c.id),text:pathOf(c).join(' › '),count:c.count,depth:0});}
    else out.push({id:String(c.id),text:c.name,count:c.count,depth});
    walk(String(c.id),depth+1);}};
   walk('',0);return out;
  }
  function graphPaperOptions(query){
   const q=String(query||'').trim().toLowerCase();
   const rowsOut=state.items.filter(i=>!q||[i.title,i.authors,i.venue,i.year].join(' ').toLowerCase().includes(q));
   return rowsOut.map(i=>({id:String(i.id),text:i.title||'제목 없음',sub:[String(i.authors||'').split(';')[0].trim(),i.year].filter(Boolean).join(' · '),depth:0}));
  }
  /* The picker is an in-page list under the scope bar, never a native popup or a window: a search box over a
     listbox. Down arrow moves into the list, up and down move inside it, Enter picks, Escape closes. */
  function graphPicker(slot,trigger,{label,options,currentID,onPick,open}){
   const panel=node('div',null,slot,{class:'sc-pick-panel',role:'group','aria-label':label});panel.hidden=!open;
   trigger.setAttribute('aria-expanded',String(!!open));
   const search=node('input',null,panel,{type:'search',placeholder:label+' 검색','aria-label':label+' 검색'});
   const list=node('div',null,panel,{class:'sc-pick-list',role:'listbox','aria-label':label});
   const MAX=60;
   const options$=()=>[...list.querySelectorAll('[role=option]')];
   const fill=()=>{
    list.replaceChildren();const all=options(search.value);
    if(!all.length)node('p',search.value?'맞는 항목이 없습니다.':'고를 수 있는 항목이 없습니다.',list,{class:'sc-muted sc-pick-empty'});
    for(const o of all.slice(0,MAX)){
     const opt=node('button',null,list,{type:'button',role:'option','aria-selected':String(String(o.id)===String(currentID)),'data-value':o.id,class:'sc-pick-option'});
     opt.style.paddingInlineStart=(8+(o.depth||0)*16)+'px';
     node('span',o.text,opt,{class:'sc-pick-text'});
     if(o.sub)node('span',o.sub,opt,{class:'sc-pick-sub'});
     if(o.count!=null)node('span',String(o.count),opt,{class:'sc-count'});
     opt.addEventListener('click',()=>onPick(o.id));
    }
    if(all.length>MAX)node('p',`${all.length-MAX}개 더 있습니다. 검색으로 좁히세요.`,list,{class:'sc-muted sc-pick-empty'});
   };
   fill();search.addEventListener('input',fill);
   const close=()=>{panel.hidden=true;trigger.setAttribute('aria-expanded','false');trigger.focus?.();};
   panel.addEventListener('keydown',e=>{
    const opts=options$(),at=opts.indexOf(e.target);
    if(e.key==='Escape'){e.preventDefault();close();}
    else if(e.key==='ArrowDown'){e.preventDefault();(opts[at+1]||opts[0])?.focus?.();}
    else if(e.key==='ArrowUp'){e.preventDefault();if(at<=0)search.focus?.();else opts[at-1].focus?.();}
    else if(e.key==='Home'&&at>=0){e.preventDefault();opts[0]?.focus?.();}
    else if(e.key==='End'&&at>=0){e.preventDefault();opts[opts.length-1]?.focus?.();}
    else if(e.key==='Enter'&&e.target===search){e.preventDefault();const first=opts[0];if(first)onPick(first.getAttribute('data-value'));}
   });
   trigger.addEventListener('click',()=>{const show=panel.hidden;panel.hidden=!show;trigger.setAttribute('aria-expanded',String(show));if(show)search.focus?.();});
   return panel;
  }
  function drawGraphScope(){
   const kind=state.graphKind;
   const sb=bar();sb.classList.add('sc-graph-scope');
   node('span','범위',sb,{class:'sc-graph-scope-label'});
   const seg=node('div',null,sb,{class:'sc-segmented',role:'group','aria-label':'그래프 범위'});
   for(const[k,label]of GRAPH_KINDS)viewButton(label,()=>{state.graphKind=k;saveUI({graphKind:k});render();},seg,{'aria-pressed':String(kind===k),'data-graph-kind':k});
   const slot=node('div',null,body,{class:'sc-pick-slot'});
   if(kind==='collection'){
    const list=graphCollectionList(),current=list&&list.find(c=>String(c.id)===String(state.graphCollection));
    const trigger=button('',()=>{},sb,{class:'sc-pick-trigger','aria-haspopup':'listbox','aria-label':'컬렉션 고르기'});
    node('span',current?current.name:(list?'컬렉션 고르기':'컬렉션을 불러오는 중'),trigger,{class:'sc-pick-value'});node('span','▾',trigger,{'aria-hidden':'true'});
    if(list)graphPicker(slot,trigger,{label:'컬렉션',options:graphCollectionOptions,currentID:state.graphCollection,open:!current,
     onPick:id=>{state.graphCollection=String(id);saveUI({graphCollection:String(id)});render();}});
    check('하위 컬렉션 포함',state.graphSub,on=>{state.graphSub=on;saveUI({graphSub:on});render();},sb);
   }else if(kind==='paper'){
    const id=graphPaperID(),current=id&&itemOf(id);
    const trigger=button('',()=>{},sb,{class:'sc-pick-trigger','aria-haspopup':'listbox','aria-label':'논문 고르기'});
    node('span',current?String(current.title||'제목 없음'):'논문 고르기',trigger,{class:'sc-pick-value'});node('span','▾',trigger,{'aria-hidden':'true'});
    graphPicker(slot,trigger,{label:'논문',options:graphPaperOptions,currentID:id,open:!current,
     onPick:pick=>{state.graphPaper=String(pick);state.graphAll=false;saveUI({graphPaper:String(pick)});render();}});
    check('2단계(내 문헌만)',state.graphDepth2,on=>{state.graphDepth2=on;saveUI({graphDepth2:on});render();},sb);
   }
  }
  const shortGraphTitle=title=>{const s=plain(title||'').trim();if(s.length<=26)return s;
   let cut=s.slice(0,26).replace(/\s+\S*$/,'');
   while(/\s(and|of|the|in|for|to|a|an|on|with|by|at|from)$/i.test(cut))cut=cut.replace(/\s+\S+$/,'');
   return (cut||s.slice(0,26))+'…';};
  /* One map for both new scopes: shelf papers are solid in the journal's colour, papers not on the shelf are hollow
     circles with a firm ring. Arrows point from the citing paper to the cited one. Clicking, or Enter on, a node
     focuses it in the list and the preview below; the centre paper of a one-paper graph is ringed. */
  function drawScopeMap(laid,{W,H,label,centreID,onFocus,before}){
   const tools=runtime.graphTools,identity=runtime.journalIdentity||{identify:()=>null,colours:()=>null};
   const svg=graphCanvas(W,H,laid.nodes.length,label);
   const mapFrame=node('div',null,null,{class:'sc-graph-frame'});mapFrame.appendChild(svg);
   if(before)body.insertBefore(mapFrame,before);else body.appendChild(mapFrame);
   const defs=doc.createElementNS(SVG,'defs'),marker=doc.createElementNS(SVG,'marker');
   for(const[k,v]of Object.entries({id:'sc-arrow',viewBox:'0 0 8 8',refX:'7',refY:'4',markerWidth:'5',markerHeight:'5',orient:'auto-start-reverse'}))marker.setAttribute(k,v);
   const head=doc.createElementNS(SVG,'path');head.setAttribute('d','M0 0 L8 4 L0 8 z');head.setAttribute('fill','var(--sc-graph-line)');marker.appendChild(head);defs.appendChild(marker);svg.appendChild(defs);
   const group=doc.createElementNS(SVG,'g');svg.appendChild(group);
   const pos=new Map(laid.nodes.map(n=>[n.id,n])),near=new Map(laid.nodes.map(n=>[n.id,new Set()])),lines=[];
   for(const e of laid.edges){
    const a=pos.get(String(e.source)),c=pos.get(String(e.target));if(!a||!c)continue;
    near.get(a.id).add(c.id);near.get(c.id).add(a.id);
    const dx=c.x-a.x,dy=c.y-a.y,dist=Math.hypot(dx,dy)||1,pull=(c.r||6)+0.5,cited=e.kind==='cites';
    const line=doc.createElementNS(SVG,'line');
    for(const[k,v]of Object.entries({x1:a.x,y1:a.y,x2:cited?c.x-dx/dist*pull:c.x,y2:cited?c.y-dy/dist*pull:c.y}))line.setAttribute(k,v);
    line.setAttribute('stroke','var(--sc-graph-line)');// In a one-paper graph the lines to the centre carry the picture; the neighbours' own citations stay faint behind it.
    const side=(!!centreID&&a.id!==centreID&&c.id!==centreID)||!!e.external;
    line.setAttribute('stroke-width',cited?(side?0.8:1.4):Math.min(2.2,0.5+(e.weight||0.3)*4));
    line.setAttribute('stroke-opacity',cited?(side?0.22:0.65):0.3);line.dataset.side=side?'1':'';
    if(cited)line.setAttribute('marker-end','url(#sc-arrow)');else line.setAttribute('stroke-dasharray','2 3');
    line.setAttribute('data-a',a.id);line.setAttribute('data-b',c.id);lines.push(line);group.appendChild(line);
   }
   for(const n of laid.nodes)n.labelText=[shortGraphTitle(n.label),n.year].filter(Boolean).join(' · ')||T('제목 없음');
   const placeAll=()=>tools.placeLabels(laid.nodes,{width:W,height:H,lineHeight:14,pad:4,limit:32,first:new Set([centreID,state.graphFocus].filter(Boolean)),avoidDots:true});
   let labelled=placeAll();const marks=new Map(),activators=new Map();
   for(const n of laid.nodes){
    const g=doc.createElementNS(SVG,'g');g.setAttribute('transform',`translate(${n.x} ${n.y})`);
    g.setAttribute('tabindex','0');g.setAttribute('role','button');g.setAttribute('aria-label',plain(n.label)+(n.kind==='ghost'?' · '+T('내 서재에 없음'):''));
    const id=n.venue?identity.identify(n.venue):null,tone=id?identity.colours(id,{dark:darkScheme()}):null;
    const ghost=n.kind==='ghost',centre=n.id===centreID,r=n.r||6;
    const circle=doc.createElementNS(SVG,'circle');circle.setAttribute('r',r);
    circle.setAttribute('fill',ghost?'var(--sc-surface)':centre?'var(--sc-lime)':(tone?tone.fill:'var(--sc-fill)'));
    circle.setAttribute('stroke',ghost?'var(--sc-border-strong)':(tone?tone.ink:'var(--sc-muted)'));
    circle.setAttribute('stroke-width',ghost?2:centre?2.4:1);
    if(ghost)circle.setAttribute('data-ghost','1');
    g.appendChild(circle);
    const label=doc.createElementNS(SVG,'text');label.setAttribute('x',r+4);label.setAttribute('y','3.5');label.setAttribute('class','sc-graph-label');label.textContent=n.labelText;
    if(!labelled.has(n.id))label.setAttribute('display','none');
    g.appendChild(label);
    const title=doc.createElementNS(SVG,'title');title.textContent=`${plain(n.label)}\n`+[n.venue,n.year,ghost?T('내 서재에 없음'):null,T(`인용 ${n.citations||0}`)].filter(Boolean).join(' · ');g.appendChild(title);
    const emphasise=on=>{
     for(const line of lines){const hit=!on||line.getAttribute('data-a')===on||line.getAttribute('data-b')===on;const base=line.dataset.side?0.22:line.getAttribute('marker-end')?0.65:0.3;line.setAttribute('stroke-opacity',on?(hit?0.85:0.05):base);}
     for(const[key,m]of marks){const close=!on||key===on||near.get(on).has(key);m.circle.setAttribute('opacity',close?1:0.25);
      const show=on?(key===on||(close&&labelled.has(key))):labelled.has(key);if(show)m.label.removeAttribute('display');else m.label.setAttribute('display','none');}
    };
    const activate=()=>{state.graphFocus=n.id;labelled=placeAll();for(const[key,m]of marks)m.circle.setAttribute('stroke-width',key===n.id?2.6:(m.n.kind==='ghost'?2:m.n.id===centreID?2.4:1));emphasise(n.id);onFocus(n);};
    activators.set(n.id,activate);g.addEventListener('click',activate);
    g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();activate();}});
    g.addEventListener('mouseenter',()=>emphasise(n.id));g.addEventListener('mouseleave',()=>emphasise(null));
    g.addEventListener('focus',()=>emphasise(n.id));g.addEventListener('blur',()=>emphasise(null));
    marks.set(n.id,{g,label,circle,n});group.appendChild(g);
   }
   const zoomBar=node('div',null,mapFrame,{class:'sc-graph-zoom',role:'group','aria-label':T('확대·축소')});let zoom=1;
   const frame=()=>{const w=W/zoom,h=H/zoom;svg.setAttribute('viewBox',`${(W-w)/2} ${(H-h)/2} ${w} ${h}`);};
   viewButton('확대',()=>{zoom=Math.min(3,zoom+.25);frame();},zoomBar);viewButton('축소',()=>{zoom=Math.max(1,zoom-.25);frame();},zoomBar);
   return {svg,pos,select:id=>{const a=activators.get(id);if(a)a();return !!a;}};
  }
  // A paper row in the side lists: the title focuses it on the map, the buttons act on it.
  function scopeRow(parent,n,{focus,recentre}){
   const held=n.kind!=='ghost'?itemOf(n.id):null;
   let row;
   if(held){
    row=node('div',null,parent,{class:'sc-hit','data-node-id':n.id});
    button(held.title||n.label,()=>focus(n.id),row,{class:'sc-hit-title sc-hit-title-link',title:'지도에서 보기'});
    node('p',[held.status==='done'?T('완료'):held.status==='reading'?T('읽는 중'):T('안 읽음'),held.year,held.venue,T(`인용 ${n.citations||0}`)].filter(Boolean).join(' · '),row,{class:'sc-hit-meta'});
    const acts=node('div',null,row,{class:'sc-hit-actions'});
    if(recentre)button('이 논문 중심으로',()=>recentre(n.id),acts);
    button('열기',()=>library.openItem(n.id),acts,{'data-opens':'window'});
   }else{
    row=hitRow({title:n.untitled?'':n.label,year:n.year,venue:n.venue,doi:n.doi||'',citations:n.citations||null,inLibrary:false,id:n.openalex},null);
    parent.appendChild(row);
    if(n.untitled){const t=row.querySelector('.sc-hit-title');if(t)t.textContent='제목 미확인 · '+n.openalex;}
    row.setAttribute('data-node-id',n.id);
    const acts=row.querySelector('.sc-hit-actions')||node('div',null,row,{class:'sc-hit-actions'});
    button('지도에서 보기',()=>focus(n.id),acts);
   }
   return row;
  }
  // Which row is "current": marked, and brought into view in its list.
  function markScopeRow(host,id){
   for(const r of host.querySelectorAll('[data-node-id]')){const on=r.getAttribute('data-node-id')===String(id);if(on)r.setAttribute('aria-current','true');else r.removeAttribute('aria-current');if(on)r.scrollIntoView?.({block:'nearest'});}
  }
  function drawPaperScope(b){
   const id=graphPaperID(),centreItem=id&&itemOf(id);
   if(!centreItem){emptyCard(body,{title:'논문 하나를 고르세요',hint:'위 목록에서 논문을 고르거나, 문헌 목록에서 하나를 선택하고 돌아오세요.'});return;}
   if(state.graphMode!=='citations')return drawLegacyGraph(b,egoLegacyItems(centreItem));
   const works=runtime.paperWorks?runtime.paperWorks():{},records=state.items.map(graphRecord(works));
   const key=centreItem.libraryID+':'+centreItem.key,work=works[key]||works[String(centreItem.id)]||null;
   const store=typeof runtime.citedByStore==='function'?runtime.citedByStore():{},cached=store[key]||null;
   const metaCache=runtime.cache&&typeof runtime.cache.workMeta==='object'?runtime.cache.workMeta:{};
   const all=!!state.graphAll;
   const g=runtime.graphTools.egoGraph(id,records,{meta:metaCache,citers:cached?cached.citers:[],depth2:state.graphDepth2,limit:60,all});
   if(!work||!work.openalex){
    node('p','이 논문의 인용 목록이 아직 없습니다. OpenAlex에서 한 번 가져오면 이 논문의 참고문헌과 인용한 내 문헌이 보입니다.',body,{class:'sc-muted'});
    if(!work&&typeof runtime.sweepPaperWorks==='function')button('이 논문의 인용 목록 가져오기',()=>run(async()=>{
     const found=await runtime.Z.Items.getAsync(Number(id));
     const report=await runtime.sweepPaperWorks(found?[found]:[],{});
     message(report.found?`참고문헌 ${report.references}건을 가져왔습니다.`:'OpenAlex에서 이 논문을 찾지 못했습니다.');await render();
    }),b,{class:'sc-fetch-action'});
    return;
   }
   // 외부 인용 논문: one metered request, only on this press; a stored answer is used without asking again.
   if(!cached&&typeof runtime.sweepCitedBy==='function'){
    const ask=button('',()=>run(async()=>{
     const found=await runtime.Z.Items.getAsync(Number(id));
     const report=await runtime.sweepCitedBy(found?[found]:[],{limit:50});
     message(report.errors?'외부 인용 논문을 가져오지 못했습니다.':`외부 인용 논문 ${report.citers}편을 가져왔습니다.`);await render();
    }),b,{class:'sc-fetch-action','data-action-key':'graph-external-citers'});
    node('span',T('외부 인용 논문도 보기'),ask);node('span',T('OpenAlex · 요청 1회'),ask,{class:'sc-fetch-quota'});
   }else if(cached)node('span',T(`외부 인용 ${g.counts.ghostCitedBy}편 · 저장된 목록`),b,{class:'sc-muted'});
   const untitled=g.nodes.filter(n=>n.kind==='ghost'&&n.untitled);
   if(untitled.length&&typeof runtime.worksByID==='function'){
    const ask=button('',()=>run(async()=>{await runtime.worksByID(untitled.slice(0,50).map(n=>n.openalex));await render();}),b,{class:'sc-fetch-action'});
    node('span',T('제목 불러오기'),ask);node('span',T(`OpenAlex · ${untitled.length}편 · 요청 ${Math.ceil(Math.min(50,untitled.length)/50)}회`),ask,{class:'sc-fetch-quota'});
   }
   const W=graphWidth(),H=Math.max(380,Math.min(560,Math.round(W*0.62)));
   const laid=runtime.graphTools.egoLayout(g,{width:W,height:H});
   statTiles(body,[{value:fmtN(g.counts.cites),label:'이 논문이 인용',title:'이 논문의 참고문헌 수'},{value:fmtN(g.counts.citedBy),label:'이 논문을 인용',title:'내 문헌과, 가져온 외부 논문 중 이 논문을 인용한 수'},
    {value:fmtN(g.counts.library),label:'내 문헌',title:'이 논문과 직접 연결된 내 서재의 논문'},g.counts.near?{value:fmtN(g.counts.near),label:'2단계'}:null],{label:'논문 하나 그래프 요약'});
   drawJournalLegend(g.nodes.filter(n=>n.kind!=='ghost'),body);
   const info=node('div',null,body,{class:'sc-graph-info','aria-live':'polite'});info.hidden=true;
   const lists=node('div',null,body,{class:'sc-scope-lists'});
   let mapApi=null;
   const focus=nodeID=>{if(mapApi&&mapApi.select(nodeID))return;const n=laid.nodes.find(x=>x.id===nodeID);if(n){state.graphFocus=n.id;show(n);}};
   const recentre=pick=>{state.graphPaper=String(pick);state.graphAll=false;state.graphFocus=null;saveUI({graphPaper:String(pick)});render();};
   const show=(n,quiet)=>{
    info.hidden=false;info.replaceChildren();
    scopeRow(info,n,{focus,recentre:n.kind!=='ghost'&&n.id!==id?recentre:null});
    markScopeRow(lists,n.id);
    if(!quiet&&n.kind!=='ghost')try{win.ZoteroPane?.selectItem?.(Number(n.id));}catch(_){}
   };
   mapApi=drawScopeMap(laid,{W,H,label:'논문 하나 인용 관계 그래프',centreID:id,onFocus:show,before:info});
   body.insertBefore(node('p','실선 화살표는 인용(인용하는 논문 → 인용되는 논문) · 속이 빈 원은 내 서재에 없는 논문 · 왼쪽은 이 논문이 인용한 논문, 오른쪽은 이 논문을 인용한 논문',null,{class:'sc-muted sc-graph-caption'}),info);
   const groups=[['이 논문이 인용',g.nodes.filter(n=>n.role==='cites'||n.role==='both'),g.counts.cites],['이 논문을 인용',g.nodes.filter(n=>n.role==='citedBy'||n.role==='both'),g.counts.citedBy],
    ['내 문헌',g.nodes.filter(n=>n.kind==='paper'),g.counts.library+g.counts.near]];
   for(const[label,nodes,total]of groups){
    const section=node('section',null,lists,{class:'sc-group'});sectionHead(label,total,section);
    const list=node('div',null,section,{class:'sc-hits'});
    if(!nodes.length)node('p','표시할 논문이 없습니다.',list,{class:'sc-muted'});
    for(const n of nodes.slice(0,40))scopeRow(list,n,{focus,recentre:n.kind!=='ghost'&&n.id!==id?recentre:null});
    if(nodes.length>40)node('p',`${nodes.length-40}편은 지도에서 확인하세요.`,section,{class:'sc-muted'});
    // The header counts every paper; the 60-node cap lists fewer. Say so inside the list.
    if(!all&&total>nodes.length)viewButton(T(`${total-nodes.length}편 더 (모두 보기)`),()=>{state.graphAll=true;render();},section,{class:'sc-graph-info-more sc-list-more'});
   }
   if(g.cut)node('p',`연결된 ${g.total}편 중 ${g.shown}편을 그렸습니다.`,body,{class:'sc-muted sc-graph-footnote'});
   if(g.cut||all)viewButton(all?'60개만 보기':`모두 보기 (${g.total}편)`,()=>{state.graphAll=!all;render();},body,{class:'sc-graph-info-more'});
   if(state.graphFocus){const n=laid.nodes.find(x=>x.id===state.graphFocus);if(n)show(n,true);}
  }
  // The other graph kinds around one paper: the paper and whoever shares a tag, an author or a related link with it.
  function egoLegacyItems(centreItem){
   const raw=library.graph(state.items.slice(0,500),{mode:state.graphMode==='citations'?'related':state.graphMode});
   const ids=new Set([String(centreItem.id)]);
   for(const e of raw.edges){if(String(e.source)===String(centreItem.id))ids.add(String(e.target));if(String(e.target)===String(centreItem.id))ids.add(String(e.source));}
   return state.items.filter(i=>ids.has(String(i.id)));
  }
  function drawCollectionScope(b){
   const list=graphCollectionList();
   if(!list){node('p','컬렉션을 불러오는 중입니다.',body,{class:'sc-muted'});return;}
   const chosen=list.find(c=>String(c.id)===String(state.graphCollection));
   if(!chosen){emptyCard(body,{title:'컬렉션을 고르세요',hint:'위 목록에서 논문을 모아 두는 컬렉션을 고르면 그 안의 논문끼리의 관계를 그립니다.'});return;}
   const ids=runtime.graphTools.collectionItemIDs(list,chosen.id,{sub:state.graphSub});
   const items=state.items.filter(i=>ids.has(String(i.id)));
   if(!items.length){emptyCard(body,{title:'이 컬렉션에는 논문이 없습니다',hint:state.graphSub?'':'하위 컬렉션 포함을 켜 보세요.'});return;}
   if(state.graphMode!=='citations')return drawLegacyGraph(b,items);
   const limit=setting('graphNodeLimit',180),works=runtime.paperWorks?runtime.paperWorks():{};
   const shownItems=items.slice(0,limit),toRecord=graphRecord(works);
   const records=shownItems.map(toRecord),everyone=state.items.map(toRecord);
   const withRefs=records.filter(r=>r.references.length).length;
   const unasked=shownItems.filter(i=>!(works[i.libraryID+':'+i.key]||works[String(i.id)])).length;
   if(unasked&&typeof runtime.sweepPaperWorks==='function'){const fetchLists=button('',()=>run(async()=>{
    const wanted=[];for(const i of shownItems){const found=await runtime.Z.Items.getAsync(Number(i.id));if(found)wanted.push(found);}
    const report=await runtime.sweepPaperWorks(wanted,{onProgress:(done,total)=>message(`인용 목록 ${done}/${total}`)});
    message(`${report.found}편에서 참고문헌 ${report.references}건`+(report.missing?` · OpenAlex에 없음 ${report.missing}`:''));await render();
   }),b,{class:'sc-fetch-action'});
   node('span',T('인용 목록 가져오기'),fetchLists);node('span',T(`OpenAlex · ${unasked}편 남음`),fetchLists,{class:'sc-fetch-quota'});}
   const showOutside=state.graphOutside!==false;
   check('바깥에서 많이 인용되는 논문 표시',showOutside,on=>{state.graphOutside=on;render();},b);
   if(!withRefs){node('p','이 컬렉션 논문의 인용 목록이 아직 없습니다. “인용 목록 가져오기”를 누르면 서로의 인용 관계가 그려집니다.',body,{class:'sc-muted'});}
   const metaCache=runtime.cache&&typeof runtime.cache.workMeta==='object'?runtime.cache.workMeta:{};
   const tools=runtime.graphTools,built=tools.build(records);
   // The ranking reads every paper in the collection; only the drawing is limited to `limit` papers.
   const outside=showOutside?tools.outsideCited(items.map(toRecord),{held:everyone,meta:metaCache,floor:2,limit:12}):[];
   const W=graphWidth(),H=graphHeight(built.nodes.length+outside.length);
   /* An outside work joins the picture through any collection paper that cites it -- also one that nothing else
      in the collection touches. Isolation is decided after these edges, not before. */
   const inFolder=new Set([...built.nodes,...built.isolated].map(n=>n.id));
   const ghostNodes=[],ghostEdges=[];
   for(const o of outside){
    const via=o.citedBy.filter(p=>inFolder.has(p));if(!via.length)continue;
    const gid='W:'+o.openalex;
    ghostNodes.push({id:gid,label:o.title||o.openalex,year:o.year,venue:o.venue,citations:o.citations,doi:o.doi,openalex:o.openalex,kind:'ghost',untitled:!o.title,rank:0.1,degree:via.length,inLibrary:false});
    for(const p of via)ghostEdges.push({source:p,target:gid,kind:'cites',weight:1,external:true});
   }
   const linkedOut=new Set(ghostEdges.map(e=>e.source));
   const stillIsolated=built.isolated.filter(n=>!linkedOut.has(n.id));
   const joined=built.isolated.filter(n=>linkedOut.has(n.id)).map(n=>({...n,degree:ghostEdges.filter(e=>e.source===n.id).length}));
   const laid=tools.layout({nodes:[...built.nodes,...joined,...ghostNodes],edges:[...built.edges,...ghostEdges],missing:[],isolated:[]},{width:W,height:H});
   const direct=built.edges.filter(e=>e.kind==='cites');
   const clusters=tools.clusterCount([...built.nodes,...joined,...ghostNodes].map(n=>n.id),[...built.edges,...ghostEdges])/* every drawn node, outside works included: two papers meeting at one are one group */;
   statTiles(body,[{value:fmtN(records.length),label:'논문'},{value:fmtN(built.truncated?built.counted.total:built.edges.length),label:built.truncated?T(`연결 · 일부만 그림 (${fmtN(built.counted.drawn)}개 표시)`):'연결',title:'인용과 공통 참고문헌으로 이어진 쌍'},
    {value:fmtN(clusters),label:'묶음',title:'서로 이어진 묶음의 수'},{value:fmtN(stillIsolated.length),label:'연결 없는 논문',title:'이 컬렉션 안에서 어느 논문과도 이어지지 않은 논문'}],{label:'컬렉션 그래프 요약'});
   drawJournalLegend(built.nodes,body);
   const info=node('div',null,body,{class:'sc-graph-info','aria-live':'polite'});info.hidden=true;
   const lists=node('div',null,body,{class:'sc-scope-lists'});
   let mapApi=null;
   const focus=nodeID=>{if(mapApi&&mapApi.select(nodeID))return;const n=laid.nodes.find(x=>x.id===nodeID);if(n){state.graphFocus=n.id;show(n);}};
   const show=(n,quiet)=>{info.hidden=false;info.replaceChildren();scopeRow(info,n,{focus,recentre:null});markScopeRow(lists,n.id);if(!quiet&&n.kind!=='ghost')try{win.ZoteroPane?.selectItem?.(Number(n.id));}catch(_){}};
   if(!laid.nodes.length){if(withRefs)node('p','이 컬렉션 안에서는 서로 인용하거나 참고문헌을 공유하는 논문이 없습니다.',body,{class:'sc-muted'});}
   else{
    mapApi=drawScopeMap(laid,{W,H,label:'컬렉션 인용 관계 그래프',centreID:null,onFocus:show,before:info});
    body.insertBefore(node('p','실선 화살표는 인용 · 점선은 공통 참고문헌 · 속이 빈 원은 이 컬렉션 밖의 논문(컬렉션 논문 여러 편이 인용) · 색은 출판사',null,{class:'sc-muted sc-graph-caption'}),info);
   }
   // The papers the rest of the collection stands on.
   const cited=new Map();for(const e of direct)cited.set(e.target,(cited.get(e.target)||0)+1);
   const top=[...cited].sort((a,c)=>c[1]-a[1]).slice(0,5);
   if(top.length){
    const section=node('section',null,lists,{class:'sc-group'});sectionHead('컬렉션 안에서 가장 많이 인용된 논문',top.length,section);
    const rowsEl=node('div',null,section,{class:'sc-hits'});
    for(const[pid,count]of top){const n=laid.nodes.find(x=>x.id===pid)||{id:pid,label:itemOf(pid)?.title||pid,kind:'paper'};
     const r=scopeRow(rowsEl,{...n,citations:n.citations},{focus,recentre:null});node('p',`이 컬렉션의 ${count}편이 인용합니다`,r,{class:'sc-hit-meta sc-hit-because'});}
   }
   if(stillIsolated.length){
    const section=node('section',null,lists,{class:'sc-group'});sectionHead('연결 없는 논문',stillIsolated.length,section);
    const rowsEl=node('div',null,section,{class:'sc-hits'});
    for(const n of stillIsolated.slice(0,30)){const c=node('div',null,rowsEl,{class:'sc-hit','data-node-id':n.id});node('p',n.label,c,{class:'sc-hit-title'});
     node('p',[n.venue,n.year,n.references?T(`참고문헌 ${n.references}건`):T('인용 목록 없음')].filter(Boolean).join(' · '),c,{class:'sc-hit-meta'});
     button('열기',()=>library.openItem(n.id),node('div',null,c,{class:'sc-hit-actions'}),{'data-opens':'window'});}
    if(stillIsolated.length>30)node('p',`${stillIsolated.length-30}편 더 있습니다.`,section,{class:'sc-muted'});
   }
   if(outside.length){
    const section=node('section',null,lists,{class:'sc-group'});sectionHead('이 컬렉션이 많이 인용하는 바깥 논문',outside.length,section);
    const rowsEl=node('div',null,section,{class:'sc-hits'});
    for(const o of outside){
     const gn={id:o.heldID||'W:'+o.openalex,label:o.title||o.openalex,year:o.year,venue:o.venue,citations:o.citations,doi:o.doi,openalex:o.openalex,kind:o.heldID?'paper':'ghost',untitled:!o.title};
     const r=scopeRow(rowsEl,gn,{focus,recentre:null});node('p',`이 컬렉션의 ${o.count}편이 인용합니다`+(o.heldID?' · 내 서재의 다른 곳에 있음':''),r,{class:'sc-hit-meta sc-hit-because'});
    }
   }
   if(state.graphFocus){const n=laid.nodes.find(x=>x.id===state.graphFocus);if(n)show(n,true);}
   if(items.length>limit)node('p',`그래프는 최대 ${limit}개 문헌을 표시합니다.`,body,{class:'sc-muted'});
  }
  function drawGraph(){
   drawGraphScope();
   const b=bar();
   const modes=node('div',null,b,{class:'sc-segmented',role:'group','aria-label':'그래프 종류'});
   for(const[mode,label]of [['citations','인용 관계'],['related','관련 문헌'],['tags','공통 태그'],['authors','공통 저자']])
    viewButton(label,()=>{state.graphMode=mode;render();},modes,{'aria-pressed':state.graphMode===mode});
   if(state.graphKind==='paper')return drawPaperScope(b);
   if(state.graphKind==='collection')return drawCollectionScope(b);
   if(state.graphMode==='citations')return drawCitationGraph(b);
   return drawLegacyGraph(b);
  }

  // An OpenAlex work named as W1 or as its full URL is one work.
  const bareWork=v=>{const id=String(v||'').split('/').pop();return /^w\d+$/i.test(id)?id.toUpperCase():String(v||'');};
  /* The papers one chosen paper cites, and the papers that cite it, both
     found without asking OpenAlex again: outgoing from its own cached
     reference list, incoming by scanning every other held paper's own
     cached reference list for this one's openalex id. state.items already
     holds the whole library, not just the current scope. */
  function paperNeighbours(centreID,works,limit){
   const items=state.items;
   const centre=items.find(i=>String(i.id)===String(centreID));
   if(!centre)return null;
   const workOf=item=>works[item.libraryID+':'+item.key]||works[String(item.id)]||null;
   const centreWork=workOf(centre);
   const centreOpenalex=bareWork(centreWork&&centreWork.openalex);
   const centreRefs=new Set((centreWork&&Array.isArray(centreWork.references)?centreWork.references:[]).map(bareWork));
   const openalexOf=new Map();
   for(const item of items){
    if(String(item.id)===String(centreID))continue;
    const oa=bareWork((workOf(item)||{}).openalex);
    if(oa&&!openalexOf.has(oa))openalexOf.set(oa,item);
   }
   const cites=[...centreRefs].map(oa=>openalexOf.get(oa)).filter(Boolean);
   const citedBy=centreOpenalex?items.filter(item=>{
    if(String(item.id)===String(centreID))return false;
    const w=workOf(item);
    return !!w&&Array.isArray(w.references)&&w.references.map(bareWork).includes(centreOpenalex);
   }):[];
   const seen=new Set([String(centreID)]),neighbours=[];
   for(const item of[...cites,...citedBy])if(!seen.has(String(item.id))){seen.add(String(item.id));neighbours.push(item);}
   const cap=Math.max(0,limit-1),shown=neighbours.slice(0,cap);
   const unread=neighbours.filter(item=>item.status!=='done'&&item.status!=='reading');
   return {chosen:[centre,...shown],cites,citedBy,unread,total:neighbours.length,shownCount:shown.length,cut:neighbours.length>shown.length};
  }
  function drawCitationGraph(b){
   // Without the journal registry the nodes still draw, in the neutral tone.
   const graphTools=runtime.graphTools,identity=runtime.journalIdentity||{identify:()=>null,colours:()=>null};
   if(!graphTools||typeof runtime.paperWorks!=='function'){drawLegacyGraph(b);return;}
   const works=runtime.paperWorks();
   const limit=setting('graphNodeLimit',180);
   /* 현재 범위 / 선택 문헌 주변: the switch stays on 현재 범위 until one
      paper is chosen, and leaving it back never sticks -- the mode is read
      fresh from state.selected + state.graphScope on every draw, nothing
      else is mutated by it. */
   // 주변 mode needs one paper picked, not "at least one": with two or more
   // selected there is no single centre to draw around.
   const centreID=state.selected.size===1?[...state.selected][0]:null;
   const scopeBar=bar();
   const scopeGroup=node('div',null,scopeBar,{class:'sc-segmented',role:'group','aria-label':'그래프 범위'});
   const neighbourMode=!!centreID&&state.graphScope==='neighbours';
   for(const[scopeMode,label]of[['scope','현재 범위'],['neighbours','선택 문헌 주변']])
    viewButton(label,()=>{state.graphScope=scopeMode;render();},scopeGroup,{'aria-pressed':(neighbourMode?'neighbours':'scope')===scopeMode});
   if(!centreID)node('span',T('문헌 하나를 고르면 주변을 봅니다'),scopeBar,{class:'sc-muted'});
   const neighbourInfo=neighbourMode?paperNeighbours(centreID,works,limit):null;
   if(neighbourMode&&neighbourInfo){
    const unreadIDs=neighbourInfo.unread.map(item=>String(item.id));
    const line=node('p',null,body,{class:'sc-muted sc-graph-summary'});
    node('span',[T(`참고문헌 ${neighbourInfo.cites.length}`),T(`인용한 문헌 ${neighbourInfo.citedBy.length}`)].join(' · ')+' · ',line);
    const unreadBtn=button(T(`안 읽음 ${unreadIDs.length}`),()=>navigateSelection('explore',unreadIDs),line,{class:'sc-inline'});
    if(!unreadIDs.length)unreadBtn.disabled=true;
    if(neighbourInfo.cut)node('p',T(`연결 ${neighbourInfo.total}편 중 ${neighbourInfo.shownCount}편 표시`),body,{class:'sc-muted sc-graph-summary'});
   }
   const chosen=neighbourInfo?neighbourInfo.chosen:rows().slice(0,limit);
   const papers=chosen.map(paper=>{
    const work=works[paper.libraryID+':'+paper.key]||works[String(paper.id)]||null;
    return {id:String(paper.id),title:paper.title,year:Number(paper.year)||null,
     citations:Number(paper.citations)||0,venue:paper.venue,
     openalex:bareWork(work&&work.openalex),references:work&&Array.isArray(work.references)?work.references.map(bareWork):[]};
   });
   const withRefs=papers.filter(paper=>paper.references.length).length;
   if(!papers.length){empty('문헌을 가져오면 관계 그래프가 나타납니다.');return;}
   /* "Remaining" is what a press would still ask about. A paper OpenAlex does
      not know, or one with no DOI, is answered already and is skipped by the
      sweep; counting it kept "3편 남음" on a button that could do nothing. */
   const unasked=chosen.filter(paper=>!(works[paper.libraryID+':'+paper.key]||works[String(paper.id)])).length;
   // 주변 mode draws only from what is already cached; it never offers a fetch.
   if(!neighbourMode&&unasked){const fetchLists=button('',()=>run(async()=>{
    const wanted=[];
    for(const paper of chosen){
     const found=await runtime.Z.Items.getAsync(Number(paper.id));
     if(found)wanted.push(found);
    }
    const report=await runtime.sweepPaperWorks(wanted,
     {onProgress:(done,total)=>message(`인용 목록 ${done}/${total}`)});
    message(`${report.found}편에서 참고문헌 ${report.references}건 · 기관 ${report.institutions}곳`
     +(report.missing?` · OpenAlex에 없음 ${report.missing}`:'')+(report.noDOI?` · DOI 없음 ${report.noDOI}`:''));
    await render();
   }),b,{class:'sc-fetch-action'});
   node('span',T('인용 목록 가져오기'),fetchLists);node('span',T(`OpenAlex · ${unasked}편 남음`),fetchLists,{class:'sc-fetch-quota'});}
   if(!withRefs){
    // Nothing fetched yet is not nothing to show. The related-items graph
    // stands in until the reference lists arrive, so the tab is never a blank
    // panel with one button on it.
    node('p',neighbourMode?'이 문헌과 직접 연결된 인용 관계를 캐시에서 찾지 못했습니다.'
     :unasked?'아직 인용 목록이 없습니다. “인용 목록 가져오기”를 누르면 실제 인용 관계로 바뀝니다. 그때까지는 관련 문헌 연결을 보여줍니다.'
     :'이 범위의 논문은 OpenAlex에 참고문헌 목록이 없습니다. 관련 문헌 연결을 대신 보여줍니다.',body,{class:'sc-muted'});
    if(!neighbourMode)drawLegacyGraph(b);
    return;
   }
   const W=graphWidth(),H=graphHeight(chosen.length);
   const items=chosen.map(paper=>runtime.Z.Items.get(Number(paper.id))).filter(Boolean);
   const citedBy=typeof runtime.citedByFor==='function'&&!neighbourMode?runtime.citedByFor(items):null;
   const citedStore=typeof runtime.citedByStore==='function'&&!neighbourMode?runtime.citedByStore():{};
   const citersDue=neighbourMode?0:items.filter(ref=>!citedStore[runtime.identity(ref)]&&(works[runtime.identity(ref)]||{}).openalex).length;
   // One metered request per paper: the button says so before it is pressed.
   // 주변 mode already found who cites the centre from cached reference
   // lists, so it never asks OpenAlex for the same thing.
   if(citersDue){const fetchCiters=button('',()=>run(async()=>{
    const report=await runtime.sweepCitedBy(items,{onProgress:(d,t)=>message(`인용한 논문 ${d+1}/${t}`)});
    message(`${report.found}편에서 인용 ${report.citers}건`
     +(report.noWork?` · 인용 목록 먼저 필요 ${report.noWork}`:'')+(report.errors?` · 실패 ${report.errors}`:''));
    await render();
   }),b,{class:'sc-fetch-action'});
   node('span',T('인용한 논문 가져오기'),fetchCiters);node('span',T(`${citersDue}편 남음 · 요청 최대 ${citersDue}회`),fetchCiters,{class:'sc-fetch-quota'});}
   const graph=graphTools.layout(graphTools.build(papers,{citedBy}),{width:W,height:H});
   const counted=graph.counted||{direct:0,coupled:0,isolated:0};
   const notDrawn=[counted.isolated?T(`연결 없음 ${counted.isolated}`):'',withRefs<papers.length?T(`인용 목록 없음 ${papers.length-withRefs}`):'',counted.external?T(`바깥 논문 ${counted.external}`):''].filter(Boolean);
   /* The picture in one sentence: how many separate clusters the papers
      form, and which paper this library cites most among its own -- the one
      the rest stands on. Read off the same edges the map draws. */
   {
    const paperIDs=new Set(graph.nodes.filter(n=>n.kind==='paper').map(n=>n.id));
    const inner=graph.edges.filter(e=>!e.external&&paperIDs.has(e.source)&&paperIDs.has(e.target));
    const parent=new Map([...paperIDs].map(id=>[id,id]));const find=id=>{while(parent.get(id)!==id){parent.set(id,parent.get(parent.get(id)));id=parent.get(id);}return id;};
    for(const e of inner)parent.set(find(e.source),find(e.target));
    const touched=new Set(inner.flatMap(e=>[e.source,e.target]));
    const clusters=new Set([...touched].map(find)).size;
    const citedIn=new Map();for(const e of inner)if(e.kind==='cites')citedIn.set(e.target,(citedIn.get(e.target)||0)+1);
    const [topID,topN]=[...citedIn].sort((a,b)=>b[1]-a[1])[0]||[];
    const top=topID?papers.find(p=>p.id===topID):null;
    // The figures are one tile row; the sentence under it names only the paper the rest stands on.
    statTiles(body,[{value:fmtN(graph.nodes.filter(n=>n.kind==='paper').length),label:'이어진 논문'},{value:fmtN(counted.direct),label:graph.truncated?'인용 · 일부만 그림':'인용',title:'서재 안에서 확인된 인용 관계(건)'},
     counted.coupled?{value:fmtN(counted.coupled),label:'공통 참고문헌 쌍'}:null,{value:fmtN(clusters),label:'묶음',title:'서로 이어진 묶음의 수'}],{label:'관계 그래프 요약'});
    const parts=[top&&topN>1?T(`이 그래프 안에서 가장 많이 인용된 논문: ${String(top.title||'').slice(0,60)} (${topN}편이 인용)`):''].filter(Boolean);
    if(parts.length)node('p',parts.join(' · '),body,{class:'sc-muted sc-graph-summary sc-graph-insight'});
    if(notDrawn.length)node('p',`그리지 않음: ${notDrawn.join(' · ')}`,body,{class:'sc-muted sc-graph-footnote'});
   }
   drawJournalLegend(graph.nodes.filter(n=>n.kind==='paper'),body);
   if(!graph.nodes.length){
    empty('이 범위에서는 서로 인용하거나 참고문헌을 공유하는 논문이 없습니다. 범위를 넓혀보세요.');
    return;
   }
   const svg=graphCanvas(W,H,graph.nodes.length,'인용 관계 그래프');
   // The map sits in a frame of its own so the zoom buttons can lie on it, top right, and never meet the footer.
   const mapFrame=node('div',null,body,{class:'sc-graph-frame'});mapFrame.appendChild(svg);
   const defs=doc.createElementNS(SVG,'defs');
   const marker=doc.createElementNS(SVG,'marker');
   for(const[k,v]of Object.entries({id:'sc-arrow',viewBox:'0 0 8 8',refX:'7',refY:'4',markerWidth:'5',markerHeight:'5',orient:'auto-start-reverse'}))marker.setAttribute(k,v);
   const head=doc.createElementNS(SVG,'path');head.setAttribute('d','M0 0 L8 4 L0 8 z');head.setAttribute('fill','var(--sc-graph-line)');
   marker.appendChild(head);defs.appendChild(marker);svg.appendChild(defs);
   const group=doc.createElementNS(SVG,'g');svg.appendChild(group);
   const positions=new Map(graph.nodes.map(n=>[n.id,n]));
   const neighbours=new Map(graph.nodes.map(n=>[n.id,new Set()]));
   const lines=[];
   for(const e of graph.edges){
    const a=positions.get(String(e.source)),c=positions.get(String(e.target));
    if(!a||!c)continue;
    neighbours.get(a.id).add(c.id);neighbours.get(c.id).add(a.id);
    const line=doc.createElementNS(SVG,'line');
    const cited=e.kind==='cites';
    // A cited line drawn to the target's own centre buries its arrowhead
    // under the node's fill; pulled back to the circle's boundary, the head
    // actually shows.
    let x2=c.x,y2=c.y;
    if(cited){
     const dx=c.x-a.x,dy=c.y-a.y,dist=Math.hypot(dx,dy)||1,pull=(c.r||6)+0.5;
     x2=c.x-dx/dist*pull;y2=c.y-dy/dist*pull;
    }
    for(const[k,v]of Object.entries({x1:a.x,y1:a.y,x2,y2}))line.setAttribute(k,v);
    line.setAttribute('stroke','var(--sc-graph-line)');
    // A stated citation is solid and carries an arrow; a shared-reading thread
    // is faint and has no direction, because it is an inference, not a fact.
    line.setAttribute('stroke-width',cited?1.4:Math.min(2.2,0.5+e.weight*4));
    line.setAttribute('stroke-opacity',cited?0.75:Math.min(0.5,0.12+e.weight));
    if(cited)line.setAttribute('marker-end','url(#sc-arrow)');
    else line.setAttribute('stroke-dasharray','2 3');
    line.setAttribute('data-a',a.id);line.setAttribute('data-b',c.id);
    lines.push(line);group.appendChild(line);
   }
   const marks=new Map();
   // What each label will say, before deciding which ones fit: a short title
   // and the year, e.g. "Mapping cellular… 2025" -- a journal mark and a year
   // named the journal, not the paper, and read the same for every paper in it.
   const shortTitle=title=>{const s=plain(title||'').trim();
    if(s.length<=26)return s;
    // Cut at a word, then drop function words the cut left hanging: "Phase separation of" reads as a mistake.
    let cut=s.slice(0,26).replace(/\s+\S*$/,'');
    while(/\s(and|of|the|in|for|to|a|an|on|with|by|at|from)$/i.test(cut))cut=cut.replace(/\s+\S+$/,'');
    return cut+'…';};
   for(const n of graph.nodes)n.labelText=[shortTitle(n.label),n.year].filter(Boolean).join(' \u00b7 ')||T('제목 없음');
   /* A small graph shows every title; there is room, and nothing to decide.
      Past that, placeLabels picks what fits without collision, and the
      chosen paper always gets its label regardless (see the opacity check
      below) -- it is the one node the reader is least willing to lose. */
   const SMALL_GRAPH=16;
   const small=graph.nodes.length<=SMALL_GRAPH;
   /* A label that would collide is not drawn at all (display none, not opacity 0: a hidden label
      still took part in layout and in every overlap check) and appears with the hover or focus. At
      most LABEL_LIMIT are shown; the chosen paper is placed first so it never loses its words. The
      boxes are estimated generously (14px line, 4px each side) because real glyph widths vary. */
   const LABEL_LIMIT=32;
   const placeAll=()=>small
    ?new Set(graph.nodes.map(n=>n.id))
    :graphTools.placeLabels(graph.nodes,{width:W,height:H,lineHeight:14,pad:4,limit:LABEL_LIMIT,first:state.selected,avoidDots:true});
   let labelled=placeAll();
   const setLabel=(m,on)=>{for(const el of [m.label,m.backdrop]){if(!el)continue;if(on)el.removeAttribute('display');else el.setAttribute('display','none');}};
   // Small enough that every label stays; placeLabelSides picks whichever of
   // the four sides around a node collides least, instead of always sitting
   // just right of it -- exactly where an edge to a neighbour usually runs.
   const sides=small&&typeof graphTools.placeLabelSides==='function'
    ?graphTools.placeLabelSides(graph.nodes,{width:W,height:H,edges:graph.edges})
    :null;
   for(const n of graph.nodes){
    const g=doc.createElementNS(SVG,'g');
    g.setAttribute('transform',`translate(${n.x} ${n.y})`);
    g.setAttribute('tabindex','0');g.setAttribute('role','button');g.setAttribute('aria-label',plain(n.label));
    const id=n.venue?identity.identify(n.venue):null;
    const tone=id?identity.colours(id,{dark:darkScheme()}):null;
    /* Size is how central the paper is here, not how famous it is anywhere,
       and the very value layout() already settled the picture around --
       recomputing it here from citations, as before, could disagree with the
       spacing the nodes were actually laid out at. */
    const r=n.r||graphTools.centralityRadius(n.rank);
    const external=n.kind==='external';
    const circle=doc.createElementNS(SVG,external?'rect':'circle');
    if(external){
     // A square for work you do not hold, so the thing you could go and read is
     // never mistaken for something already on the shelf.
     for(const[k,v]of Object.entries({x:-r,y:-r,width:r*2,height:r*2,rx:2}))circle.setAttribute(k,v);
    } else circle.setAttribute('r',r);
    circle.setAttribute('fill',external?'var(--sc-bg)':state.selected.has(n.id)?'var(--sc-lime)':(tone?tone.fill:'var(--sc-fill)'));
    circle.dataset.fill=tone?'journal':'plain';
    circle.setAttribute('stroke',external?'var(--sc-external)':(tone?tone.ink:'var(--sc-muted)'));
    circle.setAttribute('stroke-width',state.selected.has(n.id)?2.4:1);
    if(external)circle.setAttribute('stroke-dasharray','2 2');
    g.appendChild(circle);
    // A label on every node at this density is a grey smear, so only the papers
    // worth reading first carry one: the most cited and the best connected.
    const label=doc.createElementNS(SVG,'text');
    const side=sides&&sides.get(n.id);
    label.setAttribute('x',side?side.dx:r+4);label.setAttribute('y',side?side.dy:'3.5');
    if(side&&side.anchor!=='start')label.setAttribute('text-anchor',side.anchor);
    label.setAttribute('class','sc-graph-label');
    label.textContent=n.labelText;
    if(n.kind==='external')label.dataset.kind='external';
    // A rounded surface-coloured backdrop under the words, so a line that runs behind a label never cuts through it.
    const backdrop=doc.createElementNS(SVG,'rect');backdrop.setAttribute('class','sc-graph-label-bg');backdrop.setAttribute('rx','6');
    g.appendChild(backdrop);
    // A label is drawn when it fits, not when a number clears a threshold:
    // forty of them piled up in the middle is worse than showing none.
    g.appendChild(label);
    const title=doc.createElementNS(SVG,'title');
    title.textContent=`${plain(n.label)}\n`+[n.venue,n.year,
     n.kind==='external'?T('내 라이브러리에 없음'):null,
     T(`인용 ${n.citations}`),n.references?T(`참고문헌 ${n.references}`):null,T(`연결 ${n.degree}`),
     n.rank!=null?T(`중심성 ${(n.rank*100).toFixed(0)}%`):null].filter(Boolean).join(' · ');
    g.appendChild(title);
    // Selecting a node marks it in place: a redraw would reset the zoom and the hover.
    const activate=()=>{state.selected=new Set([n.id]);labelled=placeAll();focusNode(n.id);updateSelectionUI();message(n.label);showInfo(n);for(const [key,m] of marks){m.circle.setAttribute('stroke-width',key===n.id?2.4:1);if(m.circle.tagName==='circle'){const node0=positions.get(key);const idv=node0&&node0.venue?identity.identify(node0.venue):null;const tn=idv?identity.colours(idv,{dark:darkScheme()}):null;m.circle.setAttribute('fill',key===n.id?'var(--sc-lime)':(tn?tn.fill:'var(--sc-fill)'));}}if(n.kind!=='external')try{win.ZoteroPane?.selectItem?.(Number(n.id));}catch(_){}};
    g.addEventListener('click',activate);
    g.addEventListener('dblclick',()=>run(()=>n.kind==='external'
     ?runtime.Z.launchURL&&runtime.Z.launchURL(`https://openalex.org/${n.openalex}`)
     :library.openItem(n.id)));
    g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();activate();}});
    // Hovering brings one paper's neighbourhood forward instead of leaving the
    // reader to trace a line across a thousand of them.
    g.addEventListener('mouseenter',()=>focusNode(n.id));
    g.addEventListener('mouseleave',()=>focusNode(null));
    g.addEventListener('focus',()=>focusNode(n.id));
    g.addEventListener('blur',()=>focusNode(null));
    marks.set(n.id,{g,label,backdrop,circle,n});
    group.appendChild(g);
   }
   fitBackdrops();
   /* The backdrop is sized from the words it sits under: the browser's own measure when it has one, an estimate (Korean is wider) when it has not. */
   function fitBackdrops(){
    for(const m of marks.values()){
     const t=m.label;let w=0;
     try{w=t.getComputedTextLength?.()||0;}catch(_){w=0;}
     if(!w)for(const ch of String(t.textContent))w+=/[\u1100-\u11ff\u3000-\u9fff\uac00-\ud7af]/.test(ch)?11:6;
     const x=Number(t.getAttribute('x'))||0,y=Number(t.getAttribute('y'))||0,anchor=t.getAttribute('text-anchor')||'start';
     const left=anchor==='end'?x-w:anchor==='middle'?x-w/2:x;
     for(const[k,v]of Object.entries({x:left-4,y:y-10.5,width:w+8,height:15}))m.backdrop.setAttribute(k,v);
    }
   }
   function focusNode(id){
    for(const line of lines){
     const on=!id||line.getAttribute('data-a')===id||line.getAttribute('data-b')===id;
     line.setAttribute('stroke-opacity',on?(line.getAttribute('marker-end')?0.85:0.42):0.05);
    }
    for(const[key,mark]of marks){
     const near=!id||key===id||neighbours.get(id).has(key);
     /* Focus dims the far marks, not their words: a label at 22% opacity was
        text at under 2:1. Far labels step out of the way instead, and come
        back when the focus goes. */
     mark.g.setAttribute('opacity',1);
     mark.circle?.setAttribute('opacity',near?1:0.22);
     // The hovered paper always gets its words; the labels already placed stay while they are near; nothing else is added, so hovering never piles titles up.
     const on=id?(key===id||(near&&labelled.has(key))):labelled.has(key);
     setLabel(mark,on);
    }
   }
   focusNode(null);
   /* The chosen paper, pinned under the map: its whole title, how far it has
      been read, and the papers on the map that cite it or that it cites --
      direct citations only, not shared references. A title goes to that
      paper; the choice is kept for when the map is drawn again. */
   const info=node('div',null,body,{class:'sc-graph-info','aria-live':'polite'});info.hidden=true;
   function showInfo(n){
    state.graphInfoID=n.id;info.hidden=false;info.replaceChildren();
    const local=state.items.find(i=>String(i.id)===String(n.id));
    const titleOf=id=>state.items.find(i=>String(i.id)===String(id))?.title||positions.get(id)?.label||String(id);
    node('p',local?.title||n.label||n.id,info,{class:'sc-graph-info-title'});
    if(local){
     const at=runtime.localStamp?runtime.localStamp(local.lastRead)?.getTime():Date.parse(local.lastRead||'');
     node('p',[local.status==='done'?T('완료'):local.status==='reading'?T('읽는 중'):T('안 읽음'),Number(local.seconds)>0&&runtime.formatReadTime?runtime.formatReadTime(local.seconds,{compact:true}):'',Number.isFinite(at)?T(`${Math.max(0,Math.floor((Date.now()-at)/864e5))}일 전 읽음`):''].filter(Boolean).join(' · '),info,{class:'sc-muted'});
    }else node('p',T('내 서재에 없는 논문'),info,{class:'sc-muted'});
    const direct=graph.edges.filter(e=>e.kind==='cites');
    const citing=[...new Set(direct.filter(e=>e.target===n.id).map(e=>e.source))],cited=[...new Set(direct.filter(e=>e.source===n.id).map(e=>e.target))];
    /* Both lists were capped at 12 with no way past that; the head now also
       says these are edges within the drawn graph, not every citation the
       paper has -- easy to read as the whole picture otherwise. */
    for(const [label,dirKey,ids] of [['이 그래프 안에서 이 논문을 인용한 문헌','citing',citing],['이 그래프 안에서 이 논문이 인용한 문헌','cited',cited]]){
     node('p',`${T(label)} ${ids.length}`,info,{class:'sc-graph-info-head'});
     const moreKey=dirKey+':'+n.id,all=!!state.graphInfoMore?.[moreKey];
     for(const id of ids.slice(0,all?ids.length:12)){
      const held=state.items.find(i=>String(i.id)===String(id));
      const line=node('div',null,info,{class:'sc-graph-info-row'});
      if(held)button(titleOf(id),()=>showPaper(id),line,{class:'sc-hit-title-link',title:titleOf(id)});else node('span',titleOf(id),line);
      if(held)node('span',held.status==='done'?T('완료'):held.status==='reading'?T('읽는 중'):T('안 읽음'),line,{class:'sc-muted'});
     }
     if(ids.length>12)viewButton(all?'접기':T(`${ids.length-12}개 더 보기`),()=>{state.graphInfoMore={...(state.graphInfoMore||{}),[moreKey]:!all};showInfo(n);},info,{class:'sc-graph-info-more'});
    }
   }
   if(state.graphInfoID&&positions.has(state.graphInfoID))showInfo(positions.get(state.graphInfoID));
   const zoomBar=node('div',null,mapFrame,{class:'sc-graph-zoom',role:'group','aria-label':T('확대·축소')});let zoom=1;
   // Anchored at 0 0, zooming in pushed half the nodes out of frame with no
   // way to pan back; keep the frame centred on the drawing instead.
   const frame=()=>{const w=W/zoom,h=H/zoom;svg.setAttribute('viewBox',`${(W-w)/2} ${(H-h)/2} ${w} ${h}`);};
   viewButton('확대',()=>{zoom=Math.min(3,zoom+.25);frame();},zoomBar);
   // Zoom goes in, not out past the fitted drawing: below 1 it shrank 11px labels to 5px.
   viewButton('축소',()=>{zoom=Math.max(1,zoom-.25);frame();},zoomBar);
   node('p','실선 화살표는 실제 인용 · 점선은 공통 참고문헌 · 네모는 내가 갖고 있지 않은 논문 · 크기는 이 라이브러리 안에서의 중심성 · 색은 출판사',body,{class:'sc-muted sc-graph-caption'});
   // The one thing a citation map tells you that reading your own shelf cannot.
   if(graph.missing.length){
    sectionHead('내 라이브러리가 자주 인용하지만 갖고 있지 않은 논문',graph.missing.length);
    const list=node('div',null,body,{class:'sc-hits'});
    const shown=graph.missing.slice(0,25),placed=new Map();
    for(const row of shown){
     const c=node('div',null,list,{class:'sc-hit'});
     node('p',row.id,c,{class:'sc-hit-title'});
     node('p',`내 논문 ${row.citedBy.length}편이 인용합니다`,c,{class:'sc-hit-meta'});
     const actions=node('div',null,c,{class:'sc-hit-actions'});
     button('OpenAlex에서 보기',()=>runtime.Z.launchURL&&runtime.Z.launchURL(`https://openalex.org/${row.id}`),actions,{'data-opens':'browser'});
     placed.set(row.id,c);
    }
    /* An ID is no answer to "should I read this": the titles arrive in one
       request, and each row becomes a paper with 추가 -- or 보유, for one
       already on the shelf that this range simply did not draw.

       선택 문헌 주변 mode never asks OpenAlex for anything -- it fills in
       only what an earlier lookup already put in the shared work-metadata
       cache, and stays with the bare ID otherwise. */
    const owned=typeof runtime.libraryDOIs==='function'?runtime.libraryDOIs():new Set();
    const fillFrom=found=>{
     for(const row of shown){
      const work=found[row.id],old=placed.get(row.id);
      if(!work||!old?.isConnected)continue;
      const fresh=hitRow({...work,inLibrary:!!(work.doi&&owned.has(String(work.doi).toLowerCase()))},null);
      node('p',`내 논문 ${row.citedBy.length}편이 인용합니다`,fresh,{class:'sc-hit-meta sc-hit-because'});
      old.replaceWith(fresh);
     }
    };
    if(neighbourMode){
     const cache=runtime.cache&&typeof runtime.cache.workMeta==='object'?runtime.cache.workMeta:{};
     fillFrom(cache);
    }else if(typeof runtime.worksByID==='function'){
     const generation=epoch;
     runtime.worksByID(shown.map(row=>row.id)).then(found=>{
      if(disposed||generation!==epoch||!list.isConnected)return;
      fillFrom(found);
     }).catch(error=>runtime.Z.logError?.(error));
    }
   }
   // The papers nothing connects to are named rather than drawn: as a ring round
   // the outside they were most of the ink and none of the structure.
   if(graph.isolated&&graph.isolated.length){
    sectionHead('이 범위에서 연결이 없는 논문',graph.isolated.length);
    const list=node('div',null,body,{class:'sc-hits'});
    for(const n of graph.isolated.slice(0,30)){
     const c=node('div',null,list,{class:'sc-hit'});
     node('p',n.label,c,{class:'sc-hit-title'});
     node('p',[n.venue,n.year,n.references?T(`참고문헌 ${n.references}건`):T('인용 목록 없음')].filter(Boolean).join(' · '),c,{class:'sc-hit-meta'});
     button('열기',()=>library.openItem(n.id),node('div',null,c,{class:'sc-hit-actions'}),{'data-opens':'window'});
    }
   }
   if(graph.truncated)node('p',T(`연결 ${fmtN(counted.total)}건 중 강한 ${fmtN(counted.drawn)}건만 그렸습니다. 검색으로 범위를 좁히면 전부 보입니다.`),body,{class:'sc-muted'});
   if(rows().length>limit)node('p',`그래프는 최대 ${limit}개 문헌을 표시합니다.`,body,{class:'sc-muted'});
  }

  /* The tag, author and related-item modes, drawn with the citation map's
     layout rather than the old one.

     They used a separate placer that stacked nodes into vertical columns and
     labelled every one of them, so a hundred titles overlapped into a grey
     band. The graph is a different question in each mode, but "how do you draw
     a graph so it can be read" has one answer. */
  function drawLegacyGraph(b,scopeItems){
   const limit=setting('graphNodeLimit',180);
   const raw=library.graph((scopeItems||rows()).slice(0,limit),{mode:state.graphMode==='citations'?'related':state.graphMode});
   if(!raw.nodes.length){empty('문헌을 가져오면 관계 그래프가 나타납니다.');return;}
   const W=graphWidth(),H=graphHeight(raw.nodes.length);
   /* The good layout when it is there, the old placer when it is not.

      The layout lives on the runtime as an optional module. Reaching for it
      unconditionally made the whole graph tab die -- caught, logged, and drawn
      as an empty panel -- in any host that had not loaded it, which is a worse
      outcome than a plainer graph. */
   const tools=runtime.graphTools||null;
   const built={
    nodes:raw.nodes.map(n=>({id:String(n.id),label:n.label,citations:0,degree:0,rank:0,kind:'paper',venue:state.items.find(i=>String(i.id)===String(n.id))?.venue||''})),
    edges:raw.edges.map(e=>({source:String(e.source),target:String(e.target),kind:'coupled',weight:0.5})),
    missing:[],isolated:[],counted:{}
   };
   const degree=new Map();
   for(const e of built.edges){degree.set(e.source,(degree.get(e.source)||0)+1);degree.set(e.target,(degree.get(e.target)||0)+1);}
   for(const n of built.nodes)n.degree=degree.get(n.id)||0;
   drawJournalLegend(built.nodes,body);
   const top=Math.max(1,...built.nodes.map(n=>n.degree));
   for(const n of built.nodes)n.rank=n.degree/top;
   const laid=tools?tools.layout(built,{width:W,height:H}):(()=>{
    const old=model.layout(raw,W,H);
    return {nodes:old.nodes.map(n=>({...n,id:String(n.id),r:5,degree:degree.get(String(n.id))||0}))};
   })();
   node('p',`문헌 ${laid.nodes.length} · 연결 ${built.edges.length}`,body,{class:'sc-muted'});
   const svg=graphCanvas(W,H,laid.nodes.length,'문헌 관계 그래프');
   const mapFrame=node('div',null,body,{class:'sc-graph-frame'});mapFrame.appendChild(svg);
   const group=doc.createElementNS(SVG,'g');svg.appendChild(group);
   const pos=new Map(laid.nodes.map(n=>[n.id,n]));
   for(const e of built.edges){
    const a=pos.get(e.source),c=pos.get(e.target);if(!a||!c)continue;
    const line=doc.createElementNS(SVG,'line');
    for(const[k,v]of Object.entries({x1:a.x,y1:a.y,x2:c.x,y2:c.y}))line.setAttribute(k,v);
    line.setAttribute('stroke','var(--sc-graph-line)');
    line.setAttribute('stroke-opacity','0.4');
    group.appendChild(line);
   }
   for(const n of laid.nodes)n.labelText=String(n.label).slice(0,34);
   const labelled=tools?tools.placeLabels(laid.nodes,{width:W,height:H,lineHeight:14,pad:4,limit:32,first:state.selected,avoidDots:true}):new Set(laid.nodes.map(n=>n.id));
   for(const n of laid.nodes){
    const g=doc.createElementNS(SVG,'g');
    g.setAttribute('transform',`translate(${n.x} ${n.y})`);
    g.setAttribute('tabindex','0');g.setAttribute('role','button');g.setAttribute('aria-label',plain(n.label));
    const circle=doc.createElementNS(SVG,'circle');
    circle.setAttribute('r',n.r||5);
    circle.setAttribute('fill',state.selected.has(n.id)?'var(--sc-accent)':'var(--sc-fill)');
    circle.setAttribute('stroke',state.selected.has(n.id)?'var(--sc-accent)':'var(--sc-muted)');
    g.appendChild(circle);
    const label=doc.createElementNS(SVG,'text');
    label.setAttribute('x',(n.r||5)+4);label.setAttribute('y','3.5');
    label.setAttribute('class','sc-graph-label');
    label.textContent=n.labelText;
    if(!(labelled.has(n.id)||state.selected.has(n.id)))label.setAttribute('display','none');
    g.addEventListener('mouseenter',()=>label.removeAttribute('display'));g.addEventListener('mouseleave',()=>{if(!(labelled.has(n.id)||state.selected.has(n.id)))label.setAttribute('display','none');});
    g.appendChild(label);
    const title=doc.createElementNS(SVG,'title');title.textContent=`${n.label}\n`+T(`연결 ${n.degree}`);g.appendChild(title);
    const activate=()=>{state.selected=new Set([n.id]);updateSelectionUI();message(n.label);for(const other of group.querySelectorAll('circle[data-picked]')){other.removeAttribute('data-picked');other.setAttribute('fill','var(--sc-fill)');other.setAttribute('stroke','var(--sc-muted)');}circle.setAttribute('data-picked','1');circle.setAttribute('fill','var(--sc-accent)');circle.setAttribute('stroke','var(--sc-accent)');};
    g.addEventListener('click',activate);
    g.addEventListener('dblclick',()=>run(()=>library.openItem(n.id)));
    g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();activate();}});
    group.appendChild(g);
   }
   let zoom=1;
   /* Zooming keeps the middle of the graph, not its top-left corner. Anchored
      at 0 0, two presses put half the nodes outside the frame with no way to
      pan back to them. */
   const frame=()=>{const w=W/zoom,h=H/zoom;svg.setAttribute('viewBox',`${(W-w)/2} ${(H-h)/2} ${w} ${h}`);};
   const zoomBar=node('div',null,mapFrame,{class:'sc-graph-zoom',role:'group','aria-label':T('확대·축소')});
   viewButton('확대',()=>{zoom=Math.min(3,zoom+.25);frame();},zoomBar);
   viewButton('축소',()=>{zoom=Math.max(1,zoom-.25);frame();},zoomBar);
   if((scopeItems||rows()).length>limit)node('p',`그래프는 최대 ${limit}개 문헌을 표시합니다. 검색으로 범위를 좁히세요.`,body,{class:'sc-muted'});
  }
  function drawTags(){
   /* Finding a topic to read comes first: the tree, searchable and sortable
      by reading, then the editing forms folded below it. */
   const treeHost=node('div',null,body,{class:'sc-tag-browse'});
   const edit=node('details',null,body,{class:'sc-tag-edit'});if(state.tagEditOpen)edit.open=true;edit.addEventListener('toggle',()=>{state.tagEditOpen=edit.open;});
   node('summary',T('태그 붙이기·빼기·이름 바꾸기'),edit);
   sectionHead('선택 문헌의 태그',state.selected.size?`${state.selected.size}편`:'',edit);const b=bar(edit),value=node('input',null,b,{placeholder:'추가·제거할 정확한 태그 (쉼표로 구분)','aria-label':'추가할 태그'});
   /* Both verbs said nothing: with no paper selected or an empty box they did
      nothing, and when they worked the reader had to go and look. Each now
      refuses in words, reports what it did, and a removal can be taken back. */
   const names=()=>value.value.split(',').map(t=>t.trim()).filter(Boolean);
   const ready=()=>{if(!state.selected.size)throw new Error('태그를 붙일 문헌을 먼저 선택하세요. 보유 문헌에서 고르거나 “현재 선택 가져오기”를 누르세요.');const tags=names();if(!tags.length)throw new Error('여러 개는 쉼표로 구분해 태그 이름을 입력하세요.');return tags;};
   button('선택 문헌에 태그 추가',async()=>{const tags=ready(),n=state.selected.size;await library.addTags([...state.selected],tags);await load();message(`${n}편에 태그 ${tags.join(', ')}를 붙였습니다.`);},b);
   button('선택 문헌에서 태그 제거',async()=>{
    const tags=ready(),ids=[...state.selected];
    // Who actually carried each tag, so 되돌리기 gives it back to them and no one else.
    // Which paper carried which of the tags: A with a and B with b get back a and b, not both each.
    const carried=new Map();
    for(const id of ids){const own=(state.items.find(i=>String(i.id)===String(id))?.tags||[]).filter(t=>tags.includes(t));if(own.length)carried.set(id,own);}
    const had=[...carried.keys()];
    const result=await library.removeTags(ids,tags);await load();
    // What the library says it took off, with types; the panel's own list only when the service does not say.
    const removed=Array.isArray(result?.removed)?result.removed:[...carried].flatMap(([id,own])=>own.map(tag=>({id:String(id),tag,type:0})));
    const papers=new Set(removed.map(row=>row.id)).size;
    if(!papers){message(`선택한 문헌 중 ${tags.join(', ')} 태그가 있는 문헌이 없습니다.`);return;}
    message(`${papers}편에서 태그 ${tags.join(', ')}를 뺐습니다.`);
    const undo=button('되돌리기',async()=>{
     if(typeof library.restoreTags==='function')await library.restoreTags(removed);
     else{const groups=new Map();for(const row of removed){if(!groups.has(row.tag))groups.set(row.tag,[]);groups.get(row.tag).push(row.id);}for(const[tag,list]of groups)await library.addTags(list,[tag]);}
     undo.remove();await load();message(`${papers}편에 태그를 다시 붙였습니다.`);},bar(),{'data-writes':'library'});
   },b);button('태그 필터 해제',()=>{dropQuick('explore','q-tag','q-status');render();},b);
   sectionHead('태그 경로 이름 바꾸기',null,edit);
   const rename=bar(edit),from=node('input',null,rename,{'aria-label':'기존 태그 경로',placeholder:'기존 태그 경로'}),to=node('input',null,rename,{'aria-label':'새 태그 경로',placeholder:'새 태그 경로'});let subtree=true;
   check('하위 태그도 변경',true,on=>{subtree=on;},rename);
   button('선택 문헌 태그 이름 변경',async()=>{if(!state.selected.size)throw new Error('이 변경은 선택한 문헌의 태그에만 적용되니, 이름을 바꿀 문헌을 먼저 선택하세요.');if(!from.value.trim()||!to.value.trim())throw new Error('기존 태그 경로와 새 태그 경로를 모두 입력하세요.');const result=await library.renameTagBranch([...state.selected],from.value,to.value,{subtree});await load();message(`태그 변경 ${result.updatedItems}개 문헌 · 병합 ${result.mergedTags}개`);},rename);
   /* Each tag with how much of it has been read and when it was last read:
      a heading that is all 안 읽음 and untouched for months is a reading
      list, not a finished topic. Off the rows already loaded. */
   // By the calendar: last night after midnight is 오늘, yesterday evening is 1일 전.
   const calendarAgo=at=>{const start=new Date();start.setHours(0,0,0,0);return at>=start.getTime()?T('오늘 읽음'):T(`${Math.ceil((start.getTime()-at)/864e5)}일 전 읽음`);};
   const inView=rows(),stampOf=v=>runtime.localStamp?runtime.localStamp(v)?.getTime():Date.parse(v||'');
   const tagReading=path=>{let done=0,reading=0,total=0,last=0,seconds=0;for(const it of inView){if(!(it.tags||[]).some(t=>t===path||t.startsWith(path+'/')))continue;total++;if(it.status==='done')done++;if(it.status==='reading')reading++;seconds+=Number(it.seconds)||0;const at=stampOf(it.lastRead);if(Number.isFinite(at)&&at>last)last=at;}return {done,reading,total,last,seconds};};
   const tree=library.tagTree(inView);const treeHead=sectionHead('태그 목록',tree.length,treeHost);
   // The tag search and sort live in the group's own head: one place to look, not a second search bar stacked under the page's.
   const tools=node('span',null,treeHead,{class:'sc-section-head-actions sc-tag-tools'});
   const find=node('input',null,tools,{type:'search',placeholder:T('태그 경로 검색'),'aria-label':T('태그 경로 검색')});find.value=state.tagQuery||'';
   const order=node('select',null,tools,{'aria-label':T('태그 정렬')});
   for(const [v,l] of [['name','이름순'],['unread','안 읽음 많은 순'],['recent','최근 읽은 순']])node('option',T(l),order,{value:v});
   order.value=state.tagSort||'name';
   const reading=new Map();const readingOf=path=>{if(!reading.has(path))reading.set(path,tagReading(path));return reading.get(path);};
   // A match deep in the tree keeps its ancestors, so the path reads whole.
   const keeps=n=>!state.tagQuery||String(n.path).toLowerCase().includes(state.tagQuery.toLowerCase())||(n.children||[]).some(keeps);
   const unreadIn=path=>{const r=readingOf(path);return r.total-r.done-r.reading;};
   const sorted=nodes=>[...nodes].filter(keeps).sort(state.tagSort==='unread'?(a,b)=>unreadIn(b.path)-unreadIn(a.path)||a.name.localeCompare(b.name)
    :state.tagSort==='recent'?(a,b)=>readingOf(b.path).last-readingOf(a.path).last||a.name.localeCompare(b.name):(a,b)=>a.name.localeCompare(b.name));
   const treeBox=node('div',null,treeHost,{class:'sc-tag-tree'});
   // Choosing a tag by name only calls redraw(), not a full render() -- this
   // Set lives across those calls so a parent the reader opened by hand stays
   // open instead of collapsing every time the cross-tag panel below it changes.
   const openPaths=new Set();
   /* A45: the tag's own name chooses it, without leaving 중첩 태그, so the
      papers under it can be cross-read against every other tag those same
      papers carry -- the co-occurring tags, not the ones this tag already
      implies by being their ancestor or descendant. */
   const crossBox=node('div',null,treeHost,{class:'sc-tag-cross'});crossBox.hidden=true;
   const shortName=path=>String(path).split('/').pop();
   const redrawCross=()=>{
    crossBox.replaceChildren();
    const path=state.tagFocus;
    crossBox.hidden=!path;
    if(!path)return;
    const related=t=>t===path||t.startsWith(path+'/')||path.startsWith(t+'/');
    const base=inView.filter(it=>(it.tags||[]).some(t=>t===path||t.startsWith(path+'/')));
    const co=new Map();
    for(const it of base)for(const t of new Set(it.tags||[])){
     if(related(t))continue;
     if(!co.has(t))co.set(t,{ids:new Set(),seconds:0,unread:0});
     const c=co.get(t);if(c.ids.has(String(it.id)))continue;
     c.ids.add(String(it.id));c.seconds+=Number(it.seconds)||0;if(it.status!=='done'&&it.status!=='reading')c.unread++;
    }
    const list=[...co].map(([t,c])=>({tag:t,n:c.ids.size,unread:c.unread,seconds:c.seconds,ids:[...c.ids]})).sort((a,b)=>b.n-a.n||a.tag.localeCompare(b.tag)).slice(0,5);
    sectionHead('함께 붙은 태그',list.length,crossBox);
    node('p',T(`#${shortName(path)} 태그가 붙은 문헌들이 함께 갖는 태그입니다.`),crossBox,{class:'sc-muted'});
    if(!list.length){emptyCard(crossBox,{title:'함께 붙은 태그가 없습니다.',icon:'tags'});return;}
    const table=node('table',null,crossBox,{class:'sc-tag-cross-table'});
    const hr=node('tr',null,node('thead',null,table));
    node('th',T('태그'),hr);node('th',T('문헌 수'),hr);node('th',T('안 읽음'),hr);node('th',T('읽은 시간'),hr);
    const tbody=node('tbody',null,table);
    for(const row of list){
     const tr=node('tr',null,tbody);
     node('td',row.tag,tr,{class:'sc-tag-cross-name'});
     const countCell=node('td',null,tr,{class:'sc-figure-cell'});
     // "#a ∩ #b": the reader gets there through 중첩 태그, not by remembering
     // two clicks, so the origin travels with the selection. Full paths, not
     // the short leaf name -- two different branches can share a leaf name,
     // and the shortened label used to say the same thing for both.
     button(String(row.n),()=>navigateSelection('explore',row.ids,`#${path} ∩ #${row.tag}`),countCell,{class:'sc-link-button',title:T('이 두 태그가 모두 있는 문헌을 봅니다')});
     node('td',String(row.unread),tr,{class:'sc-figure-cell'});
     node('td',row.seconds>0&&runtime.formatReadTime?runtime.formatReadTime(row.seconds,{compact:true}):'—',tr,{class:'sc-figure-cell'});
    }
   };
   const redraw=()=>{treeBox.replaceChildren();branch(sorted(tree),treeBox);if(!treeBox.childNodes.length){const none=emptyCard(treeBox,{title:tree.length?'검색에 맞는 태그가 없습니다.':'태그가 없습니다.',hint:tree.length?'':'문헌을 선택하고 태그를 추가하세요.',icon:'tags'});if(tree.length&&state.tagQuery)button('검색 지우기',()=>{state.tagQuery='';find.value='';redraw();},emptyActions(none));}};
   let typing=null;find.addEventListener('input',()=>{state.tagQuery=find.value;win.clearTimeout(typing);typing=win.setTimeout(redraw,120);});
   order.addEventListener('change',()=>{state.tagSort=order.value;redraw();});
   function branch(nodes,parent,depth=0){for(const n of nodes){
    // A leaf has nothing to disclose, so it skips <details> and the triangle
    // that promised children it does not have.
    const hasKids=!!(n.children&&n.children.length);
    const container=hasKids?node('details',null,parent):node('div',null,parent,{class:'sc-tag-leaf'});
    container.style.setProperty('--sc-tag-depth',String(depth));
    if(hasKids&&(state.tagQuery||openPaths.has(n.path)))container.open=true;
    if(hasKids)container.addEventListener('toggle',()=>{if(container.open)openPaths.add(n.path);else openPaths.delete(n.path);});
    const row=hasKids?node('summary',null,container):node('div',null,container,{class:'sc-tag-row'});
    // The name itself chooses the tag for 함께 붙은 태그, below the tree.
    const nameBtn=button('',()=>{state.tagFocus=state.tagFocus===n.path?'':n.path;redraw();redrawCross();},row,{class:'sc-tag-name','aria-pressed':String(state.tagFocus===n.path),title:n.path||n.name});
    // The name in its own box so a long tag ends in an ellipsis instead of being cut (arXiv category tags run long).
    node('span',n.name,nameBtn,{class:'sc-tag-label'});
    // The count is a badge, not a parenthesis: "#methods 2".
    nameBtn.appendChild(doc.createTextNode(' '));node('span',String(n.count),nameBtn,{class:'sc-count'});
    nameBtn.addEventListener('click',event=>event.stopPropagation());
    const r=readingOf(n.path);if(r.total){const time=r.seconds>0&&runtime.formatReadTime?runtime.formatReadTime(r.seconds,{compact:true}):'';
     node('span',[T(`완료 ${r.done}/${r.total}`),time,r.last?calendarAgo(r.last):''].filter(Boolean).join(' · '),row,{class:'sc-tag-reading'});
     // The unread under this heading, one press away in the list.
     const left=r.total-r.done-r.reading;
     if(left>0){const go=button(T(`안 읽음 ${left}편`),()=>{putQuick('explore',[quickTag(n.path),quickStatus('unread')]);return navigate('explore');},row,{class:'sc-tag-unread'});go.addEventListener('click',event=>event.stopPropagation());}}const only=button('이 태그만',()=>{putQuick('explore',[quickTag(n.path)]);navigate('explore');},row,{class:'sc-tag-only'});only.addEventListener('click',event=>event.stopPropagation());if(hasKids)branch(sorted(n.children),container,depth+1);}}redraw();redrawCross();
  }
  /* A note needs a paper. Opening this tab with the whole library in scope
     used to show a disabled editor and "select a paper", with no paper to
     be seen: the papers open in reader tabs, the recent ones, and whatever
     the search box matches are offered here, one press each. */
  function notePaperChooser(){
   const pick=item=>{state.selected=new Set([String(item.id)]);render();};
   const byId=id=>state.items.find(i=>String(i.id)===String(id));
   node('p','노트를 붙일 문헌을 하나 고르세요. 열려 있는 논문·최근 문헌에서 누르거나, 위 검색창으로 찾으세요.',body,{class:'sc-muted'});
   const open=[];
   try{for(const tab of (typeof reader?.tabs==='function'?reader.tabs(win):[])){if(!tab.itemID)continue;const ref=runtime.Z?.Items?.get?.(Number(tab.itemID));const paper=(ref?.parentID&&byId(ref.parentID))||byId(tab.itemID);if(paper&&!open.some(i=>String(i.id)===String(paper.id)))open.push(paper);}}catch(error){runtime.Z?.logError?.(error);}
   if(open.length){sectionHead('지금 열려 있는 논문',open.length);const b=bar();for(const it of open)button(it.title,()=>pick(it),b,{'data-pick':String(it.id)});}
   const when=v=>typeof v==='number'?(Number.isFinite(v)?v:0):((runtime.localStamp?runtime.localStamp(v)?.getTime():Date.parse(v||''))||0);
   const activity=it=>Math.max(when(it.lastRead),when(it.dateModified),when(it.dateAdded));
   const list=rows();
   // Twelve of them fit. When a title was typed, the twelve are the closest
   // matches, not the first twelve the library happens to hold.
   const offered=new Set(open.map(i=>String(i.id)));
   const rest=list.filter(i=>!offered.has(String(i.id)));
   const shown=(state.query?model.rankByQuery(rest,state.query):[...rest].sort((a,b)=>activity(b)-activity(a)||String(a.id).localeCompare(String(b.id)))).slice(0,12);
   if(state.query)sectionHead('검색 결과',list.length>12?`${list.length}편 중 12편`:`${list.length}편`);
   else sectionHead('최근 문헌',list.length?`${list.length}편`:'');
   if(shown.length){const b=bar();for(const it of shown)button(String(it.title||'').slice(0,60),()=>pick(it),b,{'data-pick':String(it.id),title:it.title});}
   else empty(state.query?'검색에 맞는 문헌이 없습니다. 검색어를 바꿔 보세요.':'이 범위에 문헌이 없습니다. 범위를 라이브러리로 바꾸세요.');
   const acts=bar();button('현재 선택 가져오기',()=>{const picked=runtime.selected(win);if(!picked.length){message('Zotero 목록에서 선택한 문헌이 없습니다. 목록에서 먼저 고르세요.',true);return;}state.selected=new Set(picked.slice(0,1).map(i=>String(i.id)));render();},acts,{'data-variant':'primary'});
  }
  async function drawNotes(token){const target=selected();
   // 40 at a time, until 더 보기 asks for more; a new query, library, scope
   // or filter starts back at 40 rather than keeping whatever was reached.
   const noteContext=JSON.stringify([state.query,state.scope,state.libraryID,state.status,state.ratingMin,state.yearFrom,state.yearTo,state.tag,state.type,state.color,activeRules()]);
   if(state.noteContext!==noteContext){state.noteContext=noteContext;state.noteLimit=40;}
   // Notes first, so the compose fold can say how many the paper has and stay closed over them.
   const own=target.length===1&&!state.query&&scoped().some(i=>String(i.id)===String(target[0].id));
   const notes=await scopeNotes(own?[String(target[0].id)]:ids());if(token!==epoch||disposed)return;
   const mine=target.length===1?(own?notes:notes.filter(n=>String(n.parentID||'')===String(target[0].id))).length:notes.length;
   /* The compose area folds by default when there is something to read; it opens when there is nothing yet, when an unsaved draft is in it, or when the reader opened it (kept across redraws). */
   const composeKey=target.length===1?String(target[0].id):'choose';
   const draftKey=draftContext+'|새 노트 내용|0';
   const hasDraft=target.length===1&&!!String(drafts.get(draftKey)||'').trim();
   const wantOpen=hasDraft||state.noteComposeOpen===composeKey||(!mine&&!state.query);
   // One head: "이 문헌의 노트 · 1" with its actions on the right (built here, placed in the head below).
   const headLine=doc.createElement('span');headLine.className='sc-section-head-actions';
   const host=node('div',null,body,{class:'sc-note-compose'});
   host.hidden=!wantOpen;
   const toggle=button(target.length===1?'새 노트 쓰기':'노트 붙일 문헌 고르기',()=>{host.hidden=!host.hidden;toggle.setAttribute('aria-expanded',String(!host.hidden));state.noteComposeOpen=host.hidden?null:composeKey;},headLine,{class:'sc-quiet-action','aria-expanded':String(wantOpen)});
   if(target.length===1)button('다른 문헌 고르기',()=>{state.selected=new Set();restoreKept();render();},headLine,{class:'sc-quiet-action'});
   if(target.length!==1){
    // Built where it always was, then carried into the fold.
    const mark=body.lastChild;
    if(target.length>1){node('p',`선택한 ${target.length}편 중 하나를 고르세요`,body,{class:'sc-muted'});const pickBar=bar();for(const it of target.slice(0,12))button(it.title,()=>{state.selected=new Set([String(it.id)]);render();},pickBar,{'data-pick':String(it.id)});}else notePaperChooser();
    while(mark.nextSibling)host.appendChild(mark.nextSibling);
   }
   else{
    node('p',`${target[0].title}에 새 노트`,host,{class:'sc-muted'});
    const draft=node('textarea',null,host,{'aria-label':'새 노트 내용',placeholder:'선택한 문헌에 새 노트 작성'}),actions=bar(host);const saveNote=button('새 노트 저장',async()=>{if(!draft.value.trim())throw new Error('빈 노트는 만들지 않으니 노트 내용을 먼저 입력하세요.');const submitted=draft.value,parent=one().id,libraryID=state.libraryID;const id=await library.createNote(parent,submitted);noteCache=null;finishDraft(draft,submitted,true);state.lastSavedNote={id,parent,libraryID};state.noteComposeOpen=null;await render();message('노트를 저장했습니다. 필요하면 저장한 노트를 열어 편집하세요.');},actions,{'data-variant':'primary','data-action-key':'create-note:'+state.libraryID+':'+[...state.selected].sort().join(',')});
    // 이 문헌의 주석만으로 노트를 만든다. 주석이 없으면 아무것도 만들지 않는다.
    button('이 문헌 주석에서 노트 만들기',async()=>{
     const paper=target[0],parent=paper.id,libraryID=state.libraryID;
     const marks=await library.annotations([parent]);
     if(!marks.length){message('이 문헌에는 주석이 없어 노트를 만들지 않았습니다.');return;}
     const id=await library.noteFromAnnotations(marks.map(a=>a.id));noteCache=null;
     state.lastSavedNote={id,parent,libraryID};await render();
     message(`주석 ${marks.length}개로 노트를 만들었습니다.`);
    },actions);
    if(state.lastSavedNote?.libraryID===state.libraryID&&state.selected.has(state.lastSavedNote.parent)){const id=state.lastSavedNote.id;button('저장한 노트 열기',()=>library.openItem(id),actions,{'data-opens':'window'});}
   }
   // The notes: the chosen paper's own when it sits in the scope and nothing
   // is being searched; otherwise the scope's, newest first, as a note search.
   /* A note is found by its paper too: "Kim 재현" finds what was written
      about reproducibility in Kim's paper. Every word must be in the note or
      its paper; one found only through the paper says which of its fields. */
   const paperOf=n=>state.items.find(i=>String(i.id)===String(n.parentID||''));
   const sourceHit=new Map();
   const matching=notes.filter(n=>{
    if(model.matches(n.title+' '+n.text,state.query))return true;
    const p_=paperOf(n);if(!p_)return false;
    const meta=[p_.title,p_.authors,p_.year,p_.venue,...(p_.tags||[])].join(' ');
    if(!model.matches(n.title+' '+n.text+' '+meta,state.query))return false;
    const words=String(state.query||'').toLowerCase().split(/\s+/).filter(Boolean);
    const fields=[['저자',p_.authors],['제목',p_.title],['저널',p_.venue],['연도',p_.year],['태그',(p_.tags||[]).join(' ')]];
    const hit=fields.find(([,v])=>words.some(w=>String(v||'').toLowerCase().includes(w)&&!String(n.title+' '+n.text).toLowerCase().includes(w)));
    if(hit){const w=words.find(w=>String(hit[1]||'').toLowerCase().includes(w));const at=String(hit[1]).toLowerCase().indexOf(w);const piece=String(hit[1]).slice(Math.max(0,at-12),at+w.length+24).trim();sourceHit.set(n.id,`${T(hit[0])}: ${piece}`);}
    return true;
   }).sort((a,b)=>String(b.modified||'').localeCompare(String(a.modified||'')));const paperTitle=id=>state.items.find(i=>String(i.id)===String(id))?.title;
   // A note's meta line used to say only the paper's title; whether that
   // paper is read at all is worth as much on the row as when the note was written.
   const paperState=id=>{const p=state.items.find(i=>String(i.id)===String(id));return p?(p.status==='done'?T('완료'):p.status==='reading'?T('읽는 중'):T('안 읽음')):'';};
   /* Finished and never written up: papers marked 완료 in this scope with no
      child note and no memo. Where the reading left nothing behind, the note
      is the one to write while it is fresh. From the notes just read. */
   if(!own&&!state.query){
    const withNote=new Set(notes.map(n=>String(n.parentID||'')));
    // The same papers the notes were read for, filters and all.
    const noteScope=ids(),pool=noteScope?scoped().filter(i=>noteScope.map(String).includes(String(i.id))):scoped();
    const bare=pool.filter(i=>{if(i.status!=='done'||withNote.has(String(i.id)))return false;const ref=runtime.Z.Items.get(Number(i.id));return !String((ref&&runtime.entry?.(ref)?.remark)||'').trim();});
    if(bare.length){
     const fold=node('details',null,body,{class:'sc-notes-missing'});
     if(state.notesMissingOpen)fold.open=true;fold.addEventListener('toggle',()=>{state.notesMissingOpen=fold.open;});
     node('summary',T(`완료했지만 노트도 메모도 없는 문헌 ${bare.length}편`),fold);
     for(const it of bare.slice(0,state.notesMissingAll?bare.length:12)){
      const line=node('div',null,fold,{class:'sc-notes-missing-row'});
      node('span',it.title||T('제목 없음'),line,{class:'sc-notes-missing-title',title:it.title||''});
      button('노트 쓰기',()=>{state.selected=new Set([String(it.id)]);render();},line);
     }
     if(bare.length>12)viewButton(state.notesMissingAll?'12편만 보기':T(`${bare.length}편 모두 보기`),()=>{state.notesMissingAll=!state.notesMissingAll;render();},fold,{class:'sc-local-reading-more'});
    }
   }
   const CAP=state.noteLimit||40;const cut=!own&&matching.length>CAP;const listed=own?matching:matching.slice(0,CAP);
   const noteHead=sectionHead(own?'이 문헌의 노트':state.query?'검색된 노트':cut?'최근 노트':'이 범위의 노트',
    cut?T(`${listed.length}/${matching.length}개 표시`):matching.length);
   noteHead.appendChild(headLine);noteHead.after(host);setNavBadge(matching.length);
   for(const n of listed){const c=card(n.title,[paperTitle(n.parentID),paperState(n.parentID),String(n.modified||'').slice(0,10),sourceHit.has(n.id)?T('문헌 정보 일치')+' — '+sourceHit.get(n.id):''].filter(Boolean).join(' · '));const text=node('p',n.text.length>1200?n.text.slice(0,1200)+'…':n.text,c,{class:'sc-note-text'});if(state.query)noteExcerpt(text,n);/* "전체 내용 보기" replaced the text but left the four-line clamp on, so
    nothing opened; and a note under 1,200 characters but over four lines was
    clamped with no way to open it. The button appears when the note is cut
    either way, and opening removes the clamp. */
   const more=button('전체 내용 보기',()=>{text.textContent=n.text;text.classList.add('sc-note-open');more.remove();},c,{class:'sc-note-more'});
   // Cut by length, or by the four-line clamp at the width it is shown at; the
   // second can only be measured once laid out, and again when the width changes.
   text.dataset.truncated=String(n.text.length>1200);
   more.hidden=!(n.text.length>1200||n.text.split('\n').length>4);
   // An excerpt is always part of the note: the whole of it is one press away.
   if(text.classList.contains('sc-note-excerpt'))more.hidden=false;
   win.requestAnimationFrame?.(syncNoteOverflow);if(!own&&n.parentID&&paperTitle(n.parentID))button('이 문헌에 노트 쓰기',()=>{state.selected=new Set([String(n.parentID)]);state.query=search.value='';render();},c);button('노트 편집',()=>library.openItem(n.id),c,{'data-opens':'window'});button('내용 복사',()=>copy(n.text),c);
    // The list had no way to let a note go. Trash, not delete: Zotero's trash keeps it.
    button('휴지통으로',()=>run(async()=>{await library.trashItems([n.id]);noteCache=null;await render();message('노트를 휴지통으로 옮겼습니다. Zotero 휴지통에서 복원할 수 있습니다.');}),c,{class:'sc-danger-soft',title:'삭제하지 않고 Zotero 휴지통으로 옮깁니다'});}
   if(cut)button('더 보기',()=>{state.noteLimit=CAP+40;render();},body,{class:'sc-notes-more'});
   if(!matching.length)empty(state.query?'검색에 맞는 노트가 없습니다. 검색어를 바꿔 보세요.':own?'이 문헌에는 아직 노트가 없습니다. 위에 첫 노트를 쓰세요.':'이 범위에 노트가 없습니다. 위에서 문헌을 골라 첫 노트를 쓰세요.');}
  /* Searching, a note shows where it matched: up to two passages around the
     words, the words themselves in bold and underlined, no background --
     not its first four lines, which may be nowhere near. Matched only in the
     title, it says so. 전체 내용 보기 still gives the whole note. */
  function noteExcerpt(text,n){
   const body_=String(n.text||''),lower=body_.toLowerCase();
   const words=String(state.query||'').toLowerCase().split(/\s+/).filter(Boolean);
   const hits=[];for(const w of words){const at=lower.indexOf(w);if(at>=0)hits.push(at);}
   hits.sort((a,b)=>a-b);
   if(!hits.length){if(words.some(w=>String(n.title||'').toLowerCase().includes(w))){text.dataset.excerpt='true';text.textContent=body_.slice(0,240)+(body_.length>240?'…':'');node('span',T('제목에서 일치'),text,{class:'sc-muted sc-note-title-hit'});}return;}
   const spans=[];for(const at of hits){const from=Math.max(0,at-80),to=Math.min(body_.length,at+160);const last=spans[spans.length-1];if(last&&from<=last[1])last[1]=Math.max(last[1],to);else spans.push([from,to]);if(spans.length>=2)break;}
   text.replaceChildren();text.classList.add('sc-note-excerpt');
   const pattern=new RegExp('('+words.map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')','gi');
   for(const [i,[from,to]] of spans.entries()){
    if(i||from)text.appendChild(doc.createTextNode('…'));
    for(const part of body_.slice(from,to).replace(/\s+/g,' ').split(pattern)){if(!part)continue;if(words.includes(part.toLowerCase()))node('span',part,text,{class:'sc-search-hit'});else text.appendChild(doc.createTextNode(part));}
   }
   if(spans[spans.length-1][1]<body_.length)text.appendChild(doc.createTextNode('…'));
  }
  /* Reading back through what you marked up.

     The list was a stack of boxed cards, each with a four-pixel colour bar down
     its side, a checkbox labelled "주석 선택", and two buttons always showing.
     Six annotations filled the window and the chrome outweighed the text, which
     is the wrong way round for a panel whose whole job is to let you read your
     own highlights in one go.

     Now the highlight is the content and everything else gets out of its way:
     a colour dot and the page, the text at reading size, the comment under it
     as an editable memo, and the actions only on hover. */
  async function drawAnnotations(token){
   /* '색 없음' and "no colour filter" both used state.color=''; pressing the
      chip could not tell one from the other and did nothing. A sentinel that
      is neither '' nor a real hex lets 색 없음 actually filter to colourless
      annotations. */
   const NO_COLOR='\u0000none';
   const colorKey=hex=>hex?hex:NO_COLOR;
   const colorMatches=a=>{if(!state.color)return true;if(state.color===NO_COLOR)return !String(a.color||'').trim();return String(a.color||'').toLowerCase()===state.color.toLowerCase();};
   /* One search box, the panel's own: it narrows annotations by their text and
      memo, and says so in its placeholder on this tab. A second box here held
      the same query in two places (Codex, round 2). */
   // The three things done to a selection sit with the selection, after the
   // list's summary; the colour swatches there filter by colour, so the hex
   // box and its button are gone.
   const selectionTools=node('div',null,null,{class:'sc-annot-selection'});
   const chosenCount=node('span','',selectionTools,{class:'sc-annot-chosen',role:'status'});
   const colorEdit=node('input',null,selectionTools,{type:'color',value:'#ffd400','aria-label':'선택 주석 새 색상',title:'선택 주석에 칠할 색'});
   button('선택 주석 색 바꾸기',async()=>{
    const chosen=[...state.annotationIDs].filter(id=>visibleAnnotationIDs.has(id));
    if(!chosen.length)throw new Error('현재 범위의 주석을 선택하세요.');
    const count=await library.recolorAnnotations(chosen,colorEdit.value);
    await render();message(`${count}개 주석의 색상을 변경했습니다.`);
   },selectionTools);
   button('선택 주석을 노트로',async()=>{
    const chosen=[...state.annotationIDs].filter(id=>visibleAnnotationIDs.has(id));
    if(!chosen.length)throw new Error('현재 범위의 주석을 선택하세요.');
    const id=await library.noteFromAnnotations(chosen);noteCache=null;
    await library.openItem(id);message('출처 링크가 포함된 노트를 만들었습니다.');
   },selectionTools,{'data-opens':'window'});
   // Offered only from a second annotation on; the restriction used to stand
   // as its own paragraph under the list all the time, whether or not merging
   // was even possible yet -- it is this button's title now.
   const mergeBtn=button('선택 주석 병합',async()=>{
    const chosen=[...state.annotationIDs].filter(id=>visibleAnnotationIDs.has(id));
    const mark=epoch;
    const id=await library.mergeAnnotations(chosen,{isCurrent:()=>!disposed&&!panel.hidden&&epoch===mark});
    state.annotationIDs=new Set([String(id)]);
    await render();message('주석을 병합했습니다. 나머지 주석은 휴지통에서 복원할 수 있습니다.');
   },selectionTools,{'data-needs':'2',title:'병합은 같은 PDF·유형·색상에, 같은 페이지 또는 인접한 두 페이지에서만 됩니다. 기존 참조 노트의 링크는 바뀌지 않습니다.'});
   const mergeFeatureOff=mergeBtn.hidden;
   body.appendChild(selectionTools);

   const list=await library.annotations(ids());
   if(token!==epoch||disposed)return;
   // Every filter but colour: the chips count from this, so choosing one colour leaves the others to choose.
   /* The search reads the paper an annotation is in as well as its words:
      "Kim 대조군" finds what was marked on the control in Kim's paper. One
      that matched only through its paper says so. */
   const paperByID=new Map(state.items.map(i=>[String(i.id),i]));
   const sourceText=a=>{const paper=paperByID.get(String(a.parentID||''));return paper?[paper.title,paper.authors,paper.venue,paper.year,...(paper.tags||[])].join(' '):'';};
   const viaSource=new Set();
   const unfiltered=list.filter(a=>{
    if(setting('annotationIgnoreFigures',false)&&/^(?:figure|fig\.?|table|그림|표)\s*\d/i.test((a.text||'').trim()))return false;
    if(!state.query||model.matches(a.text+' '+a.comment,state.query))return true;
    if(model.matches(a.text+' '+a.comment+' '+sourceText(a),state.query)){viaSource.add(a.id);return true;}
    return false;
   });
   const filtered=unfiltered.filter(a=>colorMatches(a)&&(!state.annotationPaperID||String(a.parentID||'')===state.annotationPaperID));
   state.annotationIDs=new Set([...state.annotationIDs].filter(id=>filtered.some(a=>a.id===id)));
   setNavBadge(filtered.length||null);

   // Nothing at all to show: no chips or table either. With annotations that a colour or paper filter hides, those stay (below).
   if(!unfiltered.length){
    selectionTools.hidden=true;
    empty(state.color?'이 색의 주석이 없습니다. 색 필터가 켜져 있습니다.':'조건에 맞는 주석이 없습니다. PDF에서 하이라이트나 메모를 추가하세요.');
    if(state.color||state.annotationPaperID)button('색 필터 해제',()=>{state.color='';state.annotationPaperID='';render();},body,{'data-variant':'primary'});
    return;
   }

   // A short memo on the paper itself, saved as you type. Writing one used to
   // mean making a whole note item; this is the scrap-of-paper version.
   const chosenPapers=selected();
   if(chosenPapers.length===1)drawPaperMemo(chosenPapers[0]);

   const counts=new Map();
   // #FFD400 and #ffd400 are one colour: one chip, one count, one filter.
   for(const a of unfiltered){const hex=String(a.color||'').toLowerCase();counts.set(hex,(counts.get(hex)||0)+1);}
   const labels=runtime.cache.readerSettings?.colorLabels||{};
   const colorMeaning=hex=>{const key=Object.keys(labels).find(k=>k.toLowerCase()===String(hex||'').toLowerCase());return key?String(labels[key]||'').trim().slice(0,24):'';};
   const summary=bar();
   node('span',`주석 ${filtered.length}개`,summary,{class:'sc-muted'});
   // One line read by meaning, not a row of colour pills: "핵심 결과 12 · 방법
   // 8 · 색 없음 2". A colour without a reader-given label still gets a
   // neutral name here; its hex only shows in the title, on hover.
   [...counts].sort((a,b)=>b[1]-a[1]).forEach(([hex,n],i)=>{
    const on=state.color===colorKey(hex);
    const meaning=hex?colorMeaning(hex):'';
    const label=hex?(meaning||T('이름 없는 색')):T('색 없음');
    const chip=node('button',null,summary,{class:'sc-annot-swatch',type:'button','aria-pressed':String(on),
     title:on?`${hex} · ${n}개 · 다시 눌러 색 필터 해제`:`${hex||T('색 없음')} · ${n}개 · 눌러서 이 색만 보기`});
    node('span',null,chip,{class:'sc-annot-dot',style:`background:${/^#[0-9a-f]{6}$/i.test(hex)?hex:'var(--sc-faint)'}`});
    node('span',label,chip,{class:'sc-annot-meaning'});
    node('span',String(n),chip);
    chip.addEventListener('click',()=>{state.color=on?'':colorKey(hex);render();});
   });
   // Order of the list, remembered: by paper and page, or by what was touched last.
   const orderBox=node('span',null,summary,{class:'sc-segmented sc-annot-order',role:'group','aria-label':T('주석 정렬')});
   for(const [key,label] of [['page','문헌·쪽순'],['recent','최근 수정순']])viewButton(label,async()=>{await saveUI({annotationOrder:key});render();},orderBox,{'aria-pressed':String((runtime.cache.workbenchUI?.annotationOrder==='recent')===(key==='recent'))});
   /* 문헌별 주석 분포: each paper a row, each colour a column, the count of
      annotations in the cell -- where the methods and the key results were
      marked across papers. The article and its supplement are one paper. A
      cell shows those annotations, keeping the search and scope; the table
      stays, so the next cell is one press away. Counts, not a judgement. */
   const perPaper=new Map();
   for(const a of unfiltered){const pid=String(a.parentID||'');if(!pid)continue;const row=perPaper.get(pid)||new Map();const hex=String(a.color||'').toLowerCase();row.set(hex,(row.get(hex)||0)+1);perPaper.set(pid,row);}
   if(perPaper.size>1){
    const fold=node('details',null,body,{class:'sc-annot-summary'});
    if(state.annotationTableOpen||state.annotationPaperID||state.annotationCompare)fold.open=true;
    fold.addEventListener('toggle',()=>{state.annotationTableOpen=fold.open;});
    node('summary',T(`문헌별 주석 분포 · ${perPaper.size}편`),fold);
    const cols=[...counts.keys()];
    const table=node('table',null,fold,{class:'sc-annot-summary-table'});
    const hr=node('tr',null,node('thead',null,table));node('th',T('문헌'),hr);
    for(const hex of cols){const th=node('th',null,hr);node('span',null,th,{class:'sc-annot-dot',style:`background:${/^#[0-9a-f]{6}$/i.test(hex)?hex:'var(--sc-faint)'}`});node('span',colorMeaning(hex)||hex||T('색 없음'),th);}
    const tbody=node('tbody',null,table);
    const papersSorted=[...perPaper].sort((a,b)=>[...b[1].values()].reduce((x,y)=>x+y,0)-[...a[1].values()].reduce((x,y)=>x+y,0));
    for(const [pid,row] of papersSorted.slice(0,state.annotationTableAll?papersSorted.length:12)){
     const tr=node('tr',null,tbody);
     const nameCell=node('td',null,tr,{class:'sc-annot-summary-paper',title:paperByID.get(pid)?.title||''});
     // Two papers can be chosen to read side by side.
     const chosen=(state.annotationCompareIDs||[]).includes(pid);
     const box=node('input',null,nameCell,{type:'checkbox','aria-label':T(`${paperByID.get(pid)?.title||''} 비교에 넣기`),class:'sc-annot-compare-pick'});box.checked=chosen;
     box.addEventListener('change',()=>{const now=(state.annotationCompareIDs||[]).filter(id=>id!==pid);if(box.checked)now.push(pid);state.annotationCompareIDs=now.slice(-2);render();});
     nameCell.appendChild(doc.createTextNode(paperByID.get(pid)?.title||T('제목 없음')));
     for(const hex of cols){
      const td=node('td',null,tr);const n=row.get(hex)||0;
      if(!n){node('span','·',td,{class:'sc-muted','aria-hidden':'true'});continue;}
      const on=state.annotationPaperID===pid&&state.color===colorKey(hex);
      button(String(n),()=>{state.annotationPaperID=on?'':pid;state.color=on?'':colorKey(hex);render();},td,{class:'sc-annot-summary-cell','aria-pressed':String(on),title:T(on?'다시 누르면 모두 보기':'이 문헌의 이 색 주석만 보기')});
     }
    }
    if(papersSorted.length>12)viewButton(state.annotationTableAll?'12편만 보기':T(`${papersSorted.length}편 모두 보기`),()=>{state.annotationTableAll=!state.annotationTableAll;render();},fold);
    const pair=(state.annotationCompareIDs||[]).filter(id=>perPaper.has(id));
    const tools=node('div',null,fold,{class:'sc-actions'});
    if(pair.length===2)viewButton(state.annotationCompare?'목록으로':'주석 나란히',()=>{state.annotationCompare=!state.annotationCompare;render();},tools,{'data-variant':state.annotationCompare?'':'primary'});
    else node('span',T('비교할 문헌 두 편을 고르세요'),tools,{class:'sc-muted'});
    /* 주석 나란히: the two papers as columns, the colour meanings as rows, the
       first two annotations of each in the cell with page and file -- the
       methods of one next to the methods of the other. The search holds;
       colour and paper filters are set aside here and back on return. */
    if(state.annotationCompare&&pair.length===2){
     if(state.color||state.annotationPaperID)node('p',T('나란히 보는 동안 색·문헌 필터는 적용하지 않습니다. 목록으로 돌아가면 다시 적용됩니다.'),body,{class:'sc-muted sc-annot-compare-note'});
     const grid=node('div',null,body,{class:'sc-annot-compare'});
     node('span','',grid,{class:'sc-annot-compare-corner'});
     for(const pid of pair)node('span',paperByID.get(pid)?.title||T('제목 없음'),grid,{class:'sc-annot-compare-head',title:paperByID.get(pid)?.title||''});
     const fileName=id=>{const ref=runtime.Z.Items.get?.(Number(id));return String(ref?.getField?.('title')||'');};
     for(const hex of cols){
      const rowHead=node('span',null,grid,{class:'sc-annot-compare-meaning'});
      node('span',null,rowHead,{class:'sc-annot-dot',style:`background:${/^#[0-9a-f]{6}$/i.test(hex)?hex:'var(--sc-faint)'}`});
      node('span',colorMeaning(hex)||hex||T('색 없음'),rowHead);
      for(const pid of pair){
       const cell=node('div',null,grid,{class:'sc-annot-compare-cell'});
       const these=unfiltered.filter(a=>String(a.parentID||'')===pid&&String(a.color||'').toLowerCase()===hex).sort((a,b)=>(a.pageIndex??1e9)-(b.pageIndex??1e9));
       if(!these.length){node('span',T('이 조건의 주석 없음'),cell,{class:'sc-muted'});continue;}
       const key=pid+'|'+hex,all=state.annotationCompareMore?.[key];
       // Named by file when the paper has more than one, whichever colour this row is.
       const files=new Set(unfiltered.filter(a=>String(a.parentID||'')===pid).map(a=>String(a.attachmentID)));
       for(const a of these.slice(0,all?these.length:2)){
        const item_=node('div',null,cell,{class:'sc-annot-compare-item'});
        const where=[`p.${a.pageLabel||((a.pageIndex??0)+1)}`,files.size>1?fileName(a.attachmentID):''].filter(Boolean).join(' · ');
        button(where,()=>run(()=>library.openItem(a.id)),item_,{class:'sc-annot-compare-where','data-opens':'window',title:T('원문 위치 열기')});
        // Long excerpts open in place.
        const clip=(text,limit,cls)=>{if(!text)return;const p_=node('p',text.length>limit?text.slice(0,limit)+'…':text,item_,{class:cls});if(text.length>limit){const whole=button('전체',()=>{p_.textContent=text;whole.remove();},item_,{class:'sc-annot-compare-more'});}};
        clip(a.text,280,'sc-annot-compare-text');clip(a.comment,200,'sc-annot-compare-comment');
       }
       if(these.length>2)viewButton(all?'2개만 보기':T(`${these.length-2}개 더 보기`),()=>{state.annotationCompareMore={...(state.annotationCompareMore||{}),[key]:!all};render();},cell,{class:'sc-annot-compare-more'});
      }
     }
     // The selection verbs act on the list, which is set aside here.
     selectionTools.hidden=true;
     return;
    }
   }
   if(state.annotationPaperID)button(T(`문헌: ${String(paperByID.get(state.annotationPaperID)?.title||'').slice(0,30)} ×`),()=>{state.annotationPaperID='';render();},summary,{class:'sc-annot-paper-filter'});
   if(!filtered.length){
    selectionTools.hidden=true;
    const emptied=empty('이 색·문헌 조건에 맞는 주석이 없습니다. 위 표나 색에서 다른 칸을 고르거나 필터를 해제하세요.');
    button('색·문헌 필터 해제',()=>{state.color='';state.annotationPaperID='';render();},emptyActions(emptied),{'data-variant':'primary'});
    return;
   }
   button('보이는 주석 전체 선택',()=>{state.annotationIDs=new Set(visibleAnnotationIDs);render();},summary,{class:'sc-annot-select-all'});
   // Drawn every time, hidden by syncChosen() rather than only appearing when
   // annotationIDs already had something in it at draw time -- selecting the
   // first card never redraws the panel, so a button that only exists when
   // the count was already non-zero could never appear on that first click.
   const clearBtn=button('선택 해제',()=>{state.annotationIDs=new Set();render();},summary,{'data-role':'annot-clear'});
   // The three verbs act on the selection, so with nothing chosen there is
   // nothing here to show -- not a row of disabled buttons waiting for one.
   const syncChosen=()=>{
    const n=[...state.annotationIDs].filter(id=>visibleAnnotationIDs.has(id)).length;
    clearBtn.hidden=!state.annotationIDs.size;
    clearBtn.textContent=T(`선택 해제 (${state.annotationIDs.size})`);
    selectionTools.hidden=!n;
    if(!n)return;
    chosenCount.textContent=T(`선택 ${n}개`);
    // Merging needs two; offered only once there is a second to merge with,
    // and still hidden when the reader feature itself turned it off.
    mergeBtn.hidden=mergeFeatureOff||n<2;
   };
   summary.appendChild(selectionTools);

   // Grouped by paper, then file; page order is the order they were made in, the only one that reads as a pass through the paper.
   const byDocument=new Map();
   for(const a of filtered){
    const key=a.attachmentID||'';
    if(!byDocument.has(key))byDocument.set(key,[]);
    byDocument.get(key).push(a);
   }
   /* Group names come from the documents on screen, read directly. Asking
      library.attachments for them listed every attachment in scope and
      checked each file on disk -- on every colour click. */
   const titles=new Map(),parents=new Map();
   // Each annotation already says which paper it is in; that names the group before any lookup.
   for(const a of filtered)if(a.attachmentID&&a.parentID&&!parents.has(a.attachmentID))parents.set(a.attachmentID,String(a.parentID));
   let unresolved=false;
   for(const id of byDocument.keys()){
    const doc_=id?runtime.Z.Items.get?.(Number(id)):null;
    if(!doc_){if(id)unresolved=true;continue;}
    titles.set(id,String(doc_.getField?.('title')||''));if(doc_.parentID&&!parents.has(id))parents.set(id,String(doc_.parentID));
   }
   if(unresolved){
    const attachmentRows=await library.attachments(ids());
    for(const a of attachmentRows)if(!titles.has(a.id)){titles.set(a.id,a.title);if(!parents.has(a.id))parents.set(a.id,a.parentID);}
   }
   // Three groups all called "Full text PDF" say nothing; the paper's title does.
   const paperOf=id=>{const parent=parents.get(id);return parent?state.items.find(i=>String(i.id)===String(parent))?.title:null;};
   const fileTitle=id=>titles.get(id)||T('첨부파일');
   // Recent order sorts papers, files and annotations by modification date, unknown dates last.
   const recent=runtime.cache.workbenchUI?.annotationOrder==='recent';
   const stamp=a=>String(a.modified||a.dateModified||'');
   const newer=(x,y)=>x&&y?y.localeCompare(x):x?-1:y?1:0;
   const latest=list_=>list_.reduce((m,a)=>stamp(a)>m?stamp(a):m,'');
   const byPaper=new Map();
   for(const [id,group] of byDocument){
    const key=parents.get(id)||'att:'+id;
    if(!byPaper.has(key))byPaper.set(key,{key,files:[],count:0});
    const entry=byPaper.get(key);entry.files.push({id,group});entry.count+=group.length;
   }
   for(const entry of byPaper.values()){
    for(const file of entry.files)file.group.sort(recent?(x,y)=>newer(stamp(x),stamp(y))||(x.pageIndex??1e9)-(y.pageIndex??1e9):(x,y)=>(x.pageIndex??1e9)-(y.pageIndex??1e9));
    if(recent){for(const file of entry.files)file.at=latest(file.group);entry.files.sort((x,y)=>newer(x.at,y.at));entry.at=entry.files[0]?.at||'';}
   }
   const papers=[...byPaper.values()];
   if(recent)papers.sort((x,y)=>newer(x.at,y.at));
   if(token!==epoch||disposed)return;


   let budget=state.annotationBudget||setting('annotationPageSize',150);
   const rest=[];
   for(const paperEntry of papers){
    if(budget<=0){rest.push(paperEntry);continue;}
    const first=paperEntry.files[0].id,parentKey=parents.get(first);
    // The paper's head and meta once; with several papers each shows three first, so one long paper does not push the others off the page.
    // One container per paper: its head, meta, files and annotations.
    const paperBox=node('section',null,body,{class:'sc-annot-paper'});
    const head=node('h3',null,paperBox,{class:'sc-annot-group'});
    node('span',paperOf(first)||fileTitle(first),head,{class:'sc-annot-group-name'});
    node('span',`${paperEntry.count}`,head,{class:'sc-annot-group-count'});
    const paper=paperByID.get(String(parentKey||''));
    if(paper){
     const status=paper.status==='done'?T('완료'):paper.status==='reading'?T('읽는 중'):T('안 읽음');
     // The journal in its own ink, like the library cards; the pieces joined by one separator style.
     const metaLine=node('p',null,paperBox,{class:'sc-annot-group-meta'});
     [paper.year,paper.venue,status,state.query?T(`일치 주석 ${paperEntry.count}개`):''].filter(Boolean).forEach((part,index)=>{
      if(index)metaLine.appendChild(doc.createTextNode(' · '));
      const piece=node('span',String(part),metaLine);if(part===paper.venue)inkJournal(piece,part);
     });
    }
    const capped=papers.length>1&&!openAnnotGroups.has(paperEntry.key)&&paperEntry.count>3;
    // What is drawn is what is spent.
    budget-=capped?3:paperEntry.count;
    let left=capped?3:Infinity;
    for(const {id:attachmentID,group} of paperEntry.files){
     if(left<=0)break;
     if(paperEntry.files.length>1)node('h4',fileTitle(attachmentID),paperBox,{class:'sc-annot-file',title:fileTitle(attachmentID)});
     const stack=node('div',null,paperBox,{class:'sc-annots'});
     for(const a of group.slice(0,left)){
      left--;
       visibleAnnotationIDs.add(a.id);
       const tint=/^#[0-9a-f]{6}$/i.test(a.color)?a.color:'var(--sc-faint)';
       const row=node('article',null,stack,{class:'sc-annot',tabindex:'0','data-selected':String(state.annotationIDs.has(a.id))});
       // The annotation's colour, shown as a square before its page (see the CSS).
       row.style.setProperty('--sc-annot',tint);
       const head=node('div',null,row,{class:'sc-annot-head'});
       node('span',`p.${a.pageLabel||((a.pageIndex??0)+1)}`,head,{class:'sc-annot-page'});
       if(a.type&&a.type!=='highlight')node('span',({underline:'밑줄',note:'메모',image:'그림',ink:'필기',text:'텍스트'})[a.type]||a.type,head,{class:'sc-annot-kind'});
       const actions=node('div',null,head,{class:'sc-annot-actions'});
       button('원문',()=>library.openItem(a.id),actions,{'data-opens':'window'});
       button('내용 복사',()=>copy(a.text+(a.comment?'\n'+a.comment:'')),actions);
       button('참조 노트',async()=>{
        const mark=epoch,links=await library.backlinks(a.id);
        if(disposed||mark!==epoch||!row.isConnected)return;
        let box=row.querySelector('[data-annotation-backlinks]');
        if(!box)box=node('div',null,row,{'data-annotation-backlinks':'true',class:'sc-annot-links'});
        box.replaceChildren();
        const notes=links.filter(link=>link.kind==='note');
        node('span',notes.length?`참조 노트 ${notes.length}개`:'이 주석을 인용한 노트가 없습니다.',box,{class:'sc-muted'});
        for(const note of notes)button(note.title||'제목 없는 노트',()=>library.openItem(note.id),box,{'data-opens':'window'});
       },actions);
       if(viaSource.has(a.id))node('span',T('문헌 정보로 찾음'),head,{class:'sc-annot-via',title:T('검색어가 주석이 아니라 이 주석이 있는 문헌의 제목·저자·저널·태그에 있습니다')});
       if(a.text)node('p',a.text,row,{class:'sc-annot-text'});
       // The annotation's own comment is the memo: it travels with the highlight,
       // shows in the reader and syncs, so there is no second place to look.
       const writeMemo=(focus)=>{
        const memoRow=node('div',null,row,{class:'sc-annot-memo-row'});
        node('span',T('메모'),memoRow,{class:'sc-annot-memo-label','aria-hidden':'true'});
        const memo=node('textarea',null,memoRow,{class:'sc-annot-memo',rows:'1',
         placeholder:'메모','aria-label':'이 주석의 메모'});
        memo.value=a.comment||'';
        autoGrow(memo);
        bindMemo(memo,value=>library.setAnnotationComment(a.id,value),`주석 ${a.pageLabel||''}`);
        if(focus)memo.focus();
        return memo;
       };
       if(a.comment)writeMemo(false);
       else{
        const add=button('메모',()=>{add.remove();writeMemo(true);},actions,{class:'sc-annot-add-memo'});
       }
       // Clicking the card selects it; the checkbox that used to do this carried a
       // label longer than most of the annotations.
       row.addEventListener('click',event=>{
        if(event.target.closest('button, textarea, a'))return;
        if(state.annotationIDs.has(a.id))state.annotationIDs.delete(a.id);
        else state.annotationIDs.add(a.id);
        row.dataset.selected=String(state.annotationIDs.has(a.id));
        syncChosen();
       });
       row.addEventListener('keydown',event=>{
        if(event.target!==row)return; // Space and Enter typed in the memo stay in the memo.
        if(event.key===' '||event.key==='Enter'){event.preventDefault();row.click();}
       });
      }
     }
     if(capped)viewButton(T(`이 문헌 주석 ${paperEntry.count-3}개 더 보기`),()=>{openAnnotGroups.add(paperEntry.key);render();},paperBox,{class:'sc-annot-group-more'});
   }
   syncChosen();
   if(rest.length){
    const more=rest.reduce((sum,entry)=>sum+entry.count,0);
    const wrap=node('div',null,body,{class:'sc-annot-more'});
    node('span',`${rest.length}개 문헌의 주석 ${more}개가 더 있습니다.`,wrap,{class:'sc-muted'});
    button('더 보기',()=>{state.annotationBudget=(state.annotationBudget||setting('annotationPageSize',150))+300;render();},wrap,{'data-variant':'primary'});
   }
  }

  // A textarea that grows to its text rather than scrolling inside two lines.
  function autoGrow(field){
   const fit=()=>{field.style.height='auto';field.style.height=(field.scrollHeight+2)+'px';};
   field.addEventListener('input',fit);
   fit();
  }

  /* A memo that saves itself.

     Every note in this panel used to need a button pressed after it, which is
     the difference between jotting something down and filing a document. This
     writes a second after typing stops, and says so rather than saving in
     silence -- an edit that vanished without a word would be worse than a
     button. */
  const memoBindings=new WeakMap();
  /* Every place that learns a memo's stored text after an await (a save that adopted the note's text, a conflict choice, a
     note write) comes through here: the editors for that paper that are connected NOW (not the one that asked, which a redraw may
     have replaced) take the text only if they still hold what they held when the request began. Anything typed since stays and
     the autosave carries it. `requested` is the value or values that count as "unchanged". */
  /* Stale answers are dropped by revision: an answer that carries memo text also carries `rev`, the memo revision it was current at.
     It is propagated only if that is still the memo's revision (an answer without one, from a stand-in library, is taken as current).
     A completion also touches only editors that existed when it began and have had no input since (their input generation is
     unchanged), or a new editor that has had none at all. */
  function memoRevNow(itemID){try{const ref=runtime.Z.Items.get(Number(itemID));const row=ref&&runtime.entry(ref);return row?(row.memoRev||0):0;}catch(_){return 0;}}
  const answerFresh=(itemID,rev)=>rev===undefined||rev===memoRevNow(itemID);
  // When a memo write settles (resolved or rolled back) the editors of that paper reconcile again.
  const stopMemoListener=runtime.addMemoListener?runtime.addMemoListener(item=>{if(disposed)return;reconcileAll(item.id,true);tidyKept(item.id);for(const e of body.querySelectorAll('textarea[data-memo-item]'))if(e.dataset.memoItem===String(item.id)&&e.isConnected)memoBindings.get(e)?.drawKept?.();}):null;
  function memoPendingNow(itemID){try{const ref=runtime.Z.Items.get(Number(itemID));return !!(ref&&runtime.memoWritePending?.(ref));}catch(_){return false;}}
  // `idleOnly`: the settle listener leaves editors that have a request of their own running; that request reconciles in its finally, after it has handled its answer.
  function reconcileAll(itemID,idleOnly=false){for(const e of body.querySelectorAll('textarea[data-memo-item]')){if(e.dataset.memoItem!==String(itemID)||!e.isConnected)continue;const b=memoBindings.get(e);if(idleOnly&&b&&b.busy>0)continue;b?.reconcile?.();}}
  function editorGens(itemID){const gens=new Map();for(const e of body.querySelectorAll('textarea[data-memo-item]')){if(e.dataset.memoItem!==String(itemID)||!e.isConnected)continue;const b=memoBindings.get(e);if(b)gens.set(b,b.gen);}return gens;}
  function syncMemoEditors(itemID,text,requested,opts={}){
   if(!answerFresh(itemID,opts.rev))return false;
   const id=String(itemID),was=(Array.isArray(requested)?requested:[requested]).filter(v=>typeof v==='string');
   let stale=false;
   for(const editor of body.querySelectorAll('textarea[data-memo-item]')){
    if(editor.dataset.memoItem!==id||!editor.isConnected)continue;
    // An editor with an open conflict (a stale save or a draft on offer) keeps it: only its own choice closes it.
    const target=memoBindings.get(editor);
    if(target?.stale||!was.includes(editor.value)||(target&&target.gen!==(opts.gens?.get(target)??0))){stale=true;continue;}
    if(editor.dataset.draftKey)for(const v of was)finishDraft(editor,v);
    memoBindings.get(editor)?.show(text);
   }
   const held=state.items.find(i=>String(i.id)===id);if(held&&!stale)held.remark=text;
   // A conflict box of a redrawn panel was drawn before this answer: it asks again.
   for(const editor of body.querySelectorAll('textarea[data-memo-item]'))if(editor.dataset.memoItem===id&&editor.isConnected)Promise.resolve(memoBindings.get(editor)?.refresh?.()).catch(()=>{});
   return !stale;
  }
  /* Every memo editor is a compare-and-swap writer. `opts.memo={itemID,base,host}`: `base` is the stored memo this editor's
     text derives from. It moves in ONE function (moveBase): to the text a save of this editor's own text returned, or to a
     stored text the editor is made to show (`show`). A write from an editor whose base is no longer the stored memo is
     refused by the library ({stale}): nothing is overwritten and both texts wait in `host` for the reader.
     A saved draft that cannot be restored safely is never offered as a conflict and never edited: it is moved to the kept
     drafts of that paper (cache.memoKept), shown as a card, and only 입력칸에 넣기 or 버리기 on that card ever removes it. */
  const storedMemo=itemID=>{try{const ref=runtime.Z.Items.get(Number(itemID));return String((ref&&runtime.entry(ref).remark)||'');}catch(_){return '';}};
  const KEPT_SHOWN=3; // how many kept drafts show before the toggle; none is ever deleted but by its own buttons
  const keptKey=itemID=>{try{const ref=runtime.Z.Items.get(Number(itemID));return ref?String(runtime.identity(ref)):String(itemID);}catch(_){return String(itemID);}};
  const keptList=itemID=>{const all=runtime.cache.memoKept,list=all&&typeof all==='object'?all[keptKey(itemID)]:null;return Array.isArray(list)?list:[];};
  function keepDraft(itemID,text,base,truncated=false,owner){
   const all=runtime.cache.memoKept&&typeof runtime.cache.memoKept==='object'&&!Array.isArray(runtime.cache.memoKept)?runtime.cache.memoKept:(runtime.cache.memoKept={});
   const list=all[keptKey(itemID)]||(all[keptKey(itemID)]=[]);
   if(list.some(entry=>entry.text===text))return;
   list.push({id:'k'+Date.now().toString(36)+Math.random().toString(36).slice(2,8),text:String(text),base:String(base??''),truncated:!!truncated,owner,at:new Date().toISOString()});
   tidyKept(itemID);
   runtime.dirty=true;Promise.resolve(runtime.flush()).catch(error=>runtime.Z.logError?.(error));
  }
  /* Housekeeping, and nothing else: a kept card goes when its text is the stored memo now (and no write of this paper is pending: that
     stored text may be an in-memory value a failure rolls back). Exact duplicates are never added (keepDraft). A shorter card is never
     dropped for being a prefix of another: it may be the newer text. */
  function tidyKept(itemID){
   const all=runtime.cache.memoKept,key=keptKey(itemID),list=all&&typeof all==='object'?all[key]:null;
   if(!Array.isArray(list))return;
   if(memoPendingNow(itemID))return;
   const stored=storedMemo(itemID);
   const keep=list.filter(entry=>entry.text!==stored);
   if(keep.length!==list.length){if(keep.length)all[key]=keep;else delete all[key];runtime.dirty=true;}
  }
  function dropKept(itemID,id){
   const all=runtime.cache.memoKept,key=keptKey(itemID);
   if(!all||!Array.isArray(all[key]))return;
   all[key]=all[key].filter(entry=>entry.id!==id);if(!all[key].length)delete all[key];
   runtime.dirty=true;Promise.resolve(runtime.flush()).catch(error=>runtime.Z.logError?.(error));
  }
  function followMemoEditors(itemID,text,source,rev,gens){
   if(!answerFresh(itemID,rev))return;
   const id=String(itemID);
   for(const editor of body.querySelectorAll('textarea[data-memo-item]')){
    if(editor===source||editor.dataset.memoItem!==id||!editor.isConnected)continue;
    const binding=memoBindings.get(editor);
    // An editor nobody has touched since it loaded follows the stored memo; one with edits or an open conflict keeps them (its next save is judged against its base).
    if(binding&&gens&&binding.gen!==(gens.get(binding)??0))continue; // input since the request began is never replaced
    if(binding&&!binding.stale&&!binding.unsaved&&editor.value===binding.base){if(editor.dataset.draftKey)finishDraft(editor,editor.value);binding.show(text);}
   }
  }
  function bindMemo(field,save,label,opts={}){
   let timer=null,last=field.value,chain=Promise.resolve(),staleBox=null,keptBox=null;
   const cas=opts.memo||null;
   const binding={base:cas?String(cas.base??''):undefined,stale:null,itemID:cas?cas.itemID:undefined,id:WINDOW_ID+'.'+(++bindingSeq),gen:0,unsaved:false,busy:0};
   // `unsaved`: real input (typed, restored, loaded from a kept card) since the editor last showed a stored text. An editor without it only follows the stored memo.
   field.addEventListener('input',()=>{binding.gen++;binding.unsaved=true;}); // input generation: a completion never replaces text typed after it began
   const grow=()=>{if(typeof autoGrow==='function')autoGrow(field);};
   /* The only place the base moves. `derived`: the text is what this editor itself just submitted and had stored, so the
      editor's current text (possibly typed on since) builds on it. Anything else moves the base only if the editor shows it. */
   const moveBase=(text,derived=false)=>{if(!cas||(!derived&&field.value!==text))return false;binding.base=String(text);binding.confirmIf=undefined;return true;};
   // While the in-memory memo is still the unsettled write this editor was restored over, the editor builds on that text: a save is judged against it.
   binding.effectiveBase=()=>binding.confirmIf!==undefined&&cas&&storedMemo(cas.itemID)===binding.confirmIf?binding.confirmIf:binding.base;
   binding.moveBase=moveBase;
   binding.loaded=cas?String(cas.base??''):undefined; // the text this editor was created with
   // Created over the in-memory value of a write that has not settled: the editor builds on it while it stands, and on the memo before it if it rolls back.
   /* The writes pending when this editor is created are the only ones that may move its base when they settle (their tokens and texts are recorded here). A write that starts later, from any editor or window, is judged by the normal check. */
   const captureKnown=()=>{try{const list=runtime.memoPendingList?.(runtime.Z.Items.get(Number(cas.itemID)))||[];if(!list.length)return undefined;binding.known={tokens:new Set(list.map(w=>w.token)),texts:[list[0].prior,...list.map(w=>w.value)]};return list[0].prior;}catch(_){return undefined;}};
   if(cas&&memoPendingNow(cas.itemID)){const prior=captureKnown();if(typeof prior==='string'&&prior!==binding.base){binding.confirmIf=binding.base;binding.base=prior;}}
   /* After every completion each connected editor of the paper is left in exactly one consistent state:
      (a) it shows the stored memo: base, autosave baseline and stored are one text, no box, its own draft cleared (finishOwn);
      (b) it shows other text on a current base: nothing is open, and the autosave baseline is invalidated so the next blur/autosave saves;
      (c) it shows other text on an old base: a usable conflict box drawn from the stored text and the input now, with a fresh token. */
   binding.reconcile=()=>{
    if(!cas||!field.isConnected)return;
    const stored=storedMemo(cas.itemID),value=field.value;
    // A restored value that was an unsettled write: if that write landed the base becomes it; if it rolled back the base stays on the memo it was typed over.
    const wasConfirm=binding.confirmIf;
    if(!memoPendingNow(cas.itemID)){
     // A base that moves also moves the base its own draft was recorded over, or a redraw would not restore it.
     const rebaseDraft=()=>{if(field.dataset.draftKey&&value!==stored&&binding.draftToken())binding.ownDraftWrite(value,stored);};
     if(binding.confirmIf!==undefined){if(stored===binding.confirmIf){moveBase(stored,true);rebaseDraft();}binding.confirmIf=undefined;}
     /* Made while writes were pending: when THOSE writes have settled, the stored memo may be any text of that stretch (a failed older write does not roll back under a newer one), and those are this editor's own history. A text from a write it did not know about is not. */
     if(binding.known){
      const live=(()=>{try{return runtime.memoPendingList?.(runtime.Z.Items.get(Number(cas.itemID)))||[];}catch(_){return [];}})();
      if(!live.some(w=>binding.known.tokens.has(w.token))){const known=binding.known;binding.known=null;if(known.texts.includes(stored)){moveBase(stored,true);rebaseDraft();}}
     }
    }
    // An editor nobody typed into since it last showed a stored text just follows the stored memo: no draft, no box.
    const holdsDraft=(()=>{const key=field.dataset.draftKey,meta=key?draftMeta(key):null;return !!meta&&meta.owner===binding.id&&draftText(key)!==undefined;})();
    if(!binding.unsaved&&!holdsDraft&&(value===binding.base||value===binding.loaded||value===wasConfirm)){
     if(value!==stored)binding.show(stored);
     else if(!memoPendingNow(cas.itemID)){moveBase(stored);last=stored;clearStale();}
     return;
    }
    if(value===stored){
     // The in-memory memo of a write that has not settled is not the persisted memo: nothing is confirmed or cleared until it does.
     if(memoPendingNow(cas.itemID))return;
     if(timer){win.clearTimeout(timer);timer=null;}
     moveBase(stored);last=stored;clearStale();binding.unsaved=false;
     if(field.dataset.draftKey)binding.finishOwn(value);
     return;
    }
    // The input differs from the stored memo: it must be in this editor's own draft (written through the ownership rules), or a redraw would lose it.
    const ownDraft=()=>{const key=field.dataset.draftKey;if(!key)return;const meta=draftMeta(key);if(meta&&meta.owner===binding.id&&draftText(key)===value)return;writeMemoDraft(field);};
    if(binding.base===stored){clearStale();last=null;ownDraft();return;}
    const s=binding.stale;
    if(!(s&&!s.used&&s.stored===stored&&s.conflict.local===value&&staleBox&&staleBox.isConnected)){
     binding.stale={stale:true,stored,conflict:{local:value,remote:stored},rev:memoRevNow(cas.itemID),used:false};field.dataset.state='stale';drawStale();
    }
    last=value;ownDraft();
   };
   binding.state=()=>({unsaved:binding.unsaved,pending:cas?memoPendingNow(cas.itemID):false,ownDraft:(()=>{const key=field.dataset.draftKey,meta=key?draftMeta(key):null;return meta&&meta.owner===binding.id?draftText(key):undefined;})(),value:field.value,base:binding.base,last,box:!!(staleBox&&staleBox.isConnected),used:!!binding.stale?.used,buttonsEnabled:staleBox?[...staleBox.querySelectorAll('button')].every(b=>!b.disabled):true,stored:cas?storedMemo(cas.itemID):undefined});
   // The draft this binding owns right now (owner and rev), captured when a job starts; null if it owns none.
   binding.draftToken=()=>{const key=field.dataset.draftKey,meta=key?draftMeta(key):null;return meta&&meta.owner===binding.id?{owner:meta.owner,rev:meta.rev}:null;};
   // Delete the draft only if this binding owns it, it still holds the submitted text, and (with a token) nothing wrote it since.
   binding.finishOwn=(submitted,token)=>{
    const key=field.dataset.draftKey;if(!key)return false;
    const meta=draftMeta(key);
    if(!meta||meta.owner!==binding.id)return false;
    if(cas&&memoPendingNow(cas.itemID))return false; // never delete on the strength of an in-memory value that is still being written
    if(token&&(token.owner!==meta.owner||token.rev!==meta.rev))return false;
    if(draftText(key)!==String(submitted))return false;
    updateDraft(key,undefined);return true;
   };
   const clearStale=()=>{binding.stale=null;if(staleBox){staleBox.remove();staleBox=null;}if(field.dataset.state==='stale')field.dataset.state='';};
   // The editor takes a stored text as its own: value, base and autosave baseline together.
   binding.show=text=>{if(timer){win.clearTimeout(timer);timer=null;}field.value=text;grow();last=text;binding.unsaved=false;binding.loaded=text;if(moveBase(text))clearStale();};
   const take=text=>{const prior=field.value;if(field.dataset.draftKey)finishDraft(field,prior);binding.show(text);};
   // Puts a kept draft into THIS editor as ordinary unsaved input; true only when it is in a connected editor's value and draft.
   binding.loadKept=entry=>{
    if(!field.isConnected)return false;
    const mine=field.value,next=!mine.trim()||mine===binding.base?entry.text:mine+'\n\n'+entry.text;
    field.value=next;grow();field.dispatchEvent(new win.Event('input',{bubbles:true}));
    return field.isConnected&&field.value===next&&(!field.dataset.draftKey||draftText(field.dataset.draftKey)===next);
   };
   let keptExpanded=false;
   const drawKept=()=>{
    if(!cas||!cas.host||!cas.host.isConnected)return;
    if(keptBox){keptBox.remove();keptBox=null;}
    tidyKept(cas.itemID);
    const list=keptList(cas.itemID).slice().reverse();if(!list.length)return; // newest first
    keptBox=node('div',null,cas.host,{class:'sc-memo-kept'});
    for(const entry of keptExpanded?list:list.slice(0,KEPT_SHOWN)){
     const card=node('div',null,keptBox,{class:'sc-memo-kept-card',role:'group','aria-label':'저장하지 못한 입력'});
     node('span','저장하지 못한 입력',card,{class:'sc-memo-label'});
     node('p','이 메모가 그 사이 바뀌어 입력칸에 되돌리지 않았습니다. 필요하면 입력칸에 넣어 직접 합치세요.',card,{class:'sc-muted'});
     if(entry.truncated)node('p','이 입력은 너무 길어 앞부분만 저장되어 있습니다. 전체가 필요하면 현재 메모와 비교해 직접 확인하세요.',card,{class:'sc-muted'});
     node('pre',entry.text||'(비어 있음)',card);
     const acts=node('div',null,card,{class:'sc-actions'});
     /* Put into the editor as ordinary unsaved input: the base does not move, so saving it is judged like any other edit.
        When the job runs the panel may have been redrawn: it loads into the editor connected NOW, and the entry is deleted
        only once it is in that editor's value and draft. With no connected editor it stays kept. */
     button('입력칸에 넣기',()=>binding.sequence(async()=>{
      try{
      let target=binding;
      if(!field.isConnected){
       target=null;
       for(const editor of body.querySelectorAll('textarea[data-memo-item]'))if(editor.isConnected&&editor.dataset.memoItem===String(cas.itemID)&&memoBindings.get(editor)?.loadKept){target=memoBindings.get(editor);break;}
      }
      if(!target){message('입력칸이 닫혀 있어 넣지 못했습니다. 입력 내용은 그대로 남아 있습니다.',true);return;}
      const done=target===binding?binding.loadKept(entry):await target.sequence(async()=>target.loadKept(entry));
      if(done){dropKept(cas.itemID,entry.id);target.drawKept();drawKept();}
      }finally{reconcileAll(cas.itemID);}
     }),acts,{'data-writes':'cache'});
     button('버리기',async()=>{dropKept(cas.itemID,entry.id);drawKept();},acts,{'data-writes':'cache'});
    }
    if(list.length>KEPT_SHOWN)viewButton(keptExpanded?'접기':`${list.length-KEPT_SHOWN}개 더 보기`,()=>{keptExpanded=!keptExpanded;drawKept();},keptBox,{class:'sc-memo-kept-more'});
   };
   binding.drawKept=drawKept;
   const drawStale=()=>{
    if(!cas||!cas.host||!cas.host.isConnected)return;
    if(staleBox){staleBox.remove();staleBox=null;}
    const found=binding.stale;if(!found)return;
    const c=staleBox=node('div',null,cas.host,{class:'sc-memo-conflict sc-memo-stale',role:'group','aria-label':'저장된 메모가 바뀌었습니다'});
    node('strong','다른 곳에서 메모가 바뀌었습니다',c);
    node('p','이 편집기를 연 뒤 저장된 메모가 바뀌어 아무것도 덮어쓰지 않았습니다. 어느 쪽을 쓸지 고르세요.',c,{class:'sc-muted'});
    const two=node('div',null,c,{class:'sc-memo-conflict-texts'});
    for(const [name,text] of [['저장된 메모',found.stored],['이 편집 내용',found.conflict.local]]){
     const col=node('div',null,two,{class:'sc-memo-conflict-text'});node('span',name,col,{class:'sc-memo-label'});node('pre',text||'(비어 있음)',col);
    }
    const acts=node('div',null,c,{class:'sc-actions'});
    // The buttons act on the text the editor holds when they are pressed, after the saves queued before them; each box can be used once.
    button('저장된 메모 쓰기',()=>binding.sequence(async()=>{
     try{
     if(binding.stale!==found||found.used){message('그 사이 상황이 바뀌어 아무것도 바꾸지 않았습니다. 바뀐 내용을 확인하고 다시 고르세요.',true);return;}
     if(field.value!==found.conflict.local&&field.value!==found.stored){binding.stale={...found,conflict:{local:field.value,remote:found.stored}};drawStale();message('편집 내용이 그 사이 바뀌어 버리지 않았습니다. 바뀐 내용을 확인하고 다시 고르세요.',true);return;}
     if(found.rev!==undefined&&found.rev!==memoRevNow(cas.itemID)){const now=storedMemo(cas.itemID);binding.stale={...found,stored:now,conflict:{local:field.value,remote:now},rev:memoRevNow(cas.itemID)};drawStale();message('저장된 메모가 그 사이 또 바뀌었습니다. 바뀐 내용을 확인하고 다시 고르세요.',true);return;}
     found.used=true;take(found.stored);followMemoEditors(cas.itemID,found.stored,field,found.rev);
     }finally{if(found.rev!==undefined)reconcileAll(cas.itemID);}}),acts,{'data-writes':'cache'});
    button('이 편집 내용 쓰기',async()=>{await binding.overwrite(()=>field.value,found.stored,found);},acts,{'data-writes':'library'});
    button('둘 다 합치기',async()=>{await binding.overwrite(()=>{const own=field.value;return found.stored.trim()&&own.trim()?found.stored+'\n\n'+own:found.stored.trim()?found.stored:own;},found.stored,found);},acts,{'data-writes':'library',title:T('저장된 메모 아래에 이 편집 내용을 이어 붙입니다')});
   };
   // One attempt: true when the library took it.
   const attempt=async(value,base,closes)=>{
    const gens=cas?editorGens(cas.itemID):null,startGen=binding.gen,answer={};
    let saved,failure=null;
    try{saved=await save(value,base,answer);}catch(error){failure=error;}
    // An answer with a revision (or a failure) comes from the real library: every completion ends by reconciling the editors of that paper, in one common finally.
    const live=!!cas&&(failure!==null||answer.rev!==undefined||(!!saved&&typeof saved==='object'&&saved.rev!==undefined));
    try{
     if(failure){
      // The memo was saved locally and only the note failed: the write was taken, so the base moves; the error still goes to the caller.
      if(cas&&failure.memoSaved&&answerFresh(cas.itemID,answer.rev)&&storedMemo(cas.itemID)===value&&moveBase(value,true))clearStale();
      throw failure;
     }
     if(saved&&typeof saved==='object'&&saved.stale){binding.stale={...saved,used:false};field.dataset.state='stale';drawStale();return false;}
     // The write was taken, but a newer memo exists by now: this answer changes no editor value, base, draft or box. An untouched editor just shows what is stored.
     if(cas&&!answerFresh(cas.itemID,answer.rev)){
      if(field.isConnected&&field.value===value&&binding.gen===startGen)binding.show(storedMemo(cas.itemID));
      return true;
     }
     const stored=typeof saved==='string'?saved:value;
     // The choice that opened this save succeeded: its box is closed whatever text came back (a visible box never keeps a used token).
     if(closes&&binding.stale===closes)clearStale();
     if(cas&&stored===value&&moveBase(stored,true)){
      clearStale();
      // A draft typed during the save was recorded over the old base: it is built on this one now.
      const key=field.dataset.draftKey;
      if(key&&field.value!==stored)binding.ownDraftWrite(field.value,stored);
     }
     /* The note's newer text, adopted because the memo had not changed since the last sync, comes back as the stored text:
        an editor still showing what was submitted takes it (value and base together). Input typed while the save ran stays
        as typed and keeps the old base, so its next save is a conflict. */
     if(typeof saved==='string'&&saved!==value){
      if(field.dataset.memoItem)syncMemoEditors(field.dataset.memoItem,saved,value,{rev:answer.rev,gens});
      else if(field.value===value){field.value=saved;last=saved;grow();}
      // Typed since: the typing stays, and what it was typed over is no longer stored: a fresh box with a fresh token asks.
      if(cas&&field.isConnected&&field.value!==saved&&field.value!==value&&!binding.stale){binding.stale={stale:true,stored:saved,conflict:{local:field.value,remote:saved},used:false};field.dataset.state='stale';drawStale();}
     }
     if(cas)followMemoEditors(cas.itemID,stored,field,answer.rev,gens);
     return true;
    }finally{if(live)reconcileAll(cas.itemID);}
   };
   // A detached editor keeps its input without ever touching a draft another binding owns: its own draft is enough; otherwise a separate kept entry.
   binding.preserveDetached=()=>{
    // Decided by the editor's own state only: it holds input nobody saved (`unsaved`) that is not the stored memo (and the stored memo is not a write still in flight). Never by equality to a base or any older text.
    const value=field.value;if(!cas||!binding.unsaved)return;
    if(value===storedMemo(cas.itemID)&&!memoPendingNow(cas.itemID))return;
    const key=field.dataset.draftKey,meta=key?draftMeta(key):null;
    if(meta&&meta.owner===binding.id&&draftText(key)===value)return;
    keepDraft(cas.itemID,value,baseTag(binding.base),false,binding.id);
   };
   binding.timerPending=()=>!!timer;
   binding.cancelTimer=()=>{if(timer){win.clearTimeout(timer);timer=null;}};
   const run=async(options={})=>{
    const value=field.value;
    /* An editor that is no longer on screen saves nothing: its input is already a draft (or a kept card) that the editor on screen
       restores, and a save from it would be judged against a base the reader no longer sees. */
    if(!field.isConnected){binding.preserveDetached();return {ok:false,detached:true};}
    if(value===last&&!options.force)return {ok:true,unchanged:true};
    last=value;
    field.dataset.state='saving';
    try{
     const ok=await attempt(value,binding.effectiveBase());
     if(!ok)return {ok:false,stale:binding.stale};
     if(!field.isConnected)return {ok:true};
     field.dataset.state='saved';
     win.setTimeout(()=>{if(field.dataset.state==='saved')field.dataset.state='';},1400);
     return {ok:true};
    }catch(error){
     if(field.isConnected)field.dataset.state='failed';
     last=null;
     if(options.throws)throw error;
     message(`${label} 메모를 저장하지 못했습니다: ${error.message}`,true);
     return {ok:false,error};
    }
   };
   // Whatever changes this editor's text or settles a conflict runs after the saves already queued for it.
   binding.sequence=job=>{const next=chain.catch(()=>{}).then(async()=>{binding.busy++;try{return await job();}finally{binding.busy--;}});chain=next;return next;};
   const commit=(options={})=>binding.sequence(()=>run(options));
   binding.commit=commit;
   // A conflict choice first lets an input that differs from the memo the box showed be saved (or refused), then judges the conflict as it is by then.
   binding.choose=(job,shown)=>binding.sequence(async()=>{let saved=false;if(field.value!==shown){const out=await run({});saved=!out.unchanged;}return job(saved);});
   binding.overwrite=async(pick,seenStored,found)=>{
    const result=await binding.sequence(async()=>{
     if(found&&(binding.stale!==found||found.used))return null; // the box this came from is gone, replaced or already used
     found&&(found.used=true);
     const text=pick();
     const token=binding.draftToken();
     field.value=text;grow();last=text;binding.unsaved=true;field.dataset.state='saving';
     try{const ok=await attempt(text,seenStored,found);if(ok){field.dataset.state='saved';if(field.dataset.draftKey)finishDraft(field,text,false,token);}return ok;}
     catch(error){if(found)found.used=false;field.dataset.state='failed';last=null;throw error;}
     finally{if(cas)reconcileAll(cas.itemID);}
    });
    if(result===null){message('그 사이 상황이 바뀌어 아무것도 쓰지 않았습니다. 바뀐 내용을 확인하고 다시 고르세요.',true);return false;}
    if(!result)message('그 사이 메모가 또 바뀌어 아무것도 쓰지 않았습니다. 바뀐 내용을 확인하고 다시 고르세요.',true);
    return result;
   };
   if(!opts.manual){
    // Every path that runs, cancels or skips the autosave leaves `timer` null: a stale handle would read as "a save is waiting" for ever.
    field.addEventListener('input',()=>{
     field.dataset.state='';
     if(timer)win.clearTimeout(timer);
     timer=win.setTimeout(()=>{timer=null;commit();},900);
    });
    // Leaving the field commits at once: waiting out the timer after the panel
    // has closed would lose the edit.
    field.addEventListener('blur',()=>{if(timer){win.clearTimeout(timer);timer=null;}commit();});
    memoFields.push({field,flush:()=>{if(timer){win.clearTimeout(timer);timer=null;}return commit();}});
   }else{
    // A manual editor saves only by its button, but its input is still preserved when it goes (a redraw, or the window closing).
    memoFields.push({field,flush:()=>{binding.preserveDetached();}});
   }
   /* The shared draft is only ever changed through these three, and only with the owner and revision this window just read:
      ownDraftWrite (a draft this binding owns), claimDraft and dropDraft (restore, against the meta it read). */
   binding.ownDraftWrite=(text,base)=>{if(binding.draftToken())updateDraft(field.dataset.draftKey,text,base,binding.id);};
   const sameMeta=(a,b)=>(!a&&!b)||(a&&b&&a.owner===b.owner&&a.rev===b.rev);
   binding.claimDraft=(text,base,seen)=>{if(sameMeta(draftMeta(field.dataset.draftKey),seen))updateDraft(field.dataset.draftKey,text,base,binding.id);};
   binding.dropDraft=seen=>{if(cas&&memoPendingNow(cas.itemID))return;if(sameMeta(draftMeta(field.dataset.draftKey),seen))updateDraft(field.dataset.draftKey,undefined);};
   /* Restore reads the SHARED draft as it is now (never this window's older copy). Another live window's draft is not touched:
      a copy is offered as a kept card. One of this window or of a closed one goes back into the editor only when the memo it
      was typed over is still the stored one (compared by hash) and the editor holds nothing else, and it is not truncated;
      otherwise it is kept (never autosaved, never edited) and the editor shows the stored memo. */
   binding.restore=()=>{
    const key=field.dataset.draftKey;
    if(!cas||!key)return;
    const record=memoRecord(key),legacy=record?undefined:cachedDrafts().get(key),draft=record?record.text:legacy;
    if(typeof draft!=='string')return;
    const meta=draftMeta(key),draftBase=record?record.base:undefined,truncated=record?record.truncated===true:cachedDrafts().has(key+DRAFT_TRUNC);
    const stored=storedMemo(cas.itemID);
    const sameAsStored=draft===stored||(truncated&&stored.slice(0,DRAFT_LENGTH)===draft);
    // The stored memo the draft was typed over, as text, when it is on record and matches its hash.
    const baseText=record?record.baseText:undefined,baseOK=typeof baseText==='string'&&typeof draftBase==='string'&&baseTag(baseText)===draftBase;
    const claimBase=baseOK?baseText:(typeof draftBase==='string'?{tagged:draftBase}:undefined);
    const otherLive=!!meta&&ownerWindow(meta.owner)!==WINDOW_ID&&LIVE_DRAFT_WINDOWS.has(ownerWindow(meta.owner));
    if(otherLive){if(!sameAsStored&&draft!==field.value){keepDraft(cas.itemID,draft,draftBase,truncated,meta.owner);drawKept();}return;}
    // The value came from a draft: it is unsaved input until a save of exactly that value is confirmed (a leftover equal to the stored memo is just dropped, unless that memo is a write still in flight).
    if(draft===field.value&&!truncated){
     if(draft===stored&&!memoPendingNow(cas.itemID)){binding.dropDraft(meta);return;}
     // The editor shows what a write (still in flight) put in memory: its base is the memo that draft was typed over, so a rollback to it is an ordinary unsaved edit, not a conflict.
     if(baseOK&&baseText!==binding.base&&draft!==baseText){moveBase(baseText,true);binding.confirmIf=draft;}
     if(memoPendingNow(cas.itemID)&&!binding.known)captureKnown();
     binding.claimDraft(draft,claimBase,meta);binding.unsaved=true;return;
    }
    if(sameAsStored&&!memoPendingNow(cas.itemID)){binding.dropDraft(meta);return;}
    if(!truncated&&draftBase===baseTag(stored)&&field.value===binding.loaded){field.value=draft;grow();binding.unsaved=true;binding.claimDraft(draft,claimBase,meta);return;}
    keepDraft(cas.itemID,draft,draftBase,truncated,meta?meta.owner:undefined);binding.dropDraft(meta);drawKept();
   };
   memoBindings.set(field,binding);
   drawKept();
   return binding;
  }

  function drawPaperMemo(item){
   const box=node('div',null,body,{class:'sc-memo'});
   node('span','이 문헌 메모',box,{class:'sc-memo-label'});
   const field=node('textarea',null,box,{class:'sc-annot-memo sc-paper-memo',rows:'1',
    placeholder:'짧게 적어두세요. 노트 항목은 만들지 않습니다.','aria-label':'이 문헌의 메모'});
   field.dataset.memoItem=String(item.id);
   const ref=runtime.Z.Items.get(Number(item.id));
   field.value=(ref&&runtime.entry(ref).remark)||'';
   const loaded=field.value;
   autoGrow(field);
   /* Memo and note never merge by themselves: when both changed, nothing is written and both texts wait here for a choice. */
   const slot=node('div',null,box,{class:'sc-memo-conflict-slot'}),staleHost=node('div',null,box,{class:'sc-memo-stale-slot'});
   const showConflict=async()=>{
    let found=null;
    try{found=await library.memoConflict(item.id);}catch(_){}
    if(disposed||!slot.isConnected)return;
    slot.replaceChildren();
    if(!found)return;
    const c=node('div',null,slot,{class:'sc-memo-conflict',role:'group','aria-label':'메모와 노트가 서로 다릅니다'});
    node('strong','다른 곳에서 바뀐 노트가 있습니다',c);
    node('p','노트와 이 메모가 모두 바뀌어 자동으로 합치지 않았습니다. 아무것도 쓰지 않았고, 고르기 전까지 이 메모는 이 컴퓨터에만 저장됩니다.',c,{class:'sc-muted'});
    const two=node('div',null,c,{class:'sc-memo-conflict-texts'});
    for(const [label,text] of [['노트 내용',found.remote],['이 메모',found.local]]){
     const col=node('div',null,two,{class:'sc-memo-conflict-text'});node('span',label,col,{class:'sc-memo-label'});
     node('pre',text||'(비어 있음)',col);
    }
    /* A choice waits for the saves already queued for this editor and for the current input, then judges the conflict as it is.
       Only an editor still holding exactly the memo that was resolved takes the answer; a different input (typed, or a draft) stays. */
    const choose=choice=>()=>memoBinding.choose(async saved=>{
     const typedBefore=field.value,gens=editorGens(item.id);
     let result,live=false; // reconcile only for answers from the real library (they carry a revision), and always when it throws
     try{
     result=await library.resolveMemoConflict(item.id,choice,found);
     live=!!result&&result.rev!==undefined;
     if(result&&result.stale){message('그 사이 내용이 바뀌어 아무것도 쓰지 않았습니다. 바뀐 내용을 확인하고 다시 고르세요.',true);await showConflict();return;}
     if(result&&!result.conflict&&typeof result.text==='string')syncMemoEditors(item.id,result.text,typedBefore===found.local||(!saved&&typedBefore===memoBinding.base)?[typedBefore]:[],{rev:result.rev,gens});
     }catch(error){live=true;throw error;}finally{if(live)reconcileAll(item.id);}
     if(result&&!result.resolved&&!result.conflict){message('이미 정리된 충돌이라 최신 내용을 불러왔습니다.');await showConflict();return;}
     message(choice==='note'?'노트 내용을 메모로 가져왔습니다.':choice==='local'?'이 메모를 노트에 썼습니다.':'두 내용을 이어 붙여 메모와 노트에 썼습니다.');
     await showConflict();
    },found.local);
    const acts=node('div',null,c,{class:'sc-actions'});
    button('노트 내용 쓰기',choose('note'),acts,{'data-writes':'library'});
    button('이 메모 쓰기',choose('local'),acts,{'data-writes':'library'});
    button('둘 다 합치기',choose('both'),acts,{'data-writes':'library',title:T('노트 내용 아래에 구분선을 넣고 이 메모를 이어 붙입니다')});
   };
   // Saved here or under a row, the memo is the same one: the search sees it either way.
   const memoBinding=bindMemo(field,(value,base,answer)=>Promise.resolve(library.setRemark(item.id,value,{base,answer})).then(async result=>{if(result&&result.stale)return result;const held=state.items.find(i=>String(i.id)===String(item.id));if(held&&(field.value===value||field.value===result))held.remark=typeof result==='string'?result:String(value||'');await showConflict();return result;}),item.title||'문헌',{memo:{itemID:item.id,base:loaded,host:staleHost}});
   memoBinding.refresh=showConflict;
   memoBinding.restore();
   showConflict();
   /* The memo lives in this plugin's own file; this puts the same text into one
      child note (tagged style-custom:memo) so it is in Zotero too. The note is not opened. */
   button('노트로 옮기기',async()=>{
    const submitted=field.value,gens=editorGens(item.id);
    const out=await memoBinding.commit({force:true,throws:true});
    if(!out.ok){message('저장된 메모가 그 사이 바뀌어 아무것도 쓰지 않았습니다. 위에서 어느 쪽을 쓸지 고르세요.',true);return;}
    let result,live=false;
    try{
     result=await library.memoToNote(item.id);
     live=!!result&&result.rev!==undefined;
     if(result.adopted&&typeof result.text==='string')syncMemoEditors(item.id,result.text,submitted,{rev:result.rev,gens});
    }catch(error){live=true;throw error;}finally{if(live)reconcileAll(item.id);}
    await showConflict();
    message(result.conflict?'노트와 이 메모가 모두 바뀌어 아무것도 쓰지 않았습니다. 아래에서 어느 쪽을 쓸지 고르세요.':result.adopted?'노트가 더 최신이라 노트의 내용을 메모로 가져왔습니다. 노트는 바꾸지 않았습니다.':result.created?'메모를 노트로 옮겼습니다. 노트는 열지 않았습니다.':'메모 노트를 갱신했습니다. 노트는 열지 않았습니다.');
   },box,{class:'sc-memo-to-note',title:T('이 문헌의 하위 노트(태그 style-custom:memo) 하나에 메모를 씁니다. 이후 노트를 고치면 메모도 따라갑니다')});
  }

  /* The way to a paper when none is chosen: with an empty card the hint and the buttons go inside it, centred;
     the buttons are plain grey everywhere (the one dark pill is the page's main action, and this is not it). */
  const pickOne=(card=null)=>{
   const chosen=selected();
   if(chosen.length>1){
    if(card)node('span',`선택한 ${chosen.length}편 중 하나를 고르세요`,card,{class:'sc-empty-hint'});else node('p',`선택한 ${chosen.length}편 중 하나를 고르세요`,body,{class:'sc-muted'});
    const pickBar=card?emptyActions(card):bar();for(const it of chosen.slice(0,12))button(it.title,()=>{state.selected=new Set([String(it.id)]);render();},pickBar);
   }
   const acts=card?emptyActions(card):bar();button('현재 선택 가져오기',()=>{state.selected=new Set(runtime.selected(win).map(i=>String(i.id)));render();},acts);button('보유 문헌에서 고르기',()=>navigate('explore'),acts);};
  async function drawBacklinks(token){let item;try{item=one();}catch(_){pickOne(empty('역링크를 확인할 문헌 하나를 선택하세요.'));return;}
   // The scan reads every note in the library; the page says so while it runs instead of standing blank.
   const waiting=node('p','이 문헌을 가리키는 노트와 관련 문헌을 라이브러리 전체에서 찾는 중…',body,{class:'sc-muted'});
   const found=await library.backlinks(item.id);if(token!==epoch||disposed)return;waiting.remove();
   // A note that links twice, or is also a related item, is one row per kind.
   const seen=new Set(),links=found.filter(link=>{const key=link.kind+':'+link.id;if(seen.has(key))return false;seen.add(key);return true;});
   if(links.length)sectionHead('이 문헌을 가리키는 항목',links.length);
   for(const link of links){
    const where=link.kind==='note'?(link.parentTitle?T(`노트 · ${link.parentTitle}`):T('독립 노트')):T('관련 문헌');
    const c=card(link.title||T('제목 없음'),where);button('열기',()=>library.openItem(link.id),c,{'data-opens':'window'});}
   if(!links.length)empty('이 문헌을 가리키는 노트나 관련 문헌이 없습니다.');}
  // What the scan found across the whole library. The classifier can name 29
  // supplementary files, 17 duplicates and 6 papers filed under the wrong
  // item; until this existed, none of that was reachable. Fetching is kept
  // apart from drawing so drawAttachments can also use it to note, next to an
  // attachment already in the current list, what the scan concluded about it.
  async function findingsReport(token){
   if(typeof runtime.attachmentFindings!=='function')return null;
   let found=null;
   try{found=await runtime.attachmentFindings(win.ZoteroPane?.getSelectedLibraryID?.());}
   catch(error){runtime.Z.logError?.(error);return null;}
   if(token!==epoch||disposed)return null;
   // The clean-up list (preprint + published both held, papers held twice) rides with the scan.
   found.cleanup={merge:[],copies:[]};
   if(typeof runtime.cleanupFindings==='function'){
    try{found.cleanup=await runtime.cleanupFindings(win.ZoteroPane?.getSelectedLibraryID?.());}
    catch(error){runtime.Z.logError?.(error);}
    if(token!==epoch||disposed)return null;
   }
   const total=found.supplementary.length+found.duplicate.length+found.foreign.length+(found.orphan||[]).length+found.missing.length+(found.broken||[]).length+found.cleanup.merge.length+found.cleanup.copies.length;
   if(!total&&!found.unread)return null;
   return found;
  }
  /* A row on every visit to this tab used to make the point once and then
     cost a scroll forever after. It is a collapsed fold now, its summary
     the same counts read at a glance; each section inside caps at ten rows
     with its own 더 보기, since a library-wide scan can run to hundreds. */
  function drawFindingsBox(found,parent){
   const details=node('details',null,parent,{class:'sc-attachment-findings'});
   if(state.attachmentFindingsOpen)details.open=true;
   details.addEventListener('toggle',()=>{state.attachmentFindingsOpen=details.open;});
   // Only the findings that exist: a row of zeros says nothing.
   const facts=[['보충자료',found.supplementary.length],['중복',found.duplicate.length],['다른 논문',found.foreign.length],['보충자료만 있는 문헌',(found.orphan||[]).length],['첨부 없음',found.missing.length],['파일 연결 끊김',(found.broken||[]).length],['합칠 프리프린트',(found.cleanup?.merge||[]).length],['여러 번 보유',(found.cleanup?.copies||[]).length]].filter(([,count])=>count>0);
   node('summary',T('자료 점검')+' · '+(facts.length?facts.map(([label,count])=>`${T(label)} ${count}`).join(' · '):T('이상 없음')),details);
   if(found.unread){
    button(`아직 안 읽은 ${found.unread}개 판별`,()=>run(async()=>{
     const items=await runtime.libraryItems(win.ZoteroPane?.getSelectedLibraryID?.());
     const result=await runtime.scanAttachmentKinds(items,{onProgress:(d,t)=>message(`첨부파일 판별 중 ${d+1}/${t}`)});
     message(`본문 ${result.article} · 보충자료 ${result.supplementary} · 중복 ${result.duplicate} · 다른 논문 ${result.foreign}`);
     await render();
    }),details,{class:'sc-inline'});
   }
   const PAGE=10;
   const section=(key,title,rows,tone,act)=>{
    if(!rows.length)return;
    sectionHead(title,rows.length,details);
    const list=node('div',null,details,{class:'sc-hits'});
    const all=!!state.findingsMore?.[key];
    for(const row of rows.slice(0,all?rows.length:PAGE)){
     const c=node('div',null,list,{class:'sc-hit'+(tone?' sc-hit-'+tone:'')});
     node('p',row.title||'제목 없음',c,{class:'sc-hit-title'});
     node('p',[row.year,row.file,row.why].filter(Boolean).join(' · '),c,{class:'sc-hit-meta'});
     const actions=node('div',null,c,{class:'sc-hit-actions'});
     if(row.fileID)button('파일 열기',()=>library.openItem(row.fileID),actions,{'data-opens':'window'});
     button('문헌 보기',()=>library.openItem(row.id),actions,{'data-opens':'window'});
     if(act)act(row,actions);
    }
    if(rows.length>PAGE)viewButton(all?'접기':T(`${rows.length-PAGE}개 더 보기`),()=>{state.findingsMore={...(state.findingsMore||{}),[key]:!all};render();},details,{class:'sc-attachment-findings-more'});
   };
   section('supplementary','보충자료',found.supplementary,'');
   section('duplicate','같은 파일이 두 번',found.duplicate,'warn',(row,actions)=>{
    button('휴지통으로',()=>run(async()=>{
     const {moved}=await runtime.trashAttachments([row.fileID]);
     message(moved?'중복 첨부를 휴지통으로 보냈습니다. Zotero에서 되돌릴 수 있습니다.':'옮기지 못했습니다.');
     await render();
    }),actions);
   });
   section('foreign','다른 논문이 붙어 있음',found.foreign,'alert');
   // A supplement filed as its own bibliography entry. The paper it belongs to
   // is a suggestion the user confirms one at a time, never a bulk action: two
   // papers by one group on one molecule look alike enough that guessing is how
   // a supplement lands on the wrong paper in the first place.
   section('orphan','보충자료만 있는 문헌',found.orphan||[],'warn',(row,actions)=>{
    const home=row.home;
    if(home&&home.id){
     button('원논문에 붙이기',()=>run(async()=>{
      const result=await runtime.rehomeSupplement(row.fileID,home.id);
      message(result.moved?`보충자료를 원논문으로 옮겼습니다${result.trashed?' · 빈 항목은 휴지통으로':''}. Zotero에서 되돌릴 수 있습니다.`:'옮길 것이 없었습니다.');
      await render();
     }),actions);
     button('원논문 보기',()=>library.openItem(home.id),actions,{'data-opens':'window'});
     node('p',`원논문으로 보이는 문헌: ${home.title}`,actions.parentNode,{class:'sc-hit-meta'});
    } else if(home&&home.ambiguous){
     node('p',`후보가 둘입니다 — 직접 고르세요: ${home.ambiguous.map(a=>a.title).join('  |  ')}`,
      actions.parentNode,{class:'sc-hit-meta'});
     for(const candidate of home.ambiguous)
      button(`«${String(candidate.title).slice(0,18)}»에 붙이기`,()=>run(async()=>{
       const result=await runtime.rehomeSupplement(row.fileID,candidate.id);
       message(result.moved?'보충자료를 옮겼습니다. Zotero에서 되돌릴 수 있습니다.':'옮길 것이 없었습니다.');
       await render();
      }),actions);
    } else {
     node('p','원논문을 라이브러리에서 찾지 못했습니다.',actions.parentNode,{class:'sc-hit-meta'});
    }
   });
   /* Of the papers with no file, the unread ones first: the file is what
      stands between them and reading. Waiting ones say so. */
   const statusOf=id=>state.items.find(i=>String(i.id)===String(id))?.status;
   const unreadMissing=found.missing.filter(row=>{const st=statusOf(row.id);return st!=='done'&&st!=='reading';});
   /* Zotero's own "Find Available PDF" for the paper (its open-access and
      institutional resolvers); nothing opens, the outcome is said on the status line. */
   const findPDF=(row,actions)=>{
    if(typeof runtime.findPDF!=='function'||row.findable===false)return;
    button('PDF 찾기',()=>run(async()=>{
     message(`PDF를 찾는 중… ${String(row.title||'').slice(0,50)}`);
     const result=await runtime.findPDF(row.id);
     if(disposed)return;
     if(result.status==='found'){message(`PDF를 찾아 붙였습니다 — ${row.title||''}`);await render();}
     else if(result.status==='unsupported')message('이 Zotero에서는 PDF 찾기를 쓸 수 없습니다.',true);
     else message(`열려 있는 PDF를 찾지 못했습니다 — ${row.title||''}`,true);
    }),actions,{'data-opens':'download',title:T('Zotero가 오픈액세스·기관 구독 경로에서 PDF를 찾아 붙입니다')});
   };
   /* Every paper without a file, one after another, with a progress line and a
      stop button. Zotero's own Find Available PDF does the finding; nothing opens. */
   if(found.missing.some(row=>row.findable!==false)&&typeof runtime.findPDFs==='function'){
    const sweepBar=node('div',null,details,{class:'sc-hit-actions sc-pdf-sweep'});
    const ordered=[...unreadMissing,...found.missing.filter(row=>!unreadMissing.includes(row))].filter(row=>row.findable!==false).map(row=>row.id);
    /* The search is owned by the bench, not by this block of DOM: a saved PDF
       redraws the panel, and the new block picks the running job up again --
       stop visible, start off -- instead of offering a second run. */
    const stop=button('중지',()=>{sweepJob?.controller.abort();},sweepBar,{class:'sc-pdf-sweep-stop'});stop.hidden=!sweepJob;
    const sweepButton=button(`PDF 모두 찾기 · ${ordered.length}편`,async()=>{
     if(sweepJob)return;
     const controller=new AbortController(),job={controller};sweepJob=job;
     for(const current of panel.querySelectorAll('.sc-pdf-sweep-stop'))current.hidden=false;
     for(const current of panel.querySelectorAll('.sc-pdf-sweep-start'))current.disabled=true;
     try{
      const result=await runtime.findPDFs(ordered,{signal:controller.signal,onProgress:(done,total)=>{if(!disposed)message(`PDF 찾는 중 ${done+1}/${total}`);}});
      if(disposed)return;
      if(result.unsupported)message('이 Zotero에서는 PDF 찾기를 쓸 수 없습니다.',true);
      else message(`PDF ${result.found}편을 찾아 붙였습니다 · 못 찾음 ${result.none}편${result.failed?` · 오류 ${result.failed}편`:''}${result.cancelled?` · ${result.done}/${result.total}편에서 중지`:''}`);
      if(sweepJob===job)sweepJob=null;
      await render();
     }finally{
      if(sweepJob===job)sweepJob=null;
      if(!disposed)for(const current of panel.querySelectorAll('.sc-pdf-sweep-stop'))current.hidden=true;
      if(!disposed)for(const current of panel.querySelectorAll('.sc-pdf-sweep-start'))current.disabled=false;
     }
    },sweepBar,{class:'sc-pdf-sweep-start','data-opens':'download',title:T('Zotero가 오픈액세스·기관 구독 경로에서 PDF를 한 편씩 찾아 붙입니다. 중간에 멈출 수 있습니다')});
    if(sweepJob)sweepButton.disabled=true;
    void sweepButton;
   }
   // Papers held twice over: a preprint whose published version is also here, and the same DOI or title.
   const cleanup=found.cleanup||{merge:[],copies:[]};
   section('merge','프리프린트와 게재본을 둘 다 보유 · 합치기 제안',cleanup.merge.map(row=>({...row,why:`게재본: ${row.publishedTitle||row.publishedID}`})),'warn',(row,actions)=>{
    button('게재본으로 옮기기',()=>run(async()=>{
     const result=await runtime.mergePreprintIntoPublished(row.id,{publishedID:row.publishedID});
     const parts=[result.copied.tags?`태그 ${result.copied.tags}`:'',result.copied.status?'읽기 상태':'',result.copied.rating?'별점':'',result.copied.memo?'메모':'',result.copied.notes?`노트 ${result.copied.notes}`:'',result.copied.files?`첨부파일 ${result.copied.files}`:'',result.copied.collections?`컬렉션 ${result.copied.collections}`:'',result.copied.related?`관련 항목 ${result.copied.related}`:''].filter(Boolean);
     undoToast(`프리프린트를 게재본으로 합쳤습니다${parts.length?' · '+parts.join(' · '):''} · 프리프린트는 휴지통으로`,async()=>{await runtime.restorePreprint(row.id);message('프리프린트를 휴지통에서 되돌렸습니다.');await render();});
     await render();
    }),actions,{title:T('첨부파일(주석 포함)과 노트는 게재본으로 옮기고, 태그·읽기 상태·메모·컬렉션·관련 항목은 복사한 뒤 두 항목을 잇고 빈 프리프린트를 휴지통으로 보냅니다. 8초 안에 되돌리면 옮긴 것이 모두 제자리로 돌아갑니다')});
   });
   section('copies','같은 DOI·제목으로 여러 번 보유',cleanup.copies.map(group=>({id:group.items[0].id,title:group.items[0].title,year:group.items[0].year,
    why:`${group.items.length}건 · ${group.reason==='doi'?'같은 DOI':'같은 제목·연도'}`,ids:group.items.map(row=>row.id)})),'warn',(row,actions)=>{
    button('Zotero 중복 항목에서 보기',()=>run(async()=>{
     await runtime.showInDuplicatesPane(win,win.ZoteroPane?.getSelectedLibraryID?.(),row.ids);
     message('Zotero 중복 항목 화면을 열었습니다. 합치기는 거기서 고르세요.');
    }),actions,{'data-opens':'pane',title:T('Zotero 본창의 중복 항목 화면에서 이 문헌들을 보여 줍니다. 새 창은 열리지 않습니다')});
   });
   // The file is linked but not there (an old Dropbox path, a missing relative file). Downloading
   // would add a second copy; the fix is to point the link at the file again.
   section('broken','파일 연결 끊김 · 다시 연결해야 함',(found.broken||[]).map(row=>({...row,why:`저장된 경로: ${row.path||'(없음)'} · Zotero에서 첨부파일을 열어 「파일 찾기」로 다시 연결하세요 (PDF 찾기는 해결책이 아닙니다)`})),'warn');
   section('unreadMissing','안 읽었고 파일도 없는 문헌',unreadMissing,'',(row,actions)=>{findPDF(row,actions);if(isQueued(row.id))node('span',T('읽기 대기 중'),actions,{class:'sc-muted'});});
   section('readMissing','첨부파일 없음 · 읽는 중·완료',found.missing.filter(row=>!unreadMissing.includes(row)),'',findPDF);
  }

  async function drawAttachments(token){
   // The per-item list is what this tab is for; it draws first, from a
   // fetch scoped to these items. The library-wide scan (findingsReport)
   // used to be awaited before the first file appeared -- a slow scan of a
   // whole library held up a list that never depended on it. It is fetched
   // only after the list is on screen, guarded by the same token so a scan
   // that resolves after the reader has moved on drops silently.
   const list=await library.attachments(ids());if(token!==epoch||disposed)return;
   // The heading names the scope actually listed, after the search filter --
   // it used to count files the list below did not show.
   const every=list.filter(a=>model.matches(a.title+' '+a.contentType,state.query));
   if(list.length)sectionHead(state.scope==='selected'?'선택한 문헌의 첨부파일':'이 범위의 첨부파일',every.length);
   setNavBadge(every.length||null);
   const limit=state.attachmentLimit||100;
   const matching=every.slice(0,limit);
   const kindWord=type=>({'application/pdf':'PDF','application/epub+zip':'EPUB','application/epub':'EPUB','text/html':T('스냅샷')})[type]||(type?String(type).split('/')[0]:'');
   const cardOf=new Map();
   /* Grouped by parent paper, the file's name once identifies it -- one paper
      with an article and a supplement used to print the same title twice,
      told apart only by opening both. Order preserved: the parent a file's
      group first appears under decides where the whole group sits. */
   const groups=new Map();
   for(const a of matching){const key=String(a.parentID);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(a);}
   for(const [parentID,files] of groups){
    const parentItem=state.items.find(i=>String(i.id)===parentID);
    const parentRef=runtime.Z.Items.get(Number(parentID));
    const group=node('div',null,body,{class:'sc-attachment-group'});
    node('h3',parentItem?.title||T('제목 없음'),group,{class:'sc-attachment-group-title'});
    for(const a of files){
     const row=node('div',null,group,{class:'sc-attachment-row'});
     const text=node('div',null,row,{class:'sc-attachment-text'});
     // The type is a badge only when the title does not already say it ("Full text PDF" needs no second PDF).
     const kind=kindWord(a.contentType),title=String(a.title||'');
     const name=node('span',title||kind,text,{class:'sc-attachment-name'});
     if(title&&kind&&!title.toLowerCase().includes(String(kind).toLowerCase()))node('span',kind,name,{class:'sc-count sc-attachment-kind'});
     cardOf.set(String(a.id),text);
     // This file's own reading record -- the article and its supplement each keep their own place.
     const p=parentRef?runtime.pageProgress(parentRef,Number(a.id)):{total:0,visited:0,pages:{},lastPageIndex:null};
     const seconds=Object.values(p.pages||{}).reduce((n,v)=>n+(Number(v)||0),0);
     const hasPage=Number.isInteger(p.lastPageIndex);
     if(seconds>0||p.total){
      const lastRead=runtime.entry?.(parentRef)?.readingAttachments?.[String(a.id)]?.lastRead;
      const at=lastRead?(runtime.localStamp?runtime.localStamp(lastRead)?.getTime():Date.parse(lastRead)):NaN;
      const days=Number.isFinite(at)?Math.floor((Date.now()-at)/864e5):null;
      const whenLabel=days==null?'':days?T(`${days}일 전`):T('오늘');
      const parts=[seconds>0&&runtime.formatReadTime?runtime.formatReadTime(seconds,{compact:true}):'',p.total?`${p.visited}/${p.total}쪽`:'',whenLabel].filter(Boolean);
      node('span',parts.join(' · '),text,{class:'sc-attachment-reading'});
     } else {
      node('span',T('읽기 기록 없음'),text,{class:'sc-attachment-reading sc-muted'});
     }
     const actions=node('div',null,row,{class:'sc-attachment-actions'});
     button(hasPage?`${p.lastPageIndex+1}쪽부터 열기`:'열기',()=>library.openItem(a.id,hasPage?{pageIndex:p.lastPageIndex}:undefined),actions,{'data-opens':'window'});
     const supported=(['application/pdf','application/epub+zip','application/epub','text/html'].includes(a.contentType)||/^(image|audio|video)\//.test(a.contentType||''))&&a.path!==null;
     // Said on the file it is about, and pointing at the button on that same row, whatever it is called.
     if(!supported){node('span',T('미리보기를 지원하지 않는 형식입니다. 같은 줄의 버튼으로 파일을 여세요.'),text,{class:'sc-attachment-reading sc-muted sc-attachment-nopreview'});continue;}
     button('미리보기',async()=>{
      const generation=++previewEpoch,previous=preview;preview=null;
      const current=()=>!disposed&&!panel.hidden&&token===epoch&&generation===previewEpoch&&row.isConnected;
      await discardPreview(previous);if(!current())return;
      const p2=doc.createXULElement?.('attachment-preview');if(!p2)throw new Error('Zotero의 첨부 미리보기를 쓸 수 없습니다. 같은 줄의 버튼으로 파일을 여세요.');
      p2.classList.add('sc-native-preview');row.appendChild(p2);preview=p2;
      try{
       const item=await runtime.Z.Items.getAsync(Number(a.id));if(!current()){await discardPreview(p2);return;}
       p2.item=item;if(p2.isValidType===false)throw new Error('이 첨부는 미리보기를 지원하지 않습니다. 같은 줄의 버튼으로 파일을 여세요.');if(typeof p2.render!=='function')throw new Error('이 Zotero 버전은 첨부 미리보기를 지원하지 않습니다. 같은 줄의 버튼으로 파일을 여세요.');
       await p2.render();if(!current())await discardPreview(p2);
      }catch(error){await discardPreview(p2);if(current())throw error;}
     },actions);
    }
   }
   if(every.length>limit){const more=bar();node('span',`${every.length}개 중 ${limit}개`,more,{class:'sc-muted'});viewButton('100개 더 보기',()=>{state.attachmentLimit=limit+100;render();},more);}
   if(!matching.length)empty(state.query?'검색에 맞는 첨부가 없습니다. 검색어를 바꿔 보세요.':'첨부파일이 없습니다. PDF 또는 스냅샷을 첨부하세요.');
   // The list is already visible; the slower library-wide scan fills in
   // per-file notes and the folded findings box once it answers.
   const found=await findingsReport(token);if(token!==epoch||disposed)return;
   if(found){
    const NOTE_FOR={supplementary:'보충자료로 판별됨',duplicate:'중복 파일로 판별됨',foreign:'다른 논문의 파일로 판별됨',orphan:'보충자료로 판별됨 · 원논문 없음'};
    for(const kind of ['supplementary','duplicate','foreign','orphan'])for(const row of found[kind]||[]){
     if(row.fileID==null)continue;
     const c=cardOf.get(String(row.fileID));if(!c)continue;
     node('p',NOTE_FOR[kind],c,{class:'sc-attachment-note'});
    }
    drawFindingsBox(found,body);
   }
  }
  function refreshReading(){
   if(disposed||panel.hidden||state.tab!=='reading')return;
   // A48: this rebuilds the whole list; a memo mid-edit -- typing, unsaved --
   // must not be torn out from under the reader by some other row's async
   // load (a page-annotation fetch, say) finishing and calling this. The
   // save's own commit (blur, or the debounce) calls this again once it is
   // safe to.
   if(doc.activeElement?.closest?.('.sc-resume-memo-editor'))return;
   let drewStrip=false;
   const list=body.querySelector('[data-reading-progress]');if(!list)return;list.replaceChildren();
   const ranked=rows().map(item=>{const ref=runtime.Z.Items.get(Number(item.id));if(!ref)return null;const entry=runtime.entry(ref),p=runtime.pageProgress(ref);return {item,ref,entry,p,seconds:Number(entry.seconds)||0};}).filter(Boolean);
   const unread=ranked.filter(r=>!r.seconds&&!r.p.total).length;
   const read=ranked.filter(r=>r.seconds||r.p.total);
   setNavBadge(read.length||null);
   /* Most recently read first by default: the question on opening this page
      is "where was I". Longest-read is one choice away. Thirty to a page: every
      card carries up to a hundred page cells, and three hundred cards were
      thirty thousand buttons rebuilt on every refresh. */
   // Pages left after the last page read: total minus the page after
   // lastPageIndex, or minus the visited count when no last page is
   // recorded. No page total at all sorts to the very end, not to zero.
   const pagesLeftOf=r=>{const total=Number(r.p.total)||0;if(!total)return null;const li=r.p.lastPageIndex;
    // No recorded last position is nothing to sort on, not zero pages read --
    // falling back to the visited count used to float an untouched-since
    // paper up near the top on a guess. It goes last instead, with the other
    // papers pagesLeftOf already can't place.
    return Number.isInteger(li)?Math.max(0,total-(li+1)):null;};
   const bySort=state.readingSort==='time'
    ?(a,b)=>b.seconds-a.seconds
    :state.readingSort==='pages'
    ?(a,b)=>{const la=pagesLeftOf(a),lb=pagesLeftOf(b);if(la==null&&lb==null)return b.seconds-a.seconds;if(la==null)return 1;if(lb==null)return-1;return la-lb;}
    :(a,b)=>String(b.entry.lastRead||'').localeCompare(String(a.entry.lastRead||''))||b.seconds-a.seconds;
   const PER=30;let pages=1;
   /* 이어 읽기: what was being read in the last two weeks and is not finished,
      each with the page to go back to -- the page after the last one the
      reader spent time on -- one press away. The question on opening this
      page is "where was I"; the list below answers it only by scrolling. */
   const DAY=864e5,now=Date.now();
   /* Unfinished means not marked 완료, not a share of pages: a paper visited
      to 95% and not closed out is still being read. It reopens on the page
      last open, when that was recorded; otherwise at Zotero's own saved place. */
   /* A paper read in more than one file -- the article and its supplement --
      keeps a place in each: the file last read by default, the other one
      choice away, each with its own page, time and notes. Choosing a file
      only changes what is shown; it records nothing. */
   const asResume=r=>{
    const when=runtime.localStamp?runtime.localStamp(r.entry.lastRead)?.getTime():Date.parse(r.entry.lastRead||'');
    const files=Object.keys(r.entry.readingAttachments||{});
    const chosen=readingFiles.get(String(r.item.id));
    const p=chosen&&files.includes(chosen)?runtime.pageProgress(r.ref,Number(chosen)):r.p;
    const total=Number(p.total)||0;
    const next=Number.isInteger(p.lastPageIndex)&&p.lastPageIndex<total?p.lastPageIndex:null;
    // A status just set on this page counts before the runtime has re-read the tags.
    const status=r.item.status??runtime.state?.(r.ref)?.status;
    const fileSeconds=Object.values(p.pages||{}).reduce((n,v)=>n+(Number(v)||0),0);
    // The date shown is the chosen file's; the paper's own decides whether it is in 이어 읽기 at all.
    const fileRead=files.length>1?r.entry.readingAttachments?.[String(p.attachmentID)]?.lastRead:null;
    const fileWhen=fileRead?(runtime.localStamp?runtime.localStamp(fileRead)?.getTime():Date.parse(fileRead)):NaN;
    return {...r,p,files,fileSeconds,when,shownWhen:Number.isFinite(fileWhen)?fileWhen:when,total,next,status};
   };
   // Sorted after asResume(), not before: '마지막 위치 뒤 쪽 적은 순' has to read
   // the chosen file's progress (asResume swaps in readingFiles' pick), not
   // always the paper's default file, or picking a second file never moved a
   // row in this order.
   const shaped=read.map(asResume);
   shaped.sort(bySort);
   // 오늘 읽음 · 지난 7일, off the same `when` asResume already computed: not
   // a second date parse, and the same rows a click on either count narrows to.
   const dayStart=new Date();dayStart.setHours(0,0,0,0);
   const todayRows=shaped.filter(r=>Number.isFinite(r.when)&&r.when>=dayStart.getTime());
   const weekRows=shaped.filter(r=>Number.isFinite(r.when)&&r.when>=now-7*DAY);
   /* today/week narrow the whole picture, not just the general list below:
      the period is decided first, and 이어 읽기 is drawn from that same set,
      so a paper read outside the chosen period never turns up there and the
      button's own count is exactly what ends up on the screen. */
   const periodRows=state.readingView==='today'?todayRows:state.readingView==='week'?weekRows:null;
   const resumePool=periodRows||shaped;
   const resume=resumePool.filter(r=>r.status!=='done'&&(r.seconds>0||r.total)&&Number.isFinite(r.when)&&now-r.when<=14*DAY)
    .sort((a,b)=>b.when-a.when).slice(0,3);
   const resumed=new Set(resume.map(r=>String(r.item.id)));
   /* 14일 넘게 멈춤: still 읽는 중, last read more than two weeks ago -- the
      papers that fell out of 이어 읽기 and would otherwise sink in the list.
      Only a recorded date counts; a paper without one is not guessed stalled. */
   const stalled=shaped.filter(r=>r.status==='reading'&&Number.isFinite(r.when)&&now-r.when>14*DAY).sort((a,b)=>a.when-b.when);
   /* A47: which of the last 7 days' reading cites a stalled paper --
      paperWorks() references, already in hand from 관계 그래프's own fetch;
      no request here, no score, direction fixed (recent cites stalled). */
   const works=typeof runtime.paperWorks==='function'?runtime.paperWorks():{};
   const workOf=p=>works[p.libraryID+':'+p.key]||works[String(p.id)]||null;
   const refsOf=p=>{const w=workOf(p);return Array.isArray(w?.references)?w.references.map(bareWork):null;};
   const recentWithRefs=weekRows.filter(w=>refsOf(w.item));
   const anyRecentFetched=recentWithRefs.length>0;
   const reconnect=new Map(stalled.map(r=>{
    const oa=bareWork(workOf(r.item)?.openalex);
    const sources=oa?recentWithRefs.filter(w=>refsOf(w.item).includes(oa)).sort((a,b)=>b.when-a.when):[];
    return [String(r.item.id),sources];
   }));
   // Linked first (most sources first), then the plain oldest-first order.
   stalled.sort((a,b)=>{
    const la=reconnect.get(String(a.item.id)).length,lb=reconnect.get(String(b.item.id)).length;
    return (lb>0)-(la>0)||lb-la||a.when-b.when;
   });
   const readingNow=shaped.filter(r=>r.status==='reading'&&!resumed.has(String(r.item.id)));
   // A view that has emptied (the last one finished here) falls back to the whole record, and the switch stays.
   if((state.readingView==='stalled'&&!stalled.length)||(state.readingView==='reading'&&!readingNow.length)
    ||(state.readingView==='today'&&!todayRows.length)||(state.readingView==='week'&&!weekRows.length))state.readingView='';
   // The papers in 이어 읽기 are not listed a second time below it. Drawn
   // from `shaped`, not `read`, now: the general list uses the same row
   // renderer as 이어 읽기, which needs the richer shape (files, next page,
   // last-read time) that only asResume computed before. Under today/week
   // the pool is already the period's rows, so 이어 읽기 plus this list adds
   // up to exactly that period's count.
   const listedAll=resumePool.filter(r=>!resumed.has(String(r.item.id)));
   const listed=state.readingView==='stalled'?[]
    :state.readingView==='reading'?listedAll.filter(r=>r.status==='reading')
    :listedAll;
   pages=Math.max(1,Math.ceil(listed.length/PER));
   state.readingPage=Math.max(0,Math.min(state.readingPage||0,pages-1));
   // A45/#3: the annotations for one paper's pages, cached once per load()
   // and shared by both 쪽별 기록's marks and its own merged annotated-pages
   // list -- one request fills both. Keyed by paper *and* attachment: a
   // paper id alone kept serving the main PDF's marks after the file
   // chooser switched to its supplement. force refetches past a cached failure.
   const pageKey=(item,p)=>String(item.id)+':'+String(p?.attachmentID||'');
   const loadPageAnnotations=(item,p,{force=false}={})=>{
    const id=pageKey(item,p);
    if(!force&&pageAnnotations.has(id))return Promise.resolve(pageAnnotations.get(id));
    if(!force&&pageAnnotationLoads.has(id))return pageAnnotationLoads.get(id);
    const promise=(async()=>{
     if(!p.attachmentID||typeof library.annotations!=='function')return new Map();
     const all=await library.annotations([item.id]);
     const mine=all.filter(a=>String(a.attachmentID)===String(p.attachmentID)&&a.pageIndex!=null);
     const byPage=new Map();
     for(const a of mine){const list=byPage.get(a.pageIndex)||[];list.push(a);byPage.set(a.pageIndex,list);}
     pageAnnotations.set(id,byPage);
     return byPage;
    })();
    pageAnnotationLoads.set(id,promise);
    promise.catch(()=>{}).finally(()=>{if(pageAnnotationLoads.get(id)===promise)pageAnnotationLoads.delete(id);});
    return promise;
   };
   /* One paper's pages as a strip; the same in 이어 읽기, folded, and in the
      list below. byPage, once known, marks a page that carries an annotation
      with a small dot in that annotation's own colour; onPick answers a click
      by naming which page's evidence to show below the strip -- the strip no
      longer opens the PDF itself, since a glance at what is there comes first. */
   const pageStrip=(c,item,p,{byPage,onPick}={})=>{
    const rangeSize=100,total=Math.max(0,Number(p.total)||0);let start=pageRanges.get(item.id)||0;
    if(start>=total)start=0;pageRanges.set(item.id,start);
    if(total>rangeSize){const range=node('select',null,c,{'aria-label':item.title+' 페이지 범위'});
     for(let offset=0;offset<total;offset+=rangeSize)node('option',`${offset+1}–${Math.min(total,offset+rangeSize)}`,range,{value:offset});
     range.value=String(start);range.addEventListener('change',()=>{pageRanges.set(item.id,Number(range.value));refreshReading();const again=[...body.querySelectorAll('select')].find(x=>x.getAttribute('aria-label')===range.getAttribute('aria-label'));again?.focus?.();});
    }
    /* The pages as a strip of small squares, each shaded by the time spent
       on it -- the way a year of commits reads on GitHub -- instead of a row
       of numbered circles that took a line each and said nothing until read.
       The number and the seconds are in the tooltip; a click shows what is on
       that page below the strip. */
    const cells=node('div',null,c,{class:'sc-page-strip',role:'group','aria-label':`${item.title} 페이지별 읽은 시간`});
    const most=Math.max(1,...Object.values(p.pages||{}).map(Number).filter(Number.isFinite));
    for(let n=start;n<Math.min(total,start+rangeSize);n++){
     if((n-start)%20===0)node('span',String(n+1),cells,{class:'sc-page-row','aria-hidden':'true'});
     const sec=Number(p.pages[n])||0;
     const level=sec<5?0:sec>=most*0.75?4:sec>=most*0.4?3:sec>=most*0.15?2:1;
     /* A page glanced at for three seconds is not a page never opened; both
        drew as the same empty cell, so the strip read as less read than it was. */
     const seen=Object.prototype.hasOwnProperty.call(p.pages||{},n);
     const notes=byPage?.get(n);
     const cell=node('button','',cells,{class:'sc-page-cell',type:'button','data-level':String(level),'aria-label':`${n+1}페이지, ${seen?`${Math.round(sec)}초`:T('안 엶')}${notes?.length?', '+T(`주석 ${notes.length}개`):''}`,title:`${n+1}페이지 · ${seen?`${Math.round(sec)}초`:T('안 엶')}`});
     if(seen&&!level)cell.dataset.visited='1';
     if(notes?.length){
      const hex=notes.find(a=>/^#[0-9a-f]{6}$/i.test(a.color))?.color;
      const mark=node('span',null,cell,{class:'sc-page-annot-mark','aria-hidden':'true'});
      mark.style.background=hex||'var(--sc-muted)';
     }
     cell.dataset.chosen=String(pageChosen.get(pageKey(item,p))===n);
     cell.addEventListener('click',()=>{pageChosen.set(pageKey(item,p),n);onPick?.(n);});
    }
   };
   const fileChooser=(parent,item,files,p)=>{
    const label=T(`${item.title} 읽은 파일`);
    const pick=node('select',null,parent,{class:'sc-reading-file','aria-label':label});
    for(const id of files){const ref=runtime.Z.Items.get(Number(id));const name=(ref&&typeof ref.getField==='function'&&ref.getField('title'))||T(`파일 ${id}`);node('option',name,pick,{value:id});}
    pick.value=String(p.attachmentID||files[0]);
    pick.addEventListener('change',()=>{readingFiles.set(String(item.id),pick.value);refreshReading();[...body.querySelectorAll('.sc-reading-file')].find(x=>x.getAttribute('aria-label')===label)?.focus?.();});
   };
   /* 안 읽음 · 읽는 중 · 완료, set where the reading is recorded: back from
      the PDF, the paper is closed out here, and leaves 이어 읽기 for the list
      below, where it can be changed again. Page records and time stay as
      they are; visiting every page never marks a paper done by itself. */
   const readingStatus=(parent,item,ref)=>{
    if(!ref||typeof runtime.edit!=='function'||runtime.canEdit?.(ref)===false)return;
    const group=node('span',null,parent,{class:'sc-segmented sc-reading-status',role:'group','aria-label':T(`${item.title} 읽기 상태`)});
    const now=item.status==='done'?'done':item.status==='reading'?'reading':'unread';
    for(const [key,label] of [['unread','안 읽음'],['reading','읽는 중'],['done','완료']])
     button(label,()=>run(async()=>{
      if(key===now)return;
      await runtime.edit([ref],{status:key});
      if(disposed)return;
      item.status=key;
      message(T(`“${String(item.title||'').slice(0,40)}” · ${T(label)}`));
      refreshReading();
     }),group,{'aria-pressed':String(key===now)});
   };
   /* #3: 주석이 있는 쪽 used to be its own fold beside 쪽별 기록, with its own
      fetch -- two folds, and (past a supplement switch) two different ideas
      of which attachment's marks they held. It is drawn into 쪽별 기록's own
      body now, from the exact same pageAnnotations entry that fold's strip
      already loaded: one fold per row, one fetch either way. Three pages to
      start; the rest a press away. */
   const annotatedPagesList=(box,byPage,p)=>{
    box.replaceChildren();
    if(!byPage){node('p',T('주석을 읽는 중…'),box,{class:'sc-muted'});return;}
    if(!byPage.size){node('p',T('이 PDF에는 쪽이 기록된 주석이 없습니다.'),box,{class:'sc-muted'});return;}
    const pagesWith=[...byPage].sort((a,b)=>a[0]-b[0]);
    const drawPage=([index,notes])=>{
     const row=node('div',null,box,{class:'sc-reading-evidence-row'});
     const sec=Number(p.pages?.[index])||0;
     const said=[T(`${notes[0].pageLabel||index+1}쪽`),sec>0&&runtime.formatReadTime?runtime.formatReadTime(sec,{compact:true}):'',T(`주석 ${notes.length}개`)].filter(Boolean).join(' · ');
     button(said,()=>run(()=>library.openItem(p.attachmentID,{pageIndex:index})),row,{class:'sc-reading-evidence-page','data-opens':'window',title:T('이 쪽을 엽니다')});
     const first=notes.find(a=>a.comment)||notes[0];
     const words=String(first.comment||first.text||'').replace(/\s+/g,' ').trim();
     if(words){const line=node('span',null,row,{class:'sc-reading-evidence-text'});
      // The annotation's own colour is what it means to the reader, so it stays.
      if(first.color){const swatch=node('span',null,line,{class:'sc-reading-evidence-swatch','aria-hidden':'true'});swatch.style.background=first.color;}
      line.appendChild(doc.createTextNode(words.slice(0,140)));}
    };
    pagesWith.slice(0,3).forEach(drawPage);
    if(pagesWith.length>3){const rest=viewButton(T(`${pagesWith.length-3}쪽 더 보기`),()=>{rest.remove();pagesWith.slice(3).forEach(drawPage);},box,{class:'sc-reading-evidence-more'});}
   };
   /* 지난번 마지막 주석: the most recently modified mark (or, without a date
      anywhere, the highest page) among a paper's own marks -- read directly
      off whatever 쪽별 기록's shared load already holds, so the line can
      appear the moment that completes rather than needing its own fold opened. */
   const lastAnnotationLine=mine=>{
    if(!mine.length)return null;
    const dated=mine.filter(a=>a.dateModified||a.modified);
    const pageOf=a=>a.pageLabel||(a.pageIndex!=null?a.pageIndex+1:null);
    let best;
    if(dated.length){
     best=dated.slice().sort((a,b)=>String(b.dateModified||b.modified||'').localeCompare(String(a.dateModified||a.modified||'')))[0];
     const page=pageOf(best);if(page==null)return null;
     const words=String(best.comment||best.text||'').replace(/\s+/g,' ').trim().slice(0,80);
     return words?T(`지난번 마지막 주석: p.${page} · ${words}`):T(`지난번 마지막 주석: p.${page}`);
    }
    best=mine.slice().sort((a,b)=>(b.pageIndex??-1)-(a.pageIndex??-1))[0];
    const page=pageOf(best);if(page==null)return null;
    const words=String(best.comment||best.text||'').replace(/\s+/g,' ').trim().slice(0,80);
    return words?T(`마지막 쪽 주석: p.${page} · ${words}`):T(`마지막 쪽 주석: p.${page}`);
   };
   // 읽기 대기: papers put by for reading, oldest first, until reading starts.
   const queue=Object.entries(readingQueue()).filter(([key])=>key.startsWith(`${state.libraryID||''}:`));
   const queued=[],inView=new Set(rows().map(i=>String(i.id)));
   const byKey=new Map(state.items.map(i=>[String(i.key),i]));
   for(const [key,entry] of queue.sort((a,b)=>String(a[1].at).localeCompare(String(b[1].at)))){
    // The queue answers the same search and filters as the rest of the page.
    const item=byKey.get(key.slice(`${state.libraryID||''}:`.length));if(!item||!inView.has(String(item.id)))continue;
    const ref=runtime.Z.Items.get(Number(item.id));const started=ref?Date.parse(runtime.entry(ref).lastRead||''):NaN;
    // Read since it was put by: it has moved on to 이어 읽기 or the list, and is not shown twice.
    if(Number.isFinite(started)&&started>Date.parse(entry.at||''))continue;
    if(item.status==='done')continue;
    queued.push({item,entry,key});
   }
   /* Today and this week, in papers: how many were opened today and in the
      last seven days. The record keeps a paper's total time and when it was
      last read, not time per day, so it counts papers and says no more.
      Each count is also a button onto just those papers -- pressing the same
      one again goes back to the whole record, the one mechanism the other
      view switch already uses. */
   if(weekRows.length){const line=node('p',null,list,{class:'sc-overview-facts sc-reading-today'});
    for(const [key,label,value] of [['today','오늘 읽음',todayRows.length],['week','지난 7일',weekRows.length]]){
     const on=state.readingView===key;
     const btn=button('',()=>{state.readingView=on?'':key;state.readingPage=0;refreshReading();},line,{class:'sc-overview-fact','aria-pressed':String(on)});
     node('b',T(`${value}편`),btn);btn.appendChild(doc.createTextNode(' '+T(label)));
     if(!value)btn.disabled=true;
    }
    // The tab's count in the sidebar is the papers with a reading record: it is also shown here, so the badge matches a number on the page.
    const total=node('span',null,line,{class:'sc-overview-fact',title:T('읽은 시간이나 쪽 기록이 있는 문헌 전체 (사이드바의 숫자)')});
    node('b',T(`${read.length}편`),total);total.appendChild(doc.createTextNode(' '+T('읽기 기록')));
   }
   /* One row, shared by 이어 읽기 and the general record list below it: a
      title and memo on the first line, 열기/이어 읽기 and the status control
      at the end of the second -- the general list used to build its own
      plain card instead, with a redundant progress bar and its page strip
      always open. opts.recordMeta switches only the meta line's order (읽은
      시간 · 방문 쪽/전체 쪽 · 마지막 읽음, what the general list is for)
      and the button's word for an already-완료 paper. */
   const drawResumeRow=(box,r,opts={})=>{
     const row=node('div',null,box,{class:'sc-resume-row'+(opts.recordMeta?' sc-reading-record':'')});
     const text=node('div',null,row,{class:'sc-resume-text'});
     node('span',r.item.title,text,{class:'sc-resume-title',title:r.item.title});
     if(r.files.length>1)fileChooser(text,r.item,r.files,r.p);
     /* A48: the memo line the reader meant to check is editable in place --
        press it (or, with nothing written yet, 메모 쓰기) and it becomes a
        textarea, saved the same way drawPaperMemo's own memo is (bindMemo +
        library.setRemark, updating state.items' cached remark too). A
        successful save returns to the one-line view; a failed one leaves
        the editor and the draft exactly as they were. */
     const remarkBox=node('div',null,text,{class:'sc-resume-remark-box'});
     const renderRemarkView=()=>{
      remarkBox.replaceChildren();
      const current=String(r.entry.remark||'').trim();
      if(current)button(current.split('\n')[0].slice(0,140),renderRemarkEdit,remarkBox,{class:'sc-resume-remark',title:T('눌러서 편집합니다')});
      else button(T('메모 쓰기'),renderRemarkEdit,remarkBox,{class:'sc-resume-remark-add'});
     };
     const renderRemarkEdit=()=>{
      remarkBox.replaceChildren();
      const editor=node('div',null,remarkBox,{class:'sc-resume-memo-editor'});
      const field=node('textarea',null,editor,{rows:'2','aria-label':T(`${r.item.title} 메모`),placeholder:T('짧게 적어두세요. 노트 항목은 만들지 않습니다.')});
      const loaded=String(r.entry.remark||'');field.value=loaded;field.dataset.memoItem=String(r.item.id);
      // One draft per paper for this editor, whichever tab or redraw created it (the automatic key depends on where it was drawn).
      field.dataset.draftKey=JSON.stringify(['remark-row',state.libraryID,r.item.id]);
      field.focus();
      let typing=true;for(const [type,on] of [['focus',true],['input',true],['blur',false]])field.addEventListener(type,()=>{typing=on;});
      const rowBinding=bindMemo(field,(value,base,answer)=>Promise.resolve(library.setRemark(r.item.id,value,{base,answer})).then(result=>{
       if(result&&result.stale)return result;
       const stored=typeof result==='string'?result:String(value||'');
       // A later keystroke's save must not be overwritten by this earlier answer.
       const newest=field.value===value||field.value===stored;
       const held=state.items.find(i=>String(i.id)===String(r.item.id));if(held&&newest)held.remark=stored;
       // An autosave that lands while the reader keeps typing must not collapse the editor under them.
       if(!field.isConnected||typing||field.value!==value)return result;
       renderRemarkView();
       return result;
      }),r.item.title||'문헌',{memo:{itemID:r.item.id,base:loaded,host:editor}});
      rowBinding.restore(); // a draft left by an earlier editor of this paper comes back (or waits as a kept card), never silently dropped
     };
     renderRemarkView();
     // No recorded date is a different fact from "read today" (days===0), and
     // reads as nothing otherwise -- an empty space where a date belongs.
     const hasDate=Number.isFinite(r.shownWhen);
     const days=hasDate?Math.floor((now-r.shownWhen)/DAY):null;
     // With files to choose between, the time is this file's, and says so; the paper's total is the list's.
     const seconds=r.files.length>1?r.fileSeconds:r.seconds;
     const timeText=seconds>0&&runtime.formatReadTime?runtime.formatReadTime(seconds,{compact:true}):'';
     let parts;
     if(opts.recordMeta){
      const timeLabel=timeText?T(r.files.length>1?`이 파일 읽은 시간 ${timeText}`:`읽은 시간 ${timeText}`):T('읽은 시간 기록 없음');
      const lastLabel=!hasDate?T('마지막 읽음 기록 없음'):days?T(`마지막 읽음 ${days}일 전`):T('마지막 읽음 오늘');
      parts=[timeLabel,r.total?`${r.p.visited}/${r.total}쪽`:'',lastLabel].filter(Boolean);
     } else {
      // What is left after the page to come back to, so a paper two pages from its end reads as one.
      const left=r.next!=null&&r.total?r.total-(r.next+1):null;
      const lastPart=!hasDate?T('마지막 읽음 기록 없음'):days?`${days}일 전`:T('오늘');
      parts=[r.total?`${r.p.visited}/${r.total}쪽`:'',left?T(`이 쪽 뒤 ${left}쪽`):'',r.files.length>1&&timeText?T(`이 파일 ${timeText}`):timeText,lastPart].filter(Boolean);
     }
     const target=r.p.attachmentID||r.item.id;
     const resumeLabel=opts.recordMeta&&r.status==='done'?'열기':r.next!=null?`${r.next+1}쪽에서`:'이어 읽기';
     node('span',parts.join(' · '),row,{class:'sc-resume-meta'});
     /* A47: 14일 넘게 멈춤 only -- opts.reconnect is who among the last 7
        days' reading cites this stalled paper (paperWorks() references,
        already in hand; no request, no score). opts.refsUnknown separates
        "checked, nothing linked" from "nothing to check yet". */
     if(opts.reconnect){
      if(opts.reconnect.length){
       const fold=node('details',null,row,{class:'sc-reading-reconnect'});
       node('summary',T(`최근 읽은 ${opts.reconnect.length}편이 인용`),fold);
       for(const src of opts.reconnect){
        const line=node('div',null,fold,{class:'sc-reading-reconnect-row'});
        node('span',T(`최근 읽은 ${src.item.title||T('제목 없음')} → 이 문헌`),line);
        const srcDays=Number.isFinite(src.when)?Math.floor((now-src.when)/DAY):null;
        node('span',srcDays!=null?T(`마지막 읽음 ${srcDays}일 전`):T('마지막 읽음 기록 없음'),line,{class:'sc-muted'});
       }
       // The row's own resume action, repeated here so reconnecting does not need a scroll back up.
       button(resumeLabel,()=>run(()=>library.openItem(target,r.next!=null?{pageIndex:r.next}:undefined)),fold,{'data-opens':'window'});
      } else node('span',T(opts.refsUnknown?'참고문헌 기록 없음':'연결 없음'),row,{class:'sc-muted sc-reading-reconnect-note'});
     }
     // 열기/이어 읽기 and the status control share the meta's line, at the row's end.
     const actions=node('div',null,row,{class:'sc-resume-actions'});
     button(resumeLabel,()=>run(()=>library.openItem(target,r.next!=null?{pageIndex:r.next}:undefined)),actions,{'data-opens':'window',title:T(r.next!=null?'마지막으로 보던 쪽에서 엽니다':'Zotero가 기억하는 위치에서 엽니다')});
     // The page-by-page record is not listed below for these, so it folds in here.
     readingStatus(actions,r.item,r.ref);
     // The file chooser belongs with the button that opens that file, so the two travel as one.
     {const chooser=text.querySelector('.sc-reading-file');if(chooser)actions.insertBefore(chooser,actions.firstChild);}
     const folds=node('div',null,row,{class:'sc-resume-folds'});
     if(r.total){
      const rowID=String(r.item.id);
      // #3: pages, marks, the 지난번 마지막 주석 line and the merged
      // annotated-pages list all key off paper *and* attachment -- switching
      // the file chooser changes r.p.attachmentID, and so this key, rather
      // than reusing a cache built for the file just left.
      const pid=pageKey(r.item,r.p);
      const more=node('details',null,folds,{class:'sc-resume-pages'});
      if(openStrips.has(rowID))more.open=true;
      /* 방문 쪽/전체 쪽 is known the moment the row is drawn; the annotation
         count, and 지난번 마지막 주석 by the title, join it only once this
         fold's own shared load has actually completed -- never fetched just
         for either. */
      const summary=node('summary',null,more);
      const known=pageAnnotations.get(pid);
      const mine=known?[...known.values()].flat():[];
      summary.textContent=T(`쪽별 기록 · 방문 ${r.p.visited}/${r.total}`)+(known?' · '+T(`주석 ${mine.length}`):'');
      if(mine.length&&!text.querySelector('.sc-resume-last-annotation')){
       const line=lastAnnotationLine(mine);
       if(line)node('span',line,text,{class:'sc-resume-last-annotation'});
      }
      // The strip itself, and the key that explains it, are built only once
      // opened: a closed fold that still built thirty thousand cells behind
      // it was most of a big list's render cost for nothing shown.
      const stripBox=node('div',null,more,{class:'sc-resume-pages-body'});
      let built=false;
      const build=()=>{
       if(built)return;built=true;
       const legend=node('div',null,stripBox,{class:'sc-page-legend','aria-hidden':'true'});
       node('span',T('쪽당 읽은 시간 적게'),legend);
       for(const level of [0,1,2,3,4])node('span','',legend,{class:'sc-page-cell sc-page-key','data-level':String(level)});
       node('span',T('많이'),legend);
       const evidenceBox=node('div',null,stripBox,{class:'sc-page-evidence'});
       // Choosing a page shows what is on it right below the strip -- the
       // time spent there and any annotation's excerpt -- with its own way
       // to open that page, instead of the strip itself opening on a click.
       const showEvidence=n=>{
        evidenceBox.replaceChildren();
        const notes=pageAnnotations.get(pid)?.get(n)||[];
        const sec=Number(r.p.pages?.[n])||0;
        const line=node('div',null,evidenceBox,{class:'sc-reading-evidence-row'});
        const said=[T(`${notes[0]?.pageLabel||n+1}쪽`),sec>0&&runtime.formatReadTime?runtime.formatReadTime(sec,{compact:true}):'',notes.length?T(`주석 ${notes.length}개`):''].filter(Boolean).join(' · ');
        button(said,()=>run(()=>{if(!r.p.attachmentID)throw new Error('어느 파일의 몇 쪽인지 기록이 없습니다. 그 PDF를 한 번 열어 읽은 뒤 다시 보세요.');return library.openItem(r.p.attachmentID,{pageIndex:n});}),line,{class:'sc-reading-evidence-page','data-opens':'window',title:T('이 쪽을 엽니다')});
        for(const a of notes){
         const words=String(a.comment||a.text||'').replace(/\s+/g,' ').trim();if(!words)continue;
         const excerpt=node('span',null,line,{class:'sc-reading-evidence-text'});
         if(a.color){const swatch=node('span',null,excerpt,{class:'sc-reading-evidence-swatch','aria-hidden':'true'});swatch.style.background=a.color;}
         excerpt.appendChild(doc.createTextNode(words.slice(0,140)));
        }
       };
       pageStrip(stripBox,r.item,r.p,{byPage:pageAnnotations.get(pid),onPick:n=>{pageChosen.set(pid,n);showEvidence(n);}});
       if(pageChosen.has(pid))showEvidence(pageChosen.get(pid));
       // #3: 주석이 있는 쪽's own list, merged into this same fold rather than
       // a second one below it -- one press opens both the strip and this.
       const listBox=node('div',null,stripBox,{class:'sc-reading-evidence-list'});
       annotatedPagesList(listBox,pageAnnotations.get(pid),r.p);
      };
      more.addEventListener('toggle',()=>{
       more.open?openStrips.add(rowID):openStrips.delete(rowID);
       if(!more.open)return;
       build();
       // Switching the file chooser calls refreshReading() itself (see
       // fileChooser above), which redraws this whole row against the newly
       // chosen file's r.p -- the strip, the marks and the evidence below it
       // all follow without any of this needing to know a file was switched.
       if(!pageAnnotations.has(pid))loadPageAnnotations(r.item,r.p).catch(()=>{}).then(()=>{if(!disposed&&more.isConnected)refreshReading();});
      });
      if(more.open)build();
     }
   };
   if(resume.length){
    sectionHead('이어 읽기',resume.length,list);
    const box=node('div',null,list,{class:'sc-resume'});
    for(const r of resume)drawResumeRow(box,r);
   }
   if(queued.length){
    sectionHead('읽기 대기',queued.length,list);
    const box=node('div',null,list,{class:'sc-reading-queue'});
    /* Oldest first, ten at a time; each says where it came from and why --
       the read papers that cite it, or that it cites, as they were when it
       was put by -- and the reader's own memo, if any. */
    for(const {item,entry,key} of queued.slice(0,state.queueAll?queued.length:10)){
     const row=node('div',null,box,{class:'sc-reading-queue-row'});
     const text=node('div',null,row,{class:'sc-resume-text'});
     node('span',item.title||T('제목 없음'),text,{class:'sc-resume-title',title:item.title||''});
     const waited=Math.max(0,Math.floor((Date.now()-Date.parse(entry.at||''))/DAY));
     node('span',[item.venue,(entry.people||[]).join(', '),Number.isFinite(waited)?T(`대기 ${waited}일`):''].filter(Boolean).join(' · '),text,{class:'sc-resume-remark'});
     if(entry.reason?.text)node('span',entry.reason.text,text,{class:'sc-resume-remark sc-queue-why',title:entry.reason.text});
     const sources=(entry.reason?.paperIDs||[]).map(id=>state.items.find(i=>String(i.id)===String(id))).filter(Boolean);
     if(sources.length){
      const why=node('details',null,text,{class:'sc-queue-reason'});
      node('summary',entry.reason.direction==='citing'?T(`담은 이유: 읽던 ${sources.length}편을 인용`):T(`담은 이유: 읽던 ${sources.length}편이 인용`),why);
      node('p',T('인용 관계는 담을 때의 기록이고, 상태와 시간은 지금 값입니다.'),why,{class:'sc-muted'});
      for(const src of sources)node('p',[src.title,T('지금')+' '+(src.status==='done'?T('완료'):src.status==='reading'?T('읽는 중'):T('안 읽음')),Number(src.seconds)>0&&runtime.formatReadTime?runtime.formatReadTime(src.seconds,{compact:true}):''].filter(Boolean).join(' · '),why,{class:'sc-queue-reason-paper'});
     }
     const memo=String(item.remark||'').trim();
     if(memo)node('span',memo.split('\n')[0].slice(0,140),text,{class:'sc-resume-remark'});
     button('열기',()=>run(()=>library.openItem(item.id)),row,{'data-opens':'window'});
     button('대기 해제',()=>run(async()=>{
      const before={...readingQueue()},had=before[key];
      const next={...before};delete next[key];await saveUI({readingQueue:next});refreshReading();
      undoToast(`“${item.title||T('제목 없음')}”을 읽기 대기에서 뺐습니다.`,async()=>{await saveUI({readingQueue:{...readingQueue(),[key]:had}});refreshReading();});
     }),row);
    }
    if(queued.length>10)viewButton(state.queueAll?'10편만 보기':T(`${queued.length}편 모두 보기`),()=>{state.queueAll=!state.queueAll;refreshReading();},list,{class:'sc-local-reading-more'});
   }
   /* 읽기 기록 is one group: its head, the switch between views (kept while there is any record, with its
      counts, so a view that empties is never a dead end), the sort and paging, and the rows. These used to
      sit inside 이어 읽기, under the rows of a different list. */
   if(read.length){
    sectionHead('읽기 기록',state.readingView==='stalled'?stalled.length:listed.length,list);
    const views=node('div',null,list,{class:'sc-segmented sc-reading-views',role:'group','aria-label':T('읽기 기록 보기')});
    for(const [key,label,count] of [['','전체 기록',listedAll.length],['reading','읽는 중',readingNow.length],['stalled','14일 넘게 멈춤',stalled.length]]){
     const b_=button('',()=>{state.readingView=key;state.readingPage=0;refreshReading();},views,{'aria-pressed':String((state.readingView||'')===key)});withCount(b_,label,count);
     if(key&&!count)b_.disabled=true;
    }
   }
   if(state.readingView==='stalled'){
    const box=node('div',null,list,{class:'sc-resume sc-reading-stalled'});
    for(const r of stalled.slice(0,state.stalledAll?stalled.length:10))drawResumeRow(box,r,{reconnect:reconnect.get(String(r.item.id)),refsUnknown:!anyRecentFetched});
    if(stalled.length>10)viewButton(state.stalledAll?'10편만 보기':T(`${stalled.length}편 모두 보기`),()=>{state.stalledAll=!state.stalledAll;refreshReading();},list,{class:'sc-local-reading-more'});
   }
   if(read.length&&state.readingView!=='stalled'){
    const tools=node('div',null,list,{class:'sc-actions sc-reading-tools'});
    const order=node('select',null,tools,{'aria-label':'읽기 기록 정렬'});
    for(const[v,l]of [['recent','최근 읽은 순'],['time','읽은 시간 긴 순'],['pages','마지막 위치 뒤 쪽 적은 순']])node('option',l,order,{value:v});
    order.value=state.readingSort==='time'?'time':state.readingSort==='pages'?'pages':'recent';
    order.addEventListener('change',()=>{state.readingSort=order.value;state.readingPage=0;refreshReading();body.querySelector('[aria-label="읽기 기록 정렬"]')?.focus?.();});
    if(pages>1){
     const from=state.readingPage*PER;
     button('이전',()=>{state.readingPage--;refreshReading();},tools).disabled=!state.readingPage;
     node('span',`${from+1}–${Math.min(listed.length,from+PER)} / ${listed.length}편`,tools,{class:'sc-muted'});
     button('다음',()=>{state.readingPage++;refreshReading();},tools).disabled=state.readingPage>=pages-1;
    }
    if(unread)node('span',`아직 읽지 않은 ${unread}편은 뺐습니다.`,tools,{class:'sc-muted'});
   }
   if(listed.length){
    // The same row as 이어 읽기, not a separate card: one first line for
    // title and memo, one second for 읽은 시간 · 방문 쪽/전체 쪽 · 마지막
    // 읽음 with 열기/이어 읽기 and the status control at its end. No
    // second progress bar, and the page strip is a fold, not always open.
    const recordsBox=node('div',null,list,{class:'sc-resume sc-reading-records'});
    for(const r of listed.slice(state.readingPage*PER,(state.readingPage+1)*PER)){
     drawResumeRow(recordsBox,r,{recordMeta:true});
     drewStrip=true;
    }
   }
   if(!drewStrip&&!list.childNodes.length)empty('읽은 시간과 페이지는 PDF를 열어 읽는 동안 자동으로 기록됩니다. 아직 기록이 없습니다.',list);
   // The key used to stand above every strip whether or not any fold was
   // open; it now draws inside each 쪽별 기록 fold instead, so it is only
   // seen once one is actually opened.
  }
  function drawReading(){const progress=node('div',null,body,{'data-reading-progress':'true'});const b=bar();for(const theme of ['light','dark','sepia'])button(({light:'밝은 PDF',dark:'어두운 PDF',sepia:'세피아 PDF'})[theme],()=>reader.applyTheme(win,theme),b);
   button('리더 모양 원래대로',async()=>{await reader.resetAppearance(win);render();},b);
   const margin=reader.marginOptions(),marginBar=bar();
   const width=node('input',null,marginBar,{type:'number',min:160,max:480,'aria-label':'여백 주석 너비'});width.value=String(margin.width);
   const side=node('select',null,marginBar,{'aria-label':'여백 주석 위치'});node('option','오른쪽',side,{value:'right'});node('option','왼쪽',side,{value:'left'});side.value=margin.side;
   const limit=node('input',null,marginBar,{type:'number',min:100,max:5000,'aria-label':'여백 주석 표시 글자 수'});limit.value=String(margin.textLimit);
   button('여백 주석 설정 적용',async()=>{await reader.setMarginOptions(win,{width:Number(width.value),side:side.value,textLimit:Number(limit.value)});message('여백 주석 설정을 적용했습니다.');},marginBar);
   const settings=runtime.cache.readerSettings||{};
   check('PDF 여백에 주석 표시',!!settings.marginAnnotations,on=>run(()=>reader.setMarginAnnotations(win,on)),b);
   check('리더 사이드바 표시',settings.sidebarVisible!==false,on=>run(()=>reader.setSidebar(win,on)),b);
   check('세로 탭 목록 표시',!!settings.verticalTabs,on=>run(()=>reader.setVerticalTabs(win,on)),b);
   const colors=bar(),color=node('input',null,colors,{type:'color',value:'#ffd400','aria-label':'주석 색상'}),label=node('input',null,colors,{placeholder:'색상의 의미','aria-label':'색상 이름'});button('색상 이름 저장',()=>reader.setColorLabel(color.value,label.value),colors);
   const custom=bar();const bg=node('input',null,custom,{type:'color',value:'#ffffff','aria-label':'PDF 배경색'}),fg=node('input',null,custom,{type:'color',value:'#28313b','aria-label':'PDF 글자색'});button('사용자 PDF 테마 적용',()=>reader.applyTheme(win,{background:bg.value,foreground:fg.value}),custom);
   const paletteBar=bar(),paletteSelect=node('select',null,paletteBar,{'aria-label':'저장된 주석 팔레트'});
   node('option','주석 팔레트 선택',paletteSelect,{value:''});
   for(const palette of reader.annotationPalettes())node('option',palette.name,paletteSelect,{value:palette.id});
   paletteSelect.value=state.paletteID||settings.annotationPaletteID||'';
   paletteSelect.addEventListener('change',()=>{state.paletteID=paletteSelect.value;});
   button('주석 팔레트 적용',async()=>{if(!paletteSelect.value)throw new Error('주석 팔레트를 선택하세요.');await reader.applyAnnotationPalette(win,paletteSelect.value);message('주석 팔레트를 적용했습니다.');},paletteBar);
   button('주석 팔레트 삭제',async()=>{if(!paletteSelect.value)throw new Error('주석 팔레트를 선택하세요.');await reader.deleteAnnotationPalette(paletteSelect.value);state.paletteID=null;render();},paletteBar);
   const paletteName=node('input',null,body,{'aria-label':'새 주석 팔레트 이름',placeholder:'주석 팔레트 이름'});
   const paletteText=node('textarea',null,body,{'aria-label':'주석 팔레트 색상과 이름',placeholder:'#ffd400, 핵심 주장\n#ff6666, 확인 필요'});
   node('p','한 줄에 #RRGGBB 색상과 이름을 쉼표로 구분해 입력하세요.',body,{class:'sc-muted'});
   button('주석 팔레트 저장',async()=>{
    const entries=paletteText.value.split(/\r?\n/).filter(line=>line.trim()).map(line=>{const comma=line.indexOf(',');if(comma<0)throw new Error('색상과 이름을 쉼표로 구분하세요.');return {color:line.slice(0,comma).trim(),label:line.slice(comma+1).trim()};});
    const saved=await reader.saveAnnotationPalette(paletteName.value,entries);state.paletteID=saved.id;render();
   },body);
   /* The reading data is what the tab is for; the reader's appearance and
      annotation colours sat above it and pushed it below the fold. */
   const look=node('details',null,body,{class:'sc-group sc-reader-look'});node('summary','리더 모양·주석 색',look);
   for(const el of [...body.children])if(el!==progress&&el!==look)look.appendChild(el);
   look.open=!!runtime.cache.workbenchUI?.readerLook;look.addEventListener('toggle',()=>saveUI({readerLook:look.open}));
   refreshReading();
  }
  function drawTabs(){
   // The switch has its own line: a 16px box beside a 32px field made the row three heights.
   check('세로 탭 목록 표시',!!runtime.cache.readerSettings?.verticalTabs,on=>run(()=>reader.setVerticalTabs(win,on)),bar());
   const b=bar();
   const tabs=reader.tabs(win);
   /* Saving needs a name and a document open: the button says so by being off,
      instead of answering the press in English. A saved name is cleared, so a
      second press does not make a second group of the same name. */
   const docs=tabs.filter(tab=>tab.itemID).length;
   const name=node('input',null,b,{placeholder:'탭 그룹 이름','aria-label':'탭 그룹 이름'});
   const saveGroup=button('열린 탭 저장',async()=>{const submitted=name.value.trim();await reader.saveTabGroup(win,submitted);finishDraft(name,name.value,true);await render();message(`“${submitted}” 탭 그룹을 저장했습니다 · 문서 ${docs}개`);},b,{title:docs?'':T('PDF 탭을 하나 이상 연 뒤 저장할 수 있습니다')});
   const syncSave=()=>{saveGroup.disabled=!docs||!name.value.trim();};
   name.addEventListener('input',syncSave);syncSave();
   sectionHead('열린 탭',tabs.length);
   for(const [index,tab]of tabs.entries()){
    const c=card(tab.title,tab.selected?'현재 탭':'');button('이동',()=>reader.selectTab(win,tab.id),c);
    if(tab.itemID){button('닫기',async()=>{await reader.closeTab(win,tab.id);render();},c);
     button('탭 앞으로',()=>{reader.moveTab(win,tab.id,index-1);render();},c).disabled=index<=1;
     button('탭 뒤로',()=>{reader.moveTab(win,tab.id,index+1);render();},c).disabled=index>=tabs.length-1;
     button('이 탭 외 문서 탭 닫기',()=>{const result=reader.closeOtherTabs(win,tab.id);render();message(`${result.closed}개 문서 탭을 닫았습니다.`);},c);
    }
   }
   const groups=reader.tabGroups();
   sectionHead('저장된 탭 그룹',groups.length||'');
   // A heading over nothing reads as a page that failed to load.
   if(!groups.length)empty('저장한 탭 그룹이 없습니다. 위에서 이름을 적고 "열린 탭 저장"을 누르면 지금 열린 문서 탭을 한 묶음으로 저장합니다.');
   for(const group of groups){
    const c=card(group.name,`${group.tabs.length}개 탭`),title=node('input',null,c,{'aria-label':'저장된 탭 그룹 이름'});title.value=group.name;title.dataset.draftKey=JSON.stringify(['tab-group-name',group.id]);
    button('복원',async()=>{const result=await reader.restoreTabGroup(win,group.id);await render();message(`복원 ${result.opened} · 찾지 못함 ${result.missing}`);},c);
    button('탭 그룹 이름 변경',async()=>{const submitted=title.value;await reader.renameTabGroup(group.id,submitted);finishDraft(title,submitted);render();},c);
    button('현재 탭으로 그룹 갱신',async()=>{await reader.updateTabGroup(win,group.id);render();},c);
    button('그룹 삭제',async()=>{
     const at=reader.tabGroups().findIndex(g=>g.id===group.id);
     await reader.deleteTabGroup(group.id);render();
     undoToast(`탭 그룹 “${group.name}”을 지웠습니다.`,async()=>{await reader.undeleteTabGroup(group,at);await render();message(`탭 그룹 “${group.name}”을 되살렸습니다.`);});
    },c);
   }
  }
  function drawViews(){
   // Nothing saved yet: the name field and its button live inside the empty card, not above it.
   const b=reader.viewGroups().length?bar():emptyActions(emptyCard(body,{title:'저장한 뷰 그룹이 없습니다.',hint:'열 표시·순서·너비·정렬을 조절한 뒤 현재 뷰를 저장하세요.'})),name=node('input',null,b,{placeholder:'현재 열 배치 이름','aria-label':'뷰 그룹 이름'});const saveView=button('현재 뷰 저장',async()=>{const submitted=name.value.trim();await reader.saveView(win,submitted);finishDraft(name,name.value,true);await render();message(`“${submitted}” 뷰를 저장했습니다.`);},b);
   {const sync=()=>{saveView.disabled=!name.value.trim();};name.addEventListener('input',sync);sync();}
   for(const view of reader.viewGroups()){
    const c=card(view.name,`${view.columns.length}개 열 설정`),title=node('input',null,c,{'aria-label':'저장된 뷰 그룹 이름'});title.value=view.name;title.dataset.draftKey=JSON.stringify(['view-group-name',view.id]);
    button('적용',()=>run(async()=>{await reader.applyView(win,view.id);message(`${view.name} 뷰를 적용했습니다.`);}),c);
    button('뷰 그룹 이름 변경',async()=>{const submitted=title.value;await reader.renameView(view.id,submitted);finishDraft(title,submitted);render();},c);
    button('현재 열 배치로 뷰 갱신',async()=>{await reader.updateView(win,view.id);render();},c);
    button('삭제',async()=>{
     const at=reader.viewGroups().findIndex(g=>g.id===view.id);
     await reader.deleteView(view.id);render();
     undoToast(`뷰 그룹 “${view.name}”을 지웠습니다.`,async()=>{await reader.undeleteView(view,at);await render();message(`뷰 그룹 “${view.name}”을 되살렸습니다.`);});
    },c);
   }
  }
  function drawCanvas(){const noBoards=!(runtime.cache.boards||[]).length;const b=noBoards?emptyActions(emptyCard(body,{title:'보드를 만들고 선택한 문헌을 카드로 추가하세요.'})):bar(),name=node('input',null,b,{placeholder:'새 보드 이름','aria-label':'보드 이름'});button('보드 만들기',async()=>{const board=model.createBoard(runtime.cache,name.value);state.boardID=board.id;runtime.dirty=true;await runtime.flush();render();},b,{'data-variant':'primary'});const select=node('select',null,b,{'aria-label':'캔버스 선택'});node('option','보드 선택',select,{value:''});for(const board of runtime.cache.boards||[])node('option',board.name,select,{value:board.id});select.value=state.boardID||'';select.addEventListener('change',()=>{state.boardID=select.value;state.cardIDs.clear();render();});const board=(runtime.cache.boards||[]).find(b=>b.id===state.boardID);
   button('보드 삭제',async()=>{if(!board)throw new Error('삭제할 보드를 선택하세요.');deletedCardSelections.set(board.id,[...state.cardIDs]);model.deleteBoard(runtime.cache,board.id);state.boardID=null;state.cardIDs.clear();runtime.dirty=true;await runtime.flush();render();},b,{class:'sc-danger-soft'}).hidden=!board;
   // Nothing to act on is shown as off, as the matrix's paging and the tab
   // manager's moves already are, instead of an error after the press.
   select.disabled=noBoards;if(noBoards)select.hidden=true;
   button('삭제 취소',async()=>{const restored=model.restoreBoard(runtime.cache);if(!restored)throw new Error('되돌릴 보드가 없습니다. 보드를 지운 뒤에만 되돌릴 수 있습니다.');state.boardID=restored.id;state.cardIDs=new Set((deletedCardSelections.get(restored.id)||[]).filter(id=>restored.nodes.some(n=>n.id===id)));runtime.dirty=true;await runtime.flush();render();},b).hidden=!(deletedCardSelections.size||(runtime.cache.boardTrash||[]).length);
   if(!board){if(!noBoards)empty('보드를 선택하거나 새로 만드세요.');return;}
   const save=async()=>{runtime.dirty=true;await runtime.flush();render();};button('선택 문헌 추가',async()=>{const chosen=selected();if(!chosen.length)throw new Error('카드로 올릴 문헌을 먼저 선택하세요.');model.addToBoard(runtime.cache,board,chosen);await save();},b);button('메모 카드 추가',async()=>{model.addBoardNote(runtime.cache,board,'새 메모');await save();},b);button('카드 연결',async()=>{const ids=[...state.cardIDs];if(ids.length!==2)throw new Error('두 카드를 선택하세요.');model.linkCards(board,...ids);await save();},b);button('선택 카드 삭제',async()=>{
    if(!state.cardIDs.size)throw new Error('지울 카드를 먼저 선택하세요.');
    /* A board can be restored after deletion; its cards, with their memos,
       could not. The cards and their links are kept for one 되돌리기. */
    const gone=board.nodes.filter(n=>state.cardIDs.has(n.id)).map(n=>({...n}));
    const links=board.edges.filter(e=>state.cardIDs.has(e.source)||state.cardIDs.has(e.target)).map(e=>({...e}));
    for(const id of state.cardIDs)model.removeCard(board,id);state.cardIDs.clear();await save();
    message(`카드 ${gone.length}개를 지웠습니다.`);
    const undo=button('카드 삭제 되돌리기',async()=>{
     const have=new Set(board.nodes.map(n=>n.id));
     board.nodes.push(...gone.filter(n=>!have.has(n.id)));
     const ids=new Set(board.nodes.map(n=>n.id));
     board.edges.push(...links.filter(e=>ids.has(e.source)&&ids.has(e.target)&&!board.edges.some(x=>x.source===e.source&&x.target===e.target)));
     await save();message(`카드 ${gone.length}개를 되살렸습니다.`);
    },bar());undo.dataset.role='card-undo';
   },b);
   const boardName=node('input',null,b,{'aria-label':'현재 보드 이름'});boardName.value=board.name;boardName.dataset.draftKey=JSON.stringify(['board-name',board.id]);
   button('보드 이름 변경',async()=>{const submitted=boardName.value;model.renameBoard(board,submitted);runtime.dirty=true;await runtime.flush();finishDraft(boardName,submitted);render();},b);
   button('카드 연결 해제',async()=>{const ids=[...state.cardIDs];if(ids.length!==2)throw new Error('연결을 해제할 두 카드를 선택하세요.');model.unlinkCards(board,...ids);await save();},b);
   const canvas=node('div',null,body,{class:'sc-canvas'});const svg=doc.createElementNS(SVG,'svg');svg.setAttribute('class','sc-canvas-lines');svg.setAttribute('width',String(Math.max(2000,...board.nodes.map(n=>n.x+300))));svg.setAttribute('height',String(Math.max(2000,...board.nodes.map(n=>n.y+300))));canvas.appendChild(svg);for(const e of board.edges){const a=board.nodes.find(n=>n.id===e.source),z=board.nodes.find(n=>n.id===e.target);if(!a||!z)continue;const line=doc.createElementNS(SVG,'line');for(const[k,v]of Object.entries({x1:a.x+90,y1:a.y+40,x2:z.x+90,y2:z.y+40,stroke:'var(--sc-graph-line)'}))line.setAttribute(k,v);svg.appendChild(line);}
   for(const n of board.nodes){const c=card(n.label,null,canvas);c.classList.add('sc-canvas-card');c.dataset.cardId=n.id;c.style.left=n.x+'px';c.style.top=n.y+'px';c.style.background=/^#[0-9a-f]{6}$/i.test(n.color)?n.color:'#ffffff';check('카드 선택',state.cardIDs.has(n.id),on=>on?state.cardIDs.add(n.id):state.cardIDs.delete(n.id),c);const memo=node('textarea',null,c,{'aria-label':'카드 메모'});memo.dataset.draftKey=JSON.stringify(['board-note',board.id,n.id]);memo.value=n.note;memo.addEventListener('change',()=>run(async()=>{n.note=memo.value.slice(0,50000);runtime.dirty=true;await runtime.flush();}));if(n.itemID)button('문헌 열기',()=>library.openItem(n.itemID),c,{'data-opens':'window'});
    const editor=node('details',null,c);node('summary','카드 편집',editor);
    const title=node('input',null,editor,{'aria-label':'카드 제목'});title.value=n.label;title.dataset.draftKey=JSON.stringify(['board-label',board.id,n.id]);
    const color=node('input',null,editor,{type:'color','aria-label':'카드 색상'});color.value=n.color;color.dataset.draftKey=JSON.stringify(['board-color',board.id,n.id]);
    button('카드 모양 저장',async()=>{const label=title.value,hex=color.value;model.updateCard(board,n.id,{label,color:hex});runtime.dirty=true;await runtime.flush();finishDraft(title,label);finishDraft(color,hex);render();},editor);
    const handle=c.querySelector('h3');handle.setAttribute('tabindex','0');handle.title=T('드래그하거나 방향키로 이동');if(n.itemID)handle.addEventListener('dblclick',()=>run(()=>library.openItem(n.itemID)));handle.addEventListener('keydown',e=>{const move={ArrowLeft:[-10,0],ArrowRight:[10,0],ArrowUp:[0,-10],ArrowDown:[0,10]}[e.key];if(move){e.preventDefault();model.moveCard(board,n.id,n.x+move[0],n.y+move[1]);
     // The board is redrawn to move the lines; the card keeps the keyboard, so a second press moves it again.
     run(async()=>{await save();body.querySelector(`.sc-canvas-card[data-card-id="${n.id}"] h3`)?.focus?.();});}});
    handle.addEventListener('pointerdown',e=>{const start={x:e.clientX,y:e.clientY,left:n.x,top:n.y};handle.setPointerCapture?.(e.pointerId);const move=ev=>{model.moveCard(board,n.id,start.left+ev.clientX-start.x,start.top+ev.clientY-start.y);c.style.left=n.x+'px';c.style.top=n.y+'px';};const up=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',up);
     // A click is not a move: redrawing on every release rebuilt the card between the two clicks of a double-click.
     if(n.x!==start.left||n.y!==start.top)run(save);};handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',up,{once:true});});
   }
  }
  // The fields long enough to need clamping, which is done on a child of the cell.
  /* A44: 문헌 추가 -- a search over the whole library, its own box rather
     than the top one (that one narrows 보유 문헌 itself; this one only picks
     who is compared), and the chosen list beside it. Both edit state.selected
     directly, so the table, references, footer and CSV all follow from the
     one Set the rest of the panel already reads. */
  /* With a table already on screen (the chosen papers, or the whole list) the picker stays folded behind 문헌 추가. */
  const matrixPickerDefaultOpen=()=>selected().length<1&&!rows().length;
  function drawMatrixPicker(parent){
   const onChange=()=>{state.matrixUsingSelection=true;render();};
   const chosen=selected();
   if(chosen.length){
    const list=node('div',null,parent,{class:'sc-matrix-selection'});
    for(const item of chosen){
     const row=node('div',null,list,{class:'sc-matrix-selection-row'});
     node('span',item.title||T('제목 없음'),row,{class:'sc-matrix-selection-title'});
     button('빼기',()=>{state.selected.delete(String(item.id));onChange();},row);
    }
   }
   // With a comparison already on screen the picker stays folded; 문헌 추가 opens it.
   const open=state.matrixPickerOpen??matrixPickerDefaultOpen();
   if(!open)return;
   const picker=node('div',null,parent,{class:'sc-matrix-picker'});
   const searchBar=node('div',null,picker,{class:'sc-actions'});
   const search=node('input',null,searchBar,{type:'search',placeholder:T('제목·저자로 찾기'),'aria-label':T('비교에 추가할 문헌 검색')});
   search.value=state.matrixPickerQuery||'';
   const results=node('div',null,picker,{class:'sc-hits sc-matrix-picker-results'});
   const drawResults=()=>{
    results.replaceChildren();
    const chosenIDs=new Set(selected().map(item=>String(item.id)));
    const q=String(state.matrixPickerQuery||'').trim();
    const pool=state.items.filter(item=>!chosenIDs.has(String(item.id)));
    const matched=q?pool.filter(item=>model.matches([item.title,item.authors].join(' '),q)):pool;
    const limit=state.matrixPickerAll?matched.length:6;
    for(const item of matched.slice(0,limit)){
     const row=node('div',null,results,{class:'sc-matrix-picker-row'});
     node('span',item.title||T('제목 없음'),row,{class:'sc-matrix-picker-title'});
     node('span',item.authors||'',row,{class:'sc-muted sc-matrix-picker-authors'});
     button('추가',()=>{state.selected.add(String(item.id));onChange();},row);
    }
    if(!matched.length)node('p',T('일치하는 문헌이 없습니다.'),results,{class:'sc-muted'});
    else if(matched.length>limit)viewButton(T(`${matched.length-limit}개 더 보기`),()=>{state.matrixPickerAll=true;drawResults();},results,{class:'sc-local-reading-more'});
   };
   drawResults();
   let typing=null;
   search.addEventListener('input',()=>{state.matrixPickerQuery=search.value;state.matrixPickerAll=false;win.clearTimeout(typing);typing=win.setTimeout(drawResults,150);});
  }
  const CLAMPED=new Set(['abstract','summary','remark']);
  // 논문 비교 evidence fields, in the order a methods table reads them; kept per paper by runtime.setEvidence.
  // Saves still in flight; an export waits for them so the last edit is in it.
  const evidenceSaves=new Set(),settleEvidence=async()=>{while(evidenceSaves.size)await Promise.allSettled([...evidenceSaves]);};
  const EVIDENCE=[['species','생물종/균주'],['construct','construct'],['condition','조건'],['control','대조군'],['result','결과'],['limit','한계']];
  function drawMatrix(){
   const available=[['title','제목'],['authors','저자'],['year','발행연도'],['venue','저널'],['doi','DOI'],['citations','인용 수'],['impactFactor','IF'],['status','읽기 상태'],['rating','별점'],['seconds','읽기 시간'],['tags','태그'],['abstract','초록'],['remark','읽기 메모'],['summary','AI 요약'],...EVIDENCE.map(([key,label])=>['ev_'+key,label])];
   // The deciding figures come right after the name, ahead of venue and
   // authors, so they fit before a docked panel runs out of width; DOI is
   // still there to add back, but nobody compares two papers by their DOI.
   const defaults=['title','status','year','citations','impactFactor','venue','authors'];
   /* A44: once the picker has been used -- adding or removing a paper --
      the comparison is exactly the chosen set, empty included. Before that,
      nothing has committed to "a selection" yet, so 0 chosen still means
      "compare what 보유 문헌 is showing", which is what every existing use of
      this tab (and the tests for it) already expects. */
   const usingPicker=matrixUsingPicker();
   const scopeItems=usingPicker?model.sortItems(selected(),state.sort):rows();
   // No saved choices yet: a memo on any of these papers earns its own column, right after the reading state.
   const hasMemo=scopeItems.some(item=>String(item.remark||'').trim());
   const defaultFields=hasMemo?[...defaults.slice(0,2),'remark',...defaults.slice(2)]:defaults;
   const saved=runtime.cache.matrixFields;
   const fields=Array.isArray(saved)?[...new Set(saved.filter(field=>available.some(([key])=>field===key)))]:defaultFields;
   if(!fields.length)fields.push(...defaultFields);
   /* 2-4 papers flip to one row per paper by default -- the shape that fits a
      docked panel without a scrollbar -- but a reader who has chosen a side
      keeps it: null means "decide for me", true/false means they did. */
   const n=scopeItems.length,flip=state.transpose??(n>=2&&n<=4);
   const b=bar();if(scopeItems.length)button('행·열 전환',()=>{state.transpose=!flip;render();},b);
   button('문헌 추가',()=>{state.matrixPickerOpen=!(state.matrixPickerOpen??matrixPickerDefaultOpen());render();},b);
   drawMatrixPicker(body);
   if(!scopeItems.length){
    empty('비교할 문헌을 추가하세요.');
    return;
   }
   const options=node('details',null,body,{class:'sc-matrix-options'});node('summary','비교 항목 선택',options);
   const fieldNames=Object.fromEntries(available);
   for(const[key,label]of available)check('비교 항목: '+T(label),fields.includes(key),on=>run(async()=>{
    const latest=Array.isArray(runtime.cache.matrixFields)?[...new Set(runtime.cache.matrixFields.filter(field=>available.some(([id])=>id===field)))]:fields;
    const next=on?[...new Set([...latest,key])]:latest.filter(field=>field!==key);
    if(!next.length){render();throw new Error('비교 항목을 최소 하나는 남겨 두세요.');}
    runtime.cache.matrixFields=next;runtime.dirty=true;await runtime.flush();render();
   }),options);
   /* The table is read by people and pasted into sheets: statuses in words,
      time as "1시간 5분" rather than 3900. */
   const STATUS={unread:'안 읽음',reading:'읽는 중',done:'완료'};
   const values=scopeItems.map(item=>{
    const ref=runtime.Z.Items.get(Number(item.id)),entry=ref?runtime.entry(ref):{};
    const seconds=Number(item.seconds)||0;
    const evidence=ref&&typeof runtime.evidenceOf==='function'?runtime.evidenceOf(ref):{};
    return {...item,...Object.fromEntries(EVIDENCE.map(([key])=>['ev_'+key,evidence[key]||''])),tags:(item.tags||[]).join(' · '),remark:entry.remark||'',summary:entry.summary||'',
     status:T(STATUS[item.status]||item.status||'안 읽음'),
     seconds:seconds>0?(runtime.formatReadTime?runtime.formatReadTime(seconds,{compact:true}):`${seconds}초`):''};
   });
   const data=model.matrix(values,fields,flip);
   // Evidence typed into a cell lands in `values`, so the CSV is read at the click.
   button('CSV 복사',async()=>{await settleEvidence();copy(model.csv(model.matrix(values,fields,flip).map((row,i)=>row.map((value,j)=>(flip?j===0:i===0)?T(fieldNames[value]||String(value)):value))));},b);
   if(typeof runtime.setEvidence==='function'){
    if(!EVIDENCE.every(([key])=>fields.includes('ev_'+key)))button('근거 칸 추가',()=>run(async()=>{
     runtime.cache.matrixFields=[...new Set([...fields,...EVIDENCE.map(([key])=>'ev_'+key)])];runtime.dirty=true;await runtime.flush();render();
    }),b,{title:T('생물종/균주 · construct · 조건 · 대조군 · 결과 · 한계 칸을 표에 넣고 직접 적습니다')});
    button('종합 노트 만들기',()=>run(async()=>{
     await settleEvidence();
     const wanted=new Set([...state.annotationIDs].map(String)),marks=wanted.size?(await library.annotations(values.map(v=>v.id))).filter(m=>wanted.has(String(m.id))):[];
     const entries=values.map(v=>({id:v.id,evidence:EVIDENCE.map(([key,label])=>[label,v['ev_'+key]]),annotationIDs:marks.filter(m=>String(m.parentID)===String(v.id)).map(m=>m.id)}))
      .filter(entry=>entry.annotationIDs.length||entry.evidence.some(([,text])=>String(text||'').trim()));
     if(!entries.length){message('적어 둔 근거 칸이나 고른 주석이 없어 노트를 만들지 않았습니다. 칸에 내용을 적거나 주석 탭에서 주석을 고르세요.',true);return;}
     const collection=win.ZoteroPane?.getSelectedCollection?.();
     const id=await library.synthesisNote(entries,{title:T('논문 비교 종합')+' · '+new Date().toISOString().slice(0,10),collectionID:collection?.id});
     noteCache=null;await library.openItem(id);
     message(T(`문헌 ${entries.length}편으로 종합 노트를 만들었습니다 — 아이템 창에서 선택했습니다.`)+(marks.length?T(` 주석 ${marks.length}개 포함`):''));
    }),b,{'data-opens':'pane',title:T('비교 중인 문헌의 근거 칸과, 주석 탭에서 고른 주석을 한 노트로 모읍니다. 각 문헌과 주석 페이지로 가는 링크가 들어갑니다')});
   }
   const pageSize=setting('matrixPageSize',50),total=Math.ceil(values.length/pageSize),key=JSON.stringify(values.map(i=>i.id));
   if(state.matrixPageKey!==key){state.matrixPageKey=key;state.matrixPage=0;}
   state.matrixPage=Math.max(0,Math.min(state.matrixPage||0,Math.max(0,total-1)));
   // One page of everything never needed paging chrome; it only crowded the bar.
   if(total>1){
    /* The pager is the right end of the toolbar: ‹ 1/9 ›, with the totals in its tooltip. */
    const pager=node('span',null,b,{class:'sc-matrix-pager',role:'group','aria-label':T('비교 표 페이지'),title:T(`전체 ${values.length}개 · ${state.matrixPage+1}/${Math.max(1,total)} 페이지 · CSV는 전체 문헌`)});
    const prev=button('',()=>{state.matrixPage--;render();},pager,{class:'sc-icon-button','aria-label':'비교 이전 페이지',title:T('이전 페이지')});setIcon(prev,'matrixPrev');prev.disabled=state.matrixPage===0;
    node('span',`${state.matrixPage+1}/${Math.max(1,total)}`,pager,{class:'sc-matrix-pager-count',role:'status'});
    const next=button('',()=>{state.matrixPage++;render();},pager,{class:'sc-icon-button','aria-label':'비교 다음 페이지',title:T('다음 페이지')});setIcon(next,'matrixNext');next.disabled=state.matrixPage+1>=total;
   }
   // With nothing selected the table is the whole list on screen; it says so.
   if(!selected().length)node('p','선택 없음 · 현재 목록 전체',body,{class:'sc-muted sc-matrix-scope'});
   const shown=model.matrix(values.slice(state.matrixPage*pageSize,(state.matrixPage+1)*pageSize),fields,flip);
   const scroll=node('div',null,body,{class:'sc-matrix-scroll'});
   const moreHint=node('p',T('표가 옆으로 더 이어집니다. 가로로 밀어서 보세요.'),body,{class:'sc-muted sc-matrix-hint'});moreHint.hidden=true;
   // A table wider than the panel says so: a fade at the cut edge and a line under it, until the end is reached.
   const syncMore=()=>{const more=scroll.scrollWidth>scroll.clientWidth+2&&scroll.scrollLeft+scroll.clientWidth<scroll.scrollWidth-2;scroll.dataset.more=String(more);moreHint.hidden=!(scroll.scrollWidth>scroll.clientWidth+2);};
   scroll.addEventListener('scroll',syncMore);win.requestAnimationFrame?.(syncMore);
   const table=node('table',null,scroll,{class:'sc-matrix'});
   table.dataset.fit=String(flip&&n<=4);
   // Figures are compared down a column, so they set flush right in tabular
   // numerals; the field's own row or column carries the mark.
   const NUMERIC=new Set(['year','citations','impactFactor','rating']);
   const pageItems=values.slice(state.matrixPage*pageSize,(state.matrixPage+1)*pageSize);
   shown.forEach((row,i)=>{const tr=node('tr',null,table);row.forEach((value,j)=>{const heading=flip?j===0:i===0;const field=flip?fields[i]:fields[j];
    // A title is the way to the paper, as it is everywhere else in the panel.
    const paper=!heading&&field==='title'?pageItems[(flip?j:i)-1]:null;
    const rowItem=!heading?pageItems[(flip?j:i)-1]:null;
    const cell=node(heading?'th':'td',heading?(fieldNames[value]||String(value)):paper?null:String(value),tr);
    if(paper)button(String(value),()=>library.openItem(paper.id),cell,{class:'sc-link-button','data-opens':'window',title:`${value} · Zotero에서 열기`});
    /* The long prose fields are clamped on a child, not on the cell.
       Two adjacent cells that are both `display: -webkit-box` are laid out as
       one box, so in the flipped table -- which is what two or three papers
       get -- the second paper's memo printed underneath the first paper's
       inside the first paper's cell. */
    if(!heading&&!paper&&CLAMPED.has(field)){cell.textContent='';node('div',String(value),cell,{class:'sc-matrix-clamp'});}
    if(!heading&&rowItem&&String(field||'').startsWith('ev_')&&typeof runtime.setEvidence==='function'){
     cell.textContent='';
     const area=node('textarea',null,cell,{class:'sc-matrix-edit',rows:'2','aria-label':`${T(fieldNames[field])} · ${rowItem.title}`,placeholder:T('적기')});
     area.value=String(value);
     // Keyed by the paper, not by its title and position: same-title papers
     // and a reordered table must not swap what was typed.
     const ownerRef=runtime.Z.Items.get(Number(rowItem.id));
     area.dataset.draftKey=JSON.stringify(['evidence',rowItem.libraryID??ownerRef?.libraryID??state.libraryID,rowItem.key??ownerRef?.key??rowItem.id,field]);
     if(drafts.has(area.dataset.draftKey)){area.value=drafts.get(area.dataset.draftKey);rowItem[field]=area.value;}
     area.addEventListener('input',()=>{rowItem[field]=area.value;});
     area.addEventListener('change',()=>run(async()=>{
      const ref=runtime.Z.Items.get(Number(rowItem.id));if(!ref)return;
      const submitted=area.value;rowItem[field]=submitted;const save=runtime.setEvidence(ref,{[field.slice(3)]:submitted});
      const tracked=Promise.resolve(save);evidenceSaves.add(tracked);
      try{await tracked;}finally{evidenceSaves.delete(tracked);}
      finishDraft(area,submitted);
     }));
    }
    if(NUMERIC.has(field))cell.classList.add('sc-figure-cell');if(heading)cell.setAttribute('scope',flip?'row':'col');if(!heading&&field)cell.dataset.field=field;});});
   // Only an explicit pick, not "whatever is on screen": with nothing chosen
   // the table above is the whole list, and there is no fixed set of papers
   // to ask "which references do these share".
   if(selected().length>=2&&selected().length<=6)drawCompareReferences(scopeItems);
   const insightFold=node('details',null,body,{class:'sc-compare-insight-fold'});
   node('summary','주장·논쟁 AI 분석',insightFold);
   if(state.compareInsightOpen)insightFold.open=true;
   insightFold.addEventListener('toggle',()=>{state.compareInsightOpen=insightFold.open;});
   drawCompareInsight(values,insightFold);
  }
  /* What the chosen papers cite in common, and what only one of them does --
     read from the reference lists paperWorks() already holds, nothing asked
     for. Rows are the referenced works, shared ones first; a column per
     paper marks who cites it; the last column says whether the work itself
     is on the shelf, and how far read if so. */
  function drawCompareReferences(papers){
   const works=typeof runtime.paperWorks==='function'?runtime.paperWorks():{};
   const workOf=p=>works[p.libraryID+':'+p.key]||works[String(p.id)]||null;
   // null (not fetched) is kept apart from [] (fetched, empty): only the
   // first should count against "확보".
   const refsOf=p=>{const w=workOf(p);return Array.isArray(w?.references)?w.references.map(bareWork):null;};
   const acquired=papers.filter(p=>refsOf(p));
   const byRef=new Map();
   for(const p of papers){
    const refs=refsOf(p);if(!refs)continue;
    for(const ref of new Set(refs)){if(!byRef.has(ref))byRef.set(ref,[]);byRef.get(ref).push(p);}
   }
   const shared=[...byRef].filter(([,citing])=>citing.length>=2);
   const single=[...byRef].filter(([,citing])=>citing.length===1);
   const section=node('section',null,body,{class:'sc-compare-references'});
   const fold=node('details',null,section);
   if(state.compareReferencesOpen)fold.open=true;
   fold.addEventListener('toggle',()=>{state.compareReferencesOpen=fold.open;});
   node('summary',papers.length>=3
    ?`2편 이상에서 인용 ${shared.length} · 확보된 목록 중 한 편만 인용 ${single.length} · 참고목록 확보 ${acquired.length}/${papers.length}편`
    :`공통 참고문헌 ${shared.length} · 확보된 목록 중 한 편만 인용 ${single.length} · 참고목록 확보 ${acquired.length}/${papers.length}편`,fold);
   if(!byRef.size){node('p','참고문헌 기록이 없습니다. 관계 그래프에서 인용 목록을 가져오면 채워집니다.',fold,{class:'sc-muted'});return;}
   const STATUS={unread:'안 읽음',reading:'읽는 중',done:'완료'};
   const scroll=node('div',null,fold,{class:'sc-reference-matrix-scroll'});
   const table=node('table',null,scroll,{class:'sc-reference-matrix'});
   const thead=node('thead',null,table);
   const head=node('tr',null,thead);node('th','',head);
   for(const p of papers)node('th',String(p.title||T('제목 없음')),head,{scope:'col',title:p.title||''});
   node('th','보유',head,{scope:'col'});
   const tbody=node('tbody',null,table);
   for(const [refID,citing] of [...shared,...single]){
    const tr=node('tr',null,tbody);
    // The library, then an earlier lookup's cache, then the bare id: the
    // best name for this work that costs no request of its own.
    const held=state.items.find(item=>bareWork(workOf(item)?.openalex)===refID);
    const cache=runtime.cache&&typeof runtime.cache.workMeta==='object'?runtime.cache.workMeta:{};
    const titleCell=node('th',null,tr,{scope:'row'});
    // Opening the reference used to reuse openInList, which points the whole
    // panel's selection at it -- one press out of a comparison and the set
    // being compared was gone. It opens in Zotero instead, leaving state.selected alone.
    if(held)button(String(held.title||refID),()=>run(()=>library.openItem(held.id)),titleCell,{class:'sc-link-button','data-opens':'window',title:`${held.title||refID} · ${T('Zotero에서 열기')}`});
    else node('span',String(cache[refID]?.title||refID),titleCell,{title:refID});
    // A blank cell used to mean either "confirmed not cited" or "we never
    // fetched this paper's list, so we don't know" -- the same mark for two
    // different facts. Only an acquired list can say "no".
    for(const p of papers){
     const fetched=acquired.includes(p);
     node('td',fetched?(citing.includes(p)?'✓':''):T('미확보'),tr,{class:'sc-ref-check'+(fetched?'':' sc-ref-unknown')});
    }
    const libCell=node('td',null,tr);
    if(held)node('span',[T(STATUS[held.status]||'안 읽음'),Number(held.seconds)>0&&runtime.formatReadTime?runtime.formatReadTime(held.seconds,{compact:true}):''].filter(Boolean).join(' · '),libCell);
    else node('span','서재에 없음',libCell,{class:'sc-muted'});
   }
  }
  /* The papers in the table, read together by the model: what each claims,
     the chain it argues along, and where they pull against each other, with
     the evidence that would settle each dispute. Two to six papers, their
     abstracts and the reader's own notes go in; the outline comes back into
     a box the reader can edit, copy, or keep as a note on the first paper. */
  function drawCompareInsight(values,parent=body){
   const chosen=values.slice(0,6);
   const key=JSON.stringify(chosen.map(paper=>paper.id));
   const section=node('section',null,parent,{class:'sc-compare-insight','aria-label':'AI 논지·논쟁 분석'});
   sectionHead('주장·논리 흐름·논쟁 여지',null,section);
   const b=bar(section);
   if(!String(runtime.pref('aiEndpoint','')||'').trim())node('p','번역·AI 설정에 AI 서버 주소와 모델을 넣으면 켜집니다.',section,{class:'sc-muted'});
   node('span','언어',b,{class:'sc-muted'});
   const language=node('input',null,b,{value:setting('aiLanguage','Korean'),'aria-label':'출력 언어',class:'sc-lang'});
   const ready=chosen.length>=2&&chosen.length<=6&&values.length<=6;
   node('span',values.length>6?`${values.length}편은 너무 많습니다. 둘에서 여섯 편을 선택하세요.`:chosen.length<2?'문헌을 둘 이상 선택하면 함께 읽습니다.':`${chosen.length}편 · 초록 있음 ${chosen.filter(paper=>String(paper.abstract||'').trim()).length}`,b,{class:'sc-muted'});
   let stop;
   const go=button('함께 읽기',()=>run(async()=>{
    message('선택한 문헌의 제목·초록·메모를 설정된 AI 서비스에 요청 중…');
    const request=++aiEpoch,mark=epoch;stop.hidden=false;
    try{
     const result=await assist.run('compare',chosen,{language:language.value});
     if(disposed||panel.hidden||state.tab!=='matrix'||request!==aiEpoch||mark!==epoch)return;
     state.compareOutput=result;state.compareKey=key;
     const box=body.querySelector('.sc-compare-output');
     if(box){box.value=result;box.hidden=false;}
     const acts=body.querySelector('.sc-compare-actions');if(acts)acts.hidden=false;
     message('분석이 왔습니다. 초록만 읽고 쓴 밑그림이니 본문과 대조해 판단하세요.');
    }finally{if(stop.isConnected)stop.hidden=true;}
   }),b);
   go.disabled=!ready;
   stop=button('요청 중지',()=>{aiEpoch++;assist.cancel?.();message('AI 요청을 중지했습니다.');stop.hidden=true;},b);stop.hidden=true;
   const output=node('textarea',null,section,{class:'sc-ai-output sc-compare-output','aria-label':'AI 논지·논쟁 분석 결과 — 초록 기준 밑그림'});
   const have=state.compareKey===key&&state.compareOutput;
   output.hidden=!have;if(have)output.value=state.compareOutput;
   const actions=bar(section);actions.classList.add('sc-compare-actions');actions.hidden=!have;
   button('결과 복사',()=>copy(output.value),actions,{'data-ai-copy':'true'});
   button('첫 문헌의 노트로 저장',()=>run(async()=>{if(!output.value.trim()||state.compareKey!==key)throw new Error('먼저 “함께 읽기”를 눌러 결과를 받으세요.');noteCache=null;await library.createNote(chosen[0].id,`함께 읽기 (${chosen.map(paper=>plain(paper.title||'').slice(0,40)).join(' · ')})\n\n`+output.value);message('첫 문헌 아래에 노트로 저장했습니다.');}),actions);
  }
  /* Collections as a tree, each with a bar for how much it holds. A list of
     boxed cards, one per collection with a button and a checkbox, said no
     more than the sidebar already does; here the bars make the big and the
     empty visible at a glance, subcollections sit under their parents, and
     a name is the way in. */
  async function drawCollections(token){
   const collections=await library.collections(win.ZoteroPane?.getSelectedLibraryID?.()||runtime.Z.Libraries.userLibraryID);if(token!==epoch||disposed)return;
   const tilesAt=node('div',null,body,{class:'sc-stat-slot'});
   const b=bar();
   const find=node('input',null,b,{type:'search',placeholder:'컬렉션 이름 검색','aria-label':'컬렉션 검색'});
   const sort=node('select',null,b,{'aria-label':'컬렉션 정렬'});sort.hidden=!enabled('sortCollectionItem');
   for(const[v,l]of [['name','이름순'],['count','문헌 많은 순'],['lastRead','최근 읽은 순'],['unread','안 읽음 많은 순'],['favorite','즐겨찾기 먼저']])node('option',l,sort,{value:v});
   check('빈 컬렉션 숨기기',!!state.collectionsHideEmpty,on=>{state.collectionsHideEmpty=on;draw();},b);
   /* A paper filed in three collections is one paper: the header counts
      distinct papers, and a parent that holds its papers only through its
      subcollections is not "empty". */
   const kidsOf=new Map();
   for(const c of collections){const key=c.parentID||'';if(!kidsOf.has(key))kidsOf.set(key,[]);kidsOf.get(key).push(c);}
   const deep=new Map();
   const deepIDs=c=>{if(deep.has(c.id))return deep.get(c.id);const ids=new Set(c.itemIDs||[]);deep.set(c.id,ids);for(const kid of kidsOf.get(c.id)||[])for(const id of deepIDs(kid))ids.add(id);return ids;};
   for(const c of collections)c.deepCount=c.itemIDs?deepIDs(c).size:c.count;
   const distinct=new Set(collections.flatMap(c=>c.itemIDs||[])).size||collections.reduce((n,c)=>n+c.count,0);
   // The bar, its split and its figure all count the same papers: the collection with what is filed below it.
   const most=Math.max(1,...collections.map(c=>c.deepCount||0));
   const statusByID=new Map(state.items.map(i=>[String(i.id),i.status]));
   const readByID=new Map(state.items.map(i=>[String(i.id),runtime.localStamp?runtime.localStamp(i.lastRead)?.getTime():Date.parse(i.lastRead||'')]));
   const secondsByID=new Map(state.items.map(i=>[String(i.id),Number(i.seconds)||0]));
   // What is read in each, and when anything in it was last read: which projects are live, and which are shelved.
   const readingMix=ids=>{const mix={done:0,reading:0,unread:0,known:0,last:0,seconds:0};for(const id of ids){if(!statusByID.has(String(id)))continue;const st=statusByID.get(String(id));mix[st==='done'?'done':st==='reading'?'reading':'unread']++;mix.known++;mix.seconds+=secondsByID.get(String(id))||0;const at=readByID.get(String(id));if(Number.isFinite(at)&&at>mix.last)mix.last=at;}return mix;};
   const ago=at=>{const days=Math.floor((Date.now()-at)/864e5);return days<1?T('오늘 읽음'):days<60?T(`${days}일 전 읽음`):T(`${Math.round(days/30)}개월 전 읽음`);};
   // Live projects, not just how many exist: a collection whose papers were
   // touched in the last two weeks, off the same last-read data as each row's own bar.
   const recentDays=14*864e5,now=Date.now();
   const recent=collections.filter(c=>{const last=readingMix(deepIDs(c)).last;return last>0&&now-last<=recentDays;}).length;
   /* The summary is one stat-tile row above the search, not a sentence packed into the toolbar. */
   {const tiles=statTiles(tilesAt,[
     {value:fmtN(collections.length),label:'컬렉션',title:`컬렉션 ${collections.length}개`},
     {value:fmtN(distinct),label:'서로 다른 문헌',title:`서로 다른 문헌 ${distinct}편: 여러 컬렉션에 든 문헌은 한 번만 셉니다`},
     {value:fmtN(collections.filter(c=>!c.deepCount).length),label:'빈 컬렉션'},
     {value:fmtN(recent),label:'최근 14일 읽음',title:`최근 14일에 읽은 컬렉션 ${recent}개`}],{label:'컬렉션 요약'});
    tiles.setAttribute('aria-label',T(`컬렉션 ${collections.length}개 · 서로 다른 문헌 ${distinct}편 · 빈 컬렉션 ${collections.filter(c=>!c.deepCount).length}개 · 최근 14일에 읽은 컬렉션 ${recent}개`));}
   /* One soft group, "컬렉션 · n" over its rows; each top-level collection is a white row card inside it. */
   const treeGroup=node('section',null,body,{class:'sc-group sc-collection-section'});
   sectionHead('컬렉션',collections.length,treeGroup);
   const list=node('div',null,treeGroup,{class:'sc-collection-tree'});
   function draw(){
    list.replaceChildren();
    const favorites=runtime.cache.favoriteCollections||[];
    const q=find.value.trim();
    const byParent=new Map();
    for(const c of collections){const key=c.parentID||'';if(!byParent.has(key))byParent.set(key,[]);byParent.get(key).push(c);}
    // Which projects are live, and which have the most left: both off the reading already loaded.
    const mixOf=new Map();const mixFor=c=>{if(!mixOf.has(c.id))mixOf.set(c.id,readingMix(deepIDs(c)));return mixOf.get(c.id);};
    const order=(x,y)=>!enabled('sortCollectionItem')?0:sort.value==='lastRead'?mixFor(y).last-mixFor(x).last||x.name.localeCompare(y.name):sort.value==='unread'?mixFor(y).unread-mixFor(x).unread||x.name.localeCompare(y.name):sort.value==='count'?y.count-x.count:sort.value==='favorite'?Number(favorites.includes(y.id))-Number(favorites.includes(x.id))||x.name.localeCompare(y.name):x.name.localeCompare(y.name);
    const matches=c=>model.matches(c.name,q);
    const subtree=c=>[c,...(byParent.get(c.id)||[]).flatMap(subtree)];
    let drawn=0;
    const walk=(parent,depth,host=list)=>{
     for(const c of [...(byParent.get(parent)||[])].sort(order)){
      const family=subtree(c);
      if(!family.some(matches))continue;
      if(state.collectionsHideEmpty&&!c.deepCount)continue;
      drawn++;
      // A top-level collection is a soft grey group: its own row is the header, the subcollections sit inside it.
      const group=depth?host:node('div',null,list,{class:'sc-collection-group'});
      const row=node('div',null,group,{class:'sc-collection'+(c.deepCount?'':' sc-collection-empty'),role:'button',tabindex:'0','data-depth':String(depth),'data-id':c.id});
      row.style.setProperty('--sc-depth',String(depth));
      /* Opening a collection shows its papers: the tree moves behind the
         panel, and the panel goes to 보유 문헌 scoped to it. A parent whose
         papers all sit below it opens with its subcollections. */
      const open=()=>run(async()=>{
       await win.ZoteroPane.collectionsView.selectCollection(Number(c.id));
       if(disposed)return;
       // The papers the row counted: with its subcollections whenever it has papers below it.
       state.scope=c.deepCount>c.count||!c.count?'collection-recursive':'collection';scope.value=state.scope;
       await load();await navigate('explore');
       message(`${c.name} 컬렉션의 문헌을 보여 줍니다.`);
      });
      row.addEventListener('click',event=>{if(event.target.closest('button,input,label'))return;open();});
      row.addEventListener('keydown',event=>{if(event.target!==row)return;if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}});
      const nameLine=node('div',null,row,{class:'sc-collection-line'});
            setIcon(node('span',null,nameLine,{class:'sc-collection-icon'}),'collections');
      node('span',c.name,nameLine,{class:'sc-collection-name',title:c.name});
      const kids=(byParent.get(c.id)||[]).length;
      /* "3편 · 하위 컬렉션 1": the count badge is the papers (with what is filed below), the sub-collections are said in words. An empty one is a dim word, not a badge. */
      if(enabled('collectionItemCount')){
       if(c.deepCount)node('span',`${c.deepCount}편`,nameLine,{class:'sc-collection-count',title:c.deepCount>c.count?T(`이 컬렉션 ${c.count}편 · 하위 컬렉션까지 ${c.deepCount}편`):''});
       else node('span',T('비어 있음'),nameLine,{class:'sc-collection-none'});
      }
      if(kids)node('span',T(`하위 컬렉션 ${kids}`),nameLine,{class:'sc-collection-kids'});
      /* The bar's length is still the collection's size; inside it, how much
         has been read -- the summary's three tones -- so a collection that was
         filed and never opened shows as one. Read off the loaded papers. */
      const barBox=node('div',null,row,{class:'sc-collection-bar','aria-hidden':'true'});
      const fill=node('span',null,barBox,{class:'sc-collection-fill'});fill.style.width='100%';
      const mix=readingMix(deepIDs(c));
      if(c.deepCount)node('span',`${mix.done}/${c.deepCount}`,row,{class:'sc-collection-ratio',title:T(`완료 ${mix.done}편 / 전체 ${c.deepCount}편`)});
      if(mix.known){
       fill.classList.add('sc-collection-mix');
       for(const key of ['done','reading','unread'])if(mix[key])node('span',null,fill,{class:'sc-overview-'+key}).style.flexGrow=String(mix[key]);
       const mixText=node('span',null,nameLine,{class:'sc-collection-mixtext'});
       const said=[mix.done&&T(`완료 ${mix.done}`),mix.reading&&T(`읽는 중 ${mix.reading}`)].filter(Boolean);
       if(said.length)mixText.appendChild(doc.createTextNode(said.join(' · ')));
       /* The unread count is itself the way to them, always in sight: the
          collection opens with 안 읽음 set, and a search or filter that would
          hide them is set aside until the scope goes back to the library. */
       if(mix.unread){
        if(said.length)mixText.appendChild(doc.createTextNode(' · '));
        const go=button(T(`안 읽음 ${mix.unread}`),()=>{
         const kept={query:state.query,status:state.status,ratingMin:state.ratingMin,yearFrom:state.yearFrom,yearTo:state.yearTo,type:state.type,tag:state.tag,...keptRules()};
         if(Object.values(kept).some(Boolean)&&!state.keptFilters)state.keptFilters=kept;
         state.query='';search.value='';for(const key of ['ratingMin','yearFrom','yearTo','type','tag'])state[key]='';state.rulesByTab={};for(const [,input] of filterInputs)input.value='';type.value='';
         state.rulesByTab={explore:[quickStatus('unread')]};
         return open();
        },mixText,{'data-writes':'cache',class:'sc-collection-unread',title:T('이 컬렉션의 안 읽은 문헌만 보기')});
        go.addEventListener('click',event=>event.stopPropagation());
       }
       if(mix.seconds)mixText.appendChild(doc.createTextNode((said.length||mix.unread?' · ':'')+(runtime.formatReadTime?runtime.formatReadTime(mix.seconds,{compact:true}):Math.round(mix.seconds/60)+'분')));
       if(mix.last)mixText.appendChild(doc.createTextNode((said.length||mix.unread||mix.seconds?' · ':'')+ago(mix.last)));
      }
      const actions=node('div',null,row,{class:'sc-collection-actions'});
      button('컬렉션 열기',open,actions,{'data-writes':'cache'});
      if(enabled('favoriteCollections'))check('즐겨찾기',favorites.includes(c.id),on=>run(async()=>{runtime.cache.favoriteCollections=on?[...new Set([...favorites,c.id])]:favorites.filter(id=>id!==c.id);runtime.dirty=true;await runtime.flush();draw();}),actions);
      if(favorites.includes(c.id))row.classList.add('sc-collection-favorite');
      walk(c.id,depth+1,group);
     }
    };
    walk('',0);
    if(!drawn){
     const none=emptyCard(list,{title:q?'검색에 맞는 컬렉션이 없습니다.':'컬렉션이 없습니다.',icon:'collections'});
     if(q)button('검색 지우기',()=>{find.value='';draw();},emptyActions(none));
    }
   }
   sort.value='name';sort.addEventListener('change',draw);
   let typing=null;find.addEventListener('input',()=>{win.clearTimeout(typing);typing=win.setTimeout(draw,120);});
   draw();
  }
  const GROUP_LABELS={citing:'이 논문을 인용한 논문',reference:'이 논문이 인용한 문헌',related:'주제가 가까운 논문'};

  // One dense row per result: what it is, then the actions, which stay out of
  // the way until the row is hovered.
  function hitRow(work,parent,decorate){
   const row=node('div',null,parent||null,{class:'sc-hit'});
   // A caller's extra lines (why it is listed, seen) come back with every redraw of the row.
   const done=()=>{decorate?.(row,work);return row;};
   if(work.doi&&!work.inLibrary){const open=node('button',work.title||'제목 없음',row,{class:'sc-hit-title sc-hit-title-link',type:'button',title:'doi.org에서 열기','data-opens':'browser'});open.addEventListener('click',()=>{try{win.Zotero.launchURL('https://doi.org/'+encodeURI(work.doi));}catch(e){message(readable(e),true);}});}
   else node('p',work.title||'제목 없음',row,{class:'sc-hit-title'});
   const meta=node('p',null,row,{class:'sc-hit-meta'});
   // The publisher mark leads the line: it is the one thing in a row of grey
   // metadata a reader recognises at a glance.
   const P=runtime.palette?.(doc);
   const mark=P&&typeof runtime.journalMarkForVenue==='function'?runtime.journalMarkForVenue(doc,work.venue,P):null;
   if(mark){mark.style.marginInlineEnd='6px';meta.appendChild(mark);}
   /* A preprint is six to twelve months ahead of the paper it becomes, and it
      used to sit in the list looking like one more journal article. */
   const preprint=work.preprint||/preprint/i.test(String(work.type||''))||/rxiv|research square|ssrn/i.test(String(work.venue||''));
   if(preprint){const chip=node('span','Preprint',meta,{class:'sc-preprint',title:'아직 심사 전 원고입니다. 정식 게재본은 나중에 따로 나올 수 있습니다.'});chip.style.marginInlineEnd='6px';}
   // Worst news first, in the row: a withdrawn paper must not read like a paper.
   const rank=Number(work.signals&&work.signals.rank)||0;
   if(rank>=1){
    const word=rank>=3?'철회':rank>=2?'우려 표명':'정정';
    const chip=node('span',word,meta,{class:'sc-signal sc-signal-'+(rank>=3?'retracted':rank>=2?'concern':'corrected'),
     title:rank>=3?'철회된 논문입니다. 인용하기 전에 철회 사유를 확인하세요.':rank>=2?'우려 표명(expression of concern)이 게시된 논문입니다.':'정정·정오표가 게시된 논문입니다.'});
    chip.style.marginInlineEnd='6px';
   }else if(work.doi&&typeof runtime.cachedIssueStatus==='function'){
    /* Only what an earlier look at this paper left in the cache: a list never asks. */
    const known=runtime.cachedIssueStatus(work.doi);
    if(known==='retracted'||known==='concern'){
     const chip=node('span',known==='retracted'?'철회':'우려',meta,{class:'sc-signal sc-signal-'+known,'data-from':'cache',
      title:known==='retracted'?'철회된 논문입니다. 인용하기 전에 철회 사유를 확인하세요.':'우려 표명(expression of concern)이 게시된 논문입니다.'});
     chip.style.marginInlineEnd='6px';
    }
   }
   /* The year and the citation count are what a reader sorts by; the journal
      and the access note are there to identify the paper. Only the first two
      take the full ink. */
   node('span',String(work.year||T('연도 미상')),meta,{class:'sc-hit-year'});
   const rest=[work.venue,work.openAccess?T('오픈액세스'):null].filter(Boolean);
   if(work.citations!=null){meta.appendChild(doc.createTextNode(' · '));node('span',T(`인용 ${work.citations}`),meta,{class:'sc-hit-cited'});}
   if(rest.length)meta.appendChild(doc.createTextNode(' · '+rest.join(' · ')));
   if(work.authors?.length)node('p',work.authors.slice(0,4).join(', ')+(work.authors.length>4?` 외 ${work.authors.length-4}명`:''),row,{class:'sc-hit-authors'});
   if(work.inLibrary){
    /* 보유 says how far it has been read, from the library already loaded:
       a paper on the shelf and a paper read are two different answers. */
    const bare=v=>String(v||'').toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//,'').trim();
    const held=work.doi?state.items.find(i=>i.doi&&bare(i.doi)===bare(work.doi)):null;
    const said=held?[T('보유'),held.status==='done'?T('완료'):held.status==='reading'?T('읽는 중'):T('안 읽음'),Number(held.seconds)>0&&runtime.formatReadTime?runtime.formatReadTime(held.seconds,{compact:true}):''].filter(Boolean).join(' · '):'보유';
    const ownedChip=node('span',said,null,{class:'sc-hit-owned'});meta.insertBefore(ownedChip,meta.firstChild);
    /* Owned was a dead end: the reader had to go and search their own
       library for it. 보기 selects it in the list behind the panel. */
    const mine=work.doi&&typeof runtime.itemForDOI==='function'?runtime.itemForDOI(work.doi):null;
    const acts=node('div',null,row,{class:'sc-hit-actions'});
    const shelf=mine||work.importedItem||null;
    if(shelf&&win.ZoteroPane?.selectItem)button('보기',()=>run(async()=>{await win.ZoteroPane.selectItem(shelf.id);message(`목록에서 선택했습니다 — ${String(shelf.getField?.('title')||work.title||'').slice(0,60)}`);}),acts,{title:'Zotero 목록에서 이 논문 선택'});
    {/* An unread paper on the shelf can be put by for reading from here, newly added or not. */
     const panelItem=held||work.importedItem||(mine?{id:String(mine.id),key:mine.key,status:runtime.state?.(mine)?.status||'unread'}:null);
     if(panelItem&&panelItem.status!=='done'&&panelItem.status!=='reading'){
      const waiting=isQueued(panelItem.id);
      button(waiting?'대기 중':'읽기 대기',()=>run(async()=>{await setReadingQueue([panelItem],!waiting);message(waiting?'읽기 대기에서 뺐습니다.':'읽기 진행의 읽기 대기에 넣었습니다.');row.replaceWith(hitRow(work,null,decorate));}),acts,{class:'sc-local-reading-queue','aria-pressed':String(waiting)});
     }}
    aroundToggle(row,acts,work);
    if(!acts.childNodes.length)acts.remove();
    return done();
   }
   const actions=node('div',null,row,{class:'sc-hit-actions'});
   if(!work.doi&&!work.inLibrary&&typeof runtime.Z?.ZotPoP?.openSearch==='function')button('ZotPoP에서 찾기',()=>runtime.Z.ZotPoP.openSearch(win,{title:work.title||'',year:work.year||''}),actions,{'data-opens':'window'});
   if(work.doi)button(importLabel(),()=>run(async()=>{
    const saved=await importHere(work);
    // The row is stale once the paper is in: redraw it in place as owned, with 읽기 대기 on offer.
    work.inLibrary=true;work.importedItem=ownedRecord(saved,work);
    const fresh=hitRow(work,null,decorate);row.replaceWith(fresh);
   }),actions,{'data-writes':'library',title:importTip()});
   if(work.doi)button('DOI',()=>copy(work.doi),actions);
   if(work.pdfURL)button('PDF',()=>win.Zotero.launchURL(work.pdfURL),actions,{'data-opens':'browser'});
   aroundToggle(row,actions,work);
   return done();
  }

  /* 이 논문 주변: what happened around a paper after it was published --
     corrections, retractions and comments (Crossref, Europe PMC), and the
     reactions to it (Bluesky, Hacker News, Wikipedia, Altmetric with the
     reader's own key). Asked for the paper being looked at, never for a list,
     abandoned when the reader moves on, and kept by the runtime per DOI. An
     answer that could not be had is said so; it never reads as a clean bill. */
  const aroundRuns=new Set();
  function abortAround(){for(const c of aroundRuns){try{c.abort?.();}catch(_){}}aroundRuns.clear();}
  const ISSUE_KIND={correction:'정정',retraction:'철회',withdrawal:'철회(저자)','expression-of-concern':'우려 표명',erratum:'정오표'};
  const ISSUE_STATUS={retracted:'철회됨',concern:'우려 표명',corrected:'정정 있음'};
  const AROUND_EVENTS=6;
  const safeURL=url=>/^https?:\/\//i.test(String(url||''))?String(url):'';
  const dayOf=value=>String(value||'').slice(0,10);
  // External text (a post, a headline) is shown as text, never as the panel's own markup.
  const ext=(tag,text,parent,attrs={})=>{const n=doc.createElementNS(HTML,tag);n.textContent=String(text==null?'':text);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));parent?.appendChild(n);return n;};
  function drawAround(parent,source,{open=false,onToggle}={}){
   const box=node('div',null,parent,{class:'sc-around',role:'region','aria-label':'이 논문 주변'});
   const bar=node('div',null,box,{class:'sc-around-bar'});
   /* One line by default: the title, how the notices stand, and the counts of
      reactions. Pressing it opens the two groups below. */
   const head=node('button',null,bar,{type:'button',class:'sc-around-summary','aria-expanded':String(!!open)});
   node('span','이 논문 주변',head,{class:'sc-around-title'});
   const chips=node('span',null,head,{class:'sc-around-chips'});
   const chevron=node('span',null,head,{class:'sc-around-chevron','aria-hidden':'true'});
   const detail=node('div',null,box,{class:'sc-around-detail'});
   detail.hidden=!open;
   const heads=[];
   const pane=label=>{const g=node('section',null,detail,{class:'sc-group sc-around-group'});heads.push(sectionHead(label,null,g));return node('div',null,g,{class:'sc-around-body'});};
   const issuesBox=pane('이슈 경과'),reactionsBox=pane('SNS·웹 반응'),issuesHead=heads[0];
   let controller=null,seq=0;
   const summary={issues:'loading',reactions:'loading'};
   function paintSummary(){
    chips.replaceChildren();
    const {issues,reactions}=summary;
    if(issues==='loading'&&reactions==='loading'){node('span','확인 중…',chips,{class:'sc-muted sc-around-chip-note'});return;}
    if(issues==='loading')node('span','확인 중…',chips,{class:'sc-muted sc-around-chip-note'});
    else if(issues==='error')node('span','확인 못함',chips,{class:'sc-around-chip','data-status':'unknown'});
    else{
     const status=issues.summary?.status||'unknown';
     node('span',ISSUE_STATUS[status]||(status==='notice'?'공지 문헌':status==='clean'?'정정·철회 없음':'확인 못함'),chips,{class:'sc-around-chip','data-status':status});
    }
    if(reactions==='loading')return;
    if(reactions==='error'||reactions.allFailed){node('span','반응 확인 못함',chips,{class:'sc-muted sc-around-chip-note'});return;}
    if(reactions.reason==='no-doi')return;
    const counts=[['Bluesky',reactions.bluesky?.count],['Hacker News',reactions.hackerNews?.count],['Wikipedia',reactions.wikipedia?.count]].filter(([,n])=>n>0);
    if(reactions.altmetric&&Number(reactions.altmetric.score)>0)counts.push(['Altmetric',Math.round(Number(reactions.altmetric.score))]);
    if(!counts.length)node('span','반응 없음',chips,{class:'sc-muted sc-around-chip-note'});
    for(const[name,n]of counts){const chip=node('span',name+' ',chips,{class:'sc-around-badge'});node('b',String(n),chip);}
   }
   function setOpen(value){
    detail.hidden=!value;head.setAttribute('aria-expanded',String(value));
   }
   head.addEventListener('click',()=>{const next=detail.hidden;setOpen(next);try{onToggle?.(next);}catch(_){}});
   paintSummary();
   const note=(parentEl,text,cls='')=>node('p',text,parentEl,{class:'sc-muted sc-around-note'+(cls?' '+cls:'')});
   function paintIssues(res){
    const summary=res?.summary||{},status=summary.status||'unknown',failed=Array.isArray(summary.failed)?summary.failed:[];
    const checked=dayOf(summary.checked),line=node('div',null,issuesBox,{class:'sc-around-statusline'});
    let said;
    if(ISSUE_STATUS[status])said=ISSUE_STATUS[status];
    else if(status==='notice')said=T('다른 논문에 대한 정정·철회 공지입니다');
    else if(status==='clean')said=T('알려진 정정·철회 없음')+(checked?' · '+T(`${checked} 확인`):'');
    else said=T('확인 못함')+(failed.length?' ('+T(`${failed.join(', ')} 응답 없음`)+')':summary.reason==='no-doi'?' ('+T('DOI 없음')+')':'');
    ext('span',said,line,{class:'sc-around-status','data-status':status,role:'status'});
    if(ISSUE_STATUS[status]&&checked)node('span',T(`${checked} 확인`),line,{class:'sc-muted sc-around-date'});
    const events=Array.isArray(res?.events)?res.events:[];
    if(events.length){
     const list=node('ol',null,issuesBox,{class:'sc-around-timeline'});
     const draw=event=>{
      const row=node('li',null,list,{class:'sc-around-row','data-kind':event.kind});
      node('span',event.date?dayOf(event.date):T('날짜 미상'),row,{class:'sc-around-when'});
      const name=event.kind==='comment'?T(`코멘트 ${event.count||1}건`):T(ISSUE_KIND[event.kind]||'정정');
      const target=safeURL(event.url);
      if(target){const b=node('button',null,row,{type:'button',class:'sc-around-link','data-opens':'browser',title:target});b.textContent=name;b.addEventListener('click',()=>{try{win.Zotero.launchURL(target);}catch(_){}});}
      else ext('span',name,row,{class:'sc-around-kind'});
      ext('span',[event.source,event.via].filter(Boolean).join(' · '),row,{class:'sc-muted sc-around-src'});
     };
     events.slice(0,AROUND_EVENTS).forEach(draw);
     if(events.length>AROUND_EVENTS){const more=viewButton(T(`더 보기 · ${events.length-AROUND_EVENTS}건`),()=>{more.remove();events.slice(AROUND_EVENTS).forEach(draw);},issuesBox,{class:'sc-quiet-action'});}
    }
    if(status!=='unknown'&&failed.length)note(issuesBox,T(`응답 없음: ${failed.join(', ')}`));
    const peer=source.doi?'https://pubpeer.com/search?q='+encodeURIComponent(String(source.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i,'').toLowerCase()):'';
    issuesHead.querySelector('.sc-section-head-actions')?.remove();
    if(peer){const acts=node('span',null,issuesHead,{class:'sc-section-head-actions'});const b=node('button','PubPeer에서 보기',acts,{type:'button',class:'sc-quiet-action','data-opens':'browser'});b.addEventListener('click',()=>{try{win.Zotero.launchURL(peer);}catch(_){}});}
   }
   function paintReactions(res){
    const checked=dayOf(res?.checked),failed=Array.isArray(res?.failed)?res.failed:[];
    if(res?.reason==='no-doi'){note(reactionsBox,'DOI가 없어 반응을 찾을 수 없습니다');return;}
    if(res?.allFailed){note(reactionsBox,T('확인 못함')+' ('+T(`${failed.join(', ')} 응답 없음`)+')');return;}
    const bsky=res?.bluesky||{count:0,top:[]},hn=res?.hackerNews||{count:0,top:[]},wiki=res?.wikipedia||{count:0,articles:[]},alt=res?.altmetric;
    const counts=[['Bluesky',bsky.count],['Hacker News',hn.count],['Wikipedia',wiki.count]].filter(([,n])=>n>0);
    if(alt&&Number(alt.score)>0)counts.push(['Altmetric',Math.round(Number(alt.score))]);
    if(!counts.length){note(reactionsBox,T('찾은 반응 없음')+(checked?' · '+T(`${checked} 확인`):''));}
    else{
     const badges=node('div',null,reactionsBox,{class:'sc-around-badges'});
     for(const[name,n]of counts){const chip=node('span',name+' ',badges,{class:'sc-around-badge'});node('b',String(n),chip);}
    }
    const hidden=[];
    const link=(url,parentEl,label)=>{const target=safeURL(url);if(!target)return;const b=node('button',label,parentEl,{type:'button',class:'sc-quiet-action','data-opens':'browser',title:target});b.addEventListener('click',()=>{try{win.Zotero.launchURL(target);}catch(_){}});};
    /* One card template for every source: who and when, the text, then the figures with their outline icons and the link. */
    const stat=(parentEl,icon,value,label)=>{const span=node('span',null,parentEl,{class:'sc-around-stat',title:label,'aria-label':label});const mark=node('span',null,span,{class:'sc-around-stat-icon','aria-hidden':'true'});setIcon(mark,icon);const svg=mark.firstChild;if(svg){svg.setAttribute('width','14');svg.setAttribute('height','14');}node('span',fmtN(value),span);return span;};
    const card=(source,who,date,text,parentEl)=>{
     const c=node('article',null,parentEl,{class:'sc-around-card','data-source':source});
     const head=node('p',null,c,{class:'sc-around-card-head'});
     ext('span',who,head,{class:'sc-around-author'});
     if(date)ext('span',' · '+dayOf(date),head,{class:'sc-muted'});
     ext('p',text,c,{class:'sc-around-text'});
     return node('div',null,c,{class:'sc-around-card-foot'});
    };
    const post=(p,parentEl)=>{
     const foot=card('bluesky',p.author||p.handle||'Bluesky',p.date,p.text,parentEl);
     const stats=node('span',null,foot,{class:'sc-around-stats'});
     stat(stats,'like',p.likes||0,T(`좋아요 ${p.likes||0}`));stat(stats,'repost',p.reposts||0,T(`리포스트 ${p.reposts||0}`));
     link(p.url,foot,'Bluesky에서 보기');
    };
    const story=(h,parentEl)=>{
     const foot=card('hackernews','Hacker News',h.date,h.title,parentEl);
     const stats=node('span',null,foot,{class:'sc-around-stats'});
     stat(stats,'like',h.points||0,T(`추천 ${h.points||0}`));stat(stats,'comment',h.comments||0,T(`댓글 ${h.comments||0}`));
     link(h.url,foot,'Hacker News에서 보기');
    };
    const posts=Array.isArray(bsky.top)?bsky.top:[],stories=Array.isArray(hn.top)?hn.top:[],articles=Array.isArray(wiki.articles)?wiki.articles:[];
    if(posts.length||stories.length){
     const cards=node('div',null,reactionsBox,{class:'sc-around-cards'});
     posts.slice(0,3).forEach(p=>post(p,cards));
     stories.slice(0,1).forEach(h=>story(h,cards));
    }
    const rest=posts.slice(3).length+stories.slice(1).length+articles.length;
    if(rest){
     const more=viewButton(T(`더 보기 · ${rest}건`),()=>{
      more.remove();
      let cards=reactionsBox.querySelector('.sc-around-cards');if(!cards)cards=node('div',null,reactionsBox,{class:'sc-around-cards'});
      posts.slice(3).forEach(p=>post(p,cards));stories.slice(1).forEach(h=>story(h,cards));
      if(articles.length){
       const wl=node('div',null,reactionsBox,{class:'sc-around-wiki'});
       node('p','Wikipedia 문서',wl,{class:'sc-muted sc-around-note'});
       for(const a of articles){const r=node('div',null,wl,{class:'sc-around-row'});link(a.url,r,a.title||'Wikipedia');}
      }
     },reactionsBox,{class:'sc-quiet-action'});
    }
    if(failed.length)note(reactionsBox,T(`응답 없음: ${failed.join(', ')}`));
   }
   async function load(force=false){
    if(controller){aroundRuns.delete(controller);try{controller.abort?.();}catch(_){}}
    const mine=++seq;
    controller=typeof win.AbortController==='function'?new win.AbortController():typeof AbortController==='function'?new AbortController():null;
    if(controller)aroundRuns.add(controller);
    const signal=controller?.signal,live=()=>mine===seq&&!disposed&&!signal?.aborted;
    const ask=(which,target,fn,paint,waiting)=>{
     target.replaceChildren();target.setAttribute('aria-busy','true');
     node('p',waiting,target,{class:'sc-muted sc-around-loading',role:'status'});
     summary[which]='loading';paintSummary();
     return Promise.resolve().then(()=>fn({signal,force})).then(result=>{
      if(!live())return;target.replaceChildren();target.removeAttribute('aria-busy');paint(result);summary[which]=result||'error';paintSummary();
     },error=>{
      if(!live()||error?.name==='AbortError')return;
      target.replaceChildren();target.removeAttribute('aria-busy');note(target,'확인하지 못했습니다 — 다시 확인을 눌러 보세요');summary[which]='error';paintSummary();
     });
    };
    await Promise.all([ask('issues',issuesBox,source.issues,paintIssues,'이슈 경과를 확인하는 중…'),ask('reactions',reactionsBox,source.reactions,paintReactions,'SNS·웹 반응을 찾는 중…')]);
   }
   button('다시 확인',()=>load(true),bar,{class:'sc-quiet-action'});
   run(()=>load(false));
   return {box,destroy(){seq++;if(controller){aroundRuns.delete(controller);try{controller.abort?.();}catch(_){}}box.remove();}};
  }
  // A paper known only by its DOI -- a row in a list of related works.
  function aroundSource(doi,urls=[]){
   return {doi,issues:o=>runtime.doiIssues(doi,o),reactions:o=>runtime.doiReactions(doi,urls,o)};
  }
  /* Only one row is open at a time: opening another closes the first and
     abandons its request. */
  let aroundRow=null;
  function closeAroundRow(){
   if(!aroundRow)return;
   const {row,toggle,handle}=aroundRow;aroundRow=null;
   handle.destroy();toggle.setAttribute('aria-expanded','false');row.removeAttribute('data-around');
  }
  function aroundToggle(row,actions,work){
   if(typeof runtime.doiIssues!=='function'||typeof runtime.doiReactions!=='function')return null;
   const toggle=node('button','주변 보기',actions,{type:'button',class:'sc-hit-around','aria-expanded':'false'});
   if(!work.doi){toggle.disabled=true;toggle.title=T('DOI가 없어 확인할 수 없습니다');return toggle;}
   toggle.title=T('정정·철회와 SNS 반응을 이 논문에 대해서만 찾아봅니다');
   toggle.addEventListener('click',()=>{
    const was=aroundRow&&aroundRow.row===row;
    closeAroundRow();
    if(was)return;
    // Beside the row, not inside it: a row's own grid has columns of its own.
    const handle=drawAround(row.parentNode,aroundSource(work.doi,[work.url].filter(Boolean)),{open:true});handle.box.classList.add('sc-around-inline');row.after(handle.box);
    aroundRow={row,toggle,handle};
    toggle.setAttribute('aria-expanded','true');row.setAttribute('data-around','open');
   });
   return toggle;
  }

  function hitList(works,parent){
   const list=node('div',null,parent,{class:'sc-hits'});
   for(const work of works)hitRow(work,list);
   return list;
  }

  const PATH_LABELS={overview:'개관',foundation:'기초',predecessor:'직계 선행연구',primary:'원논문',seed:'이 논문',continuation:'후속 연구',uses:'이 방법을 쓴 연구',tools:'방법·도구'};
  const PATH_NOTES={
   overview:'분야 전체를 먼저 잡아 주는 리뷰 — 여기서 시작하세요',
   foundation:'참고문헌 여러 편이 공통으로 인용한 논문 — 이 분야가 전제로 깔고 있는 연구',
   predecessor:'이 논문과 참고문헌을 많이 공유하는 선행연구 — 같은 문제를 먼저 다룬 논문',
   seed:'위 단계를 읽고 나면 이 논문이 무엇을 보탰는지 보입니다',
   primary:'이 리뷰의 참고문헌들이 가장 많이 인용한 원논문',
   continuation:'이 논문을 인용하고 같은 선행연구 줄기를 잇는 논문 — 실제로 이어 받은 연구',
   uses:'이 방법을 쓴 연구 가운데 선행연구를 가장 많이 공유하는 논문',
   tools:'널리 쓰이는 방법·도구·교재 — 순서대로 읽을 필요 없이 필요할 때 찾아보세요'};
  /* The heading line takes the short form -- clipping the long one mid-word was
     worse than not printing it -- and the full sentence stays in the full path. */
  const PATH_NOTES_SHORT={
   overview:'분야 전체를 먼저 잡아 주는 리뷰',
   foundation:'참고문헌 여러 편이 공통으로 인용한 논문',
   predecessor:'참고문헌을 많이 공유하는 선행연구',
   seed:'위 단계를 읽고 나면 무엇을 보탰는지 보입니다',
   primary:'참고문헌들이 가장 많이 인용한 원논문',
   continuation:'이 논문을 이어 받은 연구',
   uses:'이 방법을 쓴 연구',
   tools:'필요할 때 찾아보는 방법·도구'};
  const GROUP_NOTES={citing:'이 논문 이후에 나온 논문 중 이 논문을 참고문헌에 올린 것 — 후속 연구',reference:'이 논문이 참고문헌으로 든 문헌 — 바탕이 된 연구',related:'참고문헌을 많이 공유하거나 OpenAlex가 주제를 가깝게 본 논문 — 옆 연구'};
  /* 새로 나온 관련 논문: what has been published in the last ninety days on top
     of the shelf the panel is already showing, most of the shelf first.

     This is the question a reading list cannot answer about itself, and the
     reason for a journal alert in another window. It is cheap enough to ask
     from here: OpenAlex ORs fifty of the reader's own papers into one `cites:`
     filter, so a collection is one request -- this library's seven largest
     collections together came to 0.0009 of the daily dollar.

     Ranked by how many of the reader's own papers each new one cites, because
     that is what separates a paper about their corner of the field from one
     that merely used a method everybody uses. The row says which held papers
     it stands on, so the claim can be checked rather than believed. */
  const FRESH_DAYS=90;
  async function drawFreshCiters(token,head){
   const shelf=scoped();
   const works=typeof runtime.paperWorks==='function'?runtime.paperWorks():{};
   const seedOf=p=>String((works[p.libraryID+':'+p.key]||works[String(p.id)]||{}).openalex||'').split('/').pop().toUpperCase();
   const seeds=new Set();let noWork=0;
   for(const paper of shelf){const id=seedOf(paper);if(/^W\d+$/.test(id))seeds.add(id);else noWork++;}
   const key=`${state.libraryID||''}:${state.scope}:${shelfKey(shelf)}`;
   const saved=typeof runtime.freshCiterStore==='function'?runtime.freshCiterStore()[key]:null;
   // A stored answer is shown at any age, dated; only 다시 확인 asks again.
   const kept=saved&&saved.days===FRESH_DAYS?saved:null;
   const list=node('div',null,body);
   /* How much of the shelf could not be asked about. "Nothing new" and "most
      of this was never asked" are different answers and only one of them is
      reassurance, so the gap is said wherever the answer is. */
   const gapLine=(parent,missing=noWork)=>{
    if(!missing)return;
    const line=node('p',T(`이 범위 ${missing}편은 OpenAlex 기록이 없어 묻지 못했습니다.`),parent,{class:'sc-muted sc-path-note'});
    button('관계 그래프에서 채우기',()=>run(async()=>{await navigate('graph');}),line,{class:'sc-path-jump'});
   };
   const draw=report=>{
    list.replaceChildren();
    const all=report.rows||[];
    const at=Date.parse(report.at),gone=Number.isFinite(at)?Math.max(0,Math.floor((Date.now()-at)/864e5)):0;
    const checked=gone?T(`${gone}일 전 확인`):T('오늘 확인');
    const view=state.freshSeen||'new';
    const unseen=all.filter(w=>!isSeen({key:seenWorkKey(w)})).length;
    const rows=all.filter(w=>view==='all'||(view==='seen')===isSeen({key:seenWorkKey(w)}));
    message(all.length?T(`새 논문 ${all.length}편 · 최근 ${report.days}일 · 내 문헌 ${report.seeds}편 기준`)
     :T(`최근 ${report.days}일 사이 이 범위를 인용한 새 논문이 없습니다.`));
    if(!all.length){
     const box=node('div',null,list,{class:'sc-empty'});
     node('p',T(`최근 ${report.days}일 사이 이 범위의 문헌을 인용한 새 논문이 없습니다.`),box);
     node('p',checked,box,{class:'sc-muted'});
     gapLine(box,report.noWork);
     return;
    }
    const heading=sectionHead('새로 나온 관련 논문',all.length,list);
    node('span',T(`최근 ${report.days}일 · ${checked}`),heading,{class:'sc-path-head-note'});
    node('p','이 범위의 문헌을 인용한 새 논문입니다. 내 문헌을 많이 인용한 순서입니다.',list,{class:'sc-muted sc-hit-group-note'});
    gapLine(list,report.noWork);
    if(report.truncated)node('p','인용한 논문이 더 있어 최근 것부터 보여 줍니다.',list,{class:'sc-muted sc-path-note'});
    // The same switch and the same store as 저자 추적's inbox: seen in one is seen in both.
    const tools=node('div',null,list,{class:'sc-inbox-tools'});
    const views=node('div',null,tools,{class:'sc-segmented',role:'group','aria-label':T('새 논문 보기')});
    for(const [key,label,count] of [['new','미확인',unseen],['seen','확인함',all.length-unseen],['all','전체',all.length]])
     withCount(button('',()=>{state.freshSeen=key;state.freshLimit=0;draw(report);},views,{'aria-pressed':String(view===key)}),label,count);
    node('span',T('↑↓ 이동 · e 확인함'),tools,{class:'sc-muted sc-inbox-hint'});
    const box=node('div',null,list,{class:'sc-hits'});inboxKeys(box);
    const limit=state.freshLimit||12;
    /* Why this paper is here goes directly under its title, as it does in the
       reading order: above the year and journal, which identify the paper
       rather than justify it. Redrawn with the row, so 추가 does not lose it. */
    const decorate=(row,work)=>{
     const why=node('p',null,null,{class:'sc-path-why'});
     row.insertBefore(why,row.querySelector('.sc-hit-meta'));
     node('b',T(`내 서재 ${work.shared}편 인용`),why);
     const named=(work.citedTitles||[]).filter(Boolean);
     if(named.length)why.appendChild(doc.createTextNode(' · '+named[0]+(named.length>1?' '+T(`외 ${named.length-1}편`):'')));
     const entry={key:seenWorkKey(work)},seen=isSeen(entry);
     row.dataset.seen=String(seen);
     const acts=row.querySelector('.sc-hit-actions')||node('div',null,row,{class:'sc-hit-actions'});
     button(seen?'되돌리기':'확인함',()=>run(async()=>{
      // The next paper's button takes the focus (in 전체 the row stays, so one on).
      const index=[...row.parentNode.children].indexOf(row),at=view==='all'?index+1:index;
      await setSeen(entry,!seen);
      if(disposed||state.tab!=='related'||state.relatedView!=='fresh')return;
      draw(report);
      const buttons=[...body.querySelectorAll('.sc-hits .sc-inbox-seen')];
      (buttons[Math.max(0,at)]||buttons[buttons.length-1]||body.querySelector('.sc-inbox-tools [aria-pressed="true"]'))?.focus?.();
     }),acts,{class:'sc-inbox-seen',title:T(seen?'미확인으로 되돌립니다':'이 논문을 확인한 것으로 두고 목록에서 뺍니다')});
    };
    if(!rows.length)node('p',T(view==='new'?'확인하지 않은 새 논문이 없습니다.':'확인한 새 논문이 없습니다.'),box,{class:'sc-muted sc-inbox-empty'});
    for(const work of rows.slice(0,limit))hitRow(work,box,decorate);
    if(rows.length>limit){
     const more=bar(list);
     node('span',T(`${rows.length}편 중 ${limit}편`),more,{class:'sc-muted'});
     viewButton(T(`${rows.length}편 모두 보기`),()=>{state.freshLimit=rows.length;render();},more);
    }
   };
   const ask=async({refresh=false}={})=>{
    freshAbort?.abort?.();
    const controller=typeof win.AbortController==='function'?new win.AbortController():typeof AbortController==='function'?new AbortController():null;
    freshAbort=controller;
    const current=()=>token===epoch&&!disposed&&state.tab==='related';
    message('OpenAlex에서 새 논문을 찾는 중…');
    list.replaceChildren();
    node('p','OpenAlex에서 새 논문을 찾는 중…',list,{class:'sc-muted sc-path-note',role:'status'});
    let report;
    try{
     report=await runtime.freshCitersCached(key,shelf.map(p=>runtime.Z.Items.get(Number(p.id))).filter(Boolean),
      {days:FRESH_DAYS,refresh,signal:controller?.signal,onProgress:(done,total)=>{
       if(!current()){controller?.abort?.();return;}
       if(total>1)message(T(`OpenAlex에서 새 논문을 찾는 중… ${done+1}/${total}`));
      }});
    }catch(error){
     if(!current()||controller?.signal?.aborted)return;
     list.replaceChildren();
     throw error;
    }
    if(!current())return;
    draw(report);
    /* A spent budget is said once, under the answer, and the partial answer
       above it is honest about being partial rather than being kept. */
    if(report.budgetGone)node('p','OpenAlex 하루 한도를 다 썼습니다. 한국 시간 오전 9시에 초기화되니 그때 다시 확인하세요.',list,{class:'sc-muted sc-path-note'});
    else if(report.partial)node('p','일부 조회가 실패해 결과를 저장하지 않았습니다. 다시 확인을 눌러 주세요.',list,{class:'sc-muted sc-path-note'});
   };
   button('다시 확인',()=>run(()=>ask({refresh:true})),head,{class:'sc-quiet-action'});
   if(!seeds.size){
    const box=node('div',null,list,{class:'sc-empty'});
    node('p','이 범위에는 OpenAlex에서 확인한 문헌이 없어 새 논문을 찾을 수 없습니다. 관계 그래프 탭에서 인용 목록을 먼저 가져오세요.',box);
    button('관계 그래프 열기',()=>run(async()=>{await navigate('graph');}),bar(box),{'data-variant':'primary'});
    return;
   }
   if(kept){draw(kept);return;}
   /* Not asked yet. Every other metered lookup here says what it will spend
      before it is pressed, and this one can: the shelf is fifty papers per
      request, and that number is known without asking anything. */
   const requests=Math.ceil(seeds.size/50)*3;
   const intro=node('div',null,list,{class:'sc-guide'});
   node('h2','새로 나온 관련 논문',intro);
   node('p',T(`이 범위의 문헌 ${seeds.size}편을 인용한 최근 ${FRESH_DAYS}일 논문을 OpenAlex에서 찾습니다. 내 문헌을 많이 인용한 순서로 보여 줍니다.`),intro);
   gapLine(intro);
   button(T(`새 논문 찾기 · OpenAlex (요청 최대 ${requests}회)`),()=>run(()=>ask()),bar(intro),{'data-variant':'primary'});
  }

  /* One shelf, named the same way twice running, so a saved answer is found
     again and a shelf that has gained a paper asks afresh. */
  function shelfKey(items){
   let hash=2166136261;
   for(const id of items.map(i=>String(i.id)).sort()){
    for(let at=0;at<id.length;at++){hash^=id.charCodeAt(at);hash=Math.imul(hash,16777619);}
   }
   return items.length+'-'+(hash>>>0).toString(36);
  }
  async function drawRelated(token){
   let item=null;try{item=one();}catch(_){item=null;}
   const canPath=typeof runtime.readingPathCached==='function';
   const canFresh=typeof runtime.freshCitersCached==='function';
   if(!state.relatedView)state.relatedView=['list','line','fresh'].includes(ui.relatedView)?ui.relatedView:'path';
   if(!state.pathDepth)state.pathDepth=ui.pathDepth==='full'?'full':'min';
   /* 새 논문 asks about the shelf the panel is already showing, not about one
      paper, so it is the one view here that answers with nothing selected --
      and the tab, which used to be a page of instructions until a paper was
      picked, now opens on something to read. */
   const scopeView=canFresh&&state.relatedView==='fresh';
   const view=scopeView?'fresh':!item?null:canPath?(state.relatedView==='fresh'?'path':state.relatedView):'list';
   const head=bar();
   if(canPath||canFresh){
    const modes=node('div',null,head,{class:'sc-segmented',role:'group','aria-label':'관련 논문 보기'});
    for(const[key,label]of [['path','읽기 순서'],['line','발전 과정'],['list','전체 목록'],['fresh','새 논문']]){
     if(key==='fresh'?!canFresh:key!=='list'&&!canPath)continue;
     const press=viewButton(label,()=>run(async()=>{state.relatedView=key;await saveUI({relatedView:key});await render();body.querySelector('.sc-segmented [aria-pressed="true"]')?.focus?.();}),modes,{'aria-pressed':String((view||(item?null:state.relatedView==='fresh'?'path':state.relatedView))===key)});
     // The three per-paper views need a paper; saying so on the control beats
     // letting it answer with the same guide every time.
     if(key!=='fresh'&&!item){press.disabled=true;press.title=T('문헌을 하나 고르면 볼 수 있습니다');}
    }
   }
   if(scopeView){await drawFreshCiters(token,head);return;}
   if(!item){
    /* Nothing selected: say what the tab will do and how to start, instead
       of a single line that read as an error. */
    const guide=emptyCard(body,{title:'문헌을 하나 고르세요.',hint:'참고문헌과 인용 관계를 분석해 무엇을 어떤 순서로 읽을지 짜 드립니다: 개관 → 기초 → 직계 선행연구 → 이 논문 → 후속 연구.'});
    const tiers=node('ul',null,guide,{class:'sc-empty-tiers'});
    for(const [key,label,icon] of [['citing',GROUP_LABELS.citing,'recent'],['reference',GROUP_LABELS.reference,'backlinks'],['related',GROUP_LABELS.related,'related']]){
     const li=node('li',null,tiers);const mark=node('span',null,li,{class:'sc-empty-tier-icon','aria-hidden':'true'});setIcon(mark,icon);
     node('strong',label,li);node('span',T(GROUP_NOTES[key]),li,{class:'sc-empty-tier-note'});
    }
    node('span',T('보유하지 않은 논문은 행의 버튼으로 ZotPoP에서 바로 찾거나 가져올 수 있습니다.'),guide,{class:'sc-empty-hint'});
    const chosen=selected();
    if(chosen.length>1){node('span',`선택한 ${chosen.length}편 중 하나를 고르세요`,guide,{class:'sc-empty-hint'});const pickBar=emptyActions(guide);for(const it of chosen.slice(0,12))button(it.title,()=>{state.selected=new Set([String(it.id)]);render();},pickBar);}
    const acts=emptyActions(guide);
    button('현재 선택 가져오기',()=>{state.selected=new Set(runtime.selected(win).map(i=>String(i.id)));render();},acts);
    button('보유 문헌에서 고르기',()=>navigate('explore'),acts);
    return;
   }
   /* The paper's name is already on the line above, in the context bar; a
      second copy of it pushed the order itself below the fold. The views
      themselves are chosen above, on the one control that also holds 새 논문. */
   const b=head;
   // The paper's own surroundings, asked for once it is the one in focus.
   if(typeof runtime.paperIssues==='function'&&typeof runtime.paperReactions==='function'){
    const ref=runtime.Z.Items.get(Number(item.id));
    drawAround(node('div',null,body,{class:'sc-around-host'}),{doi:item.doi,
     issues:o=>runtime.paperIssues(ref,o),reactions:o=>runtime.paperReactions(ref,o)},
     {open:runtime.cache.workbenchUI?.aroundOpen===true,onToggle:value=>saveUI({aroundOpen:value})});
   }
   const list=node('div',null,body);
   async function path({refresh=false}={}){
    const ref=runtime.Z.Items.get(Number(item.id));
    if(refresh){if(typeof runtime.forgetReadingPath==='function')runtime.forgetReadingPath(ref);else runtime.discoverCache.delete('path:'+runtime.identity(ref));}
    // A lookup for a paper the user has left is stopped, not left running up
    // the OpenAlex budget in the background.
    pathAbort?.abort?.();
    const controller=typeof win.AbortController==='function'?new win.AbortController():typeof AbortController==='function'?new AbortController():null;
    pathAbort=controller;
    const current=()=>token===epoch&&!disposed&&state.tab==='related';
    message('참고문헌과 인용 관계로 읽기 순서를 짜는 중…');
    if(list.childElementCount)list.setAttribute('aria-busy','true');
    else node('p','참고문헌과 인용 관계로 읽기 순서를 짜는 중…',list,{class:'sc-muted sc-path-note',role:'status'});
    let plan;
    try{
     plan=await runtime.readingPathCached(ref,{signal:controller?.signal,onProgress:(done,total)=>{
      if(!current()){controller?.abort?.();return;}
      message(`OpenAlex에서 참고문헌과 인용 관계를 읽는 중… ${done}/${total}`);
     }});
    }catch(error){
     // An error from a lookup the user has already left belongs to nobody.
     if(!current()||controller?.signal?.aborted)return;
     list.removeAttribute('aria-busy');
     list.querySelector('[role=status]')?.remove();
     throw error;
    }
    if(!current())return;
    list.replaceChildren();
    list.removeAttribute('aria-busy');
    if(!plan){message('이 논문을 OpenAlex에서 찾지 못했습니다. DOI를 확인한 뒤 다시 찾으세요.',true);return;}
    drawPath(plan);
   }
   /* Two depths. The short path is what a reader acts on: where to start, two
      foundations, two predecessors, the paper, one continuation -- about seven
      rows, the rest one click away. The full path is every section with its
      tail. Papers already owned read as "보유" and are not steps: there is
      nothing to fetch, and counting them hid the ones that are missing. */
   const MIN_QUOTA={overview:1,foundation:2,predecessor:2,primary:4,seed:1,continuation:1,uses:1};
   function drawPath(plan){
    list.replaceChildren();
    const depth=state.pathDepth||(ui.pathDepth==='full'?'full':'min');
    const short=depth==='min';
    list.classList.add('sc-path-list');list.dataset.depth=depth;
    const owned=typeof runtime.libraryDOIs==='function'?runtime.libraryDOIs():null;
    // The paper itself is in the library by definition, even when it was found
    // by title and its DOI is not on the item: it must never offer "추가".
    const own=work=>{if(work.seed){work.inLibrary=true;return;}if(owned&&work.doi)work.inLibrary=owned.has(String(work.doi).toLowerCase());
     /* Owned is not read. A paper saved and never opened keeps its number, its
        reason and its "먼저" links; only one marked 완료 folds away. */
     const mine=work.inLibrary&&work.doi?localByDOI.get(String(work.doi).toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//,'')):null;
     work.local=mine||null;work.readDone=!!mine&&mine.status==='done';};
    const localByDOI=new Map(state.items.filter(i=>i.doi).map(i=>[String(i.doi).toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//,''),i]));
    const settled=work=>!!work.inLibrary&&!!work.readDone;
    const steps=(plan.steps||[]).map(step=>({...step,works:step.works||[],more:step.more||[]}));
    const rest=plan.rest||[];
    for(const step of steps)for(const work of [...step.works,...step.more])own(work);
    const planStart=steps.flatMap(step=>step.works).find(work=>work.start);
    // What each section shows at this depth. The short path keeps its quota of
    // rows still to fetch; owned rows met on the way are shown but not counted.
    const shown=new Map();
    for(const step of steps){
     if(step.key==='tools')continue;
     if(!short){shown.set(step.key,step.works);continue;}
     // Chosen by importance, shown in reading order.
     const order=[...step.works,...step.more];
     let pool=[...order].sort((a,b)=>(a.rank??99)-(b.rank??99));
     if(step.key==='continuation'||step.key==='uses'){
      pool=[...pool].sort((a,b)=>(b.shared||0)-(a.shared||0));
      // One continuation is a claim: a preprint from last month with nothing
      // in common but the citation does not get to make it.
      const solid=pool.filter(w=>(w.shared||0)>=5||(w.citations||0)>=5);
      if(solid.length)pool=solid;
     }
     // The overview earns a place in the short path only as the start.
     if(step.key==='overview'){if(planStart&&pool.includes(planStart))shown.set(step.key,[planStart]);continue;}
     const out=[];let unowned=0;const quota=MIN_QUOTA[step.key]??1;
     for(const work of pool){
      if(unowned>=quota)break;
      out.push(work);
      if(!settled(work)||work.seed)unowned++;
     }
     if(planStart&&pool.includes(planStart)&&!out.includes(planStart))out.unshift(planStart);
     if(out.length)shown.set(step.key,step.key==='continuation'||step.key==='uses'?out.sort((a,b)=>(a.year||0)-(b.year||0)):out.sort((a,b)=>order.indexOf(a)-order.indexOf(b)));
    }
    /* A short-path row that stands on a hidden one brings it along -- at most
       two -- rather than losing the "read first" silently. */
    if(short){
     const byID=new Map(steps.flatMap(step=>[...step.works,...step.more].map(work=>[work.id,[work,step.key]])));
     let added=0;
     for(const rows of [...shown.values()])for(const work of rows)for(const [id] of work.needIDs||[]){
      if(added>=2)break;
      const hit=byID.get(id);if(!hit)continue;
      const [target,key]=hit;
      // A method is looked up, not read in order; it stays in its box.
      if(key==='tools'||key==='seed')continue;
      const list=shown.get(key)||[];
      if(list.includes(target)||settled(target))continue;
      const order=steps.find(step=>step.key===key);const all=[...order.works,...order.more];
      shown.set(key,[...list,target].sort((a,b)=>all.indexOf(a)-all.indexOf(b)));added++;
     }
    }
    // Numbers follow what is on screen: a step is a paper to read, so the
    // paper itself and the ones already owned are not numbered.
    const number=new Map();let n=0;
    for(const step of steps)for(const work of shown.get(step.key)||[])if(!work.seed&&!settled(work))number.set(work.id,++n);
    // A start already on the shelf is still the start -- the best one, as it
    // costs nothing to open.
    const start=(planStart&&steps.some(step=>(shown.get(step.key)||[]).includes(planStart))?planStart:null)
     ||steps.flatMap(step=>shown.get(step.key)||[]).find(work=>number.has(work.id));
    const sectionOf=new Map(steps.flatMap(step=>(shown.get(step.key)||[]).map(work=>[work.id,step.key])));
    const c=plan.counts||{},fetched=c.fetched??c.references??0;
    const total=c.total&&c.total>fetched?`${fetched}/${c.total}`:String(fetched);
    const gaps=plan.partial?.length?T(plan.budgetGone?' · OpenAlex 한도로 일부를 읽지 못했습니다':' · 일부 조회가 실패했습니다'):'';
    message(c.total||fetched?`참고문헌 ${total}편 · 인용한 논문 ${c.citers||0}편에서 ${n}편을 골랐습니다${gaps}.`
     :`OpenAlex에 이 논문의 참고문헌 목록이 없어 인용한 논문 ${c.citers||0}편만 살폈습니다${gaps}.`);
    const notes=[];
    if(plan.titleMatched)notes.push('DOI가 없어 제목으로 찾은 논문입니다. 아래 "이 논문" 줄이 맞는지 확인하세요.');
    if(plan.mode==='review')notes.push('이 문헌은 리뷰라서, 뒤에 읽을 선행연구 대신 리뷰가 딛고 선 원논문을 보여 줍니다.');
    if(plan.mode==='method')notes.push('방법 논문이라, 이 논문을 인용한 논문은 후속 연구가 아니라 이 방법을 쓴 연구입니다.');
    for(const text of notes)node('p',text,list,{class:'sc-muted sc-path-note'});
    if(plan.partial?.length){
     const note=node('p','빠진 부분이 있는 결과는 저장하지 않습니다.',list,{class:'sc-muted sc-path-note'});
     button('다시 찾기',()=>run(()=>path({refresh:true})),note,{class:'sc-path-jump'});
    }
    if(!n&&sectionOf.size>1)node('p','순서에 든 논문을 모두 읽었습니다. 이 논문부터 읽어도 됩니다.',list,{class:'sc-muted sc-path-note'});
    else if(!n){
     const box=node('div',null,list,{class:'sc-empty'});
     node('p',c.total?'이 논문의 참고문헌에서 순서를 매길 만한 논문을 찾지 못했습니다.':'OpenAlex에 이 논문의 참고문헌 목록이 없어 순서를 짤 수 없습니다.',box);
     button('전체 목록 보기',()=>run(async()=>{state.relatedView='list';await saveUI({relatedView:'list'});await render();}),bar(box));
    }
    const edges=new Map(steps.flatMap(step=>[...step.works,...step.more].map(work=>[work.id,(work.needIDs||[]).map(([id])=>id)])));
    const reached=new Map();
    const reach=(id,trail=new Set())=>{
     if(reached.has(id))return reached.get(id);
     if(trail.has(id))return new Set();
     trail.add(id);
     const out=new Set();
     for(const next of edges.get(id)||[]){out.add(next);for(const far of reach(next,trail))out.add(far);}
     trail.delete(id);out.delete(id);reached.set(id,out);
     return out;
    };
    const jump=id=>{
     const target=list.querySelector(`[data-work="${String(id).replace(/"/g,'')}"]`);
     if(!target)return;
     target.scrollIntoView?.({block:'center',behavior:'smooth'});
     target.focus?.();
    };
    /* Owned works of a section fold into one line: "보유 3편 · first title 외".
       The start, when owned, keeps a line of its own. */
    /* Owned works of a section fold into one line: "보유 3편 · first title 외",
       which opens to the list -- the reader can see what was folded, not
       wonder whether it was dropped. The start, when owned, keeps its own line. */
    const ownedRow=(works,parent,{isStart=false}={})=>{
     const list=Array.isArray(works)?works:[works];
     const line=work=>`${work.title||'제목 없음'}${work.year?` · ${work.year}`:''}`;
     const label=list.length>1?`${T(`${list.length}편`)} · ${line(list[0])} ${T('외')}`:line(list[0]);
     if(list.length===1){
      const row=node('div',null,parent,{class:'sc-path-row sc-path-owned',tabindex:'-1','data-work':list[0].id});
      node('span','완료',row,{class:'sc-path-step'});
      {const t=node('p',label,row,{class:'sc-hit-title'});if(isStart)t.prepend(node('span',T('여기부터'),null,{class:'sc-path-start'}));}
      return row;
     }
     const box=node('details',null,parent,{class:'sc-path-owned-group'});
     const row=node('summary',null,box,{class:'sc-path-row sc-path-owned','data-work':list[0].id});
     node('span','완료',row,{class:'sc-path-step'});
     node('p',label,row,{class:'sc-hit-title'});
     const inner=node('ul',null,box,{class:'sc-path-owned-list'});
     for(const work of list)node('li',line(work),inner);
     return box;
    };
    const pathRow=(work,key,parent,{brief=false}={})=>{
     if(settled(work)&&!work.seed)return ownedRow(work,parent,{isStart:work===start});
     const row=hitRow(work,parent);
     row.classList.add('sc-path-row');
     row.setAttribute('tabindex','-1');
     row.dataset.work=work.id;
     if(work.seed){row.classList.add('sc-path-seed');row.querySelector('.sc-hit-owned')?.remove();row.querySelector('.sc-hit-around')?.remove();}
     const num=number.get(work.id);
     if(num)row.dataset.step=String(num);
     /* On the shelf but not finished: how far it has gone is said once, in
        the row's own 보유 (hitRow reads it off the library by DOI); a
        second line under the title repeated it. When the DOI lookup there
        found nothing but the path knows the paper, the path's record says it. */
     const owned=row.querySelector('.sc-hit-owned');
     if(work.inLibrary&&!work.seed&&work.local&&owned&&owned.textContent==='보유'){
      const l=work.local,said=[T('보유'),l.status==='reading'?T('읽는 중'):T('안 읽음')];
      if(Number(l.seconds)>0&&runtime.formatReadTime)said.push(runtime.formatReadTime(l.seconds,{compact:true}));
      owned.textContent=said.join(' · ');
     }
     // The PDF is the one action a reader takes from this list without
     // hovering first; it stays in sight.
     row.querySelector('.sc-hit-actions [data-opens="browser"]')?.classList.add('sc-hit-pdf');
     row.insertBefore(node('span',num?String(num):work.seed?'':'·',null,{class:'sc-path-step',...(num?{}:{'aria-hidden':'true'})}),row.firstChild);
     // "Start here" belongs on the title's line, not on one of its own.
     if(work===start)row.querySelector('.sc-hit-title')?.prepend(node('span','여기부터',null,{class:'sc-path-start'}));
     if(work.finding&&!work.seed)node('p',work.finding,row,{class:'sc-path-finding',lang:'en',...(work.findingSource?{title:`초록 출처: ${work.findingSource}`}:{})});
     let parts=runtime.pathTools.reasons(work,key).filter(part=>!/^먼저: /.test(part));
     if(brief)parts=parts.slice(0,1);
     // "Read first" names a numbered step in another section, by its number
     // on this screen -- reached through steps that are owned or hidden, and
     // reduced over what is shown so it names only the nearest.
     const reachable=[...reach(work.id)].filter(id=>number.has(id)&&sectionOf.get(id)!==key&&number.get(id)<(num||Infinity));
     const needs=reachable.filter(id=>!reachable.some(other=>other!==id&&reach(other).has(id))).sort((a,b)=>number.get(a)-number.get(b)).slice(0,3);
     if(!parts.length&&!needs.length)return row;
     /* Why this paper sits at this step is the reason to read it, so it goes
        directly under the title -- above the year, journal and authors, which
        are there to identify the paper, not to justify it. */
     const why=node('p',null,null,{class:'sc-path-why'});
     row.insertBefore(why,row.querySelector('.sc-hit-meta'));
     if(parts.length)why.appendChild(doc.createTextNode(parts.map(part=>T(part)).join(' · ')));
     if(needs.length){
      why.appendChild(doc.createTextNode((parts.length?' · ':'')+T('먼저:')+' '));
      for(const [i,id] of needs.entries()){
       if(i)why.appendChild(doc.createTextNode(', '));
       button(`${number.get(id)}번`,()=>jump(id),why,{class:'sc-path-jump','aria-label':`${number.get(id)}번으로 이동`});
      }
     }
     return row;
    };
    for(const step of steps){
     if(step.key==='tools')continue;
     const rows=shown.get(step.key);
     if(!rows?.length)continue;
     const nums=rows.map(work=>number.get(work.id)).filter(Boolean);
     const range=step.key==='seed'||!nums.length?'':' · '+T(nums.length===1?`${nums[0]}번`:`${nums[0]}–${nums[nums.length-1]}번`);
     const head=node('h3',null,list,{class:'sc-hit-group sc-path-head'});
     node('span',`${T(PATH_LABELS[step.key])}${range}`,head,{class:'sc-path-head-name'});
     const note=plan.mode==='review'&&step.key==='seed'?'원논문과 나란히 읽으면 이 리뷰가 무엇을 근거로 삼는지 보입니다':PATH_NOTES[step.key];
     /* What "기초" or "선행연구" means is the point of the grouping, so it is
        read, not hovered for: on one line beside the heading in the short path,
        on its own line in the full one. */
     if(short)node('span',T(plan.mode==='review'&&step.key==='seed'?note:PATH_NOTES_SHORT[step.key]||note),head,{class:'sc-path-head-note',title:T(note)});
     else node('p',note,list,{class:'sc-muted sc-hit-group-note'});
     const box=node('div',null,list,{class:'sc-hits'});
     const ownedHere=rows.filter(work=>settled(work)&&!work.seed&&work!==start);
     for(const work of rows){if(!ownedHere.includes(work))pathRow(work,step.key,box,{brief:short});}
     if(ownedHere.length)ownedRow(ownedHere,box);
     if(!short&&step.more.length){
      const more=node('details',null,list,{class:'sc-path-more'});
      node('summary',`${T(PATH_LABELS[step.key])} · ${T(`${step.more.length}편 더`)}`,more);
      let drawn=false;
      more.addEventListener('toggle',()=>{if(more.open&&!drawn){drawn=true;const inner=node('div',null,more,{class:'sc-hits'});for(const work of step.more)pathRow(work,step.key,inner);}});
     }
    }
    const tools=steps.find(step=>step.key==='tools');
    const restCount=plan.restTotal??rest.length;
    const hidden=steps.filter(step=>step.key!=='tools').reduce((sum,step)=>sum+step.works.length+step.more.length,0)-sectionOf.size;
    const foot=node('div',null,list,{class:'sc-path-foot'});
    button(short?`전체 순서 보기 · ${hidden}편 더`:'짧게 보기',()=>run(async()=>{
     const focused=doc.activeElement?.closest?.('[data-work]')?.dataset.work;
     state.pathDepth=short?'full':'min';await saveUI({pathDepth:state.pathDepth});
     drawPath(plan);
     // The toggle itself was redrawn: keep the reader where they were.
     const target=(focused&&list.querySelector(`[data-work="${focused}"]`))||list.querySelector('.sc-path-depth');
     target?.focus?.({preventScroll:true});target?.scrollIntoView?.({block:'nearest'});
    }),foot,{class:'sc-path-depth'});
    if(short){
     // The boxes the short path leaves out are one press away, opened.
     const open=selector=>run(async()=>{state.pathDepth='full';await saveUI({pathDepth:'full'});drawPath(plan);const box=list.querySelector(selector);if(box){box.open=true;box.dispatchEvent(new win.Event('toggle'));box.scrollIntoView?.({block:'start'});}});
     if(tools?.more.length)viewButton(`${T(PATH_LABELS.tools)} ${tools.more.length}`,()=>open('.sc-path-tools'),foot,{class:'sc-path-jump'});
     if(restCount)viewButton(`${T('나머지 참고문헌')} ${restCount}`,()=>open('.sc-path-rest'),foot,{class:'sc-path-jump'});
     return;
    }
    if(tools?.more.length){
     const box=node('details',null,list,{class:'sc-path-more sc-path-tools'});
     node('summary',`${T(PATH_LABELS.tools)} · ${T(`${tools.more.length}편`)}`,box);
     node('p',PATH_NOTES.tools,box,{class:'sc-muted sc-hit-group-note'});
     const inner=node('div',null,box,{class:'sc-hits'});
     for(const work of tools.more)pathRow(work,'tools',inner);
    }
    if(rest.length){
     const more=node('details',null,list,{class:'sc-path-rest'});
     node('summary',`나머지 참고문헌 ${restCount}편`,more);
     let drawn=false;
     more.addEventListener('toggle',()=>{if(more.open&&!drawn){drawn=true;for(const work of rest)own(work);hitList(rest,more);}});
    }
   }
   // Up and down (or j and k) walk the rows; Enter opens the one in focus.
   list.addEventListener('keydown',event=>{
    if(event.metaKey||event.ctrlKey||event.altKey||event.isComposing)return;
    if(event.target.matches?.('input,textarea,select,[contenteditable]'))return;
    const rows=[...list.querySelectorAll('.sc-path-row')].filter(row=>!row.closest('details:not([open])'));
    const at=rows.indexOf(event.target.closest?.('.sc-path-row'));
    if(at<0)return;
    const move=/^(ArrowDown|j)$/.test(event.key)?1:/^(ArrowUp|k)$/.test(event.key)?-1:0;
    if(move){event.preventDefault();rows[Math.max(0,Math.min(rows.length-1,at+move))]?.focus?.();return;}
    if(event.key==='Enter'&&event.target===rows[at]){event.preventDefault();rows[at].querySelector('.sc-hit-title-link')?.click();}
   });
   async function find({refresh=false}={}){
    if(refresh){const ref=runtime.Z.Items.get(Number(item.id));if(typeof runtime.forgetLookup==='function')runtime.forgetLookup(ref,'related:');else runtime.discoverCache.delete('related:'+runtime.identity(ref));}
    message('OpenAlex에서 관련 논문을 찾는 중…');
    const {work,suggestions}=await runtime.relatedWorksCached(runtime.Z.Items.get(Number(item.id)));
    if(token!==epoch||disposed||state.tab!=='related')return;
    list.replaceChildren();
    if(!work){message('이 논문을 OpenAlex에서 찾지 못했습니다.',true);return;}
    if(!suggestions.length){message('주제가 맞는 관련 논문을 찾지 못했습니다.');return;}
    message(`${suggestions.length}편 · 이미 보유 ${suggestions.filter(s=>s.inLibrary).length}편`);
    for(const group of runtime.discoverTools.GROUPS){
     const rows=suggestions.filter(s=>s.source===group);
     if(!rows.length)continue;
     sectionHead(GROUP_LABELS[group],rows.length,list);
     node('p',GROUP_NOTES[group],list,{class:'sc-muted sc-hit-group-note'});
     hitList(rows,list);
    }
   }
   /* The line of development: what had to be done before this paper could be
      written, in the order it happened. The reading order answers what to read
      first; this answers how the field arrived here. */
   async function timeline({refresh=false}={}){
    const ref=runtime.Z.Items.get(Number(item.id));
    if(refresh&&typeof runtime.forgetReadingPath==='function')runtime.forgetReadingPath(ref);
    pathAbort?.abort?.();
    const controller=typeof win.AbortController==='function'?new win.AbortController():typeof AbortController==='function'?new AbortController():null;
    pathAbort=controller;
    const current=()=>token===epoch&&!disposed&&state.tab==='related';
    message('참고문헌의 계보에서 마일스톤을 찾는 중…');
    if(!list.childElementCount)node('p','참고문헌의 계보에서 마일스톤을 찾는 중…',list,{class:'sc-muted sc-path-note',role:'status'});
    let plan;
    try{plan=await runtime.readingPathCached(ref,{signal:controller?.signal,onProgress:(done,total)=>{
     if(!current()){controller?.abort?.();return;}
     message(`OpenAlex에서 참고문헌과 인용 관계를 읽는 중… ${done}/${total}`);
    }});}catch(error){
     if(!current()||controller?.signal?.aborted)return;
     list.removeAttribute('aria-busy');list.querySelector('[role=status]')?.remove();
     throw error;
    }
    if(!current())return;
    list.replaceChildren();
    if(!plan){message('이 논문을 OpenAlex에서 찾지 못했습니다. DOI를 확인한 뒤 다시 찾으세요.',true);return;}
    drawTimeline(plan);
   }
   function drawTimeline(plan){
    list.replaceChildren();
    const found=plan.milestones;
    if(!found?.line?.length){
     // "찾는 중" stayed on the status line above the answer, so the reader
     // could not tell whether to wait.
     message('발전 과정 분석 완료 · 공통으로 기대는 논문 없음');
     const box=node('div',null,list,{class:'sc-empty'});
     node('p','이 논문의 참고문헌들이 공통으로 기대는 논문을 찾지 못했습니다. 서로 다른 갈래를 폭넓게 인용한 논문에서 자주 생깁니다.',box);
     button('읽기 순서 보기',()=>run(async()=>{state.relatedView='path';await saveUI({relatedView:'path'});await render();}),bar(box));
     return;
    }
    message(`${found.line.length}단계 · 참고문헌 ${found.bar}편 이상이 기대는 논문`);
    node('p','이 논문이 나오기까지 이 갈래가 지나온 단계입니다. 참고문헌들이 공통으로 인용한 정도로 골랐습니다.',list,{class:'sc-muted sc-path-note'});
    const line=node('ol',null,list,{class:'sc-line'});
    // A plan is kept for weeks; what is on the shelf is asked now, as the reading order does.
    const owned=typeof runtime.libraryDOIs==='function'?runtime.libraryDOIs():null;
    for(const work of found.line){
     if(owned&&work.doi)work.inLibrary=owned.has(String(work.doi).toLowerCase());
     const row=node('li',null,line,{class:'sc-line-row'});
     node('span',String(work.year||''),row,{class:'sc-line-year'});
     const body2=node('div',null,row,{class:'sc-line-body'});
     const title=node('p',work.title||T('제목 없음'),body2,{class:'sc-hit-title'});
     if(work.inLibrary)node('span','보유',title,{class:'sc-line-owned'});
     const why=[T(`참고문헌 ${work.support}편이 인용`)];
     if(work.cited)why.push(T('이 논문이 인용'));
     if(work.citations!=null)why.push(T(`인용 ${work.citations}`));
     node('p',why.join(' · '),body2,{class:'sc-path-why'});
     if(work.venue)node('p',work.venue,body2,{class:'sc-hit-meta'});
     const acts=node('div',null,body2,{class:'sc-hit-actions'});
     const mine=work.inLibrary&&work.doi&&typeof runtime.itemForDOI==='function'?runtime.itemForDOI(work.doi):null;
     if(mine&&win.ZoteroPane?.selectItem)button('보기',()=>run(async()=>{await win.ZoteroPane.selectItem(mine.id);message(`목록에서 선택했습니다 — ${String(work.title||'').slice(0,60)}`);}),acts,{title:'Zotero 목록에서 이 논문 선택'});
     if(!work.inLibrary&&work.doi){
      // A milestone worth reading is worth keeping: in, without leaving the panel.
      const add=button(importLabel(),()=>run(async()=>{
       const saved=await importHere(work);
       work.inLibrary=true;add.remove();node('span','보유',title,{class:'sc-line-owned'});
      }),acts,{'data-writes':'library',title:importTip()});
      button('doi.org에서 열기',()=>{try{win.Zotero?.launchURL?.('https://doi.org/'+work.doi);}catch(_){}},acts,{'data-opens':'browser'});
     }
     if(!acts.childNodes.length)acts.remove();
    }
    const last=node('li',null,line,{class:'sc-line-row sc-line-seed'});
    node('span',String(plan.milestones.seedYear||item.year||''),last,{class:'sc-line-year'});
    node('p',item.title||T('제목 없음'),node('div',null,last,{class:'sc-line-body'}),{class:'sc-hit-title'});
   }
   const go=view==='path'?path:view==='line'?timeline:find;
   // A view is chosen, an action is taken: the segmented control above holds
   // the views, and these two stop wearing its clothes.
   button('다시 찾기',()=>run(()=>go({refresh:true})),b,{class:'sc-quiet-action'});
   button('저자로 이동',()=>run(async()=>{await navigate('authors');}),b,{class:'sc-quiet-action'});
   // The tab was asked for; do not make the user ask twice.
   run(()=>go());
  }

  async function drawAuthors(token){
   // The watchlist is drawn first and unconditionally: it is a list of people
   // being followed, and hiding it until a paper happened to be selected made
   // every followed author invisible.
   const watchArea=node('div',null,body,{class:'sc-author-watch'});
   // The person being looked at is a region of its own, ruled off from the
   // watchlist above it: the two ran together as one page of names.
   const list=node('div',null,body,{class:'sc-author-page'});
   /* A section of the author page: its name in the text's ink with the count
      beside it, over a rule. The generic group label (10px, grey, capitals)
      was smaller than the rows under it, so every section ran into the next. */
   const section=(label,count,parent=list)=>sectionHead(label,count,parent,'sc-author-head');
   let item=null;
   try{item=one();}catch(_){item=null;}
   /* One section of a person's page: a soft container with "Name · n" over its
      rows. Built here, not left to groupSections, because this page is filled
      in after the tab is drawn, and a heading with loose rows under it is what
      the page looked like before. */
   const personGroup=(label,count,parent,extra='')=>{
    const g=node('section',null,parent,{class:'sc-group sc-person-group'+(extra?' '+extra:'')});
    sectionHead(label,count,g,'sc-author-head');
    return g;
   };
   const watchedRow=id=>{
    const short=runtime.discoverTools?.shortID?.(id)||id;
    return (runtime.watchedAuthors?.()||[]).find(w=>w.id===id||(runtime.discoverTools?.shortID?.(w.id)||w.id)===short)||null;
   };
   /* What of this person is already on the shelf, and how far each has been
      read -- from the loaded library, so it shows before OpenAlex answers.
      A title opens the paper whatever the search or filters were. */
   function drawShelf(name,person,parent,redo){
    const shelf=papersBy(name);
    if(!shelf.items.length)return;
    const g=personGroup(shelf.guess?'내 서재의 이 저자 문헌 (이름 첫 글자로 추정)':'내 서재의 이 저자 문헌',shelf.items.length,parent,'sc-person-shelf');
    const mine=node('div',null,g,{class:'sc-author-shelf'});
    const ordered=[...shelf.items].sort((a,b)=>(Number(b.year)||0)-(Number(a.year)||0));
    for(const item of ordered.slice(0,state.authorShelfAll?ordered.length:8)){
     const row=node('div',null,mine,{class:'sc-author-shelf-row'});
     button(item.title||T('제목 없음'),()=>showPaper(item.id),row,{class:'sc-hit-title-link',title:item.title||''});
     const meta=node('span',null,row,{class:'sc-muted sc-author-shelf-meta'});
     const said=[[item.year,'sc-shelf-year'],[item.status==='done'?T('완료'):item.status==='reading'?T('읽는 중'):T('안 읽음'),'sc-shelf-state'],[Number(item.seconds)>0&&runtime.formatReadTime?runtime.formatReadTime(item.seconds,{compact:true}):'','sc-shelf-time']].filter(([text])=>text);
     said.forEach(([text,cls],index)=>{if(index)meta.appendChild(doc.createTextNode(' · '));{const chip=node('span',String(text),meta,{class:cls});if(cls==='sc-shelf-state')chip.dataset.status=item.status||'unread';}});
    }
    if(ordered.length>8)viewButton(state.authorShelfAll?'8편만 보기':T(`${ordered.length}편 모두 보기`),()=>{state.authorShelfAll=!state.authorShelfAll;redo();},g,{class:'sc-local-reading-more'});
   }
   /* One person's page, drawn into `root`: the full page under the watch table
      (show) and the panel that opens right under their row (inline) are the
      same renderer, so the two cannot drift apart. */
   async function renderPerson(person,root,opts={}){
    const inline=!!opts.inline;
    const live=()=>token===epoch&&!disposed&&state.tab==='authors'&&root.isConnected;
    const redo=()=>renderPerson(person,root,opts);
    if(!inline)message(`${person.name}의 최근 작업을 불러오는 중…`);
    // The shelf first, while OpenAlex is asked.
    root.replaceChildren();
    const wrap=node('div',null,root,{class:'sc-person-detail'+(inline?' sc-person-inline':'')});
    if(!inline)node('h3',person.name,wrap,{class:'sc-hit-group'});
    else node('p',T('불러오는 중…'),wrap,{class:'sc-muted sc-person-loading'});
    drawShelf(person.name,person,wrap,redo);
    let data;
    try{data=await runtime.authorUpdates(person.id);}
    catch(error){
     if(!inline)throw error;
     if(live()){wrap.replaceChildren();const line=node('p',null,wrap,{class:'sc-muted sc-person-loading'});node('span',readable(error),line);button('다시 시도',()=>run(redo),line);}
     return;
    }
    const {profile,works,fresh:reported,watching,checkedAt}=data;
    /* One 확인함, not two.

       The inbox above marks a paper read in its own per-paper store, keyed by
       DOI, and that is reversible. This page used to count from the sweep's
       own baseline instead, so marking two of four in the inbox left the
       person's page still saying four -- and its button then called
       markAuthorSeen plus clearAuthorNews, which threw the stored news away
       for good and did not mark anything in the inbox. Both now read and
       write the one store, so a paper dismissed in either place is dismissed
       in both, and can be put back. */
    const newsKey=seenWorkKey;
    const fresh=reported.filter(work=>!isSeen({key:newsKey(work)}));
    if(!live())return;
    wrap.replaceChildren();
    if(!inline&&item){const back=bar(wrap);button('← 이 논문의 저자 보기',()=>run(loadAuthors),back);}
    const stored=watchedRow(person.id);
    // The face, the name and the numbers on one line. A person is easier to
    // hold in mind than a row of statistics, which is the whole point of
    // following people rather than papers.
    const head=node('div',null,wrap,{class:'sc-person'+(inline?' sc-person-compact':'')});
    if(!inline)wrap.scrollIntoView?.({block:'start',behavior:'smooth'});
    let face=null;
    if(!inline){face=node('div',null,head,{class:'sc-face'});node('span',initials(profile?.name||person.name),face,{class:'sc-face-text'});}
    const who=node('div',null,head,{class:'sc-person-who'});
    // The row's name is cut to fit its column; the opened panel always says the whole name.
    node('h3',profile?.name||person.name,who,{class:inline?'sc-person-inline-name':'',title:profile?.name||person.name});
    const stats=node('p',null,who,{class:'sc-profile'});
    const places=person.places&&person.places.length>1?person.places.map(p=>p.name).join(' · '):'';
    const institution=stored?.institution||person.institution||profile?.institutions?.[0]||'';
    if(places||institution){
     const span=node('span',null,stats,{class:'sc-profile-place'});
     node('span',T('소속')+' ',span);
     if(places)node('b',places,span);else placeLine({institution},span);
    }
    /* 마지막 확인 is the stored sweep (what the table row says); the profile's own fetch date only stands in when no sweep has recorded one. */
    const checkedOn=(stored&&stored.sweptAt)||checkedAt||'';
    for(const [label,value] of [['h-index',profile?.hIndex],['논문',profile?.works!=null?fmtN(profile.works):null],['총 인용',profile?.citations!=null?fmtN(profile.citations):null],['마지막 확인',checkedOn.slice(0,10)]]){
     if(value==null||value==='')continue;
     const span=node('span',label+' ',stats);node('b',String(value),span);
    }
    if(profile?.topics?.length){
     const chips=node('div',null,who,{class:'sc-chips'});
     for(const topic of profile.topics){const chip=node('span',topic.name,chips,{class:'sc-chip'});if(topic.count)node('b',fmtN(topic.count),chip);}
    }
    // A portrait is a nice-to-have on a metered budget, so it is fetched only
    // for the author actually being looked at, and remembered either way.
    if(face)paintPortrait(face,{...person,name:profile?.name||person.name,orcid:profile?.orcid});
    const unseenStored=stored?unseenWorks(stored):[];
    const follow=bar(wrap);
    if(inline)button('상세 보기',()=>run(()=>show(person)),follow,{class:'sc-person-full',title:T('이 저자의 전체 화면 보기')});
    if(profile?.orcid)button('ORCID 열기',()=>win.Zotero.launchURL(profile.orcid),follow,{'data-opens':'browser'});
    /* LinkedIn has no public search API and its pages are behind a login, so nothing is fetched from it:
       the button opens the reader's browser on LinkedIn's people search for the name and the latest
       institution -- the profile itself when the person's ORCID record lists one. */
    {const who=profile?.name||person.name||'',where=stored?.institution||person.institution||profile?.institutions?.[0]||'';
     if(who)button('LinkedIn',()=>run(async()=>{let url='';
      const id=String(profile?.orcid||person.orcid||'').match(/\d{4}-\d{4}-\d{4}-\d{3}[\dX]/i)?.[0];
      if(id&&typeof runtime.orcidLinkedIn==='function'){try{url=await runtime.orcidLinkedIn(id);}catch(_){url='';}}
      if(!/^https:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\//i.test(url||''))url='https://www.linkedin.com/search/results/people/?keywords='+encodeURIComponent([who,where].filter(Boolean).join(' '));
      win.Zotero.launchURL(url);}),follow,{'data-opens':'browser',title:T('LinkedIn에서 이 사람 찾기 (ORCID에 프로필이 있으면 바로 열기)')});}
    const refreshed=async()=>{refreshWatched();if(!inline)await show(person);};
    if(watching){
     // As in the list: letting someone go drops their baseline and news, so the first press only arms it.
     if(!inline){
      const off=button('관심 해제',()=>{
       if(!off.dataset.armed){off.dataset.armed='1';off.textContent=T('정말 해제');win.setTimeout(()=>{if(off.isConnected){delete off.dataset.armed;off.textContent=T('관심 해제');}},3000);return;}
       return run(async()=>{await unfollow(person,refreshed);await refreshed();});
      },follow,{class:'sc-unwatch'});
     }
     /* The count is the list shown under it (the stored unseen papers when there are any), so the button and the group agree. */
     const toMark=unseenStored.length?unseenStored:fresh;
     if(toMark.length)button(`새 논문 ${toMark.length}편 확인함`,()=>run(async()=>{
      // Marked one by one in the store the inbox reads, so 확인함 above and
      // here agree and either can be undone. The sweep's own record of what
      // it has found is left alone; a later sweep replaces it anyway.
      for(const work of toMark)await setSeen({key:newsKey(work)},true);
      if(inline)state.watchRefocus=true;
      await refreshed();
     }),follow);
    } else if(!inline){
     // Everything visible now is the baseline, so "new" later means new to the user.
     button('관심 저자로 등록',()=>run(async()=>{
      await runtime.watchAuthor({...person,name:profile?.name||person.name,seen:works.map(w=>w.id)});
      await refreshed();
     }),follow);
    }
    /* What is new since the last look: papers in the inbox's own row anatomy,
       then a first-time co-author, a move and a new filing, each in a
       container of its own -- one answer to "what has this person done
       lately", not four sections scattered down the page. */
    const newCoauthors=stored?.newCoauthors||[];
    const moved=stored?.moved?.to?stored.moved:null;
    const newPatents=stored?.newPatents?.length||0;
    if(watching&&(unseenStored.length||fresh.length)){
     const g=personGroup('새 논문',unseenStored.length||fresh.length,wrap,'sc-person-news');
     if(unseenStored.length){
      const byDOI=new Map(state.items.filter(i=>i.doi).map(i=>[bareDOI(i.doi),i]));
      const box=node('div',null,g,{class:'sc-author-inbox'});
      for(const work of unseenStored)drawInboxRow({key:seenWorkKey(work),work,people:[stored],copies:[work]},box,{byDOI,self:true,redraw:redo,toggle:async(entry,seen)=>{await setSeen(entry,!seen);if(disposed||state.tab!=='authors')return;if(inline)state.watchRefocus=true;await refreshed();}});
     }else hitList(fresh,g);
    }
    if(moved||newCoauthors.length||newPatents){
     const news=node('section',null,wrap,{class:'sc-group sc-person-group sc-author-news','aria-label':T('마지막 확인 이후')});
     {const head=sectionHead('마지막 확인 이후','',news,'sc-author-head');if(checkedOn)node('span',checkedOn.slice(0,10),head,{class:'sc-muted sc-author-head-date'});}
     if(moved){
      const line=node('p',null,news,{class:'sc-author-news-line'});
      node('span',T('소속 이동'),line,{class:'sc-author-news-label'});
      node('span',`${moved.from||'?'} → ${moved.to}${moved.since?` · ${moved.since}년부터`:''}`,line);
     }
     if(newCoauthors.length){
      /* A name not on any of their earlier papers is a collaboration starting,
         which tends to come before the topic shift it produces. */
      const line=node('p',null,news,{class:'sc-author-news-line'});
      node('span',T('처음 함께 낸 저자'),line,{class:'sc-author-news-label'});
      node('span',newCoauthors.join(', '),line,{title:'마지막 확인 이후 처음 같이 낸 저자'});
     }
     if(newPatents){
      const line=node('p',null,news,{class:'sc-author-news-line'});
      node('span',T('새 특허'),line,{class:'sc-author-news-label'});
      node('span',T(`${newPatents}건 · 아래 특허 목록에 표시`),line);
     }
    }
    drawShelf(profile?.name||person.name,person,wrap,redo);
    // The circle of colleagues, out of the works already in hand: no request of
    // its own, and an edge exists because two names are on the same paper.
    const circle=runtime.coauthorsOf?.(person.id,works)||[];
    if(circle.length){
     const g=personGroup('함께 낸 저자',circle.length,wrap,'sc-person-circle');
     const net=node('div',null,g,{class:'sc-network'});
     const most=circle[0].papers||1;
     for(const mate of circle){
      const chip=node('div',null,net,{class:'sc-node'});
      chip.setAttribute('role','button');chip.tabIndex=0;
      const mateRow=watchedRow(mate.id);
      if(mateRow)chip.dataset.followed='true';
      const go=()=>{
       // A followed co-author opens right where they are in the table; anyone else gets their own page.
       if(inline&&mateRow&&opts.expand){opts.expand(mateRow);return;}
       return run(()=>show({id:mate.id,name:mate.name,institution:mate.institution}));
      };
      chip.addEventListener('click',go);
      chip.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();go();}});
      // Thickness stands for how often, which is the only quantity here.
      chip.style.setProperty('--sc-tie',String(Math.max(0.18,mate.papers/most)));
      const mateFace=node('span',null,chip,{class:'sc-node-face'});
      node('span',initials(mate.name),mateFace,{class:'sc-face-text'});
      // Only a face already found: a circle of twenty does not cost twenty searches.
      showFace(mateFace,runtime.portraitOf?.(mate.id));
      const text=node('span',null,chip,{class:'sc-node-body'});
      node('span',mate.name,text,{class:'sc-node-name'});
      node('span',`${mate.papers}편${mate.last?` · ${mate.last}`:''}`,text,{class:'sc-node-meta'});
      chip.title=[mate.name,mate.institution,`공저 ${mate.papers}편`,mateRow?'관심 저자':'',...(mate.titles||[])].filter(Boolean).join('\n');
     }
    }
    const recent=personGroup('최근 논문',works.length,wrap,'sc-person-recent');
    if(!works.length)node('p','최근 논문을 찾지 못했습니다.',recent,{class:'sc-muted'});
    else hitList(works,recent);
    // Filings last: they are the rarest and the least often read, and the new
    // ones are already named in the box at the top.
    if(stored&&stored.patents&&stored.patents.length){
     /* A filing is the earliest public sign of where a lab is heading, often
        a year before the paper; the new ones since the last look are marked. */
     const g=personGroup('특허',stored.newPatents?.length?`${stored.patents.length} · 새 ${stored.newPatents.length}`:stored.patents.length,wrap);
     const box=node('div',null,g,{class:'sc-hits'});
     for(const patent of stored.patents){
      const c=node('div',null,box,{class:'sc-hit sc-patent'+(patent.fresh?' sc-patent-fresh':'')});
      const phead=node('p',null,c,{class:'sc-hit-title'});
      if(patent.fresh)node('span','새',phead,{class:'sc-tag sc-new',title:'마지막 확인 이후 새로 보인 특허'});
      node('span',patent.title,phead);
      node('p',[patent.id,patent.granted?`등록 ${patent.granted}`:patent.filed?`출원 ${patent.filed}`:'',patent.applicants?.[0]||'',patent.status||''].filter(Boolean).join(' · '),c,{class:'sc-hit-meta'});
      const actions=node('div',null,c,{class:'sc-hit-actions'});
      if(patent.link)button('열기',()=>runtime.Z.launchURL&&runtime.Z.launchURL(patent.link),actions,{'data-opens':'browser'});
     }
    }else if(stored&&typeof runtime.patentsKey==='function'&&!runtime.patentsKey()&&!inline){
     node('p','특허 확인은 설정에 USPTO Open Data Portal 키를 넣으면 켜집니다 (무료).',wrap,{class:'sc-muted'});
    }
    if(!inline)message(`${works.length}편 · 이미 보유 ${works.filter(w=>w.inLibrary).length}편`
     +(watching?` · 새 논문 ${fresh.length}편`+(checkedAt?` · 마지막 확인 ${checkedAt.slice(0,10)}`:''):''));
   }
   async function show(person){
    list.replaceChildren();
    await renderPerson(person,list,{});
   }
   // Every row used to read "<institution> · 마지막 확인 2026-09-17" -- the same
   // date on all 109 of them, which answered nothing and cost the only line
   // available. A watchlist has exactly one question: who has published since I
   // looked. So the sweep runs once for everyone, the answer lives on the row,
   // and the people with news sort to the top.
   /* 저장된 새 논문: every followed author's news in one list, newest first,
      a paper two of them share once with both names on it, and what the
      library already knows about it -- owned, how far read. Read off what the
      last sweep kept (at most eight a person), so it asks nothing and marks
      nothing seen. The cards below stay the way to one person. */
   const bareDOI=doi=>String(doi||'').toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//,'').trim();
   // One paper two followed authors share is one entry, with both names on it
   // and each one's own copy of the record (their part in it is in that copy).
   function mergedNews(watched){
    const merged=new Map();
    for(const person of watched)for(const work of person.news||[]){
     const key=seenWorkKey(work);if(!key)continue;
     if(!merged.has(key))merged.set(key,{key,work,people:[],copies:[]});
     const entry=merged.get(key);
     entry.people.push(person);entry.copies.push(work);
     // The fullest record stands for the paper.
     if(!entry.work.citations&&work.citations!=null)entry.work={...entry.work,citations:work.citations};
    }
    return [...merged.values()].sort((a,b)=>String(b.work.date||'').localeCompare(String(a.work.date||'')));
   }
   // A person's part in a paper, as far as the stored record says.
   function rolesOf(copy){
    const roles=[];
    if(copy?.position==='first')roles.push(T('1저자'));
    if(copy?.position==='last')roles.push(T('마지막 저자'));
    if(copy?.corresponding)roles.push(T('교신'));
    return roles;
   }
   /* One row of the saved news, the same anatomy in the inbox and on a person's own
      page: who it is from, the title, the journal in its own ink, the figures, the
      library's reading state, and what can be done with it. ctx: byDOI, redraw,
      toggle(entry,wasSeen,row,box), self (on one person's page). */
   function drawInboxRow(entry,box,ctx){
    const {work,people}=entry;
    const row=node('div',null,box,{class:'sc-author-inbox-row'+(ctx.self?' sc-inbox-self':''),'data-seen':String(isSeen(entry))});
    // Who it is from leads the row: the followed author's own face, as on the card.
    if(!ctx.self){
     const faces=node('span',null,row,{class:'sc-inbox-faces','aria-hidden':'true'});
     for(const person of people.slice(0,3))watchFace(person,faces);
     if(people.length>3)node('span','+'+(people.length-3),faces,{class:'sc-inbox-faces-more'});
    }
    const text=node('div',null,row,{class:'sc-inbox-text'});
    const title=node('p',null,text,{class:'sc-hit-title'});
    const mine=ctx.byDOI.get(bareDOI(work.doi));
    // A paper on the shelf opens there; one that is not opens at its DOI.
    if(mine)button(work.title||T('제목 없음'),()=>{state.selected=new Set([String(mine.id)]);state.scope='selected';scope.value='selected';return navigate('explore');},title,{class:'sc-hit-title-link',title:T('이 문헌 자세히 보기')});
    else if(work.doi){const link=node('button',work.title||T('제목 없음'),title,{type:'button',class:'sc-hit-title-link','data-opens':'browser',title:T('doi.org에서 열기')});link.addEventListener('click',()=>{try{win.Zotero.launchURL('https://doi.org/'+bareDOI(work.doi));}catch(e){message(readable(e),true);}});}
    else title.textContent=work.title||T('제목 없음');
    // Worst news first: a withdrawn paper must not read like a paper.
    const rank=Number(work.signals&&work.signals.rank)||0;
    if(rank>=1)node('span',T(rank>=3?'철회':rank>=2?'우려 표명':'정정'),title,{class:'sc-signal sc-signal-'+(rank>=3?'retracted':rank>=2?'concern':'corrected')});
    /* One meta line, the same anatomy as a library card: the journal's full
       name once, in its own ink; a preprint is said once, as a chip, and its
       server stands where the journal would; then the date, the figures the
       plugin already holds, and the followed authors with their part. */
    const meta=node('p',null,text,{class:'sc-hit-meta sc-inbox-meta'});
    const preprint=isPreprintWork(work);
    if(preprint)node('span','Preprint',meta,{class:'sc-preprint',title:T('아직 심사 전 원고입니다. 정식 게재본은 나중에 따로 나올 수 있습니다.')});
    const parts=[];
    const venueName=preprint?serverName(work.venue):String(work.venue||'').trim();
    if(venueName)parts.push(el=>{const v=venueSpan(el,venueName);if(venueName!==work.venue)v.title=work.venue;});
    const date=String(work.date||'').slice(0,10);
    if(date)parts.push(el=>node('span',date,el,{class:'sc-paper-year'}));
    const info=!preprint&&work.venue?runtime.journalIdentity?.identify?.(String(work.venue).trim()):null;
    const impact=info&&info.impactFactor!=null&&info.impactFactor!==''&&typeof info.impactFactor!=='boolean'&&Number.isFinite(Number(info.impactFactor))?Number(info.impactFactor):null;
    if(impact!=null)parts.push(el=>node('span',`IF ${impact.toFixed(1)}`,el,{class:'sc-inbox-fact',title:T('저장된 저널 IF')+(info.year?` (${info.year})`:'')}));
    const cited=Number(work.citations??mine?.citations);
    if(Number.isFinite(cited)&&(work.citations!=null||mine?.citations!=null))parts.push(el=>node('span',T(`인용 ${cited.toLocaleString()}`),el,{class:'sc-inbox-fact',title:T('지금까지 이 논문을 인용한 논문 수')}));
    people.forEach((person,index)=>{
     // On the person's own page with no part to say there is nothing to show: no empty piece after a ' · '.
     if(ctx.self&&!rolesOf(entry.copies[index]).length)return;
     parts.push(el=>{
     const copy=entry.copies[index];
     const who=node('span',null,el,{class:'sc-inbox-who'});
     // Each name opens that person's page: from a paper to who wrote it, without the card grid.
     // On the person's own page the name is already the heading; only their part is said.
     if(!ctx.self)button(person.name,()=>run(()=>show(person)),who,{class:'sc-inbox-person',title:T('이 저자 보기')});
     const roles=rolesOf(copy);
     if(roles.length)node('span',roles.join(' · '),who,{class:'sc-inbox-role'});
    });});
    parts.forEach((make,index)=>{if(index)meta.appendChild(doc.createTextNode(' · '));make(meta);});
    const status=node('span',null,row,{class:'sc-inbox-status'});
    if(mine){node('span',T('보유'),status,{class:'sc-hit-owned'});const said=[mine.status==='done'?T('완료'):mine.status==='reading'?T('읽는 중'):T('안 읽음')];if(Number(mine.seconds)>0&&runtime.formatReadTime)said.push(runtime.formatReadTime(mine.seconds,{compact:true}));node('span',said.join(' · '),status,{class:'sc-inbox-read'});}
    else{
     // Not on the shelf: taken in from here, as from any list of suggestions.
     if(work.doi&&typeof runtime.importWork==='function'){const add=button(importLabel(),()=>run(async()=>{
      const saved=await importHere(work);
      // Redrawn as a paper on the shelf: its reading state and 읽기 대기 appear in place.
      const record=ownedRecord(saved,work);
      if(record&&typeof ctx.redraw==='function'){ctx.byDOI.set(bareDOI(work.doi),record);ctx.redraw();}
      else{add.remove();node('span',T('보유'),status,{class:'sc-hit-owned'});}
     }),status,{'data-writes':'library',title:importTip()});}
    }
    const actions=node('span',null,row,{class:'sc-inbox-actions'});
    /* An owned, unread paper can be put by for reading: it waits on 읽기
       진행 whatever happens to it here, and leaves once reading starts. */
    if(mine&&mine.status!=='done'&&mine.status!=='reading'){
     const waiting=isQueued(mine.id);
     button(waiting?'대기 중':'읽기 대기',()=>run(async()=>{
      await setReadingQueue([mine],!waiting,people.map(p=>p.name));if(!disposed&&state.tab==='authors')ctx.redraw();
      message(waiting?'읽기 대기에서 뺐습니다.':'읽기 진행의 읽기 대기에 넣었습니다.');
     }),actions,{class:'sc-inbox-queue','aria-pressed':String(waiting),title:T(waiting?'다시 누르면 대기에서 뺍니다':'읽기 진행 탭의 읽기 대기에 넣습니다')});
    }
    const seen=isSeen(entry);
    button(seen?'되돌리기':'확인함',()=>run(()=>ctx.toggle(entry,seen,row,box)),actions,{'data-writes':'cache',class:'sc-inbox-seen',title:T(seen?'미확인으로 되돌립니다':'이 논문을 확인한 것으로 두고 목록에서 뺍니다')});
   }
   /* Papers carrying a followed author's id but signed from places that author
      has never been listed at: a namesake merged into the profile is the usual
      cause. They are not counted as news; here the reader confirms one (it
      becomes news and teaches the row its place) or rejects it for good. */
   function drawNamesakeGroup(watched,parent){
    const held=watched.flatMap(person=>(person.unverified||[]).map(work=>({person,work})));
    if(!held.length)return;
    const fold=node('details',null,parent,{class:'sc-namesake-group'});
    if(state.namesakeOpen)fold.open=true;
    fold.addEventListener('toggle',()=>{state.namesakeOpen=fold.open;});
    node('summary',T(`확인 필요 ${held.length}`),fold);
    node('p',T('같은 이름의 다른 사람 논문일 수 있습니다. 이 저자의 알려진 소속과 겹치지 않아 새 논문 수에서 뺐습니다.'),fold,{class:'sc-muted sc-inbox-note'});
    for(const {person,work} of held){
     const row=node('div',null,fold,{class:'sc-author-inbox-row'});
     node('b',work.title||work.doi||work.id,row);
     node('p',[person.name,work.venue,(work.date||'').slice(0,4),(work.places||[]).join(', ')].filter(Boolean).join(' · '),row,{class:'sc-muted'});
     node('p',T('동명이인일 수 있음'),row,{class:'sc-muted'});
     const acts=node('div',null,row,{class:'sc-hit-actions'});
     button('이 저자의 논문입니다',()=>run(async()=>{await runtime.resolveNamesake(person.id,work.id,true);if(!disposed&&state.tab==='authors')refreshWatched();}),acts,{class:'sc-namesake-confirm'});
     button('다른 사람입니다',()=>run(async()=>{await runtime.resolveNamesake(person.id,work.id,false);if(!disposed&&state.tab==='authors')refreshWatched();}),acts,{class:'sc-namesake-reject'});
    }
   }
   function drawAuthorInbox(watched,parent,hook={}){
    const all=mergedNews(watched);
    if(!all.length)return;
    const byDOI=new Map(state.items.filter(i=>i.doi).map(i=>[bareDOI(i.doi),i]));
    /* The newest sweep is not the state of the list. Reporting the maximum
       put "마지막 확인 today" over a list in which eleven of a hundred and nine
       had not been looked at for a month, and over people never checked at
       all. The oldest is what says whether the list can be trusted. */
    const stamps=watched.map(p=>p.sweptAt).filter(Boolean).sort();
    const last=stamps[stamps.length-1];
    const oldest=stamps[0];
    const never=watched.filter(p=>!p.sweptAt).length;
    const staleDays=oldest?Math.floor((Date.now()-Date.parse(oldest))/864e5):0;
    const view=state.inboxView||'new';
    const section=node('section',null,parent,{class:'sc-author-inbox-section'});
    sectionHead('저장된 새 논문',all.length,section);
    if(last){
     const shown=(runtime.formatStamp&&runtime.localStamp?runtime.formatStamp(runtime.localStamp(last)):String(last).replace('T',' ')).slice(0,16);
     const note=node('p',T(`마지막 확인 ${shown} · 저자마다 확인 안 한 새 논문은 최대 50편까지`),section,{class:'sc-muted sc-inbox-note'});
     // What the date above does not cover, said next to it rather than left out.
     if(never)note.appendChild(doc.createTextNode(' · '+T(`${never}명은 아직 확인하지 않았습니다`)));
     else if(staleDays>7)note.appendChild(doc.createTextNode(' · '+T(`${staleDays}일 넘게 확인하지 않은 저자가 있습니다`)));
    }
    // The author picked in the 관계 map narrows this list; counts follow it.
    const focused=()=>state.authorFocus?watched.find(p=>p.id===state.authorFocus)||null:null;
    const pool=()=>{const who=focused();return who?all.filter(e=>e.people.some(p=>p.id===who.id)):all;};
    const tools=node('div',null,section,{class:'sc-inbox-tools'});
    const views=node('div',null,tools,{class:'sc-segmented',role:'group','aria-label':T('새 논문 보기')});
    const viewButtons=new Map();
    for(const [key,label] of [['new','미확인'],['seen','확인함'],['all','전체']])
     viewButtons.set(key,[withCount(button('',()=>{state.inboxView=key;state.inboxAll=false;refreshWatched();},views,{'aria-pressed':String(view===key)}),label,0),label]);
    const find=node('input',null,tools,{type:'search',placeholder:T('제목·저널·저자 검색'),'aria-label':T('새 논문 검색')});
    find.value=state.inboxQuery||'';
    // Everything the list shows now (its search and author filter included) in one press, with one undo.
    let shownUnseen=[];
    const markAll=button('모두 확인함',()=>run(async()=>{
     const keys=shownUnseen.map(e=>seenKey(e));if(!keys.length)return;
     const evicted={};
     await setSeenMany(keys,true,null,{evicted});
     if(disposed||state.tab!=='authors')return;
     refreshWatched();
     message(`${keys.length}편을 확인함으로 옮겼습니다.`);
     undoToast(`${keys.length}편을 확인함으로 옮겼습니다.`,async()=>{await setSeenMany(keys,false,null,{restore:evicted});if(!disposed&&state.tab==='authors')refreshWatched();message(`${keys.length}편을 미확인으로 되돌렸습니다.`);});
    }),tools,{class:'sc-inbox-mark-all',title:T('지금 목록에 보이는 안 읽은 새 논문을 모두 확인한 것으로 둡니다')});
    node('span',T('↑↓ 이동 · e 확인함'),tools,{class:'sc-muted sc-inbox-hint'});
    const focusBar=node('div',null,section,{class:'sc-inbox-focus'});
    const box=node('div',null,section,{class:'sc-author-inbox'});inboxKeys(box);
    const more=node('div',null,section,{class:'sc-actions'});
    const draw=()=>{
     box.replaceChildren();more.replaceChildren();focusBar.replaceChildren();
     const who=focused();
     const base=pool();
     const unseen=base.filter(e=>!isSeen(e)).length;
     for(const [key,count] of [['new',unseen],['seen',base.length-unseen],['all',base.length]]){const [b,label]=viewButtons.get(key);withCount(b,label,count);}
     // The way out of a narrowed list is on the list, wherever the map is.
     if(who){
      const chip=button('',()=>{state.authorFocus='';hook.sync?.();draw();},focusBar,{class:'sc-focus-chip','aria-label':T(`저자 필터 해제: ${who.name}`),title:T('저자 필터 해제')});
      node('span',T(`저자: ${who.name}`),chip,{class:'sc-focus-chip-name'});
      node('span','×',chip,{class:'sc-focus-chip-x','aria-hidden':'true'});
     }
     focusBar.hidden=!who;
     const words=String(state.inboxQuery||'').toLowerCase().split(/\s+/).filter(Boolean);
     const rows=base.filter(e=>view==='all'||(view==='seen')===isSeen(e)).filter(e=>{
      if(!words.length)return true;
      const hay=[e.work.title,e.work.venue,...e.people.map(p=>p.name)].join(' ').toLowerCase();
      return words.every(w=>hay.includes(w));
     });
     shownUnseen=rows.filter(e=>!isSeen(e));markAll.disabled=!shownUnseen.length;
     if(!rows.length){node('p',T(words.length?'검색어에 맞는 새 논문이 없습니다.':who?'이 저자의 해당 새 논문이 없습니다.':view==='new'?'확인하지 않은 새 논문이 없습니다.':'확인한 새 논문이 없습니다.'),box,{class:'sc-muted sc-inbox-empty'});more.hidden=true;return;}
     for(const entry of rows.slice(0,state.inboxAll?rows.length:12))drawInboxRow(entry,box,{byDOI,redraw:draw,toggle:async(entry,seen,row)=>{
      // The focus moves to the next paper's button, so a list is worked through from the keyboard.
      const index=[...box.children].indexOf(row),at=view==='all'?index+1:index;
      await setSeen(entry,!seen);
      if(disposed||state.tab!=='authors')return;
      refreshWatched();
      const buttons=[...body.querySelectorAll('.sc-inbox-seen')];
      // The last one handled: back to the view buttons, not lost in the page.
      (buttons[Math.max(0,at)]||buttons[buttons.length-1]||body.querySelector('.sc-inbox-tools [aria-pressed="true"]'))?.focus?.();
     }});
     if(rows.length>12)viewButton(state.inboxAll?'12편만 보기':`${rows.length}편 모두 보기`,()=>{state.inboxAll=!state.inboxAll;draw();},more);
     more.hidden=!more.childElementCount;
    };
    hook.redraw=draw;
    let typing=null;
    find.addEventListener('input',()=>{state.inboxQuery=find.value;win.clearTimeout(typing);typing=win.setTimeout(()=>{typing=null;draw();},120);});
    draw();
   }
   // Any script's letters survive the folding: a Korean name is a name, not nothing.
   const fold=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^\p{L}\s-]/gu,' ').replace(/\s+/g,' ').trim();
   const nameKey=name=>{const parts=fold(name).split(' ').filter(Boolean);return parts.length>1?parts[parts.length-1]+'|'+parts[0][0]:'';};
   /* A person's papers already in the library: the full name as the library
      spells it, or failing that family name and first initial, said to be a
      guess. */
   const papersBy=name=>{
    const whole=fold(name),key=nameKey(name);
    const names=item=>String(item.authors||'').split(';').map(n=>n.trim()).filter(Boolean);
    const exact=state.items.filter(item=>names(item).some(n=>fold(n)===whole));
    return exact.length?{items:exact,guess:false}:{items:state.items.filter(item=>key&&names(item).some(n=>nameKey(n)===key)),guess:true};
   };
   /* The same matching, as totals rather than a list, and built once over
      every item instead of once per watched author: the card grid used to
      keep its own held/exact maps and the table did not have this at all.
      A paper with more than one watched author on it counts for each of
      them -- the tooltip on every cell that uses this says so. */
   // When any of a person's matched papers were last read in the library, by the calendar.
   const authorStamp=v=>runtime.localStamp?runtime.localStamp(v)?.getTime():Date.parse(v||'');
   const calendarAgo=at=>{const start=new Date();start.setHours(0,0,0,0);return at>=start.getTime()?T('오늘 읽음'):T(`${Math.ceil((start.getTime()-at)/864e5)}일 전 읽음`);};
   const authorTotals=(()=>{
    const exact=new Map(),guess=new Map();
    const bump=(map,key,item)=>{if(!key)return;const e=map.get(key)||{n:0,done:0,unread:0,seconds:0,last:0};e.n++;
     if(item.status==='done')e.done++;else if(item.status!=='reading')e.unread++;
     e.seconds+=Number(item.seconds)||0;
     const at=authorStamp(item.lastRead);if(Number.isFinite(at)&&at>e.last)e.last=at;
     map.set(key,e);};
    for(const item of state.items){
     const names=String(item.authors||'').split(';').map(n=>n.trim()).filter(Boolean);
     for(const key of new Set(names.map(fold)))bump(exact,key,item);
     for(const key of new Set(names.map(nameKey)))bump(guess,key,item);
    }
    return {exact,guess};
   })();
   const statsFor=name=>{
    const whole=authorTotals.exact.get(fold(name));
    if(whole)return {...whole,guess:false};
    const g=authorTotals.guess.get(nameKey(name));
    return g?{...g,guess:true}:{n:0,done:0,unread:0,seconds:0,last:0,guess:false};
   };
   const COAUTHOR_NOTE=T('공동 저자로 실린 문헌은 관련된 관심 저자 모두에게 집계됩니다');
   // What a person has that is still to look at: their news less what the inbox has marked 확인함.
   const unseenWorks=person=>(person.news||[]).filter(work=>!isSeen({key:seenWorkKey(work)}));
   /* 관계: who among the followed authors writes with whom. Every edge is a
      paper two of them are both on, found in what is already held -- the news
      each one's last check kept (its stored author names) and the library's own
      author lists -- counted once per paper, so a paper that is both news and
      on the shelf is one. No request is made to draw it. */
   function authorLinks(watched){
    const byName=new Map();
    for(const person of watched){const key=fold(person.name);if(key&&!byName.has(key))byName.set(key,person);}
    const shared=new Map();
    const link=(people,key)=>{
     const list=[...new Set(people.filter(Boolean))];
     // A consortium paper names a crowd and says nothing about who works together.
     if(list.length<2||list.length>30)return;
     for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){
      const a=list[i],b=list[j],pair=a.id<b.id?a.id+'\u0000'+b.id:b.id+'\u0000'+a.id;
      if(!shared.has(pair))shared.set(pair,{source:a.id<b.id?a.id:b.id,target:a.id<b.id?b.id:a.id,keys:new Set()});
      shared.get(pair).keys.add(key);
     }
    };
    for(const person of watched)for(const work of person.news||[])
     link([person,...(work.people||[]).map(name=>byName.get(fold(name)))],'w:'+seenWorkKey(work));
    for(const item of state.items){
     const people=String(item.authors||'').split(';').map(name=>byName.get(fold(name.trim())));
     link(people,item.doi?'w:'+bareDOI(item.doi):'l:'+item.id);
    }
    return [...shared.values()].map(e=>({source:e.source,target:e.target,weight:e.keys.size}));
   }
   const GRAPH_LIMIT=40;
   function drawAuthorGraph(watched,parent,hook){
    const graphTools=runtime.graphTools;
    const open=runtime.cache.workbenchUI?.authorGraphOpen!==false;
    const edgesAll=authorLinks(watched);
    const head=sectionHead('관계',edgesAll.length?T(`공저 ${edgesAll.length}쌍`):'',parent);
    const toggle=viewButton(open?'접기':'펼치기',()=>{saveUI({authorGraphOpen:!open});refreshWatched();},head,{class:'sc-graph-toggle','aria-expanded':String(open),title:T('관심 저자 사이의 공저 관계')});
    if(!open||!graphTools?.layout)return;
    const wrap=node('div',null,parent,{class:'sc-author-graph-wrap'});
    const degree=new Map();
    for(const e of edgesAll){degree.set(e.source,(degree.get(e.source)||0)+1);degree.set(e.target,(degree.get(e.target)||0)+1);}
    const info=person=>{
     const mine=statsFor(person.name);
     return {person,lib:mine.guess?0:mine.n,fresh:unseenWorks(person).length};
    };
    const facts=new Map(watched.map(p=>[p.id,info(p)]));
    const activity=id=>(facts.get(id).lib+facts.get(id).fresh)+(degree.get(id)||0)*3;
    const focusID=state.authorFocus&&watched.some(p=>p.id===state.authorFocus)?state.authorFocus:'';
    if(state.authorFocus&&!focusID)state.authorFocus='';
    let nodes=watched.filter(p=>degree.get(p.id)||activity(p.id)>0);
    const all=nodes.length;
    const hidden=!state.authorGraphAll&&nodes.length>GRAPH_LIMIT;
    if(hidden){
     const connected=nodes.filter(p=>degree.get(p.id)).sort((a,b)=>activity(b.id)-activity(a.id));
     const rest=nodes.filter(p=>!degree.get(p.id)).sort((a,b)=>activity(b.id)-activity(a.id));
     nodes=[...connected,...rest].slice(0,GRAPH_LIMIT);
     const focusPerson=watched.find(p=>p.id===focusID);
     if(focusPerson&&!nodes.includes(focusPerson))nodes[nodes.length-1]=focusPerson;
    }
    const ids=new Set(nodes.map(p=>p.id));
    const edges=edgesAll.filter(e=>ids.has(e.source)&&ids.has(e.target));
    if(!edges.length){node('p',T('관심 저자 사이에 함께 쓴 논문이 아직 보이지 않습니다. 새 논문을 확인하면 공저 관계가 여기에 그려집니다.'),wrap,{class:'sc-muted sc-author-graph-empty'});return;}
    // The unlinked are left out of a drawing of links, unless the reader asks for everyone.
    if(!state.authorGraphAll){const linked=new Set(edges.flatMap(e=>[e.source,e.target]));nodes=nodes.filter(p=>linked.has(p.id)||p.id===focusID);}
    const bar=node('div',null,wrap,{class:'sc-author-graph-tools'});
    node('span',T(`${nodes.length}명 · 공저 ${edges.length}쌍`),bar,{class:'sc-muted'});
    if(all>nodes.length||state.authorGraphAll)viewButton(state.authorGraphAll?'활동 많은 저자만 보기':T(`모두 보기 (${watched.length}명)`),()=>{state.authorGraphAll=!state.authorGraphAll;refreshWatched();},bar,{class:'sc-graph-all','aria-pressed':String(!!state.authorGraphAll)});
    const W=graphWidth(),H=nodes.length>40?560:nodes.length>16?440:340;
    const maxAct=Math.max(1,...nodes.map(p=>activity(p.id)));
    const graphNodes=nodes.map(p=>({id:p.id,label:p.name,person:p,rank:activity(p.id)/maxAct,degree:degree.get(p.id)||0,rad:nodes.length>60?11:Math.round(12+7*Math.sqrt(activity(p.id)/maxAct))}));
    const laid=graphTools.layout({nodes:graphNodes,edges:edges.map(e=>({...e,weight:Math.min(1,e.weight/4),count:e.weight,kind:'co'}))},{width:W,height:H,pad:30,nodeRadius:n=>n.rad,gap:8});
    // The layout fits one scale to both axes; a wide frame is filled sideways, so the drawing uses its room.
    {const lo=Math.min(...laid.nodes.map(n=>n.x)),hi=Math.max(...laid.nodes.map(n=>n.x)),from=34,to=W-34;
     if(hi-lo>1&&hi-lo<to-from)for(const n of laid.nodes)n.x=from+(n.x-lo)*(to-from)/(hi-lo);}
    // The layout may shrink to fit; whatever it left touching is pushed apart inside the frame.
    for(let pass=0;pass<40;pass++){
     let moved=false;
     for(let i=0;i<laid.nodes.length;i++)for(let j=i+1;j<laid.nodes.length;j++){
      const a=laid.nodes[i],b=laid.nodes[j],want=a.rad+b.rad+6;
      let dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy);
      if(d>=want)continue;
      if(d<.01){dx=1;dy=0;d=1;}
      const push=(want-d)/2/d;a.x-=dx*push;a.y-=dy*push;b.x+=dx*push;b.y+=dy*push;moved=true;
     }
     for(const n of laid.nodes){n.x=Math.max(n.rad+4,Math.min(W-n.rad-4,n.x));n.y=Math.max(n.rad+4,Math.min(H-n.rad-4,n.y));}
     if(!moved)break;
    }
    for(const n of laid.nodes)n.r=n.rad;
    const positions=new Map(laid.nodes.map(n=>[n.id,n]));
    const near=new Map(laid.nodes.map(n=>[n.id,new Set()]));
    for(const e of edges){near.get(e.source)?.add(e.target);near.get(e.target)?.add(e.source);}
    const frame=node('div',null,wrap,{class:'sc-graph-frame'});
    const svg=doc.createElementNS(SVG,'svg');
    svg.setAttribute('viewBox',`0 0 ${W} ${H}`);svg.setAttribute('class','sc-graph sc-author-graph');
    svg.style.setProperty('--sc-graph-height',H+'px');
    svg.setAttribute('role','group');svg.setAttribute('aria-label',T('관심 저자 공저 관계 그래프'));
    frame.appendChild(svg);
    const defs=doc.createElementNS(SVG,'defs');svg.appendChild(defs);
    const lineLayer=doc.createElementNS(SVG,'g'),nodeLayer=doc.createElementNS(SVG,'g');svg.appendChild(lineLayer);svg.appendChild(nodeLayer);
    const lines=[];
    for(const e of edges){
     const a=positions.get(e.source),b=positions.get(e.target);
     const line=doc.createElementNS(SVG,'line');
     for(const [k,v] of Object.entries({x1:a.x,y1:a.y,x2:b.x,y2:b.y}))line.setAttribute(k,v);
     line.setAttribute('stroke','var(--sc-graph-line)');line.setAttribute('stroke-width',String(Math.min(6,1+e.weight*1.1)));
     line.setAttribute('data-a',e.source);line.setAttribute('data-b',e.target);
     const title=doc.createElementNS(SVG,'title');title.textContent=`${a.person.name} · ${b.person.name} · ${T(`함께 쓴 논문 ${e.weight}편`)}`;line.appendChild(title);
     lineLayer.appendChild(line);lines.push(line);
    }
    const marks=new Map();
    const order=laid.nodes.map(n=>n.id);
    let labelled=new Set();
    const place=()=>{
     const first=focusID?[focusID,...near.get(focusID)]:null;
     labelled=graphTools.placeLabels(laid.nodes,{width:W,height:H,lineHeight:14,pad:4,limit:Math.max(12,Math.min(40,laid.nodes.length)),first,avoidDots:true});
    };
    const tabbable=()=>focusID&&marks.has(focusID)?focusID:order[0];
    for(const n of laid.nodes){
     const g=doc.createElementNS(SVG,'g');
     g.setAttribute('transform',`translate(${n.x} ${n.y})`);g.setAttribute('role','button');g.setAttribute('aria-pressed','false');
     g.setAttribute('aria-label',n.person.name);g.setAttribute('data-author',n.id);
     const circle=doc.createElementNS(SVG,'circle');circle.setAttribute('r',n.rad);circle.setAttribute('class','sc-author-dot');g.appendChild(circle);
     const letters=doc.createElementNS(SVG,'text');letters.setAttribute('class','sc-author-initials');letters.setAttribute('text-anchor','middle');letters.setAttribute('y','4');letters.textContent=initials(n.person.name);g.appendChild(letters);
     const found=runtime.portraitOf?.(n.person.id);
     if(found?.url){
      const clip=doc.createElementNS(SVG,'clipPath');clip.setAttribute('id','sc-author-clip-'+n.id);
      const hole=doc.createElementNS(SVG,'circle');hole.setAttribute('r',n.rad-1);clip.appendChild(hole);defs.appendChild(clip);
      const img=doc.createElementNS(SVG,'image');img.setAttribute('href',found.url);img.setAttribute('x',-(n.rad-1));img.setAttribute('y',-(n.rad-1));img.setAttribute('width',(n.rad-1)*2);img.setAttribute('height',(n.rad-1)*2);
      img.setAttribute('preserveAspectRatio','xMidYMid slice');img.setAttribute('clip-path',`url(#sc-author-clip-${n.id})`);
      img.addEventListener('error',()=>img.remove());
      img.addEventListener('load',()=>{letters.setAttribute('display','none');});
      g.appendChild(img);
     }
     const ring=doc.createElementNS(SVG,'circle');ring.setAttribute('r',n.rad);ring.setAttribute('class','sc-author-ring');g.appendChild(ring);
     const backdrop=doc.createElementNS(SVG,'rect');backdrop.setAttribute('class','sc-graph-label-bg');backdrop.setAttribute('rx','6');g.appendChild(backdrop);
     const label=doc.createElementNS(SVG,'text');label.setAttribute('class','sc-graph-label');label.setAttribute('x',n.rad+4);label.setAttribute('y','3.5');label.textContent=n.person.name;g.appendChild(label);
     const title=doc.createElementNS(SVG,'title');const f=facts.get(n.id);
     title.textContent=[n.person.name,f.lib?T(`서재 ${f.lib}편`):'',f.fresh?T(`새 논문 ${f.fresh}편`):'',n.degree?T(`공저 ${n.degree}명`):''].filter(Boolean).join(' · ');g.appendChild(title);
     g.addEventListener('click',()=>choose(state.authorFocus===n.id?'':n.id));
     g.addEventListener('keydown',event=>{
      const at=order.indexOf(n.id);
      const go=index=>{event.preventDefault();const id=order[(index+order.length)%order.length];marks.get(id)?.g.focus?.();};
      if(event.key==='Enter'||event.key===' '){event.preventDefault();choose(state.authorFocus===n.id?'':n.id);}
      else if(event.key==='ArrowRight'||event.key==='ArrowDown')go(at+1);
      else if(event.key==='ArrowLeft'||event.key==='ArrowUp')go(at-1);
      else if(event.key==='Home')go(0);
      else if(event.key==='End')go(order.length-1);
     });
     marks.set(n.id,{g,circle,label,backdrop,n});
     nodeLayer.appendChild(g);
    }
    svg.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.authorFocus){event.preventDefault();event.stopPropagation();choose('');marks.get(tabbable())?.g.focus?.();}});
    // The backdrop is sized from the words under it, estimated when there is no layout to measure.
    for(const m of marks.values()){
     let w=0;try{w=m.label.getComputedTextLength?.()||0;}catch(_){w=0;}
     if(!w)w=graphTools.textWidth?graphTools.textWidth(m.n.person.name):m.n.person.name.length*6.5;
     for(const [k,v] of Object.entries({x:m.n.rad,y:-7,width:w+8,height:15}))m.backdrop.setAttribute(k,v);
    }
    const summary=node('div',null,wrap,{class:'sc-author-graph-info','aria-live':'polite'});
    const paint=()=>{
     const picked=state.authorFocus&&marks.has(state.authorFocus)?state.authorFocus:'';
     place();
     for(const line of lines){
      const on=!picked||line.getAttribute('data-a')===picked||line.getAttribute('data-b')===picked;
      line.setAttribute('stroke-opacity',on?(picked?.9:.55):.08);
     }
     for(const [id,m] of marks){
      const related=!picked||id===picked||near.get(picked).has(id);
      m.g.setAttribute('aria-pressed',String(id===picked));m.g.setAttribute('tabindex',id===tabbable()?'0':'-1');
      m.g.dataset.state=id===picked?'selected':related?(picked?'near':''):'dim';
      m.g.setAttribute('opacity',related?1:.35);
      const showLabel=labelled.has(id)&&(!picked||related);
      for(const el of [m.label,m.backdrop]){if(showLabel)el.removeAttribute('display');else el.setAttribute('display','none');}
     }
     // The summary: who, where, what is on the shelf, and the people they write with most.
     summary.replaceChildren();summary.hidden=!picked;
     if(!picked)return;
     const person=marks.get(picked).n.person,f=facts.get(picked);
     const top=node('div',null,summary,{class:'sc-author-graph-who'});
     watchFace(person,top);
     const names=node('div',null,top,{class:'sc-author-graph-name'});
     node('strong',person.name,names);
     placeLine(person,names);
     const figures=[f.lib?T(`서재 ${f.lib}편`):T('서재에 없음'),f.fresh?T(`새 논문 ${f.fresh}편`):T('새 논문 없음'),T(`공저 ${near.get(picked).size}명`)];
     node('p',figures.join(' · '),summary,{class:'sc-muted sc-author-graph-figures'});
     const mates=edges.filter(e=>e.source===picked||e.target===picked).map(e=>({id:e.source===picked?e.target:e.source,weight:e.weight})).sort((a,b)=>b.weight-a.weight).slice(0,5);
     if(mates.length){
      const line=node('div',null,summary,{class:'sc-author-graph-mates'});
      node('span',T('자주 함께'),line,{class:'sc-muted'});
      for(const mate of mates){
       const who=positions.get(mate.id).person;
       const b=button('',()=>choose(mate.id),line,{class:'sc-author-graph-mate',title:T(`${who.name} 선택`)});
       node('span',who.name,b,{class:'sc-mate-name'});node('span','×'+mate.weight,b,{class:'sc-count'});
      }
     }
     const actions=node('div',null,summary,{class:'sc-actions'});
     button('이 저자 보기',()=>run(()=>show(person)),actions);
     button('선택 해제',()=>choose(''),actions);
    };
    function choose(id){
     state.authorFocus=id||'';
     paint();hook.redraw?.();
     const who=id&&positions.get(id)?.person;
     message(who?T(`${who.name} · 새 논문 목록을 이 저자로 좁혔습니다.`):T('저자 선택을 풀었습니다.'));
    }
    hook.sync=()=>{if(svg.isConnected)paint();};
    paint();
   }
   function drawWatched(parent){
    // Those with most still to look at first; the runtime's order counts news already seen.
    const watched=runtime.watchedAuthorsByNews().map((person,index)=>({person,index,left:unseenWorks(person).length}))
     .sort((a,b)=>b.left-a.left||a.index-b.index).map(x=>x.person);
    if(!watched.length)return;
    const swept=watched.some(person=>person.sweptAt);
    const fresh=watched.filter(person=>unseenWorks(person).length);
    const head=node('div',null,parent,{class:'sc-watch-head'});
    // The toolbar says what is waiting (the groups below carry the names and their counts); with nothing to say it has no heading.
    // The same count as the list below: a paper two of them share is one paper.
    const news=mergedNews(watched),unseenNews=news.filter(e=>!isSeen(e));
    if(fresh.length){const heading=node('h3',null,head,{class:'sc-hit-group'});
     node('span',unseenNews.length?T(`확인 안 한 새 논문 ${unseenNews.length}편`):T('새 논문 모두 확인함'),heading,{class:'sc-watch-count','data-state':unseenNews.length?'new':'done'});}
    const tools=node('div',null,head,{class:'sc-watch-tools'});
    button(swept?'새 논문 다시 확인':'새 논문 한 번에 확인',()=>run(async()=>{
     message(`관심 저자 ${watched.length}명의 새 논문을 확인하는 중…`);
     const result=await runtime.sweepWatchedAuthors({onProgress:(done,total)=>
      message(`새 논문 확인 중 ${done+1}/${total}`)});
     if(token!==epoch||disposed||state.tab!=='authors')return;
     refreshWatched();
     message(T(result.budgetGone
      ? `OpenAlex 하루 한도를 다 썼습니다. ${result.remaining}묶음이 남았고, 한국 시간 오전 9시에 초기화됩니다. 지금까지 확인한 결과는 저장했습니다.`
      : result.withNews
       /* What this run turned up and what is still waiting are two answers.
          Reporting only the second made a week in which nothing happened read
          exactly like one in which something did. */
       ? result.added
        ? `새로 찾은 논문 ${result.added}편 · 확인 안 한 논문 ${result.works}편 · ${result.withNews}명. 요청 ${result.requests}회.`
        : `새로 찾은 논문은 없습니다. 확인 안 한 논문 ${result.works}편이 ${result.withNews}명에게 남아 있습니다.`
       : `새 논문은 없습니다. 저자 ${result.authors}명을 요청 ${result.requests}회로 확인했습니다.`)
      +(result.failed?' '+T(`${result.failed}명은 서버 오류로 확인하지 못해 이전 소식을 그대로 두었습니다. 다시 확인을 누르세요.`):'')
      +(result.unfinished?' '+T(`${result.unfinished}명은 논문이 많아 끝까지 읽지 못했습니다. 다음 확인이 이어서 봅니다.`):''),
      result.budgetGone||!!result.failed);
     /* Faces follow the news without a second press: only for people never
        looked for or due again, off the OpenAlex budget, in the background. */
     if(!result.budgetGone&&runtime.pref?.('authorPortraits',true)!==false&&runtime.portraitsDue?.()>0){
      runtime.findWatchedPortraits().then(found=>{
       if(disposed||state.tab!=='authors'||!found?.found)return;
       refreshWatched();
      }).catch(error=>runtime.Z.logError?.(error));
     }
    }),tools);
    /* Faces for everyone on the list at once: Wikidata first (a freely licensed
       photograph, by ORCID), then each person's own pages. About two dozen
       requests for a hundred people; what is found stays for two months. */
    if(typeof runtime.findWatchedPortraits==='function'&&runtime.pref?.('authorPortraits',true)!==false){
     const withFace=watched.filter(person=>runtime.portraitOf?.(person.id)).length;
     button(withFace?`사진 다시 찾기 (${withFace}명 있음)`:'사진 찾기',()=>run(async()=>{
      message('관심 저자의 사진을 찾는 중… Wikidata, Google Scholar, 각자의 홈페이지를 확인합니다.');
      const result=await runtime.findWatchedPortraits({onProgress:(stage,done,total)=>
       message(stage==='wikidata'?`Wikidata에서 찾는 중 ${Math.min(done+15,total)}/${total}`:`홈페이지에서 찾는 중 ${done+1}/${total}`)});
      if(token!==epoch||disposed||state.tab!=='authors')return;
      refreshWatched();
      const total=watched.filter(person=>runtime.portraitOf?.(person.id)).length;
      message(!result.asked
       ? `확인할 사람이 없습니다. 사진이 있는 ${total}명 외에는 최근 두 달 안에 이미 찾아봤습니다.`
       : `사진 ${total}명 · 이번에 찾음 ${result.found}명 (Wikimedia ${result.wikimedia} · Google Scholar ${result.scholar||0} · 홈페이지 ${result.homepage}) · 요청 ${result.requests}회`
         +(result.busy?' · Wikidata가 요청을 제한해 일부는 다음에 다시 찾습니다.':''),
       result.busy);
     }),tools);
    }
    /* "새 논문 없음" is an answer about everybody, so it waits until everybody
       has been asked. It used to appear as soon as one person had been swept,
       over a list where the rest had never been looked at. */
    const unchecked=watched.filter(person=>!person.sweptAt).length;
    if(!fresh.length&&swept)node('span',unchecked?T(`확인 전 ${unchecked}명`):T('새 논문 없음'),tools,{class:'sc-watch-quiet'});
    /* The people with something to say come first, and the quiet ones fold.

       This used to be a chip the reader had to find and press, so opening the
       tab with a hundred and nine followed authors put a hundred quiet cards
       above everything else -- the whole page was names, and the ten that
       mattered were somewhere inside it. Whoever has an unread paper, a new
       filing or a move is shown; the rest sit behind one button. */
    /* 카드 / 표 is one segmented choice, not a dark button that changes its own name. */
    const viewSwitch=node('div',null,tools,{class:'sc-segmented sc-watch-view',role:'group','aria-label':T('저자 보기 방식')});
    for(const [manageOn,label] of [[false,'카드로 보기'],[true,'목록 관리']])button(label,()=>{if(!!state.watchManage===manageOn)return;state.watchManage=manageOn;refreshWatched();},viewSwitch,{'aria-pressed':String(!!state.watchManage===manageOn)});
    if(state.watchManage){drawWatchManager(watched,parent);return;}
    // A grid, not a column: at this panel width one name per row turned a
    // hundred people into a scroll, and the whole point is to see them at once.
    sectionHead('관심 저자',watched.length,parent);
    const hasNews=person=>!!(unseenWorks(person).length||person.newPatents?.length||(person.moved&&person.moved.to));
    const loud=watched.filter(hasNews),quiet=watched.filter(person=>!hasNews(person));
    // Quiet authors stay folded whether or not any news is left (marking the last one seen must not open 109 cards); only the reader's press shows them.
    const folding=quiet.length>0;
    const shown=folding&&!state.watchQuietOpen?loud:watched;
    const rows=node('div',null,parent,{class:'sc-watch-grid'});
    for(const person of shown){
     // The badge counts what is still to look at, as the inbox does.
     const left=unseenWorks(person),count=left.length;
     const row=node('div',null,rows,{class:'sc-watch'+(count?' sc-watch-new':'')});
     row.setAttribute('role','button');row.tabIndex=0;
     const open=()=>run(()=>show(person));
     row.addEventListener('click',open);
     row.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}});
     watchFace(person,row);
     const line=node('div',null,row,{class:'sc-watch-line'});
     node('span',person.name,line,{class:'sc-watch-name'});
     /* The name's own line carries what is new about the person, at its right: a labelled badge, never a bare number. */
     /* The full name, when the library spells it the same way; otherwise the
        family name and first initial, which can take in a namesake, and says
        it is a guess. */
     const stats=statsFor(person.name);
     const mineHost=node('span',null,null);
     if(stats.n&&!stats.guess)node('span',T(`서재 ${stats.n}`),mineHost,{class:'sc-watch-mine',title:T(`내 서재에 이 저자의 문헌 ${stats.n}편 · 완료 ${stats.done}편 (이름 전체가 같은 문헌) · `)+COAUTHOR_NOTE});
     else if(stats.n)node('span',T(`서재 ${stats.n}?`),mineHost,{class:'sc-watch-mine',title:T(`성과 이름 첫 글자가 같은 문헌 ${stats.n}편 · 완료 ${stats.done}편 · 같은 이름의 다른 사람이 섞였을 수 있습니다 · `)+COAUTHOR_NOTE});
     if(count)node('span',T(`새 논문 ${count}`),line,{class:'sc-watch-badge',title:`확인 안 한 새 논문 ${count}편`});
     const patents=person.newPatents?.length||0;
     if(patents)node('span',T(`특허 ${patents}`),line,{class:'sc-watch-badge sc-watch-patent',title:`마지막 확인 이후 새 특허 ${patents}건`});
     // With news, the line says what the news is; without it, who they are.
     const latest=count?left[0]:null;
     /* A move is its own small amber badge and a muted line of where; it no longer
        replaces the line about the latest paper, which is what the reader came for. */
     const moved=person.moved&&person.moved.to?person.moved:null;
     let sub=null;
     if(latest){
      sub=node('span',null,row,{class:'sc-watch-sub'});
      if(latest.date)sub.appendChild(doc.createTextNode(latest.date.slice(0,7)+' · '));
      if(latest.venue)inkJournal(node('span',latest.venue,sub,{class:'sc-watch-venue'}),String(latest.venue).trim());
      else sub.appendChild(doc.createTextNode(latest.title||''));
      sub.title=`${latest.title||''}${latest.venue?' · '+latest.venue:''}`;
     }
     if(moved){
      const mv=node('span',null,row,{class:'sc-watch-sub sc-watch-move'});
      node('span',T('소속 이동'),mv,{class:'sc-status-chip','data-tone':'amber'});
      node('span',`${moved.from||'?'} → ${moved.to}`,mv,{class:'sc-watch-moved-text'});
      mv.title=moved.since?`소속이 바뀐 것으로 보입니다 · ${moved.since}년부터 · ${moved.at||''} 확인 · OpenAlex 저자 기록의 현재 소속 기준`:`소속이 바뀐 것으로 보입니다 · ${moved.at||''} 확인 · OpenAlex 저자 기록의 현재 소속 기준`;
     }
     if(!moved&&!latest){sub=node('span',null,row,{class:'sc-watch-sub'});const where=runtime.placeOf?.(person.institution);if(where?.flag)node('span',where.flag,sub,{class:'sc-flag','aria-hidden':'true'});node('span',person.institution||'소속 미확인',sub);sub.title=person.institution||'';}
     /* What the shelf holds of them rides the end of the first detail line, so the name line keeps its room for the badges. */
     if(mineHost.firstChild){const first=row.querySelector('.sc-watch-sub');if(first){const subline=node('div',null,null,{class:'sc-watch-subline'});row.insertBefore(subline,first);subline.appendChild(first);subline.appendChild(mineHost.firstChild);}}
     row.title=count?`${person.name} · 새 논문 ${count}편`
      :person.sweptAt?`${person.name} · 새 논문 없음 (확인 ${person.sweptAt.slice(0,10)})`
      :`${person.name} · 아직 확인하지 않음`;
    }
    // The quiet ones are one press away, and the press says how many.
    if(folding)button(state.watchQuietOpen?T('조용한 저자 접기'):T(`조용한 저자 ${quiet.length}명 보기`),
     ()=>{state.watchQuietOpen=!state.watchQuietOpen;refreshWatched();},parent,
     {class:'sc-local-reading-more','aria-expanded':String(!!state.watchQuietOpen)});
    /* After the people: how they connect, and the papers they have written
       since you looked. The map narrows the list below it to one person. */
    const hook={};
    drawAuthorGraph(watched,parent,hook);
    drawAuthorInbox(watched,parent,hook);
    drawNamesakeGroup(watched,parent);
   }
   /* The followed authors as a list to keep in order: find one by name or
      place, sort by who has news or who was checked longest ago, let one go
      with a click, copy the whole list out. A hundred cards are for
      noticing; this is for tending. */
   /* The followed list as a table to tend. The toolbar is built once and
      only the rows are redrawn as the reader types, so Korean composition is
      not cut off mid-syllable by a rebuilt input. */
   const WATCH_GROUPS=[['none','없음'],['place','소속'],['tier','티어'],['country','국가'],['field','분야']];
   const WATCH_FACETS=[['tier','티어'],['country','국가'],['field','분야']];
   const FIELD_FOLD=18;
   // "University of Zurich" and "Zurich University" are one place; so are a name and the same name in brackets.
   const placeKey=name=>{
    let text=fold(String(name||'').replace(/\([^)]*\)/g,' ')).replace(/^the\s+/,'');
    const m=text.match(/^university of (.+)$/);if(m)text=m[1]+' university';
    return text.replace(/\s+/g,' ').trim();
   };
   // The four things a followed author can be grouped or filtered by, from what is already held about them.
   function watchAttributes(person){
    const where=runtime.placeOf?.(person.institution)||null;
    const field=String(person.subfield||person.field||'').trim();
    const none={key:'~',label:T('미상'),unknown:true};
    return {
     tier:where?.tier?.label?{key:where.tier.label,label:where.tier.label,note:where.tier.note}:none,
     country:where?.country?{key:where.country,label:`${where.flag?where.flag+' ':''}${countryLabel(where.country)}`}:none,
     field:field?{key:fold(field)||field,label:field}:{...none,label:T('분야 미상')},
     place:person.institution&&placeKey(person.institution)?{key:placeKey(person.institution),label:String(person.institution).replace(/\s*\([^)]+\)\s*$/,'').trim()||person.institution}:{...none,label:T('소속 미상')}
    };
   }
   const watchOptions=()=>{
    const ui=runtime.cache.workbenchUI||{};
    if(state.watchGroup===undefined)state.watchGroup=WATCH_GROUPS.some(([k])=>k===ui.watchGroup)?ui.watchGroup:'none';
    if(!state.watchFilters){state.watchFilters={};for(const [dim] of WATCH_FACETS)state.watchFilters[dim]=new Set(Array.isArray(ui.watchFilters?.[dim])?ui.watchFilters[dim].map(String):[]);}
    if(!state.watchClosed)state.watchClosed=new Set(Array.isArray(ui.watchClosed)?ui.watchClosed.map(String):[]);
    return state;
   };
   const saveWatchOptions=()=>saveUI({watchGroup:state.watchGroup,watchFilters:Object.fromEntries(WATCH_FACETS.map(([dim])=>[dim,[...state.watchFilters[dim]]])),watchClosed:[...state.watchClosed]});
   const watchApi={};
   function drawWatchManager(watched,parent){
    watchOptions();
    const tools=bar(parent);
    const search=node('input',null,tools,{type:'search',placeholder:'이름·소속으로 찾기','aria-label':'관심 저자 찾기'});search.value=state.watchQuery||'';
    const pick=node('select',null,tools,{'aria-label':'관심 저자 정렬'});
    for(const [value,label] of [['news','새 소식 순'],['name','이름순'],['place','소속순'],['checked','오래 안 본 순'],['added','최근 등록 순'],['time','읽은 시간순'],['unread','안 읽음 많은 순'],['recent','최근 읽은 순']]){const o=node('option',label,pick,{value});if((state.watchSort||'news')===value)o.selected=true;}
    node('span',T('묶어 보기'),tools,{class:'sc-watch-grouping-label'});
    const grouping=node('div',null,tools,{class:'sc-segmented sc-watch-grouping',role:'group','aria-label':T('묶어 보기')});
    const groupButtons=new Map();
    for(const [key,label] of WATCH_GROUPS)groupButtons.set(key,button(label,()=>{state.watchGroup=key;saveWatchOptions();for(const [k,b] of groupButtons)b.setAttribute('aria-pressed',String(k===key));redraw();},grouping,{'aria-pressed':String(state.watchGroup===key),'data-group':key}));
    const count=node('span','',tools,{class:'sc-muted'});
    button('목록 복사',()=>copy(watched.map(p=>[p.name,p.institution||'',p.id].join('\t')).join('\n')),tools,{title:'이름 · 소속 · OpenAlex id, 탭으로 구분'});
    const facets=node('div',null,parent,{class:'sc-watch-facets'});
    const host=node('div',null,parent,{class:'sc-watch-table-host'});
    const redraw=()=>{host.replaceChildren();drawWatchTable(watched,host,count,facets);};
    search.addEventListener('input',()=>{state.watchQuery=search.value;redraw();});
    search.addEventListener('compositionend',()=>{state.watchQuery=search.value;redraw();});
    pick.addEventListener('change',()=>{state.watchSort=pick.value;redraw();});
    watchApi.redraw=redraw;
    /* A follower's panel opens right under their row. The one whose panel is
       open is chosen from anywhere (a co-author chip in another panel), so if
       a search or a filter has hidden them it is dropped rather than leaving
       the reader looking at nothing. */
    watchApi.expand=person=>{
     const attrs=watchAttributes(person);
     const hidden=!model.matches(`${person.name} ${person.institution||''} ${person.institutionGiven||''}`,String(state.watchQuery||''))
      ||WATCH_FACETS.some(([dim])=>state.watchFilters[dim].size&&!state.watchFilters[dim].has(attrs[dim].key));
     if(hidden){state.watchQuery='';search.value='';for(const [dim] of WATCH_FACETS)state.watchFilters[dim].clear();saveWatchOptions();}
     state.watchOpen=person.id;
     const group=`${state.watchGroup}:${attrs[state.watchGroup]?.key}`;
     if(state.watchClosed.delete(group))saveWatchOptions();
     redraw();
     const panel=host.querySelector('.sc-watch-expand-body');
     panel?.focus?.();panel?.scrollIntoView?.({block:'nearest'});
    };
    redraw();
   }
   // One row of the table: the person, what the library holds of them, and what is new.
   function drawWatchRow(person,tbody,maxSeconds){
    const tr=node('tr',null,tbody,{'data-author-id':person.id,class:'sc-watch-row'});
    const nameCell=node('td',null,tr,{class:'sc-col-name'});
    const who=node('span',null,nameCell,{class:'sc-watch-who'});
    node('span',null,who,{class:'sc-watch-chevron','aria-hidden':'true'});
    watchFace(person,who);
    const open=node('button',person.name,who,{class:'sc-journal-name',type:'button',title:`${person.name} · ${T('눌러서 펼치기')}`,'aria-expanded':String(state.watchOpen===person.id)});
    const place=node('td',null,tr,{class:'sc-col-place'});
    const line=placeLine(person,place);
    if(person.institutionGiven&&person.institutionGiven!==person.institution)line.title+=` · 등록 당시: ${person.institutionGiven}`;
    if(person.moved&&person.moved.to)place.classList.add('sc-watch-moved');
    // 보유·완료·안 읽음: three fixed columns near 800px width crushed name
    // and affiliation, so they share one cell now, still matched by name
    // against the library, and a guessed match is marked.
    const stats=statsFor(person.name);
    const parts=[];
    if(stats.n)parts.push(T(`보유 ${stats.n}${stats.guess?'?':''}`));
    if(stats.done)parts.push(T(`완료 ${stats.done}`));
    if(stats.unread)parts.push(T(`안 읽음 ${stats.unread}`));
    if(stats.last)parts.push(calendarAgo(stats.last));
    /* The chip is inside the cell, not the cell itself: a badge class on the td
       made it inline-flex, which pulled it out of the table row's middle line. */
    const readCell=node('td',null,tr,{class:'sc-col-reading'+(parts.length?'':' sc-none'),title:parts.length?(stats.guess?T('성과 이름 첫 글자만 같아 짐작한 값입니다 · ')+COAUTHOR_NOTE:COAUTHOR_NOTE):''});
    if(parts.length)node('span',parts.join(' · '),readCell,{class:'sc-cell-chip'});else noneMark(readCell);
    const timeCell=node('td',null,tr,{class:'sc-col-time'});
    if(stats.seconds){
     node('span',runtime.formatReadTime?runtime.formatReadTime(stats.seconds,{compact:true}):Math.round(stats.seconds/60)+'분',timeCell,{class:'sc-watch-time-text'});
     const meter=node('span',null,timeCell,{class:'sc-watch-time-bar',role:'img','aria-label':T(`읽은 시간 ${runtime.formatReadTime?runtime.formatReadTime(stats.seconds,{compact:true}):Math.round(stats.seconds/60)+'분'}`),title:COAUTHOR_NOTE});
     node('span',null,meter,{class:'sc-watch-time-fill'}).style.width=Math.round(100*stats.seconds/maxSeconds)+'%';
    } else noneMark(timeCell);
    /* The same source as the opened panel (the stored sweep), so the row and the detail cannot disagree. */
    const dateCell=node('td',null,tr,{class:'sc-col-date'+(person.sweptAt?'':' sc-none')});
    if(person.sweptAt)dateCell.textContent=person.sweptAt.slice(0,10);else node('span',T('아직 없음'),dateCell,{class:'sc-none-mark'});
    const news=unseenWorks(person).length;const newsCell=node('td',null,tr,{class:'sc-col-n'+(news?'':' sc-none')});if(news)node('span',String(news),newsCell,{class:'sc-cell-number sc-cell-new',title:`확인 안 한 새 논문 ${news}편`});else noneMark(newsCell);
    const patents=person.patents?.length||0;
    const patentCell=node('td',null,tr,{class:'sc-col-n'+(patents?'':' sc-none')});
    if(patents)patentCell.textContent=String(patents)+(person.newPatents?.length?` · ${T('새')} ${person.newPatents.length}`:'');else noneMark(patentCell);
    const act=node('td',null,tr,{class:'sc-col-act'});
    // Letting someone go drops their baseline and news: the first press only arms the button.
    const off=button('해제',()=>{
     if(!off.dataset.armed){off.dataset.armed='1';off.textContent=T('정말 해제');win.setTimeout(()=>{if(off.isConnected){delete off.dataset.armed;off.textContent=T('해제');}},3000);return;}
     return run(async()=>{await unfollow(person,refreshWatched);message(`${person.name}을(를) 관심 저자에서 뺐습니다.`);refreshWatched();});
    },act,{title:'관심 저자에서 빼기',class:'sc-unwatch'});
    // The whole row opens the person under it; its own buttons keep their own meaning.
    tr.addEventListener('click',e=>{if(e.target.closest('button:not(.sc-journal-name),a,input,select'))return;toggleWatchOpen(person,tr);});
    if(state.watchOpen===person.id)mountWatchExpansion(person,tr,{animate:false});
    return tr;
   }
   /* The panel under a row: one table row spanning every column, so what a
      row folds away opens in place instead of replacing the page below. */
   function mountWatchExpansion(person,tr,{animate=true}={}){
    tr.classList.add('sc-watch-open');
    tr.querySelector('.sc-journal-name')?.setAttribute('aria-expanded','true');
    const row=doc.createElementNS(HTML,'tr');row.className='sc-watch-expand';row.dataset.authorId=person.id;
    if(!animate)row.dataset.settled='true';
    // As many columns as are showing: a narrow panel hides some, and a span wider than the table grows empty ones.
    const table=tr.parentNode.closest('table');
    const columns=()=>{
     const heads=[...(table?.querySelectorAll('thead th')||[])];
     if(!heads.length)return 8;
     let shown=heads.length;
     try{shown=heads.filter(th=>win.getComputedStyle(th).display!=='none').length||heads.length;}catch(_){}
     return shown;
    };
    const cell=node('td',null,row,{colspan:String(columns())});
    if(table&&typeof win.ResizeObserver==='function'){try{new win.ResizeObserver(()=>{const n=String(columns());if(cell.getAttribute('colspan')!==n)cell.setAttribute('colspan',n);}).observe(table);}catch(_){}}
    const panel=node('div',null,cell,{class:'sc-watch-expand-body',tabindex:'-1',role:'region','aria-label':T(`${person.name} 상세`)});
    tr.after(row);
    const opts={inline:true,expand:p=>watchApi.expand?.(p)};
    renderPerson(person,panel,opts).catch(error=>runtime.Z.logError?.(error));
    return panel;
   }
   function closeWatchOpen({focus=true}={}){
    const id=state.watchOpen;state.watchOpen='';
    for(const row of watchArea.querySelectorAll('tr.sc-watch-expand'))row.remove();
    for(const tr of watchArea.querySelectorAll('tr.sc-watch-open')){tr.classList.remove('sc-watch-open');tr.querySelector('.sc-journal-name')?.setAttribute('aria-expanded','false');}
    if(focus&&id)[...watchArea.querySelectorAll('tr.sc-watch-row')].find(tr=>tr.dataset.authorId===id)?.querySelector('.sc-journal-name')?.focus?.();
   }
   function toggleWatchOpen(person,tr){
    if(state.watchOpen===person.id){closeWatchOpen();return;}
    closeWatchOpen({focus:false});
    state.watchOpen=person.id;
    const panel=mountWatchExpansion(person,tr);
    panel.focus?.();panel.scrollIntoView?.({block:'nearest'});
   }
   function drawWatchTable(watched,host,count,facetHost){
    const q=String(state.watchQuery||'');
    const sort=state.watchSort||'news';
    // The library-match stats behind 보유/완료/안 읽음/읽은 시간: one lookup
    // per person against the totals built once in authorTotals above.
    const order={news:(a,b)=>(unseenWorks(b).length+(b.newPatents?.length||0))-(unseenWorks(a).length+(a.newPatents?.length||0))||a.name.localeCompare(b.name),name:(a,b)=>a.name.localeCompare(b.name),place:(a,b)=>String(a.institution||'').localeCompare(String(b.institution||''))||a.name.localeCompare(b.name),checked:(a,b)=>String(a.sweptAt||'').localeCompare(String(b.sweptAt||''))||a.name.localeCompare(b.name),added:(a,b)=>String(b.checkedAt||'').localeCompare(String(a.checkedAt||'')),
     time:(a,b)=>statsFor(b.name).seconds-statsFor(a.name).seconds||a.name.localeCompare(b.name),
     unread:(a,b)=>statsFor(b.name).unread-statsFor(a.name).unread||a.name.localeCompare(b.name),
     recent:(a,b)=>statsFor(b.name).last-statsFor(a.name).last||a.name.localeCompare(b.name)}[sort];
    const attrs=new Map(watched.map(p=>[p.id,watchAttributes(p)]));
    const filters=state.watchFilters;
    const passes=(p,skip='')=>WATCH_FACETS.every(([dim])=>dim===skip||!filters[dim].size||filters[dim].has(attrs.get(p.id)[dim].key));
    const base=watched.filter(p=>model.matches(`${p.name} ${p.institution||''} ${p.institutionGiven||''}`,q));
    const shown=base.filter(p=>passes(p)).sort(order);
    const active=WATCH_FACETS.reduce((n,[dim])=>n+filters[dim].size,0);
    count.textContent=`${shown.length}/${watched.length}`+T('명');
    // Filters: several values of one kind add up, kinds narrow each other, and every count is what pressing it would leave.
    facetHost.replaceChildren();
    for(const [dim,label] of WATCH_FACETS){
     const tally=new Map();
     // Every value stays listed, so the row of chips does not rearrange itself as they are pressed; one that would leave nobody reads 0.
     for(const p of base){const a=attrs.get(p.id)[dim];const e=tally.get(a.key)||{...a,n:0};if(passes(p,dim))e.n++;tally.set(a.key,e);}
     for(const key of filters[dim])if(!tally.has(key)){const a=[...attrs.values()].map(x=>x[dim]).find(x=>x.key===key);if(a)tally.set(key,{...a,n:0});}
     let options=[...tally.values()].sort((a,b)=>(a.unknown?1:0)-(b.unknown?1:0)||(dim==='tier'?a.key.localeCompare(b.key):b.n-a.n||a.label.localeCompare(b.label)));
     const known=options.filter(o=>!o.unknown);
     const line=node('div',null,facetHost,{class:'sc-watch-facet','data-facet':dim});
     node('span',T(label),line,{class:'sc-watch-facet-label'});
     if(dim==='field'&&!known.length){node('span',T('분야는 다음 새 논문 확인 때 채워집니다'),line,{class:'sc-muted sc-watch-facet-note'});continue;}
     if(known.length<1&&!options.some(o=>filters[dim].has(o.key)))continue;
     const cap=dim==='field'&&!state.watchFieldAll&&options.length>FIELD_FOLD?options.filter((o,i)=>i<FIELD_FOLD||filters[dim].has(o.key)):options;
     const chips=node('div',null,line,{class:'sc-watch-facet-chips'});
     for(const o of cap){
      const chip=button('',()=>{if(filters[dim].has(o.key))filters[dim].delete(o.key);else filters[dim].add(o.key);saveWatchOptions();watchApi.redraw();},chips,{class:'sc-chip-button sc-watch-chip','aria-pressed':String(filters[dim].has(o.key)),title:o.note||''});
      if(!o.n)chip.dataset.empty='true';
      withCount(chip,o.label,o.n);
     }
     if(cap.length<options.length)viewButton(T(`${options.length-cap.length}개 더 보기`),()=>{state.watchFieldAll=true;watchApi.redraw();},chips,{class:'sc-quiet-action sc-watch-facet-more'});
     else if(dim==='field'&&state.watchFieldAll&&options.length>FIELD_FOLD)viewButton(T('접기'),()=>{state.watchFieldAll=false;watchApi.redraw();},chips,{class:'sc-quiet-action sc-watch-facet-more'});
    }
    if(active)button('필터 지우기',()=>{for(const [dim] of WATCH_FACETS)filters[dim].clear();saveWatchOptions();watchApi.redraw();},facetHost,{class:'sc-quiet-action sc-watch-clear'});
    facetHost.hidden=!facetHost.childElementCount;
    // One scale for every reading-time bar in the table, from what is actually shown.
    const maxSeconds=Math.max(1,...shown.map(p=>statsFor(p.name).seconds));
    const heads=[['이름','sc-col-name',''],['소속','sc-col-place',''],['읽기 상태','sc-col-reading',COAUTHOR_NOTE],['읽은 시간','sc-col-time',COAUTHOR_NOTE],['마지막 확인','sc-col-date',''],['새 논문','sc-col-n','확인 안 한 새 논문 (편)'],['특허','sc-col-n','특허 (건)'],['','sc-col-act','']];
    const makeTable=(parent,people,index=0)=>{
     const table=node('table',null,parent,{class:'sc-watch-table'+(index?' sc-watch-table-continued':'')});
     const thead=node('thead',null,table);const head=node('tr',null,thead);
     for(const [label,cls,title] of heads){const a={scope:'col',class:cls};if(title)a.title=title;node('th',label,head,a);}
     const tbody=node('tbody',null,table);
     for(const person of people)drawWatchRow(person,tbody,maxSeconds);
     return table;
    };
    const mode=state.watchGroup||'none';
    if(mode==='none'||!shown.length){
     if(shown.length)makeTable(host,shown);
    } else {
     const groups=new Map();
     for(const p of shown){const a=attrs.get(p.id)[mode];const g=groups.get(a.key)||{...a,people:[]};g.people.push(p);groups.set(a.key,g);}
     // A place's name is the one most of its members use.
     if(mode==='place')for(const g of groups.values()){const seen=new Map();for(const p of g.people){const l=attrs.get(p.id).place.label;seen.set(l,(seen.get(l)||0)+1);}g.label=[...seen.entries()].sort((a,b)=>b[1]-a[1])[0][0]||g.label;}
     const ordered=[...groups.values()].sort((a,b)=>(a.unknown?1:0)-(b.unknown?1:0)||(mode==='tier'?a.key.localeCompare(b.key):b.people.length-a.people.length||a.label.localeCompare(b.label)));
     const known=watched.filter(p=>!attrs.get(p.id)[mode].unknown).length;
     ordered.forEach((g,index)=>{
      const id=`${mode}:${g.key}`;
      const closed=state.watchClosed.has(id);
      const box=node('section',null,host,{class:'sc-group sc-watch-group','data-group-key':g.key,'data-open':String(!closed)});
      const h=node('h3',null,box,{class:'sc-hit-group sc-section-head sc-watch-group-head'});
      const toggle=node('button',null,h,{type:'button',class:'sc-watch-group-toggle','aria-expanded':String(!closed)});
      node('span',null,toggle,{class:'sc-watch-chevron','aria-hidden':'true'});
      node('span',g.label,toggle,{class:'sc-section-head-name'});
      toggle.appendChild(doc.createTextNode(' '));
      node('span',T(`${g.people.length}명`),toggle,{class:'sc-section-head-count'});
      const fresh=new Set(g.people.flatMap(p=>unseenWorks(p).map(w=>seenWorkKey(w)))).size; // a paper by two followed authors counts once
      if(fresh){toggle.appendChild(doc.createTextNode(' '));}
      if(fresh)node('span',T(`새 논문 ${fresh}`),toggle,{class:'sc-watch-group-new'});
      const notes=[];
      if(g.note)notes.push(g.note);
      if(mode==='field'||mode==='tier'||mode==='country')if(known<watched.length)notes.push(T(mode==='field'?`분야를 아는 저자 ${known}/${watched.length}명`:mode==='tier'?`티어를 아는 저자 ${known}/${watched.length}명`:`국가를 아는 저자 ${known}/${watched.length}명`));
      if(g.unknown&&mode==='field')notes.push(T('다음 새 논문 확인 때 OpenAlex 주제에서 채워집니다'));
      if(notes.length)toggle.title=notes.join(' · ');
      const holder=node('div',null,box,{class:'sc-watch-group-body'});holder.hidden=closed;
      makeTable(holder,g.people,index);
      toggle.addEventListener('click',()=>{
       const now=state.watchClosed.has(id);
       if(now)state.watchClosed.delete(id);else state.watchClosed.add(id);
       holder.hidden=!now;box.dataset.open=String(now);toggle.setAttribute('aria-expanded',String(now));
       saveWatchOptions();
      });
     });
    }
    if(!shown.length)node('p','찾는 저자가 없습니다.',host,{class:'sc-muted'});
    if(!host.dataset.escBound){
     host.dataset.escBound='1';
     // Esc closes the open panel from anywhere inside the table, and the focus goes back to its row.
     host.addEventListener('keydown',e=>{
      if(e.key!=='Escape'||!state.watchOpen||e.defaultPrevented)return;
      e.preventDefault();e.stopPropagation();closeWatchOpen();
     });
    }
    if(state.watchRefocus){state.watchRefocus=false;host.querySelector('.sc-watch-expand-body')?.focus?.();}
   }
   function refreshWatched(){
    watchArea.replaceChildren();
    drawWatched(watchArea);

   }

   async function loadAuthors(){
    message('저자 정보를 확인하는 중…');
    const people=await runtime.authorsOfCached(runtime.Z.Items.get(Number(item.id)));
    if(token!==epoch||disposed||state.tab!=='authors')return;
    list.replaceChildren();
    refreshWatched();
    if(!people.length){message('OpenAlex에서 이 논문의 저자를 찾지 못했습니다.',true);return;}
    /* Arrived from the item menu asking for this paper's senior author: the
       last-listed author is the lab's, which is who "track the PI" means. The
       list is one click away rather than a step to walk through. */
    const wanted=state.focus==='pi'?(people.find(p=>p.position==='last')||people.find(p=>p.position==='first')||people[0]):null;
    state.focus='';
    if(wanted){
     await show(wanted);
     if(token!==epoch||disposed||state.tab!=='authors')return;
     const back=node('div',null,null,{class:'sc-actions sc-focus-back'});
     node('span',`${item.title} · ${T(wanted.position==='last'?'책임저자':'제1저자')}`,back,{class:'sc-muted'});
     button(`이 논문의 저자 ${people.length}명 모두 보기`,()=>run(loadAuthors),back);
     list.insertBefore(back,list.firstChild);
     return;
    }
    section('이 논문의 저자',people.length);
    message(`이 논문의 저자 ${people.length}명. 이름을 눌러 최근 작업을 확인하세요.`);
    const authors=node('div',null,list,{class:'sc-hits'});
    for(const person of people){
     const row=node('div',null,authors,{class:'sc-hit',role:'button',tabindex:'0'});
     row.addEventListener('click',e=>{if(e.target.closest('button'))return;run(()=>show(person));});
     row.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();run(()=>show(person));}});
     node('p',person.name,row,{class:'sc-hit-title'});
     node('p',[T(person.position==='first'?'제1저자':person.position==='last'?'교신·책임저자':'공저자'),person.institution].filter(Boolean).join(' · '),row,{class:'sc-hit-meta'});
     const actions=node('div',null,row,{class:'sc-hit-actions'});
     button('최근 논문',()=>run(()=>show(person)),actions);
     /* Following a paper's authors used to mean opening each in turn. The
        row says who is already followed; for the rest one press follows,
        with their current papers as the baseline so nothing old reads new. */
     const followed=runtime.watchedAuthors?.().some(w=>runtime.discoverTools?.shortID?.(w.id)===runtime.discoverTools?.shortID?.(person.id)||w.id===person.id);
     if(followed)node('span','관심 저자',row,{class:'sc-hit-owned'});
     else{const add=button('관심 저자로 등록',()=>run(async()=>{
      const {profile,works}=await runtime.authorActivityCached(person.id);
      await runtime.watchAuthor({...person,name:profile?.name||person.name,seen:(works||[]).map(w=>w.id)});
      if(token!==epoch||disposed)return;
      refreshWatched();add.remove();actions.before(node('span','관심 저자',null,{class:'sc-hit-owned'}));
      message(`${profile?.name||person.name}을(를) 관심 저자로 등록했습니다.`);
     }),actions);}
    }
    groupSections(list);
    // One author is not a choice; go straight to their work.
    if(people.length===1)await show(people[0]);
   }
   refreshWatched();
   if(!item){
    // The count is already the group's own head (관심 저자 · n); a second line saying it again was noise.
    message('');
    node('p','문헌을 하나 고르면 OpenAlex에서 그 논문의 저자를 찾고, 관심 저자로 등록하면 새 논문·소속 이동·특허를 알려줍니다.',body,{class:'sc-muted'});pickOne();
    return;
   }
   // Named on the line above, in the context bar.
   const b=bar();
   button('새로고침',()=>run(async()=>{
    {const ref=runtime.Z.Items.get(Number(item.id));if(typeof runtime.forgetLookup==='function')runtime.forgetLookup(ref,'authors:');else runtime.discoverCache.delete('authors:'+runtime.identity(ref));}
    await loadAuthors();
   }),b);
   run(loadAuthors);
  }

  const METRIC_ICONS={
   citations:[['path',{d:'M5.5 4.5C3.8 4.5 2.5 5.8 2.5 7.5S3.8 10.5 5.5 10.5c.3 0 .6 0 .8-.1-.4 1-1.3 1.7-2.3 2v1.1c2.3-.4 4-2.4 4-4.8V7.5c0-1.7-1.3-3-3-3zM12.5 4.5c-1.7 0-3 1.3-3 3s1.3 3 3 3c.3 0 .6 0 .8-.1-.4 1-1.3 1.7-2.3 2v1.1c2.3-.4 4-2.4 4-4.8V7.5c0-1.7-1.3-3-3-3z'}]],
   impact:[['path',{d:'M2.5 12.5h11v1.2h-11zM4 7.5h2V11H4zm3.5-3.5h2V11h-2zm3.5 4.5h2V11h-2z'}]],
   time:[['path',{d:'M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2zm0 1.3a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zm-.6 1.4v3.5l2.7 1.6.6-1-2.1-1.3V4.9z'}]]
  };
  function metricIcon(name,parent){
   const svg=doc.createElementNS(SVG_NS,'svg');
   svg.setAttribute('viewBox','0 0 16 16');svg.setAttribute('width','12');svg.setAttribute('height','12');
   svg.setAttribute('aria-hidden','true');svg.setAttribute('fill','currentColor');
   for(const [tag,attrs] of METRIC_ICONS[name])svgShape(svg,tag,attrs);
   parent.appendChild(svg);
   return svg;
  }
  // The same bands the item tree uses, so a journal reads alike in both places.
  function impactTone(value){
   const n=Number(value);
   if(!(n>0))return '';
   if(n>=30)return 'top';
   if(n>=10)return 'high';
   if(n>=5)return 'mid';
   if(n>=2)return 'low';
   return 'base';
  }
  /* A figure the panel has not looked up yet is not the same as a figure that
     is zero. An em dash says "not known"; 0 says none. Both keep the column
     width, so the figures still line up down the list. */
  function metric(parent,{icon,text,tone,label,name,unit}){
   const known=text!==''&&text!==null&&text!==undefined;
   const span=node('span',null,parent,{class:'sc-metric',title:known?label:`${T(label)} · ${T('아직 확인하지 않음')}`});
   if(name)span.dataset.metric=name;
   if(!known)span.dataset.empty='true';
   // The unit names the figure where the reader looks: "IF 12.4", not a
   // bar-chart glyph they have to learn.
   if(unit)node('span',T(unit),span,{class:'sc-metric-unit'});
   else if(icon)metricIcon(icon,span);
   node('span',known?String(text):'—',span,{class:'sc-metric-value'});
   if(tone&&known)span.dataset.tone=tone;
   return span;
  }

  /* Which colour is which journal. The map paints every node in its journal's
     colour, and a reader new to it has no way to know that lilac is Nature
     and coral is Cell; the six commonest journals in the map are named, each
     in its own mark, with how many nodes it accounts for. */
  function drawJournalLegend(nodes,parent){
   const identity=runtime.journalIdentity;
   if(!identity?.identify||!identity.colours)return;
   const counts=new Map();
   for(const n of nodes)if(n.venue)counts.set(n.venue,(counts.get(n.venue)||0)+1);
   const top=[...counts].sort((a,b)=>b[1]-a[1]).slice(0,6).filter(([venue])=>identity.identify(venue));
   const legend=node('div',null,parent,{class:'sc-graph-legend','aria-label':'저널별 색'});
   // The swatch is the node's own paint, not the badge, so the key matches the map.
   for(const [venue,count] of (top.length>=2?top:[])){
    const entry=node('span',null,legend,{class:'sc-legend-entry',title:`${venue} · ${count}편`});
    const tone=identity.colours(identity.identify(venue),{dark:darkScheme()});const dot=node('span',null,entry,{class:'sc-legend-dot'});dot.style.background=tone.fill;dot.style.boxShadow=`inset 0 0 0 1px ${tone.ink}`;
    node('span',venue,entry,{class:'sc-legend-name'});
    node('span',String(count),entry,{class:'sc-legend-count'});
   }
   // The two shapes the map uses besides colour.
   const outside=node('span',null,legend,{class:'sc-legend-entry'});node('span',null,outside,{class:'sc-legend-dot sc-legend-external'});node('span','내 라이브러리에 없음',outside,{class:'sc-legend-name'});
   const coupled=node('span',null,legend,{class:'sc-legend-entry'});node('span',null,coupled,{class:'sc-legend-line'});node('span','공통 참고문헌',coupled,{class:'sc-legend-name'});
  }
  /* OpenAlex subject browsing and local JIF comparisons. Official JCR
     categories remain a separate external view; stored standalone Q values
     have no verified category context. */
  const JOURNAL_ICONS={
   impact:[['line',{x1:3,y1:12.6,x2:3,y2:8.6}],['line',{x1:8,y1:12.6,x2:8,y2:4.6}],['line',{x1:13,y1:12.6,x2:13,y2:7}]],
   quartile:[['circle',{cx:8,cy:6.4,r:3.4}],['path',{d:'M5.8 9.2L4.8 13.4l3.2-1.6 3.2 1.6-1-4.2'}]],
   abbreviation:[['path',{d:'M8.4 2.6H13v4.6l-6 6a1.1 1.1 0 01-1.6 0L2.8 10.2a1.1 1.1 0 010-1.6z'}],['circle',{cx:10.5,cy:5.1,r:.95}]],
   publisher:[['rect',{x:3,y:4.4,width:10,height:8.6,rx:.8}],['path',{d:'M6 4.4V2.8h4v1.6'}],['line',{x1:6,y1:7.6,x2:6,y2:9.6}],['line',{x1:10,y1:7.6,x2:10,y2:9.6}]],
   issn:[['line',{x1:3.2,y1:4,x2:3.2,y2:12}],['line',{x1:5.6,y1:4,x2:5.6,y2:12}],['line',{x1:7.6,y1:4,x2:7.6,y2:12}],['line',{x1:10.2,y1:4,x2:10.2,y2:12}],['line',{x1:12.8,y1:4,x2:12.8,y2:12}]],
   field:[['path',{d:'M2.7 12.6V4.2h3.9l1.4 1.7h5.3v6.7z'}]],
   hindex:[['path',{d:'M3 12l3.2-3.6 2.6 2 4.2-5'}],['line',{x1:2.6,y1:13,x2:13.4,y2:13}]],
   works:[['rect',{x:2.75,y:3,width:3,height:10,rx:.8}],['rect',{x:7.25,y:3,width:3,height:10,rx:.8}],['path',{d:'M11.9 3.6l1.9.5-2.2 9.1-1.2-.3'}]],
   access:[['rect',{x:3.4,y:7.2,width:9.2,height:6,rx:1}],['path',{d:'M5.6 7.2V5.4a2.4 2.4 0 014.8 0'}]],
   country:[['circle',{cx:8,cy:8,r:5.4}],['path',{d:'M2.6 8h10.8M8 2.6c1.7 1.6 2.5 3.4 2.5 5.4S9.7 11.8 8 13.4M8 2.6C6.3 4.2 5.5 6 5.5 8s.8 3.8 2.5 5.4'}]],
   link:[['path',{d:'M6.8 9.2a2.6 2.6 0 003.7 0l2-2a2.6 2.6 0 00-3.7-3.7l-.9.9'}],['path',{d:'M9.2 6.8a2.6 2.6 0 00-3.7 0l-2 2a2.6 2.6 0 003.7 3.7l.9-.9'}]],
   library:[['path',{d:'M8 4.8C6.7 3.7 5.1 3.2 3 3.2v8.6c2.1 0 3.7.5 5 1.6 1.3-1.1 2.9-1.6 5-1.6V3.2c-2.1 0-3.7.5-5 1.6z'}],['line',{x1:8,y1:4.8,x2:8,y2:13.4}]]
  };
  function journalIcon(name,parent){
   const svg=doc.createElementNS(SVG_NS,'svg');
   svg.setAttribute('viewBox','0 0 16 16');svg.setAttribute('width','13');svg.setAttribute('height','13');
   svg.setAttribute('aria-hidden','true');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');
   svg.setAttribute('stroke-width','1.4');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');
   for(const [tag,attrs] of JOURNAL_ICONS[name]||[])svgShape(svg,tag,attrs);
   parent.appendChild(svg);
   return svg;
  }
  const journalView=state.journalView||(state.journalView={sort:'if',field:'',pick:{domain:'',field:'',subfield:''},grouped:false,open:new Set(),scope:'library',page:0});
  journalView.pick=journalView.pick||{domain:'',field:'',subfield:''};
  const JOURNAL_LEVELS=['domain','field','subfield'];
  const journalPath=(path,index=2)=>JOURNAL_LEVELS.slice(0,index+1).map(level=>path[level]||'');
  const journalPathKey=(path,index=2)=>JSON.stringify(journalPath(path,index));
  const journalPathLabel=(path,index=2)=>journalPath(path,index).filter(Boolean).join(' › ');
  const journalPathMatches=(path,pick,levels=JOURNAL_LEVELS)=>levels.every(level=>!pick[level]||path[level]===pick[level]);
  function journalLevels(venue,profile){
   if(runtime.journalIdentity?.resolveLevels)return runtime.journalIdentity.resolveLevels(venue,profile);
   // Compatibility for a runtime without the new resolver; never truncate topics.
   const registry=runtime.journalIdentity?.registryLevels?.(venue)||[];
   const complete=list=>[...new Map(list.filter(t=>JOURNAL_LEVELS.every(k=>typeof t?.[k]==='string'&&t[k].trim()))
    .map(t=>{const path=Object.fromEntries(JOURNAL_LEVELS.map(k=>[k,t[k].trim()]));return [journalPathKey(path),path];})).values()];
   const known=complete(registry);return known.length?known:complete(profile?.topics||[]);
  }
  function journalInputs(venue,items){
   const ref=runtime.Z.Items.get(Number(items[0].id));
   return {profile:ref&&typeof runtime.journalProfile==='function'?runtime.journalProfile(ref):null,
    record:ref&&typeof runtime.journalRecord==='function'?runtime.journalRecord(ref):{name:venue,issn:''}};
  }
  function selectedJournalRanks(j){
   const pick=journalView.pick;
   if(pick.domain==='\u0000none')return [];
   const selectedLevel=pick.subfield?'subfield':pick.field?'field':null;
   return (j.fieldRanks||[]).filter(r=>(!selectedLevel||r.level===selectedLevel)&&journalPathMatches(r,pick));
  }
  const COUNTRY_NAMES={US:'미국',GB:'영국',DE:'독일',NL:'네덜란드',CH:'스위스',KR:'한국',JP:'일본',CN:'중국',FR:'프랑스',IT:'이탈리아',ES:'스페인',CA:'캐나다',AU:'호주',SE:'스웨덴',DK:'덴마크',SG:'싱가포르',IN:'인도',BR:'브라질',IE:'아일랜드',AT:'오스트리아',BE:'벨기에',PL:'폴란드',NZ:'뉴질랜드',TW:'대만',HK:'홍콩',NO:'노르웨이',FI:'핀란드',IL:'이스라엘',RU:'러시아'};
  const compact=n=>n==null?'':n>=1e6?(n/1e6).toFixed(1).replace(/\.0$/,'')+'M':n>=1e4?Math.round(n/1e3)+'k':n>=1e3?(n/1e3).toFixed(1).replace(/\.0$/,'')+'k':String(n);
  /* Everything known about one journal, gathered from the three places it
     lives: the registry (JIF, quartile, abbreviation, publisher, ISSN), the
     OpenAlex cache (subjects, h-index, output, access, country, homepage),
     and this library (how many papers, how many read, how they are cited). */
  function journalFacts(venue,items,input=journalInputs(venue,items)){
   const id=runtime.journalIdentity?.identify?.(venue)||null;
   const {profile,record}=input;
   const levels=journalLevels(venue,profile);
   const issns=[...new Set([...(id?.issns||[]),...String(record.issn||'').split(/[,;\s]+/).map(x=>x.trim()).filter(x=>/^\d{4}-?\d{3}[\dXx]$/.test(x)).map(x=>x.length===8?x.slice(0,4)+'-'+x.slice(4):x.toUpperCase())])];
   const first=items[0];
   const registryImpact=id?.impactFactor!=null&&id.impactFactor!==''&&typeof id.impactFactor!=='boolean'
    &&Number.isFinite(Number(id.impactFactor))&&Number(id.impactFactor)>=0;
   const impact=registryImpact?Number(id.impactFactor):(first.impactFactor!=null?Number(first.impactFactor):null);
   const year=registryImpact?(id.year??null):(first.impactYear||null);
   const read=items.filter(i=>i.status==='done').length;
   const cited=items.map(i=>Number(i.citations)||0);
   const years=items.map(i=>Number(i.year)).filter(Number.isFinite);
   const globalRank=runtime.journalIdentity?.registryRank?.(venue)||null;
   return {venue,items,id,profile,impact,year,quartile:id?.quartile??null,abbreviation:id?.abbreviation||'',globalRank,
    publisher:profile?.publisher||id?.label||id?.publisher||'',issns,fields:levels.map(l=>journalPathLabel(l)),topics:profile?.topics||[],levels,
    fieldRanks:runtime.journalIdentity?.registryFieldRanks?.(venue)||[],
    hIndex:profile?.hIndex??null,works:profile?.works??null,citedness:profile?.citedness??null,isOA:!!profile?.isOA,inDoaj:!!profile?.inDoaj,apc:profile?.apc??null,
    country:profile?.country||'',homepage:profile?.homepage||'',openAlexID:profile?.openAlexID||'',
    papers:items.length,read,avgCited:cited.length?Math.round(cited.reduce((a,b)=>a+b,0)/cited.length):0,
    span:years.length?[Math.min(...years),Math.max(...years)]:null,source:registryImpact?T('저장된 JIF 자료'):first.impactSource||''};
  }
  /* A journal the library does not hold, straight from the registry: the
     figure, quartile, abbreviation, publisher and ISSNs are all there; only
     the OpenAlex profile and the library counts are not. */
  function registryFacts(row,items){
   const id=runtime.journalIdentity?.identify?.(row.title)||null;
   const levels=journalLevels(row.title,{topics:Array.isArray(row.levels)?row.levels:[]});
   return {venue:row.title,items:items||[],id,profile:null,impact:row.impactFactor??null,year:row.year??null,quartile:row.quartile??null,abbreviation:row.abbreviation||'',
    globalRank:row.rank,publisher:row.publisher||'',issns:(row.issns||[]).map(x=>String(x).length===8?String(x).slice(0,4)+'-'+String(x).slice(4):String(x)),fields:levels.map(l=>journalPathLabel(l)),topics:[],levels,
    fieldRanks:runtime.journalIdentity?.registryFieldRanks?.(row.title)||[],
    hIndex:null,works:null,citedness:null,isOA:false,inDoaj:false,apc:null,country:'',homepage:'',openAlexID:'',
    papers:(items||[]).length,read:(items||[]).filter(i=>i.status==='done').length,avgCited:0,span:null,source:T('저장된 JIF 자료'),registryOnly:true};
  }
  /* 내 문헌 분석: before any catalog, what this library does with its
     journals -- how many papers each holds, how many are still unread, how
     long has been spent reading them, and how they are cited, with the
     count the median stands on. Read off the rows in hand; it asks nothing
     and stays when the JCR catalog fails to load. A journal is one row when
     the registry knows the names are one journal, otherwise by its name. */
  function drawJournalReadingOverview(){
   const groups=new Map();
   const scope=rows();
   for(const item of scope){
    // A paper with no journal is still part of the whole: it counts under its own row.
    const rank=item.venue?runtime.journalIdentity?.registryRank?.(item.venue):null;
    const key=!item.venue?'\u0000none':rank?'#'+rank:String(item.venue).trim().toLowerCase();
    if(!groups.has(key))groups.set(key,{venue:item.venue||T('저널 미기재'),unnamed:!item.venue,items:[]});
    groups.get(key).items.push(item);
   }
   if(!groups.size)return;
   // The shares' denominators are the whole of what is in view, fixed whatever the order or how many rows show.
   const totalPapers=scope.length,totalSeconds=scope.reduce((n,i)=>n+(Number(i.seconds)||0),0);
   const median=list=>{const s=[...list].sort((a,b)=>a-b);return s.length?(s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2):null;};
   /* The official standing only exists in a real captured JCR catalog: the
      shipped OpenAlex placeholder is declared as an estimate (source.metric)
      and never carries jif/categoryMetrics, so it is treated the same as no
      catalog at all rather than shown under the Clarivate name. */
   const jcrCatalog=runtime.jcrCatalog&&!runtime.jcrCatalog.source?.metric?runtime.jcrCatalog:null;
   const all=[...groups.values()].map(g=>{
    const known=list=>list.map(i=>i.citations).filter(c=>c!=null&&c!==''&&Number.isFinite(Number(c))).map(Number);
    const cited=known(g.items);
    const reading=g.items.filter(i=>i.status==='done'||i.status==='reading'),unread=g.items.filter(i=>i.status!=='done'&&i.status!=='reading');
    // The citation median split by reading state: what has been taken up against what is waiting.
    const split=[['read',reading],['unread',unread]].map(([key,list])=>{const c=known(list);return {key,n:list.length,known:c.length,median:median(c)};});
    let jcrJournal=null;
    if(jcrCatalog&&g.venue){
     const id=runtime.journalIdentity?.identify?.(g.venue)||null;
     const record=journalInputs(g.venue,g.items).record;
     const issns=[...new Set([...(id?.issns||[]),...String(record?.issn||'').split(/[,;\s]+/)])].filter(Boolean);
     jcrJournal=jcrMatch(jcrCatalog,g.venue,issns);
    }
    const jcrStandings=jcrJournal?(jcrJournal.categoryMetrics||[]).filter(m=>m.quartile!=null||m.rank!=null)
     .sort((a,b)=>(a.quartile??5)-(b.quartile??5)||(b.percentile??-1)-(a.percentile??-1)):[];
    return {...g,key:String(g.venue),unread,
     seconds:g.items.reduce((n,i)=>n+(Number(i.seconds)||0),0),cited,median:median(cited),split,
     jcrJournal,jcrStandings};
   });
   /* One scale for every row's citation marks, and it is logarithmic: citation
      medians span orders of magnitude (3 next to 13,308), and on a linear
      axis one outlier journal pushes every other mark into the first pixels
      where they pile into a blob. Clamping at a percentile would hide how far
      the outlier is; a log axis keeps every row legible and the outlier
      honest, and its decade ticks (1 10 100 1k 10k) are read at a glance.
      Position = log10(1+median)/log10(1+top), so a real 0 sits at the start. */
   const citeTop=Math.max(1,...all.flatMap(g=>g.split.map(p=>p.median||0)));
   const citeLog=v=>Math.log10(1+Math.max(0,v));
   const citeAt=v=>Math.min(1,Math.max(0,citeLog(v)/citeLog(citeTop)));
   const citeTicks=[1,10,100,1000,10000,100000].filter(t=>t<=citeTop);
   const tickText=t=>t>=1000?`${t/1000}k`:String(t);
   const byTime=state.journalReadingSort==='time',byIF=state.journalReadingSort==='if';
   all.sort(byIF?(a,b)=>(b.jcrJournal?.jif??-1)-(a.jcrJournal?.jif??-1)||b.items.length-a.items.length
    :byTime?(a,b)=>b.seconds-a.seconds||b.items.length-a.items.length:(a,b)=>b.unread.length-a.unread.length||b.items.length-a.items.length);
   // The papers with no journal named are the whole's remainder, not a journal: pinned last, whatever the order.
   all.sort((a,b)=>(a.unnamed?1:0)-(b.unnamed?1:0));
   const box=node('section',null,body,{class:'sc-journal-reading','aria-label':T('내 문헌 분석')});
   const head=node('div',null,box,{class:'sc-journal-reading-head'});
   node('h3',T('내 문헌 분석'),head,{class:'sc-journal-reading-title'});
   // 저널 미기재 is the remainder, not a journal: counted apart from the 종.
   const unnamedPapers=all.filter(g=>g.unnamed).reduce((n,g)=>n+g.items.length,0),namedCount=all.filter(g=>!g.unnamed).length;
   node('span',[T(`저널 ${namedCount}종`),unnamedPapers&&T(`저널 미기재 ${unnamedPapers}편`),T(`문헌 ${all.reduce((n,g)=>n+g.items.length,0)}편`)].filter(Boolean).join(' · '),head,{class:'sc-muted'});
   // A search or filter above narrows this too; it says so, or a part reads as the whole library.
   const narrowed=[state.query&&T(`검색 “${state.query}”`),state.scope!=='library'&&T('선택 범위'),...Object.values(parentOptions()).filter(Boolean).length?[T('필터 적용')]:[]].filter(Boolean);
   if(narrowed.length)node('span',T('적용 중: ')+narrowed.join(' · '),head,{class:'sc-journal-reading-scope'});
   if(jcrCatalog?.source?.metricYear)node('p',T(`IF·Q·순위는 Clarivate JCR ${jcrCatalog.source.metricYear}(공식) 기준입니다.`),box,{class:'sc-muted sc-journal-reading-jcr-note'});
   const order=node('div',null,head,{class:'sc-segmented',role:'group','aria-label':T('내 문헌 분석 정렬')});
   button('안 읽음 많은 순',()=>{state.journalReadingSort='';render();},order,{'aria-pressed':String(!byTime&&!byIF)});
   button('읽은 시간순',()=>{state.journalReadingSort='time';render();},order,{'aria-pressed':String(byTime)});
   if(jcrCatalog)viewButton('IF 높은 순',()=>{state.journalReadingSort='if';render();},order,{'aria-pressed':String(byIF)});
   // The legend, once, under the title: what the two bars and the two marks mean.
   // Two plain legend items: what the marks are, and what the two bars are.
   const legendLine=node('div',null,box,{class:'sc-muted sc-journal-legend-line'});
   node('span',T('● 읽는 중·완료  ■ 안 읽음')+' · '+T('로그 눈금'),legendLine,{class:'sc-journal-legend-item'});
   node('span',T('막대: 위 보유 · 아래 시간'),legendLine,{class:'sc-journal-legend-item'});
   const shown=all.slice(0,state.journalReadingAll?all.length:8);
   const table=node('div',null,box,{class:'sc-journal-reading-table',role:'table'});
   const header=node('div',null,table,{class:'sc-journal-reading-row sc-journal-reading-header',role:'row'});
   // Legends live here once, not on every row.
   // Numbers are right-aligned under right-aligned headers; the two charts (비중, 인용 중앙값) are left-aligned with theirs.
   for(const label of ['저널','보유 (편)','안 읽음 (편)'])node('span',T(label),header,{role:'columnheader'});
   const mixHead=node('span',null,header,{role:'columnheader',class:'sc-journal-reading-mix-head'});
   node('span',T('비중'),mixHead);
   node('span',T('읽은 시간'),header,{role:'columnheader'});
   const citeHead=node('span',null,header,{role:'columnheader',class:'sc-journal-citation-head'});
   node('span',T('인용 중앙값'),citeHead,{class:'sc-journal-citation-title'});
   const axisEnds=node('span',null,citeHead,{class:'sc-journal-citation-axis'});
   for(const t of citeTicks){const at=citeAt(t);const label=node('span',tickText(t),axisEnds,{class:'sc-journal-citation-tick'});label.style.left=`calc(5px + (100% - 10px) * ${at})`;if(at>0.9)label.dataset.edge='end';}
   for(const g of shown){
    const row=node('div',null,table,{class:'sc-journal-reading-row',role:'row'});
    const nameCell=node('div',null,row,{class:'sc-journal-reading-name',role:'cell'});
    const nameText=node('span',g.venue,nameCell,{class:'sc-journal-reading-name-text'+(g.unnamed?' sc-journal-reading-unnamed':''),title:g.venue});
    if(!g.unnamed)inkJournal(nameText,g.venue);
    // The official standing, one category at a time: the best category leads,
    // a chip says how many more it is placed in, and the tooltip lists every
    // one. Looked up and absent reads differently from never having checked.
    if(jcrCatalog&&g.venue){
     if(g.jcrStandings.length){
      const lead=g.jcrStandings[0],name=jcrCatalog.category(lead.categoryKey)?.name||lead.categoryKey;
      const figure=g.jcrJournal.jif!=null?`IF ${g.jcrJournal.jif}`:'';
      const standing=[lead.quartile!=null?'Q'+lead.quartile:'',lead.rank!=null&&lead.rankTotal!=null?`${lead.rank}/${lead.rankTotal}`:''].filter(Boolean).join(' ');
      const more=g.jcrStandings.length>1?` +${g.jcrStandings.length-1}`:'';
      const text=[figure,[standing,name].filter(Boolean).join(' ')].filter(Boolean).join(' · ')+more;
      const tip=[T(`Clarivate JCR ${jcrCatalog.source.metricYear}(공식)`),...g.jcrStandings.map(m=>{
       const catName=jcrCatalog.category(m.categoryKey)?.name||m.categoryKey;
       return [catName,m.quartile!=null?'Q'+m.quartile:'',m.rank!=null&&m.rankTotal!=null?`${m.rank}/${m.rankTotal}`:''].filter(Boolean).join(' ');
      })].join(' · ');
      node('span',text,nameCell,{class:'sc-journal-reading-jcr',title:tip});
     }else if(g.jcrJournal===null)node('span',T('JCR에 없음'),nameCell,{class:'sc-journal-reading-jcr'});
    }
    // The count of papers held is the way to them: 보유 문헌, searched for this journal.
    const heldCell=node('span',null,row,{class:'sc-journal-reading-num',role:'cell'});
    // Exactly this group's papers, by id -- a text search on the venue name
    // also matched "Nature Methods" under "Nature". The group with no journal named gets the same badge: it is the biggest group more often than not, and a bare number there read as a different kind of cell.
    heldCell.dataset.label=T('보유');
    button(fmtN(g.items.length),()=>navigateSelection('explore',g.items.map(i=>i.id)),heldCell,{class:'sc-journal-reading-count','data-unit':'편',title:T(`${g.venue} 문헌을 보유 문헌에서 보기`)});
    const unread=node('span',null,row,{class:'sc-journal-reading-num sc-journal-reading-unread',role:'cell'});
    const open=state.journalReadingOpen===g.key;
    if(g.unread.length){
     const b=button(fmtN(g.unread.length),()=>{state.journalReadingOpen=open?'':g.key;render();},unread,{class:'sc-journal-reading-count','data-unit':'편','aria-expanded':String(open),title:T(open?'다시 누르면 접기':'안 읽은 문헌 펼치기')});
    }else node('span','0',unread,{class:'sc-journal-reading-count sc-journal-reading-count-none','data-unit':'편'});
    unread.dataset.label=T('안 읽음');
    /* What share of the papers in view this journal holds, and what share of
       the reading time went to it, on one 0-100% scale: a journal collected
       much and read little shows as a long bar over a short one. */
    const mix=node('span',null,row,{class:'sc-journal-reading-mix',role:'cell'});
    const share=(label,part,whole)=>{
     // Label left, bar, value right: the same three tracks on both lines, so the labels, bars and figures each form a column.
     const line=node('span',null,mix,{class:'sc-journal-reading-share'});
     const pct=whole>0?Math.round(100*part/whole):null;
     const scale=node('span',null,line,{class:'sc-journal-reading-bar','aria-hidden':'true'});
     if(pct!=null)node('span',null,scale).style.width=`${pct}%`;
     node('span',pct==null?'—':`${pct}%`,line,{class:'sc-journal-reading-pct',title:T(label)});
    };
    share('보유',g.items.length,totalPapers);
    share('시간',g.seconds,totalSeconds);
    const timeCell=node('span',null,row,{class:'sc-journal-reading-num',role:'cell'});
    if(g.seconds>0)timeCell.textContent=runtime.formatReadTime?runtime.formatReadTime(g.seconds,{compact:true}):Math.round(g.seconds/60)+'분';else noneMark(timeCell);
    /* Both medians on one axis shared by every row (0 to the header's end value): a dot for the papers read or being read, a square for the unread, in two lanes so equal values never fully overlap, joined by a thin line when both exist. No record is no mark and —; a real 0 sits at the axis start. */
    const cell=node('span',null,row,{class:'sc-journal-reading-num sc-journal-reading-citation-compare',role:'cell',title:T('인용 수를 아는 문헌만으로 계산합니다'),'data-label':T('인용 중앙값')});
    const plot=node('span',null,cell,{class:'sc-journal-citation-plot','aria-hidden':'true'});
    const at=part=>citeAt(part.median);
    const fx=part=>`calc(5px + (100% - 10px) * ${at(part)})`;
    // Faint decade ticks on the baseline, the same positions as the header's labels.
    for(const t of citeTicks)node('span',null,plot,{class:'sc-journal-citation-grid'}).style.left=`calc(5px + (100% - 10px) * ${citeAt(t)})`;
    const [rd,un]=g.split;
    if(rd.median!=null&&un.median!=null){
     const join=node('span',null,plot,{class:'sc-journal-citation-join'});
     join.style.left=fx(at(rd)<=at(un)?rd:un);join.style.width=`calc((100% - 10px) * ${Math.abs(at(rd)-at(un))})`;
    }
    for(const part of g.split)if(part.median!=null)node('span',part.key==='read'?'●':'■',plot,{class:'sc-journal-citation-dot','data-group':part.key}).style.left=fx(part);
    for(const part of g.split){
     const line=node('span',null,cell,{class:'sc-journal-citation-line','data-group':part.key});
     node('span',part.key==='read'?'●':'■',line,{class:'sc-journal-citation-mark','aria-hidden':'true'});
     if(part.median==null)noneMark(line).classList.add('sc-journal-citation-value');
     else{const value=node('span',fmtN(Math.round(part.median)),line,{class:'sc-journal-citation-value'});node('span',` · ${part.known}/${part.n}편`,value,{class:'sc-journal-citation-coverage'});}
     line.title=T(`인용 수를 아는 문헌 ${part.known}편 / 전체 ${part.n}편`);
    }
    if(open){
     const list=node('div',null,table,{class:'sc-journal-reading-papers',role:'row'});
     for(const item of g.unread.slice(0,20)){
      const line=node('div',null,list,{class:'sc-journal-reading-paper'});
      button(item.title||T('제목 없음'),()=>{state.selected=new Set([String(item.id)]);state.scope='selected';scope.value='selected';return navigate('explore');},line,{class:'sc-hit-title-link',title:T('이 문헌 자세히 보기')});
      // With its year and citations, so the unread list can be weighed where it opens; unknown is not 0.
      const c=item.citations;node('span',[item.year,c!=null&&c!==''&&Number.isFinite(Number(c))?T(`인용 ${fmtN(Number(c))}`):T('인용 미확인')].filter(Boolean).join(' · '),line,{class:'sc-muted'});
     }
     if(g.unread.length>20)node('p',T(`외 ${g.unread.length-20}편`),list,{class:'sc-muted'});
    }
   }
   if(all.length>8)viewButton(state.journalReadingAll?'8종만 보기':`${all.length}종 모두 보기`,()=>{state.journalReadingAll=!state.journalReadingAll;render();},bar(box));
  }
  function drawJournals(){
   drawJournalReadingOverview();
   const switchBrowser=async mode=>{state.journalBrowser=mode;await saveUI({journalBrowser:mode});if(!disposed&&state.tab==='journals')await render();};
   if(state.journalBrowser==='openalex'){
    button('JCR 카테고리로 돌아가기',()=>switchBrowser('jcr'),bar(),{class:'sc-jcr-return'});
    drawOpenAlexJournals();return;
   }
   const browser=runtime.jcrBrowser||root.CustomStyleJCRBrowser;
   if(!runtime.jcrCatalog||typeof browser?.mount!=='function'){
    emptyCard(body,{title:'공식 JCR 카테고리 자료를 불러오지 못했습니다.',hint:'플러그인 업데이트를 확인하거나 아래에서 다른 탐색 방법을 고르세요.',role:'alert'}).classList.add('sc-jcr-unavailable');
    /* A failure says so and offers the ways on. Rows of dashes under real
       column names read as data that had come back empty (Codex, round 3). */
    const actions=bar();
    button('JCR 원본 열기',()=>runtime.Z.launchURL?.('https://jcr.clarivate.com/jcr/browse-categories'),actions,{'data-opens':'browser'});
    button('OpenAlex 주제로 탐색',()=>switchBrowser('openalex'),actions);
    return;
   }
   const host=node('div',null,body,{class:'sc-jcr-host'});
   const zotPoPUnavailable='저널 논문 검색을 열 수 없습니다. 도구 → 부가 기능에서 ZotPoP를 설치·활성화한 뒤 다시 시도하세요.';
   jcrMount=browser.mount(host,{catalog:runtime.jcrCatalog,initialState:state.jcrBrowserState||{},t:T,
    errorMessages:{ZOTPOP_UNAVAILABLE:zotPoPUnavailable},
    onStateChange:value=>{state.jcrBrowserState=value;return saveUI({jcrBrowserState:value});},
    onOpenAlex:ctx=>{if(ctx&&ctx.name){journalView.query=String(ctx.name);journalView.page=0;}return switchBrowser('openalex');},
    onOpenSource:url=>runtime.Z.launchURL?.(url),
    onSearchJournal:journal=>{
     if(typeof runtime.Z.ZotPoP?.openSearch!=='function'){
      const error=new Error(zotPoPUnavailable);error.code='ZOTPOP_UNAVAILABLE';throw error;
     }
     return runtime.Z.ZotPoP.openSearch(win,{venue:journal.title});
    },
    onError:error=>runtime.Z.logError?.(error)
   });
  }
  function drawOpenAlexJournals(){
   const byVenue=new Map();
   for(const item of rows()){if(!item.venue)continue;const list=byVenue.get(item.venue)||[];list.push(item);byVenue.set(item.venue,list);}
   const registry=runtime.journalIdentity?.registryRanked?.()||[];
   if(journalView.scope==='all'&&!registry.length)journalView.scope='library';
   if(!byVenue.size&&journalView.scope!=='all'){if(registry.length){journalView.scope='all';}else{empty('저널이 있는 문헌이 없습니다.');return;}}
   /* The facts for 255 journals -- registry, OpenAlex cache, library counts
      -- are gathered once per set of items and kept; typing in the search
      box used to rebuild them on every keystroke, which is where the lag
      was. */
   const inputs=[...byVenue].map(([venue,items])=>({venue,items,input:journalInputs(venue,items)}));
   const factsKey=JSON.stringify([journalView.scope,state.libraryID,state.scope,runtime.journalIdentity?.registryRevision?.()??0,
    inputs.map(({venue,items,input})=>[venue,items.map(i=>[i.id,i.impactFactor,i.impactYear,i.impactSource,i.status,i.citations,i.year]),input])]);
   if(journalView.factsKey!==factsKey){
    const mine=inputs.map(({venue,items,input})=>journalFacts(venue,items,input));
    if(journalView.scope==='all'){
     // Every registry journal, the library's own facts standing in where the library holds it.
     const held=new Map(mine.filter(j=>j.globalRank).map(j=>[j.globalRank,j]));
     journalView.facts=registry.map(row=>held.get(row.rank)||registryFacts(row,[]));
    }else journalView.facts=mine;
    journalView.factsKey=factsKey;journalView.page=0;
   }
   const all=journalView.facts;
   /* The subject hierarchy, one row per level, large to small: the four
      domains OpenAlex keeps, then the fields inside the chosen domain, then
      the subfields inside the chosen field. A row collapses to its chosen
      chip once picked, so the path reads as a breadcrumb and the next level
      opens beneath it; the chip again, or 전체, lets go. The user asked for
      the fields to be arranged by size and picked level by level rather than
      spread flat in twenty-six chips. */
   const pick=journalView.pick;
   const matches=j=>pick.domain==='\u0000none'
    ?!j.levels.length
    :!JOURNAL_LEVELS.some(level=>pick[level])||j.levels.some(path=>journalPathMatches(path,pick));
   const controls=bar();controls.classList.add('sc-journal-controls');
   /* Two views: the journals this library holds, and every journal in the
      registry -- 22,594 of them -- so a journal the user does not hold can be
      found, placed and compared. The rank column is the place in the whole
      registry in both views. */
   const scopes=node('div',null,controls,{class:'sc-segmented',role:'group','aria-label':'저널 범위'});
   viewButton(`내 서재 ${byVenue.size}`,()=>{journalView.scope='library';journalView.page=0;render();},scopes,{'aria-pressed':String(journalView.scope!=='all')});
   if(registry.length)viewButton(`저장 저널 ${registry.length.toLocaleString()}`,()=>{journalView.scope='all';journalView.page=0;render();},scopes,{'aria-pressed':String(journalView.scope==='all')});
   button('공식 JCR 카테고리 보기',()=>runtime.Z.launchURL?.('https://jcr.clarivate.com/jcr/browse-categories'),controls,
    {title:'Clarivate JCR의 Groups와 Categories · 기관 접근 또는 계정 로그인이 필요할 수 있습니다','data-opens':'browser'});
   // Journals found by name, abbreviation, publisher or field, apart from the paper search above.
   const find=node('input',null,controls,{type:'search',placeholder:'저널·약어·출판사·분야 검색','aria-label':'저널 검색'});find.value=journalView.query||'';
   // Typing redraws only the list, a beat after the last key, not the whole tab.
   let typing=null;
   find.addEventListener('input',()=>{journalView.query=find.value;win.clearTimeout(typing);typing=win.setTimeout(()=>{typing=null;redrawJournalList();},120);});
   const sortPick=node('select',null,controls,{'aria-label':'저널 정렬'});
   for(const [value,label] of [['if','IF 높은 순'],['name','이름순'],['papers','내 문헌 많은 순'],['quartile','저장 Q 순 (카테고리 미확인)'],['fieldrank','로컬 분야 순위 높은 순']]){const o=node('option',label,sortPick,{value});if(journalView.sort===value)o.selected=true;}
   sortPick.addEventListener('change',()=>{journalView.sort=sortPick.value;render();});
   const grouped=viewButton(journalView.grouped?'목록으로':'분야별로 묶기',()=>{journalView.grouped=!journalView.grouped;render();},controls,{'aria-pressed':String(journalView.grouped)});
   grouped.classList.add('sc-journal-toggle');
   const known=all.filter(j=>j.levels.length).length;
   node('span',journalView.scope==='all'?`저장 저널 ${all.length.toLocaleString()}종 · OpenAlex 분야 있음 ${known.toLocaleString()} · 내 서재 ${all.filter(j=>j.papers).length}`:`저널 ${all.length}종 · JIF 있는 저널 ${all.filter(j=>j.impact!=null).length} · 분야 알려진 저널 ${known}`,controls,{class:'sc-muted sc-journal-count'});
   node('p','OpenAlex 분야별 저장 JIF 비교입니다. 로컬 순위·Q는 자체 계산이며, 저장 Q는 카테고리 미확인 원본값입니다.',body,{class:'sc-muted sc-journal-source'});
   /* One line, three menus, large to small: 대분류 › 분야 › 세부 분야. Each
      menu lists what is under the choice to its left, largest first, with
      its count; a smaller level can be picked on its own, and the levels
      above it follow. The user found the chip rows hard to read and asked
      for one line that can be picked at any level. */
   const LEVELS=[['domain','대분류'],['field','분야'],['subfield','세부 분야']];
   const line=node('div',null,body,{class:'sc-field-line','aria-label':'분야 고르기'});
   const underMemo=new Map();
   const under=(level,index)=>{
    const memoKey=level+'|'+index;
    if(underMemo.has(memoKey))return underMemo.get(memoKey);
    const above=LEVELS.slice(0,index).map(([l])=>l);
    const counts=new Map();
    for(const j of all){const mine=new Map();for(const path of j.levels){
     if(!journalPathMatches(path,pick,above)||!path[level])continue;
     const value=journalPathKey(path,index);mine.set(value,path);
    }for(const [value,path] of mine){const entry=counts.get(value)||{value,path,label:path[level],parent:index?journalPathKey(path,index-1):'',parentLabel:index?journalPathLabel(path,index-1):'',count:0};entry.count++;counts.set(value,entry);}}
    const list=[...counts.values()].sort((x,y)=>y.count-x.count||x.label.localeCompare(y.label)||x.value.localeCompare(y.value));
    underMemo.set(memoKey,list);return list;
   };
   for(const [index,[level,label]] of LEVELS.entries()){
    const options=under(level,index);
    node('span',label,line,{class:'sc-field-level'});
    const select=node('select',null,line,{'aria-label':label,'data-level':level});
    const ancestors=LEVELS.slice(0,index).map(([level])=>level);
    const under_=all.filter(j=>!ancestors.some(l=>pick[l])||j.levels.some(path=>journalPathMatches(path,pick,ancestors)));
    const placed=under_.filter(j=>j.levels.length).length;
    /* The three menus used to read "전체 · 252" alike, which is the number of
       journals placed and the same figure in all three. It looked like the
       list of subjects was 252 long, or missing. Each says how many subjects
       it offers; how many journals sit under them is on the menu itself. */
    node('option',`전체 · ${options.length}개`,select,{value:''});
    select.title=`${T(label)} ${options.length}개 · ${T('분야가 있는 저널')} ${placed.toLocaleString()}종`;
    const unplaced=index===0?all.length-all.filter(j=>j.levels.length).length:0;
    const unknownLabel=T('분야 미상');
    if(unplaced)node('option',unknownLabel+' · '+unplaced,select,{value:'\u0000none'});
    // Groups in the order of their own size, so the biggest domain's fields come first.
    const parentOrder=index>0?under(LEVELS[index-1][0],index-1).map(o=>o.value):[];
    const parents=[...new Set(options.map(o=>o.parent))].sort((x,y)=>(parentOrder.indexOf(x)+1||1e9)-(parentOrder.indexOf(y)+1||1e9));
    const grouped=index>0&&!pick[LEVELS[index-1][0]]&&parents.length>1;
    for(const parent of grouped?parents:['']){
     const holder=grouped?node('optgroup',null,select,{label:options.find(o=>o.parent===parent)?.parentLabel||parent}):select;
     for(const o of options){if(grouped&&o.parent!==parent)continue;const opt=node('option',null,holder,{value:o.value});opt.textContent=`${o.label} ${o.count}`;opt.title=journalPathLabel(o.path,index);}
    }
    // A pick the current scope has no journal for still shows, at zero, so the menus do not lie.
    const selected=pick[level]==='\u0000none'?'\u0000none':pick[level]?journalPathKey(pick,index):'';
    if(selected&&selected!=='\u0000none'&&!options.some(o=>o.value===selected)){const o=node('option',null,select,{value:selected});o.textContent=`${pick[level]} 0`;o.title=journalPathLabel(pick,index);}
    if(!options.length&&!pick[level])select.disabled=true;
    select.value=selected;
    select.addEventListener('change',()=>{
     const value=select.value;
     const choice=options.find(o=>o.value===value);
     if(value&&!(index===0&&value==='\u0000none')&&!choice){select.value=selected;return;}
     for(const [l] of LEVELS.slice(index))pick[l]='';
     if(value==='\u0000none')pick.domain=value;
     else if(choice)for(const [l] of LEVELS.slice(0,index+1))pick[l]=choice.path[l];
     journalView.field=pick.field;journalView.page=0;render();
    });
    if(index<LEVELS.length-1)node('span','›',line,{class:'sc-field-sep','aria-hidden':'true'});
   }
   if(pick.domain||pick.field||pick.subfield){const clear=button('전체',()=>{for(const [l] of LEVELS)pick[l]='';journalView.field='';journalView.page=0;render();},line,{class:'sc-field-clear',title:'분야 선택 지우기'});}
   // Overall order is a local catalog position, never an official JCR category rank.
   const order={if:(a,b)=>(a.globalRank&&b.globalRank)?a.globalRank-b.globalRank:(b.impact??-1)-(a.impact??-1)||a.venue.localeCompare(b.venue),name:(a,b)=>a.venue.localeCompare(b.venue),papers:(a,b)=>b.papers-a.papers||(b.impact??-1)-(a.impact??-1),fieldrank:(a,b)=>{const x=selectedJournalRanks(a)[0],y=selectedJournalRanks(b)[0];return (x?x.rank/x.of:9)-(y?y.rank/y.of:9)||(b.impact??-1)-(a.impact??-1)||a.venue.localeCompare(b.venue);},quartile:(a,b)=>(a.quartile??9)-(b.quartile??9)||(b.impact??-1)-(a.impact??-1)}[journalView.sort]||((a,b)=>0);
   const listArea=node('div',null,body,{class:'sc-journal-list'});
   journalView.redraw=()=>{
   listArea.replaceChildren();
   /* "Nat. Commun." and "2041-1723" are how a reader writes a journal down,
      so the dots come out of both sides and the ISSNs go in, with and
      without their hyphen. */
   const plainQuery=text=>model.norm(text).replace(/\./g,'').trim();
   const q=plainQuery(journalView.query||'');
   const found=j=>{
    if(!q)return true;
    if(j.haystack===undefined)j.haystack=plainQuery([j.venue,j.abbreviation,j.publisher,...(j.issns||[]),
     ...(j.issns||[]).map(issn=>String(issn).replace(/-/g,'')),...j.levels.flatMap(l=>[l.domain,l.field,l.subfield])]
     .filter(Boolean).join('\u0000'));
    return j.haystack.includes(q);
   };
   const shownAll=all.filter(j=>matches(j)&&found(j)).sort(order);
   if(!shownAll.length){node('p',q?'검색에 맞는 저널이 없습니다.':'이 분야의 저널이 없습니다.',listArea,{class:'sc-empty'});return;}
   // A page at a time past a hundred rows: the registry is twenty-two thousand.
   const pageSize=100,pages=Math.ceil(shownAll.length/pageSize);
   journalView.page=Math.max(0,Math.min(journalView.page||0,pages-1));
   const shown=shownAll.length>pageSize?shownAll.slice(journalView.page*pageSize,(journalView.page+1)*pageSize):shownAll;
   if(shownAll.length>pageSize){
    const paging=node('div',null,listArea,{class:'sc-actions sc-journal-paging'});
    node('span',`${journalView.page*pageSize+1}–${journalView.page*pageSize+shown.length} / ${shownAll.length.toLocaleString()}`,paging,{class:'sc-muted',role:'status'});
    button('이전',()=>{journalView.page--;journalView.redraw();},paging).disabled=journalView.page===0;
    button('다음',()=>{journalView.page++;journalView.redraw();},paging).disabled=journalView.page+1>=pages;
   }
   /* A table, as the user asked: one column each for the rank, the name in
      the journal's own colour (text, no box), quartile, abbreviation, house,
      papers here, fields, and the figure; the column names once at the top. */
   const table=node('table',null,listArea,{class:'sc-journal-table'});
   const thead=node('thead',null,table);const hr=node('tr',null,thead,{class:'sc-journal-head'});
   const commonYear=shown[0].year&&shown.every(j=>String(j.year||'')===String(shown[0].year))?shown[0].year:null;
   for(const [label,cls] of [['로컬 JIF 순번','sc-col-rank'],['저널','sc-col-name'],['저장 Q','sc-col-q'],['약어','sc-col-abbr'],['출판사','sc-col-pub'],['내 문헌','sc-col-n'],['OpenAlex 분야','sc-col-fields'],['로컬 분야 순위','sc-col-fieldrank'],[`JIF${commonYear?' '+commonYear:''}`,'sc-col-if']])node('th',label,hr,{scope:'col',class:cls});
   const tbody=node('tbody',null,table);
   if(journalView.grouped){
    const groups=new Map();
    // Grouped by the level beneath the one chosen: fields by default, subfields once a field is picked.
    const groupLevel=pick.field?'subfield':pick.domain?'field':'field';
    for(const j of shown){const path=j.levels.find(x=>journalPathMatches(x,pick));const index=groupLevel==='field'?1:2;
     const key=path?journalPathKey(path,index):'\u0000none';const group=groups.get(key)||{label:path?journalPathLabel(path,index):T('분야 미확인'),list:[]};group.list.push(j);groups.set(key,group);}
    const sections=[...groups.values()].sort((a,b)=>b.list.length-a.list.length||a.label.localeCompare(b.label));
    for(const {label:field,list} of sections){
     const gr=node('tr',null,tbody,{class:'sc-journal-group'});node('th',`${field} · ${list.length}종`,gr,{colspan:'9',scope:'colgroup',class:'sc-hit-group'});
     list.sort(order).forEach(j=>journalRow(j,tbody,j.globalRank));
    }
   }else{
    shown.forEach(j=>journalRow(j,tbody,j.globalRank));
   }
   };
   function redrawJournalList(){if(disposed||state.tab!=='journals'||!listArea.isConnected)return;journalView.redraw();}
   journalView.redraw();
   if(!String(runtime.pref?.('journalRankKey','')||'').trim()){
    node('p','저장 Q는 원본 카테고리가 확인되지 않은 값입니다. CAS 등 추가 등급 조회는 easyScholar 키(선택)가 필요합니다.',
     body,{class:'sc-muted'});
   }
  }
  function journalRow(j,tbody,rank){
   const open=journalView.open.has(j.venue);
   const tr=node('tr',null,tbody,{class:'sc-journal'+(open?' sc-journal-open':''),'data-venue':j.venue});
   node('td',rank!=null?rank.toLocaleString():'',tr,{class:'sc-col-rank sc-journal-rank',title:rank!=null?`저장된 목록에서 ${rank.toLocaleString()}번째 (JIF 순, 공식 JCR 순위 아님)`:'저장된 목록에 없음'});
   if(!j.papers)tr.classList.add('sc-journal-absent');
   // The name in the journal's own colour, as text: the colour is the mark.
   const nameCell=node('td',null,tr,{class:'sc-col-name'});
   const title=node('button',j.venue,nameCell,{class:'sc-journal-name',type:'button','aria-expanded':String(open),title:'프로필 펼치기·접기','data-safe':'view'});
   title.addEventListener('click',()=>{if(journalView.open.has(j.venue))journalView.open.delete(j.venue);else journalView.open.add(j.venue);journalView.redraw?.();});
   const identity=runtime.journalIdentity;
   if(j.id&&identity?.colours){try{const tone=identity.colours(j.id,{dark:darkScheme()});const ink=tone.ink;if(ink){title.style.color=ink;title.style.fontWeight='600';}}catch(_){}}
   const qCell=node('td',null,tr,{class:'sc-col-q'});
   if(j.quartile)node('span',`Q${j.quartile}?`,qCell,{class:'sc-quartile','data-q':String(j.quartile),title:`저장된 Q${j.quartile} · 카테고리 미확인`});
   node('td',j.abbreviation||'',tr,{class:'sc-col-abbr',title:j.abbreviation||''});
   node('td',j.publisher||'',tr,{class:'sc-col-pub',title:j.publisher||''});
   node('td',j.papers?String(j.papers):'—',tr,{class:'sc-col-n'+(j.papers?'':' sc-none'),title:j.papers?`내 문헌 ${j.papers}편`:'내 서재에 없는 저널'});
   const fieldsCell=node('td',null,tr,{class:'sc-col-fields'});
   if(!j.levels.length){fieldsCell.textContent='—';fieldsCell.classList.add('sc-journal-if-none');fieldsCell.title=T('저장된 OpenAlex 분야 정보가 없습니다.');}
   if(j.levels.length){
    const byField=new Map();for(const l of j.levels){if(!l.field)continue;const key=journalPathKey(l,1),entry=byField.get(key)||{path:l,subs:[]};if(l.subfield&&!entry.subs.includes(l.subfield))entry.subs.push(l.subfield);byField.set(key,entry);}
    const parts=[...byField.values()].map(({path,subs})=>`${journalPathLabel(path,1)}${subs.length?' › '+subs.join(' · '):''}`);
    // Two fields fill the column; a journal that spans more says how many, and
    // the tooltip has all of them.
    fieldsCell.textContent=parts.length>2?parts.slice(0,2).join(' | ')+` +${parts.length-2}`:parts.join(' | ');
    fieldsCell.title=parts.join('\n');
    if(journalView.pick.field&&byField.has(journalPathKey(journalView.pick,1)))fieldsCell.classList.add('sc-chip-on-text');
   }
   // Only the selected coherent path supplies its local comparison rank.
   const rankCell=node('td',null,tr,{class:'sc-col-fieldrank'});
   const ranks=selectedJournalRanks(j),best=ranks[0]||null;
   if(!best){rankCell.textContent='—';rankCell.classList.add('sc-journal-if-none');
    rankCell.title=T(j.impact==null?'JIF가 없으면 분야 안에서 줄을 세울 수 없습니다.':'선택한 OpenAlex 경로의 로컬 JIF 비교 순위가 없습니다.');}
   else{
    const place=node('span',`${best.rank.toLocaleString()}/${best.of.toLocaleString()}`,rankCell,{class:'sc-field-rank'});
    place.dataset.q=String(best.quartile);
    rankCell.title=T('OpenAlex 분야와 저장 JIF의 로컬 비교 · 공식 JCR 순위 아님')+'\n'+ranks.map(r=>T(`${journalPathLabel(r)||r.name} ${r.of.toLocaleString()}종 중 ${r.rank.toLocaleString()}위 · 상위 ${r.percentile}% · 로컬 Q${r.quartile}`)).join('\n');
   }
   const figure=node('td',j.impact!=null?j.impact.toFixed(1):'—',tr,{class:'sc-col-if sc-journal-if',title:j.impact!=null?`JIF ${j.impact.toFixed(1)}${j.year?' ('+j.year+')':''}${j.source?' · '+j.source:''}`:'IF 미확인'});
   if(j.impact==null)figure.classList.add('sc-journal-if-none');
   else figure.dataset.tone=j.impact>=10?'top':j.impact>=5?'high':j.impact>=2?'mid':'low';
   // The two lookups, laid over the row's right side while the pointer is on it.
   const actions=node('div',null,fieldsCell,{class:'sc-hit-actions'});
   if(j.items.length)button('지표 조회',async()=>{
    const ref=runtime.Z.Items.get(Number(j.items[0].id));
    const hit=await runtime.fetchJournalMetric(runtime.journalRecord(ref));
    await load();
    message(hit&&hit.citedness!=null
     ?`${hit.name||j.venue}: 2년 평균 피인용 ~${hit.citedness} (OpenAlex 추정치, 공식 JIF 아님)`
     :`${j.venue}: OpenAlex에 이 저널의 지표가 없습니다.`);
   },actions);
   if(j.items.length)button('공식 값 새로고침',async()=>{const result=await runtime.refreshJournalMetrics([runtime.Z.Items.get(Number(j.items[0].id))],win.DOMParser);message(`확인 ${result.updated} · 미확인 ${result.failed+result.unknown}`);await load();},actions);
   if(j.items.length&&String(runtime.pref?.('journalRankKey','')||'').trim()){
    button('등급 조회',async()=>{await runtime.refreshPublicationRanks([runtime.Z.Items.get(Number(j.items[0].id))]);await load();message('저널 등급 조회를 마쳤습니다.');},actions);
   }
   if(open){const pr=node('tr',null,tbody,{class:'sc-journal-profile-row'});const cell=node('td',null,pr,{colspan:'9'});journalProfile(j,cell);}
  }
  function journalProfile(j,card){
   const box=node('div',null,card,{class:'sc-journal-profile'});
   const grid=node('dl',null,box,{class:'sc-facts'});
   const fact=(icon,label,value,{title='',tone=''}={})=>{
    if(value===null||value===undefined||value==='')return null;
    const row=node('div',null,grid,{class:'sc-fact',title:title||label});
    if(tone)row.dataset.tone=tone;
    const dt=node('dt',null,row);journalIcon(icon,dt);node('span',label,dt);
    const dd=node('dd',null,row);
    if(value instanceof win.Node||typeof value==='object')dd.appendChild(value);else dd.textContent=String(T(value));
    return row;
   };
   fact('impact','JIF',j.impact!=null?`${j.impact.toFixed(1)}${j.year?' · '+j.year:''}`:'미확인',{title:j.source||'저장된 JIF 자료',tone:j.impact==null?'':j.impact>=10?'top':j.impact>=5?'high':j.impact>=2?'mid':'low'});
   fact('quartile','저장 Q',j.quartile?`Q${j.quartile}?`:'미확인',{title:'카테고리 미확인 · 공식 카테고리별 사분위로 사용할 수 없습니다'});
   fact('abbreviation','약어',j.abbreviation||null,{title:'JCR 표준 약어'});
   fact('publisher','출판사',j.publisher||null);
   fact('issn','ISSN',j.issns.length?j.issns.join(' · '):null);
   if(j.fields.length){const span=doc.createElementNS(HTML,'span');j.fields.forEach(f=>{node('span',f,span,{class:'sc-chip sc-chip-tiny'});});fact('field','OpenAlex 분야',span,{title:'표와 필터에 사용하는 동일한 OpenAlex 분류 경로'});}
   fact('hindex','h-index',j.hIndex!=null?String(j.hIndex):null,{title:'OpenAlex 기준 저널 h-index'});
   fact('works','발행·피인용',j.works!=null?(j.citedness!=null?T(`${compact(j.works)}편 · 2년 평균 피인용 ${j.citedness}`):T(`${compact(j.works)}편`)):null,{title:'OpenAlex 기준 누적 논문 수와 2년 평균 피인용 (공식 JIF 아님)'});
   const access=!j.profile?null:[T(j.isOA?'전면 OA':'구독형'),j.inDoaj?T('DOAJ 등재'):'',j.apc!=null?T(j.isOA?'APC ${0}':'OA 선택 시 APC ${0}').replace('{0}',j.apc.toLocaleString()):''].filter(Boolean).join(' · ');
   fact('access','오픈액세스',access,{tone:j.isOA?'low':''});
   fact('country','국가',j.country?`${COUNTRY_NAMES[j.country]||j.country}`:null);
   if(j.homepage){const a=node('a',j.homepage.replace(/^https?:\/\/(www\.)?/,'').replace(/\/$/,''),null,{href:'#',title:j.homepage});a.addEventListener('click',e=>{e.preventDefault();runtime.Z.launchURL&&runtime.Z.launchURL(j.homepage);});fact('link','홈페이지',a);}
   const profileRanks=selectedJournalRanks(j),rankNames=new Map();
   for(const r of profileRanks)rankNames.set(r.name,(rankNames.get(r.name)||0)+1);
   for(const r of profileRanks){
    const parent=r.level==='subfield'?r.field:r.domain;
    const label=rankNames.get(r.name)>1&&parent?`${parent} › ${r.name}`:r.name;
    fact('quartile',label,`${r.rank.toLocaleString()}위 / ${r.of.toLocaleString()}종 · 상위 ${r.percentile}% · 로컬 Q${r.quartile}`,
     {title:(journalPathLabel(r)||r.name)+'\n'+T('OpenAlex 분야와 저장 JIF의 로컬 비교 · 공식 JCR 순위 아님'),tone:r.quartile===1?'top':r.quartile===2?'high':r.quartile===3?'mid':'low'});
   }
   if(j.globalRank)fact('quartile','로컬 JIF 순번',`${j.globalRank.toLocaleString()}번째 / ${(runtime.journalIdentity?.registryRanked?.()||[]).length.toLocaleString()}`,{title:'저장된 목록의 JIF 순번 · 공식 JCR 카테고리 순위 아님'});
   fact('library','내 서재',j.papers?`${j.papers}편 · 읽음 ${j.read} · 평균 피인용 ${j.avgCited}${j.span?' · '+(j.span[0]===j.span[1]?j.span[0]:j.span[0]+'–'+j.span[1]):''}`:'없음',{title:'이 서재에서 이 저널의 문헌'});
   if(!j.profile)node('p','추가 OpenAlex 프로필은 “빈 칸 채우기”로 조회할 수 있습니다. 저장된 분류는 표와 상세에서 동일하게 표시됩니다.',box,{class:'sc-muted sc-fact-note'});
   const actions=bar(box);
   if(j.papers)button('이 저널 문헌 보기',()=>{state.query=search.value=j.venue;navigate('explore');},actions);
   else if(typeof runtime.Z?.ZotPoP?.openSearch==='function')button('ZotPoP에서 이 저널 검색',()=>runtime.Z.ZotPoP.openSearch(win,{venue:j.venue}),actions,{'data-opens':'window'});
   if(j.abbreviation){
    {const b=button('JCR에서 보기',()=>runtime.Z.launchURL&&runtime.Z.launchURL(`https://jcr.clarivate.com/jcr-jp/journal-profile?journal=${encodeURIComponent(j.abbreviation)}&year=${j.year||new Date().getFullYear()-1}`),actions,{title:'Journal Citation Reports의 저널 페이지 · 기관 로그인이 필요합니다','data-opens':'browser'});journalIcon('link',b);b.insertBefore(b.lastChild,b.firstChild);}
   }
   if(j.openAlexID){const b=button('OpenAlex에서 보기',()=>runtime.Z.launchURL&&runtime.Z.launchURL(`https://openalex.org/${j.openAlexID}`),actions,{'data-opens':'browser'});journalIcon('link',b);b.insertBefore(b.lastChild,b.firstChild);}
  }
  function drawAssist(){let item;try{item=one();}catch(_){pickOne(empty('번역·요약할 문헌 하나를 선택하세요. AI 서버 주소와 모델은 설정에서 연결합니다.'));return;}bindAI(item.id);node('h2',item.title,body);const b=bar();const language=node('input',null,b,{value:setting('aiLanguage','Korean'),'aria-label':'출력 언어',class:'sc-lang'});const output=node('textarea',null,body,{class:'sc-ai-output','aria-label':'AI 생성 결과 — 적용 전 확인',placeholder:T('요청하면 결과가 여기에 나타납니다.')});if(state.aiOutput)output.value=Array.isArray(state.aiOutput)?state.aiOutput.join(', '):state.aiOutput;
   const aiReady=!!(String(runtime.pref('aiEndpoint','')||'').trim()&&String(runtime.pref('aiModel','')||'').trim());
   /* Two parts, named: what to ask, and what came back. The request row and
      the result box used to run together under the paper's title, and the
      note saying the service was not set up sat below the box it explained. */
   const askHead=sectionHead('요청',null,body);body.insertBefore(askHead,b);
   if(!aiReady)body.insertBefore(node('p','Zotero 설정 → Style Custom → 번역·AI에 AI 서버 주소·모델·API 키를 넣으면 켜집니다. 요청은 버튼을 누를 때만 보냅니다.',null,{class:'sc-muted sc-settings-note'}),b);
   b.insertBefore(node('span',T('출력 언어'),null,{class:'sc-settings-label'}),language);
   body.insertBefore(sectionHead('결과',null,body),output);
   // Nothing to stop until something is running.
   const stopAI=button('요청 중지',()=>{aiEpoch++;assist.cancel?.();message('AI 요청을 중지했습니다.');stopAI.hidden=true;},b,{class:'sc-danger-soft'});stopAI.hidden=true;
   /* What each request sends, so a press that cannot succeed is off before
      it is made: nothing without a server, and nothing that needs an
      abstract for a paper that has none. */
   const hasAbstract=!!String(item.abstract||'').trim();
   const NEEDS_ABSTRACT=new Set(['summary','remark','tags']);
   if(aiReady&&!hasAbstract)body.insertBefore(node('p','이 문헌에는 초록이 없어 요약·메모·태그 제안은 쓸 수 없습니다. 제목 번역만 됩니다.',null,{class:'sc-muted sc-settings-note'}),b);
   for(const[task,label]of [['translate','제목 번역'],['summary','초록 요약'],['remark','읽기 메모 제안'],['tags','태그 제안']])button(label,async()=>{message(task==='translate'?'제목을 AI 서버에 보내는 중…':'제목·초록을 AI 서버에 보내는 중…');stopAI.hidden=false;const request=++aiEpoch;let result;const memoBase=storedMemo(item.id);try{result=await assist.run(task,item,{language:language.value});}finally{stopAI.hidden=true;}if(disposed||panel.hidden||state.tab!=='assist'||request!==aiEpoch||state.aiItemID!==item.id||selected().length!==1||selected()[0].id!==item.id)return;state.aiTask=task;state.aiOutput=result;state.aiMemoBase=memoBase;const current=body.querySelector('.sc-ai-output');if(current){current.value=Array.isArray(result)?result.join(', '):result;updateDraft(current.dataset.draftKey,current.value);syncAIApply();}message('AI 생성 결과입니다. 원문과 비교한 뒤 적용하세요.');},b,{'data-writes':'network',title:!aiReady?T('설정에서 AI 서버를 연결하면 켜집니다'):(NEEDS_ABSTRACT.has(task)&&!hasAbstract)?T('초록이 없는 문헌입니다'):''}).disabled=!aiReady||(NEEDS_ABSTRACT.has(task)&&!hasAbstract);
   const actions=bar();button('결과 복사',()=>copy(output.value),actions);button('선택 문헌에 적용',async()=>{if(!output.value.trim()||state.aiItemID!==item.id||!state.aiTask)throw new Error('현재 문헌의 결과를 먼저 생성하세요.');const ref=runtime.Z.Items.get(Number(item.id));if(state.aiTask==='tags')await library.addTags([item.id],output.value.split(',').map(s=>s.trim()).filter(Boolean));else if(state.aiTask==='remark'){const out=await library.setRemark(item.id,output.value,{base:state.aiMemoBase});if(out&&out.stale)throw new Error('이 제안을 만든 뒤 저장된 메모가 바뀌어 적용하지 않았습니다. 메모를 확인한 뒤 다시 생성하세요.');}else{runtime.entry(ref)[state.aiTask==='translate'?'translatedTitle':'summary']=output.value;runtime.dirty=true;await runtime.flush();}message('확인한 결과를 저장했습니다.');await runtime.refreshWindows();},actions,{'data-variant':'primary','data-ai-apply':'true'});syncAIApply();
  }
  /* The settings page as sections, each with its name, one line saying what it
     changes, its options one per line, and its action under them. It was one
     run of twenty-four checkboxes, a colour well, a number and two text boxes
     with no headings, and nothing said which control belonged to which. */
  function drawAppearance(){
   const part=(label,note)=>{const box=node('section',null,body,{class:'sc-settings-part'});sectionHead(label,null,box);if(note)node('p',note,box,{class:'sc-muted sc-settings-note'});return box;};
   const menusOn=enabled('menuVisibility');
   if(menusOn){
    const menus=part('작업 메뉴','왼쪽 목록에 보일 기능을 고릅니다. 숨긴 기능은 ⌘/Ctrl K 검색에서도 빠집니다.');
    // The switches follow the sidebar: one small head per group (탐색, 읽기, 정리, 도구), its own grid under it.
    for(const [groupLabel,ids] of GROUPS){
     const members=ids.filter(id=>id!=='appearance'&&TABS.some(([key])=>key===id));
     if(!members.length)continue;
     node('div',T(groupLabel),menus,{class:'sc-settings-sublabel'});
     const grid=node('div',null,menus,{class:'sc-settings-grid'});
     // The grid's heading says what these are, so each shows only its name; a
     // screen reader, reaching one on its own, still hears the whole phrase.
     for(const id of members){const label=TABS.find(([key])=>key===id)[1];check(T(label),!hiddenTabs().has(id),on=>run(async()=>{const hidden=hiddenTabs();on?hidden.delete(id):hidden.add(id);runtime.cache.hiddenWorkbenchTabs=[...hidden];runtime.dirty=true;await runtime.flush();render();}),grid)
      .setAttribute('aria-label',T(label)+' '+T('메뉴 표시'));}
    }
    // Resetting every menu undoes the grid above it, so it sits under the grid as a verb that removes.
    button('메뉴 기본값 복원',async()=>{runtime.cache.hiddenWorkbenchTabs=[];runtime.dirty=true;await runtime.flush();render();},bar(menus),{class:'sc-danger-soft'});
   }
   const look=part('패널 모양','강조 색과 글꼴 크기는 이 패널에만 적용됩니다. PDF 색상은 읽기 진행에서 설정하세요.');
   const form=bar(look);
   node('span',T('강조 색'),form,{class:'sc-settings-label'});
   const accent=node('input',null,form,{type:'color','aria-label':'강조 색상'});accent.value=runtime.pref('accentColor','#374151');
   node('span',T('글꼴 크기'),form,{class:'sc-settings-label'});
   /* A stepper, not the native number spinner (two 6px arrows no one can hit): minus, the size, plus; 11 to 20. */
   const size={value:String(runtime.pref('panelFontSize',13))};
   const stepper=node('span',null,form,{class:'sc-stepper',role:'group','aria-label':T('패널 글꼴 크기')});
   const shown=node('span',size.value,stepper,{class:'sc-stepper-value',role:'status'});
   const nudge=delta=>{const next=Math.max(11,Math.min(20,(Number(size.value)||13)+delta));size.value=String(next);shown.textContent=size.value;minus.disabled=next<=11;plus.disabled=next>=20;};
   const minus=button('−',()=>nudge(-1),stepper,{'aria-label':'글꼴 크기 줄이기',class:'sc-stepper-button'});
   stepper.insertBefore(minus,shown);
   const plus=button('+',()=>nudge(1),stepper,{'aria-label':'글꼴 크기 키우기',class:'sc-stepper-button'});
   nudge(0);
   // The app's own light/dark switch only flips between the two (the setting has no 'follow the system' value), so it sits on the same row as the other panel look controls.
   node('span',T('앱 테마'),form,{class:'sc-settings-label'});
   button('앱 밝게/어둡게 전환',()=>runtime.toggleAppTheme(),form);
   button('스타일 저장',async()=>{runtime.Z.Prefs.set('extensions.style-custom.accentColor',accent.value,true);const fontSize=Math.max(11,Math.min(20,Number(size.value)||13));runtime.Z.Prefs.set('extensions.style-custom.panelFontSize',fontSize,true);if(['#374151','#5654d8'].includes(accent.value.toLowerCase()))panel.style.removeProperty('--sc-accent');else panel.style.setProperty('--sc-accent',accent.value);panel.style.fontSize=fontSize+'px';size.value=String(fontSize);message(`패널 모양을 저장했습니다 · 글꼴 ${fontSize}px`);},form,{'data-variant':'primary'});
   const list=part('목록 표시','Zotero 문헌 목록의 제목 열과 항목 아이콘에 적용됩니다.');
   const opts=node('div',null,list,{class:'sc-settings-stack'});
   check('제목 옆 색상·별점 태그',runtime.pref('titleTags',false),on=>{runtime.Z.Prefs.set('extensions.style-custom.titleTags',on,true);runtime.refreshWindows();},opts);
   check('안 읽은 제목 굵게',runtime.pref('unreadBold',false),on=>{runtime.Z.Prefs.set('extensions.style-custom.unreadBold',on,true);runtime.refreshWindows();},opts);
   check('제목 읽기 히트맵',runtime.pref('titleHeatmap',false),on=>{runtime.Z.Prefs.set('extensions.style-custom.titleHeatmap',on,true);runtime.refreshWindows();},opts);
   check('항목 아이콘 클릭으로 유형 필터',runtime.pref('quickTypeFilter',true),on=>runtime.Z.Prefs.set('extensions.style-custom.quickTypeFilter',on,true),opts);
   check('문서 탭 활동 시 수정일 갱신',runtime.pref('touchDateOnRead',false),on=>runtime.Z.Prefs.set('extensions.style-custom.touchDateOnRead',on,true),opts);
   const fields=part('추가 열','문헌 목록에 열로 보일 Zotero 필드 이름을 쉼표로 적습니다.');
   const fieldRow=bar(fields);
   const customFields=node('input',null,fieldRow,{'aria-label':'추가 문헌 열','placeholder':'DOI, publisher, language'});customFields.value=runtime.pref('customFields','');
   button('추가 열 적용',async()=>{const fields=await runtime.setCustomFields(customFields.value);
    // The columns are registered hidden, as Zotero's own are: the message says where to turn them on.
    const n=Array.isArray(fields)?fields.length:0;
    message(n?`추가 열 ${n}개를 등록했습니다. 문헌 목록 머리글을 오른쪽 클릭해 켜세요.`:'추가 열을 모두 뺐습니다.');},fieldRow);
   if(enabled('styleEditor')){
    const edit=part('패널 CSS','이 패널 안에만 적용됩니다. 외부 파일을 불러오는 규칙(@import, url())은 받지 않습니다.');
    const css=node('textarea',null,edit,{'aria-label':'Custom 패널 CSS',placeholder:'.sc-card { font-size: 13px; }'});css.value=runtime.pref('panelCSS','');
    button('패널 CSS 적용',()=>{runtime.setPanelCSS(css.value);message(css.value.trim()?'패널 CSS를 적용했습니다.':'패널 CSS를 비웠습니다.');},bar(edit));
   }
  }
  async function render(){if(disposed||panel.hidden)return;if(hiddenTabs().has(state.tab))state.tab='appearance';
   if(needsRuleData()){try{await ensureRuleData();}catch(error){runtime.Z?.logError?.(error);}if(disposed||panel.hidden)return;}
   /* "선택한 문헌" with nothing selected showed an empty list that read as
      broken: after 자세히 the scope stayed on the selection, and the
      selection went away with the next click in the tree. With nothing to
      show, the scope falls back to the library. */
   if(state.scope==='selected'&&!state.selected.size){state.scope='library';scope.value='library';state.selectionLabel='';restoreKept();}const token=++epoch;state.exploreCount=null;state.tabCount=null;clear();reloadDeferSince=0;for(const b of kindChips.querySelectorAll('button'))b.setAttribute('aria-pressed',String(state.type===b.dataset.kind));memoFields=[];draftContext=JSON.stringify([state.tab,state.libraryID,[...state.selected].sort()]);draftCounters=new Map();for(const[id,b]of navButtons){b.hidden=hiddenTabs().has(id);b.setAttribute('aria-current',id===state.tab?'page':'false');b.classList.toggle('active',id===state.tab);b.setAttribute('tabindex',id===state.tab?'0':'-1');}updateChrome();refreshNotice().catch(()=>{});
   // Said in the panel, never in a modal: the first background write into Extra.
   if(runtime.cache?.citationExtraNoticePending){win.setTimeout(()=>{if(disposed||panel.hidden||!runtime.cache.citationExtraNoticePending)return;message("인용 수를 Extra 필드에 'Citations: N (출처, 날짜)' 한 줄로 기록합니다. 원하지 않으면 설정 → Style Custom → 인용 수·IF → '논문 추가·수정 시 인용 수 조회 후 Extra 저장'을 끄세요.");delete runtime.cache.citationExtraNoticePending;runtime.dirty=true;},0);}try{
   switch(state.tab){case'explore':{
    /* A43's widening only runs a scope note/annotation read when the box is
       actually on and there is something to widen; otherwise this stays the
       exact same synchronous call it always was. exploreRows() is async, and
       awaiting it -- even along its own early-return path -- defers to a
       microtask; several filter changes fired without awaiting each render
       (as 보유 문헌's own controls do) could then interleave their clear()s
       with a paperList() still pending from an earlier one, each adding its
       own cards on top of the next's. Only take that detour when needed. */
    if(state.searchRecords&&state.query.trim()){
     const {items,hits}=await exploreRows();
     if(token!==epoch||disposed)break;
     state.exploreCount=items.length;
     await paperList(items,{hits});
     if(token===epoch&&!disposed)updateChrome();
    } else {await paperList(rows());}
    break;
   }case'recent':await drawRecent();break;case'related':await drawRelated(token);break;case'authors':await drawAuthors(token);break;case'graph':drawGraph();break;case'tags':drawTags();break;case'notes':await drawNotes(token);break;case'annotations':await drawAnnotations(token);break;case'backlinks':await drawBacklinks(token);break;case'attachments':await drawAttachments(token);break;case'reading':drawReading();break;case'tabs':drawTabs();break;case'views':drawViews();break;case'canvas':drawCanvas();break;case'matrix':drawMatrix();break;case'collections':await drawCollections(token);break;case'journals':drawJournals();break;case'assist':drawAssist();break;case'appearance':drawAppearance();break;}
   if(token===epoch&&!disposed){groupSections();restoreDrafts();revealNav(navButtons.get(state.tab),false);}
  }catch(error){if(token===epoch&&!disposed)message(readable(error),true);}}
  function refreshMetrics(){
   if(disposed||panel.hidden)return;
   for(const item of state.items){const ref=runtime.Z.Items.get(Number(item.id));if(ref)Object.assign(item,runtime.state(ref));}
   for(const card of body.querySelectorAll('[data-item-id]')){const item=state.items.find(row=>String(row.id)===card.dataset.itemId);if(!item)continue;card.dataset.status=item.status;const time=card.querySelector('[data-metric=time] .sc-metric-value');if(time)time.textContent=Number(item.seconds)>0?(runtime.formatReadTime?runtime.formatReadTime(item.seconds,{compact:true}):Math.floor(item.seconds)+'초'):'';const status=card.querySelector('[data-metric=status]');if(status)status.textContent=({unread:'안 읽음',reading:'읽는 중',done:'완료'})[item.status]||'안 읽음';}
  }
  async function applyPreferences(){panel.dataset.density=setting('workbenchDensity',runtime.cache.workbenchUI?.density||'comfortable');syncDensity();const accent=setting('accentColor','#374151');if(['#374151','#5654d8'].includes(accent.toLowerCase()))panel.style.removeProperty('--sc-accent');else panel.style.setProperty('--sc-accent',accent);panel.style.fontSize=setting('panelFontSize',13)+'px';await render();}
  const keyboard=e=>{if(e.isComposing||panel.hidden)return;
   if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();e.stopPropagation();commands.hidden?openCommands():closeCommands();return;}
   if(!commands.hidden)return;
   const editing=e.target?.closest?.('input,textarea,select,[contenteditable=true]');
   if((e.key==='/'&&!editing)||((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='f')){
    const jcrSearch=state.tab==='journals'&&state.journalBrowser!=='openalex'?body.querySelector('.sc-jcr-search'):null;
    if(jcrSearch){e.preventDefault();jcrSearch.focus?.();jcrSearch.select?.();}
    else if(!controls.hidden){e.preventDefault();search.focus?.();search.select?.();}
   }
   else if(e.key==='Escape'){
    // The filter layers close one at a time, innermost first, and give focus back.
    if(filterPanel.contains(e.target)&&(ruleDraft||filtersOpen())){e.preventDefault();e.stopPropagation();if(ruleDraft)closeRuleEditor(true);else{setFiltersOpen(false);filterSummary.focus?.();}return;}
    if(e.target?.closest?.('input,textarea')){e.target.blur();return;}e.stopPropagation();toggle(false);}
  };panel.addEventListener('keydown',keyboard);
  /* A memo saves itself as it is typed, and the save is an item change that
     reloaded the panel: the field was rebuilt under the cursor a second after
     each pause, and a long list jumped back to the top. While the reader is
     typing in the panel the reload waits, and runs when they leave the field. */
  let reloadPending=false;
  const typing=()=>{const a=doc.activeElement;return !!a&&panel.contains(a)&&(a.localName==='textarea'||a.isContentEditable===true||(a.localName==='input'&&/^(text|search|)$/.test(a.getAttribute('type')||'')));};
  /* A notifier reload never rebuilds a memo under the reader: it waits while an editor has an autosave waiting or a save running,
     re-checks after load()'s own lookups (they can take long), and after about 5 s it goes ahead anyway (every unsaved input is
     already a draft, and the panel must not stop refreshing). */
  let reloadDeferSince=0,notifierLoad=false;
  const memoBusy=()=>{
   if(reloadDeferSince&&Date.now()-reloadDeferSince>5000)return false;
   return [...body.querySelectorAll('textarea[data-memo-item]')].some(e=>{const b=memoBindings.get(e);return !!b&&(b.timerPending?.()||b.busy>0);});
  };
  function reloadAgain(){
   if(disposed||panel.hidden)return;
   if(typing()){reloadPending=true;return;}
   if(memoBusy()){if(!reloadDeferSince)reloadDeferSince=Date.now();reloadTimer=win.setTimeout(reloadAgain,300);return;}
   notifierLoad=true;run(load); // the deadline is kept across load() and reset only by an actual render
  }
  const scheduleReload=()=>{if(disposed||panel.hidden)return;if(typing()){reloadPending=true;return;}reloadPending=false;if(reloadTimer)win.clearTimeout(reloadTimer);reloadTimer=win.setTimeout(reloadAgain,200);};
  panel.addEventListener('focusout',()=>{if(reloadPending)win.setTimeout(()=>{if(reloadPending&&!typing())scheduleReload();},0);});
  if(runtime.Z.Notifier){notifier=runtime.Z.Notifier.registerObserver({notify:scheduleReload},['item','item-tag','collection','tab'],'style-custom-workbench');}
  const selectionTimer=win.setInterval(()=>{if(!disposed&&!win.closed&&!panel.hidden&&scopeContext()!==observedContext)run(load);},500);
  function destroy(){if(disposed)return;
   try{sweepJob?.controller.abort();}catch(_){}
   graphResize?.disconnect?.();if(graphResizeTimer)win.clearTimeout(graphResizeTimer);
   if(tabID){const id=tabID;tabID=null;closingSelf=true;moveBack();try{win.Zotero_Tabs.close(id);}catch(_){}closingSelf=false;}
   // An edit typed a moment ago is still waiting out its timer. Closing the
   // panel must write it, not discard it.
   for(const entry of memoFields)Promise.resolve(entry.flush()).catch(error=>runtime.Z.logError?.(error));
   memoFields=[];
   abortAround();dismissToast();disposed=true;LIVE_DRAFT_WINDOWS.delete(WINDOW_ID);stopMemoListener?.();win.clearInterval(selectionTimer);epoch++;loadEpoch++;aiEpoch++;if(draftTimer){win.clearTimeout(draftTimer);draftTimer=null;Promise.resolve(runtime.flush()).catch(error=>runtime.Z.logError?.(error));}if(reloadTimer)win.clearTimeout(reloadTimer);if(searchTimer){win.clearTimeout(searchTimer);searchTimer=null;}noteCache=null;if(notifier!=null)runtime.Z.Notifier.unregisterObserver(notifier);clear();for(const[target,event,fn]of listeners)target.removeEventListener(event,fn);toolbar?.remove();panel.remove();sheet.remove();jcrSheet.remove();}
  const accent=runtime.pref('accentColor','#374151');if(/^#[a-f\d]{6}$/i.test(accent)&&!['#374151','#5654d8'].includes(accent.toLowerCase()))panel.style.setProperty('--sc-accent',accent);panel.style.fontSize=Math.max(11,Math.min(20,Number(runtime.pref('panelFontSize',13))||13))+'px';
  // Long background work reports here rather than through a modal, so the user
  // can keep reading while the columns fill in behind them.
  const setStatus=value=>{if(!disposed)message(value);};
  const notify=(text,{error=false,full=''}={})=>{if(disposed)return;message(text,error);status.title=full&&full!==text?full:'';return panel.hidden?toggle(true):undefined;};
  return {draftStore:{put:(key,text,base,owner,itemID)=>updateDraft(key,text,base,owner,itemID),count:()=>Object.keys(memoStore()).length,texts:()=>Object.values(memoStore()).map(r=>r.text)},memoEditorState:()=>[...body.querySelectorAll('textarea[data-memo-item]')].filter(e=>e.isConnected).map(e=>memoBindings.get(e)?.state?.()).filter(Boolean),filters:{rules:()=>activeRules(),set:list=>{setRules(model.cleanRules(list));return render();},open:()=>{setFiltersOpen(true);},edit:kind=>openRuleEditor({id:newRuleID(),kind,mode:ruleMode,...ruleDefaults(kind)},false,null),editor:()=>ruleDraft},toggle,load,render,refreshReading,refreshMetrics,applyPreferences,destroy,panel,state,setStatus,notify,flushSearch:applySearch,dock:()=>dock({save:false}),undock:()=>undock({save:false}),docked:()=>!!tabID,dockError:()=>dockError,show:async (tab,focus)=>{navigationEpoch++;if(TABS.some(t=>t[0]===tab))state.tab=tab;state.focus=focus||'';await toggle(true);if(hiddenTabs().has(tab))message('숨겨진 탭입니다. 스타일 편집에서 켜세요.',true);}};
 }
 const api={attach,TABS};root.CustomStyleWorkbench=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);

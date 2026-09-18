/* User-opened, in-window research workspace. Never opens itself or another app. */
(function(root){
 'use strict';
 const HTML='http://www.w3.org/1999/xhtml',SVG='http://www.w3.org/2000/svg';
 const TABS=[['explore','보유 문헌'],['recent','최근 문헌'],['related','관련 논문'],['authors','저자 추적'],['graph','관계 그래프'],['tags','중첩 태그'],['notes','노트'],['annotations','주석'],['backlinks','역링크'],['attachments','첨부 미리보기'],['reading','읽기 진행'],['tabs','탭 관리'],['views','뷰 그룹'],['canvas','캔버스'],['matrix','논문 비교'],['collections','컬렉션'],['journals','저널 지표'],['assist','번역 · AI'],['appearance','스타일 편집']];
 const GROUPS=[['탐색',['explore','recent','related','authors','collections','journals']],['읽기',['reading','notes','annotations','attachments','backlinks']],['정리',['tags','graph','canvas','matrix']],['도구',['tabs','views','assist','appearance']]];
 const FILTER_TABS=new Set(['explore','recent','collections','journals','reading','notes','annotations','attachments','tags','graph']);
 function attach(win,{runtime,library,reader,model,assist}){
  const doc=win.document;let disposed=false,epoch=0,loadEpoch=0,previewEpoch=0,aiEpoch=0,preview=null,notifier=null,reloadTimer=null,draftTimer=null;
  // Every self-saving memo currently on screen, so an edit still inside its
  // one-second wait is written when the panel closes rather than lost.
  let memoFields=[];
  let observedContext=null;let draftContext='',draftCounters=new Map();const drafts=new Map(),visibleAnnotationIDs=new Set(),pageRanges=new Map(),deletedCardSelections=new Map();
  const ui=runtime.cache.workbenchUI&&typeof runtime.cache.workbenchUI==='object'?runtime.cache.workbenchUI:{};
  let returnFocus=null,commandFocus=null,commandIndex=0,commandMatches=[],navigationEpoch=0;const pendingActions=new Set();
  const state={tab:TABS.some(([id])=>id===ui.lastTab)?ui.lastTab:'explore',query:'',type:'',tag:'',status:'',ratingMin:'',yearFrom:'',yearTo:'',sort:'library',scope:'library',items:[],selected:new Set(),annotationIDs:new Set(),graphMode:'related',boardID:null,cardIDs:new Set(),color:'',transpose:false,aiOutput:null,aiTask:null,aiItemID:null,libraryID:null,paletteID:null};
  const enabled=id=>runtime.featureEnabled?.(id)!==false;
  const setting=(key,fallback)=>runtime.getSetting?runtime.getSetting(key):runtime.pref(key,fallback);
  const tabFeature={explore:'explore',recent:'Recent',graph:'graphView',tags:'tags',notes:'noteManager',annotations:'annotationManager',backlinks:'backlinks',attachments:'attachmentPreview',tabs:'tabManager',views:'viewManager',canvas:'canvas'};
  const actionFeature={'선택 주석 색상 변경':'annotationColors','선택 주석 색 바꾸기':'annotationColors','선택 주석 병합':'reader.mergeAnnotations','참조 노트 보기':'backlinks','참조 노트':'backlinks','밝은 PDF':'PDFStyles','어두운 PDF':'PDFStyles','세피아 PDF':'PDFStyles','사용자 PDF 테마 적용':'PDFStyles','주석 팔레트 적용':'annotationColors','주석 팔레트 삭제':'annotationColors','주석 팔레트 저장':'annotationColors','색상 이름 저장':'showAnnotationColorName','여백 주석 설정 적용':'marginAnnotation','관련 문헌으로 연결':'relatedItems','선택 문헌끼리 연결 해제':'relatedItems','선택 문헌에 태그 추가':'addTags','선택 문헌에서 태그 제거':'addTags','선택 문헌 태그 이름 변경':'addTags','초록 요약':'tldr','읽기 메모 제안':'AIGenerateRemark','태그 제안':'AIGenerateTags','앱 밝게/어둡게 전환':'darkLightButton'};
  const DRAFT_LIMIT=100,DRAFT_LENGTH=50000,DRAFT_TOTAL=500000;
  function cachedDrafts(){const saved=runtime.cache.workbenchDrafts;const map=new Map(saved?.version===1&&Array.isArray(saved.entries)?saved.entries.filter(entry=>Array.isArray(entry)&&entry.length===2&&typeof entry[0]==='string'&&entry[0].length<=1000&&!/password|secret|api.?key|access.?token|bearer/i.test(entry[0])&&typeof entry[1]==='string'&&entry[1].length<=DRAFT_LENGTH).slice(-DRAFT_LIMIT):[]);let total=[...map.values()].reduce((sum,value)=>sum+value.length,0);while(total>DRAFT_TOTAL){const key=map.keys().next().value;total-=map.get(key).length;map.delete(key);}return map;}
  for(const [key,value]of cachedDrafts())drafts.set(key,value);
  function updateDraft(key,value){
   if(!key||key.length>1000||/password|secret|api.?key|access.?token|bearer/i.test(key))return;
   const saved=cachedDrafts();saved.delete(key);drafts.delete(key);
   if(value!==undefined){value=String(value).slice(0,DRAFT_LENGTH);saved.set(key,value);drafts.set(key,value);}
   let total=[...saved.values()].reduce((sum,text)=>sum+text.length,0);
   while(saved.size>DRAFT_LIMIT||total>DRAFT_TOTAL){const oldest=saved.keys().next().value;total-=saved.get(oldest).length;saved.delete(oldest);}
   for(const existing of drafts.keys())if(!saved.has(existing))drafts.delete(existing);
   runtime.cache.workbenchDrafts={version:1,entries:[...saved]};runtime.dirty=true;
   if(draftTimer)win.clearTimeout(draftTimer);
   draftTimer=win.setTimeout(()=>{draftTimer=null;Promise.resolve(runtime.flush()).catch(error=>runtime.Z.logError?.(error));},250);
  }
  const hiddenTabs=()=>new Set([...(Array.isArray(runtime.cache.hiddenWorkbenchTabs)?runtime.cache.hiddenWorkbenchTabs:[]).filter(id=>id!=='appearance'&&TABS.some(([key])=>key===id)),...Object.entries(tabFeature).filter(([,feature])=>!enabled(feature)).map(([id])=>id)]);
  const listeners=[];
  const i18n=runtime.i18n||{t:value=>value};
  const T=value=>i18n.t(value);
  // The attributes that carry text a person reads. Everything else is passed
  // through untouched: translating a class name or an id would be a bug.
  const TEXT_ATTRS=new Set(['title','placeholder','aria-label','tooltiptext','label','alt','value']);
  const node=(tag,text,parent,attrs={})=>{const n=doc.createElementNS(HTML,tag);if(text!==null&&text!==undefined)n.textContent=T(text);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,TEXT_ATTRS.has(k)&&tag!=='input'?String(T(v)):k==='placeholder'||k==='aria-label'||k==='title'?String(T(v)):String(v));parent?.appendChild(n);if(draftContext&&['input','textarea'].includes(tag)&&attrs['aria-label']){const label=attrs['aria-label'],index=draftCounters.get(label)||0;draftCounters.set(label,index+1);n.dataset.draftKey=draftContext+'|'+label+'|'+index;}return n;};
  const panel=node('section',null,doc.documentElement,{id:'style-custom-workbench','aria-label':'Style Custom 연구 작업 패널'});panel.hidden=true;
  const sheet=node('link',null,doc.documentElement,{rel:'stylesheet',href:runtime.rootURI+'content/workbench.css'});
  panel.dataset.density=ui.density==='compact'?'compact':'comfortable';panel.setAttribute('role','region');
  const head=node('header',null,panel,{class:'sc-header'}),brand=node('div',null,head,{class:'sc-brand'});node('img',null,brand,{src:runtime.rootURI+'content/icons/style-custom.svg',width:24,height:24,alt:'','aria-hidden':'true'});node('strong','Style Custom',brand);node('span','연구 작업 패널',brand,{class:'sc-subtitle'});const headerActions=node('div',null,head,{class:'sc-header-actions'});
  const status=node('div','준비',panel,{class:'sc-status',role:'status','aria-live':'polite'});
  function message(value,error=false){if(disposed)return;status.textContent=String(T(value));status.dataset.error=String(error);}
  // The last three features shipped and then sat empty because they waited on a
  // context-menu item nobody had a reason to look for. Putting the new one in
  // the same place would repeat that, so the panel says what is missing, where
  // the user already is, and offers to fill it.
  const notice=node('div',null,panel,{class:'sc-notice',hidden:'hidden'});
  async function refreshNotice(){
   if(disposed||typeof runtime.backfillPending!=='function')return;
   let pending=null;
   // Counting means reading every item, and reading items is asynchronous in
   // Zotero; doing it synchronously is what broke every sweep in this plugin.
   try{pending=await runtime.backfillPending();}catch(error){return;}
   if(disposed)return;
   const total=(pending?.signals||0)+(pending?.journals||0)+(pending?.authors||0)+(pending?.files||0);
   if(!total||runtime.backfilling){notice.hidden=true;return;}
   notice.hidden=false;notice.replaceChildren();
   const parts=[];
   if(pending.files)parts.push(`종류 미판별 첨부 ${pending.files}편`);
   if(pending.signals)parts.push(`철회 여부 미확인 ${pending.signals}편`);
   if(pending.journals)parts.push(`지표 없는 저널 ${pending.journals}종`);
   if(pending.authors)parts.push(`확인 안 한 관심 저자 ${pending.authors}명`);
   node('span',parts.join(' · '),notice,{class:'sc-notice-text'});
   const act=node('div',null,notice,{class:'sc-notice-actions'});
   button('지금 채우기',()=>run(async()=>{
    notice.hidden=true;
    const report=await runtime.runBackfill({onProgress:({stage,done,total})=>
     message(`${({signals:'철회·공개접근 신호',journals:'저널 지표',authors:'관심 저자 새 논문'})[stage]||stage} 채우는 중 ${done+1}/${total}`)});
    if(disposed)return;
    message(runtime.backfillSummary(report),!!report.budgetGone);
    await refreshNotice();
   }),act);
   button('나중에',()=>{notice.hidden=true;},act);
  }
  // A transport failure is not a sentence. The panel used to print the whole
  // OpenAlex URL with "failed with status code 429" on the end.
  const failures=root.CustomStyleFailures||{describe:error=>error?.message||String(error)};
  const readable=error=>failures.describe(error)||String(error?.message||error||'');
  async function run(fn){try{return await fn();}catch(error){if(!disposed)message(readable(error),true);return null;}}
  const button=(label,fn,parent,attrs={})=>{
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
  const SVG_NS='http://www.w3.org/2000/svg';
  const ICONS={
   density:[['line',{x1:3,y1:5,x2:13,y2:5}],['line',{x1:3,y1:8,x2:13,y2:8}],['line',{x1:3,y1:11,x2:13,y2:11}]],
   search:[['circle',{cx:7.25,cy:7.25,r:4.25}],['line',{x1:10.5,y1:10.5,x2:13.5,y2:13.5}]],
   close:[['line',{x1:4,y1:4,x2:12,y2:12}],['line',{x1:12,y1:4,x2:4,y2:12}]],
   // One drawn shape per tab. Nineteen identical lines of text is a list you
   // read; nineteen distinct silhouettes is a list you recognise, which is the
   // difference between finding a tab and scanning for it every time.
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
   const parts=String(name||'').trim().split(/\s+/).filter(Boolean);
   if(!parts.length)return '?';
   const first=parts[0][0]||'';
   const last=parts.length>1?parts[parts.length-1][0]:'';
   return (first+last).toUpperCase();
  }
  async function paintPortrait(face,person){
   if(!runtime.fetchPortrait||!person?.id)return;
   const known=runtime.portraitOf?.(person.id);
   const draw=found=>{
    if(disposed||!face.isConnected||!found?.url)return;
    const img=doc.createElementNS(HTML,'img');
    img.src=found.url;img.alt='';img.setAttribute('aria-hidden','true');
    img.addEventListener('error',()=>img.remove());
    img.addEventListener('load',()=>{face.dataset.hasPhoto='true';});
    face.appendChild(img);
    face.title=found.page?`사진 출처: ${found.page}`:'';
   };
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
  const density=button('',()=>{panel.dataset.density=panel.dataset.density==='compact'?'comfortable':'compact';syncDensity();return saveUI({density:panel.dataset.density});},headerActions,{'aria-label':'화면 밀도 전환',class:'sc-icon-button'});
  setIcon(density,'density');
  function syncDensity(){const compact=panel.dataset.density==='compact';density.title=compact?'간격 넓게':'간격 좁게';density.setAttribute('aria-pressed',String(compact));}syncDensity();
  setIcon(button('',()=>openCommands(),headerActions,{'aria-keyshortcuts':'Meta+K Control+K','aria-label':'기능 찾기',title:'기능 찾기 · ⌘/Ctrl K',class:'sc-icon-button'}),'search');
  setIcon(button('',()=>toggle(false),headerActions,{'aria-label':'작업 패널 닫기',title:'닫기',class:'sc-icon-button'}),'close');
  const controls=node('div',null,panel,{class:'sc-controls sc-search-row'});
  const search=node('input',null,controls,{type:'search',placeholder:'제목·저자·태그 검색','aria-label':'작업 패널 검색'});
  search.addEventListener('input',()=>{state.query=search.value;render();});
  const scope=node('select',null,controls,{'aria-label':'표시 범위'});node('option','라이브러리',scope,{value:'library'});node('option','선택한 문헌',scope,{value:'selected'});node('option','현재 컬렉션',scope,{value:'collection'});node('option','현재 컬렉션과 하위 컬렉션',scope,{value:'collection-recursive'});
  scope.addEventListener('change',()=>{state.scope=scope.value;state.annotationIDs.clear();run(load);});
  const type=node('select',null,controls,{'aria-label':'문헌 유형 필터'});node('option','모든 유형',type,{value:''});
  type.addEventListener('change',()=>{state.type=type.value;render();});
  button('현재 선택 가져오기',()=>{state.selected=new Set(runtime.selected(win).map(i=>String(i.id)));render();},controls);
  button('새로고침',load,controls);
  const filterPanel=node('details',null,panel,{class:'sc-filters'}),filterSummary=node('summary','상세 필터',filterPanel);
  const filters=node('div',null,filterPanel,{class:'sc-filter-fields','aria-label':'문헌 상세 필터'});
  const filterChips=node('div',null,panel,{class:'sc-filter-chips','aria-label':'적용 중인 필터'});
  const filterInputs=new Map();
  function selectFilter(key,label,choices){const input=node('select',null,filters,{'aria-label':label});for(const[value,title]of choices)node('option',title,input,{value});input.value=state[key];input.addEventListener('change',()=>{state[key]=input.value;render();});filterInputs.set(key,input);}
  selectFilter('status','읽기 상태 필터',[['','모든 읽기 상태'],['unread','안 읽음'],['reading','읽는 중'],['done','완료']]);
  selectFilter('ratingMin','최소 별점',[['','모든 별점'],...Array.from({length:5},(_,i)=>[String(i+1),`${i+1}점 이상`])]);
  for(const[key,label]of [['yearFrom','시작 연도'],['yearTo','마지막 연도']]){const input=node('input',null,filters,{type:'number',min:1,max:9999,placeholder:label,'aria-label':label});input.addEventListener('input',()=>{state[key]=input.value;render();});filterInputs.set(key,input);}
  selectFilter('sort','문헌 정렬',[['library','기본 순서'],['title','제목순'],['year-desc','최신 발행순'],['citations-desc','인용 많은 순'],['rating-desc','별점 높은 순'],['time-desc','읽기 시간순']]);
  button('필터 초기화',()=>{for(const key of ['status','ratingMin','yearFrom','yearTo']){state[key]='';filterInputs.get(key).value='';}state.query=search.value='';state.type=type.value='';state.tag='';state.sort='library';filterInputs.get('sort').value='library';render();},filters);
  const shell=node('div',null,panel,{class:'sc-shell'}),nav=node('nav',null,shell,{'aria-label':'작업 종류'}),content=node('div',null,shell,{class:'sc-content'});
  const context=node('div',null,content,{class:'sc-context'}),sectionTitle=node('h2','보유 문헌',context,{class:'sc-section-title'}),contextDetail=node('span',null,context,{class:'sc-context-detail'});
  const body=node('div',null,content,{class:'sc-body',tabindex:'-1'});
  const navButtons=new Map();
  async function navigate(id,{focus=false}={}){if(!TABS.some(([key])=>key===id)||hiddenTabs().has(id))return;const request=++navigationEpoch;state.tab=id;await render();if(disposed||panel.hidden||request!==navigationEpoch||state.tab!==id)return;await saveUI({lastTab:id});if(focus&&!disposed&&!panel.hidden&&request===navigationEpoch&&state.tab===id&&commands.hidden)body.focus?.();}
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
  for(const [label,ids]of GROUPS){const group=node('div',null,nav,{class:'sc-nav-group'});node('div',label,group,{class:'sc-nav-heading'});for(const id of ids){const label=TABS.find(([key])=>key===id)[1];navButtons.set(id,leadIcon(button(label,()=>navigate(id),group,{'data-tab':id}),id));}}
  const footer=node('footer',null,panel,{class:'sc-selection-bar'});const selectionLabel=node('span','선택한 문헌 없음',footer,{class:'sc-selection-label'});
  const clearSelection=button('선택 해제',()=>{state.selected.clear();state.annotationIDs.clear();render();},footer);
  const relatedAction=button('관련 문헌으로 연결',async()=>{await library.relate([...state.selected]);await load();message('관련 문헌 연결을 저장했습니다.');},footer);
  const unlinkAction=button('선택 문헌끼리 연결 해제',async()=>{const changed=await library.unrelate([...state.selected]);await load();message(`${changed}개 문헌의 상호 연결을 해제했습니다.`);},footer);
  const commands=node('div',null,panel,{class:'sc-command-palette',role:'dialog','aria-modal':'true','aria-label':'기능 바로 찾기'});commands.hidden=true;
  const commandSearch=node('input',null,commands,{type:'search',class:'sc-command-search',placeholder:'예: 주석, 비교, 탭…',role:'combobox','aria-expanded':'false','aria-autocomplete':'list','aria-label':'찾을 기능 이름','aria-controls':'sc-command-results'});
  const commandResults=node('div',null,commands,{id:'sc-command-results',class:'sc-command-results',role:'listbox','aria-label':'검색된 기능'});
  node('p','↑↓ 이동 · Enter 열기 · Esc 닫기',commands,{class:'sc-muted'});
  function drawCommands(){
   const query=commandSearch.value.trim().toLocaleLowerCase();commandMatches=TABS.filter(([id,label])=>!hiddenTabs().has(id)&&(!query||(label+' '+id).toLocaleLowerCase().includes(query)));
   commandIndex=Math.max(0,Math.min(commandIndex,commandMatches.length-1));commandResults.replaceChildren();
   if(!commandMatches.length){node('p','일치하는 기능이 없습니다.',commandResults);commandSearch.removeAttribute('aria-activedescendant');return;}
   commandMatches.forEach(([id,label],index)=>{const option=button(label,()=>{closeCommands(false);return navigate(id,{focus:true});},commandResults,{class:'sc-command-option',id:'sc-command-'+id,role:'option','aria-selected':String(index===commandIndex),tabindex:-1});});
   commandSearch.setAttribute('aria-activedescendant','sc-command-'+commandMatches[commandIndex][0]);
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
   toolbar.setAttribute('tooltiptext','Style Custom 연구 작업 패널');toolbar.setAttribute('label','워크벤치');toolbar.setAttribute('tooltiptext','Style Custom 연구 작업 패널');toolbar.addEventListener('command',()=>run(()=>toggle()));toolbar.addEventListener('click',()=>{if(!doc.createXULElement)run(()=>toggle());});
   placeInToolbar(target,toolbar);}
  const selected=()=>state.items.filter(i=>state.selected.has(String(i.id)));
  function bindAI(itemID){if(state.aiItemID!==itemID){aiEpoch++;state.aiItemID=itemID;state.aiTask=null;state.aiOutput=null;}}
  const scoped=()=>state.scope==='selected'?selected():state.scope.startsWith('collection')?state.items.filter(i=>(state.collectionIDs||[]).includes(String(i.id))):state.items;
  const rows=()=>model.sortItems(model.filter(scoped(),{query:state.query,type:state.type,tag:state.tag,status:state.status,ratingMin:state.ratingMin,yearFrom:state.yearFrom,yearTo:state.yearTo}),state.sort);
  const parentOptions=()=>({type:state.type,tag:state.tag,status:state.status,ratingMin:state.ratingMin,yearFrom:state.yearFrom,yearTo:state.yearTo});
  const ids=()=>Object.values(parentOptions()).some(Boolean)?model.filter(scoped(),parentOptions()).map(item=>String(item.id)):state.scope==='selected'?[...state.selected]:state.scope.startsWith('collection')?[...(state.collectionIDs||[])]:undefined;
  function updateSelectionUI(){
   const count=state.selected.size;footer.dataset.selected=String(count>0);const visible=new Set((['notes','annotations','attachments'].includes(state.tab)?model.filter(scoped(),parentOptions()):rows()).map(item=>String(item.id))),outside=[...state.selected].filter(id=>!visible.has(String(id))).length;
   selectionLabel.textContent=count?`${count}개 문헌 선택${outside?' · 현재 결과 밖 '+outside+'개 포함':''}`:'문헌을 선택하면 함께 비교하거나 연결할 수 있습니다.';
   selectionLabel.title=selected().slice(0,5).map(item=>item.title).join('\n');
   clearSelection.disabled=!count||clearSelection.dataset.busy==='true';relatedAction.disabled=count<2||relatedAction.dataset.busy==='true';unlinkAction.disabled=count<2||unlinkAction.dataset.busy==='true';
   for(const card of body.querySelectorAll('[data-item-id]'))card.dataset.selected=String(state.selected.has(card.dataset.itemId));
  }
  function updateChrome(){
   sectionTitle.textContent=TABS.find(([id])=>id===state.tab)?.[1]||'';
   const applicable=FILTER_TABS.has(state.tab)&&state.tab!=='collections';controls.hidden=!applicable;filterPanel.hidden=!applicable;
   contextDetail.textContent=applicable?`${({library:'라이브러리',selected:'선택한 문헌',collection:'현재 컬렉션','collection-recursive':'현재·하위 컬렉션'})[state.scope]} · ${(['notes','annotations','attachments'].includes(state.tab)?model.filter(scoped(),parentOptions()):rows()).length}개 문헌${['notes','annotations','attachments'].includes(state.tab)?' 범위 · 내용 검색':''}`:'선택한 문헌 '+state.selected.size+'개';
   filterChips.replaceChildren();const labels={query:'검색',type:'유형',tag:'태그',status:'상태',ratingMin:'최소 별점',yearFrom:'시작 연도',yearTo:'마지막 연도'};
   for(const[key,label]of Object.entries(labels))if(state[key]){const value=key==='status'?({unread:'안 읽음',reading:'읽는 중',done:'완료'})[state[key]]:state[key];button(`${label}: ${value} ×`,()=>{state[key]='';if(key==='query')search.value='';else if(key==='type')type.value='';else if(filterInputs.has(key))filterInputs.get(key).value='';return render();},filterChips,{'aria-label':label+' 필터 해제'});}
   const count=Object.keys(labels).filter(key=>state[key]).length;filterSummary.textContent='상세 필터'+(count?' · '+count+'개 적용':'');filterChips.hidden=!applicable||!count;
   for(const group of nav.querySelectorAll('.sc-nav-group'))group.hidden=[...group.querySelectorAll('[data-tab]')].every(button=>button.hidden);
   updateSelectionUI();
  }
  function check(label,checked,fn,parent){const wrap=node('label',null,parent,{class:'sc-check'});const input=node('input',null,wrap,{type:'checkbox','aria-label':label});input.checked=checked;input.addEventListener('change',()=>fn(input.checked));node('span',label,wrap);return input;}
  function selectItem(id,on){state.annotationIDs.clear();on?state.selected.add(String(id)):state.selected.delete(String(id));updateSelectionUI();}
  function one(){const list=selected();if(list.length!==1)throw new Error('문헌을 하나 선택하세요.');return list[0];}
  async function discardPreview(p){if(!p)return;try{await p.discard?.();}catch(error){runtime.Z.logError?.(error);}finally{p.remove();if(preview===p)preview=null;}}
  function rememberDraft(event){const input=event.target;if(input?.dataset?.draftKey&&input.localName!=='select'&&!['checkbox','password'].includes(input.type))updateDraft(input.dataset.draftKey,input.value);}
  body.addEventListener('input',rememberDraft);body.addEventListener('change',rememberDraft);
  function finishDraft(input,submitted,clearValue=false){
   const key=input.dataset.draftKey;
   const latest=cachedDrafts().get(key)??drafts.get(key)??input.value;
   // The editor may have changed, or been replaced by a notifier redraw, while saving.
   if(latest!==submitted)return;
   updateDraft(key,undefined);if(clearValue)input.value='';
  }
  function restoreDrafts(){for(const input of body.querySelectorAll('[data-draft-key]'))if(drafts.has(input.dataset.draftKey))input.value=drafts.get(input.dataset.draftKey);}
  function clear(){previewEpoch++;const previous=preview;preview=null;if(previous){previous.remove();void discardPreview(previous);}body.replaceChildren();visibleAnnotationIDs.clear();}

  function empty(text){node('p',text,body,{class:'sc-empty'});}
  function bar(parent=body){return node('div',null,parent,{class:'sc-actions'});}
  // The headline and its detail go in their own block so that everything a
  // caller appends afterwards -- buttons, checkboxes, selects -- lands in one
  // row beside them instead of stacking into a ninety-pixel card.
  function card(title,subtitle,parent=body){
   const c=node('article',null,parent,{class:'sc-card'});
   const text=node('div',null,c,{class:'sc-card-text'});
   node('h3',title||'제목 없음',text);
   if(subtitle)node('p',subtitle,text,{class:'sc-muted'});
   return c;
  }
  function copy(value){runtime.Z.Utilities.Internal.copyTextToClipboard(value);message('클립보드에 복사했습니다.');}
  const scopeContext=()=>JSON.stringify([win.ZoteroPane?.getSelectedLibraryID?.()||runtime.Z.Libraries.userLibraryID,state.scope,state.scope.startsWith('collection')?(win.ZoteroPane?.getSelectedCollection?.()?.id??null):null]);
  async function load(){const token=++loadEpoch,context=scopeContext();if(observedContext!==context){state.collectionIDs=[];epoch++;clear();}observedContext=context;message('문헌을 읽는 중…');const libraryID=win.ZoteroPane?.getSelectedLibraryID?.()||runtime.Z.Libraries.userLibraryID;
   if(state.libraryID!==libraryID){state.libraryID=libraryID;state.items=[];state.annotationIDs.clear();bindAI(null);}
   const snapshot=await library.snapshot(libraryID);if(disposed||token!==loadEpoch||panel.hidden)return;if(context!==scopeContext())return load();
   if(state.scope.startsWith('collection')){state.collectionIDs=[];const collection=win.ZoteroPane?.getSelectedCollection?.();if(collection){const members=await library.collectionItems(collection.id,{libraryID,recursive:state.scope==='collection-recursive'});if(disposed||token!==loadEpoch||panel.hidden)return;if(context!==scopeContext())return load();state.collectionIDs=members;}}
   state.items=snapshot.map(i=>{const ref=runtime.Z.Items.get(Number(i.id));return {...i,...(ref?runtime.state(ref):{})};});
   const existing=new Set(state.items.map(i=>i.id));state.selected=new Set([...state.selected].filter(id=>existing.has(id)));
   type.replaceChildren();node('option','모든 유형',type,{value:''});for(const t of [...new Set(state.items.map(i=>i.itemType))].filter(Boolean).sort())node('option',t,type,{value:t});type.value=state.type;
   message(state.items.length+'개 문헌');await render();
  }
  async function toggle(show){const wasHidden=panel.hidden,open=show===undefined?wasHidden:!!show;if(open&&wasHidden)returnFocus=doc.activeElement;panel.hidden=!open;if(open){state.selected=new Set(runtime.selected(win).map(i=>String(i.id)));await load();if(!disposed&&!panel.hidden)(controls.hidden?body:search).focus?.();}else{navigationEpoch++;closeCommands(false);epoch++;loadEpoch++;aiEpoch++;clear();if(returnFocus?.isConnected&&!win.closed)returnFocus.focus?.();returnFocus=null;}}
  async function paperList(items){if(!items.length){empty('조건에 맞는 문헌이 없습니다. 검색어나 필터를 지우세요. 새 논문을 찾으려면 ZotPoP 논문 검색을 사용하세요.');return;}
   const pageSize=setting('explorePageSize',100),key=JSON.stringify([state.tab,state.scope,items.map(i=>i.id)]);
   if(state.pageKey!==key){state.pageKey=key;state.pageIndex=0;}
   state.pageIndex=Math.max(0,Math.min(state.pageIndex||0,Math.ceil(items.length/pageSize)-1));
   const start=state.pageIndex*pageSize,page=items.slice(start,start+pageSize),paging=bar();
   node('span',`${start+1}–${start+page.length} / ${items.length}개`,paging,{role:'status','aria-label':'문헌 페이지 범위'});
   button('이전 페이지',()=>{state.pageIndex--;render();},paging).disabled=state.pageIndex===0;
   button('다음 페이지',()=>{state.pageIndex++;render();},paging).disabled=start+pageSize>=items.length;
   const choose=(values,on)=>{state.annotationIDs.clear();for(const item of values)on?state.selected.add(String(item.id)):state.selected.delete(String(item.id));render();};
   button('현재 페이지 선택',()=>choose(page,true),paging);button('현재 페이지 선택 해제',()=>choose(page,false),paging);button('검색 결과 전체 선택',()=>choose(items,true),paging);
   const list=node('div',null,body,{class:'sc-paper-list'}),details=[],generation=epoch;for(const item of page){
   const c=node('article',null,list,{class:'sc-card sc-paper-card','data-item-id':item.id,'data-status':['reading','done'].includes(item.status)?item.status:'unread','data-selected':String(state.selected.has(item.id))});
   const heading=node('div',null,c,{class:'sc-paper-heading'}),pick=check('선택',state.selected.has(item.id),on=>selectItem(item.id,on),heading);pick.setAttribute('aria-label',item.title+' 선택');
   // A paper carries whatever colour it has been given; otherwise its reading state.
   const marked=runtime.highlightOf?.(runtime.Z.Items.get(Number(item.id)));
   if(marked)c.dataset.mark=marked;
   const identity=node('div',null,heading,{class:'sc-paper-identity'});
   node('h3',item.title||'제목 없음',identity,{class:'sc-paper-title',title:item.title||''});
   node('span',[item.year,item.venue,item.authors].filter(Boolean).join(' · '),identity,{class:'sc-paper-meta',title:[item.authors,item.venue].filter(Boolean).join(' · ')});
   const metrics=node('div',null,heading,{class:'sc-metrics'});
   metric(metrics,{icon:'impact',name:'impact',text:item.impactFactor??'—',tone:impactTone(item.impactFactor),label:'저널 영향력 지수'});
   metric(metrics,{icon:'citations',name:'citations',text:item.citations??'—',label:'인용 수'});
   const stars=node('span',null,metrics,{class:'sc-metric sc-stars',title:`별점 ${item.rating??0}/5`});stars.dataset.metric='rating';
   node('span','\u2605'.repeat(item.rating??0)+'\u2606'.repeat(5-(item.rating??0)),stars,{class:'sc-metric-value'});
   metric(metrics,{icon:'time',name:'time',text:runtime.formatReadTime?runtime.formatReadTime(item.seconds)||'0s':Math.floor(Number(item.seconds)||0)+'초',label:'읽은 시간'});
   const unusedMetrics=node('p',null,c,{class:'sc-metrics-source',hidden:'hidden'});
   for(const[label,value]of [['','']])node('span',[label,value].filter(value=>value!=='').join(' '),unusedMetrics,{class:'sc-metric','data-metric':label==='읽기'?'time':label===''?'status':label});
   const actions=bar(c);actions.classList.add('sc-paper-actions');button('열기',()=>library.openItem(item.id),actions,{'data-variant':'primary'});button('자세히',()=>{state.selected=new Set([item.id]);state.scope='selected';scope.value='selected';render();},actions);
   unusedMetrics.title=[item.citationSource,item.impactSource].filter(Boolean).join(' · ')||'지표 출처 미확인';
   if(state.scope==='selected'){node('p',item.abstract||'초록이 없습니다.',c);const ref=runtime.Z.Items.get(Number(item.id));const remark=node('textarea',null,c,{'aria-label':'읽기 메모',placeholder:'읽기 메모'});remark.dataset.draftKey=JSON.stringify(['remark',state.libraryID,item.id]);remark.value=runtime.entry(ref).remark||'';button('메모 저장',async()=>{const submitted=remark.value;await library.setRemark(item.id,submitted);finishDraft(remark,submitted);message('메모를 저장했습니다.');},c);}
   if(state.scope==='selected'&&items.length===1)details.push((async()=>{
    const results=await Promise.allSettled([library.notes([item.id]),library.annotations([item.id])]);
    if(disposed||epoch!==generation||!c.isConnected)return;
    for(const [index,result]of results.entries()){
     if(!enabled(index?'renderItemAnnotations':'renderItemNotes'))continue;
     const label=index?'주석':'노트',section=node('details',null,c,{class:'sc-evidence'});node('summary',label+(result.status==='fulfilled'?' · '+result.value.length:' · 확인 필요'),section);
     if(result.status==='rejected'){node('p','불러오지 못했습니다. 새로고침으로 다시 시도하세요.',section);continue;}
     if(result.value.length<=setting('inlineEvidenceCount',5))section.setAttribute('open','');
     if(!result.value.length){node('p',label+'가 없습니다.',section);continue;}
     const evidence=node('div',null,section);let visible=0,more;
     const append=amount=>{for(const value of result.value.slice(visible,visible+amount)){const detail=card(index?`p.${value.pageLabel||((value.pageIndex??0)+1)}`:value.title,null,evidence),text=String(value.text||'');const paragraph=node('p',text.length>setting('maxExcerptLength',1200)?text.slice(0,setting('maxExcerptLength',1200))+'…':text,detail);if(text.length>setting('maxExcerptLength',1200))button('전체 내용 보기',()=>{paragraph.textContent=text;},detail);if(index&&value.comment)node('p',value.comment,detail);button(index?'주석 원문 열기':'문헌 노트 편집',()=>library.openItem(value.id),detail);}visible=Math.min(result.value.length,visible+amount);if(more){more.textContent=label+' 더 보기 · '+(result.value.length-visible)+'개 남음';if(visible>=result.value.length)more.remove();}};
     append(setting('inlineEvidenceCount',5));if(visible<result.value.length)more=button(label+' 더 보기 · '+(result.value.length-visible)+'개 남음',()=>append(20),section);
    }
   })());
  }await Promise.all(details);}
  async function drawRecent(){
   const timestamp=value=>{if(typeof value==='number')return Number.isFinite(value)?value:0;const parsed=Date.parse(value||'');return Number.isFinite(parsed)?parsed:0;};
   const activity=item=>Math.max(timestamp(item.lastRead),timestamp(item.dateModified),timestamp(item.dateAdded));
   const recent=rows().filter(item=>activity(item)>0).sort((a,b)=>activity(b)-activity(a)||String(a.id).localeCompare(String(b.id)));
   node('p','마지막 읽기·수정·추가 시각이 최근인 순서입니다.',body,{class:'sc-muted'});
   await paperList(recent);
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

  function drawGraph(){
   const b=bar();
   for(const[mode,label]of [['citations','인용 관계'],['related','관련 문헌'],['tags','공통 태그'],['authors','공통 저자']])
    button(label,()=>{state.graphMode=mode;render();},b,{'aria-pressed':state.graphMode===mode});
   if(state.graphMode==='citations')return drawCitationGraph(b);
   return drawLegacyGraph(b);
  }

  function drawCitationGraph(b){
   const graphTools=runtime.graphTools,identity=runtime.journalIdentity;
   if(!graphTools||typeof runtime.paperWorks!=='function'){drawLegacyGraph(b);return;}
   const works=runtime.paperWorks();
   const limit=setting('graphNodeLimit',180);
   const chosen=rows().slice(0,limit);
   const papers=chosen.map(paper=>{
    const work=works[paper.libraryID+':'+paper.key]||works[String(paper.id)]||null;
    return {id:String(paper.id),title:paper.title,year:Number(paper.year)||null,
     citations:Number(paper.citations)||0,venue:paper.venue,
     openalex:work&&work.openalex||'',references:work&&Array.isArray(work.references)?work.references:[]};
   });
   const withRefs=papers.filter(paper=>paper.references.length).length;
   button(`인용 목록 가져오기 (${papers.length-withRefs}편 남음)`,()=>run(async()=>{
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
   }),b);
   if(!withRefs){
    empty('아직 인용 목록이 없습니다. “인용 목록 가져오기”를 눌러 OpenAlex에서 참고문헌을 받아오세요.');
    return;
   }
   const W=860,H=540;
   const graph=graphTools.layout(graphTools.build(papers),{width:W,height:H});
   const counted=graph.counted||{direct:0,coupled:0,isolated:0};
   node('p',`이어진 논문 ${graph.nodes.length} · 인용 ${counted.direct}건 · 공통 참고문헌으로 이어진 쌍 ${counted.coupled}`
    +(counted.isolated?` · 연결 없음 ${counted.isolated}`:'')
    +(withRefs<papers.length?` · 인용 목록 없음 ${papers.length-withRefs}`:''),body,{class:'sc-muted'});
   if(!graph.nodes.length){
    empty('이 범위에서는 서로 인용하거나 참고문헌을 공유하는 논문이 없습니다. 범위를 넓혀보세요.');
    return;
   }
   const svg=doc.createElementNS(SVG,'svg');
   svg.setAttribute('viewBox',`0 0 ${W} ${H}`);svg.setAttribute('class','sc-graph');
   svg.setAttribute('aria-label','인용 관계 그래프');body.appendChild(svg);
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
    for(const[k,v]of Object.entries({x1:a.x,y1:a.y,x2:c.x,y2:c.y}))line.setAttribute(k,v);
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
   for(const n of graph.nodes){
    const g=doc.createElementNS(SVG,'g');
    g.setAttribute('transform',`translate(${n.x} ${n.y})`);
    g.setAttribute('tabindex','0');g.setAttribute('role','button');g.setAttribute('aria-label',n.label);
    const id=n.venue?identity.identify(n.venue):null;
    const tone=id?identity.colours(id,{dark:darkScheme()}):null;
    const circle=doc.createElementNS(SVG,'circle');
    const r=graphTools.radiusOf(n.citations);
    circle.setAttribute('r',r);
    circle.setAttribute('fill',tone?tone.fill:'var(--sc-fill)');
    circle.setAttribute('stroke',tone?tone.ink:'var(--sc-muted)');
    circle.setAttribute('stroke-width',state.selected.has(n.id)?2.4:1);
    g.appendChild(circle);
    // A label on every node at this density is a grey smear, so only the papers
    // worth reading first carry one: the most cited and the best connected.
    const label=doc.createElementNS(SVG,'text');
    label.setAttribute('x',r+4);label.setAttribute('y','3.5');
    label.setAttribute('class','sc-graph-label');
    label.textContent=String(n.label).slice(0,38);
    if(!(n.citations>=60||n.degree>=5||state.selected.has(n.id)))label.setAttribute('opacity','0');
    g.appendChild(label);
    const title=doc.createElementNS(SVG,'title');
    title.textContent=`${n.label}\n${[n.venue,n.year,`인용 ${n.citations}`,`참고문헌 ${n.references}`,`연결 ${n.degree}`].filter(Boolean).join(' · ')}`;
    g.appendChild(title);
    const activate=()=>{state.selected=new Set([n.id]);updateSelectionUI();message(n.label);render();};
    g.addEventListener('click',activate);
    g.addEventListener('dblclick',()=>run(()=>library.openItem(n.id)));
    g.addEventListener('keydown',e=>{if(e.key==='Enter')activate();});
    // Hovering brings one paper's neighbourhood forward instead of leaving the
    // reader to trace a line across a thousand of them.
    g.addEventListener('mouseenter',()=>focusNode(n.id));
    g.addEventListener('mouseleave',()=>focusNode(null));
    g.addEventListener('focus',()=>focusNode(n.id));
    g.addEventListener('blur',()=>focusNode(null));
    marks.set(n.id,{g,label,circle,n});
    group.appendChild(g);
   }
   function focusNode(id){
    for(const line of lines){
     const on=!id||line.getAttribute('data-a')===id||line.getAttribute('data-b')===id;
     line.setAttribute('stroke-opacity',on?(line.getAttribute('marker-end')?0.85:0.42):0.05);
    }
    for(const[key,mark]of marks){
     const near=!id||key===id||neighbours.get(id).has(key);
     mark.g.setAttribute('opacity',near?1:0.22);
     if(id&&near)mark.label.setAttribute('opacity','1');
     else if(!id&&!(mark.n.citations>=60||mark.n.degree>=5||state.selected.has(key)))mark.label.setAttribute('opacity','0');
    }
   }
   const zoomBar=bar();let zoom=1;
   button('확대',()=>{zoom=Math.min(3,zoom+.25);svg.setAttribute('viewBox',`0 0 ${W/zoom} ${H/zoom}`);},zoomBar);
   button('축소',()=>{zoom=Math.max(.5,zoom-.25);svg.setAttribute('viewBox',`0 0 ${W/zoom} ${H/zoom}`);},zoomBar);
   node('span','실선 화살표는 실제 인용 · 점선은 공통 참고문헌 · 크기는 피인용 수 · 색은 출판사',zoomBar,{class:'sc-muted'});
   // The one thing a citation map tells you that reading your own shelf cannot.
   if(graph.missing.length){
    node('h3',`내 라이브러리가 자주 인용하지만 갖고 있지 않은 논문 ${graph.missing.length}`,body,{class:'sc-hit-group'});
    const list=node('div',null,body,{class:'sc-hits'});
    for(const row of graph.missing.slice(0,25)){
     const c=node('div',null,list,{class:'sc-hit'});
     node('p',row.id,c,{class:'sc-hit-title'});
     node('p',`내 논문 ${row.citedBy.length}편이 인용합니다`,c,{class:'sc-hit-meta'});
     const actions=node('div',null,c,{class:'sc-hit-actions'});
     button('OpenAlex에서 보기',()=>runtime.Z.launchURL&&runtime.Z.launchURL(`https://openalex.org/${row.id}`),actions);
    }
   }
   // The papers nothing connects to are named rather than drawn: as a ring round
   // the outside they were most of the ink and none of the structure.
   if(graph.isolated&&graph.isolated.length){
    node('h3',`이 범위에서 연결이 없는 논문 ${graph.isolated.length}`,body,{class:'sc-hit-group'});
    const list=node('div',null,body,{class:'sc-hits'});
    for(const n of graph.isolated.slice(0,30)){
     const c=node('div',null,list,{class:'sc-hit'});
     node('p',n.label,c,{class:'sc-hit-title'});
     node('p',[n.venue,n.year,n.references?`참고문헌 ${n.references}건`:'인용 목록 없음'].filter(Boolean).join(' · '),c,{class:'sc-hit-meta'});
     button('열기',()=>library.openItem(n.id),node('div',null,c,{class:'sc-hit-actions'}));
    }
   }
   if(graph.truncated)node('p','연결이 너무 많아 강한 것부터 그렸습니다. 검색으로 범위를 좁히면 전부 보입니다.',body,{class:'sc-muted'});
   if(rows().length>limit)node('p',`그래프는 최대 ${limit}개 문헌을 표시합니다.`,body,{class:'sc-muted'});
  }

  function drawLegacyGraph(b){
   const data=model.layout(library.graph(rows().slice(0,setting('graphNodeLimit',180)),{mode:state.graphMode==='citations'?'related':state.graphMode}),760,480);
   if(!data.nodes.length){empty('문헌을 가져오면 관계 그래프가 나타납니다.');return;}
   const svg=doc.createElementNS(SVG,'svg');svg.setAttribute('viewBox','0 0 760 480');svg.setAttribute('class','sc-graph');svg.setAttribute('aria-label','문헌 관계 그래프');body.appendChild(svg);let zoom=1;
   const group=doc.createElementNS(SVG,'g');svg.appendChild(group);const positions=new Map(data.nodes.map(n=>[n.id,n]));
   for(const e of data.edges){const a=positions.get(String(e.source)),c=positions.get(String(e.target));if(!a||!c)continue;const line=doc.createElementNS(SVG,'line');for(const[k,v]of Object.entries({x1:a.x,y1:a.y,x2:c.x,y2:c.y}))line.setAttribute(k,v);line.setAttribute('stroke','var(--sc-graph-line)');group.appendChild(line);}
   for(const n of data.nodes){const g=doc.createElementNS(SVG,'g');g.setAttribute('transform',`translate(${n.x} ${n.y})`);g.setAttribute('tabindex','0');g.setAttribute('role','button');g.setAttribute('aria-label',n.label);const circle=doc.createElementNS(SVG,'circle');circle.setAttribute('r',state.selected.has(n.id)?8:5);circle.setAttribute('fill',state.selected.has(n.id)?'var(--sc-accent)':'var(--sc-muted)');g.appendChild(circle);const label=doc.createElementNS(SVG,'text');label.setAttribute('x','9');label.setAttribute('y','4');label.setAttribute('class','sc-graph-label');label.textContent=String(n.label).slice(0,34);g.appendChild(label);const activate=()=>{state.selected=new Set([n.id]);updateSelectionUI();message(n.label);};g.addEventListener('click',activate);g.addEventListener('dblclick',()=>run(()=>library.openItem(n.id)));g.addEventListener('keydown',e=>{if(e.key==='Enter')activate();});group.appendChild(g);}
   button('확대',()=>{zoom=Math.min(3,zoom+.25);svg.setAttribute('viewBox',`0 0 ${760/zoom} ${480/zoom}`);},b);button('축소',()=>{zoom=Math.max(.5,zoom-.25);svg.setAttribute('viewBox',`0 0 ${760/zoom} ${480/zoom}`);},b);if(data.truncated||rows().length>setting('graphNodeLimit',180))node('p',`그래프는 최대 ${setting('graphNodeLimit',180)}개 문헌을 표시합니다. 검색으로 범위를 좁히세요.`,body);
  }
  function drawTags(){const b=bar(),value=node('input',null,b,{placeholder:'추가·제거할 정확한 태그 (쉼표로 구분)','aria-label':'추가할 태그'});button('선택 문헌에 태그 추가',async()=>{await library.addTags([...state.selected],value.value.split(',').map(t=>t.trim()).filter(Boolean));await load();},b);button('선택 문헌에서 태그 제거',async()=>{await library.removeTags([...state.selected],value.value.split(',').map(t=>t.trim()).filter(Boolean));await load();},b);button('태그 필터 해제',()=>{state.tag='';render();},b);
   const rename=bar(),from=node('input',null,rename,{'aria-label':'기존 태그 경로',placeholder:'기존 태그 경로'}),to=node('input',null,rename,{'aria-label':'새 태그 경로',placeholder:'새 태그 경로'});let subtree=true;
   check('하위 태그도 변경',true,on=>{subtree=on;},rename);
   button('선택 문헌 태그 이름 변경',async()=>{const result=await library.renameTagBranch([...state.selected],from.value,to.value,{subtree});await load();message(`태그 변경 ${result.updatedItems}개 문헌 · 병합 ${result.mergedTags}개`);},rename);
   const tree=library.tagTree(rows());function branch(nodes,parent){for(const n of nodes){const details=node('details',null,parent);const summary=node('summary',null,details);button(`${n.name} (${n.count})`,()=>{state.tag=n.path;state.tab='explore';render();},summary);if(n.children.length)branch(n.children,details);}}branch(tree,body);if(!tree.length)empty('태그가 없습니다. 문헌을 선택하고 태그를 추가하세요.');
  }
  async function drawNotes(token){const actions=bar(),draft=node('textarea',null,body,{'aria-label':'새 노트 내용',placeholder:'선택한 문헌에 새 노트 작성'});button('새 노트 저장',async()=>{const submitted=draft.value,parent=one().id,libraryID=state.libraryID;const id=await library.createNote(parent,submitted);finishDraft(draft,submitted,true);state.lastSavedNote={id,parent,libraryID};await render();message('노트를 저장했습니다. 필요하면 저장한 노트를 열어 편집하세요.');},actions,{'data-variant':'primary','data-action-key':'create-note:'+state.libraryID+':'+[...state.selected].sort().join(',')});
   if(state.lastSavedNote?.libraryID===state.libraryID&&state.selected.has(state.lastSavedNote.parent)){const id=state.lastSavedNote.id;button('저장한 노트 열기',()=>library.openItem(id),actions);}
   const notes=await library.notes(ids());if(token!==epoch||disposed)return;const matching=notes.filter(n=>!state.query||(n.title+' '+n.text).toLowerCase().includes(state.query.toLowerCase()));for(const n of matching){const c=card(n.title,n.modified);node('p',n.text.slice(0,1200),c);button('노트 편집',()=>library.openItem(n.id),c);button('내용 복사',()=>copy(n.text),c);}if(!matching.length)empty(state.query?'검색에 맞는 노트가 없습니다. 검색어를 바꿔 보세요.':'이 범위에 노트가 없습니다. 문헌을 선택해 새 노트를 작성하세요.');}
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
   const tools=bar();
   const color=node('input',null,tools,{placeholder:'#ffd400 또는 비워두면 전체','aria-label':'주석 색상 필터'});
   color.value=state.color;
   button('색상 적용',()=>{state.color=color.value.trim();render();},tools);
   const colorEdit=node('input',null,tools,{type:'color',value:'#ffd400','aria-label':'선택 주석 새 색상'});
   button('선택 주석 색 바꾸기',async()=>{
    const chosen=[...state.annotationIDs].filter(id=>visibleAnnotationIDs.has(id));
    if(!chosen.length)throw new Error('현재 범위의 주석을 선택하세요.');
    const count=await library.recolorAnnotations(chosen,colorEdit.value);
    await render();message(`${count}개 주석의 색상을 변경했습니다.`);
   },tools);
   button('선택 주석을 노트로',async()=>{
    const chosen=[...state.annotationIDs].filter(id=>visibleAnnotationIDs.has(id));
    if(!chosen.length)throw new Error('현재 범위의 주석을 선택하세요.');
    const id=await library.noteFromAnnotations(chosen);
    await library.openItem(id);message('출처 링크가 포함된 노트를 만들었습니다.');
   },tools);
   button('선택 주석 병합',async()=>{
    const chosen=[...state.annotationIDs].filter(id=>visibleAnnotationIDs.has(id));
    const mark=epoch;
    const id=await library.mergeAnnotations(chosen,{isCurrent:()=>!disposed&&!panel.hidden&&epoch===mark});
    state.annotationIDs=new Set([String(id)]);
    await render();message('주석을 병합했습니다. 나머지 주석은 휴지통에서 복원할 수 있습니다.');
   },tools);

   const list=await library.annotations(ids());
   if(token!==epoch||disposed)return;
   const filtered=list.filter(a=>
    (!setting('annotationIgnoreFigures',false)||!/^(?:figure|fig\.?|table|그림|표)\s*\d/i.test((a.text||'').trim()))
    &&(!state.color||a.color.toLowerCase()===state.color.toLowerCase())
    &&(!state.query||(a.text+' '+a.comment).toLowerCase().includes(state.query.toLowerCase())));
   state.annotationIDs=new Set([...state.annotationIDs].filter(id=>filtered.some(a=>a.id===id)));

   if(!filtered.length){
    empty('조건에 맞는 주석이 없습니다. PDF에서 하이라이트나 메모를 추가하세요.');
    return;
   }

   // A short memo on the paper itself, saved as you type. Writing one used to
   // mean making a whole note item; this is the scrap-of-paper version.
   const chosenPapers=selected();
   if(chosenPapers.length===1)drawPaperMemo(chosenPapers[0]);

   const counts=new Map();
   for(const a of filtered)counts.set(a.color||'',(counts.get(a.color||'')||0)+1);
   const summary=bar();
   node('span',`주석 ${filtered.length}개`,summary,{class:'sc-muted'});
   for(const [hex,n] of [...counts].sort((a,b)=>b[1]-a[1])){
    const chip=node('button',null,summary,{class:'sc-annot-swatch',type:'button',
     title:`${hex||'색 없음'} · ${n}개 · 눌러서 이 색만 보기`});
    node('span',null,chip,{class:'sc-annot-dot',style:`background:${/^#[0-9a-f]{6}$/i.test(hex)?hex:'var(--sc-faint)'}`});
    node('span',String(n),chip);
    chip.addEventListener('click',()=>{state.color=state.color===hex?'':hex;render();});
   }
   button('보이는 주석 전체 선택',()=>{state.annotationIDs=new Set(visibleAnnotationIDs);render();},summary);
   if(state.annotationIDs.size)button(`선택 해제 (${state.annotationIDs.size})`,()=>{state.annotationIDs=new Set();render();},summary);

   // Grouped by document and read in page order, which is the order they were
   // made in and the only order that reads as a pass through the paper.
   const byDocument=new Map();
   for(const a of filtered){
    const key=a.attachmentID||'';
    if(!byDocument.has(key))byDocument.set(key,[]);
    byDocument.get(key).push(a);
   }
   const titles=new Map((await library.attachments(ids())).map(a=>[a.id,a.title]));
   if(token!==epoch||disposed)return;

   for(const [attachmentID,group] of byDocument){
    group.sort((a,b)=>(a.pageIndex??1e9)-(b.pageIndex??1e9));
    if(byDocument.size>1)node('h3',`${titles.get(attachmentID)||'첨부파일'} · ${group.length}개`,body,{class:'sc-hit-group'});
    const stack=node('div',null,body,{class:'sc-annots'});
    for(const a of group){
     visibleAnnotationIDs.add(a.id);
     const row=node('article',null,stack,{class:'sc-annot',tabindex:'0','data-selected':String(state.annotationIDs.has(a.id))});
     const head=node('div',null,row,{class:'sc-annot-head'});
     node('span',null,head,{class:'sc-annot-dot',
      style:`background:${/^#[0-9a-f]{6}$/i.test(a.color)?a.color:'var(--sc-faint)'}`});
     node('span',`p.${a.pageLabel||((a.pageIndex??0)+1)}`,head,{class:'sc-annot-page'});
     node('span',a.type,head,{class:'sc-annot-kind'});
     const actions=node('div',null,head,{class:'sc-annot-actions'});
     button('원문',()=>library.openItem(a.id),actions);
     button('참조 노트',async()=>{
      const mark=epoch,links=await library.backlinks(a.id);
      if(disposed||mark!==epoch||!row.isConnected)return;
      let box=row.querySelector('[data-annotation-backlinks]');
      if(!box)box=node('div',null,row,{'data-annotation-backlinks':'true',class:'sc-annot-links'});
      box.replaceChildren();
      const notes=links.filter(link=>link.kind==='note');
      node('span',notes.length?`참조 노트 ${notes.length}개`:'이 주석을 인용한 노트가 없습니다.',box,{class:'sc-muted'});
      for(const note of notes)button(note.title||'제목 없는 노트',()=>library.openItem(note.id),box);
     },actions);
     if(a.text)node('p',a.text,row,{class:'sc-annot-text'});
     // The annotation's own comment is the memo: it travels with the highlight,
     // shows in the reader and syncs, so there is no second place to look.
     const memo=node('textarea',null,row,{class:'sc-annot-memo',rows:'1',
      placeholder:'메모…','aria-label':'이 주석의 메모'});
     memo.value=a.comment||'';
     autoGrow(memo);
     bindMemo(memo,value=>library.setAnnotationComment(a.id,value),`주석 ${a.pageLabel||''}`);
     // Clicking the card selects it; the checkbox that used to do this carried a
     // label longer than most of the annotations.
     row.addEventListener('click',event=>{
      if(event.target.closest('button, textarea, a'))return;
      if(state.annotationIDs.has(a.id))state.annotationIDs.delete(a.id);
      else state.annotationIDs.add(a.id);
      row.dataset.selected=String(state.annotationIDs.has(a.id));
      const clear=body.querySelector('[data-role=annot-clear]');
      if(clear)clear.textContent=`선택 해제 (${state.annotationIDs.size})`;
     });
     row.addEventListener('keydown',event=>{
      if(event.key===' '||event.key==='Enter'){event.preventDefault();row.click();}
     });
    }
   }
   node('p','병합은 같은 PDF·유형·색상에, 같은 페이지 또는 인접한 두 페이지에서만 됩니다. 기존 참조 노트의 링크는 바뀌지 않습니다.',
    body,{class:'sc-muted'});
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
  function bindMemo(field,save,label){
   let timer=null,inFlight=null,last=field.value;
   const commit=async()=>{
    const value=field.value;
    if(value===last)return;
    last=value;
    field.dataset.state='saving';
    try{
     inFlight=save(value);
     await inFlight;
     if(!field.isConnected)return;
     field.dataset.state='saved';
     win.setTimeout(()=>{if(field.dataset.state==='saved')field.dataset.state='';},1400);
    }catch(error){
     if(field.isConnected)field.dataset.state='failed';
     last=null;
     message(`${label} 메모를 저장하지 못했습니다: ${error.message}`,true);
    }
   };
   field.addEventListener('input',()=>{
    field.dataset.state='';
    if(timer)win.clearTimeout(timer);
    timer=win.setTimeout(commit,900);
   });
   // Leaving the field commits at once: waiting out the timer after the panel
   // has closed would lose the edit.
   field.addEventListener('blur',()=>{if(timer)win.clearTimeout(timer);commit();});
   memoFields.push(()=>{if(timer)win.clearTimeout(timer);return commit();});
  }

  function drawPaperMemo(item){
   const box=node('div',null,body,{class:'sc-memo'});
   node('span','이 문헌 메모',box,{class:'sc-memo-label'});
   const field=node('textarea',null,box,{class:'sc-annot-memo sc-paper-memo',rows:'1',
    placeholder:'짧게 적어두세요. 노트 항목은 만들지 않습니다.','aria-label':'이 문헌의 메모'});
   const ref=runtime.Z.Items.get(Number(item.id));
   field.value=(ref&&runtime.entry(ref).remark)||'';
   autoGrow(field);
   bindMemo(field,value=>library.setRemark(item.id,value),item.title||'문헌');
  }

  async function drawBacklinks(token){let item;try{item=one();}catch(_){empty('역링크를 확인할 문헌 하나를 선택하세요.');return;}node('h2',item.title,body);const links=await library.backlinks(item.id);if(token!==epoch||disposed)return;for(const link of links){const c=card(link.title,link.kind==='note'?'이 문헌을 참조한 노트':'관련 문헌');button('열기',()=>library.openItem(link.id),c);}if(!links.length)empty('이 문헌을 가리키는 노트나 관련 문헌이 없습니다.');}
  // What the scan found across the whole library, with somewhere to go. The
  // classifier can name 29 supplementary files, 17 duplicates and 6 papers
  // filed under the wrong item; until this existed, none of that was reachable.
  async function drawFindings(token){
   if(typeof runtime.attachmentFindings!=='function')return false;
   let found=null;
   try{found=await runtime.attachmentFindings(win.ZoteroPane?.getSelectedLibraryID?.());}
   catch(error){runtime.Z.logError?.(error);return false;}
   if(token!==epoch||disposed)return false;
   const total=found.supplementary.length+found.duplicate.length+found.foreign.length+found.missing.length;
   if(!total&&!found.unread)return false;
   const bar0=bar();
   node('span',`보충자료 ${found.supplementary.length} · 중복 ${found.duplicate.length} · 다른 논문 ${found.foreign.length}`
    +` · 보충자료만 ${(found.orphan||[]).length} · 첨부 없음 ${found.missing.length}`,
    bar0,{class:'sc-muted'});
   if(found.unread){
    button(`아직 안 읽은 ${found.unread}개 판별`,()=>run(async()=>{
     const items=await runtime.libraryItems(win.ZoteroPane?.getSelectedLibraryID?.());
     const result=await runtime.scanAttachmentKinds(items,{onProgress:(d,t)=>message(`첨부파일 판별 중 ${d+1}/${t}`)});
     message(`본문 ${result.article} · 보충자료 ${result.supplementary} · 중복 ${result.duplicate} · 다른 논문 ${result.foreign}`);
     await render();
    }),bar0);
   }
   const section=(title,rows,tone,act)=>{
    if(!rows.length)return;
    node('h3',`${title} ${rows.length}`,body,{class:'sc-hit-group'});
    const list=node('div',null,body,{class:'sc-hits'});
    for(const row of rows.slice(0,200)){
     const c=node('div',null,list,{class:'sc-hit'+(tone?' sc-hit-'+tone:'')});
     node('p',row.title||'제목 없음',c,{class:'sc-hit-title'});
     node('p',[row.year,row.file,row.why].filter(Boolean).join(' · '),c,{class:'sc-hit-meta'});
     const actions=node('div',null,c,{class:'sc-hit-actions'});
     if(row.fileID)button('파일 열기',()=>library.openItem(row.fileID),actions);
     button('문헌 보기',()=>library.openItem(row.id),actions);
     if(act)act(row,actions);
    }
   };
   section('보충자료',found.supplementary,'');
   section('같은 파일이 두 번',found.duplicate,'warn',(row,actions)=>{
    button('휴지통으로',()=>run(async()=>{
     const {moved}=await runtime.trashAttachments([row.fileID]);
     message(moved?'중복 첨부를 휴지통으로 보냈습니다. Zotero에서 되돌릴 수 있습니다.':'옮기지 못했습니다.');
     await render();
    }),actions);
   });
   section('다른 논문이 붙어 있음',found.foreign,'alert');
   // A supplement filed as its own bibliography entry. The paper it belongs to
   // is a suggestion the user confirms one at a time, never a bulk action: two
   // papers by one group on one molecule look alike enough that guessing is how
   // a supplement lands on the wrong paper in the first place.
   section('보충자료만 있는 문헌',found.orphan||[],'warn',(row,actions)=>{
    const home=row.home;
    if(home&&home.id){
     button('원논문에 붙이기',()=>run(async()=>{
      const result=await runtime.rehomeSupplement(row.fileID,home.id);
      message(result.moved?`보충자료를 원논문으로 옮겼습니다${result.trashed?' · 빈 항목은 휴지통으로':''}. Zotero에서 되돌릴 수 있습니다.`:'옮길 것이 없었습니다.');
      await render();
     }),actions);
     button('원논문 보기',()=>library.openItem(home.id),actions);
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
   section('첨부파일 없음',found.missing,'');
   return true;
  }

  async function drawAttachments(token){
   // The library-wide findings sit above the per-item list rather than
   // replacing it: the point is to reach them, not to hide the attachments.
   const list=await library.attachments(ids());if(token!==epoch||disposed)return;
   await drawFindings(token);
   if(token!==epoch||disposed)return;
   if(list.length)node('h3','선택한 문헌의 첨부파일',body,{class:'sc-hit-group'});
   const matching=list.filter(a=>!state.query||(a.title+' '+a.contentType).toLowerCase().includes(state.query.toLowerCase()));
   for(const a of matching){const c=card(a.title,a.contentType);button('열기',()=>library.openItem(a.id),c);
    const supported=['application/pdf','application/epub+zip','application/epub','text/html'].includes(a.contentType)||/^(image|audio|video)\//.test(a.contentType||'');
    if(!supported||a.path===null){node('p','이 첨부는 미리보기를 지원하지 않습니다. 열기로 확인하세요.',c,{class:'sc-muted'});continue;}
    button('미리보기',async()=>{
     const generation=++previewEpoch,previous=preview;preview=null;
     const current=()=>!disposed&&!panel.hidden&&token===epoch&&generation===previewEpoch&&c.isConnected;
     await discardPreview(previous);if(!current())return;
     const p=doc.createXULElement?.('attachment-preview');if(!p)throw new Error('Zotero 첨부 미리보기 컴포넌트를 사용할 수 없습니다. 열기를 사용하세요.');
     p.classList.add('sc-native-preview');c.appendChild(p);preview=p;
     try{
      const item=await runtime.Z.Items.getAsync(Number(a.id));if(!current()){await discardPreview(p);return;}
      p.item=item;if(p.isValidType===false)throw new Error('이 첨부는 미리보기를 지원하지 않습니다. 열기로 확인하세요.');if(typeof p.render!=='function')throw new Error('현재 Zotero에서 첨부 미리보기를 지원하지 않습니다.');
      await p.render();if(!current())await discardPreview(p);
     }catch(error){await discardPreview(p);if(current())throw error;}
    },c);
   }
   if(!matching.length)empty(state.query?'검색에 맞는 첨부가 없습니다. 검색어를 바꿔 보세요.':'첨부파일이 없습니다. PDF 또는 스냅샷을 첨부하세요.');
  }
  function refreshReading(){
   if(disposed||panel.hidden||state.tab!=='reading')return;
   const list=body.querySelector('[data-reading-progress]');if(!list)return;list.replaceChildren();
   for(const item of rows()){
    const ref=runtime.Z.Items.get(Number(item.id));if(!ref)continue;
    const p=runtime.pageProgress(ref),entry=runtime.entry(ref);
    const c=card(item.title,(runtime.formatReadTime?runtime.formatReadTime(entry.seconds):Math.floor(entry.seconds||0)+'s')+' · '+(p.total?`${p.visited}/${p.total} 페이지 · ${p.percent}%`:'아직 페이지 기록 없음'),list);
    const rangeSize=100,total=Math.max(0,Number(p.total)||0);let start=pageRanges.get(item.id)||0;
    if(start>=total)start=0;pageRanges.set(item.id,start);
    if(total>rangeSize){const range=node('select',null,c,{'aria-label':item.title+' 페이지 범위'});
     for(let offset=0;offset<total;offset+=rangeSize)node('option',`${offset+1}–${Math.min(total,offset+rangeSize)}`,range,{value:offset});
     range.value=String(start);range.addEventListener('change',()=>{pageRanges.set(item.id,Number(range.value));refreshReading();});
    }
    const cells=node('div',null,c,{class:'sc-page-strip'});
    for(let n=start;n<Math.min(total,start+rangeSize);n++){
     const sec=Number(p.pages[n])||0;const btn=button(String(n+1),()=>{if(!p.attachmentID)throw new Error('기록된 첨부파일 정보를 찾지 못했습니다.');return library.openItem(p.attachmentID,{pageIndex:n});},cells,{'aria-label':`${n+1}페이지, ${Math.round(sec)}초`});
     btn.disabled=!p.attachmentID;btn.style.background=sec?`rgba(36,92,120,${Math.min(.60,.15+Math.log1p(sec)/8)})`:'#edf1f4';btn.title=`${n+1}페이지 · ${Math.round(sec)}초`;
    }
   }
  }
  function drawReading(){const b=bar();for(const theme of ['light','dark','sepia'])button(({light:'밝은 PDF',dark:'어두운 PDF',sepia:'세피아 PDF'})[theme],()=>reader.applyTheme(win,theme),b);
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
   node('div',null,body,{'data-reading-progress':'true'});refreshReading();
  }
  function drawTabs(){
   const b=bar();check('세로 탭 목록 표시',!!runtime.cache.readerSettings?.verticalTabs,on=>run(()=>reader.setVerticalTabs(win,on)),b);
   const name=node('input',null,b,{placeholder:'탭 그룹 이름','aria-label':'탭 그룹 이름'});button('열린 탭 저장',async()=>{await reader.saveTabGroup(win,name.value);render();},b);
   const tabs=reader.tabs(win);
   for(const [index,tab]of tabs.entries()){
    const c=card(tab.title,tab.selected?'현재 탭':'');button('이동',()=>reader.selectTab(win,tab.id),c);
    if(tab.itemID){button('닫기',async()=>{await reader.closeTab(win,tab.id);render();},c);
     button('탭 앞으로',()=>{reader.moveTab(win,tab.id,index-1);render();},c).disabled=index<=1;
     button('탭 뒤로',()=>{reader.moveTab(win,tab.id,index+1);render();},c).disabled=index>=tabs.length-1;
     button('이 탭 외 문서 탭 닫기',()=>{const result=reader.closeOtherTabs(win,tab.id);render();message(`${result.closed}개 문서 탭을 닫았습니다.`);},c);
    }
   }
   node('h2','저장된 탭 그룹',body);
   for(const group of reader.tabGroups()){
    const c=card(group.name,group.tabs.length+'개 탭'),title=node('input',null,c,{'aria-label':'저장된 탭 그룹 이름'});title.value=group.name;title.dataset.draftKey=JSON.stringify(['tab-group-name',group.id]);
    button('복원',async()=>{const result=await reader.restoreTabGroup(win,group.id);await render();message(`복원 ${result.opened} · 찾지 못함 ${result.missing}`);},c);
    button('탭 그룹 이름 변경',async()=>{const submitted=title.value;await reader.renameTabGroup(group.id,submitted);finishDraft(title,submitted);render();},c);
    button('현재 탭으로 그룹 갱신',async()=>{await reader.updateTabGroup(win,group.id);render();},c);
    button('그룹 삭제',async()=>{await reader.deleteTabGroup(group.id);render();},c);
   }
  }
  function drawViews(){
   const b=bar(),name=node('input',null,b,{placeholder:'현재 열 배치 이름','aria-label':'뷰 그룹 이름'});button('현재 뷰 저장',async()=>{await reader.saveView(win,name.value);render();},b);
   for(const view of reader.viewGroups()){
    const c=card(view.name,view.columns.length+'개 열 설정'),title=node('input',null,c,{'aria-label':'저장된 뷰 그룹 이름'});title.value=view.name;title.dataset.draftKey=JSON.stringify(['view-group-name',view.id]);
    button('적용',()=>reader.applyView(win,view.id),c);
    button('뷰 그룹 이름 변경',async()=>{const submitted=title.value;await reader.renameView(view.id,submitted);finishDraft(title,submitted);render();},c);
    button('현재 열 배치로 뷰 갱신',async()=>{await reader.updateView(win,view.id);render();},c);
    button('삭제',async()=>{await reader.deleteView(view.id);render();},c);
   }
   if(!reader.viewGroups().length)empty('열 표시·순서·너비·정렬을 조절한 뒤 현재 뷰를 저장하세요.');
  }
  function drawCanvas(){const b=bar(),name=node('input',null,b,{placeholder:'새 보드 이름','aria-label':'보드 이름'});button('보드 만들기',async()=>{const board=model.createBoard(runtime.cache,name.value);state.boardID=board.id;runtime.dirty=true;await runtime.flush();render();},b);const select=node('select',null,b,{'aria-label':'캔버스 선택'});node('option','보드 선택',select,{value:''});for(const board of runtime.cache.boards||[])node('option',board.name,select,{value:board.id});select.value=state.boardID||'';select.addEventListener('change',()=>{state.boardID=select.value;state.cardIDs.clear();render();});const board=(runtime.cache.boards||[]).find(b=>b.id===state.boardID);
   button('보드 삭제',async()=>{if(!board)throw new Error('삭제할 보드를 선택하세요.');deletedCardSelections.set(board.id,[...state.cardIDs]);model.deleteBoard(runtime.cache,board.id);state.boardID=null;state.cardIDs.clear();runtime.dirty=true;await runtime.flush();render();},b);
   button('삭제 취소',async()=>{const restored=model.restoreBoard(runtime.cache);if(!restored)throw new Error('복원할 보드가 없습니다.');state.boardID=restored.id;state.cardIDs=new Set((deletedCardSelections.get(restored.id)||[]).filter(id=>restored.nodes.some(n=>n.id===id)));runtime.dirty=true;await runtime.flush();render();},b);
   if(!board){empty('보드를 만들고 선택한 문헌을 카드로 추가하세요.');return;}
   const save=async()=>{runtime.dirty=true;await runtime.flush();render();};button('선택 문헌 추가',async()=>{model.addToBoard(runtime.cache,board,selected());await save();},b);button('메모 카드 추가',async()=>{model.addBoardNote(runtime.cache,board,'새 메모');await save();},b);button('카드 연결',async()=>{const ids=[...state.cardIDs];if(ids.length!==2)throw new Error('두 카드를 선택하세요.');model.linkCards(board,...ids);await save();},b);button('선택 카드 삭제',async()=>{for(const id of state.cardIDs)model.removeCard(board,id);state.cardIDs.clear();await save();},b);
   const boardName=node('input',null,b,{'aria-label':'현재 보드 이름'});boardName.value=board.name;boardName.dataset.draftKey=JSON.stringify(['board-name',board.id]);
   button('보드 이름 변경',async()=>{const submitted=boardName.value;model.renameBoard(board,submitted);runtime.dirty=true;await runtime.flush();finishDraft(boardName,submitted);render();},b);
   button('카드 연결 해제',async()=>{const ids=[...state.cardIDs];if(ids.length!==2)throw new Error('연결을 해제할 두 카드를 선택하세요.');model.unlinkCards(board,...ids);await save();},b);
   const canvas=node('div',null,body,{class:'sc-canvas'});const svg=doc.createElementNS(SVG,'svg');svg.setAttribute('class','sc-canvas-lines');svg.setAttribute('width',String(Math.max(2000,...board.nodes.map(n=>n.x+300))));svg.setAttribute('height',String(Math.max(2000,...board.nodes.map(n=>n.y+300))));canvas.appendChild(svg);for(const e of board.edges){const a=board.nodes.find(n=>n.id===e.source),z=board.nodes.find(n=>n.id===e.target);if(!a||!z)continue;const line=doc.createElementNS(SVG,'line');for(const[k,v]of Object.entries({x1:a.x+90,y1:a.y+40,x2:z.x+90,y2:z.y+40,stroke:'#8196a4'}))line.setAttribute(k,v);svg.appendChild(line);}
   for(const n of board.nodes){const c=card(n.label,null,canvas);c.classList.add('sc-canvas-card');c.style.left=n.x+'px';c.style.top=n.y+'px';c.style.background=/^#[0-9a-f]{6}$/i.test(n.color)?n.color:'#ffffff';check('카드 선택',state.cardIDs.has(n.id),on=>on?state.cardIDs.add(n.id):state.cardIDs.delete(n.id),c);const memo=node('textarea',null,c,{'aria-label':'카드 메모'});memo.dataset.draftKey=JSON.stringify(['board-note',board.id,n.id]);memo.value=n.note;memo.addEventListener('change',()=>run(async()=>{n.note=memo.value.slice(0,50000);runtime.dirty=true;await runtime.flush();}));if(n.itemID)button('문헌 열기',()=>library.openItem(n.itemID),c);
    const editor=node('details',null,c);node('summary','카드 편집',editor);
    const title=node('input',null,editor,{'aria-label':'카드 제목'});title.value=n.label;title.dataset.draftKey=JSON.stringify(['board-label',board.id,n.id]);
    const color=node('input',null,editor,{type:'color','aria-label':'카드 색상'});color.value=n.color;color.dataset.draftKey=JSON.stringify(['board-color',board.id,n.id]);
    button('카드 모양 저장',async()=>{const label=title.value,hex=color.value;model.updateCard(board,n.id,{label,color:hex});runtime.dirty=true;await runtime.flush();finishDraft(title,label);finishDraft(color,hex);render();},editor);
    const handle=c.querySelector('h3');handle.setAttribute('tabindex','0');handle.title='드래그하거나 방향키로 이동';handle.addEventListener('keydown',e=>{const move={ArrowLeft:[-10,0],ArrowRight:[10,0],ArrowUp:[0,-10],ArrowDown:[0,10]}[e.key];if(move){e.preventDefault();model.moveCard(board,n.id,n.x+move[0],n.y+move[1]);run(save);}});
    handle.addEventListener('pointerdown',e=>{const start={x:e.clientX,y:e.clientY,left:n.x,top:n.y};handle.setPointerCapture?.(e.pointerId);const move=ev=>{model.moveCard(board,n.id,start.left+ev.clientX-start.x,start.top+ev.clientY-start.y);c.style.left=n.x+'px';c.style.top=n.y+'px';};const up=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',up);run(save);};handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',up,{once:true});});
   }
  }
  function drawMatrix(){
   const available=[['title','제목'],['authors','저자'],['year','발행연도'],['venue','저널'],['doi','DOI'],['citations','인용 수'],['impactFactor','IF'],['status','읽기 상태'],['rating','별점'],['seconds','읽기 시간(초)'],['tags','태그'],['abstract','초록'],['remark','읽기 메모'],['summary','AI 요약']];
   const defaults=['title','authors','year','venue','doi','citations','impactFactor'];
   const saved=runtime.cache.matrixFields;
   const fields=Array.isArray(saved)?[...new Set(saved.filter(field=>available.some(([key])=>field===key)))]:defaults;
   if(!fields.length)fields.push(...defaults);
   const b=bar();button('행·열 전환',()=>{state.transpose=!state.transpose;render();},b);
   const options=node('details',null,body);node('summary','비교 항목 선택',options);
   for(const[key,label]of available)check('비교 항목: '+label,fields.includes(key),on=>run(async()=>{
    const latest=Array.isArray(runtime.cache.matrixFields)?[...new Set(runtime.cache.matrixFields.filter(field=>available.some(([id])=>id===field)))]:fields;
    const next=on?[...new Set([...latest,key])]:latest.filter(field=>field!==key);
    if(!next.length){render();throw new Error('비교 항목을 하나 이상 남겨 두세요.');}
    runtime.cache.matrixFields=next;runtime.dirty=true;await runtime.flush();render();
   }),options);
   const values=(selected().length?model.sortItems(selected(),state.sort):rows()).map(item=>{
    const ref=runtime.Z.Items.get(Number(item.id)),entry=ref?runtime.entry(ref):{};
    return {...item,tags:(item.tags||[]).join(' · '),remark:entry.remark||'',summary:entry.summary||''};
   });
   const data=model.matrix(values,fields,state.transpose);
   button('CSV 복사',()=>copy(model.csv(data)),b);
   const pageSize=setting('matrixPageSize',50),total=Math.ceil(values.length/pageSize),key=JSON.stringify(values.map(i=>i.id));
   if(state.matrixPageKey!==key){state.matrixPageKey=key;state.matrixPage=0;}
   state.matrixPage=Math.max(0,Math.min(state.matrixPage||0,Math.max(0,total-1)));
   node('span',`전체 ${values.length}개 · ${state.matrixPage+1}/${Math.max(1,total)} 페이지 · CSV는 전체 문헌`,b);
   button('비교 이전 페이지',()=>{state.matrixPage--;render();},b).disabled=state.matrixPage===0;
   button('비교 다음 페이지',()=>{state.matrixPage++;render();},b).disabled=state.matrixPage+1>=total;
   const shown=model.matrix(values.slice(state.matrixPage*pageSize,(state.matrixPage+1)*pageSize),fields,state.transpose);
   const table=node('table',null,body,{class:'sc-matrix'});
   shown.forEach((row,i)=>{const tr=node('tr',null,table);row.forEach((value,j)=>{const heading=state.transpose?j===0:i===0;const cell=node(heading?'th':'td',String(value),tr);if(heading)cell.setAttribute('scope',state.transpose?'row':'col');});});
  }
  async function drawCollections(token){const collections=await library.collections(win.ZoteroPane?.getSelectedLibraryID?.()||runtime.Z.Libraries.userLibraryID);if(token!==epoch||disposed)return;const b=bar();const sort=node('select',null,b,{'aria-label':'컬렉션 정렬'});sort.hidden=!enabled('sortCollectionItem');for(const[v,l]of [['name','이름순'],['count','문헌 많은 순'],['favorite','즐겨찾기 먼저']])node('option',l,sort,{value:v});const list=node('div',null,body);function draw(){list.replaceChildren();const favorites=runtime.cache.favoriteCollections||[];const rows=[...collections].sort((a,b)=>!enabled('sortCollectionItem')?0:sort.value==='count'?b.count-a.count:sort.value==='favorite'?Number(favorites.includes(b.id))-Number(favorites.includes(a.id))||a.name.localeCompare(b.name):a.name.localeCompare(b.name));for(const c of rows){const row=card(c.name,enabled('collectionItemCount')?c.count+'개 문헌':'',list);button('컬렉션 열기',()=>win.ZoteroPane.collectionsView.selectCollection(Number(c.id)),row);if(enabled('favoriteCollections'))check('즐겨찾기',favorites.includes(c.id),on=>run(async()=>{runtime.cache.favoriteCollections=on?[...new Set([...favorites,c.id])]:favorites.filter(id=>id!==c.id);runtime.dirty=true;await runtime.flush();draw();}),row);}}sort.value='name';sort.addEventListener('change',draw);draw();}
  const GROUP_LABELS={citing:'이 논문을 인용한 논문',reference:'이 논문이 인용한 문헌',related:'주제가 가까운 논문'};

  // One dense row per result: what it is, then the actions, which stay out of
  // the way until the row is hovered.
  function hitRow(work,parent){
   const row=node('div',null,parent||null,{class:'sc-hit'});
   node('p',work.title||'제목 없음',row,{class:'sc-hit-title'});
   node('p',[work.year||'연도 미상',work.venue,work.citations==null?null:`인용 ${work.citations}`,work.openAccess?'오픈액세스':null].filter(Boolean).join(' · '),row,{class:'sc-hit-meta'});
   if(work.authors?.length)node('p',work.authors.slice(0,4).join(', ')+(work.authors.length>4?` 외 ${work.authors.length-4}명`:''),row,{class:'sc-hit-authors'});
   if(work.inLibrary){node('span','보유 중',row,{class:'sc-hit-owned'});return row;}
   const actions=node('div',null,row,{class:'sc-hit-actions'});
   if(work.doi)button('추가',()=>run(async()=>{
    message('가져오는 중… ' + (work.title||work.doi).slice(0,50));
    const saved=await runtime.importWork(work,win);
    // The row is now stale: say so in place rather than leaving a dead button.
    // The row is stale once the paper is in: redraw it in place as owned.
    work.inLibrary=true;
    const fresh=hitRow(work,null);row.replaceWith(fresh);
    message(`추가했습니다 — ${saved[0]?.getField('title')||work.doi}`);
   }),actions);
   if(work.doi)button('DOI',()=>copy(work.doi),actions);
   if(work.pdfURL)button('PDF',()=>win.Zotero.launchURL(work.pdfURL),actions);
   return row;
  }

  function hitList(works,parent){
   const list=node('div',null,parent,{class:'sc-hits'});
   for(const work of works)hitRow(work,list);
   return list;
  }

  async function drawRelated(token){
   let item;try{item=one();}catch(_){empty('관련 논문을 찾을 문헌 하나를 선택하세요.');return;}
   node('h2',item.title,body);
   const b=bar();
   const list=node('div',null,body);
   async function find({refresh=false}={}){
    if(refresh)runtime.discoverCache.delete('related:'+runtime.identity(runtime.Z.Items.get(Number(item.id))));
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
     node('h3',`${GROUP_LABELS[group]} ${rows.length}`,list,{class:'sc-hit-group'});
     hitList(rows,list);
    }
   }
   button('다시 찾기',()=>run(()=>find({refresh:true})),b);
   button('저자로 이동',()=>run(async()=>{await navigate('authors');}),b);
   // The tab was asked for; do not make the user ask twice.
   run(()=>find());
  }

  async function drawAuthors(token){
   // The watchlist is drawn first and unconditionally: it is a list of people
   // being followed, and hiding it until a paper happened to be selected made
   // every followed author invisible.
   const watchArea=node('div',null,body);
   const list=node('div',null,body);
   let item=null;
   try{item=one();}catch(_){item=null;}
   async function show(person){
    message(`${person.name}의 최근 작업을 불러오는 중…`);
    const {profile,works,fresh,watching,checkedAt}=await runtime.authorUpdates(person.id);
    if(token!==epoch||disposed||state.tab!=='authors')return;
    list.replaceChildren();
    // The face, the name and the numbers on one line. A person is easier to
    // hold in mind than a row of statistics, which is the whole point of
    // following people rather than papers.
    const head=node('div',null,list,{class:'sc-person'});
    const face=node('div',null,head,{class:'sc-face'});
    node('span',initials(profile?.name||person.name),face,{class:'sc-face-text'});
    const who=node('div',null,head,{class:'sc-person-who'});
    node('h3',profile?.name||person.name,who);
    const stats=node('p',null,who,{class:'sc-profile'});
    for(const [label,value] of [['소속',person.institution||profile?.institutions?.[0]],['h-index',profile?.hIndex],['논문',profile?.works],['총 인용',profile?.citations]]){
     if(value==null||value==='')continue;
     const span=node('span',label+' ',stats);node('b',String(value),span);
    }
    if(profile?.topics?.length){
     const chips=node('div',null,who,{class:'sc-chips'});
     for(const topic of profile.topics)node('span',topic.name+(topic.count?` ${topic.count}`:''),chips,{class:'sc-chip'});
    }
    // A portrait is a nice-to-have on a metered budget, so it is fetched only
    // for the author actually being looked at, and remembered either way.
    paintPortrait(face,{...person,name:profile?.name||person.name,orcid:profile?.orcid});
    const follow=bar(list);
    if(profile?.orcid)button('ORCID 열기',()=>win.Zotero.launchURL(profile.orcid),follow);
    if(watching){
     button('관심 해제',()=>run(async()=>{await runtime.unwatchAuthor(person.id);refreshWatched();await show(person);}),follow);
     if(fresh.length)button(`새 논문 ${fresh.length}편 확인함`,()=>run(async()=>{
      await runtime.markAuthorSeen(person.id,works);
      // The badge on the list is the same news; clearing one must clear both,
      // or the list keeps advertising papers the user has just dismissed.
      await runtime.clearAuthorNews(person.id);
      refreshWatched();
      await show(person);
     }),follow);
    } else {
     // Everything visible now is the baseline, so "new" later means new to the user.
     button('관심 저자로 등록',()=>run(async()=>{
      await runtime.watchAuthor({...person,name:profile?.name||person.name,seen:works.map(w=>w.id)});
      refreshWatched();
      await show(person);
     }),follow);
    }
    if(watching&&fresh.length){
     node('h3',`마지막 확인 이후 새 논문 ${fresh.length}`,list,{class:'sc-hit-group'});
     hitList(fresh,list);
    }
    // The circle of colleagues, out of the works already in hand: no request of
    // its own, and an edge exists because two names are on the same paper.
    const circle=runtime.coauthorsOf?.(person.id,works)||[];
    if(circle.length){
     node('h3',`함께 낸 저자 ${circle.length}`,list,{class:'sc-hit-group'});
     const net=node('div',null,list,{class:'sc-network'});
     const most=circle[0].papers||1;
     for(const mate of circle){
      const chip=node('div',null,net,{class:'sc-node'});
      chip.setAttribute('role','button');chip.tabIndex=0;
      const go=()=>run(()=>show({id:mate.id,name:mate.name,institution:mate.institution}));
      chip.addEventListener('click',go);
      chip.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();go();}});
      // Thickness stands for how often, which is the only quantity here.
      chip.style.setProperty('--sc-tie',String(Math.max(0.18,mate.papers/most)));
      node('span',initials(mate.name),chip,{class:'sc-node-face'});
      const body=node('span',null,chip,{class:'sc-node-body'});
      node('span',mate.name,body,{class:'sc-node-name'});
      node('span',`${mate.papers}편${mate.last?` · ${mate.last}`:''}`,body,{class:'sc-node-meta'});
      chip.title=[mate.name,mate.institution,`공저 ${mate.papers}편`,...(mate.titles||[])].filter(Boolean).join('\n');
     }
    }
    node('h3',`최근 논문 ${works.length}`,list,{class:'sc-hit-group'});
    if(!works.length)node('p','최근 논문을 찾지 못했습니다.',list,{class:'sc-muted'});
    else hitList(works,list);
    message(`${works.length}편 · 이미 보유 ${works.filter(w=>w.inLibrary).length}편`
     +(watching?` · 새 논문 ${fresh.length}편`+(checkedAt?` · 마지막 확인 ${checkedAt.slice(0,10)}`:''):''));
   }
   // Every row used to read "<institution> · 마지막 확인 2026-09-17" -- the same
   // date on all 109 of them, which answered nothing and cost the only line
   // available. A watchlist has exactly one question: who has published since I
   // looked. So the sweep runs once for everyone, the answer lives on the row,
   // and the people with news sort to the top.
   function drawWatched(parent){
    const watched=runtime.watchedAuthorsByNews();
    if(!watched.length)return;
    const swept=watched.some(person=>person.sweptAt);
    const fresh=watched.filter(person=>person.news?.length);
    const head=node('div',null,parent,{class:'sc-watch-head'});
    node('h3',`관심 저자 ${watched.length}`,head,{class:'sc-hit-group'});
    const tools=node('div',null,head,{class:'sc-watch-tools'});
    button(swept?'새 논문 다시 확인':'새 논문 한 번에 확인',()=>run(async()=>{
     message(`관심 저자 ${watched.length}명의 새 논문을 확인하는 중…`);
     const result=await runtime.sweepWatchedAuthors({onProgress:(done,total)=>
      message(`새 논문 확인 중 ${done+1}/${total}`)});
     if(token!==epoch||disposed||state.tab!=='authors')return;
     refreshWatched();
     message(result.budgetGone
      ? `OpenAlex 하루 한도를 다 썼습니다. ${result.remaining}묶음이 남았고 UTC 자정에 초기화됩니다. 지금까지 확인한 결과는 저장했습니다.`
      : result.withNews
       ? `${result.withNews}명이 새 논문 ${result.works}편을 냈습니다. 요청 ${result.requests}회.`
       : `새 논문은 없습니다. 저자 ${result.authors}명을 요청 ${result.requests}회로 확인했습니다.`,
      result.budgetGone);
    }),tools);
    if(fresh.length)node('span',`새 논문 ${fresh.reduce((n,p)=>n+p.news.length,0)}편 · ${fresh.length}명`,tools,{class:'sc-watch-count'});
    else if(swept)node('span','새 논문 없음',tools,{class:'sc-watch-quiet'});
    // A grid, not a column: at this panel width one name per row turned a
    // hundred people into a scroll, and the whole point is to see them at once.
    const rows=node('div',null,parent,{class:'sc-watch-grid'});
    for(const person of watched){
     const count=person.news?.length||0;
     const row=node('div',null,rows,{class:'sc-watch'+(count?' sc-watch-new':'')});
     row.setAttribute('role','button');row.tabIndex=0;
     const open=()=>run(()=>show(person));
     row.addEventListener('click',open);
     row.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}});
     const line=node('div',null,row,{class:'sc-watch-line'});
     node('span',person.name,line,{class:'sc-watch-name'});
     if(count)node('span',String(count),line,{class:'sc-watch-badge',title:`마지막 확인 이후 새 논문 ${count}편`});
     // With news, the line says what the news is; without it, who they are.
     const latest=count?person.news[0]:null;
     const sub=node('span',latest?`${latest.date?latest.date.slice(0,7)+' · ':''}${latest.venue||latest.title||''}`
      :(person.institution||'소속 미확인'),row,{class:'sc-watch-sub'});
     sub.title=latest?`${latest.title||''}${latest.venue?' · '+latest.venue:''}`
      :(person.institution||'');
     row.title=count?`${person.name} · 새 논문 ${count}편`
      :person.sweptAt?`${person.name} · 새 논문 없음 (확인 ${person.sweptAt.slice(0,10)})`
      :`${person.name} · 아직 확인하지 않음`;
    }
   }
   function refreshWatched(){
    watchArea.replaceChildren();
    drawWatched(watchArea);
    if(!watchArea.childNodes.length&&!item)node('p','아직 관심 저자가 없습니다. 문헌을 하나 선택하면 그 저자를 등록할 수 있습니다.',watchArea,{class:'sc-muted'});
   }

   async function loadAuthors(){
    message('저자 정보를 확인하는 중…');
    const people=await runtime.authorsOfCached(runtime.Z.Items.get(Number(item.id)));
    if(token!==epoch||disposed||state.tab!=='authors')return;
    list.replaceChildren();
    refreshWatched();
    if(!people.length){message('OpenAlex에서 이 논문의 저자를 찾지 못했습니다.',true);return;}
    node('h3',`이 논문의 저자 ${people.length}`,list,{class:'sc-hit-group'});
    message(`저자 ${people.length}명. 이름을 눌러 최근 작업을 확인하세요.`);
    const authors=node('div',null,list,{class:'sc-hits'});
    for(const person of people){
     const row=node('div',null,authors,{class:'sc-hit'});
     node('p',person.name,row,{class:'sc-hit-title'});
     node('p',[person.position==='first'?'제1저자':person.position==='last'?'교신·책임저자':'공저자',person.institution].filter(Boolean).join(' · '),row,{class:'sc-hit-meta'});
     const actions=node('div',null,row,{class:'sc-hit-actions'});
     button('최근 논문',()=>run(()=>show(person)),actions);
    }
    // One author is not a choice; go straight to their work.
    if(people.length===1)await show(people[0]);
   }
   refreshWatched();
   if(!item){
    message(`관심 저자 ${runtime.watchedAuthors().length}명. 새 저자를 등록하려면 문헌을 하나 선택하세요.`);
    return;
   }
   node('h2',item.title,body);
   const b=bar();
   button('새로고침',()=>run(async()=>{
    runtime.discoverCache.delete('authors:'+runtime.identity(runtime.Z.Items.get(Number(item.id))));
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
  function metric(parent,{icon,text,tone,label,name}){
   const span=node('span',null,parent,{class:'sc-metric',title:label});
   if(name)span.dataset.metric=name;
   if(icon)metricIcon(icon,span);
   node('span',text,span,{class:'sc-metric-value'});
   if(tone)span.dataset.tone=tone;
   return span;
  }

  function drawJournals(){const seen=new Set();const list=node('div',null,body,{class:'sc-hits'});for(const item of rows()){if(!item.venue||seen.has(item.venue))continue;seen.add(item.venue);
   const c=node('div',null,list,{class:'sc-hit sc-journal'});
   node('p',item.venue,c,{class:'sc-hit-title'});
   // publicationTags already carries "IF 56.1 (2025)" and the rank grades, so the
   // impact factor was being printed twice; say it once, with its provenance.
   const tags=runtime.publicationTags?.(runtime.Z.Items.get(Number(item.id)))||[];
   const facts=tags.length?tags:[item.impactFactor==null?'IF 미확인':`IF ${item.impactFactor}`];
   node('p',facts.join(' · '),c,{class:'sc-hit-meta'});
   const source=item.impactSource||'출처 정보 없음';
   node('p',source.replace(/https?:\/\/[^\s·]+/,m=>m.replace(/^https?:\/\/(www\.)?/,'').split('/')[0]),c,{class:'sc-hit-authors',title:source});
   const actions=node('div',null,c,{class:'sc-hit-actions'});
   // The route that needs nothing comes first. easyScholar wants a key the user
   // may never have had, and leading with it made the tab look broken.
   button('지표 조회',async()=>{
    const ref=runtime.Z.Items.get(Number(item.id));
    const hit=await runtime.fetchJournalMetric(runtime.journalRecord(ref));
    await load();
    message(hit&&hit.citedness!=null
     ?`${hit.name||item.venue}: 2년 평균 피인용 ~${hit.citedness} (OpenAlex 추정치, 공식 JIF 아님)`
     :`${item.venue}: OpenAlex에 이 저널의 지표가 없습니다.`);
   },actions);
   button('공식 값 새로고침',async()=>{const result=await runtime.refreshJournalMetrics([runtime.Z.Items.get(Number(item.id))],win.DOMParser);message(`확인 ${result.updated} · 미확인 ${result.failed+result.unknown}`);await load();},actions);
   // Shown only once a key exists, so the tab never offers something that can
   // only fail.
   if(String(runtime.pref?.('journalRankKey','')||'').trim()){
    button('등급 조회',async()=>{await runtime.refreshPublicationRanks([runtime.Z.Items.get(Number(item.id))]);await load();message('저널 등급 조회를 마쳤습니다.');},actions);
   }
  }
  if(!seen.size)return;
  if(!String(runtime.pref?.('journalRankKey','')||'').trim()){
   node('p','JCR 분위·CAS 등급은 easyScholar 무료 키가 있어야 조회됩니다. 설정에서 키를 넣으면 이 목록에 등급 조회 버튼이 생깁니다. 키 없이도 위의 지표 조회는 동작합니다.',
    body,{class:'sc-muted'});
  }}
  function drawAssist(){let item;try{item=one();}catch(_){empty('번역·요약할 문헌 하나를 선택하세요. 설정에서 AI endpoint와 모델을 연결할 수 있습니다.');return;}bindAI(item.id);node('h2',item.title,body);const b=bar();const language=node('input',null,b,{value:setting('aiLanguage','Korean'),'aria-label':'출력 언어'});const output=node('textarea',null,body,{class:'sc-ai-output','aria-label':'AI 생성 결과 — 적용 전 확인'});if(state.aiOutput)output.value=Array.isArray(state.aiOutput)?state.aiOutput.join(', '):state.aiOutput;
   for(const[task,label]of [['translate','제목 번역'],['summary','초록 요약'],['remark','읽기 메모 제안'],['tags','태그 제안']])button(label,async()=>{message('선택한 텍스트를 설정된 AI 서비스에 요청 중…');const request=++aiEpoch;const result=await assist.run(task,item,{language:language.value});if(disposed||panel.hidden||state.tab!=='assist'||request!==aiEpoch||state.aiItemID!==item.id||selected().length!==1||selected()[0].id!==item.id)return;state.aiTask=task;state.aiOutput=result;const current=body.querySelector('.sc-ai-output');if(current){current.value=Array.isArray(result)?result.join(', '):result;updateDraft(current.dataset.draftKey,current.value);}message('AI 생성 결과입니다. 원문과 비교한 뒤 적용하세요.');},b);
   button('요청 중지',()=>{aiEpoch++;assist.cancel?.();message('AI 요청을 중지했습니다.');},b);
   const actions=bar();button('결과 복사',()=>copy(output.value),actions);button('선택 문헌에 적용',async()=>{if(!output.value.trim()||state.aiItemID!==item.id||!state.aiTask)throw new Error('현재 문헌의 결과를 먼저 생성하세요.');const ref=runtime.Z.Items.get(Number(item.id));if(state.aiTask==='tags')await library.addTags([item.id],output.value.split(',').map(s=>s.trim()).filter(Boolean));else if(state.aiTask==='remark')await library.setRemark(item.id,output.value);else{runtime.entry(ref)[state.aiTask==='translate'?'translatedTitle':'summary']=output.value;runtime.dirty=true;await runtime.flush();}message('확인한 결과를 저장했습니다.');await runtime.refreshWindows();},actions);
  }
  function drawAppearance(){
   const menus=bar();menus.hidden=!enabled('menuVisibility');node('strong','작업 메뉴 표시',menus);
   for(const [id,label]of TABS)if(id!=='appearance')check(label+' 메뉴 표시',!hiddenTabs().has(id),on=>run(async()=>{const hidden=hiddenTabs();on?hidden.delete(id):hidden.add(id);runtime.cache.hiddenWorkbenchTabs=[...hidden];runtime.dirty=true;await runtime.flush();render();}),menus);
   button('메뉴 기본값 복원',async()=>{runtime.cache.hiddenWorkbenchTabs=[];runtime.dirty=true;await runtime.flush();render();},menus);
   button('앱 밝게/어둡게 전환',()=>runtime.toggleAppTheme(),body);check('문서 탭 활동 시 수정일 갱신',runtime.pref('touchDateOnRead',false),on=>runtime.Z.Prefs.set('extensions.style-custom.touchDateOnRead',on,true),body);
   node('p','Custom 패널과 추가 열의 표시를 조절합니다. PDF 색상은 읽기 진행에서 설정하세요.',body);const form=bar();const accent=node('input',null,form,{type:'color','aria-label':'강조 색상'});accent.value=runtime.pref('accentColor','#374151');const size=node('input',null,form,{type:'number',min:'11',max:'20','aria-label':'패널 글꼴 크기'});size.value=runtime.pref('panelFontSize',13);button('스타일 저장',async()=>{runtime.Z.Prefs.set('extensions.style-custom.accentColor',accent.value,true);const fontSize=Math.max(11,Math.min(20,Number(size.value)||13));runtime.Z.Prefs.set('extensions.style-custom.panelFontSize',fontSize,true);if(['#374151','#5654d8'].includes(accent.value.toLowerCase()))panel.style.removeProperty('--sc-accent');else panel.style.setProperty('--sc-accent',accent.value);panel.style.fontSize=fontSize+'px';size.value=String(fontSize);},form);
   check('제목 옆 색상·별점 태그',runtime.pref('titleTags',false),on=>{runtime.Z.Prefs.set('extensions.style-custom.titleTags',on,true);runtime.refreshWindows();},body);check('안 읽은 제목 굵게',runtime.pref('unreadBold',false),on=>{runtime.Z.Prefs.set('extensions.style-custom.unreadBold',on,true);runtime.refreshWindows();},body);check('제목 읽기 히트맵',runtime.pref('titleHeatmap',false),on=>{runtime.Z.Prefs.set('extensions.style-custom.titleHeatmap',on,true);runtime.refreshWindows();},body);check('항목 아이콘 클릭으로 유형 필터',runtime.pref('quickTypeFilter',true),on=>runtime.Z.Prefs.set('extensions.style-custom.quickTypeFilter',on,true),body);
   const customFields=node('input',null,body,{'aria-label':'추가 문헌 열','placeholder':'DOI, publisher, language'});customFields.value=runtime.pref('customFields','');button('추가 열 적용',async()=>{await runtime.setCustomFields(customFields.value);message('추가 열을 적용했습니다.');},body);
   const css=node('textarea',null,body,{'aria-label':'Custom 패널 CSS',placeholder:'.sc-card { font-size: 13px; }'});css.value=runtime.pref('panelCSS','');css.hidden=!enabled('styleEditor');button('패널 CSS 적용',()=>runtime.setPanelCSS(css.value),body).hidden=!enabled('styleEditor');
  }
  async function render(){if(disposed||panel.hidden)return;if(hiddenTabs().has(state.tab))state.tab='appearance';const token=++epoch;clear();memoFields=[];draftContext=JSON.stringify([state.tab,state.libraryID,[...state.selected].sort()]);draftCounters=new Map();for(const[id,b]of navButtons){b.hidden=hiddenTabs().has(id);b.setAttribute('aria-current',id===state.tab?'page':'false');b.classList.toggle('active',id===state.tab);}updateChrome();refreshNotice().catch(()=>{});try{
   switch(state.tab){case'explore':await paperList(rows());break;case'recent':await drawRecent();break;case'related':await drawRelated(token);break;case'authors':await drawAuthors(token);break;case'graph':drawGraph();break;case'tags':drawTags();break;case'notes':await drawNotes(token);break;case'annotations':await drawAnnotations(token);break;case'backlinks':await drawBacklinks(token);break;case'attachments':await drawAttachments(token);break;case'reading':drawReading();break;case'tabs':drawTabs();break;case'views':drawViews();break;case'canvas':drawCanvas();break;case'matrix':drawMatrix();break;case'collections':await drawCollections(token);break;case'journals':drawJournals();break;case'assist':drawAssist();break;case'appearance':drawAppearance();break;}
   if(token===epoch&&!disposed)restoreDrafts();
  }catch(error){if(token===epoch&&!disposed)message(readable(error),true);}}
  function refreshMetrics(){
   if(disposed||panel.hidden)return;
   for(const item of state.items){const ref=runtime.Z.Items.get(Number(item.id));if(ref)Object.assign(item,runtime.state(ref));}
   for(const card of body.querySelectorAll('[data-item-id]')){const item=state.items.find(row=>String(row.id)===card.dataset.itemId);if(!item)continue;card.dataset.status=item.status;const time=card.querySelector('[data-metric=time] .sc-metric-value');if(time)time.textContent=(runtime.formatReadTime?runtime.formatReadTime(item.seconds)||'0s':Math.floor(item.seconds||0)+'초');const status=card.querySelector('[data-metric=status]');if(status)status.textContent=({unread:'안 읽음',reading:'읽는 중',done:'완료'})[item.status]||'안 읽음';}
  }
  async function applyPreferences(){panel.dataset.density=setting('workbenchDensity',runtime.cache.workbenchUI?.density||'comfortable');syncDensity();const accent=setting('accentColor','#374151');if(['#374151','#5654d8'].includes(accent.toLowerCase()))panel.style.removeProperty('--sc-accent');else panel.style.setProperty('--sc-accent',accent);panel.style.fontSize=setting('panelFontSize',13)+'px';await render();}
  const keyboard=e=>{if(e.isComposing||panel.hidden)return;
   if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();e.stopPropagation();commands.hidden?openCommands():closeCommands();return;}
   if(!commands.hidden)return;
   const editing=e.target?.closest?.('input,textarea,select,[contenteditable=true]');
   if((e.key==='/'&&!editing)||((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='f')){if(!controls.hidden){e.preventDefault();search.focus?.();search.select?.();}}
   else if(e.key==='Escape'){e.stopPropagation();toggle(false);}
  };panel.addEventListener('keydown',keyboard);
  if(runtime.Z.Notifier){notifier=runtime.Z.Notifier.registerObserver({notify:()=>{if(disposed||panel.hidden)return;if(reloadTimer)win.clearTimeout(reloadTimer);reloadTimer=win.setTimeout(()=>run(load),200);}},['item','item-tag','collection','tab'],'style-custom-workbench');}
  const selectionTimer=win.setInterval(()=>{if(!disposed&&!win.closed&&!panel.hidden&&scopeContext()!==observedContext)run(load);},500);
  function destroy(){if(disposed)return;
   // An edit typed a moment ago is still waiting out its timer. Closing the
   // panel must write it, not discard it.
   for(const flush of memoFields)Promise.resolve(flush()).catch(error=>runtime.Z.logError?.(error));
   memoFields=[];
   disposed=true;win.clearInterval(selectionTimer);epoch++;loadEpoch++;aiEpoch++;if(draftTimer){win.clearTimeout(draftTimer);draftTimer=null;Promise.resolve(runtime.flush()).catch(error=>runtime.Z.logError?.(error));}if(reloadTimer)win.clearTimeout(reloadTimer);if(notifier!=null)runtime.Z.Notifier.unregisterObserver(notifier);clear();for(const[target,event,fn]of listeners)target.removeEventListener(event,fn);toolbar?.remove();panel.remove();sheet.remove();}
  const accent=runtime.pref('accentColor','#374151');if(/^#[a-f\d]{6}$/i.test(accent)&&!['#374151','#5654d8'].includes(accent.toLowerCase()))panel.style.setProperty('--sc-accent',accent);panel.style.fontSize=Math.max(11,Math.min(20,Number(runtime.pref('panelFontSize',13))||13))+'px';
  // Long background work reports here rather than through a modal, so the user
  // can keep reading while the columns fill in behind them.
  const setStatus=value=>{if(!disposed)message(value);};
  return {toggle,load,render,refreshReading,refreshMetrics,applyPreferences,destroy,panel,state,setStatus,show:async tab=>{navigationEpoch++;if(TABS.some(t=>t[0]===tab))state.tab=tab;await toggle(true);}};
 }
 const api={attach,TABS};root.CustomStyleWorkbench=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);

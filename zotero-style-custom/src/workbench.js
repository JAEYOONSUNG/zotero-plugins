/* User-opened, in-window research workspace. Never opens itself or another app. */
(function(root){
 'use strict';
 const HTML='http://www.w3.org/1999/xhtml',SVG='http://www.w3.org/2000/svg';
 const TABS=[['explore','문헌 탐색'],['recent','최근 문헌'],['graph','관계 그래프'],['tags','중첩 태그'],['notes','노트'],['annotations','주석'],['backlinks','역링크'],['attachments','첨부 미리보기'],['reading','읽기 진행'],['tabs','탭 관리'],['views','뷰 그룹'],['canvas','캔버스'],['matrix','논문 비교'],['collections','컬렉션'],['journals','저널 지표'],['assist','번역 · AI'],['appearance','스타일 편집']];
 const GROUPS=[['탐색',['explore','recent','collections','journals']],['읽기',['reading','notes','annotations','attachments','backlinks']],['정리',['tags','graph','canvas','matrix']],['도구',['tabs','views','assist','appearance']]];
 const FILTER_TABS=new Set(['explore','recent','collections','journals','reading','notes','annotations','attachments','tags','graph']);
 function attach(win,{runtime,library,reader,model,assist}){
  const doc=win.document;let disposed=false,epoch=0,loadEpoch=0,previewEpoch=0,aiEpoch=0,preview=null,notifier=null,reloadTimer=null,draftTimer=null;
  let observedContext=null;let draftContext='',draftCounters=new Map();const drafts=new Map(),visibleAnnotationIDs=new Set(),pageRanges=new Map(),deletedCardSelections=new Map();
  const ui=runtime.cache.workbenchUI&&typeof runtime.cache.workbenchUI==='object'?runtime.cache.workbenchUI:{};
  let returnFocus=null,commandFocus=null,commandIndex=0,commandMatches=[],navigationEpoch=0;const pendingActions=new Set();
  const state={tab:TABS.some(([id])=>id===ui.lastTab)?ui.lastTab:'explore',query:'',type:'',tag:'',status:'',ratingMin:'',yearFrom:'',yearTo:'',sort:'library',scope:'library',items:[],selected:new Set(),annotationIDs:new Set(),graphMode:'related',boardID:null,cardIDs:new Set(),color:'',transpose:false,aiOutput:null,aiTask:null,aiItemID:null,libraryID:null,paletteID:null};
  const enabled=id=>runtime.featureEnabled?.(id)!==false;
  const setting=(key,fallback)=>runtime.getSetting?runtime.getSetting(key):runtime.pref(key,fallback);
  const tabFeature={explore:'explore',recent:'Recent',graph:'graphView',tags:'tags',notes:'noteManager',annotations:'annotationManager',backlinks:'backlinks',attachments:'attachmentPreview',tabs:'tabManager',views:'viewManager',canvas:'canvas'};
  const actionFeature={'선택 주석 색상 변경':'annotationColors','선택 주석 병합':'reader.mergeAnnotations','참조 노트 보기':'backlinks','밝은 PDF':'PDFStyles','어두운 PDF':'PDFStyles','세피아 PDF':'PDFStyles','사용자 PDF 테마 적용':'PDFStyles','주석 팔레트 적용':'annotationColors','주석 팔레트 삭제':'annotationColors','주석 팔레트 저장':'annotationColors','색상 이름 저장':'showAnnotationColorName','여백 주석 설정 적용':'marginAnnotation','관련 문헌으로 연결':'relatedItems','선택 문헌끼리 연결 해제':'relatedItems','선택 문헌에 태그 추가':'addTags','선택 문헌에서 태그 제거':'addTags','선택 문헌 태그 이름 변경':'addTags','초록 요약':'tldr','읽기 메모 제안':'AIGenerateRemark','태그 제안':'AIGenerateTags','앱 밝게/어둡게 전환':'darkLightButton'};
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
  const node=(tag,text,parent,attrs={})=>{const n=doc.createElementNS(HTML,tag);if(text!==null&&text!==undefined)n.textContent=text;for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));parent?.appendChild(n);if(draftContext&&['input','textarea'].includes(tag)&&attrs['aria-label']){const label=attrs['aria-label'],index=draftCounters.get(label)||0;draftCounters.set(label,index+1);n.dataset.draftKey=draftContext+'|'+label+'|'+index;}return n;};
  const panel=node('section',null,doc.documentElement,{id:'style-custom-workbench','aria-label':'Style Custom 연구 작업 패널'});panel.hidden=true;
  const sheet=node('link',null,doc.documentElement,{rel:'stylesheet',href:runtime.rootURI+'content/workbench.css'});
  panel.dataset.density=ui.density==='compact'?'compact':'comfortable';panel.setAttribute('role','region');
  const head=node('header',null,panel,{class:'sc-header'}),brand=node('div',null,head,{class:'sc-brand'});node('img',null,brand,{src:runtime.rootURI+'content/icons/style-custom.svg',width:24,height:24,alt:'','aria-hidden':'true'});node('strong','Style Custom',brand);node('span','연구 작업 패널',brand,{class:'sc-subtitle'});const headerActions=node('div',null,head,{class:'sc-header-actions'});
  const status=node('div','준비',panel,{class:'sc-status',role:'status','aria-live':'polite'});
  function message(value,error=false){if(disposed)return;status.textContent=String(value);status.dataset.error=String(error);}
  async function run(fn){try{return await fn();}catch(error){if(!disposed)message(error.message||error,true);return null;}}
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
  const density=button('간격 좁게',()=>{panel.dataset.density=panel.dataset.density==='compact'?'comfortable':'compact';syncDensity();return saveUI({density:panel.dataset.density});},headerActions,{'aria-label':'화면 밀도 전환'});
  function syncDensity(){density.textContent=panel.dataset.density==='compact'?'간격 넓게':'간격 좁게';density.setAttribute('aria-pressed',String(panel.dataset.density==='compact'));}syncDensity();
  button('기능 찾기',()=>openCommands(),headerActions,{'aria-keyshortcuts':'Meta+K Control+K',title:'기능 찾기 · ⌘/Ctrl K'});
  button('닫기',()=>toggle(false),headerActions,{'aria-label':'작업 패널 닫기'});
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
  const context=node('div',null,content,{class:'sc-context'}),sectionTitle=node('h2','문헌 탐색',context,{class:'sc-section-title'}),contextDetail=node('span',null,context,{class:'sc-context-detail'});
  const body=node('div',null,content,{class:'sc-body',tabindex:'-1'});
  const navButtons=new Map();
  async function navigate(id,{focus=false}={}){if(!TABS.some(([key])=>key===id)||hiddenTabs().has(id))return;const request=++navigationEpoch;state.tab=id;await render();if(disposed||panel.hidden||request!==navigationEpoch||state.tab!==id)return;await saveUI({lastTab:id});if(focus&&!disposed&&!panel.hidden&&request===navigationEpoch&&state.tab===id&&commands.hidden)body.focus?.();}
  for(const [label,ids]of GROUPS){const group=node('div',null,nav,{class:'sc-nav-group'});node('div',label,group,{class:'sc-nav-heading'});for(const id of ids){const label=TABS.find(([key])=>key===id)[1];navButtons.set(id,button(label,()=>navigate(id),group,{'data-tab':id}));}}
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
  let toolbar;
  const target=doc.getElementById('zotero-items-toolbar');
  if(target){toolbar=doc.createXULElement?doc.createXULElement('toolbarbutton'):node('button');toolbar.id='style-custom-workbench-button';toolbar.setAttribute('image',runtime.rootURI+'content/icons/style-custom.svg');toolbar.setAttribute('label','워크벤치');toolbar.setAttribute('tooltiptext','Style Custom 연구 작업 패널');toolbar.addEventListener('command',()=>run(()=>toggle()));toolbar.addEventListener('click',()=>{if(!doc.createXULElement)run(()=>toggle());});target.appendChild(toolbar);}
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
  function card(title,subtitle,parent=body){const c=node('article',null,parent,{class:'sc-card'});node('h3',title||'제목 없음',c);if(subtitle)node('p',subtitle,c,{class:'sc-muted'});return c;}
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
  async function paperList(items){if(!items.length){empty('조건에 맞는 문헌이 없습니다. 검색어나 필터를 지우세요.');return;}
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
   const identity=node('div',null,heading,{class:'sc-paper-identity'});node('h3',item.title||'제목 없음',identity,{class:'sc-paper-title'});node('p',[item.authors,item.year,item.venue].filter(Boolean).join(' · '),identity,{class:'sc-paper-meta'});
   const metrics=node('p',null,c,{class:'sc-metrics'});
   for(const[label,value]of [['인용',item.citations??'—'],['IF',item.impactFactor??'—'],['',({unread:'안 읽음',reading:'읽는 중',done:'완료'})[item.status]||'안 읽음'],['별점',(item.rating??0)+'/5'],['읽기',runtime.formatReadTime?runtime.formatReadTime(item.seconds):Math.floor(Number(item.seconds)||0)+'초']])node('span',[label,value].filter(value=>value!=='').join(' '),metrics,{class:'sc-metric','data-metric':label==='읽기'?'time':label===''?'status':label});
   const actions=bar(c);actions.classList.add('sc-paper-actions');button('열기',()=>library.openItem(item.id),actions,{'data-variant':'primary'});button('자세히',()=>{state.selected=new Set([item.id]);state.scope='selected';scope.value='selected';render();},actions);
   metrics.title=[item.citationSource,item.impactSource].filter(Boolean).join(' · ')||'지표 출처 미확인';
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
  function drawGraph(){const b=bar();for(const[mode,label]of [['related','관련 문헌'],['tags','공통 태그'],['authors','공통 저자']])button(label,()=>{state.graphMode=mode;render();},b,{'aria-pressed':state.graphMode===mode});
   const data=model.layout(library.graph(rows().slice(0,setting('graphNodeLimit',180)),{mode:state.graphMode}),760,480);if(!data.nodes.length){empty('문헌을 가져오면 관계 그래프가 나타납니다.');return;}
   const svg=doc.createElementNS(SVG,'svg');svg.setAttribute('viewBox','0 0 760 480');svg.setAttribute('class','sc-graph');svg.setAttribute('aria-label','문헌 관계 그래프');body.appendChild(svg);let zoom=1;
   const group=doc.createElementNS(SVG,'g');svg.appendChild(group);const positions=new Map(data.nodes.map(n=>[n.id,n]));
   for(const e of data.edges){const a=positions.get(String(e.source)),b=positions.get(String(e.target));if(!a||!b)continue;const line=doc.createElementNS(SVG,'line');for(const[k,v]of Object.entries({x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:'#a9bcc9'}))line.setAttribute(k,v);group.appendChild(line);}
   for(const n of data.nodes){const g=doc.createElementNS(SVG,'g');g.setAttribute('transform',`translate(${n.x} ${n.y})`);g.setAttribute('tabindex','0');g.setAttribute('role','button');g.setAttribute('aria-label',n.label);const circle=doc.createElementNS(SVG,'circle');circle.setAttribute('r',state.selected.has(n.id)?8:5);circle.setAttribute('fill',state.selected.has(n.id)?'var(--sc-accent)':'var(--sc-muted)');g.appendChild(circle);const label=doc.createElementNS(SVG,'text');label.setAttribute('x','9');label.setAttribute('y','4');label.textContent=String(n.label).slice(0,34);g.appendChild(label);const activate=()=>{state.selected=new Set([n.id]);updateSelectionUI();message(n.label);};g.addEventListener('click',activate);g.addEventListener('dblclick',()=>run(()=>library.openItem(n.id)));g.addEventListener('keydown',e=>{if(e.key==='Enter')activate();});group.appendChild(g);}
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
  async function drawAnnotations(token){const actions=bar();const color=node('input',null,actions,{placeholder:'#ffd400 또는 색상 전체','aria-label':'주석 색상 필터'});color.value=state.color;button('색상 적용',()=>{state.color=color.value.trim();render();},actions);button('선택 주석을 노트로',async()=>{const chosen=[...state.annotationIDs].filter(id=>visibleAnnotationIDs.has(id));if(!chosen.length)throw new Error('현재 범위의 주석을 선택하세요.');const id=await library.noteFromAnnotations(chosen);await library.openItem(id);message('출처 링크가 포함된 노트를 만들었습니다.');},actions);
   const colorEdit=node('input',null,actions,{type:'color',value:'#ffd400','aria-label':'선택 주석 새 색상'});
   button('선택 주석 색상 변경',async()=>{const chosen=[...state.annotationIDs].filter(id=>visibleAnnotationIDs.has(id));if(!chosen.length)throw new Error('현재 범위의 주석을 선택하세요.');const count=await library.recolorAnnotations(chosen,colorEdit.value);await render();message(`${count}개 주석의 색상을 변경했습니다.`);},actions);
   button('표시된 주석 전체 선택',()=>{state.annotationIDs=new Set(visibleAnnotationIDs);render();},actions);
   button('선택 주석 병합',async()=>{const chosen=[...state.annotationIDs].filter(id=>visibleAnnotationIDs.has(id));const token=epoch;const id=await library.mergeAnnotations(chosen,{isCurrent:()=>!disposed&&!panel.hidden&&epoch===token});state.annotationIDs=new Set([String(id)]);await render();message('주석을 병합했습니다. 나머지 주석은 휴지통에서 복원할 수 있습니다.');},actions);
   node('p','병합: 같은 PDF·유형·색상, 같은 페이지 또는 인접 두 페이지. 기존 참조 노트의 링크는 자동으로 바꾸지 않습니다.',body,{class:'sc-muted'});
   const list=await library.annotations(ids());if(token!==epoch||disposed)return;const filtered=list.filter(a=>(!setting('annotationIgnoreFigures',false)||!/^(?:figure|fig\.?|table|그림|표)\s*\d/i.test((a.text||'').trim()))&&(!state.color||a.color.toLowerCase()===state.color.toLowerCase())&&(!state.query||(a.text+' '+a.comment).toLowerCase().includes(state.query.toLowerCase())));state.annotationIDs=new Set([...state.annotationIDs].filter(id=>filtered.some(a=>a.id===id)));for(const a of filtered){visibleAnnotationIDs.add(a.id);const c=card(`p.${a.pageLabel||((a.pageIndex??0)+1)} · ${a.type}`,a.comment);c.style.borderInlineStart='4px solid '+(/^#[0-9a-f]{6}$/i.test(a.color)?a.color:'#ccd7e1');check('주석 선택',state.annotationIDs.has(a.id),on=>on?state.annotationIDs.add(a.id):state.annotationIDs.delete(a.id),c);node('p',setting('annotationPreferComment',false)&&a.comment?a.comment:a.text,c);button('원문 위치',()=>library.openItem(a.id),c);button('참조 노트 보기',async()=>{const generation=epoch,links=await library.backlinks(a.id);if(disposed||generation!==epoch||!c.isConnected)return;let list=c.querySelector('[data-annotation-backlinks]');if(!list)list=node('div',null,c,{'data-annotation-backlinks':'true'});list.replaceChildren();const notes=links.filter(link=>link.kind==='note');node('p',`참조 노트 ${notes.length}개`,list);for(const note of notes)button(note.title||'제목 없는 노트',()=>library.openItem(note.id),list);},c);}if(!filtered.length)empty('조건에 맞는 주석이 없습니다. PDF에서 하이라이트나 메모를 추가하세요.');}
  async function drawBacklinks(token){let item;try{item=one();}catch(_){empty('역링크를 확인할 문헌 하나를 선택하세요.');return;}node('h2',item.title,body);const links=await library.backlinks(item.id);if(token!==epoch||disposed)return;for(const link of links){const c=card(link.title,link.kind==='note'?'이 문헌을 참조한 노트':'관련 문헌');button('열기',()=>library.openItem(link.id),c);}if(!links.length)empty('이 문헌을 가리키는 노트나 관련 문헌이 없습니다.');}
  async function drawAttachments(token){
   const list=await library.attachments(ids());if(token!==epoch||disposed)return;
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
  function drawJournals(){const seen=new Set();for(const item of rows()){if(!item.venue||seen.has(item.venue))continue;seen.add(item.venue);const c=card(item.venue,item.impactSource||'출처 정보 없음');node('p',item.impactFactor==null?'IF 미확인':`IF ${item.impactFactor}`,c,{class:'sc-metrics'});const tags=runtime.publicationTags?.(runtime.Z.Items.get(Number(item.id)))||[];if(tags.length)node('p',tags.join(' · '),c);button('저널 등급 조회',async()=>{await runtime.refreshPublicationRanks([runtime.Z.Items.get(Number(item.id))]);await load();message('저널 등급 조회를 마쳤습니다.');},c);button('공식 값 새로고침',async()=>{const result=await runtime.refreshJournalMetrics([runtime.Z.Items.get(Number(item.id))],win.DOMParser);message(`확인 ${result.updated} · 미확인 ${result.failed+result.unknown}`);await load();},c);}}
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
  async function render(){if(disposed||panel.hidden)return;if(hiddenTabs().has(state.tab))state.tab='appearance';const token=++epoch;clear();draftContext=JSON.stringify([state.tab,state.libraryID,[...state.selected].sort()]);draftCounters=new Map();for(const[id,b]of navButtons){b.hidden=hiddenTabs().has(id);b.setAttribute('aria-current',id===state.tab?'page':'false');b.classList.toggle('active',id===state.tab);}updateChrome();try{
   switch(state.tab){case'explore':await paperList(rows());break;case'recent':await drawRecent();break;case'graph':drawGraph();break;case'tags':drawTags();break;case'notes':await drawNotes(token);break;case'annotations':await drawAnnotations(token);break;case'backlinks':await drawBacklinks(token);break;case'attachments':await drawAttachments(token);break;case'reading':drawReading();break;case'tabs':drawTabs();break;case'views':drawViews();break;case'canvas':drawCanvas();break;case'matrix':drawMatrix();break;case'collections':await drawCollections(token);break;case'journals':drawJournals();break;case'assist':drawAssist();break;case'appearance':drawAppearance();break;}
   if(token===epoch&&!disposed)restoreDrafts();
  }catch(error){if(token===epoch&&!disposed)message(error.message||error,true);}}
  function refreshMetrics(){
   if(disposed||panel.hidden)return;
   for(const item of state.items){const ref=runtime.Z.Items.get(Number(item.id));if(ref)Object.assign(item,runtime.state(ref));}
   for(const card of body.querySelectorAll('[data-item-id]')){const item=state.items.find(row=>String(row.id)===card.dataset.itemId);if(!item)continue;card.dataset.status=item.status;const time=card.querySelector('[data-metric=time]');if(time)time.textContent='읽기 '+(runtime.formatReadTime?runtime.formatReadTime(item.seconds):Math.floor(item.seconds||0)+'초');const status=card.querySelector('[data-metric=status]');if(status)status.textContent=({unread:'안 읽음',reading:'읽는 중',done:'완료'})[item.status]||'안 읽음';}
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
  function destroy(){if(disposed)return;disposed=true;win.clearInterval(selectionTimer);epoch++;loadEpoch++;aiEpoch++;if(draftTimer){win.clearTimeout(draftTimer);draftTimer=null;Promise.resolve(runtime.flush()).catch(error=>runtime.Z.logError?.(error));}if(reloadTimer)win.clearTimeout(reloadTimer);if(notifier!=null)runtime.Z.Notifier.unregisterObserver(notifier);clear();for(const[target,event,fn]of listeners)target.removeEventListener(event,fn);toolbar?.remove();panel.remove();sheet.remove();}
  const accent=runtime.pref('accentColor','#374151');if(/^#[a-f\d]{6}$/i.test(accent)&&!['#374151','#5654d8'].includes(accent.toLowerCase()))panel.style.setProperty('--sc-accent',accent);panel.style.fontSize=Math.max(11,Math.min(20,Number(runtime.pref('panelFontSize',13))||13))+'px';
  return {toggle,load,render,refreshReading,refreshMetrics,applyPreferences,destroy,panel,state,show:async tab=>{navigationEpoch++;if(TABS.some(t=>t[0]===tab))state.tab=tab;await toggle(true);}};
 }
 const api={attach,TABS};root.CustomStyleWorkbench=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);

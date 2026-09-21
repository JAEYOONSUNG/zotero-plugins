/* Schema-driven preferences. Values stay local; only explicit runtime actions act externally. */
(function (root) {
 'use strict';
 const HTML='http://www.w3.org/1999/xhtml',instances=new WeakMap();
 function mount({document:doc,runtime}) {
  const host=doc.getElementById('style-custom-settings-root');
  if(!host)throw new Error('Style Custom preferences container is unavailable');
  const existing=instances.get(host);if(existing)return existing;
  if(!runtime?.settingsSchema)throw new Error('Style Custom이 준비되지 않았습니다. 설정을 다시 여세요.');
  const win=doc.defaultView,schema=runtime.settingsSchema,states=new Map(),sections=new Map(),categories=new Map();
  let destroyed=false,active=schema.categories[0]?.id||'',poll=null,observer=null,statusPending=false;
  // Every string the pane shows passes through the runtime's dictionary, so an
  // English-locale Zotero reads the pane in English; keys stay Korean.
  const t=text=>typeof text==='string'&&runtime.t?runtime.t(text):text;
  const TEXT_ATTRS=new Set(['aria-label','placeholder','title']);
  const node=(tag,text,parent,attrs={})=>{const element=doc.createElementNS(HTML,tag);if(text!==null)element.textContent=t(text);for(const [name,value]of Object.entries(attrs))element.setAttribute(name,TEXT_ATTRS.has(name)?String(t(value)):String(value));parent?.appendChild(element);return element;};
  host.replaceChildren();
  const heading=node('div',null,host,{class:'scs-heading'});node('h2','Style Custom 설정',heading);node('p','항목별 설명을 확인하고 값을 적용하세요. 텍스트 입력은 적용을 눌러야 저장됩니다.',heading);
  const message=node('p','설정을 불러오는 중…',host,{role:'status','aria-live':'polite',class:'scs-message'});
  const live=node('section',null,host,{class:'scs-live','aria-label':'현재 동작 상태'});node('strong','현재 동작',live);node('p','현재 선택 문헌 누적 읽기',live,{class:'scs-reading-label'});const readTime=node('output','—',live,{class:'scs-reading-value','aria-label':'현재 선택 문헌 누적 읽기','aria-live':'polite'});const liveText=node('p','현재 상태를 확인하는 중…',live);
  const searchBar=node('div',null,host,{class:'scs-search'});const search=node('input',null,searchBar,{type:'search',placeholder:'설정 이름·설명 검색','aria-label':'Style Custom 설정 검색'});
  const clearSearch=node('button','검색 지우기',searchBar,{type:'button'});const resultCount=node('span','',searchBar,{role:'status'});
  const first=node('section',null,host,{class:'scs-first','aria-label':'먼저 할 것'});first.hidden=true;
  const layout=node('div',null,host,{class:'scs-layout'}),nav=node('nav',null,layout,{'aria-label':'설정 분류',class:'scs-nav'}),content=node('div',null,layout,{class:'scs-content'});
  const empty=node('p','검색에 맞는 설정이 없습니다. 검색어를 바꾸거나 지우세요.',content,{class:'scs-empty'});empty.hidden=true;
  const notify=(text,error=false)=>{if(destroyed)return;message.textContent=t(text);message.dataset.error=String(error);};
  const secret=spec=>!!spec.secret||spec.type==='password';
  // Three fields decide what the plugin can reach; a new user should see them
  // before the category list, and only while they are still blank.
  const FIRST=['openalexApiKey','aiEndpoint','citationEmail'];let refreshFirst=()=>{};
  const valueOf=state=>state.spec.type==='boolean'?state.input.checked:state.input.value;
  function display(state,value){if(state.spec.type==='boolean')state.input.checked=!!value;else state.input.value=String(value??'');}
  function sync(state){
   if(FIRST.includes(state.spec.key))refreshFirst();
   const busy=state.pending||categories.get(state.spec.category)?.pending;
   state.input.disabled=!!busy||state.loading;
   if(state.apply){state.apply.disabled=!!busy||state.loading||!state.dirty;state.apply.hidden=['boolean','select'].includes(state.spec.type)&&!state.error;}
   state.row.setAttribute('aria-busy',String(!!busy||state.loading));
   state.row.dataset.error=String(!!state.error);state.row.dataset.dirty=String(!!state.dirty);
   state.input.setAttribute('aria-invalid',String(!!state.error));
  }
  function changed(state){state.revision++;state.dirty=state.spec.type==='boolean'?state.input.checked!==state.original:String(state.input.value)!==String(state.original??'');state.error=false;state.feedback.textContent=state.dirty?t('아직 적용하지 않았습니다.'):'';sync(state);}
  function parse(state){
   const spec=state.spec;
   if(spec.type==='boolean')return !!state.input.checked;
   const raw=state.input.value;
   if(spec.type==='number'){
    if(!raw.trim())throw new Error('숫자를 입력하세요.');const value=Number(raw);
    if(!Number.isFinite(value)||(spec.min!==undefined&&value<spec.min)||(spec.max!==undefined&&value>spec.max))throw new Error(`범위에 맞는 숫자를 입력하세요${spec.min!==undefined||spec.max!==undefined?' ('+(spec.min??t('제한 없음'))+'–'+(spec.max??t('제한 없음'))+')':''}.`);
    if(spec.step&&spec.step!=='any'){const steps=(value-(spec.min??0))/Number(spec.step);if(Math.abs(steps-Math.round(steps))>1e-8)throw new Error('설정된 간격에 맞는 숫자를 입력하세요.');}
    return value;
   }
   if(spec.type==='select'){const option=(spec.options||[]).find(option=>String(option.value)===raw);if(!option)throw new Error('목록에서 값을 선택하세요.');return option.value;}
   if(spec.type==='color'&&!/^#[0-9a-f]{6}$/i.test(raw))throw new Error('#RRGGBB 형식의 색상을 선택하세요.');
   return raw;
  }
  async function hydrate(state,{force=false,expectedRevision=state.revision}={}){
   if(state.spec.type==='action')return;
   try{
    const value=await runtime.getSetting(state.spec.key);if(destroyed)return;
    state.original=value===undefined?state.spec.default:value;
    if(state.revision===expectedRevision&&(force||!state.dirty)){display(state,state.original);state.dirty=false;state.error=false;state.feedback.textContent='';}
   }catch(error){if(!destroyed){state.error=true;state.feedback.textContent=t('값을 읽지 못했습니다: {0}').replace('{0}',error.message||error);}}
   finally{state.loading=false;if(!destroyed)sync(state);}
  }
  async function save(state){
   if(destroyed||state.pending||categories.get(state.spec.category)?.pending)return;
   let value;try{value=parse(state);}catch(error){state.error=true;state.feedback.textContent=error.message;sync(state);return;}
   const revision=state.revision;state.pending=true;state.feedback.textContent=t('적용하는 중…');sync(state);
   try{
    const result=await runtime.setSetting(state.spec.key,value);if(destroyed)return;const committed=['string','number','boolean'].includes(typeof result)?result:value;state.original=committed;
    if(state.revision===revision)display(state,committed);
    state.dirty=state.spec.type==='boolean'?state.input.checked!==committed:String(state.input.value)!==String(committed??'');state.error=false;
    state.feedback.textContent=t(state.revision===revision||!state.dirty?'적용했습니다.':'이전 값을 적용했습니다. 새 입력은 아직 적용하지 않았습니다.');
    await refreshStatus();
   }catch(error){if(!destroyed){state.error=true;state.dirty=true;state.feedback.textContent=t('적용하지 못했습니다: {0}').replace('{0}',error.message||error);}}
   finally{state.pending=false;if(!destroyed)sync(state);}
  }
  async function reset(category){
   const section=categories.get(category);if(section.pending||destroyed)return;
   // Twenty values change at once and there is no undo: ask first when the window can.
   if(typeof win.confirm==='function'&&!win.confirm(t('{0} 분류의 설정을 모두 기본값으로 되돌릴까요? API 키·비밀번호는 유지됩니다.').replace('{0}',t(section.label))))return;
   const members=[...states.values()].filter(state=>state.spec.category===category);
   if(members.some(state=>state.pending)){notify('진행 중인 적용이 끝난 뒤 기본값으로 되돌리세요.',true);return;}
   const revisions=new Map(members.map(state=>[state,state.revision]));section.pending=true;section.reset.disabled=true;members.forEach(sync);notify(section.label+' 기본값을 적용하는 중…');
   try{
    await runtime.resetSettings(category);if(destroyed)return;
    await Promise.all(members.filter(state=>!secret(state.spec)).map(state=>hydrate(state,{force:true,expectedRevision:revisions.get(state)})));
    notify(t('{0} 설정을 기본값으로 되돌렸습니다. API 키·비밀번호는 유지했습니다.').replace('{0}',t(section.label)));if(section.status)section.status.textContent=t('기본값으로 되돌렸습니다.');await refreshStatus();
   }catch(error){notify('기본값으로 되돌리지 못했습니다: '+(error.message||error),true);}
   finally{section.pending=false;section.reset.disabled=false;if(!destroyed)members.forEach(sync);}
  }
  function filter(){
   const query=search.value.trim().toLocaleLowerCase();let count=0;
   for(const [id,section]of sections){let visible=0;for(const state of states.values())if(state.spec.category===id){const hay=[state.spec.label,state.spec.description,state.spec.help,categories.get(id).label,...(state.spec.options||[]).map(option=>option.label)].map(t).join(' ').toLocaleLowerCase();const matches=!query||hay.includes(query);state.row.hidden=!matches;if(matches)visible++;}section.hidden=query?!visible:id!==active;if(!section.hidden)count+=visible;}
   for(const [id,category]of categories){category.button.setAttribute('aria-current',!query&&id===active?'page':'false');category.button.classList.toggle('active',!query&&id===active);}
   empty.hidden=count>0;resultCount.textContent=query?`${count}개 설정 검색됨`:'';
  }
  function selectCategory(id){if(!categories.has(id)||destroyed)return;active=id;search.value='';filter();}
  for(const category of schema.categories){
   const button=node('button',category.label,nav,{type:'button','data-category':category.id});button.addEventListener('click',()=>selectCategory(category.id));
   const section=node('section',null,content,{class:'scs-category','data-category':category.id}),title=node('div',null,section,{class:'scs-category-heading'});node('h3',category.label,title);if(category.description)node('p',category.description,section,{class:'scs-help'});
   const resetButton=node('button','이 분류 기본값 복원',title,{type:'button','aria-label':category.label+' 기본값 복원'});resetButton.addEventListener('click',()=>reset(category.id));
   const sectionStatus=node('p','',title,{class:'scs-feedback scs-section-status',role:'status','aria-live':'polite'});
   categories.set(category.id,{label:category.label,button,reset:resetButton,status:sectionStatus,pending:false});sections.set(category.id,section);
  }
  for(const spec of schema.settings){
   const section=sections.get(spec.category);if(!section||!spec.key||states.has(spec.key))throw new Error('Invalid settings schema');
   const id='scs-'+encodeURIComponent(spec.key),row=node('div',null,section,{class:'scs-setting','data-setting':spec.key,'data-type':spec.type});
   const state={spec,row,revision:0,original:spec.default,dirty:false,pending:false,loading:spec.type!=='action',error:false};
   const descriptionID=id+'-help',feedbackID=id+'-feedback';
   const label=node('label',spec.label,row,{for:id,class:'scs-label'});const line=node('div',null,row,{class:'scs-value'});
   if(spec.type==='action'){
    state.input=node('button',spec.label,line,{type:'button',id});label.hidden=true;
    state.input.addEventListener('click',async()=>{if(state.pending||destroyed)return;state.pending=true;state.feedback.textContent=t('실행하는 중…');sync(state);try{const answer=await runtime.runSettingAction(spec.action);if(!destroyed){state.feedback.textContent=typeof answer==='string'&&answer?answer:t('실행했습니다.');await refreshStatus();}}catch(error){if(!destroyed){state.error=true;state.feedback.textContent='실행하지 못했습니다: '+(error.message||error);}}finally{state.pending=false;if(!destroyed)sync(state);}});
   }else{
    if(spec.type==='select'){state.input=node('select',null,line,{id});for(const option of spec.options||[])node('option',option.label,state.input,{value:option.value});}
    else if(spec.type==='textarea'){state.input=node('textarea',null,line,{id,rows:spec.rows||4});}
    else if(['boolean','number','color','text','password','email','url'].includes(spec.type)){state.input=node('input',null,line,{id,type:secret(spec)?'password':spec.type==='boolean'?'checkbox':spec.type});}
    else throw new Error('Unsupported settings type: '+spec.type);
    if(secret(spec)){state.input.type='password';state.input.setAttribute('autocomplete','off');state.input.setAttribute('spellcheck','false');
     const reveal=node('button','표시',line,{type:'button','aria-pressed':'false'});reveal.setAttribute('aria-label',t('{0} 표시').replace('{0}',t(spec.label)));
     reveal.addEventListener('click',()=>{const show=state.input.type==='password';state.input.type=show?'text':'password';reveal.textContent=t(show?'가리기':'표시');reveal.setAttribute('aria-pressed',String(show));});}
    if(spec.unit)node('span',spec.unit,line,{class:'scs-unit'});
    for(const key of ['min','max','step'])if(spec[key]!==undefined)state.input.setAttribute(key,spec[key]);
    display(state,spec.default);state.apply=node('button','적용',line,{type:'button','aria-label':spec.label+' 적용'});state.apply.addEventListener('click',()=>save(state));
    state.input.addEventListener('input',()=>changed(state));state.input.addEventListener('change',()=>{changed(state);if(['boolean','select'].includes(spec.type))void save(state);});
    state.input.addEventListener('keydown',event=>{if(event.key==='Enter'&&spec.type!=='textarea'){event.preventDefault();void save(state);}});
   }
   state.input.setAttribute('aria-describedby',descriptionID+' '+feedbackID);
   const helpText=[spec.description,spec.help].filter(Boolean).map(t).join(' ')
    ||(spec.type==='number'?t('기본 {0} · 허용 {1}–{2}').replace('{0}',String(spec.default)).replace('{1}',spec.min??'∞').replace('{2}',spec.max??'∞')+(spec.step&&spec.step!==1&&spec.step!=='any'?' · '+t('{0} 단위').replace('{0}',String(spec.step)):'')
    :secret(spec)?t('비밀번호로 가려 표시합니다. 분류 기본값 복원으로 지워지지 않습니다.'):t('이 값은 해당 기능에 적용됩니다.'));
   const help=node('p',null,row,{id:descriptionID,class:'scs-help'});help.textContent=helpText;
   state.feedback=node('p','',row,{id:feedbackID,class:'scs-feedback',role:'status','aria-live':'polite'});states.set(spec.key,state);sync(state);
  }
  async function refreshStatus(){
   if(destroyed||statusPending)return;statusPending=true;
   try{const value=await runtime.getSettingsStatus?.();if(destroyed)return;
    if(!value){readTime.textContent='—';liveText.textContent='현재 동작 정보를 제공하지 않습니다.';return;}
    const seconds=typeof value.readSeconds==='number'&&Number.isFinite(value.readSeconds)&&value.readSeconds>=0?Math.floor(value.readSeconds):null;
    readTime.textContent=seconds===null?'—':(typeof runtime.formatReadTime==='function'?runtime.formatReadTime(seconds):seconds+'초');
    const parts=[value.version?t('버전 {0}').replace('{0}',value.version):null,t('읽기 기록 {0}').replace('{0}',t(value.recordReading?'켜짐':'꺼짐')),value.selectedTitle?t('선택: {0}').replace('{0}',value.selectedTitle):t('선택한 문헌 없음'),value.citationStatus?t('인용 조회: {0}').replace('{0}',t(value.citationStatus)):null,value.storagePath?t('저장 위치: {0}').replace('{0}',value.storagePath):null];
    liveText.replaceChildren();for(const part of parts.filter(Boolean))node('span',null,liveText,{class:'scs-live-part'}).textContent=part;
   }catch(error){if(!destroyed){readTime.textContent='—';liveText.textContent='현재 동작을 확인하지 못했습니다.';}}
   finally{statusPending=false;}
  }
  search.addEventListener('input',filter);clearSearch.addEventListener('click',()=>{search.value='';filter();search.focus();});
  {
   const heading=node('strong','먼저 할 것',first);node('p','비워 두어도 동작하지만, 채우면 인용 수·저널 정보·AI 기능이 열립니다.',first,{class:'scs-help'});
   const list=node('div',null,first,{class:'scs-first-list'}),rows=new Map();
   for(const key of FIRST){const state=states.get(key);if(!state)continue;const row=node('button',null,list,{type:'button','data-first':key});node('span',state.spec.label,row);node('span',state.spec.category==='ai'?'AI 요약·비교':key==='citationEmail'?'(선택) 빠른 대기열 · 주소가 서버에 남습니다':'없으면 인용 수 열이 비어 있습니다',row,{class:'scs-first-why'});row.addEventListener('click',()=>{selectCategory(state.spec.category);state.input.focus();});rows.set(key,row);}
   refreshFirst=()=>{if(destroyed)return;let open=0;for(const [key,row]of rows){const state=states.get(key);const blank=!String(valueOf(state)??'').trim();row.hidden=!blank;if(blank)open++;}first.hidden=!open;heading.textContent=t(open>1?'먼저 할 것':'아직 비어 있는 것');};
   refreshFirst();
  }
  nav.addEventListener('keydown',event=>{if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;const buttons=[...nav.querySelectorAll('button')],index=buttons.indexOf(doc.activeElement);if(index<0)return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:Math.max(0,Math.min(buttons.length-1,index+(event.key==='ArrowDown'?1:-1)));buttons[next].focus();selectCategory(buttons[next].dataset.category);});
  function destroy(){if(destroyed)return;destroyed=true;if(poll!==null)win.clearInterval(poll);observer?.disconnect();win.removeEventListener('unload',destroy);instances.delete(host);}
  async function loadValues(){
   await Promise.all([...states.values()].filter(state=>!state.pending&&!categories.get(state.spec.category)?.pending).map(state=>{state.loading=state.spec.type!=='action';sync(state);return hydrate(state);}));
   if(destroyed)return;filter();const errors=[...states.values()].filter(state=>state.error).length;notify(errors?errors+'개 설정을 읽지 못했습니다. 설정 다시 읽기로 재시도하세요.':'설정을 불러왔습니다.',errors>0);await refreshStatus();
  }
  const reload=node('button','설정 다시 읽기',heading,{type:'button'});reload.addEventListener('click',async()=>{if(reload.disabled||destroyed)return;reload.disabled=true;try{await loadValues();}finally{reload.disabled=false;}});
  const ready=loadValues();
  const controller={ready,destroy,refreshStatus,selectCategory};instances.set(host,controller);
  win.addEventListener('unload',destroy,{once:true});poll=win.setInterval(()=>{if(!destroyed&&host.isConnected&&!doc.hidden)void refreshStatus();},1000);
  if(win.MutationObserver){observer=new win.MutationObserver(()=>{if(!host.isConnected)destroy();});observer.observe(doc,{childList:true,subtree:true});}
  filter();return controller;
 }
 async function init(input){const doc=input?.nodeType===9?input:input?.target?.ownerDocument||input?.ownerDocument||root.document;const runtime=doc.defaultView?.Zotero?.StyleCustom||root.Zotero?.StyleCustom;
  try{const controller=mount({document:doc,runtime});await controller.ready;return controller;}catch(error){const host=doc?.getElementById('style-custom-settings-root');if(host){host.replaceChildren();const message=doc.createElementNS(HTML,'p');message.textContent='설정을 열지 못했습니다: '+(error.message||error);message.setAttribute('role','alert');host.appendChild(message);}throw error;}
 }
 const api={mount,init};root.CustomStyleSettings=api;if(root.document?.defaultView)root.document.defaultView.CustomStyleSettings=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);

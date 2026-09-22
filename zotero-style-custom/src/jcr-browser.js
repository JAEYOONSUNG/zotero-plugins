/* Native JCR groups → categories → captured journal membership.
   The catalog owns validation. This view never manufactures source totals,
   category membership, ranks or quartiles from another classification. */
(function(root){
 'use strict';
 const HTML='http://www.w3.org/1999/xhtml';
 const DEFAULT_ORDER={groups:['name','asc'],categories:['journalCount','desc'],journals:['jif','desc']};
 let sequence=0;
 /* What a row can be found by.

    The captured JCR rows carry no abbreviation at all — the field is empty on
    every one of the twenty-two thousand — so a reader typing "nat commun",
    "J Biol Chem" or "PNAS" found nothing. The abbreviation is derived here
    from the plugin's own journal identity table, the ISSNs go in with and
    without their hyphen, and the whole thing is folded the way the panel's
    other search boxes fold. Building it is not free at this size, so each row
    keeps its index for as long as the catalog object lives. */
 const DASHES=/[\u2010-\u2015\u2212]/g;
 const fold=value=>String(value==null?'':value).normalize('NFKD').replace(/\p{M}+/gu,'').normalize('NFC').toLowerCase().replace(DASHES,'-');
 const issnKey=value=>String(value==null?'':value).replace(/[^0-9xX]/g,'').toUpperCase();
 const INDEX=new WeakMap();
 function abbreviationsFor(row,identity){
  const title=String(row.title||row.name||''),found=[];
  if(row.abbreviation)found.push(String(row.abbreviation));
  if(identity&&title){
   try{const derived=identity.abbreviate&&identity.abbreviate(title);if(derived)found.push(String(derived));}catch(_){}
   const table=identity.ABBREVIATIONS;
   if(table)for(const key of [title,title.replace(/^The\s+/i,'')]){const value=table[key];if(value)found.push(String(value));}
  }
  return [...new Set(found)];
 }
 function indexFor(row,identity){
  let entry=INDEX.get(row);
  if(entry)return entry;
  const issns=(row.issns||[]).map(String),abbreviations=abbreviationsFor(row,identity);
  entry={name:fold(row.name||row.title||''),abbreviations:abbreviations.map(fold),issnKeys:issns.map(issnKey).filter(key=>key.length===8),
   text:fold([row.name,row.title,...abbreviations,...issns,...issns.map(issn=>issn.replace(/-/g,'')),
    ...(row.groupKeys||[]),...(row.categoryKeys||[])].filter(Boolean).join(' '))};
  INDEX.set(row,entry);return entry;
 }
 function mount(host,options={}){
  if(!host?.ownerDocument)throw new TypeError('JCR browser requires a DOM host');
  let catalog=options.catalog;
  const validCatalog=value=>value&&value.source&&Array.isArray(value.groups)&&Array.isArray(value.categories)&&Array.isArray(value.journals)
   &&['group','category','categoriesForGroup','journalsForCategory'].every(k=>typeof value[k]==='function');
  if(!validCatalog(catalog))throw new TypeError('JCR browser requires a validated category catalog');
  const doc=host.ownerDocument,t=typeof options.t==='function'?options.t:value=>value;
  const id='sc-jcr-'+(++sequence),initial=options.initialState||{};
  const initialView=['groups','categories','journals'].includes(initial.view)?initial.view:'groups';
  let destroyed=false,message='';
  const state={view:initialView,
   categoryKey:initial.categoryKey||null,expandedGroupKeys:new Set(Array.isArray(initial.expandedGroupKeys)?initial.expandedGroupKeys.filter(key=>catalog.group(key)):[]),
   query:typeof initial.query==='string'?initial.query:'',sortKey:initial.sortKey||DEFAULT_ORDER[initialView][0],sortDir:['asc','desc'].includes(initial.sortDir)?initial.sortDir:DEFAULT_ORDER[initialView][1],
   page:Number.isInteger(initial.page)&&initial.page>=0?initial.page:0,
   pageSize:Number.isInteger(initial.pageSize||options.pageSize)?Math.min(200,Math.max(1,initial.pageSize||options.pageSize)):25,
   history:Array.isArray(initial.history)?initial.history.filter(frame=>frame&&['groups','categories','journals'].includes(frame.view)).slice(-20).map(frame=>({
    view:frame.view,categoryKey:frame.categoryKey||null,query:typeof frame.query==='string'?frame.query:'',sortKey:frame.sortKey||DEFAULT_ORDER[frame.view][0],
    sortDir:['asc','desc'].includes(frame.sortDir)?frame.sortDir:DEFAULT_ORDER[frame.view][1],page:Number.isInteger(frame.page)&&frame.page>=0?frame.page:0})):[]};
  const element=doc.createElementNS(HTML,'section');element.classList.add('sc-jcr-browser');element.setAttribute('aria-label',t('JCR 카테고리 탐색'));host.appendChild(element);
  function snapshot(){return {...state,expandedGroupKeys:[...state.expandedGroupKeys],history:state.history.map(frame=>({...frame}))};}
  function emit(){invoke(options.onStateChange,snapshot());}
  function el(tag,text,parent,attrs={}){
   const node=doc.createElementNS(HTML,tag);
   if(text!=null)node.textContent=String(text);
   for(const[key,value]of Object.entries(attrs))if(value!=null)node.setAttribute(key,String(value));
   parent?.appendChild(node);return node;
  }
  function invoke(callback,...args){
   if(typeof callback!=='function'||destroyed)return;
   try{Promise.resolve(callback(...args)).catch(error=>failed(error));}catch(error){failed(error);}
  }
  function failed(error){
   if(destroyed)return;
   const messages=options.errorMessages,code=error?.code;
   const knownMessage=typeof code==='string'&&messages&&Object.prototype.hasOwnProperty.call(messages,code)?messages[code]:null;
   message=t(typeof knownMessage==='string'?knownMessage:'요청을 완료하지 못했습니다. 다시 시도하세요.');render();
   if(typeof options.onError==='function')try{options.onError(error);}catch(_){}
  }
  function button(text,parent,action,attrs={}){
   const node=el('button',text,parent,{type:'button',class:'sc-jcr-button',...attrs});
   node.addEventListener('click',()=>{if(!destroyed)action(node);});return node;
  }
  function metric(value){return typeof value==='number'&&Number.isFinite(value)?value.toLocaleString():value==null||value===''?'—':String(value);}
  /* JCR prints its categories in capitals. Two hundred and fifty lines of
     capitals is a wall; the same names in title case read as names. The key
     and the original spelling stay on the element for anything that matches
     against them. Short tokens that are initialisms stay as they are. */
  const KEEP=new Set(['&','AND','OF','IN','ON','THE','FOR','TO']);
  function displayName(name){
   const text=String(name||'');if(text!==text.toUpperCase()||!/[A-Z]{2}/.test(text))return text;
   return text.split(' ').map((word,index)=>{
    if(word==='&')return word;if(/^[A-Z]{1,3}$/.test(word)&&index>0&&!KEEP.has(word))return word;
    return word.split(/([-\/,])/).map(part=>/^[-\/,]$/.test(part)?part:part.charAt(0)+part.slice(1).toLowerCase()).join('').replace(/^(and|of|in|on|the|for|to)$/i,m=>index?m.toLowerCase():m);
   }).join(' ');
  }
  function pills(parent,values,cls){const list=el('ul',null,parent,{class:'sc-jcr-pills '+cls});for(const value of values)el('li',value,list,{class:'sc-jcr-pill'});return list;}
  function bar(cell,value,max){if(!(typeof value==='number'&&max>0))return;const fill=el('span',null,cell,{class:'sc-jcr-bar','aria-hidden':'true'});fill.style.setProperty('--sc-jcr-fill',Math.max(2,Math.round(value/max*100))+'%');cell.classList.add('sc-jcr-has-bar');}
  function tone(value){return typeof value!=='number'?'':value>=5?'top':value>=2.5?'high':value>=1?'mid':'low';}
  function date(value){return typeof value==='string'&&value?(/^\d{4}-\d{2}-\d{2}/.test(value)?value.slice(0,10):value):'—';}
  function route(){return {view:state.view,categoryKey:state.categoryKey,query:state.query,sortKey:state.sortKey,sortDir:state.sortDir,page:state.page};}
  function navigate(view,categoryKey=null){
   if(view==='journals'&&!catalog.category(categoryKey))return;
   state.history.push(route());if(state.history.length>20)state.history.shift();
   Object.assign(state,{view,categoryKey,query:'',sortKey:DEFAULT_ORDER[view][0],sortDir:DEFAULT_ORDER[view][1],page:0});
   message='';render();emit();
  }
  function back(){
   const previous=state.history.pop();
   if(previous)Object.assign(state,previous);else Object.assign(state,{view:'groups',categoryKey:null,query:'',page:0,sortKey:'name',sortDir:'asc'});
   message='';render();emit();
  }
  function openSource(){invoke(options.onOpenSource,catalog.source.url,{view:state.view,categoryKey:state.categoryKey});}
  const identity=()=>options.identity||root.CustomStyleJournalIdentity||null;
  function textFor(row){return indexFor(row,identity()).text;}
  /* A query typed in full is an ISSN when what is left after dropping the
     punctuation is the eight characters an ISSN has. */
  function hits(row,query){
   if(!query)return true;
   if(textFor(row).includes(query))return true;
   const key=issnKey(query);
   return key.length===8&&indexFor(row,identity()).issnKeys.includes(key);
  }
  /* Searching "multidisciplinary" used to put Agricultural Sciences on top,
     because the word sits in one of its member categories. A row found by its
     own name comes before a row found only through what it contains. */
  function tier(row,query){
   if(!query)return 0;
   const entry=indexFor(row,identity());
   if(entry.name===query||entry.abbreviations.includes(query))return 0;
   if(entry.name.includes(query))return 1;
   const key=issnKey(query);
   if(entry.abbreviations.some(value=>value.includes(query))||entry.issnKeys.some(value=>value.includes(key)&&key.length>=4))return 2;
   return 3;
  }
  function sorted(rows){
   const query=fold(state.query.trim()),direction=state.sortDir==='desc'?-1:1;
   const order=(a,b)=>{
    if(state.sortKey==='name')return direction*String(a.name||a.title||'').localeCompare(String(b.name||b.title||''));
    const x=a[state.sortKey],y=b[state.sortKey],knownX=typeof x==='number'&&Number.isFinite(x),knownY=typeof y==='number'&&Number.isFinite(y);
    if(knownX!==knownY)return knownX?-1:1;
    return (knownX?direction*(x-y):0)||String(a.name||a.title||'').localeCompare(String(b.name||b.title||''));
   };
   const found=rows.filter(row=>hits(row,query)).slice();
   return query?found.sort((a,b)=>tier(a,query)-tier(b,query)||order(a,b)):found.sort(order);
  }
  /* A journal name typed on the groups or categories view used to find
     nothing: those views hold groups and categories only. When they have
     nothing to show, the catalog's journals answer instead, in the same table
     the category view uses, so the journal is one press away. */
  function journalMatches(){
   const query=fold(state.query.trim());
   if(!query)return [];
   return catalog.journals.filter(row=>hits(row,query))
    .sort((a,b)=>tier(a,query)-tier(b,query)||String(a.title||'').localeCompare(String(b.title||''))).slice(0,200);
  }
  function journalFallback(parent){
   const found=journalMatches();
   if(!found.length)return false;
   el('p',`${t('검색에 맞는 저널')} ${found.length.toLocaleString()}`,parent,{class:'sc-jcr-coverage',role:'status'});
   const headings=[['title','저널'],['categories','JCR 카테고리'],['issns','ISSN'],['jif','JIF'],['year','지표 연도']];
   if(typeof options.onSearchJournal==='function')headings.push(['action','검색']);
   const body=table(parent,headings,'검색된 저널 표');
   for(const journal of found){
    const row=el('tr',null,body,{'data-journal-key':journal.key,'data-found-by':'journal-search'});
    const name=el('td',null,row);
    el('span',journal.title,name,{class:'sc-jcr-journal-title'});
    const abbreviation=journal.abbreviation||abbreviationsFor(journal,identity())[0]||'';
    if(abbreviation)el('span',abbreviation,name,{class:'sc-jcr-abbreviation'});
    const memberships=el('ul',null,el('td',null,row),{class:'sc-jcr-memberships'});
    for(const key of journal.categoryKeys||[]){
     const item=el('li',null,memberships);
     const label=catalog.category(key)?.name||key;
     if(catalog.category(key))button(displayName(label),item,()=>navigate('journals',key),{class:'sc-jcr-category-link','data-category-key':key,title:label});
     else el('span',displayName(label),item);
    }
    el('td',journal.issns?.length?journal.issns.join(' · '):'—',row,{'data-column':'issns'});
    el('td',metric(journal.jifDisplay??journal.jif),row,{'data-column':'jif',class:'sc-jcr-number'});
    el('td',journal.year??'—',row,{'data-column':'year',class:'sc-jcr-number'});
    if(typeof options.onSearchJournal==='function')
     button(t(options.searchJournalLabel||'저널 검색'),el('td',null,row),()=>invoke(options.onSearchJournal,journal,{categoryKey:(journal.categoryKeys||[])[0]||null}),{'data-opens':'window'});
   }
   return true;
  }
  function controls(parent){
   const toolbar=el('div',null,parent,{class:'sc-jcr-controls'});
   const input=el('input',null,toolbar,{type:'search',class:'sc-jcr-search','data-focus-key':'search',
    'aria-label':t(state.view==='journals'?'카테고리 안에서 저널 검색':'그룹·카테고리·저널 검색'),placeholder:t(state.view==='journals'?'저널명·약어·ISSN 검색':'그룹·카테고리 이름 또는 저널명·약어·ISSN')});
   input.value=state.query;
   input.addEventListener('input',()=>{if(destroyed)return;state.query=input.value;state.page=0;render();emit();});
   const label=el('label',t('정렬'),toolbar,{class:'sc-jcr-sort-label',for:id+'-sort'});
   const select=el('select',null,label,{id:id+'-sort','aria-label':t('JCR 목록 정렬'),'data-focus-key':'sort',
    title:t('숫자 정렬에서 범위값과 미확인 값은 마지막에 표시합니다.')});
   const choices=state.view==='groups'?[['name',t('이름')],['categoryCount',t('카테고리 수')],['journalCount',t('저널 수')],['citableItems',t('인용 가능 항목')]]
    :state.view==='categories'?[['name',t('이름')],['journalCount',t('저널 수')],['citableItems',t('인용 가능 항목')],['totalCitations',t('총 인용')],['medianJIF',t('JIF 중앙값')]]
     :[['name',t('저널명')],['jif','JIF'],['year',t('지표 연도')]];
   if(!choices.some(([key])=>key===state.sortKey))state.sortKey=choices[0][0];
   for(const[key,name]of choices)el('option',name,select,{value:key,...(key===state.sortKey?{selected:'selected'}:{})});
   select.value=state.sortKey;
   select.addEventListener('change',()=>{if(destroyed)return;state.sortKey=select.value;state.page=0;render();emit();});
   button(t(state.sortDir==='asc'?'오름차순':'내림차순'),toolbar,()=>{state.sortDir=state.sortDir==='asc'?'desc':'asc';state.page=0;render();emit();},
    {'aria-label':t('정렬 방향 바꾸기'),'data-focus-key':'direction'});
  }
  function sourceStamp(parent){
   const source=catalog.source||{};
   el('p',[source.provider,source.product,source.releaseYear||'',source.metricYear?`${t('지표 연도')} ${source.metricYear}`:'',
    `${t('원본 갱신')} ${date(source.datasetUpdated)}`,`${t('수집')} ${date(source.capturedAt)}`].filter(Boolean).join(' · '),parent,{class:'sc-jcr-source'});
  }
  function stats(parent,values){
   const list=el('dl',null,parent,{class:'sc-jcr-stats'});
   for(const[label,value]of values){const item=el('div',null,list);el('dt',t(label),item);el('dd',metric(value),item);}
  }
  function groups(parent){
   controls(parent);
   const rows=sorted(catalog.groups);
   const headings=el('div',null,parent,{class:'sc-jcr-group-head','aria-hidden':'true'});
   for(const heading of ['그룹','카테고리 수','저널 수','인용 가능 항목',''])el('span',t(heading),headings);
   if(!rows.length){if(journalFallback(parent))return;el('p',t('검색에 맞는 그룹이 없습니다.'),parent,{class:'sc-jcr-empty',role:'status'});return;}
   for(const group of rows){
    const section=el('section',null,parent,{class:'sc-jcr-group','data-group-key':group.key});
    const groupId=id+'-group-'+catalog.groups.indexOf(group),isOpen=state.expandedGroupKeys.has(group.key);
    const toggle=button('',section,()=>{
     isOpen?state.expandedGroupKeys.delete(group.key):state.expandedGroupKeys.add(group.key);render();emit();
    },{id:groupId,class:'sc-jcr-group-toggle','aria-expanded':String(isOpen),'aria-controls':groupId+'-content','data-focus-key':'group:'+group.key,
     'aria-label':[group.name,`${t('카테고리 수')} ${metric(group.categoryCount)}`,`${t('저널 수')} ${metric(group.journalCount)}`,`${t('인용 가능 항목')} ${metric(group.citableItems)}`].join(' · ')});
    el('span',group.name,toggle,{class:'sc-jcr-group-name'});
    for(const[label,key]of [['카테고리 수','categoryCount'],['저널 수','journalCount'],['인용 가능 항목','citableItems']])
     el('span',metric(group[key]),toggle,{class:'sc-jcr-group-metric','data-label':t(label),title:group[key]==null?t('원본에서 수집하지 않은 값'):t(label)});
    el('span',isOpen?'−':'+',toggle,{class:'sc-jcr-chevron','aria-hidden':'true'});
    if(isOpen){
     const panel=el('div',null,section,{id:groupId+'-content',class:'sc-jcr-group-content',role:'region','aria-labelledby':groupId});
     const members=catalog.categoriesForGroup(group.key).slice().sort((a,b)=>a.name.localeCompare(b.name));
     if(!members.length)el('p',t('이 그룹의 카테고리 목록은 아직 수집되지 않았습니다.'),panel,{class:'sc-jcr-empty'});
     else{
      const list=el('ul',null,panel,{class:'sc-jcr-category-links'});
      for(const category of members){const li=el('li',null,list);button(displayName(category.name),li,()=>navigate('journals',category.key),
       {class:'sc-jcr-category-link','data-category-key':category.key,title:category.name});}
     }
    }
   }
  }
  function table(parent,headings,label){
   const wrap=el('div',null,parent,{class:'sc-jcr-table-wrap',role:'region','aria-label':t(label),tabindex:'0'});
   const grid=el('table',null,wrap,{class:'sc-jcr-table'}),head=el('thead',null,grid),tr=el('tr',null,head);
   for(const[key,name]of headings)el('th',t(name),tr,{scope:'col','data-column':key});
   return el('tbody',null,grid);
  }
  function page(rows,parent){
   const pages=Math.max(1,Math.ceil(rows.length/state.pageSize));state.page=Math.min(state.page,pages-1);
   const start=state.page*state.pageSize,shown=rows.slice(start,start+state.pageSize);
   const bar=el('div',null,parent,{class:'sc-jcr-pagination'});
   el('span',rows.length?`${start+1}–${start+shown.length} / ${rows.length.toLocaleString()}`:`${t('표시 결과')} 0`,bar,{role:'status'});
   const sizes=[...new Set([25,50,75,100,200,state.pageSize])].sort((a,b)=>a-b);
   const label=el('label',t('페이지당'),bar,{class:'sc-jcr-page-size',for:id+'-page-size'});
   const size=el('select',null,label,{id:id+'-page-size','aria-label':t('페이지당 표시 수'),'data-focus-key':'page-size'});
   for(const count of sizes)el('option',String(count),size,{value:count,...(count===state.pageSize?{selected:'selected'}:{})});
   size.value=String(state.pageSize);
   size.addEventListener('change',()=>{if(destroyed)return;const count=Number(size.value);if(!sizes.includes(count))return;state.pageSize=count;state.page=0;render();emit();});
   if(pages>1){
    const previous=button(t('이전'),bar,()=>{state.page--;render();emit();},{'data-focus-key':'previous'});previous.disabled=state.page===0;
    const next=button(t('다음'),bar,()=>{state.page++;render();emit();},{'data-focus-key':'next'});next.disabled=state.page+1>=pages;
   }
   return shown;
  }
  function categories(parent){
   controls(parent);const rows=sorted(catalog.categories);
   if(!rows.length&&journalFallback(parent))return;
   const shown=page(rows,parent);
   if(!rows.length){el('p',t('검색에 맞는 카테고리가 없습니다.'),parent,{class:'sc-jcr-empty'});return;}
   const body=table(parent,[['name','카테고리'],['groups','그룹'],['editions','색인'],['journalCount','저널 수'],
    ['citableItems','인용 가능 항목'],['totalCitations','총 인용'],['medianJIF','JIF 중앙값']],'JCR 카테고리 표');
   const most=Math.max(0,...rows.map(c=>typeof c.journalCount==='number'?c.journalCount:0));
   for(const category of shown){
    const row=el('tr',null,body,{'data-category-key':category.key}),name=el('td',null,row,{'data-column':'name'});
    button(displayName(category.name),name,()=>navigate('journals',category.key),{class:'sc-jcr-category-link',title:category.name});
    const groupCell=el('td',null,row,{'data-column':'groups'}),list=el('ul',null,groupCell,{class:'sc-jcr-memberships'});
    for(const key of category.groupKeys)el('li',catalog.group(key)?.name||key,list);
    if(!category.groupKeys.length)groupCell.textContent='—';
    const editions=el('td',null,row,{'data-column':'editions'});
    if(category.editions?.length)pills(editions,category.editions,'sc-jcr-editions');else editions.textContent='—';
    for(const key of ['journalCount','citableItems','totalCitations','medianJIF']){
     const cell=el('td',null,row,{'data-column':key,class:'sc-jcr-number'});
     el('span',metric(category[key+'Display']??category[key]),cell,{class:'sc-jcr-figure'});
     if(key==='journalCount')bar(cell,category.journalCount,most);
     if(key==='medianJIF'&&tone(category.medianJIF))cell.dataset.tone=tone(category.medianJIF);
    }
   }
  }
  function journals(parent){
   const category=catalog.category(state.categoryKey);
   if(!category){el('p',t('이 카테고리를 수집 자료에서 찾을 수 없습니다.'),parent,{class:'sc-jcr-empty'});return;}
   const context=el('div',null,parent,{class:'sc-jcr-category-context'});
   pills(context,category.groupKeys.map(key=>catalog.group(key)?.name||key),'sc-jcr-parents');
   stats(context,[['JCR 저널 수',category.journalCount],['인용 가능 항목',category.citableItems],['총 인용',category.totalCitations],['JIF 중앙값',category.medianJIFDisplay??category.medianJIF]]);
   const captured=catalog.journalsForCategory(category.key);
   el('p',`${t('수집된 저널')} ${captured.length.toLocaleString()}${category.journalCount!=null?' / '+metric(category.journalCount):''}`+
    (catalog.source.complete?.journals===true?'':' · '+t('전체 저널 목록 수집 미완료')),parent,{class:'sc-jcr-coverage',role:'status'});
   if(!captured.length){
    el('p',t(catalog.source.complete?.journals===true?'이 카테고리에 표시할 저널이 없습니다.':'이 카테고리의 저널 목록은 아직 수집되지 않았습니다.'),parent,{class:'sc-jcr-empty'});
    if(typeof options.onOpenSource==='function')button(t('JCR 원본에서 저널 확인'),parent,openSource,{'data-opens':'external'});
    return;
   }
   controls(parent);const found=sorted(captured),shown=page(found,parent);
   if(!found.length){el('p',t('검색에 맞는 저널이 없습니다.'),parent,{class:'sc-jcr-empty'});return;}
   const headings=[['title','저널'],['categories','JCR 카테고리'],['issns','ISSN'],['jif','JIF'],['rank','JIF 순위'],['quartile','JIF Q'],['percentile','JIF 백분위'],['year','지표 연도']];
   if(typeof options.onSearchJournal==='function')headings.push(['action','검색']);
   const body=table(parent,headings,'JCR 카테고리의 저널 표');
   for(const journal of shown){
    const row=el('tr',null,body,{'data-journal-key':journal.key}),name=el('td',null,row);
    el('span',journal.title,name,{class:'sc-jcr-journal-title'});
    if(journal.abbreviation)el('span',journal.abbreviation,name,{class:'sc-jcr-abbreviation'});
    const memberships=el('ul',null,el('td',null,row),{class:'sc-jcr-memberships'});
    for(const key of journal.categoryKeys)el('li',displayName(catalog.category(key)?.name||key),memberships,{title:catalog.category(key)?.name||key});
    el('td',journal.issns?.length?journal.issns.join(' · '):'—',row,{'data-column':'issns'});
    el('td',metric(journal.jifDisplay??journal.jif),row,{'data-column':'jif',class:'sc-jcr-number'});
    const official=(journal.categoryMetrics||[]).filter(m=>m.categoryKey===category.key);
    for(const key of ['rank','quartile','percentile']){
     const cell=el('td',null,row,{'data-column':key,class:'sc-jcr-number'});
     if(!official.length){cell.textContent='—';continue;}
     const values=el('ul',null,cell,{class:'sc-jcr-memberships'});
     for(const value of official){
      const display=value[key+'Display']??(key==='rank'&&value.rank!=null&&value.rankTotal!=null?`${metric(value.rank)}/${metric(value.rankTotal)}`
       :key==='quartile'&&value.quartile!=null?'Q'+value.quartile:metric(value[key]));
      const editions=(value.editions||[]).join(' · ');
      el('li',(official.length>1&&editions?editions+': ':'')+display,values,{title:category.name+(editions?' · '+editions:'')});
     }
    }
    el('td',journal.year??'—',row,{'data-column':'year',class:'sc-jcr-number'});
    if(typeof options.onSearchJournal==='function')button(t(options.searchJournalLabel||'저널 검색'),el('td',null,row),()=>invoke(options.onSearchJournal,journal,{categoryKey:category.key}),{'data-opens':'window'});
   }
  }
  function render(){
   if(destroyed)return;
   const focused=doc.activeElement,focusKey=element.contains(focused)?focused?.getAttribute('data-focus-key'):null;
   const selection=focusKey==='search'?[focused.selectionStart,focused.selectionEnd]:null;
   if(state.view==='journals'&&!catalog.category(state.categoryKey))Object.assign(state,{view:'groups',categoryKey:null,page:0,history:[]});
   element.replaceChildren();
   const header=el('header',null,element,{class:'sc-jcr-header'}),title=state.view==='groups'?t('카테고리 그룹'):state.view==='categories'?t(catalog.source.complete?.categories===true?'전체 카테고리':'수집된 카테고리'):displayName(catalog.category(state.categoryKey).name);
   const top=el('div',null,header,{class:'sc-jcr-heading'});
   el('h2',title,top);
   if(state.view!=='groups'||state.history.length)button(t('뒤로'),top,back,{class:'sc-jcr-button sc-jcr-back'});
   sourceStamp(header);
   const navigation=el('div',null,header,{class:'sc-jcr-navigation'});
   if(state.view!=='groups')button(`${t('그룹 보기')} · ${catalog.groups.length}`,navigation,()=>navigate('groups'));
   if(state.view!=='categories')button(`${t(catalog.source.complete?.categories===true?'전체 카테고리':'수집된 카테고리')} · ${catalog.categories.length}`,navigation,()=>navigate('categories'));
   if(typeof options.onOpenSource==='function')button(t('JCR 원본 열기'),navigation,openSource,{'data-opens':'external'});
   if(typeof options.onOpenAlex==='function')button(t('OpenAlex 주제로 탐색'),navigation,()=>invoke(options.onOpenAlex,state.categoryKey?{categoryKey:state.categoryKey,name:displayName(catalog.category(state.categoryKey)?.name||'')}:null));
   if(catalog.source.complete?.groups!==true||catalog.source.complete?.categories!==true)
    el('p',t('그룹 또는 카테고리 목록이 일부만 수집되어 있습니다.'),header,{class:'sc-jcr-coverage'});
   if(message)el('p',message,element,{class:'sc-jcr-error',role:'alert'});
   const content=el('div',null,element,{class:'sc-jcr-content'});
   ({groups,categories,journals})[state.view](content);
   if(focusKey){
    const replacement=[...element.querySelectorAll('[data-focus-key]')].find(node=>node.getAttribute('data-focus-key')===focusKey);
    replacement?.focus?.();
    if(selection&&replacement?.setSelectionRange)try{replacement.setSelectionRange(...selection);}catch(_){}
   }
  }
  render();
  return {get state(){return snapshot();},element,render,
   updateCatalog(value){if(destroyed)return;if(!validCatalog(value))throw new TypeError('Invalid JCR category catalog');catalog=value;
    state.expandedGroupKeys=new Set([...state.expandedGroupKeys].filter(key=>catalog.group(key)));render();emit();},
   destroy(){if(destroyed)return;destroyed=true;element.remove();}};
 }
 const api={mount};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;
 root.CustomStyleJCRBrowser=api;
})(typeof globalThis!=='undefined'?globalThis:this);

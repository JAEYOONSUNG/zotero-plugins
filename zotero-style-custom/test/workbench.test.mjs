import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseHTML} from 'linkedom';
import Workbench from '../src/workbench.js';
import Model from '../src/workspace.js';
import JournalIdentity from '../src/journal-identity.js';
import JCRCategories from '../src/jcr-categories.js';
import JCRBrowser from '../src/jcr-browser.js';
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
// toolbar: the ids and element names already in the items toolbar, in order, so
// a test can check where the button is placed among them.
function fixture(initialCache,toolbar,{nativeJCR=false,catalog}={}){
 const {window:win,document:doc}=parseHTML('<html><head></head><body><div id="zotero-items-toolbar"></div></body></html>');
 if(toolbar){
  const bar=doc.getElementById('zotero-items-toolbar');
  for(const [id,name] of toolbar){
   const child=doc.createElement(name);
   if(id)child.id=id;
   Object.defineProperty(child,'localName',{value:name});
   bar.appendChild(child);
  }
 }
 doc.createXULElement=tag=>{const el=doc.createElement(tag);Object.defineProperty(el,'localName',{value:tag});return el;};
 // linkedom intentionally has only a select getter; Gecko supplies both.
 Object.defineProperty(win.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this._value??this.querySelector('option')?.getAttribute('value')??'';},set(value){this._value=String(value);}});
 Object.defineProperty(doc,'activeElement',{configurable:true,get(){return this._focusedElement||this.body;}});
 win.HTMLElement.prototype.focus=function(){this.ownerDocument._focusedElement=this;};
 const calls=[],errors=[],cache=initialCache||{items:{},readerSettings:{marginAnnotations:true}},refs=new Map([[1,{id:1}],[2,{id:2}],[9,{id:9}]]);
 // Existing subject-browser tests intentionally select the optional OpenAlex
 // view. Native default behavior is exercised with nativeJCR:true below.
 if(!nativeJCR&&cache.workbenchUI?.journalBrowser===undefined)cache.workbenchUI={...(cache.workbenchUI||{}),journalBrowser:'openalex'};
 const papers=[{id:'1',key:'K1',libraryID:1,title:'Paper Alpha',authors:'Ada Lovelace',year:'2025',venue:'Science',doi:'10.1234/a',itemType:'journalArticle',tags:['topic/a'],abstract:'An abstract',related:['2']},{id:'2',key:'K2',libraryID:1,title:'Paper Beta',authors:'Ada Lovelace',year:'2024',venue:'Nature',itemType:'journalArticle',tags:['topic/b'],abstract:'Other abstract',related:['1']}];
 let libraryID=1,mainSelection=[refs.get(1)],notify;
 win.ZoteroPane={getSelectedLibraryID:()=>libraryID,collectionsView:{selectCollection:id=>calls.push(['collection',id])}};
 const record=(name,result)=>async(...args)=>{calls.push([name,...args]);return typeof result==='function'?result(...args):result;};
 const runtime={rootURI:'file:///plugin/',cache,dirty:false,selected:()=>mainSelection,pref:(key,fallback)=>fallback,entry:ref=>cache.items[ref.id]||=( {}),state:()=>({citations:3,impactFactor:4,status:'reading'}),flush:record('flush'),refreshWindows:record('refresh'),publicationTags:()=>['Q1'],refreshJournalMetrics:record('journal',{updated:1,failed:0,unknown:0}),setPanelCSS:record('css'),toggleAppTheme:record('appTheme'),setCustomFields:record('customFields'),refreshPublicationRanks:record('ranks'),pageProgress:()=>({pages:{0:2,550:7},total:601,visited:2,percent:0,attachmentID:'99'})};
 runtime.jcrBrowser=JCRBrowser;
 if(nativeJCR)runtime.jcrCatalog=catalog===null?null:catalog||JCRCategories.create(JSON.parse(fs.readFileSync(new URL('../data/jcr-categories.json',import.meta.url),'utf8')));
 // Discovery goes out to OpenAlex; the panel only needs the shapes it returns.
 let watched=[];
 const suggestion=(id,source)=>({id,source,title:'Paper '+id,year:2024,venue:'Journal',citations:5,
  authors:['A Author','B Author'],doi:'10.1/'+id,pdfURL:'https://x/'+id+'.pdf',relevance:3,inLibrary:false});
 Object.assign(runtime,{
  identity:ref=>'key-'+ref.id,
  discoverCache:new Map(),
  discoverTools:{GROUPS:['citing','reference','related'],shortID:v=>String(v).toUpperCase()},
  relatedWorksCached:record('related',{work:{id:'W1',title:'Source'},
   suggestions:[suggestion('W5','citing'),suggestion('W7','reference')]}),
  authorsOfCached:record('authorsOf',[{id:'A1',name:'A Author',institution:'Somewhere',position:'first'},
   {id:'A2',name:'B Author',institution:'Elsewhere',position:'last'}]),
  authorActivityCached:record('authorActivity',{profile:{name:'A Author',hIndex:20,works:50,citations:900,
   institutions:['Somewhere'],topics:[{name:'A topic',count:9}],orcid:'https://orcid.org/1'},
   works:[suggestion('W9','citing')]}),
  watchedAuthors:()=>watched,
  coauthorsOf:(id,works)=>[{id:'A7',name:'Sam Okafor',institution:'MIT',papers:3,last:2026,titles:['A shared paper']},
   {id:'A8',name:'Kim Nguyen',institution:'',papers:1,last:2024,titles:[]}],
  portraitOf:()=>null,
  fetchPortrait:async()=>null,
  // The panel sorts by news; the real runtime owns that order, so the fake
  // delegates to it rather than inventing a second one that could disagree.
  watchedAuthorsByNews:()=>watched.slice().sort((a,b)=>(b.news?.length||0)-(a.news?.length||0)),
  sweepWatchedAuthors:record('sweep',{authors:watched.length,withNews:0,works:0,requests:1,budgetGone:false,remaining:0}),
  clearAuthorNews:record('clearNews',id=>{const row=watched.find(r=>r.id===id);if(row)row.news=[];return true;}),
  watchAuthor:record('watchAuthor',person=>{watched.push({id:person.id,name:person.name,seen:person.seen||[]});}),
  unwatchAuthor:record('unwatchAuthor',id=>{watched=watched.filter(row=>row.id!==id);}),
  markAuthorSeen:record('markSeen',true),
  authorUpdates:record('authorUpdates',id=>({
   profile:{name:'A Author',hIndex:20,works:50,citations:900,institutions:['Somewhere'],
    topics:[{name:'A topic',count:9}],orcid:'https://orcid.org/1'},
   works:[suggestion('W9','citing')],
   fresh:watched.some(row=>row.id===id)?[suggestion('W11','citing')]:[],
   watching:watched.some(row=>row.id===id),checkedAt:'2026-09-17T00:00:00Z'})),
  importWork:record('importWork',[{getField:()=>'Imported paper'}])
 });
 runtime.Z={Items:{get:id=>refs.get(id),getAsync:async id=>refs.get(id)||{id}},Libraries:{userLibraryID:1},Prefs:{set:(...a)=>calls.push(['pref',...a])},Utilities:{Internal:{copyTextToClipboard:text=>calls.push(['copy',text])}},Notifier:{registerObserver:observer=>{notify=observer.notify;return 42;},unregisterObserver:id=>calls.push(['unregister',id])},logError:error=>errors.push(error)};
 const library={trashItems:record('trashItems',async ids=>ids.length),snapshot:record('snapshot',()=>papers),graph:rows=>({nodes:rows.map(i=>({id:i.id,label:i.title})),edges:[]}),tagTree:()=>[{name:'topic',path:'topic',count:2,children:[]}],notes:record('notes',[{id:'9',title:'Rich note',text:'<script>literal note</script>',modified:'today',html:'<b>unsafe raw HTML</b>'}]),annotations:record('annotations',[{id:'3',key:'K3',parentID:'1',attachmentID:'99',text:'Highlight',comment:'Comment',color:'#ffd400',type:'highlight',pageLabel:'1',pageIndex:0}]),backlinks:record('backlinks',[{id:'2',title:'Paper Beta',kind:'related'}]),attachments:record('attachments',[{id:'99',parentID:'1',title:'PDF one',contentType:'application/pdf'},{id:'100',parentID:'1',title:'PDF two',contentType:'application/pdf'}]),collections:record('collections',[{id:'4',name:'Research',count:2,parentID:null}]),openItem:record('open'),relate:record('relate'),addTags:record('addTags'),removeTags:record('removeTags'),setRemark:record('remark'),createNote:record('createNote','9'),noteFromAnnotations:record('extract','9')};
 const palettes=[];const reader={annotationPalettes:()=>palettes,saveAnnotationPalette:record('savePalette',(name,entries)=>{const row={id:'palette1',name,entries};palettes.push(row);return row;}),applyAnnotationPalette:record('applyPalette'),deleteAnnotationPalette:record('deletePalette',id=>{palettes.splice(palettes.findIndex(p=>p.id===id),1);}),tabs:()=>[{id:'tab1',title:'Paper Alpha',itemID:1,selected:true}],tabGroups:()=>[{id:'g1',name:'Group',tabs:[{id:1}]}],viewGroups:()=>[{id:'v1',name:'View',columns:[{dataKey:'title'}]}],applyTheme:record('theme'),setMarginAnnotations:record('margin'),setColorLabel:record('color'),setSidebar:record('sidebar'),setVerticalTabs:record('vertical'),saveTabGroup:record('saveTabs'),restoreTabGroup:record('restoreTabs',{opened:1,missing:0}),deleteTabGroup:record('deleteTabs'),selectTab:record('selectTab'),closeTab:record('closeTab'),saveView:record('saveView'),applyView:record('applyView'),deleteView:record('deleteView')};
 Object.assign(library,{mergeAnnotations:record('mergeAnnotations','3'),unrelate:record('unrelate',2),renameTagBranch:record('renameTagBranch',{updatedItems:1,renamedTags:1,mergedTags:0}),recolorAnnotations:record('recolor',1),collectionItems:record('collectionItems',['2'])});
 Object.assign(reader,{moveTab:(...args)=>{calls.push(['moveTab',...args]);},closeOtherTabs:(...args)=>{calls.push(['closeOtherTabs',...args]);return {closed:1};},renameTabGroup:record('renameTabGroup'),updateTabGroup:record('updateTabGroup'),renameView:record('renameView'),updateView:record('updateView'),marginOptions:()=>({width:210,side:'right',textLimit:1500}),setMarginOptions:record('setMarginOptions'),resetAppearance:record('resetAppearance')});
 const assist={run:record('ai','Generated result'),cancel:()=>calls.push(['cancelAI'])};
 const model={...Model,deleteBoard:(cache,id)=>{calls.push(['deleteBoard',id]);cache.testDeleted=cache.boards.find(b=>b.id===id);cache.boards=cache.boards.filter(b=>b.id!==id);return cache.testDeleted;},restoreBoard:cache=>{calls.push(['restoreBoard']);const board=cache.testDeleted;if(board){cache.boards.push(board);delete cache.testDeleted;}return board;}};
 const bench=Workbench.attach(win,{runtime,library,reader,model,assist});
 const body=()=>bench.panel.querySelector('.sc-body');
 // An icon button carries its name in the tooltip and the accessible label,
 // not in its text, so a control is findable the way a user identifies it.
 const findButton=label=>[...bench.panel.querySelectorAll('button')]
   .find(b=>b.textContent===label||b.getAttribute('title')===label||b.getAttribute('aria-label')===label);
 const click=async label=>{const b=findButton(label);assert.ok(b,'button: '+label);b.dispatchEvent(new win.Event('click',{bubbles:true}));await settle();};
 const input=(label,value)=>{const el=bench.panel.querySelector('[aria-label="'+label+'"]');assert.ok(el,label);el.value=value;el.dispatchEvent(new win.Event('input',{bubbles:true}));return el;};
 return {win,doc,bench,runtime,library,reader,assist,calls,errors,papers,refs,body,click,input,findButton,setLibrary:id=>{libraryID=id;},setSelection:ids=>{mainSelection=ids.map(id=>refs.get(id));},notify:()=>notify(),record};
}

test('the notes tab offers the open, recent and searched papers when none is chosen, and the pick brings the editor', async () => {
 const f=fixture();await f.bench.show('notes');f.bench.state.selected=new Set();await f.bench.render();
 assert.equal(f.body().querySelector('textarea'),null,'no editor without a paper');
 assert.ok(f.body().textContent.includes('지금 열려 있는 논문'));
 assert.ok(f.body().textContent.includes('최근 문헌'));
 const open=f.body().querySelector('[data-pick="1"]');assert.ok(open,'the paper open in a reader tab is offered');
 f.bench.state.query='Beta';await f.bench.render();
 assert.ok(f.body().textContent.includes('검색 결과'));
 const found=[...f.body().querySelectorAll('[data-pick]')].map(b=>b.textContent);assert.ok(found.includes('Paper Beta'));
 f.bench.state.query='';await f.bench.render();
 f.body().querySelector('[data-pick="1"]').dispatchEvent(new f.win.Event('click'));await settle();
 assert.ok(f.bench.state.selected.has('1'));assert.ok(f.body().querySelector('textarea'),'the editor for the chosen paper');
 assert.ok(f.body().textContent.includes('Paper Alpha에 새 노트'));
 await f.click('다른 문헌 고르기');assert.equal(f.bench.state.selected.size,0);assert.ok(f.body().textContent.includes('지금 열려 있는 논문'));
 f.bench.destroy();
});

test('workbench mounts hidden and all nineteen tabs render without raw note HTML',async()=>{
 const f=fixture();assert.equal(f.bench.panel.hidden,true);assert.equal(f.calls.length,0);assert.equal(Workbench.TABS.length,19);
 for(const [tab] of Workbench.TABS){await f.bench.show(tab);assert.ok(f.body().childNodes.length,tab);assert.notEqual(f.bench.panel.querySelector('.sc-status').dataset.error,'true',tab);}
 await f.bench.show('notes');assert.ok(f.body().textContent.includes('<script>literal note</script>'));assert.equal(f.body().querySelector('script'),null);assert.equal(f.body().querySelector('b'),null);f.bench.destroy();assert.ok(f.calls.find(c=>c[0]==='unregister'));
});

test('all tabs expose functional primary actions and use library service contracts',async()=>{
 const f=fixture();await f.bench.show('explore');await f.click('열기');assert.ok(f.calls.find(c=>c[0]==='open'&&c[1]==='1'));
 await f.bench.show('graph');assert.ok(f.body().querySelector('svg'));await f.click('공통 태그');await f.click('확대');
 await f.bench.show('tags');f.input('추가할 태그','new, nested/tag');await f.click('선택 문헌에 태그 추가');assert.deepEqual(f.calls.find(c=>c[0]==='addTags').slice(1),[['1'],['new','nested/tag']]);
 await f.bench.show('notes');f.input('새 노트 내용','Plain note');await f.click('새 노트 저장');assert.ok(f.calls.find(c=>c[0]==='createNote'&&c[1]==='1'&&c[2]==='Plain note'));
 await f.bench.show('annotations');const row=f.body().querySelector('.sc-annot');row.dispatchEvent(new f.win.Event('click',{bubbles:true}));assert.equal(row.dataset.selected,'true');await f.click('선택 주석을 노트로');assert.deepEqual(f.calls.find(c=>c[0]==='extract')[1],['3']);
 await f.bench.show('backlinks');assert.match(f.body().textContent,/Paper Beta/);await f.click('열기');
 await f.bench.show('attachments');await f.click('열기');assert.ok(f.calls.find(c=>c[0]==='open'&&c[1]==='99'));
 await f.bench.show('reading');await f.click('세피아 PDF');assert.ok(f.calls.find(c=>c[0]==='theme'&&c[2]==='sepia'));
 await f.bench.show('tabs');await f.click('이동');await f.click('복원');assert.ok(f.calls.find(c=>c[0]==='restoreTabs'));
 await f.bench.show('views');await f.click('적용');assert.ok(f.calls.find(c=>c[0]==='applyView'));
 await f.bench.show('canvas');f.input('보드 이름','Board');await f.click('보드 만들기');await f.click('선택 문헌 추가');assert.equal(f.runtime.cache.boards[0].nodes[0].itemID,'1');
 await f.bench.show('matrix');await f.click('CSV 복사');assert.ok(f.calls.find(c=>c[0]==='copy'&&c[1].includes('Paper Alpha')));
 await f.bench.show('collections');await f.click('컬렉션 열기');assert.ok(f.calls.find(c=>c[0]==='collection'&&c[1]===4));
 assert.equal(f.bench.state.scope,'collection','the panel follows the tree into the collection');f.bench.state.scope='library';
 await f.bench.show('journals');await f.click('공식 값 새로고침');assert.ok(f.calls.find(c=>c[0]==='journal'));
 // The easyScholar grade lookup appears only once a key exists; without one the
 // tab used to offer a button whose only possible outcome was an error.
 assert.equal(f.bench.panel.querySelector('[data-action-key], button'), f.bench.panel.querySelector('button'));
 assert.ok(![...f.body().querySelectorAll('button')].some(b=>b.textContent==='등급 조회'),
  'no grade button without a key');
 assert.match(f.body().textContent,/easyScholar 키/);
 f.runtime.pref=(key,fallback)=>key==='journalRankKey'?'a-key':fallback;
 await f.bench.show('journals');
 await f.click('등급 조회');assert.ok(f.calls.find(c=>c[0]==='ranks'));
 await f.bench.show('assist');await f.click('제목 번역');await f.click('선택 문헌에 적용');assert.equal(f.runtime.entry(f.refs.get(1)).translatedTitle,'Generated result');
 await f.bench.show('appearance');f.input('Custom 패널 CSS','.sc-card { color: red; }');await f.click('패널 CSS 적용');assert.ok(f.calls.find(c=>c[0]==='css'));f.input('추가 문헌 열','DOI, language');await f.click('추가 열 적용');assert.ok(f.calls.find(c=>c[0]==='customFields'&&c[1]==='DOI, language'));f.bench.destroy();
});

test('search and tab changes during initial snapshot cannot discard loaded items',async()=>{
 const f=fixture(),pending=deferred();f.library.snapshot=()=>pending.promise;const showing=f.bench.show('explore');f.input('작업 패널 검색','Alpha');f.bench.state.tab='graph';await f.bench.render();pending.resolve(f.papers);await showing;
 assert.equal(f.bench.state.items.length,2);assert.ok(f.body().querySelector('svg'));f.bench.destroy();
});

test('late old-library snapshot and hidden-panel results are ignored',async()=>{
 const f=fixture(),first=deferred(),second=deferred();let n=0;f.library.snapshot=()=>++n===1?first.promise:second.promise;
 const old=f.bench.show('explore');f.setLibrary(2);const current=f.bench.load();second.resolve([f.papers[1]]);await current;first.resolve([f.papers[0]]);await old;assert.equal(f.bench.state.items[0].id,'2');
 const pending=deferred();f.library.snapshot=()=>pending.promise;const loading=f.bench.load();await f.bench.toggle(false);pending.resolve(f.papers);await loading;assert.equal(f.bench.panel.hidden,true);assert.equal(f.body().childNodes.length,0);f.bench.destroy();
});

test('notifier refresh preserves note and remark drafts and successful note save clears draft',async()=>{
 const f=fixture();await f.bench.show('notes');f.input('새 노트 내용','Do not lose this');f.notify();await new Promise(resolve=>setTimeout(resolve,230));await settle();assert.equal(f.body().querySelector('textarea').value,'Do not lose this');
 await f.click('새 노트 저장');assert.equal(f.body().querySelector('textarea').value,'');
 await f.bench.show('explore');await f.click('자세히');f.input('읽기 메모','Unsaved remark');await f.bench.load();assert.equal(f.body().querySelector('textarea').value,'Unsaved remark');f.bench.destroy();
});

test('AI response and draft cannot be applied to another paper',async()=>{
 const f=fixture(),pending=deferred();f.assist.run=()=>pending.promise;await f.bench.show('assist');f.findButton('제목 번역').dispatchEvent(new f.win.Event('click'));
 f.setSelection([2]);await f.bench.show('assist');pending.resolve('Result for Alpha');await settle();assert.equal(f.body().querySelector('.sc-ai-output').value,'');await f.click('선택 문헌에 적용');assert.equal(f.runtime.entry(f.refs.get(2)).translatedTitle,undefined);
 f.assist.run=async()=> 'Beta result';await f.click('제목 번역');f.input('AI 생성 결과 — 적용 전 확인','Reviewed Beta');await f.bench.load();assert.equal(f.body().querySelector('.sc-ai-output').value,'Reviewed Beta');await f.click('선택 문헌에 적용');assert.equal(f.runtime.entry(f.refs.get(2)).translatedTitle,'Reviewed Beta');f.bench.destroy();
});

test('scope and library changes clear hidden annotation selection before extraction',async()=>{
 const f=fixture();await f.bench.show('annotations');f.bench.state.annotationIDs.add('3');const scope=f.bench.panel.querySelector('[aria-label="표시 범위"]');scope.value='selected';scope.dispatchEvent(new f.win.Event('change'));await settle();assert.equal(f.bench.state.annotationIDs.size,0);
 f.bench.state.annotationIDs.add('3');f.setLibrary(2);f.library.annotations=async()=>[];await f.bench.load();await f.click('선택 주석을 노트로');assert.equal(f.calls.find(c=>c[0]==='extract'),undefined);f.bench.destroy();
});

test('native previews cannot resume after tab switch or overwrite a newer preview',async()=>{
 const f=fixture(),pending=deferred(),previews=[];
 f.doc.createXULElement=tag=>{const p=f.doc.createElement(tag);p.render=async()=>{p.rendered=true;};p.discard=async()=>{p.discarded=true;};previews.push(p);return p;};
 f.runtime.Z.Items.getAsync=()=>pending.promise;await f.bench.show('attachments');f.findButton('미리보기').dispatchEvent(new f.win.Event('click'));await settle();assert.equal(previews.length,1);f.bench.state.tab='notes';await f.bench.render();pending.resolve({id:99});await settle();assert.equal(previews[0].rendered,undefined);assert.equal(previews[0].discarded,true);assert.equal(previews[0].isConnected,false);
 f.runtime.Z.Items.getAsync=async id=>({id});await f.bench.show('attachments');await f.click('미리보기');assert.equal(previews.at(-1).rendered,true);f.bench.destroy();await settle();assert.equal(previews.at(-1).discarded,true);
});

test('reading refresh preserves controls and offers all pages of the recorded attachment',async()=>{
 const f=fixture();await f.bench.show('reading');const margin=f.body().querySelector('[aria-label="PDF 여백에 주석 표시"]');assert.equal(margin.checked,true);
 f.input('색상 이름','Important');const savedControl=f.body().querySelector('[aria-label="색상 이름"]');const range=f.body().querySelector('[aria-label="Paper Alpha 페이지 범위"]');assert.equal(range.querySelectorAll('option').length,7);range.value='500';range.dispatchEvent(new f.win.Event('change'));await settle();{const cell=f.body().querySelector('.sc-page-cell[aria-label^="551페이지"]');assert.ok(cell,'page 551 square');cell.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();}assert.ok(f.calls.find(c=>c[0]==='open'&&c[1]==='99'&&c[2].pageIndex===550));
 f.bench.refreshReading();assert.equal(f.body().querySelector('[aria-label="색상 이름"]'),savedControl);assert.equal(savedControl.value,'Important');assert.equal(f.body().querySelector('[aria-label="Paper Alpha 페이지 범위"]').value,'500');
 for(const [label,method] of [['리더 사이드바 표시','sidebar'],['세로 탭 목록 표시','vertical']]){const c=f.body().querySelector('[aria-label="'+label+'"]');c.checked=true;c.dispatchEvent(new f.win.Event('change'));await settle();assert.ok(f.calls.find(x=>x[0]===method));}
 f.bench.destroy();
});

test('remark drafts stay with item IDs when snapshot ordering changes',async()=>{
 const f=fixture();await f.bench.show('explore');f.bench.state.selected=new Set(['1','2']);f.bench.state.scope='selected';await f.bench.render();
 const inputs=[...f.body().querySelectorAll('[aria-label="읽기 메모"]')];inputs[0].value='Draft Alpha';inputs[0].dispatchEvent(new f.win.Event('input',{bubbles:true}));inputs[1].value='Draft Beta';inputs[1].dispatchEvent(new f.win.Event('input',{bubbles:true}));
 f.library.snapshot=async()=>[...f.papers].reverse();await f.bench.load();const reordered=[...f.body().querySelectorAll('[aria-label="읽기 메모"]')];assert.deepEqual(reordered.map(i=>i.value),['Draft Beta','Draft Alpha']);f.bench.destroy();
});

test('newer preview wins even when an older item fetch resolves last',async()=>{
 const f=fixture(),first=deferred(),second=deferred(),previews=[];
 f.doc.createXULElement=tag=>{const p=f.doc.createElement(tag);p.render=async()=>{p.rendered=true;};p.discard=async()=>{p.discarded=true;};previews.push(p);return p;};
 f.runtime.Z.Items.getAsync=id=>id===99?first.promise:second.promise;
 await f.bench.show('attachments');const buttons=[...f.body().querySelectorAll('button')].filter(b=>b.textContent==='미리보기');buttons[0].dispatchEvent(new f.win.Event('click'));await settle();buttons[1].dispatchEvent(new f.win.Event('click'));await settle();second.resolve({id:100});await settle();first.resolve({id:99});await settle();
 assert.equal(previews.length,2);assert.equal(previews[0].isConnected,false);assert.equal(previews[0].rendered,undefined);assert.equal(previews[1].isConnected,true);assert.equal(previews[1].item.id,100);assert.equal(previews[1].rendered,true);f.bench.destroy();
});
test('latest AI request wins and closing during load never focuses a hidden search field',async()=>{
 const f=fixture(),first=deferred(),second=deferred();let n=0;f.assist.run=()=>++n===1?first.promise:second.promise;await f.bench.show('assist');f.findButton('제목 번역').dispatchEvent(new f.win.Event('click'));f.findButton('초록 요약').dispatchEvent(new f.win.Event('click'));second.resolve('Current summary');await settle();first.resolve('Obsolete translation');await settle();assert.equal(f.body().querySelector('.sc-ai-output').value,'Current summary');assert.equal(f.bench.state.aiTask,'summary');
 const pending=deferred();f.library.snapshot=()=>pending.promise;let focused=0;f.bench.panel.querySelector('[aria-label="작업 패널 검색"]').focus=()=>{focused++;};const opening=f.bench.toggle(true);await f.bench.toggle(false);pending.resolve(f.papers);await opening;assert.equal(focused,0);f.bench.destroy();
});

test('AI stop invalidates pending output while preserving the reviewed draft',async()=>{
 const f=fixture(),pending=deferred();await f.bench.show('assist');await f.click('제목 번역');f.input('AI 생성 결과 — 적용 전 확인','Reviewed draft');f.assist.run=()=>pending.promise;f.findButton('초록 요약').dispatchEvent(new f.win.Event('click'));await f.click('요청 중지');pending.resolve('Cancelled answer');await settle();assert.equal(f.body().querySelector('.sc-ai-output').value,'Reviewed draft');assert.ok(f.calls.find(c=>c[0]==='cancelAI'));f.bench.destroy();
});

test('recent view orders papers by latest read or modification and excludes undated items',async()=>{
 const f=fixture();f.runtime.state=ref=>ref.id===1?{lastRead:'2026-09-14T10:00:00Z',dateModified:'2025-01-01'}:{lastRead:'2026-08-01',dateModified:'2026-09-14T12:00:00Z'};
 await f.bench.show('recent');assert.deepEqual([...f.body().querySelectorAll('h3')].map(n=>n.textContent),['Paper Beta','Paper Alpha']);await f.click('열기');assert.ok(f.calls.find(c=>c[0]==='open'&&c[1]==='2'));f.bench.destroy();
});
test('navigation visibility persists, Appearance cannot be hidden and defaults restore all tabs',async()=>{
 const f=fixture({items:{},hiddenWorkbenchTabs:['graph','appearance']});await f.bench.show('appearance');assert.equal(f.bench.panel.querySelector('[data-tab="graph"]').hidden,true);assert.equal(f.bench.panel.querySelector('[data-tab="appearance"]').hidden,false);
 const control=f.body().querySelector('[aria-label="노트 메뉴 표시"]');control.checked=false;control.dispatchEvent(new f.win.Event('change'));await settle();assert.ok(f.runtime.cache.hiddenWorkbenchTabs.includes('notes'));assert.equal(f.bench.panel.querySelector('[data-tab="notes"]').hidden,true);await f.bench.show('notes');assert.equal(f.bench.state.tab,'appearance');
 await f.click('메뉴 기본값 복원');assert.deepEqual(f.runtime.cache.hiddenWorkbenchTabs,[]);assert.ok([...f.bench.panel.querySelectorAll('[data-tab]')].every(n=>!n.hidden));f.bench.destroy();
});
test('drafts persist across new workbench instances and saved notes remove persisted draft',async()=>{
 const f=fixture();await f.bench.show('notes');f.input('새 노트 내용','Draft for next session');assert.ok(f.runtime.cache.workbenchDrafts.entries.some(([,v])=>v==='Draft for next session'));f.bench.destroy();
 const reopened=fixture(structuredClone(f.runtime.cache));await reopened.bench.show('notes');assert.equal(reopened.body().querySelector('textarea').value,'Draft for next session');await reopened.click('새 노트 저장');assert.ok(!reopened.runtime.cache.workbenchDrafts.entries.some(([,v])=>v==='Draft for next session'));reopened.bench.destroy();
});
test('persistent drafts are bounded and exclude password or credential-labelled controls',async()=>{
 const f=fixture();await f.bench.show('appearance');
 for(let i=0;i<120;i++){const input=f.doc.createElement('textarea');input.dataset.draftKey='draft-'+i;input.value='x'.repeat(50000);f.body().appendChild(input);input.dispatchEvent(new f.win.Event('input',{bubbles:true}));input.remove();}
 for(const [key,type]of [['API-key','text'],['ordinary','password']]){const input=f.doc.createElement('input');input.type=type;input.dataset.draftKey=key;input.value='private-secret';f.body().appendChild(input);input.dispatchEvent(new f.win.Event('input',{bubbles:true}));}
 const entries=f.runtime.cache.workbenchDrafts.entries;assert.ok(entries.length<=100);assert.ok(entries.reduce((sum,[,v])=>sum+v.length,0)<=500000);assert.ok(!entries.some(([,v])=>v==='private-secret'));f.bench.destroy();
});

test('canvas board undo restores its selected cards through model APIs',async()=>{
 const f=fixture();await f.bench.show('canvas');f.input('보드 이름','Review board');await f.click('보드 만들기');await f.click('선택 문헌 추가');const board=f.runtime.cache.boards[0],card=board.nodes[0];f.bench.state.cardIDs.add(card.id);
 await f.click('보드 삭제');assert.equal(f.runtime.cache.boards.length,0);assert.equal(f.bench.state.boardID,null);await f.click('삭제 취소');assert.equal(f.bench.state.boardID,board.id);assert.ok(f.bench.state.cardIDs.has(card.id));assert.ok(f.calls.find(c=>c[0]==='deleteBoard'));assert.ok(f.calls.find(c=>c[0]==='restoreBoard'));f.bench.destroy();
});
test('palette editor sends typed color entries and unread-bold preference is wired',async()=>{
 const f=fixture();await f.bench.show('reading');f.input('새 주석 팔레트 이름','Research');f.input('주석 팔레트 색상과 이름','#ffd400, Key point\n#ff6666, Check source');await f.click('주석 팔레트 저장');assert.deepEqual(f.calls.find(c=>c[0]==='savePalette').slice(1),['Research',[{color:'#ffd400',label:'Key point'},{color:'#ff6666',label:'Check source'}]]);await f.click('주석 팔레트 적용');assert.ok(f.calls.find(c=>c[0]==='applyPalette'&&c[2]==='palette1'));await f.click('주석 팔레트 삭제');assert.ok(f.calls.find(c=>c[0]==='deletePalette'&&c[1]==='palette1'));
 f.input('주석 팔레트 색상과 이름','missing delimiter');await f.click('주석 팔레트 저장');assert.equal(f.calls.filter(c=>c[0]==='savePalette').length,1);
 await f.bench.show('appearance');const bold=f.body().querySelector('[aria-label="안 읽은 제목 굵게"]');bold.checked=true;bold.dispatchEvent(new f.win.Event('change'));await settle();assert.ok(f.calls.find(c=>c[0]==='pref'&&c[1]==='extensions.style-custom.unreadBold'&&c[2]===true));f.bench.destroy();
});

test('tag removal passes exact comma-separated names and explicit selected IDs',async()=>{
 const f=fixture();await f.bench.show('tags');f.input('추가할 태그','topic, other/tag');await f.click('선택 문헌에서 태그 제거');assert.deepEqual(f.calls.find(c=>c[0]==='removeTags').slice(1),[['1'],['topic','other/tag']]);f.bench.destroy();
});

test('finishing an earlier note save preserves text typed while it was saving',async()=>{
 const f=fixture(),saving=deferred();f.library.createNote=()=>saving.promise;await f.bench.show('notes');f.input('새 노트 내용','First submitted note');f.findButton('새 노트 저장').dispatchEvent(new f.win.Event('click'));await settle();f.input('새 노트 내용','Next unsaved note');saving.resolve('9');await settle();assert.equal(f.body().querySelector('[aria-label="새 노트 내용"]').value,'Next unsaved note');f.bench.destroy();
});
test('finishing an earlier remark save preserves edits made after submission',async()=>{
 const f=fixture(),saving=deferred();f.library.setRemark=()=>saving.promise;await f.bench.show('explore');await f.click('자세히');f.input('읽기 메모','Submitted remark');f.findButton('메모 저장').dispatchEvent(new f.win.Event('click'));await settle();f.input('읽기 메모','Newer unsaved remark');saving.resolve();await settle();await f.bench.load();assert.equal(f.body().querySelector('[aria-label="읽기 메모"]').value,'Newer unsaved remark');f.bench.destroy();
});
test('restored select drafts cannot mislabel a newly created canvas board',async()=>{
 const f=fixture();await f.bench.show('canvas');f.input('보드 이름','Board A');await f.click('보드 만들기');const a=f.runtime.cache.boards[0];const select=f.body().querySelector('[aria-label="캔버스 선택"]');select.value=a.id;select.dispatchEvent(new f.win.Event('change',{bubbles:true}));await settle();f.input('보드 이름','Board B');await f.click('보드 만들기');const b=f.runtime.cache.boards[1];assert.equal(f.bench.state.boardID,b.id);assert.equal(f.body().querySelector('[aria-label="캔버스 선택"]').value,b.id);f.bench.destroy();
});

test('app theme and opt-in tab-activity modification dates call their actual runtime controls',async()=>{
 const f=fixture();await f.bench.show('appearance');await f.click('앱 밝게/어둡게 전환');assert.ok(f.calls.find(c=>c[0]==='appTheme'));const toggle=f.body().querySelector('[aria-label="문서 탭 활동 시 수정일 갱신"]');assert.equal(toggle.checked,false);toggle.checked=true;toggle.dispatchEvent(new f.win.Event('change'));assert.ok(f.calls.find(c=>c[0]==='pref'&&c[1]==='extensions.style-custom.touchDateOnRead'&&c[2]===true));f.bench.destroy();
});

test('new note draft survives notifier replacement of its editor during a pending save',async()=>{
 const f=fixture(),saving=deferred();f.library.createNote=()=>saving.promise;await f.bench.show('notes');f.input('새 노트 내용','Submitted');const oldEditor=f.body().querySelector('textarea');f.findButton('새 노트 저장').dispatchEvent(new f.win.Event('click'));await settle();await f.bench.load();assert.notEqual(f.body().querySelector('textarea'),oldEditor);f.input('새 노트 내용','Typed in replacement editor');saving.resolve('9');await settle();assert.equal(f.body().querySelector('textarea').value,'Typed in replacement editor');assert.ok(f.runtime.cache.workbenchDrafts.entries.some(([,text])=>text==='Typed in replacement editor'));f.bench.destroy();
});

test('visible status year rating and sort controls filter exploration and reset together',async()=>{
 const f=fixture();f.runtime.state=ref=>({status:ref.id===1?'done':'reading',rating:ref.id===1?5:2,citations:ref.id===1?0:20});await f.bench.show('explore');
 const change=(label,value)=>{const input=f.bench.panel.querySelector('[aria-label="'+label+'"]');input.value=value;input.dispatchEvent(new f.win.Event('change',{bubbles:true}));};
 change('문헌 정렬','citations-desc');await settle();assert.match(f.body().querySelector('h3').textContent,/Beta/);
 change('읽기 상태 필터','done');change('최소 별점','4');f.input('시작 연도','2025');await settle();assert.equal(f.body().querySelectorAll('.sc-paper-list > article').length,1);assert.match(f.body().textContent,/Alpha/);
 f.input('마지막 연도','2024');await settle();assert.equal(f.body().querySelectorAll('.sc-paper-list > article').length,0);
 await f.click('필터 초기화');assert.equal(f.body().querySelectorAll('.sc-paper-list > article').length,2);f.bench.destroy();
});

test('exploration pages past the old 200 item limit and selects exactly the requested page or results',async()=>{
 const f=fixture();f.papers.splice(0);for(let n=1;n<=251;n++){f.papers.push({id:String(n),title:'Paper '+n,itemType:'journalArticle',tags:[]});f.refs.set(n,{id:n});}
 await f.bench.show('explore');assert.equal(f.body().querySelectorAll('.sc-paper-list > article').length,100);
 await f.click('다음 페이지');await f.click('현재 페이지 선택');assert.equal(f.bench.state.selected.size,101);assert.ok(f.bench.state.selected.has('200'));assert.equal(f.bench.state.selected.has('201'),false);
 await f.click('다음 페이지');assert.equal(f.body().querySelectorAll('.sc-paper-list > article').length,51);assert.match(f.body().textContent,/Paper 251/);assert.equal(f.findButton('다음 페이지').disabled,true);
 await f.click('검색 결과 전체 선택');assert.equal(f.bench.state.selected.size,251);
 await f.click('현재 페이지 선택 해제');assert.equal(f.bench.state.selected.size,200);assert.equal(f.bench.state.selected.has('251'),false);
 f.input('작업 패널 검색','Paper 251');await settle();assert.equal(f.bench.state.pageIndex,0);assert.equal(f.body().querySelectorAll('.sc-paper-list > article').length,1);f.bench.destroy();
});

test('comparison field choices persist and CSV exports all rows while the table pages without losing zero values',async()=>{
 const f=fixture({items:{},readerSettings:{},matrixFields:['title','citations']});f.papers.splice(0);for(let n=1;n<=61;n++){f.papers.push({id:String(n),title:'Matrix '+n,itemType:'journalArticle',tags:['tag']});f.refs.set(n,{id:n});}f.setSelection([]);f.runtime.state=()=>({citations:0,rating:5,status:'reading'});
 await f.bench.show('matrix');assert.equal(f.body().querySelectorAll('tr').length,51);await f.click('비교 다음 페이지');assert.equal(f.body().querySelectorAll('tr').length,12);assert.match(f.body().textContent,/Matrix 61/);
 const rating=f.body().querySelector('[aria-label="비교 항목: 별점"]');rating.checked=true;rating.dispatchEvent(new f.win.Event('change',{bubbles:true}));await settle();assert.deepEqual(f.runtime.cache.matrixFields,['title','citations','rating']);
 await f.click('CSV 복사');const csv=f.calls.filter(c=>c[0]==='copy').at(-1)[1];assert.equal(csv.split('\r\n').length,62);assert.match(csv,/"Matrix 61","0","5"/);
 await f.click('행·열 전환');assert.equal(f.body().querySelector('th').getAttribute('scope'),'row');f.bench.destroy();
});

test('canvas exposes board and card appearance editing and reversible relation removal',async()=>{
 const f=fixture();await f.bench.show('canvas');f.input('보드 이름','Original');await f.click('보드 만들기');await f.click('선택 문헌 추가');await f.click('메모 카드 추가');
 f.input('현재 보드 이름','Updated board');await f.click('보드 이름 변경');assert.equal(f.runtime.cache.boards[0].name,'Updated board');
 f.input('카드 제목','Custom caption');f.input('카드 색상','#aabbcc');await f.click('카드 모양 저장');assert.equal(f.runtime.cache.boards[0].nodes[0].label,'Custom caption');assert.equal(f.runtime.cache.boards[0].nodes[0].color,'#aabbcc');
 for(const c of f.body().querySelectorAll('[aria-label="카드 선택"]')){c.checked=true;c.dispatchEvent(new f.win.Event('change',{bubbles:true}));}
 await f.click('카드 연결');assert.equal(f.runtime.cache.boards[0].edges.length,1);await f.click('카드 연결 해제');assert.equal(f.runtime.cache.boards[0].edges.length,0);assert.equal(f.runtime.cache.boards[0].nodes.length,2);f.bench.destroy();
});

test('tag rename annotation recolor relationship removal and collection scope have real user entry points',async()=>{
 const f=fixture();await f.bench.show('tags');f.input('기존 태그 경로','topic');f.input('새 태그 경로','review');await f.click('선택 문헌 태그 이름 변경');assert.deepEqual(f.calls.find(c=>c[0]==='renameTagBranch').slice(1),[['1'],'topic','review',{subtree:true}]);
 await f.bench.show('annotations');await f.click('보이는 주석 전체 선택');f.input('선택 주석 새 색상','#ff6666');await f.click('선택 주석 색 바꾸기');assert.deepEqual(f.calls.find(c=>c[0]==='recolor').slice(1),[['3'],'#ff6666']);
 f.bench.state.selected=new Set(['1','2']);await f.bench.render();await f.click('선택 문헌끼리 연결 해제');assert.deepEqual(f.calls.find(c=>c[0]==='unrelate')[1],['1','2']);
 f.win.ZoteroPane.getSelectedCollection=()=>({id:4,libraryID:1});const scope=f.bench.panel.querySelector('[aria-label="표시 범위"]');scope.value='collection-recursive';scope.dispatchEvent(new f.win.Event('change',{bubbles:true}));await settle();assert.deepEqual(f.calls.find(c=>c[0]==='collectionItems').slice(1),[4,{libraryID:1,recursive:true}]);
 await f.bench.show('explore');assert.match(f.body().textContent,/Beta/);assert.doesNotMatch(f.body().textContent,/Alpha/);await f.bench.show('notes');assert.deepEqual(f.calls.filter(c=>c[0]==='notes').at(-1)[1],['2']);
 f.win.ZoteroPane.getSelectedCollection=()=>null;await f.bench.load();assert.deepEqual(f.bench.state.collectionIDs,[]);f.bench.destroy();
});

test('tab and view editing plus margin and reset controls reach the reader service',async()=>{
 const f=fixture();f.reader.tabs=()=>[{id:'library',title:'Library'},{id:'a',title:'A',itemID:1},{id:'b',title:'B',itemID:2}];await f.bench.show('tabs');await f.click('탭 뒤로');assert.ok(f.calls.find(c=>c[0]==='moveTab'&&c[2]==='a'&&c[3]===2));await f.click('이 탭 외 문서 탭 닫기');assert.ok(f.calls.find(c=>c[0]==='closeOtherTabs'&&c[2]==='a'));
 f.input('저장된 탭 그룹 이름','New tabs');await f.click('탭 그룹 이름 변경');await f.click('현재 탭으로 그룹 갱신');assert.deepEqual(f.calls.find(c=>c[0]==='renameTabGroup').slice(1),['g1','New tabs']);assert.ok(f.calls.find(c=>c[0]==='updateTabGroup'&&c[2]==='g1'));
 await f.bench.show('views');f.input('저장된 뷰 그룹 이름','New view');await f.click('뷰 그룹 이름 변경');await f.click('현재 열 배치로 뷰 갱신');assert.deepEqual(f.calls.find(c=>c[0]==='renameView').slice(1),['v1','New view']);assert.ok(f.calls.find(c=>c[0]==='updateView'&&c[2]==='v1'));
 await f.bench.show('reading');f.input('여백 주석 너비','320');f.input('여백 주석 표시 글자 수','2000');const side=f.bench.panel.querySelector('[aria-label="여백 주석 위치"]');side.value='left';await f.click('여백 주석 설정 적용');assert.deepEqual(f.calls.find(c=>c[0]==='setMarginOptions')[2],{width:320,side:'left',textLimit:2000});await f.click('리더 모양 원래대로');assert.ok(f.calls.find(c=>c[0]==='resetAppearance'));f.bench.destroy();
});

test('paper detail displays status without available metrics and includes scoped notes and annotations inline',async()=>{
 const f=fixture();f.runtime.state=()=>({citations:null,impactFactor:null,status:'done',rating:4,seconds:19});await f.bench.show('explore');
 // Each figure carries its own mark now, so the row reads without a header and
 // the reading state is the dot rather than a word taking up the line.
 const row=f.body().querySelector('.sc-paper-card');
 const value=name=>row.querySelector(`[data-metric=${name}] .sc-metric-value`).textContent;
 assert.equal(value('impact'),'','an unknown figure is left blank, not dashed');
 assert.equal(value('citations'),'');
 assert.equal(value('time'),'19초');
 assert.equal(value('rating'),'★★★★☆');
 assert.equal(row.dataset.status,'done');
 for(const name of ['impact','citations','time'])assert.ok(row.querySelector(`[data-metric=${name}] svg`),name+' needs its icon');
 await f.click('자세히');assert.match(f.body().textContent,/Rich note/);assert.match(f.body().textContent,/Highlight/);assert.ok(f.findButton('문헌 노트 편집'));assert.ok(f.findButton('주석 원문 열기'));assert.deepEqual(f.calls.find(c=>c[0]==='notes')[1],['1']);assert.deepEqual(f.calls.find(c=>c[0]==='annotations')[1],['1']);assert.equal(f.body().querySelector('script'),null);f.bench.destroy();
});

test('late detail notes never leak into a different paper or tab',async()=>{
 const f=fixture(),pending=deferred();f.library.notes=()=>pending.promise;await f.bench.show('explore');const click=f.click('자세히');await settle();f.bench.state.tab='matrix';await f.bench.render();pending.resolve([{id:'9',title:'Stale note',text:'Old detail'}]);await click;assert.doesNotMatch(f.body().textContent,/Stale note/);f.bench.destroy();
});

test('annotation merge and exact note backlinks operate on visible annotation IDs from the workbench',async()=>{
 const f=fixture();f.library.annotations=f.record('annotations',[{id:'3',text:'First',color:'#ffd400',type:'highlight',pageIndex:0},{id:'4',text:'Second',color:'#ffd400',type:'highlight',pageIndex:1}]);f.library.backlinks=f.record('backlinks',[{id:'9',title:'Linked annotation note',kind:'note'}]);await f.bench.show('annotations');await f.click('참조 노트');assert.deepEqual(f.calls.find(c=>c[0]==='backlinks')[1],'3');await f.click('Linked annotation note');assert.ok(f.calls.find(c=>c[0]==='open'&&c[1]==='9'));
 await f.click('보이는 주석 전체 선택');await f.click('선택 주석 병합');const call=f.calls.find(c=>c[0]==='mergeAnnotations');assert.deepEqual(call[1],['3','4']);assert.equal(typeof call[2].isCurrent,'function');assert.match(f.bench.panel.querySelector('.sc-status').textContent,/휴지통/);f.bench.destroy();assert.equal(call[2].isCurrent(),false);
});

test('rapid comparison field changes compose while persistence is still pending',async()=>{
 const f=fixture({items:{},readerSettings:{},matrixFields:['title','authors','venue']}),pending=deferred();await f.bench.show('matrix');f.runtime.flush=()=>pending.promise;
 for(const label of ['저자','저널']){const input=f.body().querySelector('[aria-label="비교 항목: '+label+'"]');input.checked=false;input.dispatchEvent(new f.win.Event('change',{bubbles:true}));}
 assert.deepEqual(f.runtime.cache.matrixFields,['title']);pending.resolve();await settle();assert.equal(f.body().querySelectorAll('.sc-matrix th').length,1);f.bench.destroy();
});

test('collection changes during pending membership lookup discard the old scope and follow the current collection',async()=>{
 const f=fixture(),pending=deferred();let collectionID=4;f.win.ZoteroPane.getSelectedCollection=()=>({id:collectionID});f.library.collectionItems=id=>id===4?pending.promise:Promise.resolve(id===5?['2']:['1']);f.bench.state.scope='collection';const loading=f.bench.show('explore');await settle();collectionID=5;pending.resolve(['1']);await loading;
 assert.deepEqual(f.bench.state.collectionIDs,['2']);assert.match(f.body().textContent,/Beta/);assert.doesNotMatch(f.body().textContent,/Alpha/);
 collectionID=6;await new Promise(resolve=>setTimeout(resolve,600));await settle();assert.deepEqual(f.bench.state.collectionIDs,['1']);assert.match(f.body().textContent,/Alpha/);f.bench.destroy();
});

test('grouped navigation keeps every feature reachable and restores density without touching data',async()=>{
 const f=fixture({items:{},readerSettings:{},workbenchUI:{density:'compact',lastTab:'notes'}});await f.bench.toggle(true);assert.equal(f.bench.state.tab,'notes');assert.equal(f.bench.panel.dataset.density,'compact');assert.equal(f.bench.panel.querySelectorAll('.sc-nav-group').length,4);assert.equal(f.bench.panel.querySelectorAll('nav [data-tab]').length,19);
 await f.click('간격 넓게');assert.equal(f.runtime.cache.workbenchUI.density,'comfortable');assert.equal(f.bench.panel.dataset.density,'comfortable');await f.click('논문 비교');assert.equal(f.runtime.cache.workbenchUI.lastTab,'matrix');assert.equal(f.bench.panel.querySelector('.sc-section-title').textContent,'논문 비교');assert.equal(f.bench.panel.querySelector('.sc-search-row').hidden,true);f.bench.destroy();
});

test('collapsed filter chips remove only the requested filter and parent filters apply to note searches',async()=>{
 const f=fixture();f.runtime.state=ref=>({status:ref.id===1?'done':'reading',rating:4});await f.bench.show('notes');assert.equal(f.bench.panel.querySelector('.sc-filters').hasAttribute('open'),false);
 const status=f.bench.panel.querySelector('[aria-label="읽기 상태 필터"]');status.value='done';status.dispatchEvent(new f.win.Event('change',{bubbles:true}));f.input('작업 패널 검색','Rich note');await settle();assert.deepEqual(f.calls.filter(c=>c[0]==='notes').at(-1)[1],['1']);assert.match(f.bench.panel.querySelector('.sc-context-detail').textContent,/1개 문헌/);assert.match(f.body().textContent,/Rich note/);
 const remove=f.bench.panel.querySelector('[aria-label="상태 필터 해제"]');remove.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();assert.equal(f.bench.state.status,'');assert.equal(f.bench.state.query,'Rich note');assert.equal(f.calls.filter(c=>c[0]==='notes').at(-1)[1],undefined);f.bench.destroy();
});

test('command finder supports keyboard navigation hidden-feature filtering and layered Escape focus restoration',async()=>{
 const f=fixture({items:{},readerSettings:{},hiddenWorkbenchTabs:['journals']});const origin=f.doc.createElement('button');f.doc.body.appendChild(origin);origin.focus();await f.bench.show('explore');
 const key=(target,value,extras={})=>{const e=new f.win.Event('keydown',{bubbles:true,cancelable:true});Object.assign(e,{key:value,...extras});target.dispatchEvent(e);return e;};
 const search=f.bench.panel.querySelector('[aria-label="작업 패널 검색"]');assert.equal(f.doc.activeElement,search);key(search,'k',{metaKey:true});const finder=f.bench.panel.querySelector('.sc-command-search');assert.equal(f.doc.activeElement,finder);assert.equal(f.bench.panel.querySelector('.sc-shell').inert,true);assert.equal(f.bench.panel.querySelectorAll('.sc-command-option').length,18);
 f.input('찾을 기능 이름','주석');key(finder,'Enter');await settle();assert.equal(f.bench.state.tab,'annotations');assert.equal(f.bench.panel.querySelector('.sc-command-palette').hidden,true);assert.equal(f.doc.activeElement,f.body());assert.notEqual(f.bench.panel.querySelector('.sc-shell').inert,true);
 key(f.body(),'k',{ctrlKey:true});key(finder,'Escape');assert.equal(f.bench.panel.hidden,false);assert.equal(f.doc.activeElement,f.body());key(f.body(),'Escape');assert.equal(f.bench.panel.hidden,true);assert.equal(f.doc.activeElement,origin);f.bench.destroy();
});

test('save buttons prevent duplicate pending notes and saving no longer opens the editor automatically',async()=>{
 const f=fixture(),pending=deferred();f.library.createNote=f.record('createNote',()=>pending.promise);await f.bench.show('notes');f.input('새 노트 내용','One note');const save=f.findButton('새 노트 저장');save.dispatchEvent(new f.win.Event('click',{bubbles:true}));save.dispatchEvent(new f.win.Event('click',{bubbles:true}));assert.equal(f.calls.filter(c=>c[0]==='createNote').length,1);assert.equal(save.getAttribute('aria-busy'),'true');assert.equal(save.disabled,true);
 pending.resolve('9');await settle();assert.equal(f.calls.some(c=>c[0]==='open'),false);await f.click('저장한 노트 열기');assert.deepEqual(f.calls.find(c=>c[0]==='open').slice(1),['9']);f.bench.destroy();
});

test('selected paper context warns about off-result selection and disables relations until two papers are selected',async()=>{
 const f=fixture();await f.bench.show('explore');assert.equal(f.findButton('관련 문헌으로 연결').disabled,true);const checkbox=f.body().querySelector('[aria-label="Paper Beta 선택"]');checkbox.checked=true;checkbox.dispatchEvent(new f.win.Event('change',{bubbles:true}));assert.equal(f.findButton('관련 문헌으로 연결').disabled,false);assert.equal(f.body().querySelector('[data-item-id="2"]').dataset.selected,'true');
 f.input('작업 패널 검색','Alpha');await settle();assert.match(f.bench.panel.querySelector('.sc-selection-label').textContent,/결과 밖 1개 포함/);await f.click('선택 해제');assert.equal(f.findButton('관련 문헌으로 연결').disabled,true);f.bench.destroy();
});

test('large inline evidence starts with five entries and supported preview choices stay explicit',async()=>{
 const f=fixture();f.library.notes=f.record('notes',Array.from({length:30},(_,i)=>({id:String(10+i),title:'Note '+i,text:'Content'})));await f.bench.show('explore');await f.click('자세히');const section=f.body().querySelector('.sc-evidence');assert.equal(section.hasAttribute('open'),false);assert.equal(section.querySelectorAll('article').length,5);await f.click('노트 더 보기 · 25개 남음');assert.equal(section.querySelectorAll('article').length,25);
 f.library.attachments=f.record('attachments',[{id:'99',title:'Link',contentType:'text/html',path:null},{id:'100',title:'Archive',contentType:'application/zip',path:'/fake/archive.zip'}]);await f.bench.show('attachments');assert.equal(f.findButton('미리보기'),undefined);assert.match(f.body().textContent,/미리보기를 지원하지 않습니다/);assert.ok(f.findButton('열기'));f.bench.destroy();
});

test('pending note creation survives redraw without submitting the same draft twice',async()=>{
 const f=fixture(),pending=deferred();f.library.createNote=f.record('createNote',()=>pending.promise);await f.bench.show('notes');f.input('새 노트 내용','Single draft');await f.click('새 노트 저장');await f.bench.render();await f.click('새 노트 저장');assert.equal(f.calls.filter(c=>c[0]==='createNote').length,1);pending.resolve('9');await settle();assert.equal(f.findButton('새 노트 저장').disabled,false);f.bench.destroy();
});

test('a late earlier navigation cannot overwrite the remembered section or move focus from the latest choice',async()=>{
 const f=fixture(),pending=deferred();await f.bench.show('explore');f.library.annotations=()=>pending.promise;await f.click('주석');await f.click('노트');const input=f.body().querySelector('textarea');input.focus();pending.resolve([]);await settle();assert.equal(f.bench.state.tab,'notes');assert.equal(f.runtime.cache.workbenchUI.lastTab,'notes');assert.equal(f.doc.activeElement,input);f.bench.destroy();
});

test('disabled reader features block workbench recolor merge and backlink actions as well as native tools',async()=>{
 const f=fixture(),disabled=new Set();f.runtime.featureEnabled=id=>!disabled.has(id);await f.bench.show('annotations');await f.click('보이는 주석 전체 선택');const old=f.findButton('선택 주석 병합');disabled.add('reader.mergeAnnotations');old.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();assert.equal(f.calls.some(call=>call[0]==='mergeAnnotations'),false);
 disabled.add('annotationColors');disabled.add('backlinks');await f.bench.render();assert.equal(f.findButton('선택 주석 병합').hidden,true);assert.equal(f.findButton('선택 주석 색 바꾸기').hidden,true);assert.equal(f.findButton('참조 노트').hidden,true);f.bench.destroy();
});

test('configured page size and live reading metrics update existing paper cards without replacing editors',async()=>{
 const f=fixture();f.runtime.getSetting=key=>({explorePageSize:25,inlineEvidenceCount:5,maxExcerptLength:1200,workbenchDensity:'comfortable'})[key];f.runtime.formatReadTime=seconds=>Math.floor(seconds||0)+'s';f.papers.splice(0);for(let id=1;id<=30;id++){f.papers.push({id:String(id),title:'Paper '+id,itemType:'journalArticle',tags:[]});f.refs.set(id,{id});}let seconds=0;f.runtime.state=()=>({seconds,status:seconds?'reading':'unread',citations:null,impactFactor:null});await f.bench.show('explore');assert.equal(f.body().querySelectorAll('.sc-paper-card').length,25);const card=f.body().querySelector('[data-item-id="1"]');assert.equal(card.querySelector('[data-metric=time]').textContent,'','unread: no time is shown');seconds=1;f.bench.refreshMetrics();assert.equal(f.body().querySelector('[data-item-id="1"]'),card);assert.match(card.querySelector('[data-metric=time]').textContent,/1s/);assert.equal(card.dataset.status,'reading');f.bench.destroy();
});

test('opening the related tab searches straight away instead of waiting for a second click',async()=>{
 const f=fixture();
 await f.bench.show('related');
 assert.ok(f.calls.find(c=>c[0]==='related'),'the tab should look up on open');
 const titles=[...f.body().querySelectorAll('.sc-hit-title')].map(n=>n.textContent);
 assert.deepEqual(titles,['Paper W5','Paper W7']);
 // The stronger signal is labelled first.
 const groups=[...f.body().querySelectorAll('.sc-hit-group')].map(n=>n.textContent);
 assert.deepEqual(groups,['이 논문을 인용한 논문 1','이 논문이 인용한 문헌 1']);
 assert.notEqual(f.bench.panel.querySelector('.sc-status').dataset.error,'true');
 f.bench.destroy();
});

test('actions stay hidden until a row is wanted, and importing redraws that row as owned',async()=>{
 const f=fixture();
 await f.bench.show('related');
 const first=f.body().querySelector('.sc-hit');
 assert.ok(first.querySelector('.sc-hit-actions'),'a row that is not yet owned offers actions');
 assert.equal(first.querySelector('.sc-hit-owned'),null);
 await f.click('추가');
 const call=f.calls.find(c=>c[0]==='importWork');
 assert.equal(call[1].doi,'10.1/W5');
 const redrawn=f.body().querySelector('.sc-hit');
 assert.equal(redrawn.querySelector('.sc-hit-owned').textContent,'보유 중');
 assert.equal(redrawn.querySelector('.sc-hit-actions'),null,'an owned paper has nothing left to do');
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/Imported paper/);
 f.bench.destroy();
});

test('a single author is opened directly rather than offered as a choice of one',async()=>{
 const f=fixture();
 f.runtime.authorsOfCached=async()=>[{id:'A1',name:'Only Author',institution:'Somewhere',position:'first'}];
 await f.bench.show('authors');
 assert.ok(f.calls.find(c=>c[0]==='authorUpdates'),'their work should load without another click');
 assert.match(f.body().textContent,/h-index/);
 assert.match(f.body().textContent,/A topic/);
 f.bench.destroy();
});

test('asking for the paper’s senior author opens that person, and keeps the other authors one click away',async()=>{
 /* The item menu asks for this by name: the last-listed author is the lab's,
    which is who "track the PI" means. Landing on a list of five names and
    making the reader guess which one is the lab would answer nothing. */
 const f=fixture();
 await f.bench.show('authors','pi');
 assert.equal(f.calls.find(c=>c[0]==='authorUpdates')?.[1],'A2','the last author, not the first');
 assert.match(f.body().textContent,/B Author/);
 // The other authors are still reachable without going back to the library.
 await f.click('이 논문의 저자 2명 모두 보기');
 const names=[...f.body().querySelectorAll('.sc-hit-title')].map(n=>n.textContent);
 assert.deepEqual(names,['A Author','B Author']);
 // And the request is spent: drawing the tab again leaves the reader where they are.
 await f.bench.render();
 assert.deepEqual([...f.body().querySelectorAll('.sc-hit-title')].map(n=>n.textContent),['A Author','B Author']);
 f.bench.destroy();
});

test('a paper whose authors OpenAlex lists without a senior one still opens somebody',async()=>{
 const f=fixture();
 f.runtime.authorsOfCached=async()=>[{id:'A1',name:'Only Author',institution:'Somewhere',position:'first'}];
 await f.bench.show('authors','pi');
 assert.equal(f.calls.find(c=>c[0]==='authorUpdates')?.[1],'A1');
 f.bench.destroy();
});

test('two authors are listed for the user to choose between',async()=>{
 const f=fixture();
 await f.bench.show('authors');
 const names=[...f.body().querySelectorAll('.sc-hit-title')].map(n=>n.textContent);
 assert.deepEqual(names,['A Author','B Author']);
 assert.equal(f.calls.filter(c=>c[0]==='authorUpdates').length,0,'no author is opened on the user’s behalf');
 await f.click('최근 논문');
 assert.equal(f.calls.find(c=>c[0]==='authorUpdates')[1],'A1');
 f.bench.destroy();
});

test('following an author adds them to the panel and surfaces what is new next time',async()=>{
 const f=fixture();
 f.runtime.authorsOfCached=async()=>[{id:'A1',name:'Only Author',institution:'Somewhere',position:'first'}];
 await f.bench.show('authors');
 const headings=()=>[...f.body().querySelectorAll('.sc-hit-group')].map(n=>n.textContent);
 assert.equal(headings().some(h=>h.startsWith('관심 저자')),false,'nothing is followed yet');

 await f.click('관심 저자로 등록');
 // Everything already published becomes the baseline.
 const saved=f.calls.find(c=>c[0]==='watchAuthor')[1];
 assert.deepEqual(saved.seen,['W9']);
 assert.match(f.body().textContent,/마지막 확인 이후 새 논문 1/);

 // Re-opening the tab lists them, so they can be checked without the paper in hand.
 await f.bench.show('explore');await f.bench.show('authors');
 assert.ok(headings().includes('관심 저자 1'));

 await f.click('새 논문 1편 확인함');
 assert.ok(f.calls.find(c=>c[0]==='markSeen'),'marking as read is an explicit act');
 f.bench.destroy();
});

test('window chrome is icons, but every one still says what it does',async()=>{
 const f=fixture();await f.bench.toggle(true);
 const chrome=[...f.bench.panel.querySelectorAll('.sc-header-actions button')];
 assert.equal(chrome.length,5);
 for(const button of chrome){
  assert.ok(button.textContent.trim().length<=2,'chrome should be a glyph, not a sentence: '+button.textContent);
  // A glyph with no name is unusable by anyone who cannot see it.
  assert.ok(button.getAttribute('aria-label')||button.getAttribute('title'),'unnamed icon button');
 }
 assert.ok(chrome.some(b=>b.getAttribute('aria-label')==='작업 패널 닫기'));
 assert.ok(chrome.some(b=>b.getAttribute('aria-label')==='기능 찾기'));
 f.bench.destroy();
});

test('a journal is listed once, and its impact factor is stated once',async()=>{
 const f=fixture();
 f.runtime.publicationTags=()=>['IF 56.1 (2025)','JCR: Q1'];
 await f.bench.show('journals');
 const rows=[...f.body().querySelectorAll('.sc-journal')];
 assert.ok(rows.length,'journals should be listed');
 for(const row of rows){
  const text=row.textContent;
  assert.equal((text.match(/IF 56\.1/g)||[]).length<=1,true,'the impact factor was printed twice: '+text);
 }
 // The figure sits in its own column, one decimal, with its provenance in the tooltip.
 const figure=rows[0].querySelector('.sc-journal-if');
 assert.match(figure.textContent,/^\d+\.\d$/);
 assert.ok(figure.getAttribute('title'),'the provenance must remain available');
 // Actions live in the hover group, not inline in the card.
 assert.ok(rows[0].querySelector('.sc-hit-actions button'));
 f.bench.destroy();
});

test('chrome icons share one grid and one stroke, so they read as a set',async()=>{
 const f=fixture();await f.bench.toggle(true);
 const icons=[...f.bench.panel.querySelectorAll('.sc-header-actions button svg')];
 assert.equal(icons.length,5,'each chrome button should carry a drawn icon, not a text glyph');
 for(const svg of icons){
  // Unicode glyphs come from different blocks and land at different optical
  // sizes; a shared viewBox and stroke is what makes them look like one set.
  assert.equal(svg.getAttribute('viewBox'),'0 0 16 16');
  assert.equal(svg.getAttribute('width'),'16');
  assert.equal(svg.getAttribute('stroke-width'),'1.5');
  assert.equal(svg.getAttribute('stroke'),'currentColor','an icon must follow the button colour');
  assert.equal(svg.getAttribute('aria-hidden'),'true','the button is named; the glyph must not be read twice');
 }
 f.bench.destroy();
});

test('the toolbar button survives a document that rejects innerHTML on SVG',async()=>{
 // Gecko does not support innerHTML on an element built with createElementNS.
 // linkedom does, which is exactly why building the icons that way passed here
 // and then threw inside Zotero, aborting attach before the toolbar button was
 // ever created. Patching the shared prototype reproduces the real behaviour.
 const {parseHTML}=await import('linkedom');
 const probe=parseHTML('<html><body></body></html>');
 const svg=probe.document.createElementNS('http://www.w3.org/2000/svg','svg');
 const proto=Object.getPrototypeOf(svg);
 const original=Object.getOwnPropertyDescriptor(proto,'innerHTML');
 Object.defineProperty(proto,'innerHTML',{configurable:true,
  set(){throw new Error('innerHTML is not available on SVG here');},get(){return '';}});
 try{
  const f=fixture();
  await f.bench.toggle(true);
  const toolbarButton=f.doc.getElementById('style-custom-workbench-button');
  assert.ok(toolbarButton,'attach must reach the toolbar button');
  assert.match(toolbarButton.getAttribute('image'),/style-custom-toolbar\.svg$/);
  // The header icons must still be drawn, not silently skipped.
  assert.equal(f.bench.panel.querySelectorAll('.sc-header-actions button svg').length,5);
  f.bench.destroy();
 } finally {
  if(original)Object.defineProperty(proto,'innerHTML',original);
  else delete proto.innerHTML;
 }
});

test('the toolbar button does not repaint its icon in the toolbar ink', async () => {
  // The icon carries its own colours now. Passing fill: currentColor through
  // would flatten all three of them back to one grey.
  const {readFileSync} = await import('node:fs');
  const source = readFileSync(new URL('../src/workbench.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /-moz-context-properties/,
    'a context-fill glyph was replaced by a coloured one');
  assert.doesNotMatch(source, /toolbar\.style\.fill\s*=/);
  const f = fixture();
  const button = f.doc.getElementById('style-custom-workbench-button');
  assert.ok(button);
  assert.match(button.getAttribute('image') || '', /style-custom-toolbar\.svg$/);
  f.bench.destroy();
});

test('the library tab is not named as though it searched the literature',async()=>{
 // Browsing what you already have and searching for new papers are different
 // jobs in different plugins; sharing the name "문헌 탐색" conflated them.
 const explore=Workbench.TABS.find(([id])=>id==='explore');
 assert.equal(explore[1],'보유 문헌');
 assert.ok(!Workbench.TABS.some(([,label])=>label==='문헌 탐색'));
 const f=fixture();await f.bench.show('explore');
 assert.equal(f.bench.panel.querySelector('.sc-section-title').textContent,'보유 문헌');
 f.bench.destroy();
});

test('the panel says what has never been filled in, and offers to fill it', async () => {
 const f=fixture();
 f.runtime.backfillPending=async()=>({signals:1214,journals:169,authors:109});
 const ran=[];
 f.runtime.runBackfill=()=>{ran.push(1);return Promise.resolve({signals:{ok:1214,'not-found':0,error:0},journals:{found:160,missing:9},authors:{authors:109,withNews:3,works:7},budgetGone:false});};
 f.runtime.backfillSummary=()=>'채우기 완료';
 await f.bench.show('explore');
 const notice=f.bench.panel.querySelector('.sc-notice');
 assert.equal(notice.hidden,false,'three empty features must not stay invisible a second time');
 assert.match(notice.querySelector('.sc-notice-text').textContent,/1214편.*169종.*109명/);
 await f.click('지금 채우기');
 assert.equal(ran.length,1,'the button starts the sweep rather than only describing it');
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/채우기 완료/);
 f.bench.destroy();
});

test('nothing left to fill means nothing to say', async () => {
 const f=fixture();
 f.runtime.backfillPending=async()=>({signals:0,journals:0,authors:0});
 await f.bench.show('explore');
 assert.equal(f.bench.panel.querySelector('.sc-notice').hidden,true);
 f.bench.destroy();
});

test('a panel talking to an older runtime simply shows no notice', async () => {
 const f=fixture();
 delete f.runtime.backfillPending;
 await f.bench.show('explore');
 assert.equal(f.bench.panel.querySelector('.sc-notice').hidden,true);
 f.bench.destroy();
});

test('an author is shown as a person, with the people they publish with', async () => {
 const f=fixture();
 await f.bench.show('authors');
 await f.click('최근 논문');
 // A face stands in with initials until a portrait is found, and permanently
 // for anyone who has no public one.
 assert.equal(f.body().querySelector('.sc-face-text').textContent,'AA');
 const names=[...f.body().querySelectorAll('.sc-node-name')].map(n=>n.textContent);
 assert.deepEqual(names,['Sam Okafor','Kim Nguyen']);
 const meta=[...f.body().querySelectorAll('.sc-node-meta')].map(n=>n.textContent);
 assert.deepEqual(meta,['3편 · 2026','1편 · 2024']);
 // Thickness of the tie is how often they publish together, and nothing else.
 const ties=[...f.body().querySelectorAll('.sc-node')].map(n=>n.style.getPropertyValue('--sc-tie'));
 assert.deepEqual(ties,['1','0.3333333333333333']);
 f.bench.destroy();
});

test('a co-author is one click away, without leaving the tab', async () => {
 const f=fixture();
 await f.bench.show('authors');
 await f.click('최근 논문');
 f.calls.length=0;
 f.body().querySelector('.sc-node').dispatchEvent(new f.win.Event('click',{bubbles:true}));
 await new Promise(r=>setTimeout(r,0));
 assert.equal(f.calls.find(c=>c[0]==='authorUpdates')?.[1],'A7');
 f.bench.destroy();
});

test('what the scan found is reachable, and a duplicate can be dealt with', async () => {
 const f=fixture();
 const trashed=[];
 f.runtime.attachmentFindings=async()=>({
  supplementary:[{id:'1',fileID:'11',title:'A paper with extras',year:'2026',file:'si.pdf',why:'says so in its opening words'}],
  duplicate:[{id:'2',fileID:'22',title:'A paper attached twice',year:'2025',file:'again.pdf',why:''}],
  foreign:[{id:'3',fileID:'33',title:'Dali server',year:'2010',file:'other.pdf',why:'never uses the title'}],
  unknown:[],missing:[{id:'4',title:'A paper with no file',year:'2024'}],unread:0});
 f.runtime.trashAttachments=async ids=>{trashed.push(...ids);return {moved:ids.length,skipped:0};};
 await f.bench.show('attachments');
 const text=f.body().textContent;
 // 29 supplementary files, 17 duplicates and 6 mis-filed papers were detectable
 // and completely unreachable until this existed.
 assert.match(text,/보충자료 1/);
 assert.match(text,/같은 파일이 두 번 1/);
 assert.match(text,/다른 논문이 붙어 있음 1/);
 assert.match(text,/첨부파일 없음 1/);
 assert.match(text,/never uses the title/);
 await f.click('휴지통으로');
 assert.deepEqual(trashed,['22']);
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/휴지통/);
 f.bench.destroy();
});

test('a runtime that cannot answer leaves the attachments tab exactly as it was', async () => {
 const f=fixture();
 delete f.runtime.attachmentFindings;
 await f.bench.show('attachments');
 assert.ok(f.body().childNodes.length);
 assert.notEqual(f.bench.panel.querySelector('.sc-status').dataset.error,'true');
 f.bench.destroy();
});

test('every tab in the sidebar carries its own drawn icon',async()=>{
 const f=fixture();
 await f.bench.show('explore');
 const tabs=[...f.bench.panel.querySelectorAll('nav button[data-tab]')];
 assert.equal(tabs.length,19);
 const missing=tabs.filter(b=>!b.querySelector('.sc-nav-icon svg *')).map(b=>b.dataset.tab);
 assert.deepEqual(missing,[],'a tab without an icon is back to being a line of text');
 // Distinct shapes, or the icons are decoration rather than a way to find a tab.
 const shapes=tabs.map(b=>[...b.querySelectorAll('.sc-nav-icon svg *')]
  .map(n=>n.tagName+JSON.stringify([...n.attributes].map(a=>a.name+'='+a.value).sort())).join('|'));
 assert.equal(new Set(shapes).size,19);
 // The label stays: nineteen unlabelled glyphs would be a guessing game.
 assert.ok(tabs.every(b=>b.textContent.trim().length));
 f.bench.destroy();
});

test('followed authors are listed whether or not a paper happens to be selected',async()=>{
 const f=fixture();
 const rows=[{id:'A1',name:'Christopher A. Voigt',institution:'MIT',seen:[],checkedAt:'2026-09-17T00:00:00Z'},
  {id:'A2',name:'George M. Church',institution:'Harvard',seen:[],
   news:[{id:'W1',title:'A new paper',venue:'Nature',date:'2026-09-01'}]}];
 f.runtime.watchedAuthors=()=>rows;
 f.runtime.watchedAuthorsByNews=()=>rows.slice().sort((a,b)=>(b.news?.length||0)-(a.news?.length||0));
 f.setSelection([]);
 await f.bench.show('authors');
 // Ninety-five followed authors were invisible because the whole tab returned
 // early when no single paper was selected.
 const names=[...f.body().querySelectorAll('.sc-watch-name')].map(n=>n.textContent);
 // Whoever published floats up: the list should answer the question, not store it.
 assert.deepEqual(names,['George M. Church','Christopher A. Voigt']);
 const badges=[...f.body().querySelectorAll('.sc-watch-badge')].map(n=>n.textContent);
 assert.deepEqual(badges,['1'],'only the author with news is marked');
 // The subtitle earns its line: what the news is, not the same date on every row.
 const subs=[...f.body().querySelectorAll('.sc-watch-sub')].map(n=>n.textContent);
 assert.equal(subs[0],'2026-09 · Nature');
 assert.equal(subs[1],'MIT');
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/관심 저자 2명/);
 f.bench.destroy();
});

test('one sweep answers the watchlist for everyone, instead of opening them one by one',async()=>{
 const f=fixture();
 const rows=[{id:'A1',name:'Followed Person',institution:'Somewhere',seen:[]}];
 f.runtime.watchedAuthors=()=>rows;
 f.runtime.watchedAuthorsByNews=()=>rows;
 f.setSelection([]);
 await f.bench.show('authors');
 await f.click('새 논문 한 번에 확인');
 assert.ok(f.calls.find(c=>c[0]==='sweep'),'the whole list is checked in one action');
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/새 논문은 없습니다/);
 f.bench.destroy();
});

test('with a paper selected the watchlist stays, and its authors are offered too',async()=>{
 const f=fixture();
 f.runtime.watchedAuthorsByNews=f.runtime.watchedAuthors=()=>[{id:'A1',name:'Followed Person',institution:'Somewhere',seen:[]}];
 await f.bench.show('authors');
 const headings=[...f.body().querySelectorAll('.sc-hit-group')].map(n=>n.textContent);
 assert.ok(headings.some(h=>h.startsWith('관심 저자')),'the watchlist must not be replaced');
 assert.ok(headings.some(h=>h.startsWith('이 논문의 저자')),'the paper’s own authors are still offered');
 f.bench.destroy();
});

test('an empty watchlist with nothing selected explains what to do',async()=>{
 const f=fixture();
 f.runtime.watchedAuthorsByNews=f.runtime.watchedAuthors=()=>[];
 f.setSelection([]);
 await f.bench.show('authors');
 assert.match(f.body().textContent,/문헌을 하나 고르면 OpenAlex에서 그 논문의 저자를 찾고/);
 assert.notEqual(f.bench.panel.querySelector('.sc-status').dataset.error,'true');
 f.bench.destroy();
});

test('the toolbar button sits with the other tools, not off at the far edge', async () => {
  // The real order, read out of a running Zotero. Appended, the button landed
  // past the spacer, the search box and the item-pane toggle, alone at the edge
  // with nothing around it.
  const f = fixture(undefined, [
    ['zotero-tb-add', 'toolbarbutton'], ['zotero-tb-lookup', 'toolbarbutton'],
    ['zotero-lookup-panel', 'panel'],
    ['zotero-tb-attachment-add', 'toolbarbutton'], ['zotero-tb-note-add', 'toolbarbutton'],
    ['zotpop-toolbar-button', 'toolbarbutton'],
    ['', 'spacer'], ['zotero-tb-search', 'searchbox'],
    ['zotero-tb-toggle-item-pane-stacked', 'toolbarbutton']]);
  const bar = f.doc.getElementById('zotero-items-toolbar');
  const ids = [...bar.children].map(child => child.id || child.localName);
  assert.ok(ids.includes('style-custom-workbench-button'), 'the button is in the toolbar');
  // Both plugin buttons group at the end, in a fixed order, rather than trading
  // places depending on which one loaded first.
  assert.equal(ids[ids.indexOf('zotpop-toolbar-button') + 1], 'style-custom-workbench-button',
    'after the other plugin, which itself sits after the last Zotero tool');
  assert.ok(ids.indexOf('style-custom-workbench-button') < ids.indexOf('spacer'),
    'and before the spacer, rather than past the search box');
  f.bench.destroy();
});

test('a toolbar with nothing to anchor to still gets the button', async () => {
  // A button nobody can reach is worse than one badly placed.
  const f = fixture();
  assert.ok(f.doc.getElementById('style-custom-workbench-button'));
  f.bench.destroy();
  const g = fixture(undefined, [['', 'spacer'], ['zotero-tb-search', 'searchbox']]);
  const ids = [...g.doc.getElementById('zotero-items-toolbar').children].map(c => c.id || c.localName);
  assert.ok(ids.indexOf('style-custom-workbench-button') < ids.indexOf('zotero-tb-search'),
    'with no tools to follow, it goes before the spacer');
  g.bench.destroy();
});

test('every gated action label in the panel is one the gate actually knows', async () => {
  // The gate is keyed on the button's Korean label, so renaming a button
  // silently ungated it: "참조 노트 보기" became "참조 노트" and the backlinks
  // feature switch stopped covering it.
  const {readFileSync} = await import('node:fs');
  const source = readFileSync(new URL('../src/workbench.js', import.meta.url), 'utf8');
  const map = /const actionFeature=\{([^}]*)\}/.exec(source)[1];
  const gated = [...map.matchAll(/'([^']+)':'[^']+'/g)].map(m => m[1]);
  for (const label of ['선택 주석 색 바꾸기', '선택 주석 병합', '참조 노트']) {
    assert.ok(gated.includes(label), `${label} is drawn but not gated`);
  }
});

test('a memo saves itself, says so, and is not lost when the panel closes', async () => {
  const f = fixture();
  const saved = [];
  f.library.annotations = f.record('annotations',
    [{id: '3', text: 'A highlighted sentence', comment: '', color: '#ffd400', type: 'highlight', pageIndex: 0, attachmentID: '9'}]);
  f.library.setAnnotationComment = async (id, text) => { saved.push([id, text]); return text; };
  await f.bench.show('annotations');
  // Scoped to the annotation: the paper's own memo shares the class and is
  // drawn first, so an unscoped query picks up the wrong one.
  /* A textarea under every one of six hundred highlights, each showing the
     word "memo", was most of what the tab drew. It appears for an annotation
     that has one, and for any annotation the reader asks. */
  assert.equal(f.body().querySelector('.sc-annot .sc-annot-memo'), null, 'nothing written yet, nothing drawn');
  await f.click('메모');
  const memo = f.body().querySelector('.sc-annot .sc-annot-memo');
  assert.ok(memo, 'asking for one gives an editable memo');

  // Writing a note used to mean making a whole note item and pressing a button.
  memo.value = 'this is the claim to check';
  memo.dispatchEvent(new f.win.Event('input', {bubbles: true}));
  assert.equal(saved.length, 0, 'it waits rather than writing on every keystroke');

  // Leaving the field commits at once: waiting out the timer after the panel has
  // closed would lose the edit.
  memo.dispatchEvent(new f.win.Event('blur', {bubbles: true}));
  await settle();
  assert.deepEqual(saved, [['3', 'this is the claim to check']]);
  assert.equal(memo.dataset.state, 'saved', 'an edit that vanished without a word would be worse than a button');
  f.bench.destroy();
});

test('a failure to save a memo is said out loud, not swallowed', async () => {
  const f = fixture();
  f.library.annotations = f.record('annotations',
    [{id: '3', text: 'Text', comment: '', color: '#ffd400', type: 'highlight', pageIndex: 0, attachmentID: '9'}]);
  f.library.setAnnotationComment = async () => { throw new Error('read-only library'); };
  await f.bench.show('annotations');
  await f.click('메모');
  const memo = f.body().querySelector('.sc-annot .sc-annot-memo');
  memo.value = 'x';
  memo.dispatchEvent(new f.win.Event('blur', {bubbles: true}));
  await settle();
  assert.equal(memo.dataset.state, 'failed');
  assert.match(f.bench.panel.querySelector('.sc-status').textContent, /저장하지 못했습니다/);
  f.bench.destroy();
});

test('the annotation list reads as a pass through the paper', async () => {
  const f = fixture();
  f.library.annotations = f.record('annotations', [
    {id: '5', text: 'Later', comment: '', color: '#a28ae5', type: 'highlight', pageIndex: 8, attachmentID: '9'},
    {id: '3', text: 'Earlier', comment: '', color: '#ffd400', type: 'underline', pageIndex: 1, attachmentID: '9'}
  ]);
  await f.bench.show('annotations');
  const texts = [...f.body().querySelectorAll('.sc-annot-text')].map(el => el.textContent);
  assert.deepEqual(texts, ['Earlier', 'Later'], 'page order, which is the order they were made in');
  // The colour tally doubles as a filter, so a reader can pull out one pass.
  const swatches = [...f.body().querySelectorAll('.sc-annot-swatch')];
  assert.equal(swatches.length, 2);
  swatches[0].dispatchEvent(new f.win.Event('click', {bubbles: true}));
  await settle();
  assert.ok(f.bench.state.color, 'clicking a colour narrows to it');
  f.bench.destroy();
});

test('a journal profile labels stored metrics and OpenAlex fields while path choices filter the list',async()=>{
 // Stored JIF/Q and OpenAlex profiles keep their separate provenance.
 const f=fixture();
 f.runtime.journalIdentity={identify:venue=>venue==='Science'?{quartile:1,abbreviation:'SCIENCE',issns:['0036-8075'],impactFactor:44.7,year:2025,publisher:'AAAS'}:{quartile:1,abbreviation:'NATURE',issns:['0028-0836'],impactFactor:50.5,year:2025,publisher:'Springer Nature'}};
 f.runtime.journalRecord=ref=>({name:String(ref.id)==='1'?'Science':'Nature',issn:''});
 f.runtime.journalProfile=ref=>String(ref.id)==='1'?{citedness:7.0,fields:['Multidisciplinary','Engineering'],topics:[{name:'Everything',domain:'Life Sciences',field:'Multidisciplinary',subfield:'General',count:9},{name:'Bio eng',domain:'Physical Sciences',field:'Engineering',subfield:'Biomedical Engineering',count:4}],hIndex:1200,works:250000,isOA:false,inDoaj:false,apc:4000,country:'US',homepage:'https://www.science.org/',openAlexID:'S3880285'}:null;
 await f.bench.show('journals');
 // One line, three menus, largest first; every level can be picked on its own.
 const menu=level=>f.body().querySelector(`.sc-field-line select[data-level=${level}]`);
 const optionsOf=level=>[...menu(level).querySelectorAll('option')].map(o=>o.textContent);
 const choose=(level,value)=>{const m=menu(level);const option=[...m.querySelectorAll('option')].find(o=>{try{return JSON.parse(o.value).at(-1)===value;}catch{return o.value===value;}});assert.ok(option,value);m.value=option.value;m.dispatchEvent(new f.win.Event('change',{bubbles:true}));};
 assert.deepEqual(optionsOf('domain'),['전체 · 2개','분야 미상 · 1','Life Sciences 1','Physical Sciences 1'],
  'the first option counts the subjects on offer; all three menus used to repeat the journal count instead');
 assert.deepEqual(optionsOf('field'),['전체 · 2개','Multidisciplinary 1','Engineering 1'],'fields are offered before a domain is chosen');
 assert.deepEqual([...f.body().querySelectorAll('.sc-field-line .sc-field-level')].map(x=>x.textContent),['대분류','분야','세부 분야'],'each menu has its caption beside it');
 assert.deepEqual([...menu('field').querySelectorAll('optgroup')].map(g=>g.getAttribute('label')),['Life Sciences','Physical Sciences'],'grouped under their domains');
 // Nothing is open yet; opening a journal lays out its facts.
 assert.equal(f.body().querySelector('.sc-facts'),null);
 await f.click('Science');
 const facts=[...f.body().querySelectorAll('.sc-fact dt')].map(dt=>dt.textContent);
 assert.deepEqual(facts,['JIF','저장 Q','약어','출판사','ISSN','OpenAlex 분야','h-index','발행·피인용','오픈액세스','국가','홈페이지','내 서재']);
 for(const dt of f.body().querySelectorAll('.sc-fact dt'))assert.ok(dt.querySelector('svg'),'each fact carries its sign: '+dt.textContent);
 const value=label=>[...f.body().querySelectorAll('.sc-fact')].find(r=>r.querySelector('dt').textContent===label).querySelector('dd').textContent;
 assert.equal(value('JIF'),'44.7 · 2025','the local comparison uses the registry JIF, not a stale paper-level value');
 assert.equal(value('ISSN'),'0036-8075');
 assert.equal(value('오픈액세스'),'구독형 · OA 선택 시 APC $4,000');
 assert.equal(value('국가'),'미국');
 assert.match(value('내 서재'),/^1편 · 읽음 0 · 평균 피인용 3 · 2025$/);
 assert.ok([...f.body().querySelectorAll('button')].some(b=>b.textContent==='JCR에서 보기'),'the JCR page is one click away');
 // Choosing a domain narrows the menus to its right.
 choose('domain','Physical Sciences');await settle();
 assert.deepEqual(optionsOf('field'),['전체 · 1개','Engineering 1']);
 assert.deepEqual([...f.body().querySelectorAll('.sc-journal')].map(r=>r.dataset.venue),['Science']);
 choose('field','Engineering');await settle();
 assert.deepEqual(optionsOf('subfield'),['전체 · 1개','Biomedical Engineering 1']);
 // A subfield chosen on its own pulls the levels above it along.
 await f.click('전체');await settle();
 choose('subfield','General');await settle();
 assert.equal(menu('domain').value,JSON.stringify(['Life Sciences']));assert.equal(menu('field').value,JSON.stringify(['Life Sciences','Multidisciplinary']));
 assert.deepEqual([...f.body().querySelectorAll('.sc-journal')].map(r=>r.dataset.venue),['Science']);
 await f.click('전체');await settle();
 assert.equal(f.body().querySelectorAll('.sc-journal').length,2,'back to every journal');
 // Each journal is one row: rank, name, quartile, abbreviation, house, papers, fields, place in field, figure.
 const first=f.body().querySelector('tr.sc-journal');
 assert.equal(first.querySelectorAll('td').length,9);
 assert.deepEqual([...f.body().querySelectorAll('.sc-journal-table thead th')].map(th=>th.textContent),['로컬 JIF 순번','저널','저장 Q','약어','출판사','내 문헌','OpenAlex 분야','로컬 분야 순위','JIF 2025']);
 assert.equal(first.querySelector('.sc-col-q .sc-quartile').textContent,'Q1?');
 assert.equal(first.querySelector('.sc-col-abbr').textContent,'NATURE','sorted by IF, Nature first');
 // The journals have a search of their own, by name, abbreviation, publisher or field.
 const typed=async value=>{f.input('저널 검색',value);await new Promise(r=>setTimeout(r,160));await settle();};
 await typed('biomedical');
 assert.deepEqual([...f.body().querySelectorAll('.sc-journal')].map(r=>r.dataset.venue),['Science'],'found by subfield');
 await typed('nature');
 assert.deepEqual([...f.body().querySelectorAll('.sc-journal')].map(r=>r.dataset.venue),['Nature']);
 assert.equal(f.body().querySelectorAll('.sc-journal-controls input[type=search]').length,1,'the list redrew under the same box');
 await typed('');
 // Grouped by field, the journal without a profile sits under "field unknown".
 await f.click('분야별로 묶기');
 assert.deepEqual([...f.body().querySelectorAll('.sc-hit-group')].map(h=>h.textContent),['Life Sciences › Multidisciplinary · 1종','분야 미확인 · 1종']);
 f.bench.destroy();
});

test('the library splits by kind with one chip: patents and theses apart from the papers',async()=>{
 const f=fixture();
 const extra=[{id:'7',key:'K7',libraryID:1,title:'A Thesis',authors:'Grad Student',year:'2024',venue:'',itemType:'thesis',tags:[],abstract:'',related:[]},
  {id:'8',key:'K8',libraryID:1,title:'A Preprint',authors:'Some One',year:'2026',venue:'bioRxiv',itemType:'preprint',tags:[],abstract:'',related:[]}];
 f.library.snapshot=async()=>[...f.papers,...extra];
 await f.bench.show('explore');
 const chips=[...f.bench.panel.querySelectorAll('.sc-kind-chips button')].map(b=>b.textContent);
 assert.deepEqual(chips,['전체 4','논문 2','프리프린트 1','학위논문 1']);
 // The card says what kind of thing it is, unless it is a plain paper.
 const kinds=[...f.body().querySelectorAll('.sc-paper-card')].map(c=>c.querySelector('.sc-kind')?.textContent||'');
 assert.deepEqual(kinds.sort(),['','','프리프린트','학위논문']);
 await f.click('학위논문 1');
 assert.deepEqual([...f.body().querySelectorAll('.sc-paper-title')].map(h=>h.textContent),['학위논문A Thesis']);
 assert.equal(f.bench.panel.querySelector('.sc-kind-chips button[data-kind=thesis]').getAttribute('aria-pressed'),'true');
 // The select says the same thing in the same words.
 assert.equal(f.bench.panel.querySelector('select[aria-label="문헌 유형 필터"]').value,'thesis');
 await f.click('학위논문 1');
 assert.equal(f.body().querySelectorAll('.sc-paper-card').length,4);
 f.bench.destroy();
});

test('the map names its commonest journals in their own colours, and a card wears its journal mark',async()=>{
 const f=fixture();
 f.runtime.journalIdentity={identify:venue=>({mark:venue.slice(0,3).toUpperCase(),hue:200,label:''}),colours:()=>({fill:'#dde','ink':'#335',edge:'#99a'})};
 f.runtime.palette=()=>({dark:false});
 f.runtime.journalMarkForVenue=(doc,venue)=>{const m=doc.createElement('span');m.className='sc-mark';m.textContent=venue.slice(0,3).toUpperCase();return m;};
 await f.bench.show('graph');
 const legend=[...f.body().querySelectorAll('.sc-legend-entry')].map(e=>e.textContent);
 assert.deepEqual(legend,['Science1','Nature1','내 라이브러리에 없음','공통 참고문헌'],'both journals, then the two shapes the map uses');
 assert.equal(f.body().querySelectorAll('.sc-legend-entry .sc-legend-dot').length,3,'a swatch in the node\'s own paint, plus the dashed outside square');
 assert.ok(f.body().querySelector('.sc-legend-line'),'and the dashed tie');
 await f.bench.show('explore');
 assert.deepEqual([...f.body().querySelectorAll('.sc-paper-meta .sc-mark')].map(m=>m.textContent).sort(),['NAT','SCI']);
 f.bench.destroy();
});

test('markup in a title is drawn as italics and subscripts, not shown as tags',async()=>{
 const f=fixture();
 f.library.snapshot=async()=>[{...f.papers[0],title:'Establishing a <i>Bacillus subtilis</i> CO<sub>2</sub> route'},f.papers[1]];
 await f.bench.show('explore');
 const h3=[...f.body().querySelectorAll('.sc-paper-title')].find(h=>h.textContent.includes('Bacillus'));
 assert.equal(h3.querySelector('i').textContent,'Bacillus subtilis');
 assert.equal(h3.querySelector('sub').textContent,'2');
 assert.ok(!h3.textContent.includes('<i>'),'no tag text: '+h3.textContent);
 assert.equal(h3.getAttribute('title'),'Establishing a Bacillus subtilis CO2 route','attributes get the plain words');
 // Anything outside the six inline tags stays literal.
 const p=f.body().ownerDocument.createElement('p');
 f.bench.panel.appendChild(p);
 f.bench.destroy();
});

test('one press fills the window, the next puts the panel back, and the choice is remembered',async()=>{
 const f=fixture();
 await f.bench.show('explore');
 const b=f.bench.panel.querySelector('button[aria-label="전체 화면 전환"]');
 assert.equal(f.bench.panel.dataset.maximized,'false');
 b.dispatchEvent(new f.win.Event('click',{bubbles:true}));
 assert.equal(f.bench.panel.dataset.maximized,'true');
 assert.equal(b.getAttribute('aria-pressed'),'true');
 assert.equal(f.runtime.cache.workbenchUI.maximized,true);
 f.bench.panel.querySelector('.sc-brand').dispatchEvent(new f.win.Event('dblclick',{bubbles:true}));
 assert.equal(f.bench.panel.dataset.maximized,'false');
 f.bench.destroy();
 const again=fixture({items:{},readerSettings:{},workbenchUI:{maximized:true}});
 await again.bench.show('explore');
 assert.equal(again.bench.panel.dataset.maximized,'true','restored from the saved choice');
 again.bench.destroy();
});

test('the comparison table reads its papers together and keeps the reading as a note',async()=>{
 const f=fixture();
 await f.bench.show('matrix');await f.bench.load();
 // Both papers in the table: two is enough to read together.
 f.bench.state.selected=new Set(['1','2']);await f.bench.render();
 assert.ok(f.findButton('함께 읽기'));
 assert.equal(f.findButton('함께 읽기').disabled,false);
 await f.click('함께 읽기');
 const ai=f.calls.find(c=>c[0]==='ai');
 assert.equal(ai[1],'compare');
 assert.deepEqual(ai[2].map(p=>p.id),['1','2']);
 const box=f.body().querySelector('.sc-compare-output');
 assert.equal(box.hidden,false);assert.equal(box.value,'Generated result');
 await f.click('첫 문헌의 노트로 저장');
 const note=f.calls.find(c=>c[0]==='createNote');
 assert.equal(note[1],'1');assert.match(note[2],/^함께 읽기 \(Paper Alpha · Paper Beta\)\n\nGenerated result$/);
 f.bench.destroy();
});

test('the followed list can be tended as a table: found, sorted, let go',async()=>{
 const f=fixture();
 const rows=[{id:'A1',name:'Ada',institution:'MIT',institutionGiven:'MIT chemistry',sweptAt:'2026-09-01T00:00:00Z',news:[{id:'W1'}],seen:[]},
  {id:'A2',name:'Bo',institution:'Broad Institute',moved:{from:'Harvard University',to:'Broad Institute',rule:2},sweptAt:'2026-08-01T00:00:00Z',news:[],seen:[]},
  {id:'A3',name:'Cy',institution:'',news:[],seen:[]}];
 f.runtime.watchedAuthors=()=>rows;f.runtime.watchedAuthorsByNews=()=>rows;
 f.runtime.unwatchAuthor=async id=>{f.calls.push(['unwatchAuthor',id]);const i=rows.findIndex(r=>r.id===id);if(i>=0)rows.splice(i,1);};
 await f.bench.show('authors');
 await f.click('목록 관리');
 const names=()=>[...f.body().querySelectorAll('.sc-watch-table td:first-child button')].map(b=>b.textContent);
 assert.deepEqual(names(),['Ada','Bo','Cy'],'news first');
 const place=f.body().querySelector('.sc-watch-table tbody tr:nth-child(1) td:nth-child(2)');
 assert.equal(place.getAttribute('title'),'등록 당시: MIT chemistry');
 assert.ok(f.body().querySelector('.sc-watch-table tbody tr:nth-child(2) td.sc-watch-moved'),'a move is shaded');
 assert.deepEqual([...f.body().querySelectorAll('.sc-watch-table thead th')].map(t=>t.textContent),['이름','소속','마지막 확인','새 논문','특허','']);
 f.input('관심 저자 찾기','bo');
 assert.deepEqual(names(),['Bo']);
 f.input('관심 저자 찾기','');
 const sort=f.body().querySelector('select[aria-label="관심 저자 정렬"]');sort.value='checked';sort.dispatchEvent(new f.win.Event('change',{bubbles:true}));
 assert.deepEqual(names(),['Cy','Bo','Ada'],'longest unchecked first');
 // Letting someone go takes two presses: the first only arms the button.
 await f.click('해제');
 assert.ok(!f.calls.find(c=>c[0]==='unwatchAuthor'),'one press does nothing yet');
 await f.click('정말 해제');
 assert.ok(f.calls.find(c=>c[0]==='unwatchAuthor'&&c[1]==='A3'));
 assert.deepEqual(names(),['Bo','Ada']);
 await f.click('카드로 보기');
 assert.equal(f.body().querySelector('.sc-watch-table'),null);
 f.bench.destroy();
});

test('one chip keeps only the followed authors with something new',async()=>{
 const f=fixture();
 const rows=[{id:'A1',name:'Ada',news:[{id:'W1'}],seen:[]},{id:'A2',name:'Bo',news:[],seen:[]},{id:'A3',name:'Cy',news:[],moved:{from:'X',to:'Y',rule:2},seen:[]}];
 f.runtime.watchedAuthors=()=>rows;f.runtime.watchedAuthorsByNews=()=>rows;
 await f.bench.show('authors');
 const names=()=>[...f.body().querySelectorAll('.sc-watch-name')].map(n=>n.textContent);
 assert.deepEqual(names(),['Ada','Bo','Cy']);
 await f.click('새 소식만');
 assert.deepEqual(names(),['Ada','Cy'],'news or a move counts; a quiet card does not');
 await f.click('모두 보기');
 assert.deepEqual(names(),['Ada','Bo','Cy']);
 f.bench.destroy();
});

test('the panel can live in a Zotero tab, remembers it, and comes back when the tab closes',async()=>{
 const f=fixture();
 const tabs=[];let onClose=null;
 f.win.Zotero_Tabs={add(spec){const container=f.doc.createElement('div');container.className='tab-container';tabs.push(['add',spec.type,spec.title]);onClose=spec.onClose;return {id:'tab-9',container};},select(id){tabs.push(['select',id]);},close(id){tabs.push(['close',id]);const fn=onClose;onClose=null;fn?.();}};
 await f.bench.show('explore');
 const dockButton=f.bench.panel.querySelector('.sc-dock');
 assert.equal(dockButton.hidden,false,'offered when the window has tabs');
 dockButton.dispatchEvent(new f.win.Event('click',{bubbles:true}));
 assert.deepEqual(tabs[0].slice(0,2),['add','style-custom-workbench']);
 assert.equal(f.bench.panel.parentNode.className,'tab-container','the same element, moved into the tab');
 assert.equal(f.bench.panel.dataset.docked,'tab');
 assert.equal(f.runtime.cache.workbenchUI.docked,true,'remembered');
 // Opening again while docked selects the tab; closing the panel closes the tab.
 await f.bench.show('graph');
 assert.ok(tabs.some(t=>t[0]==='select'&&t[1]==='tab-9'));
 await f.bench.toggle(false);
 assert.ok(tabs.some(t=>t[0]==='close'&&t[1]==='tab-9'));
 assert.equal(f.bench.panel.parentNode,f.doc.documentElement,'back over the window');
 assert.equal(f.bench.panel.hidden,true);
 // The next open goes straight to a tab, because that is what was chosen.
 await f.bench.show('explore');
 assert.equal(f.bench.panel.dataset.docked,'tab');
 assert.equal(tabs.filter(t=>t[0]==='add').length,2);
 // The user closes the tab from the tab bar: the panel hides and waits.
 f.win.Zotero_Tabs.close('tab-9');
 assert.equal(f.bench.panel.hidden,true);
 assert.equal(f.bench.panel.dataset.docked,undefined);
 // Floating again on request, and that is remembered too.
 await f.bench.show('explore');
 f.bench.panel.querySelector('.sc-dock').dispatchEvent(new f.win.Event('click',{bubbles:true}));
 assert.equal(f.bench.panel.dataset.docked,undefined);
 assert.equal(f.bench.panel.hidden,false,'still open, floating');
 assert.equal(f.runtime.cache.workbenchUI.docked,false);
 f.bench.destroy();
});

test('the pages of a paper read as a strip of shaded squares, with the number and the seconds in the tooltip',async()=>{
 const f=fixture();
 await f.bench.show('reading');
 const cells=[...f.body().querySelector('.sc-page-strip').querySelectorAll('.sc-page-cell')];
 assert.equal(cells.length,100,'one square per page of the first hundred');
 assert.equal(cells[0].dataset.level,'0','two seconds is a glance, not reading');assert.equal(cells[1].dataset.level,'0');
 assert.equal([...f.body().querySelectorAll('.sc-page-strip .sc-page-row')].slice(0,5).map(r=>r.textContent).join(','),'1,21,41,61,81','a row label every twenty pages');
 assert.equal(cells[0].getAttribute('title'),'1페이지 · 2초');
 assert.equal(cells[0].textContent,'','no number on the square');
 assert.ok(f.body().querySelector('.sc-page-legend'),'a key from little to much');
 f.bench.destroy();
});

test('the journals tab shows the stored catalog with local positions and absent-library markers',async()=>{
 const f=fixture();
 const registry=[{title:'Nature',rank:1,key:'nature',issns:['0028-0836'],abbreviation:'NATURE',impactFactor:50.5,year:2025,quartile:1,publisher:'Nature Portfolio'},
  {title:'Science',rank:2,key:'science',issns:['0036-8075'],abbreviation:'SCIENCE',impactFactor:44.7,year:2025,quartile:1,publisher:'AAAS'},
  {title:'Cell',rank:3,key:'cell',issns:['0092-8674'],abbreviation:'CELL',impactFactor:42.5,year:2025,quartile:1,publisher:'Cell Press'}];
 f.runtime.journalIdentity={identify:venue=>{const r=registry.find(x=>x.title===venue);return r?{quartile:r.quartile,abbreviation:r.abbreviation,issns:r.issns,impactFactor:r.impactFactor,year:r.year,publisher:r.publisher}:null;},
  registryRanked:()=>registry,registryRank:title=>registry.find(x=>x.title===title)?.rank||null};
 await f.bench.show('journals');
 // The library view first: two journals, each with its place among all.
 assert.deepEqual([...f.body().querySelectorAll('tr.sc-journal')].map(r=>[r.dataset.venue,r.querySelector('.sc-col-rank').textContent]),[['Nature','1'],['Science','2']]);
 await f.click('저장 저널 3');
 const rows=[...f.body().querySelectorAll('tr.sc-journal')];
 assert.deepEqual(rows.map(r=>r.dataset.venue),['Nature','Science','Cell'],'every registry journal, in JIF order');
 assert.equal(rows[2].classList.contains('sc-journal-absent'),true,'Cell is not in this library');
 assert.equal(rows[2].querySelector('.sc-col-n').textContent,'—');
 assert.equal(rows[0].querySelector('.sc-col-n').textContent,'1');
 assert.match(f.body().querySelector('.sc-journal-count').textContent,/저장 저널 3종 · OpenAlex 분야 있음 \d+ · 내 서재 2/);
 // Opening an absent journal still shows its registry facts and its rank.
 await f.click('Cell');
 const value=label=>[...f.body().querySelectorAll('.sc-fact')].find(r=>r.querySelector('dt').textContent===label)?.querySelector('dd').textContent;
 assert.equal(value('JIF'),'42.5 · 2025');
 assert.equal(value('로컬 JIF 순번'),'3번째 / 3');
 assert.equal(value('내 서재'),'없음');
 await f.click('내 서재 2');
 assert.equal(f.body().querySelectorAll('tr.sc-journal').length,2);
 f.bench.destroy();
});

test('a selection scope with nothing selected falls back to the library, and the way back is a button',async()=>{
 const f=fixture();
 await f.bench.show('explore');
 await f.click('자세히');
 assert.equal(f.bench.state.scope,'selected');
 assert.ok(f.findButton('전체 목록으로'),'the way back is offered while narrowed');
 // The selection goes away (a click elsewhere in the tree): the list must not stay empty.
 f.bench.state.selected=new Set();await f.bench.render();
 assert.equal(f.bench.state.scope,'library');
 assert.equal(f.bench.panel.querySelector('[aria-label="표시 범위"]').value,'library');
 assert.equal(f.body().querySelectorAll('.sc-paper-card').length,2);
 assert.ok(!f.findButton('전체 목록으로'),'the way back is gone once the list is whole');
 f.bench.destroy();
});

test('every button on every tab survives a press without throwing, and the tab still draws',async()=>{
 /* The user asked for the things that cannot be clicked. In this fixture the
    library and the network are stubs, so nearly every button can be pressed;
    only the ones that let go of something are skipped. A handler that
    throws surfaces as a status line naming a JavaScript error, which is the
    one message a user must never read. */
 const f=fixture();
 f.runtime.journalIdentity={identify:()=>({quartile:1,abbreviation:'X',issns:[],impactFactor:1,year:2025}),colours:()=>({fill:'#eee',ink:'#333',edge:'#999'}),registryRanked:()=>[],registryRank:()=>null};
 const skip=/휴지통|정말|해제 \(|병합|삭제/;
 const jsError=/TypeError|ReferenceError|RangeError|is not a function|Cannot read|Cannot set|undefined|null|NaN/;
 const pressed=[],broken=[];
 const tabs=f.bench.constructor?.TABS||[['explore'],['recent'],['related'],['authors'],['collections'],['journals'],['reading'],['notes'],['annotations'],['attachments'],['backlinks'],['tags'],['graph'],['canvas'],['matrix'],['tabs'],['views'],['assist'],['appearance']];
 for(const [tab] of tabs){
  await f.bench.show(tab);await f.bench.load();
  const seen=new Set();
  for(let round=0;round<3;round++){
   const buttons=[...f.body().querySelectorAll('button')].filter(b=>!b.disabled&&!b.hidden&&b.textContent.trim()&&!skip.test(b.textContent)&&!seen.has(b.textContent.trim()));
   if(!buttons.length)break;
   for(const b of buttons){
    const label=b.textContent.trim();seen.add(label);
    if(!b.isConnected)continue;
    b.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
    pressed.push(tab+': '+label);
    const status=f.bench.panel.querySelector('.sc-status');
    if(status&&status.dataset.error==='true'&&jsError.test(status.textContent))broken.push(`${tab} · ${label} → ${status.textContent}`);
    if(f.bench.state.tab!==tab){await f.bench.show(tab);await f.bench.load();}
   }
  }
 }
 assert.deepEqual(broken,[],'a press must never surface a JavaScript error');
 assert.deepEqual(f.errors,[],'nothing reached logError');
 assert.ok(pressed.length>25,'the sweep pressed '+pressed.length+' buttons');
 f.bench.destroy();
});

test('the first open explains the panel once and never again',async()=>{
 const f=fixture();await f.bench.toggle(true);
 const welcome=f.bench.panel.querySelector('.sc-welcome');
 assert.ok(welcome&&!welcome.hidden,'the first open says what the panel is');
 assert.match(welcome.textContent,/처음 여셨네요/);
 assert.equal(f.bench.panel.querySelectorAll('.sc-notice:not(.sc-welcome)').length,1,'the welcome line is not the backfill notice');
 const ok=[...welcome.querySelectorAll('button')].find(b=>b.textContent==='알겠어요');
 assert.ok(ok,'it can be dismissed');ok.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.equal(welcome.hidden,true);assert.equal(f.runtime.cache.workbenchUI.welcomed,true,'the dismissal is remembered');
 await f.bench.toggle(false);await f.bench.toggle(true);
 assert.equal(f.bench.panel.querySelector('.sc-welcome').hidden,true,'a later open stays quiet');
 f.bench.destroy();
 const seen=fixture({items:{},readerSettings:{},workbenchUI:{welcomed:true}});await seen.bench.toggle(true);
 assert.equal(seen.bench.panel.querySelector('.sc-welcome').hidden,true,'a returning user never sees it');
 seen.bench.destroy();
});

test('every button that opens a Zotero window is marked so a sweep can leave it alone',async()=>{
 const f=fixture();
 const marked=[];
 for(const tab of ['papers','notes','annotations','backlinks','attachments']){
  await f.bench.show(tab);
  for(const b of f.bench.panel.querySelectorAll('.sc-body button'))if(b.hasAttribute('data-opens'))marked.push(b.textContent);
 }
 await f.bench.show('papers');
 const open=[...f.bench.panel.querySelectorAll('.sc-body button')].find(b=>b.textContent==='열기');
 assert.ok(open,'the paper card still offers to open the item');
 assert.equal(open.getAttribute('data-opens'),'window','and declares that it opens a window');
 f.bench.destroy();
});

test('the journals table says where each one stands inside its own subject', async () => {
 /* The reader asked for this by name: 분야 내 몇 위. The three subject menus
    also used to repeat one figure -- the journals placed -- in all three, which
    read as though the subject list itself were that short. */
 const f = fixture();
 const registry = [
  {title: 'Top Review', rank: 1, key: 'top review', issns: [], abbreviation: 'TOP REV', impactFactor: 60, year: 2025, quartile: 1, publisher: 'Nature Portfolio',
   levels: [{domain: 'Life Sciences', field: 'Biology', subfield: 'Molecular Biology'}]},
  {title: 'Cell', rank: 2, key: 'cell', issns: [], abbreviation: 'CELL', impactFactor: 42.5, year: 2025, quartile: 1, publisher: 'Cell Press',
   levels: [{domain: 'Life Sciences', field: 'Biology', subfield: 'Molecular Biology'}]}
 ];
 const ranks = {
  'Top Review': [{level: 'subfield', name: 'Molecular Biology', rank: 1, of: 1813, percentile: 1, quartile: 1}],
  'Cell': [{level: 'subfield', name: 'Molecular Biology', rank: 12, of: 1813, percentile: 1, quartile: 1},
           {level: 'field', name: 'Biology', rank: 40, of: 2996, percentile: 2, quartile: 1}]
 };
 f.runtime.journalIdentity = {
  identify: venue => registry.find(x => x.title === venue) || null,
  registryRanked: () => registry,
  registryRank: title => registry.find(x => x.title === title)?.rank || null,
  registryLevels: title => registry.find(x => x.title === title)?.levels || [],
  registryFieldRanks: title => ranks[title] || []
 };
 await f.bench.show('journals');
 await f.click('저장 저널 2');
 const places = [...f.body().querySelectorAll('tr.sc-journal .sc-col-fieldrank')];
 assert.deepEqual(places.map(td => td.textContent), ['1/1,813', '12/1,813']);
 // Every subject it is ranked in, for a journal that sits in more than one.
 assert.match(places[1].title, /Molecular Biology 1,813종 중 12위 · 상위 1% · 로컬 Q1/);
 assert.match(places[1].title, /Biology 2,996종 중 40위/);
 // The menus count the subjects they offer, not the journals underneath them.
 const first = f.body().querySelector('.sc-field-line select[data-level="domain"] option');
 assert.equal(first.textContent, '전체 · 1개');
 f.bench.destroy();
});

test('a journal the library does not hold is still placed in the subject hierarchy', async () => {
 /* The three subject menus used to count only the journals the library held
    and had a profile for, so "전체 · 22594" sat above menus totalling a couple
    of hundred. The registry carries a subject for each row, and a row without
    one can be asked for on its own. */
 const f = fixture();
 const registry = [
  {title: 'Nature', rank: 1, key: 'nature', issns: ['0028-0836'], abbreviation: 'NATURE', impactFactor: 50.5, year: 2025, quartile: 1, publisher: 'Nature Portfolio',
   levels: [{domain: 'Life Sciences', field: 'Biochemistry, Genetics and Molecular Biology', subfield: 'Molecular Biology'}]},
  {title: 'Cell', rank: 2, key: 'cell', issns: ['0092-8674'], abbreviation: 'CELL', impactFactor: 42.5, year: 2025, quartile: 1, publisher: 'Cell Press',
   levels: [{domain: 'Life Sciences', field: 'Biochemistry, Genetics and Molecular Biology', subfield: 'Cell Biology'}]},
  {title: 'Some Bulletin', rank: 3, key: 'some bulletin', issns: ['1111-2222'], abbreviation: 'SOME BULL', impactFactor: 0.4, year: 2025, quartile: 4, publisher: 'Elsevier BV'}
 ];
 f.runtime.journalIdentity = {
  identify: venue => registry.find(x => x.title === venue) || null,
  registryRanked: () => registry,
  registryRank: title => registry.find(x => x.title === title)?.rank || null,
  registryLevels: title => registry.find(x => x.title === title)?.levels || []
 };
 await f.bench.show('journals');
 await f.click('저장 저널 3');
 const menu = level => f.body().querySelector(`.sc-field-line select[data-level="${level}"]`);
 const options = level => [...menu(level).querySelectorAll('option')].map(o => o.textContent);
 assert.deepEqual(options('domain'), ['전체 · 1개', '분야 미상 · 1', 'Life Sciences 2'],
  'two of the three can be placed, and the third says so');
 assert.deepEqual(options('subfield').slice(1).sort(), ['Cell Biology 1', 'Molecular Biology 1'],
  'a journal the library does not hold reaches the smallest level');
 const venues = () => [...f.body().querySelectorAll('tr.sc-journal')].map(r => r.dataset.venue);
 menu('subfield').value = JSON.stringify(['Life Sciences','Biochemistry, Genetics and Molecular Biology','Cell Biology']);
 menu('subfield').dispatchEvent(new f.win.Event('change', {bubbles: true}));
 await settle();
 assert.deepEqual(venues(), ['Cell'], 'picking a subfield filters the whole registry');
 const domain = menu('domain');
 domain.value = '\u0000none';
 domain.dispatchEvent(new f.win.Event('change', {bubbles: true}));
 await settle();
 assert.deepEqual(venues(), ['Some Bulletin'], 'and the ones with no subject can be found on their own');
 f.bench.destroy();
});

function subjectCatalog(f,entries,profiles={}){
 JournalIdentity.loadRegistry({journals:entries.map((row,index)=>({title:row.title,impactFactor:row.impactFactor??10-index/10,
  year:2025,issns:[],abbreviation:row.title.toUpperCase(),quartile:1,...row}))});
 f.runtime.journalIdentity=JournalIdentity;
 f.papers.splice(0,f.papers.length,...entries.map((row,index)=>({id:String(index+1),key:'K'+(index+1),libraryID:1,
  title:'Paper '+row.title,venue:row.title,year:'2025',authors:'A Author',itemType:'journalArticle',tags:[],related:[]})));
 for(const paper of f.papers)f.refs.set(Number(paper.id),{id:Number(paper.id)});
 f.runtime.journalRecord=ref=>({name:f.papers[ref.id-1]?.venue||'',issn:''});
 f.runtime.journalProfile=ref=>profiles[f.papers[ref.id-1]?.venue]||null;
 f.runtime.Z.launchURL=url=>f.calls.push(['launchURL',url]);
 const menu=level=>f.body().querySelector(`select[data-level="${level}"]`);
 const choose=async(level,path)=>{const select=menu(level);select.value=path?JSON.stringify(path):'';select.dispatchEvent(new f.win.Event('change',{bubbles:true}));await settle();};
 const row=title=>[...f.body().querySelectorAll('tr.sc-journal')].find(r=>r.dataset.venue===title);
 return {menu,choose,row,venues:()=>[...f.body().querySelectorAll('tr.sc-journal')].map(r=>r.dataset.venue)};
}

test('journal menus distinguish all six repeated subfield names by full path and reject crossed branches',async()=>{
 const f=fixture();
 const biology='Biochemistry, Genetics and Molecular Biology';
 const pairs=[
  ['Genetics',['Life Sciences',biology],['Health Sciences','Medicine']],
  ['Neurology',['Life Sciences','Neuroscience'],['Health Sciences','Medicine']],
  ['Pharmacology',['Life Sciences','Pharmacology, Toxicology and Pharmaceutics'],['Health Sciences','Medicine']],
  ['Physiology',['Life Sciences',biology],['Health Sciences','Medicine']],
  ['Biochemistry',['Life Sciences',biology],['Health Sciences','Medicine']],
  ['Archeology',['Social Sciences','Arts and Humanities'],['Social Sciences','Social Sciences']]
 ];
 const path=parts=>Object.fromEntries(['domain','field','subfield'].map((k,i)=>[k,parts[i]]));
 const entries=pairs.flatMap(([label,a,b])=>[{title:'Left '+label,levels:[path([...a,label])]},
  {title:'Right '+label,levels:[path([...b,label])]}]);
 entries.push({title:'Mixed paths',levels:[path(['Life Sciences',biology,'Molecular Biology']),path(['Health Sciences','Medicine','Genetics'])]});
 const ui=subjectCatalog(f,entries);await f.bench.show('journals');
 for(const [label,a,b] of pairs){
  if(f.findButton('전체'))await f.click('전체');
  const options=[...ui.menu('subfield').querySelectorAll('option')];
  const left=options.find(o=>o.value===JSON.stringify([...a,label])),right=options.find(o=>o.value===JSON.stringify([...b,label]));
  assert.ok(left&&right,label+' has two independent path choices');assert.notEqual(left.value,right.value);
  assert.equal(left.title,[...a,label].join(' › '));assert.equal(right.title,[...b,label].join(' › '));
  assert.match(left.textContent,/ 1$/);assert.match(right.textContent,label==='Genetics'?/ 2$/:/ 1$/);
  await ui.choose('subfield',[...a,label]);
  assert.deepEqual(ui.venues(),['Left '+label]);
  assert.equal(ui.menu('domain').value,JSON.stringify([a[0]]));assert.equal(ui.menu('field').value,JSON.stringify(a));
  await f.click('전체');await ui.choose('subfield',[...b,label]);
  assert.deepEqual(new Set(ui.venues()),new Set(label==='Genetics'?['Right Genetics','Mixed paths']:['Right '+label]));
 }
 await f.click('전체');await ui.choose('domain',['Health Sciences']);
 const before=ui.menu('subfield').value;
 await ui.choose('subfield',['Life Sciences',biology,'Genetics']);
 assert.equal(ui.menu('domain').value,JSON.stringify(['Health Sciences']),'an unavailable option cannot replace the chosen domain');
 assert.equal(ui.menu('subfield').value,before);
 // An old or externally restored incompatible selection must also match zero rows.
 Object.assign(f.bench.state.journalView.pick,{domain:'Health Sciences',field:biology,subfield:'Genetics'});
 await f.bench.render();assert.deepEqual(ui.venues(),[]);assert.match(f.body().textContent,/이 분야의 저널이 없습니다/);
 f.bench.destroy();
});

test('displayed and sorted local ranks follow the selected complete field or subfield path',async()=>{
 const f=fixture(),a={domain:'Life Sciences',field:'Biology',subfield:'Genetics'},b={domain:'Health Sciences',field:'Medicine',subfield:'Genetics'};
 const entries=[...Array.from({length:8},(_,i)=>({title:'A high '+i,impactFactor:20-i,levels:[a]})),
  {title:'Alpha journal',impactFactor:8,levels:[a,b]},{title:'Beta journal',impactFactor:7,levels:[b]},
  {title:'Different medicine',impactFactor:6,levels:[{...b,subfield:'Oncology'}]},
  ...Array.from({length:8},(_,i)=>({title:'B low '+i,impactFactor:1,levels:[b]}))];
 const ui=subjectCatalog(f,entries);await f.bench.show('journals');
 const sort=f.body().querySelector('[aria-label="저널 정렬"]');sort.value='fieldrank';sort.dispatchEvent(new f.win.Event('change'));await settle();
 assert.ok(ui.venues().indexOf('Beta journal')<ui.venues().indexOf('Alpha journal'),'unselected first paths have different denominators');
 await f.click('Alpha journal');
 const rankFacts=[...f.body().querySelectorAll('.sc-journal-profile .sc-fact')].filter(fact=>fact.title.includes('로컬 비교'));
 assert.deepEqual(rankFacts.map(fact=>fact.querySelector('dt').textContent),['Biology › Genetics','Biology','Medicine › Genetics','Medicine']);
 assert.ok(rankFacts[0].title.startsWith('Life Sciences › Biology › Genetics\n'));
 assert.ok(rankFacts[2].title.startsWith('Health Sciences › Medicine › Genetics\n'));
 await f.click('Alpha journal');
 await ui.choose('field',['Health Sciences','Medicine']);
 assert.deepEqual(ui.venues().slice(0,2),['Alpha journal','Beta journal']);
 assert.equal(ui.row('Alpha journal').querySelector('.sc-col-fieldrank').textContent,'1/11');
 assert.match(ui.row('Alpha journal').querySelector('.sc-col-fieldrank').title,/Health Sciences › Medicine 11종/);
 await ui.choose('subfield',['Health Sciences','Medicine','Genetics']);
 assert.deepEqual(ui.venues().slice(0,2),['Alpha journal','Beta journal']);
 const cell=ui.row('Alpha journal').querySelector('.sc-col-fieldrank');assert.equal(cell.textContent,'1/10');
 assert.match(cell.title,/Health Sciences › Medicine › Genetics 10종/);assert.doesNotMatch(cell.title,/Life Sciences/);
 assert.match(cell.title,/로컬 비교/);assert.match(cell.title,/공식 JCR 순위 아님/);
 await f.click('분야별로 묶기');
 assert.deepEqual([...f.body().querySelectorAll('.sc-journal-group th')].map(h=>h.textContent),['Health Sciences › Medicine › Genetics · 10종']);
 await f.click('Alpha journal');
 assert.match(f.body().querySelector('.sc-journal-profile').textContent,/1위 \/ 10종/);
 assert.doesNotMatch(f.body().querySelector('.sc-journal-profile').textContent,/9위 \/ 9종/);
 f.bench.destroy();
});

test('journal cache refresh keeps canonical subjects, registry JIF and profile facts aligned without changing item IDs',async()=>{
 const f=fixture(),field='Biochemistry, Genetics and Molecular Biology';
 const levels=['Molecular Biology','Biophysics','Spectroscopy','Structural Biology'].map(subfield=>({domain:'Life Sciences',field,subfield}));
 const profiles={'Nature Methods':{profileAt:'2026-09-19',hIndex:40,fields:['Wrong field'],topics:[{domain:'Life Sciences',field,subfield:'Biophysics'},{domain:'Life Sciences',field,subfield:'Biophysics'}]},
  'Unclassified journal':{profileAt:'2026-09-19',hIndex:10,topics:levels.flatMap(t=>[t,t])}};
 const entries=[{title:'Nature Methods',impactFactor:32,year:2025,levels},{title:'Unclassified journal',impactFactor:2,levels:[]}];
 const ui=subjectCatalog(f,entries,profiles);
 f.runtime.state=()=>({impactFactor:4,impactYear:2020,impactSource:'old item snapshot',citations:3,status:'reading'});
 await f.bench.show('journals');
 assert.equal(ui.row('Nature Methods').querySelector('.sc-col-if').textContent,'32.0');
 const title=ui.row('Nature Methods').querySelector('.sc-col-fields').title;
 for(const level of levels)assert.ok(title.includes(level.subfield));assert.doesNotMatch(title,/Biophysics · Biophysics/);
 await f.click('Nature Methods');
 let facts=f.body().querySelector('.sc-journal-profile');assert.match(facts.textContent,/32\.0 · 2025/);assert.doesNotMatch(facts.textContent,/Wrong field|2020/);
 const fieldFact=[...facts.querySelectorAll('.sc-fact')].find(r=>r.querySelector('dt').textContent==='OpenAlex 분야');
 assert.equal(fieldFact.querySelectorAll('.sc-chip').length,4);
 profiles['Nature Methods'].hIndex=55;profiles['Nature Methods'].profileAt='2026-09-20';await f.bench.render();
 facts=f.body().querySelector('.sc-journal-profile');assert.ok([...facts.querySelectorAll('.sc-fact')].some(r=>r.querySelector('dt').textContent==='h-index'&&r.querySelector('dd').textContent==='55'));
 const fallback=ui.row('Unclassified journal');for(const level of levels)assert.ok(fallback.querySelector('.sc-col-fields').title.includes(level.subfield));
 assert.match(fallback.querySelector('.sc-col-fieldrank').title,/로컬 JIF 비교 순위가 없습니다/);assert.doesNotMatch(fallback.querySelector('.sc-col-fieldrank').title,/분야를 몰라/);
 profiles['Unclassified journal'].topics.push({domain:'Physical Sciences',field:'Chemistry',subfield:'Analytical Chemistry'});
 await f.bench.render();assert.match(ui.row('Unclassified journal').querySelector('.sc-col-fields').title,/Analytical Chemistry/);
 // New registry classification and JIF change the same visible records through revision invalidation.
 JournalIdentity.loadRegistry({journals:[{...entries[0],impactFactor:35,year:2026,levels:[{domain:'Physical Sciences',field:'Physics',subfield:'Optics'}]},entries[1]]});
 await f.bench.render();
 assert.match(ui.row('Nature Methods').querySelector('.sc-col-fields').title,/Physical Sciences › Physics › Optics/);
 assert.doesNotMatch(ui.row('Nature Methods').querySelector('.sc-col-fields').title,/Molecular Biology/);
 assert.equal(ui.row('Nature Methods').querySelector('.sc-col-if').textContent,'35.0');
 f.bench.destroy();
});

test('journal source labels and unknown stored Q stay honest and official category navigation is preserved',async()=>{
 const f=fixture();const ui=subjectCatalog(f,[{title:'Known subject',quartile:1,levels:[{domain:'Life Sciences',field:'Biology',subfield:'Genetics'}]},
  {title:'Missing subject',quartile:4,levels:[]}]);await f.bench.show('journals');
 assert.match(f.body().querySelector('.sc-journal-source').textContent,/OpenAlex 분야별 저장 JIF/);
 assert.match(f.body().querySelector('.sc-journal-source').textContent,/로컬 순위·Q는 자체 계산이며, 저장 Q는 카테고리 미확인 원본값/);
 assert.match(ui.row('Known subject').querySelector('.sc-col-q').textContent,/Q1\?/);
 assert.match(ui.row('Known subject').querySelector('.sc-col-q span').title,/카테고리 미확인/);
 assert.match(ui.row('Missing subject').querySelector('.sc-col-fields').title,/저장된 OpenAlex 분야 정보가 없습니다/);
 assert.doesNotMatch(f.body().textContent,/전체 JCR|JCR 등재 \d/);
 assert.ok([...f.body().querySelectorAll('th')].every(th=>th.textContent!=='JCR 순위'));
 await f.click('공식 JCR 카테고리 보기');assert.deepEqual(f.calls.find(c=>c[0]==='launchURL'),['launchURL','https://jcr.clarivate.com/jcr/browse-categories']);
 await f.click('Known subject');
 assert.match(f.body().querySelector('.sc-journal-profile').textContent,/OpenAlex 분야/);
 assert.match(f.body().querySelector('.sc-fact-note').textContent,/저장된 분류는 표와 상세에서 동일/);
 assert.ok(f.findButton('JCR에서 보기'),'journal-specific official link still available');
 assert.ok(f.findButton('이 저널 문헌 보기'),'existing library navigation preserved');
 f.bench.destroy();
});

test('journal table only shares a JIF year when every visible row has that same known year',async()=>{
 const f=fixture(),levels=[{domain:'Life Sciences',field:'Biology',subfield:'Genetics'}];
 const entries=[{title:'Catalog journal',impactFactor:30,year:2025,levels},{title:'Outside registry',levels:[]}];
 const ui=subjectCatalog(f,entries);
 JournalIdentity.loadRegistry({journals:[entries[0]]});
 f.runtime.state=()=>({impactFactor:4,impactYear:2020,citations:3,status:'reading'});
 await f.bench.show('journals');
 assert.equal(f.body().querySelector('thead .sc-col-if').textContent,'JIF');
 assert.match(ui.row('Catalog journal').querySelector('.sc-col-if').title,/2025/);
 assert.match(ui.row('Outside registry').querySelector('.sc-col-if').title,/2020/);
 f.input('저널 검색','Catalog');await new Promise(resolve=>setTimeout(resolve,160));await settle();
 assert.equal(f.body().querySelector('thead .sc-col-if').textContent,'JIF 2025');
 f.input('저널 검색','');await new Promise(resolve=>setTimeout(resolve,160));await settle();
 assert.equal(f.body().querySelector('thead .sc-col-if').textContent,'JIF');
 f.bench.destroy();
});

function capturedJCRControl(){
 const payload=JSON.parse(fs.readFileSync(new URL('../data/jcr-categories.json',import.meta.url),'utf8'));
 // Real captured 21/254 taxonomy; this deliberately named unit-test journal
 // exercises callbacks/metric cells and is never written to the shipped data.
 const category=payload.categories.find(row=>row.journalCount>0&&row.groupKeys.length);
 payload.source.complete.journals=false;
 payload.journals=[{key:'integration-control',title:'Integration control journal',abbreviation:'CONTROL',issns:['1234-5678'],
  categoryKeys:[category.key],jif:5.2,year:payload.source.metricYear,
  categoryMetrics:[{categoryKey:category.key,editions:category.editions.slice(0,1),rank:3,rankTotal:100,quartile:1,percentile:97.5}]}];
 return {catalog:JCRCategories.create(payload),category};
}

test('actual journal tab defaults to all captured JCR groups despite old OpenAlex selections and paper filters',async()=>{
 const f=fixture({items:{},readerSettings:{},workbenchUI:{lastTab:'journals'}},undefined,{nativeJCR:true});
 Object.assign(f.bench.state.journalView.pick,{domain:'Life Sciences',field:'Biology',subfield:'Genetics'});
 Object.assign(f.bench.state,{query:'a paper filter with no journal matches',scope:'selected'});
 await f.bench.show('journals');
 assert.equal(f.bench.state.journalBrowser,'jcr');
 assert.equal(f.body().querySelectorAll('.sc-jcr-group').length,21);
 assert.equal(f.body().querySelector('.sc-journal-table'),null);
 assert.equal(f.body().querySelector('select[data-level]'),null);
 assert.equal(f.bench.panel.querySelector('.sc-search-row').hidden,true);
 const find=new f.win.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperties(find,{key:{value:'f'},ctrlKey:{value:true}});
 f.bench.panel.dispatchEvent(find);assert.equal(f.doc.activeElement,f.body().querySelector('.sc-jcr-search'));
 assert.match(f.body().textContent,/Clarivate|JCR/);
 assert.ok(f.findButton('전체 카테고리 · 254'));
 await f.click('전체 카테고리 · 254');
 assert.equal(f.body().querySelectorAll('tr[data-category-key]').length,25);
 assert.match(f.body().querySelector('.sc-jcr-pagination').textContent,/254/);
 assert.equal(f.runtime.cache.workbenchUI.jcrBrowserState.view,'categories');
 f.bench.destroy();
});

test('native JCR category journals use actual model/component, preserve official contexts and invoke ZotPoP only on user action',async()=>{
 const {catalog,category}=capturedJCRControl();
 const f=fixture(undefined,undefined,{nativeJCR:true,catalog});
 f.runtime.Z.ZotPoP={openSearch:(window,query)=>f.calls.push(['journalSearch',window,query])};
 f.runtime.Z.launchURL=url=>f.calls.push(['sourceOpen',url]);
 await f.bench.show('journals');
 assert.equal(f.calls.some(c=>['journalSearch','sourceOpen'].includes(c[0])),false);
 const group=[...f.body().querySelectorAll('.sc-jcr-group')].find(node=>node.dataset.groupKey===category.groupKeys[0]);
 group.querySelector('.sc-jcr-group-toggle').dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 const target=[...f.body().querySelectorAll('.sc-jcr-category-link')].find(node=>node.dataset.categoryKey===category.key);
 assert.ok(target);target.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 const row=f.body().querySelector('tr[data-journal-key="integration-control"]');assert.ok(row);
 assert.equal(row.querySelector('[data-column="rank"]').textContent,'3/100');
 assert.equal(row.querySelector('[data-column="quartile"]').textContent,'Q1');
 assert.equal(row.querySelector('[data-column="percentile"]').textContent,'97.5');
 assert.match(f.body().querySelector('.sc-jcr-coverage').textContent,/수집 미완료/);
 await f.click('저널 검색');
 const call=f.calls.find(c=>c[0]==='journalSearch');assert.equal(call[1],f.win);assert.deepEqual(call[2],{venue:'Integration control journal'});
 await f.click('JCR 원본 열기');assert.deepEqual(f.calls.find(c=>c[0]==='sourceOpen'),['sourceOpen','https://jcr.clarivate.com/jcr/browse-categories']);
 f.bench.destroy();
});

test('OpenAlex is an explicit remembered alternative with a native JCR return control and preserved JCR navigation',async()=>{
 const {catalog}=capturedJCRControl(),f=fixture(undefined,undefined,{nativeJCR:true,catalog});
 await f.bench.show('journals');await f.click('전체 카테고리 · 254');await f.click('OpenAlex 주제로 탐색');
 assert.equal(f.bench.state.journalBrowser,'openalex');assert.ok(f.body().querySelector('.sc-journal-table'));
 assert.equal(f.body().querySelector('.sc-jcr-browser'),null);assert.equal(f.runtime.cache.workbenchUI.journalBrowser,'openalex');
 const cache=structuredClone(f.runtime.cache);f.bench.destroy();
 const reopened=fixture(cache,undefined,{nativeJCR:true,catalog});await reopened.bench.show('journals');
 assert.equal(reopened.bench.state.journalBrowser,'openalex');
 await reopened.click('JCR 카테고리로 돌아가기');
 assert.equal(reopened.bench.state.journalBrowser,'jcr');assert.equal(reopened.runtime.cache.workbenchUI.journalBrowser,'jcr');
 assert.equal(reopened.body().querySelectorAll('tr[data-category-key]').length,25);
 reopened.bench.destroy();
});

test('native JCR hides and disables paper selection actions while retaining selection for other views',async()=>{
 const f=fixture(undefined,undefined,{nativeJCR:true});
 f.setSelection([1,2]);await f.bench.show('journals');
 const footer=f.bench.panel.querySelector('.sc-selection-bar');
 assert.equal(footer.hidden,true);
 assert.deepEqual([...f.bench.state.selected],['1','2']);
 for(const button of footer.querySelectorAll('button')){
  assert.equal(button.disabled,true);
  button.dispatchEvent(new f.win.Event('click',{bubbles:true}));
 }
 await settle();
 assert.deepEqual([...f.bench.state.selected],['1','2']);
 assert.equal(f.calls.some(call=>['relate','unrelate'].includes(call[0])),false);
 await f.click('OpenAlex 주제로 탐색');
 assert.equal(footer.hidden,false);
 assert.equal(f.findButton('관련 문헌으로 연결').disabled,false);
 await f.click('JCR 카테고리로 돌아가기');assert.equal(footer.hidden,true);
 await f.bench.show('explore');assert.equal(footer.hidden,false);
 assert.deepEqual([...f.bench.state.selected],['1','2']);
 await f.click('관련 문헌으로 연결');
 assert.deepEqual(f.calls.find(call=>call[0]==='relate'),['relate',['1','2']]);
 f.bench.destroy();
});

test('missing official catalog is visible in JCR mode and never silently displays OpenAlex groups',async()=>{
 const f=fixture(undefined,undefined,{nativeJCR:true,catalog:null});
 await f.bench.show('journals');
 assert.ok(f.body().querySelector('.sc-jcr-unavailable[role="alert"]'));
 assert.equal(f.body().querySelector('.sc-journal-table'),null);assert.equal(f.bench.state.journalBrowser,'jcr');
 await f.click('OpenAlex 주제로 탐색');assert.ok(f.body().querySelector('.sc-journal-table'));
 await f.click('JCR 카테고리로 돌아가기');assert.ok(f.body().querySelector('.sc-jcr-unavailable'));
 f.bench.destroy();
});

test('a missing ZotPoP journal-search integration is reported without opening or changing other views',async()=>{
 const {catalog,category}=capturedJCRControl(),f=fixture(undefined,undefined,{nativeJCR:true,catalog});
 f.bench.state.jcrBrowserState={view:'journals',categoryKey:category.key};await f.bench.show('journals');
 await f.click('저널 검색');
 assert.match(f.body().querySelector('.sc-jcr-error[role="alert"]').textContent,/도구 → 부가 기능에서 ZotPoP를 설치·활성화한 뒤 다시 시도하세요\./);
 assert.match(f.errors[0].message,/ZotPoP/);assert.equal(f.bench.state.journalBrowser,'jcr');
 assert.ok(f.body().querySelector('tr[data-journal-key="integration-control"]'));
 f.bench.destroy();
});

test('native JCR remount and workbench destruction remove old callbacks and their stylesheet',async()=>{
 const {catalog}=capturedJCRControl(),f=fixture(undefined,undefined,{nativeJCR:true,catalog});
 f.runtime.Z.launchURL=url=>f.calls.push(['sourceOpen',url]);
 await f.bench.show('journals');const stale=f.findButton('JCR 원본 열기'),old=f.body().querySelector('.sc-jcr-browser');
 await f.bench.show('explore');assert.equal(old.isConnected,false);
 stale.dispatchEvent(new f.win.Event('click'));await settle();assert.equal(f.calls.some(c=>c[0]==='sourceOpen'),false);
 await f.bench.show('journals');await f.bench.render();await f.bench.render();
 assert.equal(f.doc.querySelectorAll('.sc-jcr-browser').length,1);
 await f.click('JCR 원본 열기');assert.equal(f.calls.filter(c=>c[0]==='sourceOpen').length,1);
 const latest=f.findButton('JCR 원본 열기');f.bench.destroy();latest.dispatchEvent(new f.win.Event('click'));await settle();
 assert.equal(f.calls.filter(c=>c[0]==='sourceOpen').length,1);
 assert.equal(f.doc.querySelectorAll('.sc-jcr-browser').length,0);
 assert.equal([...f.doc.querySelectorAll('link')].some(link=>link.getAttribute('href').endsWith('jcr-browser.css')),false);
});

test('the three annotation verbs wait until something is selected', async () => {
 const f = fixture();
 f.library.annotations = f.record('annotations', [
  {id: '3', text: 'First', comment: '', color: '#ffd400', type: 'highlight', pageIndex: 0, attachmentID: '9'},
  {id: '4', text: 'Second', comment: 'a memo', color: '#ff6666', type: 'underline', pageIndex: 1, attachmentID: '9'}
 ]);
 await f.bench.show('annotations');
 const tools = f.body().querySelector('.sc-annot-selection');
 assert.equal(tools.dataset.armed, 'false', 'nothing selected yet');
 assert.match(tools.querySelector('.sc-annot-chosen').textContent, /선택하세요/);
 assert.ok([...tools.querySelectorAll('button')].every(b => b.disabled), 'a verb with nothing to act on is not pressable');
 f.body().querySelector('.sc-annot').dispatchEvent(new f.win.Event('click', {bubbles: true}));
 assert.equal(tools.dataset.armed, 'true');
 assert.equal(tools.querySelector('.sc-annot-chosen').textContent, '선택 1개');
 assert.ok([...tools.querySelectorAll('button')].every(b => !b.disabled));
 // The memo that exists is drawn; the one that does not is a button away.
 assert.equal(f.body().querySelectorAll('.sc-annot .sc-annot-memo').length, 1, 'one memo written, one memo drawn');
 f.bench.destroy();
});

test('every button that opens a Zotero window says so, or the self-check stacks note editors', () => {
  /* The running self-check presses every button on every tab. It leaves alone
     the ones marked data-opens, because a button's label cannot be trusted to
     say it opens a window -- a note title is a label, and so is 「노트 편집」.
     Three of them lost the marker and the sweep opened a note editor on every
     install, which is what the reader saw stacking up. */
  const source = fs.readFileSync(new URL('../src/workbench.js', import.meta.url), 'utf8');
  const missing = [];
  for (let at = source.indexOf('openItem('); at >= 0; at = source.indexOf('openItem(', at + 1)) {
    const before = source.slice(Math.max(0, at - 500), at);
    const fromButton = before.lastIndexOf('button('), fromListener = before.lastIndexOf('addEventListener(');
    // Only a real button is pressed by the sweep; a listener on a cell is not.
    if (fromButton < 0 || fromButton < fromListener) continue;
    const call = before.slice(fromButton) + source.slice(at, at + 220);
    if (!call.includes('data-opens')) missing.push(call.slice(0, 90).replace(/\s+/g, ' '));
  }
  assert.deepEqual(missing, [], 'these buttons open a Zotero window without saying so');
});

test('a note in the list can be sent to the trash, and only the trash', async () => {
 /* Every card had edit and copy and nothing to let a note go. Trash, not
    delete: Zotero's trash keeps it and the reader restores it there. */
 const f=fixture();
 await f.bench.show('notes');
 const cards=f.body().querySelectorAll('.sc-note-text').length;
 assert.ok(cards>0,'there are notes to act on');
 await f.click('휴지통으로');
 const call=f.calls.find(c=>c[0]==='trashItems');
 assert.ok(call,'the library was asked to trash');
 assert.equal(call[1].length,1,'one note, the one on the card');
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/휴지통으로 옮겼습니다/);
 f.bench.destroy();
});

test('a paper chosen in the panel survives reaching a tab through the menu while the pane has nothing selected', async () => {
 /* show(tab) reopened the panel and let the pane's (empty) selection replace
    the one ticked in the panel, so Related and Authors said "0 selected". */
 const f = fixture();
 await f.bench.show('explore');
 f.bench.state.selected = new Set(['2']);
 f.setSelection([]);
 await f.bench.show('related');
 assert.deepEqual([...f.bench.state.selected], ['2'], 'the panel keeps what it had');
 f.setSelection([1]);
 await f.bench.show('authors');
 assert.deepEqual([...f.bench.state.selected], ['1'], 'the pane wins when it has something to say');
 f.bench.destroy();
});

test('with several papers selected, a one-paper tab offers them to pick from instead of a dead end', async () => {
 const f = fixture();
 f.setSelection([1, 2]);
 await f.bench.show('related');
 assert.match(f.body().textContent, /선택한 2편 중 하나를 고르세요/);
 await f.click('Paper Beta');
 assert.deepEqual([...f.bench.state.selected], ['2']);
 f.bench.destroy();
});

test('the reading tab leads with the reading and folds the reader appearance away', async () => {
 const f = fixture();
 await f.bench.show('reading');
 const first = f.body().firstElementChild;
 assert.ok(first && first.hasAttribute('data-reading-progress'), 'the reading data comes first');
 const look = f.body().querySelector('details.sc-reader-look');
 assert.ok(look, 'the appearance controls sit in a fold');
 assert.ok(look.querySelector('button'), 'and the theme buttons are inside it');
 f.bench.destroy();
});

test('a comparison table shows field names in its headings and its CSV', async () => {
 const f = fixture();
 f.setSelection([1, 2]);
 await f.bench.show('matrix');
 const heads = [...f.body().querySelectorAll('.sc-matrix th')].map(th => th.textContent);
 assert.ok(heads.length > 1, 'there are headings');
 assert.ok(!heads.some(h => /^(title|impactFactor|authors)$/.test(h)), 'no raw field keys: ' + heads.join(','));
 f.bench.destroy();
});

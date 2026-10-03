import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseHTML} from 'linkedom';
import {createRequire} from 'node:module';
import Workbench from '../src/workbench.js';
import Model from '../src/workspace.js';
import JournalIdentity from '../src/journal-identity.js';
import JCRCategories from '../src/jcr-categories.js';
import JCRBrowser from '../src/jcr-browser.js';
import PaperGraph from '../src/paper-graph.js';
import Discover from '../src/discover.js';
const require=createRequire(import.meta.url);
const SelfCheck=require('../src/selfcheck.js');
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
// toolbar: the ids and element names already in the items toolbar, in order, so
// a test can check where the button is placed among them.
function fixture(initialCache,toolbar,{nativeJCR=false,catalog,locale}={}){
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
 const runtime={rootURI:'file:///plugin/',cache,dirty:false,selected:()=>mainSelection,pref:(key,fallback)=>({aiEndpoint:'https://ai.example/v1',aiModel:'test-model'})[key]??fallback,entry:ref=>cache.items[ref.id]||=( {}),state:()=>({citations:3,impactFactor:4,status:'reading'}),flush:record('flush'),refreshWindows:record('refresh'),publicationTags:()=>['Q1'],refreshJournalMetrics:record('journal',{updated:1,failed:0,unknown:0}),setPanelCSS:record('css'),toggleAppTheme:record('appTheme'),setCustomFields:record('customFields'),refreshPublicationRanks:record('ranks'),pageProgress:()=>({pages:{0:2,550:7},total:601,visited:2,percent:0,attachmentID:'99'})};
 runtime.jcrBrowser=JCRBrowser;
 if(nativeJCR)runtime.jcrCatalog=catalog===null?null:catalog||shippedCatalog();
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
 const library={trashItems:record('trashItems',async ids=>ids.length),snapshot:record('snapshot',()=>papers),graph:rows=>({nodes:rows.map(i=>({id:i.id,label:i.title})),edges:[]}),tagTree:()=>[{name:'topic',path:'topic',count:2,children:[]}],notes:record('notes',[{id:'9',title:'Rich note',text:'<script>literal note</script>',modified:'today',html:'<b>unsafe raw HTML</b>'}]),annotations:record('annotations',[{id:'3',key:'K3',parentID:'1',attachmentID:'99',text:'Highlight',comment:'Comment',color:'#ffd400',type:'highlight',pageLabel:'1',pageIndex:0}]),backlinks:record('backlinks',[{id:'2',title:'Paper Beta',kind:'related'}]),attachments:record('attachments',[{id:'99',parentID:'1',title:'PDF one',contentType:'application/pdf'},{id:'100',parentID:'1',title:'PDF two',contentType:'application/pdf'}]),collections:record('collections',[{id:'4',name:'Research',count:2,parentID:null}]),openItem:record('open'),relate:record('relate'),addTags:record('addTags'),removeTags:record('removeTags'),setRemark:record('remark'),memoToNote:record('memoToNote',async()=>({created:true,text:''})),createNote:record('createNote','9'),noteFromAnnotations:record('extract','9')};
 const palettes=[];const reader={annotationPalettes:()=>palettes,saveAnnotationPalette:record('savePalette',(name,entries)=>{const row={id:'palette1',name,entries};palettes.push(row);return row;}),applyAnnotationPalette:record('applyPalette'),deleteAnnotationPalette:record('deletePalette',id=>{palettes.splice(palettes.findIndex(p=>p.id===id),1);}),tabs:()=>[{id:'tab1',title:'Paper Alpha',itemID:1,selected:true}],tabGroups:()=>[{id:'g1',name:'Group',tabs:[{id:1}]}],viewGroups:()=>[{id:'v1',name:'View',columns:[{dataKey:'title'}]}],applyTheme:record('theme'),setMarginAnnotations:record('margin'),setColorLabel:record('color'),setSidebar:record('sidebar'),setVerticalTabs:record('vertical'),saveTabGroup:record('saveTabs'),restoreTabGroup:record('restoreTabs',{opened:1,missing:0}),deleteTabGroup:record('deleteTabs'),undeleteTabGroup:record('undeleteTabs'),undeleteView:record('undeleteView'),selectTab:record('selectTab'),closeTab:record('closeTab'),saveView:record('saveView'),applyView:record('applyView'),deleteView:record('deleteView')};
 Object.assign(library,{mergeAnnotations:record('mergeAnnotations','3'),unrelate:record('unrelate',2),renameTagBranch:record('renameTagBranch',{updatedItems:1,renamedTags:1,mergedTags:0}),recolorAnnotations:record('recolor',1),collectionItems:record('collectionItems',['2'])});
 Object.assign(reader,{moveTab:(...args)=>{calls.push(['moveTab',...args]);},closeOtherTabs:(...args)=>{calls.push(['closeOtherTabs',...args]);return {closed:1};},renameTabGroup:record('renameTabGroup'),updateTabGroup:record('updateTabGroup'),renameView:record('renameView'),updateView:record('updateView'),marginOptions:()=>({width:210,side:'right',textLimit:1500}),setMarginOptions:record('setMarginOptions'),resetAppearance:record('resetAppearance')});
 const assist={run:record('ai','Generated result'),cancel:()=>calls.push(['cancelAI'])};
 const model={...Model,deleteBoard:(cache,id)=>{calls.push(['deleteBoard',id]);cache.testDeleted=cache.boards.find(b=>b.id===id);cache.boards=cache.boards.filter(b=>b.id!==id);return cache.testDeleted;},restoreBoard:cache=>{calls.push(['restoreBoard']);const board=cache.testDeleted;if(board){cache.boards.push(board);delete cache.testDeleted;}return board;}};
 if(locale){const i18n=require('../src/i18n.js');i18n.load(require('../src/strings.js').en);i18n.use(locale);runtime.i18n=i18n;}
 const bench=Workbench.attach(win,{runtime,library,reader,model,assist});
 const body=()=>bench.panel.querySelector('.sc-body');
 // An icon button carries its name in the tooltip and the accessible label,
 // not in its text, so a control is findable the way a user identifies it.
 const findButton=label=>[...bench.panel.querySelectorAll('button')]
   .find(b=>b.textContent===label||b.getAttribute('title')===label||b.getAttribute('aria-label')===label);
 const click=async label=>{const b=findButton(label);assert.ok(b,'button: '+label);b.dispatchEvent(new win.Event('click',{bubbles:true}));await settle();};
 // The panel search waits 150ms before it acts; a test types and then looks.
 const input=(label,value)=>{const el=bench.panel.querySelector('[aria-label="'+label+'"]');assert.ok(el,label);el.value=value;el.dispatchEvent(new win.Event('input',{bubbles:true}));bench.flushSearch?.();return el;};
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
 const basePref=f.runtime.pref;f.runtime.pref=(key,fallback)=>key==='journalRankKey'?'a-key':basePref(key,fallback);
 await f.bench.show('journals');
 await f.click('등급 조회');assert.ok(f.calls.find(c=>c[0]==='ranks'));
 await f.bench.show('assist');await f.click('제목 번역');await f.click('선택 문헌에 적용');assert.equal(f.runtime.entry(f.refs.get(1)).translatedTitle,'Generated result');
 await f.bench.show('appearance');f.input('Custom 패널 CSS','.sc-card { color: red; }');await f.click('패널 CSS 적용');assert.ok(f.calls.find(c=>c[0]==='css'));f.input('추가 문헌 열','DOI, language');await f.click('추가 열 적용');assert.ok(f.calls.find(c=>c[0]==='customFields'&&c[1]==='DOI, language'));f.bench.destroy();
});

test('주석: 선택 해제 appears the moment the first card is selected, with no full render in between',async()=>{
 const f=fixture();
 await f.bench.show('annotations');
 // The annotations tab's own clear button, not the selection-bar's -- both
 // read '선택 해제', so this test finds it by the marker that names it.
 const clear=()=>f.body().querySelector('[data-role="annot-clear"]');
 assert.ok(clear(),'the button is drawn from the first draw, just hidden');
 assert.equal(clear().hidden,true,'hidden with nothing chosen');
 const row=f.body().querySelector('.sc-annot');
 row.dispatchEvent(new f.win.Event('click',{bubbles:true}));
 assert.equal(row.dataset.selected,'true');
 // syncChosen() runs off the same click, with no render() between it and the
 // click -- the button used to only exist when annotationIDs was already
 // non-zero at draw time, so it could never appear on this very first click.
 assert.equal(clear().hidden,false,'선택 해제 shows as soon as one card is chosen');
 assert.equal(clear().textContent,'선택 해제 (1)');
 clear().dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.equal(f.bench.state.annotationIDs.size,0);
 f.bench.destroy();
});

test('A43 내 기록 포함: hidden without a query, widens 보유 문헌 past its own fields to notes and annotations, and persists',async()=>{
 const f=fixture();
 await f.bench.show('explore');
 const check=()=>f.bench.panel.querySelector('[aria-label="내 기록 포함"]');
 assert.ok(check(),'the checkbox exists from the first draw');
 assert.equal(check().closest('label').hidden,true,'nothing to widen without a query');
 f.library.notes=async()=>[{id:'9',title:'Method note',text:'a reproducibility check',modified:'today',parentID:'2'}];
 f.library.annotations=async()=>[{id:'3',key:'K3',parentID:'1',attachmentID:'99',text:'an epitope map',comment:'',color:'#ffd400',type:'highlight',pageLabel:'1',pageIndex:0}];
 f.input('작업 패널 검색','reproducibility');await settle();
 assert.equal(check().closest('label').hidden,false,'a query shows the checkbox');
 assert.equal(f.body().querySelectorAll('.sc-paper-card').length,0,'off by default: neither paper\'s own fields mention it');
 check().checked=true;check().dispatchEvent(new f.win.Event('change'));await settle();
 assert.ok(f.calls.find(c=>c[0]==='pref'||c[0]==='flush'),'the checkbox persists to workbenchUI');
 let cards=[...f.body().querySelectorAll('.sc-paper-card')];
 assert.equal(cards.length,1,'Beta is pulled in by the note only');
 let hit=cards[0].querySelector('.sc-paper-search-hit');
 assert.match(hit.textContent,/노트 1.*reproducibility/);
 hit.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.equal(f.bench.state.tab,'notes');
 assert.equal(f.bench.state.scope,'selected','opens Beta\'s exact note, not every note the query matches');
 assert.deepEqual([...f.bench.state.selected],['2']);
 f.bench.panel.querySelector('.sc-scope-back').dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.equal(f.bench.state.tab,'explore');
 f.input('작업 패널 검색','epitope');await settle();
 cards=[...f.body().querySelectorAll('.sc-paper-card')];
 assert.equal(cards.length,1,'Alpha is pulled in by the annotation only');
 hit=cards[0].querySelector('.sc-paper-search-hit');
 assert.match(hit.textContent,/주석 1.*epitope/);
 hit.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.equal(f.bench.state.tab,'annotations');
 assert.deepEqual([...f.bench.state.selected],['1']);
 f.bench.destroy();
});

test('A43 내 기록 포함: merges the note/annotation matches before sorting, and the scope count is the merged list',async()=>{
 const f=fixture();
 await f.bench.show('explore');
 // Beta (2024) matches the query on its own title; Alpha (2025) is pulled in
 // only by a note that happens to mention "beta". Under 최신 발행순 the newer,
 // note-only Alpha must sort ahead of Beta -- appending it after the base
 // list would leave the older paper first.
 f.library.notes=async()=>[{id:'9',title:'Method note',text:"compared with Beta's results",modified:'today',parentID:'1'}];
 f.input('작업 패널 검색','beta');await settle();
 const change=(label,value)=>{const input=f.bench.panel.querySelector('[aria-label="'+label+'"]');input.value=value;input.dispatchEvent(new f.win.Event('change',{bubbles:true}));};
 change('문헌 정렬','year-desc');await settle();
 const check=f.bench.panel.querySelector('[aria-label="내 기록 포함"]');check.checked=true;check.dispatchEvent(new f.win.Event('change'));await settle();
 const cards=[...f.body().querySelectorAll('.sc-paper-card')];
 assert.equal(cards.length,2);
 assert.deepEqual(cards.map(c=>c.dataset.itemId),['1','2'],'merged first, then sorted by the chosen order -- Alpha (2025) ahead of Beta (2024)');
 // 2026-10-03 detail review: the chip says only the scope (the count is in the kind chips); the count stays in its tooltip.
 assert.match(f.bench.panel.querySelector('.sc-context-detail').title,/2개 문헌/,'the scope count is the merged list, not the plain search');
 f.bench.destroy();
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
 // A45: the strip (and its range select) is only built once its fold opens.
 const fold=f.body().querySelector('.sc-resume-pages');fold.open=true;fold.dispatchEvent(new f.win.Event('toggle'));
 f.input('색상 이름','Important');const savedControl=f.body().querySelector('[aria-label="색상 이름"]');const range=f.body().querySelector('[aria-label="Paper Alpha 페이지 범위"]');assert.equal(range.querySelectorAll('option').length,7);range.value='500';range.dispatchEvent(new f.win.Event('change'));await settle();
 {const cell=f.body().querySelector('.sc-page-cell[aria-label^="551페이지"]');assert.ok(cell,'page 551 square');cell.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
  // Choosing a page shows its evidence below the strip rather than opening
  // the PDF directly; that line's own button is what opens it now.
  const openBtn=f.body().querySelector('.sc-page-evidence .sc-reading-evidence-page');
  assert.ok(openBtn,'the chosen page\'s own line appears below the strip');
  openBtn.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();}
 assert.ok(f.calls.find(c=>c[0]==='open'&&c[1]==='99'&&c[2].pageIndex===550));
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
test('보유 문헌 rows show 주석 n from one grouped read per load, and nothing when the library has no such call',async()=>{
 const f=fixture();
 f.bench.state.scope='library';
 await f.bench.show('explore');
 assert.equal(f.body().querySelector('.sc-row-annotations'),null,'no library.annotationCounts: nothing extra shown');
 f.library.annotationCounts=async ids=>{assert.deepEqual([...ids].sort(),['1','2']);return {'1':3};};
 await f.bench.load();
 const rows=[...f.body().querySelectorAll('[data-item-id]')];
 const alpha=rows.find(r=>r.dataset.itemId==='1'),beta=rows.find(r=>r.dataset.itemId==='2');
 const annotationsBtn=alpha.querySelector('.sc-row-annotations');
 assert.equal(annotationsBtn.textContent,'주석 3');
 assert.equal(beta.querySelector('.sc-row-annotations'),null,'no annotations recorded for this paper');
 // A click goes straight to just this paper's annotations, the scope kept.
 annotationsBtn.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.equal(f.bench.state.tab,'annotations');
 assert.equal(f.bench.state.annotationPaperID,'1');
 assert.equal(f.bench.state.scope,'library','the scope this list was on is kept, not narrowed to a selection');
 assert.match(f.body().textContent,/Paper Alpha/);
 f.bench.destroy();
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
 const f=fixture(),saving=deferred();f.library.setRemark=async(id,text)=>{await saving.promise;(f.runtime.cache.items[id]||={}).remark=text;return text;};await f.bench.show('explore');await f.click('자세히');f.input('읽기 메모','Submitted remark');f.findButton('메모 저장').dispatchEvent(new f.win.Event('click'));await settle();f.input('읽기 메모','Newer unsaved remark');saving.resolve();await settle();await f.bench.load();assert.equal(f.body().querySelector('[aria-label="읽기 메모"]').value,'Newer unsaved remark');f.bench.destroy();
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

test('the sort control and the rule builder filter exploration and reset together; the old single-value row is gone',async()=>{
 const f=fixture();f.runtime.state=ref=>({status:ref.id===1?'done':'reading',rating:ref.id===1?5:2,citations:ref.id===1?0:20});await f.bench.show('explore');
 const change=(label,value)=>{const input=f.bench.panel.querySelector('[aria-label="'+label+'"]');input.value=value;input.dispatchEvent(new f.win.Event('change',{bubbles:true}));};
 for(const gone of ['읽기 상태 필터','최소 별점','시작 연도','마지막 연도','문헌 유형 필터'])assert.equal(f.bench.panel.querySelector('[aria-label="'+gone+'"]'),null,gone+' is a rule now');
 assert.deepEqual([...f.bench.panel.querySelectorAll('.sc-filter-fields select,.sc-filter-fields button')].map(b=>b.getAttribute('aria-label')||b.textContent),['문헌 정렬','필터 초기화'],'the row keeps only sort and reset');
 change('문헌 정렬','citations-desc');await settle();assert.match(f.body().querySelector('h3').textContent,/Beta/);
 await f.bench.filters.set([{id:'a',kind:'status',values:['done']},{id:'b',kind:'rating',min:4},{id:'c',kind:'year',min:2025}]);
 assert.equal(f.body().querySelectorAll('.sc-paper-list > article').length,1);assert.match(f.body().textContent,/Alpha/);
 await f.bench.filters.set([{id:'a',kind:'status',values:['done']},{id:'b',kind:'rating',min:4},{id:'c',kind:'year',min:2025,max:2024}]);
 assert.equal(f.body().querySelectorAll('.sc-paper-list > article').length,0);
 await f.click('필터 초기화');assert.equal(f.body().querySelectorAll('.sc-paper-list > article').length,2);f.bench.destroy();
});

test('single-value filters saved before the rule builder become include rules on 보유 문헌, once',async()=>{
 const cache={items:{},workbenchUI:{filters:{type:'journalArticle',status:'reading',ratingMin:'3',yearFrom:'2025',yearTo:''}}};
 const f=fixture(cache);await f.bench.show('explore');await settle();
 assert.deepEqual(f.bench.filters.rules().map(r=>[r.kind,r.mode]),[['type','in'],['status','in'],['rating','in'],['year','in']]);
 assert.equal(f.runtime.cache.workbenchUI.filters,undefined,'the old key is retired');
 assert.equal(f.runtime.cache.workbenchUI.filterRules.explore.length,4,'and the rules are saved');
 f.bench.destroy();
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

test('논문 비교 fits 2-4 papers to the panel by default, flipping to one row per paper, and a chosen orientation sticks',async()=>{
 const f=fixture();
 f.papers.push({id:'3',key:'K3',libraryID:1,title:'Paper Gamma',authors:'X',year:'2023',venue:'PLOS',itemType:'journalArticle',tags:[]});
 f.refs.set(3,{id:3});
 f.setSelection([]);f.bench.state.selected=new Set();
 await f.bench.show('matrix');
 assert.equal(f.bench.state.transpose,null,'undecided until the reader picks a side');
 const table=f.body().querySelector('.sc-matrix');
 assert.equal(table.dataset.fit,'true','3 papers: fitted, one row per paper');
 assert.equal(table.querySelector('th').getAttribute('scope'),'row','flipped by default for 2-4 papers');
 // Default columns lead with the deciding figures; DOI is out, but still choosable.
 const heads=[...table.querySelectorAll('th')].map(th=>th.textContent);
 assert.deepEqual(heads,['제목','읽기 상태','발행연도','인용 수','IF','저널','저자']);
 assert.equal([...f.body().querySelectorAll('[type=checkbox]')].some(c=>c.getAttribute('aria-label')==='비교 항목: DOI'),true,'DOI is still there to add back');
 // A page of 3 rows needed no paging chrome at all.
 assert.equal(f.findButton('비교 다음 페이지'),undefined,'one page: no paging controls');
 assert.equal(/전체 \d+개/.test(f.body().textContent),false,'no paging span either');
 // Pressing 행·열 전환 picks a side explicitly, and it holds even though 3 still fits the default.
 await f.click('행·열 전환');
 assert.equal(f.bench.state.transpose,false);
 assert.equal(f.body().querySelector('.sc-matrix').dataset.fit,'false');
 assert.equal(f.body().querySelector('.sc-matrix th').getAttribute('scope'),'col');
 f.bench.destroy();
});

test('논문 비교 with more than four papers keeps the plain, unflipped shape by default',async()=>{
 const f=fixture();
 for(let n=3;n<=6;n++){f.papers.push({id:String(n),key:'K'+n,libraryID:1,title:'Paper '+n,itemType:'journalArticle',tags:[]});f.refs.set(n,{id:n});}
 f.setSelection([]);f.bench.state.selected=new Set();
 await f.bench.show('matrix');
 assert.equal(f.body().querySelector('.sc-matrix').dataset.fit,'false','6 papers: no fixed-layout squeeze');
 assert.equal(f.body().querySelector('.sc-matrix th').getAttribute('scope'),'col','not flipped past 4 papers');
 f.bench.destroy();
});

test('논문 비교 header counts what is actually compared, 0 included once the last picked paper is removed',async()=>{
 const f=fixture();
 f.setSelection([1]);f.bench.state.selected=new Set(['1']);
 await f.bench.show('matrix');
 assert.match(f.bench.panel.querySelector('.sc-context-detail').textContent,/비교 중 1편/);
 // 빼기 on the last chosen paper commits to an empty picker selection --
 // scopeItems (and the header) must read 0, not fall back to the whole list.
 await f.click('빼기');
 assert.equal(f.body().querySelectorAll('.sc-paper-card, tr[data-item-id]').length,0);
 assert.match(f.body().textContent,/비교할 문헌을 추가하세요/);
 assert.match(f.bench.panel.querySelector('.sc-context-detail').textContent,/비교 중 0편/,'not the whole library\'s count');
 f.bench.destroy();
});

test('논문 비교 adds a 읽기 메모 column after 읽기 상태 by default once a paper has a memo, but a saved choice still wins',async()=>{
 const f=fixture();f.runtime.cache.items[1]={remark:'Worth a follow-up'};
 await f.bench.show('matrix');
 const heads=[...f.body().querySelectorAll('.sc-matrix th')].map(th=>th.textContent);
 assert.deepEqual(heads.slice(0,3),['제목','읽기 상태','읽기 메모'],'remark slots in right after status');
 f.bench.destroy();
 // No memo anywhere in the table: the default stays as it was.
 const bare=fixture();
 await bare.bench.show('matrix');
 assert.ok(![...bare.body().querySelectorAll('.sc-matrix th')].some(th=>th.textContent==='읽기 메모'));
 bare.bench.destroy();
 // A saved column list is respected even with a memo present.
 const saved=fixture({items:{1:{remark:'Worth a follow-up'}},readerSettings:{},matrixFields:['title','citations']});
 await saved.bench.show('matrix');
 assert.deepEqual([...saved.body().querySelectorAll('.sc-matrix th')].map(th=>th.textContent),['제목','인용 수']);
 saved.bench.destroy();
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
 /* Each figure is named where the reader looks, and a figure nobody has looked
    up yet is dashed rather than blank: a blank one read as broken, and its
    missing width pulled the row out of line with the rows above it. */
 const row=f.body().querySelector('.sc-paper-card');
 const value=name=>row.querySelector(`[data-metric=${name}] .sc-metric-value`).textContent;
 const unit=name=>row.querySelector(`[data-metric=${name}] .sc-metric-unit`)?.textContent;
 assert.equal(value('impact'),'—','an unknown figure is dashed, not blank');
 assert.equal(row.querySelector('[data-metric=impact]').dataset.empty,'true');
 assert.equal(value('citations'),'—');
 assert.equal(value('time'),'19초');
 assert.equal(value('rating'),'★★★★☆');
 assert.equal(row.dataset.status,'done');
 assert.deepEqual([unit('impact'),unit('citations'),unit('time')],['IF','인용','읽기']);
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

test('collapsed filter chips remove only the requested rule and rules apply to note searches',async()=>{
 const f=fixture();f.runtime.state=ref=>({status:ref.id===1?'done':'reading',rating:4});await f.bench.show('notes');assert.equal(f.bench.panel.querySelector('.sc-filters').hasAttribute('open'),false);
 await f.bench.filters.set([{id:'s',kind:'status',values:['done']}]);f.input('작업 패널 검색','Rich note');await settle();assert.deepEqual(f.calls.filter(c=>c[0]==='notes').at(-1)[1],['1']);/* 2026-10-03: the chip names the scope; the count is in its tooltip. */assert.match(f.bench.panel.querySelector('.sc-context-detail').title,/1개 문헌/);assert.match(f.body().textContent,/Rich note/);
 const remove=f.bench.panel.querySelector('.sc-rule-chip-x');assert.match(remove.getAttribute('aria-label'),/읽기 상태.*규칙 삭제/);remove.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();assert.equal(f.bench.filters.rules().length,0);assert.equal(f.bench.state.query,'Rich note');assert.equal(f.calls.filter(c=>c[0]==='notes').at(-1)[1],undefined);f.bench.destroy();
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
 f.library.attachments=f.record('attachments',[{id:'99',title:'Link',contentType:'text/html',path:null},{id:'100',title:'Archive',contentType:'application/zip',path:'/fake/archive.zip'}]);await f.bench.show('attachments');assert.equal(f.findButton('미리보기'),undefined);assert.match(f.body().textContent,/미리보기를 지원하지 않는 형식입니다/);assert.ok(f.findButton('열기'));f.bench.destroy();
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
 const f=fixture();f.runtime.getSetting=key=>({explorePageSize:25,inlineEvidenceCount:5,maxExcerptLength:1200,workbenchDensity:'comfortable'})[key];f.runtime.formatReadTime=seconds=>Math.floor(seconds||0)+'s';f.papers.splice(0);for(let id=1;id<=30;id++){f.papers.push({id:String(id),title:'Paper '+id,itemType:'journalArticle',tags:[]});f.refs.set(id,{id});}let seconds=0;f.runtime.state=()=>({seconds,status:seconds?'reading':'unread',citations:null,impactFactor:null});await f.bench.show('explore');assert.equal(f.body().querySelectorAll('.sc-paper-card').length,25);const card=f.body().querySelector('[data-item-id="1"]');assert.equal(card.querySelector('[data-metric=time] .sc-metric-value').textContent,'—','unread: the time is dashed, not blank');seconds=1;f.bench.refreshMetrics();assert.equal(f.body().querySelector('[data-item-id="1"]'),card);assert.match(card.querySelector('[data-metric=time] .sc-metric-value').textContent,/1s/);assert.equal(card.dataset.status,'reading');f.bench.destroy();
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
 // One word for owned, as the reading order and the timeline write it.
 assert.equal(redrawn.querySelector('.sc-hit-owned').textContent,'보유');
 assert.equal(redrawn.querySelector('.sc-hit-actions'),null,'an owned paper has nothing left to do');
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/Imported paper/);
 f.bench.destroy();
});

test('an owned paper leads to itself, and unfollowing from the author page takes two presses',async()=>{
 const f=fixture();
 const works=[{...(await f.runtime.authorUpdates('A1')).works[0],inLibrary:true}];
 f.runtime.authorUpdates=async id=>({profile:{name:'A Author'},works,fresh:[],watching:true});
 f.runtime.itemForDOI=doi=>({id:77,getField:()=>'Owned paper'});
 const picked=[];f.win.ZoteroPane.selectItem=async id=>{picked.push(id);};
 f.runtime.authorsOfCached=async()=>[{id:'A1',name:'Only Author',institution:'Somewhere',position:'first'}];
 await f.bench.show('authors');
 await f.click('보기');
 assert.deepEqual(picked,[77],'보기 selects the paper in the list behind the panel');
 await f.click('관심 해제');
 assert.equal(f.calls.filter(c=>c[0]==='unwatchAuthor').length,0,'one press only arms it');
 await f.click('정말 해제');
 assert.equal(f.calls.filter(c=>c[0]==='unwatchAuthor').length,1);
 f.bench.destroy();
});

test('the citation map names the papers it says you lack, and asks only about what it has not asked',async()=>{
 const f=fixture();
 const extra=[];
 for(const n of [10,11,12]){extra.push({...f.papers[0],id:String(n),key:'K'+n,title:'Mine '+n});f.refs.set(n,{id:n,libraryID:1,key:'K'+n});}
 f.library.snapshot=async()=>[...f.papers,...extra];
 const works={};
 for(const p of [...f.papers,...extra])works['1:'+p.key]={openalex:'W'+p.id,references:['W99','W98','W'+(p.id==='1'?'2':'1')]};
 // Paper 2 is one OpenAlex does not know: answered, not "remaining".
 works['1:K2']={missing:true,references:[]};
 f.runtime.graphTools=PaperGraph;f.runtime.paperWorks=()=>works;f.runtime.journalIdentity=f.runtime.journalIdentity||JournalIdentity;
 f.runtime.identity=ref=>'1:'+(ref.key||'K'+ref.id);
 f.runtime.citedByStore=()=>({});f.runtime.citedByFor=()=>({});
 f.runtime.libraryDOIs=()=>new Set(['10.1/owned']);
 f.runtime.worksByID=async ids=>({W99:{id:'W99',title:'The paper everyone cites',year:2001,doi:'10.1/w99',venue:'Cell'},W98:{id:'W98',title:'One I have',year:1999,doi:'10.1/owned'}});
 await f.bench.show('graph');await settle();
 const text=f.body().textContent+f.bench.panel.textContent;
 assert.equal(/인용 목록 가져오기/.test([...f.bench.panel.querySelectorAll('button')].map(b=>b.textContent).join('|')),false,'every paper has been asked about');
 assert.match(text,/The paper everyone cites/,'a title, not W99');
 assert.equal(/\bW99\b/.test([...f.body().querySelectorAll('.sc-hit-title')].map(t=>t.textContent).join(' ')),false);
 // The graph in a sentence: one cluster, and the paper the others here stand on.
 // 2026-10-03: the figures are stat tiles now (이어진 논문 · 인용 · 묶음); the sentence names only the most cited paper.
 assert.match(f.body().querySelector('.sc-graph-insight')?.textContent||'',/Paper Alpha \(3편이 인용\)/);
 assert.ok([...f.body().querySelectorAll('.sc-overview-fact')].some(t=>/^1\s*묶음$/.test(t.textContent)),'묶음 1 is a tile: '+[...f.body().querySelectorAll('.sc-overview-fact')].map(t=>t.textContent).join('|'));
 // A node chosen is pinned under the map, with who cites it.
 const alphaNode=[...f.body().querySelectorAll('svg g[tabindex]')].find(g=>/Paper Alpha/.test(g.querySelector('title')?.textContent||''));
 alphaNode.dispatchEvent(new f.win.Event('click'));
 const info=f.body().querySelector('.sc-graph-info');
 assert.equal(info.hidden,false);
 assert.match(info.textContent,/이 논문을 인용한 문헌 3/);
 const owned=[...f.body().querySelectorAll('.sc-hit')].find(h=>/One I have/.test(h.textContent));
 assert.ok(owned.querySelector('.sc-hit-owned'),'one on the shelf says 보유');
 f.bench.destroy();
});

test('주변 mode draws one chosen paper\'s direct citation neighbourhood, entirely from the cache, and offers its unread neighbours',async()=>{
 const f=fixture();
 const extra=[10,11,12,13].map(n=>({...f.papers[0],id:String(n),key:'K'+n,title:'Neighbour '+n}));
 for(const n of [10,11,12,13])f.refs.set(n,{id:n,libraryID:1,key:'K'+n});
 f.library.snapshot=async()=>[...f.papers,...extra];
 f.runtime.state=ref=>({citations:3,impactFactor:4,status:{10:'unread',11:'done',12:'unread',13:'unread'}[ref.id]||'reading'});
 const works={
  '1:K1':{openalex:'W1',references:['W10','W11']},   // Alpha cites 10 and 11: 참고문헌.
  '1:K10':{openalex:'W10',references:[]},
  '1:K11':{openalex:'W11',references:[]},
  '1:K12':{openalex:'W12',references:['W1']},         // 12 cites Alpha: 인용한 문헌.
  '1:K13':{openalex:'W13',references:[]},              // Not connected to Alpha at all.
  '1:K2':{openalex:'W2',references:[]}
 };
 f.runtime.graphTools=PaperGraph;f.runtime.paperWorks=()=>works;f.runtime.journalIdentity=JournalIdentity;
 f.runtime.identity=ref=>'1:'+(ref.key||'K'+ref.id);
 await f.bench.show('graph');
 f.bench.state.selected=new Set();await f.bench.render();
 assert.match(f.body().textContent,/문헌 하나를 고르면 주변을 봅니다/,'nothing chosen: the switch explains itself and stays put');
 f.bench.state.selected=new Set(['1']);
 f.bench.state.graphScope='neighbours';
 await f.bench.render();
 assert.match(f.body().textContent,/참고문헌 2/,'the two papers Alpha cites, found without asking OpenAlex again');
 assert.match(f.body().textContent,/인용한 문헌 1/,'the one paper found citing Alpha from its own cached reference list');
 // Paper 13, unconnected to Alpha, never appears on the map.
 assert.equal([...f.body().querySelectorAll('svg title')].some(t=>/Neighbour 13/.test(t.textContent)),false);
 assert.equal([...f.body().querySelectorAll('svg title')].some(t=>/Neighbour 10/.test(t.textContent)),true);
 const unreadBtn=f.findButton('안 읽음 2');
 assert.ok(unreadBtn,'11 is done, so only 10 and 12 are counted as unread');
 unreadBtn.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.equal(f.bench.state.tab,'explore');
 assert.deepEqual([...f.bench.state.selected].sort(),['10','12']);
 f.bench.destroy();
});

test('주변 mode never offers a fetch button, and leaving it restores the current-scope graph',async()=>{
 const f=fixture();
 const extra=[10].map(n=>({...f.papers[0],id:String(n),key:'K'+n,title:'Neighbour '+n}));
 f.refs.set(10,{id:10,libraryID:1,key:'K10'});
 f.library.snapshot=async()=>[...f.papers,...extra];
 const works={'1:K1':{openalex:'W1',references:['W10']},'1:K10':{openalex:'W10',references:[]},'1:K2':{}};
 f.runtime.graphTools=PaperGraph;f.runtime.paperWorks=()=>works;f.runtime.journalIdentity=JournalIdentity;
 f.runtime.identity=ref=>'1:'+(ref.key||'K'+ref.id);
 f.bench.state.selected=new Set(['1']);
 f.bench.state.graphScope='neighbours';
 await f.bench.show('graph');
 assert.equal(/인용 목록 가져오기/.test(f.body().textContent),false,'주변 already has what it needs, so it never asks OpenAlex');
 assert.equal(/인용한 논문 가져오기/.test(f.body().textContent),false);
 await f.click('현재 범위');
 assert.equal(f.bench.state.graphScope,'scope');
 assert.equal(f.findButton('안 읽음 0'),undefined,'the neighbour-only summary line is gone once back on 현재 범위');
 f.bench.destroy();
});

test('관계 그래프 labels are short title + year, a small graph labels every node, and a cited line pulls back so its arrowhead shows',async()=>{
 const f=fixture();
 const extra=[10].map(n=>({...f.papers[0],id:String(n),key:'K'+n,title:'A Very Long Neighbour Paper Title About Something'}));
 f.refs.set(10,{id:10,libraryID:1,key:'K10'});
 f.library.snapshot=async()=>[...f.papers,...extra];
 const works={'1:K1':{openalex:'W1',references:['W10']},'1:K10':{openalex:'W10',references:[]},'1:K2':{}};
 f.runtime.graphTools=PaperGraph;f.runtime.paperWorks=()=>works;f.runtime.journalIdentity=JournalIdentity;
 f.runtime.identity=ref=>'1:'+(ref.key||'K'+ref.id);
 await f.bench.show('graph');await settle();
 const labels=[...f.body().querySelectorAll('.sc-graph-label')];
 assert.ok(labels.length>=2,'both connected papers are drawn');
 // Short title + year, not a journal mark and a year: a long title is cut and the year follows.
 const long=labels.find(l=>l.textContent.includes('…'));
 assert.ok(long,'the long title is shortened');
 // 2026-10-03: the year follows after a middle dot, and no title ends on a function word.
 assert.match(long.textContent,/…\s·\s\d{4}$/);
 assert.ok(!/\s(and|of|the|in|for|to|a|on)…/i.test(long.textContent),'no hanging function word');
 // A small graph, well under any collision limit: nothing is hidden for lack of room.
 assert.ok(labels.every(l=>l.getAttribute('display')!=='none'),'a small graph labels every node');
 // Paper Alpha (1) cites Neighbour 10; the line should stop short of its centre, or the arrowhead draws under the node.
 const line=f.body().querySelector('svg line[marker-end]');
 assert.ok(line,'the citation carries an arrow');
 const target=[...f.body().querySelectorAll('svg g[tabindex]')].find(g=>/A Very Long Neighbour/.test(g.querySelector('title')?.textContent||''));
 const [tx,ty]=target.getAttribute('transform').match(/-?\d+\.?\d*/g).map(Number);
 assert.notEqual(Number(line.getAttribute('x2')),tx);
 assert.notEqual(Number(line.getAttribute('y2')),ty);
 f.bench.destroy();
});

test('a small citation map places every label by side rather than always right of the node',async()=>{
 const f=fixture();
 const extra=[10].map(n=>({...f.papers[0],id:String(n),key:'K'+n,title:'Neighbour '+n}));
 f.refs.set(10,{id:10,libraryID:1,key:'K10'});
 f.library.snapshot=async()=>[...f.papers,...extra];
 const works={'1:K1':{openalex:'W1',references:['W10']},'1:K10':{openalex:'W10',references:[]},'1:K2':{}};
 let sidesCalled=0;
 const graphTools={...PaperGraph,placeLabelSides:(...args)=>{sidesCalled++;return PaperGraph.placeLabelSides(...args);}};
 f.runtime.graphTools=graphTools;f.runtime.paperWorks=()=>works;f.runtime.journalIdentity=JournalIdentity;
 f.runtime.identity=ref=>'1:'+(ref.key||'K'+ref.id);
 await f.bench.show('graph');await settle();
 assert.ok(sidesCalled>0,'a small graph places labels by side instead of always right of the node');
 assert.ok(f.body().querySelector('.sc-graph-label'),'a label is still drawn');
 f.bench.destroy();
});

test('주변 mode fills a lacked paper\'s title only from the work-metadata cache, and never asks OpenAlex',async()=>{
 const f=fixture();
 const extra=[10,11,12].map(n=>({...f.papers[0],id:String(n),key:'K'+n,title:'Neighbour '+n}));
 for(const n of [10,11,12])f.refs.set(n,{id:n,libraryID:1,key:'K'+n});
 f.library.snapshot=async()=>[...f.papers,...extra];
 // 10, 11 and 12 all cite Alpha (so they are her 인용한 문헌) and all three
 // also cite W999, which nothing on the shelf holds -- three citers clears
 // the missingFloor of 3, so it is named under the graph.
 const works={
  '1:K1':{openalex:'W1',references:[]},
  '1:K10':{openalex:'W10',references:['W1','W999']},
  '1:K11':{openalex:'W11',references:['W1','W999']},
  '1:K12':{openalex:'W12',references:['W1','W999']},
  '1:K2':{openalex:'W2',references:[]}
 };
 f.runtime.graphTools=PaperGraph;f.runtime.paperWorks=()=>works;f.runtime.journalIdentity=JournalIdentity;
 f.runtime.identity=ref=>'1:'+(ref.key||'K'+ref.id);
 f.runtime.cache.workMeta={W999:{id:'W999',title:'Cached Elsewhere',doi:'10.1/cached'}};
 let asked=0;f.runtime.worksByID=async()=>{asked++;return {};};
 f.bench.state.selected=new Set(['1']);
 f.bench.state.graphScope='neighbours';
 await f.bench.show('graph');
 await settle();
 assert.match(f.body().textContent,/Cached Elsewhere/,'the cached title fills in without a request');
 assert.equal(asked,0,'주변 mode never calls worksByID, even for a paper it lacks');
 f.bench.destroy();
});

test('zooming 선택 문헌 주변 keeps its middle too, the same centred frame as the current-scope map',async()=>{
 const f=fixture();
 const extra=[10].map(n=>({...f.papers[0],id:String(n),key:'K'+n,title:'Neighbour '+n}));
 f.refs.set(10,{id:10,libraryID:1,key:'K10'});
 f.library.snapshot=async()=>[...f.papers,...extra];
 const works={'1:K1':{openalex:'W1',references:['W10']},'1:K10':{openalex:'W10',references:[]},'1:K2':{}};
 f.runtime.graphTools=PaperGraph;f.runtime.paperWorks=()=>works;f.runtime.journalIdentity=JournalIdentity;
 f.runtime.identity=ref=>'1:'+(ref.key||'K'+ref.id);
 f.bench.state.selected=new Set(['1']);
 f.bench.state.graphScope='neighbours';
 await f.bench.show('graph');
 await settle();
 const svg=f.body().querySelector('svg.sc-graph');
 assert.ok(svg,'the citation map is drawn');
 const [x0,y0,w0,h0]=svg.getAttribute('viewBox').split(/\s+/).map(Number);
 await f.click('확대');await f.click('확대');
 const [x1,y1,w1,h1]=svg.getAttribute('viewBox').split(/\s+/).map(Number);
 assert.ok(w1<w0&&h1<h0,'two presses zoomed in');
 assert.equal(Math.round(x0+w0/2),Math.round(x1+w1/2),'the centre held horizontally');
 assert.equal(Math.round(y0+h0/2),Math.round(y1+h1/2),'the centre held vertically');
 f.bench.destroy();
});

test('a paper\'s author list says who is followed and follows the rest in one press',async()=>{
 const f=fixture();
 f.runtime.watchedAuthors=()=>[{id:'A1',name:'First Author'}];
 f.runtime.discoverTools={shortID:id=>String(id)};
 f.runtime.authorActivityCached=async id=>({profile:{name:'Second Author'},works:[{id:'W1'},{id:'W2'}]});
 f.runtime.authorsOfCached=async()=>[{id:'A1',name:'First Author',position:'first'},{id:'A2',name:'Second Author',position:'last'}];
 await f.bench.show('authors');
 const rows=[...f.body().querySelectorAll('.sc-hits .sc-hit')];
 assert.match(rows[0].textContent,/관심 저자/);
 assert.equal([...rows[0].querySelectorAll('button')].some(b=>b.textContent==='관심 저자로 등록'),false);
 await f.click('관심 저자로 등록');
 const call=f.calls.find(c=>c[0]==='watchAuthor');
 assert.equal(call[1].id,'A2');assert.deepEqual(call[1].seen,['W1','W2'],'what they have already published is the baseline');
 f.bench.destroy();
});

test('a memo being typed is not rebuilt by its own save; the reload waits until the field is left',async()=>{
 const f=fixture();
 await f.bench.show('annotations');
 const loads=()=>f.calls.filter(c=>c[0]==='annotations').length;
 const memo=f.body().querySelector('textarea.sc-annot-memo');
 assert.ok(memo,'the annotation carries its memo');
 memo.focus();memo.value='half a thought';
 const before=loads();
 f.notify();await new Promise(resolve=>setTimeout(resolve,230));await settle();
 assert.equal(loads(),before,'no reload under the cursor');
 assert.equal(f.body().querySelector('textarea.sc-annot-memo'),memo,'the same field, still there');
 f.doc.body.focus();memo.dispatchEvent(new f.win.Event('focusout',{bubbles:true}));
 await new Promise(resolve=>setTimeout(resolve,230));await settle();
 assert.ok(loads()>before,'and the change arrives once the reader has left the field');
 f.bench.destroy();
});

test('choosing one annotation colour keeps the other colours on offer, and no file scan runs for group names',async()=>{
 const f=fixture();
 f.library.annotations=async()=>[{id:'3',parentID:'1',attachmentID:'99',text:'Yellow one',comment:'',color:'#ffd400',type:'highlight',pageIndex:0},
  {id:'4',parentID:'1',attachmentID:'99',text:'Red one',comment:'',color:'#ff6666',type:'highlight',pageIndex:1}];
 f.refs.set(99,{id:99,parentID:1,getField:()=>'Main PDF'});
 let scans=0;f.library.attachments=async()=>{scans++;return [];};
 await f.bench.show('annotations');
 const chips=()=>[...f.body().querySelectorAll('.sc-annot-swatch')];
 assert.equal(chips().length,2);
 chips()[0].click();await settle();
 assert.equal(f.body().querySelectorAll('.sc-annot').length,1,'one colour shown');
 assert.equal(chips().length,2,'the other colour can still be chosen');
 assert.equal(scans,0,'the documents on screen are read directly');
 f.bench.destroy();
});

test('an annotation colour chip with a meaning label never shows the raw hex, only in its title',async()=>{
 const f=fixture();
 f.library.annotations=async()=>[{id:'3',parentID:'1',attachmentID:'99',text:'Yellow one',comment:'',color:'#ffd400',type:'highlight',pageIndex:0}];
 f.refs.set(99,{id:99,parentID:1,getField:()=>'Main PDF'});
 f.runtime.cache.readerSettings={...(f.runtime.cache.readerSettings||{}),colorLabels:{'#ffd400':'핵심 결과'}};
 await f.bench.show('annotations');
 const chip=f.body().querySelector('.sc-annot-swatch');
 assert.equal(chip.querySelector('.sc-annot-meaning').textContent,'핵심 결과');
 assert.doesNotMatch(chip.textContent,/#ffd400/i,'the hex never appears as visible text once the colour has a meaning');
 assert.match(chip.getAttribute('title'),/#ffd400/i,'but stays available in the tooltip');
 f.bench.destroy();
});

test('the tag verbs refuse in words, say what they did, and a removal can be undone',async()=>{
 const f=fixture();
 await f.bench.show('tags');
 f.bench.state.selected=new Set();
 await f.click('선택 문헌에 태그 추가');
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/먼저 선택하세요/);
 f.bench.state.selected=new Set(['1','2']);await f.bench.render();
 await f.click('선택 문헌에 태그 추가');
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/태그 이름을 입력하세요/);
 f.input('추가할 태그','topic/a');
 await f.click('선택 문헌에서 태그 제거');
 const removed=f.calls.find(c=>c[0]==='removeTags');
 assert.deepEqual(removed[1],['1','2']);
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/1편에서 태그 topic\/a를 뺐습니다/);
 await f.click('되돌리기');
 assert.deepEqual(f.calls.filter(c=>c[0]==='addTags').pop().slice(1),[['1'],['topic/a']],'given back only to the paper that carried it');
 // Two papers, two different tags: each gets back its own.
 f.bench.state.items.find(i=>i.id==='2').tags=['topic/b'];
 f.input('추가할 태그','topic/a, topic/b');
 await f.click('선택 문헌에서 태그 제거');
 const before=f.calls.filter(c=>c[0]==='addTags').length;
 await f.click('되돌리기');
 const back=f.calls.filter(c=>c[0]==='addTags').slice(before).map(c=>c.slice(1));
 assert.deepEqual(back.sort(),[[['1'],['topic/a']],[['2'],['topic/b']]].sort());
 f.bench.destroy();
});

test('a canvas card keeps the keyboard as it moves, and deleted cards come back with their links',async()=>{
 const f=fixture();
 await f.bench.show('canvas');f.input('보드 이름','Board');await f.click('보드 만들기');
 f.bench.state.selected=new Set(['1','2']);await f.click('선택 문헌 추가');
 const board=f.runtime.cache.boards[0];
 const [a,b]=board.nodes;
 const handle=()=>f.body().querySelector(`.sc-canvas-card[data-card-id="${a.id}"] h3`);
 const x=a.x;
 {const e=new f.win.Event('keydown',{bubbles:true,cancelable:true});e.key='ArrowRight';handle().dispatchEvent(e);}await settle();
 assert.equal(f.doc.activeElement,handle(),'the moved card still has the keyboard');
 {const e=new f.win.Event('keydown',{bubbles:true,cancelable:true});e.key='ArrowRight';handle().dispatchEvent(e);}await settle();
 assert.equal(board.nodes.find(n=>n.id===a.id).x,x+20,'two presses, two steps');
 f.bench.state.cardIDs=new Set([a.id,b.id]);await f.click('카드 연결');
 f.bench.state.cardIDs=new Set([a.id]);await f.click('선택 카드 삭제');
 assert.equal(board.nodes.length,1);assert.equal(board.edges.length,0);
 await f.click('카드 삭제 되돌리기');
 assert.equal(board.nodes.length,2,'the card is back');assert.equal(board.edges.length,1,'and so is its link');
 f.bench.state.cardIDs=new Set();await f.click('선택 카드 삭제');
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/지울 카드를 먼저 선택하세요/);
 f.bench.destroy();
});

test('backlinks name the paper a note sits under, once each; attachments come a hundred at a time; an empty note is not made',async()=>{
 const f=fixture();
 f.library.backlinks=async()=>[{id:'9',title:'Reading note',kind:'note',parentTitle:'Paper Beta'},{id:'9',title:'Reading note',kind:'note',parentTitle:'Paper Beta'},{id:'2',title:'Paper Beta',kind:'related'}];
 await f.bench.show('backlinks');
 assert.equal(f.body().querySelectorAll('.sc-card').length,2,'the note that links twice is one row');
 assert.match(f.body().textContent,/노트 · Paper Beta/);
 assert.match(f.body().textContent,/이 문헌을 가리키는 항목/);
 f.library.attachments=async()=>Array.from({length:130},(_,i)=>({id:String(500+i),parentID:'1',title:'File '+i,contentType:'application/pdf'}));
 f.bench.state.scope='library';
 await f.bench.show('attachments');
 assert.equal(f.body().querySelectorAll('.sc-attachment-row').length,100);
 assert.match(f.body().textContent,/이 범위의 첨부파일/);
 await f.click('100개 더 보기');
 assert.equal(f.body().querySelectorAll('.sc-attachment-row').length,130);
 await f.bench.show('notes');
 await f.click('새 노트 저장');
 assert.equal(f.calls.filter(c=>c[0]==='createNote').length,0,'no blank note');
 f.bench.destroy();
});

test('a tab group needs a name and an open document, says it was saved, and clears the name',async()=>{
 const f=fixture();
 f.reader.tabs=()=>[{id:'tab1',title:'Paper Alpha',itemID:'1',selected:true}];
 await f.bench.show('tabs');
 const save=f.findButton('열린 탭 저장');
 assert.equal(save.disabled,true,'no name, no save');
 f.input('탭 그룹 이름','Morning reading');
 assert.equal(f.findButton('열린 탭 저장').disabled,false);
 await f.click('열린 탭 저장');
 assert.deepEqual(f.calls.find(c=>c[0]==='saveTabs').slice(2),['Morning reading']);
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/“Morning reading” 탭 그룹을 저장했습니다 · 문서 1개/);
 assert.equal(f.body().querySelector('[aria-label="탭 그룹 이름"]').value,'','the name is cleared for the next group');
 f.reader.tabs=()=>[{id:'lib',title:'Library'}];await f.bench.render();
 f.input('탭 그룹 이름','Nothing open');
 assert.equal(f.findButton('열린 탭 저장').disabled,true,'without a document open there is nothing to save');
 f.bench.destroy();
});

test('the AI requests are off until a server is set, and those that need an abstract say so',async()=>{
 const f=fixture();
 const basePref=f.runtime.pref;
 f.runtime.pref=(key,fallback)=>key==='aiEndpoint'?'':basePref(key,fallback);
 await f.bench.show('assist');
 assert.equal(f.findButton('제목 번역').disabled,true,'no server, no request');
 f.runtime.pref=basePref;
 f.library.snapshot=async()=>f.papers.map(p=>({...p,abstract:''}));
 await f.bench.load();await f.bench.show('assist');
 assert.equal(f.findButton('제목 번역').disabled,false,'a title can always be translated');
 assert.equal(f.findButton('초록 요약').disabled,true,'no abstract, no summary');
 assert.match(f.body().textContent,/초록이 없어/);
 f.bench.destroy();
});

test('the menu rail is one Tab stop walked with the arrow keys',async()=>{
 const f=fixture();
 await f.bench.show('explore');
 const rail=[...f.bench.panel.querySelectorAll('[data-tab]')].filter(b=>!b.hidden);
 assert.deepEqual(rail.filter(b=>b.getAttribute('tabindex')==='0').map(b=>b.dataset.tab),['explore'],'only the current entry is a Tab stop');
 rail[0].focus();
 const e=new f.win.Event('keydown',{bubbles:true,cancelable:true});e.key='ArrowDown';rail[0].dispatchEvent(e);
 assert.equal(f.doc.activeElement.dataset.tab,rail[1].dataset.tab,'down moves to the next entry');
 const end=new f.win.Event('keydown',{bubbles:true,cancelable:true});end.key='End';f.doc.activeElement.dispatchEvent(end);
 assert.equal(f.doc.activeElement,rail[rail.length-1]);
 f.bench.destroy();
});

test('settings actions say what they did, and the selection bar stays off pages with no papers',async()=>{
 const f=fixture();
 f.runtime.setCustomFields=async value=>value.split(',').map(v=>v.trim()).filter(Boolean);
 await f.bench.show('appearance');
 const status=()=>f.bench.panel.querySelector('.sc-status').textContent;
 await f.click('스타일 저장');assert.match(status(),/패널 모양을 저장했습니다/);
 const fields=f.body().querySelector('[aria-label="추가 열"], input[placeholder*="extra"], input[aria-label*="필드"]');
 if(fields){fields.value='extra, archive';fields.dispatchEvent(new f.win.Event('input',{bubbles:true}));}
 await f.click('추가 열 적용');assert.match(status(),/오른쪽 클릭해 켜세요|모두 뺐습니다/,'where the new columns are, not "applied"');
 const footer=f.bench.panel.querySelector('.sc-selection-bar');
 assert.equal(footer.hidden,true,'settings has no papers to act on');
 await f.bench.show('tabs');assert.equal(footer.hidden,true);
 await f.bench.show('explore');assert.equal(footer.hidden,false);
 f.bench.state.selected=new Set(['1','2']);await f.bench.render();
 await f.click('관련 문헌으로 연결');assert.match(status(),/2개 문헌을 서로 관련 문헌으로 연결했습니다/);
 f.bench.destroy();
});

test('the command finder keeps the chosen line in view as the arrows move it',async()=>{
 const f=fixture();await f.bench.show('explore');
 const scrolled=[];f.win.HTMLElement.prototype.scrollIntoView=function(){scrolled.push(this.id);};
 const key=(target,value,extras={})=>{const e=new f.win.Event('keydown',{bubbles:true,cancelable:true});Object.assign(e,{key:value,...extras});target.dispatchEvent(e);return e;};
 key(f.bench.panel.querySelector('[aria-label="작업 패널 검색"]'),'k',{metaKey:true});
 const finder=f.bench.panel.querySelector('.sc-command-search');
 key(finder,'End');
 const last=[...f.bench.panel.querySelectorAll('.sc-command-option')].pop();
 assert.equal(scrolled.at(-1),last.id,'the last entry is scrolled to, not left below the fold');
 key(finder,'Escape');
 f.bench.destroy();
});

test('the list opens with a summary whose reading counts filter it, and figures sit under one sortable header',async()=>{
 const f=fixture();
 f.library.snapshot=async()=>f.papers.map((p,i)=>({...p,status:i?'done':'reading',seconds:600,impactFactor:i?4:8,citations:10}));
 await f.bench.load();await f.bench.show('explore');
 const facts=f.body().querySelector('.sc-overview-facts');
 assert.ok(facts,'a summary line');
 assert.match(facts.textContent,/읽는 중/);
 const reading=[...facts.querySelectorAll('button')].find(b=>/읽는 중/.test(b.textContent));
 reading.click();await settle();
 assert.deepEqual(f.bench.filters.rules().map(r=>[r.kind,r.values[0]]),[['status','reading']],'pressed, the list shows only those');
 await f.bench.filters.set([]);
 const ifHead=[...f.body().querySelectorAll('.sc-paper-column')].find(b=>b.dataset.metric==='impact');
 ifHead.click();await settle();
 assert.equal(f.bench.state.sort,'if-desc');
 f.bench.destroy();
});

test('followed authors\' news is one list: a shared paper once with both names, owned ones say how far read',async()=>{
 const f=fixture();
 f.runtime.watchedAuthorsByNews=()=>[
  {id:'A1',name:'First Person',seen:[],news:[{id:'W1',title:'Shared paper',doi:'10.1/shared',date:'2026-09-01'}]},
  {id:'A2',name:'Second Person',seen:[],news:[{id:'W1',title:'Shared paper',doi:'10.1/shared',date:'2026-09-01'},{id:'W2',title:'Owned one',doi:'10.1234/a',date:'2026-08-01'}]}];
 await f.bench.show('authors');
 const rows=[...f.body().querySelectorAll('.sc-author-inbox-row')];
 assert.equal(rows.length,2,'the shared paper once');
 assert.match(rows[0].textContent,/First Person/);assert.match(rows[0].textContent,/Second Person/);
 assert.match(rows[1].querySelector('.sc-inbox-status').textContent,/보유/);
 f.bench.destroy();
});

test('a new paper marked 확인함 leaves the unseen list, is found under 확인함, comes back, and the search reads names',async()=>{
 const f=fixture();
 f.runtime.watchedAuthorsByNews=()=>[
  {id:'A1',name:'First Person',seen:[],news:[{id:'W1',title:'Shared paper',doi:'10.1/shared',date:'2026-09-01'},{id:'W3',title:'Withdrawn one',doi:'10.1/bad',date:'2026-07-01',signals:{rank:3}}]},
  {id:'A2',name:'Second Person',seen:[],news:[{id:'W1',title:'Shared paper',doi:'https://doi.org/10.1/SHARED',date:'2026-09-01'},{id:'W2',title:'Owned one',doi:'10.1234/a',date:'2026-08-01'}]}];
 await f.bench.show('authors');
 // The paper's own words: the 철회 chip now stands on the title's line, beside the link rather than in the status column.
 const titles=()=>[...f.body().querySelectorAll('.sc-author-inbox-row .sc-hit-title')].map(n=>(n.querySelector('.sc-hit-title-link')||n).textContent);
 assert.match(f.body().querySelector('.sc-watch-count').textContent,/새 논문 3편/,'the heading counts the shared paper once, as the list does');
 assert.deepEqual(titles(),['Shared paper','Owned one','Withdrawn one']);
 assert.match(f.body().querySelectorAll('.sc-author-inbox-row')[2].textContent,/철회/,'a withdrawn paper says so');
 await f.click('확인함');
 assert.deepEqual(titles(),['Owned one','Withdrawn one'],'out of the unseen list');
 assert.ok(f.runtime.cache.workbenchUI.inboxSeen,'kept with the panel settings');
 assert.equal(f.runtime.watchedAuthorsByNews()[0].news.length,2,'the authors’ own news is untouched');
 await f.click('확인함 1');
 assert.deepEqual(titles(),['Shared paper']);
 await f.click('되돌리기');
 await f.click('미확인 3');
 assert.deepEqual(titles(),['Shared paper','Owned one','Withdrawn one']);
 const find=f.body().querySelector('[aria-label="새 논문 검색"]');find.value='second';find.dispatchEvent(new f.win.Event('input'));
 await new Promise(r=>setTimeout(r,200));
 assert.deepEqual(titles(),['Shared paper','Owned one'],'by a followed author’s name');
 f.bench.destroy();
});

test('recent papers say what brought them there and when; the summary names the unread papers cited most a year; author cards say what the library holds',async()=>{
 const f=fixture();
 const day=864e5,now=Date.now();
 const known={1:{status:'',citations:40,lastRead:new Date(now-2*day).toISOString()},2:{status:'',citations:300},5:{status:'done',citations:900}};
 f.runtime.state=ref=>({impactFactor:4,...known[ref.id]});
 const extra={id:'5',key:'K5',libraryID:1,title:'A finished classic',authors:'Grace Hopper',year:'1990',venue:'Nature',itemType:'journalArticle',tags:[]};
 f.library.snapshot=async()=>[{...f.papers[0],year:String(new Date().getFullYear()),dateAdded:new Date(now-9*day).toISOString()},{...f.papers[1],year:'2000',dateAdded:new Date(now-4*day).toISOString()},extra];
 f.refs.set(5,{id:5});
 await f.bench.show('recent');
 const why=[...f.body().querySelectorAll('.sc-paper-card')].map(c=>[c.querySelector('.sc-paper-title').textContent,c.querySelector('.sc-paper-why')?.textContent]);
 assert.deepEqual(why.slice(0,2),[['Paper Alpha','읽음 · 2일 전'],['Paper Beta','추가 · 4일 전 · 읽기 기록 없음']]);
 await f.bench.show('explore');
 const picks=[...f.body().querySelectorAll('.sc-overview-pick')].map(p=>p.textContent);
 // Alpha: 40 in its first year; Beta: 300 over 26 years (ZotPoP's convention, max(1, now - year)) -- about 12 a year. The done paper is not offered.
 assert.equal(picks.length,2);
 assert.match(picks[0],/Paper Alpha.*연 40회/);
 assert.match(picks[1],/Paper Beta.*연 12회/);
 f.runtime.watchedAuthorsByNews=()=>[{id:'A1',name:'Ada Lovelace',seen:[],news:[]},{id:'A2',name:'A. M. Lovelace',seen:[],news:[]},{id:'A9',name:'Nobody Here',seen:[],news:[]}];
 await f.bench.show('authors');await f.click('조용한 저자 3명 보기');
 const cards=[...f.body().querySelectorAll('.sc-watch')];
 assert.equal(cards[0].querySelector('.sc-watch-mine')?.textContent,'서재 2','the full name as the library spells it');
 assert.equal(cards[1].querySelector('.sc-watch-mine')?.textContent,'서재 2?','family name and initial only: said to be a guess');
 assert.equal(cards[2].querySelector('.sc-watch-mine'),null);
 f.bench.destroy();
});

test('an owned unread paper from the inbox waits under 읽기 대기 until reading starts, and the pages it was marked on come with their notes',async()=>{
 const f=fixture();
 const known={1:{status:''},2:{status:''}};
 f.runtime.state=ref=>({citations:3,impactFactor:4,...known[ref.id]});
 f.runtime.watchedAuthorsByNews=()=>[{id:'A1',name:'First Person',seen:[],news:[{id:'W2',title:'Paper Alpha',doi:'10.1234/a',date:'2026-08-01'}]}];
 await f.bench.show('authors');
 await f.click('읽기 대기');
 assert.equal(f.body().querySelector('.sc-inbox-queue').getAttribute('aria-pressed'),'true');
 await f.bench.show('reading');
 const queued=()=>[...f.body().querySelectorAll('.sc-reading-queue-row .sc-resume-title')].map(n=>n.textContent);
 assert.deepEqual(queued(),['Paper Alpha']);
 assert.match(f.body().querySelector('.sc-reading-queue-row').textContent,/First Person/,'who it came from');
 // Reading begins: it leaves the queue for the reading lists.
 f.runtime.cache.items[1]={...(f.runtime.cache.items[1]||{}),seconds:30,lastRead:new Date(Date.now()+1000).toISOString()};
 f.runtime.pageProgress=ref=>ref.id===1?{pages:{3:60,5:2},total:8,visited:2,percent:25,attachmentID:100,lastPageIndex:5}:{pages:{},total:0,visited:0,percent:0};
 f.library.annotations=async()=>[{attachmentID:'100',pageIndex:3,pageLabel:'4',comment:'check the control',text:'',color:'#ffd400'},{attachmentID:'100',pageIndex:3,text:'second'},{attachmentID:'200',pageIndex:3,comment:'another PDF'}];
 await f.bench.show('explore');await f.bench.show('reading');
 assert.deepEqual(queued(),[]);
 // #3: 주석이 있는 쪽 merged into 쪽별 기록 -- one fold, one shared load.
 const fold=f.body().querySelector('.sc-resume-pages');
 fold.open=true;fold.dispatchEvent(new f.win.Event('toggle'));
 await new Promise(r=>setTimeout(r,20));
 const rows=[...f.body().querySelectorAll('.sc-reading-evidence-row')].map(r=>r.textContent);
 assert.equal(rows.length,1,'one page, this PDF only');
 assert.match(rows[0],/4쪽.*주석 2개.*check the control/);
 // Once loaded, the fold's own summary says how much it holds without opening it again.
 assert.match(f.body().querySelector('.sc-resume-pages summary').textContent,/쪽별 기록 · 방문 2\/8 · 주석 2/);
 f.bench.destroy();
});

test('collections show how much of each has been read, colour chips say what the colour means, and 최근 문헌 opens on the week',async()=>{
 const f=fixture();
 const now=Date.now(),day=864e5;
 const known={1:{status:'done',lastRead:new Date(now-2*day).toISOString(),seconds:120},2:{status:''}};
 f.runtime.state=ref=>({citations:3,impactFactor:4,...known[ref.id]});
 f.library.snapshot=async()=>[{...f.papers[0],dateAdded:new Date(now-20*day).toISOString()},{...f.papers[1],dateAdded:new Date(now-1*day).toISOString()}];
 f.library.collections=async()=>[{id:'4',name:'Research',count:2,itemIDs:[1,2],parentID:null}];
 await f.bench.show('collections');
 const row=f.body().querySelector('.sc-collection');
 assert.equal(row.querySelectorAll('.sc-collection-mix > span').length,2,'done and unread, in the bar');
 assert.equal(row.querySelector('.sc-collection-mixtext').textContent,'완료 1 · 안 읽음 1 · 2분 · 2일 전 읽음');
 f.runtime.cache.readerSettings={...(f.runtime.cache.readerSettings||{}),colorLabels:{'#FFD400':'핵심 결과'}};
 await f.bench.show('annotations');
 assert.equal(f.body().querySelector('.sc-annot-swatch .sc-annot-meaning')?.textContent,'핵심 결과','matched regardless of case');
 await f.bench.show('recent');
 assert.match(f.body().querySelector('.sc-recent-week').textContent,/지난 7일\s*1편\s*읽음\s*1편\s*추가/);
 f.bench.destroy();
});

test('a paper read in its article and its supplement resumes in either, each with its own page and time; annotations are found by their paper too',async()=>{
 const f=fixture();
 const recent=new Date(Date.now()-864e5).toISOString();
 f.runtime.state=ref=>({citations:3,impactFactor:4,status:ref.id===1?'reading':''});
 f.runtime.cache.items[1]={seconds:500,lastRead:recent,readingAttachments:{100:{pageTimes:{6:300},totalPages:12,lastPageIndex:6},200:{pageTimes:{1:120},totalPages:4,lastPageIndex:1}},readingAttachmentID:100};
 f.runtime.formatReadTime=sec=>`${sec}초`;
 f.refs.set(100,{id:100,getField:()=>'Main article'});f.refs.set(200,{id:200,getField:()=>'Supplementary'});
 f.runtime.pageProgress=(ref,att)=>ref.id!==1?{pages:{},total:0,visited:0,percent:0}
  :Number(att)===200?{pages:{1:120},total:4,visited:1,percent:25,attachmentID:200,lastPageIndex:1}
  :{pages:{6:300},total:12,visited:1,percent:8,attachmentID:100,lastPageIndex:6};
 await f.bench.show('reading');
 const row=()=>f.body().querySelector('.sc-resume-row');
 assert.match(row().textContent,/7쪽에서/);
 assert.match(row().querySelector('.sc-resume-meta').textContent,/이 파일 300초/,'this file’s time, not the paper’s 500');
 const pick=row().querySelector('.sc-reading-file');
 assert.deepEqual([...pick.options].map(o=>o.textContent),['Main article','Supplementary']);
 pick.value='200';pick.dispatchEvent(new f.win.Event('change'));
 assert.match(row().textContent,/2쪽에서/,'the supplement opens where it was left');
 await f.click('2쪽에서');
 assert.deepEqual(f.calls.filter(c=>c[0]==='open').pop().slice(1),[200,{pageIndex:1}]);
 // Annotations: a search for the author finds the paper's marks, and says how.
 f.library.annotations=async()=>[{id:'3',parentID:'1',attachmentID:'99',text:'control condition',comment:'',color:'#ffd400',pageIndex:0},{id:'4',parentID:'2',attachmentID:'98',text:'other',comment:'',color:'#ffd400',pageIndex:0}];
 f.refs.set(99,{id:99,parentID:1,getField:()=>'PDF'});f.refs.set(98,{id:98,parentID:2,getField:()=>'PDF'});
 await f.bench.show('annotations');
 assert.equal(f.body().querySelectorAll('.sc-annot-group').length,2,'each paper named');
 const search=f.bench.panel.querySelector('[aria-label="작업 패널 검색"]');search.value='Lovelace control';search.dispatchEvent(new f.win.Event('search'));
 await new Promise(r=>setTimeout(r,20));
 const shown=[...f.body().querySelectorAll('.sc-annot')];
 assert.equal(shown.length,1);
 assert.match(shown[0].textContent,/문헌 정보로 찾음/);
 assert.match(f.body().querySelector('.sc-annot-group-meta').textContent,/Science.*일치 주석 1개/);
 f.bench.destroy();
});

test('#3 쪽별 기록 is keyed by paper and attachment: switching the main PDF for its supplement does not keep showing the old file\'s marks',async()=>{
 const f=fixture();
 f.runtime.cache.items[1]={readingAttachments:{100:{pageTimes:{6:300},totalPages:12,lastPageIndex:6},200:{pageTimes:{1:120},totalPages:4,lastPageIndex:1}},readingAttachmentID:100};
 f.refs.set(100,{id:100,getField:()=>'Main article'});f.refs.set(200,{id:200,getField:()=>'Supplementary'});
 f.runtime.pageProgress=(ref,att)=>ref.id!==1?{pages:{},total:0,visited:0,percent:0}
  :Number(att)===200?{pages:{1:120},total:4,visited:1,percent:25,attachmentID:200,lastPageIndex:1}
  :{pages:{6:300},total:12,visited:1,percent:8,attachmentID:100,lastPageIndex:6};
 f.library.annotations=async()=>[{id:'m',parentID:'1',attachmentID:'100',text:'',comment:'main PDF mark',pageIndex:6,pageLabel:'7'},{id:'s',parentID:'1',attachmentID:'200',text:'',comment:'supplement mark',pageIndex:1,pageLabel:'2'}];
 await f.bench.show('reading');
 const row=()=>f.body().querySelector('.sc-resume-row');
 let fold=row().querySelector('.sc-resume-pages');
 fold.open=true;fold.dispatchEvent(new f.win.Event('toggle'));
 await new Promise(r=>setTimeout(r,20));
 assert.match(row().querySelector('.sc-reading-evidence-row').textContent,/main PDF mark/,'the main file\'s own mark');
 assert.doesNotMatch(row().textContent,/supplement mark/,'not the supplement\'s, before it is even chosen');
 // Switch to the supplement: fileChooser's own change handler redraws the
 // row against attachment 200, a different cache key.
 row().querySelector('.sc-reading-file').value='200';
 row().querySelector('.sc-reading-file').dispatchEvent(new f.win.Event('change'));
 fold=row().querySelector('.sc-resume-pages');fold.open=true;fold.dispatchEvent(new f.win.Event('toggle'));
 await new Promise(r=>setTimeout(r,20));
 assert.match(row().querySelector('.sc-reading-evidence-row').textContent,/supplement mark/,'the supplement\'s own mark, not the main file\'s cached one');
 assert.doesNotMatch(row().textContent,/main PDF mark/,'the stale attachment-100 cache must not leak in under the paper-only key');
 f.bench.destroy();
});

test('a row carries the reader’s own memo; a collection says when it was last read; the week’s facts narrow 최근 문헌',async()=>{
 const f=fixture();
 const now=Date.now(),day=864e5;
 f.runtime.cache.items[1]={remark:'Why kept: the control\nsecond line'};
 const known={1:{status:'done',lastRead:new Date(now-3*day).toISOString()},2:{status:''}};
 f.runtime.state=ref=>({citations:3,impactFactor:4,...known[ref.id]});
 f.library.snapshot=async()=>[{...f.papers[0],dateAdded:new Date(now-40*day).toISOString()},{...f.papers[1],dateAdded:new Date(now-2*day).toISOString()}];
 await f.bench.show('explore');
 assert.equal(f.body().querySelector('[data-item-id="1"] .sc-paper-remark').textContent,'메모Why kept: the control','first line only');
 assert.equal(f.body().querySelector('[data-item-id="2"] .sc-paper-remark'),null);
 f.library.collections=async()=>[{id:'4',name:'Research',count:2,itemIDs:[1,2],parentID:null}];
 await f.bench.show('collections');
 assert.match(f.body().querySelector('.sc-collection-mixtext').textContent,/3일 전 읽음/);
 await f.bench.show('recent');
 const titles=()=>[...f.body().querySelectorAll('.sc-paper-title')].map(n=>n.textContent);
 assert.equal(titles().length,2);
 await f.click('1편 추가');
 assert.deepEqual(titles(),['Paper Beta'],'only what was added this week');
 assert.match(f.body().querySelector('.sc-paper-why').textContent,/^추가/);
 await f.click('1편 추가');
 assert.equal(titles().length,2,'pressed again, all of them');
 f.bench.destroy();
});

test('the expanded paper detail names where it is filed, and each path jumps the left pane there and then to the paper',async()=>{
 const f=fixture();
 f.runtime.collectionEntries=ref=>ref.id===1
  ?[{id:4,path:'Defense system › CRISPR-Cas › Type I Cas'},{id:5,path:'Reviews'}]:[];
 f.win.ZoteroPane.selectItem=f.record('selectItem');
 await f.bench.show('explore');
 f.bench.state.selected=new Set(['1','2']);f.bench.state.scope='selected';await f.bench.render();
 const line=f.body().querySelector('[data-item-id="1"] .sc-paper-collections');
 assert.ok(line,'drawn once the card is expanded');
 const links=[...line.querySelectorAll('button')];
 assert.deepEqual(links.map(b=>b.textContent),['Defense system › CRISPR-Cas › Type I Cas','Reviews'],'the full path, not the column\'s abbreviation');
 links[0].dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.deepEqual(f.calls.find(c=>c[0]==='collection'),['collection',4],'the left pane jumps to the collection first');
 assert.deepEqual(f.calls.find(c=>c[0]==='selectItem'),['selectItem',1],'then the paper is selected there');
 assert.equal(f.body().querySelector('[data-item-id="2"] .sc-paper-collections'),null,'an unfiled paper draws nothing, even expanded the same way');
 f.bench.destroy();
});

test('a paper is closed out on 읽기 진행, opened in place in the list, and the unread papers the read ones cite are named',async()=>{
 const f=fixture();
 const recent=new Date(Date.now()-864e5).toISOString();
 const known={1:{status:'reading',lastRead:recent},2:{status:''},5:{status:''}};
 f.runtime.state=ref=>({citations:3,impactFactor:4,...known[ref.id]});
 f.runtime.cache.items[1]={seconds:300,lastRead:recent};
 f.runtime.pageProgress=ref=>ref.id===1?{pages:{2:300},total:12,visited:1,percent:8,attachmentID:100,lastPageIndex:2}:{pages:{},total:0,visited:0,percent:0};
 const edits=[];f.runtime.canEdit=()=>true;f.runtime.edit=async(items,patch)=>{edits.push([items[0].id,patch]);};
 await f.bench.show('reading');
 // 이어 읽기's own rows, not the general record list below it -- both now
 // share .sc-resume-row since they share a renderer; .sc-reading-record
 // marks the general ones.
 const resume=()=>f.body().querySelector('.sc-resume-row:not(.sc-reading-record)');
 const done=[...resume().querySelectorAll('.sc-reading-status button')].find(b=>b.textContent==='완료');
 done.click();await new Promise(r=>setTimeout(r,10));
 assert.deepEqual(edits,[[1,{status:'done'}]]);
 assert.equal(resume(),null,'closed out: out of 이어 읽기');
 const card=[...f.body().querySelectorAll('.sc-reading-record')].find(c=>/Paper Alpha/.test(c.textContent));
 assert.equal([...card.querySelectorAll('.sc-reading-status button')].find(b=>b.getAttribute('aria-pressed')==='true').textContent,'완료','and in the list, where it can be changed back');
 // 자세히 opens under the row and leaves the list as it was.
 await f.bench.show('explore');
 const before=f.body().querySelectorAll('.sc-paper-card').length;
 f.body().querySelector('[data-detail-for="2"]').click();await new Promise(r=>setTimeout(r,10));
 assert.equal(f.bench.state.scope,'library');
 assert.equal(f.body().querySelectorAll('.sc-paper-card').length,before);
 assert.equal(f.body().querySelector('[data-item-id="2"]').dataset.expanded,'true');
 assert.equal(f.body().querySelector('[data-detail-for="2"]').getAttribute('aria-expanded'),'true');
 f.body().querySelector('[data-detail-for="2"]').click();await new Promise(r=>setTimeout(r,10));
 assert.equal(f.body().querySelector('[data-item-id="2"]').dataset.expanded,undefined);
 // Read papers' reference lists name the unread one they both cite, once each.
 const extra={id:'5',key:'K5',libraryID:1,title:'Cited background',authors:'X',year:'2020',venue:'Cell',itemType:'journalArticle',tags:[]};
 f.refs.set(5,{id:5});
 f.library.snapshot=async()=>[...f.papers,extra];
 known[2].status='done';
 f.runtime.paperWorks=()=>({'1:K1':{openalex:'https://openalex.org/W1',references:['W5','W5']},'1:K2':{openalex:'W2',references:['https://openalex.org/W5']},'1:K5':{openalex:'W5',references:[]}});
 await f.bench.load();await f.bench.show('explore');
 const fold=f.body().querySelector('.sc-local-reading-links');
 assert.match(fold.querySelector('summary').textContent,/인용으로 이어진 안 읽은 문헌 1편/);
 assert.match(fold.textContent,/기준 2편 중 참고문헌 기록 2편/);
 assert.match(fold.querySelector('.sc-local-reading-link').textContent,/Cited background.*2편에서 인용/);
 f.bench.destroy();
});

test('the general reading record row shares 이어 읽기\'s renderer: one meta line, no second progress bar, and a folded page strip',async()=>{
 const f=fixture();
 const days=3,recent=new Date(Date.now()-days*864e5).toISOString();
 f.runtime.state=ref=>({citations:3,impactFactor:4,status:ref.id===1?'done':'unread'});
 f.runtime.cache.items[1]={seconds:125,lastRead:recent};
 f.runtime.formatReadTime=sec=>`${sec}s`;
 f.runtime.pageProgress=ref=>ref.id===1?{pages:{4:60},total:20,visited:5,percent:25,attachmentID:100,lastPageIndex:4}:{pages:{},total:0,visited:0,percent:0};
 await f.bench.show('reading');
 const row=f.body().querySelector('.sc-reading-record');
 assert.ok(row,'a stable class marks the general record row, as tests that looked for .sc-card now need');
 assert.equal(row.querySelector('.sc-collection-bar'),null,'no second, redundant progress bar on this row');
 assert.match(row.querySelector('.sc-resume-meta').textContent,/125s.*5\/20쪽.*3일 전/,'읽은 시간 · 방문 쪽/전체 쪽 · 마지막 읽음, in that order');
 const fold=row.querySelector('.sc-resume-pages');
 assert.ok(fold,'the page strip is a fold, as in 이어 읽기, not always open');
 assert.equal(fold.hasAttribute('open'),false,'closed by default');
 // A45: the strip itself is built only once the fold is opened, not eagerly
 // behind a closed <details>.
 assert.equal(fold.querySelector('.sc-page-strip'),null,'not built while closed');
 fold.open=true;fold.dispatchEvent(new f.win.Event('toggle'));
 assert.ok(fold.querySelector('.sc-page-strip'),'the strip itself is drawn once opened');
 // #3: 주석이 있는 쪽 merged into this same fold -- one press reveals both.
 assert.ok(fold.querySelector('.sc-reading-evidence-list'),'주석이 있는 쪽 kept, inside 쪽별 기록 itself');
 assert.equal(row.querySelector('button[data-opens=window]').textContent,'열기','완료 opens rather than offering to "이어 읽기"');
 f.bench.destroy();
});

test('a general record row for a paper with several files also says "이 파일", not the paper’s whole total',async()=>{
 // drawResumeRow's recordMeta branch used to always say "읽은 시간 X" even
 // when X was really just this one file's time out of several -- the same
 // paper's own read time can be much larger, and read as a paper the reader
 // barely spent time on if the file in front of them happened to be short.
 const f=fixture();
 f.runtime.state=ref=>({citations:3,impactFactor:4,status:ref.id===1?'done':'unread'});
 f.runtime.cache.items[1]={seconds:500,readingAttachments:{
  100:{pageTimes:{6:300},totalPages:12,lastPageIndex:6},
  200:{pageTimes:{1:120},totalPages:4,lastPageIndex:1}
 },readingAttachmentID:100};
 f.runtime.formatReadTime=sec=>`${sec}s`;
 f.refs.set(100,{id:100,getField:()=>'Main article'});f.refs.set(200,{id:200,getField:()=>'Supplementary'});
 f.runtime.pageProgress=(ref,att)=>ref.id!==1?{pages:{},total:0,visited:0,percent:0}
  :Number(att)===200?{pages:{1:120},total:4,visited:1,percent:25,attachmentID:200,lastPageIndex:1}
  :{pages:{6:300},total:12,visited:1,percent:8,attachmentID:100,lastPageIndex:6};
 await f.bench.show('reading');
 const row=f.body().querySelector('.sc-reading-record');
 assert.ok(row,'the paper is 완료, so it is in the general list, not 이어 읽기');
 assert.match(row.querySelector('.sc-resume-meta').textContent,/이 파일 읽은 시간 300s/,
  'this file’s time, said the same way as 이어 읽기 says it, not the paper’s own 500');
 f.bench.destroy();
});

test('a reading row without a last-read date says so, and its actions share the meta line, off the title',async()=>{
 const f=fixture();
 f.runtime.state=ref=>({citations:3,impactFactor:4,status:'unread'});
 f.runtime.canEdit=()=>true;f.runtime.edit=async()=>{};
 // Time recorded but no lastRead at all: an edge the record list does not filter out.
 f.runtime.cache.items[1]={seconds:125};
 f.runtime.formatReadTime=sec=>`${sec}s`;
 f.runtime.pageProgress=ref=>ref.id===1?{pages:{4:60},total:20,visited:5,percent:25,attachmentID:100}:{pages:{},total:0,visited:0,percent:0};
 await f.bench.show('reading');
 const row=f.body().querySelector('.sc-reading-record');
 assert.match(row.querySelector('.sc-resume-meta').textContent,/마지막 읽음 기록 없음/,'no date is said, not left blank');
 // Title and memo are the row's own first line; the meta and the two actions
 // (열기/이어 읽기 and the status control) share a second line, off the title.
 const text=row.querySelector('.sc-resume-text'),actions=row.querySelector('.sc-resume-actions');
 assert.ok(text&&actions,'the title block and the actions block are drawn separately');
 const children=[...row.children];
 assert.ok(children.indexOf(actions)>children.indexOf(text),'actions come after the title block');
 assert.ok(actions.contains(row.querySelector('button[data-opens=window]')),'열기/이어 읽기 is in the actions group');
 assert.ok(actions.querySelector('.sc-reading-status'),'the status control is in the same group');
 f.bench.destroy();
});

test('notes name the finished papers with nothing written, owned results say how far read, collections sort by last read and by unread',async()=>{
 const f=fixture();
 const now=Date.now(),day=864e5;
 const known={1:{status:'done',seconds:600,lastRead:new Date(now-30*day).toISOString()},2:{status:'done',lastRead:new Date(now-2*day).toISOString()}};
 f.runtime.state=ref=>({citations:3,impactFactor:4,...known[ref.id]});
 f.runtime.formatReadTime=sec=>`${sec}초`;
 // Paper 1 has a note; paper 2 has neither note nor memo.
 f.library.notes=async()=>[{id:'9',parentID:'1',title:'On Alpha',text:'x',modified:'2026-09-01'}];
 f.setSelection([]);
 await f.bench.show('notes');f.bench.state.selected=new Set();await f.bench.render();
 const missing=f.body().querySelector('.sc-notes-missing');
 assert.match(missing.querySelector('summary').textContent,/노트도 메모도 없는 문헌 1편/);
 assert.match(missing.textContent,/Paper Beta/);
 assert.doesNotMatch(missing.textContent,/Paper Alpha/);
 // An owned paper in a result list: its reading state beside 보유 (paper 1 carries the result's DOI here).
 f.library.snapshot=async()=>[{...f.papers[0],doi:'https://doi.org/10.1/W5'},f.papers[1]];
 f.setSelection([1]);f.bench.state.selected=new Set(['1']);
 await f.bench.load();
 await f.bench.show('related');
 await f.click('추가');
 assert.equal(f.body().querySelector('.sc-hit .sc-hit-owned').textContent,'보유 · 완료 · 600초');
 f.library.collections=async()=>[{id:'4',name:'A-old',count:1,itemIDs:[1],parentID:null},{id:'5',name:'B-live',count:1,itemIDs:[2],parentID:null}];
 await f.bench.show('collections');
 const sort=f.body().querySelector('[aria-label="컬렉션 정렬"]');sort.value='lastRead';sort.dispatchEvent(new f.win.Event('change'));
 assert.deepEqual([...f.body().querySelectorAll('.sc-collection-name')].map(n=>n.textContent),['B-live','A-old']);
 f.bench.destroy();
});

test("a note's meta line also says its paper's reading state",async()=>{
 const f=fixture();
 f.runtime.state=ref=>({citations:3,impactFactor:4,status:ref.id===1?'reading':'unread'});
 f.library.notes=async()=>[{id:'9',parentID:'1',title:'On Alpha',text:'x',modified:'2026-09-01'}];
 f.setSelection([]);
 await f.bench.show('notes');f.bench.state.selected=new Set();await f.bench.render();
 const meta=f.body().querySelector('.sc-card-text > .sc-muted');
 assert.match(meta.textContent,/읽는 중/,'the parent paper is being read');
 f.bench.destroy();
});

test('notes are capped at 40 with a 더 보기 for the rest, and a new query starts back at 40',async()=>{
 const f=fixture();
 const notes=Array.from({length:45},(_,i)=>({id:String(i),title:'Note '+i,text:'text '+i,modified:'2026-09-'+String(20-Math.floor(i/3)).padStart(2,'0'),parentID:'1'}));
 f.library.notes=async()=>notes;
 f.setSelection([]);
 await f.bench.show('notes');f.bench.state.selected=new Set();await f.bench.render();
 assert.equal(f.body().querySelectorAll('.sc-card').length,40,'capped at 40');
 assert.match(f.body().textContent,/40\/45개 표시/);
 const more=f.findButton('더 보기');assert.ok(more,'.sc-notes-more offers the rest');
 assert.equal(more.className,'sc-notes-more');
 more.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.equal(f.body().querySelectorAll('.sc-card').length,45,'40 more: all 45 fit now');
 assert.equal(f.findButton('더 보기'),undefined,'nothing left to add');
 // A new search context starts back at 40, not wherever 더 보기 left it.
 f.input('작업 패널 검색','Note');await f.bench.render();
 assert.equal(f.body().querySelectorAll('.sc-card').length,40,'the limit reset for the new query');
 f.bench.destroy();
});

test('any unread paper can wait under 읽기 대기, the search reads the reader’s memo, and annotations can be read paper by colour',async()=>{
 const f=fixture();
 f.runtime.cache.items[2]={remark:'first line\nthe control was sham-operated'};
 const known={1:{status:'reading'},2:{status:''}};
 f.runtime.state=ref=>({citations:3,impactFactor:4,...known[ref.id]});
 f.setSelection([]);
 await f.bench.show('explore');f.bench.state.selected=new Set(['1','2']);await f.bench.render();
 await f.click('안 읽은 문헌 1편 읽기 대기에 추가');
 assert.deepEqual(Object.keys(f.runtime.cache.workbenchUI.readingQueue).map(k=>k.split(':').pop()),['K2'],'only the unread one, by its item key');
 // Again from its row: already waiting, so the button takes it out, and nothing is duplicated.
 f.body().querySelector('[data-detail-for="2"]').click();await new Promise(r=>setTimeout(r,10));
 assert.ok(f.findButton('읽기 대기에서 빼기'));
 // The memo is searched, and the row shows the part that matched.
 const search=f.bench.panel.querySelector('[aria-label="작업 패널 검색"]');search.value='sham';search.dispatchEvent(new f.win.Event('search'));
 await new Promise(r=>setTimeout(r,20));
 const cards=[...f.body().querySelectorAll('.sc-paper-card')];
 assert.equal(cards.length,1);
 assert.match(cards[0].querySelector('.sc-paper-remark').textContent,/^메모 일치.*sham-operated/);
 search.value='';search.dispatchEvent(new f.win.Event('search'));await new Promise(r=>setTimeout(r,20));
 // Paper x colour.
 f.runtime.cache.readerSettings={...(f.runtime.cache.readerSettings||{}),colorLabels:{'#5fb236':'방법'}};
 f.library.annotations=async()=>[{id:'a',parentID:'1',attachmentID:'99',text:'m1',color:'#5FB236',pageIndex:0},{id:'b',parentID:'1',attachmentID:'100',text:'m2',color:'#5fb236',pageIndex:1},{id:'c',parentID:'1',attachmentID:'99',text:'k',color:'#ffd400',pageIndex:2},{id:'d',parentID:'2',attachmentID:'98',text:'m3',color:'#5fb236',pageIndex:0}];
 await f.bench.show('annotations');
 const table=f.body().querySelector('.sc-annot-summary-table');
 assert.ok(table,'two papers: the table is offered');
 const rowOf=title=>[...table.querySelectorAll('tbody tr')].find(tr=>tr.textContent.includes(title));
 assert.deepEqual([...rowOf('Paper Alpha').querySelectorAll('td')].slice(1).map(td=>td.textContent),['2','1'],'both PDFs of one paper, and #5FB236 with #5fb236');
 [...rowOf('Paper Alpha').querySelectorAll('.sc-annot-summary-cell')].find(b=>b.textContent==='2').click();
 await new Promise(r=>setTimeout(r,20));
 assert.deepEqual([...f.body().querySelectorAll('.sc-annot .sc-annot-text')].map(n=>n.textContent).sort(),['m1','m2']);
 f.bench.destroy();
});

test('tags say how much is read, 이어 읽기 says the pages left, and 읽기 진행 counts papers opened today',async()=>{
 const f=fixture();
 const now=Date.now(),day=864e5;
 const known={1:{status:'done',lastRead:new Date(now-5*day).toISOString()},2:{status:'reading',lastRead:new Date(now-60000).toISOString()}};
 f.runtime.state=ref=>({citations:3,impactFactor:4,...known[ref.id]});
 f.library.tagTree=()=>[{name:'topic',path:'topic',count:2,children:[]}];
 f.library.snapshot=async()=>f.papers.map(p=>({...p,tags:['topic/x']}));
 await f.bench.show('tags');
 assert.match(f.body().querySelector('.sc-tag-reading').textContent,/완료 1\/2 · 오늘 읽음/);
 f.runtime.cache.items[2]={seconds:120,lastRead:new Date(now-60000).toISOString()};
 f.runtime.cache.items[1]={seconds:60,lastRead:new Date(now-5*day).toISOString()};
 f.runtime.pageProgress=ref=>ref.id===2?{pages:{3:120},total:10,visited:1,percent:10,attachmentID:7,lastPageIndex:3}:{pages:{0:60},total:4,visited:1,percent:25,attachmentID:8,lastPageIndex:0};
 await f.bench.show('reading');
 assert.match(f.body().querySelector('.sc-reading-today').textContent,/1편 오늘 읽음.*2편 지난 7일/s);
 assert.match(f.body().querySelector('.sc-resume-meta').textContent,/이 쪽 뒤 6쪽/);
 f.bench.destroy();
});

test('오늘 읽음/지난 7일 counts narrow the record list, and pressing the same one again returns to all',async()=>{
 const f=fixture();
 const now=Date.now(),day=864e5;
 const extra={...f.papers[0],id:'10',key:'K10',libraryID:1,title:'Old Paper'};
 f.refs.set(10,{id:10});
 f.library.snapshot=async()=>[...f.papers,extra];
 const lastRead={1:new Date(now-1000).toISOString(),2:new Date(now-3*day).toISOString(),10:new Date(now-20*day).toISOString()};
 f.runtime.state=ref=>({citations:3,impactFactor:4,status:'done',lastRead:lastRead[ref.id]});
 for(const id of [1,2,10])f.runtime.cache.items[id]={seconds:60,lastRead:lastRead[id]};
 f.runtime.pageProgress=()=>({pages:{},total:0,visited:0,percent:0});
 await f.bench.show('reading');
 assert.match(f.body().querySelector('.sc-reading-today').textContent,/1편 오늘 읽음.*2편 지난 7일/s);
 const facts=()=>[...f.body().querySelectorAll('.sc-reading-today .sc-overview-fact')];
 const rowTitles=()=>[...f.body().querySelectorAll('.sc-reading-record .sc-resume-title')].map(t=>t.textContent);
 assert.equal(rowTitles().length,3,'all three, unfiltered');
 facts()[0].dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.deepEqual(rowTitles(),['Paper Alpha'],'오늘 읽음 narrows to just today');
 assert.equal(f.bench.state.readingView,'today');
 facts()[0].dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.equal(rowTitles().length,3,'pressed again: back to all');
 assert.equal(f.bench.state.readingView,'');
 facts()[1].dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.deepEqual(rowTitles().sort(),['Paper Alpha','Paper Beta'],'지난 7일 narrows to the last week');
 f.bench.destroy();
});

test('지난 7일 builds its set first, so 이어 읽기 drops a paper outside the period and the button count matches what is shown',async()=>{
 const f=fixture();
 const now=Date.now(),day=864e5;
 const extra={...f.papers[0],id:'10',key:'K10',libraryID:1,title:'Ten Days Ago'};
 f.refs.set(10,{id:10});
 f.library.snapshot=async()=>[f.papers[0],f.papers[1],extra];
 // All three are still 읽는 중 and unfinished, so all three would sit in
 // 이어 읽기 (top 3, 14-day window) with no period chosen at all.
 const lastRead={1:new Date(now-1000).toISOString(),2:new Date(now-3*day).toISOString(),10:new Date(now-10*day).toISOString()};
 f.runtime.state=ref=>({citations:3,impactFactor:4,status:'reading',lastRead:lastRead[ref.id]});
 for(const id of [1,2,10])f.runtime.cache.items[id]={seconds:60,lastRead:lastRead[id]};
 f.runtime.pageProgress=()=>({pages:{},total:0,visited:0,percent:0});
 await f.bench.show('reading');
 const resumeTitles=()=>[...f.body().querySelectorAll('.sc-resume:not(.sc-reading-records) .sc-resume-title')].map(t=>t.textContent);
 const recordTitles=()=>[...f.body().querySelectorAll('.sc-reading-record .sc-resume-title')].map(t=>t.textContent);
 assert.deepEqual(resumeTitles().sort(),['Paper Alpha','Paper Beta','Ten Days Ago'],'unfiltered: all three, including the ten-day-old one');
 f.findButton('2편 지난 7일').dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.equal(f.bench.state.readingView,'week');
 assert.equal([...resumeTitles(),...recordTitles()].includes('Ten Days Ago'),false,'outside the 7-day period, it shows nowhere');
 assert.equal(resumeTitles().length+recordTitles().length,2,'shown count equals the button\'s own count');
 f.bench.destroy();
});

test('unread papers that cite the read ones are named too, and two papers’ annotations can be read side by side by meaning',async()=>{
 const f=fixture();
 const known={1:{status:'done'},2:{status:''}};
 f.runtime.state=ref=>({citations:null,impactFactor:4,...known[ref.id]});
 // Paper 2 is unread and new: no citations, but it cites paper 1, twice in its list.
 f.runtime.paperWorks=()=>({'1:K1':{openalex:'W1',references:[]},'1:K2':{openalex:'W2',references:['https://openalex.org/W1','W1']}});
 await f.bench.show('explore');
 const fold=f.body().querySelector('.sc-local-reading-links');
 assert.match(fold.textContent,/읽는 중·완료 문헌을 인용한 안 읽은 문헌/);
 const line=[...fold.querySelectorAll('.sc-local-reading-link')].find(l=>/Paper Beta/.test(l.textContent));
 assert.match(line.textContent,/읽는 중·완료 문헌 1편 인용/,'counted once');
 line.querySelector('.sc-local-reading-queue').click();await new Promise(r=>setTimeout(r,10));
 assert.equal(Object.keys(f.runtime.cache.workbenchUI.readingQueue||{}).length,1,'queued from here');
 // A paper being read is not queued from its row.
 known[1].status='reading';known[2].status='reading';await f.bench.load();await f.bench.show('explore');
 f.body().querySelector('[data-detail-for="2"]').click();await new Promise(r=>setTimeout(r,10));
 assert.equal(f.findButton('읽기 대기'),undefined);
 // Side by side.
 f.runtime.cache.readerSettings={...(f.runtime.cache.readerSettings||{}),colorLabels:{'#5fb236':'방법','#ffd400':'결과'}};
 f.library.annotations=async()=>[{id:'a',parentID:'1',attachmentID:'99',text:'alpha method',color:'#5FB236',pageIndex:0},{id:'b',parentID:'1',attachmentID:'100',text:'alpha supp method',color:'#5fb236',pageIndex:3},{id:'d',parentID:'2',attachmentID:'98',text:'beta result',color:'#ffd400',pageIndex:1}];
 f.refs.set(99,{id:99,parentID:1,getField:()=>'Main'});f.refs.set(100,{id:100,parentID:1,getField:()=>'Supplement'});
 await f.bench.show('annotations');
 for(const box of f.body().querySelectorAll('.sc-annot-compare-pick')){box.checked=true;box.dispatchEvent(new f.win.Event('change'));await new Promise(r=>setTimeout(r,5));}
 await f.click('주석 나란히');
 const grid=f.body().querySelector('.sc-annot-compare');
 assert.ok(grid);
 const cells=[...grid.querySelectorAll('.sc-annot-compare-cell')].map(c=>c.textContent);
 assert.equal(cells.length,4,'two meanings × two papers');
 assert.ok(cells.some(t=>/alpha method/.test(t)&&/alpha supp method/.test(t)&&/Supplement/.test(t)),'both files in one paper column, told apart');
 assert.ok(cells.some(t=>/이 조건의 주석 없음/.test(t)));
 await f.click('목록으로');
 assert.equal(f.body().querySelector('.sc-annot-compare'),null);
 f.bench.destroy();
});

test('an author page opens with what of theirs is on the shelf, and the comparison table shows reading state by default',async()=>{
 const f=fixture();
 const known={1:{status:'done',citations:40,impactFactor:4},2:{status:'',citations:9,impactFactor:4}};
 f.runtime.state=ref=>({...known[ref.id]});
 f.runtime.authorsOfCached=async()=>[{id:'A1',name:'Ada Lovelace',institution:'X',position:'first'}];
 const updates=f.runtime.authorUpdates;f.runtime.authorUpdates=async id=>{const r=await updates(id);return {...r,profile:{...r.profile,name:'Ada Lovelace'}};};
 await f.bench.show('authors');
 const shelf=[...f.body().querySelectorAll('.sc-author-shelf-row')].map(r=>r.textContent);
 assert.equal(shelf.length,2,'both papers by Ada Lovelace');
 assert.match(shelf.join('|'),/완료/);
 // With no saved column choice the reading state is on by default, not buried behind a checkbox.
 f.runtime.cache.matrixFields=undefined;
 f.setSelection([]);f.bench.state.selected=new Set();
 await f.bench.show('matrix');
 const statusCol=[...f.body().querySelectorAll('td[data-field="status"]')].map(td=>td.textContent);
 assert.deepEqual(statusCol,['완료','안 읽음'],'reading state shown by default');
 f.bench.destroy();
});

test('stalled papers are one view away, journal citations split by reading state, and tags are searched and jumped from',async()=>{
 const f=fixture();
 const now=Date.now(),day=864e5;
 const known={1:{status:'reading',citations:128},2:{status:'',citations:41}};
 f.runtime.state=ref=>({impactFactor:4,...known[ref.id]});
 f.runtime.cache.items[1]={seconds:300,lastRead:new Date(now-20*day).toISOString()};
 f.runtime.cache.items[2]={seconds:30,lastRead:new Date(now-13*day).toISOString()};
 f.runtime.pageProgress=ref=>ref.id===1?{pages:{2:300},total:10,visited:1,percent:10,attachmentID:7,lastPageIndex:2}:{pages:{0:30},total:4,visited:1,percent:25,attachmentID:8,lastPageIndex:0};
 await f.bench.show('reading');
 await f.click('14일 넘게 멈춤 1');
 const rows=[...f.body().querySelectorAll('.sc-reading-stalled .sc-resume-row')];
 assert.equal(rows.length,1);
 assert.match(rows[0].textContent,/Paper Alpha.*3쪽에서/s);
 assert.equal(f.body().querySelectorAll('[data-reading-progress] .sc-reading-record').length,0,'the list gives way to the view');
 await f.click('전체 기록 1');
 // Journals: the two groups each with the count they rest on.
 f.library.snapshot=async()=>f.papers.map(p=>({...p,venue:'Nature'}));
 await f.bench.load();await f.bench.show('journals');
 const lines=[...f.body().querySelectorAll('.sc-journal-citation-line')].map(l=>[l.dataset.group,l.querySelector('.sc-journal-citation-value').textContent]);
 assert.deepEqual(lines,[['read','128 · 1/1편'],['unread','41 · 1/1편']]);
 // Tags: searched, and the unread under one a press away.
 f.library.tagTree=()=>[{name:'methods',path:'methods',count:2,children:[{name:'spatial',path:'methods/spatial',count:1,children:[]},{name:'single',path:'methods/single',count:1,children:[]}]}];
 f.library.snapshot=async()=>[{...f.papers[0],tags:['methods/single']},{...f.papers[1],tags:['methods/spatial']}];
 await f.bench.load();await f.bench.show('tags');
 const find=f.body().querySelector('[aria-label="태그 경로 검색"]');find.value='spatial';find.dispatchEvent(new f.win.Event('input'));
 await new Promise(r=>setTimeout(r,200));
 const names=[...f.body().querySelectorAll('.sc-tag-name')].map(n=>n.textContent);
 assert.deepEqual(names,['methods 2','spatial 1'],'the match and its ancestor');
 assert.equal(f.body().querySelector('.sc-tag-edit').hasAttribute('open'),false,'editing folded');
 // spatial is a leaf (no children): its own row is a plain div, not a <details>.
 const jump=[...f.body().querySelectorAll('.sc-tag-unread')].find(b=>b.closest('summary, .sc-tag-row').querySelector('.sc-tag-name').textContent==='spatial 1');
 jump.click();await new Promise(r=>setTimeout(r,20));
 assert.equal(f.bench.state.tab,'explore');assert.deepEqual(f.bench.filters.rules().map(r=>[r.kind,r.values[0]]),[['tag','methods/spatial'],['status','unread']],'a tag and its unread papers arrive as two rules');
 f.bench.destroy();
});

test('A47 14일 넘게 멈춤: a paper read this week that cites a stalled one surfaces it first and reconnects on a press',async()=>{
 const f=fixture();
 const now=Date.now(),day=864e5;
 const known={1:{status:'reading',citations:5},2:{status:'done',citations:9}};
 f.runtime.state=ref=>({impactFactor:4,...known[ref.id]});
 f.runtime.cache.items[1]={seconds:300,lastRead:new Date(now-20*day).toISOString()};
 f.runtime.cache.items[2]={seconds:600,lastRead:new Date(now-2*day).toISOString()};
 f.runtime.pageProgress=ref=>ref.id===1?{pages:{2:300},total:10,visited:1,percent:10,attachmentID:7,lastPageIndex:2}:{pages:{0:600},total:20,visited:1,percent:5,attachmentID:8,lastPageIndex:0};
 // Beta (read this week) cites Alpha (stalled) -- direction fixed: recent cites stalled.
 f.runtime.paperWorks=()=>({'1:K1':{openalex:'W1',references:[]},'1:K2':{openalex:'W2',references:['W1']}});
 await f.bench.show('reading');
 await f.click('14일 넘게 멈춤 1');
 const row=f.body().querySelector('.sc-reading-stalled .sc-resume-row');
 const toggle=row.querySelector('.sc-reading-reconnect summary');
 assert.match(toggle.textContent,/최근 읽은 1편이 인용/);
 assert.equal(row.querySelector('.sc-reading-reconnect-note'),null,'a real link, not the "no link" note');
 toggle.parentElement.open=true;toggle.parentElement.dispatchEvent(new f.win.Event('toggle'));
 const line=row.querySelector('.sc-reading-reconnect-row');
 assert.match(line.textContent,/최근 읽은 Paper Beta → 이 문헌/);
 assert.match(line.textContent,/2일 전/);
 assert.ok(row.querySelector('.sc-reading-reconnect button[data-opens=window]'),'the row\'s own resume action is repeated in the fold');
 f.bench.destroy();
});

test('A47 14일 넘게 멈춤: with nothing recent to check, a stalled paper says so distinctly from a checked-and-unlinked one',async()=>{
 const f=fixture();
 const now=Date.now(),day=864e5;
 const known={1:{status:'reading',citations:5},2:{status:'reading',citations:5}};
 f.runtime.state=ref=>({impactFactor:4,...known[ref.id]});
 f.runtime.cache.items[1]={seconds:300,lastRead:new Date(now-20*day).toISOString()};
 f.runtime.cache.items[2]={seconds:300,lastRead:new Date(now-25*day).toISOString()};
 f.runtime.pageProgress=ref=>ref.id===1?{pages:{2:300},total:10,visited:1,percent:10,attachmentID:7,lastPageIndex:2}:{pages:{0:30},total:10,visited:1,percent:10,attachmentID:8,lastPageIndex:0};
 // No paper read in the last 7 days at all: nothing to check against.
 f.runtime.paperWorks=()=>({'1:K1':{openalex:'W1',references:[]},'1:K2':{openalex:'W2',references:[]}});
 await f.bench.show('reading');
 await f.click('14일 넘게 멈춤 2');
 const notes=[...f.body().querySelectorAll('.sc-reading-stalled .sc-reading-reconnect-note')].map(n=>n.textContent);
 assert.deepEqual(notes,['참고문헌 기록 없음','참고문헌 기록 없음'],'nothing recent was even fetched, not "checked, no link"');
 f.bench.destroy();
});

test('A47 14일 넘게 멈춤: a fetched-but-unrelated recent paper reads as 연결 없음, not 참고문헌 기록 없음',async()=>{
 const f=fixture();
 f.papers.push({id:'3',key:'K3',libraryID:1,title:'Paper Gamma',authors:'X',year:'2023',venue:'PLOS',itemType:'journalArticle',tags:[]});
 f.refs.set(3,{id:3});
 const now=Date.now(),day=864e5;
 const known={1:{status:'reading',citations:5},3:{status:'done',citations:9}};
 f.runtime.state=ref=>({impactFactor:4,...known[ref.id]});
 f.runtime.cache.items[1]={seconds:300,lastRead:new Date(now-20*day).toISOString()};
 f.runtime.cache.items[3]={seconds:600,lastRead:new Date(now-2*day).toISOString()};
 f.runtime.pageProgress=ref=>ref.id===1?{pages:{2:300},total:10,visited:1,percent:10,attachmentID:7,lastPageIndex:2}:ref.id===3?{pages:{0:600},total:20,visited:1,percent:5,attachmentID:9,lastPageIndex:0}:{pages:{},total:0,visited:0,percent:0};
 // Gamma (read this week) has a fetched reference list, but it does not cite Alpha.
 f.runtime.paperWorks=()=>({'1:K1':{openalex:'W1',references:[]},'1:K3':{openalex:'W3',references:['W9']}});
 await f.bench.show('reading');
 await f.click('14일 넘게 멈춤 1');
 const note=f.body().querySelector('.sc-reading-stalled .sc-reading-reconnect-note');
 assert.equal(note.textContent,'연결 없음','checked -- some recent list was fetched -- and nothing links here');
 f.bench.destroy();
});

test('A48 이어 읽기 메모: a row with a memo shows it as a button that swaps to a textarea, and a save returns to the one-line view',async()=>{
 const f=fixture();
 f.runtime.cache.items[1]={seconds:125,lastRead:new Date().toISOString(),remark:'Check the control condition'};
 f.runtime.pageProgress=ref=>ref.id===1?{pages:{4:60},total:20,visited:5,percent:25,attachmentID:100,lastPageIndex:4}:{pages:{},total:0,visited:0,percent:0};
 await f.bench.show('reading');
 const box=()=>f.body().querySelector('.sc-resume-remark-box');
 const view=box().querySelector('.sc-resume-remark');
 assert.equal(view.textContent,'Check the control condition');
 assert.equal(box().querySelector('.sc-resume-memo-editor'),null,'not editing yet');
 view.click();
 const field=box().querySelector('.sc-resume-memo-editor textarea');
 assert.equal(field.value,'Check the control condition');
 assert.equal(f.doc.activeElement,field,'the editor takes focus on opening');
 field.value='Check the control condition, and the dosage';
 field.dispatchEvent(new f.win.Event('input',{bubbles:true}));
 field.dispatchEvent(new f.win.Event('blur'));
 await settle();
 assert.deepEqual(f.calls.find(c=>c[0]==='remark'),['remark','1','Check the control condition, and the dosage',{base:'Check the control condition'}]);
 assert.equal(box().querySelector('.sc-resume-memo-editor'),null,'back to the one-line view after a successful save');
 assert.equal(box().querySelector('.sc-resume-remark').textContent,'Check the control condition, and the dosage');
 assert.equal(f.runtime.cache.items[1].remark,'Check the control condition, and the dosage','state.items\' own remark follows, as drawPaperMemo does');
 f.bench.destroy();
});

test('A48 이어 읽기 메모: a row without one offers 메모 쓰기; a failed save keeps the editor and the draft',async()=>{
 const f=fixture();
 f.runtime.cache.items[1]={seconds:125,lastRead:new Date().toISOString()};
 f.runtime.pageProgress=ref=>ref.id===1?{pages:{4:60},total:20,visited:5,percent:25,attachmentID:100,lastPageIndex:4}:{pages:{},total:0,visited:0,percent:0};
 f.library.setRemark=async()=>{throw new Error('network down');};
 await f.bench.show('reading');
 const box=()=>f.body().querySelector('.sc-resume-remark-box');
 const add=box().querySelector('.sc-resume-remark-add');
 assert.equal(add.textContent,'메모 쓰기');
 add.click();
 const field=box().querySelector('.sc-resume-memo-editor textarea');
 field.value='Worth a follow-up';
 field.dispatchEvent(new f.win.Event('input',{bubbles:true}));
 field.dispatchEvent(new f.win.Event('blur'));
 await settle();
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/저장하지 못했습니다/);
 assert.equal(box().querySelector('.sc-resume-memo-editor textarea').value,'Worth a follow-up','the draft is not lost on failure');
 f.bench.destroy();
});

test('A48 이어 읽기 메모: a reading-record refresh while the editor is focused does not recreate it',async()=>{
 const f=fixture();
 f.runtime.cache.items[1]={seconds:125,lastRead:new Date().toISOString(),remark:'Draft in progress'};
 f.runtime.pageProgress=ref=>ref.id===1?{pages:{4:60},total:20,visited:5,percent:25,attachmentID:100,lastPageIndex:4}:{pages:{},total:0,visited:0,percent:0};
 await f.bench.show('reading');
 f.body().querySelector('.sc-resume-remark').click();
 const field=f.body().querySelector('.sc-resume-memo-editor textarea');
 field.value='Draft in progress, still typing';
 field.dispatchEvent(new f.win.Event('input',{bubbles:true}));
 f.bench.refreshReading();
 assert.equal(f.body().querySelector('.sc-resume-memo-editor textarea'),field,'the same node -- refreshReading skipped the rebuild while it had focus');
 assert.equal(field.value,'Draft in progress, still typing','the unsaved draft is untouched');
 f.bench.destroy();
});

test('a collection’s unread papers are one press away, and papers added this week but never opened say so',async()=>{
 const f=fixture();
 const now=Date.now(),day=864e5;
 const known={1:{status:'done',lastRead:new Date(now-3*day).toISOString()},2:{status:''}};
 f.runtime.state=ref=>({citations:3,impactFactor:4,...known[ref.id]});
 f.library.snapshot=async()=>[{...f.papers[0],dateAdded:new Date(now-30*day).toISOString()},{...f.papers[1],dateAdded:new Date(now-2*day).toISOString()}];
 f.library.collections=async()=>[{id:'4',name:'Research',count:2,itemIDs:[1,2],parentID:null}];
 await f.bench.show('recent');
 const beta=[...f.body().querySelectorAll('.sc-paper-card')].find(c=>/Paper Beta/.test(c.textContent));
 assert.match(beta.querySelector('.sc-paper-why').textContent,/추가 · 2일 전 · 읽기 기록 없음/);
 await f.bench.show('collections');
 assert.ok(f.findButton('안 읽음 1'));
 f.bench.destroy();
});

test('the queue keeps why a paper was put by, the selection bar leads to the next task, and a note search shows the passage',async()=>{
 const f=fixture();
 const known={1:{status:'done'},2:{status:''}};
 f.runtime.state=ref=>({citations:3,impactFactor:4,...known[ref.id]});
 f.runtime.paperWorks=()=>({'1:K1':{openalex:'W1',references:['W2']},'1:K2':{openalex:'W2',references:[]}});
 f.setSelection([]);
 await f.bench.show('explore');f.bench.state.selected=new Set();await f.bench.render();
 assert.equal(f.bench.panel.querySelector('.sc-selection-bar').hidden,true,'nothing chosen: no bar');
 const line=[...f.body().querySelectorAll('.sc-local-reading-link')].find(l=>/Paper Beta/.test(l.textContent));
 line.querySelector('.sc-local-reading-queue').click();await new Promise(r=>setTimeout(r,10));
 await f.bench.show('reading');
 const why=f.body().querySelector('.sc-queue-reason summary');
 assert.equal(why.textContent,'담은 이유: 읽던 1편이 인용');
 assert.match(f.body().querySelector('.sc-queue-reason').textContent,/Paper Alpha · 지금 완료/);
 // Two chosen: compare and side by side are offered; one chosen: notes and annotations.
 await f.bench.show('explore');f.bench.state.selected=new Set(['1','2']);await f.bench.render();
 const visible=label=>{const b=[...f.bench.panel.querySelectorAll('.sc-selection-bar button')].find(x=>x.textContent===label);return !!b&&!b.hidden;};
 assert.ok(visible('논문 비교')&&visible('주석 나란히')&&!visible('노트'));
 f.bench.state.query='Alpha';f.bench.state.selected=new Set(['2']);await f.bench.render();
 assert.ok(visible('주석')&&visible('노트')&&!visible('논문 비교'));
 [...f.bench.panel.querySelectorAll('.sc-selection-bar button')].find(x=>x.textContent==='노트').click();await new Promise(r=>setTimeout(r,20));
 assert.equal(f.bench.state.tab,'notes');assert.equal(f.bench.state.scope,'selected');assert.equal(f.bench.state.query,'','a search that would hide it is set aside');
 // Leaving 보유 문헌 through the selection bar remembered where it was, so the
 // spot that used to only say 전체 목록으로 now offers the fuller 이전 목록으로.
 await f.click('이전 목록으로');
 assert.equal(f.bench.state.tab,'explore');
 assert.equal(f.bench.state.query,'Alpha','and given back');
 // A note search shows the passage around the match, far into the note.
 f.library.notes=async()=>[{id:'9',parentID:'1',title:'Long note',text:'x '.repeat(900)+'the control culture temperature was 30 C '+'y '.repeat(50),modified:'2026-09-01'}];
 f.bench.state.selected=new Set();f.bench.state.query='temperature';
 await f.bench.show('notes');
 const excerpt=f.body().querySelector('.sc-note-excerpt');
 assert.ok(excerpt);assert.match(excerpt.textContent,/control culture temperature was 30/);
 assert.equal(excerpt.querySelector('.sc-search-hit').textContent,'temperature');
 f.bench.destroy();
});

test('a kept search comes back through 다른 문헌 고르기 and through leaving an empty selection any other way',async()=>{
 const f=fixture();
 f.setSelection([]);
 // Land on the notes tab through the selection bar, as above: the search is set aside.
 await f.bench.show('explore');f.bench.state.query='Alpha';f.bench.state.selected=new Set(['2']);await f.bench.render();
 [...f.bench.panel.querySelectorAll('.sc-selection-bar button')].find(x=>x.textContent==='노트').click();await new Promise(r=>setTimeout(r,20));
 assert.equal(f.bench.state.scope,'selected');assert.equal(f.bench.state.query,'');
 // The note editor for the one chosen paper offers a way to choose another; that also gives the search back.
 await f.click('다른 문헌 고르기');
 assert.equal(f.bench.state.selected.size,0);
 assert.equal(f.bench.state.scope,'library','render’s own fallback also leaves scope, not only the search, in the state it started from');
 assert.equal(f.bench.state.query,'Alpha','다른 문헌 고르기 restores the kept search too');
 // The same search, set aside the same way, comes back even when a selection
 // empties by some other route than a dedicated “back” button -- here, the
 // page’s own “deselect” control, which calls render() without touching keptFilters itself.
 await f.bench.show('explore');f.bench.state.query='Beta';f.bench.state.selected=new Set(['1']);await f.bench.render();
 [...f.bench.panel.querySelectorAll('.sc-selection-bar button')].find(x=>x.textContent==='노트').click();await new Promise(r=>setTimeout(r,20));
 assert.equal(f.bench.state.scope,'selected');assert.equal(f.bench.state.query,'');
 await f.bench.show('explore');
 await f.click('현재 페이지 선택 해제');
 assert.equal(f.bench.state.selected.size,0);
 assert.equal(f.bench.state.scope,'library');
 assert.equal(f.bench.state.query,'Beta','render’s fallback restores it even without a dedicated back button');
 f.bench.destroy();
});

test('the library opens on today’s next steps, and a journal in 내 문헌 분석 opens its papers',async()=>{
 const f=fixture();
 const recent=new Date(Date.now()-864e5).toISOString();
 const known={1:{status:'reading'},2:{status:''}};
 f.runtime.state=ref=>({citations:3,impactFactor:4,...known[ref.id]});
 f.runtime.cache.items[1]={seconds:60,lastRead:recent};
 f.runtime.pageProgress=ref=>ref.id===1?{pages:{4:60},total:9,visited:1,percent:11,attachmentID:7,lastPageIndex:4}:{pages:{},total:0,visited:0,percent:0};
 f.runtime.paperWorks=()=>({'1:K1':{openalex:'W1',references:['W2']},'1:K2':{openalex:'W2',references:[]}});
 f.setSelection([]);
 await f.bench.show('explore');f.bench.state.selected=new Set();await f.bench.render();
 const strip=f.body().querySelector('.sc-today');
 assert.ok(strip);
 const items=[...strip.querySelectorAll('.sc-today-item')].map(b=>b.textContent);
 assert.match(items[0],/이어 읽기 · Paper Alpha · 5쪽/);
 assert.equal(items.length,2,'이어 읽기 and 오늘은 닫기 only: cited-unread lives in the fold, the queue in 읽기 대기');
 assert.equal(items.join('|').includes('인용한 안 읽은 문헌'),false);
 assert.equal(f.body().querySelectorAll('.sc-local-reading-links summary').length,1);
 strip.querySelector('.sc-today-item').click();await new Promise(r=>setTimeout(r,10));
 assert.deepEqual(f.calls.filter(c=>c[0]==='open').pop().slice(1),[7,{pageIndex:4}]);
 await f.bench.show('journals');
 const natureRow=[...f.body().querySelectorAll('.sc-journal-reading-row')].find(r=>r.querySelector('.sc-journal-reading-name')?.textContent==='Nature');
 natureRow.querySelector('[role=cell]:nth-child(2) button').click();await new Promise(r=>setTimeout(r,20));
 // Exactly this journal's papers by id, not a text search on its name -- a search
 // for "Nature" would also have matched "Nature Methods".
 assert.equal(f.bench.state.tab,'explore');assert.equal(f.bench.state.query,'');
 assert.equal(f.bench.state.scope,'selected');assert.deepEqual([...f.bench.state.selected],['2']);
 assert.deepEqual([...f.body().querySelectorAll('.sc-paper-title')].map(n=>n.textContent),['Paper Beta']);
 f.bench.destroy();
});

test('오늘의 읽기 closes for today only and returns once the local date changes',async()=>{
 const f=fixture();
 const recent=new Date(Date.now()-864e5).toISOString();
 f.runtime.state=ref=>({citations:3,impactFactor:4,status:ref.id===1?'reading':''});
 f.runtime.cache.items[1]={seconds:60,lastRead:recent};
 f.runtime.pageProgress=()=>({pages:{},total:0,visited:0,percent:0});
 f.setSelection([]);
 await f.bench.show('explore');f.bench.state.selected=new Set();await f.bench.render();
 let strip=f.body().querySelector('.sc-today');assert.ok(strip,'shown with nothing chosen or narrowed');
 const close=strip.querySelector('.sc-today-close');assert.ok(close,'오늘은 닫기');assert.equal(close.textContent,'오늘은 닫기');
 close.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 const today=new Date(),key=today.getFullYear()+'-'+String(today.getMonth()+1).padStart(2,'0')+'-'+String(today.getDate()).padStart(2,'0');
 assert.equal(f.runtime.cache.workbenchUI.todayHidden,key);
 assert.equal(f.body().querySelector('.sc-today'),null,'gone for the rest of today');
 // A render on a later local date is not held back by yesterday's dismissal.
 f.runtime.cache.workbenchUI.todayHidden='2000-01-01';await f.bench.render();
 strip=f.body().querySelector('.sc-today');assert.ok(strip,'a new day brings it back');
 f.bench.destroy();
});

test('내 문헌 분석\'s held-count opens exactly that journal\'s papers, not a text search that a sibling journal name would also match',async()=>{
 const f=fixture();
 f.library.snapshot=async()=>[...f.papers,{id:'6',key:'K6',libraryID:1,title:'Paper Gamma',authors:'Someone Else',year:'2023',venue:'Nature Methods',itemType:'journalArticle',tags:[]}];
 f.refs.set(6,{id:6});
 f.setSelection([]);
 await f.bench.show('journals');
 const natureRow=[...f.body().querySelectorAll('.sc-journal-reading-row')].find(r=>r.querySelector('.sc-journal-reading-name')?.textContent==='Nature');
 natureRow.querySelector('[role=cell]:nth-child(2) button').click();await new Promise(r=>setTimeout(r,20));
 assert.deepEqual([...f.bench.state.selected],['2'],'not the Nature Methods paper too');
 assert.deepEqual([...f.body().querySelectorAll('.sc-paper-title')].map(n=>n.textContent),['Paper Beta']);
 f.bench.destroy();
});

test('notes are found by their paper, the reading switch survives an empty view, and the kept search comes back when the selection is cleared',async()=>{
 const f=fixture();
 const known={1:{status:'reading'},2:{status:''}};
 f.runtime.state=ref=>({citations:3,impactFactor:4,...known[ref.id]});
 f.library.notes=async()=>[{id:'9',parentID:'1',title:'Checks',text:'the result was reproducible in three runs',modified:'2026-09-01'},{id:'8',parentID:'2',title:'Other',text:'reproducible elsewhere',modified:'2026-09-02'}];
 f.setSelection([]);
 await f.bench.show('notes');f.bench.state.selected=new Set();f.bench.state.query='Lovelace reproducible';await f.bench.render();
 // Both papers are by Ada Lovelace: both notes match, each saying where the author matched.
 const cards=[...f.body().querySelectorAll('.sc-card')].filter(c=>/Checks|Other/.test(c.textContent));
 assert.equal(cards.length,2);
 assert.match(cards[0].textContent,/문헌 정보 일치 — 저자: .*Lovelace/);
 // Reading: finish the only 읽는 중 paper from its view; the switch stays.
 f.bench.state.query='';
 f.runtime.cache.items[1]={seconds:60,lastRead:new Date(Date.now()-40*864e5).toISOString()};
 f.runtime.pageProgress=()=>({pages:{0:60},total:3,visited:1,percent:33,attachmentID:7,lastPageIndex:0});
 f.runtime.canEdit=()=>true;f.runtime.edit=async()=>{};
 await f.bench.show('reading');
 await f.click('읽는 중 1');
 const done=[...f.body().querySelectorAll('.sc-reading-status button')].find(b=>b.textContent==='완료');done.click();await new Promise(r=>setTimeout(r,10));
 assert.ok(f.body().querySelector('.sc-reading-views'),'the switch is still there');
 assert.equal(f.bench.state.readingView,'');
 // A search set aside by the selection bar comes back when the selection is cleared.
 await f.bench.show('explore');f.bench.state.query='Alpha';f.bench.state.selected=new Set(['1']);await f.bench.render();
 [...f.bench.panel.querySelectorAll('.sc-selection-bar button')].find(b=>b.textContent==='주석').click();await new Promise(r=>setTimeout(r,20));
 assert.equal(f.bench.state.query,'');
 await f.click('선택 해제');
 assert.equal(f.bench.state.query,'Alpha');
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
 // What is new sits in a container of its own under the name, headed "새 논문 · n"; the date it counts from is in the summary line.
 const news=f.body().querySelector('.sc-person-news');
 assert.ok(news,'the news has a box of its own');
 assert.match(news.querySelector('.sc-author-head').textContent,/^새 논문 1$/);
 assert.match(f.body().querySelector('.sc-person .sc-profile').textContent,/마지막 확인 2026-09-17/);
 assert.ok(news.querySelector('.sc-hits .sc-hit'),'its row is inside the container');

 // Re-opening the tab lists them, so they can be checked without the paper in hand.
 await f.bench.show('explore');await f.bench.show('authors');
 assert.ok(headings().includes('관심 저자 1'));

 await f.click('새 논문 1편 확인함');
 /* Marked in the one per-paper store the inbox also reads, so 확인함 in
    either place means the same thing and can be undone. It used to call
    markAuthorSeen and clearAuthorNews, which threw the stored news away for
    good and left the inbox still offering the same papers. */
 const marked=f.runtime.cache.workbenchUI?.inboxSeen||{};
 assert.equal(Object.keys(marked).length,1,'marking as read is an explicit act, recorded per paper');
 assert.equal(f.calls.some(c=>c[0]==='clearNews'),false,'and the sweep\'s own record is not thrown away');
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

test('the toolbar button takes the toolbar ink, as Zotero paints its own', async () => {
  // The outline is context-fill, so the button sits among Zotero's tools as a
  // peer rather than as a coloured badge; the button must pass the ink through.
  const {readFileSync} = await import('node:fs');
  const source = readFileSync(new URL('../src/workbench.js', import.meta.url), 'utf8');
  assert.match(source, /-moz-context-properties/, 'the ink reaches the glyph');
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

test('the panel says what has never been filled in behind a small header button, and offers to fill it', async () => {
 const f=fixture();
 f.runtime.backfillPending=async()=>({signals:1214,journals:169,authors:109});
 const ran=[];
 f.runtime.runBackfill=()=>{ran.push(1);return Promise.resolve({signals:{ok:1214,'not-found':0,error:0},journals:{found:160,missing:9},authors:{authors:109,withNews:3,works:7},budgetGone:false});};
 f.runtime.backfillSummary=()=>'채우기 완료';
 await f.bench.show('explore');
 const notice=f.bench.panel.querySelector('.sc-notice');
 // The row itself no longer sits open on every tab; the header says the count instead.
 assert.equal(notice.hidden,true,'the row waits for a press, unlike before');
 const toggle=f.bench.panel.querySelector('.sc-notice-toggle');
 assert.equal(toggle.hidden,false);
 assert.match(toggle.textContent,/자료 점검 3가지/);
 assert.match(toggle.title,/철회 여부 미확인 1214편 · 지표 없는 저널 169종 · 확인 안 한 관심 저자 109명/,'the kinds named on hover, not summed');
 await f.click(toggle.textContent);
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
 assert.equal(f.bench.panel.querySelector('.sc-notice-toggle').hidden,true,'nothing to open, so no button either');
 f.bench.destroy();
});

test('a panel talking to an older runtime simply shows no notice', async () => {
 const f=fixture();
 delete f.runtime.backfillPending;
 await f.bench.show('explore');
 assert.equal(f.bench.panel.querySelector('.sc-notice').hidden,true);
 assert.equal(f.bench.panel.querySelector('.sc-notice-toggle').hidden,true);
 f.bench.destroy();
});

test('closing the 자료 점검 row is remembered, and the header button reopens it',async()=>{
 const f=fixture();
 f.runtime.backfillPending=async()=>({signals:1214,journals:169,authors:109});
 await f.bench.show('explore');
 await f.click(f.bench.panel.querySelector('.sc-notice-toggle').textContent);
 assert.equal(f.bench.panel.querySelector('.sc-notice').hidden,false);
 await f.click('나중에');
 assert.equal(f.bench.panel.querySelector('.sc-notice').hidden,true);
 assert.equal(f.runtime.cache.workbenchUI.noticeOpen,false,'closing it is saved, not only reset in memory');
 await f.click(f.bench.panel.querySelector('.sc-notice-toggle').textContent);
 assert.equal(f.bench.panel.querySelector('.sc-notice').hidden,false,'the header button opens it again');
 assert.equal(f.runtime.cache.workbenchUI.noticeOpen,true);
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
 // A paper with no file that has not been read is the one the file stands in front of.
 assert.match(text,/안 읽었고 파일도 없는 문헌 1/);
 assert.match(text,/never uses the title/);
 await f.click('휴지통으로');
 assert.deepEqual(trashed,['22']);
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/휴지통/);
 f.bench.destroy();
});

test('the attachment list draws before the library-wide scan answers, and a stale answer is dropped',async()=>{
 const f=fixture();
 const pending={};pending.promise=new Promise(r=>{pending.resolve=r;});
 let requested=false;
 f.runtime.attachmentFindings=()=>{requested=true;return pending.promise;};
 const shown=f.bench.show('attachments');
 // The scan has been asked for but has not answered yet; the files list is already on screen.
 await new Promise(r=>setTimeout(r,0));
 assert.ok(requested);
 assert.equal(f.body().querySelectorAll('.sc-attachment-row').length,2,'the two files draw without waiting on the scan');
 assert.equal(f.body().querySelector('.sc-attachment-findings'),null,'the findings fold is not there yet');
 // Leaving the tab before the scan answers must not have it draw into whatever is on screen next.
 f.bench.state.tab='notes';await f.bench.render();
 pending.resolve({supplementary:[{id:'1',fileID:'99',title:'A paper with extras',year:'2026',file:'si.pdf',why:''}],duplicate:[],foreign:[],orphan:[],missing:[],unread:0});
 await shown;await new Promise(r=>setTimeout(r,0));
 assert.equal(f.body().querySelector('.sc-attachment-findings'),null,'a stale scan result never lands on the notes tab');
 f.bench.destroy();
});
test('the attachment heading counts what the search actually left, and per-file notes land once the scan answers',async()=>{
 const f=fixture();
 f.runtime.attachmentFindings=async()=>({supplementary:[{id:'1',fileID:'99',title:'A paper with extras',year:'2026',file:'si.pdf',why:''}],duplicate:[],foreign:[],orphan:[],missing:[],unread:0});
 await f.bench.show('attachments');
 assert.match(f.body().textContent,/이 범위의 첨부파일 2/,'both files, unfiltered');
 assert.match(f.body().textContent,/판별됨/,'the scan answered and noted the supplementary file');
 f.input('작업 패널 검색','PDF one');await f.bench.render();
 assert.match(f.body().textContent,/이 범위의 첨부파일 1/,'the heading counts files left after the search, not every file in scope');
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
 /* Whoever published is shown; whoever is quiet folds. At a hundred and nine
    followed authors the quiet cards were the whole page, and the ten that
    mattered were somewhere inside it. */
 assert.deepEqual(names,['George M. Church']);
 const badges=[...f.body().querySelectorAll('.sc-watch-badge')].map(n=>n.textContent);
 assert.deepEqual(badges,['새 논문 1'],'only the author with news is marked, with a labelled badge (user direction 2026-10-03: never a bare number)');
 // The subtitle earns its line: what the news is, not the same date on every row.
 assert.equal(f.body().querySelector('.sc-watch-sub').textContent,'2026-09 · Nature');
 // The subtitle that repeated the group head is gone (user direction 2026-10-03); the group head still counts everybody.
 assert.ok([...f.body().querySelectorAll('.sc-section-head')].some(h=>/^관심 저자\s+2$/.test(h.textContent.trim())),'the count is still everybody');
 // The quiet one is one press away, and the press says how many.
 await f.click('조용한 저자 1명 보기');
 const all=[...f.body().querySelectorAll('.sc-watch-name')].map(n=>n.textContent);
 assert.deepEqual(all,['George M. Church','Christopher A. Voigt']);
 assert.equal([...f.body().querySelectorAll('.sc-watch-sub')].map(n=>n.textContent)[1],'MIT');
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
 assert.deepEqual(chips,['전체 4','논문 2','Preprint 1','학위논문 1']);
 // The card says what kind of thing it is, unless it is a plain paper.
 const kinds=[...f.body().querySelectorAll('.sc-paper-card')].map(c=>c.querySelector('.sc-kind')?.textContent||'');
 assert.deepEqual(kinds.sort(),['','','Preprint','학위논문']);
 await f.click('학위논문 1');
 // 2026-10-03: the kind chip opens the meta line, so every title starts at the same x.
 assert.deepEqual([...f.body().querySelectorAll('.sc-paper-title')].map(h=>h.textContent),['A Thesis']);assert.equal(f.body().querySelector('.sc-paper-meta .sc-kind')?.textContent,'학위논문');
 assert.equal(f.bench.panel.querySelector('.sc-kind-chips button[data-kind=thesis]').getAttribute('aria-pressed'),'true');
 // The old 유형 select is folded into the 유형 rule; the chip is the one-press way.
 assert.equal(f.bench.panel.querySelector('select[aria-label="문헌 유형 필터"]'),null);assert.equal(f.bench.state.type,'thesis');
 await f.click('학위논문 1');
 assert.equal(f.body().querySelectorAll('.sc-paper-card').length,4);
 f.bench.destroy();
});

test('the map names its commonest journals in their own colours, and a card names its journal in that colour',async()=>{
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
 // The card spells the journal out in its own ink -- no abbreviation badge beside the full name (user, 2026-10-02).
 assert.equal(f.body().querySelectorAll('.sc-paper-meta .sc-mark').length,0);
 const venues=[...f.body().querySelectorAll('.sc-paper-meta .sc-paper-venue[data-known]')];
 assert.ok(venues.length>=2&&venues.every(v=>v.style.getPropertyValue('--j-ink-l')==='#335'));
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

test('the followed table shows a round face, tier + flag + institution, and centres every cell',async()=>{
 const f=fixture();
 const rows=[{id:'A1',name:'Ada Lovelace',institution:'MIT',sweptAt:'2026-09-01T00:00:00Z',news:[{id:'W1'}],seen:[]},
  {id:'A2',name:'Bo',institution:'Quiet College',sweptAt:'2026-08-01T00:00:00Z',news:[],seen:[]},
  {id:'A3',name:'Cy',institution:'',news:[],seen:[]}];
 f.runtime.watchedAuthors=()=>rows;f.runtime.watchedAuthorsByNews=()=>rows;
 f.runtime.portraitOf=id=>id==='A1'?{url:'data:image/png;base64,AAAA',page:'https://example.org'}:null;
 f.runtime.placeOf=name=>name==='MIT'?{country:'US',flag:'\u{1F1FA}\u{1F1F8}',hIndex:2400,tier:{key:'t1',label:'T1',note:'note'}}:name==='Quiet College'?{country:'',flag:'',hIndex:300,tier:{key:'t4',label:'T4',note:'note'}}:null;
 await f.bench.show('authors');
 await f.click('목록 관리');
 const tr=n=>f.body().querySelector(`.sc-watch-table tbody tr:nth-child(${n})`);
 const photo=tr(1).querySelector('.sc-face img');
 assert.ok(photo,'a held photo is the avatar');assert.equal(photo.getAttribute('alt'),'Ada Lovelace');assert.equal(photo.loading,'lazy');
 assert.equal(tr(2).querySelector('.sc-face img'),null,'no photo: initials');
 assert.equal(tr(2).querySelector('.sc-face .sc-face-text').textContent,'B');
 assert.ok(tr(1).querySelector('td:first-child .sc-face + button'),'the face comes before the name');
 const place=tr(1).querySelector('.sc-place');
 assert.equal(place.querySelector('.sc-tier-t1').textContent,'T1');
 assert.equal(place.querySelector('.sc-flag').textContent,'\u{1F1FA}\u{1F1F8}');
 assert.match(place.getAttribute('title'),/MIT · .* · 기관 h-index 2400/);
 assert.equal(tr(2).querySelector('.sc-flag'),null,'unknown country: no flag');
 assert.ok(tr(2).querySelector('.sc-tier-t4'));
 assert.equal(tr(3).querySelector('.sc-place-name').textContent,'소속 미상');
 assert.equal(tr(3).querySelector('.sc-tier'),null);
 // User direction 2026-10-03 (detail review): a count in a table cell is a plain right-aligned number, the unit is in the header; no pill per cell.
 assert.ok(tr(1).querySelector('td.sc-col-n .sc-cell-number'),'the count is a plain number inside its cell');
 assert.equal(tr(1).querySelector('td.sc-watch-count'),null,'no badge class on a td');
 const css=fs.readFileSync(new URL('../content/workbench.css',import.meta.url),'utf8');
 assert.match(css,/\.sc-watch-table th, #style-custom-workbench \.sc-watch-table td \{[^}]*vertical-align: middle/);
 assert.doesNotMatch(css,/\.sc-watch-table th, #style-custom-workbench \.sc-watch-table td \{ vertical-align: top/);
 f.bench.destroy();
});

const expandFixture=()=>{
 const f=fixture();
 const rows=[
  {id:'A1',name:'Ada Lovelace',institution:'MIT',subfield:'Biotechnology',sweptAt:'2026-09-01T00:00:00Z',seen:[],
   news:[{id:'W1',title:'Genetic circuits at scale',venue:'Nature Biotechnology',date:'2026-09-02',doi:'10.1/n1',citations:12,position:'last'},
    {id:'W2',title:'A bioRxiv preprint on recombinases',venue:'bioRxiv (Cold Spring Harbor Laboratory)',date:'2026-08-02',doi:'10.1101/n2',preprint:true,position:'first'}],
   newCoauthors:['Priya N.'],moved:{from:'MIT',to:'Broad Institute',since:2026}},
  {id:'A2',name:'Bo Chen',institution:'University of Zurich',subfield:'Molecular Biology',sweptAt:'2026-08-01T00:00:00Z',news:[],seen:[]},
  {id:'A3',name:'Cy Dunn',institution:'Imperial College London',subfield:'Biotechnology',sweptAt:'2026-08-01T00:00:00Z',news:[],seen:[]},
  {id:'A4',name:'Di Evans',institution:'Quiet College',news:[],seen:[]}];
 f.runtime.watchedAuthors=()=>rows;f.runtime.watchedAuthorsByNews=()=>rows;
 f.runtime.placeOf=name=>({MIT:['US',2400],'University of Zurich':['CH',300],'Imperial College London':['GB',1500]})[name]?.reduce((c,h)=>({country:c,flag:'',hIndex:h,tier:h>=2000?{key:'t1',label:'T1',note:'n'}:h>=1400?{key:'t2',label:'T2',note:'n'}:h>=400?{key:'t3',label:'T3',note:'n'}:{key:'t4',label:'T4',note:'n'}}))||null;
 f.runtime.coauthorsOf=()=>[{id:'A2',name:'Bo Chen',institution:'University of Zurich',papers:4,last:2026,titles:[]},{id:'A77',name:'Zed Outsider',institution:'Elsewhere',papers:1,last:2024,titles:[]}];
 f.runtime.authorUpdates=async id=>({profile:{name:rows.find(r=>r.id===id)?.name||id,hIndex:50,works:120,citations:9000,institutions:['MIT'],topics:[{name:'Topic',count:3}],orcid:''},
  works:[{id:'R1',title:'A recent paper',venue:'Science',year:2026,citations:5,authors:['x']}],fresh:[],watching:true,checkedAt:'2026-09-17T00:00:00Z'});
 return {f,rows};
};
const personOf=f=>f.body().querySelector('.sc-watch-expand');
const keyOn=(f,target,value)=>{const e=new f.win.Event('keydown',{bubbles:true,cancelable:true});Object.assign(e,{key:value});target.dispatchEvent(e);return e;};

test('an author row opens its detail right under it: one at a time, Esc and a second press close it, a redraw keeps it',async()=>{
 const {f}=expandFixture();
 await f.bench.show('authors');await f.click('목록 관리');
 const row=id=>f.body().querySelector(`tr.sc-watch-row[data-author-id="${id}"]`);
 const name=id=>row(id).querySelector('.sc-journal-name');
 assert.equal(personOf(f),null,'nothing is open at first');
 assert.equal(name('A1').getAttribute('aria-expanded'),'false');
 name('A1').dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 const open=personOf(f);
 assert.ok(open,'the detail row exists');
 assert.equal(open.previousElementSibling,row('A1'),'directly under the row it belongs to');
 assert.equal(open.querySelector('td').getAttribute('colspan'),String(row('A1').children.length),'one cell spanning every column');
 assert.ok(row('A1').classList.contains('sc-watch-open'));
 assert.equal(name('A1').getAttribute('aria-expanded'),'true');
 assert.equal(f.doc.activeElement,open.querySelector('.sc-watch-expand-body'),'the focus moves into the panel');
 assert.equal(f.body().querySelector('.sc-person-full').textContent,'상세 보기','the full view stays one press away');
 // Another author closes the first.
 row('A2').dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.equal(f.body().querySelectorAll('.sc-watch-expand').length,1,'one at a time');
 assert.equal(personOf(f).previousElementSibling,row('A2'));
 assert.equal(name('A1').getAttribute('aria-expanded'),'false');
 assert.ok(!row('A1').classList.contains('sc-watch-open'));
 // A redraw of the table (a sort, a search, a refresh) keeps the panel where it was.
 const sort=f.body().querySelector('select[aria-label="관심 저자 정렬"]');sort.value='name';sort.dispatchEvent(new f.win.Event('change',{bubbles:true}));await settle();
 assert.equal(personOf(f)?.previousElementSibling,row('A2'),'still open after a redraw');
 f.input('관심 저자 찾기','bo');await settle();
 assert.equal(personOf(f)?.previousElementSibling,row('A2'),'and after a search');
 f.input('관심 저자 찾기','');await settle();
 // Esc closes it and gives the focus back to the row.
 const esc=keyOn(f,personOf(f).querySelector('.sc-watch-expand-body'),'Escape');
 assert.equal(esc.defaultPrevented,true);
 assert.equal(personOf(f),null);
 assert.equal(f.doc.activeElement,name('A2'),'focus returns to the name');
 // A second press on the same row closes it as well.
 row('A2').dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.ok(personOf(f));
 name('A2').dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.equal(personOf(f),null);
 // The row's own buttons do not open it.
 await f.click('해제');
 assert.equal(personOf(f),null,'해제 is its own button');
 f.bench.destroy();
});

test('the detail is containers of rows, the same renderer inline and as a page: no heading with loose rows',async()=>{
 const {f}=expandFixture();
 f.runtime.cache.workbenchUI={...(f.runtime.cache.workbenchUI||{}),inboxSeen:{}};
 await f.bench.show('authors');await f.click('목록 관리');
 f.body().querySelector('tr.sc-watch-row[data-author-id="A1"]').dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 const check=(root,where,wanted)=>{
  const heads=[...root.querySelectorAll('.sc-section-head')];
  assert.ok(heads.length>=wanted.length,where+': sections are drawn');
  for(const head of heads){
   assert.ok(head.parentNode.classList.contains('sc-group'),where+': "'+head.textContent+'" sits in a container');
   assert.ok(head.nextElementSibling||/마지막 확인 이후/.test(head.textContent),where+': a heading is followed by its rows');
  }
  const names=heads.map(h=>h.querySelector('.sc-section-head-name').textContent);
  for(const name of wanted)assert.ok(names.includes(name),where+': '+name);
  // Nothing hangs loose between the containers.
  const wrap=root.querySelector('.sc-person-detail');
  for(const child of wrap.children)assert.ok(child.matches('.sc-group,.sc-person,.sc-actions,.sc-muted'),where+': loose '+child.className+' '+child.tagName);
 };
 const inline=personOf(f);
 check(inline,'inline',['새 논문','최근 논문','함께 낸 저자']);
 // News rows keep the inbox's anatomy: a journal in its ink, a Preprint chip, the part played, the actions.
 const rows=[...inline.querySelectorAll('.sc-author-inbox-row')];
 assert.equal(rows.length,2);
 assert.ok(rows[0].querySelector('.sc-paper-venue'),'journal');
 assert.ok(rows[1].querySelector('.sc-preprint'),'one Preprint chip');
 assert.match(rows[0].textContent,/마지막 저자/);
 assert.ok(rows[0].querySelector('.sc-inbox-seen'),'확인함');
 assert.equal(rows[0].querySelector('.sc-inbox-faces'),null,'no repeated faces for the one person');
 // The coauthor circle wraps into a grid of chips; a followed one expands where it stands, anyone else has their own page.
 const chips=[...inline.querySelectorAll('.sc-network .sc-node')];
 assert.equal(chips.length,2);
 assert.match(chips[0].textContent,/Bo Chen4편 · 2026/);
 assert.equal(chips[0].dataset.followed,'true');
 assert.equal(chips[1].dataset.followed,undefined);
 chips[0].dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.equal(f.body().querySelectorAll('.sc-watch-expand').length,1);
 assert.equal(personOf(f).previousElementSibling.dataset.authorId,'A2','a followed co-author opens in the table');
 // 상세 보기: the same detail as the full page.
 await f.click('상세 보기');
 const page=f.body().querySelector('.sc-author-page');
 assert.ok(page.querySelector('.sc-person-detail:not(.sc-person-inline)'));
 check(page,'page',['최근 논문','함께 낸 저자']);
 f.bench.destroy();
});

test('the followed table can be grouped, filtered by chips, and remembers both',async()=>{
 const {f,rows}=expandFixture();
 await f.bench.show('authors');await f.click('목록 관리');
 assert.equal(f.body().querySelectorAll('.sc-watch-group').length,0,'no grouping by default');
 const groups=()=>[...f.body().querySelectorAll('.sc-watch-group')].map(g=>g.querySelector('.sc-watch-group-toggle').textContent.replace(/\s+/g,' ').trim());
 await f.click('티어');
 assert.deepEqual(groups(),['T1 1명 새 논문 2','T2 1명','T4 1명','미상 1명'],'tiers in order, the unknown last, new papers counted');
 assert.ok(groups().at(-1).startsWith('미상'),'the unknown go last');
 for(const g of f.body().querySelectorAll('.sc-watch-group'))assert.ok(g.classList.contains('sc-group'),'a group is a container');
 await f.click('국가');
 assert.equal(groups().length,4,'three countries and the unknown');
 await f.click('분야');
 assert.match(groups()[0],/^Biotechnology 2명/,'the biggest field first');
 assert.ok(groups().some(t=>t.startsWith('분야 미상 1명')));
 await f.click('소속');
 assert.equal(groups().length,4);
 // An open author keeps working inside a group.
 f.body().querySelector('tr.sc-watch-row[data-author-id="A1"]').dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.ok(f.body().querySelector('.sc-watch-group tr.sc-watch-expand'),'the panel opens inside its group');
 // A group folds, and stays folded.
 const first=f.body().querySelector('.sc-watch-group-toggle');
 first.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.equal(first.getAttribute('aria-expanded'),'false');
 assert.equal(f.runtime.cache.workbenchUI.watchClosed.length,1);
 assert.equal(f.runtime.cache.workbenchUI.watchGroup,'place');
 // Filter chips: several of one kind add up, different kinds narrow, every count is live.
 await f.click('없음');
 const chip=(dim,label)=>[...f.body().querySelectorAll(`[data-facet="${dim}"] .sc-watch-chip`)].find(b=>b.textContent.replace(/\s*\d+$/,'')===label);
 const names=()=>[...f.body().querySelectorAll('.sc-watch-row .sc-journal-name')].map(b=>b.textContent);
 assert.equal(names().length,4);
 chip('tier','T1').dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.deepEqual(names(),['Ada Lovelace']);
 chip('tier','T2').dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.deepEqual(names(),['Ada Lovelace','Cy Dunn'],'T1 and T2 add up');
 chip('field','Biotechnology').dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.deepEqual(names(),['Ada Lovelace','Cy Dunn']);
 chip('field','Molecular Biology');
 assert.match(chip('field','Molecular Biology').textContent,/0$/,'a field no one in T1+T2 works in counts 0');
 f.input('관심 저자 찾기','cy');await settle();
 assert.deepEqual(names(),['Cy Dunn'],'combined with the name search');
 f.input('관심 저자 찾기','');await settle();
 assert.deepEqual(f.runtime.cache.workbenchUI.watchFilters.tier.sort(),['T1','T2']);
 await f.click('필터 지우기');
 assert.equal(names().length,4);
 assert.equal(f.body().querySelector('.sc-watch-clear'),null,'nothing to clear');
 f.bench.destroy();
});

test('grouping by field says when the field is still unknown, and the sweep keeps the field it reads',async()=>{
 const f=fixture();
 const rows=[{id:'A1',name:'Ada',institution:'MIT',news:[],seen:[]},{id:'A2',name:'Bo',institution:'MIT',news:[],seen:[]}];
 f.runtime.watchedAuthors=()=>rows;f.runtime.watchedAuthorsByNews=()=>rows;
 await f.bench.show('authors');await f.click('목록 관리');
 assert.match(f.body().querySelector('[data-facet="field"]').textContent,/다음 새 논문 확인 때 채워집니다/);
 await f.click('분야');
 const head=f.body().querySelector('.sc-watch-group-toggle');
 assert.match(head.textContent,/분야 미상/);
 assert.match(head.getAttribute('title'),/분야를 아는 저자 0\/2명/);
 f.bench.destroy();
 const [profile]=Discover.readProfiles({results:[{id:'https://openalex.org/A1',display_name:'X',topics:[{count:5,subfield:{display_name:'Biotechnology'},field:{display_name:'Biochemistry, Genetics and Molecular Biology'}},{count:9,subfield:{display_name:'Molecular Biology'},field:{display_name:'Biochemistry, Genetics and Molecular Biology'}},{count:2,subfield:{display_name:'Biotechnology'},field:{display_name:'Biochemistry, Genetics and Molecular Biology'}}]}]});
 assert.equal(profile.subfield,'Molecular Biology');
 assert.match(Discover.watchedProfilesURL(['A1']),/select=[^&]*topics/,'same request, one more column');
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
 assert.match(place.querySelector('.sc-place').getAttribute('title'),/^MIT · 등록 당시: MIT chemistry$/);
 assert.ok(f.body().querySelector('.sc-watch-table tbody tr:nth-child(2) td.sc-watch-moved'),'a move is shaded');
 assert.deepEqual([...f.body().querySelectorAll('.sc-watch-table thead th')].map(t=>t.textContent),['이름','소속','읽기 상태','읽은 시간','마지막 확인','새 논문','특허','']); // counts are plain numbers; the unit is the header's title (user direction 2026-10-03)
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

test('the watch table also shows held/finished/unread/reading-time, marks a guessed match, and sorts by them',async()=>{
 const f=fixture();
 // Paper Alpha (id 1) finished with time on it, Paper Beta (id 2) unread; both by Ada Lovelace.
 f.runtime.state=ref=>({citations:3,impactFactor:4,status:ref.id===1?'done':'unread',seconds:ref.id===1?600:ref.id===2?1200:0});
 f.runtime.watchedAuthorsByNews=()=>[{id:'A1',name:'Ada Lovelace',seen:[],news:[]},{id:'A2',name:'A. M. Lovelace',seen:[],news:[]},{id:'A9',name:'Nobody Here',seen:[],news:[]}];
 await f.bench.show('authors');
 await f.click('목록 관리');
 const row=name=>[...f.body().querySelectorAll('.sc-watch-table tbody tr')].find(tr=>tr.querySelector('button').textContent===name);
 const cells=name=>[...row(name).querySelectorAll('td')].map(td=>td.textContent);
 // 이름 · 소속 · 읽기 상태(보유·완료·안 읽음, merged) · 읽은 시간 · 마지막 확인 · 새 논문 · 특허 · (actions)
 const ada=cells('Ada Lovelace');
 assert.equal(ada[2],'보유 2 · 완료 1 · 안 읽음 1','both papers match the full name, split by status in one cell');
 assert.match(ada[3],/\d/,'a reading-time figure is shown, not just a bar');
 assert.equal(cells('A. M. Lovelace')[2],'보유 2? · 완료 1 · 안 읽음 1','a family-name-and-initial-only match is marked as a guess');
 assert.equal(cells('Nobody Here')[2],'—','nothing in the library matches this name');
 // Co-authored papers counting for every followed author on them is said on the merged column's header.
 const heldHead=[...f.body().querySelectorAll('.sc-watch-table thead th')].find(th=>th.textContent==='읽기 상태');
 assert.match(heldHead.getAttribute('title'),/공동 저자/);
 const sort=f.body().querySelector('select[aria-label="관심 저자 정렬"]');
 const order=()=>[...f.body().querySelectorAll('.sc-watch-table tbody tr td:first-child button')].map(b=>b.textContent);
 sort.value='time';sort.dispatchEvent(new f.win.Event('change',{bubbles:true}));
 assert.equal(order().at(-1),'Nobody Here','읽은 시간순 puts nobody with no recorded time last');
 sort.value='unread';sort.dispatchEvent(new f.win.Event('change',{bubbles:true}));
 assert.equal(order().at(-1),'Nobody Here','안 읽음 많은 순 puts nobody with no unread papers last');
 f.bench.destroy();
});

test('the followed authors with something to say are the ones on screen; the quiet fold',async()=>{
 const f=fixture();
 const rows=[{id:'A1',name:'Ada',news:[{id:'W1'}],seen:[]},{id:'A2',name:'Bo',news:[],seen:[]},{id:'A3',name:'Cy',news:[],moved:{from:'X',to:'Y',rule:2},seen:[]}];
 f.runtime.watchedAuthors=()=>rows;f.runtime.watchedAuthorsByNews=()=>rows;
 await f.bench.show('authors');
 const names=()=>[...f.body().querySelectorAll('.sc-watch-name')].map(n=>n.textContent);
 assert.deepEqual(names(),['Ada','Cy'],'news or a move counts; a quiet card waits');
 await f.click('조용한 저자 1명 보기');
 assert.deepEqual(names(),['Ada','Bo','Cy']);
 await f.click('조용한 저자 접기');
 assert.deepEqual(names(),['Ada','Cy']);
 f.bench.destroy();
});

test('with nobody in the news the quiet authors stay folded until the reader expands them',async()=>{
 // Marking the last paper seen must not open 109 cards.
 const f=fixture();
 const rows=[{id:'A1',name:'Ada',news:[],seen:[]},{id:'A2',name:'Bo',news:[],seen:[]}];
 f.runtime.watchedAuthors=()=>rows;f.runtime.watchedAuthorsByNews=()=>rows;
 await f.bench.show('authors');
 const names=()=>[...f.body().querySelectorAll('.sc-watch-name')].map(n=>n.textContent);
 assert.deepEqual(names(),[]);
 await f.click('조용한 저자 2명 보기');
 assert.deepEqual(names(),['Ada','Bo']);
 f.bench.destroy();
});

test('R18 after the last news is marked seen the quiet authors stay folded and the manage list counts unseen papers only',async()=>{
 const f=fixture();
 const rows=[{id:'A1',name:'Ada',news:[{id:'W1',doi:'10.1/a',title:'One'}],seen:[]},{id:'A2',name:'Bo',news:[{id:'W2',doi:'10.1/b',title:'Two'},{id:'W3',doi:'10.1/c',title:'Three'}],seen:[]},{id:'A3',name:'Cy',news:[],seen:[]}];
 f.runtime.watchedAuthors=()=>rows;f.runtime.watchedAuthorsByNews=()=>rows;
 f.runtime.cache.workbenchUI={...(f.runtime.cache.workbenchUI||{}),inboxSeen:{'1:10.1/a':'2026-09-01','1:10.1/b':'2026-09-01','1:10.1/c':'2026-09-01'}};
 await f.bench.show('authors');
 assert.deepEqual([...f.body().querySelectorAll('.sc-watch-name')].map(n=>n.textContent),[],'everything seen: no cards until asked');
 await f.click('목록 관리');
 const counts=[...f.body().querySelectorAll('.sc-watch-table tbody tr')].map(tr=>tr.querySelector('td.sc-col-n').textContent);
 assert.deepEqual(counts,['—','—','—'],'확인함 is respected in the count');
 f.bench.destroy();
});

test('R18 an autosave that lands while the reader keeps typing does not collapse the inline memo',async()=>{
 const f=fixture();
 f.runtime.cache.items[1]={seconds:125,lastRead:new Date().toISOString(),remark:'first'};
 f.runtime.pageProgress=ref=>ref.id===1?{pages:{4:60},total:20,visited:5,percent:25,attachmentID:100,lastPageIndex:4}:{pages:{},total:0,visited:0,percent:0};
 let release;f.library.setRemark=()=>new Promise(r=>{release=r;});
 await f.bench.show('reading');
 f.body().querySelector('.sc-resume-remark').click();
 const field=f.body().querySelector('.sc-resume-memo-editor textarea');
 field.value='first, second';field.dispatchEvent(new f.win.Event('input',{bubbles:true}));field.dispatchEvent(new f.win.Event('blur'));
 await settle();field.focus();
 field.value='first, second, third';field.dispatchEvent(new f.win.Event('input',{bubbles:true}));
 release();await settle();
 assert.equal(f.body().querySelector('.sc-resume-memo-editor textarea'),field,'still editing');
 assert.equal(field.value,'first, second, third');
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
 // A45: the strip is built only once its fold is opened.
 const fold=f.body().querySelector('.sc-resume-pages');fold.open=true;fold.dispatchEvent(new f.win.Event('toggle'));
 const cells=[...f.body().querySelector('.sc-page-strip').querySelectorAll('.sc-page-cell')];
 assert.equal(cells.length,100,'one square per page of the first hundred');
 assert.equal(cells[0].dataset.level,'0','two seconds is a glance, not reading');assert.equal(cells[1].dataset.level,'0');
 assert.equal([...f.body().querySelectorAll('.sc-page-strip .sc-page-row')].slice(0,5).map(r=>r.textContent).join(','),'1,21,41,61,81','a row label every twenty pages');
 assert.equal(cells[0].getAttribute('title'),'1페이지 · 2초');
 assert.equal(cells[0].textContent,'','no number on the square');
 assert.ok(f.body().querySelector('.sc-page-legend'),'a key from little to much');
 f.bench.destroy();
});

test('A45 쪽별 기록: summary carries 방문 쪽/전체 쪽 always, and the annotation count once known; annotated pages carry a coloured mark; choosing one shows its evidence below the strip',async()=>{
 const f=fixture();
 f.runtime.pageProgress=()=>({pages:{0:2,6:40},total:12,visited:2,percent:16,attachmentID:'99'});
 f.library.annotations=async()=>[
  {id:'3',parentID:'1',attachmentID:'99',text:'',comment:'a marked passage',color:'#ffd400',pageLabel:'7',pageIndex:6}];
 await f.bench.show('reading');
 const fold=f.body().querySelector('.sc-resume-pages');
 // Before opening: the visited/total figure is there, the annotation count is not -- unknown yet.
 assert.match(fold.querySelector('summary').textContent,/쪽별 기록 · 방문 2\/12/);
 assert.equal(/주석/.test(fold.querySelector('summary').textContent),false,'not claimed before it is known');
 fold.open=true;fold.dispatchEvent(new f.win.Event('toggle'));await settle();
 // Reopening (a full redraw already ran once the fetch resolved) now knows the count.
 const foldAgain=f.body().querySelector('.sc-resume-pages');
 assert.match(foldAgain.querySelector('summary').textContent,/쪽별 기록 · 방문 2\/12 · 주석 1/);
 const marked=foldAgain.querySelector('.sc-page-cell[aria-label^="7페이지"]');
 assert.ok(marked.querySelector('.sc-page-annot-mark'),'the annotated page carries a mark');
 assert.equal(foldAgain.querySelector('.sc-page-cell[aria-label^="1페이지"]').querySelector('.sc-page-annot-mark'),null,'a page with no annotation carries none');
 assert.equal(foldAgain.querySelector('.sc-page-evidence').textContent,'','nothing chosen yet');
 marked.dispatchEvent(new f.win.Event('click',{bubbles:true}));
 const evidence=foldAgain.querySelector('.sc-page-evidence');
 assert.match(evidence.textContent,/7쪽.*주석 1개.*a marked passage/);
 assert.match(evidence.querySelector('button[data-opens=window]').textContent,/^7쪽/);
 f.bench.destroy();
});

test('the page-time legend lives inside each 쪽별 기록 fold, not as a standing line above the list',async()=>{
 const f=fixture();
 await f.bench.show('reading');
 const list=f.body().querySelector('[data-reading-progress]');
 // Not a direct child of the list, floating above every card.
 assert.equal([...list.children].some(c=>c.classList?.contains('sc-page-legend')),false,'no standing line at the top of the page');
 const fold=f.body().querySelector('.sc-resume-pages');
 assert.ok(fold,'a fold exists for the paper with a page total');
 fold.open=true;fold.dispatchEvent(new f.win.Event('toggle'));
 assert.ok(fold.querySelector('.sc-page-legend'),'the key is inside the fold that explains it');
 f.bench.destroy();
});

test('the comparison table reads in words and its titles open the paper',async()=>{
 const f=fixture({items:{},readerSettings:{},matrixFields:['title','status','seconds']});
 f.library.snapshot=async()=>f.papers.map((p,i)=>({...p,status:i?'done':'reading',seconds:i?0:3900}));
 f.setSelection([]);f.bench.state.selected=new Set();
 await f.bench.show('matrix');
 const status=f.body().querySelector('td[data-field=status]');
 assert.equal(status.textContent,'읽는 중','not the stored word "reading"');
 assert.notEqual(f.body().querySelector('td[data-field=seconds]').textContent,'3900');
 const title=f.body().querySelector('td[data-field=title] button');
 assert.ok(title,'a title is a way to the paper');assert.equal(title.dataset.opens,'window');
 title.click();await settle();
 assert.ok(f.calls.find(c=>c[0]==='open'&&c[1]==='1'));
 assert.match(f.body().textContent,/선택 없음 · 현재 목록 전체/);
 f.bench.destroy();
});

test('reading history opens on the most recently read, thirty to a page, and can sort by time',async()=>{
 const f=fixture();
 const extra=[];
 for(let n=10;n<45;n++){extra.push({...f.papers[0],id:String(n),key:'K'+n,title:'Read '+n});f.refs.set(n,{id:n});
  f.runtime.cache.items[n]={seconds:n*60,lastRead:`2026-09-${String(n-9).padStart(2,'0')}T10:00:00Z`};}
 // Paper 44 was read last; paper 10 was read longest ago but ranks by time below none.
 f.runtime.cache.items[10].seconds=99999;
 f.library.snapshot=async()=>[...f.papers,...extra];
 f.runtime.pageProgress=()=>({pages:{},total:0,visited:0,percent:0});
 await f.bench.show('reading');
 const titles=()=>[...f.body().querySelectorAll('.sc-reading-record .sc-resume-title')].map(c=>c.textContent);
 assert.equal(titles().length,30,'thirty rows, not every paper ever opened');
 // The three read in the last fortnight and not finished are in 이어 읽기, above, and not listed twice.
 const resumed=[...f.body().querySelectorAll('.sc-resume:not(.sc-reading-records) .sc-resume-title')].map(t=>t.textContent);
 assert.equal(resumed.length,3);
 for(const t of resumed)assert.ok(!titles().some(x=>x.includes(t)),`${t} is listed once`);
 assert.match(f.body().textContent,/1–30 \/ 32편/);
 await f.click('다음');
 assert.equal(titles().length,2);
 const order=f.body().querySelector('[aria-label="읽기 기록 정렬"]');order.value='time';order.dispatchEvent(new f.win.Event('change'));
 assert.match(titles()[0],/Read 10/,'longest read first on request');
 f.bench.destroy();
});

test('the journals tab opens on what the library does with each journal: held, unread, time read, cited with its count',async()=>{
 const f=fixture();
 const extra=[{id:'5',key:'K5',libraryID:1,title:'Nature two',year:'2023',venue:'Nature',itemType:'journalArticle',status:'done',seconds:600,citations:10,tags:[]},
  {id:'6',key:'K6',libraryID:1,title:'Nature three',year:'2022',venue:'Nature',itemType:'journalArticle',citations:null,tags:[]}];
 f.library.snapshot=async()=>[...f.papers.map(p=>({...p,citations:p.venue==='Nature'?4:null})),...extra];
 f.refs.set(5,{id:5});f.refs.set(6,{id:6});
 // What the runtime knows of each: Beta and Nature three unread, Nature two done, citations as given.
 const known={1:{status:'reading',citations:null},2:{status:'',citations:4},5:{status:'done',citations:10,seconds:600},6:{status:'',citations:null}};
 f.runtime.state=ref=>({impactFactor:4,...known[ref.id]});
 await f.bench.show('journals');
 const rows=[...f.body().querySelectorAll('.sc-journal-reading-row:not(.sc-journal-reading-header)')];
 assert.deepEqual(rows.map(r=>r.querySelector('.sc-journal-reading-name').textContent),['Nature','Science'],'most unread first');
 const cells=[...rows[0].querySelectorAll('[role=cell]')].map(c=>c.textContent);
 // User direction 2026-10-03: counts are plain numbers; the unit (편) is in the column header.
 assert.equal(cells[1],'3');
 assert.match(cells[2],/^2$/);
 assert.match(cells[3],/75%.*100%/s,'three of the four papers, all the reading time');
 assert.match(cells[5],/10 · 1\/1편.*4 · 1\/2편/s,'the median of the known ones in each reading state, and on how many');
 await f.click('2');
 assert.deepEqual([...f.body().querySelectorAll('.sc-journal-reading-paper .sc-hit-title-link')].map(n=>n.textContent).sort(),['Nature three','Paper Beta']);
 await f.click('읽은 시간순');
 assert.equal(f.body().querySelector('.sc-journal-reading-row:not(.sc-journal-reading-header) .sc-journal-reading-name').textContent,'Nature');
 assert.equal(f.calls.filter(c=>/openalex|fetch/i.test(String(c[0]))).length,0,'asks nothing');
 f.bench.destroy();
});

test('내 문헌 분석 carries the official JCR quartile and category rank when a real captured catalog is loaded, and says nothing where it is not in JCR',async()=>{
 const f=fixture();
 const extra=[{id:'5',key:'K5',libraryID:1,title:'Cell paper',year:'2023',venue:'Cell',itemType:'journalArticle',tags:[]}];
 f.library.snapshot=async()=>[...f.papers,...extra];
 f.refs.set(5,{id:5});
 f.runtime.journalIdentity={identify:venue=>({Nature:{issns:['0028-0836']},Science:{issns:['0036-8075']}})[venue]||null};
 // The categories a journal is placed in are not sorted best-first in the
 // catalog; the row has to pick out Q1 8/140 over Q2 50/300 itself.
 f.runtime.jcrCatalog={source:{provider:'Clarivate',product:'JCR',metricYear:2025},
  category:key=>({'MULTIDISCIPLINARY SCIENCES':{name:'Multidisciplinary Sciences'},ENGINEERING:{name:'Engineering'}}[key]||null),
  journals:[
   {title:'Nature',issns:['0028-0836'],jif:50.5,categoryMetrics:[
     {categoryKey:'ENGINEERING',rank:50,rankTotal:300,quartile:2,percentile:83.5},
     {categoryKey:'MULTIDISCIPLINARY SCIENCES',rank:8,rankTotal:140,quartile:1,percentile:94.3}]},
   {title:'Science',issns:['0036-8075'],jif:44.7,categoryMetrics:[
     {categoryKey:'MULTIDISCIPLINARY SCIENCES',rank:12,rankTotal:140,quartile:1,percentile:91.8}]}]};
 await f.bench.show('journals');
 const row=venue=>[...f.body().querySelectorAll('.sc-journal-reading-row')].find(r=>r.querySelector('.sc-journal-reading-name-text')?.textContent===venue);
 assert.equal(row('Nature').querySelector('.sc-journal-reading-jcr').textContent,'IF 50.5 · Q1 8/140 Multidisciplinary Sciences +1','the better of its two categories leads, the other counted');
 assert.match(row('Nature').querySelector('.sc-journal-reading-jcr').getAttribute('title'),/Clarivate JCR 2025\(공식\).*Multidisciplinary Sciences Q1 8\/140.*Engineering Q2 50\/300/s);
 assert.equal(row('Science').querySelector('.sc-journal-reading-jcr').textContent,'IF 44.7 · Q1 12/140 Multidisciplinary Sciences','one category, no +N chip');
 assert.equal(row('Cell').querySelector('.sc-journal-reading-jcr').textContent,'JCR에 없음','looked up and absent, not a blank');
 assert.match(f.body().querySelector('.sc-journal-reading-jcr-note').textContent,/IF·Q·순위는 Clarivate JCR 2025\(공식\) 기준입니다\./);
 await f.click('IF 높은 순');
 assert.deepEqual([...f.body().querySelectorAll('.sc-journal-reading-row:not(.sc-journal-reading-header) .sc-journal-reading-name-text')].map(n=>n.textContent).slice(0,2),['Nature','Science'],'highest JIF first');
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
 // 자세히 now opens a paper in place; the selection scope is reached through the scope itself.
 f.bench.state.selected=new Set(['1']);f.bench.state.scope='selected';await f.bench.render();
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

/* The shipped taxonomy, parsed once. A clean checkout has only the openly
   licensed catalogue: the captured JCR tables are licensed to their reader and
   are not in the repository.

   These tests are about the panel around the catalog, not about its 89,510
   journals, and holding a frozen copy of all of them made the rest of this
   file crawl. So the real groups and categories go in and the journal list is
   whatever the test needs, with complete.journals false to say so.
   JCRCategories.create copies everything it is handed, so one parsed payload
   safely backs every catalog built here. */
let SHIPPED=null,SHIPPED_CATALOG=null;
function shippedPayload(){return SHIPPED||=JSON.parse(fs.readFileSync(new URL('../data/journal-catalog.json',import.meta.url),'utf8'));}
function shippedTaxonomy(journals,categoryCount){
 const shipped=shippedPayload();
 const original=shipped.categories.find(row=>row.journalCount>0&&row.groupKeys.length);
 const category=categoryCount==null?original:{...original,journalCount:categoryCount};
 return {payload:{...shipped,
  source:{...shipped.source,complete:{...shipped.source.complete,journals:false}},
  categories:shipped.categories.map(row=>row===original?category:row),
  journals},category};
}
function shippedCatalog(){return SHIPPED_CATALOG||=JCRCategories.create(shippedTaxonomy([]).payload);}
function capturedJCRControl(){
 /* One deliberately named unit-test journal, so the callbacks and the metric
    cells are exercised against a row whose figures are known. It is never
    written to the shipped data. */
 const {payload,category}=shippedTaxonomy([],100);
 payload.journals=[{key:'integration-control',title:'Integration control journal',abbreviation:'CONTROL',issns:['1234-5678'],
  categoryKeys:[category.key],citedness:5.2,citednessRanks:[3],citednessQuartiles:[1],citednessPercentiles:[97.5]}];
 return {catalog:JCRCategories.create(payload),category};
}

test('actual journal tab defaults to all captured JCR groups despite old OpenAlex selections and paper filters',async()=>{
 const f=fixture({items:{},readerSettings:{},workbenchUI:{lastTab:'journals'}},undefined,{nativeJCR:true});
 Object.assign(f.bench.state.journalView.pick,{domain:'Life Sciences',field:'Biology',subfield:'Genetics'});
 Object.assign(f.bench.state,{query:'a paper filter with no journal matches',scope:'selected'});
 await f.bench.show('journals');
 assert.equal(f.bench.state.journalBrowser,'jcr');
 assert.equal(f.body().querySelectorAll('.sc-jcr-group').length,shippedPayload().groups.length);
 assert.equal(f.body().querySelector('.sc-journal-table'),null);
 assert.equal(f.body().querySelector('select[data-level]'),null);
 assert.equal(f.bench.panel.querySelector('.sc-search-row').hidden,true);
 const find=new f.win.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperties(find,{key:{value:'f'},ctrlKey:{value:true}});
 f.bench.panel.dispatchEvent(find);assert.equal(f.doc.activeElement,f.body().querySelector('.sc-jcr-search'));
 const categories=shippedPayload().categories.length;
 assert.match(f.body().textContent,/OpenAlex/);
 assert.doesNotMatch(f.body().textContent,/Clarivate/);
 assert.ok(f.findButton(`전체 카테고리 · ${categories}`));
 await f.click(`전체 카테고리 · ${categories}`);
 assert.equal(f.body().querySelectorAll('tr[data-category-key]').length,25);
 assert.match(f.body().querySelector('.sc-jcr-pagination').textContent,new RegExp(String(categories)));
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
 await f.click('OpenAlex 원본 열기');assert.deepEqual(f.calls.find(c=>c[0]==='sourceOpen'),['sourceOpen','https://api.openalex.org/sources']);
 f.bench.destroy();
});

test('OpenAlex is an explicit remembered alternative with a native JCR return control and preserved JCR navigation',async()=>{
 const {catalog}=capturedJCRControl(),f=fixture(undefined,undefined,{nativeJCR:true,catalog});
 await f.bench.show('journals');await f.click(`전체 카테고리 · ${shippedPayload().categories.length}`);await f.click('OpenAlex 주제로 탐색');
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
 /* A failure says so and offers the ways on. An empty table skeleton was
    tried and read as data that had come back empty, so there is none. */
 assert.equal(f.body().querySelector('.sc-jcr-skeleton'),null,'no rows of dashes under real column names');
 assert.match(f.body().querySelector('.sc-jcr-unavailable').textContent,/다른 탐색 방법/);
 assert.ok(f.findButton('OpenAlex 주제로 탐색'),'and a way on from it');
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
 await f.bench.show('journals');const stale=f.findButton('OpenAlex 원본 열기'),old=f.body().querySelector('.sc-jcr-browser');
 await f.bench.show('explore');assert.equal(old.isConnected,false);
 stale.dispatchEvent(new f.win.Event('click'));await settle();assert.equal(f.calls.some(c=>c[0]==='sourceOpen'),false);
 await f.bench.show('journals');await f.bench.render();await f.bench.render();
 assert.equal(f.doc.querySelectorAll('.sc-jcr-browser').length,1);
 await f.click('OpenAlex 원본 열기');assert.equal(f.calls.filter(c=>c[0]==='sourceOpen').length,1);
 const latest=f.findButton('OpenAlex 원본 열기');f.bench.destroy();latest.dispatchEvent(new f.win.Event('click'));await settle();
 assert.equal(f.calls.filter(c=>c[0]==='sourceOpen').length,1);
 assert.equal(f.doc.querySelectorAll('.sc-jcr-browser').length,0);
 assert.equal([...f.doc.querySelectorAll('link')].some(link=>link.getAttribute('href').endsWith('jcr-browser.css')),false);
});

test('the annotation selection row is hidden until something is selected, and merge waits for a second', async () => {
 const f = fixture();
 f.library.annotations = f.record('annotations', [
  {id: '3', text: 'First', comment: '', color: '#ffd400', type: 'highlight', pageIndex: 0, attachmentID: '9'},
  {id: '4', text: 'Second', comment: 'a memo', color: '#ff6666', type: 'underline', pageIndex: 1, attachmentID: '9'}
 ]);
 await f.bench.show('annotations');
 const tools = f.body().querySelector('.sc-annot-selection');
 // Nothing chosen: the row itself is gone, not shown with disabled verbs waiting.
 assert.equal(tools.hidden, true, 'nothing selected yet');
 f.body().querySelector('.sc-annot').dispatchEvent(new f.win.Event('click', {bubbles: true}));
 assert.equal(tools.hidden, false, 'one annotation arms the row');
 assert.equal(tools.querySelector('.sc-annot-chosen').textContent, '선택 1개');
 const merge = [...tools.querySelectorAll('button')].find(b => b.textContent === '선택 주석 병합');
 // From one: count, colour change, 노트로, 선택 해제 -- merge is not offered yet.
 assert.equal(merge.hidden, true, 'merging one annotation is not a merge');
 assert.ok([...tools.querySelectorAll('button')].filter(b => b !== merge).every(b => !b.hidden), 'the other verbs are ready from one');
 f.body().querySelectorAll('.sc-annot')[1].dispatchEvent(new f.win.Event('click', {bubbles: true}));
 assert.equal(merge.hidden, false, 'the second one offers merge');
 // The memo that exists is drawn; the one that does not is a button away.
 assert.equal(f.body().querySelectorAll('.sc-annot .sc-annot-memo').length, 1, 'one memo written, one memo drawn');
 f.bench.destroy();
});

test('merge stays hidden by feature gate even once a second annotation is chosen, and the merge restriction reads as the button’s title, not a standing paragraph', async () => {
 const f = fixture(), disabled = new Set(['reader.mergeAnnotations']);
 f.runtime.featureEnabled = id => !disabled.has(id);
 f.library.annotations = f.record('annotations', [
  {id: '3', text: 'First', comment: '', color: '#ffd400', type: 'highlight', pageIndex: 0, attachmentID: '9'},
  {id: '4', text: 'Second', comment: '', color: '#ffd400', type: 'highlight', pageIndex: 1, attachmentID: '9'}
 ]);
 await f.bench.show('annotations');
 await f.click('보이는 주석 전체 선택');
 const merge = f.findButton('선택 주석 병합');
 assert.equal(merge.hidden, true, 'the reader feature being off still wins over having two selected');
 assert.match(merge.getAttribute('title'), /병합은 같은 PDF/);
 assert.equal(f.body().querySelectorAll('.sc-muted').length ? [...f.body().querySelectorAll('.sc-muted')].some(p => /병합은 같은 PDF/.test(p.textContent)) : false, false, 'the restriction is no longer a standing paragraph under the list');
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

test('the panel search names what it searches and puts the typed title first',async()=>{
 const f=fixture();f.papers.splice(0);
 for(let n=1;n<=3;n++){f.papers.push({id:String(n),title:'Notes about base editing '+n,itemType:'journalArticle',tags:[]});f.refs.set(n,{id:n});}
 f.papers.push({id:'9',title:'Base editing',itemType:'journalArticle',tags:[]});
 await f.bench.show('explore');
 assert.equal(f.bench.panel.querySelector('[aria-label="작업 패널 검색"]').getAttribute('placeholder'),'제목·저자·태그·DOI·초록·내 메모 검색',
  'the box no longer promises less than it does');
 f.input('작업 패널 검색','Base editing');await settle();
 assert.deepEqual([...f.body().querySelectorAll('.sc-paper-list > article')].map(n=>n.dataset.itemId),['9','1','2','3'],
  'the paper with exactly that title leads');
 f.bench.destroy();
});

test('a year, an accent and a dash typed into the panel search all find their paper',async()=>{
 const f=fixture();
 f.papers[0].authors='Hans Müller';f.papers[1].title='protein–protein interaction';
 await f.bench.show('explore');
 const titles=()=>[...f.body().querySelectorAll('.sc-paper-list > article')].map(n=>n.dataset.itemId);
 f.input('작업 패널 검색','2024');await settle();assert.deepEqual(titles(),['2'],'a year is part of the haystack');
 f.input('작업 패널 검색','Muller');await settle();assert.deepEqual(titles(),['1'],'an unaccented query finds the accented author');
 f.input('작업 패널 검색','protein-protein');await settle();assert.deepEqual(titles(),['2'],'a hyphen finds an en dash');
 f.input('작업 패널 검색','H. Müller');await settle();assert.deepEqual(titles(),['1'],'an initial matches the given name');
 f.bench.destroy();
});

test('the note paper picker offers the exact title rather than the first twelve in library order',async()=>{
 const f=fixture();f.reader.tabs=()=>[];f.papers.splice(0);
 for(let n=1;n<=20;n++){f.papers.push({id:String(n),title:'Base editing review '+n,itemType:'journalArticle',tags:[]});f.refs.set(n,{id:n});}
 f.papers.push({id:'99',title:'Base editing',itemType:'journalArticle',tags:[]});f.refs.set(99,{id:99});
 await f.bench.show('notes');f.bench.state.selected=new Set();await f.bench.render();
 f.input('작업 패널 검색','Base editing');await settle();
 const picks=[...f.body().querySelectorAll('[data-pick]')].map(b=>b.dataset.pick);
 assert.equal(picks.length,12,'twelve are still offered');
 assert.equal(picks[0],'99','and the one with exactly that title is among them');
 f.bench.destroy();
});

test('the collections header counts how many hold something read in the last 14 days',async()=>{
 const f=fixture();
 const recent=new Date(Date.now()-3*864e5).toISOString();
 const old=new Date(Date.now()-40*864e5).toISOString();
 f.runtime.state=ref=>({citations:3,impactFactor:4,status:'done',lastRead:ref.id===1?recent:old});
 f.library.collections=async()=>[{id:'4',name:'Live',count:1,itemIDs:[1],parentID:null},{id:'6',name:'Shelved',count:1,itemIDs:[2],parentID:null}];
 await f.bench.show('collections');
 // The sentence became a stat-tile row (user direction 2026-10-03): the figure and its label are tiles, the full sentence is the row's accessible name.
 assert.match(f.body().querySelector('.sc-overview-facts').getAttribute('aria-label'),/최근 14일에 읽은 컬렉션 1개/,'only Live, holding the recently-read paper');
 assert.equal([...f.body().querySelectorAll('.sc-overview-fact')].find(t=>/최근 14일 읽음/.test(t.textContent)).querySelector('b').textContent,'1');
 f.bench.destroy();
});

test('note and attachment searches take the same words in either order',async()=>{
 const f=fixture();
 await f.bench.show('notes');
 f.input('작업 패널 검색','note Rich');await settle();
 assert.match(f.body().textContent,/Rich note/,'the note list is tokenised like the paper list');
 await f.bench.show('attachments');
 f.input('작업 패널 검색','two PDF');await settle();
 assert.match(f.body().textContent,/PDF two/);
 assert.equal(f.body().textContent.includes('PDF one'),false);
 f.bench.destroy();
});

test('첨부 미리보기 groups a paper\'s files under one head, each with its own reading time, and 열기 goes to that file\'s own last page',async()=>{
 const f=fixture();
 f.library.attachments=async()=>[{id:'9',parentID:'1',title:'Full text PDF',contentType:'application/pdf'},{id:'10',parentID:'1',title:'Supplementary information',contentType:'application/pdf'}];
 f.refs.set(9,{id:9,parentID:1,libraryID:1});
 f.refs.set(10,{id:10,parentID:1,libraryID:1});
 f.runtime.formatReadTime=sec=>`${sec}s`;
 f.runtime.cache.items[1]={readingAttachments:{9:{lastRead:'2026-09-01T00:00:00Z'},10:{lastRead:'2026-08-01T00:00:00Z'}}};
 // Each file keeps its own page progress -- the supplement is not the article's tail end.
 f.runtime.pageProgress=(ref,att)=>Number(att)===10?{total:4,visited:1,percent:25,pages:{1:90},attachmentID:'10',lastPageIndex:1}
  :{total:12,visited:6,percent:50,pages:{0:140,1:520,2:80,3:100,5:370,6:30},attachmentID:'9',lastPageIndex:6};
 await f.bench.show('attachments');
 assert.equal(f.body().querySelectorAll('.sc-attachment-group').length,1,'one group for the one paper');
 const group=f.body().querySelector('.sc-attachment-group');
 assert.match(group.querySelector('.sc-attachment-group-title').textContent,/Paper Alpha/);
 const rows=[...group.querySelectorAll('.sc-attachment-row')];
 assert.equal(rows.length,2,'both PDFs under the one head');
 assert.match(rows[0].querySelector('.sc-attachment-reading').textContent,/1240s.*6\/12쪽/,'the main text\'s own time and pages');
 assert.match(rows[1].querySelector('.sc-attachment-reading').textContent,/90s.*1\/4쪽/,'the supplement\'s own time and pages');
 const openMain=[...rows[0].querySelectorAll('button')].find(b=>b.textContent==='7쪽부터 열기');// 2026-10-03: the attachment button says what it does
 const openSupp=[...rows[1].querySelectorAll('button')].find(b=>b.textContent==='2쪽부터 열기');
 assert.ok(openMain,'main text opens at its own last page, 1-based');
 assert.ok(openSupp,'the supplement opens at its own last page');
 openMain.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.ok(f.calls.find(c=>c[0]==='open'&&c[1]==='9'&&c[2]?.pageIndex===6));
 // Searching down to one file still shows a group, just with one row.
 f.input('작업 패널 검색','Supplementary');await settle();
 assert.equal(f.body().querySelectorAll('.sc-attachment-row').length,1);
 assert.match(f.body().textContent,/Supplementary information/);
 f.bench.destroy();
});

test('첨부 미리보기 says a group cannot preview only when every file in it cannot, not when one file in the group can',async()=>{
 const f=fixture();
 // Paper 1: one file that cannot preview alongside one that can -- no sentence.
 // Paper 2: nothing in the group can preview -- the sentence, once.
 f.library.attachments=async()=>[
  {id:'9',parentID:'1',title:'Full text PDF',contentType:'application/pdf'},
  {id:'10',parentID:'1',title:'Broken link',contentType:'text/html',path:null},
  {id:'8',parentID:'2',title:'Old scan',contentType:'application/octet-stream'}
 ];
 f.refs.set(9,{id:9});f.refs.set(10,{id:10});f.refs.set(8,{id:8});
 await f.bench.show('attachments');
 const groups=[...f.body().querySelectorAll('.sc-attachment-group')];
 assert.equal(groups.length,2);
 const g1=groups.find(g=>/Paper Alpha/.test(g.querySelector('.sc-attachment-group-title').textContent));
 const g2=groups.find(g=>/Paper Beta/.test(g.querySelector('.sc-attachment-group-title').textContent));
 // The sentence is about a file, so it stands on that file's row -- and points at the button on the same row, never at a 「열기」 that may not exist.
 const noteRows=g=>[...g.querySelectorAll('.sc-attachment-row')].filter(r=>/미리보기를 지원하지 않는 형식입니다/.test(r.textContent));
 assert.equal(noteRows(g1).length,1,'only the broken link says it');
 assert.match(noteRows(g1)[0].textContent,/Broken link/);
 assert.equal([...g1.querySelectorAll('.sc-attachment-row')].find(r=>/Full text PDF/.test(r.textContent)).querySelector('.sc-attachment-nopreview'),null,'the previewable file says nothing');
 assert.ok(g1.querySelector('button[data-opens]')&&[...g1.querySelectorAll('button')].some(b=>b.textContent==='미리보기'));
 assert.equal(noteRows(g2).length,1,'the one file in this group that cannot be previewed');
 assert.match(noteRows(g2)[0].textContent,/같은 줄의 버튼/,'it names the button on its own row');
 assert.equal(/「열기」|열기로 확인/.test(g2.textContent),false,'no reference to a button that may not be there');
 f.bench.destroy();
});

test('a collection opens onto its papers and counts each paper once',async()=>{
 const f=fixture();
 // "1" is filed twice; Parent holds its papers only through Child.
 f.library.collections=async()=>[{id:'4',name:'Research',count:2,itemIDs:[1,2],parentID:null},{id:'6',name:'Parent',count:0,itemIDs:[],parentID:null},{id:'7',name:'Child',count:1,itemIDs:[1],parentID:'6'}];
 await f.bench.show('collections');
 assert.match(f.body().querySelector('.sc-overview-facts').getAttribute('aria-label'),/서로 다른 문헌 2편 · 빈 컬렉션 0개/);
 const parent=f.body().querySelector('.sc-collection[data-id="6"]');
 assert.match(parent.textContent,/1편/,'a parent with papers below it is not empty');
 assert.match(parent.textContent,/하위 컬렉션 1/,'and its sub-collections are said in words ("1편 · 하위 컬렉션 1", user direction 2026-10-03)');
 parent.click();await settle();
 assert.equal(f.bench.state.tab,'explore','the panel shows the papers, not the tree again');
 assert.equal(f.bench.state.scope,'collection-recursive','a parent opens with its subcollections');
 f.bench.state.scope='library';
 f.bench.destroy();
});

test('annotation, collection and watched-author searches are tokenised too',async()=>{
 const f=fixture();
 await f.bench.show('annotations');
 f.bench.state.query='Comment Highlight';await f.bench.render();
 assert.match(f.body().textContent,/Highlight/,'the annotation matches both words in either order');
 f.library.collections=async()=>[{id:'4',name:'Research notes',count:2,parentID:null},{id:'5',name:'Teaching',count:1,parentID:null}];
 f.bench.state.query='';await f.bench.show('collections');
 f.input('컬렉션 검색','notes Research');await new Promise(resolve=>setTimeout(resolve,160));await settle();
 assert.match(f.body().textContent,/Research notes/);
 assert.equal(f.body().textContent.includes('Teaching'),false);
 f.runtime.watchedAuthorsByNews=()=>[{id:'A7',name:'Sam Okafor',institution:'MIT Media Lab',seen:[],news:[]},
  {id:'A8',name:'Kim Nguyen',institution:'Yonsei',seen:[],news:[]}];
 await f.bench.show('authors');await f.click('목록 관리');
 f.input('관심 저자 찾기','Media Sam');await settle();
 const names=[...f.body().querySelectorAll('.sc-watch-table tbody tr')].map(tr=>tr.querySelector('button').textContent);
 assert.deepEqual(names,['Sam Okafor']);
 f.bench.destroy();
});

test('the panel search waits out a burst of typing and does not re-read the notes for each search',async()=>{
 const f=fixture();
 await f.bench.show('notes');
 const box=f.bench.panel.querySelector('[aria-label="작업 패널 검색"]');
 for(const value of ['R','Ri','Ric','Rich']){box.value=value;box.dispatchEvent(new f.win.Event('input',{bubbles:true}));}
 await settle();
 assert.equal(f.bench.state.query,'','a keystroke does not redraw the tab on its own');
 await new Promise(resolve=>setTimeout(resolve,260));await settle();
 assert.equal(f.bench.state.query,'Rich','the last value wins once the typing stops');
 const after=f.calls.filter(c=>c[0]==='notes').length;
 f.input('작업 패널 검색','note');await settle();
 assert.equal(f.calls.filter(c=>c[0]==='notes').length,after,'the scope notes read for this load are reused');
 await f.bench.load();await settle();
 assert.ok(f.calls.filter(c=>c[0]==='notes').length>after,'a reload reads them again');
 f.bench.destroy();
});

test('the journals tab finds a journal by a dotted abbreviation and by an ISSN written either way',async()=>{
 const f=fixture();
 f.runtime.journalIdentity={identify:()=>({abbreviation:'Nat Commun',issns:['2041-1723']})};
 for(const paper of f.papers)paper.venue='Nature Communications';
 await f.bench.show('journals');
 const names=()=>[...f.body().querySelectorAll('.sc-journal-name')].map(n=>n.textContent);
 assert.deepEqual(names(),['Nature Communications']);
 const box=f.bench.panel.querySelector('[aria-label="저널 검색"]');
 const type=async value=>{box.value=value;box.dispatchEvent(new f.win.Event('input',{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,180));await settle();};
 await type('Nat. Commun.');assert.deepEqual(names(),['Nature Communications'],'the dots come out of the query');
 await type('2041-1723');assert.deepEqual(names(),['Nature Communications']);
 await type('20411723');assert.deepEqual(names(),['Nature Communications'],'an ISSN typed without its hyphen');
 await type('no such journal');assert.deepEqual(names(),[]);
 f.bench.destroy();
});

async function pathFixture({owned = [], show} = {}) {
 const f = fixture();
 const pathTools = (await import('../src/reading-path.js')).default;
 const subjects = {topic: new Set(['T']), subfield: new Set(['S']), field: new Set(['F']), domain: new Set(['D'])};
 const w = (id, references, extra = {}) => ({id, title: 'Work ' + id, year: 2015, citations: 5, doi: '10.1/' + id, type: 'article', references, subjects, authors: [], ...extra});
 const refs = [w('A', ['X'], {year: 2008}), w('B', ['A', 'X', 'Y'], {year: 2012}), w('C', ['A', 'B', 'X', 'Y'], {year: 2014}),
  w('D', ['A', 'B', 'X', 'Y'], {year: 2015}), w('E', ['A', 'B', 'X', 'Y'], {year: 2016}), w('X', [], {year: 2000}), w('Y', [], {year: 2001})];
 const seed = w('S', ['A', 'B', 'C', 'D', 'E', 'X', 'Y'], {year: 2022});
 const plan = pathTools.plan(seed, {
  refs, citers: [w('L', ['S', 'A', 'B', 'C', 'X'], {year: 2024}), w('M', ['S', 'A', 'B', 'D', 'X'], {year: 2025})]
 }, {show});
 /* The view is what is under test here; which works deserve to be on the line
    is settled in the reading-path tests, against a lineage large enough to
    have one. */
 plan.milestones = {span: 6, bar: 4, seedYear: 2022, line: [
  {id: 'X', title: 'Work X', year: 2000, citations: 400, venue: 'Journal', doi: '10.1/x', support: 9, cited: true},
  {id: 'A', title: 'Work A', year: 2008, citations: 300, venue: 'Journal', doi: '10.1/a', support: 7, cited: true,
   inLibrary: owned.includes('A')},
  {id: 'C', title: 'Work C', year: 2014, citations: 200, venue: 'Journal', doi: '10.1/c', support: 5}]};
 f.runtime.pathTools = pathTools;
 f.runtime.libraryDOIs = () => new Set(owned.map(id => '10.1/' + id.toLowerCase()));
 f.runtime.readingPathCached = async (ref, {onProgress} = {}) => { f.calls.push(['path']); onProgress?.(1, 3); return plan; };
 return {...f, plan};
}

test('the related tab opens on the short reading path: a handful of numbered steps, one start, the rest one click away', async () => {
 const f = await pathFixture();
 try {
  await f.bench.show('related');
  assert.ok(f.calls.find(c => c[0] === 'path'), 'the reading order is looked up on open');
  assert.ok(!f.calls.find(c => c[0] === 'related'), 'the flat list is not fetched until asked for');
  const rows = [...f.body().querySelectorAll('.sc-path-row[data-step]')];
  const numbers = rows.map(r => r.dataset.step);
  assert.deepEqual(numbers, numbers.map((_, i) => String(i + 1)), 'numbers run over what is on screen');
  assert.ok(rows.length <= 7, 'the short path is short: ' + rows.length);
  assert.equal(f.body().querySelectorAll('.sc-path-start').length, 1, 'exactly one place to start');
  const seed = f.body().querySelector('.sc-path-seed');
  assert.ok(seed && !seed.dataset.step, 'the paper itself is the reference point, not a numbered step');
  assert.equal(f.body().querySelectorAll('.sc-path-more').length, 0, 'no per-section tails in the short path');
  const toggle = [...f.body().querySelectorAll('.sc-path-depth')][0];
  assert.match(toggle.textContent, /전체 순서 보기 · \d+편 더/);
  await f.click(toggle.textContent);
  assert.ok(f.body().querySelectorAll('.sc-path-row[data-step]').length > rows.length, 'the full path shows more');
  assert.ok(f.body().querySelector('.sc-path-depth').textContent.includes('짧게 보기'));
  await f.click('전체 목록');
  assert.ok(f.calls.find(c => c[0] === 'related'), 'the list view still has its own lookup');
  assert.equal(f.body().querySelectorAll('.sc-path-row').length, 0);
 } finally { f.bench.destroy(); }
});

test('a paper already read reads as one "완료" line, is not numbered, and does not use up its section', async () => {
 const f = await pathFixture({owned: ['A', 'X']});
 const base = f.library.snapshot;
 f.library.snapshot = async () => [...await base(), {...f.papers[0], id: '50', key: 'K50', doi: '10.1/a', status: 'done'}, {...f.papers[0], id: '51', key: 'K51', doi: '10.1/x', status: 'done'}];
 try {
  await f.bench.load?.();
  await f.bench.show('related');
  const ownedRows = [...f.body().querySelectorAll('.sc-path-owned')];
  assert.ok(ownedRows.length >= 1, 'owned works are shown as owned');
  for (const row of ownedRows) {
   assert.equal(row.dataset.step, undefined);
   assert.equal(row.querySelector('.sc-path-step').textContent, '완료');
   assert.equal(row.querySelector('.sc-path-finding'), null, 'one line, no finding, no reasons');
  }
  // One start, marked either on a row to fetch or on an owned line -- an owned
  // start is the cheapest one, as there is nothing to fetch.
  // Both kinds of line now carry the same chip (an owned line used to say it in plain text).
  const marked = f.body().querySelectorAll('.sc-path-start').length;
  assert.equal(marked, 1);
  for (const row of ownedRows) assert.ok(!row.querySelector('.sc-path-why'), 'an owned line carries no reasons');
  const foundation = [...f.body().querySelectorAll('.sc-path-head')].find(h => h.textContent.startsWith('기초'));
  assert.ok(foundation, 'the foundation section is there');
 } finally { f.bench.destroy(); }
});

test('a paper saved but not read keeps its number and its reasons, and says how far it has gone', async () => {
 const f = await pathFixture({owned: ['A']});
 const base = f.library.snapshot;
 f.library.snapshot = async () => [...await base(), {...f.papers[0], id: '50', key: 'K50', doi: '10.1/a', status: 'reading', seconds: 1240}];
 try {
  await f.bench.load?.();
  await f.bench.show('related');
  const row = f.body().querySelector('[data-work="A"]');
  assert.ok(row, 'the owned paper is on the path');
  assert.ok(row.dataset.step, 'with a number, as a paper still to read');
  // Said once, in the row's own 보유, not again on a line of its own.
  assert.match(row.querySelector('.sc-hit-owned')?.textContent || '', /보유 · 읽는 중/);
  assert.equal(row.querySelectorAll('.sc-hit-owned').length, 1);
  assert.equal(row.querySelector('.sc-path-local'), null);
  assert.equal(row.classList.contains('sc-path-owned'), false, 'not folded away');
 } finally { f.bench.destroy(); }
});

test('a "read first" link names the step by its number on screen and moves focus to it', async () => {
 const f = await pathFixture();
 try {
  await f.bench.show('related');
  await f.click(f.body().querySelector('.sc-path-depth').textContent);
  const link = f.body().querySelector('.sc-path-jump');
  if (link) {
   const n = link.textContent.replace('번', '');
   assert.ok(f.body().querySelector(`[data-step="${n}"]`), 'the step it names is on screen');
  }
 } finally { f.bench.destroy(); }
});

test('a reading-order lookup that fails after the user has moved on stays silent', async () => {
 const f = fixture();
 let reject;
 f.runtime.pathTools = (await import('../src/reading-path.js')).default;
 f.runtime.readingPathCached = () => new Promise((_, no) => { reject = no; });
 try {
  await f.bench.show('related');
  await f.bench.show('explore');
  reject(Object.assign(new Error('OpenAlex 오늘 한도를 다 썼습니다'), {status: 429}));
  await settle();
  assert.notEqual(f.bench.panel.querySelector('.sc-status').dataset.error, 'true', 'the explore tab is not told about it');
 } finally { f.bench.destroy(); }
});

test('the line of development runs down the years and ends at the paper on screen', async () => {
 const f = await pathFixture({owned: ['A']});
 try {
  await f.bench.show('related');
  await f.click('발전 과정');
  const rows = [...f.body().querySelectorAll('.sc-line-row')];
  assert.ok(rows.length >= 2, 'a line, not a single step');
  const years = rows.map(row => Number(row.querySelector('.sc-line-year').textContent));
  assert.deepEqual(years, [...years].sort((a, b) => a - b), 'it reads forwards in time');
  // The paper the reader has open closes the line, and is not offered for fetching.
  const last = rows[rows.length - 1];
  assert.ok(last.classList.contains('sc-line-seed'));
  assert.equal(last.querySelector('.sc-hit-actions'), null);
  assert.equal(Number(last.querySelector('.sc-line-year').textContent), 2022);
  // Every earlier step says how much of the lineage leans on it.
  for (const row of rows.slice(0, -1)) assert.match(row.querySelector('.sc-path-why').textContent, /참고문헌 \d+편이 인용/);
  // A step already on the shelf says so rather than offering to fetch it.
  const ownedRow = rows.find(row => row.querySelector('.sc-line-owned'));
  if (ownedRow) assert.equal(ownedRow.querySelector('.sc-hit-actions'), null);
  // One not on the shelf can be taken in from the line itself.
  const imported = [];
  f.runtime.importWork = async work => { imported.push(work.doi); return []; };
  const missing = rows.find(row => !row.querySelector('.sc-line-owned') && !row.classList.contains('sc-line-seed'));
  const add = [...missing.querySelectorAll('button')].find(b => b.textContent === '추가');
  assert.ok(add, 'a milestone the reader lacks offers 추가');
  add.click(); await settle();
  assert.equal(imported.length, 1);
  assert.ok(missing.querySelector('.sc-line-owned'), 'and then says it is owned');
  // And the choice is remembered.
  assert.equal(f.bench.state.relatedView, 'line');
  await f.click('읽기 순서');
  assert.equal(f.body().querySelector('.sc-line'), null);
 } finally { f.bench.destroy(); }
});

test('a paper whose references share no lineage says so instead of drawing a history', async () => {
 const f = await pathFixture();
 try {
  f.runtime.readingPathCached = async () => ({...f.plan, milestones: null});
  await f.bench.show('related');
  await f.click('발전 과정');
  assert.ok(f.body().querySelector('.sc-empty'), 'an empty state, not an empty list');
  assert.equal(f.body().querySelector('.sc-line'), null);
  assert.ok(f.findButton('읽기 순서 보기'), 'and a way on from it');
 } finally { f.bench.destroy(); }
});

test('the watchlist shows a face for each person and finds the missing ones in one press', async () => {
 const f=fixture();
 const rows=[{id:'A1',name:'Christopher A. Voigt',institution:'MIT',seen:[]},{id:'A2',name:'George M. Church',institution:'Harvard',seen:[]}];
 const faces=new Map([['A2',{url:'https://commons.wikimedia.org/wiki/Special:FilePath/George_Church.jpg?width=160',page:'https://commons.wikimedia.org/wiki/File:George_Church.jpg'}]]);
 let searched=0;
 f.runtime.watchedAuthors=()=>rows;
 f.runtime.watchedAuthorsByNews=()=>rows;
 f.runtime.portraitOf=id=>faces.get(id)||null;
 f.runtime.findWatchedPortraits=async()=>{searched++;faces.set('A1',{url:'https://example.org/voigt.jpg',page:'https://example.org/'});return {asked:1,found:1,wikimedia:0,homepage:1,none:0,requests:3};};
 f.setSelection([]);
 try{
  await f.bench.show('authors');await f.click('조용한 저자 2명 보기');
  const card=name=>[...f.body().querySelectorAll('.sc-watch')].find(c=>c.querySelector('.sc-watch-name').textContent===name);
  // Initials until a photo is known; the photo, credited, once it is.
  assert.equal(card('Christopher A. Voigt').querySelector('.sc-watch-face .sc-face-text').textContent,'CV');
  assert.equal(card('Christopher A. Voigt').querySelector('.sc-watch-face img'),null);
  assert.match(card('George M. Church').querySelector('.sc-watch-face img').getAttribute('src'),/George_Church/);
  assert.match(card('George M. Church').querySelector('.sc-watch-face').getAttribute('title'),/commons\.wikimedia\.org/);
  // The button says how many already have one, and runs the search for all.
  await f.click('사진 다시 찾기 (1명 있음)');
  assert.equal(searched,1);
  assert.match(card('Christopher A. Voigt').querySelector('.sc-watch-face img').getAttribute('src'),/voigt/);
  assert.match(f.bench.panel.querySelector('.sc-status').textContent,/사진 2명 · 이번에 찾음 1명/);
 } finally { f.bench.destroy(); }
});

test('the annotation colour tally reads as one line by meaning, not a row of pills',async()=>{
 const f=fixture();
 f.library.annotations=async()=>[
  {id:'3',parentID:'1',attachmentID:'99',text:'a',comment:'',color:'#ffd400',type:'highlight',pageIndex:0},
  {id:'4',parentID:'1',attachmentID:'99',text:'b',comment:'',color:'#ffd400',type:'highlight',pageIndex:1},
  {id:'5',parentID:'1',attachmentID:'99',text:'c',comment:'',color:'#5fb236',type:'highlight',pageIndex:2},
  {id:'6',parentID:'1',attachmentID:'99',text:'d',comment:'',color:'',type:'highlight',pageIndex:3},
 ];
 f.refs.set(99,{id:99,parentID:1,getField:()=>'Main PDF'});
 f.runtime.cache.readerSettings={...(f.runtime.cache.readerSettings||{}),colorLabels:{'#ffd400':'핵심 결과'}};
 await f.bench.show('annotations');
 const swatches=[...f.body().querySelectorAll('.sc-annot-swatch')];
 assert.equal(swatches.length,3,'one entry per colour, plus 색 없음');
 assert.equal(swatches[0].parentElement,swatches[1].parentElement,'one line, one parent');
 // Labelled: the meaning, never the hex, with the count after it.
 assert.equal(swatches[0].querySelector('.sc-annot-meaning').textContent,'핵심 결과');
 assert.equal(swatches[0].textContent.trim(),'핵심 결과2');
 // Unlabelled but coloured: a neutral name, the hex only in the title.
 assert.equal(swatches[1].querySelector('.sc-annot-meaning').textContent,'이름 없는 색');
 assert.doesNotMatch(swatches[1].textContent,/#5fb236/i);
 assert.match(swatches[1].getAttribute('title'),/#5fb236/i);
 // No colour at all: 색 없음, still one of the parts.
 assert.equal(swatches[2].querySelector('.sc-annot-meaning').textContent,'색 없음');
 // The chips are one line of filter chips with no separator between them (2026-10-03: a dangling "·" between chips read as a stray mark).
 const parent=swatches[0].parentElement;
 const dots=[...parent.querySelectorAll('.sc-annot-dot')].map(()=>1).length;
 assert.equal(dots,3);
 assert.match(parent.textContent,/핵심 결과2\s*이름 없는 색1\s*색 없음1/);assert.doesNotMatch(parent.textContent,/핵심 결과2\s*·/);
 swatches[0].click();await settle();
 assert.equal(f.bench.state.color,'#ffd400','pressing a part filters by that colour, same as before');
 f.bench.destroy();
});

test('색 없음 filters to colourless annotations, distinct from no filter at all',async()=>{
 const f=fixture();
 f.library.annotations=f.record('annotations',[
  {id:'1',parentID:'1',attachmentID:'9',text:'has colour',comment:'',color:'#ffd400',type:'highlight',pageIndex:0},
  {id:'2',parentID:'1',attachmentID:'9',text:'no colour',comment:'',color:'',type:'highlight',pageIndex:1},
 ]);
 await f.bench.show('annotations');
 const swatchByLabel=label=>[...f.body().querySelectorAll('.sc-annot-swatch')].find(el=>el.querySelector('.sc-annot-meaning').textContent===label);
 const noColor=swatchByLabel('색 없음');
 assert.ok(noColor,'a chip for colourless annotations exists');
 assert.equal(noColor.getAttribute('aria-pressed'),'false','not pressed before any filter is chosen');
 noColor.click();await settle();
 assert.notEqual(f.bench.state.color,'','색 없음 sets its own sentinel, not the empty "no filter" value');
 const texts=[...f.body().querySelectorAll('.sc-annot-text')].map(el=>el.textContent);
 assert.deepEqual(texts,['no colour'],'only the colourless annotation is shown');
 assert.equal(swatchByLabel('색 없음').getAttribute('aria-pressed'),'true');
 // Pressing it again clears the filter back to none, not to some other colour's value.
 swatchByLabel('색 없음').click();await settle();
 assert.equal(f.bench.state.color,'');
 assert.equal(f.body().querySelectorAll('.sc-annot-text').length,2);
 f.bench.destroy();
});

test('tag rows add the summed reading time next to how much is read, and omit it when nothing is read',async()=>{
 const f=fixture();
 f.runtime.formatReadTime=sec=>`${sec}초`;
 f.library.tagTree=()=>[{name:'alpha',path:'alpha',count:1,children:[]},{name:'beta',path:'beta',count:1,children:[]}];
 f.library.snapshot=async()=>[{...f.papers[0],tags:['alpha/x']},{...f.papers[1],tags:['beta/x']}];
 f.runtime.state=ref=>({citations:3,impactFactor:4,status:ref.id===1?'done':'',seconds:ref.id===1?300:0});
 await f.bench.show('tags');
 // alpha and beta are leaves (no children), so they skip <details> and its triangle.
 const details=[...f.body().querySelectorAll('.sc-tag-tree > details, .sc-tag-tree > .sc-tag-leaf')];
 const byName=n=>details.find(d=>d.querySelector('.sc-tag-name').textContent.startsWith(n));
 const alphaText=byName('alpha').querySelector('.sc-tag-reading').textContent;
 assert.match(alphaText,/완료 1\/1/);
 assert.match(alphaText,/300초/,'the summed reading time joins the line');
 const betaText=byName('beta').querySelector('.sc-tag-reading').textContent;
 assert.doesNotMatch(betaText,/초/,'zero reading time is omitted rather than shown as 0초');
 f.bench.destroy();
});

test('중첩 태그: choosing a tag by its name lists what is carried together with it, excluding its own ancestors and descendants, and opens exactly those papers',async()=>{
 const f=fixture();
 f.runtime.formatReadTime=sec=>`${sec}s`;
 f.library.tagTree=()=>[
  {name:'topicA',path:'topicA',count:4,children:[{name:'detail',path:'topicA/detail',count:1,children:[]}]},
  {name:'shared',path:'shared',count:3,children:[]},
  {name:'other',path:'other',count:1,children:[]}
 ];
 f.library.snapshot=async()=>[
  {...f.papers[0],id:'1',key:'K1',title:'P1',tags:['topicA','shared']},
  {...f.papers[1],id:'2',key:'K2',title:'P2',tags:['topicA','shared']},
  {id:'3',key:'K3',libraryID:1,title:'P3',itemType:'journalArticle',tags:['topicA','other']},
  {id:'4',key:'K4',libraryID:1,title:'P4',itemType:'journalArticle',tags:['topicA','topicA/detail']},
  {id:'5',key:'K5',libraryID:1,title:'P5',itemType:'journalArticle',tags:['shared']}
 ];
 for(const id of [3,4,5])f.refs.set(id,{id});
 const known={1:{status:'unread',seconds:0},2:{status:'unread',seconds:120},3:{status:'done',seconds:50},4:{status:'unread',seconds:0},5:{status:'unread',seconds:0}};
 f.runtime.state=ref=>({citations:0,impactFactor:0,...known[ref.id]});
 await f.bench.show('tags');
 assert.equal(f.body().querySelector('.sc-tag-cross').hidden,true,'nothing chosen yet');
 const nameBtn=[...f.body().querySelectorAll('.sc-tag-name')].find(b=>b.textContent==='topicA 4');
 assert.ok(nameBtn,'the tag name itself is a button');
 nameBtn.click();await settle();
 const cross=f.body().querySelector('.sc-tag-cross');
 assert.equal(cross.hidden,false);
 // Choosing a tag rebuilds the tree (aria-pressed on every row can change), so re-query.
 const nameBtnAfter=[...f.body().querySelectorAll('.sc-tag-name')].find(b=>b.textContent==='topicA 4');
 assert.equal(nameBtnAfter.getAttribute('aria-pressed'),'true');
 const rowsOf=table=>[...table.querySelectorAll('tbody tr')].map(tr=>[...tr.children].map(td=>td.textContent));
 const table=cross.querySelector('.sc-tag-cross-table');
 // topicA/detail is a descendant of the chosen tag, so P4 contributes nothing here.
 assert.deepEqual(rowsOf(table),[['shared','2','2','120s'],['other','1','0','50s']]);
 const sharedCount=table.querySelectorAll('tbody tr')[0].querySelector('button');
 sharedCount.click();await settle();
 assert.equal(f.bench.state.tab,'explore');
 assert.equal(f.bench.state.scope,'selected');
 assert.deepEqual([...f.bench.state.selected].sort(),['1','2']);
 assert.match(f.bench.panel.querySelector('.sc-context-detail').textContent,/#topicA ∩ #shared/);
 f.bench.destroy();
});

test('태그: opening a parent by hand stays open across the redraw that choosing a tag by name causes',async()=>{
 const f=fixture();
 f.library.tagTree=()=>[
  {name:'topicA',path:'topicA',count:2,children:[{name:'detail',path:'topicA/detail',count:1,children:[]}]},
  {name:'shared',path:'shared',count:1,children:[]}
 ];
 f.library.snapshot=async()=>[
  {...f.papers[0],id:'1',key:'K1',title:'P1',tags:['topicA','shared']},
  {id:'4',key:'K4',libraryID:1,title:'P4',itemType:'journalArticle',tags:['topicA','topicA/detail']}
 ];
 f.refs.set(4,{id:4});
 await f.bench.show('tags');
 const findDetails=()=>[...f.body().querySelectorAll('.sc-tag-tree details')].find(d=>d.querySelector('.sc-tag-name')?.textContent==='topicA 2');
 const details=findDetails();
 assert.ok(details,'topicA has children and renders as <details>');
 details.open=true;details.dispatchEvent(new f.win.Event('toggle'));
 // Choosing a different tag by name only calls redraw(), not a full render();
 // the parent opened by hand used to collapse every time because a fresh
 // <details> was built with no memory of what the reader had opened.
 const sharedBtn=[...f.body().querySelectorAll('.sc-tag-name')].find(b=>b.textContent==='shared 1');
 sharedBtn.click();await settle();
 assert.equal(findDetails().open,true,'the parent opened by hand stays open after choosing another tag');
 f.bench.destroy();
});

test('태그: the "#a ∩ #b" origin label uses full tag paths, not just the last segment',async()=>{
 const f=fixture();
 f.library.tagTree=()=>[
  {name:'methods',path:'proj/methods',count:1,children:[]},
  {name:'thing',path:'other/thing',count:1,children:[]}
 ];
 f.library.snapshot=async()=>[
  {...f.papers[0],id:'1',key:'K1',title:'P1',tags:['proj/methods','other/thing']}
 ];
 await f.bench.show('tags');
 const nameBtn=[...f.body().querySelectorAll('.sc-tag-name')].find(b=>b.textContent==='methods 1');
 nameBtn.click();await settle();
 const countBtn=f.body().querySelector('.sc-tag-cross-table tbody tr button');
 countBtn.click();await settle();
 assert.match(f.bench.panel.querySelector('.sc-context-detail').textContent,/#proj\/methods ∩ #other\/thing/);
 f.bench.destroy();
});

test('읽기 기록 정렬 offers fewest-pages-left, with papers that have no page total sorting last',async()=>{
 const f=fixture();
 const extra={...f.papers[0],id:'3',key:'K3',title:'Paper Gamma'};
 f.refs.set(3,{id:3});
 f.library.snapshot=async()=>[...f.papers,extra];
 f.runtime.state=()=>({citations:3,impactFactor:4,status:'done'});
 f.runtime.cache.items[1]={seconds:60,lastRead:'2026-01-01T00:00:00Z'};
 f.runtime.cache.items[2]={seconds:60,lastRead:'2026-01-02T00:00:00Z'};
 f.runtime.cache.items[3]={seconds:60,lastRead:'2026-01-03T00:00:00Z'};
 // 1: 100 pages, stopped at index 89 -> 10 left. 2: 50 pages, stopped at index 44 -> 5 left. 3: no page record.
 f.runtime.pageProgress=ref=>ref.id===1?{pages:{},total:100,visited:90,percent:90,attachmentID:7,lastPageIndex:89}
  :ref.id===2?{pages:{},total:50,visited:45,percent:90,attachmentID:8,lastPageIndex:44}
  :{pages:{},total:0,visited:0,percent:0};
 await f.bench.show('reading');
 const order=f.body().querySelector('[aria-label="읽기 기록 정렬"]');
 assert.ok([...order.querySelectorAll('option')].some(o=>o.value==='pages'),'a third sort choice is offered');
 order.value='pages';order.dispatchEvent(new f.win.Event('change'));
 const titles=()=>[...f.body().querySelectorAll('.sc-reading-record .sc-resume-title')].map(c=>c.textContent);
 assert.deepEqual(titles(),['Paper Beta','Paper Alpha','Paper Gamma'],'5 left, then 10 left, then no record at all');
 f.bench.destroy();
});

test('논문 비교 offers a shared/lone reference table only for an explicit 2-6 pick, counts an unfetched reference list apart from an empty one, and favours the shelf for a title',async()=>{
 const f=fixture();
 f.papers.push({id:'3',key:'K3',libraryID:1,title:'Paper Gamma',itemType:'journalArticle',tags:[]});f.refs.set(3,{id:3});
 f.papers.push({id:'4',key:'K4',libraryID:1,title:'Paper Delta',itemType:'journalArticle',tags:[]});f.refs.set(4,{id:4});
 f.runtime.state=ref=>ref.id===4?{status:'reading',seconds:125,citations:0,impactFactor:0}:{status:'unread',seconds:0,citations:0,impactFactor:0};
 f.runtime.formatReadTime=seconds=>Math.floor(seconds/60)+'분';
 f.runtime.paperWorks=()=>({
  '1:K1':{openalex:'W1',references:['W10','W20']},
  '1:K2':{openalex:'W2',references:['W10','W30']},
  '1:K4':{openalex:'W10',references:[]}
  // Paper Gamma (1:K3) is left out on purpose: its reference list was never fetched.
 });
 await f.bench.show('matrix');
 f.bench.state.selected=new Set();await f.bench.render();
 assert.equal(f.body().querySelectorAll('.sc-reference-matrix').length,0,'nothing explicitly selected: no reference table, even with rows on screen');
 f.bench.state.selected=new Set(['1','2']);await f.bench.render();
 const fold=f.body().querySelector('.sc-compare-references details');
 assert.ok(fold,'two explicitly selected papers get the fold');
 assert.equal(fold.querySelector('summary').textContent,'공통 참고문헌 1 · 확보된 목록 중 한 편만 인용 2 · 참고목록 확보 2/2편');
 const table=fold.querySelector('.sc-reference-matrix');
 const rows=[...table.querySelectorAll('tr')].slice(1);
 assert.equal(rows.length,3,'the shared reference first, then the two cited by only one paper');
 const cells=tr=>[...tr.querySelectorAll('th,td')].map(td=>td.textContent);
 assert.deepEqual(cells(rows[0]),['Paper Delta','✓','✓','읽는 중 · 2분'],'the shared reference is on the shelf, named and read by its own title');
 assert.deepEqual(cells(rows[1]),['W20','✓','','서재에 없음']);
 assert.deepEqual(cells(rows[2]),['W30','','✓','서재에 없음']);
 // Three explicitly selected: the same shared reference reads as "cited by two or
 // more", and the paper whose list was never fetched counts against 확보 rather
 // than as though it simply had none.
 f.bench.state.selected=new Set(['1','2','3']);await f.bench.render();
 assert.equal(f.body().querySelector('.sc-compare-references summary').textContent,'2편 이상에서 인용 1 · 확보된 목록 중 한 편만 인용 2 · 참고목록 확보 2/3편');
 // More than six explicitly selected: back to no table at all.
 for(let n=5;n<=8;n++){f.papers.push({id:String(n),key:'K'+n,libraryID:1,title:'Paper '+n,itemType:'journalArticle',tags:[]});f.refs.set(n,{id:n});}
 f.bench.state.selected=new Set(['1','2','3','4','5','6','7']);await f.bench.load();
 assert.equal(f.body().querySelectorAll('.sc-reference-matrix').length,0,'more than six explicitly selected: no reference table');
 f.bench.destroy();
});

test('논문 비교 참고문헌 표 shows 미확보 for a paper whose list was never fetched, keeps only the heading row sticky, and opening a title does not steal the comparison selection',async()=>{
 const f=fixture();
 f.papers.push({id:'3',key:'K3',libraryID:1,title:'Paper Gamma',itemType:'journalArticle',tags:[]});f.refs.set(3,{id:3});
 f.papers.push({id:'4',key:'K4',libraryID:1,title:'Paper Delta',itemType:'journalArticle',tags:[]});f.refs.set(4,{id:4});
 f.runtime.state=ref=>ref.id===4?{status:'reading',seconds:125,citations:0,impactFactor:0}:{status:'unread',seconds:0,citations:0,impactFactor:0};
 f.runtime.formatReadTime=seconds=>Math.floor(seconds/60)+'분';
 f.runtime.paperWorks=()=>({
  '1:K1':{openalex:'W1',references:['W10','W20']},
  '1:K2':{openalex:'W2',references:['W10','W30']},
  '1:K4':{openalex:'W10',references:[]}
  // Paper Gamma (1:K3), the third selected paper, is left out: its list was never fetched.
 });
 let opened=null;f.library.openItem=async id=>{opened=id;};
 await f.bench.show('matrix');
 f.bench.state.selected=new Set(['1','2','3']);await f.bench.render();
 const table=f.body().querySelector('.sc-reference-matrix');
 assert.ok(table.querySelector('thead'),'the column-heading row is its own thead');
 assert.equal(table.querySelectorAll('thead tr').length,1);
 const bodyRows=[...table.querySelectorAll('tbody tr')];
 assert.equal(bodyRows.length,3,'the shared reference, then the two cited by only one of the fetched lists');
 for(const tr of bodyRows)assert.equal(tr.querySelector('th[scope=row]').closest('thead'),null,'a reference row title is not part of the sticky heading row');
 // The unfetched paper cannot say "not cited" for any row, so every one of its cells says so rather than reading blank.
 const unknown=[...table.querySelectorAll('.sc-ref-unknown')];
 assert.equal(unknown.length,3);
 assert.ok(unknown.every(td=>td.textContent==='미확보'));
 // Opening a reference already on the shelf must not overwrite the comparison's own selection.
 const before=[...f.bench.state.selected].sort();
 const titleButton=[...table.querySelectorAll('.sc-link-button')].find(b=>b.textContent==='Paper Delta');
 assert.ok(titleButton,'the shared reference is on the shelf, named as a link');
 assert.equal(titleButton.getAttribute('data-opens'),'window');
 titleButton.click();await settle();
 assert.deepEqual([...f.bench.state.selected].sort(),before,'clicking the title leaves the comparison selection untouched');
 assert.equal(opened,'4','it opens in Zotero instead of pulling the panel to it');
 f.bench.destroy();
});

test('논문 비교 folds 주장·논쟁 AI 분석 into a closed details by default, its own behaviour kept working inside',async()=>{
 const f=fixture();
 await f.bench.show('matrix');
 f.bench.state.selected=new Set(['1','2']);await f.bench.render();
 const fold=f.body().querySelector('.sc-compare-insight-fold');
 assert.ok(fold,'the AI analysis sits in its own fold');
 assert.equal(fold.querySelector('summary').textContent,'주장·논쟁 AI 분석');
 assert.ok(!fold.open,'closed by default so the table is what is seen first');
 assert.ok([...fold.querySelectorAll('button')].some(b=>b.textContent==='함께 읽기'),'its own button is still reachable inside the fold');
 fold.open=true;fold.dispatchEvent(new f.win.Event('toggle'));await settle();
 await f.bench.render();
 assert.equal(f.body().querySelector('.sc-compare-insight-fold').open,true,'the open choice sticks across redraws');
 f.bench.destroy();
});

test('leaving 보유 문헌 through a row\'s 주석 n remembers the page, selection and sort, and 이전 목록으로 restores all of it',async()=>{
 const f=fixture();
 f.runtime.getSetting=key=>({explorePageSize:2,inlineEvidenceCount:5,maxExcerptLength:1200,workbenchDensity:'comfortable',matrixPageSize:50})[key];
 f.papers.splice(0);
 for(let id=1;id<=6;id++){f.papers.push({id:String(id),key:'K'+id,libraryID:1,title:'Paper '+id,itemType:'journalArticle',tags:[]});f.refs.set(id,{id});}
 f.runtime.state=ref=>({status:'unread',seconds:0,citations:ref.id,impactFactor:0});
 f.library.annotationCounts=async()=>({'4':2});
 await f.bench.show('explore');
 f.bench.state.sort='citations-desc';await f.bench.render();
 f.bench.state.selected=new Set(['2','5']);f.bench.state.pageIndex=1;await f.bench.render();
 assert.deepEqual([...f.body().querySelectorAll('[data-item-id]')].map(c=>c.dataset.itemId),['4','3'],'page 2 of six, highest citations first');
 const annotBtn=f.body().querySelector('[data-item-id="4"] .sc-row-annotations');
 assert.ok(annotBtn,'주석 n is on the row');
 annotBtn.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.equal(f.bench.state.tab,'annotations');assert.equal(f.bench.state.annotationPaperID,'4');
 const origin=f.bench.state.listOrigin;
 assert.ok(origin,'the list position was remembered on leaving 보유 문헌');
 assert.equal(origin.tab,'explore');assert.equal(origin.scope,'library');assert.equal(origin.sort,'citations-desc');
 assert.equal(origin.pageIndex,1);assert.deepEqual([...origin.selected].sort(),['2','5']);assert.equal(origin.anchorID,'4');
 const back=f.findButton('이전 목록으로');
 assert.ok(back,'the way back is offered, even though scope itself never left 라이브러리');
 back.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.equal(f.bench.state.tab,'explore');
 assert.equal(f.bench.state.pageIndex,1,'the same page');
 assert.deepEqual([...f.bench.state.selected].sort(),['2','5'],'the same selection');
 assert.equal(f.bench.state.sort,'citations-desc','the same sort');
 assert.deepEqual([...f.body().querySelectorAll('[data-item-id]')].map(c=>c.dataset.itemId),['4','3'],'back on the same page of rows');
 assert.equal(f.bench.state.listOrigin,null,'consumed once used');
 assert.equal(f.doc.activeElement.dataset.itemId,'4','the same card is focused');
 f.bench.destroy();
});

test('opening a paper from the list overview while still on 보유 문헌 keeps the page it came from, not page 1',async()=>{
 // paperList sets its own pageKey from [tab, scope, items]; a detour that
 // stays on 보유 문헌 but narrows the scope to one paper runs paperList again
 // with a different key, so 이전 목록으로 has to restore pageKey along with
 // pageIndex or the very next paperList call sees a "new" key and zeros the page.
 const f=fixture();
 f.runtime.getSetting=key=>({explorePageSize:2,inlineEvidenceCount:5,maxExcerptLength:1200,workbenchDensity:'comfortable'})[key];
 f.papers.splice(0);
 for(let id=1;id<=6;id++){f.papers.push({id:String(id),key:'K'+id,libraryID:1,title:'Paper '+id,itemType:'journalArticle',tags:[],year:2020});f.refs.set(id,{id});}
 f.runtime.state=ref=>({status:'unread',seconds:0,citations:ref.id,impactFactor:0});
 await f.bench.show('explore');
 f.bench.state.sort='citations-desc';await f.bench.render();
 f.bench.state.pageIndex=1;await f.bench.render();
 assert.deepEqual([...f.body().querySelectorAll('[data-item-id]')].map(c=>c.dataset.itemId),['4','3'],'page 2 of six, highest citations first');
 // 먼저 읽을 만한: with every paper's year equal, the rate ordering is just citations
 // descending, so the top pick is Paper 6 -- not on this page.
 const pick=f.body().querySelector('.sc-overview-pick .sc-hit-title-link');
 assert.ok(pick,'the list overview offers a pick to open');
 assert.equal(pick.textContent,'Paper 6');
 pick.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.equal(f.bench.state.tab,'explore','the detour never left 보유 문헌');
 assert.equal(f.bench.state.scope,'selected');
 assert.deepEqual([...f.bench.state.selected],['6']);
 assert.ok(f.bench.state.listOrigin,'the origin page was remembered');
 const backBtn=f.bench.panel.querySelector('.sc-scope-back');
 assert.ok(backBtn,'선택한 문헌 scope offers a way back');
 assert.equal(backBtn.textContent,'이전 목록으로');
 backBtn.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.equal(f.bench.state.scope,'library');
 assert.equal(f.bench.state.pageIndex,1,'the second page, not reset to the first by the detour’s different item set');
 assert.deepEqual([...f.body().querySelectorAll('[data-item-id]')].map(c=>c.dataset.itemId),['4','3'],'back on the same page of rows');
 f.bench.destroy();
});

test('the selection bar\'s 노트 task also remembers 보유 문헌, and the scope-back spot offers the fuller 이전 목록으로',async()=>{
 const f=fixture();
 f.runtime.getSetting=key=>({explorePageSize:2,inlineEvidenceCount:5,maxExcerptLength:1200,workbenchDensity:'comfortable',matrixPageSize:50})[key];
 f.papers.splice(0);
 for(let id=1;id<=6;id++){f.papers.push({id:String(id),key:'K'+id,libraryID:1,title:'Paper '+id,itemType:'journalArticle',tags:[]});f.refs.set(id,{id});}
 f.runtime.state=()=>({status:'unread',seconds:0,citations:0,impactFactor:0});
 await f.bench.show('explore');
 f.bench.state.selected=new Set(['4']);f.bench.state.pageIndex=1;await f.bench.render();
 assert.deepEqual([...f.body().querySelectorAll('[data-item-id]')].map(c=>c.dataset.itemId),['3','4']);
 const goNotes=[...f.bench.panel.querySelectorAll('.sc-selection-tasks button')].find(b=>b.textContent==='노트');
 assert.ok(goNotes,'the selection bar\'s 노트 task');
 goNotes.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.equal(f.bench.state.tab,'notes');assert.equal(f.bench.state.scope,'selected');
 const back=f.bench.panel.querySelector('.sc-scope-back');
 assert.ok(back,'the scope-back spot is there once scope is 선택한 문헌');
 assert.equal(back.textContent,'이전 목록으로','it offers the full restore rather than only 전체 목록으로');
 back.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.equal(f.bench.state.tab,'explore');assert.equal(f.bench.state.scope,'library');
 assert.equal(f.bench.state.pageIndex,1);assert.deepEqual([...f.bench.state.selected],['4']);
 f.bench.destroy();
});

test('the watch table also says when a followed author was last read, and can sort by it',async()=>{
 const f=fixture();
 const now=Date.now(),day=864e5;
 // Paper Alpha and Paper Beta (both id 1/2) are Ada Lovelace's, per the fixture; Nobody Here matches nothing.
 const lastRead={1:new Date(now).toISOString(),2:new Date(now-5*day).toISOString()};
 f.runtime.state=ref=>({citations:3,impactFactor:4,status:'done',lastRead:lastRead[ref.id]});
 f.runtime.watchedAuthorsByNews=()=>[{id:'A1',name:'Ada Lovelace',seen:[],news:[]},{id:'A9',name:'Nobody Here',seen:[],news:[]}];
 await f.bench.show('authors');
 await f.click('목록 관리');
 const row=name=>[...f.body().querySelectorAll('.sc-watch-table tbody tr')].find(tr=>tr.querySelector('button').textContent===name);
 const cell=name=>row(name).querySelector('td.sc-col-reading').textContent;
 assert.match(cell('Ada Lovelace'),/ · 오늘 읽음$/,'the more recent of her two papers sets the calendar day');
 assert.equal(cell('Nobody Here'),'—','never matched, so never read');
 const sort=f.body().querySelector('select[aria-label="관심 저자 정렬"]');
 const order=()=>[...f.body().querySelectorAll('.sc-watch-table tbody tr td:first-child button')].map(b=>b.textContent);
 sort.value='recent';sort.dispatchEvent(new f.win.Event('change',{bubbles:true}));
 assert.deepEqual(order(),['Ada Lovelace','Nobody Here'],'최근 읽은 순 puts the one read today first');
 f.bench.destroy();
});

test('collection rows also add the summed reading time of their papers, and omit it when there is none',async()=>{
 const f=fixture();
 const now=Date.now(),day=864e5;
 const known={1:{status:'done',seconds:4800,lastRead:new Date(now-3*day).toISOString()},2:{status:''}};
 f.runtime.state=ref=>({citations:3,impactFactor:4,...known[ref.id]});
 f.runtime.formatReadTime=sec=>{const h=Math.floor(sec/3600),m=Math.round((sec%3600)/60);return [h&&`${h}h`,m&&`${m}m`].filter(Boolean).join(' ');};
 f.library.collections=async()=>[{id:'4',name:'Research',count:2,itemIDs:[1,2],parentID:null}];
 await f.bench.show('collections');
 assert.equal(f.body().querySelector('.sc-collection-mixtext').textContent,'완료 1 · 안 읽음 1 · 1h 20m · 3일 전 읽음');
 // No time anywhere in the collection: the fragment is left out rather than shown as 0m.
 f.runtime.state=ref=>({citations:3,impactFactor:4,status:ref.id===1?'done':''});
 await f.bench.load();await f.bench.show('collections');
 assert.equal(f.body().querySelector('.sc-collection-mixtext').textContent,'완료 1 · 안 읽음 1');
 f.bench.destroy();
});

test('보유 문헌 요약 offers a fact button onto papers waiting to be read in this library',async()=>{
 const f=fixture();
 const known={1:{status:''},2:{status:'done'}};
 f.runtime.state=ref=>({citations:3,impactFactor:4,...known[ref.id]});
 f.runtime.cache.workbenchUI={...(f.runtime.cache.workbenchUI||{}),readingQueue:{'1:1':{at:new Date().toISOString()}}};
 await f.bench.show('explore');
 const facts=f.body().querySelector('.sc-overview-facts');
 assert.ok([...facts.querySelectorAll('button')].some(b=>b.textContent==='읽기 대기 1편'),'names the one paper waiting');
 await f.click('읽기 대기 1편');
 assert.equal(f.bench.state.tab,'reading','moved to 읽기 진행');
 assert.ok(f.body().querySelector('.sc-reading-queue'),'lands where the queue itself is drawn');
 f.bench.destroy();
});

test('읽기 대기 n편 counts the whole library even under a search, and the jump lands on exactly those papers',async()=>{
 const f=fixture();
 const known={1:{status:''},2:{status:''}};
 f.runtime.state=ref=>({citations:3,impactFactor:4,...known[ref.id]});
 f.runtime.cache.workbenchUI={...(f.runtime.cache.workbenchUI||{}),readingQueue:{
  '1:1':{at:new Date(Date.now()-2000).toISOString()},'1:2':{at:new Date().toISOString()}}};
 await f.bench.show('explore');
 // A search that only lets Paper Alpha through -- the queue's own section
 // would show one paper under this search, but the count on this summary is
 // whole-library and used to send the reader to a page missing the other one.
 f.input('작업 패널 검색','Alpha');
 await f.bench.render();
 const facts=f.body().querySelector('.sc-overview-facts');
 assert.ok([...facts.querySelectorAll('button')].some(b=>b.textContent==='읽기 대기 2편'),
  'both waiting papers are counted, not just the one the search lets through');
 await f.click('읽기 대기 2편');
 assert.equal(f.bench.state.tab,'reading');
 assert.equal(f.body().querySelectorAll('.sc-reading-queue-row').length,2,
  'the jump clears the conflicting search so the destination shows every paper just counted');
 f.bench.destroy();
});

test('마지막 위치 뒤 쪽 적은 순 reads the chosen file\'s position, and a paper with no recorded last position sorts last rather than by its visited count',async()=>{
 const f=fixture();
 const extra={...f.papers[0],id:'10',key:'K10',title:'Paper Gamma'};
 f.refs.set(10,{id:10,libraryID:1,key:'K10'});
 f.library.snapshot=async()=>[...f.papers,extra];
 // Alpha has two files: 100 (nearly finished, 1 page left) is the default,
 // 200 (mostly unread, 8 pages left) is the alternative the chooser can pick.
 f.runtime.cache.items[1]={seconds:10,readingAttachments:{
  100:{lastRead:'2026-09-01T00:00:00Z'},200:{lastRead:'2026-08-01T00:00:00Z'}}};
 f.runtime.pageProgress=(ref,att)=>{
  if(String(ref.id)==='1'){
   if(Number(att)===200)return {pages:{},total:10,visited:2,percent:20,attachmentID:'200',lastPageIndex:1};
   return {pages:{},total:10,visited:9,percent:90,attachmentID:'100',lastPageIndex:8};
  }
  // Beta: a valid last position with 6 pages left.
  if(String(ref.id)==='2')return {pages:{},total:10,visited:4,percent:40,attachmentID:'50',lastPageIndex:3};
  // Gamma: no recorded last position at all, despite having visited 9 of 10 --
  // the old code fell back to total-visited (=1) and floated it to the front.
  return {pages:{},total:10,visited:9,percent:90,attachmentID:'60'};
 };
 await f.bench.show('reading');
 const sortSelect=f.body().querySelector('[aria-label="읽기 기록 정렬"]');
 sortSelect.value='pages';sortSelect.dispatchEvent(new f.win.Event('change'));await settle();
 const titlesOf=()=>[...f.body().querySelectorAll('.sc-reading-records .sc-resume-title')].map(n=>n.textContent);
 // Alpha's default file (1 page left) first, Beta (6 left) next, Gamma last
 // despite its high visited count -- it has nothing pagesLeftOf can trust.
 assert.deepEqual(titlesOf(),['Paper Alpha','Paper Beta','Paper Gamma']);
 // Switching Alpha to its other file changes what asResume() resolves for it
 // (8 pages left there), and the order follows that file, not the old one.
 const chooser=f.body().querySelector('[aria-label="Paper Alpha 읽은 파일"]');
 chooser.value='200';chooser.dispatchEvent(new f.win.Event('change'));await settle();
 assert.deepEqual(titlesOf(),['Paper Beta','Paper Alpha','Paper Gamma']);
 f.bench.destroy();
});

test('노트 탭의 "이 문헌 주석에서 노트 만들기"는 고른 문헌의 주석으로 노트를 만들고, 주석이 없으면 아무것도 만들지 않는다',async()=>{
 const f=fixture();
 f.setSelection([1]);
 await f.bench.show('notes');f.bench.state.selected=new Set(['1']);await f.bench.render();
 await f.click('이 문헌 주석에서 노트 만들기');
 assert.deepEqual(f.calls.find(c=>c[0]==='annotations')?.slice(1),[['1']]);
 assert.deepEqual(f.calls.find(c=>c[0]==='extract')?.slice(1),[['3']]);
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/주석 1개로 노트를 만들었습니다/);
 f.calls.length=0;
 f.library.annotations=async()=>[];
 await f.click('이 문헌 주석에서 노트 만들기');
 assert.ok(!f.calls.find(c=>c[0]==='extract'),'주석이 없으면 노트를 만들지 않는다');
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/주석이 없어 노트를 만들지 않았습니다/);
 f.bench.destroy();
});

test('이어 읽기 줄은 쪽별 기록 fold를 연 뒤(그 shared load가 끝나면) 마지막 주석 한 줄을 보여준다; 날짜가 있으면 최신 것을, 없으면 가장 높은 쪽을 쓴다',async()=>{
 const f=fixture();
 f.runtime.state=ref=>({citations:3,impactFactor:4,status:ref.id===1?'reading':''});
 f.runtime.cache.items[1]={seconds:500,lastRead:new Date().toISOString()};
 f.runtime.pageProgress=ref=>ref.id===1?{pages:{0:5,6:10},total:12,visited:2,percent:16,attachmentID:100,lastPageIndex:6}:{pages:{},total:0,visited:0,percent:0};
 f.library.annotations=async()=>[
  {id:'a',parentID:'1',attachmentID:'100',text:'early note',comment:'',pageIndex:0,pageLabel:'1'},
  {id:'b',parentID:'1',attachmentID:'100',text:'later note',comment:'later comment here, well past the eighty character mark just to be sure it still matches',pageIndex:6,pageLabel:'7',dateModified:'2026-09-20'},
  {id:'c',parentID:'1',attachmentID:'100',text:'',comment:'',pageIndex:6,pageLabel:'7',dateModified:'2026-01-01'}];
 await f.bench.show('reading');
 const row=()=>f.body().querySelector('.sc-resume-row');
 assert.ok(row(),'a row is drawn');
 assert.ok(!row().querySelector('.sc-resume-last-annotation'),'no fold opened yet: never fetched just for this line');
 // #3: one fold now (쪽별 기록), merged with what 주석이 있는 쪽 used to load separately.
 const fold=row().querySelector('.sc-resume-pages');
 fold.open=true;fold.dispatchEvent(new f.win.Event('toggle'));
 await new Promise(r=>setTimeout(r,20));
 let line=row().querySelector('.sc-resume-last-annotation');
 assert.match(line.textContent,/^지난번 마지막 주석: p\.7 · later comment here/,'the most recently modified, not the earlier mark on the same page');
 // No date field anywhere: the highest page stands in, worded differently.
 f.library.annotations=async()=>[
  {id:'a',parentID:'1',attachmentID:'100',text:'early note',comment:'',pageIndex:0,pageLabel:'1'},
  {id:'b',parentID:'1',attachmentID:'100',text:'a later page mark',comment:'',pageIndex:6,pageLabel:'7'}];
 await f.bench.show('explore');await f.bench.show('reading');
 const fold2=row().querySelector('.sc-resume-pages');
 fold2.open=true;fold2.dispatchEvent(new f.win.Event('toggle'));
 await new Promise(r=>setTimeout(r,20));
 line=row().querySelector('.sc-resume-last-annotation');
 assert.match(line.textContent,/^마지막 쪽 주석: p\.7 · a later page mark/);
 f.bench.destroy();
});

test('보유 문헌 요약의 IF·인용 중앙값은 그 기준으로 정렬하는 버튼이고, 다시 누르면 기본 순서로 돌아간다',async()=>{
 const f=fixture();
 f.library.snapshot=async()=>f.papers.map((p,i)=>({...p,impactFactor:i?4:8,citations:i?10:20}));
 await f.bench.load();await f.bench.show('explore');
 const facts=()=>f.body().querySelector('.sc-overview-facts');
 const ifFact=()=>[...facts().querySelectorAll('button')].find(b=>/IF 중앙값/.test(b.textContent));
 const citeFact=()=>[...facts().querySelectorAll('button')].find(b=>/인용 중앙값/.test(b.textContent));
 assert.equal(ifFact().getAttribute('aria-pressed'),'false');
 ifFact().click();await settle();
 assert.equal(f.bench.state.sort,'if-desc');
 assert.equal(f.bench.panel.querySelector('[aria-label="문헌 정렬"]').value,'if-desc');
 assert.equal(ifFact().getAttribute('aria-pressed'),'true');
 ifFact().click();await settle();
 assert.equal(f.bench.state.sort,'library','pressing again returns to the default order');
 assert.equal(f.bench.panel.querySelector('[aria-label="문헌 정렬"]').value,'library');
 citeFact().click();await settle();
 assert.equal(f.bench.state.sort,'citations-desc');
 assert.equal(citeFact().getAttribute('aria-pressed'),'true');
 f.bench.destroy();
});

/* 새 논문: the one view of 관련 논문 that answers about the whole shelf rather
   than one paper, so it is also the one that works with nothing selected. */
function shelfBench(f,{rows=[],seeds=2,noWork=0}={}){
 f.runtime.paperWorks=()=>({'1:K1':{openalex:'https://openalex.org/W1'},'1:K2':{openalex:'W2'}});
 f.runtime.identity=ref=>'1:'+(ref.key||'K'+ref.id);
 f.runtime.readingPathCached=async()=>null;
 const store={};
 f.runtime.freshCiterStore=()=>store;
 const asked=[];
 f.runtime.freshCitersCached=async(key,items,options)=>{
  asked.push({key,items:items.length,options});
  return {days:90,since:'2026-07-01',at:new Date().toISOString(),seeds,noWork,found:rows.length,
   requests:1,budgetGone:false,partial:false,truncated:false,rows};
 };
 return {asked,store};
}
const newWork=(id,shared,titles,extra={})=>({id,doi:'10.1/'+id,title:'New paper '+id,year:2026,
 date:'2026-09-0'+shared,venue:'A journal',citations:0,type:'article',authors:['A Author'],
 shared,cites:titles.map((_,i)=>'W'+(i+1)),citedTitles:titles,inLibrary:false,...extra});
// Two held papers is one request of up to three pages, and the button says so.
const FIND_NEW='새 논문 찾기 · OpenAlex (요청 최대 3회)';
async function onFresh(f){
 await f.bench.show('related');
 f.bench.state.selected.clear();
 f.bench.state.relatedView='fresh';
 await f.bench.render();await settle();
}

test('새 논문 opens with nothing selected, and says what it will spend before spending it',async()=>{
 const f=fixture();
 const {asked}=shelfBench(f);
 await onFresh(f);
 const text=f.body().textContent;
 assert.match(text,/새로 나온 관련 논문/,'the tab is no longer a page of instructions');
 assert.match(text,/요청 최대 3회/,'a metered lookup says its cost on the button');
 assert.equal(asked.length,0,'and nothing is spent until it is pressed');
 // The three per-paper views are still offered, saying why they cannot answer yet.
 const modes=[...f.body().querySelectorAll('.sc-segmented button')];
 assert.deepEqual(modes.map(b=>b.textContent),['읽기 순서','발전 과정','전체 목록','새 논문']);
 assert.deepEqual(modes.map(b=>!!b.disabled),[true,true,true,false]);
 assert.equal(modes[0].getAttribute('title'),'문헌을 하나 고르면 볼 수 있습니다');
 f.bench.destroy();
});

test('a new paper says how many of your own it cites, and names one so the claim can be checked',async()=>{
 const f=fixture();
 const {asked}=shelfBench(f,{rows:[
  newWork('W10',3,['Held one','Held two','Held three']),
  newWork('W11',1,['Held one'])
 ]});
 await onFresh(f);
 await f.click(FIND_NEW);await settle();
 assert.equal(asked.length,1);
 assert.equal(asked[0].options.days,90);
 assert.equal(asked[0].items,2,'the shelf it asked about is the scope, not the selection');
 const why=[...f.body().querySelectorAll('.sc-path-why')].map(p=>p.textContent);
 assert.match(why[0],/내 서재 3편 인용/);
 assert.match(why[0],/Held one/,'the claim names a paper of mine, not just a number');
 assert.match(why[1],/내 서재 1편 인용/);
 // Most of the shelf first is the whole point of the ranking.
 const titles=[...f.body().querySelectorAll('.sc-hit-title')].map(t=>t.textContent);
 assert.ok(titles.indexOf('New paper W10')<titles.indexOf('New paper W11'));
 f.bench.destroy();
});

test('a shelf that was only partly asked about never reads as "nothing new"',async()=>{
 const f=fixture();
 shelfBench(f,{rows:[],noWork:7});
 await onFresh(f);
 await f.click(FIND_NEW);await settle();
 const text=f.body().textContent;
 assert.match(text,/새 논문이 없습니다/);
 assert.match(text,/7편은 OpenAlex 기록이 없어 묻지 못했습니다/,'"never asked" is not reported as "nothing found"');
 f.bench.destroy();
});

test('a shelf with no OpenAlex records at all offers the way to fill them instead of an empty list',async()=>{
 const f=fixture();
 const {asked}=shelfBench(f);
 f.runtime.paperWorks=()=>({});
 await onFresh(f);
 assert.match(f.body().textContent,/관계 그래프 탭에서 인용 목록을 먼저 가져오세요/);
 assert.equal(asked.length,0,'nothing is asked when there is nothing to ask about');
 f.bench.destroy();
});

test("a kept answer is drawn at once, and 다시 확인 is what goes back out",async()=>{
 const f=fixture();
 const state=shelfBench(f,{rows:[newWork('W10',2,['Held one','Held two'])]});
 await onFresh(f);
 await f.click(FIND_NEW);await settle();
 // The panel names a shelf the same way twice running, so the answer it just
 // stored under that name is the one it finds on the next visit.
 state.store[state.asked[0].key]={days:90,at:new Date().toISOString(),seeds:2,noWork:0,requests:1,
  truncated:false,budgetGone:false,partial:false,rows:[newWork('W20',2,['Held one','Held two'])]};
 await f.bench.render();await settle();
 assert.match(f.body().textContent,/New paper W20/,'a day-old answer is shown without asking again');
 assert.equal(state.asked.length,1,'and asks nothing to show it');
 await f.click('다시 확인');await settle();
 assert.equal(state.asked.length,2,'다시 확인 is the way to ask again');
 assert.equal(state.asked[1].options.refresh,true);
 f.bench.destroy();
});

test('every button that reaches outside Zotero says so, so the self-check never presses it', () => {
  /* The self-check presses every button it does not recognise as unsafe, and
     `data-opens` is the contract that keeps it away from anything that puts a
     window on screen. Five buttons that open a browser or ZotPoP were relying
     on the verb blocklist alone.

     The call is read to its own closing bracket rather than for a fixed number
     of characters: a short window missed the attribute on a long handler, and
     a long one blamed a button for what the next button did. */
  const source = fs.readFileSync(new URL('../src/workbench.js', import.meta.url), 'utf8');
  const callAt = start => {
    let depth = 0, quote = '';
    for (let at = start; at < source.length; at++) {
      const ch = source[at];
      if (quote) { if (ch === '\\') at++; else if (ch === quote) quote = ''; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) return source.slice(start, at + 1);
    }
    return source.slice(start, start + 400);
  };
  const unmarked = [];
  for (const match of source.matchAll(/\bbutton\(/g)) {
    const call = callAt(match.index + 'button'.length);
    if (!/launchURL\(|ZotPoP\.openSearch\(|library\.openItem\(/.test(call)) continue;
    if (/data-opens/.test(call)) continue;
    unmarked.push(source.slice(match.index, match.index + 60).replace(/\s+/g, ' '));
  }
  assert.deepEqual(unmarked, [], 'these buttons open something and do not say so');
});

test('zooming the graph keeps its middle, instead of walking off to the top-left corner', async () => {
  /* Anchored at 0 0, two presses of 확대 left half the nodes outside the frame
     with nothing to pan back with. */
  const f = fixture();
  await f.bench.show('graph');
  await settle();
  const svg = f.body().querySelector('svg.sc-graph');
  assert.ok(svg, 'the graph is drawn');
  const [x0, y0, w0, h0] = svg.getAttribute('viewBox').split(/\s+/).map(Number);
  await f.click('확대');
  const [x1, y1, w1, h1] = svg.getAttribute('viewBox').split(/\s+/).map(Number);
  assert.ok(w1 < w0 && h1 < h0, 'it did zoom in');
  assert.ok(x1 > x0 && y1 > y0, 'and moved the frame inward rather than pinning it at the corner');
  // The same centre before and after is what keeps a node under the pointer.
  assert.equal(Math.round(x0 + w0 / 2), Math.round(x1 + w1 / 2));
  assert.equal(Math.round(y0 + h0 / 2), Math.round(y1 + h1 / 2));
  f.bench.destroy();
});

test('a paper dismissed in the inbox is dismissed on the author page too, and the news survives it', async () => {
  /* The inbox marked papers in its own per-paper store; this page counted from
     the sweep's baseline. Marking two of four above left the page still saying
     four, and its button then wiped the stored news for good. */
  const f = fixture();
  f.runtime.authorsOfCached = async () => [{id: 'A1', name: 'Only Author', institution: 'Somewhere', position: 'first'}];
  await f.bench.show('authors');
  await f.click('관심 저자로 등록');
  assert.ok(f.findButton('새 논문 1편 확인함'), 'one unread paper to begin with');
  // The inbox marks by DOI, in workbenchUI.inboxSeen, keyed per library.
  const news = (await f.runtime.authorUpdates('A1')).fresh[0];
  const key = `1:${String(news.doi).toLowerCase()}`;
  f.runtime.cache.workbenchUI = {...(f.runtime.cache.workbenchUI || {}), inboxSeen: {[key]: '2026-09-30T00:00:00Z'}};
  await f.bench.render();
  await settle();
  assert.equal(f.findButton('새 논문 1편 확인함'), undefined,
    'the page counts the same papers the inbox does');
  // And nothing was thrown away to achieve it.
  assert.equal(f.calls.some(c => c[0] === 'clearNews'), false);
  f.bench.destroy();
});

test('an inbox row says each thing once: the journal in its ink, Preprint as one chip, the followed author with their part',async()=>{
  /* The row used to carry an abbreviation badge, the journal's long name and a
     Korean chip -- bioRxiv three times -- and named nobody's part in the paper. */
  const f = fixture();
  f.runtime.journalIdentity = {identify: v => v === 'ACS Synthetic Biology' ? {impactFactor: 4.2, year: 2025} : null,
   colours: () => ({fill: '#eef', ink: '#335', edge: '#99a'})};
  f.runtime.journalMarkForVenue = () => { const m = f.bench.panel.ownerDocument.createElement('span'); m.className = 'sc-mark'; return m; };
  const people = ['Ada', 'Brent'];
  const rows = [
   {id: 'A1', name: 'Ada', seen: [], news: [
    {id: 'W1', title: 'A preprint', venue: 'bioRxiv (Cold Spring Harbor Laboratory)', date: '2026-09-01', type: 'preprint', preprint: true, people, position: 'first', citations: 7},
    {id: 'W2', title: 'A paper', venue: 'ACS Synthetic Biology', date: '2026-08-01', type: 'article', people, position: 'last', corresponding: true, citations: 31, doi: '10.1/w2'}]},
   {id: 'A2', name: 'Brent', seen: [], news: [
    {id: 'W2', title: 'A paper', venue: 'ACS Synthetic Biology', date: '2026-08-01', type: 'article', people, position: '', citations: 31, doi: '10.1/w2'}]}];
  f.runtime.watchedAuthors = () => rows;
  f.runtime.watchedAuthorsByNews = () => rows;
  await f.bench.show('authors');
  const inbox = [...f.body().querySelectorAll('.sc-author-inbox-row')];
  assert.equal(inbox.length, 2, 'a paper two followed authors share is one row');
  const [preprint, paper] = inbox;
  const pm = preprint.querySelector('.sc-hit-meta'), jm = paper.querySelector('.sc-hit-meta');
  assert.equal(pm.querySelectorAll('.sc-preprint').length, 1, 'one chip');
  assert.equal(pm.querySelector('.sc-preprint').textContent, 'Preprint', 'in English, not mixed with Korean');
  assert.equal(pm.querySelector('.sc-paper-venue').textContent, 'bioRxiv', 'the server once, shortened');
  assert.equal(pm.textContent.match(/bioRxiv/g).length, 1);
  assert.equal(jm.querySelector('.sc-preprint'), null, 'a journal paper carries no chip');
  assert.equal(jm.querySelectorAll('.sc-paper-venue').length, 1, 'the journal is named once');
  assert.equal(jm.querySelector('.sc-mark'), null, 'no abbreviation badge beside the full name');
  assert.equal(jm.querySelector('.sc-paper-venue').dataset.known, '1', 'in the journal\'s signature ink');
  assert.equal(jm.querySelector('.sc-paper-venue').style.getPropertyValue('--j-ink-l'), '#335');
  // Order: journal, date, then the figures, then the authors.
  const text = jm.textContent;
  assert.ok(text.indexOf('ACS Synthetic Biology') < text.indexOf('2026-08-01') && text.indexOf('2026-08-01') < text.indexOf('Ada'));
  assert.match(text, /IF 4\.2/);assert.match(text, /인용 31/);
  // The followed authors lead with their faces, and say what part they had.
  assert.equal(paper.querySelectorAll('.sc-inbox-faces .sc-watch-face').length, 2);
  const roles = [...jm.querySelectorAll('.sc-inbox-who')].map(w => w.textContent);
  assert.deepEqual(roles, ['Ada마지막 저자 · 교신', 'Brent']);
  assert.equal([...pm.querySelectorAll('.sc-inbox-role')].map(r => r.textContent).join(), '1저자');
  assert.equal(/프리프린트/.test(f.body().querySelector('.sc-author-inbox').textContent), false);
  f.bench.destroy();
});

test('저자 추적 order: 관심 저자 first, then 관계, then 저장된 새 논문, toolbar on top',async()=>{
  const f = fixture();
  const rows = [{id: 'A1', name: 'Ada', seen: [], news: [{id: 'W1', title: 'T', venue: 'Nature', date: '2026-09-01', doi: '10.1/x'}]}];
  f.runtime.watchedAuthors = () => rows;
  f.runtime.watchedAuthorsByNews = () => rows;
  f.runtime.graphTools = PaperGraph;
  await f.bench.show('authors');
  const heads = [...f.body().querySelectorAll('.sc-author-watch .sc-section-head-name')].map(h => h.textContent);
  assert.deepEqual(heads, ['관심 저자', '관계', '저장된 새 논문']);
  const area = f.body().querySelector('.sc-author-watch');
  assert.equal(area.firstElementChild.className.includes('sc-watch-head'), true, 'the toolbar stays on top');
  f.bench.destroy();
});

test('segmented controls centre the label and the count on one axis, pressed or not',()=>{
  const css = fs.readFileSync(new URL('../content/workbench.css', import.meta.url), 'utf8');
  const rule = css.match(/#style-custom-workbench \.sc-segmented button,\n#style-custom-workbench \.sc-annot-order button,\n#style-custom-workbench \.sc-chip-button \{([^}]*)\}/);
  assert.ok(rule, 'one rule for every segmented family');
  assert.match(rule[1], /display: inline-flex/);assert.match(rule[1], /align-items: center/);
  assert.match(css, /\.sc-segmented button \.sc-count[^{]*\{[^}]*align-self: center/);
  assert.match(css, /#style-custom-workbench \.sc-segmented button \{ margin: 0; \}/, 'Zotero\'s chrome margin stays reset');
});

const coWorks = () => {
  const mk = (id, name, news) => ({id, name, institution: 'Somewhere', seen: [], sweptAt: '2026-09-18T00:00:00Z', news});
  const shared = (id, doi, date, venue, copy) => ({id, title: 'Paper ' + id, doi, date, venue, people: ['Ada', 'Brent', 'Cleo'], ...copy});
  return [
   mk('A1', 'Ada', [shared('W1', '10.1/a', '2026-09-03', 'Nature', {position: 'first'}), shared('W4', '10.1/d', '2026-09-01', 'Science', {people: ['Ada', 'Brent']})]),
   mk('A2', 'Brent', [shared('W1', '10.1/a', '2026-09-03', 'Nature', {position: 'last', corresponding: true})]),
   mk('A3', 'Cleo', [shared('W1', '10.1/a', '2026-09-03', 'Nature', {})]),
   mk('A4', 'Dan', [{id: 'W9', title: 'Solo', doi: '10.1/s', date: '2026-08-01', venue: 'eLife', people: ['Dan']}])];
};
const graphFixture = async () => {
  const f = fixture();
  const rows = coWorks();
  f.runtime.watchedAuthors = () => rows;
  f.runtime.watchedAuthorsByNews = () => rows;
  f.runtime.graphTools = PaperGraph;
  await f.bench.show('authors');
  return f;
};
const dot = (f, id) => f.body().querySelector(`.sc-author-graph [data-author="${id}"]`);
const rowTitles = f => [...f.body().querySelectorAll('.sc-author-inbox-row .sc-hit-title')].map(t => t.textContent);

test('관계 graph: edges are co-authorship among followed authors, weighted by shared papers',async()=>{
  const f = await graphFixture();
  const lines = [...f.body().querySelectorAll('.sc-author-graph line')];
  const pair = (a, b) => lines.find(l => [l.getAttribute('data-a'), l.getAttribute('data-b')].sort().join() === [a, b].sort().join());
  assert.equal(lines.length, 3, 'Ada-Brent, Ada-Cleo, Brent-Cleo; Dan writes with no one followed');
  assert.ok(pair('A1', 'A2') && pair('A1', 'A3') && pair('A2', 'A3'));
  assert.equal(dot(f, 'A4'), null, 'an unlinked author is not drawn by default');
  // Two shared papers (W1, W4) draw thicker than one.
  assert.ok(Number(pair('A1', 'A2').getAttribute('stroke-width')) > Number(pair('A1', 'A3').getAttribute('stroke-width')));
  assert.match(pair('A1', 'A2').querySelector('title').textContent, /2편/);
  // Nodes are named, focusable buttons.
  assert.equal(dot(f, 'A1').getAttribute('role'), 'button');
  assert.equal(dot(f, 'A1').getAttribute('aria-label'), 'Ada');
  assert.equal(f.body().querySelectorAll('.sc-author-graph [tabindex="0"]').length, 1, 'one tab stop, arrows move within');
  // No label box overlaps another (labels that would collide are hidden).
  const shown = [...f.body().querySelectorAll('.sc-author-graph .sc-graph-label')].filter(l => l.getAttribute('display') !== 'none');
  assert.ok(shown.length >= 1);
  f.bench.destroy();
});

test('관계 graph: choosing an author highlights their circle, narrows the inbox to them, and clears from the chip, a second press or Escape',async()=>{
  const f = await graphFixture();
  assert.equal(rowTitles(f).length, 3, 'W1 (three authors, one row), W4 and the solo paper');
  dot(f, 'A2').dispatchEvent(new f.bench.panel.ownerDocument.defaultView.Event('click', {bubbles: true}));
  await settle();
  assert.deepEqual(rowTitles(f), ['Paper W1']);
  const chip = f.body().querySelector('.sc-focus-chip');
  assert.match(chip.textContent, /저자: Brent/);
  assert.equal(dot(f, 'A2').dataset.state, 'selected');
  assert.equal(dot(f, 'A1').dataset.state, 'near');
  assert.equal(dot(f, 'A3').dataset.state, 'near');
  const info = f.body().querySelector('.sc-author-graph-info');
  assert.equal(info.hidden, false);
  assert.match(info.textContent, /Brent/);assert.match(info.textContent, /Ada/);
  assert.match(f.body().querySelector('.sc-inbox-tools .sc-segmented button').textContent, /미확인 1/, 'the counts follow the narrowed list');
  // The chip clears it.
  chip.dispatchEvent(new f.bench.panel.ownerDocument.defaultView.Event('click', {bubbles: true}));
  await settle();
  assert.equal(rowTitles(f).length, 3);assert.equal(f.body().querySelector('.sc-focus-chip'), null);
  assert.equal(dot(f, 'A2').dataset.state, '');
  // A second press on the same node clears, and so does Escape.
  const win = f.bench.panel.ownerDocument.defaultView;
  dot(f, 'A2').dispatchEvent(new win.Event('click', {bubbles: true}));dot(f, 'A2').dispatchEvent(new win.Event('click', {bubbles: true}));
  await settle();
  assert.equal(rowTitles(f).length, 3, 'pressed again');
  dot(f, 'A1').dispatchEvent(new win.Event('click', {bubbles: true}));
  assert.equal(rowTitles(f).length, 2);
  const esc = new win.Event('keydown', {bubbles: true});esc.key = 'Escape';
  dot(f, 'A1').dispatchEvent(esc);
  await settle();
  assert.equal(rowTitles(f).length, 3, 'Escape clears');
  f.bench.destroy();
});

test('관계 graph is keyboard operable: Enter and Space choose, arrows move the one tab stop',async()=>{
  const f = await graphFixture();
  const win = f.bench.panel.ownerDocument.defaultView;
  const key = (el, k) => {const e = new win.Event('keydown', {bubbles: true});e.key = k;el.dispatchEvent(e);};
  const first = f.body().querySelector('.sc-author-graph [tabindex="0"]');
  key(first, 'Enter');
  assert.equal(first.getAttribute('aria-pressed'), 'true');
  assert.equal(rowTitles(f).length >= 1, true);
  key(first, 'Space');key(first, ' ');
  assert.equal(first.getAttribute('aria-pressed'), 'false', 'Space on a chosen node lets it go');
  key(first, ' ');
  assert.equal(first.getAttribute('aria-pressed'), 'true');
  key(first, 'ArrowRight');
  f.bench.destroy();
});

test('관계 graph with many authors shows the connected ones and the most active, and 모두 보기 shows everyone',async()=>{
  const f = fixture();
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push({id: 'P' + i, name: 'Person' + String.fromCharCode(65 + i % 26) + ' Surname' + String.fromCharCode(97 + Math.floor(i / 26)) + i, institution: 'X', seen: [], sweptAt: '2026-09-18T00:00:00Z', news: []});
  for (let i = 0; i < 10; i += 2) {
   const work = {id: 'S' + i, title: 'Shared ' + i, doi: '10.1/s' + i, date: '2026-09-01', venue: 'Nature', people: [rows[i].name, rows[i + 1].name]};
   rows[i].news.push(work);rows[i + 1].news.push(work);
  }
  f.runtime.watchedAuthors = () => rows;f.runtime.watchedAuthorsByNews = () => rows;f.runtime.graphTools = PaperGraph;
  await f.bench.show('authors');
  assert.equal(f.body().querySelectorAll('.sc-author-graph [data-author]').length, 10, 'only the linked ones, unlinked quiet authors are left out');
  assert.equal(f.body().querySelector('.sc-graph-all'), null, 'nothing hidden by the limit, so no toggle');
  f.bench.destroy();
});

test('확인함 is one store: a paper seen in 새 논문 leaves the inbox, and 되돌리기 restores both',async()=>{
 const f=fixture();
 shelfBench(f,{rows:[newWork('W10',3,['Held one']),newWork('W11',1,['Held one'])]});
 f.runtime.watchedAuthorsByNews=()=>[{id:'A1',name:'First Person',seen:[],news:[{id:'https://openalex.org/W10',title:'Inbox copy',doi:'https://doi.org/10.1/W10',date:'2026-09-01'}]}];
 await onFresh(f);
 await f.click(FIND_NEW);await settle();
 const hits=()=>[...f.body().querySelectorAll('.sc-hit .sc-hit-title')].map(t=>t.textContent);
 const tab=label=>[...f.body().querySelectorAll('.sc-inbox-tools .sc-segmented button')].find(b=>b.textContent.startsWith(label)).textContent;
 assert.equal(tab('미확인'),'미확인 2');
 await f.click('확인함');await settle();
 assert.deepEqual(hits(),['New paper W11'],'gone from 미확인 in 새 논문');
 assert.equal(tab('확인함'),'확인함 1');
 assert.ok(f.runtime.cache.workbenchUI.inboxSeen['10.1/w10']!=null,'keyed by the work alone (DOI), not by library');
 await f.bench.show('authors');
 assert.equal(f.body().querySelectorAll('.sc-author-inbox-row').length,0,'and from the inbox');
 await f.click('확인함 1');
 assert.equal(f.body().querySelectorAll('.sc-author-inbox-row').length,1);
 await f.click('되돌리기');
 assert.equal(f.body().querySelectorAll('.sc-author-inbox-row').length,0,'restored, so out of 확인함');
 await onFresh(f);await f.click(FIND_NEW);await settle();
 assert.deepEqual(hits(),['New paper W10','New paper W11'],'back in 새 논문 too');
 f.bench.destroy();
});

test('the inboxes are worked from the keyboard: arrows and j/k move, e marks 확인함 and moves on, typing is left alone',async()=>{
 const f=fixture();
 shelfBench(f,{rows:[newWork('W10',3,['Held one']),newWork('W11',1,['Held one']),newWork('W12',1,['Held one'])]});
 f.runtime.watchedAuthorsByNews=()=>[];
 await onFresh(f);await f.click(FIND_NEW);await settle();
 const key=(el,k)=>{const e=new f.win.Event('keydown',{bubbles:true,cancelable:true});e.key=k;el.dispatchEvent(e);return e;};
 const rows=()=>[...f.body().querySelectorAll('.sc-hits .sc-hit')];
 assert.match(f.body().querySelector('.sc-inbox-hint').textContent,/e 확인함/);
 const first=rows()[0].querySelector('.sc-hit-title-link,button');first.focus();
 key(first,'ArrowDown');assert.ok(rows()[1].contains(f.win.document.activeElement),'down');
 key(f.win.document.activeElement,'k');assert.ok(rows()[0].contains(f.win.document.activeElement),'k goes back up');
 const typed=f.win.document.createElement('input');rows()[0].appendChild(typed);key(typed,'e');
 assert.equal(rows().length,3,'nothing marked yet');
 key(f.win.document.activeElement,'e');await settle();
 assert.equal(rows().length,2,'e marked the focused row 확인함');
 assert.ok(rows()[0].contains(f.win.document.activeElement),'and the focus moved on to the next row');
 f.bench.destroy();
});

test('a day-old stored answer still renders, with its date, and the reason line survives 추가',async()=>{
 const f=fixture();
 const {asked}=shelfBench(f,{rows:[]});
 const old=new Date(Date.now()-25*3600e3).toISOString();
 f.runtime.freshCiterStore=()=>new Proxy({}, {get:(_,k)=>typeof k==='string'?{days:90,at:old,seeds:2,noWork:0,rows:[newWork('W10',3,['Held one'])]}:undefined});
 await onFresh(f);
 assert.equal(asked.length,0,'nothing is asked again on its own');
 assert.match(f.body().textContent,/1일 전 확인/);
 assert.doesNotMatch(f.body().textContent,/새 논문 찾기 · OpenAlex/);
 assert.match(f.body().querySelector('.sc-path-why').textContent,/내 서재 3편 인용/);
 await f.click('추가');await settle();
 const row=f.body().querySelector('.sc-hit');
 assert.ok(f.calls.find(c=>c[0]==='importWork'));
 assert.ok(row.querySelector('.sc-hit-owned'),'redrawn as owned');
 assert.match(row.querySelector('.sc-path-why')?.textContent||'',/내 서재 3편 인용/,'the reason line is kept');
 assert.equal(row.querySelectorAll('.sc-path-why').length,1);
 f.bench.destroy();
});

test('R18 clearing a record search resets the header count to the plain list',async()=>{
 const f=fixture();
 await f.bench.show('explore');
 f.bench.state.exploreCount=1;
 await f.bench.render();
 assert.equal(f.bench.state.exploreCount,null,'no stale merged count survives a render without a record search');
 f.bench.destroy();
});

test('R18 annotations group by paper then file, and the order choice flips p.6 against p.3 by modification date',async()=>{
 const f=fixture();
 f.refs.set(100,{id:100,parentID:1,getField:()=>'Main article'});f.refs.set(200,{id:200,parentID:1,getField:()=>'Supplementary'});f.refs.set(98,{id:98,parentID:2,getField:()=>'PDF'});
 f.library.annotations=async()=>[
  {id:'a',parentID:'1',attachmentID:'100',text:'page three',comment:'',color:'#ffd400',pageIndex:2,pageLabel:'3',modified:'2026-09-01 10:00:00'},
  {id:'b',parentID:'2',attachmentID:'98',text:'other paper',comment:'',color:'#ffd400',pageIndex:0,pageLabel:'1',modified:'2026-09-10 10:00:00'},
  {id:'c',parentID:'1',attachmentID:'200',text:'supplement',comment:'',color:'#ffd400',pageIndex:0,pageLabel:'1',modified:'2026-08-01 10:00:00'},
  {id:'d',parentID:'1',attachmentID:'100',text:'page six',comment:'',color:'#ffd400',pageIndex:5,pageLabel:'6',modified:'2026-09-20 10:00:00'},
  {id:'e',parentID:'1',attachmentID:'100',text:'undated',comment:'',color:'#ffd400',pageIndex:7,pageLabel:'8'}];
 await f.bench.show('annotations');
 const heads=()=>[...f.body().querySelectorAll('.sc-annot-group-name')].map(n=>n.textContent);
 assert.equal(heads().filter(n=>n==='Paper Alpha').length,1,'one paper title for main and supplement');
 assert.equal(heads().length,2,'two papers, each named once');
 const texts=()=>[...f.body().querySelectorAll('.sc-annot-text')].map(n=>n.textContent);
 f.bench.state.annotationPaperID='1';await f.bench.render();
 assert.equal(f.body().querySelectorAll('.sc-annot-group-meta').length,1,'the paper head and meta once');
 assert.equal(f.body().querySelectorAll('.sc-annot-file').length,2,'file subheads because there are several files');
 const order1=texts();
 assert.deepEqual(order1.slice(0,2),['page three','page six'],'page order: p.3 before p.6');
 await f.click('최근 수정순');
 assert.equal(f.runtime.cache.workbenchUI.annotationOrder,'recent','remembered');
 const order2=texts();
 assert.deepEqual(order2.slice(0,2),['page six','page three'],'recent order: p.6 first');
 const main=order2.indexOf('supplement'),last=order2.indexOf('undated');
 assert.ok(main>order2.indexOf('page three'),'the older file follows the newer file');
 assert.ok(last>order2.indexOf('page three')&&last<main,'unknown dates last within their file');
 await f.click('문헌·쪽순');
 assert.deepEqual(texts().slice(0,2),['page three','page six']);
 f.bench.destroy();
});

test('the count on the current tab is that page\'s own: notes shown, annotations shown, never the paper-scope count',async()=>{
 const f=fixture();
 f.library.notes=async()=>[{id:'9',parentID:'1',title:'One',text:'one',html:'<p>1</p>',modified:'2026-09-01'},{id:'10',parentID:'1',title:'Two',text:'two',html:'<p>2</p>',modified:'2026-09-02'}];
 f.library.annotations=async()=>[{id:'3',key:'K3',parentID:'1',attachmentID:'99',text:'an epitope map',comment:'',color:'#ffd400',type:'highlight',pageLabel:'1',pageIndex:0}];
 const badge=tab=>f.bench.panel.querySelector(`nav [data-tab="${tab}"] .sc-nav-count`)?.textContent??null;
 await f.bench.show('explore');
 assert.equal(badge('explore'),String(f.body().querySelectorAll('.sc-paper-card').length),'papers listed on 보유 문헌');
 await f.bench.show('notes');
 assert.equal(badge('notes'),'2','the notes shown, not the papers in scope');
 await f.bench.show('annotations');
 assert.equal(badge('annotations'),'1','the annotations shown');
 assert.equal(badge('notes'),null,'only the current tab carries a count');
 await f.bench.show('tags');
 assert.equal(badge('tags'),null,'a page with no natural count shows none');
 f.bench.destroy();
});

test('저자 추적: the toolbar says what is waiting in a badge, a withdrawal chip stays on its paper\'s title line',async()=>{
 const f=fixture();
 f.runtime.watchedAuthorsByNews=()=>[
  {id:'A1',name:'First Person',seen:[],news:[{id:'W3',title:'Withdrawn one',doi:'10.1/bad',date:'2026-07-01',signals:{rank:3}}]}];
 await f.bench.show('authors');
 const count=f.body().querySelector('.sc-watch-head .sc-watch-count');
 assert.equal(count.dataset.state,'new');
 assert.match(count.textContent,/확인 안 한 새 논문 1편/);
 assert.equal(f.body().querySelector('.sc-watch-head .sc-hit-group').textContent.includes('관심 저자'),false,'the group below carries the name; the toolbar does not repeat it');
 const head=[...f.body().querySelectorAll('.sc-section-head')].find(h=>h.querySelector('.sc-section-head-name')?.textContent==='관심 저자');
 assert.ok(head,'the followed authors are a group with their own head, news or not');
 const row=f.body().querySelector('.sc-author-inbox-row');
 assert.ok(row.querySelector('.sc-hit-title .sc-signal'),'the chip is on the title line');
 assert.equal(row.querySelector('.sc-inbox-status .sc-signal'),null,'and not in the status column, where it wrapped alone');
 f.bench.destroy();
});

test('논문 비교: with a comparison on screen the picker stays folded, 문헌 추가 opens it, and every row keeps its authors column',async()=>{
 const f=fixture();
 f.setSelection([1]);f.bench.state.selected=new Set(['1']);
 await f.bench.show('matrix');
 assert.equal(f.body().querySelector('.sc-matrix-picker'),null,'a comparison already exists: picker folded');
 await f.click('문헌 추가');
 const rows=[...f.body().querySelectorAll('.sc-matrix-picker-row')];
 assert.ok(rows.length>0);
 for(const row of rows)assert.equal(row.children.length,3,'title, authors, button -- also for a paper with no authors, so the button never slides into the authors column');
 f.bench.destroy();
 const g=fixture();
 g.setSelection([]);g.bench.state.selected=new Set();
 await g.bench.show('matrix');
 // 2026-10-03 (detail review): with the whole list already on screen the picker is folded behind 문헌 추가; it opens by default only when there is nothing to compare.
 assert.equal(g.body().querySelector('.sc-matrix-picker'),null,'the list is the comparison: the picker waits behind 문헌 추가');
 await g.click('문헌 추가');assert.ok(g.body().querySelector('.sc-matrix-picker'),'문헌 추가 opens the way in');
 g.bench.destroy();
});

test('관계 그래프: labels lie on a backdrop and the zoom buttons lie on the map',async()=>{
 const f=fixture();
 const extra=[10].map(n=>({...f.papers[0],id:String(n),key:'K'+n,title:'A Very Long Neighbour Paper Title About Something'}));
 f.refs.set(10,{id:10,libraryID:1,key:'K10'});
 f.library.snapshot=async()=>[...f.papers,...extra];
 const works={'1:K1':{openalex:'W1',references:['W10']},'1:K10':{openalex:'W10',references:[]},'1:K2':{}};
 f.runtime.graphTools=PaperGraph;f.runtime.paperWorks=()=>works;f.runtime.journalIdentity=JournalIdentity;
 f.runtime.identity=ref=>'1:'+(ref.key||'K'+ref.id);
 await f.bench.show('graph');await settle();
 const frame=f.body().querySelector('.sc-graph-frame');
 assert.ok(frame&&frame.querySelector('svg.sc-graph'),'the map is in a frame of its own');
 assert.deepEqual([...frame.querySelectorAll('.sc-graph-zoom button')].map(b=>b.textContent),['확대','축소'],'the zoom is inside the frame, top right by CSS, not in a bar under it');
 const labels=[...frame.querySelectorAll('.sc-graph-label')];
 assert.ok(labels.length>=2);
 for(const label of labels)assert.equal(label.previousElementSibling.getAttribute('class'),'sc-graph-label-bg','every label has its plate');
 f.bench.destroy();
});

test('읽기 진행: the record views and the sort belong to the 읽기 기록 group, not to 이어 읽기',async()=>{
 const f=fixture();
 const now=Date.now(),day=864e5;
 const lastRead={1:new Date(now-1000).toISOString(),2:new Date(now-20*day).toISOString()};
 f.runtime.state=ref=>({citations:3,impactFactor:4,status:'reading',lastRead:lastRead[ref.id]});
 for(const id of [1,2])f.runtime.cache.items[id]={seconds:60,lastRead:lastRead[id]};
 f.runtime.pageProgress=()=>({pages:{},total:0,visited:0,percent:0});
 await f.bench.show('reading');
 const groups=[...f.body().querySelectorAll('.sc-group')];
 const named=name=>groups.find(g=>g.querySelector('.sc-section-head-name')?.textContent===name);
 const resume=named('이어 읽기'),records=named('읽기 기록');
 assert.ok(resume&&records);
 assert.equal(resume.querySelector('.sc-reading-views'),null,'not under 이어 읽기');
 assert.equal(resume.querySelector('.sc-reading-tools'),null);
 assert.ok(records.querySelector('.sc-reading-views'),'the record views are in 읽기 기록');
 assert.ok(records.querySelector('.sc-reading-tools select'),'and so is the sort');
 f.bench.destroy();
});

test('중첩 태그: a count is a badge beside the name, not a parenthesis',async()=>{
 const f=fixture();
 await f.bench.show('tags');
 const name=f.body().querySelector('.sc-tag-name');
 assert.ok(name.querySelector('.sc-count'),'the count is its own badge');
 assert.equal(/[()]/.test(name.textContent),false,'no parentheses');
 f.bench.destroy();
});

test('R18 the notes compose area folds over existing notes, opens when empty or drafted, and keeps drafts',async()=>{
 const f=fixture();
 f.library.notes=async()=>[{id:'9',parentID:'1',title:'Research question',text:'Research question and follow-up',html:'<p>q</p>',modified:'2026-09-01'}];
 await f.bench.show('notes');
 const compose=()=>f.body().querySelector('.sc-note-compose');
 assert.equal(compose().hidden,true,'folded by default when the paper has notes');
 // One head, not a count line above a second "이 문헌의 노트" head: the name and its count, the actions at its right.
 const noteHead=f.body().querySelector('.sc-section-head');
 assert.match(noteHead.textContent,/이 문헌의 노트\s*1/);
 assert.ok(noteHead.querySelector('.sc-section-head-actions'),'the actions sit in the head');
 assert.match(noteHead.textContent,/새 노트 쓰기.*다른 문헌 고르기/s);
 assert.equal(f.body().querySelector('.sc-note-head'),null,'no second count line');
 assert.equal([...f.body().querySelectorAll('.sc-section-head-name')].filter(n=>n.textContent==='이 문헌의 노트').length,1,'the name once');
 await f.click('새 노트 쓰기');
 assert.equal(compose().hidden,false);
 f.input('새 노트 내용','unsaved thought');
 await f.click('새 노트 쓰기');
 assert.equal(compose().hidden,true,'folding keeps the text');
 assert.equal(compose().querySelector('textarea').value,'unsaved thought');
 await f.bench.render();
 assert.equal(compose().hidden,false,'an unsaved draft opens it again');
 assert.equal(compose().querySelector('textarea').value,'unsaved thought');
 f.bench.destroy();
 const g=fixture();
 g.library.notes=async()=>[];
 await g.bench.show('notes');
 assert.equal(g.body().querySelector('.sc-note-compose').hidden,false,'no notes: write straight away');
 g.bench.destroy();
});

test('R18 journal citations share one axis: 64 and 12 on it, unknown as a dash, legends once in the header',async()=>{
 const f=fixture();
 const mk=(id,venue,status,citations)=>({...f.papers[0],id:String(id),title:'P'+id,venue,status,citations});
 f.runtime.state=ref=>({status:[11,21].includes(ref.id)?'done':'',citations:{11:64,12:64,13:12,14:12,21:0,22:null,23:5}[ref.id]??null,impactFactor:null});
 for(const id of [11,12,13,14,21,22,23])f.refs.set(id,{id});
 f.library.snapshot=async()=>[mk(11,'Example Methods','done',64),mk(13,'Example Methods','',12),mk(21,'Zero Journal','done',0),mk(22,'Zero Journal','',null),mk(23,'Only Unread','',5)];
 await f.bench.load();await f.bench.show('journals');
 const rows=[...f.body().querySelectorAll('.sc-journal-reading-row:not(.sc-journal-reading-header)')];
 const row=name=>rows.find(r=>r.querySelector('.sc-journal-reading-name-text')?.textContent===name);
 const ex=row('Example Methods');
 assert.equal(ex.querySelectorAll('.sc-journal-citation-dot').length,2,'both marks on the one axis');
 assert.equal(ex.querySelectorAll('.sc-journal-citation-join').length,1,'joined when both exist');
 assert.deepEqual([...ex.querySelectorAll('.sc-journal-citation-value')].map(n=>n.textContent.split(' ·')[0]),['64','12']);
 assert.equal(ex.querySelector('.sc-journal-citation-label'),null,'no per-row legend');
 assert.equal(ex.querySelector('.sc-journal-reading-pct').textContent.includes('보유'),false,'no per-row 보유/시간 words');
 const zero=row('Zero Journal');
 const values=[...zero.querySelectorAll('.sc-journal-citation-value')].map(n=>n.textContent.split(' ·')[0]);
 assert.deepEqual(values,['0','—'],'a real 0 and an unknown');
 assert.equal(zero.querySelectorAll('.sc-journal-citation-dot').length,1,'unknown has no mark');
 assert.match(zero.querySelector('.sc-journal-citation-dot').style.left,/\* 0\)/,'a real 0 sits at the axis start');
 const head=f.body().querySelector('.sc-journal-reading-header');
 // The legend is one line under the section title now (it overflowed the card as a header cell), not part of the column header.
 const legend=f.body().querySelector('.sc-journal-legend-line').textContent;
 assert.match(legend,/읽는 중·완료.*안 읽음/);assert.match(legend,/보유.*시간/);
 assert.equal(/읽는 중·완료/.test(head.textContent),false,'no legend in the header cells');
 assert.match(head.querySelector('.sc-journal-citation-axis').textContent,/^1/,'decade ticks, from 1');
 f.bench.destroy();
});

test('R19 내 문헌 분석 reads evenly: identical count badges in every row, a log citation axis that survives an outlier, columns aligned with their headers',async()=>{
 const f=fixture();
 const mk=(id,venue,status,citations)=>({...f.papers[0],id:String(id),title:'P'+id,venue,status,citations});
 const list=[];let id=100;
 for(const [venue,n,cites] of [['',5,3],['Outlier',3,13308],['Small',2,4],['Zeros',2,0],['Nocite',1,null]])for(let i=0;i<n;i++){id++;list.push(mk(id,venue,i%2?'done':'',cites));}
 const by=new Map(list.map(p=>[Number(p.id),p]));
 f.runtime.state=ref=>({status:by.get(ref.id)?.status||'',citations:by.get(ref.id)?.citations??null,impactFactor:null});
 for(const p of list)f.refs.set(Number(p.id),{id:Number(p.id)});
 f.library.snapshot=async()=>list;
 await f.bench.load();await f.bench.show('journals');
 const rows=[...f.body().querySelectorAll('.sc-journal-reading-row:not(.sc-journal-reading-header)')];
 assert.equal(rows.length,5,'the no-journal group is a row like the rest');
 const sig=el=>`${el.tagName}.${el.className}`;
 const cells=r=>[r.children[1],r.children[2]];
 for(const r of rows){
  for(const c of cells(r)){assert.equal(c.className.split(' ').includes('sc-journal-reading-num'),true);assert.ok(c.querySelector('.sc-journal-reading-count'),'every count cell holds the badge, whatever the value');}
  assert.equal(sig(r.children[1].firstElementChild),sig(rows[0].children[1].firstElementChild),'held badges are the same element and classes');
  // User direction 2026-10-03: counts are plain numbers, the unit (편) is in the column header.
  assert.match(r.children[1].textContent,/^\d+$/);
 }
 // A log axis: the outlier lands inside the plot box, and the small values are not squashed to the start.
 const lefts=r=>[...r.querySelectorAll('.sc-journal-citation-dot')].map(d=>d.style.left);
 const frac=l=>Number(/\* ([0-9.e-]+)\)$/.exec(l)[1]);
 const outlier=rows.find(r=>r.querySelector('.sc-journal-reading-name-text').textContent==='Outlier');
 const small=rows.find(r=>r.querySelector('.sc-journal-reading-name-text').textContent==='Small');
 for(const r of rows)for(const l of lefts(r)){const v=frac(l);assert.ok(v>=0&&v<=1,'every mark is inside the plot box');}
 assert.equal(Math.max(...lefts(outlier).map(frac)),1,'the top of the axis is the outlier');
 assert.ok(Math.max(...lefts(small).map(frac))>0.1,'a median of 4 is not pressed against the start (linear would be 0.0003)');
 assert.match([...f.body().querySelectorAll('.sc-journal-citation-tick')].map(t=>t.textContent).join(' '),/^1 10 100 1k 10k$/);
 // Header and content alignment is a stylesheet contract.
 const css=fs.readFileSync(new URL('../content/workbench.css',import.meta.url),'utf8');
 assert.match(css,/\.sc-journal-reading-header > span:not\(:first-child\):not\([^)]*\):not\([^)]*\) \{ text-align: right; \}/,'number headers right-aligned');
 assert.match(css,/\.sc-journal-reading-header > \.sc-journal-citation-head, [^{]*\.sc-journal-reading-mix-head \{ text-align: start; \}/,'chart headers left-aligned');
 assert.match(css,/\.sc-journal-reading-num \{ display: flex; justify-content: flex-end;/,'count cells right-aligned');
 assert.match(css,/\.sc-journal-reading-row \{[^}]*min-height: 56px/,'uniform row height');
 f.bench.destroy();
});

// ---- 상세 필터: 포함·제외 규칙 ----
const cardCount=f=>f.body().querySelectorAll('.sc-paper-card').length;
const chipTexts=f=>[...f.bench.panel.querySelectorAll('.sc-rule-chip-main')].map(b=>b.textContent);
const press=(f,el)=>{el.dispatchEvent(new f.win.Event('click',{bubbles:true}));};
const key=(f,target,name)=>{const e=new f.win.Event('keydown',{bubbles:true,cancelable:true});e.key=name;target.dispatchEvent(e);return e;};

test('상세 필터 rules: an exclude rule is added in the panel, shows as a 제외 chip, narrows the list and is saved for the tab', async () => {
 const f=fixture();await f.bench.show('explore');await settle();
 assert.equal(cardCount(f),2);
 await f.click('태그 규칙 추가');await f.click('제외');
 const editor=f.bench.panel.querySelector('.sc-rule-editor');assert.equal(editor.hidden,false);
 assert.equal(f.bench.panel.querySelector('.sc-filters').hasAttribute('open'),true,'the panel opens for its editor');
 assert.equal(f.findButton('규칙 적용').disabled,true,'nothing chosen yet: nothing to apply');
 assert.match(editor.querySelector('.sc-rule-preview').textContent,/조건을 고르면/);
 const box=editor.querySelector('input[aria-label="topic/a"]');assert.ok(box,'tags of the scope are listed');
 box.checked=true;box.dispatchEvent(new f.win.Event('change',{bubbles:true}));
 assert.equal(f.findButton('규칙 적용').disabled,false);
 assert.match(editor.querySelector('.sc-rule-preview').textContent,/2편 중 1편/);
 await f.click('규칙 적용');
 assert.equal(cardCount(f),1);assert.ok(f.body().textContent.includes('Paper Beta')&&!f.body().textContent.includes('Paper Alpha'));
 assert.deepEqual(chipTexts(f),['제외 · 태그: topic/a']);
 assert.equal(f.bench.panel.querySelector('.sc-rule-chip').dataset.mode,'ex');
 assert.equal(f.bench.panel.querySelector('.sc-filters summary').textContent,'상세 필터 · 1개 적용');
 assert.equal(f.bench.panel.querySelector('.sc-rule-editor').hidden,true,'the editor closes after applying');
 assert.equal(f.runtime.cache.workbenchUI.filterRules.explore[0].mode,'ex');
 assert.deepEqual(f.runtime.cache.workbenchUI.filterRules.explore[0].values,['topic/a']);
 // The chip's × removes the rule and the list is whole again.
 press(f,f.bench.panel.querySelector('.sc-rule-chip-x'));await settle();
 assert.equal(cardCount(f),2);assert.deepEqual(f.runtime.cache.workbenchUI.filterRules,{});
 assert.equal(f.bench.panel.querySelector('.sc-filter-chips').hidden,true);
 f.bench.destroy();
});

test('상세 필터 rules: click a chip to edit it, flip it to 포함, and 모두 지우기 clears every rule and filter', async () => {
 const f=fixture();await f.bench.show('explore');await settle();
 await f.bench.filters.set([{id:'a',kind:'type',mode:'ex',values:['preprint']},{id:'b',kind:'tag',mode:'in',values:['topic/b']}]);
 assert.equal(cardCount(f),1);assert.deepEqual(chipTexts(f),['제외 · 유형: Preprint','태그: topic/b']);
 press(f,f.bench.panel.querySelectorAll('.sc-rule-chip-main')[1]);await settle();
 const editor=f.bench.panel.querySelector('.sc-rule-editor');assert.equal(editor.hidden,false);
 assert.equal(editor.getAttribute('aria-label'),'태그 규칙 편집');
 assert.equal(editor.querySelector('input[aria-label="topic/b"]').checked,true,'the rule loads into its editor');
 press(f,editor.querySelector('.sc-rule-head [data-mode="ex"]'));await settle();
 await f.click('변경 적용');
 assert.deepEqual(chipTexts(f),['제외 · 유형: Preprint','제외 · 태그: topic/b']);assert.equal(cardCount(f),1);
 assert.ok(f.body().textContent.includes('Paper Alpha'));
 f.bench.state.type='journalArticle';await f.bench.render();
 assert.ok([...f.bench.panel.querySelectorAll('.sc-filter-chips button')].some(b=>b.textContent==='모두 지우기'));
 await f.click('적용 중인 필터 모두 지우기');
 assert.equal(cardCount(f),2);assert.equal(f.bench.filters.rules().length,0);assert.equal(f.bench.state.type,'');
 assert.deepEqual(f.runtime.cache.workbenchUI.filterRules,{});
 f.bench.destroy();
});

test('상세 필터 rules: saved rules come back when the panel opens again, per tab, and bad saved data is ignored', async () => {
 const cache={items:{},workbenchUI:{filterRules:{explore:[{id:'x',kind:'type',mode:'ex',values:['preprint']},{id:'y',kind:'tag',values:['topic/b']},{id:'z',kind:'nope'}],notes:[{id:'n',kind:'pdf'}]}}};
 const f=fixture(cache);await f.bench.show('explore');await settle();
 assert.deepEqual(chipTexts(f),['제외 · 유형: Preprint','태그: topic/b']);assert.equal(cardCount(f),1);
 assert.equal(f.bench.panel.querySelector('.sc-filters summary').textContent,'상세 필터 · 2개 적용');
 await f.bench.show('attachments');await settle();
 assert.equal(chipTexts(f).length,0,'another tab keeps its own rules');
 f.bench.destroy();
 const g=fixture({items:{},workbenchUI:{filterRules:'junk'}});await g.bench.show('explore');await settle();
 assert.equal(cardCount(g),2);g.bench.destroy();
});

test('상세 필터 rules: the search box understands -word, "phrase" and field:value', async () => {
 const f=fixture();await f.bench.show('explore');await settle();
 const ask=async q=>{f.bench.state.query=q;await f.bench.render();return [...f.body().querySelectorAll('.sc-paper-card')].map(c=>c.textContent.includes('Alpha')?'A':'B').join('');};
 assert.equal(await ask('-alpha'),'B');assert.equal(await ask('title:alpha'),'A');assert.equal(await ask('-tag:topic/a'),'B');
 assert.equal(await ask('"paper beta"'),'B');assert.equal(await ask('journal:nature'),'B');assert.equal(await ask('year:2025'),'A');
 assert.equal(await ask('paper'),'AB','plain text is unchanged');
 assert.match(f.bench.panel.querySelector('.sc-rules-hint').textContent,/-단어.*제목:.*연도:/);
 f.bench.destroy();
});

test('상세 필터 rules: option lists show counts given the other rules, and journals are searchable', async () => {
 const f=fixture();await f.bench.show('explore');await settle();
 await f.click('유형 규칙 추가');
 let opt=[...f.bench.panel.querySelectorAll('.sc-rule-opt')].map(o=>o.textContent);
 assert.deepEqual(opt,['논문2']);
 await f.click('취소');
 await f.bench.filters.set([{id:'t',kind:'tag',mode:'ex',values:['topic/a']}]);
 await f.click('저널 규칙 추가');
 opt=[...f.bench.panel.querySelectorAll('.sc-rule-opt')].map(o=>o.textContent);
 assert.deepEqual(opt,['Nature1','Science0'],'Science only has the excluded paper, so it would find nothing');
 const search=f.bench.panel.querySelector('input[aria-label="저널 목록 검색"]');search.value='sci';search.dispatchEvent(new f.win.Event('input',{bubbles:true}));
 assert.deepEqual([...f.bench.panel.querySelectorAll('.sc-rule-opt')].map(o=>o.textContent),['Science0']);
 f.bench.destroy();
});

test('상세 필터 rules: collections, PDFs and notes are read once, on demand, from the library', async () => {
 const f=fixture();
 let reads=0;
 f.library.collections=async()=>{reads++;return [{id:'c1',name:'Cells',itemIDs:[1],parentID:null},{id:'c2',name:'Sub',itemIDs:[2],parentID:'c1'}];};
 f.library.childCounts=async()=>({'1':{notes:1,pdfs:1,noteTitles:['first look']}});
 await f.bench.show('explore');await settle();const before=reads;
 await f.bench.filters.set([{id:'a',kind:'pdf',mode:'in'}]);
 assert.equal(cardCount(f),1);assert.ok(f.body().textContent.includes('Paper Alpha'));const after=reads;assert.ok(after>before,'a rule that needs collections reads them');
 await f.bench.filters.set([{id:'a',kind:'pdf',mode:'ex'},{id:'b',kind:'collection',mode:'in',values:['c1'],sub:true}]);
 assert.equal(cardCount(f),1);assert.ok(f.body().textContent.includes('Paper Beta'),'Beta is in the subcollection and has no PDF');
 assert.deepEqual(chipTexts(f),['제외 · 첨부 PDF 있음','컬렉션: Cells +하위']);assert.equal(reads,after,'read once per library load, not per redraw');
 await f.bench.filters.set([{id:'c',kind:'note',mode:'in'}]);assert.equal(cardCount(f),1);
 f.bench.state.query='note:first';await f.bench.render();assert.equal(cardCount(f),1,'the note title of paper 1 is found by note:');
 f.bench.state.query='note:nothing';await f.bench.render();assert.equal(cardCount(f),0);
 f.bench.destroy();
});

test('상세 필터 rules: kinds that mean nothing on a tab are not offered there', async () => {
 const f=fixture();await f.bench.show('explore');await settle();
 const kinds=()=>[...f.bench.panel.querySelectorAll('.sc-rule-kind')].map(b=>b.dataset.kind);
 assert.equal(kinds().length,14);
 await f.bench.show('notes');await settle();assert.equal(kinds().includes('note'),false);assert.equal(kinds().length,13);
 await f.bench.show('attachments');await settle();assert.equal(kinds().includes('pdf'),false);
 await f.bench.show('tags');await settle();assert.equal(kinds().includes('tag'),false);
 await f.bench.show('annotations');await settle();assert.equal(kinds().includes('annotation'),false);
 f.bench.destroy();
});

test('상세 필터 rules: every control is labelled, and Esc closes the editor, then the panel, giving focus back', async () => {
 const f=fixture();await f.bench.show('explore');await settle();
 await f.click('단어 규칙 추가');
 const editor=f.bench.panel.querySelector('.sc-rule-editor');
 for(const el of editor.querySelectorAll('input,button,select,textarea')){
  assert.ok(el.getAttribute('aria-label')||el.textContent.trim()||el.closest('label')?.textContent.trim(),'unlabelled control in the editor: '+el.outerHTML.slice(0,80));
 }
 for(const el of f.bench.panel.querySelectorAll('.sc-rules button'))assert.ok(el.getAttribute('aria-label')||el.textContent.trim());
 const input=editor.querySelector('input[type=text]');
 assert.equal(f.doc.activeElement,input,'the editor takes focus on its first field');
 input.value='alpha';input.dispatchEvent(new f.win.Event('input',{bubbles:true}));
 assert.equal(key(f,input,'Escape').defaultPrevented,true);
 assert.equal(f.bench.panel.querySelector('.sc-rule-editor').hidden,true);
 assert.equal(f.doc.activeElement.dataset.kind,'word','focus goes back to the button that opened it');
 assert.equal(f.bench.panel.hidden,false,'one Esc does not close the whole panel');
 assert.equal(f.bench.filters.rules().length,0,'a cancelled draft adds nothing');
 key(f,f.bench.panel.querySelector('.sc-rules-title'),'Escape');
 assert.equal(f.bench.panel.querySelector('.sc-filters').hasAttribute('open'),false);
 assert.equal(f.doc.activeElement.tagName.toLowerCase(),'summary');
 f.bench.destroy();
});

test('상세 필터 rules: Enter in a field applies the rule; a range rule and a word rule work from the panel', async () => {
 const f=fixture();await f.bench.show('explore');await settle();
 await f.click('연도 규칙 추가');
 const min=f.bench.panel.querySelector('input[aria-label="연도 최소"]');min.value='2025';min.dispatchEvent(new f.win.Event('input',{bubbles:true}));
 key(f,min,'Enter');await settle();
 assert.deepEqual(chipTexts(f),['연도: 2025 이상']);assert.equal(cardCount(f),1);
 await f.click('단어 규칙 추가');await f.click('제외');
 const text=f.bench.panel.querySelector('input[aria-label="찾을 단어 또는 구절"]');text.value='gamma';text.dispatchEvent(new f.win.Event('input',{bubbles:true}));
 await f.click('규칙 적용');
 assert.deepEqual(chipTexts(f),['연도: 2025 이상','제외 · 단어: “gamma”']);assert.equal(cardCount(f),1,'nothing is called gamma, so nothing more is removed');
 f.bench.destroy();
});

test('상세 필터 rules: 필터 초기화 clears the tab\'s rules too', async () => {
 const f=fixture();await f.bench.show('explore');await settle();
 await f.bench.filters.set([{id:'a',kind:'tag',values:['topic/a']}]);assert.equal(cardCount(f),1);
 await f.click('필터 초기화');await settle();
 assert.equal(cardCount(f),2);assert.deepEqual(f.runtime.cache.workbenchUI.filterRules,{});
 f.bench.destroy();
});

function journalFixture(){
 const f=fixture();
 const mk=(id,venue,extra={})=>({id:String(id),key:'K'+id,libraryID:1,title:'Study '+id,authors:'',year:'2024',venue,itemType:'journalArticle',tags:[],abstract:'',related:[],...extra});
 f.library.snapshot=async()=>[mk(1,'Nature Methods'),mk(2,'Nature Methods'),mk(3,'Proceedings of the National Academy of Sciences of the United States of America'),mk(4,'Nucleic Acids Research'),mk(5,'Science',{journalAbbr:'Science'})];
 f.runtime.journalIdentity={identify:v=>/^Proceedings/.test(v)?{abbreviation:'PNAS',mark:'PNAS'}:null,abbreviate:v=>v==='Nature Methods'?'Nat Methods':v};
 return f;
}
const typeInto=(f,el,value)=>{el.value=value;el.dispatchEvent(new f.win.Event('input',{bubbles:true}));};

test('저널: in the search box lists journals by name, abbreviation or acronym; keys work; picks OR together and 제외 works',async()=>{
 const f=journalFixture();await f.bench.show('explore');await settle();
 const search=f.bench.panel.querySelector('[aria-label="작업 패널 검색"]'),box=()=>f.bench.panel.querySelector('.sc-suggest');
 const options=()=>[...box().querySelectorAll('.sc-suggest-option')].map(o=>o.querySelector('.sc-suggest-name').textContent.split(' ')[0]+(o.querySelector('.sc-suggest-abbr')?'/'+o.querySelector('.sc-suggest-abbr').textContent:''));
 assert.equal(box().hidden,true);assert.equal(search.getAttribute('role'),'combobox');
 typeInto(f,search,'deep ');assert.equal(box().hidden,true,'plain text offers nothing');
 typeInto(f,search,'저널:');assert.equal(box().hidden,false);assert.equal(options().length,4,'every journal in the scope, at once');
 typeInto(f,search,'저널:pnas');assert.deepEqual(options(),['Proceedings/PNAS']);
 typeInto(f,search,'저널:nat meth');assert.deepEqual(options(),['Nature/Nat Methods']);
 typeInto(f,search,'journal:NAR');assert.deepEqual(options(),['Nucleic'],'the acronym');
 typeInto(f,search,'저널:nature');assert.deepEqual(options(),['Nature/Nat Methods'].concat([]));
 // keys: ArrowDown wraps, Esc closes without leaving the panel.
 typeInto(f,search,'저널:n');const n=options().length;assert.ok(n>=3);
 assert.equal(search.getAttribute('aria-activedescendant'),'sc-journal-suggest-0');
 assert.equal(key(f,search,'ArrowDown').defaultPrevented,true);assert.equal(search.getAttribute('aria-activedescendant'),'sc-journal-suggest-1');
 key(f,search,'ArrowUp');key(f,search,'ArrowUp');assert.equal(search.getAttribute('aria-activedescendant'),'sc-journal-suggest-'+(n-1),'wraps');
 assert.equal(key(f,search,'Escape').defaultPrevented,true);assert.equal(box().hidden,true);assert.equal(f.bench.panel.hidden,false);
 // Enter on the first suggestion adds a 저널 include rule and takes the token out of the box.
 typeInto(f,search,'비교 저널:pnas');key(f,search,'Enter');await settle();
 assert.deepEqual(f.bench.filters.rules().map(r=>[r.kind,r.mode,r.values.length]),[['journal','in',1]]);
 assert.equal(f.bench.filters.rules()[0].values[0].startsWith('Proceedings'),true);assert.equal(search.value,'비교');assert.equal(f.bench.state.query,'비교');
 assert.equal(box().hidden,true);
 // A second pick joins the same rule: any of the journals.
 f.bench.state.query='';search.value='';await f.bench.render();
 typeInto(f,search,'저널:nar');key(f,search,'Enter');await settle();
 assert.deepEqual(f.bench.filters.rules().map(r=>[r.kind,r.mode,r.values.length]),[['journal','in',2]]);
 assert.equal(f.body().querySelectorAll('.sc-paper-card').length,2,'PNAS and NAR papers');
 // Journals already picked are not offered again; -저널: makes an exclude rule.
 typeInto(f,search,'저널:pnas');assert.equal(box().hidden,true);
 typeInto(f,search,'-저널:science');key(f,search,'Enter');await settle();
 assert.deepEqual(f.bench.filters.rules().map(r=>[r.kind,r.mode,r.values.length]),[['journal','in',2],['journal','ex',1]]);
 assert.equal(f.runtime.cache.workbenchUI.filterRules.explore.length,2,'picks are saved');
 // A mouse pick works too.
 await f.bench.filters.set([]);typeInto(f,search,'저널:science');
 box().querySelector('.sc-suggest-option').dispatchEvent(new f.win.Event('mousedown',{bubbles:true,cancelable:true}));await settle();
 assert.equal(f.bench.filters.rules()[0].values[0],'Science');
 f.bench.destroy();
});

test('저널: suggestions are not offered where journals are not a filter',async()=>{
 const f=journalFixture();await f.bench.show('journals');await settle();
 const search=f.bench.panel.querySelector('[aria-label="작업 패널 검색"]');
 if(search){typeInto(f,search,'저널:nat');assert.equal(f.bench.panel.querySelector('.sc-suggest').hidden,true);}
 f.bench.destroy();
});

test('저널 rule editor: typing a name, abbreviation or acronym narrows the list at once and several can be ticked',async()=>{
 const f=journalFixture();await f.bench.show('explore');await settle();
 await f.click('저널 규칙 추가');
 const rows=()=>[...f.bench.panel.querySelectorAll('.sc-rule-opt')].map(o=>o.querySelector('.sc-rule-opt-name').textContent.split(' ')[0]);
 assert.equal(rows().length,4,'the whole list shows before anything is typed');
 const search=f.bench.panel.querySelector('input[aria-label="저널 목록 검색"]');
 typeInto(f,search,'pnas');assert.deepEqual(rows(),['Proceedings']);
 typeInto(f,search,'nat methods');assert.deepEqual(rows(),['Nature']);
 assert.equal(f.bench.panel.querySelector('.sc-rule-opt-abbr').textContent,'Nat Methods');
 typeInto(f,search,'nar');assert.deepEqual(rows(),['Nucleic']);
 typeInto(f,search,'nuc');
 for(const label of ['Nucleic Acids Research']){const box=f.bench.panel.querySelector(`input[aria-label="${label}"]`);box.checked=true;box.dispatchEvent(new f.win.Event('change',{bubbles:true}));}
 typeInto(f,search,'pnas');
 const pnas=[...f.bench.panel.querySelectorAll('.sc-rule-opt input')].find(i=>/^Proceedings/.test(i.getAttribute('aria-label')));pnas.checked=true;pnas.dispatchEvent(new f.win.Event('change',{bubbles:true}));
 typeInto(f,search,'');assert.equal(rows()[0].length>0,true);
 assert.equal([...f.bench.panel.querySelectorAll('.sc-rule-opt input')].filter(i=>i.checked).length,2,'ticked journals stay listed whatever is typed');
 await f.click('규칙 적용');
 assert.equal(f.bench.filters.rules()[0].values.length,2);assert.equal(f.body().querySelectorAll('.sc-paper-card').length,2);
 f.bench.destroy();
});

/* 이 논문 주변: what happened around the paper in focus. */
const aroundIssues = (status, events = [], extra = {}) => ({events, summary: {status, checked: '2026-10-01T03:00:00Z', failed: [], comments: 0, ...extra}});
const aroundReactions = (extra = {}) => ({bluesky: {count: 0, top: []}, hackerNews: {count: 0, top: []}, wikipedia: {count: 0, articles: []},
 pubpeer: {url: 'https://pubpeer.com/search?q=x'}, checked: '2026-10-01T03:00:00Z', failed: [], ...extra});
async function aroundFixture({issues = aroundIssues('clean'), reactions = aroundReactions()} = {}) {
 const f = await pathFixture();
 f.asked = [];
 f.runtime.paperIssues = async (ref, o) => { f.asked.push(['issues', ref.id, o]); return typeof issues === 'function' ? issues(ref, o) : issues; };
 f.runtime.paperReactions = async (ref, o) => { f.asked.push(['reactions', ref.id, o]); return typeof reactions === 'function' ? reactions(ref, o) : reactions; };
 f.around = () => f.body().querySelector('.sc-around');
 f.launched = [];
 f.win.Zotero = {...(f.win.Zotero || {}), launchURL: url => f.launched.push(url)};
 return f;
}

test('around: each issue status reads in its own words and only a retraction is red', async () => {
 const cases = [['retracted', '철회됨'], ['concern', '우려 표명'], ['corrected', '정정 있음'],
  ['clean', '알려진 정정·철회 없음 · 2026-10-01 확인'], ['unknown', '확인 못함 (Crossref 응답 없음)']];
 for (const [status, words] of cases) {
  const f = await aroundFixture({issues: aroundIssues(status, [], status === 'unknown' ? {failed: ['Crossref']} : {})});
  try {
   await f.bench.show('related');await settle();
   const line = f.around().querySelector('.sc-around-status');
   assert.equal(line.dataset.status, status);
   assert.ok(line.textContent.startsWith(words), status + ': ' + line.textContent);
   const css = fs.readFileSync(new URL('../content/workbench.css', import.meta.url), 'utf8');
   const red = css.split('\n').filter(l => /sc-around/.test(l) && /var\(--sc-error\)/.test(l));
   assert.ok(red.every(l => /retraction|withdrawal|retracted/.test(l)), 'red ink is only for a retraction');
  } finally { f.bench.destroy(); }
 }
});

test('around: the timeline names each kind in Korean, dates it, and links out through the safe path', async () => {
 const events = [
  {date: '2019-03-01', kind: 'correction', source: 'Crossref', label: 'Correction', url: 'https://doi.org/10.1/c'},
  {date: '2020-05-02', kind: 'expression-of-concern', source: 'Crossref', label: 'EoC', url: 'https://doi.org/10.1/e'},
  {date: '2020-06-02', kind: 'erratum', source: 'Europe PMC', label: 'Erratum', url: ''},
  {date: '2021-01-09', kind: 'retraction', source: 'Crossref', via: 'Retraction Watch', label: 'Retraction', url: 'https://doi.org/10.1/r'},
  {date: '2021-02-09', kind: 'withdrawal', source: 'Crossref', label: 'Withdrawal', url: 'javascript:alert(1)'},
  {date: '2021-03-01', kind: 'comment', source: 'Europe PMC', label: 'Comments', count: 3, url: 'https://europepmc.org/article/MED/1'}];
 const f = await aroundFixture({issues: aroundIssues('retracted', events)});
 try {
  await f.bench.show('related');await settle();
  const rows = [...f.around().querySelectorAll('.sc-around-row')];
  const said = rows.map(r => r.querySelector('.sc-around-link,.sc-around-kind').textContent);
  assert.deepEqual(said, ['정정', '우려 표명', '정오표', '철회', '철회(저자)', '코멘트 3건']);
  assert.match(rows[3].textContent, /2021-01-09.*Crossref · Retraction Watch/);
  const links = [...f.around().querySelectorAll('.sc-around-timeline .sc-around-link')];
  assert.equal(links.length, 4, 'a notice without an address, or with an unsafe one, is text, not a link');
  assert.ok(links.every(b => b.getAttribute('data-opens') === 'browser'));
  links[0].dispatchEvent(new f.win.Event('click', {bubbles: true}));
  assert.deepEqual(f.launched, ['https://doi.org/10.1/c']);
  const peer = [...f.around().querySelectorAll('button')].find(b => b.textContent === 'PubPeer에서 보기');
  assert.ok(peer && peer.getAttribute('data-opens') === 'browser');
  peer.dispatchEvent(new f.win.Event('click', {bubbles: true}));
  assert.match(f.launched.at(-1), /^https:\/\/pubpeer\.com\/search\?q=10\.1234%2Fa$/);
 } finally { f.bench.destroy(); }
});

test('around: reactions show counts, the top posts clamped as cards, and more on request', async () => {
 const post = n => ({author: 'Writer ' + n, handle: 'w' + n + '.bsky.social', text: 'Post <b>' + n + '</b> text', date: '2026-09-0' + n + 'T10:00:00Z', likes: 10 - n, reposts: n, replies: 0, url: 'https://bsky.app/profile/w' + n + '/post/' + n});
 const f = await aroundFixture({reactions: aroundReactions({
  bluesky: {count: 12, top: [post(1), post(2), post(3)]},
  hackerNews: {count: 2, top: [{title: 'HN one', points: 90, comments: 4, date: '2026-09-01T00:00:00Z', url: 'https://news.ycombinator.com/item?id=1'}, {title: 'HN two', points: 5, comments: 0, date: '', url: 'https://news.ycombinator.com/item?id=2'}]},
  wikipedia: {count: 28, articles: [{title: 'Some article', url: 'https://en.wikipedia.org/wiki/Some_article'}]},
  altmetric: {score: 41.6}})});
 try {
  await f.bench.show('related');await settle();
  const badges = [...f.around().querySelectorAll('.sc-around-detail .sc-around-badge')].map(b => b.textContent.replace(/\s+/g, ' ').trim());
  assert.deepEqual(badges, ['Bluesky 12', 'Hacker News 2', 'Wikipedia 28', 'Altmetric 42']);
  assert.equal(f.around().querySelectorAll('[data-source=bluesky]').length, 3);
  assert.equal(f.around().querySelectorAll('[data-source=hackernews]').length, 1);
  const text = f.around().querySelector('.sc-around-text');
  assert.equal(text.textContent, 'Post <b>1</b> text', 'a post is text, never markup');
  assert.equal(text.querySelector('b'), null);
  // 2026-10-03: outline icons replace the ♥ ↻ glyphs; the figures stay, with their labels as titles.
  assert.match(f.around().querySelector('.sc-around-stats').textContent, /9\s*1/);
  assert.equal(f.around().querySelector('.sc-around-stat').title, '좋아요 9');
  const more = [...f.around().querySelectorAll('button')].find(b => b.textContent.startsWith('더 보기'));
  assert.ok(more, 'there is more to show'); more.dispatchEvent(new f.win.Event('click', {bubbles: true}));
  assert.equal(f.around().querySelectorAll('[data-source=hackernews]').length, 2);
  assert.ok(f.around().textContent.includes('Some article'));
  for (const b of f.around().querySelectorAll('.sc-around-card button, .sc-around-wiki button')) assert.equal(b.getAttribute('data-opens'), 'browser');
 } finally { f.bench.destroy(); }
});

test('around: nothing found and sources that failed are said quietly, and never as a clean answer', async () => {
 let f = await aroundFixture({reactions: aroundReactions()});
 try {
  await f.bench.show('related');await settle();
  const quiet = [...f.around().querySelectorAll('.sc-around-group')][1].textContent;
  assert.match(quiet, /찾은 반응 없음 · 2026-10-01 확인/);
 } finally { f.bench.destroy(); }
 f = await aroundFixture({reactions: aroundReactions({failed: ['Bluesky'], bluesky: {count: 0, top: []}, wikipedia: {count: 4, articles: []}})});
 try {
  await f.bench.show('related');await settle();
  const second = [...f.around().querySelectorAll('.sc-around-group')][1].textContent;
  assert.match(second, /Wikipedia 4/);assert.match(second, /응답 없음: Bluesky/);
 } finally { f.bench.destroy(); }
 f = await aroundFixture({reactions: aroundReactions({allFailed: true, failed: ['Bluesky', 'Wikipedia']})});
 try {
  await f.bench.show('related');await settle();
  const second = [...f.around().querySelectorAll('.sc-around-group')][1].textContent;
  assert.match(second, /확인 못함/);assert.doesNotMatch(second, /찾은 반응 없음/);
 } finally { f.bench.destroy(); }
 f = await aroundFixture({issues: () => { throw new Error('boom'); }});
 try {
  await f.bench.show('related');await settle();
  assert.match(f.around().textContent, /확인하지 못했습니다/);
  assert.equal(f.around().querySelector('.sc-around-status'), null, 'a failed look is not a status');
 } finally { f.bench.destroy(); }
});

test('around: asked only for the paper in focus, abandoned when the reader leaves, and 다시 확인 forces it', async () => {
 let signals = [];
 const f = await aroundFixture({issues: (ref, o) => { signals.push(o.signal); return new Promise((_, no) => o.signal?.addEventListener('abort', () => no(Object.assign(new Error('Aborted'), {name: 'AbortError'})))); }});
 try {
  await f.bench.show('related');await settle();
  assert.equal(f.asked.filter(a => a[0] === 'issues').length, 1, 'one paper, one look');
  assert.equal(f.asked.filter(a => a[0] === 'reactions').length, 1);
  assert.ok(f.around().querySelector('.sc-around-loading'), 'a small loading line while it waits');
  assert.equal(signals[0].aborted, false);
  await f.bench.show('explore');await settle();
  assert.equal(signals[0].aborted, true, 'leaving the tab stops the request');
  assert.equal(f.body().querySelector('.sc-around'), null);
  assert.equal(f.asked.length, 2, 'the explore list asked for nothing');
 } finally { f.bench.destroy(); }
 const g = await aroundFixture();
 try {
  await g.bench.show('related');await settle();
  assert.equal(g.asked[0][2].force, false);
  await g.click('다시 확인');
  const forced = g.asked.filter(a => a[2]?.force === true).map(a => a[0]).sort();
  assert.deepEqual(forced, ['issues', 'reactions']);
  await g.click('전체 목록');
  assert.ok(g.asked.slice(4).every(a => a[2].force === false), 'a redraw asks the runtime, which answers from its cache; only 다시 확인 forces');
 } finally { g.bench.destroy(); }
});

test('around: a list row shows a badge only from the cache, and asks only when the reader opens it', async () => {
 const f = await aroundFixture();
 const known = {'10.1/W5': 'retracted', '10.1/W7': 'concern'};
 f.runtime.cachedIssueStatus = doi => known[doi] || null;
 f.runtime.doiIssues = async (doi, o) => { f.asked.push(['doiIssues', doi, o]); return aroundIssues('corrected'); };
 f.runtime.doiReactions = async (doi, urls, o) => { f.asked.push(['doiReactions', doi, o]); return aroundReactions(); };
 try {
  await f.bench.show('related');await f.click('전체 목록');await settle();
  const rows = [...f.body().querySelectorAll('.sc-hit')];
  assert.ok(rows.length >= 2);
  const badge = r => r.querySelector('.sc-signal');
  const w5 = rows.find(r => r.textContent.includes('Paper W5')), w7 = rows.find(r => r.textContent.includes('Paper W7'));
  assert.equal(badge(w5).textContent, '철회');assert.ok(badge(w5).classList.contains('sc-signal-retracted'));
  assert.equal(badge(w7).textContent, '우려');
  assert.equal(f.asked.filter(a => a[0].startsWith('doi')).length, 0, 'drawing a list never fetches');
  const toggle = [...w5.querySelectorAll('button')].find(b => b.textContent === '주변 보기');
  assert.ok(toggle);toggle.dispatchEvent(new f.win.Event('click', {bubbles: true}));await settle();
  assert.deepEqual(f.asked.filter(a => a[0].startsWith('doi')).map(a => a[0] + a[1]), ['doiIssues10.1/W5', 'doiReactions10.1/W5']);
  assert.ok(w5.nextElementSibling.matches('.sc-around') && w5.nextElementSibling.querySelector('.sc-around-status'));
  toggle.dispatchEvent(new f.win.Event('click', {bubbles: true}));
  assert.ok(!w5.nextElementSibling?.matches('.sc-around'), 'a second press closes it');
 } finally { f.bench.destroy(); }
});

test('around: every button inside the section that opens a page says so', async () => {
 const f = await aroundFixture({issues: aroundIssues('retracted', [{date: '2021-01-01', kind: 'retraction', source: 'Crossref', label: 'R', url: 'https://doi.org/10.1/r'}]),
  reactions: aroundReactions({bluesky: {count: 1, top: [{author: 'A', handle: 'a', text: 't', date: '', likes: 1, reposts: 0, replies: 0, url: 'https://bsky.app/profile/a/post/1'}]}})});
 try {
  await f.bench.show('related');await settle();
  const buttons = [...f.around().querySelectorAll('button')];
  const controls = b => b.classList.contains('sc-around-summary') || b.textContent === '다시 확인' || b.textContent.startsWith('더 보기');
  assert.ok(buttons.filter(b => !controls(b)).length >= 3);
  for (const b of buttons) if (!controls(b)) assert.equal(b.getAttribute('data-opens'), 'browser', b.textContent);
 } finally { f.bench.destroy(); }
});

test('around: the focused paper is one summary line until opened, and the choice is remembered', async () => {
 const f = await aroundFixture({issues: aroundIssues('retracted', [{date: '2021-01-01', kind: 'retraction', source: 'Crossref', label: 'R', url: ''}]),
  reactions: aroundReactions({bluesky: {count: 12, top: []}, hackerNews: {count: 1, top: []}, wikipedia: {count: 28, articles: []}})});
 try {
  await f.bench.show('related');await settle();
  const head = f.around().querySelector('.sc-around-summary');
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  assert.equal(f.around().querySelector('.sc-around-detail').hidden, true, 'the two groups wait');
  assert.equal(head.textContent.replace(/\s+/g, ' ').trim(), '이 논문 주변철회됨Bluesky 12Hacker News 1Wikipedia 28');
  assert.equal(head.querySelector('.sc-around-chip').dataset.status, 'retracted');
  head.dispatchEvent(new f.win.Event('click', {bubbles: true}));await settle();
  assert.equal(f.around().querySelector('.sc-around-detail').hidden, false);
  assert.equal(f.runtime.cache.workbenchUI.aroundOpen, true, 'remembered');
  await f.bench.show('explore');await f.bench.show('related');await settle();
  assert.equal(f.around().querySelector('.sc-around-summary').getAttribute('aria-expanded'), 'true', 'it opens as it was left');
 } finally { f.bench.destroy(); }
 const loading = await aroundFixture({issues: () => new Promise(() => {}), reactions: () => new Promise(() => {})});
 try {
  await loading.bench.show('related');await settle();
  assert.match(loading.around().querySelector('.sc-around-summary').textContent, /확인 중…/);
 } finally { loading.bench.destroy(); }
 const unknown = await aroundFixture({issues: aroundIssues('unknown', [], {failed: ['Crossref']}), reactions: aroundReactions({allFailed: true, failed: ['Bluesky']})});
 try {
  await unknown.bench.show('related');await settle();
  const text = unknown.around().querySelector('.sc-around-summary').textContent;
  assert.match(text, /확인 못함/);assert.match(text, /반응 확인 못함/);
 } finally { unknown.bench.destroy(); }
});

test('around: every related row offers 주변 보기, one open at a time, and a row without a DOI says why not', async () => {
 const f = await aroundFixture();
 f.runtime.doiIssues = async (doi, o) => { f.asked.push(['doiIssues', doi, o]); return new Promise((res, no) => o.signal?.addEventListener('abort', () => no(Object.assign(new Error('x'), {name: 'AbortError'})))); };
 f.runtime.doiReactions = async (doi, urls, o) => { f.asked.push(['doiReactions', doi, o]); return new Promise(() => {}); };
 const base = f.runtime.relatedWorksCached;
 f.runtime.relatedWorksCached = async (...a) => { const r = await base(...a); r.suggestions[0].inLibrary = true; r.suggestions.push({id: 'W9', source: 'related', title: 'No identifier', year: 2020, venue: 'J', authors: [], inLibrary: false}); return r; };
 try {
  await f.bench.show('related');await f.click('전체 목록');await settle();
  const rows = [...f.body().querySelectorAll('.sc-hits .sc-hit')];
  assert.ok(rows.length >= 3);
  const toggles = rows.map(r => r.querySelector('.sc-hit-around'));
  assert.ok(toggles.every(Boolean), 'owned and not owned alike');
  const bare = toggles[rows.findIndex(r => r.textContent.includes('No identifier'))];
  assert.equal(bare.disabled, true);assert.equal(bare.title, 'DOI가 없어 확인할 수 없습니다');
  toggles[0].dispatchEvent(new f.win.Event('click', {bubbles: true}));await settle();
  const first = f.asked.find(a => a[0] === 'doiIssues');
  assert.ok(rows[0].nextElementSibling.matches('.sc-around'));
  assert.equal(rows[0].nextElementSibling.querySelector('.sc-around-summary').getAttribute('aria-expanded'), 'true', 'a row opens in full');
  toggles[1].dispatchEvent(new f.win.Event('click', {bubbles: true}));await settle();
  assert.equal(first[2].signal.aborted, true, 'the first row\'s request is abandoned');
  assert.equal(f.body().querySelectorAll('.sc-hits .sc-around').length, 1, 'one at a time');
  assert.equal(rows[0].getAttribute('data-around'), null);assert.equal(rows[1].getAttribute('data-around'), 'open');
 } finally { f.bench.destroy(); }
});

test('around: an owned related row carries its 보유 chip in the meta line, so the path row keeps one layout', () => {
 // User direction 2026-10-03 (detail review): the chip used to stack above the 주변 보기 button in the actions column and shifted its y; it now leads the meta line.
 const css = fs.readFileSync(new URL('../content/workbench.css', import.meta.url), 'utf8');
 assert.match(css, /\.sc-hit-meta > \.sc-hit-owned \{/, 'the chip is styled as part of the meta line');
 assert.ok(!/\.sc-path-row:has\(> \.sc-hit-owned\)/.test(css), 'no second grid template for owned rows');
});

test('around: the Altmetric key is an optional password setting bound to its preference', async () => {
 const {default: api} = await import('../src/settings-schema.js');
 const field = api.schema.settings.find(s => s.key === 'altmetricKey');
 assert.ok(field, 'altmetricKey is in the schema');
 assert.equal(field.type, 'password');assert.equal(field.secret, true);assert.equal(field.default, '');
 assert.match(field.label, /선택/);assert.match(field.description, /Altmetric/);
 assert.match(fs.readFileSync(new URL('../prefs.js', import.meta.url), 'utf8'), /extensions\.style-custom\.altmetricKey/);
});

/* ---- 2026-10-03 round: researcher-persona review fixes ---- */
const toastOf=f=>f.bench.panel.querySelector('.sc-undo-toast');
const heldTimers=f=>{const timers=[],real=f.win.setTimeout;f.win.setTimeout=(fn,ms,...a)=>{timers.push([fn,ms]);return timers.length;};return {timers,restore:()=>{f.win.setTimeout=real;}};};

test('r20 seen marks are keyed by the work alone, and marks saved per library are folded in',async()=>{
 const f=fixture();
 f.runtime.cache.workbenchUI={...(f.runtime.cache.workbenchUI||{}),inboxSeen:{'1:10.1/shared':'2026-09-02T00:00:00Z','2:10.1/shared':'2026-09-05T00:00:00Z','1:10.1/other':'2026-09-03T00:00:00Z'}};
 f.runtime.watchedAuthorsByNews=()=>[{id:'A1',name:'First Person',seen:[],news:[{id:'W1',title:'Shared paper',doi:'10.1/shared',date:'2026-09-01'},{id:'W2',title:'Fresh one',doi:'10.1/fresh',date:'2026-09-01'}]}];
 await f.bench.show('authors');
 const titles=()=>[...f.body().querySelectorAll('.sc-author-inbox-row .sc-hit-title')].map(n=>(n.querySelector('.sc-hit-title-link')||n).textContent);
 assert.deepEqual(titles(),['Fresh one'],'a paper marked in library 1 is seen whichever library is open');
 assert.deepEqual(Object.keys(f.runtime.cache.workbenchUI.inboxSeen).sort(),['10.1/other','10.1/shared'],'old keys migrated, duplicates folded');
 assert.equal(f.runtime.cache.workbenchUI.inboxSeen['10.1/shared'],'2026-09-02T00:00:00Z','the earlier mark date wins');
 f.bench.destroy();
});

test('r20 the reading queue is keyed by library and item key, and a queue saved by numeric id is migrated',async()=>{
 const f=fixture();
 const known={1:{status:''},2:{status:''}};
 f.runtime.state=ref=>({citations:3,impactFactor:4,...known[ref.id]});
 f.runtime.cache.workbenchUI={...(f.runtime.cache.workbenchUI||{}),readingQueue:{'1:1':{at:new Date(Date.now()-2000).toISOString()}}};
 await f.bench.show('reading');
 assert.deepEqual(Object.keys(f.runtime.cache.workbenchUI.readingQueue),['1:K1'],'the numeric id became the item key');
 assert.equal(f.body().querySelectorAll('.sc-reading-queue-row').length,1,'and the paper still waits');
 f.bench.destroy();
});

test('r20 대기 해제, 그룹 삭제 and 뷰 삭제 each offer an undo that puts the thing back, for eight seconds',async()=>{
 const f=fixture();
 const known={1:{status:''},2:{status:''}};
 f.runtime.state=ref=>({citations:3,impactFactor:4,...known[ref.id]});
 f.runtime.cache.workbenchUI={...(f.runtime.cache.workbenchUI||{}),readingQueue:{'1:K1':{at:new Date(Date.now()-2000).toISOString(),people:['Ada']}}};
 await f.bench.show('reading');
 const held=heldTimers(f);
 await f.click('대기 해제');
 assert.equal(f.runtime.cache.workbenchUI.readingQueue['1:K1'],undefined,'taken off the queue');
 assert.equal(toastOf(f).hidden,false);assert.match(toastOf(f).textContent,/읽기 대기에서 뺐습니다/);
 assert.ok(held.timers.some(([,ms])=>ms===8000),'it stays eight seconds');
 await f.click('되돌리기');
 assert.deepEqual(f.runtime.cache.workbenchUI.readingQueue['1:K1'].people,['Ada'],'back, with who it came from');
 assert.equal(toastOf(f).hidden,true);
 // The strip goes by itself when its time is up.
 await f.bench.show('views');
 await f.click('삭제');
 assert.match(toastOf(f).textContent,/뷰 그룹 “View”을 지웠습니다/);
 held.timers.filter(([,ms])=>ms===8000).at(-1)[0]();
 assert.equal(toastOf(f).hidden,true,'expired');
 await f.click('삭제');
 await f.click('되돌리기');
 const undone=f.calls.find(c=>c[0]==='undeleteView');assert.equal(undone[1].id,'v1');
 await f.bench.show('tabs');
 await f.click('그룹 삭제');
 await f.click('되돌리기');
 assert.equal(f.calls.find(c=>c[0]==='undeleteTabs')[1].id,'g1');
 held.restore();f.bench.destroy();
});

test('r20 letting an author go keeps its two presses and also offers an undo that restores the row whole',async()=>{
 const f=fixture();
 const rows=[{id:'A1',name:'Ada',institution:'MIT',news:[{id:'W1'}],seen:['W0'],checkedAt:'2026-01-01T00:00:00Z'},{id:'A3',name:'Cy',institution:'',news:[],seen:[]}];
 f.runtime.watchedAuthors=()=>rows;f.runtime.watchedAuthorsByNews=()=>rows;
 f.runtime.unwatchAuthor=async id=>{const i=rows.findIndex(r=>r.id===id);if(i>=0)rows.splice(i,1);};
 f.runtime.restoreWatchedAuthor=async(row,at)=>{rows.splice(at,0,row);f.calls.push(['restoreRow',row.id,at]);return true;};
 await f.bench.show('authors');
 await f.click('목록 관리');
 const names=()=>[...f.body().querySelectorAll('.sc-watch-table td:first-child button')].map(b=>b.textContent);
 const sizeBefore=names().length;
 await f.click('해제');
 assert.equal(rows.length,2,'one press only arms it');
 await f.click('정말 해제');
 assert.equal(rows.length,1);
 assert.match(toastOf(f).textContent,/관심 저자에서 뺐습니다/);
 await f.click('되돌리기');
 assert.equal(rows.length,2,'the author is followed again');
 assert.deepEqual(rows.find(r=>r.id==='A1').seen,['W0'],'with the baseline it had');
 assert.equal(names().length,sizeBefore,'and the row is back in the list');
 f.bench.destroy();
});

test('r20 모두 확인함 marks what the inbox shows (its search included) in one write, with one undo',async()=>{
 const f=fixture();
 f.runtime.watchedAuthorsByNews=()=>[{id:'A1',name:'First Person',seen:[],news:[{id:'W1',title:'Alpha result',doi:'10.1/a1',date:'2026-09-03'},{id:'W2',title:'Beta result',doi:'10.1/b2',date:'2026-09-02'},{id:'W3',title:'Alpha again',doi:'10.1/a3',date:'2026-09-01'}]}];
 await f.bench.show('authors');await settle();
 const rowsShown=()=>f.body().querySelectorAll('.sc-author-inbox-row').length;
 assert.equal(rowsShown(),3);
 f.input('새 논문 검색','alpha');await new Promise(r=>setTimeout(r,160));await settle();
 assert.equal(rowsShown(),2);
 const flushes=()=>f.calls.filter(c=>c[0]==='flush').length,before=flushes();
 await f.click('모두 확인함');
 assert.deepEqual(Object.keys(f.runtime.cache.workbenchUI.inboxSeen).sort(),['10.1/a1','10.1/a3'],'only what was shown, not Beta');
 assert.equal(flushes()-before,1,'one save for the whole press');
 assert.match(toastOf(f).textContent,/2편을 확인함으로 옮겼습니다/);
 await f.click('되돌리기');
 assert.deepEqual(Object.keys(f.runtime.cache.workbenchUI.inboxSeen||{}),[],'one undo restores them all');
 f.bench.destroy();
});

test('r20 the selection bar copies citations, saves a collection named in the panel, and selects in Zotero',async()=>{
 const f=fixture();
 f.runtime.citationPanel=f.record('citationPanel',true);
 f.library.saveToCollection=f.record('saveToCollection',{id:'9',name:'Reading list',count:1});
 const picked=[];f.win.ZoteroPane.selectItems=async ids=>{picked.push(ids);};
 await f.bench.show('explore');
 f.bench.state.selected=new Set(['1']);await f.bench.render();
 const cite=f.findButton('인용 복사'),pick=f.findButton('Zotero에서 선택'),collect=f.findButton('컬렉션으로 저장');
 assert.ok(cite&&pick&&collect);
 assert.equal(cite.getAttribute('data-opens'),'dialog');assert.equal(pick.getAttribute('data-opens'),'pane','both are marked so the self-check never presses them');
 await f.click('인용 복사');
 const call=f.calls.find(c=>c[0]==='citationPanel');assert.equal(call[2][0].id,1,'the chosen paper as a Zotero item');
 await f.click('Zotero에서 선택');assert.deepEqual(picked,[[1]]);
 const row=f.bench.panel.querySelector('.sc-selection-collect');assert.equal(row.hidden,true);
 await f.click('컬렉션으로 저장');assert.equal(row.hidden,false,'the name is asked in the panel, no window');
 f.input('새 컬렉션 이름','Reading list');
 await f.click('만들고 담기');
 assert.deepEqual(f.calls.find(c=>c[0]==='saveToCollection').slice(1),['Reading list',['1']]);
 assert.equal(row.hidden,true);
 f.bench.destroy();
});

test('r20 an empty 보유 문헌 search offers the same words in ZotPoP',async()=>{
 const f=fixture();
 f.runtime.Z.ZotPoP={openSearch:(...a)=>f.calls.push(['zotpop',...a])};
 await f.bench.show('explore');
 f.input('작업 패널 검색','zzzz nothing here');await settle();
 const button=[...f.body().querySelectorAll('button')].find(b=>/^ZotPoP에서 ‘zzzz nothing here’ 찾기$/.test(b.textContent));
 assert.ok(button,'named with the query');assert.equal(button.getAttribute('data-opens'),'window');
 button.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 const call=f.calls.find(c=>c[0]==='zotpop');assert.deepEqual(call[2],{keywords:'zzzz nothing here'});
 f.bench.destroy();
});

test('r20 an unowned paper added from the inbox is redrawn as owned and can be put on 읽기 대기; the button names the collection and a duplicate is said',async()=>{
 const f=fixture();
 f.win.ZoteroPane.getSelectedCollection=()=>({id:7,name:'Review'});
 f.runtime.watchedAuthorsByNews=()=>[{id:'A1',name:'First Person',seen:[],news:[{id:'W1',title:'Brand new',doi:'10.1/brandnew',date:'2026-09-03'}]}];
 f.runtime.importWork=async work=>{f.calls.push(['import',work.doi]);return Object.assign([{id:55,key:'K55',libraryID:1,getField:()=>'Brand new'}],{existing:false,collectionName:'Review'});};
 await f.bench.show('authors');
 const add=f.findButton('추가 → Review');assert.ok(add,'the collection is named before the press');
 assert.match(add.getAttribute('title'),/Review/);
 await f.click('추가 → Review');
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/추가했습니다.*→ Review/,'and after it');
 assert.equal(f.findButton('추가 → Review'),undefined,'no stale 추가 left on the row');
 const queue=f.findButton('읽기 대기');assert.ok(queue,'the row is now an owned one, with 읽기 대기');
 await f.click('읽기 대기');
 assert.ok(f.runtime.cache.workbenchUI.readingQueue['1:K55'],'queued under the new item\'s library key');
 f.runtime.importWork=async()=>Object.assign([{id:1,getField:()=>'Paper Alpha'}],{existing:true,collectionName:''});
 f.bench.destroy();
});

test('r20 an import that finds the paper already held says so and does not claim to have added it',async()=>{
 const f=fixture();
 f.runtime.watchedAuthorsByNews=()=>[{id:'A1',name:'First Person',seen:[],news:[{id:'W1',title:'Brand new',doi:'10.1/brandnew',date:'2026-09-03'}]}];
 f.runtime.importWork=async()=>Object.assign([{id:1,key:'K1',getField:()=>'Paper Alpha'}],{existing:true,collectionName:''});
 await f.bench.show('authors');
 await f.click('추가');
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/이미 보유하고 있어 다시 가져오지 않았습니다/);
 f.bench.destroy();
});

test('r20 PDF 찾기 on a paper with no file asks Zotero for it, opens nothing, and says the outcome',async()=>{
 const f=fixture();
 f.runtime.attachmentFindings=async()=>({supplementary:[],duplicate:[],foreign:[],orphan:[],unknown:[],unread:0,missing:[{id:'4',title:'A paper with no file',year:'2024'}]});
 const asked=[];f.runtime.findPDF=async id=>{asked.push(id);return {status:asked.length>1?'found':'none'};};
 await f.bench.show('attachments');
 const find=f.findButton('PDF 찾기');assert.ok(find);assert.equal(find.getAttribute('data-opens'),'download','marked so the self-check does not fetch into the library');
 await f.click('PDF 찾기');
 assert.deepEqual(asked,['4']);
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/열려 있는 PDF를 찾지 못했습니다/);
 assert.equal(f.bench.panel.querySelector('.sc-status').dataset.error,'true');
 await f.click('PDF 찾기');
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/PDF를 찾아 붙였습니다/);
 f.bench.destroy();
});

test('F6/F7 a dead file link is listed apart with its stored path and no PDF 찾기; a program or a copy with a file stays out of the sweep',async()=>{
 const f=fixture();
 f.runtime.attachmentFindings=async()=>({supplementary:[],duplicate:[],foreign:[],orphan:[],unknown:[],unread:0,
  broken:[{id:'7',title:'Paper with a dead link',year:'2020',file:'gone.pdf',path:'/Users/x/Dropbox/old/gone.pdf',brokenID:'70'}],
  missing:[{id:'4',title:'A paper with no file',year:'2024',findable:true},{id:'5',title:'Some program',year:'2024',findable:false,why:'논문이 아니고 DOI·주소도 없어 PDF 찾기에서 뺐습니다'}]});
 const swept=[];f.runtime.findPDFs=async ids=>{swept.push(...ids);return {found:0,none:ids.length,failed:0,cancelled:false,done:ids.length,total:ids.length};};
 f.runtime.findPDF=async()=>({status:'none'});
 await f.bench.show('attachments');
 const text=f.bench.panel.textContent.replace(/\s+/g,' ');
 assert.match(text,/파일 연결 끊김 1/);
 assert.match(text,/저장된 경로: \/Users\/x\/Dropbox\/old\/gone\.pdf/);
 assert.match(text,/다시 연결/);
 const findButtons=[...f.bench.panel.querySelectorAll('button')].filter(b=>b.textContent==='PDF 찾기');
 assert.equal(findButtons.length,1,'only the findable paper offers PDF 찾기');
 await f.click('PDF 모두 찾기 · 1편');
 assert.deepEqual(swept,['4']);
 f.bench.destroy();
});

test('r21 논문 비교 evidence cells save per paper, reach the CSV, and 종합 노트 만들기 builds one note and selects it',async()=>{
 const f=fixture();
 const store={};
 f.runtime.evidenceOf=ref=>({species:'',construct:'',condition:'',control:'',result:'',limit:'',...(store[ref.id]||{})});
 f.runtime.setEvidence=async(ref,patch)=>{store[ref.id]={...(store[ref.id]||{}),...patch};};
 let made=null,opened=null;
 f.library.synthesisNote=async(entries,options)=>{made={entries,options};return '77';};
 f.library.openItem=async id=>{opened=id;};
 await f.bench.show('matrix');
 // Nothing written and no annotation chosen: no note.
 await f.click('종합 노트 만들기');assert.equal(made,null,'an empty note is not made');
 await f.click('근거 칸 추가');
 assert.deepEqual(f.runtime.cache.matrixFields.slice(-6),['ev_species','ev_construct','ev_condition','ev_control','ev_result','ev_limit']);
 const area=f.body().querySelector('textarea.sc-matrix-edit');assert.ok(area,'an evidence cell is a field to type in');
 area.value='E. coli K-12';area.dispatchEvent(new f.win.Event('change',{bubbles:true}));await settle();
 const id=Object.keys(store)[0];assert.equal(store[id].species||store[id][Object.keys(store[id])[0]],'E. coli K-12','saved on the paper');
 await f.click('CSV 복사');const csv=f.calls.filter(c=>c[0]==='copy').at(-1)[1];assert.match(csv,/생물종\/균주/);assert.match(csv,/E\. coli K-12/);
 await f.click('종합 노트 만들기');
 assert.equal(made.entries.length,1,'only the paper with evidence');
 assert.deepEqual(made.entries[0].evidence[0],['생물종/균주','E. coli K-12']);
 assert.equal(opened,'77','the note is selected in the pane');
 f.bench.destroy();
});

test('r21 a reading-queue entry with a reason from ZotPoP shows its one line',async()=>{
 const f=fixture();
 const known={1:{status:''},2:{status:''}};
 f.runtime.state=ref=>({citations:3,impactFactor:4,...known[ref.id]});
 f.runtime.cache.workbenchUI={...(f.runtime.cache.workbenchUI||{}),readingQueue:{'1:K1':{at:new Date(Date.now()-2000).toISOString(),people:[],reason:{text:'ZotPoP 검색: crispr',source:'zotpop'}}}};
 await f.bench.show('reading');
 assert.match(f.body().querySelector('.sc-reading-queue-row .sc-queue-why').textContent,/ZotPoP 검색: crispr/);
 f.bench.destroy();
});

test('r21 a paper with a published version offers 게재본 가져와 연결, or just 연결 when it is held',async()=>{
 const f=fixture();
 const published={doi:'10.9/pub',venue:'Nature',year:2025};
 let linked=false,held=null,connects=[];
 f.runtime.publishedStatus=async()=>({published,held,linked});
 f.runtime.connectPublished=async ref=>{connects.push(ref.id);linked=true;return {item:{getField:()=>'Pub title'},imported:!held,linked:true};};
 f.runtime.unlinkedPublished=async()=>[];
 f.setSelection([1]);
 await f.bench.show('explore');
 await f.click('자세히');await settle();
 assert.match(f.body().querySelector('.sc-paper-published').textContent,/게재됨 · Nature · 2025/);
 assert.ok([...f.body().querySelectorAll('.sc-published-connect')].some(b=>b.textContent==='게재본 가져와 연결'));
 await f.click('게재본 가져와 연결');await settle();
 assert.equal(connects.length,1);assert.match(f.body().textContent,/연결됨|이미 연결/);
 f.bench.destroy();
 linked=false;held={id:5};
 const g=fixture();
 g.runtime.publishedStatus=async()=>({published,held,linked:false});g.runtime.unlinkedPublished=async()=>[];
 g.setSelection([1]);await g.bench.show('explore');await g.click('자세히');await settle();
 assert.ok([...g.body().querySelectorAll('.sc-published-connect')].some(b=>b.textContent==='연결'),'already held: just 연결');
 g.bench.destroy();
});

test('r21 a group counts new papers once even when two followed authors share one, and the opened author shows the whole name',async()=>{
 const {f,rows}=expandFixture();
 rows[0].name='Ada Lovelace-Montgomery-Fitzgerald III';
 rows[2].news=[{id:'W1',title:'Genetic circuits at scale',venue:'Nature Biotechnology',date:'2026-09-02',doi:'10.1/n1',citations:12,position:'middle'},{id:'W3',title:'Another',venue:'Cell',date:'2026-09-03',doi:'10.1/n3'}];
 await f.bench.show('authors');await f.click('목록 관리');await f.click('분야');
 const head=[...f.body().querySelectorAll('.sc-watch-group-toggle')].map(t=>t.textContent.replace(/\s+/g,' ').trim()).find(t=>t.startsWith('Biotechnology'));
 assert.match(head,/새 논문 3$/,'W1 (shared), W2 and W3 are three papers, not four');
 const name=f.body().querySelector('tr.sc-watch-row[data-author-id="A1"] .sc-journal-name');
 assert.match(name.title,/Ada Lovelace-Montgomery-Fitzgerald III/,'the tooltip carries the whole name');
 f.body().querySelector('tr.sc-watch-row[data-author-id="A1"]').dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.ok(personOf(f).querySelector('.sc-person-inline-name'));
 f.bench.destroy();
});

test('r21 the journal header counts journals apart from the papers with no journal named',async()=>{
 const f=fixture();
 for(const n of [3,4,5]){f.papers.push({id:String(n),key:'K'+n,libraryID:1,title:'No venue '+n,venue:'',itemType:'journalArticle',tags:[]});f.refs.set(n,{id:n});}
 f.setSelection([]);
 await f.bench.show('journals');
 const head=f.body().querySelector('.sc-journal-reading-head').textContent.replace(/\s+/g,' ');
 assert.match(head,/저널 \d+종 · 저널 미기재 3편 · 문헌 \d+편/);
 assert.equal(Number(head.match(/저널 (\d+)종/)[1]),2,'Science and Nature; the unnamed group is not a journal');
 f.bench.destroy();
});

test('r22 노트로 옮기기 saves the memo, writes one tagged note, opens nothing and says so',async()=>{
 const f=fixture();
 const calls=[];
 f.library.setRemark=async(id,text)=>{calls.push(['setRemark',id,text]);return text;};
 f.library.memoToNote=async id=>{calls.push(['memoToNote',id]);return {created:true,text:'x'};};
 await f.bench.show('annotations');
 const button=f.findButton('노트로 옮기기');assert.ok(button);
 assert.equal(button.getAttribute('data-opens'),null,'it writes a note but opens no window');
 await f.click('노트로 옮기기');
 assert.deepEqual(calls.map(c=>c[0]),['setRemark','memoToNote'],'the shown text is saved first');
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/노트는 열지 않았습니다/);
 f.bench.destroy();
});

test('r22 the clean-up list: merge a preprint into its published version with an undo, view copies in the duplicates pane, find every PDF with a stop',async()=>{
 const f=fixture();
 f.runtime.attachmentFindings=async()=>({supplementary:[],duplicate:[],foreign:[],orphan:[],unknown:[],unread:0,
  missing:[{id:'4',title:'No file A',year:'2024'},{id:'5',title:'No file B',year:'2024'}]});
 f.runtime.cleanupFindings=async()=>({
  merge:[{id:'1',title:'Preprint',year:'2024',publishedID:'2',publishedTitle:'Published',linked:false}],
  copies:[{reason:'title',items:[{id:'7',title:'Hinge',year:'2020'},{id:'8',title:'Hinge',year:'2020'},{id:'9',title:'Hinge',year:'2020'}]}]});
 const log=[];
 f.runtime.mergePreprintIntoPublished=async id=>{log.push(['merge',id]);return {copied:{tags:2,status:'done',rating:null,memo:true,notes:1}};};
 f.runtime.restorePreprint=async id=>{log.push(['restore',id]);return true;};
 f.runtime.showInDuplicatesPane=async(win,lib,ids)=>{log.push(['dups',ids]);return {selected:true};};
 const sweep=[];
 f.runtime.findPDFs=async(ids,{onProgress})=>{sweep.push(ids);onProgress(0,ids.length);return {found:1,none:1,failed:0,cancelled:false,done:2,total:2};};
 await f.bench.show('attachments');
 const summary=f.bench.panel.querySelector('.sc-attachment-findings summary').textContent;
 assert.match(summary,/합칠 프리프린트 1/);assert.match(summary,/여러 번 보유 1/);
 await f.click('게재본으로 옮기기');
 assert.deepEqual(log[0],['merge','1']);
 const toast=f.bench.panel.querySelector('.sc-undo-toast');assert.ok(!toast.hidden);assert.match(toast.textContent,/게재본으로 합쳤습니다/);
 toast.querySelector('button').dispatchEvent(new f.win.Event('click'));await settle();
 assert.deepEqual(log.find(row=>row[0]==='restore'),['restore','1']);
 const dups=f.findButton('Zotero 중복 항목에서 보기');assert.equal(dups.getAttribute('data-opens'),'pane');
 await f.click('Zotero 중복 항목에서 보기');
 assert.deepEqual(log.find(row=>row[0]==='dups')[1],['7','8','9']);
 const all=f.findButton('PDF 모두 찾기 · 2편');assert.equal(all.getAttribute('data-opens'),'download','the self-check never presses it');
 assert.ok(f.findButton('중지'));
 await f.click('PDF 모두 찾기 · 2편');
 assert.deepEqual(sweep,[['4','5']]);
 assert.match(f.bench.panel.querySelector('.sc-status').textContent,/PDF 1편을 찾아 붙였습니다 · 못 찾음 1편/);
 f.bench.destroy();
});

test('r22 evidence drafts follow the paper, not its position: two same-title papers reordered keep each one text',async()=>{
 const f=fixture();
 const store={};
 f.runtime.evidenceOf=ref=>({species:'',construct:'',condition:'',control:'',result:'',limit:'',...(store[ref.id]||{})});
 f.runtime.setEvidence=async(ref,patch)=>{store[ref.id]={...(store[ref.id]||{}),...patch};};
 f.papers.splice(0,2,{id:'1',key:'KA',libraryID:1,title:'Same title',authors:'A',year:'2025',itemType:'journalArticle',tags:[]},{id:'2',key:'KB',libraryID:1,title:'Same title',authors:'B',year:'2024',itemType:'journalArticle',tags:[]});
 f.setSelection([]);f.bench.state.selected=new Set();
 f.runtime.cache.matrixFields=['title','ev_species'];
 await f.bench.show('matrix');
 const areas=()=>[...f.body().querySelectorAll('textarea.sc-matrix-edit')];
 assert.equal(areas().length,2);
 areas()[0].value='only for A';areas()[0].dispatchEvent(new f.win.Event('input',{bubbles:true}));
 assert.notEqual(areas()[0].dataset.draftKey,areas()[1].dataset.draftKey);
 assert.match(areas()[0].dataset.draftKey,/KA/,'keyed by library and item key');
 f.papers.reverse();
 await f.bench.load();await f.bench.render();
 assert.equal(areas().length,2);
 assert.equal(areas()[0].value,'','paper B (now first) shows nothing');
 assert.equal(areas()[1].value,'only for A','paper A keeps its text in its new place');
 f.bench.destroy();
});

test('r22 the last evidence edit reaches the CSV and the synthesis note even while its save is pending',async()=>{
 const f=fixture();
 const store={};let release;const gate=new Promise(r=>{release=r;});
 f.runtime.evidenceOf=ref=>({species:'',construct:'',condition:'',control:'',result:'',limit:'',...(store[ref.id]||{})});
 f.runtime.setEvidence=async(ref,patch)=>{await gate;store[ref.id]={...(store[ref.id]||{}),...patch};};
 let made=null;f.library.synthesisNote=async entries=>{made=entries;return '77';};f.library.openItem=async()=>{};
 f.runtime.cache.matrixFields=['title','ev_species'];
 await f.bench.show('matrix');
 const area=f.body().querySelector('textarea.sc-matrix-edit');
 area.value='typed last';area.dispatchEvent(new f.win.Event('input',{bubbles:true}));
 await f.click('CSV 복사');
 assert.match(f.calls.filter(c=>c[0]==='copy').at(-1)[1],/typed last/,'the CSV carries the in-memory value');
 area.dispatchEvent(new f.win.Event('change',{bubbles:true}));
 const pressed=f.click('종합 노트 만들기');
 await settle();assert.equal(made,null,'export waits for the pending save');
 release();await pressed;await settle();
 assert.ok(made,'note made after the save');
 assert.deepEqual(made[0].evidence[0],['생물종/균주','typed last']);
 f.bench.destroy();
});

test('r22 모두 확인함 undo also restores the older seen marks the 3,000 cap evicted, and keeps later changes',async()=>{
 const seen={};for(let n=0;n<3000;n++)seen['old/'+String(n).padStart(4,'0')]=new Date(Date.UTC(2020,0,1)+n*1000).toISOString();
 const f=fixture({items:{},readerSettings:{},workbenchUI:{inboxSeen:{...seen}}});
 f.runtime.watchedAuthorsByNews=()=>[{id:'A1',name:'First Person',seen:[],news:[{id:'W1',title:'Alpha result',doi:'10.1/a1',date:'2026-09-03'},{id:'W2',title:'Beta result',doi:'10.1/b2',date:'2026-09-02'}]}];
 await f.bench.show('authors');await settle();
 await f.click('모두 확인함');
 let now=f.runtime.cache.workbenchUI.inboxSeen;
 assert.equal(Object.keys(now).length,3000);assert.ok(!('old/0000' in now)&&!('old/0001' in now),'the two oldest were pushed out');
 f.runtime.cache.workbenchUI={...f.runtime.cache.workbenchUI,inboxSeen:(()=>{const o={...now,'later/x':new Date().toISOString()};delete o['old/1500'];return o;})()};
 await f.click('되돌리기');
 now=f.runtime.cache.workbenchUI.inboxSeen;
 assert.ok('old/0000' in now&&'old/0001' in now,'evicted marks are back');
 assert.ok(!('10.1/a1' in now)&&!('10.1/b2' in now));
 assert.ok('later/x' in now&&!('old/1500' in now),'changes made after the press are kept');
 f.bench.destroy();
});

// ---- 관계 그래프 범위: 컬렉션 · 논문 하나 ----
function scopeFixture(ui){
 const f=fixture({items:{},readerSettings:{marginAnnotations:true},workbenchUI:{lastTab:'graph',...ui}});
 const extra=[10,11,12,13].map(n=>({...f.papers[0],id:String(n),key:'K'+n,title:'Scope paper '+n,authors:'Ada Lovelace',venue:'Science'}));
 for(const n of [10,11,12,13])f.refs.set(n,{id:n,libraryID:1,key:'K'+n});
 f.library.snapshot=async()=>[...f.papers,...extra];
 const works={'1:K1':{openalex:'W1',references:['W10','W11','G1','G2']},'1:K10':{openalex:'W10',references:['G1']},'1:K11':{openalex:'W11',references:['W10','G1','G2']},
  '1:K12':{openalex:'W12',references:['W1','G1']},'1:K13':{openalex:'W13',references:['W12','G2']},'1:K2':{openalex:'W2',references:[]}};
 f.runtime.graphTools=PaperGraph;f.runtime.paperWorks=()=>works;f.runtime.journalIdentity=JournalIdentity;
 f.runtime.identity=ref=>'1:'+(ref.key||'K'+ref.id);
 f.runtime.cache.workMeta={G1:{id:'G1',title:'Ghost number one',year:2001,doi:'10.1/g1',citations:99},G2:{id:'G2',title:'Ghost number two',year:2005}};
 f.store={};f.runtime.citedByStore=()=>f.store;f.fetches=0;
 f.runtime.sweepCitedBy=async(items,o)=>{f.fetches++;f.limit=o&&o.limit;f.store['1:K1']={openalex:'W1',citers:[{id:'C1',title:'A later paper',year:2025,citations:3}]};return {found:1,citers:1,errors:0};};
 f.library.collections=async()=>[{id:'40',name:'Project',count:2,itemIDs:[10,11],parentID:null},{id:'41',name:'Methods',count:2,itemIDs:[12,13],parentID:'40'},{id:'42',name:'Other',count:1,itemIDs:[2],parentID:null}];
 f.click=text=>{const b=[...f.bench.panel.querySelectorAll('button')].find(x=>x.textContent.includes(text));b?.dispatchEvent(new f.bench.panel.ownerDocument.defaultView.Event('click',{bubbles:true}));return b;};
 return f;
}
test('the graph tab has a scope control, and the one-paper graph draws solid shelf nodes and hollow ghosts, asking OpenAlex only when told to',async()=>{
 const f=scopeFixture({graphKind:'paper',graphPaper:'1'})
 await f.bench.show('graph');await settle();
 const panel=f.bench.panel;
 assert.deepEqual([...panel.querySelectorAll('.sc-graph-scope [data-graph-kind]')].map(b=>b.textContent),['라이브러리','컬렉션','논문 하나']);
 assert.equal(panel.querySelector('[data-graph-kind=paper]').getAttribute('aria-pressed'),'true');
 const circles=[...panel.querySelectorAll('svg.sc-graph circle')];
 assert.equal(circles.filter(c=>c.getAttribute('data-ghost')).length,2,'G1 and G2 are hollow');
 assert.equal(circles.length,1+2+1+2,'the paper, W10 and W11, the citer W12, two ghosts');
 const heads=[...panel.querySelectorAll('.sc-scope-lists .sc-section-head')].map(h=>h.textContent.replace(/\s+/g,' ').trim());
 assert.deepEqual(heads,['이 논문이 인용 4','이 논문을 인용 1','내 문헌 3']);
 assert.equal(f.fetches,0,'drawing the graph asks nothing');
 const ask=f.click('외부 인용 논문도 보기');
 assert.ok(ask,'the button is there');
 await settle();
 assert.equal(f.fetches,1,'one request, on the press');assert.equal(f.limit,50);
 assert.equal([...f.bench.panel.querySelectorAll('svg.sc-graph circle')].filter(c=>c.getAttribute('data-ghost')).length,3,'the fetched citer is a ghost now');
 assert.equal([...f.bench.panel.querySelectorAll('button')].some(b=>b.textContent.includes('외부 인용 논문도 보기')),false,'a stored answer is not asked for again');
 await f.bench.show('graph');await settle();assert.equal(f.fetches,1,'redrawing never asks');
 f.bench.destroy();
});
test('the one-paper graph list: a ghost offers the shared add and find actions, a click focuses its row, depth 2 is a toggle',async()=>{
 const f=scopeFixture({graphKind:'paper',graphPaper:'1'});
 await f.bench.show('graph');await settle();
 const ghostRow=[...f.bench.panel.querySelectorAll('.sc-scope-lists [data-node-id="W:G1"]')][0];
 assert.ok(ghostRow,'the ghost is listed');
 assert.match(ghostRow.textContent,/Ghost number one/);
 assert.ok([...ghostRow.querySelectorAll('button')].some(b=>/가져오기|추가|저장/.test(b.textContent)),'a ghost with a DOI can be added');
 const nodeG=[...f.bench.panel.querySelectorAll('svg.sc-graph g[role=button]')].find(g=>/Ghost number one/.test(g.getAttribute('aria-label')));
 nodeG.dispatchEvent(new f.bench.panel.ownerDocument.defaultView.Event('click',{bubbles:true}));
 assert.equal(f.bench.panel.querySelector('.sc-scope-lists [data-node-id="W:G1"]').getAttribute('aria-current'),'true');
 assert.equal(f.bench.panel.querySelector('.sc-graph-info').hidden,false);
 f.bench.destroy();
 const g=scopeFixture({graphKind:'paper',graphPaper:'10',graphDepth2:false});
 await g.bench.show('graph');await settle();
 const before=g.bench.panel.querySelectorAll('svg.sc-graph circle').length;
 const toggle=[...g.bench.panel.querySelectorAll('.sc-graph-scope .sc-check input')].find(i=>i.getAttribute('aria-label')==='2단계(내 문헌만)');
 toggle.checked=true;toggle.dispatchEvent(new g.bench.panel.ownerDocument.defaultView.Event('change',{bubbles:true}));await settle();
 assert.ok(g.bench.panel.querySelectorAll('svg.sc-graph circle').length>before,'second-step shelf papers join');
 assert.equal(g.runtime.cache.workbenchUI.graphDepth2,true);
 g.bench.destroy();
});
test('the paper and collection pickers search in the page, pick by keyboard or click, and remember the choice',async()=>{
 const f=scopeFixture({graphKind:'paper'});
 await f.bench.show('graph');await settle();
 const panel=f.bench.panel,win=panel.ownerDocument.defaultView;
 assert.ok(panel.querySelector('.sc-pick-panel'),'an in-page picker, not a window');
 const search=panel.querySelector('.sc-pick-panel input[type=search]');
 search.value='Scope paper 12';search.dispatchEvent(new win.Event('input',{bubbles:true}));
 const options=[...panel.querySelectorAll('.sc-pick-option')];
 assert.equal(options.length,1);
 search.dispatchEvent(Object.assign(new win.Event('keydown',{bubbles:true}),{key:'Enter'}));await settle();
 assert.equal(f.runtime.cache.workbenchUI.graphPaper,'12','Enter on the search picks the first match');
 assert.match(panel.querySelector('.sc-pick-value').textContent,/Scope paper 12/);
 panel.querySelector('[data-graph-kind=collection]').dispatchEvent(new win.Event('click',{bubbles:true}));await settle();
 assert.equal(f.runtime.cache.workbenchUI.graphKind,'collection');
 const opts=[...panel.querySelectorAll('.sc-pick-option .sc-pick-text')].map(o=>o.textContent);
 assert.deepEqual(opts,['Other','Project','Methods'],'the tree, subcollection under its parent');
 panel.querySelector('.sc-pick-option[data-value="40"]').dispatchEvent(new win.Event('click',{bubbles:true}));await settle();
 assert.equal(f.runtime.cache.workbenchUI.graphCollection,'40');
 f.bench.destroy();
 // A new session starts where the reader left off.
 const again=scopeFixture({...f.runtime.cache.workbenchUI});
 await again.bench.show('graph');await settle();
 assert.equal(again.bench.panel.querySelector('[data-graph-kind=collection]').getAttribute('aria-pressed'),'true');
 assert.match(again.bench.panel.querySelector('.sc-pick-value').textContent,/Project/);
 again.bench.destroy();
});
function crowd(f,from,count,refs){
 const base=f.runtime.paperWorks(),snap=f.library.snapshot,more=[],works={...base};
 for(let n=from;n<from+count;n++){more.push({...f.papers[0],id:String(n),key:'K'+n,title:'Crowd paper '+n,authors:'Ada Lovelace',venue:'Science'});f.refs.set(n,{id:n,libraryID:1,key:'K'+n});works['1:K'+n]={openalex:'W'+n,references:refs(n)};}
 f.library.snapshot=async()=>[...await snap(),...more];f.runtime.paperWorks=()=>works;return more;
}
test('F2: the outside-cited ranking reads every paper in the collection, not just the first 180 drawn',async()=>{
 const f=scopeFixture({graphKind:'collection',graphCollection:'40',graphSub:false});
 const more=crowd(f,100,200,n=>n>=290?['TOPX','TOPY']:['x'+n]);
 f.library.collections=async()=>[{id:'40',name:'Project',count:200,itemIDs:more.map(m=>Number(m.id)),parentID:null}];
 await f.bench.show('graph');await settle();
 const heads=[...f.bench.panel.querySelectorAll('.sc-scope-lists .sc-section-head')].map(h=>h.textContent.replace(/\s+/g,' ').trim());
 assert.ok(heads.includes('이 컬렉션이 많이 인용하는 바깥 논문 2'),'papers 280-299 sit past the 180 drawn but still count: '+heads.join('|'));
 f.bench.destroy();
});
test('F9: a one-paper graph whose lists are cut at 60 nodes says how many more there are inside each list',async()=>{
 const f=scopeFixture({graphKind:'paper',graphPaper:'1'});
 crowd(f,100,80,()=>['W1']);
 await f.bench.show('graph');await settle();
 const more=[...f.bench.panel.querySelectorAll('.sc-scope-lists .sc-list-more')].map(b=>b.textContent.replace(/\s+/g,' ').trim());
 assert.ok(more.length>=1&&more.every(t=>/편 더 \(모두 보기\)/.test(t)),'each cut list offers the rest: '+more.join('|'));
 f.click('편 더 (모두 보기)');await settle();
 assert.equal(f.bench.panel.querySelectorAll('.sc-scope-lists .sc-list-more').length,0,'all shown, nothing left to offer');
 f.bench.destroy();
});
test('the collection graph draws only that folder, with its tiles, lists and the outside works it cites most; sub-collections are a toggle',async()=>{
 const f=scopeFixture({graphKind:'collection',graphCollection:'40',graphSub:false});
 await f.bench.show('graph');await settle();
 const panel=f.bench.panel;
 const tiles=()=>[...panel.querySelectorAll('.sc-overview-fact')].map(t=>t.textContent.replace(/\s+/g,' ').trim());
 assert.deepEqual(tiles(),['2 논문','1 연결','1 묶음','0 연결 없는 논문']);
 const shelfNodes=[...panel.querySelectorAll('svg.sc-graph circle')].filter(c=>!c.getAttribute('data-ghost'));
 assert.equal(shelfNodes.length,2,'only the two papers in the folder');
 const outside=[...panel.querySelectorAll('.sc-scope-lists .sc-section-head')].map(h=>h.textContent.replace(/\s+/g,' ').trim());
 assert.ok(outside.includes('이 컬렉션이 많이 인용하는 바깥 논문 1'),'G1 is cited by both, G2 once is not ranked');
 assert.ok(outside.includes('컬렉션 안에서 가장 많이 인용된 논문 1'));
 assert.equal(f.fetches,0);
 const sub=[...panel.querySelectorAll('.sc-graph-scope .sc-check input')].find(i=>i.getAttribute('aria-label')==='하위 컬렉션 포함');
 sub.checked=true;sub.dispatchEvent(new panel.ownerDocument.defaultView.Event('change',{bubbles:true}));await settle();
 assert.equal(f.runtime.cache.workbenchUI.graphSub,true);
 assert.equal(tiles()[0],'4 논문','with sub-collections the folder holds four papers');
 assert.equal([...panel.querySelectorAll('svg.sc-graph circle')].filter(c=>!c.getAttribute('data-ghost')).length,4);
 f.click('관련 문헌');await settle();
 assert.ok(panel.querySelector('svg.sc-graph'),'the other modes still draw in a collection scope');
 f.bench.destroy();
});

test('every button whose handler writes to the library carries data-writes, and the self-check sweep skips by it in any language',async()=>{
 const src=fs.readFileSync(new URL('../src/workbench.js',import.meta.url),'utf8');
 const listed=new Set([...src.match(/WRITES_LIBRARY=new Set\(\[(.*?)\]\)/s)[1].matchAll(/'([^']+)'/g)].map(m=>m[1]));
 const writers=/library\.(setRemark|addTags|removeTags|restoreTags|noteFromAnnotations|createNote|unrelate|relate|trashItems|synthesisNote|saveToCollection|renameTagBranch|recolorAnnotations|mergeAnnotations|memoToNote)\(|runtime\.(importWork|trashAttachments|mergePreprintIntoPublished)\(/;
 const missing=[];
 for(const chunk of src.split(/(?=\bbutton\()/).slice(1)){
  const label=chunk.match(/^button\('([^']+)'/);
  /* the handler is what follows up to the next button; cut at a blank-level boundary by taking the first 1500 chars */
  const body=chunk.slice(0,1500).split(/\n\s*(?:const|let|function)\s/)[0].split(/\bbutton\(/).slice(0,2).join('');/* the first piece is empty: the chunk starts at button( */
  if(writers.test(body)&&!(label&&listed.has(label[1]))&&!/data-writes/.test(chunk.slice(0,1500).split(/\n\s*const\s/)[0]))missing.push(label?label[1]:chunk.slice(0,60));
 }
 assert.deepEqual(missing,[],'writers not marked');
 /* Plugin-state writers (boards, cards, views, tab groups, queue, filters, seen marks, settings) are caught by the handler's own source. */
 const cacheHandler=new RegExp(src.match(/WRITES_CACHE_HANDLER=\/(.*)\/;/)[1]);
 const stateWriters=/runtime\.dirty=true|runtime\.flush\(|\bsaveUI\(|\bsetSeen(Many)?\(|\bsetReadingQueue\(|\breader\.(save|delete|rename|update|apply|restore|close|move|set)\w*\(|\bmodel\.(create|delete|restore|addTo|addBoard|removeCard|link|unlink|rename|update)\w*\(/;
 const uncaught=[];
 for(const chunk of src.split(/(?=\bbutton\()/).slice(1)){
  const body=chunk.slice(0,900).split(/\bbutton\(/).slice(0,2).join('');
  if(stateWriters.test(body)&&!cacheHandler.test(body)&&!/data-writes|data-opens/.test(body))uncaught.push(chunk.slice(0,60));
 }
 assert.deepEqual(uncaught,[],'state writers the sweep would press');
 const f=fixture();
 await f.bench.show('annotations');
 const move=f.findButton('노트로 옮기기');
 assert.equal(move.getAttribute('data-writes'),'library');
 move.textContent='Move to note';
 assert.equal(move.hasAttribute('data-writes'),true,'English text or Korean, the attribute documents it');
 assert.notEqual(move.getAttribute('data-safe'),'view','and the sweep presses only data-safe buttons, so this one is never pressed');
 assert.equal(/Move to note/.test(move.textContent)&&!/가져오기|노트로|옮기기/.test(move.textContent),true,'the English label is not matched by the Korean verbs');
 f.bench.destroy();
});

test('a bulk PDF search survives a re-render: stop stays, start is off, no second run, destroy cancels',async()=>{
 const f=fixture();
 f.runtime.attachmentFindings=async()=>({supplementary:[],duplicate:[],foreign:[],orphan:[],unknown:[],unread:0,
  missing:[{id:'4',title:'No file A',year:'2024'},{id:'5',title:'No file B',year:'2024'}]});
 f.runtime.cleanupFindings=async()=>({merge:[],copies:[]});
 let runs=0,signal=null,release;
 f.runtime.findPDFs=(ids,{signal:s})=>{runs++;signal=s;return new Promise(resolve=>{release=()=>resolve({found:0,none:2,failed:0,cancelled:false,done:2,total:2});s.addEventListener('abort',()=>resolve({found:0,none:0,failed:0,cancelled:true,done:0,total:2}));});};
 await f.bench.show('attachments');
 await f.click('PDF 모두 찾기 · 2편');
 assert.equal(runs,1);
 await f.bench.render();await settle();
 const stop=f.findButton('중지');assert.ok(stop&&!stop.hidden,'the stop button is back after the panel redraws');
 const start=f.findButton('PDF 모두 찾기 · 2편');assert.equal(start.disabled,true,'start is off while the search runs');
 start.dispatchEvent(new f.win.Event('click'));await settle();
 assert.equal(runs,1,'a second click does not run the same papers again');
 f.bench.destroy();await settle();
 assert.equal(signal.aborted,true,'closing the panel cancels the search');
});

test('the graph collection picker follows the library: no previous library list, stale answers dropped, a new list redraws',async()=>{
 const f=fixture();
 const gate={};
 f.library.collections=(lib)=>new Promise(resolve=>{gate[lib]=()=>resolve(lib===1?[{id:'4',name:'Lib one coll',count:2,parentID:null}]:[{id:'40',name:'Lib two coll',count:1,parentID:null}]);});
 f.bench.state.graphKind='collection';
 await f.bench.show('graph');
 gate[1]();await settle();await settle();
 assert.match(f.body().textContent,/Lib one coll/);
 f.setLibrary(2);
 await f.bench.render();await settle();
 assert.ok(!/Lib one coll/.test(f.body().textContent),'the other library collections are not offered');
 gate[2]();await settle();await settle();
 assert.match(f.body().textContent,/Lib two coll/,'the new list is drawn when it arrives');
 f.bench.destroy();
});

test('two collection papers that share only an outside work are drawn with it, not dropped as isolated',async()=>{
 const f=scopeFixture({graphKind:'collection',graphCollection:'41',graphSub:false});
 const works=f.runtime.paperWorks();
 works['1:K12']={openalex:'W12',references:['W9']};works['1:K13']={openalex:'W13',references:['W9']};
 f.runtime.cache.workMeta.W9={id:'W9',title:'Shared outside work',year:2010,citations:5};
 await f.bench.show('graph');await settle();
 const panel=f.bench.panel;
 const circles=[...panel.querySelectorAll('svg.sc-graph circle')];
 assert.equal(circles.filter(c=>!c.getAttribute('data-ghost')).length,2,'both papers are on the map');
 assert.equal(circles.filter(c=>c.getAttribute('data-ghost')).length,1,'with the work they share');
 assert.match(panel.textContent,/Shared outside work/);
 f.bench.destroy();
});

test('an adopted note text replaces the editor text, so the next keystroke keeps the remote part',async()=>{
 const f=fixture();
 const saves=[];
 f.library.setRemark=async(id,text)=>{saves.push(text);return saves.length===1?'remote part\n---\n'+text:text;};
 await f.bench.show('annotations');
 const memo=f.body().querySelector('textarea.sc-annot-memo');
 memo.value='mine';memo.dispatchEvent(new f.win.Event('input',{bubbles:true}));memo.dispatchEvent(new f.win.Event('blur'));
 await settle();
 assert.equal(memo.value,'remote part\n---\nmine','the editor shows what was stored');
 memo.value=memo.value+' more';memo.dispatchEvent(new f.win.Event('input',{bubbles:true}));memo.dispatchEvent(new f.win.Event('blur'));
 await settle();
 assert.equal(saves[1],'remote part\n---\nmine more','the merged part is not deleted by the next save');
 f.bench.destroy();
});

test('text typed while a save that adopts the note runs is preserved in the editor',async()=>{
 const f=fixture(),saving=deferred();
 f.library.setRemark=async(id,text)=>{await saving.promise;return 'remote\n---\n'+text;};
 await f.bench.show('annotations');
 const memo=f.body().querySelector('textarea.sc-annot-memo');
 memo.value='mine';memo.dispatchEvent(new f.win.Event('input',{bubbles:true}));memo.dispatchEvent(new f.win.Event('blur'));
 await settle();
 memo.value='mine plus typing';
 saving.resolve();await settle();
 assert.equal(memo.value,'mine plus typing');
 f.bench.destroy();
});

test('the self-check sweep leaves every button that writes plugin state alone (boards, views, queue, settings), by attribute not wording',async()=>{
 const board={id:'b1',name:'Board one',nodes:[{id:'n1',label:'Card',x:1,y:1,note:'',color:'#ffffff'}],edges:[]};
 const f=fixture({items:{},readerSettings:{},boards:[board],favoriteCollections:['4'],matrixFields:['title','authors','venue']});
 const pressed=[],bad=[],snap=()=>JSON.stringify(f.runtime.cache,(k,v)=>k==='lastTab'||k==='workbenchUI'?undefined:v);/* lastTab and workbenchUI are only where and how the panel was left: the sweep restores them */
 for(const [tab] of Workbench.TABS){
  await f.bench.show(tab);
  /* what the sweep presses: no verb list at all, as in a UI language the list does not know */
  const buttons=SelfCheck.safeButtons(f.bench.panel);
  for(const b of buttons.slice(0,40)){
   const before=snap(),flushes=f.calls.filter(c=>['remark','addTags','removeTags','relate','trashItems'].includes(c[0])).length;
   if(!b.isConnected)continue;
   if(process.env.DBG)console.error('PRESS',tab,b.textContent.trim().slice(0,40));
   b.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
   const after=snap(),flushed=f.calls.filter(c=>['remark','addTags','removeTags','relate','trashItems'].includes(c[0])).length;
   pressed.push(tab+' · '+b.textContent.trim());
   if(after!==before||flushed!==flushes){bad.push(tab+' · '+b.textContent.trim());if(process.env.DBG)console.error('CHG',before.slice(-300),'\n',after.slice(-300));}
   if(f.bench.state.tab!==tab)await f.bench.show(tab);
  }
 }
 assert.deepEqual(bad,[],'buttons that save plugin state without data-writes');
 assert.ok(pressed.length>=3,'the sweep really presses buttons: '+pressed.length);
 await f.bench.show('canvas');
 for(const label of ['보드 만들기','보드 삭제'])assert.equal([...f.bench.panel.querySelectorAll('button')].find(b=>b.textContent.trim()===label)?.getAttribute('data-writes'),'cache',label);
 f.bench.destroy();
});

test('the collection graph counts a group formed only through an outside work (A to W and B to W is one group)',async()=>{
 const f=scopeFixture({graphKind:'collection',graphCollection:'40',graphSub:false});
 const more=crowd(f,100,2,()=>['TOPX']);
 f.library.collections=async()=>[{id:'40',name:'Project',count:2,itemIDs:more.map(m=>Number(m.id)),parentID:null}];
 await f.bench.show('graph');await settle();
 const tiles=[...f.bench.panel.querySelectorAll('.sc-overview-fact')].map(t=>t.textContent.replace(/\s+/g,' ').trim());
 assert.ok(tiles.includes('1 묶음'),'both papers meet at the outside work: '+tiles.join('|'));
 assert.ok(tiles.includes('0 연결 없는 논문'),tiles.join('|'));
 f.bench.destroy();
});

/* The self-check presses ONLY buttons marked data-safe="view". This runs the real sweep (SelfCheck.sweepSafeButtons) over the
   fixture panel in both locales with a spy on every write path: not one may be called, and nothing but the panel's own
   remembered view may change in the cache. */
const WRITE_NAMES=/^(edit|saveTx|save|pref|indexItems|importWork|watchAuthor|unwatchAuthor|markSeen|setSeen|setSeenMany|setReadingQueue|queueForReading|resolveNamesake|acceptUnverified|rejectUnverified|remark|setRemark|memoToNote|resolveMemoConflict|addTags|removeTags|restoreTags|relate|unrelate|trashItems|createNote|extract|synthesis|mergeAnnotations|recolor|savePalette|applyPalette|deletePalette|theme|margin|color|sidebar|vertical|css|customFields|clearNews|moveTab|closeOtherTabs|renameTabGroup|updateTabGroup|renameView|updateView|setMarginOptions|resetAppearance|restoreTabs|applyView|deleteBoard|restoreBoard|trash|merge|mergePreprintIntoPublished|restorePreprint|findPDFs|writes)$/i;
for(const locale of ['ko-KR','en-US']){
 test(`self-check sweep (${locale}): only data-safe="view" buttons are pressed and no write path is touched`,async()=>{
  const i18n=require('../src/i18n.js');
  try{
   const board={id:'b1',name:'Board one',nodes:[{id:'n1',label:'Card',x:1,y:1,note:'',color:'#ffffff'}],edges:[]};
   const f=fixture({items:{},readerSettings:{},boards:[board],favoriteCollections:['4'],matrixFields:['title','authors','venue']},undefined,{locale});
   const writes=[];
   // Extra spies on write paths the fixture does not record.
   for(const name of ['edit','setSeen','setSeenMany','setReadingQueue','queueForReading','resolveNamesake','acceptUnverified','rejectUnverified','indexItems','mergePreprintIntoPublished','restorePreprint','memoToNote','resolveMemoConflict'])f.runtime[name]=async(...a)=>{writes.push([name,...a]);return true;};
   f.runtime.Z.FullText={indexItems:async(...a)=>{writes.push(['FullText.indexItems',...a]);}};
   for(const ref of f.refs.values())ref.saveTx=async()=>{writes.push(['saveTx',ref.id]);};
   for(const lib of ['setRemark','resolveMemoConflict','memoToNote','setTags','createNote','trashItems'])if(typeof f.library[lib]==='function'){const real=f.library[lib];f.library[lib]=async(...a)=>{writes.push(['library.'+lib,...a]);return real(...a);};}
   // Unverified namesake works for a watched author: the approve / reject buttons exist and are never pressed.
   const person={id:'A1',name:'Ann Author',institution:'Somewhere',seen:[],news:[{id:'W4',title:'Fresh paper',doi:'10.1/f',date:'2026-09-01',places:[]}],works:[],unverified:[{id:'W3',title:'Namesake paper',doi:'10.1/n',date:'2020-01-01',places:['Elsewhere']}]};
   f.runtime.watchedAuthors=()=>[person];f.runtime.watchedAuthorsByNews=()=>[person];
   const tabs=Workbench.TABS.map(([key])=>key);
   const uiBefore=JSON.stringify(f.runtime.cache.workbenchUI||{});
   const rest=()=>JSON.stringify(f.runtime.cache,(k,v)=>k==='workbenchUI'||k==='lastTab'?undefined:k==='items'&&v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([,row])=>Object.keys(row).length)):v);/* reading a paper creates its empty row: not a change */
   const dataBefore=rest(),callsBefore=f.calls.length;
   const labelsSeen=new Set(),unsafeSeen=[];
   for(const tab of tabs){await f.bench.show(tab);await f.bench.load();for(const b of f.bench.panel.querySelectorAll('.sc-body button')){labelsSeen.add(b.textContent.trim());if(b.getAttribute('data-safe')!=='view')unsafeSeen.push(b.textContent.trim());}}
   const {pressed,broken}=await SelfCheck.sweepSafeButtons({bench:f.bench,runtime:f.runtime,tabs,wait:()=>settle()});
   assert.deepEqual(broken,[],'a press must never surface a JavaScript error');
   assert.ok(pressed>=3,'the sweep really presses the marked view buttons: '+pressed);
   assert.deepEqual(writes,[],'no write path was called');
   const newCalls=f.calls.slice(callsBefore).filter(c=>WRITE_NAMES.test(String(c[0])));
   assert.deepEqual(newCalls,[],'no recorded write call: '+JSON.stringify(newCalls.map(c=>c[0])));
   assert.equal(rest(),dataBefore,'nothing but the panel view changed in the cache');
   assert.equal(JSON.stringify(f.runtime.cache.workbenchUI||{}),uiBefore,'the remembered view was put back');
   // The cases the review found are present in this locale and none is data-safe.
   const find=text=>[...f.bench.panel.querySelectorAll('button')].filter(b=>b.textContent.trim()===text);
   const tr=k=>locale==='en-US'?(require('../src/strings.js').en[k]||k):k;
   const L={yes:tr('이 저자의 논문입니다'),no:tr('다른 사람입니다'),pdf:tr('PDF 찾기'),sepia:tr('세피아 PDF'),apply:tr('패널 CSS 적용'),seen:tr('확인함')};
   if(locale==='en-US')assert.notEqual(L.yes,'이 저자의 논문입니다','the English label really is English');
   await f.bench.show('authors');await f.bench.load();
   for(const key of ['yes','no','seen']){const hit=find(L[key]);assert.ok(hit.length,'rendered: '+L[key]);for(const b of hit)assert.notEqual(b.getAttribute('data-safe'),'view',L[key]);}
   for(const tab of ['attachments','explore','reading','appearance']){await f.bench.show(tab);await f.bench.load();for(const key of ['pdf','sepia','apply'])for(const b of find(L[key]))assert.notEqual(b.getAttribute('data-safe'),'view',L[key]);}
   assert.ok(unsafeSeen.length>20,'most buttons are not marked, and so are skipped whatever their wording: '+unsafeSeen.length);
   assert.deepEqual(SelfCheck.safeButtons(f.bench.panel).filter(b=>b.hasAttribute('data-writes')||b.hasAttribute('data-opens')).map(b=>b.textContent),[],'a view button never also writes or opens');
   f.bench.destroy();
  }finally{i18n.use('ko-KR');}
 });
}

test('every data-safe view button handler is free of library, cache and setting writes (saveUI alone remembers the view)',()=>{
 const src=fs.readFileSync(new URL('../src/workbench.js',import.meta.url),'utf8');
 const forbidden=/library\.\w+\(|runtime\.(importWork|edit|flush|set[A-Z]\w*|queue\w*|watch\w*|resolve\w*|merge\w*|dirty\s*=[^=])|Prefs\.set|\bsetSeen|\bsetReadingQueue|\bqueueForReading|\bsaveWatchOptions|\bputQuick|\bdropQuick|\breader\.\w+\(|\bmodel\.\w+\(|FullText|saveTx|\.edit\(/;
 const lines=src.split('\n').filter(line=>/viewButton\(|'data-safe':'view'/.test(line)&&!/const viewButton=/.test(line));
 assert.ok(lines.length>=40,'the marked buttons: '+lines.length);
 const bad=lines.filter(line=>forbidden.test(line.replace(/saveUI\(\{[^}]*\}\)/g,'')));
 assert.deepEqual(bad.map(l=>l.trim().slice(0,100)),[],'a view button must only change what is shown');
 const sc=fs.readFileSync(new URL('../src/selfcheck.js',import.meta.url),'utf8');
 assert.match(sc,/button\[data-safe="view"\]/,'the self-check selects by the allowlist attribute');
 assert.doesNotMatch(sc.slice(sc.indexOf('function safeButtons'),sc.indexOf('const api = {')),/skip\s*=|가져오기|data-writes/,'and keeps no verb or attribute blocklist');
});

test('a memo/note conflict shows both texts under the memo and the user\'s button decides; nothing resolves itself',async()=>{
 const f=fixture();
 let conflict={local:'my memo',remote:'text from the note'};
 const resolved=[];
 f.library.memoConflict=async()=>conflict;
 f.library.resolveMemoConflict=async(id,choice,seen)=>{resolved.push([id,choice,seen]);conflict=null;return {resolved:true,text:choice==='note'?seen.remote:choice==='local'?seen.local:seen.remote+'\n\n--\n'+seen.local};};
 await f.bench.show('annotations');await settle();
 const box=f.bench.panel.querySelector('.sc-memo-conflict');
 assert.ok(box,'the conflict box is under the memo editor');
 assert.match(box.textContent,/다른 곳에서 바뀐 노트가 있습니다/);
 assert.match(box.textContent,/my memo/);assert.match(box.textContent,/text from the note/);
 const labels=[...box.querySelectorAll('button')].map(b=>b.textContent);
 assert.deepEqual(labels,['노트 내용 쓰기','이 메모 쓰기','둘 다 합치기']);
 assert.equal(resolved.length,0,'nothing is written until a button is pressed');
 for(const b of box.querySelectorAll('button'))assert.notEqual(b.getAttribute('data-safe'),'view');
 await f.click('둘 다 합치기');
 assert.deepEqual(resolved[0].slice(0,2),['1','both']);assert.deepEqual(resolved[0][2],{local:'my memo',remote:'text from the note'},'what the box showed is what the choice is checked against');
 assert.equal(f.bench.panel.querySelector('.sc-memo-conflict'),null,'the box goes away once resolved');
 assert.equal(f.body().querySelector('textarea.sc-annot-memo').value,'text from the note\n\n--\nmy memo');
 f.bench.destroy();
});

test('choosing 노트 내용 쓰기 clears the old local draft and the autosave baseline: the old text does not come back',async()=>{
 const key=JSON.stringify(['remark',1,'1']);
 const f=fixture({items:{},workbenchDrafts:{version:1,entries:[[key,'my memo']]}});
 let conflict={local:'my memo',remote:'text from the note'};
 const saves=[];
 f.library.memoConflict=async()=>conflict;
 f.library.resolveMemoConflict=async(id,choice,seen)=>{conflict=null;return {resolved:true,text:seen.remote};};
 f.library.setRemark=async(id,text)=>{saves.push(text);return text;};
 await f.bench.show('annotations');await settle();
 const memo=f.body().querySelector('textarea.sc-annot-memo');
 memo.value='my memo';memo.dispatchEvent(new f.win.Event('input',{bubbles:true}));memo.dispatchEvent(new f.win.Event('blur'));await settle();
 saves.length=0;
 await f.click('노트 내용 쓰기');await settle();
 assert.equal(memo.value,'text from the note');
 assert.ok(!f.runtime.cache.workbenchDrafts.entries.some(([k,v])=>k===key||v==='my memo'),'the stale draft is gone '+JSON.stringify(f.runtime.cache.workbenchDrafts.entries));
 memo.dispatchEvent(new f.win.Event('blur'));await settle();
 assert.deepEqual(saves,[],'nothing is written back on blur');
 memo.value='my memo';memo.dispatchEvent(new f.win.Event('input',{bubbles:true}));memo.dispatchEvent(new f.win.Event('blur'));await settle();
 assert.deepEqual(saves,['my memo'],'typing the old text again is a real edit and is saved (the autosave baseline moved)');
 f.bench.destroy();
});

test('a conflict already settled in another window: pressing 노트 내용 쓰기 syncs the editor to the latest text, and typing after it never writes the old text back',async()=>{
 const f=fixture();
 let conflict={local:'L',remote:'R'};
 const saves=[];
 f.library.memoConflict=async()=>conflict;
 f.library.resolveMemoConflict=async()=>({resolved:false,conflict:null,text:'R'});
 f.library.setRemark=async(id,text)=>{saves.push(text);return text;};
 await f.bench.show('annotations');await settle();
 const memo=f.body().querySelector('textarea.sc-annot-memo');
 assert.equal(memo.value,'');
 memo.value='L';
 await f.click('노트 내용 쓰기');
 assert.equal(memo.value,'R','the editor takes the latest text');
 saves.length=0;
 memo.dispatchEvent(new f.win.Event('blur'));await settle();
 assert.deepEqual(saves,[],'R is the baseline: nothing is written back');
 memo.value='R and more';memo.dispatchEvent(new f.win.Event('input',{bubbles:true}));memo.dispatchEvent(new f.win.Event('blur'));await settle();
 assert.deepEqual(saves,['R and more'],'only what was typed after the sync is saved');
 f.bench.destroy();
});

test('노트 내용 쓰기 that finishes after the panel was redrawn updates the editor that is on screen now and keeps what was typed since',async()=>{
 const f=fixture();
 let release;const gate=new Promise(r=>{release=r;});
 const conflict={local:'L',remote:'R'};
 const saves=[];
 f.library.memoConflict=async()=>conflict;
 f.library.resolveMemoConflict=async()=>{await gate;return {resolved:true,conflict:null,text:'R'};};
 f.library.setRemark=async(id,text)=>{saves.push(text);return text;};
 await f.bench.show('annotations');await settle();
 const old=f.body().querySelector('textarea.sc-annot-memo');
 old.value='L';old.dispatchEvent(new f.win.Event('input',{bubbles:true}));
 saves.length=0;
 const pending=f.click('노트 내용 쓰기');
 await f.bench.show('annotations');await settle();
 const fresh=f.body().querySelector('textarea.sc-annot-memo');
 assert.notEqual(fresh,old);assert.ok(!old.isConnected);
 assert.equal(fresh.value,'L','the redraw restores the draft');
 release();await pending;await settle();
 assert.equal(fresh.value,'R','the editor on screen takes the note text');
 fresh.dispatchEvent(new f.win.Event('blur'));await settle();
 assert.deepEqual(saves.filter(v=>v!=='R'),[],'the old text is not written back to memo or note: '+JSON.stringify(saves));
 // Typed while a second request ran: it stays.
 let release2;const gate2=new Promise(r=>{release2=r;});
 f.library.resolveMemoConflict=async()=>{await gate2;return {resolved:true,conflict:null,text:'R'};};
 fresh.value='X';
 const second=f.click('노트 내용 쓰기');
 fresh.value='X typed meanwhile';
 release2();await second;await settle();
 assert.equal(fresh.value,'X typed meanwhile');
 f.bench.destroy();
});

// A library whose setRemark is the real compare-and-swap rule over the shared cache (what runtime.memoStaleWrite does).
function casLibrary(f){
 f.library.setRemark=async(id,text,opts={})=>{
  f.calls.push(['setRemark',String(id),text,opts.base]);
  const row=f.runtime.cache.items[id]||={},stored=String(row.remark||'');
  if(opts.base!==undefined&&stored!==String(opts.base)&&stored!==text)return {stale:true,stored,conflict:{local:text,remote:stored}};
  row.remark=text;return text;
 };
}
const casType=(f,el,value)=>{el.value=value;el.dispatchEvent(new f.win.Event('input',{bubbles:true}));};
const casWritten=f=>f.calls.filter(c=>c[0]==='setRemark').map(c=>c[2]);

test('memo CAS (bug 2): the list-detail 읽기 메모 editor is a CAS writer: a memo that changed under it is never overwritten by 메모 저장',async()=>{
 const f=fixture();casLibrary(f);
 await f.bench.show('explore');await f.click('자세히');
 const field=f.body().querySelector('[aria-label="읽기 메모"]');
 assert.equal(field.dataset.memoItem,'1','the editor is found by syncMemoEditors');
 casType(f,field,'L');
 f.runtime.cache.items[1].remark='R'; // 노트 내용 쓰기 completed meanwhile
 f.findButton('메모 저장').dispatchEvent(new f.win.Event('click'));await settle();
 assert.equal(f.runtime.cache.items[1].remark,'R','nothing was written over the memo');
 const box=f.body().querySelector('.sc-memo-stale');
 assert.ok(box,'both texts are shown');assert.match(box.textContent,/R/);assert.match(box.textContent,/L/);
 assert.equal(field.value,'L','what was typed is kept');
 f.bench.destroy();
});

test('memo CAS (bug 2): a completion that lands while the list detail is open updates that editor, and an untouched one is not a conflict',async()=>{
 const f=fixture();casLibrary(f);
 f.library.memoConflict=async()=>({local:'L',remote:'R'});
 f.library.resolveMemoConflict=async()=>{f.runtime.cache.items[1].remark='R';return {resolved:true,conflict:null,text:'R'};};
 f.runtime.cache.items[1]={remark:'L'};
 await f.bench.show('explore');await f.click('자세히');
 const field=f.body().querySelector('[aria-label="읽기 메모"]');
 assert.equal(field.value,'L');
 f.runtime.cache.items[1].remark='R';
 field.value='L2';
 f.findButton('메모 저장').dispatchEvent(new f.win.Event('click'));await settle();
 assert.equal(f.runtime.cache.items[1].remark,'R');
 assert.ok(f.body().querySelector('.sc-memo-stale'));
 await f.click('저장된 메모 쓰기');
 assert.equal(field.value,'R');assert.equal(f.body().querySelector('.sc-memo-stale'),null);
 casType(f,field,'R and more');f.findButton('메모 저장').dispatchEvent(new f.win.Event('click'));await settle();
 assert.equal(f.runtime.cache.items[1].remark,'R and more','after loading the stored memo the editor is current again');
 f.bench.destroy();
});

test('memo CAS (bug 3): a leftover draft built on an older memo is not put back into the editor or autosaved; it is kept as a card',async()=>{
 const f=fixture();casLibrary(f);
 await f.bench.show('annotations');await settle();
 const old=f.body().querySelector('textarea.sc-paper-memo');
 casType(f,old,'L'); // draft saved with base ''
 f.calls.length=0;
 f.runtime.cache.items[1].remark='R'; // 노트 내용 쓰기 completed; the draft was left behind
 await f.bench.show('explore');await settle();
 await f.bench.show('annotations');await settle();
 const fresh=f.body().querySelector('textarea.sc-paper-memo');
 assert.notEqual(fresh,old);
 assert.equal(fresh.value,'R','the editor shows the stored memo, not the old draft');
 const card=f.body().querySelector('.sc-memo-kept-card');
 assert.ok(card,'the draft waits as a kept card');assert.match(card.textContent,/L/);
 assert.equal(f.body().querySelector('.sc-memo-stale'),null,'no conflict box for a draft');
 fresh.dispatchEvent(new f.win.Event('blur'));await settle();
 assert.deepEqual(casWritten(f),[],'the blur autosave writes nothing: '+JSON.stringify(f.calls));
 assert.equal(f.runtime.cache.items[1].remark,'R');
 await f.click('입력칸에 넣기');
 assert.equal(fresh.value,'L','now it is ordinary unsaved input');
 assert.equal(f.body().querySelector('.sc-memo-kept-card'),null,'the card is gone once loaded');
 assert.equal(f.runtime.cache.items[1].remark,'R','loading it wrote nothing');
 fresh.dispatchEvent(new f.win.Event('blur'));await settle();
 assert.equal(f.body().querySelector('.sc-memo-stale')!==null||f.runtime.cache.items[1].remark==='L',true);
 f.bench.destroy();
});

test('memo CAS (bug 3 sequence): 노트 내용 쓰기 pressed with a saved draft, tab switched before it finishes: the draft is never written over the result',async()=>{
 const f=fixture();casLibrary(f);
 let release;const gate=new Promise(r=>{release=r;});
 f.library.memoConflict=async()=>({local:'L',remote:'R'});
 f.library.resolveMemoConflict=async()=>{await gate;f.runtime.cache.items[1].remark='R';return {resolved:true,conflict:null,text:'R'};};
 await f.bench.show('annotations');await settle();
 const old=f.body().querySelector('textarea.sc-paper-memo');
 casType(f,old,'L');
 const pending=f.click('노트 내용 쓰기');
 await f.bench.show('explore');await settle();
 release();await pending;await settle();
 f.calls.length=0;
 await f.bench.show('annotations');await settle();
 const fresh=f.body().querySelector('textarea.sc-paper-memo');
 fresh.dispatchEvent(new f.win.Event('blur'));await settle();
 assert.equal(f.runtime.cache.items[1].remark,'R');
 assert.ok(!casWritten(f).includes('L'),'L is never written: '+JSON.stringify(casWritten(f)));
 f.bench.destroy();
});

test('memo CAS: a reading-list row editor with a stale base is refused and the row stays open',async()=>{
 const f=fixture();casLibrary(f);
 f.runtime.cache.items[1]={seconds:125,lastRead:new Date().toISOString(),remark:'Check'};
 f.runtime.pageProgress=ref=>ref.id===1?{pages:{4:60},total:20,visited:5,percent:25,attachmentID:100,lastPageIndex:4}:{pages:{},total:0,visited:0,percent:0};
 await f.bench.show('reading');
 f.body().querySelector('.sc-resume-remark').click();
 const field=f.body().querySelector('.sc-resume-memo-editor textarea');
 f.runtime.cache.items[1].remark='Changed elsewhere';
 field.value='Check, and more';field.dispatchEvent(new f.win.Event('input',{bubbles:true}));field.dispatchEvent(new f.win.Event('blur'));await settle();
 assert.equal(f.runtime.cache.items[1].remark,'Changed elsewhere');
 assert.ok(f.body().querySelector('.sc-resume-memo-editor .sc-memo-stale'),'the two texts are shown in the row');
 assert.equal(f.body().querySelector('.sc-resume-memo-editor textarea'),field,'the editor stays');
 await f.click('둘 다 합치기');
 assert.equal(f.runtime.cache.items[1].remark,'Changed elsewhere\n\nCheck, and more');
 f.bench.destroy();
});

test('memo CAS: a second bench with an older editor can only make a conflict, never overwrite the first bench\'s save',async()=>{
 const f=fixture();const g=fixture(f.runtime.cache);casLibrary(f);casLibrary(g);
 await f.bench.show('annotations');await settle();await g.bench.show('annotations');await settle();
 const a=f.body().querySelector('textarea.sc-paper-memo'),b=g.body().querySelector('textarea.sc-paper-memo');
 casType(f,a,'from A');a.dispatchEvent(new f.win.Event('blur'));await settle();
 assert.equal(f.runtime.cache.items[1].remark,'from A');
 casType(g,b,'from B');b.dispatchEvent(new g.win.Event('blur'));await settle();
 assert.equal(f.runtime.cache.items[1].remark,'from A','B did not overwrite A');
 assert.ok(g.body().querySelector('.sc-memo-stale'),'B sees a conflict');
 assert.equal(b.value,'from B');
 f.bench.destroy();g.bench.destroy();
});

test('memo CAS: fast typing in one editor is not a conflict with itself (saves are chained and the base follows each answer)',async()=>{
 const f=fixture();casLibrary(f);
 await f.bench.show('annotations');await settle();
 const el=f.body().querySelector('textarea.sc-paper-memo');
 for(const v of ['a','ab','abc']){casType(f,el,v);el.dispatchEvent(new f.win.Event('blur'));}
 await settle();
 assert.equal(f.runtime.cache.items[1].remark,'abc');assert.equal(f.body().querySelector('.sc-memo-stale'),null);
 f.bench.destroy();
});

test('memo CAS: the AI memo suggestion is applied only over the memo it was made for',async()=>{
 const src=fs.readFileSync(new URL('../src/workbench.js',import.meta.url),'utf8');
 assert.match(src,/library\.setRemark\(item\.id,output\.value,\{base:state\.aiMemoBase\}\)/);
});

test('memo CAS (P1-1): a save that returns the adopted note text does not move the base when the reader typed since: the next save is a conflict',async()=>{
 const f=fixture();casLibrary(f);
 f.runtime.cache.items[1]={remark:'L'};
 let release;const gate=new Promise(r=>{release=r;});
 const cas=f.library.setRemark;
 f.library.setRemark=async(id,text,opts)=>{if(text==='L1'){await gate;f.runtime.cache.items[1].remark='R';return 'R';}return cas(id,text,opts);};
 await f.bench.show('annotations');await settle();
 const el=f.body().querySelector('textarea.sc-paper-memo');
 assert.equal(el.value,'L');
 casType(f,el,'L1');el.dispatchEvent(new f.win.Event('blur'));await settle();
 el.value='L2'; // typed while the save is pending
 release();await settle();
 assert.equal(el.value,'L2');
 el.dispatchEvent(new f.win.Event('blur'));await settle();
 assert.equal(f.runtime.cache.items[1].remark,'R','L2 did not overwrite the adopted memo');
 assert.ok(f.body().querySelector('.sc-memo-stale'),'it is a conflict');
 f.bench.destroy();
});

test('memo CAS (P1-2): the conflict buttons write what the textarea holds when they are pressed, not the text the box was drawn with',async()=>{
 const f=fixture();casLibrary(f);
 await f.bench.show('annotations');await settle();
 const el=f.body().querySelector('textarea.sc-paper-memo');
 casType(f,el,'L');f.runtime.cache.items[1].remark='R';el.dispatchEvent(new f.win.Event('blur'));await settle();
 assert.ok(f.body().querySelector('.sc-memo-stale'));
 el.value='L+NEW';
 await f.click('이 편집 내용 쓰기');
 assert.equal(f.runtime.cache.items[1].remark,'L+NEW');assert.equal(el.value,'L+NEW');
 f.runtime.cache.items[1].remark='R2';
 casType(f,el,'X');el.dispatchEvent(new f.win.Event('blur'));await settle();
 el.value='X+Y';
 await f.click('둘 다 합치기');
 assert.equal(f.runtime.cache.items[1].remark,'R2\n\nX+Y');
 // 저장된 메모 쓰기 does not discard text the box never showed.
 f.runtime.cache.items[1].remark='R3';
 casType(f,el,'Z');el.dispatchEvent(new f.win.Event('blur'));await settle();
 el.value='Z and unseen';
 await f.click('저장된 메모 쓰기');
 assert.equal(el.value,'Z and unseen','typed text is kept');
 assert.equal(f.runtime.cache.items[1].remark,'R3');
 f.bench.destroy();
});

test('memo CAS (P1-3): text typed while a conflict choice is saving is kept as a draft and survives a redraw',async()=>{
 const f=fixture();casLibrary(f);
 await f.bench.show('annotations');await settle();
 const el=f.body().querySelector('textarea.sc-paper-memo');
 casType(f,el,'L');f.runtime.cache.items[1].remark='R';el.dispatchEvent(new f.win.Event('blur'));await settle();
 let release;const gate=new Promise(r=>{release=r;});
 const cas=f.library.setRemark;
 f.library.setRemark=async(id,text,opts)=>{await gate;return cas(id,text,opts);};
 const pending=f.click('이 편집 내용 쓰기');
 await settle();
 casType(f,el,'L+MORE');
 release();await pending;await settle();
 assert.equal(f.runtime.cache.items[1].remark,'L');
 assert.equal(el.value,'L+MORE','the textarea keeps what was typed');
 await f.bench.show('annotations');await settle();
 assert.equal(f.body().querySelector('textarea.sc-paper-memo').value,'L+MORE','after a redraw the typed text is still there');
 f.bench.destroy();
});

test('memo CAS (P1-4): 이 메모 쓰기 pressed while a save is pending waits for it and the newest input, and never deletes that input or its draft',async()=>{
 const f=fixture();
 const row=()=>f.runtime.cache.items[1]||={};
 let note='R',conflict=null,gateFirst,hold=true;const gate=new Promise(r=>{gateFirst=r;});
 f.runtime.cache.items[1]={remark:'L'};conflict={local:'L',remote:'R'};
 f.library.memoConflict=async()=>conflict&&{...conflict};
 f.library.setRemark=async(id,text,opts={})=>{
  const stored=String(row().remark||'');
  if(opts.base!==undefined&&stored!==String(opts.base)&&stored!==text)return {stale:true,stored,conflict:{local:text,remote:stored}};
  row().remark=text;if(hold&&text==='L'){hold=false;await gate;}
  conflict=text!==note?{local:text,remote:note}:null;return text;
 };
 f.library.memoToNote=async()=>({created:false,text:row().remark,conflict:!!conflict});
 f.library.resolveMemoConflict=async(id,choice,seen)=>{
  if(!conflict||seen.local!==conflict.local||seen.remote!==conflict.remote)return {resolved:false,stale:true,conflict:conflict&&{...conflict},text:row().remark};
  if(choice==='local')note=row().remark;else if(choice==='note')row().remark=note;
  conflict=null;return {resolved:true,conflict:null,text:row().remark};
 };
 await f.bench.show('annotations');await settle();
 const el=f.body().querySelector('textarea.sc-paper-memo');
 assert.equal(el.value,'L');
 const move=f.click('노트로 옮기기'); // its save is delayed
 await settle();
 casType(f,el,'L2');el.dispatchEvent(new f.win.Event('blur'));
 const choose=f.click('이 메모 쓰기');
 await settle();
 gateFirst();await move;await choose;await settle();
 assert.equal(el.value,'L2','the newest input stays in the editor');
 assert.equal(row().remark,'L2','and was saved');
 assert.equal(note,'R','the choice, made for a conflict that no longer existed, wrote nothing to the note');
 assert.ok(f.body().querySelector('.sc-memo-conflict'),'the conflict is reopened with the new texts');
 f.bench.destroy();
});

test('memo CAS (P1-4b): a conflict choice with unsaved typed text keeps that text',async()=>{
 const f=fixture();
 const row=()=>f.runtime.cache.items[1]||={};
 f.runtime.cache.items[1]={remark:'L'};let note='R',conflict={local:'L',remote:'R'};
 f.library.memoConflict=async()=>conflict&&{...conflict};
 f.library.setRemark=async(id,text)=>{row().remark=text;conflict=text!==note?{local:text,remote:note}:null;return text;};
 f.library.resolveMemoConflict=async(id,choice,seen)=>{
  if(!conflict||seen.local!==conflict.local||seen.remote!==conflict.remote)return {resolved:false,stale:true,conflict:conflict&&{...conflict},text:row().remark};
  if(choice==='note')row().remark=note;conflict=null;return {resolved:true,conflict:null,text:row().remark};
 };
 await f.bench.show('annotations');await settle();
 const el=f.body().querySelector('textarea.sc-paper-memo');
 casType(f,el,'L typed, autosave not yet fired');
 await f.click('노트 내용 쓰기');
 assert.ok(el.value.includes('L typed')||row().remark.includes('L typed'),'the typed text is not discarded: editor='+el.value+' memo='+row().remark);
 assert.notEqual(el.value,'R');
 f.bench.destroy();
});

test('memo CAS (P2-2): a save that completes after a redraw leaves the kept draft alone, through later saves and redraws',async()=>{
 const f=fixture();
 let release;const gate=new Promise(r=>{release=r;});
 const row=()=>f.runtime.cache.items[1]||={};
 let first=true;
 f.library.setRemark=async(id,text,opts={})=>{
  const stored=String(row().remark||'');
  if(opts.base!==undefined&&stored!==String(opts.base)&&stored!==text)return {stale:true,stored,conflict:{local:text,remote:stored}};
  row().remark=text;if(first&&text==='AB'){first=false;await gate;}return text;
 };
 await f.bench.show('annotations');await settle();
 const old=f.body().querySelector('textarea.sc-paper-memo');
 casType(f,old,'AB');old.dispatchEvent(new f.win.Event('blur'));await settle();
 casType(f,old,'ABC');
 await f.bench.show('annotations');await settle();
 const fresh=f.body().querySelector('textarea.sc-paper-memo');
 assert.equal(fresh.value,'AB');
 assert.match(f.body().querySelector('.sc-memo-kept-card').textContent,/ABC/);
 release();await settle();
 assert.match(f.body().querySelector('.sc-memo-kept-card').textContent,/ABC/,'the save completing does not touch it');
 casType(f,fresh,'ABD');fresh.dispatchEvent(new f.win.Event('blur'));await settle();
 assert.equal(row().remark,'ABD');
 assert.match(f.body().querySelector('.sc-memo-kept-card').textContent,/ABC/,'nor does the next save');
 await f.bench.show('annotations');await settle();
 assert.match(f.body().querySelector('.sc-memo-kept-card').textContent,/ABC/,'nor a redraw');
 assert.ok(JSON.stringify(f.runtime.cache.memoKept).includes('ABC'),'it is in the cache');
 await f.click('버리기');
 assert.equal(f.body().querySelector('.sc-memo-kept-card'),null);
 assert.equal(f.runtime.cache.memoKept&&Object.keys(f.runtime.cache.memoKept).length,0,'only 버리기 removed it');
 f.bench.destroy();
});

test('memo CAS (P1-5): a note change that arrives during 메모 저장 makes the editor show it, so the next save cannot overwrite it with the old text',async()=>{
 const f=fixture();casLibrary(f);
 f.runtime.cache.items[1]={remark:'A'};
 const cas=f.library.setRemark;
 f.library.setRemark=async(id,text,opts)=>{const out=await cas(id,text,opts);f.runtime.cache.items[1].remark='R';return 'R';}; // the outside change R is adopted by the note sync
 await f.bench.show('explore');await f.click('자세히');
 let field=f.body().querySelector('[aria-label="읽기 메모"]');
 casType(f,field,'DRAFT'); // a draft typed over A ...
 f.runtime.cache.items[1].remark='B'; // ... and the memo changed under it
 await f.bench.show('explore');if(!f.body().querySelector('[aria-label="읽기 메모"]'))await f.click('자세히');
 field=f.body().querySelector('[aria-label="읽기 메모"]');
 assert.equal(field.value,'B','the editor shows the stored memo; the draft waits as a kept card');
 assert.ok(f.body().querySelector('.sc-memo-kept-card'));
 f.findButton('메모 저장').dispatchEvent(new f.win.Event('click'));await settle();
 assert.equal(field.value,'R','the editor shows what is stored');
 f.library.setRemark=cas;
 f.findButton('메모 저장').dispatchEvent(new f.win.Event('click'));await settle();
 assert.equal(f.runtime.cache.items[1].remark,'R');
 // The base never moves to text the editor does not show: with other text typed during the save, the next save is a conflict.
 f.runtime.cache.items[1]={remark:'R'};
 let release;const gate=new Promise(r=>{release=r;});
 f.library.setRemark=async(id,text,opts)=>{await gate;f.runtime.cache.items[1].remark='R2';return 'R2';};
 field.value='R';field.dispatchEvent(new f.win.Event('input',{bubbles:true}));
 const pending=f.findButton('메모 저장');pending.dispatchEvent(new f.win.Event('click'));await settle();
 field.value='typed meanwhile';release();await settle();
 f.library.setRemark=cas;
 f.findButton('메모 저장').dispatchEvent(new f.win.Event('click'));await settle();
 assert.equal(f.runtime.cache.items[1].remark,'R2','not overwritten');
 assert.ok(f.body().querySelector('.sc-memo-stale'));
 f.bench.destroy();
});

test('memo CAS (P2-3): 둘 다 합치기 closes its box, so the merge cannot be applied twice, and a kept draft is not merged by it',async()=>{
 const f=fixture();casLibrary(f);
 await f.bench.show('annotations');await settle();
 const el=f.body().querySelector('textarea.sc-paper-memo');
 casType(f,el,'L');f.runtime.cache.items[1].remark='R';el.dispatchEvent(new f.win.Event('blur'));await settle();
 const both=f.findButton('둘 다 합치기');
 both.dispatchEvent(new f.win.Event('click'));await settle();
 assert.equal(f.runtime.cache.items[1].remark,'R\n\nL');
 assert.equal(f.body().querySelector('.sc-memo-stale'),null,'the box is closed by its own success');
 both.dispatchEvent(new f.win.Event('click'));await settle();
 assert.equal(f.runtime.cache.items[1].remark,'R\n\nL','a second press of the old button writes nothing more');
 // A restored draft never gets merge buttons: it is a kept card.
 casType(f,el,'D');f.runtime.cache.items[1].remark='R9';
 await f.bench.show('annotations');await settle();
 assert.equal(f.findButton('둘 다 합치기'),undefined);assert.ok(f.body().querySelector('.sc-memo-kept-card'));
 f.bench.destroy();
});

test('kept drafts: the card survives redraws, saves and follows and goes only with 입력칸에 넣기 or 버리기; 입력칸에 넣기 is ordinary unsaved input over the usual CAS',async()=>{
 const f=fixture();casLibrary(f);
 f.runtime.cache.memoKept={'key-1':[{id:'k1',text:'KEPT ONE',base:'old',at:'2026-10-03T00:00:00Z'},{id:'k2',text:'KEPT TWO',base:'old',at:'2026-10-03T00:00:01Z'}]};
 await f.bench.show('annotations');await settle();
 assert.equal(f.body().querySelectorAll('.sc-memo-kept-card').length,2);
 const el=f.body().querySelector('textarea.sc-paper-memo');
 casType(f,el,'typed');el.dispatchEvent(new f.win.Event('blur'));await settle();
 await f.bench.show('annotations');await settle();
 assert.equal(f.body().querySelectorAll('.sc-memo-kept-card').length,2,'saves and redraws leave them');
 for(const b of f.bench.panel.querySelectorAll('.sc-memo-kept-card button'))assert.equal(b.getAttribute('data-writes'),'cache','the self-check never presses them');
 const fresh=f.body().querySelector('textarea.sc-paper-memo');
 await f.click('버리기');
 assert.equal(f.body().querySelectorAll('.sc-memo-kept-card').length,1);
 f.runtime.cache.items[1].remark='changed elsewhere';
 await f.click('입력칸에 넣기');
 assert.ok(fresh.value.includes('KEPT TWO'));
 assert.equal(f.body().querySelector('.sc-memo-kept-card'),null);
 assert.equal(f.runtime.cache.items[1].remark,'changed elsewhere','loading wrote nothing');
 fresh.dispatchEvent(new f.win.Event('blur'));await settle();
 assert.ok(f.body().querySelector('.sc-memo-stale'),'saving it is judged by the usual CAS: the memo changed, so it is a conflict');
 assert.equal(f.runtime.cache.items[1].remark,'changed elsewhere');
 f.bench.destroy();
});

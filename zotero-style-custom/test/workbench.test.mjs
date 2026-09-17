import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import Workbench from '../src/workbench.js';
import Model from '../src/workspace.js';
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(initialCache){
 const {window:win,document:doc}=parseHTML('<html><head></head><body><div id="zotero-items-toolbar"></div></body></html>');
 // linkedom intentionally has only a select getter; Gecko supplies both.
 Object.defineProperty(win.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this._value??this.querySelector('option')?.getAttribute('value')??'';},set(value){this._value=String(value);}});
 Object.defineProperty(doc,'activeElement',{configurable:true,get(){return this._focusedElement||this.body;}});
 win.HTMLElement.prototype.focus=function(){this.ownerDocument._focusedElement=this;};
 const calls=[],errors=[],cache=initialCache||{items:{},readerSettings:{marginAnnotations:true}},refs=new Map([[1,{id:1}],[2,{id:2}],[9,{id:9}]]);
 const papers=[{id:'1',key:'K1',libraryID:1,title:'Paper Alpha',authors:'Ada Lovelace',year:'2025',venue:'Science',doi:'10.1234/a',itemType:'journalArticle',tags:['topic/a'],abstract:'An abstract',related:['2']},{id:'2',key:'K2',libraryID:1,title:'Paper Beta',authors:'Ada Lovelace',year:'2024',venue:'Nature',itemType:'journalArticle',tags:['topic/b'],abstract:'Other abstract',related:['1']}];
 let libraryID=1,mainSelection=[refs.get(1)],notify;
 win.ZoteroPane={getSelectedLibraryID:()=>libraryID,collectionsView:{selectCollection:id=>calls.push(['collection',id])}};
 const record=(name,result)=>async(...args)=>{calls.push([name,...args]);return typeof result==='function'?result(...args):result;};
 const runtime={rootURI:'file:///plugin/',cache,dirty:false,selected:()=>mainSelection,pref:(key,fallback)=>fallback,entry:ref=>cache.items[ref.id]||=( {}),state:()=>({citations:3,impactFactor:4,status:'reading'}),flush:record('flush'),refreshWindows:record('refresh'),publicationTags:()=>['Q1'],refreshJournalMetrics:record('journal',{updated:1,failed:0,unknown:0}),setPanelCSS:record('css'),toggleAppTheme:record('appTheme'),setCustomFields:record('customFields'),refreshPublicationRanks:record('ranks'),pageProgress:()=>({pages:{0:2,550:7},total:601,visited:2,percent:0,attachmentID:'99'})};
 runtime.Z={Items:{get:id=>refs.get(id),getAsync:async id=>refs.get(id)||{id}},Libraries:{userLibraryID:1},Prefs:{set:(...a)=>calls.push(['pref',...a])},Utilities:{Internal:{copyTextToClipboard:text=>calls.push(['copy',text])}},Notifier:{registerObserver:observer=>{notify=observer.notify;return 42;},unregisterObserver:id=>calls.push(['unregister',id])},logError:error=>errors.push(error)};
 const library={snapshot:record('snapshot',()=>papers),graph:rows=>({nodes:rows.map(i=>({id:i.id,label:i.title})),edges:[]}),tagTree:()=>[{name:'topic',path:'topic',count:2,children:[]}],notes:record('notes',[{id:'9',title:'Rich note',text:'<script>literal note</script>',modified:'today',html:'<b>unsafe raw HTML</b>'}]),annotations:record('annotations',[{id:'3',key:'K3',parentID:'1',attachmentID:'99',text:'Highlight',comment:'Comment',color:'#ffd400',type:'highlight',pageLabel:'1',pageIndex:0}]),backlinks:record('backlinks',[{id:'2',title:'Paper Beta',kind:'related'}]),attachments:record('attachments',[{id:'99',parentID:'1',title:'PDF one',contentType:'application/pdf'},{id:'100',parentID:'1',title:'PDF two',contentType:'application/pdf'}]),collections:record('collections',[{id:'4',name:'Research',count:2,parentID:null}]),openItem:record('open'),relate:record('relate'),addTags:record('addTags'),removeTags:record('removeTags'),setRemark:record('remark'),createNote:record('createNote','9'),noteFromAnnotations:record('extract','9')};
 const palettes=[];const reader={annotationPalettes:()=>palettes,saveAnnotationPalette:record('savePalette',(name,entries)=>{const row={id:'palette1',name,entries};palettes.push(row);return row;}),applyAnnotationPalette:record('applyPalette'),deleteAnnotationPalette:record('deletePalette',id=>{palettes.splice(palettes.findIndex(p=>p.id===id),1);}),tabs:()=>[{id:'tab1',title:'Paper Alpha',itemID:1,selected:true}],tabGroups:()=>[{id:'g1',name:'Group',tabs:[{id:1}]}],viewGroups:()=>[{id:'v1',name:'View',columns:[{dataKey:'title'}]}],applyTheme:record('theme'),setMarginAnnotations:record('margin'),setColorLabel:record('color'),setSidebar:record('sidebar'),setVerticalTabs:record('vertical'),saveTabGroup:record('saveTabs'),restoreTabGroup:record('restoreTabs',{opened:1,missing:0}),deleteTabGroup:record('deleteTabs'),selectTab:record('selectTab'),closeTab:record('closeTab'),saveView:record('saveView'),applyView:record('applyView'),deleteView:record('deleteView')};
 Object.assign(library,{mergeAnnotations:record('mergeAnnotations','3'),unrelate:record('unrelate',2),renameTagBranch:record('renameTagBranch',{updatedItems:1,renamedTags:1,mergedTags:0}),recolorAnnotations:record('recolor',1),collectionItems:record('collectionItems',['2'])});
 Object.assign(reader,{moveTab:(...args)=>{calls.push(['moveTab',...args]);},closeOtherTabs:(...args)=>{calls.push(['closeOtherTabs',...args]);return {closed:1};},renameTabGroup:record('renameTabGroup'),updateTabGroup:record('updateTabGroup'),renameView:record('renameView'),updateView:record('updateView'),marginOptions:()=>({width:210,side:'right',textLimit:1500}),setMarginOptions:record('setMarginOptions'),resetAppearance:record('resetAppearance')});
 const assist={run:record('ai','Generated result'),cancel:()=>calls.push(['cancelAI'])};
 const model={...Model,deleteBoard:(cache,id)=>{calls.push(['deleteBoard',id]);cache.testDeleted=cache.boards.find(b=>b.id===id);cache.boards=cache.boards.filter(b=>b.id!==id);return cache.testDeleted;},restoreBoard:cache=>{calls.push(['restoreBoard']);const board=cache.testDeleted;if(board){cache.boards.push(board);delete cache.testDeleted;}return board;}};
 const bench=Workbench.attach(win,{runtime,library,reader,model,assist});
 const body=()=>bench.panel.querySelector('.sc-body');
 const findButton=label=>[...bench.panel.querySelectorAll('button')].find(b=>b.textContent===label);
 const click=async label=>{const b=findButton(label);assert.ok(b,'button: '+label);b.dispatchEvent(new win.Event('click',{bubbles:true}));await settle();};
 const input=(label,value)=>{const el=bench.panel.querySelector('[aria-label="'+label+'"]');assert.ok(el,label);el.value=value;el.dispatchEvent(new win.Event('input',{bubbles:true}));return el;};
 return {win,doc,bench,runtime,library,reader,assist,calls,errors,papers,refs,body,click,input,findButton,setLibrary:id=>{libraryID=id;},setSelection:ids=>{mainSelection=ids.map(id=>refs.get(id));},notify:()=>notify(),record};
}

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
 await f.bench.show('annotations');const checkbox=f.body().querySelector('[aria-label="주석 선택"]');checkbox.checked=true;checkbox.dispatchEvent(new f.win.Event('change',{bubbles:true}));await f.click('선택 주석을 노트로');assert.deepEqual(f.calls.find(c=>c[0]==='extract')[1],['3']);
 await f.bench.show('backlinks');assert.match(f.body().textContent,/Paper Beta/);await f.click('열기');
 await f.bench.show('attachments');await f.click('열기');assert.ok(f.calls.find(c=>c[0]==='open'&&c[1]==='99'));
 await f.bench.show('reading');await f.click('세피아 PDF');assert.ok(f.calls.find(c=>c[0]==='theme'&&c[2]==='sepia'));
 await f.bench.show('tabs');await f.click('이동');await f.click('복원');assert.ok(f.calls.find(c=>c[0]==='restoreTabs'));
 await f.bench.show('views');await f.click('적용');assert.ok(f.calls.find(c=>c[0]==='applyView'));
 await f.bench.show('canvas');f.input('보드 이름','Board');await f.click('보드 만들기');await f.click('선택 문헌 추가');assert.equal(f.runtime.cache.boards[0].nodes[0].itemID,'1');
 await f.bench.show('matrix');await f.click('CSV 복사');assert.ok(f.calls.find(c=>c[0]==='copy'&&c[1].includes('Paper Alpha')));
 await f.bench.show('collections');await f.click('컬렉션 열기');assert.ok(f.calls.find(c=>c[0]==='collection'&&c[1]===4));
 await f.bench.show('journals');await f.click('공식 값 새로고침');assert.ok(f.calls.find(c=>c[0]==='journal'));await f.click('저널 등급 조회');assert.ok(f.calls.find(c=>c[0]==='ranks'));
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
 f.input('색상 이름','Important');const savedControl=f.body().querySelector('[aria-label="색상 이름"]');const range=f.body().querySelector('[aria-label="Paper Alpha 페이지 범위"]');assert.equal(range.querySelectorAll('option').length,7);range.value='500';range.dispatchEvent(new f.win.Event('change'));await settle();await f.click('551');assert.ok(f.calls.find(c=>c[0]==='open'&&c[1]==='99'&&c[2].pageIndex===550));
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
 await f.bench.show('annotations');await f.click('표시된 주석 전체 선택');f.input('선택 주석 새 색상','#ff6666');await f.click('선택 주석 색상 변경');assert.deepEqual(f.calls.find(c=>c[0]==='recolor').slice(1),[['3'],'#ff6666']);
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
 const f=fixture();f.runtime.state=()=>({citations:null,impactFactor:null,status:'done',rating:4,seconds:19});await f.bench.show('explore');assert.match(f.body().querySelector('.sc-metrics').textContent,/인용 —.*IF —.*완료.*4\/5.*19초/);
 await f.click('자세히');assert.match(f.body().textContent,/Rich note/);assert.match(f.body().textContent,/Highlight/);assert.ok(f.findButton('문헌 노트 편집'));assert.ok(f.findButton('주석 원문 열기'));assert.deepEqual(f.calls.find(c=>c[0]==='notes')[1],['1']);assert.deepEqual(f.calls.find(c=>c[0]==='annotations')[1],['1']);assert.equal(f.body().querySelector('script'),null);f.bench.destroy();
});

test('late detail notes never leak into a different paper or tab',async()=>{
 const f=fixture(),pending=deferred();f.library.notes=()=>pending.promise;await f.bench.show('explore');const click=f.click('자세히');await settle();f.bench.state.tab='matrix';await f.bench.render();pending.resolve([{id:'9',title:'Stale note',text:'Old detail'}]);await click;assert.doesNotMatch(f.body().textContent,/Stale note/);f.bench.destroy();
});

test('annotation merge and exact note backlinks operate on visible annotation IDs from the workbench',async()=>{
 const f=fixture();f.library.annotations=f.record('annotations',[{id:'3',text:'First',color:'#ffd400',type:'highlight',pageIndex:0},{id:'4',text:'Second',color:'#ffd400',type:'highlight',pageIndex:1}]);f.library.backlinks=f.record('backlinks',[{id:'9',title:'Linked annotation note',kind:'note'}]);await f.bench.show('annotations');await f.click('참조 노트 보기');assert.deepEqual(f.calls.find(c=>c[0]==='backlinks')[1],'3');await f.click('Linked annotation note');assert.ok(f.calls.find(c=>c[0]==='open'&&c[1]==='9'));
 await f.click('표시된 주석 전체 선택');await f.click('선택 주석 병합');const call=f.calls.find(c=>c[0]==='mergeAnnotations');assert.deepEqual(call[1],['3','4']);assert.equal(typeof call[2].isCurrent,'function');assert.match(f.bench.panel.querySelector('.sc-status').textContent,/휴지통/);f.bench.destroy();assert.equal(call[2].isCurrent(),false);
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
 const f=fixture(),disabled=new Set();f.runtime.featureEnabled=id=>!disabled.has(id);await f.bench.show('annotations');await f.click('표시된 주석 전체 선택');const old=f.findButton('선택 주석 병합');disabled.add('reader.mergeAnnotations');old.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();assert.equal(f.calls.some(call=>call[0]==='mergeAnnotations'),false);
 disabled.add('annotationColors');disabled.add('backlinks');await f.bench.render();assert.equal(f.findButton('선택 주석 병합').hidden,true);assert.equal(f.findButton('선택 주석 색상 변경').hidden,true);assert.equal(f.findButton('참조 노트 보기').hidden,true);f.bench.destroy();
});

test('configured page size and live reading metrics update existing paper cards without replacing editors',async()=>{
 const f=fixture();f.runtime.getSetting=key=>({explorePageSize:25,inlineEvidenceCount:5,maxExcerptLength:1200,workbenchDensity:'comfortable'})[key];f.runtime.formatReadTime=seconds=>Math.floor(seconds||0)+'s';f.papers.splice(0);for(let id=1;id<=30;id++){f.papers.push({id:String(id),title:'Paper '+id,itemType:'journalArticle',tags:[]});f.refs.set(id,{id});}let seconds=0;f.runtime.state=()=>({seconds,status:seconds?'reading':'unread',citations:null,impactFactor:null});await f.bench.show('explore');assert.equal(f.body().querySelectorAll('.sc-paper-card').length,25);const card=f.body().querySelector('[data-item-id="1"]');assert.match(card.querySelector('[data-metric=time]').textContent,/0s/);seconds=1;f.bench.refreshMetrics();assert.equal(f.body().querySelector('[data-item-id="1"]'),card);assert.match(card.querySelector('[data-metric=time]').textContent,/1s/);assert.equal(card.dataset.status,'reading');f.bench.destroy();
});

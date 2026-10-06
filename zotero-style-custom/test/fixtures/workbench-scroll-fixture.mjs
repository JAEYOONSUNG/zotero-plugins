/* The workbench fixture of workbench.test.mjs, with a layout model (scroll-model.mjs) so a
   test can scroll the panel and see whether a redraw keeps the place. Fictional papers only. */
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createRequire} from 'node:module';
import Workbench from '../../src/workbench.js';
import Model from '../../src/workspace.js';
import JCRBrowser from '../../src/jcr-browser.js';
import '../../src/reader-tools.js';
import {installScrollModel} from './scroll-model.mjs';
const require=createRequire(import.meta.url);
export const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
const shippedCatalog=()=>null;
// a test can check where the button is placed among them.
export function fixture(initialCache,toolbar,{nativeJCR=false,catalog,locale,papers:given,scroll={}}={}){
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
 const calls=[],errors=[],cache=initialCache||{items:{},readerSettings:{marginAnnotations:true}},refs=new Map([[1,{id:1}],[2,{id:2}],[9,{id:9}]]);
 // Existing subject-browser tests intentionally select the optional OpenAlex
 // view. Native default behavior is exercised with nativeJCR:true below.
 if(!nativeJCR&&cache.workbenchUI?.journalBrowser===undefined)cache.workbenchUI={...(cache.workbenchUI||{}),journalBrowser:'openalex'};
 const papers=given||[{id:'1',key:'K1',libraryID:1,title:'Paper Alpha',authors:'Ada Lovelace',year:'2025',venue:'Science',doi:'10.1234/a',itemType:'journalArticle',tags:['topic/a'],abstract:'An abstract',related:['2']},{id:'2',key:'K2',libraryID:1,title:'Paper Beta',authors:'Ada Lovelace',year:'2024',venue:'Nature',itemType:'journalArticle',tags:['topic/b'],abstract:'Other abstract',related:['1']}];
 for(const p of papers)if(!refs.has(Number(p.id)))refs.set(Number(p.id),{id:Number(p.id)});
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
  // The real runtime's pending-write registry: a memo write is pending (with a token) from memory to settled storage.
  memoPendingMap:[],memoListeners:new Set(),
  memoPendingList(){return [...this.memoPendingMap];},
  memoWritePending(){return this.memoPendingMap.length>0;},
  memoPendingPrior(){return this.memoPendingMap[0]?.prior;},
  memoChainTexts(){return this.memoPendingMap.length?[this.memoPendingMap[0].prior,...this.memoPendingMap.map(w=>w.value)]:[];},
  _memoPending(item,delta,prior,value,token){
   if(delta>0){const made='w'+(this.tokenSeq=(this.tokenSeq||0)+1);this.memoPendingMap.push({token:made,prior:String(prior??''),value:String(value??'')});return made;}
   const at=token===undefined?0:this.memoPendingMap.findIndex(w=>w.token===token);if(at>=0)this.memoPendingMap.splice(at,1);
   for(const listener of [...this.memoListeners])listener(item);
  },
  addMemoListener(listener){this.memoListeners.add(listener);return()=>this.memoListeners.delete(listener);},
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
 const library={trashItems:record('trashItems',async ids=>ids.length),snapshot:record('snapshot',()=>papers),graph:rows=>({nodes:rows.map(i=>({id:i.id,label:i.title})),edges:[]}),neighbours:()=>[],tagTree:()=>[{name:'topic',path:'topic',count:2,children:[]}],notes:record('notes',[{id:'9',title:'Rich note',text:'<script>literal note</script>',modified:'today',html:'<b>unsafe raw HTML</b>'}]),annotations:record('annotations',[{id:'3',key:'K3',parentID:'1',attachmentID:'99',text:'Highlight',comment:'Comment',color:'#ffd400',type:'highlight',pageLabel:'1',pageIndex:0}]),backlinks:record('backlinks',[{id:'2',title:'Paper Beta',kind:'related'}]),attachments:record('attachments',[{id:'99',parentID:'1',title:'PDF one',contentType:'application/pdf'},{id:'100',parentID:'1',title:'PDF two',contentType:'application/pdf'}]),collections:record('collections',[{id:'4',name:'Research',count:2,parentID:null}]),openItem:record('open'),relate:record('relate'),addTags:record('addTags'),removeTags:record('removeTags'),setRemark:record('remark'),memoToNote:record('memoToNote',async()=>({created:true,text:''})),createNote:record('createNote','9'),noteFromAnnotations:record('extract','9')};
 const palettes=[];const reader={annotationPalettes:()=>palettes,saveAnnotationPalette:record('savePalette',(name,entries)=>{const row={id:'palette1',name,entries};palettes.push(row);return row;}),applyAnnotationPalette:record('applyPalette'),deleteAnnotationPalette:record('deletePalette',id=>{palettes.splice(palettes.findIndex(p=>p.id===id),1);}),tabs:()=>[{id:'tab1',title:'Paper Alpha',itemID:1,selected:true}],tabGroups:()=>[{id:'g1',name:'Group',tabs:[{id:1}]}],viewGroups:()=>[{id:'v1',name:'View',columns:[{dataKey:'title'}]}],applyTheme:record('theme'),setMarginAnnotations:record('margin'),setColorLabel:record('color'),setSidebar:record('sidebar'),setVerticalTabs:record('vertical'),saveTabGroup:record('saveTabs'),restoreTabGroup:record('restoreTabs',{opened:1,missing:0}),deleteTabGroup:record('deleteTabs'),undeleteTabGroup:record('undeleteTabs'),undeleteView:record('undeleteView'),selectTab:record('selectTab'),closeTab:record('closeTab'),saveView:record('saveView'),applyView:record('applyView'),deleteView:record('deleteView')};
 Object.assign(library,{mergeAnnotations:record('mergeAnnotations','3'),unrelate:record('unrelate',2),renameTagBranch:record('renameTagBranch',{updatedItems:1,renamedTags:1,mergedTags:0}),recolorAnnotations:record('recolor',1),collectionItems:record('collectionItems',['2'])});
 Object.assign(reader,{moveTab:(...args)=>{calls.push(['moveTab',...args]);},closeOtherTabs:(...args)=>{calls.push(['closeOtherTabs',...args]);return {closed:1};},renameTabGroup:record('renameTabGroup'),updateTabGroup:record('updateTabGroup'),renameView:record('renameView'),updateView:record('updateView'),marginOptions:()=>({width:210,side:'right',textLimit:1500}),setMarginOptions:record('setMarginOptions'),resetAppearance:record('resetAppearance')});
 const assist={run:record('ai','Generated result'),cancel:()=>calls.push(['cancelAI'])};
 const model={...Model,deleteBoard:(cache,id)=>{calls.push(['deleteBoard',id]);cache.testDeleted=cache.boards.find(b=>b.id===id);cache.boards=cache.boards.filter(b=>b.id!==id);return cache.testDeleted;},restoreBoard:cache=>{calls.push(['restoreBoard']);const board=cache.testDeleted;if(board){cache.boards.push(board);delete cache.testDeleted;}return board;}};
 if(locale){const i18n=require('../../src/i18n.js');i18n.load(require('../../src/strings.js').en);i18n.use(locale);runtime.i18n=i18n;}
 const model$=installScrollModel(win,scroll);
 const bench=Workbench.attach(win,{runtime,library,reader,model,assist});
 const body=()=>bench.panel.querySelector('.sc-body');
 // An icon button carries its name in the tooltip and the accessible label,
 // not in its text, so a control is findable the way a user identifies it.
 const findButton=label=>[...bench.panel.querySelectorAll('button')]
   .find(b=>b.textContent===label||b.getAttribute('title')===label||b.getAttribute('aria-label')===label);
 const click=async label=>{const b=findButton(label);assert.ok(b,'button: '+label);b.dispatchEvent(new win.Event('click',{bubbles:true}));await settle();};
 // The panel search waits 150ms before it acts; a test types and then looks.
 const input=(label,value)=>{const el=bench.panel.querySelector('[aria-label="'+label+'"]');assert.ok(el,label);el.value=value;el.dispatchEvent(new win.Event('input',{bubbles:true}));bench.flushSearch?.();return el;};
 return {scrollModel:model$,win,doc,bench,runtime,library,reader,assist,calls,errors,papers,refs,body,click,input,findButton,setLibrary:id=>{libraryID=id;},setSelection:ids=>{mainSelection=ids.map(id=>refs.get(id));},notify:()=>notify(),record};
}

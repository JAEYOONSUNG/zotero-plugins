import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {parseHTML} from 'linkedom';
import Workbench from '../src/workbench.js';
import Model from '../src/workspace.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

// Fictional papers and memory-only services: never reads the user's library.
async function mountDemo(win,Workbench,Model){
 const doc=win.document;
 const papers=[
  {id:'1',title:'Mapping cellular responses across tissue repair',authors:'M. Kim; A. Rivera; J. Park',year:'2025',venue:'Example Cell Research',doi:'',tags:['#methods/single-cell','#repair'],abstract:'디자인 미리보기용 예시 초록입니다. 문헌의 읽기 상태, 지표, 노트와 주석을 한곳에서 확인하는 흐름을 보여줍니다.',itemType:'journalArticle',status:'reading',rating:4,citations:128,impactFactor:12.4,seconds:1240},
  {id:'2',title:'A practical framework for reproducible literature synthesis',authors:'S. Lee; L. Chen',year:'2024',venue:'Example Methods',doi:'',tags:['#review/reproducibility'],abstract:'실제 논문이 아닌 화면 구성용 예시 데이터입니다.',itemType:'journalArticle',status:'done',rating:5,citations:64,impactFactor:8.2,seconds:3200},
  {id:'3',title:'Spatial context and cell-state transitions in regeneration',authors:'E. Morgan; H. Choi',year:'2026',venue:'Example Biology',doi:'',tags:['#methods/spatial'],abstract:'새 문헌의 지표가 아직 없을 때 0과 미확인을 구분해 보여줍니다.',itemType:'preprint',status:'unread',rating:0,citations:null,impactFactor:null,seconds:0}
 ];
 for(const paper of papers){paper.key='DEMO'+paper.id;paper.libraryID=1;}
 const refs=new Map(papers.map(p=>[Number(p.id),{id:Number(p.id),key:p.key,libraryID:1}]));
 win.ZoteroPane={getSelectedLibraryID:()=>1,getSelectedCollection:()=>({id:1}),collectionsView:{selectCollection:()=>{} }};
 const icon=doc.getElementById('demo-icon')?.getAttribute('content');
 const hint=text=>{const node=doc.getElementById('demo-feedback');if(node)node.textContent=text;};
 const demoAction=async()=>hint('이 미리보기의 동작은 예시 데이터에만 적용됩니다. 실제 Zotero에는 연결하지 않습니다.');
 const cache={items:{},readerSettings:{},workbenchUI:{density:'comfortable'},boards:[],matrixFields:['title','year','citations','rating']};
 const watched=[
  {id:'A1',name:'Christopher A. Voigt',institution:'MIT',seen:[],
   news:[{id:'W1',title:'Genetic circuit design automation at scale',venue:'Nature Biotechnology',date:'2026-09-02'},
         {id:'W2',title:'A portable recombinase toolkit',venue:'Nature Methods',date:'2026-07-18'}]},
  {id:'A2',name:'Jennifer A. Doudna',institution:'UC Berkeley',seen:[],
   news:[{id:'W3',title:'Compact editors from uncultivated bacteria',venue:'Science',date:'2026-08-21'}]},
  {id:'A3',name:'George M. Church',institution:'Harvard University',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'},
  {id:'A4',name:'Brian Hie',institution:'Stanford University',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'},
  {id:'A5',name:'Tom Ellis',institution:'Imperial College London',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'},
  {id:'A6',name:'Michael T. Laub',institution:'MIT',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'},
  {id:'A7',name:'Samuel H. Sternberg',institution:'Columbia University',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'},
  {id:'A8',name:'Jason W. Chin',institution:'University of Cambridge',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'},
  {id:'A9',name:'Randall J. Platt',institution:'ETH Zurich',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'},
  {id:'A10',name:'Farren J. Isaacs',institution:'Yale University',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'},
  {id:'A11',name:'David R. Liu',institution:'Harvard University',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'},
  {id:'A12',name:'Tobias J. Erb',institution:'Max Planck Institute for Terrestrial Microbiology',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'}
 ];
 let pending={signals:1146,journals:169,authors:109};
 const runtime={rootURI:'',cache,
  backfillPending:()=>pending,
  runBackfill:async({onProgress}={})=>{
   for(const [stage,total] of [['signals',1146],['journals',169],['authors',109]])
    for(const done of [0,Math.floor(total/2),total-1])onProgress?.({stage,done,total});
   pending={signals:0,journals:0,authors:0};
   return {signals:{ok:1145,'not-found':1,error:0,partialOnly:0},journals:{found:160,missing:9},
    authors:{authors:109,withNews:2,works:3},budgetGone:false};
  },
  backfillSummary:()=>'철회·공개접근 신호: 1145편 확인 · 1편은 기록 없음\n저널 지표: 160종 확인 · 9종은 OpenAlex에도 없음\n관심 저자: 2명이 새 논문 3편',
  watchedAuthors:()=>watched,
  coauthorsOf:()=>[
   {id:'A21',name:'Samuel H. Sternberg',institution:'Columbia University',papers:9,last:2026,titles:['A shared paper']},
   {id:'A22',name:'Martin Jinek',institution:'University of Zurich',papers:6,last:2025,titles:[]},
   {id:'A23',name:'Krzysztof Chylinski',institution:'IMBA',papers:4,last:2024,titles:[]},
   {id:'A24',name:'Emmanuelle Charpentier',institution:'Max Planck',papers:3,last:2023,titles:[]},
   {id:'A25',name:'Benjamin Oakes',institution:'Scribe Therapeutics',papers:2,last:2026,titles:[]},
   {id:'A26',name:'Addison Wright',institution:'UC Berkeley',papers:1,last:2022,titles:[]}],
  portraitOf:()=>null,
  fetchPortrait:async()=>null,
  journalRecord:()=>({name:'Example',issn:''}),
  fetchJournalMetric:async()=>({citedness:12.3,name:'Example Journal'}),
  watchedAuthorsByNews:()=>watched.slice().sort((a,b)=>(b.news?.length||0)-(a.news?.length||0)),
  sweepWatchedAuthors:async()=>({authors:watched.length,withNews:2,works:3,requests:1,budgetGone:false,remaining:0}),
  clearAuthorNews:demoAction,watchAuthor:demoAction,unwatchAuthor:demoAction,markAuthorSeen:demoAction,
  authorsOfCached:async()=>[],
  authorUpdates:async()=>({profile:{name:'Jennifer A. Doudna',hIndex:178,works:512,citations:198432,
    institutions:['UC Berkeley'],topics:[{name:'CRISPR',count:212},{name:'RNA biology',count:88},{name:'Genome editing',count:64}],
    orcid:'https://orcid.org/0000-0001-0000-0000'},
   works:[{id:'W1',title:'Compact editors from uncultivated bacteria',venue:'Science',year:2026,citations:12,openAccess:true,authors:['J. Doudna','S. Sternberg']},
    {id:'W2',title:'Structural basis of a compact RNA-guided nuclease',venue:'Nature',year:2026,citations:4,openAccess:false,authors:['J. Doudna']}],
   fresh:[{id:'W1',title:'Compact editors from uncultivated bacteria',venue:'Science',year:2026,citations:12,openAccess:true,authors:['J. Doudna']}],
   watching:true,checkedAt:'2026-09-18'}),selected:()=>[refs.get(1)],pref:(_key,fallback)=>fallback,entry:ref=>cache.items[ref.id]||={},state:ref=>papers.find(p=>Number(p.id)===ref.id)||{},flush:async()=>{},refreshWindows:async()=>{},publicationTags:()=>[],refreshJournalMetrics:async()=>({updated:0,failed:0,unknown:1}),refreshPublicationRanks:demoAction,setPanelCSS:demoAction,toggleAppTheme:demoAction,setCustomFields:demoAction,pageProgress:()=>({total:8,visited:4,percent:50,pages:{0:140,1:600,3:100,5:400},attachmentID:'9'})};
 runtime.Z={Items:{get:id=>refs.get(id),getAsync:async id=>refs.get(id)},Libraries:{userLibraryID:1},Prefs:{set:()=>{}},Utilities:{Internal:{copyTextToClipboard:()=>hint('예시 CSV를 만들었습니다. 이 미리보기에서는 클립보드를 변경하지 않습니다.')}},logError:error=>hint(String(error.message||error))};
 const notes=[{id:'10',title:'연구 질문과 후속 확인',text:'핵심 결과를 재현할 수 있는가?\n비교할 문헌과 연결해 검토합니다.',modified:'2026-09-15'}];
 const annotations=[{id:'11',text:'예시 하이라이트 — 근거와 해석을 분리해 기록합니다.',comment:'후속 문헌과 비교',color:'#ffd400',pageLabel:'3',pageIndex:2,type:'highlight'}];
 const library={snapshot:async()=>papers,graph:rows=>({nodes:rows.map(p=>({id:p.id,label:p.title})),edges:[{source:'1',target:'2'}]}),tagTree:rows=>[...new Set(rows.flatMap(p=>p.tags))].map(tag=>({name:tag,path:tag,count:1,children:[]})),notes:async()=>notes,annotations:async()=>annotations,backlinks:async()=>notes.map(n=>({...n,kind:'note'})),attachments:async()=>[],collections:async()=>[{id:'1',name:'Aeribacillus',count:0},{id:'2',name:'Anaylsis',count:4},{id:'3',name:'Antiphage',count:8},{id:'4',name:'ASR',count:6},{id:'5',name:'Bacillus coagulans',count:0},{id:'6',name:'Bio-containment',count:1},{id:'7',name:'Bioinformatics',count:0},{id:'8',name:'Book chapter',count:1},{id:'9',name:'BREX',count:13}],collectionItems:async()=>papers.map(p=>p.id),openItem:demoAction,relate:demoAction,unrelate:async()=>0,addTags:demoAction,removeTags:demoAction,renameTagBranch:async()=>({updatedItems:0,mergedTags:0}),recolorAnnotations:async()=>0,mergeAnnotations:async()=>{await demoAction();return '11';},setRemark:async(id,text)=>{runtime.entry(refs.get(Number(id))).remark=text;},createNote:async(id,text)=>{notes.push({id:String(20+notes.length),title:'예시 새 노트',text});return notes.at(-1).id;},noteFromAnnotations:async()=>{await demoAction();return '10';}};
 const reader={annotationPalettes:()=>[],tabs:()=>[{id:'library',title:'라이브러리'},{id:'paper',title:papers[0].title,itemID:1,selected:true}],tabGroups:()=>[],viewGroups:()=>[],marginOptions:()=>({width:210,side:'right',textLimit:1500})};
 for(const name of ['applyTheme','resetAppearance','setMarginOptions','setMarginAnnotations','setColorLabel','setSidebar','setVerticalTabs','applyAnnotationPalette','deleteAnnotationPalette','saveTabGroup','restoreTabGroup','deleteTabGroup','selectTab','closeTab','moveTab','renameTabGroup','updateTabGroup','saveView','applyView','deleteView','renameView','updateView'])reader[name]=demoAction;
 reader.saveAnnotationPalette=async()=>({id:'demo'});reader.closeOtherTabs=()=>({closed:0});
 const bench=Workbench.attach(win,{runtime,library,reader,model:Model,assist:{run:async()=> '이것은 실제 AI 호출 없이 표시한 예시 결과입니다.',cancel(){}}});
 doc.querySelector('link[href="content/workbench.css"]')?.remove();
 if(icon)bench.panel.querySelector('.sc-brand img').src=icon;await bench.show('explore');return {bench,runtime};
}
const css=fs.readFileSync(path.join(root,'content/workbench.css'),'utf8');
const {window:win,document:doc}=parseHTML('<html><head></head><body></body></html>');
Object.defineProperty(win.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this._value??this.querySelector('option')?.getAttribute('value')??'';},set(value){this._value=String(value);}});
const {bench}=await mountDemo(win,Workbench,Model);
const icon='data:image/svg+xml;base64,'+Buffer.from(fs.readFileSync(path.join(root,'content/icons/style-custom.svg'))).toString('base64');
bench.panel.querySelector('.sc-brand img').src=icon;
assert.equal(bench.panel.querySelectorAll('nav [data-tab]').length,19);
assert.equal(bench.panel.querySelectorAll('.sc-paper-card').length,3);
assert.equal(bench.panel.querySelector('.sc-filters').hasAttribute('open'),false);
assert.equal(bench.panel.querySelector('.sc-command-palette').hidden,true);
const snapshot=bench.panel.outerHTML;
bench.destroy();
const inline=file=>fs.readFileSync(path.join(root,file),'utf8').replace(/<\/script/gi,'<\\/script');
const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta id="demo-icon" content="${icon}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Style Custom 0.8.0 · 디자인 미리보기</title><style>body{margin:0;background:#e5e7eb;font:12px system-ui;color:#374151}.demo-bar{height:40px;display:flex;align-items:center;gap:12px;padding:0 18px}.demo-bar strong{font-weight:650}.demo-bar span{color:#4b5563}.demo-feedback{position:fixed;bottom:4px;left:18px;right:18px;font-size:11px} ${css}</style></head><body><div class="demo-bar"><strong>디자인 미리보기</strong><span>예시 문헌 · 실제 라이브러리 연결 없음</span></div><div id="demo-feedback" class="demo-feedback" role="status">간격 조절, 기능 찾기, 필터와 문헌 상세를 직접 확인할 수 있습니다.</div>${snapshot}<script>${inline('src/workspace.js')}</script><script>${inline('src/workbench.js')}</script><script>document.getElementById('style-custom-workbench').remove();(${mountDemo.toString()})(window,CustomStyleWorkbench,CustomStyleWorkspace);</script></body></html>`;
assert.ok(!html.includes('<script src=')&&!html.includes('<link '));
const target=path.join(root,'docs/design-preview.html');fs.writeFileSync(target,html);
console.log('Offline design preview verified: actual workbench DOM, 19 sections, 3 fictional papers, no external assets: '+target);

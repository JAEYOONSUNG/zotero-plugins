import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {parseHTML} from 'linkedom';
import Workbench from '../src/workbench.js';
import Model from '../src/workspace.js';
import ReadingPath from '../src/reading-path.js';
import PaperGraph from '../src/paper-graph.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

// Fictional papers and memory-only services: never reads the user's library.
async function mountDemo(win,Workbench,Model,ReadingPath,PaperGraph){
 const doc=win.document;
 const papers=[
  {id:'1',title:'Mapping cellular responses across tissue repair',authors:'M. Kim; A. Rivera; J. Park',year:'2025',venue:'Example Cell Research',doi:'10.5555/demo.1',tags:['#methods/single-cell','#repair'],abstract:'디자인 미리보기용 예시 초록입니다. 문헌의 읽기 상태, 지표, 노트와 주석을 한곳에서 확인하는 흐름을 보여줍니다.',itemType:'journalArticle',status:'reading',rating:4,citations:128,impactFactor:12.4,seconds:1240},
  {id:'2',title:'A practical framework for reproducible literature synthesis',authors:'S. Lee; L. Chen',year:'2024',venue:'Example Methods',doi:'',tags:['#review/reproducibility'],abstract:'실제 논문이 아닌 화면 구성용 예시 데이터입니다.',itemType:'journalArticle',status:'done',rating:5,citations:64,impactFactor:8.2,seconds:3200},
  {id:'3',title:'Spatial context and cell-state transitions in regeneration',authors:'E. Morgan; H. Choi',year:'2026',venue:'Example Biology',doi:'',tags:['#methods/spatial'],abstract:'새 문헌의 지표가 아직 없을 때 0과 미확인을 구분해 보여줍니다.',itemType:'preprint',status:'unread',rating:0,citations:null,impactFactor:null,seconds:0},
  // Three more on the same shelves, unread, so the journals tab has something to weigh.
  {id:'4',title:'Tissue-scale repair atlases from sparse sampling',authors:'R. Ahn; P. Silva',year:'2025',venue:'Example Cell Research',doi:'10.5555/demo.4',tags:[],abstract:'',itemType:'journalArticle',status:'reading',rating:0,citations:41,impactFactor:12.4,seconds:400},
  {id:'5',title:'Benchmarks for repair-stage classifiers',authors:'K. Oh; Christopher A. Voigt',year:'2024',venue:'Example Cell Research',doi:'',tags:[],abstract:'',itemType:'journalArticle',status:'unread',rating:0,citations:null,impactFactor:12.4,seconds:0},
  {id:'6',title:'Preregistered synthesis of repair reviews',authors:'D. Yu; S. Lee',year:'2023',venue:'Example Methods',doi:'',tags:[],abstract:'',itemType:'journalArticle',status:'unread',rating:0,citations:12,impactFactor:8.2,seconds:0}
 ];
 for(const paper of papers){paper.key='DEMO'+paper.id;paper.libraryID=1;}
 // Dates relative to today, so 최근 문헌 and its week line have something to say.
 const stamp=n=>new Date(Date.now()-n*864e5).toISOString();
 Object.assign(papers[0],{dateAdded:stamp(30),lastRead:stamp(1)});Object.assign(papers[1],{dateAdded:stamp(60),lastRead:stamp(6)});
 Object.assign(papers[2],{dateAdded:stamp(2)});Object.assign(papers[3],{dateAdded:stamp(4),dateModified:stamp(1)});
 Object.assign(papers[4],{dateAdded:stamp(90)});Object.assign(papers[5],{dateAdded:stamp(120)});
 const refs=new Map(papers.map(p=>[Number(p.id),{id:Number(p.id),key:p.key,libraryID:1}]));
 // The two PDFs of paper 1, named as Zotero would: the article and its supplement.
 refs.set(9,{id:9,parentID:1,libraryID:1,getField:()=>'Full text PDF'});refs.set(10,{id:10,parentID:1,libraryID:1,getField:()=>'Supplementary information'});
 let selectedCollection=2;
 win.ZoteroPane={getSelectedLibraryID:()=>1,getSelectedCollection:()=>({id:selectedCollection}),collectionsView:{selectCollection:id=>{selectedCollection=Number(id);}}};
 const icon=doc.getElementById('demo-icon')?.getAttribute('content');
 const hint=text=>{const node=doc.getElementById('demo-feedback');if(node)node.textContent=text;};
 const demoAction=async()=>hint('이 미리보기의 동작은 예시 데이터에만 적용됩니다. 실제 Zotero에는 연결하지 않습니다.');
 const daysAgo=n=>new Date(Date.now()-n*864e5).toISOString();
 // Reading records for the fictional papers, so the reading page shows what a reader sees.
 const cache={items:{4:{seconds:400,lastRead:daysAgo(20)},1:{seconds:1240,lastRead:daysAgo(1),remark:'Fig. 3의 대조군 조건을 방법 절과 대조해 볼 것',readingAttachments:{9:{pageTimes:{0:140,1:520,2:80,3:100,5:370,6:30},totalPages:12,lastPageIndex:6,lastRead:daysAgo(1)},10:{pageTimes:{1:90},totalPages:4,lastPageIndex:1,lastRead:daysAgo(3)}},readingAttachmentID:9},2:{seconds:3200,lastRead:daysAgo(6)}},readerSettings:{colorLabels:{'#ffd400':'핵심 결과','#5fb236':'방법'}},workbenchUI:{density:(typeof process!=='undefined'&&process.env?.PREVIEW_DENSITY==='compact')||(typeof location!=='undefined'&&/[?&]density=compact/.test(location.search))?'compact':'comfortable',welcomed:true},boards:[]};
 const watched=[
  {id:'A1',name:'Christopher A. Voigt',institution:'MIT',seen:[],
   news:[{id:'W1',title:'Genetic circuit design automation at scale',venue:'Nature Biotechnology',date:'2026-09-02'},
         {id:'W2',title:'A portable recombinase toolkit',venue:'Nature Methods',date:'2026-07-18'}]},
  {id:'A2',name:'Jennifer A. Doudna',institution:'UC Berkeley',seen:[],
   news:[{id:'W3',title:'Compact editors from uncultivated bacteria',venue:'Science',date:'2026-08-21'},
         {id:'W1',title:'Genetic circuit design automation at scale',venue:'Nature Biotechnology',date:'2026-09-02'},
         {id:'W6',title:'Tissue-scale repair atlases from sparse sampling',venue:'Example Cell Research',date:'2026-08-30',doi:'10.5555/demo.4'},
         {id:'W7',title:'Rapid editing screens in primary cells',venue:'bioRxiv',date:'2026-06-10',preprint:true,signals:{rank:3}}],
   newCoauthors:['Priya Natarajan','Luis Ortega'],
   moved:{from:'UC Berkeley',to:'Gladstone Institutes',since:2026,at:'2026-09-01'},
   patents:[{id:'US 12,345,678',title:'Compositions for programmable RNA targeting',granted:'2026-05-12',applicants:['Example University'],fresh:true,link:''}],
   newPatents:[{id:'US 12,345,678'}]},
  {id:'A3',name:'George M. Church',institution:'Harvard University',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'},
  {id:'A4',name:'Brian Hie',institution:'Stanford University',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'},
  {id:'A5',name:'Tom Ellis',institution:'Imperial College London',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'},
  {id:'A6',name:'Michael T. Laub',institution:'MIT',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'},
  {id:'A7',name:'Samuel H. Sternberg',institution:'Columbia University',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'},
  {id:'A8',name:'Jason W. Chin',institution:'University of Cambridge',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'},
  {id:'A9',name:'Randall J. Platt',institution:'ETH Zurich',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'},
  {id:'A10',name:'Farren J. Isaacs',institution:'Yale University',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'},
  {id:'A11',name:'David R. Liu',institution:'Harvard University',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'},
  {id:'A12',name:'Tobias J. Erb',institution:'Max Planck Institute for Terrestrial Microbiology',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'},
  // On papers 1, 2 and 6 above, so the watch table's 보유·완료·안 읽음·읽은 시간 columns have real numbers to show.
  {id:'A13',name:'M. Kim',institution:'Example University',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'},
  {id:'A14',name:'S. Lee',institution:'Example Methods',seen:[],news:[],sweptAt:'2026-09-18T00:00:00Z'}
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
  patentsKey:()=>'demo',
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
  // The panel's own formatter, so the preview shows what Zotero shows.
  formatReadTime:seconds=>{const v=Math.max(0,Math.floor(Number(seconds)||0));const h=Math.floor(v/3600),m=Math.floor(v%3600/60),x=v%60;return h?`${h}h ${m}m ${x}s`:m?`${m}m ${x}s`:`${x}s`;},
  // The paper's authors, fictional, so the author page draws every section.
  authorsOfCached:async()=>[
   {id:'A2',name:'Jennifer A. Doudna',institution:'UC Berkeley',position:'last'},
   {id:'A30',name:'Mina Kim',institution:'Example University',position:'first'},
   {id:'A31',name:'Alex Rivera',institution:'Example Institute',position:'middle'}],
  /* The reading order, drawn by the real planner over a fictional citation
     graph: eight made-up works whose reference lists point at each other, so
     the preview shows the same rows Zotero would draw, with no network. */
  pathTools:ReadingPath,
  // The graph layout Zotero uses, so the preview does not fall back to the old placer.
  graphTools:PaperGraph,
  libraryDOIs:()=>new Set(['10.5555/demo-f2','10.5555/demo-p1']),
  forgetReadingPath:()=>{},
  identity:ref=>'demo:'+ref?.id,
  readingPathCached:async()=>{
   const topics={topic:new Set(['t1']),subfield:new Set(['s1']),field:new Set(['f1'])};
   const W=(id,year,title,references,extra={})=>({id,doi:'10.5555/demo-'+id.toLowerCase(),title,year,
    venue:extra.venue||'Example Journal',type:extra.type||'article',citations:extra.citations??60,
    authors:extra.authors||['M. Kim','A. Rivera'],references,related:[],subjects:topics,
    abstract:'',finding:extra.finding||'',openAccess:!!extra.oa,pdfURL:''});
   const F1=W('F1',2014,'An earlier method for measuring tissue repair',[],{citations:940,
    finding:'예시 요약입니다. 이 방법이 이후 연구가 기대는 기준이 되었습니다.'});
   const F2=W('F2',2016,'A reference atlas of repair-stage cell states',[F1.id],{citations:610,
    finding:'예시 요약입니다. 단계별 세포 상태를 정리한 표준 지도를 제시합니다.'});
   const F3=W('F3',2018,'Limits of the earlier measurement approach',[F1.id,F2.id],{citations:280,
    finding:'예시 요약입니다. 기존 방법이 놓치는 구간을 짚습니다.'});
   const R1=W('R1',2021,'Measuring tissue repair: a review',[F1.id,F2.id,F3.id],{type:'review',
    citations:520,venue:'Example Reviews',finding:'예시 요약입니다. 분야 전체의 지도와 남은 질문을 정리합니다.'});
   const P1=W('P1',2022,'Mapping repair responses in a single tissue',[F1.id,F2.id,F3.id],{citations:210,
    finding:'예시 요약입니다. 한 조직에서 이 논문의 접근을 먼저 시험했습니다.'});
   const P2=W('P2',2023,'Mapping repair responses across two tissues',[F1.id,F2.id,F3.id,P1.id],{citations:150,oa:true,
    finding:'예시 요약입니다. 같은 접근을 두 조직으로 넓혔습니다.'});
   const seed=W('S',2025,papers[0].title,[F1.id,F2.id,F3.id,R1.id,P1.id,P2.id],
    {venue:'Example Cell Research',citations:128});
   const C1=W('C1',2026,'Repair maps applied to a new tissue',[seed.id,P2.id,F2.id],{citations:18,oa:true,
    finding:'예시 요약입니다. 이 논문의 지도를 다른 조직에 적용했습니다.'});
   const C2=W('C2',2026,'A shared vocabulary for repair-stage maps',[seed.id,P1.id,P2.id,F3.id],{citations:9,
    finding:'예시 요약입니다. 서로 다른 지도를 견줄 공통 용어를 제안합니다.'});
   const refs=[F1,F2,F3,R1,P1,P2];
   const have=new Set(['10.5555/demo-f2','10.5555/demo-p1']);
   const plan=ReadingPath.plan(seed,{refs,citers:[C1,C2],foundations:[F1,F2,F3],have});
   plan.milestones=ReadingPath.milestones(seed,refs,[...refs,C1,C2],{have});
   return plan;
  },
  relatedWorksCached:async()=>({work:{id:'S'},suggestions:[]}),
  /* 이 논문 주변, fictional and offline: the paper in focus was corrected and
     later retracted, and people wrote about it. Other papers answer from
     the same table, so a row opened in the list has something to say too. */
  paperIssues:async()=>({events:[
   {date:'2024-03-06',kind:'correction',source:'Crossref',label:'Correction',url:'https://example.org/notice/1'},
   {date:'2025-06-12',kind:'retraction',source:'Crossref',via:'Retraction Watch',label:'Retraction',url:'https://example.org/notice/2'},
   {date:'2025-07-02',kind:'comment',source:'Europe PMC',label:'Comments',count:4,url:'https://example.org/notice/3'}],
   summary:{status:'retracted',checked:new Date().toISOString(),failed:[],comments:4}}),
  paperReactions:async()=>({
   bluesky:{count:12,top:[
    {author:'Dana Whitfield',handle:'dana.example',text:'Reading the retraction notice next to the original figures is a useful exercise in what a repair atlas can and cannot claim. The sampling argument in the methods never held up for the spatial subset.',date:'2025-06-20T10:00:00Z',likes:48,reposts:12,replies:3,url:'https://example.org/bsky/1'},
    {author:'Lab of Open Methods',handle:'openmethods.example',text:'Thread on why the control tissue was not comparable.',date:'2025-06-14T10:00:00Z',likes:21,reposts:5,replies:1,url:'https://example.org/bsky/2'},
    {author:'Mina Park',handle:'mpark.example',text:'Added this to our journal club list.',date:'2025-02-03T10:00:00Z',likes:6,reposts:0,replies:0,url:'https://example.org/bsky/3'}]},
   hackerNews:{count:1,top:[{title:'Tissue repair atlas retracted after reanalysis',points:214,comments:87,date:'2025-06-13T00:00:00Z',url:'https://example.org/hn/1'}]},
   wikipedia:{count:28,articles:[{title:'Tissue regeneration',url:'https://example.org/wiki/1'},{title:'Single-cell sequencing',url:'https://example.org/wiki/2'}]},
   pubpeer:{url:'https://example.org/pubpeer'},checked:new Date().toISOString(),failed:[]}),
  doiIssues:async doi=>({events:doi==='10.5555/demo-p2'?[{date:'2024-11-02',kind:'expression-of-concern',source:'Crossref',label:'EoC',url:'https://example.org/notice/4'}]:[],
   summary:{status:doi==='10.5555/demo-p2'?'concern':'clean',checked:new Date().toISOString(),failed:[],comments:0}}),
  doiReactions:async()=>({bluesky:{count:0,top:[]},hackerNews:{count:0,top:[]},wikipedia:{count:3,articles:[]},pubpeer:{url:''},checked:new Date().toISOString(),failed:['Bluesky']}),
  // What an earlier look left in the cache, so two rows in the lists wear a badge.
  cachedIssueStatus:doi=>doi==='10.5555/demo-f3'?'retracted':doi==='10.5555/demo-p2'?'concern':null,
  authorUpdates:async()=>({profile:{name:'Jennifer A. Doudna',hIndex:178,works:512,citations:198432,
    institutions:['UC Berkeley'],topics:[{name:'CRISPR',count:212},{name:'RNA biology',count:88},{name:'Genome editing',count:64}],
    orcid:'https://orcid.org/0000-0001-0000-0000'},
   works:[{id:'W1',title:'Compact editors from uncultivated bacteria',venue:'Science',year:2026,citations:12,openAccess:true,authors:['J. Doudna','S. Sternberg','P. Natarajan']},
    {id:'W2',title:'Structural basis of a compact RNA-guided nuclease',venue:'Nature',year:2026,citations:4,openAccess:false,authors:['J. Doudna','L. Ortega']},
    {id:'W4',title:'Delivery of editing enzymes across tissue barriers',venue:'Cell',year:2025,citations:61,openAccess:true,authors:['J. Doudna','S. Sternberg']},
    {id:'W5',title:'Guide design rules learned from a million targets',venue:'Nature Biotechnology',year:2025,citations:88,openAccess:false,authors:['J. Doudna','M. Jinek']},
    {id:'W6',title:'An RNA-guided transposase for large insertions',venue:'Science',year:2025,citations:140,openAccess:true,authors:['J. Doudna','S. Sternberg','M. Jinek']},
    {id:'W7',title:'Off-target profiling in primary human cells',venue:'Nature Methods',year:2024,citations:203,openAccess:false,authors:['J. Doudna','B. Oakes']}],
   fresh:[{id:'W1',title:'Compact editors from uncultivated bacteria',venue:'Science',year:2026,citations:12,openAccess:true,authors:['J. Doudna']}],
   watching:true,checkedAt:'2026-09-18'}),selected:()=>[refs.get(1)],pref:(_key,fallback)=>fallback,entry:ref=>cache.items[ref.id]||={},state:ref=>papers.find(p=>Number(p.id)===ref.id)||{},flush:async()=>{},refreshWindows:async()=>{},publicationTags:()=>[],refreshJournalMetrics:async()=>({updated:0,failed:0,unknown:1}),refreshPublicationRanks:demoAction,setPanelCSS:demoAction,toggleAppTheme:demoAction,setCustomFields:demoAction,canEdit:()=>true,edit:async(items,patch)=>{for(const item of items){const paper=papers.find(p=>Number(p.id)===item.id);if(paper&&patch.status)paper.status=patch.status;}},
  paperWorks:()=>({'1:DEMO1':{openalex:'W1',references:['W4','W6']},'1:DEMO2':{openalex:'W2',references:['W4']},'1:DEMO3':{openalex:'W3',references:['https://openalex.org/W1','W2','W2']},'1:DEMO4':{openalex:'W4',references:[]},'1:DEMO6':{openalex:'W6',references:[]}}),
  // So 첨부 미리보기's findings section has something to show: one supplement filed
  // under its paper, and two papers with no PDF at all, one unread and one already done.
  attachmentFindings:async()=>({supplementary:[{id:'1',fileID:'10',title:papers[0].title,year:'2025',file:'Supplementary information.pdf',why:'첫 쪽에 Supplementary라고 적혀 있음'}],duplicate:[],foreign:[],orphan:[],missing:[{id:'3',title:papers[2].title,year:'2026'},{id:'2',title:papers[1].title,year:'2024'}],unread:0}),
  trashAttachments:async()=>({moved:0}),
  pageProgress:(ref,att)=>ref.id===1&&Number(att)===10?{total:4,visited:1,percent:25,pages:{1:90},attachmentID:'10',lastPageIndex:1}:ref.id===1?{total:12,visited:6,percent:50,pages:{0:140,1:520,2:80,3:100,5:370,6:30},attachmentID:'9',lastPageIndex:6}
  :ref.id===2?{total:8,visited:8,percent:100,pages:{0:90,1:300,2:420,3:500,4:600,5:510,6:420,7:360},attachmentID:'8',lastPageIndex:7}
  :{total:0,visited:0,percent:0,pages:{}}};
 runtime.Z={Items:{get:id=>refs.get(id),getAsync:async id=>refs.get(id)},Libraries:{userLibraryID:1},Prefs:{set:()=>{}},Utilities:{Internal:{copyTextToClipboard:()=>hint('예시 CSV를 만들었습니다. 이 미리보기에서는 클립보드를 변경하지 않습니다.')}},logError:error=>hint(String(error.message||error))};
 const notes=[{id:'10',parentID:'1',title:'연구 질문과 후속 확인',text:'핵심 결과를 재현할 수 있는가?\n비교할 문헌과 연결해 검토합니다.',modified:'2026-09-15'}];
 const annotations=[{id:'11',text:'예시 하이라이트 — 근거와 해석을 분리해 기록합니다.',comment:'후속 문헌과 비교',color:'#ffd400',pageLabel:'3',pageIndex:2,type:'highlight',attachmentID:'9',parentID:'1'},{id:'12',text:'대조군은 같은 조직에서 손상 없이 채취',comment:'',color:'#5fb236',pageLabel:'6',pageIndex:5,type:'highlight',attachmentID:'9',parentID:'1'},{id:'13',text:'재현 조건: 세 번의 독립 반복과 사전 등록된 분석 계획',comment:'방법 절 비교용',color:'#5fb236',pageLabel:'4',pageIndex:3,type:'highlight',attachmentID:'8',parentID:'2'},{id:'14',text:'결과는 재현 가능한 합성 절차에서 일관되었다',comment:'',color:'#ffd400',pageLabel:'7',pageIndex:6,type:'highlight',attachmentID:'8',parentID:'2'},{id:'15',text:'보충 실험의 대조군 배치',comment:'',color:'#5fb236',pageLabel:'2',pageIndex:1,type:'highlight',attachmentID:'10',parentID:'1'}];
 // The two PDFs attachmentFindings already reports on: paper 1's article and its supplement.
 const attachmentRows=[{id:'9',parentID:'1',title:'Full text PDF',contentType:'application/pdf',path:null},{id:'10',parentID:'1',title:'Supplementary information',contentType:'application/pdf',path:null}];
 /* A41: a real nested tree, not one flat sibling per whole tag string --
    #methods/single-cell and #methods/spatial share a #methods parent with
    two children, the same shape src/library.js's own tagTree builds, so the
    preview actually exercises nested-open behaviour rather than a flat list
    that happened to have slashes in its names. */
 const tagTree=rows=>{
  const roots=new Map();
  for(const row of rows){
   const seen=new Set();
   for(const raw of row.tags||[]){
    const tag=String(raw);if(!tag)continue;
    const parts=tag.split('/').filter(Boolean);let tree=roots,path='';
    for(const part of parts){
     path=path?path+'/'+part:part;
     if(!tree.has(part))tree.set(part,{name:part,path,count:0,children:new Map()});
     const node=tree.get(part);if(!seen.has(path)){node.count++;seen.add(path);}tree=node.children;
    }
   }
  }
  const convert=tree=>[...tree.values()].sort((a,b)=>a.name.localeCompare(b.name)).map(n=>({...n,children:convert(n.children)}));
  return convert(roots);
 };
 const library={snapshot:async()=>papers,graph:rows=>({nodes:rows.map(p=>({id:p.id,label:p.title})),edges:[{source:'1',target:'2'}]}),tagTree,notes:async ids=>ids?notes.filter(n=>!n.parentID||ids.map(String).includes(String(n.parentID))):notes,annotations:async ids=>ids?annotations.filter(a=>ids.map(String).includes(String(a.parentID))):annotations,annotationCounts:async ids=>{const wanted=ids?new Set(ids.map(String)):null;const out={};for(const a of annotations){const key=String(a.parentID);if(wanted&&!wanted.has(key))continue;out[key]=(out[key]||0)+1;}return out;},backlinks:async()=>notes.map(n=>({...n,kind:'note'})),attachments:async ids=>ids===undefined?attachmentRows:attachmentRows.filter(a=>ids.map(String).includes(String(a.parentID))),collections:async()=>[{id:'1',name:'Aeribacillus',count:0,itemIDs:[],parentID:null},{id:'2',name:'Anaylsis',count:3,itemIDs:[1,2,6],parentID:null},{id:'3',name:'Antiphage',count:2,itemIDs:[4,5],parentID:null},{id:'31',name:'Repair atlases',count:1,itemIDs:[3],parentID:'3'},{id:'4',name:'ASR',count:6},{id:'5',name:'Bacillus coagulans',count:0},{id:'6',name:'Bio-containment',count:1},{id:'7',name:'Bioinformatics',count:0},{id:'8',name:'Book chapter',count:1},{id:'9',name:'BREX',count:13}],collectionItems:async(id,{recursive=false}={})=>{const all=await library.collections();const kids=c=>all.filter(k=>k.parentID===c.id);const walk=c=>[...(c.itemIDs||[]),...(recursive?kids(c).flatMap(walk):[])];const c=all.find(x=>x.id===String(id));return c?[...new Set(walk(c).map(String))]:[];},openItem:demoAction,relate:demoAction,unrelate:async()=>0,addTags:demoAction,removeTags:demoAction,renameTagBranch:async()=>({updatedItems:0,mergedTags:0}),recolorAnnotations:async()=>0,mergeAnnotations:async()=>{await demoAction();return '11';},setRemark:async(id,text)=>{runtime.entry(refs.get(Number(id))).remark=text;},createNote:async(id,text)=>{notes.push({id:String(20+notes.length),parentID:String(id),title:'예시 새 노트',text});return notes.at(-1).id;},noteFromAnnotations:async()=>{await demoAction();return '10';}};
 const reader={annotationPalettes:()=>[],tabs:()=>[{id:'library',title:'라이브러리'},{id:'paper',title:papers[0].title,itemID:1,selected:true}],tabGroups:()=>[],viewGroups:()=>[],marginOptions:()=>({width:210,side:'right',textLimit:1500})};
 for(const name of ['applyTheme','resetAppearance','setMarginOptions','setMarginAnnotations','setColorLabel','setSidebar','setVerticalTabs','applyAnnotationPalette','deleteAnnotationPalette','saveTabGroup','restoreTabGroup','deleteTabGroup','selectTab','closeTab','moveTab','renameTabGroup','updateTabGroup','saveView','applyView','deleteView','renameView','updateView'])reader[name]=demoAction;
 reader.saveAnnotationPalette=async()=>({id:'demo'});reader.closeOtherTabs=()=>({closed:0});
 const bench=Workbench.attach(win,{runtime,library,reader,model:Model,assist:{run:async()=> '이것은 실제 AI 호출 없이 표시한 예시 결과입니다.',cancel(){}}});
 doc.querySelector('link[href="content/workbench.css"]')?.remove();
 if(icon)bench.panel.querySelector('.sc-brand img').src=icon;await bench.show('explore');
 /* design-preview.html?filters=1 shows 상세 필터 open with a few include and
    exclude rules on the fictional papers; &editor=tag (or journal, year, ...)
    also opens that rule's editor, with its live counts. */
 const flags=String(win.location?.search||'')+String(win.location?.hash||'');
 if(/filters/.test(flags)){
  await bench.filters.set([
   {id:'demo1',kind:'year',mode:'in',min:2024,max:2026},
   {id:'demo2',kind:'word',mode:'in',field:'all',text:'repair',phrase:true},
   {id:'demo3',kind:'type',mode:'ex',values:['preprint']},
   {id:'demo4',kind:'journal',mode:'ex',values:['Example Methods']}]);
  bench.filters.open();
  const wanted=flags.match(/editor=(\w+)/);if(wanted)await bench.filters.edit(wanted[1]);
 }
 /* design-preview.html?around=open opens the paper's own summary and 주변 보기 on the
    third related row (an owned one) as soon as they are drawn, so the opened state can be audited. */
 if(/around=open/.test(flags)){
  const opened=new WeakSet();
  new win.MutationObserver(()=>{
   // The paper's own summary opens, and so does the third row of the list (an owned one).
   const head=bench.panel.querySelector('.sc-around-summary[aria-expanded=false]');
   if(head&&!opened.has(head)){opened.add(head);head.click();}
   const rows=[...bench.panel.querySelectorAll('.sc-hit-around:not(:disabled)')];
   const row=rows[2];
   if(row&&!opened.has(row)&&!bench.panel.querySelector('.sc-hit[data-around=open]')){opened.add(row);row.click();}
  }).observe(bench.panel,{childList:true,subtree:true});
 }
 /* &suggest=1 types 저널: into the search box, which lists the journals under it. */
 if(/suggest/.test(flags)){const box=bench.panel.querySelector('[aria-label="작업 패널 검색"]');box.value='저널:exa';box.dispatchEvent(new win.Event('input',{bubbles:true}));box.focus?.();}
 return {bench,runtime};
}
const css=fs.readFileSync(path.join(root,'content/workbench.css'),'utf8');
const {window:win,document:doc}=parseHTML('<html><head></head><body></body></html>');
Object.defineProperty(win.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this._value??this.querySelector('option')?.getAttribute('value')??'';},set(value){this._value=String(value);}});
const {bench}=await mountDemo(win,Workbench,Model,ReadingPath,PaperGraph);
const icon='data:image/svg+xml;base64,'+Buffer.from(fs.readFileSync(path.join(root,'content/icons/style-custom.svg'))).toString('base64');
bench.panel.querySelector('.sc-brand img').src=icon;
assert.equal(bench.panel.querySelectorAll('nav [data-tab]').length,19);
assert.equal(bench.panel.querySelectorAll('.sc-paper-card').length,6);
assert.equal(bench.panel.querySelector('.sc-filters').hasAttribute('open'),false);
assert.equal(bench.panel.querySelector('.sc-command-palette').hidden,true);
const snapshot=bench.panel.outerHTML;
bench.destroy();
const inline=file=>fs.readFileSync(path.join(root,file),'utf8').replace(/<\/script/gi,'<\\/script');
const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta id="demo-icon" content="${icon}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Style Custom 0.8.0 · 디자인 미리보기</title><style>body{margin:0;background:#e5e7eb;font:12px system-ui;color:#374151}.demo-bar{height:40px;display:flex;align-items:center;gap:12px;padding:0 18px}.demo-bar strong{font-weight:650}.demo-bar span{color:#4b5563}.demo-feedback{position:fixed;bottom:4px;left:18px;right:18px;font-size:11px} ${css}</style></head><body><div class="demo-bar"><strong>디자인 미리보기</strong><span>예시 문헌 · 실제 라이브러리 연결 없음</span></div><div id="demo-feedback" class="demo-feedback" role="status">간격 조절, 기능 찾기, 필터와 문헌 상세를 직접 확인할 수 있습니다.</div>${snapshot}<script>${inline('src/workspace.js')}</script><script>${inline('src/reading-path.js')}</script><script>${inline('src/paper-graph.js')}</script><script>${inline('src/workbench.js')}</script><script>document.getElementById('style-custom-workbench').remove();(${mountDemo.toString()})(window,CustomStyleWorkbench,CustomStyleWorkspace,CustomStyleReadingPath,CustomStylePaperGraph);</script></body></html>`;
assert.ok(!html.includes('<script src=')&&!html.includes('<link '));
const target=path.join(root,'docs/design-preview.html');fs.writeFileSync(target,html);
console.log('Offline design preview verified: actual workbench DOM, 19 sections, 6 fictional papers, no external assets: '+target);

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
 const runtime={rootURI:'',cache,selected:()=>[refs.get(1)],pref:(_key,fallback)=>fallback,entry:ref=>cache.items[ref.id]||={},state:ref=>papers.find(p=>Number(p.id)===ref.id)||{},flush:async()=>{},refreshWindows:async()=>{},publicationTags:()=>[],refreshJournalMetrics:async()=>({updated:0,failed:0,unknown:1}),refreshPublicationRanks:demoAction,setPanelCSS:demoAction,toggleAppTheme:demoAction,setCustomFields:demoAction,pageProgress:()=>({total:8,visited:4,percent:50,pages:{0:140,1:600,3:100,5:400},attachmentID:'9'})};
 runtime.Z={Items:{get:id=>refs.get(id),getAsync:async id=>refs.get(id)},Libraries:{userLibraryID:1},Prefs:{set:()=>{}},Utilities:{Internal:{copyTextToClipboard:()=>hint('예시 CSV를 만들었습니다. 이 미리보기에서는 클립보드를 변경하지 않습니다.')}},logError:error=>hint(String(error.message||error))};
 const notes=[{id:'10',title:'연구 질문과 후속 확인',text:'핵심 결과를 재현할 수 있는가?\n비교할 문헌과 연결해 검토합니다.',modified:'2026-09-15'}];
 const annotations=[{id:'11',text:'예시 하이라이트 — 근거와 해석을 분리해 기록합니다.',comment:'후속 문헌과 비교',color:'#ffd400',pageLabel:'3',pageIndex:2,type:'highlight'}];
 const library={snapshot:async()=>papers,graph:rows=>({nodes:rows.map(p=>({id:p.id,label:p.title})),edges:[{source:'1',target:'2'}]}),tagTree:rows=>[...new Set(rows.flatMap(p=>p.tags))].map(tag=>({name:tag,path:tag,count:1,children:[]})),notes:async()=>notes,annotations:async()=>annotations,backlinks:async()=>notes.map(n=>({...n,kind:'note'})),attachments:async()=>[],collections:async()=>[{id:'1',name:'읽을 문헌',count:3}],collectionItems:async()=>papers.map(p=>p.id),openItem:demoAction,relate:demoAction,unrelate:async()=>0,addTags:demoAction,removeTags:demoAction,renameTagBranch:async()=>({updatedItems:0,mergedTags:0}),recolorAnnotations:async()=>0,mergeAnnotations:async()=>{await demoAction();return '11';},setRemark:async(id,text)=>{runtime.entry(refs.get(Number(id))).remark=text;},createNote:async(id,text)=>{notes.push({id:String(20+notes.length),title:'예시 새 노트',text});return notes.at(-1).id;},noteFromAnnotations:async()=>{await demoAction();return '10';}};
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
assert.equal(bench.panel.querySelectorAll('nav [data-tab]').length,17);
assert.equal(bench.panel.querySelectorAll('.sc-paper-card').length,3);
assert.equal(bench.panel.querySelector('.sc-filters').hasAttribute('open'),false);
assert.equal(bench.panel.querySelector('.sc-command-palette').hidden,true);
const snapshot=bench.panel.outerHTML;
bench.destroy();
const inline=file=>fs.readFileSync(path.join(root,file),'utf8').replace(/<\/script/gi,'<\\/script');
const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta id="demo-icon" content="${icon}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Style Custom 0.8.0 · 디자인 미리보기</title><style>body{margin:0;background:#e5e7eb;font:12px system-ui;color:#374151}.demo-bar{height:40px;display:flex;align-items:center;gap:12px;padding:0 18px}.demo-bar strong{font-weight:650}.demo-bar span{color:#4b5563}.demo-feedback{position:fixed;bottom:4px;left:18px;right:18px;font-size:11px} ${css}</style></head><body><div class="demo-bar"><strong>디자인 미리보기</strong><span>예시 문헌 · 실제 라이브러리 연결 없음</span></div><div id="demo-feedback" class="demo-feedback" role="status">간격 조절, 기능 찾기, 필터와 문헌 상세를 직접 확인할 수 있습니다.</div>${snapshot}<script>${inline('src/workspace.js')}</script><script>${inline('src/workbench.js')}</script><script>document.getElementById('style-custom-workbench').remove();(${mountDemo.toString()})(window,CustomStyleWorkbench,CustomStyleWorkspace);</script></body></html>`;
assert.ok(!html.includes('<script src=')&&!html.includes('<link '));
const target=path.join(root,'docs/design-preview.html');fs.writeFileSync(target,html);
console.log('Offline design preview verified: actual workbench DOM, 17 sections, 3 fictional papers, no external assets: '+target);

/* "화면이 자꾸 맨 위로 튀는 버그" (2026-10-06): a press in a tab redrew the page and the reader
   landed at the top. These tests scroll the panel to the middle, press what a reader presses, and
   check the place is kept. linkedom has no layout, so test/fixtures/scroll-model.mjs supplies one
   that clamps a scroll position the way a browser does when the content under it is emptied. */
import test from 'node:test';
import assert from 'node:assert/strict';
import Workbench from '../src/workbench.js';
import PaperGraph from '../src/paper-graph.js';
import {fixture,settle} from './fixtures/workbench-scroll-fixture.mjs';

const TOLERANCE=4;
// Sixty fictional papers citing each other: every tab has more than a screen of content.
function manyPapers(n=60){
 const out=[];
 for(let i=1;i<=n;i++)out.push({id:String(i),key:'K'+i,libraryID:1,title:'Paper number '+i+' on repair',authors:['Ada Lovelace','Alan Turing','Grace Hopper'][i%3],
  year:String(1990+i%35),venue:['Science','Nature','Cell'][i%3],doi:'10.1234/p'+i,itemType:'journalArticle',tags:['topic/'+(i%5),'#t'+(i%7)],
  abstract:'Abstract '+i,related:[String(i%n+1)]});
 return out;
}
function works(papers){
 const map={};
 for(const p of papers){const i=Number(p.id);map['1:'+p.key]={openalex:'W'+i,doi:p.doi,references:[1,2,3].map(k=>'W'+((i*k)%papers.length+1)).filter(w=>w!=='W'+i)};}
 return map;
}
function bench(opts={}){
 const papers=manyPapers(opts.count||60);
 const f=fixture(undefined,undefined,{papers,scroll:{scrollers:['.sc-pick-list','.sc-matrix-scroll','.sc-canvas','.sc-filter-fields']}});
 f.runtime.graphTools=PaperGraph;
 f.runtime.paperWorks=()=>works(papers);
 f.runtime.paperRowStatus=()=>'fresh';
 f.library.graph=rows=>({nodes:rows.map(i=>({id:i.id,label:i.title})),edges:rows.slice(1).map((r,k)=>({source:rows[k].id,target:r.id}))});
 f.library.notes=async()=>papers.map(p=>({id:'n'+p.id,title:'Note on '+p.title,text:'Text '+p.id,modified:'today',parentID:p.id}));
 f.library.annotations=async()=>papers.map(p=>({id:'a'+p.id,key:'A'+p.id,parentID:p.id,attachmentID:'99',text:'Highlight '+p.id,comment:'',color:['#ffd400','#5fb236','#2ea8e5'][Number(p.id)%3],type:'highlight',pageLabel:'1',pageIndex:0}));
 f.library.tagTree=()=>Array.from({length:40},(_,i)=>({name:'tag'+i,path:'tag'+i,count:i+1,children:[]}));
 return f;
}
const scroller=f=>f.body();
function middle(f,el=scroller(f)){
 const max=f.scrollModel.max(el);
 el.scrollTop=Math.round(max/2);
 return el.scrollTop;
}
/* Everything a reader presses or types that only changes the view: buttons marked data-safe="view",
   toggles and chips (aria-pressed, aria-expanded), check boxes, selects, and the find and filter boxes. */
function controls(f){
 const root=scroller(f);
 return [...root.querySelectorAll('button,input,select,summary,[role=button]')].filter(el=>{
  if(el.closest('[hidden]'))return false;
  if(el.disabled)return false;
  if(el.getAttribute('data-writes')||el.getAttribute('data-opens'))return false;
  const tag=el.localName;
  if(tag==='button'||el.getAttribute('role')==='button')return el.getAttribute('data-safe')==='view'||el.hasAttribute('aria-pressed')||el.hasAttribute('aria-expanded');
  if(tag==='summary')return true;
  if(tag==='select')return true;
  if(tag==='input')return ['checkbox','search','text',''].includes(el.getAttribute('type')||'')&&!el.closest('.sc-memo,.sc-notes-editor');
  return false;
 });
}
// The first element with a stable key at or below the top of the view, and how far down it sits.
const KEYS=['data-item-id','data-node-id','data-author-id','data-annotation-id','data-key','data-topic','data-draft-key','data-pick','id'];
const HEADINGS='h2,h3,h4';
function landmark(f){
 const body=scroller(f),top=body.getBoundingClientRect().top,bottom=top+body.clientHeight;
 for(const el of body.querySelectorAll(KEYS.map(k=>`[${k}]`).join(',')+','+HEADINGS)){
  const r=el.getBoundingClientRect();if(!r.height)continue;if(r.top>=bottom)break;
  if(r.top>=top){const attr=KEYS.find(k=>el.getAttribute(k));return attr?{attr,value:el.getAttribute(attr),offset:r.top-top}:{heading:el.textContent.trim(),offset:r.top-top};}
 }
 return null;
}
// Every landmark in view: the place is kept when any of them is where it was.
function landmarks(f){
 const body=scroller(f),top=body.getBoundingClientRect().top,bottom=top+body.clientHeight,out=[];
 for(const el of body.querySelectorAll(KEYS.map(k=>`[${k}]`).join(',')+','+HEADINGS)){
  const r=el.getBoundingClientRect();if(!r.height)continue;if(r.top>=bottom)break;if(r.top<top)continue;
  const attr=KEYS.find(k=>el.getAttribute(k));out.push(attr?{attr,value:el.getAttribute(attr),offset:r.top-top}:{heading:el.textContent.trim(),offset:r.top-top});
 }
 return out;
}
function offsetOf(f,mark){
 const body=scroller(f);
 const el=mark.heading!==undefined?[...body.querySelectorAll(HEADINGS)].find(e=>e.textContent.trim()===mark.heading):[...body.querySelectorAll(`[${mark.attr}]`)].find(e=>e.getAttribute(mark.attr)===mark.value);
 return el?el.getBoundingClientRect().top-body.getBoundingClientRect().top:Infinity;
}
const describe=el=>(el.localName+' '+(el.getAttribute('aria-label')||el.getAttribute('title')||el.textContent||el.getAttribute('placeholder')||'').trim().slice(0,40));
async function act(f,el){
 const tag=el.localName,win=f.win;
 if(tag==='select'){const opts=[...el.querySelectorAll('option')];const next=opts.find(o=>o.getAttribute('value')!==el.value);if(!next)return false;el.value=next.getAttribute('value');el.dispatchEvent(new win.Event('change',{bubbles:true}));}
 else if(tag==='input'&&(el.getAttribute('type')==='checkbox')){el.checked=!el.checked;el.dispatchEvent(new win.Event('change',{bubbles:true}));el.dispatchEvent(new win.Event('click',{bubbles:true}));}
 else if(tag==='input'){el.focus({preventScroll:true});el.value='a';el.dispatchEvent(new win.Event('input',{bubbles:true}));el.dispatchEvent(new win.Event('change',{bubbles:true}));}
 else{el.focus({preventScroll:true});el.dispatchEvent(new win.Event('click',{bubbles:true}));}
 return true;
}
/* Presses every control on the current tab, one at a time, from the middle of the page.
   Returns the presses that moved the page (or lost focus to the document) and were not a navigation. */
async function sweep(f,tab,{limit=400}={}){
 const jumps=[],tried=new Set();
 await f.bench.show(tab);await settle();
 let i=0;
 for(;i<limit;i++){
  if(f.bench.state.tab!==tab){await f.bench.show(tab);await settle();}
  const list=controls(f);if(i>=list.length)break;
  const el=list[i];
  const body=scroller(f);
  // One of each: sixty 자세히 buttons are one control, pressed once.
  const kind=describe(el).replace(/\d+/g,'#');if(tried.has(kind))continue;tried.add(kind);
  if(f.scrollModel.max(body)<60)continue;
  // The reader scrolls down to the control and presses it where it is: in the middle of the view.
  el.scrollIntoView({block:'center'});
  const before=body.scrollTop,seen=landmarks(f);
  const label=describe(el);
  const stop=f.scrollModel.frames();
  try{if(!await act(f,el)){stop();continue;}await settle();await settle();}finally{stop();}
  if(f.bench.state.tab!==tab)continue;// went to another tab: a navigation
  if(el.getAttribute('data-nav'))continue;// an explicit navigation (a person, a page)
  const after=body.scrollTop;
  // Kept: the same scrollTop; or the landmark the reader was looking at is where it was (content above it changed);
  // or the page became shorter than the old position and the browser could only stop at its end.
  const kept=Math.abs(after-before)<=TOLERANCE||seen.some(mark=>Math.abs(offsetOf(f,mark)-mark.offset)<=TOLERANCE)||(after<before&&after>=f.scrollModel.max(body)-TOLERANCE);
  if(!kept)jumps.push(`${tab}: ${label} ${before}→${after}`);
  const active=f.doc.activeElement;
  if(active===f.doc.body)jumps.push(`${tab}: ${label} dropped focus to the document`);
 }
 return jumps;
}

test('scroll model: emptying the scroll area after an await drops its place, as a browser does',async()=>{
 const f=bench();await f.bench.show('explore');await settle();
 const body=f.body();assert.ok(f.scrollModel.max(body)>200,'a long page');
 body.scrollTop=200;assert.equal(body.scrollTop,200);
 const kids=[...body.childNodes];body.replaceChildren();assert.equal(body.scrollTop,0,'clamped once laid out');
 body.append(...kids);assert.equal(body.scrollTop,0,'and not put back by the content returning');
 f.bench.destroy();
});

test('a redraw of the same tab keeps the place: render() on the graph tab from the middle',async()=>{
 const f=bench();await f.bench.show('graph');await settle();
 const body=f.body();const before=middle(f);assert.ok(before>100,'scrolled: '+before);
 const stop=f.scrollModel.frames();await f.bench.render();await settle();stop();
 assert.ok(Math.abs(body.scrollTop-before)<=TOLERANCE,`kept ${before} → ${body.scrollTop}`);
 f.bench.destroy();
});

test('the graph tab: every view control keeps the reader where they were',async()=>{
 const f=bench();
 const jumps=await sweep(f,'graph');
 assert.deepEqual(jumps,[]);
 f.bench.destroy();
});

test('content that grows above the reader does not move what they were reading',async()=>{
 const f=bench();await f.bench.show('explore');await settle();
 const body=f.body();middle(f);
 const seen=landmark(f);assert.ok(seen,'a landmark at the top of the view');
 // The redraw puts five more lines at the head of the page (a notice, a new summary line) before the cards.
 const append=body.appendChild.bind(body);let grown=false;
 body.appendChild=child=>{if(!grown){grown=true;for(let k=0;k<5;k++)append(f.doc.createElement('p'));}return append(child);};
 const stop=f.scrollModel.frames();await f.bench.render();await settle();stop();
 delete body.appendChild;
 assert.ok(grown);
 assert.ok(Math.abs(offsetOf(f,seen)-seen.offset)<=TOLERANCE,`the card stayed ${seen.offset}px down the view: ${offsetOf(f,seen)}`);
 f.bench.destroy();
});

test('changing tab starts the new tab at its top',async()=>{
 const f=bench();await f.bench.show('explore');await settle();
 middle(f);assert.ok(f.body().scrollTop>0);
 await f.bench.show('tags');await settle();
 assert.equal(f.body().scrollTop,0);
 f.bench.destroy();
});

test('a redraw that takes away the focused control focuses the same control in the new page',async()=>{
 const f=bench();await f.bench.show('graph');await settle();
 const pick=[...f.body().querySelectorAll('[data-safe="view"]')].find(b=>/공통 태그/.test(b.textContent));
 assert.ok(pick);
 pick.focus();pick.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();await settle();
 const active=f.doc.activeElement;
 assert.notEqual(active,f.doc.body,'focus did not fall to the document');
 assert.ok(active.isConnected&&/공통 태그/.test(active.textContent),'the same control, redrawn: '+active.textContent);
 f.bench.destroy();
});

for(const [tab] of Workbench.TABS){
 test(`sweep: ${tab} keeps its place on every view-only press`,async()=>{
  const f=bench();
  const jumps=await sweep(f,tab);
  assert.deepEqual(jumps,[]);
  f.bench.destroy();
 });
}

test('self-check: the read-only scroll step keeps the place on the graph and library tabs, pressing only data-safe="view"',async()=>{
 const {createRequire}=await import('node:module');const SelfCheck=createRequire(import.meta.url)('../src/selfcheck.js');
 const f=bench();
 const pressed=[];
 f.bench.panel.addEventListener('click',e=>{const b=e.target.closest?.('button');if(b)pressed.push(b);},true);
 const writes=f.calls.length;
 const stop=f.scrollModel.frames();
 const {checked,lost}=await SelfCheck.scrollKeepCheck({bench:f.bench,runtime:f.runtime,tabs:['graph','explore'],wait:()=>settle()});
 stop();
 assert.deepEqual(lost,[]);
 assert.equal(checked.length,2,checked.join(' | '));
 assert.ok(checked.every(line=>/kept/.test(line)),checked.join(' | '));
 for(const b of pressed){assert.equal(b.getAttribute('data-safe'),'view');assert.equal(b.getAttribute('aria-pressed'),'true');}
 assert.equal(f.calls.slice(writes).filter(c=>!['pref'].includes(c[0])&&/save|write|open|import|relate|trash|create|flush/.test(c[0])).length,0,'nothing written or opened');
 f.bench.destroy();
});

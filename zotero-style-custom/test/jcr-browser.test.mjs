import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseHTML} from 'linkedom';
import Browser from '../src/jcr-browser.js';
import Categories from '../src/jcr-categories.js';

const settle=async()=>{for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));};
// The shipped taxonomy. A clean checkout has only the openly licensed one:
// the captured JCR tables are licensed to their reader and are not in the
// repository, so the large-scale render tests run against this.
const path=new URL('../data/journal-catalog.json',import.meta.url);
function payload(){
 const source={provider:'Clarivate',product:'JCR',url:'https://jcr.clarivate.com/jcr/browse-categories',
  capturedAt:'2026-09-20T04:52:59.928Z',datasetUpdated:'2026-06-17',releaseYear:2026,metricYear:2025,
  complete:{groups:true,categories:true,journals:false}};
 return {schemaVersion:1,source,groups:[
  {key:'Agricultural Sciences',name:'Agricultural Sciences',categoryCount:2,journalCount:50,citableItems:76350,categoryKeys:['AGRONOMY','SHARED CATEGORY']},
  {key:'Clinical Medicine',name:'Clinical Medicine',categoryCount:2,journalCount:475,citableItems:900,categoryKeys:['MEDICINE','SHARED CATEGORY']},
  {key:'Arts & Humanities',name:'Arts & Humanities',categoryCount:1,journalCount:null,citableItems:null,categoryKeys:['HISTORY']}
 ],categories:[
  {key:'AGRONOMY',name:'AGRONOMY',groupKeys:['Agricultural Sciences'],editions:['SCIE'],journalCount:3,citableItems:100,totalCitations:200,medianJIF:2.2},
  {key:'SHARED CATEGORY',name:'SHARED CATEGORY',groupKeys:['Agricultural Sciences','Clinical Medicine'],editions:['SCIE','SSCI'],journalCount:2,citableItems:70,totalCitations:0,medianJIF:0},
  {key:'MEDICINE',name:'MEDICINE',groupKeys:['Clinical Medicine'],editions:['SCIE'],journalCount:1,citableItems:50,totalCitations:500,medianJIF:3.1},
  {key:'HISTORY',name:'HISTORY',groupKeys:['Arts & Humanities'],editions:['AHCI'],journalCount:10,citableItems:null,totalCitations:null,medianJIF:'<0.1'}
 ],journals:[
  {key:'alpha',title:'Alpha Journal',abbreviation:'ALPHA J',issns:['1234-5678'],categoryKeys:['AGRONOMY','SHARED CATEGORY'],jif:2,year:2025,
   categoryMetrics:[{categoryKey:'AGRONOMY',editions:['SCIE'],rank:2,rankTotal:3,quartile:3,percentile:55.5},
    {categoryKey:'SHARED CATEGORY',editions:['SCIE'],rank:1,rankTotal:2,quartile:1,percentile:99.1},
    {categoryKey:'SHARED CATEGORY',editions:['SSCI'],rank:2,rankTotal:2,quartile:4,percentile:20.4}]},
  {key:'zulu',title:'Zulu Journal',abbreviation:'ZULU J',issns:[],categoryKeys:['AGRONOMY'],jif:8,year:2025,
   categoryMetrics:[{categoryKey:'AGRONOMY',editions:['SCIE'],rank:1,rankTotal:3,quartile:null,percentile:null}]},
  {key:'unknown',title:'No Figures Journal',issns:[],categoryKeys:['AGRONOMY'],jif:null,year:null,
   categoryMetrics:[{categoryKey:'AGRONOMY',editions:[],rank:null,rankTotal:null,quartile:null,percentile:null,rankDisplay:'N/A',quartileDisplay:'N/A',percentileDisplay:'N/A'}]},
  {key:'shared',title:'Shared Journal',issns:[],categoryKeys:['SHARED CATEGORY'],jif:0,year:2025},
  {key:'medicine',title:'Medicine Journal',issns:[],categoryKeys:['MEDICINE'],jif:'<0.1',year:2025}
 ]};
}
function fixture({data=payload(),...options}={}){
 const {document:doc,window:win}=parseHTML('<html><body><main id="style-custom-workbench"><div id="host"></div></main></body></html>');
 Object.defineProperty(win.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this._value??this.querySelector('option[selected]')?.getAttribute('value')??this.querySelector('option')?.getAttribute('value')??'';},set(value){this._value=String(value);}});
 Object.defineProperty(doc,'activeElement',{configurable:true,get(){return this._active||doc.body;}});
 win.HTMLElement.prototype.focus=function(){doc._active=this;};
 const calls=[],catalog=Categories.create(data),host=doc.getElementById('host');
 const browser=Browser.mount(host,{catalog,onSearchJournal:(row,context)=>calls.push(['journal',row.key,context]),
  onOpenSource:(url,context)=>calls.push(['source',url,context]),onOpenAlex:()=>calls.push(['openalex']),
  onStateChange:state=>calls.push(['state',state]),...options});
 const button=text=>[...host.querySelectorAll('button')].find(b=>b.textContent===text);
 const click=node=>{assert.ok(node,'expected clickable node');node.dispatchEvent(new win.Event('click',{bubbles:true}));};
 const group=key=>[...host.querySelectorAll('.sc-jcr-group')].find(node=>node.dataset.groupKey===key);
 const category=key=>[...host.querySelectorAll('[data-category-key]')].find(node=>node.dataset.categoryKey===key);
 const search=value=>{const input=host.querySelector('input[type="search"]');assert.ok(input);input.focus();input.value=value;input.dispatchEvent(new win.Event('input',{bubbles:true}));};
 const sort=key=>{const input=host.querySelector('select');input.value=key;input.dispatchEvent(new win.Event('change',{bubbles:true}));};
 return {win,doc,host,browser,catalog,calls,button,click,group,category,search,sort};
}

test('default JCR view has wide group accordions with captured counts and actual member-category buttons',()=>{
 const data=payload();data.groups[0].categoryKeys.reverse();const f=fixture({data});
 assert.equal(f.browser.state.view,'groups');assert.equal(f.host.querySelectorAll('.sc-jcr-group').length,3);
 assert.deepEqual([...f.host.querySelectorAll('.sc-jcr-group')].map(n=>n.dataset.groupKey),['Agricultural Sciences','Arts & Humanities','Clinical Medicine']);
 const agriculture=f.group('Agricultural Sciences');
 assert.deepEqual([...agriculture.querySelectorAll('.sc-jcr-group-metric')].map(n=>n.textContent),['2','50','76,350']);
 assert.notEqual(agriculture.querySelectorAll('.sc-jcr-group-metric')[1].textContent,'5','source totals are not computed by summing category memberships');
 const toggle=agriculture.querySelector('button');
 assert.equal(toggle.getAttribute('aria-expanded'),'false');assert.match(toggle.getAttribute('aria-label'),/저널 수 50/);
 f.click(toggle);
 assert.equal(f.group('Agricultural Sciences').querySelector('button').getAttribute('aria-expanded'),'true');
 const region=f.group('Agricultural Sciences').querySelector('[role="region"]');
 assert.equal(region.id,f.group('Agricultural Sciences').querySelector('button').getAttribute('aria-controls'));
 assert.deepEqual([...region.querySelectorAll('.sc-jcr-category-link')].map(n=>n.textContent),['Agronomy','Shared Category'],'names, not capitals');
 assert.deepEqual([...region.querySelectorAll('.sc-jcr-category-link')].map(n=>n.dataset.categoryKey),['AGRONOMY','SHARED CATEGORY']);
 f.click(f.group('Clinical Medicine').querySelector('button'));
 assert.equal(f.host.querySelectorAll('[aria-expanded="true"]').length,2);
 f.click(f.group('Agricultural Sciences').querySelector('button'));
 assert.equal(f.group('Agricultural Sciences').querySelector('[role="region"]'),null);
 const unknown=f.group('Arts & Humanities');assert.deepEqual([...unknown.querySelectorAll('.sc-jcr-group-metric')].map(n=>n.textContent),['1','—','—']);
 assert.match(f.host.querySelector('.sc-jcr-source').textContent,/Clarivate · JCR · 2026 · 지표 연도 2025 · 원본 갱신 2026-06-17 · 수집 2026-09-20/);
 assert.equal(f.button('JCR 원본 열기').dataset.opens,'external');
 assert.equal(f.host.querySelector('select[data-level]'),null,'no OpenAlex domain/field/subfield controls in JCR mode');
 f.browser.destroy();
});

test('all-category table retains all parent groups, editions, exact zeros and bounded or unavailable values',()=>{
 const f=fixture();f.click(f.button('전체 카테고리 · 4'));
 assert.equal(f.browser.state.view,'categories');
 assert.equal(f.browser.state.sortKey,'journalCount');assert.equal(f.browser.state.sortDir,'desc');
 assert.deepEqual([...f.host.querySelectorAll('tbody tr')].map(n=>n.dataset.categoryKey),['HISTORY','AGRONOMY','SHARED CATEGORY','MEDICINE']);
 assert.deepEqual([...f.host.querySelectorAll('thead th')].map(n=>n.textContent),['카테고리','그룹','색인','저널 수','인용 가능 항목','총 인용','JIF 중앙값']);
 const shared=f.category('SHARED CATEGORY');
 assert.deepEqual([...shared.querySelectorAll('[data-column="groups"] li')].map(n=>n.textContent),['Agricultural Sciences','Clinical Medicine']);
 assert.deepEqual([...shared.querySelectorAll('[data-column="editions"] .sc-jcr-pill')].map(n=>n.textContent),['SCIE','SSCI']);
 assert.equal(shared.querySelector('[data-column="totalCitations"]').textContent,'0');
 assert.equal(shared.querySelector('[data-column="medianJIF"]').textContent,'0');
 const history=f.category('HISTORY');
 assert.equal(history.querySelector('[data-column="citableItems"]').textContent,'—');
 assert.equal(history.querySelector('[data-column="medianJIF"]').textContent,'<0.1');
 f.browser.destroy();
});

test('category journal drilldown uses captured membership and selected-category official metrics only',()=>{
 const f=fixture();f.click(f.group('Agricultural Sciences').querySelector('button'));f.click(f.category('AGRONOMY'));
 assert.equal(f.browser.state.categoryKey,'AGRONOMY');assert.equal(f.browser.state.view,'journals');
 assert.deepEqual([...f.host.querySelectorAll('[data-journal-key]')].map(n=>n.dataset.journalKey),['zulu','alpha','unknown']);
 assert.match(f.host.querySelector('.sc-jcr-coverage').textContent,/수집된 저널 3 \/ 3 · 전체 저널 목록 수집 미완료/);
 const alpha=f.host.querySelector('[data-journal-key="alpha"]');
 assert.equal(alpha.querySelector('[data-column="rank"]').textContent,'2/3');
 assert.equal(alpha.querySelector('[data-column="quartile"]').textContent,'Q3');
 assert.equal(alpha.querySelector('[data-column="percentile"]').textContent,'55.5');
 assert.doesNotMatch(alpha.querySelector('[data-column="quartile"]').textContent,/Q1|Q4/);
 const zulu=f.host.querySelector('[data-journal-key="zulu"]');assert.equal(zulu.querySelector('[data-column="rank"]').textContent,'1/3');
 assert.equal(zulu.querySelector('[data-column="quartile"]').textContent,'—','known rank must not be used to invent missing Q');
 const unknown=f.host.querySelector('[data-journal-key="unknown"]');assert.equal(unknown.querySelector('[data-column="quartile"]').textContent,'N/A');
 assert.equal(alpha.querySelector('button').dataset.opens,'window');
 f.click(alpha.querySelector('button'));assert.deepEqual(f.calls.find(c=>c[0]==='journal'),['journal','alpha',{categoryKey:'AGRONOMY'}]);
 f.click(f.button('뒤로'));assert.equal(f.browser.state.view,'groups');assert.ok(f.group('Agricultural Sciences').querySelector('[role="region"]'));
 f.click(f.category('SHARED CATEGORY'));
 const sharedAlpha=f.host.querySelector('[data-journal-key="alpha"]');
 assert.deepEqual([...sharedAlpha.querySelectorAll('[data-column="rank"] li')].map(n=>n.textContent),['SCIE: 1/2','SSCI: 2/2']);
 assert.deepEqual([...sharedAlpha.querySelectorAll('[data-column="quartile"] li')].map(n=>n.textContent),['SCIE: Q1','SSCI: Q4']);
 assert.equal(f.host.querySelector('[data-journal-key="shared"] [data-column="rank"]').textContent,'—','no locally calculated rank from JIF order');
 f.browser.destroy();
});

test('search, direction, pagination and back navigation preserve the route being explored',()=>{
 const f=fixture({pageSize:2});
 f.search('SHARED CATEGORY');assert.equal(f.host.querySelectorAll('.sc-jcr-group').length,2,'group search includes actual child category names');
 assert.equal(f.doc.activeElement,f.host.querySelector('input'),'redraw retains search focus');
 f.search('');f.click(f.button('전체 카테고리 · 4'));
 assert.equal(f.host.querySelectorAll('tbody tr').length,2);assert.equal(f.button('이전').disabled,true);
 f.click(f.button('다음'));assert.equal(f.browser.state.page,1);
 assert.equal(f.button('다음').disabled,true);
 f.click(f.category('MEDICINE').querySelector('button'));assert.equal(f.browser.state.view,'journals');
 assert.equal(f.host.querySelector('td[data-column="jif"].sc-jcr-number').textContent,'<0.1');
 f.click(f.button('뒤로'));assert.equal(f.browser.state.view,'categories');assert.equal(f.browser.state.page,1);
 f.search('AGRON');assert.equal(f.browser.state.page,0);assert.equal(f.host.querySelectorAll('tbody tr').length,1);
 f.click(f.category('AGRONOMY').querySelector('button'));
 f.search('1234-5678');assert.deepEqual([...f.host.querySelectorAll('[data-journal-key]')].map(n=>n.dataset.journalKey),['alpha']);
 f.search('');f.sort('name');
 assert.equal(f.browser.state.sortDir,'desc');f.click(f.button('내림차순'));
 assert.equal(f.host.querySelector('[data-journal-key]').dataset.journalKey,'alpha');
 f.sort('jif');assert.equal(f.host.querySelector('[data-journal-key]').dataset.journalKey,'alpha');
 f.click(f.button('오름차순'));assert.equal(f.host.querySelector('[data-journal-key]').dataset.journalKey,'zulu');
 f.click(f.button('뒤로'));assert.equal(f.browser.state.query,'AGRON');assert.equal(f.browser.state.view,'categories');
 f.browser.destroy();
});

test('missing journal capture is visibly incomplete and never replaced with OpenAlex or guessed zero totals',()=>{
 const f=fixture();f.click(f.group('Arts & Humanities').querySelector('button'));f.click(f.category('HISTORY'));
 assert.equal(f.host.querySelectorAll('[data-journal-key]').length,0);
 assert.match(f.host.textContent,/JCR 저널 수10/);assert.match(f.host.textContent,/수집된 저널 0 \/ 10/);
 assert.match(f.host.textContent,/아직 수집되지 않았습니다/);
 assert.equal(f.button('JCR 원본에서 저널 확인').dataset.opens,'external');
 f.click(f.button('JCR 원본에서 저널 확인'));
 assert.deepEqual(f.calls.find(c=>c[0]==='source'),['source','https://jcr.clarivate.com/jcr/browse-categories',{view:'journals',categoryKey:'HISTORY'}]);
 assert.equal(f.calls.some(c=>c[0]==='openalex'),false);
 f.click(f.button('OpenAlex 주제로 탐색'));assert.equal(f.calls.filter(c=>c[0]==='openalex').length,1);
 const incomplete=payload();incomplete.source.complete.categories=false;
 f.browser.updateCatalog(Categories.create(incomplete));f.click(f.button('수집된 카테고리 · 4'));
 assert.equal(f.host.querySelector('h2').textContent,'수집된 카테고리');assert.match(f.host.textContent,/일부만 수집/);
 f.browser.destroy();
});

test('destroy removes only this mount and ignores late callbacks while saved state can be restored',async()=>{
 let reject;const pending=new Promise((_,r)=>{reject=r;});
 const f=fixture({onSearchJournal:()=>pending});
 const sibling=f.doc.createElement('div');sibling.id='keep';f.host.appendChild(sibling);
 f.click(f.group('Agricultural Sciences').querySelector('button'));f.click(f.category('AGRONOMY'));
 f.search('Alpha');const saved=f.browser.state;
 const snapshot=f.browser.state;snapshot.expandedGroupKeys.length=0;assert.ok(f.browser.state.expandedGroupKeys.length);
 f.click(f.host.querySelector('[data-journal-key="alpha"] button'));
 const old=f.button('JCR 원본 열기');f.browser.destroy();f.browser.destroy();
 f.click(old);reject(new Error('late provider failure'));await settle();
 assert.equal(f.host.children.length,1);assert.equal(f.host.firstChild,sibling);assert.equal(f.calls.some(c=>c[0]==='source'),false);
 const next=Browser.mount(f.host,{catalog:f.catalog,initialState:saved});
 assert.equal(next.state.view,'journals');assert.equal(next.state.categoryKey,'AGRONOMY');assert.equal(next.state.query,'Alpha');
 assert.equal(next.element.querySelector('[data-journal-key]').dataset.journalKey,'alpha');next.destroy();
});

test('catalog updates fill journal membership without losing category selection, and text remains inert',()=>{
 const data=payload();data.journals=[];const f=fixture({data});
 f.click(f.group('Agricultural Sciences').querySelector('button'));f.click(f.category('AGRONOMY'));
 assert.match(f.host.textContent,/수집된 저널 0 \/ 3/);
 const populated=payload();populated.journals[0].title='<img src=x onerror="bad()"> Literal title';
 f.browser.updateCatalog(Categories.create(populated));
 assert.equal(f.browser.state.categoryKey,'AGRONOMY');assert.equal(f.host.querySelectorAll('[data-journal-key]').length,3);
 assert.equal(f.host.querySelector('img'),null);assert.match(f.host.textContent,/<img src=x/);
 assert.throws(()=>f.browser.updateCatalog({}),/Invalid JCR/);
 f.browser.destroy();
});

test('the shipped catalog renders its whole group structure, every category and exact group membership',()=>{
 const data=JSON.parse(fs.readFileSync(path,'utf8')),f=fixture({data,pageSize:200});
 const groups=data.groups.length,categories=data.categories.length;
 assert.ok(groups>=20&&categories>=200,'the real thing, not a stub');
 assert.equal(f.host.querySelectorAll('.sc-jcr-group').length,groups);
 assert.equal(f.button(`전체 카테고리 · ${categories}`).textContent,`전체 카테고리 · ${categories}`);
 for(const group of data.groups){
  const row=f.group(group.key);assert.ok(row);const values=[...row.querySelectorAll('.sc-jcr-group-metric')].map(n=>n.textContent);
  assert.deepEqual(values,[group.categoryCount,group.journalCount,group.citableItems].map(n=>n==null?'—':Number(n).toLocaleString()));
 }
 const first=data.groups[0];
 f.click(f.group(first.key).querySelector('button'));
 assert.equal(f.group(first.key).querySelectorAll('.sc-jcr-category-link').length,first.categoryCount);
 f.click(f.button(`전체 카테고리 · ${categories}`));assert.equal(f.host.querySelectorAll('tbody tr').length,200);
 f.click(f.button('다음'));assert.equal(f.host.querySelectorAll('tbody tr').length,categories-200);
 f.browser.destroy();
});

test('visible page-size choices match the catalog and persist while resetting the current page',()=>{
 const data=JSON.parse(fs.readFileSync(path,'utf8')),f=fixture({data});
 f.click(f.button(`전체 카테고리 · ${data.categories.length}`));
 const size=()=>f.host.querySelector('[data-focus-key="page-size"]');
 assert.deepEqual([...size().querySelectorAll('option')].map(n=>n.value),['25','50','75','100','200']);
 assert.equal(f.host.querySelectorAll('tbody tr').length,25);
 // The default order is by journal count, so the biggest category leads.
 const biggest=[...data.categories].sort((a,b)=>b.journalCount-a.journalCount||String(a.name).localeCompare(String(b.name)))[0];
 assert.equal(f.host.querySelector('tbody tr').dataset.categoryKey,biggest.key);
 f.click(f.button('다음'));assert.equal(f.browser.state.page,1);
 size().value='75';size().dispatchEvent(new f.win.Event('change',{bubbles:true}));
 assert.equal(f.browser.state.page,0);assert.equal(f.browser.state.pageSize,75);assert.equal(f.host.querySelectorAll('tbody tr').length,75);
 f.click(f.button('다음'));assert.equal(f.browser.state.page,1);
 size().value='100';size().dispatchEvent(new f.win.Event('change',{bubbles:true}));
 assert.equal(f.browser.state.page,0);assert.equal(f.host.querySelectorAll('tbody tr').length,100);
 const saved=f.browser.state;assert.equal(f.calls.filter(c=>c[0]==='state').at(-1)[1].pageSize,100);
 f.browser.destroy();const restored=Browser.mount(f.host,{catalog:f.catalog,initialState:saved});
 assert.equal(restored.state.pageSize,100);assert.equal(restored.element.querySelectorAll('tbody tr').length,100);restored.destroy();
 const custom=fixture({pageSize:2});custom.click(custom.button('전체 카테고리 · 4'));
 assert.deepEqual([...custom.host.querySelector('[data-focus-key="page-size"]').querySelectorAll('option')].map(n=>n.value),['2','25','50','75','100','200']);
 custom.browser.destroy();
});

test('numeric sorting keeps unknown and bounded values last in either direction without replacing real zeros',()=>{
 const f=fixture();f.click(f.button('전체 카테고리 · 4'));f.sort('medianJIF');
 assert.deepEqual([...f.host.querySelectorAll('tbody tr')].map(n=>n.dataset.categoryKey),['MEDICINE','AGRONOMY','SHARED CATEGORY','HISTORY']);
 f.click(f.button('내림차순'));
 assert.deepEqual([...f.host.querySelectorAll('tbody tr')].map(n=>n.dataset.categoryKey),['SHARED CATEGORY','AGRONOMY','MEDICINE','HISTORY']);
 assert.equal(f.category('SHARED CATEGORY').querySelector('[data-column="medianJIF"]').textContent,'0');
 assert.equal(f.category('HISTORY').querySelector('[data-column="medianJIF"]').textContent,'<0.1');
 assert.match(f.host.querySelector('select').title,/범위값과 미확인 값은 마지막/);
 f.browser.destroy();
});

test('mounts have independent accordion identities, safe restored routes and bounded callback errors',async()=>{
 const failures=[];const f=fixture({initialState:{history:[{view:'groups'}],expandedGroupKeys:['missing']},
  onOpenSource:()=>{throw new Error('<private request details>');},onError:error=>failures.push(error)});
 const host=f.doc.createElement('div');f.doc.body.appendChild(host);const second=Browser.mount(host,{catalog:f.catalog});
 assert.notEqual(f.group('Agricultural Sciences').querySelector('button').id,host.querySelector('.sc-jcr-group-toggle').id);
 assert.deepEqual(f.browser.state.expandedGroupKeys,[]);
 f.click(f.button('뒤로'));assert.equal(f.browser.state.query,'');
 f.click(f.button('JCR 원본 열기'));await settle();
 assert.match(f.host.querySelector('[role="alert"]').textContent,/요청을 완료하지 못했습니다/);
 assert.doesNotMatch(f.host.textContent,/private request details/);assert.equal(failures.length,1);
 second.destroy();f.browser.destroy();
});

test('categories read as names, with their groups and editions as chips and their size as a bar', () => {
  /* JCR prints EDUCATION & EDUCATIONAL RESEARCH; two hundred and fifty lines
     of that is a wall. The key and the original spelling stay on the element. */
  const f = fixture({initialState: {view: 'categories'}});
  const first = f.host.querySelector('[data-category-key="AGRONOMY"]');
  assert.ok(first, 'the row still carries its key');
  const link = first.querySelector('.sc-jcr-category-link');
  assert.equal(link.textContent, 'Agronomy');
  assert.equal(link.title, 'AGRONOMY', 'the original spelling is one hover away');
  assert.ok(first.querySelector('[data-column="editions"] .sc-jcr-pill'), 'editions are pills, not a dotted string');
  const count = first.querySelector('[data-column="journalCount"]');
  assert.ok(count.querySelector('.sc-jcr-bar'), 'the journal count carries a bar');
  const fills = [...f.host.querySelectorAll('.sc-jcr-bar')].map(b => parseInt(b.style.getPropertyValue('--sc-jcr-fill'), 10));
  assert.equal(Math.max(...fills), 100, 'the biggest category on the page fills its bar');
  assert.ok(fills.every(v => v >= 2 && v <= 100));
  assert.ok(first.querySelector('[data-column="medianJIF"]').dataset.tone, 'the figure carries a tone');
  f.browser.destroy();
});

test('a category name keeps its initialisms and joiners when made readable', () => {
  const f = fixture({initialState: {view: 'categories'}});
  const link = f.host.querySelector('[data-category-key="SHARED CATEGORY"] .sc-jcr-category-link');
  assert.equal(link.textContent, 'Shared Category');
  f.browser.destroy();
});

/* The captured JCR rows carry no abbreviation of their own, so the browser
   derives one from the plugin's journal identity table. Loading it here is
   what the plugin does: both files are scripts on the same global. */
import '../src/journal-identity.js';

function realistic(){
 const source={provider:'Clarivate',product:'JCR',url:'https://jcr.clarivate.com/jcr/browse-categories',
  capturedAt:'2026-09-20T04:52:59.928Z',datasetUpdated:'2026-06-17',releaseYear:2026,metricYear:2025,
  complete:{groups:true,categories:true,journals:false}};
 return {schemaVersion:1,source,groups:[
  {key:'Agricultural Sciences',name:'Agricultural Sciences',categoryCount:1,journalCount:1,citableItems:5,categoryKeys:['AGRICULTURE, MULTIDISCIPLINARY']},
  {key:'Multidisciplinary',name:'Multidisciplinary',categoryCount:1,journalCount:3,citableItems:10,categoryKeys:['MULTIDISCIPLINARY SCIENCES']}
 ],categories:[
  {key:'AGRICULTURE, MULTIDISCIPLINARY',name:'AGRICULTURE, MULTIDISCIPLINARY',groupKeys:['Agricultural Sciences'],editions:['SCIE'],journalCount:1,citableItems:5,totalCitations:50,medianJIF:1},
  {key:'MULTIDISCIPLINARY SCIENCES',name:'MULTIDISCIPLINARY SCIENCES',groupKeys:['Multidisciplinary'],editions:['SCIE'],journalCount:3,citableItems:10,totalCitations:100,medianJIF:3}
 ],journals:[
  {key:'natcommun',title:'Nature Communications',issns:['2041-1723'],categoryKeys:['MULTIDISCIPLINARY SCIENCES'],jif:18.1,year:2025},
  {key:'pnas',title:'PROCEEDINGS OF THE NATIONAL ACADEMY OF SCIENCES OF THE UNITED STATES OF AMERICA',issns:['0027-8424','1091-6490'],categoryKeys:['MULTIDISCIPLINARY SCIENCES'],jif:9.4,year:2025},
  {key:'pnasnexus',title:'PNAS Nexus',issns:['2752-6542'],categoryKeys:['MULTIDISCIPLINARY SCIENCES'],jif:30,year:2025},
  {key:'agri',title:'Agricultural Journal',issns:[],categoryKeys:['AGRICULTURE, MULTIDISCIPLINARY'],jif:1,year:2025}
 ]};
}
const journalKeys=host=>[...host.querySelectorAll('[data-journal-key]')].map(node=>node.dataset.journalKey);

test('a journal in a category is found by its derived abbreviation and by an ISSN written either way',()=>{
 const f=fixture({data:realistic(),initialState:{view:'journals',categoryKey:'MULTIDISCIPLINARY SCIENCES'}});
 assert.deepEqual(journalKeys(f.host).length,3);
 f.search('nat commun');assert.deepEqual(journalKeys(f.host),['natcommun'],'the abbreviation JCR never captured');
 f.search('2041-1723');assert.deepEqual(journalKeys(f.host),['natcommun']);
 f.search('20411723');assert.deepEqual(journalKeys(f.host),['natcommun'],'an ISSN typed without its hyphen');
 f.search('Nature Communications');assert.deepEqual(journalKeys(f.host),['natcommun']);
 f.browser.destroy();
});

test('an exact abbreviation outranks the journal that merely starts with the same letters',()=>{
 const f=fixture({data:realistic(),initialState:{view:'journals',categoryKey:'MULTIDISCIPLINARY SCIENCES'}});
 f.search('PNAS');
 assert.deepEqual(journalKeys(f.host),['pnas','pnasnexus'],'PNAS itself comes before PNAS Nexus despite the lower JIF');
 f.browser.destroy();
});

test('typing a journal name on the group view lists the journal instead of nothing',()=>{
 const f=fixture({data:realistic()});
 f.search('Nature Communications');
 assert.equal(f.host.querySelectorAll('.sc-jcr-group').length,0,'no group is named that');
 assert.deepEqual(journalKeys(f.host),['natcommun']);
 assert.equal(f.host.querySelector('[data-found-by="journal-search"]').querySelector('.sc-jcr-abbreviation').textContent,'Nat Commun');
 f.click(f.host.querySelector('[data-found-by="journal-search"] .sc-jcr-category-link'));
 assert.equal(f.browser.state.view,'journals');
 assert.equal(f.browser.state.categoryKey,'MULTIDISCIPLINARY SCIENCES','the journal opens the category it sits in');
 f.browser.destroy();
});

test('the journal fallback on the category view hands the journal to the same search action',()=>{
 const f=fixture({data:realistic(),initialState:{view:'categories'}});
 f.search('2041-1723');
 assert.equal(f.host.querySelectorAll('[data-category-key] td').length,0,'no category is named that');
 const action=[...f.host.querySelectorAll('[data-found-by="journal-search"] button')].at(-1);
 assert.equal(action.getAttribute('data-opens'),'window','a button that opens a window still says so');
 f.click(action);
 const call=f.calls.filter(c=>c[0]==='journal').at(-1);
 assert.deepEqual(call.slice(1),['natcommun',{categoryKey:'MULTIDISCIPLINARY SCIENCES'}]);
 f.browser.destroy();
});

test('a group found by its own name comes before one found through a member category',()=>{
 const f=fixture({data:realistic()});
 f.search('multidisciplinary');
 assert.deepEqual([...f.host.querySelectorAll('.sc-jcr-group')].map(n=>n.dataset.groupKey),
  ['Multidisciplinary','Agricultural Sciences'],'name before membership, though the alphabet says otherwise');
 f.browser.destroy();
});

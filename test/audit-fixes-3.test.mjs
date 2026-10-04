import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read=f=>fs.readFileSync(new URL('../content/'+f,import.meta.url),'utf8');

// ---- 1. skip duplicates sees an item saved a moment ago
function importerWithDB(){
 let saved=[],queries=0,nextID=1;
 class Item{constructor(t){this.itemType=t;this.itemTypeID=1;this.f={};this.creators=[];}
  setField(k,v){this.f[k]=v;} getField(k){return this.f[k]||'';} setCreators(c){this.creators=c;} setCollections(){}
  async saveTx(){ if(!this.id){this.id=nextID++;saved.push(this);} return this.id; }}
 const Zotero={
  Item, logError(){},
  ItemTypes:{getID:()=>1}, ItemFields:{getID:n=>n,isValidForType:()=>true},
  Translate:{Search:class{setIdentifier(){} async getTranslators(){return [];}}},
  Items:{getAsync:async id=>saved.find(i=>i.id===id)},
  DB:{queryAsync:async sql=>{queries++; if(/FROM items I/.test(sql)&&/fieldName = 'title'/.test(sql)) return saved.map(i=>({itemID:i.id,title:i.f.title,date:i.f.date,doi:null,extra:null})); return [];}},
 };
 const ctx=vm.createContext({Zotero,ZotPoPSources:{SOURCES:{}}});
 vm.runInContext(read('importer.js'),ctx);
 return {imp:ctx.ZotPoPImporter,saved,queries:()=>queries};
}
test('skip duplicates: the same no-DOI paper imported twice in a row is saved once',async()=>{
 const {imp,saved}=importerWithDB();
 const rec={title:'A long enough title about genome editing in cells',year:2024,authors:[]};
 const opts={libraryID:1,attachPDF:false,skipDuplicates:true,citationsInExtra:false};
 const a=await imp.importRecord({...rec},opts);
 const b=await imp.importRecord({...rec},opts);
 assert.equal(a.status,'added'); assert.equal(b.status,'exists'); assert.equal(saved.length,1);
});

// ---- 2. collective authors
import S from '../content/sources.js';
const ctxS=()=>({enrichCitations:false,journalMetrics:false,institutionMetrics:false});
const pm=(docs)=>({urls:[],async getJSON(url){this.urls.push(url);
 if(url.includes('esearch'))return {esearchresult:{count:String(docs.length),idlist:docs.map(d=>d.uid)}};
 if(url.includes('esummary'))return {result:{uids:docs.map(d=>d.uid),...Object.fromEntries(docs.map(d=>[d.uid,d]))}};
 return {};},async getText(){return '';}});
const collective={uid:'77',title:'Guidelines for base editing trials',authors:[{name:'Genome Editing Consortium',authtype:'CollectiveName'},{name:'Smith A',authtype:'Author'}],pubdate:'2022',fulljournalname:'J Things',source:'J Things',articleids:[{idtype:'doi',value:'10.1000/c77'}]};
test('pubmed: a CollectiveName author is kept as an organisation and found by author search',async()=>{
 const rows=await S.search('pubmed',{authors:'Genome Editing Consortium',maxResults:5},pm([collective]),ctxS());
 assert.equal(rows.length,1);
 const org=rows[0].authors.find(a=>a.kind==='organization');
 assert.equal(org.name,'Genome Editing Consortium');
 const kw=await S.search('pubmed',{keywords:'base editing',maxResults:5},pm([collective]),ctxS());
 assert.equal(kw[0].authors.length,2);
});
test('an organisation author is imported as a single-field creator',async()=>{
 const {imp,saved}=importerWithDB();
 await imp.importRecord({title:'Guidelines for base editing trials in humans',year:2022,authors:[{name:'Genome Editing Consortium',lastName:'Genome Editing Consortium',firstName:'',kind:'organization'},{firstName:'A',lastName:'Smith'}]},{libraryID:1,attachPDF:false,citationsInExtra:false});
 const c=saved[0].creators;
 assert.equal(c[0].fieldMode,1); assert.equal(c[0].lastName,'Genome Editing Consortium'); assert.equal(c[0].firstName,'');
 assert.ok(!c[1].fieldMode);
});

// ---- 5. PubMed abstracts, fetched lazily
const efetchXml = `<PubmedArticleSet>
<PubmedArticle><MedlineCitation><PMID Version="1">111</PMID><Article><Abstract>
<AbstractText Label="BACKGROUND">Genes &amp; cells.</AbstractText><AbstractText Label="RESULTS">It worked.</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>
<PubmedArticle><MedlineCitation><PMID Version="1">222</PMID><Article><Abstract><AbstractText>Plain <i>text</i>.</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>
<PubmedArticle><MedlineCitation><PMID Version="1">333</PMID><Article></Article></MedlineCitation></PubmedArticle>
</PubmedArticleSet>`;
test('fetchPubMedAbstracts: one EFetch for several PMIDs, structured abstracts joined, cached, no email sent',async()=>{
 const urls=[];
 const http={async getText(u){urls.push(u);return efetchXml;},async getJSON(){return {};}};
 const got=await S.fetchPubMedAbstracts(['111','222','333'],http,{email:'a@b.c'});
 assert.equal(urls.length,1);
 assert.ok(urls[0].includes('efetch.fcgi')&&urls[0].includes('111,222,333'));
 assert.ok(!urls[0].includes('a%40b.c')&&!urls[0].includes('a@b.c')&&!/email=/.test(urls[0]),'no email address leaves');
 assert.equal(got.get('111'),'BACKGROUND: Genes & cells.\nRESULTS: It worked.');
 assert.equal(got.get('222'),'Plain text.');
 assert.equal(got.has('333')?got.get('333'):'',''); 
 await S.fetchPubMedAbstracts(['111','222','333'],http,{});
 assert.equal(urls.length,1,'the second ask is answered from the cache, missing ones included');
});

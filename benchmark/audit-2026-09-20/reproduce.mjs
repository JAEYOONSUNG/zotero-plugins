// Read-only, deterministic audit probes. Run from any working directory.
// These assert the observed defects, not desired product behavior.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import S from '../../content/sources.js';
import Q from '../../content/query.js';
import { evaluateCase } from '../../scripts/benchmark-search.mjs';
import {loadPoPReference,compareRecords} from '../../scripts/lib/pop-reference.mjs';
const findings={};
findings.authorFalsePositive=Q.matchesAuthor('Sheila Ingemann',[{firstName:'Sheila I.',lastName:'Stewart',name:'Sheila I. Stewart'}]);
assert.equal(findings.authorFalsePositive,true);
const backendCaps={},saved={};
try {
 for(const key of ['openalex','crossref','europepmc','arxiv']) {
  saved[key]=S.SOURCES[key].search;
  S.SOURCES[key].search=async q=>{
   backendCaps[key]=q.maxResults;
   return Array.from({length:q.maxResults},(_,i)=>S.makeRecord({source:key,sourceId:key+i,title:`Genome study ${key} number ${i}`,doi:`10.9999/${key}-${i}`,year:2020,authors:[{name:'Ada Byrne'}]}));
  };
 }
 const rows=await S.search('multi',{keywords:'genome',maxResults:1000},{},{enrichCitations:false,journalMetrics:false,institutionMetrics:false});
 findings.combinedCap={requested:1000,returned:rows.length,backendCaps};
 assert.equal(rows.length,800);
} finally {for(const [key,search]of Object.entries(saved))S.SOURCES[key].search=search;}
findings.titleQueries={epmc:S.epmcQuery({title:'cancer OR genome'}),pubmedNegation:S.pubmedTerm({title:'NOT cancer'}),pubmedTitle:S.pubmedTerm({title:'CRISPR Cas9 assisted recombineering in Lactobacillus reuteri'})};
assert.equal(findings.titleQueries.epmc,'TITLE:"cancer OR genome"');
assert.equal(findings.titleQueries.pubmedNegation,'cancer[ti]');
const signed=['+','-'].map((sign,i)=>S.makeRecord({source:['crossref','openalex'][i],sourceId:String(i),title:`Bacterial growth at ${sign}10 C`,year:2020,authors:[{name:'Ada Byrne'}]}));
findings.signedTitleDedupe={input:signed.map(r=>r.title),output:S.dedupe(signed).map(r=>r.title)};
assert.equal(findings.signedTitleDedupe.output.length,1);
const unrelated=[S.makeRecord({source:'arxiv',sourceId:'a',title:'Introduction',year:2024,authors:[{name:'Alice Smith'}],itemType:'preprint',doi:'10.9999/preprint'}),S.makeRecord({source:'crossref',sourceId:'b',title:'Introduction',year:1947,authors:[{name:'Bob Brown'}],venue:'Nature',doi:'10.9999/unrelated'})];
S.linkPreprintVersions(unrelated);
findings.unrelatedVersions=unrelated.map(({title,year,publishedAs,preprintOf})=>({title,year,publishedAs,preprintOf}));
assert.equal(unrelated[0].publishedAs.doi,"10.9999/unrelated");
const rec=S.makeRecord({source:'pubmed',sourceId:'1',title:'Example',doi:'10.9999/test'});
await S.enrichFromOpenAlex([rec],{getJSON:async()=>({results:[{doi:'https://doi.org/10.9999/test',cited_by_count:42}]})},{});
findings.citationProvenance={citations:rec.citations,citationSource:rec.citationSource};
assert.equal(rec.citations,42);assert.equal(rec.citationSource,null);
const destinations=[];
await S.checkCitations(S.makeRecord({source:'pubmed',sourceId:'2',doi:'10.9999/probe'}),{getJSON:async value=>{
 const url=new URL(value);destinations.push({host:url.hostname,receivesOpenAlexKey:url.searchParams.has('api_key')});
 return url.hostname.includes('crossref')?{message:{'is-referenced-by-count':2}}:url.hostname.includes('openalex')?{cited_by_count:3}:{citationCount:1};
}},{openAlexApiKey:'DUMMY_TEST_VALUE'});
findings.credentialRouting=destinations;
assert.equal(destinations.find(x=>x.host==='api.crossref.org').receivesOpenAlexKey,true);
const config=JSON.parse(await fs.readFile(new URL('../queries.json',import.meta.url),'utf8'));
const report=JSON.parse(await fs.readFile(new URL('../results/improved-report.json',import.meta.url),'utf8'));
const spec=config.cases.find(x=>x.id==='openalex-thermophile');
const ref=await loadPoPReference(new URL('../'+spec.referencePath,import.meta.url).pathname);
const result=report.cases.find(x=>x.id===spec.id);
const evaluate=records=>evaluateCase(spec,{reference:ref,records,queryHelper:Q,thresholds:config.thresholds,now:new Date(result.capturedAt)});
findings.scorer={};
for(const [id,rows]of Object.entries({reversed:[...result.records].reverse(),nineOnly:result.records.slice(0,9),wrongMetadata:result.records.map(r=>({...r,title:'Unrelated content',authors:[],venue:'Unrelated journal',citations:-1,year:2019}))})){
 const score=evaluate(rows);findings.scorer[id]={status:score.status,topRecall:score.top.recall,fullRecall:score.full.recall};assert.equal(score.status,'pass');
}
findings.scorer.inequalityTitleMatched=compareRecords([{title:'Effects of x < y > z',year:2020}],[{title:'Effects of x z',year:2020}]).matched;
assert.equal(findings.scorer.inequalityTitleMatched,1);
findings.historical={date:report.generatedAt,cases:report.cases.length,records:report.cases.reduce((n,c)=>n+c.records.length,0),judged:report.cases.reduce((n,c)=>n+c.precision.judged,0),topMatches:report.cases.reduce((n,c)=>n+c.top.matches.length,0)};
console.log(JSON.stringify(findings,null,2));
console.log('AUDIT_REPRODUCTIONS_CONFIRMED');

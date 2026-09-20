import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import S from '../content/sources.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const old=path.join(root,'build/search-expansion-20260920'),out=path.join(root,'build/pop-equivalence-20260920');
const reference=JSON.parse((await fs.readFile(path.join(old,'references/crossref-geobacillus-1000.raw.json'),'utf8')).replace(/^\uFEFF/,''));
const prior=JSON.parse(await fs.readFile(path.join(old,'comparison-report.json'),'utf8')).cases.find(c=>c.source==='crossref');
const pages=new Map(),cacheEvidence=[];
const cache=path.join(old,'pop-data/cache/crossref');
for(const file of await fs.readdir(cache))if(file.endsWith('.dat')){
 const bytes=await fs.readFile(path.join(cache,file)),text=bytes.toString();let data;
 try{data=JSON.parse(text.slice(text.indexOf('\r\n\r\n')+4));}catch{continue;}
 if(!data.message?.items||data.message.query?.['search-terms']!=='geobacillus')continue;
 const offset=data.message.query['start-index'];if(offset>=1000)continue;
 pages.set(offset,data);cacheEvidence.push({file,offset,sha256:createHash('sha256').update(bytes).digest('hex')});
}
assert.equal(pages.size,10);
const raw=[...pages].sort((a,b)=>a[0]-b[0]).flatMap(([,d])=>d.message.items);
const doi=r=>String(r.DOI??r.doi??'').toLowerCase();
assert.deepEqual(raw.map(doi),reference.map(doi),'PoP output comes from these exact provider pages');
const before=new Set(prior.records.map(doi)),expected=new Set(reference.map(doi));
const missing=[...expected].filter(id=>!before.has(id));const requests=[];let boundedStop=false;
const http={getJSON:async value=>{const url=new URL(value);assert.equal(url.hostname,'api.crossref.org');assert.equal(url.searchParams.get('query'),'geobacillus');const offset=Number(url.searchParams.get('offset')||0);requests.push(offset);if(!pages.has(offset)){boundedStop=true;return{message:{items:[],'total-results':raw.length}};}return pages.get(offset);}};
const records=await S.search('crossref',prior.query,http,{enrichCitations:false,journalMetrics:false,institutionMetrics:false});
const received=new Set(records.map(doi));assert.deepEqual([...expected].sort(),[...received].sort());assert.ok(missing.every(id=>received.has(id)));
const occurrences=new Map();for(const[i,row]of raw.entries()){const id=doi(row);if(!occurrences.has(id))occurrences.set(id,[]);occurrences.get(id).push({rank:i+1,score:row.score});}
const duplicates=[...occurrences].filter(([,v])=>v.length>1).map(([doi,rows])=>({doi,rows}));
const report={kind:'recorded-provider-response replay, no live request',sourceSHA256:createHash('sha256').update(await fs.readFile(path.join(root,'content/sources.js'))).digest('hex'),referenceRows:reference.length,referenceUnique:expected.size,priorUniqueMatches:[...expected].filter(id=>before.has(id)).length,missing:missing.map(id=>({doi:id,originalRanks:reference.flatMap((r,i)=>doi(r)===id?[i+1]:[]),recovered:true})),replayedUnique:received.size,requests,boundedStop,limitation:'An explicit empty fixture after the tenth captured page bounds replay; it is not evidence the provider is exhausted. Historical candidate HTTP bodies were not retained, so per-miss backend causes cannot be conclusively assigned.',duplicates,duplicateRows:raw.length-expected.size,duplicatesWithChangingScores:duplicates.filter(x=>new Set(x.rows.map(r=>r.score)).size>1).length,cacheEvidence};
await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'diagnosis.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({originalUnique:expected.size,missing:missing.length,recovered:received.size,allMissingRecovered:true,duplicateRows:report.duplicateRows,changingScores:report.duplicatesWithChangingScores}));

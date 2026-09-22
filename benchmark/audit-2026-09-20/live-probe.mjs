import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import S from '../../content/sources.js';
import {createHTTPAdapter} from '../../scripts/benchmark-search.mjs';
const out=new URL('../../build/search-audit-20260920/',import.meta.url);
await fs.mkdir(out,{recursive:true});
const cases=[
 {id:'sheila-combined',source:'multi',query:{authors:'Sheila Ingemann',maxResults:1000,sort:'relevance'}},
 {id:'geobacillus-combined',source:'multi',query:{keywords:'geobacillus',maxResults:1000,sort:'relevance'}},
 {id:'known-title-pubmed',source:'pubmed',query:{title:'CRISPR Cas9 assisted recombineering in Lactobacillus reuteri',maxResults:10,sort:'relevance'}}
];
const report={capturedAt:new Date().toISOString(),candidateVersion:'0.36.6',mode:'public APIs, no API keys, no enrichment; smoke probe, not matched PoP parity',cases:[]};
for (const spec of cases) {
 const requests=[],controller=new AbortController(),started=performance.now();let firstResultMs=null,records=[],partial=[];
 const ctx={signal:controller.signal,enrichCitations:false,journalMetrics:false,institutionMetrics:false,errors:[],onResults(rows){partial=rows;if(rows.length&&firstResultMs===null)firstResultMs=Math.round(performance.now()-started);}};
 const timer=setTimeout(()=>controller.abort(),90000);let error=null;
 try {records=await S.search(spec.source,spec.query,createHTTPAdapter({requests,signal:controller.signal,timeoutMs:20000}),ctx);}catch(e){error={name:e.name,message:e.message};}finally{clearTimeout(timer);}
 const result={...spec,elapsedMs:Math.round(performance.now()-started),firstResultMs,error,providerErrors:ctx.errors,returned:records.length,partial:partial.length,sourceCounts:Object.fromEntries([...new Set(records.flatMap(r=>r.sources||[r.source]))].map(s=>[s,records.filter(r=>(r.sources||[r.source]).includes(s)).length])),earliest:records.filter(r=>r.year).sort((a,b)=>a.year-b.year).slice(0,4).map(({title,year,authors,doi})=>({title,year,authors,doi})),requests,records};
 report.cases.push(result);await fs.writeFile(new URL('live-results.json',out),JSON.stringify(report,null,2));
 console.log(JSON.stringify({...result,records:undefined,requests:requests.map(({url,status,error})=>({host:new URL(url).host,status,error}))}));
}

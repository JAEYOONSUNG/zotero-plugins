import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import S from '../content/sources.js';
import {createHTTPAdapter} from './benchmark-search.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.join(root,'build/search-expansion-20260920');
const specs=[
 {id:'pasted-title-pubmed',source:'pubmed',query:{title:'CRISPR Cas9 assisted recombineering in Lactobacillus reuteri',maxResults:10},expectedDoi:'10.1093/nar/gku623'},
 {id:'title-or-europepmc',source:'europepmc',query:{title:'recombineering OR "genome editing"',maxResults:20}},
 {id:'title-not-pubmed',source:'pubmed',query:{title:'recombineering NOT yeast',maxResults:20}},
 {id:'combined-selected-1000',source:'multi',query:{keywords:'geobacillus',sources:['crossref','europepmc','pubmed'],maxResults:1000},expectedCount:1000},
 {id:'openalex-author-id',source:'openalex',query:{authors:'A5086928770',maxResults:10}}
];
const report={capturedAt:new Date().toISOString(),version:'0.37.0',context:'No API keys; citation/journal/institution enrichment disabled. Smoke/known-target/deep-retrieval evidence, not independent semantic relevance judgments.',revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),files:Object.fromEntries(await Promise.all(['content/sources.js','content/query.js'].map(async f=>[f,createHash('sha256').update(await fs.readFile(path.join(root,f))).digest('hex')]))),cases:[]};
await fs.mkdir(dir,{recursive:true});
for(const spec of specs){
 const controller=new AbortController(),requests=[],started=performance.now();let partial=[],firstResultMs=null,records=[],error=null;
 const ctx={signal:controller.signal,enrichCitations:false,journalMetrics:false,institutionMetrics:false,errors:[],onResults(rows){partial=rows;if(rows.length&&firstResultMs===null)firstResultMs=Math.round(performance.now()-started);}};
 const timer=setTimeout(()=>controller.abort(),150000);
 try{records=await S.search(spec.source,{sort:'relevance',...spec.query},createHTTPAdapter({requests,signal:controller.signal,timeoutMs:25000}),ctx);}catch(e){error={name:e.name,message:e.message};}finally{clearTimeout(timer);}
 const expectedFound=spec.expectedDoi?records.some(r=>r.doi===spec.expectedDoi):null;
 const c={...spec,capturedAt:new Date().toISOString(),status:error||ctx.errors.length?'incomplete':spec.expectedDoi&&!expectedFound||spec.expectedCount&&records.length!==spec.expectedCount?'fail':'pass',count:records.length,partialCount:partial.length,firstResultMs,elapsedMs:Math.round(performance.now()-started),expectedFound,error,warnings:ctx.errors,sourceStatus:ctx.sourceStatus,requests,records};
 report.cases.push(c);await fs.writeFile(path.join(dir,'live-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...c,requests:undefined,records:undefined}));
}

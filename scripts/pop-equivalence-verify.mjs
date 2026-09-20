import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import S from '../content/sources.js';
import Bridge from '../content/pop.js';
import {assessPoPFidelity} from './lib/pop-fidelity.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'build/pop-equivalence-20260920');
const profile=path.join(out,'PoPData');
const exe=path.join(os.homedir(),'Library/Application Support/ZotPoP/tools/pop8query');
const hash=x=>createHash('sha256').update(x).digest('hex');
const specs=[
 {id:'crossref-1000',source:'crossref',flag:'--crossref',query:{keywords:'geobacillus',maxResults:1000,popOutputSort:'rank'}},
 {id:'pubmed-known',source:'pubmed',flag:'--pubmed',query:{title:'CRISPR Cas9 assisted recombineering Lactobacillus reuteri',maxResults:10,popOutputSort:'rank'}},
 {id:'scholar-known',source:'scholar',flag:'--gscholar',query:{title:'CRISPR Cas9 assisted recombineering in Lactobacillus reuteri',maxResults:10,popOutputSort:'rank'}},
 {id:'scholar-author',source:'scholar',flag:'--gscholar',query:{authors:'Sheila Ingemann Jensen',maxResults:30,popOutputSort:'rank'}},
 {id:'crossref-citation-order',source:'crossref',flag:'--crossref',query:{keywords:'geobacillus',maxResults:30,popOutputSort:'-cites'}}
];
await fs.mkdir(out,{recursive:true});
async function fingerprint(dir){const files=[];async function walk(p){let items;try{items=await fs.readdir(p,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}for(const ent of items.sort((a,b)=>a.name.localeCompare(b.name))){const full=path.join(p,ent.name);if(ent.isDirectory())await walk(full);else if(ent.isFile())files.push([path.relative(dir,full),hash(await fs.readFile(full))]);}}await walk(dir);if(!files.length)throw new Error('No cache files available for snapshot attestation');return{sha256:hash(JSON.stringify(files)),files};}
async function reference(spec,query,cachePolicy,snapshotId){
 // Independent CLI invocation; arguments are constructed here without the production builder.
 const args=['--datadir',profile,spec.flag];
 for(const[key,flag]of [['keywords','--keywords'],['title','--title'],['authors','--author'],['venue','--journal']])if(query[key])args.push(flag,query[key]);
 args.push('--max',String(query.maxResults),cachePolicy==='offline'?'--offline':'--direct','--sort',query.popOutputSort,'--format','json','--noerrlog');
 const startedAt=new Date().toISOString(),invocationId=randomUUID();let stdout='',stderr='',timedOut=false;
 const child=spawn(exe,args,{stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},180000);
 const exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);}).finally(()=>clearTimeout(timer));
 await fs.writeFile(path.join(out,`${spec.id}-${cachePolicy}.stdout.json`),stdout);
 await fs.writeFile(path.join(out,`${spec.id}-${cachePolicy}.stderr.log`),stderr);
 if(timedOut||![0,4].includes(exitCode))throw new Error(`Independent PoP ${cachePolicy} invocation failed: ${exitCode}${timedOut?' timeout':''}`);
 const parsed=exitCode===4?[]:JSON.parse(stdout.replace(/^\uFEFF/,''));const rows=Array.isArray(parsed)?parsed:parsed.$results;if(!Array.isArray(rows))throw new Error('Independent PoP returned no JSON rows');
 return{rows,provenance:{engine:'publish-or-perish',source:spec.source,query,outputSort:query.popOutputSort,profileId:profile,capturedAt:cachePolicy==='offline'?null:startedAt,retrievedAt:new Date().toISOString(),exitCode,complete:true,cached:cachePolicy==='offline',cancelled:false,snapshotId,acquisition:{kind:'process',invocationId,command:[exe,...args]}}};
}
const sourceFiles=['content/pop.js','content/sources.js','content/query.js','scripts/lib/pop-fidelity.mjs','scripts/lib/pop-reference.mjs'];
const report={createdAt:new Date().toISOString(),executableSHA256:hash(await fs.readFile(exe)),runnerSHA256:hash(await fs.readFile(fileURLToPath(import.meta.url))),revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceEvidence:Object.fromEntries(await Promise.all(sourceFiles.map(async f=>[f,hash(await fs.readFile(path.join(root,f)))]))),cases:[]};
for(const spec of specs){
 const query={engine:'pop',...spec.query},snapshotId=randomUUID();let candidate=null,caseResult={id:spec.id,source:spec.source,query};
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),180000);
 try{
  const records=await S.search(spec.source,query,{getJSON(){throw new Error('Unexpected direct API fallback');},getText(){throw new Error('Unexpected scraper fallback');}},
   {signal:controller.signal,popSearchSource:async(source,q,ctx)=>{const envelope=await Bridge.searchSource(source,q,{...ctx,popExecutable:exe,popDataDir:profile});envelope.provenance.snapshotId=snapshotId;candidate=envelope;return envelope;}});
  candidate.records=records;await fs.writeFile(path.join(out,`${spec.id}-candidate.json`),JSON.stringify(candidate,null,2));
  const before=await fingerprint(path.join(profile,'cache'));
  const cached=await reference(spec,query,'offline',snapshotId);
  const after=await fingerprint(path.join(profile,'cache'));
  const snapshotEvidence={snapshotId,producerInvocationId:candidate.provenance.acquisition.invocationId,producedAt:candidate.provenance.capturedAt,profileId:profile,source:spec.source,query,cacheSHA256Before:before.sha256,cacheSHA256After:after.sha256};
  const snapshot=assessPoPFidelity(cached,candidate,{evidenceMode:'same-snapshot',snapshotEvidence});
  await fs.writeFile(path.join(out,`${spec.id}-snapshot-reference.json`),JSON.stringify(cached,null,2));
  caseResult={...caseResult,snapshot,cacheFiles:before.files.length,cacheManifest:before.files,candidateRows:candidate.rows.length,referenceRows:cached.rows.length};
  // Also keep independently refreshed runs; a changing provider is never forced equal.
  if(spec.id!=='crossref-1000'){
   try{const fresh=await reference(spec,query,'refresh',null);caseResult.liveLive=assessPoPFidelity(fresh,candidate,{evidenceMode:'live-live'});await fs.writeFile(path.join(out,`${spec.id}-live-reference.json`),JSON.stringify(fresh,null,2));}catch(e){caseResult.liveLiveError=e.message;}
  }
 }catch(e){caseResult.error={name:e.name,message:e.message};}finally{clearTimeout(timer);}
 report.cases.push(caseResult);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({id:spec.id,rows:caseResult.candidateRows,snapshot:caseResult.snapshot?.status,snapshotReasons:caseResult.snapshot?.reasons,liveLive:caseResult.liveLive?.status,liveLiveReasons:caseResult.liveLive?.reasons,error:caseResult.error,liveLiveError:caseResult.liveLiveError}));
}

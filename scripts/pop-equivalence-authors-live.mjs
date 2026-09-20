import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
import A from '../content/authors.js';import Bridge from '../content/pop.js';import {createHTTPAdapter} from './benchmark-search.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),out=path.join(root,'build/pop-equivalence-20260920');
const results=[];
for(const spec of [{provider:'orcid',input:'0000-0001-8277-5907',maxResults:1000},{provider:'scholar',input:'https://scholar.google.com/citations?user=dsdG3ewAAAAJ&hl=en',maxResults:10}]){
 const requests=[],ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),90000);const start=Date.now();let result;
 try{
 const http=createHTTPAdapter({requests,signal:ctrl.signal,timeoutMs:20000});
 const ctx={signal:ctrl.signal,popSearchSource:(source,query,context)=>Bridge.searchSource(source,query,{...context,popExecutable:path.join(os.homedir(),'Library/Application Support/ZotPoP/tools/pop8query')})};
 const profiles=await A.searchProfiles(spec.provider,spec.input,http,ctx);
 if(!profiles.length)throw new Error('No profile returned');
 const records=await A.loadPublications(profiles[0],{maxResults:spec.maxResults,popOutputSort:'rank'},http,ctx);
 result={...spec,status:'success',elapsedMs:Date.now()-start,profile:profiles[0],count:records.length,partial:records.partial||false,citationsKnown:records.filter(r=>r.citations!=null).length,bylinesKnown:records.filter(r=>r.authors?.length).length,provenance:records.authorProvenance,requests,records};
 }catch(e){result={...spec,status:'error',elapsedMs:Date.now()-start,error:{name:e.name,message:e.message},requests};}finally{clearTimeout(timer);}
 results.push(result);await fs.writeFile(path.join(out,'authors-live.json'),JSON.stringify({capturedAt:new Date().toISOString(),sourceSHA256:createHash('sha256').update(await fs.readFile(path.join(root,'content/authors.js'))).digest('hex'),results},null,2));
 console.log(JSON.stringify({...result,records:undefined,requests:requests.map(r=>({url:r.url,status:r.status})),profile:result.profile?{provider:result.profile.provider,id:result.profile.id,name:result.profile.name}:null}));
}

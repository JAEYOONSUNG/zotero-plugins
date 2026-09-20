// Capture fresh PoP reference evidence without changing the user's application data.
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.join(root,'build/search-expansion-20260920');
const exe=path.join(os.homedir(),'Library/Application Support/ZotPoP/tools/pop8query');
const cases=[
 {id:'crossref-geobacillus-1000',source:'crossref',query:{keywords:'geobacillus',maxResults:1000,sort:'relevance'},flags:['--crossref','--keywords','geobacillus'],retrieval:'Crossref relevance, matching PoP native default'},
 {id:'pubmed-known-paper',source:'pubmed',kind:'known-paper',query:{title:'CRISPR Cas9 assisted recombineering Lactobacillus reuteri',maxResults:10,sort:'date'},flags:['--pubmed','--title','CRISPR Cas9 assisted recombineering Lactobacillus reuteri'],expectedDois:['10.1093/nar/gku623'],retrieval:'PubMed native newest retrieval (PoP CLI rank), not output sort=year'},
 {id:'scholar-known-paper',source:'scholar',kind:'known-paper',query:{title:'CRISPR Cas9 assisted recombineering in Lactobacillus reuteri',maxResults:10,sort:'relevance'},flags:['--gscholar','--title','CRISPR Cas9 assisted recombineering in Lactobacillus reuteri'],expectedTitles:['CRISPR–Cas9-assisted recombineering in Lactobacillus reuteri'],retrieval:'Google Scholar native relevance'},
 {id:'scholar-sheila',source:'scholar',kind:'author',query:{authors:'Sheila Ingemann Jensen',maxResults:30,sort:'relevance'},flags:['--gscholar','--author','Sheila Ingemann Jensen'],retrieval:'Google Scholar native relevance'}
];
await fs.mkdir(path.join(dir,'references'),{recursive:true});
const attempts=[];
for(const spec of cases){
 const file=path.join(dir,'references',spec.id+'.raw.json');
 const args=['--datadir',path.join(dir,'pop-data'),...spec.flags,'--max',String(spec.query.maxResults),'--direct','--sort','rank','--format','json','--noerrlog',file];
 const startedAt=new Date().toISOString();let stdout='',stderr='',timedOut=false;
 const child=spawn(exe,args,{stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>{stdout+=b.toString();});child.stderr.on('data',b=>{stderr+=b.toString();});
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},150000);
 const exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);}).finally(()=>clearTimeout(timer));
 let raw=null,sha256=null;try{const buf=await fs.readFile(file);sha256=createHash('sha256').update(buf).digest('hex');raw=JSON.parse(buf.toString().replace(/^\uFEFF/,''));}catch{}
 const completed=exitCode===0&&!timedOut&&(Array.isArray(raw)||Number(raw?.$query?.LastResult)===0);
 const attempt={id:spec.id,source:spec.source,query:spec.query,kind:spec.kind||'topic',expectedDois:spec.expectedDois,expectedTitles:spec.expectedTitles,startedAt,finishedAt:new Date().toISOString(),exitCode,timedOut,completed,count:(Array.isArray(raw)?raw:raw?.$results)?.length||0,command:[exe,...args],sha256,stdout,stderr,retrievalOrder:spec.retrieval};
 attempts.push(attempt);await fs.writeFile(path.join(dir,'capture-attempts.json'),JSON.stringify(attempts,null,2));
 if(raw){await fs.writeFile(path.join(dir,'references',spec.id+'.json'),JSON.stringify({records:Array.isArray(raw)?raw:raw.$results||[],provenance:{tool:'Publish or Perish',source:spec.source,query:spec.query,capturedAt:startedAt,completed,exitCode,originalPath:spec.id+'.raw.json',sha256,command:[exe,...args],retrievalOrder:{sort:spec.query.sort,verifiedBy:spec.retrieval}},errors:completed?[]:[stderr||'Capture incomplete']},null,2));}
 console.log(JSON.stringify({id:spec.id,exitCode,completed,count:attempt.count,timedOut}));
 if(spec.source==='scholar'&&!completed&&/captcha|robot|unusual traffic/i.test(stderr))break;
}

const config={description:'Fresh matched-source PoP comparison; Scholar uses the installed PoP engine. No universal parity claim.',
 coverage:{sources:['crossref','pubmed','scholar'],cases:'One 1000-result Crossref topic query, two known-paper lookups, one Scholar author query.'},
 criteria:{profile:'strict'},thresholds:{referenceTopK:10,candidateTopK:30,minReferenceRecall:1},timeoutMs:180000,requestTimeoutMs:30000,
 cases:cases.map(({id,source,query,kind='topic',expectedDois,expectedTitles})=>({id,source,query,kind,expectedDois,expectedTitles,referencePath:'references/'+id+'.json'}))};
await fs.writeFile(path.join(dir,'comparison-config.json'),JSON.stringify(config,null,2));

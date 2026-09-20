#!/usr/bin/env node
// Actual integrated workbench, captured JCR catalog and memory-only demo services.
// Optional screenshots use an isolated headless Chrome profile, never live Zotero.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import Categories from '../src/jcr-categories.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hash=value=>createHash('sha256').update(value).digest('hex');
const safeJSON=value=>JSON.stringify(value).replace(/</g,'\\u003c');
const script=value=>value.replace(/<\/script/gi,'<\\/script');
const files=['src/workspace.js','src/jcr-categories.js','src/jcr-browser.js','src/workbench.js',
 'content/workbench.css','content/jcr-browser.css','content/icons/style-custom.svg','scripts/design-preview.mjs','scripts/preview-jcr.mjs'];

function argumentsOf(argv){
 const options={view:'groups',size:'1440x1000',query:''};
 for(let i=0;i<argv.length;i++){
  if(argv[i]==='--help'){console.log('node scripts/preview-jcr.mjs --out FILE.html [--catalog FILE.json] [--view groups|expanded|categories|journals] [--group NAME] [--category NAME] [--query TEXT] [--size 1440x1000] [--screenshot FILE.png] [--chrome EXECUTABLE]');return null;}
  const key=argv[i];
  if(!['--out','--catalog','--view','--group','--category','--query','--size','--screenshot','--chrome'].includes(key)||i+1>=argv.length)throw new Error('Invalid argument: '+key);
  options[key.slice(2)]=argv[++i];
 }
 if(!options.out||!['groups','expanded','categories','journals'].includes(options.view))throw new Error('Provide --out and a supported --view');
 const size=/^(\d+)x(\d+)$/.exec(options.size);
 if(!size||size.slice(1).some(value=>Number(value)<320||Number(value)>8000))throw new Error('Size must be WIDTHxHEIGHT, each 320–8000');
 options.width=Number(size[1]);options.height=Number(size[2]);
 options.out=path.resolve(options.out);options.catalog=path.resolve(options.catalog||path.join(ROOT,'data/jcr-categories.json'));
 if(!/\.html?$/i.test(options.out)||options.out===options.catalog)throw new Error('Preview output must be a separate HTML file');
 if(options.screenshot&&!/\.png$/i.test(options.screenshot))throw new Error('Screenshot output must end in .png');
 return options;
}

function integratedDemo(source){
 const start=source.indexOf('async function mountDemo('),end=source.indexOf('\nconst css=',start);
 assert.ok(start>=0&&end>start,'Existing memory-only design harness was not found');
 let demo=source.slice(start,end).trim();
 const replace=(before,after)=>{assert.equal(demo.split(before).length,2,'Changed preview harness anchor: '+before);demo=demo.replace(before,after);};
 replace('async function mountDemo(win,Workbench,Model)','async function mountDemo(win,Workbench,Model,scenario)');
 replace("workbenchUI:{density:'comfortable'}","workbenchUI:{density:'comfortable',welcomed:true,journalBrowser:'jcr',jcrBrowserState:scenario.initialState}");
 replace('let pending={signals:1146,journals:169,authors:109};','let pending={signals:0,journals:0,authors:0};');
 replace('const bench=Workbench.attach',`runtime.jcrCatalog=win.CustomStyleJCRCategories.create(scenario.catalog);
 runtime.jcrBrowser=win.CustomStyleJCRBrowser;
 runtime.Z.launchURL=url=>scenario.recordAction('source-open',{url});
 runtime.Z.ZotPoP={openSearch:(_window,query)=>scenario.recordAction('journal-search',query)};
 runtime.Z.logError=error=>scenario.errors.push(String(error?.stack||error));
 const bench=Workbench.attach`);
 replace("await bench.show('explore');return {bench,runtime};","await bench.show('journals');return {bench,runtime};");
 return demo;
}

async function capture(options){
 const chrome=options.chrome||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 await fsp.access(chrome,fs.constants.X_OK);
 const profile=await fsp.mkdtemp(path.join(os.tmpdir(),'jcr-preview-chrome-'));
 const output=path.resolve(options.screenshot);await fsp.mkdir(path.dirname(output),{recursive:true});
 const args=['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync',
  '--disable-breakpad','--metrics-recording-only','--force-device-scale-factor=1',`--user-data-dir=${profile}`,
  `--window-size=${options.width},${options.height}`,'--remote-debugging-pipe','about:blank'];
 let stderr='',buffer='',nextId=1,exited=false;const pending=new Map();
 const child=spawn(chrome,args,{stdio:['ignore','ignore','pipe','pipe','pipe'],detached:process.platform!=='win32'});
 const stop=signal=>{if(exited)return;try{process.platform==='win32'?child.kill(signal):process.kill(-child.pid,signal);}catch{}};
 const closed=new Promise(resolve=>child.once('close',()=>{exited=true;resolve();}));
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
  const id=nextId++,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Headless command timed out: '+method));},15000);
  pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
  child.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');
 });
 child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-32000);});
 child.stdio[4].setEncoding('utf8');child.stdio[4].on('data',chunk=>{
  buffer+=chunk;let end;
  while((end=buffer.indexOf('\0'))>=0){const text=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!text)continue;
   const message=JSON.parse(text),task=pending.get(message.id);if(!task)continue;pending.delete(message.id);
   message.error?task.reject(new Error(message.error.message)):task.resolve(message.result);
  }
 });
 const failed=error=>{for(const task of pending.values())task.reject(error);pending.clear();};
 child.on('error',failed);child.on('close',()=>failed(new Error('Headless Chrome closed')));
 child.stdio[3].on('error',failed);child.stdio[4].on('error',failed);
 try{
  const browser=await send('Browser.getVersion');
  const {targetId}=await send('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  await send('Page.enable',{},sessionId);
  await send('Emulation.setDeviceMetricsOverride',{width:options.width,height:options.height,deviceScaleFactor:1,mobile:false},sessionId);
  await send('Page.navigate',{url:pathToFileURL(options.out).href},sessionId);
  let result;const deadline=Date.now()+30000;
  while(Date.now()<deadline){
   const evaluated=await send('Runtime.evaluate',{expression:"document.getElementById('jcr-preview-result')?.textContent || null",returnByValue:true},sessionId);
   if(evaluated.result?.value){result=JSON.parse(evaluated.result.value);break;}
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!result)throw new Error('Integrated preview did not report its browser state');
  result.browser={product:browser.product,protocolVersion:browser.protocolVersion};
  const screenshot=await send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false},sessionId);
  await fsp.writeFile(output,Buffer.from(screenshot.data,'base64'));
  if(result.tables.some(table=>table.scrollWidth>table.clientWidth+1)){
   const offset=await send('Runtime.evaluate',{expression:"(()=>{const table=document.querySelector('.sc-jcr-table-wrap');table.scrollLeft=table.scrollWidth;return table.scrollLeft;})()",returnByValue:true},sessionId);
   const right=await send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false},sessionId);
   result.horizontalScrollScreenshot={path:output.replace(/\.png$/i,'.right.png'),scrollLeft:offset.result.value};
   await fsp.writeFile(result.horizontalScrollScreenshot.path,Buffer.from(right.data,'base64'));
   await send('Runtime.evaluate',{expression:"document.querySelector('.sc-jcr-table-wrap').scrollLeft=0"},sessionId);
  }
  const probe=await send('Runtime.evaluate',{expression:`(()=>{const before=location.href,root=document.querySelector('.sc-jcr-browser');
   const source=root?.querySelector('button[data-opens="external"]'),journal=root?.querySelector('button[data-opens="window"]');
   source?.click();journal?.click();return {samePage:before===location.href,sourceButton:!!source,journalButton:!!journal,actions:window.__JCR_PREVIEW__.actions};})()`,returnByValue:true},sessionId);
  result.actionProbe=probe.result.value;
  await fsp.writeFile(output.replace(/\.png$/i,'.layout.json'),JSON.stringify(result,null,2)+'\n');
  await fsp.writeFile(output.replace(/\.png$/i,'.chrome.log'),stderr);
  assert.equal(result.ready,true);assert.deepEqual(result.errors,[]);
  assert.equal(result.nativeJCRMounts,1);assert.equal(result.workbenchMode,'jcr');
  assert.equal(result.paperSelection.hidden,true);assert.equal(result.paperSelection.display,'none');
  assert.equal(result.paperSelection.disabledActions,3);
  assert.equal(result.externalResourceRequests.length,0);
  assert.equal(result.actionProbe.samePage,true);
  if(result.actionProbe.sourceButton)assert.ok(result.actionProbe.actions.some(action=>action.type==='source-open'));
  if(result.actionProbe.journalButton)assert.ok(result.actionProbe.actions.some(action=>action.type==='journal-search'));
  await fsp.access(output);
  return {...result,screenshot:output};
 }finally{
  await fsp.writeFile(output.replace(/\.png$/i,'.chrome.log'),stderr);
  if(!exited)await Promise.race([send('Browser.close').catch(()=>{}),new Promise(resolve=>setTimeout(resolve,1000))]);
  await Promise.race([closed,new Promise(resolve=>setTimeout(resolve,2000))]);
  if(!exited){stop('SIGKILL');await closed;}
  await fsp.rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 }
}

export async function main(argv=process.argv.slice(2)){
 const options=argumentsOf(argv);if(!options)return;
 const catalogBytes=await fsp.readFile(options.catalog),payload=JSON.parse(catalogBytes),catalog=Categories.create(payload);
 const sources=Object.fromEntries(await Promise.all(files.map(async file=>[file,await fsp.readFile(path.join(ROOT,file),'utf8')])));
 const initialState={view:options.view==='expanded'?'groups':options.view,query:options.query,
  sortKey:options.view==='journals'?'jif':options.view==='categories'?'journalCount':'name',
  sortDir:['journals','categories'].includes(options.view)?'desc':'asc',page:0,pageSize:25};
 if(options.view==='expanded'){
  const key=options.group||'Agricultural Sciences';if(!catalog.group(key))throw new Error('Unknown captured group: '+key);initialState.expandedGroupKeys=[key];
 }
 if(options.view==='journals'){
  const key=options.category||'MULTIDISCIPLINARY SCIENCES';if(!catalog.category(key))throw new Error('Unknown captured category: '+key);initialState.categoryKey=key;
 }
 const metadata={createdAt:new Date().toISOString(),kind:'isolated-integrated-workbench-preview',view:options.view,initialState,size:{width:options.width,height:options.height},
  catalog:{path:options.catalog,sha256:hash(catalogBytes),source:catalog.source,groups:catalog.groups.length,categories:catalog.categories.length,journals:catalog.journals.length},
  sourceSHA256:Object.fromEntries(Object.entries(sources).map(([file,value])=>[file,hash(value)])),limitation:'Memory-only fictional library; actual integrated workbench/model/component and captured JCR data. Headless Chrome rendering is not loaded Zotero runtime evidence.'};
 const icon='data:image/svg+xml;base64,'+Buffer.from(sources['content/icons/style-custom.svg']).toString('base64');
 const demo=integratedDemo(sources['scripts/design-preview.mjs']);
 const bootstrap=`(async()=>{
 const errors=[],actions=[],resources=JSON.parse(document.getElementById('jcr-preview-resources').textContent),configuration=JSON.parse(document.getElementById('jcr-preview-config').textContent);
 window.addEventListener('error',event=>{if(event.error)errors.push(String(event.error.stack||event.error));});
 window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason?.stack||event.reason)));
 const create=document.createElementNS.bind(document);
 document.createElementNS=function(namespace,tag){const element=create(namespace,tag),set=element.setAttribute.bind(element);
  element.setAttribute=function(key,value){if(tag==='link'&&key==='href'&&resources.css[value])value='data:text/css,'+encodeURIComponent(resources.css[value]);if(tag==='img'&&key==='src'&&String(value).startsWith('content/icons/'))value=resources.icon;set(key,value);};return element;};
 const recordAction=(type,data)=>{actions.push({type,data});document.getElementById('demo-feedback').textContent='Preview action: '+type+' (no external operation)';};
 let mounted;
 try{mounted=await (${demo})(window,CustomStyleWorkbench,CustomStyleWorkspace,{catalog:configuration.catalog,initialState:configuration.initialState,errors,recordAction});}
 catch(error){errors.push(String(error.stack||error));}
 finally{document.createElementNS=create;}
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 const rect=element=>{if(!element)return null;const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,clientHeight:element.clientHeight,scrollHeight:element.scrollHeight};};
 const root=document.querySelector('.sc-jcr-browser'),footer=document.querySelector('.sc-selection-bar'),result={ready:!!root,errors,actions,view:configuration.view,workbenchMode:mounted?.bench.state.journalBrowser,nativeJCRMounts:document.querySelectorAll('.sc-jcr-browser').length,
  groups:document.querySelectorAll('.sc-jcr-group').length,categories:document.querySelectorAll('tr[data-category-key]').length,journals:document.querySelectorAll('tr[data-journal-key]').length,
  sourceStamp:document.querySelector('.sc-jcr-source')?.textContent,coverage:[...document.querySelectorAll('.sc-jcr-coverage')].map(n=>n.textContent),
  viewport:{width:innerWidth,height:innerHeight},panel:rect(mounted?.bench.panel),body:rect(document.querySelector('.sc-body')),jcr:rect(root),
  paperSelection:{hidden:footer?.hidden,display:footer?getComputedStyle(footer).display:null,disabledActions:footer?.querySelectorAll('button:disabled').length,retainedIDs:[...mounted.bench.state.selected]},
  tables:[...document.querySelectorAll('.sc-jcr-table-wrap')].map(rect),groupRows:[...document.querySelectorAll('.sc-jcr-group-toggle')].map(rect),
  journalRows:[...document.querySelectorAll('tr[data-journal-key]')].slice(0,5).map(rect),
  journalValues:[...document.querySelectorAll('tr[data-journal-key]')].slice(0,5).map(row=>({key:row.dataset.journalKey,cells:Object.fromEntries([...row.querySelectorAll('td[data-column]')].map(cell=>[cell.dataset.column,cell.textContent]))})),
  journalButtons:[...document.querySelectorAll('tr[data-journal-key] button')].slice(0,5).map(node=>({...rect(node),text:node.textContent,whiteSpace:getComputedStyle(node).whiteSpace})),
  issnCells:[...document.querySelectorAll('tr[data-journal-key] td[data-column="issns"]')].slice(0,5).map(node=>({...rect(node),whiteSpace:getComputedStyle(node).whiteSpace})),
  externalResourceRequests:performance.getEntriesByType('resource').map(r=>r.name).filter(url=>!url.startsWith('data:'))};
 window.__JCR_PREVIEW__={...result,bench:mounted?.bench,runtime:mounted?.runtime};
 const output=document.createElement('script');output.id='jcr-preview-result';output.type='application/json';output.textContent=JSON.stringify(result);document.body.appendChild(output);document.documentElement.dataset.previewReady='true';
 })();`;
 const config={catalog:payload,initialState,view:options.view};
 const resources={icon,css:{'content/workbench.css':sources['content/workbench.css'],'content/jcr-browser.css':sources['content/jcr-browser.css']}};
 const inline=['src/workspace.js','src/jcr-categories.js','src/jcr-browser.js','src/workbench.js'].map(file=>`<script>${script(sources[file])}</script>`).join('\n');
 const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' data:; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'"><meta id="demo-icon" content="${icon}"><title>JCR · Integrated workbench preview</title><style>body{margin:0;background:#e5e7eb;color:#374151;font:12px system-ui}.demo-bar{padding:12px 18px}.demo-feedback{position:fixed;bottom:3px;left:18px;font-size:11px}@media(max-width:700px){.demo-bar{display:none}}${sources['content/workbench.css']}\n${sources['content/jcr-browser.css']}</style></head><body><div class="demo-bar">Integrated workbench preview · Captured JCR data · Fictional library · No live app connection</div><div id="demo-feedback" class="demo-feedback">Offline preview · No live Zotero connection.</div><script id="jcr-preview-config" type="application/json">${safeJSON(config)}</script><script id="jcr-preview-resources" type="application/json">${safeJSON(resources)}</script>${inline}<script>${script(bootstrap)}</script></body></html>`;
 assert.ok(!html.includes('<script src='));
 await fsp.mkdir(path.dirname(options.out),{recursive:true});
 for(const [file,value]of Object.entries(sources))assert.equal(await fsp.readFile(path.join(ROOT,file),'utf8'),value,'Source changed while building preview: '+file);
 assert.equal(hash(await fsp.readFile(options.catalog)),metadata.catalog.sha256,'Catalog changed while building preview');
 await fsp.writeFile(options.out,html);await fsp.writeFile(options.out.replace(/\.html?$/i,'.preview.json'),JSON.stringify(metadata,null,2)+'\n');
 const result=options.screenshot?await capture(options):null;
 const summary={path:options.catalog,sha256:metadata.catalog.sha256,groups:catalog.groups.length,categories:catalog.categories.length,journals:catalog.journals.length,complete:catalog.source.complete};
 console.log(JSON.stringify({html:options.out,catalog:summary,view:options.view,...(result?{screenshot:result.screenshot,viewport:result.viewport,rendered:{groups:result.groups,categories:result.categories,journals:result.journals},layout:{panel:result.panel,jcr:result.jcr}}:{})}));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});

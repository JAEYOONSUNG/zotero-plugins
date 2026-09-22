import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// build.py writes the openly licensed build beside the source it came from, so a
// checkout that has not been built yet still finds the file under its own name.
const shipped=name=>{const open=path.join(root,'data',name.replace(/\.json$/,'.open.json'));
 return fs.existsSync(open)?open:path.join(root,'data',name);};
async function boot({failJCR=false,invalidJCR=false,licensed=null}={}){
 const prefs=new Map(),columns=new Map(),observers=new Map(),registered=new Set(),writes=[],errors=[],debug=[],loaded=[],attached=[],started=[],timers=[];let next=1;
 const Z={initializationPromise:Promise.resolve(),DataDirectory:{dir:'/isolated/data'},Libraries:{userLibraryID:1,get:()=>({editable:true})},Reader:{_readers:[]},getMainWindows:()=>[{testWindow:true}],getMainWindow:()=>null,debug:value=>debug.push(value),logError:e=>errors.push(e),
  Prefs:{get:k=>prefs.get(k),set:(k,v)=>prefs.set(k,v),registerObserver:(k,fn)=>{const id=next++;observers.set(id,{k,fn});return id;},unregisterObserver:id=>observers.delete(id)},
  ItemTreeManager:{registerColumn:c=>{assert.equal(typeof c.width,'string');const id=c.pluginID+'-'+c.dataKey;columns.set(id,c);return id;},unregisterColumn:id=>columns.delete(id)},
  PreferencePanes:{register:async()=> 'pane',unregister(){}},Notifier:{registerObserver:()=> 'item-observer',unregisterObserver(){}},
  HTTP:{request:async(method,url)=>{assert.equal(method,'GET');const name=url.split('/').at(-1);assert.ok(['if-catalog.json','journal-registry.json','journal-catalog.json','manifest.json'].includes(name));
   if(name==='manifest.json')return {response:JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'))};
   if(name==='journal-catalog.json'&&failJCR)throw new Error('packaged catalog unavailable');
   if(name==='journal-catalog.json'&&invalidJCR)return {response:{schemaVersion:1,source:{provider:'OpenAlex'}}};
   return {response:JSON.parse(fs.readFileSync(shipped(name),'utf8'))};}}
 };
 // The archive carries the openly licensed build of each table; a reader's own
 // licensed copy, when they have placed one, is read from the data directory.
 const local=new Map(Object.entries(licensed||{}).map(([name,value])=>['/isolated/data/style-custom-journals/'+name,JSON.stringify(value)]));
 const context=vm.createContext({Zotero:Z,console,URL,PathUtils:{join:(...p)=>p.join('/')},
  IOUtils:{exists:async p=>local.has(p),stat:async p=>({size:local.get(p).length}),readUTF8:async p=>local.get(p),writeUTF8:async(...args)=>writes.push(args)},pref:(k,v)=>prefs.set(k,v),setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout(){}});
 context.Services={scriptloader:{loadSubScript:(url,scope)=>{assert.equal(scope,vm.runInContext('globalThis',context));const name=url.split('/').at(-1);loaded.push(name);vm.runInContext(fs.readFileSync(path.join(root,'src',name),'utf8'),context,{filename:name});
  if(name==='runtime.js'){
   const prototype=vm.runInContext('CustomStyleRuntime.prototype',context),start=prototype.start;
   prototype.start=function(...args){started.push({catalog:this.jcrCatalog,browser:this.jcrBrowser});return start.apply(this,args);};
   prototype.addWindow=function(window){attached.push({window,catalog:this.jcrCatalog,browser:this.jcrBrowser});};
  }
 }},obs:{addObserver:o=>registered.add(o),removeObserver:o=>registered.delete(o)}};
 vm.runInContext(fs.readFileSync(path.join(root,'prefs.js'),'utf8'),context);vm.runInContext(fs.readFileSync(path.join(root,'bootstrap.js'),'utf8'),context);
 await vm.runInContext("startup({id:'style-custom@sungjaeyoon.dev',version:'0.8.0',rootURI:'file:///plugin/'})",context);
 return {Z,context,columns,observers,registered,writes,errors,debug,loaded,attached,started,timers};
}
test('Gecko-like bootstrap loads the openly licensed catalog before startup or window attachment without UI',async()=>{
 const {Z,context,columns,observers,registered,writes,errors,loaded,attached,started}=await boot();
 assert.equal(columns.size,26);assert.equal(Z.StyleCustom.Workbench.TABS.length,19);assert.equal(typeof Z.StyleCustom.readerTools.setVerticalTabs,'function');assert.equal(typeof Z.StyleCustom.libraryService.graph,'function');assert.equal(registered.size,1);assert.equal(writes.length,0);
 // What ships is what may be passed on. Nothing licensed travels in the archive.
 const packaged=JSON.parse(fs.readFileSync(shipped('journal-catalog.json'),'utf8'));
 assert.equal(Z.StyleCustom.jcrCatalog.groups.length,packaged.groups.length);
 assert.equal(Z.StyleCustom.jcrCatalog.categories.length,packaged.categories.length);
 assert.equal(Z.StyleCustom.jcrCatalog.source.provider,'OpenAlex');
 assert.match(String(Z.StyleCustom.jcrCatalog.source.license||Z.StyleCustom.jcrCatalog.source.licence||''),/CC0/i);
 assert.doesNotMatch(JSON.stringify(Z.StyleCustom.jcrCatalog.source),/clarivate/i);
 assert.equal(Z.StyleCustom.journalLayers['jcr-categories.json'],'shipped');
 assert.ok(loaded.indexOf('jcr-categories.js')<loaded.indexOf('workbench.js'));assert.ok(loaded.indexOf('jcr-browser.js')<loaded.indexOf('workbench.js'));
 assert.equal(started[0].catalog,Z.StyleCustom.jcrCatalog);assert.equal(attached[0].catalog,Z.StyleCustom.jcrCatalog);assert.equal(typeof attached[0].browser.mount,'function');
 await vm.runInContext('shutdown()',context);assert.equal(columns.size,0);assert.equal(observers.size,0);assert.equal(registered.size,0);assert.equal(Z.StyleCustom,undefined);assert.equal(errors.length,0);
});

test("a reader's own licensed catalog wins over the one in the archive",async()=>{
 // The whole point of the split: a subscriber puts their Journal Citation Reports
 // export in the Zotero data directory and sees their own figures, while the
 // archive that reached them carries none.
 // Every value here is invented; only the shape is the real one.
 const licensed={'jcr-categories.json':{schemaVersion:1,
  source:{provider:'Clarivate',product:'JCR',url:'https://jcr.clarivate.com/jcr/browse-categories',capturedAt:'2026-09-20T05:47:13.287Z',complete:{groups:true,categories:true,journals:true}},
  groups:[{key:'G',name:'G',categoryCount:1,journalCount:1,citableItems:1,categoryKeys:['C']}],
  categories:[{key:'C',name:'C',groupKeys:['G'],editions:['SCIE'],journalCount:1,citableItems:1,totalCitations:1,medianJIF:1.5}],
  journals:[{key:'j1',title:'Journal of Invented Results',abbreviation:'J INVENT RES',issns:['0000-0019'],keyKind:'local-issn-and-exact-title',categoryKeys:['C'],editions:['SCIE'],jif:1.5,jifDisplay:'1.5',year:2026}]}};
 const {Z,context,errors}=await boot({licensed});
 assert.equal(Z.StyleCustom.jcrCatalog.source.provider,'Clarivate');
 assert.equal(Z.StyleCustom.jcrCatalog.journals.length,1);
 assert.equal(Z.StyleCustom.journalLayers['jcr-categories.json'],'local');
 await vm.runInContext('shutdown()',context);assert.equal(errors.length,0);
});

test('missing or invalid catalog data stays unavailable without substituting the journal registry',async()=>{
 for(const options of [{failJCR:true},{invalidJCR:true}]){
  const {Z,context,columns,errors,debug}=await boot(options);
  assert.equal(Z.StyleCustom.jcrCatalog,null);assert.ok(Z.StyleCustom.jcrCatalogError);assert.equal(columns.size,26);
  assert.ok(debug.some(message=>message.includes('journal category catalog not loaded')));
  assert.ok(vm.runInContext('CustomStyleJournalIdentity.registryRanked().length',context)>0,'the registry is still loaded');
  await vm.runInContext('shutdown()',context);assert.equal(errors.length,0);
 }
});

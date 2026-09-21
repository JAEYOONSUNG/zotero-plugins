import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function boot({failJCR=false,invalidJCR=false}={}){
 const prefs=new Map(),columns=new Map(),observers=new Map(),registered=new Set(),writes=[],errors=[],debug=[],loaded=[],attached=[],started=[],timers=[];let next=1;
 const Z={initializationPromise:Promise.resolve(),DataDirectory:{dir:'/isolated/data'},Libraries:{userLibraryID:1,get:()=>({editable:true})},Reader:{_readers:[]},getMainWindows:()=>[{testWindow:true}],getMainWindow:()=>null,debug:value=>debug.push(value),logError:e=>errors.push(e),
  Prefs:{get:k=>prefs.get(k),set:(k,v)=>prefs.set(k,v),registerObserver:(k,fn)=>{const id=next++;observers.set(id,{k,fn});return id;},unregisterObserver:id=>observers.delete(id)},
  ItemTreeManager:{registerColumn:c=>{assert.equal(typeof c.width,'string');const id=c.pluginID+'-'+c.dataKey;columns.set(id,c);return id;},unregisterColumn:id=>columns.delete(id)},
  PreferencePanes:{register:async()=> 'pane',unregister(){}},Notifier:{registerObserver:()=> 'item-observer',unregisterObserver(){}},
  HTTP:{request:async(method,url)=>{assert.equal(method,'GET');const name=url.split('/').at(-1);assert.ok(['if-catalog.json','journal-registry.json','jcr-categories.json','manifest.json'].includes(name));
   if(name==='manifest.json')return {response:JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'))};
   if(name==='jcr-categories.json'&&failJCR)throw new Error('packaged JCR data unavailable');
   return {response:name==='jcr-categories.json'&&invalidJCR?{schemaVersion:1,source:{provider:'OpenAlex'}}:JSON.parse(fs.readFileSync(path.join(root,'data',name),'utf8'))};}}
 };
 const context=vm.createContext({Zotero:Z,console,URL,PathUtils:{join:(...p)=>p.join('/')},IOUtils:{exists:async()=>false,writeUTF8:async(...args)=>writes.push(args)},pref:(k,v)=>prefs.set(k,v),setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout(){}});
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
test('Gecko-like bootstrap loads official JCR model and catalog before startup or window attachment without UI',async()=>{
 const {Z,context,columns,observers,registered,writes,errors,loaded,attached,started}=await boot();
 assert.equal(columns.size,26);assert.equal(Z.StyleCustom.Workbench.TABS.length,19);assert.equal(typeof Z.StyleCustom.readerTools.setVerticalTabs,'function');assert.equal(typeof Z.StyleCustom.libraryService.graph,'function');assert.equal(registered.size,1);assert.equal(writes.length,0);
 assert.equal(Z.StyleCustom.jcrCatalog.groups.length,21);assert.equal(Z.StyleCustom.jcrCatalog.categories.length,254);
 assert.equal(Z.StyleCustom.jcrCatalog.source.provider,'Clarivate');assert.equal(Z.StyleCustom.jcrCatalog.source.url,'https://jcr.clarivate.com/jcr/browse-categories');
 assert.ok(loaded.indexOf('jcr-categories.js')<loaded.indexOf('workbench.js'));assert.ok(loaded.indexOf('jcr-browser.js')<loaded.indexOf('workbench.js'));
 assert.equal(started[0].catalog,Z.StyleCustom.jcrCatalog);assert.equal(attached[0].catalog,Z.StyleCustom.jcrCatalog);assert.equal(typeof attached[0].browser.mount,'function');
 await vm.runInContext('shutdown()',context);assert.equal(columns.size,0);assert.equal(observers.size,0);assert.equal(registered.size,0);assert.equal(Z.StyleCustom,undefined);assert.equal(errors.length,0);
});

test('missing or invalid official data stays unavailable without substituting the OpenAlex registry',async()=>{
 for(const options of [{failJCR:true},{invalidJCR:true}]){
  const {Z,context,columns,errors,debug}=await boot(options);
  assert.equal(Z.StyleCustom.jcrCatalog,null);assert.ok(Z.StyleCustom.jcrCatalogError);assert.equal(columns.size,26);
  assert.ok(debug.some(message=>message.includes('official JCR catalog not loaded')));
  assert.equal(vm.runInContext('CustomStyleJournalIdentity.registryRanked().length',context),22594);
  await vm.runInContext('shutdown()',context);assert.equal(errors.length,0);
 }
});

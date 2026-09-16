import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('Gecko-like bootstrap loads every module without Node globals and keeps user UI untouched',async()=>{
 const prefs=new Map(),columns=new Map(),observers=new Map(),registered=new Set(),writes=[],errors=[];let next=1;
 const Z={initializationPromise:Promise.resolve(),DataDirectory:{dir:'/isolated/data'},Libraries:{userLibraryID:1,get:()=>({editable:true})},Reader:{_readers:[]},getMainWindows:()=>[],getMainWindow:()=>null,debug(){},logError:e=>errors.push(e),
  Prefs:{get:k=>prefs.get(k),set:(k,v)=>prefs.set(k,v),registerObserver:(k,fn)=>{const id=next++;observers.set(id,{k,fn});return id;},unregisterObserver:id=>observers.delete(id)},
  ItemTreeManager:{registerColumn:c=>{assert.equal(typeof c.width,'string');const id=c.pluginID+'-'+c.dataKey;columns.set(id,c);return id;},unregisterColumn:id=>columns.delete(id)},
  PreferencePanes:{register:async()=> 'pane',unregister(){}},Notifier:{registerObserver:()=> 'item-observer',unregisterObserver(){}},
  HTTP:{request:async(method,url)=>{assert.equal(method,'GET');assert.ok(url.endsWith('/data/if-catalog.json'));return {response:JSON.parse(fs.readFileSync(path.join(root,'data/if-catalog.json'),'utf8'))};}}
 };
 const context=vm.createContext({Zotero:Z,console,PathUtils:{join:(...p)=>p.join('/')},IOUtils:{exists:async()=>false,writeUTF8:async(...args)=>writes.push(args)},pref:(k,v)=>prefs.set(k,v)});
 context.Services={scriptloader:{loadSubScript:(url,scope)=>{assert.equal(scope,vm.runInContext('globalThis',context));const name=url.split('/').at(-1);vm.runInContext(fs.readFileSync(path.join(root,'src',name),'utf8'),context,{filename:name});}},obs:{addObserver:o=>registered.add(o),removeObserver:o=>registered.delete(o)}};
 vm.runInContext(fs.readFileSync(path.join(root,'prefs.js'),'utf8'),context);vm.runInContext(fs.readFileSync(path.join(root,'bootstrap.js'),'utf8'),context);
 await vm.runInContext("startup({id:'style-custom@sungjaeyoon.dev',version:'0.8.0',rootURI:'file:///plugin/'})",context);
 assert.equal(columns.size,20);assert.equal(Z.StyleCustom.Workbench.TABS.length,17);assert.equal(typeof Z.StyleCustom.readerTools.setVerticalTabs,'function');assert.equal(typeof Z.StyleCustom.libraryService.graph,'function');assert.equal(registered.size,1);assert.equal(writes.length,0);
 await vm.runInContext('shutdown()',context);assert.equal(columns.size,0);assert.equal(observers.size,0);assert.equal(registered.size,0);assert.equal(Z.StyleCustom,undefined);assert.equal(errors.length,0);
});

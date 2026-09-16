import test from 'node:test';
import assert from 'node:assert/strict';
import tools from '../src/reader-tools.js';
class Style {
 constructor(){this.values=new Map();}
 getPropertyValue(k){return this.values.get(k)?.value||'';}
 getPropertyPriority(k){return this.values.get(k)?.priority||'';}
 setProperty(k,value,priority=''){this.values.set(k,{value,priority});}
 removeProperty(k){this.values.delete(k);}
}
class Node {
 constructor(tag='div'){this.tagName=tag;this.children=[];this.style=new Style();this.dataset={};this.attrs={};this.events=new Map();this.isConnected=true;}
 setAttribute(k,v){this.attrs[k]=String(v);}getAttribute(k){return this.attrs[k]??null;}
 appendChild(node){node.parent=this;this.children.push(node);return node;}
 replaceChildren(...nodes){for(const child of [...this.children])child.remove();for(const node of nodes)this.appendChild(node);}
 remove(){this.parent?.children.splice(this.parent.children.indexOf(this),1);this.isConnected=false;}
 addEventListener(k,fn){if(!this.events.has(k))this.events.set(k,new Set());this.events.get(k).add(fn);}
 removeEventListener(k,fn){this.events.get(k)?.delete(fn);}
 emit(k){for(const fn of this.events.get(k)||[])fn({stopPropagation(){}});}
}
function fixture(){
 const win=new Node('window'),timers=new Map();let next=0;
 win.setInterval=fn=>{timers.set(++next,fn);return next;};win.clearInterval=id=>timers.delete(id);
 const doc=new Node('document');doc.documentElement=new Node('html');doc.body=doc.documentElement;doc.createElement=tag=>new Node(tag);doc.createElementNS=(ns,tag)=>new Node(tag);doc.querySelectorAll=()=>pages;win.document=doc;
 const page=new Node();page.setAttribute('data-page-number','1');const pages=[page];
 const core={_state:{colorScheme:null,lightTheme:{id:'snow'},darkTheme:{id:'black'},customThemes:[{id:'user-theme',foreground:'#123456',background:'#ffffff'}],annotations:[{id:'ANN',text:'<img src=x onerror=oops>',comment:'Important',color:'#ffd400',position:{pageIndex:0},pageLabel:'i'}],primaryViewStats:{pageIndex:4,pagesCount:10}},_primaryView:{_iframeWindow:{document:doc}},
 toggleSidebar(v){this._state.sidebarOpen=v;},setColorScheme(v){this._state.colorScheme=v;},setCustomThemes(v){this._state.customThemes=v;},setLightTheme(v){this._state.lightTheme=v?{id:v}:null;},setDarkTheme(v){this._state.darkTheme=v?{id:v}:null;}};
 const navigations=[],reader={type:'pdf',itemID:11,_window:win,_iframeWindow:{},_internalReader:core,navigate:async location=>navigations.push(location)};
 const items=new Map([[11,{id:11,key:'PDF',libraryID:1,isAttachment:()=>true}]]),opened=[],errors=[];
 win.Zotero_Tabs={selectedID:'reader1',_tabs:[{id:'library',type:'library',title:'Library'},{id:'reader1',type:'reader',title:'Paper',data:{itemID:11}}],select(id){this.selectedID=id;},close(ids){ids=Array.isArray(ids)?ids:[ids];this._tabs=this._tabs.filter(t=>!ids.includes(t.id));},move(id,index){const old=this._tabs.findIndex(t=>t.id===id);if(index>old)index--;const tab=this._tabs.splice(old,1)[0];this._tabs.splice(index,0,tab);},getTabIDByItemID(id){return this._tabs.find(t=>t.data?.itemID===id)?.id;}};
 const calls=[];
 const columns={_columns:[{dataKey:'title',hidden:false,width:300,ordinal:0,sortDirection:1},{dataKey:'year',hidden:false,width:80,ordinal:1},{dataKey:'custom',hidden:true,width:120,ordinal:2}],
 setOrder(i,to){calls.push(['order',i,to]);const c=this._columns[i];c.ordinal=to;this._columns.sort((a,b)=>a.ordinal===b.ordinal?(a===c?-1:1):a.ordinal-b.ordinal);this._columns.forEach((c,i)=>c.ordinal=i);},
 toggleHidden(i){calls.push(['hidden',i]);this._columns[i].hidden=!this._columns[i].hidden;},onResize(widths,persist){calls.push(['resize',widths,persist]);for(const c of this._columns)if(widths[c.dataKey])c.width=widths[c.dataKey];},
 toggleSort(i){calls.push(['sort',i]);this._columns.forEach((c,j)=>{if(i!==j)delete c.sortDirection;else c.sortDirection=c.sortDirection?-c.sortDirection:1;});}};
 win.ZoteroPane={itemsView:{tree:{_columns:columns},async refreshAndMaintainSelection(){calls.push(['refresh']);}}};
 const runtime={cache:{},dirty:false,writes:0,async flush(){this.writes++;}};
 const Z={Notifier:{listeners:new Map(),registerObserver(ref){const id=this.listeners.size+1;this.listeners.set(id,ref);return id;},unregisterObserver(id){this.listeners.delete(id);}},getMainWindow:()=>win,Items:{get:id=>items.get(id),getByLibraryAndKeyAsync:async(lib,key)=>[...items.values()].find(i=>i.libraryID===lib&&i.key===key)},Reader:{_registeredListeners:[],registerEventListener(type,handler,pluginID){this._registeredListeners.push({type,handler,pluginID});},_unregisterEventListenerByPluginID(id){this._registeredListeners=this._registeredListeners.filter(l=>l.pluginID!==id);},_readers:[reader],getByTabID:id=>id==='reader1'?reader:null,async open(id,location,options){opened.push({id,location,options});win.Zotero_Tabs._tabs.push({id:'new'+id,type:'reader',title:'New',data:{itemID:id}});}},logError:e=>errors.push(e)};
 return {win,core,reader,page,pages,doc,timers,items,opened,navigations,calls,columns,runtime,Z,errors,service:tools.create({Zotero:Z,runtime}),tick(){for(const fn of timers.values())fn();}};
}
test('themes use native theme IDs, retain custom themes, and restore both slots on cleanup',async()=>{
 const f=fixture();const original=JSON.parse(JSON.stringify(f.core._state));const cleanup=f.service.attach(f.win);
 assert.equal(f.core._state.colorScheme,null);
 await f.service.applyTheme(f.win,'dark');assert.equal(f.core._state.darkTheme.id,'dark');
 await f.service.applyTheme(f.win,'sepia');assert.equal(f.core._state.lightTheme.id,'sepia');
 await f.service.applyTheme(f.win,{background:'#EEDDBB',foreground:'#223344'});
 assert.equal(f.core._state.lightTheme.id,'style-custom-palette');assert.equal(f.core._state.customThemes.length,2);
 assert.equal(f.runtime.cache.readerSettings.theme.background,'#eeddbb');
 cleanup();cleanup();assert.equal(f.core._state.colorScheme,original.colorScheme);assert.deepEqual(f.core._state.lightTheme,original.lightTheme);assert.deepEqual(f.core._state.darkTheme,original.darkTheme);assert.equal(f.core._state.customThemes.length,1);assert.equal(f.timers.size,0);
});
test('theme validation rejects injected CSS before mutation and cleanup respects subsequent native changes',async()=>{
 const f=fixture();await assert.rejects(f.service.applyTheme(f.win,{background:'url(evil)',foreground:'#222222'}));assert.equal(f.runtime.writes,0);
 await f.service.applyTheme(f.win,'sepia');f.core._state.lightTheme={id:'user-theme'};f.core._state.colorScheme='dark';
 f.service.stop();assert.equal(f.core._state.lightTheme.id,'user-theme');assert.equal(f.core._state.colorScheme,'dark');
});
test('saved themes apply when readers finish opening and closed readers release tracked state',async()=>{
 const f=fixture();f.Z.Reader._readers=[];await f.service.applyTheme(f.win,'dark');f.Z.Reader._readers=[f.reader];f.tick();assert.equal(f.core._state.darkTheme.id,'dark');f.Z.Reader._readers=[];f.tick();assert.equal(f.core._state.darkTheme.id,'black');f.service.stop();
});
test('margin cards are opt-in, safe text, labelled colors, page anchored and clickable; refresh and teardown work',async()=>{
 const f=fixture();f.service.attach(f.win);assert.equal(f.page.children.length,0);
 await f.service.setMarginAnnotations(f.win,true);const aside=f.page.children[0],button=aside.children[0];
 assert.match(button.textContent,/Yellow · i/);assert.match(button.textContent,/<img/);assert.equal(button.innerHTML,undefined);
 button.emit('click');await Promise.resolve();assert.deepEqual(f.navigations,[{annotationID:'ANN'}]);
 await f.service.setColorLabel('#ffd400','Hypothesis');assert.match(f.page.children[0].children[0].textContent,/Hypothesis/);
 f.core._state.annotations=[];f.tick();assert.equal(f.page.children.length,0);
 f.core._state.annotations=[{id:'SECOND',position:{pageIndex:0},comment:'Second'}];f.tick();assert.equal(f.page.children.length,1);
 await f.service.setMarginAnnotations(f.win,false);assert.equal(f.page.children.length,0);f.service.stop();
});
test('virtualized page replacement removes stale cards and mounts replacement page',async()=>{
 const f=fixture();await f.service.setMarginAnnotations(f.win,true);const old=f.page;old.isConnected=false;
 const replacement=new Node();replacement.setAttribute('data-page-number','1');f.pages.splice(0,1,replacement);f.tick();assert.equal(old.children.length,0);assert.equal(replacement.children.length,1);f.win.emit('unload');assert.equal(replacement.children.length,0);assert.equal(f.timers.size,0);
});
test('tabs list and selection use real IDs, protect library tab, and reject stale IDs',()=>{
 const f=fixture();assert.deepEqual(f.service.tabs(f.win).map(t=>t.selected),[false,true]);f.service.selectTab(f.win,'library');assert.equal(f.win.Zotero_Tabs.selectedID,'library');assert.throws(()=>f.service.closeTab(f.win,'library'));assert.throws(()=>f.service.selectTab(f.win,'missing'));f.service.closeTab(f.win,'reader1');assert.equal(f.service.tabs(f.win).length,1);
});
test('tab groups persist stable library+key identities and restore locations without duplicate tabs',async()=>{
 const f=fixture();const group=await f.service.saveTabGroup(f.win,' Session ');assert.equal(group.name,'Session');assert.equal(group.tabs[0].key,'PDF');assert.equal(group.tabs[0].pageIndex,4);
 await f.service.restoreTabGroup(f.win,group.id);assert.equal(f.opened.length,0);assert.deepEqual(f.navigations,[{pageIndex:4}]);
 f.win.Zotero_Tabs._tabs=f.win.Zotero_Tabs._tabs.slice(0,1);
 const restored=await f.service.restoreTabGroup(f.win,group.id);assert.deepEqual(restored,{opened:1,missing:0});assert.equal(f.opened[0].options.openInBackground,true);assert.equal(f.win.Zotero_Tabs.selectedID,'new11');
 f.items.clear();assert.deepEqual(await f.service.restoreTabGroup(f.win,group.id),{opened:0,missing:1});
 await f.service.deleteTabGroup(group.id);assert.deepEqual(f.service.tabGroups(),[]);
});
test('saved group list snapshots cannot mutate durable records',async()=>{
 const f=fixture();const group=await f.service.saveTabGroup(f.win,'Session');group.tabs[0].key='bad';const snapshot=f.service.tabGroups();snapshot[0].name='bad';assert.equal(f.runtime.cache.tabGroups[0].name,'Session');assert.equal(f.runtime.cache.tabGroups[0].tabs[0].key,'PDF');
});
test('view groups restore order, widths, hidden flags and sort through native APIs',async()=>{
 const f=fixture();const group=await f.service.saveView(f.win,'Default');
 f.columns.setOrder(2,0);f.columns._columns.find(c=>c.dataKey==='title').hidden=true;f.columns._columns.find(c=>c.dataKey==='year').width=200;f.columns.toggleSort(0);
 await f.service.applyView(f.win,group.id);assert.deepEqual(f.columns._columns.map(c=>c.dataKey),['title','year','custom']);assert.equal(f.columns._columns[0].hidden,false);assert.equal(f.columns._columns[1].width,80);assert.equal(f.columns._columns[0].sortDirection,1);assert.ok(f.calls.some(c=>c[0]==='resize'&&c[2]===true));assert.equal(f.calls.at(-1)[0],'refresh');
 await f.service.deleteView(group.id);assert.deepEqual(f.service.viewGroups(),[]);
});
test('layout validation occurs before mutation; missing plugin columns are ignored and new columns retained',async()=>{
 const f=fixture();const group=await f.service.saveView(f.win,'View');f.runtime.cache.viewGroups[0].columns[0].width='100px; evil';const before=f.calls.length;await assert.rejects(f.service.applyView(f.win,group.id),/Invalid/);assert.equal(f.calls.length,before);
 f.runtime.cache.viewGroups[0].columns[0].width=300;f.columns._columns.pop();f.columns._columns.push({dataKey:'new-plugin',ordinal:2,hidden:false,width:150});await f.service.applyView(f.win,group.id);assert.ok(f.columns._columns.some(c=>c.dataKey==='new-plugin'));
});
test('stop is idempotent and rejects future mutations, including tab restore awaiting an item',async()=>{
 const f=fixture();const group=await f.service.saveTabGroup(f.win,'Stop');let release;
 f.Z.Items.getByLibraryAndKeyAsync=()=>new Promise(resolve=>release=resolve);const work=f.service.restoreTabGroup(f.win,group.id);f.service.stop();release(f.items.get(11));await assert.rejects(work,/stopped/);assert.equal(f.opened.length,0);f.service.stop();await assert.rejects(f.service.saveView(f.win,'No'),/stopped/);
});
test('native page overflow clipping is reversibly opened for margin cards',async()=>{
 const f=fixture();f.page.style.setProperty('overflow','hidden','important');await f.service.setMarginAnnotations(f.win,true);assert.equal(f.page.style.getPropertyValue('overflow'),'visible');
 await f.service.setColorLabel('#ffd400','Check');assert.equal(f.page.style.getPropertyValue('overflow'),'visible');
 await f.service.setMarginAnnotations(f.win,false);assert.equal(f.page.style.getPropertyValue('overflow'),'hidden');assert.equal(f.page.style.getPropertyPriority('overflow'),'important');f.service.stop();
});
test('invalid saved tab group is rejected before any document opens',async()=>{
 const f=fixture();const group=await f.service.saveTabGroup(f.win,'Bad');f.runtime.cache.tabGroups[0].tabs.push({libraryID:1,key:'OTHER',pageIndex:-2});await assert.rejects(f.service.restoreTabGroup(f.win,group.id),/Invalid/);assert.equal(f.opened.length,0);assert.equal(f.navigations.length,0);
});
test('sidebar visibility persists, affects newly opened readers and restores on cleanup',async()=>{
 const f=fixture();f.core._state.sidebarOpen=true;await f.service.setSidebar(f.win,false);assert.equal(f.core._state.sidebarOpen,false);assert.equal(f.runtime.cache.readerSettings.sidebarVisible,false);
 await f.service.setSidebar(f.win,true);assert.equal(f.core._state.sidebarOpen,true);f.service.stop();assert.equal(f.core._state.sidebarOpen,true);
});
test('vertical rail works independently of workbench and selects/closes tabs with cleanup',async()=>{
 const f=fixture();await f.service.setVerticalTabs(f.win,true);assert.equal(f.runtime.cache.readerSettings.verticalTabs,true);
 let rail=f.doc.documentElement.children.find(n=>n.className==='style-custom-vertical-tabs');assert.ok(rail);const libraryRow=rail.children[2];libraryRow.children[0].emit('click');assert.equal(f.win.Zotero_Tabs.selectedID,'library');
 rail=f.doc.documentElement.children.find(n=>n.className==='style-custom-vertical-tabs');const readerRow=rail.children[3];readerRow.children[1].emit('click');assert.equal(f.service.tabs(f.win).length,1);
 await f.service.setVerticalTabs(f.win,false);assert.ok(!f.doc.documentElement.children.some(n=>n.className==='style-custom-vertical-tabs'));f.service.stop();
});
test('margin cards also mount in secondary split PDF view and clear when split closes',async()=>{
 const f=fixture();const page=new Node();page.setAttribute('data-page-number','1');const doc={createElement:tag=>new Node(tag),querySelectorAll:()=>[page]};f.core._secondaryView={_iframeWindow:{document:doc}};
 await f.service.setMarginAnnotations(f.win,true);assert.equal(f.page.children.length,1);assert.equal(page.children.length,1);page.children[0].children[0].emit('click');await Promise.resolve();assert.deepEqual(f.navigations,[{annotationID:'ANN'}]);
 delete f.core._secondaryView;f.tick();assert.equal(page.children.length,0);assert.equal(page.style.getPropertyValue('overflow'),'');f.service.stop();
});
test('native toolbar hook provides standalone controls and removes only our registration',async()=>{
 const f=fixture();let openedWith;f.runtime.openWorkbench=win=>{openedWith=win;};const other={type:'renderToolbar',handler(){},pluginID:'other-plugin'};f.Z.Reader._registeredListeners.push(other);
 const listener=f.Z.Reader._registeredListeners.find(l=>l!==other),appended=[];
 listener.handler({reader:f.reader,doc:f.doc,append:node=>appended.push(node)});assert.equal(appended.length,1);const button=appended[0].children[0];button.emit('click');const menu=f.doc.documentElement.children.find(n=>n.attrs['aria-label']==='Reader appearance and workspace');assert.equal(menu.hidden,false);
 const open=menu.children.find(n=>n.textContent==='Open research workspace');open.emit('click');await Promise.resolve();await Promise.resolve();assert.equal(openedWith,f.win);
 const sidebar=menu.children.find(n=>n.textContent==='Toggle reader sidebar');sidebar.emit('click');await Promise.resolve();await Promise.resolve();assert.equal(f.core._state.sidebarOpen,true);
 f.service.stop();assert.deepEqual(f.Z.Reader._registeredListeners,[other]);assert.equal(menu.isConnected,false);assert.equal(appended[0].isConnected,false);
});
test('toolbar events after per-window teardown do not reattach cleaned window',()=>{
 const f=fixture();const cleanup=f.service.attach(f.win),listener=f.Z.Reader._registeredListeners[0];cleanup();let appended=0;listener.handler({reader:f.reader,doc:f.doc,append:()=>appended++});assert.equal(appended,0);assert.equal(f.timers.size,0);f.service.stop();
});
test('standalone vertical rail delegates native tab actions to main-window tabs',async()=>{
 const f=fixture();const standalone=new Node('window');standalone.document=f.doc;standalone.setInterval=f.win.setInterval;standalone.clearInterval=f.win.clearInterval;
 await f.service.setVerticalTabs(standalone,true);assert.equal(f.service.tabs(standalone).length,2);f.service.selectTab(standalone,'library');assert.equal(f.win.Zotero_Tabs.selectedID,'library');f.service.stop();
});
test('annotation palette save/apply/delete persists typed entries and preserves themes and other labels',async()=>{
 const f=fixture();f.core.setTool=function(params){this._state.tool={...this._state.tool,...params};};f.core._state.tool={type:'underline',color:'#ffd400'};
 f.runtime.cache.readerSettings={theme:'sepia',colorLabels:{'#aaaaaa':'Existing label'}};
 const first=await f.service.saveAnnotationPalette('Research',[{color:'#FF0000',label:'Evidence'},{color:'#00ff00',label:'Question'}]);
 const second=await f.service.saveAnnotationPalette('Other',[{color:'#0000ff',label:'Model'}]);assert.equal(first.entries[0].color,'#ff0000');first.entries[0].label='mutated';assert.equal(f.service.annotationPalettes()[0].entries[0].label,'Evidence');
 assert.deepEqual(await f.service.applyAnnotationPalette(f.win,first.id),{id:first.id,applied:1});assert.deepEqual(f.core._state.tool,{type:'underline',color:'#ff0000'});assert.equal(f.runtime.cache.readerSettings.theme,'sepia');assert.equal(f.runtime.cache.readerSettings.colorLabels['#aaaaaa'],'Existing label');assert.equal(f.runtime.cache.readerSettings.colorLabels['#ff0000'],'Evidence');
 await f.service.deleteAnnotationPalette(first.id);assert.equal(f.runtime.cache.readerSettings.annotationPaletteID,undefined);assert.equal(f.service.annotationPalettes()[0].id,second.id);assert.equal(f.runtime.cache.readerSettings.colorLabels['#ff0000'],'Evidence');f.service.stop();
});
test('invalid palettes are rejected atomically, including duplicate colors and injected CSS',async()=>{
 const f=fixture();for(const entries of [[],[{color:'url(evil)',label:'X'}],[{color:'#ffffff',label:''}],[{color:'#FFFFFF',label:'A'},{color:'#ffffff',label:'B'}]])await assert.rejects(f.service.saveAnnotationPalette('Bad',entries));assert.equal(f.runtime.writes,0);assert.deepEqual(f.service.annotationPalettes(),[]);f.service.stop();
});
test('explicit color selection uses native tool with highlight fallback and refuses readonly readers',async()=>{
 const f=fixture();const calls=[];f.core.setTool=params=>calls.push(params);f.core._state.tool={type:'pointer'};assert.equal(f.service.setAnnotationColor(f.win,'#123456'),'#123456');assert.deepEqual(calls,[{type:'highlight',color:'#123456'}]);
 f.core._state.readOnly=true;assert.throws(()=>f.service.setAnnotationColor(f.win,'#112233'),/read-only/);assert.equal(calls.length,1);
 f.core._state.readOnly=false;f.win.Zotero_Tabs.selectedID='library';assert.throws(()=>f.service.setAnnotationColor(f.win,'#112233'),/Select/);f.service.stop();
});
test('palette selection without active reader persists choice without silently modifying background tools',async()=>{
 const f=fixture();f.core.setTool=()=>assert.fail('background tool changed');f.win.Zotero_Tabs.selectedID='library';const group=await f.service.saveAnnotationPalette('One',[{color:'#111111',label:'Notes'}]);assert.deepEqual(await f.service.applyAnnotationPalette(f.win,group.id),{id:group.id,applied:0});assert.equal(f.runtime.cache.readerSettings.annotationPaletteID,group.id);f.service.stop();
});
test('toolbar exposes selected palette color buttons that set native annotation color and default reset',async()=>{
 const f=fixture();const calls=[];f.core.setTool=params=>calls.push(params);f.core._state.tool={type:'ink'};const group=await f.service.saveAnnotationPalette('Palette',[{color:'#102030',label:'Evidence'}]);await f.service.applyAnnotationPalette(f.win,group.id);
 const listener=f.Z.Reader._registeredListeners[0];listener.handler({reader:f.reader,doc:f.doc,append:()=>{}});const menu=f.doc.documentElement.children.find(n=>n.attrs['aria-label']==='Reader appearance and workspace');const colors=menu.children.find(n=>n.attrs['aria-label']==='Annotation colors');assert.equal(colors.children[0].textContent,'Evidence');colors.children[0].emit('click');assert.deepEqual(calls.at(-1),{type:'ink',color:'#102030'});
 await f.service.applyAnnotationPalette(f.win,null);assert.equal(f.runtime.cache.readerSettings.annotationPaletteID,undefined);assert.deepEqual(calls.at(-1),{type:'ink',color:'#ffd400'});f.service.stop();
});
test('restoring an unloaded tab forwards the saved page through native select options',async()=>{
 const f=fixture();const group=await f.service.saveTabGroup(f.win,'Unloaded');
 f.win.Zotero_Tabs._tabs[1].type='reader-unloaded';f.Z.Reader.getByTabID=()=>null;f.win.Zotero_Tabs.selectedID='library';
 const selections=[];f.win.Zotero_Tabs.select=(id,reopening,options)=>{selections.push({id,reopening,options});f.win.Zotero_Tabs.selectedID=id;};
 await f.service.restoreTabGroup(f.win,group.id);
 assert.ok(selections.some(s=>s.id==='reader1'&&s.options?.location?.pageIndex===4));
 assert.equal(f.opened.length,0);f.service.stop();
});
test('closing target window during group item resolution prevents late document opens',async()=>{
 const f=fixture();const group=await f.service.saveTabGroup(f.win,'Closing');f.win.Zotero_Tabs._tabs=f.win.Zotero_Tabs._tabs.slice(0,1);
 let release;f.Z.Items.getByLibraryAndKeyAsync=()=>new Promise(resolve=>release=resolve);
 const work=f.service.restoreTabGroup(f.win,group.id);f.win.closed=true;release(f.items.get(11));
 await assert.rejects(work,/closed/);assert.equal(f.opened.length,0);f.service.stop();
});
test('closing window during first native open stops later group documents and final selection',async()=>{
 const f=fixture();const group=await f.service.saveTabGroup(f.win,'Multiple');f.runtime.cache.tabGroups[0].tabs.push({libraryID:1,key:'PDF2',selected:true});f.items.set(12,{id:12,key:'PDF2',libraryID:1,isAttachment:()=>true});f.win.Zotero_Tabs._tabs=f.win.Zotero_Tabs._tabs.slice(0,1);
 let release;const opens=[];f.Z.Reader.open=id=>{opens.push(id);return new Promise(resolve=>release=resolve);};
 const work=f.service.restoreTabGroup(f.win,group.id);await Promise.resolve();f.win.closed=true;release();await assert.rejects(work,/closed/);assert.deepEqual(opens,[11]);f.service.stop();
});
test('R05 tab reorder uses final positions and close-others protects the library and non-reader tabs',()=>{
 const f=fixture();f.win.Zotero_Tabs._tabs.push({id:'reader2',type:'reader-unloaded',title:'Second',data:{itemID:12}},{id:'reader3',type:'reader',title:'Third',data:{itemID:13}},{id:'note',type:'note',title:'Note',data:{itemID:14}});
 f.service.moveTab(f.win,'reader1',3);assert.deepEqual(f.service.tabs(f.win).map(t=>t.id),['library','reader2','reader3','reader1','note']);
 f.service.moveTab(f.win,'reader1',1);assert.equal(f.service.tabs(f.win)[1].id,'reader1');
 assert.throws(()=>f.service.moveTab(f.win,'library',1));assert.throws(()=>f.service.moveTab(f.win,'reader1',0));assert.throws(()=>f.service.closeOtherTabs(f.win,'gone'));
 assert.deepEqual(f.service.closeOtherTabs(f.win,'reader1'),{closed:2});assert.deepEqual(f.service.tabs(f.win).map(t=>t.id),['library','reader1','note']);f.service.stop();
});
test('R06 saved tab groups rename and update current order/pages without changing identity or unrelated groups',async()=>{
 const f=fixture();const group=await f.service.saveTabGroup(f.win,'Original'),other=await f.service.saveTabGroup(f.win,'Other');
 const renamed=await f.service.renameTabGroup(group.id,' Review ');assert.equal(renamed.id,group.id);assert.equal(renamed.name,'Review');assert.equal(renamed.tabs[0].pageIndex,4);
 f.core._state.primaryViewStats.pageIndex=9;const updated=await f.service.updateTabGroup(f.win,group.id);assert.equal(updated.name,'Review');assert.equal(updated.tabs[0].pageIndex,9);assert.equal(f.service.tabGroups().find(g=>g.id===other.id).tabs[0].pageIndex,4);
 const before=JSON.stringify(f.runtime.cache.tabGroups);await assert.rejects(f.service.renameTabGroup(group.id,''));await assert.rejects(f.service.updateTabGroup(f.win,'missing'));assert.equal(JSON.stringify(f.runtime.cache.tabGroups),before);
 f.win.Zotero_Tabs._tabs=f.win.Zotero_Tabs._tabs.slice(0,1);await assert.rejects(f.service.updateTabGroup(f.win,group.id));assert.equal(JSON.stringify(f.runtime.cache.tabGroups),before);f.service.stop();
});
test('R07 saved views rename and update layout in place and reject stale or unavailable targets',async()=>{
 const f=fixture();const group=await f.service.saveView(f.win,'Initial'),other=await f.service.saveView(f.win,'Other');await f.service.renameView(group.id,'Review');f.columns._columns[0].width=420;f.columns._columns[2].hidden=false;
 const updated=await f.service.updateView(f.win,group.id);assert.equal(updated.id,group.id);assert.equal(updated.name,'Review');assert.equal(updated.columns[0].width,420);assert.equal(updated.columns[2].hidden,false);assert.equal(f.service.viewGroups().find(v=>v.id===other.id).columns[0].width,300);
 f.columns._columns[0].width=100;await f.service.applyView(f.win,group.id);assert.equal(f.columns._columns[0].width,420);
 const before=JSON.stringify(f.runtime.cache.viewGroups);await assert.rejects(f.service.renameView('deleted','New'));await assert.rejects(f.service.renameView(group.id,' '));f.win.closed=true;await assert.rejects(f.service.updateView(f.win,group.id),/closed/);assert.equal(JSON.stringify(f.runtime.cache.viewGroups),before);f.service.stop();
});
test('R08 margin width side and text limit change actual cards with typed validation',async()=>{
 const f=fixture();f.core._state.annotations[0].text='q'.repeat(500);f.core._state.annotations[0].comment='comment';await f.service.setMarginAnnotations(f.win,true);
 assert.deepEqual(await f.service.setMarginOptions(f.win,{width:320,side:'left',textLimit:100}),{width:320,side:'left',textLimit:100});
 const aside=f.page.children[0];assert.match(aside.style.cssText,/right:calc\(100% \+ 10px\)/);assert.match(aside.style.cssText,/width:320px/);assert.equal(aside.children[0].textContent.split('\n').slice(1).join('\n').length,100);
 const before=JSON.stringify(f.runtime.cache.readerSettings);await assert.rejects(f.service.setMarginOptions(f.win,{side:'right;background:url(evil)'}));await assert.rejects(f.service.setMarginOptions(f.win,{width:999}));assert.equal(JSON.stringify(f.runtime.cache.readerSettings),before);f.service.stop();
});
test('R08 appearance reset restores original native settings while retaining palettes and display preferences',async()=>{
 const f=fixture();const original=JSON.parse(JSON.stringify(f.core._state));const group=await f.service.saveAnnotationPalette('Keep',[{color:'#123456',label:'Evidence'}]);
 await f.service.applyTheme(f.win,'sepia');await f.service.setSidebar(f.win,true);await f.service.setVerticalTabs(f.win,true);await f.service.setMarginAnnotations(f.win,true);await f.service.setMarginOptions(f.win,{width:300});
 await f.service.resetAppearance(f.win);assert.equal(f.core._state.colorScheme,original.colorScheme);assert.deepEqual(f.core._state.lightTheme,original.lightTheme);assert.equal(f.core._state.sidebarOpen,false);assert.equal(f.page.children.length,0);assert.ok(!f.doc.documentElement.children.some(n=>n.className==='style-custom-vertical-tabs'));assert.equal(f.runtime.cache.readerSettings.theme,undefined);assert.equal(f.runtime.cache.readerSettings.sidebarVisible,undefined);assert.equal(f.service.annotationPalettes()[0].id,group.id);assert.equal(f.service.marginOptions().width,300);
 f.tick();assert.deepEqual(f.core._state.lightTheme,original.lightTheme);f.service.stop();
});
test('R14 native annotation header resolves library-scoped identity and opens exact referring notes',async()=>{
 const f=fixture();f.items.set(21,{id:21,key:'ANN',libraryID:1,parentID:11,isAnnotation:()=>true});const queried=[],opened=[];f.runtime.libraryService={backlinks:async id=>{queried.push(id);return [{id:'31',title:'Exact note',kind:'note'}];},openItem:async id=>opened.push(id)};
 const hook=f.Z.Reader._registeredListeners.find(l=>l.type==='renderSidebarAnnotationHeader');let node;hook.handler({reader:f.reader,doc:f.doc,params:{annotation:{id:'ANN'}},append:n=>node=n});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(queried,[21]);assert.equal(node.children[0].textContent,'1 notes');
 node.children[0].emit('click');const menu=f.doc.documentElement.children.find(n=>n.attrs['aria-label']==='Annotation backlinks');assert.equal(menu.hidden,false);menu.children[0].emit('click');await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(opened,['31']);f.service.stop();assert.equal(menu.isConnected,false);
});
test('R14 stale annotation headers and wrong PDF identities never publish late backlinks',async()=>{
 const f=fixture();f.items.set(21,{id:21,key:'ANN',libraryID:1,parentID:11,isAnnotation:()=>true});let release;f.runtime.libraryService={backlinks:()=>new Promise(resolve=>release=resolve)};const hook=f.Z.Reader._registeredListeners.find(l=>l.type==='renderSidebarAnnotationHeader');let node;
 hook.handler({reader:f.reader,doc:f.doc,params:{annotation:{id:'ANN'}},append:n=>node=n});await new Promise(resolve=>setImmediate(resolve));f.service.stop();release([{id:'31',title:'Late',kind:'note'}]);await new Promise(resolve=>setImmediate(resolve));assert.equal(node.children[0].textContent,'Notes');assert.equal(node.isConnected,false);
 const g=fixture();g.items.set(21,{id:21,key:'ANN',libraryID:1,parentID:999,isAnnotation:()=>true});g.runtime.libraryService={backlinks:()=>assert.fail('wrong PDF queried')};g.Z.Reader._registeredListeners.find(l=>l.type==='renderSidebarAnnotationHeader').handler({reader:g.reader,doc:g.doc,params:{annotation:{id:'ANN'}},append(){}});await new Promise(resolve=>setImmediate(resolve));assert.match(g.errors[0].message,/identity/);g.service.stop();
});
test('R15 native merge resolves selected keys and delegates guarded transactional mutation',async()=>{
 const f=fixture();f.items.set(21,{id:21,key:'ANN',libraryID:1,parentID:11,isAnnotation:()=>true});f.items.set(22,{id:22,key:'ANN2',libraryID:1,parentID:11,isAnnotation:()=>true});f.core._state.selectedAnnotationIDs=['ANN','ANN2'];
 const calls=[];f.runtime.libraryService={mergeAnnotations:async(ids,options)=>{calls.push(ids);assert.equal(options.isCurrent(),true);return '21';}};
 assert.equal(await f.service.mergeSelectedAnnotations(f.win),'21');assert.deepEqual(calls,[[21,22]]);
 const menu=[];f.Z.Reader._registeredListeners.find(l=>l.type==='createAnnotationContextMenu').handler({reader:f.reader,params:{ids:['ANN','ANN2']},append:value=>menu.push(value)});assert.equal(menu[0].disabled,false);await menu[0].onCommand();assert.equal(calls.length,2);f.service.stop();
});
test('R15 merge rejects readonly wrong-PDF and stale reader selections before mutation',async()=>{
 const f=fixture();f.runtime.libraryService={mergeAnnotations:()=>assert.fail('unsafe merge')};f.core._state.readOnly=true;await assert.rejects(f.service.mergeSelectedAnnotations(f.win,['ANN','ANN2']),/read-only/);f.core._state.readOnly=false;
 f.items.set(21,{id:21,key:'ANN',libraryID:1,parentID:999,isAnnotation:()=>true});await assert.rejects(f.service.mergeSelectedAnnotations(f.win,['ANN','ANN2']),/another PDF/);
 let release;f.Z.Items.getByLibraryAndKeyAsync=()=>new Promise(resolve=>release=resolve);const work=f.service.mergeSelectedAnnotations(f.win,['ANN','ANN2']);f.win.Zotero_Tabs.selectedID='library';release({id:21,key:'ANN',libraryID:1,parentID:11,isAnnotation:()=>true});await assert.rejects(work,/changed or closed/);f.service.stop();
});
test('R16 attachment versions include only same-parent same-library locally readable PDFs and switch explicitly',async()=>{
 const f=fixture();const parent={id:1,key:'PAPER',libraryID:1,getAttachments:()=>[11,12,13,14,15]};f.items.set(1,parent);
 for(const[id,parentID,libraryID,pdf,exists]of [[11,1,1,true,true],[12,1,1,true,true],[13,999,1,true,true],[14,1,2,true,true],[15,1,1,true,false]])f.items.set(id,{id,key:'FILE'+id,parentID,libraryID,isPDFAttachment:()=>pdf,fileExists:async()=>exists,getDisplayTitle:()=>id===11?'Preprint':'Published version'});
 const versions=await f.service.attachmentVersions(f.win);assert.deepEqual(versions.map(v=>v.id),[11,12]);assert.equal(versions[0].selected,true);assert.equal(f.opened.length,0);
 assert.equal(await f.service.switchAttachmentVersion(f.win,12),12);assert.equal(f.opened[0].id,12);assert.equal(f.service.tabs(f.win).some(t=>t.id==='reader1'),true);await assert.rejects(f.service.switchAttachmentVersion(f.win,13),/same paper/);f.service.stop();
});
test('R16 stale reader during file check prevents version switching and original tab is retained on open failure',async()=>{
 const f=fixture();f.items.set(1,{id:1,libraryID:1,getAttachments:()=>[11,12]});Object.assign(f.items.get(11),{parentID:1,isPDFAttachment:()=>true,fileExists:async()=>true});let release;f.items.set(12,{id:12,parentID:1,libraryID:1,isPDFAttachment:()=>true,fileExists:()=>new Promise(resolve=>release=resolve)});
 const work=f.service.switchAttachmentVersion(f.win,12);await new Promise(resolve=>setImmediate(resolve));f.win.Zotero_Tabs.selectedID='library';release(true);await assert.rejects(work,/changed or closed/);assert.equal(f.opened.length,0);
 f.win.Zotero_Tabs.selectedID='reader1';f.items.get(12).fileExists=async()=>true;f.Z.Reader.open=async()=>{throw new Error('Reader failed to open');};await assert.rejects(f.service.switchAttachmentVersion(f.win,12),/failed to open/);assert.ok(f.service.tabs(f.win).some(t=>t.id==='reader1'));f.service.stop();
});
test('R16 native toolbar version listing exposes working user-triggered PDF choices',async()=>{
 const f=fixture();f.items.set(1,{id:1,libraryID:1,getAttachments:()=>[11,12]});Object.assign(f.items.get(11),{parentID:1,isPDFAttachment:()=>true,fileExists:async()=>true,getDisplayTitle:()=> 'Original PDF'});f.items.set(12,{id:12,parentID:1,libraryID:1,isPDFAttachment:()=>true,fileExists:async()=>true,getDisplayTitle:()=> 'Revised PDF'});
 f.Z.Reader._registeredListeners.find(l=>l.type==='renderToolbar').handler({reader:f.reader,doc:f.doc,append(){}});const menu=f.doc.documentElement.children.find(n=>n.attrs['aria-label']==='Reader appearance and workspace');menu.children.find(n=>n.textContent==='Show attachment versions').emit('click');await new Promise(resolve=>setImmediate(resolve));const versions=menu.children.find(n=>n.attrs['aria-label']==='Attachment versions');assert.equal(versions.children.length,2);assert.match(versions.children[0].textContent,/Original PDF/);versions.children[1].emit('click');await new Promise(resolve=>setImmediate(resolve));assert.equal(f.opened[0].id,12);f.service.stop();
});
test('R14 repeated headers share pending and completed lookups and distinct scans are serialized',async()=>{
 const f=fixture();for(const[id,key]of [[21,'ANN'],[22,'ANN2']])f.items.set(id,{id,key,libraryID:1,parentID:11,isAnnotation:()=>true});let release;const queried=[];f.runtime.libraryService={backlinks:id=>{queried.push(id);return new Promise(resolve=>release=resolve);}};
 const hook=f.Z.Reader._registeredListeners.find(l=>l.type==='renderSidebarAnnotationHeader'),render=key=>hook.handler({reader:f.reader,doc:f.doc,params:{annotation:{id:key}},append(){}});
 render('ANN');await new Promise(resolve=>setImmediate(resolve));render('ANN');render('ANN2');await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(queried,[21]);release([]);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(queried,[21,22]);release([]);await new Promise(resolve=>setImmediate(resolve));render('ANN');await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(queried,[21,22]);f.service.stop();
});
test('R14 note modifications invalidate cached counts on next poll without reacting to unrelated paper updates',async()=>{
 const f=fixture();f.items.set(21,{id:21,key:'ANN',libraryID:1,parentID:11,isAnnotation:()=>true});f.items.set(31,{id:31,isNote:()=>true});let notes=[],queries=0;f.runtime.libraryService={backlinks:async()=>{queries++;return notes;}};
 let node;f.Z.Reader._registeredListeners.find(l=>l.type==='renderSidebarAnnotationHeader').handler({reader:f.reader,doc:f.doc,params:{annotation:{id:'ANN'}},append:n=>node=n});await new Promise(resolve=>setImmediate(resolve));assert.equal(node.children[0].textContent,'0 notes');const observer=[...f.Z.Notifier.listeners.values()][0];observer.notify('modify','item',[11]);f.tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(queries,1);
 notes=[{id:'31',title:'New note',kind:'note'}];observer.notify('modify','item',[31]);f.tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(queries,2);assert.equal(node.children[0].textContent,'1 notes');f.service.stop();assert.equal(f.Z.Notifier.listeners.size,0);
});
test('R15 reader validation and native menu enforce the same fifty-annotation limit as library merge',async()=>{
 const f=fixture(),keys=Array.from({length:51},(_,i)=>'ANN'+i);f.Z.Items.getByLibraryAndKeyAsync=()=>assert.fail('Oversized merge must not resolve items');await assert.rejects(f.service.mergeSelectedAnnotations(f.win,keys),/2–50/);
 let menu;f.Z.Reader._registeredListeners.find(l=>l.type==='createAnnotationContextMenu').handler({reader:f.reader,params:{ids:keys},append:item=>menu=item});assert.equal(menu.disabled,true);f.service.stop();
});
test('R16 parent deletion reparenting and library changes during file checks reject stale version choices',async()=>{
 for(const change of [f=>{f.items.get(1).deleted=true;},f=>{f.items.get(11).parentID=999;},f=>{f.items.get(11).libraryID=2;},f=>{f.items.get(1).libraryID=2;}]){
  const f=fixture();f.items.set(1,{id:1,libraryID:1,getAttachments:()=>[12]});f.items.get(11).parentID=1;let release;
  f.items.set(12,{id:12,parentID:1,libraryID:1,isPDFAttachment:()=>true,fileExists:()=>new Promise(resolve=>release=resolve)});
  const pending=f.service.switchAttachmentVersion(f.win,12);await new Promise(resolve=>setImmediate(resolve));change(f);release(true);await assert.rejects(pending,/changed or closed/);assert.equal(f.opened.length,0);f.service.stop();
 }
});
test('typed reader preferences immediately control theme margin typography text visibility and sidebar without writing startup prefs',async()=>{
 const f=fixture(),prefs={readerTheme:'dark',marginEnabled:true,marginWidth:320,marginSide:'left',marginFontSize:18,marginTextLimit:100,marginShowQuote:false,marginShowComment:true,readerSidebar:false,verticalTabs:true};let writes=0;
 f.runtime.getSetting=key=>prefs[key];f.Z.Prefs={set(){writes++;}};f.core._state.sidebarOpen=true;f.core._state.annotations[0].type='highlight';
 await f.service.applyPreferences(f.win);assert.equal(writes,0);assert.equal(f.core._state.darkTheme.id,'dark');assert.equal(f.core._state.sidebarOpen,false);let aside=f.page.children[0];assert.match(aside.style.cssText,/width:320px/);assert.match(aside.style.cssText,/font:18px/);assert.match(aside.style.cssText,/right:calc/);assert.match(aside.children[0].textContent,/Important/);assert.doesNotMatch(aside.children[0].textContent,/<img/);assert.ok(f.doc.documentElement.children.some(n=>n.className==='style-custom-vertical-tabs'));
 prefs.marginShowComment=false;await f.service.applyPreferences(f.win);assert.doesNotMatch(f.page.children[0].children[0].textContent,/Important/);
 prefs.readerTheme='original';prefs.marginEnabled=false;prefs.verticalTabs=false;await f.service.applyPreferences(f.win);assert.equal(f.core._state.darkTheme.id,'black');assert.equal(f.page.children.length,0);assert.equal(writes,0);f.service.stop();
});
test('all six annotation type preferences control actual margin cards independently',async()=>{
 const f=fixture(),prefs={marginEnabled:true};f.runtime.getSetting=key=>prefs[key];const types=['highlight','underline','note','image','text','ink'];f.core._state.annotations=types.map((type,i)=>({id:'A'+i,type,text:type,position:{pageIndex:0}}));
 for(const hidden of types){for(const type of types)prefs['marginShow'+type[0].toUpperCase()+type.slice(1)]=type!==hidden;await f.service.applyPreferences(f.win);assert.equal(f.page.children[0].children.length,5);assert.ok(f.page.children[0].children.every(b=>!b.textContent.endsWith('\n'+hidden)));}
 f.service.stop();
});
test('reader feature switches restore applied effects and gate retained actions and native hooks',async()=>{
 const f=fixture(),disabled=new Set();f.runtime.featureEnabled=id=>!disabled.has(id);await f.service.applyTheme(f.win,'dark');await f.service.setMarginAnnotations(f.win,true);await f.service.setVerticalTabs(f.win,true);await f.service.setSidebar(f.win,true);
 for(const key of ['PDFStyles','marginAnnotation','verticalTabManager','toogleSidebar','annotationColors','reader.mergeAnnotations','reader.attachmentVersionSwitch','backlinks'])disabled.add(key);
 await f.service.applyPreferences(f.win);assert.equal(f.core._state.darkTheme.id,'black');assert.equal(f.page.children.length,0);assert.ok(!f.doc.documentElement.children.some(n=>n.className==='style-custom-vertical-tabs'));
 await assert.rejects(f.service.applyTheme(f.win,'light'),/disabled/);await assert.rejects(f.service.setMarginAnnotations(f.win,true),/disabled/);assert.throws(()=>f.service.setAnnotationColor(f.win,'#123456'),/disabled/);await assert.rejects(f.service.mergeSelectedAnnotations(f.win,['A','B']),/disabled/);await assert.rejects(f.service.attachmentVersions(f.win),/disabled/);
 let appended=0;for(const type of ['renderSidebarAnnotationHeader','createAnnotationContextMenu'])f.Z.Reader._registeredListeners.find(l=>l.type===type).handler({reader:f.reader,doc:f.doc,params:{annotation:{id:'ANN'},ids:['A','B']},append(){appended++;}});assert.equal(appended,0);f.service.stop();
});
test('color-name switch hides labels while keeping semantic annotation colors',async()=>{
 const f=fixture();let names=true;f.runtime.featureEnabled=id=>id==='showAnnotationColorName'?names:true;await f.service.setMarginAnnotations(f.win,true);assert.match(f.page.children[0].children[0].textContent,/Yellow/);names=false;await f.service.applyPreferences(f.win);assert.doesNotMatch(f.page.children[0].children[0].textContent,/Yellow/);assert.match(f.page.children[0].children[0].style.cssText,/#ffd400/);f.service.stop();
});
test('legacy setters synchronize typed prefs without recursive runtime.setSetting calls and custom themes round-trip',async()=>{
 const f=fixture(),prefs={readerTheme:'original',marginEnabled:false};f.runtime.getSetting=key=>prefs[key];f.runtime.setSetting=()=>assert.fail('recursive settings write');f.Z.Prefs={set:(key,value)=>{prefs[key.replace('extensions.style-custom.','')]=value;}};
 await f.service.applyTheme(f.win,{background:'#eeeeee',foreground:'#222222'});assert.equal(prefs.readerTheme,'custom');await f.service.setMarginOptions(f.win,{width:280});assert.equal(prefs.marginWidth,280);await f.service.setMarginAnnotations(f.win,true);assert.equal(prefs.marginEnabled,true);await f.service.applyPreferences(f.win);assert.equal(f.core._state.lightTheme.id,'style-custom-palette');await f.service.applyTheme(f.win,'original');assert.equal(prefs.readerTheme,'original');await f.service.applyPreferences(f.win);assert.equal(f.core._state.lightTheme.id,'snow');f.service.stop();
});
test('disabling reader features hides effects without erasing legacy choices needed when reenabled',async()=>{
 const f=fixture();let on=true;f.runtime.featureEnabled=()=>on;await f.service.applyTheme(f.win,'sepia');await f.service.setMarginAnnotations(f.win,true);await f.service.setVerticalTabs(f.win,true);on=false;await f.service.applyPreferences(f.win);assert.equal(f.runtime.cache.readerSettings.theme,'sepia');assert.equal(f.runtime.cache.readerSettings.marginAnnotations,true);assert.equal(f.runtime.cache.readerSettings.verticalTabs,true);on=true;await f.service.applyPreferences(f.win);assert.equal(f.core._state.lightTheme.id,'sepia');assert.equal(f.page.children.length,1);f.service.stop();
});
test('root legacy margin-font fallback survives preference application and width-only changes',async()=>{
 const f=fixture();f.runtime.cache.readerSettings={marginAnnotations:true,marginOptions:{width:210,fontSize:20}};
 f.runtime.getSetting=key=>key==='marginFontSize'?(f.runtime.cache.readerSettings.marginOptions.fontSize??13):undefined;
 await f.service.applyPreferences(f.win);assert.equal(f.runtime.cache.readerSettings.marginOptions.fontSize,20);assert.match(f.page.children[0].style.cssText,/font:20px/);
 await f.service.setMarginOptions(f.win,{width:300});assert.equal(f.runtime.cache.readerSettings.marginOptions.fontSize,20);assert.match(f.page.children[0].style.cssText,/font:20px/);f.service.stop();
});

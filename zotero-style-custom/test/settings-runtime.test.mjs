import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import Runtime from '../src/runtime.js';
import Model from '../src/data.js';
import Settings from '../src/settings.js';
const settle=async()=>{for(let n=0;n<8;n++)await new Promise(resolve=>setImmediate(resolve));};
function fixture(){
 const prefs=new Map([['extensions.style-custom.language','ko-KR']]),columns=new Map(),items=new Map(),clockOptions=[],errors=[];
 const Z={locale:'ko-KR',Prefs:{get:key=>prefs.get(key),set:(key,value)=>prefs.set(key,value),registerObserver:()=>1,unregisterObserver(){}},Libraries:{userLibraryID:1,get:()=>({editable:true,libraryType:'user'})},Items:{get:id=>items.get(id),getAsync:async id=>items.get(id)},Reader:{_readers:[]},ItemTreeManager:{registerColumn:option=>{columns.set(option.dataKey,option);return option.dataKey;},unregisterColumn:key=>columns.delete(key)},PreferencePanes:{register:async option=>{Z.pane=option;return 'settings';},unregister(){}},DataDirectory:{dir:'/fixture'},getMainWindow:()=>null,logError:error=>errors.push(error),debug(){}};
 const storage={read:async()=>({schema:1,items:{}}),write:async()=>{}};
 const runtime=new Runtime({Zotero:Z,model:Model,marquee:{attach:()=>()=>{}},reading:{attach:(_win,options)=>{clockOptions.push(options);return ()=>{};}},storage});
 const paper={id:1,key:'PAPER',libraryID:1,getField:key=>({title:'Selected paper',dateAdded:'2020-01-01',dateModified:'2020-01-02'})[key]||'',getTags:()=>[],getCreators:()=>[],isRegularItem:()=>true,isEditable:()=>true,hasChanged:()=>false};items.set(1,paper);
 return {runtime,Z,prefs,columns,items,paper,storage,clockOptions,errors,start:()=>runtime.start({id:'style-custom@sungjaeyoon.dev',version:'0.8.0',rootURI:'file:///plugin/'})};
}
test('real feature settings unregister and restore columns and preferences registration includes script style and icon',async()=>{
 const f=fixture();await f.start();assert.equal(f.columns.has('if'),true);await f.runtime.setSetting('feature.IFColumn',false);assert.equal(f.columns.has('if'),false);await f.runtime.setSetting('feature.IFColumn',true);assert.equal(f.columns.has('if'),true);
 assert.ok(f.Z.pane.image.endsWith('style-custom.svg'));assert.ok(f.Z.pane.scripts[0].endsWith('settings.js'));assert.ok(f.Z.pane.stylesheets[0].endsWith('preferences.css'));
 await assert.rejects(f.runtime.setSetting('recordIntervalMs',777));assert.equal(f.runtime.getSetting('recordIntervalMs'),1000);await assert.rejects(f.runtime.setSetting('made-up',true));await f.runtime.stop();
});
test('typed settings reset restores real defaults and preserves provider credentials',async()=>{
 const f=fixture();await f.start();await f.runtime.setSetting('openalexApiKey','private-test-key');await f.runtime.setSetting('citationRefreshDays',30);await f.runtime.setSetting('metadataCitations',false);
 const result=await f.runtime.resetSettings('metrics');assert.equal(result.secretsPreserved,true);assert.equal(f.runtime.getSetting('openalexApiKey'),'private-test-key');assert.equal(f.runtime.getSetting('citationRefreshDays'),7);assert.equal(f.runtime.getSetting('metadataCitations'),true);await f.runtime.stop();
});
test('reading time starts at zero and live cell updates before a delayed cache save completes',async()=>{
 const f=fixture();await f.start();const {document,window}=parseHTML('<html><body></body></html>');window.ZoteroPane={itemsView:{getRow:()=>({ref:f.paper})}};let refreshes=0;f.runtime.windows.set(window,{workbench:{refreshMetrics:()=>refreshes++}});
 const cell=f.runtime.renderCell('time',0,'',{},document);document.body.appendChild(cell);assert.equal(cell.textContent,'','nothing read yet: the cell stays blank by default');let writes=0;f.storage.write=async()=>{writes++;};await f.runtime.addReading(f.paper,1,{attachmentID:9,pageIndex:0,totalPages:10});assert.equal(cell.textContent,'1s','the cell is repainted on the tick itself');assert.equal(refreshes,1);await settle();
 // A tick a second must not rewrite the whole store: the seconds are held and
 // written by the scheduled flush, or by stop().
 assert.equal(writes,0,'the tick does not write to disk');assert.equal(f.runtime.dirty,true,'but it is remembered as unsaved');
 f.runtime.cancelScheduledFlush();await f.runtime.flush();assert.equal(writes,1,'an explicit flush writes once');
 f.storage.write=async()=>{};f.runtime.windows.clear();await f.runtime.setSetting('timeFormat','clock');assert.equal(f.runtime.formatReadTime(3661),'01:01:01');await f.runtime.setSetting('timeFormat','seconds');assert.equal(f.runtime.formatReadTime(0),'','zero stays blank by default');await f.runtime.setSetting('showZeroReadTime',true);assert.equal(f.runtime.formatReadTime(0),'0초');await f.runtime.setSetting('showZeroReadTime',false);assert.equal(f.runtime.formatReadTime(0),'');await f.runtime.stop();
});
test('recording interval and idle settings reconfigure the clock while unrelated settings do not restart it',async()=>{
 const f=fixture();await f.start();const {window}=parseHTML('<html><body></body></html>');const state={};f.runtime.windows.set(window,state);f.runtime.attachMotion(window,state);assert.equal(f.clockOptions.at(-1).intervalMs,1000);assert.equal(f.clockOptions.at(-1).idleMs,60000);
 await f.runtime.setSetting('recordIntervalMs',500);await f.runtime.setSetting('idleSeconds',10);assert.equal(f.clockOptions.at(-1).intervalMs,500);assert.equal(f.clockOptions.at(-1).idleMs,10000);const n=f.clockOptions.length;await f.runtime.setSetting('panelFontSize',16);assert.equal(f.clockOptions.length,n);f.runtime.windows.clear();await f.runtime.stop();
});
test('tag display and legacy reader preference fallbacks preserve data while changing presentation',async()=>{
 const f=fixture();await f.start();f.paper.getTags=()=>[{tag:'#topic'},{tag:'Plain'},{tag:'Colored'}];f.Z.Tags={getColor:(_lib,tag)=>tag==='Colored'?{color:'#ff0000'}:null};await f.runtime.setSetting('tagDisplayMode','prefixed');assert.deepEqual(f.runtime.displayTags(f.paper).map(t=>t.tag),['#topic']);await f.runtime.setSetting('tagDisplayMode','colored');assert.deepEqual(f.runtime.displayTags(f.paper).map(t=>t.tag),['Colored']);assert.equal(f.paper.getTags().length,3);
 f.runtime.cache.readerSettings={theme:{background:'#eeeeee',foreground:'#111111'},marginAnnotations:true,marginOptions:{width:320}};assert.equal(f.runtime.getSetting('readerTheme'),'custom');assert.equal(f.runtime.getSetting('readerCustomBackground'),'#eeeeee');assert.equal(f.runtime.getSetting('marginWidth'),320);await f.runtime.setSetting('marginWidth',280);assert.equal(f.runtime.getSetting('marginWidth'),280);await f.runtime.stop();
});
test('the actual preferences pane checkbox changes actual runtime column behavior',async()=>{
 const f=fixture();await f.start();const {document,window}=parseHTML('<html><body><div id="style-custom-settings-root"></div></body></html>');Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this._value??this.querySelector('option')?.value??'';},set(value){this._value=String(value);}});
 const pane=Settings.mount({document,runtime:f.runtime});await pane.ready;const toggle=document.querySelector('[data-setting="feature.IFColumn"] input');toggle.checked=false;toggle.dispatchEvent(new window.Event('change'));await settle();assert.equal(f.columns.has('if'),false);assert.equal(f.runtime.getSetting('feature.IFColumn'),false);pane.destroy();await f.runtime.stop();
});

test('preference observers do not reset active reading for status or marquee changes and recording toggles attach once',async()=>{
 const f=fixture(),observers=new Map();f.Z.Prefs.registerObserver=(key,fn)=>{observers.set(key,fn);return key;};const set=f.Z.Prefs.set;f.Z.Prefs.set=(key,value)=>{set(key,value);observers.get(key)?.();};await f.start();const {window}=parseHTML('<html><body></body></html>'),state={};f.runtime.windows.set(window,state);f.runtime.attachMotion(window,state);const start=f.clockOptions.length;
 await f.runtime.setSetting('autoStatus',false);await f.runtime.setSetting('scrollSpeed',250);assert.equal(f.clockOptions.length,start);f.Z.Prefs.set('extensions.style-custom.autoStatus',true);assert.equal(f.clockOptions.length,start);
 await f.runtime.setSetting('recordReading',false);assert.equal(f.clockOptions.length,start);await f.runtime.setSetting('recordReading',true);assert.equal(f.clockOptions.length,start+1);f.runtime.windows.clear();await f.runtime.stop();
});

test('relative date display leaves native sort values intact and citation retry options affect the real due calculation',async()=>{
 const f=fixture();await f.start();const {document,window}=parseHTML('<html><body></body></html>');window.ZoteroPane={itemsView:{getRow:()=>({ref:f.paper})}};await f.runtime.setSetting('dateDisplay','relative');const cell=f.runtime.renderCell('added',0,'',{},document);assert.match(cell.textContent,/일 전/);assert.equal(f.runtime.value('added',f.paper),'2020-01-01');
 const identity=f.runtime.citationTools.identity(f.runtime.citationRecord(f.paper));f.runtime.entry(f.paper).citationAttempt={status:'error',identity,checkedAt:new Date(Date.now()-10*60000).toISOString()};assert.equal(f.runtime.citationDue(f.paper),false);await f.runtime.setSetting('citationRetryMinutes',5);assert.equal(f.runtime.citationDue(f.paper),true);await f.runtime.stop();
});
test('choosing a language applies that language at once, not the one it replaces',async()=>{
 const f=fixture();await f.start();
 await f.runtime.setSetting('language','en-US');
 assert.equal(f.runtime.t('설정을 불러왔습니다.'),'Settings loaded.','English the moment English is chosen');
 await f.runtime.setSetting('language','ko-KR');
 assert.equal(f.runtime.t('설정을 불러왔습니다.'),'설정을 불러왔습니다.');
 await f.runtime.stop();
});
test('an email or server address that cannot work is refused when typed, and blank still means unset',async()=>{
 const f=fixture();await f.start();
 await assert.rejects(f.runtime.setSetting('citationEmail','not-an-email'),/이메일 형식/);
 await assert.rejects(f.runtime.setSetting('aiEndpoint','api.example.com/v1'),/https:\/\//);
 await f.runtime.setSetting('citationEmail','');await f.runtime.setSetting('aiEndpoint','https://api.example.com/v1/chat/completions');
 await f.runtime.setSetting('aiEndpoint','http://localhost:1234/v1');
 await f.runtime.stop();
});
test('the updates section says when the last check ran and why it failed, in words',async()=>{
 const f=fixture();await f.start();
 f.runtime.updater={lastResult:()=>({status:'error',at:'2026-09-27T05:02:00.000Z',message:'download failed'}),run:async()=>({status:'error',message:'download failed'})};
 assert.match(f.runtime.getSetting('updateStatus'),/실패 · download failed/);
 await assert.rejects(f.runtime.checkUpdatesNow(),/새 버전을 확인하지 못했습니다/);
 f.runtime.updater.lastResult=()=>null;
 assert.equal(f.runtime.getSetting('updateStatus'),'아직 확인하지 않았습니다.');
 await f.runtime.stop();
});
test('resetting a category brings back defaults but keeps the server address and model the reader typed',async()=>{
 const f=fixture();await f.start();
 await f.runtime.setSetting('aiEndpoint','https://api.example.com/v1/chat/completions');await f.runtime.setSetting('aiModel','my-model');
 const result=await f.runtime.resetSettings('ai');
 assert.equal(f.runtime.getSetting('aiEndpoint'),'https://api.example.com/v1/chat/completions');
 assert.equal(f.runtime.getSetting('aiModel'),'my-model');
 assert.ok(result.kept.includes('aiEndpoint'));
 await f.runtime.stop();
});
test('resetting the reader section with white text on black is not stopped halfway by the contrast check',async()=>{
 const f=fixture();await f.start();
 await f.runtime.setSetting('readerCustomBackground','#000000');await f.runtime.setSetting('readerCustomForeground','#ffffff');
 await f.runtime.resetSettings('reader');
 assert.notEqual(f.runtime.getSetting('readerCustomBackground'),'#000000','the whole set went back');
 await f.runtime.stop();
});
test('setupHints: 한국어 offered only to a Korean Zotero that never chose a language; Translate for Zotero and a DeepL key named as the translator',async()=>{
 const f=fixture();await f.start();
 assert.equal(f.runtime.setupHints().suggestLanguage,null,'a chosen language (ko-KR here) is never second-guessed');
 f.prefs.delete('extensions.style-custom.language');
 assert.equal(f.runtime.setupHints().suggestLanguage,'ko-KR','never chosen, Zotero in Korean');
 // The shipped default (prefs.js) is a value but not a choice.
 f.prefs.set('extensions.style-custom.language','en-US');f.runtime.Services={prefs:{prefHasUserValue:()=>false}};
 assert.equal(f.runtime.setupHints().suggestLanguage,'ko-KR','the default en-US from prefs.js is not a choice');
 f.runtime.Services={prefs:{prefHasUserValue:()=>true}};
 assert.equal(f.runtime.setupHints().suggestLanguage,null,'a user value is');
 f.runtime.Services={prefs:{prefHasUserValue:()=>false}};
 f.Z.locale='en-US';assert.equal(f.runtime.setupHints().suggestLanguage,null,'an English Zotero keeps the English default quietly');
 assert.equal(f.runtime.setupHints().openalexInherited,false);
 f.prefs.set('extensions.zotpop.openAlexApiKey','zp-key');
 assert.equal(f.runtime.setupHints().openalexInherited,true,'the key typed into ZotPoP is used here too');
 assert.equal(f.runtime.setupHints().translator,null);
 f.Z.PDFTranslate={api:{translate:async()=>({})}};
 assert.equal(f.runtime.setupHints().translator,'pdftranslate');
 f.prefs.set('extensions.style-custom.deeplApiKey','abc:fx');
 assert.equal(f.runtime.setupHints().translator,'deepl','a key of its own comes first, as the panel picks it');
 assert.equal(typeof f.runtime.setupHints().ai.available,'boolean');
 await f.runtime.stop();
});

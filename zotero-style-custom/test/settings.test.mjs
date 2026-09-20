import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import Settings from '../src/settings.js';
import Schema from '../src/settings-schema.js';
const settle=async()=>{for(let n=0;n<6;n++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(schema){
 const {document:doc,window:win}=parseHTML('<html><body><div id="style-custom-settings-root"></div></body></html>');
 Object.defineProperty(win.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this._value??this.querySelector('option')?.getAttribute('value')??'';},set(value){this._value=String(value);}});
 Object.defineProperty(doc,'activeElement',{configurable:true,get(){return this._active||doc.body;}});win.HTMLElement.prototype.focus=function(){this.ownerDocument._active=this;};
 const categories=Schema.schema.categories;schema||={categories,settings:[
 {key:'enabled',category:'columns',label:'기능 사용',type:'boolean',default:true,description:'지표 열을 표시합니다.'},
 {key:'speed',category:'reader',label:'속도',type:'number',default:100,min:10,max:500,step:10,description:'초당 이동 거리입니다.'},
 {key:'theme',category:'reader',label:'테마',type:'select',default:'light',options:[{value:'light',label:'밝게'},{value:'dark',label:'어둡게'}],description:'리더 색상입니다.'},
 {key:'label',category:'tags',label:'이름',type:'text',default:'original',description:'표시할 이름입니다.'},
 {key:'secret',category:'ai',label:'API 키',type:'password',secret:true,default:'',description:'로컬에 보관하는 키입니다.'},
 {key:'model',category:'ai',label:'모델',type:'text',default:'default-model',description:'요청에 사용할 모델입니다.'},
 {key:'css',category:'views',label:'CSS',type:'textarea',default:'',rows:5,description:'워크벤치에 적용합니다.'},
 {key:'refresh',category:'metrics',label:'지표 새로고침',type:'action',action:'refresh-metrics',default:null,description:'선택한 문헌을 조회합니다.'}]};
 const values=Object.fromEntries(schema.settings.map(spec=>[spec.key,spec.default]));if('secret'in values)values.secret='masked-value';
 const calls=[],status={version:'test',recordReading:true,selectedTitle:'Fixture paper',readSeconds:0,citationStatus:'idle',storagePath:'/local/cache.json'};
 const runtime={settingsSchema:schema,getSetting:key=>values[key],setSetting:async(key,value)=>{calls.push(['set',key,value]);values[key]=value;},resetSettings:async category=>{calls.push(['reset',category]);for(const spec of schema.settings)if(spec.category===category&&!spec.secret&&spec.type!=='password'&&spec.type!=='action')values[spec.key]=spec.default;},runSettingAction:async action=>{calls.push(['action',action]);},getSettingsStatus:()=>({...status})};
 const mount=()=>Settings.mount({document:doc,runtime});
 const row=key=>doc.querySelector('[data-setting="'+key+'"]');const input=key=>row(key)?.querySelector('input,select,textarea');
 const edit=(key,value,event='input')=>{const element=input(key);if(element.type==='checkbox')element.checked=!!value;else element.value=value;element.dispatchEvent(new win.Event(event,{bubbles:true}));return element;};
 const click=async text=>{const button=[...doc.querySelectorAll('button')].find(b=>b.textContent===text||b.getAttribute('aria-label')===text);assert.ok(button,text);button.dispatchEvent(new win.Event('click',{bubbles:true}));await settle();};
 return {doc,win,runtime,values,calls,status,mount,row,input,edit,click};
}
test('real schema renders all ten categories and every typed runtime-bound setting',async()=>{
 const f=fixture(Schema.schema),pane=f.mount();await pane.ready;assert.equal(f.doc.querySelectorAll('.scs-nav button').length,10);assert.equal(f.doc.querySelectorAll('[data-setting]').length,Schema.schema.settings.length);assert.ok(Schema.schema.settings.length>=100);
 for(const spec of Schema.schema.settings){const row=f.row(spec.key);assert.ok(row.querySelector('.scs-help'));assert.ok(row.querySelector('[aria-describedby]'));if(spec.secret)assert.equal(f.input(spec.key).type,'password');}
 pane.destroy();
});
test('boolean and enum bindings are immediate but numeric and text edits require Apply',async()=>{
 const f=fixture(),pane=f.mount();await pane.ready;f.edit('enabled',false,'change');await settle();assert.deepEqual(f.calls.at(-1),['set','enabled',false]);pane.selectCategory('reader');f.edit('theme','dark','change');await settle();assert.deepEqual(f.calls.at(-1),['set','theme','dark']);f.edit('speed','120');assert.equal(f.values.speed,100);await f.click('속도 적용');assert.equal(f.values.speed,120);
 pane.selectCategory('tags');f.edit('label','new name');assert.equal(f.values.label,'original');await f.click('이름 적용');assert.equal(f.values.label,'new name');pane.destroy();
});
test('invalid values stay editable with helpful errors and never reach runtime',async()=>{
 const f=fixture(),pane=f.mount();await pane.ready;pane.selectCategory('reader');f.edit('speed','');await f.click('속도 적용');assert.equal(f.calls.length,0);assert.match(f.row('speed').textContent,/숫자를 입력/);f.edit('speed','111');await f.click('속도 적용');assert.equal(f.calls.length,0);assert.match(f.row('speed').textContent,/간격/);f.edit('speed','510');await f.click('속도 적용');assert.equal(f.calls.length,0);assert.equal(f.input('speed').value,'510');pane.destroy();
});
test('search finds labels and help across categories without exposing secret values',async()=>{
 const f=fixture(),pane=f.mount();await pane.ready;const search=f.doc.querySelector('[aria-label="Style Custom 설정 검색"]');search.value='초당 이동';search.dispatchEvent(new f.win.Event('input'));assert.equal(f.row('speed').hidden,false);assert.equal(f.row('label').hidden,true);search.value='masked-value';search.dispatchEvent(new f.win.Event('input'));assert.equal(f.doc.querySelector('.scs-empty').hidden,false);assert.equal(f.doc.body.textContent.includes('masked-value'),false);await f.click('검색 지우기');assert.equal(search.value,'');pane.destroy();
});
test('navigation and actual status polling preserve uncommitted inputs including zero reading time',async()=>{
 const f=fixture(),pane=f.mount();await pane.ready;pane.selectCategory('tags');f.edit('label','Unsaved');pane.selectCategory('reader');pane.selectCategory('tags');f.status.readSeconds=1;await pane.refreshStatus();assert.equal(f.input('label').value,'Unsaved');assert.equal(f.values.label,'original');assert.match(f.doc.querySelector('.scs-live').textContent,/1초/);assert.equal(f.doc.querySelector('.scs-reading-value').textContent,'1초');f.status.readSeconds=0;await pane.refreshStatus();assert.match(f.doc.querySelector('.scs-live').textContent,/0초/);assert.equal(f.doc.querySelector('.scs-reading-value').textContent,'0초');pane.destroy();
});
test('failed Apply preserves the draft and allows an explicit retry',async()=>{
 const f=fixture(),pane=f.mount();await pane.ready;let fail=true;f.runtime.setSetting=async(key,value)=>{if(fail)throw Error('disk full');f.values[key]=value;};pane.selectCategory('tags');f.edit('label','Keep me');await f.click('이름 적용');assert.equal(f.input('label').value,'Keep me');assert.match(f.row('label').textContent,/disk full/);fail=false;await f.click('이름 적용');assert.equal(f.values.label,'Keep me');pane.destroy();
});
test('reset operates on one category, preserves secrets and does not discard a failed-reset draft',async()=>{
 const f=fixture(),pane=f.mount();await pane.ready;f.values.model='custom';pane.selectCategory('ai');f.edit('model','Unsaved model');await f.click('번역·AI 기본값 복원');assert.equal(f.values.secret,'masked-value');assert.equal(f.input('secret').value,'masked-value');assert.equal(f.input('model').value,'default-model');assert.match(f.doc.querySelector('.scs-message').textContent,/API 키.*유지/);
 f.runtime.resetSettings=async()=>{throw Error('reset failure');};f.edit('model','Retain after error');await f.click('번역·AI 기본값 복원');assert.equal(f.input('model').value,'Retain after error');pane.destroy();
});
test('pending actions are single-flight and status or late completion cannot mutate an unloaded pane',async()=>{
 const f=fixture(),pending=deferred();let calls=0;f.runtime.runSettingAction=()=>{calls++;return pending.promise;};const pane=f.mount();await pane.ready;pane.selectCategory('metrics');const action=f.row('refresh').querySelector('button');action.dispatchEvent(new f.win.Event('click'));action.dispatchEvent(new f.win.Event('click'));assert.equal(calls,1);assert.equal(action.disabled,true);const before=f.doc.body.textContent;pane.destroy();pending.resolve();await settle();assert.equal(f.doc.body.textContent,before);
});
test('initial loading errors are reported and retry preserves other dirty inputs',async()=>{
 const f=fixture();let fail=true;f.runtime.getSetting=key=>{if(key==='speed'&&fail)throw Error('not loaded');return f.values[key];};const pane=f.mount();await pane.ready;assert.match(f.doc.querySelector('.scs-message').textContent,/1개 설정/);f.edit('label','Local draft');fail=false;await f.click('설정 다시 읽기');assert.equal(f.input('label').value,'Local draft');assert.equal(f.input('speed').value,'100');assert.match(f.doc.querySelector('.scs-message').textContent,/불러왔습니다/);pane.destroy();
});
test('fragment initialization is idempotent and the settings script exposes the facade to the pane window',async()=>{
 const f=fixture();f.win.Zotero={StyleCustom:f.runtime};const code=fs.readFileSync(new URL('../src/settings.js',import.meta.url),'utf8');const sandbox={document:f.doc,Zotero:f.win.Zotero};vm.runInNewContext(code,sandbox);assert.equal(typeof f.win.CustomStyleSettings.init,'function');const first=await f.win.CustomStyleSettings.init(f.doc),second=await f.win.CustomStyleSettings.init(f.doc);assert.equal(first,second);assert.equal(f.doc.querySelectorAll('.scs-nav').length,1);f.win.dispatchEvent(new f.win.Event('unload'));first.destroy();
 const fragment=fs.readFileSync(new URL('../content/preferences.xhtml',import.meta.url),'utf8');assert.match(fragment,/event\.waitUntil\(window\.CustomStyleSettings\.init\(document\)\)/);
});

test('pending value loading cannot overwrite an input edit and Apply remains available after a save race',async()=>{
 const f=fixture(),initial=deferred();f.runtime.getSetting=key=>key==='label'?initial.promise:f.values[key];const pane=f.mount();f.edit('label','Typed before load');initial.resolve('server value');await pane.ready;assert.equal(f.input('label').value,'Typed before load');
 const pending=deferred();f.runtime.setSetting=()=>pending.promise;f.edit('label','Submitted');const apply=f.row('label').querySelector('button');apply.dispatchEvent(new f.win.Event('click'));f.edit('label','server value');pending.resolve();await settle();assert.equal(f.input('label').value,'server value');assert.equal(apply.disabled,false);assert.match(f.row('label').textContent,/새 입력/);pane.destroy();
});
test('category reset retains edits made after the reset request and does not repeat while pending',async()=>{
 const f=fixture(),pending=deferred();let calls=0;f.runtime.resetSettings=()=>{calls++;return pending.promise;};const pane=f.mount();await pane.ready;pane.selectCategory('ai');f.edit('model','Before reset');const reset=f.doc.querySelector('[aria-label="번역·AI 기본값 복원"]');reset.dispatchEvent(new f.win.Event('click'));reset.dispatchEvent(new f.win.Event('click'));f.edit('model','Typed while reset waited');pending.resolve();await settle();assert.equal(calls,1);assert.equal(f.input('model').value,'Typed while reset waited');assert.equal(f.values.secret,'masked-value');pane.destroy();
});
test('category keyboard navigation moves visible content and keeps a stable focus target',async()=>{
 const f=fixture(),pane=f.mount();await pane.ready;const first=f.doc.querySelector('.scs-nav button');first.focus();const event=new f.win.Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,{key:'ArrowDown'});first.dispatchEvent(event);assert.equal(f.doc.activeElement.dataset.category,Schema.schema.categories[1].id);assert.equal(f.doc.querySelector('.scs-category[data-category="'+Schema.schema.categories[1].id+'"]').hidden,false);pane.destroy();
});

test('Apply displays the backend canonical value without losing a newer draft',async()=>{
 const f=fixture(),pane=f.mount();await pane.ready;f.runtime.setSetting=async(key,value)=>value.trim();f.edit('label','  normalized  ');await f.click('이름 적용');assert.equal(f.input('label').value,'normalized');assert.equal(f.row('label').querySelector('button').disabled,true);pane.destroy();
});

test('the start-here block lists only the blank keys and sends each to its field',async()=>{
 const f=fixture(Schema.schema),pane=f.mount();await pane.ready;
 const block=f.doc.querySelector('.scs-first');
 assert.ok(block&&!block.hidden,'a fresh profile is told what to fill first');
 const shown=()=>[...f.doc.querySelectorAll('.scs-first-list button')].filter(b=>!b.hidden).map(b=>b.dataset.first);
 assert.deepEqual(shown(),['openalexApiKey','aiEndpoint','citationEmail'],'the key that turns the citation column on comes first; the email, which costs privacy, last');
 assert.ok(block.textContent.includes('인용 수·저널 정보'),'each one says what it unlocks');
 const row=f.doc.querySelector('[data-first="aiEndpoint"]');
 row.dispatchEvent(new f.win.Event('click',{bubbles:true}));await settle();
 assert.equal(f.doc.querySelector('.scs-category[data-category="ai"]').hidden,false,'it opens the category');
 assert.equal(f.doc.activeElement,f.input('aiEndpoint'),'and lands in the field');
 f.edit('citationEmail','someone@example.org');await f.click('연락 이메일 (선택) 적용');await settle();
 assert.ok(!shown().includes('citationEmail'),'a filled key leaves the block');
 pane.destroy();
});

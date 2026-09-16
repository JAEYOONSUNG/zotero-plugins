import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {parseHTML} from 'linkedom';
import Schema from '../src/settings-schema.js';
import Settings from '../src/settings.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function mountPreview(document,api,schema){
 const values=Object.fromEntries(schema.schema.settings.filter(row=>row.type!=='action').map(row=>[row.key,row.default]));
 const runtime={settingsSchema:schema.schema,getSetting:key=>values[key],setSetting:async(key,value)=>{schema.validate(key,value);values[key]=value;return value;},resetSettings:async category=>{for(const row of schema.schema.settings)if(row.category===category&&!row.secret&&row.type!=='action')values[row.key]=row.default;},runSettingAction:async()=>{throw new Error('설정 화면 미리보기입니다. 실제 Zotero 작업은 실행하지 않습니다.');},getSettingsStatus:()=>({version:'0.8.0 미리보기',recordReading:values.recordReading,selectedTitle:'예시 문헌',readSeconds:0,citationStatus:'실제 연결 없음',storagePath:'예시 · 실제 파일에 저장하지 않음'})};
 const pane=api.mount({document,runtime});await pane.ready;return pane;
}
const {document,window}=parseHTML('<html><body><div id="style-custom-settings-root"></div></body></html>');
Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this._value??this.querySelector('option')?.getAttribute('value')??'';},set(v){this._value=String(v);}});
const pane=await mountPreview(document,Settings,Schema);assert.equal(document.querySelectorAll('.scs-nav button').length,Schema.schema.categories.length);assert.equal(document.querySelectorAll('.scs-setting').length,Schema.schema.settings.length);
const snapshot=document.getElementById('style-custom-settings-root').outerHTML;pane.destroy();
const text=file=>fs.readFileSync(path.join(root,file),'utf8');const code=file=>text(file).replace(/<\/script/gi,'<\\/script');
const icon='data:image/svg+xml;base64,'+Buffer.from(text('content/icons/style-custom.svg')).toString('base64');
const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Style Custom 0.8 · 상세 환경설정 미리보기</title><style>body{margin:0;padding:20px;max-width:1100px;margin-inline:auto;background:Canvas;color:CanvasText;font:14px system-ui}header{display:flex;align-items:center;gap:12px;border-bottom:1px solid GrayText;padding-bottom:12px}header img{width:40px;height:40px}header small{display:block;color:GrayText}${text('content/preferences.css')}</style></head><body><header><img src="${icon}" alt="Style Custom 아이콘"><div><strong>상세 환경설정 미리보기</strong><small>예시 값 · 실제 Zotero·라이브러리에 연결하지 않습니다.</small></div></header>${snapshot}<script>${code('src/settings-schema.js')}</script><script>${code('src/settings.js')}</script><script>(${mountPreview.toString()})(document,CustomStyleSettings,CustomStyleSettingsSchema);</script></body></html>`;
assert.ok(!html.includes('<script src=')&&!html.includes('<link '));fs.writeFileSync(path.join(root,'docs/settings-preview.html'),html);
console.log(`Settings preview verified: ${Schema.schema.categories.length} categories, ${Schema.schema.settings.length} bound rows; actual settings DOM and inline assets; no native launch`);

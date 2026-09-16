import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import Schema from '../src/settings-schema.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=['src/runtime.js','src/workbench.js','src/reader-tools.js','src/reading.js','src/assist.js','src/library.js'];
const source=Object.fromEntries(files.map(file=>[file,fs.readFileSync(path.join(root,file),'utf8')]));
const baseline=JSON.parse(fs.readFileSync(path.join(root,'data/style-baseline.json'),'utf8'));
const rows=Schema.schema.settings;
assert.equal(new Set(rows.map(row=>row.key)).size,rows.length,'Duplicate setting');
assert.equal(rows.filter(row=>row.key.startsWith('feature.')).length,baseline.featureIDs.length);
assert.ok(baseline.featureIDs.every(id=>rows.some(row=>row.key==='feature.'+id)),'Missing baseline switch');
const types=['Highlight','Underline','Note','Image','Text','Ink'];
function consumers(row){
 const name=row.type==='action'?row.action:row.key.replace(/^feature\./,'');
 const found=files.filter(file=>source[file].includes(name));
 if(!found.length&&types.some(type=>row.key==='marginShow'+type)&&source['src/reader-tools.js'].includes("'marginShow'+type[0].toUpperCase()"))found.push('src/reader-tools.js');
 assert.ok(found.length,'No consumer for '+row.key);return found;
}
for(const row of rows){assert.ok(Schema.schema.categories.some(category=>category.id===row.category));if(row.type!=='action')Schema.validate(row.key,row.default);consumers(row);}
assert.throws(()=>consumers({key:'missing-control-negative-proof',type:'text'}),/No consumer/);
assert.throws(()=>Schema.validate('recordIntervalMs',777));
assert.throws(()=>Schema.validate('feature.IFColumn','false'));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
const coverage={version:manifest.version,categories:Schema.schema.categories.length,persistedSettings:rows.filter(row=>row.type!=='action').length,actions:rows.filter(row=>row.type==='action').length,method:'Static consumer links plus independent DOM/backend effect regressions; source links alone do not prove native activation.',entries:rows.map(row=>({key:row.key,label:row.label,category:row.category,type:row.type,consumers:consumers(row)}))};
fs.writeFileSync(path.join(root,'docs/settings-coverage.json'),JSON.stringify(coverage,null,2)+'\n');
console.log(`Settings bindings verified: ${rows.length} rows (${coverage.persistedSettings} stored settings + ${coverage.actions} explicit actions), ${coverage.categories} categories`);

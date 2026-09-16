import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function extractFeatureIDs(source){
 return [...new Set([...source.matchAll(/\bpref\s*\(\s*["']extensions\.zotero\.zoterostyle\.function\.([A-Za-z0-9.]+)\.enable["']\s*,/g)].map(match=>match[1]))].sort();
}
export function verifyInventory(data,baseline,read=relative=>fs.readFileSync(path.join(root,relative),'utf8')){
 const expected=baseline.featureIDs,ids=data.features.map(f=>f.id);
 assert.ok(expected.length&&new Set(expected).size===expected.length,'Invalid baseline');
 assert.equal(new Set(ids).size,ids.length,'Duplicate feature');
 assert.deepEqual([...data.sourceFeatureIDs].sort(),[...expected].sort(),'Source feature IDs differ from baseline');
 assert.ok(expected.every(id=>ids.includes(id)),'Missing baseline feature');
 for(const feature of data.features){
  assert.ok(feature.status==='implemented'&&feature.entryPoint&&feature.tests.length,'Incomplete feature '+feature.id);
  for(const file of [feature.implementation.file,...feature.tests])assert.ok(path.resolve(root,file).startsWith(root+path.sep),'Invalid source/test path');
  assert.ok(read(feature.implementation.file).includes(feature.implementation.marker),'Missing implementation '+feature.id);
  for(const file of feature.tests)assert.match(read(file),/test\(/,'Missing tests '+feature.id);
 }
 return {baseline:expected.length,additional:ids.length-expected.length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const data=JSON.parse(fs.readFileSync(path.join(root,'data/features.json'),'utf8'));
 const baseline=JSON.parse(fs.readFileSync(path.join(root,'data/style-baseline.json'),'utf8'));
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
 assert.equal(data.version,manifest.version,'Feature inventory has stale version');
 if(process.argv[2]){
  assert.equal(process.argv[2],'--reference','Use --reference path/to/installed/prefs.js');
  assert.deepEqual(extractFeatureIDs(fs.readFileSync(process.argv[3],'utf8')),baseline.featureIDs,'Installed source differs from captured baseline');
 }
 const result=verifyInventory(data,baseline);
 console.log(`Feature inventory verified: ${result.baseline} baseline + ${result.additional} workflow entries`);
}

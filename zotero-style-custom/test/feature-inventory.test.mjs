import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {extractFeatureIDs,verifyInventory} from '../scripts/verify-features.mjs';

test('source feature discovery includes multi-line dotted reader features and the verifier rejects their omission',()=>{
 const source='pref("extensions.zotero.zoterostyle.function.tabManager.enable",true);\npref(\n"extensions.zotero.zoterostyle.function.reader.mergeAnnotations.enable",\ntrue);\npref("extensions.zotero.zoterostyle.function.reader.attachmentVersionSwitch.enable",true);';
 const ids=extractFeatureIDs(source);assert.deepEqual(ids,['reader.attachmentVersionSwitch','reader.mergeAnnotations','tabManager']);
 const data={sourceFeatureIDs:ids,features:ids.map(id=>({id,status:'implemented',entryPoint:'reader toolbar',implementation:{file:'src/reader-tools.js',marker:id},tests:['test/reader-tools.test.mjs']}))};
 assert.deepEqual(verifyInventory(data,{featureIDs:ids},()=>ids.join(' ')+' test('),{baseline:3,additional:0});
 const missing=structuredClone(data);missing.features=missing.features.filter(f=>!f.id.includes('.'));assert.throws(()=>verifyInventory(missing,{featureIDs:ids},()=>ids.join(' ')+' test('),/Missing baseline/);
 const stale=structuredClone(data);stale.sourceFeatureIDs=['tabManager'];assert.throws(()=>verifyInventory(stale,{featureIDs:ids},()=>''),/differ from baseline/);
});

test('captured installed baseline and current feature source/test mappings agree',()=>{
 const read=name=>JSON.parse(fs.readFileSync(new URL('../data/'+name,import.meta.url),'utf8'));
 const result=verifyInventory(read('features.json'),read('style-baseline.json'));assert.equal(result.baseline,50);assert.equal(result.additional,7);
});

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
 const result=verifyInventory(read('features.json'),read('style-baseline.json'));assert.equal(result.baseline,50);assert.equal(result.additional,28);
});

// Both ledgers sat at 0.8.0 through eight releases, which is how a completeness
// record stops recording anything. The version check lives in the scripts'
// CLI entry point, so nothing in `npm test` ever ran it. It runs here now.
test('both completeness ledgers describe the version actually being shipped', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  for (const file of ['data/features.json', 'docs/improvement-rounds.json']) {
    const ledger = JSON.parse(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
    assert.equal(ledger.version, manifest.version,
      `${file} still claims ${ledger.version}; a stale ledger records nothing`);
  }
});

test('every round in the ledger names a source marker and a test that exist', () => {
  const rounds = JSON.parse(fs.readFileSync(new URL('../docs/improvement-rounds.json', import.meta.url), 'utf8')).rounds;
  assert.ok(rounds.length >= 45);
  for (const round of rounds) {
    for (const source of round.sources) {
      assert.ok(fs.readFileSync(new URL('../' + source.file, import.meta.url), 'utf8').includes(source.marker),
        `${round.round}: ${source.file} no longer contains ${source.marker}`);
    }
    for (const spec of round.tests) {
      assert.ok(fs.readFileSync(new URL('../' + spec.file, import.meta.url), 'utf8').includes(spec.name),
        `${round.round}: ${spec.file} no longer has the test "${spec.name}"`);
    }
  }
});

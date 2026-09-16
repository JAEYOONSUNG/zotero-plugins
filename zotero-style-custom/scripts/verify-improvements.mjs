import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const data=JSON.parse(fs.readFileSync(path.join(root,'docs/improvement-rounds.json'),'utf8'));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
assert.equal(data.version,manifest.version,'Round ledger version is stale');
const read=file=>{const target=path.resolve(root,file);assert.ok(target.startsWith(root+path.sep),'Round path escapes project');return fs.readFileSync(target,'utf8');};
function validate(rounds){
 assert.ok(rounds.length>=10,'At least ten actual rounds are required');
 assert.equal(new Set(rounds.map(row=>row.round)).size,rounds.length,'Duplicate round');
 for(const row of rounds){
  assert.match(row.round,/^R\d{2}$/);assert.ok(row.status==='verified'&&row.entryPoint&&row.review,'Incomplete round '+row.round);
  assert.ok(row.sources.length&&row.tests.length,'Missing source/test evidence '+row.round);
  for(const source of row.sources)assert.ok(read(source.file).includes(source.marker),'Missing implementation '+row.round);
  for(const test of row.tests)assert.ok(read(test.file).includes('test(')&&read(test.file).includes(test.name),'Missing test '+row.round+': '+test.name);
 }
}
validate(data.rounds);
assert.throws(()=>validate(data.rounds.slice(0,9)),/At least ten/);
const broken=structuredClone(data.rounds);broken[0].tests[0].name='unimplemented-round-negative-control';assert.throws(()=>validate(broken),/Missing test/);
console.log(`Improvement rounds verified: ${data.rounds.length} distinct source/test/entry-point records; full regression execution is checked separately`);

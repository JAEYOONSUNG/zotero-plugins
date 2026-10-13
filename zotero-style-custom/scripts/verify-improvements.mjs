/* The improvement ledger (docs/improvement-rounds.json) is only worth keeping if every row still points
   at code that exists and a test that runs. This checks that, and test/improvement-rounds.test.mjs runs
   it as part of `npm test` -- without that the ledger rots quietly, which is what happened: the round-id
   pattern rejected three-digit rounds, and every row pointing at a Python test failed because the check
   for "this file holds tests" only knew node:test's `test(`. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ledger = () => JSON.parse(fs.readFileSync(path.join(root, 'docs/improvement-rounds.json'), 'utf8'));

/* How a test file says it holds tests, per language. */
const HOLDS_TESTS = [[/\.m?js$/, 'test('], [/\.py$/, 'def test_']];

export function validate(rounds, {read = file => {
  const target = path.resolve(root, file);
  assert.ok(target.startsWith(root + path.sep), 'Round path escapes project');
  return fs.readFileSync(target, 'utf8');
}} = {}) {
  assert.ok(rounds.length >= 10, 'At least ten actual rounds are required');
  assert.equal(new Set(rounds.map(row => row.round)).size, rounds.length, 'Duplicate round');
  for (const row of rounds) {
    assert.match(row.round, /^R\d{2,}$/, 'Round id ' + row.round);
    assert.ok(row.status === 'verified' && row.entryPoint && row.review, 'Incomplete round ' + row.round);
    assert.ok(row.sources.length && row.tests.length, 'Missing source/test evidence ' + row.round);
    for (const source of row.sources) assert.ok(read(source.file).includes(source.marker), 'Missing implementation ' + row.round + ': ' + source.marker);
    for (const test of row.tests) {
      const body = read(test.file);
      const mark = (HOLDS_TESTS.find(([pattern]) => pattern.test(test.file)) || [null, 'test('])[1];
      assert.ok(body.includes(mark), 'Not a test file ' + row.round + ': ' + test.file);
      assert.ok(body.includes(test.name), 'Missing test ' + row.round + ': ' + test.name);
    }
  }
  return rounds.length;
}

export function verify() {
  const data = ledger();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(data.version, manifest.version, 'Round ledger version is stale');
  return validate(data.rounds);
}

const isMain = (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch (_) { return false; } })();
if (isMain) console.log(`Improvement rounds verified: ${verify()} distinct source/test/entry-point records; full regression execution is checked separately`);

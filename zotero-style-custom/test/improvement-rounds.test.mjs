import test from 'node:test';
import assert from 'node:assert/strict';
import {validate, verify, ledger, root} from '../scripts/verify-improvements.mjs';

/* The ledger is a record of what was improved and how it was checked. It was last whole at R78: after
   that the verifier threw on every run, so nothing it says was being checked and a row could point at a
   test that had been renamed away. It threw for two reasons of its own -- a round-id pattern that only
   allowed two digits, and a "does this file hold tests" check that only knew node:test -- and because
   it was never part of `npm test`, nobody saw it. It is part of it now. */

test('every round still points at code that is there and a test that runs', () => {
  const n = verify();
  assert.ok(n >= 158, `the ledger lost rounds: ${n}`);
  assert.equal(ledger().rounds.at(-1).round, 'R' + (n + 0), 'the last round is numbered for its position');
});

test('three-digit rounds are rounds, and a Python test counts as a test', () => {
  const rows = ledger().rounds;
  assert.ok(rows.some(r => /^R\d{3}$/.test(r.round)), 'there are rounds past R99');
  const python = rows.flatMap(r => r.tests).filter(t => t.file.endsWith('.py'));
  assert.ok(python.length, 'some rounds are backed by the Python tests');
  // Both were silently fatal before: the id pattern, and the JS-only mark.
  assert.doesNotThrow(() => validate([{
    round: 'R999', status: 'verified', entryPoint: 'x', review: 'x',
    sources: [{file: 'manifest.json', marker: '"version"'}],
    tests: [{file: 'test/install_background_test.py', name: 'def test_'}]
  }, ...ledger().rounds.slice(0, 9)]));
});

test('the verifier refuses a round whose evidence has gone', () => {
  const good = ledger().rounds;
  const noSource = structuredClone(good); noSource[0].sources[0].marker = 'a marker that is not in the file';
  assert.throws(() => validate(noSource), /Missing implementation/);
  const noTest = structuredClone(good); noTest[0].tests[0].name = 'a test that was renamed away';
  assert.throws(() => validate(noTest), /Missing test/);
  const notATest = structuredClone(good); notATest[0].tests[0].file = 'manifest.json';
  assert.throws(() => validate(notATest), /Not a test file/);
  const half = structuredClone(good); half[0].status = 'implemented';
  assert.throws(() => validate(half), /Incomplete round/);
  assert.throws(() => validate(good.slice(0, 9)), /At least ten/);
  // A path outside the project is never read.
  assert.throws(() => validate([{...good[0], round: 'R998', sources: [{file: '../../etc/hosts', marker: 'x'}]}, ...good.slice(0, 9)]), /escapes project/);
});

test('every round is numbered once, in order, and says where to find what it changed', () => {
  const rows = ledger().rounds;
  const numbers = rows.map(r => Number(r.round.slice(1)));
  assert.deepEqual(numbers, numbers.slice().sort((a, b) => a - b), 'rounds are in order');
  assert.equal(new Set(numbers).size, numbers.length);
  for (const row of rows) {
    assert.ok(row.title && row.gap, `R${row.round} says what it is`);
    assert.ok(row.entryPoint.trim().length > 1, `${row.round} says where to find it`);
  }
  assert.ok(root.endsWith('zotero-style-custom'));
});

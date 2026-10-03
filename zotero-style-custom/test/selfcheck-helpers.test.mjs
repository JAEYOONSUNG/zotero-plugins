import test from 'node:test';
import assert from 'node:assert/strict';
import SelfCheck from '../src/selfcheck.js';
import Journals from '../src/journals.js';

const rec = (title, impactFactor, authority, extra = {}) => ({
  title, aliases: [], issns: [], impactFactor, year: 2024, authority,
  sourceURL: 'https://www.cell.com/x', checkedAt: '2026-01-01', ...extra
});

test('JCR figures win over publisher-page records of the same title', () => {
  const catalog = [rec('Cell', 45.1, 'jcr'), rec('Cell', 64.5, undefined, {year: 2025}), rec('Only Page', 3, undefined)];
  const out = SelfCheck.jcrPrecedence(catalog, Journals.create, Journals.name);
  assert.equal(out.both, 1);
  assert.deepEqual(out.wins, ['Cell 45.1 (JCR)']);
  assert.deepEqual(out.losses, []);
});

test('a lookup that returns the publisher figure is reported as a loss', () => {
  const catalog = [rec('Cell', 45.1, 'jcr'), rec('Cell', 64.5, undefined)];
  const out = SelfCheck.jcrPrecedence(catalog, () => ({lookup: () => catalog[1]}), Journals.name);
  assert.equal(out.losses.length, 1);
});

test('status contradicting an explicit /unread tag is found', () => {
  const rows = [
    {id: 1, tags: [{tag: '/unread'}], status: 'reading'},
    {id: 2, tags: ['/unread'], status: 'unread'},
    {id: 3, tags: ['/unread', '/done'], status: 'done'},
    {id: 4, tags: [], status: 'reading'}
  ];
  assert.deepEqual(SelfCheck.statusContradictions(rows), [1]);
});

test('works listing a person twice are counted', () => {
  const works = [
    {people: [{id: 'A1', name: 'Kim'}, {id: 'A1', name: 'Kim'}]},
    {people: [{name: 'Lee, J.'}, {name: 'lee j'}]},
    {people: [{id: 'A1'}, {id: 'A2'}]}, {}
  ];
  assert.equal(SelfCheck.worksWithDuplicatePeople(works), 2);
});

test('missingMembers names what the target lacks', () => {
  assert.deepEqual(SelfCheck.missingMembers({a() {}}, ['a', 'b']), ['b']);
  assert.deepEqual(SelfCheck.missingMembers(null, ['a']), ['a']);
});

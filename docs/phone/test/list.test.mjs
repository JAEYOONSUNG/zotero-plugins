/* Finding a paper in a library of a few thousand, and putting them in the order asked for. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fold, haystack, words, matches, sortRows, filterRows, usefulTags, SORTS} from '../list.js';

const paper = (over = {}) => ({key: over.key || 'K', version: 1, data: {
  itemType: 'journalArticle', title: 'A paper', date: '2024', dateAdded: '2024-01-01T00:00:00Z',
  dateModified: '2024-01-01T00:00:00Z', creators: [], tags: [], collections: [], extra: '', ...over}});
const statusOf = item => (item.data.tags || []).map(t => ({'/unread': 'unread', '/reading': 'reading', '/done': 'done'}[t.tag])).find(Boolean) || '';

const LIB = [
  paper({key: 'A', title: 'Landscape of PET depolymerases', date: '2026-03-02', dateAdded: '2026-03-01T00:00:00Z',
    publicationTitle: 'Science', creators: [{lastName: 'Müller', firstName: 'Jan'}], tags: [{tag: 'plastic'}, {tag: '/reading'}],
    collections: ['C1'], extra: 'Rating: 5'}),
  paper({key: 'B', title: '세균의 방어 기작', date: '2019', dateAdded: '2026-01-01T00:00:00Z',
    publicationTitle: 'Nature', creators: [{lastName: '성', firstName: '재윤'}], tags: [{tag: 'phage'}, {tag: '/done'}],
    collections: ['C1'], extra: 'Rating: 3'}),
  paper({key: 'C', title: 'Zinc fingers', date: '2001', dateAdded: '2026-02-01T00:00:00Z',
    creators: [{lastName: 'Seo', firstName: 'H'}], tags: [{tag: 'plastic'}], collections: [], extra: ''})
];

test('a search folds accents and case, so Muller finds Müller', () => {
  assert.equal(fold('MÜLLER'), 'muller');
  assert.ok(matches(LIB[0], words('muller')));
  assert.ok(matches(LIB[0], words('MÜLLER')));
});

test('every word has to appear, so more words narrow the result', () => {
  assert.ok(matches(LIB[0], words('pet science 2026')));
  assert.ok(!matches(LIB[0], words('pet nature')));
  assert.deepEqual(words('  "phage defence"  seo '), ['phage defence', 'seo']);
});

test('Korean is searched as it is typed', () => {
  assert.ok(matches(LIB[1], words('방어')));
  assert.ok(matches(LIB[1], words('성재윤'.slice(0, 1))));
});

test('the text a paper is searched by is built once and kept with it', () => {
  const first = haystack(LIB[0]);
  assert.equal(haystack(LIB[0]), first);
  const changed = {...LIB[0], data: {...LIB[0].data, title: 'Something else'}};
  assert.notEqual(haystack(changed), first, 'a changed paper is searched afresh');
});

test('each order does what it says, and ties fall back to the newest addition', () => {
  assert.deepEqual(sortRows(LIB, 'added').map(p => p.key), ['A', 'C', 'B']);
  assert.deepEqual(sortRows(LIB, 'year').map(p => p.key), ['A', 'B', 'C']);
  assert.deepEqual(sortRows(LIB, 'rating').map(p => p.key), ['A', 'B', 'C']);
  // Korean collation puts Hangul before the Latin alphabet; that is the order a Korean reader expects.
  assert.deepEqual(sortRows(LIB, 'title').map(p => p.key), ['B', 'A', 'C']);
  assert.equal(SORTS.length, 5);
});

test('sorting never rearranges the library itself', () => {
  const before = LIB.map(p => p.key);
  sortRows(LIB, 'title');
  assert.deepEqual(LIB.map(p => p.key), before);
});

test('a collection, a status, a tag and a search narrow together', () => {
  const only = over => filterRows(LIB, {statusOf, ...over}).map(p => p.key);
  assert.deepEqual(only({}), ['A', 'B', 'C']);
  assert.deepEqual(only({collection: 'C1'}), ['A', 'B']);
  assert.deepEqual(only({status: 'done'}), ['B']);
  assert.deepEqual(only({tag: 'plastic'}), ['A', 'C']);
  assert.deepEqual(only({tag: 'plastic', q: 'zinc'}), ['C']);
  assert.deepEqual(only({collection: 'C1', status: 'reading', q: 'pet'}), ['A']);
});

test('the tags offered are the ones in use, commonest first, without the plumbing', () => {
  const tags = usefulTags([...LIB, paper({key: 'D', tags: [{tag: 'plastic'}, {tag: 'style-custom:seen'}, {tag: '/unread'}]})]);
  assert.deepEqual(tags.map(t => t.tag), ['plastic', 'phage']);
  assert.equal(tags[0].n, 3);
});

test('nothing in, nothing out, and no crash', () => {
  assert.deepEqual(filterRows([], {statusOf}), []);
  assert.deepEqual(sortRows([], 'year'), []);
  assert.deepEqual(words(''), []);
  assert.equal(fold(null), '');
});

/* Finding a paper in a library of a few thousand, and putting them in the order asked for. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fold, haystack, words, matches, sortRows, filterRows, usefulTags, familyOf, SORTS,
        groupOf, dayName, initialOf} from '../list.js';

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
  assert.equal(SORTS.length, 6);
  // Papers opened lately come first; the ones never opened keep the order they were added in.
  const seen = {A: 0, B: 500, C: 100};
  assert.deepEqual(sortRows(LIB, 'seen', {seenAt: key => seen[key]}).map(p => p.key), ['B', 'C', 'A']);
  assert.deepEqual(sortRows(LIB, 'seen').map(p => p.key), ['A', 'C', 'B'], 'with none opened it is the order they arrived');
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

/* Zotero nests collections, and a paper sits in the one it was filed in, not in its parents. */
const TREE = [
  {key: 'root', data: {name: 'Defence', parentCollection: false}},
  {key: 'kid', data: {name: 'CRISPR', parentCollection: 'root'}},
  {key: 'grandkid', data: {name: 'Type III', parentCollection: 'kid'}},
  {key: 'other', data: {name: 'Enzymes', parentCollection: false}}
];

test('picking a collection takes everything filed under it too', () => {
  assert.deepEqual([...familyOf(TREE, 'root')].sort(), ['grandkid', 'kid', 'root']);
  assert.deepEqual([...familyOf(TREE, 'kid')].sort(), ['grandkid', 'kid']);
  assert.deepEqual([...familyOf(TREE, 'other')], ['other']);
  assert.equal(familyOf(TREE, '').size, 0, 'picking nothing narrows nothing');
});

test('a collection filed inside itself does not become a loop', () => {
  const bent = [{key: 'a', data: {parentCollection: 'b'}}, {key: 'b', data: {parentCollection: 'a'}}];
  assert.deepEqual([...familyOf(bent, 'a')].sort(), ['a', 'b']);
});

test('a paper in a sub-collection shows under its parent', () => {
  const deep = [paper({key: 'X', collections: ['grandkid']}), paper({key: 'Y', collections: ['other']})];
  const under = key => filterRows(deep, {collections: familyOf(TREE, key), statusOf}).map(p => p.key);
  assert.deepEqual(under('root'), ['X']);
  assert.deepEqual(under('kid'), ['X']);
  assert.deepEqual(under('other'), ['Y']);
});

test('the abstract is searched too, which is where the words usually are', () => {
  const one = paper({key: 'Z', title: 'A short title', abstractNote: 'We show that the thermophile degrades lignin.'});
  assert.ok(matches(one, words('thermophile lignin')));
  assert.ok(!matches(one, words('mesophile')));
});

/* ---------- the headings a long list is walked by ---------- */
/* Local time throughout, because a phone in Seoul decides what "yesterday" means by the clock on
   the phone, not by UTC. */
const NOW = Date.parse('2026-10-13T09:00:00');

test('a date gets the name a reader would give it', () => {
  const name = local => dayName(Date.parse(local), NOW);
  assert.equal(name('2026-10-13T01:00:00'), '오늘');
  assert.equal(name('2026-10-12T23:00:00'), '어제');
  assert.equal(name('2026-10-09T10:00:00'), '이번 주');
  assert.equal(name('2026-10-02T10:00:00'), '이번 달');
  assert.equal(name('2026-07-02T10:00:00'), '7월', 'this year needs no year on it');
  assert.equal(name('2024-11-02T10:00:00'), '2024년 11월');
  assert.equal(dayName(0, NOW), '', 'nothing has no name');
  assert.equal(dayName(Date.parse('nonsense'), NOW), '');
});

test('the heading over a paper follows the order the list is in', () => {
  const one = paper({title: 'Landscape of PET depolymerases', date: '2026', dateAdded: '2026-03-15T10:00:00',
    extra: 'Rating: 5'});
  assert.equal(groupOf(one, 'added', {now: NOW}), '3월');
  assert.equal(groupOf(one, 'year', {now: NOW}), '2026년');
  assert.equal(groupOf(one, 'rating', {now: NOW}), '★★★★★');
  assert.equal(groupOf(paper({extra: ''}), 'rating', {now: NOW}), '별점 없음');
  assert.equal(groupOf(one, 'title', {now: NOW}), 'L');
  assert.equal(groupOf(paper({title: '세균의 방어 기작'}), 'title', {now: NOW}), 'ㅅ', 'Hangul is filed under its leading consonant');
  assert.equal(groupOf(one, 'seen', {now: NOW}), '아직 안 봄');
  assert.equal(groupOf(one, 'seen', {now: NOW, seenAt: () => NOW - 3600e3}), '오늘');
  assert.equal(groupOf(paper({date: ''}), 'year', {now: NOW}), '연도 모름');
  assert.equal(groupOf(paper({dateAdded: ''}), 'added', {now: NOW}), '날짜 모름');
  assert.equal(groupOf(paper({dateModified: '2026-10-13T08:00:00'}), 'modified', {now: NOW}), '오늘');
});

test('a title is filed under a letter however it is written', () => {
  assert.equal(initialOf('Übermensch'), 'U');
  assert.equal(initialOf('  spaced'), 'S');
  assert.equal(initialOf('3D printing'), '#');
  assert.equal(initialOf('(bracketed)'), '#');
  assert.equal(initialOf(''), '#');
  assert.equal(initialOf(null), '#');
  assert.equal(initialOf('까치'), 'ㄲ');
});

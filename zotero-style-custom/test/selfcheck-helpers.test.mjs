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
  assert.deepEqual(SelfCheck.statusContradictions(rows), [1, 3], 'row 3 carries two status tags');
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

test('an item with more than one status tag is a contradiction, whatever status it shows (Z2U3ZAFK)', () => {
  const rows = [{id: 'Z2U3ZAFK', tags: ['/unread', '/reading', '/done'], status: 'done'},
    {id: 'ok', tags: ['/done'], status: 'done'}];
  assert.deepEqual(SelfCheck.statusContradictions(rows), ['Z2U3ZAFK']);
});

test('an automatic /unread tag over recorded reading time is not a contradiction; a manual one is', () => {
  const rows = [
    {id: 'auto', tags: [{tag: '/unread', type: 1}], seconds: 5920, status: 'reading'},
    {id: 'manual', tags: [{tag: '/unread', type: 0}], seconds: 5920, status: 'reading'},
    {id: 'noTime', tags: [{tag: '/unread', type: 1}], seconds: 0, status: 'reading'}];
  assert.deepEqual(SelfCheck.statusContradictions(rows), ['manual', 'noTime']);
});

test('rating tags on standalone attachments are reported (2LSGZGCV, GJT28FRB)', () => {
  const rows = [
    {id: 1, key: '2LSGZGCV', regular: false, hasParent: false, tags: [{tag: 'style-custom:rating:4'}]},
    {id: 2, key: 'child', regular: false, hasParent: true, tags: ['style-custom:rating:2']},
    {id: 3, key: 'paper', regular: true, hasParent: false, tags: ['style-custom:rating:2']},
    {id: 4, key: 'GJT28FRB', regular: false, hasParent: false, tags: ['style-custom:rating:5', 'x']},
    {id: 5, key: 'clean', regular: false, hasParent: false, tags: ['x']}];
  assert.deepEqual(SelfCheck.orphanRatingTags(rows), ['2LSGZGCV', 'GJT28FRB']);
});

test('followed rows with news but no placesSeen were never classified', () => {
  const rows = [{id: 'A1', name: 'Huimin Zhao', news: [{id: 'W1'}]}, {id: 'A2', name: 'Ok', news: [{id: 'W2'}], placesSeen: []},
    {id: 'A3', name: 'Quiet', news: []}];
  assert.deepEqual(SelfCheck.newsWithoutClassification(rows), ['Huimin Zhao']);
});

test('duplicate news in a row is counted using the real dedupe rule', () => {
  const dedupe = list => list.filter((w, i) => list.findIndex(x => x.id === w.id) === i);
  const rows = [{name: 'Elowitz', news: [{id: 'W1'}, {id: 'W1'}]}, {name: 'Ok', news: [{id: 'W2'}]}];
  assert.deepEqual(SelfCheck.rowsWithDuplicateNews(rows, dedupe), ['Elowitz']);
});

test('corresponding-author duplicates are a failure, not a note', () => {
  assert.throws(() => SelfCheck.requireNoDuplicatePeople([{people: [{id: 'A'}, {id: 'A'}]}, {people: [{id: 'B'}]}]), /1편/);
  assert.equal(SelfCheck.requireNoDuplicatePeople([{people: [{id: 'B'}]}]), '중복 저자 목록이 남은 논문 0편 / 1편');
});

test('stored rows whose paper is trashed or gone are listed', () => {
  assert.deepEqual(SelfCheck.staleRows(['1:A', '1:B', '1:C'], key => key === '1:B'), ['1:A', '1:C']);
});

test('planCoverage names the columns whose context menu offers nothing, and never runs an entry', () => {
  let ran = 0;
  const plan = ({key}) => key === 'bare' ? [] : [{label: key + ' action', run: () => { ran++; }}];
  const out = SelfCheck.planCoverage(['journalMark', 'bare', 'status'], plan);
  assert.deepEqual(out.empty, ['bare']);
  assert.equal(out.total, 2);
  assert.equal(ran, 0);
  assert.deepEqual(SelfCheck.planCoverage(['x'], () => [{separator: true}]).empty, ['x'], 'a separator is not an action');
  assert.deepEqual(SelfCheck.planCoverage(['x'], () => { throw new Error('boom'); }).failed, ['x: boom']);
});

test('moreButtonProblems wants a button that declares what it opens, and a tooltip', () => {
  const button = {tagName: 'BUTTON', getAttribute: name => ({'data-opens': 'menu', 'aria-label': 'More'}[name]), title: 'More', textContent: '⋯'};
  const cell = {querySelector: selector => selector === 'button' ? button : null};
  assert.deepEqual(SelfCheck.moreButtonProblems(cell), []);
  button.getAttribute = () => null;
  assert.match(SelfCheck.moreButtonProblems(cell).join(' '), /data-opens/);
  assert.match(SelfCheck.moreButtonProblems({querySelector: () => null}).join(' '), /no button/);
});

// Regression review A6: a view press that saves must fail the sweep, and never actually save.
function fakeSweep({press}) {
  const real = {flushed: 0, written: 0, opened: 0};
  const runtime = {cache: {workbenchUI: {}}, dirty: false,
    flush: async () => { real.flushed++; }, edit: async () => { real.written++; },
    storage: {write: async () => { real.written++; }},
    libraryService: {openItem: async () => { real.opened++; }, getItem: async () => 'item', trashItems: async () => { real.written++; }}};
  const button = {textContent: 'Press me', disabled: false, hidden: false, isConnected: true, getAttribute: name => name === 'data-safe' ? 'view' : null, click: () => press(runtime)};
  const panel = {querySelectorAll: () => [button], querySelector: () => null};
  const bench = {panel, state: {tab: 'one'}, show: async tab => { bench.state.tab = tab; }, toggle: async () => {}};
  return {real, runtime, bench};
}

test('the sweep fails a press that saves, writes or opens, and the spy swallows the call', async () => {
  for (const [label, press] of [['flush', r => r.flush()], ['edit', r => r.edit()], ['storage.write', r => r.storage.write()], ['openItem', r => r.libraryService.openItem(1)], ['trashItems', r => r.libraryService.trashItems([1])]]) {
    const {real, runtime, bench} = fakeSweep({press});
    const out = await SelfCheck.sweepSafeButtons({bench, runtime, tabs: ['one'], wait: async () => {}});
    assert.equal(out.pressed, 1, label);
    assert.ok(out.broken.some(line => line.includes(label.split('.').pop())), label + ' is reported: ' + JSON.stringify(out.broken));
    assert.deepEqual(real, {flushed: 0, written: 0, opened: 0}, label + ' never reached the real path');
  }
});

test('a view press that only reads passes, and the real paths are back afterwards', async () => {
  const {real, runtime, bench} = fakeSweep({press: r => r.libraryService.getItem(1)});
  const flush = runtime.flush, open = runtime.libraryService.openItem;
  const out = await SelfCheck.sweepSafeButtons({bench, runtime, tabs: ['one'], wait: async () => {}});
  assert.deepEqual(out.broken, []);
  assert.equal(runtime.flush, flush, 'the real flush is restored');
  assert.equal(runtime.libraryService.openItem, open);
  await runtime.flush();
  assert.equal(real.flushed, 1);
});

test('a flush that happens outside a press (a timer) passes through untouched', async () => {
  const {real, runtime, bench} = fakeSweep({press: () => {}});
  bench.show = async tab => { bench.state.tab = tab; await runtime.flush(); };
  const out = await SelfCheck.sweepSafeButtons({bench, runtime, tabs: ['one'], wait: async () => {}});
  assert.deepEqual(out.broken, []);
  assert.equal(real.flushed, 1, 'a background write between presses is not blamed on a button');
});

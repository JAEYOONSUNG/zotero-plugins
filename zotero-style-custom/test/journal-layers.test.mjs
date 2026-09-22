/* Journal figures arrive in two layers: the openly licensed archive the plugin
   ships, and a folder in the Zotero data directory holding whatever a reader's
   own institution licenses to them. Nothing from that folder is packaged or
   published, and the figures in it win wherever they exist.

   These cover the part the reader sees: the settings row that says which layer
   each table came from, the button that reveals the folder without a sweep
   pressing it, and the self-check line that makes the numbers traceable. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseHTML} from 'linkedom';
import Runtime from '../src/runtime.js';
import Model from '../src/data.js';
import Settings from '../src/settings.js';
import Schema from '../src/settings-schema.js';
import SelfCheck from '../src/selfcheck.js';

const CATALOG = [
  {title: 'Journal of Fixtures', aliases: ['J FIXTURES'], issns: ['0000-0019'], impactFactor: 12.5,
   year: 2025, sourceURL: 'https://jcr.clarivate.com/jcr/home', checkedAt: '2026-06-18', authority: 'jcr'},
  {title: 'Quarterly of Nothing', aliases: [], issns: ['1234-5679'], impactFactor: 1.25,
   year: 2025, sourceURL: 'https://jcr.clarivate.com/jcr/home', checkedAt: '2026-06-18', authority: 'jcr'}
];

function fixture({layers = {}, dir = '/fixture/style-custom-journals', catalog = CATALOG} = {}) {
  const prefs = new Map(), columns = new Map(), items = new Map(), revealed = [], launched = [], made = [];
  const Z = {
    locale: 'ko-KR',
    Prefs: {get: key => prefs.get(key), set: (key, value) => prefs.set(key, value), registerObserver: () => 1, unregisterObserver() {}},
    Libraries: {userLibraryID: 1, get: () => ({editable: true, libraryType: 'user'})},
    Items: {get: id => items.get(id), getAsync: async id => items.get(id)},
    Reader: {_readers: []},
    ItemTreeManager: {registerColumn: option => { columns.set(option.dataKey, option); return option.dataKey; }, unregisterColumn: key => columns.delete(key)},
    PreferencePanes: {register: async option => { Z.pane = option; return 'settings'; }, unregister() {}},
    DataDirectory: {dir: '/fixture'},
    File: {reveal: async path => { revealed.push(path); }},
    launchFile: path => launched.push(path),
    getMainWindow: () => null, logError() {}, debug() {}
  };
  const io = {makeDirectory: async (path, options) => { made.push([path, options]); }, stat: async () => { throw new Error('no such file'); }};
  const runtime = new Runtime({Zotero: Z, model: Model, marquee: {attach: () => () => {}}, reading: {attach: () => () => {}},
    storage: {read: async () => ({schema: 1, items: {}}), write: async () => {}}, catalog, io});
  runtime.journalLayers = layers;
  runtime.journalDir = dir;
  runtime.journalIdentity.loadRegistry({subjects: [], journals: [{title: 'Journal of Fixtures'}, {title: 'Quarterly of Nothing'}, {title: 'Third Title'}]});
  runtime.jcrCatalog = {journals: [{key: 'a'}, {key: 'b'}, {key: 'c'}, {key: 'd'}]};
  return {runtime, Z, io, revealed, launched, made, columns,
    start: () => runtime.start({id: 'style-custom@sungjaeyoon.dev', version: '0.52.0', rootURI: 'file:///plugin/'})};
}

test('the runtime says, per table, whether the figures came from the reader\'s folder or the archive', () => {
  const f = fixture({layers: {'if-catalog.json': 'local', 'journal-registry.json': 'shipped', 'jcr-categories.json': 'shipped'}});
  const report = f.runtime.journalFigureLayers();
  assert.equal(report.dir, '/fixture/style-custom-journals');
  assert.deepEqual(report.tables, [
    {file: 'if-catalog.json', layer: 'local', count: 2},
    {file: 'journal-registry.json', layer: 'shipped', count: 3},
    {file: 'jcr-categories.json', layer: 'shipped', count: 4}
  ]);
  // A table the runtime never recorded reads as unread rather than as shipped:
  // saying "shipped" about a table nobody loaded would be an invented status.
  const silent = fixture({layers: {}});
  assert.deepEqual(silent.runtime.journalFigureLayers().tables.map(row => row.layer), [null, null, null]);
});

test('the settings note names each table, its layer and the folder, and is never written', async () => {
  const f = fixture({layers: {'if-catalog.json': 'local', 'journal-registry.json': 'local', 'jcr-categories.json': 'shipped'}});
  await f.start();
  const said = f.runtime.getSetting('journalFigureLayers');
  assert.match(said, /if-catalog\.json 내 폴더/);
  assert.match(said, /journal-registry\.json 내 폴더/);
  assert.match(said, /jcr-categories\.json 배포본/);
  assert.match(said, /폴더 \/fixture\/style-custom-journals/);
  // Read-only: it is what the runtime found, not a stored preference. Writing
  // it is refused, and restoring the category's defaults leaves it alone.
  await assert.rejects(f.runtime.setSetting('journalFigureLayers', 'anything'), /Unknown setting/);
  const result = await f.runtime.resetSettings('metrics');
  assert.equal(f.runtime.getSetting('journalFigureLayers'), said, 'a reset cannot blank what was read from disk');
  assert.ok(result.reset > 0);
  await f.runtime.stop();
});

test('the pane draws the note read-only and explains that licensed figures are never packaged', async () => {
  const f = fixture({layers: {'if-catalog.json': 'local', 'journal-registry.json': 'shipped', 'jcr-categories.json': 'shipped'}});
  await f.start();
  const {document, window} = parseHTML('<html><body><div id="style-custom-settings-root"></div></body></html>');
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {configurable: true, get() { return this._value ?? this.querySelector('option')?.value ?? ''; }, set(value) { this._value = String(value); }});
  const pane = Settings.mount({document, runtime: f.runtime});
  await pane.ready;
  const row = document.querySelector('[data-setting="journalFigureLayers"]');
  assert.ok(row, 'the note has a row of its own');
  assert.equal(row.dataset.type, 'note');
  assert.equal(row.querySelector('input, select, textarea'), null, 'nothing in it can be typed into');
  assert.match(row.querySelector('output').textContent, /if-catalog\.json 내 폴더/);
  assert.match(row.querySelector('output').textContent, /폴더 \/fixture\/style-custom-journals/);
  assert.match(row.querySelector('.scs-help').textContent, /배포본에 넣거나 공개하지 않습니다/);
  pane.destroy();
  await f.runtime.stop();
});

test('the button that reveals the folder says it opens something, so the self-check leaves it alone', async () => {
  /* The running self-check presses buttons. One that opens a file manager is
     a window on the reader's screen, which is the thing this plugin must not
     do, so it carries data-opens and the sweep skips it. */
  const f = fixture();
  await f.start();
  const {document, window} = parseHTML('<html><body><div id="style-custom-settings-root"></div></body></html>');
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {configurable: true, get() { return this._value ?? this.querySelector('option')?.value ?? ''; }, set(value) { this._value = String(value); }});
  const pane = Settings.mount({document, runtime: f.runtime});
  await pane.ready;
  const button = document.querySelector('[data-setting="open-journal-folder"] button');
  assert.ok(button);
  assert.equal(button.getAttribute('data-opens'), 'external');
  assert.equal(Schema.schema.settings.find(row => row.key === 'open-journal-folder').opens, 'external');
  // No other action in the pane opens anything outside Zotero, so none of the
  // rest may claim the marker and be skipped for free.
  const marked = [...document.querySelectorAll('[data-setting] button[data-opens]')].map(b => b.closest('[data-setting]').dataset.setting);
  assert.deepEqual(marked, ['open-journal-folder']);
  pane.destroy();
  await f.runtime.stop();
});

test('the reveal makes the folder if it is missing and falls back when Zotero cannot reveal', async () => {
  const f = fixture();
  await f.start();
  const answer = await f.runtime.runSettingAction('journalFolder');
  assert.deepEqual(f.made, [['/fixture/style-custom-journals', {ignoreExisting: true, createAncestors: true}]]);
  assert.deepEqual(f.revealed, ['/fixture/style-custom-journals']);
  assert.match(answer, /파일 관리자/);
  // It works with no library window open: nothing about a folder needs one.
  assert.equal(f.Z.getMainWindow(), null);
  delete f.Z.File;
  await f.runtime.runSettingAction('journalFolder');
  assert.deepEqual(f.launched, ['/fixture/style-custom-journals']);
  delete f.Z.launchFile;
  f.runtime.journalDir = '';
  await assert.rejects(f.runtime.runSettingAction('journalFolder'), /다시 시작하세요/);
  await f.runtime.stop();
});

test('the self-check line lets a reader tell their own figures from the shipped ones', async () => {
  const f = fixture({layers: {'if-catalog.json': 'local', 'journal-registry.json': 'shipped', 'jcr-categories.json': 'shipped'}});
  const said = await SelfCheck.journalLayerReport(f.runtime, {io: f.io, join: (a, b) => a + '/' + b});
  assert.match(said, /폴더 \/fixture\/style-custom-journals/);
  assert.match(said, /if-catalog\.json: 내 폴더 · 2건/);
  assert.match(said, /journal-registry\.json: 배포본 · 3건/);
  assert.match(said, /jcr-categories\.json: 배포본 · 4건/);
  // The named record with its figure is what makes the line checkable: the
  // reader finds that journal in the IF column and sees the same number.
  assert.match(said, /최고 Journal of Fixtures 12\.5/);
  assert.match(said, /authority jcr/);

  // The file's own date and size, when the figures are the reader's own.
  const dated = fixture({layers: {'if-catalog.json': 'local', 'journal-registry.json': 'shipped', 'jcr-categories.json': 'shipped'}});
  const io = {stat: async path => ({lastModified: Date.parse('2026-09-01T00:00:00Z'), size: 4096, path})};
  const withDate = await SelfCheck.journalLayerReport(dated.runtime, {io, join: (a, b) => a + '/' + b});
  assert.match(withDate, /if-catalog\.json: 내 폴더 · 2건 · 2026-09-01 · 4KB/);
  assert.doesNotMatch(withDate, /journal-registry\.json: 배포본 · 3건 · 2026/, 'a shipped table has no file of the reader\'s to date');

  // Nothing loaded at all is a failure, not a quiet zero.
  const empty = fixture({layers: {}, catalog: []});
  await assert.rejects(SelfCheck.journalLayerReport(empty.runtime, {}), /no journal figures loaded/);
});

test('the self-check item is registered, reports both layers and opens nothing', () => {
  const source = fs.readFileSync(new URL('../src/selfcheck.js', import.meta.url), 'utf8');
  const at = source.indexOf('journalLayerReport(runtime, {io:');
  assert.ok(at > 0, 'the check is wired into the run, not just exported');
  const call = source.slice(Math.max(0, at - 400), at + 200);
  assert.match(call, /results\.push\(await attempt\(/, 'it is one of the reported items');
  // The whole helper must stay read-only: revealing, launching or opening
  // anything from a check that runs on every install is how windows stack up.
  const body = source.slice(source.indexOf('async function journalLayerReport'), source.indexOf('async function run('));
  for (const forbidden of ['launchURL', 'launchFile', 'reveal', 'openItem', 'openDialog', 'openWindow', 'saveTx']) {
    assert.ok(!body.includes(forbidden), `the journal layer check must not call ${forbidden}`);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {parseHTML} from 'linkedom';
import I18N from '../src/i18n.js';
import Strings from '../src/strings.js';
import ReaderAssist from '../src/reader-assist.js';
import SelfCheck from '../src/selfcheck.js';
import Live from '../src/selfcheck-reader.js';
const require = createRequire(import.meta.url);
const PT = require('../src/paper-text.js');
I18N.load(Strings.en); I18N.use('en-US');

const R = (left, top, width, height) => Live.toRect({left, top, width, height});
const fast = () => Promise.resolve();
const never = () => new Promise(() => {});
const realSetTimeout = globalThis.setTimeout.bind(globalThis), realClearTimeout = globalThis.clearTimeout.bind(globalThis);
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

/* ---- the pure measuring helpers ---------------------------------------- */

test('contrast: black on white is 21:1, translucent text is judged over what is behind it', () => {
  assert.equal(Math.round(Live.contrastRatio([0, 0, 0], [255, 255, 255])), 21);
  assert.deepEqual(Live.parseColor('rgba(10, 20, 30, 50%)'), [10, 20, 30, 0.5]);
  const grey = Live.textContrast([0, 0, 0, 0.3], [255, 255, 255]);
  assert.ok(grey < 4.5, 'black at 30% on white is too light');
  assert.ok(Live.textContrast([0, 0, 0, 1], [255, 255, 255]) > 20);
  // a translucent dark card over white composes to a mid grey; the nearest opaque layer stops the walk
  assert.deepEqual(Live.backdrop([[0, 0, 0, 0.5], [255, 255, 255, 1], [255, 0, 0, 1]]), [127.5, 127.5, 127.5]);
  assert.deepEqual(Live.backdrop([], [30, 30, 30]), [30, 30, 30]);
});

test('rectangles: overlap, beside-not-under, one row and overflow are measured, not guessed', () => {
  const view = R(0, 0, 800, 600), panel = R(800, 0, 372, 600), under = R(0, 0, 1172, 600);
  assert.equal(Live.besideNotUnder(view, panel), true);
  assert.equal(Live.besideNotUnder(under, panel), false);
  assert.equal(Live.overlapRatio(panel, under), 1, 'the whole panel lies over a PDF view that was not narrowed');
  assert.equal(Live.overlapRatio(panel, view), 0);
  assert.equal(Live.oneRow([R(0, 10, 20, 20), R(30, 11, 20, 18)]), true);
  assert.equal(Live.oneRow([R(0, 10, 20, 20), R(0, 40, 20, 20)]), false, 'a second line is a wrap');
  assert.deepEqual(Live.overflowing([{label: 'a', rect: R(10, 0, 50, 10)}, {label: 'b', rect: R(90, 0, 30, 10)}], R(0, 0, 100, 10)), ['b by 20px']);
  assert.equal(Live.within(R(10, 10, 5, 5), R(0, 0, 100, 100)), true);
  assert.equal(Live.within(R(98, 10, 5, 5), R(0, 0, 100, 100)), false);
});

test('the follow-along mark agrees with the text layer only when it sits on that sentence', () => {
  const page = R(100, 50, 600, 800);
  const spans = [
    {text: 'Thermal stability limits', rect: R(172, 150, 200, 12)},
    {text: 'cycling speed in PCR.', rect: R(372, 150, 160, 12)},
    {text: 'Libraries were screened next.', rect: R(172, 166, 300, 12)}];
  const sentence = 'Thermal stability limits cycling speed in PCR.';
  // boxes in percent of the page, as overlayBoxes() returns them
  const on = Live.percentToPx([{left: 12, top: 12.5, width: 60, height: 1.5}], page);
  assert.ok(Live.within(on[0], page));
  const good = Live.overlayAgreement(on, spans, sentence);
  assert.ok(good.coverage >= 0.5 && good.recall >= 0.5, JSON.stringify(good));
  // one line too low: still on text, but not on this sentence's words
  const low = Live.percentToPx([{left: 12, top: 14.5, width: 50, height: 1.5}], page);
  const shifted = Live.overlayAgreement(low, spans, sentence);
  assert.ok(shifted.coverage >= 0.5 && shifted.recall < 0.5, JSON.stringify(shifted));
  // in the margin: on nothing
  const off = Live.overlayAgreement(Live.percentToPx([{left: 80, top: 90, width: 10, height: 1}], page), spans, sentence);
  assert.equal(off.coverage, 0); assert.equal(off.recall, 0);
});

/* A tiny styled DOM: each element's box and colours come from data attributes. */
function styledDOM(html) {
  const {document: doc, window: win} = parseHTML(`<html><body>${html}</body></html>`);
  const num = (el, k, d) => el.getAttribute && el.getAttribute(k) !== null ? Number(el.getAttribute(k)) : d;
  win.Element.prototype.getBoundingClientRect = function () { return {left: num(this, 'x', 0), top: num(this, 'y', 0), width: num(this, 'w', 10), height: num(this, 'h', 10)}; };
  const style = el => ({fontSize: (el.getAttribute && el.getAttribute('fs')) || '13px', color: (el.getAttribute && el.getAttribute('fg')) || 'rgb(20,20,20)',
    backgroundColor: (el.getAttribute && el.getAttribute('bg')) || 'rgba(0,0,0,0)', display: 'block', visibility: 'visible', overflowX: 'visible', colorScheme: ''});
  Object.defineProperty(win, 'getComputedStyle', {value: style, configurable: true});
  return {doc, win};
}

test('the panel walk reports small text, low contrast, a weak icon and anything poking out', () => {
  const ok = styledDOM(`<aside id="p" x="800" w="372" h="600" bg="rgb(255,255,255)"><p x="810" w="300" h="16">Readable</p><button x="810" y="40" w="28" h="28" aria-label="Play" fg="rgb(255,255,255)" bg="rgb(17,24,39)"><svg x="816" y="46" w="16" h="16"></svg></button></aside>`);
  const good = Live.measurePanel(ok.win, ok.doc.getElementById('p'));
  assert.deepEqual(good.problems, []); assert.equal(good.texts, 1); assert.equal(good.smallestFont, 13);
  const bad = styledDOM(`<aside id="p" x="800" w="372" h="600" bg="rgb(255,255,255)"><p x="810" w="300" h="16" fs="10px">Tiny</p><p x="810" y="20" w="300" h="16" fg="rgb(190,190,190)">Faint</p>`
    + `<span x="900" y="40" w="400" h="16">Too wide</span><button x="810" y="60" w="28" h="28" aria-label="Ghost" fg="rgb(235,235,235)"><svg x="816" y="66" w="16" h="16"></svg></button><p hidden x="1500" w="10" fs="8px">hidden is ignored</p></aside>`);
  const out = Live.measurePanel(bad.win, bad.doc.getElementById('p'));
  const all = out.problems.join(' | ');
  assert.match(all, /Tiny.*10px text under 11px/);
  assert.match(all, /Faint.*contrast/);
  assert.match(all, /pokes out of the panel by 128px/);
  assert.match(all, /icon button "Ghost": contrast/);
  assert.doesNotMatch(all, /hidden is ignored/);
});

test('a row of controls must stay on one line inside its card', () => {
  const {doc} = styledDOM(`<section id="card" x="0" w="300" h="80"><div id="row" x="10" y="10" w="280" h="30"><button x="10" y="10" w="80" h="28">One</button><button x="95" y="10" w="80" h="28">Two</button><button x="10" y="42" w="80" h="28">Three</button><button x="180" y="10" w="130" h="28">Four</button></div></section>`);
  const r = Live.rowFits(doc.getElementById('row'), {name: 'filter', card: doc.getElementById('card')});
  const all = r.problems.join(' | ');
  assert.match(all, /wraps onto more than one row/);
  assert.match(all, /"Four" by 20px out of the row/);
  assert.match(all, /"Four" by 10px out of its card/);
  assert.deepEqual(Live.rowFits(null, {name: 'tabs'}).problems, ['tabs: not found']);
});

/* ---- the test PDF --------------------------------------------------------- */

test('the test PDF is chosen deterministically: DOI and >= 6 pages first, lowest itemID, never a file that is missing or an unloaded tab', () => {
  const rows = [
    {id: 50, doi: '10.1/a', pages: 12, exists: true, tab: 'none'},
    {id: 20, doi: '10.1/b', pages: 3, exists: true, tab: 'none'},
    {id: 30, doi: '10.1/c', pages: 9, exists: false, tab: 'none'},
    {id: 40, doi: '10.1/d', pages: 9, exists: true, tab: 'unloaded'},
    {id: 10, doi: '', pages: 40, exists: true, tab: 'none'},
    {id: 60, doi: '10.1/e', pages: 7, exists: true, tab: 'loaded'}];
  assert.equal(Live.chooseAttachment(rows).id, 50);
  assert.equal(Live.chooseAttachment(rows.slice().reverse()).id, 50, 'order of input does not matter');
  assert.equal(Live.chooseAttachment(rows.filter(r => r.id !== 50)).id, 60, 'a loaded tab of the user is reused, an unloaded one is not');
  assert.equal(Live.chooseAttachment([{id: 5, doi: '', pages: 0, exists: true}, {id: 4, doi: '10.1/x', pages: 0, exists: true}]).id, 4, 'a DOI with an unknown page count beats no DOI');
  assert.equal(Live.chooseAttachment([{id: 1, exists: false}]), null);
});

function libraryFake({files = new Set(['/s/A.pdf', '/s/B.pdf', '/s/C.pdf']), tabs = {}} = {}) {
  const mk = (id, parentID, path, extra = {}) => ({id, key: 'K' + id, libraryID: 1, parentID, deleted: false, isAttachment: () => true, isPDFAttachment: () => true,
    isLinkedFileAttachment: () => false, getFilePathAsync: async () => path, ...extra});
  const parent = (id, doi, title) => ({id, key: 'P' + id, isRegularItem: () => true, deleted: false, getField: k => ({DOI: doi, title, extra: ''}[k] || '')});
  const parents = new Map([[1, parent(1, '10.5/one', 'Short paper')], [2, parent(2, '10.5/two', 'Long paper')], [3, parent(3, '', 'No DOI')], [4, parent(4, '10.5/four', 'Gone file')]]);
  const items = [mk(103, 3, '/s/C.pdf'), mk(102, 2, '/s/B.pdf'), mk(101, 1, '/s/A.pdf'), mk(104, 4, '/s/missing.pdf'),
    {id: 105, isAttachment: () => true, isPDFAttachment: () => false, parentID: 2}, {id: 2, isAttachment: () => false, isPDFAttachment: () => false}];
  const Z = {Libraries: {userLibraryID: 1}, Items: {getAll: async () => items, get: id => parents.get(id) || items.find(i => i.id === id) || null},
    DB: {queryAsync: async () => [{itemID: 101, totalPages: 4}, {itemID: 102, totalPages: 14}, {itemID: 103, totalPages: 20}, {itemID: 104, totalPages: 30}]},
    Reader: {_readers: []}};
  const win = {Zotero_Tabs: {getTabIDByItemID: id => tabs[id] || null}};
  const io = {exists: async p => files.has(p)};
  return {Z, win, io};
}

test('the library scan reads page counts from the full-text index and skips missing files', async () => {
  const {Z, win, io} = libraryFake();
  const got = await Live.pickAttachment(Z, {io, win});
  assert.equal(got.id, 102, 'DOI and 14 pages; 104 has more pages but no file');
  assert.equal(got.rank, 0); assert.equal(got.file, 'B.pdf'); assert.equal(got.doi, '10.5/two'); assert.equal(got.scanned, 4);
  const unloaded = libraryFake({tabs: {102: 'reader-unloaded-1'}});
  assert.equal((await Live.pickAttachment(unloaded.Z, {io: unloaded.io, win: unloaded.win})).id, 101, 'the PDF whose tab would be selected is skipped');
});

/* ---- the guards ------------------------------------------------------------ */

test('a spied call from the reader modules is recorded and swallowed; anyone else\'s goes through', async () => {
  let stack = 'at x (file:///p/src/workbench.js:1:1)';
  const spies = Live.createSpies({stack: () => stack});
  const real = [];
  const http = {request: async (method, url) => { real.push(url); return {status: 200}; }};
  const runtime = {flush: async () => real.push('flush'), io: {writeUTF8: async p => real.push('write ' + p), exists: async () => true}, assist: {chat: async () => 'answer'}};
  const Z = {HTTP: http, Item: {prototype: {saveTx: async () => real.push('saveTx')}}, Items: {}};
  const service = {setGuard(fn) { this.guard = fn; }};
  const installed = Live.guards(spies, {Zotero: Z, runtime, service});
  assert.ok(installed.includes('network') && installed.includes('files') && installed.includes('process') && installed.includes('assist.chat'));
  // the rest of the plugin is left alone
  await http.request('GET', 'https://api.openalex.org/works');
  await runtime.flush(); await runtime.io.writeUTF8('/data/style-custom.json', '{}');
  assert.deepEqual(real, ['https://api.openalex.org/works', 'flush', 'write /data/style-custom.json']);
  assert.equal(spies.violations.length, 0);
  // the reader panel may read its own stylesheet, and nothing else
  stack = 'at translate (jar:file:///x.xpi!/src/reader-assist.js:640:5)';
  await http.request('GET', 'jar:file:///x.xpi!/content/reader-assist.css');
  await http.request('GET', 'http://localhost:11434/api/tags');
  await assert.rejects(http.request('POST', 'https://api-free.deepl.com/v2/translate'), /blocked by the reader self-check/);
  await runtime.flush(); await runtime.io.writeUTF8('/data/style-custom-reader/1-K.struct.json', '{}'); await Z.Item.prototype.saveTx();
  await assert.rejects(runtime.assist.chat([]), /blocked/);
  assert.equal(service.guard('nsIProcess /usr/bin/say'), true, 'a process launch is refused');
  assert.equal(real.length, 5, 'only the two local requests went through');
  assert.deepEqual(spies.violations.map(v => v.call), ['Zotero.HTTP.request', 'runtime.flush', 'io.writeUTF8', 'Zotero.Item.saveTx', 'assist.chat', 'nsIProcess /usr/bin/say']);
  // and everything is put back
  const proxy = runtime.io;
  spies.restore();
  assert.notEqual(runtime.io, proxy); assert.equal(typeof runtime.io.writeUTF8, 'function');
  stack = 'at translate (jar:file:///x.xpi!/src/reader-assist.js:640:5)';
  await http.request('POST', 'https://api-free.deepl.com/v2/translate');
  assert.equal(real.at(-1), 'https://api-free.deepl.com/v2/translate');
  assert.equal(Live.READER_MODULES.test('at run (file:///p/src/selfcheck-reader.js:1:1)'), false, 'the check itself is not the reader panel');
  const synth = {speak: () => real.push('spoke')};
  const s2 = Live.createSpies();
  assert.equal(Live.guardSpeech(s2, [{speechSynthesis: synth}, null]), 1);
  synth.speak({text: 'hello'});
  assert.equal(real.at(-1), 'https://api-free.deepl.com/v2/translate', 'nothing was spoken');
  assert.deepEqual(s2.violations, [{call: 'speechSynthesis.speak', detail: 'hello'}]);
  s2.restore();
});

/* ---- the run, against a fake Zotero ---------------------------------------- */

function liveFake({speakDuringCheck = false, existingReader = false} = {}) {
  const {Z, win, io} = libraryFake();
  const calls = {open: [], reserve: [], closed: 0, guard: [], writes: [], selected: []};
  const {document: vdoc} = parseHTML('<html><body><div id="viewerContainer"></div><div class="page" data-page-number="1"><div class="textLayer"><span>Hello world text.</span></div></div></body></html>');
  const synth = {speak: () => calls.spoke = true, getVoices: () => [{}, {}], speaking: false, pending: false};
  const reader = {itemID: 102, type: 'pdf', tabID: 'tab-check', _initPromise: Promise.resolve(), _iframeWindow: {speechSynthesis: synth},
    _internalReader: {_state: {readAloudState: {active: false, paused: false, popupOpen: false}},
      _primaryView: {_iframeWindow: {document: vdoc, PDFViewerApplication: {pdfDocument: {numPages: 8}, pdfViewer: {currentScaleValue: '1.5', currentScale: 1.5, getPageView: () => ({renderingState: 3})}}}}},
    close() { calls.closed++; Z.Reader._readers.splice(Z.Reader._readers.indexOf(reader), 1); }};
  Z.Reader.open = async (...args) => { calls.open.push(args); Z.Reader._readers.push(reader); return reader; };
  Z.Reader._registeredListeners = [{type: 'renderTextSelectionPopup', handler() {}}];
  if (existingReader) Z.Reader._readers.push(reader);
  Z.getMainWindow = () => ({...win, document: {hasFocus: () => true}, Zotero_Tabs: {...win.Zotero_Tabs, selectedID: 'zotero-pane', select: id => calls.selected.push(id), _history: [[{data: {itemID: 102}}]]}});
  Z.HTTP = {request: async () => ({})};
  Z.DataDirectory = {dir: '/data'};
  const handle = {
    baseline: {doc: 0, view: 0}, session: {open: false}, doc: vdoc, win: {getComputedStyle: () => ({})},
    async ready() { return true; },
    async readPages() { if (speakDuringCheck) synth.speak({text: 'oops'}); throw new Error('no pdf.js in this fake'); },
    layout: () => [{id: '#split-view', value: '', priority: ''}], viewContainers: () => [], panel: () => vdoc.body, viewerDoc: () => vdoc,
    open() {}, collapse() {}, close() {}, showTab() {}, overlay: () => ({page: 1, boxes: []}), pageNumberOf: () => 1,
    selectionPopup(params, append) { const b = vdoc.createElement('button'); b.className = 'sc-ra-selection-listen'; b.setAttribute('data-opens', 'audio'); b.textContent = 'Listen from here'; append(b); },
    readAloudState: () => reader._internalReader._state.readAloudState, speech: () => ({present: true, voices: 2, speaking: false, pending: false}),
    player: () => null, handlers: () => ({doc: [], view: [], win: []}), targets: () => ({}), count: () => ({doc: 0, view: 0}), alive: () => false, release() { calls.released = true; }};
  const service = {diagnose: (r, o) => { calls.diagnose = o; return handle; }, reserve: (r, on) => calls.reserve.push(on), setGuard: fn => calls.guard.push(fn), sessions: () => []};
  const runtime = {version: 'test', readerAssist: service, assist: {chat: async () => ''}, io: {writeUTF8: async () => {}}};
  const fileIO = {exists: io.exists, writeUTF8: async (p, text) => calls.writes.push({p, report: JSON.parse(text)})};
  return {Z, runtime, calls, reader, fileIO};
}

test('the live run opens its own background tab, measures, closes it and writes the report', async () => {
  const f = liveFake();
  const report = await Live.run(f.Z, f.runtime, {io: f.fileIO, paths: {join: (...p) => p.join('/')}, els: null, sleep: fast, after: never, paperText: PT});
  assert.deepEqual(f.calls.open, [[102, {pageIndex: 0}, {openInBackground: true, allowDuplicate: false}]]);
  assert.deepEqual(f.calls.diagnose, {fresh: true});
  assert.deepEqual(f.calls.reserve, [true, false], 'kept out of sync() while open, let go after');
  assert.equal(f.calls.closed, 1); assert.equal(f.calls.released, true);
  assert.equal(f.Z.Reader._readers.length, 0);
  assert.equal(typeof f.reader._setState, 'function', 'Zotero\'s view-state write for the tab is suppressed');
  assert.equal(f.calls.guard.at(-1), null, 'the process guard is lifted');
  assert.equal(f.calls.writes.length, 1); assert.equal(f.calls.writes[0].p, '/data/style-custom-reader-check.json');
  const steps = Object.fromEntries(report.steps.map(s => [s.name, s]));
  assert.equal(steps['a test PDF with a local file is found'].pass, true);
  assert.equal(steps['the reader opens and pdf.js renders page 1'].pass, true);
  assert.equal(steps['extraction: body found with positions, no fallback'].pass, false, 'a failure is reported, not hidden');
  assert.match(steps['re-fit: page 1 fits the viewer narrowed by the panel'].detail, /zoom is fixed at 1.5/);
  assert.equal(steps['selection popup: the listen-from-here button is offered'].pass, true);
  assert.equal(steps['Zotero Read Aloud: its state is readable'].pass, true);
  assert.equal(steps['speech: a voice is available without speaking'].pass, true);
  assert.equal(steps['cleanup: the check\'s tab is closed and forgotten'].pass, true, steps['cleanup: the check\'s tab is closed and forgotten'].detail);
  assert.equal(steps['nothing was spoken, launched, sent or written'].pass, true);
  assert.ok(report.timings.total >= 0 && 'pick' in report.timings);
  assert.ok(report.lines.every(line => /^(PASS|FAIL) /.test(line)));
});

test('any blocked call during the run fails the step that says nothing was spoken, launched, sent or written', async () => {
  const f = liveFake({speakDuringCheck: true});
  const report = await Live.run(f.Z, f.runtime, {io: f.fileIO, paths: {join: (...p) => p.join('/')}, els: null, sleep: fast, after: never, paperText: PT});
  const step = report.steps.find(s => s.name === 'nothing was spoken, launched, sent or written');
  assert.equal(step.pass, false); assert.match(step.detail, /speechSynthesis\.speak \(oops\)/);
  assert.equal(f.calls.spoke, undefined, 'the real speak was never called');
  assert.deepEqual(report.blocked, [{call: 'speechSynthesis.speak', detail: 'oops'}]);
});

test('a reader the user already has open is reused read only and never closed', async () => {
  const f = liveFake({existingReader: true});
  const report = await Live.run(f.Z, f.runtime, {io: f.fileIO, paths: {join: (...p) => p.join('/')}, els: null, sleep: fast, after: never, paperText: PT});
  assert.deepEqual(f.calls.open, []); assert.equal(f.calls.closed, 0); assert.deepEqual(f.calls.diagnose, {fresh: false});
  assert.equal(f.Z.Reader._readers.length, 1);
  assert.match(report.mode, /reused/);
  assert.equal(report.steps.some(s => /tab is closed/.test(s.name)), false);
});

test('the default self-check never opens a reader; only the flag does', async () => {
  const f = liveFake();
  assert.equal(await SelfCheck.readerCheck(f.Z, f.runtime, {}), null);
  assert.equal(await SelfCheck.readerCheck(f.Z, f.runtime, {reader: 'yes'}), null, 'only true turns it on');
  assert.deepEqual(f.calls.open, []);
  // The whole default run, against a Zotero where every reader entry point is a tripwire.
  const tripwire = new Proxy({}, {get: (t, k) => k === 'then' ? undefined : () => { throw new Error('touched ' + String(k)); }});
  const opened = [];
  const Z = {Libraries: {userLibraryID: 1}, Items: {getAll: async () => []}, getMainWindow: () => null, Prefs: tripwire, HTTP: tripwire,
    Reader: {_readers: [], open: async (...a) => { opened.push(a); }}};
  const runtime = new Proxy({version: 't', active: true, cache: {items: {}}, readerAssist: {probeAll: async () => []}}, {get: (t, k) => k in t ? t[k] : (k === 'then' ? undefined : () => { throw new Error('runtime.' + String(k)); })});
  const out = await SelfCheck.run(Z, runtime, {network: false});
  assert.deepEqual(opened, [], 'Zotero.Reader.open was never called');
  assert.equal(out.results.some(r => /real reader/.test(r.name)), false);
  // and with the flag, the same function goes to the live check
  const g = liveFake();
  const step = await SelfCheck.readerCheck(g.Z, g.runtime, {reader: true});
  assert.equal(g.calls.open.length, 1);
  assert.equal(step.name, 'the reader features work in a real reader');
  assert.equal(step.pass, false, 'the fake has no pdf.js, so extraction fails and the step says so');
  assert.match(step.detail, /reader steps failed: .*extraction/);
});

test('bootstrap reads the reader flag with the others, clears it before running, and the build packs the module', () => {
  const boot = fs.readFileSync(new URL('../bootstrap.js', import.meta.url), 'utf8');
  assert.match(boot, /reader: Zotero\.Prefs\.get\("extensions\.style-custom\.selfCheckReader", true\) === true/);
  assert.match(boot, /for \(const flag of \[[^\]]*"selfCheckReader"[^\]]*\]\) Zotero\.Prefs\.set/);
  assert.match(boot, /"selfcheck", "selfcheck-reader"/);
  assert.match(fs.readFileSync(new URL('../scripts/build.py', import.meta.url), 'utf8'), /"src\/selfcheck-reader\.js"/);
});

/* ---- reader-assist's diagnose() handle, on the real module ---------------- */

function readerFixture() {
  const {document: doc, window: win} = parseHTML('<html><head></head><body><div id="split-view"></div></body></html>');
  Object.defineProperty(win, 'setTimeout', {value: (fn, ms) => realSetTimeout(fn, ms), configurable: true, writable: true});
  Object.defineProperty(win, 'clearTimeout', {value: id => realClearTimeout(id), configurable: true, writable: true});
  Object.defineProperty(win, 'getComputedStyle', {value: () => ({fontSize: '13px', color: 'rgb(30,30,30)', backgroundColor: 'rgb(255,255,255)', display: 'block', visibility: 'visible', overflowX: 'visible', colorScheme: ''}), configurable: true});
  if (doc.defaultView !== win) Object.defineProperty(doc, 'defaultView', {configurable: true, get: () => win});
  const viewDoc = parseHTML('<html><body><div class="page" data-page-number="1"></div></body></html>').document;
  const page = {view: [0, 0, 612, 792], rotate: 0, async getTextContent() { return {items: [{str: 'We study polymerases. They are useful.', transform: [10, 0, 0, 10, 72, 680], width: 200, height: 10, fontName: 'f2'}], styles: {f2: {fontFamily: 'serif'}, f3: {fontFamily: 'sans'}}}; },
    async getOperatorList() { return {}; }, commonObjs: {has: id => id === 'f2', get: () => ({name: 'Serif'})}};
  const core = {_state: {primaryViewStats: {pageIndex: 0, pagesCount: 1}, readAloudState: {active: false, paused: false}},
    _primaryView: {_iframeWindow: {document: viewDoc, PDFViewerApplication: {pdfDocument: {numPages: 1, getPage: async () => page}}}}};
  const reader = {type: 'pdf', itemID: 11, tabID: 't1', _window: win, _iframeWindow: {document: doc, closed: false, speechSynthesis: {getVoices: () => [1, 2, 3]}}, _internalReader: core};
  const attachment = {id: 11, key: 'ATT', libraryID: 1, parentID: 10, getFilePathAsync: async () => '/lib/ATT.pdf'};
  const parent = {id: 10, getField: k => ({title: 'A paper', abstractNote: 'An abstract.'}[k] || '')};
  const touched = [], writes = [];
  const io = {exists: async () => true, stat: async () => ({size: 1000, lastModified: 5}), readUTF8: async () => JSON.stringify({v: 1, summary: {}, chat: [], tr: {}}),
    writeUTF8: async p => writes.push(p), setModificationTime: async p => touched.push(p), makeDirectory: async () => {}, remove: async () => {}};
  const css = fs.readFileSync(new URL('../content/reader-assist.css', import.meta.url), 'utf8');
  const Z = {Items: {get: id => id === 11 ? attachment : id === 10 ? parent : null}, HTTP: {request: async () => ({response: css, status: 200})}, DataDirectory: {dir: '/data'}, logError() {}, Reader: {_readers: [reader]}, isMac: true};
  const runtime = {cache: {readerAssist: {open: true, tab: 'translate'}}, dirty: false, rootURI: 'file:///plugin/', io, paths: {join: (...p) => p.join('/')}, i18n: {isKorean: () => false}, t: I18N.t,
    pref: (k, d) => d, getSetting: () => undefined, setSetting: async () => {}, scheduleFlush() {}, assist: {available: () => false}};
  const service = ReaderAssist.create({Zotero: Z, runtime});
  return {doc, win, viewDoc, reader, runtime, service, touched, writes};
}

test('diagnose() on the check\'s own reader: a probe session that saves nothing, sync() keeps out, release() leaves nothing behind', async () => {
  const f = readerFixture();
  f.service.reserve(f.reader);
  f.service.sync(f.win, [f.reader], 't1'); await settle();
  assert.equal(f.service.sessions().length, 0, 'a reserved reader gets no ordinary session');
  const h = f.service.diagnose(f.reader, {fresh: true});
  assert.deepEqual(h.baseline, {doc: 0, view: 0});
  assert.equal(await h.ready(), true, 'stylesheet in');
  assert.equal(h.session.probing, true);
  assert.equal(h.panel().hidden, true, 'the remembered open state does not open a probe panel by itself');
  h.open();
  assert.equal(h.panel().hidden, false);
  // (linkedom keeps no !important priority; the value is what is compared here, Gecko's report has both)
  assert.equal(h.layout()[0].id, '#split-view'); assert.equal(h.layout()[0].value, '372px');
  h.collapse(true); assert.equal(h.layout()[0].value, '52px');
  h.collapse(false); h.showTab('listen'); h.close();
  assert.equal(h.layout()[0].value, '', 'the inset is given back');
  const pages = await h.readPages([1, 2]);
  assert.equal(pages.numPages, 1); assert.equal(pages.pages.length, 1, 'page 2 does not exist and is not read');
  assert.deepEqual(pages.fonts, {fonts: 2, named: 1, pages: 1}, 'f2 resolved to a name, f3 never reached commonObjs');
  const s = h.structure(pages.pages);
  const units = PT.readingOrder(s);
  assert.ok(units.length >= 1);
  const o = h.overlay(units[0], pages.sizes);
  assert.equal(o.page, 1); assert.ok(o.boxes.length >= 1 && o.boxes.every(b => b.left >= 0 && b.left + b.width <= 100.5));
  const made = []; h.selectionPopup({annotation: {position: {pageIndex: 0, rects: [[72, 600, 300, 612]]}}}, (...n) => made.push(...n));
  assert.equal(made[0].getAttribute('data-opens'), 'audio');
  assert.deepEqual(h.speech(), {present: true, voices: 3, speaking: false, pending: false});
  assert.equal(h.readAloudState().active, false);
  assert.ok(h.count().doc >= 2, 'panel and style are in the reader');
  h.release();
  assert.deepEqual(h.count(), {doc: 0, view: 0}, 'nothing of ours left');
  assert.equal(h.alive(), false); assert.equal(f.service.sessions().length, 0);
  f.service.sync(f.win, [f.reader], 't1'); await settle();
  assert.equal(f.service.sessions().length, 0, 'still reserved: sync does not bring a session back');
  assert.deepEqual(f.writes, [], 'no .state or .struct file written, not even on release');
  assert.deepEqual(f.touched, [], 'the cache file\'s time was not touched by the probe');
  assert.equal(f.runtime.cache.readerAssist.tab, 'translate', 'the remembered tab is unchanged');
  f.service.reserve(f.reader, false);
  f.service.sync(f.win, [f.reader], 't1'); await settle();
  assert.equal(f.service.sessions().length, 1, 'let go, the reader is an ordinary one again');
  f.service.stop();
});

test('diagnose() on the user\'s own reader puts the panel back the way it was and keeps their session', async () => {
  const f = readerFixture();
  f.service.sync(f.win, [f.reader], 't1'); await settle(20);
  const mine = f.service.sessions()[0];
  assert.ok(mine && mine.open, 'their panel was open');
  const h = f.service.diagnose(f.reader, {fresh: false});
  assert.equal(h.session, mine);
  await h.ready(); h.collapse(true); h.close();
  h.release();
  assert.equal(f.service.sessions()[0], mine); assert.equal(mine.open, true); assert.equal(mine.collapsed, false); assert.equal(mine.probing, false);
  f.service.stop();
});

test('the say fallback asks the self-check\'s guard first', () => {
  const src = fs.readFileSync(new URL('../src/reader-assist.js', import.meta.url), 'utf8');
  assert.match(src, /function spawnSay\(args,onexit\)\{\n\s*\/\/[^\n]*\n\s*if\(guard&&guard\('nsIProcess \/usr\/bin\/say'\)\)return \{kill\(\)\{\}\};/);
});

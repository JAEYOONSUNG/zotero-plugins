/* An offline picture of the reader panel (src/reader-assist.js), the way scripts/design-preview.mjs
   gives one of the workbench. The real panel DOM is mounted against memory-only fakes -- no Zotero, no
   library, no network, nothing on screen -- and written to docs/reader-preview.html, which
   scripts/preview-shots.mjs can then photograph with headless Chrome.

     node scripts/reader-preview.mjs                       # writes docs/reader-preview.html
     node scripts/preview-shots.mjs /tmp/shots reader      # a PNG of it, light
     node scripts/preview-shots.mjs /tmp/shots reader dark # and dark

   Every tab is painted at once, side by side, so a change of spacing or weight can be judged against the
   rest of the panel rather than one card at a time. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseHTML} from 'linkedom';
import I18N from '../src/i18n.js';
import Strings from '../src/strings.js';
import Assist from '../src/assist.js';
import ReaderAssist from '../src/reader-assist.js';
import '../src/read-aloud.js';
import '../src/paper-chat.js';
import '../src/paper-translate.js';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
require('../src/paper-text.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realSetTimeout = globalThis.setTimeout.bind(globalThis);   // the fake window's own setTimeout must not call itself
I18N.load(Strings.en); I18N.use('ko-KR');          // the panel as its reader sees it

/* A fictional paper, in the extraction module's shape. */
const sent = (text, page, y) => ({text, page, rects: [[72, y, 300, 12]]});
const para = (page, ...texts) => ({sentences: texts.map((t, i) => sent(t, page, 120 + i * 16))});
const PAPER = {
  title: 'Thermostable polymerase evolution by compartmentalised self-replication',
  abstract: 'We evolved a polymerase that tolerates 95 °C for thirty minutes.',
  sections: [
    {heading: '초록', level: 1, page: 0, kind: 'body', paragraphs: [para(0, '우리는 95도에서 30분을 견디는 중합효소를 진화시켰다.', '활성은 야생형의 80퍼센트로 유지되었다.')]},
    {heading: 'Introduction', level: 1, page: 0, kind: 'body', paragraphs: [para(0, 'DNA polymerases drive PCR.', 'Thermal stability limits how fast a cycle can run.', 'Earlier work raised the melting point by four degrees.')]},
    {heading: 'Methods', level: 1, page: 2, kind: 'body', paragraphs: [para(2, 'Libraries were screened by compartmentalised self-replication.', 'Kinetics were measured at 72 °C.')]},
    {heading: 'Results', level: 1, page: 3, kind: 'body', paragraphs: [para(3, 'Variant M7 retained 80 percent activity after 30 minutes at 95 °C.', 'The gain came from two substitutions in the thumb domain.')]},
    {heading: 'Discussion', level: 1, page: 6, kind: 'body', paragraphs: [para(6, 'The result agrees with Kim et al. and extends it to higher temperatures.')]},
    {heading: 'References', level: 'back', page: 9, kind: 'back', paragraphs: [para(9, 'Smith J. 2020. A paper.')]}
  ],
  captions: [{kind: 'figure', label: 'Figure 1', text: 'Figure 1. Residual activity after heat challenge.', page: 2}],
  references: [{text: 'Smith J. 2020. A paper.', page: 9}], footnotes: [],
  skipped: {headers: [], footers: [], pageNumbers: [], equations: [], tables: [], other: []}, stats: {pages: 10}
};
const sizes = () => Array.from({length: 10}, () => ({width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792], rotation: 0}));

function mount({scheme = 'light'} = {}) {
  const {document: doc, window: win} = parseHTML('<html><head></head><body><div id="split-view"></div></body></html>');
  const define = (name, value) => Object.defineProperty(win, name, {value, configurable: true, writable: true});
  define('setTimeout', (fn, ms) => (ms > 40 ? 0 : realSetTimeout(fn, ms)));   // no clocks in a still picture
  define('clearTimeout', () => {});
  define('navigator', {platform: 'MacIntel'});
  define('getComputedStyle', () => ({fontSize: '13px', color: 'rgb(30,30,30)', backgroundColor: 'rgb(255,255,255)', display: 'block', visibility: 'visible', overflowX: 'visible', colorScheme: scheme}));
  define('Blob', class { constructor(parts) { this.parts = parts; } });
  define('URL', {createObjectURL: () => 'blob:x', revokeObjectURL() {}});
  define('Audio', class { constructor(url) { this.src = url; } addEventListener() {} play() { return Promise.resolve(); } pause() {} });

  const viewWin = parseHTML('<html><body></body></html>').window, viewDoc = viewWin.document;
  for (let i = 1; i <= 10; i++) { const page = viewDoc.createElement('div'); page.setAttribute('class', 'page'); page.setAttribute('data-page-number', String(i)); viewDoc.body.appendChild(page); }
  viewWin.Element.prototype.getBoundingClientRect = () => ({top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0});

  const core = {_state: {primaryViewStats: {pageIndex: 2, pagesCount: 10}}, _primaryView: {_iframeWindow: {document: viewDoc}}};
  const frame = {document: doc, closed: false, setTimeout: win.setTimeout, navigator: win.navigator};
  const reader = {type: 'pdf', itemID: 11, tabID: 't1', _window: win, _iframeWindow: frame, _internalReader: core, navigate: async () => {}};
  if (doc.defaultView !== win) Object.defineProperty(doc, 'defaultView', {configurable: true, get: () => win});

  const files = new Map();
  const io = {files, exists: async p => files.has(p), stat: async () => ({size: 1000, lastModified: 5}),
    readUTF8: async p => files.get(p), writeUTF8: async (p, text) => { files.set(p, text); }, makeDirectory: async () => {}, remove: async p => { files.delete(p); }};
  files.set('/data/style-custom-reader/1-ATT.struct.json', JSON.stringify({v: 2, extractor: String(globalThis.StyleCustomPaperText && globalThis.StyleCustomPaperText.VERSION || '1') + '.2', sig: '1000:5', structured: PAPER, sizes: sizes(), fallback: false}));
  files.set('/home/Library/Application Support/StyleCustomBridge/bridge.json', JSON.stringify({port: 47823, token: 'k'.repeat(40)}));

  const attachment = {id: 11, key: 'ATT', libraryID: 1, parentID: 10, getFilePathAsync: async () => '/lib/ATT.pdf'};
  const FIELDS = {title: PAPER.title, abstractNote: PAPER.abstract, publicationTitle: 'Nature Methods', date: '2026-03-11'};
  const parent = {id: 10, key: 'ITEM', libraryID: 1, isRegularItem: () => true, getField: k => FIELDS[k] || '',
    getCreators: () => [{lastName: 'Sung'}, {lastName: 'Kim'}, {lastName: 'Rivera'}, {lastName: 'Morgan'}], getTags: () => [{tag: '#topic/PCR'}, {tag: '/reading'}]};

  /* Answers for the panel's own requests: this Mac's voices, and a bake caught halfway. */
  const http = {async request(method, url) {
    if (String(url).endsWith('reader-assist.css')) return {response: fs.readFileSync(path.join(root, 'content/reader-assist.css'), 'utf8'), status: 200};
    if (/\/v1\/audio\/voices$/.test(url)) return {status: 200, response: {available: true, bake: {out: '/Users/you/Dropbox/논문 음성', busy: false},
      models: [{id: 'supertonic', label: 'Supertonic 3', langs: ['en', 'ko'], default: 'F3', voices: [{id: 'F3', style: 'clear narrator'}, {id: 'M5', style: 'warm narrator'}]}]}};
    return {status: 200, response: {choices: [{message: {content: 'AI answer.'}}]}, getResponseHeader: () => 'application/json'};
  }};

  const Z = {Items: {get: id => id === 11 ? attachment : id === 10 ? parent : null}, HTTP: http,
    Prefs: {get: () => undefined}, Utilities: {Internal: {copyTextToClipboard() {}}}, DataDirectory: {dir: '/data'},
    logError() {}, Reader: {_readers: [reader]}, getMainWindow: () => win, isMac: true,
    PDFWorker: {async getFullText() { return {text: 'Abstract\n\nPlain text.'}; }}};
  const settings = {aiLanguage: 'Korean', aiSummaryOnOpen: false, readAloudSpeed: 100, readAloudVoice: 'supertonic:en:F3', readAloudVoiceKo: '', readAloudHeadings: true, readAloudCredit: true};
  const runtime = {cache: {}, dirty: false, rootURI: 'file:///plugin/', io, paths: {join: (...p) => p.join('/'), homeDir: '/home'},
    i18n: {isKorean: () => true}, t: I18N.t, pref: (k, d) => ({aiEndpoint: '', aiModel: '', aiKey: ''}[k] ?? d),
    getSetting: k => settings[k], setSetting: async (k, v) => { settings[k] = v; }, scheduleFlush() {},
    entry: () => ({remark: ''}), addReading: async () => {},
    libraryService: {async setRemark() { return {}; }, async createNoteHTML() { return '1'; }}};
  runtime.assist = Assist.create({Zotero: Z, runtime});
  const service = ReaderAssist.create({Zotero: Z, runtime});
  runtime.readerAssist = service;
  const container = doc.createElement('span'); doc.body.appendChild(container);
  service.mountToolbar({reader, doc, container});
  return {win, doc, service, container, reader, settle: async (n = 40) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); }};
}

/* The panel on one tab, as HTML, with the state a picture should show. */
async function panelOn(tab, {bake = null} = {}) {
  const m = mount();
  await m.settle();
  m.container.querySelector('button[data-safe="view"]').dispatchEvent(new m.win.Event('click', {bubbles: true}));
  await m.settle();
  const panel = m.doc.querySelector('[data-sc-ra]');
  panel.querySelector(`[data-tab="${tab}"]`).dispatchEvent(new m.win.Event('click', {bubbles: true}));
  await m.settle();
  // Put the bake in place before the list is built: the panel paints the card as it paints the list,
  // so a picture of a bake halfway through needs no clock and no request.
  if (bake) m.service.sessions()[0].bake = {id: 'b1', config: {base: 'http://127.0.0.1:47823', token: 'k'}, ...bake};
  if (tab === 'listen') {
    // The list only exists once the paper has been read, which is what ▶ does.
    panel.querySelector('.sc-ra-play').dispatchEvent(new m.win.Event('click', {bubbles: true}));
    await m.settle(120);
  }
  const html = panel.outerHTML;
  m.service.stop();
  return html;
}

const LABELS = [['ask', 'AI 요약·대화'], ['translate', '번역'], ['listen', '듣기 · 운전용 오디오']];
const columns = [];
for (const [tab, label] of LABELS) columns.push({label, html: await panelOn(tab)});
columns.push({label: '듣기 · 만드는 중', html: await panelOn('listen', {bake: {state: 'speaking', done: 46, total: 212, seconds: 614, out: '/Users/you/Dropbox/논문 음성'}})});
columns.push({label: '듣기 · 완성', html: await panelOn('listen', {bake: {state: 'done', done: 212, total: 212, seconds: 2810, bytes: 24 * 1048576, out: '/Users/you/Dropbox/논문 음성', file: '/Users/you/Dropbox/논문 음성/Thermostable polymerase evolution by compartmen.m4b'}})});

const css = fs.readFileSync(path.join(root, 'content/reader-assist.css'), 'utf8');
/* The panel is position:fixed in the reader; here each copy sits in its own relative box. */
const frame = `
 body{margin:0;background:#e5e7eb;font:12px -apple-system,system-ui,sans-serif;color:#374151}
 .demo-bar{height:38px;display:flex;align-items:center;gap:12px;padding:0 18px}
 .demo-bar strong{font-weight:650}
 .demo-cols{display:flex;gap:18px;padding:0 18px 18px;align-items:flex-start;overflow-x:auto}
 .demo-col{flex:0 0 auto;display:flex;flex-direction:column;gap:6px}
 .demo-col > span{font-size:11px;font-weight:650;color:#4b5563}
 .demo-hold{position:relative;width:372px;height:760px;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.14)}
 .demo-hold .sc-ra{position:absolute;top:0;bottom:0;height:100%}
 @media (prefers-color-scheme:dark){
  body{background:#1b1b1b;color:#d4d4d4}.demo-col > span{color:#a3a3a3}.demo-hold{background:#1e1e1e}
  .demo-hold .sc-ra{--color-background:#1e1e1e;--color-sidepane:#303030;--fill-primary:rgba(255,255,255,0.9);
   --color-border:rgba(255,255,255,0.18);--fill-quinary:rgba(255,255,255,0.06);--fill-quarternary:rgba(255,255,255,0.12)}
 }`;
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
  + `<title>Style Custom · 리더 패널 미리보기</title><style>${frame}\n${css}</style></head><body>`
  + `<div class="demo-bar"><strong>리더 패널 미리보기</strong><span>예시 논문 · 실제 라이브러리·네트워크 연결 없음</span></div>`
  + `<div class="demo-cols">${columns.map(c => `<div class="demo-col"><span>${c.label}</span><div class="demo-hold">${c.html}</div></div>`).join('')}</div>`
  + `</body></html>`;

if (html.includes('<script') || html.includes('<link ')) throw new Error('the preview must carry no script or external asset');
const target = path.join(root, 'docs/reader-preview.html');
fs.writeFileSync(target, html);
console.log(`Reader panel preview written: ${columns.length} states, real panel DOM, no external assets: ${target}`);

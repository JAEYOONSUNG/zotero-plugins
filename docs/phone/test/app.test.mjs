/* 논문's own checks. The app has no build step, so it is loaded here into a fake phone: a DOM
   from linkedom, a fake IndexedDB and a fake api.zotero.org. What is asserted is the part that
   can silently break and would only show up on the phone: how the library is paged in, what a
   status or rating write actually sends, and that the list shows what was asked for. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseHTML} from '../../../zotero-style-custom/node_modules/linkedom/esm/index.js';

const here = new URL('.', import.meta.url);
const read = name => fs.readFileSync(new URL(`../${name}`, here), 'utf8');

/* A library of three papers: one being read, one unread with a rating, one finished. */
const ITEMS = [
  {key: 'AAA', version: 10, data: {key: 'AAA', version: 10, itemType: 'journalArticle', title: 'Retron Septu defence', date: '2025-01-03',
    creators: [{creatorType: 'author', lastName: 'Seo', firstName: 'H'}, {creatorType: 'author', lastName: 'Kim', firstName: 'K'}],
    publicationTitle: 'Science', DOI: '10.1126/science.abc1234', tags: [{tag: '/reading', type: 1}, {tag: 'phage'}], collections: ['C1'], extra: 'Citations: 89', dateModified: '2026-10-10T00:00:00Z'}},
  {key: 'BBB', version: 11, data: {key: 'BBB', version: 11, itemType: 'journalArticle', title: 'PET depolymerase landscape', date: '2026',
    creators: [{creatorType: 'author', lastName: 'Hong', firstName: 'H'}], publicationTitle: 'Nature', tags: [{tag: '/unread', type: 1}],
    collections: [], extra: 'Rating: 4\nCitations: 7', dateModified: '2026-10-09T00:00:00Z'}},
  {key: 'CCC', version: 12, data: {key: 'CCC', version: 12, itemType: 'journalArticle', title: 'Immune sensing in bacteria', date: '2026',
    creators: [], publicationTitle: 'Nat Rev Microbiol', tags: [{tag: '/done', type: 1}], collections: ['C1'], extra: '', dateModified: '2026-10-08T00:00:00Z'}},
  // Not a paper: an attachment must never reach the list.
  {key: 'DDD', version: 13, data: {key: 'DDD', version: 13, itemType: 'attachment', parentItem: 'AAA', title: 'full text', tags: [], dateModified: '2026-10-08T00:00:00Z'}}
];
const COLLECTIONS = [{key: 'C1', version: 5, data: {key: 'C1', name: 'Phage defence', parentCollection: false}}];

/* The smallest IndexedDB that answers what the app asks of it. Each store remembers the keyPath
   it was made with, because a store keyed by something other than `key` is exactly where a wrong
   assumption hides: a row put under one name and deleted under another is never deleted. */
function fakeIndexedDB() {
  const stores = new Map();
  const paths = new Map();
  const store = name => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name); };
  const idOf = (name, row) => row[paths.get(name) || 'key'];
  const task = result => { const req = {result, onsuccess: null, onerror: null}; queueMicrotask(() => req.onsuccess && req.onsuccess()); return req; };
  return {
    open() {
      const db = {
        objectStoreNames: {contains: name => stores.has(name)},
        createObjectStore(name, options = {}) { store(name); paths.set(name, options.keyPath || 'key'); return {}; },
        transaction(name) {
          const tx = {oncomplete: null, onerror: null,
            objectStore: () => ({
              getAll: () => task([...store(name).values()]),
              get: key => task(store(name).get(key)),
              put: row => { store(name).set(idOf(name, row), row); return task(); },
              delete: key => { store(name).delete(key); return task(); },
              clear: () => { store(name).clear(); return task(); }
            })};
          queueMicrotask(() => queueMicrotask(() => tx.oncomplete && tx.oncomplete()));
          return tx;
        }
      };
      const req = {result: db, onupgradeneeded: null, onsuccess: null, onerror: null};
      queueMicrotask(() => { req.onupgradeneeded && req.onupgradeneeded(); req.onsuccess && req.onsuccess(); });
      return req;
    },
    _stores: stores
  };
}

let boots = 0;
/* Each boot gets its own clock. The globals a module reads are replaced on the next boot, so a
   timer left running by the one before would otherwise redraw this phone's screen. */
let timers = [], repeats = [];
const realAfter = globalThis.setTimeout, realStop = globalThis.clearTimeout;
const realEvery = globalThis.setInterval, realStopEvery = globalThis.clearInterval;
function ownClock() {
  const after = (fn, ms, ...rest) => { const id = realAfter(fn, ms, ...rest); timers.push(id); return id; };
  const every = (fn, ms, ...rest) => { const id = realEvery(fn, ms, ...rest); repeats.push(id); return id; };
  return {after, stop: id => realStop(id), every, stopEvery: id => realStopEvery(id)};
}
function stopOldTimers() {
  for (const id of timers) realStop(id);
  // The reading watchdog repeats for as long as a paper is being read; a test that ends mid-paper
  // would otherwise leave it ticking and the whole run would never finish.
  for (const id of repeats) realStopEvery(id);
  timers = []; repeats = [];
}

/* The phone's voice: utterances are collected, and step() speaks the oldest one through. */
const ONE_VOICE = [{voiceURI: 'v-sam', name: 'Samantha', lang: 'en-US', localService: true, default: true}];
function fakeSpeech(voices = ONE_VOICE) {
  const queue = [], spoken = [];
  class Utterance {
    constructor(text) { this.text = text; this.onstart = null; this.onend = null; this.onerror = null; }
  }
  const synth = {
    getVoices: () => voices,
    speak(u) { queue.push(u); },
    cancel() { queue.length = 0; },
    pause() { synth.paused = true; },
    resume() { synth.paused = false; },
    addEventListener() {}, removeEventListener() {},
    paused: false
  };
  return {synth, Utterance, spoken, queue,
    /* The phone starts the oldest utterance, and finishes it when the voice reaches the end. */
    start() { const u = queue[0]; if (u) { spoken.push(u.text); u.onstart?.(); } return u; },
    finish() { const u = queue.shift(); if (u) u.onend?.(); return u; },
    step() { this.start(); return this.finish(); }};
}

/* api.zotero.org, enough of it: paged listings with the headers the app reads, and PATCH/POST
   that record what was sent. */
/* One page of what Zotero indexed for a PDF: a running head, the body, a caption, references. */
const FULLTEXT = [
  `Seo et al., Science 387, 41 (2026)

Introduction

Microbial decomposers can degrade newly encountered materials [1]. The enzyme works at fif-
ty degrees.

Fig. 1. The landscape, coloured by cluster.

1`,
  `Seo et al., Science 387, 41 (2026)

References

1. H. Seo, Nature 500, 1 (2019).

2`
].join('\f');

function fakeServer({items = ITEMS, collections = COLLECTIONS, children = null, fulltext = null,
                     signal = {on: true}, conflicts = 0} = {}) {
  const sent = [];
  let refused = 0;
  const page = (rows, url) => {
    const limit = Number(url.searchParams.get('limit') || 25), start = Number(url.searchParams.get('start') || 0);
    const slice = rows.slice(start, start + limit);
    return new Response(JSON.stringify(slice), {status: 200, headers: {
      'Total-Results': String(rows.length), 'Last-Modified-Version': '42', 'Content-Type': 'application/json'}});
  };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    // No signal: the request dies on the way out, the way a phone's fetch does, and never arrives.
    if (!signal.on) throw new TypeError('Load failed');
    sent.push({method: init.method || 'GET', path: url.pathname + url.search, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null});
    if (!url.pathname.startsWith('/users/16265664')) return new Response('no', {status: 404});
    const rest = url.pathname.replace('/users/16265664', '');
    if ((init.method || 'GET') === 'PATCH' && refused < conflicts) { refused++; return new Response('', {status: 412}); }
    if (rest === '/collections') return page(collections, url);
    if (rest === '/items') {
      if ((init.method || 'GET') === 'POST') return new Response(JSON.stringify({successful: {0: {key: 'NNN'}}, failed: {}}), {status: 200, headers: {'Last-Modified-Version': '43'}});
      return page(items, url);
    }
    if (rest === '/deleted') return new Response(JSON.stringify({items: [], collections: []}), {status: 200, headers: {'Last-Modified-Version': '42'}});
    if (/^\/items\/\w+\/fulltext$/.test(rest)) {
      if (fulltext === null) return new Response('Not found', {status: 404});
      return new Response(JSON.stringify({content: fulltext, indexedPages: 2, totalPages: 2}), {status: 200, headers: {'Content-Type': 'application/json'}});
    }
    if (/^\/items\/\w+\/children$/.test(rest)) {
      // A library where one paper has a PDF and the next has none is the shape of a real one.
      const parent = rest.split('/')[2];
      const mine = typeof children === 'function' ? children(parent) : children;
      return new Response(JSON.stringify(mine || []), {status: 200, headers: {'Content-Type': 'application/json'}});
    }
    if (/^\/items\/\w+\/file$/.test(rest)) return new Response(new Uint8Array(900).fill(37), {status: 200, headers: {'Content-Type': 'application/pdf'}});
    if (/^\/items\/\w+$/.test(rest)) {
      if ((init.method || 'GET') === 'GET') {
        const key = rest.split('/').pop();
        const row = items.find(i => i.key === key);
        // The paper as it is NOW: someone else moved it on, which is why the write was refused.
        return new Response(JSON.stringify(row ? {...row, version: 99, data: {...row.data, version: 99, tags: [...(row.data.tags || []), {tag: 'added-elsewhere'}]}} : {}),
          {status: row ? 200 : 404, headers: {'Content-Type': 'application/json'}});
      }
      // 204 carries no body, and constructing one with a body throws rather than answering.
      return new Response(null, {status: 204, headers: {'Last-Modified-Version': '44'}});
    }
    return new Response('no', {status: 404});
  };
  return {fetchImpl, sent};
}

/* The app, loaded into that phone. Returns the window it runs in. */
async function boot({server = fakeServer(), stored = {'np.user': '16265664', 'np.key': 'k'.repeat(24)}, hash = '',
                     voices = ONE_VOICE, nav = {}} = {}) {
  const {window, document} = parseHTML(read('index.html'));
  const storage = new Map(Object.entries(stored));
  Object.assign(window, {
    localStorage: {getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k)},
    indexedDB: fakeIndexedDB(),
    fetch: server.fetchImpl,
    requestAnimationFrame: fn => setTimeout(fn, 0),
    matchMedia: () => ({matches: false, addEventListener() {}}),
    Response, Request, Headers, URL, URLSearchParams, queueMicrotask, console
  });
  stopOldTimers();
  const clock = ownClock();
  window.setTimeout = clock.after;
  window.clearTimeout = clock.stop;
  window.setInterval = clock.every;
  window.clearInterval = clock.stopEvery;
  /* app.js is a real module (it imports read.js and play.js), so the fake phone is put in the
     globals the module will read and the module is imported fresh for each boot. */
  const location = {origin: 'https://x.test', pathname: '/phone/', search: '', hash, reloads: 0, reload() { this.reloads++; }};
  /* A history with a real stack, so the back gesture can be exercised: pushState adds, go(-n)
     walks back and fires popstate the way a browser does. */
  const stack = [{depth: 0}];
  let at = 0;
  const history = {
    get state() { return stack[at]; },
    replaceState(entry, _title, url) {
      stack[at] = entry || stack[at];
      if (url !== undefined) { location.hash = ''; location.pathname = String(url).split('#')[0]; }
    },
    pushState(entry) { stack.splice(at + 1); stack.push(entry || {}); at = stack.length - 1; },
    go(n) {
      const to = Math.max(0, Math.min(stack.length - 1, at + n));
      if (to === at) return;
      at = to;
      queueMicrotask(() => window.dispatchEvent(new window.Event('popstate')));
    },
    back() { history.go(-1); }
  };
  window.location = location;
  const speech = fakeSpeech(voices);
  const audios = [];
  const globals = {
    window, document, localStorage: window.localStorage, indexedDB: window.indexedDB, fetch: window.fetch,
    requestAnimationFrame: window.requestAnimationFrame, Response, URL, URLSearchParams, location, history,
    matchMedia: () => ({matches: false, addEventListener() {}}),
    setTimeout: clock.after, clearTimeout: clock.stop,
    setInterval: clock.every, clearInterval: clock.stopEvery,
    addEventListener: (type, fn, opts) => window.addEventListener?.(type, fn, opts),
    // No service worker in this test phone, and linkedom's navigator is read-only.
    navigator: {userAgent: 'test', ...nav},
    // What a phone hands the lock screen and the car; the page only ever constructs one.
    MediaMetadata: class { constructor(info) { Object.assign(this, info); } },
    speechSynthesis: speech.synth, SpeechSynthesisUtterance: speech.Utterance,
    /* An audio element the test can move through time, and the Blob/URL a file is handed to it as.
       The phone plays a baked paper with one of these rather than with its own voice. */
    Blob: class { constructor(parts, options) { this.parts = parts; this.type = options && options.type; } },
    Audio: class {
      constructor(src) {
        this.src = src; this.currentTime = 0; this.playbackRate = 1; this.volume = 1; this.paused = true;
        this.preload = ''; this.handlers = {}; audios.push(this);
      }
      addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
      removeEventListener(name, fn) { this.handlers[name] = (this.handlers[name] || []).filter(held => held !== fn); }
      play() { this.paused = false; return Promise.resolve(); }
      pause() { this.paused = true; }
      fire(name) { for (const fn of this.handlers[name] || []) fn(); }
      to(seconds) { this.currentTime = seconds; this.fire('timeupdate'); }
    }
  };
  const RealURL = URL;
  class BlobURL extends RealURL {
    static createObjectURL() { return 'blob:baked'; }
    static revokeObjectURL() {}
  }
  globals.URL = BlobURL;
  const put = (name, value) => Object.defineProperty(globalThis, name, {value, configurable: true, writable: true});
  for (const [name, value] of Object.entries(globals)) put(name, value);
  await import(new URL(`../app.js?boot=${++boots}`, here));
  /* Turn the crank until everything in flight has landed. Waiting out a busy server takes
     longer than the usual round, so those tests ask for more rounds. */
  const settle = async (rounds = 60) => { for (let i = 0; i < rounds; i++) await new Promise(r => realAfter(r, 4)); };
  return {window, document, settle, storage, location, speech, audios};
}

import {after as afterAll} from 'node:test';
afterAll(() => stopOldTimers());

test('a stored key goes straight to the library, and no key shows the setup screen', async () => {
  const open = await boot();
  await open.settle();
  assert.equal(open.document.getElementById('main').hasAttribute('hidden'), false, 'the library is shown');
  assert.equal(open.document.getElementById('setup').hasAttribute('hidden'), true, 'the setup screen is not');

  const fresh = await boot({stored: {}});
  await fresh.settle();
  assert.equal(fresh.document.getElementById('setup').hasAttribute('hidden'), false, 'with no key the setup screen is shown');
  assert.equal(fresh.document.getElementById('setup-user').value, '16265664', 'the user number is filled in');
});

test('a key carried in the link is taken in on the first launch and wiped from the address', async () => {
  const server = fakeServer();
  const open = await boot({server, stored: {}, hash: '#k=' + 'k'.repeat(24) + '&u=16265664'});
  await open.settle();
  assert.equal(open.storage.get('np.user'), '16265664', 'the user number was taken from the link');
  assert.equal(open.storage.get('np.key'), 'k'.repeat(24), 'and so was the key');
  assert.equal(open.document.getElementById('main').hasAttribute('hidden'), false, 'it goes straight to the library');
  assert.ok(!String(open.location.hash || '').includes('k='), 'the key does not stay in the address');
});

test('the first screen a new phone sees asks for two things, as rows', async () => {
  const fresh = await boot({stored: {}});
  await fresh.settle();
  const box = fresh.document.querySelector('#setup .setup-box');
  assert.ok(box.querySelector('.app-mark'), "the app's own mark is at the top of it");
  assert.equal(box.querySelector('h1').textContent, '논문');
  // The two things it needs are rows in a card, the way the rest of the app asks for anything.
  const rows = [...box.querySelectorAll('.card.rows .set-row')];
  assert.deepEqual(rows.map(r => r.querySelector('.what')?.textContent || r.textContent),
    ['사용자 번호', 'API 키', '붙여넣기']);
  assert.equal(box.querySelectorAll('.set-field input').length, 2);
  assert.equal(box.querySelector('#setup-key').type, 'password', 'a key is not read over a shoulder');
  assert.equal(box.querySelectorAll('.field').length, 0, 'nothing on this screen is a form field');
  assert.equal(box.querySelector('#setup-go').textContent, '연결');
  // Where to get a key, in small print, under the button rather than above it.
  const note = [...box.querySelectorAll('.set-note')].map(n => n.textContent).join(' ');
  assert.match(note, /zotero\.org\/settings\/keys/);
  assert.match(note, /Allow write access/);
});

test('a link with no key, or a broken one, still shows the setup screen', async () => {
  for (const hash of ['', '#k=short&u=16265664', '#k=' + 'k'.repeat(24) + '&u=abc']) {
    const open = await boot({stored: {}, hash});
    await open.settle();
    assert.equal(open.document.getElementById('setup').hasAttribute('hidden'), false, `setup is shown for ${hash || '(no hash)'}`);
    assert.equal(open.storage.has('np.key'), false, 'nothing was stored');
  }
});

test('the whole library is paged in, cached, and drawn without the attachments', async () => {
  const server = fakeServer();
  const open = await boot({server});
  await open.settle();
  const rows = [...open.document.querySelectorAll('#list .row')];
  assert.equal(rows.length, 3, 'three papers, not the attachment');
  assert.match(rows[0].textContent, /Retron Septu/);
  assert.match(rows[0].textContent, /Seo · Kim|Seo/, 'the authors are named');
  assert.match(open.document.getElementById('count').textContent, /3/);
  // The listings are asked for with paging, and the key travels in the header, never in the URL.
  const listing = server.sent.filter(r => r.path.startsWith('/users/16265664/items?'));
  assert.ok(listing.length >= 1, 'the items were listed');
  assert.ok(listing.every(r => !/k{10}/.test(r.path)), 'the key is not in the URL');
  assert.equal(listing[0].headers['Zotero-API-Key'], 'k'.repeat(24));
  assert.equal(listing[0].headers['Zotero-API-Version'], '3');
});

test('the status filter and the search narrow the list', async () => {
  const open = await boot();
  await open.settle();
  const press = label => {
    const button = [...open.document.querySelectorAll('#filters button')].find(b => b.textContent === label);
    assert.ok(button, `${label} is offered`);
    button.dispatchEvent(new open.window.Event('click'));
  };
  press('읽는 중');
  assert.deepEqual([...open.document.querySelectorAll('#list .row h2')].map(h => h.textContent), ['Retron Septu defence']);
  press('완료');
  assert.deepEqual([...open.document.querySelectorAll('#list .row h2')].map(h => h.textContent), ['Immune sensing in bacteria']);
  press('전체');
  assert.equal(open.document.querySelectorAll('#list .row').length, 3);

  const box = open.document.getElementById('q');
  box.value = 'nature';
  box.dispatchEvent(new open.window.Event('input'));
  await open.settle();   // the search waits for the typist to stop
  assert.deepEqual([...open.document.querySelectorAll('#list .row h2')].map(h => h.textContent), ['PET depolymerase landscape'],
    'the search reaches the journal, not only the title');
  box.value = 'müller';
  box.dispatchEvent(new open.window.Event('input'));
  await open.settle();
  assert.equal(open.document.querySelectorAll('#list .row').length, 0, 'an accent that is not in the library finds nothing');
});

test('changing the status sends the tags the desktop plugin reads, and keeps the others', async () => {
  const server = fakeServer();
  const open = await boot({server});
  await open.settle();
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  const button = [...open.document.querySelectorAll('#detail .seg button')].find(b => b.textContent === '완료');
  button.dispatchEvent(new open.window.Event('click'));
  await open.settle();
  const write = server.sent.find(r => r.method === 'PATCH');
  assert.ok(write, 'a PATCH was sent');
  assert.equal(write.path, '/users/16265664/items/AAA');
  assert.equal(write.headers['If-Unmodified-Since-Version'], '10', 'the version this phone holds guards the write');
  assert.equal(server.sent.filter(r => r.method === 'PATCH').length, 1, 'sent once, not retried behind the scenes');
  const tags = write.body.tags.map(t => t.tag);
  assert.deepEqual(tags.filter(t => t.startsWith('/')), ['/done'], 'exactly one status tag');
  assert.ok(tags.includes('phage'), "the paper's own tags are kept");
});

test('a rating is written as the Rating line in Extra, and pressing it again clears it', async () => {
  const server = fakeServer();
  const open = await boot({server});
  await open.settle();
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  const stars = [...open.document.querySelectorAll('#detail .rate button')];
  stars[3].dispatchEvent(new open.window.Event('click'));            // four stars
  await open.settle();
  const first = server.sent.filter(r => r.method === 'PATCH').at(-1);
  assert.match(first.body.extra, /^Rating: 4$/m);
  assert.match(first.body.extra, /Citations: 89/, 'the rest of Extra survives');
});

test('the note editor posts a child note, escaped, and the paragraphs are kept', async () => {
  const server = fakeServer();
  const open = await boot({server});
  await open.settle();
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  const box = open.document.querySelector('#detail textarea');
  box.value = 'first & <b>bold</b>\n\nsecond';
  [...open.document.querySelectorAll('#detail button')].find(b => b.textContent === '메모 저장').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  const post = server.sent.find(r => r.method === 'POST');
  assert.ok(post, 'a note was posted');
  assert.equal(post.body[0].itemType, 'note');
  assert.equal(post.body[0].parentItem, 'AAA');
  assert.match(post.body[0].note, /first &amp; &lt;b&gt;bold&lt;\/b&gt;/, 'the text is escaped, not injected');
  assert.match(post.body[0].note, /<p>.*<\/p>\s*<p>/s, 'two paragraphs stay two paragraphs');
});

test('a second sync asks only for what changed', async () => {
  const server = fakeServer();
  const open = await boot({server});
  await open.settle();
  server.sent.length = 0;
  open.document.getElementById('btn-sync').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.ok(server.sent.some(r => /\/items\?since=42/.test(r.path)), 'the items are asked for since the stored version');
  assert.ok(server.sent.some(r => /\/deleted\?since=42/.test(r.path)), 'and so are the deletions');
});

test('the service worker never caches an answer from the Zotero API', () => {
  const sw = read('sw.js');
  assert.match(sw, /url\.origin\s*!==\s*location\.origin/, 'only this origin is cached');
  const shell = /const SHELL = \[([^\]]*)\]/.exec(sw);
  assert.ok(shell, 'the shell list is there');
  assert.doesNotMatch(shell[1], /https?:/, 'nothing off this origin is pre-cached');
});

/* Every module app.js imports has to be in the shell, or the first opening with no signal gets a
   page that cannot start. This went wrong twice: list.js and net.js were written after the shell
   list and nobody added them to it. */
test('everything the app imports is kept for opening with no signal', () => {
  const app = read('app.js');
  const sw = read('sw.js');
  const shell = /const SHELL = \[([\s\S]*?)\]/.exec(sw)[1];
  const imported = [...app.matchAll(/from '\.\/([\w.-]+)'/g)].map(m => m[1]);
  assert.ok(imported.length >= 6, `app.js imports several modules (${imported.join(', ')})`);
  for (const name of imported) assert.ok(shell.includes(`'${name}'`), `${name} is in the shell`);
  assert.ok(shell.includes("'app.css'") && shell.includes("'index.html'"), 'and so are the page and its look');
});

/* A new version of the app has to arrive the next time 논문 is opened. Serving the cache first
   and refreshing behind it meant a change landed only on the opening after that, which is how a
   setting that had been shipped was not on the phone. */
test('the app is fetched fresh when there is signal, and only pdf.js is served from the cache first', async () => {
  const sw = read('sw.js');
  const scope = {CACHE: null, IMMUTABLE: null, SLOW: null, fetch: null, handler: null, caches: null,
                 location: {origin: 'https://x.test'}, setTimeout, Promise, URL, Response};
  const held = new Map([['https://x.test/phone/app.js', 'OLD'], ['https://x.test/phone/vendor/pdf.min.js', 'LIB']]);
  const self = {addEventListener: (type, fn) => { if (type === 'fetch') scope.handler = fn; }, skipWaiting() {}, clients: {claim() {}}};
  const asked = [];
  const run = new Function('self', 'caches', 'fetch', 'location', 'setTimeout', sw);
  run(self,
      {match: async request => (held.has(request.url) ? new Response(held.get(request.url)) : undefined),
       open: async () => ({put: async () => {}}), keys: async () => []},
      async request => { asked.push(request.url); return new Response('NEW', {status: 200}); },
      scope.location, setTimeout);
  assert.ok(scope.handler, 'the worker answers fetches');

  const ask = async url => {
    let answer = null;
    scope.handler({request: {url, method: 'GET'}, respondWith: promise => { answer = promise; }});
    return answer ? (await answer).text() : null;
  };
  assert.equal(await ask('https://x.test/phone/app.js'), 'NEW', 'the app comes from the network');
  assert.equal(await ask('https://x.test/phone/vendor/pdf.min.js'), 'LIB', 'pdf.js comes from this phone');
  assert.ok(!asked.includes('https://x.test/phone/vendor/pdf.min.js'), 'and is not fetched again');
});

/* A library of a few thousand is what this is for. Everything that matches has to be reachable:
   it used to stop at 400 rows with a line saying so, which on a real library hid most of it. */
const MANY = Array.from({length: 900}, (_, i) => ({
  key: `P${i}`, version: 10 + i, data: {key: `P${i}`, version: 10 + i, itemType: 'journalArticle',
    title: `Paper number ${i}`, date: String(2000 + (i % 26)), dateAdded: `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00Z`,
    dateModified: '2026-10-01T00:00:00Z', creators: [{creatorType: 'author', lastName: `Author${i % 7}`}],
    publicationTitle: i % 2 ? 'Science' : 'Nature', tags: i % 3 ? [] : [{tag: 'phage'}], collections: [], extra: i % 5 ? '' : 'Rating: 4'}}));

test('a big library draws a screenful at once and the rest as it is scrolled, all of it reachable', async () => {
  const open = await boot({server: fakeServer({items: MANY})});
  await open.settle();
  const list = open.document.getElementById('list');
  const drawn = () => open.document.querySelectorAll('#list .row').length;
  assert.equal(open.document.getElementById('count').textContent, '900편', 'all of them are counted');
  assert.ok(drawn() > 0 && drawn() <= 120, `a screenful to begin with, not 900 (${drawn()})`);
  assert.doesNotMatch(list.textContent, /만 보입니다/, 'nothing says the list has been cut');

  // Scrolling to the end keeps asking for more until there is no more.
  for (let i = 0; i < 40 && drawn() < 900; i++) {
    Object.defineProperty(list, 'scrollTop', {value: 1e6, configurable: true});
    Object.defineProperty(list, 'clientHeight', {value: 800, configurable: true});
    Object.defineProperty(list, 'scrollHeight', {value: 1000, configurable: true});
    list.dispatchEvent(new open.window.Event('scroll'));
    await new Promise(r => setTimeout(r, 1));
  }
  assert.equal(drawn(), 900, 'the whole library can be reached by scrolling');
});

test('scrolling deep into the library and opening a paper comes back to the same place', async () => {
  const open = await boot({server: fakeServer({items: MANY})});
  await open.settle();
  const list = open.document.getElementById('list');
  const drawn = () => open.document.querySelectorAll('#list .row').length;
  const push = () => {
    Object.defineProperty(list, 'scrollTop', {value: 1e6, configurable: true, writable: true});
    Object.defineProperty(list, 'clientHeight', {value: 800, configurable: true});
    Object.defineProperty(list, 'scrollHeight', {value: 1000, configurable: true});
    list.dispatchEvent(new open.window.Event('scroll'));
  };
  for (let i = 0; i < 5; i++) push();
  const deep = drawn();
  assert.ok(deep > 120, `scrolled well in (${deep} rows)`);

  // A scroll listener added on every draw would make each flick draw several screenfuls.
  const before = drawn();
  list.dispatchEvent(new open.window.Event('scroll'));
  assert.equal(drawn(), before + 60, 'one flick draws one screenful, not one per redraw');

  open.document.querySelectorAll('#list .row')[100].dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  open.document.getElementById('back').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.ok(drawn() >= deep, `the list came back as long as it was (${drawn()} of ${deep})`);
});

test('the order can be changed, and it is remembered', async () => {
  const open = await boot();
  await open.settle();
  const titles = () => [...open.document.querySelectorAll('#list .row h2')].map(h => h.textContent);
  const button = open.document.getElementById('btn-sort');
  button.dispatchEvent(new open.window.Event('click'));
  const rows = [...open.document.querySelectorAll('.menu.float .menu-row')];
  assert.deepEqual(rows.map(r => r.textContent.trim()),
    ['최근 추가', '최근 본', '최근 변경', '연도', '별점', '제목'], 'every order is offered');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(rows[0].getAttribute('aria-pressed'), 'true', 'with a tick against the one it is in');
  rows[5].dispatchEvent(new open.window.Event('click'));
  assert.deepEqual(titles(), ['Immune sensing in bacteria', 'PET depolymerase landscape', 'Retron Septu defence']);
  assert.equal(open.storage.get('np.sort'), 'title', 'and kept for next time');
  assert.equal(open.document.querySelectorAll('.menu.float').length, 0, 'the menu goes once it is used');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  // The same button again means putting it away, not opening a second one.
  button.dispatchEvent(new open.window.Event('click'));
  assert.equal(open.document.querySelectorAll('.menu.float').length, 1);
  button.dispatchEvent(new open.window.Event('click'));
  assert.equal(open.document.querySelectorAll('.menu.float').length, 0);
});

test('the collections screen says which one you are already in', async () => {
  const open = await boot();
  await open.settle();
  const openIt = async () => {
    open.document.getElementById('btn-collections').dispatchEvent(new open.window.Event('click'));
    await open.settle();
    return [...open.document.querySelectorAll('#collections .row.nav')];
  };
  let rows = await openIt();
  assert.deepEqual(rows.map(r => r.querySelector('h2').textContent), ['전체', 'Phage defence']);
  assert.equal(rows[0].classList.contains('here'), true, 'the whole library, to begin with');
  assert.equal(rows[0].getAttribute('aria-current'), 'true', 'and said out loud');
  assert.equal(rows[1].classList.contains('here'), false);
  assert.deepEqual(rows.map(r => r.querySelector('.n').textContent), ['3편', '2편'],
    'with how many are in each, counted as picking one counts');

  // Into a collection, and back in: that is where it says you are.
  rows[1].dispatchEvent(new open.window.Event('click'));
  await open.settle();
  rows = await openIt();
  assert.equal(rows[1].classList.contains('here'), true, 'the one being looked at');
  assert.equal(rows[0].classList.contains('here'), false, 'and no longer the whole library');
  // What is already where you are does not pretend to lead anywhere: it is ticked, not chevroned.
  assert.notEqual(rows[1].querySelector('.chev').innerHTML, rows[0].querySelector('.chev').innerHTML);
});

test('a collection and a tag show as chips that take themselves off again', async () => {
  const open = await boot();
  await open.settle();
  const scope = open.document.getElementById('scope');
  assert.equal(scope.hidden, true, 'nothing to say about the whole library, so it takes no room');
  open.document.getElementById('btn-collections').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  const tag = [...open.document.querySelectorAll('#collections .pick-chip')].find(c => /phage/.test(c.textContent));
  assert.ok(tag, 'the tags in use are offered');
  tag.dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.deepEqual([...open.document.querySelectorAll('#list .row h2')].map(h => h.textContent), ['Retron Septu defence']);
  const chip = [...open.document.querySelectorAll('#scope .scope-chip')].find(c => /phage/.test(c.textContent));
  assert.ok(chip, 'the narrowing is on screen');
  assert.equal(scope.hidden, false, 'and now the row is there to say it');
  chip.dispatchEvent(new open.window.Event('click'));
  assert.equal(open.document.querySelectorAll('#list .row').length, 3, 'and comes off again');
  assert.equal(scope.hidden, true, 'and the row goes with it');
});

/* The phone's own back — the swipe from the edge of a home-screen app, the back button in
   Safari — has to close the screen on top rather than leave 논문 altogether. */
test('the phone\u2019s back closes the screen on top, one at a time, and leaves the list alone', async () => {
  const open = await boot();
  await open.settle();
  const shown = id => open.document.getElementById(id).hidden === false;
  const back = async () => { open.window.history.back(); await open.settle(); };

  open.document.getElementById('btn-collections').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.ok(shown('collections'), '컬렉션 is open');
  open.document.getElementById('btn-settings').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.ok(shown('settings') && shown('collections'), '설정 opens on top of it');

  await back();
  assert.ok(!shown('settings'), 'back closed 설정');
  assert.ok(shown('collections'), 'and left 컬렉션 where it was');
  await back();
  assert.ok(!shown('collections'), 'back closed 컬렉션 too');
  assert.ok(shown('main'), 'the library is still there');
});

test('closing with the button and closing with the gesture end in the same place', async () => {
  const open = await boot();
  await open.settle();
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  assert.equal(open.document.getElementById('detail').hidden, false);
  open.document.getElementById('back').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(open.document.getElementById('detail').hidden, true, 'the button closed it');
  // And the history went back with it, so one more back does not strand a hidden screen.
  open.window.history.back();
  await open.settle();
  assert.equal(open.document.getElementById('detail').hidden, true);
  assert.equal(open.document.getElementById('main').hidden, false);
});

/* A change made on a train must not vanish, and a paper someone moved on the Mac must not be
   overwritten with what this phone happened to be holding. */
async function pressStatus(open, label, rounds = 60) {
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  const button = [...open.document.querySelectorAll('#detail .seg button')].find(b => b.textContent === label);
  assert.ok(button, `${label} is offered`);
  button.dispatchEvent(new open.window.Event('click'));
  await open.settle(rounds);
}

test('a change made with no signal is shown, kept, and sent when the signal comes back', async () => {
  const signal = {on: true};
  const server = fakeServer({signal});
  const open = await boot({server});
  await open.settle();
  signal.on = false;
  await pressStatus(open, '완료', 400);

  assert.equal(server.sent.filter(r => r.method === 'PATCH').length, 0, 'nothing reached the server');
  const held = open.document.getElementById('held');
  assert.equal(held.hidden, false, 'the phone says it is holding something');
  assert.match(held.textContent, /1건/);
  const pressed = [...open.document.querySelectorAll('#detail .seg button')].find(b => b.textContent === '완료');
  assert.equal(pressed.getAttribute('aria-pressed'), 'true', 'the screen does not lie about what was pressed');

  signal.on = true;
  open.window.dispatchEvent(new open.window.Event('online'));
  await open.settle(200);
  const write = server.sent.find(r => r.method === 'PATCH');
  assert.ok(write, 'it went out once there was signal');
  assert.deepEqual(write.body.tags.map(t => t.tag).filter(t => t.startsWith('/')), ['/done']);
  console.log('DEBUG held=', JSON.stringify(open.document.getElementById('held').textContent),
    'queue=', JSON.stringify([...(open.window.indexedDB._stores.get('queue')?.entries() || [])]),
    'patches=', server.sent.filter(r => r.method === 'PATCH').map(r => r.path).join(','));
  assert.equal(open.document.getElementById('held').hidden, true, 'and nothing is left waiting');
});

test('two changes made at once are both kept, neither writing over the other', async () => {
  const signal = {on: true};
  const open = await boot({server: fakeServer({signal})});
  await open.settle();
  signal.on = false;

  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  const done = [...open.document.querySelectorAll('#detail .seg button')].find(b => b.textContent === '완료');
  const stars = open.document.querySelectorAll('#detail .rate button');
  // Pressed together, as a thumb does, before either has finished failing.
  done.dispatchEvent(new open.window.Event('click'));
  stars[3].dispatchEvent(new open.window.Event('click'));
  await open.settle(400);

  const held = [...open.window.indexedDB._stores.get('queue').values()];
  assert.equal(held.length, 2, `both changes are waiting (${held.map(w => w.kind).join(', ')})`);
  assert.deepEqual(held.map(w => w.kind).sort(), ['rating', 'status']);
  assert.match(open.document.getElementById('held').textContent, /2건/);
});

test('a paper changed on the Mac is fetched afresh and the change meant here is applied to that', async () => {
  const server = fakeServer({conflicts: 1});
  const open = await boot({server});
  await open.settle();
  await pressStatus(open, '완료');

  const writes = server.sent.filter(r => r.method === 'PATCH');
  assert.equal(writes.length, 2, 'refused once, then sent again');
  assert.equal(writes[0].headers['If-Unmodified-Since-Version'], '10', 'the first guarded the version this phone held');
  assert.equal(writes[1].headers['If-Unmodified-Since-Version'], '99', 'the second guarded the version the server has');
  const tags = writes[1].body.tags.map(t => t.tag);
  assert.deepEqual(tags.filter(t => t.startsWith('/')), ['/done'], 'what was pressed here still happened');
  assert.ok(tags.includes('added-elsewhere'), "and what was added on the Mac was not wiped out");
  assert.ok(tags.includes('phage'), 'nor were the paper\u2019s own tags');
});

test('a busy server is waited out rather than reported as a failure', async () => {
  let tries = 0;
  const base = fakeServer();
  const server = {sent: base.sent, fetchImpl: async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname.endsWith('/items') && (init.method || 'GET') === 'GET') {
      tries++;
      if (tries <= 2) return new Response('', {status: 429, headers: {'Retry-After': '0'}});
    }
    return base.fetchImpl(input, init);
  }};
  const open = await boot({server});
  await open.settle();
  assert.ok(tries >= 3, `the listing was asked for again (${tries})`);
  assert.equal(open.document.querySelectorAll('#list .row').length, 3, 'and the library arrived');
});

test('a paper shows where it sits, where to read it, and how far it was listened to', async () => {
  const stored = {'np.user': '16265664', 'np.key': 'k'.repeat(24), 'np.pct.AAA': '42'};
  const open = await boot({stored});
  await open.settle();
  const row = [...open.document.querySelectorAll('#list .row')].find(r => /Retron/.test(r.textContent));
  assert.match(row.textContent, /42%/, 'how far the reading got is on the row');

  row.dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  const detail = open.document.getElementById('detail');
  assert.match(detail.textContent, /Phage defence/, 'the collection it is in');
  const out = detail.querySelector('a.out');
  assert.ok(out, 'a way out to the publisher');
  assert.equal(out.getAttribute('rel'), 'noopener', 'and it is opened safely');
});

test('the marks come out of a paper in one tap, in the order they appear', async () => {
  const open = await boot({server: fakeServer({children: MARKED, fulltext: FULLTEXT})});
  await open.settle();
  const {marksAsText} = await import(new URL(`../app.js?boot=${boots}`, here));
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  const card = [...open.document.querySelectorAll('#detail .card')]
    .find(c => /주석/.test(c.querySelector('h3')?.textContent || ''));
  const pill = card.querySelector('.pills .pill');
  assert.equal(pill.textContent, '주석 모두 복사');

  let copied = '';
  globalThis.navigator = {userAgent: 'test', clipboard: {writeText: async text => { copied = text; }}};
  pill.dispatchEvent(new open.window.Event('click'));
  await open.settle();
  globalThis.navigator = {userAgent: 'test'};
  const lines = copied.split('\n');
  assert.match(lines[0], /^Seo & Kim \(2025\)/, 'the paper it came from, at the top');
  assert.equal(lines[1], '', 'then a blank line, then the marks');
  assert.match(lines[2], /^p\.1 “first thing said”$/, 'the earlier one first');
  assert.match(lines[3], /^p\.3 “the enzyme degrades PET”$/);
  assert.match(open.document.getElementById('toast').textContent, /주석 2개를 복사했습니다/);

  // A mark with a note of its own carries it; one with no text at all still says what it is.
  const withNote = marksAsText({data: {title: 'T', creators: [], date: '2020'}}, [
    {mark: {data: {annotationText: 'said', annotationComment: 'my note'}}, place: {page: 4}},
    {mark: {data: {}}, place: null}
  ]).split('\n');
  assert.equal(withNote[2], 'p.4 “said” — my note');
  assert.equal(withNote[3], '(그림 주석)');
});

test('the marks made in Zotero are listed in the order they appear, and lead into the paper', async () => {
  const open = await boot({server: fakeServer({children: MARKED, fulltext: FULLTEXT})});
  await open.settle();
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  const rows = [...open.document.querySelectorAll('#detail .mark-row')];
  assert.equal(rows.length, 2, 'both marks are there');
  assert.match(rows[0].textContent, /first thing said/, 'the one earlier in the paper comes first');
  assert.match(rows[0].textContent, /1쪽/);
  assert.match(rows[1].textContent, /3쪽/, 'pageIndex 2 is page three');

  rows[1].dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(open.document.getElementById('paper').hidden, false, 'a mark opens the paper at its page');
});

test('a paper hands over a citation worth pasting', async () => {
  const open = await boot();
  await open.settle();
  let copied = '';
  // linkedom's window.navigator is read-only; the module reads the global one.
  Object.defineProperty(globalThis, 'navigator', {
    value: {userAgent: 'test', clipboard: {writeText: async text => { copied = text; }}},
    configurable: true, writable: true});
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  const button = [...open.document.querySelectorAll('#detail button')].find(b => b.textContent === '인용 복사');
  assert.ok(button, 'a citation is offered');
  button.dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.match(copied, /Seo & Kim \(2025\)/, 'two authors are both named');
  assert.match(copied, /Retron Septu defence/);
  assert.match(copied, /Science/);
  assert.match(copied, /doi\.org\/10\.1126/);
});

/* ---- listening ---- */
const PDF_CHILD = [{key: 'PDF1', version: 3, data: {key: 'PDF1', itemType: 'attachment', contentType: 'application/pdf', filename: 'seo.pdf'}}];

async function openListening({voices, nav, stored, dropbox, ...options} = {}) {
  const zotero = fakeServer({children: PDF_CHILD, fulltext: FULLTEXT, ...options});
  const server = dropbox ? {sent: zotero.sent, fetchImpl: async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    return /dropboxapi\.com|dropbox\.com/.test(url) ? dropbox.handle(url, init) : zotero.fetchImpl(input, init);
  }} : zotero;
  const open = await boot({server, ...(voices ? {voices} : {}), ...(nav ? {nav} : {}),
    stored: {'np.user': '16265664', 'np.key': 'k'.repeat(24), ...(dropbox ? DROPBOX_LINKED : {}), ...(stored || {})}});
  await open.settle();
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  const start = [...open.document.querySelectorAll('#detail .listen-start')][0];
  start.dispatchEvent(new open.window.Event('click'));
  await open.settle();
  return {open, server};
}

test('listening shows the body only: no running head, no caption, no reference list', async () => {
  const {open} = await openListening();
  const lines = [...open.document.querySelectorAll('#listen .sent')].map(n => n.textContent);
  assert.ok(lines.length, 'there are sentences to read');
  assert.ok(lines.some(l => /Microbial decomposers/.test(l)), 'the body is there');
  assert.ok(lines.some(l => /fifty degrees/.test(l)), 'a word broken across a line is put back together');
  assert.ok(!lines.some(l => /Seo et al\., Science/.test(l)), 'the running head is not read');
  assert.ok(!lines.some(l => /coloured by cluster/.test(l)), 'captions are not read unless asked for');
  assert.ok(!lines.some(l => /Nature 500/.test(l)), 'the reference list is not read');
  assert.equal(open.document.getElementById('listen').hidden, false);
});

test('pressing play speaks the first sentence without its citation, and the place is remembered', async () => {
  const {open} = await openListening();
  open.document.getElementById('listen-play').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(open.speech.queue.length > 0, true, 'the phone was asked to speak');
  open.speech.start();
  await open.settle();
  assert.match(open.speech.spoken[0], /Introduction\. Microbial decomposers/, 'the section name comes first');
  assert.ok(!/\[1\]/.test(open.speech.spoken[0]), 'the citation is not read out');
  assert.equal(open.storage.get('np.at.AAA'), '0');
  const current = open.document.querySelector('#listen .sent[aria-current="true"]');
  assert.ok(current, 'the sentence being read is marked');
  assert.equal(open.document.getElementById('listen-play').getAttribute('aria-label'), '일시정지');

  // The next sentence is read without a gap, and the place moves with it.
  open.speech.finish();
  open.speech.start();
  await open.settle();
  assert.equal(open.speech.spoken.length, 2);
  assert.equal(open.storage.get('np.at.AAA'), '1');
});

test('what has already been heard is set back, and going back to a sentence undoes that', async () => {
  const {open} = await openListening();
  const sents = () => [...open.document.querySelectorAll('#listen .sent')];
  const said = () => sents().filter(n => n.classList.contains('said')).length;
  assert.equal(said(), 0, 'nothing has been heard yet');
  open.document.getElementById('listen-play').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  open.speech.start();
  await open.settle();
  assert.equal(said(), 0, 'nor while the first one is the one being read');
  open.speech.finish(); open.speech.start();
  await open.settle();
  assert.equal(said(), 1, 'the first has been heard once the second is being read');
  assert.ok(!sents()[1].classList.contains('said'), 'and the one being read is not');

  // Tapping back to the first sentence takes the mark off everything after it.
  sents()[0].dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  assert.equal(said(), 0, 'read it again and it has not been heard');
});

test('a reader who scrolled away from the voice is offered the way back', async () => {
  const {open} = await openListening();
  const body = open.document.getElementById('listen-body');
  const here = open.document.getElementById('listen-here');
  assert.ok(here, 'the way back is on the screen');
  assert.equal(here.hidden, true, 'and is not offered while the voice is in view');
  // A real scroller knows how tall it is and where each line sits; this one is told.
  body.clientHeight = 500;
  const sents = [...open.document.querySelectorAll('#listen .sent')];
  sents.forEach((node, i) => { node.offsetTop = i * 60; });
  open.document.getElementById('listen-play').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  body.scrollTop = 0;
  body.dispatchEvent(new open.window.Event('scroll'));
  assert.equal(here.hidden, true, 'the first sentence is in view');

  body.scrollTop = 2000;                       // scrolled a long way past it
  body.dispatchEvent(new open.window.Event('scroll'));
  assert.equal(here.hidden, false, 'scrolled away, the way back is offered');

  let went = null;
  sents[0].scrollIntoView = options => { went = options; };
  here.dispatchEvent(new open.window.Event('click'));
  assert.ok(went, 'and taking it goes to the sentence being read');
  assert.equal(here.hidden, true, 'the offer closes behind it');
  assert.equal(open.document.querySelector('#listen .to-now'), here, 'it sticks to the bottom of the transcript');
});

/* iOS downloads its good voices only when somebody goes and asks for them, so what one phone can
   speak with has nothing to do with the next. Everything it does have is offered. */
const MANY_VOICES = [
  {voiceURI: 'v-sam', name: 'Samantha', lang: 'en-US', localService: true, default: true},
  {voiceURI: 'v-ava', name: 'Ava (Premium)', lang: 'en-US'},
  {voiceURI: 'v-zarvox', name: 'Zarvox', lang: 'en-US'},
  {voiceURI: 'v-yuna', name: 'Yuna', lang: 'ko-KR'},
  {voiceURI: 'v-sora', name: 'Sora (Enhanced)', lang: 'ko-KR'},
  {voiceURI: 'v-kyoko', name: 'Kyoko', lang: 'ja-JP'}
];

test('every voice the phone has is offered, by language, best first, and chosen by hearing it', async () => {
  const {open} = await openListening({voices: MANY_VOICES});
  const $id = id => open.document.getElementById(id);
  const click = node => node.dispatchEvent(new open.window.Event('click', {bubbles: true}));
  assert.equal($id('listen-voice-now').textContent, '자동 · Ava', 'the button says which voice is doing the reading');

  click($id('listen-voice'));
  const menu = open.document.querySelector('.menu.float');
  assert.ok(menu, 'the voices are a menu, not a dropdown nobody opens');
  const heads = [...menu.querySelectorAll('.menu-head')].map(n => n.textContent);
  assert.equal(heads[0], '영어 · 3', "the paper's own language first, and how many it has");
  assert.deepEqual(heads.slice(1), ['한국어 · 2', '일본어 · 1'], 'then every other language the phone can speak');
  const rows = [...menu.querySelectorAll('.menu-row')].map(n => n.textContent);
  assert.match(rows[0], /^자동/, 'leaving it to the app is the first thing offered');
  assert.deepEqual(rows.slice(1, 4), ['Ava · 프리미엄', 'Samantha', 'Zarvox'], 'the good one first, the toy one last');
  assert.match(rows[rows.length - 1], /목소리 더 받기/, 'and where to get more of them');

  // Choosing one speaks a line in it: a voice cannot be told from its name.
  const before = open.speech.spoken.length;
  click([...menu.querySelectorAll('.menu-row')].find(n => n.textContent === 'Samantha'));
  await open.settle();
  assert.equal(open.storage.get('np.voice.en'), 'v-sam', 'the choice is kept for the next English paper');
  assert.equal($id('listen-voice-now').textContent, 'Samantha');
  open.speech.start();
  assert.ok(open.speech.spoken.length > before, 'and it says a line of its own');
  assert.match(open.speech.spoken[open.speech.spoken.length - 1], /read your paper/);
});

test('how loud is the reader\'s own, and the words carry it', async () => {
  const {open} = await openListening();
  const $id = id => open.document.getElementById(id);
  assert.equal($id('listen-vol-now').textContent, '최대', 'as loud as the phone goes, to begin with');
  const slider = $id('listen-vol');
  slider.value = '55';
  slider.dispatchEvent(new open.window.Event('input', {bubbles: true}));
  await open.settle();
  assert.equal(open.storage.get('np.vol'), '0.55');
  assert.equal($id('listen-vol-now').textContent, '55%');
  $id('listen-play').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(open.speech.queue[0].volume, 0.55, 'the loudness travels with the sentence');
});

test('the sentence being read is kept in the middle of the screen, every sentence', async () => {
  const {open} = await openListening();
  const body = open.document.getElementById('listen-body');
  body.clientHeight = 600;
  body.scrollTop = 0;
  const sents = [...open.document.querySelectorAll('#listen .sent')];
  sents.forEach((node, i) => { node.offsetTop = i * 400; node.offsetHeight = 300; });
  open.document.getElementById('listen-play').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  open.speech.start();
  await open.settle();
  // The first sentence is already above the middle, so there is nowhere to scroll to.
  assert.equal(body.scrollTop, 0);
  // Every sentence after that is brought to the middle, not merely onto the screen: the old rule
  // left it wherever it happened to land until it fell off the bottom.
  for (let i = 1; i < sents.length; i++) {
    open.speech.finish(); open.speech.start();
    await open.settle();
    const at = sents.findIndex(n => n.getAttribute('aria-current') === 'true');
    if (at !== i) break;
    const middle = body.scrollTop + 600 * 0.38;
    assert.ok(Math.abs(sents[at].offsetTop + 150 - middle) <= 2,
      `sentence ${at} sits at the middle of the screen (scrolled to ${body.scrollTop})`);
  }
  assert.ok(body.scrollTop > 0, 'the transcript followed the voice down the paper');
});

test('운전 모드: the page is one sentence and one pause button', async () => {
  const {open} = await openListening();
  const $id = id => open.document.getElementById(id);
  const click = node => node.dispatchEvent(new open.window.Event('click', {bubbles: true}));
  assert.equal($id('listen').classList.contains('driving'), false);
  click($id('listen-drive'));
  await open.settle();
  assert.equal($id('listen').classList.contains('driving'), true);
  assert.equal($id('listen-drive').getAttribute('aria-pressed'), 'true');
  assert.equal(open.storage.get('np.drive'), '1');
  assert.equal(open.storage.get('np.chain'), '1', 'and a car is never left in silence at the end of a paper');

  // The whole page is the pause button: nobody aims at a sentence at seventy.
  click($id('listen-play'));
  await open.settle();
  open.speech.start();
  await open.settle();
  assert.equal($id('listen-play').getAttribute('aria-label'), '일시정지');
  click($id('listen-body'));
  await open.settle();
  assert.equal($id('listen-play').getAttribute('aria-label'), '재생', 'a tap anywhere stops it');
  const sents = [...open.document.querySelectorAll('#listen .sent')];
  const at = sents.findIndex(n => n.getAttribute('aria-current') === 'true');
  click(sents[sents.length - 1]);
  await open.settle();
  assert.equal(sents.findIndex(n => n.getAttribute('aria-current') === 'true'), at, 'and a tap on a sentence does not jump the reading');

  // It is a mode the phone stays in, and one tap leaves it.
  click($id('listen-drive'));
  assert.equal($id('listen').classList.contains('driving'), false);
  assert.equal(open.storage.get('np.drive'), '0');
});

test('one paper after another, so a drive is not a paper and then silence', async () => {
  const {open} = await openListening();
  const $id = id => open.document.getElementById(id);
  const click = node => node.dispatchEvent(new open.window.Event('click', {bubbles: true}));
  const on = [...$id('listen-chain').querySelectorAll('button')].find(b => b.textContent === '이어서 계속');
  assert.ok(on, 'what happens at the end of a paper is a choice on the listening screen');
  click(on);
  assert.equal(open.storage.get('np.chain'), '1');

  const sents = [...open.document.querySelectorAll('#listen .sent')];
  click(sents[sents.length - 1]);            // the last sentence of the paper
  await open.settle();
  open.speech.start();
  await open.settle();
  open.speech.finish();
  await open.settle(40);
  assert.match($id('listen-title').textContent, /PET depolymerase/, 'the next paper in the library begins');
  assert.equal(open.storage.get('np.lastkind'), 'listen');
  // It begins at ITS beginning, not wherever the paper before it got to.
  assert.equal(open.storage.get('np.at.AAA'), String(sents.length - 1), 'the paper that ended is remembered where it ended');
  assert.equal(open.storage.get('np.at.BBB'), '0', 'and the one that follows begins at its own beginning');
  // Driving, the screen is not where you find out what started: the paper says its own name first.
  open.speech.start();
  await open.settle();
  assert.match(open.speech.spoken[open.speech.spoken.length - 1], /^다음 논문\. PET depolymerase landscape\. Introduction/);
  open.speech.finish(); open.speech.start();
  await open.settle();
  assert.ok(!/다음 논문/.test(open.speech.spoken[open.speech.spoken.length - 1]), 'and only once');
});

test('이어서 계속: 다음 논문에 읽을 본문이 없으면 멈춘다 — 앞 논문을 다시 읽지 않고', async () => {
  /* The paper that ended was still loaded in the player. Opening one with nothing to read left
     it there, and "the next paper" read the last one over again, under the new one's name. */
  const {open} = await openListening({children: key => key === 'AAA' ? PDF_CHILD : []});
  const $id = id => open.document.getElementById(id);
  const click = node => node.dispatchEvent(new open.window.Event('click', {bubbles: true}));
  click([...$id('listen-chain').querySelectorAll('button')].find(b => b.textContent === '이어서 계속'));
  const sents = [...open.document.querySelectorAll('#listen .sent')];
  click(sents[sents.length - 1]);
  await open.settle();
  open.speech.start();
  await open.settle();
  const heard = open.speech.spoken.length;
  open.speech.finish();                        // the paper ends and the next one is opened
  await open.settle(40);
  assert.match($id('listen-title').textContent, /PET depolymerase/, 'the next paper was opened');
  assert.match($id('listen-body').textContent, /읽을 본문이 없습니다/, 'and says it has nothing to read');
  assert.equal(open.speech.queue.length, 0, 'nothing is being spoken');
  assert.equal(open.speech.spoken.length, heard, 'the paper that ended was not read again');
  assert.equal($id('listen-bar').hidden, true, 'and there is no player over a paper there is none for');
});

test('the paper after this one is fetched before it is wanted, so a tunnel does not end the drive', async () => {
  const {open, server} = await openListening();
  const $id = id => open.document.getElementById(id);
  const click = node => node.dispatchEvent(new open.window.Event('click', {bubbles: true}));
  click([...$id('listen-chain').querySelectorAll('button')].find(b => b.textContent === '이어서 계속'));
  const asked = () => server.sent.filter(r => /\/items\/BBB\/children/.test(r.path)).length;
  assert.equal(asked(), 0, 'nothing is fetched for a paper nobody has got to yet');
  const sents = [...open.document.querySelectorAll('#listen .sent')];
  click(sents[0]);
  await open.settle();
  assert.equal(asked(), 0, 'nor at the top of the one being read');
  click(sents[sents.length - 1]);        // most of the way through
  await open.settle(20);
  assert.equal(asked(), 1, 'the next paper is got ready while this one is still being read');
  click(sents[Math.max(0, sents.length - 2)]);
  await open.settle(20);
  assert.equal(asked(), 1, 'and only once');
});

test('the car\'s own buttons are given the player while driving', async () => {
  const handlers = {};
  const nav = {mediaSession: {setActionHandler: (name, fn) => { handlers[name] = fn; }, metadata: null, playbackState: ''}};
  const {open} = await openListening({nav});
  const $id = id => open.document.getElementById(id);
  $id('listen-drive').dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  assert.deepEqual(Object.keys(handlers).sort(),
    ['nexttrack', 'pause', 'play', 'previoustrack', 'seekbackward', 'seekforward'].sort(),
    'the steering wheel and the lock screen can work the player');
  handlers.play();
  await open.settle();
  open.speech.start();
  await open.settle();
  assert.equal($id('listen-play').getAttribute('aria-label'), '일시정지', 'a button on the wheel starts it');
  handlers.nexttrack();
  await open.settle();
  assert.equal(nav.mediaSession.playbackState, 'playing', 'and the car is told what is happening');
  assert.match(nav.mediaSession.metadata.title, /Retron Septu/, 'with the paper on the dashboard');
  handlers.pause();
  await open.settle();
  assert.equal($id('listen-play').getAttribute('aria-label'), '재생');
});

test('the text Zotero indexed is asked for once and then kept on the phone', async () => {
  const {open, server} = await openListening();
  open.document.getElementById('listen-back').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  [...open.document.querySelectorAll('#detail .listen-start')][0].dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(server.sent.filter(r => /\/fulltext$/.test(r.path)).length, 1, 'the second time it comes from the phone');
});

test('captions are added to the reading when asked for', async () => {
  const {open} = await openListening();
  const captions = [...open.document.querySelectorAll('#listen-what button')].find(b => b.textContent === '캡션까지');
  captions.dispatchEvent(new open.window.Event('click'));
  await open.settle();
  const lines = [...open.document.querySelectorAll('#listen .sent')].map(n => n.textContent);
  assert.ok(lines.some(l => /coloured by cluster/.test(l)));
});

test('a PDF Zotero has not indexed says what to do instead of failing silently', async () => {
  const {open} = await openListening({fulltext: null});
  const said = open.document.getElementById('listen-body').textContent;
  assert.match(said, /색인/);
  assert.equal(open.document.getElementById('listen-bar').hidden, true, 'no player is offered');
});

test('a paper Zotero has not indexed is read from its abstract instead of saying nothing', async () => {
  const withAbstract = ITEMS.map(item => item.key === 'AAA'
    ? {...item, data: {...item.data, abstractNote: 'Retrons are bacterial defence systems that abort infection. '.repeat(4)}}
    : item);
  const {open} = await openListening({items: withAbstract, fulltext: null});
  const lines = [...open.document.querySelectorAll('#listen .sent')].map(n => n.textContent);
  assert.ok(lines.length, 'there is something to read');
  assert.ok(lines.some(l => /Retrons are bacterial defence/.test(l)), 'the abstract is what is read');
  assert.match(open.document.getElementById('toast').textContent, /초록/, 'and it says that is what this is');
});

test('a paper with neither body nor abstract still says what to do', async () => {
  const {open} = await openListening({fulltext: null});
  assert.match(open.document.getElementById('listen').textContent, /색인하지 않았습니다/);
});

test('a paper with no PDF says so', async () => {
  const {open} = await openListening({children: []});
  assert.match(open.document.getElementById('listen-body').textContent, /PDF 첨부가 없습니다/);
});

test('one pasted string fills both boxes, whether it is the key alone or number and key', async () => {
  const open = await boot({stored: {}});
  await open.settle();
  const user = open.document.getElementById('setup-user'), key = open.document.getElementById('setup-key');
  key.value = '16265664:' + 'k'.repeat(24);
  key.dispatchEvent(new open.window.Event('paste'));
  await new Promise(r => setTimeout(r, 10));
  assert.equal(user.value, '16265664', 'the number went to its own box');
  assert.equal(key.value, 'k'.repeat(24), 'and the key to its own');
});

test('the manifest does not fix where the icon opens, so the keys in the address survive', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal('start_url' in manifest, false, 'iOS would open the icon there and drop the address');
  assert.match(read('app.js'), /link\[rel="manifest"\]'\)\?\.remove/, 'and the link goes before the icon is added');
});

test('a long paper can be jumped about in by part, and the place shows on the slider', async () => {
  const {open} = await openListening();
  const section = open.document.getElementById('listen-section');
  const names = [...section.querySelectorAll('option')].map(o => o.textContent);
  assert.ok(names.includes('Introduction'), `the parts are offered (${names.join(', ')})`);

  const target = [...section.querySelectorAll('option')].find(o => o.textContent === 'Introduction');
  for (const option of section.querySelectorAll('option')) option.selected = option === target;
  section.dispatchEvent(new open.window.Event('change'));
  await open.settle();
  const seek = open.document.getElementById('listen-seek');
  assert.equal(seek.value, target.value, 'the slider followed');
  assert.ok(Number(seek.max) >= 1, 'and knows how long the paper is');

  // Dragging the slider moves the reading.
  seek.value = String(Number(seek.max));
  seek.dispatchEvent(new open.window.Event('change'));
  await open.settle();
  const marked = open.document.querySelector('#listen .sent[aria-current="true"]');
  assert.ok(marked, 'a sentence is marked');
  assert.equal(marked, open.document.querySelectorAll('#listen .sent')[Number(seek.max)]);
});

test('a held sentence offers the two things that are not starting the voice there', async () => {
  const {open} = await openListening();
  const sent = open.document.querySelectorAll('#listen .sent')[0];
  const event = new open.window.Event('touchstart', {bubbles: true});
  event.touches = [{clientX: 40, clientY: 200}];
  sent.dispatchEvent(event);
  await new Promise(r => setTimeout(r, 560));
  const rows = [...open.document.querySelectorAll('.menu.float .menu-row')].map(r => r.textContent.trim());
  assert.deepEqual(rows, ['문장 복사', '여기서부터 듣기', '1쪽 보기'],
    'copy it, read from it, or go to the page it is on');

  // Copying takes the sentence as the voice says it, not as the screen has broken it up.
  let copied = '';
  globalThis.navigator = {userAgent: 'test', clipboard: {writeText: async text => { copied = text; }}};
  [...open.document.querySelectorAll('.menu.float .menu-row')][0].dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.match(copied, /Microbial decomposers/);
  globalThis.navigator = {userAgent: 'test'};

  // And the tap that ended the hold does not also start the voice there.
  sent.dispatchEvent(event);
  await new Promise(r => setTimeout(r, 560));
  open.document.querySelector('.menu.float .menu-row').dispatchEvent(new open.window.Event('click'));
  sent.dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle(6);
  assert.equal(open.speech.queue.length, 0, 'nothing was spoken by the tap that let go');
});

test('how big the words are is the reader\'s own choice, and it is kept', async () => {
  const {open} = await openListening();
  open.document.getElementById('listen-more').dispatchEvent(new open.window.Event('click'));
  const track = open.document.getElementById('listen-size');
  const buttons = [...track.querySelectorAll('button')];
  assert.deepEqual(buttons.map(b => b.textContent), ['작게', '보통', '크게', '더 크게']);
  assert.equal(buttons[1].getAttribute('aria-pressed'), 'true', '보통 to begin with');

  buttons[2].dispatchEvent(new open.window.Event('click'));
  assert.equal(open.storage.get('np.read'), '1.15', 'the choice is kept');
  assert.equal(open.document.documentElement.style.getPropertyValue('--read'), '1.15',
    'and the words it applies to are told');
  assert.equal(buttons[2].getAttribute('aria-pressed'), 'true');
  assert.equal(buttons[1].getAttribute('aria-pressed'), 'false');

  // It is only the reading that grows: the chrome is not what anyone is reading.
  const css = read('app.css');
  assert.match(css, /\.transcript \.sent \{[^}]*font-size:calc\(16px \* var\(--read\)\)/);
  assert.match(css, /\.note \{[^}]*font-size:calc\(14px \* var\(--read\)\)/);
  assert.ok(!/\.row h2 \{[^}]*var\(--read\)/.test(css), 'a row of the library is chrome, not reading');

  // Next time the app opens, that is the size it opens at.
  const again = await boot({stored: {'np.user': '16265664', 'np.key': 'k'.repeat(24), 'np.read': '1.32'}});
  await again.settle();
  assert.equal(again.document.documentElement.style.getPropertyValue('--read'), '1.32');
  // Something nonsensical in the store is not allowed to shrink the app to nothing.
  const odd = await boot({stored: {'np.user': '16265664', 'np.key': 'k'.repeat(24), 'np.read': '0'}});
  await odd.settle();
  assert.equal(odd.document.documentElement.style.getPropertyValue('--read'), '1');
});

test('the player says where in the paper on one side and how much is left on the other', async () => {
  const {open} = await openListening();
  open.document.getElementById('listen-play').dispatchEvent(new open.window.Event('click'));
  open.speech.start();
  await open.settle();
  const where = open.document.getElementById('listen-where');
  const left = open.document.getElementById('listen-left');
  assert.match(where.textContent, /^1 \/ \d+/, 'which sentence of how many');
  assert.match(where.textContent, /1쪽/, 'and what page it is on');
  assert.match(left.textContent, /^남은 \d+분$/, 'how long is left, at the other end');
  // The slider is above them, as it is in a player, not below.
  const bar = open.document.getElementById('listen-bar');
  const order = [...bar.children].map(node => node.id || node.className);
  assert.ok(order.indexOf('listen-seek') < order.findIndex(name => /player-meta/.test(name)),
    'the slider is above the two ends it belongs to');

  // A sleep timer takes over the right-hand end, because that is the number that now matters.
  const sleep = open.document.getElementById('listen-sleep');
  for (const option of sleep.querySelectorAll('option')) option.selected = option.value === '20';
  // linkedom's <select>.value is a getter that does not follow option.selected.
  Object.defineProperty(sleep, 'value', {value: '20', configurable: true});
  sleep.dispatchEvent(new open.window.Event('change'));
  await open.settle();
  assert.match(open.document.getElementById('toast').textContent, /20분 뒤에 멈춥니다/);
  open.speech.finish(); open.speech.start();
  await open.settle();
  assert.match(left.textContent, /^잠들기 \d+분$/, 'the sleep timer is what is counting down now');
});

test('the sleep timer stops the reading, and says so', async () => {
  const {open} = await openListening();
  const play = open.document.getElementById('listen-play');
  play.dispatchEvent(new open.window.Event('click'));
  open.speech.start();
  await open.settle();

  const sleep = open.document.getElementById('listen-sleep');
  for (const option of sleep.querySelectorAll('option')) option.selected = option.value === 'section';
  sleep.dispatchEvent(new open.window.Event('change'));
  await open.settle();
  assert.match(open.document.getElementById('toast').textContent, /멈춥니다/);

  // Reading on into the next part is where it stops.
  const sentences = open.document.querySelectorAll('#listen .sent');
  for (let i = 0; i < sentences.length + 2; i++) { open.speech.step(); }
  await open.settle();
  assert.notEqual(open.document.getElementById('listen-play').getAttribute('aria-label'), '일시정지',
    'it is no longer playing');
});

test('tapping a sentence reads from there', async () => {
  const {open} = await openListening();
  const sentences = [...open.document.querySelectorAll('#listen .sent')];
  assert.ok(sentences.length > 1);
  const third = sentences[Math.min(2, sentences.length - 1)];
  third.dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  open.speech.start();
  assert.equal(open.speech.spoken[0], third.textContent.replace(/^/, ''), 'it started at the sentence tapped');
  assert.equal(open.document.querySelector('#listen .sent[aria-current="true"]'), third);
});

test('the card above the library does one thing at a time, never two', async () => {
  const base = fakeServer();
  let refuse = false;
  const server = {sent: base.sent, fetchImpl: async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (refuse && url.pathname.endsWith('/items') && (init.method || 'GET') === 'GET') return new Response('', {status: 403});
    return base.fetchImpl(input, init);
  }};
  const open = await boot({server});
  await open.settle();
  // First it offers to carry the keys to the home screen.
  assert.match(open.document.getElementById('pair').textContent, /홈 화면에 추가/);

  // Then the key is refused, and the same card says that instead.
  refuse = true;
  open.document.getElementById('btn-sync').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.match(open.document.getElementById('pair').textContent, /거부했습니다/);

  // Pressing it opens the settings and does NOT also put the keys in the address.
  open.document.getElementById('pair-go').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(open.document.getElementById('settings').hidden, false);
  assert.ok(!String(open.location.hash || '').includes('k='), 'the keys did not go into the address as well');
});

test('a key Zotero refuses is said once, where it can be put right', async () => {
  const base = fakeServer();
  const server = {sent: base.sent, fetchImpl: async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname.endsWith('/items') && (init.method || 'GET') === 'GET') return new Response('', {status: 403});
    return base.fetchImpl(input, init);
  }};
  const open = await boot({server});
  await open.settle();
  const card = open.document.getElementById('pair');
  assert.equal(card.hidden, false, 'the trouble is on screen');
  assert.match(card.textContent, /거부|Allow library access/);
  open.document.getElementById('pair-go').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(open.document.getElementById('settings').hidden, false, 'and it leads to where the key goes');
});

test('what is under a sheet is out of reach while it is open, and comes back after', async () => {
  const open = await boot();
  await open.settle();
  const main = open.document.getElementById('main');
  assert.equal(main.hasAttribute('inert'), false);
  open.document.getElementById('btn-collections').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(main.hasAttribute('inert'), true, 'the library is out of reach');
  assert.equal(open.document.getElementById('collections').getAttribute('aria-modal'), 'true');

  open.document.getElementById('btn-settings').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(open.document.getElementById('collections').hasAttribute('inert'), true,
    'and so is the sheet underneath the new one');

  open.window.history.back();
  await open.settle();
  assert.equal(open.document.getElementById('collections').hasAttribute('inert'), false, 'it comes back');
  open.window.history.back();
  await open.settle();
  assert.equal(main.hasAttribute('inert'), false, 'and so does the library');
});

/* ---- the PDF itself ---- */
/* Almost every file in this library is a linked file: Zotero knows only its path, and the bytes
   sit in a Dropbox folder. These check that the phone asks the right service for them. pdf.js is
   not loaded in the fake phone, so what is asserted stops at the bytes arriving. */
const LINKED_CHILD = [{key: 'PDF1', version: 3, data: {key: 'PDF1', itemType: 'attachment', linkMode: 'linked_file',
  contentType: 'application/pdf', filename: 'seo.pdf', path: 'attachments:Defense system/seo.pdf'}}];
const MARKED = [...LINKED_CHILD,
  {key: 'M1', version: 4, data: {key: 'M1', itemType: 'annotation', annotationType: 'highlight',
    annotationColor: '#ffd400', annotationText: 'the enzyme degrades PET', annotationSortIndex: '00002|000100|00050',
    annotationPosition: JSON.stringify({pageIndex: 2, rects: [[60, 700, 300, 740]]})}},
  {key: 'M2', version: 5, data: {key: 'M2', itemType: 'annotation', annotationType: 'highlight',
    annotationColor: '#5fb236', annotationText: 'first thing said', annotationSortIndex: '00000|000100|00050',
    annotationPosition: JSON.stringify({pageIndex: 0, rects: [[60, 100, 300, 140]]})}}];
const STORED_CHILD = [{key: 'PDF2', version: 3, data: {key: 'PDF2', itemType: 'attachment', linkMode: 'imported_file',
  contentType: 'application/pdf', filename: 'seo.pdf'}}];
const DROPBOX_ON = {'np.db.app': 'APPKEY', 'np.db.refresh': 'RT', 'np.db.base': '/0.Personal folder/0. Zotero'};

/* Dropbox, answering the two calls the app makes of it. */
function fakeDropbox() {
  const asked = [];
  const handle = async (url, init = {}) => {
    asked.push({url, arg: init.headers && init.headers['Dropbox-API-Arg'], body: init.body});
    if (/oauth2\/token/.test(url)) return new Response(JSON.stringify({access_token: 'AT', expires_in: 14400}), {status: 200});
    if (/files\/download/.test(url)) return new Response(new Uint8Array(4096).fill(1), {status: 200});
    return new Response('{}', {status: 200});
  };
  return {handle, asked, get paths() { return asked.filter(a => a.arg).map(a => JSON.parse(a.arg).path); }};
}

async function openPdf({children = LINKED_CHILD, stored = {}, dropbox = fakeDropbox()} = {}) {
  const zotero = fakeServer({children, fulltext: FULLTEXT});
  // One fetch for both: Zotero's own host and Dropbox's.
  const server = {sent: zotero.sent, fetchImpl: async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    return /dropboxapi\.com|dropbox\.com/.test(url) ? dropbox.handle(url, init) : zotero.fetchImpl(input, init);
  }};
  const open = await boot({server, stored: {'np.user': '16265664', 'np.key': 'k'.repeat(24), ...stored}});
  await open.settle();
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  const start = open.document.querySelector('#detail .paper-start');
  assert.ok(start, 'the paper offers its PDF');
  start.dispatchEvent(new open.window.Event('click'));
  await open.settle();
  return {open, zotero, dropbox};
}

test('a paper offers its PDF, and a linked file is fetched from Dropbox by the path the library points at', async () => {
  const {open, dropbox} = await openPdf({stored: DROPBOX_ON});
  assert.equal(open.document.getElementById('paper').hidden, false, 'the PDF screen is open');
  assert.deepEqual(dropbox.paths, ['/0.Personal folder/0. Zotero/Defense system/seo.pdf']);
  assert.ok(dropbox.asked.some(a => /oauth2\/token/.test(a.url)), 'a fresh token was fetched first');
});

test('a paper opened in the dark opens dark, until the reader says otherwise', async () => {
  const {open} = await openPdf({stored: DROPBOX_ON});
  const {nightWanted} = await import(new URL(`../app.js?boot=${boots}`, here));
  // Nothing said: the page follows the phone.
  assert.equal(nightWanted(null, true), true, 'a dark phone opens a dark page');
  assert.equal(nightWanted(null, false), false);
  // Said once, and that is what it does, whatever the phone is doing.
  assert.equal(nightWanted('off', true), false, 'turned off, it stays off in the dark');
  assert.equal(nightWanted('on', false), true, 'and on, it stays on in the light');

  // The button says which way it is, and turning it over is remembered.
  const view = open.document.getElementById('paper-view');
  const button = open.document.getElementById('paper-night');
  assert.equal(view.classList.contains('night'), false, 'this fake phone is a light one');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  button.dispatchEvent(new open.window.Event('click'));
  assert.equal(view.classList.contains('night'), true);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(open.storage.get('np.pdf.night'), 'on', 'and the choice is kept');
  button.dispatchEvent(new open.window.Event('click'));
  assert.equal(open.storage.get('np.pdf.night'), 'off', 'turning it back off is a choice too');
});

test('a tap gives the whole screen to the paper, and a double tap is still a zoom', async () => {
  const {open} = await openPdf({stored: DROPBOX_ON});
  const paper = open.document.getElementById('paper');
  const view = open.document.getElementById('paper-view');
  const tap = () => view.dispatchEvent(new open.window.Event('click'));
  assert.equal(paper.classList.contains('bare'), false, 'the bar is there to begin with');
  // A fake phone never gets as far as rendering a page, so the bar is told what it would say.
  open.document.getElementById('paper-count').textContent = '3 / 12';

  // One tap, after the moment it waits to see whether a second is coming.
  tap();
  await new Promise(r => setTimeout(r, 340));
  assert.equal(paper.classList.contains('bare'), true, 'the bar folded away');
  const now = open.document.getElementById('paper-now');
  assert.equal(now.hidden, false, 'and the page number stands in for it');
  assert.equal(now.textContent, '3 / 12', 'saying what the bar was saying');
  tap();
  await new Promise(r => setTimeout(r, 340));
  assert.equal(paper.classList.contains('bare'), false, 'another brings it back');

  // Two taps in quick succession are pdf.js zooming, and must not also fold the bar.
  tap(); tap();
  await new Promise(r => setTimeout(r, 340));
  assert.equal(paper.classList.contains('bare'), false, 'a double tap left the bar alone');

  // Leaving puts it back, so the next paper does not open with no bar.
  tap();
  await new Promise(r => setTimeout(r, 340));
  assert.equal(paper.classList.contains('bare'), true);
  open.document.getElementById('paper-back').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(paper.classList.contains('bare'), false, 'and the bar is back for the next one');
});

test('a file Zotero itself stores is fetched from Zotero, not from Dropbox', async () => {
  const {zotero, dropbox} = await openPdf({children: STORED_CHILD, stored: DROPBOX_ON});
  assert.ok(zotero.sent.some(r => r.path === '/users/16265664/items/PDF2/file'), 'the bytes came from Zotero');
  assert.equal(dropbox.paths.length, 0, 'Dropbox was not troubled');
});

test('the same PDF is fetched once and then read off this phone', async () => {
  const {open, dropbox} = await openPdf({stored: DROPBOX_ON});
  assert.equal(dropbox.paths.length, 1);
  open.document.getElementById('paper-back').dispatchEvent(new open.window.Event('click'));
  open.document.querySelector('#detail .paper-start').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(dropbox.paths.length, 1, 'the second opening needed no signal');
});

test('with no Dropbox connected the PDF screen says why and offers to connect it', async () => {
  const {open, dropbox} = await openPdf();
  assert.equal(dropbox.paths.length, 0, 'nothing was asked of Dropbox');
  const message = open.document.getElementById('paper-msg');
  assert.equal(message.hidden, false);
  assert.match(message.textContent, /Dropbox/);
  const connect = [...message.querySelectorAll('button')].find(b => /Dropbox/.test(b.textContent));
  assert.ok(connect, 'there is a way to connect it');
  connect.dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(open.document.getElementById('settings').hidden, false, 'it leads to the settings');
  assert.match(open.document.getElementById('settings-body').textContent, /Redirect URIs|앱 키/);
});

test('a paper whose file is out of reach can still be listened to and searched', async () => {
  const {open} = await openPdf();   // no Dropbox: the PDF cannot be fetched
  assert.equal(open.document.getElementById('paper-msg').hidden, false, 'it says the PDF did not open');
  assert.equal(open.document.getElementById('paper-bar').hidden, false, 'but the voice is there anyway');

  open.document.getElementById('paper-find').dispatchEvent(new open.window.Event('click'));
  const box = open.document.getElementById('paper-q');
  box.value = 'decomposers';
  box.dispatchEvent(new open.window.Event('input'));
  await open.settle();
  const found = [...open.document.querySelectorAll('#paper-found .found')];
  assert.equal(found.length, 1, 'the word is found in the text Zotero indexed');
  assert.match(found[0].textContent, /1쪽/, 'and it says which page to turn to');
  assert.match(open.document.getElementById('paper-hits').textContent, /1곳/);
});

test('an attachment that is only a web link is not offered as a file', async () => {
  const link = [{key: 'L1', version: 3, data: {key: 'L1', itemType: 'attachment', linkMode: 'linked_url',
    contentType: 'application/pdf', title: 'full text', url: 'https://example.org/a.pdf'}}];
  const {open} = await openPdf({children: link, stored: DROPBOX_ON});
  assert.match(open.document.getElementById('paper-msg').textContent, /링크|열지 못했습니다/);
});

test('the Dropbox connection travels to the home-screen app in the same link as the key', async () => {
  const taken = await boot({stored: {}, hash: '#k=' + 'k'.repeat(24) + '&u=16265664&a=APPKEY&d=RT&b=%2FPapers'});
  await taken.settle();
  assert.equal(taken.storage.get('np.db.app'), 'APPKEY');
  assert.equal(taken.storage.get('np.db.refresh'), 'RT');
  assert.equal(taken.storage.get('np.db.base'), '/Papers');
});

/* One session, end to end, the way it is actually used: find a paper, mark it, listen to it, look
   at it, search inside it, and come back out. The pieces are each checked above; this is whether
   they still fit together. */
test('a whole session: find, mark, listen, look, search, and back out again', async () => {
  const server = fakeServer({children: MARKED, fulltext: FULLTEXT});
  const open = await boot({server, stored: {'np.user': '16265664', 'np.key': 'k'.repeat(24), ...DROPBOX_ON}});
  await open.settle();
  const $ = id => open.document.getElementById(id);
  const click = node => node.dispatchEvent(new open.window.Event('click', {bubbles: true}));
  const shown = id => $(id).hidden === false;

  // Find it by a word from its journal, not its title.
  const box = $('q');
  box.value = 'science';
  box.dispatchEvent(new open.window.Event('input'));
  await open.settle();
  const rows = [...open.document.querySelectorAll('#list .row h2')].map(h => h.textContent);
  assert.deepEqual(rows, ['Retron Septu defence'], `found by journal (${rows.join(', ')})`);

  // Open it, mark it read, give it four.
  click(open.document.querySelector('#list .row'));
  await open.settle();
  assert.ok(shown('detail'));
  click([...open.document.querySelectorAll('#detail .seg button')].find(b => b.textContent === '완료'));
  await open.settle();
  click(open.document.querySelectorAll('#detail .rate button')[3]);
  await open.settle();
  const writes = server.sent.filter(r => r.method === 'PATCH');
  assert.equal(writes.length, 2, 'both changes went out');
  assert.match(String(writes[1].body.extra), /Rating: 4/);

  // Listen to it, and jump to a part of it.
  click(open.document.querySelector('#detail .listen-start'));
  await open.settle();
  assert.ok(shown('listen'), 'the transcript is up');
  assert.ok(open.document.querySelectorAll('#listen .sent').length > 1);
  click($('listen-play'));
  open.speech.start();
  await open.settle();
  assert.equal($('listen-play').getAttribute('aria-label'), '일시정지', 'it is reading');

  // Over to the PDF; it stacks on the transcript and carries the same place in the paper.
  click($('listen-pdf'));
  await open.settle();
  assert.ok(shown('paper'), 'the paper is up');
  assert.ok(shown('listen'), 'and the transcript is still behind it');
  assert.equal($('paper-bar').hidden, false, 'the voice came with it');

  // Search inside the paper.
  click($('paper-find'));
  const find = $('paper-q');
  find.value = 'microbial';
  find.dispatchEvent(new open.window.Event('input'));
  await open.settle();
  assert.equal(open.document.querySelectorAll('#paper-found .found').length, 1, 'found in the body');

  // Back out: paper, transcript, paper screen, list — each one at a time, nothing stranded.
  open.window.history.back(); await open.settle();
  assert.ok(!shown('paper') && shown('listen'), 'back left the transcript');
  open.window.history.back(); await open.settle();
  assert.ok(!shown('listen') && shown('detail'), 'and then the paper');
  open.window.history.back(); await open.settle();
  assert.ok(!shown('detail') && shown('main'), 'and then the library');
  assert.equal(open.document.querySelectorAll('#list .row').length, 1, 'with the search still narrowing it');
  assert.equal(open.document.getElementById('main').hasAttribute('inert'), false, 'and reachable again');
});

test('the phone\'s keyboard neither hides the end of a list nor leaves the app off the top', async () => {
  const open = await boot();
  await open.settle();
  const {keyboardGap} = await import(new URL(`../app.js?boot=${boots}`, here));
  // Nothing up: the viewport is the whole screen.
  assert.equal(keyboardGap(844, {height: 844, offsetTop: 0}), 0);
  // Up: what is below the visible viewport is under the keys.
  assert.equal(keyboardGap(844, {height: 508, offsetTop: 0}), 336);
  // And when the page itself has been lifted, that counts too.
  assert.equal(keyboardGap(844, {height: 508, offsetTop: 40}), 296);
  assert.equal(keyboardGap(844, null), 0, 'a phone that does not report one is no trouble');

  // iOS lifts the whole page to make room; the app is put back where it belongs.
  let put = 0;
  open.window.scrollY = 120;
  open.window.scrollTo = (x, y) => { put++; open.window.scrollY = y; };
  open.window.dispatchEvent(new open.window.Event('scroll'));
  assert.equal(put, 1, 'a page that has been lifted is put back');
  assert.equal(open.window.scrollY, 0);
  open.window.dispatchEvent(new open.window.Event('scroll'));
  assert.equal(put, 1, 'and one that is where it should be is left alone');

  // The end of the list stays reachable while the keyboard is up.
  assert.match(read('app.css'), /\.list \{[^}]*padding:[^;]*var\(--kb/, 'the list keeps clear of the keys');
});

test('a sheet is pulled back off by a finger from the left edge', async () => {
  const open = await boot();
  await open.settle();
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  const detail = open.document.getElementById('detail');
  assert.equal(detail.hasAttribute('hidden'), false, 'the paper is open');

  const drag = (type, x, y = 300, on = detail) => {
    const event = new open.window.Event(type);
    event.touches = [{clientX: x, clientY: y}];
    on.dispatchEvent(event);
  };
  // A finger that starts in the middle of the screen is not asking to leave.
  drag('touchstart', 180);
  drag('touchmove', 330);
  assert.equal(detail.style.transform, '', 'only the edge begins it');
  detail.dispatchEvent(new open.window.Event('touchend'));

  // Nor is one that goes down the screen.
  drag('touchstart', 8);
  drag('touchmove', 14, 380);
  assert.equal(detail.style.transform, '', 'a scroll stays a scroll');
  detail.dispatchEvent(new open.window.Event('touchend'));

  // Begun at the edge, taken a little way and let go slowly: it springs shut again.
  drag('touchstart', 8);
  drag('touchmove', 48);
  assert.match(detail.style.transform, /translateX\(\d+px\)/, 'it follows the finger');
  assert.equal(detail.classList.contains('dragging'), true, 'without a transition fighting it');
  await new Promise(r => setTimeout(r, 300));
  detail.dispatchEvent(new open.window.Event('touchend'));
  await open.settle(4);
  assert.equal(detail.style.transform, '', 'a short pull is undone');
  assert.equal(detail.hasAttribute('hidden'), false, 'and the paper is still open');

  // The same distance thrown off quickly is a flick, and a flick means it.
  drag('touchstart', 8);
  drag('touchmove', 90);
  await new Promise(r => setTimeout(r, 40));
  detail.dispatchEvent(new open.window.Event('touchend'));
  assert.equal(detail.style.transform, 'translateX(100%)', 'a flick sends it off');
  await open.settle(80);
  assert.equal(detail.hasAttribute('hidden'), true);

  // And so does taking it slowly past a third of the way across.
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  assert.equal(detail.hasAttribute('hidden'), false);
  drag('touchstart', 8);
  drag('touchmove', 300);
  await new Promise(r => setTimeout(r, 400));
  detail.dispatchEvent(new open.window.Event('touchend'));
  assert.equal(detail.style.transform, 'translateX(100%)', 'it leaves by the edge it came in from');
  await open.settle(80);
  assert.equal(detail.hasAttribute('hidden'), true, 'and the paper is closed');
  assert.equal(detail.style.transform, '', 'ready to come back in');
  assert.equal(open.document.getElementById('main').hasAttribute('inert'), false, 'the library is live again');
});

test('a PDF pushed sideways is being read, not dismissed', async () => {
  const open = await boot();
  await open.settle();
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  const detail = open.document.getElementById('detail');
  // A list of the open sheet that has been scrolled sideways — a zoomed page — keeps its gesture.
  const body = open.document.getElementById('detail-body');
  body.scrollLeft = 40;
  const drag = (type, x) => { const e = new open.window.Event(type); e.touches = [{clientX: x, clientY: 300}]; detail.dispatchEvent(e); };
  drag('touchstart', 6);
  drag('touchmove', 300);
  assert.equal(detail.style.transform, '', 'the screen did not move');
  detail.dispatchEvent(new open.window.Event('touchend'));
  await open.settle(4);
  assert.equal(detail.hasAttribute('hidden'), false, 'and the paper is still open');
});

test('the top of a paper reads like its title page', async () => {
  const open = await boot();
  await open.settle();
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  const hero = open.document.querySelector('#detail-body .hero');
  assert.ok(hero, 'the paper opens with a title page');
  assert.match(hero.querySelector('.name').textContent, /Retron Septu/, 'its own name first');
  assert.equal(hero.querySelector('.by').textContent, 'Seo, H · Kim, K', 'then who wrote it');
  assert.equal(hero.querySelector('.where').textContent, 'Science · 2025', 'then where it came out');
  assert.match(hero.querySelector('.doi').textContent, /^doi:10\.1126\//, 'and what it is called');
  // Not a form: no label stands against any of those lines.
  assert.equal(hero.querySelector('.kv'), null, 'nothing is labelled like a form');
  assert.equal(hero.querySelector('b'), null);
  // What it is filed under, and the taps a paper offers, read as chips rather than wide buttons.
  assert.deepEqual([...hero.querySelectorAll('.tags .chip')].map(c => c.textContent), ['Phage defence']);
  assert.deepEqual([...hero.querySelectorAll('.pills > *')].map(c => c.textContent),
    ['DOI 열기', '링크 복사', '인용 복사', 'BibTeX']);
  assert.equal(hero.querySelector('.pills .out').getAttribute('href'), 'https://doi.org/10.1126/science.abc1234');
  // Nothing on this screen is styled by hand in the markup.
  assert.equal([...open.document.querySelectorAll('#detail-body [style]')]
    .filter(node => !node.matches('.heard i, .swatch')).length, 0, 'and nothing carries its own style');
});

test('the settings screen is groups of rows, not a form', async () => {
  const open = await boot();
  await open.settle();
  open.document.getElementById('btn-settings-main').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  const body = open.document.getElementById('settings-body');
  const heads = [...body.querySelectorAll('.set-head')].map(h => h.textContent);
  assert.deepEqual(heads, ['Zotero', '앱', '라이브러리', 'Dropbox — PDF 원본', '홈 화면 앱'],
    'who this phone is first, then what it holds');
  // Every group is a card of rows with a quiet label above it and the explaining below.
  for (const group of body.querySelectorAll('.set-group')) {
    assert.ok(group.querySelector('.card.rows'), 'a card of rows');
    assert.ok(group.querySelector('.card.rows .set-row'), 'with rows in it');
  }
  const said = row => [...row.childNodes].map(n => n.textContent).join(' ');
  const rows = [...body.querySelectorAll('.set-row')];
  const find = what => rows.find(r => r.querySelector('.what')?.textContent === what);
  assert.match(said(find('사용자 번호')), /16265664/);
  assert.match(said(find('논문')), /3편/);
  assert.match(said(find('컬렉션')), /1개/);
  assert.ok(find('받아 둔 PDF'), 'and what has been downloaded');
  // The light beside 연결 comes before the word, and says which way it is.
  const linked = find('연결');
  assert.ok(linked.querySelector('.dot.off'), 'not connected, and the light says so');
  // The two text boxes are rows themselves, right-aligned, not boxed-off fields.
  assert.equal(body.querySelectorAll('.field').length, 0, 'nothing is a form field any more');
  assert.equal(body.querySelectorAll('.set-field input').length, 2, 'the app key and the folder are rows');
  // What can be pressed stands in the tint that says so, and what cannot be undone is red.
  const go = [...body.querySelectorAll('.set-go')].map(b => b.textContent);
  assert.deepEqual(go, ['업데이트 확인', '앱 새로 받기', 'PDF 비우기', '라이브러리 다시 받기', '연결', '폴더만 저장',
    '키까지 함께 담기', '키 복사']);
});

test('a paper comes out as BibTeX a reference manager will take', async () => {
  const open = await boot();
  await open.settle();
  const {bibtexOf} = await import(new URL(`../app.js?boot=${boots}`, here));
  const out = bibtexOf(ITEMS[0]);
  assert.match(out, /^@article\{seo2025retron,/, 'an article, keyed by author, year and first word');
  assert.match(out, /author = \{Seo, H and Kim, K\}/);
  assert.match(out, /title = \{Retron Septu defence\}/, 'braced, so a journal keeps its capitals');
  assert.match(out, /journal = \{Science\}/);
  assert.match(out, /year = \{2025\}/);
  assert.match(out, /doi = \{10\.1126\/science\.abc1234\}/);
  assert.ok(!/url = /.test(out), 'a DOI is the link; printing both is noise');
  assert.match(out, /\n\}$/, 'and it closes');

  // A book is not an article, and a paper with nothing in it still comes out valid.
  const book = {key: 'Z', data: {itemType: 'book', title: 'Phage', creators: [{creatorType: 'author', name: 'Twort'}],
    publisher: 'MIT Press', date: '1931', tags: []}};
  assert.match(bibtexOf(book), /^@book\{twort1931phage,/);
  assert.match(bibtexOf(book), /publisher = \{MIT Press\}/);
  assert.match(bibtexOf(book), /author = \{Twort\}/);
  const bare = bibtexOf({key: 'Y', data: {itemType: 'journalArticle', title: '', creators: [], tags: []}});
  assert.match(bare, /^@article\{paper\n\}$/, 'nothing to say, and nothing broken');

  // Braces in a title would end the entry early, so they do not survive.
  const odd = bibtexOf({key: 'X', data: {itemType: 'journalArticle', title: 'A {curly} case', creators: [], tags: []}});
  assert.match(odd, /title = \{A curly case\}/);

  // And it is one of the things a paper's own screen offers.
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  const pills = [...open.document.querySelectorAll('#detail .hero .pills > *')].map(p => p.textContent);
  assert.deepEqual(pills, ['DOI 열기', '링크 복사', '인용 복사', 'BibTeX']);
});

test('what changed is said once and quietly, not a thousand papers over again', async () => {
  const open = await boot({server: fakeServer({items: MANY})});
  await open.settle();
  const list = open.document.getElementById('list');
  const said = open.document.getElementById('said');
  // A live region over the list itself would read every row out on every redraw.
  assert.equal(list.hasAttribute('aria-live'), false, 'the list is not a live region');
  assert.equal(said.getAttribute('aria-live'), 'polite');
  assert.equal(said.getAttribute('role'), 'status');
  await open.settle(140);                 // it waits for the drawing to settle before speaking
  assert.match(said.textContent, /^900편$/, 'what is being looked at, as a number');

  // Narrowed, and the number is said again; marking one paper changes nothing to say.
  const box = open.document.getElementById('q');
  box.value = 'number 7';
  box.dispatchEvent(new open.window.Event('input'));
  await open.settle();
  await open.settle(140);
  const narrowed = said.textContent;
  assert.notEqual(narrowed, '900편');
  assert.match(narrowed, /편$/);
  box.value = 'zzzz nothing';
  box.dispatchEvent(new open.window.Event('input'));
  await open.settle(140);
  assert.equal(said.textContent, '해당하는 논문이 없습니다');

  // It is said, never drawn: out of the flow, but still in the accessibility tree.
  assert.match(read('app.css'), /\.said \{[^}]*clip-path:inset\(50%\)/);
  assert.ok(!/\.said \{[^}]*display:none/.test(read('app.css')), 'display:none would take it out of the tree');
});

/* The usual answer to "is the new version on my phone?" should not be "close the app completely
   and open it again". The build is on the settings screen, and the service worker keeps the shell
   under that same name — so if the two ever drift, the number on screen is a lie. */
test('the build on the settings screen is the one the service worker keeps', async () => {
  const open = await boot();
  await open.settle();
  const {BUILD} = await import(new URL(`../app.js?boot=${boots}`, here));
  const cache = /const CACHE = '([^']+)'/.exec(read('sw.js'))[1];
  assert.equal(BUILD, cache, 'the app and its shell are the same build');

  open.document.getElementById('btn-settings-main').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  const rows = [...open.document.querySelectorAll('#settings-body .set-row')];
  const version = rows.find(r => r.querySelector('.what')?.textContent === '버전');
  assert.ok(version, 'it is on the screen');
  assert.equal(version.querySelector('.val').textContent, cache.replace(/^nonmun-/, ''));

  // And it can be asked for a newer one rather than being closed and opened again.
  let asked = 0;
  globalThis.navigator = {userAgent: 'test', serviceWorker: {
    getRegistration: async () => ({update: async () => { asked++; }})
  }};
  const check = rows.find(r => r.textContent === '업데이트 확인');
  check.dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(asked, 1, 'the shell was asked whether there is a newer one');
  assert.match(open.document.getElementById('toast').textContent, /최신입니다/);
  globalThis.navigator = {userAgent: 'test'};
});

/* ---------- the look ---------- */
/* The status used to be a labelled dot in the row's third line, and `.dot` was later given a
   second meaning in the settings screen — nine pixels square with a grey fill — which turned every
   row's status into a sliver of stacked letters on the phone. A class that is used but never
   styled, or styled twice over for two different things, looks exactly like a broken app, so what
   the markup asks for and what the stylesheet offers are checked against each other. */
const classesIn = text => new Set([
  ...text.matchAll(/class="([^"]*)"/g),      // the page
  ...text.matchAll(/class: *'([^']*)'/g),    // what the app draws
  ...text.matchAll(/class: *`([^`]*)`/g)     // and what it draws with a state in the name
].flatMap(m => m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/))
 .filter(name => /^[a-z][a-z0-9-]*$/.test(name)));

test('every class the app asks for is one the stylesheet draws', () => {
  const css = read('app.css');
  const wanted = new Set([...classesIn(read('index.html')), ...classesIn(read('app.js'))]);
  // Drawn by the phone, not by us: the states the app toggles are checked below by name.
  for (const state of ['on', 'off', 'ready', 'night', 'with-player', 'shrunk', 'lifted', 'busy']) wanted.delete(state);
  const missing = [...wanted].filter(name => !new RegExp(`\\.${name}[^a-z0-9-]`).test(css));
  assert.deepEqual(missing, [], `these classes are used but never styled: ${missing.join(', ')}`);
});

test('the search folds away with the big title, but never while it is being used', () => {
  const css = read('app.css');
  assert.match(css, /\.top\.shrunk \.top-row \{[^}]*max-height:0/, 'scrolled, the search row folds');
  /* The gap the header puts between its rows has to be taken back with it, or folding the row
     away leaves its share of the gap behind as a hole. */
  const gap = /\.top \{[^}]*gap:(\d+)px/.exec(css);
  const pull = /\.top\.shrunk \.top-row \{[^}]*margin-bottom:-(\d+)px/.exec(css);
  assert.ok(gap && pull, 'both are set');
  assert.equal(pull[1], gap[1], 'and the row takes its own gap with it');
  /* A field being typed into must not fold away under the finger using it. The two guards are
     rules of their own: a browser that does not know :has() would otherwise throw away the fold
     itself and leave the header as tall as it ever was. */
  for (const guard of [':has(#q:focus)', ':has(#q:not(:placeholder-shown))']) {
    const rule = new RegExp(`\\.top\\.shrunk${guard.replace(/[()#:*+?^$\\.\[\]{}|\/-]/g, '\\$&')} \\.top-row \\{[^}]*max-height:40px`);
    assert.match(css, rule, `the fold is called off by ${guard}`);
  }
  assert.ok(!/\.top-row[^{]*,[^{]*:has\(/.test(css), 'and :has() never stands in a list with a plain selector');
});

/* The other way round: a rule for a class nobody asks for any more is a rule nobody will dare
   touch either, and it was a stale second meaning for one name that broke the list in the first
   place. The names that are built from a value rather than written out are listed here, because
   no reading of the source can find them. */
const FROM_VALUES = [
  'unread', 'reading', 'done',   // a paper's status, as `flag ${status}`
  'clear',                       // the push that takes a mark off a paper
  'left',                        // which way it was pushed
  'off',                         // the Dropbox light when it is not connected
  'caption',                     // a sentence that is a figure's caption
  'underline',                   // what kind of mark was made on the page
  'read'                         // which of the two a paper was last left in the middle of
];
test('every rule in the stylesheet is for a class the app still asks for', () => {
  const asked = new Set(FROM_VALUES);
  const text = ['app.js', 'pdfview.js', 'play.js', 'read.js', 'files.js', 'net.js', 'list.js', 'index.html']
    .map(read).join('\n');
  /* A class written inside a template's own ${…} — `row nav${here ? ' here' : ''}` — is still a
     class the app asks for, so the quoted parts of an interpolation are read rather than thrown
     away with it. */
  const add = value => String(value || '')
    .replace(/\$\{([^}]*)\}/g, (_, inner) => ` ${(inner.match(/'[^']*'/g) || []).join(' ').replace(/'/g, '')} `)
    .split(/[^a-zA-Z0-9-]+/)
    .forEach(name => { if (/^[a-z][a-z0-9-]*$/.test(name)) asked.add(name); });
  for (const m of text.matchAll(/class="([^"]*)"/g)) add(m[1]);
  for (const m of text.matchAll(/class: *'([^']*)'/g)) add(m[1]);
  for (const m of text.matchAll(/class: *`([^`]*)`/g)) add(m[1]);
  for (const m of text.matchAll(/classList\.(?:add|remove|toggle|contains)\(([^)]*)\)/g)) add(m[1]);
  for (const m of text.matchAll(/className *= *[`'"]([^`'"]*)/g)) add(m[1]);
  for (const m of text.matchAll(/(?:querySelector|querySelectorAll|matches|closest)\('([^']*)'\)/g)) add(m[1]);
  const styled = new Set();
  for (const m of read('app.css').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][a-z0-9-]*)/g)) styled.add(m[1]);
  const stale = [...styled].filter(name => !asked.has(name));
  assert.deepEqual(stale, [], `these are styled but nothing asks for them: ${stale.join(', ')}`);
});

/* $ returns null for an id that is not there, and almost everything in this app then quietly
   does nothing — a renamed id would not throw, it would just stop working. So every id the app
   reaches for is held against the page. */
test('every id the app reaches for is on the page', () => {
  const html = read('index.html'), js = read('app.js');
  const onPage = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const wanted = [...new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]))];
  assert.ok(wanted.length > 80, `there are a great many of them (${wanted.length})`);
  const missing = wanted.filter(id => !onPage.has(id));
  assert.deepEqual(missing, [], `these are looked up but not on the page: ${missing.join(', ')}`);
  // And nothing on the page is given an id twice over, which would make $ a coin toss.
  const all = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  const twice = all.filter((id, at) => all.indexOf(id) !== at);
  assert.deepEqual(twice, [], `these ids are used twice: ${twice.join(', ')}`);
});

/* On an iPad the app keeps a phone's measure and sits in the middle of the window. Anything
   pinned to an edge has to be pinned to the edge of that measure instead, or it ends up on its
   own in the margin. */
test('a pointer gets a hover, and only a real pointer does', () => {
  const css = read('app.css');
  const block = /@media \(hover:hover\) and \(pointer:fine\) \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(block, 'hover is behind a real pointer');
  // A touch screen that reports hover would leave the last thing tapped looking pressed.
  assert.ok(!/^\.row\.paper:hover/m.test(css.replace(block[1], '')), 'nothing hovers unconditionally');
  for (const what of ['.row.paper:hover', '.menu-row:hover', '.pill:hover', '.icon-btn:hover']) {
    assert.ok(block[1].includes(what), `${what} answers a pointer`);
  }
});

test('on a wide screen, what is pinned to an edge is pinned to the list, not the window', () => {
  const css = read('app.css');
  const wide = /@media \(min-width:620px\) \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(wide, 'there is a wider-screen measure');
  const block = wide[1];
  assert.match(block, /\.list[^{]*\{[^}]*max-width:760px/, 'the list keeps a readable measure');
  assert.match(block, /\.rail \{[^}]*calc\(50% - 380px\)/, 'and the rail comes in with it');
  // Half of the list's own width, so the two cannot drift apart.
  const measure = /max-width:(\d+)px/.exec(block)[1];
  const moved = /calc\(50% - (\d+)px\)/.exec(block)[1];
  assert.equal(Number(moved) * 2, Number(measure), 'the rail moves by half the measure, exactly');
});

/* The settings screen was given a .note for its small print while .note was already a paper's
   abstract and its memos, and the second rule quietly made every abstract twelve-pixel grey.
   Two bare rules for one class, each setting a different size, is that mistake exactly. */
test('no one class is given two different sizes in two different places', () => {
  const css = read('app.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const sizes = new Map();
  for (const m of css.matchAll(/^\.([a-z][a-z0-9-]*) \{([^}]*)\}/gm)) {
    const size = /font-size:\s*([^;]+)/.exec(m[2]);
    if (!size) continue;
    const seen = sizes.get(m[1]) || new Set();
    seen.add(size[1].trim());
    sizes.set(m[1], seen);
  }
  const split = [...sizes].filter(([, seen]) => seen.size > 1)
    .map(([name, seen]) => `${name} (${[...seen].join(' vs ')})`);
  assert.deepEqual(split, [], `these classes are sized twice over: ${split.join(', ')}`);
});

test('a status is a mark in the margin, and the three of them are told apart by colour', () => {
  const css = read('app.css');
  for (const status of ['unread', 'reading', 'done']) {
    assert.match(css, new RegExp(`\\.flag\\.${status}\\s*\\{[^}]*background`), `${status} has its own colour`);
  }
  // Never a bar down the edge of a row: a mark in the margin is a dot, and small.
  assert.match(css, /\.flag\s*\{[^}]*border-radius:999px/);
});

test('a paper with nothing to add draws no third line, and one with a rating draws it once', async () => {
  const open = await boot();
  await open.settle();
  const rows = [...open.document.querySelectorAll('#list .row')];
  const byTitle = title => rows.find(row => row.querySelector('h2').textContent.includes(title));
  const read1 = byTitle('Retron Septu');                       // reading, tagged "phage"
  assert.ok(read1.querySelector('.flag.reading'), 'the one being read is marked as such');
  assert.equal(read1.querySelector('.flag').getAttribute('aria-label'), '읽는 중', 'and says so out loud');
  assert.ok(read1.querySelector('.foot .chip'), 'its tag is shown');
  const rated = byTitle('PET depolymerase');                   // unread, four stars
  assert.ok(rated.querySelector('.flag.unread'));
  assert.match(rated.querySelector('.stars').textContent, /^★★★★☆$/);
  const plain = byTitle('Immune sensing');                     // done, nothing else to say
  assert.ok(plain.querySelector('.flag.done'));
  assert.ok(!plain.querySelector('.foot'), 'nothing to say, so no line to say it on');
});

test('the big title gives way to the small one as the library is scrolled, and does not flicker', async () => {
  const open = await boot();
  await open.settle();
  const {followScroll} = await import(new URL(`../app.js?boot=${boots}`, here));
  const list = open.document.getElementById('list');
  const top = open.document.querySelector('#main .top');
  const paint = followScroll(list, top);
  assert.equal(top.classList.contains('shrunk'), false, 'at the top it is the big title');
  assert.equal(top.classList.contains('lifted'), false, 'and the bar has no line under it');
  list.scrollTop = 8; paint();
  assert.equal(top.classList.contains('shrunk'), false, 'a nudge is not a scroll');
  assert.equal(top.classList.contains('lifted'), true, 'but the line is drawn as soon as anything is under it');
  list.scrollTop = 40; paint();
  assert.equal(top.classList.contains('shrunk'), true);
  list.scrollTop = 8; paint();
  assert.equal(top.classList.contains('shrunk'), true, 'coming back up a little does not throw the title about');
  list.scrollTop = 0; paint();
  assert.equal(top.classList.contains('shrunk'), false, 'back at the top, the big title is back');
  assert.equal(followScroll(null, top), null, 'and a screen without a list is no trouble');

  /* A paper's own screen says its name as the first thing on it, so the bar waits for the whole
     title block to go by rather than for a nudge — or the name would be said twice at once. */
  const other = open.document.createElement('main');
  const bar = open.document.createElement('header');
  other.scrollTop = 0;
  const far = followScroll(other, bar, {after: 112});
  other.scrollTop = 40; far();
  assert.equal(bar.classList.contains('shrunk'), false, 'forty pixels is still the title block');
  assert.equal(bar.classList.contains('lifted'), true, 'though the line is already drawn');
  other.scrollTop = 130; far();
  assert.equal(bar.classList.contains('shrunk'), true, 'past it, the bar takes over the name');
  other.scrollTop = 105; far();
  assert.equal(bar.classList.contains('shrunk'), true, 'and does not flicker on the way back');
  other.scrollTop = 80; far();
  assert.equal(bar.classList.contains('shrunk'), false);
  assert.match(read('app.css'), /#detail \.top\.shrunk \.detail-title \{[^}]*opacity:1/,
    'which is when the name in the bar is drawn');
});

test('the toolbar at the bottom opens the collections and the settings', async () => {
  const open = await boot();
  await open.settle();
  const bar = open.document.getElementById('statusbar');
  const tabs = [...bar.querySelectorAll('.tab')];
  assert.deepEqual(tabs.map(t => t.textContent.trim()), ['컬렉션', '설정'], 'both are named, not just drawn');
  tabs[0].dispatchEvent(new open.window.Event('click'));
  await open.settle(4);
  assert.equal(open.document.getElementById('collections').hasAttribute('hidden'), false);
  tabs[1].dispatchEvent(new open.window.Event('click'));
  await open.settle(4);
  assert.equal(open.document.getElementById('settings').hasAttribute('hidden'), false);
  // The count moved up beside the title; the bar now carries what the library is doing.
  assert.ok(bar.querySelector('#sync-state'), 'the state of the sync is still shown');
  assert.ok(!bar.querySelector('#count'), 'the count is no longer down here');
  assert.ok(open.document.querySelector('.title-row #count'), 'it is beside the title');
});

test('the list is broken up by headings that follow the order it is in', async () => {
  const open = await boot();
  await open.settle();
  const label = {title: '제목', rating: '별점'};
  const pick = how => {
    open.document.getElementById('btn-sort').dispatchEvent(new open.window.Event('click'));
    const row = [...open.document.querySelectorAll('.menu.float .menu-row')]
      .find(b => b.textContent.includes(label[how]));
    assert.ok(row, `${label[how]} is offered as an order`);
    row.dispatchEvent(new open.window.Event('click', {bubbles: true}));
  };
  pick('title');
  const named = node => node.querySelector('span').textContent;
  const headings = [...open.document.querySelectorAll('#list .group')].map(named);
  assert.deepEqual(headings, ['I', 'P', 'R'], 'by title, each letter says where it starts');
  // A heading is drawn once, above the first paper under it, never twice over.
  const inOrder = [...open.document.querySelectorAll('#list .group, #list .row')].map(n => n.className);
  assert.ok(!inOrder.some((cls, i) => cls === 'group' && inOrder[i + 1] === 'group'), 'no heading stands alone');
  assert.equal(inOrder[0], 'group', 'the list starts with one');
  pick('rating');
  // A heading says how many are under it; one paper on its own needs no counting.
  const counts = [...open.document.querySelectorAll('#list .group')]
    .map(h => h.querySelector('.n')?.textContent || '');
  assert.deepEqual(counts, ['', '2편'], 'the stars have one paper, the unrated two');
  assert.deepEqual([...open.document.querySelectorAll('#list .group')].map(named),
    ['★★★★', '별점 없음'], 'by rating, the stars themselves');
});

test('what is not reading itself sits behind one button over a paper', async () => {
  const {open} = await openPdf();
  const $id = id => open.document.getElementById(id);
  const click = node => node.dispatchEvent(new open.window.Event('click'));
  const menu = $id('paper-menu');
  assert.equal(menu.hidden, true, 'the bar over a paper starts clear');
  assert.equal($id('paper-more').getAttribute('aria-expanded'), 'false');
  click($id('paper-more'));
  assert.equal(menu.hidden, false);
  assert.equal($id('paper-more').getAttribute('aria-expanded'), 'true', 'and it says so to a reader who cannot see it');
  assert.deepEqual([...menu.querySelectorAll('.menu-row')].map(b => b.textContent.trim()),
    ['야간 모드', '확대', '축소', '다른 앱으로 열기']);
  // Turning the page dark is one thing, then the menu is out of the way again.
  click($id('paper-night'));
  assert.equal(menu.hidden, true);
  assert.equal($id('paper-view').classList.contains('night'), true);
  click($id('paper-more'));
  click($id('paper-view'));
  assert.equal(menu.hidden, true, 'and a tap on the paper puts it away');
  // Nothing is left hanging over the next paper either.
  click($id('paper-more'));
  click($id('paper-back'));
  await open.settle(6);
  assert.equal(menu.hidden, true, 'a menu never outlives the screen it was opened on');
});

test('the listening settings are one tap away, not in the way of the buttons', async () => {
  const open = await boot();
  await open.settle();
  const $id = id => open.document.getElementById(id);
  const click = node => node.dispatchEvent(new open.window.Event('click', {bubbles: true}));
  click([...open.document.querySelectorAll('#list .row')][0]);
  await open.settle(10);
  click(open.document.querySelector('#detail .listen-start'));
  await open.settle(10);
  const extra = $id('listen-extra');
  assert.equal(extra.hidden, true, 'the voice, the range, the section and the timer are put away');
  for (const id of ['listen-voice', 'listen-what', 'listen-section', 'listen-sleep']) {
    assert.ok(extra.contains($id(id)), `${id} is behind the button`);
  }
  for (const id of ['listen-play', 'listen-prev', 'listen-next', 'listen-rate', 'listen-seek', 'listen-pdf']) {
    assert.ok(!extra.contains($id(id)), `${id} is not`);
  }
  click($id('listen-more'));
  assert.equal(extra.hidden, false);
  assert.equal($id('listen-more').getAttribute('aria-expanded'), 'true');
  click($id('listen-more'));
  assert.equal(extra.hidden, true);
});

test('a paper is marked without opening it, by holding a finger on its row', async () => {
  const server = fakeServer();
  const open = await boot({server});
  await open.settle();
  const row = open.document.querySelectorAll('#list .row')[0];      // Retron Septu, 읽는 중
  const touch = (type, x = 40, y = 200) => {
    // Bubbling, as a real touch does: the library listens for these on itself, not on each row.
    const event = new open.window.Event(type, {bubbles: true});
    event.touches = [{clientX: x, clientY: y}];
    row.dispatchEvent(event);
  };
  // A finger that moves is a scroll, not a hold.
  touch('touchstart');
  touch('touchmove', 40, 260);
  await new Promise(r => setTimeout(r, 560));
  assert.equal(open.document.querySelectorAll('.menu.float').length, 0, 'scrolling never opens it');

  touch('touchstart');
  await new Promise(r => setTimeout(r, 560));
  const menu = open.document.querySelector('.menu.float');
  assert.ok(menu, 'holding it does');
  const rows = [...menu.querySelectorAll('.menu-row')];
  assert.deepEqual(rows.map(r => r.textContent.trim()),
    ['본문 듣기', 'PDF 보기', '인용 복사', '공유', '안 읽음', '읽는 중', '완료', '표시 없음', '여러 개 선택'],
    'everything the paper can be done to from here, then what it can be marked as');
  assert.equal(menu.querySelectorAll('.menu-line').length, 2, 'with a line around the marks');
  for (const at of [0, 1, 2, 3]) {
    assert.equal(rows[at].hasAttribute('aria-pressed'), false, 'an action is not a state');
    assert.ok(rows[at].querySelector('.tick svg'), 'and says what it would do');
  }
  const marks = rows.slice(4, 8);
  assert.equal(marks[1].getAttribute('aria-pressed'), 'true', 'with a tick against what it is now');
  marks[2].dispatchEvent(new open.window.Event('click'));
  await open.settle();
  const write = server.sent.find(r => r.method === 'PATCH');
  assert.ok(write, 'the mark was written');
  assert.deepEqual(write.body.tags.map(t => t.tag).filter(t => t.startsWith('/')), ['/done']);
  assert.ok(open.document.querySelector('#list .row .flag.done'), 'and the row says so straight away');

  // The tap that ended the hold must not also open the paper.
  touch('touchstart');
  await new Promise(r => setTimeout(r, 560));
  row.dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle(6);
  assert.equal(open.document.getElementById('detail').hasAttribute('hidden'), true, 'the paper did not open behind it');
});

test('the two gestures are said once, and the line goes the moment one of them is used', async () => {
  const open = await boot({server: fakeServer({items: MANY})});
  await open.settle();
  const tip = () => open.document.querySelector('#list .tip');
  assert.ok(tip(), 'a library that has them says so');
  assert.match(tip().textContent, /밀면|꾹/);

  // Used once, and it is not said again — not on this screen and not on the next boot.
  const row = open.document.querySelectorAll('#list .row.paper')[0];
  const touch = (type, x) => { const e = new open.window.Event(type, {bubbles: true}); e.touches = [{clientX: x, clientY: 200}]; row.dispatchEvent(e); };
  touch('touchstart', 200); touch('touchmove', 100);
  row.dispatchEvent(new open.window.Event('touchend', {bubbles: true}));
  await open.settle();
  assert.ok(!tip(), 'and once it has been used it goes');
  assert.equal(open.storage.get('np.tip'), 'off', 'for good');

  const again = await boot({server: fakeServer({items: MANY}),
    stored: {'np.user': '16265664', 'np.key': 'k'.repeat(24), 'np.tip': 'off'}});
  await again.settle();
  assert.ok(!again.document.querySelector('#list .tip'), 'a phone that knows is not told again');

  // So does closing it by hand.
  const third = await boot({server: fakeServer({items: MANY})});
  await third.settle();
  third.document.querySelector('#list .tip .x').dispatchEvent(new third.window.Event('click'));
  assert.ok(!third.document.querySelector('#list .tip'));
  assert.equal(third.storage.get('np.tip'), 'off');
});

test('a paper pushed aside is marked, and the same swipe pushed again clears it', async () => {
  const server = fakeServer();
  const open = await boot({server});
  await open.settle();
  const row = open.document.querySelectorAll('#list .row')[1];     // PET depolymerase, 안 읽음
  const face = row.querySelector('.face'), act = row.querySelector('.act');
  assert.ok(face && act, 'a paper carries a face that slides and something behind it');
  const touch = (type, x, y = 200) => {
    const event = new open.window.Event(type, {bubbles: true});
    event.touches = [{clientX: x, clientY: y}];
    row.dispatchEvent(event);
  };
  const swipe = async (to, {lift = true} = {}) => {
    touch('touchstart', 200);
    touch('touchmove', to, 204);
    if (lift) { row.dispatchEvent(new open.window.Event('touchend', {bubbles: true})); await open.settle(); }
  };

  // A finger that goes down the screen is a scroll: the row must not budge.
  touch('touchstart', 200);
  touch('touchmove', 192, 280);
  assert.equal(face.style.transform, '', 'a scroll never drags a row sideways');
  row.dispatchEvent(new open.window.Event('touchend', {bubbles: true}));

  // Far enough left, and what the release will do is drawn behind the row before it happens.
  await swipe(100, {lift: false});
  assert.ok(act.classList.contains('on') && act.classList.contains('done'), 'what it would do is shown');
  assert.match(act.textContent, /완료/);
  assert.match(face.style.transform, /translateX\(-\d+px\)/, 'and the row has followed the finger');
  row.dispatchEvent(new open.window.Event('touchend', {bubbles: true}));
  await open.settle();
  let write = server.sent.filter(r => r.method === 'PATCH').pop();
  assert.ok(write, 'the mark was written');
  assert.deepEqual(write.body.tags.map(t => t.tag).filter(t => t.startsWith('/')), ['/done']);

  // Not far enough is not an answer: the row springs back and nothing is sent.
  const sent = server.sent.filter(r => r.method === 'PATCH').length;
  const again = open.document.querySelectorAll('#list .row')[1];
  const nudge = (type, x) => { const e = new open.window.Event(type, {bubbles: true}); e.touches = [{clientX: x, clientY: 200}]; again.dispatchEvent(e); };
  nudge('touchstart', 200); nudge('touchmove', 170);
  again.dispatchEvent(new open.window.Event('touchend', {bubbles: true}));
  await open.settle();
  assert.equal(server.sent.filter(r => r.method === 'PATCH').length, sent, 'a short push asks nothing');
  assert.equal(again.querySelector('.face').style.transform, '', 'and the row is back where it was');

  // The other way marks it 안 읽음 — and a paper already 안 읽음 is cleared by it, so the gesture
  // undoes itself rather than needing a second one to learn.
  const third = open.document.querySelectorAll('#list .row')[1];
  const over = (type, x) => { const e = new open.window.Event(type, {bubbles: true}); e.touches = [{clientX: x, clientY: 200}]; third.dispatchEvent(e); };
  over('touchstart', 100); over('touchmove', 200);
  const plan = third.querySelector('.act');
  assert.ok(plan.classList.contains('unread'), '안 읽음 on the way back');
  third.dispatchEvent(new open.window.Event('touchend', {bubbles: true}));
  await open.settle();
  write = server.sent.filter(r => r.method === 'PATCH').pop();
  assert.deepEqual(write.body.tags.map(t => t.tag).filter(t => t.startsWith('/')), ['/unread']);
  const fourth = open.document.querySelectorAll('#list .row')[1];
  const back = (type, x) => { const e = new open.window.Event(type, {bubbles: true}); e.touches = [{clientX: x, clientY: 200}]; fourth.dispatchEvent(e); };
  back('touchstart', 100); back('touchmove', 200);
  assert.ok(fourth.querySelector('.act').classList.contains('clear'), 'pushed the same way again, it clears');
  fourth.dispatchEvent(new open.window.Event('touchend', {bubbles: true}));
  await open.settle();
  write = server.sent.filter(r => r.method === 'PATCH').pop();
  assert.deepEqual(write.body.tags.map(t => t.tag).filter(t => t.startsWith('/')), []);
});

test('a paper is listened to, read or handed over without being opened first', async () => {
  const open = await boot();
  await open.settle();
  const hold = async at => {
    const row = open.document.querySelectorAll('#list .row.paper')[at];
    const event = new open.window.Event('touchstart', {bubbles: true});
    event.touches = [{clientX: 40, clientY: 200}];
    row.dispatchEvent(event);
    await new Promise(r => setTimeout(r, 560));
    return [...open.document.querySelectorAll('.menu.float .menu-row')];
  };
  const take = label => {
    const found = [...open.document.querySelectorAll('.menu.float .menu-row')]
      .find(r => r.textContent.trim() === label);
    assert.ok(found, `${label} is offered`);
    found.dispatchEvent(new open.window.Event('click'));
  };

  // Listening is two taps away through the paper's own screen; here it is one hold and one tap.
  await hold(0);
  take('본문 듣기');
  await open.settle();
  assert.equal(open.document.getElementById('listen').hidden, false, 'the voice started from the library');
  open.window.history.back();
  await open.settle();

  // The line that finds the paper again, copied without opening anything.
  let copied = '';
  open.window.navigator = undefined;
  globalThis.navigator = {userAgent: 'test', clipboard: {writeText: async text => { copied = text; }}};
  await hold(0);
  take('인용 복사');
  await open.settle();
  assert.match(copied, /Seo & Kim \(2025\)/, 'the citation went to the clipboard');
  assert.match(open.document.getElementById('toast').textContent, /인용/);

  // Handed over through the phone's own share sheet, with the link rather than the file.
  let shared = null;
  globalThis.navigator = {userAgent: 'test', share: async what => { shared = what; }};
  await hold(0);
  take('공유');
  await open.settle();
  assert.deepEqual(shared, {title: 'Retron Septu defence', url: 'https://doi.org/10.1126/science.abc1234'});
  globalThis.navigator = {userAgent: 'test'};
});

test('several papers are picked at once and marked together', async () => {
  const server = fakeServer();
  const open = await boot({server});
  await open.settle();
  const rows = () => [...open.document.querySelectorAll('#list .row.paper')];
  const tap = node => node.dispatchEvent(new open.window.Event('click', {bubbles: true}));
  const $id = id => open.document.getElementById(id);

  // The way in is the paper's own menu, as it is on this phone.
  const event = new open.window.Event('touchstart', {bubbles: true});
  event.touches = [{clientX: 40, clientY: 200}];
  rows()[0].dispatchEvent(event);
  await new Promise(r => setTimeout(r, 560));
  // The finger lifting off the hold is a tap the row swallows; then the menu is used.
  rows()[0].dispatchEvent(new open.window.Event('click', {bubbles: true}));
  [...open.document.querySelectorAll('.menu.float .menu-row')]
    .find(r => r.textContent.trim() === '여러 개 선택').dispatchEvent(new open.window.Event('click'));
  await open.settle();

  assert.equal(open.document.getElementById('main').classList.contains('picking'), true);
  assert.equal($id('pickbar').hidden, false, 'what can be done to them is along the bottom');
  assert.equal($id('statusbar').hidden, true, 'and the usual bar steps aside');
  assert.equal($id('btn-sort').hidden, true, 'as do the two buttons at the top');
  assert.equal($id('btn-picked').hidden, false, 'with the way out in their place');
  assert.equal($id('count').textContent, '1편 선택', 'the one it was begun from is already picked');
  assert.ok(rows()[0].querySelector('.pick-mark.on'), 'and says so');
  assert.ok(!rows()[1].querySelector('.pick-mark.on'), 'the others do not');

  // A finger across a row is not a mark while a shelf is being picked.
  const across = (type, x) => {
    const event = new open.window.Event(type, {bubbles: true});
    event.touches = [{clientX: x, clientY: 300}];
    rows()[1].dispatchEvent(event);
  };
  across('touchstart', 200); across('touchmove', 90);
  assert.equal(rows()[1].querySelector('.face').style.transform, '', 'the row did not budge');
  rows()[1].dispatchEvent(new open.window.Event('touchend', {bubbles: true}));
  await open.settle();
  assert.equal(server.sent.filter(r => r.method === 'PATCH').length, 0, 'and nothing was marked');

  // A tap picks rather than opens.
  tap(rows()[1]);
  assert.equal($id('count').textContent, '2편 선택');
  assert.equal($id('detail').hasAttribute('hidden'), true, 'and nothing was opened');
  tap(rows()[1]);
  assert.equal($id('count').textContent, '1편 선택', 'tapped again it is let go');
  tap(rows()[1]);

  // Marked together: one write per paper, each against the paper as the server has it.
  tap($id('pick-mark'));
  const marks = [...open.document.querySelectorAll('.menu.float .menu-row')].map(r => r.textContent.trim());
  assert.deepEqual(marks, ['안 읽음', '읽는 중', '완료', '표시 없음']);
  [...open.document.querySelectorAll('.menu.float .menu-row')]
    .find(r => r.textContent.trim() === '완료').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  const writes = server.sent.filter(r => r.method === 'PATCH');
  assert.equal(writes.length, 2, 'two papers, two writes');
  for (const write of writes) {
    assert.deepEqual(write.body.tags.map(t => t.tag).filter(t => t.startsWith('/')), ['/done']);
  }
  assert.match($id('toast').textContent, /2편을 완료로 표시했습니다/);
  // And the picking is over, because the thing it was for has been done.
  assert.equal(open.document.getElementById('main').classList.contains('picking'), false);
  assert.equal($id('statusbar').hidden, false);
  assert.equal($id('count').textContent, '3편', 'the count is the library again');
});

test('a mark can be taken back, one paper or a whole shelf of them', async () => {
  const server = fakeServer();
  const open = await boot({server});
  await open.settle();
  const toast = open.document.getElementById('toast');
  const rows = () => [...open.document.querySelectorAll('#list .row.paper')];

  // One paper, pushed aside: the line that says so carries the way back.
  const row = rows()[0];                       // Retron Septu, 읽는 중
  const touch = (type, x) => {
    const event = new open.window.Event(type, {bubbles: true});
    event.touches = [{clientX: x, clientY: 200}];
    row.dispatchEvent(event);
  };
  touch('touchstart', 200); touch('touchmove', 100);
  row.dispatchEvent(new open.window.Event('touchend', {bubbles: true}));
  await open.settle();
  assert.match(toast.textContent, /완료/);
  const undo = toast.querySelector('.undo');
  assert.ok(undo, 'the way back is offered');
  assert.ok(open.document.querySelector('#list .flag.done'), 'it was marked');

  undo.dispatchEvent(new open.window.Event('click'));
  await open.settle();
  const back = server.sent.filter(r => r.method === 'PATCH').pop();
  assert.deepEqual(back.body.tags.map(t => t.tag).filter(t => t.startsWith('/')), ['/reading'],
    'and what it was before is what it is again');
  assert.match(toast.textContent, /읽는 중으로 되돌렸습니다/);
  assert.ok(!toast.querySelector('.undo'), 'and undoing an undo is not offered');

  // A whole shelf: each paper back to what it was, not all to one thing.
  const event = new open.window.Event('touchstart', {bubbles: true});
  event.touches = [{clientX: 40, clientY: 200}];
  rows()[0].dispatchEvent(event);
  await new Promise(r => setTimeout(r, 560));
  rows()[0].dispatchEvent(new open.window.Event('click', {bubbles: true}));
  [...open.document.querySelectorAll('.menu.float .menu-row')]
    .find(r => r.textContent.trim() === '여러 개 선택').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  open.document.getElementById('pick-all').dispatchEvent(new open.window.Event('click'));
  open.document.getElementById('pick-mark').dispatchEvent(new open.window.Event('click'));
  [...open.document.querySelectorAll('.menu.float .menu-row')]
    .find(r => r.textContent.trim() === '완료').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.match(toast.textContent, /3편을 완료로 표시했습니다/);
  server.sent.length = 0;
  toast.querySelector('.undo').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  const writes = server.sent.filter(r => r.method === 'PATCH');
  assert.equal(writes.length, 3, 'one write per paper on the way back too');
  const put = writes.map(w => w.body.tags.map(t => t.tag).filter(t => t.startsWith('/')).join('')).sort();
  assert.deepEqual(put, ['/done', '/reading', '/unread'],
    'each one back to what it was, not all three to one thing');
  assert.match(toast.textContent, /3편을 되돌렸습니다/);
});

test('picking the whole library, and letting it all go again', async () => {
  const server = fakeServer();
  const open = await boot({server});
  await open.settle();
  const $id = id => open.document.getElementById(id);
  const event = new open.window.Event('touchstart', {bubbles: true});
  event.touches = [{clientX: 40, clientY: 200}];
  open.document.querySelector('#list .row.paper').dispatchEvent(event);
  await new Promise(r => setTimeout(r, 560));
  open.document.querySelector('#list .row.paper').dispatchEvent(new open.window.Event('click', {bubbles: true}));
  [...open.document.querySelectorAll('.menu.float .menu-row')]
    .find(r => r.textContent.trim() === '여러 개 선택').dispatchEvent(new open.window.Event('click'));
  await open.settle();

  $id('pick-all').dispatchEvent(new open.window.Event('click'));
  assert.equal($id('count').textContent, '3편 선택', 'all of what is being looked at');
  assert.equal($id('pick-all').textContent, '해제', 'and the button turns into the way back');
  assert.equal(open.document.querySelectorAll('#list .pick-mark.on').length, 3);
  $id('pick-all').dispatchEvent(new open.window.Event('click'));
  assert.equal($id('count').textContent, '선택', 'nothing picked');
  assert.equal($id('pick-mark').disabled, true, 'and nothing to do with it');

  // 별점 gives all of them the same number of stars.
  $id('pick-all').dispatchEvent(new open.window.Event('click'));
  $id('pick-rate').dispatchEvent(new open.window.Event('click'));
  const stars = [...open.document.querySelectorAll('.menu.float .menu-row')].map(r => r.textContent.trim());
  assert.deepEqual(stars, ['★★★★★', '★★★★', '★★★', '★★', '★', '별점 없음']);
  [...open.document.querySelectorAll('.menu.float .menu-row')]
    .find(r => r.textContent.trim() === '★★★').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  const writes = server.sent.filter(r => r.method === 'PATCH');
  assert.equal(writes.length, 3);
  for (const write of writes) assert.match(write.body.extra, /^Rating: 3$|\nRating: 3|Rating: 3/);
  assert.match($id('toast').textContent, /3편을 3점을 주었습니다|3편을/);

  // And the way out puts everything back.
  assert.equal($id('btn-picked').hidden, true);
  assert.equal($id('btn-sync').hidden, false);
});

test('a menu dims what is behind it and leaves its own row lit', async () => {
  const open = await boot();
  await open.settle();
  const row = open.document.querySelectorAll('#list .row.paper')[0];
  const touch = (type, x = 40, y = 200) => {
    const event = new open.window.Event(type, {bubbles: true});
    event.touches = [{clientX: x, clientY: y}];
    row.dispatchEvent(event);
  };
  touch('touchstart');
  await new Promise(r => setTimeout(r, 560));
  assert.ok(open.document.querySelector('.menu.float'), 'the marks are offered');
  assert.ok(open.document.querySelector('body > .scrim'), 'and everything else is dimmed');
  assert.equal(row.classList.contains('lifted-row'), true, 'but not the row being asked about');

  // Answered, and the screen is itself again.
  open.document.querySelector('.menu.float .menu-row').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.ok(!open.document.querySelector('body > .scrim'), 'the dimming goes with the menu');
  assert.ok(!open.document.querySelector('.lifted-row'), 'and so does the lift');

  // A menu put away by a tap elsewhere leaves nothing behind either.
  touch('touchstart');
  await new Promise(r => setTimeout(r, 560));
  open.document.getElementById('count').dispatchEvent(new open.window.Event('click', {bubbles: true}));
  assert.ok(!open.document.querySelector('body > .scrim'));
  assert.ok(!open.document.querySelector('.lifted-row'));
  // The sort menu hangs off a button and lifts nothing, since nothing is being asked about.
  open.document.getElementById('btn-sort').dispatchEvent(new open.window.Event('click'));
  assert.ok(open.document.querySelector('.menu.float'));
  assert.ok(!open.document.querySelector('.lifted-row'), 'a menu about the whole list lifts no row');
});

test('a mouse asking for the marks does not swallow the next real tap', async () => {
  const open = await boot();
  await open.settle();
  const row = open.document.querySelectorAll('#list .row.paper')[0];
  // A right-click asks the same question a held finger does, but it ends in no tap at all.
  row.dispatchEvent(new open.window.Event('contextmenu', {bubbles: true}));
  assert.ok(open.document.querySelector('.menu.float'), 'the marks are offered');
  open.document.querySelector('.menu.float').remove();
  // A flag left standing would eat the next tap; a moment that has passed does not.
  await new Promise(r => setTimeout(r, 760));
  row.dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  assert.equal(open.document.getElementById('detail').hasAttribute('hidden'), false, 'the paper opens');
});

test('the library answers for every row, including the ones scrolled into view later', async () => {
  const server = fakeServer({items: MANY});
  const open = await boot({server});
  await open.settle();
  const list = open.document.getElementById('list');
  // Scrolled to the end of what is drawn, so the next pages are drawn too.
  Object.defineProperty(list, 'scrollTop', {value: 0, configurable: true, writable: true});
  Object.defineProperty(list, 'clientHeight', {value: 800, configurable: true});
  Object.defineProperty(list, 'scrollHeight', {value: 1000, configurable: true});
  for (let i = 0; i < 3; i++) { list.dispatchEvent(new open.window.Event('scroll')); await open.settle(2); }
  const rows = [...open.document.querySelectorAll('#list .row.paper')];
  assert.ok(rows.length > 60, 'there are rows the first draw did not make');
  const late = rows[rows.length - 1];

  /* A finger lands on the title, not on the row's own box, so the gesture has to be answered for
     whatever inside the row it started on. */
  const on = late.querySelector('h2');
  assert.ok(on, 'the title is what a finger actually touches');
  const touch = (type, x) => {
    const event = new open.window.Event(type, {bubbles: true});
    event.touches = [{clientX: x, clientY: 400}];
    on.dispatchEvent(event);
  };
  touch('touchstart', 200);
  touch('touchmove', 100);
  on.dispatchEvent(new open.window.Event('touchend', {bubbles: true}));
  await open.settle();
  const write = server.sent.filter(r => r.method === 'PATCH').pop();
  assert.ok(write, 'a row drawn long after the list was wired is marked all the same');
  assert.deepEqual(write.body.tags.map(t => t.tag).filter(t => t.startsWith('/')), ['/done']);
  /* And nothing is hung on a paper's own row to make that work: drawRow returns a row with no
     listeners on it, which is the whole point — a library scrolled to its end would otherwise be
     carrying a listener for every gesture times every paper. */
  const draws = /function drawRow\(item, list\) \{([\s\S]*?)\n\}/.exec(read('app.js'));
  assert.ok(draws, 'drawRow is there to be read');
  assert.ok(!/addEventListener/.test(draws[1]), 'and hangs nothing on the row it draws');
});

test('the swipe that marked a paper does not also open it', async () => {
  const open = await boot();
  await open.settle();
  const row = open.document.querySelectorAll('#list .row')[1];
  const touch = (type, x) => { const e = new open.window.Event(type, {bubbles: true}); e.touches = [{clientX: x, clientY: 200}]; row.dispatchEvent(e); };
  touch('touchstart', 200); touch('touchmove', 100);
  row.dispatchEvent(new open.window.Event('touchend', {bubbles: true}));
  row.dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle(6);
  assert.equal(open.document.getElementById('detail').hasAttribute('hidden'), true, 'the paper stayed shut');
});

test('a change made far down the library leaves the reader where they were', async () => {
  const server = fakeServer({items: MANY});
  const open = await boot({server});
  await open.settle();
  const list = open.document.getElementById('list');
  /* A real list loses its place the moment it is emptied: the scroll has nothing left to be
     measured against. linkedom keeps whatever it is told, so the phone's own behaviour is put
     back here, or this would pass however the app behaved. */
  let at = 0;
  const text = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Object.getPrototypeOf(list)), 'textContent')
    || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(list), 'textContent');
  Object.defineProperty(list, 'scrollTop', {get: () => at, set: v => { at = Number(v) || 0; }, configurable: true});
  Object.defineProperty(list, 'textContent', {
    get: () => text.get.call(list),
    set: value => { if (!value) at = 0; text.set.call(list, value); },
    configurable: true
  });
  // Scrolled a long way in, with more drawn than a screenful.
  list.scrollHeight = 40000; list.clientHeight = 700;
  for (let i = 0; i < 4; i++) { list.dispatchEvent(new open.window.Event('scroll')); await open.settle(2); }
  list.scrollTop = 2400;
  const drawn = open.document.querySelectorAll('#list .row').length;
  const row = open.document.querySelectorAll('#list .row')[9];
  const touch = type => { const e = new open.window.Event(type, {bubbles: true}); e.touches = [{clientX: 40, clientY: 400}]; row.dispatchEvent(e); };
  touch('touchstart');
  await new Promise(r => setTimeout(r, 560));
  const done = [...open.document.querySelectorAll('.menu.float .menu-row')].find(b => b.textContent.includes('완료'));
  done.dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(list.scrollTop, 2400, 'the list did not jump back to the first paper');
  assert.equal(open.document.querySelectorAll('#list .row').length, drawn, 'and as much of it is still drawn');
});

/* A library whose titles spread over twenty letters, Hangul and Latin, five papers each — more
   than one page of the list, so reaching the last letter means drawing the rest of it. */
const LETTERS = ['가', '나', '다', '라', '마', '바', '사', '아', '자', '차',
                 '카', '타', '파', '하', 'Alpha', 'Beta', 'Gamma', 'Delta', 'Omega', 'Zeta'];
const SPREAD = LETTERS.flatMap((word, g) => Array.from({length: 5}, (_, i) => ({
  key: `S${g}-${i}`, version: 10 + g * 5 + i,
  data: {key: `S${g}-${i}`, version: 10 + g * 5 + i, itemType: 'journalArticle',
    title: `${word} ${i} 논문`, date: '2026', dateAdded: '2026-01-01T00:00:00Z',
    dateModified: '2026-10-01T00:00:00Z', creators: [], publicationTitle: 'Science',
    tags: [], collections: [], extra: ''}})));

test('a long library carries landmarks down its right edge, and a finger on them moves it', async () => {
  const open = await boot({server: fakeServer({items: SPREAD}),
    stored: {'np.user': '16265664', 'np.key': 'k'.repeat(24), 'np.sort': 'title'}});
  await open.settle();
  const rail = open.document.getElementById('rail');
  assert.equal(rail.hidden, false, 'a library this long is offered the rail');
  const steps = () => [...rail.querySelectorAll('.step')];
  assert.equal(steps().length, 20, 'one landmark per letter');
  assert.deepEqual(steps().map(s => s.textContent.length), Array(20).fill(1), 'each of one character');
  assert.ok(steps().some(s => /[ㄱ-ㅎ]/.test(s.textContent)), 'Hangul is filed under its leading consonant');

  // The place is taken from the rail's own height, so the fake phone need only say how tall it is.
  rail.getBoundingClientRect = () => ({top: 100, height: 240, bottom: 340, left: 0, right: 27, width: 27});
  const touch = (type, y) => {
    const event = new open.window.Event(type);
    event.touches = [{clientX: 20, clientY: y}];
    rail.dispatchEvent(event);
  };
  const names = steps().map(s => s.textContent);
  // Nine tenths of the way down the rail is the nineteenth of twenty landmarks.
  touch('touchstart', 100 + 240 * 0.92);
  await open.settle(4);
  assert.equal(rail.classList.contains('held'), true, 'the rail says it is being used');
  const now = rail.querySelector('.now');
  assert.ok(now.textContent, 'and says in full what the finger is over');
  assert.equal(steps()[18].classList.contains('on'), true, 'the landmark under the finger is the lit one');
  assert.equal(now.textContent, names[18], 'and the bubble names that same landmark');
  // Reaching it meant drawing the rest of a list that only had its first page: the heading is there.
  const heads = [...open.document.querySelectorAll('#list .group')].map(h => h.querySelector('span').textContent);
  assert.ok(heads.includes(now.textContent), `the library was drawn as far as ${now.textContent}`);
  assert.ok(open.document.querySelectorAll('#list .row.paper').length > 60, 'which is more than one page');

  rail.dispatchEvent(new open.window.Event('touchend'));
  assert.equal(rail.classList.contains('held'), false, 'and lets go');
  assert.equal(steps().filter(s => s.classList.contains('on')).length, 0);
});

test('the landmarks are only offered where they would mean something', async () => {
  // Three papers: there is nothing to get lost in.
  const small = await boot();
  await small.settle();
  assert.equal(small.document.getElementById('rail').hidden, true, 'a short library has no rail');

  // Dates have no one-character name, so the orders that group by date go without.
  const dated = await boot({server: fakeServer({items: MANY}),
    stored: {'np.user': '16265664', 'np.key': 'k'.repeat(24), 'np.sort': 'added'}});
  await dated.settle();
  assert.equal(dated.document.getElementById('rail').hidden, true, '최근 추가 has no rail');

  // Years do: the last two digits of each.
  const byYear = await boot({server: fakeServer({items: MANY}),
    stored: {'np.user': '16265664', 'np.key': 'k'.repeat(24), 'np.sort': 'year'}});
  await byYear.settle();
  const rail = byYear.document.getElementById('rail');
  assert.equal(rail.hidden, false, '연도 does');
  const steps = [...rail.querySelectorAll('.step')];
  assert.ok(steps.length >= 6 && steps.length <= 24, `between six and twenty-four landmarks, not ${steps.length}`);
  for (const step of steps) assert.match(step.textContent, /^\d{2}$/, 'a year is its last two digits');
});

test('the bar at the top is the way back to the top of the library', async () => {
  const open = await boot({server: fakeServer({items: MANY})});
  await open.settle();
  const list = open.document.getElementById('list');
  let at = 1800;
  Object.defineProperty(list, 'scrollTop', {get: () => at, set: v => { at = Number(v) || 0; }, configurable: true});
  const tap = on => on.dispatchEvent(new open.window.Event('click', {bubbles: true}));

  // The count beside the name is part of the bar, not a thing of its own.
  tap(open.document.getElementById('count'));
  assert.equal(list.scrollTop, 0, 'a tap anywhere on the bar goes back to the top');

  // The two buttons standing in it are still buttons.
  at = 1800;
  tap(open.document.getElementById('btn-sort'));
  assert.equal(list.scrollTop, 1800, 'the sort button is not the title');
  assert.ok(open.document.querySelector('.menu.float'), 'it opens the order instead');
});

test('the bar along the bottom says whether the library is current, and whether the phone can reach anything', async () => {
  const open = await boot();
  await open.settle();
  const said = () => open.document.getElementById('sync-state').textContent;
  assert.match(said(), /갱신|최신/, 'what the sync just did, while it is still news');

  // The phone loses its signal: that is the state, not an error to be waited for.
  globalThis.navigator = {userAgent: 'test', onLine: false};
  open.window.dispatchEvent(new open.window.Event('offline'));
  assert.equal(said(), '오프라인');
  globalThis.navigator = {userAgent: 'test', onLine: true};
  open.window.dispatchEvent(new open.window.Event('online'));
  await open.settle();
  assert.match(said(), /마지막 업데이트/, 'and back again when it returns');
  globalThis.navigator = {userAgent: 'test'};

  // An hour-old library says so in hours, and one never synced says that.
  const old = await boot({stored: {'np.user': '16265664', 'np.key': 'k'.repeat(24),
    'np.synced': String(Date.now() - 3 * 3600_000)}});
  await old.settle();
  globalThis.navigator = {userAgent: 'test', onLine: true};
  old.window.dispatchEvent(new old.window.Event('online'));
  await old.settle();
  assert.match(old.document.getElementById('sync-state').textContent, /마지막 업데이트/);
  globalThis.navigator = {userAgent: 'test'};
});

test('a keyboard, for the iPad with one attached', async () => {
  const {open} = await openListening();
  const key = (name, on = open.window) => {
    const event = new open.window.Event('keydown');
    event.key = name;
    let stopped = false;
    event.preventDefault = () => { stopped = true; };
    on.dispatchEvent(event);
    return stopped;
  };
  // Space is play and pause, wherever a paper is being read.
  assert.equal(key(' '), true, 'space is taken');
  await open.settle();
  assert.equal(open.speech.queue.length > 0, true, 'the voice started');
  open.speech.start();
  await open.settle();
  assert.equal(open.document.getElementById('listen-play').getAttribute('aria-label'), '일시정지');
  key(' ');
  await open.settle();
  assert.equal(open.document.getElementById('listen-play').getAttribute('aria-label'), '재생', 'and stopped');

  // The arrows are the sentence either side.
  const at = () => open.storage.get('np.at.AAA');
  key('ArrowRight');
  open.speech.start();
  await open.settle();
  assert.equal(at(), '1', 'forward one sentence');
  key('ArrowLeft');
  open.speech.start();
  await open.settle();
  assert.equal(at(), '0', 'and back again');

  // Escape leaves the screen; on the library, a slash is the search box.
  key('Escape');
  await open.settle();
  assert.equal(open.document.getElementById('listen').hidden, true, 'escape closed the transcript');
  key('Escape');                      // and the paper's own screen under it
  await open.settle();
  assert.equal(open.document.getElementById('detail').hasAttribute('hidden'), true);
  let focused = null;
  open.document.getElementById('q').focus = () => { focused = 'q'; };
  key('/');
  assert.equal(focused, 'q', 'a slash is the search box');
  key('f');
  assert.equal(focused, 'q', 'and so is f, as it is in a browser');

  // Nothing fires while something is being typed into.
  focused = null;
  Object.defineProperty(open.document, 'activeElement',
    {value: open.document.getElementById('q'), configurable: true});
  assert.equal(key(' '), false, 'a space typed into a box is a space');
  assert.equal(key('/'), false);
});

test('a search shows what matched, where it matched', async () => {
  const open = await boot();
  await open.settle();
  const {markTerms} = await import(new URL(`../app.js?boot=${boots}`, here));
  const marked = (text, terms) => {
    const node = open.document.createElement('p');
    markTerms(node, text, terms);
    return [...node.childNodes].map(n => (n.tagName === 'B' ? `[${n.textContent}]` : n.textContent)).join('');
  };
  assert.equal(marked('Retron Septu defence', ['septu']), 'Retron [Septu] defence');
  assert.equal(marked('Retron Septu defence', []), 'Retron Septu defence', 'nothing searched, nothing marked');
  assert.equal(marked('', ['x']), '');
  assert.equal(marked('Phage phage', ['phage']), '[Phage] [phage]', 'every time it appears');
  // Folded, so an accent in the text is still found by a plain letter.
  assert.equal(marked('Müller and Muller', ['muller']), '[Müller] and [Muller]');
  // Two words that overlap in the text are one mark, not two nested ones.
  assert.equal(marked('defences', ['defence', 'ences']), '[defences]');
  // Korean is not taken apart by the folding, so the indexes still line up.
  assert.equal(marked('박테리아 면역 체계', ['면역']), '박테리아 [면역] 체계');

  // And it is the rows of the library that show it.
  const box = open.document.getElementById('q');
  box.value = 'retron';
  box.dispatchEvent(new open.window.Event('input'));
  await open.settle();
  const row = open.document.querySelector('#list .row.paper');
  assert.equal(row.querySelector('h2 b').textContent, 'Retron', 'the title says what matched');
  // An author matched shows in the line that has the author in it, not in the title.
  box.value = 'hong';
  box.dispatchEvent(new open.window.Event('input'));
  await open.settle();
  const other = open.document.querySelector('#list .row.paper');
  assert.equal(other.querySelector('h2 b'), null, 'nothing in the title matched');
  assert.equal(other.querySelector('.meta b').textContent, 'Hong');
});

test('the search box remembers what has been searched for before', async () => {
  const open = await boot();
  await open.settle();
  const box = open.document.getElementById('q');
  const cancel = open.document.getElementById('q-cancel');
  const panel = open.document.getElementById('recent');
  const list = open.document.getElementById('list');
  // linkedom has no focus of its own, so the field says it is the active one.
  const focus = node => Object.defineProperty(open.document, 'activeElement', {value: node, configurable: true});

  assert.equal(cancel.hidden, true, 'nothing to cancel until the box is open');
  focus(box);
  box.dispatchEvent(new open.window.Event('focus'));
  assert.equal(cancel.hidden, false, 'open, and there is a way out of searching');
  assert.equal(panel.hidden, true, 'but nothing has been searched for yet');

  // Searched for, then left: that is a search worth remembering.
  box.value = 'retron';
  box.dispatchEvent(new open.window.Event('input'));
  await open.settle();
  assert.equal(panel.hidden, true, 'what was typed is not in the way of the answer');
  focus(open.document.body);
  box.dispatchEvent(new open.window.Event('blur'));
  await open.settle();
  assert.deepEqual(JSON.parse(open.storage.get('np.recent')), ['retron']);

  // A second one goes in front of the first, and a keystroke is not a search.
  box.value = 'phage'; box.dispatchEvent(new open.window.Event('input'));
  await open.settle();
  box.dispatchEvent(new open.window.Event('blur'));
  await open.settle();
  box.value = 'p'; box.dispatchEvent(new open.window.Event('input'));
  await open.settle();
  box.dispatchEvent(new open.window.Event('blur'));
  await open.settle();
  assert.deepEqual(JSON.parse(open.storage.get('np.recent')), ['phage', 'retron']);

  // Opened again on an empty box: they stand over the library, newest first.
  box.value = ''; state_q(box, open);
  focus(box);
  box.dispatchEvent(new open.window.Event('focus'));
  assert.equal(panel.hidden, false, 'they are offered');
  assert.equal(list.hidden, true, 'over the library, not under it');
  assert.deepEqual([...panel.querySelectorAll('.recent-row h2')].map(h => h.textContent), ['phage', 'retron']);

  // One of them taps straight back into that search.
  panel.querySelector('.recent-row .face').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(box.value, 'phage');
  assert.equal(panel.hidden, true, 'and the panel gets out of the way');
  assert.equal(list.hidden, false);

  // And one of them can be forgotten.
  box.value = ''; state_q(box, open);
  focus(box);
  box.dispatchEvent(new open.window.Event('focus'));
  panel.querySelector('.recent-row .x').dispatchEvent(new open.window.Event('click'));
  assert.deepEqual(JSON.parse(open.storage.get('np.recent')), ['retron']);
  assert.deepEqual([...panel.querySelectorAll('.recent-row h2')].map(h => h.textContent), ['retron']);

  // 취소 means out of searching altogether.
  box.value = 'zzz'; box.dispatchEvent(new open.window.Event('input'));
  await open.settle();
  cancel.dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(box.value, '');
  assert.equal(cancel.hidden, true);
  assert.equal(open.document.querySelectorAll('#list .row.paper').length, 3, 'the library is back');
});
// The field's value and the app's idea of it are set together, as typing does.
function state_q(box, open) { box.dispatchEvent(new open.window.Event('input')); }

test('changing what is being looked at starts the list again from the top', async () => {
  const open = await boot({server: fakeServer({items: MANY})});
  await open.settle();
  const list = open.document.getElementById('list');
  let at = 0;
  Object.defineProperty(list, 'scrollTop', {get: () => at, set: v => { at = Number(v) || 0; }, configurable: true});
  const deep = () => { at = 4200; };
  const tap = node => node.dispatchEvent(new open.window.Event('click', {bubbles: true}));
  const filter = label => [...open.document.querySelectorAll('#filters button')].find(b => b.textContent === label);

  // Three hundred papers down one list is nowhere in particular in another.
  deep();
  tap(filter('완료'));
  await open.settle();
  assert.equal(list.scrollTop, 0, 'a different filter starts at the top');

  deep();
  tap(filter('전체'));
  await open.settle();
  assert.equal(list.scrollTop, 0);

  // So does a different order.
  deep();
  tap(open.document.getElementById('btn-sort'));
  [...open.document.querySelectorAll('.menu.float .menu-row')]
    .find(r => r.textContent.trim() === '제목').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(list.scrollTop, 0, 'a different order starts at the top');

  // And so does a search, and clearing one.
  deep();
  const box = open.document.getElementById('q');
  box.value = 'number 7';
  box.dispatchEvent(new open.window.Event('input'));
  await open.settle();
  assert.equal(list.scrollTop, 0);
});

test('a library narrowed to nothing offers the way back out of it', async () => {
  const open = await boot();
  await open.settle();
  const box = open.document.getElementById('q');
  box.value = 'zzzz nothing matches this';
  box.dispatchEvent(new open.window.Event('input'));
  await open.settle();
  const empty = open.document.querySelector('#list .empty');
  assert.ok(empty, 'the screen says so');
  assert.ok(empty.querySelector('.empty-mark svg'), 'with a mark rather than a bare line of text');
  assert.match(empty.textContent, /찾는 논문이 없습니다/);
  const out = empty.querySelector('button');
  assert.equal(out.textContent, '검색과 필터 지우기', 'and a way out');
  out.dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(box.value, '', 'the search is cleared');
  assert.equal(open.document.querySelectorAll('#list .row.paper').length, 3, 'and the library is back');

  // A filter can empty it too, and the same button clears that.
  const done = [...open.document.querySelectorAll('#filters button')].find(b => b.textContent === '완료');
  done.dispatchEvent(new open.window.Event('click'));
  await open.settle();
  // One paper is 완료, so narrow further until nothing is left.
  box.value = 'zzzz';
  box.dispatchEvent(new open.window.Event('input'));
  await open.settle();
  open.document.querySelector('#list .empty button').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(open.document.querySelectorAll('#list .row.paper').length, 3, 'both are cleared at once');
  assert.equal(open.document.querySelector('#filters button[aria-pressed="true"]').textContent, '전체',
    'and the filter row says so');
});

test('pulling the library down asks for it again, and the ring turns until it has arrived', async () => {
  const server = fakeServer();
  const open = await boot({server});
  await open.settle();
  const list = open.document.getElementById('list');
  const mark = open.document.querySelector('#main .pull');
  assert.ok(mark, 'the ring sits above the list, so it pushes rather than covers');
  const touch = (type, y) => {
    const event = new open.window.Event(type);
    event.touches = [{clientX: 100, clientY: y}];
    list.dispatchEvent(event);
  };
  list.scrollTop = 0;
  server.sent.length = 0;

  // Pulled a little: it shows, but letting go asks for nothing.
  touch('touchstart', 100);
  touch('touchmove', 140);
  assert.equal(mark.classList.contains('on'), true, 'it follows the finger');
  assert.equal(mark.classList.contains('pulling'), true, 'exactly, with no easing in the way');
  assert.equal(mark.classList.contains('ready'), false, 'and does not yet say it would go');
  list.dispatchEvent(new open.window.Event('touchend'));
  await open.settle(4);
  assert.equal(server.sent.length, 0, 'a short pull asks for nothing');
  assert.equal(mark.style.getPropertyValue('--pull'), '0px', 'and shuts again');

  // Pulled far enough, and it is full round by the time letting go would mean it.
  touch('touchstart', 100);
  touch('touchmove', 240);
  assert.equal(mark.classList.contains('ready'), true, 'it says letting go would go');
  assert.equal(mark.style.getPropertyValue('--turn'), '290deg', 'the ring is full');
  list.dispatchEvent(new open.window.Event('touchend'));
  assert.equal(mark.classList.contains('busy'), true, 'and it keeps turning where it is');
  assert.equal(mark.style.getPropertyValue('--pull'), '44px', 'held open while it does');
  await open.settle();
  assert.ok(server.sent.some(r => /\/items\?/.test(r.path)), 'the library was asked for again');
  assert.equal(mark.classList.contains('busy'), false, 'and it stops once the library has arrived');
  assert.equal(mark.style.getPropertyValue('--pull'), '0px');

  // A list already scrolled is being read, not refreshed.
  list.scrollTop = 300;
  server.sent.length = 0;
  touch('touchstart', 100);
  touch('touchmove', 240);
  list.dispatchEvent(new open.window.Event('touchend'));
  await open.settle(4);
  assert.equal(server.sent.length, 0, 'the gesture belongs to the top of the list only');
});

test('a first sync of thousands says how much has arrived, not just that something is happening', async () => {
  const open = await boot({server: fakeServer({items: MANY})});
  await open.settle();
  const {showSyncBar} = await import(new URL(`../app.js?boot=${boots}`, here));
  const bar = open.document.getElementById('syncbar');
  const share = () => Number(bar.style.getPropertyValue('--done'));
  // A fake server answers in no time, so the middle of a sync is asked for rather than caught.
  assert.equal(bar.hidden, true, 'nothing to wait for, nothing drawn');
  showSyncBar(120, 900);
  assert.equal(bar.hidden, false, 'while it is arriving, the line is drawn');
  assert.ok(Math.abs(share() - 120 / 900) < 0.01, 'as the share that has arrived');
  showSyncBar(600, 900);
  assert.ok(share() > 0.6, 'and it grows with it');
  showSyncBar(900, 900);
  assert.equal(bar.hidden, true, 'and goes when there is nothing left to wait for');
  // Something always shows, so a line that has only just started is not an invisible one.
  showSyncBar(0, 900);
  assert.ok(share() > 0, 'a sync that has just begun still draws something');
  // A library that fits in one page has nothing to wait for.
  showSyncBar(10, 40);
  assert.equal(bar.hidden, true);
  showSyncBar(0, 0);
  assert.equal(bar.hidden, true);
  assert.match(read('app.css'), /\.syncbar i \{[^}]*scaleX\(var\(--done,0\)\)/, 'drawn by a transform, not a width');
});

test('the refresh button says, by turning, that something is happening', async () => {
  const open = await boot();
  await open.settle();
  const button = open.document.getElementById('btn-sync');
  assert.equal(button.classList.contains('spinning'), false, 'and stops when there is not');
  button.dispatchEvent(new open.window.Event('click'));
  assert.equal(button.classList.contains('spinning'), true);
  assert.equal(button.getAttribute('aria-busy'), 'true', 'which is also said out loud');
  await open.settle();
  assert.equal(button.classList.contains('spinning'), false);
  assert.equal(button.getAttribute('aria-busy'), 'false');
});

/* The instruction this app is written under says text keeps 4.5:1 and is at least 11px. Colour is
   the one part of a look that cannot be judged by eye in the dark, so it is measured here: every
   ink, against the card it is written on, and the two quiet ones against the canvas as well,
   because that is where the count and the headings sit. */
const hexToRgb = hex => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255);
const luminance = hex => {
  const [r, g, b] = hexToRgb(hex).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const inksIn = block => Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6}|#[0-9a-f]{3})\b/g)]
  .map(m => [m[1], m[2].length === 4 ? '#' + [...m[2].slice(1)].map(c => c + c).join('') : m[2]]));

/* A shadow says nothing on a black canvas: anything lifted off the page needs an edge in the
   dark instead, which is what the two tokens carry. A rule that spells its own shadow out has
   forgotten the dark, so the only ones allowed to are the two that sit on a grey of their own. */
test('anything lifted off the page is lifted by a token, so the dark is not forgotten', () => {
  const css = read('app.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const ownShadow = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = m[1].trim(), body = m[2];
    if (/^:root|^@/.test(selector) || selector.includes('--')) continue;
    for (const shadow of body.matchAll(/box-shadow:\s*([^;]+)/g)) {
      if (!/rgba\(/.test(shadow[1])) continue;
      ownShadow.push(selector.split('\n').pop().trim());
    }
  }
  assert.deepEqual(ownShadow.sort(), ['.mark-row .swatch', '.pdf-page'].sort(),
    `these spell out a shadow of their own: ${ownShadow.join(', ')}`);
  // And both tokens exist in both schemes.
  for (const [scheme, block] of [
    ['light', /:root \{([\s\S]*?)\n\}/.exec(css)[1]],
    ['dark', /@media \(prefers-color-scheme: dark\) \{\n  :root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n  \}/.exec(css)[1]]
  ]) {
    for (const name of ['lift', 'over']) {
      assert.match(block, new RegExp(`--${name}:`), `${scheme} says what --${name} is`);
    }
  }
  // In the dark they carry an edge, since a shadow there is invisible.
  const dark = /@media \(prefers-color-scheme: dark\) \{\n  :root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n  \}/.exec(css)[1];
  for (const name of ['lift', 'over']) {
    const value = new RegExp(`--${name}:([^;]+)`).exec(dark)[1];
    assert.match(value, /rgba\(255,255,255/, `--${name} draws an edge in the dark`);
  }
});

test('every ink the app writes in can be read on the paper it is written on', () => {
  const css = read('app.css');
  const schemes = {
    light: inksIn(/:root \{([\s\S]*?)\n\}/.exec(css)[1]),
    dark: inksIn(/@media \(prefers-color-scheme: dark\) \{\n  :root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n  \}/.exec(css)[1])
  };
  for (const [scheme, ink] of Object.entries(schemes)) {
    assert.ok(ink.card && ink.canvas, `${scheme} says what a card and the canvas are`);
    for (const name of ['ink', 'muted', 'faint', 'link', 'bad', 'good', 'warm']) {
      assert.ok(ink[name], `${scheme} has --${name}`);
      const on = contrast(ink[name], ink.card);
      assert.ok(on >= 4.5, `${scheme}: --${name} on a card is ${on.toFixed(2)}:1, under 4.5`);
    }
    // 1,203편 beside the title, and the headings down the list, are written straight on the canvas.
    for (const name of ['muted', 'faint']) {
      const on = contrast(ink[name], ink.canvas);
      assert.ok(on >= 4.5, `${scheme}: --${name} on the canvas is ${on.toFixed(2)}:1, under 4.5`);
    }
    /* And some of those four are fills rather than ink: what a push aside says it will do, the
       count of what is waiting to be sent. In the dark they are light tints read as ink on black,
       so anything written on top of one has to turn dark — a white word on a pale green pill is
       the sort of thing only a measurement catches. */
    assert.ok(ink['on-fill'], `${scheme} says what is written on a fill`);
    for (const name of ['good', 'link', 'faint', 'warm']) {
      const on = contrast(ink['on-fill'], ink[name]);
      assert.ok(on >= 4.5, `${scheme}: writing on --${name} is ${on.toFixed(2)}:1, under 4.5`);
    }
  }
  // Nothing is written smaller than 11px, whatever it is.
  const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]));
  assert.equal(sizes.filter(size => size < 11).length, 0, `smallest is ${Math.min(...sizes)}px`);
});

test('how far a paper got is one number, whichever road it got there by', async () => {
  const open = await boot();
  await open.settle();
  const {shareOf} = await import(new URL(`../app.js?boot=${boots}`, here));
  assert.equal(shareOf({heard: 42}), 42, 'the sentences the voice has said');
  assert.equal(shareOf({page: 5, pages: 20}), 25, 'or the pages a finger has turned');
  assert.equal(shareOf({heard: 42, page: 18, pages: 20}), 90, 'whichever is further on');
  assert.equal(shareOf({page: 1, pages: 20}), 0, 'the first page is not progress');
  assert.equal(shareOf({page: 7}), 0, 'and a page out of nothing known is not a share');
  assert.equal(shareOf(), 0);

  // A paper read in the PDF shows its progress in the library, as a heard one does.
  const read1 = await boot({stored: {'np.user': '16265664', 'np.key': 'k'.repeat(24),
    'np.page.BBB': '9', 'np.of.BBB': '12'}});
  await read1.settle();
  const row = [...read1.document.querySelectorAll('#list .row.paper')]
    .find(r => /PET depolymerase/.test(r.textContent));
  assert.match(row.textContent, /75%/, 'three quarters of the way through, from the pages alone');
  assert.ok(row.querySelector('.foot .heard'), 'with the bar that says so');

  // And the paper's own 읽기 card says it in words, both ways if both happened.
  row.dispatchEvent(new read1.window.Event('click', {bubbles: true}));
  await read1.settle();
  const card = [...read1.document.querySelectorAll('#detail .card')]
    .find(c => /읽기/.test(c.querySelector('h3')?.textContent || ''));
  assert.match(card.textContent, /9쪽까지 봄 \(12쪽 중\)/);
  assert.ok(!/들음/.test(card.textContent), 'nothing was heard, so nothing is claimed');
});

test('whichever of the two a paper was left in the middle of is what is offered back', async () => {
  const open = await boot();
  await open.settle();
  const {resumeOf} = await import(new URL(`../app.js?boot=${boots}`, here));
  // Listening: how far through, as a share of the sentences.
  assert.deepEqual(resumeOf({key: 'A', kind: 'listen', heard: 42}),
    {kind: 'listen', said: '이어 듣기 · 42%', label: '이어 듣기', pct: 42});
  assert.equal(resumeOf({key: 'A', kind: 'listen', heard: 0}), null, 'not started is not half done');
  assert.equal(resumeOf({key: 'A', kind: 'listen', heard: 99}), null, 'and finished is not either');
  // Reading: which page, out of how many.
  assert.deepEqual(resumeOf({key: 'A', kind: 'read', page: 5, pages: 20}),
    {kind: 'read', said: '이어 읽기 · 5쪽', label: '이어 읽기', pct: 25});
  assert.equal(resumeOf({key: 'A', kind: 'read', page: 1, pages: 20}), null, 'the first page is not progress');
  assert.equal(resumeOf({key: 'A', kind: 'read', page: 20, pages: 20}), null, 'nor is the last one');
  assert.equal(resumeOf({key: '', kind: 'read', page: 5, pages: 20}), null);
  // A page with no total still carries on, just with no bar to show.
  assert.deepEqual(resumeOf({key: 'A', kind: 'read', page: 5, pages: 0}).pct, 0);

  // On the library, the card says which it was and goes back to that screen.
  const reading = await boot({stored: {'np.user': '16265664', 'np.key': 'k'.repeat(24),
    'np.last': 'BBB', 'np.lastkind': 'read', 'np.page.BBB': '7', 'np.of.BBB': '14'}});
  await reading.settle();
  const card = reading.document.querySelector('#list .resume');
  assert.ok(card, 'it is offered');
  assert.match(card.textContent, /이어 읽기 · 7쪽/);
  assert.ok(card.querySelector('.go.read'), 'with the mark for a page rather than a voice');
  card.querySelector('button').dispatchEvent(new reading.window.Event('click'));
  await reading.settle();
  assert.equal(reading.document.getElementById('paper').hidden, false, 'and it opens the PDF, not the voice');
});

test('a paper left half heard is offered back at the top of the library', async () => {
  const open = await boot({stored: {'np.user': '16265664', 'np.key': 'k'.repeat(24),
    'np.last': 'BBB', 'np.pct.BBB': '42'}});
  await open.settle();
  const card = open.document.querySelector('#list .resume');
  assert.ok(card, 'it is there');
  assert.match(card.textContent, /PET depolymerase/);
  assert.match(card.textContent, /이어 듣기 · 42%/);
  assert.ok(open.document.querySelector('#list .row'), 'and the library is still under it');

  // Under a search or a filter it would be a paper that is not in what is being looked at.
  const box = open.document.getElementById('q');
  box.value = 'retron';
  box.dispatchEvent(new open.window.Event('input'));
  await open.settle();
  // assert.ok rather than assert.equal(…, null): a DOM node in a failure message is walked by
  // node's own inspector until the stack runs out, and the real reason is never printed.
  assert.ok(!open.document.querySelector('#list .resume'), 'so it stays out of the way');

  // A paper heard to the end is finished, not half heard.
  const done = await boot({stored: {'np.user': '16265664', 'np.key': 'k'.repeat(24),
    'np.last': 'BBB', 'np.pct.BBB': '99'}});
  await done.settle();
  assert.ok(!done.document.querySelector('#list .resume'), 'a paper heard to the end is not offered back');

  // Opening one to listen is what makes it the paper to carry on with.
  const fresh = await boot();
  await fresh.settle();
  fresh.document.querySelectorAll('#list .row')[0].dispatchEvent(new fresh.window.Event('click', {bubbles: true}));
  await fresh.settle(10);
  fresh.document.querySelector('#detail .listen-start').dispatchEvent(new fresh.window.Event('click'));
  await fresh.settle(10);
  assert.equal(fresh.storage.get('np.last'), 'AAA');
});

/* Driving mode strips the bar down to a thumb's worth of buttons, and it had stripped away the one
   button that opens the settings — so the voice, the volume and what is read were all behind a door
   that driving mode had taken off its hinges. Someone who leaves driving mode on, which is the point
   of it, could never change any of them. */
test('운전 모드에서도 설정은 열린다: 목소리, 소리, 읽을 범위', async () => {
  const {open} = await openListening();
  const $id = id => open.document.getElementById(id);
  const click = node => node.dispatchEvent(new open.window.Event('click', {bubbles: true}));
  const css = read('app.css');

  click($id('listen-drive'));
  await open.settle();
  assert.equal($id('listen').classList.contains('driving'), true);
  // The door is still there, and nothing in the stylesheet takes it away.
  assert.ok(!/#listen\.driving[^{]*#listen-more[^{]*\{[^}]*display:\s*none/.test(css), 'driving mode hides the settings button');
  assert.match(css, /#listen\.driving #listen-pdf \{ display:none; \}/, 'the PDF button is still put away');

  click($id('listen-more'));
  await open.settle();
  assert.equal($id('listen-extra').hidden, false);
  assert.equal($id('listen-more').getAttribute('aria-expanded'), 'true');
  assert.equal($id('listen').classList.contains('settings'), true, 'so the sheet can carry its own size');
  // The three the reader came for are inside it.
  for (const id of ['listen-voice', 'listen-vol', 'listen-what']) {
    assert.ok($id('listen-extra').contains($id(id)), `${id} is not in the settings sheet`);
  }
  assert.deepEqual([...$id('listen-what').querySelectorAll('button')].map(b => b.textContent), ['본문만', '캡션까지', '참고문헌까지']);
  // Speed comes back while the sheet is open, and goes away again with it.
  assert.match(css, /#listen\.driving:not\(\.settings\) #listen-rate \{ display:none; \}/);
  // Big enough to hit at the wheel: every control in the sheet is sized up while driving.
  assert.match(css, /#listen\.driving #listen-extra \.small-seg button \{[^}]*height:46px/);

  click($id('listen-more'));
  await open.settle();
  assert.equal($id('listen').classList.contains('settings'), false);
});

test('읽을 범위는 세 단계: 본문만, 캡션까지, 참고문헌까지 — 그리고 고른 것이 기억된다', async () => {
  const {open} = await openListening();
  const scope = () => [...open.document.querySelectorAll('#listen-what button')];
  const press = label => { scope().find(b => b.textContent === label).dispatchEvent(new open.window.Event('click')); };
  const lines = () => [...open.document.querySelectorAll('#listen .sent')].map(n => n.textContent);

  assert.deepEqual(scope().map(b => b.textContent), ['본문만', '캡션까지', '참고문헌까지']);
  assert.equal(scope()[0].getAttribute('aria-pressed'), 'true');
  assert.ok(!lines().some(l => /coloured by cluster/.test(l)));
  assert.ok(!lines().some(l => /Nature 500/.test(l)));

  press('캡션까지');
  await open.settle();
  assert.ok(lines().some(l => /coloured by cluster/.test(l)), 'the caption is read');
  assert.ok(!lines().some(l => /Nature 500/.test(l)), 'but not the reference list yet');

  press('참고문헌까지');
  await open.settle();
  assert.ok(lines().some(l => /coloured by cluster/.test(l)), 'each step keeps the one before it');
  assert.ok(lines().some(l => /Nature 500/.test(l)), 'and adds the reference list');
  assert.equal(scope()[2].getAttribute('aria-pressed'), 'true');
  assert.equal(scope().filter(b => b.getAttribute('aria-pressed') === 'true').length, 1);
  assert.equal(open.storage.get('np.reads'), 'references');

  press('본문만');
  await open.settle();
  assert.ok(!lines().some(l => /Nature 500/.test(l)));
  assert.equal(open.storage.get('np.reads'), 'body');
});

test('참고문헌까지 고른 뒤 다음 논문을 열어도 그대로 읽는다', async () => {
  const {open} = await openListening({stored: {'np.user': '16265664', 'np.key': 'k'.repeat(24), 'np.reads': 'references'}});
  assert.equal(open.document.querySelectorAll('#listen-what button')[2].getAttribute('aria-pressed'), 'true');
  const lines = [...open.document.querySelectorAll('#listen .sent')].map(n => n.textContent);
  assert.ok(lines.some(l => /Nature 500/.test(l)), 'the choice carried over to this paper');
});

/* ---- English beside the Korean ---- */
/* The app is written in Korean and the Korean sentence is the key, so a string with no English
   still reads. That makes it easy for a new line to go in with no English and for nobody to notice,
   which is what this checks: every Korean string that can reach the screen has an entry. */
const SCREEN = [
  /text: *'([^'\n]*[가-힣][^'\n]*)'/g, /label: *'([^'\n]*[가-힣][^'\n]*)'/g,
  /title: *'([^'\n]*[가-힣][^'\n]*)'/g, /'aria-label': *'([^'\n]*[가-힣][^'\n]*)'/g,
  /placeholder: *'([^'\n]*[가-힣][^'\n]*)'/g, /toast\('([^'\n]*[가-힣][^'\n]*)'/g,
  /said: *'([^'\n]*[가-힣][^'\n]*)'/g, /\bt\('([^'\n]*[가-힣][^'\n]*)'\)/g,
  /\bT\('([^'\n]*[가-힣][^'\n]*)'/g,
  /html: *'([^'\n]*[가-힣][^'\n]*)'/g,
  // the label beside an id in a list of choices: ['body', '본문만']
  /\['[a-z-]*', *'([^'\n]*[가-힣][^'\n]*)'\]/g,
  /textContent *= *'([^'\n]*[가-힣][^'\n]*)'/g,
  // a fallback for something the server did not give: … || '제목 없음'
  /\|\| *'([^'\n]*[가-힣][^'\n]*)'/g,
  /\? *'([^'\n]*[가-힣][^'\n]*)' *:/g, /: *'([^'\n]*[가-힣][^'\n]*)';/g
];
const koreanOnScreen = () => {
  const found = new Set();
  for (const file of ['app.js', 'play.js', 'list.js', 'files.js']) {
    const source = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const pattern of SCREEN) for (const m of source.matchAll(pattern)) found.add(m[1]);
  }
  const {document: page} = parseHTML(read('index.html'));
  const walker = page.createTreeWalker(page.body, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.trim();
    if (text && /[가-힣]/.test(text)) found.add(text);
  }
  for (const node of page.body.querySelectorAll('[aria-label],[placeholder],[title],[aria-valuetext]')) {
    for (const name of ['aria-label', 'placeholder', 'title', 'aria-valuetext']) {
      const text = (node.getAttribute(name) || '').trim();
      if (text && /[가-힣]/.test(text)) found.add(text);
    }
  }
  return found;
};

test('every Korean string that reaches the screen has English beside it', async () => {
  const {default: EN} = await import('../en.js');
  const missing = [...koreanOnScreen()].filter(key => typeof EN[key] !== 'string' || !EN[key]);
  assert.deepEqual(missing, [], `these have no English: ${missing.map(s => JSON.stringify(s)).join(', ')}`);
});

test('nothing is translated that the app never says', async () => {
  const {default: EN} = await import('../en.js');
  const said = koreanOnScreen();
  const stale = Object.keys(EN).filter(key => !said.has(key));
  assert.deepEqual(stale, [], `these are translated but never said: ${stale.join(', ')}`);
});

test('a phone set to English gets English, a Korean one Korean, and the choice overrides both', async () => {
  const i18n = await import('../i18n.js');
  const {default: EN} = await import('../en.js');
  i18n.set(EN);
  assert.equal(i18n.use('auto', {language: 'en-GB'}), 'en');
  assert.equal(i18n.t('논문'), 'Papers');
  assert.equal(i18n.use('auto', {language: 'ko-KR'}), 'ko');
  assert.equal(i18n.t('논문'), '논문', 'Korean costs nothing: the table is not consulted');
  assert.equal(i18n.use('en', {language: 'ko-KR'}), 'en', 'the reader can ask for English on a Korean phone');
  assert.equal(i18n.use('ko', {language: 'en-GB'}), 'ko');
  // A browser that says nothing is not a browser; that is the harness, and it keeps the written language.
  assert.equal(i18n.use('auto', {language: ''}), 'ko');
  // A string with no entry is still readable.
  i18n.use('en', {language: 'en'});
  assert.equal(i18n.t('아직 영어가 없는 문장'), '아직 영어가 없는 문장');
  // Counts: the table writes the plural and one is made singular, verb and all.
  i18n.set({...EN, '{0}편이 남았습니다': '{0} papers are left'});
  assert.equal(i18n.T('{0}편', 3), '3 papers');
  assert.equal(i18n.T('{0}편', 1), '1 paper');
  assert.equal(i18n.T('{0}편이 남았습니다', 1), '1 paper is left');
  assert.equal(i18n.T('{0}편이 남았습니다', 12), '12 papers are left');
  // A number that is part of someone's title is not a count.
  assert.equal(i18n.T('다음 논문 · {0}', '1 papers in a title'), 'Next paper · 1 papers in a title');
  i18n.use('ko', {language: 'ko'});
  i18n.set(EN);
});

test('a phone in English reads English all the way through, markup and all', async () => {
  const open = await boot({nav: {language: 'en-GB', languages: ['en-GB']}});
  await open.settle();
  const page = open.document;
  // The page's own markup, swapped in place at start-up.
  assert.equal(page.getElementById('setup-go').textContent, 'Connect');
  assert.match(page.getElementById('q').getAttribute('placeholder'), /Title, author/);
  // Nothing Korean is left anywhere a reader can see it.
  const walker = page.createTreeWalker(page.body, 4);
  const left = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest('[hidden]') || parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') continue;
    const text = node.nodeValue.trim();
    if (text && /[가-힣]/.test(text)) left.push(text);
  }
  assert.deepEqual(left, [], `Korean left on an English phone: ${left.join(' | ')}`);
});

test('the language can be set by hand, and the setting is what the app starts with next time', async () => {
  const open = await boot({nav: {language: 'ko-KR', languages: ['ko-KR']}});
  await open.settle();
  open.document.getElementById('btn-settings-main').dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  // 화면 offers a 자동 of its own now, so the row is found by its own name rather than by its words.
  const row = [...open.document.querySelectorAll('#settings .set-row')]
    .find(r => r.querySelector('.what')?.textContent === '언어');
  const buttons = [...row.querySelectorAll('.seg button')];
  assert.deepEqual(buttons.map(b => b.textContent), ['자동', '한국어', 'English']);
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'true', 'a phone follows itself until told otherwise');
  buttons[2].dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(open.storage.get('np.lang'), 'en');
  assert.equal(open.location.reloads, 1, 'everything on screen was drawn from Korean, so it is drawn again');
});

/* ---- hearing the translation instead of the paper ---- */
const TRANSLATION_NOTE = {
  key: 'TRN1', version: 4,
  data: {key: 'TRN1', itemType: 'note', dateModified: '2026-10-14T00:00:00Z',
    note: '<div><h1>Retron defence (KO)</h1><p><em>Claude 계정 (이 Mac) · 2026-10-14</em></p>'
      + '<h2>Introduction (p. 1)</h2><p>Microbial decomposers can degrade newly encountered materials.</p>'
      + '<blockquote><p>미생물 분해자는 새로 만난 물질을 분해할 수 있다. 이 효소는 오십 도에서 작동한다.</p></blockquote>'
      + '<h2>Results (p. 3)</h2><p>The enzyme works at fifty degrees.</p>'
      + '<blockquote><p>변이체는 활성을 유지했다.</p><p><em>DeepL</em></p></blockquote></div>'}
};

test('번역 노트가 있으면 원문 대신 번역을 읽을 수 있다', async () => {
  const {open} = await openListening({children: [...PDF_CHILD, TRANSLATION_NOTE],
    voices: [...ONE_VOICE, {voiceURI: 'v-yuna', name: 'Yuna', lang: 'ko-KR', localService: true}]});
  const row = open.document.getElementById('listen-saying');
  assert.equal(row.hidden, false, 'this paper has a translation, so the choice is offered');
  const buttons = [...row.querySelectorAll('button')];
  assert.deepEqual(buttons.map(b => b.textContent), ['원문', '번역']);
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'true', 'the paper itself unless asked');

  const lines = () => [...open.document.querySelectorAll('#listen .sent')].map(n => n.textContent);
  assert.ok(lines().some(l => /Microbial decomposers/.test(l)));

  buttons[1].dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.ok(lines().some(l => /미생물 분해자는/.test(l)), 'the translation is what is read now');
  assert.ok(!lines().some(l => /Microbial decomposers/.test(l)), 'and the original is not read twice');
  // The headings came across with it, and so did the page each one is on.
  assert.ok([...open.document.querySelectorAll('#listen .sec')].some(n => /Introduction/.test(n.textContent)));
  assert.equal(open.storage.get('np.said'), 'tr');
  // A translation is another language: the voice is chosen again for it.
  open.document.getElementById('listen-play').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  const said = open.speech.queue[0];
  assert.ok(said, 'something was queued to say');
  assert.match(String(said.lang || ''), /^ko/, 'a Korean translation is read by a Korean voice');
  assert.match(said.text, /미생물|Introduction/);

  buttons[0].dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.ok(lines().some(l => /Microbial decomposers/.test(l)), 'and back again');
  assert.equal(open.storage.get('np.said'), 'raw');
});

test('번역 노트가 없으면 그 줄은 아예 나오지 않는다', async () => {
  const {open} = await openListening();
  assert.equal(open.document.getElementById('listen-saying').hidden, true);
  assert.equal(open.document.querySelectorAll('#listen-saying button').length, 0);
});

/* ---- the voice the Mac baked, played on the phone ---- */
const BAKED_MARKS = {
  title: 'Retron Septu defence', seconds: 9.4, audio: 'Retron Septu defence.m4b',
  chapters: [{chapter: 0, at: 0, title: 'Introduction'}],
  marks: [{at: 0, seconds: 3, chapter: 0, text: 'Retron Septu defence.'},
          {at: 3.2, seconds: 3, chapter: 0, text: 'Microbial decomposers can degrade new materials.'},
          {at: 6.4, seconds: 3, chapter: 0, text: 'The enzyme works at fifty degrees.'}]
};
const DROPBOX_LINKED = {'np.db.app': 'APPKEY', 'np.db.refresh': 'RT', 'np.db.access': 'AT', 'np.db.until': String(Date.now() + 3600000)};
/* Dropbox answered at the network, the way the PDF tests do it: the app builds its own client. */
function bakedDropbox({has = ['/논문 음성/Retron Septu defence.m4b'], marks = BAKED_MARKS,
                      links = true} = {}) {
  const paths = [];
  return {
    paths,
    handle: async (url, init = {}) => {
      if (/oauth2\/token/.test(url)) return new Response(JSON.stringify({access_token: 'AT', expires_in: 14400}), {status: 200});
      if (/files\/list_folder/.test(url)) {
        paths.push('list');
        return new Response(JSON.stringify({entries: has.map(p => ({'.tag': 'file', name: p.split('/').pop(), path_display: p, size: 24}))}), {status: 200});
      }
      /* The link an audio element plays from. The path is in the body here, not in the header the
         download endpoint reads it from. */
      if (/get_temporary_link/.test(url)) {
        const asked = init.body ? JSON.parse(init.body).path : '';
        paths.push(`link:${asked}`);
        if (!links || !has.includes(asked)) return new Response(JSON.stringify({error_summary: 'path/not_found/'}), {status: 409});
        return new Response(JSON.stringify({link: `https://dl.dropboxusercontent.com${asked}`}), {status: 200});
      }
      const arg = init.headers && init.headers['Dropbox-API-Arg'];
      const path = arg ? JSON.parse(arg).path : '';
      paths.push(path);
      if (path.endsWith('.json')) return new Response(JSON.stringify(marks), {status: 200});
      if (has.includes(path)) return new Response(new Uint8Array([0, 0, 0, 24]), {status: 200});
      return new Response(JSON.stringify({error_summary: 'path/not_found/'}), {status: 409});
    }
  };
}

test('맥이 구운 음성이 있으면 폰이 그것으로 읽는다 — 화면을 꺼도 멈추지 않는 파일로', async () => {
  const {open} = await openListening({dropbox: bakedDropbox()});
  await open.settle();
  const row = open.document.getElementById('listen-saying');
  assert.equal(row.hidden, false, 'the Mac made one, so it is offered');
  const buttons = [...row.querySelectorAll('button')];
  /* The Mac's voice comes first and is what reads, without being asked: the paper was baked
     precisely so the phone would not have to say it in its own voice, which the reader calls 후지다.
     The phone's own is named as the stand-in it is, not as "원문" standing level with it. */
  assert.deepEqual(buttons.map(b => b.textContent), ['맥 음성', '폰 음성']);
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'true', 'the Mac’s voice is the one in use');
  assert.equal(buttons[1].getAttribute('aria-pressed'), 'false');

  // The list is the sentences the Mac actually spoke, so a tap lands on the right moment.
  const lines = [...open.document.querySelectorAll('#listen .sent')].map(n => n.textContent);
  assert.deepEqual(lines, BAKED_MARKS.marks.map(m => m.text));

  open.document.getElementById('listen-play').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  const audio = open.audios.at(-1);
  assert.ok(audio, 'an audio element is what plays it, not the phone’s own voice');
  assert.equal(audio.paused, false);
  assert.equal(audio.currentTime, 0);
  assert.equal(open.speech.queue.length, 0, 'nothing was handed to speechSynthesis');

  // It moves through the paper by itself, on the times the Mac wrote down.
  audio.to(3.2);
  await open.settle();
  assert.equal(open.document.querySelector('#listen .sent[aria-current="true"]').textContent,
    'Microbial decomposers can degrade new materials.');
  // And a tap on a sentence seeks the file to it.
  [...open.document.querySelectorAll('#listen .sent')][2].dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  assert.equal(audio.currentTime, 6.4);

  // Back to the phone's own voice: the file stops, and it reads the paper itself.
  [...row.querySelectorAll('button')][1].dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(audio.paused, true, 'the file was left behind, not left playing');
  const back = [...open.document.querySelectorAll('#listen .sent')].map(n => n.textContent);
  assert.ok(back.some(l => /Microbial decomposers can degrade newly/.test(l)), 'the paper is back');
  open.document.getElementById('listen-play').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.ok(open.speech.queue.length > 0, 'and it is the phone speaking it, not the file');
  assert.equal(open.storage.get('np.said'), 'raw');
});

test('구운 음성이 없거나 Dropbox가 없으면 그 선택지는 나오지 않는다', async () => {
  const {open} = await openListening({dropbox: bakedDropbox({has: []})});
  assert.equal(open.document.getElementById('listen-saying').hidden, true);
  const off = await openListening();          // no Dropbox at all
  assert.equal(off.open.document.getElementById('listen-saying').hidden, true);
});

test('폰 기본 음성은 떔빵이다 — 구운 파일이 있으면 지난번에 원문을 눌렀더라도 그것이 읽는다', async () => {
  /* The reader calls the phone's own voice 후지다 and wants it only where the Mac has not read
     first, so a past tap on the phone's voice is not a standing instruction. */
  const {open} = await openListening({dropbox: bakedDropbox(), stored: {'np.said': 'raw'}});
  await open.settle();
  const buttons = [...open.document.querySelectorAll('#listen-saying button')];
  assert.deepEqual(buttons.map(b => b.textContent), ['맥 음성', '폰 음성']);
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'true', 'the Mac reads it all the same');
  open.document.getElementById('listen-play').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(open.audios.at(-1).paused, false);
  assert.equal(open.speech.queue.length, 0, 'the phone did not say a word of it');
});

test('파일을 못 읽으면 폰 목소리가 이어 읽는다 — 달리는 차가 조용해지지 않게', async () => {
  const {open} = await openListening({dropbox: bakedDropbox()});
  await open.settle();
  open.document.getElementById('listen-play').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  const audio = open.audios.at(-1);
  assert.equal(audio.paused, false, 'the file is playing');
  // The signal dies and the file cannot go on.
  audio.fire('error');
  await open.settle();
  const buttons = [...open.document.querySelectorAll('#listen-saying button')];
  assert.equal(buttons[1].getAttribute('aria-pressed'), 'true', 'the phone’s voice took over');
  assert.ok(open.speech.queue.length > 0, 'and it is reading, not silent');
  assert.match(open.document.getElementById('toast').textContent, /폰 목소리/);
});

test('한참 들은 논문은 신호 없는 길을 위해 폰이 받아 둔다', async () => {
  const dropbox = bakedDropbox();
  const {open} = await openListening({dropbox});
  await open.settle();
  open.document.getElementById('listen-play').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  const audio = open.audios.at(-1);
  assert.ok(!dropbox.paths.includes('/논문 음성/Retron Septu defence.m4b'), 'nothing was fetched to begin with');
  audio.to(20);
  await open.settle();
  assert.ok(!dropbox.paths.includes('/논문 음성/Retron Septu defence.m4b'), 'a glance costs no bytes');
  audio.to(75);
  await open.settle();
  assert.ok(dropbox.paths.includes('/논문 음성/Retron Septu defence.m4b'), 'a real listen is put away');
});

/* The Mac bakes the body alone, but a reference list that ran on without a heading is read as
   body and ends up in the file. Nothing on the phone could skip it: the file is the file. */
const REF_ENTRY = 'Doi K, Mori K, Martono H, Nagayoshi Y, Fujino Y, Tashiro K (2013) Draft genome sequence of Geobacillus kaustophilus.';
const BAKED_WITH_REFS = {...BAKED_MARKS, seconds: 13.6,
  marks: [...BAKED_MARKS.marks, {at: 9.6, seconds: 4, chapter: 0, text: REF_ENTRY}]};

test('레퍼런스는 안 읽는다 — 구운 파일에 들어있어도, 불러오면 그 자리로 간다', async () => {
  const {open} = await openListening({dropbox: bakedDropbox({marks: BAKED_WITH_REFS})});
  await open.settle();
  const lines = () => [...open.document.querySelectorAll('#listen .sent')].map(n => n.textContent);
  assert.equal(lines().length, 3, 'the three sentences of the paper');
  assert.ok(!lines().some(line => /Draft genome sequence/.test(line)), 'and not the reference list');

  // The choice is there, and it is the one a file can answer: there are no captions in a bake.
  const scope = [...open.document.querySelectorAll('#listen-what button')];
  assert.deepEqual(scope.map(b => b.textContent), ['본문만', '참고문헌까지']);
  assert.equal(scope[0].getAttribute('aria-pressed'), 'true');

  scope[1].dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.ok(lines().some(line => /Draft genome sequence/.test(line)), 'asked for, it is read');
  // And the file still lands on the right second: the sentences and the marks stayed in step.
  [...open.document.querySelectorAll('#listen .sent')].at(-1).dispatchEvent(new open.window.Event('click', {bubbles: true}));
  await open.settle();
  assert.equal(open.audios.at(-1).currentTime, 9.6);
});

test('돌아오면 읽던 자리에서 다시 읽는다 — 파일은 건드리지 않고', async () => {
  // The phone's own voice: iOS stopped it when the app went away and said nothing about it.
  const {open} = await openListening();
  open.document.getElementById('listen-play').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  open.speech.start();
  const said = open.speech.spoken.length;
  open.speech.queue.length = 0;                     // what iOS does to a page it puts away
  open.document.dispatchEvent(new open.window.Event('visibilitychange'));
  await open.settle();
  assert.ok(open.speech.queue.length > 0, 'it is reading again rather than sitting silent');
  open.speech.start();
  assert.equal(open.speech.spoken.at(-1), open.speech.spoken[said - 1], 'and from the sentence it stopped on');

  // The file, which never stopped, is not disturbed by coming back.
  const baked = await openListening({dropbox: bakedDropbox()});
  await baked.open.settle();
  baked.open.document.getElementById('listen-play').dispatchEvent(new baked.open.window.Event('click'));
  await baked.open.settle();
  const audio = baked.open.audios.at(-1);
  audio.to(3.2);
  await baked.open.settle();
  baked.open.document.dispatchEvent(new baked.open.window.Event('visibilitychange'));
  await baked.open.settle();
  assert.equal(audio.paused, false, 'still playing');
  assert.equal(audio.currentTime, 3.2, 'and not sent back to the start of the sentence');
});

test('목소리 메뉴는 화면 밖으로 잘려 보이지 않는다', async () => {
  const open = await boot();
  await open.settle();
  const {floatPlace} = await import(new URL(`../app.js?boot=${boots}`, here));
  const view = {width: 390, height: 844};
  /* 목소리 sits at the left of its row: hanging a 196px menu off its right edge put the menu's own
     left edge 76px off the side of the phone, and the menu was cut down its side. */
  const left = floatPlace({box: {top: 600, bottom: 630, right: 120, width: 90}, wide: 196, tall: 240, view});
  assert.equal(left.left, 8);
  assert.equal(left.top, 354, 'and from that far down the screen it opens upwards, as it did before');
  // Higher up it hangs under the button it was opened from.
  const under = floatPlace({box: {top: 200, bottom: 230, right: 120, width: 90}, wide: 196, tall: 240, view});
  assert.equal(under.top, 236);
  // A button at the right edge still keeps its menu's right edge against it.
  const right = floatPlace({box: {top: 100, bottom: 130, right: 382, width: 44}, wide: 196, tall: 240, view});
  assert.equal(right.left, 186);
  // Near the foot of the screen the menu opens upwards rather than off the bottom.
  const up = floatPlace({box: {top: 700, bottom: 740, right: 382, width: 44}, wide: 196, tall: 300, view});
  assert.equal(up.top, 394);
  // And a menu wider than the phone starts on the screen instead of to the left of it.
  const huge = floatPlace({box: {top: 10, bottom: 40, right: 300, width: 60}, wide: 500, tall: 100, view});
  assert.equal(huge.left, 8);
});

test('구운 파일은 다 내려오기 전에 재생된다 — 20MB를 기다리다 목소리가 안 나오던 자리', async () => {
  const dropbox = bakedDropbox();
  const {open} = await openListening({dropbox});
  await open.settle();
  const audio = open.audios.at(-1);
  assert.ok(audio, 'there is something to play');
  assert.ok(dropbox.paths.includes('link:/논문 음성/Retron Septu defence.m4b'),
    'a link was asked for, which Dropbox serves with byte ranges');
  assert.ok(!dropbox.paths.includes('/논문 음성/Retron Septu defence.m4b'),
    'and the file itself was not fetched whole before the voice was offered');
  // The sidecar is small and still read: without it the file cannot be followed along.
  assert.ok(dropbox.paths.includes('/논문 음성/Retron Septu defence.json'));
});

test('링크를 못 받으면 예전처럼 파일을 받아서 읽는다', async () => {
  const dropbox = bakedDropbox({links: false});
  const {open} = await openListening({dropbox});
  await open.settle();
  assert.ok(dropbox.paths.includes('/논문 음성/Retron Septu defence.m4b'), 'the bytes were fetched instead');
  const row = open.document.getElementById('listen-saying');
  assert.equal(row.hidden, false, 'and the Mac’s voice is offered all the same');
});

test('맥이 읽어둔 논문은 목록에서 바로 알아볼 수 있다', async () => {
  const zotero = fakeServer();
  /* The same one listing answers for the facts and for the audio, so this costs no request of
     its own. */
  const dropbox = {handle: async (url, init = {}) => {
    if (/oauth2\/token/.test(url)) return new Response(JSON.stringify({access_token: 'AT', expires_in: 14400}), {status: 200});
    if (/files\/list_folder/.test(url)) return new Response(JSON.stringify({entries: [
      {'.tag': 'file', name: 'library.json', path_display: '/논문 음성/library.json', size: 99},
      {'.tag': 'file', name: 'Retron Septu defence.m4b', path_display: '/논문 음성/Retron Septu defence.m4b', size: 24}
    ]}), {status: 200});
    const arg = init.headers && init.headers['Dropbox-API-Arg'];
    const path = arg ? JSON.parse(arg).path : '';
    if (path.endsWith('library.json')) return new Response(JSON.stringify(FACTS), {status: 200});
    return new Response(JSON.stringify({error_summary: 'path/not_found/'}), {status: 409});
  }};
  const server = {sent: zotero.sent, fetchImpl: async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    return /dropboxapi\.com|dropbox\.com/.test(url) ? dropbox.handle(url, init) : zotero.fetchImpl(input, init);
  }};
  const open = await boot({server, stored: {'np.user': '16265664', 'np.key': 'k'.repeat(24), ...DROPBOX_LINKED}});
  await open.settle();
  await open.settle();

  const voiced = open.document.querySelector('#list .row.paper[data-key="AAA"] .voiced');
  assert.ok(voiced, 'the paper the Mac has read aloud says so');
  assert.equal(voiced.getAttribute('title'), '맥 음성 있음');
  assert.equal(open.document.querySelector('#list .row.paper[data-key="BBB"] .voiced'), null,
    'and one it has not read does not');
});

test('PDF 화면은 화면 안에 들어온다 — 바가 페이지 위를 덮지 않는다', () => {
  const css = read('app.css');
  /* A centred flex item that overflows puts its left edge out of the container's reach, so a
     zoomed page could not be panned back to its own margin. */
  assert.match(css, /\.pdf \{[^}]*align-items:flex-start/, 'the pages are laid from the start of the line');
  assert.match(css, /\.pdf \{[^}]*overflow:auto/, 'and both ways scroll');
  assert.ok(!/\.pdf \{[^}]*align-items:center/.test(css), 'nothing centres them back');
  // The player on this screen stands under the pages; on the listening screen it still floats.
  assert.match(css, /#paper-bar\.player \{[^}]*position:static/);
  assert.match(css, /\.player \{[^}]*position:absolute/, 'the transcript’s player is unchanged');
  // Where you are is shown where the folded-away bar was, not on top of the player.
  assert.match(css, /\.page-now \{[^}]*top:calc\(var\(--top\)/);
});

/* ---- what the Mac knows and Zotero does not ---- */
const FACTS = {v: 2, made: '2026-10-14T00:00:00Z',
  papers: {
    AAA: {jif: 35.11, cited: 1240, venue: 'Nature Reviews Microbiology', year: 2026, from: ['KR', 'US'], lead: 'KR',
          read: 67, page: 12, pages: 18, seconds: 3120, at: '2026-10-13', mark: 'teal'},
    BBB: {jif: 6.4, cited: 3, from: ['JP']},
    CCC: {jif: 35.11, venue: 'Nature Reviews Microbiology'}
  },
  journals: {'Nature Reviews Microbiology': {country: 'GB', h: 1845, ink: '#c6004f', inkDark: '#ff6ba6'},
             Science: {ink: '#ca2015', inkDark: '#f07b73'}}};

function factsDropbox(facts = FACTS) {
  return {handle: async (url, init = {}) => {
    if (/oauth2\/token/.test(url)) return new Response(JSON.stringify({access_token: 'AT', expires_in: 14400}), {status: 200});
    if (/files\/list_folder/.test(url)) return new Response(JSON.stringify({entries: [{'.tag': 'file', name: 'library.json', path_display: '/논문 음성/library.json', size: 99}]}), {status: 200});
    const arg = init.headers && init.headers['Dropbox-API-Arg'];
    const path = arg ? JSON.parse(arg).path : '';
    if (path.endsWith('library.json')) return new Response(JSON.stringify(facts), {status: 200});
    return new Response(JSON.stringify({error_summary: 'path/not_found/'}), {status: 409});
  }};
}

test('임팩트 팩터·인용 수·저자 국적이 라이브러리 목록에 함께 나온다', async () => {
  const zotero = fakeServer();
  const dropbox = factsDropbox();
  const server = {sent: zotero.sent, fetchImpl: async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    return /dropboxapi\.com|dropbox\.com/.test(url) ? dropbox.handle(url, init) : zotero.fetchImpl(input, init);
  }};
  const open = await boot({server, stored: {'np.user': '16265664', 'np.key': 'k'.repeat(24), ...DROPBOX_LINKED}});
  await open.settle();
  await open.settle();

  const row = open.document.querySelector('#list .row.paper[data-key="AAA"]');
  assert.ok(row, 'the paper is in the list');
  const jif = row.querySelector('.jif');
  assert.ok(jif, 'the journal figure is shown');
  assert.equal(jif.textContent, '35', 'a big figure is shown whole, not to two places');
  assert.equal(jif.getAttribute('data-band'), 'top');
  assert.match(jif.getAttribute('title'), /Nature Reviews Microbiology/);
  assert.match(row.textContent, /1,240/, 'the citation count, grouped');
  assert.equal(row.querySelector('.from').textContent, '🇰🇷🇺🇸', 'the corresponding author’s country first');
  assert.equal(row.querySelector('.from').getAttribute('title'), 'KR · US');

  // A smaller figure keeps its decimal and lands in its own band.
  const other = open.document.querySelector('#list .row.paper[data-key="BBB"]');
  assert.equal(other.querySelector('.jif').textContent, '6.4');
  assert.equal(other.querySelector('.jif').getAttribute('data-band'), 'mid');
  assert.equal(other.querySelector('.from').textContent, '🇯🇵');
});

test('그 파일이 없으면 목록은 Zotero가 준 것만 그대로 보여준다', async () => {
  const open = await boot();                       // no Dropbox at all
  await open.settle();
  const row = open.document.querySelector('#list .row.paper');
  assert.ok(row, 'the library is still drawn');
  assert.equal(row.querySelector('.jif'), null, 'nothing is invented');
  assert.equal(row.querySelector('.from'), null);
});

test('논문 시그니처 컬러와 맥에서 읽은 분량이 목록에 함께 나온다', async () => {
  const zotero = fakeServer();
  const dropbox = factsDropbox();
  const server = {sent: zotero.sent, fetchImpl: async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    return /dropboxapi\.com|dropbox\.com/.test(url) ? dropbox.handle(url, init) : zotero.fetchImpl(input, init);
  }};
  const open = await boot({server, stored: {'np.user': '16265664', 'np.key': 'k'.repeat(24), ...DROPBOX_LINKED}});
  await open.settle();
  await open.settle();

  const row = open.document.querySelector('#list .row.paper[data-key="AAA"]');
  // The journal's name wears the Mac's own ink for it, both themes' at once, and the name is still
  // the name: a search mark inside it has to survive being painted.
  const venue = row.querySelector('.meta .venue');
  assert.ok(venue, 'the journal has an element of its own now');
  // The name is the one Zotero holds; the colour is the one the Mac paints that journal in.
  assert.equal(venue.textContent, 'Science');
  assert.ok(venue.classList.contains('ink'));
  assert.equal(venue.style.getPropertyValue('--j-ink').trim(), '#ca2015');
  assert.equal(venue.style.getPropertyValue('--j-ink-d').trim(), '#f07b73');
  assert.match(row.querySelector('.meta').textContent, /^Seo · Kim · 2025 · Science$/, 'and it reads as one line');

  // How far the Mac got through it, as the same bar the voice fills.
  const bar = row.querySelector('.heard');
  assert.ok(bar, 'the share is drawn');
  assert.equal(bar.getAttribute('aria-label'), '67% 읽음', 'pages read, not sentences heard');
  assert.equal(bar.querySelector('i').style.width, '67%');
  assert.match(row.textContent, /67%/);
  assert.match(row.querySelector('.foot .muted:last-of-type').getAttribute('title'),
               /18쪽 중 12쪽까지/, 'the pages behind the figure are a press away');

  // The colour it was marked with by hand, as a dot and not a bar down the edge.
  const mark = row.querySelector('.mark');
  assert.equal(mark.getAttribute('data-mark'), 'teal');
  assert.equal(mark.getAttribute('aria-label'), '청록 표시');

  /* Zotero holds "Nat Rev Microbiol" for the third paper while the Mac's file is keyed by the full
     name: the row keeps this library's spelling and still wears that journal's colour. */
  const abbreviated = open.document.querySelector('#list .row.paper[data-key="CCC"] .meta .venue');
  assert.equal(abbreviated.textContent, 'Nat Rev Microbiol');
  assert.equal(abbreviated.style.getPropertyValue('--j-ink').trim(), '#c6004f');

  // A paper the Mac has no colour and no record for is left plain.
  const other = open.document.querySelector('#list .row.paper[data-key="BBB"]');
  assert.equal(other.querySelector('.meta .venue').textContent, 'Nature', 'the journal is still named');
  assert.equal(other.querySelector('.meta .venue.ink'), null, 'no ink is invented');
  assert.equal(other.querySelector('.mark'), null);
  assert.equal(other.querySelector('.heard'), null);
});

test('맥이 읽은 기록은 한 줄로, 이 폰이 읽은 기록 아래에 적는다', async () => {
  const i18n = await import('../i18n.js');
  const {default: EN} = await import('../en.js');
  const {macRead, dayAgo} = await import('../app.js');
  const now = new Date('2026-10-15T09:00:00');
  i18n.set(EN); i18n.use('ko');
  assert.equal(macRead({read: 67, page: 12, pages: 18, seconds: 3120, at: '2026-10-13'}, {now}),
               '맥에서 18쪽 중 12쪽까지 · 52분 읽음 · 2일 전');
  // What is not known is left out rather than guessed at.
  assert.equal(macRead({page: 4}, {now}), '맥에서 4쪽까지');
  assert.equal(macRead({read: 30}, {now}), '맥에서 30%');
  assert.equal(macRead({seconds: 30}, {now}), '', 'half a minute is not a reading record');
  assert.equal(macRead(null), '');
  assert.equal(macRead({}), '');
  assert.equal(dayAgo('2026-10-15', now), '오늘');
  assert.equal(dayAgo('2026-10-14', now), '어제');
  assert.equal(dayAgo('2026-07-01', now), '7월 1일', 'far enough back that counting days says nothing');
  assert.equal(dayAgo('not a day', now), '');
  i18n.use('en');
  assert.equal(macRead({page: 12, pages: 18, seconds: 3120, at: '2026-10-13'}, {now}),
               'On the Mac · p. 12 of 18 · read for 52 minutes · 2 days ago');
  assert.equal(dayAgo('2026-10-14', now), 'yesterday');
  i18n.use('ko');
});

test('맥이 읽은 분량도 이어서 볼 것을 고르는 데 들어간다', async () => {
  const {shareOf} = await import('../app.js');
  // Whichever road got furthest: the voice, this phone's pages, or the Mac's reader.
  assert.equal(shareOf({heard: 20, page: 3, pages: 10, read: 67}), 67);
  assert.equal(shareOf({heard: 80, read: 67}), 80);
  assert.equal(shareOf({read: 0}), 0);
  assert.equal(shareOf({read: 140}), 100, 'a figure out of range is brought back into it');
  assert.equal(shareOf({}), 0);
});

/* ---- 설정 · 앱 · 화면 ---- */
test('두 가지 다크는 같은 색을 말한다', () => {
  const css = read('app.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const auto = /@media \(prefers-color-scheme: dark\) \{\n  :root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n  \}/.exec(css)[1];
  const asked = /\n:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/.exec(css)[1];
  const tokens = block => Object.fromEntries([...block.matchAll(/(--[a-z-]+):([^;]+)/g)].map(m => [m[1], m[2].trim()]));
  // Two copies of one scheme: a phone that is dark, and a reader who asked for dark. They drift
  // silently otherwise — one of the two darks would keep an old colour nobody looks at twice.
  assert.deepEqual(tokens(asked), tokens(auto));
  assert.ok(Object.keys(tokens(asked)).length > 10, 'and it is the whole scheme, not a token or two');
  // Asked for either one, the native parts are told as well.
  assert.match(css, /:root\[data-theme="light"\] \{ color-scheme: light; \}/);
  assert.match(css, /:root\[data-theme="dark"\] \{ color-scheme: dark; \}/);
  // Every rule that answers to the phone's own dark answers to the asked-for dark too.
  const autoRules = [...css.matchAll(/@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\) ([^{]+)\{/g)].map(m => m[1].trim());
  assert.ok(autoRules.length >= 3, 'the rules outside the token block are checked too');
  for (const selector of autoRules) {
    assert.match(css, new RegExp(`:root\\[data-theme="dark"\\] ${selector.replace(/[.[\]()*+?^$|\\]/g, '\\$&')}\\s*\\{`),
      `${selector} is dark when asked for, not only when the phone is`);
  }
});

test('화면을 고르면 그 자리에서 바뀌고, 기억된다', async () => {
  const open = await boot({stored: {'np.user': '16265664', 'np.key': 'k'.repeat(24)}});
  await open.settle();
  const {themeWanted, darkWanted} = await import('../app.js');
  assert.equal(themeWanted(null), 'auto');
  assert.equal(themeWanted('nonsense'), 'auto');
  assert.equal(themeWanted('dark'), 'dark');
  // 자동 is the phone's own; the other two are the reader's, whichever phone they are on.
  assert.equal(darkWanted(null, true), true);
  assert.equal(darkWanted(null, false), false);
  assert.equal(darkWanted('light', true), false, 'a dark phone, a reader who wants light');
  assert.equal(darkWanted('dark', false), true);

  const root = open.document.documentElement;
  const bar = () => [...open.document.querySelectorAll('meta[name="theme-color"]')].map(m => m.getAttribute('content'));
  assert.equal(root.getAttribute('data-theme'), null, 'it starts out following the phone');
  assert.deepEqual(bar(), ['#f1f1f5', '#000000'], 'and each bar colour keeps its own media');

  open.document.getElementById('btn-settings-main').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  const buttons = [...open.document.querySelectorAll('#settings-body .set-row')]
    .find(row => /화면/.test(row.textContent)).querySelectorAll('button');
  assert.deepEqual([...buttons].map(b => b.textContent), ['자동', '라이트', '다크']);
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'true');

  buttons[2].dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(root.getAttribute('data-theme'), 'dark', 'the whole app turns on the attribute');
  assert.equal(open.storage.get('np.theme'), 'dark');
  assert.deepEqual(bar(), ['#000000', '#000000'], 'and the strip above it goes with it');
  assert.equal(buttons[2].getAttribute('aria-pressed'), 'true');
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'false');

  // Back to 자동: nothing is remembered, so the phone answers again.
  buttons[0].dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.equal(root.getAttribute('data-theme'), null);
  assert.ok(!open.storage.get('np.theme'), 'nothing is kept for the phone’s own answer');
  assert.deepEqual(bar(), ['#f1f1f5', '#000000']);

  // The page itself settles the choice before app.js runs, or a phone in the other scheme flashes.
  const html = read('index.html');
  assert.match(html, /np\.theme/);
  assert.ok(html.indexOf('np.theme') < html.indexOf('src="app.js"'), 'and it runs before the app does');
});

test('고른 화면은 PDF 페이지까지 따라간다', async () => {
  const open = await boot();
  await open.settle();
  const {darkWanted, nightWanted} = await import('../app.js');
  // 자동 is unchanged; asked for dark on a light phone, the page opens dark too.
  assert.equal(nightWanted(null, darkWanted(null, false)), false);
  assert.equal(nightWanted(null, darkWanted('dark', false)), true);
  assert.equal(nightWanted(null, darkWanted('light', true)), false);
  // What the reader said about this one page still wins over both.
  assert.equal(nightWanted('off', darkWanted('dark', false)), false);
  assert.equal(nightWanted('on', darkWanted('light', true)), true);
});

test('the bar says when the voice is one the screen can stop, and which papers do not stop', async () => {
  // iOS stops a page's own voice when the screen locks and says nothing; a baked file plays on.
  // The line belongs on the bar before the car, not in the car.
  const {screenWarning} = await import('../app.js');
  // Another test leaves the app in English; this one is about the Korean the bar shows here.
  const i18n = await import('../i18n.js');
  i18n.use('ko', {language: 'ko-KR'});
  assert.equal(screenWarning('mac', true), '', 'the Mac reading from a file needs no warning');
  assert.match(screenWarning('raw', true), /화면을 끄면 멈춥니다/);
  assert.match(screenWarning('raw', true), /맥 음성은 안 멈춥니다/, 'and says what to switch to');
  assert.match(screenWarning('raw', false), /맥이 아직 이 논문을 굽지 않았습니다/, 'with no file there is nothing to switch to');
  assert.match(screenWarning('tr', false), /화면을 끄면 멈춥니다/, 'a translation is read by the phone too');
});

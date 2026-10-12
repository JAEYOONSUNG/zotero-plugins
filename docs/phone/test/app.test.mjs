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
function fakeSpeech() {
  const queue = [], spoken = [];
  class Utterance {
    constructor(text) { this.text = text; this.onstart = null; this.onend = null; this.onerror = null; }
  }
  const synth = {
    getVoices: () => [{voiceURI: 'v-sam', name: 'Samantha', lang: 'en-US', localService: true, default: true}],
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
    if (/^\/items\/\w+\/children$/.test(rest)) return new Response(JSON.stringify(children || []), {status: 200, headers: {'Content-Type': 'application/json'}});
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
async function boot({server = fakeServer(), stored = {'np.user': '16265664', 'np.key': 'k'.repeat(24)}, hash = ''} = {}) {
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
  const location = {origin: 'https://x.test', pathname: '/phone/', search: '', hash};
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
  const speech = fakeSpeech();
  const globals = {
    window, document, localStorage: window.localStorage, indexedDB: window.indexedDB, fetch: window.fetch,
    requestAnimationFrame: window.requestAnimationFrame, Response, URL, URLSearchParams, location, history,
    matchMedia: () => ({matches: false, addEventListener() {}}),
    setTimeout: clock.after, clearTimeout: clock.stop,
    setInterval: clock.every, clearInterval: clock.stopEvery,
    addEventListener: (type, fn, opts) => window.addEventListener?.(type, fn, opts),
    // No service worker in this test phone, and linkedom's navigator is read-only.
    navigator: {userAgent: 'test'},
    speechSynthesis: speech.synth, SpeechSynthesisUtterance: speech.Utterance
  };
  const put = (name, value) => Object.defineProperty(globalThis, name, {value, configurable: true, writable: true});
  for (const [name, value] of Object.entries(globals)) put(name, value);
  await import(new URL(`../app.js?boot=${++boots}`, here));
  /* Turn the crank until everything in flight has landed. Waiting out a busy server takes
     longer than the usual round, so those tests ask for more rounds. */
  const settle = async (rounds = 60) => { for (let i = 0; i < rounds; i++) await new Promise(r => realAfter(r, 4)); };
  return {window, document, settle, storage, location, speech};
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
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click'));
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
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click'));
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
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click'));
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

  open.document.querySelectorAll('#list .row')[100].dispatchEvent(new open.window.Event('click'));
  await open.settle();
  open.document.getElementById('back').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.ok(drawn() >= deep, `the list came back as long as it was (${drawn()} of ${deep})`);
});

test('the order can be changed, and it is remembered', async () => {
  const open = await boot();
  await open.settle();
  const titles = () => [...open.document.querySelectorAll('#list .row h2')].map(h => h.textContent);
  const select = open.document.querySelector('#scope select');
  assert.ok(select, 'the order is offered');
  // linkedom's <select>.value is read-only, as a real one is: the option is what gets chosen.
  for (const option of select.querySelectorAll('option')) option.selected = option.value === 'title';
  select.dispatchEvent(new open.window.Event('change'));
  assert.deepEqual(titles(), ['Immune sensing in bacteria', 'PET depolymerase landscape', 'Retron Septu defence']);
  assert.equal(open.storage.get('np.sort'), 'title', 'and kept for next time');
});

test('a collection and a tag show as chips that take themselves off again', async () => {
  const open = await boot();
  await open.settle();
  open.document.getElementById('btn-collections').dispatchEvent(new open.window.Event('click'));
  await open.settle();
  const tag = [...open.document.querySelectorAll('#collections .pick-chip')].find(c => /phage/.test(c.textContent));
  assert.ok(tag, 'the tags in use are offered');
  tag.dispatchEvent(new open.window.Event('click'));
  await open.settle();
  assert.deepEqual([...open.document.querySelectorAll('#list .row h2')].map(h => h.textContent), ['Retron Septu defence']);
  const chip = [...open.document.querySelectorAll('#scope .scope-chip')].find(c => /phage/.test(c.textContent));
  assert.ok(chip, 'the narrowing is on screen');
  chip.dispatchEvent(new open.window.Event('click'));
  assert.equal(open.document.querySelectorAll('#list .row').length, 3, 'and comes off again');
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
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click'));
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
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click'));
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

  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click'));
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

  row.dispatchEvent(new open.window.Event('click'));
  await open.settle();
  const detail = open.document.getElementById('detail');
  assert.match(detail.textContent, /Phage defence/, 'the collection it is in');
  const out = detail.querySelector('a.out');
  assert.ok(out, 'a way out to the publisher');
  assert.equal(out.getAttribute('rel'), 'noopener', 'and it is opened safely');
});

test('the marks made in Zotero are listed in the order they appear, and lead into the paper', async () => {
  const open = await boot({server: fakeServer({children: MARKED, fulltext: FULLTEXT})});
  await open.settle();
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click'));
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
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click'));
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

async function openListening(options = {}) {
  const server = fakeServer({children: PDF_CHILD, fulltext: FULLTEXT, ...options});
  const open = await boot({server});
  await open.settle();
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click'));
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
  open.document.querySelectorAll('#list .row')[0].dispatchEvent(new open.window.Event('click'));
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

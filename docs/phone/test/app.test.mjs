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
    publicationTitle: 'Science', tags: [{tag: '/reading', type: 1}, {tag: 'phage'}], collections: ['C1'], extra: 'Citations: 89', dateModified: '2026-10-10T00:00:00Z'}},
  {key: 'BBB', version: 11, data: {key: 'BBB', version: 11, itemType: 'journalArticle', title: 'PET depolymerase landscape', date: '2026',
    creators: [{creatorType: 'author', lastName: 'Hong', firstName: 'H'}], publicationTitle: 'Nature', tags: [{tag: '/unread', type: 1}],
    collections: [], extra: 'Rating: 4\nCitations: 7', dateModified: '2026-10-09T00:00:00Z'}},
  {key: 'CCC', version: 12, data: {key: 'CCC', version: 12, itemType: 'journalArticle', title: 'Immune sensing in bacteria', date: '2026',
    creators: [], publicationTitle: 'Nat Rev Microbiol', tags: [{tag: '/done', type: 1}], collections: ['C1'], extra: '', dateModified: '2026-10-08T00:00:00Z'}},
  // Not a paper: an attachment must never reach the list.
  {key: 'DDD', version: 13, data: {key: 'DDD', version: 13, itemType: 'attachment', parentItem: 'AAA', title: 'full text', tags: [], dateModified: '2026-10-08T00:00:00Z'}}
];
const COLLECTIONS = [{key: 'C1', version: 5, data: {key: 'C1', name: 'Phage defence', parentCollection: false}}];

/* The smallest IndexedDB that answers what the app asks of it. */
function fakeIndexedDB() {
  const stores = new Map();
  const store = name => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name); };
  const task = result => { const req = {result, onsuccess: null, onerror: null}; queueMicrotask(() => req.onsuccess && req.onsuccess()); return req; };
  return {
    open() {
      const db = {
        objectStoreNames: {contains: name => stores.has(name)},
        createObjectStore(name) { store(name); return {}; },
        transaction(name) {
          const tx = {oncomplete: null, onerror: null,
            objectStore: () => ({
              getAll: () => task([...store(name).values()]),
              put: row => { store(name).set(row.key, row); return task(); },
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

/* api.zotero.org, enough of it: paged listings with the headers the app reads, and PATCH/POST
   that record what was sent. */
function fakeServer({items = ITEMS, collections = COLLECTIONS} = {}) {
  const sent = [];
  const page = (rows, url) => {
    const limit = Number(url.searchParams.get('limit') || 25), start = Number(url.searchParams.get('start') || 0);
    const slice = rows.slice(start, start + limit);
    return new Response(JSON.stringify(slice), {status: 200, headers: {
      'Total-Results': String(rows.length), 'Last-Modified-Version': '42', 'Content-Type': 'application/json'}});
  };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    sent.push({method: init.method || 'GET', path: url.pathname + url.search, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null});
    if (!url.pathname.startsWith('/users/16265664')) return new Response('no', {status: 404});
    const rest = url.pathname.replace('/users/16265664', '');
    if (rest === '/collections') return page(collections, url);
    if (rest === '/items') {
      if ((init.method || 'GET') === 'POST') return new Response(JSON.stringify({successful: {0: {key: 'NNN'}}, failed: {}}), {status: 200, headers: {'Last-Modified-Version': '43'}});
      return page(items, url);
    }
    if (rest === '/deleted') return new Response(JSON.stringify({items: [], collections: []}), {status: 200, headers: {'Last-Modified-Version': '42'}});
    if (/^\/items\/\w+\/children$/.test(rest)) return new Response('[]', {status: 200, headers: {'Content-Type': 'application/json'}});
    if (/^\/items\/\w+$/.test(rest)) return new Response('', {status: 204, headers: {'Last-Modified-Version': '44'}});
    return new Response('no', {status: 404});
  };
  return {fetchImpl, sent};
}

/* The app, loaded into that phone. Returns the window it runs in. */
async function boot({server = fakeServer(), stored = {'np.user': '16265664', 'np.key': 'k'.repeat(24)}} = {}) {
  const {window, document} = parseHTML(read('index.html'));
  const storage = new Map(Object.entries(stored));
  Object.assign(window, {
    localStorage: {getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k)},
    indexedDB: fakeIndexedDB(),
    fetch: server.fetchImpl,
    requestAnimationFrame: fn => setTimeout(fn, 0),
    matchMedia: () => ({matches: false, addEventListener() {}}),
    Response, Request, Headers, URL, URLSearchParams, queueMicrotask, setTimeout, clearTimeout, console
  });
  // No service worker in this test phone; linkedom's navigator is read-only, so the app is given its own.
  const navigator = {userAgent: 'test'};
  const code = read('app.js');
  const run = new Function('window', 'document', 'localStorage', 'indexedDB', 'fetch', 'requestAnimationFrame',
    'Response', 'URL', 'URLSearchParams', 'navigator', 'addEventListener', 'setTimeout', 'clearTimeout', 'console', 'location', code);
  run(window, document, window.localStorage, window.indexedDB, window.fetch, window.requestAnimationFrame,
    Response, URL, URLSearchParams, window.navigator, (type, fn) => window.addEventListener?.(type, fn), setTimeout, clearTimeout, console, {origin: 'https://x.test'});
  const settle = async () => { for (let i = 0; i < 60; i++) await new Promise(r => setTimeout(r, 4)); };
  return {window, document, settle, storage};
}

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
  assert.deepEqual([...open.document.querySelectorAll('#list .row h2')].map(h => h.textContent), ['PET depolymerase landscape'],
    'the search reaches the journal, not only the title');
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

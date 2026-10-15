/* 논문 — a Zotero library on the phone.

   What it talks to
   - api.zotero.org, with the user's own key kept in this phone's localStorage. The API allows
     cross-origin requests with the Zotero-API-Key header, so no server of ours stands between.
   - Nothing else. No analytics, no backend; the library is cached in IndexedDB on the phone.

   The data contract is the one the desktop plugin (zotero-style-custom) uses, so a change made
   here shows up there after a sync, and the other way round:
     status  the tags /unread, /reading, /done   (at most one of them)
     rating  a "Rating: N" line in the item's Extra field (0-5)

   Writes go through PATCH with If-Unmodified-Since-Version, so an item changed elsewhere since
   this phone last saw it is refused rather than overwritten. */

import {readable, units as readingUnits, remainingSeconds, fromNote, isTranslation, noteTarget} from './read.js';
import {t, T, set as setStrings, use as useLanguage, using} from './i18n.js';
import EN from './en.js';
import {createPlayer, speechEngine, bakedVoice, pickVoice, paperLanguage, sectionsOf, RATES,
        voiceMenu, voiceTier, TIERS, langName, sampleFor} from './play.js';
import {fileSource, createDropbox, returningCode, paperFile, DEFAULT_BASE,
        bakedAudio, bakedMarks, bakedIndex, bakedPaths, keepBaked, libraryFacts, flagOf, bandOf,
        inkFor, markOf, MARKS, AUDIO_BASE, AUDIO_KEY} from './files.js';
import {createViewer, markPlace} from './pdfview.js';
import {filterRows, sortRows, usefulTags, familyOf, SORTS, groupOf, railLabel, fold, words} from './list.js';
import {withRetry, isOffline, mergeQueue} from './net.js';

const API = 'https://api.zotero.org';
/* Which build of the app this is. It is the name the service worker keeps its copy of the shell
   under, so the two cannot drift: a test holds them to each other. */
export const BUILD = 'nonmun-v23';
const KEYS = {user: 'np.user', key: 'np.key', ver: 'np.version', scope: 'np.scope',
              rate: 'np.rate', voice: 'np.voice.', at: 'np.at.', sort: 'np.sort', page: 'np.page.',
              pct: 'np.pct.', seen: 'np.seen.', synced: 'np.synced', last: 'np.last', tip: 'np.tip',
              read: 'np.read', recent: 'np.recent', kind: 'np.lastkind', of: 'np.of.',
              drive: 'np.drive', chain: 'np.chain', vol: 'np.vol', reads: 'np.reads', lang: 'np.lang', said: 'np.said', theme: 'np.theme'};
const STATUSES = [['', '전체'], ['reading', '읽는 중'], ['unread', '안 읽음'], ['done', '완료']];
const STATUS_TAG = {unread: '/unread', reading: '/reading', done: '/done'};
const TAG_STATUS = {'/unread': 'unread', '/reading': 'reading', '/done': 'done'};

const $ = id => document.getElementById(id);
const SAYS = new Set(['text', 'title', 'aria-label', 'placeholder', 'aria-valuetext']);
const el = (tag, attrs = {}, parent) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') node.textContent = SAYS.has(k) ? t(v) : v;
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v === true ? '' : SAYS.has(k) ? t(String(v)) : String(v));
  }
  if (parent) parent.appendChild(node);
  return node;
};
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();

let toastTimer = null;
/* A line about what just happened, and — where what happened can be taken back — the way to take
   it back, for as long as the line is up. A shelf of papers marked by one tap is exactly the
   thing worth being able to undo. */
export const TOAST = 2600, TOAST_UNDO = 6000;
function toast(text, {undo = null} = {}) {
  const node = $('toast');
  node.textContent = '';
  el('span', {text}, node);
  if (undo) {
    const back = el('button', {class: 'undo', type: 'button', text: '되돌리기'}, node);
    back.addEventListener('click', () => {
      node.hidden = true;
      clearTimeout(toastTimer);
      Promise.resolve().then(undo).catch(error => toast(error.message));
    });
  }
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, undo ? TOAST_UNDO : TOAST);
}

/* ---------- the phone's own copy ---------- */
/* One store for items, one for collections, one for the sync version. IndexedDB so a library of
   a few thousand papers opens instantly and works with no signal. */
const DB = (() => {
  let open = null;
  const ready = () => open || (open = new Promise((resolve, reject) => {
    const req = indexedDB.open('nonmun', 4);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', {keyPath: 'key'});
      if (!db.objectStoreNames.contains('collections')) db.createObjectStore('collections', {keyPath: 'key'});
      // The text Zotero indexed, kept so a paper opened once can be listened to with no signal.
      if (!db.objectStoreNames.contains('text')) db.createObjectStore('text', {keyPath: 'key'});
      // The PDFs themselves, so a paper opened once opens again with no signal.
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', {keyPath: 'key'});
      // Changes made with no signal, waiting for some.
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', {keyPath: 'id'});
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const run = async (store, mode, fn) => {
    const db = await ready();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode), out = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      tx.onerror = () => reject(tx.error);
    });
  };
  return {
    all: store => run(store, 'readonly', s => s.getAll()),
    get: (store, key) => run(store, 'readonly', s => s.get(key)),
    put: (store, rows) => run(store, 'readwrite', s => { for (const row of rows) s.put(row); }),
    remove: (store, keys) => run(store, 'readwrite', s => { for (const key of keys) s.delete(key); }),
    clear: store => run(store, 'readwrite', s => s.clear())
  };
})();

/* ---------- the account ---------- */
/* iOS gives a home-screen web app its own storage: the key typed in Safari is not there when the
   icon is opened. So the key can travel in the link itself — "키까지 함께 담기" puts it in the
   address, the icon is added from that address, and the app saves it on its first launch and
   takes it straight back out of the address. */
const standalone = () => {
  try { return window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches; }
  catch (_) { return false; }
};
function takeKeyFromLink() {
  const hash = String(location.hash || '');
  if (!hash.includes('k=')) return false;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const user = clean(params.get('u')), key = clean(params.get('k'));
  if (!/^\d+$/.test(user) || key.length < 12) return false;
  localStorage.setItem(KEYS.user, user);
  localStorage.setItem(KEYS.key, key);
  // The Dropbox connection travels the same way: the home-screen app has its own storage too.
  for (const [from, to] of [['a', 'np.db.app'], ['d', 'np.db.refresh'], ['b', 'np.db.base']]) {
    const value = clean(params.get(from));
    if (value) localStorage.setItem(to, value);
  }
  try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { location.hash = ''; }
  return true;
}

const account = {
  get user() { return localStorage.getItem(KEYS.user) || ''; },
  get key() { return localStorage.getItem(KEYS.key) || ''; },
  get version() { return Number(localStorage.getItem(KEYS.ver) || 0); },
  set version(v) { localStorage.setItem(KEYS.ver, String(v)); },
  save(user, key) { localStorage.setItem(KEYS.user, user); localStorage.setItem(KEYS.key, key); },
  get ready() { return !!(this.user && this.key); }
};

/* A read is tried again when the server is busy or the request dies on the way out. A change is
   tried again only for the answers that mean it was not taken (429, 503); anything that may have
   been applied is left to the caller, which knows whether sending it twice would be harmless. */
async function api(path, {method = 'GET', body = null, headers = {}, tries = null} = {}) {
  const url = `${API}/users/${account.user}${path}`;
  const send = {
    method,
    headers: {
      'Zotero-API-Version': '3',
      'Zotero-API-Key': account.key,
      ...(body ? {'Content-Type': 'application/json'} : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  };
  const response = await withRetry(() => fetch(url, send), {
    tries: tries === null ? (method === 'GET' ? 4 : method === 'POST' ? 1 : 2) : tries,
    onWait: ms => { if (ms > 1200) $('sync-state').textContent = `서버가 바빠 ${Math.round(ms / 1000)}초 기다립니다…`; }
  }).catch(error => {
    if (isOffline(error)) throw Object.assign(new Error('신호가 없습니다.'), {offline: true});
    throw error;
  });
  if (response.status === 403) throw Object.assign(new Error('키가 거부되었습니다. 읽기·쓰기 권한을 확인하세요.'), {status: 403});
  if (response.status === 412) throw Object.assign(new Error('다른 곳에서 먼저 바뀌었습니다. 새로 고침하고 다시 시도하세요.'), {status: 412});
  if (response.status === 429 || response.status === 503) {
    throw Object.assign(new Error('Zotero 서버가 계속 바쁩니다. 조금 뒤에 다시 시도하세요.'), {status: response.status, busy: true});
  }
  if (!response.ok) throw Object.assign(new Error(`Zotero 서버 오류 (${response.status})`), {status: response.status});
  return response;
}

/* Every page of a listing, following Total-Results rather than guessing. */
async function fetchAll(path, onPage) {
  const limit = 100;
  let start = 0, total = Infinity, version = 0;
  while (start < total) {
    const sep = path.includes('?') ? '&' : '?';
    const response = await api(`${path}${sep}limit=${limit}&start=${start}`);
    total = Number(response.headers.get('Total-Results') || 0);
    version = Math.max(version, Number(response.headers.get('Last-Modified-Version') || 0));
    const rows = await response.json();
    if (onPage) onPage(rows, start + rows.length, total);
    start += rows.length;
    if (!rows.length) break;
  }
  return version;
}

/* ---------- what a row means ---------- */
const statusOf = item => {
  for (const tag of item.data?.tags || []) {
    const name = TAG_STATUS[tag.tag];
    if (name) return name;
  }
  return '';
};
const ratingOf = item => {
  const m = /^\s*Rating:\s*([0-5])\s*$/mi.exec(item.data?.extra || '');
  return m ? Number(m[1]) : 0;
};
const yearOf = item => (String(item.data?.date || '').match(/\b(1[6-9]\d\d|20\d\d|21\d\d)\b/) || [])[1] || '';
const authorsOf = item => {
  const list = (item.data?.creators || []).filter(c => c.creatorType === 'author');
  if (!list.length) return '';
  const name = c => clean(c.lastName || c.name || '');
  return list.length === 1 ? name(list[0]) : list.length === 2 ? `${name(list[0])} · ${name(list[1])}` : `${name(list[0])} 외 ${list.length - 1}`;
};
const venueOf = item => clean(item.data?.publicationTitle || item.data?.bookTitle || item.data?.repository || item.data?.publisher || '');
const REGULAR = /^(?:journalArticle|preprint|conferencePaper|bookSection|book|thesis|report|manuscript|magazineArticle|newspaperArticle|patent|dataset|webpage|document)$/;
const isPaper = item => REGULAR.test(item.data?.itemType || '') && !item.data?.parentItem && !item.data?.deleted;

/* ---------- state ---------- */
/* `shown` is how far down the list has been drawn: a library of a few thousand is put on screen
   a screenful at a time, so opening it is instant and scrolling to the end still reaches the end. */
const state = {items: [], collections: [], status: '', collection: '', tag: '', q: '',
               sort: localStorage.getItem('np.sort') || 'added', shown: 0, busy: false, at: 0,
               picking: false, picked: new Set()};
const PAGE = 60;

/* ---------- sync ---------- */
async function loadCache() {
  const [items, collections] = await Promise.all([DB.all('items'), DB.all('collections')]);
  state.items = items.filter(isPaper);
  state.collections = collections;
}

/* The button says, by turning, that the library is being fetched — the one place the app has to
   show that it is doing something and not simply stuck. */
function spinSync(on) {
  const button = $('btn-sync');
  if (!button) return;
  button.classList.toggle('spinning', !!on);
  button.setAttribute('aria-busy', String(!!on));
}

async function sync({full = false} = {}) {
  if (state.busy) return;
  state.busy = true;
  spinSync(true);
  const since = full ? 0 : account.version;
  $('sync-state').textContent = since ? '확인 중…' : '처음 받는 중…';
  if (!state.items.length) render();
  try {
    if (full) { await DB.clear('items'); await DB.clear('collections'); account.version = 0; }

    // Collections first: the list can group by them as soon as the items land.
    const colls = [];
    await fetchAll(`/collections${since ? `?since=${since}` : ''}`, rows => colls.push(...rows));
    if (colls.length) await DB.put('collections', colls);

    // Items. Without a version this is the whole library; with one, only what changed.
    let seen = 0;
    const version = await fetchAll(`/items${since ? `?since=${since}` : ''}`, async (rows, done, total) => {
      seen = done;
      await DB.put('items', rows);
      $('sync-state').textContent = `${done.toLocaleString()} / ${total.toLocaleString()}`;
      showSyncBar(done, total);
    });

    // What was deleted elsewhere goes too, so the phone does not keep ghosts.
    if (since) {
      const response = await api(`/deleted?since=${since}`);
      const gone = await response.json();
      const keys = [...(gone.items || []), ...(gone.collections || [])];
      if (gone.items?.length) await DB.remove('items', gone.items);
      if (gone.collections?.length) await DB.remove('collections', gone.collections);
      if (keys.length) toast(T('{0}건이 삭제되어 함께 지웠습니다', keys.length));
    }

    if (version) account.version = version;
    await loadCache();
    render();
    await flushWrites();
    localStorage.setItem(KEYS.synced, String(Date.now()));
    $('sync-state').textContent = seen ? T('{0}건 갱신', seen.toLocaleString()) : t('최신');
    // The Mac bakes while the phone is in a pocket: a refresh asks the folder again, not just Zotero.
    loadBaked({refresh: true}).catch(() => {});
  } catch (error) {
    if (error.status === 403) { $('sync-state').textContent = ''; showKeyTrouble(); }
    else if (error.offline) $('sync-state').textContent = '오프라인';   // the usual state on a phone, not news
    else { $('sync-state').textContent = ''; toast(error.message || '가져오지 못했습니다'); }
  } finally {
    state.busy = false;
    spinSync(false);
    showSyncBar(0, 0);
    setTimeout(restState, 4000);
  }
}

/* A few thousand papers take a moment the first time, and a spinning button says only that
   something is happening. This says how much of it has arrived, along the foot of the bar, and
   only while there is more than one page of it to wait for. */
export function showSyncBar(done, total) {
  const bar = $('syncbar');
  if (!bar) return;
  if (!total || total <= PAGE || done >= total) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.style.setProperty('--done', String(Math.max(0.02, Math.min(1, done / total))));
}

/* ---------- writing back ---------- */
/* A change is kept as an INTENTION — "mark it done", "give it four" — not as the fields to send.
   That is what makes the two hard cases work: a paper changed on the Mac since this phone last
   saw it is fetched afresh and the intention applied to that (rather than overwriting someone
   else's tags), and a change made with no signal is held until there is some, by which time the
   paper may have moved on and "mark it done" still means the same thing.

   One PATCH per change, guarded by the version this phone holds, so a paper that moved under us
   is refused rather than overwritten. */

const INTENT = {
  status: (item, value) => {
    const kept = (item.data.tags || []).filter(t => !TAG_STATUS[t.tag]);
    return {tags: value ? [...kept, {tag: STATUS_TAG[value], type: 1}] : kept};
  },
  rating: (item, value) => {
    const lines = String(item.data.extra || '').split('\n').filter(line => !/^\s*Rating:\s*[0-5]\s*$/i.test(line));
    if (value > 0) lines.unshift(`Rating: ${value}`);
    return {extra: lines.join('\n').replace(/^\n+|\n+$/g, '')};
  }
};

async function patchItem(item, data) {
  const response = await api(`/items/${item.key}`, {
    method: 'PATCH', body: data,
    headers: {'If-Unmodified-Since-Version': String(item.version)}
  });
  const version = Number(response.headers.get('Last-Modified-Version') || item.version + 1);
  const next = {...item, version, data: {...item.data, ...data, version}};
  await DB.put('items', [next]);
  const at = state.items.findIndex(x => x.key === item.key);
  if (at >= 0) state.items[at] = next;
  if (account.version && version > account.version) account.version = version;
  return next;
}

const liveItem = key => state.items.find(x => x.key === key) || null;

/* The paper as the server has it now, for when this phone's copy was refused as out of date. */
async function freshItem(key) {
  const response = await api(`/items/${key}`);
  const row = await response.json();
  await DB.put('items', [row]);
  const at = state.items.findIndex(x => x.key === key);
  if (at >= 0) state.items[at] = row; else state.items.push(row);
  return row;
}

/* Applied here first so the screen never lies about what was pressed, then sent. */
function applyLocally(key, kind, value) {
  const item = liveItem(key);
  if (!item || !INTENT[kind]) return;
  const next = {...item, data: {...item.data, ...INTENT[kind](item, value)}};
  const at = state.items.findIndex(x => x.key === key);
  if (at >= 0) state.items[at] = next;
  DB.put('items', [next]).catch(() => {});
}

async function writeIntent(key, kind, value) {
  const item = liveItem(key);
  if (!item) throw new Error('이 논문을 찾을 수 없습니다.');
  try {
    return await patchItem(item, INTENT[kind](item, value));
  } catch (error) {
    if (error.status === 412) {
      // Changed elsewhere since this phone last looked: take what is there now and mean the same thing.
      const fresh = await freshItem(key);
      return await patchItem(fresh, INTENT[kind](fresh, value));
    }
    if (error.offline || error.busy) {
      applyLocally(key, kind, value);
      await holdWrite({kind, key, value});
      toast(error.offline ? '신호가 없어 저장해 두었습니다. 연결되면 보냅니다' : '서버가 바빠 저장해 두었습니다');
      return liveItem(key);
    }
    throw error;
  }
}

const setStatus = (item, status) => writeIntent(item.key, 'status', status);
const setRating = (item, rating) => writeIntent(item.key, 'rating', rating);

/* ---------- changes waiting for signal ---------- */
async function heldWrites() {
  const rows = await DB.all('queue').catch(() => []);
  return rows.sort((a, b) => (a.at || 0) - (b.at || 0));
}
/* Rewriting the whole queue is the simplest way to merge one change into it, so the rewrites are
   taken in turn: two changes made at once would otherwise each write over the other's. */
let holding = Promise.resolve();
function holdWrite(write) {
  holding = holding.then(async () => {
    const queue = mergeQueue(await heldWrites(), {...write, at: Date.now()});
    await DB.clear('queue').catch(() => {});
    await DB.put('queue', queue.map((row, i) => ({...row, id: `${row.kind}:${row.key}:${row.at}:${i}`}))).catch(() => {});
    paintHeld(queue.length);
  }).catch(() => {});
  return holding;
}
function paintHeld(n) {
  const mark = $('held');
  if (!mark) return;
  mark.hidden = !n;
  mark.textContent = n ? `보낼 변경 ${n}건` : '';
}

/* Sent oldest first; one that cannot go yet stays, and the rest are left for the next try. */
async function flushWrites({quiet = true} = {}) {
  // Claimed before the first await, or two of these would read the same queue and send it twice.
  if (!account.ready || flushWrites.busy) return 0;
  flushWrites.busy = true;
  let sent = 0;
  const queue = await heldWrites().catch(() => []);
  if (!queue.length) { flushWrites.busy = false; paintHeld(0); return 0; }
  try {
    for (const write of queue) {
      try {
        if (write.kind === 'note') await postNote(write.key, write.value);
        else {
          const item = liveItem(write.key) || await freshItem(write.key);
          try { await patchItem(item, INTENT[write.kind](item, write.value)); }
          catch (error) {
            if (error.status !== 412) throw error;
            const fresh = await freshItem(write.key);
            await patchItem(fresh, INTENT[write.kind](fresh, write.value));
          }
        }
        await DB.remove('queue', [write.id]);
        sent++;
      } catch (error) {
        if (error.offline || error.busy) break;   // no signal yet; the rest can wait with it
        await DB.remove('queue', [write.id]);     // refused for good: keeping it would retry forever
        toast(T('보내지 못한 변경 하나를 버렸습니다 — {0}', error.message));
      }
    }
  } finally {
    flushWrites.busy = false;
    const left = await heldWrites();
    paintHeld(left.length);
    if (sent) { render({keep: true}); if (!quiet) toast(T('{0}건을 보냈습니다', sent)); }
  }
  return sent;
}

async function postNote(key, text) {
  // Trimmed, but the line breaks are the writer's: clean() would run the paragraphs together.
  const body = String(text ?? '').replace(/[ \t]+/g, ' ').replace(/[ \t]*\n/g, '\n').trim();
  if (!body) return null;
  const html = body.split(/\n{2,}/).map(p => `<p>${p.replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'})[c]).replace(/\n/g, '<br>')}</p>`).join('');
  const response = await api('/items', {
    method: 'POST',
    body: [{itemType: 'note', parentItem: key, note: html, tags: []}]
  });
  const result = await response.json();
  if (result.failed && Object.keys(result.failed).length) throw new Error('메모를 저장하지 못했습니다');
  return result;
}

async function addNote(item, text) {
  try {
    return await postNote(item.key, text);
  } catch (error) {
    if (!error.offline && !error.busy) throw error;
    await holdWrite({kind: 'note', key: item.key, value: text});
    toast('신호가 없어 메모를 저장해 두었습니다. 연결되면 보냅니다');
    return null;
  }
}

/* The one card above the library, used for the two things worth interrupting for. It has a
   single owner: every showing replaces what the buttons do, so two of them cannot both fire. */
function showCard({html, label, run, dismiss = '나중에'}) {
  const card = $('pair');
  if (!card) return;
  // The sentence carries a <b> in it, so it is looked up whole and then written as markup.
  $('pair-text').innerHTML = t(html);
  const go = $('pair-go'), hide = $('pair-hide');
  go.textContent = t(label);
  go.hidden = !label;
  go.onclick = run || null;
  hide.textContent = t(dismiss);
  hide.onclick = () => { card.hidden = true; };
  card.hidden = false;
}

/* A key the server refuses is not a passing failure: nothing will work until it is replaced,
   so it is said once, where it can be put right. */
function showKeyTrouble() {
  showCard({
    html: 'Zotero가 이 키를 거부했습니다. <b>Allow library access</b>와 <b>Allow write access</b>가 켜져 있는지 확인하고 새 키를 넣어 주세요.',
    label: '설정 열기',
    run: () => { $('pair').hidden = true; openSettings(); },
    dismiss: '닫기'
  });
}

/* The big title gives way to the small one as the library is scrolled, and the bar grows its
   hairline only once there is something underneath it — what every list on this phone does. The
   two thresholds are apart so a title cannot flicker on a finger held still. */
const followed = new WeakMap();
export function followScroll(list, top, {after = 14} = {}) {
  if (!list || !top) return null;
  if (followed.has(list)) { const paint = followed.get(list); paint(); return paint; }
  let small = false;
  /* How far down the list the big thing has to go before the small one takes its place: a
     screenful of chrome needs fourteen pixels, a paper's own name needs the whole title block,
     or it would be said twice over at once. */
  const back = Math.max(1, after - 10);
  const paint = () => {
    const at = list.scrollTop || 0;
    if (at > after) small = true; else if (at < back) small = false;
    top.classList.toggle('shrunk', small);
    top.classList.toggle('lifted', at > 1);
  };
  list.addEventListener('scroll', paint, {passive: true});
  followed.set(list, paint);
  paint();
  return paint;
}

/* Dragging a list that is already at the top, far enough, asks for the library again — the
   gesture every other list on this phone has. The ring fills as it is pulled and keeps turning
   where it is until the library has actually arrived: one that vanished the moment the finger
   left would be saying the work was done. */
export const PULL = 62;
function pullToRefresh(list, run) {
  let from = null, pulled = 0, busy = false;
  const mark = el('div', {class: 'pull', 'aria-hidden': 'true'});
  list.parentNode.insertBefore(mark, list);   // above the list, so it pushes rather than covers
  const show = distance => {
    pulled = distance;
    mark.style.setProperty('--pull', `${Math.min(70, distance)}px`);
    mark.style.setProperty('--turn', `${Math.round(Math.min(1, distance / PULL) * 290)}deg`);
    mark.classList.toggle('ready', distance > PULL);
    mark.classList.toggle('on', distance > 4);
  };
  let fromX = 0;
  list.addEventListener('touchstart', event => {
    if (busy) { from = null; return; }
    from = list.scrollTop <= 0 && event.touches.length === 1 ? event.touches[0].clientY : null;
    fromX = event.touches[0] ? event.touches[0].clientX : 0;
    if (from !== null) mark.classList.add('pulling');     // following a finger, so no easing
    show(0);
  }, {passive: true});
  list.addEventListener('touchmove', event => {
    if (from === null || list.scrollTop > 0) { if (!busy) show(0); return; }
    const moved = event.touches[0].clientY - from;
    // A finger going sideways is pushing a paper aside, not asking for the library again.
    if (Math.abs(event.touches[0].clientX - fromX) > Math.abs(moved)) { show(0); return; }
    if (moved > 0) show(moved * 0.5);
  }, {passive: true});
  list.addEventListener('touchend', () => {
    const go = pulled > PULL;
    from = null;
    mark.classList.remove('pulling');
    if (!go) { show(0); return; }
    busy = true;
    mark.classList.add('busy');
    show(44);
    Promise.resolve().then(run).catch(() => {}).then(() => {
      busy = false;
      mark.classList.remove('busy');
      show(0);
    });
  }, {passive: true});
}

/* ---------- the phone's own keyboard ---------- */
/* How much of the screen the keyboard has taken. iOS does not shrink a layout pinned to the
   screen; it reports the smaller visible viewport instead, and anything below that line is
   simply under the keys. */
export const keyboardGap = (height, view) =>
  Math.max(0, Math.round((height || 0) - ((view?.height || height || 0) + (view?.offsetTop || 0))));

/* And it lifts the whole page to put the field it is about to fill above the keys — which in a
   layout pinned to the screen leaves the app sitting half off the top with a strip of nothing
   under it. The page is put back where it belongs, and what the keyboard covers is published so
   the end of a list stays reachable while it is up. */
function steadyKeyboard() {
  const put = () => { try { if (window.scrollY || window.pageYOffset) window.scrollTo(0, 0); } catch (_) {} };
  try {
    window.addEventListener('scroll', put, {passive: true});
    window.addEventListener('focusout', () => setTimeout(put, 0), true);
  } catch (_) {}
  const view = window.visualViewport;
  if (!view || !document.documentElement) return;
  const measure = () => {
    document.documentElement.style.setProperty('--kb', `${keyboardGap(window.innerHeight, view)}px`);
    put();
  };
  try { view.addEventListener('resize', measure); view.addEventListener('scroll', measure); } catch (_) {}
  measure();
}

/* ---------- the screens on top of the list ---------- */
/* Each sheet puts an entry in the history, so the phone's own back — the swipe from the edge in
   the home-screen app, the back button in Safari — closes it instead of leaving the app. A sheet
   is never hidden directly: it is hidden because the history went back past it, which is the only
   way the stack and the screen cannot drift apart. */
const sheets = [];
const SHEET_IDS = ['detail', 'listen', 'paper', 'collections', 'settings'];

/* What is underneath a sheet is not reachable while it is open — not by a swipe of VoiceOver and
   not by a tab — and the eye is put at the top of what just opened. */
function layerUp() {
  const top = sheets.length ? sheets[sheets.length - 1].id : '';
  for (const id of ['main', ...SHEET_IDS]) {
    const node = $(id);
    if (!node) continue;
    const below = !!top && id !== top;
    node.toggleAttribute('inert', below);
    if (SHEET_IDS.includes(id)) node.setAttribute('aria-hidden', String(below && node.hidden));
  }
}

function openSheet(id, leave = () => {}) {
  closeFloat();              // a menu belongs to the screen it was opened on
  const node = $(id);
  if (!node || sheets.some(sheet => sheet.id === id)) return false;
  const from = document.activeElement;
  sheets.push({id, leave, from});
  try { history.pushState({depth: sheets.length}, ''); } catch (_) {}
  node.hidden = false;
  node.setAttribute('role', 'dialog');
  node.setAttribute('aria-modal', 'true');
  layerUp();
  // The way back out is where the eye and the keyboard should land first.
  const first = node.querySelector('.icon-btn, button, [href]');
  requestAnimationFrame(() => { try { first && first.focus({preventScroll: true}); } catch (_) {} });
  return true;
}
function closeSheet(id) {
  const at = sheets.findIndex(sheet => sheet.id === id);
  if (at < 0) { const node = $(id); if (node) node.hidden = true; return; }
  // Going back is what closes it; popped() below does the hiding.
  try { history.go(-(sheets.length - at)); } catch (_) { while (sheets.length > at) popped(); }
}
function popped() {
  const sheet = sheets.pop();
  if (!sheet) return;
  const node = $(sheet.id);
  if (node) node.hidden = true;
  layerUp();
  try { sheet.from && sheet.from.focus && sheet.from.focus({preventScroll: true}); } catch (_) {}
  try { sheet.leave(); } catch (_) {}
}
function onPopState() {
  const depth = Number(history.state && history.state.depth) || 0;
  while (sheets.length > depth) popped();
}

/* The home-screen app has no back gesture of its own — iOS keeps that for Safari — so the sheets
   carry one: a finger from the left edge pulls the screen off to the right and what is under it
   comes back. Let go past a third of the way, or with a flick, and it goes; short of that it
   springs shut again, so a gesture started by accident costs nothing. */
export const BACK_EDGE = 32, BACK_FAR = 0.3, BACK_FLICK = 0.5, BACK_OUT = 200;
function dragBack(id) {
  const screen = $(id);
  if (!screen) return;
  let from = null, axis = '', at = 0, began = 0;
  const onTop = () => sheets.length > 0 && sheets[sheets.length - 1].id === id;
  const move = x => { at = x; screen.style.transform = x ? `translateX(${Math.round(x)}px)` : ''; };
  screen.addEventListener('touchstart', event => {
    from = null; axis = ''; at = 0;
    if (!onTop() || !event.touches || event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (touch.clientX > BACK_EDGE) return;
    // A page pushed sideways is being read, not dismissed: a zoomed PDF keeps its own gesture.
    for (const box of screen.querySelectorAll('.list, .pdf')) if ((box.scrollLeft || 0) > 0) return;
    from = {x: touch.clientX, y: touch.clientY};
    began = Date.now();
  }, {passive: true});
  screen.addEventListener('touchmove', event => {
    const touch = event.touches && event.touches[0];
    if (!from || !touch) return;
    const dx = touch.clientX - from.x, dy = touch.clientY - from.y;
    if (!axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dy) >= Math.abs(dx)) { from = null; return; }   // a scroll, and it stays one
      axis = 'x';
      screen.classList.add('dragging');
      closeFloat();
    }
    move(Math.max(0, dx));
  }, {passive: true});
  const end = () => {
    const moved = at;
    /* Either taken far enough to mean it, or thrown off fast enough: a flick that covers only a
       third of the screen is still unmistakably a flick. */
    const quick = moved > 40 && moved / Math.max(16, Date.now() - began) > BACK_FLICK;
    const far = Math.max(70, (window.innerWidth || 390) * BACK_FAR);
    const go = axis === 'x' && (moved > far || quick);
    from = null; axis = ''; at = 0;
    screen.classList.remove('dragging');
    if (!go) { screen.style.transform = ''; return; }
    // Off the edge first, and only then is the history walked back: a screen that vanished
    // mid-gesture would look like a crash rather than a way out.
    screen.style.transform = 'translateX(100%)';
    setTimeout(() => { screen.style.transform = ''; closeSheet(id); }, BACK_OUT);
  };
  screen.addEventListener('touchend', end, {passive: true});
  screen.addEventListener('touchcancel', () => { from = null; axis = ''; at = 0; screen.classList.remove('dragging'); screen.style.transform = ''; }, {passive: true});
}

/* ---------- the sliding pill ---------- */
function slide(track) {
  const chosen = track.querySelector('[aria-pressed="true"]');
  let pill = track.querySelector(':scope > .ind');
  if (!pill) { pill = el('span', {class: 'ind', 'aria-hidden': 'true'}); track.insertBefore(pill, track.firstChild); }
  const box = track.getBoundingClientRect(), mark = chosen?.getBoundingClientRect();
  if (!chosen || !mark?.width || !box.width) { track.removeAttribute('data-ind'); pill.hidden = true; return; }
  pill.hidden = false;
  track.style.setProperty('--ind-w', `${Math.round(mark.width)}px`);
  track.style.setProperty('--ind-x', `${Math.round(mark.left - box.left)}px`);
  track.setAttribute('data-ind', 'on');
}

function buildFilters() {
  const track = $('filters');
  track.textContent = '';
  el('span', {class: 'ind', 'aria-hidden': 'true'}, track);
  for (const [id, label] of STATUSES) {
    const button = el('button', {type: 'button', 'aria-pressed': String(state.status === id), text: label}, track);
    button.addEventListener('click', () => {
      state.status = id;
      for (const other of track.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button));
      slide(track);
      showing();
    });
  }
  requestAnimationFrame(() => slide(track));
}

/* ---------- the list ---------- */
const seenAt = key => Number(localStorage.getItem(KEYS.seen + key)) || 0;
const visible = () => sortRows(filterRows(state.items, {
  collections: familyOf(state.collections, state.collection),
  status: state.status, tag: state.tag, q: state.q, statusOf
}), state.sort, {seenAt});

function stars(n) { return n ? '★'.repeat(n) + '☆'.repeat(5 - n) : ''; }
const STATUS_WORD = {unread: '안 읽음', reading: '읽는 중', done: '완료'};
/* The seven colours a paper can be marked with on the Mac, named for the reader. Green is 녹색
   rather than the plugin's 초록, because 초록 is already the word this app uses for an abstract. */
const MARK_WORD = {
  red: () => t('빨강'), orange: () => t('주황'), gold: () => t('노랑'), green: () => t('녹색'),
  teal: () => t('청록'), blue: () => t('파랑'), purple: () => t('보라')
};

/* What is being looked at, and the order it is in — always on screen, so a library that seems
   to be missing papers says why. */
function paintScope(total) {
  const bar = $('scope');
  bar.textContent = '';
  if (state.collection) {
    const name = state.collections.find(c => c.key === state.collection)?.data?.name || '컬렉션';
    const chip = el('button', {class: 'scope-chip', type: 'button', 'aria-label': `${name} 해제`}, bar);
    el('span', {text: name}, chip);
    el('span', {class: 'x', text: '×'}, chip);
    chip.addEventListener('click', () => { state.collection = ''; showing(); });
  }
  if (state.tag) {
    const chip = el('button', {class: 'scope-chip', type: 'button', 'aria-label': `${state.tag} 해제`}, bar);
    el('span', {text: '#' + state.tag}, chip);
    el('span', {class: 'x', text: '×'}, chip);
    chip.addEventListener('click', () => { state.tag = ''; showing(); });
  }
  // Nothing to say about what is being looked at is itself worth a row of the screen.
  bar.hidden = !bar.firstChild;
  void total;
}

/* The order the library is in: a menu under the button that opens it, with a tick against the one
   it is in now, rather than a row of its own taken up for ever by a thing changed once a week. */
function openSortMenu() {
  floatMenu($('btn-sort'), SORTS.map(([id, label]) => ({id, label, run: () => {
    state.sort = id;
    localStorage.setItem(KEYS.sort, id);
    showing();
  }})), {chosen: state.sort});
}

/* Holding a finger on a row is how this phone asks for the things that are not worth a screen of
   their own, and the press is given up the moment the finger moves, so a scroll is never a hold.
   Both of the library's row gestures are listened for in wireRows below. */
export const HOLD = 480;

/* Pushed aside, a paper is marked: left is 완료, right is 안 읽음, and a paper already marked that
   way is cleared, so the same swipe undoes itself. What the release will do is drawn behind the
   row while the finger is still on it, because a gesture that commits something unseen is one
   nobody dares use twice. */
export const SWIPE = 72;
const SWIPE_PLAN = (status, way) => way === 'left'
  ? (status === 'done' ? {id: '', label: '표시 없음', tone: 'clear'} : {id: 'done', label: '완료', tone: 'done'})
  : (status === 'unread' ? {id: '', label: '표시 없음', tone: 'clear'} : {id: 'unread', label: '안 읽음', tone: 'unread'});
const SWIPE_MARK = {
  done: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4 4 10-10"/></svg>',
  unread: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/></svg>',
  clear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
};
/* Past the threshold the row stops following the finger one pixel for one, so the end of the
   gesture is felt rather than guessed at. */
const resist = moved => Math.sign(moved) * (Math.abs(moved) <= SWIPE ? Math.abs(moved) : SWIPE + (Math.abs(moved) - SWIPE) * 0.35);

/* A held finger, on a list that has no swiping to share the touch stream with. The library's own
   rows are in wireRows below, where the same press has to be told apart from a push aside. */
function holdWithin(node, find, run) {
  let timer = null, from = null, on = null, answered = 0;
  const give = () => { if (timer) clearTimeout(timer); timer = null; };
  node.addEventListener('touchstart', event => {
    give();
    const touch = event.touches && event.touches[0];
    on = find(event);
    if (!touch || event.touches.length !== 1 || !on) { on = null; return; }
    from = {x: touch.clientX, y: touch.clientY};
    timer = setTimeout(() => { timer = null; answered = Date.now(); run(on); }, HOLD);
  }, {passive: true});
  node.addEventListener('touchmove', event => {
    const touch = event.touches && event.touches[0];
    if (!from || !touch) return;
    if (Math.abs(touch.clientX - from.x) > 10 || Math.abs(touch.clientY - from.y) > 10) give();
  }, {passive: true});
  node.addEventListener('touchend', give, {passive: true});
  node.addEventListener('touchcancel', give, {passive: true});
  node.addEventListener('contextmenu', event => {
    const found = find(event);
    if (!found) return;
    event.preventDefault();
    answered = Date.now();
    run(found);
  });
  return () => Date.now() - answered < 700;
}

/* ---------- picking several papers at once ---------- */
/* One paper at a time is a swipe; a shelf of them is this. Begun from a paper's own menu, as it
   is on this phone — the bar at the top counts what has been picked and holds the way out, and
   the bar at the bottom holds what can be done to them. */
const PICK_MARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';
function setPicking(on, first = '') {
  state.picking = !!on;
  state.picked = new Set(on && first ? [first] : []);
  const main = $('main');
  if (main) main.classList.toggle('picking', state.picking);
  render({keep: true});
  paintPicked();
}
function paintPicked() {
  const on = state.picking, n = state.picked.size;
  for (const id of ['btn-sort', 'btn-sync']) { const node = $(id); if (node) node.hidden = on; }
  const done = $('btn-picked');
  if (done) done.hidden = !on;
  const bar = $('pickbar');
  if (bar) bar.hidden = !on;
  const tabs = $('statusbar');
  if (tabs) tabs.hidden = on;
  const all = $('pick-all');
  if (all) all.textContent = n && n >= (render.rows || []).length ? '해제' : '모두';
  for (const id of ['pick-mark', 'pick-rate']) { const node = $(id); if (node) node.disabled = !n; }
  if (!on) return;
  const count = $('count');
  if (count) count.textContent = n ? T('{0}편 선택', n.toLocaleString()) : t('선택');
}
/* Marked one after another rather than all at once: each write is its own intention against the
   paper as it stands on the server, which is what keeps a change made on the Mac meanwhile. */
async function applyPicked(what, value, said) {
  const keys = [...state.picked];
  if (!keys.length) return;
  // What each of them was, so the whole shelf can be put back the way it was.
  const was = new Map();
  for (const key of keys) {
    const item = liveItem(key);
    if (item) was.set(key, what === 'status' ? statusOf(item) : ratingOf(item));
  }
  const done = await applyMany(what, value, keys);
  setPicking(false);
  toast(T('{0}편을 {1}', done.toLocaleString(), said), {undo: async () => {
    let back = 0;
    for (const [key, before] of was) back += await applyMany(what, before, [key]);
    toast(T('{0}편을 되돌렸습니다', back.toLocaleString()));
  }});
}
async function applyMany(what, value, keys) {
  let done = 0;
  for (const key of keys) {
    const item = liveItem(key);
    if (!item) continue;
    try { await (what === 'status' ? setStatus(item, value) : setRating(item, value)); done++; }
    catch (error) { toast(error.message); break; }
  }
  if (done) render({keep: true});
  return done;
}
function pickMarkMenu() {
  floatMenu($('pick-mark'), [
    {id: 'x-unread', label: '안 읽음', run: () => applyPicked('status', 'unread', '안 읽음으로 표시했습니다')},
    {id: 'x-reading', label: '읽는 중', run: () => applyPicked('status', 'reading', '읽는 중으로 표시했습니다')},
    {id: 'x-done', label: '완료', run: () => applyPicked('status', 'done', '완료로 표시했습니다')},
    {id: 'x-none', label: '표시 없음', run: () => applyPicked('status', '', '표시를 지웠습니다')}
  ]);
}
function pickRateMenu() {
  floatMenu($('pick-rate'), [5, 4, 3, 2, 1].map(n => ({
    id: `x-${n}`, label: '★'.repeat(n), run: () => applyPicked('rating', n, `${n}점을 주었습니다`)
  })).concat([{id: 'x-0', label: '별점 없음', run: () => applyPicked('rating', 0, '별점을 지웠습니다')}]));
}

/* ---------- what a row answers to ---------- */
/* Every paper answers to the same two gestures, so the library listens for them once, on itself,
   rather than seven times over on every row. A library scrolled to the end of a few thousand
   papers would otherwise be carrying tens of thousands of listeners, and each row would cost
   more to draw than it costs to show. */
function wireRows(list) {
  let row = null, key = '', from = null, axis = '', at = 0, plan = null, timer = null;
  /* When a gesture last answered for a row. The tap that ends a hold or a swipe must not also
     open the paper, and a moment rather than a flag is what says so: a right-click on a desktop
     ends in no tap at all, and a flag left standing would swallow the next real one. */
  let answered = 0;
  const RECENT = 700;
  const paper = () => liveItem(key);
  const slide = x => {
    at = x;
    const face = row && row.querySelector('.face');
    if (face) face.style.transform = x ? `translateX(${Math.round(x)}px)` : '';
  };
  const paint = way => {
    const act = row && row.querySelector('.act');
    plan = way && row ? SWIPE_PLAN(statusOf(paper() || {data: {}}), way) : null;
    if (!act) return;
    act.className = plan ? `act on ${plan.tone} ${way}` : 'act';
    act.textContent = '';
    if (!plan) return;
    el('span', {class: 'mark', html: SWIPE_MARK[plan.tone]}, act);
    el('span', {text: plan.label}, act);
  };
  const give = () => { if (timer) clearTimeout(timer); timer = null; };
  const rowAt = event => {
    const on = event.target;
    return on && typeof on.closest === 'function' ? on.closest('.row.paper') : null;
  };
  /* Held down: everything a paper can be done to from here, without opening it and coming back
     out of it — the two screens it leads to, the two things worth copying, and the marks. */
  const askStatus = () => {
    const item = paper();
    if (!row || !item || state.picking) return;
    learned();
    const marks = [
      {id: 'unread', label: '안 읽음'}, {id: 'reading', label: '읽는 중'},
      {id: 'done', label: '완료'}, {id: '', label: '표시 없음'}
    ].map(choice => ({...choice, run: async () => {
      try { await mark(paper() || item, choice.id, choice.label); }
      catch (error) { toast(error.message); }
    }}));
    floatMenu(row, [
      {label: '본문 듣기', icon: ICON.listen, run: () => openListen(paper() || item)},
      {label: 'PDF 보기', icon: ICON.pdf, run: () => openPaper(paper() || item)},
      {label: '인용 복사', icon: ICON.cite, run: () => copyCitation(paper() || item)},
      {label: '공유', icon: ICON.share, run: () => shareItem(paper() || item)},
      {sep: true},
      ...marks,
      {sep: true},
      {label: '여러 개 선택', icon: ICON.pick, run: () => setPicking(true, item.key)}
    ], {chosen: statusOf(item), lift: row});
  };
  const mark = async (item, id, label) => {
    const was = statusOf(item);
    await setStatus(item, id);
    render({keep: true});
    toast(id ? `${label}으로 표시` : '표시를 지웠습니다', was === id ? {} : {undo: async () => {
      const live = liveItem(item.key) || item;
      await setStatus(live, was);
      render({keep: true});
      toast(was ? `${STATUS_WORD[was]}으로 되돌렸습니다` : '표시를 지운 것을 되돌렸습니다');
    }});
  };

  list.addEventListener('touchstart', event => {
    give();
    row = null; key = ''; from = null; axis = ''; at = 0; plan = null;
    const touch = event.touches && event.touches[0];
    const on = rowAt(event);
    if (!touch || event.touches.length !== 1 || !on) return;
    row = on;
    key = on.getAttribute('data-key') || '';
    if (!paper()) { row = null; return; }
    from = {x: touch.clientX, y: touch.clientY};
    timer = setTimeout(() => { timer = null; answered = Date.now(); askStatus(); }, HOLD);
  }, {passive: true});

  list.addEventListener('touchmove', event => {
    const touch = event.touches && event.touches[0];
    if (!row || !from || !touch) return;
    const dx = touch.clientX - from.x, dy = touch.clientY - from.y;
    /* The first ten pixels decide what the gesture is. A scroll must never drag a row sideways,
       a swipe must never be read as a scroll halfway through, and a finger that has moved at all
       is no longer a finger held still. */
    if (!axis) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      give();
      // While a shelf is being picked, a finger across a row is not a mark: the taps mean
      // something else entirely, and marking one of them under the others would be a surprise.
      axis = !state.picking && Math.abs(dx) > Math.abs(dy) * 1.3 ? 'x' : 'y';
      if (axis === 'x') { row.classList.add('swiping'); closeFloat(); }
    }
    if (axis !== 'x') return;
    slide(resist(dx));
    paint(dx < -10 ? 'left' : dx > 10 ? 'right' : '');
  }, {passive: true});

  const end = async () => {
    give();
    if (!row) return;
    const go = axis === 'x' && plan && Math.abs(at) > SWIPE;
    const what = plan, item = paper();
    row.classList.remove('swiping');
    slide(0);
    paint('');
    from = null; axis = '';
    if (!go || !item) return;
    answered = Date.now();         // the finger lifting off is not a tap on the paper
    learned();
    try { await mark(item, what.id, what.label); }
    catch (error) { toast(error.message); }
  };
  list.addEventListener('touchend', end, {passive: true});
  list.addEventListener('touchcancel', () => {
    give();
    if (!row) return;
    row.classList.remove('swiping');
    slide(0); paint('');
    from = null; axis = '';
  }, {passive: true});
  // A mouse has its own way of asking the same question.
  list.addEventListener('contextmenu', event => {
    const on = rowAt(event);
    if (!on) return;
    event.preventDefault();
    row = on; key = on.getAttribute('data-key') || '';
    answered = Date.now();
    askStatus();
  });

  const toggle = on => {
    const id = on.getAttribute('data-key') || '';
    if (state.picked.has(id)) state.picked.delete(id); else state.picked.add(id);
    const chosen = state.picked.has(id);
    on.setAttribute('aria-pressed', String(chosen));
    const spot = on.querySelector('.pick-mark');
    if (spot) { spot.className = `pick-mark${chosen ? ' on' : ''}`; spot.innerHTML = chosen ? PICK_MARK : ''; }
    paintPicked();
  };
  list.addEventListener('click', event => {
    const on = rowAt(event);
    if (!on) return;
    if (Date.now() - answered < RECENT) { answered = 0; return; }
    // While several are being picked, a tap picks rather than opens.
    if (state.picking) { toggle(on); return; }
    // Remembered so going back lands on the same row, not at the top of a freshly drawn list.
    state.at = list.scrollTop;
    state.drawn = state.shown;
    openDetail(on.getAttribute('data-key') || '');
  });
}

/* What was searched for, shown where it was found. The folding is done one character at a time,
   so an index into the folded text still points at a character of the original: an accent folds
   away to nothing and the Turkish dotted I folds into two, so one-for-one cannot be assumed. */
export function markTerms(parent, text, terms) {
  const whole = String(text ?? '');
  const plain = () => { parent.appendChild(document.createTextNode(whole)); return parent; };
  if (!terms || !terms.length || !whole) return plain();
  let folded = '';
  const at = [];
  for (let i = 0; i < whole.length; i++) {
    const piece = fold(whole[i]);
    for (let n = 0; n < piece.length; n++) at.push(i);
    folded += piece;
  }
  at.push(whole.length);
  const hits = [];
  for (const term of terms) {
    let from = 0, found;
    while (hits.length < 40 && (found = folded.indexOf(term, from)) >= 0) {
      hits.push([at[found], at[found + term.length]]);
      from = found + term.length;
    }
  }
  if (!hits.length) return plain();
  hits.sort((a, b) => a[0] - b[0]);
  // Two words that overlap in the text are one mark, not two nested ones.
  const runs = [];
  for (const [start, end] of hits) {
    const last = runs[runs.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else runs.push([start, end]);
  }
  let cut = 0;
  for (const [start, end] of runs) {
    if (start > cut) parent.appendChild(document.createTextNode(whole.slice(cut, start)));
    el('b', {text: whole.slice(start, end)}, parent);
    cut = end;
  }
  if (cut < whole.length) parent.appendChild(document.createTextNode(whole.slice(cut)));
  return parent;
}

/* One row. Kept apart so more of them can be added as the list is scrolled without redrawing
   what is already there. It carries no listeners of its own: the library above answers for it. */
function drawRow(item, list) {
  const row = el('button', {class: 'row paper', type: 'button', 'data-key': item.key}, list);
  // Behind the row: what pushing it aside would do. Drawn first so the face covers it.
  el('span', {class: 'act', 'aria-hidden': 'true'}, row);
  const face = el('span', {class: 'face'}, row);
  // The status is a mark in the margin beside the title: a labelled chip for it cost every row a
  // line of its own, and most of a library has no status at all.
  const status = statusOf(item);
  if (status) el('span', {class: `flag ${status}`, 'aria-label': STATUS_WORD[status]}, face);
  if (state.picking) {
    const chosen = state.picked.has(item.key);
    row.setAttribute('aria-pressed', String(chosen));
    el('span', {class: `pick-mark${chosen ? ' on' : ''}`, html: chosen ? PICK_MARK : ''}, face);
  }
  const terms = render.terms || [];
  const fact = factsFor(item.key);
  markTerms(el('h2', {}, face), clean(item.data.title) || '(제목 없음)', terms);
  const meta = el('p', {class: 'meta'}, face);
  const who = [authorsOf(item), yearOf(item)].filter(Boolean).join(' · ');
  if (who) markTerms(el('span', {}, meta), who, terms);
  /* The journal's name in the ink the Mac paints it in — the one treatment the library cards there
     and these rows now share, so a paper is recognised by its journal before it is read. A journal
     whose masthead has no colour of its own keeps the plain meta ink rather than a meaningless grey. */
  const venue = venueOf(item) || (fact && fact.venue) || '';
  if (venue) {
    if (who) meta.appendChild(document.createTextNode(' · '));
    /* Zotero may hold the journal's abbreviated name ("Nat Rev Microbiol") where the Mac's file is
       keyed by the full one, so the colour is looked up under both. The name on the row stays the
       one this library keeps; only the ink comes from the other spelling. */
    const ink = inkFor(facts, venue) || (fact && fact.venue !== venue ? inkFor(facts, fact.venue) : null);
    const named = el('span', {class: 'venue'}, meta);
    if (ink) {
      named.classList.add('ink');
      named.style.setProperty('--j-ink', ink.ink);
      named.style.setProperty('--j-ink-d', ink.dark);
    }
    markTerms(named, venue, terms);
  }
  const rating = ratingOf(item);
  const tag = (item.data.tags || []).find(t => !TAG_STATUS[t.tag] && !/^style-custom:/.test(t.tag));
  // How far it got, by either road: the voice through the sentences or a finger through the pages.
  const heard = progressOf(item.key);
  const part = heard > 1 && heard < 99;
  const mark = markOf(fact);
  /* Whether the Mac has already read this one aloud. It is the thing a reader picks a paper by
     when the next hour is spent driving, and it was invisible until the paper was opened. */
  const voiced = hasBaked(item.data.title);
  // The third line is only drawn for a paper that has something to say on it.
  if (rating || tag || part || fact || voiced) {
    const foot = el('div', {class: 'foot'}, face);
    /* A paper marked by hand on the Mac wears that colour here as a dot — never as a bar down the
       edge of the row, which on a rounded card reads as a painted fingernail. */
    if (mark) {
      const colour = T('{0} 표시', MARK_WORD[mark]());
      el('span', {class: 'mark', 'data-mark': mark, title: colour, 'aria-label': colour}, foot);
    }
    if (fact && fact.jif) {
      const band = bandOf(fact.jif);
      el('span', {class: 'jif', 'data-band': band, text: fact.jif >= 10 ? String(Math.round(fact.jif)) : fact.jif.toFixed(1),
                  title: T('{0}의 임팩트 팩터', fact.venue || venueOf(item) || '')}, foot);
    }
    if (voiced) el('span', {class: 'voiced', title: '맥 음성 있음', 'aria-label': '맥 음성 있음',
                            html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><path d="M4 14h2.5v5H5.5A1.5 1.5 0 0 1 4 17.5zM20 14h-2.5v5h1A1.5 1.5 0 0 0 20 17.5z"/></svg>'}, foot);
    if (fact && fact.cited) el('span', {class: 'muted small', text: T('인용 {0}', fact.cited.toLocaleString())}, foot);
    if (fact && fact.from && fact.from.length) {
      const flags = fact.from.map(flagOf).filter(Boolean).join('');
      if (flags) el('span', {class: 'from', text: flags, title: fact.from.join(' · ')}, foot);
    }
    if (rating) el('span', {class: 'stars', text: stars(rating)}, foot);
    if (tag) el('span', {class: 'chip', text: clean(tag.tag).slice(0, 18)}, foot);
    if (part) {
      /* The share is whichever road got furthest, so what it is called follows: the voice through
         the sentences says 들음, a finger or the Mac's reader through the pages says 읽음. */
      const voice = Number(localStorage.getItem(KEYS.pct + item.key)) || 0;
      const said = voice >= heard ? T('{0}% 들음', heard) : T('{0}% 읽음', heard);
      const bar = el('span', {class: 'heard', 'aria-label': said}, foot);
      el('i', {style: `width:${Math.min(100, heard)}%`}, bar);
      el('span', {class: 'muted', text: `${heard}%`, title: macRead(fact) || said}, foot);
    }
  }
  return row;
}

/* A gesture nobody knows about is a gesture nobody has. The two the library answers to are said
   once, at the top of it, and the line takes itself off for good the moment either one is used —
   so it is a thing you are told until you know it, not a thing you have to dismiss. */
const taught = () => localStorage.getItem(KEYS.tip) === 'off';
function learned() {
  if (taught()) return;
  localStorage.setItem(KEYS.tip, 'off');
  const line = $('list').querySelector('.tip');
  if (line) line.remove();
}
function drawTip(list) {
  if (taught() || state.items.length < 5 || state.q || state.picking) return null;
  const line = el('div', {class: 'tip'}, list);
  el('span', {text: '옆으로 밀면 완료 · 안 읽음, 꾹 누르면 듣기 · 보기 · 선택'}, line);
  const off = el('button', {class: 'x', type: 'button', 'aria-label': '안내 닫기', text: '×'}, line);
  off.addEventListener('click', () => { localStorage.setItem(KEYS.tip, 'off'); line.remove(); });
  return line;
}

/* A paper left half heard is the thing most likely to be wanted next, so the library offers it
   back rather than making it be found again. Only on the library itself: under a search or a
   filter, a paper that is not in what is being looked at has no business at the top of it. */
/* How far through a paper someone got, whichever road they took: the share of the sentences the
   voice has said, or the share of the pages a finger has turned, whichever is further on. */
export function shareOf({heard = 0, page = 0, pages = 0, read = 0} = {}) {
  const turned = page > 1 && pages > 1 ? Math.round(page / pages * 100) : 0;
  // What the Mac's own reader got through, which for most of a library is the only record there is.
  const mac = read > 0 ? Math.min(100, Math.round(read)) : 0;
  return Math.max(heard, turned, mac);
}
const progressOf = key => shareOf({
  heard: Number(localStorage.getItem(KEYS.pct + key)) || 0,
  page: Number(localStorage.getItem(KEYS.page + key)) || 0,
  pages: Number(localStorage.getItem(KEYS.of + key)) || 0,
  read: Number((factsFor(key) || {}).read) || 0
});

/* What the Mac recorded, as one line: how far through it got, how long it was read for, and when
   that was. Said as the Mac's own record, because this phone did not measure any of it. */
export function macRead(fact, {now = new Date()} = {}) {
  if (!fact) return '';
  const parts = [];
  if (fact.page > 0 && fact.pages > 0) parts.push(T('{1}쪽 중 {0}쪽까지', fact.page, fact.pages));
  else if (fact.page > 0) parts.push(T('{0}쪽까지', fact.page));
  else if (fact.read > 0) parts.push(`${Math.round(fact.read)}%`);
  if (fact.seconds >= 60) parts.push(T('{0}분 읽음', Math.round(fact.seconds / 60)));
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(fact.at || ''))) parts.push(dayAgo(fact.at, now));
  return parts.length ? T('맥에서 {0}', parts.join(' · ')) : '';
}

/* A date as a reader thinks of it: today, yesterday, so many days ago, and a plain date once it is
   far enough back that counting the days says nothing. */
export function dayAgo(day, now = new Date()) {
  const then = new Date(`${day}T00:00:00`);
  if (Number.isNaN(then.getTime())) return '';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((today - then) / 86400000);
  if (days <= 0) return T('오늘');
  if (days === 1) return T('어제');
  if (days < 30) return T('{0}일 전', days);
  return T('{0}월 {1}일', then.getMonth() + 1, then.getDate());
}

/* Whichever of the two a paper was last left in the middle of — the voice or the page — because
   a reader coming back to a library wants the thing they were doing, not a choice about it. */
export function resumeOf({key, kind, heard, page, pages}) {
  if (!key) return null;
  if (kind === 'read') {
    if (!(page > 1)) return null;
    const pct = pages > 1 ? Math.round(page / pages * 100) : 0;
    if (pct > 98) return null;
    return {kind: 'read', said: T('이어 읽기 · {0}쪽', page), label: '이어 읽기', pct};
  }
  if (!(heard >= 1 && heard <= 98)) return null;
  return {kind: 'listen', said: T('이어 듣기 · {0}%', heard), label: '이어 듣기', pct: heard};
}
const RESUME_MARK = {
  listen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>',
  read: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v13H7z" fill="none" stroke="currentColor"/><path d="M14 3v5h5" fill="none" stroke="currentColor"/></svg>'
};
function drawResume(list) {
  const key = localStorage.getItem(KEYS.last) || '';
  if (!key || state.q || state.collection || state.tag || state.status || state.picking) return null;
  const item = state.items.find(paper => paper.key === key);
  if (!item) return null;
  const on = resumeOf({
    key,
    kind: localStorage.getItem(KEYS.kind) || 'listen',
    heard: Number(localStorage.getItem(KEYS.pct + key)) || 0,
    page: Number(localStorage.getItem(KEYS.page + key)) || 0,
    pages: Number(localStorage.getItem(KEYS.of + key)) || 0
  });
  if (!on) return null;
  const card = el('section', {class: 'resume'}, list);
  const go = el('button', {type: 'button', 'aria-label': `${clean(item.data.title)} ${on.label}`}, card);
  el('span', {class: `go ${on.kind}`, html: RESUME_MARK[on.kind]}, go);
  const what = el('span', {class: 'what'}, go);
  el('b', {text: clean(item.data.title) || '(제목 없음)'}, what);
  el('span', {text: on.said}, what);
  if (on.pct) {
    const bar = el('span', {class: 'heard'}, go);
    el('i', {style: `width:${Math.min(100, on.pct)}%`}, bar);
  }
  go.addEventListener('click', () => {
    const live = liveItem(key) || item;
    if (on.kind === 'read') openPaper(live); else openListen(live);
  });
  return card;
}

/* ---------- what has been searched for before ---------- */
/* A box that remembers is the difference between searching twice and searching once. Kept short,
   newest first, and only what was typed with intent — two letters is a keystroke, not a search. */
export const RECENTS = 6;
function recentList() {
  try {
    const held = JSON.parse(localStorage.getItem(KEYS.recent) || '[]');
    return Array.isArray(held) ? held.filter(text => typeof text === 'string').slice(0, RECENTS) : [];
  } catch (_) { return []; }
}
function remember(text) {
  const word = clean(text);
  if (word.length < 2) return;
  const kept = [word, ...recentList().filter(other => other !== word)].slice(0, RECENTS);
  try { localStorage.setItem(KEYS.recent, JSON.stringify(kept)); } catch (_) {}
}
function forget(text) {
  const kept = recentList().filter(other => other !== text);
  try { localStorage.setItem(KEYS.recent, JSON.stringify(kept)); } catch (_) {}
  drawRecent();
}
/* Shown over the library while the box is open and empty, as this phone's own search does. */
function drawRecent() {
  const panel = $('recent');
  if (!panel) return;
  const words = recentList();
  const open = document.activeElement === $('q') && !clean(state.q) && words.length > 0;
  panel.hidden = !open;
  const list = $('list');
  if (list) list.hidden = open;
  if (!open) { panel.textContent = ''; return; }
  panel.textContent = '';
  el('h3', {class: 'group', text: '최근 검색'}, panel);
  for (const word of words) {
    const row = el('div', {class: 'row paper recent-row'}, panel);
    const face = el('button', {class: 'face', type: 'button'}, row);
    el('span', {class: 'ago', html: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>'}, face);
    el('h2', {text: word}, face);
    face.addEventListener('click', () => {
      $('q').value = word;
      state.q = word;
      drawRecent();
      showing();
    });
    const off = el('button', {class: 'x', type: 'button', 'aria-label': `${word} 지우기`, text: '×'}, row);
    off.addEventListener('click', () => forget(word));
  }
}

/* How many papers are being looked at, said out loud once the drawing has settled. A live region
   over the list itself would read a thousand papers out every time one of them was marked; what a
   reader who cannot see the list needs is the number. */
let sayTimer = null, saidLast = -1;
function sayCount(n) {
  const node = $('said');
  if (!node) return;
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => {
    if (n === saidLast) return;
    saidLast = n;
    node.textContent = n ? T('{0}편', n.toLocaleString()) : t('해당하는 논문이 없습니다');
  }, 400);
}

/* What is being looked at has changed, so the list starts again from the top: three hundred
   papers down one list is nowhere in particular in another. */
function showing() {
  state.shown = 0;
  const list = $('list');
  if (list) list.scrollTop = 0;
  render();
}

/* Whatever narrowed the library down to nothing is also the way back out of it. */
function clearNarrowing() {
  state.q = ''; state.collection = ''; state.tag = ''; state.status = '';
  const box = $('q');
  if (box) box.value = '';
  buildFilters();
  showing();
}

/* The list is drawn a screenful at a time. Everything that matches is counted and reachable; what
   is on screen is only what has been scrolled to, so a library of thousands opens at once. */
let more = null;
function drawMore() {
  const list = $('list');
  const rows = render.rows || [];
  const from = state.shown, to = Math.min(rows.length, from + PAGE);
  if (from >= to) return;
  const batch = document.createDocumentFragment();
  for (let i = from; i < to; i++) {
    // The heading is drawn where the list changes, whichever order it is in, and says how many
    // are under it — which is the one thing a heading can say that the rows cannot.
    const under = groupOf(rows[i], state.sort, {seenAt});
    if (under && under !== render.group) {
      render.group = under;
      const head = el('h3', {class: 'group'}, batch);
      el('span', {text: under}, head);
      const n = render.sizes ? render.sizes.get(under) : 0;
      if (n > 1) el('span', {class: 'n', text: T('{0}편', n.toLocaleString())}, head);
    }
    drawRow(rows[i], batch);
  }
  list.insertBefore(batch, more || null);
  state.shown = to;
  if (more && state.shown >= rows.length) { more.remove(); more = null; }
}

/* How many papers fall under each heading, counted once for the whole list rather than guessed
   at as the rows are drawn — the rows arrive a screenful at a time and a heading is drawn before
   the ones under it exist. */
function countGroups(rows) {
  const sizes = new Map();
  for (const item of rows) {
    const name = groupOf(item, state.sort, {seenAt});
    if (name) sizes.set(name, (sizes.get(name) || 0) + 1);
  }
  return sizes;
}

/* ---------- the landmarks down the right edge ---------- */
export const RAIL_MIN = 40, RAIL_MARKS = 6, RAIL_MAX = 24;
/* Where each heading begins, and the one or two characters that stand for it. An order whose
   headings have no short form, a list too short to get lost in, or too few landmarks to aim a
   finger at, gets no rail at all. */
function railMarks(rows) {
  const marks = [];
  let last = '';
  for (let i = 0; i < rows.length; i++) {
    const name = groupOf(rows[i], state.sort, {seenAt});
    if (!name || name === last) continue;
    last = name;
    const short = railLabel(name);
    if (!short) return [];
    marks.push({at: i, name, short});
  }
  if (rows.length < RAIL_MIN || marks.length < RAIL_MARKS) return [];
  /* More landmarks than there is room for: every nth one is drawn and the finger lands on the
     nearest of those, which is what a phone does with an alphabet too long for its screen. */
  const stride = Math.ceil(marks.length / RAIL_MAX);
  return stride < 2 ? marks : marks.filter((_, i) => i % stride === 0 || i === marks.length - 1);
}

function paintRail(marks) {
  const rail = $('rail');
  if (!rail) return;
  rail.textContent = '';
  rail.classList.remove('held');
  rail.hidden = !marks.length;
  railAt = marks;
  if (!marks.length) return;
  el('span', {class: 'now'}, rail);                 // what the finger is over, said in full
  for (const mark of marks) el('span', {class: 'step', text: mark.short}, rail);
}

/* Enough of the list is drawn to reach the landmark, and then the library is put at its heading. */
function jumpToRow(at) {
  const list = $('list');
  while (state.shown <= at + 2) { const before = state.shown; drawMore(); if (state.shown === before) break; }
  const row = list.querySelectorAll('.row.paper')[at];
  if (!row) return;
  const above = row.previousElementSibling;
  const mark = above && above.classList && above.classList.contains('group') ? above : row;
  try {
    const delta = mark.getBoundingClientRect().top - list.getBoundingClientRect().top;
    list.scrollTop = Math.max(0, (list.scrollTop || 0) + delta);
  } catch (_) {}
}

let railAt = [];
/* A finger laid on the rail is followed: the library goes to whatever landmark it is over, and
   nothing is committed, so sliding off it costs nothing. The place is taken from the rail's own
   height rather than each label's, so a rail that has been squeezed still aims true. */
function wireRail() {
  const rail = $('rail');
  if (!rail) return;
  let chosen = -1;
  const aim = y => {
    const steps = [...rail.querySelectorAll('.step')];
    if (!steps.length || !railAt.length) return;
    const box = rail.getBoundingClientRect();
    const part = box.height ? (y - box.top) / box.height : 0;
    const best = Math.max(0, Math.min(steps.length - 1, Math.floor(part * steps.length)));
    const now = rail.querySelector('.now');
    if (now && railAt[best]) {
      now.textContent = railAt[best].name;
      now.style.setProperty('--now', `${Math.round((best + 0.5) / steps.length * (box.height || 0))}px`);
    }
    steps.forEach((step, i) => step.classList.toggle('on', i === best));
    if (best === chosen) return;
    chosen = best;
    if (railAt[best]) jumpToRow(railAt[best].at);
  };
  const take = event => {
    const touch = event.touches && event.touches[0];
    if (rail.hidden) return;
    rail.classList.add('held');
    closeFloat();
    aim(touch ? touch.clientY : event.clientY || 0);
  };
  rail.addEventListener('touchstart', take, {passive: true});
  rail.addEventListener('touchmove', take, {passive: true});
  rail.addEventListener('click', take);
  const drop = () => {
    rail.classList.remove('held');
    chosen = -1;
    for (const step of rail.querySelectorAll('.step')) step.classList.remove('on');
  };
  rail.addEventListener('touchend', drop, {passive: true});
  rail.addEventListener('touchcancel', drop, {passive: true});
}

function render({keep = false} = {}) {
  const list = $('list');
  /* Emptying the list puts the scroll back at the top, so a change made from a row three hundred
     papers down would throw the reader back to the first one. */
  const was = keep ? list.scrollTop || 0 : 0;
  const rows = visible();
  render.rows = rows;
  render.group = '';
  render.sizes = countGroups(rows);
  render.terms = words(state.q);        // so every row can show what matched
  list.textContent = '';
  more = null;
  if (!state.picking) $('count').textContent = rows.length ? T('{0}편', rows.length.toLocaleString()) : '';
  sayCount(rows.length);
  paintScope(rows.length);

  drawTip(list);
  drawResume(list);

  if (!rows.length) {
    if (!state.items.length && state.busy) {
      // The first sync of a few thousand papers takes a moment; an empty screen would look broken.
      for (let i = 0; i < 6; i++) {
        const ghost = el('div', {class: 'row ghost', 'aria-hidden': 'true'}, list);
        el('span', {class: 'line wide'}, ghost);
        el('span', {class: 'line'}, ghost);
      }
      el('p', {class: 'empty', text: '라이브러리를 처음 받는 중입니다…'}, list);
    } else {
      /* A dead end is a screen with nothing on it and nothing to press: whatever emptied the
         list is also the way out of it, so the way out is put here. */
      const narrowed = !!(state.q || state.collection || state.tag || state.status);
      const empty = el('div', {class: 'empty'}, list);
      el('span', {class: 'empty-mark', 'aria-hidden': 'true', html: narrowed
        ? '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h4l1.8 2H19a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 19 18H5.5A1.5 1.5 0 0 1 4 16.5z"/></svg>'}, empty);
      el('p', {text: narrowed
        ? (state.items.length ? '찾는 논문이 없습니다.' : '논문이 없습니다.')
        : '아직 받은 논문이 없습니다.'}, empty);
      if (narrowed) {
        const out = el('button', {class: 'pill', type: 'button', text: '검색과 필터 지우기'}, empty);
        out.addEventListener('click', clearNarrowing);
      } else {
        const again = el('button', {class: 'pill', type: 'button', text: '새로 고침'}, empty);
        again.addEventListener('click', () => sync());
      }
    }
    state.shown = 0;
    paintRail([]);
    return;
  }
  const want = keep ? Math.min(rows.length, Math.max(PAGE, state.shown)) : PAGE;
  state.shown = 0;
  // A sentinel at the end: when it comes into view there is more to draw.
  more = el('div', {class: 'more', 'aria-hidden': 'true'}, list);
  while (state.shown < want) { const before = state.shown; drawMore(); if (state.shown === before) break; }
  paintRail(railMarks(rows));
  if (was) { list.scrollTop = was; requestAnimationFrame(() => { list.scrollTop = was; }); }
  watchEnd();
}

let endWatch = null;
let listening = false;
function watchEnd() {
  if (!more) return;
  if (!endWatch && typeof IntersectionObserver === 'function') {
    endWatch = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) drawMore();
    }, {root: $('list'), rootMargin: '600px'});
  }
  if (endWatch) { try { endWatch.disconnect(); endWatch.observe(more); } catch (_) {} }
  else if (!listening) { listening = true; $('list').addEventListener('scroll', onListScroll, {passive: true}); }
}
/* Without an IntersectionObserver (and in the fake phone), the scroll position does the same job. */
function onListScroll() {
  const list = $('list');
  if (list.scrollTop + list.clientHeight > list.scrollHeight - 600) drawMore();
}

/* The reader's own marks, as something that can be pasted into what they are writing: the paper
   it came from at the top, then each mark with the page it is on. */
export function marksAsText(item, placed) {
  const lines = placed.map(({mark, place}) => {
    const page = place ? place.page : Number(mark.data.annotationPageLabel) || 0;
    const text = clean(mark.data.annotationText || '');
    const note = clean(mark.data.annotationComment || '');
    const body = [text && `“${text}”`, note && `— ${note}`].filter(Boolean).join(' ');
    return `${page ? `p.${page} ` : ''}${body || '(그림 주석)'}`;
  });
  return [citationOf(item), '', ...lines].join('\n');
}
async function copyMarks(item, placed) {
  try { await navigator.clipboard.writeText(marksAsText(item, placed)); toast(T('주석 {0}개를 복사했습니다', placed.length)); }
  catch (_) { toast('복사하지 못했습니다'); }
}

/* The two things worth taking out of a paper without opening it: the line that finds it again,
   and the link itself, through the phone's own share sheet where there is one. */
async function copyCitation(item) {
  try { await navigator.clipboard.writeText(citationOf(item)); toast('인용을 복사했습니다'); }
  catch (_) { toast('복사하지 못했습니다'); }
}
export function linkOf(item) {
  const doi = clean(item.data?.DOI);
  return doi ? `https://doi.org/${encodeURI(doi)}` : clean(item.data?.url);
}
async function shareItem(item) {
  const url = linkOf(item), title = clean(item.data?.title) || '논문';
  try {
    if (navigator.share) { await navigator.share(url ? {title, url} : {title, text: citationOf(item)}); return; }
  } catch (error) { if (error && error.name === 'AbortError') return; }
  // No share sheet: the line itself is the next best thing to hand over.
  try { await navigator.clipboard.writeText(url || citationOf(item)); toast('복사했습니다'); }
  catch (_) { toast('이 폰에서는 공유할 수 없습니다'); }
}

/* A line to paste into a mail or under a slide. Not a style anyone has standardised, just the
   five things a reader needs to find the paper again. */
/* The same paper as a reference manager wants it. Not a full BibTeX writer — a key, the fields
   Zotero actually holds, and braces around the title so a journal's capitals survive. */
const BIB_TYPE = {journalArticle: 'article', book: 'book', bookSection: 'incollection',
                  conferencePaper: 'inproceedings', thesis: 'phdthesis', report: 'techreport',
                  preprint: 'misc', webpage: 'misc'};
const bibSafe = text => clean(text).replace(/[{}\\]/g, '');
export function bibtexOf(item) {
  const data = item.data || {};
  const people = (data.creators || []).filter(c => c.creatorType === 'author' || c.creatorType === 'editor');
  const names = people.map(c => c.lastName ? `${bibSafe(c.lastName)}, ${bibSafe(c.firstName || '')}`.replace(/, $/, '')
                                           : bibSafe(c.name || '')).filter(Boolean);
  const year = yearOf(item);
  const first = clean(people[0] ? people[0].lastName || people[0].name || '' : '').toLowerCase().replace(/[^a-z]/g, '');
  const word = (clean(data.title).toLowerCase().match(/[a-z]{4,}/) || [''])[0];
  const key = [first || 'paper', year || '', word].filter(Boolean).join('');
  const fields = [
    ['author', names.join(' and ')],
    ['title', clean(data.title) ? `{${bibSafe(data.title)}}` : ''],
    ['journal', bibSafe(data.publicationTitle || '')],
    ['booktitle', bibSafe(data.bookTitle || data.proceedingsTitle || '')],
    ['publisher', bibSafe(data.publisher || '')],
    ['volume', bibSafe(data.volume || '')],
    ['number', bibSafe(data.issue || '')],
    ['pages', bibSafe(data.pages || '').replace(/\s*[-–—]+\s*/, '--')],
    ['year', year ? String(year) : ''],
    ['doi', clean(data.DOI)],
    ['url', clean(data.DOI) ? '' : clean(data.url)]
  ].filter(([, value]) => value);
  const lines = fields.map(([name, value]) => `  ${name} = {${value.replace(/^\{(.*)\}$/, '$1')}}`);
  const body = lines.length ? `,\n${lines.join(',\n')}` : '';
  return `@${BIB_TYPE[data.itemType] || 'misc'}{${key}${body}\n}`;
}

export function citationOf(item) {
  const data = item.data || {};
  const people = (data.creators || []).filter(c => c.creatorType === 'author');
  const names = people.map(c => clean(c.lastName || c.name || '')).filter(Boolean);
  const who = !names.length ? ''
    : names.length === 1 ? names[0]
    : names.length === 2 ? `${names[0]} & ${names[1]}`
    : `${names[0]} et al.`;
  const year = yearOf(item);
  const bits = [
    who && year ? `${who} (${year})` : who || (year ? `(${year})` : ''),
    clean(data.title),
    venueOf(item),
    clean(data.DOI) ? `https://doi.org/${clean(data.DOI)}` : clean(data.url)
  ].filter(Boolean);
  return bits.join('. ').replace(/\.\.$/, '.') + (bits.length ? '' : '');
}

/* ---------- one paper ---------- */
/* Going back puts the list where it was left, with as much of it drawn as there was. */
function leftDetail() {
  state.shown = Math.max(state.shown, state.drawn || 0);
  render({keep: true});
  requestAnimationFrame(() => { $('list').scrollTop = state.at || 0; });
}

async function openDetail(key) {
  const item = state.items.find(x => x.key === key);
  if (!item) return;
  localStorage.setItem(KEYS.seen + key, String(Date.now()));
  $('detail-title').textContent = clean(item.data.title) || '논문';
  const body = $('detail-body');
  body.textContent = '';
  openSheet('detail', leftDetail);
  body.scrollTop = 0;
  followScroll(body, $('detail').querySelector('.top'), {after: 112});

  /* The top of a paper is read like a title page — the name, who wrote it, where it came out —
     rather than as a form with a label against every line. */
  const head = el('section', {class: 'card hero'}, body);
  el('h2', {class: 'name', text: clean(item.data.title) || '(제목 없음)'}, head);
  const by = (item.data.creators || []).filter(c => c.creatorType === 'author')
    .map(c => clean(`${c.lastName || c.name || ''}${c.firstName ? `, ${c.firstName}` : ''}`)).filter(Boolean);
  if (by.length) el('p', {class: 'by', text: by.join(' · ')}, head);
  const where = [venueOf(item), yearOf(item)].filter(Boolean).join(' · ');
  if (where) el('p', {class: 'where', text: where}, head);
  const doi = clean(item.data.DOI), link = clean(item.data.url);
  if (doi) el('p', {class: 'doi', text: `doi:${doi}`}, head);
  const inside = (item.data.collections || [])
    .map(c => state.collections.find(x => x.key === c)?.data?.name)
    .filter(Boolean);
  if (inside.length) {
    const filed = el('div', {class: 'tags'}, head);
    for (const name of inside) el('span', {class: 'chip', text: name}, filed);
  }
  // Out to the publisher, for the things only the real page has, and the two kinds of copy.
  const out = el('div', {class: 'pills'}, head);
  if (doi || link) {
    const href = doi ? `https://doi.org/${encodeURI(doi)}` : link;
    el('a', {class: 'pill out', href, target: '_blank', rel: 'noopener', text: doi ? 'DOI 열기' : '원문 열기'}, out);
    const copy = el('button', {class: 'pill', type: 'button', text: '링크 복사'}, out);
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(href); toast('복사했습니다'); }
      catch (_) { toast('복사하지 못했습니다'); }
    });
  }
  const cite = el('button', {class: 'pill', type: 'button', text: '인용 복사'}, out);
  cite.addEventListener('click', () => copyCitation(item));
  // The same paper as a reference manager wants it, for the half of writing that is not reading.
  const bib = el('button', {class: 'pill', type: 'button', text: 'BibTeX'}, out);
  bib.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(bibtexOf(item)); toast('BibTeX를 복사했습니다'); }
    catch (_) { toast('복사하지 못했습니다'); }
  });

  // Listening to the paper: the text Zotero indexed, body only.
  const listenCard = el('section', {class: 'card'}, body);
  const listenButton = el('button', {type: 'button', class: 'listen-start'}, listenCard);
  el('span', {class: 'play-mark', html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>'}, listenButton);
  el('span', {text: Number(localStorage.getItem(KEYS.at + key)) > 0 ? '본문 이어 듣기' : '본문 듣기'}, listenButton);
  listenButton.addEventListener('click', () => openListen(state.items.find(x => x.key === key) || item));
  const paperButton = el('button', {type: 'button', class: 'paper-start'}, listenCard);
  el('span', {class: 'play-mark', html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 13h6M10 17h4"/></svg>'}, paperButton);
  el('span', {text: 'PDF 보기'}, paperButton);
  paperButton.addEventListener('click', () => openPaper(state.items.find(x => x.key === key) || item));

  // Status and rating: the same three tags and the same Rating line the desktop plugin reads.
  const statusCard = el('section', {class: 'card'}, body);
  el('h3', {text: '읽기'}, statusCard);
  const track = el('nav', {class: 'seg', role: 'group', 'aria-label': '상태'}, statusCard);
  el('span', {class: 'ind', 'aria-hidden': 'true'}, track);
  const current = () => statusOf(state.items.find(x => x.key === key) || item);
  for (const [id, label] of [['', '없음'], ['unread', '안 읽음'], ['reading', '읽는 중'], ['done', '완료']]) {
    const button = el('button', {type: 'button', 'aria-pressed': String(current() === id), text: label}, track);
    button.addEventListener('click', async () => {
      const live = state.items.find(x => x.key === key) || item;
      try {
        await setStatus(live, id);
        for (const other of track.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button));
        slide(track); render({keep: true}); toast('상태를 바꿨습니다');
      } catch (error) { toast(error.message); }
    });
  }
  requestAnimationFrame(() => slide(track));

  const rateRow = el('div', {class: 'rate-row'}, statusCard);
  el('span', {class: 'muted small', text: '별점'}, rateRow);
  const rate = el('div', {class: 'rate'}, rateRow);
  const paint = value => [...rate.children].forEach((b, i) => b.classList.toggle('on', i < value));
  for (let n = 1; n <= 5; n++) {
    const button = el('button', {type: 'button', 'aria-label': `${n}점`, text: '★'}, rate);
    button.addEventListener('click', async () => {
      const live = state.items.find(x => x.key === key) || item;
      const next = ratingOf(live) === n ? 0 : n;
      try { await setRating(live, next); paint(next); render({keep: true}); toast(next ? `${next}점` : '별점을 지웠습니다'); }
      catch (error) { toast(error.message); }
    });
  }
  paint(ratingOf(item));

  /* And how far it actually got, which is the other half of what "읽기" means. */
  const wasHeard = Number(localStorage.getItem(KEYS.pct + key)) || 0;
  const onPage = Number(localStorage.getItem(KEYS.page + key)) || 0;
  const ofPages = Number(localStorage.getItem(KEYS.of + key)) || 0;
  const sofar = [
    wasHeard > 1 ? `${wasHeard}% 들음` : '',
    onPage > 1 ? `${onPage}쪽까지 봄${ofPages > 1 ? ` (${ofPages}쪽 중)` : ''}` : ''
  ].filter(Boolean).join(' · ');
  if (sofar) el('p', {class: 'muted small', text: sofar}, statusCard);
  // And what the Mac's reader got through, which is the record for most of a library.
  const macSoFar = macRead(factsFor(key));
  if (macSoFar) el('p', {class: 'muted small', text: macSoFar}, statusCard);

  const abstract = clean(item.data.abstractNote);
  if (abstract) {
    const card = el('section', {class: 'card'}, body);
    el('h3', {text: '초록'}, card);
    const text = el('p', {class: 'note clipped', text: abstract}, card);
    // Long abstracts are folded away, so the things below them are reachable without a long scroll.
    if (abstract.length > 320) {
      const more = el('button', {class: 'link-btn', type: 'button', text: '더 보기'}, card);
      more.addEventListener('click', () => {
        const open = text.classList.toggle('clipped');
        more.textContent = open ? '더 보기' : '접기';
      });
    } else text.classList.remove('clipped');
  }

  const tags = (item.data.tags || []).filter(t => !TAG_STATUS[t.tag]);
  if (tags.length) {
    const card = el('section', {class: 'card'}, body);
    el('h3', {text: '태그'}, card);
    const wrap = el('div', {class: 'tags'}, card);
    for (const tag of tags) el('span', {class: 'chip', text: clean(tag.tag)}, wrap);
  }

  // Notes and annotations live as child items; they are fetched only when a paper is opened.
  const childCard = el('section', {class: 'card'}, body);
  el('h3', {text: '메모'}, childCard);
  const childBody = el('div', {class: 'notes'}, childCard);
  el('p', {class: 'muted small', text: '불러오는 중…'}, childBody);
  const noteBox = el('textarea', {class: 'note-box', rows: '3', placeholder: '새 메모'}, childCard);
  const saveRow = el('div', {class: 'actions'}, childCard);
  const save = el('button', {class: 'secondary', type: 'button', text: '메모 저장'}, saveRow);
  save.addEventListener('click', async () => {
    const text = noteBox.value;
    if (!clean(text)) return;
    save.disabled = true;
    try {
      const saved = await addNote(item, text);
      noteBox.value = '';
      if (saved) { toast('메모를 저장했습니다'); loadChildren(); }
    }
    catch (error) { toast(error.message); }
    finally { save.disabled = false; }
  });

  async function loadChildren() {
    try {
      const response = await api(`/items/${key}/children?limit=100`);
      const rows = await response.json();
      childBody.textContent = '';
      const notes = rows.filter(r => r.data.itemType === 'note');
      const marks = rows.filter(r => r.data.itemType === 'annotation');
      if (!notes.length) el('p', {class: 'muted small', text: '메모가 없습니다.'}, childBody);
      for (const note of notes) {
        const text = String(note.data.note || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '');
        el('p', {class: 'note', text: clean(text).slice(0, 1200) || '(빈 메모)'}, childBody);
      }
      // The reader's own marks: in the order they appear in the paper, each one a way into it.
      paper.marks = marks;
      if (marks.length) {
        const card = el('section', {class: 'card'}, body);
        el('h3', {text: T('주석 {0}개', marks.length)}, card);
        const placed = marks
          .map(mark => ({mark, place: markPlace(mark)}))
          .sort((a, b) => String(a.mark.data.annotationSortIndex || '').localeCompare(String(b.mark.data.annotationSortIndex || '')));
        /* The marks are the part of a paper that gets written about, so they come out of it in
           one tap — in the order they appear, each with the page it is on. */
        const out = el('div', {class: 'pills'}, card);
        const all = el('button', {class: 'pill', type: 'button', text: '주석 모두 복사'}, out);
        all.addEventListener('click', () => copyMarks(item, placed));
        for (const {mark, place} of placed.slice(0, 200)) {
          const line = el('button', {class: 'mark-row', type: 'button'}, card);
          el('span', {class: 'swatch', style: `background:${mark.data.annotationColor || 'var(--warm)'}`}, line);
          const text = el('span', {class: 'mark-text'}, line);
          el('span', {text: clean(mark.data.annotationText || mark.data.annotationComment || '(그림 주석)')}, text);
          const page = place ? place.page : Number(mark.data.annotationPageLabel) || 0;
          if (page) el('span', {class: 'muted small', text: T('{0}쪽', page)}, line);
          line.addEventListener('click', () => openPaper(liveItem(key) || item, {at: page || 0}));
        }
      }
    } catch (error) {
      childBody.textContent = '';
      el('p', {class: 'muted small', text: '메모를 가져오지 못했습니다. ' + error.message}, childBody);
    }
  }
  loadChildren();
}

/* ---------- listening ---------- */
/* The phone has no PDF. What it reads is the text Zotero already indexed for the attachment
   (GET /items/<attachment>/fulltext), cleaned by read.js down to the body, and spoken by the
   phone's own voices. The text is kept so a paper opened once can be listened to with no signal. */
const PDF_TYPES = /pdf|epub/i;
async function attachmentOf(itemKey) {
  const response = await api(`/items/${itemKey}/children?limit=100`);
  const rows = await response.json();
  const files = rows.filter(r => r.data.itemType === 'attachment' && (PDF_TYPES.test(r.data.contentType || '') || PDF_TYPES.test(r.data.filename || '') || PDF_TYPES.test(r.data.path || '')));
  // A PDF before anything else, and among PDFs the one whose bytes this phone can actually reach.
  const rank = row => (/pdf/i.test(row.data.contentType || row.data.filename || '') ? 0 : 1)
    + (fileSource(row, dropbox.base).kind === 'none' ? 2 : 0);
  return files.sort((a, b) => rank(a) - rank(b))[0] || null;
}
const TEXT_KEEP = 300;   // papers whose indexed text is kept; each is tens of kilobytes

async function fulltextOf(attachmentKey) {
  const saved = await DB.get('text', attachmentKey).catch(() => null);
  if (saved && saved.content) {
    DB.put('text', [{...saved, at: Date.now()}]).catch(() => {});
    return saved.content;
  }
  const response = await api(`/items/${attachmentKey}/fulltext`);
  const body = await response.json();
  const content = String(body.content || '');
  if (!content) return content;
  await DB.put('text', [{key: attachmentKey, content, at: Date.now()}]).catch(() => {});
  try {
    const rows = await DB.all('text');
    if (rows.length > TEXT_KEEP) {
      const old = rows.sort((a, b) => (a.at || 0) - (b.at || 0)).slice(0, rows.length - TEXT_KEEP);
      await DB.remove('text', old.map(row => row.key));
    }
  } catch (_) {}
  return content;
}

/* What there is to read aloud: the body Zotero indexed, or failing that the abstract, which is
   the paper's own summary and better than silence. Shared by the transcript and the PDF screen so
   they never disagree about what a paper offers. */
async function bodyToRead(item) {
  let text = '', why = null;
  try {
    const attachment = await attachmentOf(item.key);
    if (!attachment) throw new Error('이 문헌에는 PDF 첨부가 없습니다.');
    text = await fulltextOf(attachment.key);
    if (!clean(text)) throw Object.assign(new Error('색인된 본문이 비어 있습니다.'), {status: 404});
  } catch (error) { why = error; }
  if (!why) return {text, onlyAbstract: false};

  const abstract = clean(item.data.abstractNote);
  if (abstract.length > 120) return {text: `Abstract\n\n${abstract}`, onlyAbstract: true};
  throw new Error(why.status === 404
    ? 'Zotero가 이 PDF의 본문을 아직 색인하지 않았습니다. 맥에서 PDF를 한 번 열고 동기화한 뒤 다시 시도하세요.'
    : why.message);
}

const listen = {player: null, list: [], item: null, nodes: [], paper: null, wake: null, voices: [],
                sleep: null, sleepAt: 0, sleepSection: '', scrolledAt: 0, chasing: false,
                index: 0, saidTo: 0, hum: null, chaining: false, ahead: '', toldCar: '', undoLead: null, leadAt: -1};

/* Stops reading after a while, or at the end of the part being read, so a paper can be put on at
   night without talking until morning. */
function setSleep(choice) {
  clearTimeout(listen.sleep);
  listen.sleep = null; listen.sleepAt = 0; listen.sleepSection = '';
  if (!choice || choice === '0') return;
  if (choice === 'section') {
    const unit = listen.player ? listen.player.state().unit : null;
    listen.sleepSection = (unit && unit.section) || '';
    // Without named parts there is nothing to stop at, and saying so beats stopping at nothing.
    if (!listen.sleepSection) { toast('이 논문에는 구간 제목이 없습니다'); return; }
    toast(T('{0}이(가) 끝나면 멈춥니다', listen.sleepSection));
    return;
  }
  const minutes = Number(choice) || 0;
  if (!minutes) return;
  listen.sleepAt = Date.now() + minutes * 60000;
  listen.sleep = setTimeout(() => {
    if (listen.player) listen.player.pause();
    listen.sleepAt = 0;
    toast('잠들기 시간이 되어 멈췄습니다');
  }, minutes * 60000);
  toast(T('{0}분 뒤에 멈춥니다', minutes));
}

/* Keep the screen on while the paper is being read; the lock screen stops Safari's speech.
   iOS takes the lock back the moment the app goes away and does not hand it back on return, so a
   lock that has been released is no lock: it is asked for again rather than counted. */
async function holdScreen(on) {
  try {
    if (!('wakeLock' in navigator)) return;
    if (listen.wake && listen.wake.released) listen.wake = null;
    if (on && !listen.wake) listen.wake = await navigator.wakeLock.request('screen');
    if (!on && listen.wake) { await listen.wake.release(); listen.wake = null; }
  } catch (_) { listen.wake = null; }
}

/* Coming back to the app. Everything iOS does to a page it has put away it does silently: the
   page's own voice stops mid-sentence, the screen lock is taken back, and nothing is said about
   either. So on the way back the sentence is started again if it went quiet and the lock is
   asked for again. A file that is still playing is left alone, which is the whole reason a
   paper is baked. */
export function cameBack() {
  if (!listen.player || listen.player.state().status !== 'playing') return false;
  holdScreen(true);
  if (listen.hum) { try { const p = listen.hum.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
  listen.player.wake();
  return true;
}

function leftListen() {
  if (listen.player && $('paper').hidden) listen.player.stop();
  if ($('paper').hidden) { setSleep('0'); carControls(false); }   // a timer belongs to the paper it was set on
  holdScreen(false);
}

function playMark(button, playing) {
  if (!button) return;
  button.setAttribute('aria-label', playing ? '일시정지' : '재생');
  button.innerHTML = playing
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h3v14H8zM13 5h3v14h-3z"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>';
}

/* One player, two screens: the transcript marks the sentence, the PDF turns to its page. What
   they share — the place in the paper, the screen staying awake, the line underneath — is done
   once here. */
function paintReading(state) {
  const playing = state.status === 'playing';
  /* The paper this is about, held before anything below can change it: carrying on to the next
     paper swaps listen.item halfway down this function, and the place reached in this one was
     then written against the next one's key — which opened it at the end of the paper. */
  const item = listen.item;
  // The part being read has finished and that is where the reader asked to stop.
  if (listen.sleepSection && state.unit && state.unit.section && state.unit.section !== listen.sleepSection) {
    listen.sleepSection = '';
    if (listen.player) listen.player.pause();
    toast('구간이 끝나 멈췄습니다');
    return;
  }
  if (listen.undoLead && state.index !== listen.leadAt) listen.undoLead();
  readAhead(state);
  carNowPlaying(item, playing);
  const left = remainingSeconds(listen.list, state.index, state.rate);
  const unit = state.unit;
  /* Where in the paper on one side, how much of it is left on the other — which is where a player
     puts them, and what a glance is looking for. */
  const line = state.status === 'error'
    ? '이 폰의 목소리가 멈췄습니다. 다시 눌러 주세요.'
    : `${state.index + 1} / ${state.total}${unit && unit.page ? ` · ${unit.page}쪽` : ''}`;
  const sleepIn = listen.sleepAt ? Math.max(1, Math.round((listen.sleepAt - Date.now()) / 60000)) : 0;
  const rest = state.status === 'error' ? ''
    : sleepIn ? `잠들기 ${sleepIn}분`
    : listen.sleepSection ? `${listen.sleepSection}까지`
    : `남은 ${Math.max(1, Math.round(left / 60))}분`;
  if (item) {
    localStorage.setItem(KEYS.at + item.key, String(state.index));
    if (state.total > 1) localStorage.setItem(KEYS.pct + item.key, String(Math.round(state.index / (state.total - 1) * 100)));
  }
  // The paper has ended, and where it got to is written down: now the next one may begin, rather
  // than leaving a car silent.
  if (state.status === 'done') playOn();
  holdScreen(playing);
  /* While a paper is being read the page holds an audio session open, not only while driving:
     that session is what puts the paper on the lock screen and answers the buttons on a steering
     wheel, and it is what iOS looks at when it decides whether a page it has put away may go on
     making a sound. */
  if (playing) carControls(true);
  if (!$('listen').hidden) {
    $('listen-where').textContent = line;
    $('listen-left').textContent = rest;
    playMark($('listen-play'), playing);
    const seek = $('listen-seek');
    seek.max = String(Math.max(0, state.total - 1));
    seek.value = String(state.index);
    const section = $('listen-section');
    const here = state.unit && state.unit.section;
    if (here) for (const option of section.querySelectorAll('option')) option.selected = option.dataset.name === here;
    paintListen(state);
  }
  if (!$('paper').hidden) {
    $('paper-where').textContent = line;
    $('paper-left').textContent = rest;
    playMark($('paper-play'), playing);
    // The page is turned only while it is being read, so a reader who scrolled away is left alone.
    if (playing && unit && unit.page && paper.viewer && paper.following !== unit.page) {
      paper.following = unit.page;
      try { paper.viewer.goto(unit.page); } catch (_) {}
    }
  }
}

/* The sentence being read is kept in the middle of the screen rather than merely on it: a glance
   from a cradle, or over a cup of coffee, lands on the same place every time instead of hunting
   down the page for a highlight. A little above the middle, because what is coming is worth more
   room than what is past. */
const MIDDLE = 0.38, LEFT_ALONE = 6000;
function centerOn(node, {soft = true} = {}) {
  const body = $('listen-body');
  if (!body || !node) return;
  const height = body.clientHeight || 0;
  if (!height) return;
  const want = Math.max(0, Math.round((node.offsetTop || 0) - height * MIDDLE + (node.offsetHeight || 0) / 2));
  if (Math.abs((body.scrollTop || 0) - want) < 2) return;
  listen.chasing = true;
  if (typeof body.scrollTo === 'function') {
    try { body.scrollTo({top: want, behavior: soft ? 'smooth' : 'auto'}); } catch (_) { body.scrollTop = want; }
  } else body.scrollTop = want;
  setTimeout(() => { listen.chasing = false; offerHere(); }, 700);
}

function paintListen(state) {
  const node = listen.nodes[state.index];
  listen.index = state.index;
  paintHeard(state.index);
  for (const other of listen.nodes) if (other && other.getAttribute('aria-current')) other.removeAttribute('aria-current');
  if (!node) return;
  node.setAttribute('aria-current', 'true');
  offerHere();
  // A reader who scrolled off to look at something is left there for a while; a driver never is.
  if (!driving() && Date.now() - listen.scrolledAt < LEFT_ALONE) return;
  centerOn(node);
}

/* A long paper is a couple of thousand sentences. They are built in one fragment and share a
   single listener, rather than carrying a closure each. */
/* Everything one paper put on the screen, but not the way back to the voice: that belongs to the
   screen itself, and a screen that threw it away would never offer it again. */
function clearTranscript() {
  const body = $('listen-body'), here = $('listen-here');
  for (const node of [...body.children]) if (node !== here) node.remove();
  if (here) here.hidden = true;
  return body;
}

function renderTranscript(list) {
  const body = clearTranscript();
  const here = $('listen-here');
  listen.nodes = [];
  listen.saidTo = 0;
  const batch = document.createDocumentFragment();
  let section = null;
  list.forEach((unit, index) => {
    if (unit.section && unit.section !== section) { section = unit.section; el('p', {class: 'sec', text: section}, batch); }
    const node = el('button', {type: 'button', class: `sent${unit.kind === 'caption' ? ' caption' : ''}`,
                               'data-at': String(index), text: unit.text}, batch);
    listen.nodes[index] = node;
  });
  if (here) { here.hidden = true; body.insertBefore(batch, here); }   // last, so it sticks to the bottom
  else body.appendChild(batch);
}

/* What has already been heard is set back a little, so how far through a paper the voice is can
   be seen rather than counted. Only the sentences between where it was and where it is now are
   touched: a paper is thousands of lines and this runs on every one of them. */
function paintHeard(index) {
  const nodes = listen.nodes, was = listen.saidTo || 0;
  if (index > was) for (let i = was; i < index && i < nodes.length; i++) nodes[i]?.classList.add('said');
  else if (index < was) for (let i = index; i < was && i < nodes.length; i++) nodes[i]?.classList.remove('said');
  listen.saidTo = index;
}

/* A reader who scrolled back to look at something has lost the voice. The way back is offered
   only while it is somewhere they are not looking. */
function offerHere() {
  const button = $('listen-here'), body = $('listen-body');
  if (!button) return;
  const node = listen.nodes[listen.index];
  const height = body.clientHeight || 0;
  if (!node || $('listen').hidden || !height) { button.hidden = true; return; }
  const top = node.offsetTop || 0, at = body.scrollTop || 0;
  button.hidden = !(top < at - 20 || top > at + height - 40);
}

/* ---- the voices this phone has ----
   iOS ships one plain voice per language and downloads the good ones only when somebody goes to
   Settings and asks for them, so no two phones have the same list and most of it is invisible.
   The menu shows the paper's own language whole, every other language the phone can speak under
   its own name, says which voices are the good ones, and ends with where to get more. Choosing
   one speaks a line in it, because nobody can tell a voice from its name. */
const TIER_NAME = Object.fromEntries(TIERS);
const shortVoice = name => String(name || '').replace(/\s*\((?:enhanced|premium|고품질|프리미엄)\)/i, '').trim() || '목소리';
const voiceLabel = voice => {
  const tier = voiceTier(voice);
  return tier === 'plain' || tier === 'novelty' ? shortVoice(voice.name) : `${shortVoice(voice.name)} · ${TIER_NAME[tier]}`;
};

function paintVoice(lang) {
  const now = $('listen-voice-now');
  if (!now) return;
  const saved = localStorage.getItem(KEYS.voice + lang) || '';
  const chosen = listen.voices.find(v => v.voiceURI === saved);
  const auto = chosen ? null : pickVoice(listen.voices, lang, '');
  now.textContent = chosen ? shortVoice(chosen.name) : auto ? `자동 · ${shortVoice(auto.name)}` : '자동';
}

function openVoiceMenu() {
  const lang = paperLanguage(listen.list);
  const groups = voiceMenu(listen.voices, lang);
  const saved = localStorage.getItem(KEYS.voice + lang) || '';
  const items = [{id: '', label: '자동 (가장 좋은 목소리)', icon: ICON.voice, run: () => chooseVoice('', lang)}];
  for (const group of groups) {
    items.push({sep: true}, {head: `${group.name} · ${group.voices.length}`});
    for (const voice of group.voices) {
      items.push({id: voice.voiceURI, label: voiceLabel(voice), run: () => chooseVoice(voice.voiceURI, lang)});
    }
  }
  items.push({sep: true},
    {label: '목소리 더 받기', icon: ICON.down, run: () => toast('설정 → 손쉬운 사용 → 콘텐츠 말하기 → 음성')});
  floatMenu($('listen-voice'), items, {chosen: saved});
}

function chooseVoice(uri, lang) {
  if (uri) localStorage.setItem(KEYS.voice + lang, uri);
  else localStorage.removeItem(KEYS.voice + lang);
  const voice = listen.voices.find(v => v.voiceURI === uri) || pickVoice(listen.voices, lang, '');
  if (listen.player) listen.player.setVoice(voice ? voice.voiceURI : '', voice ? voice.lang : lang);
  paintVoice(lang);
  // Playing, the sentence starts again in the new voice and that is the demonstration. Stopped,
  // the voice says a line of its own rather than leaving the reader to imagine it.
  const playing = listen.player && listen.player.state().status === 'playing';
  if (!playing) sayVoice(voice, lang);
}

function sayVoice(voice, lang) {
  const engine = speechEngine(window);
  if (!engine.available()) return;
  try { engine.cancel(); } catch (_) {}
  engine.speak({text: sampleFor((voice && voice.lang) || lang), lang: (voice && voice.lang) || lang,
                voiceURI: voice ? voice.voiceURI : '', rate: readRate(), volume: readVolume()});
}

/* How loud and how fast, as the reader last left them. The loudest a page may ask for is the
   phone's own volume: there is no way to push a voice past it from in here, which is why the
   slider says so when it is already at the top. */
const readRate = () => Number(localStorage.getItem(KEYS.rate)) || 1;
export const readVolume = () => {
  // Nothing stored is as loud as the phone goes, not silence: Number(null) is 0, and a 0 here
  // would have handed the player a voice nobody could hear.
  const held = localStorage.getItem(KEYS.vol), n = Number(held);
  return held !== null && Number.isFinite(n) && n >= 0.1 && n <= 1 ? n : 1;
};
function setVolume(value) {
  const volume = Math.min(1, Math.max(0.1, Math.round(value * 20) / 20));
  localStorage.setItem(KEYS.vol, String(volume));
  if (listen.player) listen.player.setVolume(volume);
  paintVolume();
  return volume;
}
function paintVolume() {
  const slider = $('listen-vol'), said = $('listen-vol-now');
  const volume = readVolume();
  if (slider) slider.value = String(Math.round(volume * 100));
  if (said) said.textContent = volume >= 1 ? '최대' : `${Math.round(volume * 100)}%`;
}

/* ---- driving ----
   The phone is in a cradle and is looked at for a second at a time, if at all. So: the sentence
   being read is as big as the screen will take and stays in the middle of it, the buttons that
   matter are thumb-sized, a tap anywhere on the page stops and starts the voice rather than
   jumping to a sentence, and the end of a paper is the start of the next one instead of silence
   at seventy miles an hour. */
export const driving = () => localStorage.getItem(KEYS.drive) === '1';
export const chaining = () => localStorage.getItem(KEYS.chain) === '1';

const nowPlaying = () => !!listen.player && listen.player.state().status === 'playing';

function setDriving(on) {
  localStorage.setItem(KEYS.drive, on ? '1' : '0');
  $('listen').classList.toggle('driving', !!on);
  const button = $('listen-drive');
  if (button) button.setAttribute('aria-pressed', String(!!on));
  if (on && !chaining()) localStorage.setItem(KEYS.chain, '1');
  buildChain();
  // Turning driving off does not take the lock screen away from a paper that is still being read.
  carControls(on || nowPlaying());
  toast(on ? '운전 모드 · 화면 아무 데나 눌러 멈춤, 끝나면 다음 논문' : '운전 모드를 껐습니다');
  const node = listen.nodes[listen.index];
  if (node) centerOn(node, {soft: false});
}

/* The next paper in the library as it is on screen, so "what comes next" is what the reader can
   see coming, not an order only the app knows. */
export function nextAfter(rows, key) {
  const at = (rows || []).findIndex(row => row && row.key === key);
  return at >= 0 ? (rows[at + 1] || null) : null;
}

/* Most of the way through a paper, the next one is quietly fetched and kept, so that the moment it
   is wanted there is nothing to wait for: a drive goes through tunnels, and the end of a paper is
   the worst time to find out there is no signal. */
const AHEAD_AT = 0.6;
function readAhead(state) {
  if (!chaining() || !listen.item || listen.ahead === listen.item.key) return;
  if (!(state.total > 1 && state.index / (state.total - 1) >= AHEAD_AT)) return;
  listen.ahead = listen.item.key;
  const next = nextAfter(render.rows || [], listen.item.key);
  if (next) bodyToRead(next).catch(() => {});   // nothing to say about it: it is only a head start
}

async function playOn() {
  // Not while the PDF of this paper is open over it: that is reading, not a drive, and the page
  // left on screen would no longer be the paper being read.
  if (listen.chaining || !chaining() || !listen.item || $('listen').hidden || !$('paper').hidden) return false;
  const next = nextAfter(render.rows || [], listen.item.key);
  if (!next) { toast('목록의 마지막 논문까지 다 읽었습니다'); return false; }
  listen.chaining = true;
  try {
    const title = clean(next.data.title) || '제목 없음';
    toast(T('다음 논문 · {0}', title));
    await openListen(next);
    // Only the paper that was actually opened is read: one with no body leaves no player behind.
    if (listen.player && listen.item === next) { announce(title); listen.player.play(); }
  } finally { listen.chaining = false; }
  return true;
}

/* Driving, the screen is not where you find out what started playing: the paper says its own name
   before its first sentence, once, and the sentence goes back to being itself afterwards. */
function announce(title) {
  const at = listen.player.state().index, unit = listen.list[at];
  if (!unit) return;
  const was = unit.lead || '';
  unit.lead = was ? `다음 논문. ${title}. ${was}` : `다음 논문. ${title}`;
  listen.leadAt = at;
  listen.undoLead = () => { unit.lead = was; listen.undoLead = null; };
}

/* The car's own controls: the steering wheel, the dashboard and the lock screen all talk to a web
   page through mediaSession, and iOS only offers them while the page is making a sound — so a
   silent loop plays under the voice to hold the session open. Everything here is asked for
   politely: a phone without any of it loses nothing but the buttons. */
function silentLoop() {
  if (listen.hum) return listen.hum;
  const audio = document.createElement('audio');
  if (typeof audio.play !== 'function' || typeof Blob !== 'function' || !URL.createObjectURL) return null;
  const rate = 8000, samples = rate / 2;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (at, text) => { for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples, true); ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  ascii(36, 'data'); view.setUint32(40, samples, true);
  bytes.fill(128, 44);                       // 8-bit silence is the middle of the range, not zero
  try { audio.src = URL.createObjectURL(new Blob([bytes], {type: 'audio/wav'})); } catch (_) { return null; }
  audio.loop = true; audio.volume = 0.01;
  listen.hum = audio;
  return audio;
}
function carControls(on) {
  const session = navigator.mediaSession;
  const hum = on ? silentLoop() : listen.hum;
  if (hum) { try { if (on) hum.play(); else hum.pause(); } catch (_) {} }
  if (!session || typeof session.setActionHandler !== 'function') return;
  const act = fn => () => { if (listen.player) fn(listen.player); };
  const handlers = on ? {play: act(p => p.play()), pause: act(p => p.pause()),
                         previoustrack: act(p => p.prev()), nexttrack: act(p => p.next()),
                         seekbackward: act(p => p.prev()), seekforward: act(p => p.next())}
                      : {play: null, pause: null, previoustrack: null, nexttrack: null,
                         seekbackward: null, seekforward: null};
  for (const [name, handler] of Object.entries(handlers)) {
    try { session.setActionHandler(name, handler); } catch (_) {}
  }
}
function carNowPlaying(item, playing) {
  const session = navigator.mediaSession;
  if (!session) return;
  // Said once per paper and per stop or start, not once per sentence.
  const said = `${item ? item.key : ''}:${playing}`;
  if (listen.toldCar === said) return;
  listen.toldCar = said;
  try {
    if (item && typeof MediaMetadata === 'function') {
      session.metadata = new MediaMetadata({title: clean(item.data.title) || '논문',
        artist: authorsOf(item) || '논문', album: venueOf(item) || ''});
    }
    session.playbackState = playing ? 'playing' : 'paused';
  } catch (_) {}
}

/* The reader panel in Zotero can save a whole-paper translation as a child note. If this paper has
   one, it can be heard in place of the original: the same player, the same sections, the same
   everything — the words are just in the reader's own language. Asked for once per paper and then
   kept, because it is one more request over a phone's signal. */
const TRANSLATIONS = new Map();
async function translationFor(item) {
  if (TRANSLATIONS.has(item.key)) return TRANSLATIONS.get(item.key);
  let found = null;
  try {
    const response = await api(`/items/${item.key}/children?limit=100`);
    const rows = await response.json();
    const notes = rows.filter(row => row.data && row.data.itemType === 'note' && isTranslation(row.data.note));
    // The most recent one wins: a paper translated twice is a paper translated better.
    const note = notes.sort((a, b) => String(b.data.dateModified || '').localeCompare(String(a.data.dateModified || '')))[0];
    if (note) found = {key: note.key, html: note.data.note, target: noteTarget(note.data.note)};
  } catch (_) { found = null; }
  TRANSLATIONS.set(item.key, found);
  return found;
}

async function openListen(item) {
  listen.item = item;
  localStorage.setItem(KEYS.last, item.key);   // so the library can offer to carry on
  localStorage.setItem(KEYS.kind, 'listen');
  $('listen-title').textContent = clean(item.data.title) || '논문';
  const body = clearTranscript();
  $('listen-bar').hidden = true;
  openSheet('listen', leftListen);
  el('p', {class: 'muted small', text: '본문을 가져오는 중…'}, body);

  let said;
  try {
    said = await bodyToRead(item);
  } catch (error) {
    clearTranscript();
    const card = el('section', {class: 'card'}, body);
    el('h3', {text: '읽을 본문이 없습니다'}, card);
    el('p', {class: 'muted small', text: error.message}, card);
    /* The paper before this one is let go of here. Carrying on to the next paper has already
       changed which paper this screen is about, and a player left reading the last one would
       read it again under the new one's name — and write its place under the new one's key. */
    if (listen.player) { listen.player.stop(); listen.player = null; }
    if (listen.baked) { listen.baked.release(); listen.baked = null; }
    listen.list = []; listen.nodes = [];
    $('listen-bar').hidden = true;
    return;
  }
  const {text, onlyAbstract} = said;

  const paper = readable(text, {title: clean(item.data.title)});
  listen.paper = paper;
  if (onlyAbstract) toast('본문 색인이 없어 초록을 읽습니다');
  const engine = speechEngine(window);
  if (!engine.available()) {
    body.textContent = '';
    el('p', {class: 'muted small', text: '이 폰에서 음성을 쓸 수 없습니다.'}, body);
    return;
  }

  listen.original = paper;
  listen.translation = await translationFor(item);
  // Whatever was playing from a file is let go of here, or the paper before it would read on
  // underneath this one: the PDF screen makes one of these too.
  if (listen.baked) { listen.baked.release(); listen.baked = null; }
  findBaked(item).then(found => {
    if (!found || listen.item !== item) return;
    listen.baked = bakedEngine(found, found.marks);
    if (!listen.baked.marks.length) { listen.baked.release(); listen.baked = null; return; }
    buildSaying();
    /* The Mac's voice is the whole reason the paper was baked, so it is what reads — the phone's
       own voice stands in until the file is found, and stays only if that is what was asked for.
       A choice made by hand is kept: 원문 means the phone's voice, 번역 means the translation. */
    if (wantsMac()) useBaked();
  }).catch(() => {});
  listen.saying = listen.translation && localStorage.getItem(KEYS.said) === 'tr' ? 'tr' : 'raw';
  if (listen.saying === 'tr') listen.paper = fromNote(listen.translation.html, {title: clean(item.data.title)});
  buildSaying();

  const withCaptions = reading();
  listen.list = readingUnits(listen.paper, unitsFor(withCaptions));
  renderTranscript(listen.list);

  const lang = paperLanguage(listen.list);
  listen.engine = engine;
  listen.voices = engine.voices();
  paintVoice(lang);
  const chosen = pickVoice(listen.voices, lang, localStorage.getItem(KEYS.voice + lang) || '');
  const rate = readRate();
  const at = Math.min(listen.list.length - 1, Math.max(0, Number(localStorage.getItem(KEYS.at + item.key)) || 0));

  if (listen.player) listen.player.stop();
  listen.player = createPlayer({engine, rate, volume: readVolume(),
    lang: chosen ? chosen.lang : lang, voiceURI: chosen ? chosen.voiceURI : '',
    onChange: event => paintReading(event.state)});
  listen.player.load(listen.list, {at});

  // The voices arrive late on iOS; refill the menu when they do.
  try {
    speechSynthesis.addEventListener('voiceschanged', () => {
      listen.voices = engine.voices();
      paintVoice(lang);
      if (!localStorage.getItem(KEYS.voice + lang)) {
        const better = pickVoice(listen.voices, lang, '');
        if (better) listen.player.setVoice(better.voiceURI, better.lang);
      }
    }, {once: true});
  } catch (_) {}

  buildRates(rate);
  buildSizes();
  buildScope();
  buildChain();
  paintVolume();
  buildSections();
  // Driving is a mode the phone stays in: the cradle it was turned on in is the next drive too.
  $('listen').classList.toggle('driving', driving());
  $('listen-drive').setAttribute('aria-pressed', String(driving()));
  carControls(driving());
  setSleep('0');
  for (const option of $('listen-sleep').querySelectorAll('option')) option.selected = option.value === '0';
  $('listen-bar').hidden = false;
  paintReading(listen.player.state());
}

/* The parts of a paper, so a reader who wants the Results can have them. */
function buildSections() {
  const select = $('listen-section');
  select.textContent = '';
  const found = sectionsOf(listen.list);
  const first = el('option', {value: '', text: found.length ? '처음부터' : '구간 없음'}, select);
  first.selected = true;
  for (const {name, index} of found) {
    const option = el('option', {value: String(index), text: name.length > 24 ? name.slice(0, 23) + '…' : name}, select);
    option.dataset.name = name;
  }
  select.disabled = !found.length;
}

/* How big the words are while a paper is being read. A reader's own choice, kept for next time,
   and it moves the transcript and a paper's own text — not the chrome, which is not what anyone
   is reading. */
export const SIZES = [['0.88', '작게'], ['1', '보통'], ['1.15', '크게'], ['1.32', '더 크게']];
export const readSize = () => {
  const held = localStorage.getItem(KEYS.read) || '1';
  return SIZES.some(([value]) => value === held) ? held : '1';
};
function setReadSize(value) {
  localStorage.setItem(KEYS.read, value);
  if (document.documentElement) document.documentElement.style.setProperty('--read', value);
}
function buildSizes() {
  const track = $('listen-size');
  if (!track) return;
  track.textContent = '';
  el('span', {class: 'ind', 'aria-hidden': 'true'}, track);
  const now = readSize();
  for (const [value, label] of SIZES) {
    const button = el('button', {type: 'button', 'aria-pressed': String(value === now), text: label}, track);
    button.addEventListener('click', () => {
      setReadSize(value);
      for (const other of track.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button));
      slide(track);
    });
  }
  requestAnimationFrame(() => slide(track));
}

function buildRates(current, track = $('listen-rate')) {
  track.textContent = '';
  el('span', {class: 'ind', 'aria-hidden': 'true'}, track);
  for (const rate of RATES) {
    const button = el('button', {type: 'button', 'aria-pressed': String(Math.abs(rate - current) < 0.01), text: `${rate}×`}, track);
    button.addEventListener('click', () => {
      listen.player.setRate(rate);
      localStorage.setItem(KEYS.rate, String(rate));
      for (const other of track.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button));
      slide(track);
    });
  }
  requestAnimationFrame(() => slide(track));
}

/* What happens when a paper ends: nothing, or the next one in the library. It is a choice rather
   than a setting because it is the difference between a phone in a pocket and a phone in a car. */
function buildChain() {
  const track = $('listen-chain');
  if (!track) return;
  track.textContent = '';
  el('span', {class: 'ind', 'aria-hidden': 'true'}, track);
  for (const [id, label] of [['one', '한 편만'], ['on', '이어서 계속']]) {
    const button = el('button', {type: 'button', 'aria-pressed': String((id === 'on') === chaining()), text: label}, track);
    button.addEventListener('click', () => {
      localStorage.setItem(KEYS.chain, id === 'on' ? '1' : '0');
      for (const other of track.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button));
      slide(track);
    });
  }
  requestAnimationFrame(() => slide(track));
}

/* ---------- the voice this Mac baked ----------
   Supertonic cannot run on a phone: the model is 383 MB and slower than real time there. It runs on
   the Mac, which leaves one m4b in a sync folder, and Dropbox is already connected here for the
   PDFs — so that file is reachable. Playing it is not a nicety: a real audio file keeps playing
   with the screen off and answers the car's buttons, and a web page's own speech does neither.

   The file is found by the name the baker gave it, kept on the phone once fetched, and played by an
   audio element. The sidecar beside it says where every sentence starts, so the list still follows
   along and a tap on a sentence still moves the voice. */
export const audioFolder = () => localStorage.getItem(AUDIO_KEY) || AUDIO_BASE;

/* The folder is read once, not once per paper: a phone on a slow signal should not spend a round
   trip finding out that a paper was never baked. */
let bakedList = null;
/* What the Mac knows and Zotero does not: the impact factor, the citation count and where the work
   was done. One file, read once, and the list shows it from then on. Absent is not an error — it
   means the plugin has not written it, and the rows simply carry what Zotero gave them. */
let facts = null;
async function loadFacts() {
  if (facts || !dropbox.linked) return facts;
  if (!bakedList) bakedList = bakedIndex({dropbox, folder: audioFolder()});
  try {
    facts = await libraryFacts({folder: audioFolder(), dropbox, index: bakedList});
    if (facts) render({keep: true});
  } catch (_) { facts = null; }
  return facts;
}
export const factsFor = key => (facts && facts.papers && facts.papers[key]) || null;

/* Which papers the Mac has a voice for, so the library can say so before one is opened. The same
   listing the facts came from, so this costs no request of its own, and it is taken again whenever
   the library is refreshed — the Mac bakes all day and a paper finished at noon should not have to
   wait for the app to be restarted. */
let bakedNames = null;
async function loadBaked({refresh = false} = {}) {
  if (!dropbox.linked) return null;
  if (!bakedList) bakedList = bakedIndex({dropbox, folder: audioFolder()});
  if (refresh) bakedList.forget();
  let list = null;
  try { list = await bakedList.names({refresh}); } catch (_) { return bakedNames; }
  if (!list) return bakedNames;
  const next = new Set(list.filter(entry => /\.m4b$/i.test(entry.name)).map(entry => entry.name));
  const was = bakedNames ? bakedNames.size : -1;
  bakedNames = next;
  if (next.size !== was) render({keep: true});
  return bakedNames;
}
/* Is this paper one of them? The name is worked out exactly as the baker worked it out, copies
   included, which is the same arithmetic that finds the file to play. */
export const bakedCount = () => (bakedNames ? bakedNames.size : 0);
export function hasBaked(title, names = bakedNames) {
  if (!names || !names.size) return false;
  return bakedPaths(clean(title) || '논문', audioFolder()).some(path => names.has(path.split('/').pop()));
}

async function findBaked(item) {
  if (!dropbox.linked) return null;
  const title = clean(item.data.title) || '논문';
  if (!bakedList) bakedList = bakedIndex({dropbox, folder: audioFolder()});
  try {
    const found = await bakedAudio({title, folder: audioFolder(), dropbox, cache: fileCache, index: bakedList});
    if (!found) return null;
    const marks = await bakedMarks({path: found.path, dropbox});
    return {...found, marks};
  } catch (_) { return null; }        // a Dropbox that is not well is not a reason to refuse to read
}

/* The baked file, as something the player can be given in place of a voice: an audio element with
   the same few things createPlayer asks of an engine. */
function bakedEngine(found, marks) {
  const bytes = found && found.bytes;
  const mine = bytes ? URL.createObjectURL(new Blob([bytes], {type: 'audio/mp4'})) : '';
  const url = mine || (found && found.url) || '';
  const audio = new Audio(url);
  // Streamed from Dropbox: enough of it to start, not all of it before anything can start.
  audio.preload = bytes ? 'auto' : 'metadata';
  const at = Array.isArray(marks && marks.marks) ? marks.marks : [];
  const named = chapterNames(marks);
  /* One file, and a voice over whichever of its sentences are being read: leaving the reference
     list out changes which sentences those are, and the voice has to be told, because what the
     player calls sentence n is a place in this file. */
  return {url, audio, path: (found && found.path) || '', streamed: !bytes,
          marks: at, names: named, engine: bakedVoice({audio, marks: at}),
          voice: (list = at) => bakedVoice({audio, marks: list}),
          release() { try { audio.pause(); } catch (_) {} if (mine) { try { URL.revokeObjectURL(mine); } catch (_) {} } }};
}
/* The names the baker gave the chapters, by number, so the transcript can say which part of the
   paper a sentence is in. The sidecar numbers each sentence's chapter rather than naming it. */
export function chapterNames(marks) {
  const out = new Map();
  for (const chapter of (marks && marks.chapters) || []) {
    if (chapter && Number.isFinite(Number(chapter.chapter))) out.set(Number(chapter.chapter), String(chapter.title || ''));
  }
  return out;
}
/* The sentences the Mac spoke, in the order it spoke them, as units the player and the transcript
   understand. Without the sidecar there is nothing to follow, and the file is not offered.

   The marks and the units are made together and have to stay in step: the player asks the file
   for sentence n, and n is a place in the file, so a sentence left out of the one must be left
   out of the other. */
const REF_CHAPTER = /\ucc38\uace0\s*\ubb38\ud5cc|references?|bibliography|literature cited|works cited/i;
/* A bibliography entry, once it has become a sentence: a run of surnames and bare initials, a
   year, and nothing anybody would say out loud. The Mac bakes the body alone, but a reference
   list that ran on without a heading is read as body and ends up in the file. */
export function looksReference(text) {
  const body = clean(text);
  if (body.length < 40) return false;
  if (!/\b(?:19|20)\d\d[a-z]?\b/.test(body)) return false;
  const initials = (body.split(/\s+/).filter(word => /^\p{Lu}{1,3}[.,;]?$/u.test(word))).length;
  return initials >= 4 && (body.match(/,/g) || []).length >= 4;
}
export const isReferenceMark = (mark, titles) =>
  REF_CHAPTER.test(String((mark && mark.chapterTitle) || (titles && titles.get(Number(mark && mark.chapter))) || ''))
  || looksReference(mark && mark.text);

export function bakedParts(marks, names = null, want = {}) {
  const all = Array.isArray(marks) ? marks : marks && Array.isArray(marks.marks) ? marks.marks : [];
  const titles = names || chapterNames(marks);
  const kept = all.filter(mark => mark && mark.text && (want.references || !isReferenceMark(mark, titles)));
  const units = kept.map((mark, index) => ({
    text: mark.text, spoken: mark.text, page: 0, index,
    section: mark.chapterTitle || titles.get(Number(mark.chapter)) || '', lead: ''
  }));
  if (kept.length || !all.length) return {marks: kept, units};
  return bakedParts(all, titles, {references: true});   // everything the Mac said beats nothing said
}
export const bakedUnits = (marks, names = null, want = {}) => bakedParts(marks, names, want).units;

/* A baked paper is read in the Mac's voice, full stop. The phone's own is a stand-in for the
   papers the Mac has not read yet — it is not a choice to be remembered over a real voice, so a
   tap on 폰 음성 lasts for that paper and no longer. The translation is different: that is a
   choice about which words are read, and the Mac has only ever said the original. */
export const wantsMac = (said = localStorage.getItem(KEYS.said)) => said !== 'tr';

/* Hand the player the baked file in place of the phone's voice, wherever it is being read from.
   The sentences become the ones the Mac actually spoke, so the list still follows along and a tap
   on a sentence still moves the voice. */
/* The same place in a paper, counted in somebody else's sentences. The Mac broke the paper up
   where its own voice breathed and the phone breaks it where the writer put the full stops, so
   there is no sentence that is the same sentence — but a reader who is a third of the way
   through is a third of the way through either way, and the alternative is starting again. */
export const placeAcross = (at, from, to) =>
  from > 1 && to > 0 ? Math.min(to - 1, Math.max(0, Math.round((at / (from - 1)) * (to - 1)))) : 0;

function useBaked({play = false, keep = ''} = {}) {
  if (!listen.baked) return false;
  const was = listen.player ? listen.player.state() : null;
  const playing = play || (was ? was.status === 'playing' : false);
  const made = bakedParts(listen.baked.marks, listen.baked.names, unitsFor(reading()));
  if (!made.units.length) return false;
  listen.saying = 'mac';
  listen.list = made.units;
  // A scope changed in the middle of a paper comes back to the sentence it was changed on; a
  // voice swapped in the middle of one carries on from where that one had got to.
  const at = keep ? Math.max(0, made.units.findIndex(unit => unit.text === keep))
                  : was ? placeAcross(was.index, was.total, made.units.length) : 0;
  if (!$('listen').hidden) renderTranscript(listen.list);
  if (listen.player) listen.player.stop();
  listen.player = createPlayer({engine: listen.baked.voice(made.marks), rate: readRate(), volume: readVolume(),
    onChange: event => paintReading(event.state)});
  listen.player.load(listen.list, {at});
  keepAfterListening(listen.baked);
  watchBaked(listen.baked);
  if (!$('listen').hidden) { buildSaying(); buildScope(); paintVoice(listen.lang || 'en'); }
  if (playing) listen.player.play(at); else paintReading(listen.player.state());
  return true;
}

/* Back to the phone's own voice: either asked for, or because the file could not be played — a
   signal that dies mid-journey must not leave a silent car. */
function useOwnVoice({play = false} = {}) {
  if (!listen.engine) return false;
  const was = listen.player ? listen.player.state() : null;
  const playing = play || (was ? was.status === 'playing' : false);
  listen.saying = listen.saying === 'tr' ? 'tr' : 'raw';
  listen.list = readingUnits(listen.paper, unitsFor(reading()));
  if (!$('listen').hidden) renderTranscript(listen.list);
  if (listen.player) listen.player.stop();
  listen.player = createPlayer({engine: listen.engine, rate: readRate(), volume: readVolume(),
    onChange: event => paintReading(event.state)});
  const lang = paperLanguage(listen.list);
  const voice = pickVoice(listen.voices || [], lang, localStorage.getItem(KEYS.voice + lang) || '');
  if (voice) listen.player.setVoice(voice.voiceURI, voice.lang || lang);
  // A translation is a different paper's worth of sentences; either way, the place is kept.
  const at = was ? placeAcross(was.index, was.total, listen.list.length) : 0;
  listen.player.load(listen.list, {at});
  if (!$('listen').hidden) { buildSaying(); buildScope(); paintVoice(lang); }
  if (playing) listen.player.play(at); else paintReading(listen.player.state());
  return true;
}

/* A paper streamed once is put away on the phone after a minute of real listening — long enough to
   mean it, so a journey with no signal has the file and a paper merely glanced at costs nothing. */
function watchBaked(baked) {
  if (!baked || !baked.audio || baked.watchingError) return;
  baked.watchingError = true;
  baked.audio.addEventListener('error', () => {
    if (listen.saying !== 'mac') return;
    if (useOwnVoice()) toast('맥 음성을 받지 못해 폰 목소리로 읽습니다');
  }, {once: true});
}

export const KEEP_AFTER = 60;
function keepAfterListening(baked) {
  if (!baked || !baked.streamed || !baked.path || baked.keeping || baked.watching || !baked.audio) return;
  const audio = baked.audio;
  baked.watching = true;
  const watch = () => {
    if ((audio.currentTime || 0) < KEEP_AFTER) return;
    audio.removeEventListener('timeupdate', watch);
    baked.keeping = true;
    keepBaked({path: baked.path, dropbox, cache: fileCache}).catch(() => {});
  };
  audio.addEventListener('timeupdate', watch);
}

/* Which voice, and which words. Shown only when there is more than one of either to offer, because
   a row of choices where one can never be picked is worse than no row.

   The Mac's voice comes first and is what reads: the phone's own is named as what it is, a
   stand-in, rather than standing as an equal under the name of the paper itself. */
function buildSaying() {
  const row = $('listen-saying');
  row.hidden = !listen.translation && !listen.baked;
  row.textContent = '';
  if (!listen.translation && !listen.baked) return;
  const track = el('nav', {class: 'seg small-seg', role: 'group', 'aria-label': t('읽을 말')}, row);
  el('span', {class: 'ind', 'aria-hidden': 'true'}, track);
  const choices = listen.baked ? [['mac', '맥 음성'], ['raw', '폰 음성']] : [['raw', '원문']];
  if (listen.translation) choices.push(['tr', '번역']);
  for (const [id, label] of choices) {
    const button = el('button', {type: 'button', 'aria-pressed': String(id === listen.saying), text: label}, track);
    button.addEventListener('click', () => {
      if (id === listen.saying || !listen.player) return;
      const was = listen.saying;
      listen.saying = id;
      localStorage.setItem(KEYS.said, id);
      if (id === 'mac') { useBaked(); return; }
      void was;
      // Which words: the paper itself, or the translation beside it. A translation is a different
      // language, so useOwnVoice chooses the voice again for it.
      listen.paper = id === 'tr'
        ? fromNote(listen.translation.html, {title: $('listen-title').textContent})
        : (listen.original || listen.paper);
      listen.voices = listen.engine ? listen.engine.voices() : listen.voices;
      useOwnVoice();
    });
  }
  requestAnimationFrame(() => slide(track));
}

/* What is read: the body alone, the figure captions with it, or the reference list as well.
   Three steps, the same three the reader panel in Zotero offers, and the choice is remembered. */
export const SCOPES = [['body', '본문만'], ['captions', '캡션까지'], ['references', '참고문헌까지']];
export const scopeOf = value => SCOPES.some(([id]) => id === value) ? value : 'body';
export const unitsFor = scope => ({captions: scope !== 'body', references: scope === 'references'});
export const reading = () => scopeOf(localStorage.getItem(KEYS.reads));

/* The Mac bakes the body alone, so there are no captions in the file to offer; what is left to
   choose there is whether the reference list it swept up with the body is read. */
export const MAC_SCOPES = [['body', '\ubcf8\ubb38\ub9cc'], ['references', '\ucc38\uace0\ubb38\ud5cc\uae4c\uc9c0']];
function buildScope() {
  const track = $('listen-what');
  track.textContent = '';
  el('span', {class: 'ind', 'aria-hidden': 'true'}, track);
  const mac = listen.saying === 'mac';
  const now = scopeOf(reading());
  const here = mac && now === 'captions' ? 'body' : now;
  for (const [id, label] of (mac ? MAC_SCOPES : SCOPES)) {
    const button = el('button', {type: 'button', 'aria-pressed': String(id === here), text: label}, track);
    button.addEventListener('click', () => {
      if (!listen.player) return;
      const unit = listen.list[listen.player.state().index];
      localStorage.setItem(KEYS.reads, id);
      for (const other of track.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button));
      slide(track);
      // The Mac's voice is a file: leaving the references out of it leaves out the sentences
      // themselves, which is the whole list the player is reading and the voice is speaking.
      if (listen.saying === 'mac') { useBaked({keep: unit ? unit.text : ''}); return; }
      listen.list = readingUnits(listen.paper, unitsFor(id));
      renderTranscript(listen.list);
      // Where the reader was stays where the reader was, even though the list around it changed.
      const back = unit ? Math.max(0, listen.list.findIndex(u => u.text === unit.text)) : 0;
      const playing = listen.player.state().status === 'playing';
      listen.player.load(listen.list, {at: back});
      if (playing) listen.player.play(back); else paintReading(listen.player.state());
    });
  }
  requestAnimationFrame(() => slide(track));
}

/* ---------- the PDF itself ---------- */
/* Zotero's API serves the bytes of an attachment only when Zotero stores it. This library keeps
   its files as linked files in a Dropbox folder, so for almost every paper the bytes come from
   Dropbox instead (files.js works out which). What is fetched once is kept in IndexedDB, so a
   paper opened on the train opens again in a tunnel. */

const FILE_CAP = 250 * 1024 * 1024;   // what this phone keeps of other people's PDFs

const dropbox = createDropbox({store: localStorage});
const redirectUri = () => location.origin + location.pathname;

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('./vendor/pdf.min.js').then(pdfjs => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.js', import.meta.url).href;
    return pdfjs;
  }).catch(error => { pdfjsPromise = null; throw error; });   // a failed load must be allowed to try again
  return pdfjsPromise;
}
const PDF_ASSETS = {
  cMapUrl: new URL('vendor/cmaps/', import.meta.url).href, cMapPacked: true,
  standardFontDataUrl: new URL('vendor/standard_fonts/', import.meta.url).href
};

async function keepFile(key, bytes) {
  try {
    await DB.put('files', [{key, bytes, size: bytes.byteLength, at: Date.now()}]);
    const rows = await DB.all('files');
    let total = rows.reduce((sum, row) => sum + (row.size || 0), 0);
    if (total <= FILE_CAP) return;
    // The oldest ones go first, and the one just fetched is never the one thrown away.
    for (const row of rows.sort((a, b) => (a.at || 0) - (b.at || 0))) {
      if (total <= FILE_CAP || row.key === key) continue;
      await DB.remove('files', [row.key]);
      total -= row.size || 0;
    }
  } catch (_) {}
}

/* The file for a paper: from this phone, from Zotero, or from Dropbox — in that order. */
const fileCache = {
  async get(key) {
    const held = await DB.get('files', key);
    return held && held.bytes && held.bytes.byteLength ? held.bytes : null;
  },
  touch(key) { DB.get('files', key).then(held => held && DB.put('files', [{...held, at: Date.now()}])).catch(() => {}); },
  put: keepFile
};
const fileBytes = (attachment, onStep) => paperFile({
  attachment, base: dropbox.base, cache: fileCache, dropbox, onStep,
  zoteroFile: async key => (await api(`/items/${key}/file`)).arrayBuffer()
});

function paperTrouble(error) {
  const msg = $('paper-msg');
  showPaperMessage(true);
  msg.textContent = '';
  const card = el('section', {class: 'card'}, msg);
  el('h3', {text: 'PDF를 열지 못했습니다'}, card);
  el('p', {class: 'muted small', text: error.message}, card);
  if (error.need === 'dropbox' || (error.source && error.source.kind === 'dropbox') || error.missing) {
    const row = el('div', {class: 'actions'}, card);
    const go = el('button', {class: 'primary', type: 'button', text: dropbox.linked ? 'Dropbox 다시 연결' : 'Dropbox 연결'}, row);
    go.addEventListener('click', () => openSettings());
  }
}

const paper = {viewer: null, item: null, following: 0, pages: 0, marks: [], text: []};
const NIGHT = 'np.pdf.night';
/* A paper read in a dark room should not open as a white rectangle. Until a reader says
   otherwise, the page follows the phone itself; once they have said, that is what it does. */
export function nightWanted(held, dark) {
  if (held === 'on') return true;
  if (held === 'off') return false;
  return !!dark;
}
const nightOn = () => nightWanted(localStorage.getItem(NIGHT), darkWanted(localStorage.getItem(KEYS.theme), phoneIsDark()));

/* While there is something to say, it stands where the page would be. */
/* The page number, shown while the pages are moving and for a moment after, so a reader with the
   bar out of the way still knows where they are. */
let pageNowTimer = null;
function showPageNow(on) {
  const now = $('paper-now');
  if (!now) return;
  clearTimeout(pageNowTimer);
  // Whatever the bar was saying, since that is what it is standing in for.
  if (!now.textContent) now.textContent = $('paper-count') ? $('paper-count').textContent : '';
  if (!on || !now.textContent) { now.hidden = true; return; }
  now.hidden = false;
  now.classList.add('on');
  pageNowTimer = setTimeout(() => { now.classList.remove('on'); }, 1400);
}

function showPaperMessage(on) {
  $('paper-msg').hidden = !on;
  $('paper-view').hidden = on;
}

function leftPaper() {
  $('paper').classList.remove('bare');
  showPageNow(false);
  showMenu(false);
  if (paper.viewer) { paper.viewer.destroy(); paper.viewer = null; }
  paper.bytes = null;   // it is in IndexedDB; holding it in memory too is just weight
  $('paper-view').classList.remove('with-player');
  if (listen.player && $('listen').hidden) listen.player.stop();
  holdScreen(false);
}

async function openPaper(item, {at = 0} = {}) {
  if (paper.viewer) { paper.viewer.destroy(); paper.viewer = null; }
  paper.following = 0;
  paper.bytes = null;
  if (!paper.item || paper.item.key !== item.key) paper.marks = [];
  $('paper-jump').hidden = true;
  $('paper-finder').hidden = true;
  showMenu(false);
  $('paper-q').value = '';
  $('paper-found').textContent = '';
  paper.text = [];
  const night = nightOn();
  $('paper-view').classList.toggle('night', night);
  $('paper-night').setAttribute('aria-pressed', String(night));
  paper.item = item;
  listen.item = item;
  // The library offers back whichever of the two a paper was last left in the middle of.
  localStorage.setItem(KEYS.last, item.key);
  localStorage.setItem(KEYS.kind, 'read');
  $('paper-title').textContent = clean(item.data.title) || '논문';
  $('paper-view').textContent = '';
  $('paper-view').classList.remove('with-player');
  $('paper-count').textContent = '';
  $('paper-bar').hidden = true;
  openSheet('paper', leftPaper);
  const msg = $('paper-msg');
  showPaperMessage(true);
  msg.textContent = '';
  const waiting = el('p', {class: 'muted small', text: 'PDF를 찾는 중…'}, msg);

  let attachment = null;
  try {
    attachment = await attachmentOf(item.key);
    if (!attachment) throw new Error('이 문헌에는 PDF 첨부가 없습니다.');
    /* The voice and the marks do not wait for the page to be drawn, and they are wanted even when
       it cannot be: a paper whose file is out of reach can still be listened to and searched. */
    readAlong(item, attachment).catch(() => {});
    loadMarks(item).catch(() => {});
    const bytes = await fileBytes(attachment, step => { waiting.textContent = step; });
    waiting.textContent = '여는 중…';
    const pdfjs = await loadPdfjs();
    if ($('paper').hidden) return;
    showPaperMessage(false);
    paper.viewer = createViewer({
      root: $('paper-view'), pdfjs,
      onPage: (n, total) => {
        paper.pages = total;
        $('paper-count').textContent = `${n} / ${total}`;
        $('paper-now').textContent = `${n} / ${total}`;
        // While the bar is out of the way, where you are has to be said somewhere.
        if ($('paper').classList.contains('bare')) showPageNow(true);
        const slider = $('paper-slider');
        slider.max = String(total);
        slider.value = String(n);
        $('paper-jump-at').textContent = `${n} / ${total}`;
        // Where this paper was left, so it opens there next time.
        if (paper.item) {
          localStorage.setItem(KEYS.page + paper.item.key, String(n));
          localStorage.setItem(KEYS.of + paper.item.key, String(total));
        }
      },
      onZoom: value => { $('paper-out').disabled = value <= 1.001; }
    });
    await paper.viewer.open(bytes.slice(0), PDF_ASSETS);   // pdf.js takes the buffer over; the kept copy must survive
    paper.bytes = bytes;
    // The marks go on after the pages exist to put them on; they may have arrived while it loaded.
    if (paper.marks.length) paper.viewer.setMarks(paper.marks);
    const back = at > 0 ? at : Number(localStorage.getItem(KEYS.page + item.key)) || 0;
    if (back > 1) paper.viewer.goto(back);
  } catch (error) {
    paperTrouble(error);
  }
}

/* The player on the PDF screen: the same one the transcript uses, so a paper carries on from
   where it was left whichever screen it is read on. */
async function readAlong(item, attachment) {
  const bar = $('paper-bar');
  for (const id of ['paper-prev', 'paper-play', 'paper-next']) $(id).hidden = false;
  const engine = speechEngine(window);
  if (!engine.available() || !attachment) return;
  let text = '';
  try { ({text} = await bodyToRead(item)); } catch (_) { sayNoVoice(true); return; }
  if ($('paper').hidden || paper.item !== item) return;
  void attachment;

  listen.paper = readable(text, {title: clean(item.data.title)});
  listen.list = readingUnits(listen.paper, {captions: false});
  paper.text = readingUnits(listen.paper, {captions: true});   // captions included: a figure is worth finding
  if (!listen.list.length) return;
  const lang = paperLanguage(listen.list);
  listen.engine = engine;
  listen.voices = engine.voices();
  const chosen = pickVoice(listen.voices, lang, localStorage.getItem(KEYS.voice + lang) || '');
  const rate = Number(localStorage.getItem(KEYS.rate)) || 1;
  const place = Math.min(listen.list.length - 1, Math.max(0, Number(localStorage.getItem(KEYS.at + item.key)) || 0));
  if (listen.player) listen.player.stop();
  listen.player = createPlayer({engine, rate, volume: readVolume(), lang: chosen ? chosen.lang : lang,
    voiceURI: chosen ? chosen.voiceURI : '', onChange: event => paintReading(event.state)});
  listen.player.load(listen.list, {at: place});
  buildRates(rate, $('paper-rate'));
  bar.hidden = false;
  $('paper-view').classList.add('with-player');
  paintReading(listen.player.state());
  /* And the Mac's own voice if this paper has been baked. The phone's voice is the stand-in that
     can start at once; the file is what the papers were baked for, and it was reachable from the
     listening screen alone — which is not where this library is read. */
  if (listen.baked) { listen.baked.release(); listen.baked = null; }
  if (!wantsMac()) return;
  findBaked(item).then(found => {
    if (!found || paper.item !== item || $('paper').hidden) return;
    const baked = bakedEngine(found, found.marks);
    if (!baked.marks.length) { baked.release(); return; }
    if (listen.baked) listen.baked.release();
    listen.baked = baked;
    if (useBaked()) toast('맥에서 구운 음성으로 읽습니다');
  }).catch(() => {});
}

/* Finding a word in the paper without a text layer: the sentences Zotero indexed each know which
   page they came from, so a match is a page to turn to. */
function findInPaper(query) {
  const list = $('paper-found');
  list.textContent = '';
  const needle = String(query || '').trim().toLowerCase();
  if (needle.length < 2) { $('paper-hits').textContent = paper.text.length ? '' : '본문 색인이 없습니다'; return; }
  const hits = [];
  for (const unit of paper.text) {
    const at = unit.text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    hits.push({page: unit.page, at, text: unit.text});
    if (hits.length >= 80) break;
  }
  $('paper-hits').textContent = hits.length ? `${hits.length}${hits.length >= 80 ? '+' : ''}곳` : '없음';
  for (const hit of hits) {
    const row = el('button', {class: 'found', type: 'button'}, list);
    el('span', {class: 'muted small page', text: T('{0}쪽', hit.page)}, row);
    const line = el('span', {class: 'found-text'}, row);
    const from = Math.max(0, hit.at - 40);
    el('span', {text: (from ? '…' : '') + hit.text.slice(from, hit.at)}, line);
    el('b', {text: hit.text.slice(hit.at, hit.at + needle.length)}, line);
    el('span', {text: hit.text.slice(hit.at + needle.length, hit.at + needle.length + 70) + '…'}, line);
    row.addEventListener('click', () => { if (paper.viewer) paper.viewer.goto(hit.page); });
  }
}

/* Silence with no explanation reads as a broken button, so the PDF screen says why there is no
   voice on this paper. */
function sayNoVoice(unindexed) {
  const bar = $('paper-bar');
  bar.hidden = false;
  $('paper-where').textContent = unindexed
    ? '본문 색인이 없어 읽어 줄 수 없습니다. 맥에서 PDF를 한 번 열고 동기화하세요.'
    : '이 논문은 읽어 줄 수 없습니다.';
  for (const id of ['paper-prev', 'paper-play', 'paper-next']) $(id).hidden = true;
}

/* The marks made in Zotero, laid over the page. Fetched only when the PDF screen did not come
   from the paper's own screen, which has them already. */
async function loadMarks(item) {
  if (paper.marks.length) return;
  const response = await api(`/items/${item.key}/children?limit=100`);
  const rows = await response.json();
  const marks = rows.filter(row => row.data.itemType === 'annotation');
  if (!marks.length || paper.item !== item) return;
  paper.marks = marks;
  if (paper.viewer) paper.viewer.setMarks(marks);
}

/* The PDF handed to whatever else the phone can open it with — a reader, mail, Files. */
async function sharePaper() {
  if (!paper.bytes || !paper.item) { toast('아직 PDF가 열리지 않았습니다'); return; }
  const name = `${clean(paper.item.data.title) || 'paper'}`.replace(/[\\/:*?"<>|]/g, ' ').slice(0, 80) + '.pdf';
  try {
    const file = new File([paper.bytes], name, {type: 'application/pdf'});
    if (navigator.canShare && navigator.canShare({files: [file]})) {
      await navigator.share({files: [file], title: name});
      return;
    }
  } catch (error) { if (error && error.name === 'AbortError') return; }
  // No share sheet for files: fall back to saving it.
  try {
    const url = URL.createObjectURL(new Blob([paper.bytes], {type: 'application/pdf'}));
    const link = el('a', {href: url, download: name});
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (_) { toast('이 폰에서는 공유할 수 없습니다'); }
}

/* A menu that belongs to a button rather than to a screen: it is put where the button is, it takes
   the next tap anywhere else as a way of saying no, and it never leaves two of itself about. */
const TICK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';
const ICON = {
  listen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z" fill="currentColor" stroke="none"/></svg>',
  pdf: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/></svg>',
  cite: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h9a2 2 0 0 1 2 2v12"/><path d="M4 7h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4"/><path d="M8.5 7.5 12 4l3.5 3.5"/><path d="M5 13v6h14v-6"/></svg>',
  pick: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m8 12 3 3 5-5"/></svg>',
  voice: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3z"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"/><path d="m8 11 4 4 4-4"/><path d="M5 19h14"/></svg>'
};
/* Where a menu that hangs off a button goes. It hangs under the button and from its right edge,
   but it is kept on the screen before anything else: the 목소리 menu hangs off a button at the left
   of its row, and aligning the menu's right edge with that button's put its own left edge 76px off
   the side of the phone — the menu was simply cut down its side.

   Pure, so the arithmetic is checked for every corner of the screen without a phone. */
export const FLOAT_EDGE = 8, FLOAT_GAP = 6;
export function floatPlace({box, wide = 196, tall = 0, view = {}} = {}) {
  const width = view.width || 0, height = view.height || 0;
  // A row near the bottom of the screen gets its menu above it rather than off the edge.
  const under = (box.bottom || 0) + FLOAT_GAP;
  const room = height - FLOAT_EDGE;
  const top = tall && under + tall > room
    ? Math.max(FLOAT_EDGE, (box.top || 0) - tall - FLOAT_GAP)
    : under;
  const last = Math.max(FLOAT_EDGE, width - wide - FLOAT_EDGE);
  const left = Math.max(FLOAT_EDGE, Math.min((box.right || 0) - wide, last));
  return {top: Math.round(top), left: Math.round(left)};
}

let floating = null;
export function closeFloat() {
  if (!floating) return;
  const {menu, anchor, away, scrim, lift} = floating;
  floating = null;
  menu.remove();
  if (scrim) scrim.remove();
  if (lift) lift.classList.remove('lifted-row');
  if (anchor) anchor.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', away, true);
  document.removeEventListener('touchstart', away, true);
}
/* A menu is a question, and everything else has to wait for the answer: what is behind it is
   dimmed, and the row the question is about stays lit and lifted above the dimming — which is
   what this phone does when a finger is held on something. */
function floatMenu(anchor, items, {chosen = '', lift = null} = {}) {
  const was = floating && floating.anchor === anchor;
  closeFloat();
  if (was) return null;                       // the same button again means put it away
  const scrim = el('div', {class: 'scrim', 'aria-hidden': 'true'}, document.body);
  if (lift) lift.classList.add('lifted-row');
  const menu = el('div', {class: 'menu float'}, document.body);
  for (const item of items) {
    // A line between what a paper can be done to and what it can be marked as.
    if (item.sep) { el('span', {class: 'menu-line', 'aria-hidden': 'true'}, menu); continue; }
    // A long menu is read by its headings: the languages this phone can speak, one above each group.
    if (item.head) { el('span', {class: 'menu-head', text: item.head}, menu); continue; }
    const row = el('button', {class: `menu-row${item.bad ? ' bad' : ''}`, type: 'button',
      'aria-pressed': item.id === undefined ? null : String(item.id === chosen)}, menu);
    // One slot at the front, holding either the tick or what the row would do.
    el('span', {class: 'tick', html: item.id !== undefined && item.id === chosen ? TICK : (item.icon || '')}, row);
    el('span', {text: item.label}, row);
    row.addEventListener('click', () => { closeFloat(); item.run(); });
  }
  const box = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
  if (box && box.width) {
    const place = floatPlace({
      box, wide: menu.offsetWidth || 196, tall: menu.offsetHeight || 0,
      view: {width: window.innerWidth || 0, height: window.innerHeight || 0}
    });
    menu.style.top = `${place.top}px`;
    menu.style.left = `${place.left}px`;
    menu.style.right = 'auto';
  }
  /* The tap that lands on the button itself is left to the button, which closes the menu by being
     pressed again; anything else is a way of saying no. iOS does not always let a tap on a plain
     div reach the document as a click, so the touch is listened for as well. */
  const away = event => { if (!menu.contains(event.target) && !anchor.contains(event.target)) closeFloat(); };
  document.addEventListener('click', away, true);
  document.addEventListener('touchstart', away, true);
  anchor.setAttribute('aria-expanded', 'true');
  floating = {menu, anchor, away, scrim, lift};
  return menu;
}

/* The menu over a paper: shown, put away, and never left open behind a screen that closed. */
function showMenu(on) {
  const menu = $('paper-menu');
  if (!menu) return;
  menu.hidden = !on;
  $('paper-more').setAttribute('aria-expanded', String(!!on));
}

/* ---------- settings ---------- */
function openSettings() {
  openSheet('settings');
  paintSettings();
}

/* Drawn afresh whenever something in it changes, without stacking another way back. */
/* ---------- the settings screen ---------- */
/* A settings screen on this phone is groups of rows: a quiet label above the group, what each
   row is on the left, what it says on the right, and the rows that do something standing in the
   tint that says they can be pressed. The explaining goes underneath in small print, not in the
   middle of the list. */
function setGroup(body, title) {
  const group = el('section', {class: 'set-group'}, body);
  if (title) el('h3', {class: 'set-head', text: title}, group);
  const card = el('div', {class: 'card rows'}, group);
  return {group, card};
}
function setRow(card, what, value) {
  const row = el('div', {class: 'set-row'}, card);
  el('span', {class: 'what', text: what}, row);
  const said = el('span', {class: 'val', text: typeof value === 'string' ? value : ''}, row);
  return {row, said};
}
function setField(card, what, value, placeholder) {
  const row = el('label', {class: 'set-row set-field'}, card);
  el('span', {class: 'what', text: what}, row);
  const box = el('input', {type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder}, row);
  box.value = value || '';
  return box;
}
function setGo(card, label, run, {bad = false} = {}) {
  const row = el('button', {class: `set-row set-go${bad ? ' bad' : ''}`, type: 'button', text: label}, card);
  row.addEventListener('click', run);
  return row;
}
const setNote = (group, text) => el('p', {class: 'set-note', text}, group);

function paintSettings() {
  const body = $('settings-body');
  body.textContent = '';

  /* Who this phone is, first: it is the one thing a reader might be asked for. */
  const who = setGroup(body, 'Zotero');
  setRow(who.card, '사용자 번호', String(account.user || ''));
  setRow(who.card, 'API 키', account.key ? '이 폰에 저장됨' : '없음');
  setNote(who.group, '키는 이 폰의 저장 공간에만 있습니다. api.zotero.org와 Dropbox 외에는 어디로도 가지 않습니다.');

  /* Which build this is, and the way to ask for a newer one — because the usual answer to "is it
     the new version?" should not be "close the app completely and open it again". */
  const about = setGroup(body, '앱');
  /* Korean, English, or whatever the phone itself is set to. Everything on screen is drawn from the
     Korean text, so switching is a reload rather than a thousand repaints. */
  const pick = setRow(about.card, '언어', '').row;
  const tongue = el('nav', {class: 'seg small-seg', role: 'group', 'aria-label': t('언어')}, pick);
  el('span', {class: 'ind', 'aria-hidden': 'true'}, tongue);
  for (const [id, label] of [['auto', '자동'], ['ko', '한국어'], ['en', 'English']]) {
    const button = el('button', {type: 'button', 'aria-pressed': String(id === language()), text: label}, tongue);
    button.addEventListener('click', () => {
      if (id === language()) return;
      localStorage.setItem(KEYS.lang, id);
      location.reload();
    });
  }
  requestAnimationFrame(() => slide(tongue));
  /* Light or dark. It takes effect under the finger — no reload — because the whole look hangs off
     tokens on the root element. */
  const look = setRow(about.card, '화면', '').row;
  const scheme = el('nav', {class: 'seg small-seg', role: 'group', 'aria-label': t('화면')}, look);
  el('span', {class: 'ind', 'aria-hidden': 'true'}, scheme);
  for (const [id, label] of [['auto', '자동'], ['light', '라이트'], ['dark', '다크']]) {
    const button = el('button', {type: 'button', 'aria-pressed': String(id === theme()), text: label}, scheme);
    button.addEventListener('click', () => {
      if (id === theme()) return;
      if (id === 'auto') localStorage.removeItem(KEYS.theme); else localStorage.setItem(KEYS.theme, id);
      applyTheme(id);
      for (const other of scheme.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button));
      slide(scheme);
    });
  }
  requestAnimationFrame(() => slide(scheme));
  setRow(about.card, '버전', BUILD.replace(/^nonmun-/, ''));
  const check = setGo(about.card, '업데이트 확인', async () => {
    check.disabled = true;
    try {
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if (!reg) { toast('이 브라우저에는 설치되어 있지 않습니다'); return; }
      await reg.update();
      if (reg.installing || reg.waiting) { toast('새 버전을 받았습니다. 다시 엽니다'); setTimeout(() => location.reload(), 900); }
      else toast('최신입니다');
    } catch (error) { toast(error.message || '확인하지 못했습니다'); }
    finally { check.disabled = false; }
  });
  /* When a phone holds on to an old copy anyway — iOS can keep a home-screen app on its own shell for
     days — this throws the shell away and fetches it again. The library is in IndexedDB and is not
     touched; only the cached files are. Offline it would leave nothing to open, so it waits for signal. */
  const again = setGo(about.card, '앱 새로 받기', async () => {
    if (navigator.onLine === false) { toast('신호가 있을 때 눌러 주세요'); return; }
    again.disabled = true;
    try {
      if (self.caches) for (const name of await caches.keys()) await caches.delete(name);
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if (reg) await reg.unregister();
      toast('다시 받는 중…');
      setTimeout(() => location.reload(), 600);
    } catch (error) { again.disabled = false; toast(error.message || '다시 받지 못했습니다'); }
  });
  setNote(about.group, '설정을 바꾸려면 듣는 화면 아래 ☰ 를 누르세요. 목소리, 소리 크기, 본문만 읽을지 캡션까지 읽을지가 그 안에 있습니다.');

  // What this phone is holding, and the two ways of asking for it again.
  const store = setGroup(body, '라이브러리');
  setRow(store.card, '논문', `${state_items()}편`);
  setRow(store.card, '컬렉션', `${state.collections.length}개`);
  const files = setRow(store.card, '받아 둔 PDF', '세는 중…');
  setRow(store.card, '마지막 동기화', whenSynced());
  setGo(store.card, 'PDF 비우기', async () => {
    await DB.clear('files').catch(() => {});
    toast('받아 둔 PDF를 지웠습니다');
    paintSettings();
  });
  setGo(store.card, '라이브러리 다시 받기', async () => {
    account.version = 0;
    closeSheet('settings');
    await sync({full: true});
  });
  DB.all('files').then(rows => {
    const size = rows.reduce((sum, row) => sum + (row.size || 0), 0);
    files.said.textContent = `${rows.length}개 · ${(size / 1048576).toFixed(1)} MB`;
  }).catch(() => { files.said.textContent = '알 수 없음'; });

  // Dropbox: where the PDFs actually are.
  const drop = setGroup(body, 'Dropbox — PDF 원본');
  const linked = setRow(drop.card, '연결', dropbox.linked ? '연결됨' : '안 됨');
  // A light beside the word, because "연결됨" and "안 됨" are read at a glance and a colour faster.
  const dot = el('span', {class: `dot ${dropbox.linked ? 'on' : 'off'}`, 'aria-hidden': 'true'});
  linked.row.insertBefore(dot, linked.said);
  const appInput = setField(drop.card, '앱 키', dropbox.appKey, 'App key');
  const baseInput = setField(drop.card, '폴더', dropbox.base, DEFAULT_BASE);
  setGo(drop.card, dropbox.linked ? '다시 연결' : '연결', async () => {
    dropbox.appKey = appInput.value;
    dropbox.base = baseInput.value || DEFAULT_BASE;
    if (!dropbox.appKey) { toast('앱 키를 넣어 주세요'); return; }
    try { location.assign(await dropbox.begin(redirectUri())); }
    catch (error) { toast(error.message); }
  });
  setGo(drop.card, '폴더만 저장', () => {
    dropbox.appKey = appInput.value;
    dropbox.base = baseInput.value || DEFAULT_BASE;
    toast('저장했습니다');
  });
  if (dropbox.linked) setGo(drop.card, '연결 끊기', () => {
    dropbox.forget();
    toast('Dropbox 연결을 끊었습니다');
    paintSettings();
  }, {bad: true});
  setNote(drop.group,
    '이 라이브러리의 PDF는 Zotero 서버가 아니라 Dropbox 폴더에 있습니다. 그래서 Zotero 키만으로는 원본을 열 수 없고, ' +
    '폰이 Dropbox에 직접 물어봐야 합니다. 아래 앱은 이 폰과 내 Dropbox 사이에만 쓰이고, 토큰은 이 폰에만 저장됩니다.');
  const steps = el('ol', {class: 'steps'}, drop.group);
  el('li', {html: '<a href="https://www.dropbox.com/developers/apps" target="_blank" rel="noopener">dropbox.com/developers/apps</a>에서 <b>Create app</b> → Scoped access → <b>Full Dropbox</b>.'}, steps);
  el('li', {html: 'Permissions 탭에서 <b>files.metadata.read</b>와 <b>files.content.read</b>를 켜고 Submit.'}, steps);
  el('li', {html: `Settings 탭의 <b>Redirect URIs</b>에 <code>${redirectUri()}</code>를 넣고 Add.`}, steps);
  el('li', {html: '같은 탭의 <b>App key</b>를 위에 붙여넣고 연결을 누릅니다.'}, steps);

  /* The home-screen app has its own storage, and deleting the icon empties it. This puts the
     keys back into the address so adding the icon again carries them, however often that happens. */
  const carry = setGroup(body, '홈 화면 앱');
  if (standalone()) {
    setRow(carry.card, '지금', '홈 화면 앱');
    setNote(carry.group, '키를 다시 담으려면 Safari에서 같은 주소를 열고 이 화면으로 오세요.');
  } else {
    setRow(carry.card, '지금', 'Safari');
    const said = el('p', {class: 'msg', hidden: true}, carry.group);
    const shown = el('p', {class: 'set-note', hidden: true}, carry.group);
    setGo(carry.card, '키까지 함께 담기', () => {
      carryKeys();
      localStorage.setItem(KEYS.scope, 'paired');
      said.hidden = false;
      said.className = 'msg good';
      said.innerHTML = `주소에 담았습니다${dropbox.linked ? ' (Dropbox 연결까지)' : ''}. 이제 아래 <b>공유 버튼 → 홈 화면에 추가</b>를 누르세요. 먼저 홈 화면의 옛 아이콘은 지워 주세요.`;
    });
    // If the address will not carry it, one string will: copied here, pasted on the other side.
    setGo(carry.card, '키 복사', async () => {
      const both = `${account.user}:${account.key}`;
      try {
        await navigator.clipboard.writeText(both);
        toast('복사했습니다. 홈 화면 앱 첫 화면에서 붙여넣기를 누르세요');
      } catch (_) {
        shown.hidden = false;
        shown.innerHTML = `길게 눌러 복사하세요: <code>${both}</code>`;
      }
    });
    setNote(carry.group,
      '홈 화면 앱은 Safari와 저장 공간이 따로입니다. 키까지 함께 담으면 Zotero 키와 Dropbox 연결이 주소에 담기고, ' +
      '그 상태로 공유 → 홈 화면에 추가를 하면 새 아이콘이 열릴 때 전부 자동으로 들어갑니다.');
  }
}
const state_items = () => state.items.length.toLocaleString();

/* What the bar along the bottom says when nothing is happening. A blank strip says nothing; this
   says the two things a reader of a library kept on a phone wants to know — whether it is current
   and whether this phone can reach anything at all. */
function restState() {
  const node = $('sync-state');
  if (!node || state.busy) return;
  const off = typeof navigator !== 'undefined' && navigator.onLine === false;
  node.textContent = off ? '오프라인' : `마지막 업데이트 ${whenSynced()}`;
}

function whenSynced() {
  const at = Number(localStorage.getItem(KEYS.synced)) || 0;
  if (!at) return '아직 없음';
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return new Date(at).toLocaleDateString('ko-KR');
}

/* ---------- collections ---------- */
function openCollections() {
  const body = $('collections-body');
  body.textContent = '';
  openSheet('collections');
  const byParent = new Map();
  for (const c of state.collections) {
    const parent = c.data.parentCollection || '';
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(c);
  }
  // Counted the way picking one counts: a collection and everything filed under it.
  const direct = new Map();
  for (const item of state.items) for (const key of item.data.collections || []) {
    if (!direct.has(key)) direct.set(key, new Set());
    direct.get(key).add(item.key);
  }
  const counts = new Map();
  for (const c of state.collections) {
    const seen = new Set();
    for (const key of familyOf(state.collections, c.key)) for (const paper of direct.get(key) || []) seen.add(paper);
    counts.set(c.key, seen.size);
  }

  /* One row the way this phone draws a row that leads somewhere: the name, how many are in it,
     and the mark that says it opens. */
  const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';
  const navRow = (name, n, depth = 0, here = false) => {
    const row = el('button', {class: `row nav${here ? ' here' : ''}`, type: 'button',
      'aria-current': here ? 'true' : null,
      style: depth ? `padding-inline-start:${18 + depth * 16}px` : null}, body);
    el('h2', {text: name}, row);
    el('span', {class: 'n', text: T('{0}편', n.toLocaleString())}, row);
    // The one being looked at is ticked rather than chevroned: it does not lead anywhere new.
    el('span', {class: 'chev', html: here ? TICK : CHEVRON}, row);
    return row;
  };

  el('h3', {class: 'group', text: '라이브러리'}, body);
  const all = navRow('전체', state.items.length, 0, !state.collection && !state.tag);
  all.addEventListener('click', () => { state.collection = ''; closeSheet('collections'); showing(); });

  // The tags actually in use, so a subject can be picked the way a collection can.
  const tags = usefulTags(state.items);
  if (tags.length) {
    el('h3', {class: 'group', text: '태그'}, body);
    const card = el('section', {class: 'card'}, body);
    const wrap = el('div', {class: 'tags'}, card);
    for (const {tag, n} of tags) {
      const chip = el('button', {class: `chip pick-chip${state.tag === tag ? ' on' : ''}`, type: 'button', title: tag}, wrap);
      el('span', {class: 'chip-text', text: tag}, chip);
      el('span', {class: 'n', text: String(n)}, chip);
      chip.addEventListener('click', () => {
        state.tag = state.tag === tag ? '' : tag;
        closeSheet('collections');
        showing();
      });
    }
  }

  if (state.collections.length) el('h3', {class: 'group', text: '컬렉션'}, body);
  const draw = (parent, depth) => {
    for (const c of (byParent.get(parent) || []).sort((a, b) => a.data.name.localeCompare(b.data.name, 'ko'))) {
      const row = navRow(clean(c.data.name), counts.get(c.key) || 0, depth, state.collection === c.key);
      row.addEventListener('click', () => { state.collection = c.key; closeSheet('collections'); showing(); });
      draw(c.key, depth + 1);
    }
  };
  draw('', 0);
}

/* ---------- start ---------- */
/* Everything the home-screen app cannot see for itself, put into the address so that adding the
   icon from here carries it: iOS gives that app its own storage, and deleting the icon empties
   it. The Dropbox connection travels the same way. */
function carryKeys() {
  /* iOS opens a home-screen icon at the manifest's start_url when there is one, which would
     throw away everything the address is carrying. Dropping the manifest leaves the old iOS
     way — apple-touch-icon and apple-mobile-web-app-capable — which uses the address as it is. */
  try { document.querySelector('link[rel="manifest"]')?.remove(); } catch (_) {}
  const extra = dropbox.linked
    ? `&a=${encodeURIComponent(dropbox.appKey)}&d=${encodeURIComponent(localStorage.getItem('np.db.refresh') || '')}&b=${encodeURIComponent(dropbox.base)}`
    : '';
  location.hash = `k=${encodeURIComponent(account.key)}&u=${encodeURIComponent(account.user)}${extra}`;
  return location.hash;
}

/* The card that offers to carry the key: only in Safari, only once the library is there. */
function offerPairing() {
  if (!$('pair') || standalone() || !account.ready || localStorage.getItem(KEYS.scope) === 'paired') return;
  showCard({
    html: '홈 화면에 추가하면 키를 다시 넣어야 합니다. <b>키까지 함께 담기</b>를 누른 뒤 공유 → 홈 화면에 추가를 하세요.',
    label: '키까지 함께 담기',
    run: () => {
      carryKeys();
      localStorage.setItem(KEYS.scope, 'paired');
      showCard({
        html: '주소에 키를 담았습니다. 이제 아래 <b>공유 버튼 → 홈 화면에 추가</b>를 누르세요. 홈 화면 앱이 열릴 때 키가 자동으로 들어갑니다.',
        label: '', run: null, dismiss: '닫기'
      });
    }
  });
}

/* One pasted string, whether it is the key alone or "number:key" as 설정 hands it over. */
function takePasted(text) {
  const both = /^(\d{3,})\s*[:|,\s]\s*(\S{12,})$/.exec(clean(text));
  if (both) { $('setup-user').value = both[1]; $('setup-key').value = both[2]; return true; }
  $('setup-key').value = clean(text);
  return false;
}

function wire() {
  $('btn-picked').addEventListener('click', () => setPicking(false));
  $('pick-mark').addEventListener('click', pickMarkMenu);
  $('pick-rate').addEventListener('click', pickRateMenu);
  $('pick-all').addEventListener('click', () => {
    const rows = render.rows || [];
    const every = state.picked.size >= rows.length;
    state.picked = every ? new Set() : new Set(rows.map(item => item.key));
    render({keep: true});
    paintPicked();
  });
  steadyKeyboard();
  wireRail();
  wireRows($('list'));
  for (const id of SHEET_IDS) dragBack(id);
  const paste = $('setup-paste');
  if (paste) paste.addEventListener('click', async () => {
    try {
      const text = clean(await navigator.clipboard.readText());
      if (text) { takePasted(text); toast('붙여넣었습니다'); }
      else toast('클립보드가 비어 있습니다');
    } catch (_) { toast('길게 눌러 붙여넣기를 쓰세요'); }
  });
  // 설정's 키 복사 puts the number and the key in one string, so one paste fills both boxes.
  $('setup-key').addEventListener('paste', () => setTimeout(() => takePasted($('setup-key').value), 0));
  let typing = null;
  $('q').addEventListener('input', event => {
    state.q = event.target.value;
    clearTimeout(typing);
    drawRecent();
    // A fast typist would otherwise filter the whole library between every two letters.
    typing = setTimeout(showing, 110);
  });
  $('q').addEventListener('search', () => { state.q = $('q').value; render(); });
  /* The box, open: what was searched for before, and the way out of searching altogether. */
  $('q').addEventListener('focus', () => { $('q-cancel').hidden = false; drawRecent(); });
  $('q').addEventListener('blur', () => {
    remember(state.q);
    setTimeout(() => {
      if (document.activeElement === $('q')) return;
      $('q-cancel').hidden = !clean(state.q);
      drawRecent();
    }, 180);
  });
  // A tap inside the panel must not take the keyboard away before the tap lands.
  for (const type of ['pointerdown', 'mousedown']) {
    $('recent').addEventListener(type, event => { if (event.target !== $('q')) event.preventDefault(); });
  }
  $('q-cancel').addEventListener('click', () => {
    remember(state.q);
    $('q').value = ''; state.q = '';
    $('q-cancel').hidden = true;
    $('q').blur();
    drawRecent();
    showing();
  });
  $('btn-sync').addEventListener('click', () => sync());
  $('btn-collections').addEventListener('click', openCollections);
  $('back').addEventListener('click', () => closeSheet('detail'));
  $('listen-back').addEventListener('click', () => closeSheet('listen'));
  $('listen-body').addEventListener('scroll', () => {
    if (!listen.chasing) listen.scrolledAt = Date.now();
    offerHere();
  }, {passive: true});
  $('listen-here').addEventListener('click', () => {
    const node = listen.nodes[listen.index];
    if (!node) return;
    listen.chasing = true;
    listen.scrolledAt = 0;                 // the reader asked to follow again
    try { node.scrollIntoView?.({block: 'center', behavior: 'smooth'}); } catch (_) {}
    setTimeout(() => { listen.chasing = false; offerHere(); }, 700);
    $('listen-here').hidden = true;
  });
  /* Held on a sentence: the two things worth doing with one that are not starting the voice
     there, which is what a tap already does. */
  const heldSentence = holdWithin($('listen-body'),
    event => (event.target && event.target.closest ? event.target.closest('.sent') : null),
    node => {
      const at = Number(node.getAttribute('data-at')) || 0;
      const unit = (listen.list || [])[at] || {};
      floatMenu(node, [
        {label: '문장 복사', icon: ICON.cite, run: async () => {
          try { await navigator.clipboard.writeText(clean(unit.text || node.textContent)); toast('복사했습니다'); }
          catch (_) { toast('복사하지 못했습니다'); }
        }},
        {label: '여기서부터 듣기', icon: ICON.listen, run: () => { if (listen.player) listen.player.play(at); }},
        ...(unit.page ? [{label: T('{0}쪽 보기', unit.page), icon: ICON.pdf, run: () => {
          if (listen.item) openPaper(liveItem(listen.item.key) || listen.item, {at: unit.page});
        }}] : [])
      ], {lift: null});
    });
  $('listen-body').addEventListener('click', event => {
    if (!listen.player) return;
    if (heldSentence()) return;        // the tap that ended the hold is not a tap on the sentence
    // Driving, the whole page is the pause button: nobody aims at a sentence at seventy.
    if (driving()) { listen.player.toggle(); return; }
    const node = event.target && event.target.closest && event.target.closest('.sent');
    if (!node) return;
    listen.player.play(Number(node.getAttribute('data-at')) || 0);
  });
  $('listen-play').addEventListener('click', () => { if (listen.player) listen.player.toggle(); });
  $('listen-prev').addEventListener('click', () => { if (listen.player) listen.player.prev(); });
  $('listen-next').addEventListener('click', () => { if (listen.player) listen.player.next(); });
  $('listen-seek').addEventListener('change', event => {
    if (listen.player) listen.player.seek(Number(event.target.value) || 0);
  });
  $('listen-section').addEventListener('change', event => {
    if (!listen.player) return;
    const at = Number(event.target.value) || 0;
    const playing = listen.player.state().status === 'playing';
    if (playing) listen.player.play(at); else listen.player.seek(at);
  });
  $('listen-sleep').addEventListener('change', event => setSleep(event.target.value));
  $('listen-voice').addEventListener('click', openVoiceMenu);
  $('listen-drive').addEventListener('click', () => setDriving(!driving()));
  for (const type of ['input', 'change']) {
    $('listen-vol').addEventListener(type, event => setVolume((Number(event.target.value) || 0) / 100));
  }
  // The screen going away stops the voice rather than leaving it talking to nobody.
  addEventListener('pagehide', () => { if (listen.player) listen.player.stop(); });
  $('collections-back').addEventListener('click', () => closeSheet('collections'));
  $('btn-settings').addEventListener('click', () => openSettings());
  $('btn-settings-main').addEventListener('click', () => openSettings());
  $('settings-back').addEventListener('click', () => closeSheet('settings'));
  addEventListener('popstate', onPopState);
  /* A keyboard, for the iPad with one attached and for Safari on a Mac: the keys the phone's own
     apps answer to. Nothing fires while something is being typed into. */
  addEventListener('keydown', event => {
    const into = document.activeElement;
    const typing = into && (into.tagName === 'INPUT' || into.tagName === 'TEXTAREA' || into.isContentEditable);
    if (event.key === 'Escape') {
      if (floating) { closeFloat(); return; }
      if (typing && into.blur) { into.blur(); return; }
      if (sheets.length) { closeSheet(sheets[sheets.length - 1].id); return; }
      if (state.picking) setPicking(false);
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    const top = sheets.length ? sheets[sheets.length - 1].id : 'main';
    const reading = (top === 'listen' || top === 'paper') && listen.player;
    if (reading && (event.key === ' ' || event.key === 'Spacebar')) {
      event.preventDefault();
      const playing = listen.player.state().status === 'playing';
      if (playing) listen.player.pause(); else listen.player.play();
      return;
    }
    if (reading && event.key === 'ArrowLeft') { event.preventDefault(); listen.player.prev(); return; }
    if (reading && event.key === 'ArrowRight') { event.preventDefault(); listen.player.next(); return; }
    // The library: what every list on a desktop answers to.
    if (top !== 'main') return;
    if (event.key === '/' || event.key === 'f' || event.key === 'F') {
      event.preventDefault();
      $('q').focus();
      return;
    }
    if (event.key === 'Enter' && state.picking) setPicking(false);
  });
  pullToRefresh($('list'), () => sync());
  followScroll($('list'), $('main').querySelector('.top'));
  // Scrolling the library puts the keyboard away, as every other list on the phone does.
  $('list').addEventListener('touchmove', () => {
    const box = $('q');
    if (box && document.activeElement === box) box.blur();
  }, {passive: true});
  // The search key on the keyboard means "that is the whole word": the keyboard goes away.
  $('q').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('q').blur(); } });
  $('q-clear').addEventListener('click', () => {
    remember(state.q);
    $('q').value = ''; state.q = '';
    showing();
    $('q').focus();
    drawRecent();
  });
  // Back from another app, or from a locked screen: the reading picks itself up.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'hidden') cameBack(); });
  // Whatever was changed with no signal goes out the moment there is some.
  addEventListener('online', () => { restState(); flushWrites({quiet: false}); });
  addEventListener('offline', restState);
  $('held').addEventListener('click', () => flushWrites({quiet: false}));
  // The PDF opens on top of the transcript, so going back lands on the transcript again.
  $('listen-pdf').addEventListener('click', () => {
    if (!listen.item) return;
    const unit = listen.player ? listen.player.state().unit : null;
    openPaper(listen.item, {at: unit && unit.page ? unit.page : 0});
  });
  $('paper-back').addEventListener('click', () => closeSheet('paper'));
  $('paper-in').addEventListener('click', () => { if (paper.viewer) paper.viewer.zoomBy(1); });
  $('paper-out').addEventListener('click', () => { if (paper.viewer) paper.viewer.zoomBy(-1); });
  // A long paper is walked with the slider rather than a hundred flicks.
  $('paper-count').addEventListener('click', () => {
    const jump = $('paper-jump');
    jump.hidden = !jump.hidden || !paper.pages;
    if (!jump.hidden) $('paper-finder').hidden = true;
  });
  $('paper-slider').addEventListener('input', event => {
    const n = Number(event.target.value) || 1;
    $('paper-jump-at').textContent = `${n} / ${paper.pages}`;
    if (paper.viewer) paper.viewer.goto(n);
  });
  $('paper-night').addEventListener('click', () => {
    const on = !nightOn();
    localStorage.setItem(NIGHT, on ? 'on' : 'off');
    $('paper-view').classList.toggle('night', on);
    $('paper-night').setAttribute('aria-pressed', String(on));
    showMenu(false);
  });
  $('paper-share').addEventListener('click', () => { showMenu(false); sharePaper(); });
  /* Everything that is not reading itself is behind one button, so the bar over a paper is the
     paper's name and the page it is on. */
  $('btn-sort').addEventListener('click', openSortMenu);
  /* The bar at the top is the way back to the top of the library, as a title bar is on this
     phone — all of it but the two buttons standing in it, so it is a target a thumb can hit.
     Which matters: the search folds away as the library is scrolled, and this is what unfolds it. */
  document.querySelector('#main .title-row').addEventListener('click', event => {
    const on = event.target;
    if (on && typeof on.closest === 'function' && on.closest('button')) return;
    const list = $('list');
    if (typeof list.scrollTo === 'function') list.scrollTo({top: 0, behavior: 'smooth'});
    else list.scrollTop = 0;
  });
  $('paper-more').addEventListener('click', () => showMenu($('paper-menu').hidden));
  /* A tap on the page puts the bar away and gives the whole screen to the paper, as this phone's
     own reader does; another brings it back. A double tap is pdf.js's own way of zooming, so the
     first tap waits to see whether a second one is coming. */
  let bareWait = null;
  $('paper-view').addEventListener('click', () => {
    showMenu(false);
    if (!$('paper-finder').hidden || !$('paper-jump').hidden) {
      $('paper-finder').hidden = true;
      $('paper-jump').hidden = true;
      return;
    }
    if (bareWait) { clearTimeout(bareWait); bareWait = null; return; }   // the second of a double tap
    bareWait = setTimeout(() => {
      bareWait = null;
      const bare = !$('paper').classList.contains('bare');
      $('paper').classList.toggle('bare', bare);
      showPageNow(bare);
    }, 300);
  });
  // Zooming is the one thing worth pressing twice, so the menu stays up for it.
  $('listen-more').addEventListener('click', () => {
    const extra = $('listen-extra');
    extra.hidden = !extra.hidden;
    $('listen-more').setAttribute('aria-expanded', String(!extra.hidden));
    // Driving strips the bar down to what a thumb needs; the settings carry their own size while open.
    $('listen').classList.toggle('settings', !extra.hidden);
  });
  $('paper-find').addEventListener('click', () => {
    const box = $('paper-finder');
    box.hidden = !box.hidden;
    $('paper-jump').hidden = true;
    if (!box.hidden) { $('paper-q').focus(); findInPaper($('paper-q').value); }
  });
  $('paper-find-close').addEventListener('click', () => { $('paper-finder').hidden = true; });
  let finding = null;
  $('paper-q').addEventListener('input', event => {
    clearTimeout(finding);
    const value = event.target.value;
    finding = setTimeout(() => findInPaper(value), 140);
  });
  $('paper-play').addEventListener('click', () => { if (listen.player) listen.player.toggle(); });
  $('paper-prev').addEventListener('click', () => { if (listen.player) listen.player.prev(); });
  $('paper-next').addEventListener('click', () => { if (listen.player) listen.player.next(); });
  addEventListener('resize', () => {
    for (const track of document.querySelectorAll('.seg')) slide(track);
    if (paper.viewer) paper.viewer.resize();
  });
  $('setup-go').addEventListener('click', async () => {
    const user = clean($('setup-user').value), key = clean($('setup-key').value);
    const msg = $('setup-msg');
    msg.hidden = false; msg.className = 'msg'; msg.textContent = '확인 중…';
    if (!/^\d+$/.test(user) || key.length < 12) { msg.className = 'msg bad'; msg.textContent = '사용자 번호와 키를 확인하세요.'; return; }
    account.save(user, key);
    try {
      const response = await api('/items?limit=1');
      await response.json();
      msg.className = 'msg good'; msg.textContent = '연결되었습니다.';
      $('setup').hidden = true; $('main').hidden = false;
      buildFilters(); await loadCache(); render(); sync({full: true});
      offerPairing();
    } catch (error) {
      msg.className = 'msg bad'; msg.textContent = error.message;
    }
  });
}

/* Dropbox sends the phone back here with a code in the address. It is traded for a token that
   lasts, and the address is wiped, exactly as the Zotero key in a link is. */
async function takeDropboxReturn() {
  const back = returningCode(location.search);
  if (!back.code && !back.error) return '';
  try { history.replaceState(null, '', location.pathname); } catch (_) {}
  if (back.error) return `Dropbox 연결이 취소되었습니다 (${back.error})`;
  try { await dropbox.finish(back.code, redirectUri()); return 'Dropbox에 연결되었습니다'; }
  catch (error) { return error.message; }
}

/* Which language this phone reads in: 자동 follows the phone itself, and the choice is settled
   before a single word is drawn. */
export const language = () => localStorage.getItem(KEYS.lang) || 'auto';

/* Light or dark. 자동 follows the phone, which is what it has always done; the other two are for
   the reader whose phone is in one and whose eyes want the other — a bright train at night, a dark
   phone in a lit room. Nothing here reloads: the tokens hang off the root, so the whole app turns
   between one frame and the next. */
export const themeWanted = held => (held === 'light' || held === 'dark' ? held : 'auto');
export const darkWanted = (held, phoneIsDark) => {
  const want = themeWanted(held);
  return want === 'auto' ? !!phoneIsDark : want === 'dark';
};
export const theme = () => themeWanted(localStorage.getItem(KEYS.theme));
const phoneIsDark = () => {
  try { return !!(matchMedia && matchMedia('(prefers-color-scheme: dark)').matches); } catch (_) { return false; }
};
/* The bar at the top of the phone is painted by the page, not by the app, so it has to be told
   too — otherwise a dark app keeps a white strip above it. In 자동 each of the two metas keeps its
   own colour and its own media; asked for one, both carry that one. */
const BAR = {light: '#f1f1f5', dark: '#000000'};
export function applyTheme(choice, {root = document.documentElement, page = document} = {}) {
  const want = themeWanted(choice);
  if (want === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', want);
  for (const meta of page.querySelectorAll('meta[name="theme-color"]')) {
    const own = /dark/.test(meta.getAttribute('media') || '') ? 'dark' : 'light';
    meta.setAttribute('content', BAR[want === 'auto' ? own : want]);
  }
  return want;
}
function speakLanguage() {
  setStrings(EN);
  return useLanguage(language(), {language: (navigator.languages && navigator.languages[0]) || navigator.language || ''});
}
/* The page's own markup is written in Korean. Rather than make every label an id, the whole of it is
   walked once at start and each exact Korean string is swapped for its English. It runs before the
   app draws anything, and it only ever replaces a string the table knows. */
function translatePage(root = document) {
  if (using() === 'ko') return 0;
  let done = 0;
  const walker = document.createTreeWalker(root.body || root, 4 /* SHOW_TEXT */);
  const texts = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node);
  for (const node of texts) {
    const was = node.nodeValue, trimmed = was.trim();
    if (!trimmed || !/[가-힣]/.test(trimmed)) continue;
    const en = t(trimmed);
    if (en !== trimmed) { node.nodeValue = was.replace(trimmed, en); done++; }
  }
  for (const node of (root.body || root).querySelectorAll('[aria-label],[placeholder],[title],[aria-valuetext]')) {
    for (const name of ['aria-label', 'placeholder', 'title', 'aria-valuetext']) {
      const was = node.getAttribute(name);
      if (!was || !/[가-힣]/.test(was)) continue;
      const en = t(was.trim());
      if (en !== was.trim()) { node.setAttribute(name, en); done++; }
    }
  }
  return done;
}

async function start() {
  speakLanguage();
  applyTheme(localStorage.getItem(KEYS.theme));   // before anything is drawn, as the language is
  translatePage();
  setReadSize(readSize());            // the size chosen last time, before anything is drawn
  try { history.replaceState({depth: 0}, ''); } catch (_) {}
  const paired = takeKeyFromLink();
  const fromDropbox = await takeDropboxReturn();
  wire();
  if (fromDropbox) setTimeout(() => toast(fromDropbox), 300);
  if (!account.ready) {
    $('setup-user').value = '16265664';
    $('setup-why').hidden = !standalone();
    $('setup').hidden = false;
    return;
  }
  $('main').hidden = false;
  buildFilters();
  await loadCache();
  render();
  restState();
  heldWrites().then(queue => paintHeld(queue.length)).catch(() => {});
  loadFacts().catch(() => {});
  loadBaked().catch(() => {});
  sync();
  if (paired) toast('키가 함께 들어왔습니다');
  else offerPairing();
}

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
start();

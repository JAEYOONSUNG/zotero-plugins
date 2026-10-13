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

import {readable, units as readingUnits, remainingSeconds} from './read.js';
import {createPlayer, speechEngine, pickVoice, paperLanguage, sectionsOf, RATES} from './play.js';
import {fileSource, createDropbox, returningCode, paperFile, DEFAULT_BASE} from './files.js';
import {createViewer, markPlace} from './pdfview.js';
import {filterRows, sortRows, usefulTags, familyOf, SORTS, groupOf, railLabel} from './list.js';
import {withRetry, isOffline, mergeQueue} from './net.js';

const API = 'https://api.zotero.org';
const KEYS = {user: 'np.user', key: 'np.key', ver: 'np.version', scope: 'np.scope',
              rate: 'np.rate', voice: 'np.voice.', at: 'np.at.', sort: 'np.sort', page: 'np.page.',
              pct: 'np.pct.', seen: 'np.seen.', synced: 'np.synced', last: 'np.last', tip: 'np.tip',
              read: 'np.read', recent: 'np.recent'};
const STATUSES = [['', '전체'], ['reading', '읽는 중'], ['unread', '안 읽음'], ['done', '완료']];
const STATUS_TAG = {unread: '/unread', reading: '/reading', done: '/done'};
const TAG_STATUS = {'/unread': 'unread', '/reading': 'reading', '/done': 'done'};

const $ = id => document.getElementById(id);
const el = (tag, attrs = {}, parent) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  if (parent) parent.appendChild(node);
  return node;
};
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();

let toastTimer = null;
function toast(text) {
  const node = $('toast');
  node.textContent = text; node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2600);
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
    });

    // What was deleted elsewhere goes too, so the phone does not keep ghosts.
    if (since) {
      const response = await api(`/deleted?since=${since}`);
      const gone = await response.json();
      const keys = [...(gone.items || []), ...(gone.collections || [])];
      if (gone.items?.length) await DB.remove('items', gone.items);
      if (gone.collections?.length) await DB.remove('collections', gone.collections);
      if (keys.length) toast(`${keys.length}건이 삭제되어 함께 지웠습니다`);
    }

    if (version) account.version = version;
    await loadCache();
    render();
    await flushWrites();
    localStorage.setItem(KEYS.synced, String(Date.now()));
    $('sync-state').textContent = seen ? `${seen.toLocaleString()}건 갱신` : '최신';
  } catch (error) {
    if (error.status === 403) { $('sync-state').textContent = ''; showKeyTrouble(); }
    else if (error.offline) $('sync-state').textContent = '오프라인';   // the usual state on a phone, not news
    else { $('sync-state').textContent = ''; toast(error.message || '가져오지 못했습니다'); }
  } finally {
    state.busy = false;
    spinSync(false);
    setTimeout(restState, 4000);
  }
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
        toast(`보내지 못한 변경 하나를 버렸습니다 — ${error.message}`);
      }
    }
  } finally {
    flushWrites.busy = false;
    const left = await heldWrites();
    paintHeld(left.length);
    if (sent) { render({keep: true}); if (!quiet) toast(`${sent}건을 보냈습니다`); }
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
  $('pair-text').innerHTML = html;
  const go = $('pair-go'), hide = $('pair-hide');
  go.textContent = label;
  go.hidden = !label;
  go.onclick = run || null;
  hide.textContent = dismiss;
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
  if (count) count.textContent = n ? `${n.toLocaleString()}편 선택` : '선택';
}
/* Marked one after another rather than all at once: each write is its own intention against the
   paper as it stands on the server, which is what keeps a change made on the Mac meanwhile. */
async function applyPicked(what, value, said) {
  const keys = [...state.picked];
  if (!keys.length) return;
  let done = 0;
  for (const key of keys) {
    const item = liveItem(key);
    if (!item) continue;
    try { await (what === 'status' ? setStatus(item, value) : setRating(item, value)); done++; }
    catch (error) { toast(error.message); break; }
  }
  setPicking(false);
  toast(`${done.toLocaleString()}편을 ${said}`);
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
    await setStatus(item, id);
    render({keep: true});
    toast(id ? `${label}으로 표시` : '표시를 지웠습니다');
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
      axis = Math.abs(dx) > Math.abs(dy) * 1.3 ? 'x' : 'y';
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
    on.setAttribute('aria-selected', String(chosen));
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
    row.setAttribute('aria-selected', String(chosen));
    el('span', {class: `pick-mark${chosen ? ' on' : ''}`, html: chosen ? PICK_MARK : ''}, face);
  }
  el('h2', {text: clean(item.data.title) || '(제목 없음)'}, face);
  el('p', {class: 'meta', text: [authorsOf(item), yearOf(item), venueOf(item)].filter(Boolean).join(' · ')}, face);
  const rating = ratingOf(item);
  const tag = (item.data.tags || []).find(t => !TAG_STATUS[t.tag] && !/^style-custom:/.test(t.tag));
  // How far the reading got, for the papers that were started and not finished.
  const heard = Number(localStorage.getItem(KEYS.pct + item.key)) || 0;
  const part = heard > 1 && heard < 99;
  // The third line is only drawn for a paper that has something to say on it.
  if (rating || tag || part) {
    const foot = el('div', {class: 'foot'}, face);
    if (rating) el('span', {class: 'stars', text: stars(rating)}, foot);
    if (tag) el('span', {class: 'chip', text: clean(tag.tag).slice(0, 18)}, foot);
    if (part) {
      const bar = el('span', {class: 'heard', 'aria-label': `${heard}% 들음`}, foot);
      el('i', {style: `width:${Math.min(100, heard)}%`}, bar);
      el('span', {class: 'muted', text: `${heard}%`}, foot);
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
  el('span', {text: '옆으로 밀면 완료 · 안 읽음, 꾹 누르면 전부'}, line);
  const off = el('button', {class: 'x', type: 'button', 'aria-label': '안내 닫기', text: '×'}, line);
  off.addEventListener('click', () => { localStorage.setItem(KEYS.tip, 'off'); line.remove(); });
  return line;
}

/* A paper left half heard is the thing most likely to be wanted next, so the library offers it
   back rather than making it be found again. Only on the library itself: under a search or a
   filter, a paper that is not in what is being looked at has no business at the top of it. */
function drawResume(list) {
  const key = localStorage.getItem(KEYS.last) || '';
  if (!key || state.q || state.collection || state.tag || state.status || state.picking) return null;
  const item = state.items.find(paper => paper.key === key);
  const heard = Number(localStorage.getItem(KEYS.pct + key)) || 0;
  if (!item || heard < 1 || heard > 98) return null;
  const card = el('section', {class: 'resume'}, list);
  const go = el('button', {type: 'button', 'aria-label': `${clean(item.data.title)} 이어 듣기`}, card);
  el('span', {class: 'go', html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>'}, go);
  const what = el('span', {class: 'what'}, go);
  el('b', {text: clean(item.data.title) || '(제목 없음)'}, what);
  el('span', {text: `이어 듣기 · ${heard}%`}, what);
  const bar = el('span', {class: 'heard'}, go);
  el('i', {style: `width:${Math.min(100, heard)}%`}, bar);
  go.addEventListener('click', () => openListen(liveItem(key) || item));
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
      if (n > 1) el('span', {class: 'n', text: `${n.toLocaleString()}편`}, head);
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
  list.textContent = '';
  more = null;
  if (!state.picking) $('count').textContent = rows.length ? `${rows.length.toLocaleString()}편` : '';
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
        el('h3', {text: `주석 ${marks.length}개`}, card);
        const placed = marks
          .map(mark => ({mark, place: markPlace(mark)}))
          .sort((a, b) => String(a.mark.data.annotationSortIndex || '').localeCompare(String(b.mark.data.annotationSortIndex || '')));
        for (const {mark, place} of placed.slice(0, 200)) {
          const line = el('button', {class: 'mark-row', type: 'button'}, card);
          el('span', {class: 'swatch', style: `background:${mark.data.annotationColor || 'var(--warm)'}`}, line);
          const text = el('span', {class: 'mark-text'}, line);
          el('span', {text: clean(mark.data.annotationText || mark.data.annotationComment || '(그림 주석)')}, text);
          const page = place ? place.page : Number(mark.data.annotationPageLabel) || 0;
          if (page) el('span', {class: 'muted small', text: `${page}쪽`}, line);
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
                index: 0, saidTo: 0};

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
    toast(`${listen.sleepSection}이(가) 끝나면 멈춥니다`);
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
  toast(`${minutes}분 뒤에 멈춥니다`);
}

/* Keep the screen on while the paper is being read; the lock screen stops Safari's speech. */
async function holdScreen(on) {
  try {
    if (!('wakeLock' in navigator)) return;
    if (on && !listen.wake) listen.wake = await navigator.wakeLock.request('screen');
    if (!on && listen.wake) { await listen.wake.release(); listen.wake = null; }
  } catch (_) { listen.wake = null; }
}

function leftListen() {
  if (listen.player && $('paper').hidden) listen.player.stop();
  if ($('paper').hidden) setSleep('0');   // a timer belongs to the paper it was set on
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
  // The part being read has finished and that is where the reader asked to stop.
  if (listen.sleepSection && state.unit && state.unit.section && state.unit.section !== listen.sleepSection) {
    listen.sleepSection = '';
    if (listen.player) listen.player.pause();
    toast('구간이 끝나 멈췄습니다');
    return;
  }
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
  if (listen.item) {
    localStorage.setItem(KEYS.at + listen.item.key, String(state.index));
    if (state.total > 1) localStorage.setItem(KEYS.pct + listen.item.key, String(Math.round(state.index / (state.total - 1) * 100)));
  }
  holdScreen(playing);
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

function paintListen(state) {
  const node = listen.nodes[state.index];
  listen.index = state.index;
  paintHeard(state.index);
  for (const other of listen.nodes) if (other && other.getAttribute('aria-current')) other.removeAttribute('aria-current');
  if (!node) return;
  node.setAttribute('aria-current', 'true');
  offerHere();
  // Chased only when it has gone off screen, and never while the reader is looking somewhere else.
  if (Date.now() - listen.scrolledAt < 6000) return;
  const body = $('listen-body');
  const top = node.offsetTop, height = body.clientHeight || 0;
  if (height && top >= body.scrollTop && top < body.scrollTop + height - 80) return;
  listen.chasing = true;
  try { node.scrollIntoView?.({block: 'center', behavior: 'smooth'}); } catch (_) { try { node.scrollIntoView?.(); } catch (__) {} }
  setTimeout(() => { listen.chasing = false; }, 700);
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

function fillVoiceMenu(lang) {
  const select = $('listen-voice');
  const same = listen.voices.filter(v => String(v.lang || '').toLowerCase().startsWith(lang));
  // Best first, by the same reckoning that picks one when nobody has chosen.
  const pool = (same.length ? same : listen.voices).slice();
  const order = [];
  const left = pool.slice();
  while (left.length && order.length < 60) {
    const best = pickVoice(left, lang, '') || left[0];
    order.push(best);
    left.splice(left.indexOf(best), 1);
  }
  const offered = order;
  const saved = localStorage.getItem(KEYS.voice + lang) || '';
  const chosen = offered.some(v => v.voiceURI === saved) ? saved : '';
  select.textContent = '';
  const auto = el('option', {value: '', text: '자동'}, select);
  if (!chosen) auto.selected = true;
  for (const voice of offered) {
    const option = el('option', {value: voice.voiceURI, text: `${voice.name}${voice.lang ? ` · ${voice.lang}` : ''}`}, select);
    if (voice.voiceURI === chosen) option.selected = true;
  }
}

async function openListen(item) {
  listen.item = item;
  localStorage.setItem(KEYS.last, item.key);   // so the library can offer to carry on
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

  const withCaptions = false;
  listen.list = readingUnits(paper, {captions: withCaptions});
  renderTranscript(listen.list);

  const lang = paperLanguage(listen.list);
  listen.voices = engine.voices();
  fillVoiceMenu(lang);
  const chosen = pickVoice(listen.voices, lang, localStorage.getItem(KEYS.voice + lang) || '');
  const rate = Number(localStorage.getItem(KEYS.rate)) || 1;
  const at = Math.min(listen.list.length - 1, Math.max(0, Number(localStorage.getItem(KEYS.at + item.key)) || 0));

  if (listen.player) listen.player.stop();
  listen.player = createPlayer({engine, rate, lang: chosen ? chosen.lang : lang, voiceURI: chosen ? chosen.voiceURI : '',
    onChange: event => paintReading(event.state)});
  listen.player.load(listen.list, {at});

  // The voices arrive late on iOS; refill the menu when they do.
  try {
    speechSynthesis.addEventListener('voiceschanged', () => {
      listen.voices = engine.voices();
      fillVoiceMenu(lang);
      if (!localStorage.getItem(KEYS.voice + lang)) {
        const better = pickVoice(listen.voices, lang, '');
        if (better) listen.player.setVoice(better.voiceURI, better.lang);
      }
    }, {once: true});
  } catch (_) {}

  buildRates(rate);
  buildSizes();
  buildScope(lang, withCaptions);
  buildSections();
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

/* What is read: the body alone, or the figure captions with it. */
function buildScope(lang, captions) {
  const track = $('listen-what');
  track.textContent = '';
  el('span', {class: 'ind', 'aria-hidden': 'true'}, track);
  for (const [id, label] of [['body', '본문만'], ['captions', '캡션까지']]) {
    const on = (id === 'captions') === captions;
    const button = el('button', {type: 'button', 'aria-pressed': String(on), text: label}, track);
    button.addEventListener('click', () => {
      const at = listen.player.state().index;
      const unit = listen.list[at];
      listen.list = readingUnits(listen.paper, {captions: id === 'captions'});
      renderTranscript(listen.list);
      const back = unit ? Math.max(0, listen.list.findIndex(u => u.text === unit.text)) : 0;
      const playing = listen.player.state().status === 'playing';
      listen.player.load(listen.list, {at: back});
      for (const other of track.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button));
      slide(track);
      if (playing) listen.player.play(back); else paintReading(listen.player.state());
    });
  }
  requestAnimationFrame(() => slide(track));
  void lang;
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
  $('paper-view').classList.toggle('night', localStorage.getItem(NIGHT) === 'on');
  $('paper-night').setAttribute('aria-pressed', String(localStorage.getItem(NIGHT) === 'on'));
  paper.item = item;
  listen.item = item;
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
        if (paper.item) localStorage.setItem(KEYS.page + paper.item.key, String(n));
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
  listen.voices = engine.voices();
  const chosen = pickVoice(listen.voices, lang, localStorage.getItem(KEYS.voice + lang) || '');
  const rate = Number(localStorage.getItem(KEYS.rate)) || 1;
  const place = Math.min(listen.list.length - 1, Math.max(0, Number(localStorage.getItem(KEYS.at + item.key)) || 0));
  if (listen.player) listen.player.stop();
  listen.player = createPlayer({engine, rate, lang: chosen ? chosen.lang : lang,
    voiceURI: chosen ? chosen.voiceURI : '', onChange: event => paintReading(event.state)});
  listen.player.load(listen.list, {at: place});
  buildRates(rate, $('paper-rate'));
  bar.hidden = false;
  $('paper-view').classList.add('with-player');
  paintReading(listen.player.state());
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
    el('span', {class: 'muted small page', text: `${hit.page}쪽`}, row);
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
  pick: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m8 12 3 3 5-5"/></svg>'
};
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
    const row = el('button', {class: `menu-row${item.bad ? ' bad' : ''}`, type: 'button',
      'aria-pressed': item.id === undefined ? null : String(item.id === chosen)}, menu);
    // One slot at the front, holding either the tick or what the row would do.
    el('span', {class: 'tick', html: item.id !== undefined && item.id === chosen ? TICK : (item.icon || '')}, row);
    el('span', {text: item.label}, row);
    row.addEventListener('click', () => { closeFloat(); item.run(); });
  }
  const box = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
  if (box && box.width) {
    const tall = menu.offsetHeight || 0;
    const room = (window.innerHeight || 0) - 8;
    // A row near the bottom of the screen gets its menu above it rather than off the edge.
    const under = box.bottom + 6;
    const top = tall && under + tall > room ? Math.max(8, box.top - tall - 6) : under;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.right = `${Math.max(8, Math.round((window.innerWidth || 0) - box.right))}px`;
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
  const navRow = (name, n, depth = 0) => {
    const row = el('button', {class: 'row nav', type: 'button',
      style: depth ? `padding-inline-start:${18 + depth * 16}px` : null}, body);
    el('h2', {text: name}, row);
    el('span', {class: 'n', text: `${n.toLocaleString()}편`}, row);
    el('span', {class: 'chev', html: CHEVRON}, row);
    return row;
  };

  el('h3', {class: 'group', text: '라이브러리'}, body);
  const all = navRow('전체', state.items.length);
  all.addEventListener('click', () => { state.collection = ''; closeSheet('collections'); showing(); });

  // The tags actually in use, so a subject can be picked the way a collection can.
  const tags = usefulTags(state.items);
  if (tags.length) {
    el('h3', {class: 'group', text: '태그'}, body);
    const card = el('section', {class: 'card'}, body);
    const wrap = el('div', {class: 'tags'}, card);
    for (const {tag, n} of tags) {
      const chip = el('button', {class: `chip pick-chip${state.tag === tag ? ' on' : ''}`, type: 'button'}, wrap);
      el('span', {text: tag}, chip);
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
      const row = navRow(clean(c.data.name), counts.get(c.key) || 0, depth);
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
  $('listen-body').addEventListener('click', event => {
    const node = event.target && event.target.closest && event.target.closest('.sent');
    if (!node || !listen.player) return;
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
  $('listen-voice').addEventListener('change', event => {
    if (!listen.player) return;
    const uri = event.target.value;
    const lang = paperLanguage(listen.list);
    localStorage.setItem(KEYS.voice + lang, uri);
    const voice = listen.voices.find(v => v.voiceURI === uri) || pickVoice(listen.voices, lang, '');
    listen.player.setVoice(voice ? voice.voiceURI : '', voice ? voice.lang : lang);
  });
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
    const on = localStorage.getItem(NIGHT) !== 'on';
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

async function start() {
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
  sync();
  if (paired) toast('키가 함께 들어왔습니다');
  else offerPairing();
}

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
start();

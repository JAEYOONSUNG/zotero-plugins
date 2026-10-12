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
import {createPlayer, speechEngine, pickVoice, paperLanguage, RATES} from './play.js';
import {fileSource, createDropbox, returningCode, paperFile, DEFAULT_BASE} from './files.js';
import {createViewer} from './pdfview.js';

const API = 'https://api.zotero.org';
const KEYS = {user: 'np.user', key: 'np.key', ver: 'np.version', scope: 'np.scope',
              rate: 'np.rate', voice: 'np.voice.', at: 'np.at.'};
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
    const req = indexedDB.open('nonmun', 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', {keyPath: 'key'});
      if (!db.objectStoreNames.contains('collections')) db.createObjectStore('collections', {keyPath: 'key'});
      // The text Zotero indexed, kept so a paper opened once can be listened to with no signal.
      if (!db.objectStoreNames.contains('text')) db.createObjectStore('text', {keyPath: 'key'});
      // The PDFs themselves, so a paper opened once opens again with no signal.
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', {keyPath: 'key'});
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

async function api(path, {method = 'GET', body = null, headers = {}} = {}) {
  const response = await fetch(`${API}/users/${account.user}${path}`, {
    method,
    headers: {
      'Zotero-API-Version': '3',
      'Zotero-API-Key': account.key,
      ...(body ? {'Content-Type': 'application/json'} : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (response.status === 403) throw Object.assign(new Error('키가 거부되었습니다. 읽기·쓰기 권한을 확인하세요.'), {status: 403});
  if (response.status === 412) throw Object.assign(new Error('다른 곳에서 먼저 바뀌었습니다. 새로 고침하고 다시 시도하세요.'), {status: 412});
  if (response.status === 429 || response.status === 503) {
    throw Object.assign(new Error('Zotero 서버가 잠시 바쁩니다. 조금 뒤에 다시 시도하세요.'), {status: response.status});
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
const state = {items: [], collections: [], status: '', collection: '', q: '', busy: false};

/* ---------- sync ---------- */
async function loadCache() {
  const [items, collections] = await Promise.all([DB.all('items'), DB.all('collections')]);
  state.items = items.filter(isPaper);
  state.collections = collections;
}

async function sync({full = false} = {}) {
  if (state.busy) return;
  state.busy = true;
  const since = full ? 0 : account.version;
  $('sync-state').textContent = since ? '확인 중…' : '처음 받는 중…';
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
    $('sync-state').textContent = seen ? `${seen.toLocaleString()}건 갱신` : '최신';
  } catch (error) {
    $('sync-state').textContent = '';
    toast(error.message || '가져오지 못했습니다');
  } finally {
    state.busy = false;
    setTimeout(() => { if (!state.busy) $('sync-state').textContent = ''; }, 4000);
  }
}

/* ---------- writing back ---------- */
/* One PATCH per change, guarded by the version this phone holds. The item in the cache is
   replaced with what the server confirms, so the next write carries the new version. */
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

async function setStatus(item, status) {
  const kept = (item.data.tags || []).filter(t => !TAG_STATUS[t.tag]);
  const tags = status ? [...kept, {tag: STATUS_TAG[status], type: 1}] : kept;
  return patchItem(item, {tags});
}

async function setRating(item, rating) {
  const lines = String(item.data.extra || '').split('\n').filter(line => !/^\s*Rating:\s*[0-5]\s*$/i.test(line));
  if (rating > 0) lines.unshift(`Rating: ${rating}`);
  return patchItem(item, {extra: lines.join('\n').replace(/^\n+|\n+$/g, '')});
}

async function addNote(item, text) {
  // Trimmed, but the line breaks are the writer's: clean() would run the paragraphs together.
  const body = String(text ?? '').replace(/[ \t]+/g, ' ').replace(/[ \t]*\n/g, '\n').trim();
  if (!body) return null;
  const html = body.split(/\n{2,}/).map(p => `<p>${p.replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'})[c]).replace(/\n/g, '<br>')}</p>`).join('');
  const response = await api('/items', {
    method: 'POST',
    body: [{itemType: 'note', parentItem: item.key, note: html, tags: []}]
  });
  const result = await response.json();
  if (result.failed && Object.keys(result.failed).length) throw new Error('메모를 저장하지 못했습니다');
  return result;
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
      render();
    });
  }
  requestAnimationFrame(() => slide(track));
}

/* ---------- the list ---------- */
const matches = (item, needle) => {
  if (!needle) return true;
  const hay = [item.data.title, venueOf(item), yearOf(item), ...(item.data.creators || []).map(c => `${c.lastName || ''} ${c.firstName || ''} ${c.name || ''}`), ...(item.data.tags || []).map(t => t.tag)].join(' ').toLowerCase();
  return needle.split(/\s+/).every(word => hay.includes(word));
};

function visible() {
  const needle = state.q.trim().toLowerCase();
  let rows = state.items;
  if (state.collection) rows = rows.filter(item => (item.data.collections || []).includes(state.collection));
  if (state.status) rows = rows.filter(item => statusOf(item) === state.status);
  if (needle) rows = rows.filter(item => matches(item, needle));
  return rows.sort((a, b) => String(b.data.dateModified || '').localeCompare(String(a.data.dateModified || '')));
}

function stars(n) { return n ? '★'.repeat(n) + '☆'.repeat(5 - n) : ''; }

function render() {
  const list = $('list');
  list.textContent = '';
  const rows = visible();
  $('count').textContent = rows.length ? `${rows.length.toLocaleString()}편` : '';
  const scope = $('scope');
  if (state.collection) {
    const name = state.collections.find(c => c.key === state.collection)?.data?.name || '컬렉션';
    scope.hidden = false; scope.textContent = '';
    el('span', {text: name}, scope);
    el('button', {type: 'button', text: '전체 보기'}, scope).addEventListener('click', () => { state.collection = ''; render(); });
  } else scope.hidden = true;

  if (!rows.length) {
    el('p', {class: 'empty', text: state.items.length ? '해당하는 논문이 없습니다.' : '아직 받은 논문이 없습니다. 오른쪽 위 새로 고침을 누르세요.'}, list);
    return;
  }
  for (const item of rows.slice(0, 400)) {
    const row = el('button', {class: 'row', type: 'button'}, list);
    el('h2', {text: clean(item.data.title) || '(제목 없음)'}, row);
    el('p', {class: 'meta', text: [authorsOf(item), yearOf(item), venueOf(item)].filter(Boolean).join(' · ')}, row);
    const foot = el('div', {class: 'foot'}, row);
    const status = statusOf(item);
    if (status) {
      const dot = el('span', {class: `dot ${status}`}, foot);
      el('i', {}, dot);
      el('span', {text: {unread: '안 읽음', reading: '읽는 중', done: '완료'}[status]}, dot);
    }
    const rating = ratingOf(item);
    if (rating) el('span', {class: 'stars', text: stars(rating)}, foot);
    if (item.data.tags?.some(t => !TAG_STATUS[t.tag])) {
      const first = item.data.tags.find(t => !TAG_STATUS[t.tag] && !/^style-custom:/.test(t.tag));
      if (first) el('span', {class: 'chip', text: clean(first.tag).slice(0, 18)}, foot);
    }
    row.addEventListener('click', () => openDetail(item.key));
  }
  if (rows.length > 400) el('p', {class: 'empty', text: `${rows.length.toLocaleString()}편 중 400편만 보입니다. 검색으로 좁혀 보세요.`}, list);
}

/* ---------- one paper ---------- */
async function openDetail(key) {
  const item = state.items.find(x => x.key === key);
  if (!item) return;
  $('detail-title').textContent = clean(item.data.title) || '논문';
  const body = $('detail-body');
  body.textContent = '';
  $('detail').hidden = false;

  const head = el('section', {class: 'card'}, body);
  el('h3', {text: clean(item.data.title) || '(제목 없음)'}, head);
  for (const [label, value] of [
    ['저자', (item.data.creators || []).filter(c => c.creatorType === 'author').map(c => clean(`${c.lastName || c.name || ''}${c.firstName ? `, ${c.firstName}` : ''}`)).join(' · ')],
    ['연도', yearOf(item)], ['저널', venueOf(item)], ['DOI', clean(item.data.DOI)]
  ]) {
    if (!value) continue;
    const row = el('div', {class: 'kv'}, head);
    el('b', {text: label}, row);
    el('span', {text: value}, row);
  }

  // Status: the same three tags the desktop plugin reads.
  const statusCard = el('section', {class: 'card'}, body);
  el('h3', {text: '상태'}, statusCard);
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
        slide(track); render(); toast('상태를 바꿨습니다');
      } catch (error) { toast(error.message); }
    });
  }
  requestAnimationFrame(() => slide(track));

  // Rating: the "Rating: N" line in Extra, as on the desktop.
  const rateCard = el('section', {class: 'card'}, body);
  el('h3', {text: '별점'}, rateCard);
  const rate = el('div', {class: 'rate'}, rateCard);
  const paint = value => [...rate.children].forEach((b, i) => b.classList.toggle('on', i < value));
  for (let n = 1; n <= 5; n++) {
    const button = el('button', {type: 'button', 'aria-label': `${n}점`, text: '★'}, rate);
    button.addEventListener('click', async () => {
      const live = state.items.find(x => x.key === key) || item;
      const next = ratingOf(live) === n ? 0 : n;
      try { await setRating(live, next); paint(next); render(); toast(next ? `${next}점` : '별점을 지웠습니다'); }
      catch (error) { toast(error.message); }
    });
  }
  paint(ratingOf(item));

  // Listening to the paper: the text Zotero indexed, body only.
  const listenCard = el('section', {class: 'card'}, body);
  const listenButton = el('button', {type: 'button', class: 'listen-start'}, listenCard);
  el('span', {class: 'play-mark', html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>'}, listenButton);
  el('span', {text: Number(localStorage.getItem(KEYS.at + key)) > 0 ? '본문 이어 듣기' : '본문 듣기'}, listenButton);
  listenButton.addEventListener('click', () => openListen(state.items.find(x => x.key === key) || item));
  const paperButton = el('button', {type: 'button', class: 'paper-start', style: 'margin-top:8px'}, listenCard);
  el('span', {class: 'play-mark', html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 13h6M10 17h4"/></svg>'}, paperButton);
  el('span', {text: 'PDF 보기'}, paperButton);
  paperButton.addEventListener('click', () => openPaper(state.items.find(x => x.key === key) || item));

  if (clean(item.data.abstractNote)) {
    const card = el('section', {class: 'card'}, body);
    el('h3', {text: '초록'}, card);
    el('p', {class: 'note', text: clean(item.data.abstractNote)}, card);
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
  const childBody = el('div', {class: 'tags', style: 'flex-direction:column;align-items:stretch;gap:10px'}, childCard);
  el('p', {class: 'muted small', text: '불러오는 중…'}, childBody);
  const noteBox = el('textarea', {rows: '3', placeholder: '새 메모', style: 'width:100%;border-radius:12px;border:1px solid var(--line);background:var(--canvas);color:var(--ink);padding:10px;font:inherit'}, childCard);
  const saveRow = el('div', {class: 'actions'}, childCard);
  const save = el('button', {class: 'secondary', type: 'button', text: '메모 저장'}, saveRow);
  save.addEventListener('click', async () => {
    const text = noteBox.value;
    if (!clean(text)) return;
    save.disabled = true;
    try { await addNote(item, text); noteBox.value = ''; toast('메모를 저장했습니다'); loadChildren(); }
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
      if (marks.length) {
        const card = el('section', {class: 'card'}, body);
        el('h3', {text: `주석 ${marks.length}개`}, card);
        for (const mark of marks.slice(0, 50)) {
          const line = el('p', {class: 'note'}, card);
          const colour = mark.data.annotationColor || 'var(--warm)';
          el('span', {style: `display:inline-block;width:6px;height:6px;border-radius:9px;background:${colour};margin-inline-end:6px;vertical-align:middle`}, line);
          el('span', {text: clean(mark.data.annotationText || mark.data.annotationComment || '(그림 주석)')}, line);
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
async function fulltextOf(attachmentKey) {
  const saved = await DB.get('text', attachmentKey).catch(() => null);
  if (saved && saved.content) return saved.content;
  const response = await api(`/items/${attachmentKey}/fulltext`);
  const body = await response.json();
  const content = String(body.content || '');
  if (content) await DB.put('text', [{key: attachmentKey, content, at: Date.now()}]).catch(() => {});
  return content;
}

const listen = {player: null, list: [], item: null, nodes: [], paper: null, wake: null, voices: []};

/* Keep the screen on while the paper is being read; the lock screen stops Safari's speech. */
async function holdScreen(on) {
  try {
    if (!('wakeLock' in navigator)) return;
    if (on && !listen.wake) listen.wake = await navigator.wakeLock.request('screen');
    if (!on && listen.wake) { await listen.wake.release(); listen.wake = null; }
  } catch (_) { listen.wake = null; }
}

function closeListen() {
  if (listen.player) listen.player.stop();
  holdScreen(false);
  $('listen').hidden = true;
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
  const left = remainingSeconds(listen.list, state.index, state.rate);
  const unit = state.unit;
  const line = state.status === 'error'
    ? '이 폰의 목소리가 멈췄습니다. 다시 눌러 주세요.'
    : `${state.index + 1} / ${state.total}${unit && unit.page ? ` · ${unit.page}쪽` : ''} · 남은 시간 약 ${Math.max(1, Math.round(left / 60))}분`;
  if (listen.item) localStorage.setItem(KEYS.at + listen.item.key, String(state.index));
  holdScreen(playing);
  if (!$('listen').hidden) {
    $('listen-where').textContent = line;
    playMark($('listen-play'), playing);
    paintListen(state);
  }
  if (!$('paper').hidden) {
    $('paper-where').textContent = line;
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
  for (const other of listen.nodes) if (other && other.getAttribute('aria-current')) other.removeAttribute('aria-current');
  if (node) {
    node.setAttribute('aria-current', 'true');
    try { node.scrollIntoView?.({block: 'center', behavior: 'smooth'}); } catch (_) { try { node.scrollIntoView?.(); } catch (__) {} }
  }
}

function renderTranscript(list) {
  const body = $('listen-body');
  body.textContent = '';
  listen.nodes = [];
  let section = null;
  list.forEach((unit, index) => {
    if (unit.section && unit.section !== section) { section = unit.section; el('p', {class: 'sec', text: section}, body); }
    const node = el('button', {type: 'button', class: `sent${unit.kind === 'caption' ? ' caption' : ''}`, text: unit.text}, body);
    node.addEventListener('click', () => { listen.player.play(index); });
    listen.nodes[index] = node;
  });
}

function fillVoiceMenu(lang) {
  const select = $('listen-voice');
  const same = listen.voices.filter(v => String(v.lang || '').toLowerCase().startsWith(lang));
  const offered = (same.length ? same : listen.voices).slice(0, 60);
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
  $('listen-title').textContent = clean(item.data.title) || '논문';
  const body = $('listen-body');
  body.textContent = '';
  $('listen-bar').hidden = true;
  $('listen').hidden = false;
  el('p', {class: 'muted small', text: '본문을 가져오는 중…'}, body);

  let text = '';
  try {
    const attachment = await attachmentOf(item.key);
    if (!attachment) throw new Error('이 문헌에는 PDF 첨부가 없습니다.');
    text = await fulltextOf(attachment.key);
  } catch (error) {
    body.textContent = '';
    const card = el('section', {class: 'card'}, body);
    el('h3', {text: '읽을 본문이 없습니다'}, card);
    el('p', {class: 'muted small', text: error.status === 404
      ? 'Zotero가 이 PDF의 본문을 아직 색인하지 않았습니다. 맥에서 PDF를 한 번 열고 동기화한 뒤 다시 시도하세요.'
      : error.message}, card);
    return;
  }
  if (!clean(text)) {
    body.textContent = '';
    el('p', {class: 'muted small', text: '색인된 본문이 비어 있습니다. 맥에서 PDF를 한 번 열어 주세요.'}, body);
    return;
  }

  const paper = readable(text, {title: clean(item.data.title)});
  listen.paper = paper;
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
  buildScope(lang, withCaptions);
  $('listen-bar').hidden = false;
  paintReading(listen.player.state());
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
    go.addEventListener('click', () => { $('paper').hidden = true; openSettings(); });
  }
}

const paper = {viewer: null, item: null, following: 0};

/* While there is something to say, it stands where the page would be. */
function showPaperMessage(on) {
  $('paper-msg').hidden = !on;
  $('paper-view').hidden = on;
}

function closePaper() {
  if (paper.viewer) { paper.viewer.destroy(); paper.viewer = null; }
  $('paper-view').classList.remove('with-player');
  if (listen.player && $('listen').hidden) listen.player.stop();
  holdScreen(false);
  $('paper').hidden = true;
}

async function openPaper(item, {at = 0} = {}) {
  if (paper.viewer) { paper.viewer.destroy(); paper.viewer = null; }
  paper.following = 0;
  paper.item = item;
  listen.item = item;
  $('paper-title').textContent = clean(item.data.title) || '논문';
  $('paper-view').textContent = '';
  $('paper-view').classList.remove('with-player');
  $('paper-count').textContent = '';
  $('paper-bar').hidden = true;
  $('paper').hidden = false;
  const msg = $('paper-msg');
  showPaperMessage(true);
  msg.textContent = '';
  const waiting = el('p', {class: 'muted small', text: 'PDF를 찾는 중…'}, msg);

  let attachment = null;
  try {
    attachment = await attachmentOf(item.key);
    if (!attachment) throw new Error('이 문헌에는 PDF 첨부가 없습니다.');
    const bytes = await fileBytes(attachment, step => { waiting.textContent = step; });
    waiting.textContent = '여는 중…';
    const pdfjs = await loadPdfjs();
    if ($('paper').hidden) return;
    showPaperMessage(false);
    paper.viewer = createViewer({
      root: $('paper-view'), pdfjs,
      onPage: (n, total) => { $('paper-count').textContent = `${n} / ${total}`; }
    });
    await paper.viewer.open(bytes.slice(0), PDF_ASSETS);   // pdf.js takes the buffer over; the kept copy must survive
    if (at > 0) paper.viewer.goto(at);
  } catch (error) {
    paperTrouble(error);
    return;
  }
  // The voice is offered once the page is up, and only if there is text to read.
  readAlong(item, attachment).catch(() => {});
}

/* The player on the PDF screen: the same one the transcript uses, so a paper carries on from
   where it was left whichever screen it is read on. */
async function readAlong(item, attachment) {
  const bar = $('paper-bar');
  const engine = speechEngine(window);
  if (!engine.available() || !attachment) return;
  let text = '';
  try { text = await fulltextOf(attachment.key); } catch (_) { return; }
  if (!clean(text) || $('paper').hidden || paper.item !== item) return;

  listen.paper = readable(text, {title: clean(item.data.title)});
  listen.list = readingUnits(listen.paper, {captions: false});
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

/* ---------- settings ---------- */
function openSettings() {
  const body = $('settings-body');
  body.textContent = '';
  $('settings').hidden = false;

  const card = el('section', {class: 'card'}, body);
  el('h3', {text: 'Dropbox — PDF 원본'}, card);
  const state = el('p', {class: 'settings-state'}, card);
  el('span', {class: `dot ${dropbox.linked ? 'on' : 'off'}`}, state);
  el('span', {text: dropbox.linked ? '연결되어 있습니다.' : '연결되어 있지 않습니다.'}, state);
  el('p', {class: 'muted small', text:
    '이 라이브러리의 PDF는 Zotero 서버가 아니라 Dropbox 폴더에 있습니다. 그래서 Zotero 키만으로는 원본을 열 수 없고, ' +
    '폰이 Dropbox에 직접 물어봐야 합니다. 아래 앱은 이 폰과 내 Dropbox 사이에만 쓰이고, 토큰은 이 폰에만 저장됩니다.'}, card);

  const appKey = el('label', {class: 'field'}, card);
  el('span', {text: 'Dropbox 앱 키'}, appKey);
  const appInput = el('input', {type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'App key'}, appKey);
  appInput.value = dropbox.appKey;

  const baseField = el('label', {class: 'field'}, card);
  el('span', {text: '라이브러리 폴더 (Dropbox 안의 경로)'}, baseField);
  const baseInput = el('input', {type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: DEFAULT_BASE}, baseField);
  baseInput.value = dropbox.base;

  const steps = el('ol', {class: 'steps'}, card);
  el('li', {html: '<a href="https://www.dropbox.com/developers/apps" target="_blank" rel="noopener">dropbox.com/developers/apps</a>에서 <b>Create app</b> → Scoped access → <b>Full Dropbox</b>.'}, steps);
  el('li', {html: 'Permissions 탭에서 <b>files.metadata.read</b>와 <b>files.content.read</b>를 켜고 Submit.'}, steps);
  el('li', {html: `Settings 탭의 <b>Redirect URIs</b>에 <code>${redirectUri()}</code>를 넣고 Add.`}, steps);
  el('li', {html: '같은 탭의 <b>App key</b>를 위에 붙여넣고 아래 연결을 누릅니다.'}, steps);

  const row = el('div', {class: 'actions'}, card);
  const connect = el('button', {class: 'primary', type: 'button', text: dropbox.linked ? '다시 연결' : '연결'}, row);
  connect.addEventListener('click', async () => {
    dropbox.appKey = appInput.value;
    dropbox.base = baseInput.value || DEFAULT_BASE;
    if (!dropbox.appKey) { toast('앱 키를 넣어 주세요'); return; }
    try { location.assign(await dropbox.begin(redirectUri())); }
    catch (error) { toast(error.message); }
  });
  const save = el('button', {class: 'secondary', type: 'button', text: '폴더만 저장'}, row);
  save.addEventListener('click', () => {
    dropbox.appKey = appInput.value;
    dropbox.base = baseInput.value || DEFAULT_BASE;
    toast('저장했습니다');
  });
  if (dropbox.linked) {
    const drop = el('button', {class: 'secondary', type: 'button', text: '연결 끊기'}, row);
    drop.addEventListener('click', () => { dropbox.forget(); toast('Dropbox 연결을 끊었습니다'); openSettings(); });
  }

  // What this phone is holding.
  const store = el('section', {class: 'card'}, body);
  el('h3', {text: '이 폰에 받아 둔 것'}, store);
  const line = el('p', {class: 'muted small', text: '세는 중…'}, store);
  const storeRow = el('div', {class: 'actions'}, store);
  const wipe = el('button', {class: 'secondary', type: 'button', text: 'PDF 비우기'}, storeRow);
  wipe.addEventListener('click', async () => {
    await DB.clear('files').catch(() => {});
    toast('받아 둔 PDF를 지웠습니다');
    openSettings();
  });
  const again = el('button', {class: 'secondary', type: 'button', text: '라이브러리 다시 받기'}, storeRow);
  again.addEventListener('click', async () => {
    account.version = 0;
    $('settings').hidden = true;
    await sync({full: true});
  });
  DB.all('files').then(rows => {
    const size = rows.reduce((sum, row) => sum + (row.size || 0), 0);
    line.textContent = `PDF ${rows.length}개 · ${(size / 1048576).toFixed(1)} MB · 논문 ${state_items()}편`;
  }).catch(() => { line.textContent = `논문 ${state_items()}편`; });

  const zotero = el('section', {class: 'card'}, body);
  el('h3', {text: 'Zotero'}, zotero);
  el('p', {class: 'muted small', text: `사용자 번호 ${account.user} · 키는 이 폰에만 있습니다.`}, zotero);
}
const state_items = () => state.items.length.toLocaleString();

/* ---------- collections ---------- */
function openCollections() {
  const body = $('collections-body');
  body.textContent = '';
  $('collections').hidden = false;
  const byParent = new Map();
  for (const c of state.collections) {
    const parent = c.data.parentCollection || '';
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(c);
  }
  const counts = new Map();
  for (const item of state.items) for (const key of item.data.collections || []) counts.set(key, (counts.get(key) || 0) + 1);

  const all = el('button', {class: 'row', type: 'button'}, body);
  el('h2', {text: '전체'}, all);
  el('p', {class: 'meta', text: `${state.items.length.toLocaleString()}편`}, all);
  all.addEventListener('click', () => { state.collection = ''; $('collections').hidden = true; render(); });

  const draw = (parent, depth) => {
    for (const c of (byParent.get(parent) || []).sort((a, b) => a.data.name.localeCompare(b.data.name, 'ko'))) {
      const row = el('button', {class: 'row', type: 'button', style: depth ? `margin-inline-start:${depth * 14}px` : null}, body);
      el('h2', {text: clean(c.data.name)}, row);
      el('p', {class: 'meta', text: `${(counts.get(c.key) || 0).toLocaleString()}편`}, row);
      row.addEventListener('click', () => { state.collection = c.key; $('collections').hidden = true; render(); });
      draw(c.key, depth + 1);
    }
  };
  draw('', 0);
}

/* ---------- start ---------- */
/* The card that offers to carry the key: only in Safari, only once the library is there. */
function offerPairing() {
  const card = $('pair');
  if (!card || standalone() || !account.ready || localStorage.getItem(KEYS.scope) === 'paired') return;
  card.hidden = false;
  $('pair-hide').addEventListener('click', () => { card.hidden = true; });
  $('pair-go').addEventListener('click', () => {
    const extra = dropbox.linked
      ? `&a=${encodeURIComponent(dropbox.appKey)}&d=${encodeURIComponent(localStorage.getItem('np.db.refresh') || '')}&b=${encodeURIComponent(dropbox.base)}`
      : '';
    location.hash = `k=${encodeURIComponent(account.key)}&u=${encodeURIComponent(account.user)}${extra}`;
    localStorage.setItem(KEYS.scope, 'paired');
    $('pair-text').innerHTML = '주소에 키를 담았습니다. 이제 아래 <b>공유 버튼 → 홈 화면에 추가</b>를 누르세요. 홈 화면 앱이 열릴 때 키가 자동으로 들어갑니다.';
    $('pair-go').hidden = true;
    $('pair-hide').textContent = '닫기';
  });
}

function wire() {
  const paste = $('setup-paste');
  if (paste) paste.addEventListener('click', async () => {
    try {
      const text = clean(await navigator.clipboard.readText());
      if (text) { $('setup-key').value = text; toast('붙여넣었습니다'); }
      else toast('클립보드가 비어 있습니다');
    } catch (_) { toast('길게 눌러 붙여넣기를 쓰세요'); }
  });
  $('q').addEventListener('input', event => { state.q = event.target.value; render(); });
  $('btn-sync').addEventListener('click', () => sync());
  $('btn-collections').addEventListener('click', openCollections);
  $('back').addEventListener('click', () => { $('detail').hidden = true; });
  $('listen-back').addEventListener('click', closeListen);
  $('listen-play').addEventListener('click', () => { if (listen.player) listen.player.toggle(); });
  $('listen-prev').addEventListener('click', () => { if (listen.player) listen.player.prev(); });
  $('listen-next').addEventListener('click', () => { if (listen.player) listen.player.next(); });
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
  $('collections-back').addEventListener('click', () => { $('collections').hidden = true; });
  $('btn-settings').addEventListener('click', () => { $('collections').hidden = true; openSettings(); });
  $('settings-back').addEventListener('click', () => { $('settings').hidden = true; });
  $('listen-pdf').addEventListener('click', () => {
    if (!listen.item) return;
    const unit = listen.player ? listen.player.state().unit : null;
    $('listen').hidden = true;
    openPaper(listen.item, {at: unit && unit.page ? unit.page : 0});
  });
  $('paper-back').addEventListener('click', closePaper);
  $('paper-in').addEventListener('click', () => { if (paper.viewer) paper.viewer.zoomBy(1); });
  $('paper-out').addEventListener('click', () => { if (paper.viewer) paper.viewer.zoomBy(-1); });
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
  sync();
  if (paired) toast('키가 함께 들어왔습니다');
  else offerPairing();
}

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
start();

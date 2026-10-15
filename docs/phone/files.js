/* Getting the PDF itself onto the phone.

   Where a paper's file actually lives decides this. Zotero's API serves the bytes only for the
   attachments it stores itself (linkMode imported_file / imported_url). This library keeps almost
   everything as a **linked file**: Zotero holds the path and the file sits in the Dropbox folder
   the library points at. Those bytes never reach Zotero's servers, so no key to api.zotero.org
   can fetch them — the phone has to ask Dropbox for them.

     attachment.data.linkMode   where the bytes are            how they are fetched
     imported_file / _url       Zotero storage                 GET /items/<key>/file
     linked_file                the Dropbox folder             POST /2/files/download
     linked_url                 nowhere; it is only a link     not at all

   Dropbox is reached with the user's own Dropbox app, through the PKCE flow, so there is no
   secret in this page and no server of ours in between: the browser gets a refresh token that
   stays in this phone's localStorage, exactly like the Zotero key.

   Everything here is either pure or takes its fetch and its storage as arguments, so the path
   building and the token handling are checked without a phone and without a network. */

export const DROPBOX = {
  authorize: 'https://www.dropbox.com/oauth2/authorize',
  token: 'https://api.dropboxapi.com/oauth2/token',
  download: 'https://content.dropboxapi.com/2/files/download',
  search: 'https://api.dropboxapi.com/2/files/search_v2',
  list: 'https://api.dropboxapi.com/2/files/list_folder',
  more: 'https://api.dropboxapi.com/2/files/list_folder/continue',
  link: 'https://api.dropboxapi.com/2/files/get_temporary_link'
};

/* ---------- where a file is ---------- */

/* The Dropbox path for a Zotero linked-file path.

   Zotero writes a linked file either relative to the base directory ("attachments:A/B.pdf") or
   as a full path. The base directory on the Mac is somewhere inside the Dropbox folder, and
   Dropbox's own paths start at the top of that folder, so what is needed is the part after it:
   "/0.Personal folder/0. Zotero". A full path is cut at its own "/Dropbox/" instead.

   Dropbox stores its names composed (NFC) while macOS hands them over decomposed (NFD); a Korean
   folder name differs in nothing else, so the name is composed here or nothing would be found. */
export function dropboxPath(zoteroPath, base = '') {
  const raw = String(zoteroPath || '').trim();
  if (!raw) return '';
  let relative = '';
  if (raw.startsWith('attachments:')) relative = raw.slice('attachments:'.length);
  else if (raw.startsWith('storage:')) return '';
  else if (/^[\\/]|^[A-Za-z]:/.test(raw)) {
    // A full path: everything below the Dropbox folder itself, whatever it is called locally.
    const cut = raw.replace(/\\/g, '/').match(/\/Dropbox[^/]*\/(.+)$/);
    if (!cut) return '';
    return tidy('/' + cut[1]);
  } else relative = raw;
  if (!relative) return '';
  const folder = String(base || '').trim().replace(/\/+$/, '');
  return tidy(`${folder ? (folder.startsWith('/') ? folder : '/' + folder) : ''}/${relative}`);
}
const tidy = path => path.replace(/\/{2,}/g, '/').normalize('NFC');

/* What to do about one attachment, before anything is fetched. */
export function fileSource(attachment, base = '') {
  const data = (attachment && attachment.data) || attachment || {};
  const mode = String(data.linkMode || '');
  if (mode === 'imported_file' || mode === 'imported_url') return {kind: 'zotero', key: data.key || ''};
  if (mode === 'linked_file') {
    const path = dropboxPath(data.path, base);
    return path ? {kind: 'dropbox', path, name: String(data.filename || data.title || '')}
                : {kind: 'none', why: 'base'};
  }
  if (mode === 'linked_url') return {kind: 'none', why: 'link'};
  // An older or odd attachment: if it names a path, treat it as a linked file anyway.
  const path = dropboxPath(data.path, base);
  return path ? {kind: 'dropbox', path, name: String(data.filename || '')} : {kind: 'none', why: 'unknown'};
}

/* ---------- Dropbox, through the user's own app ---------- */

const b64url = bytes => {
  let s = '';
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/* A Dropbox-API-Arg header has to be plain ASCII, and these paths are full of Korean. */
export function headerArg(value) {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

export const DROPBOX_KEYS = {
  app: 'np.db.app', base: 'np.db.base', refresh: 'np.db.refresh',
  access: 'np.db.access', until: 'np.db.until', pkce: 'np.db.pkce'
};

/* The folder this library's files sit in, as Dropbox sees it. The Mac knows it as
   ~/Dropbox/0.Personal folder/0. Zotero, and Dropbox's own paths start below ~/Dropbox. */
export const DEFAULT_BASE = '/0.Personal folder/0. Zotero';

export function createDropbox({
  store = localStorage,
  fetchImpl = (...args) => fetch(...args),
  randomBytes = n => { const out = new Uint8Array(n); crypto.getRandomValues(out); return out; },
  digest = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
  now = () => Date.now()
} = {}) {
  const get = key => store.getItem(key) || '';
  const set = (key, value) => (value ? store.setItem(key, value) : store.removeItem(key));

  const self = {
    get appKey() { return get(DROPBOX_KEYS.app); },
    set appKey(value) { set(DROPBOX_KEYS.app, String(value || '').trim()); },
    get base() { return get(DROPBOX_KEYS.base) || DEFAULT_BASE; },
    set base(value) {
      const folder = String(value || '').trim().replace(/\/+$/, '');
      set(DROPBOX_KEYS.base, folder && !folder.startsWith('/') ? '/' + folder : folder);
    },
    get linked() { return !!(get(DROPBOX_KEYS.app) && get(DROPBOX_KEYS.refresh)); },

    /* Step one: the address to send the phone to. The verifier is kept here and never sent,
       which is what makes the flow safe without a client secret. */
    async begin(redirectUri) {
      if (!self.appKey) throw new Error('Dropbox 앱 키가 없습니다.');
      const verifier = b64url(randomBytes(48));
      set(DROPBOX_KEYS.pkce, verifier);
      const challenge = b64url(await digest(verifier));
      const query = new URLSearchParams({
        client_id: self.appKey, response_type: 'code', code_challenge: challenge,
        code_challenge_method: 'S256', token_access_type: 'offline', redirect_uri: redirectUri
      });
      return `${DROPBOX.authorize}?${query}`;
    },

    /* Step two: the code Dropbox sent back, traded for a refresh token that lasts. */
    async finish(code, redirectUri) {
      const verifier = get(DROPBOX_KEYS.pkce);
      if (!verifier) throw new Error('이 폰에서 시작한 연결이 아닙니다. 다시 눌러 주세요.');
      const body = new URLSearchParams({
        code, grant_type: 'authorization_code', client_id: self.appKey,
        code_verifier: verifier, redirect_uri: redirectUri
      });
      const response = await fetchImpl(DROPBOX.token, {
        method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: String(body)
      });
      const answer = await response.json().catch(() => ({}));
      if (!response.ok || !answer.refresh_token) throw new Error(dropboxWhy(answer, response.status));
      set(DROPBOX_KEYS.pkce, '');
      set(DROPBOX_KEYS.refresh, answer.refresh_token);
      set(DROPBOX_KEYS.access, answer.access_token || '');
      set(DROPBOX_KEYS.until, String(now() + Number(answer.expires_in || 14400) * 1000));
      return true;
    },

    /* A token good for the next minute at least; Dropbox's own last four hours. */
    async access() {
      const until = Number(get(DROPBOX_KEYS.until) || 0);
      const held = get(DROPBOX_KEYS.access);
      if (held && until - now() > 60000) return held;
      const refresh = get(DROPBOX_KEYS.refresh);
      if (!refresh) throw Object.assign(new Error('Dropbox가 연결되어 있지 않습니다.'), {need: 'dropbox'});
      const body = new URLSearchParams({grant_type: 'refresh_token', refresh_token: refresh, client_id: self.appKey});
      const response = await fetchImpl(DROPBOX.token, {
        method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: String(body)
      });
      const answer = await response.json().catch(() => ({}));
      if (!response.ok || !answer.access_token) {
        if (response.status === 400 || response.status === 401) self.forget();
        throw Object.assign(new Error(dropboxWhy(answer, response.status)), {need: 'dropbox'});
      }
      set(DROPBOX_KEYS.access, answer.access_token);
      set(DROPBOX_KEYS.until, String(now() + Number(answer.expires_in || 14400) * 1000));
      return answer.access_token;
    },

    /* The bytes. A path that is not found is looked for by name once: a file renamed or moved
       inside the folder is still the one the paper means. */
    async download(path) {
      const token = await self.access();
      const response = await fetchImpl(DROPBOX.download, {
        method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': headerArg({path})}
      });
      if (response.ok) return await response.arrayBuffer();
      const text = await response.text().catch(() => '');
      if (response.status === 409 && /not_found/.test(text)) {
        const found = await self.find(path);
        if (found && found !== path) return await self.download(found);
        throw Object.assign(new Error('Dropbox에 이 파일이 없습니다. 맥에서 Dropbox 동기화가 끝났는지 확인하세요.'), {missing: true});
      }
      if (response.status === 401) { self.forget(); throw Object.assign(new Error('Dropbox 연결이 만료되었습니다. 다시 연결해 주세요.'), {need: 'dropbox'}); }
      throw new Error(`Dropbox 오류 (${response.status})`);
    },

    /* What is in one folder, by name. One request answers for every paper, which matters on a phone:
       asking per paper cost a round trip for each name that was not there. A folder that does not
       exist is not a failure — it means nothing has been baked yet.

       Dropbox answers a page at a time and says so (`has_more`); a folder of 240 baked papers is
       481 files, so the rest is asked for rather than assumed away. Without this the papers baked
       last were simply invisible on the phone, which is indistinguishable from never baked. */
    async list(folder) {
      const token = await self.access();
      const head = {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'};
      const out = [];
      let where = DROPBOX.list;
      let body = JSON.stringify({path: String(folder || ''), recursive: false, limit: 500});
      for (let page = 0; page < 40; page++) {
        const response = await fetchImpl(where, {method: 'POST', headers: head, body});
        if (response.status === 409) return out;
        if (response.status === 401) { self.forget(); throw Object.assign(new Error('Dropbox 연결이 만료되었습니다. 다시 연결해 주세요.'), {need: 'dropbox'}); }
        if (!response.ok) throw new Error(`Dropbox 오류 (${response.status})`);
        const answer = await response.json().catch(() => ({}));
        for (const e of answer.entries || []) {
          if (!e || e['.tag'] !== 'file' || !e.name) continue;
          out.push({name: e.name, path: e.path_display || `${folder}/${e.name}`,
                    size: e.size || 0, at: e.server_modified || ''});
        }
        if (!answer.has_more || !answer.cursor) break;
        where = DROPBOX.more;
        body = JSON.stringify({cursor: answer.cursor});
      }
      return out;
    },

    /* A link an audio element can play straight from, instead of 15 MB that must arrive first.
       Dropbox serves it with byte ranges, so it starts at once and seeks; it is good for four
       hours, which is longer than any paper. */
    async link(path) {
      const token = await self.access();
      const response = await fetchImpl(DROPBOX.link, {
        method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({path: String(path || '')})
      });
      if (response.status === 401) { self.forget(); throw Object.assign(new Error('Dropbox 연결이 만료되었습니다. 다시 연결해 주세요.'), {need: 'dropbox'}); }
      if (!response.ok) return '';
      const answer = await response.json().catch(() => ({}));
      return String(answer.link || '');
    },

    /* The same file name anywhere under the library folder. */
    async find(path) {
      const name = String(path).split('/').pop();
      if (!name) return '';
      const token = await self.access();
      const response = await fetchImpl(DROPBOX.search, {
        method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({query: name, options: {path: self.base, max_results: 20, filename_only: true}})
      });
      if (!response.ok) return '';
      const answer = await response.json().catch(() => ({}));
      const hits = (answer.matches || []).map(m => m.metadata?.metadata).filter(m => m && m.path_display);
      const exact = hits.find(m => m.name === name) || hits[0];
      return exact ? exact.path_display : '';
    },

    forget() {
      for (const key of [DROPBOX_KEYS.refresh, DROPBOX_KEYS.access, DROPBOX_KEYS.until, DROPBOX_KEYS.pkce]) set(key, '');
    }
  };
  return self;
}

function dropboxWhy(answer, status) {
  const code = String(answer && (answer.error_description || answer.error_summary || answer.error) || '');
  if (/invalid_grant|expired/.test(code)) return 'Dropbox 승인이 만료되었습니다. 다시 연결해 주세요.';
  if (/invalid_client|client_id/.test(code)) return 'Dropbox 앱 키가 올바르지 않습니다.';
  return `Dropbox 오류 (${status})${code ? ` — ${code}` : ''}`;
}

/* The code Dropbox hands back in the address, if this is that return trip. */
export function returningCode(search) {
  const query = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  if (query.get('error')) return {error: query.get('error_description') || query.get('error')};
  const code = query.get('code');
  return code ? {code} : {};
}

/* ---------- one paper's file ---------- */
/* From this phone first, then from wherever it lives. Kept apart from the app so the order, the
   errors and what is asked of each service are checked without a phone. */
export async function paperFile({attachment, base = '', cache = null, zoteroFile = null, dropbox = null, onStep = () => {}} = {}) {
  const key = (attachment && (attachment.key || attachment.data?.key)) || '';
  if (cache) {
    const held = await cache.get(key).catch(() => null);
    if (held && held.byteLength) { cache.touch?.(key); return held; }
  }
  const source = fileSource(attachment, base);
  if (source.kind === 'none') {
    throw Object.assign(new Error(source.why === 'link'
      ? '이 첨부는 파일이 아니라 링크입니다.'
      : '이 첨부의 파일 위치를 알 수 없습니다.'), {source});
  }
  onStep('내려받는 중…');
  let bytes;
  if (source.kind === 'zotero') {
    if (!zoteroFile) throw new Error('Zotero에서 파일을 가져올 수 없습니다.');
    bytes = await zoteroFile(key);
  } else {
    if (!dropbox || !dropbox.linked) {
      throw Object.assign(new Error('이 PDF는 Dropbox 폴더에 있습니다. Dropbox를 연결해 주세요.'), {need: 'dropbox', source});
    }
    bytes = await dropbox.download(source.path);
  }
  if (!bytes || bytes.byteLength < 5) throw new Error('받은 파일이 비어 있습니다.');
  if (cache) await cache.put(key, bytes).catch(() => {});
  return bytes;
}

/* ---------- the audio this Mac baked ----------
   The Zotero plugin's bridge reads a whole paper with Supertonic and leaves one m4b audiobook in a
   sync folder (bridge/tts/book.mjs). Dropbox is already connected here for the PDFs, so that file is
   reachable from the phone: it is the same voice the Mac has, it plays with the screen off, and the
   car's buttons work on it, none of which a web page's own speech can do.

   The name has to be worked out the same way the baker worked it out, which is why safeName is
   repeated here rather than guessed at. */
export const AUDIO_BASE = '/논문 음성';
export const AUDIO_KEY = 'np.db.audio';

export function safeName(title, limit = 90) {
  const one = String(title == null ? '' : title).replace(/\s+/g, ' ').trim();
  const safe = one.replace(/[\/\\:*?"<>|\x00-\x1f]/g, '-').replace(/^[.\s-]+/, '').replace(/[.\s-]+$/, '');
  if (!safe) return '논문';
  return safe.length <= limit ? safe : safe.slice(0, limit).replace(/\s+\S*$/, '') || safe.slice(0, limit);
}

/* Where to look, newest copy first: a paper baked twice is "<name> (2).m4b". */
export function bakedPaths(title, folder = AUDIO_BASE, copies = 4) {
  const base = safeName(title), where = String(folder || AUDIO_BASE).replace(/\/+$/, '') || AUDIO_BASE;
  const out = [];
  for (let n = copies; n >= 2; n--) out.push(`${where}/${base} (${n}).m4b`);
  out.push(`${where}/${base}.m4b`);
  return out;
}

/* The bytes of the baked paper, and the sidecar beside it when there is one. Nothing is downloaded
   twice: what the phone already has is kept in the same store the PDFs use. */
/* What the Mac has baked. One listing answers for every paper, so it is kept — but not for the
   whole life of the app: the Mac bakes while the phone is open, and a listing taken this morning
   says a paper finished at noon was never baked. It is taken again when it is older than a few
   minutes, and the pull to refresh throws it away outright. */
export const INDEX_FRESH = 180000;
export function bakedIndex({dropbox, folder = AUDIO_BASE, fresh = INDEX_FRESH, now = () => Date.now()} = {}) {
  let held = null, at = 0, asking = null;
  return {
    async names({refresh = false} = {}) {
      if (held && !refresh && now() - at < fresh) return held;
      if (!dropbox || !dropbox.linked) { held = []; at = now(); return held; }
      // Two papers opened at once ask one question between them.
      if (!asking) asking = dropbox.list(folder).catch(() => null).then(list => {
        asking = null;
        if (list) { held = list; at = now(); }
        return held || [];
      });
      return await asking;
    },
    /* Whether this one name is there, without a fresh listing when one was just taken. */
    async has(name) {
      const list = await this.names();
      return list.some(entry => entry.name === name);
    },
    get taken() { return at; },
    forget() { held = null; at = 0; }
  };
}

export async function bakedAudio({title, folder = AUDIO_BASE, dropbox, cache = null, index = null,
                                  stream = true, onStep = () => {}} = {}) {
  if (!dropbox || !dropbox.linked) return null;
  const paths = bakedPaths(title, folder);
  for (const path of paths) {
    if (cache) {
      const held = await cache.get(path).catch(() => null);
      if (held) return {path, bytes: held, fromCache: true};
    }
  }
  /* One listing of the folder decides which of the names is there, instead of a failed download for
     each name that is not. */
  const listing = index ? await index.names() : null;
  /* macOS hands a Korean name over decomposed and Dropbox holds it composed, so the two spellings
     of one name are compared in one spelling. */
  const there = listing ? new Set(listing.map(entry => String(entry.name).normalize('NFC'))) : null;
  const want = there ? paths.filter(path => there.has(path.split('/').pop().normalize('NFC'))) : paths;
  if (!want.length) return null;
  onStep('찾는 중');
  /* Played from a link rather than fetched whole. A baked paper is 10–30 MB: waiting for all of it
     before the voice was even offered meant that on a phone away from wifi the Mac's voice simply
     never appeared, which looked exactly like nothing having been baked. */
  if (stream) {
    for (const path of want) {
      let url = '';
      try { url = await dropbox.link(path); } catch (_) { url = ''; }
      if (url) return {path, url, fromCache: false};
    }
  }
  for (const path of want) {
    let bytes = null;
    try { bytes = await dropbox.download(path); }
    catch (error) { if (error && error.missing) continue; throw error; }
    if (!bytes) continue;
    if (cache) await cache.put(path, bytes).catch(() => {});
    return {path, bytes, fromCache: false};
  }
  return null;
}

/* The same file put away for a journey with no signal. Called once the reader is actually
   listening to it, not when it is merely offered: nobody wants 20 MB spent on a paper they
   glanced at. */
export async function keepBaked({path, dropbox, cache}) {
  if (!path || !dropbox || !cache) return false;
  const held = await cache.get(path).catch(() => null);
  if (held) return true;
  let bytes = null;
  try { bytes = await dropbox.download(path); } catch (_) { return false; }
  if (!bytes) return false;
  await cache.put(path, bytes).catch(() => {});
  return true;
}

/* The times beside the audio: chapters, and where every sentence starts. Missing is not a failure —
   the file plays without it, it just cannot follow along. */
export async function bakedMarks({path, dropbox}) {
  if (!dropbox || !path) return null;
  try {
    const bytes = await dropbox.download(path.replace(/\.m4b$/, '.json'));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (_) { return null; }
}

/* ---------- what Zotero does not know ----------
   The impact factor, how often a paper has been cited, and where the work was done are all worked
   out by the Zotero plugin on the Mac and kept in its own data file. None of it is in Zotero, so
   none of it comes down the API. The plugin leaves a small file beside the baked audio
   (`library.json`, about 140 KB for 1,200 papers, no titles and no abstracts in it) and this reads
   it: once per session, from the folder the phone is already listing. */
export const FACTS_FILE = 'library.json';

export async function libraryFacts({folder = AUDIO_BASE, dropbox, index = null} = {}) {
  if (!dropbox || !dropbox.linked) return null;
  const where = `${String(folder || AUDIO_BASE).replace(/\/+$/, '')}/${FACTS_FILE}`;
  if (index) {
    const listing = await index.names();
    if (!listing.some(entry => entry.name === FACTS_FILE)) return null;
  }
  let bytes = null;
  try { bytes = await dropbox.download(where); }
  catch (error) { if (error && error.missing) return null; throw error; }
  if (!bytes) return null;
  let parsed = null;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { return null; }
  if (!parsed || typeof parsed !== 'object' || !parsed.papers) return null;
  return {papers: parsed.papers || {}, journals: parsed.journals || {}, made: parsed.made || ''};
}

/* A two-letter country as the flag a phone draws for it. Anything else is left as it came. */
export function flagOf(code) {
  const two = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(two)) return '';
  return String.fromCodePoint(...[...two].map(letter => 0x1f1e6 + letter.charCodeAt(0) - 65));
}

/* The ink the Mac paints this journal's name in — light and dark, both measured there against the
   page they are read on. A journal whose masthead has no colour of its own (Nature's is black) has
   none here either, and its name is left in the plain meta ink rather than dressed in a grey that
   would say the same as every other grey. */
export function inkFor(facts, venue) {
  const name = String(venue || '').trim();
  const row = facts && facts.journals ? facts.journals[name] : null;
  return row && row.ink && row.inkDark ? {ink: String(row.ink), dark: String(row.inkDark)} : null;
}

/* The seven colours a paper can be marked with by hand on the Mac. The plugin names the same seven
   and a test holds the two lists together, the way it does for the bands. */
export const MARKS = ['red', 'orange', 'gold', 'green', 'teal', 'blue', 'purple'];
export const markOf = fact => (fact && MARKS.includes(fact.mark) ? fact.mark : '');

/* The band a journal's figure falls in, the same four the plugin uses. */
export const BANDS = [[30, 'top'], [10, 'high'], [5, 'mid'], [0, 'low']];
export function bandOf(jif) {
  const n = Number(jif);
  if (!Number.isFinite(n) || n <= 0) return '';
  for (const [floor, name] of BANDS) if (n >= floor) return name;
  return 'low';
}

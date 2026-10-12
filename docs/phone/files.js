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
  search: 'https://api.dropboxapi.com/2/files/search_v2'
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

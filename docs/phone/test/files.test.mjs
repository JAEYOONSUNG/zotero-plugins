/* Where a paper's PDF is, and how it is fetched. Nothing here touches a network or a phone: the
   Dropbox client is given its own fetch and its own storage. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {dropboxPath, fileSource, headerArg, createDropbox, returningCode, paperFile, DROPBOX, DEFAULT_BASE} from '../files.js';
import * as F from '../files.js';

const BASE = '/0.Personal folder/0. Zotero';
const linked = (path, extra = {}) => ({key: 'ATT1', data: {key: 'ATT1', itemType: 'attachment', linkMode: 'linked_file', contentType: 'application/pdf', path, ...extra}});
const stored = () => ({key: 'ATT2', data: {key: 'ATT2', itemType: 'attachment', linkMode: 'imported_file', contentType: 'application/pdf', filename: 'a.pdf'}});

/* localStorage, as a Map. */
function fakeStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k), map};
}
const bytes = n => new Uint8Array(n).fill(7).buffer;

test('a Zotero linked path becomes the path Dropbox knows the file by', () => {
  assert.equal(dropboxPath('attachments:Defense system/s41564.pdf', BASE), `${BASE}/Defense system/s41564.pdf`);
  assert.equal(dropboxPath('attachments:a.pdf', '0.Personal folder'), '/0.Personal folder/a.pdf', 'a folder without its slash still works');
  assert.equal(dropboxPath('attachments://odd//slashes.pdf', BASE), `${BASE}/odd/slashes.pdf`);
  assert.equal(dropboxPath('', BASE), '');
});

test('a file written as a full path is cut at the Dropbox folder itself', () => {
  assert.equal(dropboxPath('/Users/JaeYoon/Dropbox/0.Personal folder/0. Zotero/x.pdf'), '/0.Personal folder/0. Zotero/x.pdf');
  assert.equal(dropboxPath('/Users/JaeYoon/Dropbox (Personal)/Papers/x.pdf'), '/Papers/x.pdf');
  assert.equal(dropboxPath('/Users/JaeYoon/Documents/x.pdf'), '', 'a file outside Dropbox cannot be reached');
});

test('a Korean name is composed, because that is how Dropbox holds it', () => {
  const decomposed = '내 라이브러리'.normalize('NFD');
  const path = dropboxPath(`attachments:${decomposed}/a.pdf`, BASE);
  assert.equal(path, `${BASE}/내 라이브러리/a.pdf`.normalize('NFC'));
  assert.equal(path.normalize('NFC'), path);
});

test('each kind of attachment is sent to the service that actually holds it', () => {
  assert.deepEqual(fileSource(stored(), BASE), {kind: 'zotero', key: 'ATT2'});
  assert.equal(fileSource(linked('attachments:A/b.pdf'), BASE).kind, 'dropbox');
  assert.equal(fileSource(linked('attachments:A/b.pdf'), BASE).path, `${BASE}/A/b.pdf`);
  assert.equal(fileSource({data: {linkMode: 'linked_url', url: 'https://x'}}, BASE).kind, 'none');
  assert.equal(fileSource({data: {linkMode: 'linked_url'}}, BASE).why, 'link');
  assert.equal(fileSource(linked('/Users/J/Documents/x.pdf'), BASE).kind, 'none', 'a file outside the folder is not pretended to be there');
});

test('a Korean path survives the trip through an HTTP header', () => {
  const arg = headerArg({path: '/내 라이브러리/a.pdf'});
  assert.ok(/^[\x20-\x7e]*$/.test(arg), 'the header is plain ASCII');
  assert.deepEqual(JSON.parse(arg), {path: '/내 라이브러리/a.pdf'});
});

test('the Dropbox trip out keeps the verifier here and sends only its hash', async () => {
  const store = fakeStore({'np.db.app': 'APPKEY'});
  const db = createDropbox({store, randomBytes: n => new Uint8Array(n).fill(3), digest: async () => new Uint8Array(32).fill(9)});
  const url = new URL(await db.begin('https://x.test/phone/'));
  assert.equal(url.origin + url.pathname, DROPBOX.authorize);
  assert.equal(url.searchParams.get('client_id'), 'APPKEY');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('token_access_type'), 'offline', 'offline is what gives a token that lasts');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://x.test/phone/');
  assert.ok(store.map.get('np.db.pkce'), 'the verifier stayed on the phone');
  assert.ok(!String(url).includes(store.map.get('np.db.pkce')), 'and was not sent');
});

test('the code that comes back is traded for a token that lasts, and the verifier is spent', async () => {
  const store = fakeStore({'np.db.app': 'APPKEY', 'np.db.pkce': 'VERIFIER'});
  const sent = [];
  const db = createDropbox({store, fetchImpl: async (url, init) => {
    sent.push({url, body: String(init.body)});
    return new Response(JSON.stringify({access_token: 'AT', refresh_token: 'RT', expires_in: 14400}), {status: 200});
  }});
  await db.finish('CODE', 'https://x.test/phone/');
  assert.equal(sent[0].url, DROPBOX.token);
  assert.match(sent[0].body, /code_verifier=VERIFIER/);
  assert.match(sent[0].body, /grant_type=authorization_code/);
  assert.equal(store.map.get('np.db.refresh'), 'RT');
  assert.ok(!store.map.get('np.db.pkce'), 'the verifier is used once');
  assert.equal(db.linked, true);
});

test('a token near its end is renewed before it is used, and a good one is not', async () => {
  let calls = 0;
  const store = fakeStore({'np.db.app': 'A', 'np.db.refresh': 'RT', 'np.db.access': 'OLD', 'np.db.until': '1000'});
  const db = createDropbox({store, now: () => 2000, fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({access_token: 'NEW', expires_in: 14400}), {status: 200});
  }});
  assert.equal(await db.access(), 'NEW');
  assert.equal(calls, 1);
  assert.equal(await db.access(), 'NEW', 'the second ask is answered from here');
  assert.equal(calls, 1);
});

test('a refusal that cannot be retried forgets the connection instead of asking forever', async () => {
  const store = fakeStore({'np.db.app': 'A', 'np.db.refresh': 'RT'});
  const db = createDropbox({store, fetchImpl: async () => new Response(JSON.stringify({error: 'invalid_grant'}), {status: 400})});
  await assert.rejects(() => db.access(), /만료|오류/);
  assert.equal(db.linked, false, 'the dead token is dropped');
});

test('the file is asked for by path, and a moved file is found by name instead', async () => {
  const asked = [];
  const store = fakeStore({'np.db.app': 'A', 'np.db.refresh': 'RT', 'np.db.access': 'AT', 'np.db.until': String(Date.now() + 1e7)});
  const db = createDropbox({store, fetchImpl: async (url, init) => {
    asked.push({url, arg: init.headers['Dropbox-API-Arg'], body: init.body});
    if (url === DROPBOX.download) {
      const path = JSON.parse(init.headers['Dropbox-API-Arg']).path;
      if (path === '/moved/a.pdf') return new Response(bytes(2048), {status: 200});
      return new Response('{"error_summary":"path/not_found/"}', {status: 409});
    }
    return new Response(JSON.stringify({matches: [{metadata: {metadata: {name: 'a.pdf', path_display: '/moved/a.pdf'}}}]}), {status: 200});
  }});
  const got = await db.download('/gone/a.pdf');
  assert.equal(got.byteLength, 2048);
  assert.equal(asked[0].url, DROPBOX.download);
  assert.deepEqual(JSON.parse(asked[0].arg), {path: '/gone/a.pdf'});
  assert.equal(asked[1].url, DROPBOX.search, 'then it looked for the name');
  assert.equal(asked[0].body, undefined, 'the download carries no body, as Dropbox requires');
});

test('a file that is nowhere says so plainly rather than looking broken', async () => {
  const store = fakeStore({'np.db.app': 'A', 'np.db.refresh': 'RT', 'np.db.access': 'AT', 'np.db.until': String(Date.now() + 1e7)});
  const db = createDropbox({store, fetchImpl: async url =>
    (url === DROPBOX.download ? new Response('{"error_summary":"path/not_found/"}', {status: 409})
                              : new Response(JSON.stringify({matches: []}), {status: 200}))});
  await assert.rejects(() => db.download('/gone/a.pdf'), error => error.missing === true && /Dropbox/.test(error.message));
});

test('the phone asks itself first, then Zotero, then Dropbox', async () => {
  const held = new Map();
  const cache = {get: async key => held.get(key) || null, put: async (key, value) => held.set(key, value)};
  const calls = {zotero: 0, dropbox: 0};
  const dropbox = {linked: true, download: async () => { calls.dropbox++; return bytes(900); }};
  const zoteroFile = async () => { calls.zotero++; return bytes(800); };

  const one = await paperFile({attachment: stored(), base: BASE, cache, zoteroFile, dropbox});
  assert.equal(one.byteLength, 800);
  assert.deepEqual(calls, {zotero: 1, dropbox: 0}, 'a file Zotero holds comes from Zotero');

  const two = await paperFile({attachment: linked('attachments:A/b.pdf'), base: BASE, cache, zoteroFile, dropbox});
  assert.equal(two.byteLength, 900);
  assert.equal(calls.dropbox, 1, 'a linked file comes from Dropbox');

  await paperFile({attachment: linked('attachments:A/b.pdf'), base: BASE, cache, zoteroFile, dropbox});
  assert.equal(calls.dropbox, 1, 'the second time it comes from this phone');
});

test('with no Dropbox the error says what to do, and names it as the thing to connect', async () => {
  await assert.rejects(
    () => paperFile({attachment: linked('attachments:A/b.pdf'), base: BASE, dropbox: {linked: false}}),
    error => error.need === 'dropbox' && /Dropbox/.test(error.message));
});

test('a truncated download is refused rather than handed to the viewer', async () => {
  await assert.rejects(() => paperFile({attachment: stored(), zoteroFile: async () => bytes(2)}), /비어/);
});

test('the address Dropbox sends the phone back to is read, refusal and all', () => {
  assert.deepEqual(returningCode('?code=ABC'), {code: 'ABC'});
  assert.deepEqual(returningCode(''), {});
  assert.equal(returningCode('?error=access_denied&error_description=no').error, 'no');
  assert.equal(DEFAULT_BASE, '/0.Personal folder/0. Zotero');
});

/* ---- the audio this Mac baked ---- */

test('the phone looks for a baked paper under the name the baker gave it, newest copy first', () => {
  assert.deepEqual(F.bakedPaths('A paper: part 1'), [
    '/논문 음성/A paper- part 1 (4).m4b',
    '/논문 음성/A paper- part 1 (3).m4b',
    '/논문 음성/A paper- part 1 (2).m4b',
    '/논문 음성/A paper- part 1.m4b'
  ]);
  assert.deepEqual(F.bakedPaths('x', '/elsewhere/', 2), ['/elsewhere/x (2).m4b', '/elsewhere/x.m4b']);
  assert.equal(F.bakedPaths('')[0].startsWith('/논문 음성/논문'), true);
});

test('the phone names a file exactly as the Mac that baked it does', async () => {
  // Two copies of one rule is two chances to drift, and the drift would be silent: the phone would
  // simply never find the file. They are checked against each other instead.
  const baker = await import('../../../zotero-style-custom/bridge/tts/book.mjs');
  for (const title of ['A paper: part 1', 'a/b:c', '', '  ..hidden  ', '형광펜이 글자에 앉는다',
                       'word '.repeat(40), 'Ends with a dot.', 'Q? A! * " < > |']) {
    assert.equal(F.safeName(title), baker.safeName(title), JSON.stringify(title));
  }
});

test('a baked paper is fetched once and then comes from the phone', async () => {
  const asked = [];
  const store = new Map();
  const cache = {get: async p => store.get(p) || null, put: async (p, b) => { store.set(p, b); }};
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const dropbox = {
    linked: true,
    async download(path) {
      asked.push(path);
      if (path.endsWith('A paper.m4b')) return bytes;
      throw Object.assign(new Error('gone'), {missing: true});
    }
  };
  const steps = [];
  const first = await F.bakedAudio({title: 'A paper', dropbox, cache, onStep: s => steps.push(s)});
  assert.equal(first.path, '/논문 음성/A paper.m4b');
  assert.equal(first.bytes, bytes);
  assert.equal(first.fromCache, false);
  assert.deepEqual(steps, ['찾는 중']);
  assert.equal(asked.length, 4, 'the later copies are tried first, then the plain name');

  const again = await F.bakedAudio({title: 'A paper', dropbox, cache});
  assert.equal(again.fromCache, true);
  assert.equal(asked.length, 4, 'nothing was asked for a second time');
});

test('no baked paper, no Dropbox, and a Dropbox that is not well are each their own answer', async () => {
  const missing = {linked: true, async download() { throw Object.assign(new Error('gone'), {missing: true}); }};
  assert.equal(await F.bakedAudio({title: 'Nothing', dropbox: missing}), null);
  assert.equal(await F.bakedAudio({title: 'Nothing', dropbox: null}), null);
  assert.equal(await F.bakedAudio({title: 'Nothing', dropbox: {linked: false}}), null);
  // A real failure is not "there is no file": it is passed on, so the reader is told.
  const broken = {linked: true, async download() { throw Object.assign(new Error('Dropbox 연결이 만료되었습니다. 다시 연결해 주세요.'), {need: 'dropbox'}); }};
  await assert.rejects(() => F.bakedAudio({title: 'Nothing', dropbox: broken}), /만료/);
});

test('the times beside the audio are read when they are there, and missed quietly when not', async () => {
  const marks = {title: 'A paper', seconds: 100, chapters: [{at: 0, title: 'Abstract'}], marks: [{at: 0, text: 'One.'}]};
  const dropbox = {
    linked: true,
    async download(path) {
      assert.equal(path, '/논문 음성/A paper.json');
      return new TextEncoder().encode(JSON.stringify(marks)).buffer;
    }
  };
  assert.deepEqual(await F.bakedMarks({path: '/논문 음성/A paper.m4b', dropbox}), marks);
  const none = {linked: true, async download() { throw new Error('nope'); }};
  assert.equal(await F.bakedMarks({path: '/논문 음성/A paper.m4b', dropbox: none}), null);
  assert.equal(await F.bakedMarks({path: '', dropbox}), null);
});

test('the folder is read once for the whole session, not once for every paper', async () => {
  let lists = 0, downloads = 0;
  const dropbox = {
    linked: true,
    async list(folder) {
      lists++;
      assert.equal(folder, '/논문 음성');
      return [{name: 'A paper.m4b', path: '/논문 음성/A paper.m4b', size: 10}];
    },
    async download(path) { downloads++; if (path.endsWith('A paper.m4b')) return new Uint8Array([1]).buffer; throw Object.assign(new Error('gone'), {missing: true}); }
  };
  const index = F.bakedIndex({dropbox});
  const baked = await F.bakedAudio({title: 'A paper', dropbox, index});
  assert.equal(baked.path, '/논문 음성/A paper.m4b');
  assert.equal(downloads, 1, 'only the name that is actually there was fetched');

  // A paper nobody baked costs nothing at all: no download, and no second listing.
  assert.equal(await F.bakedAudio({title: 'Never baked', dropbox, index}), null);
  assert.equal(downloads, 1);
  assert.equal(await F.bakedAudio({title: 'Nor this', dropbox, index}), null);
  assert.equal(lists, 1, 'one listing answered for all three papers');

  // Without an index it still works, the old way, by asking for each name.
  downloads = 0;
  assert.ok(await F.bakedAudio({title: 'A paper', dropbox}));
  assert.ok(downloads > 1, 'and that is exactly why the index is worth having');
});

test('a sync folder that does not exist yet means nothing is baked, not a failure', async () => {
  const dropbox = {linked: true, async list() { throw new Error('409'); }, async download() { throw new Error('never asked'); }};
  const index = F.bakedIndex({dropbox});
  assert.deepEqual(await index.names(), []);
  assert.equal(await F.bakedAudio({title: 'A paper', dropbox, index}), null);
  // And with no Dropbox at all it does not even ask.
  assert.deepEqual(await F.bakedIndex({dropbox: {linked: false}}).names(), []);
});

test('the facts the Mac leaves beside the audio are read, and a missing file is not a failure', async () => {
  const facts = {v: 1, made: '2026-10-14T00:00:00Z',
    papers: {AAA: {jif: 35.11, cited: 12, from: ['KR', 'US'], lead: 'KR'}},
    journals: {Nature: {country: 'GB', h: 1845}}};
  const asked = [];
  const dropbox = {
    linked: true,
    async list() { return [{name: 'library.json', path: '/논문 음성/library.json', size: 10}]; },
    async download(path) { asked.push(path); return new TextEncoder().encode(JSON.stringify(facts)).buffer; }
  };
  const got = await F.libraryFacts({dropbox});
  assert.deepEqual(asked, ['/논문 음성/library.json']);
  assert.equal(got.papers.AAA.jif, 35.11);
  assert.equal(got.journals.Nature.country, 'GB');

  // The listing says whether it is worth asking at all.
  const empty = {linked: true, async list() { return []; }, async download() { throw new Error('should not be asked'); }};
  assert.equal(await F.libraryFacts({dropbox: empty, index: F.bakedIndex({dropbox: empty})}), null);
  // A file that is not there, a file that is not JSON, and no Dropbox: all of them are simply nothing.
  const missing = {linked: true, async download() { throw Object.assign(new Error('gone'), {missing: true}); }};
  assert.equal(await F.libraryFacts({dropbox: missing}), null);
  const rubbish = {linked: true, async download() { return new TextEncoder().encode('not json at all').buffer; }};
  assert.equal(await F.libraryFacts({dropbox: rubbish}), null);
  const wrong = {linked: true, async download() { return new TextEncoder().encode('{"hello":true}').buffer; }};
  assert.equal(await F.libraryFacts({dropbox: wrong}), null);
  assert.equal(await F.libraryFacts({dropbox: null}), null);
});

test('a country becomes the flag a phone draws, and a journal figure its band', () => {
  assert.equal(F.flagOf('KR'), '🇰🇷');
  assert.equal(F.flagOf('us'), '🇺🇸');
  for (const nonsense of ['Korea', '', null, 'K', 'KOR', 123]) assert.equal(F.flagOf(nonsense), '', String(nonsense));
  assert.equal(F.bandOf(35.1), 'top');
  assert.equal(F.bandOf(10), 'high');
  assert.equal(F.bandOf(5), 'mid');
  assert.equal(F.bandOf(4.9), 'low');
  for (const nothing of [0, -1, null, 'Nature', NaN]) assert.equal(F.bandOf(nothing), '');
});

test('a journal comes with the ink the Mac paints it in, or with none at all', () => {
  const facts = {journals: {'Nature Reviews Microbiology': {ink: '#c6004f', inkDark: '#ff6ba6'},
                            Nature: {country: 'GB'}}};
  assert.deepEqual(F.inkFor(facts, 'Nature Reviews Microbiology'), {ink: '#c6004f', dark: '#ff6ba6'});
  assert.deepEqual(F.inkFor(facts, '  Nature Reviews Microbiology  '), {ink: '#c6004f', dark: '#ff6ba6'});
  // Nature's masthead is black, so the Mac sends no colour and the name stays in the plain ink.
  assert.equal(F.inkFor(facts, 'Nature'), null);
  assert.equal(F.inkFor(facts, 'Journal of Nothing'), null);
  assert.equal(F.inkFor(null, 'Nature Reviews Microbiology'), null);
  assert.equal(F.inkFor({journals: {X: {ink: '#fff'}}}, 'X'), null, 'one half of a colour is no colour');
  // A mark is one of the seven the Mac offers, and nothing else gets drawn.
  assert.equal(F.markOf({mark: 'teal'}), 'teal');
  assert.equal(F.markOf({mark: 'chartreuse'}), '');
  assert.equal(F.markOf({}), '');
  assert.equal(F.markOf(null), '');
});

test('the phone and the Mac offer the same seven colours', async () => {
  const plugin = (await import('../../../zotero-style-custom/src/library-facts.js')).default;
  assert.deepEqual(F.MARKS, plugin.MARKS, 'two copies of one list, checked rather than left to drift');
});

test('the phone and the Mac put a paper in the same band', async () => {
  // Two copies of one rule again; they are checked against each other rather than left to drift.
  const plugin = (await import('../../../zotero-style-custom/src/library-facts.js')).default;
  for (const jif of [0, 0.1, 4.9, 5, 9.99, 10, 29.9, 30, 35.11, 120]) {
    assert.equal(F.bandOf(jif), plugin.bandOf(jif), String(jif));
  }
});

/* ---- a folder of 240 baked papers ---- */
test('한 번에 다 주지 않는 폴더는 끝까지 읽는다 — 안 그러면 나중에 구운 논문이 없는 것이 된다', async () => {
  const names = Array.from({length: 1200}, (_, i) => `Paper ${i + 1}.m4b`);
  const asked = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    asked.push(url);
    if (/oauth2\/token/.test(url)) return new Response(JSON.stringify({access_token: 'AT', expires_in: 14400}), {status: 200});
    const from = Number(body.cursor || 0);
    const page = names.slice(from, from + 500);
    return new Response(JSON.stringify({
      entries: page.map(name => ({'.tag': 'file', name, path_display: `/논문 음성/${name}`, size: 9})),
      has_more: from + 500 < names.length, cursor: String(from + 500)
    }), {status: 200});
  };
  const db = createDropbox({store: fakeStore({'np.db.app': 'APPKEY', 'np.db.refresh': 'RT', 'np.db.access': 'AT', 'np.db.until': String(Date.now() + 3600000)}), fetchImpl});
  const list = await db.list('/논문 음성');
  assert.equal(list.length, 1200, 'every file, not only the first page');
  assert.equal(list.at(-1).name, 'Paper 1200.m4b');
  assert.equal(asked.filter(u => /list_folder\/continue/.test(u)).length, 2, 'the rest was asked for, twice');
  // And the paper baked last is findable, which is the whole point.
  const index = F.bakedIndex({dropbox: db});
  assert.equal(await index.has('Paper 1200.m4b'), true);
});

test('구운 파일은 링크로 바로 재생하고, 링크가 없으면 받아서 재생한다', async () => {
  const asked = [];
  const dropbox = {
    linked: true,
    async list() { return [{name: 'A paper.m4b', path: '/논문 음성/A paper.m4b', size: 10}]; },
    async link(path) { asked.push(`link:${path}`); return `https://dl.dropboxusercontent.com${path}`; },
    async download(path) { asked.push(path); return new Uint8Array([1]).buffer; }
  };
  const index = F.bakedIndex({dropbox});
  const streamed = await F.bakedAudio({title: 'A paper', dropbox, index});
  assert.equal(streamed.url, 'https://dl.dropboxusercontent.com/논문 음성/A paper.m4b');
  assert.equal(streamed.bytes, undefined, 'nothing was waited for');
  assert.deepEqual(asked, ['link:/논문 음성/A paper.m4b']);

  // A link that cannot be had is not the end of it: the file is fetched as before.
  const noLink = {...dropbox, async link() { return ''; }};
  const got = await F.bakedAudio({title: 'A paper', dropbox: noLink, index: F.bakedIndex({dropbox: noLink})});
  assert.ok(got.bytes, 'the bytes arrived instead');

  // What the phone already holds is played from the phone, link or no link.
  const held = new Uint8Array([2]).buffer;
  const cache = {async get(key) { return key === '/논문 음성/A paper.m4b' ? held : null; }, async put() {}};
  const mine = await F.bakedAudio({title: 'A paper', dropbox, index, cache});
  assert.equal(mine.bytes, held);
  assert.equal(mine.fromCache, true);
});

test('목록은 몇 분 지나면 다시 읽는다 — 맥은 폰이 열려 있는 동안에도 계속 굽는다', async () => {
  let lists = 0, clock = 0;
  const dropbox = {linked: true, async list() { lists++; return [{name: `${lists}.m4b`, path: `/논문 음성/${lists}.m4b`}]; }};
  const index = F.bakedIndex({dropbox, fresh: 1000, now: () => clock});
  assert.equal((await index.names())[0].name, '1.m4b');
  await index.names();
  assert.equal(lists, 1, 'twice in a row costs one listing');
  clock = 1500;
  assert.equal((await index.names())[0].name, '2.m4b', 'a listing older than that is taken again');
  index.forget();
  await index.names();
  assert.equal(lists, 3, 'and a refresh takes it again at once');
  // Two papers opened at the same moment ask one question between them.
  clock = 9000;
  const [a, b] = await Promise.all([index.names(), index.names()]);
  assert.equal(lists, 4);
  assert.equal(a, b);
});

test('한참 들은 논문은 신호 없는 길을 위해 폰에 넣어 둔다', async () => {
  const put = [];
  const dropbox = {linked: true, async download(path) { put.push(`get:${path}`); return new Uint8Array([3]).buffer; }};
  const cache = {held: new Map(), async get(key) { return this.held.get(key) || null; }, async put(key, value) { this.held.set(key, value); put.push(`put:${key}`); }};
  assert.equal(await F.keepBaked({path: '/논문 음성/A paper.m4b', dropbox, cache}), true);
  assert.deepEqual(put, ['get:/논문 음성/A paper.m4b', 'put:/논문 음성/A paper.m4b']);
  // Already there: nothing is fetched twice.
  assert.equal(await F.keepBaked({path: '/논문 음성/A paper.m4b', dropbox, cache}), true);
  assert.equal(put.length, 2);
  // And a download that fails is simply no file put away, not an error thrown at the reader.
  const broken = {linked: true, async download() { throw new Error('no signal'); }};
  assert.equal(await F.keepBaked({path: '/x.m4b', dropbox: broken, cache}), false);
});

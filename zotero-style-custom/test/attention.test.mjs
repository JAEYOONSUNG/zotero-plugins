import test from 'node:test';
import assert from 'node:assert/strict';
import attention from '../src/attention.js';

const WAKEFIELD = '10.1016/S0140-6736(97)11096-0';
const parts = (y, m, d) => ({'date-parts': [[y, m, d]]});
const crossrefWakefield = {status: 'ok', message: {DOI: '10.1016/s0140-6736(97)11096-0', title: ['RETRACTED: Ileal-lymphoid'], 'updated-by': [
  {type: 'correction', label: 'Correction', source: 'retraction-watch', DOI: '10.1016/s0140-6736(04)15715-2', updated: parts(2004, 3, 6)},
  {type: 'retraction', label: 'Retraction', source: 'retraction-watch', DOI: '10.1016/s0140-6736(10)60175-4', updated: parts(2010, 2, 6)}]}};
const crossrefClean = {message: {DOI: '10.1/clean', title: ['A paper']}};
const epmcLite = {resultList: {result: [{id: '9500320', source: 'MED', pmid: '9500320'}]}};
const epmcCore = {resultList: {result: [{pmid: '9500320', pubTypeList: {pubType: ['Journal Article', 'Retracted Publication']}, commentCorrectionList: {commentCorrection: [
  ...Array.from({length: 25}, (_, i) => ({id: String(100 + i), source: 'MED', type: 'Comment in', reference: 'BMJ. 2011 Jan ' + (i + 1) + ';342:c7452.'})),
  {id: '20137807', source: 'MED', type: 'Retraction in', reference: 'Lancet. 2010 Feb 6;375(9713):445.'},
  {id: '22222', source: 'MED', type: 'Expression of concern in', reference: 'BMJ. 2011 Nov;343:d7140.'},
  {id: '5', source: 'MED', type: 'Comment on', reference: 'Other. 1999;1:1.'}]}}]}};

const json = (body, status = 200, url = '') => ({status, json: body, url});

// A fake network: routes by URL substring, records every request.
function network(routes) {
  const log = [];
  const fetch = async (url, options = {}) => {
    log.push({url, method: options.method || 'GET', headers: options.headers || {}});
    for (const [needle, answer] of routes) if (url.includes(needle)) return typeof answer === 'function' ? answer(url, options) : answer;
    return json(null, 404);
  };
  return {fetch, log};
}
const make = (routes, extra = {}) => {
  const net = network(routes);
  let clock = 1_000_000_000_000;
  const tools = attention.create({fetch: net.fetch, sleep: async ms => { clock += ms; }, now: () => clock, ...extra});
  return {...net, tools, advance: ms => { clock += ms; }};
};
const wakefieldRoutes = [
  ['api.crossref.org/works/', json(crossrefWakefield)],
  ['resultType=lite', json(epmcLite)],
  ['resultType=core', json(epmcCore)],
  ['api.openalex.org', json({id: 'W1', is_retracted: true})]
];

test('Wakefield: correction 2004 and retraction 2010 give a retracted timeline', async () => {
  const {tools} = make(wakefieldRoutes);
  const out = await tools.issues(WAKEFIELD);
  assert.equal(out.summary.status, 'retracted');
  const crossref = out.events.filter(e => e.source === 'Crossref');
  assert.deepEqual(crossref.map(e => [e.date, e.kind]), [['2004-03-06', 'correction'], ['2010-02-06', 'retraction']]);
  assert.equal(crossref[1].url, 'https://doi.org/10.1016/s0140-6736(10)60175-4');
  assert.equal(crossref[1].via, 'Retraction Watch');
  assert.ok(out.events.some(e => e.kind === 'expression-of-concern' && e.date === '2011-11' && e.source === 'Europe PMC'));
  // Dates ascend.
  const dated = out.events.filter(e => e.date).map(e => e.date);
  assert.deepEqual(dated, [...dated].sort());
  assert.deepEqual(out.summary.failed, []);
  assert.match(out.summary.checked, /^\d{4}-\d\d-\d\dT/);
});

test('Europe PMC: 25 comments are one counted event, the retraction is not doubled', async () => {
  const {tools, log} = make(wakefieldRoutes);
  const out = await tools.issues(WAKEFIELD);
  const comments = out.events.filter(e => e.kind === 'comment');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].count, 25);
  assert.equal(out.summary.comments, 25);
  assert.equal(out.events.filter(e => e.kind === 'retraction').length, 1);
  // PMID lookup happened first, then the core record by that id.
  const lite = log.findIndex(r => r.url.includes('resultType=lite')), core = log.findIndex(r => r.url.includes('resultType=core'));
  assert.ok(lite >= 0 && core > lite);
  assert.match(decodeURIComponent(log[core].url), /EXT_ID:9500320 AND SRC:MED/);
  // Already retracted: OpenAlex (metered) is not asked.
  assert.ok(!log.some(r => r.url.includes('openalex')));
});

test('a given PMID skips the lookup', async () => {
  const {tools, log} = make(wakefieldRoutes);
  await tools.issues(WAKEFIELD, {pmid: '9500320'});
  assert.ok(!log.some(r => r.url.includes('resultType=lite')));
});

test('clean (checked) is not unknown (could not check)', async () => {
  const clean = make([['api.crossref.org', json(crossrefClean)], ['europepmc', json({resultList: {result: []}})], ['api.openalex.org', json({is_retracted: false})]]);
  const a = await clean.tools.issues('10.1/clean');
  assert.equal(a.summary.status, 'clean');
  assert.deepEqual(a.events, []);
  assert.equal(a.summary.openAlexRetracted, false);

  const down = make([['api.crossref.org', json(null, 503)], ['europepmc', json(null, 500)], ['api.openalex.org', json(null, 429)]]);
  const b = await down.tools.issues('10.1/clean');
  assert.equal(b.summary.status, 'unknown');
  assert.deepEqual(b.summary.failed.sort(), ['Crossref', 'Europe PMC', 'OpenAlex']);

  // A DOI Crossref has never heard of and nobody else knows: not "clean".
  const none = make([]);
  assert.equal((await none.tools.issues('10.9/none')).summary.status, 'unknown');
});

test('a failed source is listed but a surviving answer still decides', async () => {
  const {tools} = make([['api.crossref.org', json(crossrefClean)], ['europepmc', json(null, 500)], ['api.openalex.org', json({is_retracted: false})]]);
  const out = await tools.issues('10.1/clean');
  assert.equal(out.summary.status, 'clean');
  assert.deepEqual(out.summary.failed, ['Europe PMC']);
});

test('OpenAlex flag alone makes a retracted verdict; a known flag spends no request', async () => {
  const flagged = make([['api.crossref.org', json(crossrefClean)], ['europepmc', json({resultList: {result: []}})], ['api.openalex.org', json({is_retracted: true})]]);
  const out = await flagged.tools.issues('10.1/clean');
  assert.equal(out.summary.status, 'retracted');
  assert.equal(out.events.at(-1).source, 'OpenAlex');
  const known = make([['api.crossref.org', json(crossrefClean)], ['europepmc', json({resultList: {result: []}})]]);
  const again = await known.tools.issues('10.1/clean', {openAlex: false});
  assert.equal(again.summary.status, 'clean');
  assert.ok(!known.log.some(r => r.url.includes('openalex')));
  const held = make([['api.crossref.org', json(crossrefClean)]], {openAlexHeld: () => true});
  await held.tools.issues('10.1/clean');
  assert.ok(!held.log.some(r => r.url.includes('openalex')));
});

test('concern and corrected statuses', async () => {
  const body = type => json({message: {DOI: '10.1/x', title: ['x'], 'updated-by': [{type, label: type, DOI: '10.1/n', updated: parts(2020, 1, 1)}]}});
  assert.equal((await make([['api.crossref.org', body('expression_of_concern')]]).tools.issues('10.1/x')).summary.status, 'concern');
  assert.equal((await make([['api.crossref.org', body('erratum')]]).tools.issues('10.1/x')).summary.status, 'corrected');
  assert.equal((await make([['api.crossref.org', body('withdrawal')]]).tools.issues('10.1/x')).summary.status, 'retracted');
});

test('issue TTLs: 30 days clean, 7 days flagged, 24h on failure, force refreshes', async () => {
  const day = 86400000;
  const clean = make([['api.crossref.org', json(crossrefClean)], ['europepmc', json({resultList: {result: []}})], ['api.openalex.org', json({is_retracted: false})]]);
  await clean.tools.issues('10.1/clean');
  const n = clean.log.length;
  clean.advance(29 * day);
  assert.equal((await clean.tools.issues('10.1/clean')).cached, true);
  assert.equal(clean.log.length, n);
  clean.advance(2 * day);
  assert.equal((await clean.tools.issues('10.1/clean')).cached, false);
  assert.ok(clean.log.length > n);

  const flagged = make(wakefieldRoutes);
  await flagged.tools.issues(WAKEFIELD);
  flagged.advance(6 * day);
  assert.equal((await flagged.tools.issues(WAKEFIELD)).cached, true);
  flagged.advance(2 * day);
  assert.equal((await flagged.tools.issues(WAKEFIELD)).cached, false);
  const m = flagged.log.length;
  assert.equal((await flagged.tools.issues(WAKEFIELD, {force: true})).cached, false);
  assert.ok(flagged.log.length > m);

  const down = make([['api.crossref.org', json(null, 500)], ['europepmc', json(null, 500)], ['openalex', json(null, 500)]]);
  await down.tools.issues('10.1/x');
  const k = down.log.length;
  down.advance(23 * 3600000);
  await down.tools.issues('10.1/x');
  assert.equal(down.log.length, k);
  down.advance(2 * 3600000);
  await down.tools.issues('10.1/x');
  assert.ok(down.log.length > k);
});

test('a forced refresh that learns nothing keeps the earlier answer', async () => {
  let up = true;
  const net = network([['api.crossref.org', () => up ? json(crossrefWakefield) : json(null, 503)], ['europepmc', () => up ? json(epmcLite) : json(null, 503)], ['api.openalex.org', json(null, 503)]]);
  let clock = 1e12;
  const tools = attention.create({fetch: net.fetch, sleep: async () => {}, now: () => clock});
  assert.equal((await tools.issues(WAKEFIELD)).summary.status, 'retracted');
  up = false;
  const out = await tools.issues(WAKEFIELD, {force: true});
  assert.equal(out.summary.status, 'retracted');
  assert.equal(out.stale, true);
});

const bskyBody = {hitsTotal: 24, posts: [
  {uri: 'at://did:plc:a/app.bsky.feed.post/3kaaa', author: {handle: 'a.bsky.social', displayName: 'Ann'}, record: {text: 'Great paper', createdAt: '2024-10-01T00:00:00Z'}, likeCount: 40, repostCount: 18, replyCount: 9},
  {uri: 'at://did:plc:b/app.bsky.feed.post/3kbbb', author: {handle: 'bot.example'}, record: {text: 'spam', createdAt: '2024-10-02T00:00:00Z'}, likeCount: 0, repostCount: 0, replyCount: 0},
  {uri: 'at://did:plc:c/app.bsky.feed.post/3kccc', author: {handle: 'c.bsky.social', displayName: 'Cy'}, record: {text: 'Hmm', createdAt: '2024-10-03T00:00:00Z'}, likeCount: 29, repostCount: 4, replyCount: 3}]};
const hnBody = {hits: [{objectID: '27848279', title: 'Highly accurate protein structure prediction', points: 66, num_comments: 6, created_at: '2021-07-15T10:00:00Z', url: 'https://www.nature.com/articles/s41586-021-03819-2'}]};
const wikiBody = {query: {searchinfo: {totalhits: 28}, search: [{title: 'Protein structure prediction'}, {title: 'AlphaFold'}]}};
const alpha = '10.1038/s41586-021-03819-2', landing = 'https://www.nature.com/articles/s41586-021-03819-2';
const reactionRoutes = [
  ['api.bsky.app', json(bskyBody)], ['hn.algolia.com', json(hnBody)], ['wikipedia.org', json(wikiBody)]];

test('reactions: Bluesky, Hacker News and Wikipedia parsing', async () => {
  const {tools, log} = make(reactionRoutes);
  const out = await tools.reactions(alpha, [landing]);
  assert.equal(out.bluesky.count, 24);
  assert.deepEqual(out.bluesky.top.map(p => p.likes), [40, 29]);
  assert.deepEqual(out.bluesky.top[0], {author: 'Ann', handle: 'a.bsky.social', text: 'Great paper', date: '2024-10-01T00:00:00Z', likes: 40, reposts: 18, replies: 9, url: 'https://bsky.app/profile/a.bsky.social/post/3kaaa'});
  assert.equal(out.hackerNews.count, 1);
  assert.deepEqual(out.hackerNews.top[0], {title: 'Highly accurate protein structure prediction', points: 66, comments: 6, date: '2021-07-15T10:00:00Z', url: 'https://news.ycombinator.com/item?id=27848279'});
  assert.equal(out.wikipedia.count, 28);
  assert.deepEqual(out.wikipedia.articles[1], {title: 'AlphaFold', url: 'https://en.wikipedia.org/wiki/AlphaFold'});
  assert.equal(out.pubpeer.url, 'https://pubpeer.com/search?q=' + encodeURIComponent(alpha));
  assert.ok(!('altmetric' in out));
  assert.deepEqual(out.failed, []);
  // Bluesky is queried by URL (landing and doi.org), sorted by top; the DOI string is never the query.
  const bsky = log.filter(r => r.url.includes('api.bsky.app')).map(r => decodeURIComponent(r.url));
  assert.equal(bsky.length, 2);
  assert.ok(bsky[0].includes('q=*&url=' + landing) && bsky[0].includes('sort=top'));
  assert.ok(bsky[1].includes('url=https://doi.org/' + alpha));
  assert.ok(decodeURIComponent(log.find(r => r.url.includes('hn.algolia')).url).includes('query=nature.com/articles/s41586-021-03819-2'));
  assert.ok(decodeURIComponent(log.find(r => r.url.includes('wikipedia')).url).includes('insource:"' + alpha + '"'));
  // The DOI-only search PubPeer would need is never sent.
  assert.ok(!log.some(r => r.url.includes('pubpeer')));
});

test('landing URL: resolved through doi.org when the item has none, then cached', async () => {
  const doiRoute = ['doi.org/', (url, o) => json(null, 200, landing + '#sec')];
  const {tools, log, advance} = make([doiRoute, ...reactionRoutes]);
  const out = await tools.reactions(alpha, ['https://doi.org/' + alpha, '']);
  assert.equal(out.landing, landing);
  const hits = log.filter(r => r.url.startsWith('https://doi.org/'));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].method, 'HEAD');
  // Reactions expire after 3 days; the landing URL does not.
  advance(4 * 86400000);
  await tools.reactions(alpha, []);
  assert.equal(log.filter(r => r.url.startsWith('https://doi.org/')).length, 1);
  assert.equal(await tools.landingURL(alpha, []), landing);
  // An item URL wins and needs no resolution.
  const direct = make(reactionRoutes);
  await direct.tools.reactions(alpha, [landing]);
  assert.ok(!direct.log.some(r => r.url.startsWith('https://doi.org/')));
});

test('landing URL: HEAD refused falls back to GET; no landing skips Hacker News', async () => {
  let calls = 0;
  const route = ['doi.org/', (url, o) => o.method === 'HEAD' ? json(null, 405) : (calls++, json(null, 200, landing))];
  const a = make([route, ...reactionRoutes]);
  assert.equal((await a.tools.reactions(alpha, [])).landing, landing);
  assert.equal(calls, 1);
  const b = make([['doi.org/', json(null, 200, 'https://doi.org/' + alpha)], ...reactionRoutes]);
  const out = await b.tools.reactions(alpha, []);
  assert.equal(out.landing, '');
  assert.ok(!b.log.some(r => r.url.includes('hn.algolia')));
  assert.equal(out.bluesky.count, 24);
});

test('reactions: partial failure is reported and cached for 24h; total failure is flagged', async () => {
  const {tools, log, advance} = make([['api.bsky.app', json(null, 403)], ['hn.algolia.com', json(hnBody)], ['wikipedia.org', json(wikiBody)]]);
  const out = await tools.reactions(alpha, [landing]);
  assert.deepEqual(out.failed, ['Bluesky']);
  assert.equal(out.hackerNews.count, 1);
  const n = log.length;
  advance(25 * 3600000);
  assert.equal((await tools.reactions(alpha, [landing])).cached, false);
  assert.ok(log.length > n);
});

test('reaction TTL is 3 days', async () => {
  const {tools, log, advance} = make(reactionRoutes);
  await tools.reactions(alpha, [landing]);
  const n = log.length;
  advance(2.5 * 86400000);
  assert.equal((await tools.reactions(alpha, [landing])).cached, true);
  assert.equal(log.length, n);
  advance(1 * 86400000);
  assert.equal((await tools.reactions(alpha, [landing])).cached, false);
  assert.equal((await tools.reactions(alpha, [landing], {force: true})).cached, false);
});

test('Altmetric is asked only when a key is set', async () => {
  const route = ['api.altmetric.com', json({score: 321, cited_by_tweeters_count: 100, cited_by_msm_count: 12, cited_by_feeds_count: 7, cited_by_policies_count: 3, details_url: 'https://www.altmetric.com/details/1'})];
  const without = make([route, ...reactionRoutes]);
  await without.tools.reactions(alpha, [landing]);
  assert.ok(!without.log.some(r => r.url.includes('altmetric')));
  const withKey = make([route, ...reactionRoutes], {altmetricKey: () => 'K123'});
  const out = await withKey.tools.reactions(alpha, [landing]);
  assert.deepEqual(out.altmetric, {score: 321, x: 100, news: 12, blogs: 7, policy: 3, detailsUrl: 'https://www.altmetric.com/details/1'});
  assert.ok(withKey.log.find(r => r.url.includes('altmetric')).url.includes('key=K123'));
});

test('no email, mailto or From header in any request; plain User-Agent', async () => {
  const issuesNet = make(wakefieldRoutes, {altmetricKey: () => 'K', openAlexKey: () => 'oakey'});
  await issuesNet.tools.issues(WAKEFIELD, {openAlex: undefined});
  const react = make([['doi.org/', json(null, 200, landing)], ...reactionRoutes], {altmetricKey: () => 'K', userAgent: 'StyleCustomZoteroPlugin/1.0 (Zotero plugin; paper attention)'});
  await react.tools.reactions(alpha, []);
  const all = [...issuesNet.log, ...react.log];
  assert.ok(all.length > 8);
  for (const r of all) {
    assert.ok(!/mailto|@|email/i.test(decodeURIComponent(r.url)), r.url);
    assert.ok(!/@/.test(JSON.stringify(r.headers)) && !Object.keys(r.headers).some(k => /^(from|referer)$/i.test(k)), JSON.stringify(r.headers));
    assert.ok(r.headers['User-Agent']);
  }
});

test('one request at a time per host, with a polite gap on Crossref', async () => {
  const running = {}, peak = {};
  const waits = [];
  let clock = 1e12;
  const fetch = async url => { const host = new URL(url).host; running[host] = (running[host] || 0) + 1; peak[host] = Math.max(peak[host] || 0, running[host]); await new Promise(r => setTimeout(r, 5)); running[host]--; return json(crossrefClean); };
  const tools = attention.create({fetch, now: () => clock, sleep: async ms => { waits.push(ms); clock += ms; }});
  await Promise.all([tools.issues('10.1/a'), tools.issues('10.1/b'), tools.issues('10.1/c')]);
  assert.deepEqual(Object.values(peak).filter(n => n > 1), []);
  assert.ok(Object.keys(peak).length >= 2);
  assert.ok(waits.some(ms => ms >= 200));
});

test('abort cancels and caches nothing; a timeout counts as a failed source', async () => {
  const controller = new AbortController();
  const {tools} = make(wakefieldRoutes);
  controller.abort();
  await assert.rejects(tools.issues(WAKEFIELD, {signal: controller.signal}), {name: 'AbortError'});
  await assert.rejects(tools.reactions(alpha, [landing], {signal: controller.signal}), {name: 'AbortError'});
  const mid = new AbortController();
  const slow = attention.create({fetch: () => new Promise(() => {}), sleep: async () => {}});
  const job = slow.issues(WAKEFIELD, {signal: mid.signal});
  setTimeout(() => mid.abort(), 10);
  await assert.rejects(job, {name: 'AbortError'});
});

test('without a DOI nothing is asked', async () => {
  const {tools, log} = make(wakefieldRoutes);
  assert.equal((await tools.issues('')).summary.status, 'unknown');
  assert.equal((await tools.reactions('', [])).bluesky.count, 0);
  assert.equal(log.length, 0);
});

test('referenceDate reads PubMed citation strings', () => {
  assert.equal(attention.referenceDate('Lancet. 2010 Feb 6;375(9713):445.'), '2010-02-06');
  assert.equal(attention.referenceDate('BMJ. 2011 Nov;343:d7140.'), '2011-11');
  assert.equal(attention.referenceDate('Foo. 1999;1:1.'), '1999');
  assert.equal(attention.referenceDate('nothing'), '');
});

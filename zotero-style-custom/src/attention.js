/* What happened around a paper: its issues (corrections, retractions,
   expressions of concern, PubMed comments) and the reactions to it (Bluesky,
   Hacker News, Wikipedia, optionally Altmetric).

   Pure and testable. The caller injects `fetch` (one request, one answer) and
   a cache store; nothing here knows Zotero. Every request is lazy, one paper
   at a time, one at a time per host, and carries a plain User-Agent: no email
   address, no mailto parameter, no identifier of the user, ever.

   fetch(url, {method, headers, timeout, signal}) -> {status, json, url}
   where `json` is the parsed body (null when there is none) and `url` the
   address finally reached after redirects. A WHATWG Response is accepted too.

   Two answers are kept apart on purpose: "clean" means a source that knows
   papers answered and listed no notice; "unknown" means nothing could be
   asked. A blocked or timed-out lookup must never read as a clean bill. */
(function (root) {
  'use strict';

  const DAY = 86400000;
  const TTL = {issuesClean: 30 * DAY, issuesFlagged: 7 * DAY, reactions: 3 * DAY, failure: DAY, landing: 30 * DAY};
  const TIMEOUT = 8000;
  // Minimum gap between two requests to one host. Crossref's public pool allows 5 per second.
  const GAP = {'api.crossref.org': 250};
  const DEFAULT_GAP = 200;
  const SOURCES = {crossref: 'Crossref', epmc: 'Europe PMC', openalex: 'OpenAlex'};

  const text = value => String(value == null ? '' : value).trim();
  const signalsTools = () => typeof CustomStylePaperSignals !== 'undefined' ? CustomStylePaperSignals : require('./paper-signals.js');
  const bareDOI = value => text(value).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '').toLowerCase();
  const isDOIHost = url => /^https?:\/\/(dx\.)?doi\.org\//i.test(text(url));
  const pubpeerURL = doi => doi ? 'https://pubpeer.com/search?q=' + encodeURIComponent(bareDOI(doi)) : '';

  const KIND_BY_TYPE = {
    retraction: 'retraction', partial_retraction: 'retraction', removal: 'retraction',
    withdrawal: 'withdrawal', expression_of_concern: 'expression-of-concern', erratum: 'erratum',
    correction: 'correction', corrigendum: 'correction', addendum: 'correction', clarification: 'correction',
    new_edition: 'correction', new_version: 'correction'
  };
  const SEVERITY = {retraction: 3, withdrawal: 3, 'expression-of-concern': 2, correction: 1, erratum: 1, comment: 0};
  const kindOfType = type => KIND_BY_TYPE[text(type).toLowerCase().replace(/[\s-]+/g, '_')] || 'correction';

  // Europe PMC names a link by the direction it points: "Retraction in" means this paper was retracted.
  const EPMC_KIND = [
    [/^comment in$/i, 'comment'], [/^retraction in$/i, 'retraction'], [/^partial retraction in$/i, 'retraction'],
    [/^expression of concern in$/i, 'expression-of-concern'], [/^erratum in$/i, 'erratum'],
    [/^(corrected and )?republished in$/i, 'correction'], [/^correction in$/i, 'correction']
  ];

  const MONTHS = {jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12};
  // "Lancet. 2010 Feb 6;375(9713):445." -> 2010-02-06; the year alone when that is all there is.
  function referenceDate(reference) {
    const m = /\b((?:19|20)\d{2})(?:\s+([A-Za-z]{3})[a-z]*(?:\s+(\d{1,2})\b)?)?/.exec(text(reference));
    if (!m) return '';
    const month = m[2] ? MONTHS[m[2].toLowerCase()] : 0;
    if (!month) return m[1];
    return m[1] + '-' + String(month).padStart(2, '0') + (m[3] ? '-' + String(m[3]).padStart(2, '0') : '');
  }

  const sortEvents = events => events.sort((a, b) => (a.date || '9999') < (b.date || '9999') ? -1 : (a.date || '9999') > (b.date || '9999') ? 1 : 0);

  function create({fetch, store, now = () => Date.now(), sleep, userAgent, altmetricKey, openAlexKey, openAlexHeld} = {}) {
    if (typeof fetch !== 'function') throw new TypeError('attention: a fetch function is required');
    const ua = userAgent || 'StyleCustomZoteroPlugin (Zotero plugin; paper attention)';
    const wait = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const memory = {};
    const db = store || {get: key => memory[key] || null, set: (key, value) => { memory[key] = value; }};
    const lastAt = new Map(), chains = new Map(), inflight = new Map();

    const abortError = () => Object.assign(new Error('Aborted'), {name: 'AbortError'});
    const throwIfAborted = signal => { if (signal?.aborted) throw abortError(); };

    /* One request, serialised per host with a polite gap, bounded by a timeout
       and by the caller's signal (leaving the paper cancels). */
    function request(url, {method = 'GET', headers, signal} = {}) {
      const host = new URL(url).host;
      const run = async () => {
        throwIfAborted(signal);
        const gap = GAP[host] ?? DEFAULT_GAP, since = now() - (lastAt.get(host) || 0);
        if (lastAt.has(host) && since < gap) await wait(gap - since);
        throwIfAborted(signal);
        lastAt.set(host, now());
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        let timer, onAbort;
        const guard = new Promise((_, reject) => {
          timer = setTimeout(() => { controller?.abort(); reject(Object.assign(new Error('Timeout · ' + host), {timeout: true})); }, TIMEOUT);
          onAbort = () => { controller?.abort(); reject(abortError()); };
          signal?.addEventListener?.('abort', onAbort, {once: true});
        });
        try {
          const raw = await Promise.race([
            Promise.resolve(fetch(url, {method, timeout: TIMEOUT, signal: controller?.signal || signal,
              headers: {'User-Agent': ua, 'Api-User-Agent': ua, Accept: 'application/json', ...(headers || {})}})),
            guard]);
          let json = null;
          if (raw && typeof raw.json === 'function') { try { json = await raw.json(); } catch (_) { json = null; } }
          else json = raw?.json ?? raw?.response ?? raw?.body ?? null;
          return {status: Number(raw?.status ?? 0), json, url: text(raw?.url)};
        } finally { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); guard.catch(() => {}); }
      };
      const previous = chains.get(host) || Promise.resolve();
      const next = previous.catch(() => {}).then(run);
      chains.set(host, next.catch(() => {}));
      return next;
    }

    // 200 -> body; 404 -> null (the service does not know it); anything else is no answer at all.
    async function getJSON(url, options) {
      const response = await request(url, options);
      if (response.status === 200) return response.json;
      if (response.status === 404) return null;
      throw Object.assign(new Error('HTTP ' + response.status + ' · ' + new URL(url).host), {status: response.status});
    }

    // ---------- cache ----------
    const record = doi => db.get(doi) || {};
    const fresh = slot => slot && slot.expires > now();
    const keep = (doi, name, value, ttl) => {
      const row = {...record(doi)};
      row[name] = {value, at: new Date(now()).toISOString(), expires: now() + ttl};
      db.set(doi, row);
    };
    const failedTTL = value => (value.summary?.status === 'unknown' || value.failed?.length || value.summary?.failed?.length) ? TTL.failure : null;

    async function cached(doi, name, force, signal, compute, ttlOf) {
      const key = name + '|' + doi;
      const slot = record(doi)[name];
      if (!force && fresh(slot)) return {...slot.value, cached: true};
      if (!force && inflight.has(key)) return inflight.get(key);
      const job = (async () => {
        const value = await compute();
        throwIfAborted(signal);
        const total = name === 'issues' ? value.summary.status === 'unknown' : value.allFailed;
        // A refresh that learned nothing does not replace what was known before.
        if (total && slot?.value) { keep(doi, name, slot.value, TTL.failure); return {...slot.value, cached: true, stale: true}; }
        keep(doi, name, value, ttlOf(value));
        return {...value, cached: false};
      })();
      inflight.set(key, job);
      try { return await job; } finally { inflight.delete(key); }
    }

    // ---------- issues ----------
    const noticeURL = doi => doi ? 'https://doi.org/' + doi : '';

    function crossrefEvents(payload) {
      const sig = signalsTools();
      const parsed = sig.readCrossref(payload);
      if (!parsed?.valid) return null;
      const message = payload && 'message' in payload ? payload.message : payload;
      // Which notices Retraction Watch also lists: the same notice arrives from the publisher and from them.
      const rw = new Set();
      for (const row of Array.isArray(message?.['updated-by']) ? message['updated-by'] : [])
        if (/retraction.?watch/i.test(text(row?.source))) rw.add(bareDOI(row?.DOI) + '|' + text(row?.type).toLowerCase().replace(/[\s-]+/g, '_'));
      // A new version/edition (rank 0, or pointing at the paper's own DOI) is not a notice about the paper.
      const events = parsed.updates.filter(u => u.rank > 0).map(u => ({
        date: u.date, kind: kindOfType(u.type), source: SOURCES.crossref,
        label: u.label || u.type, url: noticeURL(u.doi),
        ...(rw.has(u.doi + '|' + u.type) ? {via: 'Retraction Watch'} : {})
      }));
      for (const doi of parsed.retractedBy)
        if (!events.some(e => e.kind === 'retraction' && e.url === noticeURL(doi)))
          events.push({date: '', kind: 'retraction', source: SOURCES.crossref, label: 'Retraction', url: noticeURL(doi)});
      Object.defineProperty(events, 'isNotice', {value: parsed.noticeFor.length > 0});
      return events;
    }

    async function europePMC(doi, pmidGiven, signal) {
      const base = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&';
      let pmid = text(pmidGiven);
      if (!pmid) {
        const found = await getJSON(base + 'resultType=lite&pageSize=1&query=' + encodeURIComponent('DOI:"' + doi + '" AND SRC:MED'), {signal});
        const hit = found?.resultList?.result?.[0];
        pmid = text(hit?.pmid || (hit?.source === 'MED' ? hit?.id : ''));
      }
      if (!pmid) return {found: false, events: [], comments: 0};
      const core = await getJSON(base + 'resultType=core&pageSize=1&query=' + encodeURIComponent('EXT_ID:' + pmid + ' AND SRC:MED'), {signal});
      const result = core?.resultList?.result?.[0];
      if (!result) return {found: false, events: [], comments: 0};
      const events = [];
      let comments = 0, lastComment = '', commentURL = '';
      const list = result.commentCorrectionList?.commentCorrection;
      for (const row of Array.isArray(list) ? list : []) {
        const kind = (EPMC_KIND.find(([re]) => re.test(text(row?.type))) || [])[1];
        if (!kind) continue;
        const date = referenceDate(row.reference), url = row.id ? 'https://europepmc.org/article/' + (text(row.source) || 'MED') + '/' + text(row.id) : '';
        if (kind === 'comment') { comments++; if (date > lastComment) lastComment = date; commentURL ||= 'https://europepmc.org/article/MED/' + pmid; continue; }
        events.push({date, kind, source: SOURCES.epmc, label: text(row.type).replace(/ in$/i, ''), url});
      }
      const retractedType = /retracted publication/i.test(JSON.stringify(result.pubTypeList?.pubType || ''));
      if (comments) events.push({date: lastComment, kind: 'comment', source: SOURCES.epmc, label: 'Comments', count: comments, url: commentURL});
      return {found: true, pmid, events, comments, retractedType};
    }

    async function issues(doiInput, {force = false, signal, pmid, openAlex} = {}) {
      const doi = bareDOI(doiInput);
      if (!doi) return {events: [], summary: {status: 'unknown', checked: new Date(now()).toISOString(), failed: [], comments: 0, reason: 'no-doi'}, cached: false};
      throwIfAborted(signal);
      return cached(doi, 'issues', force, signal, async () => {
        const failed = [];
        let events = [], recognised = false, comments = 0;
        const guarded = async (name, job) => {
          try { return await job(); }
          catch (error) { if (error?.name === 'AbortError') throw error; failed.push(name); return undefined; }
        };
        const crossref = await guarded(SOURCES.crossref, async () => {
          const payload = await getJSON('https://api.crossref.org/works/' + encodeURIComponent(doi), {signal});
          return payload ? crossrefEvents(payload) : null;
        });
        // The record is itself a notice (Crossref update-to): OpenAlex flags the notice is_retracted, which says nothing about this record.
        let notice = !!crossref?.isNotice;
        if (crossref) { recognised = true; events.push(...crossref); }
        const epmc = await guarded(SOURCES.epmc, () => europePMC(doi, pmid, signal));
        if (epmc?.found) {
          recognised = true; comments = epmc.comments;
          for (const event of epmc.events) {
            // The same notice often arrives from both: keep Crossref's, which carries the exact date and notice DOI.
            const twin = event.kind !== 'comment' && events.some(e => e.kind === event.kind && e.source === SOURCES.crossref
              && (e.date || '').slice(0, 4) === (event.date || '').slice(0, 4));
            if (!twin) events.push(event);
          }
          if (epmc.retractedType && !events.some(e => SEVERITY[e.kind] === 3))
            events.push({date: '', kind: 'retraction', source: SOURCES.epmc, label: 'Retracted Publication', url: 'https://europepmc.org/article/MED/' + epmc.pmid});
        }
        // OpenAlex is metered: asked only when nothing else found a retraction and nobody already knows its flag.
        let flag = typeof openAlex === 'boolean' ? openAlex : null;
        const retracted = () => events.some(e => SEVERITY[e.kind] === 3);
        if (flag === null && !retracted() && !(openAlexHeld && openAlexHeld())) {
          const work = await guarded(SOURCES.openalex, () => getJSON('https://api.openalex.org/works/doi:' + encodeURIComponent(doi)
            + '?select=id,is_retracted,type' + (openAlexKey && text(openAlexKey()) ? '&api_key=' + encodeURIComponent(text(openAlexKey())) : ''), {signal}));
          if (work && typeof work.is_retracted === 'boolean') { flag = work.is_retracted; recognised = true; }
          if (work && text(work.type).toLowerCase() === 'retraction') notice = true;
        }
        if (flag && !retracted() && !notice) events.push({date: '', kind: 'retraction', source: SOURCES.openalex, label: 'Retracted (flag)', url: 'https://doi.org/' + doi});
        sortEvents(events);
        const worst = events.reduce((m, e) => Math.max(m, SEVERITY[e.kind] || 0), 0);
        const status = worst >= 3 ? 'retracted' : worst === 2 ? 'concern' : worst === 1 ? 'corrected' : notice ? 'notice' : recognised ? 'clean' : 'unknown';
        return {events, summary: {status, checked: new Date(now()).toISOString(), failed, comments, ...(flag !== null ? {openAlexRetracted: flag} : {})}};
      }, value => value.summary.failed.length || value.summary.status === 'unknown' ? TTL.failure
        : value.events.some(e => e.kind !== 'comment') ? TTL.issuesFlagged : TTL.issuesClean);
    }

    // ---------- reactions ----------
    async function landingURL(doi, urls, {force, signal} = {}) {
      for (const url of Array.isArray(urls) ? urls : [urls]) {
        const clean = text(url).replace(/#.*$/, '');
        if (/^https?:\/\//i.test(clean) && !isDOIHost(clean)) return clean;
      }
      const slot = record(doi).landing;
      if (!force && fresh(slot)) return slot.value.url || '';
      let final = '';
      const target = 'https://doi.org/' + doi.split('/').map(encodeURIComponent).join('/');
      for (const method of ['HEAD', 'GET']) {
        try {
          const response = await request(target, {method, signal});
          const url = text(response.url).replace(/#.*$/, '');
          if (response.status < 400 && /^https?:\/\//.test(url) && !isDOIHost(url)) { final = url; break; }
        } catch (error) { if (error?.name === 'AbortError') throw error; }
      }
      keep(doi, 'landing', {url: final}, final ? TTL.landing : TTL.failure);
      return final;
    }

    const bskyLink = post => {
      const handle = text(post?.author?.handle), rkey = text(post?.uri).split('/').pop();
      return handle && rkey ? 'https://bsky.app/profile/' + handle + '/post/' + rkey : '';
    };

    async function bluesky(queries, signal, top) {
      const posts = new Map();
      let total = 0;
      for (const query of queries) {
        const data = await getJSON('https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=*&url=' + encodeURIComponent(query) + '&sort=top&limit=25', {signal});
        const rows = Array.isArray(data?.posts) ? data.posts : [];
        // The two queries find overlapping posts: the larger total is the honest figure, their sum counts twice.
        total = Math.max(total, Number.isFinite(data?.hitsTotal) ? data.hitsTotal : rows.length);
        for (const post of rows) if (post?.uri) posts.set(post.uri, post);
      }
      const shaped = [...posts.values()].map(post => ({
        author: text(post.author?.displayName) || text(post.author?.handle), handle: text(post.author?.handle),
        text: text(post.record?.text), date: text(post.record?.createdAt || post.indexedAt),
        likes: Number(post.likeCount) || 0, reposts: Number(post.repostCount) || 0, replies: Number(post.replyCount) || 0, url: bskyLink(post)
      }));
      // Bots and empty reposts fill the tail of a search; a post nobody liked is not a reaction worth showing.
      const shown = shaped.filter(p => p.likes > 0).sort((a, b) => b.likes - a.likes || b.reposts - a.reposts).slice(0, top);
      return {count: Math.max(total, shaped.length), top: shown};
    }

    async function hackerNews(url, signal, top) {
      const bare = url.replace(/^https?:\/\/(www\.)?/i, '').replace(/[?#].*$/, '').replace(/\/$/, '');
      const data = await getJSON('https://hn.algolia.com/api/v1/search?restrictSearchableAttributes=url&tags=story&query=' + encodeURIComponent(bare), {signal});
      const hits = (Array.isArray(data?.hits) ? data.hits : []).filter(h => !h.url || text(h.url).replace(/^https?:\/\/(www\.)?/i, '').replace(/[?#].*$/, '').replace(/\/$/, '') === bare);
      const shaped = hits.map(h => ({title: text(h.title), points: Number(h.points) || 0, comments: Number(h.num_comments) || 0,
        date: text(h.created_at), url: h.objectID ? 'https://news.ycombinator.com/item?id=' + h.objectID : ''}));
      return {count: shaped.length, top: shaped.sort((a, b) => b.points - a.points).slice(0, top)};
    }

    async function wikipedia(doi, signal) {
      const url = 'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srnamespace=0&srlimit=10&srprop=&srsearch='
        + encodeURIComponent('insource:"' + doi + '"');
      const data = await getJSON(url, {signal});
      const rows = Array.isArray(data?.query?.search) ? data.query.search : [];
      const total = Number(data?.query?.searchinfo?.totalhits);
      return {count: Number.isFinite(total) ? total : rows.length,
        articles: rows.map(r => ({title: text(r.title), url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(text(r.title).replace(/ /g, '_'))}))};
    }

    async function altmetric(doi, key, signal) {
      const data = await getJSON('https://api.altmetric.com/v1/doi/' + encodeURIComponent(doi) + '?key=' + encodeURIComponent(key), {signal});
      if (!data) return {score: 0, x: 0, news: 0, blogs: 0, policy: 0, detailsUrl: ''};
      const n = value => Number(value) || 0;
      return {score: n(data.score), x: n(data.cited_by_tweeters_count), news: n(data.cited_by_msm_count), blogs: n(data.cited_by_feeds_count),
        policy: n(data.cited_by_policies_count), detailsUrl: text(data.details_url)};
    }

    async function reactions(doiInput, urls, {force = false, signal, top = 3} = {}) {
      const doi = bareDOI(doiInput);
      const empty = () => ({bluesky: {count: 0, top: []}, hackerNews: {count: 0, top: []}, wikipedia: {count: 0, articles: []}});
      if (!doi) return {...empty(), pubpeer: {url: ''}, checked: new Date(now()).toISOString(), failed: [], reason: 'no-doi', cached: false};
      throwIfAborted(signal);
      const key = text(altmetricKey ? altmetricKey() : '');
      return cached(doi, 'reactions', force, signal, async () => {
        const failed = [], result = empty();
        const guarded = async (name, job) => {
          try { return await job(); } catch (error) { if (error?.name === 'AbortError') throw error; failed.push(name); return null; }
        };
        const landing = await guarded('landing', () => landingURL(doi, urls, {force, signal}));
        const queries = [...new Set([landing, 'https://doi.org/' + doi].filter(Boolean))];
        const bsky = await guarded('Bluesky', () => bluesky(queries, signal, top));
        if (bsky) result.bluesky = bsky;
        // Hacker News matches the address, and a DOI string finds nothing there: without a landing page it is not asked.
        if (landing) { const hn = await guarded('Hacker News', () => hackerNews(landing, signal, top)); if (hn) result.hackerNews = hn; }
        const wiki = await guarded('Wikipedia', () => wikipedia(doi, signal));
        if (wiki) result.wikipedia = wiki;
        if (key) { const alt = await guarded('Altmetric', () => altmetric(doi, key, signal)); if (alt) result.altmetric = alt; }
        result.pubpeer = {url: pubpeerURL(doi)};
        result.landing = landing || '';
        // "landing" failing is not a source of its own: it only costs Hacker News, and Bluesky still has the DOI form.
        const asked = ['Bluesky', 'Wikipedia', ...(landing ? ['Hacker News'] : []), ...(key ? ['Altmetric'] : [])];
        const allFailed = asked.every(name => failed.includes(name));
        return {...result, checked: new Date(now()).toISOString(), failed: failed.filter(n => n !== 'landing'), allFailed};
      }, value => value.failed.length ? TTL.failure : TTL.reactions);
    }

    // What is already kept for a paper, of any age and with no request: the list badge.
    const peekIssues = doiInput => { const slot = record(bareDOI(doiInput)).issues; return slot && slot.value ? slot.value : null; };

    return {issues, reactions, landingURL, peekIssues, TTL};
  }

  const api = {create, pubpeerURL, referenceDate, TTL, TIMEOUT};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleAttention = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

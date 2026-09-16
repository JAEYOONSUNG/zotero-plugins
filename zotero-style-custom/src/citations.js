/* Original identifier-verified citation lookup, independent of Zotero.
 * OpenAlex: help.openalex.org/api/authentication/ and /api/filtering/ (Sep 2026).
 * Crossref: sequential requests, below public/polite request-rate limits.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CustomStyleCitations = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function normalizeDOI(value) {
    if (typeof value !== 'string') return null;
    let text = value.trim();
    const resolver = /^https?:\/\/(?:dx\.)?doi\.org\//i;
    if (resolver.test(text)) {
      // Resolver URL decorations are not part of a DOI. Strip them before
      // decoding so encoded DOI punctuation (%3F/%23) remains intact.
      text = text.replace(resolver, '').split(/[?#]/, 1)[0];
      try { text = decodeURIComponent(text); } catch (_) { return null; }
    } else text = text.replace(/^doi:\s*/i, '');
    text = text.toLowerCase();
    return /^10\.\d{4,9}\/[^\s\u0000-\u001f]+$/.test(text) ? text : null;
  }
  function words(value) {
    return String(value || '').normalize('NFKC').replace(/<[^>]*>/g, '')
      .replace(/&amp;/gi, '&').replace(/&(?:nbsp|#160);/gi, ' ')
      .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  }
  function authorName(author) {
    if (author && typeof author === 'object') return words(author.family || author.lastName || author.name);
    return words(author);
  }
  function yearOf(value) {
    const year = typeof value === 'string' && /^\d{4}$/.test(value) ? Number(value) : value;
    return Number.isInteger(year) && year >= 1000 && year <= 3000 ? year : null;
  }
  function pmidOf(value) {
    const text = String(value || '').trim().replace(/^https?:\/\/(?:www\.)?(?:pubmed\.ncbi\.nlm\.nih\.gov\/|ncbi\.nlm\.nih\.gov\/pubmed\/)/i, '').replace(/\/$/, '').replace(/^pmid:\s*/i, '');
    return /^[1-9]\d*$/.test(text) ? text : null;
  }
  function identity(record) {
    return JSON.stringify([normalizeDOI(record.doi) || String(record.doi || '').trim(),
      pmidOf(record.pmid) || String(record.pmid || '').trim(), String(record.arxiv || '').trim().toLowerCase(),
      words(record.title), yearOf(record.year), authorName(record.firstAuthor)]);
  }
  function validCount(count) { return Number.isSafeInteger(count) && count >= 0; }
  function abortError() { const error = new Error('Citation lookup cancelled'); error.name = 'AbortError'; return error; }
  function statusOf(error) { return Number(error?.status || error?.statusCode || error?.response?.status) || 0; }
  function safeError(status, reason = 'request-failed') {
    const error = new Error(reason + (status ? ':http-' + status : ''));
    error.status = status; return error;
  }
  function doiMatches(work, doi) {
    const direct = normalizeDOI(work?.doi);
    const nested = normalizeDOI(work?.ids?.doi);
    return direct === doi && (!work.ids?.doi || nested === doi);
  }
  function conflicts(work, record) {
    const wanted = pmidOf(record.pmid);
    const actual = pmidOf(work?.ids?.pmid);
    return !!(wanted && work?.ids?.pmid && wanted !== actual);
  }
  function safeTitleMatch(record, work) {
    const title = words(record.title), author = authorName(record.firstAuthor), year = yearOf(record.year);
    const dateYears = ['issued', 'published', 'published-print', 'published-online']
      .map(field => yearOf(work?.[field]?.['date-parts']?.[0]?.[0])).filter(Boolean);
    const first = work?.author?.[0];
    const family = words(first?.family), full = words([first?.given, first?.family].filter(Boolean).join(' '));
    return title.length >= 20 && title.split(' ').length >= 4 && year && author
      && (work?.title || []).some(value => words(value) === title)
      && dateYears.includes(year) && (author === family || author === full)
      && !!normalizeDOI(work.DOI);
  }
  async function lookupMany(records, http, ctx = {}) {
    if (!Array.isArray(records) || typeof http?.getJSON !== 'function') throw new TypeError('records and http.getJSON are required');
    const now = ctx.now || Date.now;
    const results = new Array(records.length);
    const groups = new Map(), remainder = [];
    let completed = 0, crossrefLast = -Infinity, crossrefListLast = -Infinity, openalexBlocked = null;
    const crossrefCache = new Map();
    function check() { if (ctx.signal?.aborted) throw abortError(); }
    async function sleep(ms) {
      check();
      if (ms <= 0) return;
      if (ctx.sleep) { await ctx.sleep(ms, ctx.signal); check(); return; }
      await new Promise((resolve, reject) => {
        let timer;
        function abort() { clearTimeout(timer); ctx.signal?.removeEventListener('abort', abort); reject(abortError()); }
        timer = setTimeout(() => { ctx.signal?.removeEventListener('abort', abort); resolve(); }, ms);
        ctx.signal?.addEventListener('abort', abort, { once: true });
        if (ctx.signal?.aborted) abort();
      });
      check();
    }
    async function request(url, provider) {
      const headers = provider === 'OpenAlex' && ctx.openalexApiKey
        ? { Authorization: 'Bearer ' + ctx.openalexApiKey } : undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        check();
        if (provider === 'Crossref') {
          const list = url.includes('/works?');
          // Crossref's published list-query limits are stricter than singleton
          // limits: public 1/s, polite 3/s. Keep a separate list-query clock.
          await sleep(Math.max(0, (ctx.email ? 125 : 250) - Math.max(0, now() - crossrefLast),
            list ? (ctx.email ? 350 : 1100) - Math.max(0, now() - crossrefListLast) : 0));
          crossrefLast = now();
          if (list) crossrefListLast = crossrefLast;
        }
        try { const data = await http.getJSON(url, headers); check(); return data; }
        catch (error) {
          check();
          if (error?.name === 'AbortError') throw abortError();
          const status = statusOf(error);
          if (attempt === 2 || status && status !== 429 && status < 500) throw safeError(status);
          // Never retain exception messages/URLs: adapters may include credentials.
          const retryHeader = error?.retryAfter ?? error?.response?.headers?.get?.('Retry-After');
          const retrySeconds = typeof retryHeader === 'number' || typeof retryHeader === 'string' && /^\d+(?:\.\d+)?$/.test(retryHeader)
            ? Number(retryHeader) : 0;
          await sleep(Math.min(5000, Math.max(500 * 2 ** attempt, retrySeconds * 1000)));
        }
      }
    }
    function mail(url) { return ctx.email ? url + (url.includes('?') ? '&' : '?') + 'mailto=' + encodeURIComponent(ctx.email) : url; }
    async function emit(index, value) {
      check();
      const record = records[index];
      const result = { key: record.key, ...value, checkedAt: new Date(now()).toISOString(), identity: identity(record) };
      results[index] = result;
      await ctx.onResult?.(result);
      completed++;
      await ctx.onProgress?.({ completed, total: records.length, key: record.key, status: result.status });
      check();
    }
    async function crossrefDOI(doi) {
      if (crossrefCache.has(doi)) return crossrefCache.get(doi);
      let outcome;
      try {
        const data = await request(mail('https://api.crossref.org/works/' + encodeURIComponent(doi)), 'Crossref');
        if (normalizeDOI(data?.message?.DOI) !== doi) outcome = { status: 'error', reason: 'Crossref:identifier-mismatch' };
        else if (!validCount(data.message['is-referenced-by-count'])) outcome = { status: 'error', reason: 'Crossref:missing-count' };
        else outcome = { status: 'ok', count: data.message['is-referenced-by-count'], source: 'Crossref' };
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        outcome = error.status === 404 ? { status: 'not-found', reason: 'Crossref:DOI-not-found' }
          : { status: 'error', reason: 'Crossref:' + error.message };
      }
      crossrefCache.set(doi, outcome); return outcome;
    }
    check();
    for (let i = 0; i < records.length; i++) {
      const doi = normalizeDOI(records[i].doi);
      if (doi) { if (!groups.has(doi)) groups.set(doi, []); groups.get(doi).push(i); }
      else remainder.push(i);
    }
    const dois = [...groups.keys()];
    // Keep below both OR count and practical URL length limits. DOI punctuation
    // that is also filter syntax skips OpenAlex and uses the exact DOI endpoint.
    const batchable = dois.filter(doi => !/[|,+]/.test(doi) && doi.length <= 500);
    const batches = [];
    let batch = [], length = 0;
    for (const doi of batchable) {
      const size = encodeURIComponent('https://doi.org/' + doi).length + 1;
      if (batch.length && (batch.length >= 100 || length + size > 6000)) { batches.push(batch); batch = []; length = 0; }
      batch.push(doi); length += size;
    }
    if (batch.length) batches.push(batch);
    const batchSet = new Set(batchable);
    for (const doi of dois) if (!batchSet.has(doi)) batches.push([doi]);
    for (const chunk of batches) {
      check();
      let failure = openalexBlocked, works = [];
      const skip = chunk.length === 1 && !batchSet.has(chunk[0]);
      if (!failure && !skip) {
        try {
          const filter = 'doi:' + chunk.map(doi => 'https://doi.org/' + doi).join('|');
          const url = 'https://api.openalex.org/works?filter=' + encodeURIComponent(filter)
            + '&per_page=100&select=doi,ids,cited_by_count';
          const data = await request(url, 'OpenAlex');
          if (!Array.isArray(data?.results)) throw safeError(0, 'malformed-response');
          works = data.results;
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          failure = 'OpenAlex:' + error.message;
          if ([401, 403, 429].includes(error.status)) openalexBlocked = failure;
        }
      }
      for (const doi of chunk) {
        const matching = works.filter(work => doiMatches(work, doi));
        for (const index of groups.get(doi)) {
          const record = records[index];
          const candidates = matching.filter(work => !conflicts(work, record));
          let outcome;
          if (candidates.length === 1 && validCount(candidates[0].cited_by_count)) {
            outcome = { status: 'ok', count: candidates[0].cited_by_count, source: 'OpenAlex' };
          } else {
            outcome = { ...await crossrefDOI(doi) };
            // Exact DOI fallback never uses a different title-derived identifier.
            // A failed primary lookup is not proof of absence in that source.
            if (outcome.status === 'not-found' && failure) outcome = { status: 'error', reason: failure + ';' + outcome.reason };
            if (outcome.status === 'not-found' && matching.length) {
              outcome = { status: 'error', reason: 'OpenAlex:ambiguous-or-missing-count;' + outcome.reason };
            }
            if (matching.length && matching.every(work => conflicts(work, record))) {
              outcome = { status: 'error', reason: 'OpenAlex:conflicting-PMID' };
            }
          }
          await emit(index, outcome);
        }
      }
    }
    for (const index of remainder) {
      check();
      const record = records[index];
      if (record.doi) { await emit(index, { status: 'unsupported', reason: 'invalid-DOI' }); continue; }
      if (record.arxiv) { await emit(index, { status: 'unsupported', reason: 'arXiv-only-exact-lookup-unavailable' }); continue; }
      if (record.pmid) {
        const pmid = pmidOf(record.pmid);
        if (!pmid) { await emit(index, { status: 'unsupported', reason: 'invalid-PMID' }); continue; }
        if (openalexBlocked) { await emit(index, { status: 'error', reason: openalexBlocked }); continue; }
        let outcome;
        try {
          const data = await request('https://api.openalex.org/works?filter=' + encodeURIComponent('pmid:' + pmid)
            + '&per_page=100&select=doi,ids,cited_by_count', 'OpenAlex');
          if (!Array.isArray(data?.results)) throw safeError(0, 'malformed-response');
          const matches = data.results.filter(work => pmidOf(work?.ids?.pmid) === pmid);
          outcome = matches.length === 1 && validCount(matches[0].cited_by_count)
            ? { status: 'ok', count: matches[0].cited_by_count, source: 'OpenAlex' }
            : { status: matches.length ? 'error' : 'not-found', reason: matches.length ? 'OpenAlex:ambiguous-or-missing-count' : 'OpenAlex:PMID-not-found' };
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          outcome = { status: 'error', reason: 'OpenAlex:' + error.message };
          if ([401, 403, 429].includes(error.status)) openalexBlocked = outcome.reason;
        }
        await emit(index, outcome); continue;
      }
      const title = words(record.title);
      if (title.length < 20 || title.split(' ').length < 4 || !yearOf(record.year) || !authorName(record.firstAuthor)) {
        await emit(index, { status: 'unsupported', reason: 'exact-title-year-first-author-required' }); continue;
      }
      let outcome;
      try {
        const url = mail('https://api.crossref.org/works?rows=5&query.bibliographic=' + encodeURIComponent(record.title)
          + '&query.author=' + encodeURIComponent(authorName(record.firstAuthor))
          + '&select=DOI,title,author,issued,published,published-print,published-online,is-referenced-by-count');
        const data = await request(url, 'Crossref');
        if (!Array.isArray(data?.message?.items)) throw safeError(0, 'malformed-response');
        const candidates = new Map();
        for (const work of data.message.items) if (safeTitleMatch(record, work)) {
          const doi = normalizeDOI(work.DOI);
          if (!candidates.has(doi)) candidates.set(doi, work);
          else if (candidates.get(doi)['is-referenced-by-count'] !== work['is-referenced-by-count']) candidates.set(doi, { DOI: doi });
        }
        const matches = [...candidates.values()];
        outcome = matches.length === 1 && validCount(matches[0]['is-referenced-by-count'])
          ? { status: 'ok', count: matches[0]['is-referenced-by-count'], source: 'Crossref' }
          : { status: matches.length === 1 ? 'error' : 'not-found', reason: matches.length > 1 ? 'ambiguous-title-match' : matches.length ? 'Crossref:missing-count' : 'no-exact-title-year-author-match' };
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        outcome = { status: 'error', reason: 'Crossref:' + error.message };
      }
      await emit(index, outcome);
    }
    return results;
  }
  return Object.freeze({ lookupMany, identity, normalizeDOI });
});

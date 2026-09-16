/* Original local metadata model. No network requests or protected Style code. */
(function (root) {
  'use strict';
  const STATUSES = new Set(['unread', 'reading', 'done']);
  const nameOf = value => typeof value === 'string' ? value : value?.tag;
  const statusOf = value => {
    const match = /^\/(unread|reading|done)$/i.exec(String(nameOf(value) || '').trim());
    return match ? match[1].toLowerCase() : null;
  };
  function number(value, integer = false) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const clean = typeof value === 'string' ? value.trim() : value;
    if (clean === '' || (typeof clean === 'string' && !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(clean))) return null;
    const n = Number(typeof clean === 'string' ? clean.replace(/,/g, '') : clean);
    return Number.isFinite(n) && n >= 0 && (!integer || Number.isSafeInteger(n)) ? n : null;
  }
  // The observed Style JSON schema stores Total(DOI) as either an integer
  // or a numeric string. Other observed fields describe citation subsets,
  // not alternative totals. The schema does not identify provider or date.
  function readLegacyCitations(value) {
    const unknown = {citations: null, citationSource: null};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown;
    if (!Object.prototype.hasOwnProperty.call(value, 'Total(DOI)')) return unknown;
    const count = number(value['Total(DOI)'], true);
    return count === null ? unknown : {citations: count, citationSource: 'Style cache: Total(DOI)'};
  }
  const ownRating = value => {
    const match = /^style-custom:rating:([0-5])$/.exec(String(nameOf(value) || ''));
    return match ? Number(match[1]) : null;
  };
  function starRating(value) {
    const name = String(nameOf(value) || '').trim().replace(/\uFE0F/g, '');
    return /^[★⭐]{1,5}$/.test(name) ? Array.from(name).length : null;
  }
  function extraFields(extra) {
    const fields = new Map();
    for (const line of String(extra || '').split(/\r?\n/)) {
      const match = /^\s*([^:]+):\s*(.*?)\s*$/.exec(line);
      if (match) fields.set(match[1].trim().toLowerCase(), match[2]);
    }
    return fields;
  }
  function readState(tags, extra, seconds) {
    const list = Array.isArray(tags) ? tags : [];
    const states = list.map(statusOf);
    const status = states.includes('done') ? 'done' : states.includes('reading') || (number(seconds) || 0) > 0 ? 'reading' : 'unread';
    const stars = list.map(starRating).filter(n => n !== null);
    const explicit = list.map(ownRating).filter(n => n !== null);
    const raw = extraFields(extra).get('rating');
    const legacy = starRating(raw) ?? number(raw, true);
    return {status, rating: explicit.length ? explicit[explicit.length - 1] : stars.length ? Math.max(...stars) : legacy !== null && legacy <= 5 ? legacy : 0};
  }
  function updateTags(tags, patch = {}) {
    const list = Array.isArray(tags) ? tags : [];
    const hasStatus = Object.prototype.hasOwnProperty.call(patch, 'status');
    const hasRating = Object.prototype.hasOwnProperty.call(patch, 'rating');
    if (hasStatus && !STATUSES.has(patch.status)) throw new RangeError('Unknown reading status');
    if (hasRating && (!Number.isInteger(patch.rating) || patch.rating < 0 || patch.rating > 5)) throw new RangeError('Rating must be an integer from 0 to 5');
    const result = list.filter(tag => !(hasStatus && statusOf(tag)) && !(hasRating && (starRating(tag) !== null || ownRating(tag) !== null))).map(tag => typeof tag === 'object' && tag !== null ? {...tag} : tag);
    const wrap = tag => list.length && list.every(value => typeof value === 'string') ? tag : {tag, type: 0};
    if (hasStatus) result.push(wrap('/' + patch.status));
    if (hasRating) result.push(wrap('style-custom:rating:' + patch.rating));
    if (hasRating && patch.rating > 0) result.push(wrap('★'.repeat(patch.rating)));
    return result;
  }
  function safely(fn) { try { return fn(); } catch (_) { return undefined; } }
  function cached(store, item, key) {
    const value = safely(() => store?.get(item, key));
    // Item-tree readers must stay synchronous. Do not trigger asynchronous APIs.
    if (value && typeof value.then === 'function') { safely(() => value.catch?.(() => {})); return undefined; }
    return value;
  }
  function readMetrics(item, styleAPI) {
    const fields = extraFields(safely(() => item.getField('extra')));
    const result = {seconds: 0, citations: null, citationSource: null, impactFactor: null, impactSource: null};
    const reading = cached(styleAPI?.storage, item, 'readingTime');
    if (reading?.data && typeof reading.data === 'object' && !Array.isArray(reading.data)) {
      result.seconds = Object.values(reading.data).reduce((sum, value) => sum + (number(value) ?? 0), 0);
      if (!Number.isFinite(result.seconds)) result.seconds = 0;
    }
    function fromExtra(keys, integer) {
      for (const key of keys) {
        const raw = fields.get(key);
        const annotated = typeof raw === 'string' ? /^(.*?)\s+\(([^()\r\n]+)\)$/.exec(raw) : null;
        const value = number(annotated ? annotated[1] : raw, integer);
        if (value !== null) return {value, source: 'Extra: ' + key + (annotated ? ' (' + annotated[2] + ')' : '')};
      }
      return null;
    }
    const citations = fromExtra(['citation count', 'citations', 'times cited', 'zscc'], true);
    const impact = fromExtra(['impact factor', 'journal impact factor', 'jcr impact factor', 'if', 'sciif'], false);
    if (citations) { result.citations = citations.value; result.citationSource = citations.source; }
    if (impact) { result.impactFactor = impact.value; result.impactSource = impact.source; }
    // Optional adapter for the public journal-rank local store. It is a read-only
    // cache, and sciif explicitly means JCR IF (never a CiteScore or five-year IF).
    const journal = safely(() => item.getField('publicationTitle'));
    if (result.impactFactor === null && journal) {
      const rank = cached(styleAPI?.rankStorage, {key: journal}, 'rank');
      const value = number(rank?.sciif);
      if (value !== null) { result.impactFactor = value; result.impactSource = 'Style journal cache: sciif'; }
    }
    result.rating = readState(safely(() => item.getTags()), fields.has('rating') ? 'Rating: ' + fields.get('rating') : '', result.seconds).rating;
    return result;
  }
  const api = {readState, updateTags, readMetrics, readLegacyCitations};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* Original local metadata model. No network requests or protected Style code. */
(function (root) {
  'use strict';
  const STATUSES = new Set(['unread', 'reading', 'done']);
  const MIN_READING_SECONDS = 30;
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
  // A tag Zotero or a tool added by itself (type 1), as against one the reader typed.
  const isAutomatic = value => typeof value === 'object' && value !== null && Number(value.type) === 1;
  // Why readState says what it says, for a tooltip.
  function statusReason(tags, seconds) {
    const list = Array.isArray(tags) ? tags : [];
    const states = list.map(statusOf);
    const spent = (number(seconds) || 0) >= MIN_READING_SECONDS;
    if (states.includes('done')) return 'tag-done';
    if (states.includes('reading')) return 'tag-reading';
    if (states.includes('unread')) {
      const manual = list.some(tag => statusOf(tag) === 'unread' && !isAutomatic(tag));
      return !spent || manual ? 'tag-unread' : 'time-over-auto-unread';
    }
    return spent ? 'time' : 'none';
  }
  function readState(tags, extra, seconds) {
    const list = Array.isArray(tags) ? tags : [];
    const states = list.map(statusOf);
    /* Reading is a tag, or time spent. An explicit /unread tag is the reader's
       word and outranks time that is only a number (imported seconds with no
       reading of their own: 12 papers showed 읽는 중 while tagged /unread);
       the first real reading tick rewrites the tag, so live reading still
       turns it. Under MIN_READING_SECONDS a glance is not reading. */
    const spent = (number(seconds) || 0) >= MIN_READING_SECONDS;
    /* Only the reader's own /unread (a manual tag, type 0, or a bare string
       that carries no type) outranks time. An automatic one (type 1, written by
       an import or another tool) does not: ten papers with minutes of reading,
       one at 5,920 s with five stars, showed unread because of it. */
    const unreadWins = states.includes('unread') && (!spent || list.some(tag => statusOf(tag) === 'unread' && !isAutomatic(tag)));
    const status = states.includes('done') ? 'done' : states.includes('reading') ? 'reading' : unreadWins ? 'unread' : spent ? 'reading' : 'unread';
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
    const wrap = (tag, type = 0) => list.length && list.every(value => typeof value === 'string') ? tag : {tag, type};
    if (hasStatus) result.push(wrap('/' + patch.status));
    // The rating is no longer a tag. Zotero shows automatic tags by default
    // (tagSelector.showAutomatic is true), so marking it automatic did not hide
    // it: style-custom:rating:1..5 sat in a library whose whole vocabulary is
    // sixteen tags, five of which the user actually chose. It lives in Extra
    // now, which syncs, is editable by hand, and is not a subject heading.
    // Existing tags are still read, so nothing is lost before a migration.
    // A visible ★★★ tag is what Zotero prints in front of the title. The rating
    // has its own column, so writing one only clutters the title; legacy star
    // tags are still read, just not created.
    if (hasRating && patch.rating > 0 && patch.legacyStarTag) result.push(wrap('★'.repeat(patch.rating)));
    return result;
  }
  // Extra is shared ground: other tools, and the user, keep their own lines
  // there. Only the Rating line is touched, its original spelling and position
  // are kept, and everything else comes back byte for byte.
  function updateExtra(extra, patch = {}) {
    if (!Object.prototype.hasOwnProperty.call(patch, 'rating')) return String(extra == null ? '' : extra);
    const rating = patch.rating;
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) throw new RangeError('Rating must be an integer from 0 to 5');
    const text = String(extra == null ? '' : extra);
    const lines = text ? text.split(/\r?\n/) : [];
    const isRating = line => /^\s*rating\s*:/i.test(line);
    const kept = lines.filter(line => !isRating(line));
    if (rating === 0) {
      // A zero rating is "not rated", so the line goes rather than reading 0.
      return kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
    }
    const index = lines.findIndex(isRating);
    const written = 'Rating: ' + rating;
    if (index === -1) return kept.length ? [...kept, written].join('\n') : written;
    // Put it back where it was, so a hand-ordered Extra stays hand-ordered.
    const before = lines.slice(0, index).filter(line => !isRating(line));
    const after = lines.slice(index + 1).filter(line => !isRating(line));
    return [...before, written, ...after].join('\n');
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
  const api = {readState, statusReason, updateTags, updateExtra, readMetrics, readLegacyCitations};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* English and Korean. English is the default; the language setting (모양 tab
   in the panel, and Zotero's Style Custom preferences) offers English, 한국어
   and "Follow Zotero". Anything unset, empty or unknown resolves to English.

   Every string in this plugin was written in Korean, at 1,068 call sites. Going
   back to invent a key for each one and rewrite the call site would have been a
   thousand chances to break a working panel for no behavioural gain.

   So the Korean text is the key. A lookup that finds nothing returns what it
   was given, which means an untranslated string still reads correctly in Korean
   and a missing translation is a gap rather than a blank. Coverage is then a
   question about the table, which can be counted, instead of a question about
   the code.

   The translation happens at the few helpers every piece of text passes
   through -- the DOM builders, the status line, the column labels -- so one
   edit covers a whole file. */
(function (root) {
  'use strict';

  const LOCALES = ['auto', 'en-US', 'ko-KR'];

  // Filled from strings.js; kept separate so the table can be regenerated
  // without touching this logic.
  let TABLE = {};

  function load(table) {
    TABLE = table && typeof table === 'object' ? table : {};
    patterns = null; misses.clear();
    return Object.keys(TABLE).length;
  }

  const DEFAULT = 'en-US';
  let current = DEFAULT;
  let detected = DEFAULT;

  /* Which language the application is in.

     Zotero exposes its own locale, which is the honest thing to follow: a user
     running Zotero in Korean can ask for that with `auto`. Only a Korean
     Zotero locale gives Korean; empty or anything else gives English. */
  function detect(zotero) {
    let raw = '';
    try { raw = String(zotero?.locale || zotero?.Prefs?.get?.('intl.locale.requested') || '').trim(); } catch (error) { }
    detected = /^ko(\b|$)/i.test(raw) ? 'ko-KR' : DEFAULT;
    return detected;
  }

  // `auto` follows Zotero; a known language is taken as given; a missing,
  // empty or unknown choice is English, never "whatever Zotero says".
  function use(choice, zotero) {
    if (choice === 'auto') { current = detect(zotero); return current; }
    current = LOCALES.includes(choice) ? choice : DEFAULT;
    return current;
  }

  const locale = () => current;
  const isKorean = () => current === 'ko-KR';

  /* Numbers, dates and plurals follow the chosen language, not the operating
     system's: a Korean Mac with the panel in English still reads "1,234". */
  function number(value, options) {
    const n = Number(value);
    if (!Number.isFinite(n)) return value == null ? '' : String(value);
    try { return n.toLocaleString(current, options); } catch (error) { return String(n); }
  }
  function date(value, options) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    try { return d.toLocaleDateString(current, options); } catch (error) { return d.toISOString().slice(0, 10); }
  }
  function time(value, options) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    try { return d.toLocaleTimeString(current, options || {hour: '2-digit', minute: '2-digit'}); } catch (error) { return d.toISOString().slice(11, 16); }
  }
  // English has a singular; Korean does not. plural(1, 'paper', 'papers').
  function plural(n, one, many) { return isKorean() || Number(n) !== 1 ? many : one; }

  /* The lookup.

     Korean in, Korean out when Korean is the language: no table walk, no cost
     on the path every cell in the item tree takes. In English, the table is
     consulted and the original returned when it holds nothing. */
  /* Keys with {0}, {1} in them stand for strings the code fills in -- "문헌
     {0}개" for "문헌 12개". An exact lookup misses those, and the panel writes
     hundreds of them, so a miss falls through to the patterns: each such key
     is compiled once into a regular expression whose captures are put back
     into the English value in order. Misses are remembered so a string that
     matches nothing costs one walk, not one per redraw. */
  let patterns = null, patternTable = null;
  const misses = new Set();
  function compilePatterns() {
    if (patterns && patternTable === TABLE) return patterns;
    patternTable = TABLE; misses.clear();
    patterns = [];
    for (const key of Object.keys(TABLE)) {
      if (!/\{\d+\}/.test(key)) continue;
      const order = [];
      const source = key.split(/(\{\d+\})/).map(part => {
        const m = part.match(/^\{(\d+)\}$/);
        if (m) { order.push(Number(m[1])); return '([\\s\\S]*?)'; }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('');
      patterns.push({key, order, re: new RegExp('^' + source + '$'), value: TABLE[key], weight: key.replace(/\{\d+\}/g, '').length});
    }
    // Longest fixed text first, so "문헌 {0}개 · 읽음 {1}" beats "{0}개".
    patterns.sort((a, b) => b.weight - a.weight);
    return patterns;
  }
  /* The table holds one English sentence per Korean one, and Korean has no
     plural. "{0} papers" filled with 1 would read "1 papers", so a filled-in
     English string turns "1 <plural noun>" into the singular. The nouns are
     the ones the table uses after a number. */
  const SINGULAR = {papers: 'paper', items: 'item', days: 'day', journals: 'journal', notes: 'note', annotations: 'annotation',
    references: 'reference', authors: 'author', pages: 'page', requests: 'request', people: 'person', connections: 'connection',
    collections: 'collection', institutions: 'institution', citations: 'citation', entries: 'entry', comments: 'comment',
    cards: 'card', batches: 'batch', errors: 'error', files: 'file', tags: 'tag', attachments: 'attachment', links: 'link',
    results: 'result', sources: 'source', rows: 'row', works: 'work', years: 'year', times: 'time', hours: 'hour', minutes: 'minute',
    seconds: 'second', months: 'month', weeks: 'week', matches: 'match', records: 'record', groups: 'group', tabs: 'tab', views: 'view'};
  const PLURAL_ONE = new RegExp('(?<![\\d.,])1 (' + Object.keys(SINGULAR).join('|') + ')\\b(?![.,]?\\d)', 'g');
  function singular(text) {
    return /(^|[^\d.,])1 [a-z]/.test(text) ? text.replace(PLURAL_ONE, (whole, noun) => '1 ' + SINGULAR[noun]) : text;
  }
  function byPattern(text) {
    if (misses.has(text)) return undefined;
    for (const p of compilePatterns()) {
      const m = text.match(p.re);
      if (!m) continue;
      const fills = new Map();
      p.order.forEach((n, i) => { if (!fills.has(n)) fills.set(n, m[i + 1]); });
      return singular(p.value.replace(/\{(\d+)\}/g, (_, n) => (fills.has(Number(n)) ? fills.get(Number(n)) : '')));
    }
    if (misses.size > 4000) misses.clear();
    misses.add(text);
    return undefined;
  }
  function t(text) {
    if (current === 'ko-KR') return text;
    if (typeof text !== 'string' || !text) return text;
    const found = TABLE[text];
    if (found !== undefined) return found;
    if (!/[가-힣]/.test(text)) return text;
    const fitted = byPattern(text);
    return fitted === undefined ? text : fitted;
  }

  // A string with numbers or names already substituted into it will not be in
  // the table. This splits on the parts that vary so the fixed parts still
  // translate: t.of`문헌 ${n}개` looks up "문헌 {0}개".
  function template(strings, ...values) {
    const pattern = strings.raw.map((part, i) => part + (i < values.length ? '{' + i + '}' : '')).join('');
    const translated = t(pattern);
    const filled = translated.replace(/\{(\d+)\}/g, (whole, index) => {
      const value = values[Number(index)];
      return value === undefined ? whole : String(value);
    });
    return current === 'ko-KR' ? filled : singular(filled);
  }

  // What the table does not cover yet, so coverage is a number rather than an
  // impression.
  function coverage(strings) {
    const wanted = [...new Set((Array.isArray(strings) ? strings : []).filter(Boolean))];
    const missing = wanted.filter(text => TABLE[text] === undefined);
    return {total: wanted.length, translated: wanted.length - missing.length, missing};
  }

  const api = {t, template, use, detect, locale, isKorean, load, coverage, LOCALES, DEFAULT, singular, number, date, time, plural,
    _table: () => TABLE};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleI18N = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

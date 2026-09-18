/* English and Korean, chosen by the application's own locale.

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
    return Object.keys(TABLE).length;
  }

  let current = 'ko-KR';
  let detected = 'ko-KR';

  /* Which language the application is in.

     Zotero exposes its own locale, which is the honest thing to follow: a user
     running Zotero in English wants this panel in English without being asked.
     `auto` means that; the other two override it. */
  function detect(zotero) {
    const raw = String(zotero?.locale || zotero?.Prefs?.get?.('intl.locale.requested') || '').trim();
    detected = /^ko\b/i.test(raw) ? 'ko-KR' : raw ? 'en-US' : 'ko-KR';
    return detected;
  }

  function use(choice, zotero) {
    if (choice === 'auto' || !LOCALES.includes(choice)) {
      current = detect(zotero);
      return current;
    }
    current = choice;
    return current;
  }

  const locale = () => current;
  const isKorean = () => current === 'ko-KR';

  /* The lookup.

     Korean in, Korean out when Korean is the language: no table walk, no cost
     on the path every cell in the item tree takes. In English, the table is
     consulted and the original returned when it holds nothing. */
  function t(text) {
    if (current === 'ko-KR') return text;
    if (typeof text !== 'string' || !text) return text;
    const found = TABLE[text];
    return found === undefined ? text : found;
  }

  // A string with numbers or names already substituted into it will not be in
  // the table. This splits on the parts that vary so the fixed parts still
  // translate: t.of`문헌 ${n}개` looks up "문헌 {0}개".
  function template(strings, ...values) {
    const pattern = strings.raw.map((part, i) => part + (i < values.length ? '{' + i + '}' : '')).join('');
    const translated = t(pattern);
    return translated.replace(/\{(\d+)\}/g, (whole, index) => {
      const value = values[Number(index)];
      return value === undefined ? whole : String(value);
    });
  }

  // What the table does not cover yet, so coverage is a number rather than an
  // impression.
  function coverage(strings) {
    const wanted = [...new Set((Array.isArray(strings) ? strings : []).filter(Boolean))];
    const missing = wanted.filter(text => TABLE[text] === undefined);
    return {total: wanted.length, translated: wanted.length - missing.length, missing};
  }

  const api = {t, template, use, detect, locale, isKorean, load, coverage, LOCALES,
    _table: () => TABLE};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleI18N = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

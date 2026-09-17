/* Reading history left behind in another plugin's notes.

   Ethereal Style kept per-page reading time as notes under one container item,
   each note naming its paper by key and carrying a readingTime object. That is
   the only copy: its own JSON store holds citation counts and nothing else. So
   the history has to be read out of the notes before the plugin that wrote them
   is removed. Pure parsing; the caller resolves keys and writes. */
(function (root) {
  'use strict';

  const KEY = /^[A-Z0-9]{8}$/;

  // Notes are HTML. The payload is the only JSON object in the body, and the
  // key sits immediately before it.
  function parseNote(html) {
    const text = String(html == null ? '' : html)
      .replace(/<[^>]*>/g, '\n')
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const key = (text.match(/\b([A-Z0-9]{8})\b/) || [])[1];
    if (!key || !KEY.test(key)) return null;
    const start = text.indexOf('{"readingTime"');
    if (start === -1) return null;
    let payload;
    try { payload = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1)); }
    catch (_) { return null; }
    const reading = payload?.readingTime;
    if (!reading || typeof reading !== 'object') return null;

    const pageTimes = {};
    let seconds = 0;
    for (const [page, value] of Object.entries(reading.data || {})) {
      const index = Number(page), amount = Number(value);
      if (!Number.isInteger(index) || index < 0 || index > 100000) continue;
      if (!Number.isFinite(amount) || amount <= 0) continue;
      pageTimes[index] = amount;
      seconds += amount;
    }
    if (!seconds) return null;
    const totalPages = Number.isInteger(reading.page) && reading.page > 0 ? reading.page : null;
    return {key, totalPages, pageTimes, seconds};
  }

  // A note is bookkeeping, not writing, when parsing it yields a reading record.
  // The Notes tab uses this to keep 228 machine notes out of a list of five.
  const isBookkeeping = html => parseNote(html) !== null;

  const api = {parseNote, isBookkeeping};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleLegacyReading = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

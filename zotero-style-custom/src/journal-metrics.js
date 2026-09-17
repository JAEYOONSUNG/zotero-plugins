/* Impact figures for journals the curated catalogue does not cover.

   The catalogue holds 86 journals with real Clarivate JIFs; this library spans
   255, so two thirds of the rows were blank and the reader had to go and look
   them up somewhere else. OpenAlex publishes a two-year mean citedness for
   essentially every indexed journal, which is close in spirit to a JIF but is
   NOT one, so it is kept as a separate, separately-labelled figure and never
   allowed to overwrite a curated value. Pure: URL building and response
   shaping; the caller makes every request. */
(function (root) {
  'use strict';

  const API = 'https://api.openalex.org/';
  const text = value => String(value == null ? '' : value).trim();
  const SELECT = 'id,display_name,issn_l,issn,type,summary_stats,works_count,alternate_titles';

  const credentials = ({email, apiKey} = {}) =>
    (apiKey ? '&api_key=' + encodeURIComponent(apiKey) : '')
    + (email ? '&mailto=' + encodeURIComponent(email) : '');

  const normalise = value => text(value).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|of|for|and|in|on)\b/g, ' ')
    // Collapse again: removing stop words leaves gaps, and "journal   bacteriology"
    // would never equal "journal bacteriology".
    .replace(/\s+/g, ' ')
    .trim();

  const cleanISSN = value => text(value).toUpperCase().replace(/[^0-9X]/g, '');

  // An ISSN names one journal; a title is a guess. Prefer it when the item has one.
  function lookupURL({name, issn} = {}, options = {}) {
    const code = cleanISSN(issn);
    if (code.length === 8) {
      return `${API}sources?per_page=1&filter=${encodeURIComponent('issn:' + code.slice(0, 4) + '-' + code.slice(4))}`
        + `&select=${SELECT}${credentials(options)}`;
    }
    const title = text(name);
    if (!title) return null;
    return `${API}sources?per_page=5&filter=${encodeURIComponent('display_name.search:' + title)}`
      + `&select=${SELECT}${credentials(options)}`;
  }

  function shapeSource(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const stats = raw.summary_stats || {};
    const metric = Number(stats['2yr_mean_citedness']);
    return {
      id: text(raw.id).replace(/^https?:\/\/openalex\.org\//i, ''),
      name: text(raw.display_name),
      issn: cleanISSN(raw.issn_l),
      type: text(raw.type),
      works: Number.isInteger(raw.works_count) ? raw.works_count : null,
      // Rounded to one place: the extra digits are false precision for a figure
      // this rough, and a column of them is harder to scan.
      citedness: Number.isFinite(metric) && metric >= 0 ? Math.round(metric * 10) / 10 : null,
      hIndex: Number.isInteger(stats.h_index) ? stats.h_index : null,
      titles: [text(raw.display_name), ...(Array.isArray(raw.alternate_titles) ? raw.alternate_titles.map(text) : [])]
        .filter(Boolean)
    };
  }

  // A search returns near-misses ("Nature" also brings "Nature Reviews ..."),
  // so a title match has to be exact once both sides are normalised.
  function pickSource(payload, {name, issn} = {}) {
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const shaped = results.map(shapeSource).filter(Boolean);
    if (!shaped.length) return null;
    const code = cleanISSN(issn);
    if (code.length === 8) {
      const byISSN = shaped.find(source => source.issn === code);
      if (byISSN) return byISSN;
    }
    const wanted = normalise(name);
    if (!wanted) return null;
    const exact = shaped.filter(source => source.titles.some(title => normalise(title) === wanted));
    if (!exact.length) return null;
    // Among journals of the same name, the one that actually publishes.
    return exact.sort((a, b) => (b.works || 0) - (a.works || 0))[0];
  }

  // Journals are cached by name so a library of 1,116 items costs 255 lookups.
  const cacheKey = ({name, issn} = {}) => {
    const code = cleanISSN(issn);
    return code.length === 8 ? 'issn:' + code : 'name:' + normalise(name);
  };

  const api = {API, lookupURL, pickSource, shapeSource, cacheKey, normalise, cleanISSN, credentials};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleJournalMetrics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

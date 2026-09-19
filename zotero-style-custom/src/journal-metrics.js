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
  // The profile fields ride on the same request the metric already costs:
  // publisher, country, homepage, open-access status, the fee, the subjects
  // it publishes in. JCR's journal page shows these, and its site needs an
  // institutional login; OpenAlex answers them without one.
  const SELECT = 'id,display_name,issn_l,issn,type,summary_stats,works_count,cited_by_count,alternate_titles,'
    + 'host_organization_name,country_code,homepage_url,is_oa,is_in_doaj,apc_usd,topics';

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

  // Zotero's ISSN field routinely holds both the print and electronic number,
  // as "0304-8608, 1432-8798". Stripping punctuation across the whole string
  // produced a sixteen-digit non-ISSN, which silently fell through to the title
  // search -- ten times the cost and a worse match. Take the first one.
  const issnList = value => (text(value).toUpperCase().match(/\d{4}\s*-?\s*\d{3}[\dX]/g) || [])
    .map(code => code.replace(/[^0-9X]/g, ''))
    .filter(code => code.length === 8);
  const cleanISSN = value => {
    const bare = text(value).toUpperCase().replace(/[^0-9X]/g, '');
    if (bare.length === 8) return bare;
    return issnList(value)[0] || '';
  };

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
      // A journal has a print and an electronic ISSN, and issn_l is only one of
      // them. Matching on issn_l alone rejects a source found by the other.
      issns: [...new Set([cleanISSN(raw.issn_l),
        ...(Array.isArray(raw.issn) ? raw.issn : [raw.issn]).map(cleanISSN)].filter(Boolean))],
      type: text(raw.type),
      works: Number.isInteger(raw.works_count) ? raw.works_count : null,
      // Rounded to one place: the extra digits are false precision for a figure
      // this rough, and a column of them is harder to scan.
      citedness: Number.isFinite(metric) && metric >= 0 ? Math.round(metric * 10) / 10 : null,
      hIndex: Number.isInteger(stats.h_index) ? stats.h_index : null,
      titles: [text(raw.display_name), ...(Array.isArray(raw.alternate_titles) ? raw.alternate_titles.map(text) : [])]
        .filter(Boolean),
      ...profileOf(raw)
    };
  }

  // What a journal's page says beyond its figure. Topics come ranked by how
  // many of the journal's papers fall in each; the fields those topics sit in
  // are what "which subject is this journal in" is answered with.
  function profileOf(raw) {
    const topics = (Array.isArray(raw?.topics) ? raw.topics : [])
      .map(t => ({name: text(t?.display_name), field: text(t?.field?.display_name), subfield: text(t?.subfield?.display_name), domain: text(t?.domain?.display_name), count: Number.isInteger(t?.count) ? t.count : 0}))
      .filter(t => t.name).slice(0, 6);
    const fields = [];
    for (const t of topics) if (t.field && !fields.includes(t.field)) fields.push(t.field);
    const apc = Number(raw?.apc_usd);
    return {
      publisher: text(raw?.host_organization_name),
      country: text(raw?.country_code).toUpperCase(),
      homepage: /^https?:\/\//i.test(text(raw?.homepage_url)) ? text(raw.homepage_url) : '',
      isOA: raw?.is_oa === true, inDoaj: raw?.is_in_doaj === true,
      apc: Number.isFinite(apc) && apc >= 0 ? apc : null,
      cited: Number.isInteger(raw?.cited_by_count) ? raw.cited_by_count : null,
      topics, fields
    };
  }

  // Fifty journals in one request, by ISSN, for filling in the profiles of
  // journals whose figure is already cached.
  function profilesURL(issns, options = {}) {
    const codes = [...new Set((Array.isArray(issns) ? issns : []).map(cleanISSN).filter(code => code.length === 8))].slice(0, 50);
    if (!codes.length) return null;
    const filter = 'issn:' + codes.map(code => code.slice(0, 4) + '-' + code.slice(4)).join('|');
    return `${API}sources?per_page=50&filter=${encodeURIComponent(filter)}&select=${SELECT}${credentials(options)}`;
  }

  function readSources(payload) {
    return (Array.isArray(payload?.results) ? payload.results : []).map(shapeSource).filter(Boolean);
  }

  // A search returns near-misses ("Nature" also brings "Nature Reviews ..."),
  // so a title match has to be exact once both sides are normalised.
  function pickSource(payload, {name, issn} = {}) {
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const shaped = results.map(shapeSource).filter(Boolean);
    if (!shaped.length) return null;
    const code = cleanISSN(issn);
    if (code.length === 8) {
      const byISSN = shaped.find(source => source.issns.includes(code));
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

  const api = {API, lookupURL, pickSource, shapeSource, profileOf, profilesURL, readSources, cacheKey, normalise, cleanISSN, issnList, credentials};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleJournalMetrics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

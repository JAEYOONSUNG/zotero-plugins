/* Finding what to read next: papers related to one you have, and what a given
   author is publishing now. Pure URL building and response shaping; the caller
   makes every request. Backed by OpenAlex, which needs no key. */
(function (root) {
  'use strict';

  const API = 'https://api.openalex.org/';
  const text = value => String(value == null ? '' : value).trim();
  const bareDOI = value => text(value).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase();
  const shortID = value => text(value).replace(/^https?:\/\/openalex\.org\//i, '').toUpperCase();

  // A key raises the daily budget but is optional; a mailto gets the polite pool.
  function credentials({email, apiKey} = {}) {
    return (apiKey ? '&api_key=' + encodeURIComponent(apiKey) : '')
      + (email ? '&mailto=' + encodeURIComponent(email) : '');
  }

  const WORK_FIELDS = 'id,doi,title,publication_year,cited_by_count,type,'
    + 'primary_location,authorships,related_works,referenced_works,open_access';

  function workURL(record, options = {}) {
    const doi = bareDOI(record?.DOI || record?.doi);
    if (doi) return `${API}works/doi:${encodeURIComponent(doi)}?select=${WORK_FIELDS}${credentials(options)}`;
    const title = text(record?.title);
    if (!title) return null;
    // Without a DOI, the title search is the only handle, so ask for one result.
    return `${API}works?per_page=1&filter=${encodeURIComponent('title.search:' + title)}`
      + `&select=${WORK_FIELDS}${credentials(options)}`;
  }

  // OpenAlex caps a filter list; batching keeps the URL inside its limits.
  function worksByIDsURL(ids, options = {}) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(shortID).filter(Boolean))].slice(0, 50);
    if (!list.length) return null;
    return `${API}works?per_page=${list.length}`
      + `&filter=${encodeURIComponent('openalex_id:' + list.join('|'))}`
      + `&select=${WORK_FIELDS}${credentials(options)}`;
  }

  function shapeWork(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = shortID(raw.id);
    if (!id) return null;
    // Keep each author's OpenAlex id. Looking one up by name alone picks the
    // wrong person: "Eugene Kim" matches a surgeon before the biophysicist.
    const people = (Array.isArray(raw.authorships) ? raw.authorships : [])
      .map(a => ({
        id: shortID(a?.author?.id),
        name: text(a?.author?.display_name),
        institution: text((Array.isArray(a?.institutions) ? a.institutions : [])[0]?.display_name),
        position: text(a?.author_position)
      }))
      .filter(a => a.name);
    const authors = people.map(a => a.name);
    return {
      id, doi: bareDOI(raw.doi), title: text(raw.title),
      year: Number.isInteger(raw.publication_year) ? raw.publication_year : null,
      citations: Number.isInteger(raw.cited_by_count) ? raw.cited_by_count : null,
      venue: text(raw.primary_location?.source?.display_name),
      authors, people, type: text(raw.type),
      openAccess: raw.open_access?.is_oa === true,
      pdfURL: text(raw.primary_location?.pdf_url) || text(raw.open_access?.oa_url),
      related: (Array.isArray(raw.related_works) ? raw.related_works : []).map(shortID).filter(Boolean),
      references: (Array.isArray(raw.referenced_works) ? raw.referenced_works : []).map(shortID).filter(Boolean)
    };
  }

  // A /works/doi: lookup returns the work itself; a title search returns a list.
  function readWork(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (Array.isArray(payload.results)) return shapeWork(payload.results[0]);
    return shapeWork(payload);
  }
  const readWorks = payload => (Array.isArray(payload?.results) ? payload.results : [])
    .map(shapeWork).filter(Boolean);

  // OpenAlex's own related_works come first; references fill the rest, because a
  // paper's own bibliography is the most reliable "read this next" there is.
  function mergeSuggestions(work, found, {have = new Set(), limit = 40} = {}) {
    if (!work) return [];
    const byID = new Map(found.map(w => [w.id, w]));
    const rank = new Map();
    work.related.forEach((id, i) => rank.set(id, {source: 'related', order: i}));
    work.references.forEach((id, i) => { if (!rank.has(id)) rank.set(id, {source: 'reference', order: i}); });
    const owned = new Set([...have].map(value => bareDOI(value)).filter(Boolean));
    return [...rank.entries()]
      .map(([id, meta]) => {
        const hit = byID.get(id);
        return hit ? {...hit, ...meta, inLibrary: !!hit.doi && owned.has(hit.doi)} : null;
      })
      .filter(Boolean)
      .sort((a, b) => (a.source === b.source ? a.order - b.order : a.source === 'related' ? -1 : 1))
      .slice(0, limit);
  }

  const authorSearchURL = (name, options = {}) => text(name)
    ? `${API}authors?per_page=8&search=${encodeURIComponent(text(name))}`
      + `&select=id,display_name,works_count,cited_by_count,summary_stats,last_known_institutions,topics,orcid`
      + credentials(options)
    : null;

  function shapeAuthor(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = shortID(raw.id);
    if (!id) return null;
    const institutions = (Array.isArray(raw.last_known_institutions) ? raw.last_known_institutions : [])
      .map(i => text(i?.display_name)).filter(Boolean);
    return {
      id, name: text(raw.display_name), orcid: text(raw.orcid),
      works: Number.isInteger(raw.works_count) ? raw.works_count : null,
      citations: Number.isInteger(raw.cited_by_count) ? raw.cited_by_count : null,
      hIndex: Number.isInteger(raw.summary_stats?.h_index) ? raw.summary_stats.h_index : null,
      i10: Number.isInteger(raw.summary_stats?.i10_index) ? raw.summary_stats.i10_index : null,
      institutions,
      // What the author actually works on, which is the point of looking them up.
      topics: (Array.isArray(raw.topics) ? raw.topics : []).slice(0, 6)
        .map(t => ({name: text(t?.display_name), count: Number.isInteger(t?.count) ? t.count : null}))
        .filter(t => t.name)
    };
  }
  const readAuthors = payload => (Array.isArray(payload?.results) ? payload.results : [])
    .map(shapeAuthor).filter(Boolean);

  const authorWorksURL = (authorID, options = {}) => shortID(authorID).startsWith('A')
    ? `${API}works?per_page=${Math.min(50, options.limit || 25)}`
      + `&filter=${encodeURIComponent('author.id:' + shortID(authorID))}`
      + `&sort=publication_date:desc&select=${WORK_FIELDS}${credentials(options)}`
    : null;

  // The name as the author themselves would search for it.
  function authorNames(item) {
    const creators = typeof item?.getCreators === 'function' ? item.getCreators() : [];
    const seen = new Set();
    const names = [];
    for (const creator of Array.isArray(creators) ? creators : []) {
      if (creator?.creatorType && creator.creatorType !== 'author') continue;
      const name = [text(creator?.firstName), text(creator?.lastName || creator?.name)].filter(Boolean).join(' ');
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
    return names;
  }

  const api = {API, workURL, worksByIDsURL, readWork, readWorks, mergeSuggestions,
    authorSearchURL, readAuthors, authorWorksURL, authorNames, shortID, bareDOI, credentials};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleDiscover = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

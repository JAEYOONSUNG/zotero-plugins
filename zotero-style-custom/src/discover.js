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
    + 'primary_location,authorships,related_works,referenced_works,open_access,topics';

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

  // OpenAlex classifies a work at four widening levels. Keeping all four lets a
  // candidate be scored on how closely it sits to the paper in hand.
  function subjectsOf(raw) {
    const topics = Array.isArray(raw?.topics) ? raw.topics : [];
    const pick = (list, key) => new Set(list.map(t => shortID(t?.[key]?.id)).filter(Boolean));
    return {
      topic: new Set(topics.map(t => shortID(t?.id)).filter(Boolean)),
      subfield: pick(topics, 'subfield'),
      field: pick(topics, 'field'),
      domain: pick(topics, 'domain')
    };
  }

  const shares = (a, b) => [...(a || [])].some(id => b?.has(id));

  // OpenAlex's related_works can be plainly wrong -- a Russian pedagogy paper
  // turns up beside a bacterial condensin study -- so a candidate has to sit in
  // the same part of the literature to be worth showing at all.
  function relevance(work, source) {
    if (!work?.subjects || !source?.subjects) return 0;
    if (shares(work.subjects.topic, source.subjects.topic)) return 3;
    if (shares(work.subjects.subfield, source.subjects.subfield)) return 2;
    if (shares(work.subjects.field, source.subjects.field)) return 1;
    return 0;
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
      references: (Array.isArray(raw.referenced_works) ? raw.referenced_works : []).map(shortID).filter(Boolean),
      subjects: subjectsOf(raw)
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
  // Papers that cite this one are the strongest signal, then the ones it chose
  // to cite; OpenAlex's computed "related" is the weakest and goes last.
  const GROUPS = ['citing', 'reference', 'related'];
  const GROUP_RANK = new Map(GROUPS.map((name, i) => [name, i]));

  function mergeSuggestions(work, found, {have = new Set(), limit = 40, citing = []} = {}) {
    if (!work) return [];
    const byID = new Map(found.map(w => [w.id, w]));
    for (const cited of citing) byID.set(cited.id, cited);
    const rank = new Map();
    citing.forEach((w, i) => rank.set(w.id, {source: 'citing', order: i}));
    work.references.forEach((id, i) => { if (!rank.has(id)) rank.set(id, {source: 'reference', order: i}); });
    work.related.forEach((id, i) => { if (!rank.has(id)) rank.set(id, {source: 'related', order: i}); });
    rank.delete(work.id);
    const owned = new Set([...have].map(value => bareDOI(value)).filter(Boolean));
    return [...rank.entries()]
      .map(([id, meta]) => {
        const hit = byID.get(id);
        if (!hit) return null;
        const score = relevance(hit, work);
        // Nothing in common with the source paper is noise, whatever list it came from.
        if (!score) return null;
        return {...hit, ...meta, relevance: score, inLibrary: !!hit.doi && owned.has(hit.doi)};
      })
      .filter(Boolean)
      .sort((a, b) => GROUP_RANK.get(a.source) - GROUP_RANK.get(b.source)
        || b.relevance - a.relevance
        || (b.citations ?? 0) - (a.citations ?? 0))
      .slice(0, limit);
  }

  // Papers that cite this one, newest and most-cited first.
  const citingURL = (workID, options = {}) => shortID(workID).startsWith('W')
    ? `${API}works?per_page=${Math.min(50, options.limit || 25)}`
      + `&filter=${encodeURIComponent('cites:' + shortID(workID))}`
      + `&sort=cited_by_count:desc&select=${WORK_FIELDS}${credentials(options)}`
    : null;

  // Matching an author by name alone picks the wrong person often enough to be
  // useless. An institution narrows it decisively, so it is scored first and a
  // name-only match is only accepted when nothing else is close.
  const normalise = value => text(value).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(university|universite|universiteit|universitat|univ|college|institute|institut|school|of|the|for|and|at)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();

  const nameParts = value => normalise(value).split(' ').filter(Boolean);

  function scoreAuthor(candidate, {name, institution} = {}) {
    const wanted = nameParts(name);
    const got = nameParts(candidate?.name);
    if (!wanted.length || !got.length) return 0;
    // The family name is the one part that must agree.
    if (wanted[wanted.length - 1] !== got[got.length - 1]) return 0;
    let score = 1;
    if (wanted.length > 1 && got.length > 1) {
      if (wanted[0] === got[0]) score += 2;
      else if (wanted[0][0] === got[0][0]) score += 1;
    }
    const place = normalise(institution);
    if (place) {
      const homes = (candidate?.institutions || []).map(normalise).filter(Boolean);
      const words = place.split(' ').filter(word => word.length > 2);
      if (homes.some(home => words.some(word => home.includes(word)))) score += 4;
    }
    // OpenAlex often records a former affiliation, so the institution cannot be
    // relied on alone. Standing can, but only as a tie-break: capping it would
    // flatten two well-known namesakes onto the same ceiling.
    return score + Math.min(3, (candidate?.hIndex || 0) / 25);
  }

  const institutionMatched = (candidate, wanted) =>
    scoreAuthor(candidate, wanted) - scoreAuthor({...candidate, institutions: []}, wanted) >= 4;

  // Returns the best candidate, or null when nothing is clearly right. Watching
  // the wrong person is worse than watching nobody, so an unclear field is
  // refused rather than guessed: without a matching institution the leader has
  // to dominate outright.
  function pickAuthor(candidates, wanted = {}) {
    const ranked = (Array.isArray(candidates) ? candidates : [])
      .map(candidate => ({candidate, score: scoreAuthor(candidate, wanted)}))
      .filter(row => row.score > 0)
      .sort((a, b) => b.score - a.score);
    if (!ranked.length) return null;
    const [best, next] = ranked;
    if (!next) return {...best.candidate, matchScore: best.score};
    // A matching institution is decisive; a small score margin is then enough.
    if (institutionMatched(best.candidate, wanted)) {
      return best.score - next.score >= 1 ? {...best.candidate, matchScore: best.score} : null;
    }
    // Otherwise the leader has to dominate outright. Comparing standing as a
    // ratio keeps two eminent namesakes apart, where a capped score cannot.
    const top = best.candidate?.hIndex || 0, rival = next.candidate?.hIndex || 0;
    const dominates = top >= 10 && top >= rival * 2;
    return dominates ? {...best.candidate, matchScore: best.score} : null;
  }

  // "Jason William Chin" returns nothing; "Jason Chin" returns him first. A
  // middle name recorded by hand is often absent from the indexed name.
  function authorQueries(name) {
    const parts = text(name).split(/\s+/).filter(Boolean);
    const queries = [text(name)];
    if (parts.length > 2) queries.push(parts[0] + ' ' + parts[parts.length - 1]);
    return [...new Set(queries.filter(Boolean))];
  }

  const authorSearchURL = (name, options = {}) => text(name)
    ? `${API}authors?per_page=10&filter=${encodeURIComponent('display_name.search:' + text(name))}`
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

  const api = {API, GROUPS, scoreAuthor, pickAuthor, authorQueries, workURL, worksByIDsURL, citingURL, readWork, readWorks, mergeSuggestions, relevance,
    authorSearchURL, readAuthors, authorWorksURL, authorNames, shortID, bareDOI, credentials};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleDiscover = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* Whether a paper is still standing: retraction and correction notices, open
   access, and whether a preprint has since been published. Pure URL building,
   response shaping and classification; the caller performs every request.

   Measured against the live services, because the field names are not what the
   documentation suggests:
   - Crossref puts `update-to` on the *notice*, pointing at the paper it acts
     on, and `updated-by` on the *paper*, pointing at its notices. A retracted
     paper is therefore recognised by `updated-by`, never by `update-to`;
     reading `update-to` alone would paint the retraction notice red and leave
     the retracted paper looking clean, which is the exact failure to avoid.
   - `updated-by` can list the same notice twice with different `source` and
     dates (publisher plus Retraction Watch), and can mix severities: the
     Wakefield Lancet paper carries a 2004 correction and a 2010 retraction.
   - OpenAlex no longer resolves a preprint DOI once the preprint is merged
     into the published work: /works/doi:10.1101/... answers 404 while the
     published work lists that preprint DOI among its locations. The link has
     to be found by title and then confirmed by that DOI. */
(function (root) {
  'use strict';

  const CROSSREF = 'https://api.crossref.org/works/';
  const OPENALEX = 'https://api.openalex.org/';
  const text = value => String(value == null ? '' : value).trim();
  const bareDOI = value => text(value)
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .toLowerCase();

  // A mailto gets Crossref's and OpenAlex's polite pools; the OpenAlex key
  // raises the daily budget. Both are optional.
  const politeness = ({email} = {}) => email ? '?mailto=' + encodeURIComponent(email) : '';

  function crossrefURL(record, options = {}) {
    const doi = bareDOI(record?.DOI || record?.doi);
    // Crossref is a DOI registry: without a DOI there is nothing to ask it.
    // A title search would answer with somebody else's retraction.
    return doi ? CROSSREF + encodeURIComponent(doi) + politeness(options) : null;
  }

  const credentials = ({email, apiKey} = {}) =>
    (apiKey ? '&api_key=' + encodeURIComponent(apiKey) : '')
    + (email ? '&mailto=' + encodeURIComponent(email) : '');

  const WORK_FIELDS = 'id,doi,title,type,publication_year,is_retracted,is_paratext,'
    + 'open_access,best_oa_location,primary_location,locations,locations_count';

  function openAlexURL(record, options = {}) {
    const doi = bareDOI(record?.DOI || record?.doi);
    return doi ? `${OPENALEX}works/doi:${encodeURIComponent(doi)}?select=${WORK_FIELDS}${credentials(options)}` : null;
  }

  // Only used when the DOI lookup fails, which for a preprint usually means it
  // has been merged into the published work and is no longer addressable.
  function openAlexTitleURL(record, options = {}) {
    const title = text(record?.title);
    if (!title) return null;
    return `${OPENALEX}works?per_page=5&filter=${encodeURIComponent('title.search:' + title)}`
      + `&select=${WORK_FIELDS}${credentials(options)}`;
  }

  // Crossref's update vocabulary, graded by what it means for a reader. A
  // retraction says the findings are withdrawn; an expression of concern says
  // they are under investigation; a correction says the paper stands with an
  // amendment. Anything unrecognised is reported at correction strength under
  // its own label rather than being dropped: a notice we cannot name is still
  // a notice the reader should see.
  const RANK = {
    retraction: 3, partial_retraction: 3, removal: 3, withdrawal: 3,
    expression_of_concern: 2,
    correction: 1, corrigendum: 1, erratum: 1, addendum: 1,
    clarification: 1, new_edition: 1, new_version: 1
  };
  const noticeRank = type => RANK[text(type).toLowerCase().replace(/[\s-]+/g, '_')] ?? 1;
  const STATUS_BY_RANK = {3: 'retracted', 2: 'concern', 1: 'corrected', 0: 'ok'};

  function noticeDate(update) {
    const parts = update?.updated?.['date-parts'];
    const row = Array.isArray(parts) ? parts[0] : null;
    if (!Array.isArray(row) || !Number.isInteger(row[0])) return '';
    return [row[0], row[1], row[2]].filter(Number.isInteger)
      .map((n, i) => i ? String(n).padStart(2, '0') : String(n)).join('-');
  }

  function shapeUpdates(list) {
    const seen = new Map();
    for (const update of Array.isArray(list) ? list : []) {
      const type = text(update?.type).toLowerCase().replace(/[\s-]+/g, '_');
      const doi = bareDOI(update?.DOI || update?.doi);
      if (!type && !doi) continue;
      // The same notice is deposited by the publisher and by Retraction Watch
      // with different dates. One notice, earliest date it is known to bear.
      const key = doi + '|' + type;
      const row = {doi, type, label: text(update?.label) || type.replace(/_/g, ' '),
        date: noticeDate(update), rank: noticeRank(type)};
      const previous = seen.get(key);
      if (!previous) seen.set(key, row);
      else if (row.date && (!previous.date || row.date < previous.date)) previous.date = row.date;
    }
    return [...seen.values()].sort((a, b) => b.rank - a.rank || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  // Crossref states a relation both ways round; `is-retracted-by` is rare but
  // authoritative where a publisher used it instead of an update deposit.
  const relationDOIs = (relation, name) =>
    (Array.isArray(relation?.[name]) ? relation[name] : [])
      .map(row => bareDOI(row?.id || row?.DOI)).filter(Boolean);

  const PREPRINT_PREFIXES = /^10\.(1101|48550|21203|26434|20944|31234|31235|31219|55458|64898)\//;

  function readCrossref(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    // Crossref wraps the work in `message`; a caller that unwrapped it already
    // is accepted, but a `message` that is not an object is a broken envelope.
    const message = 'message' in payload ? payload.message : payload;
    if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
    const doi = bareDOI(message.DOI || message.doi);
    const title = text(Array.isArray(message.title) ? message.title[0] : message.title);
    const relation = message.relation && typeof message.relation === 'object' ? message.relation : {};
    const type = text(message.type);
    return {
      doi, title, type, subtype: text(message.subtype),
      // A record with neither a DOI nor a title is not a Crossref work.
      valid: !!(doi || title),
      updates: shapeUpdates(message['updated-by']),
      // Present only when this record is itself the notice.
      noticeFor: shapeUpdates(message['update-to']),
      updatePolicy: text(message['update-policy']),
      retractedBy: relationDOIs(relation, 'is-retracted-by'),
      preprintOf: relationDOIs(relation, 'is-preprint-of'),
      hasPreprint: relationDOIs(relation, 'has-preprint'),
      isPreprint: type === 'posted-content' || text(message.subtype) === 'preprint' || PREPRINT_PREFIXES.test(doi)
    };
  }

  const OA_RANK = {diamond: 5, gold: 4, hybrid: 3, green: 2, bronze: 1, closed: 0};
  const OA_TONE = {diamond: 'green', gold: 'gold', hybrid: 'teal', green: 'green', bronze: 'orange', closed: 'gray'};

  function shapeLocation(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw.source && typeof raw.source === 'object' ? raw.source : {};
    return {
      version: text(raw.version), isOA: raw.is_oa === true,
      venue: text(source.display_name), kind: text(source.type),
      landing: text(raw.landing_page_url), pdf: text(raw.pdf_url)
    };
  }

  function readOpenAlex(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const raw = Array.isArray(payload.results) ? payload.results[0] : payload;
    if (!raw || typeof raw !== 'object' || !text(raw.id)) return null;
    const access = raw.open_access && typeof raw.open_access === 'object' ? raw.open_access : {};
    const status = text(access.oa_status).toLowerCase();
    const locations = (Array.isArray(raw.locations) ? raw.locations : []).map(shapeLocation).filter(Boolean);
    const primary = shapeLocation(raw.primary_location);
    const best = shapeLocation(raw.best_oa_location);
    return {
      id: text(raw.id).replace(/^https?:\/\/openalex\.org\//i, '').toUpperCase(),
      doi: bareDOI(raw.doi), title: text(raw.title || raw.display_name),
      type: text(raw.type), year: Number.isInteger(raw.publication_year) ? raw.publication_year : null,
      isRetracted: raw.is_retracted === true,
      openAccess: {
        isOA: access.is_oa === true,
        // OpenAlex sometimes omits oa_status; "closed" is the safe reading of
        // is_oa false, and an unnamed status must not be shown as a colour.
        status: OA_RANK[status] === undefined ? (access.is_oa === true ? '' : 'closed') : status,
        url: text(access.oa_url) || best?.pdf || best?.landing || ''
      },
      primary, locations,
      // A work whose own primary home is a repository has not been published.
      isPreprint: text(raw.type) === 'preprint'
        || (primary?.kind === 'repository' && !locations.some(l => l.kind === 'journal'))
    };
  }

  // The published version of a preprint, but only when the candidate work
  // actually carries this preprint's DOI among its locations. A title search
  // alone matches review articles and conference abstracts of the same name,
  // and offering the wrong paper as "the published version" is worse than
  // offering nothing.
  function publishedVersionOf(work, record) {
    const want = bareDOI(record?.DOI || record?.doi);
    if (!work || !want) return null;
    const journal = work.locations.find(l => l.kind === 'journal' && l.version === 'publishedVersion')
      || (work.primary?.kind === 'journal' ? work.primary : null);
    if (!journal) return null;
    const published = bareDOI(work.doi);
    if (!published || published === want) return null;
    const carriesPreprint = work.locations.some(l => bareDOI(l.landing) === want || bareDOI(l.pdf) === want);
    if (!carriesPreprint) return null;
    return {doi: published, venue: journal.venue, year: work.year,
      url: journal.landing || 'https://doi.org/' + published};
  }

  // What the column is for. Crossref's notices decide the status; OpenAlex's
  // is_retracted is only a fallback, because it says nothing about which kind
  // of notice was issued.
  function classify({crossref, openAlex} = {}) {
    const updates = crossref?.updates || [];
    let rank = updates.reduce((worst, row) => Math.max(worst, row.rank), 0);
    const notices = [...updates];
    for (const doi of crossref?.retractedBy || []) {
      if (notices.some(row => row.doi === doi)) continue;
      notices.push({doi, type: 'retraction', label: 'Retraction', date: '', rank: 3});
      rank = 3;
    }
    // A retraction notice is a legitimate paper to hold, and OpenAlex marks the
    // notice itself is_retracted. This has to be settled before that fallback
    // is consulted, or the record that does the retracting is the one painted
    // red while nothing points at the paper it retracts.
    if (!rank && crossref?.noticeFor?.length) {
      return {status: 'notice', rank: 0,
        notices: crossref.noticeFor.map(row => ({...row, source: 'update-to'}))};
    }
    if (!rank && openAlex?.isRetracted) {
      rank = 3;
      notices.push({doi: '', type: 'retraction', label: 'Retraction', date: '', rank: 3, source: 'openalex'});
    }
    if (!crossref && !openAlex) return {status: 'unknown', rank: 0, notices: []};
    return {status: STATUS_BY_RANK[rank], rank, notices: notices.sort((a, b) => b.rank - a.rank)};
  }

  // One record, assembled from whichever of the two services answered.
  // `published` is what publishedVersionOf() made of the caller's second
  // lookup, when there was one.
  function summarise({crossref, openAlex, published, record, checkedAt} = {}) {
    const verdict = classify({crossref, openAlex});
    const preprint = !!(crossref?.isPreprint || openAlex?.isPreprint)
      || PREPRINT_PREFIXES.test(bareDOI(record?.DOI || record?.doi));
    const fromRelation = (crossref?.preprintOf || [])[0];
    return {
      checkedAt: text(checkedAt) || new Date().toISOString().slice(0, 10),
      doi: bareDOI(record?.DOI || record?.doi) || crossref?.doi || openAlex?.doi || '',
      status: verdict.status,
      rank: verdict.rank,
      notices: verdict.notices,
      openAccess: openAlex?.openAccess || null,
      preprint,
      // Crossref's own `is-preprint-of` is the cheapest answer when a
      // repository deposits it; the located published work is the fallback.
      published: preprint
        ? (published || (fromRelation ? {doi: fromRelation, venue: '', year: null,
            url: 'https://doi.org/' + fromRelation} : null))
        : null
    };
  }

  const oaRank = status => OA_RANK[text(status).toLowerCase()] ?? 0;

  // Zotero sorts a column by the string the data provider returns, so the sort
  // key has to be ordinal: worst news first, then a preprint with somewhere
  // better to go, then how freely the paper can be read. Fixed-width digits
  // keep the comparison numeric under a string sort.
  function sortKey(signals) {
    if (!signals) return '';
    return String(3 - Math.min(3, signals.rank || 0))
      + (signals.published ? '0' : '1')
      + String(5 - oaRank(signals.openAccess?.status));
  }

  const STATUS_LABEL = {retracted: 'RETRACTED', concern: 'CONCERN', corrected: 'CORRECTED', notice: 'NOTICE'};
  const STATUS_TONE = {retracted: 'red', concern: 'orange', corrected: 'blue', notice: 'gray'};
  const STATUS_TEXT = {
    retracted: '철회된 논문입니다. 인용하기 전에 철회 사유를 확인하세요.',
    concern: '우려 표명(expression of concern)이 게시된 논문입니다.',
    corrected: '정정·정오표가 게시된 논문입니다.',
    notice: '이 문헌은 다른 논문에 대한 정정·철회 공지입니다.'
  };

  // What the cell should show, as data. The caller turns these into elements so
  // the badge wording and the tooltips can be tested without a DOM.
  function badges(signals, {hasPDF = true} = {}) {
    if (!signals) return [];
    const list = [];
    if (STATUS_LABEL[signals.status]) {
      const detail = signals.notices.map(row =>
        [row.label || row.type, row.date, row.doi && ('doi:' + row.doi)].filter(Boolean).join(' · ')).join('\n');
      list.push({kind: 'status', text: STATUS_LABEL[signals.status], tone: STATUS_TONE[signals.status],
        // Only a retraction is loud enough to be worth shouting; everything
        // else stays in the tinted house style.
        solid: signals.status === 'retracted',
        title: STATUS_TEXT[signals.status] + (detail ? '\n' + detail : ''),
        url: signals.notices.find(row => row.doi) ? 'https://doi.org/' + signals.notices.find(row => row.doi).doi : ''});
    }
    if (signals.published) {
      list.push({kind: 'published', text: '게재됨 →', tone: 'purple',
        title: ['이 프리프린트는 이후 정식 게재되었습니다.',
          [signals.published.venue, signals.published.year].filter(Boolean).join(' · '),
          'doi:' + signals.published.doi].filter(Boolean).join('\n'),
        url: signals.published.url});
    } else if (signals.preprint) {
      list.push({kind: 'preprint', text: 'preprint', tone: 'gray',
        title: '프리프린트입니다. 정식 게재본은 찾지 못했습니다.', url: ''});
    }
    const access = signals.openAccess;
    if (access?.status) {
      const open = access.isOA && access.status !== 'closed';
      list.push({kind: 'oa', text: open ? 'OA ' + access.status : 'closed',
        tone: OA_TONE[access.status] || 'gray',
        title: open ? `공개 접근 (${access.status})` + (access.url ? '\n' + access.url : '')
          : '공개 접근본이 없습니다.',
        // The link is only worth offering when the library cannot already open
        // the paper; on a shelf that has the PDF it is noise.
        url: open && !hasPDF ? access.url : ''});
    }
    return list;
  }

  const api = {CROSSREF, OPENALEX, WORK_FIELDS, crossrefURL, openAlexURL, openAlexTitleURL,
    readCrossref, readOpenAlex, publishedVersionOf, classify, summarise, badges, sortKey,
    noticeRank, oaRank, bareDOI, PREPRINT_PREFIXES};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStylePaperSignals = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

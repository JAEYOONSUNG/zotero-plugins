/* Patents by a followed author, from the USPTO Open Data Portal.

   A patent filing is the earliest public sign of where a lab is heading,
   often a year before the paper. PatentsView, which used to answer this
   without a key, was retired into the USPTO's Open Data Portal in 2025; the
   portal answers the same question behind a free key (a MyUSPTO account,
   data.uspto.gov). Without a key nothing here runs and nothing is claimed.

   The portal is an AWS API Gateway: `X-Api-Key` in the header, a Lucene-style
   `q` over the application's metadata, JSON back. The reader below accepts
   the field names the portal documents and the ones PatentsView used, so a
   rename on their side degrades to "no patents found" rather than an error. */
(function (root) {
  'use strict';
  const API = 'https://api.uspto.gov/api/v1/patent/applications/search';
  const text = value => (value == null ? '' : String(value)).trim();

  // "Jennifer A. Doudna" -> {first: "Jennifer", last: "Doudna", initial: "J"}.
  function splitName(name) {
    const parts = text(name).replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    if (parts.length === 1) return {first: '', last: parts[0], initial: ''};
    const last = parts[parts.length - 1];
    const first = parts.find(p => p.length > 1 && p !== last) || parts[0];
    return {first, last, initial: first[0].toUpperCase()};
  }

  function searchURL(name, {limit = 25} = {}) {
    const who = splitName(name);
    if (!who) return null;
    const quote = value => '"' + value.replace(/["\\]/g, ' ').trim() + '"';
    // Both names on the inventor, newest grant first. The date is not
    // filtered here: a filing without a grant has none yet, and it is
    // exactly the one worth seeing.
    const q = 'applicationMetaData.inventorBag.inventorNameText:(' + quote(who.last) + (who.first ? ' AND ' + quote(who.first) : '') + ')';
    return `${API}?q=${encodeURIComponent(q)}&limit=${Math.max(1, Math.min(100, limit))}&offset=0`
      + `&sort=${encodeURIComponent('applicationMetaData.grantDate desc')}`;
  }

  const headers = key => (key ? {'X-Api-Key': key, Accept: 'application/json'} : {Accept: 'application/json'});

  const nameOf = person => text(person?.inventorNameText || person?.applicantNameText || person?.assignee_organization
    || [person?.firstName || person?.inventor_name_first, person?.lastName || person?.inventor_name_last].map(text).filter(Boolean).join(' '));

  function readPatents(payload) {
    const rows = [payload?.patentFileWrapperDataBag, payload?.results, payload?.patents, payload?.data]
      .find(Array.isArray) || [];
    return rows.map(raw => {
      const meta = raw?.applicationMetaData || raw || {};
      const number = text(meta.patentNumber || raw?.patentNumber || raw?.patent_id || raw?.patent_number).replace(/^US/i, '');
      const application = text(raw?.applicationNumberText || meta.applicationNumberText || raw?.application_number);
      const title = text(meta.inventionTitle || raw?.patent_title || raw?.title);
      if (!title && !number && !application) return null;
      const granted = text(meta.grantDate || raw?.patent_date || raw?.grant_date).slice(0, 10);
      const filed = text(meta.filingDate || raw?.filing_date).slice(0, 10);
      const inventors = (Array.isArray(meta.inventorBag) ? meta.inventorBag : Array.isArray(raw?.inventors) ? raw.inventors : []).map(nameOf).filter(Boolean);
      const applicants = (Array.isArray(meta.applicantBag) ? meta.applicantBag : Array.isArray(raw?.assignees) ? raw.assignees : []).map(nameOf).filter(Boolean);
      const status = text(meta.applicationStatusDescriptionText || raw?.status);
      return {
        id: number ? 'US' + number : application ? 'APP' + application : title,
        number, application, title: title || '(제목 없음)', granted, filed, inventors, applicants, status,
        // The public page: Google Patents for a granted patent, the USPTO's
        // Patent Center for an application still pending.
        link: number ? 'https://patents.google.com/patent/US' + number : application ? 'https://patentcenter.uspto.gov/applications/' + application : ''
      };
    }).filter(Boolean);
  }

  // A search on two names still returns namesakes: "DOUDNA CATE; JAMES H."
  // for Jennifer A. Doudna. The portal writes an inventor as "LAST; FIRST",
  // so the last name is looked for in the part before the semicolon and the
  // first name compared in full when both sides have one, by initial when
  // one side has only that.
  function matchesInventor(patent, name) {
    const who = splitName(name);
    if (!who) return false;
    const last = who.last.toLowerCase();
    const first = who.first.toLowerCase();
    return (patent.inventors || []).some(inventor => {
      const clean = inventor.toLowerCase().replace(/[.,]/g, ' ');
      let lastPart, firstPart;
      if (clean.includes(';')) [lastPart, firstPart] = clean.split(';', 2);
      else { const words = clean.split(/\s+/).filter(Boolean); lastPart = words[words.length - 1] || ''; firstPart = words.slice(0, -1).join(' '); }
      if (!lastPart.split(/\s+/).filter(Boolean).includes(last)) return false;
      const theirs = firstPart.split(/\s+/).filter(Boolean)[0] || '';
      if (!first || !theirs) return true;
      if (first.length > 1 && theirs.length > 1) return first === theirs;
      return first[0] === theirs[0];
    });
  }

  const api = {API, searchURL, headers, readPatents, matchesInventor, splitName};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStylePatents = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

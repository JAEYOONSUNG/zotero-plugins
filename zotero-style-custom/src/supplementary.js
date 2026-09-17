/* Locating a paper's supplementary files. Pure: URL building, result picking
   and archive-entry triage. The caller performs every request and file write. */
(function (root) {
  'use strict';

  const REST = 'https://www.ebi.ac.uk/europepmc/webservices/rest/';
  const text = value => String(value == null ? '' : value).trim();
  const bareDOI = value => text(value).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');

  // Europe PMC is queried by the strongest identifier the item has; a title
  // search is a last resort because it can match a different paper.
  function searchURL(record, {email} = {}) {
    const doi = bareDOI(record?.DOI || record?.doi);
    const pmid = text(record?.pmid || record?.PMID);
    const title = text(record?.title);
    let query;
    if (doi) query = `DOI:"${doi}"`;
    else if (pmid) query = `EXT_ID:${pmid} AND SRC:MED`;
    else if (title) query = `TITLE:"${title.replace(/"/g, '')}"`;
    else return null;
    return REST + 'search?query=' + encodeURIComponent(query)
      + '&resultType=core&format=json&pageSize=5'
      + (email ? '&email=' + encodeURIComponent(email) : '');
  }

  // Only an article Europe PMC says has supplementary material, and only when
  // the identifier we searched by actually matches, is worth downloading.
  function pickArticle(payload, record) {
    const results = payload?.resultList?.result;
    if (!Array.isArray(results)) return null;
    const wantDOI = bareDOI(record?.DOI || record?.doi).toLowerCase();
    const wantPMID = text(record?.pmid || record?.PMID);
    let fallback = null;
    for (const row of results) {
      if (wantDOI && bareDOI(row?.doi).toLowerCase() !== wantDOI) continue;
      if (!wantDOI && wantPMID && text(row?.pmid) !== wantPMID) continue;
      const id = text(row?.pmcid) || text(row?.id);
      const source = text(row?.pmcid) ? 'PMC' : text(row?.source);
      if (!id || !source) continue;
      if (source !== 'PMC') { fallback = fallback || {id, source, doi: bareDOI(row?.doi), hasSupplementary: false, openAccess: false}; continue; }
      return {
        id, source,
        doi: bareDOI(row?.doi),
        hasSupplementary: text(row?.hasSuppl).toUpperCase() === 'Y',
        openAccess: text(row?.isOpenAccess).toUpperCase() === 'Y'
      };
    }
    // A match that is not in PMC is still worth returning: the caller can say
    // "indexed but not archived" rather than "not found".
    return fallback;
  }

  // The endpoint takes the PMCID alone, with no source segment: a /PMC/<id>/
  // path answers 404. Only PMC-archived articles have retrievable files.
  const supplementaryURL = article =>
    /^PMC\d+$/i.test(text(article?.id)) ? `${REST}${text(article.id).toUpperCase()}/supplementaryFiles` : null;

  const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)|(^|\/)\._/i;

  // Europe PMC packs the article's own figures and inline equations into the
  // same archive as the supplementary files. These are the body, not extras.
  const BODY = new RegExp([
    /_Fig\d+_HTML/, /_Article_IEq\d+/, /_Equ\d+/, /_Tab\d+_HTML/, /_Sch\d+/,   // Nature, BMC
    /\.g\d{3}\./, /\.e\d{3}\./, /\.t\d{3}\./,                                   // PLOS
    /^(nihms\d+|main|article|body)\.(html|xml|nxml)$/,
    /\.nxml$/,                                                                  // the article body itself
    /^(gr|fx)\d+\./                                                             // Elsevier inline graphics
  ].map(r => r.source).join('|'), 'i');

  // One definition of "supplementary", shared with the column that badges an
  // item, so a file the badge counts is a file the downloader keeps.
  // A spelled-out word is safe anywhere; a terse token like SI or ESM is only
  // evidence between filename separators, or a title truncated mid-word
  // ("...recognition si.pdf") would look supplementary.
  const SPELLED = /supplement\w*|supporting[\s._-]*informations?|extended[\s._-]*data|data[\s._-]?sheet|보충자료|부록/i;
  // Frontiers names its supplementary files by kind and number, with no marker
  // word: Table_2.XLSX beside the article's own fmicb-07-00723-g001.jpg.
  const NUMBERED_KIND = /^(data[_ -]?sheet|table|image|presentation|video|audio)[_ -]?\d+\.[a-z0-9]{1,5}$/i;
  const TOKEN = /(^|[._-])(s\.?i|esm|suppl?e?m?|mmc\d+|media[._-]?\d+|data[._-]?s\d+)([._-]|\.[a-z0-9]{2,4}$|$)/i;
  // A bare "s1"/"s001" only numbers a supplementary file when it sits right
  // before the extension. Elsevier's main-article downloads are named
  // 1-s2.0-S0022283683715615-main.pdf, where the s2 is part of their id scheme.
  const TRAILING_NUMBER = /(^|[._-])s\d{1,3}\.[a-z0-9]{2,5}$/i;
  // Elsevier says outright which file is the article body.
  const MAIN_ARTICLE = /[._-]main\.[a-z0-9]{2,5}$/i;
  const looksSupplementary = name => {
    const value = text(name);
    if (!value || MAIN_ARTICLE.test(value)) return false;
    return SPELLED.test(value) || NUMBERED_KIND.test(value) || TOKEN.test(value) || TRAILING_NUMBER.test(value);
  };

  const EXTENSION = /\.([a-z0-9]{1,5})$/i;

  function classifyEntries(names, {pdfOnly = false} = {}) {
    const seen = new Set();
    const kept = [];
    for (const raw of Array.isArray(names) ? names : []) {
      const name = text(raw);
      if (!name || name.endsWith('/') || JUNK.test(name)) continue;
      const base = name.slice(name.lastIndexOf('/') + 1);
      // A parent directory named "supplementary" is evidence too, but only the
      // spelled-out form: a terse token is judged on the file name alone.
      const folder = name.slice(0, name.lastIndexOf('/') + 1);
      if (!base || BODY.test(base)) continue;
      if (!looksSupplementary(base) && !SPELLED.test(folder)) continue;
      const extension = (EXTENSION.exec(base) || [, ''])[1].toLowerCase();
      if (pdfOnly && extension !== 'pdf') continue;
      const key = base.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push({entry: name, name: base, extension});
    }
    return kept;
  }

  // Zotero shows attachment titles in a flat list, so the label has to say both
  // that the file is supplementary and which one it is.
  const attachmentTitle = file => 'Supplementary: ' + text(file?.name || file);

  // The service answers 200 with an XML <errorBean> when an article is not open
  // access, so the body has to be checked before it is treated as an archive.
  function readArchiveError(bytes) {
    if (!bytes || bytes.length < 4) return 'Empty response';
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5)) return null;
    let head = '';
    for (let i = 0; i < Math.min(bytes.length, 2048); i++) head += String.fromCharCode(bytes[i]);
    const message = /<errMsg>([^<]*)<\/errMsg>/i.exec(head);
    return message ? text(message[1]) : 'Not a zip archive';
  }

  const api = {REST, searchURL, pickArticle, supplementaryURL, classifyEntries, attachmentTitle, bareDOI, looksSupplementary, readArchiveError};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleSupplementary = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

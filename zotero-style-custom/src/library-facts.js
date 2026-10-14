/* What the phone cannot work out for itself.

   The phone reads the library through Zotero's own API, which knows the title, the authors and the
   journal — and nothing about how the journal is regarded, how often the paper has been cited, or
   where the work was done. This plugin has all three already: it keeps an impact factor and a
   citation count per paper, and OpenAlex's authorship for each work, with the institution and
   country of every author. None of it is in Zotero, so none of it reaches the phone.

   This turns that into one small file. 1,200 papers come to about 130 KB — small enough to fetch in
   one go over a phone's signal, and small enough to keep. It carries no title and no abstract: the
   phone has those from Zotero, and a file in a sync folder should hold as little as it can.

   It also carries what the panel *shows* rather than knows: the signature ink the library cards
   paint a journal's name in, and how far through each paper the reader got. Both are facts about
   the library the phone has no other way to learn.

   Nothing here touches the disk or the network; runtime.js writes what this returns. */

(function (root) {
  'use strict';

const LIBRARY = /^\d+:/;                       // "1:TNSVR92P" -> the phone knows it as TNSVR92P
const key = id => String(id || '').replace(LIBRARY, '');
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const round = (value, places = 2) => (value === null ? null : Number(value.toFixed(places)));

/* The countries a paper was written in, most-represented first, and never more than a handful: a row
   on a phone has room for two or three flags. The corresponding author's country is kept apart,
   because that is the one that says whose paper it is. */
function countriesOf(people) {
  const list = Array.isArray(people) ? people : [];
  const count = new Map();
  let lead = '';
  for (const person of list) {
    const country = String(person && person.country || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) continue;
    count.set(country, (count.get(country) || 0) + 1);
    if (person.corresponding && !lead) lead = country;
  }
  const order = [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code]) => code);
  // The corresponding author's country goes first whether or not it is the most common one.
  if (lead) order.sort((a, b) => (a === lead ? -1 : b === lead ? 1 : 0));
  return {countries: order.slice(0, 4), lead};
}

/* The colours a paper can be marked with by hand: the plugin's own seven, named here rather than
   only in its stylesheets, because the phone draws the same seven. */
const MARKS = ['red', 'orange', 'gold', 'green', 'teal', 'blue', 'purple'];

/* How much of a paper has been read.

   Two records on this Mac say it and neither says it alone. The plugin's own clock knows which
   pages were dwelt on, but only for the papers it watched being read. Zotero keeps the page every
   PDF was last left on, for every paper ever opened in its reader, and its full-text index kept
   the page count. So `places` carries one {page, pages, file} for each record of where the paper
   was left, and `visited` of `total` the pages dwelt on.

   Two records of the same file are one place: either may be the one that knows the page count, and
   a paper left on page 12 of a file the index never counted is still twelve pages in. Then the
   furthest place is the answer -- by share wherever a page count is known, by page where none is.
   A page past the end of its file is a stale record, not a finished paper. */
function readingOf({places = [], visited = 0, total = 0, seconds = 0, at = ''} = {}) {
  const files = new Map();
  for (const place of Array.isArray(places) ? places : []) {
    const page = Math.trunc(num(place && place.page) || 0);
    const pages = Math.trunc(num(place && place.pages) || 0);
    if (page <= 0 && pages <= 0) continue;
    // A record with no file named is its own place; it cannot be merged with one it may not be.
    const file = place && place.file ? 'file:' + place.file : 'place:' + files.size;
    const found = files.get(file) || {pages: 0, seen: []};
    if (pages > found.pages) found.pages = pages;
    if (page > 0) found.seen.push(page);
    files.set(file, found);
  }
  let best = null;
  for (const {pages, seen} of files.values()) {
    const reached = Math.max(0, ...seen.filter(page => !pages || page <= pages));
    if (reached <= 0) continue;
    const share = pages > 0 ? reached / pages : 0;
    if (!best || share > best.share || (share === best.share && reached > best.page)) best = {page: reached, pages, share};
  }
  const pagesRead = Math.max(0, Math.trunc(num(visited) || 0));
  const pageCount = Math.max(0, Math.trunc(num(total) || 0));
  const dwelt = pageCount > 0 ? Math.min(1, pagesRead / pageCount) : 0;
  const share = Math.max(best ? best.share : 0, dwelt);
  const out = {};
  // A paper opened once is not a paper unread, so a share this small is still shown as 1%.
  if (share > 0) out.read = Math.min(100, Math.max(1, Math.round(share * 100)));
  if (best) out.page = best.page;
  const span = best && best.pages ? best.pages : pageCount;
  if (span > 0) out.pages = span;
  const time = Math.round(num(seconds) || 0);
  if (time > 0) out.seconds = time;
  const day = String(at || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) out.at = day;
  return Object.keys(out).length ? out : null;
}

/* One paper's facts, or null when there is nothing worth sending. */
function factsFor({item = {}, work = {}, reading = null} = {}) {
  const metrics = item.metrics || {};
  const {countries, lead} = countriesOf(work.people);
  const out = {};
  const jif = num(metrics.impactFactor);
  if (jif !== null) out.jif = round(jif);
  const cited = num(metrics.citations) ?? num(work.citations);
  if (cited !== null) out.cited = cited;
  if (work.venue) out.venue = String(work.venue);
  const year = num(work.year);
  if (year !== null) out.year = year;
  if (countries.length) out.from = countries;
  if (lead) out.lead = lead;
  if (num(item.seconds)) out.seconds = Math.round(item.seconds);
  // How far through it the reader got, and the colour it was marked with by hand.
  const read = reading && typeof reading === 'object' ? reading : null;
  if (read) {
    const share = num(read.read);
    if (share !== null) out.read = Math.min(100, Math.max(0, Math.round(share)));
    for (const field of ['page', 'pages', 'seconds']) {
      const value = num(read[field]);
      if (value !== null && value > 0) out[field] = Math.round(value);
    }
    const day = String(read.at || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) out.at = day;
  }
  if (MARKS.includes(item.highlight)) out.mark = item.highlight;
  return Object.keys(out).length ? out : null;
}

/* The whole library, as the file the phone reads. `journals` carries what is true of the journal
   rather than of the paper, so a hundred papers in Nature say "Nature" once. */
function libraryFacts({items = {}, works = {}, journalMetrics = {}, reading = {}} = {},
                      {made = new Date().toISOString(), inkOf = null} = {}) {
  const papers = {};
  const ids = new Set([...Object.keys(items), ...Object.keys(works)]);
  const read = reading && typeof reading === 'object' ? reading : {};
  for (const id of ids) {
    const facts = factsFor({item: items[id] || {}, work: works[id] || {}, reading: read[id] || null});
    if (facts) papers[key(id)] = facts;
  }
  const journals = {};
  for (const record of Object.values(journalMetrics)) {
    const name = record && record.name;
    if (!name || journals[name]) continue;
    const one = {};
    if (record.country) one.country = String(record.country).toUpperCase();
    if (num(record.hIndex) !== null) one.h = record.hIndex;
    if (num(record.citedness) !== null) one.perPaper = round(record.citedness, 1);
    if (record.isOA) one.oa = true;
    if (record.publisher) one.publisher = String(record.publisher);
    if (Object.keys(one).length) journals[name] = one;
  }
  /* The ink the panel paints this journal's name in, both themes', so the phone can paint it the
     same. A journal the registry never heard of is drawn grey on the Mac, and a grey that means
     nothing is not worth sending, so `inkOf` answers for those with nothing. */
  if (typeof inkOf === 'function') {
    const named = new Set(Object.keys(journals));
    for (const paper of Object.values(papers)) if (paper.venue) named.add(paper.venue);
    for (const name of named) {
      let ink = null;
      try { ink = inkOf(name); } catch (_) { ink = null; }
      if (!ink || !ink.ink || !ink.inkDark) continue;
      const one = journals[name] || (journals[name] = {});
      one.ink = String(ink.ink);
      one.inkDark = String(ink.inkDark);
    }
  }
  return {v: 2, made, papers, journals};
}

/* How a paper is marked out at a glance. The bands are the ones a reader already thinks in: a JIF
   of 10 and a JIF of 40 are not the same news, and neither is 0.9. Nothing here is a judgement of
   the paper — it is the journal's figure, and it is shown as such. */
const BANDS = [[30, 'top'], [10, 'high'], [5, 'mid'], [0, 'low']];
function bandOf(jif) {
  const n = Number(jif);
  if (!Number.isFinite(n) || n <= 0) return '';
  for (const [floor, name] of BANDS) if (n >= floor) return name;
  return 'low';
}

  const api = {libraryFacts, factsFor, countriesOf, readingOf, bandOf, BANDS, MARKS};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleLibraryFacts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

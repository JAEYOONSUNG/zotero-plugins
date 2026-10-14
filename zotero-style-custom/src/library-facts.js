/* What the phone cannot work out for itself.

   The phone reads the library through Zotero's own API, which knows the title, the authors and the
   journal — and nothing about how the journal is regarded, how often the paper has been cited, or
   where the work was done. This plugin has all three already: it keeps an impact factor and a
   citation count per paper, and OpenAlex's authorship for each work, with the institution and
   country of every author. None of it is in Zotero, so none of it reaches the phone.

   This turns that into one small file. 1,200 papers come to about 130 KB — small enough to fetch in
   one go over a phone's signal, and small enough to keep. It carries no title and no abstract: the
   phone has those from Zotero, and a file in a sync folder should hold as little as it can.

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

/* One paper's facts, or null when there is nothing worth sending. */
function factsFor({item = {}, work = {}} = {}) {
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
  return Object.keys(out).length ? out : null;
}

/* The whole library, as the file the phone reads. `journals` carries what is true of the journal
   rather than of the paper, so a hundred papers in Nature say "Nature" once. */
function libraryFacts({items = {}, works = {}, journalMetrics = {}} = {}, {made = new Date().toISOString()} = {}) {
  const papers = {};
  const ids = new Set([...Object.keys(items), ...Object.keys(works)]);
  for (const id of ids) {
    const facts = factsFor({item: items[id] || {}, work: works[id] || {}});
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
  return {v: 1, made, papers, journals};
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

  const api = {libraryFacts, factsFor, countriesOf, bandOf, BANDS};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleLibraryFacts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

#!/usr/bin/env node
/* Build data/journal-catalog.json: an openly licensed journal catalogue.
 *
 * WHY THIS EXISTS
 * ---------------
 * data/jcr-categories.json is captured from Clarivate's Journal Citation
 * Reports. It cannot be redistributed. This script builds a drop-in
 * replacement from OpenAlex, which publishes everything it holds under CC0,
 * so the plugin can ship a journal catalogue without licensing anyone's
 * proprietary data.
 *
 * WHAT THE FIGURE IS, AND IS NOT
 * ------------------------------
 * OpenAlex publishes summary_stats.2yr_mean_citedness: the mean number of
 * citations, counted over OpenAlex's open citation graph, that a source's
 * last two complete years of works received. It is close in spirit to the
 * Journal Impact Factor and is NOT one. It is computed over a different
 * citation corpus, a different document set and a different window, and it is
 * not audited. Nothing this script writes is called JIF or Impact Factor.
 * The figure travels as `citedness`, its within-category standing as
 * `citednessRanks` and `citednessQuartiles`, and source.metric.isEstimate is
 * true, matching how src/runtime.js already labels this same number ("2년 평균
 * 피인용", drawn with a leading ~ and never presented as an official JIF).
 *
 * THE TAXONOMY
 * ------------
 *   groups     <- OpenAlex fields     (26)
 *   categories <- OpenAlex subfields  (252)
 *   journals   <- OpenAlex sources filtered to type:journal with a
 *                 2yr_mean_citedness above zero
 *
 * A source is put in a category from its `topic_share`: OpenAlex's measure of
 * how concentrated the source is in each topic, relative to that topic's size.
 * Every topic belongs to exactly one subfield, so the shares are summed per
 * subfield and the leading subfields are kept: see SUBFIELD_SHARE and
 * MAX_CATEGORIES below. The raw `topics` counts were tried first and are far
 * worse, because OpenAlex's catch-all topics swamp a general journal: by raw
 * counts The Lancet lands in Economics and Econometrics, and the New England
 * Journal of Medicine in Aerospace Engineering.
 *
 * THE API KEY
 * -----------
 * OpenAlex is metered. The key is read straight out of the Zotero profile's
 * prefs.js at run time. It is never printed, never logged and never written to
 * any file, and it is sent only as the api_key query parameter to
 * api.openalex.org. Requests go out one at a time; an HTTP 429 stops the run.
 *
 * THREE FILES, ONE SWEEP
 * ----------------------
 * The same fetched rows produce everything the plugin needs, so the API is
 * paged once:
 *   data/journal-catalog.json      the groups/categories/journals catalogue,
 *                                  loaded by src/jcr-categories.js
 *   data/if-openalex.json          one impact record per journal, in the shape
 *                                  src/journals.js validates; scripts/build.py
 *                                  globs data/if-*.json and packs the result
 *   data/journal-registry.open.json the journal registry, in the shape
 *                                  loadRegistry() in src/journal-identity.js
 *                                  reads, packed as data/journal-registry.json
 *
 * Two consumer contracts predate this catalogue and name their metric field
 * `impactFactor`: Journals.valid() requires it, and the registry's readers in
 * src/journal-identity.js, src/workbench.js and src/selfcheck.js all read it.
 * Renaming it would break them, so the field keeps its name and every record
 * carries metric:"openalex-2yr-mean-citedness" beside it, which is how the
 * display layer tells an estimate from a real JIF.
 *
 * USAGE
 * -----
 *   node scripts/build-open-catalog.mjs [options]
 *     --out <path>      where to write the catalogue
 *                       (default: data/journal-catalog.json)
 *     --if-out <path>   where to write the impact records
 *                       (default: data/if-openalex.json)
 *     --registry-out <path>  where to write the registry
 *                       (default: data/journal-registry.open.json)
 *     --cache <path>    NDJSON scratch file of trimmed rows, so an
 *                       interrupted run resumes instead of re-paying for
 *                       pages it already fetched
 *     --no-resume       ignore an existing cache and start over
 *     --limit <n>       stop after n journal pages (for a smoke run)
 *     --pretty          indent the JSON (much larger; default is compact)
 */

import {readFileSync, readdirSync, writeFileSync, appendFileSync, existsSync, statSync, rmSync, mkdirSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
// The record contracts the two smaller files have to satisfy. Imported rather
// than restated, so a change to either module fails the build instead of
// shipping rows the plugin will reject at load.
import Journals from '../src/journals.js';
import Identity from '../src/journal-identity.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.openalex.org';
const ENDPOINTS = {
  sources: API + '/sources',
  subfields: API + '/subfields',
  fields: API + '/fields',
  domains: API + '/domains'
};
// type:journal drops repositories, conference series, book series and
// preprint servers. The citedness floor drops sources OpenAlex indexes but has
// no two-year figure for, which is exactly the figure this catalogue carries.
const JOURNAL_FILTER = 'type:journal,summary_stats.2yr_mean_citedness:>0';
const SELECT = ['id', 'display_name', 'issn_l', 'issn', 'works_count', 'cited_by_count', 'summary_stats', 'topic_share'].join(',');
const PAGE_SIZE = 200;
// A second subfield joins the first when it carries at least this share of the
// leading subfield's works. Co-equal subjects get in; the long tail does not.
const SUBFIELD_SHARE = 0.5;
const MAX_CATEGORIES = 3;
const USER_AGENT = 'zotero-style-custom/build-open-catalog';

/* ---------------------------------------------------------------- options */

function options(argv) {
  const result = {out: path.join(ROOT, 'data/journal-catalog.json'),
    ifOut: path.join(ROOT, 'data/if-openalex.json'),
    registryOut: path.join(ROOT, 'data/journal-registry.open.json'),
    cache: path.join(tmpdir(), 'zotero-style-custom-open-catalog.ndjson'),
    resume: true, limit: Infinity, pretty: false};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--out') result.out = path.resolve(argv[++i]);
    else if (flag === '--if-out') result.ifOut = path.resolve(argv[++i]);
    else if (flag === '--registry-out') result.registryOut = path.resolve(argv[++i]);
    else if (flag === '--cache') result.cache = path.resolve(argv[++i]);
    else if (flag === '--no-resume') result.resume = false;
    else if (flag === '--limit') result.limit = Number(argv[++i]);
    else if (flag === '--pretty') result.pretty = true;
    else throw new Error('unknown option: ' + flag);
  }
  return result;
}

/* ------------------------------------------------------------------- http */

/* The key lives in the Zotero profile, not in this repository and not in the
   environment. It is returned, used and dropped; nothing here prints it. */
function apiKey() {
  const base = path.join(homedir(), 'Library/Application Support/Zotero/Profiles');
  let profiles = [];
  try { profiles = readdirSync(base); } catch (_) { return ''; }
  for (const profile of profiles) {
    let text = '';
    try { text = readFileSync(path.join(base, profile, 'prefs.js'), 'utf8'); } catch (_) { continue; }
    const found = /openAlexApiKey",\s*"([^"]*)"/.exec(text);
    if (found && found[1]) return found[1];
  }
  return '';
}

const KEY = apiKey();
let requests = 0;

/* One request at a time. A 429 is fatal: the budget is shared with the user's
   own Zotero session and this script must not eat into it by retrying. */
async function get(endpoint, params) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (KEY) url.searchParams.set('api_key', KEY);
  requests++;
  const response = await fetch(url, {headers: {'User-Agent': USER_AGENT}});
  if (response.status === 429) {
    throw new Error('OpenAlex returned HTTP 429 (rate limited or out of budget) after ' + requests
      + ' requests. Nothing was overwritten; re-run later and the cache resumes.');
  }
  if (!response.ok) {
    // The URL carries the key, so report the endpoint path only.
    throw new Error('OpenAlex returned HTTP ' + response.status + ' for ' + new URL(endpoint).pathname);
  }
  return response.json();
}

async function fetchAll(endpoint, params = {}) {
  const rows = [];
  let cursor = '*';
  while (cursor) {
    const page = await get(endpoint, {...params, 'per-page': String(PAGE_SIZE), cursor});
    rows.push(...page.results);
    cursor = page.meta.next_cursor || null;
    if (!page.results.length) break;
  }
  return rows;
}

/* ------------------------------------------------------------- shaping */

const text = value => String(value == null ? '' : value).trim();
const openAlexId = value => text(value).replace(/^https?:\/\/openalex\.org\//i, '');
const ISSN = /^\d{4}-?\d{3}[\dX]$/;
const round = (value, places) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};
/* Two decimals is as much as a figure this rough can carry. A journal whose
   figure would round away to zero keeps two significant digits instead: every
   journal in this catalogue is here because its figure is above zero, and
   printing 0 for it would be a different claim. The cache keeps the full
   value, so this is applied once, on the way out. */
const metricValue = value => round(value, 2) || Number(Number(value).toPrecision(2));

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/* The trimmed row that goes in the cache: everything later steps need and
   nothing else, so an interrupted run resumes from a small file rather than
   from the half gigabyte of topic arrays the API sent. */
function trimSource(raw) {
  const citedness = Number(raw?.summary_stats?.['2yr_mean_citedness']);
  if (!Number.isFinite(citedness) || citedness <= 0) return null;
  const title = text(raw.display_name);
  if (!title) return null;
  const issns = [...new Set([raw.issn_l, ...(Array.isArray(raw.issn) ? raw.issn : [])]
    .map(value => text(value).toUpperCase()).filter(value => ISSN.test(value))
    .map(value => value.includes('-') ? value : value.slice(0, 4) + '-' + value.slice(4)))];
  /* topic_share, not topics. `topics` counts a source's works per topic, and
     for a general journal the count is dominated by OpenAlex's catch-all
     topics: raw counts put The Lancet in Economics and Econometrics and the
     New England Journal of Medicine in Aerospace Engineering. topic_share is
     OpenAlex's own figure for how concentrated a source is in a topic
     relative to that topic's size, and it answers what the journal is about:
     the same two land in General Health Professions.

     Summed by subfield id, never by name: seven subfield names occur twice in
     OpenAlex's taxonomy under two different fields, and summing by name would
     merge, say, clinical Genetics into molecular Genetics. */
  const bySubfield = new Map();
  for (const topic of Array.isArray(raw.topic_share) ? raw.topic_share : []) {
    const id = openAlexId(topic?.subfield?.id);
    const share = Number(topic?.value);
    if (!id || !Number.isFinite(share) || share <= 0) continue;
    bySubfield.set(id, (bySubfield.get(id) || 0) + share);
  }
  const ranked = [...bySubfield.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const leader = ranked.length ? ranked[0][1] : 0;
  const subfieldIds = ranked.filter(([, count]) => count >= leader * SUBFIELD_SHARE)
    .slice(0, MAX_CATEGORIES).map(([id]) => id);
  return {
    key: 'openalex:' + openAlexId(raw.id),
    title,
    issns,
    subfieldIds,
    citedness,
    worksCount: Number.isInteger(raw.works_count) ? raw.works_count : null,
    totalCitations: Number.isInteger(raw.cited_by_count) ? raw.cited_by_count : null,
    hIndex: Number.isInteger(raw?.summary_stats?.h_index) ? raw.summary_stats.h_index : null
  };
}

/* ------------------------------------------------------------ the journals */

/* Paged with a cursor, one page at a time, appending each page to the cache
   before asking for the next, so a run that dies at page 400 costs 400
   requests and not 448. */
async function journalRows({cache, resume, limit}) {
  let rows = [];
  let cursor = '*';
  if (resume && existsSync(cache) && statSync(cache).size) {
    const lines = readFileSync(cache, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.cursor !== undefined) { cursor = entry.cursor; continue; }
      rows.push(entry);
    }
    process.stderr.write('resuming from cache: ' + rows.length + ' journals already fetched\n');
    if (!cursor) return rows;
  } else {
    mkdirSync(path.dirname(cache), {recursive: true});
    if (existsSync(cache)) rmSync(cache);
    rows = [];
  }
  let pages = 0;
  while (cursor && pages < limit) {
    const page = await get(ENDPOINTS.sources, {filter: JOURNAL_FILTER, 'per-page': String(PAGE_SIZE), cursor, select: SELECT});
    const shaped = page.results.map(trimSource).filter(Boolean);
    rows.push(...shaped);
    cursor = page.meta.next_cursor || null;
    pages++;
    appendFileSync(cache, shaped.map(row => JSON.stringify(row)).join('\n')
      + (shaped.length ? '\n' : '') + JSON.stringify({cursor}) + '\n');
    if (pages % 10 === 0 || !cursor) {
      process.stderr.write('journals ' + rows.length + ' / ' + page.meta.count + ' (' + requests + ' requests)\n');
    }
    if (!page.results.length) break;
  }
  return rows;
}

/* ------------------------------------------------------------------- build */

async function build(config) {
  const started = new Date();
  const fields = await fetchAll(ENDPOINTS.fields);
  const subfields = await fetchAll(ENDPOINTS.subfields);
  const domains = await fetchAll(ENDPOINTS.domains);

  // Group and category keys must equal their exact names, so a repeated name
  // would silently merge two different subjects. Fail instead.
  const unique = (values, what) => {
    const seen = new Set();
    for (const value of values) {
      if (seen.has(value)) throw new Error('OpenAlex returned two ' + what + ' called "' + value + '"; the key=name schema cannot hold both');
      seen.add(value);
    }
  };
  unique(fields.map(field => text(field.display_name)), 'fields');

  /* Seven subfield names are used twice, under two different fields: Genetics,
     Archeology, Physiology, Pharmacology, Neurology, Microbiology and
     Biochemistry. The schema wants key === name, so both members of a
     colliding pair carry their parent field in brackets. Neither is
     privileged, and the bracketed name is still the reader's own words. */
  const nameCount = new Map();
  for (const subfield of subfields) {
    const name = text(subfield.display_name);
    nameCount.set(name, (nameCount.get(name) || 0) + 1);
  }
  const categoryNameById = new Map();
  for (const subfield of subfields) {
    const name = text(subfield.display_name);
    const parent = text(subfield.field?.display_name);
    categoryNameById.set(openAlexId(subfield.id), nameCount.get(name) > 1 ? name + ' (' + parent + ')' : name);
  }
  unique([...categoryNameById.values()], 'subfields, even after disambiguation,');

  const journalRowsAll = await journalRows(config);

  // Membership, counted once and used for every count in the file, so the
  // totals cannot drift from the lists they describe.
  const categoryOf = new Map(subfields.map(subfield => {
    const key = categoryNameById.get(openAlexId(subfield.id));
    return [key, {key, subfieldId: openAlexId(subfield.id), groupKey: text(subfield.field?.display_name),
      domain: text(subfield.domain?.display_name), journals: []}];
  }));
  let withoutCategory = 0;
  const journals = [];
  for (const row of journalRowsAll) {
    const keys = [...new Set(row.subfieldIds.map(id => categoryNameById.get(id)).filter(Boolean))];
    if (!keys.length) withoutCategory++;
    const journal = {...row, categoryKeys: keys};
    journals.push(journal);
    for (const key of keys) categoryOf.get(key).journals.push(journal);
  }

  // Standing within a category: rank on the citedness, ties broken by title so
  // a rebuild of the same data produces the same file. The quartile is the
  // rank's position in the category, nothing more, and is named for the
  // figure it ranks so it cannot be mistaken for a JIF quartile.
  for (const category of categoryOf.values()) {
    const ordered = category.journals.slice().sort((a, b) => b.citedness - a.citedness || a.title.localeCompare(b.title));
    const total = ordered.length;
    ordered.forEach((journal, index) => {
      const rank = index + 1;
      const position = journal.categoryKeys.indexOf(category.key);
      for (const field of ['citednessRanks', 'citednessQuartiles', 'citednessPercentiles']) {
        journal[field] = journal[field] || new Array(journal.categoryKeys.length).fill(null);
      }
      journal.citednessRanks[position] = rank;
      // Which quarter of the ordered category the rank falls in. Written this
      // way round so the best journal in a one-journal category is in the
      // first quarter rather than the last.
      journal.citednessQuartiles[position] = Math.min(4, Math.floor((rank - 1) * 4 / total) + 1);
      // How far up the category the journal sits, as a percentage. The half
      // step is the usual one: it puts a sole journal at the middle of its own
      // band rather than at 0 or at 100.
      journal.citednessPercentiles[position] = round((total - rank + 0.5) / total * 100, 1);
    });
    category.medianCitedness = median(ordered.map(journal => journal.citedness));
    category.total = total;
  }

  const categories = [...categoryOf.values()].map(category => ({
    key: category.key,
    name: category.key,
    openAlexId: category.subfieldId,
    groupKeys: [category.groupKey],
    editions: [],
    journalCount: category.total,
    // OpenAlex publishes no count of citable items: works_count is every
    // indexed work of every kind, over all time, not JCR's articles and
    // reviews inside the metric window. A wrong number is worse than none.
    citableItems: null,
    totalCitations: category.journals.reduce((sum, journal) => sum + (journal.totalCitations || 0), 0),
    medianCitedness: category.medianCitedness == null ? null : metricValue(category.medianCitedness),
    worksCount: category.journals.reduce((sum, journal) => sum + (journal.worksCount || 0), 0),
    domain: category.domain || null
  })).sort((a, b) => a.key.localeCompare(b.key));

  const byGroup = new Map(fields.map(field => [text(field.display_name), []]));
  for (const category of categories) byGroup.get(category.groupKeys[0])?.push(category);
  const groups = fields.map(field => {
    const name = text(field.display_name);
    const members = byGroup.get(name) || [];
    const journalKeys = new Set();
    for (const category of members) for (const journal of categoryOf.get(category.key).journals) journalKeys.add(journal.key);
    return {
      key: name,
      name,
      openAlexId: openAlexId(field.id),
      categoryCount: members.length,
      journalCount: journalKeys.size,
      citableItems: null,
      worksCount: members.reduce((sum, category) => sum + category.worksCount, 0),
      domain: text(field.domain?.display_name) || null,
      categoryKeys: members.map(category => category.key).sort((a, b) => a.localeCompare(b))
    };
  }).sort((a, b) => a.key.localeCompare(b.key));

  const payload = {
    schemaVersion: 1,
    source: {
      provider: 'OpenAlex',
      product: 'Sources',
      license: 'CC0-1.0',
      licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      url: ENDPOINTS.sources,
      endpoints: ENDPOINTS,
      capturedAt: started.toISOString(),
      datasetUpdated: null,
      releaseYear: null,
      metricYear: null,
      complete: {groups: true, categories: true, journals: true},
      metric: {
        field: 'citedness',
        name: 'Two-year mean citedness',
        openAlexField: 'summary_stats.2yr_mean_citedness',
        isEstimate: true,
        isJournalImpactFactor: false,
        note: 'Mean citations over OpenAlex open citation data for a source\'s last two complete years. '
          + 'Close in spirit to a Journal Impact Factor, computed from a different corpus and window, and not one.'
      },
      ranking: {
        fields: ['citednessRanks', 'citednessQuartiles', 'citednessPercentiles'],
        note: 'Position of a journal\'s citedness inside each of its categories, and that position expressed in '
          + 'quarters. Parallel to categoryKeys, index for index. Derived here, not published by OpenAlex.',
        quartileRule: 'min(4, floor((rank - 1) * 4 / journalCount) + 1), against the category\'s journalCount.',
        percentileRule: '((journalCount - rank + 0.5) / journalCount) * 100, to one decimal place.'
      },
      taxonomy: {domains: domains.length, fields: fields.length, subfields: subfields.length,
        note: 'groups are OpenAlex fields, categories are OpenAlex subfields, and a journal is placed by its topic_share.'},
      membership: {rule: 'subfields of the journal\'s topic_share, kept while a subfield carries at least '
        + Math.round(SUBFIELD_SHARE * 100) + '% of the leading subfield\'s share', maxCategories: MAX_CATEGORIES,
        disambiguation: 'Seven subfield names occur twice under different fields. Both members of each pair carry '
          + 'their parent field in brackets, because a category key must equal its displayed name.'},
      coverage: {
        filter: JOURNAL_FILTER,
        journalsCaptured: journals.length,
        journalsWithoutCategory: withoutCategory,
        journalsWithoutISSN: journals.filter(journal => !journal.issns.length).length,
        note: 'complete.journals reports that every count in this file agrees with the lists it describes, and that '
          + 'the filter above was paged to its end. It does not claim OpenAlex indexes every journal that exists.'
      },
      absent: {
        abbreviation: 'OpenAlex publishes no abbreviated journal title, so the field is omitted and the loader reads null.',
        citableItems: 'OpenAlex publishes no citable-item count; worksCount is every indexed work of every kind, all time.',
        editions: 'OpenAlex has no index editions; the array is empty.',
        metricYear: 'OpenAlex does not stamp 2yr_mean_citedness with the years it covers.',
        rankTotal: 'Derivable: a category\'s journalCount is the total its ranks are out of.'
      }
    },
    groups,
    categories: categories.map(({worksCount, ...rest}) => ({...rest, worksCount})),
    journals: journals.map(journal => ({
      key: journal.key,
      title: journal.title,
      issns: journal.issns,
      categoryKeys: journal.categoryKeys,
      citedness: metricValue(journal.citedness),
      citednessRanks: journal.citednessRanks || [],
      citednessQuartiles: journal.citednessQuartiles || [],
      citednessPercentiles: journal.citednessPercentiles || [],
      worksCount: journal.worksCount,
      totalCitations: journal.totalCitations,
      hIndex: journal.hIndex
    })).sort((a, b) => a.key.localeCompare(b.key))
  };

  return payload;
}

/* ------------------------------------------------- the two derived files */

/* The marker every derived record carries. Both files keep a field named
   impactFactor, because their readers require that name and predate this
   catalogue, so this is what tells a reader's real JIF from this estimate. */
const METRIC = 'openalex-2yr-mean-citedness';
const EVIDENCE = 'OpenAlex 2-year mean citedness (CC0); not the Journal Impact Factor.';

/* One impact record per journal, in the shape src/journals.js validates.
   Journals.valid() is the gate rather than a restatement of its rules, so a
   change there fails this build instead of shipping rows the plugin rejects. */
function impactRecords(payload) {
  const checkedAt = payload.source.capturedAt.slice(0, 10);
  const rows = [];
  const dropped = {aboveLimit: 0, rejected: 0};
  const examples = [];
  for (const journal of payload.journals) {
    // Journals.valid() refuses anything at or above 1000. A handful of
    // OpenAlex sources are above it; they are dropped, never clamped, because
    // a clamped figure would be a number nobody measured.
    if (!(journal.citedness < 1000)) { dropped.aboveLimit++; examples.push(journal.title); continue; }
    const record = {
      title: journal.title,
      aliases: [],
      issns: journal.issns.filter(code => Journals.issn(code)),
      impactFactor: journal.citedness,
      // OpenAlex does not stamp the figure with the years it covers, and
      // valid() takes null for exactly this case.
      year: null,
      sourceURL: ENDPOINTS.sources + '/' + journal.key.replace(/^openalex:/, ''),
      checkedAt,
      evidence: EVIDENCE,
      metric: METRIC
    };
    if (!Journals.valid(record)) { dropped.rejected++; continue; }
    rows.push(record);
  }
  return {rows, dropped, examples: examples.slice(0, 5)};
}

/* Mirrors flat() and exactRegistryTitle() in src/journal-identity.js. They are
   not exported, and loadRegistry throws on two rows that reduce to the same
   identity, so the duplicates have to be found here rather than at load. */
const flatTitle = value => text(value).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const exactTitle = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/* Publishers, from the sweep this repository already holds. It covers the
   journals that were in the licensed export, so roughly a quarter of these;
   the rest carry an empty publisher, which their readers already handle. */
function publisherIndex() {
  const byIssn = new Map(), byId = new Map();
  let table = {};
  try { table = JSON.parse(readFileSync(path.join(ROOT, 'data/journal-publishers-openalex.json'), 'utf8')).out || {}; }
  catch (_) { return {byIssn, byId}; }
  for (const [code, entry] of Object.entries(table)) {
    const name = text(entry?.publisher);
    if (!name) continue;
    byIssn.set(code.toUpperCase().replace(/[^0-9X]/g, ''), name);
    const id = openAlexId(entry?.id);
    if (id) byId.set(id, name);
  }
  return {byIssn, byId};
}

/* The registry, in the shape loadRegistry() reads: rows plus one shared table
   of subject names, each row's levels being [domain, field, subfield] indexes
   into it. The subject names are OpenAlex's own, without the bracketed
   parents the catalogue needs, because here the index disambiguates. */
function registryPayload(payload) {
  const subjects = [], indexOf = new Map();
  const subject = name => {
    const key = text(name);
    if (!key) return -1;
    if (!indexOf.has(key)) { indexOf.set(key, subjects.length); subjects.push(key); }
    return indexOf.get(key);
  };
  const levelOf = new Map();
  for (const category of payload.categories) {
    const field = category.groupKeys[0] || '';
    const suffix = ' (' + field + ')';
    const plain = field && category.key.endsWith(suffix) ? category.key.slice(0, -suffix.length) : category.key;
    levelOf.set(category.key, [subject(category.domain), subject(field), subject(plain)]);
  }
  const {byIssn, byId} = publisherIndex();
  const bare = code => String(code).toUpperCase().replace(/[-\s]/g, '');
  const rows = payload.journals.map(journal => {
    const id = journal.key.replace(/^openalex:/, '');
    return {
      title: journal.title,
      issns: journal.issns,
      // OpenAlex publishes no abbreviated title. The readers derive one from
      // the plugin's own table when this is empty, so nothing is invented.
      abbreviation: '',
      impactFactor: journal.citedness,
      year: null,
      // The best quarter the journal reaches in any of its categories, which
      // is how a single quartile is normally read off several rankings.
      quartile: journal.citednessQuartiles.length ? Math.min(...journal.citednessQuartiles) : null,
      publisher: byId.get(id) || journal.issns.map(code => byIssn.get(bare(code))).find(Boolean) || '',
      levels: journal.categoryKeys.map(key => levelOf.get(key)).filter(Boolean),
      metric: METRIC
    };
  });
  const counts = new Map();
  for (const row of rows) counts.set(flatTitle(row.title), (counts.get(flatTitle(row.title)) || 0) + 1);
  const used = new Set(), journals = [];
  let duplicates = 0;
  for (const row of rows) {
    const key = flatTitle(row.title);
    const codes = [...new Set(row.issns.map(bare))].sort();
    const identity = counts.get(key) === 1 ? key : 'journal:' + JSON.stringify([exactTitle(row.title), codes]);
    if (used.has(identity)) { duplicates++; continue; }
    used.add(identity);
    journals.push(row);
  }
  return {payload: {
    edition: 'OpenAlex sources, ' + payload.source.capturedAt.slice(0, 10),
    count: journals.length,
    withPublisher: journals.filter(row => row.publisher).length,
    withSubjects: journals.filter(row => row.levels.length).length,
    metricProvenance: {provider: 'OpenAlex', product: 'Sources', license: 'CC0-1.0',
      field: 'summary_stats.2yr_mean_citedness', metric: METRIC, isEstimate: true, isJournalImpactFactor: false,
      sourceURL: ENDPOINTS.sources, capturedAt: payload.source.capturedAt,
      note: 'impactFactor carries OpenAlex 2-year mean citedness, kept under that name because the registry\'s '
        + 'readers require it. The metric field on every row says what the number actually is.',
      quartileRule: payload.source.ranking.quartileRule, quartileCategoryKnown: false},
    subjectProvenance: {provider: 'OpenAlex', scheme: 'topic_share', levels: ['domain', 'field', 'subfield'],
      capturedAt: payload.source.capturedAt, identifiersRetained: false, complete: true},
    journals, subjects
  }, duplicates};
}

/* --------------------------------------------------------------------- run */

const config = options(process.argv.slice(2));
const payload = await build(config);
const write = (file, value) => {
  const json = (config.pretty ? JSON.stringify(value, null, 1) : JSON.stringify(value)) + '\n';
  writeFileSync(file, json);
  return Buffer.byteLength(json);
};

const catalogBytes = write(config.out, payload);
const impact = impactRecords(payload);
const impactBytes = write(config.ifOut, impact.rows);
const registry = registryPayload(payload);
const registryBytes = write(config.registryOut, registry.payload);

// Load each derived file through the module that will read it at runtime, so
// a file that cannot be loaded never reaches the archive.
Journals.create(impact.rows);
const loaded = Identity.loadRegistry(JSON.parse(readFileSync(config.registryOut, 'utf8')));
if (loaded !== registry.payload.journals.length) throw new Error('the registry did not load every row');

process.stderr.write([
  'wrote ' + config.out + ' (' + catalogBytes.toLocaleString() + ' bytes)',
  '  groups ' + payload.groups.length + ', categories ' + payload.categories.length
    + ', journals ' + payload.journals.length,
  'wrote ' + config.ifOut + ' (' + impactBytes.toLocaleString() + ' bytes)',
  '  records ' + impact.rows.length + ', dropped above the 1000 limit ' + impact.dropped.aboveLimit
    + (impact.examples.length ? ' (' + impact.examples.join('; ') + ')' : '')
    + ', otherwise rejected ' + impact.dropped.rejected,
  'wrote ' + config.registryOut + ' (' + registryBytes.toLocaleString() + ' bytes)',
  '  rows ' + registry.payload.count + ', duplicate identities dropped ' + registry.duplicates
    + ', with publisher ' + registry.payload.withPublisher + ', with subjects ' + registry.payload.withSubjects
    + ', subject names ' + registry.payload.subjects.length,
  'requests ' + requests + ' (about $' + (requests * 0.0001).toFixed(4) + ')'
].join('\n') + '\n');

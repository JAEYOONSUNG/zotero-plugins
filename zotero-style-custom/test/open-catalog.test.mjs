/* The openly licensed journal catalogue: data/journal-catalog.json, built by
   scripts/build-open-catalog.mjs from OpenAlex.

   Two things are under test. The logic runs against a small inline fixture, so
   a failure points at a rule rather than at 89,500 rows. The integrity checks
   run against the real generated file, because a catalogue whose counts
   disagree with its own membership lists is the failure that matters and it
   cannot be reproduced in a fixture.

   The figure this catalogue carries is OpenAlex's two-year mean citedness. It
   is not the Journal Impact Factor and the file is not allowed to say it is;
   that is a test here, not a convention. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import Model from '../src/jcr-categories.js';
import Browser from '../src/jcr-browser.js';
import Journals from '../src/journals.js';
import Identity from '../src/journal-identity.js';

const FILE = new URL('../data/journal-catalog.json', import.meta.url);

function payload() {
  return {
    schemaVersion: 1,
    source: {
      provider: 'OpenAlex', product: 'Sources', license: 'CC0-1.0',
      licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      url: 'https://api.openalex.org/sources',
      endpoints: {sources: 'https://api.openalex.org/sources', subfields: 'https://api.openalex.org/subfields',
        fields: 'https://api.openalex.org/fields', domains: 'https://api.openalex.org/domains'},
      capturedAt: '2026-09-22T00:00:00.000Z', datasetUpdated: null, releaseYear: null, metricYear: null,
      complete: {groups: true, categories: true, journals: true},
      metric: {field: 'citedness', name: 'Two-year mean citedness',
        openAlexField: 'summary_stats.2yr_mean_citedness', isEstimate: true, isJournalImpactFactor: false,
        note: 'Close in spirit to a Journal Impact Factor and not one.'},
      ranking: {fields: ['citednessRanks', 'citednessQuartiles', 'citednessPercentiles']}
    },
    groups: [
      {key: 'Medicine', name: 'Medicine', openAlexId: 'fields/27', categoryCount: 2, journalCount: 3,
        citableItems: null, worksCount: 900, domain: 'Health Sciences',
        categoryKeys: ['General Health Professions', 'Oncology']},
      {key: 'Physics and Astronomy', name: 'Physics and Astronomy', openAlexId: 'fields/31', categoryCount: 1,
        journalCount: 1, citableItems: null, worksCount: 400, domain: 'Physical Sciences',
        categoryKeys: ['Astronomy and Astrophysics']}],
    categories: [
      {key: 'Astronomy and Astrophysics', name: 'Astronomy and Astrophysics', openAlexId: 'subfields/3103',
        groupKeys: ['Physics and Astronomy'], editions: [], journalCount: 1, citableItems: null,
        totalCitations: 400, medianCitedness: 6.1, worksCount: 400, domain: 'Physical Sciences'},
      {key: 'General Health Professions', name: 'General Health Professions', openAlexId: 'subfields/2700',
        groupKeys: ['Medicine'], editions: [], journalCount: 2, citableItems: null,
        totalCitations: 600, medianCitedness: 16.26, worksCount: 500, domain: 'Health Sciences'},
      {key: 'Oncology', name: 'Oncology', openAlexId: 'subfields/2730',
        groupKeys: ['Medicine'], editions: [], journalCount: 2, citableItems: null,
        totalCitations: 300, medianCitedness: 21, worksCount: 400, domain: 'Health Sciences'}],
    journals: [
      {key: 'openalex:S49861241', title: 'The Lancet', issns: ['0099-5355', '0140-6736'],
        categoryKeys: ['General Health Professions'], citedness: 20.51, citednessRanks: [1],
        citednessQuartiles: [1], citednessPercentiles: [75], worksCount: 300, totalCitations: 400, hIndex: 1212},
      {key: 'openalex:S148561398', title: 'Journal of Clinical Oncology', issns: ['0732-183X'],
        categoryKeys: ['Oncology', 'General Health Professions'], citedness: 12, citednessRanks: [2, 2],
        citednessQuartiles: [3, 3], citednessPercentiles: [25, 25], worksCount: 200, totalCitations: 200, hIndex: 742},
      {key: 'openalex:S86914345', title: 'Cancer Cell', issns: ['1535-6108'],
        categoryKeys: ['Oncology'], citedness: 30, citednessRanks: [1], citednessQuartiles: [1],
        citednessPercentiles: [75], worksCount: 200, totalCitations: 100, hIndex: 400},
      {key: 'openalex:S37318024', title: 'The Astrophysical Journal', issns: ['0004-637X'],
        categoryKeys: ['Astronomy and Astrophysics'], citedness: 6.1, citednessRanks: [1],
        citednessQuartiles: [1], citednessPercentiles: [50], worksCount: 400, totalCitations: 400, hIndex: 500}]
  };
}

const quartileFor = (rank, total) => Math.min(4, Math.floor((rank - 1) * 4 / total) + 1);
// Written the way the build writes it, digit for digit: (x * 100) * 10 and
// x * 1000 disagree at a rounding boundary often enough to matter at 89,510.
const percentileFor = (rank, total) => Math.round((total - rank + 0.5) / total * 100 * 10) / 10;

/* Every key and every string in the file, so a claim cannot hide in a nested
   note or a field name nobody thought to look at. */
function walk(value, path = '', keys = [], strings = []) {
  if (typeof value === 'string') strings.push([path, value]);
  else if (Array.isArray(value)) value.forEach((entry, index) => walk(entry, path + '[' + index + ']', keys, strings));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) { keys.push([path + '.' + key, key]); walk(entry, path + '.' + key, keys, strings); }
  }
  return {keys, strings};
}

/* ------------------------------------------------------- the fixture rules */

test('the loader accepts an OpenAlex catalogue and reads back its taxonomy', () => {
  const catalog = Model.create(payload());
  assert.equal(catalog.source.provider, 'OpenAlex');
  assert.equal(catalog.source.license, 'CC0-1.0');
  assert.equal(catalog.groups.length, 2);
  assert.equal(catalog.categories.length, 3);
  assert.equal(catalog.journals.length, 4);
  assert.deepEqual(catalog.categoriesForGroup('Medicine').map(category => category.key),
    ['General Health Professions', 'Oncology']);
  assert.deepEqual(catalog.journalsForCategory('Oncology').map(journal => journal.title),
    ['Journal of Clinical Oncology', 'Cancer Cell']);
  assert.equal(catalog.category('Oncology').medianCitedness, 21);
  assert.equal(catalog.journals[0].citedness, 20.51);
});

test('an OpenAlex catalogue that misstates where it came from is refused', () => {
  const changes = [
    // The licence is the reason this data may ship at all.
    data => { delete data.source.license; },
    data => { data.source.license = 'CC-BY-4.0'; },
    // A file may not wear the other provider's name, in either direction.
    data => { data.source.provider = 'Clarivate'; },
    data => { data.source.provider = 'Clarivate'; data.source.product = 'JCR'; },
    data => { data.source.product = 'Topics'; },
    // Nor point somewhere that is not the API it claims to come from.
    data => { data.source.url = 'https://api.openalex.org.evil.test/sources'; },
    data => { data.source.url = 'http://api.openalex.org/sources'; },
    data => { data.source.url = 'https://user:pass@api.openalex.org/sources'; },
    data => { data.source.url = 'https://jcr.clarivate.com/jcr/browse-categories'; }
  ];
  for (const change of changes) {
    const data = payload();
    change(data);
    assert.throws(() => Model.create(data), /Invalid JCR catalog/);
  }
});

/* A reader's own Journal Citation Reports export still loads through the same
   module, and still has to be JCR all the way down. The fixture is inline
   because the licensed tables are no longer in the repository. */
test('a licensed JCR catalogue still loads, and still refuses an OpenAlex url', () => {
  const licensed = () => ({schemaVersion: 1,
    source: {provider: 'Clarivate', product: 'JCR', url: 'https://jcr.clarivate.com/jcr/browse-categories',
      capturedAt: '2026-09-20T05:47:13.287Z', releaseYear: 2026, metricYear: 2025,
      complete: {groups: true, categories: true, journals: true}},
    groups: [{key: 'Life Sciences', name: 'Life Sciences', categoryCount: 1, journalCount: 1, citableItems: 50,
      categoryKeys: ['ONCOLOGY']}],
    categories: [{key: 'ONCOLOGY', name: 'ONCOLOGY', groupKeys: ['Life Sciences'], editions: ['SCIE'],
      journalCount: 1, citableItems: 50, totalCitations: 1000, medianJIF: 4.1}],
    journals: [{key: 'j1', title: 'Journal of Invented Results', abbreviation: 'J INVENT RES',
      issns: ['0000-0019'], categoryKeys: ['ONCOLOGY'], jif: 1.5, year: 2025}]});
  const catalog = Model.create(licensed());
  assert.equal(catalog.source.provider, 'Clarivate');
  assert.equal(catalog.journals[0].jif, 1.5, 'a licensed figure keeps its own name');
  const moved = licensed();
  moved.source.url = 'https://api.openalex.org/sources';
  assert.throws(() => Model.create(moved), /Invalid JCR catalog/);
  // A licensed file does not get to skip the licence check by wearing the
  // other provider's name, and an open file does not get JCR's url.
  const mixed = licensed();
  mixed.source.provider = 'OpenAlex';
  mixed.source.product = 'Sources';
  mixed.source.license = 'CC0-1.0';
  assert.throws(() => Model.create(mixed), /Invalid JCR catalog/);
});

test('membership, counts and parallel rank arrays have to agree in the fixture', () => {
  const broken = [
    data => { data.categories[2].journalCount = 5; },
    data => { data.groups[0].categoryCount = 1; },
    data => { data.journals[0].categoryKeys = ['No Such Subfield']; },
    data => { data.categories[0].groupKeys = ['No Such Field']; },
    data => { data.groups[0].categoryKeys = ['Oncology']; }
  ];
  for (const change of broken) {
    const data = payload();
    change(data);
    assert.throws(() => Model.create(data), /Invalid JCR catalog/);
  }
  // The three standing arrays run alongside categoryKeys, index for index.
  for (const journal of payload().journals) {
    for (const field of ['citednessRanks', 'citednessQuartiles', 'citednessPercentiles']) {
      assert.equal(journal[field].length, journal.categoryKeys.length, journal.title + ' ' + field);
    }
  }
});

test('a journal is found by either of its ISSNs in the fixture', () => {
  const catalog = Model.create(payload());
  const find = issn => catalog.journals.find(journal => journal.issns.includes(issn)) || null;
  assert.equal(find('0140-6736').title, 'The Lancet');
  assert.equal(find('0099-5355').title, 'The Lancet');
  assert.equal(find('0732-183X').key, 'openalex:S148561398');
  assert.equal(find('0000-0000'), null);
});

/* ---------------------------------------------------- the generated file */

const raw = readFileSync(FILE, 'utf8');
const data = JSON.parse(raw);
const catalog = Model.create(data);

test('the generated catalogue parses and the loader accepts it', () => {
  assert.equal(data.schemaVersion, 1);
  assert.ok(catalog.groups.length >= 20, 'the OpenAlex fields');
  assert.ok(catalog.categories.length >= 200, 'the OpenAlex subfields');
  assert.ok(catalog.journals.length >= 50000, 'the journals with a two-year figure');
  assert.equal(catalog.groups.length, data.groups.length);
  assert.equal(catalog.journals.length, data.journals.length);
});

test('the generated catalogue says it is OpenAlex, CC0, and not JCR', () => {
  const source = catalog.source;
  assert.equal(source.provider, 'OpenAlex');
  assert.equal(source.product, 'Sources');
  assert.equal(source.license, 'CC0-1.0');
  assert.equal(source.url, 'https://api.openalex.org/sources');
  assert.equal(source.endpoints.subfields, 'https://api.openalex.org/subfields');
  assert.equal(source.endpoints.fields, 'https://api.openalex.org/fields');
  assert.equal(source.endpoints.domains, 'https://api.openalex.org/domains');
  assert.match(source.capturedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(source.metric.isEstimate, true, 'the figure is an estimate and has to say so');
  assert.equal(source.metric.openAlexField, 'summary_stats.2yr_mean_citedness');
  assert.ok(!/clarivate|journal citation reports/i.test(raw), 'nothing in the file may invoke JCR');
  // Honest coverage: the numbers the source block reports are the real ones.
  assert.equal(source.coverage.journalsCaptured, data.journals.length);
  assert.equal(source.coverage.journalsWithoutCategory,
    data.journals.filter(journal => !journal.categoryKeys.length).length);
  assert.equal(source.coverage.journalsWithoutISSN,
    data.journals.filter(journal => !journal.issns.length).length);
});

test('no field in the generated catalogue is named or described as a JIF', () => {
  const WORDS = /jif|impact.?factor/gi;
  // The taxonomy is small enough to walk key by key.
  const {keys, strings} = walk({source: data.source, groups: data.groups, categories: data.categories});
  const named = keys.filter(([, key]) => /jif|impact.?factor/i.test(key)).map(([path]) => path);
  assert.deepEqual(named, ['.source.metric.isJournalImpactFactor'], 'unexpected JIF-shaped field names: ' + named);
  assert.equal(data.source.metric.isJournalImpactFactor, false, 'the flag exists only to deny the claim');
  const claims = strings.filter(([path, value]) => /jif|impact.?factor/i.test(value) && !path.startsWith('.source.metric.'));
  assert.deepEqual(claims, [], 'only source.metric may discuss the Journal Impact Factor, and only to disown it');
  assert.match(data.source.metric.note, /not one|is not/i);
  // The journals are too many to walk, so take the union of their field names.
  const journalKeys = new Set();
  for (const journal of data.journals) for (const key of Object.keys(journal)) journalKeys.add(key);
  for (const key of journalKeys) assert.ok(!/jif|impact|quartile$|^percentile$/i.test(key), 'journal field ' + key);
  assert.ok(journalKeys.has('citedness') && journalKeys.has('citednessQuartiles'));
  // And nowhere else in the file: every occurrence in the text has to be one
  // of the occurrences in source.metric, or part of a journal's own name.
  // Seven journals really are called JIF-something, such as "JURNAL ILMIAH
  // FEASIBLE (JIF)". A journal's name is data, not a claim about the figure.
  const all = (raw.match(WORDS) || []).length;
  const inMetric = (JSON.stringify(data.source.metric).match(WORDS) || []).length;
  const inNames = data.journals.reduce((sum, journal) => sum + (journal.title.match(WORDS) || []).length, 0);
  assert.equal(all, inMetric + inNames, 'the words appear somewhere that is neither source.metric nor a journal name');
  assert.ok(inMetric > 0, 'source.metric has to name what the figure is not');
});

test('every category key on a journal, and every group key on a category, exists', () => {
  const categoryKeys = new Set(catalog.categories.map(category => category.key));
  const groupKeys = new Set(catalog.groups.map(group => group.key));
  for (const category of catalog.categories) {
    assert.ok(category.groupKeys.length, category.key + ' has no field');
    for (const key of category.groupKeys) assert.ok(groupKeys.has(key), category.key + ' -> ' + key);
  }
  let unknown = 0;
  for (const journal of catalog.journals) for (const key of journal.categoryKeys) if (!categoryKeys.has(key)) unknown++;
  assert.equal(unknown, 0);
  // Keys equal names, so a duplicated subfield name would have merged two
  // different subjects into one row.
  assert.equal(categoryKeys.size, catalog.categories.length);
  assert.equal(groupKeys.size, catalog.groups.length);
  for (const category of catalog.categories) assert.equal(category.key, category.name);
  for (const group of catalog.groups) assert.equal(group.key, group.name);
});

test('the counts in the generated catalogue agree with the membership lists', () => {
  for (const group of catalog.groups) {
    const members = catalog.categoriesForGroup(group.key);
    assert.equal(members.length, group.categoryCount, group.key + ' categoryCount');
    assert.equal(group.categoryKeys.length, group.categoryCount, group.key + ' categoryKeys');
    const journals = new Set();
    for (const category of members) for (const journal of catalog.journalsForCategory(category.key)) journals.add(journal.key);
    assert.equal(journals.size, group.journalCount, group.key + ' journalCount');
  }
  for (const category of catalog.categories) {
    const journals = catalog.journalsForCategory(category.key);
    assert.equal(journals.length, category.journalCount, category.key + ' journalCount');
    assert.equal(catalog.categoryCoverage(category.key).countMatches, true, category.key + ' coverage');
  }
  const total = catalog.categories.reduce((sum, category) => sum + category.journalCount, 0);
  const memberships = catalog.journals.reduce((sum, journal) => sum + journal.categoryKeys.length, 0);
  assert.equal(total, memberships);
});

test('every citedness rank and quartile lines up with its category', () => {
  const totals = new Map(catalog.categories.map(category => [category.key, category.journalCount]));
  const seen = new Map();
  for (const journal of catalog.journals) {
    assert.ok(typeof journal.citedness === 'number' && journal.citedness > 0, journal.key + ' citedness');
    assert.equal(journal.citednessRanks.length, journal.categoryKeys.length, journal.key + ' ranks');
    assert.equal(journal.citednessQuartiles.length, journal.categoryKeys.length, journal.key + ' quartiles');
    assert.equal(journal.citednessPercentiles.length, journal.categoryKeys.length, journal.key + ' percentiles');
    journal.categoryKeys.forEach((key, index) => {
      const rank = journal.citednessRanks[index], total = totals.get(key);
      assert.ok(Number.isInteger(rank) && rank >= 1 && rank <= total, journal.key + ' rank ' + rank + '/' + total);
      assert.equal(journal.citednessQuartiles[index], quartileFor(rank, total), journal.key + ' quartile in ' + key);
      assert.equal(journal.citednessPercentiles[index], percentileFor(rank, total), journal.key + ' percentile in ' + key);
      const used = seen.get(key) || new Set();
      assert.ok(!used.has(rank), 'two journals hold rank ' + rank + ' in ' + key);
      used.add(rank);
      seen.set(key, used);
    });
  }
  // A rank is a rank: nobody is missing and nobody is counted twice.
  for (const [key, used] of seen) assert.equal(used.size, totals.get(key), key + ' ranks are not 1..n');
  // The best journal in a category really is the one on top.
  for (const category of catalog.categories.slice(0, 40)) {
    const journals = catalog.journalsForCategory(category.key);
    if (!journals.length) continue;
    const best = journals.reduce((a, b) => b.citedness > a.citedness ? b : a);
    assert.equal(best.citednessRanks[best.categoryKeys.indexOf(category.key)], 1, category.key);
  }
});

/* The browser reads whichever figure the loaded catalog declares. With this
   one that is the two-year mean citedness, drawn with the leading ~ the rest
   of the plugin uses for an estimate, and no column, tooltip or sort option
   anywhere in the rendered page is allowed to say JIF. */
test('the browser renders this catalogue with its own figure, never as a JIF', () => {
  const {document: doc, window: win} = parseHTML('<html><body><div id="host"></div></body></html>');
  Object.defineProperty(win.HTMLSelectElement.prototype, 'value', {configurable: true,
    get() { return this._value ?? this.querySelector('option[selected]')?.getAttribute('value') ?? ''; },
    set(value) { this._value = String(value); }});
  Object.defineProperty(doc, 'activeElement', {configurable: true, get() { return this._active || doc.body; }});
  win.HTMLElement.prototype.focus = function () { doc._active = this; };
  const host = doc.getElementById('host');
  const browser = Browser.mount(host, {catalog});
  const click = node => node.dispatchEvent(new win.Event('click', {bubbles: true}));

  assert.equal(host.querySelectorAll('.sc-jcr-group').length, catalog.groups.length);
  const stamp = host.querySelector('.sc-jcr-source').textContent;
  assert.match(stamp, /OpenAlex · Sources/, 'the stamp names the real provider');
  assert.doesNotMatch(stamp, /Clarivate|JCR/);

  const medicine = [...host.querySelectorAll('.sc-jcr-group')].find(node => node.dataset.groupKey === 'Medicine');
  assert.ok(medicine, 'the Medicine field');
  click(medicine.querySelector('button'));
  const links = [...host.querySelectorAll('.sc-jcr-category-link')];
  assert.ok(links.length > 5, 'its subfields are listed');
  click(links.find(node => node.dataset.categoryKey === 'Oncology') || links[0]);
  assert.equal(browser.state.view, 'journals');
  const rows = host.querySelectorAll('tbody tr');
  assert.ok(rows.length, 'the category lists journals');
  const cell = column => rows[0].querySelector('[data-column="' + column + '"]');
  assert.notEqual(cell('issns').textContent, '', 'the ISSN column is filled');
  assert.equal(cell('jif'), null, 'there is no JIF column');
  const value = cell('citedness');
  // The tilde is drawn by the stylesheet from data-estimate, so the cell itself
  // holds the number and a copied column is usable.
  assert.match(value.textContent, /^[\d,.]+$/, 'the cell carries the number, not a marked-up string');
  assert.equal(value.dataset.estimate, 'true', 'and is marked as an estimate');
  const header = host.querySelector('th[data-column="citedness"]');
  assert.match(header.getAttribute('title'), /추정치/, 'the column says so once, over itself');
  assert.match(cell('rank').textContent, /^\d[\d,]*\/\d[\d,]*$/, 'a rank out of the category total');
  assert.match(cell('quartile').textContent, /^Q[1-4]$/);
  assert.match(cell('percentile').textContent, /^\d+(\.\d)?$/, 'and how far up the category it sits');

  // Nothing the reader can see calls this figure a Journal Impact Factor.
  const shown = host.textContent + ' ' + [...host.querySelectorAll('*')]
    .flatMap(node => [node.getAttribute('title'), node.getAttribute('aria-label')]).filter(Boolean).join(' ');
  assert.doesNotMatch(shown.replace(/공식 JIF가 아니라[^"]*?추정치입니다\./g, ''), /JIF|Impact Factor/i);
  browser.destroy();
});

test('a journal is found by ISSN in the generated catalogue', () => {
  const byISSN = new Map();
  for (const journal of catalog.journals) for (const issn of journal.issns) if (!byISSN.has(issn)) byISSN.set(issn, journal);
  const lancet = byISSN.get('0140-6736');
  assert.ok(lancet, 'The Lancet is in OpenAlex under 0140-6736');
  assert.equal(lancet.title, 'The Lancet');
  assert.ok(lancet.citedness > 5);
  assert.ok(lancet.categoryKeys.length >= 1);
  const nature = byISSN.get('0028-0836');
  assert.equal(nature.title, 'Nature');
  // Every ISSN is well formed, which is what a reader will paste in.
  for (const journal of catalog.journals) for (const issn of journal.issns) assert.match(issn, /^\d{4}-\d{3}[\dX]$/);
});

/* ------------------------------- the two files built from the same sweep */

const METRIC = 'openalex-2yr-mean-citedness';
const impact = JSON.parse(readFileSync(new URL('../data/if-openalex.json', import.meta.url), 'utf8'));

test('every impact record passes the contract src/journals.js enforces', () => {
  assert.ok(Array.isArray(impact) && impact.length > 50000, 'one record per journal');
  // scripts/verify-if-catalog.mjs applies exactly these two, per record.
  for (const record of impact) {
    assert.ok(Journals.valid(record), record.title);
    assert.ok(typeof record.evidence === 'string' && record.evidence.trim(), record.title);
  }
  // And the whole file has to index, which is what the plugin does with it.
  assert.equal(Journals.create(impact).records.length, impact.length);
});

test('every impact record says the figure is OpenAlex, and is not a JIF', () => {
  const evidence = new Set(impact.map(record => record.evidence));
  assert.equal(evidence.size, 1, 'one sentence, not a sentence per row');
  const [sentence] = evidence;
  assert.match(sentence, /OpenAlex/);
  assert.match(sentence, /CC0/);
  assert.match(sentence, /not the Journal Impact Factor/i);
  for (const record of impact.slice(0, 2000)) {
    assert.equal(record.metric, METRIC, record.title);
    assert.equal(record.year, null, 'OpenAlex does not date the figure');
    assert.match(record.sourceURL, /^https:\/\/api\.openalex\.org\/sources\/S\d+$/, record.title);
  }
  assert.ok(impact.every(record => record.metric === METRIC), 'every row carries the marker');
  // Dropped rather than clamped: nothing sits at the limit valid() imposes.
  assert.ok(impact.every(record => record.impactFactor < 1000));
  const lancet = impact.find(record => record.issns.includes('0140-6736'));
  assert.equal(lancet.title, 'The Lancet');
  assert.ok(lancet.impactFactor > 5);
});

test('the open registry loads through loadRegistry and keeps its subjects', () => {
  const payload = JSON.parse(readFileSync(new URL('../data/journal-registry.open.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(payload.subjects) && payload.subjects.length > 200, 'the shared name table');
  assert.equal(payload.count, payload.journals.length);
  assert.equal(payload.withPublisher, payload.journals.filter(row => row.publisher).length);
  assert.equal(payload.withSubjects, payload.journals.filter(row => row.levels.length).length);
  assert.equal(payload.metricProvenance.provider, 'OpenAlex');
  assert.equal(payload.metricProvenance.isJournalImpactFactor, false);
  assert.equal(payload.metricProvenance.isEstimate, true);
  // Every level is a triple of real indexes into the shared table.
  for (const row of payload.journals.slice(0, 5000)) {
    assert.equal(row.metric, METRIC, row.title);
    assert.ok(row.quartile === null || Number.isInteger(row.quartile) && row.quartile >= 1 && row.quartile <= 4, row.title);
    for (const level of row.levels) {
      assert.equal(level.length, 3, row.title);
      for (const index of level) assert.ok(typeof payload.subjects[index] === 'string', row.title + ' ' + index);
    }
  }
  assert.ok(payload.journals.every(row => row.metric === METRIC));
  // loadRegistry throws on two rows that reduce to the same identity, so a
  // clean load over 89,500 rows is the real check that none of them do.
  assert.equal(Identity.loadRegistry(payload), payload.journals.length);
  const lancet = Identity.registryByIssn('0140-6736');
  assert.equal(lancet.title, 'The Lancet');
  assert.ok(lancet.levels.length, 'its subjects come back unpacked as names');
  assert.equal(typeof lancet.levels[0].subfield, 'string');
  assert.ok(Identity.registryLookup('Nature'), 'and a journal is found by title');
});

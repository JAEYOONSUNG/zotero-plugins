import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import Model from '../src/jcr-categories.js';

function payload() {
  return {schemaVersion: 1, source: {provider: 'Clarivate', product: 'JCR',
    url: 'https://jcr.clarivate.com/jcr/browse-categories', capturedAt: '2026-09-20T04:52:59.928Z',
    datasetUpdated: '2026-06-17', releaseYear: 2026, metricYear: 2025,
    complete: {groups: true, categories: true, journals: true}},
    groups: [
      {key: 'Life Sciences', name: 'Life Sciences', categoryCount: 2, journalCount: 2, citableItems: 150,
        categoryKeys: ['BIOCHEMISTRY & MOLECULAR BIOLOGY', 'MULTIDISCIPLINARY SCIENCES']},
      {key: 'Multidisciplinary', name: 'Multidisciplinary', categoryCount: 1, journalCount: 2, citableItems: 100,
        categoryKeys: ['MULTIDISCIPLINARY SCIENCES']}],
    categories: [
      {key: 'BIOCHEMISTRY & MOLECULAR BIOLOGY', name: 'BIOCHEMISTRY & MOLECULAR BIOLOGY',
        groupKeys: ['Life Sciences'], editions: ['SCIE', 'ESCI'], journalCount: 1, citableItems: 50, totalCitations: 1000, medianJIF: 4.1},
      {key: 'MULTIDISCIPLINARY SCIENCES', name: 'MULTIDISCIPLINARY SCIENCES',
        groupKeys: ['Life Sciences', 'Multidisciplinary'], editions: ['SCIE'], journalCount: 2, citableItems: 100, totalCitations: 2000, medianJIF: null}],
    journals: [
      {key: 'observed-journal-a', title: 'Journal A', abbreviation: 'J A', issns: ['0028-0836', '1476-4687'],
        categoryKeys: ['BIOCHEMISTRY & MOLECULAR BIOLOGY', 'MULTIDISCIPLINARY SCIENCES'], jif: 0, year: 2025,
        observedDetails: {publicationFrequency: null, nativeCategoryRanks: [{category: 'BIOCHEMISTRY & MOLECULAR BIOLOGY', rank: '1/1'}]}},
      {key: 'observed-journal-b', title: 'Journal B', abbreviation: null, issns: [],
        categoryKeys: ['MULTIDISCIPLINARY SCIENCES'], jif: null, year: null}]
  };
}

test('official names, multiple parents, journal memberships and source counts remain exact', () => {
  const data = payload(), catalog = Model.create(data);
  assert.deepEqual(catalog.categories.map(category => category.name), data.categories.map(category => category.name));
  assert.deepEqual(catalog.category('MULTIDISCIPLINARY SCIENCES').groupKeys, ['Life Sciences', 'Multidisciplinary']);
  assert.deepEqual(catalog.categoriesForGroup('Life Sciences').map(category => category.key), data.groups[0].categoryKeys);
  assert.deepEqual(catalog.journalsForCategory('MULTIDISCIPLINARY SCIENCES').map(journal => journal.key), ['observed-journal-a', 'observed-journal-b']);
  assert.equal(catalog.group('Life Sciences').journalCount, 2, 'do not sum overlapping category memberships into 3');
  assert.equal(catalog.group('Life Sciences').citableItems, 150, 'retain captured group totals');
  assert.equal(catalog.category('MULTIDISCIPLINARY SCIENCES').medianJIF, null);
  assert.equal(catalog.journals[0].jif, 0);
  assert.equal(catalog.journals[1].jif, null);
  assert.equal(catalog.group('life sciences'), null, 'no normalized name collisions or invented aliases');
  assert.equal(catalog.category('Unknown'), null);
  assert.deepEqual(catalog.categoriesForGroup('Unknown'), []);
  assert.deepEqual(catalog.journalsForCategory('Unknown'), []);
  assert.ok(!Object.hasOwn(catalog.journals[1], 'rank'));
  assert.ok(!Object.hasOwn(catalog.journals[1], 'quartile'));
  assert.deepEqual(catalog.journals[0].observedDetails, data.journals[0].observedDetails);
});

test('normalization preserves nulls and zero without converting unavailable counts to zero', () => {
  const data = payload();
  data.groups[0].citableItems = '1,234';
  data.groups[1].citableItems = '—';
  data.categories[0].totalCitations = '2,345';
  data.categories[0].medianJIF = '4.10';
  data.categories[1].medianJIF = '';
  data.journals[0].jif = '0';
  data.journals[1].year = 'N/A';
  const catalog = Model.create(data);
  assert.equal(catalog.groups[0].citableItems, 1234);
  assert.equal(catalog.groups[1].citableItems, null);
  assert.equal(catalog.categories[0].totalCitations, 2345);
  assert.equal(catalog.categories[0].medianJIF, 4.1);
  assert.equal(catalog.categories[1].medianJIF, null);
  assert.equal(catalog.journals[0].jif, 0);
  assert.equal(catalog.journals[1].year, null);
  assert.equal(data.groups[0].citableItems, '1,234', 'input remains unchanged');
});

test('bounded official metric displays never become fabricated exact numbers', () => {
  const data = payload();
  data.categories[0].medianJIF = '<0.1';
  data.journals[0].jif = '<0.1';
  const catalog = Model.create(data);
  assert.equal(catalog.categories[0].medianJIF, null);
  assert.equal(catalog.categories[0].medianJIFDisplay, '<0.1');
  assert.equal(catalog.journals[0].jif, null);
  assert.equal(catalog.journals[0].jifDisplay, '<0.1');
  data.journals[0].jif = 0.1;
  data.journals[0].jifDisplay = '<0.1';
  assert.throws(() => Model.create(data), /bounded display is not an exact/);
});

test('model data and lookup arrays are immutable and isolated from caller mutation', () => {
  const data = payload(), catalog = Model.create(data);
  data.categories[0].groupKeys.push('Changed outside');
  data.journals[0].observedDetails.nativeCategoryRanks[0].rank = 'changed';
  data.source.complete.journals = false;
  assert.deepEqual(catalog.categories[0].groupKeys, ['Life Sciences']);
  assert.equal(catalog.journals[0].observedDetails.nativeCategoryRanks[0].rank, '1/1');
  assert.equal(catalog.source.complete.journals, true);
  assert.throws(() => catalog.groups.push({}), TypeError);
  assert.throws(() => catalog.categoriesForGroup('Life Sciences').pop(), TypeError);
  assert.throws(() => { catalog.journals[0].observedDetails.nativeCategoryRanks[0].rank = 'changed'; }, TypeError);
  assert.equal(catalog.category('MULTIDISCIPLINARY SCIENCES'), catalog.categoriesForGroup('Multidisciplinary')[0]);
});

test('invalid keys, references and nonreciprocal memberships fail before exposing a catalog', () => {
  const changes = [
    data => data.groups.push({...data.groups[0]}),
    data => data.categories.push({...data.categories[0]}),
    data => data.journals.push({...data.journals[0]}),
    data => { data.groups[0].key = 'invented-official-id'; },
    data => { data.categories[0].key = 'invented-category-id'; },
    data => data.groups[0].categoryKeys.push('Missing category'),
    data => data.categories[0].groupKeys.push('Missing group'),
    data => data.categories[0].groupKeys.pop(),
    data => data.groups[0].categoryKeys.pop(),
    data => data.journals[0].categoryKeys.push('Missing category'),
    data => data.journals[0].categoryKeys.push(data.journals[0].categoryKeys[0]),
    data => { data.journals[0].issns = ['not-an-issn']; }
  ];
  for (const change of changes) { const data = payload(); change(data); assert.throws(() => Model.create(data), /Invalid JCR catalog/); }
});

test('coverage is checked against captured official counts without claiming partial journals complete', () => {
  const data = payload();
  data.journals = [];
  assert.throws(() => Model.create(data), /journal coverage/);
  data.source.complete.journals = false;
  const partial = Model.create(data);
  assert.equal(partial.category('MULTIDISCIPLINARY SCIENCES').journalCount, 2);
  assert.deepEqual(partial.journalsForCategory('MULTIDISCIPLINARY SCIENCES'), []);
  assert.equal(partial.source.complete.journals, false);
  data.groups[0].categoryCount = 3;
  assert.throws(() => Model.create(data), /category coverage/);
  data.source.complete.categories = false;
  assert.equal(Model.create(data).groups[0].categoryCount, 3);
  data.groups[0].categoryCount = 1;
  assert.throws(() => Model.create(data), /category coverage/);
});

test('malformed metrics, counts and provenance are never normalized into trusted data', () => {
  const changes = [
    data => { data.schemaVersion = 2; },
    data => { data.source.provider = 'OpenAlex'; },
    data => { data.source.product = 'Topics'; },
    data => { data.source.url = 'https://jcr.clarivate.com.evil.test/jcr/browse-categories'; },
    data => { data.source.url = 'https://user:pass@jcr.clarivate.com/'; },
    data => { data.source.url = 'http://jcr.clarivate.com/'; },
    data => { data.source.capturedAt = 'unknown'; },
    data => { data.source.complete.categories = 'true'; },
    data => { data.groups[0].journalCount = true; },
    data => { data.categories[0].citableItems = -1; },
    data => { data.categories[0].totalCitations = '12,34'; },
    data => { data.categories[0].journalCount = 1.5; },
    data => { data.categories[0].medianJIF = Infinity; },
    data => { data.categories[0].medianJIF = 'approximately 4'; },
    data => { data.journals[0].year = 2024; },
    data => { data.journals[0].extra = undefined; }
  ];
  for (const change of changes) { const data = payload(); change(data); assert.throws(() => Model.create(data), /Invalid JCR catalog/); }
  const cyclic = payload(); cyclic.groups[0].cycle = cyclic.groups[0];
  assert.throws(() => Model.create(cyclic), /cyclic data/);
});

test('identical journal titles with distinct observed keys and ISSNs remain distinct', () => {
  const data = payload();
  data.journals[1].title = data.journals[0].title;
  data.journals[1].issns = ['0036-8075'];
  const catalog = Model.create(data);
  assert.equal(catalog.journalsForCategory('MULTIDISCIPLINARY SCIENCES').length, 2);
  assert.notEqual(catalog.journals[0].key, catalog.journals[1].key);
});

function observedCategoryMetric(categoryKey = 'MULTIDISCIPLINARY SCIENCES', overrides = {}) {
  return {categoryKey, editions: ['SCIE'], rank: 1, rankTotal: 140, quartile: 1, percentile: 99.6,
    rankDisplay: '1/140', quartileDisplay: 'Q1', percentileDisplay: '99.6', ...overrides};
}

test('observed JCR category metrics retain Nature and Lancet rank contexts without calculation', () => {
  const data = payload(), medicine = 'MEDICINE, GENERAL & INTERNAL';
  data.source.complete.journals = false;
  data.groups[0].categoryKeys[0] = medicine;
  data.categories[0] = {...data.categories[0], key: medicine, name: medicine, editions: ['SCIE'], journalCount: 336};
  data.categories[1].journalCount = 140;
  data.journals[0] = {...data.journals[0], title: 'Nature', categoryKeys: ['MULTIDISCIPLINARY SCIENCES'],
    categoryMetrics: [observedCategoryMetric()]};
  data.journals[1] = {...data.journals[1], title: 'Lancet', categoryKeys: [medicine], year: 2025,
    categoryMetrics: [observedCategoryMetric(medicine, {rankTotal: 336, percentile: 99.9, rankDisplay: '1/336', percentileDisplay: '99.9'})]};
  const catalog = Model.create(data);
  assert.deepEqual(catalog.journals[0].categoryMetrics, data.journals[0].categoryMetrics);
  assert.deepEqual(catalog.journals[1].categoryMetrics, data.journals[1].categoryMetrics);
  assert.deepEqual(catalog.categoryCoverage('MULTIDISCIPLINARY SCIENCES'), {
    categoryKey: 'MULTIDISCIPLINARY SCIENCES', officialJournalCount: 140, observedJournalCount: 1,
    metricJournalCount: 1, rankedJournalCount: 1, quartileJournalCount: 1, percentileJournalCount: 1,
    countMatches: false, membershipComplete: false});
  assert.equal(catalog.categoryCoverage('Unknown'), null);
  assert.ok(Object.isFrozen(catalog.journals[0].categoryMetrics[0]));
});

test('unranked category contexts retain N/A and never synthesize rank, quartile or percentile', () => {
  const data = payload(), key = data.categories[0].key;
  data.journals[0].categoryMetrics = [observedCategoryMetric(key, {rank: null, rankTotal: null, quartile: null,
    percentile: null, rankDisplay: 'N/A', quartileDisplay: 'N/A', percentileDisplay: 'N/A'})];
  const catalog = Model.create(data), row = catalog.journals[0].categoryMetrics[0];
  assert.deepEqual([row.rank, row.rankTotal, row.quartile, row.percentile], [null, null, null, null]);
  assert.equal(row.rankDisplay, 'N/A');
  assert.equal(catalog.journals[1].categoryMetrics, undefined, 'uncaptured contexts are not fabricated');
  assert.deepEqual(catalog.categoryCoverage(key), {categoryKey: key, officialJournalCount: 1, observedJournalCount: 1,
    metricJournalCount: 1, rankedJournalCount: 0, quartileJournalCount: 0, percentileJournalCount: 0,
    countMatches: true, membershipComplete: true});
  data.journals[0].categoryMetrics = [observedCategoryMetric(key, {quartile: null, quartileDisplay: null})];
  assert.equal(Model.create(data).journals[0].categoryMetrics[0].quartile, null, 'do not derive Q1 from an observed first rank');
});

test('invalid category metric bounds, displays and duplicate or ambiguous edition contexts fail closed', () => {
  const changes = [
    metric => { metric.categoryKey = 'Not in this journal'; },
    metric => { metric.editions = ['AHCI']; },
    metric => { metric.editions = ['Both']; },
    metric => { metric.rank = 0; }, metric => { metric.rank = 141; },
    metric => { metric.rank = 1.5; }, metric => { metric.rankTotal = 0; },
    metric => { metric.rankTotal = true; }, metric => { metric.quartile = 0; },
    metric => { metric.quartile = 5; }, metric => { metric.percentile = -1; },
    metric => { metric.percentile = 100.1; }, metric => { metric.rankDisplay = '2/140'; },
    metric => { metric.rankDisplay = '1/141'; }, metric => { metric.quartileDisplay = 'Q2'; },
    metric => { metric.percentileDisplay = '99.7'; }, metric => { metric.rankDisplay = 'Multiple'; },
    metric => { metric.quartileDisplay = 'Both'; }, metric => { metric.rankDisplay = 'N/A'; }
  ];
  for (const change of changes) {
    const data = payload(), row = observedCategoryMetric(); change(row); data.journals[0].categoryMetrics = [row];
    assert.throws(() => Model.create(data), /Invalid JCR catalog/);
  }
  for (const editions of [['SCIE'], ['SCIE', 'ESCI'], []]) {
    const data = payload(), key = data.categories[0].key;
    data.journals[0].categoryMetrics = [observedCategoryMetric(key), observedCategoryMetric(key, {editions})];
    assert.throws(() => Model.create(data), /duplicate or overlapping/);
  }
  const wrongType = payload(); wrongType.journals[0].categoryMetrics = {};
  assert.throws(() => Model.create(wrongType), /categoryMetrics/);
});

test('distinct observed edition contexts survive and coverage counts journals only once', () => {
  const data = payload(), key = data.categories[0].key;
  data.journals[0].categoryMetrics = [observedCategoryMetric(key), observedCategoryMetric(key, {
    editions: ['ESCI'], rank: 140, rankTotal: 200, quartile: 3, percentile: 30.2,
    rankDisplay: '140/200', quartileDisplay: 'Q3', percentileDisplay: '30.2%'})];
  const catalog = Model.create(data), rows = catalog.journals[0].categoryMetrics;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.editions), [['SCIE'], ['ESCI']]);
  assert.deepEqual(rows.map(row => row.quartile), [1, 3]);
  assert.equal(catalog.categoryCoverage(key).metricJournalCount, 1);
  assert.equal(catalog.categoryCoverage(key).rankedJournalCount, 1);
  assert.equal(data.journals[0].categoryMetrics[1].percentileDisplay, '30.2%');
});

test('CommonJS and Zotero global APIs agree without runtime dependencies or network', () => {
  const context = vm.createContext({URL});
  vm.runInContext(readFileSync(new URL('../src/jcr-categories.js', import.meta.url), 'utf8'), context);
  const catalog = context.CustomStyleJCRCategories.create(payload());
  assert.equal(catalog.groups.length, 2);
  assert.equal(catalog.categoriesForGroup('Life Sciences').length, 2);
  assert.equal(catalog.journalsForCategory('MULTIDISCIPLINARY SCIENCES')[0].title, 'Journal A');
});

/* The shipped taxonomy, whatever is in the archive. It used to be the captured
   JCR tables; those are licensed to their reader and no longer live in this
   repository, so a clean checkout has only the openly licensed catalogue. The
   multiple-parent case the JCR tables provided is covered by the fixture above,
   because an OpenAlex subfield sits under exactly one field. */
test('the shipped taxonomy validates exact group and category membership coverage', () => {
  const data = JSON.parse(readFileSync(new URL('../data/journal-catalog.json', import.meta.url), 'utf8'));
  const catalog = Model.create(data);
  assert.equal(catalog.groups.length, data.groups.length);
  assert.equal(catalog.categories.length, data.categories.length);
  assert.deepEqual(catalog.groups.map(group => group.name), data.groups.map(group => group.name));
  for (const group of catalog.groups) {
    assert.equal(catalog.categoriesForGroup(group.key).length, group.categoryCount);
    for (const category of catalog.categoriesForGroup(group.key)) assert.ok(category.groupKeys.includes(group.key));
  }
  assert.ok(catalog.journals.some(journal => journal.categoryKeys.length > 1), 'a journal in several categories');
  assert.equal(catalog.source.provider, 'OpenAlex');
  assert.equal(catalog.source.product, 'Sources');
});

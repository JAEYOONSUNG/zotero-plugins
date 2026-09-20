// Independent invariants over the shipped journal corpus and actual product functions.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const Identity = require(path.join(root, 'zotero-style-custom/src/journal-identity.js'));
const raw = JSON.parse(read('zotero-style-custom/data/journal-registry.json'));
Identity.loadRegistry(structuredClone(raw));
const journals = Identity.registryRanked();
assert.equal(journals.length, raw.journals.length);
const expectedGroups = new Map();
for (const row of raw.journals) {
  if (row.impactFactor == null || row.impactFactor === '' || typeof row.impactFactor === 'boolean'
      || !Number.isFinite(Number(row.impactFactor)) || Number(row.impactFactor) < 0) continue;
  const paths = (row.levels || []).map(t => t.map(i => raw.subjects[i]));
  for (const [domain, field, subfield] of paths) {
    assert.ok([domain, field, subfield].every(v => typeof v === 'string' && v.length));
    for (const level of ['field', 'subfield']) {
      const key = JSON.stringify([level, domain, field, level === 'field' ? '' : subfield]);
      if (!expectedGroups.has(key)) expectedGroups.set(key, new Map());
      expectedGroups.get(key).set(row.title, Number(row.impactFactor).toFixed(1));
    }
  }
}
const groups = new Map();
for (const journal of journals) {
  for (const rank of Identity.registryFieldRanks(journal.title)) {
    assert.equal(rank.isOfficial, false);
    assert.equal(rank.source, 'openalex');
    assert.equal(rank.method, 'local-jif');
    const key = JSON.stringify([rank.level, rank.domain, rank.field, rank.subfield]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({title: journal.title, displayedJIF: Number(journal.impactFactor).toFixed(1), ...rank});
  }
}
function verifyMemberships(observed) {
  assert.deepEqual([...observed.keys()].sort(), [...expectedGroups.keys()].sort(), 'Missing or additional subject groups');
  for (const [key, expected] of expectedGroups) {
    const rows = observed.get(key);
    assert.deepEqual(rows.map(r => r.title).sort(), [...expected.keys()].sort(), 'Missing or additional journal membership: ' + key);
    for (const row of rows) assert.equal(row.displayedJIF, expected.get(row.title));
  }
}
verifyMemberships(groups);
const missingGroup = new Map(groups);
missingGroup.delete(JSON.stringify(['subfield', 'Health Sciences', 'Medicine', 'Oncology']));
assert.throws(() => verifyMemberships(missingGroup), 'Removing a whole real group must fail completeness validation');
const missingMember = new Map(groups), firstGroup = [...groups.keys()][0];
missingMember.set(firstGroup, groups.get(firstGroup).slice(1));
assert.throws(() => verifyMemberships(missingMember), 'Removing one real journal membership must fail');
function verifyGroup(rows) {
  assert.equal(new Set(rows.map(r => r.title)).size, rows.length);
  const expectedRanks = new Map([...new Set(rows.map(row => row.displayedJIF))]
    .map(value => [value, 1 + rows.filter(other => Number(other.displayedJIF) > Number(value)).length]));
  for (const row of rows) {
    // Count strictly higher displayed values independently of the implementation's running index.
    const expected = expectedRanks.get(row.displayedJIF);
    assert.equal(row.rank, expected);
    assert.equal(row.of, rows.length);
    assert.equal(row.quartile, Math.ceil(expected * 4 / rows.length));
    assert.equal(row.percentile, Math.max(1, Math.round(expected * 100 / rows.length)));
  }
}
let memberships = 0, tiedMemberships = 0;
for (const rows of groups.values()) {
  verifyGroup(rows);
  memberships += rows.length;
  const counts = new Map();
  for (const row of rows) counts.set(row.displayedJIF, (counts.get(row.displayedJIF) || 0) + 1);
  tiedMemberships += rows.filter(row => counts.get(row.displayedJIF) > 1).length;
}
assert.throws(() => verifyGroup([{title: 'bad control', displayedJIF: '4.7', rank: 2, of: 1, quartile: 1}]),
  'A known bad rank must be rejected by the independent invariant');
const workbench = read('zotero-style-custom/src/workbench.js');
const start = workbench.indexOf('  const journalView=');
const end = workbench.indexOf('  function drawJournals()', start);
assert.ok(start >= 0 && end > start);
const state = {};
let selectedProfile = null;
const runtime = {journalIdentity: Identity, Z: {Items: {get: () => ({})}},
  journalProfile: () => selectedProfile, journalRecord: () => ({name: '', issn: ''})};
const actual = new Function('state', 'runtime', workbench.slice(start, end) +
  '\nreturn {journalFacts, registryFacts, journalPathMatches, JOURNAL_LEVELS};')(state, runtime);
const predicate = workbench.match(/const matches=j=>([\s\S]*?);\n   const controls=/)?.[1];
assert.ok(predicate, 'Production filtering predicate not found');
const matches = new Function('j', 'pick', 'JOURNAL_LEVELS', 'journalPathMatches', `return (${predicate});`);
const filterCases = [
  {domain: 'Life Sciences', field: 'Biochemistry, Genetics and Molecular Biology', subfield: 'Genetics'},
  {domain: 'Health Sciences', field: 'Biochemistry, Genetics and Molecular Biology', subfield: 'Genetics'},
  {domain: 'Health Sciences', field: 'Medicine', subfield: 'Genetics'},
].map(pick => {
  const observed = journals.filter(row => matches(row, pick, actual.JOURNAL_LEVELS, actual.journalPathMatches));
  const expected = journals.filter(row => row.levels.some(p => Object.keys(pick).every(k => p[k] === pick[k])));
  assert.deepEqual(observed.map(r => r.title), expected.map(r => r.title));
  return {pick, matches: observed.length, crossPathFalsePositives: 0};
});
const old = JSON.parse(read('benchmark/jcr-classification-audit-2026-09-20/measurements.json'));
const cacheCases = old.productionRanks.cacheExamples.map(control => {
  // Retained audit metadata, not a claim of a new network query.
  selectedProfile = {topics: control.displayedLevels, profileAt: control.profileAt};
  const facts = actual.journalFacts(control.title, [{id: 1, impactFactor: 0.1, impactYear: 2000}]);
  assert.deepEqual(facts.levels, Identity.resolveLevels(control.title, null));
  assert.equal(new Set(facts.levels.map(p => JSON.stringify(p))).size, facts.levels.length);
  const registry = journals.find(row => row.title === control.title);
  assert.equal(facts.impact, registry.impactFactor, 'Displayed JIF must match the ranking corpus');
  assert.equal(facts.year, registry.year);
  return {title: control.title, displayedLevels: facts.levels, impact: facts.impact, year: facts.year,
    firstRank: facts.fieldRanks[0]};
});
const oncology = title => Identity.registryFieldRanks(title).find(r => r.level === 'subfield' && r.name === 'Oncology');
const result = {createdAt: new Date().toISOString(), journalCount: journals.length, groups: groups.size,
  expectedGroupsFromRaw: expectedGroups.size, expectedMembershipsFromRaw: [...expectedGroups.values()].reduce((n, members) => n + members.size, 0),
  membershipsChecked: memberships, tiedMembershipsChecked: tiedMemberships, rankInvariantFailures: 0,
  filterCases, cacheCases, oncologyTie: ['Medical Oncology', 'Oncologist'].map(title => ({title, ...oncology(title)})),
  sourceSHA256: Object.fromEntries(['zotero-style-custom/src/journal-identity.js',
    'zotero-style-custom/src/workbench.js', 'zotero-style-custom/data/journal-registry.json']
    .map(name => [name, crypto.createHash('sha256').update(read(name)).digest('hex')]))};
if (process.argv.includes('--write')) fs.writeFileSync(path.join(__dirname, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({journalCount: result.journalCount, groups: result.groups,
  membershipsChecked: memberships, rankInvariantFailures: 0, filters: filterCases.map(c => c.matches)}));
console.log('JCR_CLASSIFICATION_CORRECTIONS_VERIFIED');

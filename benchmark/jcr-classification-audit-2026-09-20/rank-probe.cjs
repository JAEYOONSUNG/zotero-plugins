// Read-only audit: execute the captured production module, never a rebuilt replica.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const snapshot = path.resolve(process.argv[2]);
const J = require(path.join(snapshot, 'zotero-style-custom/src/journal-identity.js'));
const raw = JSON.parse(fs.readFileSync(path.join(snapshot, 'zotero-style-custom/data/journal-registry.json')));
J.loadRegistry(structuredClone(raw));
const titles = ['Nature', 'Science', 'Lancet', 'Chemical Reviews', 'Annual Review of Biochemistry'];
const examples = titles.map(title => ({title, levels: J.registryLevels(title), ranks: J.registryFieldRanks(title)}));
const workbench = fs.readFileSync(path.join(snapshot, 'zotero-style-custom/src/workbench.js'), 'utf8');
const predicateBody = workbench.match(/const matches=j=>([\s\S]*?);\n   const controls=/)?.[1];
assert.ok(predicateBody, 'Captured production filtering predicate was not found');
const matches = new Function('j', 'pick', `return (${predicateBody});`);
const filterExamples = [
  {domain: 'Life Sciences', field: 'Biochemistry, Genetics and Molecular Biology', subfield: 'Genetics'},
  {domain: 'Health Sciences', field: 'Biochemistry, Genetics and Molecular Biology', subfield: 'Genetics'},
].map(pick => {
  const actual = J.registryRanked().filter(j => matches(j, pick));
  const coherent = j => j.levels.some(t => Object.entries(pick).every(([k, v]) => t[k] === v));
  const wrong = actual.filter(j => !coherent(j));
  return {pick, productionMatches: actual.length, fullTripleMatches: actual.filter(coherent).length,
    crossBranchMatches: wrong.length, examples: wrong.slice(0, 5).map(j => ({title: j.title, levels: j.levels}))};
});
const cacheProfiles = JSON.parse(fs.readFileSync(path.join(snapshot, 'cache-profiles.json')));
const factsBody = workbench.match(/function journalFacts\(venue,items\)\{([\s\S]*?)\n  \}\n  \/\* A journal/)?.[1];
assert.ok(factsBody, 'Captured production journalFacts was not found');
const cacheExamples = cacheProfiles.map(profile => {
  const runtime = {Z: {Items: {get: () => ({})}}, journalIdentity: J,
    journalProfile: () => profile, journalRecord: () => ({name: profile.name, issn: ''})};
  const facts = new Function('runtime', 'venue', 'items', factsBody)(runtime, profile.name, [{id: 1}]);
  return {title: profile.name, profileAt: profile.profileAt, registryLevels: J.registryLevels(profile.name),
    displayedLevels: facts.levels, detailFields: facts.fields, firstRank: facts.fieldRanks[0]};
});
const groups = new Map();
for (const row of J.registryRanked()) {
  for (const r of J.registryFieldRanks(row.title)) {
    const key = r.level + '\0' + r.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({title: row.title, impactFactor: row.impactFactor, ...r});
  }
}
const ties = [];
let equalValueAdjacentPairs = 0;
for (const list of groups.values()) {
  list.sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    if (a.impactFactor !== b.impactFactor) continue;
    equalValueAdjacentPairs++;
    if (a.quartile !== b.quartile) ties.push({a, b});
  }
}
// A small positive control isolates tie handling from taxonomy and coverage.
J.loadRegistry({subjects: ['Domain', 'Field', 'Subfield'], journals: Array.from({length: 8}, (_, i) => ({
  title: `Tie ${i + 1}`, abbreviation: '', issns: [], impactFactor: 10, levels: [[0, 1, 2]]
}))});
const control = Array.from({length: 8}, (_, i) => J.registryFieldRanks(`Tie ${i + 1}`)[0]);
assert.deepEqual(control.map(r => r.rank), [1, 2, 3, 4, 5, 6, 7, 8]);
assert.deepEqual(control.map(r => r.quartile), [1, 1, 2, 2, 3, 3, 4, 4]);
console.log(JSON.stringify({examples, filterExamples, cacheExamples, groups: groups.size, equalValueAdjacentPairs,
  equalValueQuartileBoundaryPairs: ties.length, boundaryExamples: ties.slice(0, 6), tieControl: control}));

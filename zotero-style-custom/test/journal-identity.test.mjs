import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const journals = require("../src/journal-identity.js");

test("a journal is identified by the publisher a reader would recognise", () => {
  // Every title below is one this library actually holds.
  const seen = title => {
    const id = journals.identify(title);
    return [id.mark, id.label];
  };
  assert.deepEqual(seen("Nature"), ["Nature", "Nature"]);
  assert.deepEqual(seen("Nature Communications"), ["Nat Commun", "Nature Portfolio"]);
  assert.deepEqual(seen("Science"), ["Science", "Science"]);
  assert.deepEqual(seen("Nucleic Acids Research"), ["Nucleic Acids Res", "Oxford"]);
  assert.deepEqual(seen("Cell"), ["Cell", "Cell Press"]);
  assert.deepEqual(seen("Applied and Environmental Microbiology"), ["Appl Environ Microbiol", "ASM"]);
  assert.deepEqual(seen("Frontiers in Microbiology"), ["Front Microbiol", "Frontiers"]);
  // Scientific Reports is Nature portfolio, and a reader knows it although the
  // name does not say so.
  assert.equal(journals.identify("Scientific Reports").label, "Nature Portfolio");
});

test("the more specific pattern is tested first, or every Nature title is just Nature", () => {
  assert.equal(journals.identify("Nature").family, "nature");
  assert.equal(journals.identify("Nature Microbiology").family, "nature-portfolio");
  assert.equal(journals.identify("Science").family, "science");
  // Both share the house hue: the family is what the colour says.
  assert.notEqual(journals.identify("Nature").hue, journals.identify("Nature Microbiology").hue, "a sister journal keeps its own cover colour");
});

test("a journal nobody curated still gets a mark and a colour of its own", () => {
  const odd = journals.identify("Journal of Thermophilic Enzyme Engineering");
  assert.equal(odd.known, false);
  assert.equal(odd.mark, "J Thermophilic Enzyme Eng", "the standard abbreviation, with unknown words kept whole");
  // Stable: the same title is always the same colour, so the column stays
  // coherent rather than arbitrary.
  assert.equal(odd.hue, journals.identify("Journal of Thermophilic Enzyme Engineering").hue);
  assert.notEqual(odd.hue, journals.identify("Some Other Title Entirely").hue);
});

test("a one-word title keeps a name, not two letters", () => {
  assert.equal(journals.monogram("Cell"), "Cell");
  assert.equal(journals.monogram("Extremophiles"), "Ext");
  assert.equal(journals.identify("Nature Protocols").mark, "Nat Protoc");
});

test("a curated family reads stronger than a derived one, in both schemes", () => {
  const parse = value => value.match(/hsl\((\d+) (\d+)% (\d+)%\)/).slice(1).map(Number);
  for (const dark of [false, true]) {
    const known = journals.colours(journals.identify("Nature Reviews Cancer"), {dark});
    const other = journals.colours(journals.identify("Journal of Unknown Things"), {dark});
    assert.ok(parse(known.ink)[1] > parse(other.ink)[1], `${dark ? "dark" : "light"}: a recognised publisher reads first`);
    // A fill is a tint under light ink and a shade under dark ink, and the ink
    // always has to stand off it.
    const [, , fillLight] = parse(known.fill);
    const [, , inkLight] = parse(known.ink);
    if (dark) { assert.ok(fillLight < 40); assert.ok(inkLight > fillLight + 30); }
    else { assert.ok(fillLight > 85); assert.ok(inkLight < fillLight - 30); }
  }
});

test("no title means no mark, rather than a mark for nothing", () => {
  assert.equal(journals.identify(""), null);
  assert.equal(journals.identify(null), null);
  assert.equal(journals.monogram(""), "?");
});

test("every Nature sister journal keeps its own cover colour", () => {
  const hue = title => journals.identify(title).hue;
  assert.notEqual(hue("Nature Biotechnology"), hue("Nature Methods"));
  assert.equal(journals.identify("Nature Communications").hex, "#e63323", "the rule under the nature.com header");
  assert.equal(journals.identify("Nature Biotechnology").hex, "#efd600", "Nature Biotechnology is yellow");
  assert.equal(journals.colours(journals.identify("Nature Biotechnology")).badge, "#efd600");
  assert.equal(journals.JOURNAL_HUES["molecular cell"], 200, "measured off the PDFs in the library");
  assert.equal(journals.identify("Nature Chemical Biology").hex, "#0094a4");
  assert.equal(journals.identify("Nature Medicine").hex, "#e40428");
  assert.equal(journals.identify("Nature Microbiology").hex, "#964091");
  assert.equal(journals.identify("Nature Something New").hue, 168, "an unlisted sister falls back to the house colour");
});

test("a journal no rule knows still gets its publisher's colour from the registry", () => {
  /* Measured over every JCR journal, the title rules alone reached 3%: 84
     exact colours, 559 by pattern, 21,951 left to a hue derived from the name.
     OpenAlex knows the publisher of nearly all of them by ISSN, and a journal
     nobody curated then gets the colour of the house that prints it. */
  const loaded = journals.loadRegistry({journals: [
    {title: "Journal of Obscure Thermophile Studies", issns: ["1234-5678"], abbreviation: "J OBSCURE THERMOPHILE STUD",
     impactFactor: 2.1, year: 2025, quartile: 3, publisher: "Elsevier BV"},
    {title: "Bulletin of Nowhere", issns: ["9999-0000"], abbreviation: "BULL NOWHERE",
     impactFactor: 0.4, year: 2025, quartile: 4, publisher: "Some Regional Society"},
    {title: "Bulletin of Nowhere Else", issns: ["9999-0001"], abbreviation: "BULL NOWHERE ELSE",
     impactFactor: 0.3, year: 2025, quartile: 4, publisher: ""}
  ]});
  assert.equal(loaded, 3);
  const known = journals.identify("Journal of Obscure Thermophile Studies");
  assert.equal(known.family, "elsevier");
  assert.equal(known.viaPublisher, true);
  assert.equal(known.known, true, "a publisher family is a known colour, not a derived one");
  assert.equal(known.quartile, 3, "and the registry's quartile rides along");
  assert.equal(known.abbreviation, "J OBSCURE THERMOPHILE STUD");
  // The JCR abbreviation is a key too, because a reference list writes it.
  assert.equal(journals.identify("J OBSCURE THERMOPHILE STUD").family, "elsevier");
  assert.equal(journals.registryByIssn("1234-5678").publisher, "Elsevier BV");

  /* A publisher nobody listed still gets a family of its own, keyed on its
     name, so every journal of that house shares one colour -- which is what a
     publisher colour is for. Measured on the full JCR list this took the
     journals left to a title-derived hue from 97% to 10%, and every one of
     that 10% is a journal OpenAlex has no publisher for at all. */
  const odd = journals.identify("Bulletin of Nowhere");
  assert.equal(odd.known, true);
  assert.equal(odd.viaPublisher, true);
  assert.match(odd.family, /^pub:some-regional-society/);
  assert.equal(odd.label, "Some Regional Society", "the house's own name is the label");
  assert.equal(odd.hue, journals.identify("Bulletin of Nowhere").hue, "and the hue is stable");
  // Only a journal with no publisher at all falls back to a hue from its title.
  const none = journals.identify("Bulletin of Nowhere Else");
  assert.equal(none.known, false);
  assert.equal(none.family, "other");

  // An exact brand colour still outranks a publisher family.
  assert.equal(journals.identify("Nature").family, "nature");

  // Unloaded, everything falls back to the old behaviour rather than failing.
  journals.loadRegistry([]);
  assert.equal(journals.identify("Journal of Obscure Thermophile Studies").known, false);
  assert.equal(journals._registrySize(), 0);
});

test('a journal named by a title rule still carries the registry\'s quartile and abbreviation', () => {
  journals.loadRegistry({journals: [{title: 'Nature', issns: ['0028-0836'], abbreviation: 'NATURE', impactFactor: 56.1, year: 2025, quartile: 1, publisher: 'Nature Portfolio'}]});
  const id = journals.identify('Nature');
  assert.equal(id.family !== 'other' || id.exact, true, 'Nature is named by a rule or a measured colour');
  assert.deepEqual({quartile: id.quartile, abbreviation: id.abbreviation, impactFactor: id.impactFactor}, {quartile: 1, abbreviation: 'NATURE', impactFactor: 56.1});
});

test('the registry can be read in one order, JIF first, with the place of each journal in it', () => {
  journals.loadRegistry({journals: [
    {title: 'Cell', issns: ['0092-8674'], abbreviation: 'CELL', impactFactor: 42.5, year: 2025, quartile: 1, publisher: 'Cell Press'},
    {title: 'Nature', issns: ['0028-0836'], abbreviation: 'NATURE', impactFactor: 50.5, year: 2025, quartile: 1, publisher: 'Nature Portfolio'},
    {title: 'Obscure Letters', issns: [], abbreviation: 'OBSC LETT', impactFactor: 0.4, year: 2025, quartile: 4, publisher: ''}]});
  const ranked = journals.registryRanked();
  assert.deepEqual(ranked.map(r => [r.rank, r.title]), [[1, 'Nature'], [2, 'Cell'], [3, 'Obscure Letters']]);
  assert.equal(journals.registryRank('cell'), 2, 'looked up by the same flattened title the rules use');
  assert.equal(journals.registryRank('Nowhere Journal'), null);
  assert.equal(journals.registryRanked(), ranked, 'built once');
});

test('the registry carries each journal’s subjects, packed against one table of names', () => {
  /* The journals tab could group by subject only for journals the library held
     and had an OpenAlex profile for: 206 of 22,594. The registry now ships the
     subject of every journal, as indexes into one shared table of names. */
  journals.loadRegistry({
    subjects: ['Life Sciences', 'Biochemistry, Genetics and Molecular Biology', 'Molecular Biology', 'Cell Biology'],
    journals: [
      {title: 'Cell', issns: ['0092-8674'], impactFactor: 45.5, levels: [[0, 1, 2], [0, 1, 3]]},
      {title: 'Some Bulletin', issns: ['1111-2222'], impactFactor: 0.4}
    ]
  });
  const cell = journals.registryLevels('Cell');
  assert.equal(cell.length, 2, 'both subjects survive the unpacking');
  assert.deepEqual(cell[0], {domain: 'Life Sciences', field: 'Biochemistry, Genetics and Molecular Biology', subfield: 'Molecular Biology'});
  assert.equal(cell[1].subfield, 'Cell Biology');
  assert.deepEqual(journals.registryLevels('Some Bulletin'), [], 'a journal OpenAlex has no topics for stays empty');
  assert.deepEqual(journals.registryLevels('Not A Journal'), [], 'and so does one that is not in the registry');
  // The ranked view carries them too, because that is what the tab reads.
  const ranked = journals.registryRanked();
  assert.equal(ranked[0].title, 'Cell');
  assert.equal(ranked[0].levels[0].domain, 'Life Sciences');
});

test('local JIF comparisons preserve subject order without claiming official JCR category ranks', () => {
  journals.loadRegistry({
    subjects: ['Life Sciences', 'Biochemistry, Genetics and Molecular Biology', 'Molecular Biology', 'Cell Biology', 'Physical Sciences', 'Chemistry', 'Organic Chemistry'],
    journals: [
      {title: 'Top Review', impactFactor: 60, levels: [[0, 1, 2]]},
      {title: 'Cell', impactFactor: 45.5, levels: [[0, 1, 2], [0, 1, 3]]},
      {title: 'Mol Cell', impactFactor: 14.5, levels: [[0, 1, 2]]},
      {title: 'J Cell Biol', impactFactor: 7.4, levels: [[0, 1, 3]]},
      {title: 'Chem Rev', impactFactor: 51, levels: [[4, 5, 6]]},
      {title: 'No Figure', levels: [[0, 1, 2]]}
    ]
  });
  const cell = journals.registryFieldRanks('Cell');
  // The narrower name first, and in the order the journal's own subjects run.
  assert.deepEqual(cell.map(r => [r.level, r.name, r.rank, r.of]), [
    ['subfield', 'Molecular Biology', 2, 3],
    ['field', 'Biochemistry, Genetics and Molecular Biology', 2, 4],
    ['subfield', 'Cell Biology', 1, 2]
  ]);
  assert.equal(cell[0].quartile, 3, 'second of three is the third quarter');
  assert.equal(journals.registryFieldRanks('Chem Rev')[0].name, 'Organic Chemistry');
  assert.equal(journals.registryFieldRanks('Chem Rev')[0].of, 1, 'a subject of one still places its journal');
  // A journal with no figure cannot be ordered among journals ordered by figure.
  assert.deepEqual(journals.registryFieldRanks('No Figure'), []);
  assert.equal(journals.registryFieldRanks('Mol Cell')[0].of, 3, 'and it is not counted in anyone else’s total');
  assert.deepEqual(journals.registryFieldRanks('Not A Journal'), []);
  // Built once and kept, because it walks every row in the registry.
  assert.equal(journals.registryFieldRanks('Cell'), cell);
  for (const rank of cell) {
    assert.equal(rank.source, 'openalex');
    assert.equal(rank.method, 'local-jif');
    assert.equal(rank.isOfficial, false);
    assert.equal(rank.domain, 'Life Sciences');
    assert.equal(rank.field, 'Biochemistry, Genetics and Molecular Biology');
    assert.ok(rank.pathKey.includes(rank.domain));
  }
});

test('same-named subjects retain complete parent identity in field and subfield ranks', () => {
  const life = {domain: 'Life Sciences', field: 'Shared field', subfield: 'Genetics'};
  const health = {domain: 'Health Sciences', field: 'Shared field', subfield: 'Genetics'};
  journals.loadRegistry({journals: [
    {title: 'Life leader', impactFactor: 10, levels: [life]},
    {title: 'Health leader', impactFactor: 9, levels: [health]},
    {title: 'Shared journal', impactFactor: 5, levels: [life, {...life}, health]}
  ]});
  const lifeRanks = journals.registryFieldRanks('Life leader'), healthRanks = journals.registryFieldRanks('Health leader');
  assert.equal(lifeRanks[0].of, 2); assert.equal(healthRanks[0].of, 2);
  assert.notEqual(lifeRanks[0].pathKey, healthRanks[0].pathKey);
  assert.notEqual(lifeRanks[1].pathKey, healthRanks[1].pathKey);
  assert.equal(lifeRanks[1].subfield, '', 'a field rank represents the full parent field, not one child');
  const shared = journals.registryFieldRanks('Shared journal');
  assert.equal(shared.length, 4, 'two parent paths remain separate, repeated identical paths do not double count');
  assert.deepEqual(shared.map(rank => [rank.domain, rank.level, rank.rank, rank.of]), [
    ['Life Sciences', 'subfield', 2, 2], ['Life Sciences', 'field', 2, 2],
    ['Health Sciences', 'subfield', 2, 2], ['Health Sciences', 'field', 2, 2]
  ]);
});

test('equal displayed JIF values receive shared competition ranks, percentiles and quartiles', () => {
  const levels = [{domain: 'Health Sciences', field: 'Medicine', subfield: 'Oncology'}];
  const entries = [
    {title: 'A', impactFactor: 10.04}, {title: 'B', impactFactor: 10.03},
    {title: 'C', impactFactor: 9.80}, {title: 'D', impactFactor: 9.75},
    {title: 'No value', impactFactor: null}, {title: 'Blank value', impactFactor: ''},
    {title: 'Invalid boolean', impactFactor: false}, {title: 'Invalid negative', impactFactor: -1}
  ].map(row => ({...row, levels}));
  journals.loadRegistry({journals: entries});
  const ranks = ['A', 'B', 'C', 'D'].map(title => journals.registryFieldRanks(title)[0]);
  assert.deepEqual(ranks.map(row => row.rank), [1, 1, 3, 3]);
  assert.deepEqual(ranks.map(row => row.quartile), [1, 1, 3, 3]);
  assert.deepEqual(ranks.map(row => row.percentile), [25, 25, 75, 75]);
  assert.ok(ranks.every(row => row.of === 4));
  for (const row of entries.slice(4)) assert.deepEqual(journals.registryFieldRanks(row.title), []);
  // The rendered decimal string is the tie criterion, including JS toFixed rounding.
  journals.loadRegistry({journals: [{title: 'Round A', impactFactor: 1.15, levels}, {title: 'Round B', impactFactor: 1.14, levels}]});
  assert.equal((1.15).toFixed(1), (1.14).toFixed(1));
  assert.equal(journals.registryFieldRanks('Round A')[0].rank, journals.registryFieldRanks('Round B')[0].rank);
});

test('local percentile rounds the exact 23-of-40 midpoint upward', () => {
  const levels = [{domain: 'Domain', field: 'Field', subfield: 'Subfield'}];
  journals.loadRegistry({journals: Array.from({length: 40}, (_, index) => ({title: 'Journal ' + (index + 1), impactFactor: 40 - index, levels}))});
  const ranks = journals.registryFieldRanks('Journal 23');
  assert.ok(ranks.every(rank => rank.rank === 23 && rank.of === 40));
  assert.ok(ranks.every(rank => rank.percentile === 58), '57.5 rounds to 58; divide-first binary floating point must not yield 57');
});

test('canonical level resolution preserves registry paths and uses all complete cached topics only as fallback', () => {
  const first = {domain: 'Life Sciences', field: 'Biology', subfield: 'Molecular Biology'};
  const second = {domain: 'Life Sciences', field: 'Biology', subfield: 'Biophysics'};
  const incomplete = {domain: 'Life Sciences', field: 'Biology', subfield: ''};
  const profile = {topics: [second, second, {domain: 'Physical Sciences', field: 'Chemistry', subfield: 'Spectroscopy'},
    {domain: 'Life Sciences', field: 'Biology', subfield: 'Structural Biology'}, first, incomplete]};
  journals.loadRegistry({journals: [{title: 'Known journal', levels: [first, first, incomplete]}, {title: 'Unknown subjects', levels: []}]});
  const before = JSON.stringify(profile);
  assert.deepEqual(journals.resolveLevels('Known journal', profile), [first]);
  const fallback = journals.resolveLevels('Unknown subjects', profile);
  assert.deepEqual(fallback.map(path => path.subfield), ['Biophysics', 'Spectroscopy', 'Structural Biology', 'Molecular Biology']);
  assert.deepEqual(journals.resolveLevels('Unlisted journal', profile), fallback);
  assert.deepEqual(journals.resolveLevels('Unlisted journal', {topics: [incomplete, null, {domain: {}, field: 'Biology', subfield: 'Cell Biology'}]}), []);
  const resolved = journals.resolveLevels('Known journal', profile); resolved[0].field = 'changed';
  assert.equal(journals.registryLevels('Known journal')[0].field, 'Biology');
  assert.equal(JSON.stringify(profile), before);
});

test('registry revision changes on reload and invalidates previous rank caches', () => {
  const before = journals.registryRevision();
  const row = {title: 'Revision journal', impactFactor: 1, levels: [{domain: 'Domain', field: 'Field', subfield: 'Subfield'}]};
  journals.loadRegistry({journals: [row]});
  assert.equal(journals.registryRevision(), before + 1);
  const old = journals.registryFieldRanks(row.title);
  journals.resolveLevels(row.title, {}); journals.registryRanked();
  assert.equal(journals.registryRevision(), before + 1, 'reads do not invalidate caches');
  journals.loadRegistry({journals: []});
  assert.equal(journals.registryRevision(), before + 2);
  assert.deepEqual(journals.registryFieldRanks(row.title), []);
  assert.notEqual(journals.registryFieldRanks(row.title), old);
});

/* Counterexamples out of the shipped registry. The licensed export is not in
   the repository any more, so these are the rows that carry the same shapes in
   the openly licensed build: Genetics really does sit under two different
   fields, and two journals really do land on the same figure. */
test('shipped registry counterexamples keep Genetics parents separate, ties equal and classifications stable', () => {
  const payload = JSON.parse(readFileSync(new URL('../data/journal-registry.open.json', import.meta.url), 'utf8'));
  journals.loadRegistry(payload);
  const all = journals.registryRanked();
  const geneticPaths = [
    {domain: 'Life Sciences', field: 'Biochemistry, Genetics and Molecular Biology', subfield: 'Genetics'},
    {domain: 'Health Sciences', field: 'Medicine', subfield: 'Genetics'}
  ];
  const keys = [];
  for (const path of geneticPaths) {
    const members = all.filter(row => row.impactFactor != null && row.levels.some(level => Object.keys(path).every(key => level[key] === path[key])));
    assert.ok(members.length > 0);
    const rank = journals.registryFieldRanks(members[0].title).find(rank => rank.level === 'subfield'
      && Object.keys(path).every(key => rank[key] === path[key]));
    assert.equal(rank.of, members.length, 'group denominator is independently counted from the complete path');
    keys.push(rank.pathKey);
  }
  assert.notEqual(keys[0], keys[1]);
  // Two journals on the same figure in the same subfield rank identically.
  const oncology = title => journals.registryFieldRanks(title).find(rank => rank.level === 'subfield' && rank.name === 'Oncology');
  const tied = ['Journal of NeuroVirology', 'Biomarkers in Medicine'].map(title => all.find(row => row.title === title));
  assert.ok(tied.every(Boolean), 'both tied journals are in the registry');
  assert.equal(tied[0].impactFactor, tied[1].impactFactor, 'the tie this case is about');
  const [first, second] = tied.map(row => oncology(row.title));
  assert.deepEqual([first.rank, first.of, first.quartile, first.percentile],
    [second.rank, second.of, second.quartile, second.percentile]);
  /* A journal's canonical path does not move because a profile was handed in
     alongside it: the registry row decides. */
  const stable = all.find(row => row.levels.length > 1);
  const profile = {topics: [{domain: 'Life Sciences', field: 'Biochemistry, Genetics and Molecular Biology', subfield: 'Biophysics'},
    {domain: 'Life Sciences', field: 'Biochemistry, Genetics and Molecular Biology', subfield: 'Biophysics'}]};
  const canonical = journals.resolveLevels(stable.title, profile);
  assert.deepEqual(canonical, journals.resolveLevels(stable.title, null));
  assert.equal(canonical.length, stable.levels.length);
  for (const level of stable.levels) assert.ok(canonical.some(path => path.subfield === level.subfield), level.subfield);
});

/* Two journals whose names reduce to the same normalized string but are not
   the same journal. A collision used to hand one of them the other's
   memberships and ranks. Both pairs are real rows in the shipped registry. */
test('shipped journals with colliding normalized titles retain distinct metrics and rank identities', () => {
  const payload = JSON.parse(readFileSync(new URL('../data/journal-registry.open.json', import.meta.url), 'utf8'));
  journals.loadRegistry(payload);
  const all = journals.registryRanked();
  assert.equal(new Set(all.map(row => row.key)).size, all.length);
  for (const titles of [['Modern Philology', 'Modern philology.'],
    ['Journal of Religion & Film', 'Journal of Religion and Film']]) {
    const rows = titles.map(title => all.find(row => row.title === title));
    assert.ok(rows.every(Boolean));
    assert.notEqual(rows[0].key, rows[1].key);
    assert.notEqual(rows[0].impactFactor, rows[1].impactFactor);
    for (const row of rows) {
      assert.equal(journals.registryLookup(row.title).impactFactor, row.impactFactor);
      assert.equal(journals.identify(row.title).impactFactor, row.impactFactor);
      assert.equal(journals.registryRank(row.title), row.rank);
      assert.deepEqual(journals.registryLevels(row.title), row.levels);
      for (const issn of row.issns) assert.equal(journals.registryByIssn(issn.replace('-', '')).title, row.title);
    }
  }
  // Neither spelling is either journal's own title, but both reduce to the
  // shared normalized key, so the registry has to answer with nothing.
  for (const ambiguous of ['Modern-Philology', 'Journal-of-Religion-and-Film']) {
    assert.equal(journals.registryLookup(ambiguous), null);
    assert.equal(journals.registryRank(ambiguous), null);
    assert.deepEqual(journals.registryLevels(ambiguous), []);
    assert.deepEqual(journals.registryFieldRanks(ambiguous), []);
    assert.equal(journals.identify(ambiguous).impactFactor, null);
  }
  /* Independently aggregate every returned row identity. A normalized-title
     collision previously duplicated another journal's memberships and ranks.

     Two journals whose names reduce to the same string cannot be reached
     through a title lookup at all, because registryLookup answers null for
     both by design. So the walk covers the rows it can reach, and the
     denominator is counted separately, off the level paths every row carries,
     which needs no lookup. */
  const pathKeysOf = row => {
    const keys = new Set();
    for (const level of row.levels) {
      const path = ['domain', 'field', 'subfield'].map(key => typeof level?.[key] === 'string' ? level[key].trim() : '');
      if (!path.every(Boolean)) continue;
      keys.add(JSON.stringify(['subfield', ...path]));
      keys.add(JSON.stringify(['field', path[0], path[1]]));
    }
    return keys;
  };
  const sizes = new Map();
  for (const row of all) {
    if (!Number.isFinite(Number(row.impactFactor)) || Number(row.impactFactor) < 0) continue;
    for (const key of pathKeysOf(row)) sizes.set(key, (sizes.get(key) || 0) + 1);
  }
  // registryRanked hands back decorated copies, so a row is "reachable" when
  // its own printed name resolves back to a row that is unmistakably it.
  const reachable = row => {
    const found = journals.registryLookup(row.title);
    return !!found && found.title === row.title && found.impactFactor === row.impactFactor;
  };
  const groups = new Map();
  for (const row of all) {
    if (!reachable(row)) continue;
    for (const rank of journals.registryFieldRanks(row.title)) {
      const list = groups.get(rank.pathKey) || [];
      list.push({key: row.key, jif: row.impactFactor.toFixed(1), ...rank});
      groups.set(rank.pathKey, list);
    }
  }
  assert.ok(groups.size > 100, 'the whole subject tree, not a corner of it');
  for (const [pathKey, members] of groups) {
    assert.equal(new Set(members.map(row => row.key)).size, members.length);
    assert.ok(members.every(row => row.of === sizes.get(pathKey)), pathKey);
    // Members arrive in figure order, so a rank never goes backwards and two
    // journals showing the same figure share one rank.
    let previous = null, previousRank = 0;
    for (const row of members) {
      assert.ok(row.rank >= 1 && row.rank <= row.of, row.key);
      if (previous !== null) {
        if (row.jif === previous) assert.equal(row.rank, previousRank, 'a tie shares its rank: ' + row.key);
        else assert.ok(row.rank > previousRank, 'a lower figure ranks lower: ' + row.key);
      }
      previous = row.jif;
      previousRank = row.rank;
    }
  }
});

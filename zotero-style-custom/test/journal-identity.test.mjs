import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
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

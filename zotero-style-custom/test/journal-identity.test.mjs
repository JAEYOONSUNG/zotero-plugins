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
    const known = journals.colours(journals.identify("Nature"), {dark});
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
  assert.equal(hue("Nature Communications"), 30, "Nature Communications is orange");
  assert.equal(hue("Nature Biotechnology"), 50, "Nature Biotechnology is yellow");
  assert.equal(journals.JOURNAL_HUES["molecular cell"], 200, "measured off the PDFs in the library");
  assert.equal(hue("Nature Chemical Biology"), 190);
  assert.equal(hue("Nature Medicine"), 5);
  assert.equal(journals.identify("Nature Microbiology").hue, 200);
  assert.equal(journals.identify("Nature Something New").hue, 168, "an unlisted sister falls back to the house colour");
});

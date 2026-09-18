import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const icons = require("../src/brand-icons.js");

test("every source this plugin can search has a mark", () => {
  // The ones that carry a real brand mark, from Academicons.
  for (const key of ["crossref", "pubmed", "arxiv", "biorxiv", "semanticscholar", "osf", "ssrn"]) {
    const drawn = icons.shape(icons.iconFor(key));
    assert.ok(drawn, key + " has no mark");
    assert.equal(drawn.kind, "fill", key + " should be the real brand mark");
    assert.ok(drawn.parts.length && drawn.parts[0][1].d.length > 100, key + " path looks empty");
  }
  // The ones Academicons does not cover, drawn here rather than imitated.
  for (const key of ["openalex", "europepmc", "medrxiv", "chemrxiv", "lens", "harzing"]) {
    const drawn = icons.shape(icons.iconFor(key));
    assert.ok(drawn, key + " has no mark");
    assert.equal(drawn.kind, "stroke", key + " should be one of our own glyphs");
  }
});

test("a mark keeps its own aspect, because these come from a font", () => {
  // Forcing a 320x512 glyph into a square box would squash every non-square
  // mark. Each one carries the viewBox it was drawn in.
  const boxes = new Set(["crossref", "pubmed", "arxiv", "osf"].map(k => icons.shape(icons.iconFor(k)).viewBox));
  assert.ok(boxes.size > 1, "all the brand marks ended up with the same viewBox: " + [...boxes]);
  for (const box of boxes) assert.match(box, /^0 0 \d+ \d+$/);
});

test("the multi-source and preprint searches get a mark too, not a blank", () => {
  assert.ok(icons.shape(icons.iconFor("multi")));
  assert.ok(icons.shape(icons.iconFor("preprint")));
});

test("a source nobody has a mark for returns nothing rather than a wrong logo", () => {
  assert.equal(icons.iconFor("some-service-we-never-heard-of"), "");
  assert.equal(icons.shape(""), null);
  assert.equal(icons.shape("nonsense"), null);
  assert.equal(icons.iconFor(null), "");
});

test("source keys are matched however they are spelled", () => {
  assert.equal(icons.iconFor("EuropePMC"), "europepmc");
  assert.equal(icons.iconFor("semantic-scholar"), "semantic-scholar");
  assert.equal(icons.iconFor("SemanticScholar"), "semantic-scholar");
  assert.equal(icons.iconFor("bioRxiv"), "biorxiv");
});

test("the licence that lets these ship is in the package", async () => {
  const fs = await import("node:fs");
  const text = fs.readFileSync(new URL("../LICENSES.md", import.meta.url), "utf8");
  assert.match(text, /Academicons/);
  assert.match(text, /SIL OPEN FONT LICENSE/i);
  assert.match(text, /James Walsh/);
  // The drawn glyphs must stay separated from the licensed ones in the notice.
  assert.match(text, /OpenAlex, Europe PMC, medRxiv, ChemRxiv/);
});

test("both plugins ship the same marks, so a source never looks different in one", async () => {
  // The module is copied rather than shared: two plugins, two .xpi files. A
  // silent drift between them is exactly what nobody would notice.
  const fs = await import("node:fs");
  const mine = fs.readFileSync(new URL("../src/brand-icons.js", import.meta.url), "utf8");
  const theirs = fs.readFileSync(new URL("../../content/brand-icons.js", import.meta.url), "utf8");
  const strip = text => text.replace(/\n\s*root\.ZotPoPBrandIcons = api;/, "");
  assert.equal(strip(theirs), strip(mine), "the two copies of brand-icons.js have drifted apart");
});

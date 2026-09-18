import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const affiliations = require("../src/affiliations.js");

const person = (name, position, extra = {}) =>
  ({name, position, ror: "", country: "", institution: "", corresponding: false, ...extra});

test("the two authorships that matter are the first and the corresponding one", () => {
  // A consortium paper has hundreds, and they are rarely the same person.
  const picked = affiliations.principals([
    person("First Author", "first"),
    person("Middle One", "middle"),
    person("Middle Two", "middle"),
    person("Senior Author", "last", {corresponding: true})
  ]);
  assert.equal(picked.first.name, "First Author");
  assert.equal(picked.corresponding.name, "Senior Author");
  assert.equal(picked.correspondingKnown, true);
});

test("when nobody is flagged corresponding the last author is used, and that is said", () => {
  // Older records carry no is_corresponding at all, and guessing silently is
  // what turns a convention into a claim.
  const picked = affiliations.principals([person("First", "first"), person("Last", "last")]);
  assert.equal(picked.corresponding.name, "Last");
  assert.equal(picked.correspondingKnown, false, "the row can say the rule was a convention");
});

test("a sole author is not also reported as their own corresponding author", () => {
  const picked = affiliations.principals([person("Only", "first", {corresponding: true})]);
  assert.equal(picked.first.name, "Only");
  assert.equal(picked.corresponding, null);
});

test("standing is read off the institution's own figure, not off a list of famous names", () => {
  // A hand-written list of universities is an opinion wearing a badge. The
  // h-index of an institution's whole corpus is the same number for everybody.
  assert.equal(affiliations.tierOf(2281).key, "t1", "MIT");
  assert.equal(affiliations.tierOf(1500).key, "t2");
  assert.equal(affiliations.tierOf(860).key, "t3");
  assert.equal(affiliations.tierOf(120).key, "t4");
  // The first attempt at these cut points put 39% of the 510 institutions
  // behind this library in the top bucket, which is a label that says nothing.
  /* Calibrated twice, because the first calibration measured the wrong thing.
     Counting institutions, 61% of the 510 behind this library are above 400;
     but a badge is worn by a paper, and papers pile up at the big places, so
     paper-weighted that threshold marked 77% of rows. A mark on three rows in
     four is not a mark, it is a texture. */
  assert.ok(affiliations.TIERS[0].floor >= 2000);
  // Four buckets, four plain codes: the user asked for every row to carry one,
  // and for none of them to be a Korean word that reads as a verdict.
  assert.equal(affiliations.tierOf(860).label, "T3");
  assert.deepEqual(affiliations.TIERS.map(tier => tier.label), ["T1", "T2", "T3", "T4"]);
  assert.equal(affiliations.tierOf(0), null, "no figure is not a low figure");
  assert.equal(affiliations.tierOf(null), null);
  // And every label says what the number is rather than implying a ranking.
  for (const tier of affiliations.TIERS) {
    if (!tier.note) continue;
    assert.match(tier.note, /h-index/);
  }
});

test("a paper's provenance reads as two people, two labs and two countries", () => {
  const summary = affiliations.summarise([
    person("Jae Yoon Sung", "first", {ror: "R1", country: "KR", institution: "Yonsei"}),
    person("Senior", "last", {ror: "R2", country: "US", institution: "MIT", corresponding: true})
  ], {R1: {name: "Yonsei University", hIndex: 1500}, R2: {name: "MIT", hIndex: 2281}});
  assert.equal(summary.first.institution, "Yonsei University", "the looked-up name wins over the inline one");
  assert.equal(summary.first.tier.key, "t2");
  assert.equal(summary.corresponding.tier.key, "t1");
  assert.equal(summary.tier.key, "t1", "the stronger of the two stands for the paper");
  assert.deepEqual(summary.countries, ["KR", "US"]);
  assert.equal(summary.international, true, "the two ends of the paper are in different countries");
});

test("a flag is two code points away, so no image is shipped or fetched", () => {
  assert.equal(affiliations.flag("KR"), "\u{1F1F0}\u{1F1F7}");
  assert.equal(affiliations.flag("us"), "\u{1F1FA}\u{1F1F8}");
  assert.equal(affiliations.flag("XXX"), "");
  assert.equal(affiliations.flag(""), "");
});

test("an institution nobody has looked up yet costs its name, not a wrong tier", () => {
  const summary = affiliations.summarise([
    person("A", "first", {ror: "R9", country: "DE", institution: "Max Planck Institute"})
  ], {});
  assert.equal(summary.first.institution, "Max Planck Institute");
  assert.equal(summary.first.hIndex, null);
  assert.equal(summary.first.tier, null, "unknown standing is shown as unknown");
});

test("the sweep asks about each institution once, not once per paper", () => {
  const works = [
    {people: [person("A", "first", {ror: "R1"}), person("B", "last", {ror: "R2", corresponding: true})]},
    {people: [person("C", "first", {ror: "R1"}), person("D", "last", {ror: "R3", corresponding: true})]},
    {people: [person("E", "first", {ror: ""})]}
  ];
  assert.deepEqual(affiliations.institutionsNeeded(works).sort(), ["R1", "R2", "R3"]);
  assert.deepEqual(affiliations.institutionsNeeded(works, {R1: {hIndex: 1}}).sort(), ["R2", "R3"]);
});

test("no authors means no claim about where the paper came from", () => {
  assert.equal(affiliations.summarise([]), null);
  assert.equal(affiliations.summarise(null), null);
  assert.equal(affiliations.principals([{name: ""}]), null);
});

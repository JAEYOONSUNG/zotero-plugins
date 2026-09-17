import test from "node:test";
import assert from "node:assert/strict";
import metrics from "../src/journal-metrics.js";

const source = (name, over = {}) => ({
  id: "https://openalex.org/S1", display_name: name, issn_l: "1476-4687",
  type: "journal", works_count: 100, summary_stats: {"2yr_mean_citedness": 12.3456, h_index: 400}, ...over
});

test("an ISSN names one journal, so it is used in preference to the title", () => {
  const url = metrics.lookupURL({name: "Nature", issn: "1476-4687"});
  assert.match(url, /filter=issn%3A1476-4687/);
  assert.doesNotMatch(url, /display_name\.search/);
  // Hyphens and case in a recorded ISSN should not change the lookup.
  assert.equal(metrics.lookupURL({issn: "14764687"}), url);
  assert.match(metrics.lookupURL({name: "Molecular Cell"}), /display_name\.search/);
  assert.equal(metrics.lookupURL({}), null);
});

test("a near-miss from the title search is refused; only an exact journal counts", () => {
  const payload = {results: [source("Nature Reviews Microbiology", {issn_l: "1740-1534"}), source("Nature")]};
  // "Nature" also returns "Nature Reviews ...", and taking the first hit would
  // have put a review journal's figure on every Nature paper.
  assert.equal(metrics.pickSource(payload, {name: "Nature"}).name, "Nature");
  assert.equal(metrics.pickSource(payload, {name: "Nature Genetics"}), null);
  assert.equal(metrics.pickSource({results: []}, {name: "Nature"}), null);
  assert.equal(metrics.pickSource(null, {name: "Nature"}), null);
});

test("an ISSN match wins even when the titles disagree", () => {
  const renamed = {results: [source("Nature (London)", {issn_l: "1476-4687"})]};
  assert.equal(metrics.pickSource(renamed, {name: "Nature", issn: "1476-4687"}).issn, "14764687");
});

test("the figure is rounded, because the extra digits are false precision", () => {
  assert.equal(metrics.shapeSource(source("Nature")).citedness, 12.3);
  assert.equal(metrics.shapeSource(source("X", {summary_stats: {}})).citedness, null);
  assert.equal(metrics.shapeSource(source("X", {summary_stats: {"2yr_mean_citedness": -1}})).citedness, null);
  assert.equal(metrics.shapeSource(null), null);
});

test("journals that are written differently share one cache entry", () => {
  const same = ["Journal of Bacteriology", "The Journal of  Bacteriology", "JOURNAL OF BACTERIOLOGY"];
  const keys = new Set(same.map(name => metrics.cacheKey({name})));
  assert.equal(keys.size, 1, `1,116 items share 255 journals; caching per journal is the point: ${[...keys]}`);
  assert.equal(metrics.cacheKey({name: "Molecular & Cellular Biology"}), metrics.cacheKey({name: "Molecular and Cellular Biology"}));
  // An ISSN is a stronger identity than a name and keys separately.
  assert.match(metrics.cacheKey({name: "Nature", issn: "1476-4687"}), /^issn:/);
});

test("an alternate title still identifies the journal", () => {
  const payload = {results: [source("Proceedings of the National Academy of Sciences", {alternate_titles: ["PNAS"]})]};
  assert.ok(metrics.pickSource(payload, {name: "PNAS"}));
});

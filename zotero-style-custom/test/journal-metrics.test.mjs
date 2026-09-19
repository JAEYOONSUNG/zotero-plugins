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

test("Zotero records both ISSNs in one field, and that must still be an ISSN lookup", () => {
  // Taken from this library: 252 of its 255 journals carry an ISSN, and many
  // hold the print and electronic number together. Stripping punctuation across
  // the whole string gave a sixteen-digit non-ISSN, so every one of these fell
  // through to a title search -- ten times the cost, and a worse match.
  assert.equal(metrics.cleanISSN("0304-8608, 1432-8798"), "03048608");
  assert.equal(metrics.cleanISSN("2041-6520, 2041-6539"), "20416520");
  assert.equal(metrics.cleanISSN("1741-0126,1741-0134"), "17410126");
  assert.equal(metrics.cleanISSN("1940-087X"), "1940087X");
  assert.equal(metrics.cleanISSN("00222836"), "00222836");
  assert.equal(metrics.cleanISSN("not an issn"), "");
  assert.match(metrics.lookupURL({name: "Archives of Virology", issn: "0304-8608, 1432-8798"}),
    /filter=issn%3A0304-8608/);
});

test("a journal found by its print ISSN is accepted when OpenAlex links the electronic one", () => {
  // issn_l is only one of a journal's numbers. Matching on it alone rejected
  // the very source the ISSN filter had just returned.
  const payload = {results: [source("Chemical Science",
    {issn_l: "2041-6539", issn: ["2041-6520", "2041-6539"]})]};
  assert.ok(metrics.pickSource(payload, {name: "Chemical Science", issn: "2041-6520, 2041-6539"}));
});

test("a source carries its profile: publisher, country, access, fee, and the fields its topics fall in", () => {
  const shaped = metrics.shapeSource(source("Bioresource Technology", {
    host_organization_name: "Elsevier BV", country_code: "gb", homepage_url: "http://journals.elsevier.com/x", is_oa: false, is_in_doaj: false, apc_usd: 4880,
    cited_by_count: 2542085,
    topics: [{display_name: "Biofuel production", field: {display_name: "Engineering"}, count: 7794},
      {display_name: "Wastewater", field: {display_name: "Environmental Science"}, count: 6239},
      {display_name: "Anaerobic digestion", field: {display_name: "Engineering"}, count: 5132}]
  }));
  assert.deepEqual({publisher: shaped.publisher, country: shaped.country, homepage: shaped.homepage, isOA: shaped.isOA, apc: shaped.apc, cited: shaped.cited, fields: shaped.fields},
    {publisher: "Elsevier BV", country: "GB", homepage: "http://journals.elsevier.com/x", isOA: false, apc: 4880, cited: 2542085, fields: ["Engineering", "Environmental Science"]});
  assert.equal(shaped.topics.length, 3);
  // A record with none of it still shapes, with the profile empty.
  const bare = metrics.shapeSource(source("Nature"));
  assert.deepEqual({publisher: bare.publisher, fields: bare.fields, apc: bare.apc, homepage: bare.homepage}, {publisher: "", fields: [], apc: null, homepage: ""});
  assert.match(metrics.lookupURL({issn: "1476-4687"}), /host_organization_name/);
});

test("fifty journals are asked for in one request, by ISSN", () => {
  const url = metrics.profilesURL(["1476-4687", "0036-8075", "bad", "1476-4687"]);
  assert.match(url, /per_page=50/);
  assert.match(decodeURIComponent(url), /filter=issn:1476-4687\|0036-8075&/);
  assert.equal(metrics.profilesURL([]), null);
  assert.equal(metrics.readSources({results: [source("Nature"), null]}).length, 1);
});

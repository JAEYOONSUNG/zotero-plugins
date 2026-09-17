import test from "node:test";
import assert from "node:assert/strict";
import discover from "../src/discover.js";

const work = {
  id: "https://openalex.org/W123", doi: "https://doi.org/10.1038/S41467-024-48219-Y",
  title: "An antiplasmid system", publication_year: 2024, cited_by_count: 12, type: "article",
  primary_location: {source: {display_name: "Nature Communications"}, pdf_url: "https://x/a.pdf"},
  open_access: {is_oa: true},
  authorships: [
    {author: {id: "https://openalex.org/A1", display_name: "A Zongo"}, author_position: "first",
     institutions: [{display_name: "Institut Pasteur"}]},
    {author: {id: "https://openalex.org/A2", display_name: "B Rocha"}, author_position: "last", institutions: []}
  ],
  related_works: ["https://openalex.org/W9", "https://openalex.org/W8"],
  referenced_works: ["https://openalex.org/W7", "https://openalex.org/W9"]
};

test("a DOI is looked up directly; only a paper without one falls back to a title search", () => {
  assert.match(discover.workURL({DOI: "10.1/x"}), /works\/doi%3A10\.1%2Fx\?|works\/doi:10\.1%2Fx\?/);
  // A DOI written as a URL is normalised, not searched verbatim.
  assert.match(discover.workURL({DOI: "https://doi.org/10.1/X"}), /doi:10\.1%2Fx/i);
  assert.match(discover.workURL({title: "Some paper"}), /title\.search/);
  assert.equal(discover.workURL({}), null);
});

test("an api key and mailto are attached only when supplied", () => {
  assert.equal(discover.credentials({}), "");
  const both = discover.credentials({email: "a@b.c", apiKey: "k"});
  assert.match(both, /&api_key=k/);
  assert.match(both, /&mailto=a%40b\.c/);
});

test("a work carries each author's OpenAlex id, because a name alone finds the wrong person", () => {
  const shaped = discover.readWork(work);
  assert.deepEqual(shaped.people.map(p => p.id), ["A1", "A2"]);
  assert.equal(shaped.people[0].institution, "Institut Pasteur");
  assert.equal(shaped.people[0].position, "first");
  assert.deepEqual(shaped.authors, ["A Zongo", "B Rocha"]);
  assert.equal(shaped.doi, "10.1038/s41467-024-48219-y", "the doi is normalised for comparison");
  assert.equal(shaped.venue, "Nature Communications");
  assert.equal(shaped.openAccess, true);
});

test("a title search response and a direct lookup both yield one work", () => {
  assert.equal(discover.readWork({results: [work]}).id, "W123");
  assert.equal(discover.readWork(work).id, "W123");
  for (const bad of [null, {}, {results: []}]) assert.equal(discover.readWork(bad), null);
});

test("suggestions put OpenAlex's related works first and the bibliography after, without repeats", () => {
  const found = ["W9", "W8", "W7"].map((id, i) => discover.readWork({
    ...work, id: "https://openalex.org/" + id, title: id, doi: "https://doi.org/10.1/" + id,
    cited_by_count: i, related_works: [], referenced_works: []}));
  const merged = discover.mergeSuggestions(discover.readWork(work), found, {have: ["10.1/W8"]});
  assert.deepEqual(merged.map(s => [s.id, s.source]), [["W9", "related"], ["W8", "related"], ["W7", "reference"]]);
  // W9 is in both lists and must appear once, tagged by the stronger signal.
  assert.equal(merged.filter(s => s.id === "W9").length, 1);
  // What is already shelved is marked, not hidden.
  assert.deepEqual(merged.map(s => s.inLibrary), [false, true, false]);
  assert.equal(discover.mergeSuggestions(null, found).length, 0);
});

test("identifier batches stay inside the URL limit and drop duplicates", () => {
  const many = Array.from({length: 120}, (_, i) => "https://openalex.org/W" + i);
  const url = discover.worksByIDsURL(many);
  assert.equal((decodeURIComponent(url).match(/W\d+/g) || []).length, 50);
  assert.match(url, /per_page=50/);
  assert.equal((decodeURIComponent(discover.worksByIDsURL(["W1", "W1", "w1"])).match(/W1/g) || []).length, 1);
  assert.equal(discover.worksByIDsURL([]), null);
});

test("an author's works are requested newest first, and only for a real author id", () => {
  const url = discover.authorWorksURL("A5004155478", {limit: 6});
  assert.match(url, /author\.id%3AA5004155478/);
  assert.match(url, /sort=publication_date%3Adesc|sort=publication_date:desc/);
  assert.match(url, /per_page=6/);
  assert.equal(discover.authorWorksURL("W123"), null, "a work id is not an author id");
  assert.equal(discover.authorWorksURL(""), null);
});

test("an author profile reports standing and what they actually work on", () => {
  const [author] = discover.readAuthors({results: [{
    id: "https://openalex.org/A1", display_name: "Ben E. Black", works_count: 200, cited_by_count: 9000,
    summary_stats: {h_index: 55, i10_index: 150},
    last_known_institutions: [{display_name: "University of Pennsylvania"}],
    topics: [{display_name: "Centromere biology", count: 40}, {display_name: "Chromatin", count: 12}, {count: 1}]
  }]});
  assert.equal(author.hIndex, 55);
  assert.equal(author.institutions[0], "University of Pennsylvania");
  assert.deepEqual(author.topics.map(t => t.name), ["Centromere biology", "Chromatin"]);
  assert.deepEqual(discover.readAuthors({results: [{display_name: "no id"}]}), []);
});

test("author names come off the item deduplicated, ignoring editors and translators", () => {
  const item = {getCreators: () => [
    {firstName: "Ada", lastName: "Lovelace", creatorType: "author"},
    {firstName: "Ada", lastName: "Lovelace", creatorType: "author"},
    {firstName: "Ed", lastName: "Itor", creatorType: "editor"},
    {name: "Consortium X", creatorType: "author"}
  ]};
  assert.deepEqual(discover.authorNames(item), ["Ada Lovelace", "Consortium X"]);
  assert.deepEqual(discover.authorNames({}), []);
});

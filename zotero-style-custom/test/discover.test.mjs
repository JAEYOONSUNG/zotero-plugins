import test from "node:test";
import assert from "node:assert/strict";
import discover from "../src/discover.js";

const topic = (id, subfield, field) => ({
  id: "https://openalex.org/" + id,
  subfield: {id: "https://openalex.org/" + subfield},
  field: {id: "https://openalex.org/" + field},
  domain: {id: "https://openalex.org/D1"}
});
const bare = id => ({id: "https://openalex.org/" + id, title: id, doi: "https://doi.org/10.1/" + id,
  publication_year: 2020, cited_by_count: 1, related_works: [], referenced_works: []});

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

test("a candidate with nothing in common with the source paper is dropped", () => {
  // OpenAlex listed a Russian pedagogy paper among a bacterial condensin study's
  // related works; sharing no topic, subfield or field is what disqualifies it.
  const source = discover.readWork({...work, topics: [topic("T1", "S1", "F1")]});
  const sameTopic = discover.readWork({...bare("W9"), topics: [topic("T1", "S1", "F1")]});
  const sameField = discover.readWork({...bare("W8"), topics: [topic("T7", "S7", "F1")]});
  const unrelated = discover.readWork({...bare("W6"), topics: [topic("T9", "S9", "F9")]});
  assert.equal(discover.relevance(sameTopic, source), 3);
  assert.equal(discover.relevance(sameField, source), 1);
  assert.equal(discover.relevance(unrelated, source), 0);
  const kept = discover.mergeSuggestions(source, [sameTopic, sameField, unrelated]);
  assert.deepEqual(kept.map(s => s.id), ["W9", "W8"]);
});

test("papers citing this one rank above its bibliography, and OpenAlex's guesses last", () => {
  const T = [topic("T1", "S1", "F1")];
  const source = discover.readWork({...work, topics: T,
    related_works: ["https://openalex.org/W8"], referenced_works: ["https://openalex.org/W7"]});
  const citing = [discover.readWork({...bare("W5"), topics: T, cited_by_count: 9})];
  const found = ["W8", "W7"].map(id => discover.readWork({...bare(id), topics: T}));
  const merged = discover.mergeSuggestions(source, found, {citing, have: ["10.1/W7"]});
  assert.deepEqual(merged.map(s => [s.id, s.source]),
    [["W5", "citing"], ["W7", "reference"], ["W8", "related"]]);
  // What is already shelved is marked, not hidden.
  assert.deepEqual(merged.map(s => s.inLibrary), [false, true, false]);
});

test("a paper listed in two places appears once, and never suggests itself", () => {
  const T = [topic("T1", "S1", "F1")];
  const source = discover.readWork({...work, topics: T,
    related_works: ["https://openalex.org/W9", "https://openalex.org/W123"],
    referenced_works: ["https://openalex.org/W9"]});
  const found = ["W9", "W123"].map(id => discover.readWork({...bare(id), topics: T}));
  const merged = discover.mergeSuggestions(source, found);
  assert.deepEqual(merged.map(s => [s.id, s.source]), [["W9", "reference"]]);
});

test("citing works are asked for by citation count, and only for a work id", () => {
  assert.match(discover.citingURL("W123", {limit: 5}), /filter=cites%3AW123/);
  assert.match(discover.citingURL("W123"), /sort=cited_by_count%3Adesc|sort=cited_by_count:desc/);
  assert.equal(discover.citingURL("A1"), null);
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

const author = (name, institutions, hIndex, works) => ({
  id: "A" + name.replace(/\W/g, ""), name, institutions, hIndex, works, citations: 0, topics: []
});

test("the family name must agree; a near-miss is not a match", () => {
  const wanted = {name: "Michael Laub", institution: "MIT"};
  assert.equal(discover.scoreAuthor(author("Michael Laue", [], 60, 200), wanted), 0);
  assert.ok(discover.scoreAuthor(author("Michael T. Laub", [], 67, 225), wanted) > 0);
});

test("standing decides between namesakes when the recorded institution is stale", () => {
  // OpenAlex lists Voigt under a former centre, so the institution cannot help.
  const real = author("Christopher A. Voigt", ["Intelligent Synthetic Biology Center"], 78, 343);
  const namesake = author("Christopher Voigt", ["Naval Medical Center Portsmouth"], 2, 3);
  const picked = discover.pickAuthor([namesake, real], {name: "Christopher voigt", institution: "MIT"});
  assert.equal(picked.name, "Christopher A. Voigt");
});

test("a matching institution settles it even between two established people", () => {
  const atYale = author("Farren J. Isaacs", ["Yale University"], 44, 180);
  const elsewhere = author("Farren Isaacs", ["Somewhere Else"], 46, 200);
  assert.equal(discover.pickAuthor([elsewhere, atYale], {name: "Farren Isaacs", institution: "Yale University"}).institutions[0],
    "Yale University");
});

test("an unclear field is refused rather than guessed", () => {
  // Four namesakes of similar standing and no institution match: nobody wins.
  const crowd = ["Dave Savage", "Dave Savage", "Dave Savage"].map((n, i) => author(n + i, [], 1, 2));
  crowd.forEach(a => { a.name = "Dave Savage"; });
  assert.equal(discover.pickAuthor(crowd, {name: "Dave Savage", institution: "UC berkely"}), null);
  assert.equal(discover.pickAuthor([], {name: "Anyone"}), null);
  assert.equal(discover.pickAuthor(null, {name: "Anyone"}), null);
});

test("a middle name recorded by hand is dropped on the retry, because the index lacks it", () => {
  assert.deepEqual(discover.authorQueries("Jason William Chin"), ["Jason William Chin", "Jason Chin"]);
  assert.deepEqual(discover.authorQueries("George Church"), ["George Church"]);
  assert.deepEqual(discover.authorQueries("  "), []);
});

test("an author is searched by display name, not by the loose search parameter", () => {
  // The generic search matched alternate names and returned an unrelated author.
  const url = discover.authorSearchURL("Jason Chin");
  assert.match(url, /display_name\.search/);
  assert.doesNotMatch(url, /[?&]search=/);
});

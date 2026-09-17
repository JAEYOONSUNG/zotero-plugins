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

const author = (name, institutions, hIndex, works, extra = {}) => ({
  id: "A" + name.replace(/\W/g, ""), name, institutions, hIndex, works, citations: 0,
  orcid: extra.orcid || "",
  topics: (extra.topics || []).map(t => ({name: t, count: 1}))
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

const asked = (name, institution) =>
  discover.authorQueries(name, {institution}).map(row => [row.query, row.confirm]);

test("a middle name recorded by hand is dropped on the retry, because the index lacks it", () => {
  assert.deepEqual(asked("Jason William Chin"), [["Jason William Chin", ""], ["Jason Chin", ""]]);
  assert.deepEqual(asked("George Church"), [["George Church", ""]]);
  assert.deepEqual(asked("  "), []);
});

test("a generational suffix is not a family name, so it never becomes the one to match", () => {
  // "Ruben L Gonzalez Jr" sent the search looking for a Ruben surnamed "Jr".
  assert.deepEqual(asked("Ruben L Gonzalez Jr"),
    [["Ruben L Gonzalez Jr", ""], ["Ruben L Gonzalez", ""], ["Ruben Gonzalez", ""]]);
  const real = author("Ruben L. Gonzalez", ["Columbia University"], 37, 175);
  assert.ok(discover.scoreAuthor(real, {name: "Ruben L Gonzalez Jr", institution: "Columbia University"}) > 5);
});

test("a name is only guessed at when there is a place to check the guess against", () => {
  assert.deepEqual(asked("Ron Breaker"), [["Ron Breaker", ""]]);
  const withPlace = asked("Ron Breaker", "Yale University");
  assert.deepEqual(withPlace[0], ["Ron Breaker", ""]);
  // The short form is written out only after the recorded name has failed...
  assert.deepEqual(withPlace[1], ["Ronald Breaker", "expansion"]);
  // ...and a single part of the name comes last of all.
  assert.deepEqual(withPlace.at(-1), ["Breaker", "fragment"]);
});

test("a short part of a name is never searched on its own, being too common to narrow anything", () => {
  const parts = asked("Cheemeng Ta", "UC davis").map(([query]) => query);
  assert.ok(parts.includes("Cheemeng"), "a distinctive given name is worth a query");
  assert.ok(!parts.includes("Ta"), "two letters would return anybody");
});

test("a particle belongs to the family name, in the retry and in the fragment alike", () => {
  const queries = asked("Victor de Lorenzo", "CNB").map(([query]) => query);
  // Asking for "Victor Lorenzo" found a different man with one paper to his name.
  assert.ok(!queries.includes("Victor Lorenzo"));
  assert.ok(queries.includes("de Lorenzo"), "the surname carries its particle");
});

test("a place recorded as an acronym still names the place, but only past two letters", () => {
  const weiss = author("Ron Weiss", ["Massachusetts Institute of Technology"], 66, 236);
  assert.ok(discover.institutionAgrees(weiss, "MIT"));
  // "UC" is the University of Cambridge as readily as California, and reading it
  // as an acronym put David B. Savage of Cambridge inside "UC berkely".
  const cambridge = author("David B. Savage", ["University of Cambridge"], 75, 210);
  assert.equal(discover.institutionAgrees(cambridge, "UC berkely"), false);
  // A record shouted in capitals says nothing about which of its words is short
  // for what, so none of them is read as an abbreviation of anywhere.
  assert.equal(discover.institutionAgrees(weiss, "MEDICAL IMAGING TEAM"), false);
});

test("a place matches on whole words, so one place is not read inside another", () => {
  // "Ohio state university" found "Guardian Industries (United States)" and
  // offered a watcher of archaeal chromosomes a political cartoonist.
  const cartoonist = author("Steve Bell", ["Guardian Industries (United States)"], 1, 7);
  assert.equal(discover.institutionAgrees(cartoonist, "Ohio state university"), false);
  // One mistyped letter in a long word is still the same place, though.
  const berkeley = author("David F. Savage", ["University of California, Berkeley"], 46, 163);
  assert.ok(discover.institutionAgrees(berkeley, "UC berkely"));
});

test("a name the index has mangled is still the same name once folded", () => {
  // OpenAlex files him with a dotless i and a combining accent, which no amount
  // of accent-stripping alone turns back into "Victor".
  const real = author("Vı́ctor de Lorenzo", ["National Center for Biotechnology"], 93, 595);
  const wanted = {name: "Victor de Lorenzo", institution: "Spanish National Centre for Biotechnology-CSIC"};
  assert.ok(discover.scoreAuthor(real, wanted) > 5);
  assert.equal(discover.pickAuthor([real, author("Antonino De Lorenzo", ["University of Rome Tor Vergata"], 66, 498)],
    wanted).id, real.id);
});

test("two records sharing an ORCID are one person, not an ambiguous field", () => {
  // OpenAlex files Peter Jorth twice at Cedars-Sinai; read as rivals, neither wins.
  const id = "https://orcid.org/0000-0002-0981-740X";
  const full = author("Peter Jorth", ["Cedars-Sinai Medical Center"], 22, 72, {orcid: id});
  const stub = author("Peter Jorth ", ["Cedars-Sinai Medical Center"], 0, 2, {orcid: id});
  const picked = discover.pickAuthor([stub, full], {name: "Peter Jorth", institution: "Cedars-Sinai"});
  assert.equal(picked.works, 72, "the fuller record is the one kept");
});

test("an institution that plainly matches is not lost to arithmetic", () => {
  // Francesca Ceroni of Imperial beat a structural engineer by three points and
  // was still refused, because the institution test subtracted two scores.
  const real = author("Francesca Ceroni", ["Imperial College London"], 17, 56);
  const engineer = author("Francesca Ceroni", ["Parthenope University of Naples"], 36, 161);
  assert.equal(discover.pickAuthor([engineer, real], {name: "Francesca Ceroni", institution: "Imperial college"}).id,
    real.id);
});

test("standing settles a near-tie whether or not the institution also agrees", () => {
  // Both are filed at the institute, so the place cannot separate them.
  const real = author("J. Craig Venter", ["J. Craig Venter Institute"], 119, 275);
  const stub = author("Craig Venter", ["J. Craig Venter Institute"], 5, 13);
  const wanted = {name: "Craig Venter", institution: "J. Craig Venter Institute"};
  assert.equal(discover.pickAuthor([stub, real], wanted).id, real.id);
  // Two records of comparable standing, spelled the same and filed at the same
  // place, are still refused -- nothing there says which one to follow.
  const twin = {...author("J. Craig Venter", ["J. Craig Venter Institute"], 110, 260), id: "A5000000001"};
  assert.equal(discover.pickAuthor([twin, real], wanted), null);
});

test("the recorded name matched part for part beats a namesake carrying an extra initial", () => {
  const real = author("Ron Weiss", ["Massachusetts Institute of Technology"], 66, 236);
  const namesake = author("Ron J. Weiss", ["Massachusetts Institute of Technology"], 45, 95);
  const wanted = {name: "Ron Weiss", institution: "MIT"};
  assert.equal(discover.pickAuthor([namesake, real], wanted).id, real.id);
  // A thin duplicate spelled exactly right does not outrank the real record.
  const stub = author("Ron Weiss ", ["Massachusetts Institute of Technology"], 0, 1);
  assert.equal(discover.pickAuthor([stub, real, namesake], wanted).id, real.id);
});

test("what the watcher wrote about the work decides a tie the names cannot", () => {
  const berkeley = ["University of California, Berkeley"];
  const real = author("David F. Savage", berkeley, 46, 163,
    {topics: ["Photosynthetic Processes and Mechanisms", "RNA and protein synthesis mechanisms"]});
  const namesake = author("David A. Savage", berkeley, 41, 242,
    {topics: ["T-cell and B-cell Immunology", "Decision-Making and Behavioral Economics"]});
  const wanted = {name: "Dave Savage", institution: "UC berkely", confirm: "expansion",
    topics: "archaeal defense system, synthetic biology, rubisco"};
  assert.equal(discover.pickAuthor([namesake, real], wanted).id, real.id);
  // And it reads the same way backwards: the leader who does none of that work
  // is refused rather than attached.
  assert.equal(discover.pickAuthor([namesake, {...real, topics: []}], wanted), null);
});

test("the recorded work promotes a rival only past a lead too slight to mean anything", () => {
  const stanford = ["Stanford University"];
  const real = author("Alex Gao", stanford, 1, 3, {topics: ["Bacteriophages and microbial interactions"]});
  const namesake = author("Alex Xiong Gao", stanford, 11, 23, {topics: ["Phytochemicals and Antioxidant Activities"]});
  const wanted = {name: "Alex Gao", institution: "Stanford University", topics: "Anti-phage"};
  assert.equal(discover.pickAuthor([namesake, real], wanted).id, real.id);
  // A clear winner on name and place is not overturned by a shared word: Kyle
  // Daniels' recorded interests mention "machine learning", and so does a
  // one-paper namesake who shares nothing else with him.
  const daniels = author("Kyle G. Daniels", stanford, 8, 29, {topics: ["Protein Engineering"]});
  const passer = author("Kyle T Daniels", [], 1, 4, {topics: ["Machine Learning and Data Classification"]});
  assert.equal(discover.pickAuthor([passer, daniels],
    {name: "Kyle Gabriel Daniels", institution: "Stanford medicine, Department of genetics",
     topics: "Synthetic systems using experimental library screens and machine learning tools"}).id, daniels.id);
});

test("a guessed name has to answer to the recorded work as well as the recorded place", () => {
  // Expanding "Steve" to "Stephen" finds a growth-hormone lab at Ohio
  // University ahead of the archaeal chromosome lab OpenAlex files under a
  // stale company address; "archaea chromosome" is what tells them apart.
  const wrong = author("Stephen Bell", ["Ohio University"], 9, 24, {topics: ["Growth Hormone and Insulin-like Growth Factors"]});
  const right = author("Stephen D. Bell", ["Prometheus Research (United States)"], 56, 168,
    {topics: ["Bacterial Genetics and Biotechnology", "Chromosomal and Genetic Variations"]});
  const wanted = {name: "Steve Bell", institution: "Ohio state university",
    confirm: "expansion", topics: "archaea chromosome"};
  assert.equal(discover.pickAuthor([wrong, right], wanted), null);
  // With nothing recorded about the work there is nothing to answer to, and the
  // place alone carries it.
  assert.equal(discover.pickAuthor([wrong, right], {...wanted, topics: ""}).id, wrong.id);
});

test("a guessed name is refused outright when the recorded place does not agree", () => {
  const elsewhere = author("Ronald Breaker", ["Somewhere Else"], 106, 299);
  assert.equal(discover.pickAuthor([elsewhere],
    {name: "Ron Breaker", institution: "Yale University", confirm: "expansion"}), null);
  const atYale = author("Ronald R. Breaker", ["Yale University"], 106, 299);
  assert.equal(discover.pickAuthor([elsewhere, atYale],
    {name: "Ron Breaker", institution: "Yale University", confirm: "expansion"}).id, atYale.id);
});

test("a family name typed one letter short is forgiven; one letter changed is not", () => {
  const tan = author("Cheemeng Tan", ["University of California, Davis"], 25, 74);
  assert.equal(discover.pickAuthor([tan],
    {name: "Cheemeng Ta", institution: "UC davis", confirm: "fragment"}).id, tan.id);
  // Laue is not Laub, however well the rest of the record lines up.
  const laue = author("Michael Laue", ["Massachusetts Institute of Technology"], 60, 200);
  assert.equal(discover.pickAuthor([laue],
    {name: "Michael Laub", institution: "MIT", confirm: "fragment"}), null);
  // Nor is the slip forgiven on the plain queries, where nothing confirms it.
  assert.equal(discover.scoreAuthor(tan, {name: "Cheemeng Ta", institution: "UC davis"}), 0);
});

test("the last one standing after a fragment query has to account for the whole name", () => {
  // A surname on its own returns an arbitrary ten of a very large field, so
  // surviving the name test is not evidence: the extra initial is unexplained.
  const namesake = author("Ron J. Weiss", ["Massachusetts Institute of Technology"], 45, 95);
  const wanted = {name: "Ron Weiss", institution: "MIT", confirm: "fragment"};
  assert.equal(discover.pickAuthor([namesake], wanted), null);
  const real = author("Ron Weiss", ["Massachusetts Institute of Technology"], 66, 236);
  assert.equal(discover.pickAuthor([real], wanted).id, real.id);
});

test("a recorded interest is met by a word inside a topic or a stem shared with one", () => {
  const person = author("A B", [], 1, 1, {topics: ["Bacteriophages and microbial interactions"]});
  assert.ok(discover.topicsAgree(person, "Anti-phage"), "phage is inside bacteriophages");
  assert.ok(discover.topicsAgree(author("A B", [], 1, 1, {topics: ["RNA and protein synthesis mechanisms"]}),
    "synthetic biology"), "synthetic and synthesis share a stem");
  // Four letters would match nearly every life-science topic and prove nothing.
  assert.equal(discover.topicsAgree(person, "gene bio"), false);
  assert.equal(discover.topicsAgree(person, ""), false);
  assert.equal(discover.topicsAgree(author("A B", [], 1, 1, {topics: []}), "Anti-phage"), false);
});

test("an author is searched by display name, not by the loose search parameter", () => {
  // The generic search matched alternate names and returned an unrelated author.
  const url = discover.authorSearchURL("Jason Chin");
  assert.match(url, /display_name\.search/);
  assert.doesNotMatch(url, /[?&]search=/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Runtime = require("../src/runtime.js");
const discover = require("../src/discover.js");


const work = (id, authorIDs, over = {}) => ({
  id: "https://openalex.org/" + id,
  title: id + " title", doi: "https://doi.org/10.1/" + id.toLowerCase(),
  publication_year: 2026, publication_date: "2026-08-01", cited_by_count: 0, type: "article",
  primary_location: {source: {display_name: "Nature"}},
  open_access: {is_oa: false},
  authorships: authorIDs.map(a => ({author: {id: "https://openalex.org/" + a, display_name: a},
    author_position: "first", institutions: []})),
  ...over
});

// A stand-in for the plugin: the sweep only needs the watchlist, a fetcher and
// somewhere to save, so this exercises the real method without a whole Zotero.
function host({rows, pages, profiles = []}) {
  const calls = [];
  return {
    calls, saved: null,
    cache: {watchedAuthors: rows},
    discoverTools: discover,
    Z: {logError() {}},
    dirty: false,
    discoverOptions: () => ({}),
    libraryDOIs: () => new Set(["10.1/w9"]),
    watchedAuthors: Runtime.prototype.watchedAuthors,
    pause: Runtime.prototype.pause,
    WATCH_LIMIT: 500, SEEN_LIMIT: 400,
    outOfBudget: Runtime.prototype.outOfBudget,
    watchedAuthorsByNews: Runtime.prototype.watchedAuthorsByNews,
    watchAuthor: Runtime.prototype.watchAuthor,
    sweepWatchedAuthors: Runtime.prototype.sweepWatchedAuthors,
    sweepWatchedPatents: Runtime.prototype.sweepWatchedPatents,
    patentTools: require("../src/patents.js"), patentsKey() { return this.key || ""; }, active: true,
    retireLooseMoves: Runtime.prototype.retireLooseMoves,
    clearAuthorNews: Runtime.prototype.clearAuthorNews,
    async discoverJSON(url) {
      calls.push(url);
      const next = /\/authors\?/.test(url) ? profiles.shift() : pages.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    async flush() { this.saved = JSON.parse(JSON.stringify(this.cache.watchedAuthors)); }
  };
}

const person = (id, over = {}) => ({id, name: id + " Name", institution: "Somewhere", seen: [], ...over});

test("a hundred followed authors are answered in three requests, not a hundred", async () => {
  const rows = Array.from({length: 109}, (_, n) => person("A" + (n + 1)));
  const page = works => ({results: works, meta: {next_cursor: null}});
  const h = host({rows, pages: [page([work("W1", ["A1"])]), page([]), page([])]});
  const result = await h.sweepWatchedAuthors();
  // 109 authors / 50 per filter = 3 batches. One request each for the works,
  // because each first page came back short of the limit, and one each for
  // the author records that say where everyone is now.
  assert.equal(result.requests, 6);
  assert.equal(h.calls.filter(url => /\/works\?/.test(url)).length, 3);
  assert.equal(h.calls.filter(url => /\/authors\?/.test(url)).length, 3);
  assert.equal(result.authors, 109);
  assert.equal(result.withNews, 1);
  assert.equal(result.works, 1);
});

test("news lands on every followed author of the paper, and says what it is", async () => {
  const rows = [person("A1"), person("A2"), person("A3")];
  const h = host({rows, pages: [{results: [work("W1", ["A1", "A2"])], meta: {}}]});
  await h.sweepWatchedAuthors();
  assert.equal(h.cache.watchedAuthors[0].news.length, 1);
  assert.equal(h.cache.watchedAuthors[1].news.length, 1, "a joint paper is news for both colleagues");
  assert.deepEqual(h.cache.watchedAuthors[2].news, []);
  assert.equal(h.cache.watchedAuthors[0].news[0].venue, "Nature");
  assert.equal(h.cache.watchedAuthors[0].news[0].date, "2026-08-01");
  assert.ok(h.saved, "the sweep is worthless if it is not on disk before Zotero closes");
});

test("a paper the user already recorded is not news", async () => {
  const rows = [person("A1", {seen: ["W1"]})];
  const h = host({rows, pages: [{results: [work("W1", ["A1"]), work("W2", ["A1"])], meta: {}}]});
  const result = await h.sweepWatchedAuthors();
  assert.deepEqual(result.works, 1);
  assert.deepEqual(h.cache.watchedAuthors[0].news.map(n => n.id), ["W2"]);
});

test("a paper already on the shelf is marked, so the user does not import it twice", async () => {
  const h = host({rows: [person("A1")], pages: [{results: [work("W9", ["A1"])], meta: {}}]});
  await h.sweepWatchedAuthors();
  assert.equal(h.cache.watchedAuthors[0].news[0].inLibrary, true);
});

test("running out of budget leaves the unchecked authors unmarked, not falsely quiet", async () => {
  const rows = Array.from({length: 60}, (_, n) => person("A" + (n + 1)));
  const budget = Object.assign(new Error("Insufficient budget"), {status: 429});
  // The first batch answers; the second dies on the daily limit.
  const h = host({rows, pages: [{results: [work("W1", ["A1"])], meta: {}}, budget]});
  const result = await h.sweepWatchedAuthors();
  assert.equal(result.budgetGone, true);
  assert.equal(result.remaining, 1);
  // A51 was never asked about. Writing "checked, nothing new" on that row would
  // hide real news behind a clean-looking list until the user next swept.
  assert.equal(h.cache.watchedAuthors.find(r => r.id === "A51").sweptAt, undefined);
  assert.equal(h.cache.watchedAuthors.find(r => r.id === "A1").news.length, 1);
});

test("paging continues while the server offers a cursor", async () => {
  const many = n => Array.from({length: n}, (_, i) => work("W" + i, ["A1"]));
  const h = host({rows: [person("A1")], pages: [
    {results: many(200), meta: {next_cursor: "c2"}},
    {results: many(3).map(w => ({...w, id: w.id + "b"})), meta: {next_cursor: null}}
  ]});
  const result = await h.sweepWatchedAuthors();
  assert.equal(result.requests, 3, "one for the author record, two for the works");
  assert.match(h.calls.filter(url => /\/works\?/.test(url))[1], /cursor=c2/);
});

test("the list puts the answer at the top: news first, newest first, then by name", () => {
  const h = host({rows: [
    person("A1", {name: "Zoe", news: []}),
    person("A2", {name: "Adam", news: []}),
    person("A3", {name: "Mia", news: [{id: "W1", date: "2026-02-01"}]}),
    person("A4", {name: "Kai", news: [{id: "W2", date: "2026-09-01"}]})
  ], pages: []});
  assert.deepEqual(h.watchedAuthorsByNews().map(r => r.name), ["Kai", "Mia", "Adam", "Zoe"]);
});

test("dismissing the news remembers those papers, so they do not come back next sweep", async () => {
  const h = host({rows: [person("A1", {news: [{id: "W1"}, {id: "W2"}]})], pages: []});
  await h.clearAuthorNews("https://openalex.org/A1");
  assert.deepEqual(h.cache.watchedAuthors[0].news, []);
  assert.deepEqual(h.cache.watchedAuthors[0].seen.sort(), ["W1", "W2"]);
});

test("the batched query asks only for fields it shows", () => {
  const url = discover.watchedWorksURL(["A1", "A2"], {since: "2025-01-01"});
  assert.match(url, /author\.id%3AA1%7CA2/);
  assert.match(url, /from_publication_date%3A2025-01-01/);
  // referenced_works is hundreds of ids per paper and none of it is displayed;
  // asking for it on a 200-work page is megabytes for nothing.
  assert.doesNotMatch(url, /referenced_works/);
  assert.match(url, /publication_date/);
  assert.equal(discover.watchedWorksURL([]), null);
  assert.equal(discover.watchedWorksURL(["not-an-author"]), null);
});

test("fifty ids per filter is what OpenAlex accepts, so batches stop there", () => {
  const ids = Array.from({length: 109}, (_, n) => "A" + n);
  const batches = discover.authorBatches(ids);
  assert.deepEqual(batches.map(b => b.length), [50, 50, 9]);
  assert.deepEqual(discover.authorBatches(["A1", "A1", "A2"]), [["A1", "A2"]], "the same author twice is one id");
});

test("following someone still works past a hundred, which is where the user already is", async () => {
  // The user follows 109. The old cap rejected every addition outright, so the
  // feature was closed to exactly the person who had been using it.
  const rows = Array.from({length: 109}, (_, n) => person("A" + (n + 1)));
  const h = host({rows, pages: []});
  await h.watchAuthor({id: "https://openalex.org/A999", name: "New Person"});
  assert.equal(h.cache.watchedAuthors.length, 110);
  assert.equal(h.cache.watchedAuthors.at(-1).name, "New Person");
  h.cache.watchedAuthors = Array.from({length: 500}, (_, n) => person("B" + n));
  await assert.rejects(() => h.watchAuthor({id: "A999", name: "Too many"}), /500/);
});

test("the lookback reaches back to when each author was last checked, not a fixed window", async () => {
  const old = new Date(Date.now() - 900 * 24 * 3600 * 1000).toISOString();
  const h = host({rows: [person("A1", {checkedAt: old})], pages: [{results: [], meta: {}}]});
  await h.sweepWatchedAuthors();
  const asked = decodeURIComponent(h.calls.find(url => /\/works\?/.test(url))).match(/from_publication_date:(\d{4}-\d{2}-\d{2})/)[1];
  // Following someone two and a half years ago and sweeping today must not skip
  // the two years in between just because the default window is eighteen months.
  assert.ok(Date.parse(asked) < Date.now() - 880 * 24 * 3600 * 1000, "asked from " + asked);
});

test("a stale entry cannot ask OpenAlex for a whole career", async () => {
  const h = host({rows: [person("A1", {checkedAt: "1998-01-01T00:00:00Z"})], pages: [{results: [], meta: {}}]});
  await h.sweepWatchedAuthors();
  const asked = decodeURIComponent(h.calls.find(url => /\/works\?/.test(url))).match(/from_publication_date:(\d{4}-\d{2}-\d{2})/)[1];
  assert.ok(Date.parse(asked) > Date.now() - 6.1 * 365 * 24 * 3600 * 1000, "asked from " + asked);
});

test("an author who has never been checked uses the default window", async () => {
  const h = host({rows: [{id: "A1", name: "Fresh", seen: []}], pages: [{results: [], meta: {}}]});
  await h.sweepWatchedAuthors({months: 18});
  const asked = decodeURIComponent(h.calls.find(url => /\/works\?/.test(url))).match(/from_publication_date:(\d{4}-\d{2}-\d{2})/)[1];
  const days = (Date.now() - Date.parse(asked)) / (24 * 3600 * 1000);
  assert.ok(days > 530 && days < 560, "asked from " + asked);
});

test("a sweep notices a lab move and a first-time co-author, and drops repository deposits", async () => {
  const signed = (author, place) => ({author: {id: "https://openalex.org/" + author, display_name: author},
    author_position: "first", institutions: place ? [{display_name: place}] : []});
  const rows = [{id: "A1", name: "Ada", institution: "MIT", institutionRor: "042nb2s44", places: [{name: "Massachusetts Institute of Technology", ror: "042nb2s44"}], seen: ["W0"], coauthorsSeen: ["Old Friend"], sweptAt: "2026-07-01T00:00:00Z"}];
  const pages = [{
    results: [
      // Signed from Stanford now, with someone never seen before.
      {...work("W1", []), authorships: [signed("A1", "Stanford University"), signed("New Face", "Stanford University"), signed("Old Friend", "MIT")]},
      // A second paper signed without MIT: one could be a visiting stint.
      {...work("W4", []), authorships: [signed("A1", "Stanford University")]},
      // And the paper before those, from MIT, already seen.
      {...work("W0", []), publication_date: "2025-01-05", authorships: [signed("A1", "MIT")]},
      // A repository deposit, which OpenAlex types as a dataset.
      {...work("W2", ["A1"]), type: "dataset", primary_location: {source: {display_name: "PNNL Repository"}}},
      // A preprint, which should be flagged as one.
      {...work("W3", ["A1"]), type: "preprint", primary_location: {source: {display_name: "bioRxiv (Cold Spring Harbor Laboratory)"}}}
    ],
    meta: {next_cursor: ""}
  }];
  const profiles = [{results: [{id: "https://openalex.org/A1", display_name: "Ada",
    last_known_institutions: [{display_name: "Stanford University", ror: "https://ror.org/00f54p054"}],
    affiliations: [{institution: {display_name: "Stanford University", ror: "https://ror.org/00f54p054"}, years: [2026]},
      {institution: {display_name: "Massachusetts Institute of Technology", ror: "https://ror.org/042nb2s44"}, years: [2025, 2024]}]}]}];
  const h = host({rows, pages, profiles});
  h.active = true;
  // The signals sweep runs at the end; give it nothing to do here.
  h.sweepWatchedSignals = async () => ({checked: 0, flagged: 0, total: 0});
  await h.sweepWatchedAuthors();
  const row = h.saved[0];
  assert.ok(h.calls.some(url => /\/authors\?.*ids\.openalex/.test(url)), "the author records were asked for");
  /* Of 64 "new papers" across 109 watched authors, 15 were PNNL repository
     deposits typed dataset; the type used to be fetched and thrown away. */
  assert.deepEqual(row.news.map(n => n.id).sort(), ["W1", "W3", "W4"], "the papers, without the deposit or the seen one");
  assert.ok(!row.news.some(n => n.id === "W2"), "the deposit is gone");
  assert.equal(row.news.find(n => n.id === "W3").preprint, true, "the preprint is marked as one");
  assert.equal(row.news.find(n => n.id === "W1").preprint, false);
  assert.deepEqual(row.news.find(n => n.id === "W1").people, ["A1", "New Face", "Old Friend"], "names ride along for later");
  // OpenAlex now lists the author somewhere else: a move, dated from the record.
  assert.deepEqual({from: row.moved.from, to: row.moved.to, since: row.moved.since, rule: row.moved.rule}, {from: "MIT", to: "Stanford University", since: 2026, rule: 2});
  assert.equal(row.institution, "Stanford University");
  assert.equal(row.institutionRor, "00f54p054");
  assert.equal(row.previousInstitution, "MIT");
  // And a name not on any earlier paper is a collaboration starting.
  assert.deepEqual(row.newCoauthors, ["New Face"], "Old Friend was already known; the author is not their own co-author");
  assert.ok(row.coauthorsSeen.includes("New Face"), "and is remembered, so it is not new twice");
});

test("the first sweep does not call every colleague new, and the same lab is not a move", async () => {
  const signed = (author, place) => ({author: {id: "https://openalex.org/" + author, display_name: author},
    author_position: "first", institutions: place ? [{display_name: place}] : []});
  const rows = [{id: "A1", name: "Ada", institution: "Massachusetts Institute of Technology", seen: []}];
  const pages = [{results: [{...work("W1", []), authorships: [signed("A1", "MIT"), signed("Colleague", "MIT")]}], meta: {next_cursor: ""}}];
  const h = host({rows, pages});
  h.active = true;
  h.sweepWatchedSignals = async () => ({checked: 0, flagged: 0, total: 0});
  await h.sweepWatchedAuthors();
  const row = h.saved[0];
  assert.deepEqual(row.newCoauthors, [], "no history to compare against yet");
  assert.deepEqual(row.coauthorsSeen, ["Colleague"], "but the history starts now");
  assert.equal(row.moved, undefined, "MIT within Massachusetts Institute of Technology is the same place");
});

test("a move is read from the author record, so a second appointment or a renamed place is not one", async () => {
  /* Read off the papers, the sweep reported seven, then six, moves among
     109 authors -- "Harvard → Broad Institute" for someone appointed at
     both, "UC Berkeley → QB3" for an institute inside Berkeley, "DTU →
     Technical University of Denmark", "Harvard Medical School → Harvard
     University", "MIT chemistry → Massachusetts Institute of Technology".
     None was a move. OpenAlex's author record lists every current
     appointment with a ROR; a move is when all of the ones remembered are
     gone from it. */
  const inst = (name, ror) => ({display_name: name, ror: ror ? "https://ror.org/" + ror : ""});
  const record = (places, affiliations = []) => ({results: [{id: "https://openalex.org/A1", display_name: "Ada",
    last_known_institutions: places.map(([n, r]) => inst(n, r)),
    affiliations: affiliations.map(([n, r, years]) => ({institution: inst(n, r), years}))}]});
  const run = async (row, profile) => {
    const h = host({rows: [row], pages: [{results: [], meta: {next_cursor: ""}}], profiles: profile ? [profile] : []});
    h.active = true;
    h.sweepWatchedSignals = async () => ({checked: 0, flagged: 0, total: 0});
    await h.sweepWatchedAuthors();
    return h.saved[0];
  };
  // First sight: the text typed when following is replaced by OpenAlex's name for the same place.
  let row = await run({id: "A1", name: "Ada", institution: "MIT chemistry", seen: []},
    record([["Broad Institute", "05a0ya142"], ["Massachusetts Institute of Technology", "042nb2s44"]]));
  assert.equal(row.moved, undefined, "a baseline is adopted, not a move");
  assert.deepEqual({name: row.institution, ror: row.institutionRor, given: row.institutionGiven},
    {name: "Massachusetts Institute of Technology", ror: "042nb2s44", given: "MIT chemistry"});
  assert.deepEqual(row.places.map(p => p.name), ["Broad Institute", "Massachusetts Institute of Technology"]);
  for (const [given, canonical] of [["DTU", "Technical University of Denmark"], ["UC berkely", "University of California, Berkeley"],
      ["University of Illinois at Urbana-Champaign", "University of Illinois Urbana-Champaign"], ["Harvard Medical School", "Harvard University"]]) {
    row = await run({id: "A1", name: "Ada", institution: given, seen: []}, record([["Elsewhere", "x1"], [canonical, "x2"]]));
    assert.equal(row.institution, canonical, given + " is " + canonical);
  }
  // Nothing listed resembles the text: the current appointment is the baseline, quietly.
  row = await run({id: "A1", name: "Ada", institution: "Somewhere Typed", seen: []}, record([["Tsinghua University", "03cve4549"]]));
  assert.equal(row.moved, undefined);
  assert.deepEqual({name: row.institution, given: row.institutionGiven}, {name: "Tsinghua University", given: "Somewhere Typed"});
  // A second appointment appears: still there.
  row = await run({id: "A1", name: "Ada", institution: "Harvard University", institutionRor: "03vek6s52", places: [{name: "Harvard University", ror: "03vek6s52"}], seen: []},
    record([["Broad Institute", "05a0ya142"], ["Harvard University", "03vek6s52"]]));
  assert.equal(row.moved, undefined, "Harvard is still listed");
  assert.equal(row.institution, "Harvard University");
  assert.equal(row.places.length, 2, "and the second appointment is remembered");
  // Every remembered appointment gone: a move, to the newest place listed.
  row = await run({id: "A1", name: "Ada", institution: "Harvard University", institutionRor: "03vek6s52", places: [{name: "Harvard University", ror: "03vek6s52"}], seen: []},
    record([["Howard Hughes Medical Institute", "006w34k90"], ["Broad Institute", "05a0ya142"]],
      [["Howard Hughes Medical Institute", "006w34k90", [2026, 2025, 2024, 2023]], ["Broad Institute", "05a0ya142", [2026, 2025]], ["Harvard University", "03vek6s52", [2024, 2023]]]));
  assert.deepEqual({from: row.moved.from, to: row.moved.to, since: row.moved.since}, {from: "Harvard University", to: "Broad Institute", since: 2025});
  assert.equal(row.institutionRor, "05a0ya142");
  // The place shown drops off while another remembered one remains: no move, the other is shown.
  row = await run({id: "A1", name: "Ada", institution: "Harvard University", institutionRor: "03vek6s52", places: [{name: "Harvard University", ror: "03vek6s52"}, {name: "Broad Institute", ror: "05a0ya142"}], seen: []},
    record([["Broad Institute", "05a0ya142"]]));
  assert.equal(row.moved, undefined);
  assert.equal(row.institution, "Broad Institute");
  // A move on record is taken back when the old place is listed again.
  row = await run({id: "A1", name: "Ada", institution: "QB3", institutionRor: "04n1n3n22", places: [{name: "QB3", ror: "04n1n3n22"}], previousInstitution: "University of California, Berkeley", previousInstitutionRor: "01an7q238", moved: {from: "University of California, Berkeley", to: "QB3", rule: 2}, seen: []},
    record([["QB3", "04n1n3n22"], ["University of California, Berkeley", "01an7q238"]]));
  assert.equal(row.moved, undefined, "the move is withdrawn");
  assert.deepEqual({name: row.institution, ror: row.institutionRor}, {name: "University of California, Berkeley", ror: "01an7q238"});
  // No record came back: nothing is claimed and nothing is changed.
  row = await run({id: "A1", name: "Ada", institution: "Harvard University", institutionRor: "03vek6s52", places: [{name: "Harvard University", ror: "03vek6s52"}], seen: []}, null);
  assert.equal(row.moved, undefined);
  assert.equal(row.institution, "Harvard University");
});

test("moves recorded by the first rule are retired when the store loads", async () => {
  const h = host({rows: [
    {id: "A1", name: "Ada", institution: "Technical University of Denmark", previousInstitution: "DTU", institutionRor: "04qtj9h94", moved: {from: "DTU", to: "Technical University of Denmark", at: "2026-09-19"}, seen: []},
    {id: "A2", name: "Bo", institution: "Broad Institute", previousInstitution: "Harvard University", moved: {from: "Harvard University", to: "Broad Institute", at: "2026-09-19", rule: 2}, seen: []}
  ], pages: []});
  h.dirty = false;
  h.retireLooseMoves();
  const [a, b] = h.cache.watchedAuthors;
  assert.deepEqual({institution: a.institution, moved: a.moved, prev: a.previousInstitution, ror: a.institutionRor}, {institution: "DTU", moved: undefined, prev: undefined, ror: undefined});
  assert.equal(b.moved.rule, 2, "a move read from the author record stays");
  assert.equal(h.dirty, true);
});

test("a watched author's new papers are checked for retraction through Crossref alone", async () => {
  /* A retraction on a paper you are reading is the fact the signals column
     exists for; one on a paper by someone you follow is the same fact a step
     out. Crossref is free and unmetered, so this touches no OpenAlex budget. */
  const rows = [{id: "A1", name: "Ada", news: [
    {id: "W1", doi: "10.1/fine", title: "Fine"},
    {id: "W2", doi: "10.1/pulled", title: "Pulled"},
    {id: "W3", doi: "", title: "No DOI"},
    {id: "W4", doi: "10.1/done", title: "Already", signals: {rank: 0, status: "clean"}}
  ]}];
  const asked = [];
  const h = {
    active: true, stopping: false, dirty: false, cache: {watchedAuthors: rows}, saved: null,
    Z: {logError() {}},
    watchedAuthors: Runtime.prototype.watchedAuthors,
    sweepWatchedSignals: Runtime.prototype.sweepWatchedSignals,
    async fetchPaperSignals(item, {crossrefOnly, record}) {
      asked.push({item, crossrefOnly, doi: record && record.DOI});
      return {signals: record.DOI === "10.1/pulled" ? {status: "retracted", rank: 3, checkedAt: "2026-09-19"} : {status: "clean", rank: 0, checkedAt: "2026-09-19"}};
    },
    async flush() { this.saved = JSON.parse(JSON.stringify(this.cache.watchedAuthors)); }
  };
  const result = await h.sweepWatchedSignals();
  assert.deepEqual(asked.map(a => a.doi), ["10.1/fine", "10.1/pulled"], "only DOIs not yet checked; nothing without a DOI");
  assert.ok(asked.every(a => a.item === null && a.crossrefOnly === true), "a bare record, Crossref only");
  assert.deepEqual(result, {checked: 2, flagged: 1, total: 2});
  const news = h.saved[0].news;
  assert.equal(news[1].signals.rank, 3, "the withdrawn paper carries its verdict on the row");
  assert.equal(news[0].signals.rank, 0);
  assert.equal(news[3].signals.status, "clean", "an earlier verdict is left alone");
});

test("patents run only with a USPTO key, take the first look as the baseline, and mark what appears later", async () => {
  /* A filing is the earliest public sign of where a lab is heading. The
     portal needs a key; without one the sweep says so and touches nothing. */
  const filing = (number, title, inventors, over = {}) => ({applicationNumberText: "18" + number, applicationMetaData: {
    patentNumber: number, inventionTitle: title, grantDate: "2026-0" + (number % 9 + 1) + "-01", filingDate: "2024-01-01",
    inventorBag: inventors.map(n => ({inventorNameText: n})), applicantBag: [{applicantNameText: "The Regents"}], ...over}});
  const answer = (...rows) => ({count: rows.length, patentFileWrapperDataBag: rows});
  let h = host({rows: [{id: "A1", name: "Jennifer A. Doudna", seen: []}], pages: []});
  let result = await h.sweepWatchedPatents();
  assert.deepEqual({skipped: result.skipped, requests: result.requests}, {skipped: "no-key", requests: 0});
  assert.equal(h.saved, null, "nothing written without a key");
  // With a key: one request, the header carries it, namesakes are dropped.
  h = host({rows: [{id: "A1", name: "Jennifer A. Doudna", seen: []}], pages: [
    answer(filing(1, "RNA-guided editing", ["DOUDNA; JENNIFER A.", "JINEK; MARTIN"]), filing(2, "Aldonolactonase", ["DOUDNA CATE; JAMES H."]))]});
  h.key = "k";
  h.discoverJSON = async function (url, {headers} = {}) { this.calls.push([url, headers]); const next = this.pages.shift(); if (next instanceof Error) throw next; return next; };
  h.pages = [answer(filing(1, "RNA-guided editing", ["DOUDNA; JENNIFER A.", "JINEK; MARTIN"]), filing(2, "Aldonolactonase", ["DOUDNA CATE; JAMES H."]))];
  result = await h.sweepWatchedPatents();
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0][0], /api\.uspto\.gov.*inventorNameText/);
  assert.equal(h.calls[0][1]["X-Api-Key"], "k");
  assert.deepEqual({checked: result.checked, withPatents: result.withPatents, fresh: result.fresh}, {checked: 1, withPatents: 1, fresh: 0});
  let row = h.saved[0];
  assert.deepEqual(row.patents.map(p => p.id), ["US1"], "the namesake is not hers");
  assert.deepEqual(row.newPatents, [], "the first look is the baseline");
  assert.deepEqual(row.patentsSeen, ["US1"]);
  assert.ok(row.patentsAt);
  // A week later a new filing shows: it is the news, the old one is not.
  h.pages = [answer(filing(3, "Base editors", ["DOUDNA; JENNIFER A."]), filing(1, "RNA-guided editing", ["DOUDNA; JENNIFER A."]))];
  h.cache.watchedAuthors[0].patentsAt = "2026-01-01T00:00:00Z";
  result = await h.sweepWatchedPatents();
  row = h.saved[0];
  assert.deepEqual({fresh: result.fresh, news: row.newPatents}, {fresh: 1, news: ["US3"]});
  assert.deepEqual(row.patents.map(p => [p.id, p.fresh]), [["US3", true], ["US1", false]]);
  // Checked this week already: not asked again.
  h.pages = [];
  result = await h.sweepWatchedPatents();
  assert.equal(result.requests, 0);
  // A refused key stops the sweep at once instead of failing 109 times.
  h.cache.watchedAuthors[0].patentsAt = "2026-01-01T00:00:00Z";
  h.pages = [Object.assign(new Error("Unauthorized"), {status: 401})];
  result = await h.sweepWatchedPatents();
  assert.equal(result.unauthorized, true);
});

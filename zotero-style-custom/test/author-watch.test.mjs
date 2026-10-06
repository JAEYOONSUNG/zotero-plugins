import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Runtime = require("../src/runtime.js");
const discover = require("../src/discover.js");


const RECENT = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
const work = (id, authorIDs, over = {}) => ({
  id: "https://openalex.org/" + id,
  title: id + " title", doi: "https://doi.org/10.1/" + id.toLowerCase(),
  // Dated a week ago, not on a fixed day: the sweep treats anything older than its
  // last check less two months as already known, so a fixed date ages out of "new".
  publication_year: Number(RECENT.slice(0, 4)), publication_date: RECENT, cited_by_count: 0, type: "article",
  primary_location: {source: {display_name: "Nature"}},
  open_access: {is_oa: false},
  authorships: authorIDs.map(a => ({author: {id: "https://openalex.org/" + a, display_name: a},
    author_position: "first", institutions: [{display_name: "Somewhere"}]})),
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
    WATCH_LIMIT: 500, SEEN_LIMIT: 400, NEWS_LIMIT: 50,
    keepNews: Runtime.prototype.keepNews, panelSeenKeys: Runtime.prototype.panelSeenKeys,
    outOfBudget: Runtime.prototype.outOfBudget,
    watchedAuthorsByNews: Runtime.prototype.watchedAuthorsByNews,
    watchAuthor: Runtime.prototype.watchAuthor,
    sweepWatchedAuthors: Runtime.prototype.sweepWatchedAuthors,
    sweepWatchedPatents: Runtime.prototype.sweepWatchedPatents,
    patentTools: require("../src/patents.js"), patentsKey() { return this.key || ""; }, active: true,
    retireLooseMoves: Runtime.prototype.retireLooseMoves, reclassifyStoredNews: Runtime.prototype.reclassifyStoredNews,
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
  assert.equal(h.cache.watchedAuthors[0].news[0].date, RECENT);
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
      {...work("W3", ["A1"]), authorships: [signed("A1", "MIT")], type: "preprint", primary_location: {source: {display_name: "bioRxiv (Cold Spring Harbor Laboratory)"}}}
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

test("a batch that failed leaves its authors' news and last-checked date as they were", async () => {
  const rows = Array.from({length: 60}, (_, n) => person("A" + (n + 1), n === 55 ? {news: [{id: "W5", title: "Old news"}], sweptAt: "2026-01-01T00:00:00Z"} : {}));
  const page = works => ({results: works, meta: {next_cursor: null}});
  const down = Object.assign(new Error("HTTP 503"), {status: 503});
  const h = host({rows, pages: [page([work("W1", ["A1"])]), down]});
  const result = await h.sweepWatchedAuthors();
  assert.equal(result.failed, 10, "the ten authors of the second batch");
  const kept = h.cache.watchedAuthors.find(row => row.id === "A56");
  assert.deepEqual(kept.news.map(n => n.id), ["W5"], "their news is not wiped by a server error");
  assert.equal(kept.sweptAt, "2026-01-01T00:00:00Z", "and they are not marked as checked");
  assert.ok(h.cache.watchedAuthors.find(row => row.id === "A1").sweptAt > "2026-01-01", "the batch that answered is");
});

test("a batch stopped by the budget after its first page is part-read: news is added, the date is not moved", async () => {
  const rows = [person("A1", {news: [{id: "W0", title: "Earlier news"}], sweptAt: "2026-01-01T00:00:00Z"})];
  const quota = Object.assign(new Error("Insufficient budget"), {status: 429});
  const h = host({rows, pages: [{results: [work("W1", ["A1"])], meta: {next_cursor: "c2"}}, quota]});
  const result = await h.sweepWatchedAuthors();
  assert.equal(result.budgetGone, true);
  const row = h.cache.watchedAuthors[0];
  assert.deepEqual(row.news.map(n => n.id).sort(), ["W0", "W1"], "what page one found is added to what was there");
  assert.equal(row.sweptAt, "2026-01-01T00:00:00Z", "and the next check starts from the old date");
});

test("a batch cut off at the page limit carries on from its cursor next time, and dates itself from when it began", async () => {
  const rows = [person("A1", {sweptAt: "2026-01-01T00:00:00Z"})];
  const full = n => ({results: [work("W" + n, ["A1"])], meta: {next_cursor: "c" + (n + 1)}});
  const first = host({rows, pages: Array.from({length: 8}, (_, n) => full(n + 1))});
  const one = await first.sweepWatchedAuthors();
  assert.equal(one.unfinished, 1);
  const row = first.cache.watchedAuthors[0];
  assert.equal(row.resume.cursor, "c9", "where it stopped");
  const began = row.resume.at;
  const second = host({rows: first.cache.watchedAuthors, pages: [{results: [work("W9", ["A1"])], meta: {next_cursor: null}}]});
  await second.sweepWatchedAuthors();
  const worksCall = second.calls.find(url => /\/works\?/.test(url));
  assert.match(decodeURIComponent(worksCall), /cursor=c9/, "the second run starts at the saved cursor, not the first page");
  const after = second.cache.watchedAuthors[0];
  assert.equal(after.resume, undefined, "finished: nothing left to carry");
  assert.equal(after.sweptAt, began, "dated from when the batch was begun, so newer works are seen next time");
  assert.ok(after.news.some(n => n.id === "W9") && after.news.some(n => n.id === "W1"), "what both runs found is kept");
});

test("a batch that fails after its first page does not keep a cursor past what it threw away", async () => {
  const rows = [person("A1")];
  const down = Object.assign(new Error("HTTP 503"), {status: 503});
  const h = host({rows, pages: [{results: [work("W1", ["A1"])], meta: {next_cursor: "c2"}}, down]});
  await h.sweepWatchedAuthors();
  assert.equal(h.cache.watchedAuthors[0].resume, undefined, "the next run starts at the first page, where W1 is");
});

test("a second sweep that turns nothing up says so, instead of re-announcing what is merely unread", async () => {
  // The weekly check read the same whether something had happened or not: it
  // counted every paper not yet marked, not what this run actually found.
  const rows = [person("A1")];
  const page = works => ({results: works, meta: {next_cursor: null}});
  const h = host({rows, pages: [page([work("W1", ["A1"]), work("W2", ["A1"])]), page([])]});
  const first = await h.sweepWatchedAuthors();
  assert.equal(first.added, 2, "both are new the first time");
  assert.equal(first.works, 2);
  // The host closes over its own pages, so the second run is a second host
  // over the same watchlist rows -- which is what a week later actually is.
  const h2 = host({rows, pages: [page([work("W1", ["A1"]), work("W2", ["A1"])]), page([])]});
  const again = await h2.sweepWatchedAuthors();
  assert.equal(again.added, 0, "nothing was found this time, and the message can say so");
  assert.equal(again.works, 2, "the two still waiting are still reported as waiting");
});

test("a repository deposit is not counted as a new paper in the tally either", async () => {
  const rows = [person("A1")];
  const page = works => ({results: works, meta: {next_cursor: null}});
  const h = host({rows, pages: [page([work("W1", ["A1"], {type: "dataset"}), work("W2", ["A1"])]), page([])]});
  const result = await h.sweepWatchedAuthors();
  // Of 64 "new papers" across 109 watched authors, sixteen were copies of work
  // already published, filed as datasets.
  assert.equal(result.works, 1);
  assert.equal(result.added, 1);
  assert.deepEqual(h.cache.watchedAuthors[0].news.map(w => w.id), ["W2"]);
});

test("a long-standing collaborator is not announced as a first-time co-author", async () => {
  /* The history was carried from earlier news -- at most eight papers -- so a
     colleague of ten years who was not among those came up as new. */
  const rows = [person("A1", {coauthorsSeen: []})];
  const page = works => ({results: works, meta: {next_cursor: null}});
  const older = work("W0", ["A1", "Regular"], {publication_date: "2026-01-01"});
  const news = work("W1", ["A1", "Regular", "Newcomer"]);
  const h = host({rows, pages: [page([news, older]), page([])]});
  // Everything of theirs in the window is the record, so only 8 make the news
  // but all of it counts as history.
  h.cache.watchedAuthors[0].seen = ["W0"];
  await h.sweepWatchedAuthors();
  const row = h.cache.watchedAuthors[0];
  assert.deepEqual(row.newCoauthors, ["Newcomer"], "the regular collaborator is on their older paper, so not new");
});

test("a consortium paper's author list is not a hundred new collaborations", async () => {
  const rows = [person("A1", {coauthorsSeen: ["Regular"]})];
  const page = works => ({results: works, meta: {next_cursor: null}});
  const crowd = work("W1", ["A1", ...Array.from({length: 40}, (_, n) => "Member" + n)]);
  const h = host({rows, pages: [page([crowd]), page([])]});
  await h.sweepWatchedAuthors();
  assert.deepEqual(h.cache.watchedAuthors[0].newCoauthors, [],
    "forty names on one paper says nothing about who they have started working with");
});

test("an author's back catalogue is not news: only what appeared since they were followed", async () => {
  /* The baseline taken at follow time is their 25 newest works, but the sweep
     window reaches 18 months back, so for a prolific author everything between
     the two arrived as "new" — and after each 확인함 the next eight older
     papers came back. The inbox never emptied. */
  const followed = new Date(Date.now() - 30 * 864e5).toISOString();
  const rows = [person("A1", {checkedAt: followed, seen: []})];
  const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const page = works => ({results: works, meta: {next_cursor: null}});
  const since = work("W1", ["A1"], {publication_date: day(5)});
  const old1 = work("W2", ["A1"], {publication_date: day(200)});
  const old2 = work("W3", ["A1"], {publication_date: day(400)});
  const h = host({rows, pages: [page([since, old1, old2]), page([])]});
  const result = await h.sweepWatchedAuthors();
  assert.deepEqual(h.cache.watchedAuthors[0].news.map(w => w.id), ["W1"], "only the paper published since the follow");
  assert.equal(result.works, 1);
  // The back catalogue is recorded as known, so a later sweep cannot offer it again.
  const kept = new Set(h.cache.watchedAuthors[0].seen);
  assert.ok(kept.has("W2") && kept.has("W3"), "the older papers are held as seen rather than shown");
});

test("a paper dated just before the last check is still new, because a date can precede indexing", async () => {
  const checked = new Date(Date.now() - 10 * 864e5).toISOString();
  const rows = [person("A1", {checkedAt: checked, seen: []})];
  const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const page = works => ({results: works, meta: {next_cursor: null}});
  // Dated 40 days ago, inside the two months of slack: OpenAlex can index a
  // paper well after the date printed on it.
  const h = host({rows, pages: [page([work("W1", ["A1"], {publication_date: day(40)})]), page([])]});
  await h.sweepWatchedAuthors();
  assert.deepEqual(h.cache.watchedAuthors[0].news.map(w => w.id), ["W1"]);
});

test("an author never checked before still sees their whole window, since there is no floor yet", async () => {
  const rows = [person("A1", {seen: []})];
  const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const page = works => ({results: works, meta: {next_cursor: null}});
  const h = host({rows, pages: [page([work("W1", ["A1"], {publication_date: day(300)})]), page([])]});
  await h.sweepWatchedAuthors();
  assert.deepEqual(h.cache.watchedAuthors[0].news.map(w => w.id), ["W1"], "there is nothing to measure it against yet");
});

test("an author with more than eight new papers keeps every unseen one, up to the storage cap", async () => {
  const page = works => ({results: works, meta: {next_cursor: null}});
  const many = n => Array.from({length: n}, (_, i) => work("W" + i, ["A1"], {publication_date: new Date(Date.now() - (i + 1) * 864e5).toISOString().slice(0, 10)}));
  const h = host({rows: [person("A1", {seen: []})], pages: [page(many(12)), page([])]});
  await h.sweepWatchedAuthors();
  assert.equal(h.cache.watchedAuthors[0].news.length, 12, "the card must not say there is nothing left while four papers were dropped");
  const big = host({rows: [person("A1", {seen: []})], pages: [page(many(60)), page([])]});
  await big.sweepWatchedAuthors();
  assert.equal(big.cache.watchedAuthors[0].news.length, 60, "storage is separate from the 50 the inbox shows");
  assert.equal(big.cache.watchedAuthors[0].news[0].id, "W0", "newest first, so the oldest are the ones dropped");
});

test("papers marked seen in the panel are the ones dropped first when the cap bites", () => {
  const h = host({rows: []});
  h.NEWS_LIMIT = 3;
  h.cache.workbenchUI = {inboxSeen: {"1:10.1/w1": "2026-01-01", "10.1/w3": "2026-01-01"}};
  const make = (n, date) => ({id: "W" + n, doi: "10.1/w" + n, date});
  const kept = h.keepNews([make(1, "2026-09-05"), make(2, "2026-09-04"), make(3, "2026-09-03"), make(4, "2026-09-02"), make(5, "2026-09-01")]);
  assert.deepEqual(kept.map(w => w.id), ["W2", "W4", "W5"], "all three unseen stay; the two seen go");
});

test("expiry measures from the last sweep, not from the day the author was followed", async () => {
  const followed = new Date(Date.now() - 400 * 864e5).toISOString();
  const swept = new Date(Date.now() - 10 * 864e5).toISOString();
  const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const page = works => ({results: works, meta: {next_cursor: null}});
  const rows = [person("A1", {checkedAt: followed, sweptAt: swept, seen: []})];
  const h = host({rows, pages: [page([work("W1", ["A1"], {publication_date: day(5)}), work("W2", ["A1"], {publication_date: day(150)})]), page([])]});
  await h.sweepWatchedAuthors();
  assert.deepEqual(h.cache.watchedAuthors[0].news.map(w => w.id), ["W1"], "a 150-day-old paper predates the last sweep by months: back catalogue");
  assert.ok(h.cache.watchedAuthors[0].seen.includes("W2"));
});

test("something the inbox already showed and nobody marked is never filed away silently", async () => {
  const swept = new Date(Date.now() - 10 * 864e5).toISOString();
  const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const page = works => ({results: works, meta: {next_cursor: null}});
  const shown = {id: "W2", title: "W2 title", doi: "10.1/w2", date: day(150)};
  const rows = [person("A1", {sweptAt: swept, seen: [], news: [shown]})];
  const h = host({rows, pages: [page([work("W2", ["A1"], {publication_date: day(150)})]), page([])]});
  await h.sweepWatchedAuthors();
  assert.deepEqual(h.cache.watchedAuthors[0].news.map(w => w.id), ["W2"], "still in the inbox");
  assert.ok(!h.cache.watchedAuthors[0].seen.includes("W2"));
});

// A namesake merged into one OpenAlex profile: the paper carries the followed id but is signed from places
// this author has never been listed at.
const signed = (id, authorID, places, over = {}) => work(id, [authorID], {
  authorships: [{author: {id: "https://openalex.org/" + authorID, display_name: authorID}, author_position: "first",
    institutions: places.map(([name, ror, country]) => ({display_name: name, ror: ror ? "https://ror.org/" + ror : "", country_code: country || "US"}))}],
  ...over
});

test("a paper signed only from places the author was never at is held as unverified, not counted", async () => {
  const row = person("A1", {institution: "University of Illinois Urbana-Champaign", institutionRor: "RUIUC"});
  const h = host({rows: [row], pages: [{results: [
    signed("W1", "A1", [["University of Illinois Urbana-Champaign", "RUIUC"]]),
    signed("W2", "A1", [["Nanjing Agricultural University", "RNAU", "CN"]]),
    signed("W3", "A1", [])], meta: {}}]});
  const result = await h.sweepWatchedAuthors();
  const saved = h.cache.watchedAuthors[0];
  assert.deepEqual(saved.news.map(n => n.id).sort(), ["W1", "W3"]);
  assert.deepEqual(saved.unverified.map(n => n.id), ["W2"]);
  assert.equal(saved.unverified[0].places[0], "Nanjing Agricultural University");
  assert.equal(result.works, 2, "the held paper is not in the new-paper total");
});

test("confirming a held paper makes it news and teaches the place; rejecting remembers it", async () => {
  const mk = () => host({rows: [person("A1", {institution: "UIUC"})], pages: [{results: [signed("W2", "A1", [["Nanjing Agricultural University", "RNAU", "CN"]])], meta: {}}]});
  const yes = mk(); yes.resolveNamesake = Runtime.prototype.resolveNamesake;
  await yes.sweepWatchedAuthors();
  assert.equal(await yes.resolveNamesake("A1", "W2", true), true);
  let saved = yes.cache.watchedAuthors[0];
  assert.deepEqual(saved.news.map(n => n.id), ["W2"]);
  assert.deepEqual(saved.unverified, []);
  assert.ok(saved.placesSeen.some(pl => pl.name === "Nanjing Agricultural University"));
  // The next sweep does not hold it again.
  yes.pages = null;
  const again = host({rows: yes.cache.watchedAuthors, pages: [{results: [signed("W2", "A1", [["Nanjing Agricultural University", "RNAU", "CN"]]), signed("W5", "A1", [["Nanjing Agricultural University", "RNAU", "CN"]])], meta: {}}]});
  await again.sweepWatchedAuthors();
  assert.deepEqual(again.cache.watchedAuthors[0].unverified, []);
  assert.deepEqual(again.cache.watchedAuthors[0].news.map(n => n.id).sort(), ["W2", "W5"]);

  const no = mk(); no.resolveNamesake = Runtime.prototype.resolveNamesake;
  await no.sweepWatchedAuthors();
  await no.resolveNamesake("A1", "W2", false);
  saved = no.cache.watchedAuthors[0];
  assert.deepEqual(saved.unverified, []);
  assert.deepEqual(saved.news, []);
  assert.ok(saved.seen.includes("W2") && saved.rejected.includes("W2"));
  const later = host({rows: no.cache.watchedAuthors, pages: [{results: [signed("W2", "A1", [["Nanjing Agricultural University", "RNAU", "CN"]])], meta: {}}]});
  await later.sweepWatchedAuthors();
  assert.deepEqual(later.cache.watchedAuthors[0].unverified, [], "a rejected paper never comes back");
});

// Audit item 2, runtime side: nothing is followed on the strength of being the only candidate.
function importHost(candidates) {
  const h = host({rows: [], pages: []});
  h.cache.watchedAuthors = [];
  const requested = [];
  h.discoverJSON = async url => { requested.push(url); return {results: candidates.map(c => ({
    id: "https://openalex.org/" + c.id, display_name: c.name, works_count: 50, summary_stats: {h_index: 20},
    last_known_institutions: c.institutions.map(display_name => ({display_name})), orcid: c.orcid || null, topics: []}))}; };
  h.requested = requested;
  h.resolveAuthor = Runtime.prototype.resolveAuthor;
  h.resolveAuthorDetailed = Runtime.prototype.resolveAuthorDetailed;
  h.importWatchedAuthors = Runtime.prototype.importWatchedAuthors;
  h.authorActivity = async () => ({works: []});
  for (const name of ["pendingAuthorCandidates", "keepAuthorCandidates", "confirmAuthorCandidate", "dismissAuthorCandidate"])
    h[name] = Runtime.prototype[name];
  h.flush = async function () { this.flushed = (this.flushed || 0) + 1; };
  return h;
}

test("a different-name candidate is not auto-followed, and is not even offered", async () => {
  const h = importHost([{id: "A1", name: "David Kim", institutions: ["Harvard University"]}]);
  const result = await h.importWatchedAuthors([{name: "Alice Kim", institution: "Stanford University"}]);
  assert.equal(result.added, 0);
  assert.deepEqual(h.cache.watchedAuthors, []);
  assert.deepEqual(h.pendingAuthorCandidates(), []);
  assert.deepEqual(result.unresolved, ["Alice Kim"]);
});

test("a weak match is kept for the user to confirm; confirming follows, dismissing drops it", async () => {
  const h = importHost([{id: "A2", name: "A. Kim", institutions: ["Harvard University"]}]);
  const result = await h.importWatchedAuthors([{name: "Alice Kim", institution: "Stanford University"}]);
  assert.equal(result.added, 0);
  assert.equal(result.pending, 1);
  assert.deepEqual(h.cache.watchedAuthors, [], "nothing saved as followed");
  const [pending] = h.pendingAuthorCandidates();
  assert.equal(pending.name, "Alice Kim");
  assert.equal(pending.candidates[0].id, "A2");
  await h.confirmAuthorCandidate(pending.key, "A2");
  assert.deepEqual(h.cache.watchedAuthors.map(r => r.id), ["A2"]);
  assert.deepEqual(h.pendingAuthorCandidates(), []);
  const again = importHost([{id: "A2", name: "A. Kim", institutions: ["Harvard University"]}]);
  await again.importWatchedAuthors([{name: "Alice Kim", institution: "Stanford University"}]);
  await again.dismissAuthorCandidate(again.pendingAuthorCandidates()[0].key);
  assert.deepEqual(again.pendingAuthorCandidates(), []);
});

// Audit item 3: unseen news persists.
test("an unseen paper survives a normal refresh that finds nothing", async () => {
  const page = works => ({results: works, meta: {next_cursor: null}});
  const swept = new Date(Date.now() - 3 * 864e5).toISOString();
  const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const wold = {id: "https://openalex.org/Wold", title: "Wold", doi: "10.1/wold", date: day(20)};
  const rows = [person("A1", {sweptAt: swept, seen: [], news: [wold]})];
  const h = host({rows, pages: [page([]), page([])]});
  await h.sweepWatchedAuthors();
  assert.deepEqual(h.cache.watchedAuthors[0].news.map(w => w.id), ["https://openalex.org/Wold"]);
  assert.deepEqual(h.cache.watchedAuthors[0].seen, []);
});

test("unseen news is dropped only when seen or older than the retention, and a seen paper leaves", async () => {
  const page = works => ({results: works, meta: {next_cursor: null}});
  const swept = new Date(Date.now() - 3 * 864e5).toISOString();
  const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  // Retention counts from when a paper was announced (round 13): this one was found 200 days ago.
  const old = {id: "Wold", title: "old", doi: "10.1/old", date: day(200), foundAt: day(200)};
  const mid = {id: "Wmid", title: "mid", doi: "10.1/mid", date: day(120)};
  const gone = {id: "Wseen", title: "seen", doi: "10.1/seen", date: day(10)};
  const rows = [person("A1", {sweptAt: swept, seen: [], news: [old, mid, gone]})];
  const h = host({rows, pages: [page([]), page([])]});
  h.cache.workbenchUI = {inboxSeen: {"10.1/seen": "2026-01-01"}};
  await h.sweepWatchedAuthors();
  assert.deepEqual(h.cache.watchedAuthors[0].news.map(w => w.id), ["Wmid"], "200 days is past retention, the seen one is gone");
});

test("what is stored and what is shown have separate caps", async () => {
  const page = works => ({results: works, meta: {next_cursor: null}});
  const many = n => Array.from({length: n}, (_, i) => work("W" + i, ["A1"], {publication_date: new Date(Date.now() - (i + 1) * 864e5).toISOString().slice(0, 10)}));
  const h = host({rows: [person("A1", {seen: []})], pages: [page(many(80)), page([])]});
  await h.sweepWatchedAuthors();
  const stored = h.cache.watchedAuthors[0].news.length;
  assert.ok(stored > h.NEWS_LIMIT, "storage holds more than the display cap, " + stored);
  assert.ok(stored <= 200, "and is still bounded");
});

/* Fact-check 2026-10-05: namesake papers stayed in followed authors' stored
   news because the classifier never ran on rows swept before it existed. */
const nw = (id, over = {}) => ({id, title: id + " a long enough title", doi: "10.1/" + id.toLowerCase(), date: "2026-09-01", people: ["Zed Q"], ...over});

test("stored news is re-classified on load: stored places are judged, namesakes are held as unverified", () => {
  const row = person("A1", {name: "Huimin Zhao", institution: "University of Illinois Urbana-Champaign", institutionRor: "RUIUC",
    news: [nw("Wgood", {places: ["University of Illinois Urbana-Champaign"], country: "US", verified: "", people: ["Huimin Zhao", "Pal X"]}),
      nw("Wrice", {places: ["Nanjing Agricultural University"], country: "CN"})]});
  const h = host({rows: [row], pages: []});
  assert.equal(h.reclassifyStoredNews(), 1);
  const saved = h.cache.watchedAuthors[0];
  assert.deepEqual(saved.news.map(n => n.id), ["Wgood"]);
  assert.equal(saved.news[0].verified, "place");
  assert.deepEqual(saved.unverified.map(n => n.id), ["Wrice"]);
  assert.equal(h.dirty, true);
});

test("news swept before the classifier has nothing to judge by: marked unclassified, not silently trusted or dropped", () => {
  const row = person("A1", {name: "Huimin Zhao", news: [nw("W1"), nw("W2")]});
  const h = host({rows: [row], pages: []});
  h.reclassifyStoredNews();
  const saved = h.cache.watchedAuthors[0];
  assert.deepEqual(saved.news.map(n => [n.id, n.unclassified]), [["W1", true], ["W2", true]]);
  assert.equal(saved.placesSeen, undefined, "the row itself still reads as never classified by a sweep");
});

test("once a row has verified papers, a stored paper with no data and no shared coauthor is held; one that shares a coauthor stays", () => {
  const row = person("A1", {name: "Huimin Zhao", confirmed: [], news: [
    nw("Wv", {verified: "place", people: ["Huimin Zhao", "Real Colleague"]}),
    nw("Wshared", {people: ["Real Colleague", "Other"]}),
    nw("Wrice", {people: ["Somebody Else", "Another One"]})]});
  const h = host({rows: [row], pages: []});
  h.reclassifyStoredNews();
  const saved = h.cache.watchedAuthors[0];
  assert.deepEqual(saved.news.map(n => n.id).sort(), ["Wshared", "Wv"]);
  assert.deepEqual(saved.unverified.map(n => n.id), ["Wrice"]);
});

test("a fresh paper that names no institution is unverified unless it shares a coauthor with verified work", async () => {
  const none = (id, names) => work(id, [], {authorships: names.map((n, i) => ({author: {id: "https://openalex.org/" + (i ? "X" + n : "A1"), display_name: i ? n : "Ada"}, author_position: "first", institutions: []}))});
  const h = host({rows: [person("A1", {name: "Ada", institution: "Somewhere"})], pages: [{results: [
    work("W1", [], {authorships: [{author: {id: "https://openalex.org/A1", display_name: "Ada"}, author_position: "first", institutions: [{display_name: "Somewhere"}]}, {author: {id: "https://openalex.org/XBo", display_name: "Bo"}, author_position: "middle", institutions: []}]}),
    none("W2", ["Ada", "Bo"]), none("W3", ["Ada", "Stranger"])], meta: {}}]});
  await h.sweepWatchedAuthors();
  const saved = h.cache.watchedAuthors[0];
  assert.deepEqual(saved.news.map(n => n.id).sort(), ["W1", "W2"]);
  assert.deepEqual(saved.unverified.map(n => n.id), ["W3"]);
  assert.ok(saved.placesSeen, "a swept row records places seen");
});

test("a stored paper the classifier now rejects does not survive as 'earlier', and a held id never stays in the news", async () => {
  const row = person("A1", {name: "Ada", institution: "Somewhere", sweptAt: new Date(Date.now() - 864e5).toISOString(),
    news: [nw("Wold", {places: ["Elsewhere University"], country: "CN"}), nw("Wheld", {places: ["Somewhere"], verified: "place"})],
    unverified: [{id: "Wheld", title: "x", date: "2026-09-01"}]});
  const h = host({rows: [row], pages: [{results: [], meta: {}}]});
  await h.sweepWatchedAuthors();
  const saved = h.cache.watchedAuthors[0];
  assert.deepEqual(saved.news.map(n => n.id), [], "namesake gone, held id gone");
  assert.ok(saved.unverified.some(n => n.id === "Wold"));
});

test("news never lists a paper twice: same id, ange/anie twins, preprint beside its journal version", () => {
  const keep = list => Runtime.prototype.keepNews.call({NEWS_LIMIT: 50, panelSeenKeys: () => new Set()}, list, new Set(), 50);
  const out = keep([
    {id: "W4409654112", title: "Optogenetic control of gene expression", date: "2026-09-02", doi: "10.1/a"},
    {id: "W4409654112", title: "Optogenetic control of gene expression", date: "2026-09-02", doi: "10.1/a"},
    {id: "W2", title: "Design of a Cyclic Peptide Binder", date: "2026-09-03", doi: "10.1002/ange.1"},
    {id: "W3", title: "Design of a cyclic peptide binder.", date: "2026-09-03", doi: "10.1002/anie.1"},
    {id: "W4", title: "Pathway engineering in yeast", date: "2026-05-01", doi: "10.1101/2026.01.01", preprint: true, venue: "bioRxiv"},
    {id: "W5", title: "Pathway Engineering in Yeast", date: "2026-08-01", doi: "10.1038/x", venue: "Nature"},
    {id: "W6", title: "光合成の研究 全体の題名", date: "2026-08-02"}, {id: "W7", title: "光合成の研究 全体の題名!", date: "2026-08-02"}
  ]);
  assert.deepEqual(out.map(w => w.id).sort(), ["W2", "W4409654112", "W5", "W6"].sort());
  const journal = out.find(w => w.id === "W5");
  assert.equal(journal.preprintOf.id, "W4", "the journal version notes the preprint");
});

test("two different papers with short or distinct titles are not merged", () => {
  const out = Runtime.dedupeNews([{id: "a", title: "Editorial"}, {id: "b", title: "Editorial"}, {id: "c", title: "A study of X in cells part 1"}, {id: "d", title: "A study of X in cells part 2"}]);
  assert.equal(out.length, 4);
});

// Regression review A5: the full-works fetch must stop when its owner has gone.
function worksHost() {
  const h = Object.create(Runtime.prototype);
  Object.assign(h, {cache: {}, discoverTools: discover, active: true, stopping: false, dirty: false, Z: {logError() {}},
    discoverOptions: () => ({}), libraryDOIs: () => new Set(), async pause() {}, calls: 0});
  return h;
}
const worksPage = (n, next) => ({results: [{id: "https://openalex.org/W" + n, title: "Paper " + n, publication_year: 2020,
  authorships: [{author: {id: "https://openalex.org/A1", display_name: "Ada"}, author_position: "first", institutions: []}]}], meta: {next_cursor: next}});

test("the full-works fetch asks nothing more and writes nothing once its signal is aborted", async () => {
  const h = worksHost(), controller = new AbortController();
  h.discoverJSON = async () => { h.calls++; controller.abort(); return worksPage(h.calls, "c" + h.calls); };
  await assert.rejects(h.authorAllWorks("A1", {signal: controller.signal}), /abort/i);
  assert.equal(h.calls, 1, "no second page after the owner went away");
  assert.deepEqual(h.cache.authorWorks || {}, {}, "the cache was not written");
  assert.equal(h.dirty, false);
});

test("a closed plugin stops the full-works fetch too, and an untouched fetch still completes and caches", async () => {
  const stopped = worksHost();
  stopped.discoverJSON = async () => { stopped.calls++; stopped.stopping = true; return worksPage(stopped.calls, "next"); };
  await assert.rejects(stopped.authorAllWorks("A1"), /abort|stop/i);
  assert.equal(stopped.calls, 1);
  assert.deepEqual(stopped.cache.authorWorks || {}, {});
  const fine = worksHost();
  fine.discoverJSON = async () => { fine.calls++; return worksPage(fine.calls, fine.calls < 3 ? "c" : null); };
  const out = await fine.authorAllWorks("A1");
  assert.equal(fine.calls, 3);
  assert.equal(out.works.length, 3);
  assert.equal(Object.keys(fine.cache.authorWorks).length, 1);
});

// Stored rows that already hold twins (Keasling, Elowitz, Baker) are cleaned at load, and a mark made on the preprint carries over.
test("stored news twins are merged at load, persisted with the next flush, and the preprint's seen mark moves to the journal version", () => {
  const row = person("A1", {name: "Keasling", news: [
    {id: "W4409654112", title: "Optogenetic control of gene expression in yeast", doi: "10.1/a", date: "2026-09-02"},
    {id: "W4409654112", title: "Optogenetic control of gene expression in yeast", doi: "10.1/a", date: "2026-09-02"},
    {id: "W7", title: "Pathway engineering in yeast", doi: "10.1101/2026.01.01", date: "2026-05-01", preprint: true, venue: "bioRxiv"},
    {id: "W8", title: "Pathway Engineering in Yeast", doi: "10.1038/x", date: "2026-08-01", venue: "Nature"},
    {id: "W9", title: "Design of a Cyclic Peptide Binder", doi: "10.1002/ange.1", date: "2026-07-01"},
    {id: "W10", title: "Design of a cyclic peptide binder", doi: "10.1002/anie.1", date: "2026-07-01"}]});
  const h = host({rows: [row], pages: []});
  h.cache.workbenchUI = {inboxSeen: {"1:10.1101/2026.01.01": "2026-09-01"}};
  h.dedupeStoredNews = Runtime.prototype.dedupeStoredNews;
  h.dedupeNews = Runtime.prototype.dedupeNews;
  h.carrySeen = Runtime.prototype.carrySeen;
  h.dirty = false;
  assert.equal(h.dedupeStoredNews(), 3, "three duplicates removed");
  const saved = h.cache.watchedAuthors[0];
  assert.deepEqual(saved.news.map(n => n.id).filter(id => id === "W4409654112" || id === "W8").sort(), ["W4409654112", "W8"]);
  assert.equal(saved.news.length, 3);
  assert.ok(saved.news.some(n => n.id === "W8" && n.preprintOf), "the journal version stays and notes the preprint");
  assert.equal(h.dirty, true, "written with the next ordinary flush");
  assert.equal(h.cache.workbenchUI.inboxSeen["10.1038/x"], "2026-09-01", "marked seen on the preprint, so not unread again on the journal version");
  assert.equal(h.dedupeStoredNews(), 0, "idempotent");
});

test("keepNews carries a seen mark from a dropped twin to the one that stays", () => {
  const ctx = {NEWS_LIMIT: 50, cache: {workbenchUI: {inboxSeen: {"10.1101/p": "2026-09-01"}}}, dirty: false};
  ctx.panelSeenKeys = Runtime.prototype.panelSeenKeys;
  ctx.carrySeen = Runtime.prototype.carrySeen;
  const out = Runtime.prototype.keepNews.call(ctx, [
    {id: "W7", title: "Pathway engineering in yeast", doi: "10.1101/p", date: "2026-05-01", preprint: true},
    {id: "W8", title: "Pathway Engineering in Yeast", doi: "10.1038/j", date: "2026-08-01"}], ctx.panelSeenKeys(), 50);
  assert.deepEqual(out.map(n => n.id), ["W8"]);
  assert.equal(ctx.cache.workbenchUI.inboxSeen["10.1038/j"], "2026-09-01");
});

/* One ORCID on several OpenAlex records (round 13, round 6 leftover): following
   the person follows every record, and the sweep, the page and the circle read them all. */
test("following a merged person keeps every OpenAlex id, and an earlier row of one of them is folded in", async () => {
  const rows = [person("A2", {seen: ["W50"], news: [{id: "W51", title: "Held over from the alias row", date: RECENT}]}), person("A9")];
  const h = host({rows, pages: []});
  h.unwatchAuthor = Runtime.prototype.unwatchAuthor;
  h.watchedRowOf = Runtime.prototype.watchedRowOf;
  await h.watchAuthor({id: "A1", alsoIds: ["https://openalex.org/A2", "A3", "W4", "A1"], name: "Merged Person", seen: ["W1"]});
  const list = h.cache.watchedAuthors;
  assert.equal(list.length, 2, "the A2 row became part of the merged person");
  const merged = list.find(r => r.id === "A1");
  assert.deepEqual(merged.alsoIds, ["A2", "A3"], "only other author ids, in order");
  assert.ok(merged.seen.includes("W1") && merged.seen.includes("W50"), "what A2 already knew stays known");
  assert.deepEqual(merged.news.map(n => n.id), ["W51"], "unseen news of the folded row is kept");
  assert.equal(h.watchedRowOf("A3").id, "A1", "any of the ids finds the person");
  await h.unwatchAuthor("A3");
  assert.deepEqual(h.cache.watchedAuthors.map(r => r.id), ["A9"], "unfollowing by any id lets the whole person go");
});

test("R19 folding a followed row into a merged person keeps all its unread news (store limit, not the 50 shown) and its earlier decisions", async () => {
  const news = Array.from({length: 80}, (_, n) => ({id: "W" + (100 + n), title: "Paper " + n, date: RECENT}));
  const rows = [person("A2", {news, confirmed: ["W7"], rejected: ["W8"], unverified: [{id: "W9", title: "Held", date: RECENT}], previousInstitution: "Old Place", sweptAt: "2026-09-30T00:00:00Z", checkedAt: "2026-09-30T00:00:00Z"})];
  const h = host({rows, pages: []});
  await h.watchAuthor({id: "A1", alsoIds: ["A2"], name: "Merged Person"});
  const merged = h.cache.watchedAuthors.find(r => r.id === "A1");
  assert.equal(merged.news.length, 80, "80 unread papers stay 80");
  assert.deepEqual(merged.confirmed, ["W7"]);assert.deepEqual(merged.rejected, ["W8"]);
  assert.deepEqual(merged.unverified.map(w => w.id), ["W9"]);
  assert.equal(merged.previousInstitution, "Old Place");
  assert.equal(merged.checkedAt, "2026-09-30T00:00:00Z", "the person was checked then; folding is not a new check");
});

test("the sweep asks for every id of a merged person in one batch and files the news under the person", async () => {
  const rows = [person("A1", {alsoIds: ["A2"]}), person("A3")];
  const h = host({rows, pages: [{results: [work("W1", ["A2"]), work("W2", ["A1"]), work("W3", ["A1", "A2", "B7"])], meta: {}}]});
  const result = await h.sweepWatchedAuthors();
  const url = decodeURIComponent(h.calls.find(u => /\/works\?/.test(u)));
  assert.match(url, /author\.id:A1\|A2\|A3/);
  const profilesURL = decodeURIComponent(h.calls.find(u => /\/authors\?/.test(u)));
  assert.match(profilesURL, /ids\.openalex:A1\|A2\|A3/);
  const row = h.cache.watchedAuthors.find(r => r.id === "A1");
  assert.deepEqual(row.news.map(n => n.id).sort(), ["W1", "W2", "W3"], "a paper under the second record is the person's news");
  assert.equal(result.works, 3);
  assert.equal(row.news.find(n => n.id === "W1").position, "first", "their part is read off whichever record signed it");
  assert.ok(!h.cache.watchedAuthors.some(r => r.id === "A2"), "no second row appears for the alias");
});

test("a merged person's batches never split their ids across two requests", () => {
  const groups = [...Array.from({length: 49}, (_, n) => "A" + (n + 1)), ["A100", "A101"], "A102"];
  const batches = discover.authorBatches(groups);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 49);
  assert.deepEqual(batches[1], ["A100", "A101", "A102"]);
  // Plain ids pack fifty to a request as before.
  assert.deepEqual(discover.authorBatches(Array.from({length: 120}, (_, n) => "A" + n)).map(b => b.length), [50, 50, 20]);
});

test("the person view lists works under every id of a merged person", () => {
  const url = decodeURIComponent(discover.authorAllWorksURL("A1", {ids: ["A1", "A2"]}));
  assert.match(url, /author\.id:A1\|A2/);
  assert.match(decodeURIComponent(discover.authorWorksURL(["A1", "A2"], {limit: 25})), /author\.id:A1\|A2/);
  const payload = {results: [{id: "https://openalex.org/W1", title: "T", publication_year: 2026,
    authorships: [{author: {id: "https://openalex.org/A2"}, author_position: "last", is_corresponding: true}]}]};
  const [row] = discover.readAuthorWorks(payload, {authorID: "A1", ids: ["A1", "A2"]});
  assert.equal(row.position, "last");
  assert.equal(row.corresponding, true);
});

/* Real data, 2026-10-06: all 55 stored news of the user's 110 followed authors
   carried 미분류, and no sweep had run for 17 days. Read back by id (one filter
   request per fifty), 49 were signed from a known place and 6 were namesakes
   (four "Huimin Zhao" papers from Hainan, Nanjing Tech, Zhejiang). */
test("unclassified stored news is settled by asking for those works by id, without a sweep (round 13)", async () => {
  const stored = (id, title) => ({id, title, doi: "10.1/" + id.toLowerCase(), date: RECENT, people: ["Someone Else"], unclassified: true});
  const rows = [person("A1", {institution: "University of Illinois Urbana-Champaign", news: [stored("W1", "Own paper"), stored("W2", "Namesake paper"), {id: "W3", title: "Already checked", date: RECENT, verified: "place"}]}),
    person("A2", {alsoIds: ["A5"], institution: "MIT", news: [stored("W4", "Under the second record")]})];
  const at = (id, authorID, place) => work(id, [authorID], {authorships: [{author: {id: "https://openalex.org/" + authorID, display_name: authorID},
    author_position: "last", institutions: [{display_name: place}]}]});
  const h = host({rows, pages: [{results: [at("W1", "A1", "University of Illinois Urbana-Champaign"), at("W2", "A1", "Hainan University"), at("W4", "A5", "Massachusetts Institute of Technology")], meta: {}}]});
  h.classifyStoredNews = Runtime.prototype.classifyStoredNews;
  const result = await h.classifyStoredNews();
  assert.equal(h.calls.length, 1, "one request for every unclassified paper");
  assert.match(decodeURIComponent(h.calls[0]), /ids\.openalex:W1\|W2\|W4/);
  assert.deepEqual({asked: result.asked, settled: result.settled, held: result.held}, {asked: 3, settled: 2, held: 1});
  const [a1, a2] = h.cache.watchedAuthors;
  assert.deepEqual(a1.news.map(n => n.id), ["W1", "W3"], "the namesake paper leaves the news");
  assert.equal(a1.news[0].unclassified, undefined);
  assert.equal(a1.news[0].verified, "place");
  assert.deepEqual(a1.unverified.map(n => n.id), ["W2"], "and waits under 확인 필요");
  assert.equal(a2.news[0].verified, "place", "a merged person's second record counts as theirs");
  assert.ok(h.saved, "written once at the end");
  // Nothing left to ask: no request at all.
  const again = await h.classifyStoredNews();
  assert.equal(again.asked, 0);
  assert.equal(h.calls.length, 1);
});

test("a sweep settles stored 미분류 news first, in one extra request only when there is some (round 13)", async () => {
  const rows = [person("A1", {news: [{id: "W1", title: "Old stored paper", date: "2025-01-01", unclassified: true}]})];
  const h = host({rows, pages: [{results: [work("W1", ["A1"])], meta: {}}, {results: [], meta: {}}]});
  h.classifyStoredNews = Runtime.prototype.classifyStoredNews;
  const result = await h.sweepWatchedAuthors();
  assert.ok(h.calls.some(u => /ids\.openalex:W1/.test(decodeURIComponent(u))), "the stored paper is read back by id");
  assert.equal(result.classified.settled, 1);
  assert.equal(h.cache.watchedAuthors[0].news.find(n => n.id === "W1")?.unclassified, undefined);
});

test("following or unfollowing while a sweep runs is not undone when it finishes (round 13, Astra)", async () => {
  const rows = [person("A1"), person("A3")];
  const h = host({rows, pages: [{results: [work("W1", ["A1"]), work("W3", ["A3"])], meta: {}}]});
  h.unwatchAuthor = Runtime.prototype.unwatchAuthor;
  h.watchedRowOf = Runtime.prototype.watchedRowOf;
  const ask = h.discoverJSON;
  let once = false;
  h.discoverJSON = async function (url) {
    if (!once) { once = true; await this.unwatchAuthor("A1"); await this.watchAuthor({id: "A2", name: "Added meanwhile"}); }
    return ask.call(this, url);
  };
  await h.sweepWatchedAuthors();
  assert.deepEqual(h.cache.watchedAuthors.map(r => r.id).sort(), ["A2", "A3"], "A1 stays gone and A2 stays followed");
  assert.deepEqual(h.cache.watchedAuthors.find(r => r.id === "A3").news.map(n => n.id), ["W3"], "the sweep's own answer still lands");
  // Two presses share one run.
  const h2 = host({rows: [person("A1")], pages: [{results: [], meta: {}}]});
  const [a, b] = await Promise.all([h2.sweepWatchedAuthors(), h2.sweepWatchedAuthors()]);
  assert.equal(a, b);
  assert.equal(h2.calls.filter(u => /\/works\?/.test(u)).length, 1);
});

test("an unseen paper is kept 180 days from when it was announced, not from its publication date (round 13, Astra)", async () => {
  /* 37 of the user's 55 stored news were published over 180 days ago but
     announced on 2026-09-19 and never looked at; the next sweep would have
     deleted them without a 확인함. */
  const swept = new Date(Date.now() - 17 * 864e5).toISOString();
  const longAgo = new Date(Date.now() - 400 * 864e5).toISOString();
  const rows = [person("A1", {sweptAt: swept, news: [
    {id: "W1", title: "Published long ago, announced lately", date: "2025-04-01", verified: "place"},
    {id: "W2", title: "Announced long ago", date: "2025-03-01", verified: "place", foundAt: longAgo}]})];
  const h = host({rows, pages: [{results: [work("W5", ["A1"])], meta: {}}]});
  await h.sweepWatchedAuthors();
  const news = h.cache.watchedAuthors[0].news;
  assert.deepEqual(news.map(n => n.id).sort(), ["W1", "W5"]);
  assert.ok(news.find(n => n.id === "W5").foundAt, "a paper says when it was first announced");
  assert.equal(news.find(n => n.id === "W1").foundAt, swept, "an older one counts from the sweep that stored it");
});

/* Round 15 leftover (Astra #4): stored news kept only the first six names and
   no ids, so a followed PI signing last vanished from their own paper and the
   per-author graph lost it (33 of 55 stored news items on the real cache). */
test("stored news keeps the co-author list with ids, so a last-author PI's paper still draws their graph", async () => {
  const portrait = require("../src/author-portrait.js");
  const team = ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "A1"];
  const h = host({rows: [person("A1")], pages: [{results: [work("W1", team)], meta: {}}]});
  await h.sweepWatchedAuthors();
  const news = h.cache.watchedAuthors[0].news[0];
  assert.equal(news.people.length, 6, "the short name list for the namesake check is unchanged");
  assert.equal(news.coauthors.length, 8, "everyone, with ids");
  assert.deepEqual(news.coauthors.at(-1), {id: "A1", name: "A1"});
  assert.equal(news.authorCount, 8);
  const g = portrait.egoGraph({me: {id: "A1", name: "A1 Name"}, works: [], news: h.cache.watchedAuthors[0].news});
  assert.equal(g.nodes.length, 7, "the seven co-authors, though the followed author signs eighth");
  // A consortium paper is too crowded to say who works with whom; only the count rides along.
  const crowd = Array.from({length: 40}, (_, i) => "C" + i).concat("A1");
  const h2 = host({rows: [person("A1")], pages: [{results: [work("W2", crowd)], meta: {}}]});
  await h2.sweepWatchedAuthors();
  const big = h2.cache.watchedAuthors[0].news[0];
  assert.deepEqual(big.coauthors, []);
  assert.equal(big.authorCount, 41);
  assert.equal(portrait.egoGraph({me: {id: "A1", name: "A1 Name"}, news: [big]}).nodes.length, 0, "a crowd is not a co-author circle, even when the followed author is among the first six");
});

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
function host({rows, pages}) {
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
    clearAuthorNews: Runtime.prototype.clearAuthorNews,
    async discoverJSON(url) { calls.push(url); const next = pages.shift(); if (next instanceof Error) throw next; return next; },
    async flush() { this.saved = JSON.parse(JSON.stringify(this.cache.watchedAuthors)); }
  };
}

const person = (id, over = {}) => ({id, name: id + " Name", institution: "Somewhere", seen: [], ...over});

test("a hundred followed authors are answered in three requests, not a hundred", async () => {
  const rows = Array.from({length: 109}, (_, n) => person("A" + (n + 1)));
  const page = works => ({results: works, meta: {next_cursor: null}});
  const h = host({rows, pages: [page([work("W1", ["A1"])]), page([]), page([])]});
  const result = await h.sweepWatchedAuthors();
  // 109 authors / 50 per filter = 3 batches. One request each, because each
  // first page came back short of the limit.
  assert.equal(result.requests, 3);
  assert.equal(h.calls.length, 3);
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
  assert.equal(result.requests, 2);
  assert.match(h.calls[1], /cursor=c2/);
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
  const asked = decodeURIComponent(h.calls[0]).match(/from_publication_date:(\d{4}-\d{2}-\d{2})/)[1];
  // Following someone two and a half years ago and sweeping today must not skip
  // the two years in between just because the default window is eighteen months.
  assert.ok(Date.parse(asked) < Date.now() - 880 * 24 * 3600 * 1000, "asked from " + asked);
});

test("a stale entry cannot ask OpenAlex for a whole career", async () => {
  const h = host({rows: [person("A1", {checkedAt: "1998-01-01T00:00:00Z"})], pages: [{results: [], meta: {}}]});
  await h.sweepWatchedAuthors();
  const asked = decodeURIComponent(h.calls[0]).match(/from_publication_date:(\d{4}-\d{2}-\d{2})/)[1];
  assert.ok(Date.parse(asked) > Date.now() - 6.1 * 365 * 24 * 3600 * 1000, "asked from " + asked);
});

test("an author who has never been checked uses the default window", async () => {
  const h = host({rows: [{id: "A1", name: "Fresh", seen: []}], pages: [{results: [], meta: {}}]});
  await h.sweepWatchedAuthors({months: 18});
  const asked = decodeURIComponent(h.calls[0]).match(/from_publication_date:(\d{4}-\d{2}-\d{2})/)[1];
  const days = (Date.now() - Date.parse(asked)) / (24 * 3600 * 1000);
  assert.ok(days > 530 && days < 560, "asked from " + asked);
});

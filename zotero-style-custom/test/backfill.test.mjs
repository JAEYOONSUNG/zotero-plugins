import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Runtime = require("../src/runtime.js");
const signals = require("../src/paper-signals.js");
const discover = require("../src/discover.js");

// The user's library: 1,214 papers with no retraction check, 255 journals with
// no figure and 109 followed authors never swept, because each waited on a
// context-menu item nobody had a reason to look for.
function host({items = [], fetched = new Map(), budgetAt = null} = {}) {
  let asked = 0;
  const cache = {items: {}, watchedAuthors: []};
  const h = {
    cache, active: true, stopping: false, dirty: false, windows: new Map(),
    // Real Zotero returns a Promise here. The fixture used to hand back a plain
    // array, which is precisely why six broken sweeps passed every test.
    Z: {logError() {}, Libraries: {userLibraryID: 1}, Items: {getAll: async () => items}, getMainWindow: () => null},
    signalTools: signals, discoverTools: discover,
    isRegular: item => item.regular !== false,
    entry: Runtime.prototype.entry,
    identity: item => String(item.id),
    citationRecord: item => ({doi: item.doi || ''}),
    outOfBudget: Runtime.prototype.outOfBudget,
    pause: () => Promise.resolve(),
    itemsNeedingSignals: Runtime.prototype.itemsNeedingSignals,
    libraryItems: Runtime.prototype.libraryItems,
    refreshPaperSignals: Runtime.prototype.refreshPaperSignals,
    backfill: Runtime.prototype.backfill,
    runBackfill: Runtime.prototype.runBackfill,
    backfillSummary: Runtime.prototype.backfillSummary,
    stopBackfill: Runtime.prototype.stopBackfill,
    showBackfillProgress: Runtime.prototype.showBackfillProgress,
    watchedAuthors: () => [],
    async fetchPaperSignals(item) {
      asked++;
      if (budgetAt && asked >= budgetAt) throw Object.assign(new Error("Insufficient budget"), {status: 429});
      return fetched.get(item.id) || {signals: null, reason: "not-found"};
    },
    async refreshJournalCitedness() { return {journals: 3, found: 2, missing: 1, failed: 0, remaining: 0, budgetGone: false}; },
    async sweepWatchedAuthors() { return {authors: 0, withNews: 0, works: 0, requests: 0, budgetGone: false, remaining: 0}; },
    async flush() {}, async refreshWindows() {},
    get asked() { return asked; }
  };
  return h;
}

const paper = (id, doi = "10.1/" + id) => ({id, doi, regular: true});

test("only papers that can actually be answered are queued", async () => {
  const h = host({items: [paper(1), paper(2, ""), {id: 3, doi: "10.1/c", regular: false}, paper(4)]});
  h.cache.items["4"] = {signals: {status: "standing"}};
  // No DOI means nothing to ask Crossref; an attachment is not a paper; and one
  // already answered must not be paid for twice.
  assert.deepEqual((await h.itemsNeedingSignals(1)).map(i => i.id), [1]);
});

test("a retraction found during the backfill is recorded on the paper", async () => {
  const found = new Map([[1, {signals: {status: "retracted", noticeDOI: "10.1/n"}, reason: "ok"}]]);
  const h = host({items: [paper(1), paper(2)], fetched: found});
  const report = await h.backfill({});
  assert.equal(h.cache.items["1"].signals.status, "retracted");
  assert.equal(report.signals.ok, 1);
  assert.equal(report.signals["not-found"], 1);
  assert.equal(report.stage, "done");
});

test("running out of budget stops the whole backfill rather than sweeping on blind", async () => {
  const h = host({items: [paper(1), paper(2), paper(3), paper(4)], budgetAt: 3});
  const report = await h.backfill({});
  assert.equal(report.budgetGone, true);
  assert.equal(report.signals.remaining, 2);
  assert.equal(report.stage, "signals");
  // The later stages must not run: they would each spend the same dead budget.
  assert.equal(report.journals, null);
  assert.equal(report.authors, null);
  assert.match(h.backfillSummary(report), /하루 한도/);
});

test("the stages run cheapest and highest-stakes first", async () => {
  const order = [];
  const h = host({items: [paper(1)]});
  h.refreshJournalCitedness = async () => { order.push("journals"); return {journals: 0, found: 0, missing: 0, failed: 0, remaining: 0, budgetGone: false}; };
  h.sweepWatchedAuthors = async () => { order.push("authors"); return {authors: 0, withNews: 0, works: 0, requests: 0, budgetGone: false, remaining: 0}; };
  const inner = h.fetchPaperSignals.bind(h);
  h.fetchPaperSignals = async item => { order.push("signals"); return inner(item); };
  await h.backfill({});
  // A retracted paper is the one fact worth interrupting someone for, so it is
  // never behind a 255-journal sweep in the queue.
  assert.deepEqual(order, ["signals", "journals", "authors"]);
});

test("cancelling stops at the next paper and keeps what was already learned", async () => {
  const found = new Map([[1, {signals: {status: "standing"}, reason: "ok"}]]);
  const h = host({items: [paper(1), paper(2), paper(3)], fetched: found});
  const controller = new AbortController();
  const inner = h.fetchPaperSignals.bind(h);
  h.fetchPaperSignals = async item => { const out = await inner(item); controller.abort(); return out; };
  const report = await h.backfill({signal: controller.signal});
  assert.equal(report.signals.ok, 1);
  assert.equal(report.signals.remaining, 2);
  assert.equal(h.cache.items["1"].signals.status, "standing");
  assert.equal(report.journals, null, "a cancelled run does not roll on to the next stage");
});

test("two runs cannot race the same sweep", async () => {
  const h = host({items: [paper(1)]});
  const first = h.runBackfill({});
  const second = h.runBackfill({});
  assert.equal(first, second, "the second caller joins the run in flight");
  await first;
  assert.equal(h.backfilling, null, "and the slot is free again afterwards");
});

test("a 429 from OpenAlex is never mistaken for a clean bill of health", async () => {
  const calls = [];
  const h = host({items: []});
  h.Z.HTTP = {request: async () => ({status: 429, response: null})};
  h.signalsJSON = Runtime.prototype.signalsJSON;
  await assert.rejects(() => h.signalsJSON("https://api.openalex.org/works"), err => err.status === 429);
  // 404 still means "this paper has no such record", which is a real answer.
  h.Z.HTTP = {request: async () => (calls.push(1), {status: 404, response: null})};
  assert.equal(await h.signalsJSON("https://api.crossref.org/works/10.1/x"), null);
});

test("a spent OpenAlex budget still records the retraction, which is the point of the column", async () => {
  const h = host({items: []});
  const seen = [];
  h.bibliographyRecord = () => ({DOI: "10.1/retracted", title: "A paper", date: "2024"});
  h.discoverOptions = () => ({});
  h.signalsJSON = Runtime.prototype.signalsJSON;
  h.fetchPaperSignals = Runtime.prototype.fetchPaperSignals;
  h.Z.HTTP = {request: async (method, url) => {
    seen.push(url);
    if (/crossref/.test(url)) return {status: 200, response: {message: {DOI: "10.1/retracted", type: "journal-article",
      "update-to": undefined, relation: {}, title: ["A paper"],
      "updated-by": [{type: "retraction", DOI: "10.1/notice", updated: {"date-parts": [[2025, 1, 1]]}}]}}};
    return {status: 429, response: null};
  }};
  const out = await h.fetchPaperSignals({id: 1});
  assert.equal(out.reason, "ok");
  assert.equal(out.signals.status, "retracted", "Crossref alone answers the question worth interrupting someone for");
  assert.equal(out.signals.openAccess, null, "the half that needed OpenAlex is simply absent, not guessed");
  assert.equal(out.signals.partial, true, "and the entry says the open-access half is still missing");
  assert.ok(seen.some(url => /crossref/.test(url)));
});

test("a partial entry is asked again; a complete one is not", async () => {
  const h = host({items: [paper(1), paper(2), paper(3)]});
  h.cache.items["1"] = {signals: {status: "ok", partial: true}};
  h.cache.items["2"] = {signals: {status: "ok", openAccess: "gold"}};
  assert.deepEqual((await h.itemsNeedingSignals(1)).map(i => i.id), [1, 3]);
});

test("when neither service answered and the budget was the reason, the sweep stops", async () => {
  const h = host({items: []});
  h.bibliographyRecord = () => ({DOI: "10.1/x", title: "t", date: "2024"});
  h.discoverOptions = () => ({});
  h.signalsJSON = Runtime.prototype.signalsJSON;
  h.fetchPaperSignals = Runtime.prototype.fetchPaperSignals;
  // Crossref has never heard of it and OpenAlex is out: nothing was learned,
  // so this must not be filed as "no notices found".
  h.Z.HTTP = {request: async (method, url) =>
    /crossref/.test(url) ? {status: 404, response: null} : {status: 429, response: null}};
  await assert.rejects(() => h.fetchPaperSignals({id: 1}), err => err.status === 429);
});

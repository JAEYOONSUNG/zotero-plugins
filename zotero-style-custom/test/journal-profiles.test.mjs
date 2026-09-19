import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);
const Runtime = require("../src/runtime.js");
const metrics = require("../src/journal-metrics.js");

/* Journals cached before the profile existed hold a figure and nothing else.
   The fill asks OpenAlex for fifty at a time by ISSN, writes the profile onto
   each cached entry it answers for, and marks the rest as asked. */
function host(store, pages) {
  const calls = [];
  return {
    calls, cache: {journalMetrics: store}, dirty: false, Z: {logError() {}},
    journalCache: Runtime.prototype.journalCache, journalProfileFields: Runtime.prototype.journalProfileFields,
    refreshJournalProfiles: Runtime.prototype.refreshJournalProfiles, journalTools2: metrics,
    discoverOptions: () => ({}), outOfBudget: Runtime.prototype.outOfBudget, pause: () => Promise.resolve(),
    async discoverJSON(url) { calls.push(url); const next = pages.shift(); if (next instanceof Error) throw next; return next; },
    async flush() { this.flushed = true; }
  };
}
const raw = (name, issn, over = {}) => ({id: "https://openalex.org/S" + issn, display_name: name, issn_l: issn, issn: [issn], type: "journal",
  works_count: 10, summary_stats: {"2yr_mean_citedness": 3.2, h_index: 50}, host_organization_name: "House", country_code: "nl",
  topics: [{display_name: "T", field: {display_name: "Chemistry"}, count: 4}], ...over});

test("cached figures are given their profiles fifty at a time, and the rest marked as asked", async () => {
  const store = {
    "issn:14764687": {citedness: 12.3, issn: "14764687", name: "Nature"},
    "name:science": {citedness: 9.9, issn: "00368075", name: "Science"},
    "name:no issn anywhere": {citedness: 1.1, name: "Obscure"},
    "issn:11112222": {citedness: 2.0, issn: "11112222", name: "Unanswered"},
    "issn:99990000": {citedness: 5.0, issn: "99990000", name: "Done", profileAt: "2026-09-20T00:00:00Z", topics: [{name: "T", field: "F", subfield: "", domain: "", count: 1}]},
    // Filled before the topic hierarchy was kept: asked once more, and only once.
    "issn:77770000": {citedness: 4.0, issn: "77770000", name: "Old profile", profileAt: "2026-09-01T00:00:00Z", topics: [{name: "T", field: "F", count: 1}]},
    "name:missing": {citedness: null}
  };
  const h = host(store, [{results: [raw("Nature", "1476-4687"), raw("Science", "0036-8075", {is_oa: true, apc_usd: 0})]}]);
  const result = await h.refreshJournalProfiles();
  assert.equal(h.calls.length, 1, "one request for the three ISSNs");
  assert.match(decodeURIComponent(h.calls[0]), /issn:1476-4687\|0036-8075\|1111-2222\|7777-0000/);
  assert.deepEqual({journals: result.journals, filled: result.filled, requests: result.requests}, {journals: 5, filled: 2, requests: 1});
  assert.ok(store["issn:77770000"].profileAt > "2026-09-19T03:00:00Z", "the old profile was asked again and is now marked");
  assert.deepEqual({publisher: store["issn:14764687"].publisher, country: store["issn:14764687"].country, fields: store["issn:14764687"].fields, hIndex: store["issn:14764687"].hIndex},
    {publisher: "House", country: "NL", fields: ["Chemistry"], hIndex: 50});
  assert.equal(store["name:science"].isOA, true);
  assert.equal(store["name:science"].openAlexID, "S0036-8075");
  assert.ok(store["name:no issn anywhere"].profileAt, "no ISSN: marked, never asked");
  assert.ok(store["issn:11112222"].profileAt, "asked and unanswered: marked, so it is not asked again");
  assert.equal(store["issn:11112222"].publisher, undefined);
  assert.equal(store["issn:99990000"].profileAt, "2026-09-20T00:00:00Z", "already filled: untouched");
  assert.equal(store["name:missing"].profileAt, undefined, "a miss has no figure to profile");
  assert.equal(h.flushed, true);
  // A second run has nothing to do and costs nothing.
  const again = await h.refreshJournalProfiles();
  assert.deepEqual({journals: again.journals, requests: again.requests}, {journals: 0, requests: 0});
});

test("the profile fill stops at the budget and leaves the rest unmarked for next time", async () => {
  const store = {"issn:14764687": {citedness: 12.3, issn: "14764687"}};
  const h = host(store, [Object.assign(new Error("Insufficient budget"), {status: 429})]);
  const result = await h.refreshJournalProfiles();
  assert.equal(result.budgetGone, true);
  assert.equal(store["issn:14764687"].profileAt, undefined);
});

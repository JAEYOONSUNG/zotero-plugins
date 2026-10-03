import { test } from "node:test";
import assert from "node:assert/strict";
import Authors from "../content/authors.js";
import Metrics from "../content/metrics.js";
import { uiHarness } from "./helpers/search-ui-harness.mjs";

const rec = (n, names, venue, year, extra = {}) => ({ key: "r" + n, doi: "10.5555/p" + n, title: "Paper " + n, venue, year, citations: n * 10, citationSource: "scholar",
	authors: names.map(name => ({ name })), ...extra });
// Two Jensens under one typed name: a biologist (SI Jensen / S Jensen / Sheila Ingemann Jensen) and a physicist (S Jensen), and a third S K Jensen.
const FIXTURE = (extra = {}) => [
	rec(1, ["SI Jensen", "A Berg", "K Holm"], "Nature", 2015, extra), rec(2, ["Sheila Ingemann Jensen", "A Berg"], "Nature", 2018, extra), rec(3, ["S Jensen", "K Holm", "B Lund"], "Cell", 2016, extra),
	rec(4, ["S Jensen", "Q Zhu", "W Tan"], "Phys Rev B", 2001, extra), rec(5, ["Jensen S", "Q Zhu"], "Phys Rev B", 2004, extra), rec(6, ["SK Jensen", "X Ray"], "Optics Letters", 2010, extra)
];
const TYPED = "Sheila Ingemann Jensen";
const NAME_SEARCH = { provider: "scholar", id: null, name: TYPED, mode: "name-search", identityConfirmed: false };

test("clustering: initials are compatible, shared co-authors join, incompatible initials stay apart and go to the rest", () => {
	const { clusters, rest } = Authors.clusterPeople(FIXTURE(), TYPED);
	assert.equal(clusters.length, 2);
	assert.deepEqual(clusters[0].keys, ["r1", "r2", "r3"]);
	assert.equal(clusters[0].name, "Sheila Ingemann Jensen"); assert.deepEqual(clusters[0].forms.map(f => f.form).sort(), ["S Jensen", "SI Jensen", "Sheila Ingemann Jensen"]);
	assert.deepEqual(clusters[0].coauthors.slice(0, 2), ["A Berg", "K Holm"]); assert.equal(clusters[0].venue, "Nature"); assert.deepEqual([clusters[0].minYear, clusters[0].maxYear], [2015, 2018]);
	assert.deepEqual(clusters[1].keys, ["r4", "r5"]); assert.equal(clusters[1].name, "S Jensen");
	assert.deepEqual(rest.keys, ["r6"], "SK is not SI: this paper is no one's yet");
});

test("clustering: forms compatibility, name order, namesakes with distinct co-authors and a merge through a bridging paper", () => {
	const P = Authors.nameParts;
	assert.equal(Authors.formsCompatible(P("S Jensen"), P("SI Jensen")), true);
	assert.equal(Authors.formsCompatible(P("Sheila Jensen"), P("SI Jensen")), true);
	assert.equal(Authors.formsCompatible(P("Jensen SI"), P("Sheila Ingemann Jensen")), true);
	assert.equal(Authors.formsCompatible(P("SK Jensen"), P("SI Jensen")), false);
	assert.equal(Authors.formsCompatible(P("Sara Jensen"), P("Sheila Jensen")), false, "two different first names");
	assert.equal(Authors.formsCompatible(P("S Jensen"), P("S Nielsen")), false);
	// Without a bridge the two groups stay two people ...
	const apart = [rec(1, ["S Jensen", "A"], "J", 2000), rec(2, ["S Jensen", "A"], "J", 2001), rec(3, ["S Jensen", "B"], "K", 2005), rec(4, ["S Jensen", "B"], "K", 2006)];
	assert.equal(Authors.clusterPeople(apart, "S Jensen").clusters.length, 2);
	// ... a paper with both co-authors joins them into one.
	const bridged = [...apart, rec(5, ["S Jensen", "A", "B"], "J", 2003)];
	const merged = Authors.clusterPeople(bridged, "S Jensen");
	assert.equal(merged.clusters.length, 1); assert.equal(merged.clusters[0].n, 5);
	// a shared OpenAlex author id is enough, whatever the written form
	const byId = [rec(1, ["Sheila Jensen"], "J", 2000), rec(2, ["S Jensen"], "K", 2020)].map((r, i) => ({ ...r, authors: [{ name: r.authors[0].name, openalexId: "A77" }] }));
	assert.equal(Authors.clusterPeople(byId, "S Jensen").clusters.length, 1);
	// a lone paper under an unambiguous form joins the one cluster it is compatible with
	const lone = [...apart.slice(0, 2), rec(9, ["SI Jensen", "Z"], "M", 2012)];
	assert.deepEqual(Authors.clusterPeople(lone, "S Jensen").clusters[0].keys, ["r1", "r2", "r9"]);
	// CJK names are matched as typed
	const cjk = [{ key: "c1", authors: [{ name: "김민수" }, { name: "Lee" }], venue: "J", year: 2020 }, { key: "c2", authors: [{ name: "김민수" }, { name: "Lee" }], venue: "J", year: 2021 }, { key: "c3", authors: [{ name: "박민수" }], venue: "J", year: 2021 }];
	const found = Authors.clusterPeople(cjk, "김민수");
	assert.deepEqual(found.clusters[0].keys, ["c1", "c2"]); assert.deepEqual(found.rest.keys, ["c3"]);
});

test("metrics basis defaults to Scholar's own counts for Scholar results; the explanation names the causes", () => {
	assert.equal(Authors.defaultMetricsBasis(["scholar", "openalex"], { provider: "scholar" }), "scholar");
	assert.equal(Authors.defaultMetricsBasis(["scholar", "openalex"], { provider: "scholar", chosen: null }), null, "a deliberate choice of the highest count is kept");
	assert.equal(Authors.defaultMetricsBasis(["scholar", "openalex"], { provider: "scholar", chosen: "openalex" }), "openalex");
	assert.equal(Authors.defaultMetricsBasis(["openalex", "crossref"], { provider: "combined" }), null);
	assert.equal(Authors.defaultMetricsBasis(["openalex"], { provider: "scholar" }), null, "no Scholar counts to use");
	const base = { stats: { citations: 100, hIndex: 5 }, computed: { citations: 100, hIndex: 5 }, loaded: 20, total: null, truncated: false, filtered: false, unverified: false, basis: "scholar", source: "scholar" };
	assert.deepEqual(Authors.explainMetrics(base), []);
	assert.deepEqual(Authors.explainMetrics({ ...base, unverified: true }), ["namesakes"]);
	assert.deepEqual(Authors.explainMetrics({ ...base, truncated: true, filtered: true }), ["capped", "filtered"]);
	assert.deepEqual(Authors.explainMetrics({ ...base, total: 50 }), ["capped"]);
	assert.deepEqual(Authors.explainMetrics({ ...base, basis: null }), ["basis"]);
	assert.deepEqual(Authors.explainMetrics({ ...base, computed: { citations: 90, hIndex: 5 } }), ["unknown"]);
});

test("the author tab opens on the combined provider; a saved choice is kept and the Scholar-only field is hidden", () => {
	for (const [saved, expected] of [["", "combined"], ["{}", "combined"], [JSON.stringify({ provider: "nonsense" }), "combined"], [JSON.stringify({ provider: "scholar" }), "scholar"], [JSON.stringify({ provider: "orcid" }), "orcid"], [JSON.stringify({ provider: "combined" }), "combined"]]) {
		const ui = uiHarness({ prefs: { lastAuthorQuery: saved } });
		ui.restoreAuthorPreferences();
		assert.equal(ui.get("author-provider").value, expected, saved);
	}
	const ui = uiHarness({ prefs: { lastAuthorQuery: "" } });
	ui.restoreAuthorPreferences(); ui.switchAuthorProvider("combined");
});

async function nameSearchUi(prefs = {}) {
	const ui = uiHarness({ metrics: Metrics, realRows: true, prefs: { popDataDir: "", ...prefs } });
	await ui.switchSearchMode("authors");
	ui.get("author-input").value = TYPED;
	ui.authorSessions.scholar.action = "name-papers";
	ui.displaySearchResults(FIXTURE({ authorProfile: NAME_SEARCH }));
	return ui;
}

test("an unverified name search shows a person picker instead of numbers; choosing filters the table and computes only those papers", async () => {
	const ui = await nameSearchUi();
	assert.equal(ui.unverifiedAuthorResults(), true);
	ui.originalRenderMetrics(ui.state.visible);
	assert.equal(ui.get("metrics-table").hidden, true); assert.match(ui.get("metrics-hint").textContent, /personNeeded/);
	const cards = ui.get("metrics-person").querySelectorAll(".pp-card");
	assert.equal(cards.length, 3, "two people and the rest");
	assert.match(cards[0].textContent, /Sheila Ingemann Jensen/); assert.match(cards[0].textContent, /personPapers\|3/); assert.match(cards[0].textContent, /A Berg, K Holm/); assert.match(cards[0].textContent, /Nature/);
	assert.equal(ui.state.visible.length, 6, "nothing is hidden before a choice");
	// pick the first person only
	cards[0].emit("click");
	ui.get("metrics-person").querySelector(".pp-confirm").emit("click");
	assert.deepEqual(ui.state.visible.map(r => r.key).sort(), ["r1", "r2", "r3"]);
	assert.equal(ui.get("person-chip").hidden, false); assert.match(ui.get("person-text").textContent, /personChip\|Sheila Ingemann Jensen\|3/);
	ui.originalRenderMetrics(ui.state.visible);
	assert.equal(ui.get("metrics-table").hidden, false); assert.equal(ui.get("m-papers").textContent, "3"); assert.equal(ui.get("m-citations").textContent, "60");
	assert.equal(ui.metricsOwner(), "Sheila Ingemann Jensen");
	// manual out: this paper is not theirs
	const r3 = ui.state.records.find(r => r.key === "r3");
	ui.setPersonMembership(r3, false);
	assert.deepEqual(ui.state.visible.map(r => r.key).sort(), ["r1", "r2"]);
	ui.originalRenderMetrics(ui.state.visible); assert.equal(ui.get("m-papers").textContent, "2"); assert.equal(ui.get("m-citations").textContent, "30");
	// manual in: show the others, then add one
	ui.setPick({ ...ui.personPick(), others: true });
	assert.equal(ui.state.visible.length, 6);
	ui.originalRenderMetrics(ui.state.visible); assert.equal(ui.get("m-papers").textContent, "2", "figures stay on the chosen person's papers");
	ui.setPersonMembership(ui.state.records.find(r => r.key === "r6"), true);
	ui.originalRenderMetrics(ui.state.visible); assert.equal(ui.get("m-papers").textContent, "3");
	// the chip clears the choice: the picker is back
	ui.setPick(null); assert.equal(ui.get("person-chip").hidden, true); assert.equal(ui.state.visible.length, 6);
	ui.originalRenderMetrics(ui.state.visible); assert.equal(ui.get("metrics-table").hidden, true);
});

test("several clusters can be chosen together as one person; the chip says how many more", async () => {
	const ui = await nameSearchUi();
	ui.originalRenderMetrics(ui.state.visible);
	const cards = ui.get("metrics-person").querySelectorAll(".pp-card");
	cards[0].emit("click"); cards[1].emit("click");
	ui.get("metrics-person").querySelector(".pp-confirm").emit("click");
	assert.equal(ui.state.visible.length, 5);
	assert.match(ui.get("person-text").textContent, /personChip\|personChipMore\|Sheila Ingemann Jensen\|1\|5/);
	assert.equal(ui.personPick().extra, 1);
});

test("the chosen person persists in the author session, the saved preferences and the recent search", async () => {
	const prefs = { popDataDir: "" }, files = new Map();
	const ui = uiHarness({ metrics: Metrics, realRows: true, prefs, historyFiles: files });
	await ui.switchSearchMode("authors");
	ui.get("author-input").value = TYPED; ui.authorSessions.scholar.action = "name-papers";
	ui.displaySearchResults(FIXTURE({ authorProfile: NAME_SEARCH }));
	ui.originalRenderMetrics(ui.state.visible);
	ui.get("metrics-person").querySelectorAll(".pp-card")[0].emit("click");
	ui.get("metrics-person").querySelector(".pp-confirm").emit("click");
	assert.deepEqual([...ui.authorSessions.scholar.pick.keys].sort(), ["d:10.5555/p1", "d:10.5555/p2", "d:10.5555/p3"]);
	const saved = JSON.parse(prefs.lastAuthorQuery); assert.deepEqual(saved.sessions.scholar.pick.keys.length, 3);
	const again = uiHarness({ metrics: Metrics, realRows: true, prefs, historyFiles: files });
	again.restoreAuthorPreferences();
	const plain = value => JSON.parse(JSON.stringify(value));
	assert.deepEqual(plain(again.authorSessions.scholar.pick), { name: "Sheila Ingemann Jensen", extra: 0, keys: plain(ui.authorSessions.scholar.pick.keys), others: false });
	assert.equal(again.validPick({ keys: "no" }), null);
	for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
	const entries = await ui.history.list();
	const entry = entries.find(e => e.query?.authorAction === "name-papers");
	assert.ok(entry, "the search with the choice is kept");
	assert.equal((await ui.history.get(entry.id)).query.authorPick.keys.length, 3);
});

test("a verified profile keeps its figures and names its owner; the profile's own table, the N-of-M note and the Scholar basis show", async () => {
	const ui = uiHarness({ metrics: Metrics, realRows: true, prefs: { popDataDir: "" } });
	await ui.switchSearchMode("authors");
	const stats = { citations: 1000, hIndex: 12, i10: 20, sinceYear: 2021, since: { citations: 600, hIndex: 9, i10: 11 } };
	const profile = { provider: "scholar", id: "ABCDEFGHIJKL", name: "Jennifer A. Doudna", mode: "profile", identityConfirmed: true, scholarStats: stats };
	const rows = FIXTURE({ authorProfile: profile, authorProvenance: { truncated: true } }).map(r => ({ ...r, citations: r.citations * 3, citationSource: "openalex", citationsBy: { scholar: r.citations, openalex: r.citations * 3 } }));
	ui.authorSessions.scholar.profile = profile;
	ui.displaySearchResults(rows);
	assert.equal(ui.unverifiedAuthorResults(), false); assert.equal(ui.personPick(), null);
	ui.originalRenderMetrics(ui.state.visible);
	assert.equal(ui.metricsOwner(), "Jennifer A. Doudna");
	assert.equal(ui.get("metrics-person").hidden, true);
	assert.equal(ui.state.metricsBasis, "scholar", "Scholar's own counts, not the highest across indexes");
	assert.equal(ui.get("m-citations").textContent, "210");
	const box = ui.get("metrics-scholar").textContent;
	assert.equal(ui.get("metrics-scholar").hidden, false);
	assert.match(box, /scholarStatsTitle/); assert.match(box, /scholarStatsSince\|2021/); assert.match(box, /1,000|1000/); assert.match(box, /i10-index/);
	assert.match(ui.get("metrics-calc").textContent, /metricsCalc\|.+\|6/);
	assert.match(ui.get("metrics-explain").textContent, /metricsCappedOpen\|6/);
	assert.ok(ui.get("metrics-explain").querySelector("button"), "load them all is offered");
	// the reader's own choice of the highest count wins
	ui.state.metricsBasisUser = true; ui.state.metricsBasis = null;
	ui.originalRenderMetrics(ui.state.visible);
	assert.equal(ui.state.metricsBasis, null); assert.equal(ui.get("m-citations").textContent, "630");
	// a profile with more papers than were loaded says N of M
	const openalex = { provider: "combined", id: "A5", name: "Pat Lee", mode: "profile", identityConfirmed: true, worksCount: 50 };
	ui.state.metricsBasisUser = false; ui.authorSessions.scholar.profile = openalex;
	ui.displaySearchResults(FIXTURE({ authorProfile: openalex, authorProvenance: { truncated: false } }).map(r => ({ ...r, citationsBy: undefined })));
	ui.originalRenderMetrics(ui.state.visible);
	assert.match(ui.get("metrics-explain").textContent, /metricsLoadedOf\|50\|6/);
});

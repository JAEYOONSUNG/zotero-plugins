/* Regression review of "Rank by my library": identity, Style Custom's cached works, the cost of scoring
   a big library, and the window's job (library switch, unload, PubMed abstract). OpenAlex is metered:
   every request goes to a mock that records the URL. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import Related from "../content/related.js";
import Sources from "../content/sources.js";
import Signals from "../content/signals.js";
import I18N from "../content/i18n.js";
import { uiHarness, paper } from "./helpers/search-ui-harness.mjs";

const W = n => "https://openalex.org/W" + n;
function mockOpenAlex(table) {
	const urls = [];
	const byDoi = new Map(Object.entries(table).map(([n, w]) => [w.doi, n]));
	const getJSON = async url => {
		urls.push(url);
		const filter = decodeURIComponent((url.match(/[?&]filter=([^&]+)/) || [])[1] || "");
		const name = filter.split(":")[0], wanted = filter.slice(filter.indexOf(":") + 1).split("|");
		const out = [];
		for (const v of wanted) {
			const n = name === "doi" ? byDoi.get(v) : v.replace(/^W/, "");
			const w = n && table[n];
			if (w) out.push({ id: W(n), doi: w.doi ? "https://doi.org/" + w.doi : null, referenced_works: w.refs.map(W) });
		}
		return { results: out };
	};
	return { http: { getJSON }, urls };
}
const run = (args, ctx = {}) => Related.rank({ sources: Sources, ctx, ...args });
const NOW = Date.parse("2026-10-05T00:00:00Z");
const fresh = new Date(NOW - 2 * 86400000).toISOString();

/* ---- item 3: identity ---- */
test("identity: two different papers titled '2016 Editorial' are not one; a held paper never merges by title across different DOIs", () => {
	const held = [
		{ itemID: 1, title: "2016 Editorial", year: 2016, family: "Smith", doi: "10.1/a", openalex: "W1", refs: ["W100"] },
		{ itemID: 2, title: "2016 Editorial", year: 2016, family: "Smith", doi: "10.1/b", openalex: "W2", refs: ["W101"] }
	];
	const ix = Related.buildIndex(held);
	assert.equal(ix.clusters.length, 2, "different ids and DOIs: two papers");
	const scores = Related.scoreAll(held, [{ key: "r", id: "W9", doi: "10.1/zzz", title: "2016 Editorial", year: 2016, family: "Smith", refs: ["W100"] }]);
	assert.equal(scores.get("r").held, undefined, "another DOI and id, same title: not the held paper");
	assert.equal(scores.get("r").score > 0, true);
});

test("identity: the title fallback needs neither id nor DOI, and then the same year and first author", () => {
	const held = [{ itemID: 1, title: "A long editorial title here", year: 2016, family: "Smith", refs: ["W100"] }];
	const hit = Related.scoreAll(held, [{ key: "r", title: "A long editorial title here", year: 2016, family: "smith" }]);
	assert.equal(hit.get("r").held, true);
	for (const other of [{ year: 2017, family: "Smith" }, { year: 2016, family: "Jones" }, { year: 2016 }]) {
		assert.notEqual(Related.scoreAll(held, [{ key: "r", title: "A long editorial title here", ...other }]).get("r").held, true, JSON.stringify(other));
	}
	assert.equal(Related.buildIndex([...held, { itemID: 2, title: "A long editorial title here", year: 2016, family: "Smith", refs: ["W101"] }]).clusters.length, 1, "held without id/doi merge on the full key");
});

test("identity: an explicit version relation joins a preprint and its article, whatever the title", () => {
	const held = [{ itemID: 1, title: "Preprint title", doi: "10.1/pre", openalex: "W1", refs: ["W100"] }];
	const s = Related.scoreAll(held, [{ key: "r", id: "W9", doi: "10.1/art", title: "A completely different published title", refs: ["W100"], versionDois: ["10.1/pre"] }]);
	assert.equal(s.get("r").held, true);
});

/* ---- item 2: Style Custom's cached works ---- */
const stored = (over = {}) => ({ itemID: 1, title: "Held one", doi: "10.1000/h1", openalex: "W1", refs: ["W100", "W101"], stored: true, scDoi: "10.1000/h1", checkedAt: fresh, complete: true, ...over });
const cands = () => [{ key: "A", source: "openalex", sourceId: "W10", title: "Result A" }];
const tbl = () => ({ 1: { doi: "10.1000/h1", refs: [100, 101] }, 5: { doi: "10.1000/other", refs: [10] }, 10: { doi: "10.1000/a", refs: [1, 100] } });
const store = () => Related.createStore({ now: () => NOW });

test("Style Custom works: a different DOI than the item's current one is refetched, not scored from the cache", async () => {
	const { http, urls } = mockOpenAlex(tbl());
	const out = await run({ held: [stored({ doi: "10.1000/other", refs: ["W10"] })], results: cands(), http, store: store() });
	assert.ok(urls.some(u => /filter=doi/.test(u) && /10\.1000(%2F|\/)other/.test(u)), "the held item is asked for by its current DOI");
	assert.equal(out.scores.get("A").c1, 0, "the cached list belonged to another paper and is not used");
});

test("Style Custom works: a list older than 30 days is refetched; a fresh matching one is not", async () => {
	const old = new Date(NOW - 31 * 86400000).toISOString();
	const a = mockOpenAlex(tbl());
	await run({ held: [stored({ checkedAt: old })], results: cands(), http: a.http, store: store() });
	assert.ok(a.urls.some(u => /filter=doi/.test(u)), "2020-style stale entry: refetch in the normal DOI batch");
	const b = mockOpenAlex(tbl());
	await run({ held: [stored()], results: cands(), http: b.http, store: store() });
	assert.equal(b.urls.filter(u => /filter=doi/.test(u)).length, 0, "fresh and matching: no request for the held paper");
});

test("Style Custom works: a list capped at 500 gives no c2 and is flagged as lower confidence", async () => {
	const { http } = mockOpenAlex(tbl());
	const refs = ["W100", "W10"];
	const full = await run({ held: [stored({ refs })], results: cands(), http, store: store() });
	const capped = await run({ held: [stored({ refs, complete: false })], results: cands(), http, store: store() });
	assert.equal(full.scores.get("A").c2, 1);
	assert.equal(capped.scores.get("A").c2, 0, "the held list was cut, so 'held cites this' cannot be claimed");
	assert.equal(capped.scores.get("A").lowConf, 1);
	assert.equal(full.scores.get("A").lowConf, 0);
});

test("Style Custom works: libraryWorks carries doi, checkedAt and complete (capped at 500 references)", () => {
	const sc = { paperWorks: () => ({ "1:AAA": { doi: "10.1/x", openalex: "W1", references: Array.from({ length: 500 }, (_, i) => "W" + (i + 1000)), checkedAt: fresh }, "1:BBB": { doi: "10.1/y", openalex: "W2", references: ["W5"], checkedAt: fresh } }), watchedAuthors: () => [] };
	const [a, b] = Signals.libraryWorks(sc);
	assert.deepEqual([a.doi, a.complete, a.checkedAt], ["10.1/x", false, fresh]);
	assert.deepEqual([b.doi, b.complete], ["10.1/y", true]);
});

test("Style Custom works: an explicit preprint relation matches the held DOI even when the title changed and the result has no DOI", async () => {
	const { http } = mockOpenAlex(tbl());
	const out = await run({ held: [stored()], results: [{ key: "P", source: "openalex", sourceId: "W10", title: "Totally new title", preprintOf: { doi: "10.1000/h1" } }], http, store: store() });
	assert.equal(out.scores.get("P").held, true);
});

/* ---- item 7: cost ---- */
function big(nHeld, nRes, shared) {
	const held = [], results = [];
	for (let i = 0; i < nHeld; i++) { const refs = []; for (let j = 0; j < 150; j++) refs.push("W" + (100000 + ((i * 7 + j * 13) % 4000))); held.push({ itemID: i, title: "Held paper number " + i, doi: "10.1/h" + i, openalex: "W" + (i + 1), refs }); }
	for (let i = 0; i < nRes; i++) { const refs = []; for (let j = 0; j < shared; j++) refs.push("W" + (100000 + ((i * 11 + j * 17) % 4000))); results.push({ key: "r" + i, id: "W" + (50000 + i), doi: "10.2/r" + i, title: "Result " + i, refs }); }
	return { held, results };
}
test("scoring 1,200 x 1,200 holds the thread in slices under ~100 ms and yields between them", async () => {
	const { held, results } = big(1200, 1200, 100);
	const stamps = []; let mark = performance.now(), worst = 0, pauses = 0;
	await Related.scoreAllAsync(held, results, { every: 100, pause: async () => { pauses++; const now = performance.now(); worst = Math.max(worst, now - mark); await new Promise(r => setTimeout(r, 0)); mark = performance.now(); } });
	worst = Math.max(worst, performance.now() - mark);
	assert.ok(pauses >= 12, "a macrotask turn after the index and at least every 100 results: " + pauses);
	assert.ok(worst < 100, "longest synchronous slice " + worst.toFixed(1) + " ms");
	stamps.push(worst);
});

test("the lazy explanation equals the eager one", () => {
	const { held, results } = big(60, 40, 30);
	const scores = Related.scoreAll(held, results);
	const eager = r => { // the original formulation, written out independently
		const own = new Set(r.refs), per = new Map(), ix = Related.buildIndex(held);
		for (const ref of own) {
			const c = ix.idMap.get(ref);
			const note = k => { if (!per.has(k)) per.set(k, { k, cites: false, w: 0 }); return per.get(k); };
			if (c) { note(c).cites = true; continue; }
			for (const k of ix.refToClusters.get(ref) || []) note(k).w += ix.weight(ref);
		}
		return [...per.values()].map(p => ({ itemID: p.k.itemID, shared: Math.round(p.w * 100) / 100, cites: p.cites })).sort((a, b) => (b.cites - a.cites) || (b.shared - a.shared)).slice(0, 5);
	};
	for (const r of results.slice(0, 10)) {
		const lazy = scores.get(r.key).top.map(t => ({ itemID: t.itemID, shared: t.shared, cites: t.why.includes("cites") }));
		assert.deepEqual(lazy, eager(r));
		assert.deepEqual(scores.get(r.key).top, JSON.parse(JSON.stringify(scores.get(r.key))).top, "enumerable and stable once read");
	}
});

test("scoreAllAsync stops at a cancel between slices", async () => {
	const { held, results } = big(50, 500, 20);
	let stop = false, calls = 0;
	await assert.rejects(Related.scoreAllAsync(held, results, { pause: async () => { calls++; stop = true; }, cancelled: () => { if (stop) throw Object.assign(new Error("x"), { name: "AbortError" }); } }), e => e.name === "AbortError");
	assert.equal(calls, 1);
});

test("an aborted signal rejects rank before any scoring, even when every list is cached", async () => {
	const held = [stored()], ac = new AbortController(); ac.abort();
	const { http, urls } = mockOpenAlex(tbl());
	await assert.rejects(run({ held, results: cands(), http, store: store() }, { signal: ac.signal }), e => e.name === "AbortError");
	assert.equal(urls.length, 0);
});

/* ---- the window ---- */
const wait = ms => new Promise(r => setTimeout(r, ms));
const settleUI = async ui => { for (let i = 0; i < 300 && ui.state.related?.running; i++) await wait(5); await wait(5); };
const tables = () => ({
	1: { doi: "10.1000/h1", refs: [100] }, 10: { doi: "10.1000/a", refs: [1, 100] }, 11: { doi: "10.1000/b", refs: [100] }
});
function windowWith({ request, files = new Map() } = {}) {
	const ui = uiHarness({
		realRows: true, historyFiles: files,
		search: async () => [paper("A", { title: "Result A", source: "openalex", sourceId: "W10", doi: "10.1000/a", rank: 1 }), paper("B", { title: "Result B", source: "openalex", sourceId: "W11", doi: "10.1000/b", rank: 2 })],
		sources: { withRetry: Sources.withRetry, isQuotaError: Sources.isQuotaError, openAlexAuth: Sources.openAlexAuth },
		zotero: { Items: { get: id => ({ id, getField: f => ({ title: "Held " + id })[f] || "" }) } },
		request
	});
	return ui;
}
async function loadedUI(request) {
	const ui = windowWith({ request });
	await ui.runSearch(); ui.wireEvents();
	ui.state.doiMap = new Map([["10.1000/h1", 1]]);
	return ui;
}

test("a library switch while ranking cancels the job, clears scores and the related sort, and drops the late answer", async () => {
	let release; const gate = new Promise(r => { release = r; });
	let n = 0;
	const ui = await loadedUI(async (_m, url) => { n++; if (n === 1) await gate; return { response: await mockOpenAlex(tables()).http.getJSON(url), status: 200 }; });
	ui.get("related-btn").emit("click");
	await wait(10);
	assert.equal(ui.state.related.running, true);
	ui.get("target").value = "2:";
	ui.get("target").emit("change");
	release();
	await settleUI(ui); await wait(20);
	assert.equal(ui.state.sortKey !== "related", true, "no related sort after the switch");
	assert.ok(ui.state.records.every(r => !r.related), "no stale score on any row");
	assert.equal(ui.state.related.running, false);
	assert.equal(ui.get("related-label").textContent, "relButton");
});

test("a finished ranking is cleared when the library changes afterwards", async () => {
	const ui = await loadedUI(async (_m, url) => ({ response: await mockOpenAlex(tables()).http.getJSON(url), status: 200 }));
	ui.get("related-btn").emit("click"); await settleUI(ui);
	assert.equal(ui.state.sortKey, "related");
	ui.get("target").value = "2:"; ui.get("target").emit("change");
	assert.notEqual(ui.state.sortKey, "related");
	assert.ok(ui.state.records.every(r => !r.related));
});

test("after the window unloads the job makes no further request and applies nothing", async () => {
	let release; const gate = new Promise(r => { release = r; });
	let n = 0;
	const ui = await loadedUI(async (_m, url) => { n++; if (n === 1) await gate; return { response: await mockOpenAlex(tables()).http.getJSON(url), status: 200 }; });
	ui.get("related-btn").emit("click");
	await wait(10);
	ui.emitWindow("unload", {});
	release();
	await wait(60);
	assert.equal(n, 1, "no second request after unload");
	assert.ok(ui.state.records.every(r => !r.related), "nothing applied");
	assert.notEqual(ui.state.sortKey, "related");
});

test("the strings the fix adds exist in English and Korean", () => {
	for (const k of ["relLowConf"]) for (const lang of ["en", "ko"]) assert.ok(k in I18N.STRINGS[lang], `${lang}: ${k}`);
	assert.match(I18N.STRINGS.en.relLowConf(2), /2/); assert.match(I18N.STRINGS.ko.relLowConf(2), /[가-힣]/);
});

/* ---- item 6: Translate waits for the PubMed abstract ---- */
test("Translate awaits the abstract that is still loading, then translates once", async () => {
	let release; const gate = new Promise(r => { release = r; });
	let lookups = 0, translations = [];
	const ui = uiHarness({
		realRows: true, prefs: { translateTitle: false }, search: async () => [paper("a", { source: "pubmed", pmid: "11", title: "Pubmed paper" })],
		sources: { fetchPubMedAbstracts: async pmids => { lookups++; await gate; return new Map(pmids.map(p => [p, "Abstract of " + p])); } }
	});
	await ui.runSearch();
	const r = ui.state.records[0];
	ui.state.detailKey = r.key;
	ui.setTranslatorForTest({ defaultLanguage: () => "ko", cached: () => null, translateCached: async o => { translations.push(o.text); return { text: "x", service: "s" }; } });
	const loading = ui.ensureAbstracts([r]);            // what opening the paper does
	const clicked = ui.runTranslate();                  // Translate pressed while it is still loading
	await wait(10);
	assert.equal(translations.length, 0, "nothing translated before the abstract arrives");
	release();
	await Promise.all([loading, clicked]);
	assert.equal(lookups, 1, "the in-flight request is shared, not repeated");
	assert.deepEqual(translations, ["Abstract of 11"], "translated once, from the abstract that arrived");
	assert.notEqual(ui.get("d-tr-note").textContent, "trNoText");
});

/* ---- item 4: the Notifier observer ---- */
function loadImporter(Zotero) {
	const ctx = vm.createContext({ Zotero, ZotPoPSources: { SOURCES: {} } });
	vm.runInContext(fs.readFileSync(new URL("../content/importer.js", import.meta.url), "utf8"), ctx);
	return ctx.ZotPoPImporter;
}
test("the importer registers one Notifier observer per plugin, however many windows load it, and unregisters on unload", () => {
	const live = new Map(); let next = 1, registered = 0;
	const Zotero = { Notifier: { registerObserver(o, types, id) { registered++; live.set(next, o); return next++; }, unregisterObserver(id) { live.delete(id); } } };
	const a = loadImporter(Zotero), b = loadImporter(Zotero), c = loadImporter(Zotero);
	assert.equal(live.size, 1, "three loads, one observer");
	assert.equal(registered, 1);
	a.dispose(); b.dispose();
	assert.equal(live.size, 1, "still needed by the third window");
	c.dispose();
	assert.equal(live.size, 0, "the last unload leaves none");
	const d = loadImporter(Zotero);
	assert.equal(live.size, 1, "a window opened later registers again");
	Zotero.__zotpopTitleObserver.disposeAll();
	assert.equal(live.size, 0, "plugin shutdown drops it whatever windows remain");
	assert.equal(typeof d.dispose, "function");
});

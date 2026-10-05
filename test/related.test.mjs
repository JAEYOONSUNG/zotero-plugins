/* "Rank by my library": the score, the requests it costs, the cache that makes the second run free,
   and the button that sorts a result list by it. OpenAlex is a metered API, so every test of the
   request count runs against a mock that records each URL. */
import { test } from "node:test";
import assert from "node:assert/strict";
import Related from "../content/related.js";
import Sources from "../content/sources.js";
import I18N from "../content/i18n.js";
import { uiHarness, paper } from "./helpers/search-ui-harness.mjs";

const W = n => "https://openalex.org/W" + n;

/* A fake OpenAlex /works endpoint over a table { W-number: { doi, refs } }. */
function mockOpenAlex(table, { onRequest } = {}) {
	const urls = [];
	const byDoi = new Map(Object.entries(table).map(([n, w]) => [w.doi, n]));
	const getJSON = async url => {
		urls.push(url);
		await onRequest?.(url, urls.length);
		const filter = decodeURIComponent((url.match(/[?&]filter=([^&]+)/) || [])[1] || "");
		const [name, list] = [filter.split(":")[0], filter.slice(filter.indexOf(":") + 1)];
		const wanted = list.split("|");
		assert.ok(wanted.length <= 50, "at most 50 ids per request");
		assert.match(url, /per-page=50/);
		assert.match(url, /select=id,doi,referenced_works/);
		const out = [];
		for (const v of wanted) {
			const n = name === "doi" ? byDoi.get(v) : v.replace(/^W/, "");
			const w = n && table[n];
			if (w) out.push({ id: W(n), doi: w.doi ? "https://doi.org/" + w.doi : null, referenced_works: w.refs.map(W) });
		}
		return { results: out, meta: { count: out.length } };
	};
	return { http: { getJSON }, urls };
}
const run = (args, ctx = {}) => Related.rank({ sources: Sources, ctx, ...args });

/* Three held papers, N = 3. Reference weights: cited by 1 of 3 held = 1, by 2 of 3 = 0.5. */
const heldRows = () => [
	{ itemID: 1, title: "Held one about genome editing", doi: "10.1000/h1" },
	{ itemID: 2, title: "Held two about base editors", doi: "10.1000/h2" },
	{ itemID: 3, title: "Held three about delivery", doi: "10.1000/h3" }
];
const table = () => ({
	1: { doi: "10.1000/h1", refs: [100, 101, 102] },
	2: { doi: "10.1000/h2", refs: [100, 103] },
	3: { doi: "10.1000/h3", refs: [104, 10] },
	10: { doi: "10.1000/a", refs: [1, 100, 101, 999] },   // cites held 1; cited by held 3; shares 100 (df 2) and 101 (df 1)
	11: { doi: "10.1000/b", refs: [103, 500] },           // shares 103 only
	12: { doi: "10.1000/c", refs: [600] },                // nothing in common
	13: { doi: "10.1000/d", refs: [2] },                  // found by DOI; cites held 2
	14: { doi: "10.1000/pre", refs: [100, 101, 102] }     // the published twin of held 1
});
const resultRows = () => [
	{ key: "A", title: "Result A", source: "openalex", sourceId: "W10", doi: "10.1000/a" },
	{ key: "B", title: "Result B", source: "openalex", sourceId: "W11", doi: "10.1000/b" },
	{ key: "C", title: "Result C", source: "openalex", sourceId: "W12" },
	{ key: "D", title: "Result D", source: "crossref", doi: "10.1000/d" },
	{ key: "E", title: "Held one", source: "openalex", sourceId: "W1", doi: "10.1000/h1" },
	{ key: "P", title: "Held one about GENOME editing!", source: "openalex", sourceId: "W14", doi: "10.1000/pre" },
	{ key: "F", title: "Result F, nothing to look up", source: "crossref" }
];

test("score: 3*(c1+c2) + idf-weighted shared references, on a hand-built library", async () => {
	const { http, urls } = mockOpenAlex(table());
	const out = await run({ held: heldRows(), results: resultRows(), http });
	const s = out.scores;
	assert.deepEqual([s.get("A").c1, s.get("A").c2, s.get("A").c3], [1, 1, 2], "A cites held 1, is cited by held 3, shares refs 100 and 101");
	assert.equal(s.get("A").c3w, 1.5, "ref 101 is cited by 1 of 3 held (1.0), ref 100 by 2 of 3 (0.5)");
	assert.equal(s.get("A").score, 7.5, "3*(1+1)+1.5");
	assert.equal(s.get("B").score, 1);
	assert.equal(s.get("C").score, 0);
	assert.deepEqual([s.get("D").c1, s.get("D").score], [1, 3], "no OpenAlex id: found by DOI, then scored like any other");
	assert.match(Related.FORMULA, /3\s*\*\s*\(c1\s*\+\s*c2\)\s*\+\s*c3/);
	assert.equal(urls.length, 2, "one DOI batch (3 held + result D) and one id batch (5 results)");
	assert.equal(out.requests, 2);
	assert.deepEqual(out.order.slice(0, 4), ["A", "D", "B", "C"], "highest first, ties in the original order");
});

test("the breakdown names the held papers involved, direct links first", async () => {
	const { http } = mockOpenAlex(table());
	const { scores } = await run({ held: heldRows(), results: resultRows(), http });
	const top = scores.get("A").top;
	assert.deepEqual(top.map(t => t.itemID).slice(0, 2).sort(), [1, 3], "held 1 (A cites it) and held 3 (cites A) come first");
	assert.ok(top.find(t => t.itemID === 1).why.includes("cites") && top.find(t => t.itemID === 3).why.includes("citedBy"));
	assert.ok(top.length <= 5);
	assert.ok(top.some(t => t.itemID === 2), "held 2 shares reference 100 and is listed after the direct links");
});

test("held results are flagged and left out of the ranking; so are a held paper's preprint/published twin", async () => {
	const { http } = mockOpenAlex(table());
	const out = await run({ held: heldRows(), results: resultRows(), http });
	assert.equal(out.scores.get("E").held, true, "the library holds it: same OpenAlex id");
	assert.equal(out.scores.get("P").held, true, "another DOI, same title: the other version of a held paper");
	assert.equal(out.scores.get("E").score, null);
	assert.equal(out.scores.get("P").score, null, "its references equal held 1's, so scoring it would only echo the library back");
	assert.deepEqual(out.order.slice(-3), ["E", "P", "F"], "held after every ranked result, not rankable last");
});

test("a preprint and its article in the library count once", async () => {
	const { http } = mockOpenAlex({ ...table(), 20: { doi: "10.1000/h1-pre", refs: [100, 101, 102] } });
	const held = [...heldRows(), { itemID: 9, title: "Held one about genome editing", doi: "10.1000/h1-pre" }];
	const out = await run({ held, results: [{ key: "X", title: "X", source: "openalex", sourceId: "W10", doi: "10.1000/a" }], http });
	assert.equal(out.scores.get("X").c1, 1, "two library items for one paper is one link");
	assert.equal(out.scores.get("X").c3w, 1.5, "and does not double the idf weights: the duplicate is merged, N stays 3");
});

test("a result with neither an OpenAlex id nor a DOI is not rankable and costs no request", async () => {
	const { http, urls } = mockOpenAlex(table());
	const out = await run({ held: heldRows(), results: [{ key: "F", title: "no ids", source: "crossref" }, { key: "G", title: "unknown doi", source: "crossref", doi: "10.9000/none" }], http });
	assert.equal(out.scores.get("F").unrankable, true);
	assert.equal(out.scores.get("G").unrankable, true, "asked for by DOI, OpenAlex does not know it");
	assert.equal(urls.length, 1, "the held DOIs and result G's DOI share one batch; F is never asked for");
	assert.equal(out.order.join(""), "FG");
});

test("batching: 120 held + 60 results is 3 + 2 requests of at most 50, and the second run needs none", async () => {
	const tbl = {}, held = [], results = [];
	for (let i = 1; i <= 120; i++) { tbl[i] = { doi: "10.1000/held" + i, refs: [1000 + i, 2000] }; held.push({ itemID: i, title: "Held paper number " + i, doi: "10.1000/held" + i }); }
	for (let j = 1; j <= 60; j++) { tbl[5000 + j] = { doi: "10.1000/res" + j, refs: [j, 2000] }; results.push({ key: "r" + j, title: "Result " + j, source: "openalex", sourceId: "W" + (5000 + j) }); }
	const first = mockOpenAlex(tbl), store = Related.createStore();
	const progress = [];
	const a = await run({ held, results, http: first.http, store, onProgress: p => progress.push([p.done, p.total]) });
	assert.equal(first.urls.length, 5);
	assert.equal(a.requests, 5);
	assert.deepEqual(progress.at(-1), [5, 5]);
	assert.equal(a.scores.get("r1").c1, 1, "result 1 cites held 1");
	const second = mockOpenAlex(tbl);
	const b = await run({ held, results, http: second.http, store });
	assert.equal(second.urls.length, 0);
	assert.equal(b.requests, 0);
	assert.deepEqual([...b.scores].map(([k, v]) => [k, v.score]), [...a.scores].map(([k, v]) => [k, v.score]), "same answer from the cache");
});

test("the cache is written out, read back, and aged out after 30 days", async () => {
	const { http } = mockOpenAlex(table());
	let now = Date.parse("2026-10-01T00:00:00Z");
	const store = Related.createStore({ now: () => now });
	await run({ held: heldRows(), results: resultRows(), http, store });
	const snap = JSON.parse(JSON.stringify(store.export()));
	assert.ok(snap.version === 1 && !/api_key/i.test(JSON.stringify(snap)));
	const warm = Related.createStore({ now: () => now });
	assert.ok(warm.import(snap) > 5);
	const again = mockOpenAlex(table());
	await run({ held: heldRows(), results: resultRows(), http: again.http, store: warm });
	assert.equal(again.urls.length, 0, "a store read back from disk answers without a request");
	now += 31 * 86400000;
	const old = Related.createStore({ now: () => now });
	assert.equal(old.import(snap), 0, "past its 30 days nothing is trusted");
});

test("Style Custom's stored references are used as they are: no request for the held papers", async () => {
	const { http, urls } = mockOpenAlex(table());
	const held = [
		{ itemID: 1, title: "Held one about genome editing", openalex: "W1", refs: ["W100", "W101", "W102"] },
		{ itemID: 2, title: "Held two about base editors", openalex: "W2", refs: ["W100", "W103"] },
		{ itemID: 3, title: "Held three about delivery", openalex: "W3", refs: ["W104", "W10"] }
	];
	const out = await run({ held, results: [resultRows()[0]], http });
	assert.equal(urls.length, 1, "only the one batch of results");
	assert.match(decodeURIComponent(urls[0]), /filter=openalex_id:W10/);
	assert.equal(out.scores.get("A").score, 7.5);
});

test("an empty library cannot rank, and says so before any request", async () => {
	const { http, urls } = mockOpenAlex(table());
	const out = await run({ held: [], results: resultRows(), http });
	assert.equal(out.reason, "empty-library");
	assert.equal(out.scores.size, 0);
	assert.equal(urls.length, 0);
});

test("cancel: stops between requests, keeps what was fetched, and the rerun asks only for the rest", async () => {
	const tbl = {}, held = [];
	for (let i = 1; i <= 120; i++) { tbl[i] = { doi: "10.1000/held" + i, refs: [1000 + i] }; held.push({ itemID: i, title: "Held paper number " + i, doi: "10.1000/held" + i }); }
	const ac = new AbortController(), store = Related.createStore();
	const first = mockOpenAlex(tbl, { onRequest: (_u, n) => { if (n === 2) ac.abort(); } });
	await assert.rejects(run({ held, results: [], http: first.http, store }, { signal: ac.signal }), e => e.name === "AbortError");
	assert.equal(first.urls.length, 2, "the cancel lands during the second request; no third is sent");
	const second = mockOpenAlex(tbl);
	await run({ held, results: [{ key: "x", title: "x", source: "openalex", sourceId: "W1" }], http: second.http, store });
	assert.equal(second.urls.filter(u => /filter=doi/.test(u)).length, 2, "3 batches in all, the one that finished before the cancel is kept");
});

test("an exhausted OpenAlex budget stops the run with a reason instead of retrying", async () => {
	const http = { getJSON: async url => { throw Object.assign(new Error("Insufficient budget"), { status: 429, body: "Insufficient budget", url }); } };
	const ctx = {};
	const out = await run({ held: heldRows(), results: resultRows(), http }, ctx);
	assert.equal(out.reason, "budget");
	assert.equal(ctx.openAlexSpent, true);
});

test("requests carry the API key when there is one, and never an e-mail address", async () => {
	const { http, urls } = mockOpenAlex(table());
	await run({ held: heldRows(), results: resultRows(), http }, { openAlexApiKey: "k3y", email: "someone@example.org" });
	assert.ok(urls.length && urls.every(u => /[&?]api_key=k3y/.test(u) && !/mailto|someone/.test(u)));
});

/* ------------------------------------------------------------------ the window */
const settle = async ui => { for (let i = 0; i < 200 && ui.state.related?.running; i++) await new Promise(r => setTimeout(r, 5)); await new Promise(r => setTimeout(r, 5)); };
function windowWith({ held = true, request, files = new Map() } = {}) {
	const requests = [];
	const tbl = table();
	const items = new Map([[1, ["Held one about genome editing", "2020-05-01", "Nature Biotechnology"]], [2, ["Held two about base editors", "2021", "Cell"]], [3, ["Held three about delivery", "2019", "Science"]]]);
	const ui = uiHarness({
		realRows: true, historyFiles: files,
		search: async () => resultRows().map((r, i) => paper(r.key, { ...r, title: r.title, rank: i + 1, citations: 100 - i })),
		sources: { withRetry: Sources.withRetry, isQuotaError: Sources.isQuotaError, openAlexAuth: Sources.openAlexAuth },
		zotero: { Items: { get: id => items.has(id) ? { id, getField: f => ({ title: items.get(id)[0], date: items.get(id)[1], publicationTitle: items.get(id)[2] })[f] || "" } : null } },
		request: request || (async (_m, url) => {
			requests.push(url);
			const http = mockOpenAlex(tbl); return { response: await http.http.getJSON(url), status: 200 };
		})
	});
	return { ui, requests, files, held };
}
async function loaded(opts) {
	const w = windowWith(opts);
	await w.ui.runSearch(); w.ui.wireEvents();
	if (w.held) w.ui.state.doiMap = new Map(heldRows().map(h => [h.doi, h.itemID]));
	return w;
}

test("the button ranks the list by the library, shows the breakdown chip with a tooltip, and sorts back", async () => {
	const { ui, requests } = await loaded();
	const before = ui.state.visible.map(r => r.key);
	assert.equal(ui.get("related-btn").disabled, false);
	ui.get("related-btn").emit("click");
	await settle(ui);
	assert.equal(ui.state.sortKey, "related");
	assert.deepEqual(ui.state.visible.map(r => r.key).slice(0, 4), ["A", "D", "B", "C"], "by score, highest first");
	assert.deepEqual(ui.state.visible.map(r => r.key).slice(-3), ["E", "P", "F"], "held next, not rankable last");
	const row = key => ui.get("results-body").querySelectorAll("tr").find(tr => tr.dataset.key === key);
	const chip = row("A").querySelector(".rel-chip");
	assert.ok(chip, "a chip on the row");
	assert.match(chip.textContent, /relChip\|1\|1\|2/, "cites 1 of yours, cited by 1, 2 shared refs");
	const tipText = ui.Z && (chip.getAttribute("data-tip") || chip.getAttribute("title") || "");
	assert.match(tipText, /Held one about genome editing/);
	assert.match(tipText, /Nature Biotechnology/, "the journal in full");
	assert.match(tipText, /2020/);
	assert.ok(row("F").querySelector(".rel-chip").textContent.includes("relUnrankable"));
	assert.ok(requests.length >= 1);
	assert.equal(ui.get("related-btn").getAttribute("aria-pressed"), "true");
	// pressing again goes back to the order before
	ui.get("related-btn").emit("click");
	await settle(ui);
	assert.equal(ui.state.sortKey, "rank");
	assert.deepEqual(ui.state.visible.map(r => r.key), before);
	assert.equal(ui.get("related-btn").getAttribute("aria-pressed"), "false");
});

test("ranking again after the first run costs no request: the cache is on disk", async () => {
	const w = await loaded();
	w.ui.get("related-btn").emit("click"); await settle(w.ui);
	const n = w.requests.length;
	assert.ok(n > 0);
	w.ui.get("related-btn").emit("click"); await settle(w.ui);   // back
	w.ui.get("related-btn").emit("click"); await settle(w.ui);   // again
	assert.equal(w.requests.length, n);
	assert.ok([...w.files.keys()].some(k => /related\.json$/.test(k)), "persisted in the plugin's data folder");
	assert.doesNotMatch([...w.files.values()].join(""), /api_key/);
});

test("an empty library explains itself and sorts nothing", async () => {
	const w = await loaded({ held: false });
	const order = w.ui.state.visible.map(r => r.key);
	w.ui.get("related-btn").emit("click"); await settle(w.ui);
	assert.equal(w.ui.state.sortKey, "rank");
	assert.deepEqual(w.ui.state.visible.map(r => r.key), order);
	assert.equal(w.requests.length, 0);
	assert.equal(w.ui.get("banner-text").textContent, "relNeedsLibrary");
});

test("while it works the button is a cancel button with n of m, and cancelling leaves the order alone", async () => {
	let release; const gate = new Promise(r => { release = r; });
	let n = 0;
	const w = await loaded({ request: async (_m, url) => { n++; if (n === 1) await gate; const h = mockOpenAlex(table()); return { response: await h.http.getJSON(url), status: 200 }; } });
	const order = w.ui.state.visible.map(r => r.key);
	w.ui.get("related-btn").emit("click");
	await new Promise(r => setTimeout(r, 10));
	assert.equal(w.ui.state.related.running, true);
	assert.match(w.ui.get("related-label").textContent, /relCancel/);
	assert.match(w.ui.get("status").textContent, /relProgress\|\d+\|\d+/);
	w.ui.get("related-btn").emit("click");   // cancel
	release();
	await settle(w.ui);
	assert.equal(w.ui.state.sortKey, "rank");
	assert.deepEqual(w.ui.state.visible.map(r => r.key), order);
	assert.equal(w.ui.get("related-label").textContent, "relButton");
});

test("rowSignature carries the score, so a ranked row is rebuilt and an unranked one reused", async () => {
	const { ui } = await loaded();
	const rec = ui.state.records.find(r => r.key === "B");
	const before = ui.rowSignature(rec);
	rec.related = { score: 1, c1: 0, c2: 0, c3: 1, c3w: 1, top: [] };
	assert.notEqual(ui.rowSignature(rec), before);
	const sig = ui.rowSignature(rec);
	rec.related = { ...rec.related, c3: 2 };
	assert.notEqual(ui.rowSignature(rec), sig);
});

test("every string of the feature exists in English and Korean", () => {
	const keys = ["relButton", "relButtonTip", "relCancel", "relProgress", "relDone", "relDoneCached", "relChip", "relNoLink", "relHeldChip", "relUnrankable", "relTip", "relTipWhy", "relNeedsLibrary", "relLibraryFailed", "relBudget", "relFailed", "relBack", "relPartial", "relStopped", "relUnrankableTip", "relHeldTip"];
	for (const k of keys) for (const lang of ["en", "ko"]) assert.ok(k in I18N.STRINGS[lang], `${lang}: ${k}`);
	const chipEn = I18N.STRINGS.en.relChip(3, 2, 14), chipKo = I18N.STRINGS.ko.relChip(3, 2, 14);
	assert.match(chipEn, /cites 3 of yours/); assert.match(chipEn, /cited by 2/); assert.match(chipEn, /14 shared refs/);
	assert.match(chipKo, /[가-힣]/);
});

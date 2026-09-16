import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deferred, paper, uiHarness } from "./helpers/search-ui-harness.mjs";
import Sources from "../content/sources.js";

for (const sort of ["relevance", "date", "citations"]) {
	test(`UI displays requested ${sort} order after a previous column sort`, async () => {
		const ui = uiHarness({ sort });
		ui.state.sortKey = "citations";
		ui.state.sortDir = "desc";
		ui.get("filter").value = "old filter";
		await ui.runSearch();
		assert.equal(ui.get("filter").value, "", "previous local filter cannot hide new search results");
		assert.deepEqual(Array.from(ui.state.visible, r => r.key), sort === "citations" ? ["popular", "relevant"] : ["relevant", "popular"]);
		// Explicit column sorting still works after the initial requested order.
		ui.state.sortKey = "citations";
		ui.state.sortDir = "desc";
		ui.render();
		assert.equal(ui.state.visible[0].key, "popular");
	});
}

test("UI renders snapshots before completion and preserves selected merged records and manual sort", async () => {
	const finish = deferred();
	let ctx;
	const ui = uiHarness({ search: async (_source, _query, _http, context) => {
		ctx = context;
		ctx.onResults([paper("crossref:early", { doi: "10.1234/one", citations: 1 })], { final: false });
		return finish.promise;
	} });
	const running = ui.runSearch();
	assert.equal(ui.state.searching, true);
	assert.deepEqual(Array.from(ui.state.visible, r => r.key), ["crossref:early"]);
	assert.equal(ui.get("busy").hidden, true, "loading overlay does not obscure received results");
	ui.state.selected.add("crossref:early");
	ui.state.focusKey = ui.state.detailKey = "crossref:early";
	ui.state.sortKey = "citations";
	ui.state.sortDir = "desc";
	const snapshot = [paper("openalex:merged", { doi: "10.1234/one", citations: 1 }), paper("later", { citations: 50 })];
	ctx.onResults(snapshot, { final: false });
	assert.deepEqual(Array.from(ui.state.visible, r => r.key), ["later", "openalex:merged"]);
	assert.deepEqual(Array.from(ui.state.selected), ["openalex:merged"]);
	assert.equal(ui.state.focusKey, "openalex:merged");
	assert.equal(ui.state.detailKey, "openalex:merged");
	assert.equal(ui.state.records[0].rank, 1);
	assert.equal(snapshot[0].rank, undefined, "display metadata does not mutate source snapshots");
	finish.resolve(snapshot);
	await running;
	assert.deepEqual(Array.from(ui.state.selected), ["openalex:merged"]);
	assert.deepEqual(Array.from(ui.state.visible, r => r.key), ["later", "openalex:merged"]);
	assert.equal(ui.state.searching, false);
	ctx.onResults([paper("stale")]);
	assert.equal(ui.state.records.length, 2, "finished searches cannot deliver stale updates");
});

test("complete search failure differs from a successful empty response and banners reset on retry", async () => {
	let fail = true;
	const ui = uiHarness({ search: async () => {
		if (fail) throw new Error("All sources failed: offline");
		return [];
	} });
	await ui.runSearch();
	assert.match(ui.get("status").textContent, /^searchFailed\|All sources failed/);
	assert.equal(ui.get("statusbar").classList.contains("err"), true);
	assert.equal(ui.get("banner").hidden, false);
	assert.equal(ui.errors.length, 1);
	fail = false;
	await ui.runSearch();
	assert.match(ui.get("status").textContent, /^noResults\|/);
	assert.equal(ui.get("statusbar").classList.contains("err"), false);
	assert.equal(ui.get("banner").hidden, true);
	assert.equal(ui.get("search-btn").disabled, false);
});

test("a partial failure retains records and exposes its source error", async () => {
	const ui = uiHarness({ search: async (_source, _query, _http, ctx) => {
		ctx.errors = ["Crossref: HTTP 503"];
		return [paper("good")];
	} });
	await ui.runSearch();
	assert.equal(ui.state.records[0].key, "good");
	assert.match(ui.get("banner-text").textContent, /^partialFail\|Crossref: HTTP 503/);
	assert.equal(ui.get("statusbar").classList.contains("err"), false);
});

test("an installed PoP bridge receives the search context and can disclose its progress", async () => {
	let bridgeContext;
	const ui = uiHarness({ popBridge: { async search(query, ctx) {
		assert.equal(query.keywords, "genome editing");
		bridgeContext = ctx;
		ctx.onProgress("Google Scholar via Publish or Perish", 0, 10);
		assert.equal(ui.get("status").textContent, "Google Scholar via Publish or Perish");
		return [paper("bridge-result")];
	} }, search: async (_source, query, _http, ctx) => {
		assert.equal(typeof ctx.popSearch, "function");
		return ctx.popSearch(query, ctx);
	} });
	await ui.runSearch();
	assert.equal(bridgeContext.signal.aborted, false);
	assert.equal(ui.state.records[0].key, "bridge-result");
});

function savedRows() {
	return Object.assign([{ uid: "GS:cached", title: "Cached precise paper", authors: ["A Author"], year: 2026, cites: 3 }],
		{ cached: true, partial: true, capturedAt: new Date().toISOString() });
}

test("opening a restored Scholar query loads and labels its snapshot through the source pipeline without network", async () => {
	let calls = 0;
	const ui = uiHarness({ search: Sources.search, request: () => assert.fail("startup restore must not issue HTTP"),
		popBridge: { async search(query, ctx) {
			calls++;
			assert.equal(ctx.popCacheOnly, true);
			assert.equal(ctx.journalMetrics, false);
			assert.equal(ctx.enrichCitations, false);
			assert.equal(query.keywords, "genome editing");
			return savedRows();
		} } });
	ui.get("source").value = "scholar";
	await ui.restoreCachedSearch();
	assert.equal(calls, 1);
	assert.equal(ui.state.records.length, 1);
	assert.equal(ui.state.records[0].source, "scholar");
	assert.equal(ui.state.records[0].rank, 1);
	assert.equal(ui.state.visible[0].title, "Cached precise paper");
	assert.equal(ui.get("status").textContent, "cacheRestored|1");
	assert.match(ui.get("banner-text").textContent, /^cacheRestoredNotice\|/);
	assert.equal(ui.get("banner").hidden, false);
	assert.equal(ui.state.searching, false);
});

test("a completed live search cannot be overwritten by an earlier delayed cached restore", async () => {
	const pending = deferred();
	let signal;
	const ui = uiHarness({
		search: (...args) => args[3].popCacheOnly ? Sources.search(...args) : Promise.resolve([paper("fresh")]),
		popBridge: { async search(_query, ctx) { signal = ctx.signal; return pending.promise; } }
	});
	ui.get("source").value = "scholar";
	const restoring = ui.restoreCachedSearch();
	await ui.runSearch();
	assert.equal(signal.aborted, true);
	pending.resolve(savedRows());
	await restoring;
	assert.equal(ui.state.records[0].key, "fresh");
	assert.doesNotMatch(ui.get("status").textContent, /cacheRestored/);
});

test("Clear, query edits and source changes invalidate a pending startup cache restore", async () => {
	for (const change of [ui => ui.clearAll(), ui => { ui.get("keywords").value = "new query"; },
		ui => { ui.get("source").value = "openalex"; }, ui => ui.cancelCacheRestore()]) {
		const pending = deferred();
		const ui = uiHarness({ search: Sources.search, popBridge: { search: () => pending.promise } });
		ui.get("source").value = "scholar";
		const restoring = ui.restoreCachedSearch();
		change(ui);
		pending.resolve(savedRows());
		await restoring;
		assert.equal(ui.state.records.length, 0);
		assert.doesNotMatch(ui.get("status").textContent, /cacheRestored/);
	}
});

test("missing startup snapshots quietly preserve the ready state and source hint", async () => {
	const ui = uiHarness({ search: Sources.search, popBridge: { async search() { throw new Error("No matching PoP snapshot"); } },
		request: () => assert.fail("cache miss must not fall back to HTTP") });
	ui.get("source").value = "scholar";
	ui.get("status").textContent = "ready";
	ui.get("banner-text").textContent = "Scholar hint";
	await ui.restoreCachedSearch();
	assert.equal(ui.get("status").textContent, "ready");
	assert.equal(ui.get("banner-text").textContent, "Scholar hint");
	assert.equal(ui.state.records.length, 0);
	assert.equal(ui.errors.length, 0);
});

test("an HTTP error never throws while reading the response body", () => {
	// Zotero's XHR throws from the responseText getter unless responseType is "" or "text";
	// reading it unguarded turned every failed request into a broken error path.
	const src = readFileSync(new URL("../content/ui.js", import.meta.url), "utf8");
	const fn = src.match(/\tfunction httpError\(e, url\) \{[\s\S]*?\n\t\}/)[0];
	const scrub = src.match(/\tfunction scrubURLs\(text\) \{[\s\S]*?\n\t\}/)[0];
	const make = new Function(scrub.replace("function scrubURLs", "const scrubURLs = function") + "\n"
		+ fn.replace("function httpError", "return function httpError"))();

	const throwing = { get responseText() { throw new TypeError("responseText is only available if responseType is '' or 'text'"); },
		response: { message: "Insufficient budget" }, responseType: "json", status: 429 };
	const err = make({ status: 429, xmlhttp: throwing }, "https://api.openalex.org/works?search=x&mailto=a@b.c");
	assert.match(err.body, /Insufficient budget/, "the parsed body is used instead of responseText");
	assert.equal(err.status, 429);

	const textual = { responseType: "text", responseText: "plain failure", status: 503, response: null };
	assert.match(make({ status: 503, xmlhttp: textual }, "https://x/y").body, /plain failure/);

	// a getter that throws with no usable response must still produce an error object
	const hostile = { get responseText() { throw new Error("nope"); }, get response() { throw new Error("nope"); }, status: 500 };
	const safe = make({ status: 500, xmlhttp: hostile }, "https://x/y");
	assert.equal(safe.body, "");
	assert.match(safe.message, /HTTP 500/);
});

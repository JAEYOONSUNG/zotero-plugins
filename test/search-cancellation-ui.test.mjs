import { test } from "node:test";
import assert from "node:assert/strict";
import { deferred, paper, uiHarness } from "./helpers/search-ui-harness.mjs";

for (const method of ["getJSON", "getText"]) {
	test(`${method} bridges AbortSignal to Zotero's real cancellerReceiver contract`, async () => {
		let calls = 0, cancellations = 0, signal;
		const requestPending = deferred();
		const ui = uiHarness({ request: (_method, _url, options) => {
			calls++;
			assert.equal(options.responseType, method === "getJSON" ? "json" : "text");
			options.cancellerReceiver(() => { cancellations++; requestPending.reject(new Error("Request cancelled")); });
			return requestPending.promise;
		}, search: async (_source, _query, http, ctx) => {
			signal = ctx.signal;
			ctx.onResults([paper("received")], { final: false });
			await http[method]("https://example.org/search", {}, ctx.signal);
			return [];
		} });
		const running = ui.runSearch();
		assert.equal(calls, 1);
		ui.stopOperation();
		await running;
		assert.equal(signal.aborted, true);
		assert.equal(cancellations, 1);
		assert.equal(ui.state.records[0].key, "received");
		assert.equal(ui.get("status").textContent, "searchStopped|1");
		assert.equal(ui.get("banner").hidden, true);
		assert.equal(ui.errors.length, 0);
		assert.equal(ui.get("search-btn").disabled, false);
		assert.equal(ui.get("stop-btn").disabled, true);
		assert.equal(ui.state.searchController, null);
	});
}

test("an already aborted signal never starts an HTTP request", async () => {
	let calls = 0;
	const ui = uiHarness({ request: () => { calls++; } });
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(ui.http.getJSON("https://example.org", {}, controller.signal), { name: "AbortError" });
	await assert.rejects(ui.http.getText("https://example.org", {}, controller.signal), { name: "AbortError" });
	assert.equal(calls, 0);
});

test("cancellation before Zotero provides its canceller still aborts the request", async () => {
	const controller = new AbortController();
	const pending = deferred();
	let cancellations = 0, deliverCanceller;
	const ui = uiHarness({ request: (_method, _url, options) => {
		deliverCanceller = () => options.cancellerReceiver(() => { cancellations++; pending.reject(new Error("Request cancelled")); });
		return pending.promise;
	} });
	const request = ui.http.getJSON("https://example.org", {}, controller.signal);
	controller.abort();
	deliverCanceller();
	await assert.rejects(request, { name: "AbortError" });
	assert.equal(cancellations, 1);
});

test("settled requests detach abort listeners and preserve non-cancellation HTTP errors", async () => {
	const controller = new AbortController();
	let cancellations = 0, failure = false;
	const ui = uiHarness({ request: async (_method, _url, options) => {
		options.cancellerReceiver(() => cancellations++);
		if (failure) throw Object.assign(new Error("unavailable"), { status: 503 });
		return { response: { ok: true }, responseText: "text" };
	} });
	assert.deepEqual(await ui.http.getJSON("https://example.org", {}, controller.signal), { ok: true });
	failure = true;
	await assert.rejects(ui.http.getText("https://example.org", {}, controller.signal), { status: 503 });
	controller.abort();
	assert.equal(cancellations, 0);
});

test("Escape cancels search without presenting zero results as a completed empty query", async () => {
	const pending = deferred();
	let ctx;
	const ui = uiHarness({ search: async (_source, _query, _http, context) => { ctx = context; return pending.promise; } });
	const running = ui.runSearch();
	ui.onKeyDown({ key: "Escape" });
	assert.equal(ctx.signal.aborted, true);
	ctx.onResults([paper("after-stop")]);
	ctx.onProgress("after-stop", 1, 1);
	assert.equal(ui.get("status").textContent, "stopping");
	pending.resolve([paper("after-stop")]);
	await running;
	assert.equal(ui.state.records.length, 0);
	assert.equal(ui.get("status").textContent, "searchStopped|0");
	assert.equal(ui.errors.length, 0);
});

test("clearing an active query aborts it and prevents old results from repopulating the table", async () => {
	const pending = deferred();
	let ctx;
	const ui = uiHarness({ search: async (_source, _query, _http, context) => {
		ctx = context;
		ctx.onResults([paper("before-clear")]);
		return pending.promise;
	} });
	const running = ui.runSearch();
	ui.clearAll();
	assert.equal(ctx.signal.aborted, true);
	ctx.onResults([paper("after-clear")]);
	pending.resolve([paper("after-clear")]);
	await running;
	assert.equal(ui.state.records.length, 0);
	assert.equal(ui.get("status").textContent, "ready");
	assert.equal(ui.get("search-btn").disabled, false);
	assert.equal(ui.errors.length, 0);
});

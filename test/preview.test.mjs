import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import Preview from "../content/preview.js";
import { deferred, paper, uiHarness } from "./helpers/search-ui-harness.mjs";

const bytes = () => new TextEncoder().encode("%PDF-1.7\nfixture");

test("preview accepts only safe HTTP(S) candidates and derives known repository PDF links", () => {
	const record = { pdfUrls: ["javascript:alert(1)", "file:///private/document.pdf", "data:application/pdf,test", "https://example.org/a.pdf", "https://example.org/a.pdf"],
		pdfUrl: "https://user:pass@example.org/private.pdf", pmcid: "PMC123", arxiv: "2501.12345v2" };
	assert.deepEqual(Preview.candidates(record), ["https://example.org/a.pdf", "https://europepmc.org/articles/PMC123?pdf=render", "https://arxiv.org/pdf/2501.12345v2"]);
	assert.equal(Preview.originalURL({ url: "javascript:bad()", doi: "10.1234/safe" }), "https://doi.org/10.1234/safe");
	assert.equal(Preview.originalURL({ url: "data:text/html,bad" }), null);
	assert.throws(() => Preview.pdfBytes(new TextEncoder().encode("<html>publisher landing page</html>")), { name: "NotPDFError" });
});

test("opening preview creates one separate reusable window, including before its initial load", () => {
	const opened = [], shown = [];
	let focusCount = 0;
	const win = { closed: false, focus() { focusCount++; }, close() { this.closed = true; } };
	const manager = Preview.createManager(payload => { opened.push(payload); return win; });
	manager.open(paper("one"));
	manager.open(paper("two"));
	assert.equal(opened.length, 1);
	assert.equal(opened[0].record.key, "two", "latest selection is delivered when the window first loads");
	win.ZotPoPPreviewWindow = { showRecord: record => shown.push(record.key) };
	manager.open(paper("three"));
	assert.deepEqual(shown, ["three"]);
	assert.equal(focusCount, 3);
	manager.close();
	assert.equal(win.closed, true);
});

test("an open preview follows selection without stealing focus or refetching repeated redraws", () => {
	const shown = [];
	let opened = 0, focused = 0;
	const win = { closed: false, focus() { focused++; }, close() { this.closed = true; },
		ZotPoPPreviewWindow: { showRecord: record => shown.push(record.key) } };
	const manager = Preview.createManager(() => { opened++; return win; });
	manager.update(paper("before-opt-in"));
	assert.equal(opened, 0);
	manager.open(paper("first"));
	manager.update(paper("second"));
	manager.update(paper("second"));
	assert.deepEqual(shown, ["second"]);
	assert.equal(focused, 1);
	manager.close();
	manager.update(paper("after-close"));
	assert.equal(opened, 1);
});

test("missing PDFs show an original-link fallback without any network request or import", async () => {
	const states = [];
	const controller = Preview.createController({ fetchPDF: () => assert.fail("must not fetch a landing page"),
		renderPDF: () => assert.fail("must not render"), onState: state => states.push(state) });
	await controller.showRecord(paper("no-pdf", { url: "https://example.org/article" }));
	assert.equal(states[0].status, "unavailable");
	assert.equal(states[0].originalURL, "https://example.org/article");
});

test("a mislabeled HTML PDF is rejected and a later real PDF candidate can render", async () => {
	const states = [], requests = [];
	const controller = Preview.createController({
		async fetchPDF(url) { requests.push(url); return url.includes("landing") ? new TextEncoder().encode("<html>no PDF</html>") : bytes(); },
		async renderPDF(data) { assert.equal(data[0], 37); return { canvas: {}, pageCount: 7 }; },
		onState: state => states.push(state)
	});
	await controller.showRecord(paper("paper", { pdfUrls: ["https://example.org/landing", "https://example.org/file.pdf"] }));
	assert.equal(requests.length, 2);
	assert.deepEqual(states.map(s => s.status), ["loading", "ready"]);
	assert.equal(states.at(-1).pageCount, 7);
});

test("HTML and HTTP failures remain truthful unavailable/error states with original links", async () => {
	for (const [failure, expected] of [[Object.assign(new Error("HTML"), { name: "NotPDFError" }), "unavailable"], [new Error("HTTP 403"), "error"]]) {
		const states = [];
		const controller = Preview.createController({ fetchPDF: async () => { throw failure; }, renderPDF: () => assert.fail("must not render"),
			onState: state => states.push(state) });
		await controller.showRecord(paper("unavailable", { pdfUrl: "https://example.org/file.pdf", url: "https://example.org/article" }));
		assert.equal(states.at(-1).status, expected);
		assert.equal(states.at(-1).originalURL, "https://example.org/article");
	}
});

test("switching selection cancels the earlier load and ignores a stale completed render", async () => {
	const oldRender = deferred(), started = deferred(), states = [], signals = [];
	let renders = 0;
	const controller = Preview.createController({
		async fetchPDF(_url, signal) { signals.push(signal); return bytes(); },
		async renderPDF() { if (++renders === 1) { started.resolve(); return oldRender.promise; } return { canvas: "new", pageCount: 2 }; },
		onState: state => states.push(state)
	});
	const first = controller.showRecord(paper("old", { pdfUrl: "https://example.org/old.pdf" }));
	await started.promise;
	await controller.showRecord(paper("new", { pdfUrl: "https://example.org/new.pdf" }));
	assert.equal(signals[0].aborted, true);
	oldRender.resolve({ canvas: "old", pageCount: 10 });
	await first;
	assert.equal(states.at(-1).title, "new");
	assert.equal(states.at(-1).canvas, "new");
	controller.close();
	assert.equal(signals[1].aborted, true);
});

test("preview HTTP uses cancellable binary requests and never treats HTML as PDF", async () => {
	const controller = new AbortController(), pending = deferred();
	let cancels = 0;
	const zotero = { HTTP: { request(_method, _url, options) {
		assert.equal(options.responseType, "arraybuffer");
		options.cancellerReceiver(() => { cancels++; pending.reject(new Error("Cancelled")); });
		return pending.promise;
	} } };
	const request = Preview.fetchPDF("https://example.org/paper.pdf", controller.signal, zotero);
	controller.abort();
	await assert.rejects(request, { name: "AbortError" });
	assert.equal(cancels, 1);
	await assert.rejects(Preview.fetchPDF("https://example.org/landing", new AbortController().signal,
		{ HTTP: { request: async () => ({ response: new TextEncoder().encode("<html></html>").buffer }) } }), { name: "NotPDFError" });
});

test("the installed renderer is asked for page one and releases the PDF after drawing", async () => {
	const pages = [], options = [], canvas = { style: {}, getContext: () => ({}) };
	let destroyed = 0;
	const library = { GlobalWorkerOptions: {}, getDocument(value) {
		options.push(value);
		return { async destroy() { destroyed++; }, promise: Promise.resolve({ numPages: 9, async getPage(n) {
			pages.push(n);
			return { getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }), render: () => ({ promise: Promise.resolve(), cancel() {} }) };
		} }) };
	} };
	const render = Preview.createRenderer({ getLibrary: async () => library, createCanvas: () => canvas, width: () => 720, pixelRatio: () => 2 });
	const result = await render(bytes(), new AbortController().signal);
	assert.deepEqual(pages, [1]);
	assert.equal(result.pageCount, 9);
	assert.equal(result.canvas, canvas);
	assert.equal(destroyed, 1);
	assert.equal(options[0].isEvalSupported, false);
	assert.equal(library.GlobalWorkerOptions.workerSrc, "resource://zotero/reader/pdf/build/pdf.worker.mjs");
	assert.equal(canvas.width, 1440);
});

test("renderer cancellation stops PDF loading and releases the worker", async () => {
	const pending = deferred(), started = deferred();
	let destroyed = 0;
	const signal = new AbortController();
	const render = Preview.createRenderer({ getLibrary: async () => ({ GlobalWorkerOptions: {}, getDocument() {
		started.resolve();
		return { promise: pending.promise, async destroy() { destroyed++; pending.reject(new Error("Loading task destroyed")); } };
	} }), createCanvas: () => assert.fail("must not draw"), width: () => 700, pixelRatio: () => 1 });
	const rendering = render(bytes(), signal.signal);
	await started.promise;
	signal.abort();
	await assert.rejects(rendering, { name: "AbortError" });
	assert.equal(destroyed, 1);
});

test("search UI preview opens the focused or selected result separately without importing", async () => {
	const opened = [], shown = [];
	const ui = uiHarness({ openDialog(url, name, features, payload) {
		opened.push({ url, name, features, payload });
		return { closed: false, focus() {}, ZotPoPPreviewWindow: { showRecord: record => shown.push(record.key) } };
	} });
	await ui.runSearch();
	assert.equal(ui.get("preview-btn").disabled, true);
	ui.state.selected.add("relevant");
	ui.render();
	assert.equal(ui.get("preview-btn").disabled, false);
	ui.openPreview();
	assert.equal(opened[0].payload.record.key, "relevant");
	assert.equal(opened[0].url, "chrome://zotpop/content/preview.xhtml");
	assert.match(opened[0].features, /dialog=no/);
	ui.state.focusKey = "popular";
	ui.render();
	assert.deepEqual(shown, ["popular"]);
	ui.render();
	assert.deepEqual(shown, ["popular"], "redraws do not reload the same preview");
	ui.onKeyDown({ key: "p", preventDefault() {} });
	assert.deepEqual(shown, ["popular", "popular"], "P explicitly reopens/retries the focused preview");
	assert.equal(opened.length, 1);
	assert.equal(ui.state.importing, false);
	assert.equal(ui.state.records.length, 2);
});

test("preview markup has a separate window identity and visible original/preview actions", async () => {
	const markup = await fs.readFile(new URL("../content/preview.xhtml", import.meta.url), "utf8");
	assert.match(markup, /windowtype="zotpop:preview"/);
	assert.match(markup, /id="preview-original"/);
	assert.doesNotMatch(markup, /<iframe|<browser|https?:\/\/[^\s"]+\.js/);
	const search = await fs.readFile(new URL("../content/search.xhtml", import.meta.url), "utf8");
	assert.match(search, /id="preview-btn"/);
	assert.match(search, /id="d-preview"/);
});

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

test("search UI preview shows inside the detail card: no window, follows the open paper, P toggles", async () => {
	const shown = [], closed = [];
	let dialogs = 0;
	const fake = { page: 1, pageCount: 3, showRecord(r) { shown.push(r.key); }, goTo() {}, retry() {}, close() { closed.push(1); } };
	const ui = uiHarness({ openDialog() { dialogs++; }, previewModule: { ...Preview, createViewer: () => fake } });
	await ui.runSearch();
	assert.equal(ui.get("preview-btn").disabled, true);
	ui.state.selected.add("relevant");
	ui.render();
	assert.equal(ui.get("preview-btn").disabled, false);
	ui.openPreview();
	assert.deepEqual(shown, ["relevant"]);
	assert.equal(ui.state.detailKey, "relevant");
	assert.equal(ui.get("d-pdfview").hidden, false);
	assert.equal(ui.get("preview-btn").getAttribute("aria-pressed"), "true");
	ui.syncPreview();
	assert.deepEqual(shown, ["relevant"], "redraws do not reload the same preview");
	ui.onKeyDown({ key: "p", preventDefault() {} });
	assert.equal(ui.state.preview.on, false, "P closes it");
	assert.equal(ui.get("d-pdfview").hidden, true);
	assert.equal(closed.length >= 1, true);
	ui.onKeyDown({ key: "p", preventDefault() {} });
	assert.equal(ui.state.preview.on, true);
	assert.deepEqual(shown, ["relevant", "relevant"]);
	assert.equal(dialogs, 0, "openDialog is never called");
	assert.equal(ui.state.importing, false);
	assert.equal(ui.state.records.length, 2);
});

test("a quick run over rows fetches only the row it stops on", async () => {
	const shown = [];
	const fake = { page: 1, pageCount: 1, showRecord(r) { shown.push(r.key); }, goTo() {}, retry() {}, close() {} };
	const ui = uiHarness({ previewModule: { ...Preview, createViewer: () => fake } });
	await ui.runSearch();
	ui.openPreview(ui.state.records[0]);
	shown.length = 0;
	ui.state.detailKey = "popular"; ui.syncPreview(true);
	ui.state.detailKey = "relevant"; ui.syncPreview(true);
	ui.state.detailKey = "popular"; ui.syncPreview(true);
	await new Promise(r => setTimeout(r, 300));
	assert.deepEqual(shown, ["popular"]);
});

test("the in-window viewer turns pages, and a stale page or paper render is ignored", async () => {
	const states = [], renders = [];
	const mkPdf = () => ({ numPages: 3, getPage: async n => ({ getViewport: ({ scale }) => ({ width: 100 * scale, height: 100 * scale }),
		render: () => { const d = deferred(); renders.push({ n, d, cancelled: false }); const task = { promise: d.promise, cancel() { renders.at(-1).cancelled = true; } }; return task; } }) });
	let destroyed = 0;
	const canvas = () => ({ width: 0, height: 0, style: {}, getContext: () => ({}), tag: Math.random() });
	const viewer = Preview.createViewer({
		fetchPDF: async () => bytes(),
		getLibrary: async () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(mkPdf()), destroy: async () => { destroyed++; } }) }),
		createCanvas: canvas, width: () => 400, pixelRatio: () => 1, onState: s => states.push(s)
	});
	const first = viewer.showRecord(paper("a", { pdfUrl: "https://example.org/a.pdf" }));
	await new Promise(r => setTimeout(r, 10));
	renders[0].d.resolve(); await first;
	assert.equal(states.at(-1).status, "ready");
	assert.equal(states.at(-1).pageCount, 3);
	// Page 2 starts, page 3 is asked before it finishes: only page 3 is shown.
	const two = viewer.goTo(2); await new Promise(r => setTimeout(r, 5));
	const three = viewer.goTo(3); await new Promise(r => setTimeout(r, 5));
	renders[1].d.resolve(); renders[2].d.resolve(); await two; await three;
	assert.equal(renders[1].cancelled, true);
	assert.equal(states.at(-1).page, 3);
	assert.equal(viewer.page, 3);
	// A new paper while a page renders: the old canvas never lands.
	const turning = viewer.goTo(2); await new Promise(r => setTimeout(r, 5));
	const next = viewer.showRecord(paper("b", { pdfUrl: "https://example.org/b.pdf" }));
	const before = states.length;
	renders.at(-1).d.resolve(); await turning;
	assert.equal(states.slice(before).some(s => s.status === "ready" && s.page === 2 && s.title === "a"), false);
	await new Promise(r => setTimeout(r, 10));
	renders.at(-1).d.resolve(); await next;
	assert.equal(states.at(-1).title, "b");
	assert.equal(states.at(-1).page, 1);
	assert.ok(destroyed >= 1);
	viewer.close();
});

test("preview markup has a separate window identity and visible original/preview actions", async () => {
	const markup = await fs.readFile(new URL("../content/preview.xhtml", import.meta.url), "utf8");
	assert.match(markup, /windowtype="zotpop:preview"/);
	assert.match(markup, /id="preview-original"/);
	assert.doesNotMatch(markup, /<iframe|<browser|https?:\/\/[^\s"]+\.js/);
	const search = await fs.readFile(new URL("../content/search.xhtml", import.meta.url), "utf8");
	assert.match(search, /id="preview-btn"/);
	assert.doesNotMatch(search, /id="d-preview"/, "one preview button, in the toolbar");
	assert.equal((search.match(/preview-action/g) || []).length, 1);
});

test("pressing a row's PDF button right after its detail render still loads the preview (item 12)", async () => {
	const shown = [];
	const fake = { page: 1, pageCount: 1, showRecord(r) { shown.push(r.key); }, goTo() {}, retry() {}, close() {} };
	const ui = uiHarness({ previewModule: { ...Preview, createViewer: () => fake } });
	await ui.runSearch();
	ui.openPreview(ui.state.records[0]);
	shown.length = 0;
	const other = ui.state.records[1];
	ui.state.detailKey = other.key;
	ui.originalRenderDetail();            // the row click: real renderDetail schedules the follow timer
	ui.openPreview(other);                // the row's PDF button, before the timer fires
	await new Promise(r => setTimeout(r, 400));
	assert.deepEqual(shown, [other.key], "loaded exactly once, not stuck on loading");
});

test("the preview reads the library's own PDF before any remote one, and never trusts a file: URL from a source", async () => {
	const states = [], remote = [], local = [];
	const controller = Preview.createController({
		async fetchPDF(url) { remote.push(url); return bytes(); },
		async readLocal(path) { local.push(path); return bytes(); },
		async renderPDF() { return { canvas: {}, pageCount: 3 }; },
		onState: state => states.push(state)
	});
	await controller.showRecord(paper("held", { pdfUrl: "https://example.org/remote.pdf", localPDFPath: "/zotero/storage/AAAA/held.pdf" }));
	assert.deepEqual(local, ["/zotero/storage/AAAA/held.pdf"]);
	assert.deepEqual(remote, [], "the remote PDF is not fetched when the local one renders");
	assert.equal(states.at(-1).status, "ready");
	// A source can put anything in pdfUrls; a file: URL there is still refused.
	assert.deepEqual(Preview.candidates({ pdfUrls: ["file:///etc/passwd"], localPDFPath: "/zotero/x.pdf" }), []);
	// A missing or unreadable local file falls back to the remote copy.
	const fallback = [];
	const second = Preview.createController({
		async fetchPDF(url) { fallback.push(url); return bytes(); },
		async readLocal() { throw new Error("file is gone"); },
		async renderPDF() { return { canvas: {}, pageCount: 1 }; }, onState: () => {}
	});
	await second.showRecord(paper("held", { pdfUrl: "https://example.org/remote.pdf", localPDFPath: "/gone.pdf" }));
	assert.deepEqual(fallback, ["https://example.org/remote.pdf"]);
});

test("a held paper's preview resolves its local PDF first and passes it to the viewer", async () => {
	const shown = [], asked = [];
	const fake = { page: 1, pageCount: 1, showRecord(r) { shown.push([r.key, r.localPDFPath]); }, goTo() {}, retry() {}, close() {} };
	const ui = uiHarness({ previewModule: { ...Preview, createViewer: () => fake },
		importer: { findByTitle: async () => null, getLibraryDOIMap: async () => new Map(), forgetTitleIndex() {},
			localPDF: async (lib, rec, id) => { asked.push(id); return { itemID: id, attachmentID: 77, path: "/zotero/storage/AAAA/relevant.pdf" }; } },
		search: async () => [paper("relevant", { title: "Precise match", pdfUrl: "https://example.org/remote.pdf", inLibrary: true, libraryItemID: 5 })] });
	await ui.runSearch();
	const rec = ui.state.records[0]; rec.inLibrary = true; rec.libraryItemID = 5;
	ui.openPreview(rec);
	await new Promise(r => setTimeout(r, 10));
	assert.deepEqual(asked, [5]);
	assert.deepEqual(shown, [["relevant", "/zotero/storage/AAAA/relevant.pdf"]]);
});

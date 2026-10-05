/* The paper detail, round 8: the local PDF preview never shows another library's file, keys pressed in the
   detail stay there, the other version is actionable when it is not among the results, "Translate again"
   asks again and a changed abstract is not given the old translation, and the ranking follows a paper
   just added (held at once, the rest offered a re-rank) and says how much of the library it compared. */
import { test } from "node:test";
import assert from "node:assert/strict";
import Preview from "../content/preview.js";
import T from "../content/translate.js";
import I18N from "../content/i18n.js";
import { uiHarness, paper, mockElement } from "./helpers/search-ui-harness.mjs";

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

test("preview: a local PDF path found in one library is not shown after switching to another", async () => {
	const shown = [], asked = [];
	const fake = { page: 1, pageCount: 1, showRecord(r) { shown.push([r.key, r.localPDFPath]); }, goTo() {}, retry() {}, close() {} };
	const ui = uiHarness({ previewModule: { ...Preview, createViewer: () => fake },
		importer: { findByTitle: async () => null, getLibraryDOIMap: async () => new Map(), forgetTitleIndex() {},
			localPDF: async (lib, rec, id) => { asked.push([lib, id]); return { itemID: id, attachmentID: 77, path: "/lib" + lib + "/item" + id + ".pdf" }; } },
		search: async () => [paper("held", { title: "Held paper", pdfUrl: "https://example.org/remote.pdf" })] });
	await ui.runSearch();
	const rec = ui.state.records[0];
	rec.inLibrary = true; rec.libraryItemID = 101; ui.state.libraryID = 1;
	ui.openPreview(rec); await tick();
	assert.deepEqual(shown.at(-1), ["held", "/lib1/item101.pdf"]);
	ui.closePreview();
	// another library holds its own copy
	ui.state.libraryID = 2; rec.libraryItemID = 202;
	ui.openPreview(rec); await tick();
	assert.deepEqual(asked, [[1, 101], [2, 202]], "looked up again for the new library and item");
	assert.deepEqual(shown.at(-1), ["held", "/lib2/item202.pdf"]);
	ui.closePreview();
	// and a library that does not hold it: no local path at all
	rec.inLibrary = false;
	ui.openPreview(rec); await tick();
	assert.deepEqual(shown.at(-1), ["held", undefined]);
});

test("preview: a lookup that answers after the library changed is dropped", async () => {
	const shown = [];
	let release;
	const fake = { page: 1, pageCount: 1, showRecord(r) { shown.push(r.localPDFPath); }, goTo() {}, retry() {}, close() {} };
	const ui = uiHarness({ previewModule: { ...Preview, createViewer: () => fake },
		importer: { findByTitle: async () => null, getLibraryDOIMap: async () => new Map(), forgetTitleIndex() {},
			localPDF: () => new Promise(r => { release = () => r({ path: "/lib1/late.pdf" }); }) },
		search: async () => [paper("held", { title: "Held paper" })] });
	await ui.runSearch();
	const rec = ui.state.records[0];
	rec.inLibrary = true; rec.libraryItemID = 101; ui.state.libraryID = 1;
	ui.openPreview(rec); await tick();
	ui.state.libraryID = 2;
	release(); await tick();
	assert.equal(rec.localPDFPath, undefined, "not kept for the library now shown");
	assert.deepEqual(shown, []);
});

test("keys pressed with focus in the detail stay there: no row switch, no tick, no reading", async () => {
	const ui = uiHarness({ search: async () => [paper("a"), paper("b"), paper("c")] });
	await ui.runSearch();
	ui.state.focusKey = ui.state.detailKey = "a";
	const button = mockElement("button"); ui.get("detail").appendChild(button); button.focus();
	for (const key of ["PageDown", "ArrowDown", "End", " ", "Delete"]) {
		let prevented = false;
		ui.onKeyDown({ key, preventDefault() { prevented = true; } });
		assert.equal(prevented, false, key + " is the detail's");
	}
	assert.equal(ui.state.focusKey, "a");
	assert.equal(ui.state.selected.size, 0);
	const summary = mockElement("summary"); ui.get("detail").appendChild(summary); summary.focus();
	ui.onKeyDown({ key: " ", preventDefault() {} });
	assert.equal(ui.state.selected.size, 0, "Space opens the fold, it does not tick the row");
	// back on the table the keys work as before
	ui.get("table-wrap").focus();
	ui.onKeyDown({ key: "ArrowDown", preventDefault() {} });
	assert.equal(ui.state.focusKey, "b");
});

test("the other version outside the results: select the library's copy, or open its DOI", async () => {
	const selected = [], launched = [];
	const ui = uiHarness({ mainWindow: { ZoteroPane: { selectItem: id => selected.push(id) } }, launchURL: url => launched.push(url),
		search: async () => [paper("pre", { title: "A preprint", publishedAs: { doi: "10.1000/PUB", venue: "Cell", year: 2025 } })] });
	await ui.runSearch();
	ui.state.doiMap = new Map([["10.1000/pub", 42]]);
	const r = ui.state.records[0];
	ui.renderVersions(r);
	const buttons = ui.get("d-versions").querySelectorAll("button");
	assert.deepEqual(buttons.map(b => b.textContent), ["verShowLibrary", "verOpenDoi"]);
	assert.equal(buttons[0].getAttribute("data-opens"), "library");
	assert.equal(buttons[1].getAttribute("data-opens"), "browser");
	buttons[0].emit("click"); buttons[1].emit("click");
	assert.deepEqual(selected, [42]);
	assert.deepEqual(launched, ["https://doi.org/10.1000/pub"]);
	// not held: only the DOI
	ui.state.doiMap = new Map();
	ui.renderVersions(r);
	assert.deepEqual(ui.get("d-versions").querySelectorAll("button").map(b => b.textContent), ["verOpenDoi"]);
});

test("translation: 'again' asks anew and keeps the old one if that fails; a changed text is not given the old translation", async () => {
	let n = 0, fail = false;
	const tr = T.create({ zotero: { PDFTranslate: { api: { translate: async text => { if (fail) throw new Error("down"); n++; return { status: "success", result: "번역 " + n + ": " + text, service: "deeplfree" }; } } } }, pref: () => undefined, uiLocale: "ko" });
	await tr.translateCached({ key: "k", lang: "ko", text: "Short abstract" });
	assert.equal((await tr.translateCached({ key: "k", lang: "ko", text: "Short abstract" })).cached, true);
	assert.equal(n, 1);
	await tr.translateCached({ key: "k", lang: "ko", text: "Short abstract", fresh: true });
	assert.equal(n, 2, "Translate again sends a request");
	assert.match(tr.cached("k", "ko", "abstract", "Short abstract").text, /번역 2/);
	fail = true;
	await assert.rejects(tr.translateCached({ key: "k", lang: "ko", text: "Short abstract", fresh: true }));
	assert.match(tr.cached("k", "ko", "abstract", "Short abstract").text, /번역 2/, "the last good translation stays");
	fail = false;
	assert.equal(tr.cached("k", "ko", "abstract", "The full abstract, arrived later"), null, "not shown for a different text");
	const out = await tr.translateCached({ key: "k", lang: "ko", text: "The full abstract, arrived later" });
	assert.equal(out.cached, undefined);
	assert.match(out.text, /full abstract/);
});

test("the strings this round adds exist in both languages", () => {
	for (const k of ["verShowLibrary", "verOpenDoi", "relRerank", "relCoverage"])
		for (const lang of ["en", "ko"]) assert.ok(k in I18N.STRINGS[lang], `${lang}: ${k}`);
	assert.match(I18N.STRINGS.en.retractedTip, /PubMed/);
	assert.match(I18N.STRINGS.en.relCoverage(3, 1200), /3 of 1,200 papers of yours with a DOI/);
});

// Round 2: the search flow from the query box to the library -- restored searches, offline, history, adding.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { paper, uiHarness } from "./helpers/search-ui-harness.mjs";
import I18N from "../content/i18n.js";

const tick = () => new Promise(r => setTimeout(r, 10));
// A library that holds one paper without a DOI, found by its title as the import would find it.
const titleLibrary = (heldTitle, id = 501) => ({
	getLibraryDOIMap: async () => new Map(), forgetTitleIndex() {},
	findByTitle: async (_lib, title) => title === heldTitle ? id : null,
	getReadingStates: async ids => new Map(ids.map(i => [i, "reading"])),
	getCollectionPaths: async ids => new Map(ids.map(i => [i, [["Shelf", "Methods"]]]))
});

test("a search opened from history marks the papers the library holds now, title matches included", async () => {
	const files = new Map(), title = "Held paper without a DOI in the library";
	const first = uiHarness({ historyFiles: files, importer: titleLibrary(title), search: async () => [paper("held", { title }), paper("other", { title: "Another paper entirely here today" })] });
	await first.runSearch();
	assert.equal(first.state.records.find(r => r.key === "held").inLibrary, true);
	const [entry] = await first.history.list();

	const again = uiHarness({ historyFiles: files, importer: titleLibrary(title), search: async () => assert.fail("history must not search") });
	await again.openHistoryEntry(entry.id);
	const held = again.state.records.find(r => r.key === "held");
	assert.equal(held.inLibrary, true, "the title-matched paper is still shown as held");
	assert.equal(held.libraryItemID, 501);
	assert.equal(held.readState, "reading");
	assert.deepEqual(held.collections, [["Shelf", "Methods"]]);
	assert.equal(again.state.libCounts.owned, 1);
});

test("a restored search never carries the item id or reading state it was saved with", async () => {
	const files = new Map(), title = "Held paper without a DOI in the library";
	const first = uiHarness({ historyFiles: files, importer: titleLibrary(title), search: async () => [paper("held", { title })] });
	await first.runSearch();
	const [entry] = await first.history.list();
	const saved = await first.history.get(entry.id);
	assert.equal(saved.records[0].libraryItemID, undefined, "the saved snapshot holds no library item id");
	assert.equal(saved.records[0].readState, undefined, "nor a reading state");
	// The paper has since left the library.
	const again = uiHarness({ historyFiles: files, importer: titleLibrary("nothing held"), search: async () => assert.fail("history must not search") });
	await again.openHistoryEntry(entry.id);
	const r = again.state.records[0];
	assert.equal(r.inLibrary, false);
	assert.equal(r.libraryItemID ?? null, null);
	assert.equal(r.readState ?? null, null);
});

// ---------------------------------------------------------------- offline
const offlineHTTP = () => { throw Object.assign(new Error("NetworkError when attempting to fetch resource."), { status: 0 }); };

test("offline: a search that cannot reach any source says so, offers a retry, and shows the saved run of the same search", async () => {
	const files = new Map();
	let online = true;
	const make = () => uiHarness({ historyFiles: files, zotero: { HTTP: { request: async () => { if (!online) offlineHTTP(); return { response: {} }; } } },
		search: async (_s, _q, http) => { await http.getJSON("https://api.openalex.org/works?search=x"); return [paper("saved", { title: "Saved paper", doi: "10.1/saved" })]; } });
	const ui = make();
	await ui.runSearch();
	assert.equal(ui.state.records.length, 1);
	online = false;
	const off = make();
	await off.runSearch();
	assert.match(off.get("status").textContent, /^searchOffline/);
	assert.equal(off.state.records.length, 1, "the saved results of this search are shown");
	assert.equal(off.state.records[0].key, "saved");
	assert.equal(off.get("banner").hidden, false);
	assert.match(off.get("banner-text").textContent, /^offlineSaved/);
	assert.equal(off.get("banner-action").hidden, false, "the banner offers to try again");
	assert.equal(off.get("banner-action").textContent, "searchRetry");
	online = true;
	off.wireEvents();
	off.get("banner-action").emit("click");
	await tick(); await tick();
	assert.doesNotMatch(off.get("status").textContent, /^searchOffline/);
});

test("offline with nothing saved: the message names the connection and the banner can retry", async () => {
	const ui = uiHarness({ zotero: { HTTP: { request: async () => offlineHTTP() } },
		search: async (_s, _q, http) => { await http.getJSON("https://api.crossref.org/works?q=x"); return []; } });
	await ui.runSearch();
	assert.match(ui.get("status").textContent, /^searchOffline/);
	assert.equal(ui.get("banner-action").textContent, "searchRetry");
	assert.equal(ui.state.records.length, 0);
});

test("a failure that is not the network keeps its own message, and still offers a retry", async () => {
	const ui = uiHarness({ search: async () => { throw Object.assign(new Error("HTTP 500 · api.openalex.org"), { status: 500 }); } });
	await ui.runSearch();
	assert.match(ui.get("status").textContent, /^searchFailed/);
	assert.equal(ui.get("banner-action").hidden, false);
	assert.equal(ui.get("banner-action").textContent, "searchRetry");
});

test("the offline and retry strings exist in both languages, and the Korean one says what to do", () => {
	for (const lang of ["en", "ko"]) for (const key of ["searchOffline", "offlineSaved", "searchRetry", "historyRemove", "historyRemoveTip", "historyClearConfirm", "keywordsHelp"]) {
		assert.ok(I18N.STRINGS[lang][key], `${lang}.${key}`);
	}
	assert.match(I18N.STRINGS.ko.searchOffline, /세요/);
});

// ---------------------------------------------------------------- history menu
test("one saved search can be removed from the history menu, and clearing all asks once more", async () => {
	const files = new Map();
	let n = 0;
	const ui = uiHarness({ historyFiles: files, search: async () => [paper("p" + (++n), { title: "Paper " + n })] });
	ui.get("keywords").value = "first query"; await ui.runSearch();
	ui.get("keywords").value = "second query"; await ui.runSearch();
	assert.equal((await ui.history.list()).length, 2);
	await ui.openHistoryMenu();
	const menu = ui.get("histmenu");
	const rows = menu.querySelectorAll(".histopt");
	assert.equal(rows.length, 2);
	const remove = rows[0].querySelectorAll(".h-act").find(b => b.textContent === "historyRemove");
	assert.ok(remove, "each saved search has a remove action");
	assert.equal(remove.getAttribute("data-writes"), "history");
	remove.emit("click");
	await tick();
	assert.equal((await ui.history.list()).length, 1, "only that one is forgotten");
	assert.equal(ui.get("histmenu").querySelectorAll(".histopt").length, 1, "the menu is redrawn without it");

	const clear = ui.get("histmenu").querySelector(".histclear");
	clear.emit("click");
	await tick();
	assert.equal((await ui.history.list()).length, 1, "the first press only asks");
	assert.match(clear.textContent, /historyClearConfirm/);
	assert.equal(ui.get("histmenu").hidden, false, "the menu stays open for the second press");
	clear.emit("click");
	await tick();
	assert.equal((await ui.history.list()).length, 0);
});

// ---------------------------------------------------------------- adding
const importer = (results) => ({ getReadingStates: async () => new Map(), getCollectionPaths: async ids => new Map(ids.map(i => [i, [["Target"]]])),
	getLibraryDOIMap: async () => new Map(), forgetTitleIndex() {}, findByTitle: async () => null,
	importRecord: async r => results[r.key] });

test("adding: a paper already held and now filed in the chosen collection is a success, not a warning", async () => {
	const ui = uiHarness({ importer: importer({
		filed: { status: "exists", item: { id: 7 }, addedToCollection: true, pdf: "skipped" },
		there: { status: "exists", item: { id: 8 }, addedToCollection: false, pdf: "skipped" } }),
		search: async () => [paper("filed", { title: "Filed one" }), paper("there", { title: "There one" })] });
	await ui.runSearch();
	await ui.importRecords(ui.state.records.slice());
	const [filed, there] = ui.state.records;
	assert.equal(filed.statusClass, "ok");
	assert.equal(there.statusClass, "", "already there and already filed: nothing went wrong, no warning dot");
	assert.equal(filed.inLibrary, true);
});

test("adding re-reads where the added papers are filed, so the detail names the collection", async () => {
	const ui = uiHarness({ importer: importer({ a: { status: "added", item: { id: 41 }, pdf: "skipped", how: "translator" } }),
		search: async () => [paper("a", { title: "Alpha paper" })] });
	await ui.runSearch();
	await ui.importRecords([ui.state.records[0]]);
	await tick();
	assert.deepEqual(ui.state.records[0].collections, [["Target"]]);
	assert.equal(ui.state.records[0].libraryItemID, 41);
	assert.equal(ui.state.records[0].inLibrary, true);
});

test("the reading-queue option is remembered and the options line follows it", async () => {
	const ui = uiHarness({ prefs: { queueOnAdd: false }, zotero: { StyleCustom: { queueForReading: async () => {}, isQueued: () => false } } });
	ui.wireEvents();
	const box = ui.get("opt-queue");
	box.checked = true;
	box.emit("change");
	assert.equal(ui.prefs.queueOnAdd, true);
	assert.match(ui.get("import-opts-toggle").textContent, /optQueueShort/);
	const src = fs.readFileSync(new URL("../content/ui.js", import.meta.url), "utf8");
	assert.match(src, /\$\("opt-queue"\)\.checked = PREF\("queueOnAdd"\) === true/, "the window opens with the remembered choice");
});

// ---------------------------------------------------------------- query box and wording
test("the keyword box explains its syntax and the identifier shortcut", () => {
	const markup = fs.readFileSync(new URL("../content/search.xhtml", import.meta.url), "utf8");
	assert.match(markup, /<input id="keywords"[^>]*data-i18n-title="keywordsHelp"/);
	for (const lang of ["en", "ko"]) {
		const help = I18N.STRINGS[lang].keywordsHelp;
		assert.match(help, /AND/);
		assert.match(help, /DOI/);
		assert.match(help, /PMID/);
	}
});

test("the row help says Enter opens a held paper's own PDF, not always the browser", () => {
	for (const lang of ["en", "ko"]) {
		const s = I18N.STRINGS[lang];
		assert.match(s.detailEmpty, lang === "en" ? /PDF/ : /PDF/);
		assert.match(s.firstHint("X", 3), /PDF/);
	}
});

// ---------------------------------------------------------------- round 2, from the outside review
import vm from "node:vm";
function importerWithIds(heldExtra) {
	const saved = [{ id: 9, f: { title: "Genome editing", extra: heldExtra } }];
	let nextID = 10;
	class Item { constructor() { this.itemTypeID = 1; this.f = {}; } setField(k, v) { this.f[k] = v; } getField(k) { return this.f[k] || ""; } setCreators() {} setCollections() {}
		async saveTx() { if (!this.id) { this.id = nextID++; saved.push(this); } return this.id; } }
	const Zotero = { Item, logError() {}, ItemTypes: { getID: () => 1 }, ItemFields: { getID: n => n, isValidForType: () => true },
		Translate: { Search: class { setIdentifier() {} async getTranslators() { return []; } } },
		Items: { getAsync: async id => saved.find(i => i.id === id) },
		DB: { queryAsync: async (sql, params) => {
			if (/fieldName IN \('extra', 'archiveID', 'url'\)/.test(sql)) return saved.flatMap(i => ["extra", "archiveID", "url"].filter(k => i.f[k]).map(k => ({ itemID: i.id, fieldName: k, value: i.f[k] })));
			return [];
		} } };
	const ctx = vm.createContext({ Zotero, ZotPoPSources: { SOURCES: {}, normalizeDOI: v => v || null } });
	vm.runInContext(fs.readFileSync(new URL("../content/importer.js", import.meta.url), "utf8"), ctx);
	return { imp: ctx.ZotPoPImporter, saved };
}
const quiet = { libraryID: 1, attachPDF: false, skipDuplicates: true, citationsInExtra: false };

test("duplicates: a DOI-less PubMed result whose PMID the library holds is not saved again, short title or not", async () => {
	const { imp, saved } = importerWithIds("PMID: 123456\nPMCID: PMC1");
	const res = await imp.importRecord({ title: "Genome editing", year: 2020, pmid: "123456", authors: [] }, quiet);
	assert.equal(res.status, "exists");
	assert.equal(res.item.id, 9);
	assert.equal(saved.length, 1);
	const other = await imp.importRecord({ title: "Genome editing", year: 2020, pmid: "1234567", authors: [] }, quiet);
	assert.equal(other.status, "added", "a PMID that only contains the held one is another paper");
});

test("duplicates: an arXiv result matches the held copy by its arXiv id, version aside", async () => {
	const { imp } = importerWithIds("arXiv: 2101.00001v2");
	const res = await imp.importRecord({ title: "Short title", year: 2021, arxiv: "2101.00001", authors: [] }, quiet);
	assert.equal(res.status, "exists");
});

test("a query the sources would refuse is named before the results on screen are cleared", async () => {
	const ui = uiHarness({ search: async () => [paper("a"), paper("b")] });
	await ui.runSearch();
	ui.state.selected.add("a");
	ui.get("yearFrom").value = "2026"; ui.get("yearTo").value = "2020";
	await ui.runSearch();
	assert.match(ui.get("status").textContent, /^badYearOrder/);
	assert.equal(ui.state.records.length, 2, "the rows stay");
	assert.ok(ui.state.selected.has("a"), "and so do the checks");
	ui.get("yearFrom").value = ""; ui.get("yearTo").value = ""; ui.get("maxResults").value = "0";
	await ui.runSearch();
	assert.match(ui.get("status").textContent, /^badLimit/);
	assert.equal(ui.state.records.length, 2);
});

test("a stopped rerun never overwrites the complete saved run of the same search", async () => {
	const files = new Map();
	let release;
	const ui = uiHarness({ historyFiles: files, search: async (_s, _q, _h, ctx) => {
		if (!release) return [paper("a"), paper("b"), paper("c")];
		ctx.onResults([paper("a")]);
		return new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError" }))));
	} });
	await ui.runSearch();
	release = true;
	const run = ui.runSearch();
	await tick();
	ui.stopOperation();
	await run;
	await tick();
	const [entry] = await ui.history.list();
	assert.equal(entry.count, 3);
	assert.equal(entry.partial, false);
});

test("adding: the destination cannot change mid-run, and Retry keeps add-and-queue", async () => {
	let fail = true;
	const calls = [];
	const sc = { queueForReading: async items => { calls.push(Array.from(items, i => i.id)); }, isQueued: () => false };
	const ui = uiHarness({ zotero: { StyleCustom: sc, Items: { get: id => ({ id }) } }, importer: {
		getReadingStates: async () => new Map(), getCollectionPaths: async () => new Map(), getLibraryDOIMap: async () => new Map(), forgetTitleIndex() {}, findByTitle: async () => null,
		importRecord: async () => { assert.equal(ui.get("target").disabled, true, "the destination is locked while adding"); return fail ? { status: "failed", error: "x" } : { status: "added", item: { id: 5 }, pdf: "skipped", how: "translator" }; } },
		search: async () => [paper("a", { title: "Alpha" })] });
	await ui.runSearch();
	ui.get("opt-queue").checked = false;
	await ui.importRecords([ui.state.records[0]], { queue: true });
	assert.equal(ui.get("target").disabled, false);
	fail = false;
	ui.wireEvents();
	ui.get("banner-action").emit("click");
	await tick(); await tick();
	assert.deepEqual(calls, [[5]], "the retried paper is queued as first asked");
});

test("Cmd+C with text selected copies the text, not the focused row's citation", () => {
	const ui = uiHarness();
	ui.state.records = [paper("a", { title: "Alpha" })];
	ui.render();
	ui.state.focusKey = "a";
	ui.selection.current = { isCollapsed: false, toString: () => "a sentence of the abstract" };
	let prevented = false;
	ui.onKeyDown({ key: "c", metaKey: true, preventDefault() { prevented = true; } });
	assert.equal(prevented, false);
	assert.equal(ui.copied.length, 0);
	ui.selection.current = null;
	ui.onKeyDown({ key: "c", metaKey: true, preventDefault() { prevented = true; } });
	assert.equal(prevented, true);
	assert.equal(ui.copied.length, 1);
});

test("a translation that ends after the reader moved on leaves the other paper's card alone", async () => {
	let finish;
	const ui = uiHarness({ realRows: true, prefs: { translateTitle: false }, globals: { ZotPoPTranslate: { byCode: c => ({ code: c, name: "Korean" }), LANGUAGES: [] } },
		sources: { fetchPubMedAbstracts: () => new Promise(r => { finish = r; }) },
		search: async () => [paper("a", { pmid: "1" }), paper("b", { abstract: "B abstract" })] });
	await ui.runSearch();
	ui.setTranslatorForTest({ cached: () => null, defaultLanguage: () => "ko", translateCached: async () => assert.fail("nothing to translate") });
	ui.state.detailKey = "a";
	const run = ui.runTranslate();
	ui.state.detailKey = "b";
	ui.get("d-tr-note").textContent = "";
	finish(new Map());
	await run;
	assert.equal(ui.get("d-tr-note").textContent, "", "A's 'no text' is not written under B");
});

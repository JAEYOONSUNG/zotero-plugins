import { test } from "node:test";
import assert from "node:assert/strict";
import S from "../content/sources.js";

const context = () => ({ enrichCitations: false, journalMetrics: false, institutionMetrics: false });
function recorder(answer) {
	const urls = [];
	return { urls,
		async getJSON(url) { urls.push(url); return answer(url) ?? {}; },
		async getText(url) { urls.push(url); return ""; } };
}
const summary = (uid, extra = {}) => ({ uid, title: "Unrelated heading", authors: [{ name: "Smith A", authtype: "Author" }],
	pubdate: "2021", fulljournalname: "Journal of Things", source: "J Things", articleids: [{ idtype: "doi", value: "10.1000/x" + uid }], ...extra });
const pubmedHttp = (docs) => recorder(url => {
	if (url.includes("esearch")) return { esearchresult: { count: String(docs.length), idlist: docs.map(d => d.uid) } };
	if (url.includes("esummary")) return { result: { uids: docs.map(d => d.uid), ...Object.fromEntries(docs.map(d => [d.uid, d])) } };
	return {};
});

test("pubmed: a paper matched on its abstract is kept although its title lacks the query words", async () => {
	const http = pubmedHttp([summary("111")]);
	const rows = await S.search("pubmed", { keywords: "alpha beta", maxResults: 10 }, http, context());
	assert.equal(rows.length, 1);
});

test("pubmed: Retracted Publication sets retracted, a retraction notice does not, and the type is kept", async () => {
	const http = pubmedHttp([
		summary("1", { pubtype: ["Journal Article", "Retracted Publication"] }),
		summary("2", { pubtype: ["Journal Article", "Retraction of Publication"] }),
		summary("3", { pubtype: ["Review", "Journal Article"] })]);
	const rows = await S.search("pubmed", { title: "Unrelated", maxResults: 10 }, http, context());
	const by = id => rows.find(r => r.pmid === id);
	assert.equal(by("1").retracted, true);
	assert.equal(by("2").retracted, false);
	assert.equal(by("2").workType, "retraction");
	assert.equal(by("3").retracted, false);
	assert.equal(by("3").workType, "review");
});

test("an explicit PMID: prefix accepts 1 to 9 digits, a bare short number stays free text", async () => {
	for (const text of ["PMID:271968", "PMID:5", "PMID=123456789"]) {
		const http = pubmedHttp([summary("271968")]);
		await S.search("pubmed", { keywords: text, maxResults: 5 }, http, context());
		const digits = /(\d+)$/.exec(text)[1];
		assert.ok(http.urls.some(u => u.includes(encodeURIComponent(digits + "[uid]"))), text + " becomes a uid lookup");
	}
	const http = pubmedHttp([]);
	await S.search("pubmed", { keywords: "271968", maxResults: 5 }, http, context());
	assert.ok(!http.urls.some(u => u.includes("%5Buid%5D")), "bare digits are not an identifier");
});

test("Semantic Scholar keeps PubMedCentral as a PMC id, so a PMCID search finds the paper", async () => {
	const paper = { paperId: "abc", title: "Anything", year: 2020, authors: [], externalIds: { DOI: "10.1000/z", PubMedCentral: "7562722" } };
	const http = recorder(() => paper);
	const rows = await S.search("semanticscholar", { keywords: "PMC7562722", maxResults: 5 }, http, context());
	assert.equal(rows.length, 1);
	assert.equal(rows[0].pmcid, "PMC7562722");
});

// ---------------------------------------------------------------- UI
import { uiHarness, paper, deferred } from "./helpers/search-ui-harness.mjs";

test("a late lookup for the previous library never marks rows held in the current one", async () => {
	const lib1 = deferred(), lib2 = deferred();
	const importer = {
		getLibraryDOIMap: id => (id === 1 ? lib1.promise : lib2.promise),
		findByTitle: async () => null, forgetTitleIndex() {}
	};
	const ui = uiHarness({ realRows: true, importer });
	ui.state.records = [paper("a", { doi: "10.1000/a", inLibrary: true, libraryItemID: 77 })];
	ui.get("target").value = "1";
	const first = ui.refreshLibraryFlags();
	ui.get("target").value = "2";
	const second = ui.refreshLibraryFlags();
	lib2.resolve(new Map());
	await second;
	assert.equal(ui.state.records[0].inLibrary, false, "not held in library 2");
	assert.equal(ui.state.records[0].libraryItemID, null, "stale item id cleared");
	lib1.resolve(new Map([["10.1000/a", 99]]));
	await first;
	assert.equal(ui.state.records[0].inLibrary, false, "library 1's late answer is ignored");
	assert.equal(ui.state.records[0].libraryItemID, null);
	assert.equal(ui.state.libraryID, 2);
	assert.equal(ui.state.doiMap.size, 0);
});

test("saving the CSV twice in the same minute never overwrites the first file", async () => {
	const files = new Map(), writes = [];
	const IOUtils = {
		exists: async path => files.has(path),
		async writeUTF8(path, text, options = {}) {
			writes.push(path);
			if (options.noOverwrite && files.has(path)) throw Object.assign(new Error("exists"), { name: "NoModificationAllowedError" });
			files.set(path, text);
		}
	};
	const PathUtils = { join: (...parts) => parts.join("/") };
	const ui = uiHarness({ realRows: true, globals: { IOUtils, PathUtils }, zotero: { DataDirectory: { dir: "/out" }, File: { reveal() {}, pathToFile: p => p } } });
	ui.state.visible = [paper("a", { title: "One" })];
	await ui.saveCSV(); await ui.saveCSV(); await ui.saveCSV();
	const paths = [...files.keys()];
	assert.equal(paths.length, 3, "three exports, three files");
	assert.match(paths[0], /zotpop-\d{8}-\d{4}\.csv$/);
	assert.match(paths[1], /-2\.csv$/);
	assert.match(paths[2], /-3\.csv$/);
	assert.match(ui.get("status").textContent + " " + ui.errors.length, /csvSaved\|\/out\/zotpop-.*-3\.csv/, "the saved path is shown");
});

test("a file that appears between the check and the write is retried with the next suffix", async () => {
	const files = new Map();
	let racing = true;
	const IOUtils = {
		exists: async () => false,
		async writeUTF8(path, text, options = {}) {
			if (racing) { racing = false; files.set(path, "other program"); }
			if (options.noOverwrite && files.has(path)) throw Object.assign(new Error("exists"), { name: "NoModificationAllowedError" });
			files.set(path, text);
		}
	};
	const ui = uiHarness({ realRows: true, globals: { IOUtils, PathUtils: { join: (...p) => p.join("/") } }, zotero: { DataDirectory: { dir: "/out" }, File: { reveal() {}, pathToFile: p => p } } });
	ui.state.visible = [paper("a")];
	await ui.saveCSV();
	assert.equal(files.size, 2);
	assert.ok([...files.values()].includes("other program"), "the other program's file is untouched");
});

test("1,200 rows: a filter change reuses every built row, creates no elements and the list holds a handful of listeners", () => {
	const records = Array.from({ length: 1200 }, (_, i) => paper("k" + i, { title: (i % 2 ? "odd " : "even ") + "paper " + i, doi: "10.1000/p" + i,
		pdfUrl: "http://x/" + i + ".pdf", inLibrary: true, authors: [{ name: "A B" }], venue: "Journal", citations: i }));
	const ui = uiHarness({ realRows: true, columns: true, importer: { findByTitle: async () => null, getLibraryDOIMap: async () => new Map(records.map(r => [r.doi, 1])), forgetTitleIndex() {} } });
	const walk = (n, f) => { f(n); for (const c of n.children || []) walk(c, f); };
	const measure = () => { let elements = 0, listeners = 0; walk(ui.get("results-body"), n => { if (n.nodeType === 1) { elements++; listeners += n.listenerCount(); } }); return { elements, listeners }; };
	ui.state.doiMap = new Map(records.map(r => [r.doi, 1]));
	ui.displaySearchResults(records);
	// Only the rows near the view are built (virtual-list.test.mjs); the other 1,200 are data.
	const first = new Set(ui.get("results-body").children);
	const initial = measure();
	assert.ok(first.size > 0 && first.size <= 60, first.size + " rows built");
	assert.ok(initial.listeners <= 10, "delegated: " + initial.listeners + " listeners, not 7 per row");
	ui.get("filter").value = "odd"; ui.render();
	assert.equal(ui.state.visible.length, 600);
	// The odd rows were half of the window; the rest of the filtered window is built once.
	ui.get("filter").value = ""; ui.render();
	const created = ui.counts.created;
	ui.get("filter").value = "odd"; ui.render();
	ui.get("filter").value = ""; ui.render();
	let rows = ui.get("results-body").children;
	assert.equal(rows.length, first.size);
	assert.equal(rows.filter(r => first.has(r)).length, first.size, "every shown row is a kept one");
	assert.equal(ui.counts.created, created, "no element created by two filter changes once each window was seen");
	assert.deepEqual(measure(), initial);
});

test("a reused row follows the selection and is rebuilt when what it shows changes", () => {
	const ui = uiHarness({ realRows: true, columns: true });
	const rec = () => [paper("a", { title: "Alpha", doi: "10.1000/a" }), paper("b", { title: "Beta" })];
	ui.displaySearchResults(rec());
	const rowA = () => ui.get("results-body").children.find(r => r.dataset.key === "a");
	const before = rowA();
	ui.state.selected.add("a"); ui.render();
	assert.equal(rowA(), before, "same row object");
	assert.ok(rowA().classList.contains("selected"), "selection repainted");
	ui.state.records.find(r => r.key === "a").year = 1999; ui.render();
	assert.notEqual(rowA(), before, "a changed field rebuilds the row");
	assert.ok(rowA().classList.contains("selected"));
});

test("clicks are handled once on the list: a row click focuses it and a double click reads it", () => {
	const ui = uiHarness({ realRows: true, columns: true });
	ui.displaySearchResults([paper("a", { title: "Alpha" }), paper("b", { title: "Beta" })]);
	const rows = ui.get("results-body").children;
	rows[1].emit("click", { target: rows[1].children[3] });
	assert.equal(ui.state.focusKey, "b");
	assert.ok(rows[1].classList.contains("focused"));
	const box = rows[0].children[0].querySelector("input");
	box.checked = true; box.emit("change");
	assert.ok(ui.state.selected.has("a"));
});

test("streamed pages are drawn in batches: twenty pages inside one frame cost two draws, not twenty", async () => {
	let ctx;
	const finish = deferred();
	const ui = uiHarness({ realRows: true, columns: true, search: async (_s, _q, _h, context) => { ctx = context; return finish.promise; } });
	let draws = 0;
	const table = ui.get("results-table"), original = table.setAttribute.bind(table);
	table.setAttribute = (name, value) => { if (name === "data-cols") draws++; return original(name, value); };
	const running = ui.runSearch();
	draws = 0;
	for (let i = 1; i <= 20; i++) ctx.onResults(Array.from({ length: i * 5 }, (_, j) => paper("k" + j, { title: "t" + j })), { final: false });
	assert.equal(draws, 1, "the first page draws at once");
	assert.equal(ui.state.records.length, 100, "the data is current");
	await new Promise(resolve => setTimeout(resolve, 250));
	assert.equal(draws, 2, "the rest is one trailing draw");
	assert.equal(ui.state.visible.length, 100);
	assert.ok(ui.get("results-body").children.length <= 60, "only the rows near the view are built");
	finish.resolve([]);
	await running;
});

test("the empty list names the filters that are on and one button resets them all", () => {
	const ui = uiHarness({ realRows: true, columns: true });
	ui.displaySearchResults([paper("a", { title: "Alpha", year: 2020 }), paper("b", { title: "Beta", year: 2021 })]);
	ui.state.yearRange = { from: 1990, to: 1995 };
	ui.get("filter").value = "alpha";
	ui.state.libraryFilter = "owned";
	ui.render();
	assert.equal(ui.state.visible.length, 0);
	const box = ui.get("empty");
	assert.doesNotMatch(box.textContent, /Esc|×/, "no promise that Esc clears a year rule");
	const named = box.querySelector(".empty-filters").textContent;
	assert.match(named, /emptyFilterText\|alpha/);
	assert.match(named, /emptyFilterYears\|1990\|1995/);
	assert.match(named, /emptyFilterLibrary/);
	box.querySelector(".empty-reset").emit("click");
	assert.equal(ui.state.yearRange, null);
	assert.equal(ui.state.libraryFilter, "all");
	assert.equal(ui.get("filter").value, "");
	assert.equal(ui.state.visible.length, 2);
});

// ---------------------------------------------------------------- English quantities
import I18N from "../content/i18n.js";

test("English counts agree with their noun: 0, 1, 2 and 1,200 across every count-taking string", () => {
	const en = I18N.STRINGS.en;
	// Parameters that carry a quantity of things (not years, versions or indexes into a list).
	const COUNT = new Set(["n", "k", "count", "total", "loaded", "done", "added", "pdfs", "exists", "failed", "unowned", "on", "off", "cut", "unknown", "change", "pdf"]);
	const wrongSingular = /(?<![\d,.])[+-]?1 (?:\w+ )?(?:papers|results|authors|citations|works|profiles|sources|rows|cites|others|groups|items|records)\b/;
	// Page numbers are positions, not quantities of things.
	const ORDINAL = new Set(["previewPageOf", "previewPageCount"]);
	let scanned = 0;
	for (const [key, fn] of Object.entries(en)) {
		if (typeof fn !== "function" || ORDINAL.has(key)) continue;
		const params = /^\s*(?:\(([^)]*)\)|(\w+))\s*=>/.exec(fn.toString());
		const names = (params?.[1] ?? params?.[2] ?? "").split(",").map(x => x.trim().replace(/=.*$/, "").trim()).filter(Boolean);
		const counted = names.filter(name => COUNT.has(name));
		if (!counted.length) continue;
		scanned++;
		for (const n of [0, 1, 2, 1200]) {
			const text = String(fn(...names.map(name => COUNT.has(name) ? n : name === "partial" || name === "stopped" ? false : "X")));
			if (n === 1) assert.doesNotMatch(text, wrongSingular, `${key}(1) reads "${text}"`);
			if (n === 1200) assert.doesNotMatch(text, /(?<![\d,])1200\b/, `${key}(1200) should group digits: "${text}"`);
			if (n !== 1) assert.doesNotMatch(text, /(?<![\w'.])(?:0|[2-9]|\d[\d,]*) (?:\w+ )?(?:paper|result|author(?! profile)|work(?! group)|profile|source|row|cite|group|record|citation|other)\b(?!s)/, `${key}(${n}) reads "${text}"`);
		}
	}
	assert.ok(scanned >= 40, "the scan saw " + scanned + " count strings");
	assert.equal(en.personConfirm(1), "Compute for this paper");
	assert.equal(en.personConfirm(2), "Compute for these 2 papers");
	assert.equal(en.authorStatWorks(1), "1 paper");
	assert.equal(en.authorStatWorks(1200), "1,200 papers");
	assert.equal(en.authorStatCited(1), "1 citation");
	assert.equal(en.citeSince(1, 5, 6), "+1 citation since the last look (5 → 6)");
	assert.equal(en.citeSince(-1, 6, 5), "-1 citation since the last look (6 → 5)");
	assert.equal(en.citeSince(12, 5, 17), "+12 citations since the last look (5 → 17)");
	assert.equal(en.tipAuthorsAll(1), "1 author");
	assert.equal(en.personChosen("A", 1), "A · 1 paper");
});

// Round 4: the results table and its filters -- streaming batches, sorting, CSV, the filter builder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Sources from "../content/sources.js";
import Filters from "../content/filters.js";
import Authors from "../content/authors.js";
import I18N from "../content/i18n.js";
import { paper, uiHarness } from "./helpers/search-ui-harness.mjs";

const plain = value => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------- several journals, one batch each
const epmcRow = (id, journal) => ({ id, title: "Paper " + id + " on repair", pubYear: "2024", doi: "10.1000/" + id, citedByCount: 3,
	journalInfo: { journal: { title: journal } }, authorList: { author: [] } });
const epmcHTTP = () => ({
	async getJSON(url) {
		let q = decodeURIComponent(url);
		if (/JOURNAL:"Cell"/.test(q)) return { hitCount: 1, resultList: { result: [epmcRow("c1", "Cell")] } };
		if (/JOURNAL:"Nature Methods"/.test(q)) return { hitCount: 1, resultList: { result: [epmcRow("n1", "Nature Methods")] } };
		return { hitCount: 0, resultList: { result: [] } };
	},
	async getText() { return ""; }
});

test("several journals asked one at a time: each streamed batch holds the earlier journals' papers too", async () => {
	const snapshots = [];
	const recs = await Sources.search("europepmc", { keywords: "repair", venues: [{ name: "Cell" }, { name: "Nature Methods" }], maxResults: 20 }, epmcHTTP(),
		{ journalMetrics: false, institutionMetrics: false, enrichCitations: false, onResults: rows => snapshots.push(rows.map(r => r.doi).sort()) });
	assert.deepEqual(recs.map(r => r.doi).sort(), ["10.1000/c1", "10.1000/n1"]);
	const firstWithNature = snapshots.findIndex(s => s.includes("10.1000/n1"));
	assert.ok(firstWithNature >= 0);
	for (const s of snapshots.slice(firstWithNature)) assert.ok(s.includes("10.1000/c1"), "Cell's paper never leaves the list: " + JSON.stringify(s));
});

test("a row checked in an early batch stays checked when the next journal's batch arrives", async () => {
	let ui;
	const a = paper("a", { doi: "10.1/a" }), b = paper("b", { doi: "10.1/b" }), c = paper("c", { doi: "10.1/c" });
	let runs = 0;
	ui = uiHarness({ search: async (_s, _q, _http, ctx) => {
		if (runs++) { ctx.onResults([b]); ctx.onResults([c]); return [a, b, c]; }
		ctx.onResults([a, b]);
		ui.state.selected.add("a");
		// A batch that does not hold the first journal's rows (a source that streams per journal).
		ctx.onResults([c]);
		assert.equal(ui.state.records.length, 1);
		ctx.onResults([a, b, c]);
		assert.ok(ui.state.selected.has("a"), "checked again as soon as the row is back");
		return [a, b, c];
	} });
	await ui.runSearch();
	assert.deepEqual(plain([...ui.state.selected]), ["a"]);
	// The carry ends with the search: a later search does not bring the old check back.
	await ui.runSearch();
	assert.equal(ui.state.selected.size, 0);
});

// ---------------------------------------------------------------- sorting
test("a paper with no year, journal or OA 2-year mean sorts last in either direction, and ties keep the source's order", async () => {
	const ui = uiHarness({ search: async () => [
		paper("noyear", { year: null, venue: "", journalOA2y: null }),
		paper("old", { year: 2019, venue: "Cell", journalOA2y: 4 }),
		paper("new", { year: 2024, venue: "Nature", journalOA2y: 5 }),
		paper("tie", { year: 2019, venue: "Cell", journalOA2y: 4 })
	] });
	await ui.runSearch();
	const order = (key, dir) => { ui.state.sortKey = key; ui.state.sortDir = dir; ui.render(); return Array.from(ui.state.visible, r => r.key); };
	assert.deepEqual(order("year", "asc"), ["old", "tie", "new", "noyear"]);
	assert.deepEqual(order("year", "desc"), ["new", "old", "tie", "noyear"]);
	assert.deepEqual(order("venue", "asc"), ["old", "tie", "new", "noyear"]);
	assert.deepEqual(order("venue", "desc"), ["new", "old", "tie", "noyear"]);
	assert.deepEqual(order("journalOA2y", "asc"), ["old", "tie", "new", "noyear"]);
	assert.deepEqual(order("journalOA2y", "desc"), ["new", "old", "tie", "noyear"]);
});

// ---------------------------------------------------------------- CSV
const parseCSV = text => text.split("\n").map(line => line.slice(1, -1).split('","'));
test("CSV: an unknown cites-per-year is an empty cell, not a dash a spreadsheet reads as text", async () => {
	const ui = uiHarness({ metrics: { citesPerYear: r => r.year ? 2.5 : null }, search: async () => [paper("dated", { year: 2020 }), paper("undated", { year: null })] });
	await ui.runSearch();
	const [, dated, undated] = parseCSV(ui.csvText());
	assert.equal(dated[1], "2.50");
	assert.equal(undated[1], "", "no dash in a number column");
});

test("CSV: a title or author that starts like a formula is written as text", async () => {
	const ui = uiHarness({ search: async () => [paper("f", { title: "=HYPERLINK(\"http://x\",\"y\")", authors: [{ name: "@Kim" }], venue: "+Plus" }), paper("n", { title: "-1 is negative", year: 2020 })] });
	await ui.runSearch();
	const lines = ui.csvText().split("\n");
	assert.ok(lines[1].includes('"\'=HYPERLINK('), lines[1]);
	assert.ok(lines[1].includes('"\'@Kim"'));
	assert.ok(lines[1].includes('"\'+Plus"'));
	assert.ok(lines[2].includes('"\'-1 is negative"'));
	assert.ok(lines[2].includes('"2020"'), "numbers are left alone");
});

// ---------------------------------------------------------------- the filter builder
test("the journal rule's search finds a journal by the abbreviation or acronym a reader types", async () => {
	const ui = uiHarness({ realRows: true, search: async () => [
		paper("p", { venue: "Proceedings of the National Academy of Sciences" }),
		paper("m", { venue: "Nature Methods" }),
		paper("j", { venue: "Journal of the American Chemical Society" }),
		paper("x", { venue: "Some Local Bulletin", journalAbbrev: "Loc Bull" })
	] });
	await ui.runSearch(); ui.wireEvents();
	ui.get("filter-btn").emit("click");
	const rule = ui.addRule("journal", "include");
	ui.render();
	ui.openFilterPop(rule.id);
	const shown = query => {
		const input = ui.get("filter-pop").querySelector(`[data-fid="rule:${rule.id}:first"]`);
		input.value = query; input.emit("input");
		return plain(ui.get("filter-pop").querySelectorAll(".fp-opt").map(o => o.querySelector(".fp-opt-name").textContent));
	};
	assert.deepEqual(shown("PNAS"), ["Proceedings of the National Academy of Sciences"]);
	assert.deepEqual(shown("Nat. Methods"), ["Nature Methods"]);
	assert.deepEqual(shown("jacs"), ["Journal of the American Chemical Society"]);
	assert.deepEqual(shown("Proc Natl Acad"), ["Proceedings of the National Academy of Sciences"]);
	assert.deepEqual(shown("loc bull"), ["Some Local Bulletin"], "the abbreviation the source gave");
	assert.deepEqual(shown("methods"), ["Nature Methods"], "the name itself still works");
});

test("Filters.searchOptions matches alternatives with punctuation ignored", () => {
	const opts = [{ key: "a", label: "Nature Methods", alts: ["Nat Methods"] }, { key: "b", label: "Cell" }];
	assert.deepEqual(Filters.searchOptions(opts, "nat. meth").map(o => o.key), ["a"]);
	assert.deepEqual(Filters.searchOptions(opts, "cell").map(o => o.key), ["b"]);
	assert.equal(Filters.searchOptions(opts, "").length, 2);
});

test("a citation or year threshold says how many papers have no value and can keep them", async () => {
	const ui = uiHarness({ realRows: true, search: async () => [paper("cited", { citations: 40 }), paper("pubmed1", { citations: null }), paper("pubmed2", { citations: null }), paper("low", { citations: 2 })] });
	await ui.runSearch(); ui.wireEvents();
	ui.get("filter-btn").emit("click");
	const rule = ui.addRule("cites", "include"); rule.min = 10; ui.render();
	assert.deepEqual(Array.from(ui.state.visible, r => r.key), ["cited"], "unknowns are out by default, as before");
	ui.openFilterPop(rule.id);
	const toggle = ui.get("filter-pop").querySelector(`[data-fid="unknown:${rule.id}"]`);
	assert.ok(toggle, "a citation rule offers the toggle too (PubMed and arXiv give no counts)");
	assert.match(toggle.parentNode.textContent, /filterUnknownIn\|2/, "with how many papers it concerns");
	toggle.checked = true; toggle.emit("change");
	assert.deepEqual(Array.from(ui.state.visible, r => r.key).sort(), ["cited", "pubmed1", "pubmed2"]);
	assert.ok(Filters.UNKNOWN_KINDS.includes("year") && Filters.UNKNOWN_KINDS.includes("cpy"));
});

test("a range chip reads as typed and says when papers with no value are kept", async () => {
	const ui = uiHarness({ realRows: true, search: async () => [paper("a", { journalOA2y: 3 }), paper("b", { journalOA2y: null })] });
	await ui.runSearch(); ui.wireEvents();
	const rule = ui.addRule("oa2y", "include"); rule.min = 2.25; ui.render();
	const chip = () => ui.get("filter-chips").querySelector(".fchip").textContent;
	assert.match(chip(), /≥ 2\.25/);
	assert.doesNotMatch(chip(), /filterUnknownChip/);
	rule.includeUnknown = true; ui.render();
	assert.match(chip(), /≥ 2\.25 filterUnknownChip/);
});

// ---------------------------------------------------------------- while results stream in
test("an author's papers streaming in keep the sort the reader chose after the first batch", async () => {
	const profile = { provider: "orcid", id: "0000-0001-8277-5907", name: "Known public profile" };
	let ui;
	ui = uiHarness({ authorsService: { ...Authors, loadPublications: async (_profile, _options, _http, ctx) => {
		ctx.onResults([paper("high", { authorProfile: profile, citations: 90 }), paper("low", { authorProfile: profile, citations: 1 })]);
		ui.state.sortKey = "citations"; ui.state.sortDir = "asc"; ui.render();
		ctx.onResults([paper("high", { authorProfile: profile, citations: 90 }), paper("low", { authorProfile: profile, citations: 1 }), paper("new", { authorProfile: profile, citations: 5 })]);
		return [paper("high", { authorProfile: profile, citations: 90 }), paper("low", { authorProfile: profile, citations: 1 }), paper("new", { authorProfile: profile, citations: 5 })];
	} } });
	await ui.switchSearchMode("authors"); await ui.switchAuthorProvider("orcid"); ui.get("author-input").value = profile.id;
	await ui.runAuthorAction("publications", profile);
	assert.equal(ui.state.sortKey, "citations");
	assert.equal(ui.state.sortDir, "asc");
	assert.deepEqual(Array.from(ui.state.visible, r => r.key), ["low", "new", "high"]);
});

// ---------------------------------------------------------------- filters saved with a pinned search
test("rules restored from a pinned search get fresh ids, so a new rule never shares one", () => {
	const saved = JSON.parse(JSON.stringify([{ id: "r1", kind: "journal", mode: "exclude", values: ["biorxiv"], labels: { biorxiv: "bioRxiv" } }, { id: "r2", kind: "cites", mode: "include", min: 10, includeUnknown: true }, { id: "r3", kind: "nonsense" }]));
	const revived = Filters.reviveRules(saved);
	const fresh = Filters.newRule("year");
	assert.equal(revived.length, 2, "an unknown kind is dropped");
	assert.equal(new Set([...revived.map(r => r.id), fresh.id]).size, 3);
	assert.deepEqual(plain(revived[0].values), ["biorxiv"]);
	assert.equal(revived[0].mode, "exclude");
	assert.equal(revived[1].min, 10);
	assert.equal(revived[1].includeUnknown, true);
	assert.ok(/Filters\.reviveRules\(f\.rules\)/.test(readFileSync(new URL("../content/ui.js", import.meta.url), "utf8")), "the pin restore uses it");
});

test("words typed into a rule and a scrolled option list survive a batch of results arriving", async () => {
	const many = Array.from({ length: 40 }, (_, i) => paper("p" + i, { venue: "Journal " + i }));
	const ui = uiHarness({ realRows: true, search: async () => many });
	await ui.runSearch(); ui.wireEvents();
	ui.get("filter-btn").emit("click");
	const words = ui.addRule("text", "include"); ui.render();
	ui.openFilterPop(words.id);
	let input = ui.get("filter-pop").querySelector(`[data-fid="rule:${words.id}:first"]`);
	input.value = "protein repair"; input.emit("input");
	ui.displaySearchResults(many, { stream: false });
	input = ui.get("filter-pop").querySelector(`[data-fid="rule:${words.id}:first"]`);
	assert.equal(input.value, "protein repair", "the unfinished words are still there");
	const journal = ui.addRule("journal", "include"); ui.render();
	ui.openFilterPop(journal.id);
	ui.get("filter-pop").querySelector(`[data-fid="opts:${journal.id}"]`).scrollTop = 300;
	const cb = ui.get("filter-pop").querySelector(`[data-fid="opt:${journal.id}:journal 7"]`);
	cb.checked = true; cb.emit("change");
	assert.equal(ui.get("filter-pop").querySelector(`[data-fid="opts:${journal.id}"]`).scrollTop, 300, "the list keeps its place");
});

// ---------------------------------------------------------------- CSV: who the corresponding author is
const person = (name, position, institution, country, h, extra = {}) => ({ name, position, corresponding: false, institution, country, institutionH: h, ...extra });
test("CSV: the corresponding columns say whether the source flagged that person or it is the last author assumed", async () => {
	const ui = uiHarness({ realRows: true, search: async () => [
		paper("flagged", { people: [person("A", "first", "Lab A", "US", 10), person("B", "last", "Lab B", "DE", 500, { corresponding: true })] }),
		paper("assumed", { people: [person("A", "first", "Lab A", "US", 10), person("B", "last", "Lab B", "DE", 500)] }),
		paper("self", { people: [person("A", "first", "Lab A", "US", 10, { corresponding: true }), person("B", "last", "Lab B", "DE", 500)] })
	] });
	await ui.runSearch();
	const head = I18N.STRINGS.en.csvHead;
	assert.ok(head.includes("CorrespondingBasis"));
	assert.equal(I18N.STRINGS.ko.csvHead.length, head.length);
	const rows = ui.csvText().split("\n").slice(1).map(l => l.match(/"(?:[^"]|"")*"/g).map(c => c.slice(1, -1)));
	const at = (row, name) => row[head.indexOf(name)];
	const byKey = Object.fromEntries(rows.map(r => [r[head.indexOf("Title")], r]));
	assert.equal(at(byKey.flagged, "CorrespondingInstitution"), "Lab B");
	assert.equal(at(byKey.flagged, "CorrespondingBasis"), "csvCorrFlagged");
	assert.equal(at(byKey.assumed, "CorrespondingInstitution"), "Lab B");
	assert.equal(at(byKey.assumed, "CorrespondingBasis"), "csvCorrLastAuthor", "the last author is named as an assumption");
	assert.equal(at(byKey.self, "CorrespondingInstitution"), "Lab A", "a first author flagged corresponding is the corresponding author too");
	assert.equal(at(byKey.self, "CorrespondingBasis"), "csvCorrFlagged");
});

// ---------------------------------------------------------------- the citations cell
test("the citations cell's rising/falling mark names OpenAlex when the count beside it is another index's", async () => {
	const { default: Cite } = await import("../content/cite.js");
	const now = new Date().getFullYear();
	const series = [{ year: now - 2, n: 40 }, { year: now - 1, n: 30 }];
	const ui = uiHarness({ cite: Cite, realRows: true, search: async () => [
		paper("s2", { year: now - 5, citations: 150, citationSource: "semanticscholar", citationsBy: { openalex: 90, semanticscholar: 150 }, citesByYear: series }),
		paper("oa", { year: now - 5, citations: 90, citationSource: "openalex", citesByYear: series })
	] });
	await ui.runSearch();
	const cellTip = r => Array.from(ui.buildRow(r).children).find(c => c.dataset.k === "citations").getAttribute("data-tip");
	const [s2, oa] = ["s2", "oa"].map(k => ui.state.records.find(r => r.key === k));
	assert.match(cellTip(s2), /citeMarkDown/);
	assert.match(cellTip(s2), /citeTrendOf\|OpenAlex/, "the trend is said to be OpenAlex's");
	assert.doesNotMatch(cellTip(oa), /citeTrendOf/, "no extra words when the count is OpenAlex's own");
});

test("no unknown toggle when every paper has the figure", async () => {
	const ui = uiHarness({ realRows: true, search: async () => [paper("a", { year: 2020 }), paper("b", { year: 2021 })] });
	await ui.runSearch(); ui.wireEvents();
	ui.get("filter-btn").emit("click");
	const rule = ui.addRule("year", "include"); rule.min = 2021; ui.render();
	ui.openFilterPop(rule.id);
	assert.equal(ui.get("filter-pop").querySelector(`[data-fid="unknown:${rule.id}"]`), null);
});

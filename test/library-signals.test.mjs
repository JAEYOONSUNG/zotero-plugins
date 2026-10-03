import { test } from "node:test";
import assert from "node:assert/strict";
import S from "../content/sources.js";
import Signals from "../content/signals.js";
import fs from "node:fs";
import vm from "node:vm";
import { uiHarness, paper } from "./helpers/search-ui-harness.mjs";

const importerScript = fs.readFileSync(new URL("../content/importer.js", import.meta.url), "utf8");
const loadImporter = Zotero => { const c = vm.createContext({ Zotero, ZotPoPSignals: Signals }); vm.runInContext(importerScript, c); return c.ZotPoPImporter; };
const ctxQuiet = { journalMetrics: false, enrichCitations: false };

test("OpenAlex asks for is_retracted (search and DOI enrichment) and the record carries it; sources merge it", async () => {
	const urls = [];
	const work = (n, extra = {}) => ({ id: `https://openalex.org/W${n}`, doi: `10.1234/w${n}`, title: `Article ${n}`, publication_year: 2024, ...extra });
	const records = await S.search("openalex", { keywords: "research", maxResults: 10 }, { getJSON: async url => {
		urls.push(url);
		return { results: [work(1, { is_retracted: true }), work(2, { is_retracted: false }), work(3)], meta: { count: 3 } };
	} }, ctxQuiet);
	assert.match(urls[0], /select=[^&]*\bis_retracted\b/);
	assert.deepEqual(records.map(r => r.retracted), [true, false, false]);
	const rec = S.makeRecord({ source: "crossref", title: "T", doi: "10.1234/x" });
	const enrichUrls = [];
	await S.enrichFromOpenAlex([rec], { getJSON: async url => { enrichUrls.push(url); return { results: [{ doi: "https://doi.org/10.1234/x", cited_by_count: 3, is_retracted: true }] }; } }, {});
	assert.match(enrichUrls[0], /select=[^&]*\bis_retracted\b/);
	assert.equal(rec.retracted, true);
	assert.equal(S.mergeRecords([[S.makeRecord({ source: "openalex", sourceId: "W1", title: "Same paper here", doi: "10.1234/m", retracted: true })], [S.makeRecord({ source: "crossref", sourceId: "10.1234/m", title: "Same paper here", doi: "10.1234/m" })]])[0].retracted, true, "one source saying retracted is enough");
});

test("Europe PMC: a Retracted Publication is flagged, its Retraction notice is not", async () => {
	const rows = [["R1", "Retracted Publication"], ["R2", "Retraction of Publication"], ["R3", "Journal Article"]];
	const records = await S.search("europepmc", { keywords: "research", maxResults: 10 }, { getJSON: async () => ({ hitCount: 3, resultList: { result: rows.map(([id, type]) => ({
		id, source: "MED", pmid: id.slice(1), title: "Paper " + id, pubYear: "2020", doi: "10.9/" + id, authorString: "Smith J", journalInfo: { journal: { title: "J" } }, pubTypeList: { pubType: [type] } })) } }) }, ctxQuiet);
	assert.deepEqual(Object.fromEntries(records.map(r => [r.sourceId, r.retracted])), { R1: true, R2: false, R3: false });
});

test("the retracted chip is on the row before the title and in the detail card, nowhere else", async () => {
	const ui = uiHarness({ realRows: true, search: async () => [paper("bad", { title: "Withdrawn paper", retracted: true }), paper("fine", { title: "Fine paper" })] });
	await ui.runSearch(); ui.wireEvents();
	const rows = ui.get("results-body").querySelectorAll("tr");
	const mark = r => r.querySelector(".retract-mark");
	assert.ok(mark(rows[0]) && mark(rows[0]).textContent === "retractedChip");
	assert.equal(rows[0].querySelector(".t-main").children[0], mark(rows[0]), "before the title");
	assert.equal(mark(rows[1]), null);
	ui.state.detailKey = "bad";
	ui.originalRenderDetail();
	const chips = ui.get("d-badges").querySelectorAll(".badge");
	assert.equal(chips[0].className, "badge retracted");
	ui.state.detailKey = "fine"; ui.originalRenderDetail();
	assert.equal(ui.get("d-badges").querySelectorAll(".retracted").length, 0);
});

const works = {
	"1:LIB00001": { openalex: "W10", references: ["W500", "W77"] },
	"1:LIB00002": { openalex: "W20", references: ["W77"] },
	"1:LIB00003": { openalex: "W30", references: [] },
	"1:LIBGONE": { missing: true }
};
const runtime = (extra = {}) => ({ paperWorks: () => works, watchedAuthors: () => [], state: () => ({ status: "unread" }), ...extra });

test("library signals: which of my papers cite this one, and which of mine this one cites", () => {
	const lw = Signals.libraryWorks(runtime());
	assert.equal(lw.length, 3, "a looked-up-and-missing entry is not a work");
	assert.deepEqual(Signals.libraryCiting("https://openalex.org/W77", lw), ["1:LIB00001", "1:LIB00002"]);
	assert.deepEqual(Signals.libraryCiting("W500", lw), ["1:LIB00001"]);
	assert.deepEqual(Signals.libraryCiting("W999", lw), []);
	assert.deepEqual(Signals.libraryCited(["https://openalex.org/W20", "W30", "W404"], lw), ["1:LIB00002", "1:LIB00003"]);
	assert.deepEqual(Signals.libraryCited([], lw), []);
	assert.equal(Signals.runtimeOf({}), null);
	assert.equal(Signals.runtimeOf({ StyleCustom: {} }), null, "a runtime without the accessors is not used");
	assert.deepEqual(Signals.libraryWorks(null), []);
});

test("referenced works: one metered request, id and references read, remembered, never asked once the budget is spent", async () => {
	S.clearWorkCache();
	const urls = [];
	const http = { getJSON: async url => { urls.push(url); return { id: "https://openalex.org/W9", referenced_works: ["https://openalex.org/W10", "https://openalex.org/W20"] }; } };
	const rec = { doi: "10.1234/ref", source: "crossref" };
	const first = await S.fetchReferencedWorks(rec, http, { openAlexApiKey: "k" });
	assert.deepEqual({ ok: first.ok, cached: first.cached, id: first.id, ids: first.ids }, { ok: true, cached: false, id: "W9", ids: ["W10", "W20"] });
	assert.match(urls[0], /\/works\/doi:10\.1234%2Fref\?select=id,referenced_works/);
	const second = await S.fetchReferencedWorks(rec, http, {});
	assert.equal(second.cached, true); assert.equal(urls.length, 1, "the second ask is answered from memory");
	assert.deepEqual((await S.fetchReferencedWorks({ doi: "10.1234/other" }, http, { openAlexSpent: true })), { ok: false, reason: "budget" });
	assert.equal(urls.length, 1);
	assert.equal((await S.fetchReferencedWorks({ title: "no ids" }, http, {})).reason, "id");
	const quota = Object.assign(new Error("429"), { status: 429, url: "https://api.openalex.org/works/pmid:1" });
	const spent = {}; const failed = await S.fetchReferencedWorks({ pmid: "1" }, { getJSON: async () => { throw quota; } }, spent);
	assert.equal(failed.ok, false);
});

test("followed authors: matched by OpenAlex id or ORCID, by name only when the source gave no id", () => {
	const watched = [{ id: "A1", name: "Mina Kim" }, { id: "A2", name: "Ola Berg", orcid: "0000-0001-2345-6789" }, { id: "A3", name: "Jo Park" }];
	const rec = { people: [{ name: "M. Kim", openalexId: "A1" }, { name: "Ola B.", orcid: "https://orcid.org/0000-0001-2345-6789", openalexId: null }, { name: "Jo Park", openalexId: "A99" }], authors: [{ name: "Jo Park" }] };
	const got = Signals.followedIn(rec, watched);
	assert.deepEqual(got.map(g => g.id), ["A1", "A2"], "an id that points elsewhere (Jo Park, A99) is not rescued by the name");
	assert.deepEqual(Signals.followedIn({ authors: [{ name: "jo  PARK" }] }, watched).map(g => g.id), ["A3"]);
	assert.deepEqual(Signals.followedIn(rec, []), []);
});

test("reading state: Style Custom's done/reading wins over tags; its plain unread defers to the tag; tags alone otherwise", () => {
	const item = {};
	assert.equal(Signals.readingState(runtime({ state: () => ({ status: "done" }) }), item, "reading"), "done");
	assert.equal(Signals.readingState(runtime({ state: () => ({ status: "reading" }) }), item, null), "reading", "read for a while, never tagged");
	assert.equal(Signals.readingState(runtime(), item, "unread"), "unread");
	assert.equal(Signals.readingState(runtime(), item, null), null, "an untouched paper shows nothing, as before");
	assert.equal(Signals.readingState(null, item, "done"), "done");
	assert.equal(Signals.readingState(runtime({ state: () => { throw new Error("x"); } }), item, "reading"), "reading");
});

test("importer getReadingStates uses Style Custom when present and the tags otherwise", async () => {
	const items = [{ id: 1 }, { id: 2 }];
	const Z = { DB: { queryAsync: async () => [{ itemID: 2, name: "/unread" }] }, Items: { getAsync: async () => items },
		StyleCustom: runtime({ state: item => ({ status: item.id === 1 ? "reading" : "unread" }) }) };
	assert.deepEqual(JSON.parse(JSON.stringify([...(await loadImporter(Z).getReadingStates([1, 2]))])), [[2, "unread"], [1, "reading"]]);
	delete Z.StyleCustom;
	assert.deepEqual(JSON.parse(JSON.stringify([...(await loadImporter(Z).getReadingStates([1, 2]))])), [[2, "unread"]]);
});

test("the other version: held in the library by DOI shows 보유 (verOwned), not 'not in these results'", async () => {
	const pre = paper("pre", { title: "Preprint", year: 2026, venue: "bioRxiv", doi: "10.1234/pre", publishedAs: { key: "gone", title: "The article", doi: "10.1234/pub", venue: "Cell", year: 2025, basis: "title" } });
	const ui = uiHarness({ realRows: true, search: async () => [pre], importer: { findByTitle: async () => null, getLibraryDOIMap: async () => new Map(), forgetTitleIndex() {} } });
	await ui.runSearch(); ui.wireEvents();
	const rec = ui.state.records[0];
	ui.renderVersions(rec);
	assert.match(ui.get("d-versions").textContent, /verGone/);
	ui.state.doiMap.set("10.1234/pub", 5);
	ui.renderVersions(rec);
	assert.match(ui.get("d-versions").textContent, /verOwned/);
	assert.doesNotMatch(ui.get("d-versions").textContent, /verGone/);
});

test("the other version: held by title (no DOI match) is found once, asked once, and the detail redraws", async () => {
	let asked = 0;
	const pre = paper("pre", { title: "Preprint", year: 2026, venue: "bioRxiv", doi: "10.1234/pre", publishedAs: { key: "gone", title: "The article", doi: "10.1234/other", venue: "Cell", year: 2025, basis: "title" } });
	const ui = uiHarness({ realRows: true, search: async () => [pre], importer: { findByTitle: async () => { asked++; return 9; }, getLibraryDOIMap: async () => new Map(), forgetTitleIndex() {} } });
	await ui.runSearch(); ui.wireEvents();
	const rec = ui.state.records[0];
	ui.state.detailKey = rec.key; asked = 0;
	ui.renderVersions(rec);
	assert.match(ui.get("d-versions").textContent, /verGone/, "until the library answers");
	await new Promise(r => setTimeout(r, 5));
	assert.match(ui.get("d-versions").textContent, /verOwned/);
	ui.renderVersions(rec); ui.renderVersions(rec);
	assert.equal(asked, 1);
});

const detailHarness = (zotero, extra = {}) => uiHarness({ realRows: true, zotero, ...extra });

test("detail signals: counts, click-to-list, followed chip, and follow buttons; hidden entirely without Style Custom", async () => {
	const rec = paper("openalex:W77", { source: "openalex", sourceId: "W77", title: "Cited paper", people: [{ name: "Mina Kim", openalexId: "A1", position: "first", corresponding: true }, { name: "Ola Berg", openalexId: "A2", position: "last" }] });
	const watched = [{ id: "A2", name: "Ola Berg" }];
	const titles = { LIB00001: "My first paper", LIB00002: "My second paper" };
	const selected = [];
	const Z = {
		StyleCustom: runtime({ watchedAuthors: () => watched, watchAuthor: async p => { watched.push({ id: p.id, name: p.name }); return p; } }),
		Items: { getByLibraryAndKey: (lib, key) => titles[key] ? { id: 40 + Object.keys(titles).indexOf(key), deleted: false, getField: () => titles[key] } : null }
	};
	const ui = detailHarness(Z, { search: async () => [rec], mainWindow: { ZoteroPane: { selectItem: id => selected.push(id) } },
		sources: { fetchReferencedWorks: async () => ({ ok: true, id: "W77", ids: ["W20", "W30"] }) } });
	await ui.runSearch(); ui.wireEvents();
	const r = ui.state.records[0];
	ui.state.detailKey = r.key;
	ui.renderSignals(r);
	await new Promise(res => setTimeout(res, 5));
	const box = ui.get("d-signals");
	assert.equal(box.hidden, false);
	const text = () => box.textContent;
	assert.match(text(), /sigCitedByMine\|2/, "two of my papers cite it (local)");
	assert.match(text(), /sigFollowed\|Ola Berg/);
	// W20 is LIB00002 (in my library); W30 is LIB00003, which Zotero no longer has, so it is not counted
	assert.match(text(), /sigCitesMine\|1/);
	const [countBtn] = box.querySelectorAll("button");
	countBtn.emit("click");
	assert.deepEqual(box.querySelectorAll(".sig-title").map(n => n.textContent), ["My first paper", "My second paper"]);
	box.querySelectorAll(".sig-item")[1].querySelector("button").emit("click");
	assert.deepEqual(selected, [41]);
	// following Mina: payload and pressed state
	const watchBtns = () => box.querySelectorAll("button.watch-btn");
	assert.deepEqual(watchBtns().map(b => b.getAttribute("aria-pressed")), ["false", "true"]);
	assert.equal(watchBtns()[0].textContent, "watchAuthor");
	await ui.followAuthor(r.people[0]);
	assert.deepEqual(watched.at(-1), { id: "A1", name: "Mina Kim" });
	ui.renderSignals(r);
	assert.deepEqual(watchBtns().map(b => b.getAttribute("aria-pressed")), ["true", "true"]);
	// without Style Custom nothing is drawn
	delete ui.Z.StyleCustom;
	ui.renderSignals(r);
	assert.equal(box.hidden, true);
	assert.equal(box.firstChild, null);
	assert.equal(await ui.followAuthor(r.people[0]), false);
});

test("watch payload: the OpenAlex author id, name, lab, and only the works already listed as seen", () => {
	const recs = [{ source: "openalex", sourceId: "W1", people: [{ openalexId: "A5" }] }, { source: "openalex", sourceId: "W2", authors: [{ openalexId: "A5" }] }, { source: "openalex", sourceId: "W3", people: [{ openalexId: "A6" }] }, { source: "crossref", sourceId: "x", people: [{ openalexId: "A5" }] }];
	const seen = Signals.seenWorksOf(recs, "A5");
	assert.deepEqual(seen, ["W1", "W2"]);
	assert.deepEqual(Signals.watchPayload({ openalexId: "https://openalex.org/a5", name: "Ana", affiliation: "MIT" }, [...seen, "W1", "junk"]),
		{ id: "A5", name: "Ana", institution: "MIT", seen: ["W1", "W2"] });
	assert.equal(Signals.watchPayload({ id: "0000-0001-2345-6789", name: "No OpenAlex id" }, []), null, "an ORCID or Scholar id is not an author id Style Custom can watch");
});

test("the ORCID profile card offers 관심 저자로 추가 only with Style Custom and an OpenAlex id, pressed when followed", async () => {
	const watched = [];
	const Z = { StyleCustom: runtime({ watchedAuthors: () => watched, watchAuthor: async p => { watched.push(p); } }) };
	const profile = { provider: "orcid", id: "0000-0001-2345-6789", name: "Ana Reyes", affiliation: "MIT", openalexId: "A5", identityConfirmed: true };
	const mk = async zotero => {
		const ui = detailHarness(zotero);
		ui.wireEvents();
		ui.switchAuthorProvider?.("orcid");
		const session = ui.authorSessions.orcid; session.profiles = [profile];
		return ui;
	};
	let ui = await mk(Z);
	ui.switchAuthorProvider("orcid");
	ui.authorSessions.orcid.profiles = [profile];
	ui.renderAuthorProfiles();
	const btns = () => ui.get("author-profiles").querySelectorAll("button.watch-btn");
	assert.equal(btns().length, 1);
	assert.equal(btns()[0].getAttribute("aria-pressed"), "false");
	btns()[0].emit("click");
	await new Promise(r => setTimeout(r, 5));
	assert.deepEqual(watched[0], { id: "A5", name: "Ana Reyes", institution: "MIT", seen: [] });
	assert.equal(btns()[0].getAttribute("aria-pressed"), "true");
	ui = await mk({});
	ui.switchAuthorProvider("orcid"); ui.authorSessions.orcid.profiles = [profile]; ui.renderAuthorProfiles();
	assert.equal(ui.get("author-profiles").querySelectorAll("button.watch-btn").length, 0, "hidden without Style Custom");
});

test("translated abstract note: a child note headed with the language, only when there is text", async () => {
	const saved = [];
	class Item { constructor(type) { this.type = type; } setNote(html) { this.html = html; } async saveTx() { saved.push(this); } }
	{
		const Importer = loadImporter({ Item });
		const parent = { id: 7, libraryID: 3 };
		const note = await Importer.addTranslatedNote(parent, { heading: "번역된 초록 (한국어)", text: "첫 문단 <b>\n\n둘째 & 문단", service: "DeepL" });
		assert.equal(note.type, "note"); assert.equal(note.parentID, 7); assert.equal(note.libraryID, 3);
		assert.match(note.html, /^<h2>번역된 초록 \(한국어\)<\/h2><p>첫 문단 &lt;b&gt;<\/p><p>둘째 &amp; 문단<\/p><p><em>DeepL<\/em><\/p>$/);
		assert.equal(await Importer.addTranslatedNote(parent, { heading: "h", text: "  " }), null);
		assert.equal(saved.length, 1);
	}
});

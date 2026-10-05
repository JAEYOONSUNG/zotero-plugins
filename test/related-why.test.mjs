/* "Rank by my library", round 8: what counts as related (bands), how the score combines with the
   search's own order, the detail's "why this paper" list (each held paper a click from Zotero), a held
   result naming its library copy, and the cost of pressing the button again or after more rows arrive. */
import { test } from "node:test";
import assert from "node:assert/strict";
import Related from "../content/related.js";
import Sources from "../content/sources.js";
import I18N from "../content/i18n.js";
import { uiHarness, paper } from "./helpers/search-ui-harness.mjs";

const W = n => "https://openalex.org/W" + n;
function mockOpenAlex(table) {
	const urls = [];
	const byDoi = new Map(Object.entries(table).map(([n, w]) => [w.doi, n]));
	const getJSON = async url => {
		urls.push(url);
		const filter = decodeURIComponent((url.match(/[?&]filter=([^&]+)/) || [])[1] || "");
		const name = filter.split(":")[0], wanted = filter.slice(filter.indexOf(":") + 1).split("|");
		const out = [];
		for (const v of wanted) {
			const n = name === "doi" ? byDoi.get(v) : v.replace(/^W/, "");
			const w = n && table[n];
			if (w) out.push({ id: W(n), doi: w.doi ? "https://doi.org/" + w.doi : null, referenced_works: w.refs.map(W) });
		}
		return { results: out };
	};
	return { http: { getJSON }, urls };
}

/* Held 1-4. Ref 100 is cited by all four (weight ~0), 101 by held 1 only (weight 1). */
const heldRows = () => [1, 2, 3, 4].map(i => ({ itemID: i, title: "Held " + i, doi: "10.1000/h" + i }));
const table = () => ({
	1: { doi: "10.1000/h1", refs: [100, 101, 105] },
	2: { doi: "10.1000/h2", refs: [100, 102, 105] },
	3: { doi: "10.1000/h3", refs: [100, 103, 105] },
	4: { doi: "10.1000/h4", refs: [100, 104] },
	10: { doi: "10.1000/a", refs: [1, 2, 101] },     // strong: cites held 1 and 2
	11: { doi: "10.1000/b", refs: [101, 500] },      // some: one rare shared reference
	12: { doi: "10.1000/c", refs: [105] },           // weak: only a reference three of four held cite
	13: { doi: "10.1000/d", refs: [600] },           // none
	14: { doi: "10.1000/e", refs: [105, 601] }       // weak
});
// The search's own order: weak C first, then none D, then weak E, some B, strong A.
const resultRows = () => [
	{ key: "C", title: "Result C", source: "openalex", sourceId: "W12" },
	{ key: "D", title: "Result D", source: "openalex", sourceId: "W13" },
	{ key: "E", title: "Result E", source: "openalex", sourceId: "W14" },
	{ key: "B", title: "Result B", source: "openalex", sourceId: "W11" },
	{ key: "A", title: "Result A", source: "openalex", sourceId: "W10" },
	{ key: "H", title: "Held 1", source: "openalex", sourceId: "W1", doi: "10.1000/h1" }
];
const run = args => Related.rank({ sources: Sources, ctx: {}, ...args });

test("bands: a direct link is strong, one rare shared reference is some, only common ones is weak", async () => {
	const { http } = mockOpenAlex(table());
	const { scores } = await run({ held: heldRows(), results: resultRows(), http });
	assert.equal(scores.get("A").band, "strong");
	assert.equal(scores.get("B").band, "some");
	assert.equal(scores.get("C").band, "weak");
	assert.ok(scores.get("C").score > 0 && scores.get("C").score < 1);
	assert.equal(scores.get("D").band, "none");
	assert.equal(Related.bandOf({ score: 3.2, c1: 0, c2: 0, c3w: 3.2 }), "strong", "c3w >= 3 without a direct link");
	assert.equal(Related.bandOf({ score: 0.99, c1: 0, c2: 0, c3w: 0.99 }), "weak");
});

test("order: strong and some by score, weak and none keep the search's own order, held after them", async () => {
	const { http } = mockOpenAlex(table());
	const out = await run({ held: heldRows(), results: resultRows(), http });
	assert.deepEqual(out.order, ["A", "B", "C", "D", "E", "H"], "weak C stays above none D and weak E, as the search had them");
});

test("held results name the library copy they matched", async () => {
	const { http } = mockOpenAlex(table());
	const { scores } = await run({ held: heldRows(), results: resultRows(), http });
	assert.equal(scores.get("H").held, true);
	assert.equal(scores.get("H").heldItemID, 1);
	assert.equal(scores.get("H").heldTitle, "Held 1");
});

test("linked() lists every held paper behind a score, top keeps the first five", () => {
	const held = [], results = [];
	for (let i = 1; i <= 12; i++) held.push({ itemID: i, title: "Held " + i, openalex: "W" + i, refs: ["W" + (1000 + i)] });
	results.push({ key: "r", id: "W9999", refs: held.map(h => "W" + h.itemID) });
	const s = Related.scoreAll(held, results).get("r");
	assert.equal(s.linked().length, 12);
	assert.equal(s.top.length, 5);
	assert.deepEqual(s.top.map(x => x.itemID), s.linked().slice(0, 5).map(x => x.itemID));
	assert.ok(!Object.keys(s).includes("linked"), "not copied into saved or compared data");
});

/* ---------------------------------------------------------------- the window */
const settle = async ui => { for (let i = 0; i < 200 && ui.state.related?.running; i++) await new Promise(r => setTimeout(r, 5)); await new Promise(r => setTimeout(r, 5)); };
function windowWith({ selected = [], importer } = {}) {
	const requests = [], gets = { n: 0 };
	const items = new Map(heldRows().map(h => [h.itemID, h.title]));
	const ui = uiHarness({
		realRows: true,
		search: async () => resultRows().map((r, i) => paper(r.key, { ...r, rank: i + 1, citations: 100 - i })),
		sources: { withRetry: Sources.withRetry, isQuotaError: Sources.isQuotaError, openAlexAuth: Sources.openAlexAuth },
		mainWindow: { ZoteroPane: { selectItem: id => selected.push(id) } }, importer,
		zotero: { Items: { get: id => { gets.n++; return items.has(id) ? { id, getField: f => f === "title" ? items.get(id) : "" } : null; } } },
		request: async (_m, url) => { requests.push(url); return { response: await mockOpenAlex(table()).http.getJSON(url), status: 200 }; }
	});
	return { ui, requests, gets, selected };
}
async function loaded(opts) {
	const w = windowWith(opts);
	await w.ui.runSearch(); w.ui.wireEvents();
	w.ui.state.doiMap = new Map(heldRows().map(h => [h.doi, h.itemID]));
	return w;
}

test("the table: weak rows keep the search's order, the chip says weak and strong apart", async () => {
	const { ui } = await loaded();
	ui.get("related-btn").emit("click"); await settle(ui);
	assert.equal(ui.state.sortKey, "related");
	assert.deepEqual(ui.state.visible.map(r => r.key).slice(0, 5), ["A", "B", "C", "D", "E"]);
	const chipOf = key => ui.get("results-body").querySelectorAll("tr").find(tr => tr.dataset.key === key).querySelector(".rel-chip");
	assert.ok(chipOf("A").classList.contains("strong"));
	assert.ok(chipOf("C").classList.contains("muted"));
	assert.match(chipOf("C").textContent, /relWeakChip/);
	assert.match(ui.tipContent(chipOf("A"), "related"), /relBand\|strong/);
});

test("why this paper: every linked held paper, each a button that selects it in Zotero and opens nothing", async () => {
	const w = await loaded();
	w.ui.get("related-btn").emit("click"); await settle(w.ui);
	const a = w.ui.state.records.find(r => r.key === "A");
	w.ui.renderWhy(a);
	const box = w.ui.get("d-why");
	assert.equal(box.hidden, false);
	assert.match(box.querySelector(".why-head").textContent, /relWhyHead\|strong\|2/, "held 1 and 2 directly; held 1 also by its rare reference, still one paper");
	const buttons = box.querySelectorAll("button");
	assert.deepEqual(buttons.map(b => b.textContent), ["Held 1", "Held 2"].concat(buttons.length > 2 ? buttons.slice(2).map(b => b.textContent) : []));
	assert.ok(buttons.every(b => b.getAttribute("data-opens") === "library"), "marked for the self-check sweep");
	buttons[1].emit("click");
	assert.deepEqual(w.selected, [2]);
	// a result with no link: nothing to explain
	w.ui.renderWhy(w.ui.state.records.find(r => r.key === "D"));
	assert.equal(w.ui.get("d-why").hidden, true);
});

test("why this paper: a held result names its library copy and selects it", async () => {
	const w = await loaded();
	w.ui.get("related-btn").emit("click"); await settle(w.ui);
	const h = w.ui.state.records.find(r => r.key === "H");
	w.ui.renderWhy(h);
	const box = w.ui.get("d-why");
	assert.match(box.textContent, /relWhyHeld/);
	box.querySelector("button").emit("click");
	assert.deepEqual(w.selected, [1]);
});

test("why this paper: more than eight linked papers are counted, not listed", async () => {
	const { ui } = await loaded();
	const held = [];
	for (let i = 1; i <= 11; i++) held.push({ itemID: i, title: "Held " + i, openalex: "W" + i, refs: ["W" + (1000 + i)] });
	const rec = ui.state.records[0];
	rec.related = Related.scoreAll(held, [{ key: "r", id: "W9999", refs: held.map(h => "W" + h.itemID) }]).get("r");
	ui.renderWhy(rec);
	assert.equal(ui.get("d-why").querySelectorAll("button").length, 8);
	assert.match(ui.get("d-why").querySelector(".why-more").textContent, /relWhyMore\|3/);
});

test("pressing the button again on the same list and library sorts at once: no library pass, no request", async () => {
	const w = await loaded();
	w.ui.get("related-btn").emit("click"); await settle(w.ui);
	const reqs = w.requests.length, gets = w.gets.n;
	w.ui.get("related-btn").emit("click"); await settle(w.ui);   // back
	assert.equal(w.ui.state.sortKey, "rank");
	w.ui.get("related-btn").emit("click"); await settle(w.ui);   // again
	assert.equal(w.ui.state.sortKey, "related");
	assert.equal(w.requests.length, reqs);
	assert.equal(w.gets.n, gets, "the 1,200 held papers are not read again");
	// a paper added to the library since: the basis changed, so it is worked out again
	w.ui.get("related-btn").emit("click"); await settle(w.ui);   // back
	w.ui.state.doiMap.set("10.1000/new", 99);
	w.ui.get("related-btn").emit("click"); await settle(w.ui);
	assert.ok(w.gets.n > gets);
});

test("rows that arrive after the ranking keep the ranked rows' scores and offer to rank the new ones", async () => {
	const w = await loaded();
	w.ui.get("related-btn").emit("click"); await settle(w.ui);
	const before = w.ui.state.records.map(r => [r.key, r.related?.score ?? null]);
	// a later batch redraws the list with one more row
	w.ui.displaySearchResults([...resultRows().map((r, i) => paper(r.key, { ...r, rank: i + 1 })), paper("N", { title: "New one", source: "openalex", sourceId: "W11" })]);
	assert.deepEqual(w.ui.state.records.filter(r => r.key !== "N").map(r => [r.key, r.related?.score ?? null]), before, "scores carried through the redraw");
	assert.match(w.ui.get("related-label").textContent, /relRankNew\|1/);
	w.ui.get("related-btn").emit("click"); await settle(w.ui);
	assert.equal(w.ui.state.sortKey, "related", "still ranked, not sent back");
	assert.equal(w.ui.state.records.find(r => r.key === "N").related.band, "some");
	assert.match(w.ui.get("related-label").textContent, /relBack/);
	w.ui.get("related-btn").emit("click"); await settle(w.ui);
	assert.equal(w.ui.state.sortKey, "rank", "and back goes to the order before the first ranking");
});

test("the round's strings exist in English and Korean", () => {
	for (const k of ["relWeakChip", "relBand", "relTipOpen", "relWhyLabel", "relWhyHead", "relWhyHeld", "relWhyOpen", "relWhyMore", "relUntitled", "relRankNew"])
		for (const lang of ["en", "ko"]) assert.ok(k in I18N.STRINGS[lang], `${lang}: ${k}`);
	assert.match(I18N.STRINGS.ko.relWhyHead("strong", 3), /강한 연결/);
});

test("a ranked paper added here is held at once; the button offers a re-rank since the library changed", async () => {
	const doiMap = () => new Map(heldRows().map(h => [h.doi, h.itemID]));
	const importer = { getReadingStates: async () => new Map(), getLibraryDOIMap: async () => doiMap(), forgetTitleIndex() {}, findByTitle: async () => null,
		importRecord: async () => ({ status: "added", item: { id: 77 }, pdf: "no pdf", how: "translator" }) };
	const w = await loaded({ importer });
	w.ui.get("related-btn").emit("click"); await settle(w.ui);
	const b = w.ui.state.records.find(r => r.key === "B");
	b.doi = "10.1000/b";
	await w.ui.importRecords([b]);
	assert.equal(b.related.held, true);
	assert.equal(b.related.heldItemID, 77);
	w.ui.render();
	assert.match(w.ui.get("related-label").textContent, /relRerank/);
	const n = w.requests.length;
	w.ui.get("related-btn").emit("click"); await settle(w.ui);
	assert.equal(w.ui.state.sortKey, "related", "re-ranked, not sent back");
	assert.match(w.ui.get("related-label").textContent, /relBack/);
	assert.ok(w.requests.length - n <= 1, "the new held paper's references come from the cache or one request");
});

test("the status says how much of the library could be compared", async () => {
	const w = await loaded();
	w.ui.state.doiMap.set("10.1000/unknown-to-openalex", 50);
	w.ui.get("related-btn").emit("click"); await settle(w.ui);
	assert.match(w.ui.get("status").textContent, /relCoverage\|4\|5/);
	const d = w.ui.state.records.find(r => r.key === "D");
	assert.match(w.ui.tipContent(Object.assign(w.ui.get("results-body").querySelectorAll("tr").find(tr => tr.dataset.key === "D").querySelector(".rel-chip")), "related"), /relCoverage\|4\|5/);
	assert.equal(d.related.band, "none");
});

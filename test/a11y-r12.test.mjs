/* Round 12: keyboard and screen-reader use of the search window, and saved yearly citation series that
   say which years they never saw instead of showing them as zero. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Cite from "../content/cite.js";
import Sources from "../content/sources.js";
import History from "../content/history.js";
import I18N from "../content/i18n.js";

const at = (y, m = 9, d = 2) => new Date(y, m, d);
const years = list => list.map(([year, n]) => ({ year, n }));
const read = name => fs.readFileSync(new URL("../content/" + name, import.meta.url), "utf8");

test("a series read in December 2024 and reopened in October 2026: 2025 and 2026 are unknown, not zero, and no -100%", () => {
	const seen = Cite.seriesSeen(new Date(2024, 11, 10).getTime());
	assert.deepEqual({ from: seen.from, to: seen.to }, { from: 2015, to: 2024 });
	const tr = Cite.trend({ byYear: years([[2023, 80], [2024, 100]]), year: 2023, citations: 180, seen }, at(2026));
	const y = Object.fromEntries(tr.years.map(e => [e.year, e]));
	assert.equal(y[2025].n, null); assert.equal(y[2025].unknown, true);
	assert.equal(y[2026].n, null); assert.equal(y[2026].unknown, true);
	assert.equal(y[2024].n, 100);
	assert.equal(tr.current.n, null, "this year's count is unknown");
	// the change compares the two full years before the series was read
	assert.deepEqual(tr.last, { year: 2023, n: 80 });
	assert.equal(tr.prev, null, "published 2023: no year before to compare");
	assert.equal(tr.yoy, null); assert.equal(tr.direction, null);
	const older = Cite.trend({ byYear: years([[2022, 40], [2023, 80], [2024, 100]]), year: 2020, citations: 220, seen }, at(2026));
	assert.equal(older.yoy, 100, "2023 against 2022, both read"); assert.equal(older.direction, "up");
	assert.equal(tr.seen.to, 2024);
	// a live series (no stamp) is read today: nothing changes
	const live = Cite.trend({ byYear: years([[2025, 9], [2026, 4]]), year: 2024, citations: 13 }, at(2026));
	assert.equal(live.seen, null);
	assert.equal(live.years.find(e => e.year === 2024).n, 0, "a covered year OpenAlex leaves out is still zero");
});

test("the result-set sum: a year no saved series covers is unknown, one only some cover is marked short and kept out of the change", () => {
	const old = Cite.seriesSeen(new Date(2024, 5, 1).getTime());
	const s = Cite.sumByYear([{ citesByYear: years([[2023, 10], [2024, 20]]), citesByYearSeen: old }, { citesByYear: years([[2024, 5], [2025, 6]]) }], at(2026));
	const y = Object.fromEntries(s.years.map(e => [e.year, e]));
	assert.equal(y[2024].n, 25);
	assert.equal(y[2025].n, 6); assert.equal(y[2025].short, true);
	assert.equal(s.yoy, null, "no change from a year only one paper reaches");
	const both = Cite.sumByYear([{ citesByYear: years([[2023, 10]]), citesByYearSeen: old }], at(2026));
	assert.equal(both.years.find(e => e.year === 2026).n, null);
	assert.equal(both.years.find(e => e.year === 2026).unknown, true);
});

test("every yearly series is stored with when it was read; a saved search without it is stamped with its save time", async () => {
	const http = { async getJSON(url) {
		if (/\/works\?filter=doi:/.test(url)) return { results: [{ doi: "https://doi.org/10.5555/x", cited_by_count: 7, counts_by_year: [{ year: 2025, cited_by_count: 5 }] }] };
		if (/\/works\/doi:/.test(url) || /\/works\//.test(url)) return { cited_by_count: 7, counts_by_year: [{ year: 2025, cited_by_count: 5 }] };
		throw new Error("unexpected " + url);
	} };
	const records = [Sources.makeRecord({ source: "crossref", doi: "10.5555/x", title: "T", year: 2024 })];
	await Sources.enrichFromOpenAlex(records, http, {});
	assert.ok(records[0].citesByYearSeen && Number.isInteger(records[0].citesByYearSeen.to), "enrichment stamps the series");
	Sources.clearWorkCache();
	const got = await Sources.refreshOpenAlexWork({ doi: "10.5555/x" }, http, {}, new Date(2026, 1, 1).getTime());
	assert.equal(got.citesByYearSeen.to, 2026);
	assert.deepEqual(Sources.seriesSeen(Date.UTC(2024, 6, 1)), Cite.seriesSeen(Date.UTC(2024, 6, 1)));
	// the merge carries the time with the series
	const merged = Sources.mergeRecords([[Sources.makeRecord({ source: "crossref", doi: "10.5555/y", title: "Merge me", year: 2024 })],
		[Sources.makeRecord({ source: "openalex", sourceId: "W1", doi: "10.5555/y", title: "Merge me", year: 2024, citesByYear: years([[2024, 9]]), citesByYearSeen: Cite.seriesSeen(Date.UTC(2024, 6, 1)) })]]);
	assert.equal(merged[0].citesByYearSeen.to, 2024);
	// an entry written before the time was kept: reopened, its series reads as of its save date
	const files = new Map();
	const h = History.create({ io: History.memoryIO(files), dir: "/h", join: (...p) => p.join("/"), now: () => new Date(2024, 11, 10) });
	const id = await h.save({ source: "openalex", query: { keywords: "x" }, records: [{ key: "a", title: "A", citesByYear: years([[2024, 3]]) }] });
	const raw = JSON.parse(files.get("/h/" + id + ".json"));
	for (const r of raw.records) delete r.citesByYearSeen;
	files.set("/h/" + id + ".json", JSON.stringify(raw));
	const entry = await h.get(id);
	assert.equal(entry.records[0].citesByYearSeen.to, 2024);
	const tr = Cite.figures({ ...entry.records[0], year: 2024, citations: 3, citationSource: "openalex" }, at(2026)).trend;
	assert.equal(tr.years.find(e => e.year === 2026).n, null);
});

test("unknown years draw as '?' with words for screen readers, in both languages", () => {
	const ui = read("ui.js");
	assert.match(ui, /citeYearUnknown/);
	assert.match(read("search.css"), /\.tr-col\.unknown \.tr-bar/);
	for (const lang of ["en", "ko"]) for (const key of ["citeYearUnknown", "citeSeriesAsOf", "metricsTrendGaps", "citeYearShort"]) assert.ok(I18N.STRINGS[lang][key] !== undefined, lang + " " + key);
	assert.match(I18N.make("en")("citeYearUnknown", 2025), /2025.*unknown/);
});

// ---------------------------------------------------------------- keyboard and screen reader
import { uiHarness, paper, mockElement } from "./helpers/search-ui-harness.mjs";
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const css = read("search.css"), markup = read("search.xhtml"), uiSource = read("ui.js");
const rows = () => [paper("a", { title: "Alpha", year: 2020 }), paper("b", { title: "Beta", year: 2021 }), paper("c", { title: "Gamma", year: 2022 })];
async function loaded(options = {}) {
	const ui = uiHarness({ realRows: true, search: async () => rows(), ...options });
	await ui.runSearch(); ui.wireEvents(); ui.render();
	return ui;
}
const key = (ui, k, extra = {}) => ui.onKeyDown({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault() {}, stopPropagation() {}, ...extra });

test("the history menu from the keyboard: the first search takes focus, arrows skip headings, Escape gives focus back", async () => {
	const files = new Map();
	const ui = await loaded({ historyFiles: files, search: async () => [paper("hit", { title: "Menu paper" })] });
	ui.get("keywords").value = "first"; await ui.runSearch();
	ui.get("keywords").value = "second"; await ui.runSearch();
	const btn = ui.get("history-btn"), menu = ui.get("histmenu");
	btn.emit("click", { detail: 0 }); await tick(20);
	assert.equal(menu.hidden, false);
	const items = menu.querySelectorAll('[role="menuitem"]');
	assert.ok(items.length >= 3, "two searches and 'forget all'");
	assert.equal(mockElement.active, items[0], "opened from the keyboard, the first search is focused");
	items[0].emit("keydown", { key: "ArrowDown" });
	assert.equal(mockElement.active, items[1]);
	items[1].emit("keydown", { key: "End" });
	assert.equal(mockElement.active, items.at(-1), "'forget all' is reachable");
	assert.equal(items.at(-1).tabIndex, 0);
	items.at(-1).emit("keydown", { key: "ArrowDown" });
	assert.equal(mockElement.active, items[0], "the list wraps");
	items[0].emit("keydown", { key: "Escape" });
	assert.equal(menu.hidden, true);
	assert.equal(mockElement.active, btn, "Escape returns focus to History");
	// the document-level Escape does the same when focus is elsewhere
	btn.emit("click", { detail: 0 }); await tick(20);
	key(ui, "Escape");
	assert.equal(menu.hidden, true); assert.equal(mockElement.active, btn);
});

test("a row's menu opens from the keyboard (Shift+F10 / context-menu key), is a menu, moves with arrows and closes back to the list", async () => {
	const ui = await loaded();
	ui.state.focusKey = "b"; ui.render();
	mockElement.active = ui.get("table-wrap");
	key(ui, "F10", { shiftKey: true });
	const menu = ui.get("ctxmenu");
	assert.equal(menu.hidden, false);
	assert.equal(menu.getAttribute("role"), "menu");
	const items = menu.querySelectorAll('[role="menuitem"]');
	assert.ok(items.length > 4);
	assert.equal(mockElement.active, items[0], "the first item takes focus");
	menu.emit("keydown", { key: "ArrowDown", target: items[0] });
	assert.equal(mockElement.active, items[1]);
	menu.emit("keydown", { key: "Escape" });
	assert.equal(menu.hidden, true);
	assert.equal(mockElement.active, ui.get("table-wrap"), "focus is back in the list");
	key(ui, "ContextMenu");
	assert.equal(menu.hidden, false, "the context-menu key opens it too");
	menu.emit("keydown", { key: "Tab" });
	assert.equal(menu.hidden, true);
});

test("the results are a multi-select grid: rows carry ids and aria-selected, the list names the row the arrows reached", async () => {
	const ui = await loaded();
	assert.match(markup, /id="results-table" role="grid" aria-multiselectable="true"/);
	assert.match(markup, /id="table-wrap" tabindex="0" role="group" data-i18n-aria="resultsLabel"/);
	mockElement.active = ui.get("table-wrap");
	key(ui, "ArrowDown");
	const wrap = ui.get("table-wrap"), body = ui.get("results-body");
	const first = body.children[0];
	assert.ok(first.id && first.id.startsWith("row-"));
	assert.equal(wrap.getAttribute("aria-activedescendant"), first.id);
	assert.equal(first.getAttribute("aria-selected"), "false");
	key(ui, " ");
	assert.equal(first.getAttribute("aria-selected"), "true", "Space selects, and the row says so");
	key(ui, "ArrowDown");
	assert.equal(wrap.getAttribute("aria-activedescendant"), body.children[1].id);
	// ids stay distinct for keys that differ only in punctuation
	const idOf = k => { ui.state.records.push(paper(k)); return k; };
	idOf("x:1"); idOf("x_1"); ui.render();
	const ids = body.children.map(tr => tr.id);
	assert.equal(new Set(ids).size, ids.length);
	assert.ok(body.children[0].querySelector("input").getAttribute("aria-label"), "the row's checkbox has a name");
});

test("S in the list (or View → Sort by…) sorts by any column shown, from the keyboard; the header says the sort", async () => {
	const ui = uiHarness({ realRows: true, columns: true, search: async () => rows() });
	await ui.runSearch(); ui.wireEvents();
	mockElement.active = ui.get("table-wrap");
	key(ui, "s");
	const menu = ui.get("tbmenu");
	assert.equal(menu.hidden, false);
	const items = menu.children.filter(c => c.tagName === "DIV" && c.getAttribute("role") === "menuitemradio");
	assert.ok(items.length >= 10, "one item per column");
	const yearItem = items.find(i => /^(thYear|year)\b/.test(i.textContent));
	assert.ok(yearItem);
	let i = items.indexOf(yearItem);
	items[0].focus();
	for (let n = 0; n < i; n++) menu.emit("keydown", { key: "ArrowDown" });
	menu.emit("keydown", { key: "Enter" });
	assert.equal(ui.state.sortKey, "year"); assert.equal(ui.state.sortDir, "desc");
	assert.deepEqual(ui.state.visible.map(r => r.key), ["c", "b", "a"]);
	assert.equal(mockElement.active, ui.get("table-wrap"), "focus goes back to the list");
	assert.equal(ui.get("table-wrap").getAttribute("aria-expanded"), null, "the list is not marked as a menu button");
	const th = ui.get("results-head").children.find(c => c.dataset.sort === "year");
	assert.equal(th.getAttribute("aria-sort"), "descending");
	// the View menu offers it too
	const labels = ui.viewMenuItems().filter(x => x && x.label).map(x => x.label);
	assert.ok(labels.includes("sortMenu") && labels.includes("keysMenu"));
});

test("? opens the list of every shortcut; Escape closes it and gives focus back", async () => {
	const ui = await loaded();
	const opener = ui.get("table-wrap"); mockElement.active = opener;
	key(ui, "?");
	// focus is on the close button: button → head → card → overlay
	const overlay = mockElement.active?.parentNode?.parentNode?.parentNode;
	assert.ok(overlay && overlay.getAttribute("role") === "dialog", "a dialog, with focus on its close button");
	assert.equal(overlay.getAttribute("aria-modal"), "true");
	const listed = overlay.querySelectorAll("dd").map(d => d.textContent);
	for (const k of ["keyRunSearch", "keyFilter", "keyMove", "keyTick", "keyOpen", "keyPreview", "keySort", "keyRowMenu", "keyCopyCite", "keyCopyDoi", "keyEscape", "keyHelp"]) assert.ok(listed.includes(k), k);
	assert.ok(mockElement.active.getAttribute("aria-label"), "the close button has a name");
	key(ui, "Escape");
	assert.equal(overlay.parentNode, null, "removed");
	assert.equal(mockElement.active, opener);
	// every key onKeyDown answers to is in the list
	for (const k of ['"p"', '"s"', '"?"', '"F10"', '"ContextMenu"', '"Home"', '"Delete"']) assert.ok(uiSource.includes(k), k);
	for (const k of ["\"P\"", "\"S\"", "\"?\"", "Shift+F10", "Delete", "Home End"]) assert.ok(uiSource.slice(uiSource.indexOf("const SHORTCUTS"), uiSource.indexOf("const isMacKeys")).includes(k.replace(/"/g, "")), "listed: " + k);
});

test("a failure is announced at once: the alert region gets the status error and a warning banner", async () => {
	const ui = await loaded();
	assert.match(markup, /id="sr-alert" class="sr-only" role="alert"/);
	void ui;
	const failing = uiHarness({ realRows: true, search: async () => { throw new Error("network down"); } });
	await failing.runSearch(); await tick(60);
	assert.match(failing.get("sr-alert").textContent, /\S/, "the failure reached the alert region");
});

test("icon-only buttons are named in the window's language; no English literals in aria-label", () => {
	assert.doesNotMatch(markup, /aria-label="(clear|\?)"/);
	for (const id of ["filter-clear", "facet-clear", "person-clear", "banner-close", "author-help-toggle"]) {
		const tag = markup.match(new RegExp(`<button id="${id}"[^>]*>`))[0];
		assert.match(tag, /data-i18n-aria="/, id);
	}
	for (const k of ["resultsLabel", "rowTick", "bannerClose", "progressLabel", "sortMenu", "keysMenu", "keysTitle", "keysClose"]) for (const lang of ["en", "ko"]) assert.ok(I18N.STRINGS[lang][k] !== undefined, lang + " " + k);
});

// WCAG 2.2 non-text contrast of the focus ring: the ink against the card and the canvas, both themes.
const lum = hex => { const c = hex.match(/\w\w/g).map(x => parseInt(x, 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
test("focus is a solid 2px ring of 3:1 or more; forced colours, more contrast and reduced motion are handled", () => {
	assert.match(css, /button:focus-visible[^{]*\{\s*outline: 2px solid var\(--accent\); outline-offset: 2px;/);
	const light = css.slice(0, css.indexOf("@media (prefers-color-scheme: dark)")), dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
	const tok = (src, name) => src.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`))[1];
	for (const src of [light, dark]) for (const bg of ["card", "bg", "menu-bg"]) assert.ok(ratio(tok(src, "accent"), tok(src, bg)) >= 3, bg);
	assert.match(css, /@media \(forced-colors: active\)/);
	assert.match(css, /@media \(prefers-contrast: more\)/);
	assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{[^}]*animation-duration/);
	assert.doesNotMatch(css, /outline-offset:\s*-\d/, "still no inset rings (the 'nails')");
	// the keyboard's row and a focused menu item are visibly darker than a selected row
	assert.match(css, /--row-focus: rgba\(20, 22, 30, 0\.15\)/);
	assert.match(css, /\.tbmenu \.selopt:focus \{ outline: none; background: var\(--seg-on\); color: var\(--seg-on-ink\); \}/);
});

// ---------------------------------------------------------------- Escape takes one layer; handled keys stay handled
import { parseHTML } from "linkedom";
import Tip from "../content/tooltip.js";
test("Escape on a visible hover card closes only the card: it is used up, so the search behind it keeps running", async () => {
	const { document } = parseHTML('<body><button id="b" data-tip="Stop the search">x</button></body>');
	const win = { document, setTimeout, clearTimeout, addEventListener() {}, innerWidth: 1000, innerHeight: 700 };
	const tip = Tip.attach(win, { delay: 0 });
	let reachedPage = 0;
	document.addEventListener("keydown", e => { if (!e.defaultPrevented) reachedPage++; });
	const fire = (el, type, extra = {}) => { const e = new document.defaultView.Event(type, { bubbles: true, cancelable: true }); Object.assign(e, extra); el.dispatchEvent(e); return e; };
	fire(document.getElementById("b"), "mouseover", { clientX: 5, clientY: 5 });
	await tick(20);
	assert.equal(tip.open, true);
	fire(document.getElementById("b"), "keydown", { key: "Escape" });
	assert.equal(tip.open, false);
	assert.equal(reachedPage, 0, "the page's Escape (stop search) never saw it");
	fire(document.getElementById("b"), "keydown", { key: "Escape" });
	assert.equal(reachedPage, 1, "with no card, Escape reaches the page");
});

test("a key a widget already handled, or one pressed on a menu button, does not also move or tick result rows", async () => {
	const ui = await loaded();
	ui.state.focusKey = "a"; ui.render();
	mockElement.active = ui.get("table-wrap");
	ui.onKeyDown({ key: "ArrowDown", defaultPrevented: true, preventDefault() {}, stopPropagation() {} });
	assert.equal(ui.state.focusKey, "a", "handled elsewhere");
	const menuBtn = ui.get("export-btn"); menuBtn.setAttribute("aria-haspopup", "menu");
	mockElement.active = menuBtn;
	key(ui, "ArrowDown"); key(ui, " ");
	assert.equal(ui.state.focusKey, "a"); assert.equal(ui.state.selected.size, 0);
	mockElement.active = ui.get("table-wrap");
	key(ui, "ArrowDown");
	assert.notEqual(ui.state.focusKey, "a", "in the list the arrows still move");
	// Escape with a search running and nothing open stops it; with the shortcut list open it only closes the list
	ui.state.searching = true; let stopped = 0; ui.state.searchController = { abort() { stopped++; } };
	key(ui, "?"); key(ui, "Escape");
	assert.equal(stopped, 0, "the list closed, the search kept going");
	ui.state.searching = false;
});

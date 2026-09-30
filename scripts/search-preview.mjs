// Offline design preview of the ZotPoP search window.
//
// Loads the real content/search.xhtml markup and content/search.css, runs the
// real content/ui.js (and the real i18n, journal marks, JCR, metrics, ...) in
// linkedom against memory-only stubs of Zotero and of the network sources, does
// one search over a fixed, clearly fictional result set, and writes the DOM as
// static HTML with the CSS inlined: no scripts, no external assets, no network.
//
//   node scripts/search-preview.mjs   ->  docs/search-preview.html (results)
//                                         docs/search-preview-detail.html (selected row)
//                                         docs/search-preview-facet.html (one author's results, three rows selected)
//                                         docs/search-preview-import.html (an import where one paper fails)
//
// After the two static states the build drives the real handlers (choose an author
// facet, the library filter, the Export/View menus, select rows, import against a stub
// importer that fails one paper, retry, jump between a preprint and its published version)
// and records what happened in `trace`, so the checks are on behaviour, not on static markup.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const require_ = (await import("node:module")).createRequire(import.meta.url);

// Fictional records. Every title, author and DOI is made up (10.5555 is a test prefix).
export const FAKE = [
	["Mapping cellular responses across tissue repair with single-cell atlases, spatial context and longitudinal sampling in three regenerating organs", ["Mina Kim", "Alex Rivera", "Jonas Park"], 2025, "Nature Methods", 214, "openalex", { doi: "10.5555/demo.001", pdf: true, jif: 32.1, abstract: "Fictional abstract for the design preview: a single-cell atlas of repair-stage cell states across three tissues." }],
	["A practical framework for reproducible literature synthesis", ["Sora Lee", "Lin Chen"], 2024, "Science", 97, "crossref", { doi: "10.5555/demo.002", pdf: true, jif: 45.8 }],
	["Spatial context and cell-state transitions in regeneration", ["Eva Morgan", "Hana Choi"], 2026, "bioRxiv", 3, "openalex", { doi: "10.5555/demo.003", pdf: true, preprint: true, server: "bioRxiv", publishedDoi: "10.5555/demo.004" }],
	["Tissue-scale repair atlases from sparse sampling", ["Ren Ahn", "Paula Silva"], 2025, "Cell", 41, "crossref", { doi: "10.5555/demo.004", inLibrary: true, jif: 42.5 }],
	["Benchmarks for repair-stage classifiers", ["Kai Oh", "Chris Voigtland"], 2024, "Nature Biotechnology", 66, "europepmc", { doi: "10.5555/demo.005", pdf: true, jif: 33.1 }],
	["Preregistered synthesis of repair reviews", ["Dana Yu", "Sora Lee"], 2023, "eLife", 12, "openalex", { doi: "10.5555/demo.006", pdf: true, jif: 6.4 }],
	["Compact editors from uncultivated bacteria", ["Jenna Dowd", "Sam Sternfield", "Priya Natarajan"], 2026, "Proceedings of the National Academy of Sciences", 18, "europepmc", { doi: "10.5555/demo.007", jif: 9.4 }],
	["Guide design rules learned from a million targets", ["Jenna Dowd", "Marta Jinkova"], 2025, "Nucleic Acids Research", 88, "crossref", { doi: "10.5555/demo.008", pdf: true, jif: 13.1 }],
	["Off-target profiling in primary human cells", ["Jenna Dowd", "Ben Oakley"], 2024, "Genome Biology", 203, "openalex", { doi: "10.5555/demo.009", pdf: true, jif: 10.1, abstract: "Fictional abstract for the design preview: guide-level off-target profiles across primary human cell types, compared between three editing enzymes." }],
	["Delivery of editing enzymes across tissue barriers", ["Jenna Dowd", "Sam Sternfield"], 2025, "Cell Reports", 61, "europepmc", { doi: "10.5555/demo.010", jif: 7.5 }],
	["Preregistered synthesis of repair reviews", ["Dana Yu", "Omar Haddad"], 2022, "medRxiv", 0, "europepmc", { doi: "10.5555/demo.011", preprint: true, server: "medRxiv" }],
	["Spatial context and cell-state transitions in regeneration: a commentary", ["Tara Novak"], 2022, "Example Journal of Tissue Studies", null, "crossref", { doi: "10.5555/demo.012" }]
];

// demo3 names its published version (demo4, in the library) itself; demo11 is linked to demo6
// only by title and first author; demo12 has a similar title and no link at all.
function records(Sources) {
	return Sources.linkPreprintVersions(FAKE.map(([title, names, year, venue, citations, source, x], i) => Sources.makeRecord({
		source, sourceId: "demo" + (i + 1), title, year, venue, citations, doi: x.doi,
		authors: names.map(n => { const p = n.split(" "); return { name: n, firstName: p.slice(0, -1).join(" "), lastName: p.at(-1) }; }),
		authorString: names.join(", "), abstract: x.abstract || "",
		pdfUrl: x.pdf ? "https://example.invalid/pdf/" + (i + 1) + ".pdf" : null,
		itemType: x.preprint ? "preprint" : "journalArticle", preprintServer: x.server || null, publishedDoi: x.publishedDoi || null,
		journalIF: x.jif ?? null, journalIFEstimate: x.jif != null, journalH: x.jif ? Math.round(x.jif * 6) : null,
		openAccess: Boolean(x.pdf)
	})));
}

// Runs the real UI once and returns the two static pages as strings.
export async function buildPreview({ locale = "en" } = {}) {
	const markup = read("content/search.xhtml").replace(/<\?xml[^>]*\?>/, "")
		.replace(/<script\b[^>]*><\/script>/g, "").replace(/<link\b[^>]*>/g, "");
	const { window, document } = parseHTML(markup);
	const css = read("content/search.css");
	const errors = [];
	let netCalls = 0;
	const importCalls = [];
	const prefs = { language: locale, searchSurface: "papers", hintShown: true, multiSourceMigrated: true, defaultSource: "multi", multiSourceMigrated2: true };
	const listeners = new Map();
	// linkedom's window rejects assignments; the UI only needs a small window surface.
	const win = { document, DOMParser: window.DOMParser, addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
		matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }), setTimeout, clearTimeout,
		innerWidth: 1280, innerHeight: 860, outerWidth: 1280, outerHeight: 860, screenX: 0, screenY: 0, close() {}, openDialog() {} };
	// linkedom has no layout: scrolling and focus are no-ops there.
	for (const name of ["scrollIntoView", "focus"]) if (!window.HTMLElement.prototype[name]) window.HTMLElement.prototype[name] = function () {};
	// HTMLSelectElement.value in linkedom does not follow the selected option.
	Object.defineProperty(window.HTMLSelectElement.prototype, "value", { configurable: true,
		get() { return this._value ?? this.querySelector("option[selected]")?.getAttribute("value") ?? this.querySelector("option")?.getAttribute("value") ?? ""; },
		set(v) { this._value = String(v); } });
	Object.defineProperty(window.HTMLSelectElement.prototype, "options", { configurable: true, get() { return [...this.querySelectorAll("option")]; } });
	Object.defineProperty(window.HTMLSelectElement.prototype, "selectedIndex", { configurable: true,
		get() { const i = this.options.findIndex(o => o.getAttribute("value") === this.value); return i < 0 ? 0 : i; },
		set(i) { this._value = this.options[i]?.getAttribute("value") ?? ""; } });

	const Sources = require_(path.join(root, "content/sources.js"));
	const recs = records(Sources);
	// A later run of the same search finds one more paper: the row the re-run marks as new.
	const later = Sources.makeRecord({ source: "openalex", sourceId: "demo13", title: "Longitudinal follow-up of repair-stage maps", year: 2026, venue: "Cell Systems", citations: 1, doi: "10.5555/demo.013",
		authors: [{ name: "Mina Kim", firstName: "Mina", lastName: "Kim" }], authorString: "Mina Kim", itemType: "journalArticle" });
	let runs = 0;
	const library = new Map([["10.5555/demo.004", 1]]);
	const ctx = vm.createContext({
		window: win, document, AbortController, console, setTimeout, clearTimeout, CSS: { escape: v => v },
		Zotero: { locale, debug() {}, logError: e => errors.push(e), launchURL() {}, Libraries: { userLibraryID: 1 },
			Prefs: { get: key => prefs[key.replace("extensions.zotpop.", "")], set: (key, v) => { prefs[key.replace("extensions.zotpop.", "")] = v; } },
			HTTP: { request: () => { netCalls++; throw new Error("network is off in the preview"); } },
			Utilities: { Internal: { copyTextToClipboard() {} } } },
		ZotPoPMarquee: { attach: () => ({ refresh() {}, refreshCell() {} }) },
		ZotPoPImporter: { importRecord: async r => { importCalls.push(r.key); return r.sourceId === "demo9" ? { status: "failed", error: "fictional failure" } : { status: "added", item: { id: 100 + importCalls.length }, pdf: r.pdfUrl ? "pdf:oa" : "no pdf", how: "translator" }; },
			getLibraryDOIMap: async () => library, getReadingStates: async ids => new Map(ids.map(id => [id, "reading"])),
			getCollectionPaths: async ids => new Map(ids.filter(id => id === 1).map(id => [id, [["Repair atlases", "Tissue maps", "2025 reviews"], ["Reading list"]]])), getTargets: () => [{ libraryID: 1, collectionID: null, label: "My Library", depth: 0 }, { libraryID: 1, collectionID: 7, label: "Repair atlases", depth: 1 }],
			getCurrentTarget: () => ({ libraryID: 1, collectionID: null }), forgetTitleIndex() {} }
	});
	win.Zotero = ctx.Zotero;
	for (const f of ["i18n", "query", "brand-icons", "affiliations", "journal-marks", "jcr", "history", "sources", "authors", "metrics", "preview"]) vm.runInContext(read(`content/${f}.js`), ctx, { filename: f });
	// linkedom's dataset drops "data-i18n" (a digit in the name); read the attribute instead. Strings stay the real ones.
	ctx.ZotPoPI18N.apply = (root, t) => {
		for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.getAttribute("data-i18n"));
		for (const el of root.querySelectorAll("[data-i18n-ph]")) el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph")));
		for (const el of root.querySelectorAll("[data-i18n-title]")) el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
		for (const el of root.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria")));
	};
	// Same search function shape as the real one; only the network is replaced.
	ctx.ZotPoPSources = Object.assign(Object.create(Sources), { search: async (_s, _q, _h, c) => { let out = runs++ ? [later, ...recs] : recs; c?.onResults?.(out, { final: false }); return out; } });
	vm.runInContext(read("content/ui.js"), ctx, { filename: "ui.js" });
	for (const fn of listeners.get("load") || []) fn();
	await new Promise(r => setTimeout(r, 30));
	document.getElementById("keywords").value = "tissue repair";
	document.getElementById("query-form").dispatchEvent(new window.Event("submit", { cancelable: true }));
	for (let i = 0; i < 100 && !document.querySelector("#results-body tr"); i++) await new Promise(r => setTimeout(r, 20));
	await new Promise(r => setTimeout(r, 60));

	const rows = document.querySelectorAll("#results-body tr");
	const page = () => {
		// Static page: mirror form state into attributes, then drop event-only nodes.
		for (const el of document.querySelectorAll("input")) {
			if (el.type === "checkbox") { if (el.checked) el.setAttribute("checked", ""); else el.removeAttribute("checked"); }
			else if (el.value != null && el.value !== "") el.setAttribute("value", el.value);
		}
		for (const s of document.querySelectorAll("select")) { const v = s.value; for (const o of s.querySelectorAll("option")) { if (o.getAttribute("value") === v) o.setAttribute("selected", ""); else o.removeAttribute("selected"); } }
		const body = document.body.outerHTML.replace(/<script\b[\s\S]*?<\/script>/g, "");
		return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZotPoP search preview (fictional data)</title><style>${css}</style></head>${body}</html>`;
	};
	const results = page();
	rows[0]?.dispatchEvent(new window.Event("click", { bubbles: true }));
	await new Promise(r => setTimeout(r, 30));
	const detail = page();

	// ---- drive states through the real handlers
	const wait = ms => new Promise(r => setTimeout(r, ms));
	const fire = (el, type = "click") => el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
	const table = () => [...document.querySelectorAll("#results-body tr")];
	const rowOf = id => table().find(tr => tr.dataset.key.endsWith(id));
	const shown = () => table().map(tr => tr.dataset.key.replace(/^.*demo/, ""));
	const text = id => document.getElementById(id).textContent;
	const trace = { columns: {}, facet: {} };
	trace.columns.basic = document.getElementById("results-table").getAttribute("data-cols");
	trace.columns.statusAttr = document.getElementById("results-table").hasAttribute("data-status");
	const items = () => [...document.querySelectorAll("#tbmenu .selopt")];
	const libLine = () => ["lib-all", "lib-new", "lib-owned"].map(text).join(" / ");
	// the View menu: opens with its items, "Columns: all" applies and closes it
	fire(document.getElementById("view-btn"));
	trace.menu = { expanded: document.getElementById("view-btn").getAttribute("aria-expanded"), labels: items().map(e => e.textContent), roles: items().map(e => e.getAttribute("role")),
		checked: items().map(e => e.getAttribute("aria-checked")), open: !document.getElementById("tbmenu").hidden };
	fire(items()[1]);
	trace.columns.all = document.getElementById("results-table").getAttribute("data-cols");
	trace.menu.closed = document.getElementById("tbmenu").hidden && document.getElementById("view-btn").getAttribute("aria-expanded") === "false";
	fire(document.getElementById("view-btn"));
	trace.menu.reopened = items().map(e => e.getAttribute("aria-checked"));
	fire(items()[0]);
	trace.columns.back = document.getElementById("results-table").getAttribute("data-cols");
	fire(document.getElementById("export-btn"));
	trace.menu.export = items().map(e => e.textContent);
	fire(document.body);
	trace.menu.closedByOutsideClick = document.getElementById("tbmenu").hidden;
	trace.columns.doiInDetail = detail.includes("10.5555/demo.001");
	trace.library = { start: libLine() };
	// preprint and published version: an explicit relation, an inferred one, an unrelated similar title
	const versions = { explicit: {}, inferred: {}, unrelated: {} };
	const versionLine = id => { fire(rowOf(id)); return { line: text("d-versions"), hidden: document.getElementById("d-versions").hidden, title: document.getElementById("d-versions").getAttribute("title"), meta: text("d-meta"), button: Boolean(document.querySelector("#d-versions button")) }; };
	Object.assign(versions.explicit, versionLine("demo3"));
	const cb3 = rowOf("demo3").querySelector("input"); cb3.checked = true; fire(cb3, "change");
	fire(document.querySelector("#d-versions button"));
	await wait(20);
	versions.explicit.jump = { title: text("d-title"), meta: text("d-meta"), line: text("d-versions"), selected: text("selected-count"), focusedRow: table().filter(tr => tr.classList.contains("focused")).map(tr => tr.dataset.key.replace(/^.*demo/, "")), primary: text("d-primary-label") };
	fire(document.querySelector("#d-versions button"));
	await wait(20);
	versions.explicit.back = { meta: text("d-meta"), selected: text("selected-count") };
	cb3.checked = false; fire(cb3, "change");
	Object.assign(versions.inferred, versionLine("demo11"));
	versions.inferred.published = versionLine("demo6");
	Object.assign(versions.unrelated, versionLine("demo12"));
	// a filter that hides the target is let go when jumping there
	fire(document.getElementById("lib-owned"));
	fire(rowOf("demo4"));
	fire(document.querySelector("#d-versions button"));
	await wait(20);
	versions.revealed = { rows: shown().length, pressed: document.getElementById("lib-all").getAttribute("aria-pressed"), detail: text("d-title") };
	trace.versions = versions;
	fire(rowOf("demo1"));
	// three rows chosen, two of them by the Jenna Dowd facet later
	for (const id of ["demo1", "demo8", "demo9"]) { const cb = rowOf(id).querySelector("input"); cb.checked = true; fire(cb, "change"); }
	trace.selectedAll = text("selected-count");
	trace.importLabel = document.getElementById("import-btn").textContent.trim();
	fire(document.getElementById("selected-only"));
	trace.selectedOnlyRows = shown();
	fire(document.getElementById("selected-only"));
	fire(document.querySelector('#results-head th[data-sort="cpy"]'));
	fire(rowOf("demo9"));
	await wait(20);
	trace.facet.evidence = text("d-evidence");
	trace.facet.line = text("d-facets");
	fire(document.querySelector("#d-facets button"));
	await wait(20);
	trace.facet.rows = shown();
	trace.facet.selected = text("selected-count");
	trace.facet.chip = text("facet-text");
	// the library counts follow the author facet; changing the filter keeps the checks
	trace.library.withFacet = libLine();
	fire(document.getElementById("lib-new"));
	trace.library.facetNew = { rows: shown(), selected: text("selected-count") };
	fire(document.getElementById("lib-all"));
	const facet = page();
	fire(document.getElementById("facet-clear"));
	await wait(20);
	trace.facet.cleared = shown().length;
	// import three, one of which fails; the failure stays selected and is the only one retried
	fire(document.getElementById("import-btn"));
	for (let i = 0; i < 100 && document.getElementById("banner").hidden; i++) await wait(20);
	trace.import = { calls: [...importCalls], selected: table().filter(tr => tr.querySelector("input").checked).map(tr => tr.dataset.key.replace(/^.*demo/, "")),
		banner: text("banner-text"), retry: document.getElementById("banner-action").textContent, statuses: Object.fromEntries(["demo1", "demo8", "demo9"].map(id => [id, rowOf(id).querySelector("td.status").textContent])) };
	const importPage = page();
	// two added, one failed: the library counts move by two; the selected-only mode ignores the library filter
	trace.library.afterImport = libLine();
	fire(document.getElementById("lib-owned"));
	trace.library.owned = shown().sort((a, b) => a - b);
	fire(document.getElementById("selected-only"));
	trace.library.selectedOnly = { rows: shown(), counts: libLine() };
	fire(document.getElementById("selected-only"));
	trace.library.ownedAgain = shown().length;
	fire(document.getElementById("lib-all"));
	importCalls.length = 0;
	fire(document.getElementById("banner-action"));
	for (let i = 0; i < 100 && !importCalls.length; i++) await wait(20);
	await wait(60);
	trace.retry = { calls: [...importCalls] };
	// a paper added from the detail alone, not checked: when it fails it is selected, with its cause in words
	{ const cb = rowOf("demo9").querySelector("input"); cb.checked = false; fire(cb, "change"); }
	trace.single = { before: text("selected-count") };
	importCalls.length = 0;
	fire(rowOf("demo9"));
	await wait(20);
	fire(document.getElementById("d-primary"));
	for (let i = 0; i < 100 && (!importCalls.length || document.getElementById("d-primary").disabled); i++) await wait(20);
	await wait(60);
	trace.single.after = { calls: [...importCalls], selected: text("selected-count"), status: text("d-status"), cls: document.getElementById("d-status").className, row: rowOf("demo9").querySelector("input").checked };
	fire(rowOf("demo4"));
	importCalls.length = 0;
	fire(document.getElementById("d-primary"));
	await wait(20);
	trace.single.owned = { label: text("d-primary-label"), calls: importCalls.length };
	fire(document.getElementById("d-more"));
	trace.single.more = items().map(e => e.textContent);
	fire(document.body);
	// ---- the same search again: a later run finds one more paper, the owned row's detail lists its collections
	const bar = year => [...document.querySelectorAll("#metrics-years .yr-bar")].find(b => b.getAttribute("title").startsWith(year));
	trace.histogram = { bars: document.querySelectorAll("#metrics-years .yr-bar").length, ends: [...document.querySelectorAll("#metrics-years .yr-ends span")].map(e => e.textContent), rows: shown().length };
	fire(bar("2025"), "mousedown");
	await wait(20);
	trace.histogram.pressed = shown().sort((a, b) => a - b);
	trace.histogram.clearLabel = document.querySelector("#metrics-years .yr-clear")?.textContent;
	trace.histogram.barsAfter = document.querySelectorAll("#metrics-years .yr-bar").length;
	fire(document.querySelector("#metrics-years .yr-clear"));
	await wait(20);
	trace.histogram.cleared = shown().length;
	fire(document.getElementById("history-btn"));
	for (let i = 0; i < 50 && document.getElementById("histmenu").hidden; i++) await wait(20);
	trace.history = { entries: [...document.querySelectorAll("#histmenu .histopt .h-meta")].map(e => e.textContent) };
	Object.assign(document.getElementById("histmenu").style, { top: "44px", left: "700px" });
	const historyPage = page();
	fire(document.body);
	document.getElementById("histmenu").hidden = true;
	document.getElementById("keywords").value = "tissue repair";
	fire(document.getElementById("query-form"), "submit");
	for (let i = 0; i < 100 && shown().length < 13; i++) await wait(20);
	await wait(60);
	trace.rerun = { rows: shown().length, marked: table().filter(tr => tr.querySelector(".new-mark")).map(tr => tr.dataset.key.replace(/^.*demo/, "")), tip: document.querySelector(".new-mark")?.getAttribute("title") };
	fire(rowOf("demo4"));
	await wait(20);
	trace.collections = { text: text("d-collections"), tip: document.getElementById("d-collections").getAttribute("title"), hiddenOnUnowned: null };
	fire(rowOf("demo3"));
	await wait(20);
	trace.collections.hiddenOnUnowned = document.getElementById("d-collections").hidden;
	fire(rowOf("demo4"));
	await wait(20);
	const rerun = page();
	return { results, detail, facet, importPage, historyPage, rerun, trace, rows: rows.length, netCalls, errors };
}

export function checkPreview(out) {
	const problems = [];
	if (out.rows < 10) problems.push("expected at least 10 result rows, got " + out.rows);
	if (out.netCalls) problems.push("network was called");
	for (const [name, html] of [["results", out.results], ["detail", out.detail], ["facet", out.facet], ["import", out.importPage], ["history", out.historyPage], ["rerun", out.rerun]]) {
		if (/<script\b|<link\b/i.test(html)) problems.push(name + ": script or link tag present");
		if (/(?:src|href)\s*=\s*["'](?:https?:|\/\/|chrome:|resource:)/i.test(html)) problems.push(name + ": external asset");
		if (/url\(\s*["']?(?:https?:|\/\/|chrome:)/i.test(html)) problems.push(name + ": external css url");
		if (name === "history" || name === "rerun") { if (!html.includes('id="results-table"')) problems.push(name + ": no table"); continue; }
		for (const needle of ['id="results-table"', 'id="results-body"', 'id="query-form"', name === "facet" ? "Off-target profiling" : "Mapping cellular responses"]) if (!html.includes(needle)) problems.push(name + ": missing " + needle);
	}
	if (!out.results.includes('class="in-library')) problems.push("no in-library row");
	if (!/id="detail-body"(?![^>]*hidden)/.test(out.detail)) problems.push("detail pane not shown for the selected row");
	const t = out.trace, same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
	if (t.columns.basic !== "basic" || t.columns.all !== "all" || t.columns.back !== "basic") problems.push("column view did not switch basic/all/basic");
	if (t.columns.statusAttr) problems.push("status column shown before any status");
	if (!t.menu.open || t.menu.expanded !== "true" || t.menu.labels.length !== 4 || !same(t.menu.roles, ["menuitemradio", "menuitemradio", "menuitemcheckbox", "menuitemcheckbox"])) problems.push("the View menu should open with two radio items and two checkable items; got " + JSON.stringify(t.menu));
	if (!t.menu.closed || !t.menu.closedByOutsideClick) problems.push("a menu should close after a choice and on an outside click");
	if (!same(t.menu.reopened, ["false", "true", "true", "true"])) problems.push("the reopened View menu should show Columns: all as chosen; got " + t.menu.reopened);
	if (t.menu.export.length < 2) problems.push("the Export menu should offer copy and save");
	if (!/전체 12 \/ 미보유 11 \/ 보유 1|All 12 \/ Not owned 11 \/ Owned 1/.test(t.library.start)) problems.push("the library filter should start at 12 / 11 / 1; got " + t.library.start);
	if (!/4 \/ .* 4 \/ .* 0$/.test(t.library.withFacet)) problems.push("the library counts should follow the author facet; got " + t.library.withFacet);
	if (!same(t.library.facetNew.rows.slice().sort(), ["10", "7", "8", "9"])) problems.push("Jenna's not-owned rows should be 7-10; got " + t.library.facetNew.rows);
	if (t.library.facetNew.selected !== t.facet.selected) problems.push("changing the library filter should keep the checks");
	if (!/12 \/ .* 9 \/ .* 3$/.test(t.library.afterImport)) problems.push("after two papers were added the counts should be 12 / 9 / 3; got " + t.library.afterImport);
	if (!same(t.library.owned, ["1", "4", "8"])) problems.push("the owned rows should be 1, 4, 8; got " + t.library.owned);
	if (!same(t.library.selectedOnly.rows, ["9"]) || !/1 \/ .* 1 \/ .* 0$/.test(t.library.selectedOnly.counts)) problems.push("selected-only should ignore the library filter and count the selection; got " + JSON.stringify(t.library.selectedOnly));
	if (t.library.ownedAgain !== 3) problems.push("turning selected-only off should bring the library filter back");
	if (!/^(출판본|Published version): Cell · 2025 · (보유|in library) · /.test(t.versions.explicit.line) || !t.versions.explicit.button) problems.push("the explicit link should name the owned published version; got " + t.versions.explicit.line);
	if (/추정|Probably/.test(t.versions.explicit.line)) problems.push("an explicit link is not marked as estimated");
	if (!/10\.5555\/demo\.003/.test(t.versions.explicit.meta) || !/10\.5555\/demo\.004/.test(t.versions.explicit.jump.meta) || !/10\.5555\/demo\.003/.test(t.versions.explicit.back.meta)) problems.push("both versions keep their own DOI");
	if (!same(t.versions.explicit.jump.focusedRow, ["4"]) || !/^(프리프린트|Preprint): bioRxiv · 2026/.test(t.versions.explicit.jump.line) || !/(라이브러리에서 보기|Show in library)/.test(t.versions.explicit.jump.primary)) problems.push("the jump should open the owned version's row and detail; got " + JSON.stringify(t.versions.explicit.jump));
	if (t.versions.explicit.jump.selected !== t.versions.explicit.back.selected || !/1/.test(t.versions.explicit.jump.selected)) problems.push("the jump should keep the checked preprint checked");
	if (!/^(출판본 추정|Probably published): eLife · 2023 · (미보유|not in library) · /.test(t.versions.inferred.line) || !/^(프리프린트 추정|Probably a preprint): medRxiv · 2022/.test(t.versions.inferred.published.line)) problems.push("a title-and-author link should be marked as estimated on both sides; got " + t.versions.inferred.line + " / " + t.versions.inferred.published.line);
	if (!t.versions.unrelated.hidden) problems.push("a similar but unrelated title must not be linked");
	if (t.versions.revealed.rows !== FAKE.length || t.versions.revealed.pressed !== "true") problems.push("jumping to a row a filter hides should let go of the filter; got " + JSON.stringify(t.versions.revealed));
	if (!same(t.single.after.calls.map(k => k.replace(/^.*demo/, "")), ["9"]) || !/^(선택 1편|1 selected)/.test(t.single.after.selected) || !t.single.after.row) problems.push("a failed add from the detail should leave the paper selected; got " + JSON.stringify(t.single.after));
	if (!/fictional failure/.test(t.single.after.status) || !/err/.test(t.single.after.cls)) problems.push("the detail should say why the add failed; got " + t.single.after.status);
	if (t.single.owned.calls !== 0 || !/(라이브러리에서 보기|Show in library)/.test(t.single.owned.label)) problems.push("an owned paper's main action shows the library copy and adds nothing");
	if (t.single.more.length !== 6) problems.push("the detail's More menu should hold the six other actions; got " + t.single.more);
	if (!t.columns.doiInDetail) problems.push("DOI missing from the detail");
	if (!same(t.facet.rows, ["9", "8", "10", "7"])) problems.push("Jenna facet + per-year sort should give 9, 8, 10, 7; got " + t.facet.rows);
	if (t.facet.cleared !== FAKE.length) problems.push("clearing the facet did not restore every row");
	if (!same(t.selectedOnlyRows.slice().sort(), ["1", "8", "9"])) problems.push("selected-only should show rows 1, 8, 9; got " + t.selectedOnlyRows);
	if (!same(t.import.selected, ["9"])) problems.push("after the import only the failed row should stay selected; got " + t.import.selected);
	if (t.import.calls.length !== 3) problems.push("import should try the three selected rows");
	if (t.retry.calls.length !== 1 || !t.retry.calls[0].endsWith("demo9")) problems.push("retry should pass only the failed key; got " + t.retry.calls);
	if (t.histogram.bars < 3 || t.histogram.ends.join() !== "2022,2026") problems.push("histogram should span 2022 to 2026; got " + t.histogram.ends);
	if (!same(t.histogram.pressed, ["1", "4", "8", "10"])) problems.push("pressing the 2025 bar should keep the 2025 rows; got " + t.histogram.pressed);
	if (t.histogram.barsAfter !== t.histogram.bars) problems.push("the histogram should keep every year after one is chosen");
	if (t.histogram.cleared !== FAKE.length) problems.push("the clear control did not restore every row");
	if (!t.history.entries.length || !/오늘|today/.test(t.history.entries[0]) || !/12/.test(t.history.entries[0])) problems.push("history entry should show its date and count; got " + t.history.entries);
	if (!same(t.rerun.marked, ["13"])) problems.push("only the new paper should be marked; got " + t.rerun.marked);
	if (!t.collections.text.includes("Tissue maps › 2025 reviews") || !t.collections.tip.includes("Repair atlases › Tissue maps › 2025 reviews") || !t.collections.hiddenOnUnowned) problems.push("owned row should list its collections; got " + t.collections.text);
	return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const out = await buildPreview({ locale: process.env.PREVIEW_LOCALE || "en" });
	const problems = checkPreview(out);
	if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
	fs.mkdirSync(path.join(root, "docs"), { recursive: true });
	fs.writeFileSync(path.join(root, "docs/search-preview.html"), out.results);
	fs.writeFileSync(path.join(root, "docs/search-preview-detail.html"), out.detail);
	fs.writeFileSync(path.join(root, "docs/search-preview-facet.html"), out.facet);
	fs.writeFileSync(path.join(root, "docs/search-preview-import.html"), out.importPage);
	fs.writeFileSync(path.join(root, "docs/search-preview-history.html"), out.historyPage);
	fs.writeFileSync(path.join(root, "docs/search-preview-rerun.html"), out.rerun);
	console.log(`ZotPoP search preview: real markup, CSS and ui.js, ${out.rows} fictional rows, no network: docs/search-preview.html, docs/search-preview-detail.html`);
	process.exit(0);
}

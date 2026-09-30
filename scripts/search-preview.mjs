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
	["Mapping cellular responses across tissue repair", ["Mina Kim", "Alex Rivera", "Jonas Park"], 2025, "Nature Methods", 214, "openalex", { doi: "10.5555/demo.001", pdf: true, jif: 32.1, abstract: "Fictional abstract for the design preview: a single-cell atlas of repair-stage cell states across three tissues." }],
	["A practical framework for reproducible literature synthesis", ["Sora Lee", "Lin Chen"], 2024, "Science", 97, "crossref", { doi: "10.5555/demo.002", pdf: true, jif: 45.8 }],
	["Spatial context and cell-state transitions in regeneration", ["Eva Morgan", "Hana Choi"], 2026, "bioRxiv", 3, "openalex", { doi: "10.5555/demo.003", pdf: true, preprint: true, server: "bioRxiv" }],
	["Tissue-scale repair atlases from sparse sampling", ["Ren Ahn", "Paula Silva"], 2025, "Cell", 41, "crossref", { doi: "10.5555/demo.004", inLibrary: true, jif: 42.5 }],
	["Benchmarks for repair-stage classifiers", ["Kai Oh", "Chris Voigtland"], 2024, "Nature Biotechnology", 66, "europepmc", { doi: "10.5555/demo.005", pdf: true, jif: 33.1 }],
	["Preregistered synthesis of repair reviews", ["Dana Yu", "Sora Lee"], 2023, "eLife", 12, "openalex", { doi: "10.5555/demo.006", pdf: true, jif: 6.4 }],
	["Compact editors from uncultivated bacteria", ["Jenna Dowd", "Sam Sternfield", "Priya Natarajan"], 2026, "Proceedings of the National Academy of Sciences", 18, "europepmc", { doi: "10.5555/demo.007", jif: 9.4 }],
	["Guide design rules learned from a million targets", ["Jenna Dowd", "Marta Jinkova"], 2025, "Nucleic Acids Research", 88, "crossref", { doi: "10.5555/demo.008", pdf: true, jif: 13.1 }],
	["Off-target profiling in primary human cells", ["Jenna Dowd", "Ben Oakley"], 2024, "Genome Biology", 203, "openalex", { doi: "10.5555/demo.009", pdf: true, jif: 10.1 }],
	["Delivery of editing enzymes across tissue barriers", ["Jenna Dowd", "Sam Sternfield"], 2025, "Cell Reports", 61, "europepmc", { doi: "10.5555/demo.010", jif: 7.5 }],
	["Rapid editing screens in primary cells", ["Iris Thorne", "Omar Haddad"], 2026, "medRxiv", 0, "europepmc", { doi: "10.5555/demo.011", preprint: true, server: "medRxiv" }],
	["Field notes on a shared vocabulary for repair-stage maps", ["Tara Novak"], 2022, "Example Journal of Tissue Studies", null, "crossref", { doi: "10.5555/demo.012" }]
];

function records(Sources) {
	return FAKE.map(([title, names, year, venue, citations, source, x], i) => Sources.makeRecord({
		source, sourceId: "demo" + (i + 1), title, year, venue, citations, doi: x.doi,
		authors: names.map(n => { const p = n.split(" "); return { name: n, firstName: p.slice(0, -1).join(" "), lastName: p.at(-1) }; }),
		authorString: names.join(", "), abstract: x.abstract || "",
		pdfUrl: x.pdf ? "https://example.invalid/pdf/" + (i + 1) + ".pdf" : null,
		itemType: x.preprint ? "preprint" : "journalArticle", preprintServer: x.server || null,
		journalIF: x.jif ?? null, journalIFEstimate: x.jif != null, journalH: x.jif ? Math.round(x.jif * 6) : null,
		openAccess: Boolean(x.pdf)
	}));
}

// Runs the real UI once and returns the two static pages as strings.
export async function buildPreview({ locale = "en" } = {}) {
	const markup = read("content/search.xhtml").replace(/<\?xml[^>]*\?>/, "")
		.replace(/<script\b[^>]*><\/script>/g, "").replace(/<link\b[^>]*>/g, "");
	const { window, document } = parseHTML(markup);
	const css = read("content/search.css");
	const errors = [];
	let netCalls = 0;
	const prefs = { language: locale, searchSurface: "papers", hintShown: true, multiSourceMigrated: true, defaultSource: "multi", multiSourceMigrated2: true };
	const listeners = new Map();
	// linkedom's window rejects assignments; the UI only needs a small window surface.
	const win = { document, DOMParser: window.DOMParser, addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
		matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }), setTimeout, clearTimeout,
		innerWidth: 1280, innerHeight: 860, outerWidth: 1280, outerHeight: 860, screenX: 0, screenY: 0, close() {}, openDialog() {} };
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
	const library = new Map([["10.5555/demo.004", 1]]);
	const ctx = vm.createContext({
		window: win, document, AbortController, console, setTimeout, clearTimeout, CSS: { escape: v => v },
		Zotero: { locale, debug() {}, logError: e => errors.push(e), launchURL() {}, Libraries: { userLibraryID: 1 },
			Prefs: { get: key => prefs[key.replace("extensions.zotpop.", "")], set: (key, v) => { prefs[key.replace("extensions.zotpop.", "")] = v; } },
			HTTP: { request: () => { netCalls++; throw new Error("network is off in the preview"); } },
			Utilities: { Internal: { copyTextToClipboard() {} } } },
		ZotPoPMarquee: { attach: () => ({ refresh() {}, refreshCell() {} }) },
		ZotPoPImporter: { getLibraryDOIMap: async () => library, getReadingStates: async ids => new Map(ids.map(id => [id, "reading"])), getTargets: () => [{ libraryID: 1, collectionID: null, label: "My Library", depth: 0 }, { libraryID: 1, collectionID: 7, label: "Repair atlases", depth: 1 }],
			getCurrentTarget: () => ({ libraryID: 1, collectionID: null }), forgetTitleIndex() {} }
	});
	win.Zotero = ctx.Zotero;
	for (const f of ["i18n", "query", "brand-icons", "affiliations", "journal-marks", "jcr", "history", "sources", "authors", "metrics", "preview"]) vm.runInContext(read(`content/${f}.js`), ctx, { filename: f });
	// linkedom's dataset drops "data-i18n" (a digit in the name); read the attribute instead. Strings stay the real ones.
	ctx.ZotPoPI18N.apply = (root, t) => {
		for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.getAttribute("data-i18n"));
		for (const el of root.querySelectorAll("[data-i18n-ph]")) el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph")));
		for (const el of root.querySelectorAll("[data-i18n-title]")) el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
	};
	// Same search function shape as the real one; only the network is replaced.
	ctx.ZotPoPSources = Object.assign(Object.create(Sources), { search: async (_s, _q, _h, c) => { c?.onResults?.(recs, { final: false }); return recs; } });
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
	return { results, detail, rows: rows.length, netCalls, errors };
}

export function checkPreview(out) {
	const problems = [];
	if (out.rows < 10) problems.push("expected at least 10 result rows, got " + out.rows);
	if (out.netCalls) problems.push("network was called");
	for (const [name, html] of [["results", out.results], ["detail", out.detail]]) {
		if (/<script\b|<link\b/i.test(html)) problems.push(name + ": script or link tag present");
		if (/(?:src|href)\s*=\s*["'](?:https?:|\/\/|chrome:|resource:)/i.test(html)) problems.push(name + ": external asset");
		if (/url\(\s*["']?(?:https?:|\/\/|chrome:)/i.test(html)) problems.push(name + ": external css url");
		for (const needle of ['id="results-table"', 'id="results-body"', 'id="query-form"', "Mapping cellular responses"]) if (!html.includes(needle)) problems.push(name + ": missing " + needle);
	}
	if (!out.results.includes('class="in-library')) problems.push("no in-library row");
	if (!/id="detail-body"(?![^>]*hidden)/.test(out.detail)) problems.push("detail pane not shown for the selected row");
	return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const out = await buildPreview({ locale: process.env.PREVIEW_LOCALE || "en" });
	const problems = checkPreview(out);
	if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
	fs.mkdirSync(path.join(root, "docs"), { recursive: true });
	fs.writeFileSync(path.join(root, "docs/search-preview.html"), out.results);
	fs.writeFileSync(path.join(root, "docs/search-preview-detail.html"), out.detail);
	console.log(`ZotPoP search preview: real markup, CSS and ui.js, ${out.rows} fictional rows, no network: docs/search-preview.html, docs/search-preview-detail.html`);
	process.exit(0);
}

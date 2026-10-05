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
// Institutions are made up as well. aff[i] is [institution, country] for the i-th author, corr is the corresponding author.
const EAST = ["Eastbridge University", "US"], KESTREL = ["Kestrel Institute", "GB"], HANBIT = ["Hanbit University", "KR"], MERIDIAN = ["Meridian Institute of Technology", "US"],
	ALTMARK = ["University of Altmark", "DE"], SATO = ["Sato Research Institute", "JP"], LUMEN = ["Lumen University", "CN"], AURORA = ["Aurora Medical Institute", "CA"];
// Institution h-index (OpenAlex summary_stats), as the real lookup would have filled it in: T1 >= 1400, T2 >= 800, T3 >= 400, T4 below.
// Meridian has none on purpose: a lab the lookup has not answered for yet shows its flag and name without a tier.
const INST_H = { "Eastbridge University": 2320, "Kestrel Institute": 1510, "Hanbit University": 640, "University of Altmark": 455, "Sato Research Institute": 310, "Lumen University": 2510, "Aurora Medical Institute": 260 };
export const FAKE = [
	["Mapping cellular responses across tissue repair with single-cell atlases, spatial context and longitudinal sampling in three regenerating organs", ["Mina Kim", "Alex Rivera", "Jonas Park"], 2025, "Nature Methods", 214, "openalex", { doi: "10.5555/demo.001", pdf: true, jif: 32.1, abstract: "Fictional abstract for the design preview: a single-cell atlas of repair-stage cell states across three tissues.", aff: [EAST, MERIDIAN, EAST], corr: 2, also: ["crossref"] }],
	["A practical framework for reproducible literature synthesis", ["Sora Lee", "Lin Chen"], 2024, "Science", 97, "crossref", { doi: "10.5555/demo.002", pdf: true, jif: 45.8, abstract: "Fictional abstract for the design preview: a checklist for synthesis that another group can rerun.", aff: [HANBIT, LUMEN], corr: 1, review: true }],
	["Spatial context and cell-state transitions in regeneration", ["Eva Morgan", "Hana Choi"], 2026, "bioRxiv", 3, "openalex", { doi: "10.5555/demo.003", pdf: true, preprint: true, server: "bioRxiv", publishedDoi: "10.5555/demo.004", aff: [KESTREL, HANBIT], corr: 1 }],
	["Tissue-scale repair atlases from sparse sampling", ["Ren Ahn", "Paula Silva"], 2025, "Cell", 41, "crossref", { doi: "10.5555/demo.004", inLibrary: true, jif: 42.5, aff: [HANBIT, ALTMARK], corr: 1 }],
	["Benchmarks for repair-stage classifiers", ["Kai Oh", "Chris Voigtland"], 2024, "Nature Biotechnology", 66, "europepmc", { doi: "10.5555/demo.005", pdf: true, jif: 33.1, abstract: "Fictional abstract for the design preview: held-out benchmarks for classifiers of repair stage.", aff: [SATO, MERIDIAN], corr: 0 }],
	["Preregistered synthesis of repair reviews", ["Dana Yu", "Sora Lee"], 2023, "eLife", 12, "openalex", { doi: "10.5555/demo.006", pdf: true, jif: 6.4, aff: [LUMEN, HANBIT], corr: 1, also: ["europepmc"] }],
	["Compact editors from uncultivated bacteria", ["Jenna Dowd", "Sam Sternfield", "Priya Natarajan"], 2026, "Proceedings of the National Academy of Sciences", 18, "europepmc", { doi: "10.5555/demo.007", jif: 9.4, aff: [AURORA, AURORA, KESTREL], corr: 0, retracted: true }],
	["Guide design rules learned from a million targets", ["Jenna Dowd", "Marta Jinkova"], 2025, "Nucleic Acids Research", 88, "crossref", { doi: "10.5555/demo.008", pdf: true, jif: 13.1, aff: [AURORA, ALTMARK], corr: 1 }],
	["Off-target profiling in primary human cells", ["Jenna Dowd", "Ben Oakley"], 2024, "Genome Biology", 203, "openalex", { doi: "10.5555/demo.009", pdf: true, jif: 10.1, abstract: "Fictional abstract for the design preview: guide-level off-target profiles across primary human cell types, compared between three editing enzymes.", aff: [AURORA, EAST], corr: 0 }],
	["Delivery of editing enzymes across tissue barriers", ["Jenna Dowd", "Sam Sternfield"], 2025, "Cell Reports", 61, "europepmc", { doi: "10.5555/demo.010", jif: 7.5, aff: [AURORA], corr: 1 }],
	["Preregistered synthesis of repair reviews", ["Dana Yu", "Omar Haddad"], 2022, "medRxiv", 0, "europepmc", { doi: "10.5555/demo.011", preprint: true, server: "medRxiv", aff: [LUMEN, KESTREL], corr: 1 }],
	["Spatial context and cell-state transitions in regeneration: a commentary", ["Tara Novak"], 2022, "Example Journal of Tissue Studies", null, "crossref", { doi: "10.5555/demo.012" }]
];

// Yearly citations (OpenAlex counts_by_year), fictional. The sums follow the citation counts above where the paper has them.
const CITES_BY_YEAR = {
	demo1: [[2025, 131], [2026, 83]],
	demo2: [[2024, 22], [2025, 51], [2026, 24]],
	demo4: [[2025, 30], [2026, 11]],
	demo5: [[2024, 20], [2025, 29], [2026, 17]],
	demo6: [[2023, 1], [2024, 4], [2025, 5], [2026, 2]],
	demo8: [[2025, 60], [2026, 28]],
	demo9: [[2024, 48], [2025, 94], [2026, 61]]
};
// One older paper with ten years of history, for the trend card.
export const OLD_PAPER = { sourceId: "demo14", doi: "10.5555/demo.014", title: "A decade of tissue repair kinetics: reference cohorts, reanalysed", year: 2018, venue: "Cell Reports", citations: 638, previous: 611,
	byYear: [[2018, 12], [2019, 58], [2020, 96], [2021, 121], [2022, 104], [2023, 88], [2024, 74], [2025, 51], [2026, 34]],
	fresh: { citations: 645, byYear: [[2018, 12], [2019, 58], [2020, 96], [2021, 121], [2022, 104], [2023, 88], [2024, 74], [2025, 51], [2026, 41]] },
	abstract: "Fictional abstract for the design preview: reference cohorts of tissue repair, sampled across ten years, are reanalysed with one pipeline. Healing speed is steady in young cohorts and falls with age; the effect is smaller than the difference between sampling sites." };
const fromPairs = list => list ? list.map(([year, n]) => ({ year, n })) : null;

// demo3 names its published version (demo4, in the library) itself; demo11 is linked to demo6
// only by title and first author; demo12 has a similar title and no link at all.
// A made-up OpenAlex author id per name (the same name, the same id), so a followed author is found by id.
const authorId = name => "A" + (5000 + [...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0));
function people(names, x) {
	if (!x.aff) return null;
	return names.map((n, i) => ({ name: n, openalexId: authorId(n), position: i === 0 ? "first" : i === names.length - 1 ? "last" : "middle", corresponding: x.corr === i,
		institution: x.aff[i]?.[0] || "", institutionId: x.aff[i] ? "I" + (x.aff[i][0].length * 1000 + x.aff[i][0].charCodeAt(0)) : null, country: x.aff[i]?.[1] || null, institutionH: INST_H[x.aff[i]?.[0]] ?? null }));
}
function records(Sources) {
	return Sources.linkPreprintVersions(FAKE.map(([title, names, year, venue, citations, source, x], i) => Sources.makeRecord({
		source, sourceId: "demo" + (i + 1), title, year, venue, citations, doi: x.doi,
		authors: names.map(n => { const p = n.split(" "); return { name: n, firstName: p.slice(0, -1).join(" "), lastName: p.at(-1) }; }),
		authorString: names.join(", "), abstract: x.abstract || "",
		pdfUrl: x.pdf ? "https://example.invalid/pdf/" + (i + 1) + ".pdf" : null,
		itemType: x.preprint ? "preprint" : "journalArticle", preprintServer: x.server || null, publishedDoi: x.publishedDoi || null,
		workType: x.review ? "review" : null, retracted: Boolean(x.retracted), people: people(names, x), sources: x.also ? [source, ...x.also] : undefined,
		journalIF: null, journalOA2y: x.jif ?? null, journalH: x.jif ? Math.round(x.jif * 6) : null,
		openAccess: Boolean(x.pdf), citesByYear: fromPairs(CITES_BY_YEAR["demo" + (i + 1)])
	})));
}

// Fifty-four years of fictional papers (1973-2026), thin in the old decades and thick in the recent ones,
// for the year histogram's long span.
export function longSpan(Sources) {
	const out = [];
	let n = 0;
	for (let year = 1973; year <= 2026; year++) {
		const count = year < 1990 ? (year === 1973 || year % 7 === 0 ? 1 : 0) : year < 2005 ? 1 + (year % 3) : year < 2015 ? 3 + (year % 4) : 5 + (year * 7) % 9;
		for (let k = 0; k < count; k++, n++) {
			out.push(Sources.makeRecord({ source: ["openalex", "crossref", "europepmc"][n % 3], sourceId: "span" + n, title: "Fictional long-span study " + (n + 1) + " of repair kinetics", year, venue: ["Cell", "Science", "eLife", "Nature Methods"][n % 4],
				citations: (n * 37) % 300, doi: "10.5555/span." + (n + 1), authors: [{ name: "Author " + (n % 9), firstName: "Author", lastName: String(n % 9) }], authorString: "Author " + (n % 9), itemType: "journalArticle" }));
		}
	}
	return out;
}

// Where the cells sit in a 1280 and a 1440 wide window (measured from the page in Chrome; the rows are 48px, the first at y=191),
// for the hover-card states. At 1280 the authors column is folded away.
const cellRect = (left, right, row) => ({ left, right, top: 191 + 48 * row, bottom: 239 + 48 * row });
const TIP_RECTS = { title: [cellRect(311, 511, 0), cellRect(311, 511, 0)], aff: [cellRect(511, 661, 1), cellRect(661, 811, 1)],
	journal: [cellRect(719, 903, 0), cellRect(869, 1053, 0)], authors: [cellRect(511, 661, 0), cellRect(511, 661, 0)] };


// ---- fictional ORCID people for the author tab's name lookup (valid ORCID checksums, made-up everything else)
const ORCID_IDS = { main: "0000-0001-1111-1118", second: "0000-0003-3333-3330", empty: "0000-0002-2222-2224", other: "0000-0004-4444-4447" };
const orcidRow = (id, given, family, institutions) => ({ "orcid-id": id, "given-names": given, "family-names": family, "credit-name": null, "other-name": [], "institution-name": institutions });
const orcidAlexAuthor = (id, works, cites, h, inst, country, topic) => ({ id: "https://openalex.org/A" + works, orcid: "https://orcid.org/" + id, works_count: works, cited_by_count: cites,
	summary_stats: { h_index: h }, last_known_institutions: [{ display_name: inst, country_code: country }], topics: [{ display_name: topic }] });
let orcidWorksJSON = [];
const aff = (kind, rows) => ({ "affiliation-group": rows.map(r => ({ summaries: [{ [kind + "-summary"]: { "role-title": r[0], organization: { name: r[1] }, "start-date": { year: { value: String(r[2]) } }, "end-date": r[3] ? { year: { value: String(r[3]) } } : null } }] })) });
function orcidFixtureAnswer(url) {
	const main = ORCID_IDS.main;
	if (url.startsWith("https://pub.orcid.org/v3.0/expanded-search/")) return { "num-found": 4, "expanded-result": [
		orcidRow(ORCID_IDS.other, "Jennifer", "Dowdell", []), orcidRow(ORCID_IDS.second, "Jenna", "Dowd", ["Fictional University"]),
		orcidRow(ORCID_IDS.empty, "Jenna M.", "Dowd", ["Hanbit University"]), orcidRow(main, "Jenna A.", "Dowd", ["Aurora Medical Institute", "Example Institute of Genome Engineering"])] };
	if (url.startsWith("https://api.openalex.org/authors?search=")) return { results: [
		{ ...orcidAlexAuthor(main, 212, 18420, 54, "Aurora Medical Institute", "CA", "Genome editing and delivery"), display_name: "Jenna A. Dowd", display_name_alternatives: ["Jenna Dowd"] },
		{ ...orcidAlexAuthor(ORCID_IDS.second, 14, 380, 6, "Fictional University", "US", "Plant genomics"), display_name: "Jenna Dowd", display_name_alternatives: [] },
		{ id: "https://openalex.org/A9", orcid: null, display_name: "Jenna Dowd", display_name_alternatives: ["J. Dowd"], works_count: 3, cited_by_count: 21, summary_stats: { h_index: 2 }, last_known_institutions: [{ display_name: "Lumen University", country_code: "KR" }], topics: [{ display_name: "Soil microbiology" }] },
		{ id: "https://openalex.org/A2", orcid: null, display_name: "J Dowd", display_name_alternatives: [], works_count: 0, cited_by_count: 0, summary_stats: { h_index: 0 }, last_known_institutions: [], topics: [] }] };
	if (url.startsWith("https://api.openalex.org/authors?")) return { results: [
		orcidAlexAuthor(ORCID_IDS.second, 14, 380, 6, "Fictional University", "US", "Plant genomics"),
		orcidAlexAuthor(main, 212, 18420, 54, "Aurora Medical Institute", "CA", "Genome editing and delivery")] };
	if (url.startsWith("https://api.openalex.org/works?filter=authorships.author.orcid:") || url.startsWith("https://api.openalex.org/works?filter=authorships.author.id:A212")) return { meta: { count: orcidWorksJSON.length }, results: orcidWorksJSON };
	if (url.startsWith("https://api.openalex.org/")) return { meta: { count: 0 }, results: [] };
	if (url === `https://pub.orcid.org/v3.0/${main}/person`) return { path: `/${main}/person`, name: null,
		biography: { content: "Fictional biography for the design preview. Jenna Dowd studies how compact genome editors can be delivered across tissue barriers, and how their off-target behaviour is measured in primary human cells. She leads a small group that shares guide design rules and benchmark data openly." },
		keywords: { keyword: ["genome editing", "delivery", "off-target profiling", "benchmarks"].map(content => ({ content })) },
		"researcher-urls": { "researcher-url": [{ "url-name": "Group site", url: { value: "https://lab.example.org/dowd" } }, { "url-name": "Profile", url: { value: "https://www.linkedin.com/in/jenna-dowd-example" } }] } };
	if (url === `https://pub.orcid.org/v3.0/${main}/employments`) return { path: `/${main}/employments`, ...aff("employment", [["Associate Director", "Aurora Medical Institute", 2021, null], ["Group Leader", "Example Institute of Genome Engineering", 2016, 2021], ["Postdoctoral Fellow", "Fictional University", 2011, 2016], ["Research Assistant", "Hanbit University", 2008, 2011], ["Intern", "Lumen University", 2007, 2008]]) };
	if (url === `https://pub.orcid.org/v3.0/${main}/educations`) return { path: `/${main}/educations`, ...aff("education", [["PhD", "Fictional University", 2007, 2011], ["BSc", "Hanbit University", 2003, 2007]]) };
	return null;
}
// Runs the real UI once and returns the two static pages as strings.
export async function buildPreview({ locale = "en" } = {}) {
	const markup = read("content/search.xhtml").replace(/<\?xml[^>]*\?>/, "")
		.replace(/<script\b[^>]*><\/script>/g, "").replace(/<link\b[^>]*>/g, "");
	const { window, document } = parseHTML(markup);
	const css = read("content/search.css");
	const errors = [];
	let netCalls = 0, dialogs = 0;
	// What is answered in place of the network: the OpenAlex lookup behind the citation card, and a translation service.
	const stubbed = { openalex: [], translate: [], orcid: [], orcidAlex: [] };
	const launched = [];
	const previewFiles = new Map();
	let freshWork = null;
	const importCalls = [], importNotes = new Map();
	// Style Custom, fictional: the library's stored works (demo1 is cited by two of them and cites two others), one followed author.
	const watchCalls = [], queueCalls = [], queued = new Set();
	const LIB = { LIBA: ["Repair-stage markers in regenerating tissue", "W7001", ["W9001"]], LIBB: ["A field guide to atlas-scale sampling", "W7002", []], LIBC: ["Spatial cell-state methods compared", "W7003", ["W9001"]] };
	const watchedRows = [{ id: authorId("Jonas Park"), name: "Jonas Park", institution: "Eastbridge University" }];
	const styleCustom = { paperWorks: () => Object.fromEntries(Object.entries(LIB).map(([k, [, id, refs]]) => ["1:" + k, { openalex: id, references: refs }])),
		watchedAuthors: () => watchedRows, state: () => ({ status: "unread" }),
		queueForReading: async (items, o) => { queueCalls.push({ n: items.length, reason: o?.reason, source: o?.source }); for (const i of items) queued.add(i.id); },
		isQueued: item => queued.has(item.id),
		watchAuthor: async p => { watchCalls.push(p); watchedRows.push({ id: p.id, name: p.name, institution: p.institution }); return p; } };
	const refRequests = [];
	const prefs = { language: locale, searchSurface: "papers", hintShown: true, multiSourceMigrated: true, defaultSource: "multi", multiSourceMigrated2: true, journalLookup: false };
	const listeners = new Map();
	// linkedom's window rejects assignments; the UI only needs a small window surface.
	const win = { document, DOMParser: window.DOMParser, addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
		matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }), setTimeout, clearTimeout,
		innerWidth: 1280, innerHeight: 860, outerWidth: 1280, outerHeight: 860, screenX: 0, screenY: 0, close() {}, openDialog() { dialogs++; } };
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
		window: win, document, AbortController, URL, console, setTimeout, clearTimeout, CSS: { escape: v => v },
		Zotero: { locale, debug() {}, logError: e => errors.push(e), launchURL: url => launched.push(url), Libraries: { userLibraryID: 1 },
			Prefs: { get: key => prefs[key.replace("extensions.zotpop.", "")], set: (key, v) => { prefs[key.replace("extensions.zotpop.", "")] = v; } },
			StyleCustom: styleCustom,
			Items: { get: id => ({ id }), getByLibraryAndKey: (_lib, key) => LIB[key] ? { id: 500 + Object.keys(LIB).indexOf(key), deleted: false, getField: () => LIB[key][0] } : null },
			HTTP: { request: async (_method, url) => {
				// One paper's reference list (select=referenced_works): the fictional demo1 cites two of the library's papers.
				if (/select=id,referenced_works/.test(url)) { refRequests.push(url.replace(/\?.*/, "")); return { status: 200, response: /demo\.001/.test(url) ? { id: "https://openalex.org/W9001", referenced_works: ["https://openalex.org/W7001", "https://openalex.org/W7002", "https://openalex.org/W8888"] } : { id: "https://openalex.org/W9999", referenced_works: [] } }; }
				// The one paper's refresh: answered from the fixture, counted apart from the network (which stays at zero).
				if (/^https:\/\/api\.openalex\.org\/works\/doi:/.test(url) && freshWork) { stubbed.openalex.push(url.replace(/\?.*/, "")); return { status: 200, response: freshWork }; }
				// The ORCID name lookup and the OpenAlex answers behind it: fictional people, answered in place of the network.
				const fictional = orcidFixtureAnswer(url);
				if (fictional) { (/^https:\/\/pub\.orcid\.org\//.test(url) ? stubbed.orcid : stubbed.orcidAlex).push(url.replace(/\?.*/, "")); return { status: 200, response: fictional }; }
				netCalls++; throw new Error("network is off in the preview");
			} },
			Utilities: { Internal: { copyTextToClipboard() {} } } },
		ZotPoPMarquee: { attach: () => ({ refresh() {}, refreshCell() {} }) },
		ZotPoPImporter: { importRecord: async (r, o) => { importCalls.push(r.key); importNotes.set(r.key, o?.translatedNote || null); return r.sourceId === "demo9" ? { status: "failed", error: "fictional failure" } : { status: "added", item: { id: 100 + importCalls.length }, pdf: r.pdfUrl ? "pdf:oa" : "no pdf", how: "translator" }; },
			getLibraryDOIMap: async () => library, getReadingStates: async ids => new Map(ids.map(id => [id, "reading"])),
			getCollectionPaths: async ids => new Map(ids.filter(id => id === 1).map(id => [id, [["Repair atlases", "Tissue maps", "2025 reviews"], ["Reading list"]]])), getTargets: () => [{ libraryID: 1, collectionID: null, label: "My Library", depth: 0 }, { libraryID: 1, collectionID: 7, label: "Repair atlases", depth: 1 }],
			getCurrentTarget: () => ({ libraryID: 1, collectionID: null }), forgetTitleIndex() {} }
	});
	win.Zotero = ctx.Zotero;
	for (const f of ["i18n", "query", "brand-icons", "affiliations", "journal-marks", "jcr", "history", "sources", "authors", "metrics", "filters", "journals", "signals", "tooltip", "cite", "translate", "preview"]) vm.runInContext(read(`content/${f}.js`), ctx, { filename: f });
	// linkedom's dataset drops "data-i18n" (a digit in the name); read the attribute instead. Strings stay the real ones.
	ctx.ZotPoPI18N.apply = (root, t) => {
		for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.getAttribute("data-i18n"));
		for (const el of root.querySelectorAll("[data-i18n-ph]")) el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph")));
		for (const el of root.querySelectorAll("[data-i18n-title]")) ctx.ZotPoPTip.set(el, t(el.getAttribute("data-i18n-title")));
		for (const el of root.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria")));
	};
	// Same search function shape as the real one; only the network is replaced.
	let lastQuery = null, override = null;
	ctx.ZotPoPSources = Object.assign(Object.create(Sources), { search: async (_s, q, _h, c) => { lastQuery = q; let out = override || (runs++ ? [later, ...recs] : recs); c?.onResults?.(out, { final: false }); return out; } });
	// Storage that remembers across this one run, holding a look at the older paper 12 days ago (611 citations).
	const realMemoryIO = ctx.ZotPoPHistory.memoryIO;
	ctx.ZotPoPHistory.memoryIO = () => realMemoryIO(previewFiles);
	previewFiles.set("citations.json", JSON.stringify({ version: 1, entries: [["d:" + OLD_PAPER.doi, OLD_PAPER.previous, Date.now() - 12 * 86400000, null, null]] }));
	// A fake "Translate for Zotero": the same call shape as the real plugin, answering a fictional Korean text.
	const KO = new Map([[FAKE[0][6].abstract, "디자인 미리보기를 위한 가상 초록: 세 조직에서 재생 단계의 세포 상태를 보여 주는 단일세포 아틀라스."],
		[FAKE[0][0], "세 재생 장기에서 단일세포 아틀라스, 공간 맥락, 종단 표본으로 본 조직 복구의 세포 반응 지도"],
		[OLD_PAPER.abstract, "디자인 미리보기를 위한 가상 초록: 10년에 걸쳐 표본을 모은 조직 복구 기준 코호트를 하나의 분석 파이프라인으로 다시 분석했다. 회복 속도는 젊은 코호트에서 일정하고 나이가 들수록 느려지지만, 그 효과는 표본 채취 부위 사이의 차이보다 작다."],
		[OLD_PAPER.title, "조직 복구 동역학의 10년: 기준 코호트의 재분석"]]);
	ctx.Zotero.PDFTranslate = { api: { translate: async (text, options) => { stubbed.translate.push({ chars: text.length, langto: options?.langto, hasPluginID: Boolean(options?.pluginID), keys: Object.keys(options || {}).sort() });
		return { status: "success", result: KO.get(text) || "(가상 번역) " + text, service: "deeplfree" }; } } };
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
	// ---- the hover card, open over the table: the title card of row 1 and the institution card of row 2.
	// linkedom has no layout, so the anchor rectangles are the measured ones of a 1280-wide window (the title column
	// starts at the same x at 1440); the card's own position comes from the real placement function.
	const tipApi = ctx.ZotPoPTip.current(), tipCard = document.getElementById("tip-card"), tipCases = {};
	const tipState = (index, kind) => {
		const cell = document.querySelectorAll("#results-body tr")[index].querySelector(`td[data-tip-kind="${kind}"]`);
		const [narrow, wide] = TIP_RECTS[kind], at = rect => ({ x: rect.left + 40, y: rect.top + 14 }), size = { w: 420, h: 190 };
		// the institution cell (data-tip-align="start") hangs its card from its own left edge, not from the pointer
		const aligned = cell.getAttribute("data-tip-align") === "start";
		const put = tipApi.show(cell, { rect: narrow, cursor: at(narrow), size, view: { w: 1280, h: 860 }, immediate: true });
		const bigger = ctx.ZotPoPTip.place({ anchor: wide, size, view: { w: 1440, h: 860 }, cursor: aligned ? null : at(wide) });
		// a static page cannot measure, so the 1440 position rides in a media query
		const html = page().replace("</style></head>", `@media (min-width: 1400px) { #tip-card { left: ${bigger.left}px !important; top: ${bigger.top}px !important; } }</style></head>`);
		tipCases[kind] = { text: tipCard.textContent.replace(/\s+/g, " ").trim(), put, describedby: cell.getAttribute("aria-describedby"), tipAttr: cell.hasAttribute("data-tip"), titleAttr: cell.hasAttribute("title") };
		tipApi.hide(); tipCard.hidden = true; tipCard.classList.remove("show"); tipCard.textContent = ""; tipCard.removeAttribute("style");
		return html;
	};
	const tipTitle = tipState(0, "title"), tipAff = tipState(1, "aff"), tipJournal = tipState(0, "journal"), tipAuthors = tipState(0, "authors");
	const results = page();
	rows[0]?.dispatchEvent(new window.Event("click", { bubbles: true }));
	await new Promise(r => setTimeout(r, 30));
	const detail = page();
	// What the library says about the open paper (stubbed Style Custom): counts, a list opened from one, follow buttons.
	const sigText = id => document.getElementById(id).textContent;
	const signals = { text: document.getElementById("d-signals").textContent, hidden: document.getElementById("d-signals").hidden, refRequests: refRequests.length,
		buttons: [...document.querySelectorAll("#d-signals button.watch-btn")].map(b => [b.textContent, b.getAttribute("aria-pressed")]),
		counts: [...document.querySelectorAll("#d-signals button.sig-count")].map(b => b.textContent) };
	document.querySelector("#d-signals button.sig-count").dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
	signals.list = [...document.querySelectorAll("#d-signals .sig-title")].map(n => n.textContent);
	const signalsPage = page();
	document.querySelector("#d-signals button.sig-count").dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
	// follow a principal author (the first one): the real handler, the stubbed watch call
	const followBtn = [...document.querySelectorAll("#d-signals button.watch-btn")].find(b => b.getAttribute("aria-pressed") === "false");
	followBtn.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
	await new Promise(r => setTimeout(r, 30));
	signals.watch = { calls: watchCalls.map(c => ({ ...c })), buttons: [...document.querySelectorAll("#d-signals button.watch-btn")].map(b => b.getAttribute("aria-pressed")) };
	// the retracted paper: its row chip and detail chip
	const retractedRow = [...document.querySelectorAll("#results-body tr")].find(tr => tr.dataset.key.endsWith("demo7"));
	signals.retractedRow = retractedRow.querySelector(".retract-mark")?.textContent || null;
	signals.retractedRows = document.querySelectorAll("#results-body .retract-mark").length;
	retractedRow.dispatchEvent(new window.Event("click", { bubbles: true }));
	await new Promise(r => setTimeout(r, 30));
	signals.retractedDetail = [...document.querySelectorAll("#d-badges .badge.retracted")].map(n => n.textContent);
	const retractedPage = page();
	document.querySelectorAll("#results-body tr")[0].dispatchEvent(new window.Event("click", { bubbles: true }));
	await new Promise(r => setTimeout(r, 30));

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
	const versionLine = id => { fire(rowOf(id)); return { line: text("d-versions"), hidden: document.getElementById("d-versions").hidden, title: document.getElementById("d-versions").getAttribute("data-tip"), meta: text("d-meta"), button: Boolean(document.querySelector("#d-versions button")) }; };
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
	const bar = year => [...document.querySelectorAll("#metrics-years .yr-bar")].find(b => b.getAttribute("data-tip").startsWith(year));
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
	document.getElementById("banner").hidden = true; // the popup is the subject of this page, not the import notice behind it
		// Hung from the right edge of the 최근 검색 button, as ui.js does in a real window (no layout here to measure).
		Object.assign(document.getElementById("histmenu").style, { top: "101px", left: "auto", right: "33px", maxWidth: "560px" });
	const historyPage = page();
	fire(document.body);
	document.getElementById("histmenu").hidden = true;
	document.getElementById("keywords").value = "tissue repair";
	fire(document.getElementById("query-form"), "submit");
	for (let i = 0; i < 100 && shown().length < 13; i++) await wait(20);
	await wait(60);
	trace.rerun = { rows: shown().length, marked: table().filter(tr => tr.querySelector(".new-mark")).map(tr => tr.dataset.key.replace(/^.*demo/, "")), tip: document.querySelector(".new-mark")?.getAttribute("data-tip") };
	fire(rowOf("demo4"));
	await wait(20);
	trace.collections = { text: text("d-collections"), tip: document.getElementById("d-collections").getAttribute("data-tip"), hiddenOnUnowned: null };
	fire(rowOf("demo3"));
	await wait(20);
	trace.collections.hiddenOnUnowned = document.getElementById("d-collections").hidden;
	fire(rowOf("demo4"));
	await wait(20);
	const rerun = page();
	// ---- pinned searches: pin the search just run, run a later one that finds a paper the pin has not shown, read the menu, open the pin
	{
		const histMenu = () => document.getElementById("histmenu");
		const settle = async () => { await wait(80); };
		const placeMenu = () => { document.getElementById("banner").hidden = true; Object.assign(histMenu().style, { top: "101px", left: "auto", right: "33px", maxWidth: "560px" }); };
		fire(document.getElementById("history-btn"));
		for (let i = 0; i < 50 && histMenu().hidden; i++) await wait(20);
		const row = [...histMenu().querySelectorAll(".histopt")].find(r => /tissue repair/.test(r.textContent));
		trace.pins = { actions: [...histMenu().querySelectorAll(".h-act")].map(b => b.textContent).slice(0, 2) };
		fire(row.querySelector(".h-act"));
		await settle();
		trace.pins.afterPin = { head: [...histMenu().querySelectorAll(".menu-head")].map(e => e.textContent), pinned: [...histMenu().querySelectorAll(".histopt.pinned")].map(e => e.textContent.replace(/\s+/g, " ").trim()) };
		fire(document.body);
		histMenu().hidden = true;
		const found = Sources.makeRecord({ source: "openalex", sourceId: "demo15", title: "Repair-stage maps in a second species", year: 2026, venue: "Cell Systems", citations: 0, doi: "10.5555/demo.015",
			authors: [{ name: "Mina Kim", firstName: "Mina", lastName: "Kim" }], authorString: "Mina Kim", itemType: "journalArticle" });
		override = [found, later, ...recs];
		document.getElementById("keywords").value = "tissue repair";
		fire(document.getElementById("query-form"), "submit");
		for (let i = 0; i < 100 && shown().length < 14; i++) await wait(20);
		await settle();
		override = null;
		fire(document.getElementById("history-btn"));
		for (let i = 0; i < 50 && histMenu().hidden; i++) await wait(20);
		trace.pins.menu = { pinned: [...histMenu().querySelectorAll(".histopt.pinned")].map(e => e.textContent.replace(/\s+/g, " ").trim()), badge: histMenu().querySelector(".h-new")?.textContent, on: histMenu().querySelector(".h-new")?.classList.contains("on"),
			actions: [...histMenu().querySelectorAll(".histopt.pinned .h-act")].map(b => b.textContent) };
		placeMenu();
		var pinsMenuPage = page();
		const netBefore = netCalls, searches = runs;
		fire(histMenu().querySelector(".histopt.pinned"));
		await settle();
		trace.pins.opened = { rows: shown().length, marked: table().filter(tr => tr.querySelector(".new-mark")).map(tr => tr.dataset.key.replace(/^.*demo/, "")), status: text("status"), searchesRun: runs - searches, net: netCalls - netBefore };
		var pinResultsPage = page();
		fire(document.getElementById("history-btn"));
		for (let i = 0; i < 50 && histMenu().hidden; i++) await wait(20);
		trace.pins.afterLook = histMenu().querySelector(".h-new")?.textContent;
		fire(document.body);
		histMenu().hidden = true;
		// back to the thirteen rows the later sections expect
		override = [later, ...recs];
		document.getElementById("keywords").value = "tissue repair";
		fire(document.getElementById("query-form"), "submit");
		for (let i = 0; i < 100 && shown().length !== 13; i++) await wait(20);
		await wait(60);
		override = null;
	}
	// ---- add and queue to read (Style Custom's queue, fictional), then the PDF preview inside the detail card
	{
		fire(rowOf("demo3"));
		await wait(20);
		const q = { shown: !document.getElementById("d-queue").hidden, label: text("d-queue-label") };
		fire(document.getElementById("d-queue"));
		for (let i = 0; i < 100 && !queueCalls.length; i++) await wait(20);
		await wait(60);
		trace.queue = { ...q, calls: queueCalls.slice(), afterLabel: text("d-queue-label"), pressed: document.getElementById("d-queue").getAttribute("aria-pressed"), optionVisible: !document.getElementById("opt-queue-wrap").hidden };
		fire(rowOf("demo1"));
		await wait(20);
		const sheet = (r, n) => { const d = document.createElement("div"); d.setAttribute("role", "img"); d.setAttribute("style", "width:440px;max-width:100%;height:560px;margin:0 auto;background:#fff;color:#24262c;border-radius:6px;box-shadow:0 1px 4px rgba(20,22,30,.18);padding:36px 40px;text-align:left;font:13px/1.7 Georgia,serif;box-sizing:border-box;overflow:hidden");
			d.textContent = (n === 1 ? r.title + " — " : "") + "Fictional page " + n + ". " + "Lorem ipsum repair-stage cell states across regenerating tissue. ".repeat(14); return d; };
		let current = null;
		ctx.ZotPoPPreview = Object.assign({}, ctx.ZotPoPPreview, { createViewer: opts => {
			const viewer = { page: 1, pageCount: 12, async showRecord(r) { current = r; viewer.page = 1; opts.onState({ status: "ready", canvas: sheet(r, 1), page: 1, pageCount: 12, title: r.title, originalURL: "https://doi.org/" + r.doi }); },
				async goTo(n) { viewer.page = Math.max(1, Math.min(12, n)); opts.onState({ status: "ready", canvas: sheet(current, viewer.page), page: viewer.page, pageCount: 12, title: current.title, originalURL: "https://doi.org/" + current.doi }); },
				retry() {}, close() {} };
			return viewer; } });
		document.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "p" }));
		await wait(60);
		const pdf = () => ({ shown: !document.getElementById("d-pdfview").hidden, page: text("dp-page"), pressed: document.getElementById("preview-btn").getAttribute("aria-pressed"), attr: document.getElementById("detail").hasAttribute("data-preview"), canvases: document.querySelectorAll("#dp-canvas > *").length });
		trace.pdf = { open: pdf() };
		fire(document.getElementById("dp-next")); fire(document.getElementById("dp-next"));
		await wait(20);
		trace.pdf.turned = pdf();
		var pdfPage = page();
		document.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "p" }));
		await wait(20);
		trace.pdf.closed = pdf();
		trace.pdf.dialogs = dialogs;
		trace.pdf.focus = [...rowOf("demo1").classList].includes("focused") || true;
	}
	// ---- the filter builder: a popover with rules, chips under the toolbar, the quick syntax of the box
	const pop = () => document.getElementById("filter-pop");
	const chipTexts = () => [...document.querySelectorAll("#filter-chips .fchip")].map(c => c.textContent.replace(/\s+/g, " ").trim());
	const key = (el, k, extra = {}) => { const e = new window.Event("keydown", { bubbles: true, cancelable: true }); Object.assign(e, { key: k }, extra); el.dispatchEvent(e); return e; };
	const addRule = async kind => { fire(pop().querySelector(`[data-fid="add:${kind}"]`)); await wait(5); return [...pop().querySelectorAll(".fp-rule")].at(-1).getAttribute("data-rule"); };
	const pick = (id, value) => { const cb = pop().querySelector(`[data-fid="opt:${id}:${value}"]`); cb.checked = true; fire(cb, "change"); };
	const setMode = (id, m) => fire(pop().querySelector(`[data-fid="mode:${id}:${m}"]`));
	const setRange = async (id, which, v) => { const input = pop().querySelector(`[data-fid="rule:${id}:${which === "min" ? "first" : "max"}"]`); input.value = v; fire(input, "input"); await wait(300); };
	const optionTexts = () => [...pop().querySelectorAll(".fp-opt")].map(o => o.textContent.replace(/\s+/g, " ").trim());
	trace.filters = { before: shown().length };
	const filterBox = document.getElementById("filter");
	filterBox.value = "journal:Cell -author:Kim"; fire(filterBox, "input"); await wait(200);
	trace.filters.quick = { rows: shown().map(Number).sort((a, b) => a - b) };
	filterBox.value = "\"cell-state transitions\" -commentary"; fire(filterBox, "input"); await wait(200);
	trace.filters.phrase = { rows: shown().map(Number).sort((a, b) => a - b) };
	filterBox.value = "-commentary"; fire(filterBox, "input"); await wait(200);
	trace.filters.negation = shown().length;
	fire(document.getElementById("filter-btn"));
	trace.filters.opened = { hidden: pop().hidden, expanded: document.getElementById("filter-btn").getAttribute("aria-expanded"), title: pop().querySelector("h3")?.textContent, kinds: pop().querySelectorAll(".fp-kinds .fp-chip").length };
	const rJournal = await addRule("journal");
	trace.filters.journalOptions = optionTexts().slice(0, 4);
	setMode(rJournal, "exclude");
	pick(rJournal, "biorxiv"); pick(rJournal, "medrxiv");
	trace.filters.excludeJournal = { rows: shown().length, chips: chipTexts() };
	const rAuthor = await addRule("author");
	pick(rAuthor, "name:jenna dowd"); pick(rAuthor, "name:sora lee");
	trace.filters.author = { rows: shown().map(Number).sort((a, b) => a - b), chips: chipTexts() };
	const rYear = await addRule("year");
	await setRange(rYear, "min", "2024");
	trace.filters.year = { rows: shown().map(Number).sort((a, b) => a - b), chips: chipTexts() };
	// the author rule open: every author still on offer, with what picking one leaves
	fire(pop().querySelector(`[data-fid="rule:${rAuthor}:toggle"]`));
	trace.filters.authorOptions = optionTexts().slice(0, 6);
	trace.filters.shownLine = pop().querySelector(".fp-shown")?.textContent;
	trace.filters.metrics = { papers: text("m-papers"), bars: document.querySelectorAll("#metrics-years .yr-bar").length, lib: libLine() };
	// Hung under the Filter button the way positionFilterPop does in a real window (no layout here to measure).
		Object.assign(pop().style, { top: "154px", left: "clamp(483px, calc(100vw - 902px), 538px)", width: "528px", maxHeight: "calc(100vh - 224px)" });
	const filtersPage = page();
	// keyboard: Escape closes, and the chips stay
	key(pop(), "Escape");
	trace.filters.escape = { hidden: pop().hidden, expanded: document.getElementById("filter-btn").getAttribute("aria-expanded"), chips: chipTexts().length };
	// a chip opens its rule again; its x lets one go
	fire(document.querySelector("#filter-chips .fchip-main"));
	trace.filters.chipEdit = { open: !pop().hidden, editors: pop().querySelectorAll(".fp-edit").length };
	key(pop(), "Escape");
	const sizeBefore = shown().length;
	fire(document.querySelector("#filter-chips .fchip .filter-clear"));
	trace.filters.chipRemove = { chips: chipTexts().length, rowsBefore: sizeBefore, rows: shown().length };
	fire(document.querySelector("#filter-chips .fchip-clear"));
	trace.filters.cleared = { rows: shown().length, chips: chipTexts().length };
	filterBox.value = ""; fire(filterBox, "input"); await wait(200);
	// institutions: the table's second line, the detail's authors with an index into the institutions, a click filters
	fire(rowOf("demo1"));
	await wait(20);
	trace.affiliations = { cells: [...document.querySelectorAll("#results-body td.aff")].map(td => td.textContent.replace(/\s+/g, "")), tips: [...document.querySelectorAll("#results-body td.aff")].map(td => td.title), line: [...document.querySelectorAll("#results-body tr")].map(tr => tr.querySelector(".t-aff")?.textContent || ""), rowAttr: document.getElementById("results-table").hasAttribute("data-aff"),
		detail: text("d-authors").replace(/\s+/g, " ").trim(), instButtons: [...document.querySelectorAll("#d-authors .au-inst-btn")].map(b => b.textContent) };
	fire(document.querySelector("#d-authors .au-inst-btn"));
	await wait(20);
	trace.affiliations.filtered = { rows: shown().map(Number).sort((a, b) => a - b), chips: chipTexts() };
	fire(document.querySelector("#filter-chips .fchip-clear"));
	await wait(20);
	// ---- the author tab: a profile lookup, then that profile's papers (stubbed lookups; fictional people)
	const dowd = recs.filter(r => r.authorString.startsWith("Jenna Dowd"));
	const realAuthors = { searchProfiles: ctx.ZotPoPAuthors.searchProfiles, loadPublications: ctx.ZotPoPAuthors.loadPublications, loadNamePublications: ctx.ZotPoPAuthors.loadNamePublications };
	const profiles = [
		{ provider: "scholar", id: "DEMOxAUTHOR1", name: "Jenna Dowd", affiliation: "Example Institute of Genome Engineering", url: "https://scholar.google.com/citations?user=DEMOxAUTHOR1", mode: "profile", identityConfirmed: true },
		{ provider: "scholar", id: "DEMOxAUTHOR2", name: "Jenna M. Dowd", affiliation: "Fictional University, Dept. of Biology", url: "https://scholar.google.com/citations?user=DEMOxAUTHOR2", mode: "profile", identityConfirmed: false }
	];
	ctx.ZotPoPAuthors.searchProfiles = async () => profiles;
	ctx.ZotPoPAuthors.loadPublications = async profile => Object.assign(dowd.slice(), { authorProfile: profile });
	fire(document.getElementById("mode-authors"));
	await wait(30);
	{ const provider = document.getElementById("author-provider"); provider.value = "scholar"; fire(provider, "change"); await wait(30); }
	document.getElementById("author-input").value = "Jenna Dowd";
	fire(document.getElementById("author-form"), "submit");
	for (let i = 0; i < 100 && !document.querySelector("#author-profiles .author-profile"); i++) await wait(20);
	await wait(40);
	const authorsLookup = page();
	fire(document.querySelector("#author-profiles .author-profile button"));
	for (let i = 0; i < 100 && !table().length; i++) await wait(20);
	await wait(80);
	fire(table()[0]);
	await wait(30);
	trace.authors = { rows: table().length, profiles: document.querySelectorAll("#author-profiles .author-profile").length, formHidden: document.getElementById("author-panel").hidden, paperFormHidden: document.getElementById("query-form").hidden };
	const authorsPage = page();
	// ---- a name search with namesakes: the figures wait for a person (stubbed Scholar answer; fictional people)
	const paper_ = (n, names, venue, year, cites) => Sources.makeRecord({ source: "scholar", sourceId: "namesake" + n, title: ["Delivery of compact editors", "Tissue barriers and cargo size", "Editor off-target maps", "Spin transport in thin films", "Magnetic anisotropy at interfaces", "Soil fungi and carbon cycling"][n - 1],
		authors: names.map(x => { const q = x.split(" "); return { name: x, firstName: q.slice(0, -1).join(" "), lastName: q.at(-1) }; }), year, venue, citations: cites, doi: "10.5555/namesake." + n, itemType: "journalArticle" });
	const namesakes = [paper_(1, ["JA Dowd", "S Sternfield", "P Natarajan"], "Nature Biotechnology", 2024, 88), paper_(2, ["Jenna A Dowd", "S Sternfield"], "Nature Biotechnology", 2022, 41), paper_(3, ["J Dowd", "P Natarajan", "B Oakley"], "Genome Biology", 2023, 17),
		paper_(4, ["J Dowd", "Q Zhu", "W Tan"], "Physical Review B", 2008, 52), paper_(5, ["Dowd J", "Q Zhu"], "Physical Review B", 2011, 33), paper_(6, ["JK Dowd", "L Moreno"], "Soil Biology and Biochemistry", 2016, 9)];
	ctx.ZotPoPAuthors.loadNamePublications = async (name, options, _http, _ctx, provider) => {
		const profile = { provider, id: null, name, affiliation: "", url: "", mode: "name-search", identityConfirmed: false };
		return Object.assign(namesakes.map(r => ({ ...r, authorProfile: profile })), { authorProfile: profile, partial: false });
	};
	{
		const input = document.getElementById("author-input");
		input.value = "Jenna A Dowd"; fire(input, "input");
		fire(document.getElementById("author-name-btn"));
		for (let i = 0; i < 100 && table().length < 6; i++) await wait(20);
		await wait(60);
		trace.pick = { rows: table().length, hint: text("metrics-hint"), tableHidden: document.getElementById("metrics-table").hidden, cards: [...document.querySelectorAll("#metrics-person .pp-card")].map(c => c.textContent.replace(/\s+/g, " ").trim()) };
	}
	const authorsPick = page();
	{
		fire(document.querySelector("#metrics-person .pp-card")); fire(document.querySelector("#metrics-person .pp-confirm"));
		await wait(60);
		trace.pick.chosen = { rows: table().length, chip: document.getElementById("person-chip").hidden ? "" : text("person-text"), papers: text("m-papers"), title: document.querySelector("#metrics h3").textContent, owner: text("metrics-person").replace(/\s+/g, " ").trim() };
		fire(document.getElementById("person-clear")); await wait(30);
	}
	// ---- the same tab with ORCID: a name finds people (real authors.js; only the answers are fictional), one pick lists their papers
	ctx.ZotPoPAuthors.searchProfiles = realAuthors.searchProfiles; ctx.ZotPoPAuthors.loadPublications = realAuthors.loadPublications;
	orcidWorksJSON = dowd.map((r, i) => ({ id: "https://openalex.org/W9" + String(i).padStart(3, "0"), doi: "https://doi.org/" + r.doi, title: r.title, publication_year: r.year, publication_date: r.year + "-06-01", type: "article",
		cited_by_count: r.citations, counts_by_year: [{ year: 2025, cited_by_count: Math.round(r.citations * 0.6) }], biblio: {},
		authorships: r.authors.map((a, n) => ({ author: { display_name: a.name, id: a.name === "Jenna Dowd" ? "https://openalex.org/A212" : undefined, orcid: a.name === "Jenna Dowd" ? "https://orcid.org/" + ORCID_IDS.main : null }, author_position: n === 0 ? "first" : "last",
			institutions: [{ display_name: "Aurora Medical Institute", country_code: "CA" }] })),
		primary_location: { source: { id: "https://openalex.org/S9" + i, display_name: r.venue } } })).concat([{ id: "https://openalex.org/W9100", doi: "https://doi.org/10.5555/dowd.old", title: "Delivery of compact editors: an early look", publication_year: 2019, publication_date: "2019-02-01", type: "article", cited_by_count: 340, counts_by_year: [], biblio: {},
		authorships: [{ author: { display_name: "Jenna Dowd", id: "https://openalex.org/A212", orcid: "https://orcid.org/" + ORCID_IDS.main }, author_position: "first", institutions: [{ display_name: "Example Institute of Genome Engineering", country_code: "GB" }] }], primary_location: { source: { display_name: "Genome Research" } } }]);
	const select = document.getElementById("author-provider"); select.value = "orcid"; fire(select, "change");
	await wait(30);
	document.getElementById("author-input").value = "Jenna Dowd";
	fire(document.getElementById("author-form"), "submit");
	for (let i = 0; i < 100 && !document.querySelector("#author-profiles .author-profile"); i++) await wait(20);
	await wait(40);
	const orcidCards = () => [...document.querySelectorAll("#author-profiles .author-profile")];
	trace.orcid = { cards: orcidCards().length, names: orcidCards().map(c => c.querySelector(".author-profile-name").textContent), more: document.querySelector("#author-profiles .author-more")?.textContent || "",
		firstStats: [...orcidCards()[0].querySelectorAll(".author-profile-stats .badge")].map(b => b.textContent.replace(/\s+/g, " ")), status: text("status"), requestsBeforePick: stubbed.orcid.length + stubbed.orcidAlex.length };
	const orcidLookup = page();
	fire(orcidCards()[0].querySelector(".author-sum-toggle"));
	for (let i = 0; i < 100 && !document.querySelector("#author-profiles .author-summary .author-bio"); i++) await wait(20);
	await wait(40);
	trace.orcid.summary = { text: document.querySelector("#author-profiles .author-summary")?.textContent.replace(/\s+/g, " ").trim() || "", jobs: document.querySelectorAll("#author-profiles .author-summary .author-sum-row").length,
		more: [...document.querySelectorAll("#author-profiles .author-sum-more")].map(n => n.textContent), chips: document.querySelectorAll("#author-profiles .author-sum-chips .badge").length, clamped: Boolean(document.querySelector("#author-profiles .author-bio.clamped")) };
	fire(orcidCards()[0].querySelector(".author-linkedin")); await wait(30);
	trace.orcid.linkedin = launched.slice(); trace.orcid.linkedinTip = orcidCards()[0].querySelector(".author-linkedin").getAttribute("data-tip") || "";
	const orcidSummary = page();
	fire(orcidCards()[0].querySelector("button.author-load"));
	for (let i = 0; i < 150 && !table().length; i++) await wait(20);
	await wait(100);
	trace.orcid.rows = table().length; trace.orcid.statusAfter = text("status"); trace.orcid.banner = text("banner-text"); trace.orcid.sort = document.querySelector("#results-table th[aria-sort]")?.textContent.trim() || "";
	trace.orcid.firstYears = table().slice(0, 3).map(r => r.querySelector('td[data-k="year"]')?.textContent || "");
	trace.orcid.requests = { orcid: stubbed.orcid.length, alex: stubbed.orcidAlex.length };
	const orcidWorks = page();
	// ---- the combined provider: one OpenAlex search and one ORCID search, merged cards (stubbed; fictional people)
	{
		const before = stubbed.orcid.length + stubbed.orcidAlex.length;
		select.value = "combined"; fire(select, "change"); await wait(30);
		document.getElementById("author-input").value = "Jenna Dowd";
		fire(document.getElementById("author-form"), "submit");
		for (let i = 0; i < 100 && !document.querySelector("#author-profiles .author-profile"); i++) await wait(20);
		await wait(60);
		const cards = () => [...document.querySelectorAll("#author-profiles .author-profile")];
		trace.combined = { cards: cards().length, names: cards().map(c => c.querySelector(".author-profile-name").textContent), badges: cards().map(c => [...c.querySelectorAll(".author-profile-head .badge")].map(b => b.textContent)),
			more: document.querySelector("#author-profiles .author-more")?.textContent || "", requests: stubbed.orcid.length + stubbed.orcidAlex.length - before, kindHidden: document.getElementById("author-input-kind-field").hidden,
			label: text("author-input-label"), placeholder: document.getElementById("author-input").placeholder, firstMeta: [...cards()[0].querySelectorAll(".author-profile-meta")].map(n => n.textContent), firstStats: [...cards()[0].querySelectorAll(".author-profile-stats .badge")].map(b => b.textContent) };
		trace.combinedPage = page();
		fire(cards()[0].querySelector("button.author-load"));
		for (let i = 0; i < 150 && !table().length; i++) await wait(20);
		await wait(100);
		trace.combined.rows = table().length; trace.combined.status = text("status"); trace.combined.title = document.querySelector("#metrics h3").textContent;
	}
	select.value = "scholar"; fire(select, "change"); await wait(30);
	fire(document.getElementById("mode-papers"));
	await wait(40);
	// the paper form folds once there are results, and the summary names the conditions
	trace.fold = { collapsed: document.getElementById("query-form").classList.contains("collapsed"), summary: text("cond-summary"), expanded: document.getElementById("cond-toggle").getAttribute("aria-expanded") };
	fire(document.getElementById("cond-toggle"));
	trace.fold.afterClick = { collapsed: document.getElementById("query-form").classList.contains("collapsed"), expanded: document.getElementById("cond-toggle").getAttribute("aria-expanded") };
	const unfolded = page();
	// ---- the journal box: suggestions as you type, picked journals as chips, the search covers any of them
	const venue = document.getElementById("venue");
	const typeVenue = async v => { venue.value = v; fire(venue, "input"); await wait(40); };
	const options = () => [...document.querySelectorAll("#venue-list .jopt")].map(o => o.textContent.replace(/\s+/g, " ").trim());
	trace.journals = {};
	await typeVenue("nat meth");
	trace.journals.natMethods = options();
	key(venue, "ArrowDown"); key(venue, "Enter");
	await typeVenue("PNAS"); trace.journals.pnas = options().slice(0, 3);
	key(venue, "ArrowDown"); key(venue, "Enter");
	await typeVenue("nar"); trace.journals.nar = options().slice(0, 3);
	key(venue, "ArrowDown"); key(venue, "Enter");
	trace.journals.chips = [...document.querySelectorAll("#venue-chips .jchip")].map(c => c.getAttribute("data-tip"));
	await typeVenue("proc natl acad");
	trace.journals.typed = { listOpen: !document.getElementById("venue-list").hidden, expanded: venue.getAttribute("aria-expanded"), options: options().slice(0, 4) };
	key(venue, "ArrowDown");
	trace.journals.active = document.querySelector("#venue-list .jopt.hot")?.textContent.replace(/\s+/g, " ").trim();
	const journalsPage = page();
	key(venue, "Escape");
	trace.journals.escape = { hidden: document.getElementById("venue-list").hidden, chips: document.querySelectorAll("#venue-chips .jchip").length };
	venue.value = "";
	fire(document.getElementById("query-form"), "submit");
	await wait(100);
	trace.journals.query = { venue: lastQuery.venue, venues: (lastQuery.venues || []).map(v => v.name), issnCounts: (lastQuery.venues || []).map(v => v.issns.length) };
	for (const b of [...document.querySelectorAll("#venue-chips .filter-clear")].reverse()) fire(b);
	trace.journals.afterRemove = document.querySelectorAll("#venue-chips .jchip").length;
	// ---- a long span of years: binned, flush to a baseline, labelled at both ends
	override = longSpan(Sources);
	fire(document.getElementById("query-form"), "submit");
	for (let i = 0; i < 100 && shown().length < 50; i++) await wait(20);
	await wait(80);
	const bars = [...document.querySelectorAll("#metrics-years .yr-bar")];
	trace.longSpan = { rows: shown().length, bars: bars.length, ends: [...document.querySelectorAll("#metrics-years .yr-ends span")].map(e => e.textContent), first: bars[0]?.getAttribute("data-tip"), last: bars.at(-1)?.getAttribute("data-tip"),
		basis: document.querySelectorAll("#metrics-basis button").length };
	fire(bars[3], "mousedown");
	await wait(20);
	trace.longSpan.selected = { rows: shown().length, range: document.querySelector("#metrics-years .yr-clear")?.textContent, title: [...document.querySelectorAll("#metrics-years .yr-bar")][3].getAttribute("data-tip") };
	fire(document.querySelector("#metrics-years .yr-clear"));
	await wait(20);
	const longSpanPage = page();
	fire(document.getElementById("cond-toggle"));

	// ---- the citation trend card and a translated abstract, on one older paper with ten years of history
	const old = OLD_PAPER, oldRecord = Sources.makeRecord({ source: "openalex", sourceId: old.sourceId, title: old.title, year: old.year, venue: old.venue, citations: old.citations, doi: old.doi,
		authors: [{ name: "Mina Kim", firstName: "Mina", lastName: "Kim" }, { name: "Alex Rivera", firstName: "Alex", lastName: "Rivera" }], authorString: "Mina Kim, Alex Rivera",
		abstract: old.abstract, itemType: "journalArticle", citesByYear: fromPairs(old.byYear), journalIF: null, journalOA2y: 8.2, journalH: 49 });
	override = [oldRecord, ...recs.slice(0, 8)];
	freshWork = { id: "https://openalex.org/W14", cited_by_count: old.fresh.citations, counts_by_year: old.fresh.byYear.map(([year, n]) => ({ year, cited_by_count: n })) };
	document.getElementById("keywords").value = "tissue repair kinetics";
	fire(document.getElementById("query-form"), "submit");
	for (let i = 0; i < 100 && !rowOf("demo14"); i++) await wait(20);
	await wait(80);
	trace.cite = { rows: shown().length, mark: rowOf("demo14").querySelector("td[data-k=citations] .cite-mark")?.textContent, cellTip: rowOf("demo14").querySelector("td[data-k=citations]").getAttribute("data-tip"),
		metricsTrend: document.getElementById("metrics-trend").hidden ? "" : document.getElementById("metrics-trend").textContent.replace(/\s+/g, " ").trim(),
		marks: table().map(tr => tr.querySelector("td[data-k=citations] .cite-mark")?.textContent || "") };
	// Positions the fixed card would get in a real window (linkedom has no layout): the cell's, and the card's own size.
	const proto = window.HTMLElement.prototype, realRect = proto.getBoundingClientRect;
	proto.getBoundingClientRect = function () {
		const box = (left, top, w, h) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h });
		if (this.classList?.contains("cite-pop")) return box(0, 0, 440, 430);
		if (this.dataset?.k === "citations") return box(1053, 191, 68, 48);
		return box(0, 0, 100, 30);
	};
	fire(rowOf("demo14").querySelector("td[data-k=citations]"));
	for (let i = 0; i < 100 && !document.querySelector(".cite-pop .cite-delta"); i++) await wait(20);
	await wait(40);
	const citeCard = () => document.querySelector(".cite-pop");
	trace.cite.pop = { text: citeCard()?.textContent.replace(/\s+/g, " ").trim(), bars: citeCard()?.querySelectorAll(".tr-col").length, peak: citeCard()?.querySelector(".tr-col.peak .tr-y")?.textContent, role: citeCard()?.getAttribute("role"),
		count: citeCard()?.querySelector(".cite-n")?.textContent, delta: citeCard()?.querySelector(".cite-delta")?.textContent, requests: stubbed.openalex.length, detailStrip: document.getElementById("d-cite").textContent.replace(/\s+/g, " ").trim() };
	document.getElementById("detail").style.cssText = "--detail-max: 400px";
	const citePage = page();
	document.getElementById("detail").style.cssText = "";
	// a second click on the same figure, and Escape, close it; a second open within hours asks nobody (cached)
	document.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" }));
	trace.cite.closedByEscape = !citeCard();
	fire(rowOf("demo14").querySelector("td[data-k=citations]"));
	await wait(60);
	trace.cite.requestsAfterReopen = stubbed.openalex.length;
	document.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" }));
	proto.getBoundingClientRect = realRect;

	// translated abstract: the language chosen from the in-page menu, then the real handler; the original stays, with the service named
	fire(rowOf("demo14"));
	await wait(20);
	fire(document.getElementById("d-tr-lang"));
	const langItem = [...document.querySelectorAll("#tbmenu .selopt")].find(e => e.textContent === "한국어");
	trace.translate = { langItems: [...document.querySelectorAll("#tbmenu .selopt")].map(e => e.textContent), before: document.getElementById("d-tr-run-label").textContent };
	fire(langItem);
	const titleBox = document.getElementById("d-tr-title"); titleBox.checked = true; fire(titleBox, "change");
	fire(document.getElementById("d-tr-run"));
	for (let i = 0; i < 100 && document.getElementById("d-tr-out").hidden; i++) await wait(20);
	await wait(60);
	const out = () => ({ via: text("d-tr-via"), body: text("d-tr-text"), title: text("d-tr-title-out"), original: text("d-abstract"), originalHidden: document.getElementById("d-abstract").hidden, calls: stubbed.translate.length, shown: !document.getElementById("d-tr-out").hidden });
	trace.translate.done = out();
	trace.translate.call = stubbed.translate[0];
	// a taller pane, as a reader would drag it, so the abstract and its translation are both in view
	document.getElementById("detail").style.cssText = "--detail-max: 560px";
	const translatedPage = page();
	document.getElementById("detail").style.cssText = "";
	// again: "Translate again" asks anew (the abstract and the title, one call each); the original folds away and comes back
	fire(document.getElementById("d-tr-run"));
	await wait(40);
	trace.translate.again = { calls: stubbed.translate.length };
	fire(document.getElementById("d-tr-orig"));
	trace.translate.folded = { originalHidden: document.getElementById("d-abstract").hidden, label: text("d-tr-orig") };
	fire(document.getElementById("d-tr-orig"));
	trace.translate.unfolded = { originalHidden: document.getElementById("d-abstract").hidden, label: text("d-tr-orig") };
	// the add option "keep translated abstract as a note": the translated demo14 abstract travels with the import, others do not
	{
		const box = document.getElementById("opt-trnote"); box.checked = true; fire(box, "change");
		for (const tr of table()) { const c = tr.querySelector("input"); if (c.checked) { c.checked = false; fire(c, "change"); } }
		const c14 = rowOf("demo14").querySelector("input"), c2 = rowOf("demo2").querySelector("input"); c14.checked = true; fire(c14, "change"); c2.checked = true; fire(c2, "change");
		importCalls.length = 0; importNotes.clear();
		fire(document.getElementById("import-btn"));
		for (let i = 0; i < 100 && importCalls.length < 2; i++) await wait(20);
		await wait(40);
		var translateNote = { withTranslation: importNotes.get([...importNotes.keys()].find(k => k.endsWith("demo14"))) || null, without: (k => k ? importNotes.get(k) : "missing")([...importNotes.keys()].find(k => k.endsWith("demo2"))) };
		box.checked = false; fire(box, "change");
	}
	// no service installed: a plain message that says what to do
	const installed = ctx.Zotero.PDFTranslate; delete ctx.Zotero.PDFTranslate;
	fire(rowOf("demo1"));
	await wait(20);
	fire(document.getElementById("d-tr-run"));
	for (let i = 0; i < 50 && !text("d-tr-note"); i++) await wait(20);
	trace.translate.none = { note: text("d-tr-note"), err: document.getElementById("d-tr-note").className };
	ctx.Zotero.PDFTranslate = installed;
	trace.signals = signals;
	trace.translateNote = translateNote;
	return { pinsMenuPage, pinResultsPage, pdfPage, retractedPage, signalsPage, tipTitle, tipAff, tipJournal, tipAuthors, tipCases, results, detail, facet, importPage, historyPage, rerun, authorsLookup, authorsPage, authorsPick, combinedPage: trace.combinedPage, orcidLookup, orcidSummary, orcidWorks, unfolded, filtersPage, journalsPage, longSpanPage, citePage, translatedPage, trace, rows: rows.length, netCalls, stubbed, errors };
}

export function checkPreview(out) {
	const problems = [];
	if (out.rows < 10) problems.push("expected at least 10 result rows, got " + out.rows);
	if (out.netCalls) problems.push("network was called");
	for (const [name, html] of [["results", out.results], ["detail", out.detail], ["facet", out.facet], ["import", out.importPage], ["history", out.historyPage], ["rerun", out.rerun], ["authors", out.authorsPage], ["authors-lookup", out.authorsLookup], ["authors-pick", out.authorsPick], ["authors-combined", out.combinedPage], ["orcid", out.orcidLookup], ["orcid-summary", out.orcidSummary], ["orcid-works", out.orcidWorks], ["unfolded", out.unfolded], ["filters", out.filtersPage], ["journals", out.journalsPage], ["longspan", out.longSpanPage], ["cite", out.citePage], ["translate", out.translatedPage], ["signals", out.signalsPage], ["retracted", out.retractedPage]]) {
		if (/<script\b|<link\b/i.test(html)) problems.push(name + ": script or link tag present");
		if (/(?:src|href)\s*=\s*["'](?:https?:|\/\/|chrome:|resource:)/i.test(html)) problems.push(name + ": external asset");
		if (/url\(\s*["']?(?:https?:|\/\/|chrome:)/i.test(html)) problems.push(name + ": external css url");
		if (["history", "rerun", "unfolded", "filters", "journals", "longspan", "cite", "translate", "signals", "retracted"].includes(name) || name.startsWith("authors") || name.startsWith("orcid")) { if (!html.includes('id="results-table"')) problems.push(name + ": no table"); continue; }
		for (const needle of ['id="results-table"', 'id="results-body"', 'id="query-form"', name === "facet" ? "Off-target profiling" : "Mapping cellular responses"]) if (!html.includes(needle)) problems.push(name + ": missing " + needle);
	}
	if (!out.results.includes('class="in-library')) problems.push("no in-library row");
	{
		const c = out.trace.cite, tr = out.trace.translate;
		if (out.stubbed.openalex.length !== 1 || c.pop.requests !== 1 || c.requestsAfterReopen !== 1) problems.push("opening the citation card should make one OpenAlex request and the second open none; got " + JSON.stringify([out.stubbed.openalex.length, c.pop.requests, c.requestsAfterReopen]));
		if (!/▼/.test(c.mark || "") || !c.marks.some(m => m === "▲") || !/▲|▼/.test(out.results)) problems.push("the table should carry a trend mark; got " + JSON.stringify(c.marks));
		if (!c.pop.text || c.pop.bars !== 9 || c.pop.peak !== "2021" || c.pop.role !== "dialog" || c.pop.count !== "645") problems.push("the citation card should show nine years, the peak in 2021 and the fresh 645; got " + JSON.stringify(c.pop));
		if (!/\+34/.test(c.pop.delta || "") || !/→/.test(c.pop.delta || "")) problems.push("the card should say +34 since the last look; got " + c.pop.delta);
		if (!c.closedByEscape) problems.push("Escape should close the citation card");
		if (!c.metricsTrend) problems.push("the side card should chart the whole result set's citations per year");
		if (out.stubbed.translate.length !== 4 || tr.again.calls !== 4) problems.push("translation should make one call for the abstract and one for the title, and Translate again one more each; got " + out.stubbed.translate.length + "/" + tr.again.calls);
		if (tr.call.langto !== "ko-KR" || !tr.call.hasPluginID || tr.call.keys.join() !== "langto,pluginID") problems.push("Translate for Zotero should be called with langto and pluginID only; got " + JSON.stringify(tr.call));
		if (!/DeepL Free/.test(tr.done.via) || !/한국어/.test(tr.done.via) || !/가상 초록/.test(tr.done.body) || !tr.done.title || tr.done.originalHidden || !/Fictional abstract/.test(tr.done.original)) problems.push("the translation should sit under the original with the service named; got " + JSON.stringify(tr.done));
		if (!tr.folded.originalHidden || tr.unfolded.originalHidden) problems.push("the original should fold and unfold");
		if (!/Translate for Zotero|번역 서비스가 설정/.test(tr.none.note) || !/err/.test(tr.none.err)) problems.push("with no service the card should say how to set one up; got " + JSON.stringify(tr.none));
		for (const [name, html] of [["cite", out.citePage]]) if (!/class="tip-card cite-pop show"/.test(html)) problems.push(name + ": no open citation card");
		if (!/class="d-tr-out"(?![^>]*hidden)/.test(out.translatedPage)) problems.push("translate: no translation shown");
	}
	for (const name of ["tipTitle", "tipAff", "tipJournal", "tipAuthors"]) if (!/class="tip-card show"/.test(out[name])) problems.push(name + ": no open hover card");
	if (!/tip-title/.test(out.tipTitle) || !/tip-where/.test(out.tipTitle) || !/tier-t/.test(out.tipAff)) problems.push("the hover cards should carry title, institutions and a tier chip");
	for (const kind of ["title", "aff", "journal", "authors"]) if (!out.tipCases[kind] || out.tipCases[kind].titleAttr || out.tipCases[kind].describedby !== "tip-card") problems.push("hover card " + kind + ": native title left behind or no aria-describedby");
	if (!/id="detail-body"(?![^>]*hidden)/.test(out.detail)) problems.push("detail pane not shown for the selected row");
	const t = out.trace, same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
	if (t.columns.basic !== "basic" || t.columns.all !== "all" || t.columns.back !== "basic") problems.push("column view did not switch basic/all/basic");
	if (t.columns.statusAttr) problems.push("status column shown before any status");
	if (!t.menu.open || t.menu.expanded !== "true" || t.menu.labels.length !== 8 || !same(t.menu.roles, ["menuitemradio", "menuitemradio", "menuitemcheckbox", "menuitemcheckbox", "menuitemcheckbox", "menuitemradio", "menuitemradio", "menuitemradio"])) problems.push("the View menu should open with two radio items, three checkable items and the three languages; got " + JSON.stringify(t.menu));
	if (!t.menu.closed || !t.menu.closedByOutsideClick) problems.push("a menu should close after a choice and on an outside click");
	if (!same(t.menu.reopened, ["false", "true", "true", "true", "true", "true", "false", "false"])) problems.push("the reopened View menu should show Columns: all as chosen; got " + t.menu.reopened);
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
	if (!t.fold.collapsed || t.fold.expanded !== "false" || !t.fold.summary) problems.push("the paper form should fold after a search; got " + JSON.stringify(t.fold));
	if (t.fold.afterClick.collapsed || t.fold.afterClick.expanded !== "true") problems.push("the conditions toggle should unfold the form");
	{
		const c = t.combined || {}, k = t.pick || {};
		if (c.cards !== 4 || c.names?.[0] !== "Jenna A. Dowd" || !same(c.badges?.[0], ["OpenAlex", "ORCID"]) || !c.more) problems.push("the combined lookup should merge the OpenAlex and ORCID people into cards, best first, with the weak ones folded; got " + JSON.stringify([c.cards, c.names, c.badges, c.more]));
		if (c.requests !== 3 || c.kindHidden !== true || !/OpenAlex/.test(c.label || "")) problems.push("the combined lookup should cost one OpenAlex search, one ORCID search and one enrichment, and hide the Scholar input kind; got " + JSON.stringify([c.requests, c.kindHidden, c.label]));
		if (c.rows !== 5 || !/Jenna A\. Dowd/.test(c.title || "")) problems.push("picking a combined card should load the person's five papers and name them over the metrics; got " + JSON.stringify([c.rows, c.title]));
		if (k.rows !== 6 || !k.tableHidden || k.cards?.length !== 3 || k.chosen?.rows !== 3 || k.chosen?.papers !== "3") problems.push("a name search should show three picker cards, no numbers, then filter to the chosen person's three papers; got " + JSON.stringify(k));
	}
	{
		const o = t.orcid || {};
		if (out.netCalls || out.stubbed.orcid.length < 4) problems.push("the ORCID states should run on the stubbed ORCID answers only; got " + JSON.stringify([out.netCalls, out.stubbed.orcid.length]));
		if (o.cards !== 2 || !/Jenna A\. Dowd/.test(o.names?.[0] || "") || !o.more) problems.push("the ORCID lookup should show the two profiles with papers and fold the other two; got " + JSON.stringify([o.cards, o.names, o.more]));
		if (o.requestsBeforePick !== 2) problems.push("a name lookup should cost one ORCID search and one batched OpenAlex request; got " + o.requestsBeforePick);
		if (!(o.firstStats || []).some(x => /212/.test(x)) || !(o.firstStats || []).some(x => /54/.test(x))) problems.push("the first candidate should show its works and h-index; got " + JSON.stringify(o.firstStats));
		if (!o.summary?.jobs || !o.summary.more.length || o.summary.chips !== 4 || !o.summary.clamped) problems.push("the profile summary should list positions, a +n more, four keywords and a clamped biography; got " + JSON.stringify(o.summary));
		if (!same(o.linkedin, ["https://www.linkedin.com/in/jenna-dowd-example"])) problems.push("the LinkedIn button should open the profile ORCID lists; got " + JSON.stringify(o.linkedin));
		if (o.rows !== 5 || !/ORCID 0000-0001-1111-1118/.test(o.statusAfter || "") || !/Jenna A\. Dowd/.test(o.statusAfter || "")) problems.push("picking a profile should list its five papers with the person named in the status; got " + JSON.stringify([o.rows, o.statusAfter]));
		if (!same(o.firstYears, ["2026", "2025", "2025"])) problems.push("an ORCID person's papers should be newest first; got " + JSON.stringify(o.firstYears));
	}
	{
		const g = t.signals || {};
		if (g.hidden || !/(내 문헌 2편이 이 논문을 인용|2 of my papers cite this)/.test(g.text || "") || !/(이 논문이 내 문헌 2편을 인용|This cites 2 of my papers)/.test(g.text || "")) problems.push("the detail should say 1 of my papers cite it and it cites 2 of mine (LIBA/LIBC cite W9001, the reference list holds LIBA and LIBB); got " + g.text);
		if (!/(관심 저자 참여|Followed author): Jonas Park/.test(g.text || "")) problems.push("the followed author's chip is missing; got " + g.text);
		if (g.refRequests !== 1) problems.push("opening the detail should cost one referenced_works request; got " + g.refRequests);
		if (!same(g.list, ["Repair-stage markers in regenerating tissue", "Spatial cell-state methods compared"]) && !same(g.list, ["Repair-stage markers in regenerating tissue", "A field guide to atlas-scale sampling"])) problems.push("the count should open a list of library titles; got " + JSON.stringify(g.list));
		if (!g.buttons.length || !g.buttons.some(b => b[1] === "true") || !g.buttons.some(b => b[1] === "false")) problems.push("follow buttons should show both a followed and a not-yet-followed author; got " + JSON.stringify(g.buttons));
		if (!g.watch || g.watch.calls.length !== 1 || !/^A\d+$/.test(g.watch.calls[0].id) || !g.watch.calls[0].institution || !Array.isArray(g.watch.calls[0].seen) || g.watch.buttons.includes("false")) problems.push("following should call watchAuthor once with id, name, institution and seen, then show every button pressed; got " + JSON.stringify(g.watch));
		if (g.retractedRows !== 1 || !/^(철회|Retracted)$/.test(g.retractedRow || "") || !same(g.retractedDetail, [g.retractedRow])) problems.push("exactly the retracted paper should carry the chip, in the row and the detail; got " + JSON.stringify([g.retractedRows, g.retractedRow, g.retractedDetail]));
		const n = t.translateNote || {};
		if (!n.withTranslation || !/^(번역된 초록|Translated abstract) \(/.test(n.withTranslation.heading) || !n.withTranslation.text || n.without !== null) problems.push("the translated abstract should go with the import only for the paper translated here; got " + JSON.stringify(n));
	}
	if (t.authors.rows !== 4 || t.authors.profiles !== 2 || t.authors.formHidden || !t.authors.paperFormHidden) problems.push("the author tab should list two profiles and four papers; got " + JSON.stringify(t.authors));
	{
		const p = t.pins || {}, q = t.queue || {}, d = t.pdf || {};
		if (!p.actions?.length || !/(고정|Pin)/.test(p.actions[0])) problems.push("each recent search should offer a pin action; got " + JSON.stringify(p.actions));
		if (p.afterPin?.pinned?.length !== 1 || !/tissue repair/.test(p.afterPin.pinned[0]) || !p.afterPin.head.some(h => /(고정 검색|Pinned searches)/.test(h))) problems.push("a pinned search should lead the menu under its own heading; got " + JSON.stringify(p.afterPin));
		if (!/(새 결과 1|1 new)/.test(p.menu?.badge || "") || !p.menu.on || p.menu.actions.length !== 2) problems.push("the pin should say one new result and offer run again and unpin; got " + JSON.stringify(p.menu));
		if (p.opened?.searchesRun !== 0 || p.opened.net !== 0 || !same(p.opened.marked, ["15"]) || p.opened.rows !== 14) problems.push("opening a pin shows the stored result with only the unseen paper marked, no search run; got " + JSON.stringify(p.opened));
		if (!/(새 결과 없음|nothing new)/.test(p.afterLook || "")) problems.push("after a look the pin has nothing new; got " + p.afterLook);
		if (!q.shown || !/(추가하고 읽기 대기|Add and queue)/.test(q.label) || q.calls.length !== 1 || q.calls[0].source !== "zotpop" || !/(ZotPoP 검색|ZotPoP search): tissue repair/.test(q.calls[0].reason) || !q.optionVisible) problems.push("add and queue should add, then queue with the search as the reason; got " + JSON.stringify(q));
		if (!d.open.shown || !d.open.attr || d.open.pressed !== "true" || !/^1 \/ 12$/.test(d.open.page) || d.open.canvases !== 1) problems.push("P should open the PDF in the detail card on page 1 of 12; got " + JSON.stringify(d.open));
		if (!/^3 \/ 12$/.test(d.turned.page)) problems.push("the page buttons should turn pages; got " + JSON.stringify(d.turned));
		if (d.closed.shown || d.closed.attr || d.dialogs !== 0) problems.push("P again closes the preview and no window is ever opened; got " + JSON.stringify([d.closed, d.dialogs]));
		for (const [name, html] of [["pins", out.pinsMenuPage], ["pin-results", out.pinResultsPage], ["pdf", out.pdfPage]]) {
			if (/<script\b|<link\b/i.test(html)) problems.push(name + ": script or link tag present");
			if (!html.includes('id="results-table"')) problems.push(name + ": no table");
		}
	}
	return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const out = await buildPreview({ locale: process.env.PREVIEW_LOCALE || "en" });
	const problems = checkPreview(out);
	if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
	fs.mkdirSync(path.join(root, "docs"), { recursive: true });
	fs.writeFileSync(path.join(root, "docs/search-preview.html"), out.results);
	fs.writeFileSync(path.join(root, "docs/search-preview-detail.html"), out.detail);
	fs.writeFileSync(path.join(root, "docs/search-preview-tooltip.html"), out.tipTitle);
	fs.writeFileSync(path.join(root, "docs/search-preview-tooltip-aff.html"), out.tipAff);
	fs.writeFileSync(path.join(root, "docs/search-preview-tooltip-journal.html"), out.tipJournal);
	fs.writeFileSync(path.join(root, "docs/search-preview-tooltip-authors.html"), out.tipAuthors);
	fs.writeFileSync(path.join(root, "docs/search-preview-facet.html"), out.facet);
	fs.writeFileSync(path.join(root, "docs/search-preview-import.html"), out.importPage);
	fs.writeFileSync(path.join(root, "docs/search-preview-history.html"), out.historyPage);
	fs.writeFileSync(path.join(root, "docs/search-preview-rerun.html"), out.rerun);
	fs.writeFileSync(path.join(root, "docs/search-preview-unfolded.html"), out.unfolded);
	fs.writeFileSync(path.join(root, "docs/search-preview-authors.html"), out.authorsPage);
	fs.writeFileSync(path.join(root, "docs/search-preview-authors-lookup.html"), out.authorsLookup);
	fs.writeFileSync(path.join(root, "docs/search-preview-authors-pick.html"), out.authorsPick);
	fs.writeFileSync(path.join(root, "docs/search-preview-authors-combined.html"), out.combinedPage);
	fs.writeFileSync(path.join(root, "docs/search-preview-orcid.html"), out.orcidLookup);
	fs.writeFileSync(path.join(root, "docs/search-preview-orcid-summary.html"), out.orcidSummary);
	fs.writeFileSync(path.join(root, "docs/search-preview-orcid-works.html"), out.orcidWorks);
	fs.writeFileSync(path.join(root, "docs/search-preview-filters.html"), out.filtersPage);
	fs.writeFileSync(path.join(root, "docs/search-preview-journals.html"), out.journalsPage);
	fs.writeFileSync(path.join(root, "docs/search-preview-longspan.html"), out.longSpanPage);
	fs.writeFileSync(path.join(root, "docs/search-preview-cite.html"), out.citePage);
	fs.writeFileSync(path.join(root, "docs/search-preview-translate.html"), out.translatedPage);
	fs.writeFileSync(path.join(root, "docs/search-preview-signals.html"), out.signalsPage);
	fs.writeFileSync(path.join(root, "docs/search-preview-retracted.html"), out.retractedPage);
	fs.writeFileSync(path.join(root, "docs/search-preview-pins.html"), out.pinsMenuPage);
	fs.writeFileSync(path.join(root, "docs/search-preview-pin-results.html"), out.pinResultsPage);
	fs.writeFileSync(path.join(root, "docs/search-preview-pdf.html"), out.pdfPage);
	console.log(`ZotPoP search preview: real markup, CSS and ui.js, ${out.rows} fictional rows, no network: docs/search-preview.html, docs/search-preview-detail.html`);
	process.exit(0);
}

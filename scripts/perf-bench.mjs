// Performance and request-cost bench for the ZotPoP search window.
//
// Runs the real content/search.xhtml, content/ui.js and content/sources.js (and the
// real importer against a stub of Zotero's database) in linkedom, with every
// service answered from a fictional corpus in memory, and measures what a reader
// with a 1,200-paper library pays: startup, time to first row, render and re-render,
// filter and sort, the detail pane, memory over repeated searches, the held-paper
// lookup, and the requests a search sends (per source, duplicates, OpenAlex cost).
//
//   node --expose-gc scripts/perf-bench.mjs            -> a table on stdout
//   node --expose-gc scripts/perf-bench.mjs --json     -> the same as JSON
//
// Nothing here touches the network or Zotero. The corpus is made up (10.5555 is a test prefix).
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { parseHTML } from "linkedom";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- the fictional corpus
const JOURNALS = ["Nature", "Science", "Cell", "Nature Biotechnology", "Nucleic Acids Research", "Genome Biology", "eLife", "Cell Reports",
	"Nature Communications", "PLOS ONE", "Scientific Reports", "Molecular Cell", "Genome Research", "Nature Methods", "Proceedings of the National Academy of Sciences"];
for (let i = 0; i < 135; i++) JOURNALS.push("Fictional Journal of Genome Studies " + (i + 1));
const COUNTRIES = ["US", "GB", "KR", "DE", "JP", "CN", "CA", "FR", "NL", "CH"];
const INSTITUTIONS = Array.from({ length: 300 }, (_, i) => ({ id: "I" + (9000 + i), name: "Fictional Institute " + (i + 1), country: COUNTRIES[i % COUNTRIES.length], h: 100 + (i * 37) % 2400 }));
const WORDS = "genome editing guide cas nuclease delivery repair template off target base prime screen cell line mouse model therapy vector capsid".split(" ");
const U = 4200;
function work(i) {
	const authors = Array.from({ length: 3 + (i % 9) }, (_, k) => ({ id: "A" + (100000 + (i * 7 + k * 13) % 9000), name: ["Mina", "Alex", "Jonas", "Sora", "Lin", "Eva", "Hana", "Ren", "Kai"][k % 9] + " " + ["Kim", "Rivera", "Park", "Lee", "Chen", "Morgan", "Choi", "Ahn", "Oh"][(i + k) % 9] + (i % 50) }));
	const inst = k => INSTITUTIONS[(i * 3 + k * 11) % INSTITUTIONS.length];
	const year = 2000 + (i % 27);
	const preprint = i % 23 === 0;
	return {
		i, doi: preprint ? "10.48550/arxiv.2401." + String(10000 + i) : "10.5555/w" + i, year,
		title: "Genome editing " + WORDS[i % WORDS.length] + " " + WORDS[(i * 7) % WORDS.length] + " study " + i + " in " + WORDS[(i * 3) % WORDS.length] + " systems",
		authors, inst, venue: preprint ? "arXiv" : JOURNALS[i % JOURNALS.length], journalId: preprint ? "S4306400194" : "S" + (7000 + (i % JOURNALS.length)),
		citations: (i * 97) % 1500, abstract: Array.from({ length: 160 }, (_, k) => WORDS[(i + k * 5) % WORDS.length]).join(" "),
		byYear: Array.from({ length: Math.min(10, 2026 - year + 1) }, (_, k) => ({ year: 2026 - k, cited_by_count: (i + k * 3) % 40 })),
		preprint
	};
}
const UNIVERSE = Array.from({ length: U }, (_, i) => work(i));
// Each service ranks the corpus its own way; about two-thirds of what one finds the others find too.
const ORDER = {
	openalex: UNIVERSE.map(w => w.i),
	crossref: UNIVERSE.filter(w => !w.preprint).map(w => w.i).sort((a, b) => ((a * 31) % 997) - ((b * 31) % 997) || a - b),
	europepmc: UNIVERSE.filter(w => w.i % 3 !== 1).map(w => w.i).sort((a, b) => ((a * 17) % 761) - ((b * 17) % 761) || a - b),
	arxiv: UNIVERSE.filter(w => w.preprint || w.i % 7 === 0).map(w => w.i)
};

function openAlexWork(w) {
	const inverted = {};
	w.abstract.split(" ").forEach((word, k) => (inverted[word] ||= []).push(k));
	return {
		id: "https://openalex.org/W" + (5000000 + w.i), doi: "https://doi.org/" + w.doi, title: w.title, display_name: w.title, publication_year: w.year, publication_date: w.year + "-03-01",
		type: w.preprint ? "preprint" : "article", is_retracted: false, is_authors_truncated: false, cited_by_count: w.citations, counts_by_year: w.byYear,
		authorships: w.authors.map((a, k) => ({ author_position: k === 0 ? "first" : k === w.authors.length - 1 ? "last" : "middle", is_corresponding: k === w.authors.length - 1,
			author: { id: "https://openalex.org/" + a.id, display_name: a.name, orcid: null }, raw_author_name: a.name,
			institutions: [{ id: "https://openalex.org/" + w.inst(k).id, display_name: w.inst(k).name, country_code: w.inst(k).country }], countries: [w.inst(k).country] })),
		primary_location: { landing_page_url: "https://example.invalid/" + w.i, source: { id: "https://openalex.org/" + w.journalId, display_name: w.venue, issn_l: null, issn: [], host_organization_name: "Fictional Press" } },
		best_oa_location: w.i % 2 ? { pdf_url: "https://example.invalid/" + w.i + ".pdf" } : null, open_access: { oa_url: null }, locations: [],
		biblio: { volume: String(w.i % 40), issue: "2", first_page: "1", last_page: "12" }, ids: { pmid: w.i % 2 ? "https://pubmed.ncbi.nlm.nih.gov/" + (30000000 + w.i) : null },
		abstract_inverted_index: inverted
	};
}
function crossrefWork(w) {
	return { DOI: w.doi, title: [w.title], author: w.authors.map((a, k) => ({ given: a.name.split(" ")[0], family: a.name.split(" ")[1], sequence: k ? "additional" : "first", affiliation: [{ name: w.inst(k).name }] })),
		issued: { "date-parts": [[w.year, 3, 1]] }, "container-title": [w.venue], publisher: "Fictional Press", "is-referenced-by-count": w.citations + 3, type: "journal-article",
		volume: "1", issue: "2", page: "1-12", URL: "https://doi.org/" + w.doi, abstract: "<jats:p>" + w.abstract + "</jats:p>", ISSN: w.i % 5 ? ["1234-" + String(1000 + (w.i % JOURNALS.length))] : [] };
}
function epmcWork(w) {
	return { id: String(30000000 + w.i), source: "MED", pmid: String(30000000 + w.i), doi: w.doi, title: w.title, pubYear: String(w.year), firstPublicationDate: w.year + "-03-01",
		authorList: { author: w.authors.map((a, k) => ({ firstName: a.name.split(" ")[0], lastName: a.name.split(" ")[1], fullName: a.name, authorAffiliationDetailsList: { authorAffiliation: [{ affiliation: w.inst(k).name }] } })) },
		journalInfo: { journal: { title: w.venue }, volume: "1", issue: "2" }, citedByCount: w.citations, abstractText: w.abstract, pubTypeList: { pubType: ["journal article"] } };
}
function arxivEntry(w) {
	const id = w.preprint ? "2401." + String(10000 + w.i) : "2301." + String(10000 + w.i);
	return `<entry><id>http://arxiv.org/abs/${id}v1</id><published>${w.year}-03-01T00:00:00Z</published><title>${w.title}</title><summary>${w.abstract}</summary>`
		+ w.authors.map(a => `<author><name>${a.name}</name></author>`).join("") + (w.preprint ? "" : `<arxiv:doi>${w.doi}</arxiv:doi><arxiv:journal_ref>${w.venue} 1 (${w.year})</arxiv:journal_ref>`)
		+ `<link title="pdf" href="https://arxiv.org/pdf/${id}v1"/></entry>`;
}

// ---------------------------------------------------------------- the network, in memory
export function fakeNetwork({ latency = 25 } = {}) {
	const log = [];
	const param = (url, name) => new URL(url).searchParams.get(name);
	async function answer(url) {
		const u = new URL(url), host = u.host;
		if (host === "api.openalex.org") {
			if (u.pathname === "/works") {
				const filter = param(url, "filter") || "";
				const doiFilter = /(?:^|,)doi:([^,]+)/.exec(filter);
				if (doiFilter && !param(url, "search")) {
					const want = new Set(doiFilter[1].split("|").map(d => d.toLowerCase()));
					return { meta: { count: want.size }, results: UNIVERSE.filter(w => want.has(w.doi)).map(openAlexWork) };
				}
				const per = Number(param(url, "per-page") || 25), page = Number(param(url, "page") || 1);
				const ids = ORDER.openalex.slice((page - 1) * per, page * per);
				return { meta: { count: ORDER.openalex.length }, results: ids.map(i => openAlexWork(UNIVERSE[i])) };
			}
			if (u.pathname === "/sources") {
				const filter = param(url, "filter") || "";
				const ids = (/ids\.openalex:([^,]+)/.exec(filter)?.[1] || "").split("|").filter(Boolean);
				const issns = (/(?:^|,)issn:([^,]+)/.exec(filter)?.[1] || "").split("|").filter(Boolean);
				if (issns.length) return { meta: { count: issns.length }, results: issns.map(issn => { const k = Number(issn.slice(5)) - 1000; return { id: "https://openalex.org/S" + (7000 + k), display_name: JOURNALS[k], issn_l: issn, issn: [issn], summary_stats: { "2yr_mean_citedness": 3, h_index: 120 }, works_count: 1000 }; }) };
				if (param(url, "search")) return { meta: { count: 1 }, results: [{ id: "https://openalex.org/S7000", display_name: param(url, "search"), issn: [], summary_stats: { "2yr_mean_citedness": 5, h_index: 200 } }] };
				return { meta: { count: ids.length }, results: ids.map((id, k) => ({ id: "https://openalex.org/" + id, display_name: JOURNALS[(Number(id.slice(1)) - 7000) % JOURNALS.length] || "arXiv", issn_l: null, issn: [], summary_stats: { "2yr_mean_citedness": 2 + k % 9, h_index: 100 + k }, works_count: 1000, is_oa: false, is_in_doaj: false })) };
			}
			if (u.pathname === "/institutions") {
				const ids = (/ids\.openalex:([^,&]+)/.exec(param(url, "filter") || "")?.[1] || "").split("|").filter(Boolean);
				return { meta: { count: ids.length }, results: ids.map(id => { const inst = INSTITUTIONS.find(x => x.id === id); return { id: "https://openalex.org/" + id, display_name: inst?.name, country_code: inst?.country, summary_stats: { h_index: inst?.h } }; }) };
			}
			if (u.pathname === "/authors") return { meta: { count: 1 }, results: [{ id: "https://openalex.org/A100001", display_name: param(url, "search"), works_count: 40 }] };
			if (/^\/works\//.test(u.pathname)) return { id: "https://openalex.org/W5000001", referenced_works: Array.from({ length: 40 }, (_, k) => "https://openalex.org/W" + (5000000 + k * 13)) };
		}
		if (host === "api.crossref.org") {
			if (u.pathname === "/journals") return { message: { items: [] } };
			const rows = Number(param(url, "rows") || 20), offset = Number(param(url, "offset") || 0);
			return { message: { "total-results": ORDER.crossref.length, items: ORDER.crossref.slice(offset, offset + rows).map(i => crossrefWork(UNIVERSE[i])) } };
		}
		if (host === "www.ebi.ac.uk") {
			const size = Number(param(url, "pageSize") || 25), cursor = param(url, "cursorMark") || "*";
			const start = cursor === "*" ? 0 : Number(cursor.slice(1));
			const items = ORDER.europepmc.slice(start, start + size).map(i => epmcWork(UNIVERSE[i]));
			return { hitCount: ORDER.europepmc.length, nextCursorMark: "c" + (start + size), resultList: { result: items } };
		}
		if (host === "export.arxiv.org") {
			const start = Number(param(url, "start") || 0), n = Number(param(url, "max_results") || 10);
			return `<feed xmlns="http://www.w3.org/2005/Atom"><opensearch:totalResults>${ORDER.arxiv.length}</opensearch:totalResults>`
				+ ORDER.arxiv.slice(start, start + n).map(i => arxivEntry(UNIVERSE[i])).join("") + "</feed>";
		}
		throw Object.assign(new Error("no fixture for " + url), { status: 404 });
	}
	return {
		log,
		async request(method, url, options = {}) {
			const entry = { url, at: performance.now(), aborted: false };
			log.push(entry);
			let cancelled = false, cancel;
			const stopped = new Promise((_, reject) => { cancel = () => { cancelled = true; entry.aborted = true; reject(Object.assign(new Error("cancelled"), { name: "AbortError" })); }; });
			options.cancellerReceiver?.(() => cancel());
			await Promise.race([sleep(latency), stopped]);
			if (cancelled) throw new Error("cancelled");
			const body = await answer(url);
			return options.responseType === "json" ? { status: 200, response: body } : { status: 200, response: body, responseText: typeof body === "string" ? body : JSON.stringify(body) };
		}
	};
}

// What a request costs on OpenAlex's metered API (USD): a search-priced call is ten times a filter lookup.
export function openAlexCost(url) {
	if (!/api\.openalex\.org/.test(url)) return 0;
	const u = new URL(url);
	if (u.searchParams.get("search") || /\.search:/.test(u.searchParams.get("filter") || "")) return 0.001;
	return 0.0001;
}

// ---------------------------------------------------------------- the library, in a stub database
function library(size = 1200) {
	// 300 of the corpus's papers are held by DOI, 60 more by title only, the rest are the reader's other papers.
	const items = [];
	for (let k = 0; k < size; k++) {
		const id = 1000 + k;
		if (k < 300) { const w = UNIVERSE[k * 7]; items.push({ id, title: w.title, date: w.year + "-03-01", doi: w.doi }); }
		else if (k < 360) { const w = UNIVERSE[k * 5 + 1]; items.push({ id, title: w.title, date: String(w.year), doi: null }); }
		else items.push({ id, title: "A paper of the reader's own on another topic number " + k, date: "2019", doi: "10.9999/own" + k });
	}
	return items;
}
function database(items) {
	const queries = [];
	return {
		queries,
		async queryAsync(sql, params) {
			queries.push(sql.slice(0, 60));
			if (/F\.fieldName IN \('DOI', 'extra'\)/.test(sql)) return items.filter(i => i.doi).map(i => ({ itemID: i.id, fieldName: "DOI", value: i.doi }));
			if (/F\.fieldName = 'title'/.test(sql)) return items.map(i => ({ itemID: i.id, title: i.title, date: i.date, doi: i.doi, extra: null }));
			if (/FROM itemTags/.test(sql)) return params.filter((_, k) => k % 3 === 0).map(id => ({ itemID: id, name: "/reading" }));
			if (/FROM collectionItems/.test(sql)) return params.map(id => ({ itemID: id, collectionID: 1 + id % 20 }));
			return [];
		}
	};
}

// ---------------------------------------------------------------- the window
export async function openWindow({ locale = "en", latency = 25, libSize = 1200, prefs: extraPrefs = {}, historyFiles = new Map(), worksSize = 1145, patch = code => code } = {}) {
	const markup = read("content/search.xhtml").replace(/<\?xml[^>]*\?>/, "").replace(/<script\b[^>]*><\/script>/g, "").replace(/<link\b[^>]*>/g, "");
	const { window, document } = parseHTML(markup);
	const counters = { created: 0, rows: 0 };
	// Gecko finds an element by id in a hash table; linkedom walks the tree. Kept by id here, so the
	// bench measures the window's own work and not linkedom's lookup.
	const byId = new Map(), findById = document.getElementById.bind(document);
	document.getElementById = id => { let el = byId.get(id); if (el && el.id === id && el.isConnected) return el; el = findById(id); if (el) byId.set(id, el); return el; };
	const create = document.createElement.bind(document);
	document.createElement = (tag, ...rest) => { counters.created++; if (tag === "tr") counters.rows++; return create(tag, ...rest); };
	const listeners = new Map();
	const win = { document, DOMParser: window.DOMParser, addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
		matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }), setTimeout, clearTimeout, requestAnimationFrame: fn => setTimeout(fn, 16),
		innerWidth: 1280, innerHeight: 860, outerWidth: 1280, outerHeight: 860, screenX: 0, screenY: 0, close() {}, openDialog() {} };
	for (const name of ["scrollIntoView", "focus", "select"]) if (!window.HTMLElement.prototype[name]) window.HTMLElement.prototype[name] = function () {};
	Object.defineProperty(window.HTMLSelectElement.prototype, "value", { configurable: true,
		get() { return this._value ?? this.querySelector("option[selected]")?.getAttribute("value") ?? this.querySelector("option")?.getAttribute("value") ?? ""; },
		set(v) { this._value = String(v); } });
	Object.defineProperty(window.HTMLSelectElement.prototype, "options", { configurable: true, get() { return [...this.querySelectorAll("option")]; } });
	Object.defineProperty(window.HTMLSelectElement.prototype, "selectedIndex", { configurable: true,
		get() { const i = this.options.findIndex(o => o.getAttribute("value") === this.value); return i < 0 ? 0 : i; },
		set(i) { this._value = this.options[i]?.getAttribute("value") ?? ""; } });
	const net = fakeNetwork({ latency });
	const items = library(libSize), db = database(items);
	const prefs = Object.assign(extraPrefs, { language: locale, searchSurface: "papers", hintShown: true, multiSourceMigrated: true, multiSourceMigrated2: true, defaultSource: "multi", journalLookup: false }, extraPrefs);
	const works = Object.fromEntries(Array.from({ length: worksSize }, (_, k) => ["1:K" + k, { openalex: "https://openalex.org/W" + (6000000 + k), references: Array.from({ length: 45 }, (_, j) => "https://openalex.org/W" + (5000000 + (k * 11 + j * 29) % U)) }]));
	const styleCustom = { paperWorks: () => works, watchedAuthors: () => [{ id: "A100005", name: "Followed Person" }], state: () => ({ status: "unread" }),
		queueForReading: async () => {}, isQueued: () => false, watchAuthor: async p => p };
	const ctx = vm.createContext({
		window: win, document, AbortController, URL, console, setTimeout, clearTimeout, CSS: { escape: v => v }, performance,
		Zotero: { locale, debug() {}, logError() {}, launchURL() {}, Libraries: { userLibraryID: 1, getAll: () => [{ libraryID: 1, editable: true, name: "My Library" }] }, DB: db, StyleCustom: styleCustom,
			Prefs: { get: key => prefs[key.replace("extensions.zotpop.", "")], set: (key, v) => { prefs[key.replace("extensions.zotpop.", "")] = v; } },
			Items: { get: id => ({ id }), getAsync: async ids => ids.map(id => ({ id })), getByLibraryAndKey: (_lib, key) => ({ id: 1, deleted: false, getField: () => "Held " + key }) },
			Collections: { get: id => ({ name: "Collection " + id, parentID: id > 10 ? id - 10 : null }), getByLibrary: () => Array.from({ length: 40 }, (_, k) => ({ id: k + 1, name: "Collection " + (k + 1), parentID: k >= 10 ? k - 9 : null })) },
			Notifier: { registerObserver: () => "obs", unregisterObserver() {} },
			HTTP: { request: net.request }, Utilities: { Internal: { copyTextToClipboard() {} } } },
		ZotPoPMarquee: { attach: () => ({ refresh() {}, refreshCell() {} }) }
	});
	win.Zotero = ctx.Zotero;
	for (const f of ["i18n", "query", "brand-icons", "affiliations", "journal-marks", "jcr", "history", "sources", "authors", "metrics", "filters", "journals", "signals", "tooltip", "cite", "translate", "preview", "related", "importer"]) {
		vm.runInContext(read(`content/${f}.js`), ctx, { filename: f });
	}
	ctx.ZotPoPI18N.apply = (rootNode, t) => {
		for (const el of rootNode.querySelectorAll("[data-i18n]")) el.textContent = t(el.getAttribute("data-i18n"));
		for (const el of rootNode.querySelectorAll("[data-i18n-ph]")) el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph")));
		for (const el of rootNode.querySelectorAll("[data-i18n-title]")) ctx.ZotPoPTip.set(el, t(el.getAttribute("data-i18n-title")));
		for (const el of rootNode.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria")));
	};
	const realMemoryIO = ctx.ZotPoPHistory.memoryIO;
	ctx.ZotPoPHistory.memoryIO = () => realMemoryIO(historyFiles);
	const code = read("content/ui.js").replace('window.addEventListener("load", init);',
		'window.addEventListener("load", init); globalThis.__ui = { state, render, renderDetail, sortByColumn, refreshLibraryFlags, rowStats, rowCache, displaySearchResults, runSearch, buildResultContext, syncWindow, virtualView };');
	vm.runInContext(patch(code), ctx, { filename: "ui.js" });
	const t0 = performance.now();
	for (const fn of listeners.get("load") || []) fn();
	const initMs = performance.now() - t0;
	const ui = ctx.__ui;
	const body = () => document.getElementById("results-body");
	const fire = (el, type = "click") => el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
	return { window, document, ctx, ui, net, db, counters, prefs, historyFiles, initMs, body, fire, listeners };
}

// One search from the form, as the reader starts it; resolves with what it cost.
export async function search(w, { keywords = "genome editing", maxResults = 200, sources = ["openalex", "crossref", "europepmc", "arxiv"], venue = "", authors = "" } = {}) {
	const { document, ui, net, counters, db } = w;
	document.getElementById("keywords").value = keywords;
	document.getElementById("venue").value = venue;
	document.getElementById("authors").value = authors;
	document.getElementById("maxResults").value = String(maxResults);
	document.getElementById("source").value = sources.length > 1 ? "multi" : sources[0];
	for (const key of ["openalex", "crossref", "europepmc", "arxiv", "pubmed", "semanticscholar", "scholar"]) { const box = document.getElementById("multi-source-" + key); if (box) box.checked = sources.includes(key); }
	const from = net.log.length, created = counters.created, rows = counters.rows, dbFrom = db.queries.length;
	const built = ui.rowStats.built, reused = ui.rowStats.reused;
	let renders = 0;
	const originalRender = ui.render;
	const t0 = performance.now();
	let firstRow = null;
	const watch = setInterval(() => { if (firstRow == null && w.body().firstChild) firstRow = performance.now() - t0; }, 2);
	const done = ui.runSearch();
	await done;
	clearInterval(watch);
	const total = performance.now() - t0;
	const requests = net.log.slice(from);
	const urls = requests.map(r => r.url.replace(/[?&](api_key|mailto)=[^&]*/g, ""));
	const bySource = {};
	for (const u of urls) { const k = new URL(u).host + new URL(u).pathname.replace(/\/[^/]*\d[^/]*$/, "/:id"); bySource[k] = (bySource[k] || 0) + 1; }
	const seen = new Map(); for (const u of urls) seen.set(u, (seen.get(u) || 0) + 1);
	const duplicates = [...seen.values()].reduce((s, n) => s + n - 1, 0);
	return { total, firstRow, requests: requests.length, bySource, duplicates, openAlexUSD: requests.reduce((s, r) => s + openAlexCost(r.url), 0),
		created: counters.created - created, rowsBuilt: ui.rowStats.built - built, rowsReused: ui.rowStats.reused - reused, trCreated: counters.rows - rows, dbQueries: db.queries.length - dbFrom,
		shown: ui.state.visible.length, domRows: w.body().children.length, records: ui.state.records.length, renders, originalRender };
}

const time = (fn, n = 1) => { const t0 = performance.now(); for (let i = 0; i < n; i++) fn(); return (performance.now() - t0) / n; };
const heap = () => { globalThis.gc?.(); globalThis.gc?.(); return process.memoryUsage().heapUsed / 1048576; };

export async function bench() {
	const out = {};
	// Startup: an empty window, and one that restores the last 1,200-row search from history.
	{
		const w = await openWindow();
		out.startupEmptyMs = w.initMs;
		out.startupRequests = w.net.log.length;
		await sleep(50);
		await search(w, { maxResults: 1200 });
		await sleep(50);
		const again = await openWindow({ historyFiles: w.historyFiles, prefs: w.prefs });
		const t0 = performance.now();
		// Only the rows near the view are built: the restored list is counted in the data, the built rows in the DOM.
		for (let i = 0; i < 400 && again.ui.state.visible.length < 1000; i++) await sleep(5);
		out.startupRestoreMs = again.initMs + (performance.now() - t0);
		out.startupRestoreRequests = again.net.log.length;
		out.startupRestoreRows = again.ui.state.visible.length;
		out.startupRestoreBuilt = again.body().children.length;
	}
	for (const max of [200, 1200]) {
		const w = await openWindow();
		await sleep(20);
		const s = await search(w, { maxResults: max });
		out["search" + max] = s;
		const ui = w.ui;
		// Re-render with nothing changed: every row reused.
		let c = w.counters.created, b = ui.rowStats.built;
		out["rerender" + max] = { ms: time(() => ui.render(), 5), created: w.counters.created - c, built: ui.rowStats.built - b };
		// Filter and its clearing.
		const filter = w.document.getElementById("filter");
		c = w.counters.created; b = ui.rowStats.built;
		const f1 = time(() => { filter.value = "delivery"; ui.render(); });
		const shownFiltered = ui.state.visible.length;
		const f2 = time(() => { filter.value = ""; ui.render(); });
		out["filter" + max] = { ms: f1, clearMs: f2, shown: shownFiltered, created: w.counters.created - c, built: ui.rowStats.built - b };
		// Sort by citations, then by year, then back.
		c = w.counters.created;
		out["sort" + max] = { ms: time(() => { ui.sortByColumn("citations"); ui.sortByColumn("year"); ui.sortByColumn("rank"); }) / 3, created: w.counters.created - c };
		// The detail pane: open a row, then the cost a render pays while it stays open.
		const row = w.body().children[5];
		c = w.counters.created;
		out["detail" + max] = { openMs: time(() => w.fire(row.children[3])), created: w.counters.created - c };
		const withDetail = time(() => ui.render(), 5);
		c = w.counters.created;
		ui.render();
		out["detail" + max].renderWithDetailMs = withDetail;
		out["detail" + max].createdPerRender = w.counters.created - c;
		out["detail" + max].contextMs = time(() => ui.buildResultContext(ui.state.records[5]), 5);
		// Scrolling the whole list a screenful at a time: what each step builds, and how long it takes.
		{
			const wrap = w.document.getElementById("table-wrap"), view = ui.virtualView();
			const before = ui.rowStats.built, c0 = w.counters.created, step = 860, steps = Math.ceil(view.total / step);
			const t1 = performance.now();
			for (let k = 1; k <= steps; k++) { wrap.scrollTop = k * step; ui.syncWindow(); }
			out["scroll" + max] = { steps, msPerStep: (performance.now() - t1) / steps, built: ui.rowStats.built - before, created: w.counters.created - c0, domRows: w.body().children.length };
			wrap.scrollTop = 0; ui.syncWindow();
		}
		// Held-paper lookup: the library pass after a search.
		const q = w.db.queries.length;
		out["held" + max] = { ms: time(() => {}), queries: 0 };
		const t0 = performance.now(); await ui.refreshLibraryFlags(); out["held" + max] = { ms: performance.now() - t0, queries: w.db.queries.length - q, owned: ui.state.records.filter(r => r.inLibrary).length };
	}
	// Memory over repeated searches in one window.
	{
		const w = await openWindow({ latency: 2 });
		await search(w, { maxResults: 1200 });
		const base = heap();
		const trace = [];
		for (let i = 0; i < 8; i++) { await search(w, { maxResults: 1200, keywords: i % 2 ? "genome editing" : "genome editing delivery" }); trace.push(heap()); }
		out.memory = { baseMB: base, afterMB: trace.at(-1), growthMB: trace.at(-1) - base, trace, rowCache: w.ui.rowCache.size, bodyListeners: null };
	}
	// Cancellation: a second search started while the first runs.
	{
		const w = await openWindow({ latency: 40 });
		w.document.getElementById("keywords").value = "genome editing";
		w.document.getElementById("source").value = "multi";
		for (const key of ["openalex", "crossref", "europepmc", "arxiv"]) w.document.getElementById("multi-source-" + key).checked = true;
		const first = w.ui.runSearch();
		await sleep(60);
		const before = w.net.log.length;
		w.document.getElementById("keywords").value = "genome editing repair";
		const second = search(w, { keywords: "genome editing repair", maxResults: 200 });
		await first; const s = await second;
		out.cancel = { abortedRequests: w.net.log.filter(r => r.aborted).length, firstRunRequests: before, secondRunRequests: s.requests };
	}
	// A typed journal and author, the cases that resolve a name on OpenAlex first; searched twice.
	{
		const w = await openWindow({ latency: 2 });
		const a = await search(w, { maxResults: 200, sources: ["openalex"], venue: "Nature", authors: "Mina Kim" });
		const b = await search(w, { maxResults: 200, sources: ["openalex"], venue: "Nature", authors: "Mina Kim" });
		out.lookups = { first: a.bySource, second: b.bySource, firstUSD: a.openAlexUSD, secondUSD: b.openAlexUSD };
	}
	return out;
}

function table(out) {
	const f = n => n == null ? "-" : typeof n === "number" ? (Number.isInteger(n) ? String(n) : n.toFixed(1)) : String(n);
	const lines = [];
	const row = (k, v) => lines.push(k.padEnd(46) + v);
	row("startup, empty window (ms)", f(out.startupEmptyMs));
	row("startup, restoring a 1,200-row search (ms)", f(out.startupRestoreMs) + "  requests " + out.startupRestoreRequests + "  rows " + out.startupRestoreRows + " (built " + out.startupRestoreBuilt + ")");
	for (const max of [200, 1200]) {
		const s = out["search" + max];
		row(`search ${max}: first row / total (ms)`, f(s.firstRow) + " / " + f(s.total));
		row(`search ${max}: requests (duplicates)`, s.requests + " (" + s.duplicates + ")  OpenAlex $" + s.openAlexUSD.toFixed(4));
		row(`search ${max}: by endpoint`, JSON.stringify(s.bySource));
		row(`search ${max}: rows built / reused / elements`, s.rowsBuilt + " / " + s.rowsReused + " / " + s.created);
		row(`search ${max}: rows in the data / in the DOM`, s.shown + " / " + s.domRows);
		row(`re-render ${max} (ms, elements, rebuilt)`, f(out["rerender" + max].ms) + ", " + out["rerender" + max].created + ", " + out["rerender" + max].built);
		row(`filter ${max} (ms / clear ms, elements)`, f(out["filter" + max].ms) + " / " + f(out["filter" + max].clearMs) + ", " + out["filter" + max].created);
		row(`sort ${max} (ms, elements)`, f(out["sort" + max].ms) + ", " + out["sort" + max].created);
		row(`detail ${max}: open (ms, elements)`, f(out["detail" + max].openMs) + ", " + out["detail" + max].created);
		row(`detail ${max}: render while open (ms, elements)`, f(out["detail" + max].renderWithDetailMs) + ", " + out["detail" + max].createdPerRender + "  context " + f(out["detail" + max].contextMs) + " ms");
		const sc = out["scroll" + max];
		row(`scroll ${max} top to bottom (ms/step, built)`, f(sc.msPerStep) + " x " + sc.steps + ", " + sc.built + " rows, " + sc.created + " elements, " + sc.domRows + " in DOM");
		row(`held lookup ${max} (ms, DB queries)`, f(out["held" + max].ms) + ", " + out["held" + max].queries);
	}
	row("memory: 8 more 1,200-row searches (MB)", f(out.memory.baseMB) + " -> " + f(out.memory.afterMB) + "  rowCache " + out.memory.rowCache);
	row("cancel: requests aborted by a new search", String(out.cancel.abortedRequests));
	row("typed journal+author, 1st search", JSON.stringify(out.lookups.first) + " $" + out.lookups.firstUSD.toFixed(4));
	row("typed journal+author, same again", JSON.stringify(out.lookups.second) + " $" + out.lookups.secondUSD.toFixed(4));
	return lines.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	const out = await bench();
	console.log(process.argv.includes("--json") ? JSON.stringify(out, null, 2) : table(out));
	process.exit(0);
}

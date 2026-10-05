import fs from "node:fs";
import vm from "node:vm";
import Sources from "../../content/sources.js";
import Preview from "../../content/preview.js";
import History from "../../content/history.js";
import Affiliations from "../../content/affiliations.js";
import JournalMarks from "../../content/journal-marks.js";
import JCR from "../../content/jcr.js";
import Authors from "../../content/authors.js";
import Filters from "../../content/filters.js";
import Journals from "../../content/journals.js";
import Signals from "../../content/signals.js";
import Related from "../../content/related.js";
import Tip from "../../content/tooltip.js";

export const paper = (key, extra = {}) => ({
	key, title: key, citations: 1, year: 2026, authors: [], ...extra
});

export function deferred() {
	let resolve, reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

// The element focus() was last called on, standing in for document.activeElement.
export function mockElement(tagName = "div") {
	const attributes = new Map(), classes = new Set(), listeners = new Map();
	let text = "";
	const node = {
		tagName: tagName.toUpperCase(), nodeType: tagName === "#fragment" ? 11 : tagName === "#text" ? 3 : 1,
		children: [], parentNode: null, connected: false, value: "", checked: false, hidden: true, style: {}, scrollLeft: 0,
		get parentElement() { return this.parentNode; },
		get isConnected() { return this.parentNode ? this.parentNode.isConnected : this.connected; },
		get firstChild() { return this.children[0] || null; },
		get nextSibling() { const siblings = this.parentNode?.children; return siblings ? siblings[siblings.indexOf(this) + 1] || null : null; },
		get textContent() { return text + this.children.map(child => child.textContent || "").join(""); },
		set textContent(value) {
			for (const child of this.children) child.parentNode = null;
			this.children = []; text = "";
			if (this.nodeType === 3) text = String(value ?? "");
			else if (String(value ?? "")) { const child = mockElement("#text"); child.textContent = value; child.parentNode = this; this.children.push(child); }
		},
		get className() { return [...classes].join(" "); },
		set className(value) { classes.clear(); for (const name of String(value).split(/\s+/).filter(Boolean)) classes.add(name); attributes.set("class", String(value)); },
		get title() { return attributes.get("title") || ""; },
		set title(value) { attributes.set("title", String(value)); },
		classList: {
			add(...names) { for (const name of names) classes.add(name); },
			remove(...names) { for (const name of names) classes.delete(name); },
			toggle(name, on = !classes.has(name)) { on ? classes.add(name) : classes.delete(name); return on; },
			contains: name => classes.has(name)
		},
		getAttribute(name) { return name === "class" ? node.className : attributes.get(name) ?? null; },
		setAttribute(name, value) { if (name === "class") node.className = value; else attributes.set(name, String(value)); },
		hasAttribute(name) { return attributes.has(name); },
		removeAttribute(name) { attributes.delete(name); },
		appendChild(child) {
			if (child.nodeType === 11) { for (const part of [...child.children]) this.appendChild(part); return child; }
			child.remove?.();
			child.parentNode = this; this.children.push(child); return child;
		},
		insertBefore(child, reference) { child.remove?.(); child.parentNode = this; if (!reference) this.children.push(child); else this.children.splice(this.children.indexOf(reference), 0, child); return child; },
		remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; } },
		contains(other) { return other === this || this.children.some(child => child.contains?.(other)); },
		matches(selector) {
			if (this.nodeType !== 1) return false;
			return selector.split(",").some(value => {
				const match = value.trim().match(/^([\w-]+)?(?:\.([\w-]+))?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/);
				return Boolean(match && (!match[1] || this.tagName === match[1].toUpperCase())
					&& (!match[2] || classes.has(match[2])) && (!match[3] || (this.hasAttribute(match[3]) && (match[4] === undefined || this.getAttribute(match[3]) === match[4]))));
			});
		},
		closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest?.(selector) || null; },
		querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches?.(selector) ? [child] : []), ...(child.querySelectorAll?.(selector) || [])]); },
		querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
		addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
		removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
		// Bubbles to the parents like a DOM event, so delegated handlers see a click on a child.
		emit(name, event = {}) {
			let stopped = false;
			const ev = { target: this, preventDefault() {}, ...event, stopPropagation() { stopped = true; event.stopPropagation?.(); } };
			for (let at = this; at && !stopped; at = at.parentNode) for (const fn of [...(at.listeners?.get(name) || [])]) fn(ev);
		},
		get listeners() { return listeners; },
		listenerCount() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); },
		focus() { mockElement.active = node; }, scrollIntoView() {},
		getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 30, width: 100, height: 30 }; }
	};
	const dataName = key => "data-" + String(key).replace(/[A-Z]/g, letter => "-" + letter.toLowerCase());
	node.dataset = new Proxy({}, {
		get: (_, key) => attributes.get(dataName(key)), set: (_, key, value) => { attributes.set(dataName(key), String(value)); return true; },
		deleteProperty: (_, key) => { attributes.delete(dataName(key)); return true; }
	});
	return node;
}

export function uiHarness({ sort = "relevance", search, request, refreshLibraryFlags, popBridge, authorsService = Authors, openDialog, marquee, realRows = false, columns = false, launchURL = () => {
}, historyFiles = new Map(), prefs = {}, mainWindow = null, importer = null, metrics = null, zotero = {}, sources = {}, previewModule = null, cite = null, globals = {} } = {}) {
	// The author tab opens on the combined provider; tests of the other providers start from Scholar unless they save their own choice.
	const startOnScholar = !("lastAuthorQuery" in prefs);
	if (startOnScholar) prefs.lastAuthorQuery = JSON.stringify({ provider: "scholar" });
	const copied = [], reloads = [];
	const elements = new Map(), errors = [], events = new Map(), counts = { created: 0 };
	const get = id => {
		if (!elements.has(id)) { const node = mockElement(); node.connected = true; elements.set(id, node); }
		return elements.get(id);
	};
	const docEvents = mockElement("document"), winEvents = mockElement("window");
	const document = {
		getElementById: get, querySelectorAll(selector) {
			const match = selector.match(/^#([\w-]+)\s+(.+)$/);
			return match ? get(match[1]).querySelectorAll(match[2]) : [];
		}, createElement: (...args) => { counts.created++; return mockElement(...args); }, body: mockElement("body"),
		get activeElement() { return mockElement.active || null; },
		addEventListener: (...args) => docEvents.addEventListener(...args), removeEventListener: (...args) => docEvents.removeEventListener(...args),
		createTextNode(value) { const node = mockElement("#text"); node.textContent = value; return node; },
		createDocumentFragment: () => mockElement("#fragment"),
		querySelector(selector) {
			const match = selector.match(/^#([\w-]+)\s+(.+)$/);
			return match ? get(match[1]).querySelector(match[2]) : null;
		}
	};
	if (columns) {
		const table = get("results-table"), head = get("results-head"), cols = get("cols");
		table.appendChild(cols); table.appendChild(head); table.appendChild(get("results-body"));
		const markup = fs.readFileSync(new URL("../../content/search.xhtml", import.meta.url), "utf8");
		const keys = [...markup.matchAll(/<col data-k="([^"]+)"/g)].map(match => match[1]);
		for (const key of keys) {
			const col = mockElement("col"); col.dataset.k = key; cols.appendChild(col);
			const th = mockElement("th"); th.dataset.k = key;
			if (key !== "chk") { th.dataset.sort = key; if (key !== "status") { const grip = mockElement("span"); grip.className = "rz"; th.appendChild(grip); } }
			head.appendChild(th);
		}
	}
	// The library filter's three buttons, as the markup has them.
	for (const key of ["all", "new", "owned"]) { const b = mockElement("button"); b.connected = true; b.dataset.lib = key; elements.set("lib-" + key, b); get("lib-filter").appendChild(b); }
	for (const source of ["openalex", "crossref", "europepmc", "arxiv"]) get("multi-source-" + source).checked = true;
	get("keywords").value = "genome editing";
	get("sort").value = sort;
	get("source").value = "openalex";
	get("maxResults").value = "10";
	get("author-provider").value = "scholar";
	get("author-max-results").value = "1000";
	const apiRecords = [paper("relevant", { title: "Precise match" }),
		paper("popular", { title: "Broad review", citations: 10000, year: 2020 })];
	const context = vm.createContext({
		AbortController, setTimeout, clearTimeout, ...globals,
		window: { location: { reload() { reloads.push(1); } }, addEventListener(name, fn) { events.set(name, fn); winEvents.addEventListener(name, fn); }, openDialog, arguments: mainWindow ? [{ mainWindow }] : undefined },
		document,
		Zotero: { Prefs: { get: key => { let k = key.replace("extensions.zotpop.", ""); return k in prefs ? prefs[k] : true; }, set: (key, value) => { prefs[key.replace("extensions.zotpop.", "")] = value; } }, debug() {}, logError: e => errors.push(e), launchURL, Utilities: { Internal: { copyTextToClipboard: text => copied.push(String(text)) } },
			Libraries: { userLibraryID: 1 },
			HTTP: { request: request || (() => { throw new Error("Unexpected HTTP request"); }) }, ...zotero },
		ZotPoPI18N: { make: () => (key, ...args) => key === "csvHead" ? ["head"] : [key, ...args].join("|") },
		ZotPoPSources: { SOURCES: { openalex: { label: "OpenAlex" } }, POP_SOURCES: Sources.POP_SOURCES, normalizeDOI: Sources.normalizeDOI, filterRecords: (records, query) => Sources.filterRecords ? Sources.filterRecords(records, query) : records,
			search: search || (async (_source, query) => query.sort === "citations" ? [...apiRecords].reverse() : [...apiRecords]), ...sources },
		ZotPoPPoPBridge: popBridge,
		ZotPoPAuthors: authorsService,
		ZotPoPPreview: previewModule || Preview,
		...(cite ? { ZotPoPCite: cite } : {}),
		ZotPoPHistory: { ...History, memoryIO: () => History.memoryIO(historyFiles) },
		ZotPoPAffiliations: Affiliations,
		ZotPoPFilters: Filters,
		ZotPoPJournals: Journals,
		ZotPoPSignals: Signals,
		ZotPoPRelated: Related,
		ZotPoPJournalMarks: JournalMarks,
		ZotPoPTip: Tip,
		ZotPoPJCR: JCR,
		ZotPoPMarquee: marquee || { attach: () => ({ refresh() {}, refreshCell() {} }) },
		ZotPoPMetrics: metrics || { citesPerYear: () => 1 },
		CSS: { escape: value => value },
		ZotPoPImporter: importer || undefined,
		refreshFlags: refreshLibraryFlags || (async () => {})
	});
	let code = fs.readFileSync(new URL("../../content/ui.js", import.meta.url), "utf8");
	// Exercise the actual query, search, HTTP adapter and render functions. Isolate
	// native Zotero library access and individual row/detail widgets only.
	code = code.replace('window.addEventListener("load", init);', `
		if (!globalThis.ZotPoPImporter) refreshLibraryFlags = globalThis.refreshFlags;
		${realRows ? "" : 'buildRow = () => document.createElement("tr");'}
		const originalRenderMetrics = renderMetrics;
		const originalRenderDetail = renderDetail;
		renderMetrics = renderDetail = () => {};
		cacheIO = setupStorage();
		globalThis.harness = { refreshLibraryFlags, saveCSV, tipContent, journalMark, state, runSearch, render, showInLibrary, http, stopOperation, onKeyDown, clearAll, clearFilter, syncFilterClear, openPreview, closePreview, togglePreview, syncPreview, viewerOfPreview, paintPreview, previewRecord, buildRow, rowSignature, setRowStatus, onDocumentScroll, restoreCachedSearch, cancelCacheRestore,
			openHistoryEntry, openHistoryMenu, closeHistoryMenu, sortValue, matchesFilter, csvText, popOriginalJSON, displaySearchResults, checkCitations, readQuery, populateSearchSources, sourceHint, savePrefs, saveQuery, restoreQuery, setupColumnOrder, setupColumnResize, applyColumnWidths, restoreLayout, normalizeColumnOrder,
			wireEvents, importRecords, openToolbarMenu, closeToolbarMenu, onToolbarMenuKey, viewMenuItems, setLanguage, languageChoice, renderVersions, renderSignals, followAuthor, heldVersion, revealRecord, buildResultContext, applyLocalFacet, setFacet, updateCounts, applyColumnView, saveLayout, originalRenderDetail, runAuthorAction, switchSearchMode, switchAuthorProvider, renderAuthorProfiles, authorQuery, authorInputChanged, restoreAuthorPreferences, saveAuthorPreferences, originalRenderMetrics,
			yearBins, filterSpec, addRule, openFilterPop, closeFilterPop, syncFilterUI, clearAllFilters, affLineParts, shortInstitution, renderAuthors, addVenueChip, removeVenueChip, setVenueChips, refreshVenueSuggestions, onVenueKey, wireVenueBox, ensureJournalCatalog, citeCardBody, renderCiteStrip,
			searchMode: () => searchSurface, authorSessions, setAuthorProvider: provider => { activeAuthorProvider = provider; }, personPick, setPick, peopleClusters, setPersonMembership, unverifiedAuthorResults, validPick, metricsOwner, authorMetricsInfo,
			ensureAbstracts, runTranslate, setTranslatorForTest: value => { translator = value; },
			get history() { return history; },
			setOpenSelectForTest: value => { openSel = value; } };
	`);
	vm.runInContext(code, context);
	if (startOnScholar) context.harness.setAuthorProvider("scholar");
	return { copied, reloads, counts, Z: context.Zotero, ...context.harness, get, errors, events, prefs, emitDocument: (name, event) => docEvents.emit(name, event), emitWindow: (name, event) => winEvents.emit(name, event) };
}

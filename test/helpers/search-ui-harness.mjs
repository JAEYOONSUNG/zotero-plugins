import fs from "node:fs";
import vm from "node:vm";
import Sources from "../../content/sources.js";
import Preview from "../../content/preview.js";

export const paper = (key, extra = {}) => ({
	key, title: key, citations: 1, year: 2026, authors: [], ...extra
});

export function deferred() {
	let resolve, reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

export function mockElement(tagName = "div") {
	const attributes = new Map(), classes = new Set(), listeners = new Map();
	let text = "";
	const node = {
		tagName: tagName.toUpperCase(), nodeType: tagName === "#fragment" ? 11 : tagName === "#text" ? 3 : 1,
		children: [], parentNode: null, connected: false, value: "", checked: false, hidden: true, style: {}, scrollLeft: 0,
		get parentElement() { return this.parentNode; },
		get isConnected() { return this.parentNode ? this.parentNode.isConnected : this.connected; },
		get firstChild() { return this.children[0] || null; },
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
		insertBefore(child, reference) { child.remove?.(); child.parentNode = this; this.children.splice(this.children.indexOf(reference), 0, child); return child; },
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
		emit(name, event = {}) { for (const fn of listeners.get(name) || []) fn({ target: this, ...event }); },
		listenerCount() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); },
		focus() {}, scrollIntoView() {}
	};
	const dataName = key => "data-" + String(key).replace(/[A-Z]/g, letter => "-" + letter.toLowerCase());
	node.dataset = new Proxy({}, {
		get: (_, key) => attributes.get(dataName(key)), set: (_, key, value) => { attributes.set(dataName(key), String(value)); return true; },
		deleteProperty: (_, key) => { attributes.delete(dataName(key)); return true; }
	});
	return node;
}

export function uiHarness({ sort = "relevance", search, request, refreshLibraryFlags, popBridge, openDialog, marquee, realRows = false, launchURL = () => {} } = {}) {
	const elements = new Map(), errors = [], events = new Map();
	const get = id => {
		if (!elements.has(id)) { const node = mockElement(); node.connected = true; elements.set(id, node); }
		return elements.get(id);
	};
	const document = {
		getElementById: get, querySelectorAll: () => [], createElement: mockElement,
		createDocumentFragment: () => mockElement("#fragment"),
		querySelector(selector) {
			const match = selector.match(/^#([\w-]+)\s+(.+)$/);
			return match ? get(match[1]).querySelector(match[2]) : null;
		}
	};
	get("keywords").value = "genome editing";
	get("sort").value = sort;
	get("source").value = "openalex";
	get("maxResults").value = "10";
	const apiRecords = [paper("relevant", { title: "Precise match" }),
		paper("popular", { title: "Broad review", citations: 10000, year: 2020 })];
	const context = vm.createContext({
		AbortController,
		window: { addEventListener(name, fn) { events.set(name, fn); }, openDialog },
		document,
		Zotero: { Prefs: { get: () => true, set() {} }, debug() {}, logError: e => errors.push(e), launchURL,
			HTTP: { request: request || (() => { throw new Error("Unexpected HTTP request"); }) } },
		ZotPoPI18N: { make: () => (key, ...args) => [key, ...args].join("|") },
		ZotPoPSources: { SOURCES: { openalex: { label: "OpenAlex" } }, normalizeDOI: Sources.normalizeDOI,
			search: search || (async (_source, query) => query.sort === "citations" ? [...apiRecords].reverse() : [...apiRecords]) },
		ZotPoPPoPBridge: popBridge,
		ZotPoPPreview: Preview,
		ZotPoPMarquee: marquee || { attach: () => ({ refresh() {}, refreshCell() {} }) },
		ZotPoPMetrics: { citesPerYear: () => 1 },
		CSS: { escape: value => value },
		refreshFlags: refreshLibraryFlags || (async () => {})
	});
	let code = fs.readFileSync(new URL("../../content/ui.js", import.meta.url), "utf8");
	// Exercise the actual query, search, HTTP adapter and render functions. Isolate
	// native Zotero library access and individual row/detail widgets only.
	code = code.replace('window.addEventListener("load", init);', `
		refreshLibraryFlags = globalThis.refreshFlags;
		${realRows ? "" : 'buildRow = () => document.createElement("tr");'}
		renderMetrics = renderDetail = () => {};
		globalThis.harness = { state, runSearch, render, http, stopOperation, onKeyDown, clearAll, openPreview, previewRecord, buildRow, setRowStatus, onDocumentScroll, restoreCachedSearch, cancelCacheRestore,
			setOpenSelectForTest: value => { openSel = value; } };
	`);
	vm.runInContext(code, context);
	return { ...context.harness, get, errors, events };
}

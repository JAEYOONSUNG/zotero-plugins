import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { uiHarness, paper, deferred } from "./helpers/search-ui-harness.mjs";

// The saved widths carry the version that wrote them. Read it from the window's
// own source so a bump does not quietly turn these fixtures into stale ones.
const COL_VERSION = Number(/const COL_VERSION = (\d+)/.exec(
	readFileSync(new URL("../content/ui.js", import.meta.url), "utf8"))[1]);

const keys = parent => [...parent.children].map(node => node.dataset.k);
function event(node, type, extra = {}) {
	const value = { clientX: 25, button: 0, ...extra, defaultPrevented: false, stopped: false };
	value.preventDefault = () => { value.defaultPrevented = true; };
	value.stopPropagation = () => { value.stopped = true; };
	node.emit(type, value);
	return value;
}
function transfer() {
	const data = new Map();
	return { setData: (key, value) => data.set(key, value), getData: key => data.get(key) || "", effectAllowed: "", dropEffect: "" };
}
function setup(options = {}) {
	const h = uiHarness({ realRows: true, columns: true, ...options });
	h.restoreLayout(); h.setupColumnOrder(); h.setupColumnResize(); h.applyColumnWidths();
	h.header = key => h.get("results-head").children.find(node => node.dataset.k === key);
	return h;
}
function start(h, source) {
	const th = h.header(source), dataTransfer = transfer();
	event(th, "mousedown"); event(th, "dragstart", { dataTransfer });
	assert.equal(dataTransfer.getData("text/plain"), source);
	assert.equal(dataTransfer.effectAllowed, "move");
	return dataTransfer;
}
function drop(h, source, target, after = false) {
	const dataTransfer = start(h, source), th = h.header(target), clientX = after ? 75 : 25;
	assert.equal(event(th, "dragover", { dataTransfer, clientX }).defaultPrevented, true);
	assert.equal(th.classList.contains(after ? "column-drop-after" : "column-drop-before"), true);
	event(th, "drop", { dataTransfer, clientX }); event(h.header(source), "dragend");
}
function aligned(h, expected) {
	assert.deepEqual(keys(h.get("results-head")), expected);
	assert.deepEqual(keys(h.get("cols")), expected);
	for (const row of h.get("results-body").children) assert.deepEqual(keys(row), expected);
	assert.equal(expected[0], "chk");
}

test("the shipped header, colgroup and actual generated cells share all stable field IDs", () => {
	const markup = readFileSync(new URL("../content/search.xhtml", import.meta.url), "utf8");
	const heads = ["chk", ...[...markup.matchAll(/<th\s[^>]*data-sort="([^"]+)"/g)].map(match => match[1])];
	const h = setup(), row = h.buildRow(paper("schema"));
	assert.deepEqual(heads, keys(h.get("cols")));
	assert.deepEqual(keys(row), heads);
	assert.match(markup, /<tr id="results-head">/);
});

test("header drag moves keyed cells and widths in place while preserving checkbox, links and marquee", () => {
	const launches = [], prefs = { colWidthsVersion: COL_VERSION, colWidths: JSON.stringify({ title: 411, year: 83 }) };
	let refreshed = 0;
	const h = setup({ prefs, launchURL: url => launches.push(url), marquee: { attach: () => ({ refresh: () => refreshed++, refreshCell() {} }) } });
	const rec = paper("one", { rank: 1, url: "https://example.test/paper", title: "Paper", year: 2024, authorString: "Example" });
	h.state.records = [rec]; h.state.selected.add(rec.key); h.render();
	const row = h.get("results-body").firstChild, title = row.querySelector("td.title"), checkbox = row.firstChild.firstChild;
	const titleCol = h.get("cols").children.find(col => col.dataset.k === "title");
	const original = keys(h.get("cols"));
	drop(h, "year", "title");
	const expected = original.filter(key => key !== "year"); expected.splice(expected.indexOf("title"), 0, "year");
	aligned(h, expected);
	assert.equal(h.get("results-body").firstChild, row);
	assert.equal(row.querySelector("td.title"), title);
	assert.equal(row.firstChild.firstChild, checkbox);
	assert.equal(checkbox.checked, true);
	assert.equal(h.state.selected.has(rec.key), true);
	assert.equal(title.dataset.marquee, "title");
	assert.ok(refreshed >= 1);
	assert.equal(titleCol.style.width, "411px");
	assert.equal(h.get("cols").children.find(col => col.dataset.k === "year").style.width, "83px");
	assert.deepEqual(JSON.parse(prefs.colOrder), expected);
	// A click on the title stays in the window; double-click is the way to the browser.
	event(title.firstChild, "click"); assert.deepEqual(launches, []);
	event(row, "dblclick"); assert.deepEqual(launches, [rec.url]);
	checkbox.checked = false; event(checkbox, "change"); assert.equal(h.state.selected.has(rec.key), false);
	const reopened = setup({ prefs }); aligned(reopened, expected);
	assert.equal(reopened.state.colWidths.title, 411);
	assert.equal(reopened.state.colWidths.year, 83);
});

test("successful and cancelled header drags suppress accidental sort clicks, ordinary clicks still sort", () => {
	const h = setup();
	h.state.records = [paper("old", { rank: 1, year: 2000 }), paper("new", { rank: 2, year: 2025 })]; h.render();
	drop(h, "year", "title");
	event(h.header("year"), "click"); assert.equal(h.state.sortKey, "rank");
	event(h.header("year"), "mousedown"); event(h.header("year"), "click");
	assert.equal(h.state.sortKey, "year"); assert.equal(h.state.sortDir, "desc");
	assert.equal(h.state.visible[0].key, "new");
	event(h.header("year"), "mousedown"); event(h.header("year"), "click"); assert.equal(h.state.sortDir, "asc");
	start(h, "title"); event(h.header("title"), "dragend"); event(h.header("title"), "click");
	assert.equal(h.state.sortKey, "year");
});

test("resize grips cannot initiate column drag and width updates remain keyed after reordering", () => {
	const h = setup(); drop(h, "title", "rank", true);
	const th = h.header("title"), grip = th.querySelector(".rz"), before = keys(h.get("cols"));
	event(th, "mousedown", { target: grip, clientX: 10 });
	event(grip, "mousedown", { clientX: 10 });
	assert.equal(event(th, "dragstart", { dataTransfer: transfer() }).defaultPrevented, true);
	h.emitDocument("mousemove", { clientX: 60 }); h.emitDocument("mouseup");
	assert.equal(h.state.colWidths.title, 370);
	assert.equal(h.get("cols").children.find(col => col.dataset.k === "title").style.width, "370px");
	assert.deepEqual(keys(h.get("cols")), before);
	event(th, "click", { target: grip }); assert.equal(h.state.sortKey, "rank");
	assert.equal(JSON.parse(h.prefs.colWidths).title, 370);
});

test("drop after target works both directions and checkbox column stays fixed", () => {
	const h = setup();
	drop(h, "title", "status", true); assert.equal(keys(h.get("cols")).at(-1), "title");
	drop(h, "title", "citations"); assert.equal(keys(h.get("cols"))[1], "title");
	const before = keys(h.get("cols")), saved = h.prefs.colOrder;
	assert.equal(h.header("chk").getAttribute("draggable"), null);
	const dataTransfer = start(h, "year"); event(h.header("chk"), "drop", { dataTransfer }); event(h.header("year"), "dragend");
	aligned(h, before); assert.equal(h.prefs.colOrder, saved);
});

test("invalid saved orders retain known unique fields, append new fields and leave widths unchanged", () => {
	for (const saved of ["bad JSON", "{}", "null", '"title"', '["title","bad","title","chk",4,null]']) {
		const prefs = { colOrder: saved, colWidthsVersion: COL_VERSION, colWidths: '{"title":480,"year":77}' };
		const h = setup({ prefs }), order = keys(h.get("cols"));
		assert.equal(order.length, 16); assert.equal(new Set(order).size, 16); assert.equal(order[0], "chk");
		if (saved.startsWith("[")) assert.equal(order[1], "title");
		assert.equal(prefs.colOrder, saved, "restoring never rewrites user preferences");
		assert.equal(h.state.colWidths.title, 480); assert.equal(h.state.colWidths.year, 77);
	}
});

test("escape, dragend, blur and unload clear highlights without persisting a cancelled order", () => {
	for (const cancel of [h => event(h.header("year"), "dragend"), h => h.emitDocument("keydown", { key: "Escape" }), h => h.emitWindow("blur"), h => h.emitWindow("unload")]) {
		const h = setup(), before = keys(h.get("cols"));
		const dataTransfer = start(h, "year"); event(h.header("title"), "dragover", { dataTransfer });
		cancel(h);
		for (const th of h.get("results-head").children) assert.ok(!/column-(dragging|drop)/.test(th.className));
		event(h.header("title"), "drop", { dataTransfer });
		aligned(h, before); assert.equal(h.prefs.colOrder, undefined);
		event(h.header("title"), "click"); assert.equal(h.state.sortKey, "rank");
	}
});

test("progressive and later rows keep persisted order and status cells update in their new position", async () => {
	const gate = deferred(); let callbacks;
	const h = setup({ search: async (_source, _query, _http, ctx) => { callbacks = ctx; await gate.promise; return [paper("first"), paper("second")]; } });
	drop(h, "status", "citations");
	const expected = keys(h.get("cols")), pending = h.runSearch();
	while (!callbacks) await new Promise(resolve => setImmediate(resolve));
	callbacks.onResults([paper("first")]); aligned(h, expected);
	gate.resolve(); await pending; aligned(h, expected);
	assert.equal(h.get("results-body").children.length, 2);
	const rec = h.state.records[0]; h.setRowStatus(rec, "Complete", "ok");
	assert.equal(h.get("results-body").children[0].children[1].textContent, "Complete");
	h.render(); aligned(h, expected);
	assert.equal(h.get("results-body").children[0].children[1].textContent, "Complete");
});

test("edge drag scrolls wide tables, external drags do not reorder or scroll", () => {
	const h = setup(), wrap = h.get("table-wrap");
	wrap.scrollWidth = 1000; wrap.clientWidth = 100;
	event(wrap, "dragover", { clientX: 99, dataTransfer: transfer() }); assert.equal(wrap.scrollLeft, 0);
	start(h, "title"); event(wrap, "dragover", { clientX: 99 }); assert.equal(wrap.scrollLeft, 28);
	event(wrap, "dragover", { clientX: 1 }); assert.equal(wrap.scrollLeft, 0);
	event(h.header("title"), "dragend");
	assert.equal(h.prefs.colOrder, undefined);
});

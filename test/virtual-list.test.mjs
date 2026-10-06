/* The results list builds only the rows near the viewport. 1,200 results used to build every row (about
   4,300 builds and 123k elements over a streamed search, 2.4 s to the first row in the bench); the rest of
   the list is two spacers whose heights are the measured rows plus a running average for the unmeasured.
   Everything a reader does with rows that are not built yet goes through the data, never the DOM. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { uiHarness, paper, mockElement } from "./helpers/search-ui-harness.mjs";

const read = name => fs.readFileSync(new URL("../content/" + name, import.meta.url), "utf8");
const many = (n = 1200, extra = () => ({})) => Array.from({ length: n }, (_, i) => paper("k" + i, { title: "Paper " + i, doi: "10.5555/k" + i, citations: n - i, ...extra(i) }));
const key = (ui, k, extra = {}) => ui.onKeyDown({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault() {}, stopPropagation() {}, ...extra });
const rowsOf = ui => ui.get("results-body").children;
const builtKeys = ui => rowsOf(ui).map(tr => tr.dataset.key);
const rowOf = (ui, k) => rowsOf(ui).find(tr => tr.dataset.key === k) || null;
const padOf = (ui, which) => parseFloat(ui.get("results-pad-" + which).querySelector("td")?.style.height || "0");
const ROW = 30; // the harness's rows measure 30 px (getBoundingClientRect)
function list(n = 1200, { height = 600, records, ...options } = {}) {
	const ui = uiHarness({ realRows: true, columns: true, ...options });
	ui.get("table-wrap").clientHeight = height;
	ui.get("table-wrap").scrollTop = 0;
	ui.displaySearchResults(records || many(n));
	return ui;
}
const scrollTo = (ui, y) => { ui.get("table-wrap").scrollTop = y; ui.syncWindow(); };
const indexOfKey = (ui, k) => ui.state.visible.findIndex(r => r.key === k);

test("1,200 results: the first draw builds at most 60 rows, and two spacers stand in for the rest", () => {
	const ui = list(1200);
	const n = rowsOf(ui).length;
	assert.ok(n > 0 && n <= 60, n + " rows built");
	assert.deepEqual(builtKeys(ui), ui.state.visible.slice(0, n).map(r => r.key), "the first rows, in order");
	assert.equal(padOf(ui, "top"), 0);
	assert.equal(padOf(ui, "bottom"), (1200 - n) * ROW, "the unbuilt rows at the measured height");
	assert.ok(ui.rowStats.built <= 60, "built " + ui.rowStats.built);
	// A short list has nothing to stand in for.
	const small = list(12);
	assert.equal(rowsOf(small).length, 12);
	assert.equal(padOf(small, "top"), 0); assert.equal(padOf(small, "bottom"), 0);
});

test("scrolling builds the rows near the new position on demand, from the scroll event", async () => {
	const ui = list(1200);
	const wrap = ui.get("table-wrap");
	wrap.scrollTop = 600 * ROW;
	wrap.emit("scroll");
	await new Promise(resolve => setTimeout(resolve, 60));
	const shown = builtKeys(ui);
	assert.ok(shown.length <= 60, shown.length + " rows");
	for (const i of [600, 610]) assert.ok(shown.includes(ui.state.visible[i].key), "row " + i + " is built");
	assert.ok(!shown.includes(ui.state.visible[0].key), "the top rows are let go");
	const start = indexOfKey(ui, shown[0]);
	assert.equal(padOf(ui, "top"), start * ROW);
	assert.equal(padOf(ui, "top") + shown.length * ROW + padOf(ui, "bottom"), 1200 * ROW, "the list keeps its full height");
	// to the very end
	scrollTo(ui, 1200 * ROW);
	assert.equal(builtKeys(ui).at(-1), ui.state.visible[1199].key);
	assert.equal(padOf(ui, "bottom"), 0);
});

test("grid semantics: aria-rowcount counts every result and aria-rowindex is the row's place in the data", () => {
	const ui = list(1200);
	const table = ui.get("results-table");
	assert.equal(table.getAttribute("aria-rowcount"), "1201", "1,200 rows and the header");
	assert.equal(ui.get("results-head").getAttribute("aria-rowindex"), "1");
	for (const [i, tr] of rowsOf(ui).entries()) assert.equal(tr.getAttribute("aria-rowindex"), String(i + 2));
	scrollTo(ui, 800 * ROW);
	const tr = rowOf(ui, ui.state.visible[805].key);
	assert.equal(tr.getAttribute("aria-rowindex"), "807");
	ui.get("filter").value = "Paper 1"; ui.render();
	assert.equal(table.getAttribute("aria-rowcount"), String(ui.state.visible.length + 1), "follows the filter");
	const markup = read("search.xhtml");
	assert.match(markup, /<tbody id="results-pad-top"[^>]*aria-hidden="true"/);
	assert.match(markup, /<tbody id="results-pad-bottom"[^>]*aria-hidden="true"/);
	assert.ok(markup.indexOf('id="results-pad-top"') < markup.indexOf('id="results-body"') && markup.indexOf('id="results-body"') < markup.indexOf('id="results-pad-bottom"'));
});

test("rows are reused: a re-render, a filter and scrolling back build nothing new (round 4)", () => {
	const ui = list(1200);
	const first = new Map(rowsOf(ui).map(tr => [tr.dataset.key, tr]));
	const built = ui.rowStats.built, created = ui.counts.created;
	ui.render();
	ui.get("filter").value = "Paper"; ui.render();
	ui.get("filter").value = ""; ui.render();
	assert.equal(ui.rowStats.built, built, "nothing rebuilt by re-render or filter");
	assert.equal(ui.counts.created, created, "no element created");
	scrollTo(ui, 500 * ROW);
	const afterScroll = ui.rowStats.built;
	assert.ok(afterScroll > built, "the middle is built when reached");
	scrollTo(ui, 0);
	assert.equal(ui.rowStats.built, afterScroll, "the top rows come back from the cache");
	for (const tr of rowsOf(ui)) assert.ok(first.get(tr.dataset.key) === tr, tr.dataset.key + " is the same row");
	// rowSignature still decides: a changed paper is rebuilt when shown
	const r = ui.state.visible[1];
	r.year = 1901; ui.render();
	assert.ok(rowOf(ui, r.key) !== first.get(r.key), "a changed row is rebuilt");
	assert.equal(typeof ui.rowSignature(r), "string");
});

test("while results stream in, a kept row's rank cell is rewritten in place and its checkmark survives (rounds 16 and 20)", () => {
	const ui = list(0);
	ui.state.searching = true;
	const pool = many(1200);
	ui.displaySearchResults(pool);
	scrollTo(ui, 600 * ROW);
	const k = ui.state.visible[605].key;
	ui.state.selected.add(k); ui.render();
	const before = rowOf(ui, k), built = ui.rowStats.built;
	assert.equal(before.querySelector("input").checked, true);
	// The next page puts a new paper first: every rank moves by one.
	ui.displaySearchResults([paper("fresh", { title: "Fresh", doi: "10.5555/fresh", citations: 99999 }), ...pool]);
	const after = rowOf(ui, k);
	assert.ok(after === before, "the same row");
	assert.equal(after.children.find(c => c.dataset.k === "rank").textContent, "607", "its rank cell follows");
	assert.equal(after.querySelector("input").checked, true, "the tick stays");
	assert.equal(after.getAttribute("aria-selected"), "true");
	assert.ok(ui.rowStats.built - built <= 2, "at most the newly reached row is built: " + (ui.rowStats.built - built));
	// A tick on a row that is not built yet shows when it is.
	const far = ui.state.visible[1100].key;
	ui.state.selected.add(far); ui.render();
	scrollTo(ui, 1100 * ROW);
	assert.equal(rowOf(ui, far).querySelector("input").checked, true);
	assert.equal(rowOf(ui, far).getAttribute("aria-selected"), "true");
});

test("keys reach rows that are not built: End, Home, PageDown and the arrows build and show the focused row", () => {
	const ui = list(1200);
	ui.wireEvents();
	const wrap = ui.get("table-wrap");
	mockElement.active = wrap;
	key(ui, "End");
	const last = ui.state.visible[1199];
	assert.equal(ui.state.focusKey, last.key);
	assert.equal(ui.state.detailKey, last.key, "the detail pane follows");
	const tr = rowOf(ui, last.key);
	assert.ok(tr, "the last row is built");
	assert.ok(tr.classList.contains("focused"));
	assert.ok(wrap.scrollTop >= 1200 * ROW - 600, "scrolled to it: " + wrap.scrollTop);
	assert.equal(wrap.getAttribute("aria-activedescendant"), tr.id);
	key(ui, "Home");
	assert.equal(ui.state.focusKey, ui.state.visible[0].key);
	assert.equal(wrap.scrollTop, 0);
	assert.ok(rowOf(ui, ui.state.visible[0].key));
	for (let i = 0; i < 9; i++) key(ui, "PageDown");
	assert.equal(ui.state.focusKey, ui.state.visible[90].key);
	assert.ok(rowOf(ui, ui.state.visible[90].key), "row 90 built");
	assert.equal(wrap.getAttribute("aria-activedescendant"), rowOf(ui, ui.state.visible[90].key).id);
	for (let i = 0; i < 40; i++) key(ui, "ArrowDown");
	const at = ui.state.visible[130];
	assert.equal(ui.state.focusKey, at.key);
	assert.ok(rowOf(ui, at.key), "row 130 built");
	key(ui, "PageUp");
	assert.equal(ui.state.focusKey, ui.state.visible[120].key);
	// Space ticks the row the keys reached, and the row says so.
	key(ui, " ");
	assert.ok(ui.state.selected.has(ui.state.visible[120].key));
	assert.equal(rowOf(ui, ui.state.visible[120].key).getAttribute("aria-selected"), "true");
	// Shift+F10 opens that row's menu; S opens the sort menu.
	key(ui, "End");
	key(ui, "F10", { shiftKey: true });
	assert.equal(ui.get("ctxmenu").hidden, false, "the row menu opens on a row reached by End");
	ui.get("ctxmenu").emit("keydown", { key: "Escape" });
	mockElement.active = wrap;
	key(ui, "s");
	assert.equal(ui.get("tbmenu").hidden, false, "S opens the sort menu");
});

test("aria-activedescendant only ever names a row that exists", () => {
	const ui = list(1200);
	ui.wireEvents();
	const wrap = ui.get("table-wrap");
	mockElement.active = wrap;
	key(ui, "ArrowDown");
	const id = wrap.getAttribute("aria-activedescendant");
	assert.equal(id, rowOf(ui, ui.state.visible[0].key).id);
	// The mouse wheel takes the list far from the focused row: its row is let go, and so is the reference.
	scrollTo(ui, 900 * ROW);
	assert.equal(rowOf(ui, ui.state.visible[0].key), null);
	assert.equal(wrap.getAttribute("aria-activedescendant"), null);
	scrollTo(ui, 0);
	assert.equal(wrap.getAttribute("aria-activedescendant"), id, "back again");
	// The next arrow brings the focused row back into view first.
	scrollTo(ui, 900 * ROW);
	key(ui, "ArrowDown");
	assert.equal(ui.state.focusKey, ui.state.visible[1].key);
	assert.equal(wrap.getAttribute("aria-activedescendant"), rowOf(ui, ui.state.visible[1].key).id);
});

test("selection works on the data: Cmd+A, Shift+End and Shift-click reach rows that were never built", () => {
	const ui = list(1200);
	ui.wireEvents();
	const wrap = ui.get("table-wrap");
	mockElement.active = wrap;
	key(ui, "a", { metaKey: true });
	assert.equal(ui.state.selected.size, 1200);
	assert.equal(ui.get("selected-count").textContent, "selected|1200");
	assert.equal(ui.get("chk-all").checked, true);
	ui.state.selected.clear(); ui.render();
	// Shift+arrows extend a range from where it began, across unbuilt rows.
	key(ui, "Home");
	for (let i = 0; i < 5; i++) key(ui, "ArrowDown");
	for (let i = 0; i < 20; i++) key(ui, "PageDown", { shiftKey: true });
	assert.equal(ui.state.selected.size, 201, "rows 5 to 205");
	assert.ok(ui.state.selected.has(ui.state.visible[5].key) && ui.state.selected.has(ui.state.visible[205].key));
	assert.equal(ui.get("selected-count").textContent, "selected|201");
	// A click, then a Shift-click 900 rows further down: the rows between are picked though never built.
	ui.state.selected.clear(); ui.render();
	scrollTo(ui, 0);
	const a = rowOf(ui, ui.state.visible[2].key);
	a.emit("click", { target: a.children[3] });
	scrollTo(ui, 900 * ROW);
	const b = rowOf(ui, ui.state.visible[902].key);
	b.emit("click", { target: b.children[3], shiftKey: true });
	assert.equal(ui.state.selected.size, 901, "rows 2 to 902");
	assert.equal(ui.state.focusKey, ui.state.visible[902].key);
	assert.equal(b.getAttribute("aria-selected"), "true");
	assert.equal(ui.get("selected-count").textContent, "selected|901");
	// Cmd-click still toggles one.
	const c = rowOf(ui, ui.state.visible[905].key);
	c.emit("click", { target: c.children[3], metaKey: true });
	assert.equal(ui.state.selected.size, 902);
});

test("variable row heights: built rows are measured, the rest estimated by their average, and the first visible row stays put", () => {
	const ui = list(1200);
	const tall = tr => { tr.offsetHeight = 60; };
	// Every other built row wraps its title onto a second line.
	rowsOf(ui).forEach((tr, i) => { if (i % 2) tall(tr); });
	ui.syncWindow();
	const n = rowsOf(ui).length;
	const view = ui.virtualView();
	const avg = view.estimate;
	assert.ok(avg > ROW && avg < 60, "average " + avg);
	assert.ok(Math.abs(padOf(ui, "bottom") - (1200 - n) * avg) < 1, "unbuilt rows at the average");
	// Scroll to the middle and note the first visible row and how far into it the view starts.
	scrollTo(ui, 20000);
	const v1 = ui.virtualView();
	const anchor = v1.firstVisible, offset = ui.get("table-wrap").scrollTop - v1.rowTop(anchor);
	// Now every built row turns out to be 60 px: the estimate above changes, the view must not jump.
	for (const tr of rowsOf(ui)) tall(tr);
	ui.syncWindow();
	const v2 = ui.virtualView();
	assert.equal(ui.state.visible[v2.firstVisible].key, ui.state.visible[anchor].key, "the same row is first");
	assert.ok(Math.abs((ui.get("table-wrap").scrollTop - v2.rowTop(anchor)) - offset) < 1, "at the same offset");
	assert.ok(v2.estimate > avg, "the estimate moved");
	// The spacers and built rows still add up to the model's height.
	const sum = padOf(ui, "top") + rowsOf(ui).reduce((s, tr) => s + (tr.offsetHeight || ROW), 0) + padOf(ui, "bottom");
	assert.ok(Math.abs(sum - v2.total) < 1, sum + " vs " + v2.total);
});

test("CSV and copy citation read the data: every one of 1,200 rows, built or not", () => {
	const ui = list(1200);
	ui.wireEvents();
	assert.ok(rowsOf(ui).length <= 60);
	const csv = ui.csvText().split("\n");
	assert.equal(csv.length, 1201, "a header and 1,200 rows");
	assert.ok(csv.at(-1).includes(ui.state.visible[1199].title));
	mockElement.active = ui.get("table-wrap");
	key(ui, "End");
	key(ui, "c", { metaKey: true });
	assert.ok(ui.copied.at(-1).includes(ui.state.visible[1199].title), ui.copied.at(-1));
});

test("rows far down carry their library mark, zebra and end classes from their place in the data", () => {
	const ui = uiHarness({ realRows: true, columns: true });
	ui.get("table-wrap").clientHeight = 600;
	ui.state.doiMap = new Map([["10.5555/k900", 1]]);
	ui.displaySearchResults(many(1200));
	scrollTo(ui, 900 * ROW);
	const held = rowOf(ui, "k900");
	assert.ok(held.classList.contains("in-library"), "held mark");
	const at = i => rowOf(ui, ui.state.visible[i].key);
	assert.equal(at(901).classList.contains("alt"), true, "the 902nd row is an even (striped) row");
	assert.equal(at(902).classList.contains("alt"), false);
	assert.equal(at(902).classList.contains("v-end"), false);
	scrollTo(ui, 1200 * ROW);
	assert.equal(at(1199).classList.contains("v-end"), true, "the last row of the data has no bottom rule");
	const css = read("search.css");
	assert.doesNotMatch(css, /tbody tr:nth-child\(even\)/, "stripes follow the data, not the built rows");
	assert.doesNotMatch(css, /tbody tr:last-child td/, "the last built row is not the last row");
	assert.match(css, /\.v-pad/);
});

test("a column order chosen while scrolled applies to rows built afterwards", () => {
	const ui = list(1200);
	const order = ui.normalizeColumnOrder(["chk", "year", "title"]);
	ui.state.colOrder = order; ui.render();
	scrollTo(ui, 700 * ROW);
	const tr = rowOf(ui, ui.state.visible[705].key);
	assert.deepEqual(tr.children.map(c => c.dataset.k), [...order]);
	// the spacer cell spans every column
	assert.equal(ui.get("results-pad-top").querySelector("td").getAttribute("colspan"), String(order.length));
});

test("every header cell stays stuck at the top while rows scroll under it (the Cited header used to scroll away)", () => {
	const css = read("search.css");
	const offenders = [];
	for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
		const position = /(?:^|;)\s*position:\s*([\w-]+)/.exec(body)?.[1];
		if (!position || position === "sticky") continue;
		for (const part of selectors.split(",")) if (/#results-table th(?:\[[^\]]+\]|\.[\w-]+|:[\w-]+)*\s*$/.test(part.trim())) offenders.push(part.trim() + " -> " + position);
	}
	assert.deepEqual(offenders, []);
});

test("a filter typed while scrolled deep: the view ends at the shorter list's bottom with no blank stretch", () => {
	const ui = list(1200);
	scrollTo(ui, 900 * ROW);
	ui.get("filter").value = "Paper 11"; ui.render();
	const n = ui.state.visible.length;
	assert.ok(n > 100 && n < 200, n + " rows match (titles and DOIs)");
	const shown = builtKeys(ui);
	assert.equal(shown.at(-1), ui.state.visible[n - 1].key, "the last rows are built");
	assert.ok(shown.length >= Math.ceil(570 / ROW), "a screenful: " + shown.length);
	assert.equal(padOf(ui, "top") + shown.length * ROW + padOf(ui, "bottom"), n * ROW);
	// Clearing it from the same place keeps the rows near the view built.
	ui.get("filter").value = ""; ui.render();
	assert.ok(rowsOf(ui).length <= 60);
});

test("the detail pane opens for a row reached far down, from a click and from the keys", () => {
	const ui = list(1200);
	ui.wireEvents();
	scrollTo(ui, 1000 * ROW);
	const target = ui.state.visible[1004], tr = rowOf(ui, target.key);
	tr.emit("click", { target: tr.children[3] });
	assert.equal(ui.state.detailKey, target.key);
	ui.originalRenderDetail();
	assert.equal(ui.get("d-title").textContent, target.title);
	mockElement.active = ui.get("table-wrap");
	key(ui, "Home");
	ui.originalRenderDetail();
	assert.equal(ui.get("d-title").textContent, ui.state.visible[0].title);
});

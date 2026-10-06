import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mockElement, paper, uiHarness } from "./helpers/search-ui-harness.mjs";
import Sources from "../content/sources.js";
import JournalMarks from "../content/journal-marks.js";
import I18N from "../content/i18n.js";

const css = readFileSync(new URL("../content/search.css", import.meta.url), "utf8");
const markup = readFileSync(new URL("../content/search.xhtml", import.meta.url), "utf8");

const rows = () => [paper("a", { title: "Alpha", year: 2020 }), paper("b", { title: "Beta", year: 2021 }), paper("c", { title: "Gamma", year: 2022 }), paper("d", { title: "Delta", year: 2023 })];
async function loaded(options = {}) {
	const ui = uiHarness({ realRows: true, search: async () => rows(), ...options });
	await ui.runSearch(); ui.wireEvents();
	ui.state.records.forEach(r => { r.inLibrary = r.key === "b"; });
	ui.render();
	return ui;
}
const menuItems = ui => ui.get("tbmenu").children.filter(c => c.tagName === "DIV" && c.className !== "selhead");

test("selected-only answers by selection alone, and the other filters return when it is turned off", async () => {
	const ui = await loaded();
	const [a, b] = ui.state.records;
	ui.state.selected.add("a");
	ui.state.libraryFilter = "owned";
	ui.state.yearRange = { from: 2030, to: 2031 };
	assert.equal(ui.matchesFilter(a, "zzz"), false, "without the mode, the filters apply");
	ui.state.selectedOnly = true;
	assert.equal(ui.matchesFilter(a, "zzz"), true, "a checked paper shows whatever the text, year or library filter says");
	assert.equal(ui.matchesFilter(b, ""), false, "an unchecked one never shows");
	ui.state.selectedOnly = false;
	assert.equal(ui.matchesFilter(a, "zzz"), false);
	assert.equal(ui.matchesFilter(a, "", true), false, "the library filter is back: a is not owned");
	assert.equal(ui.matchesFilter(b, "", true), true);
});

test("the library filter counts after the other filters, keeps the checks and follows an import", async () => {
	const importer = { getReadingStates: async () => new Map(), getLibraryDOIMap: async () => new Map(), forgetTitleIndex() {},
		importRecord: async r => r.key === "c" ? { status: "failed", error: "nope" } : { status: "added", item: { id: 9 }, pdf: "no pdf", how: "translator" } };
	const ui = await loaded({ importer });
	const line = () => ["lib-all", "lib-new", "lib-owned"].map(id => ui.get(id).textContent).join(" / ");
	assert.equal(line(), "libAll 4 / libNew 3 / libOwned 1");
	ui.get("filter").value = "a";
	ui.render();
	assert.equal(line(), "libAll 4 / libNew 3 / libOwned 1", "Alpha, Beta, Gamma and Delta all contain an a");
	ui.get("filter").value = "et";
	ui.render();
	assert.equal(line(), "libAll 1 / libNew 0 / libOwned 1", "counts follow the text filter");
	ui.get("filter").value = "";
	ui.state.selected.add("a");
	ui.get("lib-new").emit("click");
	assert.deepEqual(Array.from(ui.state.visible, r => r.key).sort(), ["a", "c", "d"]);
	assert.equal(ui.get("lib-new").getAttribute("aria-pressed"), "true");
	assert.equal(line(), "libAll 4 / libNew 3 / libOwned 1", "the filter's own choice does not change the counts");
	ui.get("lib-owned").emit("click");
	assert.deepEqual(Array.from(ui.state.visible, r => r.key), ["b"]);
	assert.deepEqual(Array.from(ui.state.selected), ["a"], "changing the filter keeps the checks");
	ui.get("lib-new").emit("click");
	for (const key of ["a", "c"]) ui.state.selected.add(key);
	await ui.importRecords(ui.state.records.filter(r => ui.state.selected.has(r.key)));
	assert.equal(line(), "libAll 4 / libNew 2 / libOwned 2", "one paper was added, one failed");
	assert.deepEqual(Array.from(ui.state.visible, r => r.key).sort(), ["c", "d"], "the added paper left the not-owned list");
	assert.deepEqual(Array.from(ui.state.selected), ["c"]);
});

test("a failed add from the detail alone leaves the paper selected", async () => {
	const importer = { getReadingStates: async () => new Map(), getLibraryDOIMap: async () => new Map(), forgetTitleIndex() {},
		importRecord: async () => ({ status: "failed", error: "nope" }) };
	const ui = await loaded({ importer });
	assert.equal(ui.state.selected.size, 0);
	await ui.importRecords([ui.state.records[0]]);
	assert.deepEqual(Array.from(ui.state.selected), ["a"]);
	assert.equal(ui.state.records[0].statusTitle, "nope", "the cause is kept for the detail to say");
});

test("the toolbar menus open on a click, move with the arrows, run on Enter and give focus back on Escape", async () => {
	const ui = await loaded();
	const btn = ui.get("view-btn"), menu = ui.get("tbmenu");
	btn.emit("click", { detail: 0 });
	assert.equal(menu.hidden, false);
	assert.equal(btn.getAttribute("aria-expanded"), "true");
	assert.deepEqual(menuItems(ui).map(n => n.getAttribute("role")), ["menuitemradio", "menuitemradio", "menuitemcheckbox", "menuitemcheckbox", "menuitemcheckbox", "menuitem", "menuitem", "menuitemradio", "menuitemradio", "menuitemradio"], "five view items, Sort by and Keyboard shortcuts, then the three languages");
	assert.equal(mockElement.active, menuItems(ui)[0], "opened from the keyboard, focus lands on the first item");
	menu.emit("keydown", { key: "ArrowDown" });
	assert.equal(mockElement.active, menuItems(ui)[1]);
	menu.emit("keydown", { key: "ArrowUp" }); menu.emit("keydown", { key: "ArrowUp" });
	assert.equal(mockElement.active, menuItems(ui).at(-1), "the list wraps");
	menu.emit("keydown", { key: "Home" }); menu.emit("keydown", { key: "ArrowDown" });
	menu.emit("keydown", { key: "Enter" });
	assert.equal(ui.state.colsMode, "all", "Enter on 'Columns: all' runs it");
	assert.equal(menu.hidden, true);
	assert.equal(btn.getAttribute("aria-expanded"), "false");
	assert.equal(mockElement.active, btn, "and focus returns to the button");
	btn.emit("click", { detail: 0 });
	assert.deepEqual(menuItems(ui).slice(0, 2).map(n => n.getAttribute("aria-checked")), ["false", "true"], "the chosen column view is marked");
	menu.emit("keydown", { key: "Escape" });
	assert.equal(menu.hidden, true);
	assert.equal(mockElement.active, btn);
	assert.equal(ui.state.colsMode, "all", "Escape changes nothing");
	ui.get("export-btn").emit("click", { detail: 0 });
	ui.onKeyDown({ key: "Escape", preventDefault() {} });
	assert.equal(menu.hidden, true, "Escape on the document closes it too");
	assert.equal(mockElement.active, ui.get("export-btn"));
	// a disabled item does nothing, and another menu replaces the open one
	ui.state.detailKey = "a";
	ui.get("d-more").emit("click", { detail: 0 });
	assert.equal(menuItems(ui)[0].getAttribute("aria-disabled"), "true", "no URL, no 'Open in browser'");
	menuItems(ui)[0].emit("click");
	assert.equal(menu.hidden, false, "a disabled item leaves the menu open");
	ui.get("view-btn").emit("click");
	assert.equal(ui.get("d-more").getAttribute("aria-expanded"), "false");
	assert.equal(menuItems(ui).length, 10);
});

test("the sort arrow is its own node beside the header's text and aria-sort follows it", async () => {
	const ui = uiHarness({ realRows: true, columns: true, search: async () => rows() });
	await ui.runSearch();
	ui.state.sortKey = "cpy"; ui.state.sortDir = "desc";
	ui.render();
	const heads = ui.get("results-head").children;
	const th = key => heads.find(h => h.dataset.sort === key);
	assert.equal(th("cpy").getAttribute("aria-sort"), "descending");
	assert.ok(th("cpy").classList.contains("sorted-desc"), "the chevron is drawn by the stylesheet from the header's class");
	assert.equal(th("cpy").querySelector(".sort-mark").textContent, "", "no glyph that could differ from the header text");
	assert.equal(th("cpy").children[0].className, "sort-mark", "the mark sits before the resize grip, after the label");
	assert.equal(th("citations").hasAttribute("aria-sort"), false, "the neighbouring column carries nothing");
	assert.equal(th("citations").querySelector(".sort-mark").textContent, "");
	ui.state.sortDir = "asc"; ui.render();
	assert.equal(th("cpy").getAttribute("aria-sort"), "ascending");
	assert.ok(th("cpy").classList.contains("sorted-asc"));
	assert.equal(th("cpy").querySelectorAll(".sort-mark").length, 1);
	assert.doesNotMatch(css, /sorted-(asc|desc)::after/, "no arrow is painted at the cell's edge any more");
});

test("the markup folds the long metadata, keeps one preview button and the detail actions (queue only with Style Custom)", () => {
	assert.equal((markup.match(/id="preview-btn"/g) || []).length, 1);
	for (const gone of ["select-new", "copy-csv", "save-csv", "cols-mode", "toggle-metrics", "toggle-detail", "copy-pop-json", "d-preview", "d-open", "d-add"]) assert.ok(!markup.includes(`id="${gone}"`), gone + " moved into a menu");
	const actions = /<div class="d-actions">([\s\S]*?)<\/div>/.exec(markup)[1];
	assert.deepEqual([...actions.matchAll(/<button id="([^"]+)"/g)].map(m => m[1]), ["d-queue", "d-primary", "d-more"]);
	const at = id => markup.indexOf(`id="${id}"`);
	assert.ok(at("d-authors") < at("d-fold") && at("d-fold") < at("d-abstract"), "the disclosure row sits above the abstract, so a short pane scrolls the abstract and never hides the disclosure");
	const fold = markup.slice(at("d-fold"), markup.indexOf("</details>", at("d-fold")));
	for (const id of ["d-facets", "d-where", "d-meta"]) assert.ok(fold.includes(`id="${id}"`), id + " is inside the fold");
	assert.ok(!/id="d-versions"[^>]*>[\s\S]{0,4}<\/div>[\s\S]*class="badge ver"/.test(markup) && !css.includes(".badge.ver"), "no version badge");
});

test("dashboard rules in the stylesheet (user direction 2026-10-01, replacing the plain-UI 7px corners): corners of 4px or more, text of 11px or more, no shadow on menus, 11px menu notes", () => {
	for (const m of css.matchAll(/border-radius:\s*([^;}]+)/g)) for (const px of m[1].matchAll(/([\d.]+)px/g)) assert.ok(Number(px[1]) >= 4, "radius " + m[0]);
	for (const m of css.matchAll(/(?<![-\w])font-size:\s*([\d.]+)px/g)) assert.ok(Number(m[1]) >= 11, m[0]);
	const block = sel => new RegExp("(?:^|\\n)" + sel.replace(/[.[\]()*+?^$|]/g, "\\$&") + "\\s*\\{([^}]*)\\}").exec(css)[1];
	// every popover shares one radius and one soft shadow (review 2026-10-03: menus were flat while the filter and cite cards floated)
	assert.match(block(".ctxmenu"), /box-shadow: var\(--pop-shadow\)/);
	assert.match(block(".selmenu"), /box-shadow: var\(--pop-shadow\)/);
	assert.ok(Number(/font-size:\s*([\d.]+)px/.exec(block(".histmenu .histopt .h-meta"))[1]) >= 11);
	for (const sel of ["input[type=text], input[type=number], input[type=search], select", "button", ".sel-btn"]) assert.match(block(sel), /border-radius:\s*(10px|999px)/, sel);
	assert.match(css, /\.toolbar \{[^}]*flex-wrap: nowrap/, "the toolbar stays on one line where it fits");
	// Below 1440px (the line ran past the edge from 1280 to 1420) the actions take a second row, at the right.
	const narrow = /@media \(max-width: 1439px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] || "";
	assert.match(narrow, /\.toolbar \{[^}]*flex-wrap: wrap/);
	assert.match(narrow, /\.toolbar > \.spacer \{[^}]*flex: 1 0 100%/);
	assert.match(narrow, /#preview-btn \{[^}]*margin-inline-start: auto/);
});

// WCAG contrast, from the stylesheet's own tokens.
const hexRGB = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const lum = c => { const f = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const over = (base, rgba) => { const [r, g, b, a] = rgba; return base.map((v, i) => v * (1 - a) + [r, g, b][i] * a); };
const hslRGB = (h, s, l) => { const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2; const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]; return [r, g, b].map(v => (v + m) * 255); };
function tokens(scheme) {
	const light = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)"));
	const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"), css.indexOf("* { box-sizing"));
	const block = scheme === "dark" ? dark : light, out = {};
	for (const m of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
	return out;
}
const rgbaOf = v => { const m = /rgba\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/.exec(v); return m.slice(1).map(Number); };

for (const scheme of ["light", "dark"]) {
	test(`status, muted and journal inks clear 4.5:1 on ${scheme} rows, plain and selected`, () => {
		// Rows are drawn on the white / dark card; the lightest dark row and the darkest light row is the focused one (selected plus hover).
		const tk = tokens(scheme), page = hexRGB(tk.card), selected = over(page, rgbaOf(tk["row-sel"])), focused = over(selected, rgbaOf(tk["row-hover"]));
		for (const name of ["ok", "warn", "err", "muted", "accent-ink"]) for (const [what, bg] of [["row", page], ["selected row", selected], ["focused row", focused]]) {
			assert.ok(ratio(hexRGB(tk[name]), bg) >= 4.5, `--${name} on a ${what} (${scheme}): ${ratio(hexRGB(tk[name]), bg).toFixed(2)}`);
		}
		// every hue the derived journal colours can take, and every exact brand code
		const inks = [];
		for (let hue = 0; hue < 360; hue += 5) for (const known of [true, false]) inks.push(JournalMarks.colours({ hue, known }, { dark: scheme === "dark" }).ink);
		for (const hex of Object.values(JournalMarks.JOURNAL_COLOURS)) inks.push(JournalMarks.tonesFor(hex, scheme === "dark").ink);
		for (const ink of inks) {
			const [h, s, l] = /hsl\((\d+) (\d+)% (\d+)%\)/.exec(ink).slice(1).map(Number);
			for (const bg of [page, selected, focused]) assert.ok(ratio(hslRGB(h, s / 100, l / 100), bg) >= 4.5, `${ink} (${scheme}) ${ratio(hslRGB(h, s / 100, l / 100), bg).toFixed(2)}`);
		}
	});
}

test("both locales word the new controls, and the PDF and column tips say what is true", () => {
	const keys = ["libFilterLabel", "libAll", "libNew", "libOwned", "libFilterTip", "exportMenu", "exportTip", "viewMenu", "viewTip", "detailToggle", "dShowLibrary", "dMore", "dMoreTip", "dFold", "statusLine", "verPublished", "verPreprint", "verOwned", "verNotOwned", "verShow", "verGone", "verEstimateTip", "verExplicitTip"];
	for (const locale of ["en", "ko"]) {
		const t = I18N.make(locale);
		for (const key of keys) assert.notEqual(t(key, 1), key, `${locale}: ${key}`);
	}
	const ko = I18N.make("ko"), en = I18N.make("en");
	assert.equal(ko("libAll") + " / " + ko("libNew") + " / " + ko("libOwned"), "전체 / 미보유 / 보유");
	assert.equal(en("libAll") + " / " + en("libNew") + " / " + en("libOwned"), "All / Not in library / In library");
	for (const t of [ko, en]) {
		assert.match(t("evPdf") + t("thPdfClickTip"), /후보|candidate/i);
		assert.match(t("evPdf"), /후보|candidate/i);
		assert.match(t("thPdfClickTip"), /후보|candidate/i);
	}
	assert.ok(!/상세에는 그대로/.test(ko("colsModeTip")) && /순위는 없/.test(ko("colsModeTip")), "the rank is not in the detail");
	assert.ok(/not the rank/.test(en("colsModeTip")));
	assert.equal(ko("verPublished", true), "출판본 추정");
	assert.equal(ko("verPublished", false), "출판본");
});

test("version links keep the target's key and why they were made; a similar unrelated title stays unlinked", () => {
	const mk = extra => Sources.makeRecord({ source: "crossref", title: "Genome engineering through improved recombinase specificity", year: 2025, authors: [{ name: "Alice Smith" }], ...extra });
	const pre = mk({ sourceId: "p", doi: "10.1234/pre", itemType: "preprint", venue: "bioRxiv" });
	const pub = mk({ sourceId: "q", doi: "10.1234/pub", venue: "Nature" });
	const similar = mk({ sourceId: "s", doi: "10.1234/sim", title: "Genome engineering through improved recombinase specificity: a commentary", venue: "Nature", authors: [{ name: "Bob Brown" }] });
	Sources.linkPreprintVersions([pre, pub, similar]);
	assert.deepEqual({ ...pre.publishedAs }, { key: pub.key, title: pub.title, doi: "10.1234/pub", venue: "Nature", year: 2025, basis: "title" });
	assert.deepEqual({ ...pub.preprintOf }, { key: pre.key, title: pre.title, doi: "10.1234/pre", venue: "bioRxiv", year: 2025, basis: "title" });
	assert.equal(similar.preprintOf, undefined);
	const explicit = mk({ sourceId: "e", doi: "10.1234/e", itemType: "preprint", title: "A different title", publishedDoi: "10.1234/pub" });
	Sources.linkPreprintVersions([explicit, pub]);
	assert.equal(explicit.publishedAs.basis, "explicit");
	assert.equal(explicit.publishedAs.key, pub.key);
});

test("the detail names the other version, whether the library has it, and jumps to it without touching either", async () => {
	const pre = paper("pre", { title: "Preprint", year: 2026, venue: "bioRxiv", doi: "10.1/pre", publishedAs: { key: "pub", doi: "10.1/pub", venue: "Cell", year: 2025, basis: "title" } });
	const pub = paper("pub", { title: "Published", year: 2025, venue: "Cell", doi: "10.1/pub", preprintOf: { key: "pre", doi: "10.1/pre", venue: "bioRxiv", year: 2026, basis: "explicit" } });
	const ui = uiHarness({ realRows: true, search: async () => [pre, pub] });
	await ui.runSearch(); ui.wireEvents();
	ui.state.records.find(r => r.key === "pub").inLibrary = true;
	ui.state.selected.add("pre");
	ui.renderVersions(ui.state.records.find(r => r.key === "pre"));
	assert.equal(ui.get("d-versions").hidden, false);
	assert.equal(ui.get("d-versions").textContent, "verPublished|true: Cell · 2025 · verOwned · verShow", "an estimated link is worded as one");
	assert.doesNotMatch(ui.get("d-versions").textContent, /badge/);
	ui.renderVersions(ui.state.records.find(r => r.key === "pub"));
	assert.equal(ui.get("d-versions").textContent, "verPreprint|false: bioRxiv · 2026 · verNotOwned · verShow");
	ui.state.libraryFilter = "owned"; ui.render();
	assert.deepEqual(Array.from(ui.state.visible, r => r.key), ["pub"]);
	ui.revealRecord("pre");
	assert.equal(ui.state.detailKey, "pre");
	assert.equal(ui.state.libraryFilter, "all", "a filter that hid the target is let go");
	assert.equal(ui.state.visible.length, 2);
	assert.deepEqual(Array.from(ui.state.selected), ["pre"], "selection is untouched");
	assert.equal(ui.state.records.find(r => r.key === "pub").doi, "10.1/pub");
	assert.equal(ui.state.records.find(r => r.key === "pre").doi, "10.1/pre");
});

// ---- journal ink for both themes (fix round): chosen by the stylesheet, never by matchMedia at draw time
test("the journal name and the detail chip carry the ink of both themes, and the stylesheet chooses", async () => {
	const ui = uiHarness({ realRows: true, search: async () => [paper("sci", { venue: "Science", publisher: "American Association for the Advancement of Science (AAAS)" }), paper("none", { venue: "" })] });
	await ui.runSearch(); ui.wireEvents();
	const cell = ui.get("results-body").children[0].querySelector("td.venue");
	const chip = ui.journalMark(ui.state.records[0]);
	assert.ok(chip, "the detail shows the journal chip");
	for (const el of [cell, chip]) {
		for (const name of ["ink", "fill", "edge"]) for (const suffix of ["l", "d"]) assert.ok(el.style[`--j-${name}-${suffix}`], `--j-${name}-${suffix} is set on ${el.className}`);
		assert.notEqual(el.style["--j-ink-l"], el.style["--j-ink-d"], "two different inks");
		assert.equal(el.style.color, undefined, "no inline colour pins one theme");
		assert.equal(el.style.background, undefined, "no inline background either: the chip is the tinted pair, not the raw brand colour");
	}
	// The dark ink is the dark page's ink: it is light, and it clears 4.5:1 on the dark card.
	const [h, s, l] = /hsl\((\d+) (\d+)% (\d+)%\)/.exec(cell.style["--j-ink-d"]).slice(1).map(Number);
	assert.ok(ratio(hslRGB(h, s / 100, l / 100), hexRGB(tokens("dark").card)) >= 4.5, "dark ink on the dark card: " + cell.style["--j-ink-d"]);
	// The stylesheet picks by prefers-color-scheme; the raw brand colour is not worn by the chip.
	assert.match(css, /\.venue-known \{[^}]*color: var\(--j-ink\)/);
	assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*\.venue-known \{ --j-ink: var\(--j-ink-d\)/);
	assert.match(css, /\.jmark \{[^}]*background: var\(--j-fill\)/);
	assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*\.venue-known \{[^}]*\}\s*\.jmark \{ --j-ink: var\(--j-ink-d\); --j-fill: var\(--j-fill-d\)/);
	assert.doesNotMatch(read_("content/ui.js"), /matchMedia\?\.\("\(prefers-color-scheme/, "the ink is no longer decided when the row is drawn");
});
function read_(name) { return readFileSync(new URL("../" + name, import.meta.url), "utf8"); }

test("no focus ring is drawn inside a rounded card: half of it showed as dark 'nails' on the card's sides", () => {
	// An inset ring (negative outline-offset) on a scroller is clipped by its header and fade and
	// leaves only the curved left and right edges. The focused row carries keyboard position instead.
	assert.doesNotMatch(css, /outline-offset:\s*-\d/, "no inset focus rings");
	assert.match(css, /\.table-wrap:focus-visible\s*\{\s*outline:\s*none;\s*\}/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseHTML } from "linkedom";
import Tip from "../content/tooltip.js";
import { uiHarness, paper } from "./helpers/search-ui-harness.mjs";

const read = file => fs.readFileSync(new URL("../" + file, import.meta.url), "utf8");
const view = { w: 1000, h: 700 };

test("hover card placement: below the anchor, flipped above when there is no room, clamped inside the window, never over the anchor", () => {
	const anchor = { left: 100, top: 100, right: 400, bottom: 140 }, size = { w: 300, h: 120 };
	let p = Tip.place({ anchor, size, view, cursor: { x: 200, y: 120 } });
	assert.equal(p.side, "below"); assert.equal(p.top, 140 + 8); assert.equal(p.left, 184, "starts a little left of the pointer");
	assert.ok(!(200 >= p.left && 200 <= p.left + 300 && 120 >= p.top && 120 <= p.top + 120), "the pointer is not under the card");
	p = Tip.place({ anchor: { left: 100, top: 600, right: 400, bottom: 640 }, size, view, cursor: { x: 200, y: 620 } });
	assert.equal(p.side, "above"); assert.equal(p.top, 600 - 8 - 120);
	p = Tip.place({ anchor: { left: 900, top: 100, right: 990, bottom: 140 }, size, view, cursor: { x: 980, y: 120 } });
	assert.equal(p.left, 1000 - 8 - 300, "clamped at the right edge");
	p = Tip.place({ anchor: { left: 0, top: 100, right: 20, bottom: 140 }, size, view, cursor: { x: 2, y: 120 } });
	assert.equal(p.left, 8, "clamped at the left edge");
	p = Tip.place({ anchor, size: { w: 300, h: 900 }, view, cursor: null });
	assert.ok(p.maxHeight > 0 && p.maxHeight < 900 && p.top >= 8, "a card taller than the window is cut to the room it has");
	assert.equal(p.left, 100, "without a pointer (keyboard focus) it aligns with the anchor");
	p = Tip.place({ anchor, size, view, cursor: { x: 200, y: 160 } });
	assert.ok(p.top > 160, "a pointer outside the anchor, under the card, is stepped past");
});

test("set() replaces the native title and keeps an accessible name", () => {
	const { document } = parseHTML("<body><button id=b></button><button id=w>Add</button><input id=i></body>");
	const b = document.getElementById("b"), w = document.getElementById("w"), i = document.getElementById("i");
	for (const el of [b, w, i]) el.setAttribute("title", "old");
	Tip.set(b, "Open the paper\nline two"); Tip.set(w, "Adds it"); Tip.set(i, "Search help");
	for (const el of [b, w, i]) { assert.equal(el.hasAttribute("title"), false); assert.ok(el.getAttribute("data-tip")); }
	assert.equal(b.getAttribute("aria-label"), "Open the paper", "an icon-only button is named by its tip");
	assert.equal(w.hasAttribute("aria-label"), false, "a button with words keeps them");
	assert.equal(i.getAttribute("aria-description"), "Search help", "a field keeps its label and gets the tip as a description");
	Tip.set(b, ""); assert.equal(b.hasAttribute("data-tip"), false);
});

function stage(rich) {
	const { document } = parseHTML('<body><table><tbody><tr data-key="k"><td id="plain" data-tip="Full text of a cut cell">short</td><td id="rich" data-tip-kind="title" title="borrowed">x<span id="inner" data-marquee="title" title="rolling text">y</span></td></tr></tbody></table></body>');
	const win = { document, setTimeout, clearTimeout, addEventListener() {}, innerWidth: 1000, innerHeight: 700 };
	const tip = Tip.attach(win, { delay: 0, rich });
	const fire = (el, type, extra = {}) => { const e = new document.defaultView.Event(type, { bubbles: true, cancelable: true }); Object.assign(e, extra); el.dispatchEvent(e); };
	return { document, tip, fire };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

test("one delegated listener: hover shows the card after the delay, a title taken over, Escape hides it", async () => {
	const { document, tip, fire } = stage(() => { const d = document_().createElement("div"); d.textContent = "rich body"; return d; });
	function document_() { return globalThis.__doc || (globalThis.__doc = parseHTML("<body></body>").document); }
	const plain = document.getElementById("plain");
	fire(plain, "mouseover", { clientX: 10, clientY: 10 });
	await wait(30);
	assert.equal(tip.open, true);
	assert.equal(tip.card.textContent, "Full text of a cut cell");
	assert.equal(plain.getAttribute("aria-describedby"), "tip-card");
	fire(document, "keydown", { key: "Escape" });
	assert.equal(tip.open, false, "Escape hides it");
	assert.equal(plain.hasAttribute("aria-describedby"), false);
	// a rolling cell's borrowed title never shadows the rich card, and no native title is left to double up
	const inner = document.getElementById("inner");
	fire(inner, "mouseover", { clientX: 10, clientY: 10 });
	await wait(30);
	assert.equal(tip.card.textContent, "rich body");
	assert.equal(document.getElementById("rich").hasAttribute("title"), false);
	assert.equal(inner.hasAttribute("title"), false);
	fire(document, "scroll"); assert.equal(tip.open, false, "scrolling hides it");
});

test("keyboard focus shows the card at once and focus leaving hides it", async () => {
	const { document, tip, fire } = stage();
	const plain = document.getElementById("plain");
	fire(plain, "focusin");
	assert.equal(tip.open, true, "no delay for the keyboard");
	fire(plain, "focusout");
	assert.equal(tip.open, false);
});

test("the cells' hover cards are built from the record: title, institution, journal, authors", async () => {
	const person = (name, over) => ({ name, position: "middle", corresponding: false, institution: "", institutionId: null, country: null, institutionH: null, ...over });
	const ui = uiHarness({ realRows: true, metrics: { citesPerYear: () => 12.5 }, search: async () => [
		paper("p", { title: "A long paper title about loop extrusion", venue: "Science", year: 2025, citations: 40, publisher: "AAAS", journalIF: 45.8, journalIFEstimate: true, url: "https://example.invalid/p",
			authors: ["A", "B", "C", "D", "E", "F", "G", "H"].map(name => ({ name })), authorString: "A, B, C, D, E, F, G, H",
			people: ["A", "B", "C", "D", "E", "F", "G", "H"].map((name, i) => person(name, i === 0 ? { position: "first", institution: "Hanbit University", country: "KR", institutionH: 640 } : i === 7 ? { position: "last", corresponding: true, institution: "Lumen University", country: "CN", institutionH: 1510 } : {})) })
	] });
	await ui.runSearch();
	const row = ui.get("results-body").firstChild, cell = k => row.children.find(c => c.dataset.k === k);
	const text = (k, kind) => ui.tipContent(cell(k), kind).textContent;
	const title = text("title", "title");
	assert.ok(title.startsWith("A long paper title about loop extrusion"));
	assert.ok(title.includes("Science · 2025 · tipCites|40 · tipPerYear|12.5"), "journal, year, cites and per-year line");
	assert.ok(title.includes("A, B, C, D, E, F") && title.includes("authorsMore|2") && !title.includes("G,"), "first six authors, then +N");
	assert.ok(title.includes("affFirst") && title.includes("Hanbit University") && title.includes("affCorresponding") && title.includes("Lumen University"), "first and corresponding institutions");
	assert.ok(title.includes("titleOpenTip"));
	const aff = text("affiliation", "aff");
	assert.ok(aff.startsWith("Lumen University") && aff.includes("tipTierAbove|1510|T1|1400") && aff.includes("affCorresponding"), aff);
	const journal = text("venue", "journal");
	assert.ok(journal.startsWith("Science") && journal.includes("AAAS") && journal.includes("45.8") && journal.includes("tipEstimate"), journal);
	const authors = text("authorString", "authors");
	assert.ok(authors.includes("tipAuthorsAll|8") && authors.includes("H*") && authors.includes("affCorresponding"), authors);
	for (const k of ["title", "affiliation", "venue", "authorString"]) assert.equal(cell(k).getAttribute("title"), null, k + " has no native title");
});

test("the window uses the hover card and no native title", () => {
	const ui = read("content/ui.js"), html = read("content/search.xhtml"), css = read("content/search.css"), i18n = read("content/i18n.js");
	assert.ok(html.indexOf("content/tooltip.js") > 0 && html.indexOf("content/tooltip.js") < html.indexOf("content/ui.js"));
	assert.doesNotMatch(ui.replace("document.title =", ""), /\.title\s*=[^=]|setAttribute\("title"/, "ui.js sets data-tip through tip(), never title");
	assert.doesNotMatch(html, /\stitle="/, "the markup carries data-i18n-title, which i18n turns into data-tip");
	assert.doesNotMatch(i18n, /setAttribute\("title"/);
	const block = (/(?:^|\n)\.tip-card\s*\{([^}]*)\}/.exec(css) || [])[1] || "";
	assert.match(block, /border-radius:\s*12px/); assert.match(block, /padding:\s*10px 12px/); assert.match(block, /max-width:\s*420px/);
	assert.match(block, /pointer-events:\s*none/); assert.match(block, /transition:[^;]*\.12s/);
	// Menus stay flat (toolbar-detail.test.mjs); the hover card floats over the table, so it is allowed its soft shadow.
	assert.match(block, /box-shadow/);
});

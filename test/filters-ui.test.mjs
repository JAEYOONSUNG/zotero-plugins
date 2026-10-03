import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mockElement, paper, uiHarness } from "./helpers/search-ui-harness.mjs";
import { buildPreview } from "../scripts/search-preview.mjs";

const css = readFileSync(new URL("../content/search.css", import.meta.url), "utf8");
const markup = readFileSync(new URL("../content/search.xhtml", import.meta.url), "utf8");
const rows = () => [
	paper("a", { title: "Alpha", year: 2020, venue: "Cell", authors: [{ name: "Ann One" }], citations: 5, people: [{ name: "Ann One", position: "first", institution: "Eastbridge University", country: "US" }, { name: "Bo Two", position: "last", institution: "Kestrel Institute", country: "GB", corresponding: true }] }),
	paper("b", { title: "Beta", year: 2021, venue: "bioRxiv", itemType: "preprint", authors: [{ name: "Bo Two" }], citations: 50 }),
	paper("c", { title: "Gamma", year: 2022, venue: "Science", authors: [{ name: "Ann One" }], citations: 500 }),
	paper("d", { title: "Delta", year: 2023, venue: "Cell", authors: [{ name: "Cy Three" }], citations: null })
];
async function loaded(options = {}) {
	const ui = uiHarness({ realRows: true, search: async () => rows(), ...options });
	await ui.runSearch(); ui.wireEvents();
	return ui;
}
const keys = ui => Array.from(ui.state.visible, r => r.key).sort();
// Values built inside the page's sandbox have its own Array and Object; compare them as data.
const plain = value => JSON.parse(JSON.stringify(value));

test("the filter popover opens from its button, closes with Escape and gives focus back", async () => {
	const ui = await loaded();
	const btn = ui.get("filter-btn"), pop = ui.get("filter-pop");
	btn.emit("click");
	assert.equal(pop.hidden, false);
	assert.equal(btn.getAttribute("aria-expanded"), "true");
	assert.equal(pop.getAttribute("aria-label"), "filterPopTitle");
	assert.equal(mockElement.active, pop.querySelector('[data-fid="close"]'), "the keyboard moves into the popover");
	assert.ok(pop.querySelectorAll("button").length > 12, "every control is a real button");
	pop.emit("keydown", { key: "Escape" });
	assert.equal(pop.hidden, true);
	assert.equal(btn.getAttribute("aria-expanded"), "false");
	assert.equal(mockElement.active, btn, "focus returns to the button");
	btn.emit("click");
	ui.onKeyDown({ key: "Escape", preventDefault() {} });
	assert.equal(pop.hidden, true, "Escape on the document closes it too");
	btn.emit("click"); btn.emit("click");
	assert.equal(pop.hidden, true, "the button toggles");
	// no results, nothing to filter
	const empty = uiHarness();
	empty.wireEvents(); empty.render();
	empty.get("filter-btn").emit("click");
	assert.equal(empty.get("filter-pop").hidden, true);
	assert.equal(empty.get("filter-btn").disabled, true);
});

test("rules from the popover filter the table; chips mark excludes and let one go", async () => {
	const ui = await loaded();
	ui.get("filter-btn").emit("click");
	const rule = ui.addRule("journal", "exclude");
	rule.values.push("biorxiv"); rule.labels.biorxiv = "bioRxiv";
	ui.render();
	assert.deepEqual(keys(ui), ["a", "c", "d"]);
	const chips = ui.get("filter-chips");
	assert.equal(chips.hidden, false);
	const chip = chips.querySelector(".fchip");
	assert.ok(chip.classList.contains("excl"), "an exclude chip is marked");
	assert.equal(chip.querySelector(".fchip-tag").textContent, "filterExcluded");
	assert.equal(chip.querySelector(".fchip-text").textContent, "filterKind|journal: bioRxiv");
	assert.match(chip.querySelector(".fchip-main").getAttribute("aria-label"), /^filterExcluded · filterKind\|journal: bioRxiv — filterChipEdit$/);
	assert.equal(ui.get("filter-count").textContent, "1");
	// an include rule next to it
	const inc = ui.addRule("year", "include"); inc.min = 2021;
	ui.render();
	assert.deepEqual(keys(ui), ["c", "d"]);
	assert.equal(chips.querySelectorAll(".fchip").length, 2);
	assert.ok(!chips.querySelectorAll(".fchip")[1].classList.contains("excl"));
	// the x on the first chip removes that rule only
	chips.querySelector(".fchip").querySelector(".filter-clear").emit("click");
	assert.deepEqual(keys(ui), ["b", "c", "d"]);
	assert.equal(ui.state.rules.length >= 1, true);
	// the library counts and the histogram follow the filtered set
	assert.equal(ui.get("lib-all").textContent.trim(), "libAll 3");
	// a new search lets every rule go
	await ui.runSearch();
	assert.equal(ui.state.rules.length, 0);
	assert.equal(ui.get("filter-chips").hidden, true);
});

test("Clear in the form lets every rule and journal go too", async () => {
	const ui = await loaded();
	const r = ui.addRule("journal", "exclude"); r.values.push("cell"); ui.addVenueChip({ name: "Cell" });
	ui.render();
	assert.equal(ui.get("filter-chips").hidden, false);
	ui.clearAll();
	assert.equal(ui.state.rules.length, 0);
	assert.equal(ui.state.venueChips.length, 0);
	assert.equal(ui.get("filter-chips").hidden, true);
});

test("an author rule offers the authors of the results with counts that follow the other rules", async () => {
	const ui = await loaded();
	ui.get("filter-btn").emit("click");
	const year = ui.addRule("year", "include"); year.min = 2022;
	const author = ui.addRule("author", "include");
	ui.render();
	ui.openFilterPop(author.id);
	const opts = plain(ui.get("filter-pop").querySelectorAll(".fp-opt").map(o => o.textContent));
	assert.deepEqual(opts, ["Ann One1", "Cy Three1"], "Ann One has one paper from 2022 on; Bo Two none");
	assert.equal(ui.get("filter-pop").querySelectorAll(".fp-opt")[0].querySelector("input").getAttribute("data-fid"), `opt:${author.id}:name:ann one`);
});

test("the box's quick syntax and the rules combine; the library filter and selection keep working", async () => {
	const ui = await loaded();
	ui.get("filter").value = "journal:cell -author:ann"; ui.render();
	assert.deepEqual(keys(ui), ["d"]);
	ui.get("filter").value = "-delta"; ui.render();
	assert.deepEqual(keys(ui), ["a", "b", "c"]);
	const r = ui.addRule("type", "exclude"); r.values.push("preprint"); ui.render();
	assert.deepEqual(keys(ui), ["a", "c"]);
	ui.state.records[0].inLibrary = true; ui.render();
	assert.equal(ui.get("lib-owned").textContent.trim(), "libOwned 1");
	ui.get("lib-new").emit("click");
	assert.deepEqual(keys(ui), ["c"]);
	ui.state.selected.add("b");
	ui.state.selectedOnly = true; ui.render();
	assert.deepEqual(keys(ui), ["b"], "selected-only still answers by selection alone");
	ui.state.selectedOnly = false;
	ui.clearAllFilters();
	assert.equal(ui.get("filter").value, "");
	assert.equal(ui.state.libraryFilter, "all");
	assert.equal(ui.state.rules.length, 0);
	assert.deepEqual(keys(ui), ["a", "b", "c", "d"]);
});

test("the year histogram groups a long span into at most 24 bins on round years", async () => {
	const ui = uiHarness();
	for (const [first, last, size] of [[2022, 2026, 1], [2003, 2026, 1], [1973, 2026, 5], [1990, 2026, 2], [1900, 2026, 10], [1500, 2026, 50], [2026, 2026, 1]]) {
		const bins = plain(ui.yearBins(first, last));
		assert.ok(bins.length <= 24, `${first}-${last}: ${bins.length} bins`);
		assert.equal(bins[0].size, size, `${first}-${last}`);
		assert.equal(bins[0].from, first, "the first bin starts at the first year with data");
		assert.equal(bins.at(-1).to, last, "and the last one ends at the last");
		for (let i = 1; i < bins.length; i++) {
			assert.equal(bins[i].from, bins[i - 1].to + 1, "no gap and no overlap");
			assert.equal(bins[i].from % size, 0, "bins start on round years");
		}
	}
	assert.deepEqual(plain(ui.yearBins(1973, 2026)[0]), { from: 1973, to: 1974, size: 5 });
});

test("rows carry a second line of first and corresponding author with institution only where the source has them", async () => {
	const ui = await loaded();
	const parts = ui.affLineParts(ui.state.records[0]);
	assert.deepEqual(plain(parts.map(p => [p.role, p.name, p.institution, p.country])), [["first", "Ann One", "Eastbridge University", "US"], ["corr", "Bo Two", "Kestrel Institute", "GB"]]);
	assert.deepEqual(plain(ui.affLineParts(ui.state.records[1])), [], "no data, no line and no placeholder");
	assert.equal(ui.shortInstitution("Harvard University  Medical Laboratory"), "Harvard Univ. Medical Lab.");
	const [first, second, ...rest] = ui.get("results-body").children;
	assert.equal(first.querySelector(".t-aff").textContent, "affLineFirst Ann One · 🇺🇸 Eastbridge Univ. · affLineCorr Bo Two", "the corresponding author's lab is the column's; the line names the first author's only when it differs");
	assert.equal(second.querySelector(".t-aff"), null);
	assert.equal(ui.get("results-table").hasAttribute("data-aff"), true, "every row is two lines tall when one has a second line");
	ui.state.records.forEach(r => { r.people = null; });
	ui.render();
	assert.equal(ui.get("results-table").hasAttribute("data-aff"), false, "and one line when none has");
	ui.state.records[0].people = rows()[0].people; ui.state.affLine = false; ui.render();
	assert.equal(ui.get("results-table").hasAttribute("data-aff"), false, "or when the reader turned the line off");
});

test("the detail lists authors with an index into their institutions; an institution filters the results", async () => {
	const people = [0, 1, 2, 3, 4, 5, 6, 7].map(i => ({ name: "Author " + i, position: i === 0 ? "first" : i === 7 ? "last" : "middle", institution: i % 2 ? "Kestrel Institute" : "Eastbridge University", country: i % 2 ? "GB" : "US", corresponding: i === 7 }));
	const ui = await loaded({ search: async () => [paper("p", { title: "P", people, authorString: "x" }), paper("q", { title: "Q" })] });
	const r = ui.state.records.find(x => x.key === "p");
	ui.renderAuthors(r);
	const box = ui.get("d-authors");
	const names = box.querySelector(".au-list");
	assert.equal(names.querySelectorAll(".au").length, 6, "six authors show");
	assert.equal(names.querySelector(".au-more").textContent, "authorsMore|2");
	assert.ok(names.querySelector(".au").classList.contains("au-first"));
	const insts = plain(box.querySelectorAll(".au-inst-btn").map(b => b.textContent));
	assert.deepEqual(insts, ["Eastbridge University (US)", "Kestrel Institute (GB)"], "numbered in order of appearance");
	assert.equal(names.querySelector(".au").querySelector("sup").textContent, "1");
	names.querySelector(".au-more").emit("click");
	assert.equal(box.querySelector(".au-list").querySelectorAll(".au").length, 8, "the rest opens in place");
	assert.equal(box.querySelector(".au-list").querySelector(".au-corr").textContent, "*");
	assert.equal(box.querySelector(".au-legend").textContent, "* affCorrLegend");
	box.querySelector(".au-inst-btn").emit("click");
	assert.deepEqual(keys(ui), ["p"], "an institution keeps its papers");
	assert.equal(ui.state.rules[0].kind, "inst");
	// plain line when the source gave no institution
	ui.renderAuthors(ui.state.records.find(x => x.key === "q"));
	assert.equal(box.textContent, "noAuthors");
});

test("the journal box: chips, a query of several journals, a typed name still works", async () => {
	let seen = null;
	const ui = await loaded({ search: async (_s, q) => { seen = q; return rows(); }, prefs: { journalLookup: false } });
	ui.addVenueChip({ name: "Nature Methods", abbrev: "Nat Methods", issns: ["1548-7091"] });
	ui.addVenueChip({ name: "Cell" });
	ui.addVenueChip({ name: "cell" });
	assert.equal(ui.state.venueChips.length, 2, "a journal is added once");
	assert.equal(ui.get("venue-chips").querySelectorAll(".jchip").length, 2);
	assert.equal(ui.get("venue-box").classList.contains("has-chips"), true);
	await ui.runSearch();
	assert.deepEqual(plain(seen.venues.map(v => v.name)), ["Nature Methods", "Cell"]);
	assert.equal(seen.venue, '"Nature Methods" OR 1548-7091 OR "Cell"');
	ui.get("venue").value = "Science";
	await ui.runSearch();
	assert.deepEqual(plain(seen.venues.map(v => v.name)), ["Nature Methods", "Cell", "Science"], "what is still typed counts as one more");
	ui.removeVenueChip(0);
	ui.get("venue").value = "";
	await ui.runSearch();
	assert.equal(seen.venue, "Cell", "one journal is just the name");
	ui.setVenueChips([]);
	ui.get("venue").value = "Nucleic Acids Res";
	await ui.runSearch();
	assert.equal(seen.venue, "Nucleic Acids Res", "typing a name and searching without picking is as it always was");
	assert.equal(seen.venues, undefined);
	// Backspace in an empty box takes the last chip back
	ui.addVenueChip({ name: "Science" }); ui.get("venue").value = "";
	ui.onVenueKey({ key: "Backspace", preventDefault() {} });
	assert.equal(ui.state.venueChips.length, 0);
});

test("the suggestion list: arrows, Enter picks only a highlighted journal, Escape closes", async () => {
	const ui = await loaded({ prefs: { journalLookup: false } });
	const input = ui.get("venue"), list = ui.get("venue-list");
	input.value = "nat meth";
	await ui.refreshVenueSuggestions();
	assert.equal(list.hidden, false);
	assert.equal(input.getAttribute("aria-expanded"), "true");
	const options = () => list.querySelectorAll(".jopt");
	assert.ok(options().length >= 1);
	assert.equal(options()[0].querySelector(".jopt-name").textContent, "Nature Methods");
	let prevented = false;
	// Enter with nothing highlighted is the search, as ever
	ui.onVenueKey({ key: "Enter", preventDefault() { prevented = true; }, stopPropagation() {} });
	assert.equal(prevented, false, "Enter is left to the form");
	input.value = "nat meth"; await ui.refreshVenueSuggestions();
	ui.onVenueKey({ key: "ArrowDown", preventDefault() {} });
	assert.ok(options()[0].classList.contains("hot"));
	assert.equal(input.getAttribute("aria-activedescendant"), "venue-opt-0");
	ui.onVenueKey({ key: "Enter", preventDefault() { prevented = true; }, stopPropagation() {} });
	assert.equal(prevented, true, "Enter on a highlighted one picks it");
	assert.deepEqual(plain(ui.state.venueChips.map(c => c.name)), ["Nature Methods"]);
	assert.equal(input.value, "");
	assert.equal(list.hidden, true);
	input.value = "pnas"; await ui.refreshVenueSuggestions();
	assert.equal(list.hidden, false);
	let stopped = false;
	ui.onVenueKey({ key: "Escape", preventDefault() {}, stopPropagation() { stopped = true; } });
	assert.equal(list.hidden, true);
	assert.equal(stopped, true, "Escape closes the list and nothing else");
	input.value = "n"; await ui.refreshVenueSuggestions();
	assert.equal(list.hidden, true, "one letter lists nothing");
});

test("a journal already picked stays in the list, marked, and an empty list has no key hints", async () => {
	const ui = await loaded({ prefs: { journalLookup: false } });
	const input = ui.get("venue"), list = ui.get("venue-list");
	input.value = "pnas"; await ui.refreshVenueSuggestions();
	ui.onVenueKey({ key: "ArrowDown", preventDefault() {} }); ui.onVenueKey({ key: "Enter", preventDefault() {}, stopPropagation() {} });
	assert.equal(ui.state.venueChips.length, 1, "PNAS is picked");
	// typing the start of its ISO abbreviation afterwards must not look like "no match"
	input.value = "proc natl acad"; await ui.refreshVenueSuggestions();
	const picked = Array.from(list.querySelectorAll(".jopt")).filter(o => o.classList.contains("picked"));
	assert.ok(picked.length >= 1, "the picked journal is still listed");
	assert.equal(picked[0].getAttribute("aria-disabled"), "true");
	assert.equal(picked[0].querySelector(".jopt-abbr").textContent, "venuePicked");
	assert.equal(list.querySelector(".jopt-note"), null, "not told there is no match");
	// nothing to choose: no "arrows / Enter / Esc" footer
	input.value = "zzzqq"; await ui.refreshVenueSuggestions();
	assert.ok(list.querySelector(".jopt-note"));
	assert.equal(list.querySelector(".jopt-foot"), null, "key hints only when there is something to choose");
});

test("the stylesheet and markup carry the new controls", () => {
	for (const id of ["filter-btn", "filter-count", "filter-chips", "filter-pop", "venue-box", "venue-chips", "venue-list"]) assert.ok(markup.includes(`id="${id}"`), id);
	assert.ok(markup.indexOf("content/filters.js") < markup.indexOf("content/ui.js") && markup.indexOf("content/journals.js") < markup.indexOf("content/ui.js"), "loaded before the window code");
	assert.match(markup, /id="venue"[^>]*type="text"/);
	// the segmented source control is a grid of equal cells in a rounded (not pill) tray
	assert.match(css, /\.metrics-basis \{[^}]*display: grid;[^}]*repeat\(2, minmax\(0, 1fr\)\)/);
	assert.match(css, /\.metrics-basis \{[^}]*border-radius: var\(--r-box\)/);
	assert.match(css, /\.metrics-basis button\.wide \{ grid-column: 1 \/ -1; \}/);
	// the chip of an excluded filter keeps a solid border (review 2026-10-03: dashed read as unfinished) and says "exclude" in an amber tag; no chip has an edge bar
	assert.doesNotMatch(css, /\.(fchip|fp-rule)\.excl \{[^}]*dashed/);
	assert.match(css, /\.fchip\.excl \.fchip-tag[^{]*\{[^}]*var\(--att-bg\)/);
	assert.doesNotMatch(css, /\.(fchip|fp-rule|jchip)[^{]*\{[^}]*border-left/);
});

test("the preview drives the real handlers: quick syntax, rules, chips, institutions, journals and a long span", async () => {
	const out = await buildPreview({ locale: "ko" });
	const t = out.trace;
	assert.equal(out.netCalls, 0);
	assert.equal(t.filters.before, 13);
	assert.deepEqual(t.filters.quick.rows, [4, 10], "journal:Cell -author:Kim");
	assert.deepEqual(t.filters.phrase.rows, [3], "a phrase, and -commentary leaves the commentary out");
	assert.equal(t.filters.negation, 12);
	assert.equal(t.filters.opened.hidden, false);
	assert.equal(t.filters.opened.kinds, 13, "all thirteen kinds of rule to add");
	assert.equal(t.filters.excludeJournal.rows, 10, "excluding bioRxiv and medRxiv takes two papers away");
	assert.deepEqual(t.filters.excludeJournal.chips, ["제외저널: bioRxiv, medRxiv×"]);
	assert.deepEqual(t.filters.author.rows, [2, 6, 7, 8, 9, 10]);
	assert.deepEqual(t.filters.year.rows, [2, 7, 8, 9, 10]);
	assert.deepEqual(t.filters.year.chips, ["제외저널: bioRxiv, medRxiv×", "저자: Jenna Dowd, Sora Lee×", "연도 범위: ≥ 2024×"]);
	assert.equal(t.filters.authorOptions[0], "Jenna Dowd4", "options count against the other rules");
	assert.equal(t.filters.shownLine, "13편 중 5편 표시");
	assert.equal(t.filters.metrics.papers, "5", "the metrics follow the filtered set");
	assert.match(t.filters.metrics.lib, /전체 5 \/ 미보유 4 \/ 보유 1/);
	assert.deepEqual(t.filters.escape, { hidden: true, expanded: "false", chips: 3 });
	assert.equal(t.filters.chipEdit.open, true);
	assert.equal(t.filters.chipEdit.editors, 1, "a chip opens its own rule");
	assert.equal(t.filters.chipRemove.chips, 2);
	assert.deepEqual(t.filters.cleared, { rows: 13, chips: 0 });
	assert.match(t.affiliations.line[1], /^1저자 Mina Kim · 교신 Jonas Park$/);
	for (const cell of ["T1🇺🇸EastbridgeUniv.", "T1🇨🇳LumenUniv.", "T3🇰🇷HanbitUniv.", "소속미상"]) assert.ok(t.affiliations.cells.includes(cell), "tier chip, flag and the corresponding author's lab, or a muted unknown: " + cell);
	assert.equal(t.affiliations.line[0], "", "a record from a source without affiliations has no line");
	assert.equal(t.affiliations.rowAttr, true);
	assert.equal(t.affiliations.detail, "Mina Kim1, Alex Rivera2, Jonas Park1*1Eastbridge University (US)2Meridian Institute of Technology (US)* 교신");
	assert.deepEqual(t.affiliations.filtered.rows, [1, 9], "Eastbridge: Mina Kim's atlas and the Genome Biology paper");
	assert.deepEqual(t.affiliations.filtered.chips, ["기관: Eastbridge University×"]);
	assert.equal(t.journals.natMethods[0], "Nature MethodsNat Methods");
	assert.deepEqual(t.journals.chips, ["Nature Methods · Nat Methods", "Proceedings of the National Academy of Sciences · PNAS", "Nucleic Acids Research · Nucleic Acids Res"]);
	assert.equal(t.journals.typed.listOpen, true);
	assert.deepEqual(t.journals.escape, { hidden: true, chips: 3 });
	assert.deepEqual(plain(t.journals.query.venues), ["Nature Methods", "Proceedings of the National Academy of Sciences", "Nucleic Acids Research"]);
	assert.equal(t.journals.afterRemove, 0);
	assert.ok(t.longSpan.bars <= 24 && t.longSpan.bars >= 8, "a long span is grouped, not 54 specks: " + t.longSpan.bars);
	assert.deepEqual(t.longSpan.ends, ["1973", "2026"]);
	assert.equal(t.longSpan.basis, 4, "the statistics' source is four cells");
	assert.equal(t.longSpan.selected.range, "1985–1989 ×", "a bin selects all its years");
	for (const html of [out.filtersPage, out.journalsPage, out.longSpanPage]) assert.ok(!/<script\b|<link\b/i.test(html));
	assert.match(out.filtersPage, /class="filter-pop"[^>]*role="dialog"/);
	assert.match(out.filtersPage, /class="fchip excl"/);
});

test("an IF threshold drops papers with no JIF by default; the popover has a toggle to keep them", async () => {
	const ui = await loaded({ search: async () => [paper("a", { journalIF: 9, journalIFSource: "JCR 2025" }), paper("b", { journalIF: null, journalOA2y: 8 }), paper("c", { journalIF: 2, journalIFSource: "JCR 2025" })] });
	const rule = ui.addRule("if", "include"); rule.min = 5; ui.render();
	assert.deepEqual(keys(ui), ["a"], "OpenAlex's 8 does not pass a JIF threshold, and an unknown JIF is out by default");
	ui.openFilterPop(rule.id);
	const toggle = ui.get("filter-pop").querySelector(`[data-fid="unknown:${rule.id}"]`);
	assert.ok(toggle, "the include-unknown checkbox is offered on a JIF rule");
	toggle.checked = true; toggle.emit("change");
	assert.deepEqual(keys(ui), ["a", "b"], "with it on, papers with no JIF stay");
	const oa = ui.addRule("oa2y", "include"); oa.min = 5; rule.min = null; ui.render();
	assert.deepEqual(keys(ui), ["b"], "the OpenAlex mean has its own filter");
});

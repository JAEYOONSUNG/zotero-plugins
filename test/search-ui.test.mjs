import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deferred, mockElement, paper, uiHarness } from "./helpers/search-ui-harness.mjs";
import Sources from "../content/sources.js";

for (const sort of ["relevance", "date", "citations"]) {
	test(`UI displays requested ${sort} order after a previous column sort`, async () => {
		const ui = uiHarness({ sort });
		ui.state.sortKey = "citations";
		ui.state.sortDir = "desc";
		ui.get("filter").value = "old filter";
		await ui.runSearch();
		assert.equal(ui.get("filter").value, "", "previous local filter cannot hide new search results");
		assert.deepEqual(Array.from(ui.state.visible, r => r.key), sort === "citations" ? ["popular", "relevant"] : ["relevant", "popular"]);
		// Explicit column sorting still works after the initial requested order.
		ui.state.sortKey = "citations";
		ui.state.sortDir = "desc";
		ui.render();
		assert.equal(ui.state.visible[0].key, "popular");
	});
}

test("UI renders snapshots before completion and preserves selected merged records and manual sort", async () => {
	const finish = deferred();
	let ctx;
	const ui = uiHarness({ search: async (_source, _query, _http, context) => {
		ctx = context;
		ctx.onResults([paper("crossref:early", { doi: "10.1234/one", citations: 1 })], { final: false });
		return finish.promise;
	} });
	const running = ui.runSearch();
	assert.equal(ui.state.searching, true);
	assert.deepEqual(Array.from(ui.state.visible, r => r.key), ["crossref:early"]);
	assert.equal(ui.get("busy").hidden, true, "loading overlay does not obscure received results");
	ui.state.selected.add("crossref:early");
	ui.state.focusKey = ui.state.detailKey = "crossref:early";
	ui.state.sortKey = "citations";
	ui.state.sortDir = "desc";
	const snapshot = [paper("openalex:merged", { doi: "10.1234/one", citations: 1 }), paper("later", { citations: 50 })];
	ctx.onResults(snapshot, { final: false });
	assert.deepEqual(Array.from(ui.state.visible, r => r.key), ["later", "openalex:merged"]);
	assert.deepEqual(Array.from(ui.state.selected), ["openalex:merged"]);
	assert.equal(ui.state.focusKey, "openalex:merged");
	assert.equal(ui.state.detailKey, "openalex:merged");
	assert.equal(ui.state.records[0].rank, 1);
	assert.equal(snapshot[0].rank, undefined, "display metadata does not mutate source snapshots");
	finish.resolve(snapshot);
	await running;
	assert.deepEqual(Array.from(ui.state.selected), ["openalex:merged"]);
	assert.deepEqual(Array.from(ui.state.visible, r => r.key), ["later", "openalex:merged"]);
	assert.equal(ui.state.searching, false);
	ctx.onResults([paper("stale")]);
	assert.equal(ui.state.records.length, 2, "finished searches cannot deliver stale updates");
});

test("complete search failure differs from a successful empty response and banners reset on retry", async () => {
	let fail = true;
	const ui = uiHarness({ search: async () => {
		if (fail) throw new Error("All sources failed: offline");
		return [];
	} });
	await ui.runSearch();
	assert.match(ui.get("status").textContent, /^searchFailed\|All sources failed/);
	assert.equal(ui.get("statusbar").classList.contains("err"), true);
	assert.equal(ui.get("banner").hidden, false);
	assert.equal(ui.errors.length, 1);
	fail = false;
	await ui.runSearch();
	assert.match(ui.get("status").textContent, /^noResults\|/);
	assert.equal(ui.get("statusbar").classList.contains("err"), false);
	assert.equal(ui.get("banner").hidden, true);
	assert.equal(ui.get("search-btn").disabled, false);
});

test("a partial failure retains records and exposes its source error", async () => {
	const ui = uiHarness({ search: async (_source, _query, _http, ctx) => {
		ctx.errors = ["Crossref: HTTP 503"];
		return [paper("good")];
	} });
	await ui.runSearch();
	assert.equal(ui.state.records[0].key, "good");
	assert.match(ui.get("banner-text").textContent, /^partialFail\|Crossref: HTTP 503/);
	assert.equal(ui.get("statusbar").classList.contains("err"), false);
});

test("an installed PoP bridge receives the search context and can disclose its progress", async () => {
	let bridgeContext;
	const ui = uiHarness({ popBridge: { async search(query, ctx) {
		assert.equal(query.keywords, "genome editing");
		bridgeContext = ctx;
		ctx.onProgress("Google Scholar via Publish or Perish", 0, 10);
		assert.equal(ui.get("status").textContent, "Google Scholar via Publish or Perish");
		return [paper("bridge-result")];
	} }, search: async (_source, query, _http, ctx) => {
		assert.equal(typeof ctx.popSearch, "function");
		return ctx.popSearch(query, ctx);
	} });
	await ui.runSearch();
	assert.equal(bridgeContext.signal.aborted, false);
	assert.equal(ui.state.records[0].key, "bridge-result");
});

function savedRows() {
	return Object.assign([{ uid: "GS:cached", title: "Cached precise paper", authors: ["A Author"], year: 2026, cites: 3 }],
		{ cached: true, partial: true, capturedAt: new Date().toISOString() });
}

test("opening a restored Scholar query loads and labels its snapshot through the source pipeline without network", async () => {
	let calls = 0;
	const ui = uiHarness({ search: Sources.search, request: () => assert.fail("startup restore must not issue HTTP"),
		popBridge: { async search(query, ctx) {
			calls++;
			assert.equal(ctx.popCacheOnly, true);
			assert.equal(ctx.journalMetrics, false);
			assert.equal(ctx.enrichCitations, false);
			assert.equal(query.keywords, "genome editing");
			return savedRows();
		} } });
	ui.get("source").value = "scholar";
	await ui.restoreCachedSearch();
	assert.equal(calls, 1);
	assert.equal(ui.state.records.length, 1);
	assert.equal(ui.state.records[0].source, "scholar");
	assert.equal(ui.state.records[0].rank, 1);
	assert.equal(ui.state.visible[0].title, "Cached precise paper");
	assert.equal(ui.get("status").textContent, "cacheRestored|1");
	assert.match(ui.get("banner-text").textContent, /^cacheRestoredNotice\|/);
	assert.equal(ui.get("banner").hidden, false);
	assert.equal(ui.state.searching, false);
});

test("a completed live search cannot be overwritten by an earlier delayed cached restore", async () => {
	const pending = deferred(), called = deferred();
	let signal;
	const ui = uiHarness({
		search: (...args) => args[3].popCacheOnly ? Sources.search(...args) : Promise.resolve([paper("fresh")]),
		popBridge: { async search(_query, ctx) { signal = ctx.signal; called.resolve(); return pending.promise; } }
	});
	ui.get("source").value = "scholar";
	const restoring = ui.restoreCachedSearch();
	await called.promise;
	await ui.runSearch();
	assert.equal(signal.aborted, true);
	pending.resolve(savedRows());
	await restoring;
	assert.equal(ui.state.records[0].key, "fresh");
	assert.doesNotMatch(ui.get("status").textContent, /cacheRestored/);
});

test("Clear, query edits and source changes invalidate a pending startup cache restore", async () => {
	for (const change of [ui => ui.clearAll(), ui => { ui.get("keywords").value = "new query"; },
		ui => { ui.get("source").value = "openalex"; }, ui => ui.cancelCacheRestore()]) {
		const pending = deferred();
		const ui = uiHarness({ search: Sources.search, popBridge: { search: () => pending.promise } });
		ui.get("source").value = "scholar";
		const restoring = ui.restoreCachedSearch();
		change(ui);
		pending.resolve(savedRows());
		await restoring;
		assert.equal(ui.state.records.length, 0);
		assert.doesNotMatch(ui.get("status").textContent, /cacheRestored/);
	}
});

test("missing startup snapshots quietly preserve the ready state and source hint", async () => {
	const ui = uiHarness({ search: Sources.search, popBridge: { async search() { throw new Error("No matching PoP snapshot"); } },
		request: () => assert.fail("cache miss must not fall back to HTTP") });
	ui.get("source").value = "scholar";
	ui.get("status").textContent = "ready";
	ui.get("banner-text").textContent = "Scholar hint";
	await ui.restoreCachedSearch();
	assert.equal(ui.get("status").textContent, "ready");
	assert.equal(ui.get("banner-text").textContent, "Scholar hint");
	assert.equal(ui.state.records.length, 0);
	assert.equal(ui.errors.length, 0);
});

test("an HTTP error never throws while reading the response body", () => {
	// Zotero's XHR throws from the responseText getter unless responseType is "" or "text";
	// reading it unguarded turned every failed request into a broken error path.
	const src = readFileSync(new URL("../content/ui.js", import.meta.url), "utf8");
	const fn = src.match(/\tfunction httpError\(e, url\) \{[\s\S]*?\n\t\}/)[0];
	const scrub = src.match(/\tfunction scrubURLs\(text\) \{[\s\S]*?\n\t\}/)[0];
	const make = new Function(scrub.replace("function scrubURLs", "const scrubURLs = function") + "\n"
		+ fn.replace("function httpError", "return function httpError"))();

	const throwing = { get responseText() { throw new TypeError("responseText is only available if responseType is '' or 'text'"); },
		response: { message: "Insufficient budget" }, responseType: "json", status: 429 };
	const err = make({ status: 429, xmlhttp: throwing }, "https://api.openalex.org/works?search=x&mailto=a@b.c");
	assert.match(err.body, /Insufficient budget/, "the parsed body is used instead of responseText");
	assert.equal(err.status, 429);

	const textual = { responseType: "text", responseText: "plain failure", status: 503, response: null };
	assert.match(make({ status: 503, xmlhttp: textual }, "https://x/y").body, /plain failure/);

	// a getter that throws with no usable response must still produce an error object
	const hostile = { get responseText() { throw new Error("nope"); }, get response() { throw new Error("nope"); }, status: 500 };
	const safe = make({ status: 500, xmlhttp: hostile }, "https://x/y");
	assert.equal(safe.body, "");
	assert.match(safe.message, /HTTP 500/);
});

test("scrolling inside an open menu keeps it open, so a long collection list can be picked from", () => {
	const ui = uiHarness();
	const container = mockElement(), select = mockElement("select"), button = mockElement("button"), menu = mockElement();
	button.className = "sel-btn"; button.setAttribute("aria-expanded", "true");
	container.appendChild(select); container.appendChild(button); container.appendChild(menu);
	const option = mockElement(); menu.appendChild(option);
	ui.setOpenSelectForTest({ sel: select, menu });
	ui.onDocumentScroll({ target: menu });
	ui.onDocumentScroll({ target: option });
	assert.equal(menu.parentNode, container, "the menu scrolling to the current collection must not close it");
	assert.equal(button.getAttribute("aria-expanded"), "true");
	ui.onDocumentScroll({ target: ui.get("table-wrap") });
	assert.equal(menu.parentNode, null);
});

test("a finished search is kept on disk and reopens at startup without asking any API", async () => {
	const files = new Map();
	let searches = 0;
	const first = uiHarness({ historyFiles: files, search: async () => { searches++; return [paper("saved", { title: "Saved paper", doi: "10.1/saved" })]; } });
	first.get("keywords").value = "Geobacillus";
	await first.runSearch();
	assert.equal(searches, 1);
	const entries = await first.history.list();
	assert.equal(entries.length, 1);
	assert.equal(entries[0].source, "openalex");
	assert.equal(entries[0].count, 1);
	assert.equal(entries[0].partial, false);

	// A new window over the same files, same query typed in: the answer is already there.
	const second = uiHarness({ historyFiles: files, search: async () => assert.fail("a saved search must not be searched again"),
		request: () => assert.fail("startup restore must not issue HTTP") });
	second.get("keywords").value = "  geobacillus";
	await second.restoreCachedSearch();
	assert.equal(second.state.records.length, 1);
	assert.equal(second.state.records[0].title, "Saved paper");
	assert.equal(second.state.records[0].rank, 1);
	assert.equal(second.get("status").textContent, "historyRestored|1");
	assert.match(second.get("banner-text").textContent, /^historyRestoredNotice\|.*\|false$/);
	assert.equal(second.get("banner").hidden, false);
	assert.equal(second.state.searching, false);
	assert.notEqual(second.get("search-btn").disabled, true, "a live search stays one click away");
});

test("a stopped search is kept as incomplete, and a different query or source is not confused with it", async () => {
	const files = new Map();
	const finish = deferred();
	let ctx;
	const ui = uiHarness({ historyFiles: files, search: async (_s, _q, _h, context) => { ctx = context; return finish.promise; } });
	const running = ui.runSearch();
	ctx.onResults([paper("early")], { final: false });
	ui.stopOperation();
	finish.reject(Object.assign(new Error("Search cancelled"), { name: "AbortError" }));
	await running;
	await new Promise(r => setTimeout(r, 0));
	const [entry] = await ui.history.list();
	assert.equal(entry.partial, true);
	assert.equal(entry.count, 1);

	const other = uiHarness({ historyFiles: files });
	other.get("keywords").value = "something else";
	await other.restoreCachedSearch();
	assert.equal(other.state.records.length, 0);
	other.get("keywords").value = "genome editing";
	other.get("source").value = "crossref";
	await other.restoreCachedSearch();
	assert.equal(other.state.records.length, 0, "the same words on another source are another search");
	other.get("source").value = "openalex";
	await other.restoreCachedSearch();
	assert.equal(other.state.records.length, 1);
	assert.match(other.get("banner-text").textContent, /\|true$/, "the notice says the search had been stopped");
});

test("picking a recent search from the menu refills the boxes and shows its results", async () => {
	const files = new Map();
	const ui = uiHarness({ historyFiles: files, search: async () => [paper("hit", { title: "Menu paper" })] });
	ui.get("keywords").value = "thermophile";
	ui.get("yearFrom").value = "2019";
	await ui.runSearch();
	const [entry] = await ui.history.list();
	ui.clearAll();
	assert.equal(ui.get("keywords").value, "");
	await ui.openHistoryEntry(entry.id);
	assert.equal(ui.get("keywords").value, "thermophile");
	assert.equal(ui.get("yearFrom").value, "2019");
	assert.equal(ui.state.records[0].title, "Menu paper");
	assert.equal(ui.get("status").textContent, "historyRestored|1");
	await ui.openHistoryEntry("0000000000000000");
	assert.equal(ui.get("status").textContent, "historyMissing");
	// The menu itself lists the entry with its source, count and time, and a way to forget all.
	await ui.openHistoryMenu();
	const menu = ui.get("histmenu");
	assert.equal(menu.hidden, false);
	const items = menu.querySelectorAll("div.histopt");
	assert.equal(items.length, 1);
	assert.equal(items[0].querySelector("span.h-label").textContent, "thermophile · 2019–");
	assert.match(items[0].querySelector("span.h-meta").textContent, /^historyEntryMeta\|OpenAlex\|1\|/);
	assert.ok(menu.querySelector("div.histclear"));
	ui.closeHistoryMenu();
	assert.equal(menu.hidden, true);
});

test("affiliation columns sort, filter and export from the people a source supplied", async () => {
	const people = (inst, country, h, name = "A") => [{ name, position: "first", corresponding: false, institution: inst, institutionId: "I", country, institutionH: h }];
	const ui = uiHarness({ realRows: true, search: async () => [
		paper("kr", { people: people("KAIST", "KR", 900) }),
		paper("us", { people: people("MIT", "US", 1800) }),
		paper("none", { venue: "Somewhere" })
	] });
	await ui.runSearch();
	assert.equal(ui.sortValue(ui.state.records[0], "tier"), 900);
	assert.equal(ui.sortValue(ui.state.records[1], "affiliation"), "mit");
	assert.equal(ui.sortValue(ui.state.records[2], "tier"), -1);
	assert.equal(ui.sortValue(ui.state.records[1], "country"), "US");
	ui.state.sortKey = "tier"; ui.state.sortDir = "desc";
	ui.render();
	assert.deepEqual(ui.state.visible.map(r => r.key), ["us", "kr", "none"]);
	assert.equal(ui.matchesFilter(ui.state.records[0], "kaist"), true);
	assert.equal(ui.matchesFilter(ui.state.records[0], "us"), false);
	assert.equal(ui.matchesFilter(ui.state.records[1], "us"), true);
	const row = ui.get("results-body").firstChild;
	assert.equal(row.querySelector("td.aff").textContent, "MIT");
	assert.equal(row.querySelector("td.country").textContent, "🇺🇸 US");
	assert.equal(row.querySelector("span.tier").textContent, "T1");
	assert.match(row.querySelector("td.aff").title, /^affFirst: A · MIT · 🇺🇸 US · affHIndex\|1800 · T1$/);
	const csv = ui.csvText().split("\n");
	assert.match(csv[1], /"MIT","US","1800"/);
	assert.match(csv[3], /"","",""/);
});

test("the journal cell carries the publisher's mark in its colour, and so does the detail pane", async () => {
	const ui = uiHarness({ realRows: true, search: async () => [
		paper("sci", { venue: "Science", publisher: "American Association for the Advancement of Science (AAAS)" }),
		paper("unk", { venue: "Journal of Cleaner Production", publisher: "Elsevier BV" }),
		paper("none", { venue: "" })
	] });
	await ui.runSearch();
	const rows = ui.get("results-body").children;
	const venue = rows[0].querySelector("td.venue");
	assert.equal(venue.textContent, "Science", "the name itself carries the colour; no chip crowds it");
	assert.match(venue.style.color, /^hsl\(4 81% 36%\)$/);
	assert.equal(venue.style.fontWeight, "600");
	assert.equal(venue.title, "Science · Science · American Association for the Advancement of Science (AAAS)");
	assert.equal(venue.dataset.marquee, "venue");
	assert.match(rows[1].querySelector("td.venue").title, /^Journal of Cleaner Production · J Clean Prod · Elsevier/);
	assert.equal(rows[1].querySelector("td.venue").classList.contains("venue-known"), true, "the publisher placed it");
	assert.equal(rows[2].querySelector("td.venue").style.color, undefined);
	// The detail pane shows the abbreviation as a chip in the same colour.
	ui.state.detailKey = "sci";
	ui.state.records[0].journalAbbrev = "Science";
});

test("the window follows Zotero's own language unless told otherwise", async () => {
  const fs = await import("node:fs");
  const read = name => fs.readFileSync(new URL("../" + name, import.meta.url), "utf8");
  /* Auto was supported but was not the default, so a Korean Zotero still got an
     English window until somebody went looking for the menu. */
  assert.match(read("prefs.js"), /extensions\.zotpop\.language",\s*"auto"/);
  // An unset preference must land on auto too, not on English.
  for (const file of ["content/ui.js", "content/proxylogin.js"]) {
    assert.doesNotMatch(read(file), /PREF\("language"\)\s*\|\|\s*"en"/, file);
    assert.match(read(file), /PREF\("language"\)\s*\|\|\s*"auto"/, file);
  }
  // And "auto" must never reach anything that expects a real language.
  assert.doesNotMatch(read("content/ui.js"), /language:\s*t\.locale\s*\|\|\s*PREF/);
  // And it is offered first, because it is what most people want.
  const menu = read("content/preferences.xhtml");
  assert.ok(menu.indexOf('value="auto"') < menu.indexOf('value="en"'),
    "auto comes before the fixed languages");
});

test("a paper already on the shelf without a DOI is still recognised", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../content/importer.js", import.meta.url), "utf8");
  const rows = [];
  const sandbox = {
    Zotero: {
      logError() {},
      DB: { queryAsync: async () => rows }
    },
    ZotPoPSources: { normalizeDOI: v => String(v || "").toLowerCase() || null },
    module: { exports: {} }
  };
  sandbox.globalThis = sandbox;
  const vm = await import("node:vm");
  vm.createContext(sandbox);
  vm.runInContext(source + "\nglobalThis.__api = ZotPoPImporter;", sandbox);
  const api = sandbox.__api;

  /* Duplicate detection was DOI-only, which in a library like this one leaves
     sixty-eight items unmatchable: a result whose DOI was resolved still finds
     nothing, because the copy on the shelf has no DOI field at all. */
  rows.push({ itemID: 7, title: "A thermostable type I-B CRISPR-Cas system", date: "2023-10-05" });
  assert.equal(await api.findByTitle(1, "A thermostable type I-B CRISPR–Cas system!", "2023"), 7,
    "punctuation and case do not make it a different paper");
  assert.equal(await api.findByTitle(1, "A thermostable type I-B CRISPR-Cas system", "2019"), null,
    "the same name in a different year is a different paper");

  // A wrong match silently withholds a paper somebody asked for, so a short
  // title is not evidence: "Erratum" would match half a library.
  rows.length = 0;
  rows.push({ itemID: 9, title: "Erratum", date: "2020" });
  assert.equal(await api.findByTitle(1, "Erratum", "2020"), null);

  // A database that cannot be read is not an answer either way.
  sandbox.Zotero.DB.queryAsync = async () => { throw new Error("locked"); };
  assert.equal(await api.findByTitle(1, "A thermostable type I-B CRISPR-Cas system", "2023"), null);
});

test("a restored or freshly displayed result gets the JCR impact factor, and an OpenAlex-only figure is marked as an estimate", async () => {
	const files = new Map();
	const ui = uiHarness({ historyFiles: files, search: async () => [
		paper("nc", { venue: "Nature Communications", issn: "2041-1723", journalIF: 17.5 }),
		paper("odd", { venue: "Some Obscure Bulletin", journalIF: 1.3 }),
		paper("none", { venue: "Nowhere" })
	] });
	await ui.runSearch();
	const byKey = key => ui.state.records.find(r => r.key === key);
	assert.equal(byKey("nc").journalIF, 18.1, "the JCR figure replaces a stale OpenAlex one");
	assert.equal(byKey("nc").journalIFEstimate, false);
	assert.equal(byKey("odd").journalIF, 1.3);
	assert.equal(byKey("odd").journalIFEstimate, true, "not in the JCR, so the OpenAlex figure is an estimate");
	assert.equal(byKey("none").journalIF, undefined);
	// The same holds for a search brought back from disk.
	const [entry] = await ui.history.list();
	const again = uiHarness({ historyFiles: files });
	await again.openHistoryEntry(entry.id);
	assert.equal(again.state.records.find(r => r.key === "nc").journalIF, 18.1);
	assert.equal(again.state.records.find(r => r.key === "odd").journalIFEstimate, true);
});

test("a paper handed over from the item list opens the search already filled in and running", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../content/ui.js", import.meta.url), "utf8");
  /* The search tab used to open empty and ask you to type in what was already
     on the row under the pointer. The main window hands the row over; the
     form reads it once, fills title and authors, brackets the year, and runs. */
  assert.match(source, /function applyPrefill\(\)/);
  assert.match(source, /Zotero\.ZotPoP\.takePrefill/);
  assert.match(source, /window\.addEventListener\("load", init\);/, "the harness keys on this exact line; it must stay");
  assert.match(source, /window\.addEventListener\("load", applyPrefill\);/, "registered after init, so it runs after init");
  assert.match(source, /window\.addEventListener\("zotpop-prefill", applyPrefill\);/, "an already-open tab is told to run the new one");
  // Year is bracketed by one on either side, so a preprint from the year before still matches.
  assert.match(source, /\$\("yearFrom"\)\.value = String\(year - 1\)/);
  assert.match(source, /\$\("yearTo"\)\.value = String\(year \+ 1\)/);
  // And the sender side: openSearch stores what it was given and takePrefill consumes it once.
  const plugin = readFileSync(new URL("../src/zotpop.js", import.meta.url), "utf8");
  assert.match(plugin, /openSearch\(mainWindow, prefill\)/);
  assert.match(plugin, /takePrefill\(\) \{ let p = this\._prefill; this\._prefill = null; return p; \}/);
});

test("a title's italics are drawn in the list and the detail, and kept for the import", async () => {
	/* Crossref and OpenAlex hand titles over with the inline markup Zotero
	   keeps in the field. The list used to show the plain words; now the
	   organism is in italics, and the imported item carries the markup the
	   way a native Zotero import would. */
	const ui = uiHarness({ realRows: true, search: async () => [
		paper("bs", { title: "Establishing a Bacillus subtilis CO2 route", titleMarkup: "Establishing a <i>Bacillus subtilis</i> CO<sub>2</sub> route" }),
		paper("plain", { title: "No markup" })
	] });
	await ui.runSearch();
	const rows = ui.get("results-body").children;
	const link = rows[0].querySelector("td.title").querySelector("a");
	assert.equal(link.querySelector("i").textContent, "Bacillus subtilis");
	assert.equal(link.querySelector("sub").textContent, "2");
	assert.equal(link.textContent, "Establishing a Bacillus subtilis CO2 route");
	assert.equal(rows[1].querySelector("td.title").querySelector("a").textContent, "No markup");
	// (The detail pane draws the same way; the harness stubs it out.)
	// The source normaliser keeps the markup beside the plain title, and only the six tags.
	const made = Sources.makeRecord({ source: "crossref", title: "A <i>Bacillus</i> <span class=\"x\">study</span> &amp; more", doi: "10.1/x" });
	assert.equal(made.title, "A Bacillus study & more");
	assert.equal(made.titleMarkup, "A <i>Bacillus</i> study & more");
	assert.equal(Sources.makeRecord({ source: "crossref", title: "Plain", doi: "10.1/y" }).titleMarkup, null);
});

test("the × clears the results filter and hides itself when there is nothing to clear", async () => {
	const ui = uiHarness({ realRows: true, search: async () => [paper("a", { title: "Alpha" }), paper("b", { title: "Beta" })] });
	await ui.runSearch();
	ui.syncFilterClear();
	assert.equal(ui.get("filter-clear").hidden, true, "nothing to clear yet");
	ui.get("filter").value = "zzz"; ui.render(); ui.syncFilterClear();
	assert.equal(ui.state.visible.length, 0);
	assert.equal(ui.get("filter-clear").hidden, false, "the × shows once there is something to clear");
	ui.clearFilter();
	assert.equal(ui.get("filter").value, "");
	assert.equal(ui.state.visible.length, 2, "every result is back");
	assert.equal(ui.get("filter-clear").hidden, true);
});

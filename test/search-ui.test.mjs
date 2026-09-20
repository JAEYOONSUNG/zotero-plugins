import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deferred, mockElement, paper, uiHarness } from "./helpers/search-ui-harness.mjs";
import Sources from "../content/sources.js";
import Authors from "../content/authors.js";

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
  api.forgetTitleIndex();
  assert.equal(await api.findByTitle(1, "Erratum", "2020"), null);

  /* Every title in the library is read once per run, not once per paper: eighty
     imported papers used to mean eighty full scans. */
  let scans = 0;
  const seen = sandbox.Zotero.DB.queryAsync;
  sandbox.Zotero.DB.queryAsync = async (...args) => { scans++; return seen(...args); };
  api.forgetTitleIndex();
  for (let n = 0; n < 5; n++) await api.findByTitle(1, "Some other paper title entirely here", "2020");
  assert.equal(scans, 1, "five lookups, one scan");

  // A database that cannot be read is not an answer either way: saying "not
  // here" would import a second copy of a paper already on the shelf.
  sandbox.Zotero.DB.queryAsync = async () => { throw new Error("locked"); };
  api.forgetTitleIndex();
  await assert.rejects(() => api.findByTitle(1, "A thermostable type I-B CRISPR-Cas system", "2023"), /duplicates/);
  await assert.rejects(() => api.findByDOI(1, "10.1/x"), /duplicates/);
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
		paper("bs", { title: "Establishing a Bacillus subtilis CO2 route", titleMarkup: "Establishing a <i>Bacillus subtilis</i> CO<sub>2</sub> route", url: "https://example.test/bs" }),
		paper("plain", { title: "No markup" })
	] });
	await ui.runSearch();
	const rows = ui.get("results-body").children;
	const link = rows[0].querySelector("td.title").querySelector("a");
	assert.equal(link.querySelector("i").textContent, "Bacillus subtilis");
	assert.equal(link.querySelector("sub").textContent, "2");
	assert.equal(link.textContent, "Establishing a Bacillus subtilis CO2 route");
	// Without a URL the title is plain text, not a link that goes nowhere.
	assert.equal(rows[1].querySelector("td.title").querySelector("a"), null);
	assert.equal(rows[1].querySelector("td.title").querySelector("span").textContent, "No markup");
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


test("requested 1000 and 2000 limits reach the search engine without an API key", async () => {
	for (const source of ["multi", "openalex"]) for (const max of [1000, 2000]) {
		let received;
		const ui = uiHarness({ prefs: { openAlexApiKey: "" }, search: async (_source, query) => { received = query.maxResults; return []; } });
		ui.get("source").value = source;
		ui.get("maxResults").value = String(max);
		await ui.runSearch();
		assert.equal(received, max);
		assert.equal(ui.get("maxResults").value, String(max));
	}
});

test("source failures keep history incomplete and never describe zero partial rows as no matches", async () => {
	for (const rows of [[paper("partial")], []]) {
		const ui = uiHarness({ search: async (_s, _q, _h, ctx) => { ctx.errors = ["Crossref: HTTP 503"]; return rows; } });
		await ui.runSearch();
		assert.match(ui.get("status").textContent, /^incompleteResults\|/);
		assert.match(ui.get("banner-text").textContent, /Crossref: HTTP 503/);
		const entries = await ui.history.list();
		if (rows.length) assert.equal(entries[0].partial, true);
	}
});

test("old cached author false positives are excluded locally while the original snapshot is preserved", async () => {
	const ui = uiHarness({ search: async () => assert.fail("cache revalidation must not search") });
	const query = { authors: "Sheila Ingemann", keywords: "", maxResults: 1000, sort: "relevance" };
	const rows = [paper("right", { authors: [{ firstName: "Sheila Ingemann", lastName: "Jensen", name: "Sheila Ingemann Jensen" }] }),
		paper("wrong", { year: 1947, authors: [{ firstName: "Sheila I.", lastName: "Stewart", name: "Sheila I. Stewart" }] })];
	const id = await ui.history.save({ source: "openalex", query, records: rows });
	await ui.openHistoryEntry(id);
	assert.deepEqual(Array.from(ui.state.records, r => r.key), ["right"]);
	assert.match(ui.get("banner-text").textContent, /historyRevalidated\|1/);
	assert.equal((await ui.history.get(id)).records.length, 2, "do not rewrite the captured evidence");
});

test("combined selection reaches the engine, is cached separately and is restored", async () => {
	let requested;
	const ui = uiHarness({ search: async (_s, query) => { requested = query; return [paper("coverage")]; } });
	ui.get("source").value = "multi";
	ui.get("multi-source-scholar").checked = true;
	ui.get("multi-source-pubmed").checked = true;
	await ui.runSearch();
	assert.deepEqual(Array.from(requested.sources), ["openalex", "crossref", "europepmc", "arxiv", "pubmed", "scholar"]);
	const [entry] = await ui.history.list();
	assert.deepEqual(Array.from(entry.query.sources), Array.from(requested.sources));
	ui.get("multi-source-scholar").checked = false;
	await ui.openHistoryEntry(entry.id);
	assert.equal(ui.get("multi-source-scholar").checked, true);
});

test("an explicitly empty combined selection fails before clearing existing results", async () => {
	const ui = uiHarness({ search: async () => assert.fail("no selected sources") });
	ui.get("source").value = "multi";
	for (const source of ["openalex", "crossref", "europepmc", "arxiv", "pubmed", "semanticscholar", "scholar"]) ui.get("multi-source-" + source).checked = false;
	ui.state.records = [paper("existing")];
	await ui.runSearch();
	assert.equal(ui.get("status").textContent, "needSources");
	assert.equal(ui.state.records[0].key, "existing");
});

test("results received before a transport exception remain in incomplete history", async () => {
	const ui = uiHarness({ search: async (_s, _q, _h, ctx) => { ctx.onResults([paper("received")]); throw new Error("connection closed"); } });
	await ui.runSearch();
	assert.equal(ui.state.records[0].key, "received");
	const [entry] = await ui.history.list();
	assert.equal(entry.partial, true);
	assert.equal(entry.count, 1);
});

test("PoP rows retain native rank, order, duplicates, unknowns and independent selection through history", async () => {
	const raw = [
		{ title: "", rank: 8, year: 0, cites: 0, doi: "10.1234/grant", authors: [] },
		{ title: "Shared title", rank: 3, year: 2016, cites: 7, doi: "10.1234/duplicate", authors: ["S Jensen", "..."] },
		{ title: "Shared title", rank: 9, year: 2016, cites: 7, doi: "10.1234/duplicate", authors: ["S Jensen", "..."] }
	];
	const provenance = { engine: "publish-or-perish", source: "crossref", profileId: "pop-default", outputSort: "-cites", capturedAt: new Date().toISOString(), invocationId: "ui-probe", complete: true, cached: false, cancelled: false, exitCode: 0 };
	const records = Sources.normalizePoPExactRecords(raw, "crossref", provenance);
	const prefs = { popDataDir: "" }, files = new Map();
	const ui = uiHarness({ prefs, historyFiles: files, realRows: true, search: async () => records });
	ui.get("engine").value = "pop"; ui.get("source").value = "crossref"; ui.get("popOutputSort").value = "-cites";
	ui.get("authors").value = "An author absent from these snippets";
	await ui.runSearch();
	assert.deepEqual(Array.from(ui.state.visible, r => r.rank), [8, 3, 9]);
	assert.equal(ui.state.records.length, 3);
	assert.equal(new Set(ui.state.records.map(r => r.key)).size, 3);
	assert.deepEqual(JSON.parse(JSON.stringify(ui.state.records.map(r => r.popOriginal))), raw);
	assert.deepEqual(JSON.parse(ui.popOriginalJSON()), raw);
	assert.equal(ui.get("copy-pop-json").hidden, false);
	ui.state.selected.add(ui.state.records[1].key);
	ui.displaySearchResults(records);
	assert.deepEqual(Array.from(ui.state.selected), [records[1].key], "selecting one duplicate must not select the other");
	const [saved] = await ui.history.list();
	const snapshot = await ui.history.get(saved.id);
	assert.equal(snapshot.query.engine, "pop");
	assert.deepEqual(snapshot.records.map(r => r.rank), [8, 3, 9]);
	const reopened = uiHarness({ prefs, historyFiles: files, realRows: true, search: async () => assert.fail("history must not call the network") });
	await reopened.openHistoryEntry(saved.id);
	assert.equal(reopened.get("engine").value, "pop");
	assert.equal(reopened.get("source").value, "crossref");
	assert.deepEqual(Array.from(reopened.state.visible, r => r.rank), [8, 3, 9]);
	assert.deepEqual(JSON.parse(JSON.stringify(reopened.state.records.map(r => r.popOriginal))), raw);
	assert.doesNotMatch(reopened.get("banner-text").textContent, /historyRevalidated/);
});

test("native raw query conflicts fail before erasing results, while raw-only criteria reach PoP", async () => {
	let query;
	const ui = uiHarness({ prefs: { popDataDir: "" }, search: async (_s, q) => { query = q; return []; } });
	ui.get("engine").value = "pop"; ui.get("source").value = "crossref";
	ui.get("popRaw").value = "query=CRISPR";
	ui.state.records = [paper("existing")];
	await ui.runSearch();
	assert.equal(query, undefined);
	assert.equal(ui.state.records[0].key, "existing");
	assert.equal(ui.get("status").textContent, "popRawConflict");
	ui.get("keywords").value = "";
	await ui.runSearch();
	assert.equal(query.engine, "pop"); assert.equal(query.popRaw, "query=CRISPR");
	assert.equal(query.popProfile, "pop-default"); assert.equal(query.popOutputSort, "rank");
});

test("rankless native rows do not display or export an invented original rank", async () => {
	const rows = Sources.normalizePoPExactRecords([{ title: "No native rank", year: 0 }], "crossref", { engine: "publish-or-perish", source: "crossref", profileId: "pop-default", invocationId: "rankless", complete: true });
	const ui = uiHarness({ realRows: true, search: async () => rows });
	ui.get("engine").value = "pop"; ui.get("source").value = "crossref";
	await ui.runSearch();
	assert.equal(ui.get("results-body").firstChild.querySelector('td[data-k="rank"]').textContent, "–");
	assert.equal(ui.sortValue(ui.state.records[0], "rank"), -1);
	assert.equal(ui.csvText().split("\n")[1].split(",")[2], '""');
	assert.equal(Object.hasOwn(JSON.parse(ui.popOriginalJSON())[0], "rank"), false);
});

test("native help changes with the engine and history warns without switching profiles", async () => {
	const ui = uiHarness({ prefs: { popDataDir: "/profile/B" } });
	ui.get("engine").value = "pop"; ui.get("source").value = "crossref"; ui.sourceHint();
	assert.equal(ui.get("authors").getAttribute("title"), "popAuthorsHelp");
	assert.equal(ui.get("title").getAttribute("title"), "popTitleHelp");
	ui.get("engine").value = "direct"; ui.sourceHint();
	assert.equal(ui.get("authors").getAttribute("title"), "authorsHelp");
	const query = { engine: "pop", keywords: "gene", maxResults: 30, popProfile: "/profile/A", popOutputSort: "rank" };
	const rows = Sources.normalizePoPExactRecords([{ title: "Gene paper", rank: 1 }], "crossref", { engine: "publish-or-perish", source: "crossref", profileId: "/profile/A", invocationId: "profile-A", complete: true });
	const id = await ui.history.save({ source: "crossref", query, records: rows });
	await ui.openHistoryEntry(id);
	assert.match(ui.get("banner-text").textContent, /popProfileChanged\|\/profile\/A\|\/profile\/B/);
	assert.equal(ui.readQuery().popProfile, "/profile/B");
});

test("ORCID author mode finds a real profile shape, loads unknown-citation works and restores separate history", async () => {
	const id = "0000-0001-8277-5907", files = new Map(), prefs = {}, requests = [];
	const person = { path: `/${id}/person`, name: { "given-names": { value: "Sheila Ingemann" }, "family-name": { value: "Jensen" } } };
	const works = { path: `/${id}/works`, group: [1, 2, 3].map(n => ({ "work-summary": [{ "put-code": n, title: { title: { value: `Public work ${n}` } }, "publication-date": { year: { value: "2020" } }, type: "journal-article" }] })) };
	const ui = uiHarness({ realRows: true, prefs, historyFiles: files, request: async (_method, url) => { requests.push(url); return { response: url.endsWith("/person") ? person : works, status: 200 }; } });
	ui.state.records = [paper("paper-context")]; ui.get("keywords").value = "My paper query";
	await ui.switchSearchMode("authors"); await ui.switchAuthorProvider("orcid");
	ui.get("author-input").value = id; ui.get("author-max-results").value = "2"; ui.authorInputChanged();
	await ui.runAuthorAction("profiles");
	assert.match(ui.get("author-profiles").textContent, /Sheila Ingemann Jensen/);
	assert.match(ui.get("author-profiles").textContent, /authorIdentityConfirmed/);
	assert.equal(ui.get("author-name-btn").hidden, true);
	let entries = await ui.history.list(); assert.equal(entries[0].kind, "profiles"); assert.equal(entries[0].count, 1);
	const profileEntry = entries[0];
	ui.get("author-profiles").querySelector("button").emit("click");
	await new Promise(resolve => setImmediate(resolve)); await ui.state.searchDone;
	assert.equal(ui.state.records.length, 2); assert.equal(requests.length, 2);
	assert.ok(ui.state.records.every(row => row.citations === null && row.authors.length === 0));
	assert.match(ui.get("status").textContent, /incompleteResults/);
	assert.match(ui.get("banner-text").textContent, /authorLimited\|2\|3/);
	ui.originalRenderMetrics(ui.state.records);
	assert.equal(ui.get("metrics-table").hidden, true); assert.match(ui.get("metrics-hint").textContent, /authorNoCitationData\|2/);
	entries = await ui.history.list(); const publicationEntry = entries.find(entry => entry.query.authorAction === "publications");
	assert.equal(publicationEntry.partial, true); assert.equal(publicationEntry.query.authorProfileId, id);
	await ui.switchSearchMode("papers"); assert.equal(ui.state.records[0].key, "paper-context"); assert.equal(ui.get("keywords").value, "My paper query");
	const reopened = uiHarness({ realRows: true, prefs, historyFiles: files, request: () => assert.fail("history must not use the network") });
	await reopened.openHistoryEntry(publicationEntry.id);
	assert.equal(reopened.searchMode(), "authors"); assert.equal(reopened.get("author-provider").value, "orcid");
	assert.equal(reopened.get("author-input").value, id); assert.equal(reopened.state.records.length, 2);
	assert.ok(reopened.state.records.every(row => row.citations === null));
	assert.doesNotMatch(reopened.get("banner-text").textContent, /historyRevalidated/);
	await reopened.openHistoryEntry(profileEntry.id); assert.equal(reopened.state.records.length, 0);
	assert.match(reopened.get("author-profiles").textContent, /Sheila Ingemann Jensen/);
});

test("Scholar profile URL bypasses name lookup and keeps native publication rank and original rows", async () => {
	const calls = [], id = "dsdG3ewAAAAJ";
	const raw = [{ title: "Native profile publication", rank: 9, cites: 20, authors: ["Curtis Bonk"] }];
	const ui = uiHarness({ realRows: true, prefs: { popDataDir: "" }, popBridge: { async searchSource(source, query) {
		calls.push({ source, query }); return { rows: raw, provenance: { engine: "publish-or-perish", source, complete: true, cached: false, profileId: "pop-default", invocationId: "author-ui-profile" } };
	} } });
	await ui.switchSearchMode("authors"); ui.get("author-input").value = `https://scholar.google.com/citations?user=${id}`;
	await ui.runAuthorAction("profiles"); assert.equal(calls.length, 0);
	assert.match(ui.get("author-profiles").textContent, /authorIdentityPending/);
	await ui.runAuthorAction("publications", ui.authorSessions.scholar.profiles[0]);
	assert.equal(calls[0].source, "scholarprofile"); assert.equal(calls[0].query.authors, id);
	assert.equal(ui.state.records[0].rank, 9); assert.deepEqual(JSON.parse(ui.popOriginalJSON()), raw);
	assert.match(ui.get("author-profiles").textContent, /authorIdentityConfirmed/);
});

test("Scholar profile access errors stay visible and the separate name-paper action does not claim identity", async () => {
	const calls = [];
	const ui = uiHarness({ realRows: true, prefs: { popDataDir: "" }, popBridge: { async searchSource(source, query) {
		calls.push(source);
		if (source === "scholarauthor") throw new Error("Login required");
		return { rows: [{ title: "A matching name", rank: 1, authors: [query.authors] }], provenance: { engine: "publish-or-perish", source, complete: true, cached: false, invocationId: "name-papers" } };
	} } });
	await ui.switchSearchMode("authors"); ui.get("author-input").value = "Sheila Ingemann Jensen";
	await ui.runAuthorAction("profiles"); assert.match(ui.get("banner-text").textContent, /Login required/); assert.equal(ui.get("author-profiles").children.length, 0);
	await ui.runAuthorAction("name-papers"); assert.deepEqual(calls, ["scholarauthor", "scholar"]);
	assert.match(ui.get("banner-text").textContent, /authorNameUnverified/); assert.match(ui.get("author-profiles").textContent, /authorNameUnverified/);
	assert.equal(ui.state.records[0].authorProfile.identityConfirmed, false);
	assert.equal(ui.get("author-profiles").querySelector("button"), null, "name results cannot be selected as a confirmed profile");
	const [entry] = await ui.history.list(); assert.equal(entry.query.authorAction, "name-papers"); assert.equal(entry.query.authorProfileId, "");
});

test("cancelled and stale author lookups cannot replace a paper context, including services that ignore abort", async () => {
	const pending = deferred(); let ctx;
	const ui = uiHarness({ authorsService: { ...Authors, searchProfiles: async (_provider, _input, _http, context) => { ctx = context; return pending.promise; } } });
	ui.state.records = [paper("paper-retained")]; ui.get("keywords").value = "paper criteria";
	await ui.switchSearchMode("authors"); ui.get("author-input").value = "Old name";
	const searching = ui.runAuthorAction("profiles"); await new Promise(resolve => setImmediate(resolve));
	await ui.switchSearchMode("papers"); assert.equal(ctx.signal.aborted, true);
	assert.equal(ui.state.records[0].key, "paper-retained"); assert.equal(ui.get("keywords").value, "paper criteria");
	pending.resolve([{ provider: "scholar", id: "dsdG3ewAAAAJ", name: "Late result" }]); await searching;
	assert.equal(ui.searchMode(), "papers"); assert.equal(ui.state.records[0].key, "paper-retained");
	assert.equal(ui.authorSessions.scholar.profiles.length, 0); assert.equal((await ui.history.list()).length, 0);
});

test("editing author input cancels the active request and provider inputs persist independently", async () => {
	const pending = deferred(); let signal;
	const ui = uiHarness({ authorsService: { ...Authors, searchProfiles: async (_provider, _input, _http, ctx) => { signal = ctx.signal; return pending.promise; } } });
	await ui.switchSearchMode("authors"); ui.get("author-input").value = "Scholar Name";
	const running = ui.runAuthorAction("profiles"); await new Promise(resolve => setImmediate(resolve));
	ui.get("author-input").value = "Edited Name"; ui.authorInputChanged(); await running;
	assert.equal(signal.aborted, true); pending.resolve([]);
	await ui.switchAuthorProvider("orcid"); ui.get("author-input").value = "0000-0001-8277-5907"; ui.authorInputChanged();
	await ui.switchAuthorProvider("scholar"); assert.equal(ui.get("author-input").value, "Edited Name");
	const fresh = uiHarness({ prefs: ui.prefs }); fresh.restoreAuthorPreferences();
	assert.equal(fresh.get("author-input").value, "Edited Name");
	await fresh.switchAuthorProvider("orcid"); assert.equal(fresh.get("author-input").value, "0000-0001-8277-5907");
});

test("author mode validates ORCID, missing bridge and raw profile/name actions without fabricated cards", async () => {
	const ui = uiHarness(); await ui.switchSearchMode("authors"); await ui.switchAuthorProvider("orcid");
	ui.get("author-input").value = "Sheila Jensen"; await ui.runAuthorAction("profiles");
	assert.match(ui.get("banner-text").textContent, /valid ORCID/); assert.equal(ui.get("author-profiles").children.length, 0);
	await ui.switchAuthorProvider("scholar"); ui.get("author-input").value = "Some Author"; await ui.runAuthorAction("profiles");
	assert.match(ui.get("banner-text").textContent, /Publish or Perish command-line tool/);
	ui.get("author-input").value = "https://scholar.google.com/citations?user=dsdG3ewAAAAJ"; await ui.runAuthorAction("name-papers");
	assert.equal(ui.get("status").textContent, "authorNeedName");
});

test("ambiguous Scholar names need an explicit input kind and name-paper search remains separate", async () => {
	const calls = [];
	const ui = uiHarness({ popBridge: { async searchSource(source, query) { calls.push({ source, query }); return { rows: [], provenance: { engine: "publish-or-perish", source, complete: true } }; } } });
	await ui.switchSearchMode("authors"); ui.get("author-input").value = "MichaelSmith";
	await ui.runAuthorAction("profiles"); assert.equal(calls.length, 0); assert.match(ui.get("banner-text").textContent, /ambiguous|name|profile/i);
	ui.get("author-input-kind").value = "name"; ui.authorInputChanged(); await ui.runAuthorAction("profiles");
	assert.equal(calls[0].source, "scholarauthor"); assert.equal(calls[0].query.authors, "MichaelSmith");
	await ui.runAuthorAction("name-papers"); assert.equal(calls[1].source, "scholar");
	await ui.switchAuthorProvider("orcid"); await ui.switchAuthorProvider("scholar"); assert.equal(ui.get("author-input-kind").value, "name");
	ui.get("author-input-kind").value = "profile"; await ui.runAuthorAction("name-papers"); assert.equal(ui.get("status").textContent, "authorNeedName");
});

test("author startup restores the last selected profile publication context without a request", async () => {
	const prefs = {}, files = new Map(), id = "0000-0001-8277-5907";
	const profile = { provider: "orcid", id, name: "Public Author", identityConfirmed: true };
	const records = [paper("public-work", { citations: null, authors: [], authorProfile: profile })]; records.authorProfile = profile;
	const ui = uiHarness({ prefs, historyFiles: files, authorsService: { ...Authors, searchProfiles: async () => [profile], loadPublications: async () => records } });
	await ui.switchSearchMode("authors"); await ui.switchAuthorProvider("orcid"); ui.get("author-input").value = id;
	await ui.runAuthorAction("profiles"); await ui.runAuthorAction("publications", profile);
	const reopened = uiHarness({ prefs, historyFiles: files, authorsService: { ...Authors, searchProfiles: () => assert.fail("no lookup") } });
	reopened.restoreAuthorPreferences(); await reopened.switchSearchMode("authors"); await reopened.restoreCachedSearch();
	assert.equal(reopened.state.records[0].key, "public-work"); assert.match(reopened.get("author-profiles").textContent, /Public Author/);
});

test("Stop preserves published author rows as incomplete without late overwrite", async () => {
	const waiting = deferred(); let context;
	const profile = { provider: "orcid", id: "0000-0001-8277-5907", name: "Known public profile" };
	const ui = uiHarness({ authorsService: { ...Authors, loadPublications: async (_profile, _options, _http, ctx) => {
		context = ctx; ctx.onResults([paper("received-author-row", { authorProfile: profile, citations: null })]); return waiting.promise;
	} } });
	await ui.switchSearchMode("authors"); await ui.switchAuthorProvider("orcid"); ui.get("author-input").value = profile.id;
	const running = ui.runAuthorAction("publications", profile); await new Promise(resolve => setImmediate(resolve));
	ui.stopOperation(); await running;
	assert.equal(context.signal.aborted, true); assert.equal(ui.state.records[0].key, "received-author-row");
	const [entry] = await ui.history.list(); assert.equal(entry.partial, true); assert.equal(entry.query.authorProfileId, profile.id);
	waiting.resolve([paper("late")]); await new Promise(resolve => setImmediate(resolve));
	assert.equal(ui.state.records[0].key, "received-author-row");
});

test("author UI is registered after sources, and native paper fields and history controls remain available", () => {
	const markup = readFileSync(new URL("../content/search.xhtml", import.meta.url), "utf8");
	assert.ok(markup.indexOf('/sources.js') < markup.indexOf('/authors.js') && markup.indexOf('/authors.js') < markup.indexOf('/ui.js'));
	for (const id of ["mode-papers", "mode-authors", "author-form", "author-provider", "author-input-kind", "author-input", "author-stop-btn", "author-history-btn", "author-profiles", "query-form", "popRaw", "copy-pop-json"]) assert.ok(markup.includes(`id="${id}"`), id);
});

test("author form and mode button events execute the workflow and cancel edits without touching paper input", async () => {
	let calls = 0;
	const ui = uiHarness({ authorsService: { ...Authors, searchProfiles: async () => { calls++; return []; } } });
	ui.wireEvents(); ui.get("mode-authors").emit("click"); await new Promise(resolve => setImmediate(resolve));
	assert.equal(ui.searchMode(), "authors"); assert.equal(ui.get("query-form").hidden, true);
	ui.get("author-input").value = "A Scholar Name"; ui.get("author-input").emit("input");
	let prevented = false; ui.get("author-form").emit("submit", { preventDefault: () => { prevented = true; } });
	await new Promise(resolve => setImmediate(resolve)); await ui.state.searchDone;
	assert.equal(prevented, true); assert.equal(calls, 1);
	assert.equal(ui.get("keywords").value, "genome editing");
	ui.get("mode-papers").emit("click"); await new Promise(resolve => setImmediate(resolve));
	assert.equal(ui.get("query-form").hidden, false); assert.equal(ui.get("author-panel").hidden, true);
});

test("overlapping author requests serialize and generic clear cannot leave search locked", async () => {
	const delayed = deferred(); let firstSignal, calls = 0;
	const ui = uiHarness({ authorsService: { ...Authors, searchProfiles: async (_p, _i, _h, ctx) => {
		calls++; if (calls === 1) { firstSignal = ctx.signal; return delayed.promise; } return [];
	} } });
	await ui.switchSearchMode("authors"); ui.get("author-input").value = "Name";
	const a = ui.runAuthorAction("profiles"), b = ui.runAuthorAction("profiles");
	await Promise.all([a, b]); assert.equal(firstSignal.aborted, true); assert.equal(calls, 2); assert.equal(ui.state.searching, false);
	delayed.resolve([]);
	const blocked = deferred(); ui.authorSessions.scholar.profile = null;
	const other = uiHarness({ authorsService: { ...Authors, searchProfiles: async () => blocked.promise } });
	await other.switchSearchMode("authors"); other.get("author-input").value = "Name";
	const pending = other.runAuthorAction("profiles"); other.clearAll(); await pending;
	assert.equal(other.state.searching, false); assert.equal(other.state.searchController, null); blocked.resolve([]);
});

test("a Scholar profile search that hits Google's login wall falls back to the paper search by name, and says why", async () => {
	/* The reader typed a name and pressed Find profile, and got a red line and an
	   empty table, because Google now wants a signed-in account for profile
	   search. The paper search by the same name is still open, so it runs. */
	const calls = [];
	const ui = uiHarness({ realRows: true, prefs: { popDataDir: "" }, popBridge: { async searchSource(source, query) {
		calls.push(source);
		if (source === "scholarauthor") throw Object.assign(new Error("Publish or Perish (scholarauthor) search failed (3); Google requires a signed-in Google account for Scholar profile search"), { exitCode: 3, source, reason: "login" });
		return { rows: [{ title: "A matching name", rank: 1, authors: [query.authors] }], provenance: { engine: "publish-or-perish", source, complete: true, cached: false, invocationId: "name-papers" } };
	} } });
	await ui.switchSearchMode("authors"); ui.get("author-input").value = "Sheila Ingemann";
	await ui.runAuthorAction("profiles");
	assert.deepEqual(calls, ["scholarauthor", "scholar"], "the name search ran on its own");
	assert.equal(ui.state.records.length, 1, "the table is not left empty");
	assert.match(ui.get("banner-text").textContent, /scholarProfileLogin/, "the banner says why these are name results and how to get the profile");
	assert.equal(ui.state.records[0].authorProfile.identityConfirmed, false, "and does not claim the identity was verified");
	// A profile URL cannot be re-run as a name; that path stays an error.
	const urlCalls = [];
	const byUrl = uiHarness({ realRows: true, prefs: { popDataDir: "" }, popBridge: { async searchSource(source) { urlCalls.push(source); throw Object.assign(new Error("login"), { reason: "login" }); } } });
	await byUrl.switchSearchMode("authors"); byUrl.get("author-input").value = "https://scholar.google.com/citations?user=abc123";
	await byUrl.runAuthorAction("profiles");
	assert.ok(!urlCalls.includes("scholar"), "a profile URL is never re-run as a name search");
	assert.equal(byUrl.state.records.length, 0);
});

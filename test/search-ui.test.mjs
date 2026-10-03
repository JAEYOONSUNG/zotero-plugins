import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deferred, mockElement, paper, uiHarness } from "./helpers/search-ui-harness.mjs";
import Sources from "../content/sources.js";
import Authors from "../content/authors.js";
import JCR from "../content/jcr.js";

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

	// The server's Retry-After travels with the error, so the retry waits as long as it was told to.
	const limited = { response: null, responseType: "json", status: 429, getResponseHeader: name => name === "Retry-After" ? "7" : null };
	assert.equal(make({ status: 429, xmlhttp: limited }, "https://api.semanticscholar.org/graph/v1/paper/search").retryAfter, "7");

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
		paper("kr", { people: people("KAIST", "KR", 1500) }),
		paper("us", { people: people("MIT", "US", 2100) }),
		paper("none", { venue: "Somewhere" })
	] });
	await ui.runSearch();
	assert.equal(ui.sortValue(ui.state.records[0], "tier"), 1500);
	assert.equal(ui.sortValue(ui.state.records[1], "affiliation"), "1mit", "tier first, then the lab");
	assert.equal(ui.sortValue(ui.state.records[0], "affiliation"), "2kaist");
	assert.equal(ui.sortValue(ui.state.records[2], "affiliation"), "9", "no affiliation sorts last");
	assert.equal(ui.sortValue(ui.state.records[2], "tier"), -1);
	assert.equal(ui.sortValue(ui.state.records[1], "country"), "US");
	ui.state.sortKey = "tier"; ui.state.sortDir = "desc";
	ui.render();
	assert.deepEqual(ui.state.visible.map(r => r.key), ["us", "kr", "none"]);
	assert.equal(ui.matchesFilter(ui.state.records[0], "kaist"), true);
	assert.equal(ui.matchesFilter(ui.state.records[0], "us"), false);
	assert.equal(ui.matchesFilter(ui.state.records[1], "us"), true);
	const row = ui.get("results-body").firstChild;
	assert.equal(row.querySelector("span.aff-name").textContent, "MIT");
	assert.equal(row.querySelector("span.aff-flag").textContent, "🇺🇸");
	assert.equal(row.querySelector("span.tier").textContent, "T1");
	assert.equal(row.querySelector("span.aff-name").dataset.marquee, "affiliation", "only the lab's name rolls, the chip and flag stay");
	assert.equal(row.querySelector("td.country").textContent, "🇺🇸 US");
	assert.equal(row.querySelector("span.tier").textContent, "T1");
	const affCard = ui.tipContent(row.querySelector("td.aff"), "aff").textContent;
	assert.equal(row.querySelector("td.aff").getAttribute("title"), null, "the native tooltip is gone; the hover card replaces it");
	assert.match(affCard, /^MIT.*tipTierAbove\|2100\|T1\|2000.*affFirst.*A$/, "institution, tier line with its band, then which author it belongs to");
	const csv = ui.csvText().split("\n");
	assert.match(csv[1], /"MIT","US","2100"/);
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
	/* Both themes' inks travel on the cell; the stylesheet picks one with prefers-color-scheme, so a dark
	   page, a live theme switch and a static copy never wear the light ink. */
	// Science keeps its red hue (4); the colour-harmony pass caps saturation at 55% and draws every ink at one luminance
	assert.match(venue.style["--j-ink-l"], /^hsl\(4 55% \d+%\)$/);
	assert.match(venue.style["--j-ink-d"], /^hsl\(\d+ \d+% \d+%\)$/);
	assert.notEqual(venue.style["--j-ink-l"], venue.style["--j-ink-d"], "a light and a dark ink");
	assert.equal(venue.style.color, undefined, "no inline colour that would pin one theme");
	assert.equal(venue.getAttribute("title"), null);
	const journalCard = ui.tipContent(venue, "journal").textContent;
	assert.ok(journalCard.startsWith("Science") && journalCard.includes("American Association for the Advancement of Science (AAAS)"), journalCard);
	assert.equal(venue.dataset.marquee, "venue");
	assert.match(ui.tipContent(rows[1].querySelector("td.venue"), "journal").textContent, /^Journal of Cleaner Production.*tipAbbrev.*J Clean Prod.*tipPublisher.*Elsevier/);
	assert.equal(rows[1].querySelector("td.venue").classList.contains("venue-known"), true, "the publisher placed it");
	assert.equal(rows[2].querySelector("td.venue").style["--j-ink-l"], undefined);
	// The detail pane shows the abbreviation as a chip in the same colour.
	ui.state.detailKey = "sci";
	ui.state.records[0].journalAbbrev = "Science";
});

test("the window is in English unless told otherwise; Follow Zotero and 한국어 are choices", async () => {
  const fs = await import("node:fs");
  const read = name => fs.readFileSync(new URL("../" + name, import.meta.url), "utf8");
  /* English is the default: a profile that never chose gets English, even under a Korean Zotero. */
  assert.match(read("prefs.js"), /extensions\.zotpop\.language",\s*"en"/);
  for (const file of ["content/ui.js", "content/proxylogin.js"]) {
    assert.match(read(file), /PREF\("language"\)\s*\|\|\s*"en"/, file);
    assert.doesNotMatch(read(file), /PREF\("language"\)\s*\|\|\s*"auto"/, file);
  }
  // And "auto" must never reach anything that expects a real language.
  assert.doesNotMatch(read("content/ui.js"), /language:\s*t\.locale\s*\|\|\s*PREF/);
  // The pane offers English, 한국어, then Follow Zotero.
  const menu = read("content/preferences.xhtml");
  assert.ok(menu.indexOf('value="en"') < menu.indexOf('value="ko"') && menu.indexOf('value="ko"') < menu.indexOf('value="auto"'));
  const I18N = (await import("../content/i18n.js")).default;
  for (const locale of ["en", "ko"]) {
    const s = I18N.STRINGS[locale];
    // Each choice is named in its own language, whatever the window speaks, and the label says both.
    assert.equal(s.prefLangEn, "English");
    assert.equal(s.prefLangKo, "한국어");
    assert.match(s.prefLangAuto, /Follow Zotero/);
    assert.match(s.prefLangAuto, /Zotero 언어 따르기/);
    assert.match(s.prefLanguage, /Language/);
    assert.match(s.prefLanguage, /언어/);
  }
  // Nothing set, empty, or unknown is English; only auto asks Zotero, and only a Korean Zotero gives Korean.
  assert.equal(I18N.resolveLocale(undefined, "ko-KR"), "en");
  assert.equal(I18N.resolveLocale("", "ko-KR"), "en");
  assert.equal(I18N.resolveLocale("fr", "ko-KR"), "en");
  assert.equal(I18N.resolveLocale("auto", "ko-KR"), "ko");
  assert.equal(I18N.resolveLocale("auto", "en-US"), "en");
  assert.equal(I18N.resolveLocale("auto", ""), "en");
  assert.equal(I18N.resolveLocale("auto", undefined), "en");
  assert.equal(I18N.resolveLocale("ko", "en-US"), "ko");
  assert.equal(I18N.resolveLocale("en", "ko-KR"), "en");
});

test("the search window's View menu has a Language group that saves the choice and reopens the window", async () => {
  const ui = uiHarness();
  let items = Array.from(ui.viewMenuItems());
  const at = items.findIndex(item => item.heading === "Language / 언어");
  assert.ok(at > 0, "a captioned group in the View menu");
  const group = items.slice(at + 1);
  assert.deepEqual(Array.from(group, item => item.label), ["English", "한국어", "Follow Zotero / Zotero 언어 따르기"]);
  assert.ok(group.every(item => item.radio && !item.disabled), "radio choices, none dimmed");
  assert.deepEqual(Array.from(group, item => item.check), [true, false, false], "English is chosen when nothing was");
  // Choosing one writes the setting and reopens the window in it.
  group[1].run();
  assert.equal(ui.prefs.language, "ko");
  assert.equal(ui.reloads.length, 1);
  items = Array.from(ui.viewMenuItems());
  assert.deepEqual(Array.from(items.slice(at + 1), item => item.check), [false, true, false]);
  // The same choice again does nothing.
  items.slice(at + 1)[1].run();
  assert.equal(ui.reloads.length, 1);
  items.slice(at + 1)[2].run();
  assert.equal(ui.prefs.language, "auto");
  // A search in progress is not interrupted: the choice is saved and the window says it applies later.
  ui.state.searching = true;
  Array.from(ui.viewMenuItems()).slice(at + 1)[0].run();
  assert.equal(ui.prefs.language, "en");
  assert.equal(ui.reloads.length, 2, "no reload while searching");
  assert.match(ui.get("status").textContent, /^langAppliesLater/);
  // The menu draws the caption as a caption, not as a dimmed item.
  ui.state.searching = false;
  ui.openToolbarMenu(ui.get("view-btn"), ui.viewMenuItems(), "view");
  const drawn = Array.from(ui.get("tbmenu").children);
  assert.ok(drawn.some(node => node.className === "selhead" && node.textContent === "Language / 언어"));
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

test("without the reader's own export every figure is the OpenAlex estimate", async () => {
	// The Journal Impact Factor is licensed to whoever subscribes to it, so the plugin
	// carries none and nothing on screen may claim to be one until an export is loaded.
	JCR.load([]);
	const ui = uiHarness({ search: async () => [paper("nc", { venue: "Nature Communications", issn: "2041-1723", journalIF: 17.5 })] });
	await ui.runSearch();
	const row = ui.state.records.find(r => r.key === "nc");
	assert.equal(row.journalIF, 17.5, "the OpenAlex figure stands");
	assert.notEqual(row.journalIFEstimate, false, "and is not passed off as the JCR figure");
});

test("a restored or freshly displayed result gets the JCR impact factor, and an OpenAlex-only figure is marked as an estimate", async () => {
	// As it is after the reader has put their own Journal Citation Reports export in
	// the Zotero data directory; the plugin reads it from there at window load.
	JCR.load([["Nature Communications", "NAT COMMUN", "", "2041-1723", 18.1]]);
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
	JCR.load([]);
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
	const link = rows[0].querySelector("td.title").querySelector("span");
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
	ui.wireEvents();
	ui.get("export-btn").emit("click");
	assert.deepEqual(Array.from(ui.get("tbmenu").children.filter(c => c.tagName === "DIV"), c => c.textContent), ["copyCsv", "saveCsv", "popOriginalJSON"], "the original JSON is offered when every row came from PoP");
	ui.closeToolbarMenu();
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
	assert.equal(ui.get("authors").getAttribute("data-tip"), "popAuthorsHelp");
	assert.equal(ui.get("title").getAttribute("data-tip"), "popTitleHelp");
	ui.get("engine").value = "direct"; ui.sourceHint();
	assert.equal(ui.get("authors").getAttribute("data-tip"), "authorsHelp");
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
	ui.get("author-profiles").querySelector("button.author-load").emit("click");
	await new Promise(resolve => setImmediate(resolve)); await ui.state.searchDone;
	// OpenAlex is asked first for an ORCID iD's papers and knows none in this fixture, so the ORCID list is read
	assert.equal(ui.state.records.length, 2); assert.equal(requests.length, 3);
	assert.match(requests[1], /^https:\/\/api\.openalex\.org\/works\?filter=authorships\.author\.orcid:0000-0001-8277-5907/);
	assert.ok(ui.state.records.every(row => row.citations === null && row.authors.length === 0));
	assert.equal(ui.get("status").textContent, `authorOrcidWorks|Sheila Ingemann Jensen|${id}|2|true`);
	assert.match(ui.get("banner-text").textContent, /authorOrcidViaOrcid/); assert.equal(ui.state.sortKey, "year"); assert.equal(ui.state.sortDir, "desc");
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
	assert.doesNotMatch(ui.get("author-profiles").textContent, /authorLoadWorks/, "name results cannot be selected as a confirmed profile");
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
	ui.get("author-input").value = "0000-0002-1825-0098"; await ui.runAuthorAction("profiles");
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
	for (const id of ["mode-papers", "mode-authors", "author-form", "author-provider", "author-input-kind", "author-input", "author-stop-btn", "author-history-btn", "author-profiles", "query-form", "popRaw", "export-btn", "view-btn", "tbmenu", "d-primary", "d-more", "d-versions", "lib-filter"]) assert.ok(markup.includes(`id="${id}"`), id);
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

test("the keyboard reaches what the mouse reaches: copy, deselect, jump to either end", async () => {
	/* ⌘C copies the focused row's citation and ⇧⌘C its DOI; Backspace deselects the
	   focused row and ⌘Backspace clears every selection; Home and End move focus
	   to the ends, which used to scroll the table while the focus stayed put. */
	const ui = uiHarness({ realRows: true, search: async () => [
		paper("first", { title: "First paper", doi: "10.1/first", authors: [{ name: "A" }], year: 2020, venue: "J" }),
		paper("second", { title: "Second paper", doi: "10.1/second", authors: [{ name: "B" }], year: 2021, venue: "J" }),
		paper("third", { title: "Third paper", doi: "10.1/third", authors: [{ name: "C" }], year: 2022, venue: "J" })
	] });
	await ui.runSearch();
	const press = (key, extra = {}) => ui.onKeyDown({ key, preventDefault() {}, ...extra });
	press("End");
	assert.equal(ui.state.focusKey, "third");
	press("Home");
	assert.equal(ui.state.focusKey, "first");
	press(" ");
	assert.equal(ui.state.selected.has("first"), true);
	press("Backspace");
	assert.equal(ui.state.selected.has("first"), false, "Backspace deselects the focused row");
	press("a", { metaKey: true });
	assert.equal(ui.state.selected.size, 3);
	press("Backspace", { metaKey: true });
	assert.equal(ui.state.selected.size, 0, "⌘Backspace clears the selection");
	press("c", { metaKey: true });
	assert.match(ui.copied.at(-1), /First paper/, "⌘C copies the citation");
	press("c", { metaKey: true, shiftKey: true });
	assert.equal(ui.copied.at(-1), "10.1/first", "⇧⌘C copies the DOI");
	assert.match(ui.get("status").textContent, /copiedDoi|DOI/);
});

test("a result limit that is not a whole number reaches the validator instead of becoming 200", async () => {
	// The engine refuses "Result limit must be an integer from 1 to 2000"; it never saw
	// the mistake, because the box turned 0 and "twenty" into a silent 200.
	for (const [typed, expected] of [["0", 0], ["twenty", "twenty"], ["-4", -4], ["", 200], ["50", 50]]) {
		let asked;
		const ui = uiHarness({ search: async (_source, query) => { asked = query; return []; } });
		ui.get("maxResults").value = typed;
		ui.get("keywords").value = "geobacillus";
		await ui.runSearch();
		assert.deepEqual(asked.maxResults, expected, `"${typed}" is passed on as typed`);
	}
	await assert.rejects(() => Sources.search("openalex", { keywords: "x", maxResults: "twenty" }, { getJSON: async () => ({}) }, {}),
		/Result limit must be an integer/);
});

test("an empty table after a search that ran says so, and says when a source failed", async () => {
	const ui = uiHarness({ search: async () => [] });
	ui.render();
	assert.match(String(ui.get("empty").textContent), /emptyInitial/, "before any search");
	ui.get("keywords").value = "geobacillus";
	await ui.runSearch();
	assert.match(String(ui.get("empty").textContent), /emptyAfterSearch/, "after a search that ran");

	// Sources.search is what normally creates ctx.errors, and it is mocked out here.
	const failed = uiHarness({ search: async (_source, _query, _http, context) => { context.errors = ["OpenAlex: HTTP 429"]; return []; } });
	failed.get("keywords").value = "geobacillus";
	await failed.runSearch();
	assert.match(String(failed.get("empty").textContent), /emptyAfterPartial/,
		"nothing found plus a failed source is not the same as no such paper");
});

test("a search cut at the result limit says how many the source had", async () => {
	const ui = uiHarness({ search: async (_source, _query, _http, ctx) => {
		ctx.sourceStatus = { pubmed: { retrieved: 2, total: 5000, limit: 2, reason: "result-limit" } };
		return [paper("a", { citations: 1 }), paper("b", { citations: 2 })];
	} });
	await ui.runSearch();
	assert.match(ui.get("status").textContent, /^resultCount\|.*\|2\|false\|5000$/, "the total the source reported reaches the status line");
});

test("the in-library mark leads to the copy an import found, even without a DOI", async () => {
	const picked = [];
	const ui = uiHarness({ mainWindow: { ZoteroPane: { selectItem: id => picked.push(id) } } });
	ui.showInLibrary({ title: "No DOI here", libraryItemID: 42 });
	assert.deepEqual(picked, [42]);
});

test("Shift with the arrows selects a range from the starting row, and going back shrinks it", async () => {
	const ui = uiHarness({ search: async () => [paper("r0"), paper("r1"), paper("r2"), paper("r3")] });
	await ui.runSearch();
	const press = (key, extra = {}) => ui.onKeyDown({ key, preventDefault() {}, ...extra });
	ui.state.focusKey = ui.state.visible[0].key;
	ui.state.selected.clear();
	press("ArrowDown", { shiftKey: true });
	press("ArrowDown", { shiftKey: true });
	assert.deepEqual([...ui.state.selected].sort(), [0, 1, 2].map(i => ui.state.visible[i].key).sort(), "the starting row is in the range");
	press("ArrowUp", { shiftKey: true });
	assert.deepEqual([...ui.state.selected].sort(), [0, 1].map(i => ui.state.visible[i].key).sort(), "going back shrinks it");
});

test("an item a DOI translator made keeps the abstract and PubMed IDs the search result had", async () => {
	const source = readFileSync(new URL("../content/importer.js", import.meta.url), "utf8");
	const sandbox = { Zotero: { logError() {}, ItemFields: { getID: () => 1, isValidForType: () => true } }, ZotPoPSources: {}, module: { exports: {} } };
	sandbox.globalThis = sandbox;
	const vm = await import("node:vm");
	vm.createContext(sandbox);
	vm.runInContext(source + "\nglobalThis.__api = ZotPoPImporter;", sandbox);
	const fields = { abstractNote: "", extra: "Citations: 3" };
	let saved = 0;
	const item = { itemTypeID: 1, getField: k => fields[k] || "", setField: (k, v) => { fields[k] = v; }, saveTx: async () => { saved++; } };
	assert.equal(await sandbox.__api.backfill(item, { abstract: "What the paper found.", pmid: "123", pmcid: "PMC9" }), true);
	assert.equal(fields.abstractNote, "What the paper found.");
	assert.match(fields.extra, /^Citations: 3\nPMID: 123\nPMCID: PMC9$/);
	fields.abstractNote = "The translator's own";
	assert.equal(await sandbox.__api.backfill(item, { abstract: "Other", pmid: "123" }), false, "nothing is overwritten or added twice");
	assert.equal(saved, 1);
});

test("a result the library holds without a DOI is marked by title, as the import would find it", async () => {
	const importer = {
		getLibraryDOIMap: async () => new Map([["10.1/owned", 5]]),
		findByTitle: async (_lib, title) => title === "Held without a DOI on the shelf" ? 9 : null
	};
	const ui = uiHarness({ importer, search: async () => [
		paper("a", { doi: "10.1/owned" }), paper("b", { title: "Held without a DOI on the shelf" }), paper("c", { title: "Not here at all in this library" })] });
	await ui.runSearch();
	const mark = key => ui.state.records.find(r => r.key === key).inLibrary;
	assert.equal(mark("a"), true);
	assert.equal(mark("b"), true, "found by title and year");
	assert.equal(mark("c"), false);
	assert.equal(ui.state.records.find(r => r.key === "b").libraryItemID, 9);
});

test("sorting by affiliation summarises each author list once, not once per comparison", async () => {
	const Aff = (await import("../content/affiliations.js")).default;
	const real = Aff.summarise;
	let calls = 0;
	Aff.summarise = people => { calls++; return real(people); };
	try {
		const ui = uiHarness();
		const records = Array.from({ length: 200 }, (_, i) => paper("p" + i, { people: [{ name: "A" + i, institutions: [] }] }));
		for (let round = 0; round < 3; round++) for (const r of records) ui.sortValue(r, "affiliation");
		assert.ok(calls > 0, "the summary is really asked for");
		assert.ok(calls <= records.length, `${calls} summaries for ${records.length} records over three passes`);
	} finally { Aff.summarise = real; }
});

test("an item made by hand keeps the day the source gave, and a bad date falls back to the year", async () => {
	const source = readFileSync(new URL("../content/importer.js", import.meta.url), "utf8");
	const sandbox = { Zotero: { logError() {} }, ZotPoPSources: {}, module: { exports: {} } };
	sandbox.globalThis = sandbox;
	const vm = await import("node:vm");
	vm.createContext(sandbox);
	vm.runInContext(source + "\nglobalThis.__api = ZotPoPImporter;", sandbox);
	const date = sandbox.__api.publicationDate;
	assert.equal(date({ publicationDate: "2026-09-14", year: 2026 }), "2026-09-14");
	assert.equal(date({ publicationDate: "2026-09", year: 2026 }), "2026-09");
	assert.equal(date({ publicationDate: "2026-02-30", year: 2026 }), "2026", "no such day");
	assert.equal(date({ publicationDate: "2025-12-01", year: 2026 }), "2026", "a date that disagrees with the year is not trusted");
	assert.equal(date({ year: 2020 }), "2020");
});

test("a JCR impact factor is saved and exported as JCR, an OpenAlex figure as OpenAlex", async () => {
	const source = readFileSync(new URL("../content/importer.js", import.meta.url), "utf8");
	const sandbox = { Zotero: { logError() {} }, ZotPoPSources: {}, module: { exports: {} } };
	sandbox.globalThis = sandbox;
	const vm = await import("node:vm");
	vm.createContext(sandbox);
	vm.runInContext(source + "\nglobalThis.__api = ZotPoPImporter;", sandbox);
	const label = sandbox.__api.journalFigureLabel;
	assert.equal(label({ journalIF: 56.1, journalIFSource: "JCR 2025", journalIFEstimate: false }), "JCR 2025");
	assert.equal(label({ journalIF: 18.9, journalIFEstimate: true }), "OpenAlex 2y");
	const ui = uiHarness({ search: async () => [paper("a", { journalIF: 56.1, journalIFSource: JCR.EDITION, journalIFEstimate: false })] });
	await ui.runSearch();
	assert.ok(ui.csvText().split("\n")[1].includes(`"56.10","${JCR.EDITION}"`), "the CSV says which figure it is");
});

test("a preprint and the paper it became are two records, though their titles match", async () => {
	const source = readFileSync(new URL("../content/importer.js", import.meta.url), "utf8");
	const sandbox = { Zotero: { logError() {} }, ZotPoPSources: {}, module: { exports: {} } };
	sandbox.globalThis = sandbox;
	const vm = await import("node:vm");
	vm.createContext(sandbox);
	vm.runInContext(source + "\nglobalThis.__api = ZotPoPImporter;", sandbox);
	const same = sandbox.__api.sameWorkIdentifiers;
	const item = doi => ({ getField: k => k === "DOI" ? doi : "" });
	assert.equal(same({ doi: "10.1101/2024.01.01.123" }, item("10.1038/s41586-024-1")), false, "different DOIs: not a duplicate");
	assert.equal(same({ doi: "https://doi.org/10.1/ABC" }, item("10.1/abc")), true, "one DOI written two ways");
	assert.equal(same({ doi: "10.1/x" }, item("")), true, "no DOI on the shelf: the title decides");
});

test("a title match skips the preprint with another DOI and finds the copy without one", async () => {
	const source = readFileSync(new URL("../content/importer.js", import.meta.url), "utf8");
	const rows = [
		{ itemID: 3, title: "A thermostable type I-B CRISPR-Cas system", date: "2023", doi: "10.1101/2023.01.01.500" },
		{ itemID: 4, title: "A thermostable type I-B CRISPR-Cas system", date: "2023", doi: null }];
	const sandbox = { Zotero: { logError() {}, DB: { queryAsync: async () => rows } }, ZotPoPSources: {}, module: { exports: {} } };
	sandbox.globalThis = sandbox;
	const vm = await import("node:vm");
	vm.createContext(sandbox);
	vm.runInContext(source + "\nglobalThis.__api = ZotPoPImporter;", sandbox);
	const api = sandbox.__api;
	assert.equal(await api.findByTitle(1, "A thermostable type I-B CRISPR-Cas system", "2023", { doi: "10.1038/s41586-023-1" }), 4, "the copy without a DOI, not the preprint");
	assert.equal(await api.findByTitle(1, "A thermostable type I-B CRISPR-Cas system", "2023", { doi: "https://doi.org/10.1101/2023.01.01.500" }), 3, "the same DOI written another way");
	rows[1].extra = "DOI: 10.9/elsewhere";
	api.forgetTitleIndex();
	assert.equal(await api.findByTitle(1, "A thermostable type I-B CRISPR-Cas system", "2023", { doi: "10.1038/s41586-023-1" }), null, "a DOI kept in Extra counts as a DOI");
});

test("a budget spent in one search is remembered by the window for the next", async () => {
	const seen = [];
	const ui = uiHarness({ search: async (_s, _q, _h, ctx) => { seen.push(ctx.openAlexSpent); ctx.openAlexSpent = true; return [paper("a")]; } });
	await ui.runSearch();
	await ui.runSearch();
	assert.deepEqual(seen, [false, true], "the second search starts knowing");
});

test("titles keep α and β and Korean letters, and a DOI is the same however it was written", async () => {
	const source = readFileSync(new URL("../content/importer.js", import.meta.url), "utf8");
	const rows = [{ itemID: 1, value: "https://doi.org/10.1038/ABC.1" }, { itemID: 2, value: "Note\nDOI: 10.1016/j.cell.2020.01.001" }];
	const sandbox = { Zotero: { logError() {}, DB: { queryAsync: async () => rows } }, ZotPoPSources: { normalizeDOI: Sources.normalizeDOI }, module: { exports: {} } };
	sandbox.globalThis = sandbox;
	const vm = await import("node:vm");
	vm.createContext(sandbox);
	vm.runInContext(source + "\nglobalThis.__api = ZotPoPImporter;", sandbox);
	const api = sandbox.__api;
	assert.notEqual(api.flatTitle("α-synuclein aggregation in dopaminergic neurons"), api.flatTitle("β-synuclein aggregation in dopaminergic neurons"));
	assert.equal(api.flatTitle("한국 연구자의 유전체 편집 동향 분석"), "한국 연구자의 유전체 편집 동향 분석");
	const map = await api.getLibraryDOIMap(1);
	assert.equal(map.get("10.1038/abc.1"), 1, "a doi.org link in the field");
	assert.equal(map.get("10.1016/j.cell.2020.01.001"), 2, "a DOI line in Extra");
});

test("the statistics can be switched from the highest per paper to one index's own counts", async () => {
	const ui = uiHarness({ metrics: (await import("../content/metrics.js")).default });
	ui.state.records = ui.state.visible = [
		paper("a", { citations: 3, year: 2020, citationsBy: { openalex: 3, crossref: 0 } }),
		paper("b", { citations: 3, year: 2020, citationsBy: { openalex: 0, crossref: 3 } }),
		paper("c", { citations: 3, year: 2020, citationsBy: { crossref: 3 } })];
	ui.originalRenderMetrics(ui.state.records);
	const box = ui.get("metrics-basis");
	assert.equal(box.hidden, false);
	const buttons = box.children.filter(c => c.tagName !== "#text");
	assert.equal(buttons.length, 3, "highest, OpenAlex, Crossref");
	const hBefore = ui.get("m-h").textContent;
	buttons.find(b => /openalex/i.test(b.textContent)).emit("click");
	assert.equal(ui.state.metricsBasis, "openalex");
	ui.originalRenderMetrics(ui.state.records); // the harness stubs the redraw the click asks for
	assert.equal(ui.get("m-h").textContent, "1");
	assert.notEqual(ui.get("m-h").textContent, hBefore, "the h-index is OpenAlex's own now");
});

test("a paper already on the shelf gets a PDF only when it has none, and never twice at once", async () => {
	const source = readFileSync(new URL("../content/importer.js", import.meta.url), "utf8");
	let tries = 0;
	const items = new Map([[7, { id: 7, attachmentContentType: "application/pdf" }]]);
	const sandbox = { Zotero: { logError() {}, Items: { get: id => items.get(id) }, Libraries: { get: () => ({ filesEditable: true }) },
		Attachments: { addAvailableFile: async () => { tries++; await new Promise(r => setTimeout(r, 5)); return { id: 9 }; } } }, ZotPoPSources: {}, module: { exports: {} } };
	sandbox.globalThis = sandbox;
	const vm = await import("node:vm");
	vm.createContext(sandbox);
	vm.runInContext(source + "\nglobalThis.__api = ZotPoPImporter;", sandbox);
	const api = sandbox.__api;
	assert.equal(await api.fillPDF({ id: 1, libraryID: 1, getAttachments: () => [7] }, {}, {}), "has pdf", "a PDF record counts, even one still syncing");
	assert.equal(tries, 0);
	const bare = { id: 2, libraryID: 1, getAttachments: () => [] };
	const [a, b] = await Promise.all([api.fillPDF(bare, {}, {}), api.fillPDF(bare, {}, {})]);
	assert.deepEqual([a, b].sort(), ["pdf:zotero", "skipped"], "the second press does not fetch a second copy");
	assert.equal(tries, 1);
});

test("a DOI match is exact: underscores and percent signs are not wildcards, and a longer DOI is not a match", async () => {
	const source = readFileSync(new URL("../content/importer.js", import.meta.url), "utf8");
	let rows = [];
	const sandbox = { Zotero: { logError() {}, DB: { queryAsync: async () => rows } }, ZotPoPSources: { normalizeDOI: Sources.normalizeDOI }, module: { exports: {} } };
	sandbox.globalThis = sandbox;
	const vm = await import("node:vm");
	vm.createContext(sandbox);
	vm.runInContext(source + "\nglobalThis.__api = ZotPoPImporter;", sandbox);
	const api = sandbox.__api;
	rows = [{ itemID: 1, fieldName: "DOI", value: "10.1234/aXb" }, { itemID: 2, fieldName: "DOI", value: "10.1234/a_bcdef" }];
	assert.equal(await api.findByDOI(1, "10.1234/a_b"), null, "neither aXb nor a_bcdef is a_b");
	rows = [{ itemID: 3, fieldName: "DOI", value: "http://dx.doi.org/10.1234/A_B" }];
	assert.equal(await api.findByDOI(1, "10.1234/a_b"), 3, "the same DOI written as a link");
	rows = [{ itemID: 4, fieldName: "extra", value: "PMID: 1\nDOI:10.1234/a_b" }];
	assert.equal(await api.findByDOI(1, "10.1234/a_b"), 4, "and in Extra");
});

test("the metrics notes are one line each with a (?) that opens the full text, and the table keeps the top", async () => {
	const Metrics = (await import("../content/metrics.js")).default;
	const ui = uiHarness({ metrics: Metrics });
	ui.originalRenderMetrics([paper("a", { citations: 5, citationSource: "openalex", citationSources: ["openalex", "crossref"] }), paper("b", { citations: null })]);
	assert.equal(ui.get("metrics-hint").hidden, true, "no paragraph above the numbers once there are results");
	const notes = ui.get("metrics-notes");
	const helps = notes.querySelectorAll("button");
	assert.ok(helps.length >= 2, "an unknown-count line and the scope line");
	assert.match(notes.textContent, /metricsUnknownShort\|1\|2/);
	assert.doesNotMatch(notes.querySelectorAll("div").filter(d => d.className === "metrics-note-line").map(d => d.textContent).join(""), /metricsUnknown\|/, "the line is the short form");
	const fulls = notes.querySelectorAll("p");
	assert.ok(fulls.every(p => p.hidden), "full texts start closed");
	assert.equal(helps[0].getAttribute("aria-expanded"), "false");
	helps[0].emit("click");
	assert.equal(helps[0].getAttribute("aria-expanded"), "true");
	assert.equal(fulls[0].hidden, false);
	assert.match(fulls[0].textContent, /metricsUnknown\|1\|2/);
	helps[0].emit("click");
	assert.equal(fulls[0].hidden, true);
});

test("a row already in the library shows Style Custom's reading state beside the check, only when present", async () => {
	const importer = {
		getLibraryDOIMap: async () => new Map([["10.1/a", 5], ["10.1/b", 6]]),
		getReadingStates: async ids => { assert.deepEqual([...ids].sort(), [5, 6]); return new Map([[5, "reading"]]); }
	};
	const ui = uiHarness({ importer, realRows: true, search: async () => [paper("a", { doi: "10.1/a" }), paper("b", { doi: "10.1/b" }), paper("c", { doi: "10.1/c" })] });
	await ui.runSearch();
	const rec = key => ui.state.records.find(r => r.key === key);
	assert.equal(rec("a").readState, "reading");
	assert.equal(rec("b").readState, null);
	assert.equal(rec("c").readState, null);
	const cell = key => ui.buildRow(rec(key)).querySelector("td.lib");
	const badge = cell("a").querySelector(".read-state");
	assert.equal(badge.textContent, "readReading");
	assert.equal(badge.getAttribute("data-tip"), "readStateTip");
	assert.equal(badge.getAttribute("title"), null);
	assert.equal(cell("b").querySelector(".read-state"), null);
	assert.equal(cell("c").querySelector(".read-state"), null);
});

test("Style Custom's tags are read for the found items in one query, done over reading over unread", async () => {
	const { readFileSync } = await import("node:fs");
	const vm = await import("node:vm");
	const source = readFileSync(new URL("../content/importer.js", import.meta.url), "utf8");
	const queries = [];
	const sandbox = { Zotero: { logError() {}, DB: { queryAsync: async (sql, params) => { queries.push([sql, params]); return [
		{ itemID: 1, name: "/unread" }, { itemID: 1, name: "/Done" }, { itemID: 2, name: "/reading" }]; } } }, ZotPoPSources: {}, module: { exports: {} } };
	sandbox.globalThis = sandbox; vm.createContext(sandbox);
	vm.runInContext(source + "\nglobalThis.__api = ZotPoPImporter;", sandbox);
	const states = await sandbox.__api.getReadingStates([1, 2, 2, 3]);
	assert.equal(JSON.stringify([...states]), JSON.stringify([[1, "done"], [2, "reading"]]));
	assert.equal(queries.length, 1);
	assert.equal(JSON.stringify(queries[0][1]), "[1,2,3]");
	assert.equal((await sandbox.__api.getReadingStates([])).size, 0);
	sandbox.Zotero.DB.queryAsync = async () => { throw new Error("locked"); };
	assert.equal((await sandbox.__api.getReadingStates([1])).size, 0, "a database that cannot be read is a missing hint");
});

test("the add options stay one summary line in the footer, opened by hand, whatever is selected", async () => {
	const ui = uiHarness({ search: async () => [paper("a"), paper("b")] });
	await ui.runSearch(); ui.wireEvents();
	const toggle = ui.get("import-opts-toggle"), box = ui.get("import-opts");
	assert.equal(box.hidden, true, "folded with nothing selected");
	assert.equal(toggle.hidden, false);
	assert.match(toggle.textContent, /^optsSummary\|/);
	assert.equal(toggle.getAttribute("aria-expanded"), "false");
	toggle.emit("click");
	assert.equal(box.hidden, false, "the toggle opens them by hand");
	assert.equal(toggle.getAttribute("aria-expanded"), "true");
	assert.match(toggle.textContent, /optsHide/);
	toggle.emit("click");
	assert.equal(box.hidden, true);
	// Choosing rows changes the count and the button, never the shape of the footer.
	ui.state.selected.add("a"); ui.render();
	assert.equal(box.hidden, true, "selecting a row does not reflow the footer");
	assert.equal(toggle.hidden, false, "the summary line is there in both states");
	assert.equal(ui.get("import-btn").disabled, false);
	ui.state.selected.clear(); ui.render();
	assert.equal(box.hidden, true);
	// The values are untouched by folding.
	ui.get("opt-fillpdf").checked = true; ui.get("opt-fillpdf").emit("change");
	assert.equal(ui.prefs.fillMissingPDF, true);
	assert.match(toggle.textContent, /optFillPdfShort/);
});

// ---- the reviewer's round: default columns, evidence and author facet, selection and retry
const person = (name, extra = {}) => ({ name, ...extra });
const round = () => [
	paper("a", { title: "A", year: 2025, citations: 10, authors: [person("Jenna Dowd"), person("Ben Oakley")] }),
	paper("b", { title: "B", year: 2024, citations: 200, inLibrary: true, authors: [person("Jenna Dowd")] }),
	paper("c", { title: "C", year: 2026, citations: 3, authors: [person("jenna  dowd"), person("Other Person")] }),
	paper("d", { title: "D", year: 2026, citations: null, authors: [person("Someone Else")] }),
	paper("e", { title: "E", year: 2023, citations: 5, authors: [person("X", { openalexId: "A1" }), person("Y")] }),
	paper("f", { title: "F", year: 2023, citations: 6, authors: [person("X Renamed", { openalexId: "A1" })] })
];
async function loaded(options = {}) {
	const ui = uiHarness({ realRows: true, search: async () => round(), ...options });
	await ui.runSearch(); ui.wireEvents();
	ui.state.records.forEach((r, i) => { r.inLibrary = r.key === "b"; });
	return ui;
}

test("the default result columns put the title second and hide five columns until All is chosen", async () => {
	const markup = readFileSync(new URL("../content/search.xhtml", import.meta.url), "utf8");
	const css = readFileSync(new URL("../content/search.css", import.meta.url), "utf8");
	const cols = [...markup.matchAll(/<col data-k="([^"]+)"/g)].map(m => m[1]);
	assert.deepEqual(cols.slice(0, 4), ["chk", "title", "authorString", "affiliation"], "the institution column is visible by default, right behind the authors");
	assert.doesNotMatch(/\[data-cols="basic"\] \[data-k="rank"\][\s\S]*?\{ display: none; \}/.exec(css)[0], /data-k="affiliation"/);
	const hidden = /\[data-cols="basic"\] \[data-k="rank"\][\s\S]*?\{ display: none; \}/.exec(css)[0];
	for (const key of ["rank", "country", "tier", "doi"]) assert.match(hidden, new RegExp(`data-k="${key}"`));
	assert.match(hidden, /:not\(\[data-status\]\) \[data-k="status"\]/, "status only shows once a row has one");
	assert.ok(!markup.includes('id="select-all"'), "the toolbar's second select-all is gone");
	const ui = await loaded();
	const table = ui.get("results-table");
	assert.equal(table.getAttribute("data-cols"), "basic");
	assert.equal(table.hasAttribute("data-status"), false);
	ui.setRowStatus(ui.state.records[0], "Added", "ok");
	assert.equal(table.hasAttribute("data-status"), true);
	const pick = index => { ui.get("view-btn").emit("click"); ui.get("tbmenu").children.filter(c => c.tagName === "DIV")[index].emit("click"); };
	pick(1);
	assert.equal(table.getAttribute("data-cols"), "all");
	assert.equal(ui.prefs.colsMode, "all", "the choice is remembered");
	pick(0);
	assert.equal(table.getAttribute("data-cols"), "basic");
});

test("the detail says its figures once, in one sentence, and never hides an unknown count as zero", async () => {
	const ui = await loaded({ metrics: { citesPerYear: r => r.citations == null ? null : r.citations / Math.max(1, 2026 - r.year) } });
	const ctx = key => ui.buildResultContext(ui.state.records.find(r => r.key === key));
	ui.state.records.find(r => r.key === "a").journalIF = 10.1;
	ui.state.records.find(r => r.key === "a").journalIFEstimate = true;
	ui.state.records.find(r => r.key === "a").pdfUrl = "https://example.invalid/a.pdf";
	assert.deepEqual(Array.from(ctx("a").evidence), ["evCites||10", "evPerYear|10.0", "evIF|10.1|true", "evPdf"]);
	assert.deepEqual(Array.from(ctx("d").evidence), ["evCitesUnknown|"], "an unknown count reads as unknown");
	assert.match(ctx("c").evidence[0], /^evCites\|\|3$/, "and a real count as a number");
});

test("same-name authors are counted over this search only, by ID when there is one, and narrow the table", async () => {
	const ui = await loaded();
	const a = ui.state.records.find(r => r.key === "a");
	const jenna = ui.buildResultContext(a).authors;
	assert.equal(jenna.length, 1, "an author with one result is not offered");
	assert.equal(jenna[0].name, "Jenna Dowd");
	assert.equal(jenna[0].byId, false, "a name-only key never claims identity");
	assert.deepEqual([jenna[0].total, jenna[0].unowned], [3, 2]);
	const byId = ui.buildResultContext(ui.state.records.find(r => r.key === "e")).authors[0];
	assert.equal(byId.byId, true);
	assert.equal(byId.total, 2, "two spellings of one author ID are one author");
	ui.setFacet({ key: jenna[0].key, name: jenna[0].name, byId: false });
	assert.deepEqual(Array.from(ui.state.visible, r => r.key).sort(), ["a", "b", "c"]);
	assert.equal(ui.get("facet-chip").hidden, false);
	assert.match(ui.get("facet-text").textContent, /^facetChipName\|Jenna Dowd\|3$/);
	assert.equal(ui.applyLocalFacet(ui.state.records.find(r => r.key === "d")), false);
	ui.get("facet-clear").emit("click");
	assert.equal(ui.state.visible.length, 6);
	assert.equal(ui.get("facet-chip").hidden, true);
	ui.setFacet({ key: jenna[0].key, name: "Jenna Dowd", byId: false });
	ui.clearFilter();
	assert.equal(ui.state.visible.length, 6, "clearing the filter lets go of the facet too");
	ui.setFacet({ key: jenna[0].key, name: "Jenna Dowd", byId: false });
	await ui.runSearch();
	assert.equal(ui.state.facet, null, "a new search starts without it");
});

test("selection counts what is on screen and what a filter hides, and the library filter keeps the checks", async () => {
	const ui = await loaded();
	for (const key of ["a", "b", "d"]) ui.state.selected.add(key);
	ui.setFacet({ key: "name:jenna dowd", name: "Jenna Dowd", byId: false });
	assert.equal(ui.get("selected-count").textContent, "selectedSplit|3|2|1");
	assert.equal(ui.get("selected-only").hidden, false);
	assert.equal(ui.get("import-btn").querySelector("span")?.textContent ?? "importBtnN|3", "importBtnN|3");
	assert.deepEqual(Array.from(ui.state.selected).sort(), ["a", "b", "d"], "the selection outside the filter is not dropped");
	ui.get("facet-clear").emit("click");
	ui.get("selected-only").emit("click");
	assert.deepEqual(Array.from(ui.state.visible, r => r.key).sort(), ["a", "b", "d"]);
	ui.get("selected-only").emit("click");
	assert.equal(ui.state.visible.length, 6);
	assert.equal(ui.get("selected-count").textContent, "selected|3");
	ui.get("chk-all").checked = false; ui.get("chk-all").emit("change", { target: ui.get("chk-all") });
	assert.equal(ui.state.selected.size, 0, "the header checkbox is the one select-all");
});

test("an import keeps its failures selected, retries only them, and tells a lost PDF from a lost paper", async () => {
	const calls = [];
	const importer = { getReadingStates: async () => new Map(), getLibraryDOIMap: async () => new Map(), forgetTitleIndex() {},
		importRecord: async r => { calls.push(r.key); return r.key === "b" ? { status: "failed", error: "nope" }
			: r.key === "c" ? { status: "added", item: { id: 3 }, pdf: "no pdf", how: "translator" }
			: r.key === "d" ? { status: "exists", item: { id: 4 }, pdf: "skipped" } : { status: "added", item: { id: 1 }, pdf: "pdf:oa", how: "translator" }; } };
	const ui = await loaded({ importer });
	for (const key of ["a", "b", "c", "d"]) ui.state.selected.add(key);
	await ui.importRecords(ui.state.records.filter(r => ui.state.selected.has(r.key)));
	assert.deepEqual(calls, ["a", "b", "c", "d"]);
	assert.deepEqual(Array.from(ui.state.selected), ["b"], "only the failure stays selected");
	assert.equal(ui.get("banner").hidden, false);
	assert.match(ui.get("banner-text").textContent, /^importFailuresPdf\|1\|1$/, "one paper failed, one was saved without its PDF");
	assert.equal(ui.get("banner-action").textContent, "importRetry|1");
	const savedNoPdf = ui.state.records.find(r => r.key === "c");
	assert.equal(savedNoPdf.statusClass, "warn"); assert.equal(savedNoPdf.statusTitle, "tipPdfMissed");
	assert.equal(ui.state.records.find(r => r.key === "b").statusClass, "err");
	calls.length = 0;
	ui.get("banner-action").emit("click");
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(calls, ["b"], "the retry carries the failed key alone");
});

test("the institution cell: unknown is muted and only where the source normally has labs; the corresponding author's lab wins; other countries go in the tooltip", async () => {
	const person = (name, over) => ({ name, position: "middle", corresponding: false, institution: "", institutionId: null, country: null, institutionH: null, ...over });
	const ui = uiHarness({ realRows: true, search: async () => [
		paper("both", { people: [person("A", { position: "first", institution: "Hanbit University", country: "KR", institutionH: 500 }), person("B", { position: "last", corresponding: true, institution: "Kestrel Institute", country: "GB", institutionH: 1500 })] }),
		paper("unk", { source: "openalex", people: [person("A", { position: "first", institution: "Hanbit University", country: "KR" }), person("B", { position: "last", corresponding: true })] }),
		paper("oa", { source: "openalex" }),
		paper("plain", { source: "crossref" })
	] });
	await ui.runSearch();
	const cell = key => ui.get("results-body").children.find(r => r.dataset.key === key).children.find(c => c.dataset.k === "affiliation");
	assert.equal(cell("both").querySelector("span.aff-name").textContent, "Kestrel Inst.");
	assert.equal(cell("both").querySelector("span.tier").textContent, "T2");
	assert.match(ui.tipContent(cell("both"), "aff").textContent, /tipCountries/, "the first author's other country is named in the hover card, as a row of its own");
	assert.equal(cell("unk").querySelector("span.aff-name").textContent, "affUnknown");
	assert.match(cell("unk").querySelector("span.aff-name").className, /aff-unknown/);
	assert.equal(cell("oa").querySelector("span.aff-name").className.includes("aff-unknown"), true);
	assert.equal(cell("plain").children.length, 0, "a source without institutions gets an empty cell");
	assert.equal(ui.tipContent(cell("plain"), "aff"), null);
});

test("ORCID name search lists ranked profile cards, picking one lists all its papers, and the session remembers both", async () => {
	const A = "0000-0001-1111-1118", B = "0000-0002-2222-2224", C = "0000-0003-3333-3330", files = new Map(), prefs = {}, requests = [], opened = [];
	const row = (id, given, family) => ({ "orcid-id": id, "given-names": given, "family-names": family, "institution-name": ["Example University"], "other-name": [], "credit-name": null });
	const alexAuthor = (id, works) => ({ id: "https://openalex.org/A" + works, orcid: "https://orcid.org/" + id, works_count: works, cited_by_count: works * 10, summary_stats: { h_index: 7 },
		last_known_institutions: [{ display_name: "Elsewhere Institute", country_code: "KR" }], topics: [{ display_name: "Gene editing" }] });
	const alexWork = n => ({ id: "https://openalex.org/W" + n, doi: "https://doi.org/10.5555/o" + n, title: "Paper " + n, publication_year: 2019 + n, publication_date: (2019 + n) + "-01-01", type: "article",
		cited_by_count: n, counts_by_year: [], authorships: [{ author: { display_name: "Jennifer Doudna", orcid: "https://orcid.org/0000-0001-1111-1118" } }], primary_location: { source: { display_name: "Journal X" } }, biblio: {} });
	const request = async (_method, url) => {
		requests.push(url);
		if (url.startsWith("https://pub.orcid.org/v3.0/expanded-search/")) return { status: 200, response: { "num-found": 3, "expanded-result": [row(C, "Jenny", "Doudna"), row(A, "Jennifer", "Doudna"), row(B, "Jennifer A.", "Doudna")] } };
		if (url.startsWith("https://api.openalex.org/authors?")) return { status: 200, response: { results: [alexAuthor(A, 120), alexAuthor(B, 0)] } };
		if (url.startsWith("https://api.openalex.org/works?")) return { status: 200, response: { meta: { count: 3 }, results: [alexWork(1), alexWork(2), alexWork(3)] } };
		throw Object.assign(new Error("Unexpected HTTP request"), { status: 404 });
	};
	const ui = uiHarness({ realRows: true, prefs, historyFiles: files, request, launchURL: url => opened.push(url) });
	await ui.switchSearchMode("authors"); await ui.switchAuthorProvider("orcid");
	ui.get("author-input").value = "Jennifer Doudna"; ui.authorInputChanged();
	await ui.runAuthorAction("profiles");
	const cards = () => ui.get("author-profiles").children.filter(child => child.className.includes("author-profile"));
	assert.equal(requests.length, 2, "one ORCID search and one batched OpenAlex request");
	assert.equal(cards().length, 1, "the profile with no papers waits behind the more button");
	assert.match(cards()[0].textContent, /Jennifer Doudna/); assert.match(cards()[0].textContent, /authorStatWorks\|120/); assert.match(cards()[0].textContent, /authorStatH\|7/);
	assert.match(cards()[0].textContent, /Example University/); assert.match(cards()[0].textContent, /Gene editing/); assert.match(ui.get("author-profiles").textContent, /authorMoreProfiles\|2/);
	assert.equal(ui.get("status").textContent, "authorProfilesFound|3");
	const entries = await ui.history.list(); assert.equal(entries[0].kind, "profiles"); assert.equal(entries[0].query.authorInput, "Jennifer Doudna");
	// the LinkedIn button asks ORCID once for a listed profile (this stub has none) and then opens a name-and-institution search; LinkedIn itself is never fetched
	ui.get("author-profiles").querySelector("button.author-linkedin").emit("click");
	await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
	assert.equal(requests.filter(url => url === `https://pub.orcid.org/v3.0/${A}/researcher-urls`).length, 1); assert.ok(requests.every(url => !/linkedin/i.test(url)));
	assert.equal(opened.length, 1); assert.match(opened[0], /^https:\/\/www\.linkedin\.com\/search\/results\/people\/\?keywords=Jennifer%20Doudna%20Example%20University$/);
	// picking the card lists the papers at once
	ui.get("author-profiles").querySelector("button.author-load").emit("click");
	await new Promise(resolve => setImmediate(resolve)); await ui.state.searchDone;
	assert.equal(ui.state.records.length, 3); assert.equal(ui.state.sortKey, "year"); assert.equal(ui.state.sortDir, "desc");
	assert.equal(ui.get("status").textContent, `authorOrcidWorks|Jennifer Doudna|${A}|3|false`);
	assert.match(ui.get("banner-text").textContent, /authorOrcidViaOpenAlex/);
	assert.ok(requests.some(url => url.startsWith("https://api.openalex.org/works?filter=authorships.author.orcid:" + A)));
	// session and recent searches
	assert.equal(ui.authorSessions.orcid.profile.id, A); assert.equal(ui.authorSessions.orcid.input, "Jennifer Doudna"); assert.equal(ui.authorSessions.orcid.profiles.length, 3);
	const saved = JSON.parse(prefs.lastAuthorQuery || prefs["extensions.zotpop.lastAuthorQuery"] || "{}");
	assert.equal(saved.sessions.orcid.input, "Jennifer Doudna"); assert.equal(saved.sessions.orcid.profile.id, A);
	const fresh = uiHarness({ prefs, historyFiles: files, request: () => assert.fail("restoring must not use the network") }); fresh.restoreAuthorPreferences();
	assert.equal(fresh.get("author-provider").value, "orcid"); assert.equal(fresh.get("author-input").value, "Jennifer Doudna"); assert.equal(fresh.authorSessions.orcid.profile.id, A);
	const list = await ui.history.list(); const works = list.find(entry => entry.query.authorAction === "publications");
	assert.equal(works.query.authorProfileId, A); assert.equal(works.query.authorProfiles.length, 3);
});

test("the ORCID LinkedIn button opens the profile ORCID lists, falling back to a search when it lists none", async () => {
	const A = "0000-0001-1111-1118", opened = [], urls = []; let listed = "https://www.linkedin.com/in/jane-doe";
	const ui = uiHarness({ launchURL: url => opened.push(url), request: async (_method, url) => {
		urls.push(url);
		if (url.endsWith("/researcher-urls")) return { status: 200, response: { path: `/${A}/researcher-urls`, "researcher-url": listed ? [{ "url-name": "LI", url: { value: listed } }] : [] } };
		throw Object.assign(new Error("no"), { status: 404 });
	} });
	await ui.switchSearchMode("authors"); await ui.switchAuthorProvider("orcid");
	ui.authorSessions.orcid.profiles = [{ provider: "orcid", id: A, name: "Jane Doe", affiliation: "Example University", institutions: ["Example University"], identityConfirmed: true, mode: "profile", url: "https://orcid.org/" + A }];
	ui.renderAuthorProfiles();
	const button = () => ui.get("author-profiles").querySelector("button.author-linkedin");
	assert.equal(button().getAttribute("data-tip"), "authorLinkedInMaybeTip");
	button().emit("click"); for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(opened, ["https://www.linkedin.com/in/jane-doe"]); assert.equal(button().getAttribute("data-tip"), "authorLinkedInProfileTip");
	button().emit("click"); for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
	assert.equal(urls.length, 1, "asked once per person"); assert.equal(opened.length, 2);
	const other = uiHarness({ launchURL: url => opened.push(url), request: async () => ({ status: 200, response: { path: `/${A}/researcher-urls`, "researcher-url": [] } }) });
	await other.switchSearchMode("authors"); await other.switchAuthorProvider("orcid");
	other.authorSessions.orcid.profiles = [{ provider: "orcid", id: A, name: "Jane Doe", institutions: ["Example University"], identityConfirmed: true, mode: "profile" }]; other.renderAuthorProfiles();
	opened.length = 0; other.get("author-profiles").querySelector("button.author-linkedin").emit("click"); for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(opened, ["https://www.linkedin.com/search/results/people/?keywords=Jane%20Doe%20Example%20University"]);
	assert.equal(other.get("author-profiles").querySelector("button.author-linkedin").getAttribute("data-tip"), "authorLinkedInSearchTip");
	// Scholar cards get the search button too
	await other.switchAuthorProvider("scholar");
	other.authorSessions.scholar.profiles = [{ provider: "scholar", id: "dsdG3ewAAAAJ", name: "Curtis Bonk", affiliation: "Indiana University", mode: "profile", identityConfirmed: true }]; other.renderAuthorProfiles();
	assert.equal(other.get("author-profiles").querySelector("button.author-linkedin").getAttribute("data-tip"), "authorLinkedInSearchTip");
});

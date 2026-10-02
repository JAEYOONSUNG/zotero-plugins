import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Cite from "../content/cite.js";
import Sources from "../content/sources.js";
import History from "../content/history.js";

const at = (y, m = 9, d = 2) => new Date(y, m, d);
const years = list => list.map(([year, n]) => ({ year, n }));

test("OpenAlex counts_by_year is parsed to ascending { year, n }; junk is dropped, nothing is null", () => {
	assert.deepEqual(Sources.parseCountsByYear([{ year: 2025, cited_by_count: 51 }, { year: 2024, cited_by_count: 48 }, { year: "x", cited_by_count: 3 }, { year: 2023 }, null, { year: 2026, cited_by_count: -1 }]), years([[2024, 48], [2025, 51]]));
	assert.equal(Sources.parseCountsByYear([]), null);
	assert.equal(Sources.parseCountsByYear(undefined), null);
	assert.equal(Sources.parseCountsByYear("2025"), null);
});

test("the OpenAlex search and the DOI enrichment ask for counts_by_year and keep it on the record", async () => {
	const source = fs.readFileSync(new URL("../content/sources.js", import.meta.url), "utf8");
	assert.equal([...source.matchAll(/select=[^"]*counts_by_year/g)].length, 3, "the search, the DOI enrichment and the one-paper refresh");
	const urls = [];
	const http = { async getJSON(url) {
		urls.push(url);
		if (/\/works\?filter=doi:/.test(url)) return { results: [{ doi: "https://doi.org/10.5555/x", cited_by_count: 7, counts_by_year: [{ year: 2025, cited_by_count: 5 }, { year: 2026, cited_by_count: 2 }] }] };
		throw new Error("unexpected " + url);
	} };
	const records = [Sources.makeRecord({ source: "crossref", sourceId: "10.5555/x", doi: "10.5555/x", title: "T", year: 2024 })];
	await Sources.enrichFromOpenAlex(records, http, {});
	assert.deepEqual(records[0].citesByYear, years([[2025, 5], [2026, 2]]));
	assert.equal(records[0].citations, 7);
	// a merge keeps the yearly counts from whichever copy has them
	const merged = Sources.mergeRecords([[Sources.makeRecord({ source: "crossref", doi: "10.5555/y", title: "Merge me", year: 2024, citations: 3 })],
		[Sources.makeRecord({ source: "openalex", sourceId: "W1", doi: "10.5555/y", title: "Merge me", year: 2024, citations: 9, citesByYear: years([[2025, 9]]) })]]);
	assert.deepEqual(merged[0].citesByYear, years([[2025, 9]]));
});

test("trend: last full year against the one before, the year so far, the peak, the average, only the last ten years", () => {
	const t = Cite.trend({ byYear: years([[2018, 12], [2019, 58], [2020, 96], [2021, 121], [2022, 104], [2023, 88], [2024, 74], [2025, 51], [2026, 34]]), year: 2018, citations: 638 }, at(2026));
	assert.deepEqual(t.years.map(y => y.year), [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
	assert.equal(t.years.at(-1).partial, true);
	assert.deepEqual(t.current, { year: 2026, n: 34 });
	assert.deepEqual(t.last, { year: 2025, n: 51 });
	assert.deepEqual(t.prev, { year: 2024, n: 74 });
	assert.equal(t.yoy, -31);
	assert.equal(t.direction, "down");
	assert.deepEqual(t.peak, { year: 2021, n: 121, partial: false });
	assert.equal(t.perYear, 638 / 8);
	const up = Cite.trend({ byYear: years([[2024, 48], [2025, 51], [2026, 10]]), year: 2024, citations: 109 }, at(2026));
	assert.equal(up.yoy, 6); assert.equal(up.direction, "up");
	assert.deepEqual(up.years.map(y => y.year), [2024, 2025, 2026]);
	// a long-lived paper: only the ten years ending this year
	const old = Cite.trend({ byYear: years([[2005, 3], [2016, 4], [2017, 9], [2026, 1]]), year: 2005, citations: 17 }, at(2026));
	assert.deepEqual(old.years.map(y => y.year), [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
	assert.equal(old.years.find(y => y.year === 2020).n, 0, "a year OpenAlex leaves out is zero");
});

test("trend: a paper too young to have a year before, a flat or empty year, a zero base, no data", () => {
	const young = Cite.trend({ byYear: years([[2025, 40], [2026, 12]]), year: 2025, citations: 52 }, at(2026));
	assert.equal(young.prev, null); assert.equal(young.yoy, null); assert.equal(young.direction, null);
	assert.deepEqual(young.last, { year: 2025, n: 40 });
	const flat = Cite.trend({ byYear: years([[2024, 10], [2025, 10]]), year: 2024, citations: 20 }, at(2026));
	assert.equal(flat.direction, "flat"); assert.equal(flat.yoy, 0);
	const zeroBase = Cite.trend({ byYear: years([[2023, 5], [2025, 8]]), year: 2023, citations: 13 }, at(2026));
	assert.equal(zeroBase.prev.n, 0); assert.equal(zeroBase.yoy, null, "no percentage from nothing"); assert.equal(zeroBase.direction, "up");
	const justStarted = Cite.trend({ byYear: years([[2025, 4]]), year: 2020, citations: 4 }, at(2026, 0, 3));
	assert.equal(justStarted.current.n, 0, "the new year has no count yet"); assert.equal(justStarted.current.year, 2026);
	assert.equal(Cite.trend({ byYear: null, year: 2020, citations: 4 }, at(2026)), null);
	assert.equal(Cite.trend({ byYear: [], year: 2020 }, at(2026)), null);
	assert.equal(Cite.trend({ byYear: years([[2030, 4]]), year: 2020 }, at(2026)), null, "a year ahead of today is ignored");
	const unknownYear = Cite.trend({ byYear: years([[2025, 4], [2026, 1]]), citations: 5 }, at(2026));
	assert.equal(unknownYear.perYear, null);
});

test("sumByYear adds up the papers that have yearly counts and says how many", () => {
	const s = Cite.sumByYear([{ citesByYear: years([[2025, 10], [2026, 4]]) }, { citesByYear: years([[2024, 3], [2025, 5]]) }, { citesByYear: null }, {}], at(2026));
	assert.equal(s.papers, 2); assert.equal(s.of, 4);
	assert.equal(s.years.length, 10);
	assert.deepEqual(s.years.slice(-3).map(y => y.n), [3, 15, 4]);
	assert.equal(s.yoy, 400);
	assert.equal(Cite.sumByYear([{}, { citesByYear: null }], at(2026)), null);
	assert.equal(Cite.sumByYear([], at(2026)), null);
});

function snaps(over = {}) {
	const files = new Map(), clock = { t: Date.UTC(2026, 9, 1, 8) };
	const make = () => Cite.createSnapshots({ io: History.memoryIO(files), path: "citations.json", now: () => clock.t, ...over });
	return { files, clock, make };
}
test("snapshots: the look before is kept, a look within hours only refreshes the count, the delta says what was added", async () => {
	const { clock, make } = snaps(), s = make();
	await s.load();
	s.observe("d:10.5555/x", 100);
	assert.equal(s.delta("d:10.5555/x"), null, "the first look has nothing to compare with");
	clock.t += 2 * 3600 * 1000;
	s.observe("d:10.5555/x", 101);
	assert.equal(s.delta("d:10.5555/x"), null, "two hours later is still the same look");
	clock.t += 24 * 3600 * 1000;
	const day1 = clock.t;
	s.observe("d:10.5555/x", 110);
	let d = s.delta("d:10.5555/x");
	assert.equal(d.change, 9); assert.equal(d.before, 101); assert.equal(d.count, 110);
	assert.equal(d.to, day1);
	clock.t += 3600 * 1000;
	s.observe("d:10.5555/x", 112);
	assert.equal(s.delta("d:10.5555/x").change, 11, "the comparison is still against the look before the day");
	assert.equal(s.observe("", 5), null); assert.equal(s.observe("k", NaN), null); assert.equal(s.observe("k", -1), null);
});

test("snapshots persist, reload and stay bounded (the longest-unseen go first)", async () => {
	const { files, clock, make } = snaps({ max: 3 }), s = make();
	await s.load();
	for (let i = 0; i < 6; i++) { s.observe("d:" + i, i * 10); clock.t += 1000; }
	assert.equal(s.size, 3);
	assert.deepEqual(s.keys().sort(), ["d:3", "d:4", "d:5"]);
	await s.flush();
	const saved = JSON.parse(files.get("citations.json"));
	assert.equal(saved.entries.length, 3);
	const again = make();
	await again.load();
	assert.equal(again.get("d:5").c, 50);
	// a damaged file starts over; bad rows are skipped
	files.set("citations.json", "{not json");
	const broken = make(); await broken.load(); assert.equal(broken.size, 0);
	files.set("citations.json", JSON.stringify({ version: 1, entries: [["d:ok", 5, 10, null, null], ["d:bad", "x", 1], [7, 1, 1], ["d:neg", -1, 1]] }));
	const partial = make(); await partial.load(); assert.deepEqual(partial.keys(), ["d:ok"]);
	// nothing written when nothing changed
	files.delete("citations.json");
	const quiet = make(); await quiet.flush(); assert.equal(files.has("citations.json"), false);
	// the cap holds on load too
	files.set("citations.json", JSON.stringify({ version: 1, entries: Array.from({ length: 10 }, (_, i) => ["d:" + i, i, i, null, null]) }));
	const capped = make(); await capped.load(); assert.equal(capped.size, 3);
});

function fakeHttp(answer) {
	const calls = [];
	return { calls, async getJSON(url) { calls.push(url); if (answer instanceof Error) throw answer; return typeof answer === "function" ? answer(url) : answer; } };
}
const work = { id: "https://openalex.org/W9", cited_by_count: 645, counts_by_year: [{ year: 2026, cited_by_count: 41 }, { year: 2025, cited_by_count: 51 }] };

test("refresh: one request by DOI with the key, remembered for six hours, an id or PMID when there is no DOI", async () => {
	Sources.clearWorkCache();
	const http = fakeHttp(work), ctx = { openAlexApiKey: "k1" };
	const rec = { doi: "10.5555/Refresh", source: "crossref" };
	let a = await Sources.refreshOpenAlexWork(rec, http, ctx, 1000);
	assert.equal(a.ok, true); assert.equal(a.cached, false); assert.equal(a.citations, 645);
	assert.deepEqual(a.citesByYear, years([[2025, 51], [2026, 41]]));
	assert.equal(http.calls.length, 1);
	assert.match(http.calls[0], /^https:\/\/api\.openalex\.org\/works\/doi:10\.5555%2Frefresh\?select=id,cited_by_count,counts_by_year&api_key=k1$/);
	let b = await Sources.refreshOpenAlexWork(rec, http, ctx, 1000 + 5 * 3600 * 1000);
	assert.equal(b.cached, true); assert.equal(http.calls.length, 1, "five hours later is still remembered");
	let c = await Sources.refreshOpenAlexWork(rec, http, ctx, 1000 + 6 * 3600 * 1000 + 1);
	assert.equal(c.cached, false); assert.equal(http.calls.length, 2, "after six hours it asks again");
	await Sources.refreshOpenAlexWork({ source: "openalex", sourceId: "W77" }, http, ctx, 1);
	assert.match(http.calls.at(-1), /works\/W77\?/);
	await Sources.refreshOpenAlexWork({ pmid: "123456", source: "pubmed" }, http, ctx, 1);
	assert.match(http.calls.at(-1), /works\/pmid:123456\?/);
	const none = await Sources.refreshOpenAlexWork({ source: "arxiv", arxiv: "2401.00001" }, http, ctx, 1);
	assert.deepEqual(none, { ok: false, reason: "id" });
	assert.equal(http.calls.length, 4);
});

test("refresh respects the metered budget: nothing is asked once spent, and a refusal marks it spent", async () => {
	Sources.clearWorkCache();
	const spent = fakeHttp(work);
	assert.deepEqual(await Sources.refreshOpenAlexWork({ doi: "10.5555/a" }, spent, { openAlexSpent: true }), { ok: false, reason: "budget" });
	assert.equal(spent.calls.length, 0);
	const err = Object.assign(new Error("HTTP 429 · api.openalex.org"), { status: 429, body: "Insufficient budget" });
	const refused = fakeHttp(err), ctx = {};
	const r = await Sources.refreshOpenAlexWork({ doi: "10.5555/b" }, refused, ctx);
	assert.equal(r.ok, false); assert.equal(r.reason, "budget"); assert.equal(ctx.openAlexSpent, true);
	assert.equal(refused.calls.length, 1, "a budget refusal is not retried");
	const down = fakeHttp(Object.assign(new Error("HTTP 500 · api.openalex.org"), { status: 500 }));
	const f = await Sources.refreshOpenAlexWork({ doi: "10.5555/c" }, down, { }, 0);
	assert.equal(f.reason, "failed"); assert.match(f.message, /500/);
	const empty = await Sources.refreshOpenAlexWork({ doi: "10.5555/d" }, fakeHttp({ id: "W1" }), {});
	assert.equal(empty.reason, "failed");
});

test("the window loads cite.js and translate.js before ui.js, and a button is reset against Zotero's chrome", () => {
	const markup = fs.readFileSync(new URL("../content/search.xhtml", import.meta.url), "utf8");
	const css = fs.readFileSync(new URL("../content/search.css", import.meta.url), "utf8");
	for (const f of ["cite", "translate"]) assert.ok(markup.indexOf(`content/${f}.js`) > 0 && markup.indexOf(`content/${f}.js`) < markup.indexOf("content/ui.js"), f);
	const rule = css.match(/\nbutton \{([^}]*)\}/)[1];
	assert.match(rule, /margin: 0;/); assert.match(rule, /max-height: none;/); assert.match(rule, /appearance: none;/);
	for (const id of ["d-cite", "metrics-trend", "d-tr-run", "d-tr-lang", "d-tr-title", "d-tr-orig", "d-tr-out", "d-tr-text", "d-tr-copy"]) assert.ok(markup.includes(`id="${id}"`), id);
});

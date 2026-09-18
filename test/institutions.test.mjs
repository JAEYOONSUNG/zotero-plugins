// Offline: who did the work, where, and what that lab's standing is -- through the
// adapters, the merge and the OpenAlex institution lookup, with the network mocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

// Each test gets its own module so the caches in one cannot answer for another.
function freshSources() {
	const module = { exports: {} };
	vm.runInNewContext(readFileSync(new URL("../content/sources.js", import.meta.url), "utf8"), {
		module, require: createRequire(new URL("../content/sources.js", import.meta.url)),
		setTimeout: fn => setTimeout(fn, 0), clearTimeout, setInterval, clearInterval
	});
	return module.exports;
}

const authorship = (name, position, extra = {}) => ({
	author: { display_name: name }, author_position: position, is_corresponding: Boolean(extra.corresponding),
	institutions: extra.inst ? [{ id: "https://openalex.org/" + extra.inst, display_name: extra.instName || extra.inst, country_code: extra.country || null }] : [],
	countries: extra.country ? [extra.country] : []
});
const openAlexWork = (n, authorships) => ({ id: `https://openalex.org/W${n}`, doi: `10.1234/w${n}`, title: `Paper ${n}`, publication_year: 2024, authorships,
	primary_location: { source: { id: "https://openalex.org/S1", display_name: "Journal One", issn_l: "1111-1111" } } });

test("OpenAlex authorships become people with lab, country and role; institutions are looked up once each", async () => {
	const S = freshSources();
	const urls = [];
	const http = { async getJSON(url) {
		const u = new URL(url); urls.push(u);
		if (u.pathname === "/works") return { meta: { count: 2 }, results: [
			openAlexWork(1, [authorship("Sheila Ingemann Jensen", "first", { inst: "I10", instName: "DTU", country: "DK" }),
				authorship("M Middle", "middle"), authorship("P I Boss", "last", { corresponding: true, inst: "I20", instName: "MIT", country: "US" })]),
			openAlexWork(2, [authorship("Solo Author", "first", { inst: "I10", instName: "DTU", country: "DK" })])
		] };
		if (u.pathname === "/sources") return { results: [{ id: "https://openalex.org/S1", display_name: "Journal One", issn: ["1111-1111"], summary_stats: { "2yr_mean_citedness": 4.5, h_index: 120 } }] };
		if (u.pathname === "/institutions") {
			assert.equal(u.searchParams.get("filter"), "ids.openalex:I10|I20");
			return { results: [{ id: "https://openalex.org/I10", display_name: "Technical University of Denmark", country_code: "DK", summary_stats: { h_index: 640 } },
				{ id: "https://openalex.org/I20", display_name: "MIT", country_code: "US", summary_stats: { h_index: 1800 } }] };
		}
		throw new Error("unexpected " + url);
	} };
	const records = await S.search("openalex", { keywords: "ingemann", maxResults: 10 }, http, { enrichCitations: false, jcr: false });
	assert.equal(records.length, 2);
	const [a, b] = records;
	assert.equal(a.people.length, 3);
	assert.deepEqual({ ...a.people[0] }, { name: "Sheila Ingemann Jensen", position: "first", corresponding: false, institution: "DTU", institutionId: "I10", country: "DK", institutionH: 640 });
	assert.equal(a.people[2].corresponding, true);
	assert.equal(a.people[2].institutionH, 1800);
	assert.equal(a.people[1].institutionH, null, "middle authors are not looked up");
	assert.equal(b.people[0].institutionH, 640, "the second paper's lab came from the same single request");
	assert.equal(urls.filter(u => u.pathname === "/institutions").length, 1);
	assert.equal(a.journalIF, 4.5, "journal metrics still arrive alongside");

	// A second search over the same labs asks nothing more of OpenAlex.
	const before = urls.length;
	await S.enrichInstitutions(records.map(r => ({ ...r, people: r.people.map(p => ({ ...p, institutionH: null })) })), http, {});
	assert.equal(urls.length, before);
});

test("labs OpenAlex does not answer for are remembered as unknown, and a failed lookup keeps the records", async () => {
	const S = freshSources();
	let calls = 0;
	const people = [{ name: "A", position: "first", corresponding: false, institution: "Ghost Lab", institutionId: "I404", country: null, institutionH: null }];
	const records = [{ title: "x", people }];
	await S.enrichInstitutions(records, { async getJSON() { calls++; return { results: [] }; } }, {});
	await S.enrichInstitutions(records, { async getJSON() { calls++; return { results: [] }; } }, {});
	assert.equal(calls, 1, "an unanswered lab is not asked about again");
	assert.equal(records[0].people[0].institutionH, null);
	const failing = [{ title: "y", people: [{ ...people[0], institutionId: "I500" }] }];
	const logs = [];
	await S.enrichInstitutions(failing, { async getJSON() { const e = new Error("HTTP 500"); e.status = 500; throw e; } }, { log: m => logs.push(m) });
	assert.equal(failing[0].people[0].institution, "Ghost Lab");
	assert.ok(logs.some(m => /Institution lookup failed/.test(m)));
});

test("Crossref and Europe PMC affiliation strings are kept, but never outrank OpenAlex's placed people", () => {
	const S = freshSources();
	const placed = [{ name: "A", position: "first", corresponding: false, institution: "DTU", institutionId: "I10", country: "DK", institutionH: null }];
	const strings = [{ name: "A", position: "first", corresponding: false, institution: "Dept of Something, DTU, Lyngby", institutionId: null, country: null, institutionH: null },
		{ name: "B", position: "last", corresponding: false, institution: "", institutionId: null, country: null, institutionH: null }];
	const base = { title: "Same paper", doi: "10.1234/x", authors: [] };
	let [merged] = S.mergeRecords([[{ ...base, source: "crossref", people: strings }], [{ ...base, source: "openalex", people: placed }]]);
	assert.equal(merged.people[0].institutionId, "I10", "the placed list wins whichever order the sources arrive in");
	[merged] = S.mergeRecords([[{ ...base, source: "openalex", people: placed }], [{ ...base, source: "crossref", people: strings }]]);
	assert.equal(merged.people[0].institutionId, "I10");
	[merged] = S.mergeRecords([[{ ...base, source: "openalex", people: null }], [{ ...base, source: "crossref", people: strings }]]);
	assert.equal(merged.people[0].institution, "Dept of Something, DTU, Lyngby", "a string is better than nothing");
});

test("a journal known only by name is looked up by that name, matched exactly, and preprint servers are left alone", async () => {
	const S = freshSources();
	const urls = [];
	const http = { async getJSON(url) {
		const u = new URL(url); urls.push(u);
		assert.equal(u.pathname, "/sources");
		if (u.searchParams.get("search") === "Nature") return { results: [
			{ id: "https://openalex.org/S2", display_name: "Nature Communications", issn: ["2041-1723"], summary_stats: { "2yr_mean_citedness": 15, h_index: 500 } },
			{ id: "https://openalex.org/S1", display_name: "Nature", issn: ["0028-0836"], summary_stats: { "2yr_mean_citedness": 50, h_index: 1600 } }] };
		return { results: [{ id: "https://openalex.org/S9", display_name: "Something Else", issn: [], summary_stats: { "2yr_mean_citedness": 1, h_index: 5 } }] };
	} };
	const records = [
		{ title: "a", venue: "Nature", journalId: null, issn: null, journalIF: null, journalH: null, itemType: "journalArticle" },
		{ title: "b", venue: "nature", journalId: null, issn: null, journalIF: null, journalH: null, itemType: "journalArticle" },
		{ title: "c", venue: "Obscure Bulletin", journalId: null, issn: null, journalIF: null, journalH: null, itemType: "journalArticle" },
		{ title: "d", venue: "arXiv", journalId: null, issn: null, journalIF: null, journalH: null, itemType: "preprint", preprintServer: "arXiv" }
	];
	await S.enrichJournalMetrics(records, http, { jcr: false });
	assert.equal(records[0].journalIF, 50, "the exact name, not the first search hit");
	assert.equal(records[0].journalId, "S1");
	assert.equal(records[1].journalIF, 50, "case does not make a second journal");
	assert.equal(records[2].journalIF, null, "no exact match means no number");
	assert.equal(records[3].journalIF, null, "a preprint server has no IF");
	assert.equal(urls.length, 2);
	// Asked again, both answers -- including the miss -- come from memory.
	await S.enrichJournalMetrics(records.map(r => ({ ...r, journalIF: null, journalId: null })), http, { jcr: false });
	assert.equal(urls.length, 2);
});

test("the lookup caches round-trip through a snapshot so a new session pays nothing again", async () => {
	const S = freshSources();
	const http = { async getJSON(url) {
		const u = new URL(url);
		if (u.pathname === "/institutions") return { results: [{ id: "https://openalex.org/I1", display_name: "Lab", country_code: "KR", summary_stats: { h_index: 900 } }] };
		return { results: [{ id: "https://openalex.org/S1", display_name: "J", issn: ["1-1"], summary_stats: { "2yr_mean_citedness": 2, h_index: 10 } }] };
	} };
	const rec = { title: "x", journalId: "S1", issn: null, journalIF: null, journalH: null,
		people: [{ name: "A", position: "first", corresponding: false, institution: "", institutionId: "I1", country: null, institutionH: null }] };
	await S.enrichJournalMetrics([rec], http, { jcr: false });
	await S.enrichInstitutions([rec], http, {});
	const snapshot = JSON.parse(JSON.stringify(S.exportCaches()));
	assert.equal(snapshot.version, 1);
	assert.ok(snapshot.journals.some(([k]) => k === "S1") && snapshot.journals.some(([k]) => k === "issn:1-1"));
	assert.ok(snapshot.institutions.some(([k, v]) => k === "I1" && v.hIndex === 900));

	const T = freshSources();
	assert.equal(T.importCaches(snapshot) > 0, true);
	assert.equal(T.importCaches({ version: 2 }), 0);
	assert.equal(T.importCaches({ version: 1, journals: [["bad", "string"], [1, {}]] }), 0, "malformed lines are skipped");
	const again = { ...rec, journalIF: null, journalH: null, people: [{ ...rec.people[0], institutionH: null, institution: "" }] };
	await T.enrichJournalMetrics([again], { getJSON: () => assert.fail("must not fetch") }, { jcr: false });
	await T.enrichInstitutions([again], { getJSON: () => assert.fail("must not fetch") }, {});
	assert.equal(again.journalIF, 2);
	assert.equal(again.people[0].institutionH, 900);
	assert.equal(again.people[0].institution, "Lab", "a lab's name is filled from the cache when the source left it blank");
	assert.equal(again.people[0].country, "KR");
});

test("institution lookups can be switched off and are skipped on a cancelled search", async () => {
	const S = freshSources();
	let institutionCalls = 0;
	const http = { async getJSON(url) {
		const u = new URL(url);
		if (u.pathname === "/works") return { meta: { count: 1 }, results: [openAlexWork(1, [authorship("A", "first", { inst: "I1", country: "KR" })])] };
		if (u.pathname === "/institutions") { institutionCalls++; return { results: [] }; }
		return { results: [] };
	} };
	const records = await S.search("openalex", { keywords: "x", maxResults: 5 }, http, { enrichCitations: false, journalMetrics: false, institutionMetrics: false });
	assert.equal(records[0].people[0].country, "KR", "the country a source already knows needs no lookup");
	assert.equal(institutionCalls, 0);
});

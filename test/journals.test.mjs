import { test } from "node:test";
import assert from "node:assert/strict";
import J from "../content/journals.js";
import Marks from "../content/journal-marks.js";
import Sources from "../content/sources.js";
import History from "../content/history.js";

const registry = [
	{ title: "Nature Methods", issns: ["1548-7091", "1548-7105"], abbreviation: "Nat Methods", impactFactor: 36 },
	{ title: "Nature Reviews Methods Primers", issns: ["2662-8449"], impactFactor: 40 },
	{ title: "Proceedings of the National Academy of Sciences", issns: ["0027-8424"], impactFactor: 11 },
	{ title: "Proceedings of the National Academy of Sciences India Section B", issns: ["0369-8211"], impactFactor: 1 },
	{ title: "Nucleic Acids Research", issns: ["0305-1048"], impactFactor: 14 },
	{ title: "New Astronomy Reviews", issns: ["1387-6473"], impactFactor: 6 },
	{ title: "Journal of the American Chemical Society", issns: ["0002-7863"], impactFactor: 16 },
	{ title: "Journal of the American Ceramic Society", issns: ["0002-7820"], impactFactor: 4 },
	{ title: "Cell", issns: ["0092-8674"], impactFactor: 60 },
	{ title: "Cell Reports", issns: ["2211-1247"], impactFactor: 9 },
	{ title: "Molecular Cell", issns: ["1097-2765"], impactFactor: 14 },
	{ title: "The Lancet", issns: ["0140-6736"], impactFactor: 100 }
];
const catalog = J.build({ curated: Marks.ABBREVIATIONS, abbreviate: Marks.abbreviateByWords, registry });
const names = (q, limit) => J.suggest(catalog, q, { limit }).map(s => s.name);

test("a journal is found by its name, its abbreviation or its letters, whatever the case and punctuation", () => {
	for (const q of ["Nature Methods", "nature methods", "Nat Methods", "nat. methods", "NAT-METHODS", "nat methods"]) assert.equal(names(q)[0], "Nature Methods", q);
	for (const q of ["PNAS", "pnas", "P.N.A.S.", "Proc Natl Acad Sci", "proc. natl. acad. sci."]) assert.equal(names(q)[0], "Proceedings of the National Academy of Sciences", q);
	assert.equal(names("NAR")[0], "Nucleic Acids Research", "an acronym ranks the journal readers mean first: it is the better known");
	assert.equal(names("JACS")[0], "Journal of the American Chemical Society");
	assert.equal(names("Cell Rep")[0], "Cell Reports");
	assert.equal(names("the lancet")[0], "The Lancet", "a leading The is ignored on both sides");
	assert.equal(names("lancet")[0], "The Lancet");
	assert.deepEqual(names("n"), [], "one character names half the registry");
	assert.deepEqual(names("   "), []);
	assert.deepEqual(names("zzzqq"), []);
	assert.equal(names("nature").length > 0, true);
});

test("typing the first words of an ISO abbreviation finds the journal (\"proc natl acad\" for PNAS), before the abbreviation is finished", () => {
	// Review 2026-10-03: "proc natl acad" listed nothing after PNAS had been picked, and read as an abbreviation that is not understood.
	for (const q of ["proc natl", "proc natl acad", "Proc. Natl. Acad.", "proc nat acad"]) {
		assert.equal(names(q)[0], "Proceedings of the National Academy of Sciences", q);
	}
	assert.ok(names("PROC NATL ACAD SCI U S A")[0].startsWith("Proceedings of the National Academy of Sciences"), "the long ISO form is found too");
	// the registry's own abbreviation, with nothing curated, is found by its first words as well
	const bare = J.build({ registry: [{ title: "Journal of Obscure Results", abbreviation: "J Obscure Res" }, { title: "Journal of Other Things", abbreviation: "J Other Thing" }] });
	assert.deepEqual(J.suggest(bare, "j obs").map(x => x.name), ["Journal of Obscure Results"]);
	assert.equal(J.suggest(bare, "j obscure").length, 1);
	// every word may stop short: "proc natl acad sc" is still PNAS (tier 1, a prefix of the ISO abbreviation)
	assert.equal(J.suggest(catalog, "proc natl acad sc")[0].name, "Proceedings of the National Academy of Sciences");
});

test("ranking: exact abbreviation or acronym, then names that start with the typing, then the rest", () => {
	const ranked = J.suggest(catalog, "cell", { limit: 1000 });
	assert.equal(ranked[0].name, "Cell", "the exact name first");
	const order = ranked.map(s => s.name);
	assert.ok(order.indexOf("Cell Reports") < order.indexOf("Molecular Cell"), "a name that starts with the typing comes before one that merely contains it");
	assert.equal(ranked.find(s => s.name === "Cell Reports").tier, 1);
	assert.equal(ranked.find(s => s.name === "Molecular Cell").tier, 3);
	const tiers = ranked.map(s => s.tier);
	assert.deepEqual(tiers, [...tiers].sort((a, b) => a - b), "tiers never go back up");
	const nm = J.suggest(catalog, "nat meth");
	assert.equal(nm[0].name, "Nature Methods", "a start of the abbreviation");
	assert.equal(nm[0].tier, 1);
	assert.ok(J.suggest(catalog, "methods", { limit: 500 }).find(s => s.name === "Nature Methods").tier >= 3, "a word from the middle is a weaker match");
	assert.equal(J.suggest(catalog, "Proc Natl Acad Sci")[0].tier, 0, "the abbreviation spelled out");
	assert.equal(J.suggest(catalog, "pnas")[0].tier, 0);
	assert.equal(J.suggest(catalog, "nar").map(s => s.name).indexOf("New Astronomy Reviews") > 0, true, "an acronym shared with a lesser journal ranks it after");
	assert.equal(J.suggest(catalog, "nat", { limit: 3 }).length, 3, "the limit holds");
});

test("each suggestion carries what a chip needs: name, abbreviation, ISSNs", () => {
	const s = J.suggest(catalog, "nat methods")[0];
	assert.deepEqual({ name: s.name, abbrev: s.abbrev, issns: s.issns, source: s.source }, { name: "Nature Methods", abbrev: "Nat Methods", issns: ["1548-7091", "1548-7105"], source: "local" });
	assert.equal(J.suggest(catalog, "pnas")[0].abbrev, "PNAS");
	assert.equal(J.suggest(catalog, "nucleic acids research")[0].abbrev, "Nucleic Acids Res");
	// an unfamiliar journal is abbreviated word by word, words the list does not know kept whole
	assert.equal(J.suggest(catalog, "new astronomy reviews")[0].abbrev, "New Astron Rev");
});

test("OpenAlex's answers follow the local ones and never list a journal twice", () => {
	const local = J.suggest(catalog, "nature methods", { limit: 2 });
	const remote = ["Nature Methods", "NATURE-METHODS", "Methods in Ecology and Evolution"].map((n, i) => J.fromAutocomplete({ id: "https://openalex.org/S" + (100 + i), display_name: n, external_id: i === 2 ? "https://portal.issn.org/resource/ISSN/2041-210X" : "" }));
	assert.equal(remote[2].openalexId, "S102");
	assert.deepEqual(remote[2].issns, ["2041-210X"]);
	const merged = J.mergeSuggestions(local, remote, 8);
	assert.deepEqual(merged.map(s => s.name), [...local.map(s => s.name), "Methods in Ecology and Evolution"], "a name already listed, in any spelling, is skipped");
	assert.equal(merged.at(-1).source, "remote");
	assert.equal(J.mergeSuggestions(local, remote, 2).length, 2, "the limit holds");
	assert.equal(J.fromAutocomplete(null), null);
	// ISSN is as good as a name
	assert.deepEqual(J.mergeSuggestions([{ name: "A Journal", issns: ["2041-210X"] }], [{ name: "Other Spelling", issns: ["2041-210X"] }], 5).length, 1);
});

test("picked journals become query fields: the box as typed, one journal, or an OR of several", () => {
	assert.deepEqual(J.queryFields([], "  Nucleic Acids Res  "), { venue: "Nucleic Acids Res", venues: undefined }, "nothing picked: exactly as before");
	assert.deepEqual(J.queryFields([], 'Cell OR "Nature"'), { venue: 'Cell OR "Nature"', venues: undefined }, "an expression typed by hand stays one");
	assert.deepEqual(J.queryFields([{ name: "Cell", issns: ["0092-8674"] }], ""), { venue: "Cell", venues: [{ name: "Cell", issns: ["0092-8674"], openalexId: null }] });
	const two = J.queryFields([{ name: "Nature Methods", issns: ["1548-7091"] }, { name: "Cell", issns: [], openalexId: "S1" }], "");
	assert.equal(two.venue, '"Nature Methods" OR 1548-7091 OR "Cell"');
	assert.deepEqual(two.venues.map(v => v.name), ["Nature Methods", "Cell"]);
	const typed = J.queryFields([{ name: "Cell" }], "Science");
	assert.deepEqual(typed.venues.map(v => v.name), ["Cell", "Science"], "text still in the box counts as one more");
	assert.equal(J.queryFields([{ name: "Cell" }], "cell").venues.length, 1, "unless it is the one already picked");
	assert.deepEqual(J.venueNames({ venues: [{ name: "A" }, "B", { name: " A " }] }), ["A", "B"]);
	// the search layer builds the same expression from the list, so a saved query and a typed one match alike
	assert.equal(Sources.venueExpression(Sources.normalizeVenues(two.venues)), two.venue);
	assert.deepEqual(Sources.normalizeVenues([{ name: "Cell " }, "cell", { name: "" }, { name: "X", openalexId: "bad" }]).map(v => [v.name, v.openalexId]), [["Cell", null], ["X", null]]);
});

const http = log => ({
	async getJSON(url) {
		log.push(url);
		if (/api\.openalex\.org\/sources\?filter=issn/.test(url)) return { results: [{ id: "https://openalex.org/S11", issn: ["1548-7091", "1548-7105"] }, { id: "https://openalex.org/S22", issn: ["0092-8674"] }] };
		if (/api\.openalex\.org\/sources\?search=/.test(url)) return { results: [{ id: "https://openalex.org/S33", display_name: "Science" }] };
		if (/europepmc/.test(url)) return { hitCount: 0, resultList: { result: [] } };
		return { results: [], meta: { count: 0 } };
	},
	async getText() { return ""; }
});

test("OpenAlex takes several journals in one filter, resolved once and remembered", async () => {
	const log = [];
	const venues = [{ name: "Nature Methods", issns: ["1548-7091", "1548-7105"] }, { name: "Cell", issns: ["0092-8674"] }, { name: "Nature", openalexId: "S99" }, { name: "Science" }];
	await Sources.search("openalex", { keywords: "repair", venues, maxResults: 5 }, http(log), { journalMetrics: false, institutionMetrics: false, enrichCitations: false });
	const lookups = log.filter(u => /openalex\.org\/sources/.test(u));
	assert.equal(lookups.length, 2, "one request for every journal that has an ISSN, one search for the one that has only a name; the picked id costs none");
	assert.match(lookups[0], /filter=issn:1548-7091\|1548-7105\|0092-8674/);
	const works = log.find(u => /openalex\.org\/works/.test(u));
	assert.match(decodeURIComponent(works), /primary_location\.source\.id:S99\|S11\|S22\|S33|primary_location\.source\.id:[S\d|]+/);
	for (const id of ["S99", "S11", "S22", "S33"]) assert.ok(decodeURIComponent(works).includes(id), id);
	assert.equal(log.filter(u => /openalex\.org\/works/.test(u)).length, 1, "one query for all of them");
	// the same journals again: nothing to look up
	const again = [];
	await Sources.search("openalex", { keywords: "repair", venues, maxResults: 5 }, http(again), { journalMetrics: false, institutionMetrics: false, enrichCitations: false });
	assert.equal(again.filter(u => /openalex\.org\/sources/.test(u)).length, 0, "remembered");
	assert.equal(again.filter(u => /openalex\.org\/works/.test(u)).length, 1);
});

test("a source that takes one journal at a time is asked once per journal", async () => {
	const log = [];
	await Sources.search("europepmc", { keywords: "repair", venues: [{ name: "Cell" }, { name: "Nature Methods" }], maxResults: 5 }, http(log), { journalMetrics: false, institutionMetrics: false, enrichCitations: false });
	const asked = log.filter(u => /europepmc/.test(u)).map(u => decodeURIComponent(u));
	assert.equal(asked.length, 2);
	assert.ok(/JOURNAL:"Cell"/.test(asked[0]) && !/Nature Methods/.test(asked[0]));
	assert.ok(/JOURNAL:"Nature Methods"/.test(asked[1]));
});

test("what comes back is checked against any of the journals", () => {
	const q = { venue: Sources.venueExpression(Sources.normalizeVenues([{ name: "Nature Methods", issns: ["1548-7091"] }, { name: "Cell" }])) };
	const recs = [{ key: "a", title: "A", venue: "Nature Methods" }, { key: "b", title: "B", venue: "Cell" }, { key: "c", title: "C", venue: "Science" }, { key: "d", title: "D", venue: "Some Other", issn: "1548-7091" }];
	assert.deepEqual(Sources.filterRecords(recs, q).map(r => r.key), ["a", "b", "d"], "by name or by ISSN");
});

test("the history menu names picked journals, not the expression the search ran with", () => {
	const q = J.queryFields([{ name: "Nature Methods", issns: ["1548-7091"] }, { name: "Cell" }], "");
	assert.equal(History.describe({ keywords: "repair", ...q }), "repair · Nature Methods, Cell");
	assert.equal(History.describe({ keywords: "repair", venue: "Cell" }), "repair · Cell");
	// two searches over different journals are different searches
	assert.notEqual(History.signature?.("multi", { venue: q.venue }) ?? q.venue, History.signature?.("multi", { venue: "Cell" }) ?? "Cell");
});

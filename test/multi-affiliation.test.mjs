/* Every institution an author lists, not just the first: a researcher who holds a post at a university and at
   an institute is shown at both, the tier is the better of them (and says which), filters find the paper by any
   of them, the CSV lists them all after the columns a sheet already reads, and saved searches of the old shape
   read as the new one. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import A from "../content/affiliations.js";
import F from "../content/filters.js";
import History from "../content/history.js";
import I18N from "../content/i18n.js";
import { paper, uiHarness } from "./helpers/search-ui-harness.mjs";

function freshSources() {
	const module = { exports: {} };
	vm.runInNewContext(readFileSync(new URL("../content/sources.js", import.meta.url), "utf8"), {
		module, require: createRequire(new URL("../content/sources.js", import.meta.url)),
		setTimeout: fn => setTimeout(fn, 0), clearTimeout, setInterval, clearInterval
	});
	return module.exports;
}
const inst = (id, name, country, type = "education", ror = null) => ({ id: "https://openalex.org/" + id, display_name: name, country_code: country, type, ror });
const authorship = (name, position, institutions, extra = {}) => ({ author: { id: "https://openalex.org/" + name.replace(/\W/g, ""), display_name: name }, author_position: position,
	is_corresponding: Boolean(extra.corresponding), institutions, countries: [...new Set(institutions.map(i => i.country_code))] });
const csvCells = line => line.match(/"(?:[^"]|"")*"/g).map(c => c.slice(1, -1).replace(/""/g, '"'));

// Two posts for the first author (a university and a hospital, two countries), one for the corresponding author.
const MULTI = [
	{ name: "Ada First", position: "first", corresponding: false, institution: "Hanbit University", institutionId: "I1", country: "KR", institutionH: 640,
		institutions: [{ name: "Hanbit University", id: "I1", ror: "https://ror.org/01", country: "KR", type: "education", hIndex: 640 },
			{ name: "Eastbridge Hospital", id: "I2", ror: null, country: "US", type: "healthcare", hIndex: 2320 },
			{ name: "Kestrel Institute", id: "I3", ror: null, country: "GB", type: "facility", hIndex: null }] },
	{ name: "Bo Middle", position: "middle", corresponding: false, institution: "Altmark Lab", institutionId: "I9", country: "DE", institutionH: null,
		institutions: [{ name: "Altmark Lab", id: "I9", ror: null, country: "DE", type: "facility", hIndex: null }] },
	{ name: "Cy Corr", position: "last", corresponding: true, institution: "Lumen University", institutionId: "I4", country: "CN", institutionH: 455,
		institutions: [{ name: "Lumen University", id: "I4", ror: null, country: "CN", type: "education", hIndex: 455 }] }
];

test("OpenAlex: every institution of an authorship is kept with its id, ROR, country and type; each one's h-index is looked up", async () => {
	const S = freshSources();
	const asked = [];
	const http = { async getJSON(url) {
		const u = new URL(url);
		if (u.pathname === "/works") return { meta: { count: 1 }, results: [{ id: "https://openalex.org/W1", doi: "10.1234/w1", title: "Paper", publication_year: 2025,
			primary_location: { source: { id: "https://openalex.org/S1", display_name: "J" } },
			authorships: [authorship("Ada First", "first", [inst("I1", "Hanbit University", "KR", "education", "https://ror.org/01"), inst("I2", "Eastbridge Hospital", "US", "healthcare")]),
				authorship("Cy Corr", "last", [inst("I4", "Lumen University", "CN")], { corresponding: true })] }] };
		if (u.pathname === "/sources") return { results: [] };
		if (u.pathname === "/institutions") {
			asked.push(u.searchParams.get("filter"));
			return { results: [{ id: "https://openalex.org/I1", display_name: "Hanbit University", country_code: "KR", summary_stats: { h_index: 640 } },
				{ id: "https://openalex.org/I2", display_name: "Eastbridge Hospital", country_code: "US", summary_stats: { h_index: 2320 } },
				{ id: "https://openalex.org/I4", display_name: "Lumen University", country_code: "CN", summary_stats: { h_index: 455 } }] };
		}
		throw new Error("unexpected " + url);
	} };
	const [r] = await S.search("openalex", { keywords: "x", maxResults: 5 }, http, { enrichCitations: false, jcr: false });
	const ada = r.people[0];
	assert.deepEqual(JSON.parse(JSON.stringify(ada.institutions)), [
		{ name: "Hanbit University", id: "I1", ror: "https://ror.org/01", country: "KR", type: "education", hIndex: 640 },
		{ name: "Eastbridge Hospital", id: "I2", ror: null, country: "US", type: "healthcare", hIndex: 2320 }]);
	// The single-institution fields stay the first one's, so everything that read them reads the same.
	assert.deepEqual([ada.institution, ada.institutionId, ada.country, ada.institutionH], ["Hanbit University", "I1", "KR", 640]);
	assert.deepEqual(asked, ["ids.openalex:I1|I2|I4"], "the second post is looked up in the same request");
});

test("Crossref and Europe PMC: every affiliation string is kept, in order", () => {
	const S = freshSources();
	const placed = [{ name: "A", position: "first", corresponding: false, institution: "DTU", institutionId: "I10", country: "DK", institutionH: null,
		institutions: [{ name: "DTU", id: "I10", ror: null, country: "DK", type: "education", hIndex: null }, { name: "Novo Foundation", id: "I11", ror: null, country: "DK", type: "nonprofit", hIndex: null }] }];
	const strings = [{ name: "A", position: "first", corresponding: false, institution: "Dept X, DTU", institutionId: null, country: null, institutionH: null }];
	const base = { title: "Same paper", doi: "10.1234/x", authors: [] };
	const [merged] = S.mergeRecords([[{ ...base, source: "crossref", people: strings }], [{ ...base, source: "openalex", people: placed }]]);
	assert.deepEqual(merged.people[0].institutions.map(i => i.name), ["DTU", "Novo Foundation"], "the placed list brings all its institutions");
	// The Crossref adapter itself: two affiliation objects become two institutions.
	const crossref = readFileSync(new URL("../content/sources.js", import.meta.url), "utf8");
	assert.match(crossref, /institutions: \(a\.affiliation \|\| \[\]\)/, "Crossref keeps every affiliation");
	assert.match(crossref, /institutions: \(a\.authorAffiliationDetailsList\?\.authorAffiliation \|\| \[\]\)/, "Europe PMC keeps every affiliation");
});

test("the tier is the best of an author's institutions, and names the institution it comes from", () => {
	const where = A.summarise(MULTI);
	assert.equal(where.first.institution, "Hanbit University", "the first institution is shown first");
	assert.equal(where.first.hIndex, 640, "the first institution's own h-index, as the CSV column has always held");
	assert.equal(where.first.tier, "t1");
	assert.equal(where.first.tierFrom, "Eastbridge Hospital");
	assert.equal(where.first.tierH, 2320);
	assert.deepEqual(where.first.institutions.map(i => [i.name, i.flag, i.tier]), [["Hanbit University", "🇰🇷", "t3"], ["Eastbridge Hospital", "🇺🇸", "t1"], ["Kestrel Institute", "🇬🇧", null]]);
	assert.deepEqual(where.countries, ["KR", "US", "GB", "CN"], "every country of the two principal authors");
	assert.equal(where.tier, "t1");
	assert.equal(where.hIndex, 2320);
	// The old shape (one institution in flat fields) reads as a list of one.
	const old = A.summarise([{ name: "Solo", position: "first", institution: "Lab", institutionId: "I7", country: "kr", institutionH: 500 }]);
	assert.deepEqual(old.first.institutions.map(i => [i.name, i.country, i.hIndex]), [["Lab", "KR", 500]]);
	assert.equal(old.first.tierFrom, "Lab");
});

test("filters: institution, country and words match any of an author's institutions", () => {
	const r = { title: "T", people: MULTI };
	assert.deepEqual(F.institutions(r).map(i => i.name), ["Hanbit University", "Eastbridge Hospital", "Kestrel Institute", "Altmark Lab", "Lumen University"]);
	assert.deepEqual(F.countries(r), ["KR", "US", "GB", "DE", "CN"]);
	const env = { where: x => A.summarise(x.people) };
	const rule = (kind, values) => ({ ...F.newRule(kind, "include"), values });
	assert.equal(F.ruleHolds(r, rule("inst", [F.flat("Eastbridge Hospital")]), env), true, "the second post finds the paper");
	assert.equal(F.ruleHolds(r, rule("country", ["GB"]), env), true, "the third post's country finds it");
	assert.equal(F.matches(r, F.compile("inst:kestrel"), env), true);
	assert.equal(F.matches(r, F.compile("country:gb"), env), true);
});

test("saved searches of the old shape gain the list when they are read", async () => {
	const files = new Map();
	const h = History.create({ io: History.memoryIO(files), dir: "h" });
	const old = { key: "k", title: "T", people: [{ name: "Old", position: "first", institution: "Lab A", institutionId: "I5", country: "KR", institutionH: 900 }, { name: "Nobody", position: "last" }] };
	const id = await h.save({ source: "openalex", query: { keywords: "x" }, records: [old] });
	const back = await h.get(id);
	assert.deepEqual(back.records[0].people[0].institutions, [{ name: "Lab A", id: "I5", ror: null, country: "KR", type: null, hIndex: 900 }]);
	assert.deepEqual(back.records[0].people[1].institutions, []);
	assert.equal(back.records[0].people[0].institution, "Lab A", "the flat fields stay");
});

const pick = (ui, key) => ui.state.records.find(r => r.key === key);

test("the institution cell shows the first with +n, the hover card lists them all, and the tier chip names its institution", async () => {
	// The column shows the corresponding author's lab; a first author alone is the column's person.
	const ui2 = uiHarness({ realRows: true, search: async () => [paper("f", { people: [MULTI[0]], source: "openalex" })] });
	await ui2.runSearch();
	const solo = pick(ui2, "f");
	const row = ui2.buildRow(solo);
	const more = row.querySelector("span.aff-more");
	assert.ok(more, "a +n marks the other institutions");
	assert.equal(more.textContent, "+2");
	const affTd = more.closest("td");
	const card = ui2.tipContent(affTd, "aff");
	const lines = card.querySelectorAll("div.tip-inst-row").map(n => n.textContent);
	assert.equal(lines.length, 3, "the hover card lists all three institutions: " + lines.join(" | "));
	assert.match(lines[1], /Eastbridge Hospital/);
	assert.match(card.textContent, /tipTierFrom\|Eastbridge Hospital/, "the tier says which institution it comes from");
});

test("the detail lists every institution: superscripts point at each, the folded where-line names them all", async () => {
	const ui = uiHarness({ realRows: true, search: async () => [paper("m", { people: MULTI, source: "openalex" })] });
	await ui.runSearch();
	const r = pick(ui, "m");
	ui.renderAuthors(r);
	const box = ui.get("d-authors");
	const insts = box.querySelectorAll("button.au-inst-btn").map(b => b.textContent);
	assert.deepEqual(insts, ["Hanbit University (KR)", "Eastbridge Hospital (US)", "Kestrel Institute (GB)", "Altmark Lab (DE)", "Lumen University (CN)"]);
	const ada = box.querySelectorAll("span.au")[0];
	assert.deepEqual(ada.querySelectorAll("sup").map(s => s.textContent), ["1,2,3"], "Ada points at her three institutions");
	ui.state.detailKey = "m";
	ui.originalRenderDetail();
	const where = ui.get("d-where").textContent;
	for (const name of ["Hanbit University", "Eastbridge Hospital", "Kestrel Institute", "Lumen University"]) assert.match(where, new RegExp(name));
});

test("CSV: the existing columns are unchanged; every institution follows at the end, joined with '; '", async () => {
	const ui = uiHarness({ realRows: true, search: async () => [paper("m", { people: MULTI, source: "openalex" })] });
	await ui.runSearch();
	const head = I18N.STRINGS.en.csvHead, ko = I18N.STRINGS.ko.csvHead;
	const before = ["Citations", "CitationsPerYear", "Rank", "Authors", "Title", "Year", "Journal", "JIF", "JIFSource", "OpenAlex2yMean", "FirstAuthorInstitution", "FirstAuthorCountry", "FirstAuthorInstitutionHIndex", "CorrespondingInstitution", "CorrespondingCountry", "CorrespondingInstitutionHIndex", "CorrespondingBasis", "Publisher", "DOI", "URL", "PDF", "Source", "InLibrary", "CitationSource", "Tier", "Retracted"];
	assert.deepEqual(head.slice(0, before.length), before, "a sheet built on the earlier columns still reads them where they were");
	assert.deepEqual(head.slice(before.length), ["FirstAuthorInstitutions", "FirstAuthorCountries", "CorrespondingInstitutions", "CorrespondingCountries", "AllInstitutions"]);
	assert.equal(ko.length, head.length);
	const row = csvCells(ui.csvText().split("\n")[1]);
	assert.equal(row.length, head.length);
	const at = name => row[head.indexOf(name)];
	assert.deepEqual([at("FirstAuthorInstitution"), at("FirstAuthorCountry"), at("FirstAuthorInstitutionHIndex")], ["Hanbit University", "KR", "640"]);
	assert.equal(at("FirstAuthorInstitutions"), "Hanbit University; Eastbridge Hospital; Kestrel Institute");
	assert.equal(at("FirstAuthorCountries"), "KR; US; GB");
	assert.equal(at("CorrespondingInstitutions"), "Lumen University");
	assert.equal(at("CorrespondingCountries"), "CN");
	assert.equal(at("AllInstitutions"), "Hanbit University; Eastbridge Hospital; Kestrel Institute; Altmark Lab; Lumen University");
	assert.equal(at("Tier"), "T1", "the best institution sets the tier");
});

test("rowSignature follows a second institution: a new post or its h-index rebuilds the row", async () => {
	const people = MULTI.map(p => ({ ...p, institutions: p.institutions.map(i => ({ ...i })) }));
	const ui = uiHarness({ realRows: true, search: async () => [paper("m", { people, source: "openalex" })] });
	await ui.runSearch();
	const r = pick(ui, "m");
	const before = ui.rowSignature(r);
	people[2].institutions.push({ name: "Second Post", id: "I8", ror: null, country: "JP", type: "facility", hIndex: null });
	ui.displaySearchResults([paper("m", { people, source: "openalex" })]);
	const after = ui.rowSignature(pick(ui, "m"));
	assert.notEqual(after, before, "an added institution is seen");
	people[2].institutions[1].hIndex = 2100;
	ui.displaySearchResults([paper("m", { people, source: "openalex" })]);
	assert.notEqual(ui.rowSignature(pick(ui, "m")), after, "its h-index is seen");
});

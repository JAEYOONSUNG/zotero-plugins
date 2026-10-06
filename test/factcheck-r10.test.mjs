/* Round 10 fact-check: journal metrics checked against the user's real JCR export, live OpenAlex and the
   library (2026-10-06). Every fixture below is a real row or a real answer. */
import { test } from "node:test";
import assert from "node:assert/strict";
import JCR from "../content/jcr.js";
import S from "../content/sources.js";
import I18N from "../content/i18n.js";

// Rows exactly as the user's jcr.json has them.
const ROWS = [
	["MICROBIOLOGY", "MICROBIOLOGY+", "0026-2617", "1608-3237", 1],
	["MICROBIOLOGY-SGM", "MICROBIOL-SGM", "1350-0872", "1465-2080", 4.3],
	["Life-Basel", "LIFE-BASEL", "", "2075-1729", 3.9],
	["NITRIC OXIDE-BIOLOGY AND CHEMISTRY", "NITRIC OXIDE-BIOL CH", "1089-8603", "1089-8611", 3.8],
	["Jove-Journal of Visualized Experiments", "JOVE-J VIS EXP", "1940-087X", "1940-087X", 1.2],
	["BIOCHIMICA ET BIOPHYSICA ACTA-BIOENERGETICS", "BBA-BIOENERGETICS", "0005-2728", "1879-2650", 2.6],
	["BIOTECHNOLOGY LETTERS", "BIOTECHNOL LETT", "0141-5492", "1573-6776", 2.5],
	["PROCEEDINGS OF THE NATIONAL ACADEMY OF SCIENCES OF THE UNITED STATES OF AMERICA", "P NATL ACAD SCI USA", "0027-8424", "1091-6490", 9.5],
	["SPORTS MEDICINE", "SPORTS MED", "0112-1642", "1179-2035", 11],
	["Sports Medicine-Open", "SPORTS MED-OPEN", "2199-1170", "2198-9761", 6.2],
	["NATURE", "NATURE", "0028-0836", "1476-4687", 56.1],
	["Nature-Based Solutions", "NAT-BASED SOLUT", "", "2772-4115", 3.6],
	["GENOME BIOLOGY", "GENOME BIOL", "1474-760X", "1474-760X", 9.2]
];
const table = JCR.build(ROWS);
const jif = record => table.find(record)?.jif ?? null;

test("a bare 'Microbiology' is not given the Russian journal's 1.0: only the ISSN decides it", () => {
	assert.equal(jif({ venue: "Microbiology" }), null, "six of the user's papers are the Society's Microbiology (4.3)");
	assert.equal(jif({ venue: "Microbiology", issn: "1350-0872" }), 4.3);
	assert.equal(jif({ venue: "Microbiology", issn: "0026-2617" }), 1);
});

test("titles the JCR writes with a hyphenated qualifier are found by their plain names", () => {
	assert.equal(jif({ venue: "Life" }), 3.9);
	assert.equal(jif({ venue: "Nitric Oxide" }), 3.8);
	assert.equal(jif({ venue: "Journal of Visualized Experiments" }), 1.2);
	assert.equal(jif({ venue: "Biochimica et Biophysica Acta (BBA) - Bioenergetics" }), 2.6, "the bracketed initials are not in the JCR title");
	// ...without taking a title some journal carries outright.
	assert.equal(jif({ venue: "Sports Medicine" }), 11);
	assert.equal(jif({ venue: "Nature" }), 56.1);
});

test("a renamed title's figure is labelled as the journal the JCR lists now; a mere spelling is not", () => {
	JCR.load(ROWS, { fileName: "jcr.json" });
	const old = { venue: "Biotechnology Techniques", issn: "0951-208X" }, pnas = { venue: "Proceedings of the National Academy of Sciences" };
	JCR.apply([old, pnas]);
	assert.equal(old.journalIF, 2.5);
	assert.equal(old.journalIFAs, "Biotechnology Letters");
	assert.equal(pnas.journalIF, 9.5);
	assert.equal(pnas.journalIFAs, undefined);
	for (const lang of ["en", "ko"]) assert.match(I18N.STRINGS[lang].jifTip("2.5", "JCR", null, "Biotechnology Letters"), /Biotechnology Letters/);
	assert.doesNotMatch(I18N.STRINGS.en.jifTip("9.5", "JCR", null, undefined), /undefined|lists/);
	JCR.load([]);
});

test("OpenAlex records keep every ISSN: Genome Biology's ISSN-L is not the one the JCR lists", async () => {
	// Live answer for Genome Biology's source: issn_l 1465-6906, the JCR row has only 1474-760X.
	const work = { id: "https://openalex.org/W1", doi: "https://doi.org/10.1186/gb-test", title: "T", publication_year: 2020, type: "article", authorships: [],
		primary_location: { source: { id: "https://openalex.org/S81160022", display_name: "Genome biology and evolution of something", issn_l: "1465-6906", issn: ["1465-6906", "1465-6914", "1474-7596", "1474-760X"] } } };
	const http = { getJSON: async () => ({ results: [work], meta: { count: 1 } }), getText: async () => "" };
	const [rec] = await S.search("openalex", { keywords: "10.1186/gb-test" }, http, { journalMetrics: false, institutionMetrics: false });
	assert.ok(rec.issns.includes("1474-760X"));
	assert.equal(jif(rec), 9.2, "found by ISSN although neither the ISSN-L nor the name matches");
});

test("PubMed records carry both the print and the electronic ISSN", async () => {
	const doc = { uid: "1", title: "Genome paper", authors: [{ name: "Smith A", authtype: "Author" }], pubdate: "2020", fulljournalname: "Genome biology",
		source: "Genome Biol", issn: "1465-6906", essn: "1474-760X", articleids: [] };
	const http = { getJSON: async url => url.includes("esearch") ? { esearchresult: { count: "1", idlist: ["1"] } } : url.includes("esummary") ? { result: { uids: ["1"], 1: doc } } : {}, getText: async () => "" };
	const [rec] = await S.search("pubmed", { keywords: "genome", maxResults: 5 }, http, { enrichCitations: false, journalMetrics: false, institutionMetrics: false });
	assert.deepEqual(rec.issns, ["1465-6906", "1474-760X"]);
});

test("OpenAlex's 2-year mean of exactly 0 (a title with no recent articles) is unknown, not the lowest figure", () => {
	// Live answers: Biotechnology for Biofuels (renamed 2022) 0; Genome Biology 9.67.
	assert.equal(S.journalStats({ id: "https://openalex.org/S1", display_name: "Biotechnology for Biofuels", issn_l: "1754-6834", summary_stats: { "2yr_mean_citedness": 0, h_index: 150 } }).if2y, null);
	assert.equal(S.journalStats({ id: "https://openalex.org/S2", display_name: "Genome biology", summary_stats: { "2yr_mean_citedness": 9.672977624784854 } }).if2y, 9.672977624784854);
});

test("a title the export lists itself is matched before any rename alias", () => {
	const t = JCR.build([...ROWS, ["Angewandte Chemie", "ANGEW CHEM", "0044-8249", "1521-3757", 9.1],
		["ANGEWANDTE CHEMIE-INTERNATIONAL EDITION", "ANGEW CHEM INT EDIT", "1433-7851", "1521-3773", 17.6]]);
	assert.equal(t.find({ venue: "Angewandte Chemie" }).jif, 9.1);
	assert.equal(t.find({ venue: "Angewandte Chemie" }).via, undefined);
	assert.equal(JCR.build(ROWS.concat([["ANGEWANDTE CHEMIE-INTERNATIONAL EDITION", "ANGEW CHEM INT EDIT", "1433-7851", "1521-3773", 17.6]])).find({ venue: "Angewandte Chemie" }).via, "Angewandte Chemie");
});

test("the Preferences notes say what the IF column really shows without a JCR file", () => {
	for (const lang of ["en", "ko"]) {
		const s = I18N.STRINGS[lang];
		assert.doesNotMatch(s.prefJcrNone, /IF column shows OpenAlex|IF 열에는 OpenAlex/);
		assert.doesNotMatch(s.prefNoteIF, /with a ~|~를 붙여/);
		assert.match(s.prefNoteIF, lang === "en" ? /OA 2y/ : /OA 2년/);
	}
});

import M from "../content/metrics.js";
// Samuel H. Sternberg (OpenAlex A5072427514), every work ZotPoP loaded on 2026-10-06 as [citations, year, authors].
// OpenAlex's own profile that day: h-index 38, i10 55 over 127 works (ZotPoP merged three duplicate versions).
const STERNBERG = [[0,2026,4],[0,2026,7],[0,2026,3],[1,2026,10],[0,2026,2],[0,2026,18],[0,2026,8],[4,2026,12],[0,2026,2],[1,2026,6],[0,2026,18],[0,2026,2],[0,2026,2],[5,2026,11],[5,2026,7],[12,2025,13],[34,2025,13],[5,2025,10],[12,2025,5],[1,2025,12],[15,2025,9],[2,2025,8],[0,2025,7],[1,2025,11],[21,2025,15],[106,2025,15],[0,2025,1],[10,2025,13],[0,2025,15],[0,2025,8],[0,2025,4],[0,2025,4],[10,2025,5],[9,2024,9],[3,2024,5],[58,2024,13],[9,2024,10],[39,2024,8],[1,2024,5],[4,2024,13],[0,2024,6],[55,2024,6],[3,2023,8],[2,2023,10],[37,2023,9],[23,2023,2],[66,2023,8],[4,2023,9],[47,2023,4],[153,2023,9],[7,2023,6],[2,2023,9],[8,2023,7],[12,2023,4],[0,2023,4],[0,2023,4],[0,2022,5],[10,2022,2],[74,2022,11],[80,2022,6],[55,2021,4],[3,2021,4],[0,2021,4],[360,2020,7],[1,2020,4],[6,2020,7],[1,2020,2],[133,2019,4],[123,2019,27],[3,2019,4],[680,2019,4],[3,2019,2],[58,2018,2],[20,2018,10],[0,2018,2],[0,2018,2],[0,2018,2],[0,2018,2],[0,2018,2],[9,2018,2],[0,2018,2],[0,2018,2],[0,2018,2],[0,2018,2],[0,2018,2],[1255,2017,10],[312,2017,5],[21,2017,9],[216,2017,2],[48,2017,4],[228,2017,8],[28,2017,5],[1,2017,5],[0,2017,3],[286,2016,5],[8,2016,8],[14,2016,5],[263,2016,4],[210,2015,9],[681,2015,4],[419,2015,2],[715,2015,18],[302,2015,7],[1,2015,5],[651,2014,6],[217,2014,7],[1300,2014,15],[1908,2014,5],[0,2014,15],[0,2014,8],[0,2014,1],[120,2014,5],[0,2013,7],[105,2012,3],[0,2012,3],[0,2012,3],[0,2012,3],[166,2012,3],[1888,2012,3],[1,2012,5],[152,2010,4],[57,2010,8],[85,2009,5],[0,2009,3]];

test("a real author's h-index matches OpenAlex's profile (Sternberg, h 38)", () => {
	const recs = STERNBERG.map(([citations, year, n]) => ({ citations, year, authors: Array.from({ length: n }, (_, i) => ({ name: "A" + i })), citationSource: "openalex" }));
	const m = M.compute(recs, 2026);
	assert.equal(m.hIndex, 38);
	assert.equal(m.papers, 124);
	assert.equal(m.minYear, 2009);
});

test("figures that cannot be computed are null, not 0 or a one-year rate", () => {
	const none = M.compute([{ year: 2020, citations: null, authors: [{ name: "A" }] }], 2026);
	assert.equal(none.hIndex, null);
	assert.equal(none.gIndex, null);
	assert.equal(none.hA, null);
	assert.equal(none.citesPerPaper, null);
	assert.equal(none.citesPerYear, null);
	const undated = M.compute([{ year: null, citations: 100, authors: [{ name: "A" }] }], 2026);
	assert.equal(undated.citesPerYear, null, "no year, no yearly rate");
	assert.equal(undated.hIndex, 1);
	assert.equal(M.compute([], 2026).hIndex, null);
});

import F from "../content/filters.js";
test("errata, editorials, front matter and peer-review reports are not articles in the type filter", () => {
	// Types OpenAlex gave Tiangang Liu's 179 works: 27 peer-review, 2 erratum, 2 editorial, 1 dataset, 2 other.
	for (const workType of ["peer-review", "erratum", "editorial", "paratext", "dataset", "other"])
		assert.equal(F.typeOf({ itemType: "journalArticle", workType, title: "A paper" }), "other", workType);
	assert.equal(F.typeOf({ itemType: "journalArticle", workType: "article", title: "A paper" }), "article");
	assert.equal(F.typeOf({ itemType: "journalArticle", workType: "letter", title: "A paper" }), "article");
	assert.equal(F.typeOf({ itemType: "journalArticle", workType: "review", title: "A paper" }), "review");
});

import J from "../content/journals.js";
// The two registry rows for "Microbiology", as journal-registry.json has them.
const MICRO = [{ title: "Microbiology", issns: ["1350-0872", "1465-2080"], abbreviation: "", impactFactor: 2.91, publisher: "Microbiology Society" },
	{ title: "Microbiology", issns: ["0026-2617", "1608-3237", "3034-5464"], abbreviation: "", impactFactor: 0.8, publisher: "Pleiades Publishing" }];

test("two journals of one title are two choices in the journal list, told apart by publisher", () => {
	const cat = J.build({ registry: MICRO, jcr: ROWS.slice(0, 2) });
	const found = J.suggest(cat, "Microbiology").filter(x => J.flat(x.name) === "microbiology");
	assert.equal(found.length, 2);
	assert.deepEqual(found.map(x => x.publisher).sort(), ["Microbiology Society", "Pleiades Publishing"]);
	const society = found.find(x => x.publisher === "Microbiology Society");
	assert.ok(society.issns.includes("1350-0872") && !society.issns.includes("0026-2617"), "the Society's choice holds only its own ISSNs");
	assert.equal(J.suggest(J.build({ registry: MICRO.slice(0, 1) }), "Microbiology")[0].homonym, undefined, "a title with one journal says nothing more");
});

test("a journal picked with its ISSNs is searched by them, not by its title", async () => {
	const urls = [];
	const http = { getText: async () => "", getJSON: async url => { urls.push(url);
		if (url.includes("/sources?filter=issn:")) return { results: [{ id: "https://openalex.org/S96", display_name: "Microbiology", issn: ["1350-0872", "1465-2080"] }] };
		return { results: [], meta: { count: 0 }, message: { items: [], "total-results": 0 } }; } };
	const venues = [{ name: "Microbiology", issns: ["1350-0872", "1465-2080"] }];
	await S.search("openalex", { venues, maxResults: 5 }, http, { journalMetrics: false, institutionMetrics: false });
	assert.ok(urls.some(u => u.includes("primary_location.source.id:S96")));
	assert.ok(!urls.some(u => u.includes("sources?search=")), "no title search that takes Pleiades' journal too");
	urls.length = 0;
	await S.search("crossref", { venues, maxResults: 5 }, http, { journalMetrics: false, institutionMetrics: false });
	assert.ok(urls.some(u => u.startsWith("https://api.crossref.org/journals/1350-0872/works")), urls.join("\n"));
});

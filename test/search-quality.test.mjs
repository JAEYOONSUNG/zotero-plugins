import { test } from "node:test";
import assert from "node:assert/strict";
import S from "../content/sources.js";

const ctx = { enrichCitations: false, journalMetrics: false };
const target = "Precise genome editing with engineered recombinases";
const work = (id, title, citations, date = "2025-01-01") => ({
	id: "https://openalex.org/" + id, title, doi: "10.1234/" + id,
	cited_by_count: citations, publication_year: Number(date.slice(0, 4)), publication_date: date
});
const crossref = (id, title, citations, date = [2025, 1, 1]) => ({
	DOI: "10.1234/" + id, title: [title], "is-referenced-by-count": citations,
	issued: { "date-parts": [date] }
});
function mockHTTP({ oa = [], cr = [], epmc = [], sources = [], fail = [] } = {}) {
	const urls = [];
	return { urls, async getJSON(url) {
		urls.push(new URL(url));
		if (fail.some(host => url.includes(host))) throw new Error("source unavailable");
		if (url.includes("openalex.org/sources")) return { results: sources };
		if (url.includes("openalex.org/works")) return { results: oa, meta: { count: oa.length } };
		if (url.includes("crossref.org/works")) return { message: { items: cr, "total-results": cr.length } };
		if (url.includes("europepmc")) return { resultList: { result: epmc }, hitCount: epmc.length };
		throw new Error("Unexpected request " + url);
	}, async getText(url) { urls.push(new URL(url)); return "<feed></feed>"; } };
}
const rec = (source, title, extra = {}) => ({
	source, title, key: source + ":" + title, authors: [], pdfUrls: [], sources: [source], ...extra
});

test("OpenAlex title and author relevance do not request citation order", async () => {
	for (const fields of [{ title: target }, { authors: "David R Liu" }, { keywords: "genome editing" }]) {
		const http = mockHTTP();
		await S.search("openalex", { ...fields, sort: "relevance", maxResults: 5 }, http, ctx);
		assert.notEqual(http.urls[0].searchParams.get("sort"), "cited_by_count:desc");
	}
	const http = mockHTTP();
	await S.search("openalex", { title: target, sort: "citations" }, http, ctx);
	assert.equal(http.urls[0].searchParams.get("sort"), "cited_by_count:desc");
});

test("OpenAlex exact journal name excludes similarly named journals", async () => {
	const http = mockHTTP({ sources: [
		{ id: "https://openalex.org/S1", display_name: "Nature Communications" },
		{ id: "https://openalex.org/S2", display_name: "Nature" },
		{ id: "https://openalex.org/S3", display_name: "Nature Medicine" }
	] });
	await S.search("openalex", { venue: "Nature", sort: "date" }, http, ctx);
	assert.equal(http.urls[1].searchParams.get("filter"), "primary_location.source.id:S2");
});

test("combined relevance keeps each source's top results before truncating", async () => {
	const http = mockHTTP({
		oa: [work("oa", "Targeted recombinase genome engineering", 1), work("old", "Broad genome survey", 10000)],
		cr: [crossref("cr", "Directed evolution of recombinases", 0), crossref("review", "Broad gene survey", 20000)]
	});
	const result = await S.search("multi", { keywords: "recombinase engineering", maxResults: 2 }, http, ctx);
	assert.deepEqual(result.map(r => r.doi), ["10.1234/oa", "10.1234/cr"]);
});

test("an exact title outranks a popular partial match in relevance mode", async () => {
	const http = mockHTTP({ oa: [work("review", "A review of genome editing", 10000), work("target", target, 1)] });
	const result = await S.search("multi", { keywords: target, maxResults: 2 }, http, ctx);
	assert.equal(result[0].doi, "10.1234/target");
});

test("combined date and citation order are applied before the result limit", async () => {
	for (const [sort, expected] of [["date", "new"], ["citations", "old"]]) {
		const http = mockHTTP({ oa: [work("old", "Older paper", 10000, "2025-01-01")],
			cr: [crossref("new", "Newer paper", 1, [2025, 12, 1])] });
		const result = await S.search("multi", { keywords: "paper", sort, maxResults: 1 }, http, ctx);
		assert.equal(result[0].doi, "10.1234/" + expected);
	}
});

test("combined relevance rewards agreement without duplicate votes from one source", async () => {
	const http = mockHTTP({ oa: [work("a", "Single source", 900), work("shared", "Shared result", 1), work("a", "Single source", 900)],
		cr: [crossref("b", "Other source", 800), crossref("shared", "Shared result", 1)] });
	const result = await S.search("multi", { keywords: "query", maxResults: 3 }, http, ctx);
	assert.equal(result[0].doi, "10.1234/shared");
	assert.deepEqual(result[0].sources, ["openalex", "crossref"]);
});

test("preprint relevance is not replaced by citation order", async () => {
	const http = mockHTTP({ epmc: [
		{ id: "1", title: "Specific recombinase paper", source: "PPR", citedByCount: 1 },
		{ id: "2", title: "General biology review", source: "PPR", citedByCount: 10000 }
	] });
	const result = await S.search("preprint", { keywords: "recombinase", maxResults: 2 }, http, ctx);
	assert.equal(result[0].sourceId, "1");
});

test("one failed source preserves relevance and reports partial failure", async () => {
	const http = mockHTTP({ oa: [work("good", "Specific paper", 1), work("bad", "Broad paper", 5000)], fail: ["crossref"] });
	const context = { ...ctx };
	const result = await S.search("multi", { keywords: "query", maxResults: 2 }, http, context);
	assert.equal(result[0].doi, "10.1234/good");
	assert.equal(context.errors.length, 1);
});

test("dedupe preserves non-Latin titles and short-title records with conflicting metadata", () => {
	const records = [rec("x", "유전자 편집 연구"), rec("x", "단백질 구조 분석"),
		rec("x", "Editorial", { year: 2020 }), rec("x", "Editorial", { year: 2025 })];
	assert.equal(S.dedupe(records).length, 4);
	assert.equal(S.dedupe([rec("x", "유전자 편집 연구"), rec("y", "유전자 편집 연구")]).length, 1);
});

test("DOI and no-DOI copies merge metadata without conflating distinct DOIs", () => {
	const records = S.mergeRecords([
		[rec("oa", target, { doi: "10.1234/a", year: 2025, citations: 3 })],
		[rec("epmc", target + ".", { year: 2025, abstract: "Detailed abstract", pmid: "123" })],
		[rec("cr", target, { doi: "10.1234/b", year: 2025 })]
	]);
	assert.equal(records.length, 2);
	assert.equal(records[0].pmid, "123");
	assert.equal(records[0].abstract, "Detailed abstract");
	assert.deepEqual(records[0].sources, ["oa", "epmc"]);
});

test("dedupe uses normalized DOI and preserves unrelated missing titles", () => {
	assert.equal(S.dedupe([rec("x", "One", { doi: "https://doi.org/10.1234/ABC" }), rec("y", "Two", { doi: "10.1234/abc" })]).length, 1);
	assert.equal(S.dedupe([rec("x", "", { sourceId: "1" }), rec("x", "", { sourceId: "2" })]).length, 2);
});

test("generic titles require corroborating authors, year and journal", () => {
	for (const title of ["Introduction", "Acknowledgements", "Editorial Board"]) {
		assert.equal(S.dedupe([rec("x", title, { sourceId: "1", venue: "Nature" }),
			rec("y", title, { sourceId: "2", venue: "Science" })]).length, 2);
	}
	const metadata = { year: 2025, authors: [{ lastName: "Liu" }], venue: "Nature" };
	assert.equal(S.dedupe([rec("x", "Introduction", metadata), rec("y", "Introduction", metadata)]).length, 1);
});

test("identifier bridges collapse copies with different titles and retain source ranks", () => {
	const result = S.mergeRecords([
		[rec("oa", "A full research title", { doi: "10.1234/bridge" })],
		[rec("epmc", "A translated research title", { pmid: "42" })],
		[rec("cr", "A full research title", { doi: "10.1234/bridge", pmid: "42" })]
	]);
	assert.equal(result.length, 1);
	assert.equal(result[0].pmid, "42");
	assert.equal(result[0].sources.length, 3);
	assert.equal(Object.keys(result[0].sourceRanks).length, 3);
});

test("PMC identifiers merge translated copies and preserve conflicting papers", () => {
	const a = rec("oa", "An original research paper title", { pmcid: "PMC42" });
	const b = rec("epmc", "A translated research paper title", { pmcid: "PMC42" });
	assert.equal(S.dedupe([a, b]).length, 1);
	assert.equal(S.dedupe([a, { ...a, source: "cr", pmcid: "PMC43" }]).length, 2);
});

test("conflicting shared identifiers do not hide earlier verified copies", () => {
	const a = rec("oa", "First record", { doi: "10.1234/shared", pmid: "1" });
	const b = rec("cr", "Conflicting record", { doi: "10.1234/shared", pmid: "2" });
	const copy = { ...a, source: "epmc", title: "Translated copy", abstract: "Verified abstract" };
	for (const rows of [[a, b, copy], [b, a, copy], [copy, b, a]]) {
		const merged = S.dedupe(rows);
		assert.equal(merged.length, 2);
		assert.equal(merged.find(r => r.pmid === "1").abstract, "Verified abstract");
		assert.equal(S.dedupe(merged).length, 2);
	}
});

test("generic titles need a known matching journal as well as author and year", () => {
	const a = rec("oa", "Introduction", { year: 2025, authors: [{ lastName: "Liu" }] });
	for (const venue of [undefined, "Nature"]) {
		assert.equal(S.dedupe([a, { ...a, source: "cr", venue }]).length, 2);
	}
	assert.equal(S.dedupe([{ ...a, venue: "Nature" }, { ...a, source: "cr", venue: "NATURE" }]).length, 1);
});

test("arXiv keeps quoted phrases, Boolean operators and fielded groups intact", async () => {
	for (const [keywords, expected] of [
		['"base editing" OR CRISPR', '(all:"base editing" OR all:CRISPR)'],
		['(transformer OR attention) AND ti:"language model"', '((all:transformer OR all:attention) AND ti:"language model")'],
		['transformer attention', '(all:transformer AND all:attention)'],
		['CRISPR NOT cancer', '(all:CRISPR ANDNOT all:cancer)'],
		['CRISPR AND NOT cancer', '(all:CRISPR ANDNOT all:cancer)']
	]) {
		const http = mockHTTP();
		await S.search("arxiv", { keywords }, http, ctx);
		assert.equal(http.urls[0].searchParams.get("search_query"), expected);
	}
});

test("OpenAlex resolves a plain author name to entities instead of scanning raw names", async () => {
	// "Sung JY" broadened to the surname made OpenAlex return thousands of other Sungs,
	// 92% of which the local filter discarded, at ~99 metered requests per search.
	assert.equal(S.isPlainAuthorQuery("Sung JY"), true);
	assert.equal(S.isPlainAuthorQuery("Sung AND Kim"), false, "boolean queries keep the name search");
	assert.equal(S.isPlainAuthorQuery("a; b"), false);

	let asked = [];
	const http = {
		async getJSON(url) {
			asked.push(url);
			return { results: [
				{ id: "https://openalex.org/A1", display_name: "Jee Young Sung", display_name_alternatives: ["J. Y. Sung"] },
				{ id: "https://openalex.org/A2", display_name: "Jae Yoon Sung" },
				{ id: "https://openalex.org/A3", display_name: "Min Ho Kim" }
			] };
		}
	};
	let filter = await S.openAlexAuthorFilter("Sung JY", http, {});
	assert.equal(filter, "authorships.author.id:A1|A2", "only the matching people are kept");
	assert.equal(asked.length, 1, "one lookup, not a page walk");
	assert.match(asked[0], /\/authors\?search=Sung%20JY/);

	let none = await S.openAlexAuthorFilter("Nobody Here", { async getJSON() { return { results: [] }; } }, {});
	assert.equal(none, null, "no match falls back to the name search");
});

test("OpenAlex requests carry the API key when one is configured", () => {
	// Without a key OpenAlex allows about ten searches a day and then refuses everything.
	let withKey = S.openAlexAuth({ openAlexApiKey: "k123", email: "a@b.c" });
	assert.match(withKey, /api_key=k123/);
	assert.match(withKey, /mailto=a%40b\.c/);
	assert.equal(S.openAlexAuth({}), "");
	// A budget refusal must not be retried: the wait cannot help until midnight UTC.
	assert.equal(S.isQuotaError({ status: 429, body: '{"message":"Insufficient budget"}' }), true);
	assert.equal(S.isQuotaError({ status: 429, message: "HTTP 429" }), false, "a plain 429 is still retried");
	assert.equal(S.isQuotaError({ status: 503 }), false);
});

test("a topic search drops provider noise that matches no query term", () => {
	// Crossref answered "Geobacillus thermophilic genome engineering" with fracture-mechanics
	// and finite-element papers, which matched only the word "engineering" in their journal name.
	const terms = S.keywordTerms("Geobacillus thermophilic genome engineering");
	assert.deepEqual(terms, ["geobacillus", "thermophilic", "genome", "engineering"]);

	const drop = [
		{ title: "A numerical study of crack propagation", venue: "Engineering Fracture Mechanics" },
		{ title: "Adaptive mesh refinement for elliptic problems", venue: "Computer Methods in Applied Mechanics and Engineering" }
	];
	for (const r of drop) assert.equal(S.matchesKeywords(terms, r), false, r.title);

	const keep = [
		{ title: "Complete genome sequence of Geobacillus icigianus", venue: "MRA" },
		{ title: "Thermophilic enzymes and their applications", venue: "Extremophiles" },
		{ title: "", abstract: "", venue: "Nature" }
	];
	for (const r of keep) assert.equal(S.matchesKeywords(terms, r), true, r.title || "(no title)");

	// a single term, a quoted phrase or a Boolean query is left to the provider
	assert.equal(S.matchesKeywords(S.keywordTerms("crispr"), drop[0]), true);
	assert.deepEqual(S.keywordTerms('"gene editing"'), []);
	assert.deepEqual(S.keywordTerms("a AND b"), []);
	assert.deepEqual(S.keywordTerms("title:x"), []);
});

// Round 20: a regression sweep over rounds 2-18 (Astra + own read).
import { test } from "node:test";
import assert from "node:assert/strict";
import Sources from "../content/sources.js";

const noMetrics = { journalMetrics: false, institutionMetrics: false, enrichCitations: false };

test("Europe PMC keeps both ISSNs, so a journal picked by its electronic ISSN keeps its papers", async () => {
	const row = { id: "1", source: "MED", title: "Biofilm paper", pubYear: "2024", doi: "10.1/bio", authorList: { author: [] },
		journalInfo: { journal: { title: "Microbiology", issn: "1350-0872", essn: "1465-2080" } } };
	const http = { async getJSON() { return { hitCount: 1, resultList: { result: [row] } }; }, async getText() { return ""; } };
	const recs = await Sources.search("europepmc", { keywords: "biofilm", venues: [{ name: "Microbiology", issns: ["1465-2080"] }], maxResults: 5 }, http, noMetrics);
	assert.equal(recs.length, 1);
	assert.deepEqual(recs[0].issns, ["1350-0872", "1465-2080"]);
});

test("OpenAlex completion never shortens a complete author list (OpenAlex stops at 100 authorships)", async () => {
	const names = Array.from({ length: 101 }, (_, i) => "Author" + i + " Person" + i);
	const rec = Sources.makeRecord({ source: "crossref", sourceId: "x", title: "Big consortium paper", doi: "10.1234/big", year: 2024, citations: 5,
		authors: names.map(n => ({ name: n, firstName: n.split(" ")[0], lastName: n.split(" ")[1] })), authorString: names.join(", "),
		people: names.map((n, i) => ({ name: n, position: i === 0 ? "first" : i === 100 ? "last" : "middle", corresponding: false, institution: i === 100 ? "Last Lab University" : "", institutionId: null, country: null, institutionH: null })) });
	const authorships = names.slice(0, 100).map((n, i) => ({ author: { display_name: n, id: "https://openalex.org/A" + i }, author_position: i === 0 ? "first" : "middle",
		institutions: [{ id: "https://openalex.org/I" + i, display_name: "Inst " + i, country_code: "us" }] }));
	const http = { async getJSON() { return { results: [{ doi: "https://doi.org/10.1234/big", cited_by_count: 7, authorships }] }; } };
	await Sources.enrichFromOpenAlex([rec], http, {}, { complete: true });
	assert.equal(rec.people.length, 101, "the 101st author stays");
	assert.equal(rec.people[100].institution, "Last Lab University", "and keeps the lab the source named");
	assert.equal(rec.people[100].position, "last");
	assert.equal(rec.people[0].institution, "Inst 0", "matched authors gain their OpenAlex institution");
	assert.equal(rec.people[0].country, "US");
	assert.equal(rec.people[5].institutionId, "I5");
});

test("merging two copies keeps the longer author list's people when the shorter one is placed", () => {
	const longPeople = Array.from({ length: 3 }, (_, i) => ({ name: "P" + i + " Q" + i, position: "middle", institution: "", institutionId: null, country: null }));
	const shortPeople = longPeople.slice(0, 2).map((p, i) => ({ ...p, institution: "Inst " + i, institutionId: "I" + i, country: "KR" }));
	const a = Sources.makeRecord({ source: "crossref", sourceId: "a", title: "Same paper", doi: "10.1234/same", year: 2024, authors: longPeople.map(p => ({ name: p.name })), people: longPeople });
	const b = Sources.makeRecord({ source: "openalex", sourceId: "b", title: "Same paper", doi: "10.1234/same", year: 2024, authors: longPeople.map(p => ({ name: p.name })), people: shortPeople });
	const [merged] = Sources.dedupe([a, b]);
	assert.equal(merged.people.length, 3);
	assert.equal(merged.people[0].institutionId, "I0");
	assert.equal(merged.people[2].name, "P2 Q2");
});

test("sorted by citations, every fetched candidate is completed from OpenAlex before the limit cuts the list", async () => {
	const item = (doi, n) => ({ DOI: doi, title: ["Biofilm " + doi], author: [{ given: "A", family: "B" }], issued: { "date-parts": [[2024]] }, "container-title": ["J"], type: "journal-article", "is-referenced-by-count": n });
	const http = { async getJSON(url) {
		const u = new URL(url);
		if (u.host === "api.crossref.org") return { message: { "total-results": 2, items: [item("10.1234/a", 10), item("10.1234/b", 1)] } };
		if (u.pathname === "/works" && String(u.searchParams.get("filter")).startsWith("doi:"))
			return { results: [{ doi: "https://doi.org/10.1234/a", cited_by_count: 10 }, { doi: "https://doi.org/10.1234/b", cited_by_count: 100 }] };
		return { meta: { count: 0 }, results: [] };
	}, async getText() { return ""; } };
	const one = await Sources.search("multi", { keywords: "biofilm", sort: "citations", maxResults: 1, sources: ["openalex", "crossref"] }, http, { journalMetrics: false, institutionMetrics: false });
	assert.deepEqual(one.map(r => [r.doi, r.citations]), [["10.1234/b", 100]]);
});

test("an explicit correction notice stays a correction: merged with an OpenAlex 'article', and when its title says review", async () => {
	const Filters = (await import("../content/filters.js")).default;
	const oa = Sources.makeRecord({ source: "openalex", sourceId: "W1", title: "Author Correction: Metabolic remodelling", doi: "10.1234/fix", year: 2025, workType: "article" });
	const epmc = Sources.makeRecord({ source: "europepmc", sourceId: "E1", title: "Author Correction: Metabolic remodelling", doi: "10.1234/fix", year: 2025, workType: "erratum" });
	const [merged] = Sources.dedupe([oa, epmc]);
	assert.equal(merged.workType, "erratum");
	assert.equal(Filters.typeOf(merged), "other");
	const titled = { title: "Correction: A systematic review of plants", itemType: "journalArticle", workType: "erratum" };
	assert.equal(Filters.typeOf(titled), "other", "an erratum about a review is not a review");
	assert.equal(Filters.typeOf({ title: "A systematic review of plants", itemType: "journalArticle", workType: "article" }), "review");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const M = require("../content/metrics.js");

test("a paper with no citation count is left out of citations per paper, not counted as zero", () => {
	const m = M.compute([{ citations: null, year: 2020 }, { citations: 5, year: 2020 }], 2026);
	assert.equal(m.unknownCitations, 1);
	assert.equal(m.citesPerPaper, 5, "five over the one paper that has a count, not over two");
	assert.equal(m.hIndex, 1);
	assert.equal(M.compute([{ citations: 0, year: 2020 }], 2026).unknownCitations, 0, "a real zero is a count");
});

test("counts from more than one index are named, so the h-index is read as a reference figure", () => {
	const m = M.compute([{ citations: 8, citationSource: "crossref", year: 2020 }, { citations: 12, citationSource: "europepmc", year: 2021 }], 2026);
	assert.deepEqual([...m.citationSources].sort(), ["crossref", "europepmc"]);
	assert.equal(M.compute([{ citations: 3, source: "openalex" }]).citationSources.length, 1);
});

test("statistics can be read from one index alone: its own counts, unknown where it has none", () => {
	const records = [
		{ year: 2020, citations: 3, citationsBy: { openalex: 3, crossref: 0 } },
		{ year: 2020, citations: 3, citationsBy: { openalex: 0, crossref: 3 } },
		{ year: 2020, citations: 3, citationsBy: { crossref: 3 } }];
	assert.equal(M.compute(records, 2026).hIndex, 3, "the highest per paper, as before");
	assert.equal(M.compute(records, 2026, { provider: "openalex" }).hIndex, 1, "OpenAlex's own network");
	assert.equal(M.compute(records, 2026, { provider: "openalex" }).unknownCitations, 1, "the paper OpenAlex has no count for is unknown");
	assert.equal(M.compute(records, 2026, { provider: "crossref" }).hIndex, 2);
});

test("string years count; no first year leaves the annual h as null; truncated author lists leave per-author figures", () => {
	const m = M.compute([{ year: "2015", citations: 10, authors: [{}, {}] }, { year: 2020, citations: 5, authors: [{}] }], 2025);
	assert.equal(m.minYear, 2015);
	assert.equal(m.citationYears, 10);
	assert.equal(M.paperAge("2020", 2025), 5);
	const none = M.compute([{ citations: 3, authors: [{}] }], 2025);
	assert.equal(none.hiAnnual, null);
	const cut = M.compute([{ year: 2020, citations: 10, authors: new Array(100).fill({}), authorsTruncated: true }, { year: 2020, citations: 8, authors: [{}, {}] }], 2025);
	assert.equal(cut.authorsTruncated, 1);
	assert.equal(cut.authorsPerPaper, 2);
	assert.equal(cut.papersPerAuthor, 0.5);
	assert.equal(cut.citesPerAuthor, 4);
	assert.equal(cut.papers, 2);
});

test("an unknown author list is not a solo author: per-author figures leave those papers out", () => {
	// ORCID works carry no author list at all.
	const orcid = [1, 2, 3].map(i => ({ year: 2020, citations: 9, authors: [], authorListComplete: false }));
	const m = M.compute(orcid, 2025);
	assert.equal(m.citesPerAuthor, null, "not 27");
	assert.equal(m.authorsPerPaper, null, "not 1");
	assert.equal(m.papersPerAuthor, null);
	assert.equal(m.hiNorm, null, "not 3");
	assert.equal(m.hiAnnual, null);
	assert.equal(m.perAuthorPapers, 0, "no paper is eligible");
	assert.equal(m.hIndex, 3, "figures that need no author list are untouched");
});

test("per-author figures say how many papers they were computed on", () => {
	const known = [{ year: 2020, citations: 10, authors: [{}, {}] }, { year: 2020, citations: 8, authors: [{}, {}, {}, {}] }];
	const empty = { year: 2020, citations: 50, authors: [] };
	const incomplete = { year: 2020, citations: 40, authors: [{}], authorListComplete: false };
	const m = M.compute([...known, empty, incomplete], 2025);
	assert.equal(m.perAuthorPapers, 2);
	assert.equal(m.papers, 4);
	assert.equal(m.citesPerAuthor, 5 + 2);
	assert.equal(m.authorsPerPaper, 3);
	assert.equal(m.hiNorm, 2);
	assert.equal(m.authorsUnknown, 2, "the empty and the incomplete list are counted as left out");
	assert.equal(m.citations, 108, "totals still count every paper");
});

test("a record with no authors field at all is an unknown author list too", () => {
	const m = M.compute([{ year: 2020, citations: 4 }], 2025);
	assert.equal(m.perAuthorPapers, 0);
	assert.equal(m.citesPerAuthor, null);
});

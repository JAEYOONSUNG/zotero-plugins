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

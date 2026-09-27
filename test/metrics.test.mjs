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

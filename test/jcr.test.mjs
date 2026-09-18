import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import J from "../content/jcr.js";
const require = createRequire(import.meta.url);
const S = require("../content/sources.js");

test("loads in Gecko without CommonJS", () => {
	const context = vm.createContext({ ZotPoPJCRData: [["Nature", "NATURE", "0028-0836", "1476-4687", 56.1]] });
	vm.runInContext(fs.readFileSync(new URL("../content/jcr.js", import.meta.url), "utf8"), context);
	assert.deepEqual(Object.keys(context.ZotPoPJCR), Object.keys(J));
	assert.equal(context.ZotPoPJCR.shared().find({ issn: "0028-0836" }).jif, 56.1);
});

test("the shipped table is the JCR 2026 release and answers by ISSN, title, abbreviation or alias", () => {
	const t = J.shared();
	assert.ok(t.size > 30000, "ISSN index built from the export");
	assert.equal(t.find({ issn: "0028-0836" }).jif, 56.1, "Nature by ISSN");
	assert.equal(t.find({ issns: ["1362-4962"] }).jif, 15, "Nucleic Acids Research by e-ISSN");
	assert.equal(t.find({ venue: "Nature Communications" }).jif, 18.1);
	assert.equal(t.find({ venue: "Nat. Commun." }).jif, 18.1, "the JCR abbreviation, punctuation aside");
	assert.equal(t.find({ venue: "Proceedings of the National Academy of Sciences" }).jif, 9.5, "Zotero's short PNAS title");
	assert.equal(t.find({ venue: "The ISME Journal" }).jif, 10.2, "a leading article is not part of the name");
	assert.equal(t.find({ venue: "eLife" }), null, "eLife left the JCR; no number is invented");
	assert.equal(t.find({ venue: "Some Obscure Bulletin" }), null);
	assert.equal(t.find(null), null);
});

test("apply fills the JIF and remembers where it came from; an unknown journal is left for the estimate", () => {
	const records = [{ venue: "Nature", issn: "0028-0836", journalIF: null }, { venue: "Some Obscure Bulletin", journalIF: null }];
	assert.equal(J.apply(records), 1);
	assert.equal(records[0].journalIF, 56.1);
	assert.equal(records[0].journalIFSource, J.EDITION);
	assert.equal(records[0].journalIFEstimate, false);
	assert.equal(records[0].journalAbbrev, "NATURE");
	assert.equal(records[1].journalIF, null);
});

test("in the metrics pass the JCR figure wins and OpenAlex only supplies the h-index or a marked estimate", async () => {
	const urls = [];
	const http = { async getJSON(url) { urls.push(new URL(url));
		return { results: [
			{ id: "https://openalex.org/S1", display_name: "Nature", issn: ["0028-0836"], summary_stats: { "2yr_mean_citedness": 49.9, h_index: 1600 } },
			{ id: "https://openalex.org/S9", display_name: "Some Obscure Bulletin", issn: ["1111-1111"], summary_stats: { "2yr_mean_citedness": 1.3, h_index: 5 } }
		] }; } };
	const records = [
		{ title: "a", venue: "Nature", issn: "0028-0836", journalId: "S1", journalIF: null, journalH: null },
		{ title: "b", venue: "Some Obscure Bulletin", issn: "1111-1111", journalId: "S9", journalIF: null, journalH: null }
	];
	await S.enrichJournalMetrics(records, http, {});
	assert.equal(records[0].journalIF, 56.1, "the JCR figure, not OpenAlex's 49.9");
	assert.equal(records[0].journalIFEstimate, false);
	assert.equal(records[0].journalH, 1600, "the h-index still comes from OpenAlex");
	assert.equal(records[1].journalIF, 1.3);
	assert.equal(records[1].journalIFEstimate, true, "an OpenAlex-only figure is marked as the estimate it is");
	// Switching the JCR off gives the old behaviour, for the tests that exercise it.
	const again = [{ title: "a", venue: "Nature", issn: "0028-0836", journalId: "S1", journalIF: null, journalH: null }];
	await S.enrichJournalMetrics(again, http, { jcr: false });
	assert.equal(again[0].journalIF, 49.9);
});

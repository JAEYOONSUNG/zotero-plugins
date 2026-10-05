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

// Rows exactly as a Journal Citation Reports export gives them. The plugin ships no
// such table: it is licensed to whoever subscribes, and is read at runtime from the
// reader's own folder in the Zotero data directory. These nine stand for that file.
const EXPORT = [
	["CA-A CANCER JOURNAL FOR CLINICIANS", "CA-CANCER J CLIN", "0007-9235", "1542-4863", 685.2],
	["NATURE", "NATURE", "0028-0836", "1476-4687", 56.1],
	["NUCLEIC ACIDS RESEARCH", "NUCLEIC ACIDS RES", "0305-1048", "1362-4962", 15],
	["Nature Communications", "NAT COMMUN", "", "2041-1723", 18.1],
	["PROCEEDINGS OF THE NATIONAL ACADEMY OF SCIENCES OF THE UNITED STATES OF AMERICA", "P NATL ACAD SCI USA", "0027-8424", "1091-6490", 9.5],
	["ISME Journal", "ISME J", "1751-7362", "1751-7370", 10.2],
	["Biotechnology for Biofuels and Bioproducts", "BIOTECHNOL BIOF BIOP", "", "2731-3654", 6],
	["MICROBIOLOGY-SGM", "MICROBIOL-SGM", "1350-0872", "1465-2080", 4.3],
	["ANGEWANDTE CHEMIE-INTERNATIONAL EDITION", "ANGEW CHEM INT EDIT", "1433-7851", "1521-3773", 17.6]
];

test("nothing is built in: the table is empty until the reader's own export is loaded", () => {
	assert.equal(J.shared().size, 0, "no licensed figure travels with the plugin");
	assert.equal(J.shared().find({ issn: "0028-0836" }), null);
	assert.equal(J.apply([{ venue: "Nature", issn: "0028-0836", journalIF: null }]), 0,
		"and an unmatched journal is left to the OpenAlex estimate");
});

test("a loaded export answers by ISSN, title, abbreviation or alias", () => {
	const t = J.load(EXPORT);
	assert.equal(t.find({ issn: "0028-0836" }).jif, 56.1, "Nature by ISSN");
	assert.equal(t.find({ issns: ["1362-4962"] }).jif, 15, "Nucleic Acids Research by e-ISSN");
	assert.equal(t.find({ venue: "Nature Communications" }).jif, 18.1);
	assert.equal(t.find({ venue: "Nat. Commun." }).jif, 18.1, "the JCR abbreviation, punctuation aside");
	assert.equal(t.find({ venue: "Proceedings of the National Academy of Sciences" }).jif, 9.5, "Zotero's short PNAS title");
	assert.equal(t.find({ venue: "The ISME Journal" }).jif, 10.2, "a leading article is not part of the name");
	assert.equal(t.find({ venue: "eLife" }), null, "a journal the export does not carry invents no number");
	assert.equal(t.find({ venue: "Biotechnology for Biofuels" }).name, "Biotechnology for Biofuels and Bioproducts", "a renamed journal answers under its current title");
	assert.equal(t.find({ venue: "Journal of General Microbiology" }).jif, 4.3);
	assert.equal(t.find({ venue: "Angewandte Chemie" }).jif, 17.6, "the German edition shares the International Edition's figure");
	assert.equal(t.find({ venue: "Some Obscure Bulletin" }), null);
	assert.equal(t.find(null), null);
});

test("apply fills the JIF and remembers where it came from; an unknown journal is left for the estimate", () => {
	const records = [{ venue: "Nature", issn: "0028-0836", journalIF: null }, { venue: "Some Obscure Bulletin", journalIF: null }];
	assert.equal(J.apply(records), 1);
	assert.equal(records[0].journalIF, 56.1);
	assert.equal(records[0].journalIFSource, J.EDITION);
	assert.equal(records[0].journalAbbrev, undefined, "the JCR's capitalised abbreviation is not copied onto the record");
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
	assert.equal(records[0].journalOA2y, 49.9, "OpenAlex's 2-year mean is kept in its own field beside the JIF");
	assert.equal(records[0].journalH, 1600, "the h-index still comes from OpenAlex");
	assert.equal(records[1].journalIF, null, "a journal outside the JCR has no JIF: OpenAlex's mean never stands in for it");
	assert.equal(records[1].journalOA2y, 1.3);
	// Switching the JCR off gives the old behaviour, for the tests that exercise it.
	const again = [{ title: "a", venue: "Nature", issn: "0028-0836", journalId: "S1", journalIF: null, journalH: null }];
	await S.enrichJournalMetrics(again, http, { jcr: false });
	assert.equal(again[0].journalIF, null);
	assert.equal(again[0].journalOA2y, 49.9);
});

test("a title shared by two different journals is ambiguous; an ISSN still decides", () => {
	const t = J.build([["MICROBIOLOGY", "MICROBIOLOGY+", "0026-2617", "1608-3237", 1.2], ["MICROBIOLOGY-SGM", "MICROBIOL-SGM", "1350-0872", "1465-2080", 2.8], ["Microbiology", "MICROBIOL", "1350-0872", "", 2.8], ["Microbiology", "MICROB X", "9999-0001", "", 1]]);
	assert.equal(t.find({ venue: "Microbiology" }), null);
	assert.equal(t.find({ venue: "Microbiology", issn: "1350-0872" }).jif, 2.8);
	assert.equal(t.find({ venue: "Microbiology-SGM" }).jif, 2.8);
});

test("the JCR label is the edition the reader's own file records, never a year built into the plugin (round 6)", () => {
	// A bare list of rows says nothing about its year: the label says JCR and no year.
	J.load(EXPORT);
	assert.equal(J.EDITION, "JCR", "no edition year is invented for a file that does not record one");
	assert.equal(J.edition().jcrYear, null);
	const plain = [{ venue: "Nature", issn: "0028-0836" }]; J.apply(plain);
	assert.equal(plain[0].journalIFSource, "JCR");
	// The file records its year: { jcrYear, rows } (the JIF year is the one before the release).
	J.load({ jcrYear: 2025, rows: EXPORT });
	assert.equal(J.EDITION, "JCR 2025 (JIF 2024)");
	const recs = [{ venue: "Nature", issn: "0028-0836" }]; J.apply(recs);
	assert.equal(recs[0].journalIFSource, "JCR 2025 (JIF 2024)");
	// only the JIF year given
	J.load({ jifYear: 2023, rows: EXPORT });
	assert.equal(J.EDITION, "JCR 2024 (JIF 2023)");
	// or the file name carries it: jcr-2026.json, JCR_2026.json
	J.load(EXPORT, { fileName: "jcr-2026.json" });
	assert.equal(J.EDITION, "JCR 2026 (JIF 2025)");
	J.load(EXPORT, { fileName: "JCR_2027.json" });
	assert.equal(J.EDITION, "JCR 2027 (JIF 2026)");
	// a year inside the file wins over one in its name; nonsense years are ignored
	J.load({ jcrYear: 2024, rows: EXPORT }, { fileName: "jcr-2026.json" });
	assert.equal(J.EDITION, "JCR 2024 (JIF 2023)");
	J.load({ jcrYear: "soon", rows: EXPORT });
	assert.equal(J.EDITION, "JCR");
	assert.equal(J.shared().find({ issn: "0028-0836" }).jif, 56.1, "the rows of an object-shaped file are read");
	// which file in the folder is read: the newest edition year, else jcr.json
	assert.equal(J.pickFile(["journal-registry.json", "jcr.json", "jcr-2024.json", "jcr-2026.json", "notes.txt"]), "jcr-2026.json");
	assert.equal(J.pickFile(["journal-registry.json", "jcr.json"]), "jcr.json");
	assert.equal(J.pickFile(["journal-registry.json"]), null);
	J.load([]);
});

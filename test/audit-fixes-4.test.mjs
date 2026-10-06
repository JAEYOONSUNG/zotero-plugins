import { test } from "node:test";
import assert from "node:assert/strict";
import { paper, uiHarness } from "./helpers/search-ui-harness.mjs";
import I18N from "../content/i18n.js";

const person = (name, position, institution, country, h, extra = {}) => ({ name, position, corresponding: false, institution, institutionId: "I" + institution, country, institutionH: h, ...extra });
const csvCells = line => line.match(/"(?:[^"]|"")*"/g).map(c => c.slice(1, -1).replace(/""/g, '"'));

test("CSV: first and corresponding author each carry their own institution, country and h-index", async () => {
	const ui = uiHarness({ realRows: true, search: async () => [paper("p", { people: [
		person("First A", "first", "Lab Alpha", "US", 100),
		person("Corr B", "last", "Lab Beta", "KR", 2300, { corresponding: true })] })] });
	await ui.runSearch();
	const lines = ui.csvText().split("\n");
	const head = I18N.STRINGS.en.csvHead, row = csvCells(lines[1]);
	const at = name => row[head.indexOf(name)];
	assert.equal(head.length, row.length);
	assert.equal(I18N.STRINGS.ko.csvHead.length, head.length, "Korean header has the same columns");
	assert.deepEqual([at("FirstAuthorInstitution"), at("FirstAuthorCountry"), at("FirstAuthorInstitutionHIndex")], ["Lab Alpha", "US", "100"]);
	assert.deepEqual([at("CorrespondingInstitution"), at("CorrespondingCountry"), at("CorrespondingInstitutionHIndex")], ["Lab Beta", "KR", "2300"]);
	assert.ok(!lines[1].includes('"US/KR"'), "no joined country list next to one institution");
});

test("enrichment that mutates the people list is seen by the table, sort and CSV", async () => {
	const people = [person("First A", "first", "Lab Alpha", "US", null)];
	const ui = uiHarness({ realRows: true, search: async () => [paper("p", { people })] });
	await ui.runSearch();
	assert.equal(ui.sortValue(ui.state.records[0], "tier"), -1);
	const before = ui.rowSignature(ui.state.records[0]);
	people[0].institutionH = 1800;   // what enrichInstitutions does, in place
	ui.displaySearchResults([paper("p", { people })]);
	const r = ui.state.records[0];
	assert.equal(ui.sortValue(r, "tier"), 1800);
	assert.notEqual(ui.rowSignature(r), before);
	assert.match(ui.csvText().split("\n")[1], /"Lab Alpha","US","1800"/);
});

test("rowSignature changes whenever a field buildRow reads changes", async () => {
	const people = [person("First A", "first", "Lab Alpha", "US", 100), person("Corr B", "last", "Lab Beta", "KR", 900, { corresponding: true })];
	const base = paper("p", { title: "T", venue: "Journal", publisher: "Pub", doi: "10.1/x", year: 2020, citations: 5, source: "openalex", sources: ["openalex"], people,
		journalIF: 3, journalOA2y: 2, journalH: 40, readState: "reading", inLibrary: true, pdfUrl: "https://x/y.pdf", retracted: false });
	const ui = uiHarness({ realRows: true, search: async () => [base] });
	await ui.runSearch();
	const rec = ui.state.records[0];
	// Which fields does buildRow read? Record them through a proxy.
	const read = new Set();
	const spy = new Proxy(rec, { get(t, k, rcv) { if (typeof k === "string") read.add(k); return Reflect.get(t, k, rcv); } });
	ui.buildRow(spy);
	ui.rowSignature(spy);
	for (const k of ["key", "authors", "people"]) read.delete(k);
	// The rank is rewritten on every draw of a kept row (perf-r16: "a row whose rank moves ... is kept").
	read.delete("rank");
	// Read only on hover or click, but part of what the row stands for (the source badge, the opened PDF).
	for (const k of ["source", "sources"]) read.add(k);   // identity / covered by the people summary below
	assert.ok(read.size > 15, "the spy saw the fields: " + [...read].join(","));
	const alter = v => typeof v === "number" ? v + 1 : typeof v === "boolean" ? !v : Array.isArray(v) ? [...v, "zz"] : v == null ? "changed" : String(v) + "~";
	const missing = [];
	for (const k of read) {
		const probe = Object.assign({}, rec, { [k]: alter(rec[k]) });
		if (ui.rowSignature(probe) === ui.rowSignature(rec)) missing.push(k);
	}
	assert.deepEqual(missing, [], "rowSignature ignores fields the row displays: " + missing.join(", "));
});

test("PubMed abstracts are fetched when the detail opens, once, never for the whole list", async () => {
	const calls = [];
	const fetchPubMedAbstracts = async (pmids) => { calls.push([...pmids]); return new Map(pmids.map(p => [p, "Abstract of " + p])); };
	const ui = uiHarness({ realRows: true, sources: { fetchPubMedAbstracts }, search: async () => [
		paper("a", { source: "pubmed", pmid: "1" }), paper("b", { source: "pubmed", pmid: "2" }), paper("c", { source: "openalex", abstract: "Has one" })] });
	await ui.runSearch();
	await new Promise(r => setTimeout(r, 20));
	assert.deepEqual(calls, [], "search results alone never prefetch abstracts");
	ui.state.detailKey = "a";
	ui.originalRenderDetail();
	await new Promise(r => setTimeout(r, 20));
	assert.deepEqual(calls, [["1"]]);
	assert.equal(ui.state.records[0].abstract, "Abstract of 1");
	assert.equal(ui.get("d-abstract").textContent, "Abstract of 1");
	ui.originalRenderDetail();
	await new Promise(r => setTimeout(r, 20));
	assert.equal(calls.length, 1, "an abstract already fetched is not fetched again");
	ui.state.detailKey = "c";
	ui.originalRenderDetail();
	await new Promise(r => setTimeout(r, 20));
	assert.equal(calls.length, 1, "a record that has an abstract needs no request");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import S from "../content/sources.js";

const provenance = (source = "crossref", extra = {}) => ({ engine: "publish-or-perish", source,
	profileId: "default", capturedAt: "2026-09-20T01:02:03.000Z", complete: true, cached: false,
	cancelled: false, outputSort: "title", query: { keywords: "geobacillus", engine: "pop" }, ...extra });
const noHTTP = { getJSON() { assert.fail("native PoP search must never request a direct API"); },
	getText() { assert.fail("native PoP search must never request Scholar HTML"); } };
const context = { journalMetrics: false, institutionMetrics: false, enrichCitations: false };

test("pop-equivalence projects every occurrence with original types, titleless rows and independent raw metadata", () => {
	const rows = [
		{ uid: "GS:12", doi: "10.1234/SAME", title: "A <i>precise</i> title", source: "Native journal", rank: 9,
			year: 0, cites: 0, volume: 0, issue: 0, startpage: 0, endpage: 0, type: "book-chapter",
			authors: [{ name: "Jane Example", affiliation: "Lab", ORCID: "0000-0002-1825-0097", extra: { roles: ["author"] } }, "..."],
			unknownNativeField: { values: [0, null, ""] } },
		{ doi: "10.1234/SAME", title: "A <i>precise</i> title", rank: 1, year: "2024", cites: "15", type: "dissertation",
			authors: [{ given: "Ada", family: "Lovelace", affiliation: ["Institute"] }] },
		{ rank: 0, title: 0, type: "preprint", authors: ["A Author…"] },
		{}
	];
	const evidence = provenance();
	const records = S.normalizePoPExactRecords(rows, "crossref", evidence);
	assert.equal(records.length, 4);
	assert.deepEqual(records.map(record => record.popOrdinal), [0, 1, 2, 3]);
	assert.deepEqual(records.map(record => record.popRank), [9, 1, 0, null]);
	assert.deepEqual(records.map(record => record.rank), [9, 1, 0, 4]);
	assert.deepEqual(records.map(record => record.title), ["A precise title", "A precise title", "0", ""]);
	assert.deepEqual(records.map(record => record.itemType), ["bookSection", "thesis", "preprint", "document"]);
	assert.equal(new Set(records.map(record => record.key)).size, 4);
	assert.deepEqual(records.map(record => record.popOriginal), rows);
	assert.deepEqual(records.map(record => record.source), Array(4).fill("crossref"));
	assert.equal(records[0].sourceId, "GS:12", "preserve native identifier prefixes independently of actual provider");
	assert.equal(records[0].doi, "10.1234/same");
	assert.deepEqual([records[0].year, records[0].citations, records[0].volume, records[0].issue, records[0].pages], [0, 0, "0", "0", "0"]);
	assert.deepEqual([records[1].year, records[1].citations], ["2024", "15"]);
	assert.equal(records[0].authors[1].name, "...");
	assert.equal(records[2].authors[0].name, "A Author…");
	assert.deepEqual(records[1].authors[0], { given: "Ada", family: "Lovelace", affiliation: ["Institute"], name: "Ada Lovelace", firstName: "Ada", lastName: "Lovelace" });
	assert.equal(records[0].authors[0].affiliation, "Lab");
	assert.deepEqual(records.popProvenance, evidence);
	records[0].authors[0].extra.roles.push("changed");
	records[0].popOriginal.unknownNativeField.values.push("changed");
	evidence.query.keywords = "changed externally";
	assert.deepEqual(rows[0].authors[0].extra.roles, ["author"]);
	assert.deepEqual(records[0].popOriginal.authors[0].extra.roles, ["author"]);
	assert.deepEqual(rows[0].unknownNativeField.values, [0, null, ""]);
	assert.equal(records.popProvenance.query.keywords, "geobacillus");
	assert.equal(records[0].popProvenance.query.keywords, "geobacillus");
	assert.notEqual(records[0].key, S.normalizePoPExactRecords(rows, "crossref", provenance("crossref", { capturedAt: "2026-09-20T02:00:00.000Z" }))[0].key);
});

test("pop-equivalence production route keeps native order and count without direct validation, filtering, sorting or enrichment", async () => {
	const rows = [{ title: "Z native", rank: 30, cites: 1, year: 1900, doi: "10.1234/a", authors: ["Other Person"] },
		{ title: "A native", rank: 10, cites: 999, year: 2024, doi: "10.1234/a" }, {}];
	const query = { engine: "pop", keywords: "operator:native", authors: "orcid:expression handled by PoP", title: "unmatched",
		yearFrom: 2030, yearTo: 2040, sort: "citations", popOutputSort: "title", maxResults: 1 };
	let invocations = 0; const snapshots = [];
	const ctx = { journalMetrics: true, institutionMetrics: true, enrichCitations: true,
		popSearch() { assert.fail("must not enter legacy Scholar pre-probe"); },
		async popSearchSource(source, nativeQuery, nativeContext) {
			invocations++; assert.equal(source, "crossref"); assert.deepEqual(nativeQuery, query); assert.equal(nativeContext, ctx);
			return { rows, provenance: provenance() };
		}, onResults(records, info) { snapshots.push({ records, info }); } };
	const records = await S.search("crossref", query, noHTTP, ctx);
	assert.equal(invocations, 1);
	assert.deepEqual(records.map(record => record.title), ["Z native", "A native", ""]);
	assert.deepEqual(records.map(record => record.rank), [30, 10, 3]);
	assert.equal(records.length, 3, "return CLI rows even when they exceed the user's requested cap");
	assert.equal(snapshots.length, 1);
	assert.deepEqual(snapshots[0].records.map(record => record.popOriginal), rows);
	assert.equal(snapshots[0].info.final, true);
	assert.equal(snapshots[0].info.engine, "pop");
	assert.deepEqual(ctx.popProvenance, provenance());
	assert.equal(ctx.sourceStatus.crossref.retrieved, 3);
	assert.deepEqual(ctx.errors, []);
});

test("pop-equivalence scientific title views retain inequalities and superscript meaning without unsafe elements", () => {
	const title = '<scp>Growth</scp> at p < 0.05 and q > 0.1 in <i><span class="scientific">x</span></i><jats:sup>2</jats:sup> &amp; H<sub class="index">2</sub>';
	const record = S.normalizePoPExactRecords([{ title }], "crossref", provenance())[0];
	assert.equal(record.title, "Growth at p < 0.05 and q > 0.1 in x2 & H2");
	assert.equal(record.titleMarkup, "Growth at p < 0.05 and q > 0.1 in <i>x</i><sup>2</sup> & H<sub>2</sub>");
	assert.equal(record.popOriginal.title, title);
});

test("pop-equivalence native types keep datasets and non-article records distinct from journal articles", () => {
	const types = ["dataset", "component", "grant", "peer-review", "reference-entry", "CITATION", "unknown", null,
		"journal-article", "Journal Article", "book-chapter", "dissertation", "posted-content", "report", "patent"];
	const rows = types.map(type => ({ title: "Native record", type }));
	const records = S.normalizePoPExactRecords(rows, "crossref", provenance());
	assert.deepEqual(records.map(record => record.itemType), ["dataset", "document", "document", "document", "document",
		"document", "document", "document", "journalArticle", "journalArticle", "bookSection", "thesis", "preprint", "report", "patent"]);
	assert.deepEqual(records.map(record => record.popType), types);
	assert.deepEqual(records.map(record => record.popOriginal), rows);
});

test("pop-equivalence registry maps every native provider and preserves actual source attribution", async () => {
	const flags = { scholar: "--gscholar", crossref: "--crossref", pubmed: "--pubmed", openalex: "--openalex",
		semanticscholar: "--semscholar", scholarauthor: "--gsauthor", scholarprofile: "--gsprofile", scholarciting: "--gsciting",
		hadb: "--hadb", lens: "--lens", scopus: "--scopus", wos: "--wos", wosexpanded: "--wosexpanded", wosstarter: "--wosstarter" };
	assert.deepEqual(Object.fromEntries(Object.entries(S.POP_SOURCES).map(([source, entry]) => [source, entry.flag])), flags);
	for (const source of Object.keys(flags)) {
		assert.ok(S.POP_SOURCES[source].label);
		const records = await S.search(source, { engine: "pop", popRaw: "literal native query", maxResults: 10000 }, noHTTP, {
			async popSearchSource(received) { assert.equal(received, source); return { rows: [{ title: "Native row", source: "Venue" }], provenance: provenance(source) }; }
		});
		assert.equal(records[0].source, source);
		assert.equal(records[0].venue, "Venue");
		assert.equal(records[0].popProvenance.source, source);
	}
});

test("pop-equivalence unsupported sources, unavailable tools and malformed envelopes fail without fallback", async () => {
	let calls = 0;
	const ctx = { async popSearchSource() { calls++; return { rows: [], provenance: provenance() }; } };
	for (const source of ["multi", "europepmc", "preprint", "arxiv", "osf", "unknown", "toString"]) {
		await assert.rejects(S.search(source, { engine: "pop", keywords: "query" }, noHTTP, ctx), /does not support/);
	}
	assert.equal(calls, 0);
	await assert.rejects(S.search("crossref", { engine: "unknown" }, noHTTP, ctx), /Unknown search engine/);
	await assert.rejects(S.search("crossref", { engine: "pop" }, noHTTP, {}), /unavailable/);
	for (const result of [null, [], { rows: [], provenance: provenance("pubmed") }, { rows: [], provenance: {} },
		{ rows: {}, provenance: provenance() }, { rows: [], provenance: provenance("crossref", { complete: undefined }) }]) {
		await assert.rejects(S.search("crossref", { engine: "pop" }, noHTTP, { popSearchSource: async () => result }), /Invalid Publish or Perish/);
	}
	for (const rows of [[null], [[]], [42], ["row"], {}]) {
		assert.throws(() => S.normalizePoPExactRecords(rows, "crossref", provenance()), /Invalid Publish or Perish/);
	}
	await assert.rejects(S.search("scholar", { engine: "pop" }, noHTTP, { popSearchSource: async () => { throw new Error("CLI source error"); } }), /CLI source error/);
});

test("pop-equivalence cancellation never publishes returned or invented rows", async () => {
	const alreadyAborted = new AbortController(); alreadyAborted.abort();
	await assert.rejects(S.search("crossref", { engine: "pop" }, noHTTP, { signal: alreadyAborted.signal,
		popSearchSource() { assert.fail("cancelled search cannot start a process"); } }), { name: "AbortError" });
	const controller = new AbortController();
	await assert.rejects(S.search("crossref", { engine: "pop" }, noHTTP, { signal: controller.signal,
		async popSearchSource() { controller.abort(); return { rows: [{ title: "Never publish" }], provenance: provenance() }; },
		onResults() { assert.fail("cancelled search cannot publish rows"); } }), { name: "AbortError" });
	await assert.rejects(S.search("crossref", { engine: "pop" }, noHTTP, {
		async popSearchSource() { return { rows: [{ title: "Cancelled transport" }], provenance: provenance("crossref", { cancelled: true }) }; },
		onResults() { assert.fail("a transport-marked cancellation cannot publish rows"); } }), { name: "AbortError" });
});

test("pop-equivalence explicitly retains partial and cached provenance without declaring it a fresh complete search", async () => {
	for (const [complete, cached] of [[false, false], [true, true]]) {
		let info;
		const ctx = { async popSearchSource() { return { rows: [{}], provenance: provenance("crossref", { complete, cached }) }; },
			onResults(_rows, details) { info = details; } };
		const records = await S.search("crossref", { engine: "pop" }, noHTTP, ctx);
		assert.equal(Boolean(records.partial), !complete);
		assert.equal(info.final, complete);
		assert.equal(records.popProvenance.cached, cached);
		assert.equal(ctx.sourceStatus.crossref.cached, cached);
	}
	const partialRows = [{}]; partialRows.partial = true;
	const ctx = { popSearchSource: async () => ({ rows: partialRows, provenance: provenance() }) };
	const records = await S.search("crossref", { engine: "pop" }, noHTTP, ctx);
	assert.equal(records.partial, true);
	assert.equal(ctx.sourceStatus.crossref.complete, false);
});

test("direct Crossref continues to deduplicate while native projection retains duplicate occurrences", async () => {
	const raw = { DOI: "10.1234/same", title: ["Same article"], author: [{ given: "A", family: "Author" }], issued: { "date-parts": [[2024]] } };
	const ctx = { ...context, popSearchSource() { assert.fail("direct engine must not call native PoP"); } };
	const records = await S.search("crossref", { engine: "direct", keywords: "article", maxResults: 2 }, {
		getJSON: async () => ({ message: { items: [raw, raw], "total-results": 2 } })
	}, ctx);
	assert.equal(records.length, 1);
	assert.equal(records[0].popOriginal, undefined);
	assert.equal(records[0].searchBackend, undefined);
});

test("direct Scholar parsing preserves every truncation marker instead of fabricating complete authors", () => {
	const html = '<div class="gs_r"><h3 class="gs_rt"><a href="https://example.org">Native article</a></h3><div class="gs_a">A Author, B Researcher…, ... - Journal, 2024 - publisher</div></div>';
	const rows = S.parseScholarPage(html, DOMParser);
	assert.deepEqual(rows[0].authors.map(author => author.name), ["A Author", "B Researcher…", "..."]);
});

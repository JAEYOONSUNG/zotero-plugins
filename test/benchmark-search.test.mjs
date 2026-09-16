import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assessReference, canonicalDOI, compareRecords, loadPoPReference, normalizedTitle, parsePoPReference } from "../scripts/lib/pop-reference.mjs";
import { createHTTPAdapter, evaluateCase, redactedURL, renderReport, runBenchmark } from "../scripts/benchmark-search.mjs";

const NOW = "2026-09-13T09:00:00.000Z";
const query = { keywords: "thermophile", maxResults: 30, sort: "relevance" };
const spec = { id: "topic", source: "scholar", kind: "topic", query };
const record = (n, extra = {}) => ({ title: `Thermophilic organism ${n}`, doi: `10.1234/${n}`, rank: n, year: 2020, authors: [{ name: "A Example" }], ...extra });
const rows = Array.from({ length: 30 }, (_, index) => record(index + 1));
const provenance = (extra = {}) => ({ tool: "Publish or Perish", source: "scholar", query, capturedAt: NOW, completed: true, ...extra });
const reference = (records = rows, extra = {}) => parsePoPReference({ records, provenance: provenance(extra) });
const helper = {
	matchesAuthor: (value, authors) => authors.some(author => String(author.name).includes(value)),
	matchesTitle: (value, title) => normalizedTitle(title).includes(normalizedTitle(value)),
	matchesVenue: (value, rec) => rec.venue === value,
	matchesRecord: () => true
};
const evaluate = (records = rows, options = {}, caseSpec = spec) => evaluateCase(caseSpec, { reference: reference(), records, now: NOW, timeZone: "UTC", queryHelper: helper, ...options });

test("real PoP BOM schema maps rank, source, DOI URLs, authors and query metadata", () => {
	const input = { $query: { $type: "PoPGScholar", KeyWords: "thermophile", QueryTime: Date.parse(NOW) / 1000,
		LastResult: 0, LastSubResult: 0, MaxResults: 30, YearFrom: 2015 }, $metrics: { papers_total: 2 }, $results: [
		{ rank: 2, title: "Second", source: "Nature", uid: "GS:2", article_url: "https://doi.org/10.1234/AbC", year: 2020, cites: 0, authors: ["A Author", { name: "B Author", affiliation: "School" }] },
		{ rank: 1, title: "First", source: "Science", uid: "GS:1", doi: "doi: 10.1234/FIRST" }
	] };
	const parsed = parsePoPReference("\uFEFF" + JSON.stringify(input));
	assert.equal(parsed.source, "scholar");
	assert.deepEqual(parsed.records.map(row => row.title), ["First", "Second"]);
	assert.equal(parsed.records[1].venue, "Nature");
	assert.equal(parsed.records[1].citations, 0);
	assert.equal(parsed.records[1].doi, "10.1234/abc");
	assert.equal(parsed.records[1].authors[1].name, "B Author");
	assert.equal(parsed.query.yearFrom, 2015);
	assert.equal(parsed.provenance.capturedAt, NOW);
});

test("raw PoP incomplete and cached evidence cannot pass as a fresh success", () => {
	const doc = { $query: { $type: "PoPGScholar", KeyWords: "thermophile", MaxResults: 30,
		QueryTime: Date.parse(NOW) / 1000, CacheTime: Date.parse("2025-01-01T00:00:00Z") / 1000,
		LastResult: 89, ErrorDetails: "Interrupted" }, $results: rows };
	const result = evaluate(rows, { reference: parsePoPReference(doc) });
	assert.equal(result.top.recall, 1);
	assert.equal(result.status, "fail");
	assert.ok(result.reasons.includes("stale-reference"));
	assert.ok(result.reasons.includes("incomplete-reference"));
});

test("raw PoP retrieval order cannot be inferred from result rank or output sort", () => {
	for (const [$type, source] of [["PoPGScholar", "scholar"], ["PoPOpenAlex", "openalex"], ["PoPPubMed", "pubmed"]]) {
		const doc = { $query: { $type, KeyWords: query.keywords, MaxResults: 30,
			QueryTime: Date.parse(NOW) / 1000, LastResult: 0, Sort: "rank" }, $results: rows };
		const parsed = parsePoPReference(doc);
		const result = evaluate(rows, { reference: parsed }, { ...spec, source });
		assert.equal(parsed.query.sort, undefined);
		assert.equal(result.top.recall, 1);
		assert.equal(result.status, "fail");
		assert.ok(result.reasons.includes("missing-reference-retrieval-order"));
	}
});

test("raw PoP retrieval order accepts only explicit verified provenance", async t => {
	const doc = { $query: { $type: "PoPOpenAlex", KeyWords: query.keywords, MaxResults: 30,
		QueryTime: Date.parse(NOW) / 1000, LastResult: 0, SortBy: "rank" }, $results: rows };
	const verification = { source: "openalex", retrievalOrder: { sort: "citations", verified: true, evidence: "Captured backend request has sort=cited_by_count:desc" } };
	const caseSpec = { ...spec, source: "openalex", query: { ...query, sort: "citations" } };
	for (const override of [undefined, { query: { sort: "citations" } }, { retrievalOrder: "citations" },
		{ ...verification, source: "pubmed" },
		{ ...verification, retrievalOrder: { ...verification.retrievalOrder, verified: false } },
		{ ...verification, retrievalOrder: { ...verification.retrievalOrder, evidence: " " } },
		{ ...verification, retrievalOrder: { ...verification.retrievalOrder, sort: "rank" } }]) {
		const parsed = parsePoPReference(doc, { provenance: override });
		assert.equal(evaluate(rows, { reference: parsed }, caseSpec).status, "fail");
	}
	const parsed = parsePoPReference(doc, { provenance: verification });
	assert.equal(evaluate(rows, { reference: parsed }, caseSpec).status, "pass");
	assert.deepEqual(parsed.provenance.retrievalOrder, verification.retrievalOrder);
	assert.equal(evaluate(rows, { reference: parsed }, { ...caseSpec, query }).status, "fail");
	const dir = await mkdtemp(join(tmpdir(), "zotpop-raw-order-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "raw.json");
	await writeFile(path, JSON.stringify(doc));
	assert.equal((await loadPoPReference(path)).query.sort, undefined);
	await writeFile(path + ".provenance.json", JSON.stringify(verification));
	assert.equal((await loadPoPReference(path)).query.sort, "citations");
	assert.equal((await loadPoPReference(path, { provenance: verification })).query.sort, "citations");
});

test("raw PoP additional query conditions cannot be silently discarded", () => {
	const doc = { $query: { $type: "PoPGScholar", Title: "thermophile", MaxResults: 30,
		QueryTime: Date.parse(NOW) / 1000, LastResult: 0 }, $results: rows };
	const caseSpec = { ...spec, query: { title: "thermophile", sort: "relevance", maxResults: 30 } };
	const override = { provenance: { retrievalOrder: { sort: "relevance", verified: true, evidence: "Captured Scholar query uses default relevance order" } } };
	const assess = metadata => assessReference(parsePoPReference({ ...doc, $query: { ...doc.$query, ...metadata } }, override), caseSpec, { now: NOW, timeZone: "UTC" });
	assert.equal(assess({}).comparable, true);
	for (const field of ["AllWords", "AnyWords", "ExactPhrase", "Affiliation"]) {
		const result = assess({ [field]: "unrepresented extra condition" });
		assert.equal(result.comparable, false);
		assert.ok(result.reasons.includes(`unsupported-raw-query-condition:${field}`));
	}
	assert.equal(assess({ AllWords: "   ", AnyWords: [], ExtraFlag: false }).comparable, true);
	const conflicting = parsePoPReference({ ...doc, $query: { ...doc.$query, KeyWords: "thermophile", Keywords: "hidden condition" } }, override);
	assert.ok(conflicting.unsupportedQueryFields.includes("Keywords"));
});

test("malformed, undocumented and bare array references are rejected", () => {
	for (const value of [[], { records: rows }, { records: rows, provenance: { tool: "ZotPoP" } }, { $query: {}, $results: "oops" }]) {
		assert.throws(() => parsePoPReference(value));
	}
	assert.throws(() => parsePoPReference({ records: [null], provenance: provenance() }));
});

test("CLI arrays require adjacent provenance and preserve the raw file hash", async t => {
	const dir = await mkdtemp(join(tmpdir(), "zotpop-benchmark-reference-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "results.json");
	await writeFile(path, "\uFEFF" + JSON.stringify(rows));
	await assert.rejects(loadPoPReference(path), /requires.*provenance/);
	await writeFile(path + ".provenance.json", JSON.stringify(provenance({ exitCode: 0, command: "pop --direct --format json" })));
	const result = await loadPoPReference(path);
	assert.equal(result.records.length, 30);
	assert.match(result.provenance.sha256, /^[0-9a-f]{64}$/);
	assert.equal(result.provenance.path, path);
	assert.equal(assessReference(result, spec, { now: NOW, timeZone: "UTC" }).comparable, true);
});

test("DOI canonicalization is strict and preserves different explicit DOI identities", () => {
	assert.equal(canonicalDOI("https://doi.org/10.1234/A%28B%29?download=1"), "10.1234/a(b)");
	assert.equal(canonicalDOI("some DOI 10.1234/a"), null);
	const result = compareRecords([record(1)], [record(2, { title: record(1).title })]);
	assert.equal(result.matched, 0);
	assert.equal(result.identityConflicts.length, 1);
	assert.equal(result.identityConflicts[0].reason, "different-explicit-dois");
});

test("DOI matches are reserved before title matches and ambiguous title bridges are rejected", () => {
	const refs = [record(1, { doi: null }), record(2, { title: record(1).title })];
	const candidates = [record(2, { title: record(1).title }), record(1, { doi: null })];
	const result = compareRecords(refs, candidates);
	assert.deepEqual(result.matches.map(value => [value.referenceIndex, value.candidateIndex, value.method]), [[0, 1, "exact-title"], [1, 0, "doi"]]);
	const ambiguous = compareRecords([record(1), record(2, { title: record(1).title })], [record(1, { doi: null })]);
	assert.equal(ambiguous.matched, 0);
});

test("exact normalized title matches punctuation but never fuzzy or conflicting-year titles", () => {
	assert.equal(compareRecords([{ title: "CRISPR–Cas9-assisted editing." }], [{ title: "CRISPR Cas9 assisted editing" }]).matched, 1);
	assert.equal(compareRecords([{ title: "Editing is effective" }], [{ title: "Editing is not effective" }]).matched, 0);
	assert.equal(compareRecords([{ title: "A+ channel" }], [{ title: "A− channel" }]).matched, 0);
	assert.equal(compareRecords([{ title: "Dose -1 affects growth" }], [{ title: "Dose 1 affects growth" }]).matched, 0);
	assert.equal(compareRecords([{ title: "Dose 1.5 affects growth" }], [{ title: "Dose 15 affects growth" }]).matched, 0);
	assert.equal(compareRecords([{ title: "CD4- cells" }], [{ title: "CD4 cells" }]).matched, 0);
	assert.equal(compareRecords([{ title: "Editorial", year: 2014 }], [{ title: "Editorial", year: 2024 }]).matched, 0);
	assert.equal(compareRecords([{ title: "Same long scientific paper title", pmid: "1" }], [{ title: "Same long scientific paper title", pmid: "2" }]).matched, 0);
});

test("one-to-one overlap cannot be inflated by duplicate candidate rows", () => {
	const result = compareRecords([record(1), record(2)], [record(1), record(1), record(1)]);
	assert.equal(result.matched, 1);
	assert.equal(result.recall, 0.5);
	assert.equal(result.candidateOverlap, 1 / 3);
});

test("recall uses first ten PoP ranks within first thirty candidates, separately from full overlap", () => {
	const candidates = [...rows.slice(10, 30), ...rows.slice(0, 9), record(100), rows[9]];
	const result = evaluate(candidates);
	assert.equal(result.top.recall, 0.9);
	assert.equal(result.status, "pass");
	assert.equal(result.full.matched, 29);
	assert.equal(result.full.recall, 29 / 30);
	assert.equal(result.counts.candidateRaw, 31);
	assert.equal(result.counts.candidateCompared, 30);
	assert.equal(result.precision.precision, null);
	assert.equal(evaluate([...rows.slice(10, 30), ...rows.slice(0, 8), record(100), record(101), rows[8], rows[9]]).status, "fail");
});

test("oversized PoP response is cropped at the submitted cap", () => {
	const result = evaluate(rows, { reference: reference([...rows, record(31), record(32)]) });
	assert.equal(result.counts.referenceRaw, 32);
	assert.equal(result.counts.referenceCompared, 30);
	assert.equal(result.full.recall, 1);
});

test("missing, empty, stale, future, incomplete or incomparable references cannot pass", () => {
	for (const [ref, reason] of [
		[null, "missing-reference"], [reference([]), "empty-reference"],
		[reference(rows, { capturedAt: "2026-09-12T22:00:00Z" }), "stale-reference"],
		[reference(rows, { capturedAt: "2026-09-14T09:00:00Z" }), "future-reference-time"],
		[reference(rows, { capturedAt: null }), "missing-reference-time"],
		[reference(rows, { completed: false }), "incomplete-reference"],
		[reference(rows, { source: "openalex" }), "different-source"],
		[reference(rows, { query: { ...query, maxResults: undefined } }), "missing-reference-cap"],
		[reference(rows, { query: { ...query, maxResults: 100 } }), "different-query:maxResults"],
		[reference(rows, { query: { ...query, keywords: "unrelated" } }), "different-query:keywords"],
		[reference(rows, { query: { ...query, includePatents: true } }), "different-query:includePatents"]
	]) {
		const result = evaluate(rows, { reference: ref });
		assert.equal(result.status, "fail", reason);
		assert.ok(result.reasons.includes(reason), JSON.stringify(result.reasons));
	}
});

test("partial service errors and empty candidates fail independently of overlap", () => {
	const result = evaluate(rows, { errors: [Object.assign(new Error("CAPTCHA"), { status: 403 })] });
	assert.equal(result.top.recall, 1);
	assert.ok(result.reasons.includes("candidate-errors"));
	assert.equal(result.errors[0].status, 403);
	assert.ok(evaluate([]).reasons.includes("empty-candidate"));
	assert.ok(evaluate([null, ...rows]).reasons.includes("invalid-candidate-record"));
});

test("expected target matching cannot accept a same-title wrong DOI", () => {
	const caseSpec = { ...spec, kind: "known-paper", expectedTitles: [record(1).title] };
	const result = evaluate([record(99, { title: record(1).title }), ...rows.slice(1)], {}, caseSpec);
	assert.equal(result.top.recall, 0.9);
	assert.equal(result.expectedTargets[0].found, false);
	assert.ok(result.reasons.includes("expected-target-missing"));
	assert.equal(evaluate(rows, {}, { ...spec, expectedDois: ["bad"] }).expectedTargets[0].found, false);
	assert.ok(evaluate(rows, {}, { ...spec, kind: "known-paper" }).reasons.includes("missing-expected-target"));
});

test("author, journal and year field violations use the shared query helper", () => {
	const fieldQuery = { ...query, authors: "A Example", venue: "Nature", yearFrom: 2018, yearTo: 2024 };
	const caseSpec = { ...spec, kind: "author", query: fieldQuery };
	const candidates = rows.map(row => ({ ...row, venue: "Nature" }));
	candidates[0] = { ...candidates[0], authors: [{ name: "Other Person" }], venue: "Science", year: 2000 };
	const result = evaluate(candidates, { reference: reference(rows, { query: fieldQuery }) }, caseSpec);
	assert.equal(result.top.recall, 1);
	assert.deepEqual(result.fields.violations[0].fields, ["authors", "venue", "yearFrom"]);
	assert.ok(result.reasons.includes("field-violations"));
	assert.ok(evaluate(candidates, { reference: reference(rows, { query: fieldQuery }), queryHelper: null }, caseSpec).reasons.includes("field-check-unavailable"));
});

test("precision is measured only from explicit human judgements", () => {
	const caseSpec = { ...spec, relevanceJudgements: rows.map((row, index) => ({ ...row, relevant: index < 24, judgedBy: "reviewer", judgedAt: NOW })) };
	assert.equal(evaluate(rows, {}, caseSpec).precision.precision, 0.8);
	const partial = evaluate(rows, {}, { ...caseSpec, relevanceJudgements: caseSpec.relevanceJudgements.slice(0, 1) });
	assert.equal(partial.precision.precision, null);
	assert.equal(partial.precision.precisionOnJudged, 1);
});

test("truncated Scholar author and journal fields remain unverifiable instead of known mismatches", () => {
	const q = { ...query, authors: "A Example", venue: "Nucleic Acids Research" };
	const caseSpec = { ...spec, query: q };
	const candidates = rows.map(row => ({ ...row, authors: [{ name: "B Other" }, { name: "..." }], venue: "Nucleic acids …" }));
	const result = evaluate(candidates, { reference: reference(candidates, { query: q }) }, caseSpec);
	assert.equal(result.status, "pass");
	assert.equal(result.fields.violations.length, 0);
	assert.equal(result.fields.unverifiableFields.length, 30);
	assert.equal(result.fields.verifiedRecords, 0);
	assert.deepEqual(result.fields.unverifiableFields[0].fields, ["authors", "venue"]);
	assert.equal(result.precision.precision, null);
	const definite = [...candidates]; definite[0] = { ...definite[0], authors: [{ name: "B Other" }], venue: "Nature" };
	assert.equal(evaluate(definite, { reference: reference(candidates, { query: q }) }, caseSpec).status, "fail");
});

test("HTTP adapter preserves timing, HTTP failures and signal cancellation without network", async () => {
	const requests = [];
	const http = createHTTPAdapter({ requests, fetchImpl: async () => new Response('{"answer":42}', { status: 200 }) });
	assert.deepEqual(await http.getJSON("https://example.org/works?api_key=secret&mailto=a@b.test"), { answer: 42 });
	assert.equal(requests[0].status, 200);
	assert.equal(requests[0].bytes, 13);
	assert.ok(requests[0].latencyMs >= 0);
	assert.ok(!requests[0].url.includes("secret"));
	assert.ok(!redactedURL("https://name:password@example.org/?token=secret").includes("password"));
	const failed = createHTTPAdapter({ requests, fetchImpl: async () => new Response("blocked", { status: 429 }) });
	await assert.rejects(failed.getJSON("https://example.org/"), error => error.status === 429);
	assert.equal(requests[1].error.status, 429);
	const controller = new AbortController(); controller.abort();
	const aborted = createHTTPAdapter({ signal: controller.signal, fetchImpl: async (url, options) => { options.signal.throwIfAborted(); } });
	await assert.rejects(aborted.getText("https://example.org/"), { name: "AbortError" });
});

async function fixtureConfig(t, source = "scholar") {
	const dir = await mkdtemp(join(tmpdir(), "zotpop-benchmark-runner-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "reference.json"), JSON.stringify({ records: rows, provenance: provenance({ source }) }));
	return { dir, config: { cases: [{ ...spec, source, referencePath: "reference.json" }] } };
}

test("runner uses injected sources and reports requests, progressive timing and partial errors", async t => {
	const { dir, config } = await fixtureConfig(t);
	const result = await runBenchmark(config, { baseDir: dir, now: NOW, queryHelper: helper,
		fetchImpl: async () => new Response("[]", { status: 200 }), sources: {
			async search(source, suppliedQuery, http, ctx) {
				assert.equal(source, "scholar"); assert.deepEqual(suppliedQuery, query);
				assert.equal(ctx.enrichCitations, false); assert.equal(ctx.journalMetrics, false);
				await http.getJSON("https://example.org/search");
				ctx.onResults(rows.slice(0, 10), { final: false });
				ctx.errors = ["one source unavailable"];
				return rows;
			}
		} });
	assert.equal(result.cases[0].requests.length, 1);
	assert.ok(result.cases[0].firstResultMs >= 0);
	assert.equal(result.summary.passed, 0);
	assert.equal(result.cases[0].retrievalStatus, "error");
	assert.match(renderReport(result), /not relevance precision/);
});

test("offline candidate provenance is required and no live call is made", async t => {
	const { dir, config } = await fixtureConfig(t);
	const options = { baseDir: dir, now: NOW, queryHelper: helper, sources: { search() { throw new Error("must not be called"); } } };
	const candidate = { records: rows, source: "scholar", query, capturedAt: NOW, status: "complete", errors: [], requests: [], latencyMs: 42 };
	const result = await runBenchmark(config, { ...options, offlineCandidates: { topic: candidate } });
	assert.equal(result.summary.allCasesPass, true);
	assert.equal(result.summary.parityEstablished, false);
	assert.equal(result.cases[0].latencyMs, 42);
	assert.equal(result.cases[0].mode, "recorded");
	const undocumented = await runBenchmark(config, { ...options, offlineCandidates: { topic: rows } });
	assert.equal(undocumented.summary.passed, 0);
	assert.ok(undocumented.cases[0].reasons.includes("recorded-candidate:missing-reference-time"));
});

test("CLI supports baseline sources module and injected DOM parser without live network", async t => {
	const { dir, config } = await fixtureConfig(t);
	const fresh = provenance({ capturedAt: new Date().toISOString() });
	await writeFile(join(dir, "reference.json"), JSON.stringify({ records: rows, provenance: fresh }));
	await writeFile(join(dir, "config.json"), JSON.stringify(config));
	await writeFile(join(dir, "baseline.cjs"), `module.exports = {search: async (source,q,http,ctx) => { if (!ctx.DOMParser) throw new Error('parser missing'); return ${JSON.stringify(rows)}; }};`);
	const output = join(dir, "out");
	const { stdout } = await promisify(execFile)(process.execPath, [resolve("scripts/benchmark-search.mjs"), "--config", join(dir, "config.json"), "--out", output,
		"--sources-module", join(dir, "baseline.cjs"), "--dom-parser-module", "linkedom"]);
	assert.equal(JSON.parse(stdout).allCasesPass, true);
	assert.equal(JSON.parse(await readFile(join(output, "report.json"), "utf8")).sourcesModule, join(dir, "baseline.cjs"));
	assert.match(await readFile(join(output, "report.md"), "utf8"), /1\/1 cases pass/);
});

test("invalid configs and thresholds fail closed", async () => {
	assert.throws(() => evaluate(rows, { thresholds: { candidateTopK: 0 } }), /Invalid threshold/);
	assert.throws(() => evaluate(rows, { thresholds: { minReferenceRecall: NaN } }), /Invalid minReferenceRecall/);
	await assert.rejects(runBenchmark({ cases: [] }), /nonempty/);
	await assert.rejects(runBenchmark({ cases: [spec, spec] }), /unique/);
});

test("installed PoP transport is opt-in, traced and labelled as integration fidelity", async t => {
	const { dir, config } = await fixtureConfig(t);
	let bridgeCalls = 0;
	const popBridge = { async search(suppliedQuery, ctx) {
		bridgeCalls++;
		assert.deepEqual(suppliedQuery, query);
		assert.equal(ctx.popExecutable, "/fake/pop");
		assert.equal(ctx.popDataDir, "/fake/data");
		assert.ok(ctx.signal);
		return rows;
	} };
	const sources = { async search(source, suppliedQuery, http, ctx) { return ctx.popSearch(suppliedQuery); } };
	const result = await runBenchmark(config, { baseDir: dir, now: NOW, queryHelper: helper,
		sources, popExecutable: "/fake/pop", popDataDir: "/fake/data", popBridge });
	assert.equal(bridgeCalls, 1);
	assert.equal(result.cases[0].transport, "installed-publish-or-perish");
	assert.equal(result.cases[0].requests[0].method, "CLI");
	assert.equal(result.cases[0].requests[0].status, "complete");
	assert.match(renderReport(result), /does not establish independent scraper parity/);
	const baseline = await runBenchmark(config, { baseDir: dir, now: NOW, queryHelper: helper,
		sources: { search: async () => rows }, popExecutable: "/fake/pop", popBridge });
	assert.equal(bridgeCalls, 1);
	assert.equal(baseline.cases[0].transport, "direct");
});

test("aborted sources cannot turn partial results into successful evidence", async t => {
	const { dir, config } = await fixtureConfig(t);
	config.timeoutMs = 10;
	const report = await runBenchmark(config, { baseDir: dir, now: NOW, queryHelper: helper, sources: {
		async search(source, q, http, ctx) {
			await new Promise(resolve => ctx.signal.addEventListener("abort", resolve, { once: true }));
			return rows;
		}
	} });
	assert.equal(report.summary.passed, 0);
	assert.ok(report.cases[0].reasons.includes("candidate-aborted"));
	assert.equal(report.cases[0].retrievalStatus, "error");
});

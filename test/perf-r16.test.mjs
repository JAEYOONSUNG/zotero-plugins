// Round 16: what a search costs, counted rather than timed, so the checks hold on a busy machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import S from "../content/sources.js";
import { uiHarness, paper } from "./helpers/search-ui-harness.mjs";

const require = createRequire(import.meta.url);
const Query = require("../content/query.js");
const quiet = { journalMetrics: false, institutionMetrics: false, enrichCitations: false };
const oaWork = n => ({ id: "https://openalex.org/W" + n, doi: "https://doi.org/10.5555/w" + n, title: "Genome editing method " + n + " for plants",
	publication_year: 2000 + (n % 25), cited_by_count: n % 97, abstract_inverted_index: { genome: [0], editing: [1] } });
const openAlexPages = (total, log = []) => ({ getJSON: async url => {
	log.push(url);
	const u = new URL(url), per = Number(u.searchParams.get("per-page")), page = Number(u.searchParams.get("page"));
	const from = (page - 1) * per;
	return { meta: { count: total }, results: Array.from({ length: Math.max(0, Math.min(per, total - from)) }, (_, i) => oaWork(from + i)) };
} });

test("relevance order reads each title's identity a bounded number of times, not once per comparison", async () => {
	const real = Query.titleIdentity;
	let calls = 0;
	Query.titleIdentity = value => { calls++; return real(value); };
	try {
		// A combined search orders by fused rank, with a title equal to the query first.
		const records = await S.search("multi", { keywords: "genome editing method 7 for plants", sources: ["openalex"], maxResults: 1000 }, openAlexPages(1000), quiet);
		assert.equal(records.length, 1000);
		assert.equal(records[0].title, "Genome editing method 7 for plants", "the exact title still leads");
	} finally { Query.titleIdentity = real; }
	// Each of five pages is merged, matched, sorted and linked over everything found so far (200 + 400 + ... + 1,000
	// titles, six passes: 18,000 calls, deterministic). Asked inside the comparator it was 26,316.
	assert.ok(calls <= 20000, "titleIdentity calls: " + calls);
});

test("one combined search sends each OpenAlex request once, however deep it pages", async () => {
	S.clearWorkCache();
	const log = [];
	// Only every fourth paper names the keyword, so OpenAlex is paged well past its first pool.
	const http = { getJSON: async url => {
		log.push(url);
		const u = new URL(url), per = Number(u.searchParams.get("per-page")), page = Number(u.searchParams.get("page"));
		const from = (page - 1) * per;
		return { meta: { count: 5000 }, results: Array.from({ length: per }, (_, i) => {
			const n = from + i, w = oaWork(n);
			if (n % 4) { w.title = "Unrelated record " + n; w.abstract_inverted_index = { unrelated: [0], record: [1] }; }
			return w;
		}) };
	} };
	const records = await S.search("multi", { keywords: "genome editing", sources: ["openalex"], maxResults: 200 }, http, { ...quiet });
	assert.equal(records.length, 200);
	const works = log.filter(u => u.startsWith("https://api.openalex.org/works?"));
	assert.ok(works.length >= 4, "paged past the first pool: " + works.length);
	assert.equal(new Set(works).size, works.length, "every page asked once: " + works.map(u => new URL(u).searchParams.get("page")).join(","));
});

test("a typed journal and author are resolved on OpenAlex once, and the next search reuses the answer", async () => {
	S.clearWorkCache();
	const log = [];
	const http = { getJSON: async url => {
		log.push(url);
		if (url.includes("/sources?search=")) return { results: [{ id: "https://openalex.org/S1", display_name: "Plant Journal" }] };
		if (url.includes("/authors?search=")) return { meta: { count: 2 }, results: [{ id: "https://openalex.org/A1", display_name: "Mina Kim" }, { id: "https://openalex.org/A2", display_name: "Mina Kim" }] };
		return { meta: { count: 3 }, results: [oaWork(1), oaWork(2), oaWork(3)] };
	} };
	const q = { keywords: "genome editing", venue: "Plant Journal", authors: "Mina Kim", maxResults: 50 };
	const ctx1 = { ...quiet }, ctx2 = { ...quiet };
	await S.search("openalex", q, http, ctx1);
	const first = log.length;
	await S.search("openalex", q, http, ctx2);
	const second = log.slice(first);
	assert.equal(second.filter(u => /\/(sources|authors)\?search=/.test(u)).length, 0, "no name lookup again: " + second.join(" "));
	assert.equal(second.filter(u => u.includes("/works?")).length, 1, "the search itself is still asked");
	assert.ok(second.every(u => !u.includes("/works?") || u.includes("authorships.author.id:A1|A2") && u.includes("primary_location.source.id:S1")), "the same filters");
	// The answer is reused, not its consequences dropped: the two people behind the name are still named.
	assert.ok(ctx2.errors.some(e => /2 author profiles match/.test(e)), ctx2.errors.join(" / "));
	S.clearWorkCache();
	await S.search("openalex", q, http, { ...quiet });
	assert.equal(log.slice(first + second.length).filter(u => /\/(sources|authors)\?search=/.test(u)).length, 2, "cleared, it asks again");
});

test("a failed lookup is not kept: the next search asks again", async () => {
	S.clearWorkCache();
	let tries = 0;
	const http = { getJSON: async url => {
		if (url.includes("/sources?search=")) { tries++; if (tries === 1) throw Object.assign(new Error("HTTP 404"), { status: 404 }); return { results: [{ id: "https://openalex.org/S1", display_name: "Plant Journal" }] }; }
		return { meta: { count: 1 }, results: [oaWork(1)] };
	} };
	const q = { keywords: "genome editing", venue: "Plant Journal", maxResults: 10 };
	await assert.rejects(S.search("openalex", q, http, { ...quiet }));
	await S.search("openalex", q, http, { ...quiet });
	assert.equal(tries, 2);
});

test("keyword matching gives the same answer read field by field", () => {
	const terms = S.keywordTerms("genome editing delivery");
	const cases = [
		{ title: "Genome-wide screens", abstract: "" },
		{ title: "", abstract: "Delivery of &lt;i&gt;Cas9&lt;/i&gt; ribonucleoproteins" },
		{ title: "Editing <i>in vivo</i>", abstract: "Nothing else" },
		{ title: "Unrelated", abstract: "Unrelated text about rocks" },
		{ title: "Unrelated genome", abstract: null }
	];
	assert.deepEqual(cases.map(r => S.matchesKeywords(terms, r)), [true, true, true, false, true]);
});

// ---------------------------------------------------------------- the list while results stream in
const streamed = (keys, extra = {}) => keys.map(k => paper(k, { title: "Paper " + k, doi: "10.5555/" + k, ...extra }));

test("a row whose rank moves while results stream in is kept and its rank cell rewritten, not rebuilt", () => {
	const ui = uiHarness({ realRows: true, columns: true });
	ui.state.searching = true;
	ui.displaySearchResults(streamed(["a", "b", "c"]));
	const rows = () => Object.fromEntries(ui.get("results-body").children.map(tr => [tr.dataset.key, tr]));
	const before = rows(), created = ui.counts.created;
	ui.displaySearchResults(streamed(["c", "a", "b"]));
	const after = rows();
	for (const k of ["a", "b", "c"]) assert.ok(after[k] === before[k], k + " is the same row");
	assert.equal(ui.counts.created, created, "no element created");
	const rank = tr => tr.children.find(c => c.dataset.k === "rank").textContent;
	assert.deepEqual(["c", "a", "b"].map(k => rank(after[k])), ["1", "2", "3"]);
});

test("a row that drops out of one streamed batch and comes back in the next is the same row", () => {
	const ui = uiHarness({ realRows: true, columns: true });
	ui.state.searching = true;
	ui.displaySearchResults(streamed(["a", "b", "c"]));
	const first = ui.get("results-body").children.find(tr => tr.dataset.key === "b");
	ui.displaySearchResults(streamed(["a", "c"]));
	ui.displaySearchResults(streamed(["a", "b", "c"]));
	assert.ok(ui.get("results-body").children.find(tr => tr.dataset.key === "b") === first, "the same row");
	// Once the search is over, rows of papers it no longer holds are let go.
	ui.state.searching = false;
	ui.displaySearchResults(streamed(["a"]));
	ui.displaySearchResults(streamed(["a", "b"]));
	assert.ok(ui.get("results-body").children.find(tr => tr.dataset.key === "b") !== first, "a new row");
});

test("a combined search draws one snapshot per stream frame, not one per page of every source, and none after it ends", async () => {
	const pages = { n: 0 };
	const http = {
		getJSON: async url => {
			pages.n++;
			const u = new URL(url);
			if (u.host === "api.openalex.org") {
				const per = Number(u.searchParams.get("per-page")), page = Number(u.searchParams.get("page"));
				return { meta: { count: 9000 }, results: Array.from({ length: per }, (_, i) => oaWork((page - 1) * per + i)) };
			}
			if (u.host === "api.crossref.org") {
				const rows = Number(u.searchParams.get("rows")), offset = Number(u.searchParams.get("offset"));
				return { message: { "total-results": 9000, items: Array.from({ length: rows }, (_, i) => ({ DOI: "10.5555/c" + (offset + i), title: ["Genome editing note " + (offset + i)], type: "journal-article", issued: { "date-parts": [[2020]] } })) } };
			}
			const size = Number(u.searchParams.get("pageSize")), cursor = u.searchParams.get("cursorMark"), start = cursor === "*" ? 0 : Number(cursor.slice(1));
			return { hitCount: 9000, nextCursorMark: "c" + (start + size), resultList: { result: Array.from({ length: size }, (_, i) => ({ id: "E" + (start + i), source: "MED", title: "Genome editing trial " + (start + i), pubYear: "2021" })) } };
		}
	};
	const published = [];
	const records = await S.search("multi", { keywords: "genome editing", sources: ["openalex", "crossref", "europepmc"], maxResults: 2000 }, http,
		{ ...quiet, onResults: (rows, info) => published.push({ n: rows.length, final: info?.final }) });
	const streamed = published.filter(p => !p.final);
	assert.equal(records.length, 2000);
	assert.ok(pages.n >= 15, "pages: " + pages.n);
	assert.ok(streamed.length <= pages.n / 2, streamed.length + " snapshots for " + pages.n + " pages");
	const after = published.length;
	await new Promise(r => setTimeout(r, 300));
	assert.equal(published.length, after, "no snapshot after the search returned");
	assert.equal(published.at(-1).final, true);
});

test("a folded-away detail pane asks the network for nothing; shown again, it asks for the row it holds", async () => {
	const calls = [];
	const fetchPubMedAbstracts = async pmids => { calls.push([...pmids]); return new Map(pmids.map(p => [p, "Abstract of " + p])); };
	const ui = uiHarness({ realRows: true, sources: { fetchPubMedAbstracts }, search: async () => [paper("a", { source: "pubmed", pmid: "1" }), paper("b", { source: "pubmed", pmid: "2" })] });
	await ui.runSearch();
	ui.setDetailVisible(false);
	for (const key of ["a", "b"]) { ui.state.detailKey = key; ui.originalRenderDetail(); }
	await new Promise(r => setTimeout(r, 20));
	assert.deepEqual(calls, [], "nothing asked while hidden");
	ui.setDetailVisible(true);
	ui.originalRenderDetail(); // the harness stubs the redraw setDetailVisible makes
	await new Promise(r => setTimeout(r, 20));
	assert.deepEqual(calls, [["2"]], "only the row the pane holds, once it shows");
});

// ---------------------------------------------------------------- races (Astra round 16)
test("A, then B and C pressed while A stops: C runs, B steps aside, and the rows are C's", async () => {
	const started = [];
	const ui = uiHarness({ search: (_s, q, _h, ctx) => new Promise((resolve, reject) => {
		started.push(q.keywords);
		const done = () => resolve([paper(q.keywords + "-1")]);
		if (q.keywords === "A") ctx.signal.addEventListener("abort", () => setTimeout(() => reject(Object.assign(new Error("stopped"), { name: "AbortError" })), 10));
		else setTimeout(done, 5);
	}) });
	ui.get("keywords").value = "A"; const a = ui.runSearch();
	await new Promise(r => setTimeout(r, 5));
	ui.get("keywords").value = "B"; const b = ui.runSearch();
	ui.get("keywords").value = "C"; const c = ui.runSearch();
	await Promise.all([a, b, c]);
	assert.deepEqual(started, ["A", "C"]);
	assert.deepEqual(ui.state.records.map(r => r.key), ["C-1"]);
});

test("Clear while a finished search reads its history leaves the table empty", async () => {
	let release;
	const gate = new Promise(r => { release = r; });
	const ui = uiHarness({ search: async () => [paper("x"), paper("y")] });
	const realPrevious = ui.history.previousKeys;
	ui.history.previousKeys = async (...args) => { await gate; return realPrevious(...args); };
	const run = ui.runSearch();
	await new Promise(r => setTimeout(r, 10));
	ui.clearAll();
	release();
	await run;
	assert.equal(ui.state.records.length, 0);
});

test("another version's library lookup that answers after the library changed is dropped", async () => {
	let answer;
	const lookups = [];
	const importer = { findByTitle: (lib, title) => { lookups.push(lib); return title === "Old" ? new Promise(r => { answer = r; }) : Promise.resolve(null); },
		getLibraryDOIMap: async () => new Map(), forgetTitleIndex() {} };
	const ui = uiHarness({ importer });
	ui.state.libraryID = 1;
	let redraws = 0;
	const to = { title: "Old", year: 2020, doi: null };
	assert.equal(ui.heldVersion(to, () => redraws++), false);
	await ui.refreshLibraryFlags();
	answer(101);
	await new Promise(r => setTimeout(r, 5));
	assert.equal(redraws, 0, "no redraw for the other library");
	assert.equal(ui.state.heldVersions.has("t:Old|2020"), false, "nothing kept for the library now shown");
});

test("Retry-After as an HTTP date is honoured, not read as nothing", () => {
	const now = Date.parse("2026-10-06T10:00:00Z");
	assert.equal(S.retryAfterMs("Tue, 06 Oct 2026 10:00:20 GMT", now), 20000);
	assert.equal(S.retryAfterMs("7", now), 7000);
	assert.equal(S.retryAfterMs("Tue, 06 Oct 2026 09:59:00 GMT", now), 0, "a date already past: no wait");
	assert.equal(S.retryAfterMs("soon", now), 0);
	assert.equal(S.retryAfterMs(null, now), 0);
});

test("1,200 rows streamed in six re-ranked batches: each paper's row is built once", () => {
	const ui = uiHarness({ realRows: true, columns: true });
	ui.state.searching = true;
	const pool = Array.from({ length: 1500 }, (_, i) => paper("k" + i, { title: "Paper " + i, doi: "10.5555/k" + i, citations: i }));
	const rows = new Set(), keys = new Set();
	for (let b = 0; b < 6; b++) {
		// Each batch re-ranks the pool and its top 1,200 changes: rows move, leave and come back.
		const batch = pool.slice().sort((x, y) => ((Number(x.key.slice(1)) * 7919 + b * 104729) % 1501) - ((Number(y.key.slice(1)) * 7919 + b * 104729) % 1501)).slice(0, 1200);
		ui.displaySearchResults(batch);
		for (const tr of ui.get("results-body").children) { rows.add(tr); keys.add(tr.dataset.key); }
	}
	assert.equal(rows.size, keys.size, rows.size + " rows built for " + keys.size + " papers");
});

// Live API smoke tests: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const S = require("../content/sources.js");
const M = require("../content/metrics.js");

const http = {
	async getJSON(url, headers = {}) {
		let res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "ZotPoP-tests (mailto:test@example.com)", ...headers } });
		if (!res.ok) {
			let body = await res.text().catch(() => "");
			let e = new Error("HTTP " + res.status + " " + url); e.status = res.status; e.body = body; throw e;
		}
		return res.json();
	},
	async getText(url, headers = {}) {
		let res = await fetch(url, { headers: { "User-Agent": "ZotPoP-tests", ...headers } });
		if (!res.ok) { let e = new Error("HTTP " + res.status + " " + url); e.status = res.status; throw e; }
		return res.text();
	}
};
const ctx = { email: "test@example.com", onProgress: () => {} };

// OpenAlex meters its API: an unauthenticated caller gets about ten searches a day, so a
// spent budget must read as "cannot test now", not as a failing assertion. Set
// OPENALEX_API_KEY to run these against the full allowance.
if (process.env.OPENALEX_API_KEY) ctx.openAlexApiKey = process.env.OPENALEX_API_KEY;

function unavailable(e) {
	return e?.status === 429 || e?.status === 503 || /fetch failed|ENOTFOUND|ECONNRESET/i.test(e?.message || "");
}

// These three assert on values that only OpenAlex supplies, and the adapters swallow its
// errors by design, so probe the provider once rather than reporting a spent budget as a
// failed assertion.
let openAlexProbe = null;
async function openAlexReady() {
	if (openAlexProbe === null) {
		openAlexProbe = (async () => {
			try { await http.getJSON("https://api.openalex.org/works?search=crispr&per-page=1" + (ctx.openAlexApiKey ? "&api_key=" + ctx.openAlexApiKey : "")); return true; }
			catch (e) { return !unavailable(e); }
		})();
	}
	return openAlexProbe;
}

function live(name, fn) {
	test(name, async (t) => {
		try { await fn(t); }
		catch (e) {
			if (!unavailable(e)) throw e;
			let quota = /budget|insufficient|credit/i.test(e.body || e.message || "");
			return t.skip(quota ? "provider budget spent (set OPENALEX_API_KEY to test)" : "provider unavailable: " + String(e.message).slice(0, 60));
		}
	});
}
const q = { keywords: "CRISPR base editing", yearFrom: 2018, yearTo: 2024, maxResults: 15 };

function check(recs, source, lo = 2018, hi = 2024) {
	assert.ok(recs.length > 0, source + " returned results");
	for (let r of recs) {
		assert.equal(r.source, source);
		assert.ok(r.title.length > 3, "title");
		assert.ok(Array.isArray(r.authors));
		if (r.year) assert.ok(r.year >= lo && r.year <= hi, "year in range: " + r.year + " " + r.title);
		if (r.doi) assert.match(r.doi, /^10\./);
	}
}

test("metrics", () => {
	let m = M.compute([
		{ citations: 10, year: 2020, authors: [{}, {}] },
		{ citations: 5, year: 2021, authors: [{}] },
		{ citations: 1, year: 2023, authors: [{}, {}, {}] },
		{ citations: 0, year: 2024, authors: [{}] }
	], 2026);
	assert.equal(m.papers, 4);
	assert.equal(m.citations, 16);
	assert.equal(m.hIndex, 2);
	assert.equal(m.gIndex, 4); // 10 >= 1, 15 >= 4, 16 >= 9, 16 >= 16
	assert.equal(m.citationYears, 6);
	assert.equal(m.hiNorm, 2); // 5, 5, 0.33, 0
});

test("pubmedYear prefers the earlier date", () => {
	assert.equal(S.pubmedYear({ pubdate: "2026 Jun", epubdate: "2024 Jun 10", sortpubdate: "2026/06/01 00:00" }), 2024);
	assert.equal(S.pubmedYear({ pubdate: "2025 Jan", epubdate: "2024 Dec 31" }), 2024);
	assert.equal(S.pubmedYear({ pubdate: "2019 Mar" }), 2019);
	assert.equal(S.pubmedYear({}), null);
});

test("unit helpers", () => {
	assert.equal(S.normalizeDOI("https://doi.org/10.1000/ABC.123"), "10.1000/abc.123");
	assert.equal(S.normalizeDOI("garbage"), null);
	assert.deepEqual(S.parseName("Jae Yoon Sung"), { firstName: "Jae Yoon", lastName: "Sung", name: "Jae Yoon Sung" });
	assert.deepEqual(S.parseName("Sung, Jae Yoon").lastName, "Sung");
	assert.equal(S.pubmedTerm({ keywords: "crispr", authors: "Sung JY", yearFrom: 2020 }), "(crispr[Text Word]) AND (Sung JY[au]) AND (2020:3000[dp])");
	assert.ok(S.titleSimilarity("Base editing of the human genome", "Base editing of the human genome.") > 0.9);
});

live("openalex", async () => { check(await S.search("openalex", q, http, ctx), "openalex"); });
live("openalex venue+author", async () => {
	let recs = await S.search("openalex", { authors: "David R Liu", venue: "Nature", yearFrom: 2016, maxResults: 5 }, http, ctx);
	check(recs, "openalex", 2016, 2030);
	assert.ok(recs.every(r => /nature/i.test(r.venue)), recs.map(r => r.venue).join("|"));
});
live("crossref", async () => { check(await S.search("crossref", q, http, ctx), "crossref"); });
live("semanticscholar", async (t) => {
	// Unauthenticated access is rate-limited; a 429 is the service, not our code.
	try {
		check(await S.search("semanticscholar", q, http, ctx), "semanticscholar");
	}
	catch (e) {
		if (e.status === 429) return t.skip("Semantic Scholar rate limit (set an API key to test)");
		throw e;
	}
});
live("pubmed", async (t) => {
	if (!await openAlexReady()) return t.skip("OpenAlex budget spent (set OPENALEX_API_KEY to test)");
	let recs = await S.search("pubmed", q, http, ctx);
	check(recs, "pubmed");
	assert.ok(recs.some(r => r.citations != null), "enriched with citation counts");
	assert.ok(recs.every(r => r.pmid));
});
live("arxiv", async (t) => {
	try {
		let recs = await S.search("arxiv", { keywords: "transformer attention", yearFrom: 2018, yearTo: 2024, maxResults: 10 }, http, ctx);
		check(recs, "arxiv");
		assert.ok(recs.every(r => r.arxiv));
	}
	catch (e) {
		if (e.status === 429) return t.skip("arXiv rate limit; query construction is covered by offline regressions");
		throw e;
	}
});
live("resolveDOIByTitle", async () => {
	let rec = { title: "Programmable editing of a target base in genomic DNA without double-stranded DNA cleavage", year: 2016 };
	let doi = await S.resolveDOIByTitle(rec, http, ctx);
	assert.equal(doi, "10.1038/nature17946");
});
test("citesPerYear defaults", () => {
	let v = M.citesPerYear({ citations: 100, year: new Date().getFullYear() - 4 });
	assert.equal(v, 25);
});
live("pdfCandidates", async () => {
	let rec = { doi: "10.1093/nar/gku623", pmcid: "PMC4176153", pdfUrls: ["https://academic.oup.com/x.pdf"], pdfUrl: "https://academic.oup.com/x.pdf" };
	let urls = await S.pdfCandidates(rec, http, { email: "" });
	assert.deepEqual(urls, ["https://academic.oup.com/x.pdf", "https://europepmc.org/articles/PMC4176153?pdf=render"]);
});
live("openalex pmcid + pdfUrls", async () => {
	let recs = await S.search("openalex", { title: "CRISPR-Cas9-assisted recombineering in Lactobacillus reuteri", maxResults: 3 }, http, ctx);
	let r = recs.find(x => x.doi === "10.1093/nar/gku623");
	assert.ok(r, "found");
	assert.equal(r.pmcid, "PMC4176153");
	assert.ok(r.pdfUrls.length >= 1, "pdfUrls");
});

live("multi-source merged search", async () => {
	let recs = await S.search("multi", { keywords: "single-stranded DNA annealing protein", sort: "citations", yearFrom: 2015, maxResults: 30 }, http, { ...ctx, log: () => {} });
	assert.ok(recs.length > 5, "merged results: " + recs.length);
	for (let r of recs) {
		assert.ok(Array.isArray(r.sources) && r.sources.length >= 1, "sources array");
		assert.ok(r.title.length > 3);
	}
	// merging must collapse duplicate DOIs across sources
	let dois = recs.map(r => r.doi).filter(Boolean);
	assert.equal(new Set(dois).size, dois.length, "no duplicate DOIs after merge");
	// Source coverage and live citation pages change independently. Known overlaps
	// and metadata merging are asserted with fixed fixtures in search-quality.test.mjs.
	// sorted by citations descending
	let cited = recs.map(r => r.citations ?? -1);
	assert.deepEqual(cited, [...cited].sort((a, b) => b - a), "sorted by citations");
});

live("europepmc", async () => {
	let recs = await S.search("europepmc", q, http, ctx);
	check(recs, "europepmc");
	assert.ok(recs.some(r => r.citations != null), "citation counts");
	assert.ok(recs.some(r => r.authors.length > 0), "authors parsed");
});

live("preprint source covers bioRxiv / Research Square", async () => {
	let recs = await S.search("preprint", { keywords: "recombineering", yearFrom: 2021, maxResults: 40 }, http, { ...ctx, log: () => {} });
	assert.ok(recs.length > 3, "results: " + recs.length);
	assert.ok(recs.every(r => r.itemType === "preprint"), "all preprints");
	let venues = recs.map(r => (r.venue + " " + r.publisher).toLowerCase()).join("|");
	assert.match(venues, /biorxiv|medrxiv|research square|arxiv/, "preprint servers present: " + venues.slice(0, 200));
});

live("every live preprint names its archive", async () => {
	let recs = await S.search("preprint", { keywords: "directed evolution protein engineering", yearFrom: 2024, maxResults: 40 },
		http, { ...ctx, log: () => {} });
	assert.ok(recs.length > 10, "results: " + recs.length);
	let unnamed = recs.filter(r => !r.preprintServer);
	assert.deepEqual(unnamed.map(r => r.doi || r.title), [], "every posting says where it lives");
	// Crossref's posted-content index is what reaches the chemistry and physical-science
	// archives; Europe PMC's SRC:PPR does not carry them.
	let servers = new Set(recs.map(r => r.preprintServer));
	assert.ok(servers.size > 2, "more than one archive reached: " + [...servers].join(", "));
});

live("osf preprints", async () => {
	let recs = await S.search("osf", { keywords: "open science hardware", maxResults: 10 }, http, ctx);
	assert.ok(recs.length > 0, "results: " + recs.length);
	for (let r of recs) {
		assert.equal(r.source, "osf");
		assert.equal(r.itemType, "preprint");
		assert.ok(r.preprintServer, "archive named for " + r.title);
		assert.ok(r.title.length > 3, "title");
		assert.match(r.doi || "10.", /^10\./);
	}
});

live("sort by date", async () => {
	let recs = await S.search("openalex", { venue: "Nucleic Acids Research", sort: "date", maxResults: 12 }, http, ctx);
	assert.ok(recs.length > 5, "journal feed returned results");
	let years = recs.map(r => r.year).filter(Boolean);
	assert.deepEqual(years, [...years].sort((a, b) => b - a), "newest first: " + years.join(","));
	assert.ok(years[0] >= new Date().getFullYear() - 1, "includes current material: " + years[0]);
});

live("crossref journal feed sorted by date", async () => {
	let recs = await S.search("crossref", { venue: "Nature Communications", sort: "date", maxResults: 10 }, http, ctx);
	assert.ok(recs.length > 3, "results: " + recs.length);
	let years = recs.map(r => r.year).filter(Boolean);
	assert.ok(years[0] >= new Date().getFullYear() - 1, "recent first: " + years.slice(0, 3).join(","));
});

test("proxy wrapping and candidate order", async () => {
	const P = "https://access.yonsei.ac.kr/link.n2s?url=";
	assert.equal(S.proxify("https://www.nature.com/a.pdf", P), P + "https://www.nature.com/a.pdf");
	assert.equal(S.proxify(P + "https://x/a", P), P + "https://x/a", "never double-wraps");
	assert.equal(S.proxify("https://x/a", "https://p/?u=%URL%"), "https://p/?u=" + encodeURIComponent("https://x/a"));
	assert.equal(S.proxify("https://x/a", ""), null);
	assert.equal(S.needsProxy("https://europepmc.org/x"), false, "open hosts skip the proxy");
	assert.equal(S.needsProxy("https://arxiv.org/pdf/1"), false);
	assert.equal(S.needsProxy("https://www.sciencedirect.com/x"), true);

	let rec = { doi: "10.1038/x", url: "https://www.nature.com/articles/x", pmcid: null,
		pdfUrls: ["https://www.nature.com/articles/x.pdf"], pdfUrl: "https://www.nature.com/articles/x.pdf" };
	let urls = await S.pdfCandidates(rec, null, { proxyPrefix: P });
	assert.equal(urls[0], "https://www.nature.com/articles/x.pdf", "free route is tried first");
	assert.ok(urls.slice(1).every(u => u.startsWith(P)), "proxy routes come after");
	assert.ok(urls.includes(P + "https://doi.org/10.1038/x"), "DOI landing page via proxy");

	let noProxy = await S.pdfCandidates(rec, null, {});
	assert.ok(noProxy.every(u => !u.includes("yonsei")), "no proxy configured means no proxy URLs");
});

live("journal impact via OpenAlex source id and ISSN", async (t) => {
	if (!await openAlexReady()) return t.skip("OpenAlex budget spent (set OPENALEX_API_KEY to test)");
	let recs = [
		{ title: "a", journalId: "S137773608", issn: null, journalIF: null, journalH: null },
		{ title: "b", journalId: null, issn: "1476-4687", journalIF: null, journalH: null },
		{ title: "c", journalId: null, issn: "0000-0000", journalIF: null, journalH: null }
	];
	await S.enrichJournalMetrics(recs, http, ctx);
	assert.ok(recs[0].journalIF > 5, "Nature IF by id: " + recs[0].journalIF);
	assert.ok(recs[1].journalIF > 5, "Nature IF by e-ISSN: " + recs[1].journalIF);
	assert.equal(recs[1].journalId, "S137773608");
	assert.equal(recs[2].journalIF, null);
});

live("citation check merges OpenAlex, Crossref and Semantic Scholar", async (t) => {
	if (!await openAlexReady()) return t.skip("OpenAlex budget spent (set OPENALEX_API_KEY to test)");
	let rec = { doi: "10.1038/s41586-020-2308-7", citations: null, journalIF: null, journalId: null, issn: null };
	let r = await S.checkCitations(rec, http, ctx);
	// checkCitations swallows a provider error by design and reports null for it, so assert
	// the merge rather than demanding that every provider answered: Crossref and Semantic
	// Scholar both rate-limit anonymous callers.
	let counts = ["openalex", "crossref", "semanticscholar"].map(k => r[k]).filter(v => v != null);
	assert.ok(counts.length >= 1, "no provider answered: " + JSON.stringify(r));
	assert.ok(counts.every(v => v > 1000), "a highly cited paper should exceed 1000: " + JSON.stringify(r));
	assert.equal(rec.citations, Math.max(...counts), "the merged count is the highest reported");
	assert.ok(["openalex", "crossref", "semanticscholar"].includes(rec.citationSource));
	if (r.openalex != null) assert.ok(rec.journalIF > 5, "journal IF filled from check: " + rec.journalIF);
});

test("a preprint and the article it became are kept apart but told about each other", () => {
  /* Two records, two DOIs: merging them would be wrong, because somebody may
     want either. But a real search returned the Research Square preprint and
     the Biotechnology for Biofuels article one after the other, differing only
     in the case of one letter, with nothing to say they were the same work. */
  const rows = [
    {title: "Hi-TARGET: A fast tool for a thermophilic acetogen", doi: "10.21203/rs.3.rs-5676099/v1",
     itemType: "preprint", venue: "Research Square", year: 2025, publishedDoi: "10.1186/s13068-025-02647-0"},
    {title: "Hi-TARGET: a fast tool for a thermophilic acetogen", doi: "10.1186/s13068-025-02647-0",
     itemType: "journalArticle", venue: "Biotechnology for Biofuels", year: 2025},
    {title: "Something else entirely", doi: "10.1038/s41586-000-00000-0", itemType: "journalArticle", venue: "Nature"}
  ];
  S.linkPreprintVersions(rows);
  assert.equal(rows[0].publishedAs.doi, "10.1186/s13068-025-02647-0");
  assert.equal(rows[0].publishedAs.venue, "Biotechnology for Biofuels");
  assert.equal(rows[1].preprintOf.doi, "10.21203/rs.3.rs-5676099/v1");
  assert.equal(rows[2].publishedAs, undefined, "an unrelated paper is left alone");
  // They stay two records: the whole point is that they are not the same object.
  assert.equal(rows.length, 3);

  // One record seen twice is not a preprint pair.
  const same = [
    {title: "One paper", doi: "10.1038/s41586-024-07270-x", itemType: "preprint", venue: "bioRxiv"},
    {title: "One paper", doi: "10.1038/s41586-024-07270-x", itemType: "journalArticle", venue: "Nature"}
  ];
  S.linkPreprintVersions(same);
  assert.equal(same[0].publishedAs, undefined, "the same DOI is one record, not two versions");

  // normalizeDOI returns null for anything it does not recognise, and a guard
  // that only compared the normalised form called these two versions.
  const odd = [
    {title: "Odd identifiers", doi: "internal-id-7", itemType: "preprint", venue: "Local"},
    {title: "Odd identifiers", doi: "Internal-ID-7", itemType: "journalArticle", venue: "Nature"}
  ];
  S.linkPreprintVersions(odd);
  assert.equal(odd[0].publishedAs, undefined);

  // And a pair of preprints with no published version has nothing to report.
  const both = [
    {title: "Only preprints", doi: "10.1101/2024.01.01.111111", itemType: "preprint", venue: "bioRxiv"},
    {title: "Only preprints", doi: "10.21203/rs.3.rs-999999/v1", itemType: "preprint", venue: "Research Square"}
  ];
  S.linkPreprintVersions(both);
  assert.equal(both[0].publishedAs, undefined);
});

test("a combined search asks each source for more than it will show", () => {
  /* Asking each for exactly the number to be shown made the combined search no
     better than three lists stapled together: measured on a real query,
     OpenAlex, Crossref and Europe PMC returned twenty each and sixty distinct
     DOIs -- not one paper in common, so rank fusion had nothing to fuse.
     Small searches overfetch threefold; a large one adds at most 200 candidates
     per provider rather than being cut to 200 rows, and Google Scholar, which
     is scraped, is capped on its own. */
  const source = readFileSync(new URL("../content/sources.js", import.meta.url), "utf8");
  assert.match(source, /const poolFor = max =>/);
  assert.match(source, /let providerQuery = source\.key === "scholar" \? Object\.assign\(\{\}, subQuery, \{ maxResults: Math\.min\(2000, subQuery\.maxResults\) \}\) : subQuery;/,
    "each source is asked with the widened query, Scholar with a cap of its own");
  assert.match(source, /source\.search\(providerQuery, http, sub\)/,
    "and that widened query is what actually goes out");
  const limit = Number(/const PAGE_WALK_LIMIT = (\d+);/.exec(source)[1]);
  const poolFor = new Function("PAGE_WALK_LIMIT", "return " + /const poolFor = (max => [^;]+);/.exec(source)[1])(limit);
  assert.equal(poolFor(20), 60);
  assert.equal(poolFor(5), 30, "a small request still gets a pool worth fusing");
  assert.equal(poolFor(100), 300, "threefold while that is the smaller widening");
  assert.equal(poolFor(1000), 1200, "a large request adds 200 per provider, it is not cut to 200");
  assert.equal(poolFor(20000), limit, "and never past what a page walk is allowed to fetch");
});

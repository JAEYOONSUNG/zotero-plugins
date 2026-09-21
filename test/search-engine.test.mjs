import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { DOMParser } from "linkedom";
import S from "../content/sources.js";

const context = { journalMetrics: false, enrichCitations: false };
const work = n => ({ id: `https://openalex.org/W${n}`, doi: `10.1234/w${n}`, title: `Research article ${n}`, publication_year: 2024 });
function acceleratedSources() {
	const module = { exports: {} };
	vm.runInNewContext(readFileSync(new URL("../content/sources.js", import.meta.url), "utf8"), {
		module, require: createRequire(new URL("../content/sources.js", import.meta.url)),
		setTimeout: fn => setTimeout(fn, 0), clearTimeout, setInterval, clearInterval
	});
	return module.exports;
}

test("OpenAlex page size stays fixed so a partial last page loses no papers", async () => {
	const urls = [];
	const records = await S.search("openalex", { keywords: "research", maxResults: 250 }, { getJSON: async url => {
		const u = new URL(url); urls.push(u);
		const size = Number(u.searchParams.get("per-page")), page = Number(u.searchParams.get("page"));
		return { results: Array.from({ length: size }, (_, i) => work((page - 1) * size + i)), meta: { count: 400 } };
	} }, context);
	assert.equal(records.length, 250);
	assert.equal(new Set(records.map(r => r.doi)).size, 250);
	assert.equal(records[249].doi, "10.1234/w249");
	assert.deepEqual(urls.map(u => u.searchParams.get("per-page")), ["200", "200"]);
});

test("Crossref filters soft author/journal matches and backfills the requested cap", async () => {
	const offsets = [];
	const records = await S.search("crossref", { authors: "David R Liu", venue: "Nature", maxResults: 1 }, { getJSON: async url => {
		if (new URL(url).pathname === "/journals") return { message: { items: [] } };
		const offset = Number(new URL(url).searchParams.get("offset")); offsets.push(offset);
		return { message: { "total-results": 2, items: [{ DOI: `10.1234/${offset}`, title: ["An editing paper"],
			"container-title": [offset ? "Nature" : "Nature Medicine"], author: [{ given: "David R", family: "Liu" }],
			issued: { "date-parts": [[2024]] } }] } };
	} }, context);
	assert.deepEqual(offsets, [0, 1]);
	assert.equal(records[0].doi, "10.1234/1");
});

test("Crossref journal feeds resolve an ISSN instead of scanning broad newest matches", async () => {
	const urls = [];
	const records = await S.search("crossref", { venue: "Nature Communications", sort: "date", maxResults: 1 }, { getJSON: async url => {
		const u = new URL(url); urls.push(u);
		if (u.pathname === "/journals") return { message: { items: [{ title: "Nature Communications", ISSN: ["2041-1723"] }] } };
		assert.equal(u.pathname, "/journals/2041-1723/works");
		assert.equal(u.searchParams.has("query.container-title"), false);
		return { message: { "total-results": 10000, items: [{ DOI: "10.1234/recent", title: ["A recent paper"],
			"container-title": ["Nature Communications"], ISSN: ["2041-1723"], issued: { "date-parts": [[2025, 12, 1]] } }] } };
	} }, context);
	assert.equal(urls.length, 2);
	assert.equal(records[0].doi, "10.1234/recent");
});

test("Semantic Scholar author condition is not inserted into paper keywords", async () => {
	let query;
	const records = await S.search("semanticscholar", { keywords: "base editing", authors: "David R Liu", maxResults: 2 }, { getJSON: async url => {
		query = new URL(url).searchParams.get("query");
		return { total: 2, data: [
			{ paperId: "bad", title: "Base editing", authors: [{ name: "Unrelated Author" }] },
			{ paperId: "good", title: "Base editing", authors: [{ name: "David R Liu" }] }
		] };
	} }, context);
	assert.equal(query, "base editing");
	assert.deepEqual(records.map(r => r.sourceId), ["good"]);
});

test("Semantic Scholar author-only OR considers papers from both authors before sorting", async () => {
	const papers = [];
	const records = await S.search("semanticscholar", { authors: "David Liu OR Alice Smith", sort: "citations", maxResults: 1 }, { getJSON: async url => {
		const u = new URL(url);
		if (u.pathname.endsWith("/author/search")) return { data: [{ authorId: u.searchParams.get("query").startsWith("David") ? "A" : "B", name: u.searchParams.get("query") }] };
		const id = u.pathname.split("/").at(-2); papers.push(id);
		return { data: [{ paperId: id, title: "Different research " + id, authors: [{ name: id === "A" ? "David Liu" : "Alice Smith" }], citationCount: id === "A" ? 1 : 10000 }] };
	} }, context);
	assert.deepEqual(papers, ["A", "B"]);
	assert.equal(records[0].sourceId, "B");
});

test("PubMed compiles literal text words, quoted phrases and explicit field tags", () => {
	assert.equal(S.pubmedTerm({ keywords: "CRISPR base editing" }), "((CRISPR[Text Word] AND base[Text Word]) AND editing[Text Word])");
	assert.equal(S.pubmedTerm({ keywords: '("base editing" OR CRISPR) NOT cancer' }), '(("base editing"[Text Word] OR CRISPR[Text Word]) NOT cancer[Text Word])');
	assert.equal(S.pubmedTerm({ keywords: "CRISPR[All Fields]" }), "CRISPR[All Fields]");
});

test("PubMed sorts enriched candidates before applying the result cap", async () => {
	const records = await acceleratedSources().search("pubmed", { keywords: "editing", sort: "citations", maxResults: 1 }, { getJSON: async url => {
		if (url.includes("esearch")) return { esearchresult: { idlist: ["1", "2"], count: "2" } };
		if (url.includes("esummary")) return { result: { uids: ["1", "2"],
			1: { title: "First editing paper", articleids: [{ idtype: "doi", value: "10.1234/first" }] },
			2: { title: "Second editing paper", articleids: [{ idtype: "doi", value: "10.1234/second" }] } } };
		return { results: [{ doi: "10.1234/first", cited_by_count: 1 }, { doi: "10.1234/second", cited_by_count: 10000 }] };
	} }, { journalMetrics: false });
	assert.equal(records[0].doi, "10.1234/second");
});

const scholarHTML = (start, count) => `<html><body>${Array.from({ length: count }, (_, i) => `<div class="gs_r gs_or gs_scl" data-cid="${start + i}"><h3 class="gs_rt"><a href="https://example.org/${start + i}">Specific paper ${start + i}</a></h3><div class="gs_a">A Author - Journal, 2024 - example.org</div><div class="gs_rs">A useful abstract.</div><div class="gs_fl"><a>Cited by 1,234</a></div></div>`).join("")}</body></html>`;

test("Scholar advances by actual returned rows and retains abstract/citation metadata", async () => {
	const starts = [];
	const records = await acceleratedSources().search("scholar", { keywords: "research", maxResults: 25 }, { getText: async url => {
		const start = Number(new URL(url).searchParams.get("start")); starts.push(start);
		return scholarHTML(start, start < 20 ? 10 : 5);
	} }, { ...context, DOMParser });
	assert.deepEqual(starts, [0, 10, 20]);
	assert.equal(records.length, 25);
	assert.equal(new Set(records.map(r => r.sourceId)).size, 25);
	assert.equal(records[0].abstract, "A useful abstract.");
	assert.equal(records[0].citations, 1234);
});

test("Scholar PoP bridge preserves actual result metadata and never needs direct HTTP", async () => {
	const records = await S.search("scholar", { authors: "David R Liu", venue: "Nucleic Acids Research", maxResults: 1 }, {}, { ...context,
		popSearch: async () => [{ uid: "GS:123", title: "An editing paper", source: "…Acids Research", authors: ["A Author", "…"],
			doi: "10.1234/real", year: 2024, cites: 7, abstract: "Original abstract", article_url: "https://doi.org/10.1234/real" }]
	});
	assert.equal(records[0].searchBackend, "publish-or-perish");
	assert.equal(records[0].venue, "…Acids Research", "never fabricate a full journal name from the search field");
	assert.equal(records[0].doi, "10.1234/real");
});

test("large Scholar searches publish an initial batch before the full retrieval finishes", async () => {
	const caps = []; let release, shown;
	const slow = new Promise(resolve => { release = resolve; });
	const first = new Promise(resolve => { shown = resolve; });
	const pending = S.search("scholar", { keywords: "geobacillus", maxResults: 1000 }, {}, { ...context,
		onResults(records) { if (records.length) shown(records); },
		popSearch: async query => {
			caps.push(query.maxResults);
			if (query.maxResults > 30) await slow;
			return Array.from({ length: query.maxResults }, (_, i) => ({ uid: `GS:${i}`, title: `Geobacillus research ${i}`, year: 2024, authors: ["A Author"] }));
		}
	});
	assert.equal((await first).length, 30);
	release(); const records = await pending;
	assert.deepEqual(caps, [30, 1000]);
	assert.equal(records.length, 1000);
});

test("cached partial Scholar results stop further live extension and keep their warning", async () => {
	let calls = 0;
	const ctx = { ...context, popSearch: async (_query, supplied) => {
		calls++;
		assert.equal(supplied.recoveryMaxResults, 1000);
		supplied.errors.push("Search incomplete; cached papers retained");
		const rows = Array.from({ length: 210 }, (_, i) => ({ uid: `GS:${i}`, title: `Cached paper ${i}`, year: 2010 }));
		rows.partial = true; rows.cached = true;
		return rows;
	} };
	const records = await S.search("scholar", { keywords: "geobacillus", maxResults: 1000 }, {}, ctx);
	assert.equal(records.length, 210);
	assert.equal(calls, 1, "do not resume live pagination after a provider block");
	assert.equal(ctx.errors.length, 1);
});

test("DOI resolution refuses opposite conclusions while allowing exact typography variants", async () => {
	const record = { title: "Editing genes does not increase cancer risk", year: 2024 };
	const http = { getJSON: async () => ({ message: { items: [
		{ DOI: "10.1234/wrong", title: ["Editing genes does increase cancer risk"], issued: { "date-parts": [[2024]] } },
		{ DOI: "10.1234/right", title: [record.title + "."], issued: { "date-parts": [[2024]] } }
	] } }) };
	assert.equal(await S.resolveDOIByTitle(record, http), "10.1234/right");
});

test("cancelling after a rate limit prevents all later retry requests", async () => {
	const controller = new AbortController(); let calls = 0;
	await assert.rejects(S.search("arxiv", { keywords: "editing" }, { getText: async (_url, _headers, signal) => {
		assert.equal(signal, controller.signal); calls++; controller.abort(); throw Object.assign(new Error("limited"), { status: 429 });
	} }, { ...context, signal: controller.signal }), { name: "AbortError" });
	assert.equal(calls, 1);
});

test("cancellation interrupts an in-flight adapter that ignores AbortSignal", async () => {
	const controller = new AbortController(); let started;
	const begun = new Promise(resolve => { started = resolve; });
	const pending = S.search("openalex", { keywords: "editing" }, { getJSON: () => { started(); return new Promise(() => {}); } }, { ...context, signal: controller.signal });
	await begun; controller.abort();
	await assert.rejects(pending, { name: "AbortError" });
});

test("a complete provider outage rejects instead of masquerading as zero matches", async () => {
	const ctx = { ...context };
	const fail = async () => { throw new Error("offline"); };
	await assert.rejects(S.search("multi", { keywords: "editing" }, { getJSON: fail, getText: fail }, ctx), /All search sources failed/);
	assert.equal(ctx.errors.length, 4);
});

test("combined search displays fast-source results before the last source completes", async () => {
	let release, first, complete = false;
	const slow = new Promise(resolve => { release = resolve; });
	const shown = new Promise(resolve => { first = resolve; });
	const pending = S.search("multi", { keywords: "research", maxResults: 3 }, {
		getJSON: async url => {
			if (url.includes("openalex")) return { results: [work(1)], meta: { count: 1 } };
			await slow;
			return url.includes("crossref") ? { message: { items: [], "total-results": 0 } } : { resultList: { result: [] }, hitCount: 0 };
		}, getText: async () => { await slow; return "<feed></feed>"; }
	}, { ...context, onResults(records) { if (records.length) first(records); } }).then(records => { complete = true; return records; });
	const early = await shown;
	assert.equal(early[0].doi, "10.1234/w1"); assert.equal(complete, false);
	release(); assert.equal((await pending).length, 1);
});

test("arXiv journal references retain citations while matching the actual journal name", async () => {
	const records = await S.search("arxiv", { venue: "Nature", maxResults: 1 }, { getText: async () => `<feed><opensearch:totalResults>1</opensearch:totalResults><entry><id>https://arxiv.org/abs/2001.00001v1</id><title>An important paper</title><published>2020-01-01</published><arxiv:journal_ref>Nature 583, 82-86 (2020)</arxiv:journal_ref></entry></feed>` }, context);
	assert.equal(records[0].venue, "Nature");
	assert.equal(records[0].journalReference, "Nature 583, 82-86 (2020)");
});

test("invalid year ranges are rejected before any provider request", async () => {
	let calls = 0;
	await assert.rejects(S.search("openalex", { keywords: "editing", yearFrom: 2025, yearTo: 2020 }, { getJSON: async () => { calls++; } }, context), /Start year/);
	assert.equal(calls, 0);
});

/* Google Scholar, read directly. The profile page is public; the author search
   is behind a Google sign-in; a burst of requests earns a CAPTCHA or a 429. */
const scholarProfileHTML = (rows, { more = false } = {}) => `<html><body>
<div id="gsc_prf_in">Geoffrey Hinton</div><div class="gsc_prf_il">Emeritus Prof. Comp Sci, U.Toronto</div><div class="gsc_prf_il">Verified email at cs.toronto.edu</div>
<table id="gsc_rsb_st"><tr><th></th><th>All</th><th>Since 2021</th></tr>
<tr><td class="gsc_rsb_sc1"><a>Citations</a></td><td class="gsc_rsb_std">1,088,758</td><td class="gsc_rsb_std">623770</td></tr>
<tr><td class="gsc_rsb_sc1"><a>h-index</a></td><td class="gsc_rsb_std">195</td><td class="gsc_rsb_std">134</td></tr>
<tr><td class="gsc_rsb_sc1"><a>i10-index</a></td><td class="gsc_rsb_std">550</td><td class="gsc_rsb_std">403</td></tr></table>
<table><tbody>${rows.map((r, i) => `<tr class="gsc_a_tr"><td class="gsc_a_t"><a href="/citations?view_op=view_citation&amp;hl=en&amp;user=JicYPdAAAAAJ&amp;citation_for_view=JicYPdAAAAAJ:${r.id || "v" + i}" class="gsc_a_at">${r.title}</a><div class="gs_gray">${r.authors}</div><div class="gs_gray">${r.venue}<span class="gs_oph">, ${r.year}</span></div></td><td class="gsc_a_c"><a href="https://scholar.google.com/scholar?oi=bibs&amp;hl=en&amp;cites=${r.cluster || 0}" class="gsc_a_ac gs_ibl">${r.cites}</a></td><td class="gsc_a_y"><span class="gsc_a_h gsc_a_hc gs_ibl">${r.year}</span></td></tr>`).join("")}</tbody></table>
<button id="gsc_bpf_more"${more ? "" : " disabled"}>Show more</button></body></html>`;

test("a Scholar profile page yields the person, the figures and the rows, and pages until the button is off", async () => {
	const pages = [];
	const http = { getText: async url => {
		const u = new URL(url); pages.push([Number(u.searchParams.get("cstart")), Number(u.searchParams.get("pagesize"))]);
		const start = Number(u.searchParams.get("cstart"));
		const rows = Array.from({ length: start === 0 ? 100 : 7 }, (_, i) => ({ title: `Paper ${start + i}`, authors: "E Cambria, G Hinton", venue: "Cognitive Computation 18 (1), 20", year: 2026, cites: 1234, cluster: 99000 + start + i }));
		return scholarProfileHTML(rows, { more: start === 0 });
	} };
	const { profile, records, complete } = await S.scholarProfile("JicYPdAAAAAJ", http, { DOMParser, sleepMs: 0 }, { maxResults: 500 });
	assert.deepEqual(pages, [[0, 100], [100, 100]]);
	assert.equal(profile.name, "Geoffrey Hinton");
	assert.equal(profile.affiliation, "Emeritus Prof. Comp Sci, U.Toronto", "the verified-email line is not an affiliation");
	assert.deepEqual([profile.citations, profile.hIndex, profile.i10], [1088758, 195, 550]);
	assert.equal(records.length, 107);
	assert.equal(complete, true);
	assert.equal(records[0].title, "Paper 0");
	assert.equal(records[0].venue, "Cognitive Computation", "volume, issue, pages and year are stripped from the venue line");
	assert.equal(records[0].year, 2026);
	assert.equal(records[0].citations, 1234);
	assert.equal(records[0].scholarCluster, "99000");
	assert.equal(records[0].authors[1].lastName, "Hinton");
	assert.equal(records[0].sourceId, "JicYPdAAAAAJ:v0");
	assert.equal(records[0].searchBackend, "scholar-profile");
});

test("Scholar's sign-in page is a login wall, its CAPTCHA page a captcha wall, and a 429 counts as one", async () => {
	const signin = `<!doctype html><html><head><base href="https://accounts.google.com/v3/signin/"></head><body>flowName=GlifWebSignIn</body></html>`;
	await assert.rejects(S.scholarAuthors("Geoffrey Hinton", { getText: async () => signin }, { DOMParser }), e => e.wall === "login" && /signed in/.test(e.message) && /search_authors/.test(e.url));
	const captcha = `<html><body><div id="gs_captcha_ccl"></div>Our systems have detected unusual traffic</body></html>`;
	await assert.rejects(S.scholarProfile("JicYPdAAAAAJ", { getText: async () => captcha }, { DOMParser }), e => e.wall === "captcha" && e.captcha === true);
	const limited = { getText: async () => { const e = new Error("HTTP 429"); e.status = 429; throw e; } };
	await assert.rejects(S.scholarCitedBy("12345", limited, { DOMParser }), e => e.wall === "captcha" && e.cause?.status === 429);
});

test("the Scholar author search page yields profiles with their ids, affiliations and citation counts", async () => {
	const html = `<html><body><div class="gsc_1usr"><h3 class="gs_ai_name"><a href="/citations?hl=en&amp;user=JicYPdAAAAAJ">Geoffrey Hinton</a></h3><div class="gs_ai_aff">University of Toronto</div><div class="gs_ai_eml">Verified email at cs.toronto.edu</div><div class="gs_ai_cby">Cited by 1,088,758</div></div>
	<div class="gsc_1usr"><h3 class="gs_ai_name"><a href="/citations?hl=en&amp;user=kukA0LcAAAAJ">Yoshua Bengio</a></h3><div class="gs_ai_aff">Mila</div><div class="gs_ai_cby">Cited by 900,000</div></div></body></html>`;
	const found = await S.scholarAuthors("Hinton", { getText: async () => html }, { DOMParser });
	assert.deepEqual(found.map(p => [p.id, p.name, p.affiliation, p.citations]), [["JicYPdAAAAAJ", "Geoffrey Hinton", "University of Toronto", 1088758], ["kukA0LcAAAAJ", "Yoshua Bengio", "Mila", 900000]]);
	assert.equal(found[0].url, "https://scholar.google.com/citations?user=JicYPdAAAAAJ");
});

test("a Scholar result row carries the authors that have profiles and the cluster behind Cited by", async () => {
	const html = `<html><body><div class="gs_r gs_or gs_scl" data-cid="abc"><h3 class="gs_rt"><a href="/scholar_url?url=https://example.org/p">A paper</a></h3><div class="gs_a"><a href="/citations?user=JicYPdAAAAAJ&amp;hl=en">G Hinton</a>, A Other - Nature, 2015 - nature.com</div><div class="gs_fl"><a href="/scholar?cites=5566778899&amp;as_sdt=2005">Cited by 84,735</a></div></div></body></html>`;
	const [rec] = S.parseScholarPage(html, DOMParser);
	assert.deepEqual(rec.scholarAuthors, [{ name: "G Hinton", id: "JicYPdAAAAAJ" }]);
	assert.equal(rec.scholarCluster, "abc");
	assert.equal(rec.citations, 84735);
	assert.equal(rec.url, "https://scholar.google.com/scholar_url?url=https://example.org/p", "a relative link becomes absolute");
});

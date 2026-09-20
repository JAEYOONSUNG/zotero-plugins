import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import S from "../content/sources.js";

const context = () => ({ enrichCitations: false, journalMetrics: false, institutionMetrics: false });
function acceleratedSources() {
	const module = { exports: {} };
	vm.runInNewContext(readFileSync(new URL("../content/sources.js", import.meta.url), "utf8"), {
		module, require: createRequire(new URL("../content/sources.js", import.meta.url)),
		setTimeout: fn => setTimeout(fn, 0), clearTimeout, setInterval, clearInterval
	});
	return module.exports;
}
const author = { given: "Alice", family: "Smith" };
const cr = n => ({ DOI: `10.1234/research${n}`, title: [`Research on bacterial systems ${n}`], author: [author],
	issued: { "date-parts": [[2024]] }, type: "posted-content", subtype: "preprint" });
const oa = n => ({ id: `https://openalex.org/W${n}`, doi: `10.1234/research${n}`, title: `Research on bacterial systems ${n}`,
	publication_year: 2024, authorships: [{ author: { display_name: "Alice Smith", id: "https://openalex.org/A123", orcid: "https://orcid.org/0000-0002-1825-0097" } }] });
const epmc = n => ({ id: `PPR${n}`, doi: `10.1234/research${n}`, title: `Research on bacterial systems ${n}`, pubYear: "2024", source: "PPR" });
function deepTransport(total) {
	const calls = {};
	function page(source, start, size) {
		(calls[source] ||= []).push({ start, size });
		return Array.from({ length: Math.min(size, total - start) }, (_, i) => start + i);
	}
	return { calls, async getJSON(url) {
		const u = new URL(url), p = u.searchParams;
		if (u.hostname === "api.openalex.org") {
			const size = Number(p.get("per-page")), start = (Number(p.get("page")) - 1) * size;
			return { results: page("openalex", start, size).map(oa), meta: { count: total } };
		}
		if (u.hostname === "api.crossref.org") {
			return { message: { "total-results": total, items: page("crossref", Number(p.get("offset")), Number(p.get("rows"))).map(cr) } };
		}
		if (u.hostname === "www.ebi.ac.uk") {
			const start = p.get("cursorMark") === "*" ? 0 : Number(p.get("cursorMark")), size = Number(p.get("pageSize"));
			return { resultList: { result: page("europepmc", start, size).map(epmc) }, hitCount: total, nextCursorMark: String(start + size) };
		}
		if (u.hostname === "api.osf.io") {
			const start = Number(p.get("offset") || 0), size = Number(p.get("page[size]") || 100);
			return { data: page("osf", start, size).map(n => ({ id: `osf${n}`, attributes: { title: `Research on bacterial systems ${n}`, date_published: "2024-01-01" }, links: { preprint_doi: `10.1234/research${n}` } })),
				links: { meta: { total }, next: start + size < total ? `https://api.osf.io/v2/preprints/?offset=${start + size}&page[size]=${size}` : null } };
		}
		throw new Error("Unexpected URL " + url);
	}, async getText(url) {
		const p = new URL(url).searchParams;
		return `<feed><opensearch:totalResults>${total}</opensearch:totalResults>${page("arxiv", Number(p.get("start")), Number(p.get("max_results"))).map(n => `<entry><id>https://arxiv.org/abs/2401.${String(n).padStart(5, "0")}v1</id><title>Research on bacterial systems ${n}</title><published>2024-01-01</published><arxiv:doi>10.1234/research${n}</arxiv:doi></entry>`).join("")}</feed>`;
	} };
}

for (const source of ["multi", "preprint"]) for (const maxResults of [1000, 2000]) {
	test(`${source} collects ${maxResults} unique works despite complete cross-source overlap`, async () => {
		const http = deepTransport(maxResults + 500), ctx = context();
		const records = await acceleratedSources().search(source, { keywords: "research", maxResults }, http, ctx);
		assert.equal(records.length, maxResults);
		assert.equal(new Set(records.map(row => row.doi)).size, maxResults);
		assert.equal(records[0].sources.length, 4);
		for (const [provider, calls] of Object.entries(http.calls)) {
			assert.ok(calls.at(-1).start >= 1000, `${provider} actually fetched beyond its old 200 limit`);
			assert.ok(ctx.sourceStatus[provider].retrieved >= maxResults);
			assert.equal(ctx.sourceStatus[provider].truncated, false);
		}
		assert.equal(ctx.errors.length, 0);
	});
}

test("a 10000-candidate walk limit is visible instead of a silent empty complete result", async () => {
	const ctx = context(); let count = 0;
	const rows = await S.search("crossref", { authors: "Alice Smith", maxResults: 2000 }, { getJSON: async url => {
		const p = new URL(url).searchParams, offset = Number(p.get("offset")), size = Number(p.get("rows"));
		count++;
		return { message: { "total-results": 20000, items: Array.from({ length: size }, (_, i) => ({ ...cr(offset + i), author: [{ given: "Bob", family: "Brown" }] })) } };
	} }, ctx);
	assert.equal(rows.length, 0); assert.equal(count, 100);
	assert.equal(ctx.sourceStatus.crossref.scanned, 10000);
	assert.equal(ctx.sourceStatus.crossref.reason, "candidate-limit");
	assert.ok(ctx.errors.some(error => /10000 candidates/.test(error)));
});

test("Semantic Scholar reports its 1000-candidate relevance limit for a 2000-result request", async () => {
	const ctx = context();
	const rows = await acceleratedSources().search("semanticscholar", { keywords: "research", maxResults: 2000 }, { getJSON: async url => {
		const p = new URL(url).searchParams, start = Number(p.get("offset")), size = Number(p.get("limit"));
		assert.ok(start + size <= 1000);
		return { total: 5000, next: start + size, data: Array.from({ length: size }, (_, i) => ({ paperId: String(start + i), title: `Research paper ${start + i}` })) };
	} }, ctx);
	assert.equal(rows.length, 1000);
	assert.equal(ctx.sourceStatus.semanticscholar.reason, "provider-limit");
	assert.ok(ctx.errors.some(error => /1000/.test(error)));
});

test("Semantic Scholar author papers paginate to 2000 beyond the relevance endpoint's cap", async () => {
	let pages = 0;
	const rows = await acceleratedSources().search("semanticscholar", { authors: "Alice Smith", maxResults: 2000 }, { getJSON: async url => {
		if (url.includes("/author/search")) return { data: [{ authorId: "1", name: "Alice Smith" }] };
		const start = Number(new URL(url).searchParams.get("offset")); pages++;
		return { next: start + 100 < 2100 ? start + 100 : null,
			data: Array.from({ length: 100 }, (_, i) => ({ paperId: String(start + i), title: `Research paper ${start + i}`, authors: [{ name: "Alice Smith" }] })) };
	} }, context());
	assert.equal(rows.length, 2000); assert.equal(pages, 20);
});

test("OpenAlex identifiers are verified against author identity, never similar names", async () => {
	for (const [authors, filter] of [["https://openalex.org/A123", "authorships.author.id:A123"], ["0000-0002-1825-0097", "authorships.author.orcid:0000-0002-1825-0097"]]) {
		const rows = await S.search("openalex", { authors, maxResults: 10 }, { getJSON: async url => {
			assert.equal(new URL(url).searchParams.get("filter"), filter);
			return { meta: { count: 2 }, results: [oa(1), { ...oa(2), authorships: [{ author: { id: "https://openalex.org/A999", display_name: "Alice Smith", orcid: "https://orcid.org/0000-0001-5109-3700" } }] }] };
		} }, context());
		assert.deepEqual(rows.map(row => row.sourceId), ["W1"]);
		assert.equal(rows[0].authors[0].openalexId, "A123");
	}
});

test("invalid, compound and unsupported author identifier searches make no HTTP requests", async () => {
	for (const [source, authors] of [["openalex", "0000-0002-1825-0098"], ["crossref", "A123"], ["openalex", "A123 OR A456"], ["openalex", "Alice Smith OR A123"], ["openalex", "0000000218250098"], ["openalex", "orcid:0000-0002-1825-0098"], ["openalex", "authors/A0"], ["openalex", '"A123"']]) {
		let calls = 0;
		await assert.rejects(S.search(source, { authors }, { getJSON: async () => { calls++; return {}; } }, context()), /identifier|identifiers/i);
		assert.equal(calls, 0);
	}
});

test("Combined author identity search visibly narrows the selected providers", async () => {
	const ctx = context(); let calls = 0;
	const rows = await S.search("multi", { authors: "A123", sources: ["openalex", "pubmed"], maxResults: 10 }, { getJSON: async url => {
		assert.equal(new URL(url).hostname, "api.openalex.org"); calls++;
		return { results: [oa(1)], meta: { count: 1 } };
	} }, ctx);
	assert.equal(rows.length, 1); assert.equal(calls, 1);
	assert.match(ctx.errors[0], /OpenAlex only/);
});

test("Combined source selection rejects invalid input and queries exactly the selected providers", async () => {
	for (const sources of [[], "openalex", ["fake"], ["preprint"]]) {
		await assert.rejects(S.search("multi", { keywords: "research", sources }, {}, context()), /supported source/);
	}
	let calls = 0;
	const rows = await S.search("multi", { keywords: "research", sources: ["crossref", "crossref"], maxResults: 10 }, { getJSON: async url => {
		assert.equal(new URL(url).hostname, "api.crossref.org"); calls++;
		return { message: { items: [cr(1)], "total-results": 1 } };
	} }, context());
	assert.equal(calls, 1); assert.equal(rows.length, 1);
});

test("Combined Scholar uses the PoP bridge without exceeding its supported 2000 limit", async () => {
	const caps = [];
	const rows = await S.search("multi", { keywords: "research", sources: ["scholar"], maxResults: 2000 }, {}, { ...context(), popSearch: async q => {
		caps.push(q.maxResults); assert.ok(q.maxResults <= 2000);
		return Array.from({ length: q.maxResults }, (_, i) => ({ uid: "GS:" + i, title: "Research paper " + i }));
	} });
	assert.equal(rows.length, 2000); assert.deepEqual(caps, [30, 2000]);
});

test("PubMed pasted title avoids unindexed stopwords and preserves exact phrase intent", async () => {
	const title = "CRISPR Cas9 assisted recombineering in Lactobacillus reuteri";
	for (const requested of [title, '"' + title + '"']) {
		const rows = await acceleratedSources().search("pubmed", { title: requested, maxResults: 10 }, { getJSON: async url => {
			if (url.includes("esearch")) {
				const term = new URL(url).searchParams.get("term");
				assert.doesNotMatch(term, /\bin\[ti\]/);
				if (requested[0] === '"') assert.match(term, /\[ti:~0\]/);
				return { esearchresult: { idlist: ["25074379", "2"], count: "2" } };
			}
			return { result: { uids: ["25074379", "2"], 25074379: { title }, 2: { title: "CRISPR Cas9 assisted recombineering for Lactobacillus reuteri" } } };
		} }, context());
		assert.deepEqual(Array.from(rows, row => row.pmid), ["25074379"]);
	}
});

// PubMed's native evaluator is left-to-right within each parenthesized group.
// This independent evaluator catches dropped NOTs and OR leaking across fields.
function nativePubMedMatches(expression, values) {
	const tokens = expression.match(/\(|\)|\bAND\b|\bOR\b|\bNOT\b|[^\s()[\]]+(?: [^\s()[\]]+)*\[[^\]]+\]/g).map(token => token.trim());
	let pos = 0;
	function atom() {
		const token = tokens[pos++];
		if (token === "(") { const result = group(); assert.equal(tokens[pos++], ")"); return result; }
		return token === "all[sb]" || values.has(token);
	}
	function group() {
		let result = atom();
		while (pos < tokens.length && tokens[pos] !== ")") {
			const op = tokens[pos++], right = atom();
			result = op === "OR" ? result || right : op === "NOT" ? result && !right : result && right;
		}
		return result;
	}
	const result = group(); assert.equal(pos, tokens.length); return result;
}

test("PubMed OR, NOT, nested grouping and cross-field scope have the intended truth tables", () => {
	for (const [query, expected] of [
		[{ title: "NOT cancer" }, (c, g, e, a) => !c],
		[{ title: "cancer OR genome editing" }, (c, g, e, a) => c || (g && e)],
		[{ title: "cancer OR genome", authors: "Alice Smith" }, (c, g, e, a) => (c || g) && a],
		[{ title: "cancer AND NOT (genome OR editing)" }, (c, g, e, a) => c && !(g || e)]
	]) {
		const compiled = S.pubmedTerm(query);
		for (let bits = 0; bits < 16; bits++) {
			const args = [0, 1, 2, 3].map(bit => Boolean(bits & 1 << bit));
			const values = new Set(["cancer[ti]", "genome[ti]", "editing[ti]", "Alice Smith[au]"].filter((_, i) => args[i]));
			assert.equal(nativePubMedMatches(compiled, values), expected(...args), `${compiled}, bits=${bits}`);
		}
	}
});

test("PubMed refills IDs when local author checks exhaust the initial candidate batch", async () => {
	const starts = [], ctx = context();
	const rows = await acceleratedSources().search("pubmed", { authors: "Alice Smith", maxResults: 1 }, { getJSON: async url => {
		const p = new URL(url).searchParams;
		if (url.includes("esearch")) {
			const start = Number(p.get("retstart")); starts.push(start);
			return { esearchresult: { count: "201", idlist: Array.from({ length: Math.min(200, 201 - start) }, (_, i) => String(start + i)) } };
		}
		const ids = p.get("id").split(",");
		return { result: { uids: ids, ...Object.fromEntries(ids.map(id => [id, { title: "Research " + id, authors: [{ name: id === "200" ? "Smith A" : "Brown B" }] }])) } };
	} }, ctx);
	assert.deepEqual(starts, [0, 200]); assert.equal(rows.length, 1); assert.equal(rows[0].pmid, "200");
});

test("Europe PMC title Boolean expressions remain fielded alternatives and quoted phrases stay phrases", () => {
	assert.equal(S.epmcQuery({ title: "cancer OR genome", authors: "Alice Smith" }), '(TITLE:cancer OR TITLE:genome) AND (AUTH:"Alice Smith")');
	assert.equal(S.epmcQuery({ title: '"cancer genome" OR editing' }), '(TITLE:"cancer genome" OR TITLE:editing)');
	assert.equal(S.epmcQuery({ title: "cancer genome" }), '(TITLE:cancer AND TITLE:genome)');
});

test("OSF searches each OR branch and applies exclusions locally", async () => {
	const asked = [];
	const rows = await S.search("osf", { title: "genome OR (cancer NOT review)", maxResults: 10 }, { getJSON: async url => {
		const seed = new URL(url).searchParams.get("filter[title]"); asked.push(seed);
		return { data: [seed, seed + " review"].map(title => ({ id: title, attributes: { title } })), links: { next: null, meta: { total: 2 } } };
	} }, context());
	assert.deepEqual(asked, ["genome", "cancer"]);
	assert.deepEqual(rows.map(row => row.title).sort(), ["cancer", "genome", "genome review"]);
});

test("OpenAlex secrets never travel to Crossref and enrichment records citation provenance", async () => {
	const seen = [], record = S.makeRecord({ source: "pubmed", doi: "10.1234/test" });
	await S.checkCitations(record, { getJSON: async (url, headers) => {
		const u = new URL(url); seen.push(u);
		if (u.hostname === "api.openalex.org") { assert.equal(u.searchParams.get("api_key"), "FAKE_OPENALEX_ONLY"); return { cited_by_count: 42 }; }
		assert.equal(u.searchParams.has("api_key"), false); assert.ok(!url.includes("FAKE_OPENALEX_ONLY"));
		return u.hostname === "api.crossref.org" ? { message: { "is-referenced-by-count": 3 } } : { citationCount: 2 };
	} }, { ...context(), openAlexApiKey: "FAKE_OPENALEX_ONLY", email: "test@example.invalid" });
	assert.equal(seen.length, 3); assert.equal(record.citationSource, "openalex");
	const enriched = S.makeRecord({ source: "pubmed", doi: "10.1234/enrich" });
	await S.enrichFromOpenAlex([enriched], { getJSON: async () => ({ results: [{ doi: enriched.doi, cited_by_count: 17 }] }) }, {});
	assert.equal(enriched.citations, 17); assert.equal(enriched.citationSource, "openalex");
});

test("scientific sign, inequality and superscript differences survive ingestion and deduplication", () => {
	for (const [a, b] of [["Growth at +10 C", "Growth at -10 C"], ["Effects of x < y > z", "Effects of x z"], ["Effects of x² on growth", "Effects of x₂ on growth"], ["Effects of x<sup>2</sup> on growth", "Effects of x<sub>2</sub> on growth"]]) {
		const rows = S.dedupe([a, b].map((title, i) => S.makeRecord({ source: i ? "crossref" : "openalex", title, year: 2024, authors: [{ name: "Alice Smith" }] })));
		assert.equal(rows.length, 2, a);
	}
	assert.equal(S.stripTags("Effects of <i>x</i> < y > z"), "Effects of x < y > z");
});

test("version links require independent evidence and reject unrelated or ambiguous same-title papers", () => {
	const pre = extra => S.makeRecord({ source: "crossref", doi: "10.1234/pre", title: "Introduction", itemType: "preprint", year: 2024, authors: [{ name: "Alice Smith" }], ...extra });
	const pub = extra => S.makeRecord({ source: "crossref", doi: "10.1234/pub", title: "Introduction", venue: "Nature", year: 1947, authors: [{ name: "Bob Brown" }], ...extra });
	const bad = S.linkPreprintVersions([pre(), pub()]); assert.equal(bad[0].publishedAs, undefined);
	const title = "Genome engineering through improved recombinase specificity";
	const good = S.linkPreprintVersions([pre({ title }), pub({ title, year: 2025, authors: [{ name: "Alice Smith" }] })]);
	assert.equal(good[0].publishedAs.doi, "10.1234/pub");
	const explicit = S.linkPreprintVersions([pre({ publishedDoi: "10.1234/pub" }), pub()]);
	assert.equal(explicit[0].publishedAs.doi, "10.1234/pub");
	const ambiguous = S.linkPreprintVersions([pre({ title }), pub({ title, year: 2025, authors: [{ name: "Alice Smith" }] }), pub({ title, doi: "10.1234/other", year: 2025, authors: [{ name: "Alice Smith" }] })]);
	assert.equal(ambiguous[0].publishedAs, undefined);
});

test("same-title first-author homonyms stay separate even when year and journal agree", () => {
	for (const title of ["Introduction", "Genome editing in living bacterial systems"]) {
		const rows = ["John", "Jane"].map((firstName, i) => S.makeRecord({ source: i ? "crossref" : "openalex", sourceId: String(i),
			title, year: 2025, venue: "Nature", authors: [{ firstName, lastName: "Smith", name: firstName + " Smith" }] }));
		assert.equal(S.dedupe(rows).length, 2);
	}
});

test("Crossref retains native keyword rank and recovers valid publication dates, never deposit dates", async () => {
	const rows = await S.search("crossref", { keywords: "research", maxResults: 10 }, { getJSON: async () => ({ message: {
		"total-results": 3, items: [
			{ DOI: "10.1234/first", title: ["Research systems"], published: { "date-parts": [[2024, 3, 1]] } },
			{ DOI: "10.1234/exact", title: ["Research"], "published-online": { "date-parts": [[2023]] } },
			{ DOI: "10.1234/undated", title: ["Research methods"], created: { "date-parts": [[2025]] } }
		] } }) }, context());
	assert.deepEqual(rows.map(row => row.doi), ["10.1234/first", "10.1234/exact", "10.1234/undated"]);
	assert.deepEqual(rows.map(row => row.year), [2024, 2023, null]);
});

test("unsupported negative arXiv and structured Semantic Scholar queries fail before requests", async () => {
	for (const [source, title] of [["arxiv", "NOT cancer"], ["arxiv", "genome OR NOT cancer"], ["semanticscholar", "cancer OR genome"]]) {
		let calls = 0;
		await assert.rejects(S.search(source, { title }, { getJSON: async () => { calls++; }, getText: async () => { calls++; } }, context()), /positive|does not support/);
		assert.equal(calls, 0);
	}
});

test("late provider failures retain already published pages and mark the source incomplete", async () => {
	const ctx = context();
	const rows = await S.search("multi", { keywords: "research", sources: ["openalex", "crossref"], maxResults: 1000 }, { getJSON: async url => {
		const u = new URL(url);
		if (u.hostname === "api.crossref.org") return { message: { items: [], "total-results": 0 } };
		if (u.searchParams.get("page") === "1") return { results: Array.from({ length: 200 }, (_, i) => oa(i)), meta: { count: 1000 } };
		throw new Error("connection interrupted");
	} }, ctx);
	assert.equal(rows.length, 200);
	assert.equal(ctx.sourceStatus.openalex.truncated, true);
	assert.match(ctx.errors[0], /connection interrupted/);
});

test("Crossref pure negative OR branches do not inherit another branch's positive seed", async () => {
	const rows = await S.search("crossref", { title: "cancer OR NOT genome", maxResults: 10 }, { getJSON: async url => {
		assert.equal(new URL(url).searchParams.has("query.bibliographic"), false);
		return { message: { "total-results": 3, items: ["cancer genome", "bacterial systems", "genome engineering"].map((title, i) => ({ ...cr(i), title: [title] })) } };
	} }, context());
	assert.deepEqual(rows.map(row => row.title), ["cancer genome", "bacterial systems"]);
});


test("transient fetch failures retry once recovered and preserve the successful result", async () => {
	let calls = 0;
	const rows = await acceleratedSources().search("openalex", { keywords: "research", maxResults: 1 }, { getJSON: async () => {
		if (++calls === 1) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
		return { results: [oa(1)], meta: { count: 1 } };
	} }, context());
	assert.equal(calls, 2); assert.equal(rows.length, 1);
});

test("aborting a transient fetch failure prevents its retry", async () => {
	let calls = 0; const controller = new AbortController();
	await assert.rejects(S.search("openalex", { keywords: "research", maxResults: 1 }, { getJSON: async () => {
		calls++; controller.abort(); throw new TypeError("fetch failed");
	} }, { ...context(), signal: controller.signal }), { name: "AbortError" });
	assert.equal(calls, 1);
});

test("Combined refills when cross-source identifier bridges collapse its entire initial pool", async () => {
	const starts = []; const ctx = context();
	const rows = await S.search("multi", { keywords: "research", sources: ["openalex", "europepmc"], maxResults: 2000 }, { getJSON: async url => {
		const u = new URL(url), p = u.searchParams;
		if (u.hostname === "api.openalex.org") {
			const size = Number(p.get("per-page")), start = (Number(p.get("page")) - 1) * size;
			starts.push(start);
			return { meta: { count: 4400 }, results: Array.from({ length: Math.min(size, 4400 - start) }, (_, i) => {
				const n = start + i, group = Math.floor(n / 3), part = n % 3;
				const base = { id: `https://openalex.org/W${n}`, title: `Research record number ${n}`, publication_year: 2024 };
				if (n >= 2200) return { ...base, doi: `10.1234/extra${n}` };
				return { ...base, doi: part === 0 ? `10.1234/group${group}` : null,
					ids: part === 1 ? { pmid: String(group + 1) } : part === 2 ? { pmcid: `PMC${group + 1}` } : {} };
			}) };
		}
		const start = p.get("cursorMark") === "*" ? 0 : Number(p.get("cursorMark")), size = Number(p.get("pageSize"));
		return { hitCount: 734, nextCursorMark: String(start + size), resultList: { result: Array.from({ length: Math.min(size, 734 - start) }, (_, i) => {
			const group = start + i;
			return { id: String(group + 1), doi: `10.1234/group${group}`, pmid: String(group + 1), pmcid: `PMC${group + 1}`, title: `Bridging research ${group}`, pubYear: "2024" };
		}) } };
	} }, ctx);
	assert.equal(starts.filter(start => start === 0).length, 2, "the initial pool was exhausted, then refilled after identity fusion");
	assert.equal(starts.at(-1), 4200);
	assert.equal(rows.length, 2000);
	assert.equal(new Set(rows.map(row => row.key)).size, 2000);
	assert.equal(ctx.errors.length, 0);
});

test("cancelling after the first large page keeps its snapshot and schedules no second request", async () => {
	const controller = new AbortController(); let calls = 0, shown = [];
	await assert.rejects(S.search("openalex", { keywords: "research", maxResults: 2000 }, { getJSON: async () => {
		calls++; return { results: Array.from({ length: 200 }, (_, i) => oa(i)), meta: { count: 2000 } };
	} }, { ...context(), signal: controller.signal, onResults(rows) { shown = rows; controller.abort(); } }), { name: "AbortError" });
	assert.equal(calls, 1); assert.equal(shown.length, 200);
});

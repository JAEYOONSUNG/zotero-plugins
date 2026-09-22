import { test } from "node:test";
import assert from "node:assert/strict";
import S from "../content/sources.js";

const context = () => ({ enrichCitations: false, journalMetrics: false, institutionMetrics: false });

// One real paper, as each source would describe it.
const DOI = "10.1038/s41467-020-19056-6";
const PMID = "33060576";
const PMCID = "PMC7562722";
const ARXIV = "1706.03762";

const openAlexWork = (extra = {}) => ({
	id: "https://openalex.org/W3091", doi: "https://doi.org/" + DOI, title: "Attention and transport in bacteria",
	publication_year: 2020, authorships: [{ author: { display_name: "Alice Smith" } }],
	ids: { pmid: "https://pubmed.ncbi.nlm.nih.gov/" + PMID, pmcid: PMCID }, ...extra
});
const crossrefWork = () => ({ DOI, title: ["Attention and transport in bacteria"],
	author: [{ given: "Alice", family: "Smith" }], issued: { "date-parts": [[2020]] }, type: "journal-article" });
const epmcWork = () => ({ id: "MED123", doi: DOI, title: "Attention and transport in bacteria",
	pubYear: "2020", pmid: PMID, pmcid: PMCID, source: "MED" });

function recorder(answer) {
	const urls = [];
	return { urls,
		async getJSON(url) { urls.push(url); return answer(url, "json") ?? {}; },
		async getText(url) { urls.push(url); return answer(url, "text") ?? ""; } };
}

test("a pasted DOI is looked up, not searched for as a phrase", async () => {
	// Crossref answered the free-text form of this query with 6,528,758 candidates and
	// none of the first thirty were the paper.
	const http = recorder(url => {
		if (url.includes("api.openalex.org/works")) return { results: [openAlexWork()], meta: { count: 1 } };
		if (url.includes("api.crossref.org")) return { message: { "total-results": 1, items: [crossrefWork()] } };
		if (url.includes("europepmc")) return { hitCount: 1, resultList: { result: [epmcWork()] } };
		return {};
	});
	for (const source of ["openalex", "crossref", "europepmc"]) {
		const ctx = context();
		const rows = await S.search(source, { keywords: DOI, maxResults: 30 }, http, ctx);
		assert.equal(rows.length, 1, source + " returns the one paper");
		assert.equal(rows[0].doi, DOI);
	}
	assert.ok(http.urls.some(u => u.includes("filter=doi%3A" + encodeURIComponent(DOI)) || u.includes("filter=doi:" + DOI)),
		"OpenAlex and Crossref ask for the DOI as a filter");
	assert.ok(http.urls.some(u => u.includes(encodeURIComponent('DOI:"' + DOI + '"'))), "Europe PMC asks its DOI field");
	assert.ok(!http.urls.some(u => u.includes("query=10.1038") || u.includes("search=10.1038")),
		"no source receives the DOI as free text");
});

test("a DOI in the title box is a lookup too, and the other boxes do not narrow it", async () => {
	const http = recorder(() => ({ results: [openAlexWork()], meta: { count: 1 } }));
	const rows = await S.search("openalex", { title: "  " + DOI + "  ", authors: "Someone Else", yearFrom: 1990, maxResults: 30 }, http, context());
	assert.equal(rows.length, 1);
	assert.ok(!http.urls.some(u => u.includes("raw_author_name")), "the author box is not applied to a lookup");
});

test("a pasted PMID, PMCID and arXiv id each reach the field that holds them", async () => {
	const asked = [];
	const http = {
		async getJSON(url) {
			asked.push(url);
			if (url.includes("esearch")) return { esearchresult: { count: "1", idlist: [PMID] } };
			if (url.includes("esummary")) return { result: { uids: [PMID], [PMID]: { title: "Attention and transport in bacteria",
				articleids: [{ idtype: "doi", value: DOI }, { idtype: "pmc", value: PMCID }], authors: [{ name: "Smith A" }], pubdate: "2020" } } };
			if (url.includes("europepmc")) return { hitCount: 1, resultList: { result: [epmcWork()] } };
			return { results: [openAlexWork()], meta: { count: 1 } };
		},
		async getText(url) {
			asked.push(url);
			return `<feed><opensearch:totalResults>1</opensearch:totalResults><entry><id>http://arxiv.org/abs/${ARXIV}v5</id>`
				+ `<title>Attention is all you need</title><published>2017-06-12T00:00:00Z</published>`
				+ `<summary>A transformer</summary><author><name>Ashish Vaswani</name></author></entry></feed>`;
		}
	};
	const byPmid = await S.search("pubmed", { keywords: PMID, maxResults: 30 }, http, context());
	assert.equal(byPmid.length, 1);
	assert.ok(asked.some(u => u.includes(encodeURIComponent(PMID + "[uid]"))), "PubMed is asked for the unique identifier");

	const byPmcid = await S.search("europepmc", { keywords: PMCID, maxResults: 30 }, http, context());
	assert.equal(byPmcid.length, 1);
	assert.ok(asked.some(u => u.includes(encodeURIComponent("PMCID:" + PMCID))));

	const byArxiv = await S.search("arxiv", { keywords: "arXiv:" + ARXIV + "v5", maxResults: 30 }, http, context());
	assert.equal(byArxiv.length, 1);
	assert.ok(asked.some(u => u.includes("id_list=" + ARXIV)), "arXiv is asked by id_list, not by a text search");

	const ctx = context();
	const arxivByDoi = await S.search("arxiv", { keywords: DOI, maxResults: 30 }, http, ctx);
	assert.deepEqual(arxivByDoi, []);
	assert.ok(ctx.errors.some(e => /arXiv can only be searched by an arXiv identifier/.test(e)),
		"a source without that index says so instead of reporting an empty library");
});

test("a lookup keeps only the paper that carries the identifier", async () => {
	const other = openAlexWork({ id: "https://openalex.org/W99", doi: "https://doi.org/10.1234/unrelated", ids: {} });
	const http = recorder(() => ({ results: [other, openAlexWork()], meta: { count: 2 } }));
	const rows = await S.search("openalex", { keywords: DOI, maxResults: 30 }, http, context());
	assert.deepEqual(rows.map(r => r.doi), [DOI]);
});

test("PubMed widens a title around the words it does not index, and says so", () => {
	// The live failure: a real paper whose title contains "into" came back as nothing.
	const term = S.pubmedTerm({ title: "Transport of glucose into the cell" });
	assert.ok(!/into\[ti\]/.test(term), "the stopword is not sent as a title atom");
	assert.ok(/transport\[ti\]/i.test(term) && /glucose\[ti\]/i.test(term), "the distinctive words still are");
	// A number standing alone is not indexed in [ti] either: "Cas 9" found nothing.
	assert.ok(!/\b9\[ti\]/.test(S.pubmedTerm({ title: "CRISPR Cas 9 editing" })));
});

test("PubMed asks again without the terms it reports it cannot find", async () => {
	const terms = [];
	const http = {
		async getJSON(url) {
			if (url.includes("esearch")) {
				const term = new URL(url).searchParams.get("term");
				terms.push(term);
				if (terms.length === 1) return { esearchresult: { count: "0", idlist: [], errorlist: { phrasesnotfound: ["recombineering"] } } };
				return { esearchresult: { count: "1", idlist: ["25074379"] } };
			}
			return { result: { uids: ["25074379"], 25074379: { title: "CRISPR Cas9 assisted recombineering", authors: [{ name: "Oh J" }], pubdate: "2014" } } };
		}
	};
	const ctx = context();
	const rows = await S.search("pubmed", { title: "CRISPR Cas9 assisted recombineering", maxResults: 10 }, http, ctx);
	assert.equal(terms.length, 2, "the query is reissued once");
	assert.ok(!/recombineering/.test(terms[1]), "without the term PubMed said it does not hold");
	assert.equal(rows.length, 1);
	assert.ok(ctx.errors.some(e => /does not index recombineering/.test(e)), "and the widening is disclosed");
});

test("an arXiv title with a colon is not read as a field prefix", async () => {
	let asked = "";
	const http = { async getText(url) { asked = decodeURIComponent(url); return "<feed><opensearch:totalResults>0</opensearch:totalResults></feed>"; } };
	await S.search("arxiv", { title: "Thermostable enzymes: structure-function relationships", maxResults: 10 }, http, context());
	assert.ok(!/ enzymes:/.test(asked), "the subtitle word is not sent as a bare native field");
	assert.ok(/ti:"?enzymes/.test(asked), "it is sent as a title term");
});

test("Europe PMC receives a byline the way it indexes one", () => {
	assert.equal(S.epmcQuery({ authors: "Jae Yoon Sung" }), '(AUTH:"Sung Jae Yoon" OR AUTH:"Sung JY")');
	// "Sung JY" is the form the Authors box suggests; the surname is still first.
	assert.equal(S.epmcQuery({ authors: "Sung JY" }), '(AUTH:"Sung JY" OR AUTH:"Sung J")');
});

test("Lucene metacharacters in a title travel quoted", () => {
	const query = S.epmcQuery({ title: "Bacterial growth at -10 C" });
	assert.ok(/TITLE:"-10"/.test(query), "a leading minus is not sent as a Lucene NOT");
});

test("an arXiv posting and its OpenAlex copy are one paper", () => {
	const merged = S.mergeRecords([[S.makeRecord({ source: "arxiv", sourceId: ARXIV, arxiv: ARXIV + "v2", title: "Attention is all you need" })],
		[S.makeRecord({ source: "openalex", sourceId: "W1", doi: "10.48550/arXiv." + ARXIV, title: "Attention Is All You Need (v3)" })]]);
	assert.equal(merged.length, 1, "the DOI arXiv registers for a posting identifies that posting");
});

test("a short title is not merged across venues that disagree", () => {
	const row = (source, venue) => S.makeRecord({ source, sourceId: source + "1", title: "Deep learning", year: 2015, venue,
		authors: [{ firstName: "Yann", lastName: "LeCun", name: "Yann LeCun" }] });
	assert.equal(S.mergeRecords([[row("crossref", "Nature")], [row("openalex", "ICML Tutorials")]]).length, 2);
	assert.equal(S.mergeRecords([[row("crossref", "Nature")], [row("openalex", "Nature")]]).length, 1);
});

test("Europe PMC asks again when the body arrives empty", async () => {
	// Observed live: HTTP 200 with a 17-byte body, while the control request reported
	// 10,784 hits. Read as an empty result set it becomes a silent "no such paper".
	let calls = 0;
	const paper = { ...epmcWork(), title: "Phage defence systems in Bacillus" };
	const http = { async getJSON() { calls++; return calls === 1 ? {} : { hitCount: 1, resultList: { result: [paper] } }; } };
	const rows = await S.search("europepmc", { keywords: "phage defence", maxResults: 10 }, http, context());
	assert.equal(calls, 2);
	assert.equal(rows.length, 1);
});

test("a provider's Retry-After is waited out rather than guessed at", async () => {
	const slept = [];
	const original = globalThis.setTimeout;
	globalThis.setTimeout = (fn, ms) => { slept.push(ms); return original(fn, 0); };
	try {
		let calls = 0;
		const http = { async getJSON() {
			if (++calls === 1) throw Object.assign(new Error("Too many requests"), { status: 429, retryAfter: 7 });
			return { message: { "total-results": 1, items: [crossrefWork()] } };
		} };
		const rows = await S.search("crossref", { keywords: "bacterial transport", maxResults: 10 }, http, context());
		assert.equal(rows.length, 1);
		assert.ok(slept.some(ms => ms === 7000), "the wait the provider asked for, not the default 1500 ms");
	}
	finally { globalThis.setTimeout = original; }
});

test("citation counts that could not be fetched are reported, not left blank in silence", async () => {
	const ctx = { journalMetrics: false, institutionMetrics: false };
	const http = { async getJSON(url) {
		if (url.includes("filter=doi:")) throw Object.assign(new Error("Daily budget exhausted"), { status: 402 });
		if (url.includes("esearch")) return { esearchresult: { count: "1", idlist: [PMID] } };
		return { result: { uids: [PMID], [PMID]: { title: "Attention and transport in bacteria", pubdate: "2020",
			articleids: [{ idtype: "doi", value: DOI }], authors: [{ name: "Smith A" }] } } };
	} };
	await S.search("pubmed", { keywords: "bacterial transport", maxResults: 10 }, http, ctx);
	assert.ok(ctx.errors.some(e => /Citation counts are unavailable/.test(e)));
});

test("an undated Google Scholar row survives a year range Scholar already applied", () => {
	const dated = S.makeRecord({ source: "scholar", sourceId: "a", title: "Bacterial transport", year: 2001 });
	const undated = S.makeRecord({ source: "scholar", sourceId: "b", title: "Bacterial transport in soil" });
	const kept = S.filterRecords([dated, undated], { yearFrom: 2010, yearTo: 2024 });
	assert.deepEqual(kept.map(r => r.sourceId), ["b"]);
});

test("OpenAlex names the people a written name resolved to", async () => {
	const http = { async getJSON(url) {
		if (url.includes("/authors?")) return { meta: { count: 2 }, results: [
			{ id: "https://openalex.org/A1", display_name: "Jae Yoon Sung", works_count: 41,
				last_known_institutions: [{ display_name: "Yonsei University" }] },
			{ id: "https://openalex.org/A2", display_name: "Jae-Yoon Sung", works_count: 88,
				last_known_institutions: [{ display_name: "Sungkyunkwan University" }] }] };
		return { results: [], meta: { count: 0 } };
	} };
	const ctx = context();
	await S.search("openalex", { authors: "Jae Yoon Sung", maxResults: 10 }, http, ctx);
	assert.ok(ctx.errors.some(e => /2 author profiles match this name/.test(e) && /Yonsei University/.test(e) && /Sungkyunkwan/.test(e)),
		"both people are named, with where they work");
});

test("a comma in a title cannot break an OpenAlex filter apart", async () => {
	let asked = "";
	const http = { async getJSON(url) { asked = decodeURIComponent(url); return { results: [], meta: { count: 0 } }; } };
	await S.search("openalex", { title: "Growth, survival and death of bacteria", maxResults: 10 }, http, context());
	const filter = /filter=([^&]*)/.exec(asked)[1];
	assert.equal(filter.split(",").length, 1, "the filter list still has one entry");
	assert.ok(!filter.includes("|"));
});

test("PubMed is asked again with a split number joined back on", async () => {
	// Live: the title typed "CRISPR Cas 9 ..." asked for Cas[ti] and found nothing,
	// because PubMed holds "CRISPR-Cas9" as one word. PMID 25074379 is the paper.
	const terms = [];
	const http = {
		async getJSON(url) {
			if (url.includes("esearch")) {
				terms.push(new URL(url).searchParams.get("term"));
				return terms.length === 1
					? { esearchresult: { count: "0", idlist: [] } }
					: { esearchresult: { count: "1", idlist: ["25074379"] } };
			}
			return { result: { uids: ["25074379"], 25074379: { title: "CRISPR-Cas9-assisted recombineering in Lactobacillus reuteri",
				authors: [{ name: "Oh J" }], pubdate: "2014" } } };
		}
	};
	const rows = await S.search("pubmed", { title: "CRISPR Cas 9 assisted recombineering in Lactobacillus reuteri", maxResults: 10 }, http, context());
	assert.equal(terms.length, 2, "one widening, not a loop");
	assert.ok(/Cas9\[ti\]/.test(terms[1]), "the second ask joins the number to the word before it");
	assert.equal(rows.length, 1);
	assert.equal(rows[0].pmid, "25074379");
});

test("a number after a short or unindexed word is left alone", async () => {
	const terms = [];
	const http = { async getJSON(url) {
		if (url.includes("esearch")) { terms.push(new URL(url).searchParams.get("term")); return { esearchresult: { count: "0", idlist: [] } }; }
		return { result: {} };
	} };
	await S.search("pubmed", { title: "Bacterial growth at 10 C", maxResults: 10 }, http, context());
	// Nothing to join, so nothing is asked twice: "at 10" must not become "at10".
	assert.equal(terms.length, 1);
	assert.ok(!/at10/.test(terms[0]));
});

test("a combined search resolves a pasted DOI once per source and merges the answers", async () => {
	const urls = [];
	const http = {
		async getJSON(url) {
			urls.push(url);
			if (url.includes("openalex")) return { results: [openAlexWork()], meta: { count: 1 } };
			if (url.includes("crossref")) return { message: { "total-results": 1, items: [crossrefWork()] } };
			if (url.includes("europepmc")) return { hitCount: 1, resultList: { result: [epmcWork()] } };
			return {};
		},
		async getText(url) { urls.push(url); return "<feed><opensearch:totalResults>0</opensearch:totalResults></feed>"; }
	};
	const ctx = context();
	const rows = await S.search("multi", { keywords: DOI, maxResults: 50 }, http, ctx);
	assert.equal(rows.length, 1, "three sources describing one paper are one row");
	assert.deepEqual(rows[0].sources.sort(), ["crossref", "europepmc", "openalex"]);
	assert.ok(urls.length <= 5, "and it costs one request per source, not a paging walk: " + urls.length);
});

test("a field tag written inside a title in capitals survives the prose rule", () => {
	// The parser reads an all-capital title as prose and lowercases it. The internal
	// placeholder that carries a fielded atom used to be all capitals too, so
	// "CRISPR[All Fields] AND EDITING" looked like prose and lost both its atom and
	// its AND, going out as the literal word "zotpopfield0".
	const term = S.pubmedTerm({ title: "CRISPR[All Fields] AND EDITING IN BACTERIA" });
	assert.ok(/CRISPR\[All Fields\]/.test(term), "the atom the user wrote is still there");
	assert.ok(!/zotpopfield/i.test(term), "and no placeholder leaked into the query");
	assert.ok(/EDITING\[ti\]/.test(term), "AND is still an operator, so the words stay separate atoms");
	// A capitalised title with no field tag is still read as prose.
	assert.ok(/why\[ti\]/.test(S.pubmedTerm({ title: "WHY NOT TO USE ANTIBIOTICS IN FARMING" })));
});

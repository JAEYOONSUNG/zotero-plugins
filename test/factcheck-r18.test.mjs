/* Round 18 fact-check: five real searches run through these modules against the live services and the user's
   library (2026-10-06): a topic search, Nature Microbiology 2025, a followed author (Pablo I. Nikel), a DOI paste
   and a PMID paste. Every fixture is a real answer, trimmed to the fields the code reads
   (factcheck-r18.fixtures.json). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import Related from "../content/related.js";
import Filters from "../content/filters.js";

const FX = JSON.parse(readFileSync(new URL("./factcheck-r18.fixtures.json", import.meta.url), "utf8"));
const quiet = { journalMetrics: false, institutionMetrics: false };
const clone = value => JSON.parse(JSON.stringify(value));

// Each test gets its own module, so no cache of one answers for another.
function freshSources() {
	const module = { exports: {} };
	vm.runInNewContext(readFileSync(new URL("../content/sources.js", import.meta.url), "utf8"), {
		module, require: createRequire(new URL("../content/sources.js", import.meta.url)),
		setTimeout: fn => setTimeout(fn, 0), clearTimeout, setInterval, clearInterval, URL, URLSearchParams
	});
	return module.exports;
}

function pasteHttp() {
	const asked = [];
	const answer = url => {
		asked.push(url);
		const u = new URL(url);
		if (u.host === "api.openalex.org" && u.pathname === "/works") return { meta: { count: 1 }, results: [clone(FX.doiOpenAlex)] };
		if (u.host === "api.openalex.org") return { meta: { count: 0 }, results: [] };
		if (u.host === "api.crossref.org") return { message: { "total-results": 1, items: [clone(FX.doiCrossref)] } };
		if (u.host === "www.ebi.ac.uk") return { hitCount: 1, resultList: { result: [clone(FX.doiEpmc)] } };
		throw new Error("unexpected request " + url);
	};
	return { asked, getJSON: async url => answer(url), getText: async url => { asked.push(url); throw new Error("arXiv was asked: " + url); } };
}

test("a DOI or PMID pasted into the default combined search is not reported as an incomplete run", async () => {
	for (const pasted of ["https://doi.org/10.1111/1462-2920.13434", "27348295"]) {
		const S = freshSources(), http = pasteHttp(), ctx = { ...quiet };
		const rows = await S.search("multi", { keywords: pasted, sources: ["openalex", "crossref", "europepmc", "arxiv"] }, http, ctx);
		assert.equal(rows.length, 1, pasted);
		assert.equal(rows[0].doi, "10.1111/1462-2920.13434");
		// The live run said "arXiv can only be searched by an arXiv identifier, not by a DOI" (and, for the PMID,
		// "Crossref cannot look up a PMID"), and the window called the run incomplete.
		assert.deepEqual(clone(ctx.errors), [], pasted + ": " + ctx.errors.join(" | "));
		assert.ok(!http.asked.some(u => u.includes("arxiv.org")), "arXiv is not asked about a " + (pasted.includes("doi") ? "DOI" : "PMID"));
		if (!pasted.includes("doi")) assert.ok(!http.asked.some(u => u.includes("api.crossref.org")), "Crossref is not asked about a PMID");
	}
});

test("asked on its own, a source that cannot look up the identifier still says so", async () => {
	const S = freshSources(), ctx = { ...quiet };
	assert.deepEqual(clone(await S.search("crossref", { keywords: "27348295" }, pasteHttp(), ctx)), []);
	assert.ok(ctx.errors.some(e => /Crossref cannot look up a PMID/.test(e)));
});

test("Crossref pages stay full-size when the local author check drops rows (Pablo I. Nikel: 90, 20, 12, 7, 4, 2 rows before)", async () => {
	const S = freshSources(), asked = [];
	const http = { getJSON: async url => {
		const u = new URL(url), rows = Number(u.searchParams.get("rows")), offset = Number(u.searchParams.get("offset"));
		asked.push([rows, offset]);
		return { message: { "total-results": FX.crossrefNikel.total, items: clone(FX.crossrefNikel.items.slice(offset, offset + rows)) } };
	} };
	// What a 30-result combined search asks Crossref for: a pool of 90.
	const rows = await S.search("crossref", { authors: "Pablo I. Nikel", maxResults: 90 }, http, { ...quiet });
	assert.deepEqual(FX.crossrefNikel.asked.map(a => a[0]), [90, 20, 12, 7, 4, 2], "the shrinking pages the live run made");
	assert.ok(asked.every(([n]) => n === 90), "every page asks for the full 90: " + JSON.stringify(asked));
	assert.equal(asked.length, 2);
	assert.ok(rows.length > 0 && rows.every(r => r.authors.some(a => /nikel/i.test(a.lastName || a.name))));
});

test("no provider sizes its page by the rows still missing", () => {
	const src = readFileSync(new URL("../content/sources.js", import.meta.url), "utf8");
	assert.ok(!/(?:rows|limit|pageSize|\bn) = Math\.min\([^;]*max - out\.length/.test(src), "a page sized by the remainder shrinks to one row at a time");
});

test("Crossref 'component' records (supplementary files, figures) are not listed as papers", async () => {
	const S = freshSources();
	const components = FX.crossrefTopic.items.filter(i => i.type === "component").map(i => i.DOI.toLowerCase());
	assert.equal(components.length, 10, "ten of the sixty live answers");
	assert.ok(components.includes("10.1021/acs.jafc.1c03240.s001") && components.includes("10.7717/peerj.6046/fig-1"));
	const http = { getJSON: async url => {
		const offset = Number(new URL(url).searchParams.get("offset"));
		return { message: { "total-results": 60, items: offset ? [] : clone(FX.crossrefTopic.items) } };
	} };
	const rows = await S.search("crossref", { keywords: "Pseudomonas putida metabolic engineering", maxResults: 60 }, http, { ...quiet });
	assert.ok(rows.length >= 40);
	assert.ok(!rows.some(r => components.includes(r.doi)), "no supplementary file or figure among the results");
	// Each came undated, under its paper's own title, typed as a journal article. The undated rows left are
	// theses and two BSI standards, and the standards are not counted as articles.
	assert.deepEqual(clone(rows.filter(r => !r.year && Filters.typeOf(r) === "article").map(r => r.doi)), []);
});

test("Europe PMC's correction notices are errata, not articles, and its affiliations lose the e-mail addresses", async () => {
	const S = freshSources();
	const http = { getJSON: async () => ({ hitCount: 4, resultList: { result: clone(FX.epmcNatMicro) } }) };
	const rows = await S.search("europepmc", { venue: "Nature Microbiology", yearFrom: 2025, yearTo: 2025, maxResults: 4 }, http, { ...quiet });
	const by = doi => rows.find(r => r.doi === doi);
	for (const doi of ["10.1038/s41564-025-02188-0", "10.1038/s41564-025-02163-9"]) {
		assert.equal(by(doi).workType, "erratum", doi + " is a Published Erratum");
		assert.equal(Filters.typeOf(by(doi)), "other", "and is not counted as an article");
	}
	assert.equal(Filters.typeOf(by("10.1038/s41564-025-02167-5")), "article");
	const labs = rows.flatMap(r => (r.people || []).map(p => p.institution)).filter(Boolean);
	assert.ok(labs.length > 3);
	assert.ok(!labs.some(l => l.includes("@")), labs.find(l => l.includes("@")));
	const last = by("10.1038/s41564-025-02188-0").people.at(-1);
	assert.equal(last.institution, "State Key Laboratory of Molecular Oncology, Tsinghua-Peking Center for Life Sciences, School of Life Sciences, Tsinghua University, Beijing, China.");
});

test("no journal figure for a preprint server, a repository or an ebook platform; journals keep theirs", async () => {
	const S = freshSources();
	const http = { getJSON: async url => ({ results: clone(FX.sourcesTyped).filter(s => url.includes(s.id.split("/").pop())) }) };
	const rec = (journalId, venue, itemType) => S.makeRecord({ source: "openalex", sourceId: "W1", title: venue + " paper", journalId, venue, itemType });
	const rows = [
		rec("S4306402567", "bioRxiv (Cold Spring Harbor Laboratory)", "preprint"),
		rec("S7407053192", "The University of Queensland", "thesis"),
		rec("S4306463937", "Springer eBooks", "bookSection"),
		rec("S4210172589", "SSRN Electronic Journal", "journalArticle"),
		rec("S2764926557", "Nature Microbiology", "journalArticle")
	];
	await S.enrichJournalMetrics(rows, http, { jcr: false });
	// Live, these read ~0.93, ~0.09, ~0.45 and ~0.20 in the OpenAlex 2-year column.
	assert.deepEqual(clone(rows.slice(0, 4).map(r => r.journalOA2y)), [null, null, null, null]);
	assert.deepEqual(clone(rows.slice(0, 4).map(r => r.journalH)), [null, null, null, null]);
	assert.equal(Math.round(rows[4].journalOA2y * 100) / 100, 17.29);
	assert.equal(rows[4].journalH, 234);
});

test("a saved journal answer without the source's type is asked again (the user's cache held bioRxiv at 0.93)", () => {
	const S = freshSources(), now = 1790342186589 + 86400000;
	const typed = ["S2764926557", { id: "S2764926557", name: "Nature Microbiology", if2y: 17.29, h: 234, kind: "journal" }, now - 86400000];
	assert.equal(S.importCaches({ version: 1, savedAt: new Date(now).toISOString(), journals: [clone(FX.cachedBioRxiv), typed], institutions: [] }, now), 1);
	assert.deepEqual(clone(S.exportCaches().journals.map(e => e[0])), ["S2764926557"]);
});

test("a row another index found is completed from OpenAlex: yearly citations, institutions, and both counts kept", async () => {
	const S = freshSources();
	const asked = [];
	const http = { getJSON: async url => {
		asked.push(url);
		const u = new URL(url);
		if (u.host === "api.crossref.org") return { message: { "total-results": 1, items: clone(FX.crossrefNatMicro) } };
		if (u.host === "www.ebi.ac.uk") return { hitCount: 1, resultList: { result: clone(FX.epmcNatMicro.filter(r => r.doi === "10.1038/s41564-025-02167-5")) } };
		if (u.pathname === "/works" && u.searchParams.get("filter").startsWith("doi:")) return { meta: { count: 2 }, results: clone(FX.enrichNatMicro) };
		// OpenAlex's own search did not return this paper.
		return { meta: { count: 0 }, results: [] };
	} };
	const rows = await S.search("multi", { venue: "Nature Microbiology", venues: [{ name: "Nature Microbiology", issns: ["2058-5276"] }], yearFrom: 2025, yearTo: 2025, maxResults: 20,
		sources: ["openalex", "crossref", "europepmc"] }, http, { ...quiet });
	const r = rows.find(x => x.doi === "10.1038/s41564-025-02167-5");
	assert.ok(r, "found by Crossref and Europe PMC");
	assert.ok(!r.sources.includes("openalex"));
	assert.deepEqual(clone(r.citationsBy), { crossref: 5, europepmc: 2, openalex: 3 }, "each index's own count");
	assert.equal(r.citations, 5, "the headline is still the highest");
	assert.deepEqual(clone(r.citesByYear), [{ year: 2026, n: 3 }], "OpenAlex's yearly counts for the trend");
	assert.ok(r.people.some(p => p.institutionId && p.country === "US"), "institutions with ids, for the tier and the country");
	assert.equal(asked.filter(u => u.includes("/works?filter=doi:")).length, 1, "one batched request");
});

test("a result the window already marks as held (by title, without a DOI) is flagged, not ranked against the library", async () => {
	// Held paper 3882 (10.1111/1462-2920.13434, W2460825526) cites W2027179841, live and in Style Custom's stored list.
	const held = [{ itemID: 3882, title: "Pyridine nucleotide transhydrogenases enable redox balance of Pseudomonas putida", doi: "10.1111/1462-2920.13434", openalex: "W2460825526", refs: ["W2027179841", "W1588066949"] }];
	const result = { key: "r1", source: "openalex", sourceId: "W2027179841", title: "Engineering an anaerobic metabolic regime in Pseudomonas putida KT2440", year: 2012 };
	const http = { getJSON: async () => { throw new Error("no request is needed"); } };
	const sources = { normalizeDOI: v => String(v || "").toLowerCase() || null, withRetry: fn => fn(), openAlexAuth: () => "" };
	const store = Related.createStore();
	store.putWork({ id: "W2027179841", referenced_works: [] }, sources);
	const ranked = await Related.rank({ held, results: [result], http, sources, store, ctx: { pause: () => Promise.resolve() } });
	assert.equal(ranked.scores.get("r1").band, "strong", "unmarked, it is ranked: one of yours cites it");
	const marked = await Related.rank({ held, results: [{ ...result, heldItemID: 912 }], http, sources, store, ctx: { pause: () => Promise.resolve() } });
	const s = marked.scores.get("r1");
	assert.equal(s.held, true);
	assert.equal(s.score, null);
	assert.equal(s.heldItemID, 912);
});

test("the CSV says which index each count is, the tier the table shows, and a retraction", async () => {
	const { paper, uiHarness } = await import("./helpers/search-ui-harness.mjs");
	const { default: I18N } = await import("../content/i18n.js");
	// 10.1038/s41564-024-01912-6 as the live search showed it: 88 from Crossref, first author at Cambridge (h 2004, T1),
	// corresponding author at Lisbon (h 617).
	const people = [
		{ name: "Qi Yin", position: "first", corresponding: false, institution: "University of Cambridge", institutionId: "I241749", country: "GB", institutionH: 2004 },
		{ name: "Ana Santos Almeida", position: "last", corresponding: true, institution: "University of Lisbon", institutionId: "I141596103", country: "PT", institutionH: 617 }];
	const ui = uiHarness({ realRows: true, search: async () => [
		paper("enterobacteriaceae", { title: "Ecological dynamics of Enterobacteriaceae in the human gut microbiome across global populations", doi: "10.1038/s41564-024-01912-6",
			year: 2025, citations: 88, citationSource: "crossref", source: "openalex", sources: ["openalex", "crossref"], people }),
		paper("withdrawn", { title: "A paper flagged retracted", citations: 3, citationSource: "openalex", source: "openalex", retracted: true })] });
	await ui.runSearch();
	const head = I18N.STRINGS.en.csvHead, ko = I18N.STRINGS.ko.csvHead;
	assert.equal(ko.length, head.length);
	const rows = ui.csvText().split("\n").slice(1).map(l => l.match(/"(?:[^"]|"")*"/g).map(c => c.slice(1, -1)));
	assert.ok(rows.every(r => r.length === head.length));
	const at = (row, name) => row[head.indexOf(name)];
	const [real, withdrawn] = [rows.find(r => at(r, "DOI") === "10.1038/s41564-024-01912-6"), rows.find(r => at(r, "Title") === "A paper flagged retracted")];
	assert.equal(at(real, "Citations"), "88");
	assert.match(at(real, "CitationSource"), /crossref/i, "the count is Crossref's, not OpenAlex's");
	assert.equal(at(real, "Tier"), "T1", "the better of the two labs, as the Tier column shows");
	assert.equal(at(real, "Retracted"), "");
	assert.equal(at(withdrawn, "Retracted"), "csvYes");
});

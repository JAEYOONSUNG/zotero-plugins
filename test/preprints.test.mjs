// The preprint archives: Europe PMC (SRC:PPR), Crossref (type:posted-content), arXiv and OSF.
import { test } from "node:test";
import assert from "node:assert/strict";
import S from "../content/sources.js";

const ctx = { enrichCitations: false, journalMetrics: false, log: () => {} };

// Shapes copied from live responses, trimmed to the fields the adapters read.
const epmc = (id, title, extra = {}) => ({
	id, title, source: "PPR", pubYear: "2025", firstPublicationDate: "2025-03-04",
	bookOrReportDetails: { publisher: "bioRxiv" }, doi: "10.1101/" + id, ...extra
});
const posted = (doi, title, host, extra = {}) => ({
	DOI: doi, title: [title], type: "posted-content", subtype: "preprint",
	resource: { primary: { URL: "https://www." + host + "/content/" + doi } },
	posted: { "date-parts": [[2025, 3, 4]] }, author: [{ given: "Ada", family: "Byrne" }], ...extra
});
const osfItem = (id, title, provider = "bioHackrXiv", extra = {}) => ({
	id, type: "preprints",
	attributes: { title, date_published: "2025-03-04T09:00:00.000000", description: "", ...extra },
	links: { html: "https://osf.io/preprints/x/" + id + "/", preprint_doi: "https://doi.org/10.31219/osf.io/" + id },
	embeds: {
		provider: { data: { id: provider.toLowerCase(), attributes: { name: provider } } },
		bibliographic_contributors: { data: [
			{ attributes: { index: 1 }, embeds: { users: { data: { attributes: { full_name: "Bo Kim", given_name: "Bo", family_name: "Kim" } } } } },
			{ attributes: { index: 0 }, embeds: { users: { data: { attributes: { full_name: "Ada Byrne", given_name: "Ada", family_name: "Byrne" } } } } }
		] }
	}
});
const arxivFeed = entries => `<feed><opensearch:totalResults>${entries.length}</opensearch:totalResults>${entries.map(e => `<entry>
	<id>http://arxiv.org/abs/${e.id}v1</id><title>${e.title}</title><published>2025-03-04T00:00:00Z</published>
	<summary>Abstract.</summary><author><name>Ada Byrne</name></author>${e.doi ? `<arxiv:doi>${e.doi}</arxiv:doi>` : ""}
	</entry>`).join("")}</feed>`;

// One transport for every archive, so a test only states what a given archive answered.
function archives({ epmc: ep = [], crossref = [], arxiv = [], osf = [], osfTotal, fail = [], onRequest } = {}) {
	const urls = [];
	const route = url => /europepmc/.test(url) ? "epmc" : /crossref/.test(url) ? "crossref"
		: /osf\.io/.test(url) ? "osf" : /arxiv/.test(url) ? "arxiv" : "other";
	const answer = url => {
		urls.push(new URL(url));
		const which = route(url);
		onRequest?.(which, new URL(url));
		if (fail.includes(which)) throw Object.assign(new Error(which + " unavailable"), { status: 500 });
		if (which === "epmc") return { resultList: { result: ep }, hitCount: ep.length };
		if (which === "crossref") return { message: { items: crossref, "total-results": crossref.length } };
		if (which === "osf") return { data: osf, links: { meta: { total: osfTotal ?? osf.length }, next: null } };
		if (which === "arxiv") return arxivFeed(arxiv);
		throw new Error("Unexpected request " + url);
	};
	return { urls, async getJSON(url) { return answer(url); }, async getText(url) { return answer(url); } };
}
const served = (urls, which) => urls.filter(u => u.href.includes(which));

test("every archive result names the server that holds it", async () => {
	const http = archives({
		epmc: [epmc("PPR1", "Ribosome engineering in Bacillus")],
		crossref: [posted("10.26434/chemrxiv-2025-aaa", "Ribosome engineering by acyl transfer", "chemrxiv.org",
			{ publisher: "American Chemical Society (ACS)" })],
		arxiv: [{ id: "2503.00001", title: "Ribosome engineering learned end to end" }],
		osf: [osfItem("aaa11", "Ribosome engineering notebooks")]
	});
	const records = await S.search("preprint", { keywords: "ribosome engineering", maxResults: 10 }, http, { ...ctx });
	assert.equal(records.length, 4);
	assert.ok(records.every(r => r.itemType === "preprint"), "each result is typed as a preprint");
	assert.deepEqual(records.map(r => r.preprintServer).sort(), ["ChemRxiv", "arXiv", "bioHackrXiv", "bioRxiv"]);
});

test("a publisher's own name never stands in for the archive it hosts", async () => {
	// Crossref lists ChemRxiv's publisher as the ACS and Preprints.org's as MDPI, so taking
	// the publisher would file both under a journal publisher rather than under an archive.
	const http = archives({ crossref: [
		posted("10.26434/chemrxiv-2025-bbb", "Catalysis A", "chemrxiv.org", { publisher: "American Chemical Society (ACS)" }),
		posted("10.20944/preprints202503.0001.v1", "Catalysis B", "preprints.org", { publisher: "MDPI AG" }),
		posted("10.64898/2025.03.04.700001", "Catalysis C", "biorxiv.org", { publisher: "openRxiv" })
	] });
	const records = await S.search("preprint", { keywords: "catalysis", maxResults: 10 }, http, { ...ctx });
	assert.deepEqual(records.map(r => r.preprintServer).sort(), ["ChemRxiv", "Preprints.org", "bioRxiv"]);
	assert.ok(records.every(r => r.venue === r.preprintServer), "the venue column shows the archive too");
});

test("a preprint the journals have since taken still reads as a preprint", async () => {
	const http = archives({
		crossref: [posted("10.1101/2024.08.30.610577", "Split reporters of protein interaction", "biorxiv.org", {
			publisher: "openRxiv",
			relation: { "is-preprint-of": [{ "id-type": "doi", id: "10.1073/pnas.2422085122" }] }
		})],
		epmc: [epmc("PPR2", "Recombinase specificity in vivo", {
			commentCorrectionList: { commentCorrection: [{ source: "MED", id: "38289242", type: "Preprint of" }] }
		})]
	});
	const records = await S.search("preprint", { keywords: "protein recombinase", maxResults: 10 }, http, { ...ctx });
	const byDoi = Object.fromEntries(records.map(r => [r.doi, r]));
	const crossref = byDoi["10.1101/2024.08.30.610577"], europepmc = byDoi["10.1101/ppr2"];
	assert.equal(crossref.publishedDoi, "10.1073/pnas.2422085122");
	assert.equal(europepmc.publishedPmid, "38289242");
	// The journal version is a different work with a different DOI. Reporting it must not
	// overwrite the posting's own DOI, nor promote the posting to a journal article.
	assert.equal(crossref.itemType, "preprint");
	assert.equal(crossref.preprintServer, "bioRxiv");
	assert.notEqual(crossref.doi, crossref.publishedDoi);
});

test("a posting is never reported as published as itself", async () => {
	// Crossref asserts is-preprint-of against a DOI that is occasionally the posting's own.
	// Left alone it would claim the paper had been published somewhere it had not.
	const http = archives({ crossref: [posted("10.1101/2025.03.04.700002", "Self referential posting", "biorxiv.org", {
		relation: { "is-preprint-of": [{ "id-type": "doi", id: "10.1101/2025.03.04.700002" }] }
	})] });
	const [record] = await S.search("preprint", { keywords: "self referential", maxResults: 5 }, http, { ...ctx });
	assert.equal(record.publishedDoi, null);
});

test("a posting is dated by when it went up, not by the journal issue that followed", async () => {
	const http = archives({ crossref: [posted("10.1101/2025.03.04.700003", "Thermophile genome engineering", "biorxiv.org", {
		issued: { "date-parts": [[2026, 11, 1]] }
	})] });
	const [record] = await S.search("preprint", { keywords: "thermophile genome", maxResults: 5 }, http, { ...ctx });
	assert.equal(record.publicationDate, "2025-03-04");
	assert.equal(record.year, 2025);
});

test("Crossref's other posted content is not passed off as a preprint", async () => {
	// posted-content also carries conference-abstract aggregators, preprint-highlights blogs
	// and news posts. Crossref marks those subtype "other"; nobody searching the archives
	// wants them back, and none of them is a paper.
	const http = archives({ crossref: [
		posted("10.1101/2025.03.04.700005", "Anti-phage defence systems", "biorxiv.org"),
		posted("10.14293/000000.700006", "Anti-phage defence, highlighted", "prelights.biologists.com", { subtype: "other" }),
		posted("10.64367/000000.700007", "Anti-phage defence explained for readers", "theconversation.com", { subtype: "other" })
	] });
	const records = await S.search("preprint", { keywords: "anti-phage defence", maxResults: 10 }, http, { ...ctx });
	assert.deepEqual(records.map(r => r.doi), ["10.1101/2025.03.04.700005"]);
});

test("an archive with nothing to say leaves the other archives' results standing", async () => {
	const http = archives({
		epmc: [epmc("PPR3", "Thermophilic recombineering in Geobacillus")],
		crossref: [], arxiv: [], osf: []
	});
	const records = await S.search("preprint", { keywords: "thermophilic recombineering", maxResults: 10 }, http, { ...ctx });
	assert.deepEqual(records.map(r => r.sourceId), ["PPR3"]);
});

test("every archive coming back empty is an empty result, not an error", async () => {
	const context = { ...ctx };
	const records = await S.search("preprint", { keywords: "nothing matches this", maxResults: 10 },
		archives({}), context);
	assert.deepEqual(records, []);
	assert.deepEqual(context.errors, []);
});

test("one broken archive is reported but does not lose the rest of the search", async () => {
	const context = { ...ctx };
	const http = archives({ epmc: [epmc("PPR4", "Base editor delivery in vivo")], fail: ["osf"] });
	const records = await S.search("preprint", { keywords: "base editor delivery", maxResults: 10 }, http, context);
	assert.deepEqual(records.map(r => r.sourceId), ["PPR4"]);
	assert.equal(context.errors.length, 1);
	assert.match(context.errors[0], /OSF/);
});

test("a malformed archive response is discarded rather than thrown out of the search", async () => {
	// Observed failure modes: a JSON body with no envelope at all, and an item missing the
	// relationships every field is read through. Either one used to take the search with it.
	const http = {
		urls: [],
		async getJSON(url) {
			http.urls.push(url);
			if (/europepmc/.test(url)) return { resultList: { result: [epmc("PPR5", "Phage defence systems")] }, hitCount: 1 };
			if (/osf\.io/.test(url)) return { data: [{ id: "broken" }, { id: "alsobroken", attributes: null, embeds: null }] };
			return { nonsense: true };
		},
		async getText() { return "not xml at all"; }
	};
	const context = { ...ctx };
	const records = await S.search("preprint", { keywords: "phage defence", maxResults: 10 }, http, context);
	assert.ok(records.some(r => r.sourceId === "PPR5"), "the archive that answered properly is kept");
	assert.ok(records.every(r => r.title), "no untitled husk is offered as a result");
	assert.deepEqual(context.errors, []);
});

test("cancelling a preprint search stops every archive, not just the slow one", async () => {
	const controller = new AbortController();
	let after = 0;
	const http = archives({
		epmc: [epmc("PPR6", "Cancelled mid flight")],
		onRequest: () => { if (controller.signal.aborted) after++; else controller.abort(); }
	});
	await assert.rejects(S.search("preprint", { keywords: "cancelled mid flight", maxResults: 10 }, http,
		{ ...ctx, signal: controller.signal }), { name: "AbortError" });
	assert.equal(after, 0, "no archive was asked anything after the abort");
});

test("OSF is asked nothing it cannot answer", async () => {
	// OSF rejects filter[contributors] as "not a filterable field" and offers no other author
	// route, so an author-only query has no question to put to it.
	const authorOnly = archives({ epmc: [epmc("PPR7", "A paper by Doudna")] });
	await S.search("preprint", { authors: "Jennifer Doudna", maxResults: 5 }, authorOnly, { ...ctx });
	assert.equal(served(authorOnly.urls, "osf.io").length, 0);

	const withKeywords = archives({ osf: [osfItem("ccc33", "Open hardware for gene synthesis")] });
	const records = await S.search("preprint", { keywords: "open hardware", maxResults: 5 }, withKeywords, { ...ctx });
	assert.equal(served(withKeywords.urls, "osf.io").length, 1);
	assert.deepEqual(records.map(r => r.sourceId), ["ccc33"]);
});

test("OSF keyword and title queries search the fields that hold them", async () => {
	const keyword = archives({ osf: [] });
	await S.search("preprint", { keywords: "biofoundry", maxResults: 5 }, keyword, { ...ctx });
	// A single-field substring test misses "protein engineering" across 200k postings; OSF's
	// comma form is the only OR it offers.
	assert.match(served(keyword.urls, "osf.io")[0].search, /filter\[title,description\]=biofoundry/);

	const titled = archives({ osf: [] });
	await S.search("preprint", { title: "biofoundry", maxResults: 5 }, titled, { ...ctx });
	assert.match(served(titled.urls, "osf.io")[0].search, /filter\[title\]=biofoundry/);
});

test("a withdrawn OSF posting is not offered as something to read", async () => {
	const http = archives({ osf: [
		osfItem("ddd44", "Gene editing claims", "bioHackrXiv",
			{ date_withdrawn: "2025-09-08T17:52:00.317773", reviews_state: "withdrawn" }),
		osfItem("eee55", "Gene editing methods")
	] });
	const records = await S.search("preprint", { keywords: "gene editing", maxResults: 10 }, http, { ...ctx });
	assert.deepEqual(records.map(r => r.sourceId), ["eee55"]);
});

test("OSF authors come back in the order they were credited", async () => {
	const http = archives({ osf: [osfItem("fff66", "Ordered byline")] });
	const [record] = await S.search("preprint", { keywords: "ordered byline", maxResults: 5 }, http, { ...ctx });
	assert.deepEqual(record.authors.map(a => a.name), ["Ada Byrne", "Bo Kim"]);
	assert.equal(record.doi, "10.31219/osf.io/fff66");
});

test("the preprint route asks Crossref for postings and not for a journal", async () => {
	const http = archives({ crossref: [] });
	await S.search("preprint", { keywords: "quorum sensing", venue: "bioRxiv", maxResults: 5 }, http, { ...ctx });
	const requests = served(http.urls, "crossref");
	// A posting has no ISSN and no container title, so the journal route would return nothing
	// at all; the archive name is matched against the record instead.
	assert.ok(requests.every(u => !u.pathname.startsWith("/journals")), "no journal resolution");
	assert.ok(requests.every(u => (u.searchParams.get("filter") || "").includes("type:posted-content")));
});

test("the same posting reaching us twice is one result that keeps both archives' fields", async () => {
	const http = archives({
		epmc: [epmc("PPR8", "Shared posting", { doi: "10.1101/2025.03.04.700004", citedByCount: 12 })],
		crossref: [posted("10.1101/2025.03.04.700004", "Shared posting", "biorxiv.org", {
			relation: { "is-preprint-of": [{ "id-type": "doi", id: "10.1038/s41586-025-00001-0" }] }
		})]
	});
	const records = await S.search("preprint", { keywords: "shared posting", maxResults: 10 }, http, { ...ctx });
	assert.equal(records.length, 1);
	assert.deepEqual(records[0].sources.sort(), ["crossref", "europepmc"]);
	assert.equal(records[0].citations, 12, "Europe PMC's citation count survives the merge");
	assert.equal(records[0].publishedDoi, "10.1038/s41586-025-00001-0", "Crossref's journal link survives it too");
	assert.equal(records[0].preprintServer, "bioRxiv");
});

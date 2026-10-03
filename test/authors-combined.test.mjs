import { test } from "node:test";
import assert from "node:assert/strict";
import Authors from "../content/authors.js";

const O1 = "0000-0002-1825-0097", O2 = "0000-0001-1111-1118", O3 = "0000-0002-9079-593X";
const oaAuthor = (n, name, orcid, extra = {}) => ({ id: "https://openalex.org/A" + n, orcid: orcid ? "https://orcid.org/" + orcid : null, display_name: name, display_name_alternatives: [],
	works_count: 10 * n, cited_by_count: 100 * n, summary_stats: { h_index: n }, last_known_institutions: [{ display_name: "Example University", country_code: "us" }], topics: [{ display_name: "Biosensors" }], ...extra });
const orcidRow = (id, given, family, inst = ["Example University"]) => ({ "orcid-id": id, "given-names": given, "family-names": family, "credit-name": null, "institution-name": inst, "other-name": [] });
const work = (n, aid = "A2", orcid = O1) => ({ id: "https://openalex.org/W" + n, doi: "https://doi.org/10.5555/w" + n, title: "Paper " + n, publication_year: 2020, publication_date: "2020-03-01", type: "article", cited_by_count: n,
	counts_by_year: [], authorships: [{ author: { display_name: "A Person", id: "https://openalex.org/" + aid, orcid: "https://orcid.org/" + orcid }, institutions: [], author_position: "first" }], primary_location: { source: { id: "https://openalex.org/S1", display_name: "J Ex" } }, biblio: {} });

function stub({ oa = [], orcid = [], enrich = [] } = {}) {
	const urls = [];
	return { urls, http: { async getJSON(url) {
		urls.push(url);
		if (url.startsWith("https://api.openalex.org/authors?search=")) return { results: oa };
		if (url.startsWith("https://api.openalex.org/authors?filter=orcid:")) return { results: enrich };
		if (url.startsWith("https://pub.orcid.org/v3.0/expanded-search/")) return { "num-found": orcid.length, "expanded-result": orcid };
		throw new Error("unexpected " + url);
	} } };
}

test("combined search: one OpenAlex search and one ORCID search in parallel, merged by ORCID iD, no extra request when all match", async () => {
	const { urls, http } = stub({ oa: [oaAuthor(2, "Sheila Ingemann Jensen", O1), oaAuthor(1, "Sheila Jensen", null)],
		orcid: [orcidRow(O1, "Sheila", "Jensen", ["Aarhus University"])] });
	const list = await Authors.searchProfiles("combined", "Sheila Jensen", http, {});
	assert.equal(urls.length, 2);
	assert.match(urls.find(u => u.includes("api.openalex.org")), /authors\?search=Sheila%20Jensen&per-page=15&select=id,orcid,display_name,display_name_alternatives,works_count,cited_by_count,summary_stats,last_known_institutions,topics/);
	assert.ok(urls.some(u => u.includes("expanded-search")));
	const merged = list.find(c => c.orcid === O1);
	assert.deepEqual(merged.sources, ["openalex", "orcid"]); assert.equal(merged.openalexId, "A2"); assert.equal(merged.id, "A2");
	assert.equal(merged.affiliation, "Aarhus University"); assert.equal(merged.lastInstitution.country, "US"); assert.equal(merged.hIndex, 2); assert.equal(merged.provider, "combined");
	assert.equal(list.length, 2);
});

test("combined search: ORCID-only people get one batched enrichment, and match an OpenAlex id found there", async () => {
	const { urls, http } = stub({ oa: [oaAuthor(5, "Sheila Jensen", null)], orcid: [orcidRow(O2, "Sheila", "Jensen"), orcidRow(O3, "Sheila", "Jensen")],
		enrich: [oaAuthor(5, "Sheila Jensen", O2), oaAuthor(7, "Sheila Jensen", O3)] });
	const list = await Authors.searchProfiles("combined", "Sheila Jensen", http, {});
	assert.equal(urls.length, 3, "OpenAlex search 1 + ORCID search 1 + one enrichment");
	assert.equal(urls.filter(u => u.includes("filter=orcid:")).length, 1);
	assert.equal(list.length, 2, "A5 appears once: its ORCID row matched by OpenAlex id");
	const a5 = list.find(c => c.openalexId === "A5");
	assert.equal(a5.orcid, O2); assert.deepEqual(a5.sources, ["openalex", "orcid"]);
	assert.deepEqual(list.find(c => c.openalexId === "A7").sources, ["orcid"]);
});

test("combined ranking: exact name, then works count; people with no works and no affiliation fold as weak", async () => {
	const { http } = stub({ oa: [oaAuthor(1, "S Jensen", null), oaAuthor(9, "Sheila Jensen", null), oaAuthor(4, "Sheila Jensen", null),
		oaAuthor(2, "Sheila Jensen", null, { works_count: 0, last_known_institutions: [] })], orcid: [] });
	const list = await Authors.searchProfiles("combined", "Sheila Jensen", http, {});
	assert.deepEqual(list.map(c => c.openalexId), ["A9", "A4", "A1", "A2"]);
	assert.deepEqual(list.map(c => c.weak), [false, false, false, true]);
});

test("combined search: an ORCID iD or OpenAlex id goes straight to one person; a bad checksum is an error", async () => {
	let s = stub({ enrich: [oaAuthor(3, "Pat Lee", O1)] });
	const http = { async getJSON(url) {
		s.urls.push(url);
		if (url === "https://pub.orcid.org/v3.0/" + O1 + "/person") return { path: "/" + O1 + "/person", name: { "given-names": { value: "Pat" }, "family-name": { value: "Lee" } }, biography: null, "other-names": { "other-name": [] } };
		return s.http.getJSON(url);
	} };
	for (const input of [O1, "https://orcid.org/" + O1]) {
		const list = await Authors.searchProfiles("combined", input, http, {});
		assert.equal(list.length, 1); assert.equal(list[0].orcid, O1); assert.equal(list[0].openalexId, "A3"); assert.equal(list[0].direct, true);
	}
	const one = [];
	const oaHttp = { async getJSON(url) { one.push(url); return oaAuthor(8, "Kim Park", null); } };
	for (const input of ["A8", "https://openalex.org/A8", "https://openalex.org/authors/A8"]) {
		const list = await Authors.searchProfiles("combined", input, oaHttp, {});
		assert.equal(list.length, 1); assert.equal(list[0].openalexId, "A8"); assert.equal(list[0].direct, true);
	}
	assert.ok(one.every(u => u.startsWith("https://api.openalex.org/authors/A8?select=")));
	await assert.rejects(Authors.searchProfiles("combined", "0000-0002-1825-0098", {}, {}), /valid ORCID/);
});

test("combined search keeps going when one service fails, and fails when both do", async () => {
	const http = fail => ({ async getJSON(url) {
		if (url.includes(fail)) throw Object.assign(new Error("down"), { status: 400 });
		if (url.includes("expanded-search")) return { "expanded-result": [orcidRow(O1, "Sheila", "Jensen")] };
		return { results: [oaAuthor(2, "Sheila Jensen", null)] };
	} });
	const ctx = { errors: [] };
	const list = await Authors.searchProfiles("combined", "Sheila Jensen", http("api.openalex.org/authors?search"), ctx);
	assert.ok(list.some(c => c.orcid === O1)); assert.match(ctx.errors.join(), /OpenAlex/);
	const list2 = await Authors.searchProfiles("combined", "Sheila Jensen", http("expanded-search"), { errors: [] });
	assert.equal(list2[0].openalexId, "A2");
	await assert.rejects(Authors.searchProfiles("combined", "Sheila Jensen", { async getJSON() { throw new Error("offline"); } }, {}), /offline/);
	const spent = stub({ orcid: [orcidRow(O1, "Sheila", "Jensen")] });
	const l3 = await Authors.searchProfiles("combined", "Sheila Jensen", spent.http, { openAlexSpent: true, errors: [] });
	assert.equal(l3.length, 1); assert.ok(spent.urls.every(u => !u.includes("openalex")), "no OpenAlex request once the budget is spent");
});

test("combined works load by OpenAlex author id, falling back to ORCID when OpenAlex fails or is empty", async () => {
	const person = { provider: "combined", id: "A2", openalexId: "A2", orcid: O1, name: "Sheila Jensen", worksCount: 3 };
	const urls = [];
	let records = await Authors.loadPublications(person, { maxResults: 100 }, { async getJSON(url) { urls.push(url); return { meta: { count: 3 }, results: [work(1), work(2), work(3)] }; } }, {});
	assert.equal(records.length, 3); assert.match(urls[0], /works\?filter=authorships\.author\.id:A2&sort=publication_date:desc/);
	assert.equal(records.authorProfile.provider, "combined"); assert.equal(records.authorProvenance.via, "openalex"); assert.equal(records.authorProvenance.openalexId, "A2");
	assert.ok(!urls.some(u => u.includes("orcid.org")));
	const orcidWorks = { path: "/" + O1 + "/works", group: [1, 2].map(n => ({ "work-summary": [{ "put-code": n, "display-index": "0", title: { title: { value: "W" + n } }, type: "journal-article", "publication-date": { year: { value: "2019" } }, "external-ids": { "external-id": [] } }] })) };
	for (const mode of ["error", "empty"]) {
		const seen = [];
		records = await Authors.loadPublications(person, { maxResults: 100 }, { async getJSON(url) {
			seen.push(url);
			if (url.startsWith("https://pub.orcid.org/")) return orcidWorks;
			if (mode === "error") throw Object.assign(new Error("boom"), { status: 400 });
			return { meta: { count: 0 }, results: [] };
		} }, {});
		assert.equal(records.length, 2); assert.equal(records.authorProvenance.via, "orcid"); assert.equal(records.authorProfile.provider, "combined"); assert.equal(records.authorProfile.id, "A2");
		assert.equal(seen.filter(u => u.includes("api.openalex.org/works?")).length, 1, "OpenAlex is not asked a second time under the ORCID iD");
	}
	await assert.rejects(Authors.loadPublications({ ...person, orcid: null }, { maxResults: 5 }, { async getJSON() { return { results: [] }; } }, {}), /no works/);
});

test("a combined person known only by ORCID loads through the ORCID path", async () => {
	const urls = [];
	const records = await Authors.loadPublications({ provider: "combined", id: O1, orcid: O1, openalexId: null, name: "X" }, { maxResults: 10 }, { async getJSON(url) { urls.push(url); return { meta: { count: 1 }, results: [work(1)] }; } }, {});
	assert.match(urls[0], /authorships\.author\.orcid:/); assert.equal(records.authorProfile.provider, "combined"); assert.equal(records.length, 1);
});

test("two OpenAlex author records with one ORCID iD (as the live search returns) become one card whose works are read through the iD", async () => {
	const { http } = stub({ oa: [oaAuthor(1, "Sheila I. Jensen", O1), oaAuthor(4, "Sheila Ingemann Jensen", O1)], orcid: [orcidRow(O1, "Sheila", "Jensen")] });
	const list = await Authors.searchProfiles("combined", "Sheila Jensen", http, {});
	assert.equal(list.length, 1);
	const [card] = list;
	assert.equal(card.openalexId, "A4"); assert.deepEqual(card.alsoIds, ["A1"]); assert.equal(card.worksCount, 50); assert.equal(card.citations, 500); assert.equal(card.hIndex, 4);
	assert.deepEqual(card.sources, ["openalex", "orcid"]);
	const urls = [];
	const records = await Authors.loadPublications({ ...card }, { maxResults: 50 }, { async getJSON(url) { urls.push(url); return { meta: { count: 1 }, results: [work(1, "A4", O1)] }; } }, {});
	assert.match(urls[0], /authorships\.author\.orcid:/, "both records are reached through the ORCID iD");
	assert.equal(records.authorProfile.provider, "combined");
});

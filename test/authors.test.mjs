import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import Authors from "../content/authors.js";
import Query from "../content/query.js";
import Sources from "../content/sources.js";

const ORCID = "0000-0002-1825-0097", SCHOLAR = "tI-o3okAAAAJ";
const scholarProfile = { provider: "scholar", id: SCHOLAR, name: "A Researcher", affiliation: "University", url: "https://scholar.google.com/citations?user=" + SCHOLAR };
const orcidProfile = { provider: "orcid", id: ORCID, name: "An Owner", url: "https://orcid.org/" + ORCID };
const provenance = source => ({ engine: "publish-or-perish", source, profileId: "pop-default", invocationId: "independent-invocation", capturedAt: "2026-09-20T00:00:00.000Z", complete: true, cached: false, cancelled: false });
const person = { path: "/" + ORCID + "/person", name: { "given-names": { value: "An" }, "family-name": { value: "Owner" }, "credit-name": null },
	biography: { content: "Public biography" }, "other-names": { "other-name": [{ content: "A. Owner" }] } };
const external = (value, relationship = "self", type = "doi") => ({ "external-id-type": type, "external-id-value": value, "external-id-relationship": relationship });
const work = (code, extra = {}) => ({ "put-code": code, "display-index": "0", title: { title: { value: "Reported work " + code } },
	"journal-title": { value: "Recorded journal" }, type: "journal-article", "publication-date": { year: { value: "2024" }, month: { value: "2" }, day: { value: "29" } },
	"external-ids": { "external-id": [external("10.1234/work" + code)] }, ...extra });
const group = (...summaries) => ({ "work-summary": summaries });

test("author parsers validate ORCID checksum and unambiguous Scholar profile hosts and identifiers", () => {
	for (const input of [ORCID, "https://orcid.org/" + ORCID, "orcid:" + ORCID, ORCID.replaceAll("-", "")]) assert.equal(Authors.parseOrcid(input), ORCID);
	for (const input of ["0000-0002-1825-0098", "https://evil.test/" + ORCID, "A123", "Sheila Jensen", ORCID + " OR other"]) assert.equal(Authors.parseOrcid(input), null);
	for (const input of [SCHOLAR, "https://scholar.google.com/citations?hl=en&user=" + SCHOLAR, "https://scholar.google.co.uk/citations?user=" + SCHOLAR]) {
		assert.deepEqual(Authors.parseScholarProfile(input), { id: SCHOLAR, url: "https://scholar.google.com/citations?user=" + SCHOLAR });
	}
	for (const input of ["short", SCHOLAR + "x", "https://evil.test/citations?user=" + SCHOLAR,
		"https://scholar.google.com.evil.test/citations?user=" + SCHOLAR, "https://evil@scholar.google.com/citations?user=" + SCHOLAR,
		"https://scholar.google.com/scholar?user=" + SCHOLAR, "https://scholar.google.com/citations?user=" + SCHOLAR + "&user=" + SCHOLAR,
		"javascript:alert(1)", "https://scholar.google.com:8443/citations?user=" + SCHOLAR]) assert.equal(Authors.parseScholarProfile(input), null, input);
});

test("ORCID profile lookup uses the intended public endpoint without inventing affiliation or requesting works", async () => {
	const calls = [];
	const profiles = await Authors.searchProfiles("orcid", ORCID, { async getJSON(url, headers) { calls.push({ url, headers }); return person; } });
	assert.deepEqual(calls, [{ url: "https://pub.orcid.org/v3.0/" + ORCID + "/person", headers: { Accept: "application/json" } }]);
	assert.equal(profiles[0].name, "An Owner"); assert.equal(profiles[0].affiliation, ""); assert.equal(profiles[0].biography, "Public biography");
	assert.deepEqual(profiles[0].otherNames, ["A. Owner"]); assert.equal(profiles[0].identityConfirmed, true);
	profiles[0].original.name["given-names"].value = "mutated";
	assert.equal(person.name["given-names"].value, "An");
	await assert.rejects(Authors.searchProfiles("orcid", "An Owner", {}), /valid ORCID/);
});

test("ORCID works select preferred group assertions and use only unambiguous self DOIs without fabricated bylines", async () => {
	const works = { path: "/" + ORCID + "/works", group: [
		group(work(1, { "display-index": "1", title: { title: { value: "Older assertion" } } }), work(2, { "display-index": "9",
			"external-ids": { "external-id": [external("10.1234/container", "part-of"), external("https://doi.org/10.1234/REAL")] } })),
		group(work(3, { title: null, "publication-date": { year: { value: "2023" }, month: { value: "2" }, day: { value: "29" } },
			"external-ids": { "external-id": [external("10.1234/container", "part-of")] } })),
		group(work(4, { "external-ids": { "external-id": [external("10.1234/first"), external("10.1234/second")] } })),
		group(work(5, { "publication-date": { year: { value: "0" } }, type: "data-set" })) ] };
	const snapshots = [], ctx = { onResults: (records, details) => snapshots.push({ records, details }) };
	const records = await Authors.loadPublications(orcidProfile, { maxResults: 100 }, { async getJSON() { return works; } }, ctx);
	assert.equal(records.length, 4); assert.equal(records[0].orcidPutCode, 2); assert.equal(records[0].doi, "10.1234/real");
	assert.equal(records[0].title, "Reported work 2"); assert.equal(records[0].publicationDate, "2024-02-29");
	assert.equal(records[1].title, ""); assert.equal(records[1].doi, null); assert.equal(records[1].publicationDate, "2023-02");
	assert.equal(records[2].doi, null); assert.equal(records[2].metadataWarnings.length, 1);
	assert.equal(records[3].year, null); assert.equal(records[3].itemType, "dataset");
	for (const record of records) {
		assert.deepEqual(record.authors, []); assert.equal(record.citations, null); assert.equal(record.authorListComplete, false);
		assert.equal(record.authorProfile.id, ORCID); assert.equal(record.attribution, "listed-on-orcid-record");
	}
	assert.equal(records.authorProvenance.totalGroups, 4); assert.equal(records.authorProvenance.complete, true);
	assert.equal(snapshots.length, 1); assert.equal(snapshots[0].details.final, true);
	assert.deepEqual(records[0].orcidOriginal, works.group[0]);
	records[0].orcidOriginal["work-summary"][0].title.title.value = "mutated";
	assert.equal(works.group[0]["work-summary"][0].title.title.value, "Older assertion");
});

test("ORCID whole-section results retain separate groups and disclose a requested cap as partial", async () => {
	const original = group(work(1));
	const records = await Authors.loadPublications(orcidProfile, { maxResults: 2 }, { getJSON: async () => ({ group: [original, original, group(work(3))] }) });
	assert.equal(records.length, 2); assert.equal(new Set(records.map(row => row.key)).size, 2);
	assert.equal(records[0].doi, records[1].doi); assert.equal(records.partial, true);
	assert.equal(records.authorProvenance.totalGroups, 3); assert.equal(records.authorProvenance.truncated, true);
	assert.equal(records.authorProvenance.complete, false);
	const empty = await Authors.loadPublications(orcidProfile, {}, { getJSON: async () => ({ group: [] }) });
	assert.equal(empty.length, 0); assert.equal(empty.authorProvenance.complete, true);
});

test("Scholar ID lookup never invents a name and profile loading preserves native rows and pagination cap", async () => {
	const profiles = await Authors.searchProfiles("scholar", SCHOLAR, {}, { popSearchSource() { assert.fail("ID entry must not perform name search"); } });
	assert.equal(profiles[0].name, ""); assert.equal(profiles[0].identityConfirmed, false);
	const rows = [{ title: "First", rank: 8, authors: ["Other Researcher", "..."], year: 0, cites: 0 }, { title: "First", rank: 2 }, {}];
	let call;
	const records = await Authors.loadPublications(profiles[0], { maxResults: 2000, popOutputSort: "-year" }, {}, {
		async popSearchSource(source, query) { call = { source, query }; return { rows, provenance: provenance(source) }; }
	});
	assert.deepEqual(call, { source: "scholarprofile", query: { engine: "pop", authors: SCHOLAR, maxResults: 2000, popOutputSort: "-year" } });
	assert.deepEqual(records.map(record => record.popOriginal), rows); assert.equal(records.length, 3);
	assert.deepEqual(records.map(record => record.popRank), [8, 2, null]); assert.equal(new Set(records.map(record => record.key)).size, 3);
	assert.equal(records.authorProfile.id, SCHOLAR); assert.equal(records.authorProfile.identityConfirmed, true);
	assert.equal(records.popProvenance.profileId, "pop-default"); assert.equal(records.authorProvenance.profileId, "pop-default");
	assert.equal(records.authorProvenance.authorId, SCHOLAR); assert.equal(records[0].authors[0].name, "Other Researcher");
});

test("Scholar name profile lookup requires actual identifiable profile rows", async () => {
	let call;
	const ctx = { async popSearchSource(source, query) { call = { source, query }; return {
		rows: [{ name: "A Researcher", affiliation: "University", profile_url: scholarProfile.url, cites: 42 },
			{ title: "Another Author", source: "Other Institute", uid: "GSA:abcdefghijkl" }], provenance: provenance(source) }; } };
	const profiles = await Authors.searchProfiles("scholar", "A Researcher", {}, ctx);
	assert.equal(call.source, "scholarauthor"); assert.equal(call.query.authors, "A Researcher");
	assert.equal(profiles[0].id, SCHOLAR); assert.equal(profiles[0].name, "A Researcher"); assert.equal(profiles[0].affiliation, "University");
	assert.equal(profiles[1].id, "abcdefghijkl"); assert.equal(profiles[1].name, "Another Author");
	for (const row of [{ title: "Unidentified" }, { profile_id: SCHOLAR, url: "https://scholar.google.com/citations?user=abcdefghijkl" }]) {
		await assert.rejects(Authors.searchProfiles("scholar", "A Researcher", {}, { popSearchSource: async () => ({ rows: [row], provenance: provenance("scholarauthor") }) }), /unrecognized or ambiguous/);
	}
	await assert.rejects(Authors.searchProfiles("scholar", "https://evil.test/citations?user=" + SCHOLAR, {}, ctx), /valid Google Scholar/);
});

test("Scholar input kinds prevent twelve-letter names from silently becoming profile IDs", async () => {
	const calls = [];
	const bridge = async (source, query) => { calls.push({ source, query }); return { rows: [], provenance: provenance(source) }; };
	await assert.rejects(Authors.searchProfiles("scholar", "MichaelSmith", {}, { popSearchSource: bridge }), /could be an author name or a profile ID/);
	assert.equal(calls.length, 0);
	const named = await Authors.searchProfiles("scholar", "MichaelSmith", {}, { scholarInputKind: "name", popSearchSource: bridge });
	assert.equal(named.length, 0); assert.equal(calls[0].source, "scholarauthor"); assert.equal(calls[0].query.authors, "MichaelSmith");
	const explicit = await Authors.searchProfiles("scholar", "abcdefghijkl", {}, { scholarInputKind: "profile", popSearchSource: bridge });
	assert.equal(explicit[0].id, "abcdefghijkl"); assert.equal(calls.length, 1);
	const url = await Authors.searchProfiles("scholar", "https://scholar.google.com/citations?user=abcdefghijkl", {}, { popSearchSource: bridge });
	assert.equal(url[0].id, "abcdefghijkl");
	const actual = await Authors.searchProfiles("scholar", "dsdG3ewAAAAJ", {}, { popSearchSource: bridge });
	assert.equal(actual[0].id, "dsdG3ewAAAAJ"); assert.equal(calls.length, 1);
	await assert.rejects(Authors.searchProfiles("scholar", "A Researcher", {}, { scholarInputKind: "profile", popSearchSource: bridge }), /valid Google Scholar/);
	await assert.rejects(Authors.searchProfiles("scholar", scholarProfile.url, {}, { scholarInputKind: "name", popSearchSource: bridge }), /Choose Profile/);
	const papers = await Authors.loadNamePublications("MichaelSmith", {}, {}, { scholarInputKind: "name", popSearchSource: bridge });
	assert.equal(calls.at(-1).source, "scholar"); assert.equal(calls.at(-1).query.authors, "MichaelSmith");
	assert.equal(papers.authorProfile.identityConfirmed, false);
});

test("explicit Scholar name paper search is separate from profile identity", async () => {
	let source;
	const rows = [{ title: "Paper", authors: ["Different Person"], rank: 1 }];
	const records = await Authors.loadNamePublications("A Researcher", { maxResults: 12 }, {}, { async popSearchSource(key, query) {
		source = key; assert.equal(query.authors, "A Researcher"); assert.equal(query.maxResults, 12); return { rows, provenance: provenance(key) };
	} });
	assert.equal(source, "scholar"); assert.equal(records.authorProfile.id, null); assert.equal(records.authorProfile.identityConfirmed, false);
	assert.equal(records.authorProvenance.mode, "name-search"); assert.equal(records[0].authors[0].name, "Different Person");
});

test("author services expose authorization, provider, schema and identity failures without fallback", async () => {
	for (const status of [401, 403, 404, 429]) {
		await assert.rejects(Authors.searchProfiles("orcid", ORCID, { getJSON: async () => { throw Object.assign(new Error("sensitive upstream error"), { status }); } }), error => error.status === status && !error.message.includes("sensitive"));
	}
	for (const data of [{}, { path: "/other/person", name: null }, []]) await assert.rejects(Authors.searchProfiles("orcid", ORCID, { getJSON: async () => data }), /invalid/);
	for (const data of [{}, { group: [group()] }, { group: [group(null)] }]) await assert.rejects(Authors.loadPublications(orcidProfile, {}, { getJSON: async () => data }), /invalid/);
	await assert.rejects(Authors.searchProfiles("scholar", "A Researcher", {}, { popSearchSource: async () => { throw new Error("CLI failed (3)"); } }), /signing in or completing a CAPTCHA/);
	await assert.rejects(Authors.loadPublications(scholarProfile, {}, {}, { popSearchSource: async () => ({ rows: [], provenance: provenance("crossref") }) }), /Invalid or incomplete/);
	await assert.rejects(Authors.searchProfiles("unknown", "Author", {}), /Unsupported/);
	await assert.rejects(Authors.loadPublications({ provider: "orcid", id: "invalid" }, {}, {}), /Invalid ORCID/);
	await assert.rejects(Authors.loadPublications(orcidProfile, { maxResults: 0 }, {}), /limit/);
});

test("optional ORCID token goes only to the fixed ORCID service and never enters returned metadata", async () => {
	let headers;
	const result = await Authors.searchProfiles("orcid", ORCID, { async getJSON(url, supplied) { assert.ok(url.startsWith("https://pub.orcid.org/")); headers = supplied; return person; } }, { orcidAccessToken: "intended-service-token" });
	assert.equal(headers.Authorization, "Bearer intended-service-token"); assert.ok(!JSON.stringify(result).includes("intended-service-token"));
	await assert.rejects(Authors.searchProfiles("orcid", ORCID, {}, { orcidAccessToken: "bad\nheader" }), /transport|token/);
});

test("cancellation interrupts pending HTTP and native operations without publishing partial inventions", async () => {
	for (const provider of ["orcid", "scholar"]) {
		const controller = new AbortController();
		const ctx = { signal: controller.signal, popSearchSource: () => new Promise(() => {}), onResults() { assert.fail("cancelled work cannot publish"); } };
		const pending = Authors.loadPublications(provider === "orcid" ? orcidProfile : scholarProfile, {}, { getJSON: () => new Promise(() => {}) }, ctx);
		controller.abort(); await assert.rejects(pending, { name: "AbortError" });
	}
	const controller = new AbortController(); controller.abort();
	await assert.rejects(Authors.searchProfiles("orcid", ORCID, { getJSON() { assert.fail("no request after abort"); } }, { signal: controller.signal }), { name: "AbortError" });
});

test("author module also loads as a Zotero window global", () => {
	const context = vm.createContext({ ZotPoPQuery: Query, ZotPoPSources: Sources, URL, Date });
	vm.runInContext(fs.readFileSync(new URL("../content/authors.js", import.meta.url), "utf8"), context);
	assert.equal(context.ZotPoPAuthors.parseOrcid(ORCID), ORCID);
	assert.equal(context.ZotPoPAuthors.parseScholarProfile(SCHOLAR).id, SCHOLAR);
});

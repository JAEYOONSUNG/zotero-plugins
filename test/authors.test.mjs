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
	await assert.rejects(Authors.searchProfiles("orcid", "0000-0002-1825-0098", {}), /valid ORCID/);
	await assert.rejects(Authors.searchProfiles("orcid", "https://example.test/someone", {}), /valid ORCID/);
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
	// newest first (round 6): the 2024 conflicting-DOI work comes before the 2023 one
	assert.equal(records[2].title, ""); assert.equal(records[2].doi, null); assert.equal(records[2].publicationDate, "2023-02");
	assert.equal(records[1].doi, null); assert.equal(records[1].metadataWarnings.length, 1);
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

// ---------------------------------------------------------------- ORCID by name
const A_ID = "0000-0001-1111-1118", B_ID = "0000-0002-2222-2224", C_ID = "0000-0003-3333-3330", D_ID = "0000-0004-4444-4447";
const parse = value => Authors.parseNameInput(value);
const flat = value => parse(value).variants.map(v => v.given.join(" ") + "|" + v.family);

test("typed names are read in every plausible order and Korean names are left as typed", () => {
	assert.deepEqual(flat("Jennifer Doudna"), ["Jennifer|Doudna", "Doudna|Jennifer"]);
	assert.deepEqual(flat("Doudna, Jennifer A."), ["Jennifer A|Doudna"]);
	assert.deepEqual(flat("J. Doudna"), ["J|Doudna"]);
	assert.deepEqual(flat("J.A. Doudna"), ["J A|Doudna"]);
	assert.deepEqual(flat("Doudna JA"), ["J A|Doudna"]);
	assert.deepEqual(flat("Michael C. Jewett"), ["Michael C|Jewett"]);
	assert.deepEqual(flat("Jae Yoon Sung"), ["Jae Yoon|Sung", "Yoon Sung|Jae"]);
	assert.deepEqual(flat("Ludwig van Beethoven"), ["Ludwig|van Beethoven", "van Beethoven|Ludwig"]);
	assert.deepEqual(flat("Dr. Doudna"), ["|Doudna"]);
	assert.deepEqual(flat("  Martin   Luther King Jr. "), ["Martin Luther|King", "Luther King|Martin"]);
	for (const korean of ["성재윤", "Kim 민수", "山田 太郎"]) assert.deepEqual(parse(korean), { raw: korean, cjk: true, variants: [] });
	assert.deepEqual(parse("   "), { raw: "", cjk: false, variants: [] });
});

test("the ORCID name query is fielded, quoted, in one request, and never free text", () => {
	const built = Authors.orcidNameQuery("Jennifer Doudna");
	assert.equal(built.q, '(given-names:"Jennifer" AND family-name:"Doudna") OR (given-names:"Doudna" AND family-name:"Jennifer") OR credit-name:"Jennifer Doudna" OR other-names:"Jennifer Doudna"');
	assert.equal(built.url, "https://pub.orcid.org/v3.0/expanded-search/?q=" + encodeURIComponent(built.q) + "&rows=20");
	assert.equal(Authors.orcidNameQuery("J. Doudna").q, '(given-names:J* AND family-name:"Doudna")');
	assert.equal(Authors.orcidNameQuery("Doudna, Jennifer").q.startsWith('(given-names:"Jennifer" AND family-name:"Doudna")'), true);
	assert.equal(Authors.orcidNameQuery("성재윤").q, 'credit-name:"성재윤" OR other-names:"성재윤"');
	assert.equal(Authors.orcidNameQuery('Evil" OR family-name:"x').q.includes('""'), false);
	assert.ok(!/\\/.test(Authors.orcidNameQuery('A\\ B').q));
	assert.equal(Authors.orcidNameQuery("   "), null); assert.equal(Authors.orcidNameQuery("1234 5678"), null);
});

const expanded = rows => ({ "num-found": rows.length, "expanded-result": rows });
const row = (id, given, family, extra = {}) => ({ "orcid-id": id, "given-names": given, "family-names": family, "institution-name": [], "other-name": [], "credit-name": null, ...extra });
const oaAuthor = (id, works, extra = {}) => ({ id: "https://openalex.org/A" + works, orcid: "https://orcid.org/" + id, works_count: works, cited_by_count: works * 100,
	summary_stats: { h_index: Math.round(works / 10) }, last_known_institutions: [{ display_name: "Example University", country_code: "us" }], topics: [{ display_name: "Gene editing" }], ...extra });

test("name candidates are enriched by one OpenAlex request, ranked exact-name first then by works, and empty ones are folded", async () => {
	const calls = [];
	const http = { async getJSON(url, headers) {
		calls.push(url);
		if (url.startsWith("https://pub.orcid.org/v3.0/expanded-search/")) return expanded([
			row(D_ID, "Jennifer", "Doudna-Fan"), row(A_ID, "Jennifer", "Doudna", { "institution-name": ["Example University", "Other Institute", "Third"] }),
			row(B_ID, "Jennifer A.", "Doudna"), row(C_ID, "Jenny", "Doudna"), { "orcid-id": "bad" }, row(A_ID, "Jennifer", "Doudna")]);
		assert.ok(url.startsWith("https://api.openalex.org/authors?filter=orcid:")); assert.equal(headers.Accept, undefined);
		return { results: [oaAuthor(B_ID, 500), oaAuthor(C_ID, 900), oaAuthor(A_ID, 3)] };
	} };
	const profiles = await Authors.searchProfiles("orcid", "Jennifer Doudna", http, { openAlexApiKey: "k" });
	assert.equal(calls.length, 2, "one ORCID search and one batched OpenAlex request");
	const authors = new URL(calls[1]);
	assert.equal(authors.searchParams.get("filter"), `orcid:${D_ID}|${A_ID}|${B_ID}|${C_ID}`); assert.equal(authors.searchParams.get("per-page"), "50");
	assert.match(authors.searchParams.get("select"), /works_count.*summary_stats.*last_known_institutions.*topics/); assert.equal(authors.searchParams.get("api_key"), "k");
	assert.deepEqual(profiles.map(p => p.id), [B_ID, A_ID, C_ID, D_ID], "exact full name (middle initial aside) first, then works; the unknown one last");
	assert.deepEqual(profiles.map(p => p.weak), [false, false, false, true], "no works anywhere is folded once better ones exist");
	const first = profiles[0];
	assert.equal(first.worksCount, 500); assert.equal(first.citations, 50000); assert.equal(first.hIndex, 50); assert.equal(first.topic, "Gene editing");
	assert.deepEqual(first.lastInstitution, { name: "Example University", country: "US" });
	assert.equal(profiles[1].affiliation, "Example University; Other Institute"); assert.deepEqual(profiles[1].institutions.length, 3);
	assert.equal(profiles[1].url, "https://orcid.org/" + A_ID); assert.equal(profiles[1].identityConfirmed, true);
	assert.equal(profiles.authorProvenance.endpoint, "expanded-search");
});

test("name candidates survive an OpenAlex failure or a spent budget without being folded", async () => {
	const search = () => expanded([row(A_ID, "Jennifer", "Doudna"), row(B_ID, "Jenny", "Doudna")]);
	for (const ctx of [{ openAlexSpent: true }, {}]) {
		let alex = 0;
		const profiles = await Authors.searchProfiles("orcid", "Jennifer Doudna", { async getJSON(url) { if (url.startsWith("https://api.openalex")) { alex++; throw Object.assign(new Error("down"), { status: 500 }); } return search(); } }, { ...ctx, isCancelled: () => false });
		assert.equal(profiles.length, 2); assert.ok(profiles.every(p => !p.weak && p.worksCount === undefined));
		assert.equal(profiles[0].id, A_ID, "exact name still first");
		assert.equal(alex, ctx.openAlexSpent ? 0 : 4);
	}
	assert.equal((await Authors.searchProfiles("orcid", "Nobody Atall", { async getJSON() { return { "num-found": 0, "expanded-result": null }; } })).length, 0);
	await assert.rejects(Authors.searchProfiles("orcid", "Jennifer Doudna", { getJSON: async () => ({ "expanded-result": "no" }) }), /invalid search/);
	await assert.rejects(Authors.searchProfiles("orcid", "Jennifer Doudna", { getJSON: async () => { throw Object.assign(new Error("x"), { status: 429 }); } }), /rate limit/);
});

test("an ORCID iD typed in any form still opens that one profile and never runs a name search", async () => {
	const urls = [];
	for (const input of [ORCID, "https://orcid.org/" + ORCID, "orcid:" + ORCID]) {
		const profiles = await Authors.searchProfiles("orcid", input, { async getJSON(url) { urls.push(url); return person; } });
		assert.equal(profiles.length, 1); assert.equal(profiles[0].id, ORCID);
	}
	assert.ok(urls.every(url => url === "https://pub.orcid.org/v3.0/" + ORCID + "/person"));
});

test("ranking treats initials, missing middle names and name order sensibly", () => {
	const mk = (given, family, extra = {}) => ({ givenNames: given, familyNames: family, creditName: "", otherNames: [], ...extra });
	const tier = (typed, c) => Authors.rankOrcidCandidates([c], parse(typed))[0].nameTier;
	assert.equal(tier("Jennifer Doudna", mk("Jennifer A.", "Doudna")), 2);
	assert.equal(tier("Doudna, Jennifer", mk("Jennifer", "Doudna")), 2);
	assert.equal(tier("Sung Jae Yoon", mk("Jae Yoon", "Sung")), 2);
	assert.equal(tier("J. Doudna", mk("Jennifer", "Doudna")), 1);
	assert.equal(tier("Jae Yoon Sung", mk("Jae", "Sung")), 1);
	assert.equal(tier("Jennifer Doudna", mk("Jennifer", "Smith")), 0);
	assert.equal(tier("Jennifer Doudna", mk("J", "D", { creditName: "Jennifer Doudna" })), 2);
	assert.equal(tier("José García", mk("Jose", "Garcia")), 2);
});

// ---------------------------------------------------------------- an ORCID person's papers
const alexWork = (n, extra = {}) => ({ id: "https://openalex.org/W" + n, doi: "https://doi.org/10.5555/w" + n, title: "Paper " + n, publication_year: 2020 + n % 5, publication_date: (2020 + n % 5) + "-03-01",
	type: "article", cited_by_count: n * 3, counts_by_year: [{ year: 2024, cited_by_count: n }], authorships: [{ author: { display_name: "A Person", id: "https://openalex.org/A1", orcid: "https://orcid.org/" + A_ID }, institutions: [{ display_name: "Example University", country_code: "US" }], author_position: "first" }],
	primary_location: { source: { id: "https://openalex.org/S1", display_name: "Journal of Examples", issn_l: "1234-5678" } }, biblio: {}, ...extra });
const profileA = { provider: "orcid", id: A_ID, name: "A Person", worksCount: 3, url: "https://orcid.org/" + A_ID };

test("an ORCID person's papers come from OpenAlex through the existing record pipeline, newest first", async () => {
	const urls = [], snapshots = [];
	const http = { async getJSON(url) {
		urls.push(url);
		if (url.includes("/works?")) return { meta: { count: 3 }, results: [alexWork(1), alexWork(2), alexWork(3)] };
		return { results: [] };
	} };
	const records = await Authors.loadPublications(profileA, { maxResults: 100 }, http, { onResults: records => snapshots.push(records.length) });
	assert.equal(records.length, 3); assert.ok(records.every(r => r.source === "openalex" && r.citations > 0 && r.citesByYear && r.venue === "Journal of Examples"));
	assert.match(urls[0], /works\?filter=authorships\.author\.orcid:0000-0001-1111-1118&sort=publication_date:desc/);
	assert.ok(records[0].year >= records[1].year && records[1].year >= records[2].year);
	assert.equal(records.authorProvenance.via, "openalex"); assert.equal(records.authorProvenance.endpoint, "openalex-works"); assert.equal(records.authorProvenance.complete, true);
	assert.equal(records.authorProfile.id, A_ID); assert.ok(records.every(r => r.authorProfile.id === A_ID));
	assert.ok(snapshots.length > 0 && snapshots.every(n => n > 0), "no empty snapshot is published");
	assert.ok(!urls.some(url => url.startsWith("https://pub.orcid.org")), "ORCID's list is not read when OpenAlex answers");
	const capped = await Authors.loadPublications({ ...profileA, worksCount: 50 }, { maxResults: 2 }, { getJSON: async url => url.includes("/works?") ? { meta: { count: 50 }, results: [alexWork(1), alexWork(2)] } : { results: [] } }, {});
	assert.equal(capped.length, 2); assert.equal(capped.authorProvenance.truncated, true); assert.equal(capped.partial, true);
});

test("when OpenAlex has nothing, fails or is spent, the ORCID list is used and its DOIs are enriched", async () => {
	const works = { path: "/" + A_ID + "/works", group: [1, 2, 3].map(n => group(work(n, { "publication-date": { year: { value: String(2018 + n) } },
		"external-ids": { "external-id": [external("10.5555/w" + n)] } }))) };
	for (const mode of ["empty", "error", "spent"]) {
		const urls = [];
		const http = { async getJSON(url) {
			urls.push(url);
			if (url.startsWith("https://pub.orcid.org/")) return works;
			if (mode === "error" && url.includes("authorships.author.orcid")) throw Object.assign(new Error("boom"), { status: 400 });
			if (url.includes("filter=doi:")) return { results: [{ doi: "https://doi.org/10.5555/w2", cited_by_count: 42, counts_by_year: [] }] };
			return { meta: { count: 0 }, results: [] };
		} };
		const records = await Authors.loadPublications(profileA, { maxResults: 100 }, http, { openAlexSpent: mode === "spent" });
		assert.equal(records.length, 3); assert.equal(records.authorProvenance.via, "orcid");
		assert.equal(urls.some(url => url.includes("authorships.author.orcid")), mode !== "spent");
		assert.equal(urls.some(url => url.includes("filter=doi:")), mode !== "spent", "DOI enrichment is also off once the budget is spent");
		if (mode !== "spent") assert.equal(records.find(r => r.doi === "10.5555/w2").citations, 42);
	}
	const kept = await Authors.loadPublications(profileA, { maxResults: 100, orcidOnly: true }, { getJSON: async url => { assert.ok(url.startsWith("https://pub.orcid.org/")); return works; } }, {});
	assert.equal(kept.length, 3);
});

// ---------------------------------------------------------------- LinkedIn
test("LinkedIn addresses are validated and the search address is built from name and institution", () => {
	const url = Authors.linkedInProfileURL;
	assert.equal(url("https://www.linkedin.com/in/jane-doe/"), "https://www.linkedin.com/in/jane-doe/");
	assert.equal(url("http://kr.linkedin.com/in/jane-doe"), "https://kr.linkedin.com/in/jane-doe");
	assert.equal(url("linkedin.com/in/jane-doe?trk=x#y"), "https://linkedin.com/in/jane-doe");
	assert.equal(url("https://www.linkedin.com/pub/jane/1/2/3"), "https://www.linkedin.com/pub/jane/1/2/3");
	for (const bad of ["https://linkedin.com.evil.test/in/x", "https://evil.test/linkedin.com/in/x", "https://notlinkedin.com/in/x", "https://www.linkedin.com/company/acme", "https://www.linkedin.com/",
		"javascript:alert(1)", "ftp://linkedin.com/in/x", "https://user:pw@www.linkedin.com/in/x", "https://www.linkedin.com:8443/in/x", "", null, "two words linkedin.com/in/x"]) assert.equal(url(bad), null, String(bad));
	const search = Authors.linkedInSearchURL;
	assert.equal(search({ name: "Jennifer A. Doudna", institutions: ["University of California, Berkeley", "Other"] }), "https://www.linkedin.com/search/results/people/?keywords=" + encodeURIComponent("Jennifer A. Doudna University of California, Berkeley"));
	assert.equal(search({ name: "Jae Yoon Sung", affiliation: "Hanbit University; Lab" }), "https://www.linkedin.com/search/results/people/?keywords=" + encodeURIComponent("Jae Yoon Sung Hanbit University"));
	assert.equal(search({ name: "성재윤", lastInstitution: { name: "연세대학교" } }), "https://www.linkedin.com/search/results/people/?keywords=" + encodeURIComponent("성재윤 연세대학교"));
	assert.equal(search({ name: "A&B=C", institutions: ["x y"] }), "https://www.linkedin.com/search/results/people/?keywords=A%26B%3DC%20x%20y");
	assert.ok(decodeURIComponent(search({ name: "N".repeat(300) }).split("keywords=")[1]).length <= 120);
	assert.equal(search({}), null);
	assert.deepEqual(Authors.linkedInTarget({ name: "A B", linkedin: "https://www.linkedin.com/in/ab" }), { kind: "profile", url: "https://www.linkedin.com/in/ab" });
	assert.equal(Authors.linkedInTarget({ name: "A B", linkedin: "https://evil.test/in/ab" }).kind, "search");
	assert.equal(Authors.linkedInTarget({}), null);
});

test("the ORCID researcher-urls lookup returns the first valid LinkedIn profile or null, in one public request", async () => {
	const urls = [];
	const http = rows => ({ async getJSON(url) { urls.push(url); return { path: "/" + A_ID + "/researcher-urls", "researcher-url": rows }; } });
	const item = (value, name = "site") => ({ "url-name": name, url: { value } });
	assert.equal(await Authors.orcidLinkedIn(A_ID, http([item("https://lab.example.org"), item("https://evil.test/in/x"), item("https://www.linkedin.com/in/real-one")])), "https://www.linkedin.com/in/real-one");
	assert.equal(await Authors.orcidLinkedIn(A_ID, http([item("https://lab.example.org")])), null);
	assert.equal(await Authors.orcidLinkedIn(A_ID, http([])), null);
	assert.equal(await Authors.orcidLinkedIn("bad", http([])), null);
	assert.deepEqual([...new Set(urls)], ["https://pub.orcid.org/v3.0/" + A_ID + "/researcher-urls"]);
});

// ---------------------------------------------------------------- the condensed public record
test("an ORCID record is condensed into a biography, positions, education, keywords and websites", () => {
	const aff = (kind, rows) => ({ "affiliation-group": rows.map(r => ({ summaries: [{ [kind + "-summary"]: { "role-title": r[0], organization: { name: r[1] }, "start-date": r[2] && { year: { value: String(r[2]) } },
		"end-date": r[3] ? { year: { value: String(r[3]) } } : null, "department-name": r[4] || null } }] })) });
	const summary = Authors.summarizeOrcidRecord({
		person: { biography: { content: "  Studies   genome engineering.\n\nTeaches too. " }, keywords: { keyword: [{ content: "CRISPR" }, { content: "RNA" }, { content: "CRISPR" }] },
			"researcher-urls": { "researcher-url": [{ "url-name": "Lab", url: { value: "https://lab.example.org" } }, { "url-name": "LI", url: { value: "http://www.linkedin.com/in/real" } }, { url: { value: "javascript:alert(1)" } }] } },
		employments: aff("employment", [["Postdoc", "Old Lab", 2005, 2009], ["Professor", "Example University", 2012, null], ["Fellow", "Mid Institute", 2009, 2012], ["Lecturer", "Side", 2010, 2011]]),
		educations: aff("education", [["PhD", "Harvard", 1998, 2002], ["BA", "Pomona", 1994, 1998]]) });
	assert.equal(summary.bio, "Studies genome engineering. Teaches too."); assert.equal(summary.bioClamped, false);
	assert.deepEqual(summary.keywords, ["CRISPR", "RNA"]);
	assert.deepEqual(summary.websites.map(w => [w.url, w.linkedin]), [["https://www.linkedin.com/in/real", true], ["https://lab.example.org/", false]]);
	assert.equal(summary.linkedin, "https://www.linkedin.com/in/real");
	assert.deepEqual(summary.employments.map(e => e.org), ["Example University", "Side", "Mid Institute", "Old Lab"], "what is current first, then newest start");
	assert.equal(summary.employments[0].current, true); assert.equal(summary.employments[1].end, 2011);
	assert.deepEqual(summary.educations.map(e => e.role + "|" + e.end), ["PhD|2002", "BA|1998"]);
	assert.equal(summary.empty, false);
});

test("an empty ORCID record says so and a long biography is cut at a word with an ellipsis", () => {
	for (const input of [undefined, {}, { person: { biography: null, keywords: { keyword: [] }, "researcher-urls": { "researcher-url": [] } }, employments: { "affiliation-group": [] }, educations: {} },
		{ person: { biography: { content: "   " } } }]) {
		const summary = Authors.summarizeOrcidRecord(input);
		assert.equal(summary.empty, true); assert.equal(summary.bio, ""); assert.deepEqual([summary.keywords, summary.websites, summary.employments, summary.educations], [[], [], [], []]); assert.equal(summary.linkedin, null);
	}
	const long = "word ".repeat(600), summary = Authors.summarizeOrcidRecord({ person: { biography: { content: long } } });
	assert.equal(summary.bioClamped, true); assert.ok(summary.bio.length <= 1201); assert.ok(summary.bio.endsWith("…") && !summary.bio.endsWith(" …"));
	assert.ok(summary.bio.slice(0, -1).split(" ").every(part => part === "word"), "cut between words");
	const rows = Authors.summarizeOrcidRecord({ employments: { "affiliation-group": Array.from({ length: 30 }, (_, n) => ({ summaries: [{ "employment-summary": { organization: { name: "Org " + n }, "start-date": { year: { value: String(1990 + n % 30) } } } }] })) } });
	assert.equal(rows.employments.length, 20); assert.equal(Authors.summarizeOrcidRecord({ employments: { "affiliation-group": [{ summaries: [{ "employment-summary": { organization: null } }] }] } }).empty, true);
});

test("the record summary asks for three small public sections, keeps what answered, and fails only if all fail", async () => {
	const urls = [];
	const http = fail => ({ async getJSON(url) {
		urls.push(url); const section = url.split("/").pop();
		if (fail.includes(section)) throw Object.assign(new Error("nope"), { status: 500 });
		return section === "person" ? { path: "/" + A_ID + "/person", biography: { content: "Hello" } } : { path: "/" + A_ID + "/" + section, "affiliation-group": [] };
	} });
	const ok = await Authors.orcidSummary(A_ID, http([]));
	assert.deepEqual(urls.map(url => url.split("/").pop()).sort(), ["educations", "employments", "person"]); assert.equal(ok.bio, "Hello"); assert.equal(ok.partial, false);
	const partial = await Authors.orcidSummary(A_ID, http(["employments"])); assert.equal(partial.partial, true); assert.equal(partial.bio, "Hello");
	await assert.rejects(Authors.orcidSummary(A_ID, http(["person", "employments", "educations"])), /nope/);
	await assert.rejects(Authors.orcidSummary("bad", http([])), /Invalid ORCID/);
});

test("an ORCID record capped by the result limit keeps its newest works, not the first ones listed (round 6, Astra 4)", async () => {
	const dated = (n, year) => group(work(n, { "publication-date": { year: { value: String(year) } } }));
	const records = await Authors.loadPublications(orcidProfile, { maxResults: 2, orcidOnly: true }, { getJSON: async () => ({ group: [dated(1, 2010), dated(2, 2026), dated(3, 2020), group(work(4, { "publication-date": null }))] }) }, {});
	assert.deepEqual(records.map(r => r.year), [2026, 2020]);
	assert.equal(records.authorProvenance.truncated, true);
});

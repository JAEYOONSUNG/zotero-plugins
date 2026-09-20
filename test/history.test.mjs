import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import History from "../content/history.js";

const query = { keywords: "Geobacillus", authors: "", yearFrom: 2020, maxResults: 1000, sort: "relevance" };
const records = [{ key: "openalex:W1", title: "A paper", doi: "10.1/a" }, { key: "crossref:10.1/b", title: "B paper" }];

function store(extra = {}) {
	const io = History.memoryIO();
	let tick = 0;
	const now = () => new Date(Date.UTC(2026, 8, 18, 12, 0, tick++));
	return { io, history: History.create({ io, dir: "/data/zotpop/history", now, ...extra }) };
}

test("loads in Gecko without CommonJS", () => {
	const context = vm.createContext({});
	vm.runInContext(fs.readFileSync(new URL("../content/history.js", import.meta.url), "utf8"), context);
	assert.deepEqual(Object.keys(context.ZotPoPHistory), Object.keys(History));
});

test("the same query written differently lands on the same entry", () => {
	const a = History.signature("multi", query);
	assert.equal(a, History.signature("multi", { ...query, keywords: "  geobacillus ", authors: null }));
	assert.notEqual(a, History.signature("openalex", query), "a different source is a different search");
	assert.notEqual(a, History.signature("multi", { ...query, yearFrom: 2021 }));
	assert.match(a, /^[0-9a-f]{16}$/);
});

test("a finished search is written with its records and comes back without any network", async () => {
	const { io, history } = store();
	const id = await history.save({ source: "multi", query, records });
	assert.equal(id, History.signature("multi", query));
	assert.ok(io.files.has("/data/zotpop/history/" + id + ".json"));
	const entry = await history.get(id);
	assert.deepEqual(entry.records, records);
	assert.equal(entry.source, "multi");
	assert.equal(entry.query.keywords, "Geobacillus");
	assert.equal(entry.partial, false);
	const found = await history.find("multi", { ...query, keywords: "GEOBACILLUS" });
	assert.equal(found.id, id);
	assert.equal(found.count, 2);
	assert.equal(found.label, "Geobacillus · 2020–");
});

test("re-running a search replaces its entry; the list is newest first and capped", async () => {
	const { io, history } = store({ max: 2 });
	await history.save({ source: "multi", query, records });
	await history.save({ source: "multi", query: { keywords: "second" }, records });
	await history.save({ source: "multi", query, records: records.slice(0, 1) });
	let list = await history.list();
	assert.deepEqual(list.map(e => e.label), ["Geobacillus · 2020–", "second"]);
	assert.equal(list[0].count, 1, "the newer run replaced the older one");
	await history.save({ source: "openalex", query: { keywords: "third" }, records });
	list = await history.list();
	assert.deepEqual(list.map(e => e.label), ["third", "Geobacillus · 2020–"]);
	assert.equal([...io.files.keys()].filter(p => p.endsWith(".json") && !p.endsWith("index.json")).length, 2, "dropped entries lose their file");
});

test("an index line whose file is gone is dropped on first use rather than offered forever", async () => {
	const { io, history } = store();
	const id = await history.save({ source: "multi", query, records });
	io.files.delete("/data/zotpop/history/" + id + ".json");
	assert.equal(await history.get(id), null);
	assert.equal((await history.list()).length, 0);
});

test("empty, oversized and malformed input is refused without touching the store", async () => {
	const { io, history } = store({ maxBytes: 200 });
	assert.equal(await history.save({ source: "multi", query, records: [] }), null);
	assert.equal(await history.save({ source: "", query, records }), null);
	assert.equal(await history.save({ source: "multi", query, records: Array.from({ length: 50 }, () => records[0]) }), null, "over the byte cap");
	assert.equal(io.files.size, 0);
	assert.equal(await history.get("../../etc/passwd"), null);
	io.files.set("/data/zotpop/history/index.json", "{not json");
	assert.deepEqual(await history.list(), []);
});

test("a partial search is kept and marked, and clear forgets everything", async () => {
	const { io, history } = store();
	await history.save({ source: "multi", query, records, partial: true });
	const [entry] = await history.list();
	assert.equal(entry.partial, true);
	await history.remove(entry.id);
	assert.equal((await history.list()).length, 0);
	await history.save({ source: "multi", query, records });
	await history.clear();
	assert.equal((await history.list()).length, 0);
	assert.equal([...io.files.keys()].filter(p => !p.endsWith("index.json")).length, 0);
});

test("the persisted index survives a fresh instance over the same files", async () => {
	const io = History.memoryIO();
	const first = History.create({ io, dir: "/h" });
	await first.save({ source: "multi", query, records });
	const second = History.create({ io, dir: "/h" });
	const list = await second.list();
	assert.equal(list.length, 1);
	assert.deepEqual((await second.get(list[0].id)).records, records);
});

test("combined source selection is part of cache identity, with legacy default compatibility", () => {
	const base = { keywords: "Geobacillus", maxResults: 1000 };
	const defaults = ["openalex", "crossref", "europepmc", "arxiv"];
	assert.equal(History.signature("multi", base), History.signature("multi", { ...base, sources: defaults }));
	assert.equal(History.signature("multi", { ...base, sources: ["scholar", "pubmed"] }),
		History.signature("multi", { ...base, sources: ["pubmed", "scholar", "scholar"] }));
	assert.notEqual(History.signature("multi", base), History.signature("multi", { ...base, sources: [...defaults, "scholar"] }));
	assert.notEqual(History.signature("multi", base), History.signature("multi", { ...base, sources: [] }));
});

test("Boolean operators cannot collide with literal lowercase words in cached queries", async () => {
	for (const field of ["title", "keywords", "venue"]) {
		assert.notEqual(History.signature("openalex", { [field]: "cancer OR diabetes" }),
			History.signature("openalex", { [field]: "cancer or diabetes" }));
		assert.equal(History.signature("openalex", { [field]: 'Cancer OR "DNA AND RNA"' }),
			History.signature("openalex", { [field]: 'cancer OR "dna and rna"' }));
	}
	const { io, history } = store();
	const literal = { title: "cancer or diabetes", maxResults: 10 };
	const boolean = { ...literal, title: "cancer OR diabetes" };
	const legacyID = History.signature("openalex", literal);
	io.files.set("/data/zotpop/history/index.json", JSON.stringify({ entries: [
		{ id: legacyID, source: "openalex", query: boolean, savedAt: "2026-09-20T00:00:00Z", count: 1 }
	] }));
	assert.equal(await history.find("openalex", literal), null, "a legacy lowercased key is not proof of the same query");
});

test("PoP history keys preserve native case, whitespace, profile, fields and output sort", () => {
	const q = { engine: "pop", keywords: "GeneA OR GeneB", maxResults: 30, popOutputSort: "rank", popProfile: "pop-default" };
	for (const changed of [{ keywords: "genea OR geneb" }, { keywords: "GeneA  OR GeneB" }, { popProfile: "/another/profile" },
		{ popOutputSort: "-cites" }, { affiliation: "A university" }, { issn: "1234-5678" }, { citedId: "cluster1" }, { field: "biology" }, { popRaw: "x:y" }, { engine: "direct" }]) {
		assert.notEqual(History.signature("crossref", q), History.signature("crossref", { ...q, ...changed }), JSON.stringify(changed));
	}
	assert.notEqual(History.signature("crossref", q), History.signature("pubmed", q));
	assert.equal(History.signature("crossref", {}), History.signature("crossref", { engine: "direct" }), "legacy direct keys stay compatible");
});

test("author history separates input, provider, action and case-sensitive profile IDs", () => {
	const q = { mode: "author", authorProvider: "scholar", authorInput: "Name As Typed", authorAction: "publications", authorProfileId: "dsdG3ewAAAAJ", maxResults: 100, popProfile: "pop-default" };
	for (const changed of [{ authorInput: "name as typed" }, { authorInput: "Name  As Typed" }, { authorProvider: "orcid" }, { authorAction: "name-papers" },
		{ authorProfileId: "dsdg3ewaaaaj" }, { maxResults: 200 }, { popProfile: "/other" }, { mode: "papers" }]) {
		assert.notEqual(History.signature("author:scholar", q), History.signature("author:scholar", { ...q, ...changed }));
	}
	assert.equal(History.signature("author:scholar", q), History.signature("author:scholar", { ...q, authorProfile: { id: q.authorProfileId, name: "Updated name" } }), "card metadata is not coerced to a query identity string");
});

test("only valid author profile cards allow history without publication rows and are counted as profiles", async () => {
	const { history } = store();
	const profile = { provider: "orcid", id: "0000-0001-8277-5907", name: "Sheila Ingemann Jensen" };
	const query = { mode: "author", authorProvider: "orcid", authorInput: profile.id, authorAction: "profiles", maxResults: 1000, authorProfiles: [profile] };
	const id = await history.save({ source: "author:orcid", query, records: [] });
	assert.ok(id); const saved = await history.get(id); assert.deepEqual(saved.records, []); assert.deepEqual(saved.query.authorProfiles, [profile]);
	const [entry] = await history.list(); assert.equal(entry.kind, "profiles"); assert.equal(entry.count, 1); assert.match(entry.label, /ORCID/);
	for (const authorProfiles of [[], [null], [{ provider: "orcid", id: "" }], [{ provider: "scholar", id: "other" }]]) {
		assert.equal(await history.save({ source: "author:orcid", query: { ...query, authorProfiles }, records: [] }), null);
	}
	assert.equal(await history.save({ source: "orcid", query: { ...query, mode: "papers" }, records: [] }), null);
});

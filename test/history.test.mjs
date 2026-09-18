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

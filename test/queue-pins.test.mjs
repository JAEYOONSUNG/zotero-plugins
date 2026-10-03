import { test } from "node:test";
import assert from "node:assert/strict";
import { paper, uiHarness } from "./helpers/search-ui-harness.mjs";

const importer = (held = new Map()) => ({ getReadingStates: async () => new Map(), getLibraryDOIMap: async () => new Map(), forgetTitleIndex() {},
	importRecord: async r => r.key === "bad" ? { status: "failed", error: "nope" } : held.has(r.key) ? { status: "exists", item: { id: held.get(r.key) }, pdf: "skipped" } : { status: "added", item: { id: 40 + r.key.length }, pdf: "no pdf", how: "translator" } });

function fakeStyleCustom() {
	const calls = [], queued = new Set();
	return { calls, queued, queueForReading(items, opts) { calls.push({ ids: Array.from(items, i => i.id), opts }); for (const i of items) queued.add(i.id); return Promise.resolve(); }, isQueued: item => queued.has(item.id) };
}

async function setup(extra = {}, sc = fakeStyleCustom()) {
	const ui = uiHarness({ importer: importer(extra.held), zotero: { StyleCustom: extra.noSC ? undefined : sc, Items: { get: id => ({ id }) } },
		search: async () => [paper("a", { title: "Alpha" }), paper("bad"), paper("c", { title: "Gamma" })] });
	ui.get("keywords").value = "crispr";
	await ui.runSearch(); ui.wireEvents();
	return { ui, sc };
}

test("add and queue: the option queues what was added, with the search as the reason", async () => {
	const { ui, sc } = await setup();
	ui.get("opt-queue").checked = true;
	await ui.importRecords(ui.state.records.filter(r => r.key !== "bad"));
	assert.equal(sc.calls.length, 1);
	assert.equal(sc.calls[0].opts.source, "zotpop");
	assert.match(sc.calls[0].opts.reason, /^queueReason\|.*crispr/);
	assert.equal(sc.calls[0].ids.length, 2);
});

test("a failed import is not queued, and without the option nothing is queued", async () => {
	const { ui, sc } = await setup();
	ui.get("opt-queue").checked = true;
	await ui.importRecords([ui.state.records.find(r => r.key === "bad")]);
	assert.equal(sc.calls.length, 0);
	ui.get("opt-queue").checked = false;
	await ui.importRecords([ui.state.records[0]]);
	assert.equal(sc.calls.length, 0);
});

test("the detail's add-and-queue imports then queues; an owned paper offers the queue directly and shows it pressed", async () => {
	const { ui, sc } = await setup({ held: new Map([["c", 77]]) });
	const [a, , c] = ui.state.records;
	ui.state.detailKey = a.key;
	ui.originalRenderDetail();
	assert.equal(ui.get("d-queue").hidden, false);
	assert.equal(ui.get("d-queue-label").textContent, "dAddQueue");
	await ui.get("d-queue").emit("click");
	await new Promise(r => setTimeout(r, 10));
	assert.equal(sc.calls.length, 1);
	assert.equal(a.inLibrary, true);
	// An owned paper: "읽기 대기" directly, then pressed.
	c.inLibrary = true; c.libraryItemID = 77;
	ui.state.detailKey = c.key;
	ui.originalRenderDetail();
	assert.equal(ui.get("d-queue-label").textContent, "dQueue");
	assert.equal(ui.get("d-queue").getAttribute("aria-pressed"), "false");
	await ui.get("d-queue").emit("click");
	await new Promise(r => setTimeout(r, 10));
	assert.deepEqual(sc.calls.at(-1).ids, [77]);
	assert.equal(ui.get("d-queue").getAttribute("aria-pressed"), "true");
	assert.equal(ui.get("d-queue").disabled, true);
	assert.equal(ui.get("d-queue-label").textContent, "dQueued");
});

test("without Style Custom's queue the controls stay hidden and import is unchanged", async () => {
	const { ui } = await setup({ noSC: true });
	ui.state.detailKey = ui.state.records[0].key;
	ui.originalRenderDetail();
	assert.equal(ui.get("d-queue").hidden, true);
	ui.get("opt-queue").checked = true;
	await ui.importRecords([ui.state.records[0]]);
	assert.equal(ui.state.records[0].inLibrary, true);
});

// ---------------------------------------------------------------- pinned searches
import History from "../content/history.js";
const recs = (...ids) => ids.map(id => ({ key: id, title: id, doi: "10.1/" + id }));
const query = { keywords: "crispr" };

test("a pin keeps the results already seen; a later run counts only what it has not shown", async () => {
	const h = History.create({ io: History.memoryIO(), dir: "h" });
	const id = await h.save({ source: "openalex", query, records: recs("a", "b") });
	const pin = await h.pin(id);
	assert.equal(pin.seen.length, 2);
	assert.equal(pin.newCount, 0);
	await h.save({ source: "openalex", query, records: recs("a", "b", "c", "d") });
	assert.equal((await h.pins())[0].newCount, 2);
	assert.equal((await h.baseline(id)).has("d:10.1/c"), false);
	assert.deepEqual(await h.markSeen(id, recs("a", "b", "c", "d")), { added: 2 });
	assert.equal((await h.pins())[0].newCount, 0);
	assert.equal((await h.pinFor("openalex", query)).id, id);
});

test("zero results, a short or partial run and an oversized run never reset the baseline", async () => {
	const h = History.create({ io: History.memoryIO(), dir: "h" });
	const id = await h.save({ source: "openalex", query, records: recs("a", "b", "c") });
	await h.pin(id);
	assert.equal(await h.markSeen(id, []), null);
	assert.equal(await h.save({ source: "openalex", query, records: [] }), null, "nothing is saved for an empty run");
	await h.save({ source: "openalex", query, records: recs("a"), partial: true });
	let [p] = await h.pins();
	assert.equal(p.seen.length, 3, "a partial run leaves what was seen");
	assert.equal(p.newCount, 0);
	assert.equal(p.partial, true);
	await h.markSeen(id, recs("a", "z"));
	assert.equal((await h.pins())[0].seen.length, 4, "marking only adds");
	const many = Array.from({ length: h.SEEN_CAP + 1 }, (_, i) => ({ key: "k" + i }));
	assert.equal(await h.markSeen(id, many), null);
	await h.save({ source: "openalex", query, records: many });
	assert.equal((await h.pins())[0].newCount, null, "too many to compare: no count");
	assert.equal((await h.pins())[0].seen.length, 4);
});

test("pinned searches survive the history cap and Clear history, and unpin lets go", async () => {
	const h = History.create({ io: History.memoryIO(), dir: "h", max: 2 });
	const first = await h.save({ source: "openalex", query: { keywords: "one" }, records: recs("a") });
	await h.pin(first);
	for (const word of ["two", "three", "four"]) await h.save({ source: "openalex", query: { keywords: word }, records: recs("b") });
	const ids = (await h.list()).map(e => e.id);
	assert.ok(ids.includes(first), "the pinned entry is kept past the cap");
	await h.clear();
	assert.deepEqual((await h.list()).map(e => e.id), [first]);
	assert.ok(await h.get(first));
	await h.unpin(first);
	assert.equal((await h.pins()).length, 0);
	await h.clear();
	assert.equal((await h.list()).length, 0);
});

test("author searches cannot be pinned", async () => {
	const h = History.create({ io: History.memoryIO(), dir: "h" });
	const id = await h.save({ source: "scholar", query: { mode: "author", authorProvider: "orcid", authorInput: "0000-0001" }, records: recs("a") });
	assert.equal(await h.pin(id), null);
});

test("UI: the menu lists pins first with their new count; opening one marks what is new and updates the seen set", async () => {
	const files = new Map();
	let results = recs("a", "b");
	const ui = uiHarness({ historyFiles: files, search: async () => results.map(r => ({ ...r })) });
	await ui.runSearch();
	await ui.history.list();
	const [entry] = await ui.history.list();
	ui.wireEvents();
	await ui.history.pin(entry.id);
	results = recs("a", "b", "c");
	await ui.runSearch();
	await ui.openHistoryMenu();
	const menu = ui.get("histmenu");
	const rows = menu.querySelectorAll("div.histopt");
	assert.equal(rows.length, 1, "the pinned search is not listed twice");
	assert.match(menu.textContent, /pinnedSearches/);
	assert.match(menu.querySelector("span.h-new").textContent, /pinNew\|1/);
	// Opening it shows the stored result with the unseen row marked, then the seen set grows.
	await ui.openHistoryEntry(entry.id, { pin: (await ui.history.pins())[0] });
	assert.deepEqual(Array.from(ui.state.records.filter(r => r.isNew), r => r.key), ["c"]);
	assert.equal((await ui.history.pins())[0].newCount, 0);
	await ui.openHistoryEntry(entry.id, { pin: (await ui.history.pins())[0] });
	assert.equal(ui.state.records.filter(r => r.isNew).length, 0, "nothing is new the second time");
});

test("UI: running a pin again is explicit, marks new rows against the pin and counts them as seen; an empty run changes nothing", async () => {
	let results = recs("a", "b"), calls = 0;
	const ui = uiHarness({ search: async () => { calls++; return results.map(r => ({ ...r })); } });
	await ui.runSearch();
	const [entry] = await ui.history.list();
	await ui.history.pin(entry.id);
	assert.equal(calls, 1);
	results = recs("a", "b", "n");
	const pin = (await ui.history.pins())[0];
	await ui.openHistoryEntry(pin.id, { pin, rerun: true });
	assert.equal(calls, 2, "the search ran once, on request");
	assert.deepEqual(Array.from(ui.state.records.filter(r => r.isNew), r => r.key), ["n"]);
	assert.equal((await ui.history.pins())[0].seen.length, 3);
	results = [];
	await ui.openHistoryEntry(pin.id, { pin, rerun: true });
	assert.equal((await ui.history.pins())[0].seen.length, 3, "zero results keep the baseline");
	assert.equal(ui.state.pinLook ?? null, null);
});

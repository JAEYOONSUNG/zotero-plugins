import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

test("getCollectionPaths walks each collection's parents into a name path, from one query", async () => {
	const cols = new Map([[1, { name: "A", parentID: null }], [2, { name: "B", parentID: 1 }], [3, { name: "C", parentID: 2 }], [4, { name: "D", parentID: null }]]);
	let queries = 0;
	const context = vm.createContext({ Zotero: { Collections: { get: id => cols.get(id) },
		DB: { queryAsync: async () => { queries++; return [{ itemID: 10, collectionID: 3 }, { itemID: 10, collectionID: 4 }, { itemID: 11, collectionID: 1 }]; } } } });
	vm.runInContext(fs.readFileSync(new URL("../content/importer.js", import.meta.url), "utf8"), context);
	const out = await context.ZotPoPImporter.getCollectionPaths([10, 11, 12]);
	assert.deepEqual(JSON.parse(JSON.stringify(out.get(10))), [["A", "B", "C"], ["D"]]);
	assert.deepEqual(JSON.parse(JSON.stringify(out.get(11))), [["A"]]);
	assert.equal(out.has(12), false);
	assert.equal(queries, 1);
});

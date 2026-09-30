import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPreview, checkPreview, FAKE } from "../scripts/search-preview.mjs";

test("search preview: real ui.js renders fictional rows into static, asset-free pages", async () => {
	const out = await buildPreview();
	assert.deepEqual(checkPreview(out), []);
	assert.equal(out.rows, FAKE.length);
	assert.equal(out.netCalls, 0, "the preview never touches the network");
	assert.match(out.results, /<style>[\s\S]*<\/style>/, "the real search.css is inlined");
	assert.match(out.results, /Search engine/, "the real i18n strings are applied to the markup");
	assert.match(out.detail, /Open in browser/, "the selected row fills the detail pane");
});

/* The user's JCR export is a plain list named jcr.json, with no year. It is never renamed or rewritten:
   the edition year is set in Preferences and kept in jcr.meta.json beside it, which counts only for that
   file while it still has the same rows. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import JCR from "../content/jcr.js";
import I18N from "../content/i18n.js";
import { uiHarness } from "./helpers/search-ui-harness.mjs";

const rows = [["NATURE METHODS", "NAT METHODS", "1548-7091", "1548-7105", 32.1], ["CELL", "CELL", "0092-8674", "1097-4172", 42.5]];

test("edition: the file's own year, then its name, then the sidecar, which must name the file and match its rows", () => {
	const meta = { jcrYear: 2025, file: "jcr.json", rows: 2 };
	assert.equal(JCR.editionOf(rows, "jcr.json", meta).label, "JCR 2025 (JIF 2024)");
	assert.equal(JCR.editionOf(rows, "jcr.json", meta).from, "meta");
	assert.equal(JCR.editionOf(rows, "jcr.json", { ...meta, rows: 3 }).label, "JCR", "a new export under the old name is not given last year's label");
	assert.equal(JCR.editionOf(rows, "jcr.json", { ...meta, file: "other.json" }).label, "JCR");
	assert.equal(JCR.editionOf(rows, "jcr-2026.json", meta).label, "JCR 2026 (JIF 2025)", "the name outranks the sidecar");
	assert.equal(JCR.editionOf({ jcrYear: 2024, rows }, "jcr.json", meta).label, "JCR 2024 (JIF 2023)", "the file outranks both");
	assert.equal(JCR.editionOf(rows, "jcr.json", { jcrYear: "soon", file: "jcr.json" }).label, "JCR");
});

test("status: a plain list offers to set the year; a dated file does not; a stale sidecar says so", () => {
	const plain = JCR.statusOf({ fileName: "jcr.json", data: rows, now: new Date("2026-10-06") });
	assert.deepEqual([plain.rows, plain.canSetYear, plain.suggest, plain.edition.label], [2, true, 2026, "JCR"]);
	assert.equal(JCR.statusOf({ fileName: "jcr-2026.json", data: rows }).canSetYear, false);
	assert.equal(JCR.statusOf({ fileName: "jcr.json", data: rows, meta: { jcrYear: 2025, file: "jcr.json", rows: 9 } }).staleMeta, true);
	assert.equal(JCR.statusOf({ fileName: "jcr.json", data: rows, now: new Date("2026-03-01") }).suggest, 2025, "before the June release, last year's");
	assert.equal(JCR.metaRecord("20x5", "jcr.json", rows), null);
	assert.deepEqual((({ jcrYear, file, rows: n }) => ({ jcrYear, file, rows: n }))(JCR.metaRecord("2025", "/a/b/jcr.json", rows)), { jcrYear: 2025, file: "jcr.json", rows: 2 });
});

/* The preferences pane's code (src/zotpop.js) against a fake data directory. */
function pane(files) {
	const writes = [];
	const IOUtils = {
		exists: async p => files.has(p) || [...files.keys()].some(k => k.startsWith(p + "/")),
		getChildren: async dir => [...files.keys()].filter(k => k.startsWith(dir + "/")).map(k => k),
		readUTF8: async p => { if (!files.has(p)) throw new Error("absent"); return files.get(p); },
		writeUTF8: async (p, text) => { writes.push(p); files.set(p, text); }
	};
	const els = new Map();
	const el = id => { if (!els.has(id)) els.set(id, { id, value: "", hidden: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } }); return els.get(id); };
	const doc = { getElementById: el, querySelectorAll: () => [] };
	const Zotero = { Prefs: { get: () => "en" }, locale: "en-US", DataDirectory: { dir: "/z" }, debug() {}, logError: e => { throw e; }, ZotPoPI18N: I18N };
	const ctx = vm.createContext({ Zotero, IOUtils, PathUtils: { join: (...p) => p.join("/") }, ChromeUtils: {},
		Services: { scriptloader: { loadSubScript: (url, scope) => { vm.runInContext(fs.readFileSync(new URL("../content/jcr.js", import.meta.url), "utf8") + "\nthis.ZotPoPJCR = ZotPoPJCR;", vm.createContext(scope)); } } } });
	vm.runInContext(fs.readFileSync(new URL("../src/zotpop.js", import.meta.url), "utf8"), ctx);
	Zotero.ZotPoP.rootURI = "chrome://zotpop/";
	return { plugin: Zotero.ZotPoP, doc, el, writes, files };
}

test("the pane: the status line names the file, its journals and that the year is unknown, and sets it beside the file", async () => {
	const files = new Map([["/z/zotpop/journals/jcr.json", JSON.stringify(rows)], ["/z/zotpop/journals/journal-registry.json", "[]"]]);
	const { plugin, doc, el, writes } = pane(files);
	await plugin.showJcrStatus(doc);
	assert.match(el("zotpop-jcr-status").value, /^jcr\.json · 2 journals · edition year unknown$/);
	assert.equal(el("zotpop-jcr-year-save").hidden, false);
	assert.equal(el("zotpop-jcr-year").hidden, false);
	assert.match(el("zotpop-jcr-year").value, /^20\d\d$/, "one click: a likely year is filled in");
	el("zotpop-jcr-year").value = "2025";
	const before = files.get("/z/zotpop/journals/jcr.json");
	await plugin.saveJcrYear(doc);
	assert.deepEqual(writes, ["/z/zotpop/journals/jcr.meta.json"], "only the sidecar is written");
	assert.equal(files.get("/z/zotpop/journals/jcr.json"), before, "the export is untouched and keeps its name");
	assert.deepEqual((({ jcrYear, file, rows: n }) => ({ jcrYear, file, rows: n }))(JSON.parse(files.get("/z/zotpop/journals/jcr.meta.json"))), { jcrYear: 2025, file: "jcr.json", rows: 2 });
	assert.match(el("zotpop-jcr-status").value, /JCR 2025 \(JIF 2024\) \(year set here, in jcr\.meta\.json\) Saved\./);
	el("zotpop-jcr-year").value = "next";
	await plugin.saveJcrYear(doc);
	assert.equal(writes.length, 1, "a non-year writes nothing");
	assert.match(el("zotpop-jcr-status").value, /Enter a year/);
});

test("the pane: a dated file needs no year control; the update line no longer calls a string", async () => {
	const { plugin, doc, el } = pane(new Map([["/z/zotpop/journals/jcr-2026.json", JSON.stringify(rows)]]));
	await plugin.showJcrStatus(doc);
	assert.match(el("zotpop-jcr-status").value, /JCR 2026 \(JIF 2025\) \(from the file name\)/);
	assert.equal(el("zotpop-jcr-year-save").hidden, true);
	assert.match(plugin.updateStatusText({ status: "current", version: "0.55.0" }), /^Up to date \(0\.55\.0\)/);
});

test("the markup: the set-year button is marked as writing, and its strings exist in both languages", () => {
	const markup = fs.readFileSync(new URL("../content/preferences.xhtml", import.meta.url), "utf8");
	assert.match(markup, /id="zotpop-jcr-year-save"[^>]*data-writes="jcr-meta"/);
	for (const k of ["prefJcrNone", "prefJcrBroken", "prefJcrStatus", "prefJcrYearLabel", "prefJcrYearSet", "prefJcrYearInvalid", "prefJcrYearSaved"])
		for (const lang of ["en", "ko"]) assert.ok(k in I18N.STRINGS[lang], `${lang}: ${k}`);
	assert.match(I18N.STRINGS.en.prefJournalFolderNote, /jcr\.meta\.json/);
	assert.match(I18N.STRINGS.ko.prefJournalFolderNote, /jcr\.meta\.json/);
});

test("the search window labels a plain jcr.json with the year from the sidecar", async () => {
	const files = new Map([["/z/zotpop/journals/jcr.json", JSON.stringify(rows)], ["/z/zotpop/journals/jcr.meta.json", JSON.stringify({ jcrYear: 2025, file: "jcr.json", rows: 2 })]]);
	const IOUtils = { exists: async p => files.has(p) || p === "/z/zotpop/journals", readUTF8: async p => files.get(p), writeUTF8: async () => {}, getChildren: async () => [...files.keys()], makeDirectory: async () => {}, remove: async () => {} };
	const ui = uiHarness({ globals: { IOUtils, PathUtils: { join: (...p) => p.join("/") } }, zotero: { DataDirectory: { dir: "/z" } } });
	await ui.loadJournalFigures();
	assert.equal(JCR.EDITION, "JCR 2025 (JIF 2024)");
	JCR.load([], { fileName: "" });
});

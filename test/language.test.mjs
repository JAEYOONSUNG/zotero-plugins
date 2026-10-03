/* English is ZotPoP's default language, so every string the window can say must
   exist in English; Korean must have the same keys so switching never shows a
   key name. Both are measured from the source rather than assumed. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import I18N from "../content/i18n.js";

const root = new URL("../", import.meta.url);
const read = name => readFileSync(new URL(name, root), "utf8");
const en = I18N.STRINGS.en, ko = I18N.STRINGS.ko;
const contentFiles = readdirSync(new URL("content/", root)).filter(name => /\.(js|xhtml)$/.test(name) && name !== "i18n.js");

test("English and Korean have exactly the same keys", () => {
	assert.deepEqual(Object.keys(en).filter(key => !(key in ko)), [], "in English only");
	assert.deepEqual(Object.keys(ko).filter(key => !(key in en)), [], "in Korean only");
	for (const key of Object.keys(en)) assert.equal(typeof en[key], typeof ko[key], `${key}: a function in one and text in the other`);
});

test("every string key the window asks for exists in English and Korean", () => {
	const asked = new Map();
	const note = (key, file) => { if (!asked.has(key)) asked.set(key, file); };
	for (const file of contentFiles) {
		const text = read("content/" + file);
		for (const m of text.matchAll(/(?<![\w.$])t\(\s*"([A-Za-z][A-Za-z0-9_]*)"\s*[,)]/g)) note(m[1], file);
		for (const m of text.matchAll(/data-i18n(?:-ph|-title|-aria|-value|-label)?="([^"]+)"/g)) note(m[1], file);
	}
	// Keys built at run time: the author registry kinds, and the reasons a figure may differ.
	for (const kind of ["Scholar", "Orcid", "Combined"]) for (const part of ["Input", "Help", "HelpMore"]) note(`author${kind}${part}`, "ui.js (author kind)");
	for (const reason of ["namesakes", "filtered", "basis", "otherIndex", "unknown", "match"]) note("metricsWhy_" + reason, "ui.js (metrics reasons)");
	assert.ok(asked.size > 400, `the scan should see the whole window, saw ${asked.size}`);
	const missing = [...asked].filter(([key]) => !(key in en)).map(([key, file]) => `${file}: ${key}`);
	assert.deepEqual(missing, [], "these would show as a bare key name in English");
	const missingKo = [...asked].filter(([key]) => !(key in ko)).map(([key, file]) => `${file}: ${key}`);
	assert.deepEqual(missingKo, []);
});

test("the English strings are English: no Hangul except the name of the language", () => {
	const text = value => typeof value === "function" ? value.toString() : String(value);
	const bad = Object.entries(en).filter(([, value]) => /[가-힣]/.test(text(value).replace(/한국어|Zotero 언어 따르기|언어/g, ""))).map(([key]) => key);
	assert.deepEqual(bad, []);
});

test("the window's own markup carries no Korean beyond the names of the languages", () => {
	for (const file of contentFiles.filter(name => name.endsWith(".xhtml"))) {
		const text = read("content/" + file).replace(/<!--[\s\S]*?-->/g, "");
		assert.doesNotMatch(text, /[가-힣]/, file);
	}
});

test("numbers and dates are written in the window's language", () => {
	const t = I18N.make("en");
	assert.equal(t.locale, "en");
	assert.equal(I18N.make("ko").locale, "ko");
	// A count in a status line uses the language's own grouping and its own plural.
	assert.match(en.resultCount("OpenAlex", 1, false, 5000), /^1 result from OpenAlex/);
	assert.match(en.resultCount("OpenAlex", 2, false, 5000), /^2 results from OpenAlex/);
	assert.match(en.resultCount("OpenAlex", 2, false, 5000), /5,000/);
	assert.match(ko.resultCount("OpenAlex", 2, false, 5000), /5,000/);
	const source = read("content/ui.js");
	assert.doesNotMatch(source, /\.toLocale(?:Date|Time)?String\(\s*\)/, "never the operating system's locale");
	assert.doesNotMatch(source, /\.toLocale(?:Date|Time)?String\(\s*undefined/);
});

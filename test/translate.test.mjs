import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import T from "../content/translate.js";
import I18N from "../content/i18n.js";

const make = (zotero, prefs = {}, extra = {}) => T.create({ zotero, pref: k => prefs[k], uiLocale: "ko", pluginID: "zotpop@sungjaeyoon.dev", ...extra });
const withPDF = translate => ({ PDFTranslate: { api: { translate } } });

test("Translate for Zotero is called as translate(text, { langto, pluginID }) and its object answer is read", async () => {
	const calls = [];
	const tr = make(withPDF(async function (text, options) { calls.push({ text, options, self: this }); return { status: "success", result: "  안녕  ", service: "deeplfree" }; }));
	const out = await tr.translate("Hello", "ko");
	assert.deepEqual(out, { text: "안녕", service: "DeepL Free", backend: "pdftranslate" });
	assert.deepEqual(calls[0].options, { langto: "ko-KR", pluginID: "zotpop@sungjaeyoon.dev" });
	assert.equal(calls[0].text, "Hello");
	assert.ok(calls[0].self && typeof calls[0].self.translate === "function", "called as a method of its api");
	assert.equal((await make(withPDF(async () => "plain")).translate("x", "ja")).text, "plain", "a bare string is accepted");
	assert.equal((await make(withPDF(async () => ({ result: "r" }))).translate("x", "ja")).service, "Translate for Zotero", "no service named: the plugin's own name");
	assert.equal((await make(withPDF(async () => ({ result: "r", raw: { service: "googleapi" } }))).translate("x", "de")).service, "Google Translate");
	assert.equal((await make(withPDF(async () => ({ result: "r", service: "customsvc" }))).translate("x", "de")).service, "customsvc", "an unknown id is shown as is");
	const target = [];
	const lang = make(withPDF(async (_t, o) => { target.push(o.langto); return "x"; }));
	for (const code of ["en", "zh-CN", "zh-TW", "fr", "es"]) await lang.translate("t", code);
	assert.deepEqual(target, ["en-US", "zh-CN", "zh-TW", "fr-FR", "es-ES"]);
});

test("a failing or empty answer from Translate for Zotero is an error with its reason, not a blank translation", async () => {
	const failing = [() => ({ status: "fail", result: "quota exceeded" }), () => ({ status: "failed" }), () => ({ error: { message: "bad key" } }), () => ({ status: "processing" }),
		() => ({ result: "   " }), () => null, () => { throw new Error("boom"); }, () => Promise.reject(new Error("rejected"))];
	for (const f of failing) await assert.rejects(make(withPDF(async () => f())).translate("x", "ko"), e => e.code === "failed" && e.message.length > 0);
	await assert.rejects(make(withPDF(async () => ({ status: "fail", result: "quota exceeded" }))).translate("x", "ko"), /quota exceeded/);
	await assert.rejects(make(withPDF(async () => "x")).translate("   ", "ko"), e => e.code === "empty");
	await assert.rejects(make(withPDF(async () => "x")).translate("x", "tlh"), e => e.code === "failed");
});

test("a translation that never answers gives up", async () => {
	const tr = make(withPDF(() => new Promise(() => {})), {}, { timeout: 30 });
	await assert.rejects(tr.translate("x", "ko"), /timed out/);
});

test("with the plugin absent: the endpoint of the reader's own, else a message that says how to enable it", async () => {
	const posts = [];
	const post = async (url, headers, body) => { posts.push({ url, headers, body }); return { choices: [{ message: { content: " 번역문 " } }] }; };
	const prefs = { aiEndpoint: "https://api.example.invalid/v1", aiModel: "model-x", aiKey: "sk-secret" };
	const tr = make({}, prefs, { post });
	const out = await tr.translate("Hello", "ko");
	assert.deepEqual(out, { text: "번역문", service: "model-x", backend: "ai" });
	assert.equal(posts[0].url, "https://api.example.invalid/v1/chat/completions");
	assert.equal(posts[0].headers.Authorization, "Bearer sk-secret");
	assert.equal(posts[0].body.model, "model-x");
	assert.match(posts[0].body.messages[0].content, /Korean/);
	assert.equal(posts[0].body.messages[1].content, "Hello");
	assert.doesNotMatch(JSON.stringify(posts[0].body), /sk-secret|@/, "no key or e-mail travels in the body");
	// a full path is taken as given; no key means no Authorization header
	const full = make({}, { aiEndpoint: "http://localhost:11434/v1/chat/completions", aiModel: "m" }, { post });
	await full.translate("x", "en");
	assert.equal(posts[1].url, "http://localhost:11434/v1/chat/completions"); assert.equal("Authorization" in posts[1].headers, false);
	// a key is never sent over plain http to another machine, and half a setup is no setup
	for (const bad of [{ aiEndpoint: "http://example.com/v1", aiModel: "m" }, { aiEndpoint: "https://x.invalid/v1" }, { aiModel: "m" }, {}]) {
		await assert.rejects(make({}, bad, { post }).translate("x", "ko"), e => e.code === "none");
	}
	await assert.rejects(make({}, { aiEndpoint: "https://x.invalid", aiModel: "m" }, { post: async () => ({ choices: [] }) }).translate("x", "ko"), e => e.code === "failed");
	assert.deepEqual(make({}, prefs, { post }).available(), { pdftranslate: false, ai: true });
	assert.deepEqual(make(withPDF(async () => "x")).available(), { pdftranslate: true, ai: false });
	assert.deepEqual(make({}).available(), { pdftranslate: false, ai: false });
});

test("backend order: Translate for Zotero first; when it fails the endpoint is the fallback, and both reasons are kept when both fail", async () => {
	let used = [];
	const post = async () => { used.push("ai"); return { choices: [{ message: { content: "ai text" } }] }; };
	const prefs = { aiEndpoint: "https://x.invalid", aiModel: "m" };
	const both = make(withPDF(async () => { used.push("pdf"); return { result: "pdf text", service: "deeplfree" }; }), prefs, { post });
	assert.equal((await both.translate("x", "ko")).backend, "pdftranslate");
	assert.deepEqual(used, ["pdf"]);
	used = [];
	const fallback = make(withPDF(async () => { used.push("pdf"); throw new Error("no key"); }), prefs, { post });
	assert.deepEqual(await fallback.translate("x", "ko"), { text: "ai text", service: "m", backend: "ai" });
	assert.deepEqual(used, ["pdf", "ai"]);
	const neither = make(withPDF(async () => { throw new Error("pdf down"); }), prefs, { post: async () => { throw new Error("ai down"); } });
	await assert.rejects(neither.translate("x", "ko"), e => e.code === "failed" && /ai down/.test(e.message) && /pdf down/.test(e.message));
});

test("the default language: the reader's choice, else Translate for Zotero's target, else the window's language", () => {
	assert.equal(make({}, { translateLang: "ja", "extensions.zoteropdftranslate.targetLanguage": "ko-KR" }).defaultLanguage(), "ja");
	assert.equal(make({}, { "extensions.zoteropdftranslate.targetLanguage": "de-DE" }).defaultLanguage(), "de");
	assert.equal(make({}, { "extensions.zoteropdftranslate.targetLanguage": "zh-CN" }).defaultLanguage(), "zh-CN");
	assert.equal(make({}, {}).defaultLanguage(), "ko", "the window is Korean");
	assert.equal(make({}, { translateLang: "klingon" }).defaultLanguage(), "ko");
	assert.equal(T.create({ zotero: {}, pref: () => undefined, uiLocale: "en" }).defaultLanguage(), "en");
	assert.equal(T.create({ zotero: {}, pref: () => { throw new Error("no prefs"); }, uiLocale: "ko" }).defaultLanguage(), "ko", "a preference that cannot be read is not fatal");
	assert.deepEqual(["ko-KR", "KO", "zh_tw", "zh-Hans", "pt-BR", "xx", "", null].map(T.normalizeLang), ["ko", "ko", "zh-TW", "zh-CN", "pt", null, null, null]);
	for (const code of ["ko", "en", "ja", "zh-CN", "de", "fr", "es"]) assert.ok(T.byCode(code), code);
});

test("translations are remembered per paper, language and field; a double ask costs one request; failures are not remembered", async () => {
	let n = 0, release;
	const slow = make(withPDF(() => { n++; return new Promise(r => { release = () => r({ result: "T" + n }); }); }));
	const a = slow.translateCached({ key: "k1", lang: "ko", text: "abs" }), b = slow.translateCached({ key: "k1", lang: "ko", text: "abs" });
	release();
	assert.equal((await a).text, "T1"); assert.equal((await b).text, "T1"); assert.equal(n, 1);
	assert.equal(slow.cached("k1", "ko", "abstract").text, "T1");
	assert.equal(slow.cached("k1", "ja", "abstract"), null, "another language is another entry");
	assert.equal(slow.cached("k1", "ko", "title"), null);
	assert.equal((await slow.translateCached({ key: "k1", lang: "ko", text: "abs" })).cached, true); assert.equal(n, 1);
	let fail = true;
	const flaky = make(withPDF(async () => { if (fail) throw new Error("down"); return "ok"; }));
	await assert.rejects(flaky.translateCached({ key: "k", lang: "ko", text: "x" }));
	fail = false;
	assert.equal((await flaky.translateCached({ key: "k", lang: "ko", text: "x" })).text, "ok");
	flaky.clear(); assert.equal(flaky.cached("k", "ko", "abstract"), null);
});

test("the strings exist in Korean and English, and the privacy line says only the text is sent", () => {
	const keys = ["trButton", "trButtonTip", "trRunning", "trLang", "trTitle", "trHideOrig", "trShowOrig", "trCopy", "trCopied", "trVia", "trNone", "trFailed", "trNoText",
		"citeOpen", "citeOpenTip", "citeLabel", "citePerYear", "citeBasis", "citeNow", "citeYearLine", "citeYoy", "citeYoyNone", "citePeak", "citeSince", "citeSinceNone", "citeFirstLook",
		"citeLoading", "citeAsOf", "citeFailed", "citeBudget", "citeNoId", "citeNoYears", "citeMarkUp", "citeMarkDown", "citeCellTip", "metricsTrend", "metricsTrendNote"];
	for (const locale of ["en", "ko"]) for (const key of keys) assert.ok(I18N.STRINGS[locale][key] !== undefined, locale + " " + key);
	const ko = I18N.make("ko"), en = I18N.make("en");
	assert.match(ko("trNone"), /Translate for Zotero/); assert.match(en("trNone"), /Translate for Zotero/);
	assert.match(ko("trNone"), /aiEndpoint/);
	assert.match(en("citeSince", 5, "2026-10-01", "today"), /\+5 since the last look \(2026-10-01 → today\)/);
	assert.match(ko("citeSince", -2, "2026-10-01", "오늘"), /-2회/);
	assert.match(ko("citeYoy", 6, 2025, 2024), /\+6%/);
	const source = fs.readFileSync(new URL("../content/translate.js", import.meta.url), "utf8");
	assert.doesNotMatch(source, /\bemail\b|mailto/i, "the translation code never touches the contact address");
});

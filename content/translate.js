/*
 * Translating a paper's abstract (and title) from inside the detail card.
 *
 * Backends, in this order:
 *   1. The "Translate for Zotero" plugin, when installed: its own API, so the service and key the reader
 *      already set up (DeepL, Google, ...) are the ones used and ZotPoP holds no key.
 *        await Zotero.PDFTranslate.api.translate(text, { langfrom, langto, pluginID })
 *      The answer is read defensively: a plain string, or an object whose `result` holds the text and whose
 *      `status` (and `service`) say how it went.
 *   2. Any OpenAI-compatible chat endpoint the reader configured (extensions.zotpop.aiEndpoint, aiModel,
 *      aiKey); optional, off by default.
 *   3. Otherwise a plain message saying how to switch translation on.
 * Only the text and the language names are ever sent: no e-mail, no identifier of the reader.
 * Environment-agnostic (Zotero window and Node): Zotero, the preference reader and the POST are injected.
 */
var ZotPoPTranslate = (function () {
	"use strict";

	// code: ours; pdft: how Translate for Zotero names it; ai: the name used in the prompt.
	const LANGUAGES = [
		{ code: "ko", name: "한국어", pdft: "ko-KR", ai: "Korean" },
		{ code: "en", name: "English", pdft: "en-US", ai: "English" },
		{ code: "ja", name: "日本語", pdft: "ja-JP", ai: "Japanese" },
		{ code: "zh-CN", name: "中文(简体)", pdft: "zh-CN", ai: "Simplified Chinese" },
		{ code: "zh-TW", name: "中文(繁體)", pdft: "zh-TW", ai: "Traditional Chinese" },
		{ code: "de", name: "Deutsch", pdft: "de-DE", ai: "German" },
		{ code: "fr", name: "Français", pdft: "fr-FR", ai: "French" },
		{ code: "es", name: "Español", pdft: "es-ES", ai: "Spanish" },
		{ code: "pt", name: "Português", pdft: "pt-PT", ai: "Portuguese" },
		{ code: "ru", name: "Русский", pdft: "ru-RU", ai: "Russian" },
		{ code: "it", name: "Italiano", pdft: "it-IT", ai: "Italian" }
	];
	const PDFT_LANG_PREFS = ["extensions.zoteropdftranslate.targetLanguage", "extensions.zotero.ZoteroPDFTranslate.targetLanguage"];
	const SERVICE_NAMES = { deeplfree: "DeepL Free", deeplpro: "DeepL", deepl: "DeepL", deeplx: "DeepL", googleapi: "Google Translate", google: "Google Translate",
		googleapifree: "Google Translate", bingapi: "Microsoft Translator", microsoft: "Microsoft Translator", baidu: "Baidu", youdao: "Youdao", tencent: "Tencent",
		gpt: "GPT", chatgpt: "GPT", openai: "GPT", claude: "Claude", gemini: "Gemini", niutrans: "NiuTrans", caiyun: "Caiyun", haici: "Haici", mtranserver: "MTranServer" };
	const CACHE_MAX = 300, TIMEOUT = 90000;

	const byCode = code => LANGUAGES.find(l => l.code === code) || null;
	/* "ko-KR", "ko", "zh-Hans", "ZH_tw" -> our code, or null. */
	function normalizeLang(value) {
		let v = String(value == null ? "" : value).trim().toLowerCase().replace(/_/g, "-");
		if (!v) return null;
		if (v === "zh" || /^zh-(cn|sg|hans)/.test(v)) return "zh-CN";
		if (/^zh-(tw|hk|mo|hant)/.test(v)) return "zh-TW";
		let primary = v.split("-")[0];
		return LANGUAGES.some(l => l.code === primary) ? primary : null;
	}
	function serviceLabel(id) {
		let raw = String(id == null ? "" : id).trim();
		return raw ? SERVICE_NAMES[raw.toLowerCase()] || raw : "";
	}
	function fail(code, message) { let e = new Error(message || code); e.code = code; return e; }

	/* A reply from Translate for Zotero in either shape: the text, the service, or a refusal. */
	function readReply(reply) {
		if (typeof reply === "string") return { text: reply.trim(), service: "" };
		if (!reply || typeof reply !== "object") throw fail("failed", "empty answer");
		let status = String(reply.status == null ? "" : reply.status).toLowerCase();
		if (reply.error || /^(fail|failed|error)$/.test(status)) throw fail("failed", String((reply.error && (reply.error.message || reply.error)) || reply.result || status).slice(0, 300));
		let text = [reply.result, reply.text, reply.translation, reply.data].find(v => typeof v === "string" && v.trim());
		if (!text) throw fail("failed", status ? "unfinished (" + status + ")" : "empty answer");
		let service = reply.service || (reply.raw && reply.raw.service) || (reply.task && reply.task.service) || "";
		return { text: text.trim(), service: typeof service === "string" ? service : "" };
	}

	function create({ zotero, pref = () => undefined, post, uiLocale = "en", pluginID = "", timeout = TIMEOUT } = {}) {
		const cache = new Map(), inflight = new Map();
		const read = key => { try { return pref(key); } catch (_) { return undefined; } };

		function pdfTranslate() {
			let api = zotero && zotero.PDFTranslate && zotero.PDFTranslate.api;
			return api && typeof api.translate === "function" ? api : null;
		}
		function aiConfig() {
			let endpoint = String(read("aiEndpoint") || "").trim(), model = String(read("aiModel") || "").trim();
			if (!endpoint || !model || typeof post !== "function") return null;
			// A key travels with the request: only over https, or to this very computer.
			if (!/^https:\/\//i.test(endpoint) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(endpoint)) return null;
			return { endpoint, model, key: String(read("aiKey") || "").trim() };
		}
		const available = () => ({ pdftranslate: Boolean(pdfTranslate()), ai: Boolean(aiConfig()) });

		function defaultLanguage() {
			let saved = normalizeLang(read("translateLang"));
			if (saved) return saved;
			for (let key of PDFT_LANG_PREFS) {
				let got = normalizeLang(read(key));
				if (got) return got;
			}
			return normalizeLang(uiLocale) || "en";
		}

		const withTimeout = promise => new Promise((resolve, reject) => {
			let timer = typeof setTimeout === "function" ? setTimeout(() => reject(fail("failed", "timed out")), timeout) : null;
			promise.then(v => { if (timer) clearTimeout(timer); resolve(v); }, e => { if (timer) clearTimeout(timer); reject(e); });
		});

		async function viaPDFTranslate(api, text, lang) {
			let reply = await withTimeout(Promise.resolve(api.translate(text, { langto: byCode(lang).pdft, pluginID })));
			let out = readReply(reply);
			return { text: out.text, service: serviceLabel(out.service) || "Translate for Zotero", backend: "pdftranslate" };
		}
		async function viaAI(cfg, text, lang) {
			let url = /\/chat\/completions\/?$/i.test(cfg.endpoint) ? cfg.endpoint : cfg.endpoint.replace(/\/+$/, "") + "/chat/completions";
			let headers = { "Content-Type": "application/json" };
			if (cfg.key) headers.Authorization = "Bearer " + cfg.key;
			let body = { model: cfg.model, temperature: 0, messages: [
				{ role: "system", content: "You translate scientific text into " + byCode(lang).ai + ". Reply with the translation only, keeping numbers, units, gene and species names, and abbreviations as written." },
				{ role: "user", content: text }] };
			let reply = await withTimeout(Promise.resolve(post(url, headers, body)));
			let out = reply && reply.choices && reply.choices[0] && reply.choices[0].message && reply.choices[0].message.content;
			if (typeof out !== "string" || !out.trim()) throw fail("failed", "empty answer");
			return { text: out.trim(), service: cfg.model, backend: "ai" };
		}

		/* The translation of one text: { text, service, backend }. Rejects with code "none" when no backend is
		   set up, "empty" for nothing to translate, "failed" (with the message) when the backends gave none. */
		async function translate(text, lang) {
			text = String(text == null ? "" : text).trim();
			if (!text) throw fail("empty");
			if (!byCode(lang)) throw fail("failed", "unknown language " + lang);
			let api = pdfTranslate(), cfg = aiConfig(), problem = null;
			if (api) {
				try { return await viaPDFTranslate(api, text, lang); }
				catch (e) { problem = e; if (!cfg) throw fail("failed", e.message); }
			}
			if (cfg) {
				try { return await viaAI(cfg, text, lang); }
				catch (e) { throw fail("failed", e.message + (problem ? " (" + problem.message + ")" : "")); }
			}
			throw fail("none");
		}

		const cacheKey = (key, lang, field) => [key, lang, field].join("\u0001");
		const cached = (key, lang, field) => cache.get(cacheKey(key, lang, field)) || null;
		/* The same, remembered per (paper, language, field) for the session; a second ask while the first is on
		   its way waits for it, so a double click costs one request. */
		function translateCached({ key, lang, field = "abstract", text }) {
			let id = cacheKey(key, lang, field), hit = cache.get(id);
			if (hit) return Promise.resolve(Object.assign({ cached: true }, hit));
			if (inflight.has(id)) return inflight.get(id);
			let run = translate(text, lang).then(out => {
				if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
				cache.set(id, out);
				return out;
			}).finally(() => inflight.delete(id));
			inflight.set(id, run);
			return run;
		}

		return { translate, translateCached, cached, available, defaultLanguage, clear: () => cache.clear() };
	}

	return { create, LANGUAGES, normalizeLang, serviceLabel, readReply, byCode };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPTranslate;

/* The recorded answers of test/fixtures/reactions, served by what each request asks (see test/reactions.test.mjs). */
import { readFileSync } from "node:fs";

export const fx = name => JSON.parse(readFileSync(new URL("../fixtures/reactions/" + name + ".json", import.meta.url), "utf8"));
export const BRIDGE = "10.1038/s41586-024-07552-4", QUIET = "10.1038/nature24268", RETRACTED = "10.1016/S0140-6736(97)11096-0";
export const DAY = 86400000;

/* A fetch that answers from the fixtures by what the request asks, and records every request. */
export function fakeNet({ fail = {}, overrides = {} } = {}) {
	const calls = [];
	const answer = url => {
		const u = new URL(url), q = decodeURIComponent(url);
		for (const [host, status] of Object.entries(fail)) if (u.host === host) return { status, json: null };
		for (const [pattern, body] of Object.entries(overrides)) if (q.includes(pattern)) return { status: 200, json: body };
		if (u.host === "api.crossref.org") {
			if (q.includes(BRIDGE)) return { status: 200, json: fx("crossref-bridge") };
			if (q.includes(QUIET)) return { status: 200, json: fx("crossref-quiet") };
			if (q.toLowerCase().includes(RETRACTED.toLowerCase())) return { status: 200, json: fx("crossref-retracted") };
			return { status: 404, json: null };
		}
		if (u.host === "www.ebi.ac.uk") {
			if (q.includes(BRIDGE)) return { status: 200, json: fx("epmc-bridge") };
			if (q.toLowerCase().includes(RETRACTED.toLowerCase())) return { status: 200, json: fx("epmc-retracted") };
			return { status: 200, json: { hitCount: 0, resultList: { result: [] } } };
		}
		if (u.host === "api.bsky.app") {
			if (u.searchParams.get("url") === "https://www.nature.com/articles/s41586-024-07552-4") return { status: 200, json: fx("bluesky-bridge-landing") };
			if (/Bridge RNAs direct programmable/.test(u.searchParams.get("q") || "")) return { status: 200, json: fx("bluesky-bridge-title") };
			return { status: 200, json: fx("bluesky-empty") };
		}
		if (u.host === "hn.algolia.com") {
			if (u.searchParams.get("query") === "www.nature.com/articles/s41586-024-07552-4") return { status: 200, json: fx("hn-bridge-url") };
			return { status: 200, json: fx("hn-empty") };
		}
		if (u.host === "en.wikipedia.org") {
			if (q.includes(BRIDGE)) return { status: 200, json: fx("wikipedia-bridge") };
			return { status: 200, json: { batchcomplete: "", query: { searchinfo: { totalhits: 0 }, search: [] } } };
		}
		if (u.host === "api.openalex.org") {
			if (q.includes(BRIDGE)) return { status: 200, json: fx("openalex-bridge") };
			return { status: 404, json: null };
		}
		return { status: 404, json: null };
	};
	const fetch = async (url, options = {}) => { calls.push({ url, headers: options.headers || {} }); return answer(url); };
	return { fetch, calls };
}

/* The same answers through Zotero.HTTP.request's shape, as the window's adapter calls it; successCodes: false
   resolves every status, as the adapter asks. */
export function zoteroRequest(net) {
	return async (method, url, options = {}) => {
		const answer = await net.fetch(url, { headers: options.headers });
		return { status: answer.status, response: answer.json };
	};
}

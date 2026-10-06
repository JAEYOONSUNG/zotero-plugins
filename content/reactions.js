/*
 * How a paper was received: posts on Bluesky, stories on Hacker News, Wikipedia articles that cite it,
 * the notices about it (corrections, retractions, expressions of concern, comments) and its citation trend.
 *
 * Ported from Style Custom's src/attention.js (same free sources, same reading of Crossref and Europe PMC
 * notices), without its Altmetric tier: every source here is free and needs no key. Pure and testable:
 * the caller injects `fetch` (one request, one answer: {status, json}) and a store; nothing here knows
 * Zotero. Nothing is asked until the reader presses the button, one paper at a time, one request at a time
 * per host, with a plain User-Agent: no e-mail address, no mailto, nothing that identifies the reader.
 *
 * Verified live 2026-10-06 (test/fixtures/reactions): Bluesky's public search finds posts by the article's
 * landing page and by its title, not by the doi.org address; Hacker News stories link the landing page;
 * Crossref Event Data no longer answers, so Wikipedia is asked through its own search for the DOI.
 *
 * Two answers are kept apart: "nothing found" means every source answered and none had anything; a source
 * that did not answer is named, and the card never reads as "nothing" over it.
 */
var ZotPoPReactions = (function () {
	"use strict";

	const DAY = 86400000;
	const TTL = { reactions: 7 * DAY, failure: DAY };
	const TIMEOUT = 10000;
	const TOP = 5;
	// Minimum gap between two requests to one host. Crossref's public pool allows 5 per second.
	const GAP = { "api.crossref.org": 250 };
	const DEFAULT_GAP = 200;
	const USER_AGENT = "ZotPoP (Zotero plugin; paper reactions)";
	const STORE_LIMIT = 600;

	const text = value => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
	const bareDOI = value => text(value).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").toLowerCase();
	const isDOIHost = url => /^https?:\/\/(dx\.)?doi\.org\//i.test(text(url));
	const bareURL = url => text(url).replace(/^https?:\/\/(www\.)?/i, "").replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
	const flat = value => text(value).normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

	// ---------------------------------------------------------------- notices
	/* Crossref's update vocabulary, graded by what it means for a reader. A new version or edition is a
	   release of the work, not a notice about it. Anything unrecognised is a correction under its own label. */
	const KIND_BY_TYPE = {
		retraction: "retraction", partial_retraction: "retraction", removal: "retraction", withdrawal: "withdrawal",
		expression_of_concern: "expression-of-concern", erratum: "erratum", correction: "correction", corrigendum: "correction",
		addendum: "correction", clarification: "correction"
	};
	const NEUTRAL = new Set(["new_edition", "new_version"]);
	const SEVERITY = { retraction: 3, withdrawal: 3, "expression-of-concern": 2, correction: 1, erratum: 1, comment: 0 };
	const typeKey = type => text(type).toLowerCase().replace(/[\s-]+/g, "_");
	// Europe PMC names a link by the direction it points: "Retraction in" means this paper was retracted.
	const EPMC_KIND = [
		[/^comment in$/i, "comment"], [/^retraction in$/i, "retraction"], [/^partial retraction in$/i, "retraction"],
		[/^expression of concern in$/i, "expression-of-concern"], [/^erratum in$/i, "erratum"],
		[/^(corrected and )?republished in$/i, "correction"], [/^correction in$/i, "correction"]
	];
	const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
	// "Lancet. 2010 Feb 6;375(9713):445." -> 2010-02-06; the year alone when that is all there is.
	function referenceDate(reference) {
		let m = /\b((?:19|20)\d{2})(?:\s+([A-Za-z]{3})[a-z]*(?:\s+(\d{1,2})\b)?)?/.exec(text(reference));
		if (!m) return "";
		let month = m[2] ? MONTHS[m[2].toLowerCase()] : 0;
		if (!month) return m[1];
		return m[1] + "-" + String(month).padStart(2, "0") + (m[3] ? "-" + String(m[3]).padStart(2, "0") : "");
	}
	const referenceDOI = reference => bareDOI((/\bdoi:\s*(10\.\S+?)\.?(?:\s|$)/i.exec(text(reference)) || [])[1] || "");
	function crossrefDate(update) {
		let row = update?.updated?.["date-parts"]?.[0];
		if (!Array.isArray(row) || !Number.isInteger(row[0])) return "";
		return [row[0], row[1], row[2]].filter(Number.isInteger).map((n, i) => i ? String(n).padStart(2, "0") : String(n)).join("-");
	}
	const noticeURL = doi => doi ? "https://doi.org/" + doi : "";

	/* What Crossref says about a work: its title, its landing page and the notices about it. The same notice
	   is often deposited by the publisher and by Retraction Watch with different dates: one row, the earliest. */
	function readCrossref(payload) {
		let message = payload && typeof payload === "object" && "message" in payload ? payload.message : payload;
		if (!message || typeof message !== "object" || Array.isArray(message)) return null;
		let doi = bareDOI(message.DOI);
		let title = text(Array.isArray(message.title) ? message.title[0] : message.title);
		if (!doi && !title) return null;
		let seen = new Map();
		for (let u of Array.isArray(message["updated-by"]) ? message["updated-by"] : []) {
			let type = typeKey(u?.type), target = bareDOI(u?.DOI);
			if (NEUTRAL.has(type) || (doi && target === doi)) continue;
			let key = target + "|" + type, date = crossrefDate(u);
			let row = seen.get(key);
			if (!row) seen.set(key, { date, kind: KIND_BY_TYPE[type] || "correction", label: text(u?.label) || type.replace(/_/g, " "), source: "Crossref", url: noticeURL(target), doi: target,
				...(/retraction.?watch/i.test(text(u?.source)) ? { via: "Retraction Watch" } : {}) });
			else if (date && (!row.date || date < row.date)) row.date = date;
		}
		let events = [...seen.values()];
		let relation = message.relation && typeof message.relation === "object" ? message.relation : {};
		for (let r of Array.isArray(relation["is-retracted-by"]) ? relation["is-retracted-by"] : []) {
			let target = bareDOI(r?.id);
			if (target && !events.some(e => e.kind === "retraction" && e.doi === target))
				events.push({ date: "", kind: "retraction", label: "Retraction", source: "Crossref", url: noticeURL(target), doi: target });
		}
		let landing = text(message.resource?.primary?.URL);
		return { doi, title, landing: /^https?:\/\//i.test(landing) && !isDOIHost(landing) ? landing : "", events,
			isNotice: Array.isArray(message["update-to"]) && message["update-to"].length > 0 };
	}

	/* Europe PMC's corrections and comments for one record, from the one "core" answer for its DOI. */
	function readEuropePMC(payload) {
		let result = payload?.resultList?.result?.[0];
		if (!result) return { found: false, events: [], comments: 0, commentsUrl: "" };
		let pmid = text(result.pmid || (result.source === "MED" ? result.id : ""));
		let page = pmid ? "https://europepmc.org/article/MED/" + pmid : "https://europepmc.org/article/" + text(result.source) + "/" + text(result.id);
		let events = [], comments = 0, last = "";
		let list = result.commentCorrectionList?.commentCorrection;
		for (let row of Array.isArray(list) ? list : []) {
			let kind = (EPMC_KIND.find(([re]) => re.test(text(row?.type))) || [])[1];
			if (!kind) continue;
			let date = referenceDate(row.reference);
			if (kind === "comment") { comments++; if (date > last) last = date; continue; }
			let doi = referenceDOI(row.reference);
			events.push({ date, kind, label: text(row.type).replace(/ in$/i, ""), source: "Europe PMC", doi,
				url: doi ? noticeURL(doi) : row.id ? "https://europepmc.org/article/" + (text(row.source) || "MED") + "/" + text(row.id) : page });
		}
		let retractedType = /retracted publication/i.test(JSON.stringify(result.pubTypeList?.pubType || ""));
		return { found: true, pmid, events, comments, lastComment: last, commentsUrl: comments ? page + "#comments" : "", retractedType, page };
	}

	function mergeNotices(crossref, epmc) {
		let events = (crossref?.events || []).map(e => ({ ...e }));
		for (let e of epmc?.events || []) {
			// The same notice from both: one row (Crossref's, which carries the exact date), the graver reading kept.
			let twin = events.find(x => (e.doi && x.doi === e.doi) || (x.kind === e.kind && (x.date || "").slice(0, 4) === (e.date || "").slice(0, 4)));
			if (twin) { if ((SEVERITY[e.kind] || 0) > (SEVERITY[twin.kind] || 0)) { twin.kind = e.kind; twin.label = e.label; } continue; }
			events.push({ ...e });
		}
		if (epmc?.retractedType && !events.some(e => SEVERITY[e.kind] === 3))
			events.push({ date: "", kind: "retraction", label: "Retracted Publication", source: "Europe PMC", url: epmc.page, doi: "" });
		events.sort((a, b) => (a.date || "9999") < (b.date || "9999") ? -1 : (a.date || "9999") > (b.date || "9999") ? 1 : 0);
		let worst = events.reduce((m, e) => Math.max(m, SEVERITY[e.kind] || 0), 0);
		let known = Boolean(crossref) || Boolean(epmc?.found);
		let status = worst >= 3 ? "retracted" : worst === 2 ? "concern" : worst === 1 ? "corrected" : crossref?.isNotice ? "notice" : known ? "clean" : "unknown";
		return { status, events: events.map(({ doi, ...rest }) => rest), comments: epmc?.comments || 0, commentsUrl: epmc?.commentsUrl || "" };
	}

	// ---------------------------------------------------------------- reactions
	const snippet = value => { let s = text(value); return s.length > 280 ? s.slice(0, 279).replace(/\s+\S*$/, "") + "…" : s; };
	const bskyLink = post => {
		let handle = text(post?.author?.handle), rkey = text(post?.uri).split("/").pop();
		return handle && rkey ? "https://bsky.app/profile/" + handle + "/post/" + rkey : "";
	};
	// Every address a post points at: its link card and the links in its text.
	function postLinks(post) {
		let out = [];
		for (let embed of [post?.embed, post?.record?.embed, post?.embed?.media, post?.record?.embed?.media]) if (embed?.external?.uri) out.push(embed.external.uri);
		for (let facet of Array.isArray(post?.record?.facets) ? post.record.facets : [])
			for (let f of Array.isArray(facet?.features) ? facet.features : []) if (f?.uri) out.push(f.uri);
		return out.map(bareURL).filter(Boolean);
	}
	const isBot = post => /\bbot\b/i.test(text(post?.author?.displayName) + " " + text(post?.author?.handle).replace(/[.-]/g, " "));
	function shapePost(post) {
		let likes = Number(post.likeCount) || 0, reposts = Number(post.repostCount) || 0, replies = Number(post.replyCount) || 0, quotes = Number(post.quoteCount) || 0;
		return { source: "bluesky", author: text(post.author?.displayName) || text(post.author?.handle), handle: text(post.author?.handle),
			date: text(post.record?.createdAt || post.indexedAt), text: snippet(post.record?.text), url: bskyLink(post),
			likes, reposts, replies, quotes, score: likes + 2 * reposts + replies + quotes, bot: isBot(post) };
	}
	const byScore = (a, b) => b.score - a.score || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

	function create({ fetch, store, now = () => Date.now(), sleep, userAgent, openAlexKey, openAlexHeld } = {}) {
		if (typeof fetch !== "function") throw new TypeError("reactions: a fetch function is required");
		const ua = userAgent || USER_AGENT;
		const wait = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
		const db = store || createStore();
		const lastAt = new Map(), chains = new Map(), inflight = new Map();
		const abortError = () => Object.assign(new Error("Aborted"), { name: "AbortError" });
		const throwIfAborted = signal => { if (signal?.aborted) throw abortError(); };

		/* One request, serialised per host with a polite gap, bounded by a timeout and by the caller's signal. */
		function request(url, { signal, headers } = {}) {
			let host = new URL(url).host;
			let run = async () => {
				throwIfAborted(signal);
				let gap = GAP[host] ?? DEFAULT_GAP, since = now() - (lastAt.get(host) || 0);
				if (lastAt.has(host) && since < gap) await wait(gap - since);
				throwIfAborted(signal);
				lastAt.set(host, now());
				let timer;
				let guard = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Timeout · " + host), { timeout: true })), TIMEOUT); });
				try {
					let raw = await Promise.race([Promise.resolve(fetch(url, { signal, timeout: TIMEOUT,
						headers: { "User-Agent": ua, Accept: "application/json", ...(host.endsWith("wikipedia.org") ? { "Api-User-Agent": ua } : {}), ...(headers || {}) } })), guard]);
					let json = null;
					if (raw && typeof raw.json === "function") { try { json = await raw.json(); } catch (_) { json = null; } }
					else json = raw?.json ?? raw?.response ?? null;
					return { status: Number(raw?.status ?? 0), json };
				}
				finally { clearTimeout(timer); guard.catch(() => {}); }
			};
			let next = (chains.get(host) || Promise.resolve()).catch(() => {}).then(run);
			chains.set(host, next.catch(() => {}));
			return next;
		}
		// 200 -> body; 404 -> null (the service does not know it); anything else is no answer at all.
		async function getJSON(url, options) {
			let response = await request(url, options);
			if (response.status === 200) return response.json;
			if (response.status === 404) return null;
			throw Object.assign(new Error("HTTP " + response.status + " · " + new URL(url).host), { status: response.status });
		}

		async function bluesky({ doi, landing, title }, signal) {
			let urls = [...new Set([landing, "https://doi.org/" + doi].filter(Boolean))];
			let targets = new Set([...urls.map(bareURL), "doi.org/" + doi]);
			let posts = new Map(), total = 0;
			for (let u of urls) {
				let data = await getJSON("https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=*&url=" + encodeURIComponent(u) + "&sort=top&limit=25", { signal });
				let rows = Array.isArray(data?.posts) ? data.posts : [];
				// The address searches find overlapping posts: the larger total is the honest figure, their sum counts twice.
				total = Math.max(total, Number.isFinite(data?.hitsTotal) ? data.hitsTotal : rows.length);
				for (let p of rows) if (p?.uri) posts.set(p.uri, p);
			}
			/* By title, as a phrase. A post counts only when it links the paper or quotes its whole title: a short or
			   common title would otherwise bring in posts about something else. */
			let wanted = flat(title);
			if (wanted.split(" ").length >= 4) {
				let data = await getJSON("https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=" + encodeURIComponent('"' + text(title) + '"') + "&sort=top&limit=25", { signal });
				for (let p of Array.isArray(data?.posts) ? data.posts : []) {
					if (!p?.uri || posts.has(p.uri)) continue;
					let card = [p.embed?.external?.title, p.record?.embed?.external?.title, p.record?.text].map(flat).join(" ");
					if (postLinks(p).some(link => [...targets].some(t => link === t || link.startsWith(t))) || card.includes(wanted)) posts.set(p.uri, p);
				}
			}
			let shaped = [...posts.values()].map(shapePost);
			return { count: Math.max(total, shaped.length), top: shaped.filter(p => !p.bot && p.url).sort(byScore).slice(0, TOP).map(({ bot, ...p }) => p) };
		}

		async function hackerNews({ doi, landing }, signal) {
			// Asked as the address is written, without the scheme (verified live with "www."); compared without "www.".
			let wanted = landing ? bareURL(landing) : "";
			let asWritten = landing ? text(landing).replace(/^https?:\/\//i, "").replace(/[?#].*$/, "").replace(/\/$/, "") : "";
			let stories = new Map();
			for (let query of [asWritten, doi].filter(Boolean)) {
				let data = await getJSON("https://hn.algolia.com/api/v1/search?restrictSearchableAttributes=url&tags=story&query=" + encodeURIComponent(query), { signal });
				for (let h of Array.isArray(data?.hits) ? data.hits : []) {
					let at = bareURL(h.url);
					// Algolia matches words: only a story whose link is this paper counts.
					if (!h?.objectID || !(at && ((wanted && at === wanted) || at.includes(doi)))) continue;
					let points = Number(h.points) || 0, comments = Number(h.num_comments) || 0;
					stories.set(h.objectID, { source: "hackerNews", title: text(h.title), author: text(h.author), points, comments, date: text(h.created_at),
						url: "https://news.ycombinator.com/item?id=" + h.objectID, score: points + comments });
				}
			}
			let all = [...stories.values()].sort(byScore);
			return { count: all.length, top: all.slice(0, TOP) };
		}

		async function wikipedia(doi, signal) {
			let data = await getJSON("https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srnamespace=0&srlimit=10&srprop=timestamp&srsearch="
				+ encodeURIComponent('insource:"' + doi + '"'), { signal });
			if (!data?.query) throw new Error("Wikipedia gave no search answer");
			let rows = Array.isArray(data.query.search) ? data.query.search : [];
			let total = Number(data.query.searchinfo?.totalhits);
			return { count: Number.isFinite(total) ? total : rows.length,
				articles: rows.map(r => ({ title: text(r.title), date: text(r.timestamp), url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(text(r.title).replace(/ /g, "_")) })) };
		}

		async function citations(input, signal) {
			let own = Array.isArray(input.citesByYear) ? input.citesByYear.filter(x => Number.isInteger(x?.year) && Number.isFinite(x?.n)) : [];
			/* The series a search already holds is OpenAlex's too (counts_by_year). Its total is not given: the row's own
			   count may be another index's, and the series covers only recent years, so neither sums to the other. */
			if (own.length) return { total: null, byYear: own.map(x => ({ year: x.year, n: x.n })).sort((a, b) => a.year - b.year), source: "openalex", held: true };
			if (openAlexHeld && openAlexHeld()) return null;
			let key = text(openAlexKey ? openAlexKey() : "");
			let work = await getJSON("https://api.openalex.org/works/doi:" + encodeURIComponent(input.doi) + "?select=id,cited_by_count,counts_by_year" + (key ? "&api_key=" + encodeURIComponent(key) : ""), { signal });
			if (!work) return null;
			let byYear = (Array.isArray(work.counts_by_year) ? work.counts_by_year : []).map(x => ({ year: Number(x.year), n: Number(x.cited_by_count) || 0 }))
				.filter(x => Number.isInteger(x.year)).sort((a, b) => a.year - b.year);
			return { total: Number(work.cited_by_count) || 0, byYear, source: "openalex" };
		}

		async function compute(input, signal) {
			let doi = bareDOI(input.doi), failed = [], asked = [];
			let guarded = async (name, job) => {
				asked.push(name);
				try { return await job(); }
				catch (error) { if (error?.name === "AbortError") throw error; failed.push(name); return null; }
			};
			// Crossref first: it names the landing page (which Bluesky and Hacker News are searched by) and the title.
			let crossref = await guarded("crossref", async () => readCrossref(await getJSON("https://api.crossref.org/works/" + encodeURIComponent(doi), { signal })));
			throwIfAborted(signal);
			let own = text(input.url).replace(/#.*$/, "");
			let landing = /^https?:\/\//i.test(own) && !isDOIHost(own) && !/\.pdf(\?|$)/i.test(own) ? own : crossref?.landing || "";
			let facts = { doi, landing, title: text(input.title) || crossref?.title || "" };
			let [epmc, bsky, hn, wiki, cites] = await Promise.all([
				guarded("europepmc", async () => readEuropePMC(await getJSON("https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core&pageSize=1&query="
					+ encodeURIComponent('DOI:"' + doi + '"'), { signal }))),
				guarded("bluesky", () => bluesky(facts, signal)),
				guarded("hackerNews", () => hackerNews(facts, signal)),
				guarded("wikipedia", () => wikipedia(doi, signal)),
				// The trend is context, not a reaction: a failure here is not counted against the card.
				citations({ ...input, doi }, signal).catch(error => { if (error?.name === "AbortError") throw error; return null; })
			]);
			let notices = mergeNotices(crossref, epmc);
			// A notice source only fails the card when both of them failed.
			let failedOut = failed.filter(n => !["crossref", "europepmc"].includes(n));
			if (failed.includes("crossref") && failed.includes("europepmc")) failedOut.push("notices");
			let out = {
				doi, landing, title: facts.title, checked: new Date(now()).toISOString(),
				bluesky: bsky || { count: 0, top: [] }, hackerNews: hn || { count: 0, top: [] }, wikipedia: wiki || { count: 0, articles: [] },
				notices, citations: cites, failed: failedOut
			};
			// The posts and stories together, most engaged first; a post nobody has liked yet still shows when it is all there is.
			out.mostDiscussed = [...out.bluesky.top, ...out.hackerNews.top].filter(x => x.url).sort(byScore).slice(0, TOP);
			out.nothing = !failedOut.length && !out.bluesky.count && !out.hackerNews.count && !out.wikipedia.count && !notices.events.length && !notices.comments;
			out.allFailed = ["bluesky", "hackerNews", "wikipedia"].every(n => failed.includes(n));
			return out;
		}

		async function lookup(input = {}, { force = false, signal } = {}) {
			let doi = bareDOI(input.doi);
			if (!doi) return { reason: "no-doi", cached: false };
			throwIfAborted(signal);
			let slot = db.get(doi);
			if (!force && slot && slot.expires > now()) return { ...slot.value, cached: true };
			if (inflight.has(doi)) return inflight.get(doi);
			let job = (async () => {
				let value = await compute({ ...input, doi }, signal);
				throwIfAborted(signal);
				// A refresh that learned nothing does not replace what was known before.
				if (value.allFailed && slot?.value) {
					db.set(doi, { ...slot, expires: now() + TTL.failure });
					return { ...slot.value, cached: true, stale: true };
				}
				db.set(doi, { value, at: now(), expires: now() + (value.failed.length ? TTL.failure : TTL.reactions) });
				return { ...value, cached: false };
			})();
			inflight.set(doi, job);
			try { return await job; } finally { inflight.delete(doi); }
		}

		// What is kept for a paper, of any age and with no request: the card shown again when the paper is reopened.
		function peek(doiInput) {
			let slot = db.get(bareDOI(doiInput));
			return slot?.value ? { ...slot.value, cached: true, fresh: slot.expires > now() } : null;
		}
		const busy = doiInput => inflight.has(bareDOI(doiInput));

		return { lookup, peek, busy, store: db };
	}

	/* The kept answers, one per DOI, newest last; written to disk by the caller as JSON. */
	function createStore({ limit = STORE_LIMIT } = {}) {
		let map = new Map();
		const api = {
			get: doi => map.get(bareDOI(doi)) || null,
			set(doi, slot) {
				let key = bareDOI(doi);
				map.delete(key); map.set(key, slot);
				while (map.size > limit) map.delete(map.keys().next().value);
			},
			export: () => ({ version: 1, entries: [...map.entries()] }),
			import(snapshot) {
				if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.entries)) return 0;
				let n = 0;
				for (let entry of snapshot.entries) {
					if (!Array.isArray(entry) || typeof entry[0] !== "string" || !entry[1] || typeof entry[1] !== "object" || !entry[1].value) continue;
					api.set(entry[0], entry[1]); n++;
				}
				return n;
			},
			get size() { return map.size; }
		};
		return api;
	}

	return { create, createStore, readCrossref, readEuropePMC, referenceDate, bareDOI, TTL, USER_AGENT, TOP };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPReactions;

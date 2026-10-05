/* "Rank by my library": how related each search result is to the papers the user holds, from
   citation links only. Pure functions over plain data; the HTTP client and the Sources helpers are
   passed in, so everything is testable without Zotero or the network.

   Score = 3 * (c1 + c2) + c3w
     c1  held papers this result cites                      (a direct link)
     c2  held papers that cite this result                  (a direct link)
     c3  references the result shares with the held library's references (bibliographic coupling);
         c3w weighs each shared reference by how specific it is: w = ln((N+1)/df) / ln(N+1), where N
         is the number of distinct held papers and df how many of them cite that reference, so a
         reference cited by one held paper counts 1 and one cited by nearly all counts about 0.
         A reference that is itself a held paper is a direct link (c1) and is not counted again.

   The held papers' own reference lists answer "who in my library cites this", so no citing list is
   ever fetched per result. Co-citation (c4) would need the result's citing list, one request per
   result, and is deliberately not computed. A result the library already holds, or the other
   version (preprint/article) of a held paper, is flagged and left out of the ranking: its
   references are the library's own and would only echo it. */
var ZotPoPRelated = (() => {
	const DAY = 86400000, TTL = 30 * DAY, BATCH = 50, KEEP = 6000, TOP = 5;
	const FORMULA = "score = 3*(c1+c2) + c3w";
	const shortId = v => String(v == null ? "" : v).replace(/^https?:\/\/openalex\.org\//i, "").trim().toUpperCase();
	const isWork = v => /^W\d+$/.test(v);
	const flat = v => String(v == null ? "" : v).normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
	const round = n => Math.round(n * 100) / 100;
	const chunks = (list, n) => { let out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
	function abortError() { let e = new Error("Search cancelled"); e.name = "AbortError"; return e; }
	const normDOI = (sources, v) => (sources?.normalizeDOI ? sources.normalizeDOI(v) : String(v || "").toLowerCase()) || "";

	/* What was learned from OpenAlex, kept between runs: reference lists by work id and by DOI.
	   An answer older than 30 days is asked again. A DOI OpenAlex does not know is remembered too
	   (as null) so it is not asked again every run. */
	function createStore({ now = Date.now, ttl = TTL } = {}) {
		let byId = new Map(), byDoi = new Map();
		const fresh = e => e && now() - e.at < ttl;
		return {
			byId, byDoi, now,
			getId(id) { let e = byId.get(id); return fresh(e) ? e : null; },
			getDoi(doi) { let e = byDoi.get(doi); return fresh(e) ? e : null; },
			putWork(w, sources) {
				let id = shortId(w.id), refs = (Array.isArray(w.referenced_works) ? w.referenced_works : []).map(shortId).filter(isWork), doi = normDOI(sources, w.doi), at = now();
				if (isWork(id)) byId.set(id, { refs, at });
				if (doi) byDoi.set(doi, { id: isWork(id) ? id : null, refs, at });
			},
			missingId(id) { byId.set(id, { refs: null, at: now() }); },
			missingDoi(doi) { byDoi.set(doi, { id: null, refs: null, at: now() }); },
			export() {
				let tail = map => [...map.entries()].slice(-KEEP);
				return { version: 1, savedAt: new Date(now()).toISOString(), byId: tail(byId).map(([k, e]) => [k, e.refs, e.at]), byDoi: tail(byDoi).map(([k, e]) => [k, e.id, e.refs, e.at]) };
			},
			import(snap) {
				if (!snap || snap.version !== 1) return 0;
				let n = 0;
				for (let [k, refs, at] of Array.isArray(snap.byId) ? snap.byId : []) {
					if (!isWork(k) || !Number.isFinite(at) || now() - at >= ttl || (refs !== null && !Array.isArray(refs)) || byId.has(k)) continue;
					byId.set(k, { refs, at }); n++;
				}
				for (let [k, id, refs, at] of Array.isArray(snap.byDoi) ? snap.byDoi : []) {
					if (typeof k !== "string" || !Number.isFinite(at) || now() - at >= ttl || (refs !== null && !Array.isArray(refs)) || byDoi.has(k)) continue;
					byDoi.set(k, { id, refs, at }); n++;
				}
				return n;
			}
		};
	}

	/* Who is who. A held paper is the same paper as another held paper, or as a result, by OpenAlex id,
	   then DOI, then an explicit version relation (publishedAs / preprintOf, as `versionDois`). A title
	   is a last resort only for a record that has neither an id nor a DOI, and then it must also agree on
	   the year and the first author's family name: two "Editorial"s of one year are not one paper. */
	const lc = v => String(v == null ? "" : v).toLowerCase();
	const titleKey = r => { let ft = flat(r.title), year = String(r.year || "").match(/\d{4}/)?.[0] || "", fam = flat(r.family); return ft.length >= 8 && year && fam ? ft + "|" + year + "|" + fam : ""; };

	/* The held library, indexed once: clusters (one per paper) and an inverted index from every
	   reference to the held papers that cite it. `held`: { itemID, title, year, family, doi, openalex,
	   versionDois, refs, complete } (refs null when OpenAlex could not say). */
	function* indexSteps(held, every = 100) {
		let clusters = [], idMap = new Map(), doiMap = new Map(), vdoiMap = new Map(), titleMap = new Map();
		for (let h of held) {
			let id = h.openalex ? shortId(h.openalex) : "", doi = lc(h.doi), vers = (h.versionDois || []).map(lc).filter(Boolean), tk = !id && !doi ? titleKey(h) : "";
			let c = (id && idMap.get(id)) || (doi && (doiMap.get(doi) || vdoiMap.get(doi))) || vers.map(d => doiMap.get(d)).find(Boolean) || (tk && titleMap.get(tk)) || null;
			if (!c) { c = { itemID: h.itemID, title: h.title, refs: null, complete: false }; clusters.push(c); }
			if (id) idMap.set(id, c);
			if (doi) doiMap.set(doi, c);
			for (let d of vers) vdoiMap.set(d, c);
			if (tk) titleMap.set(tk, c);
			if (Array.isArray(h.refs)) {
				c.refs = c.refs || new Set(); for (let r of h.refs) c.refs.add(shortId(r));
				if (h.complete !== false) c.complete = true;
			}
		}
		let known = clusters.filter(c => c.refs), N = known.length, refToClusters = new Map(), n = 0;
		for (let c of known) {
			for (let r of c.refs) { let l = refToClusters.get(r); if (!l) refToClusters.set(r, l = []); l.push(c); }
			if (++n % every === 0) yield;           // a long library is indexed in slices too
		}
		let weights = new Map(), logN = Math.log(N + 1);
		let weight = ref => {
			let w = weights.get(ref);
			if (w === undefined) { let df = refToClusters.get(ref)?.length || 0; w = df && N ? Math.max(0, Math.log((N + 1) / df) / logN) : 0; weights.set(ref, w); }
			return w;
		};
		let idToCluster = idMap;
		return { clusters, idMap, doiMap, vdoiMap, titleMap, refToClusters, weight, N, incomplete: known.filter(c => !c.complete).length, idToCluster };
	}

	function buildIndex(held) { let it = indexSteps(held), step; while (!(step = it.next()).done); return step.value; }

	function twinOf(ix, r) {
		let id = shortId(r.id), doi = lc(r.doi);
		return (id && ix.idMap.get(id)) || (doi && (ix.doiMap.get(doi) || ix.vdoiMap.get(doi))) || (r.versionDois || []).map(d => ix.doiMap.get(lc(d))).find(Boolean)
			|| (!id && !doi && (() => { let tk = titleKey(r); return tk && ix.titleMap.get(tk); })()) || null;
	}

	/* One result's score, without the explanation: c1, c2, c3, c3w and a lazy `top` (the five held papers
	   that explain it), worked out only when something reads it. */
	function scoreOne(ix, r) {
		if (twinOf(ix, r)) return { held: true, score: null };
		let id = shortId(r.id);
		if (!Array.isArray(r.refs) || !isWork(id)) return { unrankable: true, score: null };
		let own = new Set(r.refs.map(shortId)), cites = new Set(), shared = 0, c3w = 0;
		for (let ref of own) {
			let c = ix.idMap.get(ref);
			if (c) { cites.add(c); continue; }
			if (ix.refToClusters.has(ref)) { shared++; c3w += ix.weight(ref); }
		}
		let citedBy = new Set();
		for (let c of ix.refToClusters.get(id) || []) if (c.complete) citedBy.add(c);
		c3w = round(c3w);
		let score = { score: round(3 * (cites.size + citedBy.size) + c3w), c1: cites.size, c2: citedBy.size, c3: shared, c3w, lowConf: ix.incomplete };
		let explain = () => {
			let per = new Map(), note = c => { if (!per.has(c)) per.set(c, { c, cites: false, citedBy: false, w: 0 }); return per.get(c); };
			for (let ref of own) {
				if (ix.idMap.has(ref)) { note(ix.idMap.get(ref)).cites = true; continue; }
				let who = ix.refToClusters.get(ref);
				if (who) { let w = ix.weight(ref); for (let k of who) note(k).w += w; }
			}
			for (let c of citedBy) note(c).citedBy = true;
			return [...per.values()].map(p => ({ itemID: p.c.itemID, title: p.c.title, why: [p.cites && "cites", p.citedBy && "citedBy", p.w > 0 && "shared"].filter(Boolean), shared: round(p.w), direct: (p.cites ? 1 : 0) + (p.citedBy ? 1 : 0) }))
				.sort((a, b) => b.direct - a.direct || b.shared - a.shared).slice(0, TOP).map(({ direct, ...rest }) => rest);
		};
		Object.defineProperty(score, "top", { enumerable: true, configurable: true, get() { let v = explain(); Object.defineProperty(score, "top", { value: v, enumerable: true, writable: true, configurable: true }); return v; } });
		return score;
	}

	/* The score of every result against the held papers, all at once (the tests and small lists). */
	function scoreAll(held, results) {
		let ix = buildIndex(held), scores = new Map();
		for (let r of results) scores.set(r.key, scoreOne(ix, r));
		return scores;
	}

	/* The same, without holding the thread: the index is built once, then results are scored in slices
	   of `every` (or `budget` ms, whichever comes first), and between slices the event loop gets a turn (`pause`, a macrotask by default).
	   `cancelled` is asked before each slice and throws an AbortError when set. */
	async function scoreAllAsync(held, results, { every = 100, budget = 40, pause = () => new Promise(r => setTimeout(r, 0)), cancelled } = {}) {
		cancelled?.();
		let it = indexSteps(held), step;
		while (!(step = it.next()).done) { await pause(); cancelled?.(); }
		let ix = step.value, scores = new Map();
		let since = 0, started = Date.now();
		for (let i = 0; i < results.length; i++) {
			if (since >= every || Date.now() - started >= budget) { await pause(); cancelled?.(); since = 0; started = Date.now(); }
			scores.set(results[i].key, scoreOne(ix, results[i])); since++;
		}
		cancelled?.();
		return scores;
	}

	/* Highest score first (ties keep the list's own order), then held, then not rankable. */
	function orderOf(results, scores) {
		let tier = k => { let s = scores.get(k); return !s ? 2 : s.unrankable ? 3 : s.held ? 1 : 0; };
		return results.map((r, i) => [r.key, i]).sort((a, b) => tier(a[0]) - tier(b[0]) || (scores.get(b[0])?.score ?? 0) - (scores.get(a[0])?.score ?? 0) || a[1] - b[1]).map(x => x[0]);
	}

	/* Resolves reference lists (cache first, then batched OpenAlex filters) and scores. Never fetches
	   a citing list. Resolves { ok, scores: Map(key -> score), order, requests, reason? }; rejects
	   with an AbortError when cancelled, after keeping everything already fetched in the store. */
	async function rank({ held, results, http, ctx = {}, store = createStore(), sources, onProgress }) {
		let out = { ok: true, scores: new Map(), order: [], requests: 0, heldKnown: 0, heldUnknown: 0, reason: null };
		if (!held.length) return Object.assign(out, { ok: false, reason: "empty-library" });
		let auth = sources?.openAlexAuth ? sources.openAlexAuth({ openAlexApiKey: ctx.openAlexApiKey || "" }) : "";
		let cancelled = () => { if (ctx.signal?.aborted || ctx.isCancelled?.()) throw abortError(); };
		cancelled();
		let heldNeedsDoi = [], heldDoi = h => normDOI(sources, h.doi);
		/* Style Custom's stored list (`stored`) is used only while it is still about this item and still
		   fresh: the item's current DOI must be the one the list was fetched for, and the list at most 30
		   days old. Anything else is asked for again, in the normal batches. */
		let trusted = h => {
			if (!h.stored) return true;
			let at = Date.parse(h.checkedAt), cur = heldDoi(h), was = normDOI(sources, h.scDoi);
			return Number.isFinite(at) && store.now() - at < TTL && (cur ? cur === was : !was);
		};
		let have = h => h.openalex && Array.isArray(h.refs) && trusted(h);
		for (let h of held) { let d = heldDoi(h); if (!have(h) && d && !store.getDoi(d)) heldNeedsDoi.push(d); }
		let resNeedsId = [], resNeedsDoi = [];
		for (let r of results) {
			let id = shortId(r.sourceId && r.source === "openalex" ? r.sourceId : r.id), d = normDOI(sources, r.doi);
			if (isWork(id)) { if (!store.getId(id)) resNeedsId.push(id); }
			else if (d && !store.getDoi(d)) resNeedsDoi.push(d);
		}
		// Held and result DOIs share batches; the held papers are fetched first so an empty answer ends the run early.
		let uniq = list => [...new Set(list)];
		let doiBatches = chunks(uniq([...heldNeedsDoi, ...resNeedsDoi]), BATCH), idBatches = chunks(uniq(resNeedsId), BATCH);
		let total = doiBatches.length + idBatches.length, done = 0;
		onProgress?.({ done, total });
		let fetchBatch = async (kind, list) => {
			cancelled();
			if (ctx.openAlexSpent) { out.reason = "budget"; return false; }
			let url = "https://api.openalex.org/works?filter=" + (kind === "doi" ? "doi:" + list.map(encodeURIComponent).join("|") : "openalex_id:" + list.join("|"))
				+ "&per-page=" + BATCH + "&select=id,doi,referenced_works" + auth;
			try {
				let data = await sources.withRetry(() => http.getJSON(url, {}, ctx.signal), {}, ctx);
				out.requests++;
				let seen = new Set();
				for (let w of data?.results || []) { store.putWork(w, sources); seen.add(kind === "doi" ? normDOI(sources, w.doi) : shortId(w.id)); }
				for (let k of list) if (!seen.has(k)) (kind === "doi" ? store.missingDoi(k) : store.missingId(k));
			}
			catch (e) {
				if (e.name === "AbortError") throw e;
				if (sources.isQuotaError?.(e)) { ctx.openAlexSpent = true; out.reason = "budget"; }
				else { ctx.log?.("Related ranking request failed: " + (e.message || e)); out.reason = "failed"; }
				return false;
			}
			onProgress?.({ done: ++done, total });
			return true;
		};
		let heldNow = () => held.map(h => {
			if (have(h)) return { ...h, refs: h.refs.map(shortId) };
			let e = heldDoi(h) && store.getDoi(heldDoi(h));
			return e?.refs ? { ...h, openalex: e.id, refs: e.refs, complete: true } : { ...h, openalex: h.stored ? null : h.openalex, refs: null };
		});
		let go = true;
		for (let b of doiBatches) { if (!(go = await fetchBatch("doi", b))) break; }
		if (go) for (let b of idBatches) { if (!(go = await fetchBatch("id", b))) break; }
		let heldList = heldNow();
		out.heldKnown = heldList.filter(h => h.refs).length; out.heldUnknown = heldList.length - out.heldKnown;
		if (!out.heldKnown) return Object.assign(out, { ok: false, reason: out.reason || "no-known-held" });
		let rows = results.map(r => {
			let id = shortId(r.source === "openalex" && r.sourceId ? r.sourceId : r.id), d = normDOI(sources, r.doi), e = null;
			if (isWork(id)) e = store.getId(id);
			else if (d) { let w = store.getDoi(d); if (w?.id) { id = w.id; e = w; } }
			let versionDois = [r.publishedAs?.doi, r.preprintOf?.doi].filter(Boolean).map(x => normDOI(sources, x));
			return { key: r.key, id: isWork(id) ? id : null, doi: d, title: r.title, year: r.year, family: r.family, refs: e?.refs || null, versionDois };
		});
		cancelled();
		out.scores = await scoreAllAsync(heldList, rows, { cancelled, pause: ctx.pause });
		out.order = orderOf(results, out.scores);
		out.partial = !go;
		if (out.partial && !out.reason) out.reason = "failed";
		return out;
	}

	return { FORMULA, TTL, BATCH, shortId, flat, createStore, scoreAll, scoreAllAsync, buildIndex, orderOf, rank };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPRelated;

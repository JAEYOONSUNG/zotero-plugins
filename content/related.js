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

	/* The score of every result against the held papers. `held`: { itemID, title, doi, openalex, refs }
	   (refs null when OpenAlex could not say); `results`: { key, id, doi, title, refs, versionDois }. */
	function scoreAll(held, results) {
		let clusters = [], byTitle = new Map();
		// One cluster per paper: a preprint and its article, both in the library, are one.
		for (let h of held) {
			let ft = flat(h.title), cluster = ft.length >= 8 ? byTitle.get(ft) : null;
			if (!cluster) { cluster = { itemID: h.itemID, title: h.title, ids: new Set(), dois: new Set(), refs: null, flat: ft }; clusters.push(cluster); if (ft.length >= 8) byTitle.set(ft, cluster); }
			if (h.openalex) cluster.ids.add(shortId(h.openalex));
			if (h.doi) cluster.dois.add(String(h.doi).toLowerCase());
			if (Array.isArray(h.refs)) { cluster.refs = cluster.refs || new Set(); for (let r of h.refs) cluster.refs.add(shortId(r)); }
		}
		let known = clusters.filter(c => c.refs), N = known.length;
		let idToCluster = new Map(), doiToCluster = new Map(), refToClusters = new Map();
		for (let c of clusters) { for (let id of c.ids) idToCluster.set(id, c); for (let d of c.dois) doiToCluster.set(d, c); }
		for (let c of known) for (let r of c.refs) { if (!refToClusters.has(r)) refToClusters.set(r, new Set()); refToClusters.get(r).add(c); }
		let weight = ref => { let df = refToClusters.get(ref)?.size || 0; return df && N ? Math.max(0, Math.log((N + 1) / df) / Math.log(N + 1)) : 0; };
		let scores = new Map();
		for (let r of results) {
			let id = shortId(r.id), doi = String(r.doi || "").toLowerCase(), ft = flat(r.title);
			let twin = (id && idToCluster.get(id)) || (doi && doiToCluster.get(doi)) || (r.versionDois || []).map(d => doiToCluster.get(String(d).toLowerCase())).find(Boolean) || (ft.length >= 8 && byTitle.get(ft)) || null;
			if (twin) { scores.set(r.key, { held: true, score: null }); continue; }
			if (!Array.isArray(r.refs) || !isWork(id)) { scores.set(r.key, { unrankable: true, score: null }); continue; }
			let own = new Set(r.refs.map(shortId)), cites = new Set(), citedBy = new Set(), shared = [], per = new Map();
			let note = c => { if (!per.has(c)) per.set(c, { c, cites: false, citedBy: false, w: 0 }); return per.get(c); };
			for (let ref of own) {
				let c = idToCluster.get(ref);
				if (c) { cites.add(c); note(c).cites = true; continue; }
				let who = refToClusters.get(ref);
				if (who) { shared.push(ref); let w = weight(ref); for (let k of who) note(k).w += w; }
			}
			for (let c of refToClusters.get(id) || []) { citedBy.add(c); note(c).citedBy = true; }
			let c3w = round(shared.reduce((s, ref) => s + weight(ref), 0));
			let top = [...per.values()].map(p => ({ itemID: p.c.itemID, title: p.c.title, why: [p.cites && "cites", p.citedBy && "citedBy", p.w > 0 && "shared"].filter(Boolean), shared: round(p.w), direct: (p.cites ? 1 : 0) + (p.citedBy ? 1 : 0) }))
				.sort((a, b) => b.direct - a.direct || b.shared - a.shared).slice(0, TOP).map(({ direct, ...rest }) => rest);
			scores.set(r.key, { score: round(3 * (cites.size + citedBy.size) + c3w), c1: cites.size, c2: citedBy.size, c3: shared.length, c3w, top });
		}
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
		let heldNeedsDoi = [], heldDoi = h => normDOI(sources, h.doi);
		let have = h => h.openalex && Array.isArray(h.refs);
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
			return e?.refs ? { ...h, openalex: e.id, refs: e.refs } : { ...h, refs: null };
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
			return { key: r.key, id: isWork(id) ? id : null, doi: d, title: r.title, refs: e?.refs || null, versionDois };
		});
		out.scores = scoreAll(heldList, rows);
		out.order = orderOf(results, out.scores);
		out.partial = !go;
		if (out.partial && !out.reason) out.reason = "failed";
		return out;
	}

	return { FORMULA, TTL, BATCH, shortId, flat, createStore, scoreAll, orderOf, rank };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPRelated;

/*
 * ZotPoP search sources.
 * Environment-agnostic: works inside the Zotero chrome window and in Node (for tests).
 * Every source returns an array of normalized records:
 * {
 *   key, source, sourceId, title, authors: [{firstName,lastName,name}], year, venue, publisher,
 *   doi, pmid, pmcid, arxiv, url, pdfUrl, citations (Number|null), volume, issue, pages,
 *   abstract, itemType ('journalArticle'|'conferencePaper'|'preprint'|'book'|'bookSection'|'thesis'|'report'),
 *   preprintServer (String|null: the archive that hosts the posting -- "bioRxiv", "ChemRxiv",
 *     "arXiv", "PsyArXiv" ... -- set on and only on itemType 'preprint', so a posting is never
 *     read as a journal article; the importer writes it to Zotero's `repository` field),
 *   publishedDoi, publishedPmid (String|null: the peer-reviewed version of a preprint, once one
 *     exists. Crossref identifies it by DOI, Europe PMC only ever by PMID, hence both.)
 * }
 *
 * `http` adapter: { getJSON(url, headers) -> Promise<Object>, getText(url, headers) -> Promise<String> }
 *   Errors thrown must carry `.status` (HTTP status) when available.
 */
var ZotPoPSources = (function () {
	"use strict";

	const enc = encodeURIComponent;
	// Providers cap deep paging near here; it also stops a fully-filtered result set from
	// walking forever, since the filtered output length can never reach the requested cap.
	const PAGE_WALK_LIMIT = 10000;
	const Query = typeof ZotPoPQuery !== "undefined" ? ZotPoPQuery
		: typeof require === "function" ? require("./query.js") : null;
	const Affiliations = typeof ZotPoPAffiliations !== "undefined" ? ZotPoPAffiliations
		: typeof require === "function" ? require("./affiliations.js") : null;
	const JCR = typeof ZotPoPJCR !== "undefined" ? ZotPoPJCR
		: typeof require === "function" ? require("./jcr.js") : null;

	function abortError() { let e = new Error("Search cancelled"); e.name = "AbortError"; return e; }
	function throwIfCancelled(ctx = {}) {
		if (ctx.signal?.aborted || ctx.isCancelled?.()) throw abortError();
	}
	function sleep(ms, ctx = {}) {
		throwIfCancelled(ctx);
		return new Promise((resolve, reject) => {
			let poll, timer;
			let finish = error => {
				clearTimeout(timer);
				if (poll) clearInterval(poll);
				ctx.signal?.removeEventListener("abort", cancel);
				error ? reject(error) : resolve();
			};
			let cancel = () => finish(abortError());
			timer = setTimeout(() => finish(), ms);
			ctx.signal?.addEventListener("abort", cancel, { once: true });
			if (!ctx.signal && ctx.isCancelled) poll = setInterval(() => { if (ctx.isCancelled()) cancel(); }, 100);
			if (ctx.signal?.aborted) cancel();
		});
	}

	// Providers rank loosely: a Crossref search for "Geobacillus thermophilic genome
	// engineering" returned fracture-mechanics and finite-element papers, which matched only
	// the word "engineering" in their journal name. Require half the distinctive terms to
	// appear somewhere in the record before accepting it as a topic match.
	const KEYWORD_STOPWORDS = new Set(["and", "for", "from", "into", "the", "their", "this", "that", "with",
		"using", "use", "via", "between", "based", "new", "study", "studies", "analysis", "role", "effect", "effects"]);

	function keywordTerms(value) {
		// A quoted or Boolean query was already expressed precisely to the provider.
		if (!value || /\b(AND|OR|NOT|ANDNOT)\b|["()]|\w+:/i.test(value)) return [];
		return [...new Set(normalizedText(value).split(/\s+/).filter(w => w.length > 2 && !KEYWORD_STOPWORDS.has(w)))];
	}

	function matchesKeywords(terms, record) {
		if (terms.length < 2) return true;
		// Title and abstract only. Matching the journal name is what let a fracture-mechanics
		// paper in on the word "engineering", and it is a weak signal for what a paper is about.
		let hay = normalizedText([record.title, record.abstract].filter(Boolean).join(" "));
		if (!hay) return true;
		// One distinctive term is enough: this removes provider noise without second-guessing
		// which of the user's words the relevant paper happens to use.
		return terms.some(term => hay.includes(term));
	}

	function matchingRecords(records, query) {
		// Scholar's bylines/journal names are snippets and can be truncated. Its
		// fielded query has already constrained these fields; absence in a snippet
		// cannot disprove a match. Never fill that missing metadata from the query.
		// Scholar already constrains every field it was given, and its snippets are truncated,
		// so only the year range is re-checked there.
		let terms = keywordTerms(query.keywords);
		return records.filter(r => {
			if (r.source === "scholar") return Query ? Query.matchesRecord(r, { yearFrom: query.yearFrom, yearTo: query.yearTo }) : true;
			if (Query && !Query.matchesRecord(r, query)) return false;
			return matchesKeywords(terms, r);
		});
	}
	function publishResults(records, query, ctx, final = false) {
		if (!ctx.onResults || ctx.signal?.aborted || ctx.isCancelled?.()) return;
		let snapshot = sortSearchResults(dedupe(records), query).slice(0, query.maxResults || 200);
		ctx.onResults(snapshot, { final, source: snapshot[0]?.source });
	}

	function stripTags(s) {
		if (!s) return "";
		return String(s).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
	}

	function decodeEntities(s) {
		if (!s) return "";
		return String(s)
			.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
			.replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
			.replace(/&#(\d+);/g, (m, n) => String.fromCharCode(parseInt(n, 10)))
			.replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
			.replace(/&amp;/g, "&");
	}

	function normalizeDOI(doi) {
		if (!doi) return null;
		let s = String(doi).trim();
		s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
		s = s.toLowerCase();
		return /^10\.\d{4,9}\/\S+$/.test(s) ? s : null;
	}

	function parseName(full) {
		let name = (full || "").replace(/\s+/g, " ").trim();
		if (!name) return { firstName: "", lastName: "", name: "" };
		if (name.includes(",")) {
			let [last, first] = name.split(",", 2).map(x => x.trim());
			return { firstName: first || "", lastName: last, name };
		}
		let parts = name.split(" ");
		let last = parts.pop();
		return { firstName: parts.join(" "), lastName: last, name };
	}

	// "Sung JY" or "Doudna J" is the form Publish or Perish and PubMed use, and it is what the
	// Authors box suggests. Quoted whole, OpenAlex treats it as an exact phrase and returns
	// almost nothing ("Doudna J" matches 1 work, "Doudna" matches 882), so search the surname
	// and let matchesAuthor() enforce the initials locally.
	function searchableSurname(name) {
		let author = parseName(name);
		let initials = /^[A-Za-z]{1,3}\.?$/.test(author.lastName || "");
		if (initials && author.firstName) return author.firstName;
		return [author.firstName, author.lastName].filter(Boolean).join(" ");
	}

	function fromFamilyGiven(family, given) {
		let lastName = (family || "").trim();
		let firstName = (given || "").trim();
		return { firstName, lastName, name: [firstName, lastName].filter(Boolean).join(" ") };
	}

	function toInt(v) {
		let n = parseInt(v, 10);
		return Number.isFinite(n) ? n : null;
	}

	function yearOf(s) {
		let m = String(s || "").match(/\b(1[5-9]\d{2}|20\d{2})\b/);
		return m ? parseInt(m[1], 10) : null;
	}

	function normalizedText(s) {
		return stripTags(decodeEntities(s)).normalize("NFKC").toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
	}

	function dateFromParts(parts) {
		return parts?.length ? parts.slice(0, 3).map((v, i) => String(v).padStart(i ? 2 : 4, "0")).join("-") : null;
	}

	// Who did the work and where, as far as a source says. OpenAlex names the lab, its
	// country and which author answers for the paper; Crossref and Europe PMC carry an
	// affiliation string at best. Kept per author so the first and corresponding author
	// can be picked later without going back to the source.
	function openAlexId(value) { return String(value || "").replace("https://openalex.org/", "") || null; }
	function openAlexPeople(authorships) {
		let people = (authorships || []).map(a => {
			let inst = (a.institutions || [])[0] || {};
			return {
				name: a.author?.display_name || a.raw_author_name || "",
				position: a.author_position || "",
				corresponding: Boolean(a.is_corresponding),
				institution: inst.display_name || (a.raw_affiliation_strings || [])[0] || "",
				institutionId: openAlexId(inst.id),
				country: String(inst.country_code || (a.countries || [])[0] || "").toUpperCase() || null,
				institutionH: null
			};
		}).filter(p => p.name);
		return people.length ? people : null;
	}
	// A bare affiliation string, when the source has one at all. Null otherwise, so a
	// merge never trades OpenAlex's lab and country for a list of names alone.
	function affiliatedPeople(entries) {
		let people = entries.filter(p => p.name);
		return people.some(p => p.institution) ? people : null;
	}

	function makeRecord(r) {
		let doi = normalizeDOI(r.doi);
		let rec = Object.assign({
			source: "", sourceId: "", title: "", authors: [], year: null, publicationDate: null, venue: "", publisher: "",
			doi: null, pmid: null, pmcid: null, arxiv: null, url: null, pdfUrl: null, pdfUrls: [], citations: null, citationSource: null, sources: null,
			journalId: null, issn: null, journalIF: null, journalH: null,
			preprintServer: null, publishedDoi: null, publishedPmid: null, people: null,
			volume: "", issue: "", pages: "", abstract: "", itemType: "journalArticle"
		}, r, { doi });
		rec.publishedDoi = normalizeDOI(rec.publishedDoi);
		// A preprint whose peer-reviewed version has the very DOI we are holding is not
		// "also published elsewhere"; it is that article, and claiming both would double it.
		if (rec.publishedDoi && rec.publishedDoi === rec.doi) rec.publishedDoi = null;
		rec.title = stripTags(decodeEntities(rec.title));
		rec.key = rec.source + ":" + (rec.sourceId || rec.doi || rec.title.toLowerCase());
		if (!rec.sources) rec.sources = [rec.source];
		if (rec.citations != null && !rec.citationSource) rec.citationSource = rec.source;
		if (!rec.url && rec.doi) rec.url = "https://doi.org/" + rec.doi;
		if (rec.pdfUrl && !rec.pdfUrls.includes(rec.pdfUrl)) rec.pdfUrls.unshift(rec.pdfUrl);
		rec.pdfUrls = rec.pdfUrls.filter(Boolean);
		return rec;
	}

	async function withRetry(fn, { tries = 4, delay = 1500, retryOn = [429, 500, 502, 503, 504] } = {}, ctx = {}) {
		let lastErr;
		for (let i = 0; i < tries; i++) {
			throwIfCancelled(ctx);
			try {
				let value = await fn();
				throwIfCancelled(ctx);
				return value;
			}
			catch (e) {
				throwIfCancelled(ctx);
				lastErr = e;
				if (isQuotaError(e) || !retryOn.includes(e.status) || i === tries - 1) throw e;
				await sleep(delay * (i + 1), ctx);
			}
		}
		throw lastErr;
	}

	// OpenAlex is metered: a search request costs 10 credits, and an unauthenticated caller
	// gets $0.01/day, which is about ten searches before every later request 429s. A free
	// key raises that to $1/day. mailto alone no longer buys anything.
	function openAlexAuth(ctx) {
		let key = (ctx.openAlexApiKey || "").trim();
		return (key ? "&api_key=" + enc(key) : "") + (ctx.email ? "&mailto=" + enc(ctx.email) : "");
	}

	// A budget refusal is not a transient rate limit: retrying burns the remainder and the
	// wait cannot help until midnight UTC, so it must fail fast with an explanation.
	function isQuotaError(e) {
		return e?.status === 429 && /budget|insufficient|credit/i.test(e?.body || e?.message || "");
	}

	function hasAny(q) {
		return Boolean((q.keywords || "").trim() || (q.authors || "").trim() || (q.title || "").trim() || (q.venue || "").trim());
	}

	// ---------------------------------------------------------------- OpenAlex
	function openAlexAbstract(inv) {
		if (!inv || typeof inv !== "object") return "";
		let words = [];
		for (let [w, positions] of Object.entries(inv)) {
			// A single work with a null position list used to throw out of the whole search,
			// discarding every record already fetched. An unusable abstract is not worth that.
			if (!Array.isArray(positions)) continue;
			for (let p of positions) if (Number.isInteger(p) && p >= 0) words[p] = w;
		}
		return words.join(" ").trim();
	}

	function pmcidFromOpenAlex(w) {
		let id = w.ids?.pmcid ? String(w.ids.pmcid) : "";
		if (!id) {
			for (let l of w.locations || []) {
				let m = String(l.landing_page_url || "").match(/\/pmc\/articles\/(?:PMC)?(\d+)/i)
					|| String(l.id || "").match(/pubmedcentral\.nih\.gov:(\d+)/i);
				if (m) { id = "PMC" + m[1]; break; }
			}
		}
		let m = id.match(/PMC(\d+)/i);
		return m ? "PMC" + m[1] : null;
	}

	const OPENALEX_TYPES = {
		article: "journalArticle", "journal-article": "journalArticle", review: "journalArticle",
		preprint: "preprint", book: "book", "book-chapter": "bookSection", dissertation: "thesis",
		report: "report", "proceedings-article": "conferencePaper", paratext: "journalArticle"
	};

	// A plain single name can be resolved to OpenAlex author entities, which is far cheaper
	// and far more accurate than searching raw_author_name and filtering locally: "Sung JY"
	// broadened to the surname returned thousands of other Sungs, 92% of which were then
	// discarded, costing ~99 metered requests before the daily budget ran out.
	function isPlainAuthorQuery(value) {
		return !/\b(AND|OR|NOT)\b|[()";]/i.test(String(value || "").trim());
	}

	async function openAlexAuthorFilter(name, http, ctx) {
		let url = "https://api.openalex.org/authors?search=" + enc(name)
			+ "&per-page=25&select=id,display_name,display_name_alternatives,works_count" + openAlexAuth(ctx);
		let data = await withRetry(() => http.getJSON(url), {}, ctx);
		let ids = [];
		for (let a of data.results || []) {
			let names = [a.display_name, ...(a.display_name_alternatives || [])].filter(Boolean);
			if (!names.some(n => Query.matchesAuthor(name, [{ name: n }]))) continue;
			let id = String(a.id || "").replace("https://openalex.org/", "");
			if (id) ids.push(id);
			if (ids.length >= 25) break;
		}
		return ids.length ? "authorships.author.id:" + ids.join("|") : null;
	}

	async function searchOpenAlex(q, http, ctx) {
		let params = [];
		let filters = [];
		if (q.keywords?.trim()) params.push("search=" + enc(q.keywords.trim()));
		if (q.title?.trim()) filters.push("title.search:" + enc(q.title.trim()));
		if (q.authors?.trim()) {
			let resolved = null;
			if (isPlainAuthorQuery(q.authors)) {
				try { resolved = await openAlexAuthorFilter(q.authors.trim(), http, ctx); }
				catch (e) {
					if (e.name === "AbortError" || isQuotaError(e)) throw e;
					ctx.log?.("OpenAlex author lookup failed, falling back to name search: " + e.message);
				}
			}
			filters.push(resolved || ("raw_author_name.search:" + enc(Query.compileAuthors(q.authors,
				name => '"' + searchableSurname(name).replace(/"/g, "") + '"'))));
		}
		if (q.yearFrom) filters.push("from_publication_date:" + q.yearFrom + "-01-01");
		if (q.yearTo) filters.push("to_publication_date:" + q.yearTo + "-12-31");
		if (q.venue?.trim()) {
			// Resolve the venue to an OpenAlex source id first
			let s = await withRetry(() => http.getJSON("https://api.openalex.org/sources?search=" + enc(q.venue.trim()) + "&per-page=5" + openAlexAuth(ctx)), {}, ctx);
			let candidates = s.results || [];
			let name = normalizedText(q.venue);
			let exact = candidates.filter(x => [x.display_name, x.abbreviated_title, ...(x.alternate_titles || [])]
				.some(v => v && normalizedText(v) === name));
			// A full journal name must not silently include similarly named journals.
			let ids = (exact.length ? exact : candidates).map(x => x.id.replace("https://openalex.org/", ""));
			if (!ids.length) return [];
			filters.push("primary_location.source.id:" + ids.join("|"));
		}
		if (filters.length) params.push("filter=" + filters.join(","));
		if (!params.length) return [];
		let sort = q.sort || "relevance";
		if (sort === "date") params.push("sort=publication_date:desc");
		else if (sort === "citations") params.push("sort=cited_by_count:desc");
		let auth = openAlexAuth(ctx);
		if (auth) params.push(auth.replace(/^&/, "").replace(/&/g, "&"));
		params.push("select=id,doi,title,display_name,publication_year,publication_date,type,authorships,primary_location,biblio,cited_by_count,open_access,best_oa_location,locations,abstract_inverted_index,ids");

		let max = q.maxResults || 200;
		let out = [];
		let page = 1;
		let seen = 0;
		// Page-based APIs calculate offsets using the page size. Keep it fixed on
		// the last page too, otherwise a request for 250 repeats rows 51–100.
		let perPage = Math.min(200, max);
		while (out.length < max) {
			throwIfCancelled(ctx);
			let url = "https://api.openalex.org/works?" + params.join("&") + "&per-page=" + perPage + "&page=" + page;
			let data = await withRetry(() => http.getJSON(url), {}, ctx);
			let results = data.results || [];
			for (let w of results) {
				let loc = w.primary_location || {};
				let src = loc.source || {};
				let ids = w.ids || {};
				out.push(makeRecord({
					source: "openalex",
					sourceId: (w.id || "").replace("https://openalex.org/", ""),
					title: w.title || w.display_name || "",
					authors: (w.authorships || []).map(a => parseName(a.author?.display_name || a.raw_author_name)),
					people: openAlexPeople(w.authorships),
					year: w.publication_year || null,
					publicationDate: w.publication_date || null,
					venue: src.display_name || "",
					publisher: src.host_organization_name || "",
					journalId: src.id ? src.id.replace("https://openalex.org/", "") : null,
					issn: src.issn_l || (src.issn || [])[0] || null,
					doi: w.doi,
					pmid: ids.pmid ? String(ids.pmid).replace(/.*\//, "") : null,
					pmcid: pmcidFromOpenAlex(w),
					url: loc.landing_page_url || w.doi || null,
					pdfUrl: w.best_oa_location?.pdf_url || w.open_access?.oa_url || null,
					pdfUrls: (w.locations || []).filter(l => l.is_oa && l.pdf_url).map(l => l.pdf_url),
					citations: toInt(w.cited_by_count),
					volume: w.biblio?.volume || "",
					issue: w.biblio?.issue || "",
					pages: w.biblio?.first_page ? (w.biblio.last_page && w.biblio.last_page !== w.biblio.first_page ? w.biblio.first_page + "-" + w.biblio.last_page : w.biblio.first_page) : "",
					abstract: openAlexAbstract(w.abstract_inverted_index),
					itemType: OPENALEX_TYPES[w.type] || "journalArticle"
				}));
			}
			seen += results.length;
			out = matchingRecords(dedupe(out), q);
			publishResults(out, q, ctx);
			ctx.onProgress?.(`OpenAlex: ${out.length} / ${Math.min(max, data.meta?.count ?? max)}`, out.length, Math.min(max, data.meta?.count ?? max));
			if (results.length < perPage || seen >= (data.meta?.count ?? seen) || seen >= 10000) break;
			page++;
		}
		return out.slice(0, max);
	}

	// Batch-lookup citation counts (and OA PDFs) by DOI from OpenAlex. Mutates records.
	async function enrichFromOpenAlex(records, http, ctx) {
		// Several records can legitimately share a DOI: compatibleIdentity keeps copies apart
		// when their other identifiers conflict. Keyed one-per-DOI, all but the last lost
		// their citation count and OA links.
		let byDoi = new Map();
		for (let r of records) {
			if (!r.doi || r.citations != null) continue;
			if (!byDoi.has(r.doi)) byDoi.set(r.doi, []);
			byDoi.get(r.doi).push(r);
		}
		let dois = [...byDoi.keys()];
		for (let i = 0; i < dois.length; i += 50) {
			throwIfCancelled(ctx);
			let chunk = dois.slice(i, i + 50);
			let url = "https://api.openalex.org/works?filter=doi:" + chunk.map(enc).join("|") + "&per-page=50&select=doi,ids,cited_by_count,best_oa_location,open_access,locations" + openAlexAuth(ctx);
			try {
				let data = await withRetry(() => http.getJSON(url), {}, ctx);
				for (let w of data.results || []) {
					for (let r of byDoi.get(normalizeDOI(w.doi)) || []) {
						r.citations = toInt(w.cited_by_count);
						if (!r.pdfUrl) r.pdfUrl = w.best_oa_location?.pdf_url || w.open_access?.oa_url || null;
						for (let l of w.locations || []) if (l.is_oa && l.pdf_url && !r.pdfUrls.includes(l.pdf_url)) r.pdfUrls.push(l.pdf_url);
						if (r.pdfUrl && !r.pdfUrls.includes(r.pdfUrl)) r.pdfUrls.unshift(r.pdfUrl);
						if (!r.pmcid) r.pmcid = pmcidFromOpenAlex(w);
					}
				}
			}
			catch (e) {
				if (e.name === "AbortError") throw e;
				ctx.log?.("OpenAlex enrichment failed: " + e.message);
			}
			ctx.onProgress?.(`Citation counts: ${Math.min(i + 50, dois.length)} / ${dois.length}`, i + 50, dois.length);
		}
		return records;
	}

	// ---------------------------------------------------------------- journal metrics
	// OpenAlex publishes a 2-year mean citedness per source: the Journal Impact Factor
	// formula computed over OpenAlex's open citation graph. Free, no key needed.
	const JOURNAL_CACHE = new Map(); // "S123" | "issn:0028-0836" -> stats | null

	function journalStats(s) {
		let ss = s.summary_stats || {};
		return {
			id: (s.id || "").replace("https://openalex.org/", ""),
			name: s.display_name || "",
			issn: s.issn_l || (s.issn || [])[0] || null,
			if2y: Number.isFinite(ss["2yr_mean_citedness"]) ? ss["2yr_mean_citedness"] : null,
			abbrev: s.abbreviated_title || null,
			h: toInt(ss.h_index),
			works: toInt(s.works_count),
			oa: Boolean(s.is_oa),
			doaj: Boolean(s.is_in_doaj)
		};
	}

	function applyJournal(r, st) {
		if (!st) return;
		// The JCR figure, when there is one, is never overwritten by the estimate.
		if (r.journalIFSource !== JCR?.EDITION) { r.journalIF = st.if2y; r.journalIFEstimate = st.if2y != null; }
		r.journalH = st.h;
		if (!r.journalAbbrev && st.abbrev) r.journalAbbrev = st.abbrev;
		if (!r.journalId) r.journalId = st.id;
		if (!r.issn) r.issn = st.issn;
	}

	// A journal known only by name -- Google Scholar and Semantic Scholar hits carry no
	// ISSN -- is looked up by that name, one request per distinct journal, and the
	// answer is kept so the next search pays nothing for it. Preprint servers are
	// skipped: OpenAlex has an h-index for arXiv, and printing it as an IF would mislead.
	const NAME_LOOKUPS_PER_SEARCH = 60;
	function journalNameKey(r) {
		if (r.itemType === "preprint" || r.preprintServer || !r.venue) return null;
		let name = normalizedText(r.venue);
		return name.length >= 3 ? "name:" + name : null;
	}

	// Fill journalIF / journalH on records from their OpenAlex source id, ISSN or, failing
	// both, the journal's name. Mutates records.
	async function enrichJournalMetrics(records, http, ctx = {}) {
		const SELECT = "select=id,display_name,issn_l,issn,summary_stats,works_count,is_oa,is_in_doaj,abbreviated_title,alternate_titles";
		let mailto = openAlexAuth(ctx);
		// The Journal Impact Factor itself first, from the JCR table shipped with the
		// plugin. OpenAlex is then asked only for the journal's h-index and for an
		// estimate where the JCR does not list the journal.
		if (JCR && ctx.jcr !== false) JCR.apply(records);
		let byId = new Map(), byIssn = new Map(), byName = new Map();
		for (let r of records) {
			if (r.journalIF != null && r.journalIFSource !== JCR?.EDITION) continue;
			if (r.journalIFSource === JCR?.EDITION && r.journalH != null) continue;
			if (r.journalId) {
				if (JOURNAL_CACHE.has(r.journalId)) applyJournal(r, JOURNAL_CACHE.get(r.journalId));
				else { if (!byId.has(r.journalId)) byId.set(r.journalId, []); byId.get(r.journalId).push(r); }
			}
			else if (r.issn) {
				let k = "issn:" + r.issn;
				if (JOURNAL_CACHE.has(k)) applyJournal(r, JOURNAL_CACHE.get(k));
				else { if (!byIssn.has(r.issn)) byIssn.set(r.issn, []); byIssn.get(r.issn).push(r); }
			}
			else if (journalNameKey(r)) {
				let k = journalNameKey(r);
				if (JOURNAL_CACHE.has(k)) applyJournal(r, JOURNAL_CACHE.get(k));
				else if (byName.has(k) || byName.size < NAME_LOOKUPS_PER_SEARCH) {
					if (!byName.has(k)) byName.set(k, []);
					byName.get(k).push(r);
				}
			}
		}
		let total = byId.size + byIssn.size + byName.size, done = 0;
		let fetchChunks = async (map, filterName, keysOf) => {
			let keys = [...map.keys()];
			for (let i = 0; i < keys.length; i += 50) {
				throwIfCancelled(ctx);
				let chunk = keys.slice(i, i + 50);
				let url = "https://api.openalex.org/sources?filter=" + filterName + ":" + chunk.map(enc).join("|") + "&per-page=50&" + SELECT + mailto;
				try {
					let data = await withRetry(() => http.getJSON(url), {}, ctx);
					let seen = new Set();
					for (let s of data.results || []) {
						let st = journalStats(s);
						JOURNAL_CACHE.set(st.id, st);
						for (let issn of s.issn || []) JOURNAL_CACHE.set("issn:" + issn, st);
						for (let k of chunk) {
							if (!keysOf(s).includes(k)) continue;
							seen.add(k);
							for (let r of map.get(k)) applyJournal(r, st);
						}
					}
					for (let k of chunk) if (!seen.has(k)) JOURNAL_CACHE.set(filterName === "issn" ? "issn:" + k : k, null);
				}
				catch (e) {
					if (e.name === "AbortError") throw e;
					ctx.log?.("Journal metrics lookup failed: " + e.message);
				}
				done += chunk.length;
				ctx.onProgress?.(`Journal metrics: ${done} / ${total}`, done, total);
			}
		};
		await fetchChunks(byId, "ids.openalex", s => [(s.id || "").replace("https://openalex.org/", "")]);
		await fetchChunks(byIssn, "issn", s => s.issn || []);
		for (let [key, group] of byName) {
			throwIfCancelled(ctx);
			let name = key.slice("name:".length);
			let url = "https://api.openalex.org/sources?search=" + enc(group[0].venue.trim()) + "&per-page=5&" + SELECT + mailto;
			try {
				let data = await withRetry(() => http.getJSON(url), {}, ctx);
				// The journal must be the one asked for: "Nature" is not "Nature Communications".
				let hit = (data.results || []).find(s => [s.display_name, s.abbreviated_title, ...(s.alternate_titles || [])]
					.some(v => v && normalizedText(v) === name));
				let st = hit ? journalStats(hit) : null;
				if (st) {
					JOURNAL_CACHE.set(st.id, st);
					for (let issn of hit.issn || []) JOURNAL_CACHE.set("issn:" + issn, st);
				}
				JOURNAL_CACHE.set(key, st);
				for (let r of group) applyJournal(r, st);
			}
			catch (e) {
				if (e.name === "AbortError") throw e;
				ctx.log?.("Journal lookup by name failed: " + e.message);
			}
			done++;
			ctx.onProgress?.(`Journal metrics: ${done} / ${total}`, done, total);
		}
		return records;
	}

	// ---------------------------------------------------------------- institutions
	// An institution's standing as OpenAlex measures it: the h-index of everything it has
	// published. Asked once per lab, not once per paper, and remembered across searches.
	const INSTITUTION_CACHE = new Map(); // "I123" -> { id, name, country, hIndex } | null

	function institutionStats(i) {
		return {
			id: openAlexId(i.id),
			name: i.display_name || "",
			country: String(i.country_code || "").toUpperCase() || null,
			hIndex: toInt(i.summary_stats?.h_index)
		};
	}

	function applyInstitution(p, st) {
		if (!st) return;
		p.institutionH = st.hIndex;
		if (!p.institution) p.institution = st.name;
		if (!p.country) p.country = st.country;
	}

	// Only the first and corresponding authors are shown, so only their labs are looked up.
	function principalPeople(record) {
		let picked = Affiliations?.principals(record.people);
		return picked ? [picked.first, picked.corresponding].filter(Boolean) : [];
	}

	async function enrichInstitutions(records, http, ctx = {}) {
		let byId = new Map();
		for (let r of records) {
			for (let p of principalPeople(r)) {
				if (!p.institutionId || p.institutionH != null) continue;
				if (INSTITUTION_CACHE.has(p.institutionId)) applyInstitution(p, INSTITUTION_CACHE.get(p.institutionId));
				else {
					if (!byId.has(p.institutionId)) byId.set(p.institutionId, []);
					byId.get(p.institutionId).push(p);
				}
			}
		}
		let ids = [...byId.keys()];
		for (let i = 0; i < ids.length; i += 50) {
			throwIfCancelled(ctx);
			let chunk = ids.slice(i, i + 50);
			let url = "https://api.openalex.org/institutions?filter=ids.openalex:" + chunk.join("|")
				+ "&per-page=50&select=id,display_name,country_code,summary_stats" + openAlexAuth(ctx);
			try {
				let data = await withRetry(() => http.getJSON(url), {}, ctx);
				let seen = new Set();
				for (let raw of data.results || []) {
					let st = institutionStats(raw);
					if (!st.id) continue;
					INSTITUTION_CACHE.set(st.id, st);
					seen.add(st.id);
					for (let p of byId.get(st.id) || []) applyInstitution(p, st);
				}
				// A lab nobody answered for is recorded as asked, so the next search does
				// not keep asking the same unanswerable question.
				for (let id of chunk) if (!seen.has(id)) INSTITUTION_CACHE.set(id, null);
			}
			catch (e) {
				if (e.name === "AbortError") throw e;
				ctx.log?.("Institution lookup failed: " + e.message);
			}
			ctx.onProgress?.(`Institutions: ${Math.min(i + 50, ids.length)} / ${ids.length}`, i + 50, ids.length);
		}
		return records;
	}

	// The journal and institution answers, for the caller to keep on disk between sessions:
	// every one of them cost a metered request, and none of them changes week to week.
	const CACHE_EXPORT_LIMIT = 6000;
	function exportCaches() {
		let tail = map => [...map.entries()].slice(-CACHE_EXPORT_LIMIT);
		return { version: 1, savedAt: new Date().toISOString(), journals: tail(JOURNAL_CACHE), institutions: tail(INSTITUTION_CACHE) };
	}
	function importCaches(snapshot) {
		if (!snapshot || snapshot.version !== 1) return 0;
		let n = 0;
		for (let [map, entries] of [[JOURNAL_CACHE, snapshot.journals], [INSTITUTION_CACHE, snapshot.institutions]]) {
			for (let entry of Array.isArray(entries) ? entries : []) {
				if (!Array.isArray(entry) || typeof entry[0] !== "string" || map.has(entry[0])) continue;
				if (entry[1] !== null && (typeof entry[1] !== "object" || Array.isArray(entry[1]))) continue;
				map.set(entry[0], entry[1]);
				n++;
			}
		}
		return n;
	}

	// Live citation counts for one record from every free source that knows it.
	// Returns { openalex, crossref, semanticscholar } (null = not found) and updates rec
	// with the highest count plus its journal's impact.
	async function checkCitations(rec, http, ctx = {}) {
		let doi = rec.doi;
		let mailto = openAlexAuth(ctx).replace(/^&/, "");
		let out = { openalex: null, crossref: null, semanticscholar: null };
		let tasks = [];
		if (doi) {
			tasks.push(withRetry(() => http.getJSON("https://api.openalex.org/works/doi:" + enc(doi) + "?select=cited_by_count,primary_location" + (mailto ? "&" + mailto : "")), {}, ctx).then(w => {
				out.openalex = toInt(w.cited_by_count);
				let src = w.primary_location?.source;
				if (src?.id && !rec.journalId) rec.journalId = src.id.replace("https://openalex.org/", "");
				if (src && !rec.issn) rec.issn = src.issn_l || (src.issn || [])[0] || null;
			}).catch(e => ctx.log?.("OpenAlex: " + e.message)));
			tasks.push(withRetry(() => http.getJSON("https://api.crossref.org/works/" + enc(doi) + (mailto ? "?" + mailto : "")), {}, ctx).then(d => {
				out.crossref = toInt(d.message?.["is-referenced-by-count"]);
				if (!rec.issn) rec.issn = (d.message?.ISSN || [])[0] || null;
			}).catch(e => ctx.log?.("Crossref: " + e.message)));
		}
		else if (rec.source === "openalex" && rec.sourceId) {
			tasks.push(withRetry(() => http.getJSON("https://api.openalex.org/works/" + enc(rec.sourceId) + "?select=cited_by_count" + (mailto ? "&" + mailto : "")), {}, ctx).then(w => {
				out.openalex = toInt(w.cited_by_count);
			}).catch(e => ctx.log?.("OpenAlex: " + e.message)));
		}
		let s2id = doi ? "DOI:" + doi : rec.arxiv ? "ARXIV:" + rec.arxiv : rec.pmid ? "PMID:" + rec.pmid : null;
		if (s2id) {
			let headers = ctx.s2ApiKey ? { "x-api-key": ctx.s2ApiKey } : {};
			tasks.push(withRetry(() => http.getJSON("https://api.semanticscholar.org/graph/v1/paper/" + enc(s2id) + "?fields=citationCount", headers), {}, ctx).then(p => {
				out.semanticscholar = toInt(p.citationCount);
			}).catch(e => ctx.log?.("Semantic Scholar: " + e.message)));
		}
		await Promise.all(tasks);
		let best = null;
		for (let [k, v] of Object.entries(out)) if (v != null && (best == null || v > best.n)) best = { n: v, src: k };
		if (best) { rec.citations = best.n; rec.citationSource = best.src; }
		if (rec.journalIF == null && (rec.journalId || rec.issn)) await enrichJournalMetrics([rec], http, ctx);
		return out;
	}

	// ---------------------------------------------------------------- Crossref
	const CROSSREF_TYPES = {
		"journal-article": "journalArticle", "proceedings-article": "conferencePaper", "posted-content": "preprint",
		book: "book", monograph: "book", "edited-book": "book", "book-chapter": "bookSection", dissertation: "thesis", report: "report"
	};
	const CROSSREF_JOURNALS = new Map();
	async function crossrefJournal(venue, http, ctx) {
		if (/^\d{4}-?\d{3}[\dx]$/i.test(venue)) return { issn: venue.replace(/^(\d{4})(\d{3}[\dx])$/i, "$1-$2"), title: null };
		let key = normalizedText(venue);
		if (CROSSREF_JOURNALS.has(key)) return CROSSREF_JOURNALS.get(key);
		let url = "https://api.crossref.org/journals?query=" + enc(venue) + "&rows=20" + (ctx.email ? "&mailto=" + enc(ctx.email) : "");
		let data = await withRetry(() => http.getJSON(url), {}, ctx);
		let exact = (data.message?.items || []).filter(j => typeof j.title === "string"
			&& Query.matchesVenue(venue, { venue: j.title, issns: j.ISSN || [] }));
		let result = exact.length === 1 && exact[0].ISSN?.length ? { issn: exact[0].ISSN[0], title: exact[0].title } : null;
		if (result) CROSSREF_JOURNALS.set(key, result);
		return result;
	}

	// `publisher` is the parent company, not the archive: a bioRxiv posting reads "openRxiv",
	// ChemRxiv reads "American Chemical Society (ACS)", Preprints.org reads "MDPI AG" and
	// TechRxiv reads "IEEE". `institution` names the archive but only bioRxiv, medRxiv and
	// Research Square set it, and it cannot be requested through `select` at all.
	// resource.primary.URL can, and it is the landing page on the archive itself, so its host
	// identifies the archive exactly -- including which of bioRxiv and medRxiv a shared
	// openRxiv prefix belongs to. Every host below was read back from a real record.
	const PREPRINT_SERVER_HOSTS = {
		"biorxiv.org": "bioRxiv", "medrxiv.org": "medRxiv", "chemrxiv.org": "ChemRxiv",
		"researchsquare.com": "Research Square", "preprints.org": "Preprints.org",
		"techrxiv.org": "TechRxiv", "authorea.com": "Authorea", "ssrn.com": "SSRN",
		"peerj.com": "PeerJ Preprints", "qeios.com": "Qeios", "osf.io": "OSF Preprints",
		"arxiv.org": "arXiv"
	};

	function crossrefPreprintServer(w) {
		let host = hostOf(w.resource?.primary?.URL).replace(/^www\./, "");
		return PREPRINT_SERVER_HOSTS[host] || w.institution?.[0]?.name || w.publisher || "Preprint";
	}

	// Crossref records `is-preprint-of` on the posting itself once the journal version is
	// registered, so the published DOI comes back with the search and costs no extra request.
	function crossrefPublishedDOI(w) {
		for (let rel of w.relation?.["is-preprint-of"] || []) {
			if (rel["id-type"] === "doi" && rel.id) return rel.id;
		}
		return null;
	}

	async function searchCrossref(q, http, ctx, preprintsOnly = false) {
		if (!hasAny(q)) return [];
		let params = [];
		let endpoint = "https://api.crossref.org/works", journal = null;
		if (q.keywords?.trim()) params.push("query=" + enc(q.keywords.trim()));
		if (q.title?.trim()) params.push("query.bibliographic=" + enc(q.title.trim()));
		if (q.authors?.trim()) params.push("query.author=" + enc(q.authors.trim()));
		let filters = [];
		// "posted-content" is Crossref's type for a preprint posting. It is the whole preprint
		// landscape in one index -- bioRxiv, ChemRxiv, Research Square, SSRN, Preprints.org --
		// and it carries the posting date, so it is what makes the archives searchable here.
		if (preprintsOnly) filters.push("type:posted-content");
		// A posting has no container-title and no ISSN, so both of Crossref's venue routes
		// return nothing for one. On this route the venue names the archive instead, which
		// is held in the record and matched locally below.
		if (q.venue?.trim() && !preprintsOnly) {
			journal = await crossrefJournal(q.venue.trim(), http, ctx);
			if (journal) endpoint = "https://api.crossref.org/journals/" + enc(journal.issn) + "/works";
			else filters.push("container-title:" + enc(q.venue.trim()));
		}
		if (q.yearFrom) filters.push("from-pub-date:" + q.yearFrom);
		if (q.yearTo) filters.push("until-pub-date:" + q.yearTo);
		if (filters.length) params.push("filter=" + filters.join(","));
		if (q.sort === "date") params.push("sort=published", "order=desc");
		else if (q.sort === "citations") params.push("sort=is-referenced-by-count", "order=desc");
		if (ctx.email) params.push("mailto=" + enc(ctx.email));
		// `institution` and `subtype` are not selectable on /works -- asking for either makes
		// the whole request a 400. The preprint route therefore takes the full record and
		// pays the extra bytes; every other route stays on the narrow projection, which
		// `resource` keeps wide enough to name an archive when a posting turns up there.
		if (!preprintsOnly) params.push("select=DOI,title,author,issued,posted,relation,resource,container-title,publisher,is-referenced-by-count,volume,issue,page,URL,type,abstract,link,ISSN");

		let max = q.maxResults || 200;
		let out = [];
		let offset = 0;
		while (out.length < max) {
			throwIfCancelled(ctx);
			let rows = Math.min(100, max - out.length);
			let url = endpoint + "?" + params.join("&") + "&rows=" + rows + "&offset=" + offset;
			let data = await withRetry(() => http.getJSON(url), {}, ctx);
			let items = data.message?.items || [];
			for (let w of items) {
				let pdf = (w.link || []).find(l => l["content-type"] === "application/pdf");
				// Crossref files more than postings under posted-content, and separates them
				// by subtype: in a 100-record sample the nine subtype "other" rows were
				// conference-abstract aggregators, a preprint-highlights blog and a news
				// site, none of which is a paper anyone asked a preprint search for.
				if (preprintsOnly && w.subtype && w.subtype !== "preprint") continue;
				let isPreprint = w.type === "posted-content";
				// A preprint is dated by when it went up, which Crossref keeps in `posted`.
				// `issued` can carry the journal version's date and would misdate the posting.
				let dated = (isPreprint && w.posted?.["date-parts"]?.[0]) || w.issued?.["date-parts"]?.[0];
				let server = isPreprint ? crossrefPreprintServer(w) : null;
				out.push(makeRecord({
					source: "crossref",
					sourceId: w.DOI,
					title: (w.title || [])[0] || "",
					authors: (w.author || []).map(a => a.family ? fromFamilyGiven(a.family, a.given) : parseName(a.name)),
					people: affiliatedPeople((w.author || []).map((a, i) => ({
						name: a.family ? fromFamilyGiven(a.family, a.given).name : a.name || "",
						position: a.sequence === "first" || i === 0 ? "first" : i === (w.author || []).length - 1 ? "last" : "middle",
						corresponding: false,
						institution: (a.affiliation || []).map(x => x.name).find(Boolean) || "",
						institutionId: null, country: null, institutionH: null
					}))),
					year: dated?.[0] || null,
					publicationDate: dateFromParts(dated),
					venue: (w["container-title"] || [])[0] || server || "",
					publisher: w.publisher || "",
					preprintServer: server,
					publishedDoi: isPreprint ? crossrefPublishedDOI(w) : null,
					issn: (w.ISSN || [])[0] || null,
					issns: w.ISSN || [],
					venueAliases: journal?.title ? [journal.title] : [],
					doi: w.DOI,
					url: w.URL || null,
					pdfUrl: pdf?.URL || null,
					citations: toInt(w["is-referenced-by-count"]),
					volume: w.volume || "",
					issue: w.issue || "",
					pages: w.page || "",
					abstract: stripTags(w.abstract || ""),
					itemType: CROSSREF_TYPES[w.type] || "journalArticle"
				}));
			}
			let total = data.message?.["total-results"] ?? 0;
			out = matchingRecords(dedupe(out), q);
			publishResults(out, q, ctx);
			ctx.onProgress?.(`Crossref: ${out.length} / ${Math.min(max, total)}`, out.length, Math.min(max, total));
			if (items.length < rows || offset + items.length >= total || offset + rows >= 10000) break;
			offset += rows;
		}
		return out.slice(0, max);
	}

	// Resolve a DOI for a record lacking one by title match on Crossref
	function titleTokens(t) {
		return new Set(String(t || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w.length > 2));
	}
	function titleSimilarity(a, b) {
		let A = titleTokens(a), B = titleTokens(b);
		if (!A.size || !B.size) return 0;
		let inter = 0;
		for (let w of A) if (B.has(w)) inter++;
		return inter / Math.max(A.size, B.size);
	}
	async function resolveDOIByTitle(record, http, ctx = {}) {
		if (record.doi || !record.title) return null;
		let url = "https://api.crossref.org/works?rows=5&query.bibliographic=" + enc(record.title) + "&select=DOI,title,issued,author" + (ctx.email ? "&mailto=" + enc(ctx.email) : "");
		let data = await withRetry(() => http.getJSON(url), {}, ctx);
		for (let w of data.message?.items || []) {
			let candidate = { doi: w.DOI, title: (w.title || [])[0], year: w.issued?.["date-parts"]?.[0]?.[0],
				authors: (w.author || []).map(a => a.family ? fromFamilyGiven(a.family, a.given) : parseName(a.name)) };
			if (Query?.isSafeDOIMatch(record, candidate)) {
				record.doi = normalizeDOI(w.DOI);
				return record.doi;
			}
		}
		return null;
	}

	// ---------------------------------------------------------------- Semantic Scholar
	const S2_FIELDS = "externalIds,title,authors,year,publicationDate,venue,journal,citationCount,openAccessPdf,abstract,url,publicationTypes,publicationVenue";
	function semanticScholarRecord(p) {
		let ext = p.externalIds || {};
		let types = p.publicationTypes || [];
		let itemType = types.includes("Conference") ? "conferencePaper" : types.includes("Book") ? "book" : "journalArticle";
		if (!ext.DOI && ext.ArXiv) itemType = "preprint";
		return makeRecord({
			source: "semanticscholar",
			sourceId: p.paperId,
			title: p.title || "",
			authors: (p.authors || []).map(a => parseName(a.name)),
			year: p.year || null,
			publicationDate: p.publicationDate || null,
			venue: p.journal?.name || p.venue || p.publicationVenue?.name || "",
			doi: ext.DOI,
			pmid: ext.PubMed || null,
			arxiv: ext.ArXiv || null,
			url: p.url || null,
			pdfUrl: p.openAccessPdf?.url || null,
			citations: toInt(p.citationCount),
			volume: p.journal?.volume || "",
			pages: p.journal?.pages || "",
			abstract: p.abstract || "",
			itemType
		});
	}

	async function searchSemanticScholar(q, http, ctx) {
		let terms = [q.keywords, q.title].map(x => (x || "").trim().replace(/-/g, " ")).filter(Boolean);
		// The paper relevance endpoint searches paper text, not author bylines.
		// Author-only searches are resolved through the author graph below.
		if (!terms.length && q.authors?.trim()) return searchSemanticScholarAuthor(q, http, ctx);
		if (!terms.length && !q.venue?.trim()) return [];
		let params = ["query=" + enc(terms.join(" ") || q.venue.trim())];
		if (q.venue?.trim()) params.push("venue=" + enc(q.venue.trim()));
		if (q.yearFrom || q.yearTo) params.push("year=" + (q.yearFrom || "") + "-" + (q.yearTo || ""));
		params.push("fields=" + S2_FIELDS);
		let headers = ctx.s2ApiKey ? { "x-api-key": ctx.s2ApiKey } : {};

		let max = Math.min(q.maxResults || 200, 1000);
		let out = [];
		let offset = 0;
		while (out.length < max) {
			throwIfCancelled(ctx);
			let limit = Math.min(100, max - out.length, 1000 - offset);
			if (limit <= 0) break;
			let url = "https://api.semanticscholar.org/graph/v1/paper/search?" + params.join("&") + "&limit=" + limit + "&offset=" + offset;
			let data = await withRetry(() => http.getJSON(url, headers), { tries: 6, delay: 4000 }, ctx);
			let items = data.data || [];
			for (let p of items) out.push(semanticScholarRecord(p));
			let total = data.total ?? 0;
			out = matchingRecords(dedupe(out), q);
			publishResults(out, q, ctx);
			ctx.onProgress?.(`Semantic Scholar: ${out.length} / ${Math.min(max, total)}`, out.length, Math.min(max, total));
			if (items.length < limit || data.next == null || offset + items.length >= total) break;
			offset = data.next;
			await sleep(1100, ctx); // unauthenticated rate limit ~1 req/s
		}
		return out.slice(0, max);
	}

	async function searchSemanticScholarAuthor(q, http, ctx) {
		if (/\bNOT\b|[()]/i.test(q.authors)) throw new Error("Semantic Scholar author lookup supports names separated by AND, OR or semicolons");
		let names = q.authors.split(/\s+(?:AND|OR)\s+|;/i).map(n => n.trim().replace(/^"|"$/g, "")).filter(Boolean);
		let headers = ctx.s2ApiKey ? { "x-api-key": ctx.s2ApiKey } : {};
		let authors = new Map(), out = [], max = Math.min(q.maxResults || 200, 1000);
		for (let name of names) {
			let url = "https://api.semanticscholar.org/graph/v1/author/search?query=" + enc(name.replace(/-/g, " ")) + "&limit=20&fields=name";
			let response = await withRetry(() => http.getJSON(url, headers), { tries: 3, delay: 2000 }, ctx);
			for (let author of response.data || []) {
				if (author.authorId && Query.matchesAuthor(name, [author])) authors.set(author.authorId, author);
			}
		}
		if (authors.size > 5) throw new Error("Too many matching Semantic Scholar authors; enter a more specific full name");
		// Papers are collected per profile and interleaved below: concatenating them meant a
		// cap of 10 was filled entirely by the first matched profile, so "Doudna J" returned
		// a power-systems engineer's papers and never reached Jennifer Doudna's.
		let perAuthor = [];
		for (let author of authors.values()) {
			let offset = 0;
			let authorRecords = [];
			while (offset < 1000 && authorRecords.length < max) {
				throwIfCancelled(ctx);
				let url = "https://api.semanticscholar.org/graph/v1/author/" + enc(author.authorId) + "/papers?fields=" + S2_FIELDS + "&limit=100&offset=" + offset;
				let response = await withRetry(() => http.getJSON(url, headers), { tries: 3, delay: 2000 }, ctx);
				authorRecords = matchingRecords(dedupe([...authorRecords, ...(response.data || []).map(semanticScholarRecord)]), q);
				out = dedupe([...out, ...authorRecords]);
				publishResults(out, q, ctx);
				if (response.next == null || response.next <= offset || !(response.data || []).length) break;
				offset = response.next;
				await sleep(1100, ctx);
			}
			perAuthor.push(authorRecords);
		}
		return sortSearchResults(interleave(perAuthor), q).slice(0, max);
	}

	// Round-robin so a result cap is shared between equally plausible author profiles
	function interleave(lists) {
		let out = [], depth = Math.max(0, ...lists.map(l => l.length));
		for (let i = 0; i < depth; i++) for (let list of lists) if (i < list.length) out.push(list[i]);
		return dedupe(out);
	}

	// ---------------------------------------------------------------- PubMed
	// PubMed's [dp] filter matches the electronic publication date, while esummary's
	// `pubdate` is the (often later) journal issue date. Use the earlier of the two so the
	// year shown agrees with the year filter and with Crossref/OpenAlex online dates.
	function pubmedYear(d) {
		let years = [yearOf(d.epubdate), yearOf(d.pubdate), yearOf(d.sortpubdate)].filter(Boolean);
		return years.length ? Math.min(...years) : null;
	}

	function pubmedTerm(q) {
		let parts = [];
		// PoP uses Text Word, not PubMed's unrestricted automatic term mapping.
		// Preserve phrases/Boolean operators while tagging the actual search terms.
		if (q.keywords?.trim()) parts.push(pubmedFieldQuery(q.keywords, "Text Word"));
		if (q.title?.trim()) parts.push(pubmedFieldQuery(q.title, "ti"));
		if (q.authors?.trim()) parts.push(Query.compileAuthors(q.authors, name => name + "[au]", { binaryNot: true }));
		if (q.venue?.trim()) parts.push('"' + q.venue.trim() + '"[ta]');
		if (q.yearFrom || q.yearTo) parts.push((q.yearFrom || "1800") + ":" + (q.yearTo || "3000") + "[dp]");
		return parts.join(" AND ");
	}

	// PubMed evaluates strictly left to right, so "a OR b c" becomes ("a" OR "b") AND "c",
	// the opposite of what the box means and of what query.js applies locally. Emit explicit
	// parentheses around each run of implicitly-ANDed terms so both sides agree.
	function pubmedFieldQuery(value, field) {
		let tokens = value.trim().match(/"[^"]*"(?:\[[^\]]+\])?|[^\s()[\]"]+\[[^\]]+\]|[()]|[^\s()]+/g) || [];
		let pos = 0;

		let tag = token => /\[[^\]]+\]$/.test(token) ? token : token + "[" + field + "]";

		// One parenthesis level: AND-runs separated by OR/NOT.
		function level() {
			let segments = [[]], separators = [];
			while (pos < tokens.length) {
				let token = tokens[pos++];
				if (token === ")") break;
				if (token === "(") { segments[segments.length - 1].push("(" + level() + ")"); continue; }
				if (token === "ANDNOT") token = "NOT";
				if (/^(OR|NOT)$/.test(token)) { separators.push(token); segments.push([]); continue; }
				if (token === "AND") continue;
				segments[segments.length - 1].push(tag(token));
			}
			let grouped = segments.filter(seg => seg.length).map(seg =>
				seg.length > 1 && separators.length ? "(" + seg.join(" AND ") + ")" : seg.join(" AND "));
			if (!grouped.length) return "";
			let out = grouped[0];
			for (let i = 1; i < grouped.length; i++) out += " " + (separators[i - 1] || "AND") + " " + grouped[i];
			return out;
		}

		return level();
	}

	async function searchPubMed(q, http, ctx) {
		if (!hasAny(q)) return [];
		let max = q.maxResults || 200;
		let base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
		let tool = "&tool=zotpop" + (ctx.email ? "&email=" + enc(ctx.email) : "");
		let sort = q.sort === "date" ? "pub_date" : "relevance";
		let es = await withRetry(() => http.getJSON(base + "esearch.fcgi?db=pubmed&retmode=json&sort=" + sort + "&retmax=" + Math.min(10000, max * 3) + "&term=" + enc(pubmedTerm(q)) + tool), {}, ctx);
		let ids = es.esearchresult?.idlist || [];
		let total = toInt(es.esearchresult?.count) || ids.length;
		let out = [];
		for (let i = 0; i < ids.length && out.length < max; i += 200) {
			throwIfCancelled(ctx);
			let chunk = ids.slice(i, i + 200);
			await sleep(350, ctx);
			let sum = await withRetry(() => http.getJSON(base + "esummary.fcgi?db=pubmed&retmode=json&id=" + chunk.join(",") + tool), {}, ctx);
			let result = sum.result || {};
			for (let uid of result.uids || chunk) {
				let d = result[uid];
				if (!d || d.error) continue;
				let aids = d.articleids || [];
				let doi = aids.find(x => x.idtype === "doi")?.value || d.elocationid?.replace(/^doi:\s*/i, "") || null;
				let pmc = aids.find(x => x.idtype === "pmc")?.value || null;
				out.push(makeRecord({
					source: "pubmed",
					sourceId: uid,
					title: d.title || "",
					authors: (d.authors || []).filter(a => a.authtype !== "CollectiveName").map(a => {
						// "Sung JY" -> last "Sung", first "JY"
						let m = String(a.name || "").match(/^(.*\S)\s+(\S+)$/);
						return m ? { firstName: m[2], lastName: m[1], name: a.name } : parseName(a.name);
					}),
					year: pubmedYear(d),
					venue: d.fulljournalname || d.source || "",
					issn: d.issn || d.essn || null,
					doi,
					pmid: uid,
					pmcid: pmc,
					url: "https://pubmed.ncbi.nlm.nih.gov/" + uid + "/",
					pdfUrl: pmc ? "https://www.ncbi.nlm.nih.gov/pmc/articles/" + pmc + "/pdf/" : null,
					citations: null,
					volume: d.volume || "",
					issue: d.issue || "",
					pages: d.pages || "",
					itemType: "journalArticle"
				}));
			}
			out = matchingRecords(dedupe(out), q);
			publishResults(out, q, ctx);
			ctx.onProgress?.(`PubMed: ${out.length} / ${Math.min(max, total)}`, out.length, Math.min(max, total));
		}
		if (ctx.enrichCitations !== false) await enrichFromOpenAlex(out, http, ctx);
		return sortSearchResults(out, q).slice(0, max);
	}

	// ---------------------------------------------------------------- arXiv
	function xmlText(block, tag) {
		let m = block.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">"));
		return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
	}

	function arxivFieldQuery(value, field) {
		// Preserve phrases and Boolean structure; add AND only between adjacent terms.
		let tokens = value.trim().match(/(?:[a-z_]+:)?"[^"]*"|[()]|[^\s()]+/gi) || [];
		let out = [], previousTerm = false;
		for (let token of tokens) {
			if (token === "NOT") {
				if (out[out.length - 1] === "AND") out.pop();
				token = "ANDNOT";
			}
			let operator = /^(AND|OR|ANDNOT)$/.test(token);
			let startsTerm = !operator && token !== ")";
			if (previousTerm && startsTerm) out.push("AND");
			out.push(operator || token === "(" || token === ")" || /^[a-z_]+:/i.test(token) ? token : field + ":" + token);
			previousTerm = !operator && token !== "(";
		}
		return out.join(" ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
	}

	async function searchArxiv(q, http, ctx) {
		let parts = [];
		if (q.keywords?.trim()) parts.push(arxivFieldQuery(q.keywords, "all"));
		if (q.title?.trim()) parts.push(arxivFieldQuery(q.title, "ti"));
		if (q.authors?.trim()) parts.push(Query.compileAuthors(q.authors, name => 'au:"' + name.replace(/"/g, "") + '"', { notOperator: "ANDNOT" }));
		if (q.venue?.trim()) parts.push('jr:"' + q.venue.trim() + '"');
		if (!parts.length) return [];
		if (q.yearFrom || q.yearTo) parts.push("submittedDate:[" + (q.yearFrom || "1990") + "01010000 TO " + (q.yearTo || "2100") + "12312359]");
		let query = parts.map(p => "(" + p + ")").join(" AND ");
		let max = q.maxResults || 200;
		let out = [];
		let start = 0;
		let total = null;
		while (out.length < max) {
			throwIfCancelled(ctx);
			let n = Math.min(100, max - out.length);
			let url = "https://export.arxiv.org/api/query?search_query=" + enc(query) + "&start=" + start + "&max_results=" + n + (q.sort === "date" ? "&sortBy=submittedDate&sortOrder=descending" : "&sortBy=relevance");
			let xml = await withRetry(() => http.getText(url), { tries: 5, delay: 4000 }, ctx);
			if (total == null) total = toInt(xmlText(xml, "opensearch:totalResults")) ?? 0;
			let entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
			for (let e of entries) {
				let idUrl = xmlText(e, "id");
				if (/\/api\/errors/i.test(idUrl)) throw new Error("arXiv rejected the search: " + xmlText(e, "summary"));
				let arxivId = idUrl.replace(/^.*\/abs\//, "").replace(/v\d+$/, "");
				let authors = [...e.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g)].map(m => parseName(decodeEntities(m[1])));
				let doi = xmlText(e, "arxiv:doi");
				let journalReference = xmlText(e, "arxiv:journal_ref");
				let venue = journalReference.replace(/[,;]?\s+\d[\s\S]*$/, "").replace(/[,;]$/, "").trim();
				let pdf = (e.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/) || [])[1] || ("https://arxiv.org/pdf/" + arxivId);
				out.push(makeRecord({
					source: "arxiv",
					sourceId: arxivId,
					title: xmlText(e, "title"),
					authors,
					year: yearOf(xmlText(e, "published")),
					publicationDate: xmlText(e, "published").slice(0, 10) || null,
					venue: venue || "arXiv",
					journalReference,
					doi: doi || null,
					arxiv: arxivId,
					url: "https://arxiv.org/abs/" + arxivId,
					pdfUrl: pdf,
					citations: null,
					abstract: xmlText(e, "summary"),
					// Every arXiv entry is a posting on arXiv, whether or not a journal has
					// since taken it, so the archive is always named. arxiv:doi is that
					// journal version's DOI, which is what itemType keys off.
					preprintServer: "arXiv",
					itemType: doi ? "journalArticle" : "preprint"
				}));
			}
			out = matchingRecords(dedupe(out), q);
			publishResults(out, q, ctx);
			ctx.onProgress?.(`arXiv: ${out.length} / ${Math.min(max, total)}`, out.length, Math.min(max, total));
			// start counts rows walked, not rows kept, so a filter that rejects everything
			// would otherwise page through the entire result set three seconds at a time.
			if (entries.length < n || start + entries.length >= total || start + entries.length >= PAGE_WALK_LIMIT) break;
			start += n;
			await sleep(3000, ctx); // arXiv asks for 3 s between requests
		}
		if (ctx.enrichCitations !== false) await enrichFromOpenAlex(out, http, ctx);
		return out.slice(0, max);
	}

	// ---------------------------------------------------------------- Europe PMC
	// Indexes PubMed + PMC and, crucially, the preprint servers: bioRxiv, medRxiv
	// and Research Square. Used both as a general source and as the preprint source.
	function epmcQuery(q, preprintsOnly) {
		let parts = [];
		if (q.keywords?.trim()) parts.push("(" + q.keywords.trim() + ")");
		if (q.title?.trim()) parts.push('TITLE:"' + q.title.trim().replace(/"/g, "") + '"');
		if (q.authors?.trim()) {
			parts.push(Query.compileAuthors(q.authors, name => 'AUTH:"' + name.replace(/"/g, "") + '"'));
		}
		if (q.venue?.trim()) {
			let v = q.venue.trim().replace(/"/g, "");
			parts.push(preprintsOnly ? '(PUBLISHER:"' + v + '" OR JOURNAL:"' + v + '")' : 'JOURNAL:"' + v + '"');
		}
		if (q.yearFrom || q.yearTo) parts.push("PUB_YEAR:[" + (q.yearFrom || 1800) + " TO " + (q.yearTo || 3000) + "]");
		if (preprintsOnly) parts.push("SRC:PPR");
		return parts.join(" AND ");
	}

	function epmcPublishedPmid(r) {
		for (let c of r.commentCorrectionList?.commentCorrection || []) {
			if (/^preprint of$/i.test(c.type || "") && c.source === "MED" && c.id) return String(c.id);
		}
		return null;
	}

	function epmcRecord(r) {
		let ft = r.fullTextUrlList?.fullTextUrl || [];
		let pdf = ft.find(x => x.documentStyle === "pdf")?.url || null;
		let publisher = r.bookOrReportDetails?.publisher || r.publisher || "";
		let isPreprint = r.source === "PPR" || (r.pubTypeList?.pubType || []).some(t => /preprint/i.test(t));
		let authors = (r.authorList?.author || []).map(a => a.firstName || a.lastName
			? { firstName: a.firstName || (a.initials || ""), lastName: a.lastName || "", name: [a.firstName || a.initials, a.lastName].filter(Boolean).join(" ") }
			: parseName(a.fullName));
		if (!authors.length && r.authorString) {
			authors = r.authorString.replace(/\.$/, "").split(/,\s*/).filter(Boolean).map(n => {
				let m = n.trim().match(/^(.*\S)\s+(\S+)$/);
				return m ? { firstName: m[2], lastName: m[1], name: n.trim() } : parseName(n);
			});
		}
		let epmcAuthors = r.authorList?.author || [];
		return makeRecord({
			source: "europepmc",
			sourceId: r.id,
			title: r.title || "",
			authors,
			people: affiliatedPeople(epmcAuthors.map((a, i) => ({
				name: authors[i]?.name || a.fullName || "",
				position: i === 0 ? "first" : i === epmcAuthors.length - 1 ? "last" : "middle",
				corresponding: false,
				institution: (a.authorAffiliationDetailsList?.authorAffiliation || []).map(x => x.affiliation).find(Boolean) || "",
				institutionId: null, country: null, institutionH: null
			}))),
			year: toInt(r.pubYear) || yearOf(r.firstPublicationDate),
			publicationDate: r.firstPublicationDate || null,
			venue: r.journalInfo?.journal?.title || r.journalTitle || publisher || (isPreprint ? "Preprint" : ""),
			publisher,
			issn: r.journalInfo?.journal?.issn || r.journalInfo?.journal?.essn || null,
			doi: r.doi,
			pmid: r.pmid || null,
			pmcid: r.pmcid || null,
			url: r.doi ? "https://doi.org/" + r.doi : (ft[0]?.url || null),
			pdfUrl: pdf,
			pdfUrls: [pdf, r.pmcid ? "https://europepmc.org/articles/" + r.pmcid + "?pdf=render" : null].filter(Boolean),
			citations: toInt(r.citedByCount),
			volume: r.journalInfo?.volume || "",
			issue: r.journalInfo?.issue || "",
			pages: r.pageInfo || "",
			abstract: r.abstractText ? stripTags(r.abstractText) : "",
			// Europe PMC files the archive under `publisher` -- "bioRxiv", "medRxiv",
			// "Research Square" -- sometimes at the top level and sometimes nested in
			// bookOrReportDetails, which `publisher` above already reconciles.
			preprintServer: isPreprint ? (publisher || "Preprint") : null,
			// Europe PMC records the journal version as a "Preprint of" cross-reference. It
			// identifies it by PMID, never by DOI -- the observed entry is
			// {source:"MED", id:"38289242", type:"Preprint of"} -- so that is what is kept.
			publishedPmid: isPreprint ? epmcPublishedPmid(r) : null,
			itemType: isPreprint ? "preprint" : "journalArticle"
		});
	}

	async function searchEuropePMC(q, http, ctx, preprintsOnly = false) {
		let query = epmcQuery(q, preprintsOnly);
		if (!query.trim()) return [];
		let sort = q.sort === "date" ? "&sort=" + enc("P_PDATE_D desc")
			: q.sort === "citations" ? "&sort=" + enc("CITED desc") : "";
		let max = q.maxResults || 200;
		let out = [];
		let cursor = "*", seen = 0;
		while (out.length < max) {
			throwIfCancelled(ctx);
			let pageSize = Math.min(100, max - out.length);
			let url = "https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core"
				+ "&pageSize=" + pageSize + "&cursorMark=" + enc(cursor) + sort + "&query=" + enc(query);
			let data = await withRetry(() => http.getJSON(url), {}, ctx);
			let items = data.resultList?.result || [];
			seen += items.length;
			for (let r of items) out.push(epmcRecord(r));
			let total = toInt(data.hitCount) ?? out.length;
			out = matchingRecords(dedupe(out), q);
			publishResults(out, q, ctx);
			ctx.onProgress?.(`${preprintsOnly ? "Preprints" : "Europe PMC"}: ${out.length} / ${Math.min(max, total)}`, out.length, Math.min(max, total));
			let next = data.nextCursorMark;
			// Local filtering can reject every row, so out.length alone never terminates the
			// walk. Stop after the same 10,000 rows OpenAlex and Crossref stop at.
			if (!items.length || !next || next === cursor || out.length >= total || seen >= PAGE_WALK_LIMIT) break;
			cursor = next;
		}
		return out.slice(0, max);
	}

	// ---------------------------------------------------------------- OSF Preprints
	// One API over the 32 archives OSF hosts -- PsyArXiv, SocArXiv, engrXiv, bioHackrXiv,
	// EcoEvoRxiv, EarthArXiv, PaleorXiv, Thesis Commons and the rest -- which nothing else
	// here indexes. Free, unmetered, no key. 201,549 postings at the time of writing.
	const OSF_PREPRINTS = "https://api.osf.io/v2/preprints/";
	// OSF returns the archive, the ordered author list and the DOI only as relationships.
	// Embedding them keeps a page of results to a single request instead of 1 + 2N.
	const OSF_EMBEDS = "&embed=provider&embed=bibliographic_contributors";

	function osfAuthors(item) {
		return (item.embeds?.bibliographic_contributors?.data || [])
			.slice()
			.sort((a, b) => (a.attributes?.index ?? 0) - (b.attributes?.index ?? 0))
			.map(c => {
				let user = c.embeds?.users?.data?.attributes;
				if (user?.family_name) {
					return fromFamilyGiven(user.family_name, [user.given_name, user.middle_names].filter(Boolean).join(" "));
				}
				return parseName(user?.full_name || c.attributes?.unregistered_contributor || "");
			})
			.filter(a => a.name);
	}

	function osfRecord(item) {
		let a = item.attributes || {};
		let provider = item.embeds?.provider?.data;
		let server = provider?.attributes?.name || provider?.id || "OSF Preprints";
		return makeRecord({
			source: "osf",
			sourceId: item.id,
			title: a.title || "",
			authors: osfAuthors(item),
			year: yearOf(a.date_published),
			publicationDate: (a.date_published || "").slice(0, 10) || null,
			venue: server,
			publisher: server,
			preprintServer: server,
			// attributes.doi is null even on postings that have one; the minted DOI is only
			// ever published as links.preprint_doi, e.g. https://doi.org/10.31235/osf.io/zn6c2_v1.
			doi: item.links?.preprint_doi || null,
			url: item.links?.html || null,
			// /download/ 302s to the file on files.osf.io, so the redirect is the PDF -- but
			// only where a file was ever attached. Offering the link regardless would hand
			// the preview pane a URL that 404s.
			pdfUrl: item.relationships?.primary_file ? "https://osf.io/download/" + item.id + "/" : null,
			citations: null,
			abstract: a.description || "",
			itemType: "preprint"
		});
	}

	async function searchOSF(q, http, ctx) {
		let filters = [];
		// filter[field] is a contiguous, case-insensitive substring test, not a term search:
		// filter[title]=protein engineering matched 0 of 201,549 postings while
		// filter[title,description] (OSF's OR over both fields) matched 31 for another phrase.
		// So a keyword query goes to both fields and only a title query is narrowed to one.
		if (q.title?.trim()) filters.push("filter[title]=" + enc(q.title.trim()));
		else if (q.keywords?.trim()) filters.push("filter[title,description]=" + enc(q.keywords.trim()));
		// OSF answered filter[contributors] with "not a filterable field", and there is no
		// other author route on /preprints/, so an author-only query has nothing to ask.
		if (!filters.length) return [];
		if (q.yearFrom) filters.push("filter[date_published][gte]=" + q.yearFrom + "-01-01");
		if (q.yearTo) filters.push("filter[date_published][lte]=" + q.yearTo + "-12-31");
		if (q.sort === "date") filters.push("sort=-date_published");

		let max = q.maxResults || 200;
		let out = [];
		let url = OSF_PREPRINTS + "?" + filters.join("&") + OSF_EMBEDS + "&page[size]=" + Math.min(100, max);
		let seen = 0;
		while (url && out.length < max) {
			throwIfCancelled(ctx);
			let data = await withRetry(() => http.getJSON(url), {}, ctx);
			let items = data.data || [];
			seen += items.length;
			for (let item of items) {
				// A withdrawn posting is still served, with its reason in
				// withdrawal_justification. Offering one would be offering a paper
				// that no longer exists; an item with no title is not a result at all.
				if (item?.attributes?.date_withdrawn || !item?.attributes?.title) continue;
				out.push(osfRecord(item));
			}
			let total = toInt(data.links?.meta?.total) ?? out.length;
			out = matchingRecords(dedupe(out), q);
			publishResults(out, q, ctx);
			ctx.onProgress?.(`OSF Preprints: ${out.length} / ${Math.min(max, total)}`, out.length, Math.min(max, total));
			url = items.length && seen < PAGE_WALK_LIMIT ? data.links?.next || null : null;
		}
		return out.slice(0, max);
	}

	// ---------------------------------------------------------------- preprints
	// The archives, merged. Europe PMC and Crossref both index bioRxiv, medRxiv and Research
	// Square, and they are kept together rather than deduplicated away because they do not
	// index the same thing: measured on 2026-09-18, Crossref held 439,123 bioRxiv postings
	// with the newest posted that same day, matching bioRxiv's own feed, while Europe PMC
	// held 349,948 with the newest three days old. Crossref also reaches ChemRxiv, SSRN,
	// Preprints.org and Authorea, which Europe PMC does not; Europe PMC supplies citation
	// counts and PMC full text, which Crossref does not. OSF adds its own 32 archives.
	async function searchPreprints(q, http, ctx) {
		return searchCombined(q, http, ctx, [
			{ key: "europepmc", search: (query, transport, context) => searchEuropePMC(query, transport, context, true) },
			{ key: "crossref", search: (query, transport, context) => searchCrossref(query, transport, context, true) },
			{ key: "arxiv", search: searchArxiv },
			{ key: "osf", search: searchOSF }
		], true);
	}

	// ---------------------------------------------------------------- Google Scholar (experimental)
	function gsQuery(q) {
		let parts = [];
		if (q.keywords?.trim()) parts.push(q.keywords.trim());
		// allintitle would also scope later author/source terms to the title.
		if (q.title?.trim()) parts.push(arxivFieldQuery(q.title, "intitle"));
		if (q.authors?.trim()) parts.push(Query.compileAuthors(q.authors, name => 'author:"' + name.replace(/"/g, "") + '"'));
		if (q.venue?.trim()) parts.push('source:"' + q.venue.trim() + '"');
		return parts.join(" ");
	}

	function parseScholarPage(html, DOMParserImpl) {
		let doc = new DOMParserImpl().parseFromString(html, "text/html");
		if (doc.querySelector("#gs_captcha_ccl, #captcha, form#gs_captcha_f, #recaptcha") || /Our systems have detected unusual traffic/i.test(html)) {
			let e = new Error("Google Scholar is asking for a CAPTCHA. Open scholar.google.com in Zotero (or a browser) and solve it, then retry.");
			e.captcha = true;
			throw e;
		}
		let recs = [];
		for (let div of doc.querySelectorAll(".gs_r.gs_or.gs_scl, .gs_r")) {
			let h3 = div.querySelector("h3.gs_rt");
			if (!h3) continue;
			let a = h3.querySelector("a");
			let title = (a ? a.textContent : h3.textContent).replace(/^\[[^\]]+\]\s*/, "").trim();
			if (!title) continue;
			let meta = div.querySelector(".gs_a")?.textContent || "";
			let segs = meta.split(/\s[-–]\s/);
			let authorsSeg = segs[0] || "";
			let venueSeg = segs[1] || "";
			let year = yearOf(venueSeg) || yearOf(meta);
			let venue = venueSeg.replace(/,?\s*\b(1[5-9]\d{2}|20\d{2})\b/, "").trim();
			let cites = null;
			for (let link of div.querySelectorAll(".gs_fl a")) {
				let m = link.textContent.match(/Cited by ([\d,]+)/i);
				if (m) { cites = parseInt(m[1].replace(/,/g, ""), 10); break; }
			}
			if (cites == null && /Cited by/i.test(div.textContent)) cites = 0;
			if (cites == null) cites = 0;
			let pdfA = div.querySelector(".gs_or_ggsm a, .gs_ggs a");
			let clusterId = (div.getAttribute("data-cid") || div.querySelector("[data-cid]")?.getAttribute("data-cid") || "").trim();
			recs.push(makeRecord({
				source: "scholar",
				sourceId: clusterId || title.toLowerCase(),
				title,
				abstract: div.querySelector(".gs_rs")?.textContent?.trim() || "",
				authors: authorsSeg.split(",").map(s => s.replace(/…|\.\.\./g, "").trim()).filter(s => s && !/^\d+$/.test(s)).map(parseName),
				year,
				venue,
				url: a?.getAttribute("href") || null,
				pdfUrl: pdfA?.getAttribute("href") || null,
				citations: cites,
				itemType: /arxiv|biorxiv|medrxiv|preprint/i.test(venueSeg) ? "preprint" : "journalArticle"
			}));
		}
		return recs;
	}

	async function searchScholar(q, http, ctx) {
		if (ctx.popSearch) {
			let max = q.maxResults || 200;
			// A large PoP query writes its JSON only on completion. Publish a small
			// initial batch so users can inspect papers while the complete set loads.
			let firstQuery = max > 50 ? Object.assign({}, q, { maxResults: 30 }) : q;
			let popContext = Object.assign({}, ctx, { recoveryMaxResults: max });
			let rows = await ctx.popSearch(firstQuery, popContext);
			if (rows !== null) {
				let records = normalizePoPRecords(rows);
				publishResults(records, q, ctx);
				if (!rows.partial && firstQuery !== q && rows.length >= firstQuery.maxResults) {
					throwIfCancelled(ctx);
					rows = await ctx.popSearch(q, popContext);
					if (!Array.isArray(rows)) throw new Error("Publish or Perish became unavailable while extending the search");
					records = normalizePoPRecords(rows);
					publishResults(records, q, ctx);
				}
				return records;
			}
		}
		if (typeof ctx.DOMParser !== "function") throw new Error("Google Scholar requires a DOM parser");
		let query = gsQuery(q);
		if (!query) return [];
		let max = q.maxResults || 100;
		let out = [];
		let start = 0;
		while (out.length < max) {
			throwIfCancelled(ctx);
			let url = "https://scholar.google.com/scholar?hl=en&as_sdt=0,5&num=20" + (q.sort === "date" ? "&scisbd=1" : "") + "&q=" + enc(query)
				+ (q.yearFrom ? "&as_ylo=" + q.yearFrom : "") + (q.yearTo ? "&as_yhi=" + q.yearTo : "") + "&start=" + start;
			let html = await http.getText(url, { "Accept-Language": "en-US,en;q=0.9" });
			let recs = parseScholarPage(html, ctx.DOMParser);
			if (!recs.length) break;
			out.push(...recs);
			publishResults(out, q, ctx);
			ctx.onProgress?.(`Google Scholar: ${out.length}`, out.length, max);
			if (recs.length < 10) break;
			start += recs.length;
			await sleep(2500 + Math.random() * 2000, ctx);
		}
		return out.slice(0, max);
	}

	function normalizePoPRecords(rows) {
		if (!Array.isArray(rows)) throw new Error("Invalid Publish or Perish result list");
		return rows.map(r => makeRecord({
			source: "scholar", sourceId: String(r.uid || "").replace(/^GS:/, ""), searchBackend: "publish-or-perish",
			title: r.title, authors: (r.authors || []).map(a => parseName(typeof a === "string" ? a : a.name)),
			year: toInt(r.year), venue: r.source || "", publisher: r.publisher || "", issn: r.issn || null,
			doi: r.doi || normalizeDOI(r.article_url), url: r.article_url || null,
			pdfUrl: /\.pdf(?:[?#]|$)|\/pdf(?:[/?#]|$)/i.test(r.fulltext_url || "") ? r.fulltext_url : null,
			citations: toInt(r.cites), abstract: r.abstract || "", volume: r.volume ? String(r.volume) : "",
			issue: r.issue ? String(r.issue) : "", pages: r.startpage ? String(r.startpage) + (r.endpage && r.endpage !== r.startpage ? "-" + r.endpage : "") : "",
			itemType: /preprint/i.test(r.type || "") ? "preprint" : /book/i.test(r.type || "") ? "book" : "journalArticle"
		}));
	}

	// ---------------------------------------------------------------- library proxy
	// Hosts that already serve open access; routing them through a campus proxy only
	// adds a redirect (and often an interstitial), so leave them alone.
	const OPEN_HOSTS = /(^|\.)(europepmc\.org|ncbi\.nlm\.nih\.gov|pmc\.ncbi\.nlm\.nih\.gov|arxiv\.org|biorxiv\.org|medrxiv\.org|osf\.io|zenodo\.org)$/i;

	function hostOf(url) {
		let m = String(url || "").match(/^https?:\/\/([^/?#]+)/i);
		return m ? m[1].replace(/:\d+$/, "") : "";
	}

	/**
	 * Wrap a URL in an institutional proxy.
	 * `prefix` is either a plain prefix the target is appended to
	 * (e.g. "https://access.yonsei.ac.kr/link.n2s?url=") or a template
	 * containing %URL%, in which case the target is percent-encoded.
	 */
	function proxify(url, prefix) {
		if (!url || !prefix) return null;
		if (url.startsWith(prefix)) return url;
		let proxyHost = hostOf(prefix);
		if (proxyHost && hostOf(url) === proxyHost) return url;
		return prefix.includes("%URL%") ? prefix.replace("%URL%", enc(url)) : prefix + url;
	}

	// Whether a URL was produced by proxify() for this prefix. A %URL% template rewrites the
	// target into the middle of the proxy URL, so a startsWith() test on the prefix is wrong.
	function viaProxy(url, prefix) {
		if (!url || !prefix) return false;
		if (!prefix.includes("%URL%")) return url.startsWith(prefix);
		let host = hostOf(prefix);
		return Boolean(host) && hostOf(url) === host;
	}

	function needsProxy(url) {
		let h = hostOf(url);
		return Boolean(h) && !OPEN_HOSTS.test(h);
	}

	// ---------------------------------------------------------------- PDF candidates
	async function unpaywallPDFs(doi, http, email) {
		if (!doi || !email) return [];
		try {
			let d = await http.getJSON("https://api.unpaywall.org/v2/" + enc(doi) + "?email=" + enc(email));
			let locs = [d.best_oa_location, ...(d.oa_locations || [])].filter(Boolean);
			return [...new Set(locs.map(l => l.url_for_pdf).filter(Boolean))];
		}
		catch (e) {
			return [];
		}
	}

	// Ordered list of URLs that may serve the full-text PDF for a record.
	// Free routes first; anything behind a paywall is retried through the library proxy.
	async function pdfCandidates(rec, http, ctx = {}) {
		let urls = [...(rec.pdfUrls || [])];
		if (rec.pmcid) urls.push("https://europepmc.org/articles/" + rec.pmcid + "?pdf=render");
		if (rec.arxiv) urls.push("https://arxiv.org/pdf/" + rec.arxiv);
		if (http) urls.push(...await unpaywallPDFs(rec.doi, http, ctx.email));
		let free = [...new Set(urls.filter(Boolean))];

		let prefix = (ctx.proxyPrefix || "").trim();
		if (!prefix) return free;
		let viaProxy = [];
		for (let u of free) if (needsProxy(u)) viaProxy.push(proxify(u, prefix));
		// The landing page / DOI resolver is what a campus proxy handles best: it lands on
		// the publisher's licensed article page, from which Zotero can pick up the PDF.
		if (rec.doi) viaProxy.push(proxify("https://doi.org/" + rec.doi, prefix));
		if (rec.url && needsProxy(rec.url)) viaProxy.push(proxify(rec.url, prefix));
		return [...new Set([...free, ...viaProxy].filter(Boolean))];
	}

	// The article page to open in a browser for a licensed read
	function proxyLandingURL(rec, prefix) {
		if (!prefix) return null;
		let target = rec.doi ? "https://doi.org/" + rec.doi : rec.url;
		return target ? proxify(target, prefix) : null;
	}

	// ---------------------------------------------------------------- merge / multi-source
	function identityKeys(r) {
		let keys = [];
		if (r.doi) keys.push("doi:" + r.doi);
		if (r.pmid) keys.push("pmid:" + r.pmid);
		if (r.pmcid) keys.push("pmcid:" + r.pmcid);
		if (r.arxiv) keys.push("arxiv:" + String(r.arxiv).replace(/v\d+$/, ""));
		if (r.source && r.sourceId) keys.push("source:" + r.source + ":" + r.sourceId);
		return keys;
	}

	function compatibleIdentity(a, b) {
		return !["doi", "pmid", "pmcid", "arxiv"].some(k => a[k] && b[k] && String(a[k]) !== String(b[k]));
	}

	function sameTitleWork(a, b, title) {
		if (!title || !compatibleIdentity(a, b)) return false;
		if (a.year && b.year && Math.abs(a.year - b.year) > 1) return false;
		let authorA = normalizedText(a.authors?.[0]?.lastName || a.authors?.[0]?.name);
		let authorB = normalizedText(b.authors?.[0]?.lastName || b.authors?.[0]?.name);
		if (authorA && authorB && authorA !== authorB) return false;
		// Generic titles (e.g. Introduction) need corroborating metadata.
		let generic = /^(editorial|editorial board|introduction|acknowledg(e)?ments|preface|foreword|contents|table of contents|references|abstract|summary|conclusion|conclusions|correction|erratum|corrigendum)$/i.test(title);
		if (generic && (!normalizedText(a.venue) || normalizedText(a.venue) !== normalizedText(b.venue))) return false;
		return (!generic && (title.length >= 24 || title.split(" ").length >= 3))
			|| Boolean(a.year && a.year === b.year && authorA && authorA === authorB);
	}

	function sortSearchResults(records, q, fused = false) {
		if (q.sort === "citations") return records.sort((a, b) => (b.citations ?? -1) - (a.citations ?? -1));
		if (q.sort === "date") {
			let date = r => r.publicationDate || (r.year ? String(r.year) : "");
			return records.sort((a, b) => date(a) < date(b) ? 1 : date(a) > date(b) ? -1 : 0);
		}
		let text = (q.title || q.keywords || "").trim();
		let exact = /\b(?:AND|OR|NOT|ANDNOT)\b|\w+:/.test(text) ? "" : normalizedText(text);
		// Native relevance scores have different scales. Fuse source ranks instead,
		// counting each source once, with no citation-count tie breaker.
		let score = r => Object.values(r.sourceRanks || {}).reduce((sum, rank) => sum + 1 / (60 + rank), 0);
		return records.sort((a, b) => {
			let match = r => exact && normalizedText(r.title) === exact ? 1 : 0;
			return match(b) - match(a) || (fused ? score(b) - score(a) : 0);
		});
	}

	// Fold b into a, keeping the richest field from either
	function mergeInto(a, b) {
		if (!a.title && b.title) a.title = b.title;
		if (!a.doi && b.doi) a.doi = b.doi;
		if (!a.pmid && b.pmid) a.pmid = b.pmid;
		if (!a.pmcid && b.pmcid) a.pmcid = b.pmcid;
		if (!a.arxiv && b.arxiv) a.arxiv = b.arxiv;
		if (!a.url && b.url) a.url = b.url;
		if (!a.year && b.year) a.year = b.year;
		if (!a.publicationDate && b.publicationDate) a.publicationDate = b.publicationDate;
		if (!a.venue && b.venue) a.venue = b.venue;
		if (!a.publisher && b.publisher) a.publisher = b.publisher;
		// The one source that knows a posting is on bioRxiv must not lose that when it merges
		// with a source that only knows the DOI, or the posting reads as a journal article.
		if (!a.preprintServer && b.preprintServer) a.preprintServer = b.preprintServer;
		if (!a.publishedDoi && b.publishedDoi) a.publishedDoi = b.publishedDoi;
		if (!a.publishedPmid && b.publishedPmid) a.publishedPmid = b.publishedPmid;
		if (!a.journalId && b.journalId) a.journalId = b.journalId;
		if (!a.issn && b.issn) a.issn = b.issn;
		if (a.journalIF == null && b.journalIF != null) { a.journalIF = b.journalIF; a.journalH = b.journalH; }
		if (!a.volume && b.volume) a.volume = b.volume;
		if (!a.issue && b.issue) a.issue = b.issue;
		if (!a.pages && b.pages) a.pages = b.pages;
		if ((b.abstract || "").length > (a.abstract || "").length) a.abstract = b.abstract;
		if ((b.authors || []).length > (a.authors || []).length) a.authors = b.authors;
		// The source that knows the labs and countries wins; a longer list of bare
		// affiliation strings is not a richer one.
		let placed = people => (people || []).some(p => p.institutionId || p.country);
		if (b.people && (!a.people || (placed(b.people) && !placed(a.people)))) a.people = b.people;
		if (b.citations != null && (a.citations == null || b.citations > a.citations)) {
			a.citations = b.citations;
			a.citationSource = b.citationSource || b.source;
		}
		for (let u of b.pdfUrls || []) if (!a.pdfUrls.includes(u)) a.pdfUrls.push(u);
		if (!a.pdfUrl && b.pdfUrl) a.pdfUrl = b.pdfUrl;
		for (let source of b.sources || [b.source]) if (source && !a.sources.includes(source)) a.sources.push(source);
		for (let [source, rank] of Object.entries(b.sourceRanks || {})) {
			a.sourceRanks[source] = Math.min(a.sourceRanks[source] ?? Infinity, rank);
		}
		return a;
	}

	function mergeRecords(lists) {
		let byID = new Map(), byTitle = new Map(), entries = [];
		let root = entry => { while (entry?.mergedInto) entry = entry.mergedInto; return entry; };
		for (let list of lists) {
			for (let [index, original] of list.entries()) {
				let r = Object.assign({}, original, {
					doi: normalizeDOI(original.doi),
					arxiv: original.arxiv ? String(original.arxiv).replace(/v\d+$/, "") : null,
					pdfUrls: [...(original.pdfUrls || [])], sources: [...(original.sources || [original.source])],
					sourceRanks: Object.assign({}, original.sourceRanks || { [original.source]: index + 1 })
				});
				let ids = identityKeys(r), title = normalizedText(r.title);
				let matches = [...new Set(ids.map(id => root(byID.get(id))).filter(e => e && compatibleIdentity(e.record, r)))];
				if (!matches.length && title) {
					let candidates = [...new Set((byTitle.get(title) || []).map(root))]
						.filter(e => sameTitleWork(e.record, r, title));
					// Do not guess which of several distinct same-title papers lacks a DOI.
					if (candidates.length === 1) matches = candidates;
				}
				let entry = matches[0];
				if (entry) {
					mergeInto(entry.record, r);
					for (let other of matches.slice(1)) {
						if (!compatibleIdentity(entry.record, other.record)) continue;
						mergeInto(entry.record, other.record);
						other.mergedInto = entry;
					}
				}
				else { entry = { record: r }; entries.push(entry); }
				for (let id of ids) byID.set(id, entry);
				if (title) {
					if (!byTitle.has(title)) byTitle.set(title, []);
					byTitle.get(title).push(entry);
				}
			}
		}
		return entries.filter(e => !e.mergedInto).map(e => e.record);
	}

	const MULTI_SOURCES = ["openalex", "crossref", "europepmc", "arxiv"];

	async function searchCombined(q, http, ctx, sources, preprintsOnly = false) {
		let lists = sources.map(() => []), errors = [], done = 0, succeeded = 0;
		let snapshot = () => {
			let records = matchingRecords(mergeRecords(lists), q);
			if (preprintsOnly) for (let r of records) r.itemType = "preprint";
			return sortSearchResults(records, q, true).slice(0, q.maxResults || 200);
		};
		let publish = () => publishResults(snapshot(), q, ctx);
		await Promise.allSettled(sources.map(async (source, index) => {
			let sub = Object.assign({}, ctx, {
				enrichCitations: false,
				onResults: records => { lists[index] = records; publish(); },
				onProgress: msg => ctx.onProgress?.(`${done}/${sources.length} · ${msg}`, done, sources.length)
			});
			try {
				lists[index] = await source.search(q, http, sub);
				succeeded++;
			}
			catch (e) {
				if (e.name !== "AbortError") {
					errors.push(`${SOURCES[source.key].label}: ${e.message}`);
					ctx.log?.(`Search source ${source.key} failed: ${e.message}`);
				}
			}
			finally {
				done++;
				publish();
				ctx.onProgress?.(`${done}/${sources.length}`, done, sources.length);
			}
		}));
		ctx.errors = errors;
		throwIfCancelled(ctx);
		if (!succeeded) throw Object.assign(new Error("All search sources failed: " + errors.join(" / ")), { errors });
		let merged = matchingRecords(mergeRecords(lists), q);
		if (preprintsOnly) for (let r of merged) r.itemType = "preprint";
		// Citation enrichment can change which records belong in the top N.
		// For relevance/date it cannot, so enrich only the chosen results there.
		if (q.sort !== "citations") merged = sortSearchResults(merged, q, true).slice(0, q.maxResults || 200);
		if (ctx.enrichCitations !== false) await enrichFromOpenAlex(merged, http, ctx);
		return sortSearchResults(merged, q, true).slice(0, q.maxResults || 200);
	}

	async function searchMulti(q, http, ctx) {
		return searchCombined(q, http, ctx, MULTI_SOURCES.map(key => ({ key, search: SOURCES[key].search })));
	}

	// ---------------------------------------------------------------- registry
	const SOURCES = {
		openalex: { label: "OpenAlex", search: searchOpenAlex, hasCitations: true },
		crossref: { label: "Crossref", search: searchCrossref, hasCitations: true },
		semanticscholar: { label: "Semantic Scholar", search: searchSemanticScholar, hasCitations: true },
		pubmed: { label: "PubMed", search: searchPubMed, hasCitations: false },
		europepmc: { label: "Europe PMC (articles + preprints)", search: searchEuropePMC, hasCitations: true },
		preprint: { label: "Preprints (bioRxiv, medRxiv, ChemRxiv, Research Square, arXiv, OSF)", search: searchPreprints, hasCitations: true },
		arxiv: { label: "arXiv", search: searchArxiv, hasCitations: false },
		osf: { label: "OSF Preprints (PsyArXiv, SocArXiv, engrXiv, bioHackrXiv, ...)", search: searchOSF, hasCitations: false },
		scholar: { label: "Google Scholar (experimental)", search: searchScholar, hasCitations: true }
	};
	SOURCES.multi = { label: "Combined (OpenAlex + Crossref + Europe PMC + arXiv)", search: searchMulti, hasCitations: true, multi: true };

	function dedupe(records) {
		return mergeRecords([records]);
	}

	async function search(sourceKey, query, http, ctx = {}) {
		let src = SOURCES[sourceKey];
		if (!src) throw new Error("Unknown source: " + sourceKey);
		throwIfCancelled(ctx);
		query = Object.assign({ sort: "relevance", maxResults: 200 }, query);
		for (let key of ["keywords", "title", "authors", "venue"]) query[key] = String(query[key] || "").trim();
		if (!hasAny(query)) return [];
		if (!Number.isInteger(query.maxResults) || query.maxResults < 1 || query.maxResults > 2000) throw new Error("Result limit must be an integer from 1 to 2000");
		for (let key of ["yearFrom", "yearTo"]) {
			if (query[key] === 0 || query[key] === "") query[key] = null;
			if (query[key] != null && query[key] !== "" && (!Number.isInteger(query[key]) || query[key] < 1500 || query[key] > 2100)) throw new Error("Invalid publication year");
		}
		if (query.yearFrom && query.yearTo && query.yearFrom > query.yearTo) throw new Error("Start year must not exceed end year");
		ctx.errors = [];
		const transport = {};
		for (let method of ["getJSON", "getText"]) transport[method] = async (url, headers = {}) => {
			throwIfCancelled(ctx);
			let onAbort;
			try {
				let request = Promise.resolve().then(() => { throwIfCancelled(ctx); return http[method](url, headers, ctx.signal); });
				if (!ctx.signal) return await request;
				let cancellation = new Promise((_, reject) => {
					onAbort = () => reject(abortError());
					ctx.signal.addEventListener("abort", onAbort, { once: true });
					if (ctx.signal.aborted) onAbort();
				});
				return await Promise.race([request, cancellation]);
			}
			finally { if (onAbort) ctx.signal.removeEventListener("abort", onAbort); }
		};
		let recs = matchingRecords(dedupe(await src.search(query, transport, ctx)), query);
		sortSearchResults(recs, query);
		recs = recs.slice(0, query.maxResults);
		publishResults(recs, query, ctx);
		if (ctx.journalMetrics !== false) await enrichJournalMetrics(recs, transport, ctx);
		if (ctx.institutionMetrics !== false) await enrichInstitutions(recs, transport, ctx);
		throwIfCancelled(ctx);
		publishResults(recs, query, ctx, true);
		return recs;
	}

	return {
		SOURCES, search, dedupe, mergeRecords, pubmedYear, searchableSurname, interleave, openAlexAbstract, isPlainAuthorQuery, openAlexAuthorFilter, openAlexAuth, isQuotaError, keywordTerms, matchesKeywords, proxify, needsProxy, viaProxy, proxyLandingURL, epmcQuery, normalizeDOI, parseName, resolveDOIByTitle, enrichFromOpenAlex, enrichJournalMetrics, enrichInstitutions, exportCaches, importCaches, checkCitations, journalStats, pdfCandidates,
		titleSimilarity, parseScholarPage, normalizePoPRecords, pubmedTerm, gsQuery, stripTags, decodeEntities
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPSources;

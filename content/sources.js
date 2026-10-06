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

	/* Every streamed page re-checks every record found so far, so one search normalised the same titles
	   and abstracts dozens of times. Each field is normalised once per search (keyed by the text itself,
	   which the copies a merge makes share) and the store is emptied when the search ends. */
	const FIELD_TEXT = new Map(), FIELD_TEXT_MAX = 40000;
	function normalizedField(value) {
		if (!value) return "";
		let held = FIELD_TEXT.get(value);
		if (held !== undefined) return held;
		held = normalizedText(value);
		if (FIELD_TEXT.size >= FIELD_TEXT_MAX) FIELD_TEXT.clear();
		FIELD_TEXT.set(value, held);
		return held;
	}

	function matchesKeywords(terms, record) {
		if (terms.length < 2) return true;
		// Title and abstract only. Matching the journal name is what let a fracture-mechanics
		// paper in on the word "engineering", and it is a weak signal for what a paper is about.
		// Read field by field: a term has no space in it, so it can never span the two.
		let hay = [normalizedField(record.title), normalizedField(record.abstract)].filter(Boolean).join(" ");
		if (!hay) return true;
		// One distinctive term is enough: this removes provider noise without second-guessing
		// which of the user's words the relevant paper happens to use.
		return terms.some(term => hay.includes(term));
	}

	function structuredQuery(value) { return /\b(?:AND|OR|NOT|ANDNOT)\b|["()]/.test(value || ""); }
	function positiveQueryTerms(value, wholeAtoms = false) {
		let tree = Query.parseExpression(value, wholeAtoms, wholeAtoms);
		if (!tree) throw new SyntaxError("Invalid search expression: check quotes, operators and parentheses");
		let terms = [];
		function visit(node, negative = false) {
			if (node.kind === "term") { if (!negative) terms.push(node.value); return; }
			if (node.kind === "NOT") visit(node.child, !negative);
			else { visit(node.left, negative); visit(node.right, negative); }
		}
		visit(tree);
		function anchored(node, negative = false) {
			if (node.kind === "term") return !negative;
			if (node.kind === "NOT") return anchored(node.child, !negative);
			let join = negative ? (node.kind === "AND" ? "OR" : "AND") : node.kind;
			return join === "OR" ? anchored(node.left, negative) && anchored(node.right, negative)
				: anchored(node.left, negative) || anchored(node.right, negative);
		}
		// An OR branch containing only exclusions has no positive seed. Restricting
		// it to another branch's term would lose legitimate matches silently.
		return anchored(tree) ? [...new Set(terms)] : [];
	}
	// OSF's API only has contiguous-substring filters. One necessary positive
	// atom per Boolean branch supplies a superset; the original expression is
	// then verified against the returned fields. Refuse an unbounded complement.
	function substringSeeds(value) {
		let tree = Query.parseExpression(value);
		if (!tree) throw new SyntaxError("Invalid search expression: check quotes, operators and parentheses");
		function clauses(node, negative = false) {
			if (node.kind === "term") return [[negative ? null : node.value]];
			if (node.kind === "NOT") return clauses(node.child, !negative);
			let left = clauses(node.left, negative), right = clauses(node.right, negative);
			let join = negative ? (node.kind === "AND" ? "OR" : "AND") : node.kind;
			if ((join === "OR" ? left.length + right.length : left.length * right.length) > 32) throw new RangeError("OSF search has too many Boolean alternatives");
			return join === "OR" ? [...left, ...right] : left.flatMap(a => right.map(b => [...a, ...b]));
		}
		let seeds = clauses(tree).map(clause => clause.filter(Boolean).sort((a, b) => b.length - a.length)[0]);
		if (seeds.some(seed => !seed)) throw new SyntaxError("OSF requires a positive term in every OR branch");
		return [...new Set(seeds)];
	}

	// Sources whose keyword match is made server-side over fields a result row may lack.
	// PubMed never returns an abstract in a search; for the others only a row with no abstract
	// at all is spared, so Crossref's journal-name noise is still removed.
	const ABSTRACT_OPTIONAL = new Set(["europepmc", "openalex", "semanticscholar", "arxiv", "osf"]);
	function serverMatchedUnseen(r) {
		if (r.source === "pubmed" || (!r.abstract && (r.sources || []).includes("pubmed"))) return true;
		return !r.abstract && ABSTRACT_OPTIONAL.has(r.source);
	}
	/* A journal picked from the list carries its ISSNs, and a record that carries ISSNs is its paper only when
	   one of them is the journal's: the Society's "Microbiology" (1350-0872) and Pleiades' (0026-2617) share a
	   name. A record without an ISSN, or a journal typed by name, is matched by name. */
	const issnKey = v => String(v || "").replace(/[^\dx]/gi, "").toLowerCase();
	function matchesPickedVenues(r, venues) {
		let mine = [r.issn, ...(r.issns || [])].map(issnKey).filter(Boolean);
		return venues.map(v => typeof v === "string" ? { name: v } : v || {}).some(v => Array.isArray(v.issns) && v.issns.length && mine.length ? v.issns.some(i => mine.includes(issnKey(i))) : Query.matchesVenue(v.name, r));
	}
	// The one journal a query names by its ISSNs, or null: what Europe PMC and PubMed are asked for instead of its name.
	const pickedByIssn = q => q.venues?.length === 1 && q.venues[0].issns?.length ? q.venues[0] : null;
	function matchingRecords(records, query = {}) {
		query = query || {};
		let venues = Query && Array.isArray(query.venues) && query.venues.length && query.venue ? query.venues : null;
		if (venues) query = Object.assign({}, query, { venue: "" });
		// Scholar's bylines/journal names are snippets and can be truncated. Its
		// fielded query has already constrained these fields; absence in a snippet
		// cannot disprove a match. Never fill that missing metadata from the query.
		// Scholar already constrains every field it was given, and its snippets are truncated,
		// so only the year range is re-checked there.
		let terms = keywordTerms(query.keywords);
		return records.filter(r => {
			if (!r) return false;
			// Scholar applied the year range itself, and a snippet without a year is not
			// evidence that the paper falls outside it.
			if (r.source === "scholar") return !Query || !r.year || Query.matchesRecord(r, { yearFrom: query.yearFrom, yearTo: query.yearTo });
			// A lookup was asked for one paper. Nothing else it returned is an answer,
			// and no other box narrows it.
			if (query.identifier) return recordHasIdentifier(r, query.identifier);
			if (Query && !Query.matchesRecord(r, query)) return false;
			if (venues && !matchesPickedVenues(r, venues)) return false;
			// The server matched on fields this record does not carry (PubMed's esummary has no
			// abstract, and its Text Word search reads abstract and MeSH). Absence is not evidence.
			if (serverMatchedUnseen(r)) return true;
			if (["crossref", "osf"].includes(r.source) && structuredQuery(query.keywords)
				&& !Query.matchesTitle(query.keywords, [r.title, r.abstract].filter(Boolean).join(" "))) return false;
			return matchesKeywords(terms, r);
		});
	}
	function warn(ctx, source, message) {
		let text = (SOURCES[source]?.label || source) + ": " + message;
		if (!ctx.errors) ctx.errors = [];
		if (!ctx.errors.includes(text)) ctx.errors.push(text);
	}
	function sourceStatus(ctx, source, details) {
		if (!ctx.sourceStatus) ctx.sourceStatus = {};
		ctx.sourceStatus[source] = Object.assign({}, ctx.sourceStatus[source], details);
	}
	function candidateLimit(ctx, source, retrieved, scanned, total, limit, exhausted) {
		let truncated = !exhausted && scanned >= PAGE_WALK_LIMIT && retrieved < limit;
		sourceStatus(ctx, source, { retrieved, scanned, total, limit, exhausted, truncated,
			reason: truncated ? "candidate-limit" : !exhausted && retrieved >= limit ? "result-limit" : null });
		if (truncated) warn(ctx, source, `Search stopped after ${PAGE_WALK_LIMIT} candidates; more matches may exist. Narrow the query.`);
	}
	function publishResults(records, query, ctx, final = false) {
		if (!ctx.onResults || ctx.signal?.aborted || ctx.isCancelled?.()) return;
		let snapshot = sortSearchResults(dedupe(records), query).slice(0, query.maxResults || 200);
		ctx.onResults(snapshot, { final, source: snapshot[0]?.source });
	}

	function stripTags(s) {
		if (!s) return "";
		let text = String(s);
		// Bibliographic titles also contain inequalities. Only remove actual paired markup.
		for (let i = 0; i < 8; i++) {
			let unwrapped = text.replace(/<([a-z][\w:-]*)(?:\s[^<>]*?)?>([\s\S]*?)<\/\1\s*>/gi, "$2");
			if (unwrapped === text) break;
			text = unwrapped;
		}
		return text.replace(/<br\s*\/?>/gi, " ").replace(/\s+/g, " ").trim();
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

	// A pasted identifier is not a phrase to search for. Crossref answered the query
	// "10.1038/s41467-020-19056-6" with 6,528,758 free-text candidates and kept paging
	// until it was rate-limited, while every source here can look that DOI up exactly.
	// Only a box holding nothing but the identifier counts: a title that happens to
	// contain one is still a title.
	function identifierQuery(q) {
		for (let field of ["keywords", "title"]) {
			let raw = String(q?.[field] || "").trim().replace(/[).,;]+$/, "");
			if (!raw || /\s/.test(raw)) continue;
			let doi = normalizeDOI(raw);
			if (doi) return { kind: "doi", value: doi, field };
			let pmc = /^(?:pmcid[:=]?)?(PMC\d{4,})$/i.exec(raw) || /pmc\/articles\/(PMC\d+)/i.exec(raw);
			if (pmc) return { kind: "pmcid", value: pmc[1].toUpperCase(), field };
			let arxiv = /^(?:arxiv[:=])?(\d{4}\.\d{4,5})(?:v\d+)?$/i.exec(raw)
				|| /arxiv\.org\/(?:abs|pdf)\/(.+?)(?:v\d+)?(?:\.pdf)?$/i.exec(raw)
				|| /^(?:arxiv[:=])?([a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i.exec(raw);
			if (arxiv) return { kind: "arxiv", value: arxiv[1], field };
			// An explicit PMID: prefix is the user saying so, whatever the length (PMIDs run from 1 to 9 digits);
			// bare digits count only at the 7-8 digits a modern PMID has.
			let pmid = /^pmid[:=]?(\d{1,9})$/i.exec(raw) || /^(\d{7,8})$/.exec(raw) || /pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i.exec(raw);
			if (pmid) return { kind: "pmid", value: pmid[1], field };
		}
		return null;
	}

	// The DOI arXiv registers for a posting, which is how OpenAlex and Crossref index it.
	function arxivDOI(id) { return "10.48550/arxiv." + String(id).toLowerCase(); }

	// A lookup answers with the record that carries the identifier, or with nothing.
	function recordHasIdentifier(r, id) {
		if (!id) return true;
		let same = (a, b) => Boolean(a) && String(a).toLowerCase() === String(b).toLowerCase();
		let bare = v => String(v || "").replace(/^arxiv:/i, "").replace(/v\d+$/i, "").toLowerCase();
		if (id.kind === "doi") return same(r.doi, id.value) || same(r.publishedDoi, id.value)
			|| (Boolean(r.arxiv) && same(arxivDOI(r.arxiv), id.value));
		if (id.kind === "pmid") return same(r.pmid, id.value) || same(r.publishedPmid, id.value);
		if (id.kind === "pmcid") return same(r.pmcid, id.value);
		if (id.kind === "arxiv") return bare(r.arxiv) === bare(id.value)
			|| bare(r.doi).replace("10.48550/arxiv.", "") === bare(id.value);
		return true;
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
				openalexId: openAlexId(a.author?.id),
				orcid: a.author?.orcid || a.raw_orcid || null,
				country: String(inst.country_code || (a.countries || [])[0] || "").toUpperCase() || null,
				institutionH: null
			};
		}).filter(p => p.name);
		return people.length ? people : null;
	}
	// A bare affiliation string, when the source has one at all. Null otherwise, so a
	// merge never trades OpenAlex's lab and country for a list of names alone.
	/* Europe PMC and Crossref copy the affiliation line as printed, with the author's e-mail at its end
	   ("...Tsinghua University, Beijing, China. pengjiang@tsinghua.edu.cn."): shown in the institution
	   column and written to the CSV as the lab's name. The address is not part of the institution. */
	const affiliationText = value => String(value == null ? "" : value)
		.replace(/\s*(?:Electronic address:\s*)?[^\s@,;()]+@[^\s@,;()]+?\.?(?=[\s,;)]|$)/gi, "")
		.replace(/\(\s*\)/g, "").replace(/\s*[,;]\s*$/, "").replace(/\s+\./g, ".").replace(/\s{2,}/g, " ").trim();
	function affiliatedPeople(entries) {
		let people = entries.filter(p => p.name).map(p => p.institution ? Object.assign(p, { institution: affiliationText(p.institution) }) : p);
		return people.some(p => p.institution) ? people : null;
	}

	function makeRecord(r) {
		let doi = normalizeDOI(r.doi);
		let rec = Object.assign({
			source: "", sourceId: "", title: "", authors: [], year: null, publicationDate: null, venue: "", publisher: "",
			doi: null, pmid: null, pmcid: null, arxiv: null, url: null, pdfUrl: null, pdfUrls: [], citations: null, citationSource: null, citesByYear: null, citesByYearSeen: null, sources: null,
			journalId: null, issn: null, journalIF: null, journalOA2y: null, journalH: null,
			preprintServer: null, publishedDoi: null, publishedPmid: null, people: null, retracted: false, authorsTruncated: false,
			volume: "", issue: "", pages: "", abstract: "", itemType: "journalArticle"
		}, r, { doi });
		rec.publishedDoi = normalizeDOI(rec.publishedDoi);
		// A preprint whose peer-reviewed version has the very DOI we are holding is not
		// "also published elsewhere"; it is that article, and claiming both would double it.
		if (rec.publishedDoi && rec.publishedDoi === rec.doi) rec.publishedDoi = null;
		// The title as the source wrote it, when it carries the inline markup
		// Zotero keeps in the field ("<i>Bacillus subtilis</i>"): drawn as
		// italics in the list and imported as is. rec.title stays plain for
		// matching and display where markup cannot be drawn.
		const decodedTitle = decodeEntities(rec.title);
		rec.titleMarkup = /<\/?(i|b|em|strong|sub|sup)>/i.test(String(decodedTitle)) ? String(decodedTitle).replace(/<(?!\/?(?:i|b|em|strong|sub|sup)>)[^>]*>/gi, "").replace(/\s+/g, " ").trim() : null;
		rec.title = stripTags(decodedTitle);
		rec.key = rec.source + ":" + (rec.sourceId || rec.doi
			|| [rec.title.toLowerCase(), rec.year || "", rec.authors?.[0]?.lastName || ""].join("|"));
		if (!rec.sources) rec.sources = [rec.source];
		if (rec.citations != null && !rec.citationSource) rec.citationSource = rec.source;
		if (!rec.url && rec.doi) rec.url = "https://doi.org/" + rec.doi;
		if (rec.pdfUrl && !rec.pdfUrls.includes(rec.pdfUrl)) rec.pdfUrls.unshift(rec.pdfUrl);
		rec.pdfUrls = rec.pdfUrls.filter(Boolean);
		return rec;
	}

	/* Retry-After is seconds or an HTTP date (RFC 9110). A date was read as NaN and the retry came 1.5 s later,
	   asking a server that had said when to come back. Milliseconds to wait, 0 when it says nothing usable. */
	function retryAfterMs(value, now = Date.now()) {
		if (value == null || value === "") return 0;
		let text = String(value).trim();
		if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 1000;
		let at = Date.parse(text);
		return Number.isFinite(at) ? Math.max(0, at - now) : 0;
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
				let transientTransport = e.status === 0
					|| /^(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(e.code || e.cause?.code || "")
					|| (e.name === "TypeError" && /fetch failed|failed to fetch|network request failed|networkerror/i.test(e.message || ""));
				// OpenAlex's refusal is remembered on the run, so the search's own request and every later enrichment agree it is spent.
				if (isQuotaError(e) && /openalex\.org/i.test(String(e.url || ""))) ctx.openAlexSpent = true;
				if (isQuotaError(e) || (!retryOn.includes(e.status) && !transientTransport) || i === tries - 1) throw e;
				// A provider that says how long to wait knows better than a fixed backoff.
				let asked = Math.min(retryAfterMs(e.retryAfter ?? e.headers?.["retry-after"] ?? e.headers?.["Retry-After"]), 30000);
				await sleep(Math.max(delay * (i + 1), asked), ctx);
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
		return Boolean(q.identifier || (q.keywords || "").trim() || (q.authors || "").trim() || (q.title || "").trim() || (q.venue || "").trim());
	}

	// ---------------------------------------------------------------- several journals in one query
	/* The window may pass `venues`: the journals a reader picked, [{ name, issns, openalexId }]. One journal
	   is just the venue box. Several are an OR: OpenAlex takes the whole list in one filter (resolved to its
	   source ids once and kept), every other source is asked once per journal and the answers are merged. */
	function normalizeVenues(list) {
		let out = [], seen = new Set();
		for (let v of Array.isArray(list) ? list : []) {
			let name = String(typeof v === "string" ? v : v?.name || "").replace(/\s+/g, " ").trim();
			let key = normalizedText(name);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			out.push({ name, issns: (typeof v === "object" && Array.isArray(v.issns) ? v.issns : []).map(i => String(i)).filter(Boolean), openalexId: typeof v === "object" && /^S\d+$/.test(v.openalexId || "") ? v.openalexId : null });
		}
		return out;
	}
	// What matches records of any of these journals: their names and ISSNs joined with OR (names quoted).
	function venueExpression(venues) {
		if (venues.length === 1) return venues[0].name;
		let terms = [];
		for (let v of venues) {
			terms.push('"' + v.name.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim() + '"');
			for (let issn of v.issns) if (!terms.includes(issn)) terms.push(issn);
		}
		return terms.join(" OR ");
	}
	const OPENALEX_SOURCE_IDS = new Map();
	// Journal -> OpenAlex source ids. A picked journal that carries its id costs nothing; one with ISSNs is
	// looked up in a single request for all of them; one with a name alone is searched as a single venue is.
	const sourceKey = v => normalizedText(v.name) + "|" + (v.issns || []).join(",");
	async function openAlexSourceIds(venues, http, ctx) {
		let ids = new Set(), byIssn = [], byName = [];
		for (let v of venues) {
			if (v.openalexId) { ids.add(v.openalexId); continue; }
			// Keyed by the ISSNs too: the Society's and Pleiades' "Microbiology" are one name and two journals.
			let held = OPENALEX_SOURCE_IDS.get(sourceKey(v));
			if (held) { for (let id of held) ids.add(id); continue; }
			(v.issns.length ? byIssn : byName).push(v);
		}
		if (byIssn.length) {
			let issns = [...new Set(byIssn.flatMap(v => v.issns))];
			let data = await withRetry(() => http.getJSON("https://api.openalex.org/sources?filter=issn:" + issns.map(enc).join("|") + "&select=id,display_name,issn&per-page=50" + openAlexAuth(ctx)), {}, ctx);
			let found = (data.results || []).map(x => ({ id: openAlexId(x.id), issns: (x.issn || []).map(String) })).filter(x => x.id);
			for (let v of byIssn) {
				let mine = found.filter(x => x.issns.some(i => v.issns.includes(i))).map(x => x.id);
				if (!mine.length) { byName.push(v); continue; }
				OPENALEX_SOURCE_IDS.set(sourceKey(v), mine);
				for (let id of mine) ids.add(id);
			}
		}
		for (let v of byName) {
			let data = await withRetry(() => http.getJSON("https://api.openalex.org/sources?search=" + enc(v.name) + "&per-page=5" + openAlexAuth(ctx)), {}, ctx);
			let candidates = data.results || [], name = normalizedText(v.name);
			let exact = candidates.filter(x => [x.display_name, x.abbreviated_title, ...(x.alternate_titles || [])].some(n => n && normalizedText(n) === name));
			let mine = (exact.length ? exact : candidates).map(x => openAlexId(x.id)).filter(Boolean);
			if (mine.length) OPENALEX_SOURCE_IDS.set(sourceKey(v), mine);
			for (let id of mine) ids.add(id);
		}
		return [...ids];
	}
	// A source that takes one journal at a time is asked once per journal and the answers are pooled.
	function perJournal(fn) {
		return async function (q, http, ctx) {
			if (!Array.isArray(q.venues) || q.venues.length < 2) return fn(q, http, ctx);
			let out = [], failed = null, report = ctx.onResults;
			for (let v of q.venues) {
				throwIfCancelled(ctx);
				/* Each journal's search streams only its own rows. Reported as they are, the second
				   journal's first page replaced the first journal's rows on screen, and a paper checked
				   there lost its checkmark. What is streamed is every journal so far plus this one. */
				if (report) ctx.onResults = (rows, info) => report(sortSearchResults(dedupe([...out, ...rows]), q).slice(0, q.maxResults || 200), info);
				try { out.push(...await fn(Object.assign({}, q, { venue: v.name, venues: [v] }), http, ctx)); }
				catch (e) { if (e.name === "AbortError") throw e; failed = failed || e; }
				finally { if (report) ctx.onResults = report; }
			}
			if (failed && !out.length) throw failed;
			if (failed) (ctx.errors || (ctx.errors = [])).push(failed.message);
			return out;
		};
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

	/* A typed journal or author is resolved to OpenAlex ids before the search itself, each time at the search
	   price ($0.001, ten filter lookups). The answer is kept for LOOKUP_TTL, so the same journal or author
	   searched again, or the same search run twice, pays for the search alone. A failed lookup is not kept. */
	const LOOKUP_TTL = 24 * 3600 * 1000, LOOKUP_MAX = 200;
	const OPENALEX_LOOKUPS = new Map();
	async function openAlexLookup(path, http, ctx, now = Date.now()) {
		let held = OPENALEX_LOOKUPS.get(path);
		if (held && now - held.at < LOOKUP_TTL) return held.data;
		let data = await withRetry(() => http.getJSON("https://api.openalex.org/" + path + openAlexAuth(ctx)), {}, ctx);
		OPENALEX_LOOKUPS.delete(path);
		if (OPENALEX_LOOKUPS.size >= LOOKUP_MAX) OPENALEX_LOOKUPS.delete(OPENALEX_LOOKUPS.keys().next().value);
		OPENALEX_LOOKUPS.set(path, { at: now, data });
		return data;
	}

	async function openAlexAuthorFilter(name, http, ctx) {
		let data = await openAlexLookup("authors?search=" + enc(name)
			+ "&per-page=25&select=id,display_name,display_name_alternatives,works_count,last_known_institutions", http, ctx);
		let ids = [], matched = [];
		if ((data.meta?.count || 0) > 25) warn(ctx, "openalex", "Only the first 25 author profiles were checked; use an OpenAlex author ID or ORCID to disambiguate.");
		for (let a of data.results || []) {
			let names = [a.display_name, ...(a.display_name_alternatives || [])].filter(Boolean);
			if (!names.some(n => Query.matchesAuthor(name, [{ name: n }]))) continue;
			let id = String(a.id || "").replace("https://openalex.org/", "");
			if (id) { ids.push(id); matched.push(a); }
			if (ids.length >= 25) break;
		}
		// Two people share a written name more often than not: "Jae Yoon Sung" resolved to a
		// battery researcher and a biotechnologist at once, and the mixed list looked like
		// one person's work. Name them so the difference is visible, not silently merged.
		if (matched.length > 1) {
			let who = matched.slice(0, 5).map(a => (a.display_name || "?")
				+ (a.last_known_institutions?.[0]?.display_name ? ", " + a.last_known_institutions[0].display_name : "")
				+ (a.works_count != null ? " (" + a.works_count + " works)" : ""));
			warn(ctx, "openalex", matched.length + " author profiles match this name and their papers are combined: "
				+ who.join("; ") + (matched.length > 5 ? "; and more" : "")
				+ ". Enter an ORCID or OpenAlex author ID to search one person.");
		}
		return ids.length ? "authorships.author.id:" + ids.join("|") : null;
	}

	// OpenAlex splits a filter list on "," and one filter's values on "|", after decoding
	// the query string, so neither character can survive inside a filter value: a title
	// holding a comma made the whole request a 403.
	function openAlexSearchValue(value) {
		return enc(String(value).replace(/[,|]+/g, " ").replace(/\s+/g, " ").trim());
	}

	function openAlexIdFilter(id) {
		if (id.kind === "pmid") return "pmid:" + id.value;
		if (id.kind === "pmcid") return "pmcid:" + id.value;
		return "doi:" + (id.kind === "arxiv" ? arxivDOI(id.value) : id.value);
	}

	async function searchOpenAlex(q, http, ctx) {
		// Spent for the day: refused here, before a request is sent, as OpenAlex would refuse it.
		if (ctx?.openAlexSpent) throw Object.assign(new Error("OpenAlex budget spent for today"), { status: 429, body: "Insufficient budget", url: "https://api.openalex.org/works" });
		let params = [];
		let filters = [];
		if (q.identifier) filters.push(openAlexIdFilter(q.identifier));
		if (q.keywords?.trim()) params.push("search=" + enc(q.keywords.trim()));
		if (q.title?.trim()) filters.push("title.search:" + openAlexSearchValue(q.title.trim()));
		if (q.authors?.trim()) {
			let identifier = Query.parseAuthorIdentifier(q.authors);
			let resolved = identifier ? (identifier.type === "openalex" ? "authorships.author.id:" : "authorships.author.orcid:") + enc(identifier.id) : null;
			if (!identifier && isPlainAuthorQuery(q.authors)) {
				try { resolved = await openAlexAuthorFilter(q.authors.trim(), http, ctx); }
				catch (e) {
					if (e.name === "AbortError" || isQuotaError(e)) throw e;
					ctx.log?.("OpenAlex author lookup failed, falling back to name search: " + e.message);
				}
			}
			filters.push(resolved || ("raw_author_name.search:" + openAlexSearchValue(Query.compileAuthors(q.authors,
				name => '"' + searchableSurname(name).replace(/"/g, "") + '"'))));
		}
		if (q.yearFrom) filters.push("from_publication_date:" + q.yearFrom + "-01-01");
		if (q.yearTo) filters.push("to_publication_date:" + q.yearTo + "-12-31");
		// One journal picked from the list carries its ISSNs (or OpenAlex id): they name it exactly, where a name
		// search took every journal of that title.
		if (q.venues?.length > 1 || q.venues?.[0]?.issns?.length || q.venues?.[0]?.openalexId) {
			let ids = await openAlexSourceIds(q.venues, http, ctx);
			if (!ids.length) return [];
			filters.push("primary_location.source.id:" + ids.join("|"));
		}
		else if (q.venue?.trim()) {
			// Resolve the venue to an OpenAlex source id first
			let s = await openAlexLookup("sources?search=" + enc(q.venue.trim()) + "&per-page=5", http, ctx);
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
		params.push("select=id,doi,title,display_name,publication_year,publication_date,type,authorships,primary_location,biblio,cited_by_count,counts_by_year,open_access,best_oa_location,locations,abstract_inverted_index,ids,is_retracted,is_authors_truncated");

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
					authors: (w.authorships || []).map(a => Object.assign(parseName(a.author?.display_name || a.raw_author_name), {
						openalexId: openAlexId(a.author?.id), orcid: a.author?.orcid || a.raw_orcid || null
					})),
					people: openAlexPeople(w.authorships),
					year: w.publication_year || null,
					publicationDate: w.publication_date || null,
					venue: src.display_name || "",
					publisher: src.host_organization_name || "",
					journalId: src.id ? src.id.replace("https://openalex.org/", "") : null,
					issn: src.issn_l || (src.issn || [])[0] || null,
					// Every ISSN the journal has: the ISSN-L is often the print number, and the JCR may list only the other one.
					issns: [...new Set([src.issn_l, ...(src.issn || [])].filter(Boolean))],
					doi: w.doi,
					pmid: ids.pmid ? String(ids.pmid).replace(/.*\//, "") : null,
					pmcid: pmcidFromOpenAlex(w),
					url: loc.landing_page_url || w.doi || null,
					pdfUrl: w.best_oa_location?.pdf_url || w.open_access?.oa_url || null,
					pdfUrls: (w.locations || []).filter(l => l.is_oa && l.pdf_url).map(l => l.pdf_url),
					citations: toInt(w.cited_by_count),
					citesByYear: parseCountsByYear(w.counts_by_year),
					citesByYearSeen: w.counts_by_year ? seriesSeen() : null,
					volume: w.biblio?.volume || "",
					issue: w.biblio?.issue || "",
					pages: w.biblio?.first_page ? (w.biblio.last_page && w.biblio.last_page !== w.biblio.first_page ? w.biblio.first_page + "-" + w.biblio.last_page : w.biblio.first_page) : "",
					abstract: openAlexAbstract(w.abstract_inverted_index),
					itemType: OPENALEX_TYPES[w.type] || "journalArticle",
					// OpenAlex says "review" where itemType has only articles: kept for the results filter.
					workType: w.type || null,
					retracted: w.is_retracted === true && w.type !== "retraction",
					authorsTruncated: w.is_authors_truncated === true
				}));
			}
			seen += results.length;
			out = matchingRecords(dedupe(out), q);
			publishResults(out, q, ctx);
			ctx.onProgress?.(`OpenAlex: ${out.length} / ${Math.min(max, data.meta?.count ?? max)}`, out.length, Math.min(max, data.meta?.count ?? max));
			let exhausted = results.length < perPage || (data.meta?.count != null && seen >= data.meta.count);
			candidateLimit(ctx, "openalex", out.length, seen, data.meta?.count ?? null, max, exhausted);
			if (exhausted || seen >= PAGE_WALK_LIMIT) break;
			page++;
		}
		return out.slice(0, max);
	}

	/* Batch-lookup citation counts (and OA PDFs) by DOI from OpenAlex. Mutates records.
	   By default only records without a count are asked about. `complete` asks about every record OpenAlex did
	   not itself return, too: a Crossref or Europe PMC row came with that index's count and nothing else, so
	   it had no yearly citations, no OpenAlex retraction check and no institutions or tier -- nine of the
	   twenty rows of a Nature Microbiology 2025 search. Their own count is kept beside OpenAlex's
	   (citationsBy), and the higher one is the headline, as when the two indexes' records merge. */
	const ASKED = new WeakSet();
	const placedPeople = people => (people || []).some(p => p.institutionId || p.country);
	/* The labs of a placed list (OpenAlex's) laid over a record's own people. A list at least as long replaces
	   it, as before. A shorter one (OpenAlex stops at 100 authorships) never cuts the byline: each person keeps
	   their place, a matching name takes the placed lab where it has one, and the rest keep what their source said. */
	const surnameOf = name => String(name || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().split(/[\s,]+/).filter(Boolean).pop() || "";
	function overlayPeople(own, placed) {
		if (!own?.length || placed.length >= own.length) return placed;
		let used = new Set();
		return own.map((p, i) => {
			let j = placed[i] && !used.has(i) && surnameOf(placed[i].name) === surnameOf(p.name) ? i
				: placed.findIndex((q, k) => !used.has(k) && surnameOf(q.name) === surnameOf(p.name));
			if (j < 0) return p;
			used.add(j);
			let q = placed[j];
			return q.institutionId || q.country
				? { ...p, institution: q.institution || p.institution, institutionId: q.institutionId, country: q.country, institutionH: q.institutionH ?? p.institutionH ?? null,
					openalexId: q.openalexId || p.openalexId || null, orcid: p.orcid || q.orcid || null, corresponding: Boolean(p.corresponding || q.corresponding) }
				: p;
		});
	}
	async function enrichFromOpenAlex(records, http, ctx, { complete = false } = {}) {
		// Several records can legitimately share a DOI: compatibleIdentity keeps copies apart
		// when their other identifiers conflict. Keyed one-per-DOI, all but the last lost
		// their citation count and OA links.
		let byDoi = new Map();
		for (let r of records) {
			if (!r.doi || ASKED.has(r)) continue;
			let fromOpenAlex = (r.sources || [r.source]).includes("openalex");
			if (r.citations != null && !(complete && !fromOpenAlex)) continue;
			if (!byDoi.has(r.doi)) byDoi.set(r.doi, []);
			byDoi.get(r.doi).push(r);
		}
		let dois = [...byDoi.keys()];
		for (let i = 0; i < dois.length; i += 50) {
			throwIfCancelled(ctx);
			if (ctx.openAlexSpent) break;
			let chunk = dois.slice(i, i + 50);
			let url = "https://api.openalex.org/works?filter=doi:" + chunk.map(enc).join("|") + "&per-page=50&select=doi,ids,cited_by_count,counts_by_year,best_oa_location,open_access,locations,is_retracted,type,authorships" + openAlexAuth(ctx);
			try {
				let data = await withRetry(() => http.getJSON(url), {}, ctx);
				for (let doi of chunk) for (let r of byDoi.get(doi) || []) ASKED.add(r);
				for (let w of data.results || []) {
					for (let r of byDoi.get(normalizeDOI(w.doi)) || []) {
						let count = toInt(w.cited_by_count);
						if (r.citations == null) {
							r.citations = count;
							if (r.citations != null) r.citationSource = "openalex";
						}
						else if (count != null) {
							let by = r.citationsBy || (r.citationsBy = {}), own = r.citationSource || r.source;
							if (own && by[own] == null) by[own] = Number(r.citations);
							if (by.openalex == null || count > by.openalex) by.openalex = count;
							if (count > r.citations) { r.citations = count; r.citationSource = "openalex"; }
						}
						if (w.is_retracted === true && (w.type || r.workType) !== "retraction") r.retracted = true;
						if (!r.workType && w.type) r.workType = w.type;
						if (!r.citesByYear) { r.citesByYear = parseCountsByYear(w.counts_by_year); if (r.citesByYear) r.citesByYearSeen = seriesSeen(); }
						// The labs and countries, where the record's own source named none.
						if (!placedPeople(r.people)) { let people = openAlexPeople(w.authorships); if (placedPeople(people)) r.people = overlayPeople(r.people, people); }
						if (!r.pdfUrl) r.pdfUrl = w.best_oa_location?.pdf_url || w.open_access?.oa_url || null;
						for (let l of w.locations || []) if (l.is_oa && l.pdf_url && !r.pdfUrls.includes(l.pdf_url)) r.pdfUrls.push(l.pdf_url);
						if (r.pdfUrl && !r.pdfUrls.includes(r.pdfUrl)) r.pdfUrls.unshift(r.pdfUrl);
						if (!r.pmcid) r.pmcid = pmcidFromOpenAlex(w);
					}
				}
			}
			catch (e) {
				if (e.name === "AbortError") throw e;
				// A spent budget is not asked again in this run: each further request would only be refused.
				if (isQuotaError(e)) ctx.openAlexSpent = true;
				ctx.log?.("OpenAlex enrichment failed: " + e.message);
				// Otherwise the citation column is simply blank, with nothing said.
				warn(ctx, "openalex", "Citation counts are unavailable: " + e.message);
			}
			ctx.onProgress?.(`Citation counts: ${Math.min(i + 50, dois.length)} / ${dois.length}`, i + 50, dois.length);
		}
		return records;
	}

	/* The works one paper cites, for "this paper cites n of my papers": one request
	   (select=referenced_works), remembered for a day, never made once the budget is spent.
	   Resolves { ok, cached, id: "W1", ids: ["W123", ...] } or { ok: false, reason: "id" | "budget" | "failed" }. */
	const REF_TTL = 24 * 3600 * 1000, REF_CACHE_MAX = 300;
	const REF_CACHE = new Map();
	async function fetchReferencedWorks(rec, http, ctx = {}, now = Date.now()) {
		let path = openAlexWorkPath(rec);
		if (!path) return { ok: false, reason: "id" };
		let hit = REF_CACHE.get(path);
		if (hit && now - hit.at < REF_TTL) return { ok: true, cached: true, id: hit.id, ids: hit.ids };
		if (ctx.openAlexSpent) return { ok: false, reason: "budget" };
		try {
			let w = await withRetry(() => http.getJSON("https://api.openalex.org/works/" + path + "?select=id,referenced_works" + openAlexAuth(ctx)), {}, ctx);
			let ids = (Array.isArray(w?.referenced_works) ? w.referenced_works : []).map(openAlexId).filter(Boolean);
			if (REF_CACHE.size >= REF_CACHE_MAX) REF_CACHE.delete(REF_CACHE.keys().next().value);
			let id = openAlexId(w?.id);
			REF_CACHE.set(path, { id, ids, at: now });
			return { ok: true, cached: false, id, ids };
		}
		catch (e) {
			if (e.name === "AbortError") throw e;
			if (isQuotaError(e)) { ctx.openAlexSpent = true; return { ok: false, reason: "budget", message: e.message }; }
			ctx.log?.("OpenAlex references failed: " + e.message);
			return { ok: false, reason: "failed", message: e.message };
		}
	}

	// ---------------------------------------------------------------- journal metrics
	// OpenAlex publishes a 2-year mean citedness per source: the Journal Impact Factor
	// formula computed over OpenAlex's open citation graph. Free, no key needed.
	/* Each answer remembers when it was had. The snapshot on disk was read back
	   whole whatever its age, so a journal's figure from years ago, or a "not
	   found" from one bad day, was used for good. */
	const CACHE_TTL = { found: 180 * 86400000, missing: 30 * 86400000 };
	// The age is checked on every read, not only when the file is loaded: a window left open for weeks keeps asking.
	class TimedMap extends Map {
		set(key, value) { (this.times ||= new Map()).set(key, Date.now()); return super.set(key, value); }
		setAt(key, value, at) { super.set(key, value); (this.times ||= new Map()).set(key, at); return this; }
		at(key) { return this.times?.get(key) ?? null; }
		expired(key) {
			let at = this.at(key);
			if (at == null || !super.has(key)) return false;
			return Date.now() - at > (super.get(key) === null ? CACHE_TTL.missing : CACHE_TTL.found);
		}
		has(key) { if (this.expired(key)) { this.delete(key); this.times.delete(key); return false; } return super.has(key); }
		get(key) { return this.has(key) ? super.get(key) : undefined; }
	}
	const JOURNAL_CACHE = new TimedMap(); // "S123" | "issn:0028-0836" -> stats | null

	function journalStats(s) {
		let ss = s.summary_stats || {};
		return {
			id: (s.id || "").replace("https://openalex.org/", ""),
			name: s.display_name || "",
			issn: s.issn_l || (s.issn || [])[0] || null,
			/* Exactly 0 is what OpenAlex gives a title that published nothing in the last two years (Biotechnology
			   for Biofuels, renamed in 2022; Biotechnology Techniques, closed in 1999): no articles to average, not
			   an average of nothing cited. Shown as 0.0 it ranked those journals as the least cited of all. */
			if2y: Number.isFinite(ss["2yr_mean_citedness"]) && ss["2yr_mean_citedness"] > 0 ? ss["2yr_mean_citedness"] : null,
			abbrev: s.abbreviated_title || null,
			// "journal", "conference", "book series" -- or "repository" and "ebook platform", which are not journals.
			kind: s.type || null,
			h: toInt(ss.h_index),
			works: toInt(s.works_count),
			oa: Boolean(s.is_oa),
			doaj: Boolean(s.is_in_doaj)
		};
	}

	/* OpenAlex keeps a 2-year mean and an h-index for every source, including preprint servers, institutional
	   repositories and ebook platforms: bioRxiv read "~0.93", The University of Queensland's repository "~0.09"
	   and "Springer eBooks" "~0.45" in the journal column, as if they were journals' figures. A posting, and
	   anything hosted on a source that is not a journal, gets none. */
	const NOT_JOURNALS = new Set(["repository", "ebook platform"]);
	const journalFigureFor = (r, st) => !(r.itemType === "preprint" || r.preprintServer || NOT_JOURNALS.has(st.kind));
	function applyJournal(r, st) {
		if (!st) return;
		if (!journalFigureFor(r, st)) {
			r.journalOA2y = null; r.journalH = null;
			if (!r.journalId) r.journalId = st.id;
			return;
		}
		// OpenAlex's 2-year mean citedness is its own figure, kept apart from the JCR's Journal Impact Factor
		// (journalIF), which only the JCR table fills. The two are never mixed in one field.
		r.journalOA2y = st.if2y;
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

	// Fill journalIF (JCR) / journalOA2y / journalH on records from their OpenAlex source id, ISSN or, failing
	// both, the journal's name. Mutates records.
	async function enrichJournalMetrics(records, http, ctx = {}) {
		const SELECT = "select=id,display_name,type,issn_l,issn,summary_stats,works_count,is_oa,is_in_doaj,abbreviated_title,alternate_titles";
		let mailto = openAlexAuth(ctx);
		// The Journal Impact Factor itself first, from the JCR table shipped with the
		// plugin. OpenAlex is then asked only for the journal's h-index and for an
		// estimate where the JCR does not list the journal.
		if (JCR && ctx.jcr !== false) JCR.apply(records);
		let byId = new Map(), byIssn = new Map(), byName = new Map();
		for (let r of records) {
			if (r.journalOA2y != null && r.journalH != null) continue;
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
				if (ctx.openAlexSpent) break;
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
					// A spent budget is not asked again in this run: each further request would only be refused.
					if (isQuotaError(e)) ctx.openAlexSpent = true;
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
			if (ctx.openAlexSpent) break;
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
				// A spent budget is not asked again in this run: each further request would only be refused.
				if (isQuotaError(e)) ctx.openAlexSpent = true;
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
	const INSTITUTION_CACHE = new TimedMap(); // "I123" -> { id, name, country, hIndex } | null

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
			if (ctx.openAlexSpent) break;
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
				// A spent budget is not asked again in this run: each further request would only be refused.
				if (isQuotaError(e)) ctx.openAlexSpent = true;
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
		let tail = map => [...map.entries()].slice(-CACHE_EXPORT_LIMIT).map(([key, value]) => [key, value, map.at(key) ?? Date.now()]);
		return { version: 1, savedAt: new Date().toISOString(), journals: tail(JOURNAL_CACHE), institutions: tail(INSTITUTION_CACHE) };
	}
	function importCaches(snapshot, now = Date.now()) {
		if (!snapshot || snapshot.version !== 1) return 0;
		let n = 0, saved = Date.parse(snapshot.savedAt || "") || 0;
		for (let [map, entries] of [[JOURNAL_CACHE, snapshot.journals], [INSTITUTION_CACHE, snapshot.institutions]]) {
			for (let entry of Array.isArray(entries) ? entries : []) {
				if (!Array.isArray(entry) || typeof entry[0] !== "string" || map.has(entry[0])) continue;
				if (entry[1] !== null && (typeof entry[1] !== "object" || Array.isArray(entry[1]))) continue;
				// A journal answer saved before the source's type was kept cannot tell bioRxiv from a journal: asked again once.
				if (map === JOURNAL_CACHE && entry[1] !== null && !("kind" in entry[1])) continue;
				// An answer past its age is asked again; "not found" ages faster than a figure.
				let at = Number.isFinite(entry[2]) ? entry[2] : saved;
				if (now - at > (entry[1] === null ? CACHE_TTL.missing : CACHE_TTL.found)) continue;
				map.setAt(entry[0], entry[1], at);
				n++;
			}
		}
		return n;
	}

	/* OpenAlex's counts_by_year: [{ year, cited_by_count }], the last ten or so years, zero years left out.
	   Kept as [{ year, n }] ascending; anything malformed is dropped, an empty answer is null (unknown). */
	/* When a yearly series was read and the years it covers (OpenAlex lists ten calendar years, the current one
	   running): kept beside the series, so a saved search reopened later shows the years since as unknown, not
	   zero. The same shape as ZotPoPCite.seriesSeen. */
	function seriesSeen(at = Date.now()) {
		let to = new Date(at).getFullYear();
		return { at, from: to - 9, to };
	}
	function parseCountsByYear(list) {
		if (!Array.isArray(list)) return null;
		let byYear = new Map();
		for (let e of list) {
			let year = toInt(e?.year), n = toInt(e?.cited_by_count ?? e?.n);
			if (year == null || n == null || year < 1900 || year > 2200 || n < 0) continue;
			byYear.set(year, n);
		}
		return byYear.size ? [...byYear].sort((a, b) => a[0] - b[0]).map(([year, n]) => ({ year, n })) : null;
	}

	/* One paper's current count and yearly counts from OpenAlex: a single request, remembered for six hours
	   so reopening the card costs nothing, and never made once the budget is spent. The paper is found by
	   DOI, else its OpenAlex id, else PMID. Resolves { ok, cached, citations, citesByYear, at } or
	   { ok: false, reason: "id" | "budget" | "failed", message }. */
	const WORK_TTL = 6 * 3600 * 1000, WORK_CACHE_MAX = 500;
	const WORK_CACHE = new Map();
	function openAlexWorkPath(rec) {
		let doi = normalizeDOI(rec.doi);
		if (doi) return "doi:" + enc(doi);
		if (rec.source === "openalex" && /^W\d+$/.test(rec.sourceId || "")) return rec.sourceId;
		if (rec.pmid && /^\d+$/.test(String(rec.pmid))) return "pmid:" + rec.pmid;
		return null;
	}
	async function refreshOpenAlexWork(rec, http, ctx = {}, now = Date.now()) {
		let path = openAlexWorkPath(rec);
		if (!path) return { ok: false, reason: "id" };
		let hit = WORK_CACHE.get(path);
		if (hit && now - hit.at < WORK_TTL) return Object.assign({ ok: true, cached: true }, hit);
		if (ctx.openAlexSpent) return { ok: false, reason: "budget" };
		try {
			let w = await withRetry(() => http.getJSON("https://api.openalex.org/works/" + path + "?select=id,cited_by_count,counts_by_year" + openAlexAuth(ctx)), {}, ctx);
			let got = { citations: toInt(w.cited_by_count), citesByYear: parseCountsByYear(w.counts_by_year), citesByYearSeen: seriesSeen(now), at: now };
			if (got.citations == null) return { ok: false, reason: "failed", message: "no count in the answer" };
			if (WORK_CACHE.size >= WORK_CACHE_MAX) WORK_CACHE.delete(WORK_CACHE.keys().next().value);
			WORK_CACHE.set(path, got);
			return Object.assign({ ok: true, cached: false }, got);
		}
		catch (e) {
			if (e.name === "AbortError") throw e;
			if (isQuotaError(e)) { ctx.openAlexSpent = true; return { ok: false, reason: "budget", message: e.message }; }
			ctx.log?.("OpenAlex work refresh failed: " + e.message);
			return { ok: false, reason: "failed", message: e.message };
		}
	}

	// Live citation counts for one record from every free source that knows it.
	// Returns { openalex, crossref, semanticscholar } (null = not found) and updates rec
	// with the highest count plus its journal's impact.
	async function checkCitations(rec, http, ctx = {}) {
		let doi = rec.doi;
		let auth = openAlexAuth(ctx);
		let mailto = ctx.email ? "mailto=" + enc(ctx.email) : "";
		let out = { openalex: null, crossref: null, semanticscholar: null };
		let tasks = [];
		if (doi) {
			// A spent OpenAlex budget is not asked again in this window; Crossref still answers.
			if (!ctx.openAlexSpent) tasks.push(withRetry(() => http.getJSON("https://api.openalex.org/works/doi:" + enc(doi) + "?select=cited_by_count,primary_location" + auth), {}, ctx).then(w => {
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
			if (!ctx.openAlexSpent) tasks.push(withRetry(() => http.getJSON("https://api.openalex.org/works/" + enc(rec.sourceId) + "?select=cited_by_count" + auth), {}, ctx).then(w => {
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
		// Each index's fresh count replaces its old one, so a statistic read from one index sees the re-check.
		for (let [k, v] of Object.entries(out)) if (v != null) (rec.citationsBy ||= {})[k] = v;
		if (rec.journalOA2y == null && (rec.journalId || rec.issn)) await enrichJournalMetrics([rec], http, ctx);
		return out;
	}

	// ---------------------------------------------------------------- Crossref
	const CROSSREF_TYPES = {
		"journal-article": "journalArticle", "proceedings-article": "conferencePaper", "posted-content": "preprint",
		book: "book", monograph: "book", "edited-book": "book", "book-chapter": "bookSection", dissertation: "thesis", report: "report"
	};
	// Kinds of item that are not papers, whichever index says so.
	const NOTICE_TYPES = new Set(["paratext", "erratum", "editorial", "peer-review", "dataset", "retraction", "standard", "reference-entry", "supplementary-materials", "grant"]);
	const CROSSREF_NOT_PAPERS = new Set(["standard", "dataset", "peer-review", "grant", "reference-entry"]);
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
		for (let [field, parameter] of [["keywords", "query"], ["title", "query.bibliographic"], ["authors", "query.author"]]) {
			if (!q[field]?.trim()) continue;
			if (field === "keywords" && /\w+:|\[[^\]]+\]/.test(q[field])) throw new Error("Crossref does not support native field tags in keywords; use the title, author and journal boxes");
			let terms = positiveQueryTerms(q[field], field === "authors");
			if (terms.length) params.push(parameter + "=" + enc(terms.join(" ")));
			if (field === "keywords" && structuredQuery(q[field])) warn(ctx, "crossref", "Boolean and phrase keyword checks use deposited titles and abstracts; missing metadata can limit coverage.");
		}
		let filters = [];
		if (q.identifier) {
			// Crossref indexes DOIs, and an arXiv posting has one it registered itself.
			if (!["doi", "arxiv"].includes(q.identifier.kind)) {
				warn(ctx, "crossref", "Crossref cannot look up a " + q.identifier.kind.toUpperCase() + "; use OpenAlex, PubMed or Europe PMC for that identifier.");
				return [];
			}
			filters.push("doi:" + (q.identifier.kind === "arxiv" ? arxivDOI(q.identifier.value) : q.identifier.value));
		}
		// "posted-content" is Crossref's type for a preprint posting. It is the whole preprint
		// landscape in one index -- bioRxiv, ChemRxiv, Research Square, SSRN, Preprints.org --
		// and it carries the posting date, so it is what makes the archives searchable here.
		if (preprintsOnly) filters.push("type:posted-content");
		// A posting has no container-title and no ISSN, so both of Crossref's venue routes
		// return nothing for one. On this route the venue names the archive instead, which
		// is held in the record and matched locally below.
		if (q.venue?.trim() && !preprintsOnly) {
			// A journal picked from the list is named by its ISSN; only a typed name is looked up.
			let picked = q.venues?.length === 1 && q.venues[0].issns?.length ? q.venues[0] : null;
			journal = picked ? { issn: picked.issns[0], title: picked.name } : await crossrefJournal(q.venue.trim(), http, ctx);
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
		if (!preprintsOnly) params.push("select=DOI,title,author,issued,posted,relation,resource,published,published-print,published-online,container-title,publisher,is-referenced-by-count,volume,issue,page,URL,type,abstract,link,ISSN");

		let max = q.maxResults || 200;
		let out = [];
		let offset = 0;
		while (out.length < max) {
			throwIfCancelled(ctx);
			// Crossref serves 1000 rows a page. Asking for 100 made a large search ten
			// times as many requests, and ten times as likely to be rate-limited.
			// A fixed page: asking only for the rows still missing shrank the page each time the local
			// check dropped some ("Pablo I. Nikel": 90, 20, 12, 7, 4, 2 rows), one request per handful of rows
			// until Crossref answered 429.
			let rows = Math.min(1000, max);
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
				/* A "component" is a part of another work with a DOI of its own: a supplementary file
				   (10.1021/acs.jafc.1c03240.s001) or a figure (10.7717/peerj.6046/fig-1). Ten of sixty Crossref
				   answers for "Pseudomonas putida metabolic engineering" were these, undated, under the paper's
				   own title, and one reached the top 20 as a journal article. */
				if (w.type === "component") continue;
				let isPreprint = w.type === "posted-content";
				// A preprint is dated by when it went up, which Crossref keeps in `posted`.
				// `issued` can carry the journal version's date and would misdate the posting.
				let dates = [w.issued, w.published, w["published-online"], w["published-print"]]
					.map(date => date?.["date-parts"]?.[0]).filter(parts => Number.isInteger(parts?.[0]) && parts[0] >= 1500);
				let dated = (isPreprint && w.posted?.["date-parts"]?.[0]) || dates[0];
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
					itemType: CROSSREF_TYPES[w.type] || "journalArticle",
					// A BSI standard, a dataset or a referee report is not a paper: kept, but not counted as an article.
					workType: CROSSREF_NOT_PAPERS.has(w.type) ? w.type : null
				}));
			}
			let total = data.message?.["total-results"] ?? 0;
			out = matchingRecords(dedupe(out), q);
			publishResults(out, q, ctx);
			ctx.onProgress?.(`Crossref: ${out.length} / ${Math.min(max, total)}`, out.length, Math.min(max, total));
			let exhausted = items.length < rows || offset + items.length >= total;
			candidateLimit(ctx, "crossref", out.length, offset + items.length, total, max, exhausted);
			if (exhausted || offset + rows >= PAGE_WALK_LIMIT) break;
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
			// Semantic Scholar writes the PMC id without its prefix.
			pmcid: ext.PubMedCentral ? "PMC" + String(ext.PubMedCentral).replace(/^PMC/i, "") : null,
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

	// One paper by its identifier. Semantic Scholar resolves DOI, PMID, PMCID and arXiv
	// ids through the same endpoint, so a pasted identifier costs exactly one request.
	async function searchSemanticScholarById(id, http, ctx) {
		const PREFIX = { doi: "DOI:", pmid: "PMID:", pmcid: "PMCID:", arxiv: "arXiv:" };
		let headers = ctx.s2ApiKey ? { "x-api-key": ctx.s2ApiKey } : {};
		let url = "https://api.semanticscholar.org/graph/v1/paper/" + enc(PREFIX[id.kind] + id.value) + "?fields=" + S2_FIELDS;
		try {
			let data = await withRetry(() => http.getJSON(url, headers), { tries: 3, delay: 4000 }, ctx);
			return data?.paperId ? [semanticScholarRecord(data)] : [];
		}
		catch (e) {
			if (e.name === "AbortError") throw e;
			if (e.status === 404) return [];
			throw e;
		}
	}

	async function searchSemanticScholar(q, http, ctx) {
		if (q.identifier) return searchSemanticScholarById(q.identifier, http, ctx);
		if ([q.keywords, q.title].some(structuredQuery)) throw new Error("Semantic Scholar relevance search does not support Boolean or quoted expressions; use OpenAlex, PubMed, Europe PMC or arXiv for these queries");
		let terms = [q.keywords, q.title].map(x => (x || "").trim()).filter(Boolean);
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
			let limit = Math.min(100, max, 1000 - offset);
			if (limit <= 0) break;
			let url = "https://api.semanticscholar.org/graph/v1/paper/search?" + params.join("&") + "&limit=" + limit + "&offset=" + offset;
			let data = await withRetry(() => http.getJSON(url, headers), { tries: 6, delay: 4000 }, ctx);
			let items = data.data || [];
			for (let p of items) out.push(semanticScholarRecord(p));
			let total = data.total ?? 0;
			out = matchingRecords(dedupe(out), q);
			publishResults(out, q, ctx);
			ctx.onProgress?.(`Semantic Scholar: ${out.length} / ${Math.min(max, total)}`, out.length, Math.min(max, total));
			let reachedCap = offset + items.length >= 1000 && offset + items.length < total;
			let exhausted = items.length < limit || (!reachedCap && data.next == null) || offset + items.length >= total;
			let truncated = reachedCap && out.length < (q.maxResults || 200);
			sourceStatus(ctx, "semanticscholar", { retrieved: out.length, scanned: offset + items.length, total,
				limit: max, exhausted, truncated, reason: truncated ? "provider-limit" : !exhausted ? "result-limit" : null });
			if (truncated) warn(ctx, "semanticscholar", "The relevance API exhausted its 1000-candidate limit; additional matching records may exist.");
			if (exhausted || data.next == null || data.next <= offset) break;
			offset = data.next;
			await sleep(1100, ctx); // unauthenticated rate limit ~1 req/s
		}
		return out.slice(0, max);
	}

	async function searchSemanticScholarAuthor(q, http, ctx) {
		if (/\bNOT\b|[()]/i.test(q.authors)) throw new Error("Semantic Scholar author lookup supports names separated by AND, OR or semicolons");
		let names = q.authors.split(/\s+(?:AND|OR)\s+|;/i).map(n => n.trim().replace(/^"|"$/g, "")).filter(Boolean);
		let headers = ctx.s2ApiKey ? { "x-api-key": ctx.s2ApiKey } : {};
		let authors = new Map(), out = [], max = q.maxResults || 200;
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
			while (offset < PAGE_WALK_LIMIT && authorRecords.length < max) {
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
			if (offset >= PAGE_WALK_LIMIT && authorRecords.length < max) warn(ctx, "semanticscholar", "Author retrieval stopped after 10000 candidates; narrow the query.");
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

	// PubMed's publication types, reduced to the words the type filter and the retraction logic use.
	/* The kind of item PubMed's and Europe PMC's publication types name, in OpenAlex's words. A correction
	   notice is "Published Erratum" there (Europe PMC adds "correction"): untyped, Nature Microbiology's
	   "Author Correction: Metabolic remodelling produces fumarate..." (10.1038/s41564-025-02188-0) counted as
	   an article with the journal's JIF beside it. Editorials likewise. */
	function pubmedWorkType(types) {
		let list = (Array.isArray(types) ? types : []).map(t => String(t).trim().toLowerCase());
		if (list.includes("retraction of publication") || list.includes("retraction")) return "retraction";
		if (list.includes("published erratum") || list.includes("correction")) return "erratum";
		if (list.includes("editorial")) return "editorial";
		if (list.some(t => t === "review" || t === "systematic review" || t === "meta-analysis" || t === "review-article")) return "review";
		return null;
	}

	function grouped(value) {
		let depth = 0, quoted = false;
		if (value[0] === "(") {
			for (let i = 0; i < value.length; i++) {
				if (value[i] === '"' && value[i - 1] !== "\\") quoted = !quoted;
				if (quoted) continue;
				if (value[i] === "(") depth++;
				if (value[i] === ")" && --depth === 0) return i === value.length - 1 ? value : "(" + value + ")";
			}
		}
		return "(" + value + ")";
	}

	function pubmedTerm(q, dropped = null) {
		if (q.identifier) {
			let id = q.identifier;
			if (id.kind === "doi") return '"' + id.value + '"[aid]';
			if (id.kind === "pmid") return id.value + "[uid]";
			// PubMed has no PMCID field; the identifier appears in the record and the
			// answer is verified against it afterwards.
			if (id.kind === "pmcid") return id.value + "[All Fields]";
			return null;
		}
		let parts = [];
		// PoP uses Text Word, not PubMed's unrestricted automatic term mapping.
		// Preserve phrases/Boolean operators while tagging the actual search terms.
		if (q.keywords?.trim()) parts.push(pubmedFieldQuery(q.keywords, "Text Word", dropped));
		if (q.title?.trim()) parts.push(pubmedFieldQuery(q.title, "ti", dropped));
		if (q.authors?.trim()) parts.push(Query.compileAuthors(q.authors, name => name + "[au]", { binaryNot: true }));
		if (pickedByIssn(q)) parts.push(pickedByIssn(q).issns.map(i => '"' + i + '"[is]').join(" OR "));
		else if (q.venue?.trim()) parts.push('"' + q.venue.trim() + '"[ta]');
		if (q.yearFrom || q.yearTo) parts.push((q.yearFrom || "1800") + ":" + (q.yearTo || "3000") + "[dp]");
		return parts.length === 1 ? parts[0] : parts.map(grouped).join(" AND ");
	}

	// All adapters compile the same AST. Explicit fielded atoms are kept intact;
	// backend operator precedence never gets to reinterpret an OR branch.
	function fieldExpression(value, formatAtom, { wholeAtoms = false, ignoreOperatorCase = false,
		universe = null, binaryNot = null, nativeFields = false, omit = null } = {}) {
		let fields = [];
		// Mixed case on purpose. The parser reads a title written entirely in capitals as
		// prose and lowercases it, and an all-capital placeholder made "CRISPR[All Fields]
		// AND EDITING" look like such a title, which cost the query its AND. The match
		// below is case-insensitive too, so a fold anywhere else cannot lose the atom.
		let input = String(value || ""), prefix = "ZotPoPField";
		while (input.toUpperCase().includes(prefix.toUpperCase())) prefix += "x";
		if (nativeFields) input = input.replace(/(?:"(?:\\.|[^"\\])*"|[^\s()"]+)\[[^\]]+\]|[a-z_]+:"(?:\\.|[^"\\])*"/gi,
			atom => { let token = prefix + fields.length; fields.push(atom); return token; });
		let tree = Query.parseExpression(input, wholeAtoms, ignoreOperatorCase);
		if (!tree) throw new SyntaxError("Invalid search expression: check quotes, operators and parentheses");
		function term(node) {
			let field = new RegExp("^" + prefix + "(\\d+)$", "i").exec(node.value);
			return field && fields[Number(field[1])] ? fields[Number(field[1])] : formatAtom(node.value, node.phrase === true);
		}
		function render(node, negative = false) {
			if (node.kind === "term") return omit?.(node.value, node.phrase) ? (negative ? "(" + universe + " NOT " + universe + ")" : universe) : term(node);
			if (node.kind === "NOT") {
				if (node.child.kind === "NOT") return render(node.child.child, negative);
				return universe ? "(" + universe + " NOT " + render(node.child, !negative) + ")" : "(NOT " + render(node.child, !negative) + ")";
			}
			let left = render(node.left, negative), right = render(node.right, negative);
			if (node.kind === "AND" && universe) {
				if (left === universe) return right;
				if (right === universe) return left;
			}
			if (node.kind === "OR" && universe && (left === universe || right === universe)) return universe;
			// Binary exclusion is more compact than complementing a universe.
			if (node.kind === "AND" && node.right.kind === "NOT" && !omit) return "(" + left + " NOT " + render(node.right.child) + ")";
			return "(" + left + " " + node.kind + " " + right + ")";
		}
		if (!binaryNot) return render(tree);
		function native(node) {
			if (node.kind === "term") return term(node);
			if (node.kind === "NOT") return node.child.kind === "NOT" ? native(node.child.child) : null;
			if (node.kind === "AND") for (let [positive, negative] of [[node.left, node.right], [node.right, node.left]]) {
				if (negative.kind !== "NOT") continue;
				let left = native(positive), right = native(negative.child);
				if (left && right) return "(" + left + " " + binaryNot + " " + right + ")";
			}
			let left = native(node.left), right = native(node.right);
			return left && right ? "(" + left + " " + node.kind + " " + right + ")" : null;
		}
		let compact = native(tree);
		if (compact) return compact;
		// arXiv has only binary ANDNOT. Convert nested negation without ever
		// turning a pure negative branch into an affirmative search.
		function clauses(node, negated = false) {
			if (node.kind === "term") return [[{ node, negated }]];
			if (node.kind === "NOT") return clauses(node.child, !negated);
			let left = clauses(node.left, negated), right = clauses(node.right, negated);
			let join = negated ? (node.kind === "AND" ? "OR" : "AND") : node.kind;
			if ((join === "OR" ? left.length + right.length : left.length * right.length) > 128) throw new RangeError("Search expression has too many Boolean alternatives");
			return join === "OR" ? [...left, ...right] : left.flatMap(a => right.map(b => [...a, ...b]));
		}
		let alternatives = clauses(tree);
		if (alternatives.some(clause => clause.every(part => part.negated))) throw new SyntaxError("This source requires a positive search term in every OR branch; purely negative expressions are unsupported");
		let join = (parts, operator) => parts.length === 1 ? parts[0] : "(" + parts.join(" " + operator + " ") + ")";
		return join(alternatives.map(clause => {
			let positive = join(clause.filter(part => !part.negated).map(part => term(part.node)), "AND");
			let negative = clause.filter(part => part.negated).map(part => term(part.node));
			return negative.length ? "(" + positive + " " + binaryNot + " " + join(negative, "OR") + ")" : positive;
		}), "OR");
	}

	// PubMed does not index standalone stopwords in [ti]. Broaden those atoms
	// (including complemented atoms) in the candidate query; matchesTitle checks
	// the complete original title afterward. Quoted phrases use proximity zero,
	// which includes stopwords and is independent of PubMed's phrase index.
	// NLM's own stopword list. The short guess that stood here covered "in" but not
	// "into", so a real paper whose title contains "into" came back as nothing at all.
	const PUBMED_STOPWORDS = new Set(("a about again all almost also although always among an and another any are as at "
		+ "be because been before being between both but by can could did do does done due during each either enough "
		+ "especially etc for found from further had has have having here how however i if in into is it its itself "
		+ "just kg km made mainly make may me mg might ml mm most mostly must nearly neither no nor obtained of often "
		+ "on our overall perhaps pmid quite rather really regarding seem seen several should show showed shown shows "
		+ "significantly since so some such than that the their theirs them then there therefore these they this those "
		+ "through thus to upon use used using various very was we were what when which while with within without would")
		.split(" "));
	// PubMed does not index a standalone stopword or a bare number in [ti] either: the
	// title "CRISPR-Cas 9 ..." compiled to "9[ti]" and matched nothing. Broaden those
	// atoms and let matchesTitle check the complete original title afterwards.
	// PubMed indexes "CRISPR-Cas9" as a single word, so a title typed "CRISPR Cas 9"
	// asks for "Cas" and for "9" and matches neither. Join a short number back onto
	// the word before it, unless that word is one PubMed does not index anyway.
	function glueDigits(value) {
		return String(value || "").replace(/(\p{L}{3,})\s+(\d{1,3})\b/gu,
			(whole, word, number) => PUBMED_STOPWORDS.has(word.toLowerCase()) ? whole : word + number);
	}

	function pubmedOmissions(value, field, dropped) {
		let omitted = new Set();
		if (!["ti", "Text Word"].includes(field) && !dropped?.size) return omitted;
		for (let token of String(value || "").split(/[^\p{L}\p{N}*]+/u)) {
			let key = token.toLowerCase();
			if (!key) continue;
			if (dropped?.has(key) || PUBMED_STOPWORDS.has(key) || /^\d{1,3}$/.test(key)) omitted.add(key);
		}
		return omitted;
	}
	function pubmedFieldQuery(value, field, dropped = null) {
		let omitted = pubmedOmissions(value, field, dropped);
		return fieldExpression(value, (term, phrase) => {
			let atom = phrase ? '"' + term.replace(/"/g, "") + '"' : term;
			return atom + "[" + field + (phrase && field === "ti" && /\s/.test(term) ? ":~0" : "") + "]";
		}, { universe: "all[sb]", nativeFields: true,
			omit: omitted.size ? (term, phrase) => !phrase && omitted.has(String(term).toLowerCase()) : null });
	}

	async function searchPubMed(q, http, ctx) {
		if (!hasAny(q)) return [];
		let max = q.maxResults || 200;
		let base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
		// Without a key NCBI allows 3 requests a second; with one, 10.
		let tool = "&tool=zotpop" + (ctx.email ? "&email=" + enc(ctx.email) : "")
			+ (ctx.ncbiApiKey ? "&api_key=" + enc(String(ctx.ncbiApiKey).trim()) : "");
		let sort = q.sort === "date" ? "pub_date" : "relevance";
		let out = [], scanned = 0, total = null;
		let dropped = null, retried = false, glued = false;
		let compiled = pubmedTerm(q, dropped);
		if (!compiled) {
			warn(ctx, "pubmed", "PubMed does not index arXiv identifiers; use arXiv, OpenAlex or Semantic Scholar for this one.");
			return [];
		}
		let term = enc(compiled);
		while (out.length < max && scanned < PAGE_WALK_LIMIT) {
			let retmax = Math.min(1000, Math.max(200, max * 3), PAGE_WALK_LIMIT - scanned);
			let es = await withRetry(() => http.getJSON(base + "esearch.fcgi?db=pubmed&retmode=json&sort=" + sort + "&retmax=" + retmax + "&retstart=" + scanned + "&term=" + term + tool), {}, ctx);
			if (es.error || es.esearchresult?.ERROR) throw new Error("PubMed rejected the query: " + (es.error || es.esearchresult.ERROR));
			let ids = es.esearchresult?.idlist || [];
			total = toInt(es.esearchresult?.count) ?? ids.length;
			let issues = es.esearchresult?.errorlist;
			if (issues?.fieldsnotfound?.length) throw new Error("PubMed does not recognize fields: " + issues.fieldsnotfound.join(", "));
			if (issues?.phrasesnotfound?.length) {
				// PubMed answers a term it does not index with zero results, not an error.
				// Drop exactly those terms and ask once more before reporting nothing.
				let unusable = issues.phrasesnotfound.map(x => String(x).toLowerCase());
				if (!retried && !ids.length && !q.identifier) {
					retried = true;
					dropped = new Set([...(dropped || []), ...unusable]);
					let rebuilt = pubmedTerm(q, dropped);
					if (rebuilt && enc(rebuilt) !== term) {
						term = enc(rebuilt);
						warn(ctx, "pubmed", "PubMed does not index " + unusable.join(", ") + "; the search was widened without " + (unusable.length > 1 ? "those terms" : "that term") + " and the titles were checked here.");
						continue;
					}
				}
				warn(ctx, "pubmed", "PubMed could not find query terms: " + issues.phrasesnotfound.join(", "));
			}
			if (!ids.length && !glued && !q.identifier) {
				glued = true;
				let joined = Object.assign({}, q, { title: glueDigits(q.title), keywords: glueDigits(q.keywords) });
				let rebuilt = pubmedTerm(joined, dropped);
				// The original title is still what every returned record is checked against.
				if (rebuilt && enc(rebuilt) !== term) { term = enc(rebuilt); continue; }
			}
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
						authors: (d.authors || []).filter(a => String(a.name || "").trim()).map(a => {
							// A consortium is one organisation author, never "Consortium" as a surname with initials.
							if (a.authtype === "CollectiveName") { let name = String(a.name).replace(/\s+/g, " ").trim(); return { firstName: "", lastName: name, name, kind: "organization" }; }
							// "Sung JY" -> last "Sung", first "JY"
							let m = String(a.name || "").match(/^(.*\S)\s+(\S+)$/);
							return m ? { firstName: m[2], lastName: m[1], name: a.name } : parseName(a.name);
						}),
						year: pubmedYear(d),
						venue: d.fulljournalname || d.source || "",
						// PubMed matched [ta] on the abbreviation, so the abbreviation is
						// what a venue query has to be checked against as well.
						journalAbbreviation: d.source || "",
						issn: d.issn || d.essn || null,
						issns: [d.issn, d.essn].filter(Boolean),
						doi,
						pmid: uid,
						pmcid: pmc,
						url: "https://pubmed.ncbi.nlm.nih.gov/" + uid + "/",
						pdfUrl: pmc ? "https://www.ncbi.nlm.nih.gov/pmc/articles/" + pmc + "/pdf/" : null,
						citations: null,
						volume: d.volume || "",
						issue: d.issue || "",
						pages: d.pages || "",
						itemType: "journalArticle",
						workType: pubmedWorkType(d.pubtype),
						// The paper itself; "Retraction of Publication" is the notice, as in the OpenAlex path.
						retracted: (d.pubtype || []).some(t => /^retracted publication$/i.test(String(t).trim()))
					}));
				}
				out = matchingRecords(dedupe(out), q);
				publishResults(out, q, ctx);
				ctx.onProgress?.(`PubMed: ${out.length} / ${Math.min(max, total)}`, out.length, Math.min(max, total));
			}
			scanned += ids.length;
			let exhausted = !ids.length || scanned >= total;
			candidateLimit(ctx, "pubmed", out.length, scanned, total, max, exhausted);
			if (exhausted) break;
		}
		if (q.sort === "citations" && scanned < total) warn(ctx, "pubmed", "Citation order applies to the retrieved PubMed relevance pool; PubMed has no global citation ranking.");
		if (ctx.enrichCitations !== false) await enrichFromOpenAlex(out, http, ctx);
		return sortSearchResults(out, q).slice(0, max);
	}


	// ---------------------------------------------------------------- PubMed abstracts
	/* esummary carries no abstract. It is fetched for the papers the reader opens or translates,
	   several PMIDs per EFetch, and remembered: never for a whole result list. */
	const PUBMED_ABSTRACTS = new TimedMap(); // pmid -> text | null
	function parsePubMedAbstracts(xml) {
		let out = new Map();
		for (let block of String(xml || "").split(/<PubmedArticle[\s>]/).slice(1)) {
			let pmid = (block.match(/<PMID[^>]*>\s*(\d+)\s*<\/PMID>/) || [])[1];
			if (!pmid) continue;
			let parts = [];
			for (let m of block.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)) {
				let text = stripTags(xmlText(m[0], "AbstractText"));
				if (!text) continue;
				let label = (m[1].match(/\bLabel="([^"]*)"/) || [])[1];
				parts.push(label && label !== "UNLABELLED" ? label + ": " + text : text);
			}
			out.set(pmid, parts.join("\n"));
		}
		return out;
	}
	async function fetchPubMedAbstracts(pmids, http, ctx = {}) {
		let wanted = [...new Set((pmids || []).map(p => String(p || "").trim()).filter(p => /^\d{1,9}$/.test(p)))];
		let result = new Map();
		let missing = wanted.filter(p => {
			if (PUBMED_ABSTRACTS.has(p)) { let v = PUBMED_ABSTRACTS.get(p); if (v) result.set(p, v); return false; }
			return true;
		});
		// No email address is sent for this lookup; a key the reader set up is not an address.
		let tool = "&tool=zotpop" + (ctx.ncbiApiKey ? "&api_key=" + enc(String(ctx.ncbiApiKey).trim()) : "");
		for (let i = 0; i < missing.length; i += 200) {
			throwIfCancelled(ctx);
			let chunk = missing.slice(i, i + 200);
			let xml = await withRetry(() => http.getText("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&retmode=xml&rettype=abstract&id=" + chunk.join(",") + tool), {}, ctx);
			let parsed = parsePubMedAbstracts(xml);
			for (let p of chunk) {
				let text = parsed.get(p) || "";
				PUBMED_ABSTRACTS.set(p, text || null);
				if (text) result.set(p, text);
			}
		}
		return result;
	}

	// ---------------------------------------------------------------- arXiv
	function xmlText(block, tag) {
		let m = block.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">"));
		return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
	}

	// arXiv's own field prefixes. Any other word ending in a colon -- "enzymes:" out of
	// a subtitle -- is a search term, and sending it bare broke the whole query.
	const ARXIV_FIELDS = /^(?:ti|au|abs|co|jr|cat|rn|id|all):/i;
	// Lucene reads a leading "-" as NOT and a ":" as a field separator, so "-10" and
	// "structure-function:" have to travel quoted.
	function luceneAtom(term) {
		let value = String(term).replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-").replace(/:+$/, "");
		return /^[\p{L}\p{N}*]+$/u.test(value) ? value : '"' + value.replace(/"/g, "") + '"';
	}
	function arxivFieldQuery(value, field) {
		return fieldExpression(value, (term, phrase) => ARXIV_FIELDS.test(term) ? term
			: field + ":" + (phrase ? '"' + term.replace(/"/g, "") + '"' : luceneAtom(term)),
			{ nativeFields: true, binaryNot: "ANDNOT" });
	}

	async function searchArxiv(q, http, ctx) {
		let idList = q.identifier?.kind === "arxiv" ? q.identifier.value : null;
		if (q.identifier && !idList) {
			warn(ctx, "arxiv", "arXiv can only be searched by an arXiv identifier, not by a " + q.identifier.kind.toUpperCase() + ".");
			return [];
		}
		let parts = [];
		if (q.keywords?.trim()) parts.push(arxivFieldQuery(q.keywords, "all"));
		if (q.title?.trim()) parts.push(arxivFieldQuery(q.title, "ti"));
		// arXiv indexes "Jae Yoon Sung"; the PoP form "Sung JY" is not a phrase it holds.
		if (q.authors?.trim()) parts.push(Query.compileAuthors(q.authors, name => 'au:"' + searchableSurname(name).replace(/"/g, "") + '"', { notOperator: "ANDNOT" }));
		if (q.venue?.trim()) parts.push('jr:"' + q.venue.trim() + '"');
		if (!parts.length && !idList) return [];
		if (!idList && (q.yearFrom || q.yearTo)) parts.push("submittedDate:[" + (q.yearFrom || "1990") + "01010000 TO " + (q.yearTo || "2100") + "12312359]");
		let query = parts.map(grouped).join(" AND ");
		let max = q.maxResults || 200;
		let out = [];
		let start = 0;
		let total = null;
		while (out.length < max) {
			throwIfCancelled(ctx);
			// arXiv asks for three seconds between requests, so a page of 100 spent 36
			// seconds asleep on a 1000-row search. It serves up to 2000 at once but
			// returns short pages on large asks, which would read as exhausted here.
			let n = Math.min(500, max);
			let url = "https://export.arxiv.org/api/query?" + (idList ? "id_list=" + enc(idList) : "search_query=" + enc(query))
				+ "&start=" + start + "&max_results=" + n + (q.sort === "date" ? "&sortBy=submittedDate&sortOrder=descending" : "&sortBy=relevance");
			// arXiv answered twice with nothing at all where the same query had papers.
			// An empty body is worth asking again for; a body that is not a feed is a
			// failure, and either one read as "no papers" is how a search loses them.
			let xml = await withRetry(async () => {
				let body = String(await http.getText(url) || "");
				if (!body.trim()) throw Object.assign(new Error("arXiv returned an empty response"), { status: 503 });
				if (!/<feed[\s>]|\/api\/errors/.test(body)) throw new Error("arXiv returned a response that is not an Atom feed");
				return body;
			}, { tries: 5, delay: 4000 }, ctx);
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
					// The posting's own venue is arXiv; the journal that took it is the other version's.
					venue: "arXiv",
					journalReference,
					publishedVenue: venue || null,
					// A search by journal still finds the posting its journal took.
					venueAliases: venue ? [venue] : [],
					doi: arxivDOI(arxivId),
					publishedDoi: doi || null,
					arxiv: arxivId,
					url: "https://arxiv.org/abs/" + arxivId,
					pdfUrl: pdf,
					citations: null,
					abstract: xmlText(e, "summary"),
					// Every arXiv entry is a posting on arXiv, whether or not a journal has
					// since taken it. arxiv:doi is that journal version's DOI: kept as
					// publishedDoi, never as this posting's DOI, so the two versions stay
					// two records (dates, abstract and PDF per version).
					preprintServer: "arXiv",
					itemType: "preprint"
				}));
			}
			out = matchingRecords(dedupe(out), q);
			publishResults(out, q, ctx);
			ctx.onProgress?.(`arXiv: ${out.length} / ${Math.min(max, total)}`, out.length, Math.min(max, total));
			// start counts rows walked, not rows kept, so a filter that rejects everything
			// would otherwise page through the entire result set three seconds at a time.
			let exhausted = entries.length < n || start + entries.length >= total;
			candidateLimit(ctx, "arxiv", out.length, start + entries.length, total, max, exhausted);
			if (exhausted || start + entries.length >= PAGE_WALK_LIMIT) break;
			start += n;
			await sleep(3000, ctx); // arXiv asks for 3 s between requests
		}
		if (ctx.enrichCitations !== false) await enrichFromOpenAlex(out, http, ctx);
		return out.slice(0, max);
	}

	// ---------------------------------------------------------------- Europe PMC
	// Indexes PubMed + PMC and, crucially, the preprint servers: bioRxiv, medRxiv
	// and Research Square. Used both as a general source and as the preprint source.
	// Europe PMC indexes a byline surname first -- "Sung JY", "Sung Jae Yoon". Sent as
	// written, "J. Y. Sung" matched a single unrelated paper from 1998.
	function epmcAuthorAtom(name) {
		let parsed = parseName(name);
		let initialsLast = /^[A-Za-z]{1,3}$/.test(String(parsed.lastName || "").replace(/\./g, ""));
		let family = (initialsLast ? parsed.firstName : parsed.lastName) || "";
		let given = (initialsLast ? parsed.lastName : parsed.firstName) || "";
		let clean = v => String(v).replace(/"/g, "").replace(/\s+/g, " ").trim();
		if (!family || !given) return 'AUTH:"' + clean(name) + '"';
		let initials = given.replace(/\./g, " ").split(/[\s-]+/).filter(Boolean).map(w => w[0].toUpperCase()).join("");
		let forms = [...new Set([clean(family + " " + given), clean(family + " " + initials)])];
		return forms.length === 1 ? 'AUTH:"' + forms[0] + '"'
			: "(" + forms.map(f => 'AUTH:"' + f + '"').join(" OR ") + ")";
	}

	function epmcQuery(q, preprintsOnly) {
		if (q.identifier) {
			let id = q.identifier;
			if (id.kind === "doi") return 'DOI:"' + id.value + '"';
			if (id.kind === "pmid") return "(EXT_ID:" + id.value + " AND SRC:MED)";
			if (id.kind === "pmcid") return "PMCID:" + id.value;
			return "";
		}
		let parts = [];
		if (q.keywords?.trim()) parts.push("(" + q.keywords.trim() + ")");
		if (q.title?.trim()) parts.push(fieldExpression(q.title, (term, phrase) => "TITLE:" + (phrase ? '"' + term.replace(/"/g, "") + '"' : luceneAtom(term))));
		if (q.authors?.trim()) {
			parts.push(Query.compileAuthors(q.authors, epmcAuthorAtom));
		}
		if (pickedByIssn(q) && !preprintsOnly) parts.push(pickedByIssn(q).issns.map(i => 'ISSN:"' + i.replace(/"/g, "") + '"').join(" OR "));
		else if (q.venue?.trim()) {
			let v = q.venue.trim().replace(/"/g, "");
			parts.push(preprintsOnly ? '(PUBLISHER:"' + v + '" OR JOURNAL:"' + v + '")' : 'JOURNAL:"' + v + '"');
		}
		if (q.yearFrom || q.yearTo) parts.push("PUB_YEAR:[" + (q.yearFrom || 1800) + " TO " + (q.yearTo || 3000) + "]");
		if (preprintsOnly) parts.push("SRC:PPR");
		return parts.length === 1 ? parts[0] : parts.map(grouped).join(" AND ");
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
			// Both numbers: a journal picked by its electronic ISSN is checked against them.
			issns: [r.journalInfo?.journal?.issn, r.journalInfo?.journal?.essn].filter(Boolean),
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
			itemType: isPreprint ? "preprint" : "journalArticle",
			workType: pubmedWorkType(r.pubTypeList?.pubType) || ((r.pubTypeList?.pubType || []).some(t => /review/i.test(t)) ? "review" : null),
			// The paper itself, not the notice ("Retraction of Publication").
			retracted: (r.pubTypeList?.pubType || []).some(t => /^retracted publication$/i.test(String(t).trim()))
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
			// Fixed, as on Crossref: the remainder alone walked Europe PMC in pages of 17, 3 and 1.
			let pageSize = Math.min(1000, max);
			let url = "https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core"
				+ "&pageSize=" + pageSize + "&cursorMark=" + enc(cursor) + sort + "&query=" + enc(query);
			// Europe PMC answered a valid query with HTTP 200 and a 17-byte body; the
			// control request 60 seconds later reported 10,784 hits. Read as an empty
			// result set, that silently becomes "no such paper".
			let data = await withRetry(async () => {
				let body = await http.getJSON(url);
				if (!body || typeof body !== "object" || (body.hitCount == null && body.resultList == null)) {
					throw Object.assign(new Error("Europe PMC returned an incomplete response"), { status: 503 });
				}
				return body;
			}, {}, ctx);
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
			let exhausted = !items.length || !next || next === cursor || seen >= total;
			candidateLimit(ctx, "europepmc", out.length, seen, total, max, exhausted);
			if (exhausted || seen >= PAGE_WALK_LIMIT) break;
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

	async function searchOSF(q, http, ctx, seed = null) {
		if (q.identifier) {
			sourceStatus(ctx, "osf", { retrieved: 0, scanned: 0, total: null, limit: q.maxResults || 200, exhausted: true, truncated: false, reason: "unsupported-query" });
			return [];
		}
		let value = q.title?.trim() || q.keywords?.trim();
		if (!value) {
			warn(ctx, "osf", "Author-only and journal-only searches are unavailable in the OSF API; add a title or keyword.");
			sourceStatus(ctx, "osf", { retrieved: 0, scanned: 0, total: null, limit: q.maxResults || 200, exhausted: false, truncated: true, reason: "unsupported-query" });
			return [];
		}
		if (!seed) {
			let seeds = substringSeeds(value);
			if (seeds.length > 1) {
				let lists = [], statuses = [];
				for (let part of seeds) {
					let rows = await searchOSF(q, http, Object.assign({}, ctx, { onResults: records => {
						publishResults(mergeRecords([...lists, records]), q, ctx);
					} }), part);
					lists.push(rows); statuses.push(ctx.sourceStatus?.osf);
				}
				let out = sortSearchResults(mergeRecords(lists), q).slice(0, q.maxResults || 200);
				sourceStatus(ctx, "osf", { retrieved: out.length, scanned: statuses.reduce((n, st) => n + (st?.scanned || 0), 0),
					total: null, limit: q.maxResults || 200, exhausted: statuses.every(st => st?.exhausted),
					truncated: statuses.some(st => st?.truncated), reason: statuses.find(st => st?.truncated)?.reason || null });
				return out;
			}
			seed = seeds[0];
		}
		let filters = [];
		// filter[field] is a contiguous, case-insensitive substring test, not a term search:
		// filter[title]=protein engineering matched 0 of 201,549 postings while
		// filter[title,description] (OSF's OR over both fields) matched 31 for another phrase.
		// So a keyword query goes to both fields and only a title query is narrowed to one.
		if (q.title?.trim()) filters.push("filter[title]=" + enc(seed));
		else if (q.keywords?.trim()) filters.push("filter[title,description]=" + enc(seed));
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
			let next = data.links?.next || null;
			candidateLimit(ctx, "osf", out.length, seen, total, max, !items.length || !next);
			url = items.length && seen < PAGE_WALK_LIMIT ? next : null;
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

	/* Google Scholar has no API. Publish or Perish reads its pages; so does this.
	   Two walls stand in the way and they are told apart, because the cure is
	   different: a CAPTCHA (or a 429) wants a human to answer it once, in a
	   browser that shares Zotero's cookies; the sign-in page on author search
	   wants a Google account signed in the same way. Either way the error names
	   the wall and the page, and the window can offer to open it. */
	const SCHOLAR = "https://scholar.google.com";
	function scholarWall(html, url, status) {
		let text = String(html || "");
		let captcha = status === 429 || /gs_captcha|id="captcha"|recaptcha|Our systems have detected unusual traffic/i.test(text);
		let login = /accounts\.google\.com\/(?:v3\/)?signin|flowName=GlifWebSignIn|<base href="https:\/\/accounts\.google\.com/i.test(text);
		if (!captcha && !login) return null;
		let e = new Error(login
			? "Google Scholar wants a Google account signed in for this page. Open Scholar inside Zotero, sign in, then retry."
			: "Google Scholar is asking for a CAPTCHA. Open Scholar inside Zotero, answer it, then retry.");
		e.wall = login ? "login" : "captcha"; e.captcha = !login; e.url = url || SCHOLAR; e.source = "scholar";
		return e;
	}
	function scholarAbsolute(href) {
		if (!href) return null;
		if (/^https?:\/\//i.test(href)) return href;
		return SCHOLAR + (href.startsWith("/") ? "" : "/") + href;
	}
	function scholarProfileIdFrom(href) {
		let m = String(href || "").match(/[?&]user=([A-Za-z0-9_-]{12})/);
		return m ? m[1] : null;
	}
	async function scholarGet(url, http, ctx) {
		let html;
		try { html = await http.getText(url, { "Accept-Language": "en-US,en;q=0.9" }); }
		catch (e) {
			if (e?.status === 429 || e?.status === 403) { let wall = scholarWall("", url, 429); wall.cause = e; throw wall; }
			throw e;
		}
		let wall = scholarWall(html, url);
		if (wall) throw wall;
		return html;
	}

	function parseScholarPage(html, DOMParserImpl) {
		let doc = new DOMParserImpl().parseFromString(html, "text/html");
		let wall = scholarWall(html);
		if (wall) throw wall;
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
			// The authors that have a profile: a way from a paper to its people without a name search.
			let authorProfiles = [...div.querySelectorAll(".gs_a a[href*='citations?user='], .gs_a a[href*='citations?hl=en&user=']")]
				.map(link => ({ name: link.textContent.trim(), id: scholarProfileIdFrom(link.getAttribute("href")) })).filter(x => x.id);
			let citedByLink = [...div.querySelectorAll(".gs_fl a")].map(link => link.getAttribute("href") || "").find(href => /[?&]cites=\d+/.test(href)) || null;
			let citesCluster = citedByLink ? (citedByLink.match(/[?&]cites=(\d+)/) || [])[1] || null : null;
			recs.push(makeRecord({
				scholarAuthors: authorProfiles, scholarCluster: clusterId || citesCluster || null,
				source: "scholar",
				sourceId: clusterId || title.toLowerCase(),
				title,
				abstract: div.querySelector(".gs_rs")?.textContent?.trim() || "",
				authors: authorsSeg.split(",").map(s => s.trim()).filter(s => s && !/^\d+$/.test(s)).map(parseName),
				year,
				venue,
				url: scholarAbsolute(a?.getAttribute("href")) || null,
				pdfUrl: scholarAbsolute(pdfA?.getAttribute("href")) || null,
				citations: cites,
				itemType: /arxiv|biorxiv|medrxiv|preprint/i.test(venueSeg) ? "preprint" : "journalArticle"
			}));
		}
		return recs;
	}

	/* A profile page (citations?user=ID) is public and needs no sign-in. Its rows
	   carry title, the by-line, the venue with the year, and the count of
	   citing papers; the header carries the name, affiliation and the h-index. */
	function parseScholarProfilePage(html, DOMParserImpl, id) {
		let wall = scholarWall(html);
		if (wall) throw wall;
		let doc = new DOMParserImpl().parseFromString(html, "text/html");
		let name = doc.querySelector("#gsc_prf_in")?.textContent?.trim() || "";
		let details = [...doc.querySelectorAll(".gsc_prf_il")].map(el => el.textContent.trim());
		let affiliation = details.find(t => t && !/^Verified email/i.test(t)) || "";
		let stats = {}, since = {};
		// The "Cited by" table: a column for all years and one "Since <year>".
		let sinceYear = parseInt(([...doc.querySelectorAll("#gsc_rsb_st th")].map(th => th.textContent).join(" ") || "").match(/Since\s+(\d{4})/i)?.[1] || "", 10);
		for (let tr of doc.querySelectorAll("#gsc_rsb_st tr")) {
			let label = tr.querySelector(".gsc_rsb_sc1")?.textContent?.trim().toLowerCase() || "";
			let cells = [...tr.querySelectorAll(".gsc_rsb_std")].map(td => parseInt(td.textContent.replace(/,/g, ""), 10));
			if (!label || !cells.length) continue;
			let key = /^citations/.test(label) ? "citations" : /h-index/.test(label) ? "hIndex" : /i10/.test(label) ? "i10" : null;
			if (!key) continue;
			stats[key] = cells[0];
			if (Number.isFinite(cells[1])) since[key] = cells[1];
		}
		if (Number.isInteger(sinceYear) && Object.keys(since).length) { stats.sinceYear = sinceYear; stats.since = since; }
		let rows = [];
		for (let tr of doc.querySelectorAll("tr.gsc_a_tr")) {
			let a = tr.querySelector("a.gsc_a_at");
			let title = a?.textContent?.trim();
			if (!title) continue;
			let grays = [...tr.querySelectorAll(".gs_gray")].map(el => el.textContent.trim());
			let authorsLine = grays[0] || "", venueLine = grays[1] || "";
			let year = parseInt(tr.querySelector(".gsc_a_y .gsc_a_h")?.textContent?.trim() || "", 10) || yearOf(venueLine) || null;
			let venue = venueLine.replace(/,\s*(1[5-9]\d{2}|20\d{2})\s*$/, "").replace(/\s+\d+\s*\(\d+\)\s*,\s*[\d-–]+\s*$/, "").replace(/\s+\d+\s*,\s*[\d-–]+\s*$/, "").trim();
			let citesA = tr.querySelector(".gsc_a_c a");
			let cites = parseInt((citesA?.textContent || "").replace(/,/g, ""), 10);
			let citesCluster = (citesA?.getAttribute("href") || "").match(/[?&]cites=(\d+)/)?.[1] || null;
			let viewId = (a.getAttribute("href") || "").match(/citation_for_view=([^&]+)/)?.[1] || null;
			rows.push({ title, authors: authorsLine.split(",").map(x => x.trim()).filter(x => x && !/^(\.{3}|…)$/.test(x)), venue, year, cites: Number.isFinite(cites) ? cites : 0,
				citesCluster, id: viewId ? decodeURIComponent(viewId) : null, url: scholarAbsolute(a.getAttribute("href")) });
		}
		let more = !!doc.querySelector("#gsc_bpf_more:not([disabled])");
		return { profile: { id, name, affiliation, url: SCHOLAR + "/citations?user=" + encodeURIComponent(id), ...stats }, rows, more };
	}
	async function scholarProfile(id, http, ctx = {}, options = {}) {
		if (!/^[A-Za-z0-9_-]{12}$/.test(String(id || ""))) throw new Error("Invalid Google Scholar profile ID");
		if (typeof ctx.DOMParser !== "function") throw new Error("Google Scholar requires a DOM parser");
		let max = Math.max(1, Math.min(2000, Number(options.maxResults) || 200));
		let sort = options.sort === "date" ? "&sortby=pubdate" : "";
		let profile = null, rows = [], start = 0, pageSize = 100;
		while (rows.length < max) {
			throwIfCancelled(ctx);
			let url = `${SCHOLAR}/citations?user=${encodeURIComponent(id)}&hl=en&cstart=${start}&pagesize=${pageSize}${sort}`;
			let html = await scholarGet(url, http, ctx);
			let page = parseScholarProfilePage(html, ctx.DOMParser, id);
			if (!profile) profile = page.profile;
			rows.push(...page.rows);
			ctx.onProgress?.(`Google Scholar: ${rows.length}`, rows.length, max);
			if (!page.rows.length || !page.more || page.rows.length < pageSize) break;
			start += pageSize;
			await sleep(1200 + Math.random() * 800, ctx);
		}
		rows = rows.slice(0, max);
		let records = rows.map(r => makeRecord({
			source: "scholar", sourceId: r.id || r.title.toLowerCase(), searchBackend: "scholar-profile",
			title: r.title, authors: r.authors.map(parseName), year: r.year, venue: r.venue, url: r.url,
			citations: r.cites, scholarCluster: r.citesCluster, itemType: /arxiv|biorxiv|medrxiv|preprint/i.test(r.venue) ? "preprint" : "journalArticle"
		}));
		return { profile, records, complete: rows.length < max || !records.length };
	}
	/* The author search page needs a signed-in Google account; without one it
	   answers with the sign-in page, which scholarWall names as a login wall. */
	function parseScholarAuthorsPage(html, DOMParserImpl) {
		let wall = scholarWall(html);
		if (wall) throw wall;
		let doc = new DOMParserImpl().parseFromString(html, "text/html");
		let out = [];
		for (let box of doc.querySelectorAll(".gsc_1usr, .gs_ai")) {
			let link = box.querySelector(".gs_ai_name a, a[href*='user=']");
			let id = scholarProfileIdFrom(link?.getAttribute("href"));
			if (!id) continue;
			let cby = (box.querySelector(".gs_ai_cby")?.textContent || "").match(/([\d,]+)/);
			out.push({ provider: "scholar", id, name: link.textContent.trim(), affiliation: box.querySelector(".gs_ai_aff")?.textContent?.trim() || "",
				email: box.querySelector(".gs_ai_eml")?.textContent?.trim() || "", citations: cby ? parseInt(cby[1].replace(/,/g, ""), 10) : null,
				url: SCHOLAR + "/citations?user=" + encodeURIComponent(id) });
		}
		return out;
	}
	async function scholarAuthors(name, http, ctx = {}) {
		if (typeof ctx.DOMParser !== "function") throw new Error("Google Scholar requires a DOM parser");
		let url = `${SCHOLAR}/citations?view_op=search_authors&hl=en&mauthors=${enc(String(name || "").trim())}`;
		let html = await scholarGet(url, http, ctx);
		return parseScholarAuthorsPage(html, ctx.DOMParser);
	}
	/* The papers that cite one paper: the same result page, keyed by cluster. */
	async function scholarCitedBy(cluster, http, ctx = {}, options = {}) {
		if (!/^\d+$/.test(String(cluster || ""))) throw new Error("Invalid Google Scholar cluster id");
		if (typeof ctx.DOMParser !== "function") throw new Error("Google Scholar requires a DOM parser");
		let max = Math.max(1, Math.min(1000, Number(options.maxResults) || 100)), out = [], start = 0;
		while (out.length < max) {
			throwIfCancelled(ctx);
			let url = `${SCHOLAR}/scholar?hl=en&as_sdt=0,5&num=20&cites=${cluster}&start=${start}`;
			let html = await scholarGet(url, http, ctx);
			let recs = parseScholarPage(html, ctx.DOMParser);
			if (!recs.length) break;
			out.push(...recs);
			ctx.onProgress?.(`Google Scholar: ${out.length}`, out.length, max);
			if (recs.length < 10) break;
			start += recs.length;
			await sleep(2500 + Math.random() * 2000, ctx);
		}
		return out.slice(0, max);
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
			let html = await scholarGet(url, http, ctx);
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

	// This registry describes the installed PoP command, not direct API support.
	const POP_SOURCES = Object.freeze(Object.fromEntries([
		["scholar", "Google Scholar", "--gscholar"], ["crossref", "Crossref", "--crossref"],
		["pubmed", "PubMed", "--pubmed"], ["openalex", "OpenAlex", "--openalex"],
		["semanticscholar", "Semantic Scholar", "--semscholar"],
		["scholarauthor", "Google Scholar author", "--gsauthor"],
		["scholarprofile", "Google Scholar profile", "--gsprofile"],
		["scholarciting", "Google Scholar citing articles", "--gsciting"],
		["hadb", "Harzing's author database", "--hadb"], ["lens", "Lens", "--lens"],
		["scopus", "Scopus", "--scopus"], ["wos", "Web of Science", "--wos"],
		["wosexpanded", "Web of Science Expanded", "--wosexpanded"],
		["wosstarter", "Web of Science Starter", "--wosstarter"]
	].map(([key, label, flag]) => [key, Object.freeze({ label, flag })])));

	function clonePoPJSON(value) { return JSON.parse(JSON.stringify(value)); }

	function popItemType(value) {
		let type = String(value || "").toLowerCase().replace(/[_\s]+/g, "-");
		if (Object.hasOwn(CROSSREF_TYPES, type)) return CROSSREF_TYPES[type];
		if (type === "dataset") return "dataset";
		if (/book-(?:chapter|section)|^chapter$/.test(type)) return "bookSection";
		if (/conference|proceedings/.test(type)) return "conferencePaper";
		if (/dissertation|thesis/.test(type)) return "thesis";
		if (/preprint/.test(type)) return "preprint";
		if (/book/.test(type)) return "book";
		if (/report/.test(type)) return "report";
		if (/patent/.test(type)) return "patent";
		return "document";
	}

	function popExactAuthor(author) {
		if (typeof author === "string") return parseName(author);
		if (!author || typeof author !== "object" || Array.isArray(author)) return parseName(String(author ?? ""));
		let copy = clonePoPJSON(author);
		let name = String(copy.name ?? [copy.firstName ?? copy.given, copy.lastName ?? copy.family].filter(part => part != null && part !== "").join(" "));
		let parsed = parseName(name);
		return Object.assign(copy, { name, firstName: copy.firstName ?? copy.given ?? parsed.firstName,
			lastName: copy.lastName ?? copy.family ?? parsed.lastName });
	}

	function popTitleMarkup(value) {
		let text = decodeEntities(String(value ?? ""));
		const tags = { i: "i", italic: "i", b: "b", bold: "b", em: "em", strong: "strong", sub: "sub", sup: "sup" };
		text = text.replace(/<(\/?)(?:jats:)?(i|italic|b|bold|em|strong|sub|sup)(?:\s+[^<>]*?)?\s*>/gi,
			(_, close, tag) => "<" + close + tags[tag.toLowerCase()] + ">");
		// Only unwrap actual paired elements: '< 0.05 and q > 0.1' is scientific text.
		for (let i = 0; i < 8; i++) {
			let next = text.replace(/<((?!(?:i|b|em|strong|sub|sup)(?:\s|>))[a-z][\w:-]*)(?:\s[^<>]*?)?>([\s\S]*?)<\/\1\s*>/gi, "$2");
			if (next === text) break;
			text = next;
		}
		return /<\/?(?:i|b|em|strong|sub|sup)>/i.test(text)
			? text.replace(/<br\s*\/?>/gi, " ").replace(/\s+/g, " ").trim() : null;
	}

	// A faithful UI projection retains the native row separately. In particular, a
	// repeated DOI is still a selectable occurrence and an absent title stays absent.
	function normalizePoPExactRecords(rows, source, provenance = {}) {
		if (!Object.hasOwn(POP_SOURCES, source)) throw new Error("Publish or Perish does not support source: " + source);
		if (!Array.isArray(rows)) throw new Error("Invalid Publish or Perish result list");
		let records = rows.map((row, index) => {
			if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Invalid Publish or Perish row at index " + index);
			let original = clonePoPJSON(row);
			let authors = Array.isArray(row.authors) ? row.authors : row.authors == null ? [] : [row.authors];
			let pages = row.startpage != null ? String(row.startpage)
				+ (row.endpage != null && row.endpage !== row.startpage ? "-" + row.endpage : "") : String(row.pages ?? "");
			let record = makeRecord({
				source, sourceId: String(row.uid ?? row.sourceId ?? row.doi ?? ""),
				engine: "pop", searchBackend: "publish-or-perish",
				title: String(row.title ?? ""), authors: authors.map(popExactAuthor),
				year: row.year ?? null, venue: row.source ?? row.venue ?? "", publisher: row.publisher ?? "",
				issn: row.issn ?? null, doi: row.doi ?? normalizeDOI(row.article_url),
				pmid: row.pmid ?? null, pmcid: row.pmcid ?? null, arxiv: row.arxiv ?? null,
				url: row.article_url ?? row.url ?? null, fulltextUrl: row.fulltext_url ?? null,
				pdfUrl: /\.pdf(?:[?#]|$)|\/pdf(?:[/?#]|$)/i.test(row.fulltext_url || "") ? row.fulltext_url : null,
				citations: row.cites ?? row.citations ?? null, abstract: row.abstract ?? "",
				volume: String(row.volume ?? ""), issue: String(row.issue ?? ""), pages,
				itemType: popItemType(row.type), popType: row.type ?? null,
				popOriginal: original, popOrdinal: index, popRank: row.rank ?? null,
				rank: row.rank ?? index + 1, popProvenance: clonePoPJSON(provenance)
			});
			record.titleMarkup = popTitleMarkup(row.title);
			record.key = "pop:" + source + ":" + enc(String(provenance.profileId ?? "default"))
				+ ":" + enc(String(provenance.invocationId ?? provenance.capturedAt ?? provenance.retrievedAt ?? "")) + ":" + index;
			return record;
		});
		records.popProvenance = clonePoPJSON(provenance);
		if (rows.partial || provenance.complete === false || provenance.cancelled) records.partial = true;
		return records;
	}

	async function searchPoPExact(source, query, ctx) {
		throwIfCancelled(ctx);
		if (!Object.hasOwn(POP_SOURCES, source)) throw new Error("Publish or Perish does not support source: " + source);
		if (typeof ctx.popSearchSource !== "function") throw new Error("Publish or Perish native search is unavailable; install or configure its command-line tool");
		ctx.errors = [];
		ctx.sourceStatus = {};
		delete ctx.popProvenance;
		let result = await ctx.popSearchSource(source, Object.assign({}, query), ctx);
		throwIfCancelled(ctx);
		if (!result || !Array.isArray(result.rows) || result.provenance?.engine !== "publish-or-perish"
			|| result.provenance.source !== source || typeof result.provenance.complete !== "boolean") throw new Error("Invalid Publish or Perish source result or provenance");
		if (result.provenance.cancelled) throw abortError();
		let records = normalizePoPExactRecords(result.rows, source, result.provenance);
		ctx.popProvenance = clonePoPJSON(result.provenance);
		sourceStatus(ctx, source, { retrieved: records.length, scanned: records.length,
			complete: result.provenance.complete === true && !records.partial, cached: result.provenance.cached === true,
			engine: "publish-or-perish", partial: Boolean(records.partial) });
		// Deliberately bypass publishResults: it merges, sorts and caps API records.
		ctx.onResults?.(records, { final: !records.partial, source, engine: "pop", popProvenance: ctx.popProvenance });
		throwIfCancelled(ctx);
		return records;
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
		if (r.arxiv) keys.push("arxiv:" + String(r.arxiv).replace(/v\d+$/i, "").toLowerCase());
		// OpenAlex and Crossref carry an arXiv posting under the DOI arXiv registers for it.
		// Without this the same preprint stays two rows whenever the two titles differ.
		let posted = /^10\.48550\/arxiv\.(.+)$/i.exec(r.doi || "");
		if (posted) keys.push("arxiv:" + posted[1].replace(/v\d+$/i, "").toLowerCase());
		if (r.source && r.sourceId) keys.push("source:" + r.source + ":" + r.sourceId);
		return keys;
	}

	function compatibleIdentity(a, b) {
		return !["doi", "pmid", "pmcid", "arxiv"].some(k => a[k] && b[k] && String(a[k]) !== String(b[k]));
	}

	function sameTitleWork(a, b, title) {
		if (!title || !compatibleIdentity(a, b)) return false;
		if (a.year && b.year && Math.abs(a.year - b.year) > 1) return false;
		let fullName = author => typeof author === "string" ? author : author?.name || [author?.firstName, author?.lastName].filter(Boolean).join(" ");
		let authorA = fullName(a.authors?.[0]), authorB = fullName(b.authors?.[0]);
		let authorsAgree = Boolean(authorA && authorB && Query.matchesAuthor(authorA, [b.authors[0]]) && Query.matchesAuthor(authorB, [a.authors[0]]));
		if (authorA && authorB && !authorsAgree) return false;
		// Generic titles (e.g. Introduction) need corroborating metadata.
		let generic = /^(editorial|editorial board|introduction|acknowledg(e)?ments|preface|foreword|contents|table of contents|references|abstract|summary|conclusion|conclusions|correction|erratum|corrigendum)$/i.test(title);
		if (generic && (!normalizedText(a.venue) || normalizedText(a.venue) !== normalizedText(b.venue))) return false;
		// "Deep learning" by the same author in the same year is a Nature review in one
		// venue and a tutorial in another. A title too short to identify a paper on its
		// own may not be merged over a venue that disagrees.
		let venueA = normalizedText(a.venue), venueB = normalizedText(b.venue);
		let venuesDiffer = Boolean(venueA && venueB && venueA !== venueB);
		return (!generic && (title.length >= 24 || title.split(" ").length >= 3))
			|| Boolean(a.year && a.year === b.year && authorsAgree && !venuesDiffer);
	}

	function sortSearchResults(records, q, fused = false) {
		if (q.sort === "citations") return records.sort((a, b) => (b.citations ?? -1) - (a.citations ?? -1));
		if (q.sort === "date") {
			let date = r => r.publicationDate || (r.year ? String(r.year) : "");
			return records.sort((a, b) => date(a) < date(b) ? 1 : date(a) > date(b) ? -1 : 0);
		}
		let text = (q.title || (fused ? q.keywords : "") || "").trim();
		let exact = /\b(?:AND|OR|NOT|ANDNOT)\b|\w+:/.test(text) ? "" : Query.titleIdentity(text);
		// Native relevance scores have different scales. Fuse source ranks instead,
		// counting each source once, with no citation-count tie breaker.
		let score = r => Object.values(r.sourceRanks || {}).reduce((sum, rank) => sum + 1 / (60 + rank), 0);
		// Worked out once per record, not twice per comparison: a comparator that read the title's identity
		// spent 2 n log n of them on every sort of every streamed page.
		let keys = new Map();
		for (let r of records) if (!keys.has(r)) keys.set(r, { match: exact && Query.titleIdentity(r.titleMarkup || r.title) === exact ? 1 : 0, score: fused ? score(r) : 0 });
		return records.sort((a, b) => {
			let ka = keys.get(a), kb = keys.get(b);
			return kb.match - ka.match || (fused ? kb.score - ka.score : 0);
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
		// An index that names the item a correction, editorial or the like knows more than one that files it as an article.
		if (b.workType && (!a.workType || (NOTICE_TYPES.has(String(b.workType).toLowerCase()) && /^(article|journal-article|review)$/i.test(a.workType)))) a.workType = b.workType;
		// One source saying "retracted" is enough: a missed retraction costs more than a false flag.
		if (b.retracted) a.retracted = true;
		if (!a.publisher && b.publisher) a.publisher = b.publisher;
		// The one source that knows a posting is on bioRxiv must not lose that when it merges
		// with a source that only knows the DOI, or the posting reads as a journal article.
		if (!a.preprintServer && b.preprintServer) a.preprintServer = b.preprintServer;
		/* The type follows the evidence: a record that says "preprint" and names
		   a server, or carries a preprint server's DOI, makes the merged record a
		   preprint whichever source answered first. Europe PMC's bioRxiv posting
		   merged into OpenAlex's journal-article guess stayed an article. */
		const PREPRINT_DOI = /^10\.(1101|21203|48550|20944|31219|31234|36227)\//;
		if (b.itemType === "preprint" && a.itemType !== "preprint" && (b.preprintServer || PREPRINT_DOI.test(normalizeDOI(b.doi) || ""))) {
			a.itemType = "preprint";
			if (!a.preprintServer && b.preprintServer) a.preprintServer = b.preprintServer;
		}
		// An italic species name or a subscript survives whichever copy came first, when both are the same title.
		if (b.titleMarkup && /<(i|em|sub|sup|b|strong)>/i.test(b.titleMarkup) && !/<(i|em|sub|sup|b|strong)>/i.test(a.titleMarkup || "")
			&& Query.titleIdentity(b.titleMarkup) === Query.titleIdentity(a.titleMarkup || a.title)) a.titleMarkup = b.titleMarkup;
		if (!a.publishedDoi && b.publishedDoi) a.publishedDoi = b.publishedDoi;
		if (!a.publishedVenue && b.publishedVenue) a.publishedVenue = b.publishedVenue;
		if (!a.publishedPmid && b.publishedPmid) a.publishedPmid = b.publishedPmid;
		if (!a.journalId && b.journalId) a.journalId = b.journalId;
		if (!a.issn && b.issn) a.issn = b.issn;
		if (!a.citesByYear && b.citesByYear) { a.citesByYear = b.citesByYear; a.citesByYearSeen = b.citesByYearSeen || null; }
		// The JIF and OpenAlex's mean are separate figures, each filled from whichever record has it.
		if (a.journalIF == null && b.journalIF != null) { a.journalIF = b.journalIF; a.journalIFSource = b.journalIFSource; if (b.journalIFAs) a.journalIFAs = b.journalIFAs; }
		if (a.journalOA2y == null && b.journalOA2y != null) a.journalOA2y = b.journalOA2y;
		if (a.journalH == null && b.journalH != null) a.journalH = b.journalH;
		if (!a.volume && b.volume) a.volume = b.volume;
		if (!a.issue && b.issue) a.issue = b.issue;
		if (!a.pages && b.pages) a.pages = b.pages;
		if ((b.abstract || "").length > (a.abstract || "").length) a.abstract = b.abstract;
		// The author list and its completeness flag travel together; a complete list beats a truncated one.
		if ((b.authors || []).length && (a.authorsTruncated && !b.authorsTruncated || (a.authorsTruncated === b.authorsTruncated || !a.authorsTruncated) && (b.authors || []).length > (a.authors || []).length)) {
			a.authors = b.authors; a.authorsTruncated = b.authorsTruncated === true;
		}
		// The source that knows the labs and countries wins; a longer list of bare
		// affiliation strings is not a richer one.
		let placed = people => (people || []).some(p => p.institutionId || p.country);
		if (b.people && (!a.people || (placed(b.people) && !placed(a.people)))) a.people = overlayPeople(a.people, b.people);
		// Each index's own count is kept beside the headline one, so a statistic can be read from one index alone.
		let by = a.citationsBy || (a.citationsBy = {});
		for (let rec of [a, b]) {
			if (rec.citations != null && Number.isFinite(Number(rec.citations))) {
				let key = rec.citationSource || rec.source;
				// Counts only grow: the larger of two answers from one index is the later one, whichever merged first.
				if (key && (by[key] == null || Number(rec.citations) > by[key])) by[key] = Number(rec.citations);
			}
			for (let [key, value] of Object.entries(rec.citationsBy || {})) if (value != null && (by[key] == null || value > by[key])) by[key] = value;
		}
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
				let ids = identityKeys(r), title = Query.titleIdentity(r.titleMarkup || r.title);
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
				// Keep the first entry an identifier reached: root() follows the merges from
				// there, so the outcome no longer depends on the order the sources answered.
				for (let id of ids) if (!byID.has(id)) byID.set(id, entry);
				if (title) {
					if (!byTitle.has(title)) byTitle.set(title, []);
					byTitle.get(title).push(entry);
				}
			}
		}
		return entries.filter(e => !e.mergedInto).map(e => e.record);
	}

	// Keep distinct versions separate, linking only a deposited relation or a strong
	// title/author/date match. A shared generic title is never sufficient evidence.
	function linkPreprintVersions(records) {
		for (let record of records) { delete record.publishedAs; delete record.preprintOf; }
		let byTitle = new Map(), byDoi = new Map(), byPmid = new Map();
		let index = (map, key, record) => { if (key) { if (!map.has(key)) map.set(key, []); map.get(key).push(record); } };
		for (let article of records.filter(r => r.itemType !== "preprint" && r.venue)) {
			index(byTitle, Query.titleIdentity(article.titleMarkup || article.title), article);
			index(byDoi, normalizeDOI(article.doi), article);
			index(byPmid, article.pmid ? String(article.pmid) : null, article);
		}
		for (let pre of records.filter(r => r.itemType === "preprint")) {
			let title = Query.titleIdentity(pre.titleMarkup || pre.title);
			let pool = pre.publishedDoi || pre.publishedPmid
				? [...new Set([...(byDoi.get(normalizeDOI(pre.publishedDoi)) || []), ...(byPmid.get(String(pre.publishedPmid)) || [])])]
				: byTitle.get(title) || [];
			let candidates = pool.filter(pub => {
				let a = normalizeDOI(pre.doi), b = normalizeDOI(pub.doi);
				if (a && a === b) return false;
				if (pre.doi && String(pre.doi).trim().toLowerCase() === String(pub.doi || "").trim().toLowerCase()) return false;
				if (pre.publishedDoi || pre.publishedPmid) return Boolean(
					(pre.publishedDoi && normalizeDOI(pre.publishedDoi) === b)
					|| (pre.publishedPmid && String(pre.publishedPmid) === String(pub.pmid || "")));
				if (!title || title !== Query.titleIdentity(pub.titleMarkup || pub.title) || title.length < 24 || title.split(" ").length < 4) return false;
				if (!pre.year || !pub.year || pub.year < pre.year - 1 || pub.year > pre.year + 5) return false;
				let author = pre.authors?.[0];
				let name = author?.name || [author?.firstName, author?.lastName].filter(Boolean).join(" ");
				return Boolean(name && Query.matchesAuthor(name, pub.authors));
			});
			if (candidates.length === 0 && pre.publishedDoi && pre.publishedVenue) {
				// The journal version is not among the rows; the posting itself says where it appeared.
				pre.publishedAs = { key: null, title: null, doi: pre.publishedDoi, venue: pre.publishedVenue, year: null, basis: "explicit" };
				continue;
			}
			if (candidates.length !== 1) continue;
			let pub = candidates[0];
			// The target's key and why the two were linked, so the UI can jump to the other row
			// and say "estimated" when the link rests on title and authors, not a deposited relation.
			let basis = pre.publishedDoi || pre.publishedPmid ? "explicit" : "title";
			pre.publishedAs = { key: pub.key || null, title: pub.title || null, doi: pub.doi || null, venue: pub.venue || null, year: pub.year || null, basis };
			pub.preprintOf = { key: pre.key || null, title: pre.title || null, doi: pre.doi || null, venue: pre.venue || null, year: pre.year || null, basis };
		}
		return records;
	}

	const MULTI_SOURCES = ["openalex", "crossref", "europepmc", "arxiv"];
	// Google Scholar and OSF have no identifier index, so a pasted DOI stays text there.
	const ID_CAPABLE = new Set(["openalex", "crossref", "pubmed", "europepmc", "arxiv", "semanticscholar"]);
	const IDENTIFIER_SOURCES = new Set([...ID_CAPABLE, "multi", "preprint"]);
	/* The identifier kinds a source can look up, where it cannot look up every kind. In a combined search a
	   source that cannot is not asked: every DOI pasted into the default search said "arXiv can only be
	   searched by an arXiv identifier" and the run was reported as incomplete, with OpenAlex, Crossref and
	   Europe PMC all having found the paper. Asked on its own, such a source still says why it has nothing. */
	const ID_KINDS = { crossref: ["doi", "arxiv"], arxiv: ["arxiv"], pubmed: ["doi", "pmid", "pmcid"] };
	const canLookUp = (key, kind) => !ID_KINDS[key] || ID_KINDS[key].includes(kind);

	// A wider pool lets reciprocal-rank fusion reward agreement below each
	// source's displayed top N. Small searches overfetch threefold; large ones
	// add at most 200 candidates per provider instead of imposing a 200-row cap.

	const STREAM_GAP = 120;
	const poolFor = max => Math.min(PAGE_WALK_LIMIT, Math.max(30, Math.min((max || 200) * 3, (max || 200) + 200)));

	async function searchCombined(q, http, ctx, sources, preprintsOnly = false) {
		if (Query.parseAuthorIdentifier(q.authors)) {
			if (!sources.some(source => source.key === "openalex")) throw new Error("Author identifiers require OpenAlex or Combined search");
			if (sources.length > 1) warn(ctx, "multi", "Author identifier search uses OpenAlex only; the other sources cannot verify this identity.");
			sources = sources.filter(source => source.key === "openalex");
		}
		if (q.identifier) {
			let able = sources.filter(source => !ID_CAPABLE.has(source.key) || canLookUp(source.key, q.identifier.kind));
			if (able.length) sources = able;
		}
		if (!ctx.sourceStatus) ctx.sourceStatus = {};
		let lists = sources.map(() => []), errors = ctx.errors || (ctx.errors = []), done = 0, succeeded = 0;
		// Citation and date ordering are decided over the whole pool too, so the
		// wider pool helps them for the same reason.
		let subQuery = Object.assign({}, q, { maxResults: poolFor(q.maxResults) });
		let snapshot = () => {
			let records = matchingRecords(mergeRecords(lists), q);
			if (preprintsOnly) for (let r of records) r.itemType = "preprint";
			return linkPreprintVersions(sortSearchResults(records, q, true).slice(0, q.maxResults || 200));
		};
		/* Each source reports every page, and each report merged and sorted the whole pool again (four sources,
		   1,400 rows each, for a 1,200-row search). Pages that arrive within STREAM_GAP of the last snapshot
		   wait for one snapshot of them all; the first is shown at once, and none is left behind at the end. */
		let pending = null, lastAt = -Infinity;
		let publishNow = () => { if (pending) { clearTimeout(pending); pending = null; } lastAt = Date.now(); publishResults(snapshot(), q, ctx); };
		let publish = () => {
			if (!ctx.onResults || pending) return;
			let wait = STREAM_GAP - (Date.now() - lastAt);
			if (wait <= 0 || typeof setTimeout !== "function") publishNow();
			else pending = setTimeout(() => { pending = null; publishNow(); }, wait);
		};
		await Promise.allSettled(sources.map(async (source, index) => {
			let sub = Object.assign({}, ctx, {
				enrichCitations: false,
				errors, sourceStatus: ctx.sourceStatus,
				onResults: records => { lists[index] = records; publish(); },
				onProgress: msg => ctx.onProgress?.(`${done}/${sources.length} · ${msg}`, done, sources.length)
			});
			try {
				let providerQuery = source.key === "scholar" ? Object.assign({}, subQuery, { maxResults: Math.min(2000, subQuery.maxResults) }) : subQuery;
				if (providerQuery.identifier && !ID_CAPABLE.has(source.key)) {
					providerQuery = Object.assign({}, providerQuery, { identifier: null, keywords: providerQuery.identifier.raw || "" });
				}
				lists[index] = await source.search(providerQuery, http, sub);
				succeeded++;
			}
			catch (e) {
				// The sub-run's spent budget is the run's: the enrichment after the merge must not ask again.
				if (isQuotaError(e) && /openalex\.org/i.test(String(e.url || "")) || sub.openAlexSpent) ctx.openAlexSpent = true;
				if (e.name !== "AbortError") {
					errors.push(`${SOURCES[source.key].label}: ${e.message}`);
					sourceStatus(ctx, source.key, { retrieved: lists[index].length, truncated: true, reason: "source-error" });
					ctx.log?.(`Search source ${source.key} failed: ${e.message}`);
				}
			}
			finally {
				if (sub.openAlexSpent) ctx.openAlexSpent = true;
				done++;
				publish();
				ctx.onProgress?.(`${done}/${sources.length}`, done, sources.length);
			}
		}));
		// Whatever waited is shown now, before the refill and the citation counts take their time.
		if (pending) publishNow();
		ctx.errors = errors;
		throwIfCancelled(ctx);
		if (!succeeded) throw Object.assign(new Error("All search sources failed: " + errors.join(" / ")), { errors });
		let merged = matchingRecords(mergeRecords(lists), q);
		let pool = subQuery.maxResults;
		while (merged.length < (q.maxResults || 200) && pool < PAGE_WALK_LIMIT) {
			let expandable = sources.map((source, index) => ({ source, index }))
				.filter(({ source, index }) => lists[index].length >= pool && !ctx.sourceStatus[source.key]?.exhausted
					&& !ctx.sourceStatus[source.key]?.truncated && !["scholar", "semanticscholar"].includes(source.key));
			if (!expandable.length) break;
			pool = Math.min(PAGE_WALK_LIMIT, pool * 2);
			for (let { source, index } of expandable) {
				throwIfCancelled(ctx);
				let previous = lists[index];
				try {
					// A refill that comes back shorter than the last pass must not take rows
					// off the screen that the user is already looking at.
					let refilled = await source.search(Object.assign({}, q, { maxResults: pool }), http,
						Object.assign({}, ctx, { enrichCitations: false, onResults: records => { lists[index] = mergeRecords([previous, records]); publish(); } }));
					lists[index] = mergeRecords([previous, refilled]);
				}
				catch (e) {
					if (e.name === "AbortError") throw e;
					warn(ctx, source.key, "Refill stopped: " + e.message);
					// Preserve the prior list and stop retrying this failed continuation.
					sourceStatus(ctx, source.key, { truncated: true, reason: "source-error" });
				}
			}
			merged = matchingRecords(mergeRecords(lists), q);
		}
		if (pending) publishNow();
		if (preprintsOnly) for (let r of merged) r.itemType = "preprint";
		// Citation enrichment can change which records belong in the top N.
		// For relevance/date it cannot, so enrich only the chosen results there.
		if (q.sort !== "citations") merged = sortSearchResults(merged, q, true).slice(0, q.maxResults || 200);
		else if (ctx.enrichCitations !== false) {
			// Every candidate is completed first: OpenAlex's count can lift a paper another index under-counted into the top N.
			await enrichFromOpenAlex(merged, http, ctx, { complete: true });
			merged = sortSearchResults(merged, q, true).slice(0, q.maxResults || 200);
		}
		// The rows shown, and only those, are completed from OpenAlex where another index found them.
		if (ctx.enrichCitations !== false) await enrichFromOpenAlex(merged, http, ctx, { complete: true });
		return linkPreprintVersions(sortSearchResults(merged, q, true).slice(0, q.maxResults || 200));
	}

	async function searchMulti(q, http, ctx) {
		return searchCombined(q, http, ctx, (q.sources || MULTI_SOURCES).map(key => ({ key, search: SOURCES[key].search })));
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
		scholar: { label: "Google Scholar", search: searchScholar, hasCitations: true }
	};
	SOURCES.multi = { label: "Combined (OpenAlex + Crossref + Europe PMC + arXiv)", search: searchMulti, hasCitations: true, multi: true };
	// OpenAlex takes a list of journals natively; the others are asked one journal at a time.
	for (let key of Object.keys(SOURCES)) if (key !== "openalex" && key !== "multi") SOURCES[key].search = perJournal(SOURCES[key].search);

	function dedupe(records) {
		return mergeRecords([records]);
	}

	async function runSearch(sourceKey, query, http, ctx = {}) {
		if (query?.engine === "pop") return searchPoPExact(sourceKey, query, ctx);
		if (query?.engine && query.engine !== "direct") throw new Error("Unknown search engine: " + query.engine);
		let src = SOURCES[sourceKey];
		if (!src) throw new Error("Unknown source: " + sourceKey);
		throwIfCancelled(ctx);
		query = Object.assign({ sort: "relevance", maxResults: 200 }, query);
		for (let key of ["keywords", "title", "authors", "venue"]) query[key] = String(query[key] || "").trim();
		// Several journals: the list is kept (sources fan out over it) and the venue becomes their OR expression for matching.
		query.venues = normalizeVenues(query.venues);
		if (query.venues.length > 1) query.venue = venueExpression(query.venues);
		else if (query.venues.length === 1) query.venue = query.venues[0].name;
		else delete query.venues;
		// A DOI, PMID, PMCID or arXiv id pasted on its own names one paper. Searched as
		// text it named 6,528,758 candidates on Crossref and found none of them.
		let pasted = IDENTIFIER_SOURCES.has(sourceKey) ? identifierQuery(query) : null;
		if (pasted) {
			pasted.raw = query[pasted.field];
			query = Object.assign({}, query, { identifier: pasted, keywords: "", title: "", authors: "", venue: "", venues: undefined });
		}
		if (sourceKey === "multi" && query.sources !== undefined) {
			let allowed = [...MULTI_SOURCES, "pubmed", "semanticscholar", "scholar"];
			if (!Array.isArray(query.sources) || !query.sources.length || query.sources.some(key => !allowed.includes(key))) throw new Error("Combined search requires at least one supported source");
			query.sources = [...new Set(query.sources)];
		}
		if (!hasAny(query)) return [];
		if (!Number.isInteger(query.maxResults) || query.maxResults < 1 || query.maxResults > 2000) throw new Error("Result limit must be an integer from 1 to 2000");
		for (let key of ["yearFrom", "yearTo"]) {
			if (query[key] === 0 || query[key] === "") query[key] = null;
			if (query[key] != null && query[key] !== "" && (!Number.isInteger(query[key]) || query[key] < 1500 || query[key] > 2100)) throw new Error("Invalid publication year");
		}
		if (query.yearFrom && query.yearTo && query.yearFrom > query.yearTo) throw new Error("Start year must not exceed end year");
		let identifier = Query.parseAuthorIdentifier(query.authors);
		if (!identifier && /(?:orcid\.org|openalex\.org|\borcid:|\bopenalex:|\bA\d+\b|\b\d{4}-\d{4}-|\b\d{15}[\dX]\b)/i.test(query.authors)) throw new Error("Invalid or compound author identifier: enter one valid OpenAlex author ID or ORCID with its checksum");
		if (identifier && !["openalex", "multi"].includes(sourceKey)) throw new Error("Author identifiers require OpenAlex or Combined search");
		ctx.errors = [];
		ctx.sourceStatus = {};
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
		// A single source can hold a posting and its journal version too: Europe PMC
		// returned the bioRxiv and the Nature Communications copy of the same paper.
		linkPreprintVersions(recs);
		publishResults(recs, query, ctx);
		if (ctx.journalMetrics !== false) await enrichJournalMetrics(recs, transport, ctx);
		if (ctx.institutionMetrics !== false) await enrichInstitutions(recs, transport, ctx);
		throwIfCancelled(ctx);
		publishResults(recs, query, ctx, true);
		return recs;
	}
	async function search(sourceKey, query, http, ctx = {}) {
		try { return await runSearch(sourceKey, query, http, ctx); }
		finally { FIELD_TEXT.clear(); }
	}

	return {
		SOURCES, POP_SOURCES, search, normalizePoPExactRecords, scholarProfile, scholarAuthors, scholarCitedBy, parseScholarProfilePage, parseScholarAuthorsPage, parseScholarPage, scholarWall, filterRecords: matchingRecords, normalizeVenues, venueExpression, makeRecord, dedupe, mergeRecords, linkPreprintVersions, pubmedYear, searchableSurname, interleave, openAlexAbstract, openAlexAuthorFilter, openAlexAuth, isPlainAuthorQuery, isQuotaError, keywordTerms, matchesKeywords, proxify, needsProxy, viaProxy, proxyLandingURL, epmcQuery, normalizeDOI, parseName, resolveDOIByTitle, withRetry, retryAfterMs, enrichFromOpenAlex, enrichJournalMetrics, enrichInstitutions, parseCountsByYear, seriesSeen, refreshOpenAlexWork, fetchPubMedAbstracts, parsePubMedAbstracts, fetchReferencedWorks, clearWorkCache: () => { WORK_CACHE.clear(); REF_CACHE.clear(); OPENALEX_LOOKUPS.clear(); }, exportCaches, importCaches, checkCitations, journalStats, pdfCandidates,
		titleSimilarity, parseScholarPage, normalizePoPRecords, pubmedTerm, gsQuery, stripTags, decodeEntities
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPSources;

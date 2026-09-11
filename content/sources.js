/*
 * ZotPoP search sources.
 * Environment-agnostic: works inside the Zotero chrome window and in Node (for tests).
 * Every source returns an array of normalized records:
 * {
 *   key, source, sourceId, title, authors: [{firstName,lastName,name}], year, venue, publisher,
 *   doi, pmid, pmcid, arxiv, url, pdfUrl, citations (Number|null), volume, issue, pages,
 *   abstract, itemType ('journalArticle'|'conferencePaper'|'preprint'|'book'|'bookSection'|'thesis'|'report')
 * }
 *
 * `http` adapter: { getJSON(url, headers) -> Promise<Object>, getText(url, headers) -> Promise<String> }
 *   Errors thrown must carry `.status` (HTTP status) when available.
 */
var ZotPoPSources = (function () {
	"use strict";

	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const enc = encodeURIComponent;

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

	function makeRecord(r) {
		let doi = normalizeDOI(r.doi);
		let rec = Object.assign({
			source: "", sourceId: "", title: "", authors: [], year: null, venue: "", publisher: "",
			doi: null, pmid: null, pmcid: null, arxiv: null, url: null, pdfUrl: null, pdfUrls: [], citations: null, citationSource: null, sources: null,
			volume: "", issue: "", pages: "", abstract: "", itemType: "journalArticle"
		}, r, { doi });
		rec.title = stripTags(decodeEntities(rec.title));
		rec.key = rec.source + ":" + (rec.sourceId || rec.doi || rec.title.toLowerCase());
		if (!rec.sources) rec.sources = [rec.source];
		if (rec.citations != null && !rec.citationSource) rec.citationSource = rec.source;
		if (!rec.url && rec.doi) rec.url = "https://doi.org/" + rec.doi;
		if (rec.pdfUrl && !rec.pdfUrls.includes(rec.pdfUrl)) rec.pdfUrls.unshift(rec.pdfUrl);
		rec.pdfUrls = rec.pdfUrls.filter(Boolean);
		return rec;
	}

	async function withRetry(fn, { tries = 4, delay = 1500, retryOn = [429, 500, 502, 503, 504] } = {}) {
		let lastErr;
		for (let i = 0; i < tries; i++) {
			try {
				return await fn();
			}
			catch (e) {
				lastErr = e;
				if (!retryOn.includes(e.status) || i === tries - 1) throw e;
				await sleep(delay * (i + 1));
			}
		}
		throw lastErr;
	}

	function hasAny(q) {
		return Boolean((q.keywords || "").trim() || (q.authors || "").trim() || (q.title || "").trim() || (q.venue || "").trim());
	}

	// ---------------------------------------------------------------- OpenAlex
	function openAlexAbstract(inv) {
		if (!inv) return "";
		let words = [];
		for (let [w, positions] of Object.entries(inv)) {
			for (let p of positions) words[p] = w;
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

	async function searchOpenAlex(q, http, ctx) {
		let params = [];
		let filters = [];
		if (q.keywords?.trim()) params.push("search=" + enc(q.keywords.trim()));
		if (q.title?.trim()) filters.push("title.search:" + enc(q.title.trim()));
		if (q.authors?.trim()) filters.push("raw_author_name.search:" + enc(q.authors.trim()));
		if (q.yearFrom) filters.push("from_publication_date:" + q.yearFrom + "-01-01");
		if (q.yearTo) filters.push("to_publication_date:" + q.yearTo + "-12-31");
		if (q.venue?.trim()) {
			// Resolve the venue to an OpenAlex source id first
			let s = await withRetry(() => http.getJSON("https://api.openalex.org/sources?search=" + enc(q.venue.trim()) + "&per-page=5" + (ctx.email ? "&mailto=" + enc(ctx.email) : "")));
			let ids = (s.results || []).map(x => x.id.replace("https://openalex.org/", ""));
			if (!ids.length) return [];
			filters.push("primary_location.source.id:" + ids.join("|"));
		}
		if (filters.length) params.push("filter=" + filters.join(","));
		if (!params.length) return [];
		let sort = q.sort || "relevance";
		if (sort === "date") params.push("sort=publication_date:desc");
		else if (sort === "citations" || !q.keywords?.trim()) params.push("sort=cited_by_count:desc");
		if (ctx.email) params.push("mailto=" + enc(ctx.email));
		params.push("select=id,doi,title,display_name,publication_year,type,authorships,primary_location,biblio,cited_by_count,open_access,best_oa_location,locations,abstract_inverted_index,ids");

		let max = q.maxResults || 200;
		let out = [];
		let page = 1;
		while (out.length < max) {
			if (ctx.isCancelled?.()) break;
			let perPage = Math.min(200, max - out.length);
			let url = "https://api.openalex.org/works?" + params.join("&") + "&per-page=" + perPage + "&page=" + page;
			let data = await withRetry(() => http.getJSON(url));
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
					year: w.publication_year || null,
					venue: src.display_name || "",
					publisher: src.host_organization_name || "",
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
			ctx.onProgress?.(`OpenAlex: ${out.length} / ${Math.min(max, data.meta?.count ?? max)}`, out.length, Math.min(max, data.meta?.count ?? max));
			if (results.length < perPage || out.length >= (data.meta?.count || 0)) break;
			page++;
		}
		return out.slice(0, max);
	}

	// Batch-lookup citation counts (and OA PDFs) by DOI from OpenAlex. Mutates records.
	async function enrichFromOpenAlex(records, http, ctx) {
		let byDoi = new Map();
		for (let r of records) if (r.doi && r.citations == null) byDoi.set(r.doi, r);
		let dois = [...byDoi.keys()];
		for (let i = 0; i < dois.length; i += 50) {
			if (ctx.isCancelled?.()) break;
			let chunk = dois.slice(i, i + 50);
			let url = "https://api.openalex.org/works?filter=doi:" + chunk.map(enc).join("|") + "&per-page=50&select=doi,ids,cited_by_count,best_oa_location,open_access,locations" + (ctx.email ? "&mailto=" + enc(ctx.email) : "");
			try {
				let data = await withRetry(() => http.getJSON(url));
				for (let w of data.results || []) {
					let r = byDoi.get(normalizeDOI(w.doi));
					if (!r) continue;
					r.citations = toInt(w.cited_by_count);
					if (!r.pdfUrl) r.pdfUrl = w.best_oa_location?.pdf_url || w.open_access?.oa_url || null;
					for (let l of w.locations || []) if (l.is_oa && l.pdf_url && !r.pdfUrls.includes(l.pdf_url)) r.pdfUrls.push(l.pdf_url);
					if (r.pdfUrl && !r.pdfUrls.includes(r.pdfUrl)) r.pdfUrls.unshift(r.pdfUrl);
					if (!r.pmcid) r.pmcid = pmcidFromOpenAlex(w);
				}
			}
			catch (e) {
				ctx.log?.("OpenAlex enrichment failed: " + e.message);
			}
			ctx.onProgress?.(`Citation counts: ${Math.min(i + 50, dois.length)} / ${dois.length}`, i + 50, dois.length);
		}
		return records;
	}

	// ---------------------------------------------------------------- Crossref
	const CROSSREF_TYPES = {
		"journal-article": "journalArticle", "proceedings-article": "conferencePaper", "posted-content": "preprint",
		book: "book", monograph: "book", "edited-book": "book", "book-chapter": "bookSection", dissertation: "thesis", report: "report"
	};

	async function searchCrossref(q, http, ctx) {
		if (!hasAny(q)) return [];
		let params = [];
		if (q.keywords?.trim()) params.push("query=" + enc(q.keywords.trim()));
		if (q.title?.trim()) params.push("query.title=" + enc(q.title.trim()));
		if (q.authors?.trim()) params.push("query.author=" + enc(q.authors.trim()));
		if (q.venue?.trim()) params.push("query.container-title=" + enc(q.venue.trim()));
		let filters = [];
		if (q.yearFrom) filters.push("from-pub-date:" + q.yearFrom);
		if (q.yearTo) filters.push("until-pub-date:" + q.yearTo);
		if (filters.length) params.push("filter=" + filters.join(","));
		if (q.sort === "date") params.push("sort=published", "order=desc");
		else if (q.sort === "citations") params.push("sort=is-referenced-by-count", "order=desc");
		if (ctx.email) params.push("mailto=" + enc(ctx.email));
		params.push("select=DOI,title,author,issued,container-title,publisher,is-referenced-by-count,volume,issue,page,URL,type,abstract,link");

		let max = q.maxResults || 200;
		let out = [];
		let offset = 0;
		while (out.length < max) {
			if (ctx.isCancelled?.()) break;
			let rows = Math.min(100, max - out.length);
			let url = "https://api.crossref.org/works?" + params.join("&") + "&rows=" + rows + "&offset=" + offset;
			let data = await withRetry(() => http.getJSON(url));
			let items = data.message?.items || [];
			for (let w of items) {
				let pdf = (w.link || []).find(l => l["content-type"] === "application/pdf");
				out.push(makeRecord({
					source: "crossref",
					sourceId: w.DOI,
					title: (w.title || [])[0] || "",
					authors: (w.author || []).map(a => a.family ? fromFamilyGiven(a.family, a.given) : parseName(a.name)),
					year: w.issued?.["date-parts"]?.[0]?.[0] || null,
					venue: (w["container-title"] || [])[0] || "",
					publisher: w.publisher || "",
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
			ctx.onProgress?.(`Crossref: ${out.length} / ${Math.min(max, total)}`, out.length, Math.min(max, total));
			if (items.length < rows || out.length >= total) break;
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
		let url = "https://api.crossref.org/works?rows=3&query.bibliographic=" + enc(record.title) + "&select=DOI,title,issued" + (ctx.email ? "&mailto=" + enc(ctx.email) : "");
		let data = await withRetry(() => http.getJSON(url));
		for (let w of data.message?.items || []) {
			let sim = titleSimilarity(record.title, (w.title || [])[0]);
			let y = w.issued?.["date-parts"]?.[0]?.[0];
			if (sim >= 0.85 && (!record.year || !y || Math.abs(y - record.year) <= 1)) {
				record.doi = normalizeDOI(w.DOI);
				return record.doi;
			}
		}
		return null;
	}

	// ---------------------------------------------------------------- Semantic Scholar
	async function searchSemanticScholar(q, http, ctx) {
		let terms = [q.keywords, q.title, q.authors].map(x => (x || "").trim()).filter(Boolean);
		if (!terms.length && !q.venue?.trim()) return [];
		let params = ["query=" + enc(terms.join(" ") || q.venue.trim())];
		if (q.venue?.trim()) params.push("venue=" + enc(q.venue.trim()));
		if (q.yearFrom || q.yearTo) params.push("year=" + (q.yearFrom || "") + "-" + (q.yearTo || ""));
		params.push("fields=externalIds,title,authors,year,venue,journal,citationCount,openAccessPdf,abstract,url,publicationTypes,publicationVenue");
		let headers = ctx.s2ApiKey ? { "x-api-key": ctx.s2ApiKey } : {};

		let max = Math.min(q.maxResults || 200, 1000);
		let out = [];
		let offset = 0;
		while (out.length < max) {
			if (ctx.isCancelled?.()) break;
			let limit = Math.min(100, max - out.length, 1000 - offset);
			if (limit <= 0) break;
			let url = "https://api.semanticscholar.org/graph/v1/paper/search?" + params.join("&") + "&limit=" + limit + "&offset=" + offset;
			let data = await withRetry(() => http.getJSON(url, headers), { tries: 6, delay: 4000 });
			let items = data.data || [];
			for (let p of items) {
				let ext = p.externalIds || {};
				let types = p.publicationTypes || [];
				let itemType = types.includes("Conference") ? "conferencePaper" : types.includes("Book") ? "book" : "journalArticle";
				if (!ext.DOI && ext.ArXiv) itemType = "preprint";
				out.push(makeRecord({
					source: "semanticscholar",
					sourceId: p.paperId,
					title: p.title || "",
					authors: (p.authors || []).map(a => parseName(a.name)),
					year: p.year || null,
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
				}));
			}
			let total = data.total ?? 0;
			ctx.onProgress?.(`Semantic Scholar: ${out.length} / ${Math.min(max, total)}`, out.length, Math.min(max, total));
			if (items.length < limit || data.next == null || out.length >= total) break;
			offset = data.next;
			await sleep(1100); // unauthenticated rate limit ~1 req/s
		}
		return out.slice(0, max);
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
		if (q.keywords?.trim()) parts.push("(" + q.keywords.trim() + ")");
		if (q.title?.trim()) parts.push(q.title.trim().split(/\s+/).map(w => w + "[ti]").join(" AND "));
		if (q.authors?.trim()) parts.push(q.authors.trim().split(/\s*;\s*|\s+and\s+/i).map(a => a + "[au]").join(" AND "));
		if (q.venue?.trim()) parts.push('"' + q.venue.trim() + '"[ta]');
		if (q.yearFrom || q.yearTo) parts.push((q.yearFrom || "1800") + ":" + (q.yearTo || "3000") + "[dp]");
		return parts.join(" AND ");
	}

	async function searchPubMed(q, http, ctx) {
		if (!hasAny(q)) return [];
		let max = q.maxResults || 200;
		let base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
		let tool = "&tool=zotpop" + (ctx.email ? "&email=" + enc(ctx.email) : "");
		let sort = q.sort === "date" ? "pub_date" : "relevance";
		let es = await withRetry(() => http.getJSON(base + "esearch.fcgi?db=pubmed&retmode=json&sort=" + sort + "&retmax=" + max + "&term=" + enc(pubmedTerm(q)) + tool));
		let ids = es.esearchresult?.idlist || [];
		let total = toInt(es.esearchresult?.count) || ids.length;
		let out = [];
		for (let i = 0; i < ids.length; i += 200) {
			if (ctx.isCancelled?.()) break;
			let chunk = ids.slice(i, i + 200);
			await sleep(350);
			let sum = await withRetry(() => http.getJSON(base + "esummary.fcgi?db=pubmed&retmode=json&id=" + chunk.join(",") + tool));
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
			ctx.onProgress?.(`PubMed: ${out.length} / ${Math.min(max, total)}`, out.length, Math.min(max, total));
		}
		if (ctx.enrichCitations !== false) await enrichFromOpenAlex(out, http, ctx);
		return out.slice(0, max);
	}

	// ---------------------------------------------------------------- arXiv
	function xmlText(block, tag) {
		let m = block.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">"));
		return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
	}

	async function searchArxiv(q, http, ctx) {
		let parts = [];
		if (q.keywords?.trim()) parts.push("all:" + q.keywords.trim().split(/\s+/).map(w => w).join(" AND all:"));
		if (q.title?.trim()) parts.push(q.title.trim().split(/\s+/).map(w => "ti:" + w).join(" AND "));
		if (q.authors?.trim()) parts.push(q.authors.trim().split(/\s*;\s*|\s+and\s+/i).map(a => 'au:"' + a + '"').join(" AND "));
		if (q.venue?.trim()) parts.push('jr:"' + q.venue.trim() + '"');
		if (!parts.length) return [];
		if (q.yearFrom || q.yearTo) parts.push("submittedDate:[" + (q.yearFrom || "1990") + "01010000 TO " + (q.yearTo || "2100") + "12312359]");
		let query = parts.map(p => "(" + p + ")").join(" AND ");
		let max = q.maxResults || 200;
		let out = [];
		let start = 0;
		let total = null;
		while (out.length < max) {
			if (ctx.isCancelled?.()) break;
			let n = Math.min(100, max - out.length);
			let url = "https://export.arxiv.org/api/query?search_query=" + enc(query) + "&start=" + start + "&max_results=" + n + (q.sort === "date" ? "&sortBy=submittedDate&sortOrder=descending" : "&sortBy=relevance");
			let xml = await withRetry(() => http.getText(url), { tries: 5, delay: 4000 });
			if (total == null) total = toInt(xmlText(xml, "opensearch:totalResults")) ?? 0;
			let entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
			for (let e of entries) {
				let idUrl = xmlText(e, "id");
				let arxivId = idUrl.replace(/^.*\/abs\//, "").replace(/v\d+$/, "");
				let authors = [...e.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g)].map(m => parseName(decodeEntities(m[1])));
				let doi = xmlText(e, "arxiv:doi");
				let pdf = (e.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/) || [])[1] || ("https://arxiv.org/pdf/" + arxivId);
				out.push(makeRecord({
					source: "arxiv",
					sourceId: arxivId,
					title: xmlText(e, "title"),
					authors,
					year: yearOf(xmlText(e, "published")),
					venue: xmlText(e, "arxiv:journal_ref") || "arXiv",
					doi: doi || null,
					arxiv: arxivId,
					url: "https://arxiv.org/abs/" + arxivId,
					pdfUrl: pdf,
					citations: null,
					abstract: xmlText(e, "summary"),
					itemType: doi ? "journalArticle" : "preprint"
				}));
			}
			ctx.onProgress?.(`arXiv: ${out.length} / ${Math.min(max, total)}`, out.length, Math.min(max, total));
			if (entries.length < n || out.length >= total) break;
			start += n;
			await sleep(3000); // arXiv asks for 3 s between requests
		}
		if (ctx.enrichCitations !== false) await enrichFromOpenAlex(out, http, ctx);
		return out.slice(0, max);
	}

	// ---------------------------------------------------------------- Europe PMC
	// Indexes PubMed + PMC and, crucially, the preprint servers: bioRxiv, medRxiv
	// and Research Square. Used both as a general source and as the preprint source.
	const PREPRINT_PUBLISHERS = /biorxiv|medrxiv|research\s*square|ssrn|preprints\.org|authorea|chemrxiv/i;

	function epmcQuery(q, preprintsOnly) {
		let parts = [];
		if (q.keywords?.trim()) parts.push("(" + q.keywords.trim() + ")");
		if (q.title?.trim()) parts.push('TITLE:"' + q.title.trim().replace(/"/g, "") + '"');
		if (q.authors?.trim()) {
			for (let a of q.authors.trim().split(/\s*;\s*|\s+and\s+/i)) parts.push('AUTH:"' + a.replace(/"/g, "") + '"');
		}
		if (q.venue?.trim()) {
			let v = q.venue.trim().replace(/"/g, "");
			parts.push(preprintsOnly ? '(PUBLISHER:"' + v + '" OR JOURNAL:"' + v + '")' : 'JOURNAL:"' + v + '"');
		}
		if (q.yearFrom || q.yearTo) parts.push("PUB_YEAR:[" + (q.yearFrom || 1800) + " TO " + (q.yearTo || 3000) + "]");
		if (preprintsOnly) parts.push("SRC:PPR");
		return parts.join(" AND ");
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
		return makeRecord({
			source: "europepmc",
			sourceId: r.id,
			title: r.title || "",
			authors,
			year: toInt(r.pubYear) || yearOf(r.firstPublicationDate),
			venue: r.journalInfo?.journal?.title || r.journalTitle || publisher || (isPreprint ? "Preprint" : ""),
			publisher,
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
		let cursor = "*";
		while (out.length < max) {
			if (ctx.isCancelled?.()) break;
			let pageSize = Math.min(100, max - out.length);
			let url = "https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core"
				+ "&pageSize=" + pageSize + "&cursorMark=" + enc(cursor) + sort + "&query=" + enc(query);
			let data = await withRetry(() => http.getJSON(url));
			let items = data.resultList?.result || [];
			for (let r of items) out.push(epmcRecord(r));
			let total = toInt(data.hitCount) ?? out.length;
			ctx.onProgress?.(`${preprintsOnly ? "Preprints" : "Europe PMC"}: ${out.length} / ${Math.min(max, total)}`, out.length, Math.min(max, total));
			let next = data.nextCursorMark;
			if (!items.length || !next || next === cursor || out.length >= total) break;
			cursor = next;
		}
		return out.slice(0, max);
	}

	// bioRxiv / medRxiv / Research Square (via Europe PMC) plus arXiv, merged
	async function searchPreprints(q, http, ctx) {
		let [epmc, arx] = await Promise.allSettled([
			searchEuropePMC(q, http, ctx, true),
			searchArxiv(Object.assign({}, q), http, Object.assign({}, ctx, { enrichCitations: false }))
		]);
		let errors = [];
		if (epmc.status === "rejected") errors.push("Europe PMC: " + epmc.reason.message);
		if (arx.status === "rejected") errors.push("arXiv: " + arx.reason.message);
		let merged = mergeRecords([epmc.value || [], arx.value || []]);
		for (let r of merged) if (!r.itemType || r.itemType === "journalArticle") r.itemType = "preprint";
		if (ctx.enrichCitations !== false) await enrichFromOpenAlex(merged, http, ctx);
		if (q.sort === "date") merged.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
		else merged.sort((a, b) => (b.citations ?? -1) - (a.citations ?? -1));
		ctx.errors = errors;
		return merged.slice(0, q.maxResults || 200);
	}

	// ---------------------------------------------------------------- Google Scholar (experimental)
	function gsQuery(q) {
		let parts = [];
		if (q.keywords?.trim()) parts.push(q.keywords.trim());
		if (q.title?.trim()) parts.push("allintitle:" + q.title.trim());
		if (q.authors?.trim()) parts.push(q.authors.trim().split(/\s*;\s*|\s+and\s+/i).map(a => 'author:"' + a + '"').join(" "));
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
				let m = link.textContent.match(/Cited by (\d+)/i);
				if (m) { cites = parseInt(m[1], 10); break; }
			}
			if (cites == null && /Cited by/i.test(div.textContent)) cites = 0;
			if (cites == null) cites = 0;
			let pdfA = div.querySelector(".gs_or_ggsm a, .gs_ggs a");
			let clusterId = (div.getAttribute("data-cid") || div.querySelector("[data-cid]")?.getAttribute("data-cid") || "").trim();
			recs.push(makeRecord({
				source: "scholar",
				sourceId: clusterId || title.toLowerCase(),
				title,
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
		if (typeof ctx.DOMParser !== "function") throw new Error("Google Scholar requires a DOM parser");
		let query = gsQuery(q);
		if (!query) return [];
		let max = q.maxResults || 100;
		let out = [];
		let start = 0;
		while (out.length < max) {
			if (ctx.isCancelled?.()) break;
			let url = "https://scholar.google.com/scholar?hl=en&as_sdt=0,5&num=20" + (q.sort === "date" ? "&scisbd=1" : "") + "&q=" + enc(query)
				+ (q.yearFrom ? "&as_ylo=" + q.yearFrom : "") + (q.yearTo ? "&as_yhi=" + q.yearTo : "") + "&start=" + start;
			let html = await http.getText(url, { "Accept-Language": "en-US,en;q=0.9" });
			let recs = parseScholarPage(html, ctx.DOMParser);
			if (!recs.length) break;
			out.push(...recs);
			ctx.onProgress?.(`Google Scholar: ${out.length}`, out.length, max);
			if (recs.length < 10) break;
			start += 20;
			await sleep(2500 + Math.random() * 2000);
		}
		return out.slice(0, max);
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
	function recordKey(r) {
		return r.doi ? "doi:" + r.doi : "t:" + r.title.toLowerCase().replace(/[^a-z0-9]+/g, "");
	}

	// Fold b into a, keeping the richest field from either
	function mergeInto(a, b) {
		if (!a.doi && b.doi) a.doi = b.doi;
		if (!a.pmid && b.pmid) a.pmid = b.pmid;
		if (!a.pmcid && b.pmcid) a.pmcid = b.pmcid;
		if (!a.arxiv && b.arxiv) a.arxiv = b.arxiv;
		if (!a.url && b.url) a.url = b.url;
		if (!a.year && b.year) a.year = b.year;
		if (!a.venue && b.venue) a.venue = b.venue;
		if (!a.publisher && b.publisher) a.publisher = b.publisher;
		if (!a.volume && b.volume) a.volume = b.volume;
		if (!a.issue && b.issue) a.issue = b.issue;
		if (!a.pages && b.pages) a.pages = b.pages;
		if ((b.abstract || "").length > (a.abstract || "").length) a.abstract = b.abstract;
		if ((b.authors || []).length > (a.authors || []).length) a.authors = b.authors;
		if (b.citations != null && (a.citations == null || b.citations > a.citations)) {
			a.citations = b.citations;
			a.citationSource = b.source;
		}
		for (let u of b.pdfUrls || []) if (!a.pdfUrls.includes(u)) a.pdfUrls.push(u);
		if (!a.pdfUrl && b.pdfUrl) a.pdfUrl = b.pdfUrl;
		if (!a.sources.includes(b.source)) a.sources.push(b.source);
		return a;
	}

	function mergeRecords(lists) {
		let byKey = new Map();
		let out = [];
		for (let list of lists) {
			for (let r of list) {
				if (!r.sources) r.sources = [r.source];
				if (r.citations != null && !r.citationSource) r.citationSource = r.source;
				let k = recordKey(r);
				let existing = byKey.get(k);
				if (existing) mergeInto(existing, r);
				else { byKey.set(k, r); out.push(r); }
			}
		}
		return out;
	}

	const MULTI_SOURCES = ["openalex", "crossref", "europepmc", "arxiv"];

	async function searchMulti(q, http, ctx) {
		let done = 0;
		let errors = [];
		let settled = await Promise.allSettled(MULTI_SOURCES.map(async (key) => {
			let sub = Object.assign({}, ctx, {
				enrichCitations: false,
				onProgress: (msg) => ctx.onProgress?.(`${done}/${MULTI_SOURCES.length} \uC644\uB8CC \u00B7 ${msg}`, done, MULTI_SOURCES.length)
			});
			try {
				let recs = await SOURCES[key].search(q, http, sub);
				done++;
				ctx.onProgress?.(`${done}/${MULTI_SOURCES.length} \uC644\uB8CC`, done, MULTI_SOURCES.length);
				return recs;
			}
			catch (e) {
				done++;
				errors.push(`${SOURCES[key].label}: ${e.message}`);
				ctx.log?.(`multi-source ${key} failed: ${e.message}`);
				return [];
			}
		}));
		let merged = mergeRecords(settled.map(s => s.value || []));
		if (ctx.enrichCitations !== false) await enrichFromOpenAlex(merged, http, ctx);
		merged.sort((a, b) => (b.citations ?? -1) - (a.citations ?? -1));
		ctx.errors = errors;
		return merged.slice(0, q.maxResults || 200);
	}

	// ---------------------------------------------------------------- registry
	const SOURCES = {
		openalex: { label: "OpenAlex", search: searchOpenAlex, hasCitations: true },
		crossref: { label: "Crossref", search: searchCrossref, hasCitations: true },
		semanticscholar: { label: "Semantic Scholar", search: searchSemanticScholar, hasCitations: true },
		pubmed: { label: "PubMed", search: searchPubMed, hasCitations: false },
		europepmc: { label: "Europe PMC (articles + preprints)", search: searchEuropePMC, hasCitations: true },
		preprint: { label: "Preprints (bioRxiv, medRxiv, Research Square, arXiv)", search: searchPreprints, hasCitations: true },
		arxiv: { label: "arXiv", search: searchArxiv, hasCitations: false },
		scholar: { label: "Google Scholar (experimental)", search: searchScholar, hasCitations: true }
	};
	SOURCES.multi = { label: "Combined (OpenAlex + Crossref + Europe PMC + arXiv)", search: searchMulti, hasCitations: true, multi: true };

	function dedupe(records) {
		let seen = new Set();
		let out = [];
		for (let r of records) {
			let k = r.doi ? "doi:" + r.doi : "t:" + r.title.toLowerCase().replace(/[^a-z0-9]+/g, "");
			if (seen.has(k)) continue;
			seen.add(k);
			out.push(r);
		}
		return out;
	}

	async function search(sourceKey, query, http, ctx = {}) {
		let src = SOURCES[sourceKey];
		if (!src) throw new Error("Unknown source: " + sourceKey);
		let recs = await src.search(query, http, ctx);
		return dedupe(recs);
	}

	return {
		SOURCES, search, dedupe, mergeRecords, pubmedYear, proxify, needsProxy, proxyLandingURL, epmcQuery, normalizeDOI, parseName, resolveDOIByTitle, enrichFromOpenAlex, pdfCandidates,
		titleSimilarity, parseScholarPage, pubmedTerm, gsQuery, stripTags, decodeEntities
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPSources;

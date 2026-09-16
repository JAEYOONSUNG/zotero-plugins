import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";

const SOURCE_NAMES = {
	popgscholar: "scholar", popgoogle: "scholar", googlescholar: "scholar", scholar: "scholar",
	popcrossref: "crossref", crossref: "crossref", poppubmed: "pubmed", pubmed: "pubmed",
	popopenalex: "openalex", openalex: "openalex", popsemanticscholar: "semanticscholar",
	popsemantic: "semanticscholar", semanticscholar: "semanticscholar"
};

export function normalizeSource(value) {
	const key = String(value ?? "").toLowerCase().replace(/[^a-z]/g, "");
	return SOURCE_NAMES[key] || key;
}

export function canonicalDOI(value) {
	if (typeof value !== "string") return null;
	let doi = value.trim().replace(/^doi:\s*/i, "");
	if (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(doi)) {
		try { doi = decodeURIComponent(new URL(doi).pathname.slice(1)); } catch { return null; }
	}
	return /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi.toLowerCase() : null;
}

function decodeText(value) {
	return String(value ?? "").replace(/<[^>]*>/g, "").replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity) => {
		if (entity[0] === "#") {
			const code = Number.parseInt(entity.slice(entity[1].toLowerCase() === "x" ? 2 : 1), entity[1].toLowerCase() === "x" ? 16 : 10);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
		}
		return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[entity.toLowerCase()];
	});
}

// Exact normalized text only. Mathematical symbols are retained: A+ and A− are distinct.
export function normalizedTitle(value) {
	return decodeText(value).normalize("NFKC").toLowerCase().replace(/['’ʼ]/g, "")
		.replace(/(^|[\s(=<>])([-+])\s*(?=\d)/g, (_, lead, sign) => `${lead} ${sign === "-" ? "minussign" : "plussign"} `)
		.replace(/([\p{L}]+\d+)-(?=\s|$)/gu, "$1 negativesuffix ")
		.match(/[\p{L}\p{M}]+|\d+(?:[.,]\d+)*|[\p{Sm}%!/⁄^]/gu)?.join(" ") || "";
}

function numeric(value) {
	if (value === null || value === undefined || value === "") return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

function isoTime(value) {
	if (!value) return null;
	const time = typeof value === "number" ? value * (value < 1e12 ? 1000 : 1) : value;
	const date = new Date(time);
	return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function normalizeRecord(row, index = 0, source = "") {
	if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Invalid record at index ${index}`);
	const title = decodeText(Array.isArray(row.title) ? row.title[0] : row.title).trim();
	const authors = (Array.isArray(row.authors) ? row.authors : []).map(author => {
		if (typeof author === "string") return { name: author };
		return { ...author, name: author?.name || [author?.firstName || author?.given, author?.lastName || author?.family].filter(Boolean).join(" ") };
	});
	const doi = canonicalDOI(row.doi || row.DOI) || canonicalDOI(row.article_url || row.url);
	return {
		...row, title, doi, authors, source: normalizeSource(source || row.source),
		sourceId: String(row.sourceId || row.uid || ""), venue: String(row.venue ?? (row.uid || row.article_url || row.cites !== undefined ? row.source : "") ?? ""),
		url: row.url || row.article_url || null, year: numeric(row.year), citations: numeric(row.citations ?? row.cites),
		rank: numeric(row.rank) ?? index + 1, originalIndex: index
	};
}

const RAW_QUERY_FIELDS = {
	keywords: ["KeyWords", "Keywords"], authors: ["Author", "Authors"], title: ["Title"],
	venue: ["Publication", "PublicationName", "Journal", "Source"], excludes: ["ExcludeWords", "Exclude", "Excludes"],
	yearFrom: ["YearFrom"], yearTo: ["YearTo"], maxResults: ["MaxResults"],
	includeCitations: ["IncludeCitations"], includePatents: ["IncludePatents"], onlyReviews: ["OnlyReviews"]
};
const RETRIEVAL_ORDERS = new Set(["relevance", "date", "citations"]);
const RAW_METADATA_FIELDS = new Set([
	"$type", "Name", "QueryTime", "CacheTime", "LastResult", "LastSubResult", "ErrorDetails",
	"Sort", "SortBy", "SortOrder", ...Object.values(RAW_QUERY_FIELDS).flat()
]);
const nonemptyCondition = value => value !== undefined && value !== null && value !== false && value !== 0
	&& (typeof value === "string" ? value.trim().length > 0 : typeof value === "object" ? Object.keys(value).length > 0 : true);

// This evidence must describe the provider's retrieval order. PoP --sort/rank is an
// output ordering option and cannot establish the provider's selected result set.
function verifiedRetrievalOrder(provenance, source) {
	const order = provenance?.retrievalOrder;
	if (!order || order.verified !== true || !RETRIEVAL_ORDERS.has(order.sort)
		|| typeof order.evidence !== "string" || !order.evidence.trim()
		|| provenance.source && normalizeSource(provenance.source) !== source) return null;
	return { sort: order.sort, verified: true, evidence: order.evidence.trim() };
}

export function parsePoPReference(input, { provenance: suppliedProvenance } = {}) {
	let document = typeof input === "string" || Buffer.isBuffer(input) ? JSON.parse(String(input).replace(/^\uFEFF/, "")) : input;
	if (Array.isArray(document) && suppliedProvenance) document = { records: document, provenance: suppliedProvenance };
	if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("Reference must be a PoP JSON object or a records/provenance wrapper");
	const raw = Object.hasOwn(document, "$query") && Object.hasOwn(document, "$results");
	let provenance, query, source, rows, errors;
	const unsupportedQueryFields = [];
	if (raw) {
		const metadata = document.$query;
		if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Invalid PoP $query");
		source = normalizeSource(metadata.$type);
		query = {};
		for (const [key, aliases] of Object.entries(RAW_QUERY_FIELDS)) {
			const alias = aliases.find(name => Object.hasOwn(metadata, name));
			if (alias) query[key] = metadata[alias];
			for (const name of aliases) {
				if (name !== alias && nonemptyCondition(metadata[name]) && String(metadata[name]).trim() !== String(metadata[alias] ?? "").trim()) unsupportedQueryFields.push(name);
			}
		}
		for (const [name, value] of Object.entries(metadata)) {
			if (!RAW_METADATA_FIELDS.has(name) && nonemptyCondition(value)) unsupportedQueryFields.push(name);
		}
		const retrievalOrder = verifiedRetrievalOrder(suppliedProvenance, source);
		if (retrievalOrder) query.sort = retrievalOrder.sort;
		errors = [];
		if (metadata.ErrorDetails) errors.push(String(metadata.ErrorDetails));
		for (const name of ["LastResult", "LastSubResult"]) {
			if (metadata[name] !== undefined && Number(metadata[name]) !== 0) errors.push(`${name}: ${metadata[name]}`);
		}
		if (!Object.hasOwn(metadata, "LastResult")) errors.push("Missing PoP completion state (LastResult)");
		const queryTime = isoTime(metadata.QueryTime);
		const cacheTime = isoTime(metadata.CacheTime);
		const observed = [queryTime, cacheTime].filter(Boolean).sort();
		provenance = { tool: "Publish or Perish", format: "pop-json", source, queryTime, cacheTime,
			capturedAt: observed[0] || null, completed: errors.length === 0, retrievalOrder,
			rawQuery: metadata, metrics: document.$metrics || null };
		rows = document.$results;
	} else {
		provenance = document.provenance;
		if (!provenance || !/publish\s+or\s+perish/i.test(provenance.tool || "")) throw new Error("Normalized reference requires Publish or Perish provenance");
		if (!provenance.query || typeof provenance.query !== "object") throw new Error("Normalized reference requires provenance.query");
		source = normalizeSource(provenance.source);
		query = { ...provenance.query };
		errors = Array.isArray(document.errors) ? document.errors.map(String) : [];
		if (provenance.exitCode !== undefined && provenance.exitCode !== 0) errors.push(`exitCode: ${provenance.exitCode}`);
		provenance = { ...provenance, capturedAt: isoTime(provenance.capturedAt) };
		rows = document.records;
	}
	if (!Array.isArray(rows)) throw new Error("PoP reference results must be an array");
	const records = rows.map((row, index) => normalizeRecord(row, index, source)).sort((a, b) => a.rank - b.rank || a.originalIndex - b.originalIndex);
	return { source, query, records, provenance, errors, unsupportedQueryFields, rawCount: rows.length };
}

export async function loadPoPReference(path, { provenance: suppliedProvenance } = {}) {
	const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
	const document = JSON.parse(String(bytes).replace(/^\uFEFF/, ""));
	let provenance = suppliedProvenance;
	if (!provenance && (Array.isArray(document) || Object.hasOwn(document || {}, "$query"))) {
		try { provenance = JSON.parse((await readFile(`${path}.provenance.json`, "utf8")).replace(/^\uFEFF/, "")); }
		catch (error) {
			if (Array.isArray(document) || error.code !== "ENOENT") throw new Error(`PoP reference requires readable provenance at ${path}.provenance.json: ${error.message}`);
		}
	}
	const parsed = parsePoPReference(document, { provenance });
	parsed.provenance = { ...parsed.provenance, path, fileModifiedAt: info.mtime.toISOString(), sha256: createHash("sha256").update(bytes).digest("hex") };
	return parsed;
}

function summary(record, index) {
	return { index, rank: record.rank, doi: canonicalDOI(record.doi), title: record.title, year: record.year, sourceId: record.sourceId };
}

export function compareRecords(reference, candidate) {
	const used = new Set(), matched = new Map(), conflicts = [], titleDOIs = new Map();
	for (const record of [...reference, ...candidate]) {
		const title = normalizedTitle(record.title), doi = canonicalDOI(record.doi);
		if (title && doi) {
			if (!titleDOIs.has(title)) titleDOIs.set(title, new Set());
			titleDOIs.get(title).add(doi);
		}
	}
	// Resolve all DOI matches before title fallbacks can consume a DOI match's candidate.
	for (const [ri, ref] of reference.entries()) {
		const doi = canonicalDOI(ref.doi);
		if (!doi) continue;
		const ci = candidate.findIndex((rec, index) => !used.has(index) && canonicalDOI(rec.doi) === doi);
		if (ci >= 0) { used.add(ci); matched.set(ri, { referenceIndex: ri, candidateIndex: ci, method: "doi" }); }
	}
	for (const [ri, ref] of reference.entries()) {
		const title = normalizedTitle(ref.title);
		if (!title) continue;
		const doi = canonicalDOI(ref.doi);
		for (const [ci, rec] of candidate.entries()) {
			if (normalizedTitle(rec.title) !== title) continue;
			const candidateDOI = canonicalDOI(rec.doi);
			if (doi && candidateDOI && doi !== candidateDOI) {
				conflicts.push({ reason: "different-explicit-dois", reference: summary(ref, ri), candidate: summary(rec, ci) });
				continue;
			}
			if (matched.has(ri) || used.has(ci)) continue;
			if ((titleDOIs.get(title)?.size || 0) > 1 && (!doi || !candidateDOI)) continue;
			if (ref.year && rec.year && Number(ref.year) !== Number(rec.year)) continue;
			if (["pmid", "pmcid", "arxiv"].some(field => ref[field] && rec[field] && String(ref[field]).toLowerCase() !== String(rec[field]).toLowerCase())) continue;
			used.add(ci);
			matched.set(ri, { referenceIndex: ri, candidateIndex: ci, method: "exact-title" });
		}
	}
	const matches = [...matched.values()].sort((a, b) => a.referenceIndex - b.referenceIndex);
	const count = matches.length;
	return { referenceCount: reference.length, candidateCount: candidate.length, matched: count,
		recall: reference.length ? count / reference.length : null,
		candidateOverlap: candidate.length ? count / candidate.length : null,
		jaccard: reference.length + candidate.length - count ? count / (reference.length + candidate.length - count) : null,
		doiMatches: matches.filter(match => match.method === "doi").length,
		titleMatches: matches.filter(match => match.method === "exact-title").length,
		matches: matches.map(match => ({ ...match, reference: summary(reference[match.referenceIndex], match.referenceIndex), candidate: summary(candidate[match.candidateIndex], match.candidateIndex) })),
		misses: reference.flatMap((record, index) => matched.has(index) ? [] : [summary(record, index)]),
		candidateOnly: candidate.flatMap((record, index) => used.has(index) ? [] : [summary(record, index)]),
		identityConflicts: conflicts };
}

const TEXT_FIELDS = ["keywords", "authors", "title", "venue", "excludes"];
const FLAGS = ["includeCitations", "includePatents", "onlyReviews"];
const queryText = value => String(value || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
const calendarDate = (date, timeZone) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

export function assessReference(reference, spec, { now = new Date(), maxReferenceAgeHours = 24, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
	const reasons = [];
	if (!reference) return { comparable: false, reasons: ["missing-reference"] };
	if (reference.source !== normalizeSource(spec.source)) reasons.push("different-source");
	if (!reference.records.length) reasons.push("empty-reference");
	if (reference.errors.length || reference.provenance.completed !== true) reasons.push("incomplete-reference");
	for (const field of reference.unsupportedQueryFields || []) reasons.push(`unsupported-raw-query-condition:${field}`);
	const captured = new Date(reference.provenance.capturedAt || NaN), current = new Date(now);
	if (!Number.isFinite(captured.getTime())) reasons.push("missing-reference-time");
	else {
		const age = current - captured;
		if (age < -300000) reasons.push("future-reference-time");
		if (age > maxReferenceAgeHours * 3600000 || calendarDate(captured, timeZone) !== calendarDate(current, timeZone)) reasons.push("stale-reference");
	}
	const ref = reference.query || {}, query = spec.query || {};
	for (const key of TEXT_FIELDS) if (queryText(ref[key]) !== queryText(query[key])) reasons.push(`different-query:${key}`);
	for (const key of ["yearFrom", "yearTo"]) if (Number(ref[key] || 0) !== Number(query[key] || 0)) reasons.push(`different-query:${key}`);
	if (!Number.isInteger(Number(ref.maxResults)) || Number(ref.maxResults) < 1) reasons.push("missing-reference-cap");
	else if (Number(ref.maxResults) !== Number(query.maxResults)) reasons.push("different-query:maxResults");
	if (!RETRIEVAL_ORDERS.has(ref.sort)) reasons.push("missing-reference-retrieval-order");
	else if (ref.sort !== (query.sort || "relevance")) reasons.push("different-query:sort");
	for (const key of FLAGS) {
		if (ref[key] !== undefined || query[key] !== undefined) {
			if (ref[key] === undefined || query[key] === undefined || ref[key] !== query[key]) reasons.push(`different-query:${key}`);
		}
	}
	return { comparable: reasons.length === 0, reasons, source: reference.source, query: reference.query,
		provenance: reference.provenance, rawCount: reference.rawCount };
}

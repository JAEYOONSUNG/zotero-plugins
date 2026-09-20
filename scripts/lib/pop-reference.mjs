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

function decodeEntities(value) {
	return String(value ?? "").replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity) => {
		if (entity[0] === "#") {
			const code = Number.parseInt(entity.slice(entity[1].toLowerCase() === "x" ? 2 : 1), entity[1].toLowerCase() === "x" ? 16 : 10);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
		}
		return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[entity.toLowerCase()];
	});
}

function decodeText(value) {
	// Strip only recognized formatting tags. A scientific inequality such as
	// `p < 0.05 and q > 0.1` is text, not an HTML element.
	return decodeEntities(value).replace(/<\/?(?:i|b|em|strong|sup|sub|scp|span|p|br|jats:italic|jats:sup|jats:sub)(?:\s+[^<>]*?)?\s*\/?>/gi, "");
}

function scriptText(kind, value) {
	return [...String(value).normalize("NFKC")].map(char => /\s/.test(char) ? " "
		: ` ${kind} ${{ "-": "minussign", "−": "minussign", "+": "plussign", "=": "equalssign" }[char] || char} `).join("");
}

// Exact normalized text only. Mathematical symbols are retained: A+ and A− are distinct.
export function normalizedTitle(value) {
	const semantic = decodeEntities(value).replace(/<(?:jats:)?(sup|sub)(?:\s+[^<>]*?)?\s*>([\s\S]*?)<\/(?:jats:)?\1\s*>/gi,
		(_, kind, content) => scriptText(kind.toLowerCase() === "sup" ? "superscript" : "subscript", decodeText(content)))
		.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁱⁿ]/g, char => scriptText("superscript", char))
		.replace(/[₀-₎ₐ-ₜ]/g, char => scriptText("subscript", char));
	return decodeText(semantic)
		.normalize("NFKC").toLowerCase().replace(/['’ʼ]/g, "")
		.replace(/−/g, "-")
		.replace(/(^|[\s(=<>^/])([-+])\s*(?=\d)/g, (_, lead, sign) => `${lead} ${sign === "-" ? "−" : "+"} `)
		.replace(/([\p{L}\p{N}])-(?=\s|$|[,;:)])/gu, "$1 − ")
		.replace(/-(?=\d)/g, " − ")
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
	const originalTitle = row.titleMarkup || (Array.isArray(row.title) ? row.title[0] : row.title);
	const title = decodeText(originalTitle).trim();
	const titleMarkup = /<\/?(?:jats:)?(?:sup|sub)(?:\s|>)/i.test(decodeEntities(originalTitle)) ? decodeEntities(originalTitle).trim() : null;
	const authors = (Array.isArray(row.authors) ? row.authors : []).map(author => {
		if (typeof author === "string") return { name: author };
		return { ...author, name: author?.name || [author?.firstName || author?.given, author?.lastName || author?.family].filter(Boolean).join(" ") };
	});
	const doi = canonicalDOI(row.doi || row.DOI) || canonicalDOI(row.article_url || row.url);
	return {
		...row, title, titleMarkup, doi, authors, source: normalizeSource(source || row.source),
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

function authorKey(author) {
	const structured = typeof author === "object" && (author?.lastName || author?.family);
	const name = typeof author === "string" ? author : structured
		? [author.firstName || author.given, author.lastName || author.family].filter(Boolean).join(" ") : author?.name;
	if (/…|\.\.\.|\bet\s+al\.?\s*$/i.test(name || "")) return null;
	const parts = String(name || "").normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]+/gu) || [];
	if (!parts.length) return null;
	const rawParts = String(name).match(/[\p{L}\p{N}]+/gu) || [];
	const fullName = parts.join(" ");
	if (structured) return { fullName, surname: parts.at(-1), given: /^[A-Z]{1,4}$/.test(rawParts[0]) ? parts[0][0] : parts[0] };
	if (String(name).includes(",") && parts.length > 1) return { fullName, surname: parts[0], given: parts[1] };
	if (parts.length > 1 && /^[A-Z]{1,4}$/.test(rawParts.at(-1))) return { fullName, surname: parts.at(-2), given: parts.at(-1)[0] };
	return { fullName, surname: parts.at(-1), given: parts.length > 1 ? parts[0] : "" };
}

const compatibleAuthor = (a, b) => a.fullName === b.fullName || a.surname === b.surname && (a.given === b.given
	|| a.given.length === 1 && a.given === b.given[0] || b.given.length === 1 && b.given === a.given[0]);

export function assessMetadata(reference, candidate, matches) {
	const conflicts = [], unverifiable = [];
	for (const match of matches) {
		const ref = reference[match.referenceIndex], rec = candidate[match.candidateIndex];
		const fields = [], missing = [];
		for (const field of ["title", "year", "pmid", "pmcid", "arxiv"]) {
			const a = field === "title" ? normalizedTitle(ref.titleMarkup || ref.title) : String(ref[field] || "").toLowerCase();
			const b = field === "title" ? normalizedTitle(rec.titleMarkup || rec.title) : String(rec[field] || "").toLowerCase();
			if (field === "title" && (!a || !b)) missing.push(field);
			else if (a && b && a !== b) fields.push(field);
			else if (a && !b) missing.push(field);
		}
		const ra = (ref.authors || []).map(authorKey).filter(Boolean), ca = (rec.authors || []).map(authorKey).filter(Boolean);
		const truncatedAuthors = [ref, rec].some(record => (record.authors || []).some(author => /…|\.\.\.|\bet\s+al\.?\s*$/i.test(typeof author === "string" ? author : author?.name || "")));
		if (truncatedAuthors) missing.push("authors");
		else if (ra.length && ca.length && (ra.some(a => !ca.some(b => compatibleAuthor(a, b))) || ca.some(a => !ra.some(b => compatibleAuthor(a, b))))) fields.push("authors");
		else if (ra.length && (!ca.length || ra.length !== ca.length)) missing.push("authors");
		const context = { referenceIndex: match.referenceIndex, candidateIndex: match.candidateIndex, method: match.method };
		if (fields.length) conflicts.push({ ...context, fields, reference: summary(ref, match.referenceIndex), candidate: summary(rec, match.candidateIndex),
			values: Object.fromEntries(fields.map(field => [field, field === "title"
				? { reference: ref.titleMarkup || ref.title, candidate: rec.titleMarkup || rec.title }
				: { reference: ref[field], candidate: rec[field] }])) });
		if (missing.length) unverifiable.push({ ...context, fields: missing });
	}
	return { checked: matches.length, conflicts, unverifiable,
		policy: "Matched title, year, explicit identifiers and author-list compatibility (initials allowed); missing reference fields are not inferred. Citation counts and venue spelling may vary and are not identity criteria." };
}

export function compareRecords(reference, candidate) {
	const used = new Set(), matched = new Map(), conflicts = [], titleDOIs = new Map();
	const identities = records => records.map(record => ({ title: normalizedTitle(record.titleMarkup || record.title), doi: canonicalDOI(record.doi) }));
	const refIdentities = identities(reference), candidateIdentities = identities(candidate);
	const byDOI = new Map(), byTitle = new Map();
	for (const [index, { title, doi }] of candidateIdentities.entries()) {
		for (const [map, key] of [[byDOI, doi], [byTitle, title]]) if (key) {
			if (!map.has(key)) map.set(key, []);
			map.get(key).push(index);
		}
	}
	for (const { title, doi } of [...refIdentities, ...candidateIdentities]) {
		if (title && doi) {
			if (!titleDOIs.has(title)) titleDOIs.set(title, new Set());
			titleDOIs.get(title).add(doi);
		}
	}
	// Resolve all DOI matches before title fallbacks can consume a DOI match's candidate.
	for (const [ri, ref] of reference.entries()) {
		const doi = refIdentities[ri].doi;
		if (!doi) continue;
		const ci = byDOI.get(doi)?.find(index => !used.has(index));
		if (ci !== undefined) { used.add(ci); matched.set(ri, { referenceIndex: ri, candidateIndex: ci, method: "doi" }); }
	}
	for (const [ri, ref] of reference.entries()) {
		const { title, doi } = refIdentities[ri];
		if (!title) continue;
		for (const ci of byTitle.get(title) || []) {
			const rec = candidate[ci], candidateDOI = candidateIdentities[ci].doi;
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
	const refDOIs = refIdentities.map(row => row.doi).filter(Boolean), candidateDOIs = candidateIdentities.map(row => row.doi).filter(Boolean);
	const uniqueReferenceDOIs = new Set(refDOIs), uniqueCandidateDOIs = new Set(candidateDOIs);
	const recoveredDOIs = [...uniqueReferenceDOIs].filter(doi => uniqueCandidateDOIs.has(doi)).length;
	return { referenceCount: reference.length, candidateCount: candidate.length, matched: count,
		recall: reference.length ? count / reference.length : null,
		candidateOverlap: candidate.length ? count / candidate.length : null,
		jaccard: reference.length + candidate.length - count ? count / (reference.length + candidate.length - count) : null,
		doiMatches: matches.filter(match => match.method === "doi").length,
		titleMatches: matches.filter(match => match.method === "exact-title").length,
		matches: matches.map(match => ({ ...match, reference: summary(reference[match.referenceIndex], match.referenceIndex), candidate: summary(candidate[match.candidateIndex], match.candidateIndex) })),
		misses: reference.flatMap((record, index) => matched.has(index) ? [] : [summary(record, index)]),
		candidateOnly: candidate.flatMap((record, index) => used.has(index) ? [] : [summary(record, index)]),
		identityConflicts: conflicts,
		doiCoverage: { referenceUnique: uniqueReferenceDOIs.size, candidateUnique: uniqueCandidateDOIs.size, matchedUnique: recoveredDOIs,
			referenceDuplicates: refDOIs.length - uniqueReferenceDOIs.size, candidateDuplicates: candidateDOIs.length - uniqueCandidateDOIs.size,
			referenceWithoutDOI: reference.length - refDOIs.length, candidateWithoutDOI: candidate.length - candidateDOIs.length,
			recall: uniqueReferenceDOIs.size ? recoveredDOIs / uniqueReferenceDOIs.size : null,
			method: "Diagnostic unique canonical DOI coverage only; does not replace raw one-to-one full-cap recall or strict criteria." },
		metadata: assessMetadata(reference, candidate, matches) };
}

const TEXT_FIELDS = ["keywords", "authors", "title", "venue", "excludes"];
const FLAGS = ["includeCitations", "includePatents", "onlyReviews"];
const DEFAULT_MULTI_SOURCES = ["openalex", "crossref", "europepmc", "arxiv"];
const MULTI_SOURCES = new Set([...DEFAULT_MULTI_SOURCES, "pubmed", "semanticscholar", "scholar"]);
function selectedSources(value, source) {
	if (value === undefined) return source === "multi" ? [...DEFAULT_MULTI_SOURCES].sort() : [];
	if (!Array.isArray(value) || !value.length) return null;
	const normalized = value.map(normalizeSource);
	return normalized.some(key => !MULTI_SOURCES.has(key)) ? null : [...new Set(normalized)].sort();
}
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
	const referenceSources = selectedSources(ref.sources, reference.source), candidateSources = selectedSources(query.sources, normalizeSource(spec.source));
	if (!referenceSources || !candidateSources || JSON.stringify(referenceSources) !== JSON.stringify(candidateSources)) reasons.push("different-query:sources");
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

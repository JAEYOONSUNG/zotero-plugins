#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assessReference, canonicalDOI, compareRecords, loadPoPReference, normalizeRecord, normalizeSource, normalizedTitle } from "./lib/pop-reference.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULTS = { referenceTopK: 10, candidateTopK: 30, minReferenceRecall: 0.9 };
const errorInfo = error => ({ name: error?.name || "Error", message: String(error?.message || error), ...(error?.status ? { status: error.status } : {}) });
const sha256 = value => createHash("sha256").update(value).digest("hex");

function validateCriteria(options = {}) {
	if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Invalid criteria");
	const profile = options.profile || "overlap";
	if (!["strict", "overlap"].includes(profile)) throw new Error("Invalid criteria profile");
	const strict = profile === "strict";
	const criteria = { profile, minFullRecall: strict ? 1 : null, minSameTopKRecall: strict ? 1 : null,
		minRankAgreement: strict ? 1 : null, requireMetadataConsistency: strict, requireVerifiedFields: strict, ...options };
	for (const key of ["minFullRecall", "minSameTopKRecall", "minRankAgreement"]) {
		if (criteria[key] === null && !strict) continue;
		if (!Number.isFinite(criteria[key]) || criteria[key] < 0 || criteria[key] > 1) throw new Error(`Invalid criterion ${key}`);
	}
	for (const key of ["requireMetadataConsistency", "requireVerifiedFields"]) if (typeof criteria[key] !== "boolean") throw new Error(`Invalid criterion ${key}`);
	if (strict && (!criteria.requireMetadataConsistency || !criteria.requireVerifiedFields || criteria.minFullRecall <= 0 || criteria.minSameTopKRecall <= 0 || criteria.minRankAgreement <= 0)) throw new Error("Strict criteria cannot disable completeness, ranking, metadata or field verification");
	return criteria;
}

function rankingAssessment(reference, candidates, k, comparable) {
	const count = Math.min(k, reference.length);
	const matches = compareRecords(reference.slice(0, count), candidates.slice(0, count)).matches;
	const exact = matches.filter(match => match.referenceIndex === match.candidateIndex).length;
	const gain = index => 1 / (index + 1);
	const ideal = Array.from({ length: count }, (_, i) => gain(i) / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
	const dcg = matches.reduce((sum, match) => sum + gain(match.referenceIndex) / Math.log2(match.candidateIndex + 2), 0);
	return { applicable: comparable, k: count, sameTopKRecall: count ? matches.length / count : null,
		rankAgreement: count ? exact / count : null, ndcg: ideal ? dcg / ideal : null,
		meanAbsoluteRankError: matches.length ? matches.reduce((sum, match) => sum + Math.abs(match.referenceIndex - match.candidateIndex), 0) / matches.length : null,
		method: "Same-size top-k identity recall, exact-position agreement and NDCG with reciprocal reference rank gain. Rank measures are gated only for matching source and retrieval sort." };
}

function validateThresholds(options) {
	const thresholds = { ...DEFAULTS, ...options };
	for (const key of ["referenceTopK", "candidateTopK"]) {
		if (!Number.isInteger(thresholds[key]) || thresholds[key] < 1) throw new Error(`Invalid threshold ${key}`);
	}
	if (!Number.isFinite(thresholds.minReferenceRecall) || thresholds.minReferenceRecall < 0 || thresholds.minReferenceRecall > 1) throw new Error("Invalid minReferenceRecall");
	return thresholds;
}

function fieldAssessment(records, query, helper) {
	const fields = ["authors", "title", "venue"].filter(key => String(query[key] || "").trim());
	const available = helper && ["matchesAuthor", "matchesTitle", "matchesVenue", "matchesRecord"].every(key => typeof helper[key] === "function");
	const required = fields.length > 0 || Boolean(query.excludes || query.yearFrom || query.yearTo);
	if (!available) return { checked: false, required, violations: [], unverifiableFields: [], verifiedRecords: 0, error: required ? "Query helper unavailable" : null };
	const violations = [], unverifiableFields = [];
	let verifiedRecords = 0;
	const truncated = value => /…|\.\.\.|\bet\s+al\.?\s*$/i.test(String(value || ""));
	try {
		for (const [index, record] of records.entries()) {
			const failed = [], unknown = [];
			if (query.authors && !helper.matchesAuthor(query.authors, record.authors)) {
				const names = record.authors.map(author => author.name || [author.firstName, author.lastName].filter(Boolean).join(" ")).filter(Boolean);
				if (!names.length || names.some(truncated)) unknown.push("authors"); else failed.push("authors");
			}
			if (query.title && !helper.matchesTitle(query.title, record.titleMarkup || record.title)) {
				if (!record.title || truncated(record.title)) unknown.push("title"); else failed.push("title");
			}
			if (query.venue && !helper.matchesVenue(query.venue, record)) {
				const names = [record.venue, record.journalAbbreviation, record.journalAbbr, ...(record.venueAliases || [])].filter(Boolean);
				if (!names.length || names.some(truncated)) unknown.push("venue"); else failed.push("venue");
			}
			const year = Number(record.year || String(record.publicationDate || "").slice(0, 4));
			if ((query.yearFrom || query.yearTo) && (!Number.isInteger(year) || year <= 0)) unknown.push("year");
			if (query.yearFrom && year && year < Number(query.yearFrom)) failed.push("yearFrom");
			if (query.yearTo && year && year > Number(query.yearTo)) failed.push("yearTo");
			if (!helper.matchesRecord(record, query) && !failed.length && !unknown.length) failed.push("query");
			if (failed.length) violations.push({ index, doi: record.doi, title: record.title, fields: failed });
			if (unknown.length) unverifiableFields.push({ index, doi: record.doi, title: record.title, fields: unknown, reason: "missing-or-truncated-metadata" });
			if (!failed.length && !unknown.length && required) verifiedRecords++;
		}
		return { checked: true, required, violations, unverifiableFields, verifiedRecords, error: null };
	} catch (error) { return { checked: false, required: true, violations, unverifiableFields, verifiedRecords, error: errorInfo(error).message }; }
}

function targetAssessment(spec, reference, candidates) {
	const expected = [];
	for (const doi of spec.expectedDois || []) expected.push({ doi: canonicalDOI(doi), title: "", invalid: !canonicalDOI(doi) });
	let titles = spec.expectedTitles || [];
	if (!expected.length && !titles.length && ["exact-title", "known-paper"].includes(spec.kind) && spec.query?.title) titles = [spec.query.title];
	for (const title of titles) {
		const refs = (reference?.records || []).filter(record => normalizedTitle(record.titleMarkup || record.title) === normalizedTitle(title));
		const knownDOIs = new Set(refs.map(record => canonicalDOI(record.doi)).filter(Boolean));
		expected.push({ title, doi: knownDOIs.size === 1 ? [...knownDOIs][0] : null, ambiguous: knownDOIs.size > 1 });
	}
	return expected.map(target => {
		const comparison = compareRecords([target], candidates);
		const match = comparison.matches[0];
		return { ...target, found: !target.invalid && !target.ambiguous && Boolean(match),
			candidateIndex: match?.candidateIndex ?? null, method: match?.method ?? null };
	});
}

function precisionAssessment(spec, candidates) {
	// Relevance needs explicit human judgements. Bibliographic overlap is reported separately.
	const judgements = Array.isArray(spec.relevanceJudgements) ? spec.relevanceJudgements : [];
	const unique = new Map();
	for (const judgement of judgements) {
		if (typeof judgement.relevant !== "boolean" || !judgement.judgedBy || !judgement.judgedAt) continue;
		const match = compareRecords([judgement], candidates).matches[0];
		if (!match) continue;
		const existing = unique.get(match.candidateIndex);
		unique.set(match.candidateIndex, existing && existing.relevant !== judgement.relevant ? { conflict: true } : judgement);
	}
	const judged = [...unique.values()].filter(value => !value.conflict);
	const relevant = judged.filter(value => value.relevant).length;
	return { method: "human-judgements", candidateCount: candidates.length, judged: judged.length, relevant,
		unjudged: candidates.length - judged.length, coverage: candidates.length ? judged.length / candidates.length : null,
		precisionOnJudged: judged.length ? relevant / judged.length : null,
		precision: candidates.length && judged.length === candidates.length ? relevant / candidates.length : null };
}

export function evaluateCase(spec, { reference = null, records = [], errors = [], latencyMs = null, firstResultMs = null,
	requests = [], queryHelper = null, thresholds = {}, now = new Date(), candidateIssues = [], referenceError = null,
	maxReferenceAgeHours = 24, timeZone, criteria = {} } = {}) {
	const limits = validateThresholds(thresholds);
	const rules = validateCriteria({ ...criteria, ...spec.criteria });
	const max = Number(spec.query?.maxResults);
	const reasons = [...candidateIssues];
	const candidateErrors = [...errors];
	if (!Number.isInteger(max) || max < 1) reasons.push("invalid-candidate-cap");
	const cap = Number.isInteger(max) && max > 0 ? max : 0;
	const candidate = records.slice(0, cap).flatMap((record, index) => {
		try { return [normalizeRecord(record, index)]; }
		catch (error) { reasons.push("invalid-candidate-record"); candidateErrors.push(error); return []; }
	});
	const refRecords = (reference?.records || []).slice(0, cap);
	const evidence = assessReference(reference, spec, { now, maxReferenceAgeHours, ...(timeZone ? { timeZone } : {}) });
	reasons.push(...evidence.reasons);
	if (referenceError) reasons.push("reference-load-failed");
	if (candidateErrors.length) reasons.push("candidate-errors");
	if (!candidate.length) reasons.push("empty-candidate");
	const top = compareRecords(refRecords.slice(0, limits.referenceTopK), candidate.slice(0, limits.candidateTopK));
	const full = compareRecords(refRecords, candidate);
	const ranking = rankingAssessment(refRecords, candidate, limits.referenceTopK, Boolean(reference
		&& reference.source === normalizeSource(spec.source) && reference.query?.sort === (spec.query?.sort || "relevance")));
	const expectedTargets = targetAssessment(spec, reference, candidate);
	if (["exact-title", "known-paper"].includes(spec.kind) && !expectedTargets.length) reasons.push("missing-expected-target");
	if (expectedTargets.some(target => !target.found)) reasons.push("expected-target-missing");
	const fields = fieldAssessment(candidate, spec.query || {}, queryHelper);
	const referenceFields = fieldAssessment(refRecords, spec.query || {}, queryHelper);
	if (fields.required && !fields.checked) reasons.push("field-check-unavailable");
	if (fields.violations.length) reasons.push("field-violations");
	if (top.recall === null || top.recall < limits.minReferenceRecall) reasons.push("reference-recall-below-threshold");
	if (rules.minFullRecall !== null && (full.recall === null || full.recall < rules.minFullRecall)) reasons.push("full-recall-below-threshold");
	if (rules.minSameTopKRecall !== null && ranking.applicable && (ranking.sameTopKRecall === null || ranking.sameTopKRecall < rules.minSameTopKRecall)) reasons.push("same-top-k-recall-below-threshold");
	if (rules.minRankAgreement !== null && ranking.applicable && (ranking.rankAgreement === null || ranking.rankAgreement < rules.minRankAgreement)) reasons.push("rank-agreement-below-threshold");
	if (rules.requireMetadataConsistency && full.metadata.conflicts.length) reasons.push("metadata-conflicts");
	if (rules.requireMetadataConsistency && full.metadata.unverifiable.length) reasons.push("metadata-unverifiable");
	// A same-title, different-DOI pair is an excluded alternative, not a defect
	// when each distinct record matched its own DOI. Unresolved identities lower
	// recall; contradictions within actual matches are metadata conflicts.
	if (rules.requireVerifiedFields && fields.unverifiableFields.length) reasons.push("unverifiable-fields");
	if (rules.requireVerifiedFields && (referenceFields.violations.length || referenceFields.unverifiableFields.length || referenceFields.required && !referenceFields.checked)) reasons.push("unverified-reference-fields");
	return { id: spec.id, kind: spec.kind || "topic", source: normalizeSource(spec.source), query: spec.query,
		status: reasons.length ? "fail" : "pass", reasons: [...new Set(reasons)], reference: evidence,
		referenceError, counts: { referenceRaw: reference?.rawCount ?? 0, referenceCompared: refRecords.length,
			candidateRaw: records.length, candidateCompared: candidate.length },
		thresholds: limits, criteria: rules, top, full, ranking, metadata: full.metadata, expectedTargets, fields, referenceQuality: referenceFields, precision: precisionAssessment(spec, candidate),
		latencyMs, firstResultMs, requests, errors: candidateErrors.map(errorInfo), records: candidate };
}

export function redactedURL(value) {
	try {
		const url = new URL(value);
		for (const key of [...url.searchParams.keys()]) if (/api[-_]?key|token|secret|password|email|mailto/i.test(key)) url.searchParams.set(key, "[redacted]");
		url.username = ""; url.password = "";
		return url.href;
	} catch { return "[invalid URL]"; }
}

export function createHTTPAdapter({ fetchImpl = globalThis.fetch, requests = [], signal: defaultSignal, timeoutMs = 30000 } = {}) {
	async function errorBody(response) {
		const limit = 16384, reader = response.body?.getReader?.();
		if (!reader) return String(await response.text()).slice(0, limit);
		const decoder = new TextDecoder();
		let body = "", size = 0;
		try {
			while (size < limit) {
				const { value, done } = await reader.read();
				if (done) break;
				const part = value.subarray(0, limit - size);
				body += decoder.decode(part, { stream: true }); size += part.length;
				if (size >= limit) await reader.cancel();
			}
			return body + decoder.decode();
		} finally { reader.releaseLock(); }
	}
	async function request(type, url, headers = {}, signal) {
		const entry = { method: "GET", type, url: redactedURL(url), startedAt: new Date().toISOString() };
		requests.push(entry);
		const started = performance.now();
		const controller = new AbortController();
		const signals = [...new Set([signal, defaultSignal].filter(Boolean))];
		const onAbort = () => controller.abort();
		for (const inherited of signals) { inherited.addEventListener("abort", onAbort, { once: true }); if (inherited.aborted) controller.abort(); }
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetchImpl(url, { headers, signal: controller.signal });
			entry.status = response.status;
			if (!response.ok) {
				let body = "";
				try { body = await errorBody(response); } catch { /* Preserve the HTTP status even if the response stream fails. */ }
				throw Object.assign(new Error(`HTTP ${response.status} from ${new URL(url).hostname}`), { status: response.status, body });
			}
			const text = await response.text();
			entry.bytes = Buffer.byteLength(text);
			return type === "json" ? JSON.parse(text.replace(/^\uFEFF/, "")) : text;
		} catch (error) { entry.error = errorInfo(error); throw error; }
		finally {
			clearTimeout(timer);
			for (const inherited of signals) inherited.removeEventListener("abort", onAbort);
			entry.latencyMs = Math.round((performance.now() - started) * 100) / 100;
		}
	}
	return { getJSON: (url, headers, signal) => request("json", url, headers, signal), getText: (url, headers, signal) => request("text", url, headers, signal) };
}

async function moduleValue(path) {
	const specifier = path.startsWith(".") || path.startsWith("/") || /^[a-z]:[\\/]/i.test(path) ? pathToFileURL(resolve(path)).href : path;
	const imported = await import(specifier);
	return imported.default || imported;
}

async function optionalQueryHelper(path) {
	try { return await moduleValue(path); }
	catch (error) { if (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND") return null; throw error; }
}

async function sourceEvidence(paths, { sources, queryHelper } = {}) {
	const files = [];
	for (const path of [...new Set(paths)]) {
		try { files.push({ path: resolve(path), sha256: sha256(await readFile(path)) }); }
		catch (error) { files.push({ path: resolve(path), error: errorInfo(error).message }); }
	}
	let revision = null, dirty = null;
	try {
		const run = promisify(execFile);
		const [head, status] = await Promise.all([run("git", ["rev-parse", "HEAD"], { cwd: ROOT }), run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ROOT })]);
		revision = head.stdout.trim(); dirty = Boolean(status.stdout.trim());
	} catch { /* Non-git installations still retain exact module hashes. */ }
	return { revision, dirty, files, injectedSources: Boolean(sources), injectedQueryHelper: queryHelper !== undefined,
		...(sources ? { injectedSearchSHA256: sha256(String(sources.search)), limitation: "Injected source function hash cannot establish closed-over state." } : {}) };
}

export async function runBenchmark(config, { baseDir = process.cwd(), sourcesModule = resolve(ROOT, "content/sources.js"),
	sources = null, queryHelper, queryModule = resolve(ROOT, "content/query.js"), DOMParser,
	fetchImpl = globalThis.fetch, now, context = {}, offlineCandidates = {}, popExecutable = null, popDataDir = null,
	popModule = resolve(ROOT, "content/pop.js"), popBridge = null } = {}) {
	if (!Array.isArray(config.cases) || !config.cases.length) throw new Error("Benchmark config requires nonempty cases");
	const ids = new Set();
	for (const spec of config.cases) {
		if (!spec.id || ids.has(spec.id)) throw new Error("Benchmark case ids must be present and unique");
		ids.add(spec.id);
		if (!spec.source || !spec.query) throw new Error(`Case ${spec.id} requires source and query`);
		validateCriteria({ ...config.criteria, ...spec.criteria });
	}
	validateThresholds(config.thresholds);
	validateCriteria(config.criteria);
	const evaluationMode = config.mode || "fresh";
	if (!["fresh", "historical-replay"].includes(evaluationMode)) throw new Error("Invalid benchmark mode");
	if (evaluationMode === "historical-replay" && config.cases.some(spec => !spec.candidatePath && !Object.hasOwn(offlineCandidates, spec.id))) throw new Error("Historical replay requires recorded candidates for every case");
	const evaluatorEvidence = await sourceEvidence([sourcesModule, queryModule, fileURLToPath(import.meta.url), resolve(ROOT, "scripts/lib/pop-reference.mjs"),
		...(popExecutable ? [popModule, popExecutable] : [])], { sources, queryHelper });
	const helper = queryHelper === undefined ? await optionalQueryHelper(queryModule) : queryHelper;
	if (popExecutable && !popBridge) popBridge = await moduleValue(popModule);
	if (popExecutable && typeof popBridge?.search !== "function") throw new Error("PoP bridge must export search(query, context)");
	const results = [];
	for (const spec of config.cases) {
		let reference = null, referenceError = null, records = [], errors = [], latencyMs = null, firstResultMs = null;
		let requests = [], candidateIssues = [], mode = "live", transport = "direct", candidateEvidence = evaluatorEvidence, candidateSHA256 = null;
		let capturedAt = now ? new Date(now) : new Date();
		let assessmentTime = capturedAt;
		try { if (spec.referencePath) reference = await loadPoPReference(resolve(baseDir, spec.referencePath)); }
		catch (error) { referenceError = errorInfo(error); }
		try {
			if (Object.hasOwn(offlineCandidates, spec.id) || spec.candidatePath) {
				mode = "recorded";
				const bytes = Object.hasOwn(offlineCandidates, spec.id) ? JSON.stringify(offlineCandidates[spec.id]) : await readFile(resolve(baseDir, spec.candidatePath), "utf8");
				candidateSHA256 = sha256(bytes);
				const fixture = JSON.parse(bytes.replace(/^\uFEFF/, ""));
				records = Array.isArray(fixture) ? fixture : fixture.records;
				if (!Array.isArray(records)) throw new Error("Candidate fixture requires records array");
				errors = fixture.errors || [];
				requests = fixture.requests || [];
				latencyMs = fixture.latencyMs ?? null;
				firstResultMs = fixture.firstResultMs ?? null;
				transport = fixture.transport || "recorded-unspecified";
				candidateEvidence = fixture.sourceEvidence || { revision: null, files: [], limitation: "Original candidate source revision and hashes were not recorded." };
				if (Number.isFinite(new Date(fixture.capturedAt || NaN).getTime())) capturedAt = new Date(fixture.capturedAt);
				if (evaluationMode === "historical-replay") assessmentTime = capturedAt;
				const recordedEvidence = assessReference({ source: normalizeSource(fixture.source), query: fixture.query || {}, records,
					errors, rawCount: records.length, provenance: { capturedAt: fixture.capturedAt, completed: fixture.status === "complete" } }, spec,
					{ now: assessmentTime, maxReferenceAgeHours: config.maxReferenceAgeHours ?? 24, ...(config.timeZone ? { timeZone: config.timeZone } : {}) });
				candidateIssues.push(...recordedEvidence.reasons.map(reason => `recorded-candidate:${reason}`));
			} else {
				if (!sources) sources = await moduleValue(sourcesModule);
				if (typeof sources.search !== "function") throw new Error("Sources module must export search(source, query, http, ctx)");
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), spec.timeoutMs || config.timeoutMs || 120000);
				const started = performance.now();
				const ctx = { ...context, enrichCitations: false, journalMetrics: false, DOMParser, errors: [],
					signal: controller.signal, isCancelled: () => controller.signal.aborted,
					onResults(snapshot) { if (snapshot.length && firstResultMs === null) firstResultMs = Math.round(performance.now() - started); } };
				if (popExecutable) ctx.popSearch = async (bridgeQuery, overrides = {}) => {
					transport = "installed-publish-or-perish";
					const entry = { method: "CLI", transport, executable: popExecutable, source: spec.source, query: bridgeQuery,
						startedAt: new Date().toISOString() };
					requests.push(entry);
					const start = performance.now();
					try {
						const result = await popBridge.search(bridgeQuery, { ...ctx, ...overrides, popExecutable, popDataDir });
						entry.status = "complete";
						return result;
					} catch (error) { entry.error = errorInfo(error); throw error; }
					finally { entry.latencyMs = Math.round(performance.now() - start); }
				};
				const http = createHTTPAdapter({ fetchImpl, requests, signal: controller.signal, timeoutMs: config.requestTimeoutMs || 30000 });
				try {
					records = await sources.search(normalizeSource(spec.source), { ...spec.query }, http, ctx);
					if (!Array.isArray(records)) throw new Error("Sources search did not return records");
					if (controller.signal.aborted) candidateIssues.push("candidate-aborted");
				} finally {
					clearTimeout(timer);
					latencyMs = Math.round(performance.now() - started);
					if (records.length && firstResultMs === null) firstResultMs = latencyMs;
					errors.push(...(ctx.errors || []));
				}
			}
		} catch (error) { errors.push(error); }
		const result = evaluateCase(spec, { reference, referenceError, records: Array.isArray(records) ? records : [], errors,
			latencyMs, firstResultMs, requests, queryHelper: helper, thresholds: config.thresholds, criteria: config.criteria, candidateIssues, now: assessmentTime,
			maxReferenceAgeHours: config.maxReferenceAgeHours ?? 24, timeZone: config.timeZone });
		results.push({ ...result, mode, evaluationMode, transport, capturedAt: capturedAt.toISOString(), assessedAt: assessmentTime.toISOString(),
			sourceEvidence: candidateEvidence, candidateSHA256, retrievalStatus: result.errors.length || candidateIssues.length ? "error" : "complete" });
	}
	const passed = results.filter(result => result.status === "pass").length;
	const sourceSet = new Set(results.filter(result => result.status === "pass").map(result => result.source));
	const hasScholarAndAPI = sourceSet.has("scholar") && [...sourceSet].some(source => !["scholar", "multi"].includes(source));
	const coverage = { declaration: config.coverage || null, observed: { sources: [...new Set(results.map(result => result.source))],
		kinds: [...new Set(results.map(result => result.kind))], caps: [...new Set(results.map(result => result.query.maxResults))],
		queries: results.map(result => ({ id: result.id, source: result.source, query: result.query, criteria: result.criteria })) },
		limitation: "Results apply only to these cases, source transports, retrieval orders, caps and capture times; no universal Publish or Perish parity is established." };
	return { generatedAt: new Date().toISOString(), evaluationMode, sourcesModule: resolve(sourcesModule), sourceEvidence: evaluatorEvidence,
		configSHA256: sha256(JSON.stringify(config)), thresholds: validateThresholds(config.thresholds), criteria: validateCriteria(config.criteria), coverage,
		summary: { cases: results.length, passed, failed: results.length - passed,
			allCasesPass: passed === results.length, hasScholarAndAPI, parityEstablished: false,
			declaredCoveragePassed: Boolean(config.coverage) && passed === results.length && results.every(result => result.criteria.profile === "strict"),
			freshStrictCasesPassed: evaluationMode === "fresh" ? results.filter(result => result.status === "pass" && result.criteria.profile === "strict").length : 0 },
		cases: results };
}

const pct = value => value === null || value === undefined ? "unavailable" : `${(value * 100).toFixed(1)}%`;
const cell = value => String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
export function renderReport(report) {
	const lines = [`# ZotPoP / Publish or Perish comparison`, "", `Generated: ${report.generatedAt}`, "",
		`${report.summary.passed}/${report.summary.cases} cases pass. Scholar and API coverage: ${report.summary.hasScholarAndAPI ? "present" : "not established"}.`, "",
		`Evaluation: ${report.evaluationMode || "unspecified"}. Profile: ${report.criteria?.profile || "unspecified"}. ${report.coverage?.limitation || "No universal Publish or Perish parity is established."}`, "",
		...(report.evaluationMode === "historical-replay" ? ["Historical replay evaluates frozen captures at their original candidate capture time; it does not measure current live search performance.", ""] : []),
		`Declared coverage: ${cell(JSON.stringify(report.coverage?.declaration || null))}. Observed sources: ${(report.coverage?.observed?.sources || []).join(", ")}. Observed caps: ${(report.coverage?.observed?.caps || []).join(", ")}.`, "",
		`Evaluator revision: ${report.sourceEvidence?.revision || "unavailable"}. Dirty working tree: ${report.sourceEvidence?.dirty ?? "unknown"}. Config SHA-256: ${report.configSHA256 || "unavailable"}.`, "",
		"Candidate overlap is bibliographic agreement with PoP, not relevance precision. Missing human judgements leave precision unavailable.", "",
		"Transport 'installed-publish-or-perish' uses the installed PoP engine; its overlap measures integration fidelity and does not establish independent scraper parity.", "",
		"| Case | Source | Status | PoP top recall | Full-cap recall | Same top-k recall | Rank agreement | Metadata conflicts | Precision | Latency |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
	for (const result of report.cases) lines.push(`| ${cell(result.id)} | ${cell(result.source)} | ${result.status} | ${pct(result.top.recall)} | ${pct(result.full.recall)} | ${pct(result.ranking?.sameTopKRecall)} | ${pct(result.ranking?.rankAgreement)} | ${result.metadata?.conflicts.length ?? "unavailable"} | ${pct(result.precision.precision)} | ${result.latencyMs ?? "unavailable"} ms |`);
	for (const result of report.cases) {
		lines.push("", `## ${result.id}`, "", `Mode: ${result.mode}. Transport: ${result.transport}. Counts: ${JSON.stringify(result.counts)}.`, "",
			`Outcome: ${result.reasons.length ? result.reasons.join(", ") : "All declared checks pass"}.`, "",
			`Criteria: ${JSON.stringify(result.criteria || {})}. Ranking applicable: ${result.ranking?.applicable ?? false}; NDCG: ${pct(result.ranking?.ndcg)}.`, "",
			`Matches: ${result.full.doiMatches} DOI, ${result.full.titleMatches} normalized exact title. Identity conflicts: ${result.full.identityConflicts.length}. Known field violations: ${result.fields.violations.length}. Records with unverifiable fields: ${result.fields.unverifiableFields.length}. Fully verified field records: ${result.fields.verifiedRecords}.`, "",
			`Unique DOI diagnostic: ${pct(result.full.doiCoverage?.recall)} recall; reference duplicates: ${result.full.doiCoverage?.referenceDuplicates ?? "unavailable"}. Raw full-cap recall remains the strict criterion.`, "",
			`Matched-record metadata: ${result.metadata?.conflicts.length ?? "unavailable"} conflicts; ${result.metadata?.unverifiable.length ?? "unavailable"} unverifiable records. Candidate capture: ${result.capturedAt || "unavailable"}. Candidate SHA-256: ${result.candidateSHA256 || "live"}. Candidate source revision: ${result.sourceEvidence?.revision || "unavailable"}.`, "",
			`Reference quality: ${result.referenceQuality.violations.length} known field violations; ${result.referenceQuality.unverifiableFields.length} records with unverifiable fields.`, "",
			`Reference time: ${result.reference.provenance?.capturedAt || "unavailable"}. Reference SHA-256: ${result.reference.provenance?.sha256 || "unavailable"}.`);
		if (result.errors.length) lines.push("", `Errors: ${result.errors.map(error => error.message).join("; ")}`);
	}
	return lines.join("\n") + "\n";
}

export async function main(argv = process.argv.slice(2)) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const key = argv[i];
		if (key === "--help") {
			console.log("Usage: node scripts/benchmark-search.mjs --config FILE --out DIR [--sources-module FILE] [--query-module FILE] [--dom-parser-module FILE_OR_PACKAGE] [--pop-executable FILE] [--pop-data-dir DIR]\nSet criteria.profile='strict' for full-cap recall, same-top-k order, metadata and field verification. Config mode='historical-replay' explicitly replays recorded captures at capture time. Cases may set candidatePath to {records,source,query,capturedAt,status:'complete',errors,requests,latencyMs,sourceEvidence}. Paths in config are relative to its directory. Coverage is declared in config.coverage; passing cases never establishes universal parity.");
			return 0;
		}
		if (!["--config", "--out", "--sources-module", "--query-module", "--dom-parser-module", "--pop-executable", "--pop-data-dir"].includes(key) || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`Invalid CLI argument: ${key}`);
		args[key.slice(2)] = argv[++i];
	}
	if (!args.config || !args.out) throw new Error("--config and --out are required");
	const configPath = resolve(args.config);
	const config = JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/, ""));
	const options = { baseDir: dirname(configPath) };
	if (args["sources-module"]) options.sourcesModule = resolve(args["sources-module"]);
	if (args["query-module"]) options.queryModule = resolve(args["query-module"]);
	if (args["pop-data-dir"] && !args["pop-executable"]) throw new Error("--pop-data-dir requires --pop-executable");
	if (args["pop-executable"]) options.popExecutable = resolve(args["pop-executable"]);
	if (args["pop-data-dir"]) options.popDataDir = resolve(args["pop-data-dir"]);
	if (args["dom-parser-module"]) {
		const parser = await moduleValue(args["dom-parser-module"]);
		options.DOMParser = parser.DOMParser || parser;
		if (typeof options.DOMParser !== "function") throw new Error("DOM parser module must export DOMParser");
	}
	const report = await runBenchmark(config, options);
	await mkdir(resolve(args.out), { recursive: true });
	await writeFile(resolve(args.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
	await writeFile(resolve(args.out, "report.md"), renderReport(report));
	console.log(JSON.stringify(report.summary));
	return report.summary.allCasesPass ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 2; });
}

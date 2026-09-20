import { isDeepStrictEqual } from "node:util";
import { DOMParser } from "linkedom";
import { canonicalDOI, compareRecords, normalizeRecord, normalizedTitle } from "./pop-reference.mjs";

/**
 * Exact PoP output fidelity, deliberately separate from bibliography quality.
 *
 * Both envelopes: { rows: <unaltered PoP JSON rows>, provenance: {
 *   engine:'publish-or-perish', source, query, outputSort, profileId,
 *   capturedAt:<ISO timestamp>, exitCode:0|4, complete:true, cached:boolean,
 *   cancelled:false, acquisition:{kind:'process'|'fixture',invocationId},
 *   snapshotId?:<documented identity of an intentionally shared cache snapshot>
 * }}. The candidate additionally requires records:<production UI records>.
 *
 * evidenceMode='live-live' requires two distinct process invocation IDs and
 * fresh, uncached captures. 'same-snapshot' additionally requires equal explicit
 * snapshot IDs and options.snapshotEvidence={snapshotId,producerInvocationId,
 * producedAt,profileId,source,query,cacheSHA256Before,cacheSHA256After}. The producer
 * must be one uncached invocation here and its cache fingerprints must agree.
 * Cached capturedAt:null is retained as unknown; retrievedAt must be fresh.
 * This NEVER claims independent fresh evidence.
 * 'replay' permits fixtures/old captures and NEVER claims live evidence.
 * Acquisition metadata is evidence supplied by the capture runner: this pure
 * oracle cannot establish that a caller truthfully executed an external process.
 * Do not manufacture process provenance when replaying or copying a fixture.
 *
 * No row slicing, deduplication, rank sorting, DOI matching, coercion or unknown
 * replacement participates in output equality. Object member order is immaterial;
 * member presence, JSON types, values and every array position are significant.
 */
export function assessPoPFidelity(referenceEnvelope, candidateEnvelope, options = {}) {
  const { evidenceMode = "live-live", now = new Date(), maxAgeHours = 24, snapshotEvidence = null,
    maxCaptureGapMs = 30 * 60 * 1000, timeZone = "UTC", maxDifferences = 100 } = options;
  if (!["live-live", "same-snapshot", "replay"].includes(evidenceMode)) throw new Error("Unknown PoP fidelity evidence mode");
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0 || !Number.isFinite(maxCaptureGapMs) || maxCaptureGapMs < 0
    || !Number.isInteger(maxDifferences) || maxDifferences < 1) throw new Error("Invalid PoP fidelity limits");
  const current = new Date(now);
  if (!Number.isFinite(current.getTime())) throw new Error("Invalid PoP fidelity evaluation time");
  const calendar = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const reasons = [], rawDiff = differenceCollector(maxDifferences), projectionDiff = differenceCollector(maxDifferences);
  const reference = inspectEnvelope(referenceEnvelope, "reference", reasons);
  const candidate = inspectEnvelope(candidateEnvelope, "candidate", reasons);
  const snapshot = evidenceMode === "same-snapshot" ? inspectSnapshotEvidence(reference, candidate, snapshotEvidence)
    : { valid: false, reasons: [] };
  reasons.push(...snapshot.reasons);
  const provenance = {};
  for (const [name, envelope] of [["reference", reference], ["candidate", candidate]]) {
    const p = envelope.provenance;
    const issues = [];
    if (p.engine !== "publish-or-perish") issues.push("wrong-engine");
    for (const field of ["source", "outputSort", "profileId"]) if (typeof p[field] !== "string" || !p[field].trim()) issues.push(`missing-${field}`);
    if (!plainObject(p.query) || !validJSON(p.query) || !Number.isInteger(p.query.maxResults) || p.query.maxResults < 1) issues.push("invalid-query");
    if (p.complete !== true || p.cancelled !== false || envelope.partial || envelope.errors.length) issues.push("incomplete");
    if (p.exitCode !== 0 && !(p.exitCode === 4 && envelope.rows.length === 0)) issues.push("failed-process");
    if (typeof p.cached !== "boolean") issues.push("unknown-cache-state");
    const unknownCacheTime = evidenceMode === "same-snapshot" && snapshot.valid && p.cached === true && p.capturedAt === null;
    const observedAt = unknownCacheTime ? p.retrievedAt : p.capturedAt;
    const captured = typeof observedAt === "string" ? new Date(observedAt) : new Date(NaN);
    if (!Number.isFinite(captured.getTime())) issues.push("missing-capture-time");
    else if (evidenceMode !== "replay") {
      if (captured - current > 300000) issues.push("future-capture");
      if (current - captured > maxAgeHours * 3600000 || calendar.format(captured) !== calendar.format(current)) issues.push("stale-capture");
    }
    if (evidenceMode !== "replay") {
      if (p.acquisition?.kind !== "process" || typeof p.acquisition?.invocationId !== "string" || !p.acquisition.invocationId.trim()) issues.push("missing-independent-process-evidence");
      if (p.acquisition?.copiedFrom || p.acquisition?.fixturePath) issues.push("fixture-presented-as-live");
    }
    if (evidenceMode === "live-live" && p.cached !== false) issues.push("cached-capture");
    provenance[name] = { issues, capturedAt: p.capturedAt ?? null, retrievedAt: p.retrievedAt ?? null, profileId: p.profileId ?? null,
      cached: p.cached ?? null, invocationId: p.acquisition?.invocationId ?? null };
    reasons.push(...issues.map(issue => `${name}:${issue}`));
  }
  for (const field of ["source", "query", "outputSort", "profileId"]) {
    if (!isDeepStrictEqual(reference.provenance[field], candidate.provenance[field])) reasons.push(`different-${field}`);
  }
  if (evidenceMode !== "replay") {
    const rp = reference.provenance, cp = candidate.provenance;
    if (rp.acquisition?.invocationId && rp.acquisition.invocationId === cp.acquisition?.invocationId) reasons.push("same-process-invocation");
    const observed = p => new Date(p.capturedAt ?? (evidenceMode === "same-snapshot" ? p.retrievedAt : null));
    if (Math.abs(observed(rp) - observed(cp)) > maxCaptureGapMs) reasons.push("capture-time-gap");
  }
  rawDiff.compare(reference.rows, candidate.rows, "rows");
  if (rawDiff.count) reasons.push("raw-output-different");
  assessProjection(candidate, projectionDiff);
  if (projectionDiff.count) reasons.push("production-projection-different");
  // Matching incomplete strings proves byte fidelity, not author identity or
  // independently correct titles. Leave those separate unknowns visible.
  const metadata = compareRecords(reference.rows.map((r, i) => normalizeRecord(r, i, reference.provenance.source)),
    candidate.rows.map((r, i) => normalizeRecord(r, i, candidate.provenance.source))).metadata;
  const uniqueReasons = [...new Set(reasons)];
  return { status: uniqueReasons.length ? "fail" : "pass", passed: uniqueReasons.length === 0,
    profile: "pop-output-fidelity", evidenceMode, reasons: uniqueReasons,
    counts: { reference: reference.rows.length, candidate: candidate.rows.length, production: candidate.records?.length ?? null },
    raw: rawDiff.result(), projection: projectionDiff.result(), provenance,
    snapshotEvidence: evidenceMode === "same-snapshot" ? { valid: snapshot.valid, reasons: snapshot.reasons, attestation: snapshotEvidence } : null,
    freshIndependentEvidence: evidenceMode === "live-live" && uniqueReasons.length === 0,
    evidenceScope: evidenceMode === "live-live" ? "Separately invoked current PoP output; acquisition claims must be backed by runner evidence."
      : evidenceMode === "same-snapshot" ? "Two process invocations against an explicitly shared cached snapshot; not independent fresh retrieval."
        : "Recorded input replay; not live search evidence.",
    bibliographicQuality: { status: "not-established", metadata,
      limitation: "Exact PoP output fidelity does not establish independent metadata correctness, author identity, relevance precision or universal search parity." } };
}

function inspectSnapshotEvidence(reference, candidate, evidence) {
  const reasons = [];
  const rp = reference.provenance, cp = candidate.provenance;
  if (!plainObject(evidence)) return { valid: false, reasons: ["missing-snapshot-attestation"] };
  if (typeof evidence.snapshotId !== "string" || !evidence.snapshotId.trim()
    || evidence.snapshotId !== rp.snapshotId || evidence.snapshotId !== cp.snapshotId) reasons.push("unproven-shared-snapshot");
  for (const field of ["source", "query", "profileId"]) {
    if (!Object.hasOwn(evidence, field) || !isDeepStrictEqual(evidence[field], rp[field]) || !isDeepStrictEqual(evidence[field], cp[field])) reasons.push(`snapshot-different-${field}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(evidence.cacheSHA256Before || "") || evidence.cacheSHA256Before !== evidence.cacheSHA256After) reasons.push("snapshot-cache-changed-or-unverified");
  const producer = [rp, cp].find(p => p.acquisition?.invocationId === evidence.producerInvocationId && p.cached === false);
  if (!producer || !evidence.producerInvocationId || !evidence.producedAt || producer.capturedAt !== evidence.producedAt) reasons.push("unproven-snapshot-producer");
  if (rp.cached !== true && cp.cached !== true) reasons.push("shared-snapshot-without-cache-evidence");
  if (producer) for (const p of [rp, cp].filter(p => p.cached === true)) {
    const retrieved = new Date(p.retrievedAt || NaN), produced = new Date(evidence.producedAt);
    if (!Number.isFinite(retrieved.getTime()) || retrieved < produced) reasons.push("snapshot-retrieval-time-unverified");
  }
  return { valid: reasons.length === 0, reasons };
}

const plainObject = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function validJSON(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if ((!Array.isArray(value) && !plainObject(value)) || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? Object.keys(value).length === value.length && value.every(item => validJSON(item, ancestors))
    : Object.keys(value).every(key => validJSON(value[key], ancestors));
  ancestors.delete(value);
  return valid;
}

function inspectEnvelope(value, name, reasons) {
  if (!plainObject(value)) reasons.push(`${name}:invalid-envelope`);
  const envelope = plainObject(value) ? value : {};
  const validRows = Array.isArray(envelope.rows) && validJSON(envelope.rows) && envelope.rows.every(plainObject);
  if (!validRows) reasons.push(`${name}:invalid-raw-rows`);
  if (!plainObject(envelope.provenance)) reasons.push(`${name}:missing-provenance`);
  return { rows: validRows ? envelope.rows : [], provenance: plainObject(envelope.provenance) ? envelope.provenance : {},
    records: envelope.records, partial: envelope.partial === true || envelope.rows?.partial === true || envelope.records?.partial === true,
    errors: Array.isArray(envelope.errors) ? envelope.errors : envelope.errors ? [envelope.errors] : [] };
}

function differenceCollector(limit) {
  let count = 0;
  const differences = [];
  const add = (path, reference, candidate, reason = "different-value") => {
    count++;
    if (differences.length < limit) differences.push({ path, reason,
      ...(reference !== undefined ? { reference } : {}), ...(candidate !== undefined ? { candidate } : {}) });
  };
  const compare = (a, b, path) => {
    if (isDeepStrictEqual(a, b)) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) add(`${path}.length`, a.length, b.length, "different-count");
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (!Object.hasOwn(a, i) || !Object.hasOwn(b, i)) add(`${path}[${i}]`, a[i], b[i], "different-presence");
        else compare(a[i], b[i], `${path}[${i}]`);
      }
    } else if (plainObject(a) && plainObject(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) add(`${path}.${key}`, a[key], b[key], "different-presence");
        else compare(a[key], b[key], `${path}.${key}`);
      }
    } else add(path, a, b, typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) ? "different-type" : "different-value");
  };
  return { add, compare, get count() { return count; }, result: () => ({ equal: count === 0, differenceCount: count, differences, omittedDifferences: count - differences.length }) };
}

// This projection specification is independent of the production normalizer.
// A DOM parser checks displayed text; no sources.js helper is imported here.
function plainTitle(value) {
  const parser = new DOMParser();
  // PoP also returns escaped inline tags. Decode one entity layer before parsing
  // markup, then protect remaining ampersands from a second entity decode.
  const decoded = String(value ?? "").replace(/&(?:#\d+|#x[\da-f]+|amp|lt|gt|quot|apos|nbsp);/gi,
    entity => parser.parseFromString(`<div>${entity}</div>`, "text/html").querySelector("div").textContent);
  const document = parser.parseFromString(`<body><div>${decoded.replace(/&/g, "&amp;")}</div></body>`, "text/html");
  return document.querySelector("div").textContent.replace(/\s+/g, " ").trim();
}

function authorProjection(author) {
  const original = plainObject(author) ? structuredClone(author) : {};
  const name = typeof author === "string" ? author : author?.name
    ?? [author?.firstName ?? author?.given, author?.lastName ?? author?.family].filter(value => value != null && value !== "").join(" ");
  const normalized = String(name ?? "").replace(/\s+/g, " ").trim();
  const names = normalized.includes(",") ? normalized.split(",").slice(0, 2).map(s => s.trim()) : null;
  const words = normalized.split(" ");
  const surname = names ? names[0] : words.pop();
  const given = names ? names[1] || "" : words.join(" ");
  return { ...original, name: typeof author === "string" ? normalized : String(name ?? ""), firstName: original.firstName ?? original.given ?? given,
    lastName: original.lastName ?? original.family ?? surname };
}

function assessProjection(candidate, diff) {
  const { rows, records, provenance } = candidate;
  if (!Array.isArray(records)) { diff.add("records", "array", records, "missing-production-records"); return; }
  if (records.length !== rows.length) diff.add("records.length", rows.length, records.length, "different-count");
  const keys = new Set();
  for (const [i, raw] of rows.entries()) {
    const record = records[i], path = `records[${i}]`;
    if (!plainObject(record)) { diff.add(path, "object", record, "missing-production-record"); continue; }
    const expected = {
      source: provenance.source, searchBackend: "publish-or-perish", engine: "pop", popOriginal: raw,
      popOrdinal: i, popRank: raw.rank ?? null, rank: raw.rank ?? i + 1, popType: raw.type ?? null,
      sourceId: String(raw.uid ?? raw.sourceId ?? raw.doi ?? ""), title: plainTitle(raw.title),
      authors: (Array.isArray(raw.authors) ? raw.authors : raw.authors == null ? [] : [raw.authors]).map(authorProjection), year: raw.year ?? null,
      citations: raw.cites ?? raw.citations ?? null, venue: raw.source ?? raw.venue ?? "",
      publisher: raw.publisher ?? "", abstract: raw.abstract ?? "",
      volume: String(raw.volume ?? ""), issue: String(raw.issue ?? ""),
      pages: raw.startpage != null ? String(raw.startpage) + (raw.endpage != null && raw.endpage !== raw.startpage ? `-${raw.endpage}` : "") : String(raw.pages ?? ""),
      fulltextUrl: raw.fulltext_url ?? null, issn: raw.issn ?? null, pmid: raw.pmid ?? null,
      pmcid: raw.pmcid ?? null, arxiv: raw.arxiv ?? null, popProvenance: provenance
    };
    for (const [field, value] of Object.entries(expected)) {
      if (!Object.hasOwn(record, field)) diff.add(`${path}.${field}`, value, undefined, "different-presence");
      else diff.compare(value, record[field], `${path}.${field}`);
    }
    if (typeof record.key !== "string" || !record.key || keys.has(record.key)) diff.add(`${path}.key`, "unique nonempty occurrence key", record.key, "invalid-occurrence-key");
    keys.add(record.key);
    const doi = canonicalDOI(raw.doi) || canonicalDOI(raw.article_url);
    diff.compare(doi, record.doi, `${path}.doi`);
    diff.compare(raw.article_url ?? raw.url ?? (doi ? `https://doi.org/${doi}` : null), record.url, `${path}.url`);
    if (normalizedTitle(record.titleMarkup || record.title) !== normalizedTitle(raw.title)) diff.add(`${path}.titleMarkup`, raw.title, record.titleMarkup, "changed-title-meaning");
    if (record.popOriginal === raw) diff.add(`${path}.popOriginal`, "independent clone", "shared object", "aliased-original-row");
  }
}

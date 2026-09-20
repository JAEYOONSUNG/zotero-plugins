import { test } from "node:test";
import assert from "node:assert/strict";
import { assessPoPFidelity } from "../scripts/lib/pop-fidelity.mjs";
import { evaluateCase } from "../scripts/benchmark-search.mjs";
import { parsePoPReference } from "../scripts/lib/pop-reference.mjs";
import Sources from "../content/sources.js";
import Query from "../content/query.js";

const NOW = "2026-09-20T06:00:00.000Z";
const options = { now: NOW, timeZone: "UTC" };
const copy = value => structuredClone(value);
const rawRow = n => ({ uid: `GS:${n}`, title: `Thermophilic paper ${n}`, source: "Journal of Microbiology",
  doi: `10.1234/${n}`, rank: n, year: 2020, cites: n, authors: [{ name: "A Author" }, { name: "B Other" }] });
const provenance = invocationId => ({ engine: "publish-or-perish", source: "scholar",
  query: { engine: "pop", keywords: "thermophile", maxResults: 30, popOutputSort: "rank" },
  outputSort: "rank", profileId: "default", capturedAt: NOW, exitCode: 0,
  complete: true, cached: false, cancelled: false, acquisition: { kind: "process", invocationId } });

// Hand-written golden UI rows, intentionally not made with the production mapper.
function goldenRows(rows, p) {
  return rows.map((r, i) => ({ source: "scholar", sourceId: r.uid, engine: "pop", searchBackend: "publish-or-perish",
    popOriginal: copy(r), popOrdinal: i, popRank: r.rank, rank: r.rank, popType: null, key: `golden-row-${i}`,
    title: r.title, titleMarkup: null, authors: [{ name: "A Author", firstName: "A", lastName: "Author" },
      { name: "B Other", firstName: "B", lastName: "Other" }], year: r.year, citations: r.cites,
    venue: r.source, publisher: "", abstract: "", volume: "", issue: "", pages: "", fulltextUrl: null,
    issn: null, pmid: null, pmcid: null, arxiv: null,
    doi: r.doi, url: `https://doi.org/${r.doi}`, popProvenance: copy(p) }));
}
function envelopes(count = 30) {
  const rows = Array.from({ length: count }, (_, i) => rawRow(i + 1));
  const reference = { rows: copy(rows), provenance: provenance("reference-invocation") };
  const candidate = { rows: copy(rows), provenance: provenance("candidate-invocation") };
  candidate.records = goldenRows(candidate.rows, candidate.provenance);
  return { reference, candidate };
}
function assess({ reference, candidate }, extra = {}) { return assessPoPFidelity(reference, candidate, { ...options, ...extra }); }
function withProvenance(envelope, values) {
  Object.assign(envelope.provenance, values);
  if (envelope.records) for (const r of envelope.records) r.popProvenance = copy(envelope.provenance);
}
function productionEnvelopes(rows, source = "scholar") {
  const reference = { rows: copy(rows), provenance: { ...provenance("reference-invocation"), source } };
  const candidate = { rows: copy(rows), provenance: { ...provenance("candidate-invocation"), source } };
  candidate.records = Sources.normalizePoPExactRecords(candidate.rows, source, candidate.provenance);
  return { reference, candidate };
}

test("exact full output passes hand-authored golden projections without modifying either input", () => {
  const pair = envelopes(), before = copy(pair);
  const result = assess(pair);
  assert.equal(result.status, "pass", JSON.stringify(result));
  assert.deepEqual(result.counts, { reference: 30, candidate: 30, production: 30 });
  assert.equal(result.freshIndependentEvidence, true);
  assert.equal(result.bibliographicQuality.status, "not-established");
  assert.deepEqual(pair, before);
});

test("full-array equality rejects changes past top ten and extra rows past the query cap", () => {
  const mutations = {
    "reverse-tail": rows => [...rows.slice(0, 10), ...rows.slice(10).reverse()],
    "extra-31st-row": rows => [...rows, rawRow(31)],
    "drop-30th-row": rows => rows.slice(0, -1),
    "duplicate-row": rows => [...rows.slice(0, -1), copy(rows[0])]
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const pair = envelopes();
    pair.candidate.rows = mutate(pair.candidate.rows);
    pair.candidate.records = goldenRows(pair.candidate.rows, pair.candidate.provenance);
    const result = assess(pair);
    assert.equal(result.status, "fail", name);
    assert.ok(result.reasons.includes("raw-output-different"), name);
    assert.equal(result.freshIndependentEvidence, false, name);
  }
});

test("every raw value, nested attribute, array order, JSON type and field presence matters", () => {
  const mutations = {
    citation: row => { row.cites = 999999; },
    "author-order": row => { row.authors.reverse(); },
    "author-attribute": row => { row.authors[0].orcid = "0000-0000-0000-0000"; },
    uid: row => { row.uid = "GS:changed"; },
    "number-as-string": row => { row.year = "2020"; },
    "missing-to-null": row => { row.fulltext_url = null; },
    "zero-to-absent": row => { delete row.cites; },
    rank: row => { row.rank = 200; },
    "same-doi-wrong-title": row => { row.title = "Unrelated paper"; },
    venue: row => { row.source = "Different Journal"; }
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const pair = envelopes();
    mutate(pair.candidate.rows[29]);
    const result = assess(pair);
    assert.equal(result.status, "fail", name);
    assert.ok(result.reasons.includes("raw-output-different"), name);
    assert.ok(result.raw.differenceCount > 0, name);
  }
  const pair = envelopes();
  pair.candidate.rows[0] = Object.fromEntries(Object.entries(pair.candidate.rows[0]).reverse());
  assert.equal(assess(pair).status, "pass", "JSON object member order is not semantic output order");
});

test("raw equality alone cannot hide corrupt product fields, rank or duplicate selection keys", () => {
  const mutations = {
    title: record => { record.title = "Wrong title"; },
    year: record => { record.year = 0; },
    citations: record => { record.citations = 0; },
    authors: record => { record.authors.reverse(); },
    raw: record => { record.popOriginal.cites = 999; },
    ordinal: record => { record.popOrdinal = 0; },
    rank: record => { record.popRank = 1; },
    "display-rank": record => { record.rank = 1; },
    source: record => { record.source = "crossref"; },
    key: record => { record.key = "golden-row-0"; },
    doi: record => { record.doi = "10.1234/wrong"; },
    url: record => { record.url = "https://example.org/wrong"; },
    type: record => { record.popType = "CITATION"; },
    pmid: record => { record.pmid = "12345"; },
    provenance: record => { record.popProvenance.profileId = "different"; }
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const pair = envelopes();
    mutate(pair.candidate.records[29]);
    const result = assess(pair);
    assert.equal(result.raw.equal, true, name);
    assert.equal(result.status, "fail", name);
    assert.ok(result.reasons.includes("production-projection-different"), name);
  }
  for (const mutate of [pair => { pair.candidate.records.pop(); }, pair => { delete pair.candidate.records; },
    pair => { pair.candidate.records[0].popOriginal = pair.candidate.rows[0]; }]) {
    const pair = envelopes(); mutate(pair);
    assert.equal(assess(pair).status, "fail");
  }
});

test("production normalization preserves titleless grants, duplicate rows, unknowns and author details", () => {
  const rows = [
    { doi: "10.1234/grant", type: "grant", year: 0, rank: 1, cites: 0 },
    { title: "&lt;scp&gt;Geobacillus&lt;/scp&gt; &amp; x<sup>2</sup> at p < 0.05", rank: 2, year: null,
      authors: [{ given: "A", family: "Author", affiliation: { name: "University" } }, "..."],
      source: "Journal …", fulltext_url: "https://example.org/fulltext", volume: 0, issue: 0, startpage: 0, endpage: 2 },
    { title: "Consortia based production of biochemicals", rank: 3, type: "CITATION", year: 0, authors: ["SI Jensen", "..."] },
    { title: "Consortia based production of biochemicals", rank: 4, year: 2016, authors: ["SI Jensen", "..."] }
  ];
  const pair = productionEnvelopes(rows, "crossref"), result = assess(pair);
  assert.equal(result.status, "pass", JSON.stringify(result));
  assert.equal(result.bibliographicQuality.metadata.unverifiable.length, 4);
  assert.equal(result.bibliographicQuality.status, "not-established");
  const unknownRemoved = copy(pair);
  unknownRemoved.candidate.rows[2].authors.pop();
  assert.equal(assess(unknownRemoved).status, "fail");
  const duplicateRemoved = copy(pair);
  duplicateRemoved.candidate.rows.pop();
  assert.equal(assess(duplicateRemoved).status, "fail");
  const changedScript = copy(pair);
  changedScript.candidate.records[1].titleMarkup = "Geobacillus & x<sub>2</sub> at p < 0.05";
  assert.equal(assess(changedScript).status, "fail");
});

test("fidelity of identical truncated bylines never overrides unchanged strict quality failures", () => {
  const raw = [{ title: "Bacterial growth", rank: 1, authors: ["B Other", "..."], year: 2020 }];
  const pair = productionEnvelopes(raw);
  assert.equal(assess(pair).status, "pass");
  const query = { authors: "Sheila Ingemann Jensen", maxResults: 30, sort: "relevance" };
  const reference = parsePoPReference({ records: raw, provenance: { tool: "Publish or Perish", source: "scholar", query, capturedAt: NOW, completed: true } });
  const result = evaluateCase({ id: "self", source: "scholar", query }, { reference, records: raw,
    criteria: { profile: "strict" }, now: NOW, timeZone: "UTC", queryHelper: Query });
  assert.equal(result.status, "fail");
  for (const reason of ["metadata-unverifiable", "unverifiable-fields", "unverified-reference-fields"]) assert.ok(result.reasons.includes(reason), reason);
});

test("fresh evidence fails on mismatched conditions, default/explicit profiles, errors or cache recovery", () => {
  const changes = {
    engine: { engine: "direct" }, source: { source: "crossref" }, profile: { profileId: "/different-profile" },
    query: { query: { engine: "pop", keywords: "different", maxResults: 30, popOutputSort: "rank" } },
    outputSort: { outputSort: "-cites" }, cached: { cached: true }, failed: { exitCode: 1 },
    incomplete: { complete: false }, cancelled: { cancelled: true },
    stale: { capturedAt: "2026-09-19T06:00:00.000Z" }, future: { capturedAt: "2026-09-21T06:00:00.000Z" },
    absentTime: { capturedAt: null },
    sameProcess: { acquisition: { kind: "process", invocationId: "reference-invocation" } },
    copiedFixture: { acquisition: { kind: "fixture", invocationId: "different" } },
    disguisedFixture: { acquisition: { kind: "process", invocationId: "different", copiedFrom: "reference.json" } },
    missingAcquisition: { acquisition: null }, missingQuery: { query: null }
  };
  for (const [name, change] of Object.entries(changes)) {
    const pair = envelopes(); withProvenance(pair.candidate, change);
    const result = assess(pair);
    assert.equal(result.status, "fail", name);
    assert.equal(result.freshIndependentEvidence, false, name);
  }
  for (const name of ["reference", "candidate"]) {
    for (const mark of [envelope => { envelope.partial = true; }, envelope => { envelope.rows.partial = true; },
      envelope => { envelope.errors = ["transport failure"]; }]) {
      const pair = envelopes(); mark(pair[name]);
      assert.equal(assess(pair).status, "fail", name);
    }
  }
  const partialProduct = envelopes(); partialProduct.candidate.records.partial = true;
  assert.equal(assess(partialProduct).status, "fail");
  const gap = envelopes(); withProvenance(gap.reference, { capturedAt: "2026-09-20T04:00:00.000Z" });
  assert.ok(assess(gap).reasons.includes("capture-time-gap"));
});

test("same-snapshot and replay are explicitly labelled and cannot claim independent fresh retrieval", () => {
  const shared = envelopes();
  withProvenance(shared.reference, { snapshotId: "documented-shared-cache" });
  withProvenance(shared.candidate, { snapshotId: "documented-shared-cache", cached: true, capturedAt: null, retrievedAt: NOW });
  const snapshotEvidence = { snapshotId: "documented-shared-cache", producerInvocationId: "reference-invocation", producedAt: NOW,
    source: "scholar", query: copy(shared.reference.provenance.query), profileId: "default", cacheSHA256Before: "a".repeat(64), cacheSHA256After: "a".repeat(64) };
  assert.equal(assess(shared).status, "fail");
  assert.equal(assess(shared, { evidenceMode: "same-snapshot" }).status, "fail", "unknown cache age needs a proven fresh producer");
  const result = assess(shared, { evidenceMode: "same-snapshot", snapshotEvidence });
  assert.equal(result.status, "pass", JSON.stringify(result));
  assert.equal(result.freshIndependentEvidence, false);
  assert.equal(result.provenance.candidate.capturedAt, null, "never manufacture original cache age");
  assert.match(result.evidenceScope, /not independent fresh/);
  for (const change of [{ producerInvocationId: "invented" }, { producedAt: "2026-09-19T06:00:00.000Z" },
    { profileId: "different" }, { source: "crossref" }, { query: {} }, { cacheSHA256After: "b".repeat(64) },
    { cacheSHA256Before: "" }, { snapshotId: "other" }]) {
    assert.equal(assess(shared, { evidenceMode: "same-snapshot", snapshotEvidence: { ...snapshotEvidence, ...change } }).status, "fail", JSON.stringify(change));
  }
  const late = copy(shared); withProvenance(late.candidate, { retrievedAt: "2026-09-20T05:00:00.000Z" });
  assert.equal(assess(late, { evidenceMode: "same-snapshot", snapshotEvidence }).status, "fail");
  const noTime = copy(shared); withProvenance(noTime.candidate, { retrievedAt: null });
  assert.equal(assess(noTime, { evidenceMode: "same-snapshot", snapshotEvidence }).status, "fail");
  withProvenance(shared.candidate, { snapshotId: "different" });
  assert.equal(assess(shared, { evidenceMode: "same-snapshot", snapshotEvidence }).status, "fail");
  const replay = envelopes();
  for (const envelope of [replay.reference, replay.candidate]) withProvenance(envelope,
    { capturedAt: "2025-01-01T00:00:00.000Z", cached: true, acquisition: { kind: "fixture", invocationId: "fixture" } });
  assert.equal(assess(replay).status, "fail");
  const recorded = assess(replay, { evidenceMode: "replay" });
  assert.equal(recorded.status, "pass");
  assert.equal(recorded.freshIndependentEvidence, false);
  withProvenance(replay.candidate, { complete: false });
  assert.equal(assess(replay, { evidenceMode: "replay" }).status, "fail");
});

test("valid completed empty results compare without inventing records", () => {
  const pair = envelopes(0);
  withProvenance(pair.reference, { exitCode: 4 });
  withProvenance(pair.candidate, { exitCode: 4 });
  assert.equal(assess(pair).status, "pass");
  const wrong = envelopes(); withProvenance(wrong.candidate, { exitCode: 4 });
  assert.equal(assess(wrong).status, "fail");
});

test("malformed envelopes fail closed, and truncated diagnostics do not truncate evaluation", () => {
  for (const bad of [null, {}, { rows: [null] }, { rows: [{ year: NaN }] }, { rows: [{ year: undefined }] }]) {
    assert.equal(assessPoPFidelity(bad, bad, options).status, "fail");
  }
  const pair = envelopes(); for (const row of pair.candidate.rows) row.cites = -1;
  const result = assess(pair, { maxDifferences: 1 });
  assert.equal(result.status, "fail");
  assert.equal(result.raw.differenceCount, 30);
  assert.equal(result.raw.differences.length, 1);
  assert.equal(result.raw.omittedDifferences, 29);
  for (const invalid of [{ evidenceMode: "strict" }, { maxAgeHours: 0 }, { maxDifferences: 0 }, { now: "bad" }]) {
    assert.throws(() => assess(pair, invalid));
  }
});

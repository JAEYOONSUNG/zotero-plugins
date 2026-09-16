import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Query from "../content/query.js";
import { evaluateCase } from "./benchmark-search.mjs";
import { loadPoPReference } from "./lib/pop-reference.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const folder = resolve(root, "benchmark");
const read = async path => JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
const config = await read(resolve(folder, "queries.json"));
const baseline = await read(resolve(folder, "results/baseline-report.json"));
const improved = await read(resolve(folder, "results/improved-report.json"));
assert.equal(config.cases.length, 12);
assert.equal(improved.cases.length, config.cases.length);
assert.equal(baseline.cases.length, config.cases.length);
let recovered = 0, targets = 0, direct = 0, bridged = 0;
for (const spec of config.cases) {
	const result = improved.cases.find(c => c.id === spec.id);
	const before = baseline.cases.find(c => c.id === spec.id);
	assert.ok(result && before, `missing case ${spec.id}`);
	assert.deepEqual(result.query, spec.query);
	assert.deepEqual(before.query, spec.query);
	const referencePath = resolve(folder, spec.referencePath);
	const original = await read(referencePath);
	const rawPath = resolve(dirname(referencePath), original.provenance.originalPath);
	assert.ok(rawPath.startsWith(resolve(folder, "references") + "/"));
	const raw = await read(rawPath);
	assert.deepEqual(original.records, Array.isArray(raw) ? raw : raw.$results, `${spec.id}: modified PoP reference`);
	assert.equal(original.provenance.exitCode, 0);
	assert.ok(original.provenance.command.includes("--direct"));
	const reference = await loadPoPReference(referencePath);
	const check = evaluateCase(spec, { reference, records: result.records, errors: result.errors,
		queryHelper: Query, thresholds: config.thresholds, requests: result.requests });
	assert.equal(check.status, "pass", `${spec.id}: ${check.reasons.join(", ")}`);
	assert.equal(check.top.recall, 1, `${spec.id}: top references missing`);
	assert.deepEqual(check.top.matches, result.top.matches);
	assert.equal(check.fields.violations.length, 0);
	assert.ok(result.requests.length > 0, `${spec.id}: no execution evidence`);
	if (spec.source === "scholar") {
		assert.equal(result.transport, "installed-publish-or-perish");
		assert.ok(result.requests.some(r => r.method === "CLI"));
		bridged++;
	} else {
		assert.equal(result.transport, "direct");
		assert.ok(result.requests.some(r => r.method === "GET" && r.status === 200));
		direct++;
	}
	recovered += check.top.matches.length;
	targets += Math.min(config.thresholds.referenceTopK, reference.records.length);
}
assert.equal(direct, 6); assert.equal(bridged, 6);
assert.ok(baseline.summary.passed < improved.summary.passed);
console.log(`comparison verified: ${config.cases.length}/${config.cases.length} cases, ${recovered}/${targets} top references, ${direct} direct API and ${bridged} installed PoP cases`);

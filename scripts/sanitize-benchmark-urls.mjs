#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const benchmark = resolve(root, "benchmark");
const privateRoot = resolve(root, "build/pop-parity/private-originals");
const manifestPath = resolve(benchmark, "privacy-manifest.json");
const sensitiveName = name => /token|secret|password|api[-_]?key|authorization/i.test(name);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const parse = bytes => JSON.parse(String(bytes).replace(/^\uFEFF/, ""));
const encode = value => JSON.stringify(value, null, 2) + "\n";

async function jsonFiles(folder) {
	const files = [];
	for (const entry of await readdir(folder, { withFileTypes: true })) {
		const path = resolve(folder, entry.name);
		if (entry.isDirectory()) files.push(...await jsonFiles(path));
		else if (entry.isFile() && entry.name.endsWith(".json") && path !== manifestPath) files.push(path);
	}
	return files.sort();
}

function sanitizeURL(value, removed) {
	if (!/^https?:\/\//i.test(value)) return value;
	const hashIndex = value.indexOf("#");
	const body = hashIndex < 0 ? value : value.slice(0, hashIndex);
	const fragment = hashIndex < 0 ? "" : value.slice(hashIndex);
	const queryIndex = body.indexOf("?");
	if (queryIndex < 0) return value;
	let count = 0;
	const kept = body.slice(queryIndex + 1).split("&").filter(part => {
		let name;
		try { name = decodeURIComponent(part.split("=", 1)[0].replace(/\+/g, " ")); }
		catch { return true; }
		if (!sensitiveName(name)) return true;
		removed[name] = (removed[name] || 0) + 1;
		count++;
		return false;
	});
	return count ? body.slice(0, queryIndex) + (kept.length ? "?" + kept.join("&") : "") + fragment : value;
}

function sanitize(value, removed) {
	if (typeof value === "string") return sanitizeURL(value, removed);
	if (Array.isArray(value)) return value.map(child => sanitize(child, removed));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitize(child, removed)]));
	return value;
}

// Independent URL parsing checks the exported query keys. No values enter logs.
function sensitiveParameters(value) {
	if (typeof value === "string") {
		if (!/^https?:\/\//i.test(value)) return 0;
		try { return [...new URL(value).searchParams.keys()].filter(sensitiveName).length; }
		catch { return 0; }
	}
	if (Array.isArray(value)) return value.reduce((sum, child) => sum + sensitiveParameters(child), 0);
	if (value && typeof value === "object") return Object.values(value).reduce((sum, child) => sum + sensitiveParameters(child), 0);
	return 0;
}

function containedPath(base, path) {
	const result = resolve(root, path);
	if (!result.startsWith(base + sep)) throw new Error("Manifest path escapes its declared directory");
	return result;
}

async function check() {
	const manifest = parse(await readFile(manifestPath));
	let removed = 0, remaining = 0;
	for (const entry of manifest.files) {
		const original = await readFile(containedPath(privateRoot, entry.originalPath));
		const shared = await readFile(containedPath(benchmark, entry.path));
		if (sha256(original) !== entry.originalSha256 || sha256(shared) !== entry.sanitizedSha256) throw new Error(`Artifact hash mismatch: ${entry.path}`);
		const counts = {};
		const expected = sanitize(parse(original), counts);
		if (!isDeepStrictEqual(expected, parse(shared))) throw new Error(`Changes beyond sensitive URL parameters: ${entry.path}`);
		if (!isDeepStrictEqual(counts, entry.removedParameterCounts)) throw new Error(`Removal count mismatch: ${entry.path}`);
		removed += Object.values(counts).reduce((sum, count) => sum + count, 0);
	}
	for (const path of await jsonFiles(benchmark)) remaining += sensitiveParameters(parse(await readFile(path)));
	if (remaining) throw new Error(`Shared artifacts still contain ${remaining} sensitive URL query parameters`);
	console.log(`privacy verified: ${manifest.files.length} sanitized files, ${removed} removed parameters, ${remaining} remaining`);
}

async function apply() {
	let existing = false;
	try {
		await readFile(manifestPath);
		existing = true;
	} catch (error) { if (error.code !== "ENOENT") throw error; }
	if (existing) { await check(); return; }
	const changes = [];
	for (const path of await jsonFiles(benchmark)) {
		const original = await readFile(path), removedParameterCounts = {};
		const shared = sanitize(parse(original), removedParameterCounts);
		if (!Object.keys(removedParameterCounts).length) continue;
		const bytes = Buffer.from(encode(shared));
		const repositoryPath = relative(root, path);
		const originalPath = resolve(privateRoot, repositoryPath);
		changes.push({ path, original, bytes, entry: { path: repositoryPath, originalPath: relative(root, originalPath),
			originalSha256: sha256(original), sanitizedSha256: sha256(bytes), removedParameterCounts } });
	}
	// Preserve every original before changing any shared artifact.
	for (const change of changes) {
		const path = resolve(root, change.entry.originalPath);
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		try { await writeFile(path, change.original, { flag: "wx", mode: 0o600 }); }
		catch (error) {
			if (error.code !== "EEXIST" || sha256(await readFile(path)) !== change.entry.originalSha256) throw new Error(`Original preservation failed: ${change.entry.path}`);
		}
	}
	for (const change of changes) await writeFile(change.path, change.bytes);
	const manifest = { version: 1, createdAt: new Date().toISOString(),
		policy: "Only URL query parameters with token, secret, password, api-key or authorization names were removed; all other JSON values are preserved.",
		originalLocation: "Ignored local build directory; originals are not part of shared artifacts.",
		reportHashMeaning: "Existing report reference SHA-256 values identify the original comparison inputs. This manifest maps each original input to its URL-sanitized export.",
		files: changes.map(change => change.entry) };
	await writeFile(manifestPath, encode(manifest));
	await writeFile(resolve(privateRoot, "sha256-manifest.json"), encode(manifest), { mode: 0o600 });
	await check();
}

const mode = process.argv[2] || "--check";
if (process.argv.length > 3 || !["--apply", "--check"].includes(mode)) {
	console.error("Usage: node scripts/sanitize-benchmark-urls.mjs [--apply|--check]");
	process.exitCode = 2;
} else {
	(mode === "--apply" ? apply() : check()).catch(error => { console.error(error.message); process.exitCode = 1; });
}

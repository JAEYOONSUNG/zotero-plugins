import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import Bridge from "../content/pop.js";

const source = await fs.readFile(new URL("../content/pop.js", import.meta.url), "utf8");
function deferred() {
	let resolve, reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}
async function fixture(t, body) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zotpop-bridge-"));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const executable = path.join(dir, "fixture executable.cjs"), dataDir = path.join(dir, "separate data");
	await fs.writeFile(executable, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
	return { dir, executable, dataDir, ctx: { popExecutable: executable, popDataDir: dataDir } };
}

function geckoHarness({ stdout = ['[{"title":"native result"}]'], stderr = [], exitCode = 0, pending = false, missing = false, onWrite } = {}) {
	const calls = [], directories = [], started = deferred(), ended = deferred(), files = new Map();
	let kills = 0, stdinClosed = 0;
	function pipe(chunks) {
		let index = 0;
		return { async readString() {
			if (index < chunks.length) return chunks[index++];
			if (pending) await ended.promise;
			return "";
		} };
	}
	const child = {
		stdout: pipe(stdout), stderr: pipe(stderr),
		stdin: { async close() { stdinClosed++; } },
		wait: () => pending ? ended.promise : Promise.resolve({ exitCode }),
		async kill() { kills++; ended.resolve({ exitCode: -15 }); return { exitCode: -15 }; }
	};
	const context = vm.createContext({
		TextEncoder,
		Services: { dirsvc: { get: () => ({ path: "/fixture/home" }) }, env: { get: () => "" } },
		Ci: { nsIFile: {} },
		PathUtils: { join: path.posix.join, isAbsolute: path.posix.isAbsolute, filename: path.posix.basename },
		IOUtils: { async stat(file) {
			if (files.has(file)) return { type: "regular", size: new TextEncoder().encode(files.get(file)).length, lastModified: Date.now() };
			if (missing || file.includes("zotpop-snapshots")) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
			return { type: "regular" };
		}, async makeDirectory(dir, options) { directories.push({ dir, options }); },
			async readUTF8(file) { return files.get(file); }, async writeUTF8(file, value, options) { assert.equal(options.tmpPath, file + ".tmp"); files.set(file, value); onWrite?.(); },
			async setPermissions(_file, mode) { assert.equal(mode, 0o600); }, async getChildren() { return [...files.keys()]; }, async remove(file) { files.delete(file); } },
		Zotero: { isMac: true, isWin: false, Prefs: { get: () => "" } },
		ChromeUtils: { importESModule(uri) {
			assert.equal(uri, "resource://gre/modules/Subprocess.sys.mjs");
			return { Subprocess: { async call(options) { calls.push(options); started.resolve(); return child; } } };
		} }
	});
	vm.runInContext(source, context);
	return { bridge: context.ZotPoPPoPBridge, calls, directories, files, started: started.promise,
		kills: () => kills, stdinClosed: () => stdinClosed };
}

test("query arguments preserve literal values and use a separate data directory without a shell", async t => {
	const f = await fixture(t, 'process.stdout.write(JSON.stringify([{title:"fixture",args:process.argv.slice(2)}]));');
	const query = { keywords: 'gene "editing"; $(touch unwanted) OR repair', title: "Precise paper",
		authors: "David R Liu", venue: "Nature", yearFrom: 2018, yearTo: 2025, maxResults: 30, sort: "citations" };
	const progress = [];
	const rows = await Bridge.search(query, { ...f.ctx, onProgress: message => progress.push(message) });
	assert.deepEqual(rows[0].args, ["--datadir", f.dataDir, "--gscholar", "--keywords", query.keywords,
		"--title", query.title, "--author", query.authors, "--journal", query.venue,
		"--years", "2018-2025", "--max", "30", "--direct", "--sort", "rank", "--format", "json", "--noerrlog"]);
	assert.equal((await fs.stat(f.dataDir)).isDirectory(), true);
	assert.equal(progress.length, 2);
	assert.match(progress[0], /^Google Scholar via Publish or Perish:/);
});

test("missing executable returns null but an invalid executable remains an error", async t => {
	const f = await fixture(t, "");
	assert.equal(await Bridge.search({ keywords: "query" }, { ...f.ctx, popExecutable: path.join(f.dir, "missing") }), null);
	await fs.chmod(f.executable, 0o644);
	await assert.rejects(Bridge.search({ keywords: "query" }, f.ctx), { code: "EACCES" });
	await assert.rejects(Bridge.search({ keywords: "query" }, { ...f.ctx, popExecutable: f.dir }), /not a file/);
});

test("successful output validates JSON and respects the requested result cap", async t => {
	const f = await fixture(t, 'process.stdout.write("\\uFEFF" + JSON.stringify([{title:"one"},{title:"two"}]));');
	assert.deepEqual(await Bridge.search({ keywords: "query", maxResults: 1 }, f.ctx), [{ title: "one" }]);
	assert.deepEqual(Bridge.parseResults('{"$query":{},"$results":[]}', 10), []);
	for (const invalid of ["captcha html", "{}", "[null]", '[{"title":""}]', '{"$results":[3]}']) {
		assert.throws(() => Bridge.parseResults(invalid, 10), /invalid/);
	}
});

test("PoP errors and malformed stdout cannot silently become a fallback or empty results", async t => {
	const failed = await fixture(t, 'process.stdout.write("[]"); process.stderr.write("Google Scholar CAPTCHA required"); process.exitCode=7;');
	await assert.rejects(Bridge.search({ keywords: "query" }, failed.ctx), /failed \(7\).*CAPTCHA/);
	const malformed = await fixture(t, 'process.stdout.write("not json");');
	await assert.rejects(Bridge.search({ keywords: "query" }, malformed.ctx), /invalid JSON/);
});

test("PoP exit 4 means a successful empty query while exit 3 remains a source failure", async t => {
	const empty = await fixture(t, 'process.stderr.write("514 No matching data"); process.exitCode=4;');
	const progress = [];
	assert.deepEqual(await Bridge.search({ keywords: "query" }, { ...empty.ctx, onProgress: message => progress.push(message) }), []);
	assert.match(progress.at(-1), /0 results$/);
	const unavailable = await fixture(t, 'process.stdout.write("[]"); process.stderr.write("Data source unavailable"); process.exitCode=3;');
	await assert.rejects(Bridge.search({ keywords: "query" }, unavailable.ctx), /failed \(3\).*Data source unavailable/);
});

test("invalid criteria fail before any child process is started", () => {
	for (const query of [{}, { keywords: "x\0y" }, { keywords: "x", maxResults: -1 },
		{ keywords: "x", maxResults: 2.5 }, { keywords: "x", yearFrom: 2025, yearTo: 2020 }, { keywords: "x", yearFrom: "bad" }]) {
		assert.throws(() => Bridge.buildArguments(query, "/data"));
	}
	assert.ok(Bridge.buildArguments({ title: "title", yearFrom: 2020 }, "/data").includes("2020-"));
	assert.ok(Bridge.buildArguments({ title: "title", yearTo: 2025 }, "/data").includes("-2025"));
});

test("Node cancellation terminates a child that ignores SIGTERM and preserves AbortError", async t => {
	const f = await fixture(t, `
		const fs = require('node:fs');
		const path = require('node:path');
		process.on('SIGTERM', () => {});
		fs.writeFileSync(path.join(process.argv[process.argv.indexOf('--datadir')+1], 'ready'), String(process.pid));
		setInterval(() => {}, 1000);
	`);
	const controller = new AbortController();
	const running = Bridge.search({ keywords: "query" }, { ...f.ctx, signal: controller.signal });
	const outcome = assert.rejects(running, { name: "AbortError" });
	let pid;
	const deadline = Date.now() + 5000;
	while (!pid && Date.now() < deadline) {
		try { pid = Number(await fs.readFile(path.join(f.dataDir, "ready"), "utf8")); }
		catch (_) { await new Promise(resolve => setTimeout(resolve, 10)); }
	}
	controller.abort();
	await outcome;
	assert.ok(pid, "fixture process actually started before cancellation");
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("an already cancelled search starts neither a native nor Node child", async t => {
	const f = await fixture(t, 'throw new Error("must not execute");');
	const controller = new AbortController(); controller.abort();
	await assert.rejects(Bridge.search({ keywords: "query" }, { ...f.ctx, signal: controller.signal }), { name: "AbortError" });
	const native = geckoHarness();
	await assert.rejects(native.bridge.search({ keywords: "query" }, { signal: controller.signal }), { name: "AbortError" });
	assert.equal(native.calls.length, 0);
});

test("Gecko uses the verified streaming subprocess interface and detaches cancellation after completion", async () => {
	const native = geckoHarness({ stdout: ['[{"title":', '"한국어 paper"}]'], stderr: ["search progress", "complete"] });
	const controller = new AbortController();
	const rows = await native.bridge.search({ keywords: "query", maxResults: 5 }, { signal: controller.signal });
	assert.equal(rows[0].title, "한국어 paper");
	assert.equal(native.calls[0].command, "/fixture/home/Library/Application Support/ZotPoP/tools/pop8query");
	assert.equal(native.calls[0].stderr, "pipe");
	assert.equal(native.directories[0].dir, "/fixture/home/Library/Application Support/ZotPoP/PoPData");
	assert.equal(native.stdinClosed(), 1);
	controller.abort();
	assert.equal(native.kills(), 0);
});

test("Gecko kills an in-flight subprocess even when cancellation races with process creation", async () => {
	const native = geckoHarness({ pending: true });
	const controller = new AbortController();
	const running = native.bridge.search({ keywords: "query" }, { signal: controller.signal });
	await native.started;
	controller.abort();
	await assert.rejects(running, { name: "AbortError" });
	assert.equal(native.kills(), 1);
});

test("Gecko missing executable falls back while nonzero exits remain visible", async () => {
	const absent = geckoHarness({ missing: true });
	assert.equal(await absent.bridge.search({ keywords: "query" }), null);
	assert.equal(absent.calls.length, 0);
	const failed = geckoHarness({ exitCode: 8, stderr: ["Search unavailable"] });
	await assert.rejects(failed.bridge.search({ keywords: "query" }), /failed \(8\).*Search unavailable/);
});

const cachedRows = count => Array.from({ length: count }, (_, i) => ({ uid: `GS:${i + 1}`, title: `Recovered paper ${i + 1}`, rank: i + 1 }));
async function snapshotFiles(f) {
	const directory = path.join(f.dataDir, "zotpop-snapshots");
	return (await fs.readdir(directory)).filter(name => name.endsWith(".json")).map(name => path.join(directory, name));
}

test("a failed large query performs one offline replay and returns explicitly incomplete recovered rows", async t => {
	const f = await fixture(t, `
		const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2);
		const dir = args[args.indexOf('--datadir')+1];
		fs.appendFileSync(path.join(dir, 'calls'), JSON.stringify(args)+'\\n');
		if (args.includes('--offline')) {
			const cap = Number(args[args.indexOf('--max')+1]);
			process.stdout.write(JSON.stringify(Array.from({length:cap}, (_,i)=>({title:'Recovered '+i}))));
		} else { process.stderr.write('Progress: 210 (of 1000)\\nGoogle Scholar CAPTCHA'); process.exitCode=3; }
	`);
	const ctx = { ...f.ctx, errors: [], recoveryMaxResults: 1000 }, query = { keywords: "Geobacillus", maxResults: 1000 };
	const rows = await Bridge.search(query, ctx);
	assert.equal(rows.length, 210);
	assert.equal(rows.partial, true);
	assert.equal(rows.cached, true);
	assert.ok(Number.isFinite(Date.parse(rows.capturedAt)));
	assert.match(ctx.errors[0], /search incomplete.*210 cached results/);
	const calls = (await fs.readFile(path.join(f.dataDir, "calls"), "utf8")).trim().split("\n").map(JSON.parse);
	assert.equal(calls.length, 2);
	assert.ok(calls[0].includes("--direct"));
	assert.ok(calls[1].includes("--offline"));
	assert.ok(!calls[1].includes("--direct"));
	assert.equal(calls[1][calls[1].indexOf("--max") + 1], "210");
	assert.equal((await snapshotFiles(f)).length, 1);
});

test("offline recovery preserves a literal --direct query value and does not cycle after failure", async t => {
	const f = await fixture(t, `
		const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2);
		fs.appendFileSync(path.join(args[args.indexOf('--datadir')+1], 'calls'), JSON.stringify(args)+'\\n');
		process.stderr.write('Progress: 3 (of 10)\\nUnavailable'); process.exitCode=3;
	`);
	await assert.rejects(Bridge.search({ keywords: "--direct", maxResults: 10 }, f.ctx), /failed \(3\)/);
	const calls = (await fs.readFile(path.join(f.dataDir, "calls"), "utf8")).trim().split("\n").map(JSON.parse);
	assert.equal(calls.length, 2);
	assert.equal(calls[1][calls[1].indexOf("--keywords") + 1], "--direct");
	assert.ok(calls[1].includes("--offline"));
});

test("page-zero blocking restores a broader exact-query snapshot and preserves its capture time", async t => {
	const f = await fixture(t, 'process.stderr.write("Google Scholar CAPTCHA"); process.exitCode=3;');
	const capturedAt = new Date(Date.now() - 2000).toISOString();
	await Bridge.storeSnapshot({ keywords: "Geobacillus", maxResults: 1000 }, cachedRows(210), { ...f.ctx, s2ApiKey: "do-not-persist-this-secret" }, { capturedAt, complete: false });
	const ctx = { ...f.ctx, recoveryMaxResults: 1000 };
	const rows = await Bridge.search({ keywords: "Geobacillus", maxResults: 30, sort: "date" }, ctx);
	assert.equal(rows.length, 210);
	assert.equal(rows.capturedAt, capturedAt);
	assert.equal(rows.partial, true);
	assert.match(ctx.errors[0], /ZotPoP snapshot/);
	assert.ok(!(await fs.readFile((await snapshotFiles(f))[0], "utf8")).includes("do-not-persist-this-secret"));
	const limited = await Bridge.search({ keywords: "Geobacillus", maxResults: 30 }, { ...f.ctx, popCacheOnly: true, recoveryMaxResults: 100 });
	assert.equal(limited.length, 100);
});

test("a fresh preliminary probe retains larger recent data, but a complete smaller response replaces it", async t => {
	const f = await fixture(t, `process.stdout.write(JSON.stringify(${JSON.stringify(cachedRows(30))}));`);
	const query = { keywords: "Geobacillus", maxResults: 1000 };
	await Bridge.storeSnapshot(query, cachedRows(210), f.ctx, { capturedAt: new Date(Date.now() - 1000).toISOString(), complete: false });
	const probe = await Bridge.search({ ...query, maxResults: 30 }, f.ctx);
	assert.equal(probe.partial, undefined, "the successful probe itself remains a fresh result");
	let cached = await Bridge.search(query, { ...f.ctx, popCacheOnly: true });
	assert.equal(cached.length, 210);
	await fs.writeFile(f.executable, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(${JSON.stringify(cachedRows(12))}));\n`);
	await Bridge.search({ ...query, maxResults: 30 }, f.ctx);
	cached = await Bridge.search(query, { ...f.ctx, popCacheOnly: true });
	assert.equal(cached.length, 12);
	assert.equal(cached.partial, true, "even a previously complete snapshot is disclosed as cached on reuse");
});

test("cache-only mode never starts a process and refuses different, expired or corrupted criteria", async t => {
	const f = await fixture(t, 'throw new Error("must not run");');
	const query = { keywords: "Geobacillus", yearFrom: 2018, exclusions: ["cancer"] };
	await Bridge.storeSnapshot(query, cachedRows(2), f.ctx, { complete: false });
	for (const other of [{ ...query, keywords: "Bacillus" }, { ...query, yearFrom: 2015 }, { ...query, exclusions: [] }]) {
		await assert.rejects(Bridge.search(other, { ...f.ctx, popCacheOnly: true }), /No matching PoP snapshot/);
	}
	const file = (await snapshotFiles(f))[0], original = JSON.parse(await fs.readFile(file, "utf8"));
	for (const bad of [
		{ ...original, capturedAt: new Date(Date.now() - 25 * 3600_000).toISOString() },
		{ ...original, capturedAt: new Date(Date.now() + 3600_000).toISOString() },
		{ ...original, queryKey: "another-query" },
		{ ...original, criteria: { keywords: "Bacillus" } },
		{ ...original, rows: [{ uid: "missing-title" }] }
	]) {
		await fs.writeFile(file, JSON.stringify(bad));
		await assert.rejects(Bridge.search(query, { ...f.ctx, popCacheOnly: true }), /No matching PoP snapshot/);
	}
	await fs.writeFile(file, " ".repeat(8 * 1024 * 1024 + 1));
	await assert.rejects(Bridge.search(query, { ...f.ctx, popCacheOnly: true }), /No matching PoP snapshot/);
});

test("snapshot storage bounds file count and serializes competing writes without losing broader data", async t => {
	const f = await fixture(t, "");
	const query = { keywords: "same" };
	await Promise.all([Bridge.storeSnapshot(query, cachedRows(20), f.ctx, { complete: false }),
		Bridge.storeSnapshot(query, cachedRows(3), f.ctx, { complete: false })]);
	assert.equal((await Bridge.search(query, { ...f.ctx, popCacheOnly: true })).length, 20);
	for (let i = 0; i < 14; i++) await Bridge.storeSnapshot({ keywords: "distinct " + i }, cachedRows(1), f.ctx, { complete: false });
	assert.equal((await snapshotFiles(f)).length, 12);
	await assert.rejects(Bridge.storeSnapshot(query, cachedRows(2001), f.ctx), /Invalid or expired/);
});

test("cancellation with a valid snapshot still returns AbortError without recovery", async t => {
	const f = await fixture(t, `
		const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2);
		fs.writeFileSync(path.join(args[args.indexOf('--datadir')+1], 'ready'), 'yes');
		process.stderr.write('Progress: 10 (of 1000)'); setInterval(()=>{},1000);
	`);
	const query = { keywords: "Geobacillus", maxResults: 1000 };
	await Bridge.storeSnapshot(query, cachedRows(210), f.ctx, { complete: false });
	const controller = new AbortController(), ctx = { ...f.ctx, signal: controller.signal };
	const running = Bridge.search(query, ctx), outcome = assert.rejects(running, { name: "AbortError" });
	const deadline = Date.now() + 5000;
	let started = false;
	while (!started && Date.now() < deadline) {
		try { await fs.stat(path.join(f.dataDir, "ready")); started = true; }
		catch (_) { await new Promise(resolve => setTimeout(resolve, 10)); }
	}
	controller.abort();
	await outcome;
	assert.ok(started);
	assert.equal(ctx.errors, undefined);
});

test("Gecko snapshot IO uses exact criteria and returns tagged cached rows without running PoP", async () => {
	const native = geckoHarness();
	const query = { keywords: "Geobacillus", maxResults: 1000 };
	await native.bridge.storeSnapshot(query, cachedRows(210), {}, { complete: false });
	assert.equal(native.files.size, 1);
	const ctx = { popCacheOnly: true, recoveryMaxResults: 1000 };
	const rows = await native.bridge.search({ ...query, maxResults: 30 }, ctx);
	assert.equal(rows.length, 210);
	assert.equal(rows.partial, true);
	assert.equal(rows.cached, true);
	assert.equal(native.calls.length, 0);
	assert.match(ctx.errors[0], /cached results/);
});

test("cancellation during snapshot IO cannot turn into a completed successful search", async () => {
	const controller = new AbortController();
	const native = geckoHarness({ onWrite: () => controller.abort() });
	await assert.rejects(native.bridge.search({ keywords: "query" }, { signal: controller.signal }), { name: "AbortError" });
});

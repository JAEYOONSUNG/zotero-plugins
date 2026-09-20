/* global ChromeUtils, Services, Ci, IOUtils, PathUtils, Zotero */
/* Optional adapter for the user's separately installed Publish or Perish CLI. */
var ZotPoPPoPBridge = (function () {
	"use strict";
	const isNode = typeof module !== "undefined" && module.exports && typeof require === "function";
	const MAX_OUTPUT = 20 * 1024 * 1024;
	const MAX_ERROR = 64 * 1024;
	const LABEL = "Google Scholar via Publish or Perish";
	const SNAPSHOT_MAX_AGE = 24 * 60 * 60 * 1000;
	const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
	const SNAPSHOT_MAX_FILES = 12;
	const snapshotWrites = new Map();
	const SOURCE_FLAGS = Object.freeze({
		scholar: "--gscholar", crossref: "--crossref", pubmed: "--pubmed", openalex: "--openalex",
		semanticscholar: "--semscholar", scholarauthor: "--gsauthor", scholarprofile: "--gsprofile",
		scholarciting: "--gsciting", hadb: "--hadb", lens: "--lens", scopus: "--scopus",
		wos: "--wos", wosexpanded: "--wosexpanded", wosstarter: "--wosstarter"
	});
	const SOURCE_FIELDS = Object.freeze({ keywords: "--keywords", title: "--title", authors: "--author", venue: "--journal",
		affiliation: "--affiliation", issn: "--issn", citedId: "--citedid", field: "--field" });
	const OUTPUT_SORTS = new Set(["rank", "author", "cites", "cites_annual", "cites_norm", "source", "title", "year"]);

	function abortError() {
		return Object.assign(new Error("Publish or Perish search cancelled"), { name: "AbortError" });
	}
	function checkCancelled(ctx) {
		if (ctx.signal?.aborted || ctx.isCancelled?.()) throw abortError();
	}
	function reportProgress(stderr, ctx) {
		let matches = [...stderr.matchAll(/Progress:\s*(\d+)\s*\(of\s*(\d+)\)/g)];
		let last = matches[matches.length - 1];
		if (last) ctx.onProgress?.(`${ctx.popProgressLabel || LABEL}: ${last[1]} / ${last[2]}`, Number(last[1]), Number(last[2]));
		let positive = matches.filter(match => Number(match[1]) > 0).at(-1);
		if (positive) ctx._popProgressCount = Number(positive[1]);
	}
	function text(value, field) {
		let result = String(value ?? "").trim();
		if (result.includes("\0")) throw new Error(`Invalid ${field}: contains a null character`);
		return result;
	}
	function maxResults(query) {
		let max = Number(query.maxResults ?? 200);
		if (!Number.isInteger(max) || max < 1 || max > 2000) throw new Error("PoP result limit must be an integer from 1 to 2000");
		return max;
	}
	function buildArguments(query, dataDir) {
		let args = ["--datadir", dataDir, "--gscholar"];
		let hasQuery = false;
		for (let [key, flag] of [["keywords", "--keywords"], ["title", "--title"], ["authors", "--author"], ["venue", "--journal"]]) {
			let value = text(query[key], key);
			if (value) { args.push(flag, value); hasQuery = true; }
		}
		if (!hasQuery) throw new Error("Enter at least one search field");
		let year = key => {
			if (query[key] == null || query[key] === "") return "";
			let value = Number(query[key]);
			if (!Number.isInteger(value) || value < 1500 || value > 2100) throw new Error(`Invalid ${key}`);
			return String(value);
		};
		let from = year("yearFrom"), to = year("yearTo");
		if (from && to && from > to) throw new Error("Start year must not exceed end year");
		if (from || to) args.push("--years", from + "-" + to);
		args.push("--max", String(maxResults(query)), "--direct", "--sort", "rank", "--format", "json", "--noerrlog");
		return args;
	}

	function nativeText(value, field) {
		if (value == null) return "";
		if (typeof value !== "string" || value.includes("\0")) throw new Error(`Invalid PoP ${field}`);
		return value;
	}

	function buildSourceArguments(sourceKey, query, dataDir = null, cachePolicy = "refresh") {
		if (!Object.hasOwn(SOURCE_FLAGS, sourceKey)) throw new Error("Unsupported Publish or Perish source: " + sourceKey);
		if (!["refresh", "offline"].includes(cachePolicy)) throw new Error("Invalid PoP cache policy");
		let raw = nativeText(query.popRaw, "raw query"), outputSort = nativeText(query.popOutputSort, "output sort") || "rank";
		if (!OUTPUT_SORTS.has(outputSort.replace(/^-/, ""))) throw new Error("Invalid PoP output sort");
		let fields = Object.fromEntries(Object.keys(SOURCE_FIELDS).map(key => [key, nativeText(query[key], key)]));
		let hasFields = Object.values(fields).some(value => value.trim());
		let hasYear = key => query[key] != null && query[key] !== "";
		if (raw.trim() && (hasFields || hasYear("yearFrom") || hasYear("yearTo"))) throw new Error("PoP raw query cannot be combined with ordinary search fields or years");
		if (!raw.trim() && !hasFields) throw new Error("Enter at least one PoP search field or native query");
		let args = [];
		if (dataDir) args.push("--datadir", dataDir);
		args.push(SOURCE_FLAGS[sourceKey]);
		if (raw.trim()) args.push("--raw", raw);
		else {
			for (let [key, flag] of Object.entries(SOURCE_FIELDS)) if (fields[key].trim()) args.push(flag, fields[key]);
			let year = key => {
				if (!hasYear(key)) return "";
				let value = Number(query[key]);
				if (!Number.isInteger(value) || value < 1500 || value > 2100) throw new Error(`Invalid ${key}`);
				return String(value);
			};
			let from = year("yearFrom"), to = year("yearTo");
			if (from && to && from > to) throw new Error("Start year must not exceed end year");
			if (from || to) args.push("--years", from + "-" + to);
		}
		args.push("--max", String(maxResults(query)), cachePolicy === "offline" ? "--offline" : "--direct",
			"--sort", outputSort, "--format", "json", "--noerrlog");
		return args;
	}

	function parseSourceResults(stdout) {
		let data;
		try { data = JSON.parse(stdout.replace(/^\uFEFF/, "")); }
		catch (_) { throw new Error("Publish or Perish returned invalid JSON"); }
		let rows = Array.isArray(data) ? data : data?.$results;
		if (!Array.isArray(rows) || rows.some(row => !row || Array.isArray(row) || typeof row !== "object")) {
			throw new Error("Publish or Perish returned an invalid result list");
		}
		if (!Array.isArray(data) && data.$query && (data.$query.ErrorDetails
			|| ["LastResult", "LastSubResult"].some(key => data.$query[key] !== undefined && Number(data.$query[key]) !== 0))) {
			throw new Error("Publish or Perish output reports an incomplete query");
		}
		return rows;
	}

	function nodeRuntime() {
		const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
		const home = os.homedir();
		let base = process.platform === "darwin" ? path.join(home, "Library", "Application Support")
			: process.platform === "win32" ? process.env.APPDATA || path.join(home, "AppData", "Roaming")
				: process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
		return {
			join: path.join,
			uuid: () => require("node:crypto").randomUUID(),
			basename: path.basename,
			isAbsolute: path.isAbsolute,
			supportDir: path.join(base, "ZotPoP"),
			executableName: process.platform === "win32" ? "pop8query.exe" : "pop8query",
			pref: () => "",
			async exists(executable) {
				try {
					let stat = await fs.stat(executable);
					if (!stat.isFile()) throw new Error("PoP executable path is not a file: " + executable);
					await fs.access(executable, require("node:fs").constants.X_OK);
					return true;
				}
				catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return false; throw e; }
			},
			mkdir: dir => fs.mkdir(dir, { recursive: true, mode: 0o700 }),
			async readSnapshot(file) {
				let stat = await fs.stat(file);
				if (!stat.isFile() || stat.size > SNAPSHOT_MAX_BYTES) throw new Error("Invalid snapshot size or type");
				return fs.readFile(file, "utf8");
			},
			async writeSnapshot(file, value) {
				let tmp = file + ".tmp";
				try { await fs.writeFile(tmp, value, { mode: 0o600 }); await fs.rename(tmp, file); }
				finally { await fs.rm(tmp, { force: true }); }
			},
			async listSnapshots(dir) { return Promise.all((await fs.readdir(dir)).map(async name => {
				let file = path.join(dir, name), stat = await fs.stat(file);
				return { file, modified: stat.mtimeMs };
			})); },
			removeSnapshot: file => fs.rm(file, { force: true }),
			run: runNode
		};
	}

	function geckoRuntime() {
		let services = typeof Services !== "undefined" ? Services
			: ChromeUtils.importESModule("resource://gre/modules/Services.sys.mjs").Services;
		let home = services.dirsvc.get("Home", Ci.nsIFile).path;
		let base = Zotero.isMac ? PathUtils.join(home, "Library", "Application Support")
			: Zotero.isWin ? services.dirsvc.get("AppData", Ci.nsIFile).path
				: services.env.get("XDG_DATA_HOME") || PathUtils.join(home, ".local", "share");
		return {
			join: (...parts) => PathUtils.join(...parts),
			uuid: () => String(services.uuid.generateUUID()).replace(/[{}]/g, ""),
			basename: value => PathUtils.filename(value),
			isAbsolute: value => PathUtils.isAbsolute(value),
			supportDir: PathUtils.join(base, "ZotPoP"),
			executableName: Zotero.isWin ? "pop8query.exe" : "pop8query",
			pref: key => Zotero.Prefs.get("extensions.zotpop." + key, true) || "",
			async exists(executable) {
				try {
					let stat = await IOUtils.stat(executable);
					if (stat.type !== "regular") throw new Error("PoP executable path is not a file: " + executable);
					return true;
				}
				catch (e) { if (e.name === "NotFoundError") return false; throw e; }
			},
			mkdir: dir => IOUtils.makeDirectory(dir, { createAncestors: true, permissions: 0o700 }),
			async readSnapshot(file) {
				let stat = await IOUtils.stat(file);
				if (stat.type !== "regular" || stat.size > SNAPSHOT_MAX_BYTES) throw new Error("Invalid snapshot size or type");
				return IOUtils.readUTF8(file);
			},
			async writeSnapshot(file, value) {
				await IOUtils.writeUTF8(file, value, { tmpPath: file + ".tmp" });
				await IOUtils.setPermissions(file, 0o600);
			},
			async listSnapshots(dir) { return Promise.all((await IOUtils.getChildren(dir)).map(async file => ({ file, modified: (await IOUtils.stat(file)).lastModified }))); },
			removeSnapshot: file => IOUtils.remove(file, { ignoreAbsent: true }),
			run: runGecko
		};
	}

	async function runGecko(executable, args, ctx) {
		const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
		let child = await Subprocess.call({ command: executable, arguments: args, stderr: "pipe" });
		let killPromise;
		let stop = () => killPromise || (killPromise = child.kill());
		let onAbort = () => { stop().catch(() => {}); };
		ctx.signal?.addEventListener("abort", onAbort, { once: true });
		if (ctx.signal?.aborted) onAbort();
		let read = async (pipe, stderr = false) => {
			let chunks = "";
			for (;;) {
				let chunk = await pipe.readString();
				if (!chunk) return chunks;
				chunks += chunk;
				if (stderr) { chunks = chunks.slice(-MAX_ERROR); reportProgress(chunks, ctx); }
				else if (chunks.length > MAX_OUTPUT) throw new Error("PoP output exceeds the supported size");
			}
		};
		let tasks = [read(child.stdout), read(child.stderr, true), child.wait()];
		try {
			let [stdout, stderr, { exitCode }] = await Promise.all([...tasks, child.stdin?.close()]);
			checkCancelled(ctx);
			return { stdout, stderr, exitCode };
		}
		catch (e) {
			await stop().catch(() => {});
			await Promise.allSettled(tasks);
			checkCancelled(ctx);
			throw e;
		}
		finally { ctx.signal?.removeEventListener("abort", onAbort); }
	}

	function runNode(executable, args, ctx) {
		const { spawn } = require("node:child_process");
		return new Promise((resolve, reject) => {
			let child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "", stderr = "", outputError, forceKill;
			let onAbort = () => {
				child.kill("SIGTERM");
				if (!forceKill) forceKill = setTimeout(() => child.kill("SIGKILL"), 300);
			};
			let cleanup = () => { clearTimeout(forceKill); ctx.signal?.removeEventListener("abort", onAbort); };
			ctx.signal?.addEventListener("abort", onAbort, { once: true });
			if (ctx.signal?.aborted) onAbort();
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", chunk => {
				if (outputError) return;
				stdout += chunk;
				if (stdout.length > MAX_OUTPUT) { outputError = new Error("PoP output exceeds the supported size"); onAbort(); }
			});
			child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-MAX_ERROR); reportProgress(stderr, ctx); });
			let onPipeError = e => { outputError = e; onAbort(); };
			child.stdout.on("error", onPipeError);
			child.stderr.on("error", onPipeError);
			child.on("error", e => { cleanup(); reject(ctx.signal?.aborted ? abortError() : e); });
			child.on("close", (exitCode, signal) => {
				cleanup();
				if (ctx.signal?.aborted || ctx.isCancelled?.()) reject(abortError());
				else if (outputError) reject(outputError);
				else resolve({ stdout, stderr, exitCode, signal });
			});
		});
	}

	function parseResults(stdout, cap) {
		let data;
		try { data = JSON.parse(stdout.replace(/^\uFEFF/, "")); }
		catch (_) { throw new Error("Publish or Perish returned invalid JSON"); }
		let rows = Array.isArray(data) ? data : data?.$results;
		if (!Array.isArray(rows) || rows.some(r => !r || Array.isArray(r) || typeof r !== "object" || typeof r.title !== "string" || !r.title.trim())) {
			throw new Error("Publish or Perish returned an invalid result list");
		}
		return rows.slice(0, cap);
	}

	function settings(ctx) {
		let runtime = isNode ? nodeRuntime() : geckoRuntime();
		let executable = text(ctx.popExecutable ?? runtime.pref("popExecutable"), "PoP executable")
			|| runtime.join(runtime.supportDir, "tools", runtime.executableName);
		let dataDir = text(ctx.popDataDir ?? runtime.pref("popDataDir"), "PoP data directory")
			|| runtime.join(runtime.supportDir, "PoPData");
		if (!runtime.isAbsolute(executable) || !runtime.isAbsolute(dataDir)) throw new Error("PoP executable and data directory must use absolute paths");
		return { runtime, executable, dataDir };
	}

	function sourceSettings(ctx) {
		let runtime = isNode ? nodeRuntime() : geckoRuntime();
		let executable = text(ctx.popExecutable ?? runtime.pref("popExecutable"), "PoP executable")
			|| runtime.join(runtime.supportDir, "tools", runtime.executableName);
		let dataDir = text(ctx.popDataDir ?? runtime.pref("popDataDir"), "PoP data directory") || null;
		if (!runtime.isAbsolute(executable) || dataDir && !runtime.isAbsolute(dataDir)) throw new Error("PoP executable and data directory must use absolute paths");
		return { runtime, executable, dataDir };
	}

	// The explicit native engine is a separate path: one invocation, no legacy
	// Scholar probing/recovery and no transformed or silently discarded rows.
	async function searchSource(sourceKey, query = {}, ctx = {}) {
		checkCancelled(ctx);
		let { runtime, executable, dataDir } = sourceSettings(ctx);
		let cachePolicy = ctx.popCachePolicy ?? "refresh";
		let args = buildSourceArguments(sourceKey, query, dataDir, cachePolicy);
		if (ctx.popCacheOnly) throw new Error("Native PoP cache requests must explicitly use the offline cache policy");
		if (!await runtime.exists(executable)) { checkCancelled(ctx); throw new Error("Publish or Perish executable is unavailable; configure its path to use the PoP engine"); }
		if (dataDir) await runtime.mkdir(dataDir);
		checkCancelled(ctx);
		let startedAt = new Date().toISOString(), invocationId = runtime.uuid();
		let label = `Publish or Perish (${sourceKey})`;
		let processCtx = { signal: ctx.signal, isCancelled: ctx.isCancelled, onProgress: ctx.onProgress, popProgressLabel: label, _popProgressCount: 0 };
		ctx.onProgress?.(label + ": searching…", 0, maxResults(query));
		let result = await runtime.run(executable, args, processCtx);
		checkCancelled(ctx);
		if (result.exitCode !== 0 && result.exitCode !== 4) {
			// stderr can contain service URLs or credentials. Expose only a fixed
			// actionable category, never copy the provider's response into logs.
			// Google now answers the Scholar profile-search URL with its sign-in
			// page for anyone not signed in; the tool then fails to parse a login
			// form as a results page. That is a login wall, not a CAPTCHA, and
			// the caller can fall back to the paper search, which is still open.
			let login = /accounts\.google\.com|\/signin\/|\bLogin\?/i.test(result.stderr);
			let detail = login ? "; Google requires a signed-in Google account for Scholar profile search. Sign in to Google Scholar inside Publish or Perish, then retry"
				: /captcha|unusual traffic|robot/i.test(result.stderr) ? "; verify access in Publish or Perish"
					: /unauthori[sz]ed|forbidden|api.?key|credential|subscription|authenticat/i.test(result.stderr) ? "; check this source's access settings in Publish or Perish"
						: /quota|budget|rate.?limit|too many requests/i.test(result.stderr) ? "; this source's request limit was reached" : "";
			throw Object.assign(new Error(`${label} search failed (${result.signal || result.exitCode})${detail}`), { exitCode: result.exitCode, source: sourceKey, reason: login ? "login" : undefined });
		}
		let rows = result.exitCode === 4 ? [] : parseSourceResults(result.stdout);
		checkCancelled(ctx);
		let effectiveQuery = { engine: "pop" };
		for (let key of [...Object.keys(SOURCE_FIELDS), "yearFrom", "yearTo", "popRaw"]) if (query[key] !== undefined) effectiveQuery[key] = query[key];
		effectiveQuery.maxResults = maxResults(query);
		effectiveQuery.popOutputSort = query.popOutputSort || "rank";
		let provenance = { engine: "publish-or-perish", source: sourceKey, outputSort: effectiveQuery.popOutputSort,
			profileId: dataDir || "pop-default", invocationId, acquisition: { kind: "process", invocationId }, startedAt, retrievedAt: new Date().toISOString(),
			capturedAt: cachePolicy === "offline" ? null : startedAt,
			query: effectiveQuery, exitCode: result.exitCode, complete: true, cached: cachePolicy === "offline", cancelled: false };
		ctx.onProgress?.(`${label}: ${rows.length} results`, rows.length, maxResults(query));
		checkCancelled(ctx);
		return { rows, provenance };
	}

	function queryKey(query) {
		buildArguments(query, "/snapshot-validation");
		let stable = value => {
			if (value === null || ["string", "boolean"].includes(typeof value)) return value;
			if (typeof value === "number" && Number.isFinite(value)) return value;
			if (Array.isArray(value)) return value.map(stable);
			if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
			throw new Error("Invalid snapshot query criteria");
		};
		let fields = Object.fromEntries(Object.entries(query).filter(([key, value]) => !["maxResults", "sort"].includes(key) && value !== undefined));
		for (let key of ["keywords", "title", "authors", "venue"]) fields[key] = text(query[key], key);
		for (let key of ["yearFrom", "yearTo"]) fields[key] = query[key] == null || query[key] === "" ? null : Number(query[key]);
		let key = JSON.stringify(stable(fields));
		if (key.length > 16000) throw new Error("Snapshot query is too large");
		return key;
	}

	function snapshotLocation(query, runtime, dataDir) {
		let key = queryKey(query), hash = 2166136261;
		for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
		let dir = runtime.join(dataDir, "zotpop-snapshots");
		return { key, dir, file: runtime.join(dir, `query-${(hash >>> 0).toString(16).padStart(8, "0")}-${key.length}.json`) };
	}

	function validateSnapshot(value, key) {
		let age = Date.now() - Date.parse(value?.capturedAt);
		if (value?.schema !== 1 || value?.source !== "google-scholar-via-pop" || value.queryKey !== key
			|| queryKey(value.criteria) !== key || !Number.isFinite(age) || age < 0 || age > SNAPSHOT_MAX_AGE
			|| typeof value.complete !== "boolean" || !Array.isArray(value.rows) || value.rows.length > 2000) throw new Error("Invalid or expired PoP snapshot");
		parseResults(JSON.stringify(value.rows), 2000);
		return value;
	}

	async function readSnapshot(query, runtime, dataDir, ctx) {
		checkCancelled(ctx);
		let location = snapshotLocation(query, runtime, dataDir);
		try {
			let raw = await runtime.readSnapshot(location.file);
			checkCancelled(ctx);
			if (new TextEncoder().encode(raw).byteLength > SNAPSHOT_MAX_BYTES) return null;
			return validateSnapshot(JSON.parse(raw), location.key);
		}
		catch (e) { checkCancelled(ctx); return null; }
	}

	async function storeSnapshot(query, rows, ctx = {}, options = {}) {
		checkCancelled(ctx);
		let { runtime, dataDir } = settings(ctx), location = snapshotLocation(query, runtime, dataDir);
		let capturedAt = new Date(options.capturedAt ?? Date.now()).toISOString();
		let cleanRows = parseResults(JSON.stringify(rows), 2001);
		let value = validateSnapshot({ schema: 1, source: "google-scholar-via-pop", queryKey: location.key,
			criteria: JSON.parse(location.key), capturedAt, complete: options.complete === true, rows: cleanRows }, location.key);
		let encoded = JSON.stringify(value);
		if (new TextEncoder().encode(encoded).byteLength > SNAPSHOT_MAX_BYTES) throw new Error("PoP snapshot exceeds the supported size");
		let queued = (snapshotWrites.get(location.file) || Promise.resolve()).catch(() => {}).then(async () => {
			checkCancelled(ctx);
			let previous = await readSnapshot(query, runtime, dataDir, ctx);
			// A small preliminary probe must not destroy broader, recently received data.
			if (previous && (Date.parse(previous.capturedAt) > Date.parse(capturedAt)
				|| (previous.rows.length > cleanRows.length && !value.complete))) return previous;
			await runtime.mkdir(location.dir);
			checkCancelled(ctx);
			await runtime.writeSnapshot(location.file, encoded);
			let files = (await runtime.listSnapshots(location.dir)).filter(entry => /^query-[0-9a-f]{8}-\d+\.json$/.test(runtime.basename(entry.file)))
				.sort((a, b) => Number(b.file === location.file) - Number(a.file === location.file) || b.modified - a.modified);
			for (let entry of files.slice(SNAPSHOT_MAX_FILES)) await runtime.removeSnapshot(entry.file);
			checkCancelled(ctx);
			return value;
		});
		snapshotWrites.set(location.file, queued);
		try { return await queued; }
		finally { if (snapshotWrites.get(location.file) === queued) snapshotWrites.delete(location.file); }
	}

	async function remember(query, rows, ctx, options) {
		try { await storeSnapshot(query, rows, ctx, options); }
		catch (e) { checkCancelled(ctx); ctx.log?.("PoP snapshot could not be saved (" + e.name + ")"); }
	}

	function recovered(rows, capturedAt, ctx, origin) {
		checkCancelled(ctx);
		rows.partial = true;
		rows.cached = true;
		rows.capturedAt = capturedAt;
		rows.cacheSource = origin;
		let warning = `${LABEL}: search incomplete; showing ${rows.length} cached results captured ${capturedAt} (${origin}).`;
		if (!ctx.errors) ctx.errors = [];
		ctx.errors.push(warning);
		ctx.onProgress?.(warning, rows.length, ctx.recoveryMaxResults || rows.length);
		return rows;
	}

	function recoveryLimit(query, ctx) {
		return maxResults({ maxResults: ctx.recoveryMaxResults ?? maxResults(query) });
	}

	async function recover(query, ctx, settingsValue, processCtx, result) {
		let { runtime, executable, dataDir } = settingsValue;
		let cap = recoveryLimit(query, ctx), offline;
		checkCancelled(ctx);
		if (result && result.exitCode !== 0 && result.exitCode !== 4 && processCtx._popProgressCount > 0) {
			let count = Math.min(cap, processCtx._popProgressCount, 2000);
			let args = buildArguments({ ...query, maxResults: count }, dataDir);
			args.splice(args.lastIndexOf("--direct"), 1);
			args.push("--offline");
			try {
				let cached = await runtime.run(executable, args, { ...ctx, _popProgressCount: 0 });
				checkCancelled(ctx);
				if (cached.exitCode === 0) {
					let rows = parseResults(cached.stdout, count);
					if (rows.length) offline = { rows, capturedAt: new Date().toISOString() };
				}
			}
			catch (e) { checkCancelled(ctx); }
		}
		let snapshot = await readSnapshot(query, runtime, dataDir, ctx);
		if (offline) await remember(query, offline.rows, ctx, { capturedAt: offline.capturedAt, complete: false });
		if (snapshot?.rows.length && (!offline || snapshot.rows.length > offline.rows.length)) {
			return recovered(snapshot.rows.slice(0, cap), snapshot.capturedAt, ctx, "ZotPoP snapshot");
		}
		if (offline) return recovered(offline.rows.slice(0, cap), offline.capturedAt, ctx, "PoP offline cache");
		return null;
	}

	async function search(query, ctx = {}) {
		checkCancelled(ctx);
		let config = settings(ctx), { runtime, executable, dataDir } = config;
		if (ctx.popCacheOnly) {
			let cached = await readSnapshot(query, runtime, dataDir, ctx);
			if (cached?.rows.length) return recovered(cached.rows.slice(0, recoveryLimit(query, ctx)), cached.capturedAt, ctx, "ZotPoP snapshot");
			throw new Error("No matching PoP snapshot from the last 24 hours is available");
		}
		if (!await runtime.exists(executable)) { checkCancelled(ctx); return null; }
		let args = buildArguments(query, dataDir);
		await runtime.mkdir(dataDir);
		checkCancelled(ctx);
		ctx.onProgress?.(LABEL + ": searching…", 0, maxResults(query));
		let result, processCtx = { ...ctx, _popProgressCount: 0 };
		try { result = await runtime.run(executable, args, processCtx); }
		catch (e) {
			checkCancelled(ctx);
			let cached = await recover(query, ctx, config, processCtx);
			if (cached) return cached;
			throw e;
		}
		checkCancelled(ctx);
		// PoP documents exit 4 as a completed query with no matching data.
		if (result.exitCode !== 0 && result.exitCode !== 4) {
			let cached = await recover(query, ctx, config, processCtx, result);
			if (cached) return cached;
			let detail = result.stderr.trim().slice(-2000);
			throw new Error(`Publish or Perish search failed (${result.signal || result.exitCode})${detail ? ": " + detail : ""}`);
		}
		let rows;
		try { rows = result.exitCode === 4 ? [] : parseResults(result.stdout, maxResults(query)); }
		catch (e) {
			let cached = await recover(query, ctx, config, processCtx);
			if (cached) return cached;
			throw e;
		}
		await remember(query, rows, ctx, { complete: rows.length < maxResults(query) });
		checkCancelled(ctx);
		ctx.onProgress?.(`${LABEL}: ${rows.length} results`, rows.length, maxResults(query));
		return rows;
	}

	return { search, buildArguments, parseResults, storeSnapshot, SOURCE_FLAGS, searchSource, buildSourceArguments, parseSourceResults };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPPoPBridge;

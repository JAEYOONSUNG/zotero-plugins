/*
 * Recent searches, kept with their results.
 *
 * Every search spends metered OpenAlex requests, and the same query typed again
 * tomorrow used to spend them again for an answer that had not changed. Each finished
 * search is therefore written to disk -- the query, the source, and every record --
 * and can be brought back without touching the network. The same query run again
 * replaces its earlier entry; the list is capped so it never grows without bound.
 *
 * Storage is injected (IOUtils in Zotero, memory in tests): { readText, writeText,
 * remove, exists, makeDir } and a `join` for paths. Environment-agnostic.
 */
var ZotPoPHistory = (function () {
	"use strict";

	const INDEX = "index.json";
	const QUERY_FIELDS = ["authors", "venue", "title", "keywords", "yearFrom", "yearTo", "sort", "maxResults", "sources", "engine", "affiliation", "issn", "citedId", "field", "popRaw", "popOutputSort", "popProfile", "popCachePolicy"];

	// A stable id for a query: FNV-1a over its normalised fields, so the same search
	// lands on the same file however the boxes were spaced or capitalised.
	function fnv(text) {
		let h = 0x811c9dc5;
		for (let i = 0; i < text.length; i++) {
			h ^= text.charCodeAt(i);
			h = Math.imul(h, 0x01000193) >>> 0;
		}
		return h.toString(16).padStart(8, "0");
	}
	function normalizeQuery(query = {}) {
		if (query.mode === "author") {
			let out = { mode: "author" };
			for (let key of ["authorProvider", "authorInput", "authorInputKind", "authorAction", "authorProfileId", "popProfile"]) if (query[key] != null && query[key] !== "") out[key] = String(query[key]);
			if (query.maxResults != null) out.maxResults = Number(query.maxResults);
			return out;
		}
		let out = {};
		for (let key of QUERY_FIELDS) {
			let value = query[key];
			if (value == null || value === "") continue;
			if (key === "engine" && value === "direct") continue;
			if (query.engine === "pop") {
				if (key === "sources" || key === "sort") continue;
				out[key] = ["yearFrom", "yearTo", "maxResults"].includes(key) ? Number(value) : String(value);
				continue;
			}
			if (key === "sources") {
				if (!Array.isArray(value)) continue;
				let names = [...new Set(value.map(name => String(name).trim().toLowerCase()))].sort();
				// Preserve the keys of searches saved before source selection existed.
				if (names.join(",") !== "arxiv,crossref,europepmc,openalex") out[key] = names;
				continue;
			}
			if (["yearFrom", "yearTo", "maxResults"].includes(key)) { out[key] = Number(value); continue; }
			let text = String(value).replace(/\s+/g, " ").trim();
			// Uppercase Boolean operators are syntax in title/keyword queries;
			// the lowercase words and quoted literals must never reuse that cache.
			out[key] = ["title", "keywords", "venue"].includes(key)
				? (text.match(/"(?:\\.|[^"\\])*"|[^"]+/g) || []).map(part => part.startsWith('"') ? part.toLowerCase()
					: part.split(/(\b(?:AND|OR|NOT|ANDNOT)\b)/).map(token => /^(AND|OR|NOT|ANDNOT)$/.test(token) ? token : token.toLowerCase()).join("")).join("")
				: text.toLowerCase();
		}
		return out;
	}
	function signature(source, query) {
		let text = JSON.stringify([String(source || ""), normalizeQuery(query)]);
		return fnv(text) + fnv(text.split("").reverse().join(""));
	}

	// What the menu shows for a search: the boxes that were filled, in reading order.
	function describe(query = {}) {
		if (query.mode === "author") return [query.authorProvider === "orcid" ? "ORCID" : "Google Scholar", query.authorInput || query.authorProfileId].filter(Boolean).join(" · ");
		let bits = [];
		if (query.engine === "pop") bits.push("PoP");
		if (query.popRaw) bits.push(String(query.popRaw));
		if (query.keywords) bits.push(String(query.keywords).trim());
		if (query.title) bits.push("title: " + String(query.title).trim());
		if (query.authors) bits.push(String(query.authors).trim());
		if (query.venue) bits.push(String(query.venue).trim());
		if (query.yearFrom || query.yearTo) bits.push([query.yearFrom || "", query.yearTo || ""].join("–"));
		// Two combined searches over different sources are different searches, and the
		// menu showed both as the same words.
		if (Array.isArray(query.sources) && query.sources.length) bits.push(query.sources.join("+"));
		return bits.join(" · ");
	}

	function create({ io, dir, join, max = 30, maxBytes = 12 * 1024 * 1024, now = () => new Date() } = {}) {
		if (!io) throw new TypeError("History storage requires an io adapter");
		let path = name => (join || ((a, b) => a.replace(/\/+$/, "") + "/" + b))(dir || "", name);
		let ready = null;
		let index = null;
		let writes = Promise.resolve();

		async function load() {
			if (index) return index;
			if (!ready) {
				ready = (async () => {
					try { await io.makeDir?.(dir); } catch (_) { /* may already exist */ }
					try {
						let parsed = JSON.parse(await io.readText(path(INDEX)));
						index = Array.isArray(parsed?.entries) ? parsed.entries.filter(e => e && typeof e.id === "string") : [];
					}
					catch (_) { index = []; }
					return index;
				})();
			}
			return ready;
		}

		async function writeIndex() {
			await io.writeText(path(INDEX), JSON.stringify({ version: 1, entries: index }));
		}

		function serial(task) {
			let run = writes.then(task, task);
			writes = run.catch(() => {});
			return run;
		}

		// Reads wait for writes in flight, so a search saved a moment ago is already listed.
		async function list() {
			await writes;
			let entries = await load();
			return entries.slice().sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
		}

		async function save({ source, query, records, partial = false, label = "" }) {
			let profiles = query?.mode === "author" && ["scholar", "orcid"].includes(query.authorProvider) && Array.isArray(query.authorProfiles)
				? query.authorProfiles.filter(profile => profile && profile.provider === query.authorProvider && typeof profile.id === "string" && profile.id.trim()) : [];
			if (!source || !Array.isArray(records) || !records.length && !profiles.length) return null;
			let id = signature(source, query);
			let savedAt = now().toISOString();
			let body = JSON.stringify({ version: 1, id, source, query, savedAt, partial, records });
			if (body.length > maxBytes) return null;
			return serial(async () => {
				await load();
				await io.writeText(path(id + ".json"), body);
				index = index.filter(e => e.id !== id);
				let profileOnly = query?.mode === "author" && query.authorAction === "profiles";
				index.push({ id, source, label: label || describe(query), query, count: profileOnly ? profiles.length : records.length,
					...(profileOnly ? { kind: "profiles" } : {}), savedAt, partial });
				index.sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)));
				let dropped = index.splice(0, Math.max(0, index.length - max));
				for (let e of dropped) await io.remove(path(e.id + ".json")).catch(() => {});
				await writeIndex();
				return id;
			});
		}

		async function find(source, query) {
			let id = signature(source, query);
			await writes;
			let normalized = JSON.stringify(normalizeQuery(query));
			return (await load()).find(e => e.id === id && e.source === source
				&& JSON.stringify(normalizeQuery(e.query)) === normalized) || null;
		}

		async function get(id) {
			if (!/^[0-9a-f]{16}$/.test(String(id))) return null;
			try {
				let parsed = JSON.parse(await io.readText(path(id + ".json")));
				if (parsed?.version !== 1 || !Array.isArray(parsed.records)) return null;
				return parsed;
			}
			catch (_) {
				// The index can outlive its file; drop the dangling line rather than
				// keep offering a search that cannot be opened.
				await serial(async () => { await load(); index = index.filter(e => e.id !== id); await writeIndex(); }).catch(() => {});
				return null;
			}
		}

		async function remove(id) {
			return serial(async () => {
				await load();
				index = index.filter(e => e.id !== id);
				await io.remove(path(id + ".json")).catch(() => {});
				await writeIndex();
			});
		}

		async function clear() {
			return serial(async () => {
				await load();
				for (let e of index) await io.remove(path(e.id + ".json")).catch(() => {});
				index = [];
				await writeIndex();
			});
		}

		return { list, save, find, get, remove, clear, signature, describe };
	}

	// A storage that forgets everything when the window closes: the fallback when the
	// platform offers no file access, and what the tests run against.
	function memoryIO(files = new Map()) {
		return {
			files,
			async readText(p) { if (!files.has(p)) throw new Error("ENOENT " + p); return files.get(p); },
			async writeText(p, text) { files.set(p, text); },
			async remove(p) { files.delete(p); },
			async exists(p) { return files.has(p); },
			async makeDir() {}
		};
	}

	return { create, memoryIO, signature, describe, normalizeQuery };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPHistory;

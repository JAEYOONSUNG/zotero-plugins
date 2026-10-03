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
		// Journals picked from the list read as their names, not as the OR expression the search was run with.
		if (Array.isArray(query.venues) && query.venues.length) bits.push(query.venues.map(v => String((v && v.name) || v).trim()).filter(Boolean).join(", "));
		else if (query.venue) bits.push(String(query.venue).trim());
		if (query.yearFrom || query.yearTo) bits.push([query.yearFrom || "", query.yearTo || ""].join("–"));
		// Two combined searches over different sources are different searches, and the
		// menu showed both as the same words.
		if (Array.isArray(query.sources) && query.sources.length) bits.push(query.sources.join("+"));
		return bits.join(" · ");
	}

	// What identifies a result across two runs of one search: its DOI, else the source's own key.
	// Only these short strings are kept per entry, never the records a second time.
	const KEY_CAP = 1000;
	function recordKey(record = {}) {
		let doi = String(record.doi || "").trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
		return doi ? "d:" + doi : record.key ? "k:" + record.key : "";
	}
	function keysOf(records, cap = KEY_CAP) {
		return [...new Set(records.map(recordKey).filter(Boolean))].slice(0, cap);
	}
	// A pinned search remembers what it has shown, so it keeps far more than an ordinary entry.
	// Past this many results the comparison is not trustworthy and nothing is marked.
	const SEEN_CAP = 3000;

	function create({ io, dir, join, max = 30, maxBytes = 12 * 1024 * 1024, now = () => new Date() } = {}) {
		if (!io) throw new TypeError("History storage requires an io adapter");
		let path = name => (join || ((a, b) => a.replace(/\/+$/, "") + "/" + b))(dir || "", name);
		let ready = null;
		let index = null;
		let writes = Promise.resolve();
		let pinList = null;
		const PINS = "pins.json";
		async function loadPins() {
			if (pinList) return pinList;
			try {
				let parsed = JSON.parse(await io.readText(path(PINS)));
				pinList = Array.isArray(parsed?.pins) ? parsed.pins.filter(p => p && typeof p.id === "string" && p.query && Array.isArray(p.seen)) : [];
			}
			catch (_) { pinList = []; }
			return pinList;
		}
		async function writePins() { await io.writeText(path(PINS), JSON.stringify({ version: 1, pins: pinList })); }
		let newAmong = (records, seen) => {
			if (records.length > SEEN_CAP) return null;
			let known = new Set(seen);
			return keysOf(records, SEEN_CAP).filter(k => !known.has(k)).length;
		};

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
			let keys = keysOf(records);
			let body = JSON.stringify({ version: 1, id, source, query, savedAt, partial, keys, records });
			if (body.length > maxBytes) return null;
			return serial(async () => {
				await load();
				await loadPins();
				await io.writeText(path(id + ".json"), body);
				index = index.filter(e => e.id !== id);
				let profileOnly = query?.mode === "author" && query.authorAction === "profiles";
				index.push({ id, source, label: label || describe(query), query, count: profileOnly ? profiles.length : records.length,
					...(profileOnly ? { kind: "profiles" } : {}), savedAt, partial });
				index.sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)));
				// A pinned search is kept whatever its age; the oldest others make room.
				let over = Math.max(0, index.length - max), pinned = new Set(pinList.map(p => p.id)), dropped = [];
				for (let e of index) { if (over <= 0) break; if (!pinned.has(e.id)) { dropped.push(e); over--; } }
				index = index.filter(e => !dropped.includes(e));
				for (let e of dropped) await io.remove(path(e.id + ".json")).catch(() => {});
				await writeIndex();
				// What this run turned up that the pin has not shown yet, for the menu to say.
				let pin = pinList.find(p => p.id === id);
				if (pin) { pin.newCount = newAmong(records, pin.seen); pin.lastRun = savedAt; pin.partial = Boolean(partial); await writePins(); }
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

		// The keys of the last run of this exact search, to tell what is new this time.
		// Nothing when it was never run, or when more results were kept than the cap holds.
		async function previousKeys(source, query) {
			let saved = await find(source, query);
			let entry = saved && await get(saved.id);
			if (!entry) return null;
			let keys = Array.isArray(entry.keys) ? entry.keys : keysOf(entry.records);
			return keys.length && keys.length < KEY_CAP ? new Set(keys) : null;
		}

		// ---- pinned searches: a search kept with its conditions, sources, filters and the results already seen
		async function pins() {
			await writes;
			return (await loadPins()).slice().sort((a, b) => String(a.pinnedAt).localeCompare(String(b.pinnedAt)));
		}
		async function pinFor(source, query) {
			await writes;
			let id = signature(source, query);
			return (await loadPins()).find(p => p.id === id && p.source === source) || null;
		}
		async function pin(id, { filters = null, label = "" } = {}) {
			let entry = await get(id);
			if (!entry || entry.query?.mode === "author") return null;
			return serial(async () => {
				await loadPins();
				let existing = pinList.find(p => p.id === id);
				if (existing) return existing;
				let stamp = now().toISOString();
				let record = { id, source: entry.source, query: entry.query, label: label || describe(entry.query), pinnedAt: stamp,
					seen: keysOf(entry.records, SEEN_CAP), seenAt: stamp, lastRun: entry.savedAt, partial: Boolean(entry.partial), newCount: 0, ...(filters ? { filters } : {}) };
				pinList.push(record);
				await writePins();
				return record;
			});
		}
		async function unpin(id) {
			return serial(async () => { await loadPins(); pinList = pinList.filter(p => p.id !== id); await writePins(); });
		}
		// What a run is compared against: the keys already shown, or null when there are none.
		async function baseline(id) {
			await writes;
			let found = (await loadPins()).find(p => p.id === id);
			return found && found.seen.length ? new Set(found.seen) : null;
		}
		// The results were looked at: their keys join the seen set. They never replace it, so a short,
		// partial or failed run cannot reset what was seen; an empty run, or one too large to compare, changes nothing.
		async function markSeen(id, records) {
			if (!Array.isArray(records) || !records.length || records.length > SEEN_CAP) return null;
			return serial(async () => {
				await loadPins();
				let found = pinList.find(p => p.id === id);
				if (!found) return null;
				let before = new Set(found.seen), fresh = keysOf(records, SEEN_CAP).filter(k => !before.has(k));
				found.seen = found.seen.concat(fresh).slice(0, SEEN_CAP);
				found.seenAt = now().toISOString();
				found.newCount = 0;
				await writePins();
				return { added: fresh.length };
			});
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
				await loadPins();
				let pinned = new Set(pinList.map(p => p.id));
				for (let e of index) if (!pinned.has(e.id)) await io.remove(path(e.id + ".json")).catch(() => {});
				index = index.filter(e => pinned.has(e.id));
				await writeIndex();
			});
		}

		return { list, save, find, get, previousKeys, remove, clear, signature, describe, pins, pin, unpin, pinFor, baseline, markSeen, SEEN_CAP };
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

	return { create, memoryIO, signature, describe, normalizeQuery, recordKey };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPHistory;

/*
 * Citations over time: the trend of one paper from OpenAlex's counts_by_year, the total over a result set,
 * and a small bounded memory of the last count seen per paper, so the card can say how many citations
 * arrived since the previous look. Pure and environment-agnostic (Zotero window and Node).
 *
 * Years are [{ year, n }]. A count that OpenAlex leaves out (zero years) is zero from the paper's
 * publication year on, and unknown before it.
 */
var ZotPoPCite = (function () {
	"use strict";

	const WINDOW = 10;
	const VISIT_GAP = 6 * 3600 * 1000;

	function yearMap(list, upTo) {
		let map = new Map();
		for (let e of Array.isArray(list) ? list : []) {
			let year = Number(e && e.year), n = Number(e && e.n);
			if (Number.isInteger(year) && Number.isFinite(n) && n >= 0 && year <= upTo) map.set(year, n);
		}
		return map;
	}

	/* The shape of one paper's citations: the last ten calendar years (the current one partial), the last
	   two full years against each other, the peak, the yearly average. Null when there is no yearly data.
	   input: { byYear, year (publication year), citations (total) }. */
	function trend(input, now = new Date()) {
		let cy = now.getFullYear();
		let map = yearMap(input && input.byYear, cy);
		if (!map.size) return null;
		let pub = Number.isInteger(input.year) ? input.year : null;
		let first = Math.min(...map.keys());
		let start = Math.max(cy - WINDOW + 1, pub != null ? Math.min(pub, first) : first);
		start = Math.min(start, cy);
		let years = [];
		for (let y = start; y <= cy; y++) years.push({ year: y, n: map.get(y) ?? 0, partial: y === cy });
		let at = y => { let found = years.find(e => e.year === y); return found ? found.n : null; };
		let last = at(cy - 1), prev = at(cy - 2);
		let yoy = last != null && prev != null && prev > 0 ? Math.round((last - prev) / prev * 100) : null;
		let direction = last != null && prev != null ? (last > prev ? "up" : last < prev ? "down" : "flat") : null;
		let peak = null;
		for (let e of years) if (e.n > 0 && (!peak || e.n > peak.n)) peak = { year: e.year, n: e.n, partial: e.partial };
		let total = Number.isFinite(Number(input.citations)) ? Number(input.citations) : null;
		return {
			years, max: Math.max(1, ...years.map(e => e.n)),
			current: { year: cy, n: at(cy) ?? 0 },
			last: last == null ? null : { year: cy - 1, n: last },
			prev: prev == null ? null : { year: cy - 2, n: prev },
			yoy, direction, peak,
			recent: years.reduce((a, e) => a + e.n, 0),
			perYear: total != null && pub != null ? total / Math.max(1, cy - pub) : null
		};
	}

	/* The whole result set's citations per year: each paper's yearly counts added up, over the papers that
	   have them. { years, papers, of } or null when none does. */
	function sumByYear(records, now = new Date()) {
		let cy = now.getFullYear(), sum = new Map(), papers = 0;
		for (let r of records || []) {
			let map = yearMap(r && r.citesByYear, cy);
			if (!map.size) continue;
			papers++;
			for (let [y, n] of map) if (y > cy - WINDOW) sum.set(y, (sum.get(y) || 0) + n);
		}
		if (!papers) return null;
		let years = [];
		for (let y = cy - WINDOW + 1; y <= cy; y++) years.push({ year: y, n: sum.get(y) || 0, partial: y === cy });
		let at = y => years.find(e => e.year === y).n;
		let yoy = at(cy - 2) > 0 ? Math.round((at(cy - 1) - at(cy - 2)) / at(cy - 2) * 100) : null;
		return { years, max: Math.max(1, ...years.map(e => e.n)), papers, of: (records || []).length, yoy };
	}

	/* Last count seen per paper: { c, at } now, { p, pAt } at the look before. A look within six hours of the
	   last one only refreshes the count, so searching twice in a day does not wipe the comparison. Bounded:
	   the longest-unseen papers go first. Persisted through the injected io (readText/writeText). */
	function createSnapshots({ io, path, max = 3000, gap = VISIT_GAP, now = () => Date.now() } = {}) {
		let map = new Map(), ready = null, dirty = false, writing = Promise.resolve();
		const valid = n => Number.isFinite(n) && n >= 0;
		async function load() {
			if (!ready) ready = (async () => {
				try {
					let parsed = JSON.parse(await io.readText(path));
					for (let e of Array.isArray(parsed && parsed.entries) ? parsed.entries : []) {
						if (!Array.isArray(e) || typeof e[0] !== "string" || !valid(e[1]) || !valid(e[2])) continue;
						map.set(e[0], { c: e[1], at: e[2], p: valid(e[3]) ? e[3] : null, pAt: valid(e[4]) ? e[4] : null });
					}
				}
				catch (_) { /* first run, or a damaged file: the comparison starts again */ }
				trim();
			})();
			return ready;
		}
		function trim() {
			if (map.size <= max) return;
			let order = [...map].sort((a, b) => a[1].at - b[1].at);
			for (let [key] of order.slice(0, map.size - max)) map.delete(key);
		}
		function observe(key, count, at = now()) {
			if (!key || !valid(count)) return null;
			let old = map.get(key), entry;
			if (!old) entry = { c: count, at, p: null, pAt: null };
			else if (at - old.at >= gap) entry = { c: count, at, p: old.c, pAt: old.at };
			else entry = Object.assign({}, old, { c: count });
			map.set(key, entry);
			dirty = true;
			trim();
			return entry;
		}
		/* What changed since the look before: null when there was none. */
		function delta(key) {
			let e = map.get(key);
			return e && e.p != null ? { change: e.c - e.p, from: e.pAt, to: e.at, count: e.c, before: e.p } : null;
		}
		async function flush() {
			await load();
			if (!dirty || !io) return;
			dirty = false;
			let body = JSON.stringify({ version: 1, entries: [...map].map(([k, e]) => [k, e.c, e.at, e.p, e.pAt]) });
			writing = writing.then(() => io.writeText(path, body)).catch(() => { dirty = true; });
			await writing;
		}
		return { load, observe, delta, flush, get: key => map.get(key) || null, get size() { return map.size; }, keys: () => [...map.keys()] };
	}

	return { trend, sumByYear, createSnapshots, WINDOW, VISIT_GAP };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPCite;

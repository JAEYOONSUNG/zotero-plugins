/*
 * Publish or Perish-style citation metrics.
 * Works in Zotero window and Node.
 */
var ZotPoPMetrics = (function () {
	"use strict";

	function hIndex(values) {
		let v = values.slice().sort((a, b) => b - a);
		let h = 0;
		for (let i = 0; i < v.length; i++) {
			if (v[i] >= i + 1) h = i + 1; else break;
		}
		return h;
	}

	function gIndex(values) {
		let v = values.slice().sort((a, b) => b - a);
		let sum = 0, g = 0;
		for (let i = 0; i < v.length; i++) {
			sum += v[i];
			if (sum >= (i + 1) * (i + 1)) g = i + 1; else break;
		}
		return g;
	}

	// Age of a paper in years, minimum 1 (as in PoP)
	function paperAge(year, now = new Date().getFullYear()) {
		if (!year) return null;
		return Math.max(1, now - year);
	}

	function citesPerYear(rec, now = new Date().getFullYear()) {
		let age = paperAge(rec.year, now);
		if (age == null || rec.citations == null) return null;
		return rec.citations / age;
	}

	function compute(records, now = new Date().getFullYear()) {
		let n = records.length;
		let cites = records.map(r => r.citations || 0);
		let citations = cites.reduce((a, b) => a + b, 0);
		let years = records.map(r => r.year).filter(y => Number.isFinite(y));
		let minYear = years.length ? Math.min(...years) : null;
		let maxYear = years.length ? Math.max(...years) : null;
		let citationYears = minYear ? Math.max(1, now - minYear) : 1;
		let nAuthors = records.map(r => Math.max(1, (r.authors || []).length));
		let normCites = records.map((r, i) => (r.citations || 0) / nAuthors[i]);
		let annual = records.map(r => citesPerYear(r, now) || 0);

		let hi = hIndex(cites);
		let hiNorm = hIndex(normCites);
		return {
			papers: n,
			citations,
			minYear, maxYear,
			citationYears,
			citesPerYear: n ? citations / citationYears : 0,
			citesPerPaper: n ? citations / n : 0,
			citesPerAuthor: normCites.reduce((a, b) => a + b, 0),
			papersPerAuthor: nAuthors.reduce((a, b) => a + 1 / b, 0),
			authorsPerPaper: n ? nAuthors.reduce((a, b) => a + b, 0) / n : 0,
			hIndex: hi,
			gIndex: gIndex(cites),
			hiNorm,
			hiAnnual: hiNorm / citationYears,
			hA: hIndex(annual)
		};
	}

	return { compute, hIndex, gIndex, citesPerYear, paperAge };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPMetrics;

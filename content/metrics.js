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
		year = Number(year);
		if (!Number.isInteger(year) || year <= 0) return null;
		return Math.max(1, now - year);
	}

	function citesPerYear(rec, now = new Date().getFullYear()) {
		let age = paperAge(rec.year, now);
		if (age == null || rec.citations == null) return null;
		return rec.citations / age;
	}

	/* With a provider named, every figure is that index's alone: its count
	   where it has one, unknown where it has none. Without one, the per-paper
	   headline count (the highest any index gave) is used, as before. */
	function compute(records, now = new Date().getFullYear(), { provider } = {}) {
		if (provider) records = records.map(r => {
			let own = r.citationsBy?.[provider] ?? ((r.citationSource || r.source) === provider ? r.citations : null);
			return Object.assign({}, r, { citations: own ?? null, citationSource: provider, citationsBy: undefined });
		});
		let n = records.length;
		/* A record whose count never arrived (no DOI, a spent OpenAlex budget)
		   is unknown, not zero. Counted as zero it pulled citations per paper
		   down by every such paper; the per-paper figures now divide by the
		   papers whose counts are known, and say how many were left out. */
		let known = records.filter(r => r.citations != null && Number.isFinite(Number(r.citations)));
		let unknownCitations = n - known.length;
		let cites = records.map(r => Number(r.citations) || 0);
		let citations = cites.reduce((a, b) => a + b, 0);
		let years = records.map(r => Number(r.year)).filter(y => Number.isInteger(y) && y > 0);
		let minYear = years.length ? Math.min(...years) : null;
		let maxYear = years.length ? Math.max(...years) : null;
		let citationYears = minYear ? Math.max(1, now - minYear) : 1;
		/* Per-author figures need a whole author list. OpenAlex cuts a list at 100, and ORCID works, Scholar rows
		   and some records carry no list at all: counted as one author each they would credit a paper's whole
		   citation count to a single person. Such papers are left out of every per-author figure, and the
		   result says how many papers the figures were computed on. */
		let listKnown = r => Array.isArray(r.authors) && r.authors.length > 0 && r.authorListComplete !== false;
		let whole = records.filter(r => !r.authorsTruncated && listKnown(r));
		let authorsTruncated = records.filter(r => r.authorsTruncated).length;
		let authorsUnknown = n - whole.length - authorsTruncated;
		let nAuthors = whole.map(r => r.authors.length);
		let normCites = whole.map((r, i) => (r.citations || 0) / nAuthors[i]);
		// ...and at least one of them with a citation count somebody gave: an unknown count is not a 0 to normalise.
		let computable = whole.some(r => r.citations != null && Number.isFinite(Number(r.citations)));
		let annual = records.map(r => citesPerYear(r, now) || 0);

		let hi = hIndex(cites);
		let hiNorm = hIndex(normCites);
		return {
			papers: n,
			citations,
			minYear, maxYear,
			citationYears,
			citesPerYear: n ? citations / citationYears : 0,
			citesPerPaper: known.length ? citations / known.length : 0,
			unknownCitations,
			// Counts from more than one citation index are not one network: the h-index over them is a reference figure.
			citationSources: [...new Set(known.flatMap(r => Object.keys(r.citationsBy || {}).length ? Object.keys(r.citationsBy) : [r.citationSource || r.source]).filter(Boolean))],
			citesPerAuthor: computable ? normCites.reduce((a, b) => a + b, 0) : null,
			papersPerAuthor: computable ? nAuthors.reduce((a, b) => a + 1 / b, 0) : null,
			authorsPerPaper: computable ? nAuthors.reduce((a, b) => a + b, 0) / whole.length : null,
			// How many papers the per-author figures rest on, and how many were left out (cut off, or no list).
			perAuthorPapers: whole.length,
			authorsTruncated,
			authorsUnknown,
			hIndex: hi,
			gIndex: gIndex(cites),
			hiNorm: computable ? hiNorm : null,
			hiAnnual: minYear && computable ? hiNorm / citationYears : null,
			hA: hIndex(annual)
		};
	}

	return { compute, hIndex, gIndex, citesPerYear, paperAge };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPMetrics;

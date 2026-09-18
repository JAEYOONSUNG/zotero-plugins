/*
 * Where a paper came from, and who answers for it.
 *
 * A search hit names its authors and nothing else. Which lab did the work, in which
 * country, and how that lab stands are what a reader weighs before opening the PDF,
 * and OpenAlex carries all three on every authorship. This module picks the two
 * people who matter out of an author list that can run to hundreds, and turns an
 * institution's output into a tier.
 *
 * "Top-tier" is a judgement, and a hand-written list of famous universities is an
 * opinion wearing a badge. The standing of an institution is therefore read off
 * OpenAlex's own figure for it -- the h-index of everything it has ever published --
 * and bucketed. The thresholds mirror the ones the companion Style Custom plugin
 * uses in the item list, so a paper reads the same in both places. Environment-
 * agnostic: loads in the Zotero window and in Node for tests.
 */
var ZotPoPAffiliations = (function () {
	"use strict";

	const text = value => String(value == null ? "" : value).replace(/\s+/g, " ").trim();

	// Cut points on a continuum, taken from the measured spread of institution
	// h-indexes rather than guessed: roughly the top tenth, third and two-thirds.
	const TIERS = [
		{ key: "t1", floor: 1400 },
		{ key: "t2", floor: 800 },
		{ key: "t3", floor: 400 },
		{ key: "t4", floor: 0 }
	];

	function tierOf(hIndex) {
		let value = Number(hIndex);
		if (!(value > 0)) return null;
		return TIERS.find(tier => value >= tier.floor) || null;
	}

	// ISO 3166-1 alpha-2, so a flag is two regional indicator symbols away.
	function flag(code) {
		let value = text(code).toUpperCase();
		if (!/^[A-Z]{2}$/.test(value)) return "";
		return String.fromCodePoint(...[...value].map(letter => 0x1F1E6 + letter.charCodeAt(0) - 65));
	}

	/* The first author did the work and the corresponding author answers for it. When
	   nobody is flagged corresponding -- older records, and every source but OpenAlex --
	   the last author is the convention in the life sciences, and `correspondingKnown`
	   says which rule was used. */
	function principals(people) {
		let list = (Array.isArray(people) ? people : []).filter(person => person && text(person.name));
		if (!list.length) return null;
		let first = list.find(person => person.position === "first") || list[0];
		let flagged = list.filter(person => person.corresponding);
		let last = list.find(person => person.position === "last") || list[list.length - 1];
		let corresponding = flagged.length ? flagged[0] : (list.length > 1 ? last : null);
		return {
			first,
			corresponding: corresponding && corresponding !== first ? corresponding : null,
			correspondingKnown: flagged.length > 0
		};
	}

	function describe(person) {
		if (!person) return null;
		let tier = tierOf(person.institutionH);
		return {
			name: text(person.name),
			institution: text(person.institution),
			country: text(person.country).toUpperCase(),
			flag: flag(person.country),
			hIndex: Number.isFinite(person.institutionH) ? person.institutionH : null,
			tier: tier ? tier.key : null
		};
	}

	/* What a row shows for one paper: both people, their labs, their countries, and the
	   better of the two institutions' tiers. */
	function summarise(people) {
		let picked = principals(people);
		if (!picked) return null;
		let first = describe(picked.first);
		let corresponding = describe(picked.corresponding);
		let countries = [...new Set([first?.country, corresponding?.country].filter(Boolean))];
		let best = [first, corresponding].filter(row => row?.tier).sort((a, b) => (b.hIndex || 0) - (a.hIndex || 0))[0] || null;
		return {
			first, corresponding, countries,
			correspondingKnown: picked.correspondingKnown,
			tier: best?.tier || null,
			hIndex: best?.hIndex ?? first?.hIndex ?? null,
			international: countries.length > 1
		};
	}

	const api = { summarise, principals, describe, tierOf, flag, TIERS };
	return api;
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPAffiliations;

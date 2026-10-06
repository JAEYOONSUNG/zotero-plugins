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

	// Cut points on a continuum. They must stay identical to Style Custom's
	// (test/affiliations.test.mjs compares the two tables).
	const TIERS = [
		{ key: "t1", floor: 2000 },
		{ key: "t2", floor: 1400 },
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
		// A list that names positions but has no last author was cut short (OpenAlex stops at 100): its final
		// entry is a middle author, and naming that lab as the last author's would be invented.
		let positioned = list.some(person => person.position);
		let last = list.find(person => person.position === "last") || (positioned ? null : list[list.length - 1]);
		let corresponding = flagged.length ? flagged[0] : (list.length > 1 && last ? last : null);
		return {
			first,
			corresponding: corresponding && corresponding !== first ? corresponding : null,
			correspondingKnown: flagged.length > 0
		};
	}

	/* Every institution an author lists, in the source's order, as { name, id, ror, country, type, hIndex }.
	   A person saved before the list existed (one institution in flat fields) reads as a list of one. */
	function institutionsOf(person) {
		if (!person) return [];
		if (Array.isArray(person.institutions) && person.institutions.length) {
			return person.institutions.filter(i => i && (text(i.name) || i.id || i.country)).map(i => ({
				name: text(i.name), id: i.id || null, ror: i.ror || null, country: text(i.country).toUpperCase() || null, type: i.type || null,
				hIndex: Number.isFinite(i.hIndex) ? i.hIndex : null
			}));
		}
		if (!text(person.institution) && !person.institutionId && !text(person.country)) return [];
		return [{ name: text(person.institution), id: person.institutionId || null, ror: null, country: text(person.country).toUpperCase() || null, type: null,
			hIndex: Number.isFinite(person.institutionH) ? person.institutionH : null }];
	}

	/* One author as a row shows them. The institution, country and h-index are the first institution's (what the
	   CSV columns have always held); the tier is the best of all of them, and `tierFrom` names that institution. */
	function describe(person) {
		if (!person) return null;
		let institutions = institutionsOf(person).map(i => ({ ...i, flag: flag(i.country), tier: tierOf(i.hIndex)?.key || null }));
		let first = institutions[0] || null;
		let best = institutions.filter(i => i.tier).sort((a, b) => b.hIndex - a.hIndex)[0] || null;
		let country = first?.country || text(person.country).toUpperCase();
		return {
			name: text(person.name),
			institution: first ? first.name : text(person.institution),
			country,
			flag: flag(country),
			hIndex: first && first.hIndex != null ? first.hIndex : Number.isFinite(person.institutionH) ? person.institutionH : null,
			tier: best ? best.tier : null,
			tierH: best ? best.hIndex : null,
			tierFrom: best ? best.name : null,
			institutions,
			countries: [...new Set(institutions.map(i => i.country).filter(Boolean))]
		};
	}

	/* What a row shows for one paper: both people, their labs, their countries, and the
	   better of the two people's best institutions. */
	function summarise(people) {
		let picked = principals(people);
		if (!picked) return null;
		let first = describe(picked.first);
		let corresponding = describe(picked.corresponding);
		let countries = [...new Set([first, corresponding].flatMap(p => p ? (p.countries.length ? p.countries : [p.country]) : []).filter(Boolean))];
		let best = [first, corresponding].filter(row => row?.tier).sort((a, b) => (b.tierH || 0) - (a.tierH || 0))[0] || null;
		return {
			first, corresponding, countries,
			correspondingKnown: picked.correspondingKnown,
			tier: best?.tier || null,
			hIndex: best?.tierH ?? first?.hIndex ?? null,
			tierFrom: best?.tierFrom || null,
			international: countries.length > 1
		};
	}

	const api = { summarise, principals, describe, institutionsOf, tierOf, flag, TIERS };
	return api;
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPAffiliations;

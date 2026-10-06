/*
 * Finding a journal as you type, and turning the journals picked into a query.
 *
 * A reader types what they know the journal by: its name, the abbreviation a reference list prints
 * ("Nat Methods", "Proc Natl Acad Sci"), or the letters people say aloud ("PNAS", "NAR", "JACS").
 * This module answers from lists that are already on the machine -- the curated abbreviations of
 * journal-marks.js, the open journal registry, the reader's own JCR export when there is one -- ranked
 * so the exact abbreviation or acronym comes first, then names that start with the typing, then the
 * rest. It never makes a request; the window asks OpenAlex's autocomplete only when this list has
 * too few answers, and merges what comes back with mergeSuggestions.
 *
 * Environment-agnostic: loads in the Zotero window and in Node for tests.
 */
var ZotPoPJournals = (function () {
	"use strict";

	// Case, accents, dots and every other punctuation mark are ignored: "Nat. Methods" is "nat methods".
	const flat = value => String(value == null ? "" : value).normalize("NFKD").replace(/\p{M}+/gu, "").normalize("NFC").toLowerCase()
		.replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/^the /, "");
	const SKIP = new Set(["the", "of", "and", "in", "for", "on", "a", "an", "at", "to", "de", "der", "des", "du", "la", "le", "et", "und", "di", "del"]);
	const issnOf = value => { let m = String(value || "").toUpperCase().match(/(\d{4})-?(\d{3}[\dX])/); return m ? m[1] + "-" + m[2] : ""; };

	// "Journal of the American Chemical Society" -> "jacs": the first letters of the words that carry meaning.
	// One-word titles have no acronym ("Cell" is already as short as it gets).
	function acronymOf(name) {
		let words = flat(name).split(" ").filter(w => w && !SKIP.has(w));
		return words.length >= 2 ? words.map(w => w[0]).join("") : "";
	}
	// JCR writes titles in capitals ("NATURE METHODS"); a name nobody else supplied is set in title case.
	function prettify(name) {
		let s = String(name || "").trim();
		if (s !== s.toUpperCase()) return s;
		return s.toLowerCase().replace(/(^|[\s(\-/])(\p{L})/gu, (_, pre, c) => pre + c.toUpperCase())
			.replace(/\b(Of|The|And|In|For|On|A|An|At|To|De|Der)\b(?!$)/g, w => w.toLowerCase()).replace(/^./, c => c.toUpperCase());
	}

	/* The catalog: one entry per journal, with everything it can be found by.
	   Inputs, all optional:
	     curated   { "Full Name": "Abbrev", ... }            (journal-marks.js ABBREVIATIONS)
	     abbreviate(name) -> string                           (journal-marks.js, ISO 4 style, word by word)
	     registry  [{ title, abbreviation, issns, impactFactor, publisher }]   (the open journal registry)
	     jcr       [[name, abbreviation, issn, eIssn, jif], ...]               (the reader's own export) */
	function build({ curated = {}, abbreviate = null, registry = [], jcr = [] } = {}) {
		// Spelled-out ways of saying a name that are not journals of their own ("PNAS" for the Proceedings).
		let aliases = new Set(Object.entries(curated || {}).filter(([full, short]) => flat(full) !== flat(short)).map(([, short]) => flat(short)));
		let byName = new Map(), list = [];
		/* Two journals can carry one title: "Microbiology" is the Microbiology Society's (1350-0872) and Pleiades'
		   (0026-2617). Merged into one choice, picking it searched both. A row whose ISSNs share nothing with a held
		   entry of that title is a journal of its own; the two are told apart by publisher in the list. */
		let entryFor = (name, pretty, ids = []) => {
			let key = flat(name);
			if (!key) return null;
			let mine = ids.map(issnOf).filter(Boolean), held = byName.get(key) || [];
			let e = held.find(x => !mine.length || !x.issns.length || x.issns.some(i => mine.includes(i)));
			if (!e) {
				e = { name: pretty ? prettify(name) : String(name).trim(), n: key, abbrevs: [], a: [], k: acronymOf(name), issns: [], pop: 0, curated: false, publisher: "" };
				held.push(e); byName.set(key, held); list.push(e);
				if (held.length > 1) for (let x of held) x.homonym = true;
			}
			return e;
		};
		let addAbbrev = (e, text) => {
			let key = flat(text);
			if (!key || key === e.n || e.a.includes(key)) return;
			e.a.push(key); e.abbrevs.push(String(text).trim());
		};
		let addIssn = (e, ...ids) => { for (let id of ids) { let v = issnOf(id); if (v && !e.issns.includes(v)) e.issns.push(v); } };
		for (let [full, short] of Object.entries(curated || {})) {
			if (aliases.has(flat(full)) && flat(full) === flat(short)) continue;
			let e = entryFor(full, false); if (!e) continue;
			e.curated = true; e.pop = Math.max(e.pop, 1000);
			addAbbrev(e, short);
		}
		for (let row of registry || []) {
			let e = entryFor(row.title, false, row.issns || []); if (!e) continue;
			addIssn(e, ...(row.issns || []));
			if (row.abbreviation) addAbbrev(e, row.abbreviation);
			if (!e.publisher && row.publisher) e.publisher = row.publisher;
			e.pop = Math.max(e.pop, Number(row.impactFactor) || 0);
		}
		for (let row of jcr || []) {
			let [name, abbrev, issn, eissn, jif] = row;
			let e = entryFor(name, true, [issn, eissn]); if (!e) continue;
			addIssn(e, issn, eissn);
			// The JCR's own abbreviations are shouted in capitals; they are found by, not shown.
			if (abbrev) { let key = flat(abbrev); if (key && key !== e.n && !e.a.includes(key)) e.a.push(key); }
			e.pop = Math.max(e.pop, Number(jif) || 0);
		}
		for (let e of list) {
			// The abbreviation a reference list prints is found by too, whatever the registry says: "Proc Natl Acad Sci"
			// reaches PNAS's journal whether or not anyone listed it. It is shown only when no better one is known.
			let short = typeof abbreviate === "function" ? abbreviate(e.name) : "", key = flat(short);
			if (key && key !== e.n && !e.a.includes(key)) { e.a.push(key); if (!e.abbrevs.length) e.abbrevs.push(short); }
			e.h = " " + [e.n, ...e.a].join(" | ") + " ";
		}
		return { entries: list, size: list.length };
	}

	// 0 exact abbreviation / acronym / name, 1 starts with it, 2 acronym starts with it, 3 every typed word starts a word, 4 contains it; -1 no.
	function tierOf(e, q, tokens, compact) {
		if (e.n === q || e.a.includes(q) || (compact.length >= 2 && e.k === compact)) return 0;
		if (e.n.startsWith(q) || e.a.some(a => a.startsWith(q))) return 1;
		if (compact.length >= 3 && e.k.startsWith(compact)) return 2;
		if (tokens.every(tok => e.h.includes(" " + tok))) return 3;
		if (e.h.includes(q)) return 4;
		return -1;
	}

	/* The best `limit` journals for what was typed. A query shorter than two characters answers nothing:
	   one letter names half the registry. Ties inside a tier go to the better known journal (curated, then
	   by impact), then to the shorter name. */
	function suggest(catalog, query, { limit = 8, min = 2 } = {}) {
		let q = flat(query);
		if (!catalog || q.length < min) return [];
		let tokens = q.split(" "), compact = q.replace(/ /g, ""), found = [];
		for (let e of catalog.entries) { let tier = tierOf(e, q, tokens, compact); if (tier >= 0) found.push({ e, tier }); }
		found.sort((x, y) => x.tier - y.tier || y.e.pop - x.e.pop || x.e.name.length - y.e.name.length || x.e.name.localeCompare(y.e.name));
		return found.slice(0, limit).map(({ e, tier }) => ({ name: e.name, abbrev: e.abbrevs[0] || "", issns: e.issns.slice(), tier, source: "local",
			...(e.homonym ? { homonym: true, publisher: e.publisher || "" } : {}) }));
	}

	// Remote answers (OpenAlex's autocomplete) follow the local ones; a journal already listed, by name or ISSN, is not listed twice.
	function mergeSuggestions(local, remote, limit = 8) {
		let out = (local || []).slice(), names = new Set(out.map(o => flat(o.name))), issns = new Set(out.flatMap(o => o.issns || []));
		for (let r of remote || []) {
			if (out.length >= limit) break;
			let key = flat(r.name);
			if (!key || names.has(key) || (r.issns || []).some(i => issns.has(i))) continue;
			names.add(key); for (let i of r.issns || []) issns.add(i);
			out.push({ ...r, source: "remote" });
		}
		return out.slice(0, limit);
	}

	// One OpenAlex /autocomplete/sources row as a suggestion.
	function fromAutocomplete(row) {
		if (!row || !row.display_name) return null;
		let id = String(row.id || "").replace(/^https?:\/\/openalex\.org\//, "");
		return { name: String(row.display_name), abbrev: "", issns: [issnOf(row.external_id)].filter(Boolean), openalexId: /^S\d+$/.test(id) ? id : null, hint: row.hint || "", tier: 5, source: "remote" };
	}

	// ---------------------------------------------------------------- the query
	const quote = name => '"' + String(name).replace(/["\\]/g, " ").replace(/\s+/g, " ").trim() + '"';
	/* The chips picked and whatever is still typed in the box, as the fields of a search query.
	   - nothing picked: the box as typed, exactly as before (it may be an expression of its own);
	   - one journal: its name alone;
	   - several: an OR expression of the names and their ISSNs (for matching what comes back), and the
	     list itself, which each source turns into its own filter. Typed text that is not a picked
	     journal counts as one more. */
	function queryFields(chips, typed) {
		let text = String(typed || "").trim(), list = (chips || []).map(c => ({ name: String(c.name).trim(), issns: (c.issns || []).slice(), openalexId: c.openalexId || null })).filter(c => c.name);
		if (!list.length) return { venue: text, venues: undefined };
		if (text && !list.some(c => flat(c.name) === flat(text))) list.push({ name: text, issns: [], openalexId: null });
		if (list.length === 1) return { venue: list[0].name, venues: list };
		let terms = [];
		for (let c of list) { terms.push(quote(c.name)); for (let i of c.issns) if (!terms.includes(i)) terms.push(i); }
		return { venue: terms.join(" OR "), venues: list };
	}
	// The journals of a query as a plain list of names (sources fan out over these).
	function venueNames(query) {
		let list = Array.isArray(query && query.venues) ? query.venues.map(v => typeof v === "string" ? v : v && v.name).filter(Boolean) : [];
		return [...new Set(list.map(n => String(n).trim()).filter(Boolean))];
	}

	// A registry handed in by the page that has it already (tests and the design preview have no file to read).
	let held = null;
	const holdRegistry = rows => { held = Array.isArray(rows) ? rows : null; };

	return { holdRegistry, held: () => held, flat, acronymOf, prettify, build, suggest, mergeSuggestions, fromAutocomplete, queryFields, venueNames, issnOf };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPJournals;

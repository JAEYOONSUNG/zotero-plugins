/*
 * The Journal Impact Factor, from the JCR itself.
 *
 * OpenAlex's two-year mean citedness follows the JIF formula on open data, and it
 * is what the results table used to show as "IF". It is not the figure people mean
 * by that word. This module answers with the Clarivate figure -- the user's own
 * export of the JCR 2026 release (JIF 2025), 22,594 journals -- matched by ISSN
 * first, then by title or JCR abbreviation. What it cannot name falls back to the
 * OpenAlex estimate, which the table then marks as one.
 * Environment-agnostic: loads in the Zotero window and in Node for tests.
 */
var ZotPoPJCR = (function () {
	"use strict";

	const EDITION = "JCR 2026 (JIF 2025)";
	const flat = value => String(value == null ? "" : value).normalize("NFKC").toLowerCase()
		.replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/^the /, "");
	// Titles Zotero writes one way and the JCR another.
	const ALIASES = {
		"proceedings of the national academy of sciences": "proceedings of the national academy of sciences of the united states of america",
		"pnas": "proceedings of the national academy of sciences of the united states of america",
		"plos one": "plos one", "plos biology": "plos biology", "embo journal": "embo journal"
	};
	const issnKey = value => {
		let s = String(value || "").toUpperCase().replace(/[^0-9X]/g, "");
		return /^\d{7}[\dX]$/.test(s) ? s : "";
	};

	function build(rows) {
		let byIssn = new Map(), byName = new Map();
		for (let row of rows || []) {
			let [name, abbrev, issn, eissn, jif] = row;
			let entry = { name, abbrev, issn, eissn, jif: Number(jif) };
			for (let id of [issn, eissn]) { let k = issnKey(id); if (k && !byIssn.has(k)) byIssn.set(k, entry); }
			for (let title of [name, abbrev]) { let k = flat(title); if (k && !byName.has(k)) byName.set(k, entry); }
		}
		return {
			size: byIssn.size,
			// A record's ISSN settles it; a title only when no ISSN is known or matches.
			find(record) {
				if (!record) return null;
				for (let id of [record.issn, ...(record.issns || [])]) { let hit = byIssn.get(issnKey(id)); if (hit) return hit; }
				for (let title of [record.venue, record.journalAbbrev, ...(record.venueAliases || [])]) {
					let key = flat(title), hit = byName.get(ALIASES[key] || key);
					if (hit) return hit;
				}
				return null;
			}
		};
	}

	let table = null;
	function shared() {
		if (!table) table = build(typeof ZotPoPJCRData !== "undefined" ? ZotPoPJCRData : typeof require === "function" ? require("./jcr-2025-data.js") : []);
		return table;
	}

	// Fill journalIF from the JCR where it knows the journal. Mutates records; returns how many.
	function apply(records, source = shared()) {
		let n = 0;
		for (let r of records || []) {
			let hit = source.find(r);
			if (!hit) continue;
			r.journalIF = hit.jif;
			r.journalIFSource = EDITION;
			r.journalIFEstimate = false;
			// The JCR's own abbreviations are shouted in capitals ("NAT COMMUN"); the
			// reference-list form comes from elsewhere, so they are not copied over.
			n++;
		}
		return n;
	}

	return { EDITION, build, shared, apply, flat, issnKey };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPJCR;

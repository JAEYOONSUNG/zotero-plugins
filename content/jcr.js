/*
 * The Journal Impact Factor, from the JCR itself.
 *
 * OpenAlex's two-year mean citedness follows the JIF formula on open data, and it
 * is what the results table shows as "IF" by default. It is not the figure people
 * mean by that word. This module answers with the Clarivate figure instead, matched
 * by ISSN first, then by title or JCR abbreviation, for a reader who holds a JCR
 * entitlement of their own.
 *
 * That figure is licensed to its reader, so the plugin does not carry it: nothing
 * is built in, and the table stays empty until load() is handed rows read from the
 * reader's own export in the Zotero data directory. Until then, and for any journal
 * the export does not name, the OpenAlex estimate answers and the table marks it as
 * an estimate.
 * Environment-agnostic: loads in the Zotero window and in Node for tests.
 */
var ZotPoPJCR = (function () {
	"use strict";

	const EDITION = "JCR 2026 (JIF 2025)";
	const flat = value => String(value == null ? "" : value).normalize("NFKC").toLowerCase()
		.replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/^the /, "");
	// Titles Zotero writes one way and the JCR another, and journals the JCR lists
	// only under the name they carry now: an old paper's old title is sent there.
	const ALIASES = {
		"biotechnology for biofuels": "biotechnology for biofuels and bioproducts",
		"bmc evolutionary biology": "bmc ecology and evolution",
		"molecular and general genetics mgg": "molecular genetics and genomics",
		"molecular and general genetics": "molecular genetics and genomics",
		"journal of general microbiology": "microbiology sgm",
		"european journal of biochemistry": "febs journal",
		"journal of applied bacteriology": "journal of applied microbiology",
		"genome announcements": "microbiology resource announcements",
		"agricultural and biological chemistry": "bioscience biotechnology and biochemistry",
		"biotechnology techniques": "biotechnology letters",
		"standards in genomic sciences": "environmental microbiome",
		"current protocols in molecular biology": "current protocols",
		"bioelectrochemistry and bioenergetics": "bioelectrochemistry",
		"angewandte chemie": "angewandte chemie international edition",
		"acta crystallographica section f structural biology and crystallization communications": "acta crystallographica section f structural biology communications",
		"acta crystallographica section f": "acta crystallographica section f structural biology communications",
		"frontiers in bioscience": "frontiers in bioscience landmark",
		"proceedings of the national academy of sciences": "proceedings of the national academy of sciences of the united states of america",
		"pnas": "proceedings of the national academy of sciences of the united states of america"
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
	// Rows as the export gives them: [title, abbreviation, issn, eIssn, jif].
	function load(rows) { table = build(Array.isArray(rows) ? rows : []); return table; }
	function shared() {
		if (!table) table = build(typeof ZotPoPJCRData !== "undefined" ? ZotPoPJCRData : []);
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

	return { EDITION, build, load, shared, apply, flat, issnKey };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPJCR;

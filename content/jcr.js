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

	/* Which edition the figures are is the reader's file's to say, never the plugin's: a year built in
	   here labelled every export "JCR 2026" whatever year it was. The file records it as
	   { jcrYear: 2026, rows: [...] } (or jifYear, the year before the release), or in its name,
	   jcr-2026.json; a bare list of rows is labelled "JCR" with no year. */
	const YEAR = value => { let n = Number(String(value ?? "").match(/^\s*(?:JCR\s*)?(\d{4})\s*$/i)?.[1]); return Number.isInteger(n) && n >= 1975 && n <= 2100 ? n : null; };
	function editionOf(data, fileName) {
		let jcrYear = null, jifYear = null;
		if (data && !Array.isArray(data) && typeof data === "object") {
			jcrYear = YEAR(data.jcrYear ?? data.edition);
			jifYear = YEAR(data.jifYear);
		}
		if (!jcrYear && !jifYear) jcrYear = YEAR(String(fileName || "").match(/jcr[\s_-]*(\d{4})/i)?.[1]);
		if (jcrYear && !jifYear) jifYear = jcrYear - 1;
		if (jifYear && !jcrYear) jcrYear = jifYear + 1;
		return { jcrYear, jifYear, label: jcrYear ? "JCR " + jcrYear + " (JIF " + jifYear + ")" : "JCR" };
	}
	let edition = editionOf(null);
	// The export to read from the journals folder: the newest jcr-YYYY.json, else jcr.json; null for none.
	function pickFile(names) {
		let list = (names || []).map(name => String(name).split(/[\\/]/).pop());
		let dated = list.map(name => ({ name, year: YEAR(name.match(/^jcr[\s_-]*(\d{4})\.json$/i)?.[1]) })).filter(x => x.year).sort((a, b) => b.year - a.year);
		return dated[0]?.name || list.find(name => /^jcr\.json$/i.test(name)) || null;
	}
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
		let byIssn = new Map(), byName = new Map(), ambiguous = new Set();
		for (let row of rows || []) {
			let [name, abbrev, issn, eissn, jif] = row;
			let entry = { name, abbrev, issn, eissn, jif: Number(jif) };
			for (let id of [issn, eissn]) { let k = issnKey(id); if (k && !byIssn.has(k)) byIssn.set(k, entry); }
			for (let title of [name, abbrev]) { let k = flat(title); if (!k) continue;
				let held = byName.get(k);
				if (!held) byName.set(k, entry);
				// The same title on two different journals (a Russian and a Society one both called "Microbiology"): only an ISSN may decide it.
				else if (held !== entry && issnKey(held.issn) !== issnKey(entry.issn) && issnKey(held.eissn) !== issnKey(entry.eissn)) ambiguous.add(k);
			}
		}
		return {
			size: byIssn.size,
			// A record's ISSN settles it; a title only when no ISSN is known or matches.
			find(record) {
				if (!record) return null;
				for (let id of [record.issn, ...(record.issns || [])]) { let hit = byIssn.get(issnKey(id)); if (hit) return hit; }
				for (let title of [record.venue, record.journalAbbrev, ...(record.venueAliases || [])]) {
					let key = flat(title), k2 = ALIASES[key] || key, hit = ambiguous.has(k2) ? null : byName.get(k2);
					if (hit) return hit;
				}
				return null;
			}
		};
	}

	let table = null, held = null;
	// Rows as the export gives them: [title, abbreviation, issn, eIssn, jif], as a bare list or { jcrYear, rows }.
	function load(data, { fileName = "" } = {}) {
		let rows = Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : [];
		edition = editionOf(data, fileName);
		held = rows; table = build(held); return table;
	}
	// The rows the table was built from: the journal box finds journals by their JCR names and abbreviations too.
	function rows() { return held || (typeof ZotPoPJCRData !== "undefined" ? ZotPoPJCRData : []); }
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
			r.journalIFSource = edition.label;
			// The JCR's own abbreviations are shouted in capitals ("NAT COMMUN"); the
			// reference-list form comes from elsewhere, so they are not copied over.
			n++;
		}
		return n;
	}

	return { get EDITION() { return edition.label; }, edition: () => ({ ...edition }), pickFile, build, load, rows, shared, apply, flat, issnKey };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPJCR;

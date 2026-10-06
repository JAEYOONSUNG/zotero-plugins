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
	/* A bare list cannot carry its year, and the reader's export is theirs: it is never rewritten. The year
	   goes into a small file beside it instead, jcr.meta.json { jcrYear, file, rows }, which counts only for
	   the file it names and only while that file still has the same number of rows (a new export under the
	   old name is not given last year's label). The file's own year, then its name, outrank it. */
	const META_FILE = "jcr.meta.json";
	const rowsOf = data => Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : [];
	function metaApplies(meta, data, fileName) {
		if (!meta || typeof meta !== "object" || !YEAR(meta.jcrYear)) return false;
		let name = String(fileName || "").split(/[\\/]/).pop();
		return String(meta.file || "") === name && (meta.rows == null || Number(meta.rows) === rowsOf(data).length);
	}
	function editionOf(data, fileName, meta = null) {
		let jcrYear = null, jifYear = null, from = null;
		if (data && !Array.isArray(data) && typeof data === "object") {
			jcrYear = YEAR(data.jcrYear ?? data.edition);
			jifYear = YEAR(data.jifYear);
			if (jcrYear || jifYear) from = "file";
		}
		if (!jcrYear && !jifYear) { jcrYear = YEAR(String(fileName || "").match(/jcr[\s_-]*(\d{4})/i)?.[1]); if (jcrYear) from = "name"; }
		if (!jcrYear && !jifYear && metaApplies(meta, data, fileName)) { jcrYear = YEAR(meta.jcrYear); from = "meta"; }
		if (jcrYear && !jifYear) jifYear = jcrYear - 1;
		if (jifYear && !jcrYear) jcrYear = jifYear + 1;
		return { jcrYear, jifYear, from, label: jcrYear ? "JCR " + jcrYear + " (JIF " + jifYear + ")" : "JCR" };
	}
	// What the sidecar holds for a year the reader sets: the year, the file it is about and its row count.
	function metaRecord(year, fileName, data) {
		let jcrYear = YEAR(year);
		if (!jcrYear) return null;
		return { jcrYear, file: String(fileName || "").split(/[\\/]/).pop(), rows: rowsOf(data).length, savedAt: new Date().toISOString() };
	}
	/* The status line under the journals folder: which file, how many journals, which edition and where that
	   year came from; `canSetYear` when the file and its name say nothing, `staleMeta` when a sidecar names
	   this file but no longer matches it. `suggest` is the newest edition likely out (JCR is released in June). */
	function statusOf({ fileName = null, data = null, meta = null, now = new Date() } = {}) {
		if (!fileName) return { file: null, rows: 0, edition: editionOf(null), canSetYear: false };
		let edition = editionOf(data, fileName, meta), rows = rowsOf(data).length;
		let named = meta && String(meta.file || "") === String(fileName).split(/[\\/]/).pop();
		return { file: fileName, rows, edition, canSetYear: edition.from === null || edition.from === "meta",
			staleMeta: Boolean(named && edition.from !== "meta" && edition.from === null),
			suggest: now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1 };
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
	// Of those, the ones that are only another spelling of the same journal; every other entry is a renamed or
	// successor journal, whose figure is labelled as that journal's.
	const SPELLINGS = new Set(["proceedings of the national academy of sciences", "pnas"]);
	const issnKey = value => {
		let s = String(value || "").toUpperCase().replace(/[^0-9X]/g, "");
		return /^\d{7}[\dX]$/.test(s) ? s : "";
	};

	/* Plain titles the JCR gives to one journal while another is the one usually meant by them: "MICROBIOLOGY"
	   in the JCR is the Russian journal (JIF 1.0), but a reference list's "Microbiology" is far more often the
	   Microbiology Society's (MICROBIOLOGY-SGM, 4.3). Only an ISSN may decide these. */
	const AMBIGUOUS_TITLES = new Set(["microbiology"]);
	// "Biochimica et Biophysica Acta (BBA) - Bioenergetics": the bracketed initials are not part of the JCR title.
	const unbracketed = value => String(value == null ? "" : value).replace(/\([^)]*\)/g, " ");
	function build(rows) {
		let byIssn = new Map(), byName = new Map(), ambiguous = new Set(AMBIGUOUS_TITLES), byHead = new Map();
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
			/* The JCR joins a title to its qualifier with a hyphen ("Life-Basel", "NITRIC OXIDE-BIOLOGY AND CHEMISTRY",
			   "Jove-Journal of Visualized Experiments"), where the journal itself and every other index say "Life",
			   "Nitric Oxide", "Journal of Visualized Experiments". Each side is a way to find it, but only where no
			   journal carries that title outright and no other JCR title shares it. */
			let raw = String(name || ""), cut = raw.indexOf("-");
			if (cut > 0) for (let part of [raw.slice(0, cut), raw.slice(cut + 1)]) {
				let k = flat(part);
				if (!k || k.length < 4 || (part === raw.slice(cut + 1) && k.split(" ").length < 3)) continue;
				byHead.set(k, byHead.has(k) && byHead.get(k) !== entry ? null : entry);
			}
		}
		const byTitle = (key, heads = true) => ambiguous.has(key) ? null : byName.get(key) || (heads && !byName.has(key) ? byHead.get(key) : null) || null;
		return {
			size: byIssn.size,
			// A record's ISSN settles it; a title only when no ISSN is known or matches.
			find(record) {
				if (!record) return null;
				for (let id of [record.issn, ...(record.issns || [])]) { let hit = byIssn.get(issnKey(id)); if (hit) return hit; }
				for (let title of [record.venue, record.journalAbbrev, record.journalAbbreviation, ...(record.venueAliases || [])]) {
					for (let key of new Set([flat(title), flat(unbracketed(title))])) {
						if (!key) continue;
						// The title as written first: an export that still lists the old title (or the German Angewandte) has its own figure.
						let hit = byTitle(key, false);
						if (hit) return hit;
						let renamed = ALIASES[key];
						hit = renamed ? byTitle(renamed) : null;
						// A title the JCR lists under another (its successor's) name says so: that figure is the other title's.
						if (hit) return SPELLINGS.has(key) ? hit : Object.assign({}, hit, { via: title });
						hit = byTitle(key);
						if (hit) return hit;
					}
				}
				return null;
			}
		};
	}

	// The JCR shouts its titles ("BIOTECHNOLOGY LETTERS"); shown to a reader they are set in title case.
	const titleCase = name => { let s = String(name || "").trim(); return s !== s.toUpperCase() ? s
		: s.toLowerCase().replace(/(^|[\s(\-/])(\p{L})/gu, (_, pre, c) => pre + c.toUpperCase()).replace(/\b(Of|The|And|In|For|On|A|An|At|To)\b(?!$)/g, w => w.toLowerCase()).replace(/^./, c => c.toUpperCase()); };
	let table = null, held = null;
	// Rows as the export gives them: [title, abbreviation, issn, eIssn, jif], as a bare list or { jcrYear, rows }.
	function load(data, { fileName = "", meta = null } = {}) {
		let rows = rowsOf(data);
		edition = editionOf(data, fileName, meta);
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
			// Matched through a renamed title: the figure is the journal the JCR lists now, and the tooltip names it.
			if (hit.via) r.journalIFAs = titleCase(hit.name); else delete r.journalIFAs;
			// The JCR's own abbreviations are shouted in capitals ("NAT COMMUN"); the
			// reference-list form comes from elsewhere, so they are not copied over.
			n++;
		}
		return n;
	}

	return { get EDITION() { return edition.label; }, edition: () => ({ ...edition }), META_FILE, YEAR, editionOf, metaRecord, statusOf, pickFile, build, load, rows, shared, apply, flat, issnKey };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPJCR;

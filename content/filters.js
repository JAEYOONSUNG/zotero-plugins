/*
 * Filtering a result list: the quick syntax of the filter box and the rules of the filter builder.
 *
 * Pure functions over result records, no DOM. The window (ui.js) owns the state and the drawing; this
 * module decides which record passes, and what each option of a rule would count. Environment-agnostic:
 * loads in the Zotero window and in Node for tests.
 *
 * A filter is the text of the box plus a list of rules.
 *   - The box: plain words (all must occur), "exact phrases", -word and -"phrase" to leave papers out,
 *     and field:value / -field:value for title, abstract, author, journal, year, inst, country.
 *   - A rule has a kind, a mode (include or exclude) and its values. Several values of one rule mean
 *     "any of these"; rules and box terms combine with AND; an exclude rule removes what it matches.
 */
var ZotPoPFilters = (function () {
	"use strict";

	const KINDS = ["text", "author", "journal", "inst", "country", "type", "source", "year", "cites", "cpy", "if", "pdf"];
	const MULTI_KINDS = ["author", "journal", "inst", "country", "type", "source", "pdf"];
	const RANGE_KINDS = ["year", "cites", "cpy", "if"];
	const TEXT_FIELDS = ["all", "title", "abstract", "author", "journal", "inst"];
	const TYPES = ["article", "preprint", "review", "book", "other"];

	// Accents and case do not tell two spellings apart ("Müller" and "Muller" are searched alike).
	const fold = value => String(value == null ? "" : value).normalize("NFKD").replace(/\p{M}+/gu, "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
	// A key for a journal or an institution: letters and digits only, so punctuation and case never split one into two.
	const flat = value => fold(value).replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/^the /, "");

	// ------------------------------------------------------------------ quick syntax
	const FIELD_ALIASES = {
		title: "title", t: "title", "제목": "title",
		abstract: "abstract", abs: "abstract", ab: "abstract", "초록": "abstract",
		author: "author", au: "author", a: "author", "저자": "author",
		journal: "journal", j: "journal", venue: "journal", "저널": "journal", "학술지": "journal",
		year: "year", y: "year", "연도": "year",
		inst: "inst", institution: "inst", aff: "inst", affiliation: "inst", "기관": "inst", "소속": "inst",
		country: "country", c: "country", "국가": "country"
	};

	// "2018", "2018-2022", "2018..2022", ">=2020", ">2020", "<2020", "<=2020", "2020-", "-2020" -> {min,max} or null.
	function parseRange(value) {
		let s = String(value || "").trim().replace(/[–—]/g, "-"), m;
		let n = x => (x === "" || x == null ? null : Number(x));
		if ((m = s.match(/^(\d+(?:\.\d+)?)$/))) return { min: n(m[1]), max: n(m[1]) };
		if ((m = s.match(/^(>=?|<=?)\s*(\d+(?:\.\d+)?)$/))) {
			let v = n(m[2]);
			if (m[1] === ">") return { min: v + (Number.isInteger(v) ? 1 : 1e-9), max: null };
			if (m[1] === ">=") return { min: v, max: null };
			if (m[1] === "<") return { min: null, max: v - (Number.isInteger(v) ? 1 : 1e-9) };
			return { min: null, max: v };
		}
		if ((m = s.match(/^(\d+(?:\.\d+)?)?\s*(?:\.\.|-)\s*(\d+(?:\.\d+)?)?$/)) && (m[1] || m[2])) return { min: n(m[1]), max: n(m[2]) };
		return null;
	}

	/* Splits the box into terms. A term is { field, text, phrase, neg, range }: field is null for a plain
	   word or phrase. A leading "-" excludes. "field:value" needs a known field name; any other colon
	   ("CRISPR:Cas9", a URL) stays part of a plain word. A value may be quoted: author:"Kim JH". */
	function parseQuick(input) {
		let src = String(input == null ? "" : input).replace(/[“”„]/g, '"');
		let terms = [], i = 0;
		while (i < src.length) {
			while (i < src.length && /\s/.test(src[i])) i++;
			if (i >= src.length) break;
			let neg = false;
			if (src[i] === "-" && i + 1 < src.length && !/\s/.test(src[i + 1])) { neg = true; i++; }
			// An optional "field:" prefix.
			let field = null, head = src.slice(i).match(/^([^\s:"]{1,16}):(?=\S)/u);
			if (head && FIELD_ALIASES[head[1].toLowerCase()]) { field = FIELD_ALIASES[head[1].toLowerCase()]; i += head[0].length; }
			let text, phrase = false;
			if (src[i] === '"') {
				let end = src.indexOf('"', i + 1);
				// An unclosed quote takes the rest of the box: the phrase is still being typed.
				text = src.slice(i + 1, end < 0 ? src.length : end); phrase = true; i = end < 0 ? src.length : end + 1;
			}
			else { let start = i; while (i < src.length && !/\s/.test(src[i])) i++; text = src.slice(start, i); }
			text = fold(text);
			// A lone "-" is a dash being typed, not a word.
			if (!text || (!neg && !field && !phrase && text === "-")) continue;
			let term = { field, text, phrase, neg };
			if (field === "year") { let range = parseRange(text); if (!range) { term.field = null; term.text = (head ? head[0] : "") + text; } else term.range = range; }
			terms.push(term);
		}
		return terms;
	}

	// ------------------------------------------------------------------ what a record says
	const authorName = a => a.name || [a.firstName, a.lastName].filter(Boolean).join(" ");
	// An author's key: the registry ID when the source gave one, else the name as written.
	// A name is not a person, so a name key never claims the results are one author's.
	function authorKeys(r) {
		let out = [];
		for (let a of r.authors || []) {
			let name = authorName(a);
			let key = a.openalexId ? "id:" + a.openalexId : a.orcid ? "id:" + a.orcid : name ? "name:" + fold(name) : null;
			if (key && !out.some(o => o.key === key)) out.push({ key, name, byId: key.startsWith("id:") });
		}
		return out;
	}
	function peopleOf(r) { return Array.isArray(r.people) ? r.people : []; }
	function institutions(r) {
		let out = [];
		for (let p of peopleOf(r)) {
			let name = String(p.institution || "").trim(), key = flat(name);
			if (key && !out.some(o => o.key === key)) out.push({ key, name, country: p.country || null });
		}
		return out;
	}
	function countries(r) {
		let out = [];
		for (let p of peopleOf(r)) { let c = String(p.country || "").toUpperCase(); if (/^[A-Z]{2}$/.test(c) && !out.includes(c)) out.push(c); }
		return out;
	}
	const REVIEW_TITLE = /(?:^|[:\-–—]\s*)(?:a |an |the )?(?:systematic |narrative |scoping |critical |brief |mini-?|literature |comprehensive )*(?:review|meta-analysis|umbrella review)\b|\b(?:systematic review|meta-analysis|literature review|a review of|an overview of)\b/i;
	// The record's kind, in the five words a reader filters by.
	function typeOf(r) {
		let t = r.itemType || "journalArticle";
		if (t === "preprint" || r.preprintServer) return "preprint";
		if (String(r.workType || "").toLowerCase() === "review" || (["journalArticle", "conferencePaper"].includes(t) && REVIEW_TITLE.test(r.title || ""))) return "review";
		if (t === "book" || t === "bookSection") return "book";
		if (t === "journalArticle" || t === "conferencePaper") return "article";
		return "other";
	}
	const hasPDF = r => Boolean((r.pdfUrls || []).length || r.pdfUrl || r.pmcid || r.arxiv);
	const sourcesOf = r => [...new Set((r.sources && r.sources.length ? r.sources : [r.source]).filter(Boolean))];

	/* Text of each field, folded once per record. The record is never copied or changed; the memo holds
	   it only while the record lives. */
	const memo = new WeakMap();
	const SIGNATURE = ["title", "abstract", "authorString", "venue", "journalAbbrev", "doi", "year", "people", "authors"];
	function texts(r) {
		let m = memo.get(r);
		// Records are completed while the window is open (institutions arrive after the first draw), so the
		// memo is kept only while the fields it was read from are the very same values.
		if (!m || SIGNATURE.some((key, i) => m.sig[i] !== r[key])) {
			let people = peopleOf(r);
			m = {
				sig: SIGNATURE.map(key => r[key]),
				title: fold(r.title),
				abstract: fold(r.abstract),
				author: fold([r.authorString, ...(r.authors || []).map(authorName)].join(" ")),
				journal: fold([r.venue, r.journalAbbrev, ...(r.venueAliases || [])].filter(Boolean).join(" ")),
				inst: fold(people.map(p => p.institution).filter(Boolean).join(" ")),
				doi: fold(r.doi),
				year: String(r.year || "")
			};
			memo.set(r, m);
		}
		return m;
	}
	// The box's plain words match this: what the filter always searched, plus the import status shown in the row.
	function haystack(r, env) {
		let m = texts(r), where = env && env.where ? env.where(r) : null;
		return [m.title, m.author, m.journal, m.doi, m.year, fold(r.status),
			where ? fold([where.first?.institution, where.corresponding?.institution, ...(where.countries || [])].filter(Boolean).join(" ")) : ""].join(" ");
	}

	// A few names a reader types for a country: ISO code, English and Korean.
	const COUNTRY_NAMES = {
		US: ["united states", "usa", "america", "미국"], CN: ["china", "중국"], GB: ["united kingdom", "uk", "britain", "england", "영국"], DE: ["germany", "독일"],
		FR: ["france", "프랑스"], JP: ["japan", "일본"], KR: ["south korea", "korea", "한국", "대한민국"], CA: ["canada", "캐나다"], AU: ["australia", "호주"],
		IT: ["italy", "이탈리아"], ES: ["spain", "스페인"], NL: ["netherlands", "네덜란드"], CH: ["switzerland", "스위스"], SE: ["sweden", "스웨덴"],
		DK: ["denmark", "덴마크"], NO: ["norway", "노르웨이"], FI: ["finland", "핀란드"], BE: ["belgium", "벨기에"], AT: ["austria", "오스트리아"],
		IN: ["india", "인도"], BR: ["brazil", "브라질"], SG: ["singapore", "싱가포르"], IL: ["israel", "이스라엘"], TW: ["taiwan", "대만"],
		HK: ["hong kong", "홍콩"], RU: ["russia", "러시아"], PL: ["poland", "폴란드"], PT: ["portugal", "포르투갈"], IE: ["ireland", "아일랜드"],
		NZ: ["new zealand", "뉴질랜드"], ZA: ["south africa", "남아공"], MX: ["mexico", "멕시코"], TR: ["turkey", "터키"], IR: ["iran", "이란"],
		SA: ["saudi arabia", "사우디"], EG: ["egypt", "이집트"], CZ: ["czechia", "czech republic", "체코"], GR: ["greece", "그리스"], TH: ["thailand", "태국"]
	};
	function countryCodeFor(text) {
		let q = fold(text);
		if (/^[a-z]{2}$/.test(q)) return q.toUpperCase();
		for (let [code, names] of Object.entries(COUNTRY_NAMES)) if (names.some(n => fold(n) === q)) return code;
		return null;
	}

	// ------------------------------------------------------------------ one term, one rule
	function numberOf(kind, r, env) {
		if (kind === "year") return Number.isInteger(r.year) ? r.year : null;
		if (kind === "cites") return r.citations == null || !Number.isFinite(Number(r.citations)) ? null : Number(r.citations);
		if (kind === "cpy") { let v = env && env.cpy ? env.cpy(r) : null; return v == null || !Number.isFinite(Number(v)) ? null : Number(v); }
		if (kind === "if") return r.journalIF == null || !Number.isFinite(Number(r.journalIF)) ? null : Number(r.journalIF);
		return null;
	}
	const inRange = (v, range) => v != null && (range.min == null || v >= range.min) && (range.max == null || v <= range.max);

	function termMatches(r, term, env) {
		let m = texts(r), hit;
		if (term.field === "year") hit = inRange(numberOf("year", r, env), term.range);
		else if (term.field === "country") {
			let code = countryCodeFor(term.text), list = countries(r);
			hit = code ? list.includes(code) : false;
		}
		else if (term.field) hit = m[term.field].includes(term.text);
		else hit = haystack(r, env).includes(term.text);
		return term.neg ? !hit : hit;
	}

	// A text rule's value is itself a little query: words (all of them) and "phrases", looked up in one field.
	function textValueMatches(r, value, field, env) {
		let parts = parseQuick(value);
		if (!parts.length) return false;
		let target = field === "all" ? haystack(r, env) : texts(r)[field] || "";
		return parts.every(p => p.neg ? !target.includes(p.text) : target.includes(p.text));
	}

	// Whether the record satisfies the rule's condition (the exclude mode inverts this at the call site).
	function ruleHolds(r, rule, env) {
		if (rule.kind === "text") return rule.values.some(v => textValueMatches(r, v, rule.field || "all", env));
		if (RANGE_KINDS.includes(rule.kind)) return inRange(numberOf(rule.kind, r, env), rule);
		let has;
		if (rule.kind === "author") has = authorKeys(r).map(a => a.key);
		else if (rule.kind === "journal") has = [flat(r.venue)];
		else if (rule.kind === "inst") has = institutions(r).map(i => i.key);
		else if (rule.kind === "country") has = countries(r);
		else if (rule.kind === "type") has = [typeOf(r)];
		else if (rule.kind === "source") has = sourcesOf(r);
		else if (rule.kind === "pdf") has = [hasPDF(r) ? "yes" : "no"];
		else return true;
		return rule.values.some(v => has.includes(v));
	}

	// ------------------------------------------------------------------ rules
	let nextId = 1;
	function newRule(kind, mode = "include") {
		return { id: "r" + nextId++, kind, mode: mode === "exclude" ? "exclude" : "include", field: "all", values: [], labels: {}, min: null, max: null };
	}
	function ruleActive(rule) {
		if (!rule) return false;
		if (RANGE_KINDS.includes(rule.kind)) return rule.min != null || rule.max != null;
		return rule.values.length > 0;
	}
	// Rules and the box, ready to test records against. Rules with nothing chosen are left out.
	function compile(text, rules) {
		let terms = parseQuick(text), active = (rules || []).filter(ruleActive);
		return { terms, rules: active, empty: !terms.length && !active.length, text: String(text || "") };
	}
	/* Whether the record passes. opts: skipRule (an id, or "*" for every rule) leaves rules out, so an option
	   list can count against "all the other rules"; ignoreYears leaves out the year rules and year: terms,
	   so the year histogram keeps its whole picture. */
	function matches(r, spec, env, opts = {}) {
		if (!spec) return true;
		for (let term of spec.terms) {
			if (opts.ignoreYears && term.field === "year") continue;
			if (!termMatches(r, term, env)) return false;
		}
		for (let rule of spec.rules) {
			if (opts.skipRule === "*" || opts.skipRule === rule.id) continue;
			if (opts.ignoreYears && rule.kind === "year") continue;
			if (ruleHolds(r, rule, env) === (rule.mode === "exclude")) return false;
		}
		return true;
	}

	// ------------------------------------------------------------------ options for a rule
	/* What a record offers a multi-value rule: [{ key, label }]. Counting these over the records that pass
	   every other rule is what makes each option's number honest. */
	function offered(kind, r) {
		if (kind === "author") return authorKeys(r).map(a => ({ key: a.key, label: a.name }));
		if (kind === "journal") return r.venue ? [{ key: flat(r.venue), label: r.venue }] : [];
		if (kind === "inst") return institutions(r).map(i => ({ key: i.key, label: i.name }));
		if (kind === "country") return countries(r).map(c => ({ key: c, label: c }));
		if (kind === "type") return [{ key: typeOf(r), label: typeOf(r) }];
		if (kind === "source") return sourcesOf(r).map(s => ({ key: s, label: s }));
		if (kind === "pdf") return [{ key: hasPDF(r) ? "yes" : "no", label: hasPDF(r) ? "yes" : "no" }];
		return [];
	}
	// Option counts for a kind over a list of records: [{ key, label, n }], biggest first, then by name.
	function tally(kind, records) {
		let map = new Map();
		for (let r of records) for (let o of offered(kind, r)) {
			let e = map.get(o.key);
			if (e) e.n++; else map.set(o.key, { key: o.key, label: o.label, n: 1 });
		}
		let fixed = kind === "type" ? TYPES : kind === "pdf" ? ["yes", "no"] : null;
		let list = [...map.values()];
		if (fixed) return fixed.map(k => map.get(k) || { key: k, label: k, n: 0 });
		return list.sort((a, b) => b.n - a.n || String(a.label).localeCompare(String(b.label)));
	}
	// Options of a kind matching what the reader typed into the picker's search box, folded like everything else.
	function searchOptions(options, query) {
		let q = fold(query);
		return q ? options.filter(o => fold(o.label).includes(q)) : options;
	}

	return { KINDS, MULTI_KINDS, RANGE_KINDS, TEXT_FIELDS, TYPES, fold, flat, parseQuick, parseRange, authorKeys, institutions, countries, typeOf, hasPDF, sourcesOf,
		countryCodeFor, COUNTRY_NAMES, newRule, ruleActive, compile, matches, ruleHolds, tally, offered, searchOptions, numberOf };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPFilters;

import { test } from "node:test";
import assert from "node:assert/strict";
import F from "../content/filters.js";

const person = (name, institution, country, extra = {}) => ({ name, institution, country, ...extra });
const rec = (key, extra = {}) => ({ key, title: key, abstract: "", authors: [], authorString: "", venue: "", year: 2020, citations: 10, itemType: "journalArticle", sources: ["openalex"], source: "openalex", ...extra });
const pool = () => [
	rec("cell-kim", { title: "Spatial atlas of repair", venue: "Cell", year: 2025, citations: 120, journalIF: 42, authors: [{ name: "Mina Kim" }, { name: "Alex Rivera" }], authorString: "Mina Kim, Alex Rivera",
		abstract: "A single-cell atlas of repair.", people: [person("Mina Kim", "Harvard University", "US"), person("Alex Rivera", "Stanford University", "US")], pdfUrl: "https://example.test/a.pdf" }),
	rec("sci-lee", { title: "A review of repair methods", venue: "Science", year: 2024, citations: 40, journalIF: 45, authors: [{ name: "Sora Lee" }], authorString: "Sora Lee", sources: ["crossref", "openalex"], source: "crossref",
		people: [person("Sora Lee", "Seoul National University", "KR")], workType: "review" }),
	rec("bio-kim", { title: "Preprint on repair", venue: "bioRxiv", year: 2026, citations: 2, itemType: "preprint", authors: [{ name: "Kim Mina" }], authorString: "Kim Mina", sources: ["europepmc"], source: "europepmc", people: null }),
	rec("nar-park", { title: "Guide design", venue: "Nucleic Acids Research", year: 2019, citations: null, journalIF: 13.1, authors: [{ name: "Jonas Park" }], authorString: "Jonas Park", abstract: "Guides for editing.",
		people: [person("Jonas Park", "Harvard University", "US")], arxiv: "2101.00001" })
];
const run = (records, text, rules = [], opts = {}) => records.filter(r => F.matches(r, F.compile(text, rules), { cpy: x => x.citations == null ? null : x.citations / 2 }, opts)).map(r => r.key);
const rule = (kind, mode, extra = {}) => Object.assign(F.newRule(kind, mode), extra);

test("quick syntax: words, phrases, negation, fields, aliases and ranges", () => {
	const terms = F.parseQuick('journal:Cell -author:Kim "exact phrase" -"bad one" year:2018-2022 crispr:cas9 - 저널:네이처 title:"two words"');
	assert.deepEqual(terms.map(t => [t.field, t.text, t.phrase, t.neg]), [
		["journal", "cell", false, false], ["author", "kim", false, true], [null, "exact phrase", true, false], [null, "bad one", true, true],
		["year", "2018-2022", false, false], [null, "crispr:cas9", false, false], ["journal", "네이처", false, false], ["title", "two words", true, false]]);
	assert.deepEqual(terms[4].range, { min: 2018, max: 2022 });
	assert.deepEqual(F.parseQuick("plain words here").map(t => t.text), ["plain", "words", "here"], "plain text keeps its old meaning: every word must occur");
	assert.deepEqual(F.parseQuick(""), []);
	assert.deepEqual(F.parseQuick("  - ").length, 0, "a dash being typed is not a word");
	assert.deepEqual(F.parseQuick('"unclosed phrase').map(t => [t.text, t.phrase]), [["unclosed phrase", true]], "a phrase still being typed counts");
	assert.equal(F.parseQuick("T:cell")[0].field, "title", "field names are not case sensitive");
	assert.equal(F.parseQuick("저자:Kim")[0].field, "author", "Korean field names work");
	assert.equal(F.parseQuick("e-coli")[0].neg, false, "a dash inside a word is part of it");
	assert.equal(F.parseQuick("-ase")[0].neg, true);
	for (const [text, range] of [["2020", { min: 2020, max: 2020 }], [">=2020", { min: 2020, max: null }], [">2020", { min: 2021, max: null }], ["<=2020", { min: null, max: 2020 }], ["<2020", { min: null, max: 2019 }], ["2020-", { min: 2020, max: null }], ["-2020", { min: null, max: 2020 }], ["2018..2022", { min: 2018, max: 2022 }], ["2018–2022", { min: 2018, max: 2022 }]]) {
		assert.deepEqual(F.parseRange(text), range, text);
	}
	assert.equal(F.parseRange("abc"), null);
	assert.equal(F.parseQuick("year:abc")[0].field, null, "a year that is not a range is just text");
});

test("box terms: words AND, phrases, exclusion and fielded values", () => {
	const p = pool();
	assert.deepEqual(run(p, "repair"), ["cell-kim", "sci-lee", "bio-kim"]);
	assert.deepEqual(run(p, "repair atlas"), ["cell-kim"], "every word must occur");
	assert.deepEqual(run(p, '"repair methods"'), ["sci-lee"], "a phrase is adjacent words");
	assert.deepEqual(run(p, '"methods repair"'), [], "in that order");
	assert.deepEqual(run(p, "repair -review"), ["cell-kim", "bio-kim"], "-word leaves the papers with it out");
	assert.deepEqual(run(p, "-repair"), ["nar-park"]);
	assert.deepEqual(run(p, "journal:Cell"), ["cell-kim"], "the journal field names the journal");
	assert.deepEqual(run(p, "journal:Cell -author:Kim"), [], "and -author:Kim removes Mina Kim's paper");
	assert.deepEqual(run(p, "author:kim -journal:biorxiv"), ["cell-kim"]);
	assert.deepEqual(run(p, "title:guide"), ["nar-park"]);
	assert.deepEqual(run(p, "abstract:editing"), ["nar-park"], "the abstract is searched only on request");
	assert.deepEqual(run(p, "editing"), [], "plain words do not look in the abstract, as before");
	assert.deepEqual(run(p, "year:2024-2025"), ["cell-kim", "sci-lee"]);
	assert.deepEqual(run(p, "year:>=2025"), ["cell-kim", "bio-kim"]);
	assert.deepEqual(run(p, "-year:2019"), ["cell-kim", "sci-lee", "bio-kim"]);
	assert.deepEqual(run(p, "inst:harvard"), ["cell-kim", "nar-park"], "any author's institution");
	assert.deepEqual(run(p, "inst:harvard -inst:stanford"), ["nar-park"]);
	assert.deepEqual(run(p, "country:KR"), ["sci-lee"]);
	assert.deepEqual(run(p, "country:korea"), ["sci-lee"], "a country by name");
	assert.deepEqual(run(p, "국가:미국"), ["cell-kim", "nar-park"], "and by its Korean name");
	assert.deepEqual(run(p, "MUELLER"), [], "nothing matches nothing");
	assert.equal(F.matches(p[0], F.compile("zzz", []), {}, { ignoreYears: true }), false);
	assert.equal(F.matches(p[0], F.compile("year:1999", []), {}, { ignoreYears: true }), true, "ignoreYears leaves year: terms out for the histogram");
	assert.deepEqual(run([rec("x", { title: "Müller study" })], "muller"), ["x"], "accents are not told apart");
});

test("include and exclude rules for every kind; several values mean any of them", () => {
	const p = pool();
	const cases = [
		["author", ["name:mina kim"], ["cell-kim"]],
		["author", ["name:mina kim", "name:sora lee"], ["cell-kim", "sci-lee"]],
		["journal", ["cell", "science"], ["cell-kim", "sci-lee"]],
		["inst", [F.flat("Harvard University")], ["cell-kim", "nar-park"]],
		["country", ["KR"], ["sci-lee"]],
		["type", ["preprint"], ["bio-kim"]],
		["type", ["review"], ["sci-lee"]],
		["type", ["article"], ["cell-kim", "nar-park"]],
		["type", ["article", "review"], ["cell-kim", "sci-lee", "nar-park"]],
		["source", ["europepmc"], ["bio-kim"]],
		["source", ["openalex"], ["cell-kim", "sci-lee", "nar-park"]],
		["pdf", ["yes"], ["cell-kim", "nar-park"]],
		["pdf", ["no"], ["sci-lee", "bio-kim"]],
		["text", ["atlas", "guide"], ["cell-kim", "nar-park"]]
	];
	for (const [kind, values, expected] of cases) {
		assert.deepEqual(run(p, "", [rule(kind, "include", { values })]), expected, `include ${kind} ${values}`);
		assert.deepEqual(run(p, "", [rule(kind, "exclude", { values })]), p.map(r => r.key).filter(k => !expected.includes(k)), `exclude ${kind} ${values}`);
	}
	// text rules look in the chosen field; a value with several words wants all of them, a quoted one wants them adjacent
	assert.deepEqual(run(p, "", [rule("text", "include", { field: "title", values: ["repair review"] })]), ["sci-lee"], "both words in the title, in any order");
	assert.deepEqual(run(p, "", [rule("text", "include", { field: "title", values: ['"repair review"'] })]), [], "unless it is a phrase");
	assert.deepEqual(run(p, "", [rule("text", "include", { field: "title", values: ["repair guide"] })]), [], "a word the title lacks");
	assert.deepEqual(run(p, "", [rule("text", "include", { field: "title", values: ['"review of"'] })]), ["sci-lee"]);
	assert.deepEqual(run(p, "", [rule("text", "include", { field: "abstract", values: ["single-cell"] })]), ["cell-kim"]);
	assert.deepEqual(run(p, "", [rule("text", "include", { field: "author", values: ["rivera"] })]), ["cell-kim"]);
	assert.deepEqual(run(p, "", [rule("text", "include", { field: "journal", values: ["nucleic"] })]), ["nar-park"]);
	assert.deepEqual(run(p, "", [rule("text", "include", { field: "inst", values: ["seoul", "stanford"] })]), ["cell-kim", "sci-lee"], "institution or country field");
	assert.deepEqual(run(p, "", [rule("text", "exclude", { field: "title", values: ["repair"] })]), ["nar-park"]);
});

test("range rules: years, citations, per year and journal IF, with unknown values", () => {
	const p = pool();
	assert.deepEqual(run(p, "", [rule("year", "include", { min: 2024, max: 2025 })]), ["cell-kim", "sci-lee"]);
	assert.deepEqual(run(p, "", [rule("year", "exclude", { min: 2024, max: 2025 })]), ["bio-kim", "nar-park"]);
	assert.deepEqual(run(p, "", [rule("year", "include", { min: 2025 })]), ["cell-kim", "bio-kim"], "an open end");
	assert.deepEqual(run(p, "", [rule("cites", "include", { min: 30 })]), ["cell-kim", "sci-lee"]);
	assert.deepEqual(run(p, "", [rule("cites", "exclude", { min: 30 })]), ["bio-kim", "nar-park"], "a paper with no count is not 'at least 30'");
	assert.deepEqual(run(p, "", [rule("cites", "include", { max: 10 })]), ["bio-kim"], "and not 'at most 10' either: unknown is not a number");
	assert.deepEqual(run(p, "", [rule("cpy", "include", { min: 30 })]), ["cell-kim"], "citations per year, from the environment");
	assert.deepEqual(run(p, "", [rule("if", "include", { min: 40 })]), ["cell-kim", "sci-lee"]);
	assert.deepEqual(run(p, "", [rule("if", "include", { min: 10, max: 20 })]), ["nar-park"]);
	assert.deepEqual(run(p, "", [rule("if", "exclude", { min: 10 })]), ["bio-kim"], "no figure: not excluded");
	assert.equal(F.ruleActive(rule("year", "include")), false, "a range with neither end does nothing");
	assert.equal(F.ruleActive(rule("author", "include")), false, "nor does a rule with no values");
});

test("rules combine with AND, with the box, and skipRule / ignoreYears leave some out", () => {
	const p = pool();
	const rules = [rule("journal", "exclude", { values: ["biorxiv"] }), rule("author", "include", { values: ["name:mina kim", "name:sora lee"] }), rule("year", "include", { min: 2025 })];
	assert.deepEqual(run(p, "", rules), ["cell-kim"]);
	assert.deepEqual(run(p, "repair", rules), ["cell-kim"]);
	assert.deepEqual(run(p, "-repair", rules), []);
	assert.deepEqual(run(p, "", rules, { skipRule: rules[2].id }), ["cell-kim", "sci-lee"], "one rule left out: what its option list should count against");
	assert.deepEqual(run(p, "", rules, { skipRule: "*" }), ["cell-kim", "sci-lee", "bio-kim", "nar-park"].filter(() => true), "every rule left out");
	assert.deepEqual(run(p, "", rules, { ignoreYears: true }), ["cell-kim", "sci-lee"], "year rules left out for the histogram");
	const spec = F.compile("repair", [...rules, rule("type", "include")]);
	assert.equal(spec.rules.length, 3, "an empty rule is dropped");
	assert.equal(F.compile("", []).empty, true);
});

test("option counts, kinds and the folded search of an option list", () => {
	const p = pool();
	assert.deepEqual(F.tally("journal", p).map(o => [o.label, o.n]).slice(0, 2), [["Cell", 1], ["bioRxiv", 1]].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
	assert.deepEqual(F.tally("type", p).map(o => [o.key, o.n]), [["article", 2], ["preprint", 1], ["review", 1], ["book", 0], ["other", 0]], "the five kinds, zero included");
	assert.deepEqual(F.tally("pdf", p).map(o => [o.key, o.n]), [["yes", 2], ["no", 2]]);
	assert.deepEqual(F.tally("source", p).map(o => [o.key, o.n]).sort(), [["crossref", 1], ["europepmc", 1], ["openalex", 3]]);
	assert.deepEqual(F.tally("country", p).map(o => [o.key, o.n]), [["US", 2], ["KR", 1]]);
	assert.deepEqual(F.tally("inst", p).map(o => [o.label, o.n]).slice(0, 1), [["Harvard University", 2]]);
	assert.equal(F.tally("author", p).find(o => o.label === "Mina Kim").n, 1);
	// "within the other rules": count a kind over the records the other rules leave
	const rules = [rule("year", "include", { min: 2025 })];
	const rest = p.filter(r => F.matches(r, F.compile("", rules), {}));
	assert.deepEqual(F.tally("journal", rest).map(o => o.label).sort(), ["Cell", "bioRxiv"]);
	assert.deepEqual(F.searchOptions([{ label: "Müller" }, { label: "Smith" }], "MULL").map(o => o.label), ["Müller"], "a search of the list is case and accent blind");
	assert.deepEqual(F.typeOf(rec("t", { title: "Meta-analysis of repair" })), "review", "a title that says what it is");
	assert.deepEqual(F.typeOf(rec("t", { title: "Preregistered synthesis of repair reviews" })), "article", "a word inside a title is not a review");
	assert.deepEqual(F.typeOf(rec("t", { itemType: "bookSection" })), "book");
	assert.deepEqual(F.typeOf(rec("t", { itemType: "thesis" })), "other");
	assert.deepEqual(F.typeOf(rec("t", { preprintServer: "arXiv" })), "preprint");
	assert.equal(F.hasPDF(p[3]), true, "an arXiv id is a candidate");
	assert.equal(F.KINDS.length, 12);
});

test("records completed after the first draw are read again", () => {
	const r = rec("late", { title: "Late arrival", people: null });
	assert.deepEqual(run([r], "inst:harvard"), []);
	r.people = [person("A B", "Harvard University", "US")];
	assert.deepEqual(run([r], "inst:harvard"), ["late"], "institutions that arrive later count at once");
	r.title = "Changed title";
	assert.deepEqual(run([r], "changed"), ["late"]);
});

test("country:uk resolves to GB, two-letter codes still pass through", () => {
	assert.equal(F.countryCodeFor("uk"), "GB");
	assert.equal(F.countryCodeFor("UK"), "GB");
	assert.equal(F.countryCodeFor("kr"), "KR");
	assert.equal(F.countryCodeFor("England"), "GB");
});

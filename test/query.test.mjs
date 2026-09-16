import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import Q from "../content/query.js";

const liu = { firstName: "David R", lastName: "Liu", name: "David R Liu" };
const sung = { firstName: "Jae Yoon", lastName: "Sung", name: "Jae Yoon Sung" };
const title = "Programmable editing of a target base in genomic DNA without double-stranded DNA cleavage";
const candidate = (extra = {}) => ({ title, doi: "10.1038/nature17946", year: 2016, authors: [liu], ...extra });

test("loads in Gecko without CommonJS and exposes the same pure helpers", () => {
	const context = vm.createContext({});
	vm.runInContext(fs.readFileSync(new URL("../content/query.js", import.meta.url), "utf8"), context);
	assert.deepEqual(Object.keys(context.ZotPoPQuery), Object.keys(Q));
	assert.equal(context.ZotPoPQuery.matchesAuthor("Liu DR", [liu]), true);
});

test("author matching accepts initials, given/family order and punctuation", () => {
	for (const query of ["Liu", "David R Liu", "Liu David R", "Liu, David R", "D R Liu", "Liu DR", "D.R. Liu", "D Liu"]) {
		assert.equal(Q.matchesAuthor(query, [liu]), true, query);
	}
	for (const query of ["Sung JY", "J.Y. Sung", "Sung, Jae-Yoon", "Jae Yoon Sung"]) {
		assert.equal(Q.matchesAuthor(query, [sung]), true, query);
	}
	assert.equal(Q.matchesAuthor("David R Liu", [{ firstName: "DR", lastName: "Liu" }]), true);
	assert.equal(Q.matchesAuthor("David Liu", [{ firstName: "D R", lastName: "Liu" }]), true);
	assert.equal(Q.matchesAuthor("David Liu", [{ firstName: "DR", lastName: "Liu" }]), true);
	assert.equal(Q.matchesAuthor("Jae Yoon Sung", ["Sung JY"]), true);
});

test("author matching keeps surname boundaries and conflicting full names", () => {
	for (const query of ["Li", "Daniel R Liu", "David Q Liu", "Liu DP", "Sung JY"]) assert.equal(Q.matchesAuthor(query, [liu]), false, query);
	assert.equal(Q.matchesAuthor("David", [liu]), false, "a given name alone is not a surname match");
	assert.equal(Q.matchesAuthor("JOHN Smith", [{ firstName: "Jane", lastName: "Smith" }]), false);
	assert.equal(Q.matchesAuthor("David Liu", [{ lastName: "Liu" }]), false, "missing given metadata cannot verify it");
	assert.equal(Q.matchesAuthor("DR Liu", [{ firstName: "David", lastName: "Liu" }]), false, "an explicitly requested middle initial needs evidence");
});

test("author matching supports accents, particles and non-Latin names", () => {
	assert.equal(Q.matchesAuthor("Garcia Marquez G", [{ firstName: "Gabriel", lastName: "García Márquez" }]), true);
	assert.equal(Q.matchesAuthor("ONeill J", [{ firstName: "John", lastName: "O’Neill" }]), true);
	assert.equal(Q.matchesAuthor("Waals JD", ["Johannes Diderik van der Waals"]), true);
	assert.equal(Q.matchesAuthor("van der Waals, J D", ["van der Waals J D"]), true);
	assert.equal(Q.matchesAuthor("김민수", [{ lastName: "김민수" }]), true);
	assert.equal(Q.matchesAuthor("김민수", [{ lastName: "김민석" }]), false);
	assert.equal(Q.matchesAuthor("김민수", [{ lastName: "김", firstName: "민수" }]), true);
	assert.equal(Q.matchesAuthor("张三", [{ lastName: "张", firstName: "三" }]), true);
	assert.equal(Q.matchesAuthor("张三", [{ lastName: "张", firstName: "四" }]), false);
	assert.equal(Q.matchesAuthor("はら", [{ lastName: "ばら" }]), false, "Japanese voicing marks are not optional Latin accents");
	assert.equal(Q.matchesAuthor("कुमार", [{ lastName: "कुमीर" }]), false, "Indic vowel marks distinguish names");
});

test("author expressions implement explicit AND, OR, semicolons and grouping", () => {
	assert.equal(Q.matchesAuthor('"Sung JY" AND "Liu DR"', [sung, liu]), true);
	assert.equal(Q.matchesAuthor("Sung JY and Liu DR", [sung]), false);
	assert.equal(Q.matchesAuthor("Sung JY; Liu DR", [sung, liu]), true);
	assert.equal(Q.matchesAuthor("Sung JY OR Liu DR", [liu]), true);
	assert.equal(Q.matchesAuthor('(Sung JY OR Kim) AND "Liu DR"', [liu]), false);
	assert.equal(Q.matchesAuthor('(Sung JY OR Kim) AND "Liu DR"', [sung, liu]), true);
	assert.equal(Q.matchesAuthor("Liu DR AND NOT Sung JY", [liu]), true);
	assert.equal(Q.matchesAuthor("Liu DR AND", [liu]), false);
	assert.equal(Q.matchesAuthor("(Liu DR OR Sung JY", [liu]), false);
});

test("author compilation formats whole names and preserves Boolean grouping", () => {
	const atom = name => 'author:"' + name + '"';
	assert.equal(Q.compileAuthors("David Liu OR Alice Smith", atom), '(author:"David Liu" OR author:"Alice Smith")');
	assert.equal(Q.compileAuthors('"Liu, David R"; "Sung JY"', atom), '(author:"Liu, David R" AND author:"Sung JY")');
	assert.equal(Q.compileAuthors('"Liu DR" "Sung JY"', atom), '(author:"Liu DR" AND author:"Sung JY")');
	assert.equal(Q.compileAuthors("Liu OR Sung AND Kim", atom), '(author:"Liu" OR (author:"Sung" AND author:"Kim"))');
	assert.equal(Q.compileAuthors("(Liu OR Sung) AND Kim", atom), '((author:"Liu" OR author:"Sung") AND author:"Kim")');
	assert.equal(Q.compileAuthors("Liu AND NOT (Sung OR Kim)", atom), '(author:"Liu" AND (NOT (author:"Sung" OR author:"Kim")))');
	assert.equal(Q.compileAuthors("NOT Liu", atom), '(NOT author:"Liu")');
	assert.equal(Q.compileAuthors("Liu and Sung or Kim", atom), '((author:"Liu" AND author:"Sung") OR author:"Kim")');
	assert.equal(Q.compileAuthors("", atom), "");
});

test("author compiler leaves atom escaping to callers and calls each atom once", () => {
	const seen = [];
	const input = '"Research AND Development" OR "O\\"Neill J"';
	const compiled = Q.compileAuthors(input, name => { seen.push(name); return JSON.stringify(name); });
	assert.deepEqual(seen, ["Research AND Development", 'O"Neill J']);
	assert.equal(compiled, '("Research AND Development" OR "O\\"Neill J")');
	const distributed = [];
	Q.compileAuthors("Liu AND (Sung OR NOT Kim)", name => { distributed.push(name); return name; }, { notOperator: "ANDNOT" });
	assert.deepEqual(distributed, ["Liu", "Sung", "Kim"]);
});

test("ANDNOT compilation retains exclusion logic under nested groups", () => {
	const atom = name => "au:" + name;
	const options = { notOperator: "ANDNOT" };
	assert.equal(Q.compileAuthors("Liu AND NOT (Sung OR Kim)", atom, options), '(au:Liu ANDNOT (au:Sung OR au:Kim))');
	assert.equal(Q.compileAuthors("Liu ANDNOT Sung", atom, options), '(au:Liu ANDNOT au:Sung)');
	assert.equal(Q.compileAuthors("NOT Sung AND Liu", atom, options), '(au:Liu ANDNOT au:Sung)');
	assert.equal(Q.compileAuthors("Liu AND (Sung OR NOT Kim)", atom, options), '((au:Liu AND au:Sung) OR (au:Liu ANDNOT au:Kim))');
	assert.equal(Q.compileAuthors("NOT NOT Liu", atom, options), "au:Liu");
});

test("PubMed binary NOT compilation emits fielded exclusions with valid grouping", () => {
	const atom = name => '"' + name + '"[au]';
	const options = { binaryNot: true };
	assert.equal(Q.compileAuthors('(Liu DR OR Sung JY) AND NOT "Kim J"', atom, options), '(("Liu DR"[au] OR "Sung JY"[au]) NOT "Kim J"[au])');
	assert.equal(Q.compileAuthors("Liu AND (Sung OR NOT Kim)", atom, options), '(("Liu"[au] AND "Sung"[au]) OR ("Liu"[au] NOT "Kim"[au]))');
	assert.equal(Q.compileAuthors("NOT Sung AND Liu", atom, options), '("Liu"[au] NOT "Sung"[au])');
	assert.equal(Q.compileAuthors("Liu ANDNOT Sung", atom, options), '("Liu"[au] NOT "Sung"[au])');
	assert.equal(Q.compileAuthors('"ANDNOT Consortium" AND NOT Liu', atom, options), '("ANDNOT Consortium"[au] NOT "Liu"[au])', "atom text is not rewritten with the operator");
	assert.equal(Q.compileAuthors("Liu AND NOT Sung", atom), '("Liu"[au] AND (NOT "Sung"[au]))', "Lucene-style default is unchanged");
});

test("compilation and matching agree on every author combination", () => {
	const names = ["Liu", "Sung", "Kim"];
	const cases = [
		["Liu OR Sung AND Kim", (a, b, c) => a || (b && c)],
		["(Liu OR Sung) AND Kim", (a, b, c) => (a || b) && c],
		["Liu AND NOT (Sung OR Kim)", (a, b, c) => a && !(b || c)],
		["Liu AND (Sung OR NOT Kim)", (a, b, c) => a && (b || !c)],
		["NOT Sung AND Liu", (a, b) => !b && a],
		["NOT (NOT Liu OR Sung)", (a, b) => !(!a || b)],
		['"Liu" "Sung"', (a, b) => a && b]
	];
	for (const [query, expected] of cases) {
		for (const options of [{}, { notOperator: "ANDNOT" }, { binaryNot: true }]) {
			const compiled = Q.compileAuthors(query, name => JSON.stringify(name), options);
			for (let mask = 0; mask < 8; mask++) {
				const present = names.map((_, i) => Boolean(mask & (1 << i)));
				const authors = names.filter((_, i) => present[i]).map(lastName => ({ lastName }));
				authors.push({ lastName: "Other" }); // Known byline even when none of the queried names occur.
				assert.equal(Q.matchesAuthor(query, authors), expected(...present), query + " / " + mask);
				assert.equal(Q.matchesAuthor(compiled, authors), expected(...present), query + " → " + compiled + " / " + mask);
			}
		}
	}
});

test("ANDNOT compiler preserves compact positive groups and bounds exclusion expansion", () => {
	const manyGroups = Array(9).fill("(Liu OR Sung)").join(" AND ");
	assert.doesNotThrow(() => Q.compileAuthors(manyGroups + " AND NOT Kim", name => name, { notOperator: "ANDNOT" }));
	const mixedGroups = "Liu AND " + Array(8).fill("(Sung OR NOT Kim)").join(" AND ");
	let called = false;
	assert.throws(() => Q.compileAuthors(mixedGroups, name => { called = true; return name; }, { notOperator: "ANDNOT" }), /too complex/);
	assert.equal(called, false, "reject unsupported expansion before constructing backend atoms");
});

test("invalid author expressions fail clearly before formatting or broadening a request", () => {
	for (const query of ["Liu AND", "OR Liu", "Liu OR OR Sung", "(Liu OR Sung", "Liu)", '"Liu', '""', "Liu;;Sung", "()", "NOT"]) {
		let called = false;
		assert.throws(() => Q.compileAuthors(query, () => { called = true; return "field"; }), { name: "SyntaxError" }, query);
		assert.equal(called, false, query);
		assert.equal(Q.matchesAuthor(query, [liu, sung]), false, query);
	}
	for (const query of ["NOT Liu", "Liu OR NOT Sung", "NOT (Liu OR Sung)"]) {
		for (const options of [{ notOperator: "ANDNOT" }, { binaryNot: true }]) {
			let called = false;
			assert.throws(() => Q.compileAuthors(query, name => { called = true; return name; }, options), /positive author name/);
			assert.equal(called, false, "reject unanchored exclusions before formatting");
		}
	}
	assert.throws(() => Q.compileAuthors("Liu", null), { name: "TypeError" });
	assert.throws(() => Q.compileAuthors("Liu", () => ""), { name: "TypeError" });
	assert.throws(() => Q.compileAuthors("Liu", name => name, { notOperator: "INVALID" }), { name: "RangeError" });
});

test("title matching distinguishes words, contiguous phrases and literal lowercase negation", () => {
	assert.equal(Q.matchesTitle("genome editing", "Editing the human genome"), true);
	assert.equal(Q.matchesTitle('"genome editing"', "Editing the human genome"), false);
	assert.equal(Q.matchesTitle('"genome editing"', "Precise genome-editing methods"), true);
	assert.equal(Q.matchesTitle("editing", "Methods for preediting"), false);
	assert.equal(Q.matchesTitle('"does not increase"', "The treatment does increase survival"), false);
	assert.equal(Q.matchesTitle("does not increase", "The treatment does increase survival"), false);
	assert.equal(Q.matchesTitle("Cas9", "Cas12 editing"), false);
	assert.equal(Q.matchesTitle('"dose 10"', "Dose 100 was effective"), false);
	assert.equal(Q.matchesTitle('"한국어 연구"', "새로운 한국어 연구 방법"), true);
});

test("title expressions preserve Boolean branches without treating keywords as required title fields", () => {
	assert.equal(Q.matchesTitle('(CRISPR OR recombinase) AND editing NOT cancer', "Recombinase editing methods"), true);
	assert.equal(Q.matchesTitle('(CRISPR OR recombinase) AND editing NOT cancer', "CRISPR editing in cancer"), false);
	assert.equal(Q.matchesTitle('"CRISPR AND editing"', "CRISPR AND editing"), true);
	assert.equal(Q.matchesTitle('"unclosed phrase', "unclosed phrase"), false);
	assert.equal(Q.matchesRecord({ title: "Unrelated title", authors: [] }, { keywords: "term only present in full text" }), true);
});

test("journal matching accepts exact titles, abbreviations, acronyms and ISSNs without journal families", () => {
	assert.equal(Q.matchesVenue("Nature", { venue: "Nature" }), true);
	assert.equal(Q.matchesVenue("Nature", { venue: "Nature Communications" }), false);
	assert.equal(Q.matchesVenue("Nature Communications", { venue: "Nature" }), false);
	assert.equal(Q.matchesVenue("Cell", { venue: "Cells" }), false);
	assert.equal(Q.matchesVenue("Cell", { venue: "Cellular" }), false);
	assert.equal(Q.matchesVenue("Science", { venue: "Sciences" }), false);
	assert.equal(Q.matchesVenue("J. Biol. Chem.", { venue: "Journal of Biological Chemistry" }), true);
	assert.equal(Q.matchesVenue("Journal of Biological Chemistry", { venue: "J Biol Chem" }), true);
	assert.equal(Q.matchesVenue("NAR", { venue: "Nucleic Acids Research" }), true);
	assert.equal(Q.matchesVenue("NAR", { venue: "Nucleic Acids Review" }), true, "acronyms alone remain ambiguous");
	assert.equal(Q.matchesVenue("Nat Commun", { venue: "Nature Communications" }), true);
	assert.equal(Q.matchesVenue("Nature", { publisher: "Nature" }), false);
	assert.equal(Q.matchesVenue("0028-0836", { venue: "Nature", issn: "00280836" }), true);
	assert.equal(Q.matchesVenue("Nature OR Cell", { venue: "Cell" }), true);
	assert.equal(Q.matchesVenue("Journal of Bone and Joint Surgery", { venue: "Journal of Bone and Joint Surgery" }), true);
});

test("explicit fields and year bounds combine; missing required metadata does not pass", () => {
	const record = { title: "Genome editing", authors: [liu], venue: "Nature", year: 2016 };
	assert.equal(Q.matchesRecord(record, { authors: "Liu DR", title: '"genome editing"', venue: "Nature", yearFrom: 2016, yearTo: 2016 }), true);
	for (const query of [{ authors: "Liu DQ" }, { title: '"base editing"' }, { venue: "Nature Communications" }, { yearFrom: 2017 }, { yearTo: 2015 }]) assert.equal(Q.matchesRecord(record, query), false);
	assert.equal(Q.matchesRecord({ title: "Genome editing" }, { authors: "Liu" }), false);
	assert.equal(Q.matchesRecord({ title: "Genome editing" }, { yearFrom: 2010 }), false);
	assert.equal(Q.matchesRecord({ publicationDate: "2025-03-10" }, { yearFrom: 2025, yearTo: 2025 }), true);
	assert.equal(Q.matchesRecord(record, {}), true);
	assert.equal(Q.matchesRecord(record, { yearFrom: "not-a-year" }), false);
	assert.equal(Q.matchesRecord({ title: "A", year: Infinity }, { yearFrom: 2025 }), false);
});

test("negated explicit fields cannot be verified from absent metadata", () => {
	assert.equal(Q.matchesAuthor("NOT Liu", []), false);
	assert.equal(Q.matchesAuthor("NOT Liu", [{}]), false);
	assert.equal(Q.matchesTitle("NOT cancer", ""), false);
	assert.equal(Q.matchesVenue("NOT Nature", {}), false);
	assert.equal(Q.matchesAuthor("", []), true);
	assert.equal(Q.matchesTitle("", ""), true);
	assert.equal(Q.matchesVenue("", {}), true);
});

test("safe DOI matching accepts complete titles with typography, markup and online-year differences", () => {
	assert.equal(Q.isSafeDOIMatch({ title, year: 2016 }, candidate()), true);
	assert.equal(Q.isSafeDOIMatch({ title: title.replace("double-stranded", "double stranded") + ".", year: 2017, authors: [liu] }, candidate()), true);
	assert.equal(Q.isSafeDOIMatch({ title: "<i>Café</i> research &amp; a new genome-editing technique" }, candidate({ title: "Cafe research and a new genome editing technique" })), true);
	assert.equal(Q.isSafeDOIMatch({ title: "CR<i>IS</i>PR research &amp; a new genome-editing technique" }, candidate({ title: "CRISPR research and a new genome editing technique" })), true);
	assert.equal(Q.isSafeDOIMatch({ title, doi: "https://doi.org/10.1038/NATURE17946" }, candidate()), true);
});

test("safe DOI matching rejects negation and opposite conclusions despite nearly identical words", () => {
	for (const [a, b] of [
		["Treatment does not increase survival in human cells", "Treatment does increase survival in human cells"],
		["Treatment increases survival in human cells", "Treatment decreases survival in human cells"],
		["Editing without double stranded DNA cleavage", "Editing with double stranded DNA cleavage"],
		["A regulates B in living cells", "B regulates A in living cells"]
	]) assert.equal(Q.isSafeDOIMatch({ title: a }, candidate({ title: b })), false, a);
});

test("safe DOI matching retains numeric, statistical and scientific sign distinctions", () => {
	for (const [a, b] of [
		["Drug dose 10 improves long term survival", "Drug dose 100 improves long term survival"],
		["Mutation effects with p < 0.05 in living cells", "Mutation effects with p > 0.05 in living cells"],
		["Mutation effects with p = 0.05 in living cells", "Mutation effects with p = 0.5 in living cells"],
		["Mutation effects with p != 0.05 in living cells", "Mutation effects with p = 0.05 in living cells"],
		["Mutation effects with p ≠ 0.05 in living cells", "Mutation effects with p = 0.05 in living cells"],
		["Mutation effects with x ∉ S in living cells", "Mutation effects with x ∈ S in living cells"],
		["Mutation effects with x<y>z in living cells", "Mutation effects with x<w>z in living cells"],
		["Mutation effects with x^2 in living cells", "Mutation effects with x2 in living cells"],
		["Growth measured at -5 degrees in culture", "Growth measured at 5 degrees in culture"],
		["CD4+ cells regulate the immune response", "CD4- cells regulate the immune response"],
		["Mutation effects at 5% prevalence in populations", "Mutation effects at 5 prevalence in populations"]
	]) assert.equal(Q.isSafeDOIMatch({ title: a }, candidate({ title: b })), false, a);
});

test("safe DOI matching rejects conflicting identifiers, authors, years and unsupported title variants", () => {
	assert.equal(Q.isSafeDOIMatch({ title }, candidate({ doi: "not-a-doi" })), false);
	assert.equal(Q.isSafeDOIMatch({ title, doi: "10.1234/other" }, candidate()), false);
	assert.equal(Q.isSafeDOIMatch({ title, year: 2024 }, candidate()), false);
	assert.equal(Q.isSafeDOIMatch({ title, authors: [sung] }, candidate()), false);
	assert.equal(Q.isSafeDOIMatch({ title, pmid: "1" }, candidate({ pmid: "2" })), false);
	assert.equal(Q.isSafeDOIMatch({ title, arxiv: "1234.5678v2" }, candidate({ arxiv: "1234.5678" })), true);
	assert.equal(Q.isSafeDOIMatch({ title: title + ": a new review" }, candidate()), false);
	assert.equal(Q.isSafeDOIMatch({ title: "" }, candidate({ title: "" })), false);
});

test("short and generic titles require corroborating year and author metadata", () => {
	for (const short of ["Editorial", "Introduction", "Base editing"]) {
		assert.equal(Q.isSafeDOIMatch({ title: short }, candidate({ title: short })), false, short);
		assert.equal(Q.isSafeDOIMatch({ title: short, year: 2016, authors: [liu], venue: "Nature" }, candidate({ title: short, venue: "Nature" })), true, short);
		assert.equal(Q.isSafeDOIMatch({ title: short, year: 2016, authors: [liu], venue: "Nature" }, candidate({ title: short, venue: "Cell" })), false, short);
	}
	assert.equal(Q.isSafeDOIMatch({ title: "Editorial", year: 2016, authors: [{}] }, candidate({ title: "Editorial", authors: [{}] })), false);
});

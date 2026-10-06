/* The glossary in docs/wording.md, enforced. One word per concept in each language:
   a researcher who reads "Owned" in the toolbar, "held" in a chip and "in library" in a
   tooltip has to stop and ask whether they are three different things. Both string
   tables are scanned, as source text for functions (so a literal inside a branch is
   seen) and as their output. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import I18N from "../content/i18n.js";

const en = I18N.STRINGS.en, ko = I18N.STRINGS.ko;
const text = value => Array.isArray(value) ? value.join(",") : typeof value === "function" ? value.toString() : String(value);
const scan = (table, rule, except = []) => Object.entries(table).filter(([key, value]) => !except.includes(key) && rule.test(text(value))).map(([key]) => key);

/* [what to use, forbidden variant, keys exempt with a reason] */
const EN_RULES = [
	["in library / not in library", /\b(?:Not owned|Owned|owned|held|you hold|holds this)\b/],
	["paper (not publication, work)", /\bpublications\b|\bwork groups?\b|"work"\)/i],
	["citations (not cites, as a noun)", /\bCites\b|\} cites\b|\bcites\)|"cite"\)/],
	["JIF (not IF)", /(?<![A-Za-z])IF(?![A-Za-z])/],
	["Settings (Zotero 7+ names it so)", /\bPreferences\b/],
	["add (not import)", /\bimport(?:ed|ing)?\b|\bfor import\b/i],
	["detail pane (not detail card)", /\bdetail card\b|\bthe paper's detail\b/],
	["follow (not watch)", /\bwatch(?:ed|ing|list)?\b/i],
	["Max results (the field's own name, not result limit)", /\bresult limit\b/i],
	["Journal (the field and column, not Publication)", /\bPublication(?! years?| or Perish)\b/],
	["no API names in prose (API key is fine)", /\bAPIs\b|\bAPI(?! key)\b|\bHTTP \d{3}\b|\(429\)|\bendpoint\b/],
	["no title case", /Search & Import Papers/]
];
const KO_RULES = [
	["검색원 (not 검색 소스, 소스)", /검색 소스|(?<![가-힣A-Za-z])소스(?![가-힣])|소스[를가에의는도]/],
	["논문 (not 문헌, 실적)", /(?<!참고|인용 )문헌|실적/],
	["-세요 (not -십시오)", /십시오/],
	["더 보기 (with a space)", /더보기/],
	["상세 패널 (not 상세 창, 상세 카드)", /상세 창|상세 카드/],
	["JIF (not IF)", /(?<![A-Za-z])IF(?![A-Za-z])/],
	["설정 (not 환경설정)", /환경설정/],
	["추가 (not 가져오기, 가져옴)", /가져오기|가져옴/],
	["관심 저자 (not 팔로우)", /팔로우|팔로잉/],
	["저널 (not 학술지)", /학술지/],
	["no jargon", /엔드포인트|UTC 자정|자정\s*\(UTC\)|API 사용량|\(429\)/],
	["최대 결과 수 (not 결과 상한)", /결과 상한/]
];

for (const [use, rule, except = []] of EN_RULES) {
	test(`English: ${use}`, () => assert.deepEqual(scan(en, rule, except), []));
}
for (const [use, rule, except = []] of KO_RULES) {
	test(`Korean: ${use}`, () => assert.deepEqual(scan(ko, rule, except), []));
}

test("the glossary file names every rule the test enforces", () => {
	const doc = readFileSync(new URL("../docs/wording.md", import.meta.url), "utf8");
	for (const [use] of [...EN_RULES, ...KO_RULES]) {
		const head = use.split(" (")[0];
		assert.ok(doc.toLowerCase().includes(head.toLowerCase()), `docs/wording.md should explain "${head}"`);
	}
});

test("English labels are in sentence case", () => {
	const PROPER = /^(?:Zotero|ZotPoP|OpenAlex|ORCID|PubMed|Google|Scholar|Crossref|Europe|PMC|Semantic|DOI|PDFs?|CSV|JIF|JCR|PoP|Publish|Perish|LinkedIn|Style|Custom|Extra|Translate|GitHub|API|URL|IDs?|iD|Enter|Esc|Space|Shift|NCBI|AND|OR|NOT|Yonsei|CAPTCHA|JSON|Unpaywall|Research|Square|Library|English)$/;
	const bad = Object.entries(en).filter(([, value]) => typeof value === "string" && value.length < 60 && !/[.;?!](?:\s|$)/.test(value))
		.filter(([, value]) => value.split(/\s+[—·]\s+/).some(part => part.split(/\s+/).slice(1).some(word => /^[A-Z][a-z]/.test(word) && !PROPER.test(word.replace(/[^\w-]/g, "")))))
		.map(([key, value]) => `${key}: ${value}`);
	assert.deepEqual(bad, []);
});

/* What a user can do next. Every error in Korean ends in what to do (-세요); the English
   says it too, as a second clause after the cause. */
const ERROR_KEYS = ["searchFailed", "searchOffline", "csvSaveFailed", "citeCheckFailed", "trFailed", "loginCheckFailed", "updateStatusError",
	"queueFailed", "watchAuthorFail", "authorSummaryFail", "relLibraryFailed", "relFailed", "relBudget", "historyMissing", "authorNoProfiles",
	"prefJcrBroken", "notJSON", "readLocalFailed", "previewFailed", "loginNeeded", "needSources", "needCriteria", "badYear", "badYearOrder",
	"badLimit", "popRawConflict", "openAlexQuota", "pinGone", "proxyNotSet", "importFailures", "importFailuresPdf", "trNone", "relNeedsLibrary",
	"authorNeedInput", "authorNeedName", "authorModuleUnavailable", "citeFailed", "noResults", "emptyAfterSearch"];
const sample = value => typeof value === "function" ? String(value("X", 2, 3, 4)) : value;

test("every Korean error says what to do (-세요)", () => {
	const keys = [...ERROR_KEYS, ...Object.keys(ko).filter(key => /^err[A-Z]/.test(key))];
	assert.deepEqual(keys.filter(key => !(key in ko)), [], "listed error keys exist");
	assert.deepEqual(keys.filter(key => !/세요/.test(sample(ko[key]))), []);
});

test("every English error goes on to say what to do", () => {
	const keys = [...ERROR_KEYS, ...Object.keys(en).filter(key => /^err[A-Z]/.test(key))];
	const NEXT = /\b(?:try|check|press|choose|pick|enter|use|add|open|set|sign in|swap|clear|select|run|install|leave|restart|switch|raise|wait|type|reopen|search)\b/i;
	assert.deepEqual(keys.filter(key => !NEXT.test(sample(en[key]).split(/[:—]\s/).slice(-1)[0] + " " + sample(en[key]))), []);
	// A bare "failed: <detail>" is not enough: something follows the detail.
	assert.deepEqual(keys.filter(key => /:\s*X\.?$/.test(sample(en[key])) || /:\s*X\.?$/.test(sample(ko[key]))), []);
});

/* Counts are grouped in Korean as in English: "1,200편", never "1200편". Years are not counts. */
test("Korean counts group their digits like the English ones", () => {
	const COUNT = /^(?:n|total|loaded|shown|added|rows|ranked|count|c1|c2|shared|exists|failed|pdfs|on|off|unowned|cut|unknown|done|i|pdf|change)$/;
	const bad = [];
	for (const [key, value] of Object.entries(ko)) {
		if (typeof value !== "function") continue;
		const src = value.toString(), params = src.slice(0, src.indexOf("=>")).replace(/[()\s]/g, "").split(",").filter(Boolean);
		params.forEach((param, at) => {
			if (!COUNT.test(param)) return;
			const args = params.map((p, j) => j === at ? 12345 : COUNT.test(p) ? 2 : "x");
			let out; try { out = String(value(...args)); } catch { return; }
			if (out.includes("12345")) bad.push(`${key}(${param}): ${out}`);
		});
	}
	assert.deepEqual(bad, []);
});

/* The CSV column that holds an institution's h-index says so; an author's own h-index is a different figure. */
test("CSV headers name what the column holds", () => {
	assert.ok(en.csvHead.includes("FirstAuthorInstitutionHIndex") && en.csvHead.includes("CorrespondingInstitutionHIndex"));
	assert.ok(!en.csvHead.includes("FirstAuthorHIndex") && !en.csvHead.includes("CorrespondingHIndex"));
	assert.ok(ko.csvHead.includes("1저자 기관 h-index") && ko.csvHead.includes("교신저자 기관 h-index"));
	assert.equal(en.csvHead.length, ko.csvHead.length);
	assert.equal(new Set(en.csvHead).size, en.csvHead.length, "no two English columns share a name");
	assert.equal(new Set(ko.csvHead).size, ko.csvHead.length, "no two Korean columns share a name");
});

/* Raw errors from the sources (English, with status codes and host names) become a sentence in
   the window's language that names the service and what to do. */
test("source errors are explained in the window's language", () => {
	const ex = I18N.explainError;
	assert.equal(typeof ex, "function");
	const k = ex("HTTP 503 · api.openalex.org", "ko");
	assert.match(k, /OpenAlex/); assert.match(k, /세요/); assert.doesNotMatch(k, /api\.openalex\.org|HTTP/);
	assert.match(ex("HTTP 503 · api.openalex.org", "en"), /OpenAlex.*(?:try|again)/i);
	assert.match(ex("HTTP 429 · api.semanticscholar.org", "ko"), /Semantic Scholar.*요청/);
	assert.match(ex("HTTP 403 · eutils.ncbi.nlm.nih.gov", "en"), /PubMed/);
	assert.match(ex("Start year must not exceed end year", "ko"), /시작 연도/);
	assert.match(ex("Author identifiers require OpenAlex or Combined search", "ko"), /OpenAlex|통합 검색/);
	assert.match(ex("Semantic Scholar relevance search does not support Boolean or quoted expressions; use OpenAlex, PubMed, Europe PMC or arXiv for that query", "ko"), /Semantic Scholar.*세요/);
	assert.match(ex("PubMed rejected the query: bad field", "ko"), /PubMed.*bad field.*세요/);
	assert.match(ex("Enter a valid Google Scholar profile URL or 12-character profile ID", "ko"), /Google Scholar.*세요/);
	assert.match(ex("All search sources failed: OpenAlex: HTTP 503 · api.openalex.org / Crossref: HTTP 500 · api.crossref.org", "ko"), /OpenAlex.*Crossref.*세요/);
	// A partial-failure list keeps each source's name, explained.
	assert.match(ex("Crossref: HTTP 500 · api.crossref.org", "ko"), /^Crossref/);
	// Unknown text is left as it is, never swallowed.
	assert.equal(ex("Something odd", "ko"), "Something odd");
	// English messages already written for the user stay English in English.
	assert.equal(ex("Something odd", "en"), "Something odd");
});

test("the window explains errors before showing them", () => {
	const ui = readFileSync(new URL("../content/ui.js", import.meta.url), "utf8");
	assert.doesNotMatch(ui, /t\("searchFailed", (?:error|e)\.message \|\| (?:error|e)\)/, "searchFailed gets the explained text");
	assert.doesNotMatch(ui, /t\("partialFail", ctx\.errors\.join/, "partialFail gets the explained list");
	assert.doesNotMatch(ui, /t\("notJSON", url/, "notJSON names the service, not the URL");
});

/* Round 14, from the outside review: wording that said something untrue. */
test("author cards pass numbers, so the counts read 1,200 papers, not NaN", () => {
	const ui = readFileSync(new URL("../content/ui.js", import.meta.url), "utf8");
	assert.doesNotMatch(ui, /t\("authorStat(?:Works|Cited)", Number\([^)]*\)\.toLocaleString/);
	assert.equal(en.authorStatWorks(1200), "1,200 papers");
	assert.equal(ko.authorStatCited(1200), "인용 1,200");
});

test("progress lines from the sources are in the window's language", () => {
	const lp = I18N.localizeProgress;
	assert.equal(typeof lp, "function");
	assert.match(lp("Citation counts: 50 / 120", "ko"), /^인용 수 조회 중: 50 \/ 120$/);
	assert.match(lp("Journal metrics: 3 / 9", "ko"), /^저널 지표 조회 중/);
	assert.match(lp("Institutions: 50 / 70", "ko"), /^소속 기관 조회 중/);
	assert.match(lp("2/3 · Citation counts: 50 / 120", "ko"), /^2\/3 · 인용 수 조회 중/);
	assert.match(lp("Publish or Perish: searching…", "ko"), /검색 중/);
	assert.match(lp("Crossref: 120 results", "ko"), /Crossref: 120편/);
	assert.match(lp("Citation counts: 50 / 120", "en"), /^Loading citation counts: 50 \/ 120$/);
	assert.equal(lp("OpenAlex: 50 / 200", "ko"), "OpenAlex: 50 / 200");
	const ui = readFileSync(new URL("../content/ui.js", import.meta.url), "utf8");
	for (const m of ui.matchAll(/onProgress: \(msg, n, total\) => \{[^}]*\}/g)) assert.match(m[0], /progressText\(msg\)/, "the raw progress text is not shown");
});

test("the PDF-missed tip says how to retry, not that adding again duplicates", () => {
	for (const table of [en, ko]) assert.doesNotMatch(table.tipPdfMissed, /would make a second copy|두 개가 됩니다/);
	assert.match(en.tipPdfMissed, /Fill a missing PDF/);
	assert.doesNotMatch(en.optSkip, /by DOI\)/);
	assert.match(ko.optSkip, /제목/);
});

test("the affiliation column names the last author as the stand-in", () => {
	assert.match(en.thInstTip, /last author/); assert.match(ko.thInstTip, /마지막 저자/);
	assert.doesNotMatch(en.thInstTip, /the first author when none is named/);
});

test("a failed abstract lookup and a missing reference list each get their own message", () => {
	const ui = readFileSync(new URL("../content/ui.js", import.meta.url), "utf8");
	assert.match(ui, /abstractFailed\.has\(r\.key\) \? t\("abstractLoadFailed"\)/);
	assert.match(en.abstractLoadFailed, /PubMed/); assert.match(ko.abstractLoadFailed, /세요/);
	assert.match(ui, /"no-known-held"[^\n]*relNoReferences|relNoReferences[^\n]*"no-known-held"/);
	assert.match(ko.relNoReferences, /세요/);
	assert.doesNotMatch(en.citeCheckNone, /no DOI/);
});

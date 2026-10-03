import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const i18n = require("../src/i18n.js");
const strings = require("../src/strings.js");

test("the Korean text is the key, so an untranslated string still reads", () => {
  /* Every string here was written in Korean at over a thousand call sites.
     Inventing a key for each one and rewriting the call site would have been a
     thousand chances to break a working panel for no behavioural gain. */
  i18n.load(strings.en);
  i18n.use("en-US");
  assert.equal(i18n.t("보유 문헌"), "Library");
  assert.equal(i18n.t("번역되지 않은 문장입니다"), "번역되지 않은 문장입니다",
    "a gap reads as Korean rather than as a blank");
  i18n.use("ko-KR");
  assert.equal(i18n.t("보유 문헌"), "보유 문헌");
});

test("Korean costs nothing: the table is not consulted at all", () => {
  i18n.load({"x": "y"});
  i18n.use("ko-KR");
  // The item tree asks for text on the path every cell takes.
  assert.equal(i18n.t("x"), "x");
  i18n.use("en-US");
  assert.equal(i18n.t("x"), "y");
  i18n.load(strings.en);
});

test("English is the default: nothing set, empty or unknown is English", () => {
  i18n.load(strings.en);
  assert.equal(i18n.DEFAULT, "en-US");
  assert.equal(i18n.use(undefined, {locale: "ko-KR"}), "en-US", "a preference that was never set is English, even in a Korean Zotero");
  assert.equal(i18n.use("", {locale: "ko-KR"}), "en-US");
  assert.equal(i18n.use(null), "en-US");
  assert.equal(i18n.use("fr-FR", {locale: "ko-KR"}), "en-US", "an unknown value is English, not whatever Zotero says");
  assert.equal(i18n.t("보유 문헌"), "Library");
});

test("auto follows Zotero's own language, and only a Korean Zotero gives Korean", () => {
  assert.equal(i18n.use("auto", {locale: "en-GB"}), "en-US");
  assert.equal(i18n.use("auto", {locale: "ko-KR"}), "ko-KR");
  assert.equal(i18n.use("auto", {locale: "ko"}), "ko-KR");
  assert.equal(i18n.use("auto", {locale: "ja-JP"}), "en-US");
  assert.equal(i18n.use("auto", {}), "en-US", "with nothing to go on, English");
  // An explicit choice overrides what was detected.
  assert.equal(i18n.use("en-US", {locale: "ko-KR"}), "en-US");
  assert.equal(i18n.use("ko-KR", {locale: "en-US"}), "ko-KR");
  i18n.use("en-US");
});

test("numbers, dates and plurals follow the chosen language", () => {
  i18n.use("en-US");
  assert.equal(i18n.number(1234567.891, {maximumFractionDigits: 1}), "1,234,567.9");
  assert.equal(i18n.number("n/a"), "n/a");
  assert.equal(i18n.date("2026-03-04T12:00:00Z", {timeZone: "UTC", month: "short", day: "numeric", year: "numeric"}), "Mar 4, 2026");
  assert.equal(i18n.plural(1, "paper", "papers"), "paper");
  assert.equal(i18n.plural(2, "paper", "papers"), "papers");
  assert.equal(i18n.plural(0, "paper", "papers"), "papers");
  i18n.use("ko-KR");
  assert.match(i18n.date("2026-03-04T12:00:00Z", {timeZone: "UTC", month: "short", day: "numeric", year: "numeric"}), /2026년 3월 4일/);
  assert.equal(i18n.plural(1, "paper", "papers"), "papers", "Korean has no singular");
  i18n.use("en-US");
});

test("a filled-in English string does not say '1 papers'", () => {
  i18n.load(strings.en);
  i18n.use("en-US");
  assert.equal(i18n.singular("1 papers · 11 papers · 0.1 papers · 21 papers · 1 notes"), "1 paper · 11 papers · 0.1 papers · 21 papers · 1 note");
  const saved = i18n._table();
  i18n.load({"문헌 {0}개": "{0} papers"});
  assert.equal(i18n.t("문헌 1개"), "1 paper");
  assert.equal(i18n.t("문헌 2개"), "2 papers");
  assert.equal(i18n.template`문헌 ${1}개`, "1 paper");
  i18n.use("ko-KR");
  assert.equal(i18n.template`문헌 ${1}개`, "문헌 1개");
  i18n.use("en-US");
  i18n.load(saved);
});

test("a string with a number in it still translates around the number", () => {
  i18n.load({"문헌 {0}개": "{0} items", "{0} · {1}개 문헌{2}": "{0} · {1} items{2}"});
  i18n.use("en-US");
  assert.equal(i18n.template`문헌 ${7}개`, "7 items");
  assert.equal(i18n.template`${"A"} · ${3}개 문헌${""}`, "A · 3 items");
  i18n.use("ko-KR");
  assert.equal(i18n.template`문헌 ${7}개`, "문헌 7개");
  i18n.load(strings.en);
});

test("every translation is for a string that is actually in the source", () => {
  // A table entry whose key no longer appears anywhere is dead weight that
  // quietly stops covering anything.
  const source = ["src", "content"].flatMap(dir =>
    fs.readdirSync(new URL("../" + dir, import.meta.url))
      .filter(name => /\.(js|xhtml)$/.test(name) && name !== "strings.js")
      .map(name => fs.readFileSync(new URL(`../${dir}/${name}`, import.meta.url), "utf8")))
    .join("\n");
  /* A templated string never appears whole in the source: `문헌 ${n}개` is
     written with the expression in the middle. So the check is on the longest
     run of literal text between the placeholders, which does appear verbatim. */
  /* A templated string never appears whole in the source: `문헌 ${n}개` is
     written with the expression in the middle, and a line break is written as
     the two characters \ and n rather than as an actual newline. So the check
     is on the longest run of literal text between those, which does appear
     verbatim. */
  const orphans = Object.keys(strings.en).filter(key => {
    const longest = key.split(/\{\d+\}|\n/).map(part => part.trim())
      .sort((a, b) => b.length - a.length)[0] || "";
    return longest.length > 4 && !source.includes(longest);
  });
  assert.deepEqual(orphans, [], "these translations match nothing in the source");
});

test("no translation is left as its own Korean original", () => {
  const same = Object.entries(strings.en).filter(([ko, en]) => ko === en);
  assert.deepEqual(same.map(([ko]) => ko), [], "an untranslated entry should be absent, not copied");
  for (const [ko, en] of Object.entries(strings.en)) {
    assert.equal(typeof en, "string", ko);
    // A placeholder that exists in one and not the other loses a number.
    const holes = text => (String(text).match(/\{\d+\}/g) || []).sort().join(",");
    assert.equal(holes(en), holes(ko), `placeholders differ for ${JSON.stringify(ko)}`);
  }
});

test('a string the code filled in still finds its English through the pattern keys', () => {
  const saved = i18n._table();
  i18n.load({'문헌 {0}개': '{0} papers', '읽은 시간 {0} · 전체 {1}쪽 중 {2}쪽': 'Read {0} · {2} of {1} pages', '{0}개': '{0}', '저널': 'Journal'});
  i18n.use('en-US');
  assert.equal(i18n.t('문헌 12개'), '12 papers');
  assert.equal(i18n.t('읽은 시간 5m 40s · 전체 38쪽 중 8쪽'), 'Read 5m 40s · 8 of 38 pages', 'captures go back in their own order');
  assert.equal(i18n.t('저널'), 'Journal', 'an exact hit still wins');
  assert.equal(i18n.t('아무 데도 없는 문장'), '아무 데도 없는 문장', 'a miss returns the original');
  assert.equal(i18n.t('Plain English 3'), 'Plain English 3', 'no Korean, no walk');
  i18n.use('ko-KR');
  assert.equal(i18n.t('문헌 12개'), '문헌 12개');
  i18n.load(saved);
});

/* ---- English coverage ------------------------------------------------------
   English is the default, so a Korean sentence that reaches the screen with no
   English beside it is a defect, not a gap to fill over time. This reads every
   source file, finds every string literal with Hangul in it, and requires the
   dictionary to answer for it. It also finds the other way to leak: Korean
   assigned straight into the page (textContent, title, aria-label...) without
   going through t(), which the dictionary never sees. */
function koreanLiterals(source) {
  const out = [];              // {text, index, line}
  const masked = source.split("");
  const blank = (from, to) => { for (let k = from; k < to; k++) if (masked[k] !== "\n") masked[k] = " "; };
  const lineAt = index => source.slice(0, index).split("\n").length;
  let prevSignificant = "";
  function code(i, nested) {
    let depth = 0;
    while (i < source.length) {
      const c = source[i], d = source[i + 1];
      if (c === "/" && d === "/") { const e = source.indexOf("\n", i); const stop = e < 0 ? source.length : e; blank(i, stop); i = stop; continue; }
      if (c === "/" && d === "*") { const e = source.indexOf("*/", i + 2); const stop = e < 0 ? source.length : e + 2; blank(i, stop); i = stop; continue; }
      if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < source.length && source[j] !== c && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
        const raw = source.slice(i + 1, j);
        if (/[가-힣]/.test(raw) || /\\u[0-9a-f]{4}/i.test(raw)) {
          let text = raw;
          try { text = JSON.parse('"' + raw.replace(/\\'/g, "'").replace(/"/g, '\\"') + '"'); } catch (error) { }
          if (/[가-힣]/.test(text)) out.push({text, index: i, line: lineAt(i)});
        }
        blank(i + 1, j); prevSignificant = c; i = j + 1; continue;
      }
      if (c === "`") { i = template(i); prevSignificant = "`"; continue; }
      if (c === "/" && !/[\w)\]]/.test(prevSignificant) && prevSignificant !== "") {
        let j = i + 1, inClass = false;
        while (j < source.length && source[j] !== "\n") { if (source[j] === "\\") j++; else if (source[j] === "[") inClass = true; else if (source[j] === "]") inClass = false; else if (source[j] === "/" && !inClass) break; j++; }
        blank(i + 1, j); prevSignificant = ")"; i = j + 1; continue;
      }
      if (nested) { if (c === "{") depth++; else if (c === "}") { if (depth === 0) return i; depth--; } }
      if (!/\s/.test(c)) prevSignificant = c;
      i++;
    }
    return i;
  }
  function template(i) {
    const start = i; let j = i + 1, text = "", n = 0;
    let quasiFrom = j;
    while (j < source.length && source[j] !== "`") {
      if (source[j] === "\\") { text += source.slice(j, j + 2); j += 2; continue; }
      if (source[j] === "$" && source[j + 1] === "{") {
        blank(quasiFrom, j); text += "{" + n++ + "}";
        const end = code(j + 2, true); j = end + 1; quasiFrom = j; continue;
      }
      text += source[j]; j++;
    }
    blank(quasiFrom, j);
    let cooked = text;
    try { cooked = JSON.parse('"' + text.replace(/\\`/g, "`").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"'); } catch (error) { }
    if (/[가-힣]/.test(cooked)) out.push({text: cooked, index: start, line: lineAt(start)});
    return j + 1;
  }
  code(0, false);
  return {out, masked: masked.join("")};
}

const srcDir = new URL("../src/", import.meta.url);
const sourceFiles = fs.readdirSync(srcDir).filter(name => name.endsWith(".js") && name !== "strings.js");

/* What may stay Korean, and why. Everything else must have English.
   - selfcheck.js: the developer's own report, never shown in the panel.
   - the memo separator: a marker written into saved text and recognised later,
     so it cannot change with the language.
   - draft keys and query-string keys: identifiers, not words.
   - the Korean search examples: shown only when the panel is Korean, with the
     English set (title:word ...) shown otherwise.
   - the language setting itself: each language is named in its own language. */
const KEEP_KOREAN = new Set([
  "\n\n--- 이 컴퓨터의 메모 ---\n", "|새 노트 내용|0",
  "-단어", "“구절”", "제목:단어", "-저자:김", "연도:2018-2022", "태그:methods", "저널:Nat Methods", "컬렉션:Review",
  "Language / 언어", "Zotero 언어 따르기 / Follow Zotero", "한국어",
  "언어를 한국어로 바꿨습니다.",
  "기본값은 영어입니다. 한국어를 고르면 패널이 한국어로 바뀝니다. Zotero 언어 따르기는 Zotero가 한국어일 때만 한국어를 씁니다. 패널은 바로 바뀌고, 문헌 목록의 열 이름은 Zotero를 다시 시작하면 바뀝니다."
]);

test("every Korean string in the source has English", () => {
  i18n.load(strings.en);
  i18n.use("en-US");
  const gaps = [];
  let total = 0;
  for (const name of sourceFiles) {
    if (name === "selfcheck.js") continue;
    const {out} = koreanLiterals(fs.readFileSync(new URL(name, srcDir), "utf8"));
    for (const {text, line} of out) {
      total++;
      if (KEEP_KOREAN.has(text)) continue;
      if (/[가-힣]/.test(i18n.t(text))) gaps.push(`${name}:${line} ${JSON.stringify(text).slice(0, 90)}`);
    }
  }
  assert.ok(total > 2000, `the scanner should see the whole source, saw ${total}`);
  assert.deepEqual(gaps, [], `${gaps.length} of ${total} Korean strings have no English`);
});

test("no English translation still contains Korean, except the name of the language", () => {
  const bad = Object.entries(strings.en)
    .filter(([, en]) => /[가-힣]/.test(String(en).replace(/한국어/g, "")))
    .map(([ko]) => ko.slice(0, 60));
  assert.deepEqual(bad, []);
});

test("Korean is never written straight into the page without passing through t()", () => {
  const leaks = [];
  for (const name of sourceFiles) {
    if (name === "selfcheck.js") continue;
    const {out, masked} = koreanLiterals(fs.readFileSync(new URL(name, srcDir), "utf8"));
    for (const {text, index, line} of out) {
      if (KEEP_KOREAN.has(text)) continue;
      // The statement the literal sits in: back to the previous ; { or } in code.
      let from = index;
      while (from > 0 && !";{}".includes(masked[from - 1])) from--;
      const statement = masked.slice(from, index);
      const sink = /(\.textContent|\.innerText|\.title|\.placeholder|\.alt|\.tooltipText)\s*\+?=[^=]|setAttribute\(\s*["'](?:aria-label|title|placeholder|alt)["']\s*,/.exec(statement);
      if (!sink) continue;
      const afterSink = statement.slice(sink.index);
      if (/(^|[^\w.])(t|T|say)\(|\.t\(|template|\.\s*t\b/.test(afterSink)) continue;
      leaks.push(`${name}:${line} ${JSON.stringify(text).slice(0, 80)}`);
    }
  }
  assert.deepEqual(leaks, [], "these reach the page without translation");
});

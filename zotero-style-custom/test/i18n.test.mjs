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

test("auto follows Zotero's own language", () => {
  // Somebody running Zotero in English wants this panel in English without
  // being asked; somebody running it in Korean wants it in Korean.
  assert.equal(i18n.use("auto", {locale: "en-GB"}), "en-US");
  assert.equal(i18n.use("auto", {locale: "ko-KR"}), "ko-KR");
  assert.equal(i18n.use("auto", {}), "ko-KR", "with nothing to go on, the language it was written in");
  // An explicit choice overrides what was detected.
  assert.equal(i18n.use("en-US", {locale: "ko-KR"}), "en-US");
  assert.equal(i18n.use("ko-KR", {locale: "en-US"}), "ko-KR");
  // A value that is not one of the three is treated as auto rather than trusted.
  assert.equal(i18n.use("fr-FR", {locale: "en-US"}), "en-US");
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

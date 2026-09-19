import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const kinds = require("../src/item-kinds.js");

test("a patent is recognised by its number, as the offices print it and files are named", () => {
  /* Three rows in this library were bare attachments called
     US20240352440A1.pdf, US20200208187A1.pdf and US10138506.pdf, sitting in
     the list like any other PDF. */
  assert.equal(kinds.patentNumber("US20240352440A1.pdf"), "US20240352440A1");
  assert.equal(kinds.patentNumber("US10138506.pdf"), "US10138506");
  assert.equal(kinds.patentNumber("US 10,138,506 B2"), "US10138506B2", "offices print thousands separators; files do not");
  assert.equal(kinds.patentNumber("EP3456789B1"), "EP3456789B1");
  assert.equal(kinds.patentNumber("WO2021/123456 A1"), "WO2021/123456A1");
  assert.equal(kinds.patentNumber("KR10-2345678"), "KR10-2345678");
  // A paper about patents is not a patent.
  assert.equal(kinds.patentNumber("The economics of patents in biotechnology"), "");
  assert.equal(kinds.patentNumber("Structure of a type II SMC complex"), "");
});

test("kindOf tells a patent and a thesis from a paper, and says why", () => {
  assert.deepEqual(kinds.kindOf({filename: "US20240352440A1.pdf"}),
    {kind: "patent", number: "US20240352440A1", why: "file name"});
  assert.equal(kinds.kindOf({itemType: "patent", title: "Engineered PETase variants"}).kind, "patent");
  assert.equal(kinds.kindOf({itemType: "thesis", title: "Anything"}).kind, "thesis");
  assert.deepEqual(kinds.kindOf({title: "Acetate metabolism in Geobacillus: a PhD thesis"}), {kind: "thesis", why: "title"});
  assert.equal(kinds.kindOf({title: "박사학위논문: 호열성 효소의 진화"}).kind, "thesis");
  assert.equal(kinds.kindOf({itemType: "journalArticle", title: "Structure of a type II SMC complex", filename: "smith 2024.pdf"}), null);
  assert.equal(kinds.kindOf({}), null);
  assert.equal(kinds.office("US10138506"), "미국");
  assert.equal(kinds.office("KR10-2345678"), "한국");
});

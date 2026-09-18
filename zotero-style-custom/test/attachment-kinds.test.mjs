import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const kinds = require("../src/attachment-kinds.js");

// Every fixture below is the real opening of a real file in this library, read
// out of Zotero's own extracted text. The old rule looked at filenames and
// found 1 supplementary file out of 1,229, because ZotMoov had renamed them all
// to "Author - Year - Title.pdf".
const NATURE_SI = "A swapped genetic code prevents viral infections and gene transfer In the format provided by the authors and unedited Nature | www.nature.com/nature Supplementary information https://doi.org/10.1038/s41586-023-05824-z Supplementary Material";
const NATURE_ARTICLE = "720 | Nature | Vol 615 | 23 March 2023 Article A swapped genetic code prevents viral infections and gene transfer Akos Nyerges, Svenja Vinke, Regan Flynn, Sian V. Owen";
const PNAS_SI = "Supplementary Information for Systematic evasion of the restriction-modification barrier in bacteria Christopher D. Johnston, Sean L. Cotton, Susan R. Rittling";
const PNAS_ARTICLE = "Systematic evasion of the restriction-modification barrier in bacteria Christopher D. Johnston, Sean L. Cotton, Susan R. Rittling, Jacqueline R. Starr, Gary G. Borisy, Floyd E. Dewhirst, and Katherine P. Lemon Vaccine and Infectious Disease Division, Fred Hutchinson Cancer";
const NCB_SI = "nature chemical biology Artic�e https://doi.org/10.1038/s41589-023-01504-1 Short-range translocation by a restriction enzyme motor triggers diffusion along DNA In the format provided by the authors and unedited 1 Table of Contents Supplementary Fig. 1";
const NCB_ARTICLE = "Nature Chemical Biology | Volume 20 | June 2024 | 689–698 689 nature chemical biology Article https://doi.org/10.1038/s41589-023-01504-1 Short-range translocation by a restriction enzyme motor triggers diffusion along DNA Martin Gose, Emma E. Magill";
const TOC_SI = "Table of contents A) Supplementary figures 1. Data collection and analysis 2. Deviations from simple exponential";
const FRONTIERS = "ORIGINAL RESEARCH published: 12 May 2015 doi: 10.3389/fmicb.2015.00430 Frontiers in Microbiology Genomic analysis of six new Geobacillus strains reveals highly conserved carbohydrate";

test("a supplementary file is recognised by what it says, not what it is called", () => {
  assert.equal(kinds.openingKind(NATURE_SI).kind, "supplementary");
  assert.equal(kinds.openingKind(PNAS_SI).kind, "supplementary");
  assert.equal(kinds.openingKind(NCB_SI).kind, "supplementary");
  assert.equal(kinds.openingKind(TOC_SI).kind, "supplementary");
});

test("an article is recognised by its masthead or section label", () => {
  assert.equal(kinds.openingKind(NATURE_ARTICLE).kind, "article");
  assert.equal(kinds.openingKind(FRONTIERS).kind, "article");
  // A ligature that failed to extract arrives as U+FFFD, so "Article" reaches
  // us as "Artic?e" and matched nothing until it was normalised.
  assert.equal(kinds.openingKind(NCB_ARTICLE).kind, "article");
});

test("an article that merely cites its own supplement is still an article", () => {
  const body = FRONTIERS + " ".repeat(5) + "x".repeat(700)
    + " as shown in Supplementary Figure 3 and Supplementary Table 1";
  assert.notEqual(kinds.openingKind(body).kind, "supplementary");
});

test("the same document attached twice is a duplicate, not a second supplement", () => {
  // Sixteen items in this library have one. Calling every extra PDF "SI x2" is
  // what made the badge untrustworthy.
  const out = kinds.classifyGroup([
    {id: 1, text: FRONTIERS + " body text here"},
    {id: 2, text: FRONTIERS + " body text here"}
  ], {title: "Genomic analysis of six new Geobacillus strains reveals highly conserved carbohydrate"});
  assert.deepEqual(out.map(row => row.kind), ["article", "duplicate"]);
  assert.equal(out[1].duplicateOf, 1);
  assert.equal(kinds.summarise(out).supplementary, 0);
});

test("a re-flowed copy of the same paper still reads as a duplicate", () => {
  const reflowed = FRONTIERS.replace(/ /g, "  ").replace("Frontiers in Microbiology", "Frontiers\nin Microbiology");
  assert.equal(kinds.sameDocument(FRONTIERS, reflowed), true);
  assert.equal(kinds.sameDocument(FRONTIERS, PNAS_ARTICLE), false);
});

test("an article and its supplement are told apart, in either order", () => {
  const title = "A swapped genetic code prevents viral infections and gene transfer";
  for (const files of [
    [{id: 1, text: NATURE_SI}, {id: 2, text: NATURE_ARTICLE}],
    [{id: 1, text: NATURE_ARTICLE}, {id: 2, text: NATURE_SI}]
  ]) {
    const out = kinds.classifyGroup(files, {title});
    const summary = kinds.summarise(out);
    assert.equal(summary.article, 1);
    assert.equal(summary.supplementary, 1);
  }
});

test("a supplement that never names its own paper is still a supplement", () => {
  // "Table of contents A) Supplementary figures ..." names nothing. Judged on
  // the title alone it looked like somebody else's paper.
  const out = kinds.classifyGroup([
    {id: 1, text: "LETTERS Exploitation of binding energy for catalysis and design Summer B. Thyme, Jordan Jarjour"},
    {id: 2, text: TOC_SI}
  ], {title: "Exploitation of binding energy for catalysis and design"});
  assert.deepEqual(out.map(row => row.kind), ["article", "supplementary"]);
});

test("a different paper filed under this item is called out", () => {
  const out = kinds.classifyGroup([
    {id: 1, text: "Dali server: conservation mapping in 3D Liisa Holm and Paivi Rosenstrom Institute of Biotechnology"},
    {id: 2, text: "Scientific REPORTS 8:11079 DOI:10.1038/s41598-018-27992-z Allosteric regulation of an unrelated enzyme"}
  ], {title: "Dali server: conservation mapping in 3D"});
  assert.deepEqual(out.map(row => row.kind), ["article", "foreign"]);
  assert.match(out[1].why, /never uses the title/);
});

test("markup in a Zotero title does not turn a correctly filed paper into somebody else's", () => {
  // Twelve papers were reported as mis-filed because their titles carry
  // <span style="font-variant:small-caps;">BREX</span> and none of those words
  // appear in any PDF.
  const title = '<span style="font-variant:small-caps;">BREX</span> is a novel phage resistance system';
  const body = "BREX is a novel phage resistance system widespread in microbial genomes " + "text ".repeat(50);
  assert.equal(kinds.namesTitle(body, title).matched, true);
  assert.equal(kinds.flat(title), "brex is a novel phage resistance system");
});

test("the title check reads the whole document, not the first page", () => {
  // A first page often opens with the abstract and never repeats the title.
  // Scoring page one alone marked a Nature Chemical Biology review as foreign.
  const title = "Systems metabolic engineering of microorganisms for natural and non-natural chemicals";
  const body = "536 nature chemical biology | VOL 8 | JUNE 2012 REVIEW ARTICLE "
    + "filler ".repeat(200)
    + " systems metabolic engineering of microorganisms for natural and non-natural chemicals";
  assert.equal(kinds.namesTitle(body, title).matched, true);
});

test("a single file is the article unless it says otherwise or belongs elsewhere", () => {
  const title = "Genomic analysis of six new Geobacillus strains reveals highly conserved carbohydrate";
  assert.equal(kinds.classifyGroup([{id: 1, text: FRONTIERS}], {title})[0].kind, "article");
  assert.equal(kinds.classifyGroup([{id: 1, text: PNAS_SI}], {title: "Systematic evasion of the restriction-modification barrier in bacteria"})[0].kind, "supplementary");
  assert.equal(kinds.classifyGroup([{id: 1, text: "A completely unrelated gamma-ray perspective piece about jets"}],
    {title: "The First LHAASO Catalog of Gamma-Ray Sources"})[0].kind, "foreign");
});

test("no text means no verdict, rather than a guess", () => {
  const out = kinds.classifyGroup([{id: 1, text: ""}, {id: 2, text: ""}], {title: "Some paper about things"});
  assert.ok(out.every(row => row.kind !== "supplementary"));
  assert.deepEqual(kinds.classifyGroup([], {title: "x"}), []);
  assert.equal(kinds.openingKind("").kind, "unknown");
  assert.equal(kinds.namesTitle("text here", "ab cd"), null, "a title too short to test gives no verdict");
});

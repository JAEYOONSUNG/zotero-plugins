import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url);
const PT = require("../src/paper-text.js");

/* ---------------------------------------------------------------------------
   Synthetic pages. Coordinates are PDF user space, y from the top; an item's
   box is [x, y, w, h] and its baseline is y + h. Glyphs are half an em wide.
   --------------------------------------------------------------------------- */

const W = 612, H = 792, EM = 0.5;
const item = (str, x, y, size = 10, o = {}) => ({
  str, x, y, w: o.w != null ? o.w : str.length * size * EM, h: size,
  fontName: o.bold ? "Times-Bold" : o.italic ? "Times-Italic" : "Times-Roman", fontSize: size,
  bold: !!o.bold, italic: !!o.italic, ...(o.dir ? { dir: o.dir } : {}),
});

/* Greedy-wrapped paragraph in a column: returns its items and the y where the next one may start. */
function para(x, top, width, text, size = 10, o = {}) {
  const pitch = o.pitch || size * 1.25;
  const words = text.split(/\s+/);
  const lines = [];
  let cur = "", first = true;
  for (const w of words) {
    const room = Math.floor((width - (first && o.indent ? o.indent : 0)) / (size * EM));
    if (cur && (cur + " " + w).length > room) { lines.push({ s: cur, first }); cur = w; first = false; }
    else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push({ s: cur, first });
  const items = lines.map((l, i) => item(l.s, x + (l.first && o.indent ? o.indent : 0), top + i * pitch, size, o));
  return { items, next: top + lines.length * pitch + (o.after != null ? o.after : size * 0.9) };
}

/* Lines placed exactly as given (to control where a line ends). */
const lines = (x, top, strs, size = 10, o = {}) => strs.map((s, i) => item(s, x, top + i * (o.pitch || size * 1.25), size, o));

/* Sentence k, recognisable and unique. */
const S = k => `In trial ${k} the enzyme cleaved the labelled substrate at the expected site in the presence of magnesium.`;
const prose = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => S(a + i)).join(" ");

const page = (index, items) => ({ index, width: W, height: H, items });
const texts = r => PT.readingOrder(r).map(s => s.text);
const trialOf = t => { const m = /In trial (\d+)/.exec(t); return m ? +m[1] : null; };
const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const COL0 = 54, COL1 = 318, CW = 240;

/* ---------------------------------------------------------------- text cleaning */

test("ligatures, soft hyphens, odd spaces and zero-width characters are cleaned; Greek, micro, plus-minus, times and degree stay", () => {
  assert.equal(PT.normalizeText("ﬁnd ﬂow oﬀ eﬃcient ﬄ"), "find flow off efficient ffl");
  assert.equal(PT.normalizeText("anti­biotic"), "antibiotic");
  assert.equal(PT.normalizeText("5 mg ml​﻿"), "5 mg ml");
  assert.equal(PT.normalizeText("α-helix µM ± 3 × 10 37 °C ΔrecA"), "α-helix µM ± 3 × 10 37 °C ΔrecA");
  assert.equal(PT.normalizeText("non‑binding"), "non-binding");
});

/* ---------------------------------------------------------------- sentences */

const sentences = s => PT.splitSentences(s).map(([a, b]) => s.slice(a, b).trim());

test("sentences split at full stops but not inside abbreviations, initials, decimals, addresses or brackets", () => {
  assert.deepEqual(sentences("We grew S. cerevisiae at 30 °C. Cells were harvested."), ["We grew S. cerevisiae at 30 °C.", "Cells were harvested."]);
  assert.deepEqual(sentences("Growth is shown in Fig. 2 and Supplementary Fig. S1. The rate was 3.5 mM per hour."), ["Growth is shown in Fig. 2 and Supplementary Fig. S1.", "The rate was 3.5 mM per hour."]);
  assert.deepEqual(sentences("This agrees with Smith et al. (2020) and with Dr. Jones, e.g. in vitro, i.e. in cells. It differs from E. coli."), ["This agrees with Smith et al. (2020) and with Dr. Jones, e.g. in vitro, i.e. in cells.", "It differs from E. coli."]);
  assert.deepEqual(sentences("Code is at https://github.com/lab/tool and doi:10.1038/s41586-023-06268-1. Please cite it."), ["Code is at https://github.com/lab/tool and doi:10.1038/s41586-023-06268-1.", "Please cite it."]);
  assert.deepEqual(sentences("Binding was tight [12,13]. See refs (Smith et al., 2020; Lee, 2019). Done."), ["Binding was tight [12,13].", "See refs (Smith et al., 2020; Lee, 2019).", "Done."]);
  assert.deepEqual(sentences("The strain (see Table 1. Strains used here) grew. Then it stopped."), ["The strain (see Table 1. Strains used here) grew.", "Then it stopped."]);
  assert.deepEqual(sentences("Species such as B. subtilis sp. nov. and Vibrio spp. differ vs. controls (p < 0.05). Yes."), ["Species such as B. subtilis sp. nov. and Vibrio spp. differ vs. controls (p < 0.05).", "Yes."]);
  assert.deepEqual(sentences("Is it so? It is! And then “we saw it.” Next."), ["Is it so?", "It is!", "And then “we saw it.”", "Next."]);
  assert.deepEqual(sentences("Strain No. 5 was used."), ["Strain No. 5 was used."]);
});

test("a hyphen at a line end is resolved conservatively and every decision is recorded", () => {
  const lex = { words: new Set(["wild-type", "organisms", "binding", "protein"]) };
  assert.equal(PT.decideHyphen("micro", "organisms", lex).action, "join");            // the joined word is in the paper
  assert.equal(PT.decideHyphen("wild", "type", lex).action, "keep");                  // the hyphenated word is in the paper
  assert.equal(PT.decideHyphen("Cas9", "mediated", lex).action, "keep");              // a digit in the first half
  assert.equal(PT.decideHyphen("DNA", "binding", lex).action, "keep");                // an acronym
  assert.equal(PT.decideHyphen("foun", "dation", lex).action, "join");                // a syllable break
  assert.equal(PT.decideHyphen("sub", "Saharan", lex).action, "keep");                // the next line is not lower-case

  const r = PT.structure({ pages: [page(0, [
    ...lines(72, 90, [
      "All growth curves were measured for the several different strains of micro-",
      "organisms grown in minimal medium at 37 degrees, and the wild-",
      "type strain and the Cas9-",
      "mediated knockout were compared across several independent biological rep-",
      "licates, and the same foun-",
      "dation was laid for the analysis of the binding of this protein to DNA targets.",
      "The wild-type strain served as the reference throughout the whole of this work.",
      "Further microorganisms were not tested, because the organisms listed were enough.",
    ].concat(Array.from({ length: 8 }, (_, i) => S(i + 1).slice(0, 90) + " and more words follow")), 10, { pitch: 12 }),
  ]) ] });
  const all = texts(r).join(" ");
  assert.match(all, /different strains of microorganisms grown in minimal medium at 37 degrees, and the wild-type strain and the Cas9-mediated knockout were compared/);
  assert.match(all, /biological replicates, and the same foundation was laid/);
  const done = r.notes.hyphenation.map(h => `${h.action}:${h.left}-${h.right}`);
  assert.ok(done.includes("join:micro-organisms") && done.includes("keep:wild-type") && done.includes("keep:Cas9-mediated") && done.includes("join:foun-dation") && done.includes("join:rep-licates"), done.join(", "));
});

/* ---------------------------------------------------------------- columns and order */

test("two columns are read column by column, top to bottom", () => {
  const left = para(COL0, 90, CW, prose(1, 14));
  const right = para(COL1, 90, CW, prose(15, 28));
  const r = PT.structure({ pages: [page(0, [...left.items, ...right.items])] });
  const order = texts(r).map(trialOf);
  assert.deepEqual(order, Array.from({ length: 28 }, (_, i) => i + 1));
  assert.equal(r.stats.columns, 2);
});

test("a single-column title block over two columns keeps its place, and three columns work too", () => {
  const abstract = para(54, 200, 504, "ABSTRACT_START " + prose(1, 3), 9, { bold: true });
  const left = para(COL0, 280, CW, prose(4, 17));
  const right = para(COL1, 280, CW, prose(18, 31));
  const r = PT.structure({ pages: [page(0, [
    item("A study of the enzyme", 54, 60, 22, { bold: true }), item("under many conditions", 54, 86, 22, { bold: true }),
    item("Ada Lovelace, Alan Turing and Grace Hopper", 54, 130, 10),
    ...abstract.items, ...left.items, ...right.items,
  ]) ] });
  assert.equal(r.title, "A study of the enzyme under many conditions");
  const order = texts(r).map(trialOf);
  assert.deepEqual(order.filter(Boolean), Array.from({ length: 31 }, (_, i) => i + 1));
  assert.ok(r.abstract.startsWith("ABSTRACT_START"));
  assert.ok(!texts(r).some(t => /Lovelace/.test(t)), "the author line is front matter, not body");
  assert.ok(r.skipped.other.some(e => /Lovelace/.test(e.text)));

  const cols = [54, 232, 410].map(x => para(x, 100, 160, prose(1 + 9 * [54, 232, 410].indexOf(x), 9 + 9 * [54, 232, 410].indexOf(x)), 10));
  const r3 = PT.structure({ pages: [page(0, cols.flatMap(c => c.items))] });
  assert.equal(r3.stats.columns, 3);
  assert.deepEqual(texts(r3).map(trialOf), Array.from({ length: 27 }, (_, i) => i + 1));
});

test("sentence order follows page, zone, column and y on every page", () => {
  const p0 = [...para(COL0, 90, CW, prose(1, 12)).items, ...para(COL1, 90, CW, prose(13, 24)).items];
  const p1 = [...para(COL0, 90, CW, prose(25, 36)).items, ...para(COL1, 90, CW, prose(37, 48)).items];
  const r = PT.structure({ pages: [page(0, p0), page(1, p1)] });
  const flat = r.sections.flatMap(s => s.paragraphs.flatMap(p => p.sentences));
  for (let i = 1; i < flat.length; i++) {
    const a = flat[i - 1], b = flat[i];
    const ka = [a.page, a.zone, a.col, a.y], kb = [b.page, b.zone, b.col, b.y];
    for (let k = 0; k < 4; k++) { if (ka[k] !== kb[k]) { assert.ok(kb[k] > ka[k] - (k === 3 ? 2 : 0), `${i}: ${ka} then ${kb}`); break; } }
  }
});

/* ---------------------------------------------------------------- headers, footers, numbers */

test("running heads, page numbers and download stamps never reach the body", () => {
  const pages = [0, 1, 2, 3].map(n => {
    const body = para(COL0, 90, CW, prose(1 + 8 * n, 8 + 8 * n));
    const body2 = para(COL1, 90, CW, prose(33 + 8 * n, 40 + 8 * n));
    return page(n, [
      item("Journal of Imaginary Results", 54, 28, 8, { italic: true }), item(`Vol 5 | ${2020 + n}`, 480, 28, 8),
      ...body.items, ...body2.items,
      item(`– ${n + 3} –`, 296, 755, 8),
      item(`Downloaded from https://example.org/journal.pdf by guest on ${n + 3} May 2024`, 54, 770, 7),
      item(`© 2024 The Authors. All rights reserved.`, 54, 780, 7),
    ]);
  });
  const r = PT.structure({ pages });
  const all = texts(r).join(" ");
  assert.ok(!/Imaginary|Downloaded|rights reserved|Vol 5/.test(all), all.slice(0, 200));
  assert.ok(r.skipped.headers.some(e => /Imaginary/.test(e.text)));
  assert.ok(r.skipped.footers.some(e => /Downloaded from/.test(e.text)));
  assert.equal(r.skipped.pageNumbers.length, 4);
  assert.equal(texts(r).length, 4 * 16);
});

test("a first page carries a title block, authors, affiliations, dates and keywords that are not read as body", () => {
  const abstract = para(54, 330, 504, "The abstract of the paper begins here. " + prose(1, 4), 9);
  const left = para(COL0, 420, CW, prose(5, 20));
  const right = para(COL1, 420, CW, prose(21, 36));
  const r = PT.structure({ pages: [page(0, [
    item("Structural basis of enzyme action", 54, 70, 20, { bold: true }),
    item("Ada Lovelace1, Alan Turing2 and Grace Hopper1,*", 54, 110, 10),
    item("1Department of Biochemistry, University of Cambridge, Cambridge CB2 1QW, UK", 54, 130, 8),
    item("2School of Mathematics, University of Manchester, Manchester M13 9PL, UK", 54, 142, 8),
    item("*Correspondence: grace@example.org", 54, 154, 8),
    item("Received: 3 March 2023; Accepted: 5 June 2023; Published online: 1 July 2023", 54, 180, 8),
    item("Keywords: enzyme, cleavage, magnesium", 54, 300, 9),
    ...abstract.items, ...left.items, ...right.items,
  ]) ] });
  assert.equal(r.title, "Structural basis of enzyme action");
  assert.match(r.abstract, /^The abstract of the paper begins here\./);
  const body = texts(r).join(" ");
  assert.ok(!/Department|Correspondence|Received|Keywords|Lovelace/.test(body), body.slice(0, 300));
  const why = r.skipped.other.map(e => e.reason).join("|");
  assert.match(why, /affiliations/);
  assert.match(why, /dates/);
  assert.match(why, /keywords/);
});

/* ---------------------------------------------------------------- continuation */

test("a sentence that runs from one column to the next, and from one page to the next, stays one sentence", () => {
  const part1 = prose(1, 12) + " The assay was repeated with a second preparation of the";
  const part2 = "enzyme and gave the same result. " + prose(13, 24);
  const left = para(COL0, 90, CW, part1);
  const right = para(COL1, 90, CW, part2);
  const r = PT.structure({ pages: [page(0, [...left.items, ...right.items])] });
  const joined = texts(r).find(t => /second preparation/.test(t));
  assert.equal(joined, "The assay was repeated with a second preparation of the enzyme and gave the same result.");
  assert.equal(r.sections[0].paragraphs.length, 1, "one paragraph across the two columns");

  // across a page, with a running head and a footer in between
  const lastCol = para(COL0, 90, CW, prose(1, 30) + " The final value rose steadily and reached");
  const nextPage = para(COL0, 90, CW, "its plateau after ten minutes of incubation. " + prose(31, 40));
  const pg = (n, items) => page(n, [item("Journal of Imaginary Results", 54, 28, 8), item(String(n + 1), 300, 760, 8), ...items]);
  const r2 = PT.structure({ pages: [pg(0, lastCol.items), pg(1, nextPage.items), pg(2, para(COL0, 90, CW, prose(41, 50)).items)] });
  const t2 = texts(r2).find(t => /final value/.test(t));
  assert.equal(t2, "The final value rose steadily and reached its plateau after ten minutes of incubation.");
});

/* ---------------------------------------------------------------- citations in text */

test("superscript citation numbers leave the spoken text but stay in the highlight boxes; real exponents and charges stay", () => {
  const size = 10, top = 100;
  const first = "Many bacteria were found in E. coli";
  const x0 = 72, w1 = first.length * size * EM;
  const rest = ". The titre reached 10";
  const pieces = [
    item(first, x0, top, size),
    item("12,13", x0 + w1, top + 0.5, 6),                                   // raised, smaller: a citation
    item(rest, x0 + w1 + 5 * 6 * EM, top, size),
  ];
  const xr = x0 + w1 + 5 * 6 * EM + rest.length * size * EM;
  pieces.push(item("6", xr, top + 0.5, 6));                                   // an exponent after a digit
  const tail = " cells per ml in 2 mM Mg";
  pieces.push(item(tail, xr + 6 * EM, top, size));
  const xt = xr + 6 * EM + tail.length * size * EM;
  pieces.push(item("2+", xt, top + 0.5, 6));                                  // an ion charge
  pieces.push(item(" and the area was 4 cm", xt + 2 * 6 * EM, top, size));
  const xa = xt + 2 * 6 * EM + " and the area was 4 cm".length * size * EM;
  pieces.push(item("2", xa, top + 0.5, 6));                                   // cm2, not a citation
  pieces.push(item(". It was clear.", xa + 6 * EM, top, size));
  const filler = para(72, 130, 468, prose(1, 8));
  const r = PT.structure({ pages: [page(0, [...pieces, ...filler.items])] });
  const ro = PT.readingOrder(r);
  const s1 = ro[0];
  assert.equal(s1.text, "Many bacteria were found in E. coli.");
  assert.ok(!/12/.test(s1.text));
  const xs = s1.rects.flatMap(([x, , w]) => [x, x + w]);
  assert.ok(Math.max(...xs) >= x0 + w1 + 5 * 6 * EM - 0.5, "the rect reaches over the citation number");
  const s2 = ro[1].text;
  assert.match(s2, /^The titre reached 10⁶ cells per ml in 2 mM Mg²⁺ and the area was 4 cm²\.$/, s2);
  assert.equal(ro[2].text, "It was clear.");
});

test("citation markers are recognised by what they are", () => {
  const sup = str => ({ str, sup: true });
  assert.equal(PT.isCiteSup(sup("12,13"), "in E. coli"), true);
  assert.equal(PT.isCiteSup(sup("1–5"), "shown"), true);
  assert.equal(PT.isCiteSup(sup("*"), "author"), true);
  assert.equal(PT.isCiteSup(sup("6"), "10"), false);          // power
  assert.equal(PT.isCiteSup(sup("2"), "4 cm"), false);        // area
  assert.equal(PT.isCiteSup(sup("2+"), "Mg"), false);         // charge
  assert.equal(PT.isCiteSup(sup("−1"), "s"), false);     // exponent
});

/* ---------------------------------------------------------------- what is not body */

function onePage(extra) {
  const intro = para(72, 90, 468, "Introduction text. " + prose(1, 6));
  return { intro, ...extra };
}

test("figure and table captions, table bodies, equations and footnotes are each filed away", () => {
  let y = 90;
  const items = [];
  const a = para(72, y, 468, prose(1, 5)); items.push(...a.items); y = a.next + 6;
  // a figure caption: bold label, smaller type, several lines
  items.push(item("Fig. 1 |", 72, y, 8, { bold: true }));
  const capTail = "Cleavage of the substrate. a, Gel of the reaction products after 10 min. b, Quantification of three independent experiments.";
  const capLines = para(72 + 8 * 8 * EM + 4, y, 468 - 40, capTail, 8);
  capLines.items.forEach((it, i) => { if (i > 0) it.x = 72; });
  items.push(...capLines.items);
  y = capLines.next + 6;
  const b = para(72, y, 468, prose(6, 10)); items.push(...b.items); y = b.next + 6;
  // an equation: centred expression and a number at the right margin
  items.push(item("E = mc² + Σ α β × γ", 230, y, 10), item("(3)", 520, y, 10));
  y += 22;
  const c = para(72, y, 468, "where m is the mass of the labelled substrate. " + prose(11, 14)); items.push(...c.items); y = c.next + 8;
  // a table: aligned columns of short cells in small type
  items.push(item("Table 1 | Kinetic constants", 72, y, 8, { bold: true })); y += 14;
  const rows = [["Variant", "Km", "kcat", "Ratio"], ["wt", "1.2", "30", "25"], ["K166A", "2.4", "12", "5"], ["H174Y", "3.9", "8", "2"], ["Y194F", "1.1", "28", "26"]];
  rows.forEach(r => { [72, 190, 300, 410].forEach((x, k) => items.push(item(r[k], x, y, 8))); y += 11; });
  y += 8;
  const d = para(72, y, 468, prose(15, 20)); items.push(...d.items);
  // a footnote at the foot of the page, small, starting with a superscript marker
  items.push(item("1", 72, 737, 5, { w: 3 }), item("Values are the mean of three independent experiments, each done in duplicate.", 76, 738, 7));
  const r = PT.structure({ pages: [page(0, items)] });
  const body = texts(r).map(trialOf).filter(Boolean);
  assert.deepEqual(body, Array.from({ length: 20 }, (_, i) => i + 1));
  assert.ok(!texts(r).some(t => /Cleavage of the substrate|Kinetic constants|Values are the mean|E = mc/.test(t)), texts(r).join("\n"));
  assert.equal(r.captions.filter(c => c.kind === "figure").length, 1);
  assert.match(r.captions.find(c => c.kind === "figure").text, /Quantification of three independent experiments/);
  assert.equal(r.captions.find(c => c.kind === "figure").label, "Fig. 1");
  assert.ok(r.captions.some(c => c.kind === "table" && /Table 1/.test(c.label)));
  assert.ok(r.skipped.tables.length >= 1, "the table body is set aside");
  assert.ok(r.skipped.tables.some(t => /Y194F/.test(t.text)));
  assert.ok(r.skipped.equations.length >= 1);
  assert.ok(r.footnotes.some(f => /Values are the mean/.test(f.text)));
});

test("references end the body: a headed list and a headingless one, then back matter is marked", () => {
  const ref = n => `${n}. Smith, J., Lee, K. & Park, S. Cleavage of labelled substrates by magnesium-dependent enzymes. Nature ${400 + n}, ${10 + n}–${20 + n} (20${10 + n}).`;
  const p0 = [...para(72, 90, 468, "Introduction. " + prose(1, 5)).items];
  const r0 = PT.structure({ pages: [page(0, p0)] });
  assert.equal(r0.references.length, 0);

  const items = [];
  let y = 90;
  const heading = (t, size = 11) => { items.push(item(t, 72, y, size, { bold: true })); y += size * 2; };
  heading("Results");
  let p = para(72, y, 468, prose(1, 6)); items.push(...p.items); y = p.next + 8;
  heading("Acknowledgements");
  p = para(72, y, 468, "We thank the members of the laboratory for helpful discussions and the facility for access."); items.push(...p.items); y = p.next + 8;
  heading("Author contributions");
  p = para(72, y, 468, "A.L. designed the study. A.T. performed the experiments. G.H. wrote the paper."); items.push(...p.items); y = p.next + 8;
  heading("References");
  for (let n = 1; n <= 7; n++) { p = para(72, y, 468, ref(n), 8, { pitch: 10 }); items.push(...p.items); y = p.next + 2; }
  const r = PT.structure({ pages: [page(0, items)] });
  assert.equal(r.references.length, 7);
  assert.match(r.references[0].text, /^1\. Smith, J\., Lee, K\. & Park, S\./);
  assert.ok(!texts(r).some(t => /Smith, J\.|Nature 40/.test(t)), "no reference entry in the body");
  const back = r.sections.filter(s => s.level === "back").map(s => s.heading);
  assert.deepEqual(back, ["Acknowledgements", "Author contributions"]);
  assert.equal(r.sections.find(s => s.heading === "Results").level, 1);
  const ro = PT.readingOrder(r);
  assert.ok(ro.filter(s => s.kind === "back").length >= 2, "back-matter sentences are marked so a reader can skip them");

  // the same list without a heading is still found
  const items2 = [...para(72, 90, 468, prose(1, 8)).items];
  y = 220;
  for (let n = 1; n <= 9; n++) { p = para(72, y, 468, ref(n), 8, { pitch: 10 }); items2.push(...p.items); y = p.next + 2; }
  const r2 = PT.structure({ pages: [page(0, items2)] });
  assert.ok(r2.references.length >= 8, `found ${r2.references.length}`);
  assert.equal(texts(r2).length, 8);
});

test("section headings: numbered, capitalised, bold run-in; levels follow numbering and type size", () => {
  const items = [];
  let y = 80;
  const h = (t, size, o = {}) => { items.push(item(t, 72, y, size, { bold: true, ...o })); y += size * 1.8; };
  const body = (a, b) => { const p = para(72, y, 468, prose(a, b)); items.push(...p.items); y = p.next + 6; };
  h("1. Introduction", 13); body(1, 5);
  h("2. Materials and methods", 13);
  h("2.1 Strain construction", 11); body(6, 9);
  h("2.2 Protein purification", 11); body(10, 13);
  h("3. RESULTS", 13); body(14, 18);
  // a bold run-in heading: bold words, then regular text on the same line
  const runBold = item("Gel electrophoresis.", 72, y, 10, { bold: true });
  const runTail = item(" Samples were separated on a 1% agarose gel and stained.", 72 + runBold.w, y, 10);
  items.push(runBold, runTail);
  const more = para(72, y + 12.5, 468, prose(19, 22)); items.push(...more.items);
  const r = PT.structure({ pages: [page(0, items)] });
  const heads = r.sections.filter(s => s.heading).map(s => [s.heading, s.level, s.part]);
  assert.deepEqual(heads.map(h => h[0]), ["1. Introduction", "2. Materials and methods", "2.1 Strain construction", "2.2 Protein purification", "3. RESULTS", "Gel electrophoresis"]);
  assert.deepEqual(heads.map(h => h[1]), [1, 1, 2, 2, 1, 3]);
  assert.deepEqual(heads.map(h => h[2]), ["main", "methods", "methods", "methods", "main", "main"]);
  const gel = r.sections.find(s => s.heading === "Gel electrophoresis");
  assert.match(gel.paragraphs[0].sentences[0].text, /^Samples were separated on a 1% agarose gel and stained\./);
});

test("sentences that are only an address are set aside, and a very long run is cut into speakable pieces", () => {
  const pseudo = i => String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + (Math.floor(i / 26) % 26)) + "ing";
  const long = Array.from({ length: 150 }, (_, i) => pseudo(i)).join(" ") + "; " + Array.from({ length: 20 }, (_, i) => pseudo(i + 200)).join(" ") + ".";
  const p = para(72, 90, 468, "https://example.org/data/set/12345. " + prose(1, 4) + " " + long);
  const r = PT.structure({ pages: [page(0, p.items)] });
  assert.ok(r.skipped.other.some(e => /example\.org/.test(e.text) && /URL|address/i.test(e.reason)));
  const ro = PT.readingOrder(r);
  assert.ok(ro.every(s => s.text.split(/\s+/).length <= 120), "no sentence longer than 120 words");
  assert.ok(!ro.some(s => /^https?:/.test(s.text)));
});

test("a draft layer printed under the final text is not read twice", () => {
  const body = para(72, 90, 468, prose(1, 8));
  const overlay = body.items.slice(0, 3).map(it => ({ ...it, x: it.x + 4, str: it.str.replace(/trial/g, "TRIAL") }));
  const r = PT.structure({ pages: [page(0, [...body.items, ...overlay])] });
  const all = texts(r).join(" ");
  assert.ok(!/TRIAL/.test(all) || !/trial/.test(all.slice(0, 10)), "one layer only");
  assert.equal(texts(r).filter(t => /In trial 1 /.test(t)).length, 1);
});

test("a column of line numbers in the margin is not text", () => {
  const items = [];
  for (let i = 0; i < 24; i++) items.push(item(String(i + 1), 40, 90 + i * 14, 9));
  const text = para(72, 90, 468, prose(1, 14), 10, { pitch: 14 });
  items.push(...text.items);
  const r = PT.structure({ pages: [page(0, items)] });
  assert.ok(texts(r).every(t => !/^\d+ /.test(t)));
  assert.equal(texts(r).map(trialOf).filter(Boolean).length, 14);
});

/* ---------------------------------------------------------------- pdf.js adapter, order, debug */

test("pageFromPdfjs converts pdf.js text items and the viewport into the page shape", () => {
  const viewport = { width: 612, height: 792, scale: 1, transform: [1, 0, 0, -1, 0, 792] };
  const textContent = {
    items: [
      { str: "Heading", transform: [14, 0, 0, 14, 72, 700], width: 60, height: 14, fontName: "g_d0_f1", hasEOL: false },
      { str: "body text", transform: [10, 0, 0, 10, 72, 680], width: 45, height: 10, fontName: "g_d0_f2", hasEOL: true },
      { str: "rotated stamp", transform: [0, 8, -8, 0, 20, 300], width: 70, height: 8, fontName: "g_d0_f2" },
      { type: "beginMarkedContent", id: "x" },
    ],
    styles: { g_d0_f1: { fontFamily: "serif" }, g_d0_f2: { fontFamily: "sans-serif" } },
  };
  const fonts = { g_d0_f1: { name: "ABCDEF+MinionPro-Bold", bold: true }, g_d0_f2: { name: "ABCDEF+Myriad-It", italic: true } };
  const p = PT.pageFromPdfjs(4, viewport, textContent, { fonts });
  assert.equal(p.index, 4); assert.equal(p.width, 612); assert.equal(p.height, 792);
  assert.equal(p.items.length, 3);
  const [a, b, c] = p.items;
  assert.deepEqual([a.str, a.x, a.y, a.h, a.fontSize], ["Heading", 72, 78, 14, 14]);   // top of the box is 792 - 700 - 14
  assert.equal(a.bold, true); assert.equal(b.italic, true);
  assert.equal(a.fontName, "ABCDEF+MinionPro-Bold");
  assert.equal(c.dir, "ttb");
  const bare = PT.pageFromPdfjs(0, viewport, { items: [textContent.items[0]], styles: textContent.styles });
  assert.equal(bare.items[0].bold, undefined, "without font names bold is left unknown");
});

test("fontsOf reads font names from pdf.js and skips fonts that are not loaded yet", () => {
  const commonObjs = { get: id => { if (id === "g_d0_f9") throw new Error("not resolved"); return { name: id === "g_d0_f1" ? "ABC+Times-Bold" : "ABC+Times-Roman", bold: id === "g_d0_f1", italic: false }; } };
  const fonts = PT.fontsOf(commonObjs, { styles: { g_d0_f1: {}, g_d0_f2: {}, g_d0_f9: {} } });
  assert.deepEqual(Object.keys(fonts).sort(), ["g_d0_f1", "g_d0_f2"]);
  assert.equal(fonts.g_d0_f1.bold, true);
});

test("headings set in capitals get a spoken form, acronyms kept", () => {
  const items = [item("A study of enzyme action under many conditions", 72, 40, 22, { bold: true }), item("MATERIALS AND METHODS", 72, 80, 13, { bold: true }), ...para(72, 110, 468, prose(1, 6)).items,
    item("DNA REPAIR IN BACTERIA", 72, 230, 13, { bold: true }), ...para(72, 260, 468, prose(7, 12)).items];
  const r = PT.structure({ pages: [page(0, items)] });
  assert.deepEqual(r.sections.filter(s => s.heading).map(s => s.spoken), ["Materials and methods", "DNA repair in bacteria"]);
});

test("readingOrder lists body sentences only, addressed by section and sentence", () => {
  const items = [item("1. Introduction", 72, 80, 13, { bold: true }), ...para(72, 110, 468, prose(1, 6)).items];
  const r = PT.structure({ pages: [page(0, items)] });
  const ro = PT.readingOrder(r);
  assert.equal(ro.length, 6);
  assert.deepEqual(ro.map(s => s.sentenceIndex), [0, 1, 2, 3, 4, 5]);
  assert.ok(ro.every(s => s.sectionIndex === ro[0].sectionIndex && s.page === 0 && Array.isArray(s.rects) && s.rects.length >= 1));
  assert.ok(ro[0].rects.every(rc => rc.length === 4 && rc.every(Number.isFinite)));
});

test("debug prints what was classified as what, page by page", () => {
  const pages = [0, 1, 2].map(n => page(n, [
    item("Journal of Imaginary Results", 54, 28, 8), item(String(n + 1), 300, 760, 8),
    ...para(72, 90, 468, prose(1 + 6 * n, 6 + 6 * n)).items,
  ]));
  const out = PT.debug(PT.structure({ pages }));
  assert.match(out, /3 pages/);
  assert.match(out, /--- page 1/);
  assert.match(out, /--- page 3/);
  assert.match(out, /BODY .*In trial 1 /);
  assert.match(out, /HEADER .*Imaginary/);
  assert.match(out, /PAGENUMBER/);
  assert.ok(out.split("\n").length < 80, "readable on one screen per page");
});

/* ---------------------------------------------------------------- real papers */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "paper-text");
const fixtureNames = existsSync(FIXTURES) ? readdirSync(FIXTURES).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)).sort() : [];
const SKIP = fixtureNames.length ? false : "test/fixtures/paper-text/*.json are absent (local extractions of the library's own PDFs, gitignored); skipping the real-paper checks";
const load = name => JSON.parse(readFileSync(path.join(FIXTURES, name + ".json"), "utf8"));
const cache = new Map();
const run = name => { if (!cache.has(name)) { const f = load(name); cache.set(name, PT.structure({ pages: f.pages })); } return cache.get(name); };
const flat = r => r.sections.flatMap((s, si) => s.paragraphs.flatMap(p => p.sentences.map(x => ({ ...x, section: s, si }))));
const TERMINAL = /[.!?]["”’')\]]*$/;

// The reference-list heading is missing from this one (its text layer is glyph codes), so it is checked for being noticed instead.
const UNREADABLE = new Set(["biorxiv"]);
// A 1992 Nature page that starts in the middle of another paper's reference list; not a normal article.
const NOT_NORMAL = new Set(["nature1992", "biorxiv"]);

test("the fixture set covers different publishers and layouts", { skip: SKIP }, () => {
  assert.ok(fixtureNames.length >= 6, fixtureNames.join(", "));
  for (const must of ["nature", "natcomm", "cell", "pnas", "mdpi", "aparicio"]) assert.ok(fixtureNames.includes(must), must + " fixture missing");
});

for (const name of fixtureNames) {
  test(`${name}: body is cleanly separated from everything else`, { skip: SKIP }, () => {
    const r = run(name);
    const sents = flat(r);
    const st = r.stats;
    if (UNREADABLE.has(name)) { assert.equal(st.unreadable, true, "a garbled text layer is reported"); return; }
    assert.equal(st.unreadable, false);
    // no running head, footer or page number among the body sentences
    const junk = [...r.skipped.headers, ...r.skipped.footers, ...r.skipped.pageNumbers].map(e => norm(e.text)).filter(t => t.length >= 14 && t.split(" ").length >= 2);
    const bad = sents.filter(s => { const n = norm(s.text); return junk.some(j => n === j || (n.startsWith(j) && j.length >= 0.7 * n.length) || (n.length >= 14 && j.startsWith(n) && n.length >= 0.7 * j.length)); });
    assert.deepEqual(bad.map(s => s.text), [], "header or footer text in the body");
    // no reference entries, no caption text
    const refs = new Set(r.references.map(e => norm(e.text).slice(0, 50)));
    assert.deepEqual(sents.filter(s => refs.has(norm(s.text).slice(0, 50))).map(s => s.text), []);
    const caps = r.captions.map(c => norm(c.text));
    assert.deepEqual(sents.filter(s => { const n = norm(s.text); return n.length > 60 && caps.some(c => c.includes(n)); }).map(s => s.text), [], "caption text in the body");
    assert.ok(!sents.some(s => /^(?:Fig(?:ure)?\.?|Table)\s+\d+\s*[|:.]\s/.test(s.text)), "a caption read as a sentence");
    // size and shape of the sentences
    for (const s of sents) { const n = s.text.split(/\s+/).length; assert.ok(n >= 2 && n <= 120, `${n} words: ${s.text.slice(0, 80)}`); }
    const ended = sents.filter(s => TERMINAL.test(s.text)).length / sents.length;
    assert.ok(ended >= (name === "nature1992" ? 0.9 : 0.95), `terminal punctuation ${Math.round(ended * 100)}%`);
    if (!NOT_NORMAL.has(name)) assert.ok(st.bodyChars >= 0.55 * st.totalChars * (name === "mdpi" || name === "akkaya" || name === "aparicio" ? 0.88 : 1), `body ${Math.round(100 * st.bodyChars / st.totalChars)}% of ${st.totalChars}`);
    // reading order is monotonic by page, zone, column and y
    for (let i = 1; i < sents.length; i++) {
      const a = sents[i - 1], b = sents[i];
      if (b.page < a.page) assert.fail(`page goes back at ${i}: ${a.text.slice(0, 40)} / ${b.text.slice(0, 40)}`);
    }
    let backwards = 0;
    for (let i = 1; i < sents.length; i++) {
      const a = sents[i - 1], b = sents[i];
      if (a.page !== b.page) continue;
      if (b.zone < a.zone || (b.zone === a.zone && b.col < a.col) || (b.zone === a.zone && b.col === a.col && b.y < a.y - 2)) backwards++;
    }
    assert.ok(backwards <= Math.ceil(sents.length * 0.005), `${backwards} sentences out of order`);
    // nothing odd in the text itself
    assert.ok(!sents.some(s => /[­​ﬀ-ﬆ�]/.test(s.text)), "ligature, soft hyphen or replacement character left in");
    assert.ok(!sents.some(s => /\s{2,}/.test(s.text)));
    assert.ok(r.skipped.pageNumbers.length + r.skipped.headers.length + r.skipped.footers.length > 0 || name === "crampton" || name === "akkaya");
    if (r.references.length) assert.ok(r.references.every(e => e.text.length > 10));
    assert.ok(r.title.length > 10, "a title was found");
    assert.ok(r.abstract.length > 150, "an abstract was found");
  });
}

/* Hand-labelled papers: counts and anchors read off the PDFs. */

const LABELS = {
  natcomm: {
    // Nature Communications, two columns, drop cap, bold run-in subheads in a sans face that the font names do not mark as bold
    first: "In the evolutionary arms race against phage, bacteria have assembled a diverse arsenal of antiviral immune strategies.",
    last: "Samples were incubated and EMSAs were performed as described above.",
    mainSentences: [235, 262], backHeadings: ["Data availability", "Acknowledgements", "Author contributions", "Competing interests", "Additional information", "Peer review information", "Open Access"],
    headings: ["Results", "Architecture of DrmAB nucleoprotein complex", "DNA binding requirements of DrmAB", "ATPase activity is critical for DISARM function",
      "DrmA contains an unstructured trigger loop that partially occludes the DNA-binding site", "Methylation sensing and DNA-mediated DrmAB activation", "Discussion", "Methods",
      "Cloning and protein expression", "Protein purification", "Bacterial strains used in phage assays", "Phage strains", "Phage titering",
      "CryoEM sample preparation, data collection and processing", "Native electrophoretic mobility shift assays (EMSAs)"],
    captions: 5, references: [58, 63], columns: 2,
  },
  pnas: {
    // PNAS, two columns, bold run-in subheads; the reference list has no break between columns
    first: "Bacterial immune systems exhibit remarkable diversity and modularity, as a consequence of the continuous selective pressures imposed by phage predation.",
    mainSentences: [280, 330], captions: 7, references: [60, 66], columns: 2,
    headings: ["Results", "Coevolving Components", "Lamassus", "Lamassu Senses DNA Ends In Vitro", "Lamassu Senses Phage Origins of Replication In Vivo", "Structural Basis of LmuA Activation", "Lamassus Evolved from DNA Repair Complex SbcCD", "Discussion", "Materials and Methods", "Genome Database", "Lamassu Detection", "Strains and Plasmids", "Protein Expression and Purification", "Phage Plaque Assays", "Structural Modeling",
      "Chromatin immunoprecipitation sequencing (ChIP-Seq)", "In Vitro DNA Degradation Experiments", "Native Mass Spectrometry (nMS) Analysis of Complexes"],
    backHeadings: ["ACKNOWLEDGMENTS"],
  },
  aparicio: {
    // bioRxiv-style preprint: one column, double spaced, line numbers in the margin, figures after the reference list
    first: "Bacteriophages impose a strong evolutionary pressure on microbes for the development of mechanisms of survival.",
    mainSentences: [135, 160], captions: 4, references: [27, 33], columns: 1,
    headings: ["INTRODUCTION", "MATERIAL AND METHODS", "Bacterial strains and growth conditions", "Phage cultivation", "Cloning of Class 1 DISARM and mutants", "Phage infection growth curves", "Phage replication over time",
      "Methylation-sensitive DNA sequencing", "Construction of motif-containing conjugative plasmids", "Conjugation efficiency", "Statistical analysis", "RESULTS",
      "Class 1 DISARM protects against widely diverse DNA phages", "Class 1 DISARM can drive a phage population with chronic lifestyle to extinction", "Class 1 DISARM provides protection independent of methylation status",
      "Class 1 DISARM of Serratia sp. SCBI modifies host DNA with two methylation patterns", "Class 1 DISARM displays anti-conjugation activity dependent on number of cognate sites", "DISCUSSION"],
    backHeadings: ["ACKNOWLEDGEMENT", "FUNDING", "AUTHOR CONTRIBUTIONS"],
  },
};

for (const [name, lab] of Object.entries(LABELS)) {
  test(`${name}: hand-labelled sentence count, anchors, headings, captions and references`, { skip: SKIP || (fixtureNames.includes(name) ? false : `${name} fixture absent`) }, () => {
    const r = run(name);
    const main = PT.readingOrder(r).filter(s => s.kind !== "back");
    assert.equal(main[0].text, lab.first);
    if (lab.last) assert.equal(main[main.length - 1].text, lab.last);
    assert.ok(main.length >= lab.mainSentences[0] && main.length <= lab.mainSentences[1], `${main.length} body sentences, expected ${lab.mainSentences.join("–")}`);
    const heads = r.sections.filter(s => s.heading && s.level !== "back" && s.kind !== "abstract").map(s => s.heading);
    for (const h of lab.headings) assert.ok(heads.includes(h), `heading "${h}" missing; found ${heads.join(" | ")}`);
    assert.ok(heads.length <= lab.headings.length + 4, `${heads.length - lab.headings.length} headings too many: ${heads.filter(h => !lab.headings.includes(h)).join(" | ")}`);
    assert.deepEqual(r.sections.filter(s => s.level === "back").map(s => s.heading).filter(h => lab.backHeadings.includes(h)), lab.backHeadings);
    assert.equal(r.captions.filter(c => c.kind === "figure").length, lab.captions, r.captions.map(c => c.label).join(", "));
    assert.ok(r.references.length >= lab.references[0] && r.references.length <= lab.references[1], `${r.references.length} references`);
    assert.equal(r.stats.columns, lab.columns);
    assert.equal(r.title.length > 20, true);
  });
}

test("the layout cases the labelled papers stand for", { skip: SKIP }, () => {
  // Nature: no heading above the list of references; found as a run of reference-like blocks, entries split on their numbers
  const nature = run("nature");
  assert.ok(nature.references.length >= 50 && nature.references.length <= 56, `nature: ${nature.references.length} references`);
  assert.ok(nature.references.slice(0, 5).every((e, i) => e.text.startsWith(`${i + 1}. `)));
  assert.ok(nature.captions.length >= 15, "Nature figure and Extended Data captions");
  assert.ok(!flat(nature).some(s => /Fig\. \d \|/.test(s.text)));
  // a caption set over two columns continues in the second one
  const fig1 = nature.captions.find(c => c.label === "Fig. 1");
  assert.match(fig1.text, /Gel source data are provided in Supplementary Fig\. 1\.?$/);
  // Cell: a wide table runs over the gutter and is taken out whole
  const cell = run("cell");
  assert.ok(cell.skipped.tables.some(t => /Dazbog/.test(t.text)));
  assert.ok(!flat(cell).some(s => /Pfam\d{5}/.test(s.text)));
  // Wiley: letter-spaced "F I G U R E 1" labels are still captions
  assert.ok(run("wiley").captions.length >= 8);
  // Annual Reviews: a sidebar in the margin is not threaded into the text
  const ar = run("annrev");
  assert.ok(!flat(ar).some(s => /Hibernation factors:/.test(s.text)));
  // NAR 2025: a title set with letter-spaced words keeps all its letters
  assert.match(run("nar2025").title, /in Escherichia coli$/);
  // the superscript numbers after words are not read: few citation digits are left glued to a word in a Nature paper
  const glued = flat(nature).filter(s => /\b[a-z]{4,}\d{1,2}(?:,\d{1,2}){0,3}[.,;]/.test(s.text));
  assert.ok(glued.length <= 3, glued.slice(0, 3).map(s => s.text).join("\n"));
});

test("without font names the body, captions and references hold; only headings degrade", { skip: SKIP }, () => {
  for (const name of ["nature", "natcomm", "pnas", "mdpi", "wiley", "annrev"]) {
    if (!fixtureNames.includes(name)) continue;
    const a = run(name);
    const pages = load(name).pages.map(p => ({ ...p, items: p.items.map(({ bold, italic, ...rest }) => rest) }));
    const b = PT.structure({ pages });
    assert.ok(Math.abs(b.references.length - a.references.length) <= Math.max(3, 0.08 * a.references.length), `${name}: references ${a.references.length} vs ${b.references.length}`);
    assert.ok(Math.abs(b.stats.bodyChars - a.stats.bodyChars) <= 0.18 * a.stats.bodyChars, `${name}: body ${a.stats.bodyChars} vs ${b.stats.bodyChars}`);
    assert.ok(b.captions.length >= 0.7 * a.captions.length, `${name}: captions ${a.captions.length} vs ${b.captions.length}`);
    assert.ok(b.sections.filter(s => s.heading).length >= 3, `${name}: some headings still found`);
  }
});

test("the shipped module has no dependency on the DOM or on Zotero", () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "paper-text.js"), "utf8");
  assert.ok(!/\b(?:document|window|Zotero|Components|Services)\b\./.test(src.replace(/\/\*[\s\S]*?\*\//g, "")), "pure logic");
  assert.equal(typeof globalThis.StyleCustomPaperText, "object");
  assert.equal(globalThis.StyleCustomPaperText, PT);
});

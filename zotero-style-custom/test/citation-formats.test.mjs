import test from "node:test";
import assert from "node:assert/strict";
import formats from "../src/citation-formats.js";

const paper = {
  title: "Loop-extrusion-mediated plasmid DNA cleavage by the bacterial SMC Wadjet complex",
  creators: [{firstName: "Biswajit", lastName: "Pradhan"}, {firstName: "Amar", lastName: "Deep"}, {firstName: "Eugene", lastName: "Kim"}],
  year: "2025", venue: "Molecular Cell", volume: "85", issue: "4", pages: "712-725",
  DOI: "10.1016/j.molcel.2025.01.004"
};

test("each offered style orders author, year and source the way that style requires", () => {
  assert.equal(formats.format("apa", paper),
    "Pradhan, B., Deep, A., & Kim, E. (2025). Loop-extrusion-mediated plasmid DNA cleavage by the bacterial SMC Wadjet complex. Molecular Cell, 85(4), 712-725. https://doi.org/10.1016/j.molcel.2025.01.004");
  // MLA names only the first author once there are more than two.
  assert.equal(formats.format("mla", paper),
    'Pradhan, Biswajit, et al. "Loop-extrusion-mediated plasmid DNA cleavage by the bacterial SMC Wadjet complex." Molecular Cell, vol. 85, no. 4, pp. 712-725, 2025. https://doi.org/10.1016/j.molcel.2025.01.004');
  assert.equal(formats.format("chicago", paper),
    'Pradhan, Biswajit, Amar Deep, and Eugene Kim. 2025. "Loop-extrusion-mediated plasmid DNA cleavage by the bacterial SMC Wadjet complex." Molecular Cell 85 (4): 712-725. https://doi.org/10.1016/j.molcel.2025.01.004');
  assert.equal(formats.format("vancouver", paper),
    "Pradhan B, Deep A, Kim E. Loop-extrusion-mediated plasmid DNA cleavage by the bacterial SMC Wadjet complex. Molecular Cell. 2025;85(4):712-725. https://doi.org/10.1016/j.molcel.2025.01.004");
});

test("a two-author MLA citation still names both, unlike a three-author one", () => {
  const two = {...paper, creators: paper.creators.slice(0, 2)};
  assert.match(formats.format("mla", two), /^Pradhan, Biswajit, and Amar Deep\./);
});

test("missing metadata degrades to a shorter citation instead of printing empty punctuation", () => {
  const bare = {title: "A preprint without a journal", creators: [{lastName: "Liu"}]};
  const apa = formats.format("apa", bare);
  assert.equal(apa, "Liu. (n.d.). A preprint without a journal.");
  assert.doesNotMatch(apa, /,\s*\.|\(\)|\s\./);
  for (const style of formats.STYLES) assert.doesNotMatch(formats.format(style.key, bare), /undefined|null|,\s*,/);
});

test("a DOI already written as a URL is not doubled into another doi.org prefix", () => {
  assert.match(formats.format("apa", {...paper, DOI: "https://doi.org/10.1/x"}), /https:\/\/doi\.org\/10\.1\/x$/);
  assert.match(formats.format("apa", {...paper, DOI: "http://dx.doi.org/10.1/x"}), /https:\/\/doi\.org\/10\.1\/x$/);
  // With no DOI at all the item URL stands in rather than an empty link.
  assert.match(formats.format("apa", {...paper, DOI: "", url: "https://example.org/a"}), /https:\/\/example\.org\/a$/);
});

test("BibTeX and RIS come out parseable, with en-dashed pages and a stable cite key", () => {
  const bib = formats.bibtex(paper);
  assert.match(bib, /^@article\{pradhan2025,/);
  assert.match(bib, /pages = \{712--725\}/);
  assert.match(bib, /author = \{Pradhan, Biswajit and Deep, Amar and Kim, Eugene\}/);
  assert.equal((bib.match(/\{/g) || []).length, (bib.match(/\}/g) || []).length);
  const ris = formats.ris(paper);
  assert.match(ris, /^TY {2}- JOUR\n/);
  assert.equal((ris.match(/^AU {2}- /gm) || []).length, 3);
  assert.match(ris, /\nER {2}- $/);
});

test("braces in a title cannot break out of the BibTeX field", () => {
  const bib = formats.bibtex({...paper, title: "A {hostile} title \\ with braces}"});
  assert.equal((bib.match(/(?<!\\)\{/g) || []).length, (bib.match(/(?<!\\)\}/g) || []).length);
});

test("an unknown style is refused rather than silently producing nothing", () => {
  assert.throws(() => formats.format("vancouverr", paper), RangeError);
  assert.throws(() => formats.format("apa", null), TypeError);
});

import test from "node:test";
import assert from "node:assert/strict";
import suppl from "../src/supplementary.js";

const hit = (over = {}) => ({resultList: {result: [{
  id: "33654093", source: "MED", pmid: "33654093", pmcid: "PMC7935883",
  doi: "10.1038/s41467-021-21734-y", hasSuppl: "Y", isOpenAccess: "Y", ...over}]}});

test("the strongest identifier available drives the search, and a bare title only as a last resort", () => {
  assert.match(suppl.searchURL({DOI: "10.1/x"}), /query=DOI%3A%2210\.1%2Fx%22/);
  // A DOI written as a URL must not be searched for verbatim.
  assert.match(suppl.searchURL({DOI: "https://doi.org/10.1/x"}), /query=DOI%3A%2210\.1%2Fx%22/);
  assert.match(suppl.searchURL({pmid: "123"}), /EXT_ID%3A123%20AND%20SRC%3AMED/);
  assert.match(suppl.searchURL({title: 'A "quoted" paper'}), /TITLE/);
  assert.equal(suppl.searchURL({}), null);
});

test("the files endpoint takes the PMCID alone; a source segment answers 404", () => {
  // Verified against the live service: /PMC/PMC7935883/... is a 404, /PMC7935883/... is the zip.
  assert.equal(suppl.supplementaryURL({id: "PMC7935883", source: "PMC"}),
    "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC7935883/supplementaryFiles");
  assert.equal(suppl.supplementaryURL({id: "pmc7935883"}),
    "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC7935883/supplementaryFiles");
  // A PubMed-only record has no archived files to fetch.
  assert.equal(suppl.supplementaryURL({id: "33654093", source: "MED"}), null);
  assert.equal(suppl.supplementaryURL(null), null);
});

test("a result for a different DOI is rejected rather than downloaded as this paper's files", () => {
  assert.equal(suppl.pickArticle(hit({doi: "10.9999/other"}), {DOI: "10.1038/s41467-021-21734-y"}), null);
  const picked = suppl.pickArticle(hit(), {DOI: "10.1038/s41467-021-21734-y"});
  assert.equal(picked.id, "PMC7935883");
  assert.equal(picked.source, "PMC");
  assert.equal(picked.hasSupplementary, true);
});

test("an article indexed but not archived in PMC comes back so the reason can be reported", () => {
  const picked = suppl.pickArticle(hit({pmcid: "", hasSuppl: "N"}), {DOI: "10.1038/s41467-021-21734-y"});
  assert.equal(picked.source, "MED");
  assert.equal(picked.hasSupplementary, false);
  assert.equal(suppl.supplementaryURL(picked), null);
});

test("an empty or malformed search result yields nothing instead of throwing", () => {
  for (const payload of [null, {}, {resultList: {}}, {resultList: {result: []}}])
    assert.equal(suppl.pickArticle(payload, {DOI: "10.1/x"}), null);
});

test("archive triage keeps the supplementary files and drops packaging and article body", () => {
  const names = ["41467_2021_21734_MOESM1_ESM.pdf", "41467_2021_21734_MOESM2_ESM.xlsx",
    "__MACOSX/._41467_2021_21734_MOESM1_ESM.pdf", ".DS_Store", "figures/", "nihms123.xml",
    "main.nxml", "supplementary/movie1.avi", "41467_2021_21734_MOESM1_ESM.pdf"];
  const kept = suppl.classifyEntries(names);
  assert.deepEqual(kept.map(f => f.name),
    ["41467_2021_21734_MOESM1_ESM.pdf", "41467_2021_21734_MOESM2_ESM.xlsx", "movie1.avi"]);
  // The article's own figures ship in the same archive and must not be attached.
  assert.deepEqual(suppl.classifyEntries(["41467_2021_21734_Fig1_HTML.gif", "41467_2021_21734_Article_IEq1.gif",
    "gr1.jpg", "pone.0123456.g001.tif", "ncomms9083-f1.jpg"]), []);
  // Frontiers marks supplementary files by kind and number, with no marker word.
  assert.deepEqual(suppl.classifyEntries(["Table_2.XLSX", "Image_3.PNG", "fmicb-07-00723-g001.gif"]).map(f => f.name),
    ["Table_2.XLSX", "Image_3.PNG"]);
  // A nested entry keeps its archive path for extraction but is named by its basename.
  assert.equal(kept[2].entry, "supplementary/movie1.avi");
  assert.deepEqual(kept.map(f => f.extension), ["pdf", "xlsx", "avi"]);
  assert.deepEqual(suppl.classifyEntries(names, {pdfOnly: true}).map(f => f.name),
    ["41467_2021_21734_MOESM1_ESM.pdf"]);
  assert.deepEqual(suppl.classifyEntries(null), []);
});

test("a closed-access article comes back as a readable reason, not a corrupt archive", () => {
  const xml = new TextEncoder().encode(
    '<?xml version="1.0"?><errorBean><errCode>0</errCode><errMsg>Article with id PMC7039709 is not open access one</errMsg></errorBean>');
  assert.equal(suppl.readArchiveError(xml), "Article with id PMC7039709 is not open access one");
  // A real zip starts with the local-file or end-of-central-directory signature.
  assert.equal(suppl.readArchiveError(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])), null);
  assert.equal(suppl.readArchiveError(new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0])), null);
  assert.equal(suppl.readArchiveError(new Uint8Array([1, 2, 3, 4])), "Not a zip archive");
  assert.equal(suppl.readArchiveError(new Uint8Array([])), "Empty response");
  assert.equal(suppl.readArchiveError(null), "Empty response");
});

test("attachment titles say the file is supplementary so it is distinguishable in the item list", () => {
  assert.equal(suppl.attachmentTitle({name: "mmc1.pdf"}), "Supplementary: mmc1.pdf");
});

// Audit item 1: a title search must never be trusted as an identifier match.
const titled = (over = {}) => ({resultList: {result: [{
  id: "PMC999", source: "PMC", pmcid: "PMC999", pmid: "999", title: "Gene X controls growth in cells.",
  pubYear: "2020", authorString: "Park J, Lee K.", doi: "10.1/new", hasSuppl: "Y", isOpenAccess: "Y",
  pubTypeList: {pubType: ["Journal Article"]}, ...over}]}});
const want = {title: "Gene X controls growth in cells", year: 2020, creators: [{lastName: "Park", firstName: "J"}]};

test("a stored PMID or PMCID drives the lookup before any title search", () => {
  assert.match(suppl.searchURL({pmid: "12345678", title: "t"}), /EXT_ID%3A12345678/);
  assert.match(suppl.searchURL({pmcid: "PMC77", pmid: "5", title: "t"}), /PMCID%3APMC77/);
  assert.match(suppl.searchURL({DOI: "10.1/x", pmid: "5"}), /DOI%3A/);
});

test("a title-search hit needs exact title, year within one and the first author's family name", () => {
  const ok = suppl.pickArticle(titled(), want);
  assert.equal(ok.id, "PMC999");
  assert.equal(ok.needsConfirmation, undefined);
  assert.equal(suppl.pickArticle(titled({pubYear: "2021"}), want).id, "PMC999", "year +-1 is allowed");
  for (const over of [{pubYear: "2025"}, {authorString: "Other A."}, {title: "Gene X controls growth in other cells."}]) {
    const got = suppl.pickArticle(titled(over), want);
    assert.equal(got.needsConfirmation, true, JSON.stringify(over));
    assert.equal(got.hasSupplementary, false, "nothing is downloaded for an unconfirmed candidate");
    assert.equal(suppl.supplementaryURL(got), null);
  }
  assert.equal(suppl.pickArticle(titled(), {title: want.title}).needsConfirmation, true, "no year or author to check means unconfirmed");
});

test("corrections, errata and retraction notices are never picked", () => {
  for (const type of ["Published Erratum", "Retraction of Publication", "Retracted Publication", "Correction", "Erratum", "Expression of Concern"]) {
    assert.equal(suppl.pickArticle(titled({pubTypeList: {pubType: [type]}}), want), null, type);
  }
  assert.equal(suppl.pickArticle(titled({title: "Correction: Gene X controls growth in cells"}), want), null);
});

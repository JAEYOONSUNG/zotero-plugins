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

test("a trashed duplicate is recoverable, and nothing on disk is touched", async () => {
  // Zotero's trash is undoable; deleting the file would not be. The user has
  // seventeen of these, and every one of them is their own file.
  const { createRequire } = await import("node:module");
  const Runtime = createRequire(import.meta.url)("../src/runtime.js");
  const saved = [];
  const store = {"22": {kind: "duplicate"}, "23": {kind: "article"}};
  const items = new Map([
    [22, {id: 22, libraryID: 1, deleted: false, async saveTx() { saved.push(this.id); }}],
    [24, {id: 24, libraryID: 2, deleted: false, async saveTx() { saved.push(this.id); }}]
  ]);
  const host = {
    cache: {fileKinds: store}, dirty: false,
    Z: {Items: {get: id => items.get(id)}, Libraries: {get: id => ({editable: id === 1})}},
    fileVerdicts: Runtime.prototype.fileVerdicts,
    trashAttachments: Runtime.prototype.trashAttachments,
    async flush() {}, async refreshWindows() {}
  };
  const result = await host.trashAttachments([22, 24, 999]);
  assert.equal(result.moved, 1);
  assert.equal(result.skipped, 2, "a read-only library and a missing item are skipped, not forced");
  assert.equal(items.get(22).deleted, true);
  assert.equal(items.get(24).deleted, false);
  assert.deepEqual(saved, [22]);
  assert.equal(store["22"], undefined, "its verdict goes with it");
  assert.equal(store["23"].kind, "article");
});

test("a file Zotero has not indexed is indexed first, not written off", async () => {
  // Eleven of this library's attachments had no extracted text, so they could
  // not be judged at all. Asking Zotero to index them is the same extraction
  // its own search does, and turns "cannot tell" into an answer.
  const { createRequire } = await import("node:module");
  const Runtime = createRequire(import.meta.url)("../src/runtime.js");
  const indexed = [];
  const cache = new Map([[1, ""], [2, "ORIGINAL RESEARCH A paper about thermophiles and their enzymes"]]);
  const attachment = id => ({id, key: "K" + id, deleted: false, attachmentContentType: "application/pdf",
    attachmentFilename: `f${id}.pdf`, isFileAttachment: () => true});
  const item = {id: 9, getField: key => key === "title" ? "A paper about thermophiles and their enzymes" : "",
    getAttachments: () => [1, 2], isRegularItem: () => true};
  const host = {
    cache: {items: {}, fileKinds: {}}, active: true, stopping: false, dirty: false,
    Z: {
      logError() {}, Items: {get: id => attachment(id)},
      FullText: {async indexItems(ids) { indexed.push(...ids); for (const id of ids) cache.set(id, "Supplementary Information for A paper about thermophiles"); }}
    },
    fileTools: kinds, isRegular: () => true,
    fileVerdicts: Runtime.prototype.fileVerdicts,
    indexAttachments: Runtime.prototype.indexAttachments,
    scanAttachmentKinds: Runtime.prototype.scanAttachmentKinds,
    attachmentText: async a => cache.get(a.id) || "",
    async flush() {}, async refreshWindows() {}
  };
  const result = await host.scanAttachmentKinds([item]);
  assert.deepEqual(indexed, [1], "only the file with no text is indexed");
  assert.equal(result.indexed, 1);
  assert.equal(result.unread, 0, "once indexed it is no longer unreadable");
  assert.equal(host.cache.fileKinds["1"].kind, "supplementary");
  assert.equal(host.cache.fileKinds["2"].kind, "article");
});

test("a scan can be told not to index, and then simply reports what it could not read", async () => {
  // The option used to be called `index`, which the enclosing loop counter
  // shadowed: 0 !== false, so every scan indexed regardless of what was asked.
  const { createRequire } = await import("node:module");
  const Runtime = createRequire(import.meta.url)("../src/runtime.js");
  let asked = 0;
  const item = {id: 9, getField: () => "", getAttachments: () => [1], isRegularItem: () => true};
  const host = {
    cache: {items: {}, fileKinds: {}}, active: true, stopping: false, dirty: false,
    Z: {logError() {}, Items: {get: id => ({id, key: "K", deleted: false, attachmentContentType: "application/pdf",
      attachmentFilename: "f.pdf", isFileAttachment: () => true})},
      FullText: {async indexItems() { asked++; }}},
    fileTools: kinds, isRegular: () => true,
    fileVerdicts: Runtime.prototype.fileVerdicts,
    indexAttachments: Runtime.prototype.indexAttachments,
    scanAttachmentKinds: Runtime.prototype.scanAttachmentKinds,
    attachmentText: async () => "",
    async flush() {}, async refreshWindows() {}
  };
  const result = await host.scanAttachmentKinds([item], {buildIndex: false});
  assert.equal(asked, 0);
  assert.equal(result.unread, 1);
  assert.equal(result.indexed, 0);
});

test("a paper whose supplement is already on the shelf is not fetched again", async () => {
  const { createRequire } = await import("node:module");
  const Runtime = createRequire(import.meta.url)("../src/runtime.js");
  let requests = 0;
  const host = {
    cache: {fileKinds: {"7": {kind: "supplementary"}}},
    Z: {HTTP: {request() { requests++; throw new Error("should not have asked"); }}, Items: {get: () => null}},
    supplementaryTools: {searchURL: () => "https://example.invalid/"},
    contactEmail: () => "",
    bibliographyRecord: () => ({DOI: "10.1/x", title: "A paper"}),
    fileVerdicts: Runtime.prototype.fileVerdicts,
    fetchSupplementary: Runtime.prototype.fetchSupplementary,
    attachmentKinds: () => [{id: "7", kind: "supplementary", read: true, name: "si.pdf"}]
  };
  const result = await host.fetchSupplementary({id: 1});
  // The old check compared publisher filenames, which a file mover renames
  // away; every one of this library's twenty-nine supplements would have been
  // downloaded a second time.
  assert.equal(result.status, "already");
  assert.equal(result.skipped, 1);
  assert.equal(requests, 0, "and it costs no request at all");

  // Asking for it again explicitly still goes out to the network.
  await assert.rejects(() => host.fetchSupplementary({id: 1}, {refetch: true}));
  assert.equal(requests, 1);
});

test("a supplement that was just downloaded is badged without waiting for a scan", async () => {
  const { createRequire } = await import("node:module");
  const Runtime = createRequire(import.meta.url)("../src/runtime.js");
  const saved = [];
  const attachment = {id: 42, tags: [], addTag(tag) { this.tags.push(tag); },
    setField() {}, async saveTx() { saved.push(this.id); }};
  const host = {
    cache: {fileKinds: {}}, dirty: false, SUPPLEMENTARY_TAG: "style-custom:supplementary",
    Z: {logError() {}},
    supplementaryTools: {attachmentTitle: file => "Supplementary: " + file.name},
    fileVerdicts: Runtime.prototype.fileVerdicts,
    markSupplementary: Runtime.prototype.markSupplementary
  };
  await host.markSupplementary(attachment, {name: "mmc1.pdf"});
  assert.equal(host.cache.fileKinds["42"].kind, "supplementary");
  assert.match(host.cache.fileKinds["42"].why, /내려받았습니다/);
  assert.deepEqual(attachment.tags, ["style-custom:supplementary"]);
  assert.deepEqual(saved, [42]);
});

test("a supplement's home paper is suggested only when the answer is not a guess", () => {
  const library = [
    {id: "1", title: "Mechanism of DNA entrapment by a loop-extruding Wadjet SMC motor"},
    {id: "2", title: "Structural basis for plasmid restriction by SMC JET nuclease"},
    {id: "3", title: "Cell-free gene expression"}
  ];
  // The title route: the stub says what it is, minus the marker.
  const named = kinds.findHome(
    {id: "9", title: "[Supplementary] Mechanism of DNA entrapment by a loop-extruding Wadjet SMC motor", text: ""},
    library);
  assert.equal(named.id, "1");
  assert.equal(named.viaTitle, true);

  // A three-word title made of common words matches almost any document, and
  // matching one is not evidence of anything.
  assert.equal(kinds.findHome({id: "9", title: "", text: "cell free gene expression in a tube " + "x ".repeat(40)},
    library), null, "a short generic title is not a candidate at all");

  // Two candidates that fit equally well means the library holds a pair, and
  // picking one at random is the mistake this whole feature exists to find.
  const pair = kinds.findHome({id: "9", title: "Cell-free gene expression [Supplementary]", text: ""},
    [{id: "1", title: "Mechanism of DNA entrapment by a loop-extruding Wadjet SMC motor"},
     {id: "2", title: "Mechanism of DNA entrapment by a loop-extruding Wadjet SMC motor"}]);
  assert.equal(pair, null, "nothing matches, so nothing is suggested");

  const twins = kinds.findHome(
    {id: "9", title: "Structural basis for plasmid restriction by SMC JET nuclease", text: ""},
    [{id: "1", title: "Structural basis for plasmid restriction by SMC JET nuclease"},
     {id: "2", title: "Structural basis for plasmid restriction by SMC JET nuclease"}]);
  assert.equal(twins.id, null);
  assert.equal(twins.ambiguous.length, 2, "both are offered, and the user picks");

  // Body text is weaker evidence than a title: a supplement cites its
  // neighbours, and one here matched a different paper by the same group on the
  // same enzyme, fully, from a sentence in its methods.
  const cited = kinds.findHome({id: "9", title: "",
    text: "Supplementary Information " + "filler ".repeat(120)
      + " see also Protein Engineering of Tagatose 4-Epimerase for D-Tagatose Production"},
    [{id: "1", title: "Protein Engineering of Tagatose 4-Epimerase for D-Tagatose Production"}]);
  assert.equal(cited, null, "a mention below the title block does not count");
});

test("the supplement marker comes off a title without taking the title with it", () => {
  assert.equal(kinds.withoutMarker("Supplementrary_Landscape profiling of PET depolymerases"),
    "Landscape profiling of PET depolymerases", "an underscore separates words; a greedy \\w* ate both");
  assert.equal(kinds.withoutMarker("[Supplementary] An Orthogonal T7 Replisome"), "An Orthogonal T7 Replisome");
  assert.equal(kinds.withoutMarker("Cell-free gene expression [Supplementary]"), "Cell-free gene expression");
  assert.equal(kinds.withoutMarker("A paper about silicon si chips"), "A paper about silicon chips");
});

test("rehoming a supplement moves it and retires only an empty stub", async () => {
  const { createRequire } = await import("node:module");
  const Runtime = createRequire(import.meta.url)("../src/runtime.js");
  const make = (id, children = []) => ({id, deleted: false, parentItemID: null,
    getAttachments: () => children, async saveTx() { saved.push(id); }});
  const saved = [];
  const stub = make(10, [11]);
  const file = {id: 11, parentItemID: 10, async saveTx() { saved.push(11); }};
  const paper = make(20);
  const items = new Map([[10, stub], [11, file], [20, paper]]);
  const host = {cache: {}, dirty: false, Z: {Items: {get: id => items.get(id)}},
    isRegular: item => item !== file, rehomeSupplement: Runtime.prototype.rehomeSupplement,
    async flush() {}, async refreshWindows() {}};

  const result = await host.rehomeSupplement(11, 20);
  assert.equal(file.parentItemID, 20);
  assert.equal(result.moved, 1);
  assert.equal(result.trashed, 1, "the stub had nothing else on it");
  assert.equal(stub.deleted, true, "trashed, which Zotero can undo; no file is deleted");

  // A stub that still holds its own article is a real paper that happened to
  // carry someone else's supplement, and it stays.
  const keeper = make(30, [31]);
  const other = {id: 31, parentItemID: 30, async saveTx() {}};
  items.set(30, keeper); items.set(31, other);
  items.set(32, {id: 32, parentItemID: 30, async saveTx() {}});
  keeper.getAttachments = () => [31, 32];
  const second = await host.rehomeSupplement(32, 20);
  assert.equal(second.trashed, 0);
  assert.equal(keeper.deleted, false);
});

test("the download is counted before it is started, and closed articles are not attempted", async () => {
  const { createRequire } = await import("node:module");
  const Runtime = createRequire(import.meta.url)("../src/runtime.js");
  const supplementary = createRequire(import.meta.url)("../src/supplementary.js");
  // Measured over this library: 1,146 papers have a DOI, 697 are in PMC, 506 of
  // those say they have supplementary material, and only 336 are open access --
  // the only set whose archive the endpoint will hand over.
  const answers = {
    "10.1/open": {resultList: {result: [{doi: "10.1/open", pmcid: "PMC1", hasSuppl: "Y", isOpenAccess: "Y", source: "PMC"}]}},
    "10.1/closed": {resultList: {result: [{doi: "10.1/closed", pmcid: "PMC2", hasSuppl: "Y", isOpenAccess: "N", source: "PMC"}]}},
    "10.1/plain": {resultList: {result: [{doi: "10.1/plain", pmcid: "PMC3", hasSuppl: "N", isOpenAccess: "Y", source: "PMC"}]}},
    "10.1/elsewhere": {resultList: {result: [{doi: "10.1/elsewhere", id: "MED9", source: "MED"}]}},
    "10.1/unknown": {resultList: {result: []}}
  };
  let requests = 0;
  const item = (id, doi, kinds = []) => ({id, doi, kinds});
  const items = [item(1, "10.1/open"), item(2, "10.1/closed"), item(3, "10.1/plain"),
    item(4, "10.1/elsewhere"), item(5, "10.1/unknown"), item(6, ""),
    item(7, "10.1/open", [{kind: "supplementary"}]), item(8, "")];
  // Item 6 has no DOI but does have a title, and Europe PMC is searched by
  // title in that case; item 8 has neither, and cannot be looked up at all.
  items[7].noTitle = true;
  const host = {
    active: true, stopping: false, supplementaryTools: supplementary,
    Z: {logError() {}, HTTP: {async request(method, url) {
      requests++;
      const doi = decodeURIComponent(url).match(/DOI:"([^"]+)"/)?.[1];
      return {response: answers[doi] || {resultList: {result: []}}};
    }}},
    isRegular: () => true, contactEmail: () => "",
    attachmentKinds: it => it.kinds,
    bibliographyRecord: it => ({DOI: it.doi, title: it.noTitle ? "" : "Paper " + it.id}),
    previewSupplementary: Runtime.prototype.previewSupplementary
  };
  const report = await host.previewSupplementary(items);
  assert.deepEqual(report.available.map(row => row.id), ["1"]);
  assert.equal(report.closed, 1, "an article that is not open access answers with an XML error, not an archive");
  assert.equal(report.noSupplement, 1);
  assert.equal(report.notArchived, 1);
  assert.equal(report.notFound, 2, "the one with no DOI is still searched by title, and is not there");
  assert.equal(report.noIdentifier, 1, "the one with neither DOI nor title cannot be looked up");
  assert.equal(report.already, 1);
  // The two it could answer without asking cost nothing.
  assert.equal(requests, 6);
  assert.equal(report.errors, 0);
});

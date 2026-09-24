import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const path = require("../src/reading-path.js");

/* Each case below is a failure seen on a real paper from the user's library
   (nine papers, run live against OpenAlex and judged by a reader in the field),
   reduced to the smallest set of works that shows it. */

const subjects = (topic = "T1", subfield = "S1", field = "F1") =>
  ({topic: new Set([topic]), subfield: new Set([subfield]), field: new Set([field]), domain: new Set(["D1"])});
const work = (id, references = [], extra = {}) =>
  ({id, title: "Work " + id, year: 2015, citations: 50, type: "article", doi: "10.1/" + id.toLowerCase(),
    references, subjects: subjects(), ...extra});
const all = plan => plan.steps.flatMap(step => [...step.works, ...step.more]);
const section = (plan, key) => plan.steps.find(step => step.key === key);
const ids = (plan, key) => (section(plan, key)?.works || []).map(w => w.id);
const everywhere = (plan, key) => { const s = section(plan, key); return s ? [...s.works, ...s.more].map(w => w.id) : []; };

/* A small field. The paper cites A..E. B and C build on A; D on B.
   H is cited by A, B and C but not by the paper: the classic nobody names.
   X1, X2 are shared background. */
function field() {
  const seed = work("S", ["A", "B", "C", "D", "E", "X1", "X2"], {year: 2022});
  const refs = [
    work("A", ["H", "X1"], {year: 2008}),
    work("B", ["A", "H", "X1", "X2"], {year: 2012}),
    work("C", ["A", "H", "X1", "X2"], {year: 2014}),
    work("D", ["B", "X1", "X2", "A"], {year: 2018}),
    work("E", ["Q"], {year: 2010}),
    work("X1", [], {year: 2000}),
    work("X2", [], {year: 2001})
  ];
  const citers = [
    work("L1", ["S", "A", "B", "D", "X1", "X2"], {year: 2024}),
    work("R1", ["S", "A", "B", "C", "X1"], {year: 2025, type: "review", title: "A review of the field"})
  ];
  return {seed, refs, citers, foundations: [work("H", [], {year: 1999, count: 3})]};
}

test("the classics the references agree on are found even though the paper never cites them", () => {
  const {seed, refs} = field();
  assert.deepEqual(path.foundationCandidates(seed, refs, {floor: 3}), [{id: "H", count: 3}]);
});

test("the path runs overview, foundation, predecessor, the paper, continuation -- each in dependency order", () => {
  const f = field();
  const plan = path.plan(f.seed, f);
  assert.deepEqual(plan.steps.map(step => step.key), ["overview", "foundation", "predecessor", "seed", "continuation"]);
  assert.deepEqual(ids(plan, "overview"), ["R1"], "a review citing the paper is where to start");
  // A review written three years after the paper maps later ground: the start
  // is the foundation the references lean on most.
  const start = plan.steps.flatMap(step => step.works).find(w => w.start);
  assert.notEqual(start.id, "R1");
  assert.equal(section(plan, "foundation").works.some(w => w.start), true);
  const numbered = plan.steps.flatMap(step => step.works);
  assert.deepEqual(numbered.map(w => w.step), numbered.map((_, i) => i + 1), "one running number");
  const h = numbered.find(w => w.id === "H"), a = numbered.find(w => w.id === "A");
  assert.ok(h.step < a.step, "H underlies A, so it comes first");
  const seedRow = numbered.find(w => w.seed);
  assert.ok(numbered.filter(w => !w.after && !w.seed).every(w => w.step < seedRow.step));
  assert.deepEqual(ids(plan, "continuation"), ["L1"]);
});

test("a method is recognised by what it is, even inside the paper's own field (MMseqs2, Southern blots, a lab manual)", () => {
  const f = field();
  f.refs.push(work("M", [], {title: "MMseqs2 enables sensitive protein sequence searching", citations: 5400}));
  f.refs.push(work("SB", [], {title: "Detection of specific sequences among DNA fragments", citations: 32000, year: 1975, subjects: subjects("T9")}));
  f.refs.push(work("LM", [], {title: "Experiments in molecular genetics", type: "book", citations: 27000, year: 1972}));
  for (const r of f.refs.filter(r => ["A", "B", "C"].includes(r.id))) r.references.push("M", "SB", "LM");
  const plan = path.plan(f.seed, f);
  assert.deepEqual(everywhere(plan, "tools").sort(), ["LM", "M", "SB"]);
  assert.ok(!everywhere(plan, "foundation").some(id => ["M", "SB", "LM"].includes(id)));
});

test("a much-cited paper with a short reference list stays in the path when it is on the paper's own topic (Boeke 1984)", () => {
  const f = field();
  f.refs.find(r => r.id === "B").citations = 2400;
  f.refs.find(r => r.id === "B").references = ["A", "X1"];
  const plan = path.plan(f.seed, f);
  assert.ok(!everywhere(plan, "tools").includes("B"));
});

test("versions of one paper are one row, and the paper's own retitled preprint is not its predecessor", () => {
  const f = field();
  // The same citing paper three times: journal version and two preprint records.
  f.citers.push(work("L2", ["S", "A", "B", "X1", "X2"], {title: "Nanobody inhibitors of SMC", year: 2026, citations: 0}));
  f.citers.push(work("L2p", ["S", "A", "B", "X1", "X2"], {title: "Nanobody Inhibitors of SMC.", type: "preprint", year: 2025, citations: 3}));
  f.citers.push(work("L2q", ["S", "A", "B", "X1"], {title: "nanobody inhibitors of <i>SMC</i>", type: "preprint", year: 2025}));
  // The paper's preprint, retitled, sharing nearly all its references.
  f.refs.push(work("Sp", ["A", "B", "C", "D", "E", "X1", "X2"], {title: "Targeted DNA integration in human cells without double-strand breaks using CRISPR RNA-guided transposases", type: "preprint", year: 2021}));
  f.seed.title = "Targeted DNA integration in human cells without double-strand breaks using CRISPR-associated transposases";
  f.seed.references.push("Sp");
  const plan = path.plan(f.seed, f);
  const rows = all(plan).concat(plan.rest).map(w => w.id);
  assert.equal(rows.filter(id => id.startsWith("L2")).length, 1, "three records, one row");
  assert.ok(rows.includes("L2"), "the journal version is the one kept");
  assert.ok(!rows.includes("Sp"), "the paper's own preprint is gone");
  assert.equal(section(plan, "seed").works[0].versions, 2);
});

test("a citer that is the journal version of a preprint the paper cited is not listed twice", () => {
  const f = field();
  f.refs.push(work("P1", ["A", "B", "X1"], {title: "Pattern receptors sense the phage proteome", type: "preprint", year: 2021}));
  f.seed.references.push("P1");
  f.citers.push(work("P1j", ["S", "A", "B", "X1"], {title: "Pattern Receptors Sense the Phage Proteome", year: 2026}));
  const plan = path.plan(f.seed, f);
  assert.ok(!all(plan).some(w => w.id === "P1j"));
});

test("continuation means continuing the line of work, not citing the paper from another field (m6A and EcoP15I)", () => {
  const f = field();
  // Same topic by OpenAlex's reckoning, plenty of shared references -- all of
  // them in the paper's second thread, none in the line it stands on.
  f.seed.references.push("M1", "M2", "M3", "M4");
  f.refs.push(...["M1", "M2", "M3", "M4"].map(id => work(id, [], {year: 2013})));
  f.citers.push(work("MW", ["S", "M1", "M2", "M3", "M4"], {year: 2016, citations: 1200}));
  const plan = path.plan(f.seed, f);
  assert.ok(!everywhere(plan, "continuation").includes("MW"));
  assert.ok(everywhere(plan, "continuation").includes("L1"));
});

test("a foundation that builds on a predecessor pulls it into the foundations, so nothing needs a later step", () => {
  const f = field();
  // Hidden classic H2 cites D (a predecessor): D is foundational after all.
  f.foundations.push(work("H2", ["D"], {year: 2019, count: 3}));
  for (const r of f.refs.filter(r => ["A", "B", "C"].includes(r.id))) r.references.push("H2");
  const plan = path.plan(f.seed, f, {show: {foundation: 12}});
  assert.ok(everywhere(plan, "foundation").includes("D"));
  const numbered = plan.steps.flatMap(step => step.works);
  const byStep = new Map(numbered.map(w => [w.id, w.step]));
  for (const w of numbered) for (const n of w.needs) assert.ok(n < w.step, `${w.id} needs ${n}, which comes later`);
  assert.ok(byStep.get("D") < byStep.get("H2") || !byStep.has("H2"));
});

test("'read first' names only a step in an earlier section, and a citation loop does not erase it", () => {
  const f = field();
  // B and D cite each other (same-month preprints); D also stands on A.
  f.refs.find(r => r.id === "B").references.push("D");
  f.refs.find(r => r.id === "D").year = 2012;
  const plan = path.plan(f.seed, f, {show: {foundation: 1, predecessor: 5}});
  const numbered = plan.steps.flatMap(step => step.works);
  const section = new Map(plan.steps.flatMap(step => step.works.map(w => [w.step, step.key])));
  for (const step of plan.steps) for (const w of step.works) {
    for (const n of w.needs) assert.notEqual(section.get(n), step.key, "within a section the order already says it");
  }
  assert.ok(numbered.some(w => w.needs.length), "the loop left the cross-section hints in place");
});

test("a review in hand is read to find its sources: its plan is the primary papers it rests on", () => {
  const f = field();
  f.seed.title = "Bacterial DNA methylation: a review";
  const plan = path.plan(f.seed, f);
  assert.equal(plan.mode, "review");
  assert.ok(plan.steps.some(step => step.key === "primary"));
  assert.ok(!plan.steps.some(step => step.key === "predecessor"));
});

test("a method's citers are uses of the method, not its continuation", () => {
  const f = field();
  Object.assign(f.seed, {title: "5-Fluoroorotic acid as a selective agent", type: "book-chapter", citations: 1400});
  const plan = path.plan(f.seed, f);
  assert.equal(plan.mode, "method");
  assert.ok(plan.steps.some(step => step.key === "uses"));
  assert.ok(!plan.steps.some(step => step.key === "continuation"));
});

test("a long bibliography makes a review, unless the title reports a finding or it is a preprint", () => {
  const refs = Array.from({length: 130}, (_, i) => "R" + i);
  assert.equal(path.isReview({title: "Connecting the dots: ParB for chromosome segregation", references: refs}), true);
  assert.equal(path.isReview({title: "Novel genes required for surface motility", references: refs}), false);
  assert.equal(path.isReview({title: "Repurposing a ParB fold into a toxin", type: "preprint", references: refs}), false);
  assert.equal(path.isReview({title: "Subunit assembly of EcoP1I", type: "book-review"}), false);
});

test("a citation to a work years newer, and a citation loop, do not break the order", () => {
  const {depth} = path.depths([
    work("P", ["Q"], {year: 2000}), work("Q", ["P"], {year: 2020}),
    work("M", ["N"], {year: 2010}), work("N", ["M"], {year: 2010})
  ]);
  assert.equal(depth.get("P"), 0, "P cannot have built on something twenty years later");
  assert.equal(depth.get("Q"), 1);
  assert.ok(Number.isInteger(depth.get("M")) && Number.isInteger(depth.get("N")), "a loop ends");
});

test("the reasons say what put a paper at its step, in phrases that translate one by one", () => {
  const f = field();
  const plan = path.plan(f.seed, f);
  const find = id => all(plan).find(w => w.id === id);
  assert.deepEqual(path.reasons(find("H"), "foundation"), ["참고문헌 3편이 인용", "이 논문 참고문헌엔 없음"]);
  assert.match(path.reason(find("L1"), "continuation"), /참고문헌 \d+편 겹침/);
  assert.deepEqual(path.reasons(find("R1"), "overview").slice(0, 1), ["이 논문을 인용한 리뷰"]);
});

test("owned papers are marked, and a paper with no references still gets its reviews and continuation", () => {
  const {seed, citers} = field();
  const plan = path.plan({...seed, references: []}, {refs: [], citers, have: new Set(["10.1/l1"])});
  assert.deepEqual(plan.steps.map(step => step.key), ["overview", "seed", "continuation"]);
  assert.equal(section(plan, "continuation").works[0].inLibrary, true);
  assert.equal(path.plan(null), null);
});

test("the line under a paper is what it established, from its own abstract, never its outlook", () => {
  const d = require("../src/discover.js");
  const index = text => { const out = {}; text.split(" ").forEach((w, i) => (out[w] = out[w] || []).push(i)); return out; };
  const abstract = d.abstractOf(index("PET is a major plastic. Here, we uncover a new enzyme family in compost. We show that the enzyme depolymerizes PET at 70 C within ten hours. We anticipate that our strategy will provide a route to recycling."));
  assert.equal(d.findingOf(abstract), "We show that the enzyme depolymerizes PET at 70 C within ten hours.");
  assert.equal(d.findingOf("Finally, we outline future developments in the field of gene editing."), "");
  assert.match(d.findingOf("Plastics are everywhere today. Here we review enzymes that degrade polyesters and polyamides.", {review: true}), /^Here we review/);
  assert.equal(d.findingOf(""), "");
});

test("the journal decides a review before any count does (a 149-reference FEMS review)", () => {
  assert.equal(path.isReview({title: "DNA methyltransferases and epigenetic regulation in bacteria", venue: "FEMS Microbiology Reviews", references: Array(149).fill("R")}), true);
  assert.equal(path.isReview({title: "A study", venue: "Trends in Microbiology"}), true);
  assert.equal(path.isReview({title: "A study", venue: "Nucleic Acids Research"}), false);
});

test("a paper filed under the wrong topic is placed where its references sit, and a toolkit keeps its tools as lineage", () => {
  const f = field();
  const lab = subjects("TK", "SB", "FB");
  // OpenAlex put the toolkit paper under spacecraft; all its references disagree.
  f.seed.subjects = subjects("SPACE", "AERO", "ENG");
  f.seed.abstract = "Engineering undomesticated microbes is slow. Here we developed a scalable, high-throughput pipeline to evaluate engineerability.";
  for (const r of f.refs) r.subjects = lab;
  for (const [id, title] of [["SEVA", "The Standard European Vector Architecture (SEVA)"], ["MOCLO", "A MoClo assembly standard"], ["GG", "Golden Gate cloning toolkit"]]) {
    f.refs.push(work(id, ["A"], {title, subjects: lab, year: 2012}));
    f.seed.references.push(id);
  }
  for (const r of f.refs.filter(r => ["B", "C", "D"].includes(r.id))) r.references.push("SEVA");
  const plan = path.plan(f.seed, f);
  assert.ok(!everywhere(plan, "tools").includes("SEVA"), "a toolkit's toolkits are its lineage");
  assert.ok(all(plan).some(w => w.id === "SEVA"));
});

test("citing many tools does not make a paper a toolkit: a structure paper keeps MMseqs2 among its tools", () => {
  const f = field();
  for (const [id, title] of [["M", "MMseqs2 enables sensitive searching"], ["AF", "Highly accurate protein structure prediction with AlphaFold"], ["IP", "InterProScan 5"]]) {
    f.refs.push(work(id, [], {title, citations: 5000}));
    f.seed.references.push(id);
    for (const r of f.refs.filter(r => ["A", "B", "C"].includes(r.id))) r.references.push(id);
  }
  f.seed.abstract = "Bacteria sense phage. We show that a screen identifies triggers of immunity.";
  const plan = path.plan(f.seed, f);
  assert.ok(everywhere(plan, "tools").includes("M"));
  assert.ok(!everywhere(plan, "foundation").includes("M"));
});

test("biology is not a tool name: muscle, rice blast, a chimera, a transcriptional program", () => {
  for (const title of ["Skeletal muscle stem cells regenerate", "Rice blast fungus effectors", "A chimera of two nucleases",
    "A transcriptional program for sporulation", "Muscle stem cells in ageing"]) {
    assert.equal(path.isTool({title, citations: 50, references: Array(40).fill("R")}), false, title);
  }
  assert.equal(path.isTool({title: "MUSCLE: multiple sequence alignment with high accuracy", references: []}), "titled");
  assert.equal(path.isTool({title: "Basic local alignment search tool (BLAST)", references: []}), "titled");
  const f = field();
  Object.assign(f.seed, {title: "Muscle stem cells in ageing"});
  assert.equal(path.plan(f.seed, f).mode, "paper", "a muscle paper is not a methods paper");
});

test("a reference with a non-Latin title does not hide every citer whose title is also non-Latin", () => {
  const f = field();
  f.refs.push(work("KO", ["A"], {title: "한국어 제목의 논문"}));
  f.seed.references.push("KO");
  f.citers.push(work("K1", ["S", "A", "B", "D", "X1", "X2"], {title: "희귀당 효소의 구조", year: 2024}));
  const plan = path.plan(f.seed, f);
  assert.ok(everywhere(plan, "continuation").includes("K1"));
});

test("two works titled 'Correction' years apart are two works; a one-letter typo between versions is one", () => {
  const {kept} = path.mergeVersions([
    work("C1", [], {title: "Correction", year: 2010}), work("C2", [], {title: "Correction", year: 2019}),
    work("K1", [], {title: "Ketose-3-epimerases for rare sugar production in bacteria", year: 2016}),
    work("K2", [], {title: "Ketoso-3-epimerases for rare sugar production in bacteria", year: 2016, type: "preprint"})
  ]);
  assert.deepEqual(kept.map(w => w.id).sort(), ["C1", "C2", "K1"]);
});

test("a predecessor pulled into the foundations keeps a numbered place next to the work that needs it", () => {
  const f = field();
  f.foundations.push(work("H2", ["D"], {year: 2019, count: 3}));
  for (const r of f.refs.filter(r => ["A", "B", "C"].includes(r.id))) r.references.push("H2");
  for (const id of ["F1", "F2", "F3", "F4"]) {
    f.refs.push(work(id, [], {year: 2001}));
    f.seed.references.push(id);
    for (const r of f.refs.filter(r => ["A", "B", "C"].includes(r.id))) r.references.push(id);
  }
  const plan = path.plan(f.seed, f);
  const shown = section(plan, "foundation").works.map(w => w.id);
  if (shown.includes("H2")) assert.ok(shown.includes("D"), "H2 is shown, so what it stands on is shown too");
  assert.ok(everywhere(plan, "foundation").includes("D"));
  const d = everywhere(plan, "foundation").indexOf("D"), h = everywhere(plan, "foundation").indexOf("H2");
  assert.ok(d < h, "D sits before H2");
});

test("a Perspective in a research journal is read as a review from its own abstract", () => {
  assert.equal(path.isReview({title: "Protein dynamism and evolvability", venue: "Science", references: Array(47).fill("R"),
    abstract: "Proteins move. Here we discuss how conformational diversity enables new functions."}), true);
  assert.equal(path.isReview({title: "A screen identifies triggers", venue: "Science", references: Array(47).fill("R"),
    abstract: "We show that phage proteins trigger immunity."}), false);
});

test("an essay that argues and reports nothing is a perspective; a protocol journal makes a method paper", () => {
  assert.equal(path.isReview({title: "Protein dynamism and evolvability", venue: "Science", references: Array(47).fill("R"),
    abstract: "The traditional view conflicts with adaptation. We consider an alternative view. We surmise that these properties matter."}), true);
  assert.equal(path.isReview({title: "X", venue: "Science", references: Array(47).fill("R"),
    abstract: "We consider two models. We show that the second fits the data."}), false);
  const f = field();
  Object.assign(f.seed, {title: "A new tool for the flexible genetic manipulation of Geobacillus", venue: "Bio-protocol"});
  assert.equal(path.plan(f.seed, f).mode, "method");
});

test("the same subject is the rare words in common, and survives a changed word ending", () => {
  const f = field();
  f.seed.title = "CBASS immunity uses CARF-related effectors to sense cyclic oligonucleotide signals and protect bacteria from phage";
  const generic = ["CRISPR system in bacteria", "Phage defence in bacteria", "Bacteria and phage systems", "Type III CRISPR bacteria", "Bacteria phage type"];
  f.refs.push(...generic.map((title, i) => work("G" + i, [], {title})));
  f.refs.push(work("CO", ["A"], {title: "Cyclic GMP-AMP signalling protects bacteria against viral infection", year: 2019}));
  f.refs.push(work("GAS", ["A"], {title: "Lactobacillus gasseri type II CRISPR system in bacteria", year: 2019}));
  f.seed.references.push("CO", "GAS", ...generic.map((_, i) => "G" + i));
  for (let i = 0; i < 10; i++) f.citers.push(work("Z" + i, ["S"], {title: "Unrelated bacteria phage paper number " + i}));
  const plan = path.plan(f.seed, f);
  const rows = [...all(plan), ...plan.rest];
  assert.equal(rows.find(w => w.id === "CO")?.sameSubject, true, "cyclic + signal(l)ing + protect(s): rare words shared");
  assert.equal(rows.find(w => w.id === "GAS")?.sameSubject, false, "CRISPR, type, system, bacteria are everywhere");
});

test("Cas12a and Cas12k are two proteins, and 'we discuss the implications' does not make a research paper a review", () => {
  const {kept} = path.mergeVersions([
    work("A", [], {title: "Structure of the Cas12a effector complex bound to target DNA", year: 2020}),
    work("K", [], {title: "Structure of the Cas12k effector complex bound to target DNA", year: 2020})
  ]);
  assert.equal(kept.length, 2);
  assert.equal(path.isReview({title: "X", references: Array(60).fill("R"),
    abstract: "Here we report the structure of X. It reveals a pocket. We discuss implications for evolution."}), false);
});

test("with few titles, shared field words are not a subject", () => {
  const f = field();
  f.seed.title = "Structural basis for recognition of DNA by a bacterial protein complex";
  f.refs.push(work("G", [], {title: "Structural basis of protein recognition in bacterial DNA complexes"}));
  f.seed.references.push("G");
  const rows = [...all(path.plan(f.seed, f)), ...path.plan(f.seed, f).rest];
  assert.notEqual(rows.find(w => w.id === "G")?.sameSubject, true);
});

test("what a title rules out is not its subject: 'without double-strand breaks'", () => {
  const f = field();
  f.seed.title = "Targeted DNA integration in human cells without double-strand breaks using CRISPR-associated transposases";
  f.refs.push(work("KO", ["A"], {title: "Repair of double-strand breaks induced by CRISPR-Cas9 leads to large deletions in human cells"}));
  f.seed.references.push("KO");
  const plan = path.plan(f.seed, f);
  assert.notEqual([...all(plan), ...plan.rest].find(w => w.id === "KO")?.sameSubject, true);
});

test("the milestones are the works this paper's own lineage leans on, one per era", () => {
  const sub = {topic: new Set(["T"]), subfield: new Set(["S"]), field: new Set(["F"])};
  const W = (id, year, refs, extra = {}) => ({id, doi: "10.5555/" + id, title: extra.title || ("Work " + id),
    year, type: extra.type || "article", citations: extra.citations ?? 50, venue: "Journal",
    references: refs, related: [], subjects: sub, authors: ["A"], abstract: ""});
  // An origin every later work stands on, a turn the field took, and the step
  // just before the paper -- plus a manual everybody cites and nobody builds on.
  // Citation counts the field would actually show: a milestone is one the
  // field noticed, so the fixture gives them each a few hundred.
  const origin = W("ORIGIN", 1990, [], {citations: 400});
  const turn = W("TURN", 2004, ["ORIGIN"], {citations: 300});
  const near = W("NEAR", 2018, ["ORIGIN", "TURN"], {citations: 200});
  const manual = W("MANUAL", 1972, [], {title: "Experiments in Molecular Genetics", citations: 20000});
  const refs = [];
  for (let i = 0; i < 10; i++) refs.push(W("R" + i, 2010 + (i % 6), ["ORIGIN", "TURN", "MANUAL"].concat(i > 5 ? ["NEAR"] : [])));
  refs.push(near);
  const seed = W("SEED", 2022, [...refs.map(r => r.id), "ORIGIN"]);
  const found = path.milestones(seed, refs, [...refs, origin, turn, near, manual], {have: new Set(["10.5555/TURN"])});
  const ids = found.line.map(w => w.id);
  assert.ok(ids.includes("ORIGIN") && ids.includes("NEAR"), "the origin and the step before it are both steps");
  assert.ok(!ids.includes("MANUAL"), "a manual everyone cites is not a milestone");
  assert.deepEqual(ids, [...ids].sort((a, b) => found.line.find(w => w.id === a).year - found.line.find(w => w.id === b).year),
    "the line reads forwards in time");
  assert.equal(found.line.find(w => w.id === "TURN").inLibrary, true, "a milestone already owned says so");
  assert.equal(found.line.find(w => w.id === "ORIGIN").cited, true, "the paper cites its own origin");
  /* A bibliography that shares almost nothing has no line of development to
     show, and two papers out of ten is not one. Saying nothing is the honest
     answer; drawing a timeline from that would invent a history. */
  const loose = [];
  for (let i = 0; i < 10; i++) loose.push(W("L" + i, 2000 + i, ["X" + i]));
  loose[0].references = ["ORIGIN"]; loose[1].references = ["ORIGIN"]; loose[2].references = ["TURN"];
  assert.equal(path.milestones(W("S2", 2020, loose.map(r => r.id)), loose, [...loose, origin, turn]), null);
});

test("no milestones rather than a line of one", () => {
  assert.equal(path.milestones({id: "S", year: 2020, references: []}, [], []), null);
});

test("specificity is a gate at a fixed floor, and a lineage too thin to draw draws nothing", () => {
  const sub = {topic: new Set(["T"]), subfield: new Set(["S"]), field: new Set(["F"])};
  const W = (id, year, refs, extra = {}) => ({id, doi: "10.5555/" + id, title: extra.title || ("Work " + id),
    year, type: "article", citations: extra.citations ?? 300, venue: "J", references: refs, related: [],
    subjects: sub, authors: ["A"], abstract: ""});
  /* The paper the field was built on: eight of ten references stand on it, and
     the citations that followed are the evidence it broke out, not a reason to
     drop it. Beside it, a work cited by the whole world and leaned on here by
     the same eight -- a thousandth of its citations -- is not a step. */
  const axis = W("AXIS", 2010, [], {title: "A bacterium that eats the polymer", citations: 1400});
  const step = W("STEP", 2014, ["AXIS"], {title: "Engineering the enzyme for activity", citations: 600});
  const late = W("LATE", 2019, ["AXIS", "STEP"], {title: "A depolymerase that recycles bottles", citations: 900});
  const everywhere = W("EVERY", 1990, [], {title: "A tool for sequence alignment", citations: 90000});
  const refs = [];
  for (let i = 0; i < 10; i++) refs.push(W("R" + i, 2016 + (i % 4), i < 8 ? ["AXIS", "STEP", "LATE", "EVERY"] : ["EVERY"]));
  const seed = W("SEED", 2022, refs.map(r => r.id));
  const found = path.milestones(seed, refs, [...refs, axis, step, late, everywhere]);
  const ids = found.line.map(w => w.id);
  assert.ok(ids.includes("AXIS"), "the paper the field stands on survives its own citation count");
  assert.ok(!ids.includes("EVERY"), "what everyone cites is not this paper's history");

  // Too few of the references share anything: no line rather than a wrong one.
  const loose = [];
  for (let i = 0; i < 12; i++) loose.push(W("L" + i, 2012 + i, i < 4 ? ["AXIS"] : ["Z" + i]));
  assert.equal(path.milestones(W("S2", 2024, loose.map(r => r.id)), loose, [...loose, axis]), null);
});

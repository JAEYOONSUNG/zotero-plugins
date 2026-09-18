import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const graph = require("../src/paper-graph.js");

const paper = (id, openalex, references, extra = {}) =>
  ({id, openalex, references, title: "Paper " + id, year: 2020, citations: 10, ...extra});

test("a stated citation and an inferred neighbour are not the same kind of edge", () => {
  const built = graph.build([
    paper(1, "W1", ["R1", "R2", "R3", "R4"]),
    paper(2, "W2", ["R1", "R2", "R3", "R9"]),
    paper(3, "W3", ["W1", "Z1", "Z2"])
  ]);
  const cites = built.edges.filter(edge => edge.kind === "cites");
  const coupled = built.edges.filter(edge => edge.kind === "coupled");
  assert.deepEqual(cites.map(edge => [edge.source, edge.target]), [["3", "1"]],
    "paper 3 cites paper 1, and that edge has a direction");
  assert.deepEqual(coupled.map(edge => [edge.source, edge.target]), [["1", "2"]]);
  assert.equal(coupled[0].shared, 3);
});

test("a stated citation is never also drawn as an inference", () => {
  // Two papers can both cite each other's sources and cite each other. Drawing
  // both edges would say the same thing twice, in two visual languages.
  const built = graph.build([
    paper(1, "W1", ["R1", "R2", "R3"]),
    paper(2, "W2", ["W1", "R1", "R2", "R3"])
  ]);
  assert.equal(built.edges.length, 1);
  assert.equal(built.edges[0].kind, "cites");
});

test("coupling asks what fraction of the reading is shared, not how long the lists are", () => {
  // A review with 300 references would otherwise be everybody's nearest
  // neighbour purely for having read widely.
  const short = new Set(["a", "b", "c", "d"]);
  const review = new Set([...Array(300).keys()].map(String).concat(["a", "b", "c", "d"]));
  const focused = new Set(["a", "b", "c", "e"]);
  assert.ok(graph.coupling(short, focused).score > graph.coupling(short, review).score);
});

test("a single shared reference is not a relationship", () => {
  const built = graph.build([
    paper(1, "W1", ["R1", "X1", "X2", "X3"]),
    paper(2, "W2", ["R1", "Y1", "Y2", "Y3"])
  ]);
  assert.deepEqual(built.edges, [], "one shared methods citation joins nothing");
});

test("what the library cites but does not hold is counted", () => {
  // The one thing a citation map tells you that reading your own shelf cannot.
  const built = graph.build([
    paper(1, "W1", ["KEY", "a", "b"]),
    paper(2, "W2", ["KEY", "c", "d"]),
    paper(3, "W3", ["KEY", "e", "f"]),
    paper(4, "W4", ["once"])
  ]);
  assert.deepEqual(built.missing.map(row => [row.id, row.citedBy.length]), [["KEY", 3]]);
});

test("trimming a dense graph keeps the strongest threads, not the first ones found", () => {
  const papers = [];
  for (let i = 1; i <= 12; i++) {
    papers.push(paper(i, "W" + i, ["core1", "core2", "core3"].concat(
      i <= 3 ? ["tight1", "tight2", "tight3", "tight4"] : ["spread" + i])));
  }
  const built = graph.build(papers, {maxEdges: 5});
  assert.equal(built.edges.length, 5);
  assert.ok(built.truncated);
  // The three papers that share seven references beat the pairs that share three.
  const top = built.edges.slice(0, 3).map(edge => [edge.source, edge.target].sort().join("-"));
  assert.deepEqual(top.sort(), ["1-2", "1-3", "2-3"]);
});

test("the same library lays out the same way twice", () => {
  const built = graph.build([paper(1, "W1", ["a", "b", "c"]), paper(2, "W2", ["a", "b", "c"]),
    paper(3, "W3", ["x"])]);
  const a = graph.layout(built, {width: 400, height: 300});
  const b = graph.layout(built, {width: 400, height: 300});
  assert.deepEqual(a.nodes.map(node => [node.x, node.y]), b.nodes.map(node => [node.x, node.y]),
    "a redraw must not look like a different graph");
  // Everything lands inside the box, with room for a label.
  for (const node of a.nodes) {
    assert.ok(node.x >= 0 && node.x <= 400, `x ${node.x}`);
    assert.ok(node.y >= 0 && node.y <= 300, `y ${node.y}`);
  }
});

test("a paper nothing connects to is set aside, not drawn as a ring round the edge", () => {
  // Drawn anyway, the unconnected papers form a ring outside everything else --
  // repulsion has nothing to hold them in and gravity stops them leaving -- and
  // that ring was most of the ink while carrying none of the structure.
  const built = graph.build([paper(1, "W1", ["a", "b", "c"]), paper(2, "W2", ["a", "b", "c"]),
    paper(3, "W3", []), paper(4, "W4", ["zz"])]);
  assert.deepEqual(built.nodes.map(node => node.id), ["1", "2"]);
  assert.deepEqual(built.isolated.map(node => node.id), ["3", "4"]);
  assert.equal(built.counted.isolated, 2);
  const laid = graph.layout(built, {width: 400, height: 300});
  assert.equal(laid.nodes.length, 2);
  assert.equal(laid.isolated.length, 2, "they are carried through so the panel can name them");
});

test("two papers never end up drawn on top of each other", () => {
  // A tight cluster used to collapse into one dot with forty labels on it.
  const papers = [];
  for (let i = 1; i <= 14; i++) papers.push(paper(i, "W" + i, ["a", "b", "c", "d"], {citations: i * 30}));
  const laid = graph.layout(graph.build(papers), {width: 600, height: 400});
  for (let i = 0; i < laid.nodes.length; i++) {
    for (let j = i + 1; j < laid.nodes.length; j++) {
      const a = laid.nodes[i], b = laid.nodes[j];
      const apart = Math.hypot(a.x - b.x, a.y - b.y);
      const want = graph.radiusOf(a.citations) + graph.radiusOf(b.citations);
      assert.ok(apart >= want * 0.9, `${a.id} and ${b.id} are ${apart.toFixed(1)} apart, need ${want.toFixed(1)}`);
    }
  }
});

test("node size follows the log of the citation count", () => {
  // Counts span orders of magnitude; a linear radius would make every paper in
  // a normal library the same invisible dot.
  const sizes = [0, 10, 100, 1000].map(graph.radiusOf);
  for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i] > sizes[i - 1]);
  assert.ok(sizes[0] >= 3, "an uncited paper is still a dot, not a point");
  assert.ok(sizes[3] <= 13);
  assert.equal(graph.radiusOf(-5), graph.radiusOf(0));
});

test("nothing to draw is answered with nothing, not an error", () => {
  assert.deepEqual(graph.build([]).nodes, []);
  assert.deepEqual(graph.layout({nodes: []}).nodes, []);
  assert.deepEqual(graph.build(null).edges, []);
  assert.equal(graph.coupling(new Set(), new Set(["a"])), 0);
});

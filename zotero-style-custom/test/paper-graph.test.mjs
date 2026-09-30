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

test("the work that cites yours joins the map, and the long tail does not", () => {
  /* References point backwards: they say what a paper was built on. Who built
     on it afterwards is the other half, and the half that says whether a thread
     is still moving. A paper citing one of yours is the long tail -- thousands
     of them, almost all noise on a map of your own field. */
  const papers = [paper(1, "W1", ["a", "b", "c"]), paper(2, "W2", ["a", "b", "c"]), paper(3, "W3", ["z"])];
  const citedBy = {
    1: [{id: "X1", title: "Builds on three", year: 2025, citations: 40},
        {id: "X2", title: "Cites one only", year: 2024, citations: 3}],
    2: [{id: "X1", title: "Builds on three", year: 2025, citations: 40}],
    3: [{id: "X1", title: "Builds on three", year: 2025, citations: 40}]
  };
  const built = graph.build(papers, {citedBy});
  assert.deepEqual(built.external.map(n => n.label), ["Builds on three"]);
  assert.equal(built.external[0].kind, "external");
  assert.equal(built.external[0].inLibrary, false);
  assert.equal(built.counted.incoming, 3, "one edge per paper of mine that it cites");

  // A paper of mine that nothing on my shelf touches is not isolated if later
  // work sits under it.
  assert.ok(built.nodes.some(n => n.id === "3"), "paper 3 is connected through its citer");
  assert.deepEqual(built.isolated.map(n => n.id), []);
});

test("size is centrality in this collection, not fame in the world", () => {
  /* A citation count is the same number whether you hold one paper or a
     thousand, and in a library of one field almost everything famous is famous.
     PageRank over your own citation edges says how much of your structure runs
     through a paper. */
  const nodes = [{id: "hub"}, {id: "a"}, {id: "b"}, {id: "c"}];
  const edges = [
    {source: "a", target: "hub", kind: "cites"},
    {source: "b", target: "hub", kind: "cites"},
    {source: "c", target: "hub", kind: "cites"},
    {source: "a", target: "b", kind: "coupled"}
  ];
  const rank = graph.pagerank(nodes, edges);
  assert.equal(rank.get("hub"), 1, "the most-depended-on is the top of the scale");
  assert.ok(rank.get("hub") > rank.get("a"));
  // A shared-reading thread is an inference about similarity, not a vote.
  const without = graph.pagerank(nodes, edges.filter(e => e.kind === "cites"));
  assert.equal(rank.get("hub"), without.get("hub"));
  // A paper citing nothing in the collection must not leak its rank away.
  const sum = [...graph.pagerank([{id: "x"}, {id: "y"}], []).values()].every(v => v > 0);
  assert.ok(sum, "with no edges at all, everything still has a rank");
});

test("nothing to fold is not an error", () => {
  const papers = [paper(1, "W1", ["a", "b", "c"]), paper(2, "W2", ["a", "b", "c"])];
  assert.deepEqual(graph.build(papers, {citedBy: {}}).external, []);
  assert.deepEqual(graph.build(papers, {citedBy: null}).external, []);
  // A citer that is already in the library is not also drawn as an outsider.
  const mine = graph.build(papers, {citedBy: {1: [{id: "W2", title: "Mine B"}]}});
  assert.deepEqual(mine.external, []);
});

test("a label is drawn when it fits, not when a number clears a threshold", () => {
  /* Showing a label for everything above a threshold put forty of them on top
     of each other in the middle of a real graph, which is worse than showing
     none: overlapping text is not readable and it hides the nodes underneath. */
  const crowd = [];
  for (let i = 0; i < 12; i++) {
    crowd.push({id: "n" + i, x: 100 + i * 2, y: 100 + i * 2, r: 5, degree: 5, rank: 0.5,
      labelText: "A fairly long journal label " + i});
  }
  const shown = graph.placeLabels(crowd);
  assert.ok(shown.size >= 1, "something is labelled");
  assert.ok(shown.size < crowd.length, "and the ones that would collide are not");

  // Spread out, they all fit.
  const spread = crowd.map((n, i) => ({...n, x: 50, y: 40 + i * 40}));
  assert.equal(graph.placeLabels(spread).size, spread.length);

  // Work you do not hold is the payoff of the map, so it is offered a label
  // before a paper already on the shelf.
  const mixed = [
    {id: "mine", x: 100, y: 100, r: 5, degree: 9, rank: 1, kind: "paper", labelText: "Mine here"},
    {id: "theirs", x: 104, y: 102, r: 5, degree: 1, rank: 0.1, kind: "external", labelText: "Theirs here"}
  ];
  const picked = graph.placeLabels(mixed);
  assert.ok(picked.has("theirs"), "the outside paper wins the contested spot");
  assert.equal(picked.has("mine"), false);

  // Nothing to label is not an error.
  assert.equal(graph.placeLabels([]).size, 0);
  assert.equal(graph.placeLabels([{id: "x", x: 0, y: 0, labelText: ""}]).size, 0);
});

test("label width is estimated per character, and Korean runs wider than Latin at the same length", () => {
  // A flat per-character guess treats "AAAAAAAAAAAA" and "가나다라마바사아자차카타"
  // (12 characters each) as the same box -- a gap that clears the Latin
  // pair actually overlaps once the glyphs are Korean-wide.
  const latin = [
    {id: "a", x: 0, y: 40, r: 5, degree: 1, rank: 0.2, labelText: "AAAAAAAAAAAA"},
    {id: "b", x: 90, y: 40, r: 5, degree: 1, rank: 0.2, labelText: "AAAAAAAAAAAA"}
  ];
  assert.equal(graph.placeLabels(latin).size, 2, "Latin labels at this spacing clear each other");
  const korean = latin.map(n => ({...n, labelText: "가나다라마바사아자차카타"}));
  assert.equal(graph.placeLabels(korean).size, 1, "the same spacing is not enough once the glyphs are Korean-wide");
});

test("a label that would run off the edge of the view is left out rather than clipped", () => {
  const near = [{id: "edge", x: 195, y: 50, r: 5, degree: 1, rank: 0.5, labelText: "A title long enough to overflow 2024"}];
  const bounded = graph.placeLabels(near, {width: 200, height: 100});
  assert.equal(bounded.size, 0, "the box would cross the right edge of the view");
  // The same node, unbounded, is placed -- so it is the view check doing this, not the collision check.
  assert.equal(graph.placeLabels(near).size, 1);
  // A short label with room to spare is placed as usual.
  const inside = [{id: "mid", x: 40, y: 50, r: 5, degree: 1, rank: 0.5, labelText: "OK 2024"}];
  assert.equal(graph.placeLabels(inside, {width: 200, height: 100}).size, 1);
});

test("placeLabelSides keeps every node, spreading close ones to different sides", () => {
  const pair = [
    {id: "a", x: 100, y: 100, r: 5, degree: 5, rank: 0.8, labelText: "First paper title"},
    {id: "b", x: 108, y: 101, r: 5, degree: 4, rank: 0.6, labelText: "Second paper title"}
  ];
  const sides = graph.placeLabelSides(pair);
  assert.equal(sides.size, 2, "nothing is dropped, unlike placeLabels");
  const a = sides.get("a"), b = sides.get("b");
  assert.ok(a && b, "every node got a placement");
  // Two nodes this close cannot both sit at the default right-of-node spot
  // without their boxes overlapping, so they must have picked different sides.
  assert.notDeepEqual([a.dx, a.dy, a.anchor], [b.dx, b.dy, b.anchor]);
});

test("placeLabelSides falls back to the default right-of-node spot when nothing else is nearby", () => {
  const lone = [{id: "solo", x: 50, y: 50, r: 5, degree: 1, rank: 0.2, labelText: "Alone"}];
  const sides = graph.placeLabelSides(lone);
  const spot = sides.get("solo");
  assert.equal(spot.anchor, "start");
  assert.equal(spot.dx, 5 + 4);
});

test("node size is centrality (PageRank within this graph), capped and floored like radiusOf but scaled by rank, not by citations", () => {
  assert.equal(graph.centralityRadius(0), 3.5, "the least central paper is still a dot");
  assert.equal(graph.centralityRadius(1), 13, "the most-depended-on paper in this graph is the largest");
  assert.ok(graph.centralityRadius(0.25) > graph.centralityRadius(0));
  assert.ok(graph.centralityRadius(0.25) < graph.centralityRadius(1));
  // Out-of-range input is clamped, the same way a negative citation count is.
  assert.equal(graph.centralityRadius(-1), graph.centralityRadius(0));
  assert.equal(graph.centralityRadius(5), graph.centralityRadius(1));
});

test("placeLabelSides keeps a label off the lines and off the other nodes when it can", () => {
  // b lies to the right of a on the same row, joined by an edge: the default spot (right of a)
  // sits on that edge, so a's label goes somewhere the line does not run.
  const nodes = [
    {id: "a", x: 100, y: 100, r: 5, degree: 3, rank: 0.9, labelText: "First paper"},
    {id: "b", x: 240, y: 100, r: 5, degree: 1, rank: 0.1, labelText: "Second"}
  ];
  const plain = graph.placeLabelSides(nodes).get("a");
  assert.equal(plain.dx, 5 + 4, "without edges the right-hand spot is taken, as before");
  const aware = graph.placeLabelSides(nodes, {edges: [{source: "a", target: "b"}]}).get("a");
  assert.ok(!(aware.anchor === "start" && aware.dy === 3.5), "with the edge known, a's label leaves the line");
  // A node in the way counts too: b's circle sits where a's right-hand label would be.
  const crowded = [
    {id: "a", x: 100, y: 100, r: 5, degree: 3, rank: 0.9, labelText: "First paper"},
    {id: "c", x: 130, y: 100, r: 9, degree: 1, rank: 0.1, labelText: "C"}
  ];
  const away = graph.placeLabelSides(crowded).get("a");
  assert.ok(!(away.anchor === "start" && away.dy === 3.5), "a label does not start on top of a neighbouring node");
});

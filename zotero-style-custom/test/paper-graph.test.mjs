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

test("a dense graph keeps at most the limit of labels, none overlapping each other or another paper's dot, the chosen paper first", () => {
  const nodes = [];
  for (let i = 0; i < 45; i++) nodes.push({id: "n" + i, x: 20 + (i * 53) % 400, y: 20 + (i * 97) % 380, r: 4 + (i % 5), degree: i % 7, rank: ((i * 13) % 100) / 100, labelText: "A long real-world paper title… " + (1990 + i % 35)});
  const opts = {width: 760, height: 420, lineHeight: 14, pad: 4, limit: 32, avoidDots: true};
  const shown = graph.placeLabels(nodes, opts);
  assert.ok(shown.size > 0 && shown.size <= 32, "limit respected: " + shown.size);
  const boxes = nodes.filter(n => shown.has(n.id)).map(n => ({n, x: n.x + n.r + 3 - 4, y: n.y - 7 - 4, w: graph.placeLabels.length >= 0 ? (String(n.labelText).length * 6.5 + 8) : 0, h: 22}));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    assert.ok(!(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y), "labels " + a.n.id + " and " + b.n.id + " collide");
  }
  const chosen = nodes[20];
  assert.ok(graph.placeLabels(nodes, {...opts, first: [chosen.id]}).has(chosen.id) || !(chosen.x + 200 < 760), "the chosen paper is offered its place first");
});

// ---- scopes: one paper, one collection ----
const shelf = () => [
  paper(1, "W1", ["W2", "W3", "G1", "G2"], {citations: 50}),
  paper(2, "W2", ["G1"], {citations: 5}),
  paper(3, "W3", [], {citations: 70}),
  paper(4, "W4", ["W1"], {citations: 3}),      // cites the centre
  paper(5, "W5", ["W4", "G1"]),                // two steps out: cites 4
  paper(6, "W6", ["G9"])                       // unrelated
];

test("one paper: what it cites, what cites it, ghosts for what the shelf lacks", () => {
  const g = graph.egoGraph("1", shelf(), {meta: {G1: {title: "Ghost one", year: 2001, citations: 900}}});
  const byRole = role => g.nodes.filter(n => n.role === role).map(n => n.id).sort();
  assert.equal(g.nodes[0].id, "1");
  assert.deepEqual(byRole("cites").filter(id => !id.startsWith("W:")), ["2", "3"]);
  assert.deepEqual(byRole("citedBy"), ["4"]);
  const ghosts = g.nodes.filter(n => n.kind === "ghost");
  assert.deepEqual(ghosts.map(n => n.id), ["W:G1", "W:G2"], "the more cited ghost first");
  assert.equal(ghosts[0].label, "Ghost one");
  assert.equal(ghosts[1].untitled, true);
  assert.ok(g.nodes.every(n => n.id !== "5" && n.id !== "6"), "depth 2 is off by default");
  assert.deepEqual({cites: g.counts.cites, citedBy: g.counts.citedBy, library: g.counts.library}, {cites: 4, citedBy: 1, library: 3});
  const has = (s, t) => g.edges.some(e => e.source === s && e.target === t && e.kind === "cites");
  assert.ok(has("1", "2") && has("1", "W:G1") && has("4", "1"), "arrows point from the citing paper");
  assert.ok(has("2", "W:G1"), "a shelf neighbour's own citation of a drawn ghost is an edge too");
});

test("one paper: depth 2 adds only shelf papers, and fetched citers become ghosts", () => {
  const g = graph.egoGraph("1", shelf(), {depth2: true, citers: [{id: "C1", title: "Later work", citations: 4}, {id: "W4"}, {id: "C1"}]});
  const near = g.nodes.filter(n => n.role === "near").map(n => n.id);
  assert.deepEqual(near, ["5"]);
  assert.ok(g.nodes.every(n => n.id !== "6"));
  assert.equal(g.counts.near, 1);
  const later = g.nodes.find(n => n.id === "W:C1");
  assert.equal(later.role, "citedBy");
  assert.equal(g.nodes.filter(n => n.openalex === "C1").length, 1, "a citer fetched twice is one node");
  assert.equal(g.nodes.filter(n => n.id === "4").length, 1, "a citer already on the shelf is not also a ghost");
  assert.equal(g.counts.citedBy, 2);
});

test("one paper: at most sixty nodes unless asked for all, shelf papers kept first", () => {
  const many = [paper(1, "W1", Array.from({length: 100}, (_, i) => "G" + i)), paper(2, "W2", ["W1"])];
  const g = graph.egoGraph("1", many, {limit: 60});
  assert.equal(g.nodes.length, 60);
  assert.ok(g.nodes.some(n => n.id === "2"), "the shelf paper survives the cut");
  assert.equal(g.cut, true);
  assert.equal(g.total, 102);
  const all = graph.egoGraph("1", many, {all: true});
  assert.equal(all.nodes.length, 102);
  assert.equal(all.cut, false);
  assert.equal(graph.egoGraph("nope", many), null);
  const laid = graph.egoLayout(all, {width: 760, height: 520});
  assert.ok(laid.nodes.every(n => n.x >= 0 && n.x <= 760 && n.y >= 0 && n.y <= 520));
});

test("a collection is its own papers, and with sub the ones filed below it", () => {
  const cols = [{id: "1", parentID: null, itemIDs: [1, 2]}, {id: "2", parentID: "1", itemIDs: [3]}, {id: "3", parentID: "2", itemIDs: [4, 2]}, {id: "4", parentID: null, itemIDs: [9]}];
  assert.deepEqual([...graph.collectionItemIDs(cols, "1", {sub: false})].sort(), ["1", "2"]);
  assert.deepEqual([...graph.collectionItemIDs(cols, "1", {sub: true})].sort(), ["1", "2", "3", "4"]);
  assert.deepEqual([...graph.collectionItemIDs(cols, "2")].sort(), ["2", "3", "4"]);
  assert.equal(graph.collectionItemIDs(cols, "missing").size, 0);
  const loop = [{id: "1", parentID: "2", itemIDs: [1]}, {id: "2", parentID: "1", itemIDs: [2]}];
  assert.equal(graph.collectionItemIDs(loop, "1").size, 2, "a cycle ends");
});

test("outside works are ranked by how many of the set cite them, shelf copies named", () => {
  const set = [paper(1, "W1", ["G1", "G2", "W7"]), paper(2, "W2", ["G1", "G2", "G3"]), paper(3, "W3", ["G1", "W1"])];
  const held = [...set, paper(7, "W7", [], {title: "Held elsewhere"})];
  const out = graph.outsideCited(set, {held, meta: {G2: {title: "Two", citations: 5}}, floor: 2});
  assert.deepEqual(out.map(o => [o.openalex, o.count]), [["G1", 3], ["G2", 2]], "G3 is cited once and W7 is cited once");
  assert.equal(out[1].title, "Two");
  assert.equal(graph.outsideCited(set, {held, floor: 1}).find(o => o.openalex === "W7").heldID, "7");
  assert.equal(graph.outsideCited(set, {held, floor: 1}).some(o => o.openalex === "W1"), false, "a paper inside the set is not outside it");
  assert.equal(graph.clusterCount(["1", "2", "3", "4"], [{source: "1", target: "2"}]), 1);
});

test("F3: a paper whose only thread was trimmed from the drawing is not reported as unconnected, and the counts are the whole library's", () => {
  const papers = [];
  for (let i = 1; i <= 12; i++) {
    papers.push(paper(i, "W" + i, ["core1", "core2", "core3"].concat(
      i <= 3 ? ["tight1", "tight2", "tight3", "tight4"] : ["spread" + i])));
  }
  const full = graph.build(papers, {maxEdges: 900});
  const cut = graph.build(papers, {maxEdges: 5});
  assert.ok(cut.truncated);
  assert.equal(cut.edges.length, 5);
  assert.equal(cut.isolated.length, full.isolated.length, "trimming the drawing must not create unconnected papers");
  assert.equal(cut.counted.isolated, full.counted.isolated);
  assert.equal(cut.counted.coupled, full.counted.coupled, "the tile counts every edge found, not the drawn ones");
  assert.equal(cut.counted.total, full.edges.length);
  assert.equal(cut.counted.drawn, 5);
});

test("F4: two copies of one OpenAlex work are not coupled to each other and cite a missing work once", () => {
  const built = graph.build([
    paper(1, "W1", ["R1", "R2", "R3", "M1"]),
    paper(2, "W1", ["R1", "R2", "R3", "M1"]),
    paper(3, "W3", ["M1", "x"]),
    paper(4, "W4", ["M1", "y"])
  ], {missingFloor: 3});
  assert.equal(built.edges.some(e => e.kind === "coupled" && [e.source, e.target].sort().join() === "1,2"), false);
  const m1 = built.missing.find(row => row.id === "M1");
  assert.equal(m1.citedBy.length, 3, "W1 (two copies), W3 and W4: three works, not four items");
});

test("F4: outsideCited counts distinct works, and ego citers dedupe copies", () => {
  const set = [paper(1, "W1", ["G1", "G2"]), paper(2, "W1", ["G1", "G2"]), paper(3, "W3", ["G1"])];
  const out = graph.outsideCited(set, {floor: 2});
  assert.deepEqual(out.map(o => [o.openalex, o.count]), [["G1", 2]], "G1 is cited by two works; G2 by one");
  const shelf = [paper(1, "W1", []), paper(2, "W2", ["W1"]), paper(3, "W2", ["W1"]), paper(4, "W1", ["W1"])];
  const g = graph.egoGraph("1", shelf);
  assert.equal(g.counts.citedBy, 1, "two copies of W2 are one citer; the second copy of the centre is not a citer");
});

test("F2: outsideCited over a whole collection past 180 papers, excluding works inside it", () => {
  const set = [];
  for (let i = 1; i <= 300; i++) set.push(paper(i, "W" + i, i > 200 ? ["TOP1", "TOP2", "W5"] : ["x" + i]));
  const out = graph.outsideCited(set, {floor: 2, limit: 12});
  assert.deepEqual(out.map(o => o.openalex).sort(), ["TOP1", "TOP2"], "papers 201-300 count, and W5 is in the collection");
  assert.equal(out[0].count, 100);
});

test("a fetched citer that the shelf holds counts as a shelf citer even when its capped references miss the centre", () => {
  const g = graph.egoGraph("1", [paper(1, "W1", []), paper(2, "W2", ["W9"])], {citers: [{id: "W2", title: "B"}]});
  assert.equal(g.counts.citedBy, 1, "B is a citer of A");
  assert.equal(g.counts.ghostCitedBy, 0, "and it is not a ghost");
  assert.ok(g.nodes.some(n => n.id === "2" && n.role === "citedBy"), "B is a solid node");
  assert.ok(g.edges.some(e => e.source === "2" && e.target === "1"), "with a confirmed B to A edge");
});

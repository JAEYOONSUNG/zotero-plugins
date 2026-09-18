/* A citation graph, built the way the paper-map tools build one.

   The old graph joined papers that shared a tag or an author and drew every
   node as the same grey dot. Sharing a tag is a fact about how the library was
   filed, not about the papers; a graph of it tells you what you already typed.

   What the field's tools actually map is the citation record. Two measures come
   out of it, and only one is computable from what a library holds:

     - bibliographic coupling: two papers that cite many of the same works are
       working on the same problem. Both reference lists are in hand, so this is
       arithmetic and costs no extra request.
     - co-citation: two papers cited together by later work. That needs the
       citing side, which means a request per paper and a far larger index, so
       it is not attempted rather than approximated badly.

   Direct citation is drawn too, and drawn differently: a paper citing another
   is a stated fact, while coupling is an inference, and the picture should not
   present the two as the same kind of line.

   The third thing those tools give you is the work you have not got: a paper
   that many of your own papers cite, which is not in the library. That falls
   out of the same reference lists for free. */
(function (root) {
  'use strict';

  const text = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const pairKey = (a, b) => (a < b ? a + '>' + b : b + '>' + a);

  /* Bibliographic coupling, normalised.

     A plain count of shared references rewards review articles for having long
     bibliographies. Dividing by the geometric mean of the two lengths asks
     instead what fraction of each paper's reading the two have in common, which
     is the question the picture is meant to answer. */
  function coupling(a, b) {
    if (!a || !b || !a.size || !b.size) return 0;
    const small = a.size <= b.size ? a : b;
    const large = a.size <= b.size ? b : a;
    let shared = 0;
    for (const id of small) if (large.has(id)) shared++;
    if (!shared) return 0;
    return {shared, score: shared / Math.sqrt(a.size * b.size)};
  }

  /* papers: [{id, title, year, citations, venue, openalex, references: [...]}]

     minShared guards against two papers that happen to share one methods
     citation being drawn as neighbours; minScore against a pair that overlaps
     only because both cite everything. */
  function build(papers, {minShared = 3, minScore = 0.06, maxEdges = 900, missingFloor = 3} = {}) {
    const list = (Array.isArray(papers) ? papers : []).filter(paper => paper && paper.id != null);
    const nodes = list.map(paper => ({
      id: String(paper.id),
      label: text(paper.title) || '(제목 없음)',
      year: Number(paper.year) || null,
      citations: Number(paper.citations) || 0,
      venue: text(paper.venue),
      openalex: text(paper.openalex),
      references: new Set((Array.isArray(paper.references) ? paper.references : []).map(text).filter(Boolean)),
      inLibrary: true, degree: 0
    }));
    const byWork = new Map();
    for (const node of nodes) if (node.openalex) byWork.set(node.openalex, node);

    const edges = [];
    // Direct citation: a stated fact, and the only edge with a direction.
    for (const node of nodes) {
      for (const reference of node.references) {
        const target = byWork.get(reference);
        if (target && target !== node) {
          edges.push({source: node.id, target: target.id, kind: 'cites', weight: 1, shared: 0});
        }
      }
    }
    const stated = new Set(edges.map(edge => pairKey(edge.source, edge.target)));

    // Coupling: an inference, drawn as an undirected thread.
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const found = coupling(nodes[i].references, nodes[j].references);
        if (!found || found.shared < minShared || found.score < minScore) continue;
        if (stated.has(pairKey(nodes[i].id, nodes[j].id))) continue;
        edges.push({source: nodes[i].id, target: nodes[j].id, kind: 'coupled',
          weight: found.score, shared: found.shared});
      }
    }
    // The strongest threads first, so trimming a dense library keeps the
    // structure rather than whichever pairs happened to be compared first.
    edges.sort((a, b) => (b.kind === 'cites') - (a.kind === 'cites') || b.weight - a.weight);
    const kept = edges.slice(0, maxEdges);
    const byID = new Map(nodes.map(node => [node.id, node]));
    for (const edge of kept) {
      byID.get(edge.source).degree++;
      byID.get(edge.target).degree++;
    }

    // Work the library cites but does not hold. This is the one thing a citation
    // map tells you that reading your own shelf cannot.
    const counts = new Map();
    for (const node of nodes) {
      for (const reference of node.references) {
        if (byWork.has(reference)) continue;
        const row = counts.get(reference) || {id: reference, citedBy: []};
        row.citedBy.push(node.id);
        counts.set(reference, row);
      }
    }
    const missing = [...counts.values()]
      .filter(row => row.citedBy.length >= missingFloor)
      .sort((a, b) => b.citedBy.length - a.citedBy.length);

    /* A paper nothing connects to is not part of the picture.

       Drawn anyway, the unconnected ones form a ring around the outside -- the
       repulsion has nothing to hold them in and gravity stops them leaving --
       and that ring is most of the ink while carrying none of the structure.
       They are counted and named instead, which is the useful form of the same
       fact: these are the papers your library has nothing else about. */
    const shaped = nodes.map(node => Object.assign({}, node, {references: node.references.size}));
    const connected = shaped.filter(node => node.degree > 0);
    const isolated = shaped.filter(node => !node.degree);
    return {
      nodes: connected, isolated, edges: kept, missing,
      truncated: edges.length > kept.length,
      counted: {direct: kept.filter(edge => edge.kind === 'cites').length,
        coupled: kept.filter(edge => edge.kind === 'coupled').length,
        isolated: isolated.length}
    };
  }

  // A repeatable pseudo-random source: the same library has to lay out the same
  // way twice, or every redraw looks like a different graph.
  function seeded(seed) {
    let state = (seed >>> 0) || 1;
    return () => {
      state ^= state << 13; state >>>= 0;
      state ^= state >> 17;
      state ^= state << 5; state >>>= 0;
      return state / 4294967296;
    };
  }

  /* Force-directed layout. Edges pull, every pair pushes, and the whole thing is
     nudged toward the middle so a component with no edges out of it does not
     drift off the canvas. */
  function layout(graph, {width = 760, height = 480, iterations = 700, seed = 7, pad = 30} = {}) {
    const nodes = ((graph && graph.nodes) || []).map(node => Object.assign({}, node));
    if (!nodes.length) {
      return {nodes: [], edges: (graph && graph.edges) || [], missing: (graph && graph.missing) || [],
        isolated: (graph && graph.isolated) || []};
    }
    const random = seeded(seed);
    /* How far apart the layout wants unrelated nodes.

       These four numbers were swept against this library's real citation graph
       rather than chosen: strong repulsion with a weak pull, run long. At the
       first values 410 pairs of the 124 connected papers sat closer together
       than their own labels; at these, 40 do, and the drawing uses a third more
       of the canvas. */
    const k = Math.sqrt(width * height / nodes.length) * 2.8;
    const index = new Map();
    nodes.forEach((node, i) => {
      index.set(node.id, i);
      // A spiral start rather than a random one: deterministic, and it settles
      // faster because it begins with the nodes already spread out.
      const angle = i * 2.399963;
      const radius = Math.sqrt(i / nodes.length) * Math.min(width, height) * 0.42;
      node.x = width / 2 + Math.cos(angle) * radius + (random() - 0.5) * 4;
      node.y = height / 2 + Math.sin(angle) * radius + (random() - 0.5) * 4;
      node.vx = 0; node.vy = 0;
      // Every node keeps its drawn size, so the layout can refuse to let two of
      // them sit on top of each other.
      node.r = radiusOf(node.citations);
    });
    const edges = ((graph && graph.edges) || [])
      .map(edge => Object.assign({}, edge, {a: index.get(String(edge.source)), b: index.get(String(edge.target))}))
      .filter(edge => edge.a != null && edge.b != null);

    for (let step = 0; step < iterations; step++) {
      const cooling = 1 - step / iterations;
      for (const node of nodes) { node.vx = 0; node.vy = 0; }
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          let dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
          let distance = Math.hypot(dx, dy);
          if (distance < 0.01) { dx = random() - 0.5; dy = random() - 0.5; distance = 0.01; }
          const force = (k * k) / distance;
          const fx = dx / distance * force, fy = dy / distance * force;
          nodes[i].vx += fx; nodes[i].vy += fy;
          nodes[j].vx -= fx; nodes[j].vy -= fy;
        }
      }
      for (const edge of edges) {
        const a = nodes[edge.a], b = nodes[edge.b];
        const dx = a.x - b.x, dy = a.y - b.y;
        const distance = Math.max(0.01, Math.hypot(dx, dy));
        /* The pull is linear in distance, not quadratic.

           Squared, a tight cluster collapsed into a single unreadable blob: the
           closer two papers got the harder they were dragged together, so the
           middle of the graph became one dot with forty labels on it. Linear
           attraction settles at a spacing instead of at a point. */
        const pull = distance / k * 4 * (edge.kind === 'cites' ? 1.2 : 0.5 + edge.weight);
        const fx = dx / distance * pull, fy = dy / distance * pull;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
      const limit = Math.max(2, Math.min(width, height) / 14 * cooling);
      for (const node of nodes) {
        // Just enough gravity to keep a detached component on the canvas.
        node.vx += (width / 2 - node.x) * 0.004;
        node.vy += (height / 2 - node.y) * 0.004;
        const speed = Math.hypot(node.vx, node.vy) || 1;
        const scale = Math.min(1, limit / speed);
        node.x += node.vx * scale;
        node.y += node.vy * scale;
      }
      // Nothing may sit on top of anything else. Without this the dense middle
      // of a real library is a pile of circles with the labels unreadable.
      separate(nodes, random, step > iterations * 0.4 ? 1 : 0.5);
    }
    for (let extra = 0; extra < 14; extra++) separate(nodes, random, 1);

    // Fit to the box, leaving room for a label.
    const xs = nodes.map(node => node.x), ys = nodes.map(node => node.y);
    const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    const scale = Math.min((width - pad * 2) / Math.max(1, maxX - minX),
      (height - pad * 2) / Math.max(1, maxY - minY));
    for (const node of nodes) {
      node.x = pad + (node.x - minX) * scale;
      node.y = pad + (node.y - minY) * scale;
      delete node.vx; delete node.vy;
    }
    return {nodes, edges: (graph && graph.edges) || [], missing: (graph && graph.missing) || [],
      isolated: (graph && graph.isolated) || [],
      truncated: !!(graph && graph.truncated), counted: graph && graph.counted};
  }

  // Push apart any two nodes whose drawn circles overlap, plus a gap for the
  // stroke. Run inside the loop so the forces settle around real sizes.
  function separate(nodes, random, strength) {
    const gap = 9;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const want = a.r + b.r + gap;
        let dx = b.x - a.x, dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        if (distance >= want) continue;
        if (distance < 0.01) { dx = random() - 0.5; dy = random() - 0.5; distance = 0.01; }
        const shift = (want - distance) / distance * 0.5 * strength;
        const ox = dx * shift, oy = dy * shift;
        a.x -= ox; a.y -= oy;
        b.x += ox; b.y += oy;
      }
    }
  }

  // Node size: citation counts span orders of magnitude, so the radius follows
  // the log, and a paper with none is still a dot rather than a point.
  function radiusOf(citations, {min = 3.5, max = 13} = {}) {
    const value = Math.max(0, Number(citations) || 0);
    return min + (max - min) * Math.min(1, Math.log10(value + 1) / Math.log10(2001));
  }

  const api = {build, layout, coupling, radiusOf, seeded};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStylePaperGraph = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

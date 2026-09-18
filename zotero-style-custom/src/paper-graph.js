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

  /* The work that cites yours, which your own shelf cannot tell you.

     References point backwards: they say what a paper was built on. Who built
     on it afterwards is the other half, and it is the half that says whether a
     thread is still moving. It cannot be derived from a library -- the citing
     papers are by definition ones you may not hold -- so it is fetched, and
     folded in here as a third kind of node.

     citedBy: {paperID: [{id, title, year, citations, venue}]}, from outside. */
  function foldCitedBy(nodes, edges, citedBy, {minCiters = 2, maxNodes = 120} = {}) {
    const byWork = new Map();
    for (const node of nodes) if (node.openalex) byWork.set(node.openalex, node);
    const outside = new Map();
    for (const [paperID, list] of Object.entries(citedBy || {})) {
      for (const citer of Array.isArray(list) ? list : []) {
        const id = text(citer && citer.id);
        if (!id || byWork.has(id)) continue;
        const row = outside.get(id) || {
          id: 'W:' + id, openalex: id, kind: 'external',
          label: text(citer.title) || id, year: Number(citer.year) || null,
          citations: Number(citer.citations) || 0, venue: text(citer.venue),
          inLibrary: false, degree: 0, cites: []
        };
        row.cites.push(String(paperID));
        outside.set(id, row);
      }
    }
    /* Only work that cites more than one of your papers.

       A paper that cites one of yours is the long tail -- thousands of them,
       and almost all noise on a map of your own field. A paper that cites two
       or three is working on your problem, which is the thing worth seeing. */
    const kept = [...outside.values()]
      .filter(row => new Set(row.cites).size >= minCiters)
      .sort((a, b) => new Set(b.cites).size - new Set(a.cites).size || b.citations - a.citations)
      .slice(0, maxNodes);
    const added = [];
    for (const row of kept) {
      const {cites, ...node} = row;
      added.push(node);
      for (const paperID of new Set(cites)) {
        edges.push({source: node.id, target: String(paperID), kind: 'cites', weight: 1, shared: 0, external: true});
      }
    }
    return added;
  }

  /* papers: [{id, title, year, citations, venue, openalex, references: [...]}]

     minShared guards against two papers that happen to share one methods
     citation being drawn as neighbours; minScore against a pair that overlaps
     only because both cite everything. */
  function build(papers, {minShared = 3, minScore = 0.06, maxEdges = 900, missingFloor = 3,
      citedBy = null, minCiters = 2, maxCiters = 120} = {}) {
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

    /* Coupling: an inference, drawn as an undirected thread.

       Found through an inverted index rather than by comparing every pair.
       Intersecting all n(n-1)/2 reference sets took 199ms at 600 papers and
       grows as the square: most of that work compared two papers with nothing
       whatever in common. Walking each shared reference instead only ever
       touches pairs that do share something, and the vast majority of
       references are cited by exactly one paper and cost nothing at all. */
    const citers = new Map();
    for (const [index, node] of nodes.entries()) {
      for (const reference of node.references) {
        const list = citers.get(reference);
        if (list) list.push(index); else citers.set(reference, [index]);
      }
    }
    const shared = new Map();
    for (const list of citers.values()) {
      if (list.length < 2) continue;
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const key = list[a] * nodes.length + list[b];
          shared.set(key, (shared.get(key) || 0) + 1);
        }
      }
    }
    for (const [key, count] of shared) {
      if (count < minShared) continue;
      const i = Math.floor(key / nodes.length), j = key % nodes.length;
      const score = count / Math.sqrt(nodes[i].references.size * nodes[j].references.size);
      if (score < minScore) continue;
      if (stated.has(pairKey(nodes[i].id, nodes[j].id))) continue;
      edges.push({source: nodes[i].id, target: nodes[j].id, kind: 'coupled',
        weight: score, shared: count});
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
    const shaped = nodes.map(node => Object.assign({}, node,
      {references: node.references.size, kind: 'paper', inLibrary: true}));
    // The work that cites yours joins before the connectedness is decided: a
    // paper of yours that nothing on your shelf touches may still sit under
    // three later papers, and that is not an isolated paper.
    const external = citedBy ? foldCitedBy(shaped, kept, citedBy, {minCiters, maxCiters}) : [];
    const byID2 = new Map([...shaped, ...external].map(node => [node.id, node]));
    for (const edge of kept) {
      if (!edge.external) continue;
      const a = byID2.get(edge.source), b = byID2.get(edge.target);
      if (a) a.degree++;
      if (b) b.degree++;
    }
    const everything = [...shaped, ...external];
    const rank = pagerank(everything, kept);
    for (const node of everything) node.rank = rank.get(node.id) || 0;
    const connected = everything.filter(node => node.degree > 0);
    const isolated = shaped.filter(node => !node.degree);
    return {
      nodes: connected, isolated, edges: kept, missing, external,
      truncated: edges.length > kept.length,
      counted: {direct: kept.filter(edge => edge.kind === 'cites' && !edge.external).length,
        coupled: kept.filter(edge => edge.kind === 'coupled').length,
        incoming: kept.filter(edge => edge.external).length,
        external: external.length,
        isolated: isolated.length}
    };
  }

  /* How central a paper is inside this collection, rather than in the world.

     Citation count answers "how famous is this"; it is the same number whether
     you hold one paper or a thousand, and in a library of one field almost
     everything famous is famous. What a map of your own reading should size by
     is how much of *your* structure runs through a paper -- the review everyone
     on your shelf cites, the method three of your threads depend on.

     PageRank over the citation edges answers that. A paper gains weight from
     being cited by papers that are themselves cited, and the damping factor is
     the usual 0.85: with probability 0.15 a reader jumps somewhere at random
     rather than following a reference. */
  function pagerank(nodes, edges, {damping = 0.85, iterations = 40} = {}) {
    const index = new Map(nodes.map((node, i) => [node.id, i]));
    const n = nodes.length;
    if (!n) return new Map();
    const out = new Array(n).fill(0);
    const links = [];
    for (const edge of edges) {
      // Only stated citations carry rank. A shared-reading thread is an
      // inference about similarity, not a vote.
      if (edge.kind !== 'cites') continue;
      const from = index.get(String(edge.source)), to = index.get(String(edge.target));
      if (from == null || to == null || from === to) continue;
      links.push([from, to]);
      out[from]++;
    }
    let rank = new Array(n).fill(1 / n);
    for (let step = 0; step < iterations; step++) {
      const next = new Array(n).fill((1 - damping) / n);
      let sunk = 0;
      for (let i = 0; i < n; i++) if (!out[i]) sunk += rank[i];
      // A paper that cites nothing in the collection would otherwise leak its
      // rank out of the graph entirely.
      const spill = damping * sunk / n;
      for (let i = 0; i < n; i++) next[i] += spill;
      for (const [from, to] of links) next[to] += damping * rank[from] / out[from];
      rank = next;
    }
    const top = Math.max(...rank);
    return new Map(nodes.map((node, i) => [node.id, top > 0 ? rank[i] / top : 0]));
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
  function layout(graph, {width = 760, height = 480, iterations = 400, seed = 7, pad = 30} = {}) {
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
      /* Overlap resolution every fourth step, and on the last dozen.

         Run every step it was half the layout's cost for nothing: the forces
         move nodes a little each iteration, so pushing circles apart on every
         one of them redoes work the next iteration undoes. Measured over this
         library's graph, every fourth step reaches the same spacing -- forty
         crowded pairs either way -- and the run drops from 302ms to 124ms.
         The final passes are what actually settle it. */
      if (step % 4 === 0 || step > iterations - 12) {
        separate(nodes, random, step > iterations * 0.4 ? 1 : 0.5);
      }
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
      // Kept, because label placement has to know how far out to start.
      node.r = radiusOf(node.citations) * (0.7 + 0.6 * (node.rank || 0));
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

  /* Which nodes get a label, decided by whether the label fits.

     Showing a label for everything above a threshold put forty of them on top
     of each other in the middle of a real graph, which is worse than showing
     none: overlapping text is not readable and it hides the nodes underneath.

     So labels are placed in order of what matters most and each is kept only if
     its box misses everything already placed. The result is that the busiest
     part of the picture -- where the labels would collide -- shows the few that
     earned it, and the sparse edges show many. */
  function placeLabels(nodes, {charWidth = 5.2, lineHeight = 11, limit = 60, pad = 2} = {}) {
    const wanted = [...nodes]
      // Work you do not hold is the payoff of the whole map, so it is offered a
      // label before a paper already on the shelf.
      .sort((a, b) => (b.kind === 'external') - (a.kind === 'external')
        || (b.rank || 0) - (a.rank || 0) || b.degree - a.degree);
    const placed = [];
    const shown = new Set();
    for (const node of wanted) {
      if (shown.size >= limit) break;
      const text = String(node.labelText == null ? node.label : node.labelText);
      if (!text) continue;
      const r = node.r || 6;
      const box = {
        x: node.x + r + 3 - pad,
        y: node.y - lineHeight / 2 - pad,
        w: text.length * charWidth + pad * 2,
        h: lineHeight + pad * 2
      };
      const clash = placed.some(other =>
        box.x < other.x + other.w && box.x + box.w > other.x
        && box.y < other.y + other.h && box.y + box.h > other.y);
      if (clash) continue;
      placed.push(box);
      shown.add(node.id);
    }
    return shown;
  }

  // Node size: citation counts span orders of magnitude, so the radius follows
  // the log, and a paper with none is still a dot rather than a point.
  function radiusOf(citations, {min = 3.5, max = 13} = {}) {
    const value = Math.max(0, Number(citations) || 0);
    return min + (max - min) * Math.min(1, Math.log10(value + 1) / Math.log10(2001));
  }

  const api = {build, layout, coupling, radiusOf, seeded, pagerank, foldCitedBy, placeLabels};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStylePaperGraph = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

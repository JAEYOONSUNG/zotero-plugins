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
      // Two copies of one OpenAlex work share every reference by definition; that is
      // a duplicate, not a relation between two papers.
      if (nodes[i].openalex && nodes[i].openalex === nodes[j].openalex) continue;
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
    // Whether a paper is connected is a fact about the whole library, not about
    // the 900 threads that fit on the canvas: degree counts every edge found.
    for (const edge of edges) {
      byID.get(edge.source).degree++;
      byID.get(edge.target).degree++;
    }

    // Work the library cites but does not hold. This is the one thing a citation
    // map tells you that reading your own shelf cannot.
    const counts = new Map(), countedWorks = new Map();
    for (const node of nodes) {
      const work = node.openalex || 'id:' + node.id;
      for (const reference of node.references) {
        if (byWork.has(reference)) continue;
        // Copies of one work cite a reference once, not once per copy.
        const seen = countedWorks.get(reference) || countedWorks.set(reference, new Set()).get(reference);
        if (seen.has(work)) continue;
        seen.add(work);
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
      counted: {direct: edges.filter(edge => edge.kind === 'cites').length,
        coupled: edges.filter(edge => edge.kind === 'coupled').length,
        drawn: kept.filter(edge => !edge.external).length, total: edges.length,
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
  function layout(graph, {width = 760, height = 480, iterations = 400, seed = 7, pad = 30, nodeRadius = null, gap = 9} = {}) {
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
      // them sit on top of each other. Size is centrality within this graph
      // (see centralityRadius), not a citation count from the world outside it.
      node.r = nodeRadius ? nodeRadius(node) : centralityRadius(node.rank);
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
        separate(nodes, random, step > iterations * 0.4 ? 1 : 0.5, gap);
      }
    }
    for (let extra = 0; extra < 14; extra++) separate(nodes, random, 1, gap);

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
      // Kept, because label placement has to know how far out to start; the
      // same centralityRadius as at layout's start, so nothing resizes mid-draw.
      node.r = nodeRadius ? nodeRadius(node) : centralityRadius(node.rank);
    }
    return {nodes, edges: (graph && graph.edges) || [], missing: (graph && graph.missing) || [],
      isolated: (graph && graph.isolated) || [],
      truncated: !!(graph && graph.truncated), counted: graph && graph.counted};
  }

  // Push apart any two nodes whose drawn circles overlap, plus a gap for the
  // stroke. Run inside the loop so the forces settle around real sizes.
  function separate(nodes, random, strength, gap = 9) {
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

  // Hangul, and CJK generally, draws close to a full em at 11px; Latin script
  // (and digits, punctuation) runs closer to 0.6em. A flat per-character
  // guess undersized every Korean label and let them collide undetected.
  const WIDE_CHAR = /[぀-ヿㄱ-ㆎ가-힣一-鿿豈-﫿]/;
  function textWidth(str, {narrow = 6.5, wide = 11} = {}) {
    let w = 0;
    for (const ch of String(str)) w += WIDE_CHAR.test(ch) ? wide : narrow;
    return w;
  }

  /* Which nodes get a label, decided by whether the label fits.

     Showing a label for everything above a threshold put forty of them on top
     of each other in the middle of a real graph, which is worse than showing
     none: overlapping text is not readable and it hides the nodes underneath.

     So labels are placed in order of what matters most and each is kept only if
     its box misses everything already placed, and sits inside the view -- a
     label that ran off the edge used to sit there anyway, half off-canvas and
     unreadable, which is worse than the node it belonged to going unlabelled.
     The result is that the busiest part of the picture -- where the labels
     would collide -- shows the few that earned it, and the sparse edges show
     many. */
  function placeLabels(nodes, {lineHeight = 11, limit = 60, pad = 2, width = Infinity, height = Infinity, first = null, avoidDots = false} = {}) {
    // `first`: ids that must be offered a place before anything else (the chosen paper).
    const firstIDs = new Set([...(first || [])].map(String));
    const wanted = [...nodes]
      // Work you do not hold is the payoff of the whole map, so it is offered a
      // label before a paper already on the shelf.
      .sort((a, b) => (firstIDs.has(String(b.id)) - firstIDs.has(String(a.id)))
        || (b.kind === 'external') - (a.kind === 'external')
        || (b.rank || 0) - (a.rank || 0) || (b.degree || 0) - (a.degree || 0));
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
        w: textWidth(text) + pad * 2,
        h: lineHeight + pad * 2
      };
      if (box.x < 0 || box.y < 0 || box.x + box.w > width || box.y + box.h > height) continue;
      // A label drawn across another paper's dot reads as that paper's label: keep it off every dot but its own.
      const onDot = nodes.some(other => other !== node && avoidDots && (() => {
        const rr = (other.r || 6) + 1;
        const nx = Math.max(box.x, Math.min(other.x, box.x + box.w)), ny = Math.max(box.y, Math.min(other.y, box.y + box.h));
        return Math.hypot(other.x - nx, other.y - ny) < rr;
      })());
      if (onDot && !firstIDs.has(String(node.id))) continue;
      const clash = placed.some(other =>
        box.x < other.x + other.w && box.x + box.w > other.x
        && box.y < other.y + other.h && box.y + box.h > other.y);
      if (clash) continue;
      placed.push(box);
      shown.add(node.id);
    }
    return shown;
  }

  /* Every node labelled, sides chosen instead of nodes dropped.

     placeLabels is right for a crowded graph: most labels would collide, so
     showing the ones that fit is the useful picture. A small graph is the
     opposite problem -- there is room for every title, but the fixed spot
     just right of the node is exactly where an edge to that node's own
     neighbour usually runs, so the label sits on top of a line and, once two
     nodes are close, on top of each other. Trying the other three sides per
     node and keeping whichever collides least (with the labels already
     placed, and with the frame) keeps every label -- none are dropped -- while
     spreading them off the lines and off each other. */
  function placeLabelSides(nodes, {lineHeight = 11, pad = 2, gap = 4, width = Infinity, height = Infinity, edges = []} = {}) {
    // Central papers first: the ones most likely to sit in a crowded middle
    // get first pick of the side that is actually clear.
    const order = [...nodes].sort((a, b) => (b.rank || 0) - (a.rank || 0) || (b.degree || 0) - (a.degree || 0));
    const placed = [];
    const sides = new Map();
    const byID = new Map(nodes.map(n => [String(n.id), n]));
    // Every edge as a segment, so a label is also kept off the lines.
    const segments = [];
    for (const e of edges || []) {
      const a = byID.get(String(e.source)), b = byID.get(String(e.target));
      if (a && b) segments.push({a, b});
    }
    const boxFor = (node, side, w) => {
      const r = node.r || 6;
      const d = r + gap;
      if (side === 'left') return {x: node.x - d - w, y: node.y - lineHeight / 2, w, h: lineHeight,
        anchor: 'end', dx: -d, dy: 3.5};
      if (side === 'above') return {x: node.x - w / 2, y: node.y - d - lineHeight, w, h: lineHeight,
        anchor: 'middle', dx: 0, dy: -d};
      if (side === 'below') return {x: node.x - w / 2, y: node.y + d, w, h: lineHeight,
        anchor: 'middle', dx: 0, dy: d + lineHeight - 3};
      // The four corners: a label that would sit on an edge running straight
      // up, down, left or right of its node often clears it diagonally.
      const k = d * 0.72;
      if (side === 'above-right') return {x: node.x + k, y: node.y - k - lineHeight, w, h: lineHeight,
        anchor: 'start', dx: k, dy: -k};
      if (side === 'above-left') return {x: node.x - k - w, y: node.y - k - lineHeight, w, h: lineHeight,
        anchor: 'end', dx: -k, dy: -k};
      if (side === 'below-right') return {x: node.x + k, y: node.y + k, w, h: lineHeight,
        anchor: 'start', dx: k, dy: k + lineHeight - 3};
      if (side === 'below-left') return {x: node.x - k - w, y: node.y + k, w, h: lineHeight,
        anchor: 'end', dx: -k, dy: k + lineHeight - 3};
      return {x: node.x + d, y: node.y - lineHeight / 2, w, h: lineHeight,
        anchor: 'start', dx: d, dy: 3.5};
    };
    const overlaps = (box, other) => box.x < other.x + other.w && box.x + box.w > other.x
      && box.y < other.y + other.h && box.y + box.h > other.y;
    // A circle against a box: the nearest point of the box to the centre.
    const hitsNode = (box, n) => {
      const r = (n.r || 6) + 1;
      const nx = Math.max(box.x - pad, Math.min(n.x, box.x + box.w + pad));
      const ny = Math.max(box.y - pad, Math.min(n.y, box.y + box.h + pad));
      return Math.hypot(n.x - nx, n.y - ny) < r;
    };
    // A segment against a box (Liang-Barsky clip).
    const hitsSegment = (box, seg) => {
      const x0 = seg.a.x, y0 = seg.a.y, dx = seg.b.x - x0, dy = seg.b.y - y0;
      const left = box.x - pad, right = box.x + box.w + pad, top = box.y - pad, bottom = box.y + box.h + pad;
      let t0 = 0, t1 = 1;
      for (const [p, q] of [[-dx, x0 - left], [dx, right - x0], [-dy, y0 - top], [dy, bottom - y0]]) {
        if (p === 0) { if (q < 0) return false; continue; }
        const t = q / p;
        if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
        else { if (t < t0) return false; if (t < t1) t1 = t; }
      }
      return t0 <= t1;
    };
    for (const node of order) {
      const text = String(node.labelText == null ? node.label : node.labelText);
      const w = textWidth(text) + pad * 2;
      let best = null, bestScore = Infinity;
      for (const side of ['right', 'left', 'above', 'below', 'above-right', 'below-right', 'above-left', 'below-left']) {
        const box = boxFor(node, side, w);
        const inView = box.x >= 0 && box.y >= 0 && box.x + box.w <= width && box.y + box.h <= height;
        let score = inView ? 0 : 1000;
        for (const other of placed) if (overlaps(box, other)) score += 10;
        for (const other of nodes) if (other !== node && hitsNode(box, other)) score += 10;
        for (const seg of segments) if (hitsSegment(box, seg)) score += seg.a === node || seg.b === node ? 2 : 3;
        if (score < bestScore) { bestScore = score; best = box; }
        if (score === 0) break;
      }
      placed.push(best);
      sides.set(node.id, {anchor: best.anchor, dx: best.dx, dy: best.dy});
    }
    return sides;
  }

  /* Labels that never sit on anything: each candidate is tried at eight places round its
     node (right first, then left, above, below and the corners) and kept at the first place
     that is inside the frame, misses every label already placed and every other node's dot;
     among clean places the one crossing fewest lines wins. A node with no clean place goes
     unlabelled -- its name comes with hover, focus or the find box -- except the chosen ones
     (`first`), which take the place sitting on the fewest labels -- but never on a dot.

     Returns id -> {anchor, dx, dy}: where the text goes relative to the node's centre. */
  const LABEL_SIDES = ['right', 'left', 'above', 'below', 'above-right', 'below-right', 'above-left', 'below-left'];
  function labelBox(node, side, w, lineHeight, gap) {
    const r = node.r || node.rad || 6, d = r + gap, k = d * 0.72;
    const at = (x, y, anchor, dx, dy) => ({x, y, w, h: lineHeight, anchor, dx, dy});
    switch (side) {
      case 'left': return at(node.x - d - w, node.y - lineHeight / 2, 'end', -d, 3.5);
      case 'above': return at(node.x - w / 2, node.y - d - lineHeight, 'middle', 0, -d - 3);
      case 'below': return at(node.x - w / 2, node.y + d, 'middle', 0, d + lineHeight - 3);
      case 'above-right': return at(node.x + k, node.y - k - lineHeight, 'start', k, -k - 3);
      case 'above-left': return at(node.x - k - w, node.y - k - lineHeight, 'end', -k, -k - 3);
      case 'below-right': return at(node.x + k, node.y + k, 'start', k, k + lineHeight - 3);
      case 'below-left': return at(node.x - k - w, node.y + k, 'end', -k, k + lineHeight - 3);
      default: return at(node.x + d, node.y - lineHeight / 2, 'start', d, 3.5);
    }
  }
  function placeLabelsAround(nodes, {lineHeight = 14, pad = 2, gap = 4, limit = 60, width = Infinity, height = Infinity, first = null, edges = [], text = null} = {}) {
    const firstIDs = new Set([...(first || [])].map(String));
    const wanted = [...nodes].sort((a, b) => (firstIDs.has(String(b.id)) - firstIDs.has(String(a.id)))
      || (b.kind === 'external') - (a.kind === 'external')
      || (b.rank || 0) - (a.rank || 0) || (b.degree || 0) - (a.degree || 0));
    const byID = new Map(nodes.map(n => [String(n.id), n]));
    const segments = [];
    for (const e of edges || []) {
      const a = byID.get(String(e.source)), b = byID.get(String(e.target));
      if (a && b) segments.push({a, b});
    }
    const overlaps = (p, q) => p.x - pad < q.x + q.w + pad && p.x + p.w + pad > q.x - pad && p.y < q.y + q.h && p.y + p.h > q.y;
    const hitsNode = (box, n) => {
      const r = (n.r || n.rad || 6) + 1;
      const nx = Math.max(box.x - pad, Math.min(n.x, box.x + box.w + pad));
      const ny = Math.max(box.y - pad, Math.min(n.y, box.y + box.h + pad));
      return Math.hypot(n.x - nx, n.y - ny) < r;
    };
    const crosses = (box, seg) => {
      const x0 = seg.a.x, y0 = seg.a.y, dx = seg.b.x - x0, dy = seg.b.y - y0;
      let t0 = 0, t1 = 1;
      for (const [p, q] of [[-dx, x0 - box.x], [dx, box.x + box.w - x0], [-dy, y0 - box.y], [dy, box.y + box.h - y0]]) {
        if (p === 0) { if (q < 0) return false; continue; }
        const t = q / p;
        if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
        else { if (t < t0) return false; if (t < t1) t1 = t; }
      }
      return t0 <= t1;
    };
    const placed = [], out = new Map();
    for (const node of wanted) {
      if (out.size >= limit) break;
      const words = String(text ? text(node) : node.labelText == null ? node.label : node.labelText);
      if (!words) continue;
      const w = textWidth(words);
      let best = null, bestCross = Infinity;
      for (const side of LABEL_SIDES) {
        const box = labelBox(node, side, w, lineHeight, gap);
        if (box.x < 0 || box.y < 0 || box.x + box.w > width || box.y + box.h > height) continue;
        if (placed.some(other => overlaps(box, other))) continue;
        if (nodes.some(other => other !== node && hitsNode(box, other))) continue;
        let cross = 0;
        for (const seg of segments) if (seg.a !== node && seg.b !== node && crosses(box, seg)) cross++;
        if (cross < bestCross) { best = box; bestCross = cross; if (!cross) break; }
      }
      // A chosen node with no clean place takes the side that sits on the fewest labels -- never one on a dot.
      if (!best && firstIDs.has(String(node.id))) {
        let fewest = Infinity;
        for (const side of LABEL_SIDES) {
          const box = labelBox(node, side, w, lineHeight, gap);
          if (box.x < 0 || box.y < 0 || box.x + box.w > width || box.y + box.h > height) continue;
          if (nodes.some(other => other !== node && hitsNode(box, other))) continue;
          const clash = placed.filter(other => overlaps(box, other)).length;
          if (clash < fewest) { fewest = clash; best = box; }
        }
      }
      if (!best) continue;
      placed.push(best);
      out.set(node.id, {anchor: best.anchor, dx: best.dx, dy: best.dy});
    }
    return out;
  }

  // Node size: citation counts span orders of magnitude, so the radius follows
  // the log, and a paper with none is still a dot rather than a point.
  function radiusOf(citations, {min = 3.5, max = 13} = {}) {
    const value = Math.max(0, Number(citations) || 0);
    return min + (max - min) * Math.min(1, Math.log10(value + 1) / Math.log10(2001));
  }

  /* Node size from centrality within the displayed graph, not "citations ×
     centrality" -- a paper famous everywhere but marginal to this particular
     set of readings used to draw as large as the paper this whole graph
     actually turns on. rank is PageRank over the graph's own citation edges,
     already normalised to [0, 1] with the most-depended-on paper at 1; the
     square root keeps the one dominant hub from swallowing the scale the way
     a linear map would. */
  function centralityRadius(rank, {min = 3.5, max = 13} = {}) {
    const value = Math.max(0, Math.min(1, Number(rank) || 0));
    return min + (max - min) * Math.sqrt(value);
  }

  /* ---- Scopes: one paper, or one collection -------------------------------
     The whole-library map answers "what does my shelf look like". Two narrower
     questions come up more: "what does this one paper sit between" and "does
     this folder I collect into hang together". Both are read off the reference
     lists already stored, so neither asks OpenAlex anything; only the papers
     that cite a paper, which a shelf cannot know, are ever fetched, and only
     when the reader presses the button. */

  const bare = value => {
    const id = text(value).split('/').pop();
    return /^w\d+$/i.test(id) ? id.toUpperCase() : text(value);
  };

  // The papers filed in one collection, and with `sub` the ones filed below it.
  // collections: [{id, parentID, itemIDs}] as library.collections() returns them.
  function collectionItemIDs(collections, rootID, {sub = true} = {}) {
    const list = Array.isArray(collections) ? collections : [];
    const kids = new Map();
    for (const c of list) {
      const key = c.parentID == null ? '' : String(c.parentID);
      if (!kids.has(key)) kids.set(key, []);
      kids.get(key).push(c);
    }
    const byID = new Map(list.map(c => [String(c.id), c]));
    const out = new Set(), seen = new Set();
    const walk = id => {
      if (seen.has(id)) return;
      seen.add(id);
      const c = byID.get(id);
      if (!c) return;
      for (const item of c.itemIDs || []) out.add(String(item));
      if (sub) for (const kid of kids.get(id) || []) walk(String(kid.id));
    };
    walk(String(rootID));
    return out;
  }

  /* The papers outside a set that the set cites most.

     papers: the set; held: every paper on the shelf (to say which of the
     outside ones is already owned, elsewhere). Only works cited by `floor` or
     more of the set count: one citation is the long tail. */
  function outsideCited(papers, {held = [], meta = {}, floor = 2, limit = 12} = {}) {
    const inside = new Set((papers || []).map(p => bare(p.openalex)).filter(Boolean));
    const owned = new Map();
    for (const p of held || []) {
      const id = bare(p.openalex);
      if (id && !owned.has(id)) owned.set(id, p);
    }
    const counts = new Map(), works = new Map();
    for (const p of papers || []) {
      // A work held as several items cites a reference once.
      const work = bare(p.openalex) || 'id:' + p.id;
      for (const ref of new Set((p.references || []).map(bare).filter(Boolean))) {
        if (inside.has(ref) || ref === bare(p.openalex)) continue;
        const seen = works.get(ref) || works.set(ref, new Set()).get(ref);
        if (seen.has(work)) continue;
        seen.add(work);
        const row = counts.get(ref) || {openalex: ref, citedBy: []};
        row.citedBy.push(String(p.id));
        counts.set(ref, row);
      }
    }
    return [...counts.values()]
      .filter(row => row.citedBy.length >= floor)
      .map(row => {
        const m = meta[row.openalex] || {}, mine = owned.get(row.openalex) || null;
        return {openalex: row.openalex, citedBy: row.citedBy, count: row.citedBy.length,
          title: text(m.title) || (mine && text(mine.title)) || '', year: Number(m.year) || (mine && Number(mine.year)) || null,
          venue: text(m.venue) || (mine && text(mine.venue)) || '', doi: text(m.doi),
          citations: Number(m.citations) || 0, heldID: mine ? String(mine.id) : null};
      })
      .sort((a, b) => b.count - a.count || b.citations - a.citations || (a.openalex < b.openalex ? -1 : 1))
      .slice(0, limit);
  }

  // How many separate groups the nodes form through the given edges.
  function clusterCount(nodeIDs, edges) {
    const parent = new Map([...nodeIDs].map(id => [String(id), String(id)]));
    const find = id => { while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); } return id; };
    const touched = new Set();
    for (const e of edges || []) {
      const a = String(e.source), b = String(e.target);
      if (!parent.has(a) || !parent.has(b)) continue;
      parent.set(find(a), find(b));
      touched.add(a); touched.add(b);
    }
    return new Set([...touched].map(find)).size;
  }

  /* One paper and the papers around it.

     centreID: the paper; papers: every paper on the shelf, [{id, title, year,
     citations, venue, openalex, references}]; meta: titles for work ids not on
     the shelf (a cache, may be empty); citers: papers citing the centre that
     were fetched earlier. Shelf papers are solid nodes, the rest ghosts.

     Nodes are capped at `limit` (the centre, then shelf papers, then the most
     cited ghosts) unless `all`. */
  function egoGraph(centreID, papers, {meta = {}, citers = [], depth2 = false, limit = 60, all = false} = {}) {
    const list = (Array.isArray(papers) ? papers : []).filter(p => p && p.id != null);
    const byID = new Map(list.map(p => [String(p.id), p]));
    const centre = byID.get(String(centreID));
    if (!centre) return null;
    const refSet = p => p._refs || (p._refs = new Set((p.references || []).map(bare).filter(Boolean)));
    const byWork = new Map();
    for (const p of list) { const id = bare(p.openalex); if (id && !byWork.has(id)) byWork.set(id, p); }
    const centreWork = bare(centre.openalex);

    const libCites = [], ghostRefs = [];
    for (const ref of refSet(centre)) {
      if (ref === centreWork) continue;
      const hit = byWork.get(ref);
      if (hit && hit !== centre) libCites.push(hit); else if (!hit) ghostRefs.push(ref);
    }
    // A work held as several items is one citer; a second copy of the centre is not a citer of it.
    const seenWork = new Set();
    const libCitedBy = centreWork ? list.filter(p => {
      if (p === centre || bare(p.openalex) === centreWork || !refSet(p).has(centreWork)) return false;
      const key = bare(p.openalex) || 'id:' + p.id;
      if (seenWork.has(key)) return false;
      seenWork.add(key); return true;
    }) : [];
    const ghostCiters = [], seenCiter = new Set(), confirmedCiters = new Set();
    for (const c of citers || []) {
      const id = bare(c && c.id);
      if (!id || id === centreWork || seenCiter.has(id)) continue;
      seenCiter.add(id);
      /* A fetched citer the shelf already holds is a shelf citer: the fetch is
         the proof, whether or not its stored references (capped) name the centre. */
      const held = byWork.get(id);
      if (held) {
        if (held !== centre && bare(held.openalex) !== centreWork) {
          confirmedCiters.add(held);
          if (!libCitedBy.includes(held) && !seenWork.has(id)) { libCitedBy.push(held); seenWork.add(id); }
        }
        continue;
      }
      ghostCiters.push({openalex: id, title: text(c.title), year: Number(c.year) || null, venue: text(c.venue),
        citations: Number(c.citations) || 0, doi: text(c.doi)});
    }
    const first = new Map();   // shelf paper id -> role
    for (const p of libCites) first.set(String(p.id), 'cites');
    for (const p of libCitedBy) first.set(String(p.id), first.has(String(p.id)) ? 'both' : 'citedBy');

    const near = [];
    if (depth2) {
      const level = new Set([...first.keys(), String(centre.id)]);
      const firstWorks = new Set([...first.keys()].map(id => bare(byID.get(id).openalex)).filter(Boolean));
      const seenNear = new Set();
      for (const p of list) {
        if (level.has(String(p.id)) || (centreWork && bare(p.openalex) === centreWork)) continue;
        const nearKey = bare(p.openalex) || 'id:' + p.id;
        if (seenNear.has(nearKey)) continue;
        const cites = [...refSet(p)].some(ref => firstWorks.has(ref));
        const w = bare(p.openalex);
        const cited = w && [...first.keys()].some(id => refSet(byID.get(id)).has(w));
        if (cites || cited) { near.push(p); seenNear.add(nearKey); }
      }
    }
    const counts = {
      cites: libCites.length + ghostRefs.length,
      citedBy: libCitedBy.length + ghostCiters.length,
      library: first.size, near: near.length,
      ghostCites: ghostRefs.length, ghostCitedBy: ghostCiters.length
    };

    const cap = all ? Infinity : Math.max(0, limit - 1);
    const ghosts = [
      ...ghostRefs.map(id => { const m = meta[id] || {}; return {openalex: id, role: 'cites', title: text(m.title), year: Number(m.year) || null,
        venue: text(m.venue), citations: Number(m.citations) || 0, doi: text(m.doi)}; }),
      ...ghostCiters.map(c => ({...c, role: 'citedBy'}))
    ].sort((a, b) => b.citations - a.citations || (a.openalex < b.openalex ? -1 : 1));
    const shelf = [...libCites.filter(p => first.get(String(p.id)) === 'cites'),
      ...libCitedBy].filter((p, i, a) => a.indexOf(p) === i);
    const ordered = [];
    for (const p of shelf) ordered.push({p, role: first.get(String(p.id))});
    for (const p of near) ordered.push({p, role: 'near'});
    let used = 0;
    const keptShelf = [], keptGhosts = [];
    for (const row of ordered) if (used < cap) { keptShelf.push(row); used++; }
    for (const g of ghosts) if (used < cap) { keptGhosts.push(g); used++; }

    const nodes = [{id: String(centre.id), label: text(centre.title) || '(제목 없음)', year: Number(centre.year) || null,
      citations: Number(centre.citations) || 0, venue: text(centre.venue), openalex: centreWork,
      kind: 'centre', role: 'centre', inLibrary: true}];
    for (const {p, role} of keptShelf) nodes.push({id: String(p.id), label: text(p.title) || '(제목 없음)', year: Number(p.year) || null,
      citations: Number(p.citations) || 0, venue: text(p.venue), openalex: bare(p.openalex), kind: 'paper', role, inLibrary: true});
    for (const g of keptGhosts) nodes.push({id: 'W:' + g.openalex, label: g.title || g.openalex, year: g.year, citations: g.citations,
      venue: g.venue, openalex: g.openalex, doi: g.doi, kind: 'ghost', role: g.role, inLibrary: false, untitled: !g.title});

    const shown = new Set(nodes.map(n => n.id));
    const edges = [], seen = new Set();
    const add = (s, t) => { const k = s + '>' + t; if (s === t || !shown.has(s) || !shown.has(t) || seen.has(k)) return; seen.add(k); edges.push({source: s, target: t, kind: 'cites'}); };
    for (const n of nodes) {
      if (n.kind === 'ghost') {
        if (n.role === 'cites') add(nodes[0].id, n.id); else add(n.id, nodes[0].id);
      }
    }
    for (const p of confirmedCiters) add(String(p.id), nodes[0].id);
    const nodeByWork = new Map(nodes.filter(n => n.openalex).map(n => [n.openalex, n]));
    for (const n of nodes) {
      if (n.kind === 'ghost') continue;
      const p = byID.get(n.id);
      for (const ref of refSet(p)) { const t = nodeByWork.get(ref); if (t) add(n.id, t.id); }
    }
    const degree = new Map();
    for (const e of edges) { degree.set(e.source, (degree.get(e.source) || 0) + 1); degree.set(e.target, (degree.get(e.target) || 0) + 1); }
    for (const n of nodes) n.degree = degree.get(n.id) || 0;
    return {nodes, edges, counts, total: 1 + first.size + near.length + ghosts.length, shown: nodes.length,
      cut: nodes.length < 1 + first.size + near.length + ghosts.length};
  }

  /* A fixed, readable layout for one paper and its neighbours: what it cites
     on the left, what cites it on the right, shelf papers on the inner ring,
     ghosts and second-step papers further out. Force layout would put the
     same star in a different place every time the data changed. */
  function egoLayout(graph, {width = 760, height = 520, pad = 40} = {}) {
    const cx = width / 2, cy = height / 2;
    const nodes = graph.nodes.map(n => Object.assign({}, n));
    const rx = width / 2 - pad - 70, ry = height / 2 - pad;
    const groups = {cites: [], citedBy: [], both: [], near: []};
    for (const n of nodes) if (n.role !== 'centre') groups[n.role === 'near' ? 'near' : n.role].push(n);
    const place = (arr, from, to, ring) => {
      arr.forEach((n, i) => {
        const t = arr.length === 1 ? 0.5 : i / (arr.length - 1);
        const a = from + (to - from) * t;
        const stagger = 1 - 0.14 * (i % 2);
        n.x = cx + Math.cos(a) * rx * ring * stagger;
        n.y = cy + Math.sin(a) * ry * ring * stagger;
      });
    };
    const split = arr => [arr.filter(n => n.kind !== 'ghost'), arr.filter(n => n.kind === 'ghost')];
    const [citesShelf, citesGhost] = split(groups.cites), [byShelf, byGhost] = split(groups.citedBy);
    const R = Math.PI * 0.38;
    place(citesShelf, Math.PI - R, Math.PI + R, 0.55);
    place(citesGhost, Math.PI - R - 0.1, Math.PI + R + 0.1, 1);
    place(byShelf, -R, R, 0.55);
    place(byGhost, -R - 0.1, R + 0.1, 1);
    place(groups.both, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5, 0.5);
    place(groups.near, -Math.PI * 0.9, Math.PI * 0.9, 1.08);
    for (const n of nodes) {
      if (n.role === 'centre') { n.x = cx; n.y = cy; n.r = 14; n.rank = 1; continue; }
      n.r = n.kind === 'ghost' ? 6 : centralityRadius(n.role === 'near' ? 0.15 : 0.35);
      n.x = Math.max(pad / 2, Math.min(width - pad / 2, n.x));
      n.y = Math.max(pad / 2, Math.min(height - pad / 2, n.y));
    }
    return {nodes, edges: graph.edges};
  }

  const api = {collectionItemIDs, outsideCited, clusterCount, egoGraph, egoLayout, build, layout, coupling, radiusOf, centralityRadius, seeded, pagerank, foldCitedBy, placeLabels, placeLabelSides, placeLabelsAround, labelBox, textWidth};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStylePaperGraph = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

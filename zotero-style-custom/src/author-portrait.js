/* Finding one portrait for a followed author, and the people they work with.

   Ported from PostGrabbit's watched-PI photo discovery, which the user already
   relies on. The rules are kept rather than reinvented, because they exist to
   stop a lab's logo, a banner or a colleague's headshot being presented as the
   person: a candidate must be named on the page, and an ambiguous winner is
   refused outright rather than guessed.

   Pure: HTML in, a decision out. The caller makes every request, so nothing
   here can reach the network on its own. */
(function (root) {
  'use strict';

  const BAD = /(?:^|[\W_])(?:logo|icon|banner|hero|sprite|favicon|brand|seal|wordmark|ad)(?:[\W_]|$)/i;
  const GOOD = /(?:^|[\W_])(?:profile|portrait|headshot|faculty|professor|person|member|people)(?:[\W_]|$)/i;
  const MIN_SIDE = 160;
  const MAX_ASPECT = 3;
  const MIN_SCORE = 60;
  // Two candidates within a hair of each other is not an answer. Grabbit refuses
  // rather than picking, and so does this: a wrong face is worse than none.
  const MARGIN = 12;
  const CACHE_DAYS = 60;

  const text = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

  const normalise = value => text(value).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();

  function absolute(base, raw) {
    const value = text(raw);
    if (!value || /^data:/i.test(value)) return '';
    try {
      const url = new URL(value, base);
      // Only a public page can be a source. A plugin must never be talked into
      // fetching something off the machine it runs on.
      if (!/^https?:$/i.test(url.protocol)) return '';
      if (/^(localhost|\[?::1\]?|0\.0\.0\.0)$/i.test(url.hostname)) return '';
      if (/^(10\.|127\.|192\.168\.|169\.254\.)/.test(url.hostname)) return '';
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname)) return '';
      return url.href;
    } catch (ignored) { return ''; }
  }

  const decode = value => String(value)
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  /* Attribute values are HTML: "…?view_op=view_photo&amp;user=…" is the URL
     with an ampersand in it, and was being fetched with the "&amp;" intact. */
  const attrs = tag => {
    const found = {};
    for (const match of String(tag).matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      found[match[1].toLowerCase()] = decode(match[3] ?? match[4] ?? match[5] ?? '');
    }
    return found;
  };

  // Enough of a parse to read the three things that matter: what the page says
  // its headings are, what its images claim to be, and any JSON-LD Person.
  function readPage(markup) {
    const html = String(markup || '');
    const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]{0,400}?)<\/h[1-3]>/gi)]
      .map(m => text(decode(m[1].replace(/<[^>]*>/g, ' '))))
      .filter(Boolean);
    const images = [...html.matchAll(/<img\b([^>]*)>/gi)].map(m => attrs(m[1]));
    const meta = [];
    for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
      const a = attrs(m[1]);
      const kind = (a.property || a.name || '').toLowerCase();
      if (/image/.test(kind) && a.content) meta.push([kind, decode(a.content)]);
    }
    const jsonLd = [...html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
      .map(m => m[1]);
    const title = text(decode((/<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html) || [])[1] || ''));
    return {headings, images, meta, jsonLd, title};
  }

  function* walk(value) {
    if (Array.isArray(value)) { for (const item of value) yield* walk(item); return; }
    if (value && typeof value === 'object') {
      yield value;
      for (const item of Object.values(value)) yield* walk(item);
    }
  }

  function personImage(jsonLd, wanted) {
    for (const raw of jsonLd) {
      let parsed;
      try { parsed = JSON.parse(raw); } catch (ignored) { continue; }
      for (const item of walk(parsed)) {
        const kinds = [].concat(item['@type'] || []);
        if (!kinds.some(kind => String(kind).toLowerCase() === 'person')) continue;
        if (normalise(item.name) !== wanted) continue;
        let image = item.image;
        if (Array.isArray(image)) image = image[0];
        if (image && typeof image === 'object') image = image.url || image.contentUrl;
        if (text(image)) return text(image);
      }
    }
    return '';
  }

  // Alt text like "Sam Okafor" is a claim about who is pictured, and it is not
  // this author. Two capitalised words that are not part of the wanted name are
  // enough to disqualify a weak candidate.
  function namesSomeoneElse(claim, words) {
    const wanted = new Set(words);
    const names = (String(claim).match(/\b[A-Z][a-z]{1,}\b/g) || [])
      .map(word => word.toLowerCase())
      .filter(word => !wanted.has(word) && !GOOD.test(word) && !BAD.test(word));
    return new Set(names).size >= 2;
  }

  // The page must name the person. Everything else is a tie-breaker.
  function choose(markup, pageURL, name) {
    const page = readPage(markup);
    const wanted = normalise(name);
    const words = wanted.split(' ').filter(Boolean);
    if (!words.length) return null;
    const first = words[0], surname = words[words.length - 1];
    // Headings only, as in the original: a <title> is usually the whole site's,
    // so "Jane Roe -- Roe Lab" would make every page of that lab claim her.
    const signal = normalise(page.headings.join(' ')).split(' ');
    const namesThem = !!(first && surname && signal.includes(first) && signal.includes(surname));
    const pageAliases = new Set(page.headings.filter(h => /^[A-Z]{2,6}$/.test(h.trim())).map(h => h.trim()));
    let host = '';
    try { host = new URL(pageURL).hostname.toLowerCase(); } catch (ignored) { }

    const candidates = new Map();
    let offered = 0;
    const offer = (raw, score, source) => {
      if (score < MIN_SCORE || offered >= 16) return;
      offered++;
      const url = absolute(pageURL, raw);
      if (!url) return;
      if (score > (candidates.get(url) || [0])[0]) candidates.set(url, [score, source]);
    };

    const declared = personImage(page.jsonLd, wanted);
    if (declared) offer(declared, 180, 'json-ld Person.image');

    for (const image of page.images) {
      const src = image.src || image['data-src'] || image['data-lazy-src'] || '';
      const claim = ['alt', 'title', 'aria-label', 'class', 'id', 'src']
        .map(key => image[key] || '').join(' ');
      if (BAD.test(claim)) continue;
      const width = /^\d+$/.test(image.width || '') ? Number(image.width) : 0;
      const height = /^\d+$/.test(image.height || '') ? Number(image.height) : 0;
      // A favicon-sized image is not a portrait, and a long thin one is a banner.
      if ((width && width < MIN_SIDE) || (height && height < MIN_SIDE)) continue;
      if (width && height && Math.max(width / height, height / width) > MAX_ASPECT) continue;

      const claimWords = normalise(claim).split(' ').filter(Boolean);
      const tokens = new Set(claimWords);
      const exact = words.length > 0 && claimWords.some((_, at) =>
        words.every((word, offset) => claimWords[at + offset] === word));
      const both = !!(first && surname && tokens.has(first) && tokens.has(surname));
      let score = exact ? 110 : both ? 90 : 0;
      const aliases = new Set((claim.match(/\b[A-Z]{2,6}\b/g) || []));
      const aliasMatch = [...pageAliases].some(alias => aliases.has(alias));
      let sameHost = false;
      try { sameHost = new URL(absolute(pageURL, src) || 'about:blank').hostname.toLowerCase() === host; }
      catch (ignored) { }
      if (score === 0 && aliasMatch) score = 85 + (sameHost ? 20 : 0);
      const good = GOOD.test(claim);
      if (score && good) score += 30;
      // The weakest rule: an image a page that names this person calls a
      // portrait. It must not fire when the image itself names somebody else --
      // on a lab page, "Sam Okafor" under /people/ would otherwise be served up
      // as the author, which is the one mistake worth never making here.
      else if (namesThem && good && !namesSomeoneElse(claim, words)) score = 70;
      offer(src, score, 'homepage image');
    }

    if (namesThem) {
      for (const [kind, value] of page.meta) {
        offer(value, /^(og:|twitter:)/.test(kind) ? 65 : 60, kind);
      }
    }

    const ranked = [...candidates.entries()]
      .map(([url, [score, source]]) => ({url, score, source}))
      .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
    if (!ranked.length || ranked[0].score < MIN_SCORE) return null;
    // A declared Person.image is the page's own answer and needs no margin.
    if (ranked.length > 1 && ranked[0].source !== 'json-ld Person.image'
        && ranked[0].score - ranked[1].score < MARGIN) return null;
    return ranked[0];
  }

  // ORCID is the only place that reliably links a researcher to their own page.
  const orcidURL = orcid => {
    const id = /(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i.exec(text(orcid));
    return id ? `https://pub.orcid.org/v3.0/${id[1].toUpperCase()}/researcher-urls` : null;
  };

  function readResearcherURLs(payload) {
    const rows = payload && Array.isArray(payload['researcher-url']) ? payload['researcher-url'] : [];
    const urls = [];
    for (const row of rows) {
      const value = absolute('https://orcid.org/', row && (row.url && row.url.value));
      if (!value) continue;
      const label = text(row['url-name']).toLowerCase();
      // A personal or lab page first; a profile aggregator is unlikely to carry
      // a portrait this code can attribute with any confidence.
      const rank = /personal|home|lab|group|website|faculty/.test(label) ? 0
        : /twitter|x\.com|linkedin|github|scholar|researchgate/.test(value) ? 2 : 1;
      urls.push({url: value, label: text(row['url-name']), rank});
    }
    return urls.sort((a, b) => a.rank - b.rank).map(row => row.url).slice(0, 3);
  }

  /* Wikidata, by ORCID: the one public record that ties a researcher's
     identifier to a freely licensed photograph (P18, on Wikimedia Commons) and
     to an official website (P856). Found through the ordinary search API, not
     the query service, which rate-limits to one request a minute when busy.

     Two requests cover fifty people: a search for the items carrying these
     ORCIDs, then the items themselves. */
  const ORCID = /(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i;
  const bareOrcid = value => ((ORCID.exec(text(value)) || [])[1] || '').toUpperCase();
  const WIKIDATA = 'https://www.wikidata.org/w/api.php?format=json&formatversion=2&origin=*';
  const WIKIDATA_SEARCH_BATCH = 15;
  const WIKIDATA_ENTITY_BATCH = 50;
  function wikidataSearchURL(orcids) {
    const ids = [...new Set((orcids || []).map(bareOrcid).filter(Boolean))].slice(0, WIKIDATA_SEARCH_BATCH);
    if (!ids.length) return null;
    return `${WIKIDATA}&action=query&list=search&srlimit=50&srsearch=${encodeURIComponent('haswbstatement:' + ids.map(id => 'P496=' + id).join('|'))}`;
  }
  const readWikidataSearch = payload => (payload?.query?.search || [])
    .map(hit => text(hit?.title)).filter(title => /^Q\d+$/.test(title));
  function wikidataEntitiesURL(qids) {
    const ids = [...new Set((qids || []).filter(id => /^Q\d+$/.test(id)))].slice(0, WIKIDATA_ENTITY_BATCH);
    return ids.length ? `${WIKIDATA}&action=wbgetentities&props=claims&ids=${ids.join('|')}` : null;
  }
  const claim = (entity, property) => {
    const rows = entity?.claims?.[property];
    const row = Array.isArray(rows) ? rows.find(r => r?.rank === 'preferred') || rows.find(r => r?.rank !== 'deprecated') : null;
    return row?.mainsnak?.datavalue?.value ?? null;
  };
  // ORCID -> what Wikidata says about the person it belongs to.
  function readWikidataEntities(payload) {
    const out = new Map();
    const entities = payload?.entities || {};
    for (const entity of Object.values(entities)) {
      /* Every ORCID on the item, not the first: George Church's carries three,
         and OpenAlex knows him by the third. */
      const orcids = (Array.isArray(entity?.claims?.P496) ? entity.claims.P496 : [])
        .filter(row => row?.rank !== 'deprecated')
        .map(row => bareOrcid(row?.mainsnak?.datavalue?.value)).filter(Boolean);
      if (!orcids.length) continue;
      const image = text(claim(entity, 'P18'));
      const site = absolute('https://www.wikidata.org/', claim(entity, 'P856'));
      const scholar = scholarID(claim(entity, 'P1960'));
      for (const orcid of orcids) out.set(orcid, {qid: text(entity?.id), image, site, scholar});
    }
    return out;
  }
  /* A Google Scholar profile's own photo, by the profile ID Wikidata records
     (P1960): one image request, no search page read. A profile without a
     photo answers with Scholar's grey placeholder, which is a PNG; the
     photos people upload come back as JPEG, so only a JPEG counts. */
  const scholarID = value => /^[\w-]{12}$/.test(text(value)) ? text(value) : '';
  const scholarPhoto = id => scholarID(id)
    ? `https://scholar.googleusercontent.com/citations?view_op=view_photo&user=${scholarID(id)}&citpid=2` : '';
  const scholarPage = id => scholarID(id)
    ? `https://scholar.google.com/citations?user=${scholarID(id)}` : '';
  const scholarIsPhoto = type => /^image\/jpe?g\b/i.test(text(type));

  // A Commons file, at the size it will be drawn, and the page that credits it.
  const commonsFile = name => text(name).replace(/ /g, '_');
  const commonsThumb = (name, width = 160) => name
    ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(commonsFile(name))}?width=${width}` : '';
  const commonsPage = name => name
    ? `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(commonsFile(name))}` : '';

  const stale = (checkedAt, now = Date.now()) => {
    const when = Date.parse(text(checkedAt));
    return !Number.isFinite(when) || now - when > CACHE_DAYS * 24 * 3600 * 1000;
  };

  // A co-author network out of works already in hand. Nothing is inferred to
  // make the picture look connected: an edge exists because the two names are
  // on the same paper, and it says how many.
  function coauthors(works, authorID, {limit = 24} = {}) {
    const me = text(authorID).replace(/^https?:\/\/openalex\.org\//i, '');
    const people = new Map();
    for (const work of Array.isArray(works) ? works : []) {
      const on = (work.people || []).filter(person => person.id);
      if (!on.some(person => person.id === me)) continue;
      for (const person of on) {
        if (person.id === me) continue;
        const found = people.get(person.id) || {
          id: person.id, name: person.name, institution: person.institution || '', papers: 0, titles: [], last: null
        };
        found.papers++;
        if (!found.institution && person.institution) found.institution = person.institution;
        if (found.titles.length < 3 && work.title) found.titles.push(work.title);
        const year = Number(work.year) || null;
        if (year && (!found.last || year > found.last)) found.last = year;
        people.set(person.id, found);
      }
    }
    return [...people.values()]
      .sort((a, b) => b.papers - a.papers || (b.last || 0) - (a.last || 0) || a.name.localeCompare(b.name))
      .slice(0, limit);
  }


  /* One followed author's own relationship graph: the author in the middle and
     the people who share papers with them around, out of works already in hand
     (the tracked works, the news the last check stored, and the library's own
     author lists). No request is made. A co-author's weight is the number of
     distinct papers they share with the centre, a paper held in two places
     counting once; a paper naming a crowd says nothing about who works with
     whom and is skipped, as in the circle of followed authors. */
  const fold = value => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^\p{L}\s-]/gu, ' ').replace(/\s+/g, ' ').trim();
  const initialsOf = name => {
    const all = text(name).split(' ').filter(Boolean);
    const parts = all.filter((word, index) => index === 0 || !/^(jr|sr|ii|iii|iv|v)\.?,?$/i.test(word));
    if (!parts.length) return '?';
    return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  };
  const bareDoi = value => text(value).toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
  const CROWD = 30;
  function egoGraph({me, works, news, items, followed, limit = 20, fullLabels = 8} = {}) {
    const myID = text(me?.id).replace(/^https?:\/\/openalex\.org\//i, '');
    const myName = fold(me?.name);
    const shortID = value => text(value).replace(/^https?:\/\/openalex\.org\//i, '');
    /* The id is the identity. A name stands in only for a record that carries
       none (the stored news and the library's author lists are names alone):
       it joins the one person of that name the ids know, and stands by itself
       when two ids share it, rather than crediting either. Two John Smiths with
       different ids are two people; one id under two spellings is one. */
    const records = [];              // [paper key, [{id, name, folded}]]
    const idsByName = new Map();     // folded name -> Set of ids
    const collect = (key, list) => {
      const entries = [];
      for (const person of list) {
        const name = text(person.name), folded = fold(name);
        if (!folded) continue;
        const id = shortID(person.id);
        if (id) { if (!idsByName.has(folded)) idsByName.set(folded, new Set()); idsByName.get(folded).add(id); }
        entries.push({id, name, folded});
      }
      records.push([key, entries]);
    };
    for (const work of Array.isArray(works) ? works : [])
      collect(bareDoi(work.doi) || 'w:' + text(work.id), (work.people || []).map(p => ({id: p.id, name: p.name})));
    for (const work of Array.isArray(news) ? news : [])
      collect(bareDoi(work.doi) || 'w:' + text(work.id), (work.people || []).map(name => ({id: '', name: typeof name === 'string' ? name : name?.name})));
    for (const item of Array.isArray(items) ? items : [])
      collect(bareDoi(item.doi) || 'l:' + text(item.id), text(item.authors).split(';').map(name => ({id: '', name})));

    const people = new Map();        // identity -> {name, id, folded}
    const papers = new Map();        // paper key -> Set of identities (never the centre)
    for (const [key, entries] of records) {
      const names = new Set();
      let mine = false;
      for (const person of entries) {
        let identity;
        if (person.id) {
          // With ids on both sides the ids decide; a matching name alone never makes someone the centre.
          if (myID ? person.id === myID : person.folded === myName) { mine = true; continue; }
          identity = person.id;
        } else {
          const candidates = idsByName.get(person.folded);
          if (person.folded === myName && (!candidates || !myID || candidates.has(myID))) { mine = true; continue; }
          identity = candidates && candidates.size === 1 ? [...candidates][0] : 'n:' + person.folded;
        }
        names.add(identity);
        const known = people.get(identity);
        if (!known) people.set(identity, {name: person.name, id: identity.startsWith('n:') ? '' : identity, folded: person.folded});
        else if (person.name.length > known.name.length) known.name = person.name;
      }
      if (!mine || names.size + 1 > CROWD) continue;
      const held = papers.get(key) || new Set();
      for (const identity of names) held.add(identity);
      papers.set(key, held);
    }

    const weight = new Map();
    for (const names of papers.values()) for (const name of names) weight.set(name, (weight.get(name) || 0) + 1);
    const follow = Array.isArray(followed) ? followed : [];
    const ranked = [...people.entries()].filter(([key]) => weight.has(key))
      .map(([key, person]) => {
        // By id when both have one; a name only for a person drawn without an id.
        const who = follow.find(row => row && (person.id ? row.id && row.id === person.id : fold(row.name) === person.folded));
        return {key, name: person.name, authorID: person.id, weight: weight.get(key), who};
      })
      .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
    const total = ranked.length;
    const shownRows = ranked.slice(0, Number.isFinite(limit) ? Math.max(0, limit) : undefined);
    const nodes = shownRows.map((row, rank) => {
      const id = row.key;
      const followedAs = row.who ? {id: row.who.id, name: row.who.name} : null;
      const full = rank < fullLabels || !!followedAs;
      return {id, name: row.name, weight: row.weight, rank, followed: followedAs, authorID: row.authorID || '',
        full, label: full ? row.name : initialsOf(row.name), initials: initialsOf(row.name), tooltip: row.name};
    });
    const idByKey = new Map(shownRows.map((row, i) => [row.key, nodes[i].id]));
    const pair = new Map();
    for (const names of papers.values()) {
      const inside = [...names].filter(name => idByKey.has(name));
      if (inside.length < 2 || inside.length > 12) continue;
      for (let i = 0; i < inside.length; i++) for (let j = i + 1; j < inside.length; j++) {
        const a = idByKey.get(inside[i]), b = idByKey.get(inside[j]);
        const key = a < b ? a + '\u0000' + b : b + '\u0000' + a;
        const row = pair.get(key) || {source: a < b ? a : b, target: a < b ? b : a, weight: 0};
        row.weight++;
        pair.set(key, row);
      }
    }
    const links = [...pair.values()].sort((a, b) => b.weight - a.weight).slice(0, 30);
    return {
      centre: {id: myID || 'me', name: text(me?.name), initials: initialsOf(me?.name)},
      nodes, edges: nodes.map(node => ({source: myID || 'me', target: node.id, weight: node.weight})),
      links, total, shown: nodes.length, hidden: total - nodes.length
    };
  }

  /* Where everything goes: the author in the middle and the rest on concentric
     ellipses, the people whose names are written out placed at the sides, where a
     name has room, and the initials-only circles at the top and bottom. Pure, so the
     same numbers can be checked.

     How many fit on a ring is decided by its circumference and the size of the
     nodes, not by a fixed count: points are spaced by equal arc length, and rings
     are a node apart. When the frame is too small for all of them (a narrow panel
     with many co-authors) the canvas grows taller until they fit, and the answer
     says how tall it became (`height`); nothing is allowed to overlap or leave it. */
  function ellipseLength(a, b) {
    return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  }
  // `count` points at equal arc length around an ellipse, starting at the top, turned by `phase` of a step.
  function onEllipse(cx, cy, rx, ry, count, phase) {
    const steps = 1440, table = [0];
    for (let i = 1; i <= steps; i++) {
      const t0 = -Math.PI / 2 + 2 * Math.PI * (i - 1) / steps, t1 = -Math.PI / 2 + 2 * Math.PI * i / steps;
      table.push(table[i - 1] + Math.hypot(rx * (Math.cos(t1) - Math.cos(t0)), ry * (Math.sin(t1) - Math.sin(t0))));
    }
    const total = table[steps], out = [];
    for (let k = 0; k < count; k++) {
      const target = ((k + phase) / count % 1) * total;
      let lo = 0, hi = steps;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (table[mid] < target) lo = mid + 1; else hi = mid; }
      const i = Math.max(1, lo), span = table[i] - table[i - 1] || 1, f = (target - table[i - 1]) / span;
      const t = -Math.PI / 2 + 2 * Math.PI * (i - 1 + f) / steps;
      out.push({angle: t, x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t)});
    }
    return out;
  }
  function egoLayout(graph, {width = 760, height = 360} = {}) {
    const maxWeight = Math.max(1, ...graph.nodes.map(node => node.weight));
    const picked = graph.nodes.slice(0, 48).map(node => ({...node,
      rad: node.followed ? 17 : 12 + Math.round(5 * Math.sqrt(node.weight / maxWeight))}));
    const omitted = Math.max(0, graph.nodes.length - 48);
    const centreRad = 26, gap = 8;
    const labelRoom = Math.min(150, Math.round(width * 0.25));
    const widest = Math.max(17, ...picked.map(node => node.rad));
    const cell = 2 * widest + gap;
    const innerR = centreRad + widest + gap;
    const build = H => {
      const rx0 = Math.max(innerR, width / 2 - labelRoom - widest - 6), ry0 = Math.max(innerR, H / 2 - widest - 6);
      const rings = [];
      for (let k = 0; ; k++) {
        const rx = rx0 - k * cell * 1.15, ry = ry0 - k * cell * 1.15;
        if (rx < innerR || ry < innerR) break;
        rings.push({rx, ry, cap: Math.max(1, Math.floor(ellipseLength(rx, ry) / cell))});
      }
      return rings;
    };
    const place = H => {
      const rings = build(H), total = rings.reduce((sum, ring) => sum + ring.cap, 0);
      if (total < picked.length) return null;
      // Spread by capacity, so no ring is packed while another stands empty.
      const counts = rings.map(ring => Math.min(ring.cap, Math.floor(picked.length * ring.cap / total)));
      let left = picked.length - counts.reduce((a, b) => a + b, 0);
      while (left > 0) {
        let best = -1;
        rings.forEach((ring, k) => { if (counts[k] < ring.cap && (best < 0 || ring.cap - counts[k] > rings[best].cap - counts[best])) best = k; });
        counts[best]++; left--;
      }
      const cx = width / 2, cy = H / 2, placed = [];
      let from = 0;
      rings.forEach((ring, k) => {
        const members = picked.slice(from, from + counts[k]);
        from += members.length;
        if (!members.length) return;
        const slots = onEllipse(cx, cy, ring.rx, ring.ry, members.length, k % 2 ? 0.5 : 0);
        // Written-out names take the positions nearest the left and right edges of the ring.
        const order = slots.map((slot, i) => ({slot, i})).sort((a, b) => Math.abs(Math.cos(b.slot.angle)) - Math.abs(Math.cos(a.slot.angle)));
        const full = members.filter(node => node.full), rest = members.filter(node => !node.full);
        [...full, ...rest].forEach((node, i) => {
          const slot = order[i].slot;
          placed.push({...node, x: slot.x, y: slot.y, side: Math.cos(slot.angle) >= 0 ? 'start' : 'end'});
        });
      });
      const centre = {id: graph.centre.id, name: graph.centre.name, x: cx, y: cy, rad: centreRad, centre: true};
      const all = [centre, ...placed];
      for (const n of all) if (n.x - n.rad < 0 || n.x + n.rad > width || n.y - n.rad < 0 || n.y + n.rad > H) return null;
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++)
        if (Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y) < all[i].rad + all[j].rad + 1) return null;
      return {centre, nodes: placed};
    };
    let H = height, laid = null;
    for (let attempt = 0; attempt < 80 && !laid; attempt++) {
      laid = place(H);
      if (!laid) H += 40;
    }
    if (!laid) {
      // Cannot happen for 48 nodes; the last frame is still returned rather than nothing.
      const centre = {id: graph.centre.id, name: graph.centre.name, x: width / 2, y: H / 2, rad: centreRad, centre: true};
      laid = {centre, nodes: picked.map((node, i) => ({...node, x: width / 2 + (i % 8) * 40 - 140, y: 40 + Math.floor(i / 8) * 40, side: 'start'}))};
    }
    return {centre: laid.centre, nodes: laid.nodes.filter(node => Number.isFinite(node.x)), omitted, width, height: H};
  }

  const api = {choose, readPage, personImage, orcidURL, readResearcherURLs, stale, coauthors, egoGraph, egoLayout,
    normalise, absolute, CACHE_DAYS, MIN_SCORE, MARGIN,
    bareOrcid, wikidataSearchURL, readWikidataSearch, wikidataEntitiesURL, readWikidataEntities,
    commonsThumb, commonsPage, scholarID, scholarPhoto, scholarPage, scholarIsPhoto, WIKIDATA_SEARCH_BATCH, WIKIDATA_ENTITY_BATCH};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleAuthorPortrait = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

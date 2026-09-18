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

  const attrs = tag => {
    const found = {};
    for (const match of String(tag).matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      found[match[1].toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? '';
    }
    return found;
  };

  const decode = value => String(value)
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

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

  const api = {choose, readPage, personImage, orcidURL, readResearcherURLs, stale, coauthors,
    normalise, absolute, CACHE_DAYS, MIN_SCORE, MARGIN};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleAuthorPortrait = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

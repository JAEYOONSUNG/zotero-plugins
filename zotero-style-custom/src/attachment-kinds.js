/* Telling an article apart from its supplementary file by reading it.

   The old rule looked at filenames: mmc1.pdf, 41586_..._MOESM1_ESM.pdf, s1.pdf.
   In this library that rule flags 1 file out of 1,229, because ZotMoov renames
   every attachment to "Author - Year - Title.pdf" and the publisher's name is
   gone. The filename carries no signal at all here.

   The first page does. A supplementary file says so in its opening words, and
   an article carries a masthead, a section label or a DOI line. Zotero already
   extracts that text for its own search index, so reading it costs nothing.

   Three things turn up in a library with more than one PDF on an item, and they
   are not the same thing: a real supplementary file, the same file attached
   twice, and a completely different paper filed under the wrong item. Saying
   "SI x2" for all three is what made the badge untrustworthy. */
(function (root) {
  'use strict';

  const text = value => String(value == null ? '' : value)
    // A ligature that failed to extract arrives as U+FFFD, turning "Article"
    // into "Artic?e" and matching nothing. A single letter is the right guess.
    .replace(/\uFFFD/g, 'l')
    .replace(/\s+/g, ' ').trim();

  // Comparison form: publishers break words across columns and use ligatures,
  // so only letters and digits survive.
  const flat = value => text(value)
    // Zotero titles carry markup: <span style="font-variant:small-caps;">BREX</span>.
    // Left in, the title's words become "span style font variant small caps",
    // which appear in no PDF, and twelve correctly filed papers were reported
    // as somebody else's.
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();

  // How much of the front matter to judge on. A first page is about this long,
  // and an article that merely cites "supplementary Fig. 3" later must not be
  // mistaken for one.
  const OPENING = 1200;
  const STRONG_WINDOW = 320;

  // What a supplementary file calls itself, in the words publishers actually
  // use. Every one of these was read off a real file in this library.
  const SUPPLEMENTARY = [
    /supplement(?:ary|al)\s+(?:information|materials?|data|methods?|figures?|tables?|notes?|appendix|discussion|text)/i,
    /supporting\s+information/i,
    /^\s*supplement(?:ary|al)\b/i,
    /extended\s+data\s+(?:figures?|tables?|items?)/i,
    /electronic\s+supplementary\s+material/i,
    // Nature stamps this on every unedited author-supplied file.
    /in\s+the\s+format\s+provided\s+by\s+the\s+authors?\s+and\s+unedited/i,
    /appendix\s+[sa]?\d/i,
    /보충\s*자료|부록/
  ];

  // What an article looks like at the top: a section label, a masthead, or the
  // publication record. None of these ever opens a supplementary file.
  const ARTICLE = [
    /^\s*(?:research|review|original|short|brief)?\s*(?:article|paper|report|communication|letter)s?\b/i,
    /^\s*(?:r\s*e\s*s\s*e\s*a\s*r\s*c\s*h\s+a\s*r\s*t\s*i\s*c\s*l\s*e)/i,
    /^\s*original\s+research\b/i,
    /^\s*(?:chapter|perspective|editorial|commentary|news\s*(?:&|and)\s*views)\b/i,
    /received:?\s*\d{1,2}\s+\w+\s+\d{4}/i,
    /\breceived\b[^.]{0,40}\baccepted\b/i,
    /\bvol(?:ume)?\.?\s*\d+\b[^.]{0,30}\b(?:no|issue|pp?)\b/i,
    /\|\s*vol(?:ume)?\.?\s*\d+\s*(?:\||\bno\b)/i,
    // "Nature Chemical Biology | Volume 20 | June 2024 | 689-698"
    /\|\s*(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\s*\|/i,
    /\bdoi:?\s*(?:https?:\/\/doi\.org\/)?10\.\d{4,9}\//i,
    /\bissn\b/i,
    /\ball\s+rights\s+reserved\b/i
  ];

  const hit = (patterns, value) => patterns.some(pattern => pattern.test(value));

  // A supplementary marker is only worth much at the very top. Further down it
  // is just an article pointing at its own extras.
  function openingKind(raw) {
    const opening = text(raw).slice(0, OPENING);
    if (!opening) return {kind: 'unknown', why: 'no extracted text', score: 0};
    const strong = opening.slice(0, STRONG_WINDOW);

    const supplementaryEarly = hit(SUPPLEMENTARY, strong);
    const articleEarly = hit(ARTICLE, strong);

    if (supplementaryEarly && !articleEarly) {
      return {kind: 'supplementary', why: 'says so in its opening words', score: 3};
    }
    if (articleEarly && !supplementaryEarly) {
      return {kind: 'article', why: 'opens like an article', score: 3};
    }
    if (supplementaryEarly && articleEarly) {
      // Both, at the top. Which came first decides it: "Supplementary
      // information ... Nature | Vol 615" is a supplement to that article.
      const first = (list) => Math.min(...list.map(p => {
        const found = p.exec(strong);
        return found ? found.index : Infinity;
      }));
      const s = first(SUPPLEMENTARY), a = first(ARTICLE);
      if (s !== a) return {kind: s < a ? 'supplementary' : 'article', why: 'both markers; the earlier one decides', score: 2};
    }
    if (hit(SUPPLEMENTARY, opening)) {
      return {kind: 'unknown', why: 'mentions supplements, but not at the top', score: 1};
    }
    if (hit(ARTICLE, opening)) return {kind: 'article', why: 'article markers below the fold', score: 1};
    return {kind: 'unknown', why: 'nothing decisive on the first page', score: 0};
  }

  // Two files are the same document when their first pages agree. Publishers
  // re-flow text between downloads, so this compares content, not bytes.
  function sameDocument(a, b, {need = 0.9} = {}) {
    const left = flat(a).slice(0, 600), right = flat(b).slice(0, 600);
    if (!left || !right) return false;
    if (left === right) return true;
    const shorter = left.length < right.length ? left : right;
    const longer = left.length < right.length ? right : left;
    if (shorter.length < 80) return false;
    if (longer.startsWith(shorter)) return true;
    const words = new Set(shorter.split(' ').filter(w => w.length > 2));
    if (!words.size) return false;
    const other = new Set(longer.split(' ').filter(w => w.length > 2));
    let shared = 0;
    for (const word of words) if (other.has(word)) shared++;
    return shared / words.size >= need;
  }

  /* Does this document belong to the paper it is filed under?

     Judged on the whole text, not the first page. A first page often opens with
     the abstract and never repeats the title, so scoring page one marked real
     articles as foreign: a Nature Chemical Biology review scored 43% and a
     CRISPR classification paper 25%, both correctly filed. Across a whole
     document the separation is clean, because a paper uses its own title words
     throughout and somebody else's paper does not. */
  /* The threshold is measured, not guessed. Over all 1,211 attachments in this
     library that have extracted text, 1,186 use every word of their paper's
     title; the rest fall away in a thin tail. Everything below 0.70 is a real
     filing mistake -- a Science Perspective under a catalogue paper, a TneDI
     cloning paper under two different restriction-enzyme papers -- and
     everything at 0.80 and above is a correctly filed paper whose title the
     extractor mangled. Nothing sits in between. */
  function namesTitle(raw, title, {need = 0.7, window = 60000} = {}) {
    const wanted = [...new Set(flat(title).split(' ').filter(word => word.length > 3))];
    if (wanted.length < 3) return null;
    const body = flat(raw).slice(0, window);
    if (!body) return null;
    const words = new Set(body.split(' '));
    let found = 0;
    for (const word of wanted) if (words.has(word)) found++;
    const share = found / wanted.length;
    return {matched: share >= need, share, checked: wanted.length};
  }

  /* One verdict per file on an item, given each file's first page.

     files: [{id, name, text}]  ->  [{id, kind, why, duplicateOf}]
     kinds: article | supplementary | duplicate | foreign | unknown */
  function classifyGroup(files, {title = ''} = {}) {
    const rows = (Array.isArray(files) ? files : []).map(file => ({
      id: file.id, name: text(file.name), body: text(file.text),
      ...openingKind(file.text)
    }));
    if (!rows.length) return [];
    const usableTitle = flat(title).split(' ').filter(word => word.length > 3).length >= 3;
    const belongs = row => usableTitle ? namesTitle(row.body, title) : null;

    if (rows.length === 1) {
      const only = rows[0];
      const named = belongs(only);
      return [{
        id: only.id, name: only.name, duplicateOf: null,
        kind: only.kind === 'supplementary' ? 'supplementary'
          : named && !named.matched ? 'foreign' : 'article',
        why: only.kind === 'supplementary' ? only.why
          : named && !named.matched ? `this document never uses the title of the paper it is filed under (${Math.round(named.share * 100)}%)`
          : 'the only file'
      }];
    }

    const out = rows.map(row => ({id: row.id, name: row.name, kind: 'unknown', why: row.why, duplicateOf: null}));

    // 1. The same document twice is neither an article and its supplement nor a
    //    filing mistake, and calling it "SI x2" was the commonest thing wrong.
    for (let i = 0; i < rows.length; i++) {
      if (out[i].duplicateOf) continue;
      for (let j = i + 1; j < rows.length; j++) {
        if (out[j].duplicateOf) continue;
        if (sameDocument(rows[i].body, rows[j].body)) {
          out[j].duplicateOf = rows[i].id;
          out[j].kind = 'duplicate';
          out[j].why = 'the same document as another file on this item';
        }
      }
    }

    // 2. A file that says it is supplementary is supplementary. This outranks
    //    the title check: a supplement that opens with a table of contents may
    //    never name its own paper, and used to be reported as a filing mistake.
    for (const [index, row] of rows.entries()) {
      if (out[index].kind === 'duplicate') continue;
      if (row.kind === 'supplementary' && row.score >= 2) {
        out[index].kind = 'supplementary';
        out[index].why = row.why;
      }
    }

    // 3. A document that never uses the title's words anywhere is a different
    //    paper filed under this item -- a real error, worth saying out loud.
    for (const [index, row] of rows.entries()) {
      if (out[index].kind !== 'unknown') continue;
      const named = belongs(row);
      if (named && !named.matched) {
        out[index].kind = 'foreign';
        out[index].why = `this document never uses the title of the paper it is filed under (${Math.round(named.share * 100)}% of ${named.checked} words)`;
      }
    }

    // 4. What is left and opens like an article is the article.
    for (const [index, row] of rows.entries()) {
      if (out[index].kind !== 'unknown') continue;
      if (row.kind === 'article') { out[index].kind = 'article'; out[index].why = row.why; }
    }

    // 5. By elimination: on an item that already has exactly one article, a
    //    remaining file that does belong to this paper is its supplement.
    if (out.filter(row => row.kind === 'article').length === 1) {
      for (const [index, row] of rows.entries()) {
        if (out[index].kind !== 'unknown') continue;
        const named = belongs(row);
        if (named && named.matched) {
          out[index].kind = 'supplementary';
          out[index].why = 'the item already has its article, and this belongs to the same paper';
        }
      }
    }

    // 6. Nothing said article, but something belongs here: the one that belongs
    //    best is the article rather than everything staying unknown.
    if (!out.some(row => row.kind === 'article')) {
      let best = -1, bestShare = -1;
      for (const [index, row] of rows.entries()) {
        if (out[index].kind !== 'unknown') continue;
        const named = belongs(row);
        const share = named ? named.share : 0;
        if (share > bestShare) { bestShare = share; best = index; }
      }
      if (best >= 0 && (bestShare >= 0.75 || !usableTitle)) {
        out[best].kind = 'article';
        out[best].why = usableTitle ? 'the file that best matches this paper' : 'the first readable file';
      }
    }
    return out;
  }

  // A title with the supplement marker taken off it. Twenty-two items in this
  // library are a supplement filed as its own bibliography entry, and five of
  // them say so in the title: "[Supplementary] Mechanism of DNA entrapment...".
  // Letters only, not \w: an underscore is a word separator here, and a greedy
  // \w* swallowed "Supplementrary_Landscape" whole, taking the title with it.
  const MARKER = /(^|[\s\[(_-])(supplement[a-z]*|supple|supporting\s+informations?|si|esm|보충자료|부록)([\s\])_:-]|$)/gi;
  const withoutMarker = title => text(title).replace(/<[^>]*>/g, ' ').replace(MARKER, ' ').trim();

  /* Which paper in the library does this supplement belong to?

     The answer is a suggestion, never an instruction. Two things make a wrong
     guess easy: a short generic title ("Cell-free gene expression") matches
     almost any document, and a library often holds two papers by the same group
     on the same molecule. So a candidate has to be specific enough to mean
     something, and has to beat the runner-up clearly; otherwise this says it
     does not know, which is the honest answer and the safe one. */
  function findHome(supplement, candidates, {need = 0.85, gap = 0.2, minWords = 5, window = 600} = {}) {
    // Only the title block at the very top, not the first page. Further down, a
    // supplement cites its neighbours: one here matched a different paper by the
    // same group on the same enzyme, fully, from a sentence in its methods.
    const opening = new Set(flat(supplement?.text).slice(0, window).split(' '));
    const ownTitle = flat(withoutMarker(supplement?.title));
    const ownWords = new Set(ownTitle.split(' ').filter(word => word.length > 3));
    if (!opening.size && !ownWords.size) return null;

    const scored = [];
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (!candidate || String(candidate.id) === String(supplement?.id)) continue;
      const words = [...new Set(flat(candidate.title).split(' ').filter(word => word.length > 3))];
      // A three-word title made of common words is not evidence of anything.
      if (words.length < minWords) continue;
      // The title route is the trustworthy one; body text is a weaker signal and
      // is held to a higher bar rather than being treated as equal evidence.
      const inText = words.filter(word => opening.has(word)).length / words.length;
      const inTitle = ownWords.size ? words.filter(word => ownWords.has(word)).length / words.length : 0;
      const viaTitle = inTitle >= inText;
      scored.push({id: candidate.id, title: candidate.title, viaTitle,
        share: viaTitle ? inTitle : inText * 0.95});
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.share - a.share);
    const [best, next] = scored;
    if (best.share < need) return null;
    // Two candidates that fit equally well means the library holds a pair, and
    // picking one of them at random is how a supplement ends up on the wrong
    // paper -- exactly the mistake this whole feature exists to find.
    if (next && best.share - next.share < gap) {
      return {id: null, share: best.share, ambiguous: [best, next].map(row => ({id: row.id, title: row.title}))};
    }
    return {id: best.id, title: best.title, share: best.share, viaTitle: best.viaTitle, ambiguous: null};
  }

  // What the column should say about an item, in one short label.
  function summarise(verdicts) {
    const rows = Array.isArray(verdicts) ? verdicts : [];
    const count = kind => rows.filter(row => row.kind === kind).length;
    return {
      pdfs: rows.length,
      article: count('article'),
      supplementary: count('supplementary'),
      duplicate: count('duplicate'),
      foreign: count('foreign'),
      unknown: count('unknown')
    };
  }

  const api = {openingKind, sameDocument, namesTitle, classifyGroup, summarise, findHome, withoutMarker, flat, OPENING, STRONG_WINDOW};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleAttachmentKinds = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

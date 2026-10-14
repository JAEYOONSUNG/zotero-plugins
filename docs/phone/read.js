/* Turning Zotero's stored full text into something worth listening to.

   The phone does not have the PDF: it asks Zotero for the text it already indexed
   (GET /items/<attachment>/fulltext), which arrives as one string with a form feed between
   pages. That text carries everything the page carried — the running head on every page, the
   "Downloaded from ..." stamp down the margin, the figure captions, the reference list — and
   reading it out loud start to finish is what makes Zotero's own Read Aloud tiring.

   So the text is cleaned first:
     - lines that come back on page after page (running heads, footers, journal stamps) are dropped
     - the usual furniture (page numbers, download stamps, licence lines, bare URLs) goes
     - the body stops where the references begin
     - captions are set aside, to be read only if asked for
     - words broken across a line are put back together, and in-text citations are taken out of
       what is spoken while the sentence itself keeps them
   and only then is it split into sentences.

   Everything here is a pure function of the text, so it is tested without a phone. */

const PAGE = '\f';

/* ---- the furniture ---- */
/* Some PDFs come out of extraction with almost no line breaks: a whole page is one line. A rule
   that looks for a stamp ANYWHERE in a line would then throw the page away for one "| www." in
   it, so those rules are only allowed to condemn a line short enough to be a stamp itself. */
const STAMP_LENGTH = 200;

const FURNITURE = [
  /^\s*\d{1,4}\s*$/,                                        // a bare page number
  /^\s*(?:page\s+)?\d{1,4}\s*(?:of|\/)\s*\d{1,4}\s*$/i,
  /^\s*this content downloaded/i,
  /^\s*(?:https?:\/\/|www\.|doi:)\S*\s*$/i,
  /^\s*(?:see discussions|citations:?\s*\d+|reads\s*\d+)\s*$/i,
  /^\s*author manuscript\b/i,
  /^\s*\[?(?:e|pre)?print\]?\s*$/i,
  /^\s*check for updates\s*$/i,
  /^\s*(?:received|accepted|revised|published(?:\s+online)?|available online)\s*[:,]?\s*(?:\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  /^\s*\d{0,2}\s*(?:department|institute|institut|laborator(?:y|ies)|school|college|faculty|division)\s+(?:of|for|de|,)/i,
  /^\s*keywords?\s*[:：]/i,
  /^\s*\*?\s*(?:e-?mail|correspondence|corresponding author|lead contact)\s*[:.]/i,
  /^\s*\d{0,2}\s*these authors (?:contributed|jointly)/i
];

/* Stamps recognised by what they contain rather than by where they start: only ever applied to a
   line short enough to be nothing but a stamp. */
const STAMP_INSIDE = [
  /downloaded\s+from/i,
  /all rights reserved/i, /©|\(c\)\s*\d{4}/,
  /creativecommons\.org/i, /\bHHS Public Access\b/i,
  /1234567890\(\)/,                                          // the glyph table some PDFs leave in the text
  /\|\s*(?:doi:|www\.|https?:\/\/)/i,                       // a journal citing itself across the top of every page
  /\blicen[cs]e information\b/i, /\bexclusive licensee\b/i
];

/* The front matter of a journal paper: who wrote it, where they work, how to reach them, when it
   was received, and the licence it is published under. All of it sits before the first word of
   the paper and all of it was being read out before it — which is most of the first minute. */
const FRONT = [
  /\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/i,                      // an address to write to
  /\borcid\.org\b/i,
  /^\s*(?:received|accepted|revised|published(?:\s+online)?|available online)\s*[:,]?\s*\d/i,
  /^\s*(?:keywords?|key words|subject (?:areas|terms)|abbreviations)\s*[:：]/i,
  /^\s*(?:doi|https?:\/\/doi\.org)\b/i,
  /^\s*\d{0,2}\s*(?:department|institute|institut|laborator(?:y|ies)|school|college|faculty|division|centre|center|graduate school)\s+(?:of|for|de|,)/i,
  /^\s*\d{0,2}\s*(?:these authors|corresponding author|correspondence|present address|e-?mail)\b/i,
  /^\s*\*?\s*correspondence\s*(?:and requests|to|:)/i
];
/* The licence, which is paragraphs of it and never the paper. */
const LICENCE = /\b(?:creative\s+commons|this article is licensed under|open access this article|the images or other third[- ]party material|permits use, sharing|no changes were made)\b/i;

/* A line from a reference list that is not under a "References" heading — some PDFs run it on. */
const REFERENCE_LINE = /^\s*\[?\d{1,3}[.\]]\s+\p{Lu}[^\n]{0,180}?(?:\((?:19|20)\d\d\)|\b(?:19|20)\d\d[a-z]?[;.,]|\bdoi\.org\/|\bet al\.)/u;

/* A journal's own stamp run together with the first words of the page, which happens when the
   text comes out of the PDF in one line: "802 | VOL.11 NO.8 | AUGUST 2014 | nature methods for
   the first time...". The stamp is cut off the front and the words are kept. */
const STAMPS = [
  /^\s*\d{1,4}\s*\|(?:[^|]{1,40}\|){1,3}\s*/,
  /^\s*(?:vol\.?\s*\d+[^|]{0,30}\|)\s*/i,
  /^\s*downloaded from [^\s]+(?: at [^,]{0,60})?(?: on [A-Z][a-z]+ \d{1,2}, \d{4})?\s*/i,
  /^\s*nature (?:methods|biotechnology|communications|microbiology|reviews [a-z]+)\s*\|\s*/i
];
export function stripStamp(line) {
  let out = String(line), cut = false;
  for (const stamp of STAMPS) {
    const shorter = out.replace(stamp, '');
    if (shorter !== out) { cut = true; out = shorter; }
  }
  // What follows the last bar is usually the journal's own name — lower case words before the
  // capital that starts the page's first sentence. A line never begins in lower case otherwise.
  if (cut) out = out.replace(/^(?:[a-z][a-z.&]*\s+){1,4}(?=\p{Lu})/u, '');
  return out.trim() || String(line).trim();
}
const REFERENCES = /^\s*(?:\d+\.?\s*)?(references?|bibliography|literature cited|works cited|참고\s*문헌)\s*:?\s*$/i;
const BACK = /^\s*(?:\d+\.?\s*)?(acknowledge?ments?|author contributions?|competing interests?|conflicts? of interest|data availability|supplementary (?:information|material)|funding|ethics|감사의 글)\s*:?\s*$/i;
const CAPTION = /^\s*(?:(?:supplementary|extended data|supporting)\s+)?(?:fig(?:ure)?s?|table|box|scheme|chart|plate)\s*\.?\s*(?:s\s*)?\d+[a-z]?\s*(?:[.:|)\]–-]|$)/i;
const HEADING = /^(?:(?:\d+(?:\.\d+){0,3}|[IVX]+)[.)]?\s+)?(abstract|introduction|background|related work|methods?|materials and methods|experimental(?: procedures)?|results?(?: and discussion)?|discussion|conclusions?|limitations?|초록|서론|방법|결과|논의|결론)(?![\p{L}\p{N}])[\s:.]*$/iu;

const norm = line => line.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();

/* Lines that appear, in the same shape, near the top or the bottom of many pages: the running
   head and the footer. Kept to the edges so a sentence that happens to repeat is not lost.
   A paper of two or three pages has too few to go by counting, so there a line is only dropped
   when it is on every page and does not end like a sentence. */
export function repeatedLines(pages, {edge = 3, share = 0.5} = {}) {
  if (pages.length < 2) return new Set();
  const few = pages.length < 4;
  const seen = new Map();
  // Counted by page number, not by the page's text: two pages that read the same are still two.
  pages.forEach((page, at) => {
    const lines = page.split('\n').map(l => l.trim()).filter(Boolean);
    const edges = new Set([...lines.slice(0, edge), ...lines.slice(-edge)]);
    for (const line of edges) {
      // A long line may still be a stamp, but only if it does not read like a sentence.
      if (line.length > 160 || (line.length > 90 && /[.!?]$/.test(line))) continue;
      const key = norm(line);
      if (!key || key.length < 4) continue;
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key).add(at);
    }
  });
  const out = new Set();
  for (const [key, where] of seen) {
    if (few) { if (where.size === pages.length && key.length <= 60 && !/[.!?]$/.test(key)) out.add(key); }
    else if (where.size >= Math.max(3, Math.ceil(pages.length * share))) out.add(key);
  }
  return out;
}

/* A line of running text, or something that only looks like one? */
const isJunk = (line, repeats, {inRefs = false} = {}) =>
  !line ||
  FURNITURE.some(re => re.test(line)) ||
  (line.length <= STAMP_LENGTH && STAMP_INSIDE.some(re => re.test(line))) ||
  repeats.has(norm(line)) ||
  (!inRefs && REFERENCE_LINE.test(line));

/* Who wrote it and where — true of a whole block, not of one line, because an affiliation runs
   over several and an address sits on the end of one. */
/* The line of authors under a title: names each carrying the small numbers that point at an
   affiliation, separated by commas, and never a sentence. It can run very long, so it is
   recognised by its shape rather than by its length — and only before the paper has begun, where
   an author list is the only thing that looks like this. */
export function isAuthorList(line) {
  const names = (line.match(/\p{Lu}\p{L}{2,}\s*\d{1,2}(?:\s*,\s*\d{1,2})*/gu) || []).length;
  const commas = (line.match(/,/g) || []).length;
  const stops = (line.match(/[.!?]\s/g) || []).length;
  return names >= 4 && commas >= 4 && stops === 0;
}

export const isFrontMatter = block =>
  isAuthorList(block) || (block.length <= STAMP_LENGTH * 4 && FRONT.some(re => re.test(block)));

/* The same question of one line. Some PDFs give back a whole page as a single block, so the front
   matter has to be recognised line by line as well as block by block. */
export const isFrontLine = line =>
  isAuthorList(line) || (line.length <= STAMP_LENGTH * 2 && FRONT.some(re => re.test(line)));

/* "trans-\nporter" is one word; "RNA-\nguided" keeps its hyphen. */
function dehyphenate(text) {
  return text.replace(/(\p{Ll})-\n(\p{Ll})/gu, '$1$2').replace(/(\p{L})\n(?=\p{L})/gu, '$1 ').replace(/\n+/g, ' ');
}

/* What is said out loud: the citations go, the sentence on screen keeps them. */
export function spokenForm(text) {
  return String(text)
    .replace(/\s*\[(?:\s*\d+\s*(?:[-–,]\s*\d+\s*)*)+\]/g, '')                      // [1], [2-4], [1,5]
    .replace(/\s*\((?:[^()]*?\b(?:et al\.?|and colleagues)[^()]*?|\s*(?:19|20)\d\d[a-z]?(?:\s*[;,]\s*(?:19|20)\d\d[a-z]?)*\s*)\)/g, '')
    .replace(/\s*\(\s*(?:fig(?:ure|s)?|table|eq|supplementary)\.?\s*[^)]{0,20}\)/gi, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* ---- sentences ---- */
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|et al|fig|figs|eq|eqs|ref|refs|vs|cf|approx|dr|prof|no|vol|sec|tab|resp|ca|mr|ms|mrs|st|inc|ltd|co|al|sp|spp|var|subsp)\.$/i;
export const LONG = 400;

/* A run this long has usually lost its full stops to the PDF, and a voice reading it gives the
   reader nowhere to get off. It is broken at a semicolon or a colon — never one inside brackets,
   which in a paper is a list of structures or genes rather than a pause. */
export function breakLong(text, limit = LONG) {
  if (text.length <= limit) return [text];
  // Every pause the writer put in, outside any bracket.
  const pieces = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === ';' || c === ':') && text[i + 1] === ' ') {
      pieces.push(text.slice(start, i + 1).trim());
      start = i + 2;
    }
  }
  const rest = text.slice(start).trim();
  if (rest) pieces.push(rest);
  if (pieces.length < 2) return [text];
  // Put the small ones back together, so the breaking makes breaths rather than scraps.
  const out = [];
  for (const piece of pieces) {
    const last = out[out.length - 1];
    if (last && last.length + piece.length + 1 <= limit) out[out.length - 1] = `${last} ${piece}`;
    else out.push(piece);
  }
  return out;
}

export function splitSentences(text) {
  const source = String(text).replace(/\s+/g, ' ').trim();
  if (!source) return [];
  const out = [];
  let start = 0;
  const boundary = /[.!?。？！…]+["'”’)\]]*(?=\s)/g;
  let m;
  while ((m = boundary.exec(source))) {
    const end = m.index + m[0].length;
    const head = source.slice(start, end), tail = source.slice(end).trimStart();
    if (!tail) break;
    if (ABBREVIATION.test(head)) continue;
    if (/(?:^|\s)[A-Z]\.$/.test(head)) continue;                 // an initial: "J. Smith"
    if (/^[a-z(\[]/.test(tail) && /[.]$/.test(m[0])) continue;   // "...fig. shows" carries on
    out.push(head.trim());
    start = end;
  }
  const rest = source.slice(start).trim();
  if (rest) out.push(rest);
  return out.flatMap(piece => breakLong(piece));
}

/* ---- the whole paper ---- */
/* Returns {sections, captions, skipped, stats}. A section is {heading, page, sentences:[{text, spoken, page}]}.
   `title` lets the first page's title block be recognised and not read twice. */
export function readable(raw, {title = ''} = {}) {
  const text = String(raw || '').replace(/\r/g, '');
  const pages = text.includes(PAGE) ? text.split(PAGE) : [text];
  const repeats = repeatedLines(pages);
  const sections = [{heading: '', page: 1, blocks: []}];
  const captions = [];
  /* The reference list is kept rather than thrown away: it is not read with the body, but a reader
     who asks for it ("참고문헌까지") wants to hear who was cited. Other back matter -- funding,
     acknowledgements, competing interests -- is not kept; nobody asks to hear it. */
  const references = [];
  const skipped = {repeated: repeats.size, furniture: 0, references: 0, captions: 0};
  let inBack = false, backKind = '', started = false;

  pages.forEach((page, index) => {
    const pageNo = index + 1;
    for (const block of page.split(/\n\s*\n/)) {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      const kept = [];
      for (const line of lines) {
        if (isJunk(line, repeats, {inRefs: backKind === 'references'})) { skipped.furniture++; continue; }
        if (!started && isFrontLine(line)) { skipped.furniture++; continue; }
        kept.push(line);
      }
      if (!kept.length) continue;
      for (let i = 0; i < kept.length; i++) kept[i] = stripStamp(kept[i]);

      // A heading of its own, or the line that starts the back matter.
      if (kept.length === 1 && kept[0].length < 90) {
        if (REFERENCES.test(kept[0])) { inBack = true; backKind = 'references'; skipped.references++; continue; }
        if (BACK.test(kept[0])) { inBack = true; backKind = 'other'; continue; }
        if (HEADING.test(kept[0])) {
          inBack = false; backKind = ''; started = true;
          sections.push({heading: kept[0].replace(/^(?:\d+(?:\.\d+)*|[IVX]+)[.)]?\s+/, '').replace(/[:.]\s*$/, ''), page: pageNo, blocks: []});
          continue;
        }
      }
      if (inBack) {
        skipped.references++;
        if (backKind === 'references') {
          const entry = dehyphenate(kept.join('\n')).replace(/\s{2,}/g, ' ').trim();
          if (entry.length > 8 && /\p{L}/u.test(entry)) references.push({text: entry, page: pageNo});
        }
        continue;
      }

      // A caption often shares a block with the paragraph above it; the block is cut where it begins.
      const breaks = kept.findIndex((line, i) => i > 0 && CAPTION.test(line));
      let tail = [];
      if (breaks > 0) { tail = kept.slice(breaks); kept.length = breaks; }
      if (tail.length) {
        captions.push({text: dehyphenate(tail.join('\n')).replace(/\s{2,}/g, ' ').trim(), page: pageNo});
        skipped.captions++;
      }
      if (!kept.length) continue;

      const joined = dehyphenate(kept.join('\n')).replace(/\s{2,}/g, ' ').trim();
      if (joined.length < 3) continue;
      if (CAPTION.test(joined)) { captions.push({text: joined, page: pageNo}); skipped.captions++; continue; }
      if (joined.length <= STAMP_LENGTH * 6 && LICENCE.test(joined)) { skipped.furniture++; continue; }
      // The front matter only ever sits before the paper starts; after that an address in the
      // text is part of what is being said.
      if (!started && isFrontMatter(joined)) { skipped.furniture++; continue; }
      // The title block of the first page: the app shows the title already.
      if (pageNo === 1 && title && joined.toLowerCase().startsWith(String(title).toLowerCase().slice(0, 40))) continue;
      // Once a real paragraph has been read, the paper has begun.
      if (joined.length > 160 || /[.!?]\s/.test(joined)) started = true;
      sections[sections.length - 1].blocks.push({text: joined, page: pageNo});
    }
  });

  const out = [];
  for (const section of sections) {
    const sentences = [];
    for (const block of section.blocks) {
      for (const text of splitSentences(block.text)) {
        const spoken = spokenForm(text);
        // A "sentence" with no letters (a row of numbers from a table) is not worth saying.
        if (!/\p{L}/u.test(spoken) || spoken.replace(/\s/g, '').length < 3) continue;
        sentences.push({text, spoken, page: block.page});
      }
    }
    if (sentences.length) out.push({heading: section.heading, page: section.page, sentences});
  }
  const words = out.reduce((n, s) => n + s.sentences.reduce((m, x) => m + (x.spoken.match(/\S+/g) || []).length, 0), 0);
  return {sections: out, captions, references, skipped, stats: {pages: pages.length, sentences: out.reduce((n, s) => n + s.sentences.length, 0), words}};
}

/* One flat list to read, with the section name carried on its first sentence. */
export function units(paper, {captions = false, references = false} = {}) {
  const out = [];
  for (const section of paper.sections) {
    section.sentences.forEach((sentence, i) => {
      out.push({...sentence, section: section.heading, lead: i === 0 && section.heading ? section.heading : ''});
    });
  }
  if (captions) for (const caption of paper.captions) {
    for (const text of splitSentences(caption.text)) out.push({text, spoken: spokenForm(text), page: caption.page, section: '캡션', kind: 'caption'});
  }
  /* One entry at a time, not one sentence: "Smith J. 2020. A paper. Nature 1:2-3." is one thing a
     listener is counting off, and splitting it at the full stops would read as four. A very long
     entry is still broken, so no single utterance runs past what a voice will take. */
  if (references) for (const entry of paper.references || []) {
    for (const text of breakLong(entry.text)) out.push({text, spoken: spokenForm(text), page: entry.page, section: '참고문헌', kind: 'reference'});
  }
  return out.map((unit, index) => ({...unit, index}));
}

/* About how long the rest takes, at 200 words a minute times the rate. */
export const remainingSeconds = (list, from = 0, rate = 1) => {
  let words = 0;
  for (let i = Math.max(0, from); i < list.length; i++) words += (list[i].spoken.match(/\S+/g) || []).length;
  return Math.round(words / (200 * (rate || 1)) * 60);
};

/* ---------- a translation, read instead of the original ----------
   The Zotero plugin's reader panel saves a whole-paper translation as a child note (paper-translate
   noteHTML): a title, then for each paragraph the original in a <p> and the translation in a
   <blockquote>, under <h2> headings that carry the page. This turns that note back into the same
   shape readable() makes, so everything downstream — the player, the transcript, the sections, the
   baker — works on a translation exactly as it works on the paper.

   Only the blockquotes are read: the original is in the note so a reader can check it, not so a
   voice can say every sentence twice. */

const TAG = /<[^>]+>/g;
const ENTITY = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'"};
const plain = html => String(html || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(TAG, '')
  .replace(/&(#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') { const code = Number(name.slice(1)); return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole; }
    const known = ENTITY[name.toLowerCase()];
    return known === undefined ? whole : known;
  })
  .replace(/[ \t]+/g, ' ')
  .trim();

/* Is this note one of those? It is, when it has translations in it at all. */
export const isTranslation = html => /<blockquote[\s>]/i.test(String(html || '')) && /<h1[\s>]/i.test(String(html || ''));

/* The language the note says it is in: the "(KO)" the plugin puts after the title. */
export function noteTarget(html) {
  const head = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(String(html || ''));
  const said = head ? /\(([A-Za-z-]{2,7})\)\s*$/.exec(plain(head[1])) : null;
  return said ? said[1].toLowerCase() : '';
}

export function fromNote(html, {title = ''} = {}) {
  const source = String(html || '');
  const sections = [];
  let heading = '', page = 1;
  const open = (name, at) => { sections.push({heading: name, page: at, sentences: []}); };
  for (const m of source.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>|<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi)) {
    if (m[1] !== undefined) {
      const said = plain(m[1]);
      const where = /\(\s*p\.\s*(\d+)\s*\)\s*$/i.exec(said);
      if (where) page = Number(where[1]) || page;
      heading = said.replace(/\s*\(\s*p\.\s*\d+\s*\)\s*$/i, '').trim();
      open(heading, page);
      continue;
    }
    /* A blockquote holds the translation, and sometimes a line naming the translator after it; only
       the first paragraph of the quote is the paper. */
    const inside = [...String(m[2]).matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(x => plain(x[1])).filter(Boolean);
    const said = inside.length ? inside[0] : plain(m[2]);
    if (!said) continue;
    if (!sections.length) open(heading, page);
    for (const text of splitSentences(said)) {
      const spoken = spokenForm(text);
      if (!/\p{L}/u.test(spoken) || spoken.replace(/\s/g, '').length < 3) continue;
      sections[sections.length - 1].sentences.push({text, spoken, page});
    }
  }
  const kept = sections.filter(section => section.sentences.length);
  const words = kept.reduce((n, s) => n + s.sentences.reduce((m, x) => m + (x.spoken.match(/\S+/g) || []).length, 0), 0);
  return {
    sections: kept, captions: [], references: [],
    skipped: {repeated: 0, furniture: 0, references: 0, captions: 0},
    stats: {pages: page, sentences: kept.reduce((n, s) => n + s.sentences.length, 0), words},
    translated: true, target: noteTarget(source), title
  };
}

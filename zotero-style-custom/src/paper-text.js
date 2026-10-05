/* Clean body text from a PDF's positioned text, for reading a paper aloud.

   A PDF has no paragraphs, no columns and no sections: only runs of text at
   coordinates. Reading it back means rebuilding all of that and, above all,
   deciding what is the paper and what is the page around it. The decisions, in
   the order they are made:

     1. Items become rows by vertical overlap (a superscript shares its row with
        the word it sits on) and rows become segments wherever a gap is wider than
        a word space can be, so two columns on one baseline stay two segments.
     2. Text repeated at the same height on half the pages, page numbers and the
        strong boilerplate patterns (Downloaded from, copyright, preprint stamps)
        in the page margins are headers and footers. They are removed before the
        columns are measured, or they would bridge the gutter.
     3. Gutters are found by x-gap clustering of the long segments (one, or two
        for three columns). A segment that crosses a gutter spans it: a title or
        an abstract above two columns is read before them, in place.
     4. Lines become blocks (paragraph candidates) by vertical gap, left edge and
        a short line that closes a sentence. Rows of aligned short cells are a
        table; a short symbol-heavy line with "(3)" at the right is an equation.
     5. A state machine walks the blocks in reading order: front matter, abstract,
        body, back matter, references, supplement. Headings change the state;
        captions, footnotes, tables, equations and figure text are filed away on
        the way, and an unfinished sentence waits for its next body block, across
        columns, pages and whatever was skipped in between.
     6. Paragraphs are rebuilt character by character so every character knows the
        text item it came from: line-end hyphens are resolved, superscript
        citation numbers are left out of the text but kept in the rects, and each
        sentence can be given the boxes to highlight.

   Pure logic: no DOM, no Zotero. Coordinates are PDF user space with y measured
   from the top of the page; an item's box is [x, y, w, h] with the baseline at
   y + h (the caller converts, pageFromPdfjs does it for pdf.js). */
(function (root) {
  'use strict';

  /* ---------------------------------------------------------------- text */

  const LIGATURES = {'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st'};
  const SOFT = '­';

  /* Ligatures expand, zero-width characters go, every kind of space is a space,
     typographic hyphens are hyphens. A soft hyphen at the very end of an item is
     kept as a marker (the item broke the word there); elsewhere it is dropped.
     Greek letters, micro, plus-minus, times and degree are left as they are. */
  function normalizeText(value) {
    let s = String(value == null ? '' : value);
    s = s.replace(/[ﬀ-ﬆ]/g, c => LIGATURES[c]);
    s = s.replace(/[​-‏⁠﻿‪-‮�]/g, '');
    s = s.replace(/[   -   　\t\r\n\f\v]/g, ' ');
    s = s.replace(/[‐‑]/g, '-');
    s = s.replace(/[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/g, '');
    s = s.replace(/­(?=[\s\S])/g, '');
    return s;
  }
  const squash = s => String(s).toLowerCase().replace(/[^\p{L}]/gu, '');
  const clean = s => normalizeText(s).split(SOFT).join('').replace(/\s+/g, ' ').trim();
  const words = s => { const t = String(s).trim(); return t ? t.split(/\s+/) : []; };
  const round1 = n => Math.round(n * 10) / 10;
  const sum = a => a.reduce((x, y) => x + y, 0);
  const median = a => { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
  const percentile = (a, p) => { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.max(0, Math.round(p * (b.length - 1))))]; };
  const nsLen = s => String(s).replace(/\s/g, '').length;
  const TERMINAL = /[.!?]["”’')\]]*$/;
  const squashWords = s => String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1);
  const dice = (a, b) => {
    const A = new Set(squashWords(a)), B = new Set(squashWords(b));
    if (!A.size || !B.size) return 0;
    let n = 0; for (const w of A) if (B.has(w)) n++;
    return 2 * n / (A.size + B.size);
  };

  /* ------------------------------------------------- pdf.js adaptation */

  const mul = (a, b) => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];

  // font names say what a PostScript name says: Times-Bold, MinionPro-It, AdvTimes-b, Arial,BoldItalic
  const BOLD_NAME = /bold|black|heavy|semibold|demi|[-_,.](?:b|bd|bld|sb|sbd|bi|bdit)$|[-_,.](?:b|bd|bld|bi)(?=[-_,.+])|\.B$/i;
  const ITALIC_NAME = /italic|oblique|slanted|[-_,.](?:i|it|ita|ital|obl|bi|bdit)$|[-_,.](?:i|it|bi)(?=[-_,.+])/i;

  /* pdf.js getTextContent() + its viewport -> the page shape structure() reads.
     pdf.js hides real font names from textContent (it gives ids such as
     g_d0_f4 and a generic family), so bold and italic come from opts.fonts when
     the caller has it ({id: {name, bold, italic}}, which pdf.js exposes through
     commonObjs when the document is opened with fontExtraProperties) and are left
     undefined otherwise; structure() then infers bold from glyph widths. */
  function pageFromPdfjs(pageIndex, viewport, textContent, opts) {
    const fonts = (opts && opts.fonts) || {};
    const styles = (textContent && textContent.styles) || {};
    const scale = (viewport && viewport.scale) || 1;
    const width = (viewport && viewport.width) || 612;
    const height = (viewport && viewport.height) || 792;
    const vt = (viewport && viewport.transform) || [1, 0, 0, -1, 0, height];
    const items = [];
    for (const it of (textContent && textContent.items) || []) {
      if (!it || typeof it.str !== 'string' || !it.transform || !it.str.length) continue;
      const m = mul(vt, it.transform);
      const size = Math.hypot(m[2], m[3]);
      const horizontal = Math.abs(m[1]) <= Math.abs(m[0]) * 0.5;
      const info = fonts[it.fontName] || {};
      const style = styles[it.fontName] || {};
      const name = info.name || style.fontName || it.fontName || '';
      const named = !!(info.name || info.bold !== undefined);
      const bold = named ? !!info.bold || BOLD_NAME.test(info.name || '') : undefined;
      const italic = named ? !!info.italic || ITALIC_NAME.test(info.name || '') : undefined;
      const w = (it.width || 0) * scale;
      let x, y, bw, bh;
      if (horizontal) { x = m[4]; y = m[5] - size; bw = w; bh = size; }
      else { // rotated text: the box covers the run; it is only used to set it aside
        bw = size; bh = w;
        x = m[4] - (m[1] < 0 ? 0 : size); y = m[5] - (m[1] < 0 ? w : 0);
      }
      const item = {str: it.str, x: round1(x), y: round1(y), w: round1(bw), h: round1(bh), fontName: name, fontSize: round1(size)};
      if (bold !== undefined) item.bold = bold;
      if (italic !== undefined) item.italic = italic;
      if (style.fontFamily) item.fontFamily = style.fontFamily;
      if (!horizontal) item.dir = 'ttb'; else if (it.dir === 'rtl') item.dir = 'rtl';
      items.push(item);
    }
    return {index: pageIndex, width: round1(width), height: round1(height), items};
  }

  /* {fontName: {name, bold, italic}} for a page, read from pdf.js after the page's operator list has
     been parsed (page.getOperatorList()) and the document was opened with fontExtraProperties: true.
     Pass it to pageFromPdfjs as opts.fonts. A font that is not loaded is left out. */
  function fontsOf(commonObjs, textContent) {
    const out = {};
    for (const id of Object.keys((textContent && textContent.styles) || {})) {
      try {
        const f = commonObjs.get(id);
        if (f && f.name) out[id] = {name: f.name, bold: !!(f.bold || f.black), italic: !!f.italic};
      } catch (e) { /* not resolved yet */ }
    }
    return out;
  }

  /* ------------------------------------------------------ line building */

  const GAP_SPACE = 0.14;     // a gap wider than this many em is a space
  const GAP_SEGMENT = 1.0;    // wider than this many em starts a new segment (gutter, tab, cell)
  const GAP_SEGMENT_MIN = 8.5;  // ... and never less than this many points (a 6pt reference list keeps its marker)

  const UNIT_BEFORE_EXPONENT = /^(?:m|cm|mm|nm|km|µm|μm|Å|R|r|Q)$/;

  /* A superscript that is a citation number or a footnote symbol, as opposed to
     an exponent or an ion charge. Numbers and ranges only; a minus sign or plus
     is a real exponent or charge and stays ("s-1", "Mg2+"), a digit glued to a
     digit is a power ("10 6"), and a single digit after a length unit is an
     area or volume ("cm2"). `tail` is the text already written before it. */
  function isCiteSup(part, tail) {
    const s = part.str.trim();
    if (!s) return false;
    if (/^[*†‡§¶#]+$/.test(s)) return !!tail;
    if (!/^[\d,\s–\-*†‡§]+$/.test(s) || !/\d/.test(s)) return false;
    if (!tail) return false;
    if (/\d$/.test(tail) || /\s$/.test(tail) || /[\u207A\u207B\u2212\u00B9\u00B2\u00B3\u2070-\u2079-]$/.test(tail)) return false;
    const w = /([A-Za-zµÅμ]+)$/.exec(tail);
    if (w && /^\d$/.test(s) && UNIT_BEFORE_EXPONENT.test(w[1])) return false;
    return true;
  }

  const SUPER = {'0': '\u2070', '1': '\u00B9', '2': '\u00B2', '3': '\u00B3', '4': '\u2074', '5': '\u2075', '6': '\u2076', '7': '\u2077', '8': '\u2078', '9': '\u2079', '+': '\u207A', '-': '\u207B', '\u2212': '\u207B'};

  function dominantSize(parts) {
    const weight = new Map();
    for (const p of parts) {
      const k = Math.round(p.size * 4) / 4;
      weight.set(k, (weight.get(k) || 0) + Math.max(1, nsLen(p.str)));
    }
    let best = 0, bw = -1;
    for (const [k, w] of weight) if (w > bw || (w === bw && k > best)) { best = k; bw = w; }
    return best;
  }

  /* Concatenate parts into text. Gaps decide spaces, but a stripped citation
     number is invisible: the gap that counts is the one after it. Returns the
     text, one token per character (which part and which character of it, for
     the rects) and where citation numbers were left out. */
  function joinParts(parts, stripSup) {
    const toks = [], marks = [];
    let text = '';
    let lastEnd = null, lastStr = '', lastSize = 0, lastSpace = false, any = false, supSpace = false;
    const push = (ch, part, ci) => { text += ch; toks.push({ch, part, ci}); };
    const lastPart = parts[parts.length - 1];
    // adjacent raised items are one superscript: "2" then "+" is a charge, not citation 2 and a plus
    const supRun = new Map();
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i].sup || supRun.has(parts[i])) continue;
      const run = [parts[i]];
      for (let j = i + 1; j < parts.length && parts[j].sup && parts[j].x - (run[run.length - 1].x + run[run.length - 1].w) < 0.5 * parts[j].size; j++) run.push(parts[j]);
      const str = run.map(q => q.str).join('');
      for (const q of run) supRun.set(q, {str, first: run[0], decided: null});
    }
    for (const p of parts) {
      const s = p.str;
      if (!s) continue;
      const runInfo = p.sup ? supRun.get(p) : null;
      if (runInfo && runInfo.first === p) runInfo.decided = isCiteSup({str: runInfo.str}, text);
      if (stripSup !== false && p.sup && (runInfo ? runInfo.decided : isCiteSup(p, text))) {
        marks.push({pos: toks.length, part: p});
        lastEnd = p.x + p.w;
        if (/\s$/.test(s) || p.spaceAfter) supSpace = true;
        continue;
      }
      if (any && lastEnd != null) {
        const em = Math.max(p.size, lastSize) || 10;
        const gap = p.x - lastEnd;
        if (supSpace || lastSpace || /\s$/.test(lastStr) || /^\s/.test(s) || gap > em * GAP_SPACE) {
          if (text.length && text[text.length - 1] !== ' ') push(' ', p, -1);
        }
      }
      // an exponent or ion charge that stays in the text is written as superscript characters, so a speech
      // engine does not run it into the number before it ("10" + "6" must not read as 106)
      const asSup = stripSup !== false && p.sup && any && /^[\d+\-\u2212]+$/.test(s.trim());
      for (let ci = 0; ci < s.length; ci++) {
        const ch = asSup && SUPER[s[ci]] ? SUPER[s[ci]] : s[ci];
        if (ch === ' ') { if (text.length && text[text.length - 1] !== ' ') push(' ', p, ci); }
        else if (ch === SOFT && !(p === lastPart && ci === s.length - 1)) continue;
        else push(ch, p, ci);
      }
      lastEnd = p.x + p.w; lastStr = s; lastSize = p.size; lastSpace = !!p.spaceAfter; supSpace = false; any = true;
    }
    while (text.endsWith(' ')) { text = text.slice(0, -1); toks.pop(); }
    return {text, toks, marks};
  }

  /* Rows: items whose vertical extents overlap. Sorted by centre, an item joins
     the open row when its centre falls inside the row's largest item (a
     superscript or subscript always does) or that item's centre falls inside it. */
  function clusterRows(items) {
    const arr = items.slice().sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2) || a.x - b.x);
    const rows = [];
    let cur = null;
    for (const p of arr) {
      const c = p.y + p.h / 2;
      if (cur) {
        const core = cur.core;
        const cc = core.y + core.h / 2;
        if ((c >= core.y - 0.1 * core.h && c <= core.y + core.h * 1.1) || (cc >= p.y && cc <= p.y + p.h)) {
          cur.items.push(p);
          if (p.size > core.size) cur.core = p;
          continue;
        }
      }
      cur = {items: [p], core: p};
      rows.push(cur);
    }
    return rows.flatMap(splitStacked);
  }

  /* A large item (an 18pt title line) can reach over two lines of the column beside it, and
     the overlap rule would make them one row. Two items of like size that stand over each
     other on different baselines are never one row: the row is cut by baseline, and the
     items of another size (superscripts, the title) go to the line beside them. */
  function splitStacked(row) {
    const its = row.items;
    if (its.length < 3) return [row];
    const stacked = (a, b) => Math.max(a.size, b.size) < 1.25 * Math.min(a.size, b.size) && nsLen(a.str) >= 2 && nsLen(b.str) >= 2
      && Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0 && Math.abs(a.baseline - b.baseline) > 0.5 * Math.min(a.size, b.size);
    // a sweep along x: only items that overlap horizontally are compared
    const byX = its.slice().sort((a, b) => a.x - b.x);
    let conflict = false;
    for (let i = 0; i < byX.length && !conflict; i++) for (let j = i + 1; j < byX.length && byX[j].x < byX[i].x + byX[i].w; j++) if (stacked(byX[i], byX[j])) { conflict = true; break; }
    if (!conflict) return [row];
    const norm = dominantSize(its);
    const anchors = its.filter(p => Math.abs(p.size - norm) <= 0.15 * norm).sort((a, b) => a.baseline - b.baseline);
    const groups = [];
    for (const p of anchors) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(p.baseline - g.baseline) <= 0.3 * p.size) g.items.push(p); else groups.push({items: [p], baseline: p.baseline});
    }
    if (groups.length < 2) return [row];
    for (const p of its) {
      if (anchors.includes(p)) continue;
      const c = p.y + p.h / 2;
      const near = groups.filter(g => g.items.some(q => Math.max(q.x - (p.x + p.w), p.x - (q.x + q.w)) < 2 * Math.max(p.size, q.size)));
      const pool = near.length ? near : groups;
      let best = pool[0], bd = Infinity;
      for (const g of pool) { const d = Math.abs(g.baseline - (p.size < norm ? p.baseline : c)); if (d < bd) { bd = d; best = g; } }
      best.items.push(p);
    }
    return groups.map(g => ({items: g.items, core: g.items.reduce((a, b) => (b.size > a.size ? b : a))}));
  }

  function makeSegment(parts) {
    parts.sort((a, b) => a.x - b.x);
    const dom = dominantSize(parts);
    const big = parts.filter(p => p.size >= dom * 0.92 && p.size <= dom * 1.08 + 0.3);
    const core = big.length ? big : parts;
    const base = median(core.map(p => p.baseline));
    for (const p of parts) {
      p.sup = false; p.sub = false;
      if (big.length && p.size <= dom * 0.86) {
        if (p.baseline <= base - dom * 0.12) p.sup = true;
        else if (p.baseline >= base + dom * 0.1) p.sub = true;
      }
    }
    let chars = 0, allChars = 0, boldChars = 0, italicChars = 0;
    for (const p of core) chars += nsLen(p.str);
    for (const p of parts) { const n = nsLen(p.str); allChars += n; if (p.bold) boldChars += n; if (p.italic) italicChars += n; }
    const seg = {
      parts, size: dom, baseline: base,
      x0: Math.min(...parts.map(p => p.x)), x1: Math.max(...parts.map(p => p.x + p.w)),
      top: Math.min(...core.map(p => p.y)), bottom: Math.max(...core.map(p => p.y + p.h)),
      boldFrac: allChars ? boldChars / allChars : 0, bold: allChars > 0 && boldChars / allChars >= 0.9, italic: allChars > 0 && italicChars / allChars >= 0.6,
      chars, page: parts[0].page, skip: null,
    };
    seg.plain = joinParts(parts, true).text;
    seg.startsSup = !!parts[0].sup;
    return seg;
  }

  function segmentsOf(allParts) {
    const segs = [];
    // a drop cap is much larger than the page's type and only a letter or two; it must not
    // pull the lines beside it into one row
    const mode = dominantSize(allParts);
    const caps = allParts.filter(p => mode && p.size >= 1.6 * mode && nsLen(p.str) <= 3
      && !allParts.some(q => q !== p && Math.abs(q.size - p.size) < 0.2 * p.size && Math.abs(q.baseline - p.baseline) < 0.5 * p.size));
    const parts = caps.length ? allParts.filter(p => !caps.includes(p)) : allParts;
    for (const p of caps) segs.push(makeSegment([p]));
    if (!parts.length) return segs;
    for (const row of clusterRows(parts)) {
      let items = row.items.slice().sort((a, b) => a.x - b.x);
      // text laid over other text (a draft layer, a stamp): items that overlap along the row
      // belong to two layers; the layer with less text is dropped from this row
      if (items.length > 1) {
        const layers = [];
        for (const it of items) {
          let placed = false;
          for (const L of layers) {
            const last = L.items[L.items.length - 1];
            if (it.x >= L.end - 0.3 * Math.min(it.w, last.w, 6 * it.size)) { L.items.push(it); L.end = Math.max(L.end, it.x + it.w); placed = true; break; }
          }
          if (!placed) layers.push({items: [it], end: it.x + it.w});
        }
        if (layers.length > 1) {
          const weight = L => sum(L.items.map(q => nsLen(q.str)));
          const main = layers.reduce((x, y) => (weight(y) > weight(x) ? y : x));
          const stray = sum(layers.filter(L => L !== main).map(weight));
          // a few characters laid across a row are an accent or a stamp; a second layer is long
          if (stray >= 6 && stray >= 0.15 * weight(main)) items = main.items;
          else if (stray < 6) items = layers.flatMap(L => L.items).sort((q, r) => q.x - r.x);
          else items = main.items;
        }
      }
      let cur = [items[0]], end = items[0].x + items[0].w;
      for (let i = 1; i < items.length; i++) {
        const p = items[i];
        const em = Math.max(p.size, cur[cur.length - 1].size) || 10;
        if (p.x - end > Math.max(em * GAP_SEGMENT, GAP_SEGMENT_MIN)) { segs.push(makeSegment(cur)); cur = [p]; end = p.x + p.w; }
        else { cur.push(p); end = Math.max(end, p.x + p.w); }
      }
      segs.push(makeSegment(cur));
    }
    return segs;
  }

  /* List bullets drawn as a letter from a symbol font (Cell's "d" before each item of a list): a font
     named as a symbol or pi font, or one that only ever draws single letters in another family than the
     text beside it. Its single glyphs are not text. */
  const SYMBOL_FONT = /(?:^|[+_-])(?:[A-Za-z]*Pi\d*|[A-Za-z]*Symbol[A-Za-z]*|[A-Za-z]*Dingbat[A-Za-z]*|Wingdings\d*|ZapfDingbats|MT-?Extra)$/i;
  function dropBullets(pages) {
    const stat = new Map();
    for (const pg of pages) for (const p of pg.parts) {
      let f = stat.get(p.font);
      if (!f) { f = {single: 0, longer: 0, family: p.family, letters: new Set()}; stat.set(p.font, f); }
      if (nsLen(p.str) <= 1) { f.single++; if (/[A-Za-z]/.test(p.str)) f.letters.add(p.str.trim()); } else f.longer++;
    }
    const famW = new Map();
    for (const pg of pages) for (const p of pg.parts) famW.set(p.family, (famW.get(p.family) || 0) + nsLen(p.str));
    const mainFam = [...famW.entries()].sort((a, b) => b[1] - a[1])[0];
    const bullet = new Set();
    for (const [font, f] of stat) {
      if (SYMBOL_FONT.test(fontKey(font).replace(/[-,](?:Regular|Roman)$/i, ''))) bullet.add(font);
      else if (f.single >= 3 && f.longer === 0 && ((mainFam && f.family && f.family !== mainFam[0]) || (f.letters.size <= 2 && f.single >= 6))) bullet.add(font);
    }
    if (!bullet.size) return;
    for (const pg of pages) pg.parts = pg.parts.filter(p => !(bullet.has(p.font) && /^\s*[a-zA-Z]\s*$/.test(p.str)));
  }

  /* A document that carries its text twice, in two typefaces (a stale, reflowed text layer under
     the final one, a few points off or on the next page): when at least three long runs appear
     verbatim in two fonts at different places, the fonts fall into two layers and the layer with
     less text in the document goes, with the other styles of its typeface. */
  function dropStaleLayer(pages, skipped) {
    const long = new Map();
    for (const pg of pages) for (const p of pg.parts) if (p.str.trim().length >= 40) { const k = p.str.trim(); if (!long.has(k)) long.set(k, []); long.get(k).push(p); }
    const edges = [];
    for (const ps of long.values()) {
      if (ps.length !== 2 || ps[0].font === ps[1].font) continue;
      if (ps[0].page === ps[1].page && Math.abs(ps[0].x - ps[1].x) < 0.5 && Math.abs(ps[0].y - ps[1].y) < 0.5) continue;
      if (ps[0].str.trim().length < 60) continue;
      edges.push([ps[0].font, ps[1].font, ps[0].str.trim().length]);
    }
    if (edges.length < 3) return;
    const face = f => fontKey(f).split(/[-,]/)[0];
    const real = edges.every(([a, b]) => realFontName(a) && realFontName(b));
    const flat = edges.map(([a, b]) => [a, b]);
    // with real names the two layers are two typefaces; without them, each set of linked fonts on its own
    const side = new Map();
    let comp = 0;
    for (const [a0] of edges) {
      if (side.has(a0)) continue;
      side.set(a0, {c: comp, k: 0});
      for (let changed = true; changed;) {
        changed = false;
        for (const [a, b] of edges) {
          if (side.has(a) && !side.has(b)) { side.set(b, {c: side.get(a).c, k: 1 - side.get(a).k}); changed = true; }
          else if (side.has(b) && !side.has(a)) { side.set(a, {c: side.get(b).c, k: 1 - side.get(b).k}); changed = true; }
        }
      }
      comp++;
    }
    if (edges.some(([a, b]) => side.get(a).k === side.get(b).k)) return;
    const weight = new Map();
    const keyOfPart = p => {
      if (real) { const fa = face(p.font); const e = edges.find(([a, b]) => face(a) === fa || face(b) === fa); return e ? fa : null; }
      const sd = side.get(p.font); return sd ? sd.c + ':' + sd.k : null;
    };
    for (const pg of pages) for (const p of pg.parts) { const k = keyOfPart(p); if (k) weight.set(k, (weight.get(k) || 0) + nsLen(p.str)); }
    const dropKeys = new Set();
    if (real) {
      const faces = [...new Set(flat.flat().map(face))];
      if (faces.length !== 2) return;
      dropKeys.add((weight.get(faces[0]) || 0) < (weight.get(faces[1]) || 0) ? faces[0] : faces[1]);
    } else for (let c = 0; c < comp; c++) dropKeys.add((weight.get(c + ':0') || 0) < (weight.get(c + ':1') || 0) ? c + ':0' : c + ':1');
    const sideOf = p => (dropKeys.has(keyOfPart(p)) ? 1 : 0);
    // the layer to drop must be largely a copy: headings repeated in a contents list are not a layer
    let dropped = 0;
    for (const [k, w] of weight) if (dropKeys.has(k)) dropped += w;
    if (sum(edges.map(e => e[2])) < 0.05 * dropped) return;
    const drop = 1;
    for (const pg of pages) {
      const gone = pg.parts.filter(p => sideOf(p) === drop);
      if (!gone.length) continue;
      pg.parts = pg.parts.filter(p => sideOf(p) !== drop);
      skipped.other.push({text: gone.map(p => p.str).join(' ').replace(/\s+/g, ' ').slice(0, 300), page: pg.index, reason: 'a second, stale text layer in another typeface'});
    }
  }

  /* A run that starts with a subscript or superscript can carry that small size for the rest of the
     line ("t" + "2 was the isocitrate lyase ..." set at 5.3pt in an 8pt paragraph). Its glyphs are as wide
     as the paragraph's, so the width per character, against what the same font gives elsewhere, says
     the real size. Only ever made larger, and only for runs long enough to measure. */
  function fixRunSizes(pages) {
    const per = new Map(), all = [];
    for (const pg of pages) for (const p of pg.parts) {
      if (p.str.length < 10 || !(p.w > 0)) continue;
      const r = p.w / (p.str.length * p.size);
      if (!per.has(p.font)) per.set(p.font, []);
      per.get(p.font).push(r); all.push(r);
    }
    const R0 = median(all);
    // only runs set well below the paper's running size: the subscript's size carried on
    const sizes = [];
    for (const pg of pages) for (const p of pg.parts) if (p.str.length >= 10) sizes.push(p.size);
    const runSize = median(sizes);
    const norm = new Map();
    for (const [f, rs] of per) norm.set(f, rs.length >= 8 ? median(rs) : R0);
    for (const pg of pages) for (const p of pg.parts) {
      if (p.str.length < 12 || !(p.w > 0) || p.size > 0.85 * runSize) continue;
      // capitals and letter-spaced headings are wide by nature; only running text is measured
      const low = (p.str.match(/\p{Ll}/gu) || []).length;
      if (low < 0.6 * nsLen(p.str) || / \S /.test(p.str.trim().slice(0, 12))) continue;
      const R = norm.get(p.font) || R0;
      if (!R || p.w / (p.str.length * p.size) < 1.35 * R) continue;
      const size = Math.round(10 * p.w / (p.str.length * R)) / 10;
      p.size = size; p.y = p.baseline - size; p.h = size;
    }
  }

  /* Bold from glyph widths when the caller could not name the fonts: a bold cut
     of the body face is wider per character than its regular. */
  function inferBold(pages) {
    const stat = new Map();
    for (const pg of pages) for (const p of pg.parts) {
      let f = stat.get(p.font);
      if (!f) { f = {chars: 0, width: 0, known: false, family: p.family}; stat.set(p.font, f); }
      if (p.bold !== undefined) f.known = true;
      const s = p.str.replace(/\s/g, '');
      if (s.length >= 6 && p.w > 0 && /^[A-Za-z]+$/.test(s)) { f.chars += s.length; f.width += (p.w / (p.size || 1)); }
    }
    const ratio = f => (f.chars ? f.width / f.chars : 0);
    const dominant = new Map();
    for (const f of stat.values()) {
      const d = dominant.get(f.family || '');
      if (!d || f.chars > d.chars) dominant.set(f.family || '', f);
    }
    const bold = new Map();
    for (const [name, f] of stat) {
      if (f.known || f.chars < 20) continue;
      const d = dominant.get(f.family || '');
      bold.set(name, !!(d && d !== f && ratio(d) > 0 && ratio(f) >= ratio(d) * 1.07));
    }
    for (const pg of pages) for (const p of pg.parts) if (p.bold === undefined) { p.bold = bold.get(p.font) || false; p.boldGuess = true; }
  }

  /* ---------------------------------------- headers, footers, numbers */

  const PAGE_NUMBER = /^\s*[-–—]?\s*(?:page\s+)?(?:\d{1,4}|[ivxlc]{1,6})(?:\s*(?:of|\/)\s*\d{1,4})?\s*[-–—]?\s*$/i;
  const MARGIN_PATTERNS = [
    /^downloaded from\b/i, /downloaded from\s+(?:https?:|www\.)/i, /\bguest\s*\(guest\)/i,
    /©|\(c\)\s*\d{4}|\bcopyright\b|all rights reserved|creative commons|\bcc[- ]by\b|licen[sc]ed under|this is an open access|open access article/i,
    /\b(?:biorxiv|medrxiv|chemrxiv|arxiv|ssrn)\b.*(?:preprint|doi|posted|copyright)|this version posted|the copyright holder|preprint \(which was not certified/i,
    /\bplease cite this article\b/i, /^\s*(?:https?:\/\/)?(?:dx\.)?doi\.org\/\S+\s*$/i, /^\s*doi:\s*\S+\s*$/i,
    /^\s*page\s+\d+\s*(?:of\s+\d+)?\s*$/i, /\b\d+\s+of\s+\d+\s*$/,
    /\|\s*www\.[a-z.]+\.com|www\.nature\.com|www\.cell\.com|www\.pnas\.org|www\.sciencemag\.org|www\.annualreviews\.org|journals\.plos\.org/i,
    /^\s*(?:research article|article|review|letter|report|perspective|resource|short report|original article|original research|brief communication|analysis|minireview|mini-review|survey and summary|open access|research|special issue|communication)\s*$/i,
    /^\s*(?:check for updates|crossmark|click for updates)\s*$/i,
    /\be-?mail:\s*\S+@\S+/i,
  ];
  const keyOf = s => String(s).toLowerCase().replace(/[^\p{L}]/gu, '');
  const STAMP = /^\s*(?:check for updates|crossmark|click for updates|view article online|view journal(?: \| view issue)?)\s*$/i;
  // a journal's own line: name, volume, pages and a date or year ("Cell Host & Microbe 30, 1556–1569, November 9, 2022")
  const JOURNAL_LINE = /^\s*(?:\d{1,5}\s+)?\p{Lu}[\p{L}&.\s]{2,60}\s\d{1,4}\s*[,:(]\s*(?:\d{1,4}\)\s*[,:]?\s*)?[e]?\d{1,6}\s*[\u2013-]\s*[e]?\d{1,6}.{0,40}\b(?:19|20)\d{2}\b.{0,40}$|[\u00AA\u00A9]\s*(?:19|20)\d{2}\s+\p{Lu}/u;

  function detectMargins(pages, skipped, meta) {
    const n = pages.length;
    const zones = new Map();    // letters-only key -> segments in a margin
    const doi = meta && meta.doi ? keyOf(meta.doi) : '';
    for (const pg of pages) {
      const H = pg.height;
      for (const seg of pg.segs) {
        const top = seg.top < H * 0.095, bottom = seg.top > H * 0.88;
        seg.zone = top ? 'top' : bottom ? 'bottom' : null;
        if (!seg.zone) continue;
        const text = seg.plain.trim();
        if (PAGE_NUMBER.test(text) && text.length <= 14) { seg.skip = 'pageNumber'; continue; }
        const k = keyOf(text);
        if (!k || text.length > 200) continue;
        if (!zones.has(k)) zones.set(k, []);
        zones.get(k).push(seg);
      }
    }
    // half the pages is the rule; a long enough line on a quarter of them also counts, since
    // supplementary and reporting pages often come without the running head
    const need = Math.max(2, Math.ceil(n * 0.5)), needLong = Math.max(3, Math.ceil(n * 0.25));
    for (const [k, segs] of zones) {
      const pageSet = new Set(segs.map(s => s.page));
      if (pageSet.size >= need || (k.length >= 8 && pageSet.size >= needLong)) for (const s of segs) if (!s.skip) s.skip = s.zone === 'top' ? 'header' : 'footer';
    }
    // a footer seen once with more on it than the repeated one ("1556 Cell Host & Microbe 30, 1556-1569, November 9,
    // 2022 ª 2022 Elsevier Inc." on the first text page) still carries the repeated text
    const repeated = [...zones.entries()].filter(([k, sg]) => k.length >= 12 && sg.some(x => x.skip === 'header' || x.skip === 'footer')).map(([k]) => k);
    for (const pg of pages) for (const seg of pg.segs) {
      if (seg.skip || !seg.zone) continue;
      const text = seg.plain.trim();
      const k = keyOf(text);
      if (MARGIN_PATTERNS.some(re => re.test(text)) || (doi && k.includes(doi)) || repeated.some(r => k.includes(r)) || JOURNAL_LINE.test(text)) seg.skip = seg.zone === 'top' ? 'header' : 'footer';
    }
    // a stamp is a stamp wherever it stands (the crossmark label beside the abstract)
    for (const pg of pages) for (const seg of pg.segs) if (!seg.skip && STAMP.test(seg.plain)) { seg.skip = 'stamp'; skipped.other.push({text: seg.plain, page: pg.index, reason: 'stamp'}); }
    // line numbers down the margin (preprints, review copies): a column of bare numbers. A page
    // with few lines (a figure legend page) joins in when the paper shows the column elsewhere.
    const numberEdges = new Set();
    const numberCols = pg => {
      const nums = pg.segs.filter(sg => !sg.skip && /^\d{1,4}$/.test(sg.plain.trim()));
      const text = pg.segs.filter(sg => !sg.skip && sg.plain.length >= 20);
      const found = [];
      for (const edge of ['x0', 'x1']) {
        const groups = new Map();
        for (const sg of nums) { const k = Math.round(sg[edge] / 8); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(sg); }
        for (const [k, g] of groups) {
          const xr = Math.max(...g.map(sg => sg.x1));
          const leftOfText = text.filter(sg => sg.x0 >= xr - 1).length >= g.length * 0.5;
          const rightOfText = text.filter(sg => sg.x1 <= Math.min(...g.map(sg => sg.x0)) + 1).length >= g.length * 0.5;
          if (leftOfText || rightOfText) found.push({edge, k, g});
        }
      }
      return found;
    };
    for (const pg of pages) for (const f of numberCols(pg)) if (f.g.length >= 6) { numberEdges.add(f.edge + f.k); for (const sg of f.g) sg.skip = 'lineNumber'; }
    if (numberEdges.size) for (const pg of pages) for (const f of numberCols(pg)) if (f.g.length >= 2 && numberEdges.has(f.edge + f.k)) for (const sg of f.g) sg.skip = 'lineNumber';
    // notes in the margin beside the text (a glossary box, a sidebar): entirely outside the body block
    for (const pg of pages) {
      const live = pg.segs.filter(sg => !sg.skip);
      const body = live.filter(sg => sg.x1 - sg.x0 >= 0.3 * pg.width && sg.plain.length >= 30);
      if (body.length < 6) continue;
      const left = percentile(body.map(sg => sg.x0), 0.1), right = percentile(body.map(sg => sg.x1), 0.9);
      const side = live.filter(sg => sg.plain.length >= 6 && /\p{L}{3}/u.test(sg.plain) && (sg.x1 <= left - 4 || sg.x0 >= right + 4) && sg.x1 - sg.x0 < 0.3 * pg.width);
      if (side.length >= 2) for (const sg of side) sg.skip = 'margin';
    }
    for (const pg of pages) for (const seg of pg.segs) {
      if (!seg.skip) continue;
      if (seg.skip === 'duplicate' || seg.skip === 'stamp') continue;
      const kind = seg.skip === 'header' ? 'headers' : seg.skip === 'footer' ? 'footers' : (seg.skip === 'lineNumber' || seg.skip === 'margin') ? 'other' : 'pageNumbers';
      skipped[kind].push({text: seg.plain, page: pg.index, y: round1(seg.top), reason: seg.skip === 'pageNumber' ? 'page number' : seg.skip === 'lineNumber' ? 'line number in the margin' : seg.skip === 'margin' ? 'note in the margin beside the text' : 'repeated or boilerplate in the page margin'});
    }
  }

  /* Some PDFs carry the same text twice, one layer over the other, a few points apart
     (a draft layer under the final one). Of two segments that sit on the same baseline and
     overlap along it, the shorter is the overlay. */
  function dropOverlays(pg, skipped) {
    const segs = pg.segs.filter(sg => !sg.skip).sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
    let dropped = 0;
    for (let i = 0; i < segs.length; i++) {
      const a = segs[i];
      if (a.skip) continue;
      for (let j = i + 1; j < segs.length; j++) {
        const b = segs[j];
        if (b.baseline - a.baseline > 0.35 * Math.min(a.size, b.size)) break;
        if (b.skip) continue;
        const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        if (overlap >= 0.5 * Math.min(a.x1 - a.x0, b.x1 - b.x0) && overlap > 4 * Math.min(a.size, b.size)) {
          const loser = a.chars < b.chars ? a : b;
          loser.skip = 'duplicate';
          dropped++;
          if (loser === a) break;
        }
      }
    }
    return dropped;
  }

  /* Table rows line their cells up: at least two left edges recur, within a few points,
     in most of the rows. Figure labels and axis ticks scatter. */
  function aligned(rows) {
    if (rows.length < 2) return false;
    const edges = [];
    for (const r of rows) for (const c of r.cells) edges.push({x: c.x0, row: rows.indexOf(r)});
    const clusters = [];
    for (const e of edges.sort((a, b) => a.x - b.x)) {
      const last = clusters[clusters.length - 1];
      if (last && e.x - last.x1 <= 5) { last.rows.add(e.row); last.x1 = e.x; } else clusters.push({x1: e.x, rows: new Set([e.row])});
    }
    return clusters.filter(c => c.rows.size >= Math.max(2, Math.ceil(0.6 * rows.length))).length >= 2;
  }

  /* Tables set across the page (the cells run over the gutter) would be torn into
     the columns, so rows of four or more short cells are taken out before the
     columns are measured, when at least three of them follow each other. */
  function detectWideTables(pg, skipped) {
    const live = pg.segs.filter(sg => !sg.skip);
    if (live.length < 8) return;
    const rows = lineify(live, pg.index, -1, 0, '');
    const isRow = r => r.cells.length >= 4 && sum(r.cells.map(c => c.plain.length)) / r.cells.length <= 26;
    let i = 0;
    while (i < rows.length) {
      if (!isRow(rows[i])) { i++; continue; }
      let j = i, last = i, count = 0;
      while (j < rows.length) {
        const r = rows[j];
        const before = rows[Math.max(i, j - 1)];
        const near = r.baseline - before.baseline <= 3.2 * Math.max(r.size, before.size);
        if (!near) break;
        if (isRow(r)) { last = j; count++; }
        else if (r.chars > 80) break;       // a wrapped cell line is short; a paragraph line is not
        j++;
      }
      const labelled = rows.slice(i, last + 1).filter(r => isRow(r) && /\p{L}{3}/u.test(r.cells[0].plain)).length;
      if (count >= 3 && labelled >= 0.6 * count && aligned(rows.slice(i, last + 1).filter(isRow))) {
        const run = rows.slice(i, last + 1);
        // the header line above, when there is one
        const above = rows[i - 1];
        if (above && above.cells.length >= 2 && i - 1 >= 0 && rows[i].baseline - above.baseline <= 3.2 * rows[i].size && above.chars <= 80 && !skipped.__never) run.unshift(above);
        for (const r of run) for (const c of r.cells) c.skip = 'table';
        skipped.tables.push({text: run.map(r => r.cells.map(c => c.plain).join(' | ')).join('\n'), page: pg.index, reason: 'rows of short cells across the page'});
      }
      i = Math.max(last + 1, i + 1);
    }
  }

  /* --------------------------------------------------------- columns */

  /* Gutters by x-gap clustering. A candidate position is a gutter when enough
     rows have a long segment ending before it and another starting after it
     (paired rows), and the segments that cross it do not cut through the run of
     paired rows. The crossing ones are what spans the gutter: a title or an
     abstract over two columns, or a figure caption in the middle of them. */
  function findGutters(segs, W, lo, hi, out, depth, minPaired) {
    const need = minPaired || 5;
    const minLong = Math.max(0.17 * W, 60);
    const long = segs.filter(s => s.x1 - s.x0 >= minLong && s.plain.length >= 20);
    if (long.length < (need >= 5 ? 8 : 6)) return;
    let best = null;
    const xs0 = Math.ceil(lo + 0.12 * W), xs1 = Math.floor(hi - 0.12 * W);
    for (let x = xs0; x <= xs1; x++) {
      const left = long.filter(s => s.x1 <= x), right = long.filter(s => s.x0 >= x);
      if (left.length < 4 || right.length < 4) continue;
      const rt = right.map(s => s.baseline).sort((a, b) => a - b);
      const paired = [];
      for (const s of left) { if (rt.some(t => Math.abs(t - s.baseline) <= 0.5 * s.size)) paired.push(s.baseline); }
      if (paired.length < need) continue;
      const pTop = Math.min(...paired) - 4, pBottom = Math.max(...paired) + 4;
      let C = 0, inside = 0;
      for (const s of segs) if (s.x0 < x - 1 && s.x1 > x + 1) { C++; if (s.baseline >= pTop && s.baseline <= pBottom) inside++; }
      if (inside > 0.5 * paired.length) continue;
      if (!best || inside < best.inside || (inside === best.inside && paired.length > best.P)) best = {inside, C, P: paired.length, from: x, to: x};
      else if (inside === best.inside && paired.length === best.P && best.to === x - 1) best.to = x;
    }
    if (!best || best.to - best.from < 4) return;
    const g = (best.from + best.to) / 2;
    out.push(g);
    if (depth < 1) {
      findGutters(segs.filter(s => s.x1 <= g), W, lo, g, out, depth + 1, minPaired);
      findGutters(segs.filter(s => s.x0 >= g), W, g, hi, out, depth + 1, minPaired);
    }
  }

  const LINE_BASE_TOL = 0.4;

  function lineify(segs, page, col, zone, group) {
    const sorted = segs.slice().sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
    const rows = [];
    for (const s of sorted) {
      const cur = rows[rows.length - 1];
      if (cur && Math.abs(s.baseline - cur.baseline) <= LINE_BASE_TOL * Math.min(s.size, cur.size)) {
        cur.segs.push(s);
        cur.size = Math.max(cur.size, s.size);
        cur.baseline = (cur.baseline * (cur.segs.length - 1) + s.baseline) / cur.segs.length;
      } else rows.push({segs: [s], baseline: s.baseline, size: s.size});
    }
    return rows.map(r => {
      let cells = r.segs.sort((a, b) => a.x0 - b.x0);
      // a list marker ("12." or "[12]") belongs to the text after it, not a cell of its own
      if (cells.length >= 2 && MARKER_CELL.test(cells[0].plain.trim()) && cells[1].x0 - cells[0].x1 < 3 * cells[0].size) {
        cells = [makeSegment(cells[0].parts.concat(cells[1].parts)), ...cells.slice(2)];
      }
      const widest = cells.reduce((a, b) => ((b.x1 - b.x0) > (a.x1 - a.x0) ? b : a));
      const text = cells.map(c => c.plain).join(' ').replace(/\s+/g, ' ').trim().replace(/(?:^|(?<=\s))((?:\p{Lu} ){3,}\p{Lu})(?=\s|\d|$)/gu, m => m.replace(/ /g, ''));
      const chars = sum(cells.map(c => c.chars));
      return {
        cells, text, page, col, zone, group,
        x0: Math.min(...cells.map(c => c.x0)), x1: Math.max(...cells.map(c => c.x1)),
        top: Math.min(...cells.map(c => c.top)), bottom: Math.max(...cells.map(c => c.bottom)),
        baseline: r.baseline, size: widest.size,
        bold: chars > 0 && sum(cells.map(c => c.boldFrac * c.chars)) / chars >= 0.9,
        italic: chars > 0 && sum(cells.filter(c => c.italic).map(c => c.chars)) / chars >= 0.7,
        chars, parts: [].concat(...cells.map(c => c.parts)),
        startsSup: cells[0].startsSup,
      };
    });
  }

  /* Where a gutter holds. A long line that crosses it cuts the page there; a piece
     between two cuts carries the gutter when long lines stand on both sides of it at
     the same height (paired). A gutter is therefore not the page's but a stretch's:
     a figure with a narrow column beside it, then two columns of another width below,
     is three stretches with two gutters. lo..hi clips the pieces to a range of the page. */
  const isLongSeg = (s, W) => s.x1 - s.x0 >= Math.max(0.17 * W, 60) && s.plain.length >= 15;
  const crossesAt = (s, g) => s.x0 < g - 1 && s.x1 > g + 1;
  function gutterPieces(segs, g, W, lo, hi) {
    const long = segs.filter(s => isLongSeg(s, W) && s.baseline >= lo && s.baseline <= hi);
    const cuts = long.filter(s => crossesAt(s, g)).map(s => s.baseline).sort((a, b) => a - b);
    const left = long.filter(s => s.x1 <= g + 1 && s.plain.length >= 20), right = long.filter(s => s.x0 >= g - 1 && s.plain.length >= 20);
    const pairs = left.filter(s => right.some(t => Math.abs(t.baseline - s.baseline) <= 0.5 * s.size)).map(s => s.baseline);
    const bounds = [-Infinity, ...cuts, Infinity];
    const pieces = [];
    for (let k = 0; k + 1 < bounds.length; k++) {
      const a = bounds[k], b = bounds[k + 1];
      const n = pairs.filter(y => y > a && y < b).length;
      if (n) pieces.push({g, a, b, lo, hi, pairs: n});
    }
    return pieces;
  }
  const inPiece = (pc, y) => y > pc.a && y < pc.b && y >= pc.lo && y <= pc.hi;

  /* The page's gutters as pieces: those found on the page, then, where none of them
     holds, a gutter the rest of the document uses (a first page with only three lines
     in two columns) and, failing that, one found in that stretch alone (a sidebar beside
     the abstract). */
  function activePieces(segs, W, pageGutters, docGutters) {
    const live = segs;
    const pieces = [];
    for (const g of pageGutters) for (const pc of gutterPieces(live, g, W, -Infinity, Infinity)) pieces.push(pc);
    const uncovered = () => {
      const ys = [...new Set(live.map(s => s.baseline))].sort((a, b) => a - b);
      const out = [];
      let cur = null;
      for (const y of ys) {
        if (pieces.some(pc => inPiece(pc, y))) { cur = null; continue; }
        if (!cur) { cur = {lo: y, hi: y}; out.push(cur); } else cur.hi = y;
      }
      return out.filter(r => live.filter(s => s.baseline >= r.lo && s.baseline <= r.hi && isLongSeg(s, W)).length >= 4);
    };
    for (const r of uncovered()) {
      let best = null;
      for (const g of docGutters) {
        if (pageGutters.some(p => Math.abs(p - g) < 0.04 * W)) continue;
        const pcs = gutterPieces(live, g, W, r.lo, r.hi).filter(pc => pc.pairs >= 2);
        const n = sum(pcs.map(pc => pc.pairs));
        if (pcs.length && (!best || n > best.n)) best = {n, pcs};
      }
      if (best) pieces.push(...best.pcs);
    }
    if (pieces.length) {
      for (const r of uncovered()) {
        const inR = live.filter(s => s.baseline >= r.lo && s.baseline <= r.hi);
        const found = [];
        findGutters(inR, W, 0, W, found, 1, 3);
        for (const g of found) pieces.push(...gutterPieces(inR, g, W, r.lo, r.hi).filter(pc => pc.pairs >= 2));
      }
    }
    return pieces;
  }

  /* The first line of a reference list in a column: small type, an entry's start, and
     only small type after it in the column. */
  const refHead = (ls, i, bodySize) => {
    const l = ls[i];
    if (l.size > 0.93 * bodySize) return false;
    const two = l.text + ' ' + (ls[i + 1] ? ls[i + 1].text : '');
    if (!(REF_MARKER.test(l.text) || REF_START.test(l.text)) || !/\b(?:19|20)\d{2}[a-z]?\b/.test(two)) return false;
    const rest = ls.slice(i);
    return rest.length >= 3 && rest.filter(q => q.size <= 0.93 * bodySize).length >= 0.9 * rest.length;
  };

  /* One page into lines in reading order. Segments that cross a gutter where it holds
     (a title, an abstract, a caption across the page) and lines where no gutter holds on
     a page that has columns elsewhere are spanning rows; runs of them cut the page into
     zones. Inside a zone the columns of each stretch are chained top to bottom: a column
     is read after every column above it that it lies under, and a column carries on into
     the one below it, so the narrow column beside a figure continues into the wide column
     under the figure. A reference list that starts across the columns at one height closes
     the zone: the body above it in every column is read first. */
  function layoutPage(pg, bodySize, docGutters) {
    const dropCaps = pg.segs.filter(s => !s.skip && bodySize && s.size >= 1.6 * bodySize && s.plain.length <= 3 && /^[\p{L}\d]+$/u.test(s.plain.trim()) && !pg.segs.some(q => q !== s && !q.skip && Math.abs(q.size - s.size) < 0.2 * s.size && Math.abs(q.baseline - s.baseline) < 0.5 * s.size));
    for (const d of dropCaps) d.skip = 'dropcap';
    const segs = pg.segs.filter(s => !s.skip);
    const W = pg.width;
    const pageGutters = pg.pageGutters || [];
    const pieces = activePieces(segs, W, pageGutters, docGutters || []);
    const gutters = [...new Set(pieces.map(pc => pc.g))].sort((a, b) => a - b);
    pg.gutters = gutters;
    const activeAt = y => [...new Set(pieces.filter(pc => inPiece(pc, y)).map(pc => pc.g))].sort((a, b) => a - b);
    for (const s of segs) {
      const act = activeAt(s.baseline);
      s.sig = act.join('/');
      if (!pieces.length) { s.col = 0; continue; }
      if (!act.length || act.some(g => crossesAt(s, g))) { s.col = -1; continue; }
      let c = 0;
      for (const g of act) if (s.x0 >= g - 2) c++;
      s.col = c;
    }
    // a column segment beside a spanning one on its baseline, in its type, is part of the spanning row
    if (pieces.length) {
      const spans = segs.filter(s => s.col < 0);
      for (const s of segs) if (s.col >= 0 && spans.some(t => Math.abs(t.baseline - s.baseline) <= 0.4 * s.size && Math.abs(t.size - s.size) <= 0.6 && Math.max(t.x0 - s.x1, s.x0 - t.x1) < 3 * s.size)) s.col = -1;
    }
    // the short last line of a paragraph that spans the gutter does not itself reach the gutter:
    // a line that closes a sentence right under a spanning row, from the same left edge, belongs to it
    if (pieces.length) {
      const rowsNow = lineify(segs.filter(s => s.col < 0), pg.index, -1, 0, '');
      for (const row of rowsNow) {
        const below = segs.filter(s => s.col >= 0 && s.baseline > row.baseline && s.baseline - row.baseline <= 1.5 * Math.max(s.size, row.size) && Math.abs(s.x0 - row.x0) < 0.5 * s.size && /[.!?]["”')\]]*$/.test(s.plain) && row.x1 - row.x0 > 0.85 * (Math.max(...rowsNow.map(r => r.x1 - r.x0))));
        for (const s of below) s.col = -1;
      }
    }
    const spanRows = lineify(segs.filter(s => s.col < 0), pg.index, -1, 0, '');
    // consecutive spanning rows form one run (a title block, an abstract); a column
    // segment inside a run (an icon, a stray label) is read after the run, not in it
    const runs = [];
    for (const r of spanRows) {
      const cur = runs[runs.length - 1];
      const last = cur && cur[cur.length - 1];
      if (last && r.baseline - last.baseline <= 1.9 * Math.max(r.size, last.size)) cur.push(r); else runs.push([r]);
    }
    const zoneOf = s => { let z = 0; for (const run of runs) if (s.baseline > run[0].baseline - 0.3 * s.size) z++; return z; };
    const byZone = [];
    for (let z = 0; z <= runs.length; z++) byZone.push([]);
    for (const s of segs) if (s.col >= 0) byZone[zoneOf(s)].push(s);
    const lines = [];
    let zoneId = 0, nodeId = 0;
    const chainCols = (zsegs) => {
      // stretches: consecutive baselines with the same set of gutters
      const sorted = zsegs.slice().sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
      const nodes = [];
      let band = -1, lastSig = null;
      const nodeOf = new Map();
      for (const s of sorted) {
        if (s.sig !== lastSig) { band++; lastSig = s.sig; }
        const key = band + ':' + s.col;
        let n = nodeOf.get(key);
        if (!n) { n = {band, col: s.col, segs: [], id: nodeId++}; nodeOf.set(key, n); nodes.push(n); }
        n.segs.push(s);
      }
      for (const n of nodes) {
        const use = n.segs.filter(s => isLongSeg(s, W));
        const src = use.length ? use : n.segs;
        n.x0 = Math.min(...src.map(s => s.x0)); n.x1 = Math.max(...src.map(s => s.x1));
      }
      const overlaps = (u, v) => Math.min(u.x1, v.x1) - Math.max(u.x0, v.x0) > 0.3 * Math.min(u.x1 - u.x0, v.x1 - v.x0);
      for (const v of nodes) {
        v.preds = [];
        for (let b = v.band - 1; b >= 0 && !v.preds.length; b--) v.preds = nodes.filter(u => u.band === b && overlaps(u, v));
      }
      const order = [];
      const done = new Set();
      let last = null, chain = -1;
      const ready = v => !done.has(v) && v.preds.every(u => done.has(u));
      const first = a => a.sort((u, v) => u.band - v.band || u.x0 - v.x0)[0];
      while (order.length < nodes.length) {
        let next = last ? first(nodes.filter(v => ready(v) && v.preds.includes(last))) : null;
        if (!next) { next = first(nodes.filter(ready)) || first(nodes.filter(v => !done.has(v))); chain++; }
        next.chain = chain; done.add(next); order.push(next); last = next;
      }
      return order;
    };
    const emitZone = (zsegs) => {
      const order = chainCols(zsegs);
      const out = order.map(n => ({n, ls: lineify(n.segs, pg.index, n.chain, 0, '')}));
      // a reference list starting at one height across the columns closes the zone above it
      if (order.length >= 2) {
        const starts = [];
        for (const {n, ls} of out) {
          const i = ls.findIndex((l, k) => refHead(ls, k, bodySize));
          if (i >= 0) starts.push({n, y: ls[i].baseline, top: ls[i].top, above: ls.slice(0, i).some(l => l.size > 0.93 * bodySize && l.chars >= 25)});
        }
        if (starts.length >= 2) {
          const y0 = Math.min(...starts.map(t => t.y)), y1 = Math.max(...starts.map(t => t.y));
          const sz = Math.max(...starts.map(t => t.n.segs[0].size));
          if (y1 - y0 <= 6 * sz && starts.some(t => t.above)) {
            const cut = Math.min(...starts.map(t => t.top)) - 0.5;
            const above = zsegs.filter(s => s.bottom <= cut + 0.2 * s.size || s.baseline < cut), below = zsegs.filter(s => !above.includes(s));
            if (above.length && below.length) { emitZone(above); emitZone(below); return; }
          }
        }
      }
      const z = zoneId++;
      for (const {n, ls} of out) for (const l of ls) { l.zone = z; l.col = n.chain; l.group = pg.index + ':' + z + ':' + n.id; lines.push(l); }
    };
    for (let z = 0; z <= runs.length; z++) {
      if (byZone[z].length) emitZone(byZone[z]);
      if (z < runs.length) { const zz = zoneId++; for (const l of runs[z]) { l.zone = zz; l.group = pg.index + ':' + zz + ':s'; l.col = -1; lines.push(l); } }
    }
    // a drop cap joins the first line beside it, and the lines it pushes in are not paragraph indents
    for (const d of dropCaps) {
      const cand = lines.filter(l => l.col >= 0 && l.x0 >= d.x1 - 3 && l.x0 - d.x1 < 2.5 * bodySize && l.baseline >= d.top && l.baseline <= d.baseline + 2 && l.x0 - d.x0 < 0.4 * pg.width);
      if (!cand.length) { d.skip = null; continue; }
      cand.sort((a, b) => a.baseline - b.baseline);
      const first = cand[0];
      first.cells[0] = makeSegment(d.parts.concat(first.cells[0].parts));
      first.parts = [].concat(...first.cells.map(c => c.parts));
      first.text = first.cells.map(c => c.plain).join(' ').replace(/\s+/g, ' ').trim();
      first.x0 = Math.min(first.x0, d.x0); first.chars += d.chars;
      for (const l of cand.slice(1)) l.dropIndent = true;
      first.dropFirst = true;
    }
    pg.columns = gutters.length ? Math.max(...segs.map(s => (s.sig ? s.sig.split('/').length : 0))) + 1 : 1;
    pg.lines = lines;
    let id = 0;
    for (const l of lines) { l.id = pg.index + '.' + (id++); for (const p of l.parts) p.lineId = l.id; }
    // the measure of a column: its own lines when it has enough of them, else the chain it belongs to
    pg.geom = {};
    const measure = (ls, lo, hi) => {
      const long = ls.filter(l => l.chars >= 25);
      const use = long.length >= 3 ? long : ls;
      return {left: percentile(use.map(l => l.x0), lo), right: percentile(use.map(l => l.x1), hi), n: long.length};
    };
    for (const c of new Set(lines.map(l => l.col))) pg.geom[c] = measure(lines.filter(l => l.col === c), 0.15, 0.85);
    pg.groupGeom = {};
    for (const gk of new Set(lines.map(l => l.group))) {
      const m = measure(lines.filter(l => l.group === gk), 0.15, 0.85);
      if (m.n >= 3) pg.groupGeom[gk] = m;
    }
    const gAll = lines.filter(l => l.chars >= 25);
    const gUse = gAll.length ? gAll : lines;
    pg.geom[-1] = {left: percentile(gUse.map(l => l.x0), 0.1), right: percentile(gUse.map(l => l.x1), 0.9)};
    return pg;
  }

  /* ----------------------------------------------------- vocabularies */

  const HEADINGS = {
    abstract: ['abstract', 'summary', 'abstractsummary', 'structuredabstract', 'executivesummary'],
    frontskip: ['highlights', 'graphicalabstract', 'inbrief', 'etocblurb', 'significance', 'significancestatement', 'keypoints', 'keywords', 'keyword',
      'authorsummary', 'laysummary', 'impactstatement', 'articleinfo', 'articlehistory', 'researcharticlesummary', 'editorssummary', 'publicsummary', 'authors', 'author',
      'graphicalabstracts', 'researchhighlights', 'keyresourcestable'],
    refs: ['references', 'reference', 'bibliography', 'literaturecited', 'workscited', 'referencelist', 'notesandreferences', 'referencesandnotes',
      'referencesandnote', 'literature', 'methodsreferences', '참고문헌', '인용문헌', 'literaturverzeichnis'],
    supp: ['supplementaryinformation', 'supplementarymaterial', 'supplementarymaterials', 'supplementarydata', 'supplementaryfiles', 'supplementaryfigures', 'figures', 'figurelegends', 'figurecaptions', 'tables', 'figuresandtables', 'tablesandfigures',
      'supplementaryinformationavailable', 'supportinginformation', 'supportinginformationavailable', 'supplementalinformation', 'appendixasupplementarydata',
      'associatedcontent', 'extendeddata', 'extendeddatafigures', 'supplementarytables'],
    back: ['acknowledgments', 'acknowledgements', 'acknowledgment', 'acknowledgement', 'acknowledgmentsandfunding', 'acknowledgementsandfunding', 'authorcontributions',
      'authorscontributions', 'contributions', 'authorcontribution', 'creditauthorshipcontributionstatement', 'competinginterests', 'competinginterest',
      'conflictofinterest', 'conflictsofinterest', 'conflictofinterests', 'declarationofcompetinginterest', 'declarationofcompetinginterests', 'declarationofinterest',
      'declarationofinterests', 'declarations', 'disclosures', 'disclosure', 'disclosurestatement', 'funding', 'fundinginformation', 'financialsupport', 'fundingsources',
      'dataavailability', 'dataavailabilitystatement', 'codeavailability', 'dataandcodeavailability', 'dataandmaterialsavailability', 'datamaterialsandsoftwareavailability', 'datamaterialandsoftwareavailability', 'availabilityofdataandmaterials',
      'datasharingstatement', 'dataandmaterialavailability', 'ethics', 'ethicsstatement', 'ethicsapproval', 'ethicsdeclarations', 'ethicsapprovalandconsenttoparticipate',
      'additionalinformation', 'reportingsummary', 'peerreviewinformation', 'peerreview', 'publishersnote', 'openaccess', 'rightsandpermissions', 'reprintsandpermissions',
      'aboutthisarticle', 'onlinecontent', 'authorinformation', 'abbreviations', 'abbreviation', 'notes', 'authornotes', 'correspondence', 'materialsavailability', 'leadcontact',
      'authorstatement', 'statementofauthorship', 'conflictofinterestdisclosure', 'consentforpublication', 'competingfinancialinterests', 'orcid', 'notefromthepublisher',
      'footnotes', 'footnote', 'correspondenceandrequestsformaterials', 'reprintsandpermissionsinformation', 'reprintsandpermissionsinformationisavailable', 'dedication', 'inmemoriam', 'authorsnote', 'contributorinformation', 'sourceofsupport', 'grantsupport'],
    main: ['introduction', 'background', 'results', 'resultsanddiscussion', 'discussion', 'discussionandconclusion', 'discussionandconclusions', 'conclusion', 'conclusions',
      'concludingremarks', 'perspectives', 'outlook', 'main', 'methods', 'materialsandmethods', 'materialandmethods', 'materialsandmethod', 'materialandmethod', 'methodsandmaterials', 'experimentalprocedures', 'experimentalsection',
      'experimental', 'starmethods', 'onlinemethods', 'methodsummary', 'methodology', 'materials', 'subjectsandmethods', 'patientsandmethods', 'theory', 'rationale',
      'resourceavailability', 'methoddetails', 'quantificationandstatisticalanalysis', 'statisticalanalysis', 'limitationsofthestudy', 'futuredirections',
      'summaryandconclusions', 'overview', 'motivation', 'implications', 'limitations', 'perspective', 'synopsis', 'preface', 'prologue', 'epilogue', 'afterword'],
  };
  const HEAD_KIND = new Map();
  for (const [kind, names] of Object.entries(HEADINGS)) for (const n of names) HEAD_KIND.set(n, kind);
  const METHODS_NAMES = new Set(['methods', 'materialsandmethods', 'materialandmethods', 'materialsandmethod', 'materialandmethod', 'materialandmethods', 'materialsandmethod', 'materialandmethod', 'methodsandmaterials', 'experimentalprocedures', 'experimentalsection', 'experimental', 'starmethods',
    'onlinemethods', 'methodology', 'subjectsandmethods', 'patientsandmethods', 'methodsummary', 'methoddetails', 'materials']);

  /* The heading name a line carries: numbering removed, spaced capitals closed
     up ("A B S T R A C T"), trailing punctuation dropped, letters only. */
  function headingName(text) {
    let t = String(text).replace(/\s+/g, ' ').trim();
    t = t.replace(/^(?:section\s+)?(?:\d{1,2}(?:\.\d{1,2}){0,3}|[IVX]{1,5}(?=[.)]))[.)]?\s+/i, '');
    t = t.replace(/^(?:[A-H][.)]\s+)/, '');
    t = t.replace(/[.:;–—\-\s]+$/, '');
    return squash(t);
  }
  const headKind = text => HEAD_KIND.get(headingName(text)) || null;

  const ABBR = new Set(['fig', 'figs', 'eq', 'eqs', 'ref', 'refs', 'e.g', 'i.e', 'vs', 'approx', 'dr', 'mr', 'mrs', 'ms', 'prof', 'sp', 'spp', 'subsp', 'var', 'no', 'nos',
    'cf', 'ca', 'resp', 'inc', 'ltd', 'co', 'corp', 'st', 'jr', 'sr', 'vol', 'vols', 'pp', 'ed', 'eds', 'viz', 'suppl', 'supp', 'sec', 'secs', 'chap', 'tab', 'ext', 'al', 'etc',
    'u.s', 'a.m', 'p.m', 'ph.d', 'm.d', 'dept', 'univ', 'est', 'esp', 'incl', 'excl', 'avg', 'conc', 'fr', 'gen', 'ver', 'ssp', 'nov', 'aff', 'ibid', 'mt', 'wt', 'min', 'max',
    'temp', 'dist', 'et', 'ser', 'cat', 'nat', 'biol', 'chem', 'phys', 'proc', 'rev', 'sci', 'natl', 'acad', 'soc', 'mol']);
  // those that take what follows even if it is capitalised ("Fig. 2", "vs. Control", "sp. nov.")
  const ABBR_TAKES_NEXT = new Set(['fig', 'figs', 'eq', 'eqs', 'ref', 'refs', 'no', 'nos', 'tab', 'sec', 'secs', 'chap', 'vol', 'vols', 'pp', 'cf', 'vs', 'dr', 'mr', 'mrs', 'ms',
    'prof', 'st', 'jr', 'sr', 'sp', 'spp', 'subsp', 'var', 'approx', 'ca', 'resp', 'viz', 'suppl', 'supp', 'ext']);
  const STARTERS = new Set(['the', 'this', 'these', 'those', 'in', 'we', 'our', 'a', 'an', 'it', 'they', 'however', 'here', 'to', 'thus', 'moreover', 'furthermore', 'additionally',
    'similarly', 'notably', 'consistent', 'for', 'as', 'using', 'together', 'overall', 'taken', 'collectively', 'next', 'finally', 'importantly', 'interestingly', 'previous', 'recent',
    'although', 'while', 'when', 'because', 'since', 'following', 'after', 'before', 'during', 'despite', 'both', 'several', 'many', 'most', 'some', 'such', 'each', 'one', 'two', 'three',
    'based', 'given', 'indeed', 'also', 'further', 'of', 'on', 'by', 'with', 'at', 'from', 'their', 'his', 'her', 'its', 'there', 'then', 'first', 'second', 'third', 'if', 'what', 'how',
    'why', 'which', 'who', 'no', 'not', 'all', 'only', 'but', 'and', 'or', 'so', 'yet', 'whereas', 'unlike', 'compared']);
  const OPENERS = /["“‘(\[]/;
  const UPPER = /[A-ZÀ-ÖØ-Þ]/;

  /* Sentence boundaries, science-aware. A boundary is a . ? or ! (with any
     closing quote or bracket) followed by a space and a capital or digit, except
     inside parentheses and after an abbreviation, an initial ("E. coli") or a
     reference marker such as "et al.". Returns [start, end) ranges. */
  function splitSentences(s) {
    const out = [];
    let start = 0, depth = 0, depthStart = 0;
    const n = s.length;
    for (let i = 0; i < n; i++) {
      const c = s[i];
      if (c === '(' || c === '[' || c === '{') { if (depth === 0) depthStart = i; depth++; }
      else if (c === ')' || c === ']' || c === '}') { if (depth > 0) depth--; }
      if (depth > 0 && i - depthStart > 400) depth = 0;
      if (c !== '.' && c !== '?' && c !== '!') continue;
      let j = i + 1;
      while (j < n && /[.?!]/.test(s[j])) j++;
      let k = j, d = depth;
      while (k < n && /["”’')\]}]/.test(s[k])) { if (/[)\]}]/.test(s[k]) && d > 0) d--; k++; }
      if (d > 0) continue;
      if (k < n && s[k] !== ' ') continue;
      let m = k;
      while (m < n && s[m] === ' ') m++;
      if (m >= n) continue;
      let next = s[m], probe = m;
      if (OPENERS.test(next) && m + 1 < n) { probe = m + 1; next = s[probe]; if (OPENERS.test(next) && probe + 1 < n) { probe++; next = s[probe]; } }
      const isDigit = /\d/.test(next);
      if (!UPPER.test(next) && !isDigit) continue;
      if (c === '.' && j === i + 1) {
        const before = s.slice(Math.max(0, i - 24), i);
        const tm = /(?:^|[\s(\[“"'‘—–\/])([A-Za-z][A-Za-z.]*)$/.exec(before);
        const tok = tm ? tm[1] : '';
        if (tok) {
          const low = tok.toLowerCase();
          if (/^[A-Z]$/.test(tok)) continue;                                              // initials and "E. coli"
          if (/^[A-Za-z]\.[A-Za-z]$/.test(tok) || /^(?:[A-Za-z]\.){1,3}[A-Za-z]$/.test(tok)) continue;   // e.g, i.e, U.S, Ph.D
          if (ABBR.has(low)) {
            const nw = /^[A-Za-z]+/.exec(s.slice(probe));
            const starter = nw && STARTERS.has(nw[0].toLowerCase());
            if (low === 'al' || low === 'etc' || low === 'et') { if (!starter) continue; }
            else if (ABBR_TAKES_NEXT.has(low)) continue;
            else if (!starter) continue;
          }
        }
      }
      out.push([start, k]);
      start = m;
      i = Math.max(i, k - 1);
    }
    if (start < n) out.push([start, n]);
    return out.filter(r => s.slice(r[0], r[1]).trim());
  }

  /* ------------------------------------------------------- hyphens */

  // Second and first elements that make hyphenated compounds ("binding" in "DNA-binding",
  // "self" in "self-assembly"); used only beside a word the document also uses on its own.
  const KEEP_RIGHT = new Set(['binding', 'dependent', 'independent', 'induced', 'mediated', 'specific', 'based', 'derived', 'resistant', 'free', 'like', 'type', 'encoded', 'related',
    'associated', 'coupled', 'terminal', 'wide', 'scale', 'phage', 'fold', 'stranded', 'rich', 'poor', 'positive', 'negative', 'deficient', 'sensitive', 'tolerant', 'controlled',
    'limited', 'targeting', 'treated', 'expressing', 'containing', 'producing', 'resolution', 'throughput', 'to', 'driven', 'regulated', 'activated', 'inducible', 'knockout',
    'tagged', 'fused', 'linked', 'bound', 'loaded', 'dose', 'response', 'only', 'sized', 'shaped', 'weight', 'wild', 'phase', 'dimensional', 'step', 'copy', 'cell', 'cells']);
  const SUFFIX_ONLY = /^(?:ments?|ings?|ed|ers?|ions?|ations?|ly|ness(?:es)?|able|ible|ity|ities|ives?|al|ally|ics?|ous|ences?|ances?|ants?|ents?|isms?|ists?|i[sz]e[sd]?|i[sz]ing|i[sz]ations?|ional|ionally|ary|ory|ure|ures)$/;
  const JOINED_WORD = /^(?:highlight|highway|nonetheless|crossover|crossroad|halfway|wholesale|wholly|longitud|shortcut|shortage|shortly|fullness|wildlife|allow|allocat|alleviat|allele|allel|ultrason|panel|pandemic|pancrea|realiz|realis|reality|wellness|lowest)/;
  const KEEP_PREFIX = new Set(['high', 'low', 'self', 'non', 'multi', 'cross', 'well', 'semi', 'quasi', 'single', 'double', 'long', 'short', 'full', 'half', 'whole', 'real', 'wild', 'all', 'pan', 'ultra']);
  const KEEP_LEFT = new Set(['non', 'anti', 'self', 'cross', 'semi', 'quasi', 'co', 'high', 'low', 'long', 'short', 'well', 'single', 'double', 'whole', 'real', 'full', 'large',
    'small', 'half', 'cell', 'host', 'phage', 'dna', 'rna', 'trna', 'mrna', 'gene', 'protein', 'head', 'liquid', 'rate', 'two', 'three', 'one', 'time', 'dose']);

  /* Is "micro-|organisms" one word or a hyphenated compound? Conservative: join
     when the document itself uses the joined word elsewhere; keep when it uses the
     hyphenated form, when either side has a digit, is an initial or an acronym
     ("DNA-"), or when a half is a typical compound element ("binding", "anti");
     otherwise a hyphen at the end of a line is a syllable break. */
  function decideHyphen(left, right, lex) {
    if (!left || !right) return {action: 'keep', why: 'empty side'};
    if (/\d/.test(left) || /^\d/.test(right)) return {action: 'keep', why: 'digit beside the hyphen'};
    if (!/^[a-z]/.test(right)) return {action: 'keep', why: 'next line does not start lower-case'};
    if (left.length < 2) return {action: 'keep', why: 'single-letter prefix'};
    if (/^[A-Z]{2,}$/.test(left) || (/[a-z]/.test(left) && /[A-Z]/.test(left.slice(1)))) return {action: 'keep', why: 'acronym or mixed-case word before the hyphen'};
    const l = left.toLowerCase(), r = right.toLowerCase();
    const words = lex && lex.words ? lex.words : new Set();
    if (words.has(l + '-' + r)) return {action: 'keep', why: 'hyphenated word occurs in the document'};
    if (words.has(l + r)) return {action: 'join', why: 'joined word occurs in the document'};
    // a compound prefix keeps its hyphen ("high-fidelity", "self-versus", "non-self") unless the paper joins it
    if (JOINED_WORD.test(l + r)) return {action: 'join', why: 'a common word'};
    if (KEEP_PREFIX.has(l)) return {action: 'keep', why: 'compound prefix'};
    // two words the paper uses on their own are a compound ("motif-adaptable"); syllables are not words
    if (l.length >= 4 && r.length >= 4 && words.has(l) && words.has(r)) return {action: 'keep', why: 'both halves are words of the document'};
    if (l.length >= 4 && r.length >= 6 && words.has(l) && !SUFFIX_ONLY.test(r) && !/^(?:trans|under|over|inter|intra|super|counter|with|back|fore|after|there|where|some|every|work|path|frame|break|cross|thermo|photo|hydro|micro|macro|poly|para|meta|peri|post|retro|extra|ultra)$/.test(l)) return {action: 'keep', why: 'a word of the document, then a word'};
    // a typical compound element beside a word the document also uses on its own
    if (((KEEP_RIGHT.has(r) && l.length >= 3 && words.has(l)) || (KEEP_LEFT.has(l) && r.length >= 3 && words.has(r)))) return {action: 'keep', why: 'compound element beside a word the document uses on its own'};
    if (r.length >= 3 && l.length >= 2) return {action: 'join', why: 'syllable break'};
    return {action: 'keep', why: 'too short to be sure'};
  }

  /* The words the document itself uses, for deciding hyphens. Fragments of words broken at
     a line end are not words and are left out: the token that ends in the hyphen and the
     first token of the line after it. */
  function buildLexicon(pages) {
    const w = new Set();
    for (const pg of pages) {
      let broken = false;
      for (const l of pg.lines) {
        const toks = l.text.toLowerCase().split(/[^\p{L}\p{N}'\u2019-]+/u).filter(Boolean);
        toks.forEach((raw, i) => {
          if (broken && i === 0) return;
          if (i === toks.length - 1 && /-$/.test(l.text.trim()) ) return;
          const t = raw.replace(/^-+|-+$/g, '');
          if (t.length > 1 && /^\p{L}+(?:-\p{L}+)*$/u.test(t)) w.add(t);
        });
        broken = /\p{L}-$/u.test(l.text.trim());
      }
    }
    return {words: w};
  }

  /* --------------------------------------------------- paragraph stream */

  /* Join lines into paragraph text keeping, for every character, the item it
     came from. Citation numbers stay out of the text (marks keep them for the
     rects); a line-end hyphen is resolved by decideHyphen. */
  function buildStream(lines, lex, notes) {
    const toks = [], marks = [];
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const use = joinParts([].concat(...line.cells.map(c => c.parts)), true);
      if (li > 0 && toks.length) {
        const tail = toks.slice(-40).map(t => t.ch).join('');
        const hm = /([\p{L}\p{N}]*)([-­])$/u.exec(tail);
        const nm = /^([\p{L}]+)/u.exec(use.toks.slice(0, 40).map(t => t.ch).join(''));
        if (hm && hm[1]) {
          const left = hm[1], right = nm ? nm[1] : '';
          const soft = hm[2] === '­';
          const d = soft ? {action: 'join', why: 'soft hyphen'} : decideHyphen(left, right, lex);
          if (notes) notes.push({action: d.action, left, right, why: d.why, page: line.page});
          if (d.action === 'join') toks.pop();
          else if (soft) { const t = toks[toks.length - 1]; toks[toks.length - 1] = {ch: '-', part: t.part, ci: t.ci}; }
        } else if (toks[toks.length - 1].ch !== ' ') toks.push({ch: ' ', part: toks[toks.length - 1].part, ci: -1});
      }
      const base = toks.length;
      for (const t of use.toks) toks.push(t);
      for (const m of use.marks) marks.push({pos: base + m.pos, part: m.part});
    }
    // a spacing accent that the PDF drew as its own glyph after the letter it belongs to ("Jasko\u00B4 lska")
    for (let i = 1; i + 2 < toks.length; i++) {
      if (/[\u00B4\u00A8`]/.test(toks[i].ch) && /\p{L}/u.test(toks[i - 1].ch) && toks[i + 1].ch === ' ' && /\p{Ll}/u.test(toks[i + 2].ch)) { toks[i] = {ch: '', part: toks[i].part, ci: -1}; toks[i + 1] = {ch: '', part: toks[i].part, ci: -1}; }
    }
    const outT = [], idx = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      idx[i] = outT.length;
      if (t.ch === '') continue;
      if (t.ch === ' ' && (!outT.length || outT[outT.length - 1].ch === ' ')) continue;
      outT.push(t);
    }
    idx[toks.length] = outT.length;
    while (outT.length && outT[outT.length - 1].ch === ' ') outT.pop();
    return {toks: outT, marks: marks.map(m => ({pos: Math.min(idx[m.pos] != null ? idx[m.pos] : outT.length, outT.length), part: m.part}))};
  }

  /* -------------------------------------------------------- rects */

  function rectsOf(toks, marks, a, b) {
    const byLine = new Map();
    const add = (part, c0, c1) => {
      const len = part.str.length || 1;
      const x0 = part.x + part.w * (c0 / len), x1 = part.x + part.w * ((c1 + 1) / len);
      const id = part.lineId != null ? part.lineId : 'l' + Math.round(part.baseline);
      let r = byLine.get(id);
      if (!r) { r = {x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity}; byLine.set(id, r); }
      r.x0 = Math.min(r.x0, x0); r.x1 = Math.max(r.x1, x1);
      r.y0 = Math.min(r.y0, part.y); r.y1 = Math.max(r.y1, part.y + part.h);
    };
    const span = new Map();
    for (let i = a; i < b; i++) {
      const t = toks[i];
      if (!t || t.ci < 0) continue;
      const s = span.get(t.part);
      if (!s) span.set(t.part, [t.ci, t.ci]); else { s[0] = Math.min(s[0], t.ci); s[1] = Math.max(s[1], t.ci); }
    }
    for (const [part, [c0, c1]] of span) add(part, c0, c1);
    for (const m of marks) if (m.pos > a && m.pos <= b) add(m.part, 0, m.part.str.length - 1);
    return [...byLine.values()].sort((p, q) => p.y0 - q.y0 || p.x0 - q.x0).map(r => [round1(r.x0), round1(r.y0), round1(r.x1 - r.x0), round1(r.y1 - r.y0)]);
  }

  const URL_ONLY = /^(?:(?:https?:\/\/|www\.|ftp:\/\/)\S+|(?:doi:\s*)?10\.\d{4,9}\/\S+|\S+@\S+\.\S+|(?:e-?mail|doi|url)\s*:\s*\S+)[.,;)]*$/i;

  function chunkLong(text, maxWords) {
    if (words(text).length <= maxWords) return [text];
    // cut at a semicolon or colon nearest the middle, else at a comma, else a space
    const mid = text.length / 2;
    let best = -1, bd = Infinity;
    for (const re of [/;\s/g, /:\s/g, /,\s/g]) {
      let m;
      while ((m = re.exec(text))) { const d = Math.abs(m.index - mid); if (d < bd && m.index > 20 && m.index < text.length - 20) { bd = d; best = m.index + 1; } }
      if (best >= 0) break;
    }
    if (best < 0) { best = text.indexOf(' ', Math.floor(mid)); if (best < 0) return [text]; }
    return [...chunkLong(text.slice(0, best).trim(), maxWords), ...chunkLong(text.slice(best).trim(), maxWords)];
  }

  /* A paragraph's lines into sentences with their rects. Fragments of fewer than
     two words are joined onto a neighbour, an over-long run is cut at a
     semicolon or comma, and a sentence that is only a URL, DOI or address is
     set aside. */
  function sentencesOf(lines, lex, notes, other) {
    const st = buildStream(lines, lex, notes);
    const text = st.toks.map(t => t.ch).join('');
    if (!text.trim()) return [];
    const lineById = new Map();
    for (const l of lines) lineById.set(l.id, l);
    const merged = [];
    const isAddress = t => URL_ONLY.test(t.trim());
    for (const r of splitSentences(text)) {
      const piece = text.slice(r[0], r[1]);
      if (words(piece).length < 2 && !isAddress(piece) && merged.length) merged[merged.length - 1][1] = r[1];
      else merged.push([r[0], r[1]]);
    }
    if (merged.length > 1 && words(text.slice(merged[0][0], merged[0][1])).length < 2 && !isAddress(text.slice(merged[0][0], merged[0][1]))) { merged[1][0] = merged[0][0]; merged.shift(); }
    const result = [];
    for (const [a0, b0] of merged) {
      let a = a0, b = b0;
      while (a < b && text[a] === ' ') a++;
      while (b > a && text[b - 1] === ' ') b--;
      const piece = text.slice(a, b);
      if (!/\p{L}/u.test(piece)) { if (piece.trim()) other.push({text: piece, page: st.toks[a] ? st.toks[a].part.page : lines[0].page, reason: 'no letters'}); continue; }
      const firstTok = st.toks[a];
      const page = firstTok ? firstTok.part.page : lines[0].page;
      if (URL_ONLY.test(piece.trim())) { other.push({text: piece, page, reason: 'only a URL, DOI or address'}); continue; }
      let offset = a;
      for (const ch of chunkLong(piece, 110)) {
        const at = text.indexOf(ch, offset);
        const ca = at >= 0 ? at : offset, cb = ca + ch.length;
        offset = cb;
        const ft = st.toks[ca] || firstTok;
        const line = ft ? lineById.get(ft.part.lineId) : null;
        result.push({
          text: ch, spoken: spokenOf(ch), page: ft ? ft.part.page : page, rects: rectsOf(st.toks, st.marks, ca, cb),
          col: line ? line.col : 0, zone: line ? line.zone : 0, y: ft ? round1(ft.part.y) : 0,
        });
      }
    }
    return result;
  }

  /* A sentence as it is spoken: inline citations left out ("(29, 106, 125)", "[1, 2]", "( 31 )",
     "(Smith et al., 2020; Lee, 2019)"), the written text unchanged. A figure or equation reference,
     a quantity in brackets and an enumeration "(1) ... (2) ..." stay. */
  const CITE_NUM = /\s*[\[(]\s*(\d{1,3}(?:\s*[,\u2013\u2014-]\s*\d{1,3})*)\s*[\])]/g;
  const CITE_NAME = String.raw`(?:(?:de|van|von|der|den|da|di|du|la|le|del)\s+)*\p{Lu}[\p{L}'\u2019-]+`;
  const CITE_AUTHOR = new RegExp(String.raw`\s*\((?:see\s+(?:also\s+)?|e\.g\.,?\s*|reviewed in\s+|cf\.\s*)?(?:${CITE_NAME}(?:\s+(?:et\s+al\.?|and|&)(?:\s+${CITE_NAME})?)?,?\s+(?:19|20)\d{2}[a-z]?(?:,\s*(?:19|20)\d{2}[a-z]?)*(?:;\s*)?)+\)`, 'gu');
  function spokenOf(text) {
    const singles = [];
    let m;
    CITE_NUM.lastIndex = 0;
    while ((m = CITE_NUM.exec(text))) if (/^\d+$/.test(m[1])) singles.push(+m[1]);
    const enumerated = singles.includes(1) && singles.includes(2);
    let out = text.replace(CITE_NUM, (all, nums, at) => {
      if (enumerated && /^\d$/.test(nums)) return all;
      // "(Fig. 2)", "equation (3)", "step [2]" keep their number
      if (/(?:\b(?:fig|figs|figure|figures|eq|eqs|equation|equations|table|tables|step|steps|ref|lane|lanes|panel|panels|section|chapter|no)\.?|[=<>\u00B1\u00D7])\s*$/i.test(text.slice(0, at))) return all;
      return '';
    });
    out = out.replace(CITE_AUTHOR, '');
    out = out.replace(/\s+([.,;:!?)])/g, '$1').replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
    return out || text;
  }

  /* ----------------------------------------------- block building */

  const NUMBERED = /^(?:\d{1,2}(?:\.\d{1,2}){0,3})[.)]?\s+\p{Lu}/u;
  const NUMERIC_TOKEN = /^[\d.,+\-−–±%()<>=\/:~×]*\d[\d.,+\-−–±%()<>=\/:~×]*$/;
  const isNumberedHead = l => NUMBERED.test(l.text) && l.chars <= 95 && !TERMINAL.test(l.text.replace(/\)$/, ''));

  const MARKER_CELL = /^\[?\d{1,3}[\].)]?$/;
  function tabularFlags(lines) {
    return lines.map(l => {
      // a leading list marker ("12." or "[12]") is not a table cell
      const cells = l.cells.length > 1 && MARKER_CELL.test(l.cells[0].plain.trim()) ? l.cells.slice(1) : l.cells;
      const c = cells.length;
      if (c >= 3 && sum(cells.map(x => x.plain.length)) / c <= 28) return true;
      if (c >= 2) {
        const num = cells.filter(x => words(x.plain).every(w => NUMERIC_TOKEN.test(w))).length;
        if (num / c >= 0.5 && l.text.length <= 90) return true;
      }
      return false;
    });
  }

  // consecutive lines of text in one type size, and how far apart they are
  function pitchesOf(ls, size) {
    const t = ls.filter(l => Math.abs(l.size - size) <= 0.4 && l.chars >= 20);
    const out = [];
    for (let k = 1; k < t.length; k++) { const p = t[k].baseline - t[k - 1].baseline; if (p > 0.8 * size && p < 3.5 * size) out.push(p); }
    return out;
  }

  function buildBlocks(pg, bodySize, docPitch) {
    const blocks = [];
    const lines = pg.lines;
    const byGroup = new Map();
    for (const l of lines) { if (!byGroup.has(l.group)) byGroup.set(l.group, []); byGroup.get(l.group).push(l); }
    for (const [, ls] of byGroup) {
      const flags = tabularFlags(ls);
      for (let i = 1; i < ls.length - 1; i++) if (!flags[i] && flags[i - 1] && flags[i + 1] && ls[i].chars <= 45) flags[i] = true;
      ls.forEach((l, i) => { l.tab = flags[i]; });
      let i = 0;
      while (i < ls.length) {
        if (!ls[i].tab) { i++; continue; }
        let j = i; while (j < ls.length && ls[j].tab) j++;
        const smallPrint = ls.slice(i, j).every(l => l.size < bodySize * 0.95);
        const tabRows = ls.slice(i, j).filter(l => l.cells.length >= 2);
        if ((j - i < 3 && !(smallPrint && j - i >= 2)) || !aligned(tabRows)) for (let k = i; k < j; k++) ls[k].tab = false;
        i = j;
      }
      // the line pitch of each type size in the column, from lines of text: figure labels packed
      // close together in the same column would make every paragraph line look far apart
      for (const l of ls) {
        const own = pitchesOf(ls, l.size);
        const doc = docPitch && docPitch.get(sizeKey(l.size));
        if (own.length >= 3) { l.typPitch = median(own); l.typKnown = true; } else if (doc) { l.typPitch = doc; l.typKnown = true; } else { l.typPitch = l.size * 1.2; l.typKnown = false; }
      }
    }
    let cur = null;
    for (let li = 0; li < lines.length; li++) {
      const l = lines[li];
      const g = (l.col >= 0 && pg.groupGeom[l.group]) || pg.geom[l.col] || pg.geom[-1];
      l.colLeft = g.left; l.colRight = g.right;
      l.fill = g.right > g.left ? (l.x1 - l.x0) / (g.right - g.left) : 1;
      const prev = cur && cur.lines[cur.lines.length - 1];
      const next = lines[li + 1];
      const why = !cur ? 'start' : prev.group !== l.group ? 'group' : breakReason(prev, l, cur, next && next.group === l.group ? next : null);
      if (why) { cur = {lines: [l], page: pg.index, col: l.col, zone: l.zone, group: l.group, why}; blocks.push(cur); }
      else cur.lines.push(l);
    }
    return blocks;
  }

  const capsLine = l => { const t = l.text.replace(/[^A-Za-z]/g, ''); return t.length >= 4 && t === t.toUpperCase(); };

  // the font of most of a line's characters, and the one font a line is set in (null when mixed)
  const mainFont = l => { if (l._mf === undefined) { const w = new Map(); for (const p of l.parts) w.set(p.font, (w.get(p.font) || 0) + nsLen(p.str)); let b = null, bw = -1; for (const [f, n] of w) if (n > bw) { b = f; bw = n; } l._mf = b; } return l._mf; };
  const soleFont = l => { const f = mainFont(l); return l.parts.every(p => p.font === f || nsLen(p.str) <= 2) ? f : null; };
  function breakReason(prev, l, block, next) {
    if (!!prev.tab !== !!l.tab) return 'tab';
    if (!!prev.title !== !!l.title) return 'title';
    const typ = l.typPitch || prev.typPitch;
    const pitch = l.baseline - prev.baseline;
    if (Math.abs(l.size - prev.size) > Math.max(0.5, 0.05 * prev.size)) {
      // a line that opens with a run-in heading in larger type carries on in the body size
      const mixed = prev.parts.some(q => Math.abs(q.size - l.size) < 0.4 && nsLen(q.str) >= 4) && prev.parts.some(q => Math.abs(q.size - prev.size) < 0.4 && nsLen(q.str) >= 4);
      if (!mixed) return 'size';
    }
    if (pitch > 1.45 * typ || (!l.typKnown && pitch > 1.9 * l.size)) return 'pitch';
    if (l.bold !== prev.bold) return 'bold';
    // a short line set wholly in another font than the line after it (a heading when weight is unknown)
    if (prev.bold === undefined || prev.parts.every(p => !realFontName(p.font))) {
      if (prev.chars <= 110 && !TERMINAL.test(prev.text) && (prev.fill < 0.85 || Math.abs(l.size - prev.size) >= 0.4) && soleFont(prev) && soleFont(prev) !== mainFont(l)) return 'font';
    }
    const width = l.colRight - l.colLeft;
    const ex = q => (q.dropIndent ? q.colLeft : q.x0);
    const isIndented = x => x - l.colLeft > 0.9 * l.size && x - l.colLeft < 0.4 * width;
    const first = block.lines[0];
    if (isIndented(ex(l)) && !isIndented(ex(prev))) {
      // indented after a flush line: a hanging indent when the next line is indented alike, else a new paragraph
      // (or the flush line is a reference or list entry that runs to the margin: a two-line entry
      // shows only one indented line)
      const entryStart = block.lines.length === 1 && prev.fill > 0.85 && (REF_MARKER.test(prev.text) || REF_AUTHORS.test(prev.text));
      const hanging = (next && Math.abs(ex(next) - ex(l)) < 0.5 * l.size && !isIndented(ex(first))) || entryStart;
      if (!hanging) return 'indent';
    } else if (!isIndented(ex(l)) && isIndented(ex(prev)) && block.lines.length >= 2 && isIndented(ex(block.lines[1])) && !isIndented(ex(first))) {
      return 'hanging-end';     // flush line after the indented tail of a hanging-indent entry
    }
    // a line that closes a sentence well short of the margin ends the paragraph
    const short = prev.colRight - prev.x1;
    if (short > 2.5 * prev.size && width > 0 && short > 0.1 * width && TERMINAL.test(prev.text)) return 'short-line';
    // numbered and known-name headings are blocks of their own, before and after
    // "... depicted in Fig." then "2 A were indeed ...": the number belongs to the reference before it
    const refAbbrev = /\b(?:Figs?|Fig|Tables?|Eqs?|Refs?|No|Nos|Sect|Suppl)\.$/.test(prev.text);
    if (isNumberedHead(l) && !refAbbrev && (TERMINAL.test(prev.text) || prev.fill < 0.9)) return 'numbered-after';
    if (isNumberedHead(prev) && prev.fill < 0.8) return 'numbered-before';
    if (headKind(prev.text) && prev.chars <= 60 && prev.fill < 0.6 && !TERMINAL.test(prev.text)) return 'name-after';
    if (headKind(l.text) && l.chars <= 60 && l.fill < 0.6 && !TERMINAL.test(l.text) && (capsLine(l) || l.bold || prev.fill < 0.98)) return 'name-before';
    return null;
  }

  /* -------------------------------------------------- block features */

  function textOf(block) { return block.lines.map(l => l.text).join(' ').replace(/\s+/g, ' ').trim(); }

  function featuresOf(block, bodySize) {
    const text = textOf(block);
    const ws = words(text);
    const letters = text.replace(/[^\p{L}]/gu, '');
    const lower = text.replace(/[^\p{Ll}]/gu, '').length;
    const upperW = ws.filter(w => /^\p{Lu}/u.test(w)).length;
    const nonSpace = nsLen(text);
    const digits = text.replace(/\D/g, '').length;
    const syms = (text.match(/[=+−×÷±∑∏∫∂∇√∞≈≠≤≥<>→←↔∈∉⊂⊃∪∩Α-Ωα-ω^_{}|∗]/g) || []).length;
    const lines = block.lines;
    const size = median(lines.map(l => l.size));
    const body = lines.length > 1 ? lines.slice(0, -1) : lines;
    const wordLike = ws.filter(w => /^\p{Ll}{3,}[.,;:)]*$/u.test(w) || /^\p{Lu}\p{Ll}{2,}[.,;:)]*$/u.test(w)).length;
    return {
      text, nWords: ws.length, nChars: nonSpace, nLines: lines.length,
      lowerRatio: letters.length ? lower / letters.length : 0,
      capWordRatio: ws.length ? upperW / ws.length : 0,
      digitRatio: nonSpace ? digits / nonSpace : 0,
      symRatio: nonSpace ? syms / nonSpace : 0,
      size, fill: median(body.map(l => l.fill)),
      wordLikeRatio: ws.length ? wordLike / ws.length : 0,
      bold: lines.every(l => l.bold),
      allCaps: letters.length >= 4 && letters === letters.toUpperCase(),
      terminal: TERMINAL.test(text),
      startsLower: /^\p{Ll}/u.test(text),
      small: size < bodySize * 0.93,
    };
  }

  const CAPTION_RE = /^\s*((?:supplementary|supplemental|extended data|source data)\s+)?(fig(?:ure)?s?|table|scheme|chart|box|plate|graphic|video|movie)\.?\s*(S?\d+[A-Za-z]?(?:\s*[–\-]\s*\d+)?|[IVX]{1,4})\b\s*([.:|–—]|\s|$)/i;
  const SHOWS = /\b(?:shows?|showed|illustrates?|depicts?|presents?|summari[sz]es?|compares?|indicates?|demonstrates?|reveals?|lists?|provides?|displays?|gives?)\b/i;

  /* A caption starts a block with its label; it is told from a body sentence
     that begins "Figure 2 shows" by the label being bold, the block being set
     smaller than the body, or the separator being a bar, colon or full stop
     followed by a capital. */
  function captionStart(b, f, bodySize) {
    const m = CAPTION_RE.exec(f.text);
    if (!m) return null;
    const firstPart = b.lines[0].parts.find(p => p.str.trim());
    // when fonts are known only by id, a label in another font than the legend after it stands for bold
    const restPart = firstPart && b.lines[0].parts.find(q => q.str.trim() && q.font !== firstPart.font && nsLen(q.str) >= 4);
    const labelBold = !!(firstPart && (firstPart.bold || (!realFontName(firstPart.font) && restPart && b.lines[0].parts.indexOf(restPart) > 0)));
    const sep = m[4] || ' ';
    const after = f.text.slice(m[0].length);
    const strongSep = /[|:–—]/.test(sep) || (sep === '.' && /^\s*(?:\p{Lu}|\(\p{L}{1,2}\)|\p{Ll}{1,4}\p{Lu})/u.test(after));
    const small = f.size < bodySize * 0.985;
    const cap = /^(?:supplementary|supplemental|extended data|source data|table|scheme)/i.test(f.text);
    // a label in capitals ("FIGURE 2", "TABLE 1") needs no bold to be one
    const capsLabel = /^(?:FIGURE|FIG\.?|TABLE|SCHEME)\b/.test(f.text);
    const ok = sep === '|' || (capsLabel && (strongSep || sep === ' '))
      || (labelBold && (strongSep || cap || sep === ' '))
      || (small && (strongSep || cap || sep === ' '))
      || (strongSep && !SHOWS.test(after.slice(0, 40)) && b.lines.length <= 14 && f.size <= bodySize * 1.02);
    if (!ok) return null;
    const label = f.text.slice(0, m[0].length).replace(/[.:|–—\s]+$/, '').replace(/\s+/g, ' ');
    return {kind: /table/i.test(m[2]) ? 'table' : 'figure', label};
  }

  /* A heading is a short block that is a known section name, a numbered title,
     or set apart by size, weight or capitals, and does not end like a sentence. */
  function headingOf(b, f, bodySize, state, ctx) {
    if (f.nLines > 3 || f.text.length > 200 || f.nWords > 24 || f.nWords < 1) return null;
    const t = f.text;
    const name = headingName(t);
    const kind = HEAD_KIND.get(name) || null;
    const style = {size: f.size, bold: f.bold, caps: f.allCaps};
    if (kind && f.nWords <= 8) return Object.assign({kind, text: t.replace(/[\s.:]+$/, ''), strong: true, name}, style);
    if (state === 'refs' || state === 'supp' || state === 'front') return null;
    if (/^[\d\s.,;:()\-–]+$/.test(t)) return null;
    // a bold sentence-style title that closes with a full stop ("Structural Modeling.") is a heading too
    const idStyled = !realFontName((b.lines[0].parts.find(q => q.str.trim()) || {}).font) && ctx && ctx.domFont && b.lines.every(l => soleFont(l) && soleFont(l) === soleFont(b.lines[0])) && fontKey(soleFont(b.lines[0])) !== fontKey(ctx.bodyFont || '')
      && ctx.fontWidth && ctx.fontWidth.get(soleFont(b.lines[0])) >= 0.94 * (ctx.fontWidth.get(ctx.bodyFont) || 0);
    const boldTitle = (f.bold || idStyled) && f.nWords <= 14 && f.nLines <= 2 && /^\p{Lu}/u.test(t) && !/\.\s+\p{Lu}/u.test(t.slice(0, -1));
    if (TERMINAL.test(t) && !/\)$/.test(t) && !boldTitle) return null;
    if (/[,;:]$/.test(t)) return null;
    // a heading may open with a gene or molecule name in mixed case ("msDNA", "mRNA", "eIF4E")
    if (!/^[\p{Lu}\d]/u.test(t) && !/^\p{Ll}{1,4}\p{Lu}[\p{L}\d]*\b/u.test(t)) return null;
    if (/^\s*[(\[]?[a-z]\)/.test(t)) return null;
    if (CAPTION_RE.test(t) && !f.allCaps) return null;
    if (t.replace(/[^\p{L}]/gu, '').length < 3) return null;
    // panel letters and axis labels ("A B D", "E F") are not a heading
    if (!/\p{L}{3}/u.test(t)) return null;
    const numbered = NUMBERED.test(t);
    const bigger = f.size >= bodySize * 1.12;
    const mk = extra => Object.assign({kind: null, text: t.replace(/[\s.]+$/, ''), name}, style, extra);
    if (numbered && f.nLines <= 2 && f.nWords <= 14 && f.size >= bodySize * 0.95 && (f.bold || bigger || f.fill < 0.9) && /^\d{1,2}(?:\.\d{1,2}){0,3}[.)]?\s+\p{Lu}\p{Ll}/u.test(t)) return mk({numbered: true});
    if (bigger && !(f.lowerRatio > 0.97 && f.nWords > 12)) return mk({bigger: true});
    if (f.bold && f.size >= bodySize * 0.95 && f.nLines <= 2 && f.nWords <= 14 && f.nChars >= 4) return mk({boldLine: true});
    if (f.allCaps && f.nLines <= 2 && f.nWords <= 9 && f.size >= bodySize * 0.95 && f.nChars >= 5) return mk({capsLine: true});
    // set in another typeface than the body (a sans heading over serif text), without bold or a larger size
    const lead = b.lines[0].parts.find(q => q.str.trim()) || {};
    const fam = lead.family;
    // another typeface by name (SansSerif over Roman) when the names are real, else by pdf.js's generic family
    const byName = ctx && ctx.bodyFont && realFontName(lead.font) && realFontName(ctx.bodyFont) && fontBase(lead.font) !== fontBase(ctx.bodyFont);
    const byFamily = fam && ctx && ctx.bodyFamily && fam !== ctx.bodyFamily && !(realFontName(lead.font) && ctx.bodyFont && realFontName(ctx.bodyFont));
    // when the fonts are known only by id (pdf.js before the page is rendered): a line wholly in another font
    // than the body's at its size, not a narrower (italic) cut
    const byId = !realFontName(lead.font) && ctx && ctx.domFont && b.lines.every(l => soleFont(l) === lead.font) && ctx.bodyFont && fontKey(lead.font) !== fontKey(ctx.bodyFont) && (!ctx.domFont.get(sizeKey(f.size)) || fontKey(lead.font) !== ctx.domFont.get(sizeKey(f.size)) || Math.abs(f.size - bodySize) > 0.3)
      && ctx.fontWidth && ctx.fontWidth.get(lead.font) >= 0.94 * (ctx.fontWidth.get(ctx.bodyFont) || 0) && f.nWords <= 14 && f.nLines <= 2 && /^[\p{Lu}\d]/u.test(t)
      && f.size >= bodySize * 0.95 && f.nChars >= 8 && /\p{Ll}{3}/u.test(t) && !/\d\s+\d/.test(t);
    if (byId) return mk({typeface: true});
    if ((byName || byFamily) && f.nLines <= 3 && f.nWords <= 24 && f.size >= bodySize * 0.95 && f.nChars >= 8 && b.lines.every(l => l.parts.every(q => nsLen(q.str) <= 2 || fontKey(q.font) === fontKey(lead.font) || (!byName && q.family === fam)))) return mk({typeface: true});
    return null;
  }

  function equationOf(b, f, bodySize) {
    if (f.nLines > 5 || f.size < bodySize * 0.85) return null;
    const last = b.lines[b.lines.length - 1];
    const lastCell = last.cells[last.cells.length - 1].plain.trim();
    const eqNo = last.cells.length >= 2 && /^\(\s*\d+[a-z]?\s*\)$/.test(lastCell);
    const toks = words(f.text);
    if (toks.length < 2 && !eqNo) return null;
    const mathy = toks.filter(w => w.length <= 2 || /^[^\p{L}]+$/u.test(w)).length / Math.max(1, toks.length);
    if (eqNo && f.wordLikeRatio < 0.6) return 'equation number at the right margin';
    if (f.symRatio >= 0.12 && f.wordLikeRatio < 0.4 && mathy >= 0.5) return 'symbol-heavy line';
    if (/=/.test(f.text) && f.wordLikeRatio < 0.3 && mathy >= 0.6 && toks.length >= 3 && f.nLines <= 3) return 'formula';
    return null;
  }

  function isProse(b, f, bodySize) {
    if (f.nLines >= 2) return f.fill >= 0.45 && f.nWords / f.nLines >= 3.5 && f.lowerRatio >= 0.5 && f.wordLikeRatio >= 0.35;
    return f.nWords >= 5 && f.lowerRatio >= 0.55 && f.wordLikeRatio >= 0.4 && f.terminal && Math.abs(f.size - bodySize) <= Math.max(1, bodySize * 0.12);
  }

  const REF_MARKER = /^\s*(?:\[\d{1,3}\]\s*|\d{1,3}\.\s+)\S/;
  const REF_AUTHORS = /^\s*(?:\p{Lu}\.\s?)+\p{Lu}[\p{L}'\u2019-]+(?:,|\s+et al)/u;
  const INITIALS = String.raw`(?:\p{Lu}\.?(?=[\s,;.]|$)\s?){1,4}`;
  const REF_START = new RegExp(String.raw`^\s*(?:\[?\d{1,3}[\].)]?\s+)?(?:\p{Lu}[\p{L}'\u2019\-]+,?\s*${INITIALS}|\p{Lu}[\p{L}'\u2019\-]+\s+\p{Lu}{1,3}[,.\s]|\p{Lu}\.\s?(?:\p{Lu}\.\s?)*\p{Lu}[\p{L}'\u2019\-]+)`, 'u');
  function refLike(text) {
    let score = 0;
    if (REF_START.test(text)) score++;
    if (/\b(?:19|20)\d{2}[a-z]?\b/.test(text)) score++;
    if (/\bdoi\b|\bet al\b|\b\d{1,4}\s*[:,]\s*\d{1,5}\s*[\u2013\-]\s*\d{1,5}\b|\b\d{2,4}\s*\(\d{1,3}\)\s*[:,]\s*\d|\bpp?\.\s*\d+|\bvol\.?\s*\d+|\b[A-Z][a-z]*\.\s+(?:[A-Z][a-z]*\.\s+)*\d{1,4}[,:]\s*\d/.test(text)) score++;
    if (/(?:\((?:19|20)\d{2}\)\.?|\b(?:19|20)\d{2};[\d():\u2013\-]+\.?|\u2013\s?\d{1,5}\.?|doi:\s?\S+|https?:\/\/\S+)\s*$/.test(text)) score++;
    return score >= 3;
  }

  /* References come as one block per column or per gap; split into entries by
     numeric markers or, failing that, by hanging indent and the author pattern. */
  function splitRefs(lines) {
    if (!lines.length) return [];
    const marker = l => /^\s*(?:\[\d{1,3}\]|\d{1,3}\.\s|\d{1,3}\s+(?=\p{Lu}))/u.test(l.text);
    const nm = lines.filter(marker).length;
    const entries = [];
    let cur = null;
    const minX = Math.min(...lines.map(l => l.x0));
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i], prev = lines[i - 1];
      let start = false;
      if (!cur) start = true;
      else if (nm >= lines.length * 0.3) start = marker(l);
      else {
        const flush = l.x0 <= minX + 0.6 * l.size;
        const prevIndented = prev.x0 > minX + 0.6 * prev.size;
        const closes = /[.\d)\]]\s*$/.test(prev.text);
        const gap = l.baseline - prev.baseline > 1.35 * (l.typPitch || l.size * 1.2);
        start = gap || (flush && (prevIndented || (closes && REF_START.test(l.text))));
      }
      if (start) { cur = {lines: [l]}; entries.push(cur); } else cur.lines.push(l);
    }
    return entries;
  }

  /* A "sentence" that is labels and numbers off a figure or a table: a sentence of a paper has
     function words; "B. fragilis B. comes 50 100 P. dorei 1,877 Phocaeicola 270" does not. */
  const FUNCTION_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'to', 'in', 'is', 'was', 'were', 'are', 'be', 'been', 'with', 'for', 'by', 'that', 'on', 'as', 'at',
    'from', 'this', 'these', 'which', 'we', 'it', 'its', 'or', 'not', 'but', 'than', 'into', 'between', 'both', 'each', 'all', 'has', 'have', 'had', 'can', 'may', 'also', 'our', 'their', 'when', 'while', 'after', 'under', 'using', 'used', 'show', 'shows', 'shown']);
  function figureSoup(text) {
    const ws = words(text);
    if (ws.length < 6) return null;
    const fw = ws.filter(w => FUNCTION_WORDS.has(w.toLowerCase().replace(/[^\p{L}]/gu, ''))).length;
    const shortOrNum = ws.filter(w => /\d/.test(w) || w.replace(/[^\p{L}]/gu, '').length <= 2).length;
    if (fw / ws.length < 0.05 && shortOrNum / ws.length >= 0.35) return 'labels and numbers without a sentence (figure or table text)';
    return null;
  }

  /* ---------------------------------------------------------- assemble */

  const FRONT_PATTERNS = [
    [/^(?:received|accepted|published|revised|available online|first published|online first|submitted|editor)\b|\b(?:received|accepted)\s*:/i, 'dates'],
    [/^(?:key\s*words?|keywords?|index terms|subject terms|abbreviations)\b/i, 'keywords'],
    [/(?:^|\s)(?:\*|∗)?\s*(?:corresponding author|correspondence|e-?mail|address correspondence|to whom correspondence|contributed equally|equal contribution|present address)/i, 'correspondence'],
    [/\b(?:university|université|universität|institute|department|laborator(?:y|ies)|school of|hospital|college|centre|center|faculty|academy|cnrs|inserm|max planck|national)\b/i, 'affiliations'],
  ];
  /* Front matter that can stand anywhere on the first two pages (at a column foot, in a sidebar, in a
     box under the text): what no paragraph of a paper says. In small type the weaker signs suffice. */
  const FRONT_STRONG = [
    [/^\s*(?:received|accepted|revised|published(?: online)?|editor|edited by|handling editor|reviewed by)\s*:?\s*(?:\d|\p{Lu}\p{Ll}+ \d|\d{1,2} \p{Lu})/u, 'dates'],
    [/\b(?:received|revised|accepted)\s*:?\s*\p{Lu}?\p{Ll}* ?\d{1,2},? \d{4}.{0,80}\b(?:accepted|published|revised)\b/iu, 'dates'],
    [/[\u00A9\u00AA]\s*(?:the author|\d{4})|\bcreative commons\b|this is an open access article|\bopen access article distributed\b|\bcc[- ]by(?:[- ]n[cd])*\b|licen[cs]ed under|all rights reserved|for (?:commercial re-?use|permissions),? please|reprints and (?:translation|permission)/i, 'licence or copyright'],
    [/^\s*(?:check for updates|crossmark)\s*$/i, 'stamp'],
    [/(?:^|\s)[*\u2020\u2021\u00A7]?\s*(?:these authors contributed equally|contributed equally to this work|equal contribution|corresponding authors?\b|to whom correspondence should be addressed|correspondence(?: and requests for materials)? (?:should be addressed|may also be addressed|to)|present address|lead contact)/i, 'correspondence'],
    [/\bgrant\/award (?:number|no)|^\s*funding information\b/i, 'funding'],
  ];
  const FRONT_SMALL = [
    [/(?:^|[\s\d\u00B9\u00B2\u00B3\u2070-\u2079*\u2020\u2021])(?:department|dept\.?|institute|school|faculty|division|laboratory|center|centre|college|university|hospital)\s+(?:of|for)\b.{0,160}\b(?:usa|uk|china|japan|germany|france|korea|india|canada|australia|israel|spain|italy|switzerland|netherlands|sweden|denmark|[A-Z]{2}\s+\d{5}|\d{4,6})\b/i, 'affiliations'],
    [/\S+@\S+\.(?:edu|com|org|net|ac\.\w+|edu\.\w+|gov|de|fr|uk|cn|jp|kr|il|ch|nl|se|dk|it|es|ca|au)\b/i, 'correspondence'],
    [/^\s*(?:\*\s*)?(?:correspondence|e-?mail|contact)\s*:/i, 'correspondence'],
  ];
  function frontBoilerplate(f, bodySize) {
    for (const [re, why] of FRONT_STRONG) if (re.test(f.text)) return why;
    if (f.size < bodySize * 0.95) for (const [re, why] of FRONT_SMALL) if (re.test(f.text)) return why;
    return null;
  }

  function frontReason(f) {
    for (const [re, why] of FRONT_PATTERNS) if (re.test(f.text)) return why;
    return 'authors or other front matter';
  }

  /* A bold prefix on the first line followed by regular text: a run-in heading
     ("Strain construction. E. coli strains were ..."). */
  const sizeKey = size => Math.round(size * 2) / 2;
  // a font name without its subset tag and glyph-variant suffix: NMIAMH+AdvOT1ef757c0+fb -> AdvOT1ef757c0
  const fontKey = f => String(f || '').replace(/^[A-Z]{6}\+/, '').replace(/\+[0-9a-z]+$/i, '');
  // the typeface of a font name without its weight and slant: SabonLTStd-Roman -> SabonLTStd
  const fontBase = f => { let t = fontKey(f), prev; do { prev = t; t = t.replace(/[-,_ ](?:bold|italic|oblique|roman|regular|semibold|medium|light|black|it|bd|bi|b|i|obl|ital)$/i, ''); } while (t !== prev); return t; };
  const realFontName = f => { const t = fontKey(f); return /[A-Za-z]{4,}/.test(t) && !/^g_d\d+_f\d+$/.test(t) && !/^[A-Za-z]{2,8}[0-9a-f]{8}$/.test(t); };
  function runInHeading(b, allowLower, ctx) {
    const ps = b.lines[0].parts.filter(p => p.str.trim());
    if (!ps.length) return null;
    // set apart from the body type: bold, or a different font from the one the paper uses
    // at this size (when the font names say nothing, a heading in another face still shows)
    const dom = ctx && ctx.domFont;
    // with fonts known only by id, a heading in another generic family (sans over serif) shows by that
    const idOnly = !realFontName(ps[0].font);
    const styled = (p, k) => p.bold || (!p.italic && dom && dom.get(sizeKey(p.size)) && fontKey(p.font) !== dom.get(sizeKey(p.size)) && (k > 0 || nsLen(p.str) > 3))
      || (idOnly && ctx && ctx.domFamily && p.family && ctx.domFamily.get(sizeKey(p.size)) && p.family !== ctx.domFamily.get(sizeKey(p.size)) && (k > 0 || nsLen(p.str) > 3));
    let i = 0; while (i < ps.length && styled(ps[i], i)) i++;
    if (i === 0 || i === ps.length) return null;
    // set apart by family alone, it must be closed like a run-in heading ("Phage strains. Genes ...")
    if (idOnly && !ps.slice(0, i).some(p => p.bold || (dom && dom.get(sizeKey(p.size)) && fontKey(p.font) !== dom.get(sizeKey(p.size)) && p.family === (ctx.domFamily && ctx.domFamily.get(sizeKey(p.size)))))
      && !/[.:]\s*$/.test(ps[i - 1].str) && !/^\s*[.:\u2014]/.test(ps[i].str)) return null;
    if (ps.slice(i).some((p, k) => styled(p, 1) && nsLen(p.str) > 12)) return null;
    const prefix = joinParts(ps.slice(0, i), false).text.replace(/\s+/g, ' ').trim();
    const known = HEAD_KIND.get(headingName(prefix)) || null;
    const nw = words(prefix).length;
    if (!prefix || nw > 12 || prefix.length > 110) return null;
    if (!known && (!/\p{Ll}{3}/u.test(prefix) || (nw < 2 && prefix.length < 9))) return null;
    if (!known && !/[.:—]\s*$/.test(prefix) && nw > 8) return null;
    if ((!allowLower && !/^[\p{Lu}\d]/u.test(prefix)) || CAPTION_RE.test(prefix)) return null;
    return {text: prefix.replace(/[\s.:—]+$/, ''), kind: known, parts: ps.slice(0, i)};
  }

  /* The block's lines with the first line's run-in prefix cut away, and the full stop or
     colon that closed it. */
  function restLines(b, run) {
    const first = b.lines[0];
    const drop = new Set(run.parts);
    let stripped = false;
    const keep = parts => parts.filter(p => !drop.has(p)).map(p => {
      if (stripped) return p;
      stripped = true;
      const m = /^[\s.:\u2014]+/.exec(p.str);
      if (!m || m[0].length >= p.str.length) return p;
      const cut = m[0].length, frac = cut / p.str.length;
      return Object.assign({}, p, {str: p.str.slice(cut), x: p.x + p.w * frac, w: p.w * (1 - frac)});
    });
    const cells = first.cells.map(c => Object.assign({}, c, {parts: keep(c.parts)})).filter(c => c.parts.length);
    const parts = [].concat(...cells.map(c => c.parts));
    const rest = [];
    if (parts.length) rest.push(Object.assign({}, first, {parts, cells, text: joinParts(parts, true).text}));
    return rest.concat(b.lines.slice(1));
  }

  const sentenceless = (lines, ctx) => buildStream(lines, ctx.lex, ctx.notes.hyphenation).toks.map(t => t.ch).join('').replace(/\s+/g, ' ').trim();

  function assemble(byIndex, blocks, ctx) {
    const T = ctx.skipped, log = ctx.log, bodySize = ctx.bodySize;
    const out = {title: '', captions: [], references: [], footnotes: [], sections: []};
    const note = (page, kind, reason, text, b) => log.push({page, kind, reason, text: String(text).slice(0, 90), col: b ? b.col : undefined, y: b && b.lines ? round1(b.lines[0].top) : undefined, why: b ? b.why : undefined});
    const feats = blocks.map(b => featuresOf(b, bodySize));

    // headingless reference lists: three reference-like blocks in a row
    const refRun = new Array(blocks.length).fill(false);
    {
      const cand = [];
      blocks.forEach((b, i) => { if (!b.lines.every(l => l.title || l.tab)) cand.push(i); });
      for (let k = 0; k < cand.length; k++) {
        const here = j => refLike(feats[j].text) && feats[j].nWords >= 6;
        if (!here(cand[k])) continue;
        if (cand.slice(k, k + 5).filter(here).length >= 3) refRun[cand[k]] = true;
      }
    }

    const seenKept = new Set();
    const contRun = new Map();
    let state = ctx.titleFound ? 'front' : 'body';
    let section = null, pend = null, interposed = 0, capOpen = null, abstractExplicit = false, abstractStyle = null;
    const metaAbs = ctx.meta && ctx.meta.abstract ? clean(ctx.meta.abstract) : '';
    const sections = out.sections;

    const flush = () => {
      if (!pend) return;
      const para = pend; pend = null;
      if (!section) { section = {heading: '', level: 1, page: para.lines[0].page, paragraphs: [], kind: state === 'back' ? 'back' : 'body', info: {}}; sections.push(section); }
      const sents = sentencesOf(para.lines, ctx.lex, ctx.notes.hyphenation, T.other).filter(se => {
        const why = figureSoup(se.text);
        if (why) T.other.push({text: se.text, page: se.page, reason: why});
        return !why;
      });
      if (sents.length) section.paragraphs.push({sentences: sents});
    };
    const startSection = (heading, info, kind, page) => {
      flush();
      section = {heading, level: 1, page, paragraphs: [], kind, info: info || {}};
      sections.push(section);
      interposed = 0;
    };
    const addBody = (b, f) => {
      const first = b.lines[0];
      seenKept.add(b.group);
      if (pend) {
        const prevLast = pend.lines[pend.lines.length - 1];
        const prevText = pend.lines.slice(-2).map(l => l.text).join(' ');
        const crossing = prevLast.group !== first.group || interposed > 0;
        const open = !TERMINAL.test(prevText) || /[,;:\-–—]$/.test(prevText);
        const indented = first.x0 - first.colLeft > 0.9 * first.size;
        const endsAbbrev = /(?:\bet al|\bFigs?|\be\.g|\bi\.e|\bvs|\bca|\bcf|\bapprox|\bspp?)\.$/.test(prevText);
        // a block that starts in lower case or with a number cannot start a paragraph when the text before it
        // never closed its sentence, wherever the break between them came from
        const continues = open && /^[\p{Ll}\d]/u.test(f.text);
        // a sentence carries on in its own type: a legend's tail in smaller print is not its continuation
        const sameType = Math.abs(median(pend.lines.map(l => l.size)) - f.size) <= 1;
        const refNumber = /\b(?:Figs?|Tables?|Eqs?|Refs?|No|Nos)\.$/.test(prevText) && /^\d/.test(f.text);
        if (sameType && ((crossing && !indented && (open || f.startsLower || (endsAbbrev && /^\d/.test(f.text)))) || continues || refNumber)) { pend.lines.push(...b.lines); interposed = 0; return; }
      }
      flush();
      pend = {lines: b.lines.slice()};
      interposed = 0;
    };
    // front matter, filed line by line when its lines are of different kinds (authors, then affiliations, then dates)
    const frontSkip = (b, f) => {
      const groups = [];
      for (const l of b.lines) {
        const why = frontReason({text: l.text});
        const g = groups[groups.length - 1];
        if (g && (g.why === why || why === 'authors or other front matter')) g.lines.push(l); else groups.push({why, lines: [l]});
      }
      if (groups.length === 1) groups[0].why = frontReason(f);
      for (const g of groups) {
        const text = g.lines.map(l => l.text).join(' ');
        T.other.push({text, page: b.page, reason: 'front matter: ' + g.why});
        note(b.page, 'front', g.why, text, b);
      }
      interposed++;
    };
    const skipBlock = (b, f, bucket, kind, reason) => {
      T[bucket].push({text: f.text, page: b.page, reason});
      note(b.page, kind, reason, f.text, b);
      interposed++;
    };
    const refEntries = (b, f, why) => {
      const entries = splitRefs(b.lines);
      entries.forEach((e, k) => {
        const text = sentenceless(e.lines, ctx);
        const prev = out.references[out.references.length - 1];
        const startsEntry = REF_MARKER.test(text) || REF_START.test(text);
        // the tail of an entry that ran over a column or page, or whose continuation lines came as a block of their own
        const complete = /(?:\(\s*(?:19|20)\d{2}[a-z]?\s*\)|\b(?:19|20)\d{2}[a-z]?|\d+\s*[\u2013-]\s*\d+|doi\S*|https?:\/\S+|\bpp?\.\s*\d+)\W*$/i.test(prev ? prev.text : '');
        const numbered = !!prev && REF_MARKER.test(prev.text);
        if (k === 0 && prev && !startsEntry && (numbered || !complete || text.length < 60)) prev.text += ' ' + text;
        else out.references.push({text, page: e.lines[0].page});
      });
      note(b.page, 'reference', why, f.text, b);
      interposed++;
    };
    const acceptHeading = h => {
      if (state === 'front' || state === 'frontskip') return !!h.kind && h.kind !== 'back' && h.kind !== 'frontskip' || (h.kind === 'back' && false);
      if (state === 'refs' || state === 'supp') return !!h.kind && h.kind !== 'abstract' && h.kind !== 'frontskip';
      if (state === 'abstract') return !!h.kind || h.numbered || h.bigger || h.capsLine;
      if (state === 'back') return !!h.kind || h.numbered || h.bigger;
      return true;
    };
    /* Prose that the shape tests miss, decided in the paper's running type (a size the paper sets text
       in, its typeface, not bold): a paragraph dense with concentrations and formulas ("11.64 g L-1
       K2HPO4, 4.89 g L-1 NaH2PO4") that still opens like a sentence, and a paragraph's first line on
       its own whose sentence carries on in a later block that starts in lower case. */
    const inBodyType = (b, f) => {
      if (f.bold || b.lines.some(l => l.tab) || !ctx.textSize(f.size)) return false;
      const lead = b.lines[0].parts.find(q => q.str.trim()) || {};
      return !(ctx.bodyFamily && lead.family && lead.family !== ctx.bodyFamily);
    };
    const opensLikeProse = t => { const w = words(t).slice(0, 8); return w.length >= 5 && w.filter(x => /^\p{L}[\p{Ll}'\u2019-]{1,}[,;:]?$/u.test(x)).length >= 4 && /^[\p{Lu}(]/u.test(t); };
    const proseInBodyType = bi => {
      const b = blocks[bi], f = feats[bi];
      if (!inBodyType(b, f) || !opensLikeProse(f.text)) return false;
      if (f.nLines >= 2 && f.fill >= 0.6) return true;
      if (f.terminal || f.nWords < 6 || f.fill < 0.7) return false;
      for (let j = bi + 1; j < Math.min(blocks.length, bi + 40); j++) {
        if (blocks[j].page > b.page + 1) break;
        if (!isProse(blocks[j], feats[j], bodySize) || !inBodyType(blocks[j], feats[j])) continue;
        return /^\p{Ll}/u.test(feats[j].text);
      }
      return false;
    };
    // a heading that is not a known section name needs prose beside it, or it is a figure label
    const proseAt = (j, page) => j >= 0 && j < blocks.length && blocks[j].page === page && isProse(blocks[j], feats[j], bodySize);
    const supported = bi => proseAt(bi + 1, blocks[bi].page) || proseAt(bi - 1, blocks[bi].page) || (bi + 1 < blocks.length && blocks[bi + 1].page === blocks[bi].page && !!headingOf(blocks[bi + 1], feats[bi + 1], bodySize, 'body', ctx));

    let inForm = false;
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi], f = feats[bi];
      if (ctx.formPage != null && b.page >= ctx.formPage && state !== 'refs') {
        // a form is back matter: its subheadings ("Statistics", "Methodology") open back sections only
        if (!inForm) { inForm = true; startSection('Reporting Summary', {name: 'reportingsummary'}, 'back', b.page); state = 'back'; }
        const hf = headingOf(b, f, bodySize, 'back', ctx);
        if (hf && hf.kind !== 'refs' && hf.kind !== 'supp' && f.nWords <= 12) { startSection(hf.text, hf, 'back', b.page); note(b.page, 'heading', 'reporting-summary heading', f.text, b); continue; }
        if (!isProse(b, f, bodySize)) { skipBlock(b, f, 'other', 'other', 'reporting summary form'); continue; }
        note(b.page, 'back', 'reporting summary', f.text, b);
        addBody(b, f);
        continue;
      }
      if (b.lines.every(l => l.title)) { out.title = (out.title ? out.title + ' ' : '') + f.text; note(b.page, 'title', 'title block', f.text, b); continue; }
      if (b.lines.every(l => l.tab)) { skipBlock(b, f, 'tables', 'table', 'aligned short cells'); continue; }

      const cap = captionStart(b, f, bodySize);
      if (cap) {
        seenKept.add(b.group);
        out.captions.push({kind: cap.kind, label: cap.label, text: f.text, page: b.page});
        note(b.page, 'caption', cap.label, f.text, b);
        capOpen = {size: f.size, group: b.group, page: b.page, col: b.lines[0].col, startTop: b.lines[0].top, x0: b.lines[0].x0, last: b.lines[b.lines.length - 1].baseline, labelOnly: f.nWords <= 4};
        interposed++;
        continue;
      }
      if (capOpen && capOpen.labelOnly && capOpen.group === b.group && b.lines[0].baseline - capOpen.last < 2.2 * (b.lines[0].typPitch || 12)) {
        // a caption whose label stands alone on its line carries on in the block after it
        const c = out.captions[out.captions.length - 1];
        c.text += ' ' + f.text; capOpen.last = b.lines[b.lines.length - 1].baseline; capOpen.labelOnly = false; capOpen.size = f.size;
        note(b.page, 'caption', 'text of ' + c.label, f.text, b);
        continue;
      }
      if (capOpen && capOpen.page === b.page && f.size < bodySize * 0.97 && f.size <= capOpen.size + 0.3 && Math.abs(f.size - capOpen.size) <= 2 && (!b.lines[0].bold || b.lines[0].parts.some(q => q.boldGuess))) {
        const l0 = b.lines[0];
        const pitch = l0.typPitch || 12;
        // under the caption, from the same left edge, set in the same small type (a title in bold, then its panels)
        const below = l0.baseline > capOpen.last && l0.baseline - capOpen.last < 2.6 * pitch && Math.abs(l0.x0 - capOpen.x0) < 1.5 * f.size;
        // a caption set over two columns carries on at the top of the next one
        const nextColumn = capOpen.group !== b.group && l0.col > capOpen.col && Math.abs(l0.top - capOpen.startTop) < 4;
        if (below || nextColumn) {
          const c = out.captions[out.captions.length - 1];
          c.text += ' ' + f.text; capOpen.last = b.lines[b.lines.length - 1].baseline; capOpen.group = b.group; capOpen.col = l0.col; capOpen.size = Math.min(capOpen.size, f.size);
          note(b.page, 'caption', 'continuation of ' + c.label, f.text, b);
          continue;
        }
      }
      // a legend's panels set as blocks of their own ("(A) Schematic ...", "b, Close-up ...") in the legend's type
      if (capOpen && capOpen.page === b.page && /^\s*(?:\(\s*[A-Ha-h](?:[–,-]\s*[A-Ha-h])?\s*\)|[A-Ha-h](?:[–-][A-Ha-h])?,)\s+\S/.test(f.text) && Math.abs(f.size - capOpen.size) <= 0.5 && f.size < bodySize * 0.97) {
        const c = out.captions[out.captions.length - 1];
        c.text += ' ' + f.text; capOpen.last = b.lines[b.lines.length - 1].baseline; capOpen.group = b.group; capOpen.col = b.lines[0].col;
        note(b.page, 'caption', 'panel of ' + c.label, f.text, b);
        continue;
      }
      if (capOpen && capOpen.page !== b.page) capOpen = null;

      if (!contRun.has(b) && state !== 'front' && state !== 'frontskip' && state !== 'refs' && !HEAD_KIND.get(headingName(f.text))) {
        const eqEarly = equationOf(b, f, bodySize);
        if (eqEarly) { skipBlock(b, f, 'equations', 'equation', eqEarly); continue; }
      }
      const preRun = contRun.get(b);
      if (preRun) {
        const rest = restLines(b, preRun);
        if (rest.length) { pend = {lines: rest}; interposed = 0; seenKept.add(b.group); }
        note(b.page, 'heading', 'second line of a bold run-in heading', preRun.text, b);
        continue;
      }
      const head = headingOf(b, f, bodySize, state, ctx);
      if (head && head.boldLine) {
        // a bold heading sentence can run on into the next block's first line
        const nb = blocks[bi + 1];
        if (nb && nb.group === b.group && nb.lines[0].baseline - b.lines[b.lines.length - 1].baseline < 1.6 * (nb.lines[0].typPitch || 12)) {
          const run = runInHeading(nb, true, ctx);
          if (run && !run.kind) { head.text += ' ' + run.text; head.runIn = true; contRun.set(nb, run); }
        }
      }
      if (head && acceptHeading(head) && (head.kind || supported(bi))) {
        const kind = head.kind;
        if (kind === 'abstract') {
          startSection('Abstract', {name: 'abstract'}, 'abstract', b.page);
          state = 'abstract'; abstractExplicit = true; abstractStyle = null;
          note(b.page, 'heading', 'abstract heading', f.text, b); continue;
        }
        if (kind === 'frontskip') {
          flush(); state = 'frontskip'; section = null;
          T.other.push({text: f.text, page: b.page, reason: 'front matter: ' + head.text});
          note(b.page, 'front', 'skipped heading', f.text, b); continue;
        }
        if (kind === 'refs') { flush(); state = 'refs'; section = null; note(b.page, 'heading', 'references heading', f.text, b); continue; }
        if (kind === 'supp') {
          flush(); state = 'supp'; section = null;
          T.other.push({text: f.text, page: b.page, reason: 'supplement'});
          note(b.page, 'heading', 'supplement heading', f.text, b); continue;
        }
        if (kind === 'back') { startSection(head.text, head, 'back', b.page); state = 'back'; note(b.page, 'heading', 'back-matter heading', f.text, b); continue; }
        startSection(head.text, head, 'body', b.page);
        state = 'body';
        note(b.page, 'heading', head.numbered ? 'numbered heading' : head.bigger ? 'larger type' : head.boldLine ? 'bold line' : head.capsLine ? 'capitals' : 'known section name', f.text, b);
        continue;
      }

      if (state === 'frontskip') { skipBlock(b, f, 'other', 'other', 'front matter summary'); continue; }
      if (state === 'supp') { skipBlock(b, f, 'other', 'other', 'supplement file list or notes'); continue; }
      if (state === 'refs' || (state === 'body' && f.small)) {
        // the licence box and the dates repeated on a last page are not a reference or a sentence
        const why = frontBoilerplate(f, bodySize);
        if (why === 'licence or copyright' || why === 'dates' || why === 'stamp') { skipBlock(b, f, 'other', 'other', 'boilerplate: ' + why); continue; }
      }
      if (state === 'refs') { refEntries(b, f, 'in the reference list'); continue; }
      if (refRun[bi] && state !== 'front') {
        flush(); state = 'refs'; section = null;
        refEntries(b, f, 'run of reference-like blocks'); continue;
      }

      const eq = equationOf(b, f, bodySize);
      if (eq) { skipBlock(b, f, 'equations', 'equation', eq); continue; }

      if (state === 'front') {
        const proseStart = isProse(b, f, bodySize) && f.nChars >= 220 && f.capWordRatio < 0.45 && !f.startsLower;
        const matches = metaAbs && dice(f.text.slice(0, 200), metaAbs.slice(0, 200)) > 0.6;
        if (proseStart || matches) {
          startSection('Abstract', {name: 'abstract'}, 'abstract', b.page);
          state = 'abstract'; abstractExplicit = false; abstractStyle = null;
          ctx.abstractReason = matches ? 'matches the item abstract' : 'first long prose block after the title';
        } else {
          frontSkip(b, f);
          continue;
        }
      }

      // front matter wherever it stands on the first two pages: in the body's way it would thread
      // affiliations or a licence into a sentence that runs past it
      if (b.page <= ctx.firstPage + 1 && (state === 'body' || state === 'abstract')) {
        const why = frontBoilerplate(f, bodySize);
        if (why) { T.other.push({text: f.text, page: b.page, reason: 'front matter: ' + why}); note(b.page, 'front', why, f.text, b); interposed++; continue; }
      }
      // footnotes: small print low on the page that starts with a marker
      const first = b.lines[0];
      const pageH = byIndex[b.page] ? byIndex[b.page].height : 792;
      // a table's footnote: its letter glued to the note ("bSlopes were derived ..."), in small type
      if (f.size < bodySize * 0.97 && /^[a-h]\p{Lu}\p{Ll}{2,}/u.test(f.text) && (first.startsSup || b.lines[0].parts.find(q => q.str.trim()) && b.lines[0].parts.find(q => q.str.trim()).size < f.size - 0.5 || !/^[a-h]\p{Lu}{2}/u.test(f.text))) {
        out.footnotes.push({text: f.text, page: b.page});
        note(b.page, 'footnote', 'table footnote', f.text, b);
        interposed++;
        continue;
      }
      if (f.small && first.top > pageH * 0.5 && (first.startsSup || /^(?:[*†‡§¶]|\d{1,2}\s?\p{Lu}|[a-d]\s\p{Lu})/u.test(f.text))) {
        // on the first page this is the affiliation or correspondence note, not a footnote of the text
        const why = frontReason(f);
        if (b.page === ctx.firstPage && why !== 'authors or other front matter') {
          T.other.push({text: f.text, page: b.page, reason: 'front matter: ' + why});
          note(b.page, 'front', why, f.text, b);
          interposed++;
          continue;
        }
        out.footnotes.push({text: f.text, page: b.page});
        note(b.page, 'footnote', 'small print at the foot of the page', f.text, b);
        interposed++;
        continue;
      }

      // a contents list (STAR Methods): a run of short titles with no sentence among them
      if (b.lines.length >= 3 && !/[.!?]\s/.test(f.text) && b.lines.filter(l => l.chars <= 70 && !TERMINAL.test(l.text)).length >= 0.8 * b.lines.length && b.lines.filter(l => l.fill < 0.85).length >= 0.6 * b.lines.length && f.capWordRatio >= 0.12 && b.lines.every(l => /^\p{Lu}/u.test(l.text))) {
        skipBlock(b, f, 'other', 'other', 'a list of titles (contents)'); continue;
      }
      if (!isProse(b, f, bodySize) && !proseInBodyType(bi)) {
        skipBlock(b, f, 'other', 'other', f.small ? 'small text outside a paragraph (figure or table text)' : f.nWords <= 4 ? 'short fragment (figure label)' : 'not paragraph text');
        continue;
      }
      if (f.size < bodySize * 0.8 && f.nLines < 3 && !ctx.textSize(f.size)) { skipBlock(b, f, 'other', 'other', 'small print'); continue; }
      // a few lines in small type that never finish a sentence are labels in a figure
      if (f.small && !ctx.textSize(f.size) && f.nLines <= 3 && !f.terminal && !(pend && /^\p{Ll}/u.test(f.text) && Math.abs(median(pend.lines.map(l => l.size)) - f.size) <= 0.5)) { skipBlock(b, f, 'other', 'other', 'small text outside a paragraph (figure or table text)'); continue; }

      if (state === 'abstract') {
        if (/^(?:key\s*words?|keywords?|abbreviations|index terms)\b/i.test(f.text)) {
          T.other.push({text: f.text, page: b.page, reason: 'front matter: keywords'});
          note(b.page, 'front', 'keywords', f.text, b); continue;
        }
        const taken = (section ? section.paragraphs.length : 0) + (pend ? 1 : 0);
        const styleChanged = abstractStyle && (Math.abs(f.size - abstractStyle.size) > 0.6 || f.bold !== abstractStyle.bold);
        const crossesInto = pend && (pend.lines[pend.lines.length - 1].group !== first.group || interposed > 0) && !TERMINAL.test(pend.lines.slice(-2).map(l => l.text).join(' '));
        if (!crossesInto && ((!abstractExplicit && taken >= 1) || styleChanged)) {
          startSection('', {}, 'body', b.page);
          state = 'body';
        } else {
          if (!abstractStyle) abstractStyle = {size: f.size, bold: f.bold};
          note(b.page, 'abstract', ctx.abstractReason || 'abstract text', f.text, b);
          ctx.abstractReason = '';
          addBody(b, f);
          continue;
        }
      }

      // a bold run-in heading starts the paragraph ("Strain construction. E. coli ...")
      const run = (state === 'body' || state === 'back') ? runInHeading(b, false, ctx) : null;
      if (run) {
        flush();
        if (run.kind === 'refs') { state = 'refs'; section = null; note(b.page, 'heading', 'references run-in heading', f.text, b); continue; }
        const isBack = run.kind === 'back';
        if (isBack) state = 'back'; else if (state === 'back') state = 'body';
        section = {heading: run.text, level: 3, page: b.page, paragraphs: [], kind: isBack ? 'back' : 'body',
          info: {runIn: true, name: headingName(run.text), size: f.size, bold: true}};
        sections.push(section);
        note(b.page, 'heading', 'bold run-in heading', run.text, b);
        const rest = restLines(b, run);
        if (rest.length) { pend = {lines: rest}; note(b.page, 'body', 'paragraph after run-in heading', rest.map(l => l.text).join(' '), b); }
        interposed = 0;
        continue;
      }
      if (!section) startSection('', {}, state === 'back' ? 'back' : 'body', b.page);
      note(b.page, 'body', 'paragraph', f.text, b);
      addBody(b, f);
    }
    flush();
    out.sections = sections.filter(s => s.paragraphs.length || s.kind === 'abstract' || s.heading);
    return out;
  }

  /* ------------------------------------------------------------- title */

  function detectTitle(pg, bodySize, meta) {
    if (!pg) return false;
    // a section heading in large type ("1. Introduction", "RESULTS") is not a title
    const lines = pg.lines.filter(l => !l.tab && l.top < pg.height * 0.65 && !headKind(l.text) && !NUMBERED.test(l.text));
    if (!lines.length) return false;
    const metaTitle = meta && meta.title ? clean(meta.title) : '';
    let chosen = [];
    const maxSize = Math.max(...lines.filter(l => /\p{L}{3}/u.test(l.text) && l.chars >= 3).map(l => l.size), 0);
    const cands = lines.filter(l => l.size >= Math.max(bodySize * 1.12, maxSize * 0.85) && l.chars >= 3 && /\p{L}{3}/u.test(l.text));
    if (cands.length) {
      const bySize = new Map();
      for (const l of cands) { const k = Math.round(l.size * 2) / 2; if (!bySize.has(k)) bySize.set(k, []); bySize.get(k).push(l); }
      let best = null;
      for (const [k, ls] of bySize) {
        const chars = sum(ls.map(l => l.chars));
        const score = k * 1000 + chars;
        if (chars >= 12 && chars <= 400 && (!best || score > best.score)) best = {score, ls};
      }
      if (best) chosen = best.ls;
    }
    if (metaTitle && (!chosen.length || dice(chosen.map(l => l.text).join(' '), metaTitle) < 0.5)) {
      let bestRun = null;
      for (let i = 0; i < lines.length; i++) {
        let acc = '';
        for (let j = i; j < Math.min(lines.length, i + 5); j++) {
          if (Math.abs(lines[j].size - lines[i].size) > 0.6) break;
          acc += ' ' + lines[j].text;
          const s = dice(acc, metaTitle);
          if (!bestRun || s > bestRun.s) bestRun = {s, ls: lines.slice(i, j + 1)};
        }
      }
      if (bestRun && bestRun.s >= 0.7) chosen = bestRun.ls;
    }
    if (!chosen.length) return false;
    chosen.forEach(l => { l.title = true; });
    return true;
  }

  /* A heading set in capitals is not read letter by letter or shouted: "MATERIAL AND METHODS"
     becomes "Material and methods". Acronyms of up to four letters ("DNA") stay as they are. */
  function speakHeading(h) {
    const t = String(h || '');
    const letters = t.replace(/[^\p{L}]/gu, '');
    if (letters.length < 5 || letters !== letters.toUpperCase()) return t;
    let first = true;
    return t.replace(/\p{L}+/gu, w => {
      const keep = w.length <= 4 && !/^(?:AND|THE|FOR|WITH|OF|IN|ON|TO|OR|A|AN)$/.test(w) && w.length > 1;
      const out = keep ? w : (first ? w[0] + w.slice(1).toLowerCase() : w.toLowerCase());
      first = false;
      return out;
    });
  }

  /* ----------------------------------------------------------- structure */

  function bodyFontSize(pages) {
    const w = new Map();
    for (const pg of pages) for (const s of pg.segs) {
      if (s.skip || s.plain.length < 30) continue;
      const k = Math.round(s.size * 4) / 4;
      w.set(k, (w.get(k) || 0) + s.plain.replace(/[^\p{L}]/gu, '').length);
    }
    let best = 10, bw = -1;
    for (const [k, v] of w) if (v > bw) { best = k; bw = v; }
    return best;
  }

  /* Heading level: the numbering depth when there is one, a bold run-in is 3,
     otherwise the rank of the heading's style (larger, bold, capitals first),
     at most 3. */
  function assignLevels(sections) {
    const keyOf2 = s => { const i = s.info || {}; return [Math.round((i.size || 0) * 2) / 2, i.bold ? 1 : 0, i.caps ? 1 : 0]; };
    const keys = new Map();
    for (const s of sections) {
      if (!s.heading || s.kind === 'back' || s.kind === 'abstract') continue;
      if (s.info && s.info.runIn) { s.level = 3; continue; }
      const m = /^(\d{1,2}(?:\.\d{1,2}){0,3})[.)]?\s/.exec(s.heading);
      if (m) { s.level = Math.min(3, m[1].split('.').length); s.info.numberedLevel = true; continue; }
      const k = keyOf2(s);
      keys.set(k.join('|'), k);
    }
    const counts = new Map();
    for (const s of sections) {
      if (!s.heading || s.kind === 'back' || s.kind === 'abstract' || (s.info && (s.info.runIn || s.info.numberedLevel))) continue;
      const k = keyOf2(s).join('|');
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let entries = [...keys.entries()];
    if (entries.filter(e => counts.get(e[0]) >= 2).length >= 1) entries = entries.filter(e => counts.get(e[0]) >= 2);
    const ranked = entries.sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1] || b[1][2] - a[1][2]);
    for (const s of sections) {
      if (!s.heading || s.kind === 'back' || s.kind === 'abstract' || (s.info && (s.info.runIn || s.info.numberedLevel))) continue;
      const k = keyOf2(s);
      // the nearest ranked style by size, then weight
      let best = 0, bd = Infinity;
      ranked.forEach((e, i) => { const d = Math.abs(e[1][0] - k[0]) * 10 + Math.abs(e[1][1] - k[1]) + Math.abs(e[1][2] - k[2]); if (d < bd) { bd = d; best = i; } });
      s.level = Math.min(3, best + 1);
    }
  }

  function structure(input) {
    const pagesIn = (input && input.pages) || [];
    const meta = (input && input.meta) || {};
    const skipped = {headers: [], footers: [], pageNumbers: [], equations: [], tables: [], other: []};
    const log = [];
    const notes = {hyphenation: []};
    let totalChars = 0;
    const P = pagesIn.map((pg, idx) => {
      const index = pg.index != null ? pg.index : idx;
      const parts = [], rotated = [];
      for (const it of pg.items || []) {
        if (!it || typeof it.str !== 'string') continue;
        const str = normalizeText(it.str);
        if (!str.trim()) { if (str.length && parts.length) parts[parts.length - 1].spaceAfter = true; continue; }
        totalChars += nsLen(str.split(SOFT).join(''));
        const size = +it.fontSize || +it.h || 10;
        const x = +it.x, y = +it.y;
        if (!isFinite(x) || !isFinite(y)) continue;
        const h = +it.h || size;
        let w = +it.w;
        if (!isFinite(w) || w <= 0) w = str.length * size * 0.5;
        const part = {str, x, y, w, h, size, font: it.fontName || '', family: it.fontFamily || '', bold: it.bold, italic: it.italic, page: index, baseline: y + h};
        if (it.dir === 'ttb') rotated.push(part); else parts.push(part);
      }
      return {index, width: +pg.width || 612, height: +pg.height || 792, parts, rotated};
    });
    dropBullets(P);
    dropStaleLayer(P, skipped);
    fixRunSizes(P);
    inferBold(P);
    for (const pg of P) {
      pg.segs = segmentsOf(pg.parts);
      pg.overlays = dropOverlays(pg);
      if (pg.rotated.length) {
        const text = pg.rotated.map(p => p.str).join(' ').replace(/\s+/g, ' ').trim();
        if (text) skipped.other.push({text, page: pg.index, reason: 'rotated margin text'});
      }
    }
    detectMargins(P, skipped, meta);
    for (const pg of P) detectWideTables(pg, skipped);
    const bodySize = bodyFontSize(P);
    // gutters page by page, then the ones the document keeps using (odd and even pages differ)
    for (const pg of P) { const g = []; findGutters(pg.segs.filter(s => !s.skip), pg.width, 0, pg.width, g, 0); pg.pageGutters = g.sort((a, b) => a - b); }
    const docGutters = [];
    {
      const all = P.flatMap(pg => pg.pageGutters).sort((a, b) => a - b);
      let run = [];
      const close = () => { if (run.length >= 2) docGutters.push(median(run)); run = []; };
      for (const g of all) { if (run.length && g - run[run.length - 1] > 4) close(); run.push(g); }
      close();
    }
    for (const pg of P) layoutPage(pg, bodySize, docGutters);
    const lex = buildLexicon(P);
    const fontWeight = new Map();
    for (const pg of P) for (const p of pg.parts) { const k = sizeKey(p.size) + '|' + fontKey(p.font); fontWeight.set(k, (fontWeight.get(k) || 0) + nsLen(p.str)); }
    const famWeight = new Map();
    for (const pg of P) for (const p of pg.parts) if (p.family && Math.abs(p.size - bodySize) <= 0.4) famWeight.set(p.family, (famWeight.get(p.family) || 0) + nsLen(p.str));
    let bodyFamily = '', bw = -1;
    for (const [fm, w] of famWeight) if (w > bw) { bodyFamily = fm; bw = w; }
    const domFont = new Map();
    {
      const best = new Map();
      for (const [k, w] of fontWeight) { const [sz, ...f] = k.split('|'); const cur = best.get(sz); if (!cur || w > cur.w) best.set(sz, {w, font: f.join('|')}); }
      for (const [sz, v] of best) domFont.set(+sz, v.font);
    }
    const titleFound = detectTitle(P[0], bodySize, meta);
    const docPitch = new Map();
    {
      const by = new Map();
      for (const pg of P) {
        const groups = new Map();
        for (const l of pg.lines) { if (!groups.has(l.group)) groups.set(l.group, []); groups.get(l.group).push(l); }
        for (const ls of groups.values()) for (const k of new Set(ls.map(l => sizeKey(l.size)))) { if (!by.has(k)) by.set(k, []); by.get(k).push(...pitchesOf(ls, k)); }
      }
      for (const [k, ps] of by) if (ps.length >= 5) docPitch.set(k, median(ps));
    }
    const blocks = [];
    for (const pg of P) for (const b of buildBlocks(pg, bodySize, docPitch)) blocks.push(b);
    const byIndex = []; P.forEach(pg => { byIndex[pg.index] = pg; });
    // the sizes the paper sets running text in: the body, and a smaller one for Methods or legends set as text
    const sizeWeight = new Map();
    for (const pg of P) for (const sg of pg.segs) { if (sg.skip || sg.plain.length < 30) continue; const k = sizeKey(sg.size); sizeWeight.set(k, (sizeWeight.get(k) || 0) + sg.plain.replace(/[^\p{L}]/gu, '').length); }
    const topWeight = Math.max(0, ...sizeWeight.values());
    const textSize = size => Math.abs(size - bodySize) <= 0.5 || (sizeWeight.get(sizeKey(size)) || 0) >= 0.15 * topWeight;
    // the journal's reporting-summary form at the end (Nature's "nature portfolio | reporting summary"):
    // from its first page on everything is back matter, whatever its subheadings say
    let formPage = null;
    for (const pg of P) {
      if (pg.index <= (P[0] ? P[0].index : 0) + 1) continue;
      const formLine = t => /\|\s*reporting\s+summary\b/i.test(t);
      if (pg.segs.some(sg => sg.size >= 1.3 * bodySize && /^\s*reporting\s+summary\s*$/i.test(sg.plain)) || pg.segs.some(sg => formLine(sg.plain)) || pg.rotated.some(p => formLine(p.str))) { formPage = pg.index; break; }
    }
    // average glyph width per font, to tell an italic cut (narrower) from a heading face
    const fontWidth = new Map();
    {
      const acc = new Map();
      for (const pg of P) for (const p of pg.parts) { const t = p.str.replace(/\s/g, ''); if (t.length >= 4 && /^[A-Za-z]+$/.test(t) && p.w > 0) { const a = acc.get(p.font) || {c: 0, w: 0}; a.c += t.length; a.w += p.w / p.size; acc.set(p.font, a); } }
      for (const [f, a] of acc) if (a.c >= 20) fontWidth.set(f, a.w / a.c);
    }
    const domFamily = new Map();
    {
      const w = new Map();
      for (const pg of P) for (const p of pg.parts) if (p.family) { const k = sizeKey(p.size) + '|' + p.family; w.set(k, (w.get(k) || 0) + nsLen(p.str)); }
      const best = new Map();
      for (const [k, n] of w) { const [sz, fam] = k.split('|'); const b = best.get(sz); if (!b || n > b.n) best.set(sz, {n, fam}); }
      for (const [sz, b] of best) domFamily.set(+sz, b.fam);
    }
    const res = assemble(byIndex, blocks, {domFamily, fontWidth, formPage, textSize, skipped, log, notes, bodySize, lex, titleFound, meta, domFont, bodyFamily, bodyFont: domFont.get(sizeKey(bodySize)) || '', firstPage: P.length ? P[0].index : 0});
    assignLevels(res.sections);

    // "Abstract:" run in front of the first sentence is a label, not text
    const absSec = res.sections.find(s => s.kind === 'abstract');
    if (absSec && absSec.paragraphs.length) {
      const s0 = absSec.paragraphs[0].sentences[0];
      if (s0) s0.text = s0.text.replace(/^abstract\b[\s.:—-]*/i, '') || s0.text;
    }
    let abstract = '';
    if (absSec) abstract = absSec.paragraphs.map(p => p.sentences.map(s => s.text).join(' ')).join(' ');
    if (!abstract && meta.abstract) abstract = clean(meta.abstract);
    const title = res.title ? clean(res.title) : (meta.title ? clean(meta.title) : '');

    let bodyChars = 0;
    for (const s of res.sections) for (const p of s.paragraphs) for (const se of p.sentences) bodyChars += nsLen(se.text);
    let counted = P.filter(pg => pg.lines.filter(l => l.chars >= 15).length >= 8).map(pg => pg.columns);
    if (!counted.length) counted = P.map(pg => pg.columns);
    const tally = {};
    let modeCols = 1, best = 0;
    for (const k of counted) { tally[k] = (tally[k] || 0) + 1; if (tally[k] > best) { best = tally[k]; modeCols = k; } }

    let inMethods = false;
    const sections = res.sections.map(s => {
      const o = {heading: s.heading, spoken: speakHeading(s.heading), level: s.kind === 'back' ? 'back' : s.level, page: s.page, paragraphs: s.paragraphs, kind: s.kind};
      if (s.kind !== 'back' && s.kind !== 'abstract') {
        if (s.level === 1 && s.heading) inMethods = METHODS_NAMES.has(headingName(s.heading));
        o.part = inMethods ? 'methods' : 'main';
      }
      return o;
    });

    // a PDF whose text layer is glyph codes rather than text (no ToUnicode map) comes out as
    // punctuation soup: few of its words are made of letters with a vowel in them
    let wordy = 0, toks = 0;
    for (const pg of P) for (const sg of pg.segs) {
      if (sg.plain.length < 30) continue;
      for (const t of sg.plain.split(/\s+/)) {
        if (t.length < 3) continue;
        toks++;
        if (/^[\p{L}][\p{L}'\u2019-]*[.,;:)]?$/u.test(t) && /[aeiouy\u00E0-\u00FF\u0400-\u04FF\u3040-\u30FF\uAC00-\uD7AF\u4E00-\u9FFF]/i.test(t)) wordy++;
      }
    }
    const letterRatio = toks ? wordy / toks : 1;
    const unreadable = toks > 300 && letterRatio < 0.45;

    const out = {
      title, abstract, sections,
      captions: res.captions, references: res.references, footnotes: res.footnotes,
      skipped,
      stats: {bodyChars, totalChars, pages: P.length, columns: modeCols, bodySize, pageColumns: P.map(pg => pg.columns), hyphenations: notes.hyphenation.length,
        wordShare: Math.round(letterRatio * 100) / 100, unreadable, useFallback: unreadable},
      notes,
      layout: P.map(pg => ({index: pg.index, columns: pg.columns, gutters: pg.gutters, width: pg.width, height: pg.height})),
    };
    // a text layer of glyph codes has no body worth reading: nothing is offered, and the flag tells the
    // reader to use another source of text (the full-text index)
    if (unreadable) { out.sections = []; out.abstract = meta.abstract ? clean(meta.abstract) : ''; out.stats.bodyChars = 0; }
    // the per-block log of what was classified as what is for debug(); a reader caching the result does not need it
    if (input && input.debug) { out.log = log; Object.defineProperty(out, '_pages', {value: P, enumerable: false}); }
    return out;
  }

  /* ------------------------------------------------------ reading order */

  /* Every body sentence in reading order and nothing else. sentenceIndex counts
     within the section, so (sectionIndex, sentenceIndex) addresses a sentence. */
  function readingOrder(structured) {
    const out = [];
    ((structured && structured.sections) || []).forEach((sec, si) => {
      let n = 0;
      sec.paragraphs.forEach((p, pi) => {
        for (const s of p.sentences) {
          out.push({text: s.text, spoken: s.spoken || s.text, page: s.page, rects: s.rects, sectionIndex: si, sentenceIndex: n++, paragraphIndex: pi, kind: sec.kind, level: sec.level});
        }
      });
    });
    return out;
  }

  /* -------------------------------------------------------------- debug */

  /* A report per page of what was classified as what, and why. */
  function debug(structured) {
    if (!structured) return '';
    const st = structured.stats || {};
    const lines = [`${st.pages} pages, ${st.columns} column(s), body ${st.bodyChars}/${st.totalChars} chars (${st.totalChars ? Math.round(100 * st.bodyChars / st.totalChars) : 0}%), body type ${st.bodySize}pt`];
    const byPage = new Map();
    const put = e => { if (!byPage.has(e.page)) byPage.set(e.page, []); byPage.get(e.page).push(e); };
    for (const e of structured.log || []) put(e);
    for (const k of ['headers', 'footers', 'pageNumbers']) {
      for (const e of (structured.skipped && structured.skipped[k]) || []) put({page: e.page, kind: k === 'headers' ? 'header' : k === 'footers' ? 'footer' : 'pageNumber', reason: e.reason, text: e.text});
    }
    for (const pgi of [...byPage.keys()].sort((a, b) => a - b)) {
      const lay = (structured.layout || []).find(l => l.index === pgi);
      lines.push('', `--- page ${pgi + 1}${lay ? `, ${lay.columns} column(s)` : ''} ---`);
      for (const e of byPage.get(pgi)) {
        const text = String(e.text || '').replace(/\s+/g, ' ').slice(0, 64);
        lines.push(`${e.kind.toUpperCase().padEnd(10)} ${e.col != null && e.col >= 0 ? 'c' + e.col : '  '} ${e.reason ? '[' + e.reason + '] ' : ''}${text}`);
      }
    }
    return lines.join('\n');
  }

  const api = {structure, readingOrder, pageFromPdfjs, fontsOf, debug, splitSentences, normalizeText, decideHyphen, headingName, isCiteSup, spokenOf, _: {segmentsOf, findGutters, joinParts, clusterRows, breakReason, lineify}};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.StyleCustomPaperText = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

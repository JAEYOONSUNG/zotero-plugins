/* The maps and charts, checked as drawings (design pass 2026-10-05, the user: "시각화 부분도 디자인 신경 쓰고").

   - every letter on a map is set in the panel's type tokens, never under 11px;
   - every mark the reader has to see (node ring, line, arrow, journal ink, the chosen paper) clears 3:1 on the card,
     in light and in dark;
   - at 8 and at 120 papers, laid out at the widths the panel gives a map (narrow, normal, wide), no label sits on
     another label or on another paper's dot;
   - a map that colours its nodes has a key that names those colours. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import PaperGraph from '../src/paper-graph.js';
import Portrait from '../src/author-portrait.js';
import JournalIdentity from '../src/journal-identity.js';

const css = fs.readFileSync(fileURLToPath(new URL('../content/workbench.css', import.meta.url)), 'utf8');
const source = fs.readFileSync(fileURLToPath(new URL('../src/workbench.js', import.meta.url)), 'utf8');

// ---- colour arithmetic ---------------------------------------------------------------------------------------
const rgbOf = value => {
  const v = String(value).trim();
  let m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) return m[1].match(/../g).map(x => parseInt(x, 16));
  m = v.match(/^hsl\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*\)$/i);
  if (m) {
    const h = Number(m[1]) / 360, s = Number(m[2]) / 100, l = Number(m[3]) / 100;
    const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const hue = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map(x => Math.round(x * 255));
  }
  throw new Error('colour ' + v);
};
const luminance = rgb => { const c = rgb.map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4); return c[0] * .2126 + c[1] * .7152 + c[2] * .0722; };
const contrast = (a, b) => { const x = luminance(rgbOf(a)), y = luminance(rgbOf(b)); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const blend = (fg, bg, alpha) => { const f = rgbOf(fg), b = rgbOf(bg); return '#' + f.map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join(''); };

// The two token blocks: the first #style-custom-workbench rule, and the one inside the dark-scheme media group.
const block = text => Object.fromEntries([...text.matchAll(/(--sc-[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
const lightText = css.slice(css.indexOf('#style-custom-workbench {'), css.indexOf('}', css.indexOf('#style-custom-workbench {')));
const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const darkText = css.slice(css.indexOf('#style-custom-workbench {', darkStart), css.indexOf('}', css.indexOf('#style-custom-workbench {', darkStart)));
const light = block(lightText), dark = {...light, ...block(darkText)};
const resolve = (palette, value) => { let v = value; for (let i = 0; i < 5 && /^var\(/.test(v); i++) v = palette[v.match(/var\((--sc-[\w-]+)\)/)[1]]; return v; };

test('every mark on a map clears 3:1 on the card, in light and dark', () => {
  for (const [name, palette] of [['light', light], ['dark', dark]]) {
    const card = resolve(palette, palette['--sc-surface']);
    for (const token of ['--sc-node-ring', '--sc-graph-line', '--sc-text']) {
      const ink = resolve(palette, palette[token]);
      assert.ok(contrast(ink, card) >= 3, `${name} ${token} ${ink} on ${card}: ${contrast(ink, card).toFixed(2)}`);
    }
    // A line brought forward (hover, focus, find) is drawn at .85 opacity: still 3:1 once blended into the card.
    const line = blend(resolve(palette, palette['--sc-graph-line']), card, .85);
    assert.ok(contrast(line, card) >= 3, `${name} emphasised line ${line}: ${contrast(line, card).toFixed(2)}`);
    // The neutral node is told apart by its ring, and the ring from the node's own fill.
    assert.ok(contrast(resolve(palette, palette['--sc-node-ring']), resolve(palette, palette['--sc-node-fill'])) >= 3, `${name} ring on node fill`);
    // The chosen paper: lime, ringed in the ink.
    assert.ok(contrast(resolve(palette, palette['--sc-text']), resolve(palette, palette['--sc-lime'])) >= 3, `${name} chosen paper ring`);
  }
});

test('a journal\'s ring on a map clears 3:1 on the card, in light and dark', () => {
  const venues = ['Nature', 'Science', 'Cell', 'Cell Reports', 'Nature Communications', 'PLOS ONE', 'eLife', 'Nucleic Acids Research',
    'Molecular Cell', 'ACS Synthetic Biology', 'Journal of Biological Chemistry', 'Proceedings of the National Academy of Sciences', 'Nature Methods', 'Bioinformatics'];
  let checked = 0;
  for (const venue of venues) {
    const id = JournalIdentity.identify(venue);
    if (!id) continue;
    for (const [name, palette, isDark] of [['light', light, false], ['dark', dark, true]]) {
      const tone = JournalIdentity.colours(id, {dark: isDark}), card = resolve(palette, palette['--sc-surface']);
      assert.ok(contrast(tone.ink, card) >= 3, `${name} ${venue} ring ${tone.ink}: ${contrast(tone.ink, card).toFixed(2)}`);
      checked++;
    }
  }
  assert.ok(checked >= 16, 'most of the commonest journals are known to the registry');
});

test('every letter on a map is set in the type tokens, never under 11px', () => {
  // The rules that style SVG text in a map name a size token, never a pixel size.
  const svgTextRules = [...css.matchAll(/([^{}]*\.(?:sc-graph(?:-label)?|sc-author-initials)[^{}]*)\{([^}]*)\}/g)]
    .filter(([, selector, body]) => /\btext\b|sc-graph-label|sc-author-initials/.test(selector) && /font/.test(body));
  assert.ok(svgTextRules.length >= 3, 'the map text rules are found');
  for (const [, selector, body] of svgTextRules) {
    for (const size of body.matchAll(/font(?:-size)?\s*:\s*([^;]+)/g)) {
      assert.doesNotMatch(size[1], /\b(?:[0-9]|10)(?:\.\d+)?px\b/, `${selector.trim()} sets a size under 11px`);
      if (/font-size/.test(size[0]) || /\//.test(size[1])) assert.match(size[1], /var\(--sc-fs-[a-z]+\)/, `${selector.trim()} uses a size token`);
    }
  }
  // The smallest token itself has the 11px floor.
  assert.match(css, /--sc-fs-meta:\s*max\(11px,/, 'the meta size is floored at 11px');
  // And the drawing code never writes a font size into a map's <text>.
  const draws = source.match(/createElementNS\(SVG,'text'\)[^;]*;[^\n]*/g) || [];
  assert.ok(draws.length >= 6, 'the map text is found in the source');
  for (const line of draws) assert.doesNotMatch(line, /font-size|fontSize/, 'no inline font size on map text');
});

// ---- labels: no overlaps at 8 and 120 papers, at the widths the panel gives a map ------------------------------
const WIDTHS = [560, 860, 1100]; // 700, 1,100 and 1,600px panels after the rail and padding (the map is capped at 1100)
const graphOf = n => {
  const papers = [];
  for (let i = 0; i < n; i++) {
    const refs = new Set();
    for (let k = 1; k <= 3; k++) refs.add('W' + ((i + k * Math.max(3, Math.round(n / 14))) % n));
    refs.delete('W' + i);
    papers.push({id: String(i), title: `Structural mechanism of programmable transposases number ${i}`, year: 2000 + i % 26,
      citations: (i * 53) % 1400, venue: ['Cell', 'Science', 'Nature', 'eLife'][i % 4], openalex: 'W' + i, references: [...refs]});
  }
  return PaperGraph.build(papers);
};
const boxesOf = (nodes, places, text, {lineHeight = 14, gap = 4} = {}) => [...places].map(([id, place]) => {
  const n = nodes.find(x => x.id === id), w = PaperGraph.textWidth(text(n));
  const left = place.anchor === 'end' ? n.x + place.dx - w : place.anchor === 'middle' ? n.x + place.dx - w / 2 : n.x + place.dx;
  // The text's own box: baseline at dy, about 11px of letters above it and 3px below.
  return {id, x: left, y: n.y + place.dy - 11, w, h: 14};
});
const overlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > .5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > .5;
const onDot = (box, n) => { const r = (n.r || n.rad || 6); const nx = Math.max(box.x, Math.min(n.x, box.x + box.w)), ny = Math.max(box.y, Math.min(n.y, box.y + box.h)); return Math.hypot(n.x - nx, n.y - ny) < r - .5; };
function assertClean(nodes, places, text, what) {
  const boxes = boxesOf(nodes, places, text);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++)
    assert.ok(!overlap(boxes[i], boxes[j]), `${what}: label ${boxes[i].id} sits on label ${boxes[j].id}`);
  for (const box of boxes) for (const n of nodes) if (n.id !== box.id) assert.ok(!onDot(box, n), `${what}: label ${box.id} sits on dot ${n.id}`);
  return boxes.length;
}

for (const size of [8, 120]) for (const W of WIDTHS) {
  test(`paper map, ${size} papers at ${W}px: no label on a label or a dot`, () => {
    const H = Math.max(220, Math.min(size > 80 ? 680 : 540, 90 + size * 46));
    const laid = PaperGraph.layout(graphOf(size), {width: W, height: H});
    for (const n of laid.nodes) n.labelText = `${String(n.label).slice(0, 26)}… · ${n.year}`;
    const places = PaperGraph.placeLabelsAround(laid.nodes, {width: W, height: H, lineHeight: 14, pad: 2, gap: 4, limit: size <= 16 ? size : 32, edges: laid.edges});
    const shown = assertClean(laid.nodes, places, n => n.labelText, `${size}@${W}`);
    assert.ok(shown >= Math.min(size, 6), `${size}@${W}: ${shown} labels shown`);
    for (const [id, place] of places) {
      const n = laid.nodes.find(x => x.id === id), w = PaperGraph.textWidth(n.labelText);
      const left = place.anchor === 'end' ? n.x + place.dx - w : place.anchor === 'middle' ? n.x + place.dx - w / 2 : n.x + place.dx;
      assert.ok(left >= -1 && left + w <= W + 1, `${size}@${W}: label ${id} stays inside the frame`);
    }
  });
}

for (const size of [8, 40]) for (const W of [360, 760, 860]) {
  test(`a person's co-author graph, ${size} co-authors at ${W}px: full names never sit on a name or a face`, () => {
    const works = Array.from({length: size * 2}, (_, i) => ({id: 'W' + i, doi: '10.9/' + i, title: 'p' + i,
      people: [{id: 'A1', name: 'Jennifer A. Doudna'}, {id: 'B' + (i % size), name: 'Co Author Number ' + (i % size) + ' Longname'}]}));
    const graph = Portrait.egoGraph({me: {id: 'A1', name: 'Jennifer A. Doudna'}, works, limit: 48});
    const H = graph.nodes.length > 12 ? 400 : 320;
    const laid = Portrait.egoLayout(graph, {width: W, height: H}), HT = Math.max(H, Number(laid.height) || H);
    const everyone = [laid.centre, ...laid.nodes].map(n => Object.assign(n, {r: n.rad}));
    const named = new Set([laid.centre.id, ...laid.nodes.filter(n => n.full).map(n => n.id)]);
    const places = PaperGraph.placeLabelsAround(everyone, {width: W, height: HT, lineHeight: 14, pad: 2, gap: 5, limit: 49,
      first: new Set([laid.centre.id]), text: n => named.has(n.id) ? n.name : ''});
    // In a crowd at a narrow width the middle may go unnamed (the page above names them) rather than sit on a face.
    if (size <= 8) assert.ok(places.has(laid.centre.id), 'the person in the middle is named');
    assertClean(everyone, places, n => n.name, `ego ${size}@${W}`);
  });
}

test('a map that colours its nodes names those colours in a key at its foot', () => {
  // drawJournalLegend writes one entry per journal it colours, from the same legendVenues the nodes are painted from.
  assert.match(source, /function graphTones\(nodes\)\{[\s\S]{0,200}legendVenues\(nodes\)/, 'the node paint comes from the key\'s own list');
  assert.match(source, /const top=state\.graphJournalColour===false\?\[\]:legendVenues\(nodes\);/, 'and the key lists exactly those journals');
  // Each paper map hands its key to the card, so the key sits under the drawing it explains.
  const kits = [...source.matchAll(/graphKit\(\{svg,frame:mapFrame/g)].map(m => source.slice(m.index, source.indexOf('});', m.index)));
  assert.equal(kits.length, 3, 'citation, scope and related maps');
  for (const call of kits) assert.match(call, /legend:lastLegend/, 'each paper map moves its key into its card');
});

test('placeLabelsAround keeps the chosen paper named even in a crowd, and drops the rest rather than piling them up', () => {
  const nodes = Array.from({length: 30}, (_, i) => ({id: String(i), x: 100 + (i % 6) * 6, y: 100 + Math.floor(i / 6) * 6, r: 5, labelText: 'A long title for paper ' + i}));
  const places = PaperGraph.placeLabelsAround(nodes, {width: 400, height: 300, first: new Set(['17'])});
  assert.ok(places.has('17'), 'the chosen paper keeps its words');
  assert.ok(places.size < nodes.length, 'a crowd does not get a label each');
});

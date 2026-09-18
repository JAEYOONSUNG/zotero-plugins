/* Who published this, shown as a mark rather than a colour-coded number.

   The IF column used to tint each value by tier: purple above 30, blue above
   10, teal above 5, green above 2. One column, five hues, a different colour on
   every row, and the tier said nothing the number itself did not already say.
   That is what made the list look like a toy.

   A journal's publisher is the thing a reader actually recognises at a glance,
   and it is not written anywhere else in the row. So the colour carries the
   publisher family, the number goes back to plain readable ink, and weight
   alone carries how high the figure is.

   The marks are monograms, not logos. A publisher's logo is its trademark and
   there is no offline source for one, so each family gets a lettermark drawn in
   its own colour instead: recognisable, ours to ship, and legible at 14px. */
(function (root) {
  'use strict';

  const text = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const flat = value => text(value).toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

  /* One entry per publisher family, in the order they are tested: a longer,
     more specific pattern has to come before the family it belongs to, or
     "Nature Communications" is matched by the rule for "Nature".

     The hues are the families' own, pulled toward each other in saturation so
     that a column of them reads as one set rather than as a paint chart. */

  /* Every Nature sister journal wears its own cover colour, and a reader who
     works in the field knows them: Biotechnology blue, Methods green, Chemical
     Biology purple, Genetics amber, Medicine red. The portfolio is one family
     but the marks are not one colour. Hues approximate the covers. */
  const NATURE_TITLES = [
    [/^nature$/, 168], [/^nature communications/, 195], [/^nature biotechnology/, 215],
    [/^nature methods/, 95], [/^nature chemical biology/, 285], [/^nature genetics/, 40],
    [/^nature cell biology/, 200], [/^nature immunology/, 350], [/^nature neuroscience/, 25],
    [/^nature medicine/, 5], [/^nature structural/, 260], [/^nature microbiology/, 140],
    [/^nature chemistry/, 320], [/^nature materials/, 30], [/^nature physics/, 230],
    [/^nature nanotechnology/, 15], [/^nature photonics/, 45], [/^nature catalysis/, 20],
    [/^nature energy/, 60], [/^nature ecology/, 120], [/^nature plants/, 110],
    [/^nature metabolism/, 300], [/^nature machine intelligence/, 250], [/^nature sustainability/, 150],
    [/^nature climate change/, 190], [/^nature human behaviour/, 340], [/^nature aging/, 275],
    [/^nature cancer/, 355], [/^nature synthesis/, 35], [/^nature food/, 80], [/^nature water/, 205],
    [/^nature cardiovascular/, 10], [/^nature mental health/, 330], [/^nature protocols/, 100],
    [/^nature reviews/, 175], [/^scientific reports/, 160], [/^npj\b/, 165], [/^communications /, 180]
  ];
  function natureHue(title) {
    const key = flat(title);
    const hit = NATURE_TITLES.find(([test]) => test.test(key));
    return hit ? hit[1] : 168;
  }

  const FAMILIES = [
    // --- Nature portfolio: the house colour, with the flagship darker ---
    {key: 'nature', label: 'Nature', mark: 'N', hue: 168, test: /^nature$/},
    {key: 'nature-portfolio', label: 'Nature Portfolio', hue: natureHue,
     // Scientific Reports and the Communications titles are Nature portfolio
     // too, and a reader knows it even though the name does not say so.
     test: /^(nature|npj|scientific reports|communications (biology|chemistry|physics|materials|earth|engineering|medicine))\b/,
     mark: title => monogram(title, 'N')},
    // --- the other flagships ---
    {key: 'science', label: 'Science', mark: 'S', hue: 358, test: /^science$/},
    {key: 'aaas', label: 'AAAS', hue: 358, test: /^science\b(advances|immunology|robotics|signaling|translational)?/,
     mark: title => monogram(title, 'S')},
    {key: 'pnas', label: 'PNAS', mark: 'PN', hue: 220,
     test: /^proceedings of the national academy|^pnas\b/},
    {key: 'cell-press', label: 'Cell Press', hue: 200,
     test: /^(cell|molecular cell|developmental cell|cancer cell|immunity|neuron|chem|joule|matter|one earth|med|current biology|structure|trends in)\b/,
     mark: title => monogram(title, 'C')},
    // --- society and university presses ---
    {key: 'oxford', label: 'Oxford', hue: 232,
     test: /^(nucleic acids research|bioinformatics|briefings in|nar |database|molecular biology and evolution|fems )/,
     mark: title => monogram(title, 'O')},
    {key: 'asm', label: 'ASM', hue: 190,
     test: /^(applied and environmental microbiology|journal of bacteriology|mbio|msystems|msphere|mmbr|microbiology and molecular biology reviews|antimicrobial agents|journal of virology|infection and immunity|journal of clinical microbiology)\b/,
     mark: title => monogram(title, 'A')},
    {key: 'acs', label: 'ACS', hue: 208,
     test: /^(acs |journal of the american chemical society|analytical chemistry|biochemistry$|journal of agricultural and food chemistry|environmental science and technology)/,
     mark: title => monogram(title, 'ACS')},
    {key: 'rsc', label: 'RSC', hue: 344,
     test: /^(chemical (science|communications|society reviews)|green chemistry|soft matter|lab on a chip|analyst$)/,
     mark: title => monogram(title, 'RSC')},
    {key: 'embo', label: 'EMBO', hue: 12,
     test: /^(the )?embo |^molecular systems biology/, mark: title => monogram(title, 'EM')},
    {key: 'elife', label: 'eLife', mark: 'eL', hue: 24, test: /^elife/},
    {key: 'plos', label: 'PLOS', hue: 32, test: /^plos\b|^plo s\b/, mark: title => monogram(title, 'PL')},
    {key: 'frontiers', label: 'Frontiers', hue: 152, test: /^frontiers in\b/, mark: title => monogram(title, 'F')},
    {key: 'mdpi', label: 'MDPI', hue: 140,
     test: /^(ijms|international journal of molecular sciences|microorganisms|biomolecules|catalysts|polymers|molecules|foods|sensors|cells)$/,
     mark: title => monogram(title, 'M')},
    // --- the big commercial houses, last: their titles are the least regular ---
    {key: 'elsevier', label: 'Elsevier', hue: 28,
     test: /^(metabolic engineering|journal of (molecular biology|biological chemistry|biotechnology)|bioresource technology|biotechnology advances|enzyme and microbial|process biochemistry|food chemistry|international journal of biological macromolecules|current opinion in|methods in enzymology|biochimica et biophysica)/,
     mark: title => monogram(title, 'E')},
    {key: 'springer', label: 'Springer', hue: 214,
     test: /^(applied microbiology and biotechnology|extremophiles|archives of microbiology|world journal of microbiology|biotechnology letters|journal of industrial microbiology|amb express|microbial cell factories|biotechnology for biofuels|bmc )/,
     mark: title => monogram(title, 'Sp')},
    {key: 'wiley', label: 'Wiley', hue: 246,
     test: /^(biotechnology and bioengineering|molecular microbiology|environmental microbiology|microbial biotechnology|febs |protein science|angewandte|advanced science|chembiochem)/,
     mark: title => monogram(title, 'W')}
  ];

  // An initialism from the words that carry meaning, so an unknown journal still
  // gets a mark that means something: "Journal of Molecular Biology" -> JMB.
  const SKIP = new Set(['the', 'of', 'and', 'in', 'for', 'on', 'a', 'an', 'at', 'to', 'de', 'der']);
  function monogram(title, fallback) {
    const words = flat(title).split(' ').filter(word => word && !SKIP.has(word));
    if (!words.length) return fallback || '?';
    if (words.length === 1) {
      // A one-word title keeps up to four letters: "Cell" is the mark, "Ce" is
      // not a name anybody recognises.
      const one = words[0];
      return (one.length <= 4 ? one : one.slice(0, 3)).replace(/^./, c => c.toUpperCase());
    }
    const letters = words.slice(0, 3).map(word => word[0].toUpperCase()).join('');
    return letters.length >= 2 ? letters : (fallback || letters);
  }

  // A stable hue for a journal nobody curated, so the same title is always the
  // same colour and the column stays coherent instead of arbitrary.
  function derivedHue(title) {
    const value = flat(title);
    let hash = 0;
    for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
    return hash % 360;
  }

  function identify(title) {
    const name = text(title);
    if (!name) return null;
    const key = flat(name);
    for (const family of FAMILIES) {
      if (!family.test.test(key)) continue;
      return {
        family: family.key, label: family.label,
        hue: typeof family.hue === 'function' ? family.hue(name) : family.hue,
        mark: typeof family.mark === 'function' ? family.mark(name) : family.mark,
        known: true
      };
    }
    return {family: 'other', label: '', hue: derivedHue(name), mark: monogram(name), known: false};
  }

  // The mark's ink and its fill, derived from one hue so every tile in the
  // column is built the same way. A curated family sits a little stronger than
  // a derived one, so a recognised publisher reads first.
  function colours(identity, {dark = false} = {}) {
    const hue = identity?.hue ?? 0;
    const known = !!identity?.known;
    return dark
      ? {ink: hsl(hue, known ? 46 : 26, 72), fill: hsl(hue, known ? 34 : 18, 24), edge: hsl(hue, known ? 34 : 18, 34)}
      : {ink: hsl(hue, known ? 42 : 22, 38), fill: hsl(hue, known ? 46 : 26, 94), edge: hsl(hue, known ? 40 : 22, 86)};
  }

  const hsl = (h, s, l) => `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;

  const api = {identify, colours, monogram, derivedHue, natureHue, FAMILIES, NATURE_TITLES};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleJournalIdentity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

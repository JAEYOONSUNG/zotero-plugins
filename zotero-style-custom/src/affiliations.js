/* Where a paper came from, and who answers for it.

   A Zotero record holds author names and nothing else. Which lab did the work,
   which country it was done in, and who the corresponding author is are all
   facts a reader uses constantly and none of them are anywhere in the library.
   OpenAlex carries all three on every authorship.

   "Top-tier" is the awkward one. It is a judgement, and a hand-written list of
   famous universities is just my opinion wearing a badge. So the standing of an
   institution is read off OpenAlex's own figure for it -- the h-index of
   everything that institution has ever published -- and bucketed. That is a
   measurable claim about output, it is the same number for everybody, and the
   tooltip says exactly what it is rather than implying a ranking. */
(function (root) {
  'use strict';

  const text = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

  /* The buckets, in h-index of the institution's whole corpus.

     Calibrated twice, because the first calibration measured the wrong thing.

     Counting institutions, 61% of the 510 behind this library sit above 400.
     But a badge is worn by a paper, not by an institution, and papers pile up
     at the big places: paper-weighted, 77% were above 400 and 26% above 1400.
     A mark that appears on three rows in four is not a mark, it is a texture.

     So the thresholds are read off the paper-weighted spread, and only the top
     two buckets carry a label at all:

       h >= 2000   labelled T1 (cut-points shared with ZotPoP)
       h >= 1400   labelled T2
       below       sorts, but says nothing on the row

     The tooltip always carries the actual number, so the reader can disagree
     with where the line was drawn. These are cut points on a continuum and the
     labels are the short form, never a ranking. */
  // ZotPoP (the search plugin at the repo root) mirrors this table: change both together.
  const TIERS = [
    {key: 't1', floor: 2000, label: 'T1', note: '기관 전체 h-index 2000 이상 (ZotPoP과 같은 기준)'},
    {key: 't2', floor: 1400, label: 'T2', note: '기관 전체 h-index 1400 이상 (ZotPoP과 같은 기준)'},
    {key: 't3', floor: 400, label: 'T3', note: '기관 전체 h-index 400 이상'},
    {key: 't4', floor: 0, label: 'T4', note: '기관 전체 h-index 400 미만'}
  ];

  function tierOf(hIndex) {
    const value = Number(hIndex);
    if (!(value > 0)) return null;
    return TIERS.find(tier => value >= tier.floor) || TIERS[TIERS.length - 1];
  }

  // Country codes are ISO 3166-1 alpha-2, so a flag is two regional indicator
  // symbols away and no image has to be shipped or fetched.
  function flag(code) {
    const value = text(code).toUpperCase();
    if (!/^[A-Z]{2}$/.test(value)) return '';
    return String.fromCodePoint(...[...value].map(letter => 0x1F1E6 + letter.charCodeAt(0) - 65));
  }

  /* The two authorships that matter, out of a list that can run to hundreds.

     The first author did the work and the corresponding author answers for it;
     on a large consortium paper they are rarely the same person and often not
     even on the same continent. When nobody is flagged corresponding -- which
     happens on older records -- the last author is the convention in this
     field, and saying which rule was used is the honest part. */
  function principals(people) {
    /* OpenAlex sometimes lists one person twice on a work (and an older store
       may hold both). One person counts once: the same id, else the same
       normalised name, with the corresponding flag kept if either copy has it. */
    const keyOf = person => text(person.id) || text(person.name).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const byKey = new Map(), list = [];
    for (const person of Array.isArray(people) ? people : []) {
      if (!person || !text(person.name)) continue;
      const key = keyOf(person);
      if (byKey.has(key)) { const kept = byKey.get(key); if (person.corresponding && !kept.corresponding) kept.corresponding = true; continue; }
      const copy = {...person}; byKey.set(key, copy); list.push(copy);
    }
    if (!list.length) return null;
    const first = list.find(person => person.position === 'first') || list[0];
    const flagged = list.filter(person => person.corresponding);
    const last = list.find(person => person.position === 'last') || list[list.length - 1];
    /* Every flagged author is kept. The compact display wants one, and prefers
       a corresponding author who is not the first author: a first author who
       is also corresponding used to stop the search there, so a second
       corresponding author was never looked for. */
    const elsewhere = flagged.find(person => person !== first);
    const corresponding = flagged.length ? (elsewhere || null) : (list.length > 1 && last !== first ? last : null);
    return {
      first,
      corresponding,
      allCorresponding: flagged,
      firstIsCorresponding: flagged.includes(first),
      correspondingKnown: flagged.length > 0,
      others: flagged.length > 1 ? flagged.length - 1 : 0,
      everyone: list
    };
  }

  // One line per person, as the row should read it.
  function describe(person, institutions = {}) {
    if (!person) return null;
    const record = person.ror ? institutions[person.ror] : null;
    const tier = record ? tierOf(record.hIndex) : null;
    return {
      name: text(person.name),
      institution: text(record?.name || person.institution),
      ror: text(person.ror),
      country: text(person.country).toUpperCase(),
      flag: flag(person.country),
      hIndex: record?.hIndex ?? null,
      tier: tier || null
    };
  }

  /* What the column shows for one paper. Both people, their labs, their
     countries, and how the corresponding author was decided. */
  function summarise(people, institutions = {}) {
    const picked = principals(people);
    if (!picked) return null;
    const first = describe(picked.first, institutions);
    const corresponding = describe(picked.corresponding, institutions);
    /* The ends of the paper: the first author and every corresponding author
       (the last author stands in when nobody is flagged). */
    const ends = [first, ...(picked.allCorresponding.length ? picked.allCorresponding.map(p => describe(p, institutions)) : [corresponding])]
      .filter(Boolean);
    const correspondingAll = picked.allCorresponding.map(p => describe(p, institutions));
    const countries = [...new Set(ends.map(row => row.country).filter(Boolean))];
    const everyone = picked.everyone.map(p => describe(p, institutions));
    const best = [...new Set(ends)].filter(row => row?.tier)
      .sort((a, b) => (b.hIndex || 0) - (a.hIndex || 0))[0] || null;
    return {
      first, corresponding, correspondingAll, countries,
      institutions: [...new Set(ends.map(row => row.institution).filter(Boolean))],
      // Every listed author, for a collaboration that is wider than the two ends.
      allCountries: [...new Set(everyone.map(row => row.country).filter(Boolean))],
      allInstitutions: [...new Set(everyone.map(row => row.institution).filter(Boolean))],
      firstIsCorresponding: picked.firstIsCorresponding,
      correspondingKnown: picked.correspondingKnown,
      extraCorresponding: picked.others,
      tier: best?.tier || null,
      // The figure behind that badge, so the tier column sorts by the institution it draws.
      hIndex: best?.hIndex ?? null,
      // International when the ends of the paper (first and every corresponding
      // author) are in different countries, which is a different thing from a
      // long author list; allCountries carries that wider picture.
      international: countries.length > 1
    };
  }

  // Every institution a sweep needs to look up, once, rather than once per paper.
  function institutionsNeeded(works, known = {}) {
    const wanted = new Set();
    for (const work of Array.isArray(works) ? works : []) {
      const picked = principals(work?.people);
      if (!picked) continue;
      for (const person of [picked.first, picked.corresponding, ...picked.allCorresponding]) {
        const ror = text(person?.ror);
        if (ror && !known[ror]) wanted.add(ror);
      }
    }
    return [...wanted];
  }

  const api = {summarise, principals, describe, tierOf, flag, institutionsNeeded, TIERS};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleAffiliations = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

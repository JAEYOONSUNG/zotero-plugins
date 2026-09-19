/* Telling a patent or a thesis apart from a paper.

   A row like "US20240352440A1.pdf" sat in the item list as a bare attachment,
   indistinguishable from any other PDF, and a thesis was one more journalArticle
   without a journal. Both are different kinds of thing from a paper -- no impact
   factor applies, no journal colour, a different reason to be on the shelf --
   and a reader scanning the list needs to see that without opening them.

   A patent is recognised by its number, which every office prints in a fixed
   shape and which people name the file after. A thesis is recognised by
   Zotero's own item type, or by the words a title uses when it is one. */
(function (root) {
  'use strict';

  const text = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

  /* Patent numbers, as the offices print them and as files get named.
     US: grant 7–11 digits (+ B1/B2), application 4-digit year + 7 digits (+ A1).
     EP/WO/KR/JP/CN: office prefix, digits, optional kind code. */
  const PATENT = [
    /\bUS\s?(?:RE)?\d{7,11}\s?(?:[AB]\d)?\b/i,
    /\bUS\s?(?:19|20)\d{2}\/?\d{7}\s?(?:A\d)?\b/i,
    /\bEP\s?\d{6,8}\s?(?:[AB]\d)?\b/i,
    /\bWO\s?(?:19|20)?\d{2}\/?\d{5,7}\s?(?:A\d)?\b/i,
    /\bKR\s?(?:10-)?\d{7,10}\s?(?:[AB]\d)?\b/i,
    /\bJP\s?(?:19|20)?\d{2}-?\d{5,7}\s?(?:[AB]\d)?\b/i,
    /\bCN\s?\d{9,12}\s?(?:[AB]\d)?\b/i
  ];
  const THESIS_WORDS = /\b(?:ph\.?\s?d\.?|doctoral|master'?s|m\.?\s?sc\.?|dissertation|thesis)\b|학위\s*논문|박사|석사/i;

  function patentNumber(value) {
    // Offices print thousands separators ("US 10,138,506 B2"); files do not.
    const raw = text(value).replace(/\.(pdf|docx?|txt)$/i, '').replace(/(\d),(?=\d{3})/g, '$1');
    for (const pattern of PATENT) {
      const found = pattern.exec(raw);
      if (found) return found[0].replace(/\s+/g, '').toUpperCase();
    }
    return '';
  }

  // Which office, from the number, so the badge can say "US patent" rather
  // than just "patent".
  function office(number) {
    const prefix = String(number || '').slice(0, 2).toUpperCase();
    return {US: '미국', EP: '유럽', WO: 'WIPO', KR: '한국', JP: '일본', CN: '중국'}[prefix] || prefix;
  }

  /* What kind of thing an item or a bare attachment is.
     Returns 'patent' | 'thesis' | null, with the evidence that decided it. */
  function kindOf({itemType, title, filename} = {}) {
    const type = text(itemType);
    if (type === 'patent') return {kind: 'patent', number: patentNumber(title) || patentNumber(filename), why: 'item type'};
    if (type === 'thesis') return {kind: 'thesis', why: 'item type'};
    const number = patentNumber(filename) || patentNumber(title);
    if (number) return {kind: 'patent', number, why: filename && patentNumber(filename) ? 'file name' : 'title'};
    if (THESIS_WORDS.test(text(title))) return {kind: 'thesis', why: 'title'};
    return null;
  }

  const api = {kindOf, patentNumber, office, PATENT, THESIS_WORDS};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleItemKinds = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

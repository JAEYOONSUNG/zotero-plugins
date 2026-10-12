/* Which papers are shown, in what order, and how they are found.

   A library of a few thousand papers is searched on every keystroke, so the text each paper is
   searched by is built once and kept against the paper object itself: a paper that changes is a
   new object, so the old text falls away with it and nothing has to be invalidated by hand.

   None of this touches the DOM, so the searching and the sorting are checked without a phone. */

const hayOf = new WeakMap();

/* Latin accents are folded, so Muller finds Müller; Hangul is composed, so a name typed on the
   phone matches one that came from a Mac. */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .normalize('NFC').toLowerCase();
}

export function haystack(item) {
  const held = hayOf.get(item);
  if (held !== undefined) return held;
  const data = item.data || {};
  const people = (data.creators || []).map(c => `${c.lastName || ''} ${c.firstName || ''} ${c.name || ''}`);
  const tags = (data.tags || []).map(t => t.tag);
  const text = fold([
    data.title, data.publicationTitle, data.bookTitle, data.repository, data.publisher,
    data.date, data.DOI, data.shortTitle, ...people, ...tags
  ].filter(Boolean).join(' '));
  hayOf.set(item, text);
  return text;
}

/* Every word has to appear somewhere, so "seo 2026 science" narrows rather than widens. A word in
   quotes is taken whole. */
export function words(query) {
  const out = [];
  for (const piece of String(query ?? '').match(/"[^"]*"|\S+/g) || []) {
    const word = fold(piece.replace(/^"|"$/g, ''));
    if (word) out.push(word);
  }
  return out;
}

export const matches = (item, needles) => needles.every(word => haystack(item).includes(word));

export const SORTS = [
  ['added', '최근 추가'],
  ['modified', '최근 변경'],
  ['year', '연도'],
  ['rating', '별점'],
  ['title', '제목']
];

const yearOf = item => Number((String(item.data?.date || '').match(/\b(1[6-9]\d\d|20\d\d|21\d\d)\b/) || [])[1] || 0);
const ratingOf = item => Number((String(item.data?.extra || '').match(/^\s*Rating:\s*([0-5])\s*$/im) || [])[1] || 0);
const titleOf = item => fold(item.data?.title || '');
const when = (item, field) => String(item.data?.[field] || '');

/* A sort always falls back to the most recently added, so two papers of the same year or the same
   rating keep a stable and sensible order rather than whatever the array happened to hold. */
export function sortRows(rows, how = 'added') {
  const recent = (a, b) => when(b, 'dateAdded').localeCompare(when(a, 'dateAdded'));
  const by = {
    added: recent,
    modified: (a, b) => when(b, 'dateModified').localeCompare(when(a, 'dateModified')) || recent(a, b),
    year: (a, b) => yearOf(b) - yearOf(a) || recent(a, b),
    rating: (a, b) => ratingOf(b) - ratingOf(a) || recent(a, b),
    title: (a, b) => titleOf(a).localeCompare(titleOf(b), 'ko') || recent(a, b)
  };
  return rows.slice().sort(by[how] || by.added);
}

/* The library narrowed to what is being looked at. The original array is never touched. */
export function filterRows(items, {collection = '', status = '', tag = '', q = '', statusOf} = {}) {
  const needles = words(q);
  let rows = items;
  if (collection) rows = rows.filter(item => (item.data.collections || []).includes(collection));
  if (status) rows = rows.filter(item => statusOf(item) === status);
  if (tag) rows = rows.filter(item => (item.data.tags || []).some(t => t.tag === tag));
  if (needles.length) rows = rows.filter(item => matches(item, needles));
  return rows === items ? rows.slice() : rows;
}

/* The tags worth offering as a filter: the ones actually used, commonest first, without the
   plumbing the desktop plugin writes. */
export function usefulTags(items, {limit = 40} = {}) {
  const count = new Map();
  for (const item of items) {
    for (const {tag} of item.data?.tags || []) {
      if (!tag || /^\//.test(tag) || /^style-custom:/.test(tag)) continue;
      count.set(tag, (count.get(tag) || 0) + 1);
    }
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'))
    .slice(0, limit)
    .map(([tag, n]) => ({tag, n}));
}

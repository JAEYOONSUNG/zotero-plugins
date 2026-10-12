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
    data.date, data.DOI, data.shortTitle, data.abstractNote, ...people, ...tags
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
  ['seen', '최근 본'],
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
export function sortRows(rows, how = 'added', {seenAt = () => 0} = {}) {
  const recent = (a, b) => when(b, 'dateAdded').localeCompare(when(a, 'dateAdded'));
  const by = {
    added: recent,
    // Papers never opened fall to the bottom together, in the order they were added.
    seen: (a, b) => (seenAt(b.key) - seenAt(a.key)) || recent(a, b),
    modified: (a, b) => when(b, 'dateModified').localeCompare(when(a, 'dateModified')) || recent(a, b),
    year: (a, b) => yearOf(b) - yearOf(a) || recent(a, b),
    rating: (a, b) => ratingOf(b) - ratingOf(a) || recent(a, b),
    title: (a, b) => titleOf(a).localeCompare(titleOf(b), 'ko') || recent(a, b)
  };
  return rows.slice().sort(by[how] || by.added);
}

/* A collection and everything filed under it. Zotero nests collections, and a paper sits in the
   one it was filed in, not in its parents: picking 파지 방어 and seeing nothing because every
   paper is in a sub-collection of it is not what anyone means by picking it. */
export function familyOf(collections, key) {
  const family = new Set(key ? [key] : []);
  if (!key) return family;
  const children = new Map();
  for (const row of collections || []) {
    const parent = (row.data && row.data.parentCollection) || '';
    if (!parent) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(row.key);
  }
  const walk = [key];
  while (walk.length) {
    for (const child of children.get(walk.pop()) || []) {
      if (family.has(child)) continue;   // a cycle in the data must not become a loop here
      family.add(child);
      walk.push(child);
    }
  }
  return family;
}

/* The library narrowed to what is being looked at. The original array is never touched. */
export function filterRows(items, {collection = '', collections = null, status = '', tag = '', q = '', statusOf} = {}) {
  const needles = words(q);
  const family = collections || (collection ? new Set([collection]) : null);
  let rows = items;
  if (family && family.size) rows = rows.filter(item => (item.data.collections || []).some(c => family.has(c)));
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

/* ---------- where you are in a long list ---------- */
/* A thousand papers scroll past without a landmark. The heading a paper sits under depends on the
   order the list is in — a date for the three date orders, the year, the stars, the first letter —
   and a paper whose heading is the same as the one above it draws none, so the headings fall where
   the list actually changes. */
const CHOSEONG = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';

/* The letter a title is filed under: the leading consonant for Hangul, the plain letter for the
   alphabets that have accents, and # for everything that starts with a digit or a bracket. */
export function initialOf(title) {
  const first = String(title ?? '').trim()[0];
  if (!first) return '#';
  const code = first.codePointAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return CHOSEONG[Math.floor((code - 0xac00) / 588)];
  if (/\p{L}/u.test(first)) return first.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return '#';
}

/* Today and yesterday have names; a week has one; after that a month is what anyone means. */
export function dayName(at, now = Date.now()) {
  if (!at) return '';
  const was = new Date(at), today = new Date(now);
  if (Number.isNaN(was.getTime())) return '';
  const midnight = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(today) - midnight(was)) / 86400000);
  if (days <= 0) return '오늘';
  if (days === 1) return '어제';
  if (days < 7) return '이번 주';
  if (was.getFullYear() === today.getFullYear() && was.getMonth() === today.getMonth()) return '이번 달';
  if (was.getFullYear() === today.getFullYear()) return `${was.getMonth() + 1}월`;
  return `${was.getFullYear()}년 ${was.getMonth() + 1}월`;
}

export function groupOf(item, how = 'added', {now = Date.now(), seenAt = () => 0} = {}) {
  if (how === 'year') { const year = yearOf(item); return year ? `${year}년` : '연도 모름'; }
  if (how === 'rating') { const n = ratingOf(item); return n ? '★'.repeat(n) : '별점 없음'; }
  if (how === 'title') return initialOf(item.data?.title);
  if (how === 'seen') return dayName(seenAt(item.key), now) || '아직 안 봄';
  const at = Date.parse(when(item, how === 'modified' ? 'dateModified' : 'dateAdded'));
  return dayName(at, now) || '날짜 모름';
}

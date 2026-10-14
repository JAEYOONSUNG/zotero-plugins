/* English beside the Korean, the way the Zotero plugin does it: the Korean sentence written at the
   call site IS the key, and the table turns it into English. Nothing here invents an id, so a string
   with no English still reads correctly in Korean rather than showing a blank or a dotted path.

   The phone follows itself by default — a Korean phone gets Korean, anything else gets English — and
   설정 · 앱 · 언어 overrides that. The choice is read once at start-up, because a phone's language
   does not change while an app is open.

     t('논문')                      -> 'Papers'
     T('{0}편', 12)                 -> '12 papers'
     T('{0}/{1} 문장', 3, 40)       -> 'sentence 3/40'

   A count of one is made singular by the same small rule the plugin uses, so no table entry ever has
   to carry "1 papers". */

export const DEFAULT = 'ko';
let table = {}, lang = DEFAULT;

export const set = (en = {}) => { table = en || {}; };
export const using = () => lang;

/* 'auto' asks the phone: a Korean one reads Korean, any other reads English, because English is the
   one language this table has. A phone that says nothing at all about its language is not a phone —
   every browser answers — so that case keeps the language this app is written in. */
export function use(choice, {language = ''} = {}) {
  const asked = String(choice || 'auto');
  if (asked === 'ko' || asked === 'en') { lang = asked; return lang; }
  const said = String(language || '').trim();
  lang = !said ? DEFAULT : /^ko\b/i.test(said) ? 'ko' : 'en';
  return lang;
}

/* "3 papers" but "1 paper", and the verb with it. Only the number the sentence was given is looked
   at, never a number that came in as someone's name or a title. */
function singular(text, counts) {
  if (!counts.includes(1)) return text;
  return text
    .replace(/(?<![\d.,])1 ([A-Za-z-]+(?: [A-Za-z-]+)?)s\b/g, '1 $1')
    .replace(/(?<![\d.,])(1 [A-Za-z-]+(?: [A-Za-z-]+)?) are\b/g, '$1 is')
    .replace(/(?<![\d.,])(1 [A-Za-z-]+(?: [A-Za-z-]+)?) have\b/g, '$1 has')
    .replace(/(?<![\d.,])(1 [A-Za-z-]+(?: [A-Za-z-]+)?) were\b/g, '$1 was');
}

export function t(korean) {
  const key = korean == null ? '' : String(korean);
  if (lang === 'ko') return key;                    // Korean costs nothing: the table is not consulted
  const en = table[key];
  return typeof en === 'string' && en ? en : key;
}

/* The Korean sentence with {0}, {1}… in it, filled in. The English is looked up first, so the parts
   may sit in a different order there. */
export function T(korean, ...values) {
  const line = t(korean);
  const counts = values.filter(v => typeof v === 'number');
  const filled = line.replace(/\{(\d+)\}/g, (whole, n) => {
    const value = values[Number(n)];
    return value === undefined || value === null ? whole : String(value);
  });
  return lang === 'ko' ? filled : singular(filled, counts);
}

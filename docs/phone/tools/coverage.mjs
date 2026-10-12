/* How much of a paper survives the cleaning, and whether any paper is being gutted.

   The companion to audit.mjs: that one asks what is still read that should not be, this one asks
   what is no longer read that should be. Over-filtering is the worse failure — a paper that comes
   out as five sentences is useless and says nothing about why.

       node docs/phone/tools/coverage.mjs ~/Zotero/storage 200

   On 2026-10-13: 75.5% of the words in the file are read, no paper below a quarter, average
   sentence 21 words. One paper was coming out at 1% before the stamp rules were taught that a
   page arriving as a single line is not a stamp. */
import fs from 'node:fs';
import path from 'node:path';
import {readable, units} from '../read.js';

const root = process.argv[2], want = Number(process.argv[3] || 200);
const all = fs.readdirSync(root).map(d => path.join(root, d, '.zotero-ft-cache')).filter(f => fs.existsSync(f));
const pick = [];
for (let i = 0; i < all.length && pick.length < want; i += Math.max(1, Math.floor(all.length / want))) pick.push(all[i]);

const thin = [], longest = [];
let papers = 0, words = 0, sentences = 0, kept = 0;
for (const file of pick) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
  if (text.length < 4000) continue;
  papers++;
  const raw = (text.match(/\S+/g) || []).length;
  const list = units(readable(text));
  const said = list.reduce((n, u) => n + (u.spoken.match(/\S+/g) || []).length, 0);
  words += raw; kept += said; sentences += list.length;
  const share = said / raw;
  if (share < 0.25) thin.push({file, raw, said, share, n: list.length});
  for (const u of list) if (u.spoken.length > 400) longest.push(u.spoken.slice(0, 160));
}
console.log(`papers ${papers}  words in ${words}  words read ${kept}  (${(kept / words * 100).toFixed(1)}% of the file)`);
console.log(`sentences ${sentences}, average ${Math.round(kept / sentences)} words each`);
console.log(`\npapers where less than a quarter survived: ${thin.length}`);
for (const t of thin.slice(0, 8)) console.log(`   ${(t.share * 100).toFixed(0)}%  ${t.said}/${t.raw} words, ${t.n} sentences  ${t.file.split('/').slice(-2)[0]}`);
console.log(`\n"sentences" over 400 characters: ${longest.length}`);
for (const l of longest.slice(0, 5)) console.log(`   · ${l}`);

/* What read.js still reads aloud that it should not, measured against the real thing.

   Zotero keeps the text it indexed for an attachment at ~/Zotero/storage/<key>/.zotero-ft-cache,
   which is the same text the phone asks the API for. Running the cleaning over a few hundred of
   those says, in numbers, whether a change to read.js helped — which the unit tests, built from
   invented papers, cannot.

       node docs/phone/tools/audit.mjs ~/Zotero/storage 120

   Sentences per paper is the number to watch; it went 564 -> 401 over the cleaning added on
   2026-10-13. The buckets below are deliberately crude and catch real sentences too ("Figure 1D
   presents..."), so read the samples before believing a count. */
import fs from 'node:fs';
import path from 'node:path';
import {readable, units} from '../read.js';

const root = process.argv[2];
const want = Number(process.argv[3] || 120);
const all = fs.readdirSync(root).map(d => path.join(root, d, '.zotero-ft-cache')).filter(f => fs.existsSync(f));
const pick = [];
for (let i = 0; i < all.length && pick.length < want; i += Math.max(1, Math.floor(all.length / want))) pick.push(all[i]);

const SUSPECT = [
  ['running head / journal stamp', /^(?:[A-Z][A-Za-z.\- ]{2,30}(?:et al\.)?,? ?(?:[A-Z][a-z]+ )?\d{1,4}[,:] ?\d+)/],
  ['download stamp', /downloaded from|by guest on|from ?https?:\/\/|user on \d|see the terms and conditions/i],
  ['licence / copyright', /creative commons|all rights reserved|©|copyright ©|this article is licensed|licensed under/i],
  ['reference line', /^\s*\[?\d{1,3}[.\]]\s+[A-Z][a-z]+,? [A-Z]\.(?:[ ,].*)?\(?(?:19|20)\d\d/],
  ['author block / affiliation', /^(?:\d\s*)?(?:Department|Institute|University|College|School) of /],
  ['email / orcid', /@[a-z0-9.-]+\.[a-z]{2,}|orcid\.org/i],
  ['keywords/doi line', /^(?:Keywords?|DOI|https?:\/\/doi)/i],
  ['received/accepted', /^(?:Received|Accepted|Published|Revised)[: ]/i],
  ['table row', /^[\d.\s%±()\-]+$/],
  ['page furniture', /^(?:Page \d+ of \d+|\d+\s*\|\s*\w+|Supplementary|Extended Data Fig)/i],
  ['figure caption leak', /^(?:Fig(?:ure)?\.?\s*\d|Table\s*\d|Supplementary Fig)/i]
];

let papers = 0, sentences = 0;
const hits = new Map();
const samples = new Map();
for (const file of pick) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
  if (text.length < 2000) continue;
  papers++;
  const list = units(readable(text));
  sentences += list.length;
  for (const unit of list) {
    for (const [name, test] of SUSPECT) {
      if (!test.test(unit.spoken)) continue;
      hits.set(name, (hits.get(name) || 0) + 1);
      if (!samples.has(name)) samples.set(name, []);
      if (samples.get(name).length < 3) samples.get(name).push(unit.spoken.slice(0, 120));
    }
  }
}
console.log(`papers ${papers}  sentences ${sentences}  (${Math.round(sentences / papers)} each)`);
for (const [name, n] of [...hits].sort((a, b) => b[1] - a[1])) {
  console.log(`\n${String(n).padStart(5)}  ${name}   (${(n / sentences * 100).toFixed(2)}% of what is read)`);
  for (const s of samples.get(name)) console.log(`        · ${s}`);
}

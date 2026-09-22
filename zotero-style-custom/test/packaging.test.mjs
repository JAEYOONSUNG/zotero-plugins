import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/* What may leave this machine.
   Journal Citation Reports figures are licensed to whoever subscribes to them.
   Both plugins read a subscriber's own export from the Zotero data directory
   and never carry one, and the two builds are written to keep it that way. The
   checks below read the builds themselves rather than trusting a convention,
   because this is the mistake that is expensive to undo: once a release is
   published the file is out, and deleting it afterwards does not recall it. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');
const read = file => fs.readFileSync(file, 'utf8');

/* The names of the four files a reader supplies for themselves. */
const LICENSED = ['jcr-categories.json', 'if-catalog.json', 'journal-registry.json', 'if-jcr-2025.json'];

function styleCustomBuild() {
  const source = read(path.join(ROOT, 'scripts/build.py'));
  const files = [.../^FILES = \[(.*?)\]$/ms.exec(source)[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  const mapped = Object.fromEntries([.../^SOURCE_OF = \{(.*?)\}$/ms.exec(source)[1]
    .matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map(m => [m[1], m[2]]));
  return {files, sourceOf: name => mapped[name] || name};
}

test('the Style Custom build packs no file a reader has to license for themselves', () => {
  const {files, sourceOf} = styleCustomBuild();
  for (const name of files) {
    const from = sourceOf(name);
    assert.ok(!LICENSED.includes(path.basename(from)),
      `${name} would be packed from ${from}, which is a licensed export`);
  }
  // The two that keep their name in the archive have to come from elsewhere.
  for (const name of ['data/if-catalog.json', 'data/journal-registry.json']) {
    assert.notEqual(sourceOf(name), name, `${name} must be packed from an openly licensed build`);
    assert.match(sourceOf(name), /\.open\.json$/);
  }
});

test('the ZotPoP build packs no file a reader has to license for themselves', () => {
  const source = read(path.join(REPO, 'scripts/build.sh'));
  assert.match(source, /skip = \{[^}]*"jcr-2025-data\.js"/, 'the licensed table is skipped by name');
  // It copies a registry in beside the code, and only the open build of one.
  assert.match(source, /rm -f content\/journal-registry\.json/);
  assert.match(source, /journal-registry\.open\.json/);
  assert.doesNotMatch(source, /cp zotero-style-custom\/data\/journal-registry\.json/);
});

test('every journal table that ships says where it came from, and it is not Clarivate', () => {
  const {files, sourceOf} = styleCustomBuild();
  const catalog = JSON.parse(read(path.join(ROOT, sourceOf('data/journal-catalog.json'))));
  assert.equal(catalog.source.provider, 'OpenAlex');
  assert.match(String(catalog.source.license || catalog.source.licence), /CC0/i);
  assert.doesNotMatch(JSON.stringify(catalog.source), /clarivate/i);
  // No field in the shipped catalogue may be named for the figure it is not.
  const names = new Set(Object.keys(catalog.journals[0]).concat(Object.keys(catalog.categories[0])));
  for (const name of names) assert.doesNotMatch(name, /jif|impactfactor/i, `${name} names the wrong figure`);
  assert.ok(files.includes('data/journal-catalog.json'));
});

test('a figure that came from a publisher names the page it was read from, and there are few of them', () => {
  const {sourceOf} = styleCustomBuild();
  const file = path.join(ROOT, sourceOf('data/if-catalog.json'));
  if (!fs.existsSync(file)) return; // assembled by the build; a fresh checkout has not run it yet
  const records = JSON.parse(read(file));
  const cited = records.filter(row => /clarivate/i.test(JSON.stringify(row)));
  // A publisher printing its own journal's impact factor on its own page, with
  // the page named, is a citation. A table of them would be the database again.
  assert.ok(cited.length <= 100, `${cited.length} records mention Clarivate; a handful of citations is the most that can be`);
  for (const row of cited) {
    assert.doesNotMatch(String(row.sourceURL), /clarivate\.com/i, `${row.title} points at Clarivate itself`);
    assert.ok(String(row.evidence || '').trim(), `${row.title} cites no page`);
  }
  const estimates = records.filter(row => row.metric === 'openalex-2yr-mean-citedness');
  assert.ok(estimates.length > 1000, 'the open figures are the body of the table');
  for (const row of estimates.slice(0, 200)) {
    assert.match(String(row.evidence), /not the Journal Impact Factor/i,
      `${row.title} does not disown the name`);
  }
});

test('the licensed files are ignored by git, so they cannot be committed back by accident', () => {
  const ignores = read(path.join(ROOT, '.gitignore')) + read(path.join(REPO, '.gitignore'));
  for (const name of LICENSED) {
    assert.ok(ignores.includes(name), `${name} is not in either .gitignore`);
  }
  assert.ok(ignores.includes('jcr-2025-data.js'));
});

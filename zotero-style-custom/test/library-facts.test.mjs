import test from 'node:test';
import assert from 'node:assert/strict';
import LF from '../src/library-facts.js';
const {libraryFacts, factsFor, countriesOf, bandOf} = LF;

test('the countries a paper was written in, the corresponding author first', () => {
  const people = [
    {name: 'A', country: 'cn', corresponding: false},
    {name: 'B', country: 'CN', corresponding: false},
    {name: 'C', country: 'KR', corresponding: true},
    {name: 'D', country: 'US', corresponding: false}
  ];
  const {countries, lead} = countriesOf(people);
  assert.equal(lead, 'KR');
  assert.equal(countries[0], 'KR', 'whose paper it is comes first, even with fewer authors');
  assert.deepEqual([...countries].sort(), ['CN', 'KR', 'US']);
  // Case is settled, nonsense is dropped, and a row on a phone never gets more than a handful.
  assert.deepEqual(countriesOf([{country: 'Korea'}, {country: ''}, {country: null}]).countries, []);
  assert.equal(countriesOf([]).lead, '');
  assert.equal(countriesOf(null).countries.length, 0);
  const many = Array.from({length: 9}, (_, i) => ({country: ['AA','BB','CC','DD','EE','FF','GG','HH','II'][i]}));
  assert.equal(countriesOf(many).countries.length, 4);
});

test('a paper carries only what the phone cannot work out for itself', () => {
  const facts = factsFor({
    item: {metrics: {impactFactor: 35.1134, citations: 12}, seconds: 3119.4},
    work: {venue: 'Nature Reviews Microbiology', year: 2026, citations: 9,
           people: [{country: 'US', corresponding: true}, {country: 'GB'}]}
  });
  assert.deepEqual(facts, {jif: 35.11, cited: 12, venue: 'Nature Reviews Microbiology', year: 2026,
                           from: ['US', 'GB'], lead: 'US', seconds: 3119});
  assert.ok(!('title' in facts), 'the phone has the title from Zotero already');
  // The paper's own citation count wins over the work's, and a paper with nothing to add is left out.
  assert.equal(factsFor({item: {}, work: {citations: 7}}).cited, 7);
  assert.equal(factsFor({item: {}, work: {}}), null);
  assert.equal(factsFor({}), null);
  // A zero is news; a missing figure is not the same as zero.
  assert.equal(factsFor({item: {metrics: {citations: 0}}}).cited, 0);
  assert.ok(!('jif' in factsFor({item: {metrics: {citations: 0}}})));
});

test('the whole library becomes one small file, keyed the way the phone knows a paper', () => {
  const out = libraryFacts({
    items: {'1:AAA': {metrics: {impactFactor: 50, citations: 3}}, '1:BBB': {}},
    works: {'1:AAA': {venue: 'Nature', year: 2024, people: [{country: 'KR', corresponding: true}]},
            '1:CCC': {venue: 'Science', year: 2020, citations: 11}},
    journalMetrics: {'issn:1': {name: 'Nature', country: 'GB', hIndex: 1845, citedness: 72.5, isOA: false, publisher: 'Springer'},
                     'issn:2': {name: 'Nature', country: 'GB'},
                     'issn:3': {name: '', country: 'US'}}
  }, {made: '2026-10-14T00:00:00Z'});
  assert.equal(out.v, 1);
  assert.equal(out.made, '2026-10-14T00:00:00Z');
  // The library number is not part of how the phone knows a paper.
  assert.deepEqual(Object.keys(out.papers).sort(), ['AAA', 'CCC']);
  assert.equal(out.papers.AAA.jif, 50);
  assert.equal(out.papers.AAA.lead, 'KR');
  assert.equal(out.papers.CCC.cited, 11);
  // A journal is said once however many papers are in it, and one with no name is not a journal.
  assert.deepEqual(Object.keys(out.journals), ['Nature']);
  assert.deepEqual(out.journals.Nature, {country: 'GB', h: 1845, perPaper: 72.5, publisher: 'Springer'});
  assert.equal(libraryFacts({}).papers && Object.keys(libraryFacts({}).papers).length, 0);
});

test('the bands are the ones a reader already thinks in, and nothing is a band by accident', () => {
  assert.equal(bandOf(35.1), 'top');
  assert.equal(bandOf(30), 'top');
  assert.equal(bandOf(29.9), 'high');
  assert.equal(bandOf(10), 'high');
  assert.equal(bandOf(9.9), 'mid');
  assert.equal(bandOf(5), 'mid');
  assert.equal(bandOf(4.9), 'low');
  assert.equal(bandOf(0.4), 'low');
  // No figure is not a low figure.
  for (const nothing of [0, -1, null, undefined, '', NaN, 'Nature']) assert.equal(bandOf(nothing), '', String(nothing));
});

test('the real library fits in a file a phone can fetch at once', async () => {
  const fs = await import('node:fs');
  const path = `${process.env.HOME}/Zotero/style-custom.json`;
  if (!fs.existsSync(path)) return;                    // not this machine; the shape is covered above
  const out = libraryFacts(JSON.parse(fs.readFileSync(path, 'utf8')));
  const size = JSON.stringify(out).length;
  assert.ok(Object.keys(out.papers).length > 100, 'the library came through');
  assert.ok(size < 2 * 1024 * 1024, `${(size / 1024).toFixed(0)}KB is too much to hand a phone`);
  // Nothing of the paper itself leaks into a file that sits in a sync folder.
  const text = JSON.stringify(out);
  assert.ok(!/abstract/i.test(text));
  for (const paper of Object.values(out.papers)) {
    assert.ok(!('title' in paper) && !('authors' in paper));
  }
});

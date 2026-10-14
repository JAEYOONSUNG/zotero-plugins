import test from 'node:test';
import assert from 'node:assert/strict';
import LF from '../src/library-facts.js';
const {libraryFacts, factsFor, countriesOf, readingOf, bandOf, MARKS} = LF;

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
  assert.equal(out.v, 2);
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

test('how far a paper was read: the furthest record wins, and a stale bookmark is not a finished paper', () => {
  // Zotero's bookmark at page 12 of 18, the plugin's own clock with 2 pages dwelt on of 18.
  assert.deepEqual(readingOf({places: [{page: 12, pages: 18}], visited: 2, total: 18}),
                   {read: 67, page: 12, pages: 18});
  // Pages dwelt on can be the further of the two, and then they are what is reported.
  assert.deepEqual(readingOf({places: [{page: 2, pages: 10}], visited: 9, total: 10}),
                   {read: 90, page: 2, pages: 10});
  // Two PDFs, each with its own page count: the one further through the paper answers.
  assert.deepEqual(readingOf({places: [{page: 9, pages: 40}, {page: 3, pages: 4}]}),
                   {read: 75, page: 3, pages: 4});
  // A bookmark past the end of its file is a stale record from a replaced PDF, not a finished read.
  assert.equal(readingOf({places: [{page: 30, pages: 9}]}), null);
  // A page with no count behind it still says the paper was opened there.
  assert.deepEqual(readingOf({places: [{page: 4, pages: 0}]}), {page: 4});
  /* Two records of the same file are one place. Zotero's bookmark at page 12 of a file its index
     never counted, and this plugin's own first page of 18: twelve pages in, not one. */
  assert.deepEqual(readingOf({places: [{page: 12, pages: 0, file: 100}, {page: 1, pages: 18, file: 100}]}),
                   {read: 67, page: 12, pages: 18});
  // A different file is a different place, and the further through the paper wins.
  assert.deepEqual(readingOf({places: [{page: 12, pages: 0, file: 100}, {page: 9, pages: 10, file: 200}]}),
                   {read: 90, page: 9, pages: 10});
  // One stale page in a file does not throw away the sound record beside it.
  assert.deepEqual(readingOf({places: [{page: 30, pages: 9, file: 100}, {page: 4, pages: 0, file: 100}]}),
                   {read: 44, page: 4, pages: 9});
  // A paper barely opened is not a paper unread, so the smallest share still shows.
  assert.equal(readingOf({places: [{page: 1, pages: 400}]}).read, 1);
  // Reading time and the day it was last read ride along; anything else is not a date.
  assert.deepEqual(readingOf({seconds: 3119.6, at: '2026-10-14T07:07:30.482Z'}), {seconds: 3120, at: '2026-10-14'});
  assert.ok(!('at' in (readingOf({seconds: 10, at: 'yesterday'}) || {})));
  // Nothing known is nothing sent.
  assert.equal(readingOf({}), null);
  assert.equal(readingOf(), null);
  assert.equal(readingOf({places: 'all of them', visited: -3, total: 0}), null);
});

test('a paper carries how far it was read and the colour it was marked with', () => {
  const facts = factsFor({item: {highlight: 'teal'}, work: {venue: 'Nature'},
                          reading: {read: 67, page: 12, pages: 18, seconds: 600, at: '2026-10-01'}});
  assert.deepEqual(facts, {venue: 'Nature', read: 67, page: 12, pages: 18, seconds: 600, at: '2026-10-01', mark: 'teal'});
  // The reading record wins over the plain total the item carries, because it counted the same clock.
  assert.equal(factsFor({item: {seconds: 10}, work: {venue: 'Nature'}, reading: {seconds: 600}}).seconds, 600);
  assert.equal(factsFor({item: {seconds: 10}, work: {venue: 'Nature'}}).seconds, 10);
  // Only the seven colours the plugin offers, and nothing invented.
  assert.deepEqual(MARKS, ['red', 'orange', 'gold', 'green', 'teal', 'blue', 'purple']);
  assert.ok(!('mark' in factsFor({item: {highlight: 'chartreuse'}, work: {venue: 'Nature'}})));
  // A figure out of range is brought back into it rather than passed on.
  assert.equal(factsFor({item: {}, work: {venue: 'Nature'}, reading: {read: 140}}).read, 100);
  assert.ok(!('page' in factsFor({item: {}, work: {venue: 'Nature'}, reading: {page: -2}})));
});

test('a journal is sent in its own signature ink, and an unknown journal is sent without one', () => {
  const inks = {Nature: {ink: '#c6004f', inkDark: '#ff6ba6'}};
  const out = libraryFacts({
    items: {'1:AAA': {metrics: {impactFactor: 50}}, '1:BBB': {metrics: {impactFactor: 2}}},
    works: {'1:AAA': {venue: 'Nature'}, '1:BBB': {venue: 'Journal of Nothing Known'}},
    journalMetrics: {'issn:1': {name: 'Nature', country: 'GB', hIndex: 1845}}
  }, {made: '2026-10-14T00:00:00Z', inkOf: name => inks[name] || null});
  assert.deepEqual(out.journals.Nature, {country: 'GB', h: 1845, ink: '#c6004f', inkDark: '#ff6ba6'});
  // A journal no row has metrics for still gets its ink, and an unknown one is left plain.
  assert.ok(!('Journal of Nothing Known' in out.journals), 'grey is not a colour worth sending');
  const both = libraryFacts({works: {'1:AAA': {venue: 'Cell'}}, items: {'1:AAA': {metrics: {citations: 1}}}},
                            {inkOf: () => ({ink: '#006fa8', inkDark: '#42c0ff'})});
  assert.deepEqual(both.journals.Cell, {ink: '#006fa8', inkDark: '#42c0ff'});
  // Both halves of a colour or none: a phone cannot draw a dark theme out of a light ink.
  assert.equal(Object.keys(libraryFacts({works: {'1:A': {venue: 'Cell'}}, items: {'1:A': {metrics: {citations: 1}}}},
    {inkOf: () => ({ink: '#006fa8'})}).journals).length, 0);
  // A lookup that throws loses its colour, not the file.
  assert.ok(libraryFacts({works: {'1:A': {venue: 'Cell'}}, items: {'1:A': {metrics: {citations: 1}}}},
    {inkOf: () => { throw new Error('no registry'); }}).papers.A);
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

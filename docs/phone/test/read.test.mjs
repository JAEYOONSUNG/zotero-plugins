/* What is read out loud, from the text Zotero indexed. The sample below is the shape a journal
   PDF really comes back in: a running head on every page, a download stamp, hyphens at the ends
   of lines, figure captions in the middle of the body, and a reference list at the end. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readable, units, splitSentences, spokenForm, repeatedLines, remainingSeconds} from '../read.js';

const PAPER = [
  // page 1
  `Seo et al., Science 387, 41 (2026)
RESEARCH ARTICLE

Landscape profiling of PET depolymerases

Enzymes capable of breaking down polymers have been identified from natural sources. We gener-
ated a landscape of 170 lineages of 1894 polyethylene terephthalate candidates [1].

Downloaded from https://www.science.org at Yonsei University on February 11, 2026

1`,
  // page 2
  `Seo et al., Science 387, 41 (2026)

Introduction

Microbial decomposers can degrade newly encountered materials (Smith et al., 2019). The iso-
lation of Ideonella sakaiensis exemplifies this evolutionary concept (fig. S3).

Fig. 1. The landscape of the PETase family, coloured by cluster.

2`,
  // page 3
  `Seo et al., Science 387, 41 (2026)

Results

A primary screening was conducted by using representative nodes from 164 clusters [2,3]. Of 105
nodes, 58 released detectable monomer.

Downloaded from https://www.science.org at Yonsei University on February 11, 2026

3`,
  // page 4
  `Seo et al., Science 387, 41 (2026)

References

1. H. Seo, J. Park, Nature 500, 1 (2019).
2. K. Kim, Science 300, 20 (2020).

4`
].join('\f');

test('the running head, the download stamp and the page numbers are not read', () => {
  const paper = readable(PAPER, {title: 'Landscape profiling of PET depolymerases'});
  const said = units(paper).map(u => u.spoken).join(' ');
  assert.ok(!/Seo et al\., Science/.test(said), 'the running head is gone');
  assert.ok(!/Downloaded from/.test(said), 'the download stamp is gone');
  assert.ok(!/^\s*\d+\s*$/m.test(said), 'no bare page numbers');
  assert.ok(/Microbial decomposers/.test(said), 'the body is still there');
});

test('the reference list is where the reading stops', () => {
  const paper = readable(PAPER);
  const said = units(paper).map(u => u.spoken).join(' ');
  assert.ok(!/Nature 500/.test(said));
  assert.ok(!/K\. Kim/.test(said));
  assert.ok(/released detectable monomer/.test(said), 'the last body sentence is kept');
});

test('captions are set aside and read only when asked for', () => {
  const paper = readable(PAPER);
  assert.equal(paper.captions.length, 1);
  assert.ok(!units(paper).some(u => /coloured by cluster/.test(u.spoken)));
  assert.ok(units(paper, {captions: true}).some(u => /coloured by cluster/.test(u.spoken)));
});

test('a word broken across a line is put back together', () => {
  const paper = readable(PAPER);
  const said = units(paper).map(u => u.spoken).join(' ');
  assert.ok(/generated a landscape/.test(said), '"gener-\\nated" is one word');
  assert.ok(/isolation of Ideonella/.test(said), '"iso-\\nlation" is one word');
  assert.ok(!/gener- ?ated/.test(said));
});

test('the sentence on screen keeps its citations and what is said drops them', () => {
  const paper = readable(PAPER);
  const list = units(paper);
  const screen = list.find(u => /candidates/.test(u.text));
  assert.ok(/\[1\]/.test(screen.text), 'the text shown keeps [1]');
  assert.ok(!/\[1\]/.test(screen.spoken), 'what is said does not');
  const smith = list.find(u => /Microbial decomposers/.test(u.text));
  assert.ok(!/Smith et al/.test(smith.spoken));
  const fig = list.find(u => /Ideonella/.test(u.text));
  assert.ok(!/fig\. S3/.test(fig.spoken));
});

test('the section heading travels with the first sentence under it', () => {
  const list = units(readable(PAPER));
  const first = list.find(u => /Microbial decomposers/.test(u.text));
  assert.equal(first.section, 'Introduction');
  assert.equal(first.lead, 'Introduction');
  const second = list.find(u => /Ideonella/.test(u.text));
  assert.equal(second.lead, '', 'only the first one carries it');
});

test('every sentence says which page it came from, for picking up where you left off', () => {
  const list = units(readable(PAPER));
  assert.equal(list.find(u => /Microbial decomposers/.test(u.text)).page, 2);
  assert.equal(list.find(u => /primary screening/.test(u.text)).page, 3);
});

test('a repeated line is only dropped when it repeats across pages, not when it is a real sentence', () => {
  const pages = ['Head\nThe cell divides.', 'Head\nThe cell divides.', 'Head\nMore text here.', 'Head\nAnd more.'];
  const repeats = repeatedLines(pages);
  assert.ok(repeats.has('head'));
  assert.ok(!repeats.has('the cell divides.'), 'a sentence on two of four pages stays');
});

test('a paper of two pages drops the stamp on both of them but keeps a repeated sentence', () => {
  const repeats = repeatedLines(['Science 387 (2026)\nThe cell divides.', 'Science 387 (2026)\nThe cell divides.']);
  assert.ok(repeats.has('science # (#)'), 'the journal stamp goes');
  assert.ok(!repeats.has('the cell divides.'), 'something that reads as a sentence stays');
  assert.equal(repeatedLines(['only one page']).size, 0);
});

test('sentences break where a reader would, not at every full stop', () => {
  assert.deepEqual(splitSentences('We used E. coli cells. They grew well.'), ['We used E. coli cells.', 'They grew well.']);
  assert.deepEqual(splitSentences('See fig. 2 for the yield. It rose.'), ['See fig. 2 for the yield.', 'It rose.']);
  assert.deepEqual(splitSentences('J. Smith agreed. So did we.'), ['J. Smith agreed.', 'So did we.']);
  assert.deepEqual(splitSentences('이 효소는 분해한다. 그리고 빠르다.'), ['이 효소는 분해한다.', '그리고 빠르다.']);
});

test('what is spoken keeps its punctuation tidy after the citations go', () => {
  assert.equal(spokenForm('The yield rose [1], and fell (Smith et al., 2019).'), 'The yield rose, and fell.');
  assert.equal(spokenForm('As shown (Fig. 2), it works.'), 'As shown, it works.');
});

test('a row of numbers from a table is not offered as a sentence', () => {
  const paper = readable('Intro\n\n12.4 56.7 89.1 0.02\n\nThe enzyme works well at fifty degrees.');
  const said = units(paper).map(u => u.spoken);
  assert.ok(said.some(s => /enzyme works well/.test(s)));
  assert.ok(!said.some(s => /12\.4 56\.7/.test(s)));
});

test('how long is left is counted from the words still to come', () => {
  const list = units(readable(PAPER));
  const whole = remainingSeconds(list, 0, 1);
  assert.ok(whole > 0);
  assert.ok(remainingSeconds(list, list.length - 1, 1) < whole);
  assert.ok(remainingSeconds(list, 0, 2) < whole, 'twice the speed is half the time');
});

test('text with no pages and no furniture still reads', () => {
  const paper = readable('One sentence here. And another one after it.');
  assert.equal(units(paper).length, 2);
  assert.equal(paper.stats.pages, 1);
});

test('nothing to read gives nothing, not a crash', () => {
  assert.deepEqual(units(readable('')), []);
  assert.deepEqual(units(readable(null)), []);
});

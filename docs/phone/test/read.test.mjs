/* What is read out loud, from the text Zotero indexed. The sample below is the shape a journal
   PDF really comes back in: a running head on every page, a download stamp, hyphens at the ends
   of lines, figure captions in the middle of the body, and a reference list at the end. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readable, units, splitSentences, spokenForm, withoutCitations, repeatedLines, remainingSeconds, stripStamp, isAuthorList, breakLong, LONG} from '../read.js';

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

/* The commonest citation in these papers is invisible in the text Zotero hands over: the
   superscript that marked it is gone, so what is left is a number glued to a word and read out
   in the middle of a clause. Every line below is from a paper in the library. */
test('a citation that lost its superscript is not read as a number', () => {
  assert.equal(spokenForm('Many antiviral defence mechanisms are conserved across all domains of life1.'),
    'Many antiviral defence mechanisms are conserved across all domains of life.');
  assert.equal(spokenForm('the same organism and even single cell1,2, and STING12,13 after that.'),
    'the same organism and even single cell, and STING after that.');
  assert.equal(spokenForm('First engineering was introduced with E. coli (Jiang et al, 2013).'),
    'First engineering was introduced with E. coli.');
  assert.equal(spokenForm('including Lactobacillus reuteri (Oh and van Pijkeren, 2014) and Streptomyces (Smith, 2014; Lee, 2015).'),
    'including Lactobacillus reuteri and Streptomyces.');
  assert.equal(spokenForm('unleashes indiscriminate DNase activity (12, 13) upon binding (3-5).'),
    'unleashes indiscriminate DNase activity upon binding.');
});

test('a number inside a name is not a citation', () => {
  const kept = 'Plasmid pGKE75 was expressed from the gk704 promoter in B. subtilis ATCC6051 with Cas9, Tn21, p53, IS110 and BL21(DE3) at OD600.';
  assert.equal(spokenForm(kept), kept);
  assert.equal(spokenForm('shown in figure3 and table2 for type1 and lane2.'), 'shown in figure3 and table2 for type1 and lane2.');
  assert.equal(withoutCitations('The result (which we confirmed in 2015) held.'), 'The result (which we confirmed in 2015) held.',
    'a bracket with something to say in it is part of the paper');
  assert.equal(withoutCitations('A sentence with nothing to take out.'), 'A sentence with nothing to take out.');
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

/* What a real journal PDF puts in front of the paper, and at the back of it. Every line below was
   taken from the text Zotero had indexed for a paper in the library and was being read out loud. */
const REAL_FRONT = `Seo et al., Nature 601, 1 (2026)

Landscape profiling of PET depolymerases

Hyun Seo1, Jan Müller2, Jae Yoon Sung1

1Department of Biotechnology, Yonsei University, Seoul, Korea. 2Institute of Molecular Biology, Mainz, Germany.
9These authors contributed equally: Hyun Seo, Jan Müller. e-mail: seo@yonsei.ac.kr 1234567890():,; 1234567890():,;
Received: 11 June 2022 Accepted: 7 November 2022 Check for updates
https://doi.org/10.1038/s41586-022-05432-3
Keywords: PET, depolymerase, plastics

Abstract

Enzymes capable of breaking down polymers have been identified from natural sources.

Open Access This article is licensed under a Creative Commons Attribution 4.0 International License, which permits use, sharing, adaptation and reproduction in any medium.

Introduction

The isolation of Ideonella sakaiensis exemplifies this evolutionary concept.`;

test('nothing in front of the paper is read: who wrote it, where, when it arrived, or its licence', () => {
  const said = units(readable(REAL_FRONT, {title: 'Landscape profiling of PET depolymerases'})).map(u => u.spoken).join(' ');
  assert.ok(/Enzymes capable of breaking down/.test(said), 'the abstract is read');
  assert.ok(/Ideonella/.test(said), 'and so is the introduction');
  assert.ok(!/yonsei\.ac\.kr/.test(said), 'the address to write to is not');
  assert.ok(!/Department of Biotechnology/.test(said), 'nor where they work');
  assert.ok(!/Received: 11 June/.test(said), 'nor when it arrived');
  assert.ok(!/Creative Commons/.test(said), 'nor the licence');
  assert.ok(!/1234567890/.test(said), 'nor the glyph table the PDF left behind');
  assert.ok(!/Keywords/.test(said), 'nor the keyword line');
  assert.ok(!/doi\.org/.test(said), 'nor the DOI');
});

test('an address in the body is still read, because by then the paper has begun', () => {
  const paper = `Methods

We obtained the strains from the collection. The data are at https://example.org and requests go to lab@uni.edu for the plasmids.`;
  const said = units(readable(paper)).map(u => u.spoken).join(' ');
  assert.ok(/requests go to/.test(said), 'a sentence of the paper is not thrown away for holding an address');
});

test('a caption that shares a block with the paragraph above it is still set aside', () => {
  const paper = `Results

The enzyme works well in water.
Fig. 5 | Schematic representation of the mechanism.`;
  const list = units(readable(paper));
  assert.deepEqual(list.map(u => u.spoken), ['The enzyme works well in water.']);
  assert.equal(readable(paper).captions.length, 1);
  assert.ok(units(readable(paper), {captions: true}).some(u => /Schematic representation/.test(u.spoken)));
});

test('a journal stamp run together with the first words of a page loses the stamp, not the words', () => {
  const paper = `Introduction

802 | VOL.11 NO.8 | AUGUST 2014 | nature methods Doing this for the first time can be challenging.`;
  const said = units(readable(paper)).map(u => u.spoken).join(' ');
  assert.ok(/Doing this for the first time can be challenging/.test(said), 'the words are kept');
  assert.ok(!/VOL\.11|nature methods/.test(said), 'the stamp is gone');
  assert.equal(stripStamp('5 | Cell 182 | July 2020 | The cell divides.'), 'The cell divides.');
  assert.equal(stripStamp('An ordinary sentence.'), 'An ordinary sentence.');
});

test('a reference that ran on without a heading is not read as a sentence', () => {
  const paper = `Discussion

The result holds across species.

12. H. Seo, J. Park, Nature 500, 1 (2019).
13. K. Kim et al., Science 300, 20 (2020).`;
  const said = units(readable(paper)).map(u => u.spoken).join(' ');
  assert.ok(/The result holds/.test(said));
  assert.ok(!/H\. Seo/.test(said));
  assert.ok(!/K\. Kim/.test(said));
});

/* Some PDFs come out of extraction with hardly any line breaks: a whole page arrives as one
   line. A rule that condemns a line for containing a stamp would then throw the page away. */
test('a page that arrives as one long line is still read', () => {
  const page = 'The enzyme was purified to homogeneity and assayed at fifty degrees. ' +
    'Activity rose with temperature up to sixty degrees, where it fell sharply. ' +
    'Downloaded from https://www.science.org at Yonsei University on February 11, 2026 ' +
    'The same pattern was seen for the variant.';
  const said = units(readable(page)).map(u => u.spoken).join(' ');
  assert.ok(/purified to homogeneity/.test(said), 'the page is not thrown away');
  assert.ok(/pattern was seen for the variant/.test(said), 'nor the end of it');
});

test('a short line that is nothing but a stamp still goes', () => {
  const paper = 'Introduction\n\nDownloaded from https://www.science.org on 11 February 2026\n\nThe enzyme works.';
  const said = units(readable(paper)).map(u => u.spoken).join(' ');
  assert.ok(!/Downloaded from/.test(said));
  assert.ok(/The enzyme works/.test(said));
});

test('the line of authors under the title is not read, however long it runs', () => {
  const line = 'Amika Kikuchi 1,9, Hiroki Onoda1,8,9, Kosuke Yamaguchi2, Satomi Kori1, Shun Matsuzawa1, Yoshie Chiba 3';
  assert.equal(isAuthorList(line), true);
  assert.equal(isAuthorList('We tested the enzyme at 30, 40, 50 and 60 degrees. It worked.'), false,
    'a sentence that happens to list numbers is not an author list');
  const said = units(readable(`${line}\n\nAbstract\n\nThe enzyme degrades PET.`)).map(u => u.spoken).join(' ');
  assert.ok(!/Kikuchi/.test(said));
  assert.ok(/degrades PET/.test(said));
});

test('a run too long to say in one breath is broken where a reader would pause', () => {
  const long = 'First we describe the setup in some detail so that it can be repeated in another laboratory without trouble; ' +
    'then we give the measurements that were taken over the whole range of temperatures studied, in triplicate, on three days; ' +
    'and finally we set out what we think it means for the field as a whole and for the experiment that ought to come next; ' +
    'the appendix holds the raw numbers and the scripts that produced every figure in this paper.';
  assert.ok(long.length > 400, 'the sample is long enough to need breaking');
  const pieces = breakLong(long);
  assert.ok(pieces.length >= 2, 'it is broken up');
  assert.ok(pieces.every(p => p.length < long.length));
  assert.equal(pieces.join(' ').replace(/\s+/g, ' '), long.replace(/\s+/g, ' '), 'and nothing is lost');
  assert.deepEqual(breakLong('Short enough already.'), ['Short enough already.']);
});

test('a semicolon inside brackets is a list, not a pause', () => {
  const long = 'Previous structures of the enzyme were solved in several states ' + 'x'.repeat(260) +
    ' (PDB:4DA4, aa:731-1602; 6X9I, aa:729-1600) and all of them agree with what is reported here.';
  const pieces = breakLong(long);
  assert.equal(pieces.length, 1, 'it was not cut inside the bracket');
});

test('the reference list is kept, so it can be read when it is asked for', () => {
  const raw = [
    'Introduction', '', 'The body is here. It has two sentences.', '',
    'Acknowledgements', '', 'We thank the funders of this work.', '',
    'References', '',
    'Smith J. 2020. A thermostable polymerase. Nature 1:2-3.', '',
    'Lee K, Park H. 2021. Another paper entirely. Cell 4:5-6.', ''
  ].join('\n');
  const paper = readable(raw, {title: ''});
  // Only the references are kept; funding and acknowledgements are not something anyone asks to hear.
  assert.deepEqual(paper.references.map(r => r.text), [
    'Smith J. 2020. A thermostable polymerase. Nature 1:2-3.',
    'Lee K, Park H. 2021. Another paper entirely. Cell 4:5-6.'
  ]);
  assert.ok(!JSON.stringify(paper.sections).includes('thank the funders'));
  assert.ok(!JSON.stringify(paper.sections).includes('Smith J.'), 'and they are not read with the body');

  // Three steps, each adding to the one before it.
  const body = units(paper);
  assert.deepEqual(body.map(u => u.kind || 'body'), ['body', 'body']);
  const withRefs = units(paper, {captions: true, references: true});
  assert.deepEqual(withRefs.slice(-2).map(u => u.kind), ['reference', 'reference']);
  assert.equal(withRefs.at(-1).section, '참고문헌');
  // An entry is one thing to hear, not four sentences.
  assert.equal(withRefs.at(-2).text, 'Smith J. 2020. A thermostable polymerase. Nature 1:2-3.');
  assert.deepEqual(units(paper, {references: false}).map(u => u.kind || 'body'), ['body', 'body']);
  // The index is still the position in whatever list was asked for.
  assert.deepEqual(withRefs.map(u => u.index), withRefs.map((_, i) => i));
});

test('a long entry is broken where its writer paused, and a stray page number is not an entry', () => {
  // Author lists run long. breakLong cuts at the pauses a writer put in -- never mid-word, and never
  // at a comma, which in a reference is part of a name rather than a breath.
  const semis = 'Smith J; Lee K; Park H; ' + 'Kim M; '.repeat(70) + '2024. A paper with very many authors. Journal 9:1-2.';
  const commas = 'Author A, ' + 'Author B, '.repeat(60) + 'and Author Z. 2024. Another. Cell 4:5-6.';
  const raw = ['Introduction', '', 'Body sentence here.', '', 'References', '', semis, '', commas, '', '12.', '', 'ibid.', ''].join('\n');
  const paper = readable(raw, {title: ''});
  assert.equal(paper.references.length, 2, paper.references.map(r => r.text.slice(0, 30)).join(' | '));
  // "12." is a stray page number and "ibid." is too short to be an entry.
  assert.ok(!paper.references.some(r => /^(?:12\.|ibid\.)$/.test(r.text)));

  const list = units(paper, {references: true}).filter(u => u.kind === 'reference');
  const fromSemis = list.filter(u => u.text.includes('Kim M'));
  assert.ok(fromSemis.length > 1, 'the one with pauses in it was broken at them');
  for (const unit of fromSemis) assert.ok(unit.text.length <= LONG, `${unit.text.length} > ${LONG}`);
  // The one that is all commas stays whole: breaking a name list at a comma reads as a new entry.
  assert.equal(list.filter(u => u.text.includes('Author B')).length, 1);
  // Nothing is lost either way.
  assert.equal(list.map(u => u.text).join(' ').replace(/\s+/g, ' '), `${semis} ${commas}`.replace(/\s+/g, ' '));
});

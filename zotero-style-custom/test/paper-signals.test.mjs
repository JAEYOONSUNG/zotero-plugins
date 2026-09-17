import test from 'node:test';
import assert from 'node:assert/strict';
import signals from '../src/paper-signals.js';

// Trimmed from the live responses. Recorded 2026-09-17 against
// api.crossref.org and api.openalex.org; see the module header for the field
// names these fixtures exist to pin down.
const WAKEFIELD = {message: {
  DOI: '10.1016/S0140-6736(97)11096-0', type: 'journal-article',
  title: ['RETRACTED: Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children'],
  'updated-by': [
    {DOI: '10.1016/s0140-6736(04)15715-2', type: 'correction', label: 'Correction', source: 'retraction-watch',
      updated: {'date-parts': [[2004, 3, 6]]}},
    {DOI: '10.1016/s0140-6736(10)60175-4', type: 'retraction', label: 'Retraction', source: 'retraction-watch',
      updated: {'date-parts': [[2010, 2, 6]]}}
  ],
  relation: {}
}};

const RETRACTION_NOTICE = {message: {
  DOI: '10.1016/s0140-6736(10)60175-4', type: 'journal-article',
  title: ['Retraction—Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children'],
  'update-to': [{DOI: '10.1016/s0140-6736(97)11096-0', type: 'retraction', label: 'Retraction',
    source: 'retraction-watch', updated: {'date-parts': [[2010, 2, 6]]}}],
  relation: {}
}};

// Real duplication: the publisher and Retraction Watch both deposit the same
// notice, with different dates.
const CONCERN = {message: {
  DOI: '10.1016/j.lungcan.2003.10.006', type: 'journal-article', title: ['Recoverin as a paraneoplastic antigen'],
  'updated-by': [
    {DOI: '10.1016/j.lungcan.2026.109332', type: 'expression_of_concern', label: 'Expression of concern',
      source: 'publisher', updated: {'date-parts': [[2026, 2, 13]]}},
    {DOI: '10.1016/j.lungcan.2026.109332', type: 'expression_of_concern', label: 'Expression of concern',
      source: 'publisher', updated: {'date-parts': [[2026, 5, 1]]}}
  ],
  relation: {}
}};

const CLEAN = {message: {
  DOI: '10.1038/s41467-024-48219-y', type: 'journal-article',
  title: ['An antiplasmid system drives antibiotic resistance gene integration'],
  'update-policy': 'https://doi.org/10.1007/springer_crossmark_policy', relation: {}
}};

const GOLD_WORK = {
  id: 'https://openalex.org/W4396930067', doi: 'https://doi.org/10.1038/s41467-024-48219-y',
  title: 'An antiplasmid system', type: 'article', publication_year: 2024, is_retracted: false,
  open_access: {is_oa: true, oa_status: 'gold', oa_url: 'https://www.nature.com/articles/s41467-024-48219-y.pdf'},
  primary_location: {version: 'publishedVersion', is_oa: true, landing_page_url: 'https://doi.org/10.1038/s41467-024-48219-y',
    source: {display_name: 'Nature Communications', type: 'journal'}},
  locations: [{version: 'publishedVersion', is_oa: true, landing_page_url: 'https://doi.org/10.1038/s41467-024-48219-y',
    source: {display_name: 'Nature Communications', type: 'journal'}}]
};

const CLOSED_RETRACTED_WORK = {
  id: 'https://openalex.org/W2117847125', doi: 'https://doi.org/10.1016/s0140-6736(97)11096-0',
  type: 'article', is_retracted: true,
  open_access: {is_oa: false, oa_status: 'closed', oa_url: null},
  primary_location: {version: 'publishedVersion', is_oa: false, source: {display_name: 'The Lancet', type: 'journal'}},
  locations: []
};

// The published work that swallowed a bioRxiv preprint. Its locations still
// carry the preprint's DOI, which is the only thing that proves the link.
const PUBLISHED_WORK = {
  id: 'https://openalex.org/W4389561271', doi: 'https://doi.org/10.1038/s41588-023-01585-7',
  title: 'A compendium of genetic regulatory effects across pig tissues', type: 'article', publication_year: 2024,
  open_access: {is_oa: true, oa_status: 'hybrid', oa_url: 'https://www.nature.com/articles/s41588-023-01585-7.pdf'},
  primary_location: {version: 'publishedVersion', is_oa: true, landing_page_url: 'https://doi.org/10.1038/s41588-023-01585-7',
    source: {display_name: 'Nature Genetics', type: 'journal'}},
  locations: [
    {version: 'publishedVersion', is_oa: true, landing_page_url: 'https://doi.org/10.1038/s41588-023-01585-7',
      source: {display_name: 'Nature Genetics', type: 'journal'}},
    {version: 'acceptedVersion', is_oa: true, landing_page_url: 'https://doi.org/10.1101/2022.11.11.516073',
      source: {display_name: 'bioRxiv (Cold Spring Harbor Laboratory)', type: 'repository'}}
  ]
};

const BARE_PREPRINT = {
  id: 'https://openalex.org/W7172447656', doi: 'https://doi.org/10.64898/2026.08.03.742496', type: 'preprint',
  open_access: {is_oa: true, oa_status: 'green', oa_url: 'https://www.biorxiv.org/content/full.pdf'},
  primary_location: {version: 'acceptedVersion', is_oa: true, source: {display_name: 'bioRxiv', type: 'repository'}},
  locations: [{version: 'acceptedVersion', is_oa: true, source: {display_name: 'bioRxiv', type: 'repository'}}]
};

const summarise = (crossrefPayload, workPayload, record, published) => signals.summarise({
  crossref: crossrefPayload ? signals.readCrossref(crossrefPayload) : null,
  openAlex: workPayload ? signals.readOpenAlex(workPayload) : null,
  published, record, checkedAt: '2026-09-17'
});

test('a paper carrying no notices is reported as standing, distinctly from never having been asked', () => {
  const clean = summarise(CLEAN, GOLD_WORK, {DOI: '10.1038/s41467-024-48219-y'});
  assert.equal(clean.status, 'ok');
  assert.equal(clean.notices.length, 0);
  // A clean paper still produces a sort key, so it can be told apart from one
  // with no cached answer at all.
  assert.notEqual(signals.sortKey(clean), '');
  assert.equal(signals.sortKey(null), '');
  assert.deepEqual(signals.badges(clean, {hasPDF: true}).map(b => b.kind), ['oa']);
});

test('a retracted paper is retracted even when an older correction is listed first', () => {
  const verdict = summarise(WAKEFIELD, CLOSED_RETRACTED_WORK, {DOI: '10.1016/S0140-6736(97)11096-0'});
  assert.equal(verdict.status, 'retracted');
  // Crossref lists the 2004 correction before the 2010 retraction; the worse
  // notice has to win regardless of order.
  assert.equal(verdict.notices[0].type, 'retraction');
  assert.equal(verdict.notices[0].date, '2010-02-06');
  assert.ok(verdict.notices.some(row => row.type === 'correction'), 'the correction is still reported');
  const badge = signals.badges(verdict, {hasPDF: true})[0];
  assert.equal(badge.tone, 'red');
  assert.equal(badge.solid, true, 'a retraction must not look like every other pill');
  assert.match(badge.url, /10\.1016\/s0140-6736\(10\)60175-4$/, 'the badge links to the retraction notice');
  // The worst news sorts first under a plain string sort.
  const clean = summarise(CLEAN, GOLD_WORK, {DOI: '10.1038/s41467-024-48219-y'});
  assert.ok(signals.sortKey(verdict) < signals.sortKey(clean));
});

test('an expression of concern is its own verdict, neither a retraction nor a correction', () => {
  const verdict = summarise(CONCERN, null, {DOI: '10.1016/j.lungcan.2003.10.006'});
  assert.equal(verdict.status, 'concern');
  // The publisher deposited the same notice twice with different dates.
  assert.equal(verdict.notices.length, 1, 'one notice, not one per deposit');
  assert.equal(verdict.notices[0].date, '2026-02-13', 'the earliest date the notice is known to bear');
  const [badge] = signals.badges(verdict, {hasPDF: true});
  assert.notEqual(badge.tone, 'red', 'an investigation is not a withdrawal');
  assert.match(badge.title, /우려/);
});

test('the retraction notice itself is not reported as a retracted paper', () => {
  // OpenAlex marks the notice is_retracted too, so a naive reading paints the
  // record that does the retracting and leaves the retracted paper clean.
  const verdict = summarise(RETRACTION_NOTICE, {...CLOSED_RETRACTED_WORK, doi: 'https://doi.org/10.1016/s0140-6736(10)60175-4'},
    {DOI: '10.1016/s0140-6736(10)60175-4'});
  assert.equal(verdict.status, 'notice');
  assert.equal(verdict.rank, 0);
  assert.equal(verdict.notices[0].doi, '10.1016/s0140-6736(97)11096-0', 'it names the paper it acts on');
  assert.equal(signals.badges(verdict, {hasPDF: true})[0].solid, false, 'only a real retraction is shouted');
});

test('OpenAlex is trusted for a retraction Crossref does not describe, but never over it', () => {
  const onlyOpenAlex = summarise(null, CLOSED_RETRACTED_WORK, {DOI: '10.1016/s0140-6736(97)11096-0'});
  assert.equal(onlyOpenAlex.status, 'retracted');
  assert.equal(onlyOpenAlex.notices[0].source, 'openalex');
  // Crossref naming the notices is the better answer; the fallback must not
  // add a second, anonymous retraction on top of them.
  const both = summarise(WAKEFIELD, CLOSED_RETRACTED_WORK, {DOI: '10.1016/S0140-6736(97)11096-0'});
  assert.equal(both.notices.filter(row => row.source === 'openalex').length, 0);
});

test('a Crossref relation retracts a paper even with no update deposit', () => {
  const payload = {message: {DOI: '10.1/x', title: ['A paper'],
    relation: {'is-retracted-by': [{'id-type': 'doi', id: '10.1/notice'}]}}};
  const verdict = summarise(payload, null, {DOI: '10.1/x'});
  assert.equal(verdict.status, 'retracted');
  assert.equal(verdict.notices[0].doi, '10.1/notice');
});

test('an unrecognised notice type is surfaced under its own label rather than dropped', () => {
  const payload = {message: {DOI: '10.1/x', title: ['A paper'], relation: {},
    'updated-by': [{DOI: '10.1/n', type: 'something_new', label: 'Editorial note', updated: {'date-parts': [[2026, 1, 2]]}}]}};
  const verdict = summarise(payload, null, {DOI: '10.1/x'});
  assert.notEqual(verdict.status, 'ok', 'an unknown notice is still a notice');
  assert.match(signals.badges(verdict, {hasPDF: true})[0].title, /Editorial note/);
});

test('open access is reported by kind, and the way in is only offered when the shelf lacks the PDF', () => {
  const open = summarise(CLEAN, GOLD_WORK, {DOI: '10.1038/s41467-024-48219-y'});
  assert.deepEqual(open.openAccess, {isOA: true, status: 'gold',
    url: 'https://www.nature.com/articles/s41467-024-48219-y.pdf'});
  const withPDF = signals.badges(open, {hasPDF: true}).find(b => b.kind === 'oa');
  const withoutPDF = signals.badges(open, {hasPDF: false}).find(b => b.kind === 'oa');
  assert.equal(withPDF.url, '', 'a library that already has the PDF needs no link');
  assert.equal(withoutPDF.url, 'https://www.nature.com/articles/s41467-024-48219-y.pdf');
  // Freer access sorts ahead of a paywall.
  const closed = summarise(CLEAN, CLOSED_RETRACTED_WORK, {DOI: '10.1/x'});
  assert.ok(signals.oaRank(open.openAccess.status) > signals.oaRank(closed.openAccess.status));
  assert.equal(signals.badges(closed, {hasPDF: false}).find(b => b.kind === 'oa').url, '');
});

test('a published version is offered only when the candidate carries this preprint DOI', () => {
  const record = {DOI: '10.1101/2022.11.11.516073', title: 'A compendium of genetic regulatory effects across pig tissues'};
  const work = signals.readOpenAlex(PUBLISHED_WORK);
  const found = signals.publishedVersionOf(work, record);
  assert.equal(found.doi, '10.1038/s41588-023-01585-7');
  assert.equal(found.venue, 'Nature Genetics');
  // A same-titled review with no link back to the preprint must be refused:
  // offering the wrong paper as "the published version" is worse than nothing.
  const impostor = signals.readOpenAlex({...PUBLISHED_WORK,
    locations: PUBLISHED_WORK.locations.filter(l => l.source.type === 'journal')});
  assert.equal(signals.publishedVersionOf(impostor, record), null);
  // Nor may a work be offered as the published version of itself.
  assert.equal(signals.publishedVersionOf(work, {DOI: '10.1038/s41588-023-01585-7'}), null);
  const verdict = summarise(null, PUBLISHED_WORK, record, found);
  assert.equal(verdict.preprint, true);
  assert.equal(signals.badges(verdict, {hasPDF: true})[0].kind, 'published');
});

test("Crossref's own is-preprint-of is enough when the repository deposits it", () => {
  const payload = {message: {DOI: '10.21203/rs.3.rs-2261680/v1', type: 'posted-content', subtype: 'preprint',
    title: ['A compendium'], relation: {'is-preprint-of': [{'id-type': 'doi', id: '10.1038/s41588-023-01585-7'}]}}};
  const verdict = summarise(payload, null, {DOI: '10.21203/rs.3.rs-2261680/v1'});
  assert.equal(verdict.preprint, true);
  assert.equal(verdict.published.doi, '10.1038/s41588-023-01585-7');
});

test('a preprint with nowhere better to go says so instead of staying silent', () => {
  const verdict = summarise(null, BARE_PREPRINT, {DOI: '10.64898/2026.08.03.742496'});
  assert.equal(verdict.preprint, true);
  assert.equal(verdict.published, null);
  const kinds = signals.badges(verdict, {hasPDF: false}).map(b => b.kind);
  assert.deepEqual(kinds, ['preprint', 'oa']);
});

test('a malformed or empty response yields no verdict instead of throwing or inventing one', () => {
  for (const payload of [null, undefined, {}, {message: null}, 'not json', 42, []]) {
    assert.doesNotThrow(() => signals.readCrossref(payload));
    assert.doesNotThrow(() => signals.readOpenAlex(payload));
  }
  assert.equal(signals.readOpenAlex({}), null, 'a work with no id is not a work');
  assert.equal(signals.readOpenAlex({results: []}), null);
  assert.equal(signals.readCrossref({message: 'nonsense'}), null);
  // A Crossref body that parsed but describes nothing must not read as clean.
  assert.equal(signals.readCrossref({message: {}}).valid, false);
  assert.equal(signals.classify({}).status, 'unknown');
  // Garbage inside the fields is ignored rather than propagated.
  const junk = signals.readCrossref({message: {DOI: '10.1/x', title: ['t'], relation: 'nope',
    'updated-by': [null, 'x', {}, {type: 'retraction'}]}});
  assert.equal(junk.updates.length, 1);
  assert.equal(junk.updates[0].doi, '');
  assert.deepEqual(junk.retractedBy, []);
  assert.deepEqual(signals.badges(null), []);
  // A date Crossref left incomplete degrades to what it does say.
  assert.equal(signals.readCrossref({message: {DOI: '10.1/x',
    'updated-by': [{DOI: '10.1/n', type: 'retraction', updated: {'date-parts': [[2010]]}}]}}).updates[0].date, '2010');
});

test('a paper with no DOI is not looked up at all, rather than looked up by title', () => {
  // A title search on Crossref would answer with somebody else's retraction.
  assert.equal(signals.crossrefURL({title: 'A paper with no identifier'}), null);
  assert.equal(signals.crossrefURL({}), null);
  assert.equal(signals.openAlexURL({title: 'A paper with no identifier'}), null);
  const verdict = summarise(null, null, {title: 'A paper with no identifier'});
  assert.equal(verdict.status, 'unknown');
  assert.deepEqual(signals.badges(verdict, {hasPDF: false}), [], 'nothing is claimed about an unidentifiable paper');
});

test('a DOI written as a URL, in capitals or with a doi: prefix reaches the same record', () => {
  const urls = ['10.1016/S0140-6736(97)11096-0', 'https://doi.org/10.1016/S0140-6736(97)11096-0',
    'doi:10.1016/s0140-6736(97)11096-0'].map(DOI => signals.crossrefURL({DOI}));
  assert.equal(new Set(urls).size, 1);
  assert.match(urls[0], /^https:\/\/api\.crossref\.org\/works\/10\.1016%2Fs0140-6736/);
  // The credentials are optional and must not become part of the path.
  assert.doesNotMatch(signals.crossrefURL({DOI: '10.1/x'}), /mailto/);
  assert.match(signals.crossrefURL({DOI: '10.1/x'}, {email: 'a@b.c'}), /\?mailto=a%40b\.c$/);
  assert.match(signals.openAlexURL({DOI: '10.1/x'}, {apiKey: 'k', email: 'a@b.c'}), /api_key=k&mailto=a%40b\.c$/);
  assert.match(signals.openAlexTitleURL({title: 'pig tissues'}), /title\.search%3Apig%20tissues/);
  assert.equal(signals.openAlexTitleURL({}), null);
});

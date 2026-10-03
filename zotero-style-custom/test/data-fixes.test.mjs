/* Data-correctness fixes from the fact-check of 2026-10-03. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Runtime = require('../src/runtime.js');
const journals = require('../src/journals.js');
const affiliations = require('../src/affiliations.js');
const signals = require('../src/paper-signals.js');
const discover = require('../src/discover.js');
const attention = require('../src/attention.js');

const rec = (title, issns, impactFactor, over = {}) => ({title, aliases: [], issns, impactFactor, year: 2025,
  sourceURL: 'https://jcr.clarivate.com/jcr/home', checkedAt: '2026-06-18', ...over});
const publisher = (title, issns, impactFactor) => rec(title, issns, impactFactor, {sourceURL: 'https://www.cell.com/metrics', checkedAt: '2026-09-13'});
const item = (fields) => ({getField: k => fields[k] || ''});
const rebuilt = catalog => {
  const host = {catalog, cache: {}, journalTools: journals};
  Runtime.prototype.rebuildJournals.call(host);
  return host.journals;
};

test('1 a JCR record is never displaced by a publisher-page record, in either order', () => {
  const jcr = rec('Cell', ['0092-8674'], 45.1, {authority: 'jcr'});
  const page = publisher('Cell', ['0092-8674'], 42.5);
  for (const order of [[jcr, page], [page, jcr]]) {
    const j = rebuilt(order);
    assert.equal(j.lookup(item({publicationTitle: 'Cell'})).impactFactor, 45.1);
    assert.equal(j.lookup(item({publicationTitle: 'x', ISSN: '0092-8674'})).impactFactor, 45.1);
  }
});

test('11 a bare title shared by two journals is ambiguous unless an ISSN decides', () => {
  const j = rebuilt([rec('Microbiology', ['0026-2617', '1608-3237'], 1.0, {authority: 'jcr'}),
    rec('Microbiology-sgm', ['1350-0872', '1465-2080'], 4.3, {authority: 'jcr', aliases: ['Microbiology']}),
    publisher('Microbiology', ['1465-2080'], 4.3)]);
  assert.equal(j.lookup(item({publicationTitle: 'Microbiology'})), null);
  assert.equal(j.lookup(item({publicationTitle: 'Microbiology', ISSN: '1465-2080'})).impactFactor, 4.3);
  assert.equal(j.lookup(item({publicationTitle: 'Microbiology', ISSN: '0026-2617'})).impactFactor, 1.0);
});

test('12 the JCR standing is found by the item ISSN and by a normalised title', () => {
  const catalog = {journals: [
    {title: 'PROCEEDINGS OF THE NATIONAL ACADEMY OF SCIENCES OF THE UNITED STATES OF AMERICA', issns: ['0027-8424', '1091-6490']},
    {title: 'ISME Journal', issns: ['1751-7362']}]};
  const host = {journalTools: journals, _jcrIndex: Runtime.prototype._jcrIndex};
  const match = (...a) => Runtime.prototype._jcrMatch.call(host, catalog, ...a);
  assert.ok(match('PNAS', []));
  assert.ok(match('The ISME Journal', []));
  assert.ok(match('Something else', ['0027-8424']));
  assert.equal(match('Unrelated', []), null);
});

test('4 one person listed twice is one corresponding author', () => {
  const people = [
    {id: 'A1', name: 'Ann One', position: 'first'},
    {id: 'A2', name: 'Bo Two', corresponding: true},
    {id: 'A2', name: 'Bo Two', corresponding: true},
    {id: '', name: 'Cy  Three', corresponding: true}, {id: '', name: 'cy three', corresponding: true},
    {id: 'A9', name: 'Last', position: 'last'}];
  const picked = affiliations.principals(people);
  assert.equal(picked.others, 1, 'Bo and Cy are two people, not four');
  assert.equal(picked.correspondingKnown, true);
  assert.equal(affiliations.principals([{id: 'A1', name: 'X', corresponding: true}, {id: 'A1', name: 'X', corresponding: true}]).others, 0);
});

test('5 a new_version update pointing at the paper itself is not a correction', () => {
  const own = '10.1371/journal.pgen.1008666';
  const read = signals.readCrossref({message: {DOI: own, title: ['A paper'],
    'updated-by': [{DOI: own, type: 'new_version', label: 'New version', updated: {'date-parts': [[2020, 5, 1]]}}]}});
  assert.deepEqual(read.updates, []);
  assert.equal(signals.classify({crossref: read}).status, 'ok');
  // new_version/new_edition rank 0 even when the DOI differs.
  const other = signals.readCrossref({message: {DOI: own, title: ['A paper'], 'updated-by': [{DOI: '10.1/other', type: 'new_edition'}]}});
  assert.equal(signals.classify({crossref: other}).status, 'ok');
  // A stored verdict from before the fix is repaired on load.
  const stored = {doi: own, status: 'corrected', rank: 1, notices: [{doi: own, type: 'new_version', rank: 1}]};
  assert.equal(signals.repair(stored).status, 'ok');
  assert.equal(signals.repair({doi: own, status: 'corrected', rank: 1, notices: [{doi: '10.1/c', type: 'correction', rank: 1}]}).status, 'corrected');
});

test('10 a Crossref correction does not hide an OpenAlex retraction flag', () => {
  const crossref = signals.readCrossref({message: {DOI: '10.1/p', title: ['t'], 'updated-by': [{DOI: '10.1/c', type: 'correction'}]}});
  assert.equal(signals.classify({crossref, openAlex: {isRetracted: true}}).status, 'retracted');
  const notice = signals.readCrossref({message: {DOI: '10.1/n', title: ['n'], 'update-to': [{DOI: '10.1/p', type: 'retraction'}]}});
  assert.equal(signals.classify({crossref: notice, openAlex: {isRetracted: true}}).status, 'notice');
});

test('9 a retraction notice is a notice in the around panel too, not "Retracted (flag)"', async () => {
  const json = (body) => ({status: 200, json: body, url: ''});
  const tools = attention.create({sleep: async () => {}, now: () => 1e12, fetch: async url => {
    if (url.includes('api.crossref.org')) return json({message: {DOI: '10.1/n', title: ['Retraction: x'], 'update-to': [{DOI: '10.1/p', type: 'retraction'}]}});
    if (url.includes('api.openalex.org')) return json({id: 'W1', is_retracted: true, type: 'retraction'});
    return {status: 404, json: null, url: ''};
  }});
  const out = await tools.issues('10.1/n');
  assert.equal(out.summary.status, 'notice');
  assert.ok(!out.events.some(e => e.label === 'Retracted (flag)'));
  // OpenAlex alone says it is a notice.
  const alone = attention.create({sleep: async () => {}, now: () => 1e12, fetch: async url =>
    url.includes('api.openalex.org') ? json({id: 'W1', is_retracted: true, type: 'retraction'}) : {status: 404, json: null, url: ''}});
  assert.equal((await alone.issues('10.1/n2')).summary.status, 'notice');
});

test('8 an author listed twice on a work gives one entry', () => {
  const w = {id: 'W1', people: [{id: 'A1', name: 'a'}, {id: 'A1', name: 'a'}, {id: 'A2', name: 'b'}]};
  const by = discover.attribute([w], ['A1', 'A2']);
  assert.equal(by.get('A1').length, 1);
  assert.equal(by.get('A2').length, 1);
});

test('3 works stored before schema 2 are refetched once, in batches of fifty', async () => {
  const items = Array.from({length: 3}, (_, n) => ({id: n, doi: n === 2 ? '' : '10.1/p' + n}));
  const store = {k0: {doi: '10.1/p0', year: 2020, people: []}, k1: {doi: '10.1/p1', v: 2, people: []}, k2: {doi: '', missing: true}};
  const asked = [];
  const host = {
    cache: {works: store}, discoverTools: discover, affiliationTools: affiliations, active: true, stopping: false, dirty: false,
    paperWorks: Runtime.prototype.paperWorks, isRegular: () => true, identity: it => 'k' + it.id,
    bibliographyRecord: it => ({DOI: it.doi}), discoverOptions: () => ({}), Z: {logError() {}},
    async discoverJSON(url) {
      asked.push(url);
      return {results: [{id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1/p0', publication_year: 2020, cited_by_count: 5,
        authorships: [{author: {id: 'https://openalex.org/A1', display_name: 'F'}, author_position: 'first', institutions: []},
          {author: {id: 'https://openalex.org/A2', display_name: 'L'}, author_position: 'last', institutions: []}]}]};
    },
    async sweepInstitutions() { return 0; }, async flush() {}, async refreshWindows() {}
  };
  const report = await Runtime.prototype.sweepPaperWorks.call(host, items);
  assert.equal(asked.length, 1);
  assert.match(decodeURIComponent(asked[0]), /10\.1\/p0/);
  assert.doesNotMatch(decodeURIComponent(asked[0]), /10\.1\/p1/);
  assert.equal(store.k0.v, 2);
  assert.deepEqual(store.k0.people.map(p => p.name), ['F', 'L'], 'the last author is kept');
  assert.equal(report.already, 2);
  assert.equal((await Runtime.prototype.sweepPaperWorks.call(host, items)).asked, 0, 'a second run costs nothing');
});

test('6 an institution row without checkedAt, or older than 180 days, is asked again', async () => {
  const old = new Date(Date.now() - 200 * 864e5).toISOString();
  const fresh = new Date().toISOString();
  const known = {R0: {ror: 'R0', name: 'No stamp', hIndex: 100}, R1: {ror: 'R1', name: 'Old', hIndex: 100, checkedAt: old},
    R2: {ror: 'R2', name: 'Fresh', hIndex: 100, checkedAt: fresh}};
  const asked = [];
  const host = {
    cache: {institutions: known, works: {}}, institutionTable: Runtime.prototype.institutionTable, paperWorks: Runtime.prototype.paperWorks,
    affiliationTools: affiliations, discoverTools: discover, discoverOptions: () => ({}), active: true, stopping: false, dirty: false,
    Z: {logError() {}}, outOfBudget: () => false,
    async discoverJSON(url) { asked.push(decodeURIComponent(url)); return {results: [{ror: 'https://ror.org/R1', display_name: 'Old', summary_stats: {h_index: 2004}}]}; }
  };
  await Runtime.prototype.sweepInstitutions.call(host, {});
  assert.equal(asked.length, 1);
  assert.match(asked[0], /R0\|R1/);
  assert.doesNotMatch(asked[0], /R2/);
  assert.equal(known.R1.hIndex, 2004);
  assert.ok(known.R1.checkedAt > old);
  assert.ok(known.R0.checkedAt, 'a row the batch did not return is stamped so it is not asked every sweep');
  assert.equal(known.R0.hIndex, 100, 'the old figure stays when nothing new arrived');
});

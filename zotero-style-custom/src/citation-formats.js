/* Citation strings in the styles Google Scholar offers. Pure formatting: the
   caller supplies plain records, so nothing here touches Zotero or the network. */
(function (root) {
  'use strict';

  // Zotero ships these CSL styles, so prefer its own processor and keep the
  // hand-rolled formatter below only as a fallback when a style is missing.
  const STYLES = [
    {key: 'mla', label: 'MLA', url: 'http://www.zotero.org/styles/modern-language-association'},
    {key: 'apa', label: 'APA', url: 'http://www.zotero.org/styles/apa'},
    {key: 'chicago', label: 'Chicago', url: 'http://www.zotero.org/styles/chicago-author-date'},
    {key: 'harvard', label: 'Harvard', url: 'http://www.zotero.org/styles/harvard-cite-them-right'},
    {key: 'vancouver', label: 'Vancouver', url: 'http://www.zotero.org/styles/vancouver'}
  ];

  const text = value => String(value == null ? '' : value).trim();
  const initials = given => text(given).split(/[\s.-]+/).filter(Boolean).map(part => part[0].toUpperCase() + '.').join(' ');

  function names(creators) {
    return (Array.isArray(creators) ? creators : [])
      .filter(c => c && (c.lastName || c.name || c.firstName))
      .map(c => ({family: text(c.lastName || c.name), given: text(c.firstName)}));
  }

  // "A, B, and C" / "A, B, & C" / "A et al." — each style joins differently.
  // APA, MLA and Chicago keep the serial comma even with only two names;
  // Harvard does not, which is why it is an option rather than a constant.
  function join(parts, {conjunction, etAlAfter, etAl = 'et al.', serialComma = true}) {
    if (!parts.length) return '';
    if (etAlAfter && parts.length > etAlAfter) return parts[0] + ' ' + etAl;
    if (parts.length === 1) return parts[0];
    const head = parts.slice(0, -1), tail = parts[parts.length - 1];
    return head.join(', ') + (serialComma || parts.length > 2 ? ',' : '') + ' ' + conjunction + ' ' + tail;
  }

  function locator(record, {volumeWord, issueWord, pageWord}) {
    const bits = [];
    if (record.volume) bits.push(volumeWord ? volumeWord + ' ' + record.volume : text(record.volume));
    if (record.issue) bits.push(issueWord ? issueWord + ' ' + record.issue : text(record.issue));
    if (record.pages) bits.push(pageWord ? pageWord + ' ' + record.pages : text(record.pages));
    return bits.join(', ');
  }

  // APA and Harvard bracket the issue onto the volume: 85(4), 712-725.
  function volumeIssuePages(record) {
    const head = record.volume ? text(record.volume) + (record.issue ? `(${text(record.issue)})` : '') : '';
    return [head, text(record.pages)].filter(Boolean).join(', ');
  }

  const doiURL = record => record.DOI ? 'https://doi.org/' + text(record.DOI).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') : text(record.url);
  const period = value => !value ? '' : /[.?!]$/.test(value) ? value : value + '.';

  function apa(record) {
    const authors = names(record.creators).map(c => c.given ? `${c.family}, ${initials(c.given)}` : c.family);
    const who = authors.length > 20 ? authors.slice(0, 19).join(', ') + ', ... ' + authors[authors.length - 1]
      : join(authors, {conjunction: '&'});
    const where = [record.venue, volumeIssuePages(record)].filter(Boolean).join(', ');
    return [period(who), record.year ? `(${record.year}).` : '(n.d.).', period(text(record.title)), period(where), doiURL(record)]
      .filter(Boolean).join(' ').trim();
  }

  function mla(record) {
    const people = names(record.creators);
    const first = people[0] ? (people[0].given ? `${people[0].family}, ${people[0].given}` : people[0].family) : '';
    const rest = people.slice(1).map(c => [c.given, c.family].filter(Boolean).join(' '));
    const who = people.length > 2 ? first + ', et al.' : join([first, ...rest].filter(Boolean), {conjunction: 'and'});
    const where = [record.venue && `${record.venue}`, locator(record, {volumeWord: 'vol.', issueWord: 'no.', pageWord: 'pp.'}), record.year]
      .filter(Boolean).join(', ');
    return [period(who), record.title ? `"${period(text(record.title))}"` : '', period(where), doiURL(record)]
      .filter(Boolean).join(' ').trim();
  }

  function chicago(record) {
    const people = names(record.creators);
    const first = people[0] ? (people[0].given ? `${people[0].family}, ${people[0].given}` : people[0].family) : '';
    const rest = people.slice(1).map(c => [c.given, c.family].filter(Boolean).join(' '));
    const who = people.length > 10 ? first + ' et al.' : join([first, ...rest].filter(Boolean), {conjunction: 'and'});
    const where = record.venue
      ? record.venue + (record.volume ? ' ' + record.volume : '') + (record.issue ? ` (${record.issue})` : '') + (record.pages ? ': ' + record.pages : '')
      : '';
    return [period(who), record.year ? record.year + '.' : 'n.d.', record.title ? `"${period(text(record.title))}"` : '', period(where), doiURL(record)]
      .filter(Boolean).join(' ').trim();
  }

  const harvard = record => {
    const authors = names(record.creators).map(c => c.given ? `${c.family}, ${initials(c.given)}` : c.family);
    const where = [record.venue, volumeIssuePages(record)].filter(Boolean).join(', ');
    return [period(join(authors, {conjunction: 'and', serialComma: false})), record.year ? `(${record.year})` : '(no date)',
      period(text(record.title)), period(where), doiURL(record)].filter(Boolean).join(' ').trim();
  };

  const vancouver = record => {
    const authors = names(record.creators).map(c => [c.family, initials(c.given).replace(/[.\s]/g, '')].filter(Boolean).join(' '));
    const who = authors.length > 6 ? authors.slice(0, 6).join(', ') + ', et al' : authors.join(', ');
    const where = record.venue
      ? `${record.venue}. ${record.year || ''}` + (record.volume ? ';' + record.volume : '') + (record.issue ? `(${record.issue})` : '') + (record.pages ? ':' + record.pages : '')
      : text(record.year);
    return [period(who), period(text(record.title)), period(where), doiURL(record)].filter(Boolean).join(' ').trim();
  };

  // ISO 690 puts the family name in capitals and the source after the title.
  function iso690(record) {
    const people = names(record.creators);
    const first = people[0] ? [people[0].family.toUpperCase(), people[0].given].filter(Boolean).join(', ') : '';
    const rest = people.slice(1).map(c => [c.family.toUpperCase(), c.given].filter(Boolean).join(', '));
    const who = people.length > 3 ? first + ', et al.' : join([first, ...rest].filter(Boolean), {conjunction: 'and'});
    const where = record.venue
      ? record.venue + (record.year ? ', ' + record.year : '')
        + (record.volume ? ', ' + record.volume : '') + (record.pages ? ': ' + record.pages : '')
      : text(record.year);
    return [period(who), period(text(record.title)), period(where)].filter(Boolean).join(' ').trim();
  }

  const FORMATTERS = {mla, apa, chicago, harvard, vancouver, iso690};

  function format(key, record) {
    const build = FORMATTERS[key];
    if (!build) throw new RangeError('Unknown citation style: ' + key);
    if (!record || typeof record !== 'object') throw new TypeError('A citation needs a record');
    return build(record).replace(/\s+/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
  }

  // BibTeX/RIS mirror the other two things Scholar hands you.
  const bibtexEscape = value => text(value).replace(/[\\{}]/g, '\\$&');
  function bibtex(record) {
    const people = names(record.creators);
    const key = ((people[0]?.family || 'ref').toLowerCase().replace(/[^a-z]/g, '') || 'ref') + (record.year || '');
    const fields = [['title', record.title], ['author', people.map(c => [c.family, c.given].filter(Boolean).join(', ')).join(' and ')],
      ['journal', record.venue], ['year', record.year], ['volume', record.volume], ['number', record.issue],
      ['pages', text(record.pages).replace(/-+/g, '--')], ['doi', record.DOI]];
    return `@article{${key},\n` + fields.filter(([, v]) => text(v))
      .map(([name, v]) => `  ${name} = {${bibtexEscape(v)}},`).join('\n').replace(/,$/, '') + '\n}';
  }
  function ris(record) {
    const lines = [['TY', 'JOUR'], ...names(record.creators).map(c => ['AU', [c.family, c.given].filter(Boolean).join(', ')]),
      ['TI', record.title], ['JO', record.venue], ['PY', record.year], ['VL', record.volume],
      ['IS', record.issue], ['SP', text(record.pages).split(/[-–]/)[0]], ['DO', record.DOI]];
    return lines.filter(([, v]) => text(v)).map(([tag, v]) => `${tag}  - ${text(v)}`).join('\n') + '\nER  - ';
  }

  // EndNote's tagged format. RefMan and RefWorks both read RIS, so those three
  // export links differ only in the file they are offered as.
  function endnote(record) {
    const lines = [['%0', 'Journal Article'], ...names(record.creators).map(c => ['%A', [c.family, c.given].filter(Boolean).join(', ')]),
      ['%T', record.title], ['%J', record.venue], ['%D', record.year], ['%V', record.volume],
      ['%N', record.issue], ['%P', record.pages], ['%R', record.DOI], ['%U', record.url]];
    return lines.filter(([, value]) => text(value)).map(([tag, value]) => `${tag} ${text(value)}`).join('\n');
  }

  // What Google Scholar's citation popup shows, in its order.
  const PANEL_STYLES = [
    {key: 'mla', label: 'MLA'}, {key: 'apa', label: 'APA'}, {key: 'iso690', label: 'ISO 690'},
    {key: 'chicago', label: 'Chicago'}, {key: 'harvard', label: 'Harvard'}, {key: 'vancouver', label: 'Vancouver'}
  ];
  const EXPORTS = [
    {key: 'bibtex', label: 'BibTeX', extension: 'bib'},
    {key: 'endnote', label: 'EndNote', extension: 'enw'},
    {key: 'ris', label: 'RefMan', extension: 'ris'},
    {key: 'ris', label: 'RefWorks', extension: 'ris'}
  ];

  const api = {STYLES, PANEL_STYLES, EXPORTS, format, bibtex, ris, endnote, FORMATTERS};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleCitationFormats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

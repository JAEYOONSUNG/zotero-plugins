/* A self-check that runs inside the real Zotero.

   The plugin's behaviour is covered by 486 Node tests, but those run against
   linkedom and a fixture. The bugs that actually shipped were the ones only the
   real runtime could show: innerHTML missing on createElementNS SVG elements,
   <button> not growing around wrapped content, a manifest byte that made the
   whole .xpi vanish. This exercises each feature against the user's own library
   and writes a report, so "it works" is something read back rather than assumed.

   It is read-only by default. The one write it performs is a no-op: a rating is
   written back at the value it already had, which drives the whole transaction
   without changing what the user sees. */
(function (root) {
  'use strict';

  const ok = (name, detail) => ({name, pass: true, detail: detail ?? ''});
  const bad = (name, detail) => ({name, pass: false, detail: String(detail)});

  async function attempt(name, fn) {
    try {
      const detail = await fn();
      return detail === false ? bad(name, 'returned false') : ok(name, detail);
    } catch (error) {
      return bad(name, (error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error));
    }
  }

  async function run(Zotero, runtime, {network = true, repair = false, fill = false} = {}) {
    const results = [];
    const win = Zotero.getMainWindow && Zotero.getMainWindow();
    const doc = win && win.document;
    const library = Zotero.Libraries.userLibraryID;

    // Half the plugin calls Zotero.Items.getAll(libraryID) as if it returned an
    // array. Whether it does is exactly the sort of thing only the real Zotero
    // can answer, so the answer is recorded rather than assumed.
    let raw = null, getAllShape = 'missing';
    try {
      raw = Zotero.Items.getAll ? Zotero.Items.getAll(library) : null;
      getAllShape = raw && typeof raw.then === 'function' ? 'promise'
        : Array.isArray(raw) ? 'array of ' + raw.length
        : raw === null || raw === undefined ? String(raw) : typeof raw;
      if (raw && typeof raw.then === 'function') raw = await raw;
    } catch (error) { getAllShape = 'threw: ' + (error && error.message || error); raw = null; }
    const all = (Array.isArray(raw) ? raw : []).filter(item => {
      try { return runtime.isRegular(item); } catch (ignored) { return false; }
    });
    const withDOI = all.filter(item => {
      try { return !!runtime.signalTools.bareDOI(runtime.citationRecord(item).doi); }
      catch (ignored) { return false; }
    });

    results.push(await attempt('Zotero.Items.getAll returns what the plugin assumes', () => {
      if (getAllShape === 'promise' && !runtime.libraryItems) {
        throw new Error('it returns a Promise and nothing awaits it; every sweep fails on its first line');
      }
      if (!all.length) throw new Error('shape was ' + getAllShape + ' -- no papers reached the plugin');
      return getAllShape;
    }));

    results.push(await attempt('plugin is live', () => {
      if (!runtime.active) throw new Error('runtime is not active');
      return `v${runtime.version} · ${all.length} papers · ${Object.keys(runtime.cache.items || {}).length} cached`;
    }));

    results.push(await attempt('every column is registered', () => {
      const missing = (runtime.columnDefinitions || []).map(row => row[0])
        .filter(key => !runtime.featureColumns.has(key) && runtime.columnFeature(key) && runtime.featureEnabled(runtime.columnFeature(key)));
      if (missing.length) throw new Error('not registered: ' + missing.join(', '));
      return `${runtime.columns.length} columns`;
    }));

    // renderCell is where Gecko-only failures surface; a thrown error here
    // blanks a column in the real tree while every Node test still passes.
    results.push(await attempt('every column renders a cell', () => {
      if (!doc) throw new Error('no main window');
      const sample = all.slice(0, 3);
      const failures = [];
      for (const [key] of runtime.columnDefinitions || []) {
        for (const item of sample) {
          try {
            const value = runtime.value(key, item);
            const cell = runtime.renderCell(key, -1, value, {className: ''}, doc);
            if (!cell || typeof cell.textContent !== 'string') throw new Error('no cell');
          } catch (error) { failures.push(key + ': ' + (error.message || error)); }
        }
      }
      if (failures.length) throw new Error(failures.slice(0, 5).join(' | '));
      return `${(runtime.columnDefinitions || []).length} columns × ${sample.length} papers`;
    }));

    results.push(await attempt('state and value read back for every paper', () => {
      let errors = 0, lastError = '';
      for (const item of all) {
        try { runtime.state(item); } catch (error) { errors++; lastError = String(error.message || error); }
      }
      if (errors) throw new Error(`${errors} papers failed: ${lastError}`);
      return `${all.length} papers`;
    }));

    results.push(await attempt('the panel opens and every tab draws', async () => {
      if (!win) throw new Error('no main window');
      const state = runtime.windows.get(win);
      const bench = state && state.workbench;
      if (!bench) throw new Error('workbench not attached');
      const errorsBefore = [];
      const tabs = (root.CustomStyleWorkbench && root.CustomStyleWorkbench.TABS || []).map(row => row[0]);
      const failed = [];
      for (const tab of tabs) {
        try {
          await bench.show(tab);
          const status = bench.panel.querySelector('.sc-status');
          if (status && status.dataset.error === 'true') failed.push(tab + ': ' + status.textContent);
        } catch (error) { failed.push(tab + ': ' + (error.message || error)); }
      }
      try { await bench.toggle(false); } catch (ignored) {}
      if (failed.length) throw new Error(failed.join(' | '));
      return `${tabs.length} tabs, ${errorsBefore.length} errors`;
    }));

    results.push(await attempt('the sidebar shows an icon for every tab', () => {
      const state = runtime.windows.get(win);
      const bench = state && state.workbench;
      if (!bench) throw new Error('workbench not attached');
      const buttons = [...bench.panel.querySelectorAll('nav button[data-tab]')];
      const blank = buttons.filter(b => !b.querySelector('.sc-nav-icon svg *')).map(b => b.dataset.tab);
      if (blank.length) throw new Error('no icon: ' + blank.join(', '));
      return `${buttons.length} icons`;
    }));

    results.push(await attempt('every library-wide sweep reads real items', async () => {
      const got = await runtime.libraryItems(library);
      if (!Array.isArray(got) || !got.length) throw new Error('libraryItems returned ' + (got && got.length));
      const needing = await runtime.itemsNeedingSignals(library);
      const stragglers = await runtime.visibleRatingTagItems(library);
      const stars = await runtime.starTagItems(library);
      return `${got.length} items · ${needing.length} need signals · ${stragglers.length} rating tags · ${stars.length} star tags`;
    }));

    results.push(await attempt('the panel reports what is still empty', async () => {
      const pending = await runtime.backfillPending(library);
      return `signals ${pending.signals} · journals ${pending.journals} · authors ${pending.authors}`;
    }));

    results.push(await attempt('every citation style renders', () => {
      const item = all.find(paper => paper.getField('title'));
      if (!item) throw new Error('no paper with a title');
      const record = runtime.bibliographyRecord(item);
      const out = [];
      const F = runtime.citationFormats;
      for (const style of [...F.PANEL_STYLES, ...F.EXPORTS]) {
        let text = '';
        if (style.key === 'bibtex') text = F.bibtex(record);
        else if (style.key === 'ris') text = F.ris(record);
        else if (style.key === 'endnote') text = F.endnote(record);
        else text = F.format(style.key, record);
        if (!String(text).trim()) throw new Error(style.label + ' produced nothing');
        out.push(style.label);
      }
      return out.join(', ');
    }));

    // The dialog once shipped with every row overlapping, because a <button>
    // does not grow around wrapped content in Gecko and no Node test could see
    // it. Opening it for real is the only check that means anything.
    results.push(await attempt('the citation dialog opens with usable rows', async () => {
      if (!win) throw new Error('no main window');
      const item = all[0];
      if (!item) throw new Error('empty library');
      const backdrop = await runtime.citationPanel(win, [item]);
      const rows = [...backdrop.querySelectorAll('.sc-cite-row, [role=button]')];
      const empty = rows.filter(row => !String(row.textContent || '').trim()).length;
      const boxes = rows.map(row => row.getBoundingClientRect && row.getBoundingClientRect());
      // Rows that overlap vertically are the exact failure that shipped before.
      let overlaps = 0;
      for (let i = 1; i < boxes.length; i++) {
        const a = boxes[i - 1], b = boxes[i];
        if (a && b && a.height && b.height && b.top < a.bottom - 1) overlaps++;
      }
      const closeButton = backdrop.querySelector('.sc-cite-close');
      if (closeButton) closeButton.click(); else backdrop.remove();
      if (!rows.length) throw new Error('no rows');
      if (empty) throw new Error(`${empty} rows produced no text`);
      if (overlaps) throw new Error(`${overlaps} rows overlap the one above`);
      return `${rows.length} rows, none empty, none overlapping`;
    }));

    // The rating moved from a tag to Extra. Writing the value it already holds
    // drives the whole transaction without changing anything the user sees.
    results.push(await attempt('a rating round-trips through Extra', async () => {
      const item = all.find(paper => runtime.canEdit(paper) && runtime.state(paper).rating > 0)
        || all.find(paper => runtime.canEdit(paper));
      if (!item) throw new Error('nothing editable');
      const before = runtime.state(item).rating;
      const extraBefore = String(item.getField('extra') || '');
      await runtime.edit([item], {rating: before});
      const after = runtime.state(item).rating;
      const tags = (item.getTags() || []).map(tag => tag.tag || tag);
      if (after !== before) throw new Error(`rating changed ${before} -> ${after}`);
      if (tags.some(tag => /^style-custom:rating:/.test(tag))) throw new Error('rating tag is still written');
      const expected = runtime.model.updateExtra(extraBefore, {rating: before});
      const extraAfter = String(item.getField('extra') || '');
      if (extraAfter !== expected) throw new Error(`extra mismatch: ${JSON.stringify(extraAfter)}`);
      return `rating ${before} kept · extra ${JSON.stringify(extraAfter).slice(0, 60)}`;
    }));

    results.push(await attempt('rating tags left in the library', async () => {
      const stragglers = await runtime.visibleRatingTagItems(library);
      return `${stragglers.length} papers still carry one`;
    }));

    results.push(await attempt('the reading history is in this plugin', () => {
      const entries = Object.values(runtime.cache.items || {}).filter(entry => entry && entry.seconds > 0);
      const hours = entries.reduce((sum, entry) => sum + entry.seconds, 0) / 3600;
      return `${entries.length} papers · ${hours.toFixed(1)} h`;
    }));

    results.push(await attempt('the watchlist is readable and ordered', () => {
      const watched = runtime.watchedAuthorsByNews();
      const withNews = watched.filter(row => row.news && row.news.length);
      return `${watched.length} followed · ${withNews.length} with news · limit ${runtime.WATCH_LIMIT}`;
    }));

    results.push(await attempt('following one more author is possible', async () => {
      const probe = 'A999999999';
      const had = runtime.watchedAuthors().some(row => row.id === probe);
      if (had) return 'probe already present; skipped';
      await runtime.watchAuthor({id: probe, name: 'Self-check probe', institution: ''});
      const added = runtime.watchedAuthors().some(row => row.id === probe);
      await runtime.unwatchAuthor(probe);
      const gone = !runtime.watchedAuthors().some(row => row.id === probe);
      if (!added) throw new Error('could not add');
      if (!gone) throw new Error('could not remove');
      return `added and removed at ${runtime.watchedAuthors().length} followed`;
    }));

    results.push(await attempt('contact details reach the APIs', () => {
      const options = runtime.discoverOptions();
      const bits = [];
      bits.push(options.apiKey ? `OpenAlex key ok (${String(options.apiKey).length} chars)` : 'NO OPENALEX KEY');
      bits.push(options.email ? `mailto ${options.email}` : 'NO MAILTO -- requests go to the slow anonymous pool');
      if (!options.apiKey || !options.email) throw new Error(bits.join(' · '));
      return bits.join(' · ');
    }));

    if (network) {
      results.push(await attempt('Crossref answers for real papers', async () => {
        const sample = withDOI.slice(0, 3);
        if (!sample.length) throw new Error('no paper with a DOI');
        const seen = [];
        for (const item of sample) {
          const {signals, reason} = await runtime.fetchPaperSignals(item);
          seen.push(reason === 'ok' ? (signals.status + (signals.partial ? '(partial)' : '')) : reason);
        }
        return seen.join(', ');
      }));

      results.push(await attempt('OpenAlex answers for a real journal', async () => {
        const item = all.find(paper => runtime.journalRecord(paper).issn || runtime.journalRecord(paper).name);
        if (!item) throw new Error('no journal on any paper');
        const record = runtime.journalRecord(item);
        const hit = await runtime.fetchJournalMetric(record);
        if (!hit) throw new Error('no answer for ' + record.name);
        return `${record.name} -> ${hit.citedness === null ? 'not indexed' : '~' + hit.citedness}`;
      }));

      results.push(await attempt('the watchlist sweep reaches OpenAlex', async () => {
        const watched = runtime.watchedAuthors();
        if (!watched.length) return 'nobody followed; skipped';
        const url = runtime.discoverTools.watchedWorksURL(watched.slice(0, 50).map(row => row.id),
          Object.assign({since: '2026-01-01'}, runtime.discoverOptions()));
        if (!url) throw new Error('no url built');
        const payload = await runtime.discoverJSON(url);
        const works = runtime.discoverTools.readWorks(payload);
        return `${works.length} works for ${Math.min(50, watched.length)} authors in one request`;
      }));
    }

    // Asked for explicitly, because these change the user's library rather than
    // reading it: the rating migration they asked for, and the sweep that fills
    // the three columns that have been empty since the day they shipped.
    if (repair) {
      results.push(await attempt('rating tags moved to Extra', async () => {
        const stragglers = await runtime.visibleRatingTagItems(library);
        if (!stragglers.length) {
          const stray = await runtime.moveStrayRatingTags(library);
          return `no papers left · attachments: ${stray.moved} lifted, ${stray.alreadyRated} already rated, ${stray.orphans} standalone left alone`;
        }
        const {fixed, skipped} = await runtime.hideRatingTags(stragglers);
        const stray = await runtime.moveStrayRatingTags(library);
        const after = await runtime.visibleRatingTagItems(library);
        if (after.length) throw new Error(`${after.length} papers still carry a rating tag`);
        return `${fixed} papers moved${skipped ? `, ${skipped} not editable` : ''}`
          + ` · attachments: ${stray.moved} lifted to their paper, ${stray.alreadyRated} already rated, ${stray.orphans} standalone left alone`;
      }));
    }
    if (fill) {
      results.push(await attempt('the backfill runs over the whole library', async () => {
        const report = await runtime.runBackfill({libraryID: library});
        const bits = [];
        if (report.signals) bits.push(`signals ok ${report.signals.ok} · none ${report.signals['not-found']} · err ${report.signals.error}` + (report.signals.partialOnly ? ` · partial ${report.signals.partialOnly}` : ''));
        if (report.journals) bits.push(`journals found ${report.journals.found} · missing ${report.journals.missing}`);
        if (report.authors) bits.push(`authors ${report.authors.authors} · with news ${report.authors.withNews} · works ${report.authors.works}`);
        if (report.budgetGone) bits.push('stopped: OpenAlex budget spent');
        return bits.join(' | ') || 'nothing to do';
      }));
      results.push(await attempt('what the retraction column now shows', async () => {
        const counts = {};
        let partial = 0;
        for (const item of all) {
          const found = runtime.signalsOf(item);
          if (!found) continue;
          counts[found.status] = (counts[found.status] || 0) + 1;
          if (found.partial) partial++;
        }
        return JSON.stringify(counts) + (partial ? ` · ${partial} partial` : '');
      }));
    }

    const passed = results.filter(row => row.pass).length;
    return {
      version: runtime.version, when: new Date().toISOString(),
      passed, failed: results.length - passed, results
    };
  }

  const api = {run};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleSelfCheck = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

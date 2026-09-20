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
      // The message is the part worth reading; a stack of jar: URLs is not.
      // Reporting only the stack hid every explanation these checks write.
      const said = String(error && error.message || error || 'failed');
      const where = error && error.stack ? String(error.stack).split('\n')[0] : '';
      return bad(name, where && !where.includes(said) ? `${said}  [${where}]` : said);
    }
  }

  async function run(Zotero, runtime, {network = true, repair = false, fill = false, shots = false} = {}) {
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

    results.push(await attempt('every safe button on every tab survives a press', async () => {
      /* The real DOM, not the fixture: XUL quirks, missing globals and stale
         handlers show up here. Buttons that reach the network, write to the
         library or let go of something are skipped by their verbs; the rest
         are pressed once, and a status line naming a JavaScript error fails. */
      const state = runtime.windows.get(win);
      const bench = state && state.workbench;
      if (!bench) throw new Error('workbench not attached');
      /* data-opens is the contract for windows; these verbs are the second net,
         for anything that writes to the library or edits an item in place. */
      const skip = /가져오기|조회|새로고침|확인|함께 읽기|검색|내려받기|채우기|저장|복사|열기|이동|해제|병합|휴지통|초기화|복원|삭제|중지|등록|전환|만들기|추가|연결|적용|다시|찾기|가리기|표시|보기|JCR|OpenAlex|ZotPoP|번역|요약|제안|정리|옮기기|지우기|되돌리기|편집|바꾸기|노트로|전체 선택/;
      const jsError = /TypeError|ReferenceError|RangeError|is not a function|Cannot read|Cannot set|undefined|NaN/;
      const tabs = (root.CustomStyleWorkbench && root.CustomStyleWorkbench.TABS || []).map(row => row[0]);
      const broken = []; let pressed = 0;
      for (const tab of tabs) {
        try { await bench.show(tab); } catch (error) { broken.push(tab + ' · show → ' + (error.message || error)); continue; }
        const seen = new Set();
        /* A note title is a button label, so the verb list cannot catch it:
           anything that opens a Zotero window says so with data-opens, and the
           sweep leaves those alone instead of stacking empty note editors. */
        const buttons = [...bench.panel.querySelectorAll('.sc-body button')].filter(b => !b.disabled && !b.hidden && !b.hasAttribute('data-opens') && b.textContent.trim() && !skip.test(b.textContent) && !seen.has(b.textContent.trim()));
        for (const b of buttons.slice(0, 12)) {
          const label = b.textContent.trim(); seen.add(label);
          if (!b.isConnected) continue;
          try { b.click(); pressed++; } catch (error) { broken.push(`${tab} · ${label} → ${error.message || error}`); continue; }
          await new Promise(resolve => win.setTimeout(resolve, 60));
          const status = bench.panel.querySelector('.sc-status');
          if (status && status.dataset.error === 'true' && jsError.test(status.textContent)) broken.push(`${tab} · ${label} → ${status.textContent.slice(0, 80)}`);
          if (bench.state.tab !== tab) { try { await bench.show(tab); } catch (ignored) {} }
        }
      }
      try { await bench.toggle(false); } catch (ignored) {}
      if (broken.length) throw new Error(broken.join(' | '));
      return `${pressed} buttons pressed across ${tabs.length} tabs, none threw`;
    }));

    results.push(await attempt('a double-click on a column edge fits the column to its content', async () => {
      /* The user reported the fit not happening. The handler is real code on
         the real header: dispatch the double-click it listens for and read
         back what it did, or where it stopped. */
      const state = runtime.windows.get(win);
      if (!state || !state.columnFit) throw new Error('column fit not attached');
      const resizers = [...win.document.querySelectorAll('.virtualized-table-header .resizer')];
      if (!resizers.length) throw new Error('no column resizers in the items header');
      const tree = win.ZoteroPane?.itemsView?.tree;
      const visible = tree?._getVisibleColumns?.() || [];
      const target = resizers.find(node => { const key = [...node.classList].find(n => !['resizer', 'draggable'].includes(n)); const i = visible.findIndex(c => c.dataKey === key); return i >= 0 && i < visible.length - 1; }) || resizers[0];
      const key = [...target.classList].find(n => !['resizer', 'draggable'].includes(n));
      const cell = () => win.document.querySelector(`#${tree.props.id} .virtualized-table-header .cell.${win.CSS.escape(key)}`);
      const before = cell()?.getBoundingClientRect().width;
      target.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, cancelable: true, view: win }));
      await new Promise(resolve => win.setTimeout(resolve, 120));
      const after = cell()?.getBoundingClientRect().width;
      if (!state.columnFit.seen) throw new Error(`the double-click never reached the handler (resizer classes: ${target.className})`);
      if (!state.columnFit.fitted) throw new Error(`the handler stopped: ${state.columnFit.last}`);
      return `${state.columnFit.last} · header ${Math.round(before)} → ${Math.round(after)}px · ${resizers.length} resizers`;
    }));

    if (shots) results.push(await attempt('pictures of the panel for the README, taken off the hidden window', async () => {
      /* drawWindow paints from layout, so a window that is hidden from the
         screen still yields its picture. Nothing is brought forward. */
      const state = runtime.windows.get(win), bench = state && state.workbench;
      if (!bench) throw new Error('workbench not attached');
      const dir = PathUtils.join(PathUtils.parent(runtime.selfCheckPath || Zotero.DataDirectory.dir + '/style-custom-selfcheck.json'), 'style-custom-shots');
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
      const shoot = async name => {
        await new Promise(resolve => win.setTimeout(resolve, 900));
        const scale = 2, w = win.innerWidth, h = win.innerHeight;
        const canvas = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
        canvas.width = w * scale; canvas.height = h * scale;
        const ctx = canvas.getContext('2d'); ctx.scale(scale, scale);
        ctx.drawWindow(win, 0, 0, w, h, '#ffffff');
        const data = canvas.toDataURL('image/png').split(',')[1];
        const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        await IOUtils.write(PathUtils.join(dir, name + '.png'), bytes);
        return `${name} ${w}×${h}`;
      };
      const taken = [];
      try { await bench.toggle(false); } catch (ignored) {}
      taken.push(await shoot('library'));
      await bench.show('explore'); if (!bench.docked()) { try { bench.dock(); } catch (ignored) {} }
      for (const tab of ['explore', 'related', 'authors', 'journals', 'annotations', 'graph', 'collections', 'reading', 'matrix']) {
        try { await bench.show(tab); taken.push(await shoot(tab)); } catch (error) { taken.push(`${tab} failed: ${error.message || error}`); }
      }
      try { await bench.toggle(false); } catch (ignored) {}
      return taken.join(' · ') + ' → ' + dir;
    }));

    results.push(await attempt('the panel can sit in a Zotero tab and fill it', async () => {
      const state = runtime.windows.get(win);
      const bench = state && state.workbench;
      if (!bench || typeof bench.dock !== 'function') throw new Error('workbench not attached');
      if (!win.Zotero_Tabs || typeof win.Zotero_Tabs.add !== 'function') return 'this window has no tab bar';
      const before = win.Zotero_Tabs.selectedID;
      await bench.show('explore');
      if (!bench.docked() && !bench.dock()) throw new Error('Zotero_Tabs.add refused: ' + (bench.dockError?.() || 'no reason given'));
      try {
        await new Promise(resolve => win.setTimeout(resolve, 250));
        const inTab = !!bench.panel.closest('#tabs-deck, .tab-container, [id^="zotero-tabs"], deck') || bench.panel.parentNode !== win.document.documentElement;
        const rect = bench.panel.getBoundingClientRect();
        const tabID = win.Zotero_Tabs.selectedID;
        const drawn = bench.panel.querySelector('.sc-paper-card, .sc-empty, .sc-hits');
        if (!inTab) throw new Error('the panel did not move into the tab');
        if (rect.width < 400 || rect.height < 300) throw new Error(`the panel measures ${Math.round(rect.width)}×${Math.round(rect.height)} in the tab`);
        if (!drawn) throw new Error('nothing drawn inside the tab');
        return `tab ${tabID} · ${Math.round(rect.width)}×${Math.round(rect.height)} · ${bench.docked() ? 'docked' : 'not docked'}`;
      } finally {
        try { bench.undock(); } catch (ignored) {}
        try { await bench.toggle(false); } catch (ignored) {}
        try { if (before) win.Zotero_Tabs.select(before); } catch (ignored) {}
      }
    }));

    results.push(await attempt('the item menu shows a sign on every verb', () => {
      const menu = win.document.getElementById('style-custom-itemmenu');
      if (!menu) throw new Error('menu not attached');
      const items = [...menu.querySelectorAll('menuitem, menu')].filter(node => node.closest('menupopup')?.parentNode === menu || node.parentNode?.parentNode === menu);
      const top = [...menu.querySelector('menupopup').children].filter(node => node.localName === 'menuitem' || node.localName === 'menu');
      const signed = top.filter(node => node.getAttribute('image') && /iconic/.test(node.className));
      const bare = top.filter(node => !node.getAttribute('image')).map(node => node.getAttribute('label'));
      if (signed.length < 15) throw new Error(`${signed.length} of ${top.length} entries carry a sign · bare: ${bare.join(' · ')}`);
      const sample = signed[0].getAttribute('image');
      if (!/^data:image\/svg\+xml/.test(sample)) throw new Error('the sign is not an inline SVG: ' + sample.slice(0, 40));
      // And every label has English waiting for it, so the menu is not the one place a distributed copy speaks Korean.
      // In Korean the labels are the keys; ask the dictionary for each one as English would.
      const i18n = runtime.i18n;
      const labels = top.map(node => node.getAttribute('label')).filter(Boolean);
      const before = i18n.locale();
      let untranslated = [];
      try { i18n.use('en-US'); untranslated = labels.filter(label => /[가-힣]/.test(i18n.t(label))); }
      finally { i18n.use(before); }
      if (untranslated.length) throw new Error(`${untranslated.length} menu labels have no English: ${untranslated.slice(0, 4).join(' · ')}`);
      return `${signed.length}/${top.length} entries signed · ${menu.querySelectorAll('menuseparator').length} separators · English for all ${labels.length}`;
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

    // Both plugins claim a place in the items toolbar. Whether either one is
    // actually there, and whether they can be told apart, is not something the
    // code can answer about itself.
    // What is actually in that toolbar, in order, so the button can be placed
    // beside the other tools rather than guessed at.
    // The language toggle, proved against the running application rather than
    // against the table on its own.
    results.push(await attempt('the panel speaks the chosen language', () => {
      const chosen = runtime.pref('language', 'auto');
      const active = runtime.applyLocale();
      const samples = ['보유 문헌', '관계 그래프', '주석', '문헌을 하나 선택하세요.'];
      const shown = samples.map(text => runtime.t(text));
      if (active === 'en-US' && shown.every((text, i) => text === samples[i])) {
        throw new Error('English is selected but nothing is being translated');
      }
      if (active === 'ko-KR' && shown.some((text, i) => text !== samples[i])) {
        throw new Error('Korean is selected but text is being translated anyway');
      }
      const table = runtime.i18n._table();
      const size = Object.keys(table).length;
      const covered = samples.filter(text => table[text] !== undefined).length;
      return `설정 ${chosen} → ${active} · 사전 ${size}개 · 예: ${shown.slice(0, 2).join(' / ')}`
        + ` · 표본 ${covered}/${samples.length}`;
    }));

    // And how much of the interface the table actually reaches, counted rather
    // than guessed: an untranslated string still reads in Korean, so coverage
    // is a number to improve, not a breakage.
    results.push(await attempt('how much of the interface is translated', () => {
      const table = runtime.i18n._table();
      const labels = (runtime.columnDefinitions || []).map(row => row[1]);
      const tabs = (root.CustomStyleWorkbench?.TABS || []).map(row => row[1]);
      const wanted = [...labels, ...tabs].filter(Boolean);
      const missing = wanted.filter(text => /[가-힣]/.test(text) && table[text] === undefined);
      return `사전 ${Object.keys(table).length}개 · 열·탭 ${wanted.length}개 중 미번역 ${missing.length}`
        + (missing.length ? ` (${missing.slice(0, 4).join(', ')})` : '');
    }));

    results.push(await attempt('where the toolbar button sits', () => {
      if (!doc) throw new Error('no main window');
      const bar = doc.getElementById('zotero-items-toolbar');
      if (!bar) throw new Error('no items toolbar');
      return [...bar.children].map(child =>
        `${child.id || child.localName}${child.id === 'style-custom-workbench-button' ? '*' : ''}`).join(' > ');
    }));

    results.push(await attempt('both plugins have their own toolbar shortcut', () => {
      if (!doc) throw new Error('no main window');
      const bar = doc.getElementById('zotero-items-toolbar');
      if (!bar) throw new Error('no items toolbar');
      const ours = doc.getElementById('style-custom-workbench-button');
      const theirs = doc.getElementById('zotpop-toolbar-button');
      const missing = [!ours && 'Style Custom', !theirs && 'ZotPoP'].filter(Boolean);
      if (missing.length) throw new Error('no toolbar button for ' + missing.join(' and '));
      const image = button => String(button.getAttribute('image') || '');
      if (image(ours) === image(theirs)) throw new Error('both buttons use the same icon');
      const hidden = [ours, theirs].filter(button => button.hidden
        || (win.getComputedStyle && win.getComputedStyle(button).display === 'none'));
      if (hidden.length) throw new Error(`${hidden.length} toolbar button(s) are present but not visible`);
      return `${image(ours).split('/').pop()} + ${image(theirs).split('/').pop()}`;
    }));

    results.push(await attempt('a failed request is reported as a sentence, not a URL', () => {
      const failures = root.CustomStyleFailures;
      if (!failures) throw new Error('the failure translator did not load');
      const budget = Object.assign(new Error(
        'HTTP GET https://api.openalex.org/works?per_page=25&filter=author.id%3AA1 failed with status code 429'),
        {status: 429});
      const said = failures.describe(budget);
      if (/https?:\/\//.test(said)) throw new Error('still printing the URL: ' + said);
      if (!/OpenAlex/.test(said)) throw new Error('does not say which service: ' + said);
      return said.slice(0, 60) + '…';
    }));

    // What the Files column actually says, for one item of each kind. A verdict
    // that never reaches the cell is a verdict nobody sees.
    // How much of this library's own journal list gets a real colour, now that
    // the registry knows a publisher for nearly every JCR journal.
    results.push(await attempt('journal colours reach the library', async () => {
      const identity = runtime.journalIdentity;
      const size = identity._registrySize ? identity._registrySize() : 0;
      const venues = new Set();
      for (const item of await runtime.libraryItems(library)) {
        if (!runtime.isRegular(item)) continue;
        const venue = String(item.getField('publicationTitle') || '').trim();
        if (venue) venues.add(venue);
      }
      let exact = 0, rule = 0, publisher = 0, derived = 0;
      for (const venue of venues) {
        const id = identity.identify(venue);
        if (!id) { derived++; continue; }
        if (id.exact) exact++; else if (id.viaPublisher) publisher++; else if (id.known) rule++; else derived++;
      }
      if (!size) throw new Error('journal registry did not load');
      return `등록 저널 ${size} · 이 라이브러리 저널 ${venues.size}종: 브랜드색 ${exact} · 규칙 ${rule} · 출판사색 ${publisher} · 유도색 ${derived}`;
    }));

    results.push(await attempt('the files column says what the scan found', async () => {
      if (!doc) throw new Error('no main window');
      const findings = await runtime.attachmentFindings(library);
      const said = [];
      // The badge text, not the group heading: the column says "SI", which is
      // what publishers call it and what the user is looking for.
      for (const [label, rows] of [['SI', findings.supplementary],
                                   ['중복', findings.duplicate], ['다른 논문', findings.foreign]]) {
        if (!rows.length) { said.push(`${label} 0`); continue; }
        const item = await Zotero.Items.getAsync(Number(rows[0].id));
        // renderCell finds its item through the visible row, so a row has to
        // stand in for one. Borrowed and put straight back: the alternative is
        // changing what the user has selected in order to test a badge.
        const view = win.ZoteroPane && win.ZoteroPane.itemsView;
        if (!view || typeof view.getRow !== 'function') throw new Error('no item tree to render into');
        const original = view.getRow;
        let cell;
        try {
          view.getRow = () => ({ref: item});
          cell = runtime.renderCell('files', 0, runtime.value('files', item), {className: ''}, doc);
        } finally { view.getRow = original; }
        const text = String(cell.textContent || '');
        if (!text.includes(label)) throw new Error(`${label}: the cell reads "${text}"`);
        said.push(`${label} ${rows.length} -> "${text}"`);
      }
      return said.join(' · ');
    }));

    // The citation map and the affiliation column share one sweep, so one check
    // reports how far it has got.
    results.push(await attempt('the citation record behind the map', async () => {
      const works = Object.values(runtime.paperWorks());
      const withRefs = works.filter(work => Array.isArray(work.references) && work.references.length);
      const references = withRefs.reduce((n, work) => n + work.references.length, 0);
      const institutions = Object.values(runtime.institutionTable());
      const ranked = institutions.filter(row => row.hIndex > 0);
      return `조회한 논문 ${works.length} · 참고문헌 있는 논문 ${withRefs.length} · 참고문헌 ${references}건`
        + ` · 기관 ${institutions.length} (h-index 있음 ${ranked.length})`;
    }));

    results.push(await attempt('the affiliation column has something to say', async () => {
      if (!doc) throw new Error('no main window');
      const all = await runtime.libraryItems(library);
      const papers = all.filter(item => runtime.isRegular(item));
      const known = papers.map(item => runtime.affiliationOf(item)).filter(Boolean);
      if (!known.length) return '아직 조회 전 (인용 목록 가져오기를 실행하세요)';
      const international = known.filter(row => row.international).length;
      const tiered = known.filter(row => row.tier).length;
      const sample = known.find(row => row.first && row.first.institution);
      return `${known.length}편 · 국제공동 ${international} · 기관 등급 있음 ${tiered}`
        + (sample ? ` · 예: ${sample.first.institution}${sample.first.country ? ' (' + sample.first.country + ')' : ''}` : '');
    }));

    results.push(await attempt('what the attachment scan found', async () => {
      const found = await runtime.attachmentFindings(library);
      const orphan = found.orphan || [];
      const placed = orphan.filter(row => row.home && row.home.id).length;
      return `보충자료 ${found.supplementary.length} · 중복 ${found.duplicate.length}`
        + ` · 다른 논문 ${found.foreign.length} · 첨부 없음 ${found.missing.length}`
        + ` · 보충자료만 ${orphan.length} (원논문 찾음 ${placed})`
        + (found.unread ? ` · 미판별 ${found.unread}` : '');
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

    /* What the outside services are told about this caller.

       Leaving the address blank used to fail this check, which made it
       permanently red for anyone who had decided not to give one -- and a check
       that is always red is a check nobody reads. Supplying an address is a
       choice about publishing it, not a setting that is wrong when unset, so an
       empty one is reported rather than complained about. A key that is missing
       is a different matter: the daily allowance without one is about ten
       requests, which does stop the sweeps working. */
    results.push(await attempt('contact details reach the APIs', () => {
      const options = runtime.discoverOptions();
      const bits = [];
      bits.push(options.apiKey ? `OpenAlex key ok (${String(options.apiKey).length} chars)` : 'NO OPENALEX KEY');
      bits.push(options.email
        ? `mailto set (polite pool)`
        : 'mailto 없음 — 익명 대기열을 씁니다. 설정 → 연락 이메일에 주소를 넣으면 빨라집니다.');
      if (!options.apiKey) throw new Error(bits.join(' · ') + ' · 키 없이는 하루 약 10건입니다');
      return bits.join(' · ');
    }));

    results.push(await attempt('patents: the USPTO key, if any, is accepted', async () => {
      const key = runtime.patentsKey();
      if (!key) return 'no USPTO key set — the patents tier is off. Free at data.uspto.gov (MyUSPTO).';
      if (!network) return `key set (${key.length} chars) · not tried offline`;
      const [row] = runtime.watchedAuthors();
      if (!row) return `key set (${key.length} chars) · no followed author to try`;
      const payload = await runtime.discoverJSON(runtime.patentTools.searchURL(row.name), {headers: runtime.patentTools.headers(key)});
      const found = runtime.patentTools.readPatents(payload);
      const mine = found.filter(patent => runtime.patentTools.matchesInventor(patent, row.name));
      return `${row.name}: ${found.length} answered · ${mine.length} match the inventor` + (mine[0] ? ` · e.g. ${mine[0].id} ${mine[0].title.slice(0, 50)}` : '');
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
        if (report.journals) bits.push(`journals found ${report.journals.found} · missing ${report.journals.missing}` + (report.journals.profiles ? ` · profiles filled ${report.journals.profiles.filled}/${report.journals.profiles.journals}` : ''));
        if (report.authors) bits.push(`authors ${report.authors.authors} · with news ${report.authors.withNews} · works ${report.authors.works} · records ${report.authors.profiles ?? '-'}`);
        if (report.patents) bits.push(report.patents.skipped === 'no-key' ? 'patents skipped (no USPTO key)' : `patents checked ${report.patents.checked} · with patents ${report.patents.withPatents} · new ${report.patents.fresh}` + (report.patents.unauthorized ? ' · KEY REFUSED' : ''));
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

/* The live reader self-check: the reader panel measured on a real PDF in the real Zotero, with nobody at the keyboard.

   Opt-in (extensions.style-custom.selfCheckReader, read by bootstrap.js with the main selfCheck flag and cleared
   before the run). The default self-check never calls this, so it never opens a reader.

   What it does, in order:
   1. picks a PDF: the attachment of a regular item with a local file, preferring a parent with a DOI and >= 6
      pages (the full-text index's page count), lowest itemID first. A PDF whose only tab is an unloaded one is
      skipped: Zotero.Reader.open would select that tab (reader.js: "try to find an unloaded tab and select it").
      If the user has it open in a loaded reader, that reader is reused read only and never closed.
   2. opens it in a background tab: Zotero.Reader.open(id, {pageIndex: 0}, {openInBackground: true,
      allowDuplicate: false}). Zotero runs hidden for self-checks (open -gj), so nothing reaches the screen.
      Zotero's own view-state write for that tab (last page, scroll) is suppressed: it is a tab the user never opened.
   3. waits for reader._initPromise, PDFViewerApplication.pdfDocument and page 1 rendered (30 s in all).
   4. measures through reader-assist's diagnose() handle -- the panel's own functions on a probe session -- with
      failing spies on everything that speaks, launches, sends or writes (see guards()).
   5. closes its own tab, checks nothing of ours is left in that reader, and writes
      <data dir>/style-custom-reader-check.json. selfcheck.js folds the result into one step.

   The measuring helpers are pure (rectangles, colours, rows, coverage) so the tests drive them without Zotero. */
(function (root) {
  'use strict';

  const REPORT_FILE = 'style-custom-reader-check.json';
  // A call whose stack runs through one of these files is the reader panel's own doing.
  const READER_MODULES = /\/(?:reader-assist|read-aloud|paper-chat|paper-translate|paper-text|assist)\.js\b/;
  const IO_WRITES = ['writeUTF8', 'write', 'writeJSON', 'remove', 'move', 'copy', 'makeDirectory', 'setModificationTime', 'setPermissions', 'createUniqueFile', 'createUniqueDirectory'];
  const RENDERED = 3;   // pdf.js RenderingStates.FINISHED (viewer.mjs)

  const clean = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const truncate = (value, n = 120) => { const s = clean(value); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const message = error => String(error && error.message || error || 'failed');

  /* ---- colours ------------------------------------------------------------ */
  function parseColor(value) {
    const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)/.exec(String(value || ''));
    if (!m) return null;
    let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    if (!Number.isFinite(a)) a = 1;
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  const luminance = ([r, g, b]) => {
    const c = [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  function contrastRatio(a, b) {
    const l1 = luminance(a), l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  // A colour with alpha laid over an opaque one.
  const over = (fg, bg) => fg[3] === undefined || fg[3] >= 1 ? fg.slice(0, 3) : [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
  /* The colour behind a node: its own and its ancestors' backgrounds (nearest first), composited from the first
     opaque one outward; the page colour beneath when none is opaque. */
  function backdrop(layers, base = [255, 255, 255]) {
    const stack = [];
    for (const c of layers || []) { if (!c || !(c[3] > 0)) continue; stack.push(c); if (c[3] >= 1) break; }
    let out = base.slice(0, 3);
    for (const c of stack.reverse()) out = over(c, out);
    return out;
  }
  // The contrast of a (possibly translucent) foreground over a backdrop.
  const textContrast = (fg, bg) => contrastRatio(over(fg, bg), bg);

  /* ---- rectangles ---------------------------------------------------------- */
  function toRect(r) {
    if (!r) return null;
    const left = Number(r.left), top = Number(r.top);
    const width = Number(r.width != null ? r.width : r.right - r.left), height = Number(r.height != null ? r.height : r.bottom - r.top);
    if (![left, top, width, height].every(Number.isFinite)) return null;
    return {left, top, width, height, right: left + width, bottom: top + height};
  }
  const area = r => r ? Math.max(0, r.width) * Math.max(0, r.height) : 0;
  function intersect(a, b) {
    if (!a || !b) return null;
    const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top), right = Math.min(a.right, b.right), bottom = Math.min(a.bottom, b.bottom);
    return right > left && bottom > top ? {left, top, right, bottom, width: right - left, height: bottom - top} : null;
  }
  // Share of a's area that lies inside b.
  const overlapRatio = (a, b) => area(a) ? area(intersect(a, b)) / area(a) : 0;
  // The PDF view ends where the panel begins: never under it.
  const besideNotUnder = (view, panel, tol = 1) => !!view && !!panel && view.right <= panel.left + tol;
  const within = (inner, outer, tol = 1) => !!inner && !!outer && inner.left >= outer.left - tol && inner.top >= outer.top - tol && inner.right <= outer.right + tol && inner.bottom <= outer.bottom + tol;
  // Boxes on one row: their vertical centres agree within tol.
  function oneRow(rects, tol = 3) {
    const centres = (rects || []).filter(r => r && r.width > 0 && r.height > 0).map(r => r.top + r.height / 2);
    return centres.length <= 1 || Math.max(...centres) - Math.min(...centres) <= tol;
  }
  // Children that leave their container sideways: [{label, rect}] → labels with the overshoot in px.
  function overflowing(children, container, tol = 1) {
    if (!container) return [];
    const out = [];
    for (const {label, rect} of children || []) {
      if (!rect || !(rect.width > 0)) continue;
      const by = Math.max(rect.right - container.right, container.left - rect.left);
      if (by > tol) out.push(`${label} by ${Math.round(by)}px`);
    }
    return out;
  }
  // Boxes in percent of a page (the follow-along mark's own units) as pixels in the page's box.
  const percentToPx = (boxes, page) => (boxes || []).map(b => toRect({left: page.left + b.left / 100 * page.width, top: page.top + b.top / 100 * page.height, width: b.width / 100 * page.width, height: b.height / 100 * page.height}));

  /* Does the mark sit on the sentence's text? coverage: the share of the mark's area that text-layer spans cover
     (sampled on a grid). recall: the share of the sentence's words found in the spans the mark touches. A mark one
     line off still sits on text (coverage) but on other words (recall), so both are asked for. */
  const words = text => (clean(text).toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]{3,}/gu) || []);
  function overlayAgreement(boxes, spans, sentence, {grid = [12, 3]} = {}) {
    const rects = (boxes || []).filter(b => b && b.width > 0 && b.height > 0);
    const live = (spans || []).filter(s => s && s.rect && area(s.rect) > 0);
    let points = 0, covered = 0;
    for (const b of rects) {
      for (let i = 0; i < grid[0]; i++) for (let j = 0; j < grid[1]; j++) {
        const x = b.left + (i + 0.5) / grid[0] * b.width, y = b.top + (j + 0.5) / grid[1] * b.height;
        points++;
        if (live.some(s => x >= s.rect.left && x <= s.rect.right && y >= s.rect.top && y <= s.rect.bottom)) covered++;
      }
    }
    const touched = live.filter(s => rects.some(b => { const i = intersect(s.rect, b); return i && area(i) >= 0.3 * Math.min(area(s.rect), area(b)); }));
    const want = new Set(words(sentence)), got = new Set(words(touched.map(s => s.text).join(' ')));
    const found = [...want].filter(w => got.has(w)).length;
    return {boxes: rects.length, spans: touched.length, coverage: points ? covered / points : 0, recall: want.size ? found / want.size : 0};
  }

  /* ---- the test PDF ------------------------------------------------------- */
  // 0: DOI and >= 6 pages; 1: DOI, page count unknown; 2: DOI, fewer pages; 3: >= 6 pages; 4: anything else.
  function rankAttachment(row) {
    const doi = !!(row && row.doi), pages = Number(row && row.pages) || 0;
    return doi && pages >= 6 ? 0 : doi && !pages ? 1 : doi ? 2 : pages >= 6 ? 3 : 4;
  }
  // Lowest itemID in the best rank; never one whose only tab is unloaded (opening it would select the user's tab).
  function orderCandidates(rows) {
    return (rows || []).filter(r => r && r.tab !== 'unloaded')
      .map(r => ({r, rank: rankAttachment(r)}))
      .sort((a, b) => a.rank - b.rank || a.r.id - b.r.id).map(x => x.r);
  }
  const chooseAttachment = rows => orderCandidates((rows || []).filter(r => r && r.exists !== false))[0] || null;
  function doiOf(item) {
    let doi = '';
    try { doi = clean(item.getField('DOI')); } catch (ignored) { /* not a field of this type */ }
    if (!doi) { try { const m = /\bDOI:\s*(10\.\S+)/i.exec(String(item.getField('extra') || '')); if (m) doi = m[1]; } catch (ignored) {} }
    return /^10\.\S+\/\S+/.test(doi) ? doi : '';
  }
  function tabStateOf(Zotero, win, itemID) {
    try { if ((Zotero.Reader._readers || []).some(r => r.itemID === itemID)) return 'loaded'; } catch (ignored) {}
    try { if (win && win.Zotero_Tabs && win.Zotero_Tabs.getTabIDByItemID(itemID)) return 'unloaded'; } catch (ignored) {}
    return 'none';
  }
  async function pickAttachment(Zotero, {io = null, win = null, limit = 400} = {}) {
    let items = Zotero.Items.getAll(Zotero.Libraries.userLibraryID);
    if (items && typeof items.then === 'function') items = await items;
    const pdfs = (Array.isArray(items) ? items : []).filter(it => {
      try { return it.isAttachment() && it.isPDFAttachment() && !it.deleted && !!it.parentID; } catch (ignored) { return false; }
    }).sort((a, b) => a.id - b.id);
    // The page count the full-text index recorded, in one read-only query (Zotero.Fulltext.getPages reads the same table).
    const pages = new Map();
    try { for (const row of await Zotero.DB.queryAsync('SELECT itemID, totalPages FROM fulltextItems') || []) pages.set(Number(row.itemID), Number(row.totalPages) || 0); }
    catch (ignored) { /* no index: every page count is unknown */ }
    const rows = [];
    for (const it of pdfs) {
      let parent = null;
      try { parent = Zotero.Items.get(it.parentID); } catch (ignored) {}
      if (!parent || !parent.isRegularItem || !parent.isRegularItem() || parent.deleted) continue;
      let title = '';
      try { title = parent.getField('title'); } catch (ignored) {}
      rows.push({id: it.id, key: it.key, libraryID: it.libraryID, parentID: parent.id, parentKey: parent.key, item: it,
        doi: doiOf(parent), pages: pages.get(it.id) || 0, tab: tabStateOf(Zotero, win, it.id), title: truncate(title, 120)});
    }
    let tried = 0;
    for (const row of orderCandidates(rows)) {
      if (tried++ >= limit) break;
      let path = false, exists = false;
      try { path = await row.item.getFilePathAsync(); } catch (ignored) {}
      try { exists = !!path && (io ? await io.exists(path) : true); } catch (ignored) {}
      if (exists) return {...row, file: String(path).split(/[\\/]/).pop(), rank: rankAttachment(row), scanned: rows.length, tried};
    }
    return null;
  }

  /* ---- extraction ---------------------------------------------------------- */
  // What the panel would read aloud as body: every sentence outside the back matter, in reading order.
  function bodyUnits(structured, PT) {
    if (!structured || !PT || typeof PT.readingOrder !== 'function') return [];
    return PT.readingOrder(structured).filter(u => u.kind !== 'back');
  }
  function extractionSummary(structured, PT, {ms = [], pages = 0} = {}) {
    if (!structured) return {fallback: true, reason: 'no structure', body: 0, withRects: 0, rectShare: 0};
    const stats = structured.stats || {};
    const units = bodyUnits(structured, PT);
    const withRects = units.filter(u => Array.isArray(u.rects) && u.rects.length).length;
    const total = ms.reduce((a, b) => a + b, 0);
    return {
      fallback: !!stats.unreadable, unreadable: !!stats.unreadable, pages: stats.pages || pages,
      body: units.length, withRects, rectShare: units.length ? withRects / units.length : 0,
      captions: (structured.captions || []).length, references: (structured.references || []).length,
      columns: stats.columns || 0, sections: (structured.sections || []).length,
      msPerPage: ms.length ? Math.round(total / ms.length) : null,
      first: units.slice(0, 3).map(u => truncate(u.text, 120)), last: units.slice(-3).map(u => truncate(u.text, 120))
    };
  }

  /* ---- the panel ---------------------------------------------------------- */
  const SVG = 'http://www.w3.org/2000/svg';
  const describe = node => `${String(node.localName || node.tagName || '').toLowerCase()}${node.className && typeof node.className === 'string' ? '.' + node.className.trim().split(/\s+/).join('.') : ''}`;
  const rectOf = node => { try { return toRect(node.getBoundingClientRect()); } catch (ignored) { return null; } };
  function baseColor(win, node) {
    try {
      const doc = node.ownerDocument;
      for (const n of [doc.body, doc.documentElement]) { const c = n && parseColor(win.getComputedStyle(n).backgroundColor); if (c && c[3] >= 1) return c.slice(0, 3); }
      const scheme = String(win.getComputedStyle(node).colorScheme || '');
      return /dark/.test(scheme) && !/light/.test(scheme) ? [30, 30, 30] : [255, 255, 255];
    } catch (ignored) { return [255, 255, 255]; }
  }
  function backdropOf(win, node) {
    const layers = [];
    for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
      const c = parseColor(win.getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    return backdrop(layers, baseColor(win, node));
  }
  /* Every visible node of the panel: text at least 11px and 4.5:1 against what is really behind it, icon-only
     buttons 3:1, nothing poking out of the panel sideways, nothing clipping its own text. */
  function measurePanel(win, panel, {minFont = 11, minText = 4.5, minIcon = 3, clipOK = /sc-ra-(sentence|row-meta|pill-text|progress|tab-text|status)/} = {}) {
    const out = {checked: 0, texts: 0, problems: [], smallestFont: null, lowestContrast: null};
    const box = rectOf(panel);
    for (const node of [panel, ...panel.querySelectorAll('*')]) {
      if (node.hidden || (node.closest && node.closest('[hidden]'))) continue;
      if (node.namespaceURI === SVG && String(node.localName).toLowerCase() !== 'svg') continue;
      const style = win.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const r = rectOf(node);
      if (!r || !(r.width > 0 && r.height > 0)) continue;
      out.checked++;
      const own = [...node.childNodes].some(n => n.nodeType === 3 && clean(n.textContent));
      const fg = parseColor(style.color);
      if (own) {
        out.texts++;
        const size = parseFloat(style.fontSize);
        if (size && (out.smallestFont === null || size < out.smallestFont)) out.smallestFont = size;
        if (size && size < minFont) out.problems.push(`${describe(node)} "${truncate(node.textContent, 24)}": ${size}px text under ${minFont}px`);
        if (fg) {
          const ratio = textContrast(fg, backdropOf(win, node));
          if (out.lowestContrast === null || ratio < out.lowestContrast) out.lowestContrast = Math.round(ratio * 100) / 100;
          if (ratio < minText) out.problems.push(`${describe(node)} "${truncate(node.textContent, 24)}": contrast ${ratio.toFixed(2)}:1`);
        }
      }
      if (String(node.localName).toLowerCase() === 'button' && !own && node.querySelector && node.querySelector('svg') && !node.disabled && fg) {
        const ratio = textContrast(fg, backdropOf(win, node));
        if (ratio < minIcon) out.problems.push(`icon button "${truncate(node.getAttribute('aria-label'), 20)}": contrast ${ratio.toFixed(2)}:1`);
      }
      if (box && node !== panel && !(node.closest && node.closest('.sc-ra-menu'))) {
        const by = Math.max(r.right - box.right, box.left - r.left);
        if (by > 1) out.problems.push(`${describe(node)} pokes out of the panel by ${Math.round(by)}px`);
      }
      if (style.overflowX === 'hidden' && node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0 && !clipOK.test(String(node.className || ''))) {
        out.problems.push(`${describe(node)} clips its text (${node.scrollWidth}>${node.clientWidth})`);
      }
    }
    return out;
  }
  // One row of controls that must fit: its children on one line and inside it (and inside the card around it).
  function rowFits(container, {name, card = null} = {}) {
    if (!container) return {name, found: false, problems: [`${name}: not found`]};
    const box = rectOf(container), cardBox = card ? rectOf(card) : null;
    const kids = [...container.children].filter(n => !n.hidden).map(n => ({label: `"${truncate(n.textContent || n.getAttribute('aria-label') || n.getAttribute('title'), 20)}"`, rect: rectOf(n)}));
    const problems = [];
    if (!oneRow(kids.map(k => k.rect))) problems.push(`${name}: wraps onto more than one row`);
    for (const x of overflowing(kids, box)) problems.push(`${name}: ${x} out of the row`);
    if (cardBox) for (const x of overflowing(kids, cardBox)) problems.push(`${name}: ${x} out of its card`);
    if (container.scrollWidth > container.clientWidth + 1 && container.clientWidth > 0) problems.push(`${name}: scrolls sideways (${container.scrollWidth}>${container.clientWidth})`);
    return {name, found: true, count: kids.length, problems};
  }

  /* ---- guards: failing spies ---------------------------------------------- */
  const isLocalURL = url => {
    const s = String(url || '');
    if (!/^https?:/i.test(s)) return true;    // jar:, file:, chrome:, resource: -- the plugin's own files
    return /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(s);
  };
  const hostOf = url => { const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(String(url || '')); return m ? m[1] : String(url || '').slice(0, 40); };
  /* A spy records and swallows a call when `when` says so (a rejected promise, a resolved one or undefined, as the
     real function would answer a failure), and lets every other call through untouched. Zotero's and the plugin's
     shared objects are only blocked for calls coming from the reader modules: a write somebody else makes during
     the check is not lost. */
  function createSpies({stack = () => String(new Error().stack || '')} = {}) {
    const violations = [], restores = [], passed = [], allowances = new Map();
    const fromReader = () => READER_MODULES.test(stack());
    /* allow(label, n): the next n calls a spy would block go through instead, each counted in `passed`. The AI step
       lifts the assist guards this way, one call at a time; every other guard stays as it was. */
    function allow(label, n = 1) { allowances.set(label, (allowances.get(label) || 0) + n); }
    function revoke(label) { const left = allowances.get(label) || 0; allowances.delete(label); return left; }
    /* observe(args, self) -> {args, done(result)}: a look at a call that is let through (the bridge requests). */
    function wrap(owner, name, label, {when = () => true, result = 'reject', detail = null, observe = null} = {}) {
      if (!owner) return false;
      let real;
      try { real = owner[name]; } catch (ignored) { return false; }
      if (typeof real !== 'function') return false;
      const own = Object.prototype.hasOwnProperty.call(owner, name);
      const through = (self, args) => {
        if (!observe) return real.apply(self, args);
        let seen = null;
        try { seen = observe(args, self); } catch (ignored) {}
        const out = real.apply(self, seen && seen.args || args);
        try { if (seen && seen.done) seen.done(out); } catch (ignored) {}
        return out;
      };
      const spy = function (...args) {
        if (!when(args)) return through(this, args);
        if ((allowances.get(label) || 0) > 0) {
          allowances.set(label, allowances.get(label) - 1);
          passed.push({call: label, detail: detail ? truncate(detail(args), 80) : ''});
          return through(this, args);
        }
        violations.push({call: label, detail: detail ? truncate(detail(args), 80) : ''});
        if (result === 'reject') return Promise.reject(Object.assign(new Error('blocked by the reader self-check: ' + label), {blocked: true}));
        if (result === 'resolve') return Promise.resolve(undefined);
        return undefined;
      };
      try { owner[name] = spy; } catch (ignored) { return false; }
      if (owner[name] !== spy) return false;
      restores.push(() => { try { if (own) owner[name] = real; else delete owner[name]; } catch (ignored) {} });
      return true;
    }
    // An object held in a field (runtime.io): replaced for the duration by a proxy whose writes are spied.
    function proxyField(holder, field, label, names, {when = fromReader} = {}) {
      const real = holder && holder[field];
      if (!real) return false;
      const proxy = new Proxy(real, {get(target, prop) {
        const value = target[prop];
        if (typeof value !== 'function') return value;
        if (!names.includes(prop)) return value.bind(target);
        return (...args) => {
          if (!when(args)) return value.apply(target, args);
          violations.push({call: `${label}.${String(prop)}`, detail: truncate(String(args[0] || '').split(/[\\/]/).pop(), 80)});
          return Promise.resolve(undefined);
        };
      }});
      holder[field] = proxy;
      restores.push(() => { if (holder[field] === proxy) holder[field] = real; });
      return true;
    }
    function record(label, detail = '') { violations.push({call: label, detail}); return true; }
    function restore() { for (const undo of restores.splice(0).reverse()) undo(); }
    return {violations, passed, allow, revoke, wrap, proxyField, record, restore, fromReader};
  }
  /* What may not happen while the check runs: speech, a process, a request to a server, a write to the library, the
     plugin's data or the reader cache, an AI or translation call. */
  function guards(spies, {Zotero, runtime, service, bridge = null}) {
    const {wrap, fromReader} = spies;
    const installed = [];
    const add = ok => { if (ok) installed.push(ok); };
    add(wrap(Zotero.HTTP, 'request', 'Zotero.HTTP.request', {when: args => !isLocalURL(args[1]) && fromReader(), result: 'reject', detail: args => `${args[0]} ${hostOf(args[1])}`,
      observe: bridge ? (args => bridge.observe(args)) : null}) && 'network');
    for (const name of ['paperSummary', 'chat', 'translateParagraphs', 'complete']) add(wrap(runtime.assist, name, 'assist.' + name, {result: 'reject'}) && 'assist.' + name);
    for (const name of ['edit', 'addReading', 'flush', 'scheduleFlush', 'setSetting', 'importWork', 'queueForReading']) add(wrap(runtime, name, 'runtime.' + name, {when: fromReader, result: 'resolve'}) && 'runtime.' + name);
    add(wrap(runtime.storage, 'write', 'storage.write', {when: fromReader, result: 'resolve'}) && 'storage.write');
    for (const name of ['setRemark', 'createNoteHTML', 'setTags', 'addTag', 'removeTag']) add(wrap(runtime.libraryService, name, 'library.' + name, {when: fromReader, result: 'resolve'}) && 'library.' + name);
    const proto = Zotero.Item && Zotero.Item.prototype;
    for (const name of ['saveTx', 'save', 'eraseTx', 'erase']) add(wrap(proto, name, 'Zotero.Item.' + name, {when: fromReader, result: 'resolve'}) && 'Zotero.Item.' + name);
    add(wrap(Zotero.Items, 'trashTx', 'Zotero.Items.trashTx', {when: fromReader, result: 'resolve'}) && 'Zotero.Items.trashTx');
    add(spies.proxyField(runtime, 'io', 'io', IO_WRITES) && 'files');
    if (service && typeof service.setGuard === 'function') { service.setGuard(label => spies.record(label)); installed.push('process'); }
    return installed;
  }
  // speechSynthesis.speak on a reader's windows: any call at all is a failure (nothing here should speak).
  function guardSpeech(spies, windows) {
    let n = 0;
    for (const win of windows) {
      let synth = null;
      try { synth = win && win.speechSynthesis; } catch (ignored) {}
      if (synth && spies.wrap(synth, 'speak', 'speechSynthesis.speak', {result: 'undefined', detail: args => clean(args[0] && args[0].text)})) n++;
    }
    return n;
  }

  /* ---- the reader --------------------------------------------------------- */
  const appOf = reader => {
    try { const w = reader._internalReader && reader._internalReader._primaryView && reader._internalReader._primaryView._iframeWindow; const u = w && (w.wrappedJSObject || w); return u && u.PDFViewerApplication || null; }
    catch (ignored) { return null; }
  };
  const viewDocOf = reader => { try { return reader._internalReader._primaryView._iframeWindow.document; } catch (ignored) { return null; } };
  function pageRendered(reader, number = 1) {
    const app = appOf(reader);
    try { const view = app && app.pdfViewer && app.pdfViewer.getPageView(number - 1); if (view && view.renderingState === RENDERED) return true; } catch (ignored) {}
    const doc = viewDocOf(reader);
    try { return !!(doc && doc.querySelector(`.page[data-page-number="${number}"] .textLayer span`)); } catch (ignored) { return false; }
  }
  // Leaf spans of a page's text layer, with their boxes.
  function textSpans(pageEl) {
    if (!pageEl) return [];
    return [...pageEl.querySelectorAll('.textLayer span')].filter(s => !s.querySelector('span'))
      .map(s => ({text: s.textContent || '', rect: rectOf(s)})).filter(s => s.rect && s.rect.width > 0 && clean(s.text));
  }
  // The box an absolutely positioned child is placed in: the page element's padding box.
  function paddingBox(el) {
    const r = rectOf(el);
    if (!r) return null;
    const cl = Number(el.clientLeft) || 0, ct = Number(el.clientTop) || 0;
    const cw = Number(el.clientWidth) || r.width, ch = Number(el.clientHeight) || r.height;
    return toRect({left: r.left + cl, top: r.top + ct, width: cw, height: ch});
  }
  /* Which of the panel's listeners are still registered: nsIEventListenerService lists every listener on a target. */
  function listenersOf(els, targets, fns) {
    if (!els || typeof els.getListenerInfoFor !== 'function') return null;
    const ours = new Set((fns || []).filter(Boolean));
    let total = 0, mine = 0;
    for (const target of targets) {
      if (!target) continue;
      let infos = [];
      try { infos = els.getListenerInfoFor(target) || []; } catch (ignored) { continue; }
      for (const info of infos) { total++; let fn = null; try { fn = info.listenerObject; } catch (ignored) {} if (fn && ours.has(fn)) mine++; }
    }
    return {total, mine};
  }

  /* ---- the AI round trip (opt-in: selfCheckReaderAI) ------------------------ */
  const BRIDGE_URL = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/v1\/chat\/completions\b/i;
  /* Every request to the local bridge, seen from inside Zotero.HTTP.request: when it started, when the first byte
     came (the transport's own requestObserver keeps working), when it ended, its status and x-bridge-provider. */
  function bridgeWatch({now = () => Date.now()} = {}) {
    const calls = [];
    function observe(args) {
      const [method, url, options, ...rest] = args;
      if (!BRIDGE_URL.test(String(url || '')) || !options || typeof options !== 'object') return null;
      const call = {t0: now(), firstByte: null, end: null, status: null, provider: null, stream: false, error: null, host: hostOf(url)};
      try { call.stream = !!JSON.parse(String(options.body || '{}')).stream; } catch (ignored) {}
      calls.push(call);
      const header = x => { try { const v = x && x.getResponseHeader && x.getResponseHeader('x-bridge-provider'); if (v && !call.provider) call.provider = String(v).trim().toLowerCase(); } catch (ignored) {} };
      const theirs = options.requestObserver;
      const watched = Object.assign({}, options, {requestObserver: xhr => {
        if (typeof theirs === 'function') theirs(xhr);
        const seen = () => {
          if (Number(xhr.readyState) >= 2) header(xhr);
          if (call.firstByte === null && Number(xhr.readyState) >= 3) call.firstByte = now() - call.t0;
        };
        try { xhr.addEventListener('progress', seen); xhr.addEventListener('readystatechange', seen); } catch (ignored) {}
      }});
      return {args: [method, url, watched, ...rest], done(out) {
        Promise.resolve(out).then(r => { call.end = now() - call.t0; call.status = r && r.status; header(r); },
          e => { call.end = now() - call.t0; call.error = message(e); });
      }};
    }
    return {calls, observe};
  }
  /* The bridge's log: one line per request, "<ISO time> key=value ...", never content. */
  function parseBridgeLog(text, {since = 0} = {}) {
    const out = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      const time = Date.parse(parts[0] || '');
      if (!Number.isFinite(time) || time < since) continue;
      const entry = {time};
      for (const part of parts.slice(1)) { const i = part.indexOf('='); if (i > 0) entry[part.slice(0, i)] = part.slice(i + 1); }
      if (entry.method === 'POST' && /\/chat\/completions/.test(entry.path || '')) out.push(entry);
    }
    return out;
  }
  // The section headings the summary prompt asks for, read from the prompt itself ("## Heading" lines).
  const headingsOf = prompt => [...String(prompt || '').matchAll(/^##\s+(.+?)\s*$/gm)].map(m => m[1]);
  const escapeRE = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // "(Section, p. N)" citations the panel turns into page links.
  const citationsIn = (text, PC, pages = 0) => PC && typeof PC.linkCitations === 'function' ? PC.linkCitations(String(text || ''), {pages}).filter(seg => seg.type === 'cite').length : 0;
  /* Which of the expected sections a summary has: the first four (summary, findings, methods, limitations) are
     required, and the findings must cite where they come from. */
  function summaryShape(text, headings, {PC = null, pages = 0} = {}) {
    const body = String(text || '');
    const found = headings.filter(h => new RegExp('^#{1,4}\\s*' + escapeRE(h) + '\\s*$', 'mi').test(body));
    const required = headings.slice(0, 4), missing = required.filter(h => !found.includes(h));
    let findings = '';
    if (headings[1]) { const m = new RegExp('^#{1,4}\\s*' + escapeRE(headings[1]) + '\\s*$([\\s\\S]*?)(?=^#{1,4}\\s|(?![\\s\\S]))', 'mi').exec(body); findings = m ? m[1] : ''; }
    const cites = citationsIn(findings, PC, pages);
    return {found, missing, findingCitations: cites, ok: !missing.length && cites > 0};
  }

  /* ---- the run ------------------------------------------------------------ */
  async function run(Zotero, runtime, opts = {}) {
    const now = opts.now || (() => Date.now());
    const sleep = opts.sleep || (ms => (Zotero.Promise && typeof Zotero.Promise.delay === 'function') ? Zotero.Promise.delay(ms) : new Promise(resolve => setTimeout(resolve, ms)));
    const timeoutMs = opts.timeoutMs || 30000;
    const io = opts.io !== undefined ? opts.io : (typeof IOUtils !== 'undefined' ? IOUtils : null);
    const paths = opts.paths !== undefined ? opts.paths : (typeof PathUtils !== 'undefined' ? PathUtils : null);
    const els = opts.els !== undefined ? opts.els : (typeof Services !== 'undefined' && Services.els ? Services.els : null);
    const PT = opts.paperText || root.StyleCustomPaperText || null;
    const started = now();
    const report = {version: runtime.version, when: new Date().toISOString(), attachment: null, mode: null, steps: [], timings: {}, blocked: [], guards: [], notes: []};
    const add = (name, pass, detail, data) => report.steps.push({name, pass: !!pass, detail: String(detail == null ? '' : detail), ...(data ? {data} : {})});
    // The timer behind every time limit (a test passes one that never fires, so its fast sleep is not a timeout).
    const after = opts.after || sleep;
    const limit = (promise, ms, what) => Promise.race([promise, after(ms).then(() => { throw new Error(`${what} took longer than ${Math.round(ms / 1000)} s`); })]);
    const check = async (name, fn, ms = 20000) => {
      const t0 = now();
      try { const r = await limit(Promise.resolve().then(fn), ms, name); add(name, r.pass, r.detail, r.data); return r; }
      catch (error) { add(name, false, 'threw: ' + message(error)); return null; }
      finally { report.timings[name] = Math.round(now() - t0); }
    };
    const service = runtime.readerAssist;
    const win = Zotero.getMainWindow ? Zotero.getMainWindow() : null;
    const tabs = win && win.Zotero_Tabs;
    const spies = createSpies(opts.stack ? {stack: opts.stack} : {});
    // The opt-in AI round trip (selfCheckReaderAI): every request to the local bridge is watched, none is made otherwise.
    const bridge = bridgeWatch();
    report.ai = opts.ai === true ? {asked: true} : {asked: false};
    let reader = null, handle = null, own = false, picked = null, selectedBefore = null, selectedForRender = false, closed = false;
    let before = null;
    try { await main(); }
    catch (error) { add('the reader check ran to the end', false, message(error)); }
    finally { await cleanup(); }
    return finish();

    async function main() {
      if (!service || typeof service.diagnose !== 'function') throw new Error('the reader panel has no diagnose() hook');
      if (!Zotero.Reader || typeof Zotero.Reader.open !== 'function') throw new Error('Zotero.Reader.open is missing');

      /* 1. the PDF */
      const t1 = now();
      picked = await pickAttachment(Zotero, {io, win});
      report.timings.pick = Math.round(now() - t1);
      if (!picked) { add('a test PDF with a local file is found', false, 'no PDF attachment of a regular item has a local file'); return; }
      report.attachment = {itemID: picked.id, key: picked.key, parentKey: picked.parentKey, title: picked.title, doi: picked.doi || null, indexedPages: picked.pages || null, file: picked.file, rank: picked.rank, tab: picked.tab, scanned: picked.scanned, tried: picked.tried};
      add('a test PDF with a local file is found', true, `item ${picked.id} (${picked.key}) · ${picked.doi || 'no DOI'} · ${picked.pages || '?'} pages · rank ${picked.rank} of 0-4 · ${picked.scanned} PDFs scanned`);

      /* 2. the guards, then the reader */
      report.guards = guards(spies, {Zotero, runtime, service, bridge});
      const t2 = now();
      const loadedTabs = (Zotero.Reader._readers || []).filter(r => r.tabID).length;
      const existing = (Zotero.Reader._readers || []).find(r => r.itemID === picked.id && r.type === 'pdf');
      if (existing) {
        reader = existing; own = false;
        report.mode = 'reused the reader the user already had open (read only, left open)';
      } else {
        selectedBefore = tabs ? tabs.selectedID : null;
        reader = await Zotero.Reader.open(picked.id, {pageIndex: 0}, {openInBackground: true, allowDuplicate: false});
        if (!reader) throw new Error('Zotero.Reader.open returned no reader (it selects an unloaded tab instead; that PDF should have been skipped)');
        own = true;
        report.mode = 'opened its own background tab and closed it afterwards';
        // Before any session: sync() must not give this tab an ordinary (saving) session.
        if (typeof service.reserve === 'function') service.reserve(reader, true);
        // Zotero writes the view state (last page, scroll, zoom) for every tab; this one was never the user's.
        let suppressed = 0;
        try { reader._setState = async () => { suppressed++; }; } catch (ignored) {}
        report.stateWrites = () => suppressed;
        if (tabs && selectedBefore && tabs.selectedID !== selectedBefore) { try { tabs.select(selectedBefore); } catch (ignored) {} report.notes.push('the background tab was selected by Zotero and the previous tab put back'); }
        if (loadedTabs >= 3) report.notes.push(`${loadedTabs} reader tabs were loaded before; Zotero keeps 3-5 loaded and may unload the least recent one while the check's tab is open`);
      }
      report.timings.open = Math.round(now() - t2);

      /* 3. ready */
      await check('the reader opens and pdf.js renders page 1', async () => {
        const t0 = now(), deadline = t0 + timeoutMs, marks = {};
        const left = () => Math.max(0, deadline - now());
        if (reader._initPromise) await limit(Promise.resolve(reader._initPromise), left(), 'reader._initPromise');
        marks.init = Math.round(now() - t0);
        while (!(appOf(reader) && appOf(reader).pdfDocument) && left() > 0) await sleep(100);
        const app = appOf(reader);
        if (!app || !app.pdfDocument) throw new Error(`PDFViewerApplication.pdfDocument did not appear in ${timeoutMs / 1000} s`);
        marks.document = Math.round(now() - t0);
        while (!pageRendered(reader, 1) && left() > 0) {
          // A tab the deck keeps in the background is laid out but may not paint: give it the stage while nobody is looking.
          if (own && !selectedForRender && now() - t0 > timeoutMs / 2 && tabs && reader.tabID) {
            let focused = true;
            try { focused = !!win.document.hasFocus(); } catch (ignored) {}
            if (!focused) { try { tabs.select(reader.tabID); selectedForRender = true; report.notes.push('page 1 had not painted in the background tab; the tab was selected while Zotero had no focus and the previous one put back'); } catch (ignored) {} }
          }
          await sleep(100);
        }
        marks.page1 = pageRendered(reader, 1) ? Math.round(now() - t0) : null;
        marks.pages = app.pdfDocument.numPages;
        return {pass: marks.page1 !== null, detail: `init ${marks.init} ms · document ${marks.document} ms · page 1 ${marks.page1 === null ? 'NOT rendered in ' + timeoutMs / 1000 + ' s' : marks.page1 + ' ms'} · ${marks.pages} pages`, data: marks};
      }, timeoutMs + 5000);
      if (!(appOf(reader) && appOf(reader).pdfDocument)) return;

      // Nothing is spoken in this reader (the panel's and Zotero's own speech go through these windows).
      guardSpeech(spies, [reader._iframeWindow, (() => { try { return reader._internalReader._primaryView._iframeWindow; } catch (ignored) { return null; } })()]);
      handle = service.diagnose(reader, {fresh: own});
      if (!handle) throw new Error('reader-assist could not mount a panel on the reader');
      const styled = await limit(handle.ready(), 10000, 'the panel stylesheet');
      if (!styled) report.notes.push('the panel stylesheet did not load: layout figures are of an unstyled panel');

      /* 4. measurements */
      let extraction = null;
      await check('extraction: body found with positions, no fallback', async () => {
        if (!PT) throw new Error('the extraction module (paper-text.js) is not loaded');
        const first = await handle.readPages([1, 2, 3]);
        const s3 = handle.structure(first.pages);
        const sum3 = extractionSummary(s3, PT, {ms: first.ms});
        let whole = null, sumAll = null, structured = s3, sizes = first.sizes;
        if (first.numPages <= 30) {
          whole = await handle.extractAll();
          if (whole && whole.pages.length) { structured = handle.structure(whole.pages); sizes = whole.sizes; sumAll = extractionSummary(structured, PT, {ms: [whole.ms / Math.max(1, whole.pages.length)]}); }
        }
        const sum = sumAll || sum3;
        extraction = {structured, sizes, units: bodyUnits(structured, PT), fonts: first.fonts};
        const problems = [];
        if (sum.fallback) problems.push('the panel would fall back to Zotero\'s plain text (unreadable text layer)');
        if (!sum.body) problems.push('no body sentence found');
        if (sum.body && sum.rectShare < 0.9) problems.push(`only ${Math.round(sum.rectShare * 100)}% of body sentences have positions (need 90%)`);
        const data = {numPages: first.numPages, pages1to3: sum3, whole: sumAll, wholeRead: !!sumAll};
        return {pass: !problems.length, data,
          detail: (problems.length ? problems.join('; ') + ' · ' : '') + `${sumAll ? 'all ' + first.numPages : 'first ' + first.pages.length} pages: ${sum.body} body sentences, ${Math.round(sum.rectShare * 100)}% with positions, ${sum.captions} captions, ${sum.references} references, ${sum.columns} column(s), ${sum.unreadable ? 'UNREADABLE' : 'readable'}, ${sum3.msPerPage} ms/page (pages 1-3)${sumAll ? `, ${sumAll.msPerPage} ms/page (whole)` : ''}`};
      }, 90000);

      await check('fonts: pdf.js named the page fonts', async () => {
        if (!extraction) throw new Error('no extraction to read fonts from');
        const f = extraction.fonts;
        return {pass: !f.fonts || f.named > 0, data: f, detail: `${f.named} of ${f.fonts} fonts on pages 1-${f.pages} resolved to a name in commonObjs, ${f.fonts - f.named} missing`};
      });

      const app = appOf(reader);
      const viewer = () => app && app.pdfViewer;
      before = {layout: handle.layout(), scaleValue: viewer() ? String(viewer().currentScaleValue) : null, scale: viewer() ? Number(viewer().currentScale) : null};
      const vdoc = () => handle.viewerDoc();
      const pageBox = n => { const el = vdoc() && vdoc().querySelector(`.page[data-page-number="${n}"]`); return el ? {el, rect: rectOf(el)} : null; };
      const viewerWidth = () => { const c = vdoc() && vdoc().getElementById('viewerContainer'); return c ? Number(c.clientWidth) || 0 : 0; };
      const viewRects = () => {
        const out = handle.viewContainers().map(node => ({name: node.id ? '#' + node.id : '.' + String(node.className || '').split(/\s+/)[0], rect: rectOf(node)}));
        try { const frame = reader._internalReader._primaryView._iframe; if (frame) out.push({name: 'primary view iframe', rect: rectOf(frame)}); } catch (ignored) {}
        return out.filter(v => v.rect && v.rect.width > 0);
      };

      handle.open();
      await sleep(250);
      await check('re-fit: page 1 fits the viewer narrowed by the panel', async () => {
        const mode = before.scaleValue;
        if (!/^(?:page-width|page-fit|auto)$/.test(String(mode))) return {pass: true, detail: `zoom is fixed at ${mode} (${before.scale}); a fixed zoom is not re-fitted`};
        let page = null, width = 0;
        for (let i = 0; i < 30; i++) { page = pageBox(1); width = viewerWidth(); if (page && page.rect && width && page.rect.width <= width + 1) break; await sleep(100); }
        if (!page || !page.rect) throw new Error('page 1 has no element');
        const scale = viewer() ? Number(viewer().currentScale) : null;
        return {pass: page.rect.width <= width + 1, data: {pageWidth: Math.round(page.rect.width), viewerWidth: width, scaleBefore: before.scale, scaleOpen: scale},
          detail: `${mode}: page 1 is ${Math.round(page.rect.width)}px in a ${width}px viewer · scale ${before.scale} → ${scale}`};
      });

      await check('panel: beside the PDF, readable, nothing overflows', async () => {
        const problems = [], data = {tabs: {}};
        const panel = handle.panel(), pr = rectOf(panel);
        data.panel = pr && {left: Math.round(pr.left), right: Math.round(pr.right), width: Math.round(pr.width)};
        if (!pr || !(pr.width > 0)) problems.push('the panel has no size');
        const views = viewRects();
        data.views = views.map(v => ({name: v.name, right: Math.round(v.rect.right)}));
        if (!views.length) problems.push('no PDF view container found');
        for (const v of views) if (pr && !besideNotUnder(v.rect, pr)) problems.push(`the PDF view (${v.name}) reaches ${Math.round(v.rect.right)}px, under the panel that starts at ${Math.round(pr.left)}px (${Math.round(overlapRatio(pr, v.rect) * 100)}% of the panel covers the PDF)`);
        const RA = root.CustomStyleReaderAssist;
        if (RA && typeof RA.unmarkedButtons === 'function') { const u = RA.unmarkedButtons(panel); if (u.length) problems.push('buttons without data-safe/data-opens/data-writes: ' + u.map(b => truncate(b.textContent || b.getAttribute('aria-label'), 20)).join(' | ')); }
        for (const id of ['ask', 'translate', 'listen']) {
          handle.showTab(id);
          await sleep(60);
          const m = measurePanel(handle.win, panel);
          data.tabs[id] = {checked: m.checked, texts: m.texts, smallestFont: m.smallestFont, lowestContrast: m.lowestContrast, problems: m.problems.length};
          problems.push(...m.problems.map(x => `${id}: ${x}`));
        }
        handle.showTab('ask');
        await sleep(30);
        const q = sel => panel.querySelector(sel);
        const card = n => n && n.closest ? n.closest('.sc-ra-card') : null;
        const rows = [rowFits(q('.sc-ra-head'), {name: 'panel header'}), rowFits(q('.sc-ra-tabs'), {name: 'tabs'}), rowFits(q('.sc-ra-seg'), {name: 'filter', card: card(q('.sc-ra-seg'))}),
          rowFits(q('.sc-ra-transport'), {name: 'player', card: card(q('.sc-ra-transport'))}), rowFits(q('.sc-ra-opts'), {name: 'speed and voice', card: card(q('.sc-ra-opts'))})];
        // Our buttons in the reader's own toolbar: one row, inside the toolbar.
        const group = handle.doc.querySelector('.sc-toolbar-group');
        if (group) {
          const toolbar = group.closest('.toolbar') || group.parentElement;
          const r = rowFits(group, {name: 'reader toolbar buttons', card: toolbar});
          const tr = rectOf(toolbar);
          for (const b of group.querySelectorAll('button')) { const br = rectOf(b); if (br && tr && (br.top < tr.top - 1 || br.bottom > tr.bottom + 1)) r.problems.push(`reader toolbar buttons: "${truncate(b.getAttribute('aria-label'), 20)}" leaves the toolbar vertically`); }
          rows.push(r);
        } else rows.push({name: 'reader toolbar buttons', found: false, problems: ['reader toolbar buttons: not mounted in the reader toolbar']});
        data.rows = rows.map(r => ({name: r.name, found: r.found, count: r.count || 0, problems: r.problems.length}));
        for (const r of rows) problems.push(...r.problems);
        // The play button's icon on its filled background.
        const play = q('.sc-ra-play');
        if (play) {
          const svg = play.querySelector('svg'), fg = parseColor(handle.win.getComputedStyle(svg || play).color);
          const ratio = fg ? textContrast(fg, backdropOf(handle.win, play)) : null;
          data.playIconContrast = ratio && Math.round(ratio * 100) / 100;
          if (ratio !== null && ratio < 3) problems.push(`the play button's icon has contrast ${ratio.toFixed(2)}:1 (need 3:1)`);
        } else problems.push('no play button');
        return {pass: !problems.length, data, detail: problems.length ? problems.slice(0, 8).join(' ; ') + (problems.length > 8 ? ` ; and ${problems.length - 8} more` : '')
          : `panel ${data.panel.width}px from ${data.panel.left}px, PDF view ends at ${data.views.map(v => v.right).join('/')}px · ${Object.values(data.tabs).reduce((n, t) => n + t.checked, 0)} elements on 3 tabs, smallest text ${Math.min(...Object.values(data.tabs).map(t => t.smallestFont || 99))}px, lowest contrast ${Math.min(...Object.values(data.tabs).map(t => t.lowestContrast || 99))}:1 · play icon ${data.playIconContrast}:1 · ${rows.length} rows fit`};
      });

      await check('rail: the folded panel sits beside the PDF', async () => {
        handle.collapse(true);
        await sleep(250);
        const panel = handle.panel(), pr = rectOf(panel), problems = [];
        if (!pr || !(pr.width > 0)) problems.push('the rail has no size');
        for (const v of viewRects()) if (pr && !besideNotUnder(v.rect, pr)) problems.push(`the PDF view (${v.name}) reaches ${Math.round(v.rect.right)}px, under the rail at ${Math.round(pr.left)}px`);
        const rail = panel.querySelector('.sc-ra-rail');
        const buttons = rail ? [...rail.querySelectorAll('button')].filter(b => !b.hidden) : [];
        if (!buttons.length) problems.push('the rail shows no buttons');
        for (const x of overflowing(buttons.map(b => ({label: `"${truncate(b.getAttribute('aria-label'), 20)}"`, rect: rectOf(b)})), pr)) problems.push(`rail: ${x} out of the rail`);
        const m = measurePanel(handle.win, panel);
        problems.push(...m.problems.map(x => 'rail: ' + x));
        handle.collapse(false);
        return {pass: !problems.length, data: {width: pr && Math.round(pr.width), buttons: buttons.length, checked: m.checked},
          detail: problems.length ? problems.slice(0, 6).join(' ; ') : `rail ${Math.round(pr.width)}px with ${buttons.length} buttons, ${m.checked} elements measured`};
      });

      await check('close: the view inset and the zoom come back exactly', async () => {
        handle.close();
        let scale = null, value = null;
        for (let i = 0; i < 30; i++) {
          await sleep(100);
          value = viewer() ? String(viewer().currentScaleValue) : null; scale = viewer() ? Number(viewer().currentScale) : null;
          if (value === before.scaleValue && (before.scale === null || Math.abs(scale - before.scale) < 1e-3)) break;
        }
        const after = handle.layout(), problems = [];
        if (JSON.stringify(after) !== JSON.stringify(before.layout)) problems.push(`inset-inline-end was ${JSON.stringify(before.layout)}, now ${JSON.stringify(after)}`);
        if (value !== before.scaleValue) problems.push(`zoom mode was ${before.scaleValue}, now ${value}`);
        if (before.scale !== null && !(Math.abs(scale - before.scale) < 1e-3)) problems.push(`scale was ${before.scale}, now ${scale}`);
        return {pass: !problems.length, data: {before, after: {layout: after, scaleValue: value, scale}},
          detail: problems.length ? problems.join(' ; ') : `inset ${before.layout.map(l => `${l.id}=${JSON.stringify(l.value)}${l.priority ? ' !' + l.priority : ''}`).join(', ') || 'none'} restored, zoom ${value} ${scale}`};
      });

      await check('follow-along: the mark lies on the sentence in the text layer', async () => {
        if (!extraction) throw new Error('no extraction');
        const unit = extraction.units.find(u => Array.isArray(u.rects) && u.rects.length && handle.pageNumberOf(u));
        if (!unit) throw new Error('no body sentence with positions');
        const page = handle.pageNumberOf(unit);
        let box = pageBox(page), spans = textSpans(box && box.el);
        if (!spans.length && own && viewer()) {
          // Only on the check's own tab: bring the page into view so pdf.js lays out its text layer.
          try { viewer().currentPageNumber = page; } catch (ignored) {}
          for (let i = 0; i < 50 && !spans.length; i++) { await sleep(100); box = pageBox(page); spans = textSpans(box && box.el); }
        }
        if (!box || !box.el) throw new Error(`page ${page} has no element`);
        if (!spans.length) throw new Error(`page ${page}'s text layer has no spans (not rendered)`);
        const pad = paddingBox(box.el);
        const o = handle.overlay(unit, extraction.sizes);
        const px = percentToPx(o.boxes, pad);
        const inside = px.every(b => within(b, pad, 1));
        const agree = overlayAgreement(px, spans, unit.text);
        const pass = px.length > 0 && inside && agree.coverage >= 0.5 && agree.recall >= 0.5;
        return {pass, data: {page, sentence: truncate(unit.text, 120), boxes: px.map(b => [b.left, b.top, b.width, b.height].map(Math.round)), page: pad && [pad.left, pad.top, pad.width, pad.height].map(Math.round), ...agree},
          detail: `p. ${page} "${truncate(unit.text, 50)}": ${px.length} box(es) ${inside ? 'inside' : 'OUTSIDE'} the page, ${Math.round(agree.coverage * 100)}% on text-layer spans, ${Math.round(agree.recall * 100)}% of its words in the ${agree.spans} spans it touches (need 50%/50%)`};
      });

      await check('speech: a voice is available without speaking', async () => {
        const sp = handle.speech();
        let say = null;
        try { say = io ? !!(await io.exists('/usr/bin/say')) : null; } catch (ignored) {}
        return {pass: sp.present || say === true, data: {...sp, say},
          detail: `speechSynthesis ${sp.present ? 'present' : 'absent'} in the reader window · ${sp.voices} voice(s) listed now · say fallback ${say === null ? 'unknown' : say ? 'present' : 'absent'} · nothing spoken`};
      });

      await check('selection popup: the listen-from-here button is offered', async () => {
        const hooked = (Zotero.Reader._registeredListeners || []).filter(l => l && l.type === 'renderTextSelectionPopup').length;
        const made = [];
        handle.selectionPopup({annotation: {text: 'self-check', position: {pageIndex: 0, rects: [[72, 600, 300, 612]]}}}, (...nodes) => made.push(...nodes));
        const button = made.find(n => n && n.classList && n.classList.contains('sc-ra-selection-listen'));
        const label = button ? clean(button.textContent) : '';
        for (const n of made) { try { n.remove(); } catch (ignored) {} }
        const problems = [];
        if (!hooked) problems.push('no renderTextSelectionPopup listener is registered');
        if (!button) problems.push('the popup hook made no listen button');
        else if (button.getAttribute('data-opens') !== 'audio') problems.push('the listen button does not say it plays audio');
        return {pass: !problems.length, detail: problems.length ? problems.join('; ') : `${hooked} popup listener(s); the hook made "${label}" (data-opens=audio), not pressed`};
      });

      await check('Zotero Read Aloud: its state is readable', async () => {
        const st = handle.readAloudState();
        if (!st) return {pass: false, detail: 'reader._internalReader._state.readAloudState is missing'};
        let keys = [];
        try { keys = Object.keys(st); } catch (ignored) {}
        const shaped = 'active' in st && 'paused' in st;
        return {pass: shaped, data: {keys}, detail: `${keys.length} keys (${keys.slice(0, 8).join(', ')}) · active ${!!st.active} · paused ${!!st.paused}${shaped ? '' : ' · active/paused missing'}`};
      });

      if (opts.ai === true) await aiSteps(extraction);
    }

    /* The AI account, end to end: status, one summary, one question, the bridge's own log, and Stop. Each AI entry
       point is let through for exactly the calls below (spies.allow); translation, audio and every write stay blocked. */
    async function aiSteps(extraction) {
      const PC = opts.paperChat || root.CustomStylePaperChat || (typeof require === 'function' ? require('./paper-chat.js') : null);
      const ai = handle && handle.ai;
      const wall = () => Date.now();
      const since = wall() - 2000;
      // PathUtils.homeDir is absent in Zotero 9's Gecko; the directory service's Home is the fallback.
      let home = null;
      try { home = paths && paths.homeDir; } catch (e) {}
      if (!home) { try { home = Services.dirsvc.get('Home', Ci.nsIFile).path; } catch (e) {} }
      const logPath = opts.bridgeLog || (paths && home ? paths.join(home, 'Library', 'Logs', 'StyleCustomBridge.log') : null);
      const pages = (ai && ai.pages()) || (extraction && extraction.structured && extraction.structured.stats && extraction.structured.stats.pages) || 0;
      const readLog = async () => {
        if (!io || !logPath) throw new Error('no way to read the bridge log');
        const text = await io.readUTF8(logPath);
        return parseBridgeLog(String(text).split(/\r?\n/).slice(-300).join('\n'), {since});
      };
      const providerOf = call => (call && call.provider) || (ai && ai.status() && ai.status().provider) || null;
      const only = async (label, fn) => { spies.allow(label, 1); try { return await fn(); } finally { report.ai.unused = (report.ai.unused || 0) + spies.revoke(label); } };
      const head = text => String(text || '').slice(0, 300);
      if (!ai) { add('AI status: the account connection is available', false, 'the diagnose handle has no AI probe'); return; }

      let status = null;
      await check('AI status: the account connection is available', async () => {
        // Look again before judging: the start-up look may predate the bridge, or not have finished.
        try { if (typeof ai.refresh === 'function') await ai.refresh(); } catch (e) {}
        status = ai.status();
        report.ai.status = status;
        if (!status) return {pass: false, detail: 'assist.status() is missing'};
        const pass = !!status.available && status.source === 'bridge' && !!status.label;
        return {pass, data: status, detail: `${status.available ? 'available' : 'NOT available'} · source ${status.source}${status.source === 'endpoint' ? ' (an address in settings wins over the bridge)' : ''} · provider ${status.provider || '-'} · label ${status.label || '-'}`};
      });
      if (!status || !status.available) {
        for (const name of ['AI summary: one request through the panel\'s summary path', 'AI chat: one methods question with page citations', 'bridge log: both requests arrived with status 200', 'AI stop: Stop ends the request within 2 s and nothing more arrives', 'AI accounting: three calls, nothing else'])
          add(name, false, 'skipped: AI is not available');
        return;
      }

      const language = ai.language();
      await check('AI summary: one request through the panel\'s summary path', async () => {
        const before = bridge.calls.length;
        const r = await only('assist.paperSummary', () => ai.summary());
        const call = bridge.calls[before] || null;
        const shape = summaryShape(r.text, headingsOf(PC ? PC.summaryPrompt(language) : ''), {PC, pages});
        const problems = [];
        if (r.state !== 'done') problems.push(`the panel says ${r.state}${r.error ? ': ' + r.error : ''}`);
        if (!call) problems.push('no request reached the bridge');
        if (r.text && shape.missing.length) problems.push('missing sections: ' + shape.missing.join(', '));
        if (r.text && !shape.findingCitations) problems.push('the findings cite no (section, p. n)');
        const data = {provider: providerOf(call), label: ai.status() && ai.status().label, firstByteMs: call && call.firstByte, httpMs: call && call.end, panelMs: r.ms, status: call && call.status,
          stream: call ? call.stream : null, chars: r.text.length, truncatedInput: r.truncated, sections: shape.found, findingCitations: shape.findingCitations, head: head(r.text)};
        report.ai.summary = data;
        return {pass: !problems.length, data, detail: (problems.length ? problems.join('; ') + ' · ' : '')
          + `${data.provider || '?'} (${data.label || '-'}) · HTTP ${data.status} · first byte ${data.firstByteMs} ms (one JSON answer, not streamed) · total ${data.panelMs} ms · ${data.chars} chars · sections ${shape.found.length}/${headingsOf(PC ? PC.summaryPrompt(language) : '').length} · ${shape.findingCitations} finding citation(s)`};
      }, 125000);

      await check('AI chat: one methods question with page citations', async () => {
        const before = bridge.calls.length;
        const r = await only('assist.chat', () => ai.ask('methods'));
        const call = bridge.calls[before] || null;
        const cites = citationsIn(r.content, PC, pages);
        const problems = [];
        if (r.error) problems.push('error: ' + r.error);
        if (!r.content) problems.push('no answer');
        if (r.content && !cites) problems.push('no (…, p. n) citation that becomes a page link');
        if (!call) problems.push('no request reached the bridge');
        const data = {provider: providerOf(call), firstTextMs: r.firstMs, firstByteMs: call && call.firstByte, totalMs: r.ms, httpMs: call && call.end, status: call && call.status, stream: call ? call.stream : null, chars: r.content.length, citations: cites, head: head(r.content)};
        report.ai.chat = data;
        return {pass: !problems.length, data, detail: (problems.length ? problems.join('; ') + ' · ' : '')
          + `${data.provider || '?'} · HTTP ${data.status} · ${data.stream ? 'streamed' : 'NOT streamed'} · first text ${data.firstTextMs} ms · total ${data.totalMs} ms · ${data.chars} chars · ${cites} page citation(s)`};
      }, 125000);

      let logged = [];
      await check('bridge log: both requests arrived with status 200', async () => {
        for (let i = 0; i < 30; i++) { logged = await readLog(); if (logged.filter(e => e.status === '200').length >= 2) break; await sleep(100); }
        const ok = logged.filter(e => e.status === '200');
        const origins = [...new Set(logged.map(e => e.origin || '?'))];
        report.ai.origins = origins;
        const data = {entries: logged.map(e => ({time: new Date(e.time).toISOString(), origin: e.origin, status: e.status, stream: e.stream, provider: e.provider, inChars: e.inChars, outChars: e.outChars, firstMs: e.firstMs, ms: e.ms})), origins};
        return {pass: ok.length >= 2, data, detail: `${logged.length} request(s) logged since the AI step began, ${ok.length} with status 200 · origin Zotero sends: ${origins.join(', ') || '-'}`
          + (logged.length > 2 ? ` · ${logged.length - 2} more than ours (another client?)` : '') + ` · ${ok.map(e => `${e.provider || '?'} in ${e.inChars || '?'} out ${e.outChars || '?'} chars ${e.ms || '?'} ms`).join(' / ')}`};
      }, 20000);

      await check('AI stop: Stop ends the request within 2 s and nothing more arrives', async () => {
        const before = bridge.calls.length, seen = logged.length;
        const asked = wall();
        const r = await only('assist.chat', () => ai.ask('methods', {stopAfterFirst: true, settleMs: 2000}));
        const call = bridge.calls[before] || null;
        const problems = [];
        if (!r.stopped) problems.push(r.content ? 'the answer finished before Stop could be pressed' : 'no text arrived to stop after' + (r.error ? ': ' + r.error : ''));
        // The HTTP request itself, not only the panel: from the press to the moment Zotero.HTTP.request settled.
        const httpAfterStop = call && call.end !== null && r.stopMs !== null ? Math.round(call.t0 + call.end - (asked + r.stopMs)) : null;
        if (r.stopped && !(r.endAfterStopMs <= 2000)) problems.push(`the panel took ${r.endAfterStopMs} ms to end`);
        if (r.stopped && !(httpAfterStop !== null && httpAfterStop <= 2000)) problems.push(`the request ${httpAfterStop === null ? 'had not ended' : 'ended ' + httpAfterStop + ' ms after Stop'}`);
        if (r.stopped && r.lengthAfter !== r.lengthAtStop) problems.push(`${r.lengthAfter - r.lengthAtStop} more chars arrived after Stop`);
        if (r.busy) problems.push('the panel still shows the question as running');
        let entry = null;
        for (let i = 0; i < 100 && !entry; i++) { const all = await readLog(); entry = all.slice(seen).find(e => e.status === '499') || null; if (!entry) await sleep(100); }
        if (!entry) problems.push('the bridge did not log a 499 (client closed) within 10 s');
        const data = {provider: providerOf(call), firstTextMs: r.firstMs, stopMs: r.stopMs, panelEndAfterStopMs: r.endAfterStopMs, httpEndAfterStopMs: httpAfterStop, lengthAtStop: r.lengthAtStop, lengthAfter2s: r.lengthAfter,
          log: entry && {status: entry.status, origin: entry.origin, provider: entry.provider, ms: entry.ms}, error: r.error};
        report.ai.stop = data;
        return {pass: !problems.length, data, detail: (problems.length ? problems.join('; ') + ' · ' : '')
          + `first text ${r.firstMs} ms · Stop at ${r.stopMs} ms · panel ended ${r.endAfterStopMs} ms later, request ${httpAfterStop} ms later · ${r.lengthAtStop} chars at Stop, ${r.lengthAfter} after 2 s · bridge logged ${entry ? entry.status : 'nothing'}`};
      }, 60000);

      try { ai.restore(); } catch (ignored) {}
      const aiCalls = spies.passed.filter(p => /^assist\./.test(p.call));
      const blocked = spies.violations.slice();
      report.ai.calls = aiCalls.map(p => p.call);
      report.ai.bridgeRequests = bridge.calls.map(c => ({stream: c.stream, status: c.status, provider: c.provider, firstByteMs: c.firstByte, ms: c.end, error: c.error}));
      add('AI accounting: three calls, nothing else', aiCalls.length === 3 && bridge.calls.length === 3 && !blocked.length,
        `${aiCalls.length} AI call(s) let through (${aiCalls.map(p => p.call.replace('assist.', '')).join(', ') || 'none'}), ${bridge.calls.length} request(s) to the bridge, ${blocked.length} blocked call(s)${blocked.length ? ': ' + [...new Set(blocked.map(v => v.call))].join(', ') : ''} · expected 3, 3, 0`);
    }

    /* 5. cleanup: our tab closes, nothing of ours stays behind */
    async function cleanup() {
      const t0 = now();
      if (handle) { try { if (handle.ai) handle.ai.restore(); } catch (ignored) {} }
      for (const label of ['assist.paperSummary', 'assist.chat']) spies.revoke(label);
      if (handle) {
        try {
          const problems = [], data = {};
          const targets = handle.targets();
          const fns = (() => { const h = handle.handlers(); return [...h.doc, ...h.view, ...h.win]; })();
          const listening = listenersOf(els, [targets.doc, targets.view, targets.win], fns);
          handle.release();
          const left = listenersOf(els, [targets.doc, targets.view, targets.win], fns);
          const counts = handle.count();
          const speech = handle.speech();
          data.listeners = {before: listening, after: left};
          data.nodes = {baseline: handle.baseline, after: counts};
          data.speech = speech;
          if (own) {
            if (counts.doc !== handle.baseline.doc || counts.view !== handle.baseline.view) problems.push(`panel nodes left in the reader: ${JSON.stringify(counts)} (before: ${JSON.stringify(handle.baseline)})`);
            if (left && listening && listening.mine > 0 && left.mine > 0) problems.push(`${left.mine} of our listeners still registered`);
            if (handle.alive()) problems.push('the session is still registered');
            const layout = handle.layout();
            if (before && JSON.stringify(layout) !== JSON.stringify(before.layout)) problems.push(`inset after release ${JSON.stringify(layout)} differs from before ${JSON.stringify(before.layout)}`);
          }
          if (speech.speaking || speech.pending) problems.push('the speech queue is not empty');
          const p = handle.player();
          if (p && p.status === 'playing') problems.push('a player is playing');
          const lis = !listening ? 'listener service unavailable' : listening.mine ? `${listening.mine} listeners of ours before, ${left ? left.mine : '?'} after` : `listener identity not visible (${listening.total} → ${left ? left.total : '?'} listeners in all)`;
          add('cleanup: nothing of ours is left in the reader', !problems.length, problems.length ? problems.join(' ; ') : own ? `nodes ${JSON.stringify(counts)} as before, ${lis}, speech queue empty` : `user's reader left as it was (panel ${handle.session.open ? 'open' : 'closed'}), speech queue empty`, data);
        } catch (error) { add('cleanup: nothing of ours is left in the reader', false, 'threw: ' + message(error)); }
      }
      if (own && reader) {
        try {
          const tabID = reader.tabID;
          if (typeof reader.close === 'function') reader.close(); else if (tabs && tabID) tabs.close(tabID);
          closed = true;
          // Zotero_Tabs.close pushes a "reopen closed tab" entry: it was never the user's tab.
          try { const h = tabs && tabs._history; const last = Array.isArray(h) && h[h.length - 1]; if (Array.isArray(last) && last.length === 1 && last[0] && last[0].data && last[0].data.itemID === picked.id) h.pop(); } catch (ignored) {}
          await sleep(1500);
          const stillOpen = (Zotero.Reader._readers || []).includes(reader);
          const session = service.sessions().some(s => s.reader === reader);
          if (typeof service.reserve === 'function') service.reserve(reader, false);
          if (tabs && selectedBefore && tabs.selectedID !== selectedBefore) { try { tabs.select(selectedBefore); } catch (ignored) {} }
          const problems = [];
          if (stillOpen) problems.push('the reader is still in Zotero.Reader._readers');
          if (session) problems.push('reader-assist still holds a session for it');
          if (tabs && selectedBefore && tabs.selectedID !== selectedBefore) problems.push(`the selected tab is ${tabs.selectedID}, was ${selectedBefore}`);
          add('cleanup: the check\'s tab is closed and forgotten', !problems.length, problems.length ? problems.join(' ; ') : `tab ${tabID} closed, no session left, selected tab ${selectedBefore || 'unchanged'}${selectedForRender ? ' (restored after painting)' : ''}${report.stateWrites ? `, ${report.stateWrites()} view-state write(s) of Zotero suppressed` : ''}`);
        } catch (error) { add('cleanup: the check\'s tab is closed and forgotten', false, 'threw: ' + message(error)); }
      } else if (reader && !own) report.notes.push('the user\'s reader was not closed');
      spies.restore();
      try { if (service && typeof service.setGuard === 'function') service.setGuard(null); } catch (ignored) {}
      report.timings.cleanup = Math.round(now() - t0);
    }

    async function finish() {
      if (!report.finished) {
        report.finished = true;
        if (typeof report.stateWrites === 'function') report.stateWrites = report.stateWrites();
        report.blocked = spies.violations.slice();
        if (report.guards.length) add('nothing was spoken, launched, sent or written', !report.blocked.length,
          report.blocked.length ? 'blocked: ' + [...new Set(report.blocked.map(v => v.call + (v.detail ? ' (' + v.detail + ')' : '')))].slice(0, 8).join(', ') : `${report.guards.length} guards held (${report.guards.join(', ')})`);
        report.timings.total = Math.round(now() - started);
        report.passed = report.steps.filter(s => s.pass).length;
        report.failed = report.steps.length - report.passed;
        report.lines = report.steps.map(s => `${s.pass ? 'PASS' : 'FAIL'} ${s.name}${s.detail ? ': ' + s.detail : ''}`);
        report.closed = closed;
        if (io && paths && Zotero.DataDirectory) {
          report.path = paths.join(Zotero.DataDirectory.dir, REPORT_FILE);
          try { await io.writeUTF8(report.path, JSON.stringify(report, null, 1)); } catch (error) { report.writeError = message(error); }
        }
      }
      return report;
    }
  }

  const api = {run, bridgeWatch, parseBridgeLog, headingsOf, summaryShape, citationsIn, REPORT_FILE, READER_MODULES, parseColor, contrastRatio, textContrast, backdrop, toRect, intersect, area, overlapRatio, besideNotUnder, within, oneRow, overflowing,
    percentToPx, overlayAgreement, rankAttachment, orderCandidates, chooseAttachment, pickAttachment, doiOf, bodyUnits, extractionSummary, measurePanel, rowFits,
    createSpies, guards, guardSpeech, isLocalURL, listenersOf, paddingBox, textSpans, truncate};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleSelfCheckReader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Cells = require('../src/item-cells.js');
const Runtime = require('../src/runtime.js');

async function page({selected = false} = {}) {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML(`<html><body>
    <div id="zotero-items-tree" class="virtualized-table">
      <div class="virtualized-table-header"><div class="cell title"><span>T</span></div><div class="cell ext-if"><span>IF</span></div></div>
      <div class="virtualized-table-body">
        <div class="row${selected ? ' selected' : ''}" id="item-tree-main-default-row-0"><span class="cell title"><span class="cell-text">A paper</span></span><span class="cell ext-if"><span class="in">12.5</span></span></div>
        <div class="row" id="item-tree-main-default-row-1"><span class="cell title">B</span><span class="cell ext-if">3</span></div>
      </div></div>
    <menupopup id="zotero-itemmenu"><menuitem id="zotero-own" label="Zotero own"/></menupopup></body></html>`);
  document.createXULElement = tag => document.createElement(tag);
  window.requestAnimationFrame = fn => { fn(); return 1; };
  window.CSS = {escape: s => String(s).replace(/([^\w-])/g, '\\$1')};
  return {document, window};
}
function fakeRT(window, extra = {}) {
  const calls = [];
  const items = new Map([[7, {id: 7, getField: f => ({publicationTitle: 'Nature Methods', title: 'A paper'})[f] || '', getTags: () => [], getBestAttachment: async () => ({id: 99})}], [8, {id: 8, getField: () => ''}]]);
  const rt = {
    calls, Z: {Items: {get: id => items.get(id)}, logError: e => calls.push(['error', e.message]), Utilities: {Internal: {copyTextToClipboard: v => calls.push(['copy', v])}}},
    t: s => s, isRegular: i => !!i, say: (w, m) => calls.push(['say', m]),
    rowSelection: (d, item) => [item], journalRecord: () => ({name: 'Nature Methods'}),
    openWorkbench: (w, tab, focus) => calls.push(['open', tab, focus]),
    filterListBy: (w, n) => calls.push(['filter', n]),
    refreshJournal: async i => calls.push(['refreshJournal', i.id]), refreshWindows: async () => {},
    refreshCitations: async (list, o) => { calls.push(['citations', list[0].id, o.force]); return {ok: 1, 'not-found': 0, unsupported: 0, error: 0}; },
    edit: async (list, patch) => { calls.push(['edit', list.map(i => i.id), patch]); },
    state: () => ({status: 'reading', rating: 3}), displayTags: () => [{tag: 'alpha'}, {tag: 'beta'}],
    libraryService: {removeTags: async (ids, tags) => calls.push(['removeTags', ids, tags]), addTags: async (ids, tags) => calls.push(['addTags', ids, tags]), openItem: async id => calls.push(['openItem', id])},
    findPDF: async id => { calls.push(['findPDF', id]); return {status: 'found'}; },
    editField: (w, i, f) => calls.push(['editField', i.id, f]), value: () => '', columnKeyFor: (w, cell) => cell.classList.contains('ext-if') ? 'if' : 'title',
    ...extra
  };
  window.ZoteroPane = {itemsView: {getRow: i => ({ref: items.get(i === 0 ? 7 : 8)}), tree: {_getVisibleColumns: () => [{dataKey: 'title'}, {dataKey: 'ext-if'}]}}};
  return rt;
}

test('hovering a body cell names its column on the tree, marks the cell, and the generated rules cover the column', async () => {
  const {document, window} = await page();
  const rt = fakeRT(window), state = {listeners: []};
  const off = Cells.attach(window, state, rt, {hover: true});
  const tree = document.getElementById('zotero-items-tree');
  const cell = document.querySelector('.row .cell.ext-if .in');
  cell.dispatchEvent(new window.Event('mouseover', {bubbles: true}));
  assert.equal(tree.getAttribute('data-sc-hover-col'), 'ext-if');
  assert.ok(document.querySelector('.row .cell.ext-if').hasAttribute('data-sc-hover-cell'));
  const css = document.getElementById('style-custom-cells').textContent;
  assert.match(css, /\[data-sc-hover-col="ext-if"\] \.virtualized-table-body \.row:not\(\.selected\) \.cell\.ext-if\{background-color:#F1F6FF;box-shadow:0 calc\(-1 \* var\(--sc-hover-pad, 0px\)\) 0 #F1F6FF/);
  assert.match(css, /\[data-sc-hover-col="ext-if"\] \.virtualized-table-header \.cell\.ext-if\{background-color:#E8F0FF/);
  assert.match(css, /\[data-sc-hover-col="title"\]/, 'a rule for every visible column');
  assert.match(css, /\.row:not\(\.selected\):hover \.cell\.ext-if::before[^{]*\{[^}]*border-radius:8px[^}]*background-color:#E3EDFF;box-shadow:inset 0 0 0 1\.5px #5B9BFF/);
  assert.match(css, /\.row\.selected:hover \.cell\.ext-if::before[^{]*\{[^}]*box-shadow:inset 0 0 0 1\.5px rgba\(255,255,255,\.9\)/, 'a selected row gets a light outline');
  assert.match(css, /prefers-color-scheme: dark/);
  // Moving to another column moves the attribute and the mark; leaving clears both.
  document.querySelector('.row .cell.title').dispatchEvent(new window.Event('mouseover', {bubbles: true}));
  assert.equal(tree.getAttribute('data-sc-hover-col'), 'title');
  assert.equal(document.querySelectorAll('[data-sc-hover-cell]').length, 1);
  document.documentElement.dispatchEvent(new window.Event('mouseleave'));
  assert.equal(tree.hasAttribute('data-sc-hover-col'), false);
  assert.equal(document.querySelectorAll('[data-sc-hover-cell]').length, 0);
  assert.ok(state.listeners.length >= 3, 'listeners registered for cleanup');
  off();
  assert.equal(state.listeners.length, 0);
  assert.equal(document.getElementById('style-custom-cells'), null);
});

test('the column tint never repaints a selected row, and the setting turns the hover off', async () => {
  const {document, window} = await page({selected: true});
  const rt = fakeRT(window);
  Cells.attach(window, {listeners: []}, rt, {hover: true});
  document.querySelector('.row .cell.title').dispatchEvent(new window.Event('mouseover', {bubbles: true}));
  const css = document.getElementById('style-custom-cells').textContent;
  assert.ok(!/\.row \.cell\.title\{background/.test(css), 'no tint rule reaches a row without :not(.selected)');
  for (const line of css.split('\n').filter(l => /background-color:#F1F6FF/.test(l) && /virtualized-table-body/.test(l))) assert.match(line, /:not\(\.selected\)/);
  // Off: no hover rules and no attribute.
  const off = await page();
  const rt2 = fakeRT(off.window);
  Cells.attach(off.window, {listeners: []}, rt2, {hover: false});
  off.document.querySelector('.row .cell.title').dispatchEvent(new off.window.Event('mouseover', {bubbles: true}));
  assert.equal(off.document.getElementById('zotero-items-tree').hasAttribute('data-sc-hover-col'), false);
  assert.ok(!/data-sc-hover-col/.test(off.document.getElementById('style-custom-cells').textContent));
});

async function rightClick(document, window, selector, popup) {
  document.querySelector(selector).dispatchEvent(new window.Event('contextmenu', {bubbles: true, cancelable: true}));
  popup.dispatchEvent(new window.Event('popupshowing'));
}

test('a right click adds the column\'s entries above Zotero\'s own and removes them when the menu hides', async () => {
  const {document, window} = await page();
  const rt = fakeRT(window);
  Cells.attach(window, {listeners: []}, rt);
  const popup = document.getElementById('zotero-itemmenu');
  await rightClick(document, window, '.row .cell.ext-if .in', popup);
  const labels = () => [...popup.children].map(n => n.getAttribute('label') || n.localName);
  assert.deepEqual(labels(), ['저널 지표 보기', '이 저널 지표 새로고침', 'menuseparator', 'Zotero own']);
  const own = popup.querySelector('#zotero-own');
  assert.equal(popup.lastChild, own, 'Zotero\'s own entries stay below');
  popup.firstChild.dispatchEvent(new window.Event('command'));
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(rt.calls.find(c => c[0] === 'open'), ['open', 'journals', 'journal:Nature Methods']);
  popup.children[1].dispatchEvent(new window.Event('command'));
  await new Promise(r => setTimeout(r, 0));
  assert.ok(rt.calls.some(c => c[0] === 'refreshJournal' && c[1] === 7));
  popup.dispatchEvent(new window.Event('popuphidden'));
  assert.deepEqual(labels(), ['Zotero own']);
  // A menu opened without a right click on a cell (keyboard, the more button) gets nothing.
  popup.dispatchEvent(new window.Event('popupshowing'));
  assert.deepEqual(labels(), ['Zotero own']);
});

test('each column kind offers its own entries and they call the matching runtime function', async () => {
  const {window} = await page();
  const rt = fakeRT(window);
  const item = rt.Z.Items.get(7);
  const run = async (key, label, extra = {}) => {
    const entry = Cells.plan({rt, win: window, item, items: [item], key, text: 'cell text', ...extra}).find(e => e.label === label || e.children?.some(c => c.label === label));
    assert.ok(entry, `${key} offers ${label}`);
    await (entry.run ? entry.run() : entry.children.find(c => c.label === label).run());
  };
  const names = key => Cells.plan({rt, win: window, item, items: [item], key, text: ''}).map(e => e.label);
  assert.deepEqual(names('journalMark'), ['저널 지표 보기', '이 저널로 목록 거르기', '저널명 복사']);
  assert.deepEqual(names('citations'), ['인용 수 새로고침', '이 논문을 인용한 논문 보기']);
  assert.deepEqual(names('status'), ['안 읽음', '읽는 중', '완료']);
  assert.equal(names('rating').length, 6);
  assert.deepEqual(names('time'), ['읽기 진행 열기']);
  assert.deepEqual(names('tags'), ['태그 추가…', '태그 지우기']);
  assert.deepEqual(names('files'), ['PDF 열기', 'PDF 찾기', '첨부 미리보기에서 보기']);
  assert.deepEqual(names('title'), ['이 항목 편집', '값 복사']);
  assert.deepEqual(names('dateAdded'), ['값 복사'], 'a column that cannot be edited only copies');
  await run('journalMark', '이 저널로 목록 거르기');
  await run('journalMark', '저널명 복사');
  await run('citations', '인용 수 새로고침');
  await run('status', '완료');
  await run('rating', '★★★★★');
  await run('rating', '별점 지우기');
  await run('tags', 'beta');
  await run('files', 'PDF 열기');
  await run('files', 'PDF 찾기');
  await run('title', '이 항목 편집');
  await run('title', '값 복사');
  const has = c => assert.ok(rt.calls.some(x => JSON.stringify(x) === JSON.stringify(c)), JSON.stringify(c));
  has(['filter', 'Nature Methods']); has(['copy', 'Nature Methods']); has(['citations', 7, true]);
  has(['edit', [7], {status: 'done'}]); has(['edit', [7], {rating: 5}]); has(['edit', [7], {rating: 0}]);
  has(['removeTags', [7], ['beta']]); has(['openItem', 99]); has(['findPDF', 7]); has(['editField', 7, 'title']); has(['copy', 'cell text']);
  assert.equal(Cells.plan({rt: {...rt, journalRecord: () => ({name: ''})}, win: window, item, items: [item], key: 'if', text: ''})[0].disabled, true, 'no journal, nothing to act on');
});

test('the more column registers narrow and visible, and its button opens the item menu for its own row', async () => {
  const {document, window} = await page();
  const columns = new Map(), prefs = new Map([['extensions.style-custom.language', 'ko-KR']]);
  const Z = {locale: 'ko-KR', debug() {}, logError: e => { throw e; },
    Libraries: {get: () => ({editable: true, libraryType: 'user'})},
    ItemTreeManager: {registerColumn(o) { const k = 'ns-' + o.dataKey; columns.set(k, o); return k; }, unregisterColumn: k => columns.delete(k), refreshColumns() {}},
    PreferencePanes: {register: async () => 'pane', unregister() {}},
    Prefs: {get: n => prefs.get(n), set: (n, v) => prefs.set(n, v), registerObserver: () => 1, unregisterObserver() {}}, DB: {}};
  const plugin = new Runtime({Zotero: Z, model: require('../src/data.js'), marquee: {attach: () => () => {}}, reading: {attach: () => () => {}}, storage: {read: async () => ({schema: 1, items: {}}), write: async () => {}}});
  await plugin.start({id: 'test@focus', version: '0.1', rootURI: 'file:///x/'});
  const more = columns.get('ns-more');
  assert.ok(more, 'registered');
  assert.equal(more.width, '28'); assert.equal(more.fixedWidth, true); assert.equal(more.hidden, false); assert.equal(more.label, '⋯');
  // Click: row 1 is not selected, so it is selected first, then the menu is built and opened at the button.
  const events = [];
  const item = {id: 8, isRegularItem: () => true, getField: () => ''};
  window.ZoteroPane = {itemsView: {getRow: () => ({ref: item}), selection: {isSelected: () => false, select: i => events.push(['select', i])}}, buildItemContextMenu: async () => events.push(['build'])};
  const popup = document.getElementById('zotero-itemmenu');
  popup.openPopup = (anchor, pos) => events.push(['open', anchor.className, pos]);
  document.defaultView ?? Object.defineProperty(document, 'defaultView', {value: window});
  const cell = more.renderCell(1, '', {className: 'ns-more'}, false, document);
  const button = cell.querySelector('button.sc-more');
  assert.ok(button); assert.equal(button.textContent, '⋯'); assert.equal(button.getAttribute('data-opens'), 'menu');
  assert.match(button.title, /우클릭|right-click/, 'the tooltip names the right click as well');
  assert.equal(button.getAttribute('aria-label'), '더 보기');
  button.dispatchEvent(new window.Event('click', {bubbles: true, cancelable: true}));
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(events, [['select', 1], ['build'], ['open', 'sc-more', 'after_end']]);
  await plugin.stop();
});

test('the self-check never right-clicks a cell or presses the more button', () => {
  const source = fs.readFileSync(new URL('../src/selfcheck.js', import.meta.url), 'utf8');
  assert.ok(!/contextmenu/i.test(source), 'no contextmenu event is dispatched');
  assert.ok(!/sc-more|openRowMenu|onItemsContextMenuOpen|buildItemContextMenu/.test(source), 'nothing presses the more button or opens the item menu');
  const cells = fs.readFileSync(new URL('../src/runtime.js', import.meta.url), 'utf8');
  assert.match(cells, /setAttribute\("data-opens", "menu"\)/, 'the button says it opens a menu');
});

test('hover clears on what Zotero fires: mouseout to outside the tree, mouseleave of the tree, body scroll, window blur, and stale marks go too', async () => {
  const {document, window} = await page();
  Cells.attach(window, {listeners: []}, fakeRT(window), {hover: true});
  const tree = document.getElementById('zotero-items-tree');
  const cell = () => document.querySelector('.row .cell.ext-if .in');
  const hover = () => { cell().dispatchEvent(new window.Event('mouseover', {bubbles: true})); assert.ok(tree.hasAttribute('data-sc-hover-col'), 'hovered'); };
  const clear = () => assert.ok(!tree.hasAttribute('data-sc-hover-col') && document.querySelectorAll('[data-sc-hover-cell]').length === 0);
  const mouseout = related => { const e = new window.Event('mouseout', {bubbles: true}); e.relatedTarget = related; cell().dispatchEvent(e); };
  hover(); mouseout(document.body); clear();                       // to an element outside the tree
  hover(); mouseout(null); clear();                                 // to nowhere
  hover(); mouseout(document.querySelector('.row .cell.title')); assert.ok(tree.hasAttribute('data-sc-hover-col'), 'a move inside the tree keeps it');
  tree.dispatchEvent(new window.Event('mouseleave')); clear();
  hover(); document.body.dispatchEvent(new window.Event('scroll', {bubbles: true})); clear();
  hover(); window.dispatchEvent(new window.Event('blur')); clear();
  // A mark left on another cell (a recycled row) is swept too.
  document.querySelector('.row .cell.title').setAttribute('data-sc-hover-cell', '');
  hover(); mouseout(null); clear();
});

test('R9 with several rows selected, refreshing citations and adding a tag act on every selected paper', async () => {
  const {document, window} = await page();
  const rt = fakeRT(window);
  const a = {id: 7, getField: () => ''}, b = {id: 8, getField: () => ''};
  const prompts = [];
  window.Services = {prompt: {prompt: (w, title, text, value) => { prompts.push(text); value.value = 'review'; return true; }}};
  const calls = [];
  rt.refreshCitations = async (list, o) => { calls.push(['citations', list.map(i => i.id)]); return {ok: 2, 'not-found': 0, unsupported: 0, error: 0}; };
  rt.libraryService.addTags = async (ids, tags) => calls.push(['addTags', ids, tags]);
  const plan = key => Cells.plan({rt, win: window, item: a, items: [a, b], key, text: ''});
  const cite = plan('citations')[0];
  assert.match(cite.label, /2/, 'the entry names how many papers it covers');
  await cite.run();
  const tag = plan('tags')[0];
  assert.match(tag.label, /2/);
  await tag.run();
  assert.deepEqual(calls, [['citations', [7, 8]], ['addTags', [7, 8], ['review']]]);
  // One paper keeps the short wording.
  assert.equal(Cells.plan({rt, win: window, item: a, items: [a], key: 'citations', text: ''})[0].label, '인용 수 새로고침');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import reading from '../src/reading.js';
class Target {
  listeners = new Map();
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  emit(name, extra = {}) { for (const callback of this.listeners.get(name) || []) callback({ isTrusted: true, ...extra }); }
  count() { return [...this.listeners.values()].reduce((n, values) => n + values.size, 0); }
}
function fixture(options = {}) {
  const window = new Target();
  const document = window.document = new Target();
  let focus = true, time = 0, callback;
  document.hasFocus = () => focus;
  window.performance = { now: () => time };
  window.setInterval = fn => { callback = fn; return 1; };
  window.clearInterval = () => { callback = null; };
  const frame = new Target();
  const pdf = new Target();
  pdf.frames = [];
  frame.frames = [pdf];
  const item = { id: 1 }, attachment = { id: 2, parentID: 1 };
  const reader = { _window: window, _iframeWindow: frame, type: 'pdf', itemID: 2 };
  window.Zotero_Tabs = { selectedID: 'pdf' };
  window.Zotero = { Reader: { getByTabID: id => id === 'pdf' ? reader : null, _readers: [reader] },
    Items: { get: id => id === 1 ? item : id === 2 ? attachment : null } };
  const ticks = [], errors = [];
  const cleanup = reading.attach(window, { onTick: (item, seconds) => ticks.push({ item, seconds }),
    onError: error => errors.push(error), ...options });
  return { window, document, frame, pdf, reader, item, attachment, ticks, errors, cleanup,
    setFocus: value => { focus = value; },
    advance: async milliseconds => { time += milliseconds; callback?.(); await Promise.resolve(); await Promise.resolve(); },
    elapse: milliseconds => { time += milliseconds; },
    hasTimer: () => !!callback };
}
test('counts only trusted active PDF input, including nested PDF frames, against parent item', async () => {
  const f = fixture();
  await f.advance(1000);
  f.pdf.emit('pointermove', { isTrusted: false });
  await f.advance(1000);
  assert.equal(f.ticks.length, 0);
  f.pdf.emit('wheel');
  await f.advance(1000);
  assert.deepEqual(f.ticks, [{ item: f.item, seconds: 1 }]);
  await f.cleanup();
});
test('idle cutoff clips partial seconds and resumed activity never credits the idle gap', async () => {
  const f = fixture();
  f.pdf.emit('keydown');
  for (let i = 0; i < 59; i++) await f.advance(1000);
  await f.advance(1500);
  assert.equal(f.ticks.reduce((n, tick) => n + tick.seconds, 0), 60);
  await f.advance(10000);
  f.pdf.emit('pointerdown');
  await f.advance(1000);
  assert.equal(f.ticks.reduce((n, tick) => n + tick.seconds, 0), 61);
  await f.cleanup();
});
test('background windows, hidden documents, and library tabs receive no credit', async () => {
  for (const deactivate of [f => f.setFocus(false), f => { f.document.hidden = true; },
    f => { f.window.Zotero_Tabs.selectedID = 'library'; }]) {
    const f = fixture();
    f.pdf.emit('wheel');
    await f.advance(1000);
    deactivate(f);
    await f.advance(1000);
    f.pdf.emit('wheel');
    await f.advance(1000);
    assert.equal(f.ticks.length, 1);
    await f.cleanup();
  }
});
test('foreground restoration requires activity and suspension is capped', async () => {
  const f = fixture();
  f.pdf.emit('wheel');
  await f.advance(3600000);
  assert.equal(f.ticks[0].seconds, 2);
  await f.advance(1000);
  assert.equal(f.ticks.length, 1);
  f.window.emit('blur');
  await f.advance(1000);
  f.pdf.emit('wheel');
  await f.advance(1000);
  assert.equal(f.ticks.length, 2);
  await f.cleanup();
});
test('reader tab switches do not transfer active-reading eligibility', async () => {
  const f = fixture();
  f.pdf.emit('wheel');
  await f.advance(1000);
  const another = { ...f.reader };
  f.window.Zotero.Reader.getByTabID = () => another;
  await f.advance(1000);
  await f.advance(1000);
  assert.equal(f.ticks.length, 1);
  f.pdf.emit('keydown');
  await f.advance(1000);
  assert.equal(f.ticks.length, 2);
  await f.cleanup();
});
test('slow persistence is serialized, failures reported, and cleanup drains accepted ticks', async () => {
  const calls = [];
  let release;
  const f = fixture({ onTick: async (item, seconds) => {
    calls.push(seconds);
    if (calls.length === 1) await new Promise(resolve => { release = resolve; });
    else if (calls.length === 2) throw new Error('save failed');
  } });
  f.pdf.emit('wheel');
  await f.advance(1000);
  await f.advance(1000);
  await f.advance(1000);
  assert.deepEqual(calls, [1]);
  const done = f.cleanup();
  release();
  await done;
  assert.deepEqual(calls, [1, 1, 1]);
  assert.equal(f.errors[0].message, 'save failed');
  assert.equal(f.window.count() + f.document.count() + f.frame.count() + f.pdf.count(), 0);
  assert.equal(f.hasTimer(), false);
  await f.cleanup();
});
test('standalone PDFs and standalone attachments work; EPUB is not timed', async () => {
  const f = fixture();
  delete f.window.Zotero_Tabs;
  delete f.attachment.parentID;
  f.pdf.emit('wheel');
  await f.advance(1000);
  assert.equal(f.ticks[0].item, f.attachment);
  f.reader.type = 'epub';
  await f.advance(1000);
  assert.equal(f.ticks.length, 1);
  await f.cleanup();
});
test('replaced nested frames lose listeners, new PDF frames accept activity, unload removes all', async () => {
  const f = fixture();
  const replacement = new Target();
  replacement.frames = [];
  f.frame.frames = [replacement];
  await f.advance(1000);
  assert.equal(f.pdf.count(), 0);
  replacement.emit('wheel');
  await f.advance(1000);
  assert.equal(f.ticks.length, 1);
  f.window.emit('unload');
  await f.cleanup();
  assert.equal(replacement.count() + f.frame.count() + f.window.count() + f.document.count(), 0);
});
test('clock rollback clears eligibility until fresh PDF activity', async () => {
  const f = fixture();
  f.pdf.emit('wheel');
  await f.advance(1000);
  await f.advance(-2000);
  await f.advance(1000);
  assert.equal(f.ticks.length, 1);
  f.pdf.emit('wheel');
  await f.advance(1000);
  assert.equal(f.ticks.length, 2);
  await f.cleanup();
});
test('another window reader cannot be credited and missing items are ignored', async () => {
  const f = fixture();
  f.reader._window = {};
  f.pdf.emit('wheel');
  await f.advance(1000);
  assert.equal(f.ticks.length, 0);
  f.reader._window = f.window;
  f.window.Zotero.Items.get = () => null;
  await f.advance(1000);
  assert.equal(f.ticks.length, 0);
  await f.cleanup();
});
test('onSession fires synchronously once per actual activity session and before measured ticks', async () => {
  const events = [];
  const f = fixture({ onSession: item => events.push(['session', item.id]),
    onTick: (item, seconds) => events.push(['tick', seconds]) });
  await f.advance(1000);
  assert.deepEqual(events, []);
  f.pdf.emit('wheel');
  assert.deepEqual(events, [['session', 1]]);
  await f.advance(1000);
  f.pdf.emit('keydown');
  f.pdf.emit('pointermove');
  await f.advance(1000);
  assert.deepEqual(events, [['session', 1], ['tick', 1], ['tick', 1]]);
  await f.advance(61000);
  f.pdf.emit('wheel');
  assert.equal(events.filter(event => event[0] === 'session').length, 2);
  f.window.emit('blur');
  await f.advance(1000);
  f.pdf.emit('wheel');
  assert.equal(events.filter(event => event[0] === 'session').length, 3);
  const another = { ...f.reader };
  f.window.Zotero.Reader.getByTabID = () => another;
  await f.advance(1000);
  f.pdf.emit('wheel');
  assert.equal(events.filter(event => event[0] === 'session').length, 4);
  await f.cleanup();
});
test('per-page location is snapshotted at interval start and delivered with the attachment ID',async()=>{
 const locations=[];const f=fixture({onTick:(item,seconds,location)=>locations.push({seconds,location})});
 f.reader._internalReader={_state:{primaryViewStats:{pageIndex:2,pagesCount:10}}};f.pdf.emit('wheel');
 f.reader._internalReader._state.primaryViewStats.pageIndex=3;await f.advance(1000);
 assert.deepEqual(locations[0],{seconds:1,location:{pageIndex:2,totalPages:10,attachmentID:2}});
 await f.advance(1000);assert.equal(locations[1].location.pageIndex,3);await f.cleanup();
});
test('per-page clock follows active split reader and leaves missing page data unknown',async()=>{
 const locations=[];const f=fixture({onTick:(item,seconds,location)=>locations.push(location)});
 f.reader._internalReader={_lastViewPrimary:false,_secondaryView:{},_state:{primaryViewStats:{pageIndex:0,pagesCount:20},secondaryViewStats:{pageIndex:8,pagesCount:20}}};
 f.pdf.emit('wheel');await f.advance(1000);assert.equal(locations[0].pageIndex,8);
 f.reader._internalReader._state.secondaryViewStats={pageIndex:-1,pagesCount:0};await f.advance(1000);await f.advance(1000);assert.deepEqual(locations[2],{pageIndex:null,totalPages:null,attachmentID:2});await f.cleanup();
});
test('session callback receives first attachment page location before any measured tick',async()=>{
 const sessions=[];const f=fixture({onSession:(item,location)=>sessions.push(location)});f.reader._internalReader={_state:{primaryViewStats:{pageIndex:4,pagesCount:12}}};f.pdf.emit('wheel');assert.deepEqual(sessions,[{pageIndex:4,totalPages:12,attachmentID:2}]);await f.cleanup();
});
test('blur and cleanup credit the final active fraction once, including sub-second reads',async()=>{
 for(const boundary of ['blur','cleanup']){
  const f=fixture();f.pdf.emit('wheel');f.elapse(750);
  if(boundary==='blur'){f.setFocus(false);f.window.emit('blur');}
  await f.cleanup();await f.cleanup();
  assert.deepEqual(f.ticks,[{item:f.item,seconds:.75}]);
 }
});
test('final fraction follows the last sampled page and does not duplicate the previous tick',async()=>{
 const events=[];const f=fixture({onTick:(item,seconds,location)=>events.push({seconds,location})});
 f.reader._internalReader={_state:{primaryViewStats:{pageIndex:1,pagesCount:5}}};f.pdf.emit('wheel');await f.advance(1000);f.elapse(250);f.window.emit('blur');await f.cleanup();
 assert.deepEqual(events.map(e=>e.seconds),[1,.25]);assert.ok(events.every(e=>e.location.pageIndex===1&&e.location.attachmentID===2));
});
test('final fraction remains idle-aware and suspension-bounded',async()=>{
 const idle=fixture();await idle.advance(1000);idle.elapse(750);await idle.cleanup();assert.deepEqual(idle.ticks,[]);
 const suspended=fixture();suspended.pdf.emit('wheel');suspended.elapse(3600000);await suspended.cleanup();assert.deepEqual(suspended.ticks.map(t=>t.seconds),[2]);
});
test('configurable idle timeout is clamped and still credits only actual active intervals',async()=>{
 for(const idleMs of [1,5000]){const f=fixture({idleMs});f.pdf.emit('wheel');for(let i=0;i<6;i++)await f.advance(1000);assert.equal(f.ticks.reduce((n,t)=>n+t.seconds,0),5);await f.cleanup();}
 const f=fixture({idleMs:1e9});f.pdf.emit('wheel');for(let i=0;i<301;i++)await f.advance(1000);assert.equal(f.ticks.reduce((n,t)=>n+t.seconds,0),300);await f.cleanup();
});
test('configured sampling cadence preserves fractional time and page snapshots',async()=>{
 const f=fixture({intervalMs:250,idleMs:5000});f.pdf.emit('wheel');await f.advance(250);await f.advance(250);f.elapse(100);await f.cleanup();assert.deepEqual(f.ticks.map(t=>t.seconds),[.25,.25,.1]);
});

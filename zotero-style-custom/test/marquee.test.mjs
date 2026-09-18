import test from "node:test";
import assert from "node:assert/strict";
import marquee from "../src/marquee.js";

// Minimal DOM fixture: Zotero's virtualized table -> row -> title cell containing
// a fixed icon and an overflow:hidden .cell-text span with rich title children.
class Target {
  listeners = new Map();
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  emit(name, event = {}) {
    for (const callback of this.listeners.get(name) || []) callback({ target: this, ...event });
  }
  count() { return [...this.listeners.values()].reduce((n, callbacks) => n + callbacks.size, 0); }
}

class Style {
  values = new Map();
  getPropertyValue(name) { return this.values.get(name)?.value || ""; }
  getPropertyPriority(name) { return this.values.get(name)?.priority || ""; }
  setProperty(name, value, priority = "") { this.values.set(name, { value, priority }); }
  removeProperty(name) { this.values.delete(name); }
}

class Element {
  nodeType = 1;
  children = [];
  attributes = new Map();
  style = new Style();
  scrollLeft = 0;
  clientWidth = 100;
  scrollWidth = 100;
  constructor(classes, parent = null, text = "") {
    this.classes = classes.split(" ");
    this.parentElement = parent;
    this.content = text;
    parent?.children.push(this);
  }
  get textContent() { return this.content + this.children.map(child => child.textContent).join(""); }
  set textContent(value) { this.content = value; this.children = []; }
  get isConnected() { return this.root === true || !!this.parentElement?.isConnected; }
  matches(selector) {
    return selector.startsWith("#") ? this.id === selector.slice(1)
      : selector.slice(1).split(".").every(value => this.classes.includes(value));
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const descendant = child.querySelector(selector);
      if (descendant) return descendant;
    }
    return null;
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
}

function fixture({ reduced = false, direction = "ltr" } = {}) {
  const window = new Target();
  const document = window.document = new Target();
  const media = new Target();
  media.matches = reduced;
  const observers = new Set();
  const frames = new Map();
  let clock = 0;
  let nextFrame = 1;
  window.matchMedia = () => media;
  window.getComputedStyle = () => ({ direction });
  window.performance = { now: () => clock };
  window.requestAnimationFrame = callback => { frames.set(nextFrame, callback); return nextFrame++; };
  window.cancelAnimationFrame = id => frames.delete(id);
  window.MutationObserver = class {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  };
  const root = document.documentElement = new Element("");
  root.root = true;
  const tree = new Element("", root);
  tree.id = "zotero-items-tree";
  const table = new Element("virtualized-table", tree);
  const row = new Element("row", table);
  const cell = new Element("cell title primary first-column", row);
  const icon = new Element("cell-icon", cell);
  const text = new Element("cell-text", cell, "A long title with ");
  const rich = new Element("italic", text, "scientific markup");
  text.scrollWidth = 460;
  const hover = target => document.emit("mouseover", { target });
  const advance = time => {
    clock += time;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(clock);
  };
  const mutation = () => { for (const observer of [...observers]) observer.callback(); };
  return { window, document, media, tree, table, row, cell, icon, text, rich, hover, advance, mutation, frames, observers };
}

test("overflowing rich titles begin quickly, keep icon/markup intact, and stop after one pass", () => {
  const f = fixture();
  const cleanup = marquee.attach(f.window);
  const children = [...f.text.children];
  f.hover(f.rich);
  assert.equal(f.cell.getAttribute("title"), "A long title with scientific markup");
  f.advance(199);
  assert.equal(f.text.scrollLeft, 0);
  assert.equal(f.text.style.getPropertyValue("text-overflow"), "");
  f.advance(101);
  assert.equal(f.text.scrollLeft, 18);
  assert.equal(f.text.style.getPropertyValue("text-overflow"), "clip");
  f.advance(1900);
  assert.equal(f.text.scrollLeft, 360);
  f.advance(800);
  assert.equal(f.text.scrollLeft, 360);
  f.advance(100);
  // One pass, then it stops. It used to return to the start and set off again
  // for as long as the pointer stayed, so a hovered row read as permanently in
  // motion rather than as something that scrolled because you asked it to.
  assert.equal(f.text.scrollLeft, 0);
  f.advance(500);
  assert.equal(f.text.scrollLeft, 0, 'it does not set off again');
  f.advance(4000);
  assert.equal(f.text.scrollLeft, 0);
  // And the ellipsis comes back, so the finished row looks like every other one.
  assert.notEqual(f.text.style.getPropertyValue("text-overflow"), "clip");
  assert.equal(f.icon.scrollLeft, 0);
  assert.equal(f.icon.style.values.size, 0);
  assert.deepEqual(f.text.children, children);
  cleanup();
});

test("fitting titles, other columns, headers, and drag copies do not animate", () => {
  const f = fixture();
  const cleanup = marquee.attach(f.window);
  f.text.scrollWidth = f.text.clientWidth;
  f.hover(f.cell);
  assert.equal(f.frames.size, 0);
  assert.equal(f.cell.getAttribute("title"), null);
  const other = new Element("cell date", f.row);
  const header = new Element("cell title", f.table);
  const dragRow = new Element("row", f.tree);
  const dragTitle = new Element("cell title", dragRow);
  for (const element of [other, header, dragTitle]) f.hover(element);
  assert.equal(f.frames.size, 0);
  cleanup();
});

test("moving within a cell preserves timing; leaving restores scroll, tooltip, and inline style", () => {
  const f = fixture();
  f.text.scrollLeft = 3;
  f.text.style.setProperty("text-overflow", "ellipsis", "important");
  f.cell.setAttribute("title", "Existing tooltip");
  const cleanup = marquee.attach(f.window);
  f.hover(f.text);
  f.advance(100);
  f.document.emit("mouseout", { target: f.text, relatedTarget: f.rich });
  f.hover(f.rich);
  f.advance(200);
  assert.equal(f.text.scrollLeft, 18);
  f.document.emit("mouseout", { target: f.rich, relatedTarget: f.row });
  assert.equal(f.text.scrollLeft, 3);
  assert.equal(f.cell.getAttribute("title"), "Existing tooltip");
  assert.equal(f.text.style.getPropertyValue("text-overflow"), "ellipsis");
  assert.equal(f.text.style.getPropertyPriority("text-overflow"), "important");
  assert.equal(f.frames.size, 0);
  assert.equal(f.observers.size, 0);
  cleanup();
});

test("table scroll resets the title, while animation scroll events do not cancel it", () => {
  const f = fixture();
  const cleanup = marquee.attach(f.window);
  f.hover(f.cell);
  f.advance(700);
  f.document.emit("scroll", { target: f.text });
  assert.equal(f.text.scrollLeft, 90);
  assert.equal(f.frames.size, 1);
  f.document.emit("scroll", { target: f.table });
  assert.equal(f.text.scrollLeft, 0);
  assert.equal(f.frames.size, 0);
  cleanup();
});

test("switching titles resets the first without letting its delayed scroll event cancel the second", () => {
  const f = fixture();
  const cleanup = marquee.attach(f.window);
  const nextRow = new Element("row", f.table);
  const nextCell = new Element("cell title primary", nextRow);
  const nextText = new Element("cell-text", nextCell, "Another overflowing title");
  nextText.scrollWidth = 300;
  f.hover(f.text);
  f.advance(700);
  f.hover(nextText);
  assert.equal(f.text.scrollLeft, 0);
  f.document.emit("scroll", { target: f.text });
  f.advance(700);
  assert.equal(nextText.scrollLeft, 90);
  f.document.emit("mouseout", { target: nextText, relatedTarget: f.row });
  assert.equal(nextText.scrollLeft, 0);
  cleanup();
});

test("recycling and title edits reset immediately, then new rows can be hovered", () => {
  const f = fixture();
  const cleanup = marquee.attach(f.window);
  f.hover(f.cell);
  f.advance(500);
  f.text.parentElement = null;
  f.cell.children = [f.icon];
  f.mutation();
  assert.equal(f.frames.size, 0);
  assert.equal(f.text.scrollLeft, 0);
  const replacement = new Element("cell-text", f.cell, "A different long title");
  replacement.scrollWidth = 280;
  f.hover(replacement);
  f.advance(500);
  assert.equal(replacement.scrollLeft, 54);
  replacement.textContent = "Edited title";
  f.mutation();
  assert.equal(replacement.scrollLeft, 0);
  assert.equal(f.cell.getAttribute("title"), null);
  cleanup();
});

test("the frame guard catches detached trees and width changes even before mutation delivery", () => {
  for (const invalidate of [f => { f.tree.parentElement = null; }, f => { f.text.clientWidth = 150; }]) {
    const f = fixture();
    const cleanup = marquee.attach(f.window);
    f.hover(f.cell);
    f.advance(500);
    invalidate(f);
    f.advance(16);
    assert.equal(f.text.scrollLeft, 0);
    assert.equal(f.frames.size, 0);
    cleanup();
  }
});

test("reduced motion keeps a static full-title tooltip and responds to preference changes", () => {
  const f = fixture({ reduced: true });
  const cleanup = marquee.attach(f.window);
  f.hover(f.cell);
  assert.equal(f.frames.size, 0);
  assert.equal(f.cell.getAttribute("title"), f.text.textContent);
  f.media.matches = false;
  f.media.emit("change");
  f.advance(500);
  assert.equal(f.text.scrollLeft, 54);
  f.media.matches = true;
  f.media.emit("change");
  assert.equal(f.text.scrollLeft, 0);
  assert.equal(f.frames.size, 0);
  assert.equal(f.cell.getAttribute("title"), f.text.textContent);
  cleanup();
  assert.equal(f.cell.getAttribute("title"), null);
});

test("cleanup is idempotent and window unload cancels frames, observers, and all listeners", () => {
  for (const unload of [false, true]) {
    const f = fixture();
    const cleanup = marquee.attach(f.window);
    f.hover(f.cell);
    f.advance(500);
    if (unload) f.window.emit("unload");
    else cleanup();
    cleanup();
    assert.equal(f.text.scrollLeft, 0);
    assert.equal(f.cell.getAttribute("title"), null);
    assert.equal(f.frames.size + f.observers.size, 0);
    assert.equal(f.document.count() + f.window.count() + f.media.count(), 0);
    f.hover(f.cell);
    assert.equal(f.frames.size, 0);
  }
});

test("mousedown/drag/blur stop scrolling without preventing normal item interaction", () => {
  const f = fixture();
  const cleanup = marquee.attach(f.window);
  let selectionEvents = 0;
  f.document.addEventListener("mousedown", () => { selectionEvents++; });
  for (const name of ["mousedown", "dragstart"]) {
    f.hover(f.cell);
    f.advance(500);
    f.document.emit(name, { target: f.text });
    assert.equal(f.text.scrollLeft, 0);
  }
  assert.equal(selectionEvents, 1);
  f.document.emit("mousemove", { target: f.cell, buttons: 1 });
  assert.equal(f.frames.size, 0);
  f.hover(f.cell);
  f.window.emit("blur");
  assert.equal(f.frames.size, 0);
  cleanup();
});

test("RTL titles scroll in their reading direction; live options can disable an active roll", () => {
  const f = fixture({ direction: "rtl" });
  let enabled = true;
  const cleanup = marquee.attach(f.window, { delay: 100, speed: 240, getOptions: () => ({ enabled }) });
  f.hover(f.cell);
  f.advance(600);
  assert.equal(f.text.scrollLeft, -120);
  enabled = false;
  f.advance(16);
  assert.equal(f.text.scrollLeft, 0);
  assert.equal(f.frames.size, 0);
  f.hover(f.cell);
  assert.equal(f.frames.size, 0);
  cleanup();
});

test("a long value in any column rolls, not just the title", () => {
  const f = fixture();
  // A plain column: Zotero clips on the cell itself, with no .cell-text wrapper.
  const venue = new Element("cell venue", f.row, "Proceedings of the National Academy of Sciences");
  venue.scrollWidth = 420;
  const impact = new Element("cell if", f.row, "16.6");
  const cleanup = marquee.attach(f.window);

  f.hover(venue);
  assert.equal(venue.getAttribute("title"), "Proceedings of the National Academy of Sciences");
  f.advance(200);
  f.advance(1000);
  assert.ok(venue.scrollLeft > 0, "an overflowing journal name should roll");
  assert.equal(f.text.scrollLeft, 0, "rolling one cell must not disturb the title");

  // A value that already fits stays still, and leaving a cell restores it.
  f.hover(impact);
  f.advance(1200);
  assert.equal(impact.scrollLeft, 0);
  assert.equal(venue.scrollLeft, 0);
  assert.equal(venue.getAttribute("title"), null);
  cleanup();
});

test("the roll is one pass per hover, and hovering away and back starts a fresh one", () => {
  const f = fixture();
  const stop = marquee.attach(f.window);
  f.hover(f.rich);
  // 200ms delay, then 360px at 180px/s, then the end pause.
  f.advance(200 + 2000 + 900 + 100);
  assert.equal(f.text.scrollLeft, 0, "one pass, then back to the start");
  assert.notEqual(f.text.style.getPropertyValue("text-overflow"), "clip",
    "and the ellipsis returns, so a finished row looks like every other one");
  f.advance(4000);
  assert.equal(f.text.scrollLeft, 0, "it does not set off again while the pointer stays");

  // Leaving and coming back is a new request, and that does roll again.
  f.document.emit("mouseout", { target: f.rich, relatedTarget: null });
  f.hover(f.rich);
  f.advance(400);
  assert.ok(f.text.scrollLeft > 0, "a second hover rolls again");
  stop();
});

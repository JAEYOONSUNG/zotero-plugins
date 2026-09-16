import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import Marquee from "../content/marquee.js";
import { mockElement, paper, uiHarness } from "./helpers/search-ui-harness.mjs";

function environment({ reduced = false, intersection = true } = {}) {
	let time = 0, id = 0, selection = null;
	const frames = new Map(), timers = new Map(), intersections = [], resizes = [];
	const doc = mockElement("document"), win = mockElement("window"), media = mockElement("media");
	doc.hidden = false;
	doc.getSelection = () => selection;
	media.matches = reduced;
	function create(tag) {
		const node = mockElement(tag);
		node.ownerDocument = doc;
		Object.defineProperties(node, {
			clientWidth: { get() { return this.width ?? this.parentNode?.clientWidth ?? 0; }, set(value) { this.width = value; } },
			scrollWidth: { get() { return this.fullWidth ?? this.parentNode?.scrollWidth ?? this.clientWidth; }, set(value) { this.fullWidth = value; } }
		});
		node.getBoundingClientRect = () => node.rect || node.parentNode?.getBoundingClientRect() || { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
		return node;
	}
	doc.createElement = create;
	Object.assign(win, {
		document: doc, performance: { now: () => time }, matchMedia: () => media,
		getComputedStyle: node => ({ direction: node.direction || node.parentNode?.direction || "ltr" }),
		requestAnimationFrame(fn) { const key = ++id; frames.set(key, fn); return key; },
		cancelAnimationFrame(key) { frames.delete(key); },
		setTimeout(fn, delay) { const key = ++id; timers.set(key, { fn, due: time + delay }); return key; },
		clearTimeout(key) { timers.delete(key); },
		ResizeObserver: class {
			constructor(callback) { this.callback = callback; this.targets = new Set(); resizes.push(this); }
			observe(target) { this.targets.add(target); }
			unobserve(target) { this.targets.delete(target); }
			disconnect() { this.targets.clear(); this.disconnected = true; }
			notify() { this.callback([...this.targets].map(target => ({ target }))); }
		}
	});
	if (intersection) win.IntersectionObserver = class {
		constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); intersections.push(this); }
		observe(target) { this.targets.add(target); }
		unobserve(target) { this.targets.delete(target); }
		disconnect() { this.targets.clear(); this.disconnected = true; }
		emit(cells, on) { this.callback(cells.map(cell => ({ target: viewport(cell), isIntersecting: on, intersectionRect: { width: on ? cell.clientWidth : 0, height: on ? 20 : 0 } }))); }
	};
	const root = create("div"); root.connected = true; root.clientWidth = 800;
	root.rect = { top: 0, left: 0, right: 800, bottom: 200, width: 800, height: 200 };
	function cell({ text = "A long title with all of its words available", width = 100, full = 184, field = "title", tooltip, direction = "ltr", offscreen = false } = {}) {
		const value = create("td");
		value.dataset.marquee = field; value.textContent = text; value.clientWidth = width; value.scrollWidth = full; value.direction = direction;
		value.rect = { top: offscreen ? 400 : 20, bottom: offscreen ? 420 : 40, left: 0, right: width, width, height: 20 };
		if (tooltip != null) value.title = tooltip;
		root.appendChild(value);
		return value;
	}
	function at(timestamp) {
		assert.ok(timestamp >= time, "test clock cannot move backwards");
		time = timestamp;
		for (const [key, timer] of [...timers]) if (timer.due <= time) { timers.delete(key); timer.fn(); }
		const pending = [...frames]; frames.clear();
		for (const [, fn] of pending) fn(time);
	}
	return { doc, win, media, root, cell, create, frames, timers, intersections, resizes, at,
		show(cells, on = true) { intersections[0].emit(cells, on); },
		select(value) { selection = value; doc.emit("selectionchange"); } };
}
const viewport = cell => cell.querySelector(".marquee-text");

test("overflow rolls automatically at42px/s, pauses at both ends, and returns without jumping", () => {
	const env = environment(), long = env.cell(), short = env.cell({ text: "Short", full: 50 });
	const controller = Marquee.attach(env.win, env.root);
	env.show([long, short]); env.at(0);
	assert.equal(viewport(long).scrollLeft, 0);
	assert.equal(env.frames.size, 0, "endpoint pause does not spin animation frames");
	assert.equal(env.timers.size, 1);
	env.at(1000); env.at(2000);
	assert.equal(viewport(long).scrollLeft, 42);
	assert.equal(viewport(short).scrollLeft, 0);
	assert.equal(short.classList.contains("marquee-active"), false);
	env.at(3000);
	assert.equal(viewport(long).scrollLeft, 84, "last character reaches the visible edge");
	assert.equal(long.dataset.marqueePhase, "end");
	env.at(3500);
	assert.equal(viewport(long).scrollLeft, 84, "end stays readable during the pause");
	env.at(4000); env.at(5000);
	assert.equal(viewport(long).scrollLeft, 42);
	env.at(6000);
	assert.equal(viewport(long).scrollLeft, 0);
	assert.equal(long.dataset.marqueePhase, "start");
	assert.equal(long.title, long.textContent, "full text is also available without waiting for motion");
	assert.equal(controller.getMetrics().speed, 42);
	controller.cleanup();
});

test("a thousand offscreen cells share one scheduler and only visible viewports are resized", () => {
	const env = environment();
	const cells = Array.from({ length: 1000 }, (_, i) => env.cell({ offscreen: i > 1 }));
	const controller = Marquee.attach(env.win, env.root);
	env.show(cells.slice(0, 2)); env.at(0); env.at(1000); env.at(2000);
	assert.equal(controller.getMetrics().tracked, 1000);
	assert.equal(controller.getMetrics().active, 2);
	assert.equal(env.intersections.length, 1);
	assert.equal(env.resizes.length, 1);
	assert.equal(env.resizes[0].targets.size, 3, "root plus two visible viewports");
	assert.equal(env.frames.size + env.timers.size, 1);
	assert.equal(viewport(cells[999]).scrollLeft, 0);
	env.show(cells.slice(0, 2), false);
	assert.equal(controller.getMetrics().active, 0);
	assert.equal(env.frames.size + env.timers.size, 0);
	assert.equal(env.resizes[0].targets.size, 1);
	assert.equal(viewport(cells[0]).scrollLeft, 0);
	controller.cleanup();
});

test("column resizing stops newly fitting text and starts new overflow from its beginning", () => {
	const env = environment(), cell = env.cell();
	const controller = Marquee.attach(env.win, env.root);
	env.show([cell]); env.at(0); env.at(1000); env.at(2000);
	cell.clientWidth = 200; env.resizes[0].notify();
	assert.equal(controller.getMetrics().active, 0);
	assert.equal(viewport(cell).scrollLeft, 0);
	assert.equal(env.frames.size + env.timers.size, 0);
	cell.clientWidth = 80; env.resizes[0].notify();
	assert.equal(controller.getMetrics().active, 1);
	assert.equal(controller.getMetrics().cells[0].distance, 104);
	env.at(2000); env.at(3000); env.at(4000);
	assert.equal(viewport(cell).scrollLeft, 42);
	controller.cleanup();
});

test("redraw and status replacement discard old viewports and preserve links/tooltips", () => {
	const env = environment(), cell = env.cell({ text: "", tooltip: "Open the article" });
	const link = env.create("a"); link.textContent = "The complete linked article title"; link.href = "https://example.test/paper";
	let clicks = 0; link.addEventListener("click", () => clicks++); cell.appendChild(link);
	const controller = Marquee.attach(env.win, env.root);
	env.show([cell]); env.at(0); env.at(1000); env.at(2000);
	assert.equal(viewport(cell).firstChild, link);
	link.emit("click"); assert.equal(clicks, 1);
	assert.equal(cell.title, "The complete linked article title\nOpen the article");
	const oldViewport = viewport(cell);
	cell.textContent = "Import failed with a complete status message"; cell.title = "Publisher returned an error";
	controller.refreshCell(cell); env.show([cell]);
	assert.notEqual(viewport(cell), oldViewport);
	assert.equal(env.intersections[0].targets.has(oldViewport), false);
	assert.equal(cell.title, "Import failed with a complete status message\nPublisher returned an error");
	cell.remove(); controller.refresh();
	assert.equal(controller.getMetrics().tracked, 0);
	assert.equal(env.frames.size + env.timers.size, 0);
	controller.cleanup();
	assert.equal(env.intersections[0].disconnected, true);
	assert.equal(env.resizes[0].disconnected, true);
});

test("reduced motion stays static and restores readable original nodes on cleanup", () => {
	const env = environment({ reduced: true }), cell = env.cell({ tooltip: "A custom original tooltip" });
	const originalText = cell.firstChild;
	const controller = Marquee.attach(env.win, env.root);
	env.show([cell]); env.at(5000);
	assert.equal(env.frames.size + env.timers.size, 0);
	assert.equal(viewport(cell).scrollLeft, 0);
	assert.equal(controller.getMetrics().reducedMotion, true);
	assert.ok(cell.title.includes(cell.textContent));
	env.media.matches = false; env.media.emit("change");
	env.at(5000); env.at(6000); env.at(7000);
	assert.equal(viewport(cell).scrollLeft, 42);
	env.media.matches = true; env.media.emit("change");
	assert.equal(viewport(cell).scrollLeft, 0);
	assert.equal(env.frames.size + env.timers.size, 0);
	controller.cleanup();
	assert.equal(cell.firstChild, originalText);
	assert.equal(cell.title, "A custom original tooltip");
	assert.equal(cell.classList.contains("marquee-managed"), false);
	assert.equal(Marquee.getMetrics(env.root), null);
});

test("hidden windows and text selection pause motion without moving text under a drag", () => {
	const env = environment(), cell = env.cell();
	const controller = Marquee.attach(env.win, env.root);
	env.show([cell]); env.at(0); env.at(1000); env.at(2000);
	env.root.emit("mousedown"); env.at(10000);
	assert.equal(viewport(cell).scrollLeft, 42);
	assert.equal(env.frames.size + env.timers.size, 0);
	env.select({ isCollapsed: false, anchorNode: viewport(cell).firstChild, focusNode: viewport(cell).firstChild });
	env.doc.emit("mouseup"); env.at(11000);
	assert.equal(viewport(cell).scrollLeft, 42);
	env.select(null); env.at(11000); env.at(11500);
	assert.equal(viewport(cell).scrollLeft, 63);
	env.doc.hidden = true; env.doc.emit("visibilitychange"); env.at(20000);
	assert.equal(viewport(cell).scrollLeft, 63);
	env.doc.hidden = false; env.doc.emit("visibilitychange"); env.at(20000);
	assert.equal(viewport(cell).scrollLeft, 63, "returning to the window does not skip unread text");
	env.win.emit("blur"); assert.equal(env.frames.size + env.timers.size, 0);
	env.win.emit("focus"); assert.equal(env.frames.size, 1);
	controller.cleanup();
});

test("RTL scrolling reaches the opposite edge and fallback visibility excludes offscreen cells", () => {
	const env = environment({ intersection: false });
	const rtl = env.cell({ direction: "rtl" }), offscreen = env.cell({ offscreen: true });
	const controller = Marquee.attach(env.win, env.root);
	env.at(0); env.at(1000); env.at(2000);
	assert.equal(viewport(rtl).scrollLeft, -42);
	assert.equal(viewport(offscreen).scrollLeft, 0);
	assert.equal(controller.getMetrics().active, 1);
	offscreen.rect = { ...offscreen.rect, top: 50, bottom: 70 }; env.root.emit("scroll");
	assert.equal(controller.getMetrics().active, 2);
	controller.cleanup();
});

test("unload cancels shared work, removes listeners and ignores delayed observers", () => {
	const env = environment(), cell = env.cell();
	const controller = Marquee.attach(env.win, env.root);
	assert.equal(Marquee.attach(env.win, env.root), controller, "reattachment cannot multiply observers or schedulers");
	env.show([cell]); env.at(0);
	const oldViewport = viewport(cell);
	env.win.emit("unload");
	assert.equal(env.frames.size + env.timers.size, 0);
	assert.equal(env.win.listenerCount() + env.doc.listenerCount() + env.media.listenerCount() + env.root.listenerCount(), 0);
	assert.equal(env.root.hasAttribute("data-marquee-active"), false);
	env.intersections[0].callback([{ target: oldViewport, isIntersecting: true, intersectionRect: { width: 100, height: 20 } }]);
	env.resizes[0].notify(); controller.refresh(); env.at(5000);
	assert.equal(env.frames.size + env.timers.size, 0);
});

test("real result rows mark only text columns and retain title links, focus and status updates", async () => {
	const calls = [], opened = [];
	const controller = { refresh: () => calls.push("refresh"), refreshCell: cell => calls.push(cell) };
	const ui = uiHarness({ realRows: true, launchURL: url => opened.push(url),
		marquee: { attach: () => { calls.push("attach"); return controller; } },
		search: async () => [paper("result", { title: "An entire title", url: "https://example.test/paper", venue: "A journal", doi: "10.1234/example", authors: [{ name: "A Researcher" }] })] });
	await ui.runSearch();
	const row = ui.get("results-body").firstChild;
	assert.deepEqual(row.children.filter(cell => cell.dataset.marquee).map(cell => cell.dataset.marquee), ["authors", "title", "venue", "doi", "status"]);
	const link = row.querySelector("a"); let prevented = false, stopped = false;
	link.emit("click", { preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
	assert.deepEqual(opened, ["https://example.test/paper"]);
	assert.equal(prevented && stopped, true);
	row.emit("click", { target: row.children[4] });
	assert.equal(ui.state.focusKey, "result");
	ui.setRowStatus(ui.state.records[0], "A complete import status", "ok", "Status details");
	assert.equal(calls.at(-1), row.querySelector("td.status"));
	assert.equal(row.querySelector("td.status").dataset.marquee, "status");
	assert.equal(calls.filter(call => call === "attach").length, 1);
	assert.ok(calls.includes("refresh"));
});

test("automatic text scrolling does not close the source menu but real table scrolling does", () => {
	const ui = uiHarness(), container = mockElement(), select = mockElement("select"), button = mockElement("button"), menu = mockElement();
	button.className = "sel-btn"; button.setAttribute("aria-expanded", "true");
	container.appendChild(select); container.appendChild(button); container.appendChild(menu);
	ui.setOpenSelectForTest({ sel: select, menu });
	const rolling = mockElement("span"); rolling.className = "marquee-text";
	ui.onDocumentScroll({ target: rolling });
	assert.equal(menu.parentNode, container);
	assert.equal(button.getAttribute("aria-expanded"), "true");
	ui.onDocumentScroll({ target: ui.get("table-wrap") });
	assert.equal(menu.parentNode, null);
	assert.equal(button.getAttribute("aria-expanded"), "false");
});

test("the Gecko page loads marquee before UI and exposes measurable motion without CSS animations", () => {
	const script = fs.readFileSync(new URL("../content/marquee.js", import.meta.url), "utf8");
	const context = vm.createContext({}); vm.runInContext(script, context);
	assert.equal(typeof context.ZotPoPMarquee.attach, "function");
	const markup = fs.readFileSync(new URL("../content/search.xhtml", import.meta.url), "utf8");
	assert.ok(markup.indexOf("content/marquee.js") < markup.indexOf("content/ui.js"));
	const css = fs.readFileSync(new URL("../content/search.css", import.meta.url), "utf8");
	assert.match(css, /prefers-reduced-motion:\s*reduce/);
	assert.match(css, /\.marquee-text\s*\{[^}]*overflow:\s*hidden/);
	assert.doesNotMatch(css, /\.marquee[^}]*animation:/);
});

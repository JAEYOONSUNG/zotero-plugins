/* One hover card for the whole window, in place of the native `title` tooltip (a small grey OS box).
   Elements carry `data-tip` (plain text) or `data-tip-kind` (a cell whose card is built from its record,
   on hover); a single delegated listener on the document does the rest, so a thousand rows cost nothing.
   Accessibility is kept: an element with no visible text takes the tip as its name, the others point at the
   card with aria-describedby while it is open. */
var ZotPoPTip = (function () {
	"use strict";
	const DELAY = 350, SWITCH_DELAY = 90, GAP = 8, MARGIN = 8;
	let last = null;

	/* Where the card goes: below the anchor, above it when there is no room below, never over the anchor
	   (so never over the pointer resting on it), aligned near the pointer and clamped inside the window.
	   Pure: rectangles in, a position out. */
	function place({ anchor, size, view, cursor = null, gap = GAP, margin = MARGIN }) {
		let below = view.h - margin - (anchor.bottom + gap), above = anchor.top - gap - margin;
		let side = size.h <= below ? "below" : size.h <= above ? "above" : below >= above ? "below" : "above";
		let room = Math.max(0, side === "below" ? below : above);
		let height = Math.min(size.h, room || size.h);
		let top = side === "below" ? anchor.bottom + gap : anchor.top - gap - height;
		let width = Math.min(size.w, view.w - 2 * margin);
		let wanted = cursor ? cursor.x - 16 : anchor.left;
		let left = Math.max(margin, Math.min(wanted, view.w - margin - width));
		// The card is clear of the anchor, so only a pointer outside the anchor can be under it: step past.
		if (cursor && cursor.x >= left && cursor.x <= left + width && cursor.y >= top && cursor.y <= top + height) {
			top = side === "below" ? cursor.y + 20 : cursor.y - 20 - height;
		}
		return { left: Math.round(left), top: Math.round(Math.max(margin, top)), side, maxHeight: height < size.h ? Math.floor(height) : null };
	}

	function textOf(el) { return (el.textContent || "").replace(/\s+/g, " ").trim(); }

	/* Give an element a tip: the text goes to data-tip and the native title goes away. */
	function set(el, text) {
		if (!el) return;
		text = text == null ? "" : String(text);
		el.removeAttribute("title");
		if (!text) { el.removeAttribute("data-tip"); return; }
		el.setAttribute("data-tip", text);
		let tag = String(el.localName || el.tagName || "").toLowerCase();
		// A field already has its label: the tip describes it. Anything else with no words of its own takes the tip as its name.
		if (tag === "input" || tag === "select" || tag === "textarea") el.setAttribute("aria-description", text.replace(/\s*\n\s*/g, " "));
		else if (!textOf(el) && !el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby")) el.setAttribute("aria-label", text.split("\n")[0]);
	}
	/* A title written by other code (the marquee sets one on a rolling cell) is taken over the first time it is met. */
	function adopt(el) {
		let title = el.getAttribute && el.getAttribute("title");
		if (title == null) return;
		if (title) { if (!el.hasAttribute("data-tip")) set(el, title); else el.removeAttribute("title"); }
		else el.removeAttribute("title");
	}

	function plainNodes(doc, text) {
		let frag = doc.createDocumentFragment();
		String(text).split("\n").forEach((line, i) => {
			let p = doc.createElement("div");
			p.className = i === 0 && String(text).includes("\n") ? "tip-line tip-first" : "tip-line";
			p.textContent = line;
			frag.appendChild(p);
		});
		return frag;
	}

	function attach(win, options = {}) {
		let doc = win.document, root = doc.body || doc;
		let card = doc.createElement("div");
		card.id = "tip-card"; card.className = "tip-card"; card.setAttribute("role", "tooltip"); card.hidden = true;
		root.appendChild(card);
		let timer = null, anchor = null, pointer = null, shown = false, hideTimer = null;
		const delay = options.delay ?? DELAY;
		const clear = id => { if (id != null) win.clearTimeout(id); };

		/* The nearest element to speak for the pointer: a tip of its own beneath a rich cell wins (a chip),
		   a rolling cell's borrowed title does not. */
		function resolve(target) {
			let cell = target.closest ? target.closest("[data-tip-kind]") : null, el = target;
			while (el && el !== doc && el !== root && el.nodeType === 1) {
				adopt(el);
				if (el === cell) break;
				if (el.hasAttribute("data-tip") && !el.hasAttribute("data-marquee")) return { el, kind: null };
				el = el.parentNode;
			}
			if (cell) return { el: cell, kind: cell.getAttribute("data-tip-kind") };
			el = target.closest ? target.closest("[data-tip]") : null;
			return el ? { el, kind: null } : null;
		}
		function content(found) {
			let node = found.kind && options.rich ? options.rich(found.el, found.kind) : null;
			if (node) return typeof node === "string" ? plainNodes(doc, node) : node;
			let text = found.el.getAttribute("data-tip");
			return text ? plainNodes(doc, text) : null;
		}
		function describe(el, on) {
			if (on) el.setAttribute("aria-describedby", card.id); else if (el.getAttribute("aria-describedby") === card.id) el.removeAttribute("aria-describedby");
		}
		function hide() {
			clear(timer); timer = null;
			if (anchor) describe(anchor, false);
			anchor = null;
			if (!shown) return;
			shown = false;
			card.classList.remove("show");
			clear(hideTimer);
			hideTimer = win.setTimeout(() => { if (!shown) { card.hidden = true; card.textContent = ""; } }, 140);
		}
		function show(found, opts = {}) {
			let body = content(found);
			if (!body) { hide(); return null; }
			clear(hideTimer);
			if (anchor && anchor !== found.el) describe(anchor, false);
			anchor = found.el; describe(anchor, true);
			card.textContent = "";
			card.appendChild(body);
			card.hidden = false;
			card.style.maxHeight = ""; card.style.visibility = "hidden";
			let view = opts.view || { w: win.innerWidth, h: win.innerHeight };
			let rect = opts.rect || anchor.getBoundingClientRect();
			let size = opts.size || (() => { let r = card.getBoundingClientRect(); return { w: r.width, h: r.height }; })();
			// A cell marked data-tip-align="start" gets its card under its own left edge, not under the pointer.
			let aligned = anchor.getAttribute && anchor.getAttribute("data-tip-align") === "start";
			let put = place({ anchor: rect, size, view, cursor: aligned ? null : opts.cursor === undefined ? pointer : opts.cursor });
			card.style.left = put.left + "px"; card.style.top = put.top + "px";
			if (put.maxHeight) card.style.maxHeight = put.maxHeight + "px";
			card.setAttribute("data-side", put.side);
			card.style.visibility = "";
			if (opts.immediate) card.classList.add("show");
			else win.setTimeout(() => { if (anchor === found.el) card.classList.add("show"); }, 0);
			shown = true;
			return put;
		}
		function over(e) {
			let found = e.target && e.target.nodeType === 1 ? resolve(e.target) : null;
			if (e.clientX != null) pointer = { x: e.clientX, y: e.clientY };
			if (!found) { if (anchor || timer) hide(); return; }
			if (found.el === anchor) return;
			let wasOpen = shown;
			clear(timer);
			if (shown) hide();
			anchor = found.el;
			timer = win.setTimeout(() => { timer = null; let a = anchor; anchor = null; if (a) show({ el: a, kind: found.kind }); }, wasOpen ? SWITCH_DELAY : delay);
		}
		function out(e) {
			if (!anchor) return;
			let to = e.relatedTarget;
			if (to && anchor.contains && anchor.contains(to)) return;
			hide();
		}
		function focus(e) {
			let found = e.target && e.target.nodeType === 1 ? resolve(e.target) : null;
			clear(timer); timer = null;
			if (!found) { hide(); return; }
			show(found, { cursor: null });
		}
		function key(e) { if (e.key === "Escape" && (shown || timer)) hide(); }
		/* A cell whose text overflows rolls sideways while the pointer rests on it (marquee.js moves its
		   scrollLeft), and that is a scroll event too: the card closed the moment the title began to roll.
		   Only a scroll that moves the anchor itself -- the table, the page -- closes it. */
		function scrolled(e) {
			let t = e.target;
			if (t && t.nodeType === 1 && (t.classList?.contains("marquee-text") || (anchor && anchor.contains && anchor.contains(t)))) return;
			hide();
		}
		const on = (target, name, fn) => target.addEventListener(name, fn, true);
		on(doc, "mouseover", over); on(doc, "mouseout", out); on(doc, "focusin", focus); on(doc, "focusout", hide);
		on(doc, "keydown", key); on(doc, "mousedown", hide); on(doc, "wheel", hide); on(doc, "scroll", scrolled); on(doc, "contextmenu", hide);
		win.addEventListener("blur", hide);
		let api = { card, show: (el, opts) => show({ el, kind: el.getAttribute("data-tip-kind") }, opts), hide, resolve, get open() { return shown; } };
		last = api;
		return api;
	}

	const api = { place, set, adopt, attach, plainNodes, DELAY, current: () => last };
	return api;
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPTip;

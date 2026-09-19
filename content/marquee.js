/* Automatic, visibility-aware reading of overflowing ZotPoP result cells. */
var ZotPoPMarquee = (function () {
	"use strict";
	const controllers = new WeakMap();
	const SELECTOR = "[data-marquee]";
	const ROOT_ATTRIBUTES = ["data-marquee-tracked", "data-marquee-visible", "data-marquee-active", "data-marquee-speed", "data-marquee-motion"];

	function attach(win, root, options = {}) {
		if (controllers.has(root)) return controllers.get(root);
		const doc = root.ownerDocument || win.document;
		const speed = Number.isFinite(options.speed) ? Math.max(20, Math.min(120, options.speed)) : 42;
		const pause = Number.isFinite(options.pause) ? Math.max(0, Math.min(5000, options.pause)) : 1000;
		/* "hover": a cell rolls only while the pointer rests on it, once out and
		   back, then stands still showing its start. A table of twenty rolling
		   cells is unreadable; one, under the pointer, is a request. */
		const mode = options.mode === "hover" ? "hover" : "auto";
		const media = win.matchMedia?.("(prefers-reduced-motion: reduce)");
		const states = new Map(), byViewport = new Map(), visible = new Set(), active = new Set(), removers = [];
		let disposed = false, frame = null, timer = null, blurred = false, pointerDown = false;
		let intersection, resize;
		const now = () => win.performance.now();

		function textSelected() {
			let selection = doc.getSelection?.() || win.getSelection?.();
			return Boolean(selection && !selection.isCollapsed
				&& (root.contains(selection.anchorNode) || root.contains(selection.focusNode)));
		}
		function paused() { return Boolean(media?.matches || doc.hidden || blurred || pointerDown || textSelected()); }
		function current(state) { return state.cell.isConnected && state.viewport.parentNode === state.cell; }
		function cancelScheduled() {
			if (frame !== null) win.cancelAnimationFrame(frame);
			if (timer !== null) win.clearTimeout(timer);
			frame = timer = null;
		}
		function metrics() {
			return {
				tracked: states.size, visible: visible.size, active: paused() ? 0 : active.size,
				speed, pause, mode, reducedMotion: Boolean(media?.matches), paused: paused(),
				pendingFrames: frame === null ? 0 : 1, pendingTimers: timer === null ? 0 : 1,
				cells: [...active].map(state => ({ field: state.cell.dataset.marquee, phase: state.phase,
					distance: state.distance, offset: state.viewport.scrollLeft, text: state.viewport.textContent }))
			};
		}
		function publishMetrics() {
			let stopped = paused();
			root.classList.toggle("marquee-reduced", Boolean(media?.matches));
			root.setAttribute("data-marquee-tracked", states.size);
			root.setAttribute("data-marquee-visible", visible.size);
			root.setAttribute("data-marquee-active", stopped ? 0 : active.size);
			root.setAttribute("data-marquee-speed", speed);
			root.setAttribute("data-marquee-motion", media?.matches ? "reduced" : stopped ? "paused" : active.size ? "running" : "static");
			for (let state of active) state.cell.classList.toggle("marquee-active", !stopped);
		}
		function schedule() {
			if (disposed) return;
			if (!active.size || paused()) { cancelScheduled(); return; }
			if (timer !== null) { win.clearTimeout(timer); timer = null; }
			if (frame === null) frame = win.requestAnimationFrame(tick);
		}
		function position(elapsed, distance) {
			let travel = distance / speed * 1000;
			let time = elapsed % (2 * pause + 2 * travel);
			if (time < pause) return { offset: 0, phase: "start", wait: pause - time };
			time -= pause;
			if (time < travel) return { offset: time / 1000 * speed, phase: "forward", wait: 0 };
			time -= travel;
			if (time < pause) return { offset: distance, phase: "end", wait: pause - time };
			return { offset: distance - (time - pause) / 1000 * speed, phase: "back", wait: 0 };
		}
		function tick(timestamp) {
			frame = null;
			if (disposed || paused()) return;
			let moving = false, wake = Infinity;
			for (let state of [...active]) {
				if (!current(state)) { release(state); continue; }
				if (state.stamp != null) state.elapsed += Math.max(0, timestamp - state.stamp);
				state.stamp = timestamp;
				let next = position(state.elapsed, state.distance);
				state.viewport.scrollLeft = state.direction * Math.max(0, Math.min(state.distance, next.offset));
				if (state.phase !== next.phase) {
					// One pass under the pointer: back at the start, the cell stands still.
					if (mode === "hover" && state.phase === "back" && next.phase === "start") {
						state.done = true; state.viewport.scrollLeft = 0; state.phase = "start"; state.cell.dataset.marqueePhase = "start";
						active.delete(state); state.cell.classList.remove("marquee-active");
						continue;
					}
					state.phase = next.phase;
					state.cell.dataset.marqueePhase = next.phase;
				}
				if (next.wait === 0) moving = true;
				else wake = Math.min(wake, next.wait);
			}
			if (!active.size) { publishMetrics(); return; }
			// One scheduler for the whole table, including shared endpoint pauses.
			if (moving) frame = win.requestAnimationFrame(tick);
			else if (Number.isFinite(wake)) timer = win.setTimeout(() => { timer = null; schedule(); }, Math.max(16, wake));
		}
		function restart(state) {
			state.elapsed = 0;
			state.stamp = paused() ? null : now();
			state.phase = "start";
			state.cell.dataset.marqueePhase = "start";
			state.viewport.scrollLeft = 0;
		}
		function measureState(state) {
			if (!current(state) || !visible.has(state)) return;
			let width = state.viewport.clientWidth, fullWidth = state.viewport.scrollWidth;
			let distance = width > 0 ? Math.max(0, fullWidth - width) : 0;
			let direction = win.getComputedStyle(state.viewport).direction === "rtl" ? -1 : 1;
			if (Math.abs(width - state.width) > 1 || Math.abs(fullWidth - state.fullWidth) > 1 || direction !== state.direction) {
				state.width = width; state.fullWidth = fullWidth; state.direction = direction;
				restart(state);
			}
			state.distance = distance;
			state.cell.classList.toggle("marquee-overflow", distance > 1);
			if (distance > 1 && (mode !== "hover" || (state.hovered && !state.done))) active.add(state);
			else { active.delete(state); state.cell.classList.remove("marquee-active"); state.viewport.scrollLeft = 0; }
		}
		function measure() {
			if (disposed) return;
			for (let state of [...visible]) {
				if (current(state)) measureState(state);
				else release(state);
			}
			publishMetrics();
			schedule();
		}
		function show(state, on) {
			if (on === visible.has(state)) return;
			if (on) {
				visible.add(state);
				resize?.observe(state.viewport);
				restart(state);
				measureState(state);
			}
			else {
				visible.delete(state); active.delete(state);
				resize?.unobserve(state.viewport);
				state.cell.classList.remove("marquee-active");
				restart(state);
			}
		}
		function fallbackVisibility() {
			if (intersection || disposed) return;
			let bounds = root.getBoundingClientRect();
			for (let state of states.values()) {
				let rect = state.viewport.getBoundingClientRect();
				show(state, rect.width > 0 && rect.height > 0 && rect.bottom > bounds.top
					&& rect.top < bounds.bottom && rect.right > bounds.left && rect.left < bounds.right);
			}
			measure();
		}
		function release(state) {
			intersection?.unobserve(state.viewport);
			resize?.unobserve(state.viewport);
			visible.delete(state); active.delete(state);
			states.delete(state.cell); byViewport.delete(state.viewport);
			state.viewport.scrollLeft = 0;
			state.cell.classList.remove("marquee-managed", "marquee-overflow", "marquee-active");
			delete state.cell.dataset.marqueePhase;
			if (state.cell.getAttribute("title") === state.tooltip) {
				if (state.originalTitle == null) state.cell.removeAttribute("title");
				else state.cell.setAttribute("title", state.originalTitle);
			}
			if (current(state)) {
				while (state.viewport.firstChild) state.cell.insertBefore(state.viewport.firstChild, state.viewport);
				state.viewport.remove();
			}
		}
		function track(cell) {
			let old = states.get(cell);
			if (old && current(old)) return;
			if (old) release(old);
			let viewport = doc.createElement("span");
			viewport.className = "marquee-text";
			while (cell.firstChild) viewport.appendChild(cell.firstChild);
			cell.appendChild(viewport);
			let originalTitle = cell.getAttribute("title"), text = viewport.textContent.trim();
			let tooltip = originalTitle && originalTitle.includes(text) ? originalTitle : [text, originalTitle].filter(Boolean).join("\n");
			if (tooltip) cell.setAttribute("title", tooltip);
			cell.classList.add("marquee-managed");
			let state = { cell, viewport, originalTitle, tooltip, width: 0, fullWidth: 0, distance: 0,
				direction: 1, elapsed: 0, stamp: null, phase: "start", hovered: false, done: false };
			states.set(cell, state); byViewport.set(viewport, state);
			intersection?.observe(viewport);
		}
		function refresh() {
			if (disposed) return;
			let cells = new Set(root.querySelectorAll(SELECTOR));
			for (let state of [...states.values()]) if (!cells.has(state.cell) || !current(state)) release(state);
			for (let cell of cells) track(cell);
			fallbackVisibility();
			publishMetrics();
			schedule();
		}
		function refreshCell(cell) {
			if (disposed) return;
			if (cell.isConnected && root.contains(cell) && cell.hasAttribute("data-marquee")) track(cell);
			else if (states.has(cell)) release(states.get(cell));
			fallbackVisibility();
			publishMetrics();
			schedule();
		}
		function motionChange() {
			cancelScheduled();
			for (let state of active) {
				if (media?.matches) restart(state);
				state.stamp = paused() ? null : now();
			}
			publishMetrics();
			schedule();
		}
		function listen(target, name, fn, capture = false) {
			if (!target?.addEventListener) return;
			target.addEventListener(name, fn, { passive: true, capture });
			removers.push(() => target.removeEventListener(name, fn, capture));
		}
		function cleanup() {
			if (disposed) return;
			disposed = true;
			cancelScheduled();
			intersection?.disconnect(); resize?.disconnect();
			for (let state of [...states.values()]) release(state);
			for (let remove of removers) remove();
			for (let attribute of ROOT_ATTRIBUTES) root.removeAttribute(attribute);
			root.classList.remove("marquee-reduced");
			controllers.delete(root);
		}

		if (win.ResizeObserver) {
			resize = new win.ResizeObserver(() => measure());
			resize.observe(root);
		}
		if (win.IntersectionObserver) {
			intersection = new win.IntersectionObserver(entries => {
				if (disposed) return;
				for (let entry of entries) {
					let state = byViewport.get(entry.target);
					if (state) show(state, entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0);
				}
				publishMetrics(); schedule();
			}, { root, threshold: 0 });
		}
		if (mode === "hover") {
			const cellOf = target => (target && target.closest ? target.closest(SELECTOR) : null);
			listen(root, "mouseover", event => {
				let cell = cellOf(event.target), state = cell && states.get(cell);
				if (!state || state.hovered) return;
				state.hovered = true; state.done = false;
				restart(state); if (visible.has(state)) measureState(state);
				publishMetrics(); schedule();
			});
			listen(root, "mouseout", event => {
				let cell = cellOf(event.target), state = cell && states.get(cell);
				if (!state || (event.relatedTarget && cell.contains(event.relatedTarget))) return;
				state.hovered = false; state.done = false;
				active.delete(state); state.cell.classList.remove("marquee-active"); restart(state);
				publishMetrics(); schedule();
			});
		}
		listen(root, "scroll", fallbackVisibility);
		listen(root, "mousedown", () => { pointerDown = true; motionChange(); }, true);
		listen(doc, "mouseup", () => { pointerDown = false; motionChange(); }, true);
		listen(doc, "selectionchange", motionChange);
		listen(doc, "visibilitychange", motionChange);
		listen(win, "blur", () => { blurred = true; pointerDown = false; motionChange(); });
		listen(win, "focus", () => { blurred = false; motionChange(); });
		listen(win, "resize", () => { fallbackVisibility(); measure(); });
		listen(win, "unload", cleanup);
		listen(media, "change", motionChange);
		listen(doc.fonts, "loadingdone", measure);
		doc.fonts?.ready?.then(() => { if (!disposed) measure(); }).catch(() => {});
		const controller = { refresh, refreshCell, measure, cleanup, getMetrics: metrics };
		controllers.set(root, controller);
		refresh();
		return controller;
	}

	return { attach, getMetrics: root => controllers.get(root)?.getMetrics() || null };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPMarquee;

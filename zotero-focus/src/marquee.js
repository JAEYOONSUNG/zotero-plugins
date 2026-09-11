/* Read overflowing item titles without changing Zotero's row or title markup. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ZoteroFocusMarquee = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_DELAY = 200;
  const DEFAULT_SPEED = 180;
  const END_PAUSE = 900;
  const REPEAT_PAUSE = 400;

  function finiteOption(value, fallback, min, max) {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(min, Math.min(max, value)) : fallback;
  }

  /**
   * Attach once per main window. Calling the returned function disables scrolling
   * and restores the currently hovered cell. getOptions is optional and may return
   * { enabled, delay, speed }; an enabled:false value also stops an active roll.
   */
  function attach(window, options = {}) {
    const document = window.document;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const listeners = [];
    let active = null;
    let disposed = false;
    let frame = null;
    let observer = null;

    function settings() {
      const current = typeof options.getOptions === "function"
        ? { ...options, ...options.getOptions() } : options;
      return {
        enabled: current.enabled !== false,
        delay: finiteOption(current.delay, DEFAULT_DELAY, 0, 5000),
        speed: finiteOption(current.speed, DEFAULT_SPEED, 20, 2000)
      };
    }

    function titleCell(target) {
      const element = target?.nodeType === 1 ? target : target?.parentElement;
      const cell = element?.closest?.(".cell.title");
      if (!cell || !cell.closest(".row") || !cell.closest(".virtualized-table")
          || !cell.closest("#zotero-items-tree")) return null;
      return cell;
    }

    function isCurrent(state) {
      return state.text.isConnected && titleCell(state.text) === state.cell
        && state.cell.querySelector(".cell-text") === state.text
        && state.text.textContent === state.content;
    }

    function reset() {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      observer?.disconnect();
      observer = null;
      const state = active;
      active = null;
      if (!state) return;
      state.text.scrollLeft = state.originalScroll;
      if (state.clipped && state.text.style.getPropertyValue("text-overflow") === "clip") {
        if (state.originalOverflow) {
          state.text.style.setProperty("text-overflow", state.originalOverflow, state.overflowPriority);
        } else {
          state.text.style.removeProperty("text-overflow");
        }
      }
      // Do not undo another renderer's tooltip change while a row is recycled.
      if (state.cell.getAttribute("title") === state.content) {
        if (state.originalTitle === null) state.cell.removeAttribute("title");
        else state.cell.setAttribute("title", state.originalTitle);
      }
    }

    function tick(now) {
      frame = null;
      const state = active;
      if (!state) return;
      if (!isCurrent(state) || !settings().enabled || reducedMotion.matches
          || Math.abs(state.text.clientWidth - state.width) > 1
          || Math.abs(state.text.scrollWidth - state.fullWidth) > 1) {
        reset();
        return;
      }
      const elapsed = now - state.started;
      if (elapsed >= state.delay) {
        if (!state.clipped) {
          state.text.style.setProperty("text-overflow", "clip", "important");
          state.clipped = true;
        }
        const movementTime = elapsed - state.delay;
        const duration = state.distance / state.speed * 1000;
        state.text.scrollLeft = state.direction * Math.min(state.distance, movementTime / 1000 * state.speed);
        if (movementTime >= duration + END_PAUSE) {
          state.text.scrollLeft = 0;
          state.started = now;
          state.delay = REPEAT_PAUSE;
        }
      }
      frame = window.requestAnimationFrame(tick);
    }

    function begin(cell) {
      if (disposed) return;
      if (active?.cell === cell && isCurrent(active)) return;
      reset();
      if (!cell) return;
      const config = settings();
      if (!config.enabled) return;
      const text = cell.querySelector(".cell-text");
      if (!text || text.clientWidth <= 0 || text.scrollWidth - text.clientWidth <= 1) return;
      const content = text.textContent;
      if (!content.trim()) return;
      active = {
        cell, text, content,
        width: text.clientWidth,
        fullWidth: text.scrollWidth,
        distance: text.scrollWidth - text.clientWidth,
        direction: window.getComputedStyle(text).direction === "rtl" ? -1 : 1,
        originalScroll: text.scrollLeft,
        originalTitle: cell.getAttribute("title"),
        originalOverflow: text.style.getPropertyValue("text-overflow"),
        overflowPriority: text.style.getPropertyPriority("text-overflow"),
        clipped: false,
        started: window.performance.now(),
        delay: config.delay,
        speed: config.speed
      };
      cell.setAttribute("title", content);
      // Observe only while hovering. Zotero replaces cell children when reusing a
      // virtualized row, even when the mouse has not moved to generate mouseout.
      observer = new window.MutationObserver(() => {
        if (active && !isCurrent(active)) reset();
      });
      observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
      if (!reducedMotion.matches) frame = window.requestAnimationFrame(tick);
    }

    function onHover(event) {
      if (event.buttons) {
        reset();
        return;
      }
      begin(titleCell(event.target));
    }

    function onLeave(event) {
      if (active && titleCell(event.relatedTarget) !== active.cell) reset();
    }

    function onScroll(event) {
      // Updating scrollLeft dispatches scroll events; those are our own animation.
      if (active && event.target !== active.text) reset();
    }

    function onMotionChange() {
      const cell = active?.cell;
      reset();
      if (cell?.isConnected) begin(cell);
    }

    function listen(target, name, callback, capture = false) {
      target.addEventListener(name, callback, { capture, passive: true });
      listeners.push(() => target.removeEventListener(name, callback, capture));
    }

    function cleanup() {
      if (disposed) return;
      disposed = true;
      reset();
      for (const remove of listeners) remove();
      listeners.length = 0;
    }

    listen(document, "mouseover", onHover);
    listen(document, "mousemove", onHover);
    listen(document, "mouseout", onLeave);
    listen(document, "scroll", onScroll, true);
    listen(document, "mousedown", reset, true);
    listen(document, "dragstart", reset, true);
    listen(document, "visibilitychange", reset);
    listen(window, "blur", reset);
    listen(window, "resize", reset);
    listen(window, "unload", cleanup);
    listen(reducedMotion, "change", onMotionChange);
    return cleanup;
  }

  return Object.freeze({ attach });
});

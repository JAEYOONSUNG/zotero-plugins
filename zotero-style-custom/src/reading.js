/* Original active-reading clock. Persistence is supplied by the plugin owner. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CustomStyleReading = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const IDLE_MS = 60000;
  function attach(window, options = {}) {
    if (typeof options.onTick !== 'function') throw new TypeError('onTick is required');
    const now = options.now || (() => window.performance.now());
    const interval = Number.isFinite(options.intervalMs)
      ? Math.max(250, Math.min(5000, options.intervalMs)) : 1000;
    const idle = Number.isFinite(options.idleMs) ? Math.max(5000, Math.min(300000, options.idleMs)) : IDLE_MS;
    const maxGap = Math.min(5000, interval * 2);
    let disposed = false;
    let current = null;
    let previousLocation = null;
    let previous = now();
    let lastActivity = -Infinity;
    let chain = Promise.resolve();
    const bound = new Map();
    function report(error) { try { options.onError?.(error); } catch (_) {} }
    function resolveReader() {
      if (window.closed || window.document.hidden || !window.document.hasFocus()) return null;
      const manager = window.Zotero?.Reader;
      let reader;
      if (window.Zotero_Tabs) reader = manager?.getByTabID(window.Zotero_Tabs.selectedID);
      else reader = manager?._readers?.find(value => value._window === window);
      if (!reader || reader._window !== window || reader.type !== 'pdf') return null;
      const attachment = window.Zotero.Items.get(reader.itemID);
      if (!attachment) return null;
      const item = attachment.parentID ? window.Zotero.Items.get(attachment.parentID) : attachment;
      return item ? { reader, item } : null;
    }
    function locationOf(reader) {
      const internal = reader?._internalReader;
      const secondary = internal?._lastViewPrimary === false && internal?._secondaryView;
      const stats = internal?._state?.[secondary ? 'secondaryViewStats' : 'primaryViewStats'];
      const page = stats?.pageIndex, total = stats?.pagesCount;
      return Object.freeze({
        pageIndex: Number.isInteger(page) && page >= 0 && (!Number.isInteger(total) || total <= 0 || page < total) ? page : null,
        totalPages: Number.isInteger(total) && total > 0 ? total : null,
        attachmentID: reader?.itemID ?? null
      });
    }
    function activity(event) {
      if (disposed || event.isTrusted === false) return;
      try {
        const active = resolveReader();
        if (!active) return;
        const time = now();
        // Activity after idle/focus/tab changes starts a new interval, never backfills it.
        if (current?.reader !== active.reader || time - lastActivity >= idle) {
          // Baseline foreign history once, before the first measured interval.
          // The callback must be synchronous; persistence remains in onTick.
          previousLocation = locationOf(active.reader);
          options.onSession?.(active.item, previousLocation);
          previous = time;
        }
        current = active;
        lastActivity = time;
      } catch (error) { report(error); }
    }
    function collectFrames(frame, targets) {
      if (!frame || targets.has(frame)) return;
      targets.add(frame);
      try {
        for (let i = 0; i < frame.frames.length; i++) collectFrames(frame.frames[i], targets);
      } catch (_) { /* Cross-origin frames cannot be observed. */ }
    }
    function syncListeners(active) {
      const targets = new Set();
      // Observe PDF documents and nested primary/secondary PDF view frames; events
      // inside an iframe do not bubble to the Zotero chrome document.
      if (active) collectFrames(active.reader._iframeWindow, targets);
      for (const [target, remove] of bound) {
        if (!targets.has(target)) { remove(); bound.delete(target); }
      }
      for (const target of targets) {
        if (bound.has(target)) continue;
        const names = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'];
        try {
          for (const name of names) target.addEventListener(name, activity, { capture: true, passive: true });
          bound.set(target, () => {
            for (const name of names) {
              try { target.removeEventListener(name, activity, true); } catch (_) {}
            }
          });
        } catch (_) { /* A closed frame is retried on the next sample. */ }
      }
    }
    function credit(time, active) {
      if (!active || time <= previous) return;
      const elapsed = Math.max(0, Math.min(time, lastActivity + idle) - previous);
      // A suspended process can wake hours later. Credit at most a small sample.
      const seconds = Math.min(elapsed, maxGap) / 1000;
      if (seconds > 0) {
        const item = active.item;
        const location = previousLocation || locationOf(active.reader);
        chain = chain.then(() => options.onTick(item, seconds, location)).catch(report);
      }
    }
    function sample() {
      if (disposed) return;
      try {
        const time = now();
        const active = resolveReader();
        syncListeners(active);
        const gap = time - previous;
        if (active && current?.reader === active.reader) credit(time, active);
        if (current?.reader !== active?.reader || gap < 0 || !active) lastActivity = -Infinity;
        current = active;
        previousLocation = active ? locationOf(active.reader) : null;
        previous = time;
      } catch (error) { previous = now(); current = null; lastActivity = -Infinity; report(error); }
    }
    function inactive() {
      if (disposed) return;
      credit(now(), current);
      // Don't infer activity from focus alone or from a selected library item.
      current = null;
      previousLocation = null;
      previous = now();
      lastActivity = -Infinity;
      syncListeners(null);
    }
    function cleanup() {
      if (disposed) return chain;
      credit(now(), current);
      disposed = true;
      window.clearInterval(timer);
      syncListeners(null);
      window.removeEventListener('blur', inactive);
      window.document.removeEventListener('visibilitychange', inactive);
      window.removeEventListener('unload', cleanup);
      return chain;
    }
    const timer = window.setInterval(sample, interval);
    window.addEventListener('blur', inactive);
    window.document.addEventListener('visibilitychange', inactive);
    window.addEventListener('unload', cleanup);
    sample();
    return cleanup;
  }
  return Object.freeze({ attach });
});

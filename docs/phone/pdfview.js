/* The PDF on the screen.

   pdf.js does the decoding; this file decides what is drawn and when. A phone cannot hold a
   hundred rendered pages, so every page gets a frame of the right shape straight away — the
   scrollbar is honest from the first moment — and only the pages near the window carry a canvas.
   A page that scrolls far away gives its canvas back.

   The arithmetic is kept out of the drawing (fitScale, nearestPage, nearby) so it is checked
   without a canvas. */

export const MAX_PIXELS = 4e6;   // one page's canvas, about an A4 at 200dpi: iOS gives up well above this
export const ZOOMS = [1, 1.25, 1.5, 2, 3];
export const ZOOM_MIN = 1, ZOOM_MAX = 5;

export const clampZoom = value => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(value) || ZOOM_MIN));

/* Two fingers: how far apart they are now against how far apart they started. */
export const pinchZoom = (startZoom, startGap, gap) =>
  (!startGap || !gap ? clampZoom(startZoom) : clampZoom(startZoom * (gap / startGap)));
export const fingerGap = touches => {
  if (!touches || touches.length < 2) return 0;
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
};

/* A second tap in the same place, soon enough after the first, means zoom here. */
export function isDoubleTap(previous, tap, {within = 320, slop = 36} = {}) {
  if (!previous) return false;
  return tap.at - previous.at < within &&
         Math.abs(tap.x - previous.x) < slop && Math.abs(tap.y - previous.y) < slop;
}

/* The scale to draw a page at: fit its width to the column, times the reader's zoom, times the
   phone's pixel density — then pulled back if that would make a canvas too large to hold. */
export function fitScale(viewport, width, {zoom = 1, density = 1, maxPixels = MAX_PIXELS} = {}) {
  const base = (width * zoom) / viewport.width;
  const scale = base * Math.min(density, 2);
  const pixels = viewport.width * scale * viewport.height * scale;
  const capped = pixels > maxPixels ? scale * Math.sqrt(maxPixels / pixels) : scale;
  return {css: base, canvas: Math.max(0.1, capped)};
}

/* The page the reader is looking at: the one covering the middle of the window. */
export function nearestPage(tops, scrollTop, height) {
  if (!tops.length) return 1;
  const eye = scrollTop + height * 0.4;
  let at = 1;
  for (let i = 0; i < tops.length; i++) if (tops[i] <= eye) at = i + 1;
  return at;
}

/* Which pages are worth holding a canvas for. */
export function nearby(page, total, reach = 1) {
  const out = [];
  for (let n = Math.max(1, page - reach); n <= Math.min(total, page + reach); n++) out.push(n);
  return out;
}

export function createViewer({root, pdfjs, onPage = () => {}, onStatus = () => {}, onZoom = () => {},
                              maxPixels = MAX_PIXELS} = {}) {
  if (!root) throw new Error('a root is required');
  let doc = null, frames = [], zoom = 1, page = 1, width = 0, density = 1, dead = false;
  const drawn = new Map();   // page number -> {canvas, task, scale}

  const measure = () => {
    width = Math.max(120, root.clientWidth || root.offsetWidth || 320);
    density = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
  };

  async function layout() {
    root.textContent = '';
    frames = [];
    measure();
    for (let n = 1; n <= doc.numPages; n++) {
      const view = await doc.getPage(n).then(p => p.getViewport({scale: 1}));
      const frame = document.createElement('div');
      frame.className = 'pdf-page';
      frame.dataset.page = String(n);
      // The shape is known before anything is drawn, so nothing jumps once it is.
      frame.style.aspectRatio = `${view.width} / ${view.height}`;
      root.appendChild(frame);
      frames.push({n, frame, view});
    }
  }

  async function draw(n) {
    const slot = frames[n - 1];
    if (!slot || dead) return;
    const {css, canvas: scale} = fitScale(slot.view, width, {zoom, density, maxPixels});
    const held = drawn.get(n);
    if (held && Math.abs(held.scale - scale) < 0.01) return;
    release(n);
    const pageObject = await doc.getPage(n);
    if (dead) return;
    const viewport = pageObject.getViewport({scale});
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    const task = pageObject.render({canvasContext: canvas.getContext('2d', {alpha: false}), viewport});
    drawn.set(n, {canvas, task, scale});
    try {
      await task.promise;
      if (dead) return;
      slot.frame.textContent = '';
      slot.frame.appendChild(canvas);
      slot.frame.classList.add('ready');
    } catch (error) {
      if (!/cancel/i.test(String(error && error.message))) onStatus({type: 'error', error});
    }
    void css;
  }

  function release(n) {
    const held = drawn.get(n);
    if (!held) return;
    try { held.task.cancel(); } catch (_) {}
    held.canvas.width = held.canvas.height = 0;   // iOS only frees canvas memory when it is emptied
    drawn.delete(n);
    const slot = frames[n - 1];
    if (slot) { slot.frame.textContent = ''; slot.frame.classList.remove('ready'); }
  }

  /* Everything on screen thrown away and drawn again — after a zoom, where every canvas is now
     the wrong size. */
  function redraw() { for (const n of [...drawn.keys()]) release(n); look(); }

  function keep(list) {
    const wanted = new Set(list);
    for (const n of [...drawn.keys()]) if (!wanted.has(n)) release(n);
    for (const n of list) draw(n);
  }

  const look = () => {
    if (!doc || !frames.length) return;
    const tops = frames.map(f => f.frame.offsetTop);
    const at = nearestPage(tops, root.scrollTop, root.clientHeight || 0);
    keep(nearby(at, frames.length));
    if (at !== page) { page = at; onPage(page, frames.length); }
  };

  let waiting = false;
  const onScroll = () => {
    if (waiting) return;
    waiting = true;
    requestAnimationFrame(() => { waiting = false; look(); });
  };
  root.addEventListener('scroll', onScroll, {passive: true});

  /* ---- the fingers ---- */
  let pinch = null, lastTap = null, settle = null;
  const onTouchStart = event => {
    if (event.touches && event.touches.length === 2) {
      pinch = {gap: fingerGap(event.touches), zoom};
      clearTimeout(settle);
    }
  };
  const onTouchMove = event => {
    if (!pinch || !event.touches || event.touches.length !== 2) return;
    event.preventDefault();
    api.setZoom(pinchZoom(pinch.zoom, pinch.gap, fingerGap(event.touches)), {draw: false});
  };
  const onTouchEnd = event => {
    if (pinch && (!event.touches || event.touches.length < 2)) {
      pinch = null;
      // Drawn again once the fingers have settled, so a wobble does not start a render each frame.
      clearTimeout(settle);
      settle = setTimeout(redraw, 140);
      return;
    }
    const touch = event.changedTouches && event.changedTouches[0];
    if (!touch || (event.touches && event.touches.length)) return;
    const tap = {at: Date.now(), x: touch.clientX, y: touch.clientY};
    if (isDoubleTap(lastTap, tap)) { api.setZoom(zoom > 1.01 ? 1 : 2); lastTap = null; }
    else lastTap = tap;
  };
  root.addEventListener('touchstart', onTouchStart, {passive: true});
  root.addEventListener('touchmove', onTouchMove, {passive: false});
  root.addEventListener('touchend', onTouchEnd, {passive: true});

  const api = {
    async open(bytes, options = {}) {
      onStatus({type: 'loading'});
      const task = pdfjs.getDocument({data: bytes, ...options});
      doc = await task.promise;
      if (dead) return 0;
      await layout();
      page = 1;
      onPage(1, doc.numPages);
      onStatus({type: 'ready', pages: doc.numPages});
      look();
      return doc.numPages;
    },
    goto(n) {
      const slot = frames[Math.max(1, Math.min(frames.length, Math.round(Number(n) || 1))) - 1];
      if (!slot) return page;
      try { slot.frame.scrollIntoView({block: 'start', behavior: 'smooth'}); }
      catch (_) { root.scrollTop = slot.frame.offsetTop; }
      look();
      return page;
    },
    /* One step along the named sizes from wherever a pinch happened to leave it. */
    zoomBy(step) {
      const above = ZOOMS.findIndex(z => z > zoom + 0.001);
      const next = step > 0
        ? (above < 0 ? ZOOMS[ZOOMS.length - 1] : ZOOMS[above])
        : ZOOMS[Math.max(0, (above < 0 ? ZOOMS.length : above) - 2)];
      return api.setZoom(next ?? zoom);
    },
    /* The page grows at once — the canvas it already has is simply stretched — and is drawn again
       sharp a moment later, so a pinch follows the fingers instead of waiting for the renderer. */
    setZoom(value, {draw = true} = {}) {
      const next = clampZoom(value);
      if (Math.abs(next - zoom) < 0.001 && draw) return zoom;
      zoom = next;
      root.style.setProperty('--pdf-zoom', String(zoom));
      onZoom(zoom);
      if (draw) redraw();
      return zoom;
    },
    get zoom() { return zoom; },
    page: () => page,
    pages: () => frames.length,
    resize() { measure(); redraw(); },
    destroy() {
      dead = true;
      clearTimeout(settle);
      root.removeEventListener('scroll', onScroll);
      root.removeEventListener('touchstart', onTouchStart);
      root.removeEventListener('touchmove', onTouchMove);
      root.removeEventListener('touchend', onTouchEnd);
      for (const n of [...drawn.keys()]) release(n);
      try { doc && doc.destroy(); } catch (_) {}
      doc = null; frames = []; root.textContent = '';
    }
  };
  return api;
}

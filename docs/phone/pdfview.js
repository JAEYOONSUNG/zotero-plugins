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

/* Where to be after a zoom. The page the reader was on and the share of it they were down, not a
   number of pixels — every pixel means something else at the new zoom. Across the page the middle
   of the view is kept, so zooming in on the right-hand column does not throw the reader back to
   the left margin, which is what left-aligned pages would otherwise do. */
export function afterZoom({down = 0, across = 0, pageTop = 0, pageHeight = 1, viewWidth = 0, ratio = 1} = {}) {
  return {
    top: Math.max(0, pageTop + down * pageHeight),
    left: Math.max(0, across * ratio - viewWidth / 2)
  };
}

/* Which pages are worth holding a canvas for. */
export function nearby(page, total, reach = 1) {
  const out = [];
  for (let n = Math.max(1, page - reach); n <= Math.min(total, page + reach); n++) out.push(n);
  return out;
}

/* Where a mark made in Zotero falls on the page, as a share of the page rather than as pixels,
   so it stays put through every zoom without being worked out again.

   Zotero keeps a mark in PDF user space, whose origin is the BOTTOM left; the screen's is the top
   left. pdf.js knows how to turn one into the other, rotated pages included, and when it is not
   there to ask the flip is done by hand. */
export function markRects(view, rects) {
  const out = [];
  const width = (view && view.width) || 0, height = (view && view.height) || 0;
  if (!width || !height) return out;
  for (const rect of rects || []) {
    if (!rect || rect.length < 4) continue;
    let [x1, y1, x2, y2] = rect.map(Number);
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    let box;
    if (view.convertToViewportRectangle) {
      const flat = view.convertToViewportRectangle([x1, y1, x2, y2]);
      box = [Math.min(flat[0], flat[2]), Math.min(flat[1], flat[3]),
             Math.max(flat[0], flat[2]), Math.max(flat[1], flat[3])];
    } else {
      box = [Math.min(x1, x2), height - Math.max(y1, y2), Math.max(x1, x2), height - Math.min(y1, y2)];
    }
    const left = (box[0] / width) * 100, top = (box[1] / height) * 100;
    const w = ((box[2] - box[0]) / width) * 100, h = ((box[3] - box[1]) / height) * 100;
    if (w <= 0 || h <= 0) continue;
    out.push({left, top, width: w, height: h});
  }
  return out;
}

/* Zotero stores a mark's place as a JSON string; a damaged one is simply not drawn. */
export function markPlace(annotation) {
  const data = (annotation && annotation.data) || annotation || {};
  let place = data.annotationPosition;
  if (typeof place === 'string') { try { place = JSON.parse(place); } catch (_) { place = null; } }
  if (!place || !Array.isArray(place.rects)) return null;
  return {
    page: Number(place.pageIndex || 0) + 1,
    rects: place.rects,
    colour: String(data.annotationColor || '#ffd400'),
    kind: String(data.annotationType || 'highlight'),
    text: String(data.annotationText || data.annotationComment || '')
  };
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
      paintMarks(slot);
      slot.frame.classList.add('ready');
    } catch (error) {
      if (!/cancel/i.test(String(error && error.message))) onStatus({type: 'error', error});
    }
    void css;
  }

  /* The reader's own marks, laid over the page. They are shares of the page, so they need no
     redrawing when it is zoomed — only when the page itself is drawn again. */
  let marks = new Map();
  function paintMarks(slot) {
    const mine = marks.get(slot.n);
    if (!mine || !mine.length) return;
    const layer = document.createElement('div');
    layer.className = 'pdf-marks';
    for (const mark of mine) {
      for (const box of markRects(slot.view, mark.rects)) {
        const bit = document.createElement('div');
        bit.className = `pdf-mark ${mark.kind === 'underline' ? 'underline' : 'highlight'}`;
        bit.style.cssText = `left:${box.left}%;top:${box.top}%;width:${box.width}%;height:${box.height}%;--mark:${mark.colour}`;
        if (mark.text) bit.title = mark.text.slice(0, 120);
        layer.appendChild(bit);
      }
    }
    if (layer.childNodes.length) slot.frame.appendChild(layer);
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
      const was = zoom;
      // Where the reader is, before the pixels mean something else.
      const slot = draw ? frames[page - 1] : null;
      const held = slot ? {
        down: ((root.scrollTop || 0) - (slot.frame.offsetTop || 0)) / (slot.frame.offsetHeight || 1),
        across: (root.scrollLeft || 0) + (root.clientWidth || 0) / 2
      } : null;
      zoom = next;
      root.style.setProperty('--pdf-zoom', String(zoom));
      onZoom(zoom);
      if (draw) redraw();
      if (held && slot) {
        const back = afterZoom({...held, pageTop: slot.frame.offsetTop || 0,
                                pageHeight: slot.frame.offsetHeight || 1,
                                viewWidth: root.clientWidth || 0, ratio: next / (was || 1)});
        root.scrollTop = back.top;
        root.scrollLeft = back.left;
      }
      return zoom;
    },
    get zoom() { return zoom; },
    /* Given the annotations as Zotero holds them; the pages already drawn take them at once. */
    setMarks(annotations) {
      marks = new Map();
      for (const row of annotations || []) {
        const place = markPlace(row);
        if (!place || !place.rects.length) continue;
        if (!marks.has(place.page)) marks.set(place.page, []);
        marks.get(place.page).push(place);
      }
      for (const slot of frames) {
        const layer = slot.frame.querySelector('.pdf-marks');
        if (layer) layer.remove();
        if (slot.frame.classList.contains('ready')) paintMarks(slot);
      }
      return marks.size;
    },
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

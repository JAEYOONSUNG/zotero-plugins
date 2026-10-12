/* The PDF on the screen.

   pdf.js does the decoding; this file decides what is drawn and when. A phone cannot hold a
   hundred rendered pages, so every page gets a frame of the right shape straight away — the
   scrollbar is honest from the first moment — and only the pages near the window carry a canvas.
   A page that scrolls far away gives its canvas back.

   The arithmetic is kept out of the drawing (fitScale, nearestPage, nearby) so it is checked
   without a canvas. */

export const MAX_PIXELS = 4e6;   // one page's canvas, about an A4 at 200dpi: iOS gives up well above this
export const ZOOMS = [1, 1.25, 1.5, 2, 3];

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

export function createViewer({root, pdfjs, onPage = () => {}, onStatus = () => {}, maxPixels = MAX_PIXELS} = {}) {
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

  return {
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
    zoomBy(step) {
      const at = ZOOMS.indexOf(zoom);
      const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (at < 0 ? 0 : at) + step))];
      if (next === zoom) return zoom;
      zoom = next;
      root.style.setProperty('--pdf-zoom', String(zoom));
      for (const n of [...drawn.keys()]) release(n);
      look();
      return zoom;
    },
    get zoom() { return zoom; },
    page: () => page,
    pages: () => frames.length,
    resize() { measure(); for (const n of [...drawn.keys()]) release(n); look(); },
    destroy() {
      dead = true;
      root.removeEventListener('scroll', onScroll);
      for (const n of [...drawn.keys()]) release(n);
      try { doc && doc.destroy(); } catch (_) {}
      doc = null; frames = []; root.textContent = '';
    }
  };
}

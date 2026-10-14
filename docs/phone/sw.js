/* The app shell, so 논문 opens with no signal. The library itself lives in IndexedDB, and every
   request to api.zotero.org goes to the network: a cached answer would show a stale library. */
const CACHE = 'nonmun-v14';
const SHELL = ['./', 'index.html', 'app.css', 'app.js',
               'read.js', 'play.js', 'files.js', 'pdfview.js', 'list.js', 'net.js', 'i18n.js', 'en.js',
               'manifest.webmanifest', 'icon-192.png?v=3', 'icon-512.png?v=3', 'icon-180.png?v=3'];
/* pdf.js and its fonts are not fetched until a PDF is opened; the handler below keeps whatever
   was fetched, so the second time a paper is opened it needs no signal either. */

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(names => Promise.all(names.filter(name => name !== CACHE).map(name => caches.delete(name))))
    .then(() => self.clients.claim()));
});
/* pdf.js and its fonts never change under their own names; everything else must not go stale. */
const IMMUTABLE = /\/vendor\//;
const SLOW = 2500;

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  event.respondWith((async () => {
    const held = await caches.match(event.request);
    if (IMMUTABLE.test(url.pathname) && held) return held;
    /* The app itself is fetched fresh whenever there is signal, so a new version lands the next
       time 논문 is opened rather than the time after that. A slow or absent signal falls back to
       what this phone already has, which is the whole point of keeping it. */
    const live = fetch(event.request).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
      return response;
    });
    if (!held) return live;
    const patience = new Promise(resolve => setTimeout(() => resolve(null), SLOW));
    const quick = await Promise.race([live.catch(() => null), patience]);
    return quick || held;
  })());
});

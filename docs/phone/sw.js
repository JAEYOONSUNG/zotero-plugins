/* The app shell, so 논문 opens with no signal. The library itself lives in IndexedDB, and every
   request to api.zotero.org goes to the network: a cached answer would show a stale library. */
const CACHE = 'nonmun-v3';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'read.js', 'play.js', 'files.js', 'pdfview.js',
               'manifest.webmanifest', 'icon-192.png?v=2', 'icon-512.png?v=2', 'icon-180.png?v=2'];
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
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  // The shell is served from the cache and refreshed in the background, so an update lands on the next open.
  event.respondWith(caches.match(event.request).then(hit => {
    const live = fetch(event.request).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
      return response;
    }).catch(() => hit);
    return hit || live;
  }));
});

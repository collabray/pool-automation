// Service worker: caches the app shell (never API responses or anything with money in it) so the app opens instantly and shows an offline notice.
const CACHE = 'pool-shell-v1';
const SHELL = ['/owner.html', '/owner.js', '/app.css', '/lib/dom.js', '/lib/api.js', '/lib/format.js', '/lib/i18n.js', '/manifest.webmanifest', '/icons/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return; // API always goes to the network
  e.respondWith(fetch(e.request).then((r) => { if (r.ok && SHELL.includes(u.pathname)) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; }).catch(() => caches.match(e.request)));
});

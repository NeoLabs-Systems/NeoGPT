/* NeoGPT Service Worker */
const CACHE = 'NeoGPT-v1';
const STATIC = [
  '/css/app.css',
  '/css/login.css',
  '/js/app.js',
  '/js/login.js',
  '/manifest.json',
  '/icon.svg',
];

/* ── Install: cache static shell ──────────────────── */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

/* ── Activate: clean old caches ───────────────────── */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* ── Fetch: network-first for API/SSE, cache-first for assets ── */
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Always go to network for API (SSE streaming must bypass cache)
  if (url.pathname.startsWith('/api/')) return;

  // Network-first for HTML pages (ensures fresh shells)
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for CSS/JS/fonts/images
  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
    )
  );
});

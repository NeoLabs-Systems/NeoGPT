/* NeoGPT — Service Worker (caching disabled) */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e =>
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )/* NeoNote — Service Worker (caching disables self.addEventListener('install', () => self.skipWaisself.addEventListener('activate', e =>
  e.waitUntil(
    Wa  e.waitUntil(
    caches.keys().thenva    caches.ke.w      .then(() => self.clients.claim())
  )
);

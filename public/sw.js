const CACHE_NAME = 'mbg-ledger-shell-v2';
const STATIC_SHELL_ASSETS = new Set(['/manifest.webmanifest', '/icon-192.png', '/icon-512.png']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(Array.from(STATIC_SHELL_ASSETS)))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only cache static PWA shell assets; never cache HTML or Next.js JS chunks forever
  if (url.origin !== self.location.origin || !STATIC_SHELL_ASSETS.has(url.pathname)) return;

  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => undefined);
          }
          return res;
        })
    )
  );
});

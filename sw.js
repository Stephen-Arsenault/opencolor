/**
 * ColorReader service worker.
 * - Precache the app shell so it launches offline.
 * - Reference datasets (data/*.json): stale-while-revalidate — instant from
 *   cache, refreshed in the background as the dataset grows.
 * Bump CACHE when shipping new assets to force an update.
 */
const CACHE = 'colorreader-v2';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './dist/app.js',
  './dist/colorreader.js',
  './dist/color.js',
  './dist/matcher.js',
  './dist/store.js',
  './data/index.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  // Datasets: stale-while-revalidate.
  if (req.url.includes('/data/')) {
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        const cached = await c.match(req);
        const network = fetch(req).then((res) => {
          if (res.ok) c.put(req, res.clone());
          return res;
        }).catch(() => cached);
        return cached || network;
      }),
    );
    return;
  }

  // Shell / everything else: network-first so pushed updates show immediately,
  // falling back to cache when offline.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || Promise.reject())),
  );
});

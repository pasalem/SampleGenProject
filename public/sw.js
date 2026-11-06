// Service worker: lets the app open offline and keeps card images cached.
//  - App files: network first (so new versions show up right away), cached copy when offline.
//  - Scryfall card images and mana symbols: cache first; they never change for a given URL.
//  - Scryfall API and GitHub API: always the network (prices and sync must be live).
const SHELL = 'shell-v2';
const IMAGES = 'images-v1';
const MAX_IMAGES = 4000;
const SHELL_FILES = [
  './', './index.html', './css/styles.css', './manifest.webmanifest', './icons/icon-192.png',
  './js/app.js', './js/collection.js', './js/db.js', './js/importer.js', './js/render.js', './js/scryfall.js', './js/history.js', './js/sync.js',
];
const IMAGE_HOSTS = new Set(['cards.scryfall.io', 'svgs.scryfall.io']);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== IMAGES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) event.respondWith(networkFirst(req));
  else if (IMAGE_HOSTS.has(url.hostname)) event.respondWith(cacheFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') return cache.match('./index.html');
    throw err;
  }
}

let puts = 0;
async function cacheFirst(req) {
  const cache = await caches.open(IMAGES);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await fetch(req);
  // Only CORS responses (not opaque ones) are cached: opaque responses take far more storage quota.
  if (res.ok && res.type === 'cors') {
    await cache.put(req.url, res.clone());
    if (++puts % 100 === 0) trim(cache);
  }
  return res;
}

// Drop the oldest images once the cache holds more than MAX_IMAGES.
async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_IMAGES; i++) await cache.delete(keys[i]);
}

/**
 * Service worker for offline app-shell support.
 *
 * Strategies:
 *   navigations (HTML)   → network-first, cache the response, fall back to the
 *                          cached copy of that route, then /offline. While
 *                          online this is byte-for-byte today's behavior.
 *   /_next/static, icons → cache-first (immutable, content-hashed).
 *   everything else      → straight to the network (never intercepted):
 *                          - Supabase REST/RPC is cross-origin and handled by
 *                            the app's IndexedDB cache layer, not the SW.
 *                          - /api/* must stay live — /api/ping is the very
 *                            probe that detects connectivity; serving it from
 *                            a cache would fake "online".
 *                          - RSC payload requests (client-side navigations)
 *                            are not cached; when they fail offline the Next
 *                            router falls back to a hard navigation, which
 *                            this SW then serves from the navigation cache.
 */

const VERSION = 'sisolution-offline-v1';
const NAV_CACHE = `${VERSION}-nav`;
const STATIC_CACHE = `${VERSION}-static`;
const OFFLINE_URL = '/offline';
const MAX_NAV_ENTRIES = 60;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(NAV_CACHE);
      await cache.add(new Request(OFFLINE_URL, { cache: 'reload' }));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

function isStaticAsset(pathname) {
  if (pathname.startsWith('/_next/static/')) return true;
  if (pathname === '/manifest.json' || pathname === '/favicon.ico') return true;
  // public/ assets shipped with a file extension (icons, fonts, uploaded media)
  if (/\.(png|jpg|jpeg|svg|webp|gif|ico|woff2?|ttf|css|js|json)$/i.test(pathname) && !pathname.startsWith('/api/')) {
    return true;
  }
  return false;
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res && res.ok) cache.put(request, res.clone());
  return res;
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(NAV_CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      cache.put(request, res.clone());
      trimCache(cache, MAX_NAV_ENTRIES);
    }
    return res;
  } catch (err) {
    const exact = await cache.match(request);
    if (exact) return exact;
    // Query-string variants (filters, tab state) fall back to the base route.
    const base = await cache.match(new URL(request.url).pathname);
    if (base) return base;
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    throw err;
  }
}

async function trimCache(cache, max) {
  const keys = await cache.keys();
  if (keys.length <= max) return;
  // Oldest first — the offline fallback must survive the trim.
  for (const key of keys) {
    if (keys.length <= max) break;
    if (new URL(key.url).pathname === OFFLINE_URL) continue;
    await cache.delete(key);
    keys.splice(keys.indexOf(key), 1);
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Supabase etc. — never intercept
  if (url.pathname.startsWith('/api/')) return; // live endpoints only

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(request).catch((err) => { throw err; }));
  }
  // Everything else: no respondWith → default network behavior.
});

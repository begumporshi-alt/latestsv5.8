/**
 * Service worker for offline app-shell support.
 *
 * The key lesson baked into this version: in-app navigation is a CLIENT-SIDE
 * RSC fetch, not a browser navigation, so a cache that only fills from
 * `request.mode === 'navigate'` stays empty for a user who only clicks the
 * sidebar. Offline, Next then falls back to a hard navigation (13.5.x
 * `fetch-server-response` MPA fallback) — and that hard navigation must find
 * a cached shell. So this worker WARMS THE CACHE EXPLICITLY:
 *
 *   activate / build change → fetch /precache-manifest.json and warm the new
 *     build's generation: every route's HTML plus every build asset (chunks,
 *     css, fonts). Route HTML alone is not enough — App Router loads each
 *     route's page chunk dynamically, so a route never opened online would
 *     have no chunk and render blank.
 *   runtime (page pings)    → the app posts the routes it sees in the
 *     sidebar; uncached routes are warmed in the background.
 *
 * Cache generations are STAMPED WITH THE BUILD ID. A deploy builds a new
 * generation next to the old one, switches over, and only then prunes
 * generations older than the previous one — so a page that is mid-load during
 * a deploy keeps working from the generation it started on, and no page ever
 * mixes old HTML with new chunks (which breaks hydration → blank page).
 *
 * Strategies:
 *   navigations (HTML)   → network-first, cache the response, fall back to
 *                          the exact route, then the query-less route, then
 *                          /offline — across all generations.
 *   /_next/static, icons → cache-first, across all generations.
 *   everything else      → straight to the network (never intercepted):
 *                          - Supabase REST/RPC is cross-origin and handled by
 *                            the app's IndexedDB layer, not the SW.
 *                          - /api/* must stay live — /api/ping is the very
 *                            probe that detects connectivity.
 *                          - RSC payload requests (client-side navigations)
 *                            are not cached; when they fail offline the Next
 *                            router hard-navigates, which lands on the
 *                            precached shell above.
 */

const VERSION = 'sisolution-offline-v3';
const META_CACHE = `${VERSION}-meta`;
const VERSION_KEY = '/__offline-build-version';
const OFFLINE_URL = '/offline';
const MAX_NAV_ENTRIES = 80;
const PRECACHE_MANIFEST_URL = '/precache-manifest.json';

/** Always warmed, even with no manifest (an installed app's core modules). */
const CORE_ROUTES = [
  '/dashboard',
  '/sales/pos',
  '/sales',
  '/inventory',
  '/crm',
  '/employees',
  '/hr/attendance',
  '/sync',
  OFFLINE_URL,
];

const STATIC_SEEDS = [
  '/manifest.json',
  '/favicon.ico',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-192-maskable.png',
  '/icon-512-maskable.png',
  '/apple-touch-icon.png',
];

/** Asset URLs referenced from a route's HTML (chunks, styles, fonts, images). */
const ASSET_RE = /\/_next\/static\/[^"'\s<>\\]+?\.(?:js|css|woff2?|ttf|png|jpe?g|svg|webp|gif|ico)/g;

/* ------------------------------------------------------------------ */
/* Cache generations                                                   */
/* ------------------------------------------------------------------ */

const navName = (build) => `${VERSION}-nav-${build}`;
const staticName = (build) => `${VERSION}-static-${build}`;

let activeBuild = null;
const handles = new Map();

async function openCache(name) {
  let cache = handles.get(name);
  if (!cache) {
    cache = await caches.open(name);
    handles.set(name, cache);
  }
  return cache;
}

async function getActiveBuild() {
  if (activeBuild) return activeBuild;
  activeBuild = 'core';
  try {
    const meta = await openCache(META_CACHE);
    const res = await meta.match(VERSION_KEY);
    if (res) activeBuild = (await res.text()) || 'core';
  } catch {
    // meta unavailable — the core generation is a safe default
  }
  return activeBuild;
}

async function setActiveBuild(build) {
  activeBuild = build;
  const meta = await openCache(META_CACHE);
  await meta.put(VERSION_KEY, new Response(String(build)));
}

async function activeNavCache() {
  return openCache(navName(await getActiveBuild()));
}

async function activeStaticCache() {
  return openCache(staticName(await getActiveBuild()));
}

/**
 * Match a request in ANY generation, newest first. Keeping older generations
 * readable is what makes a deploy safe for pages that are mid-load: their
 * chunk requests still resolve even after the new build becomes active.
 */
async function matchAcross(request, kind) {
  const names = (await caches.keys())
    .filter((name) => name.startsWith(`${VERSION}-${kind}-`))
    .sort()
    .reverse();
  for (const name of names) {
    const hit = await (await openCache(name)).match(request);
    if (hit) return hit;
  }
  return null;
}

/** Keep the current generation and its predecessor; drop older ones. */
async function pruneGenerations(keepBuilds) {
  const keep = new Set();
  for (const build of keepBuilds) {
    if (!build) continue;
    keep.add(navName(build));
    keep.add(staticName(build));
  }
  for (const name of await caches.keys()) {
    const isGeneration = name.startsWith(`${VERSION}-nav-`) || name.startsWith(`${VERSION}-static-`);
    if (!isGeneration || keep.has(name)) continue;
    await caches.delete(name);
    handles.delete(name);
  }
}

/* ------------------------------------------------------------------ */
/* Precache                                                            */
/* ------------------------------------------------------------------ */

async function mapLimit(items, limit, fn) {
  const arr = Array.from(items);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (i < arr.length) {
      const item = arr[i++];
      try {
        await fn(item);
      } catch {
        // Tolerate per-item failures — a partial precache is still useful.
      }
    }
  });
  await Promise.all(workers);
}

function extractAssets(html) {
  const out = new Set();
  let m;
  ASSET_RE.lastIndex = 0;
  while ((m = ASSET_RE.exec(html)) !== null) out.add(m[0]);
  return out;
}

async function fetchManifest() {
  try {
    const res = await fetch(`${PRECACHE_MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || typeof json !== 'object') return null;
    const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.startsWith('/')) : []);
    return {
      version: typeof json.version === 'string' && json.version ? json.version : 'core',
      routes: strList(json.routes),
      assets: strList(json.assets),
    };
  } catch {
    return null;
  }
}

async function cacheAsset(cache, url) {
  if (await cache.match(url)) return;
  const res = await fetch(url, { cache: 'reload' });
  if (res && res.ok) await cache.put(url, res);
}

/** Warm one build generation: route HTML plus every build asset. */
async function precacheBuild(build, routes, assets) {
  const nav = await openCache(navName(build));
  const stat = await openCache(staticName(build));
  const assetSet = new Set([...(Array.isArray(assets) ? assets : []), ...STATIC_SEEDS]);

  await mapLimit(routes, 4, async (route) => {
    if (await nav.match(route)) return;
    const res = await fetch(new Request(route, { cache: 'reload', credentials: 'same-origin' }));
    if (!res || !res.ok) return;
    const html = await res.clone().text();
    extractAssets(html).forEach((a) => assetSet.add(a));
    await nav.put(route, res);
  });

  await mapLimit(assetSet, 6, (url) => cacheAsset(stat, url));
}

/**
 * Build a new generation, switch to it, then prune everything older than the
 * previous generation. Nothing is deleted before the new generation is ready,
 * so an in-flight page never loses its chunks.
 */
async function switchToBuild(build, routes, assets) {
  const previous = await getActiveBuild();
  await precacheBuild(build, routes, assets);
  await setActiveBuild(build);
  await pruneGenerations([build, previous]);
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from older SW generations (pre-v3 layouts).
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n)));

      const manifest = await fetchManifest();
      const build = manifest ? manifest.version : 'core';
      if ((await getActiveBuild()) !== build) {
        await switchToBuild(
          build,
          manifest && manifest.routes.length ? manifest.routes : CORE_ROUTES,
          manifest ? manifest.assets : [],
        );
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};

  // The app asks whether a newer build has been deployed. The SW's own bytes
  // do not change per deploy, so 'activate' alone would never notice.
  if (data.type === 'offline-check-version') {
    event.waitUntil(
      (async () => {
        const manifest = await fetchManifest();
        if (!manifest) return;
        if ((await getActiveBuild()) === manifest.version) return;
        await switchToBuild(
          manifest.version,
          manifest.routes.length ? manifest.routes : CORE_ROUTES,
          manifest.assets,
        );
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const client of clients) client.postMessage({ type: 'offline-version-updated', version: manifest.version });
      })(),
    );
    return;
  }

  // The app reports the routes it knows about (sidebar). Warm anything new.
  if (data.type === 'offline-precache' && Array.isArray(data.routes)) {
    const routes = data.routes.filter((r) => typeof r === 'string' && r.startsWith('/'));
    if (routes.length > 0) {
      event.waitUntil(
        (async () => {
          const build = await getActiveBuild();
          await precacheBuild(build, routes, null);
        })(),
      );
    }
  }
});

/* ------------------------------------------------------------------ */
/* Fetch handlers                                                      */
/* ------------------------------------------------------------------ */

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
  const hit = await matchAcross(request, 'static');
  if (hit) return hit;
  const res = await fetch(request);
  if (res && res.ok) {
    const cache = await activeStaticCache();
    cache.put(request, res.clone());
  }
  return res;
}

async function networkFirstNavigation(request) {
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      const cache = await activeNavCache();
      cache.put(request, res.clone());
      trimCache(cache, MAX_NAV_ENTRIES);
    }
    return res;
  } catch (err) {
    const exact = await matchAcross(request, 'nav');
    if (exact) return exact;
    // Query-string variants (filters, tab state) fall back to the base route.
    const base = await matchAcross(new URL(request.url).pathname, 'nav');
    if (base) return base;
    const offline = await matchAcross(OFFLINE_URL, 'nav');
    if (offline) return offline;
    throw err;
  }
}

async function trimCache(cache, max) {
  const keys = await cache.keys();
  if (keys.length <= max) return;
  // Oldest first — never trim the offline fallback or the core modules.
  const protectedPaths = new Set([OFFLINE_URL, ...CORE_ROUTES]);
  for (const key of keys) {
    if (keys.length <= max) break;
    const path = new URL(key.url).pathname;
    if (protectedPaths.has(path)) continue;
    await cache.delete(key);
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

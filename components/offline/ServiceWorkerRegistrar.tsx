'use client';

/**
 * Registers the offline service worker (app-shell caching) after the app has
 * hydrated. Registration is skipped on non-secure origins (SW requirement)
 * and in dev builds: Next dev serves non-hashed chunk URLs, so a cache-first
 * SW would serve stale code across edits. Production bundles are
 * content-hashed and immutable — safe to cache. In dev, any worker left
 * over from a previous production run on the same port is unregistered and
 * its caches cleared (it would serve stale prod chunks against the dev
 * server).
 *
 * Beyond registration this component keeps the offline shell current:
 *
 *  - Route warming: after load it posts the routes it can see (sidebar links
 *    + core modules) to the SW, which caches each route's HTML and its
 *    chunks. This is what makes offline page-to-page navigation work — the
 *    SW cannot discover routes on its own, and in-app navigation never
 *    produces a cacheable browser navigation.
 *  - Build freshness: the SW's own bytes don't change per deploy, so it pings
 *    /precache-manifest.json when asked and re-warms when the build id moves.
 *
 * Also surfaces SW updates: sw.js calls skipWaiting + clients.claim, so a
 * deployed change takes over already-open pages and fires controllerchange.
 * That's the user's cue to refresh. The very first control (null → worker,
 * on the initial visit) is not an update and stays silent.
 */

import { useEffect } from 'react';
import { toast } from '@/hooks/use-toast';

/** Modules that must stay offline-available even if the user never opens them. */
const CORE_ROUTES = [
  '/dashboard',
  '/sales/pos',
  '/sales',
  '/inventory',
  '/crm',
  '/employees',
  '/hr/attendance',
  '/sync',
];

const ROUTE_PING_KEY = 'offline:route-ping-at';
const VERSION_PING_KEY = 'offline:version-ping-at';
const ROUTE_PING_INTERVAL_MS = 6 * 60 * 60 * 1000; // twice a day is plenty
const VERSION_PING_INTERVAL_MS = 5 * 60 * 1000;
const MAX_ROUTES = 80;

function collectRoutes(): string[] {
  const seen = new Set<string>(CORE_ROUTES);
  try {
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]'))) {
      const raw = a.getAttribute('href') || '';
      const path = raw.split(/[?#]/)[0];
      if (!path || path.startsWith('/api/')) continue;
      // Skip per-record pages (an id segment) — they hold dynamic data and
      // would bloat the precache; their list pages are warmed instead.
      if (path.split('/').length > 3) continue;
      seen.add(path);
      if (seen.size >= MAX_ROUTES) break;
    }
  } catch {
    // DOM not ready — core routes still get warmed.
  }
  return Array.from(seen);
}

function throttle(key: string, intervalMs: number): boolean {
  try {
    const last = Number(localStorage.getItem(key) || 0);
    if (Date.now() - last < intervalMs) return false;
    localStorage.setItem(key, String(Date.now()));
    return true;
  } catch {
    return true;
  }
}

export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    if (!window.isSecureContext) return;

    if (process.env.NODE_ENV === 'development') {
      // A service worker left over from a previous production run on this
      // origin (same port) would keep serving OLD prod chunks against the
      // dev server — stale code, broken offline behavior, blank pages.
      // Dev never registers its own worker, so any registration found here
      // is stale by definition: remove it and its caches.
      void (async () => {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) await r.unregister();
        // Always clear: a controlling worker keeps caching until the next
        // reload, so leftovers can survive the unregister on this load.
        for (const k of await caches.keys()) await caches.delete(k);
        if (regs.length === 0) return;
        toast({
          title: 'Removed a stale service worker',
          description:
            'A service worker from a previous production build was still controlling this port. It has been removed — offline mode needs a production build (npm run build && npm start).',
        });
      })();
      return;
    }

    let hadController = Boolean(navigator.serviceWorker.controller);
    const onControllerChange = () => {
      if (hadController) {
        toast({
          title: 'App updated',
          description: 'A new version is active — refresh the page to pick it up.',
        });
      }
      hadController = true;
      void pingWorker();
    };

    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'offline-version-updated') {
        toast({
          title: 'Offline data refreshed',
          description: 'The app cache has been updated for the new version. Refresh when convenient.',
        });
      }
    };

    /** Ask the SW to refresh its caches: new routes, and a new deployed build. */
    async function pingWorker() {
      try {
        const reg = await navigator.serviceWorker.ready;
        const worker = reg.active;
        if (!worker) return;
        if (navigator.onLine) {
          if (throttle(VERSION_PING_KEY, VERSION_PING_INTERVAL_MS)) {
            worker.postMessage({ type: 'offline-check-version' });
          }
          if (throttle(ROUTE_PING_KEY, ROUTE_PING_INTERVAL_MS)) {
            worker.postMessage({ type: 'offline-precache', routes: collectRoutes() });
          }
        }
      } catch {
        // Registration unavailable — nothing to warm.
      }
    }

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    navigator.serviceWorker.addEventListener('message', onMessage);

    const register = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then(() => pingWorker())
        .catch((err) => console.warn('Service worker registration failed (offline shell unavailable):', err));
    };

    // Warm once the app is interactive — the sidebar links exist by then.
    const onLoad = () => {
      register();
      // The sidebar renders after hydration; ping again once it's there.
      window.setTimeout(() => void pingWorker(), 3000);
    };

    if (document.readyState === 'complete') {
      onLoad();
    } else {
      window.addEventListener('load', onLoad, { once: true });
    }

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      navigator.serviceWorker.removeEventListener('message', onMessage);
      window.removeEventListener('load', onLoad);
    };
  }, []);

  return null;
}

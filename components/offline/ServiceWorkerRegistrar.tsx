'use client';

/**
 * Registers the offline service worker (app-shell caching) after the app has
 * hydrated. Registration is skipped on non-secure origins (SW requirement)
 * and in dev builds: Next dev serves non-hashed chunk URLs, so a cache-first
 * SW would serve stale code across edits. Production bundles are
 * content-hashed and immutable — safe to cache.
 *
 * Also surfaces SW updates: sw.js calls skipWaiting + clients.claim, so a
 * deployed change takes over already-open pages and fires controllerchange.
 * That's the user's cue to refresh. The very first control (null → worker,
 * on the initial visit) is not an update and stays silent.
 */

import { useEffect } from 'react';
import { toast } from '@/hooks/use-toast';

export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    if (!window.isSecureContext) return;
    if (process.env.NODE_ENV === 'development') return;

    let hadController = Boolean(navigator.serviceWorker.controller);
    const onControllerChange = () => {
      if (hadController) {
        toast({
          title: 'App updated',
          description: 'A new version is active — refresh the page to pick it up.',
        });
      }
      hadController = true;
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    const register = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .catch((err) => console.warn('Service worker registration failed (offline shell unavailable):', err));
    };

    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register, { once: true });
    }

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      window.removeEventListener('load', register);
    };
  }, []);

  return null;
}

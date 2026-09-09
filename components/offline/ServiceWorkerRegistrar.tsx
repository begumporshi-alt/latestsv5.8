'use client';

/**
 * Registers the offline service worker (app-shell caching) after the app has
 * hydrated. Registration is skipped on non-secure origins (SW requirement)
 * and in dev builds: Next dev serves non-hashed chunk URLs, so a cache-first
 * SW would serve stale code across edits. Production bundles are
 * content-hashed and immutable — safe to cache.
 */

import { useEffect } from 'react';

export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    if (!window.isSecureContext) return;
    if (process.env.NODE_ENV === 'development') return;

    const register = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .catch((err) => console.warn('Service worker registration failed (offline shell unavailable):', err));
    };

    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register, { once: true });
      return () => window.removeEventListener('load', register);
    }
  }, []);

  return null;
}

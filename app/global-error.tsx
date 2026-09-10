'use client';

/**
 * Last-resort error boundary (root layout level).
 *
 * Without one, any uncaught render error in production unmounts the whole
 * React tree and leaves a blank white page — which is exactly what offline
 * failures used to look like. This turns that into a recoverable screen.
 */

import { useEffect, useState } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    setOffline(typeof navigator !== 'undefined' && !navigator.onLine);
    console.error('[app] global error:', error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#0f172a', color: '#e2e8f0' }}>
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <div style={{ maxWidth: 460, textAlign: 'center' }}>
            <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
              {offline ? "You're offline" : 'Something went wrong'}
            </h1>
            <p style={{ fontSize: 14, color: '#94a3b8', marginBottom: 6 }}>
              {offline
                ? 'This screen could not load from the local copy. Your data is safe — anything you had queued is still stored on this device.'
                : 'The app hit an unexpected error. Your data is safe.'}
            </p>
            <p style={{ fontSize: 12, color: '#64748b', marginBottom: 20 }}>
              {error.digest ? `Reference: ${error.digest}` : error.message}
            </p>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button
                onClick={() => reset()}
                style={{
                  padding: '8px 16px',
                  borderRadius: 8,
                  border: 'none',
                  background: '#2563eb',
                  color: 'white',
                  fontSize: 14,
                  cursor: 'pointer',
                }}
              >
                Try again
              </button>
              <a
                href="/dashboard"
                style={{
                  padding: '8px 16px',
                  borderRadius: 8,
                  border: '1px solid #334155',
                  color: '#e2e8f0',
                  fontSize: 14,
                  textDecoration: 'none',
                }}
              >
                Go to Dashboard
              </a>
              <a
                href="/offline"
                style={{
                  padding: '8px 16px',
                  borderRadius: 8,
                  border: '1px solid #334155',
                  color: '#e2e8f0',
                  fontSize: 14,
                  textDecoration: 'none',
                }}
              >
                Offline help
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}

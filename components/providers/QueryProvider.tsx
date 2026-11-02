'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * In-memory query cache for the ERP shell.
 *
 * Scope boundary (deliberate): this cache lives in memory only and is NOT
 * persisted. Persistence and offline reads already belong to lib/offline
 * (Dexie + the transparent read fallback on the Supabase client). Adding a
 * persisted query cache would create a second copy of the same data with a
 * different staleness clock — two sources of truth for one number.
 *
 * What it buys on top of the offline cache:
 *   - request de-duplication (two components asking for the same period
 *     share one round trip),
 *   - cancellation semantics (a period switch discards the in-flight result
 *     instead of letting it overwrite the new period),
 *   - staleTime, so re-entering a tab does not re-download what was just
 *     fetched,
 *   - prefetching on intent (hover) rather than on mount.
 */
export default function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 60_000,
            gcTime: 30 * 60_000,
            // A POS/ERP tab is often left open for hours; refetching every
            // time the operator alt-tabs back would burn egress for no gain.
            refetchOnWindowFocus: false,
            refetchOnReconnect: true,
            retry: (attempt, error) => {
              const message = String((error as { message?: string })?.message || '');
              // Offline is not a transient failure — retrying just delays the
              // local fallback by three round-trip timeouts.
              if (/offline|failed to fetch|networkerror/i.test(message)) return false;
              return attempt < 2;
            },
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

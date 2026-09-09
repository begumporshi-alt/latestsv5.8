'use client';

/**
 * useCachedQuery — the drop-in data loader for offline-capable pages.
 *
 * Wraps lib/offline/cache.cachedQuery in a useEffect + state so existing
 * pages change their load function only:
 *
 *   const products = useCachedQuery<Product[]>(
 *     CACHE_KEYS.products, 60_000,
 *     () => fetchAll(() => supabase.from('products')...),
 *   );
 *
 * `deps` refires the query like a useEffect dependency array (e.g. [search]).
 * The fetcher is kept in a ref so a new closure per render doesn't refire.
 */

import { useEffect, useRef, useState } from 'react';
import { cachedQuery } from './cache';

export interface CachedQueryState<T> {
  data: T | null
  error: string | null
  loading: boolean
  /** false when the data came from the local cache rather than a live fetch */
  fresh: boolean
  offline: boolean
  cachedAt: number | null
}

export function useCachedQuery<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
): CachedQueryState<T> {
  const [state, setState] = useState<CachedQueryState<T>>({
    data: null,
    error: null,
    loading: true,
    fresh: false,
    offline: false,
    cachedAt: null,
  });

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    cachedQuery<T>(key, ttlMs, () => fetcherRef.current())
      .then((res) => {
        if (cancelled) return;
        setState({
          data: res.data,
          error: null,
          loading: false,
          fresh: res.fresh,
          offline: res.offline,
          cachedAt: res.cachedAt,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ttlMs, ...deps]);

  return state;
}

/** Small helper for the "cached as of HH:MM" badges on integrated pages. */
export function formatCachedAt(cachedAt: number | null): string {
  if (!cachedAt) return '';
  return new Date(cachedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

'use client';

import { useCallback, useMemo } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchSalesBreakdown,
  fetchSalesDetail,
  fetchSalesSummary,
  resolvePeriod,
  salesKeys,
  type BreakdownRow,
  type Dimension,
  type ResolvedPeriod,
} from './sales-report';
import { useSalesReportStore } from './sales-report-store';

/**
 * The resolved period, derived once from the store.
 *
 * `new Date()` is read during render, which is safe here because the value is
 * a calendar boundary (day granularity) rather than a ticking clock: it cannot
 * change between two renders within the same session day.
 */
export function useReportPeriod(): ResolvedPeriod {
  const period = useSalesReportStore((s) => s.period);
  const dateFrom = useSalesReportStore((s) => s.dateFrom);
  const dateTo = useSalesReportStore((s) => s.dateTo);
  return useMemo(
    () => resolvePeriod(period, { from: dateFrom, to: dateTo }),
    [period, dateFrom, dateTo],
  );
}

export function useSalesSummary(start: string, end: string) {
  return useQuery({
    queryKey: salesKeys.summary(start, end),
    queryFn: () => fetchSalesSummary(start, end),
    staleTime: 5 * 60_000,
  });
}

/**
 * Full list for one dimension.
 *
 * `enabled` keeps the request lazy: the Summary tab must not pay for four full
 * dimension lists. While the real list loads, the top-12 rows already returned
 * by the summary RPC are used as placeholder data, so the table paints
 * immediately instead of flashing a spinner.
 */
export function useSalesBreakdown(
  dimension: Dimension,
  start: string,
  end: string,
  options: { enabled?: boolean; placeholderRows?: BreakdownRow[] } = {},
) {
  const { enabled = true, placeholderRows } = options;
  return useQuery({
    queryKey: salesKeys.breakdown(dimension, start, end),
    queryFn: () => fetchSalesBreakdown(dimension, start, end),
    staleTime: 5 * 60_000,
    enabled,
    placeholderData: (previous) => previous ?? placeholderRows,
  });
}

export function useSalesDetail(
  dimension: Dimension | null,
  dimensionId: string | null,
  start: string,
  end: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: salesKeys.detail(dimension ?? 'product', dimensionId, start, end),
    queryFn: () => fetchSalesDetail(dimension as Dimension, dimensionId, start, end),
    staleTime: 5 * 60_000,
    enabled: enabled && dimension !== null,
    placeholderData: keepPreviousData,
  });
}

/**
 * Intent-based prefetch: fire on pointer/focus of a tab, not on mount.
 *
 * Mount-time prefetch of all four tabs would reproduce exactly the redundancy
 * this rewrite removes (four full lists for a user who reads one). Hovering is
 * a much stronger signal that the tab is about to be opened.
 */
export function usePrefetchBreakdown(start: string, end: string) {
  const queryClient = useQueryClient();
  return useCallback(
    (dimension: Dimension) => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      void queryClient.prefetchQuery({
        queryKey: salesKeys.breakdown(dimension, start, end),
        queryFn: () => fetchSalesBreakdown(dimension, start, end),
        staleTime: 5 * 60_000,
      });
    },
    [queryClient, start, end],
  );
}

'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getPeriodRange,
  readSalesListRefs,
  readSalesPage,
  readSalesProducts,
  salesKeys,
  type SalesPeriod,
} from './sales-data';

/**
 * The invoice list for one period window.
 *
 * `placeholderData: keepPrevious` keeps the previous window on screen while a
 * new one loads — switching Today → Last 7 days used to blank the table back
 * to skeleton rows.
 */
export function useSalesPage(period: SalesPeriod, from: string, to: string) {
  return useQuery({
    queryKey: salesKeys.page(period, from, to),
    queryFn: () => readSalesPage(`sales:page-data:${period}:${from}:${to}`, from, to),
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  });
}

export function useSalesListRefs() {
  return useQuery({
    queryKey: salesKeys.listRefs(),
    queryFn: readSalesListRefs,
    staleTime: 5 * 60_000,
  });
}

/**
 * The catalogue, fetched only when something actually reads it: a create/edit
 * form, a print view, or the product filter. Opening those before it lands
 * shows an empty picker for a moment — the same state this page already
 * tolerated when it opened offline.
 */
export function useSalesProducts(enabled: boolean) {
  return useQuery({
    queryKey: salesKeys.products(),
    queryFn: readSalesProducts,
    staleTime: 5 * 60_000,
    enabled,
  });
}

/**
 * Re-fetch everything after a write.
 *
 * The old code called `loadData(true)`, which deleted the cached window first
 * because `cachedQuery` would otherwise serve the pre-save snapshot for up to
 * its TTL. The cache now runs at a zero TTL, so the refetch always hits the
 * network and rewrites the snapshot — no deletion needed, and no way to end up
 * showing stale rows after saving.
 */
export function useInvalidateSales() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: salesKeys.all });
}

export { getPeriodRange };

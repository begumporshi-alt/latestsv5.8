'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  dashboardKeys,
  fetchDashboardCharts,
  fetchDashboardInventory,
  fetchDashboardOverview,
} from './dashboard-data';

/**
 * staleTime is per query and tracks how fast each slice actually moves:
 * the KPI row changes when a sale is posted (60 s), the monthly series only
 * moves when a month rolls over or COGS is reposted (5 min), and the stock
 * ledger walk behind the inventory cards is expensive enough that re-running
 * it on every mount would be the single biggest egress cost on the page
 * (10 min).
 */
export function useDashboardOverview() {
  return useQuery({
    queryKey: dashboardKeys.overview(),
    queryFn: fetchDashboardOverview,
    staleTime: 60_000,
  });
}

export function useDashboardCharts() {
  return useQuery({
    queryKey: dashboardKeys.charts(),
    queryFn: fetchDashboardCharts,
    staleTime: 5 * 60_000,
  });
}

export function useDashboardInventory() {
  return useQuery({
    queryKey: dashboardKeys.inventory(),
    queryFn: fetchDashboardInventory,
    staleTime: 10 * 60_000,
  });
}

/**
 * Refresh everything the dashboard shows. The page had no way to do this
 * before: after posting a sale the KPI row stayed stale for the remainder of
 * a fixed 60 s TTL with no user-facing escape hatch.
 */
export function useRefreshDashboard() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: dashboardKeys.all });
}

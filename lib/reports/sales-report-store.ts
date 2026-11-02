'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Dimension, PeriodId, View } from './sales-report';

export type DisplayMode = 'table' | 'chart';
export type ChartMetric = 'revenue' | 'profit' | 'quantity';
export type PrintScope = 'current' | 'full';

interface SalesReportState {
  /** Filter selections that should survive a navigation away and back. */
  period: PeriodId;
  dateFrom: string;
  dateTo: string;
  view: View;
  /** Table/chart preference is remembered per tab — a mix view is normal. */
  displayMode: Record<View, DisplayMode>;
  topN: number;
  metric: ChartMetric;
  printScope: PrintScope;

  setPeriod: (period: PeriodId) => void;
  setCustomRange: (from: string, to: string) => void;
  setView: (view: View) => void;
  setDisplayMode: (view: View, mode: DisplayMode) => void;
  setTopN: (n: number) => void;
  setMetric: (m: ChartMetric) => void;
  setPrintScope: (s: PrintScope) => void;
}

const TABLE_ONLY: Record<View, DisplayMode> = {
  summary: 'chart',
  product: 'table',
  brand: 'table',
  category: 'table',
  customer: 'table',
};

/**
 * Report UI state.
 *
 * Why a store rather than component state: the print document is rendered from
 * a sibling subtree and must reflect exactly what is on screen (period, tab,
 * chart metric, top-N). Threading a dozen props through a modal is how the
 * printed report and the screen drift apart.
 *
 * Persistence is limited to filter/preference fields — transient state (search
 * text, sort, page) is intentionally left out so a report always reopens on a
 * clean first page rather than a filtered, half-scrolled view.
 */
export const useSalesReportStore = create<SalesReportState>()(
  persist(
    (set) => ({
      period: 'this_month',
      dateFrom: '',
      dateTo: '',
      view: 'summary',
      displayMode: TABLE_ONLY,
      topN: 10,
      metric: 'revenue',
      printScope: 'current',

      setPeriod: (period) => set({ period }),
      setCustomRange: (dateFrom, dateTo) => set({ dateFrom, dateTo }),
      setView: (view) => set({ view }),
      setDisplayMode: (view, mode) =>
        set((s) => ({ displayMode: { ...s.displayMode, [view]: mode } })),
      setTopN: (topN) => set({ topN }),
      setMetric: (metric) => set({ metric }),
      setPrintScope: (printScope) => set({ printScope }),
    }),
    {
      name: 'si:sales-report:v1',
      // Default storage (createJSONStorage(() => localStorage)) is SSR-safe:
      // it resolves to a no-op store on the server instead of throwing.
      partialize: (s) => ({
        period: s.period,
        dateFrom: s.dateFrom,
        dateTo: s.dateTo,
        view: s.view,
        displayMode: s.displayMode,
        topN: s.topN,
        metric: s.metric,
        printScope: s.printScope,
      }),
      merge: (persisted, current) => {
        const p = (persisted || {}) as Partial<SalesReportState>;
        return {
          ...current,
          ...p,
          // A persisted map from an older build may miss a tab.
          displayMode: { ...current.displayMode, ...(p.displayMode || {}) },
        };
      },
    },
  ),
);

export const DIMENSION_TABS: { id: View; label: string }[] = [
  { id: 'summary', label: 'Summary' },
  { id: 'product', label: 'By product' },
  { id: 'brand', label: 'By brand' },
  { id: 'category', label: 'By category' },
  { id: 'customer', label: 'By customer' },
];

export type { Dimension };

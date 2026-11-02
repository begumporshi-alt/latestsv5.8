import {
  endOfMonth,
  endOfQuarter,
  format,
  parseISO,
  startOfMonth,
  startOfQuarter,
  startOfYear,
  subDays,
  subMonths,
  subQuarters,
} from 'date-fns';

import { ISO_DATE } from './as-of-presets';

export interface DateRange {
  from: string;
  to: string;
}

export interface RangePreset {
  id: string;
  label: string;
  hint: string;
  resolve: (now: Date) => { from: Date; to: Date };
}

/**
 * Presets for a *closed* window, which is a different shape from the point-in-
 * time presets in as-of-presets.ts. Both ends are inclusive: "10–20 Oct" means
 * the 10th, the 11th … the 20th.
 *
 * Calendar periods again — the app has no fiscal-year setting.
 */
export const RANGE_PRESETS: RangePreset[] = [
  {
    id: 'this-month',
    label: 'This month',
    hint: '1st of this month to today',
    resolve: now => ({ from: startOfMonth(now), to: now }),
  },
  {
    id: 'last-month',
    label: 'Last month',
    hint: 'The whole of the previous month',
    resolve: now => {
      const prev = subMonths(now, 1);
      return { from: startOfMonth(prev), to: endOfMonth(prev) };
    },
  },
  {
    id: 'last-30',
    label: 'Last 30 days',
    hint: 'Rolling 30 days ending today',
    resolve: now => ({ from: subDays(now, 29), to: now }),
  },
  {
    id: 'last-quarter',
    label: 'Last quarter',
    hint: 'The whole of the previous calendar quarter',
    resolve: now => {
      const prev = subQuarters(now, 1);
      return { from: startOfQuarter(prev), to: endOfQuarter(prev) };
    },
  },
  {
    id: 'year-to-date',
    label: 'Year to date',
    hint: '1 January to today',
    resolve: now => ({ from: startOfYear(now), to: now }),
  },
];

export function resolveRangePresets(now: Date = new Date()): Array<RangePreset & DateRange> {
  return RANGE_PRESETS.map(preset => {
    const { from, to } = preset.resolve(now);
    return { ...preset, from: format(from, ISO_DATE), to: format(to, ISO_DATE) };
  });
}

/**
 * The day before `iso`.
 *
 * This is the opening date for a range. A window of 10–20 Oct must open at the
 * *close of 9 Oct*: asking for "as of 10 Oct" would already include everything
 * posted on the 10th, so the 10th's own transactions would silently vanish from
 * the movement column. Off-by-one here is invisible in the UI and wrong in the
 * arithmetic, so it lives in one tested function.
 */
export function previousDayISO(iso: string): string {
  const parsed = parseISO(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return format(subDays(parsed, 1), ISO_DATE);
}

/** Both ends inclusive; neither runs past `today`, and `from` never past `to`. */
export function normaliseRange(range: DateRange, today: Date = new Date()): DateRange {
  const todayISO = format(today, ISO_DATE);
  let { from, to } = range;

  // Clamp both ends before ordering. Clamping only `to` leaves a range that
  // starts in the future, and swapping it afterwards would push `to` back out
  // past today.
  if (from > todayISO) from = todayISO;
  if (to > todayISO) to = todayISO;

  if (from > to) {
    // The user dragged the calendar right-to-left. Honour the intent by
    // swapping rather than rejecting the selection.
    [from, to] = [to, from];
  }
  return { from, to };
}

/** Inclusive day count — 10 Oct to 20 Oct is 11 days, not 10. */
export function rangeDayCount({ from, to }: DateRange): number {
  const start = parseISO(from);
  const end = parseISO(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  const MS_PER_DAY = 86_400_000;
  return Math.round((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;
}

/** "10 Oct – 20 Oct 2026", collapsing the year when both ends share it. */
export function formatRangeLabel({ from, to }: DateRange): string {
  const start = parseISO(from);
  const end = parseISO(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return `${from} – ${to}`;
  if (from === to) return format(end, 'd MMMM yyyy');
  if (start.getFullYear() === end.getFullYear()) {
    return `${format(start, 'd MMM')} – ${format(end, 'd MMM yyyy')}`;
  }
  return `${format(start, 'd MMM yyyy')} – ${format(end, 'd MMM yyyy')}`;
}

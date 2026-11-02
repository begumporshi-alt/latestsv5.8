import { endOfMonth, endOfQuarter, endOfYear, format, subMonths, subYears } from 'date-fns';

export const ISO_DATE = 'yyyy-MM-dd';

export interface AsOfPreset {
  id: string;
  label: string;
  hint: string;
  resolve: (now: Date) => Date;
}

/**
 * A balance sheet is a point-in-time statement, so the only meaningful choices
 * are period *ends*. Ranges are deliberately absent — "1–31 Oct" implies a
 * movement report, which this is not.
 *
 * The app has no fiscal-year setting (checked: `app_settings` holds company,
 * currency, inventory, notifications, pl_estimates, product_defaults,
 * quick_sell and vat), so these use calendar periods. If a fiscal year is ever
 * configured, quarter and year ends must follow it instead.
 */
export const AS_OF_PRESETS: AsOfPreset[] = [
  {
    id: 'today',
    label: 'Today',
    hint: 'Balances as of today',
    resolve: now => now,
  },
  {
    id: 'month-end',
    label: 'Month end',
    hint: 'Last day of the previous month',
    resolve: now => endOfMonth(subMonths(now, 1)),
  },
  {
    id: 'quarter-end',
    label: 'Quarter end',
    hint: 'Last day of the previous calendar quarter',
    // Three months back lands inside the previous quarter for every day of the
    // current one, so endOfQuarter() then resolves to that quarter's last day.
    resolve: now => endOfQuarter(subMonths(now, 3)),
  },
  {
    id: 'year-end',
    label: 'Year end',
    hint: 'Last day of the previous calendar year',
    resolve: now => endOfYear(subYears(now, 1)),
  },
];

export function resolvePresets(now: Date = new Date()): Array<AsOfPreset & { iso: string }> {
  return AS_OF_PRESETS.map(preset => ({
    ...preset,
    iso: format(preset.resolve(now), ISO_DATE),
  }));
}

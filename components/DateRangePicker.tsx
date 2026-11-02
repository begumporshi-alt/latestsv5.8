'use client';

import { useEffect, useMemo, useState } from 'react';
import { differenceInCalendarDays, format, isValid, parseISO } from 'date-fns';
import type { DateRange as DayPickerRange } from 'react-day-picker';
import { CalendarRange, ChevronDown, Loader2 } from 'lucide-react';

import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ISO_DATE } from '@/lib/as-of-presets';
import {
  formatRangeLabel,
  rangeDayCount,
  resolveRangePresets,
  type DateRange,
} from '@/lib/date-range';
import { cn } from '@/lib/utils';

export interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
  loading?: boolean;
  className?: string;
}

const toDay = (iso: string): Date | undefined => {
  const parsed = parseISO(iso);
  return isValid(parsed) ? parsed : undefined;
};

/**
 * From–To control for a closed window.
 *
 * Selection is staged in `draft` and only committed on Apply: a range calendar
 * emits `{from, to: undefined}` on the first click, and firing a query on that
 * intermediate state would show a one-day window for a moment every time.
 */
export function DateRangePicker({ value, onChange, loading, className }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DayPickerRange | undefined>();

  const selected = useMemo<DayPickerRange>(
    () => ({ from: toDay(value.from), to: toDay(value.to) }),
    [value.from, value.to]
  );

  // Re-seed the draft whenever the popover opens, so a cancelled edit never
  // lingers into the next open.
  useEffect(() => {
    if (open) setDraft(selected);
  }, [open, selected]);

  const presets = resolveRangePresets();
  const activePreset = presets.find(p => p.from === value.from && p.to === value.to);

  const draftFrom = draft?.from;
  const draftTo = draft?.to;
  const draftDays = draftFrom && draftTo ? differenceInCalendarDays(draftTo, draftFrom) + 1 : 0;
  const canApply = Boolean(draftFrom && draftTo);

  function apply() {
    if (!draftFrom || !draftTo) return;
    onChange({
      from: format(draftFrom, ISO_DATE),
      to: format(draftTo, ISO_DATE),
    });
    setOpen(false);
  }

  function commitPreset(preset: DateRange) {
    onChange({ from: preset.from, to: preset.to });
    setOpen(false);
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <span className="text-xs font-medium text-muted-foreground">Period</span>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Period ${formatRangeLabel(value)}. Change dates.`}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 text-sm transition hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
          >
            <CalendarRange className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium tabular-nums" suppressHydrationWarning>
              {formatRangeLabel(value)}
            </span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
              {rangeDayCount(value)}d
            </span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </PopoverTrigger>

        <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] p-0">
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2">
            {presets.map(preset => {
              const active = preset.from === value.from && preset.to === value.to;
              return (
                <button
                  key={preset.id}
                  type="button"
                  title={preset.hint}
                  aria-pressed={active}
                  onClick={() => commitPreset(preset)}
                  className={cn(
                    'rounded-md px-2 py-1 text-xs font-medium transition',
                    active
                      ? 'bg-blue-600 text-white'
                      : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>

          <div className="max-h-[min(70vh,34rem)] overflow-auto">
            <Calendar
              mode="range"
              numberOfMonths={2}
              selected={draft}
              defaultMonth={draft?.from ?? selected.from}
              onSelect={setDraft}
              disabled={{ after: new Date() }}
              initialFocus
            />
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2">
            <span className="text-[11px] text-muted-foreground" suppressHydrationWarning>
              {canApply
                ? `${format(draftFrom!, 'd MMM')} – ${format(draftTo!, 'd MMM yyyy')} · ${draftDays} ${draftDays === 1 ? 'day' : 'days'}`
                : 'Pick a start and an end date'}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={apply}
                disabled={!canApply}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                Apply
              </button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <div className="flex flex-wrap items-center gap-1">
        {presets.slice(0, 3).map(preset => (
          <button
            key={preset.id}
            type="button"
            title={preset.hint}
            aria-pressed={preset.id === activePreset?.id}
            onClick={() => onChange({ from: preset.from, to: preset.to })}
            className={cn(
              'rounded-lg px-2.5 py-1.5 text-xs font-medium transition',
              preset.id === activePreset?.id
                ? 'bg-blue-600 text-white'
                : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {loading && (
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Updating
        </span>
      )}
    </div>
  );
}

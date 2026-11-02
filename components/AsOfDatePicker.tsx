'use client';

import { useMemo, useState } from 'react';
import { format, isToday, isValid, parseISO } from 'date-fns';
import { CalendarDays, ChevronDown, Loader2 } from 'lucide-react';

import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ISO_DATE, resolvePresets } from '@/lib/as-of-presets';
import { cn } from '@/lib/utils';

export interface AsOfDatePickerProps {
  /** ISO yyyy-mm-dd. */
  value: string;
  onChange: (iso: string) => void;
  loading?: boolean;
  className?: string;
}

/**
 * "As of" control for point-in-time statements: preset period ends for the
 * common cases, a calendar for anything else. Presets are recomputed on every
 * render (four date operations — not worth memoising, and memoising on `value`
 * would freeze them across midnight).
 */
export function AsOfDatePicker({ value, onChange, loading, className }: AsOfDatePickerProps) {
  const [open, setOpen] = useState(false);

  const selected = useMemo(() => {
    const parsed = parseISO(value);
    return isValid(parsed) ? parsed : new Date();
  }, [value]);

  const presets = resolvePresets();

  function commit(date: Date) {
    onChange(format(date, ISO_DATE));
    setOpen(false);
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <span className="text-xs font-medium text-muted-foreground">As of</span>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Balances as of ${format(selected, 'd MMMM yyyy')}. Change date.`}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 text-sm transition hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
          >
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium tabular-nums" suppressHydrationWarning>
              {format(selected, 'EEE, d MMM yyyy')}
            </span>
            {isToday(selected) && (
              <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">
                Today
              </span>
            )}
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-0">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-muted-foreground">Balances as of</span>
            <button
              type="button"
              onClick={() => commit(new Date())}
              className="text-xs font-medium text-blue-600 hover:text-blue-700"
            >
              Today
            </button>
          </div>
          <Calendar
            mode="single"
            selected={selected}
            defaultMonth={selected}
            onSelect={day => day && commit(day)}
            disabled={{ after: new Date() }}
            initialFocus
          />
          <p className="max-w-[17rem] border-t border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            Includes every posted journal entry up to and including this date. Future dates are
            not available — there is nothing to report yet.
          </p>
        </PopoverContent>
      </Popover>

      <div className="flex flex-wrap items-center gap-1">
        {presets.map(preset => {
          const active = preset.iso === value;
          return (
            <button
              key={preset.id}
              type="button"
              title={preset.hint}
              aria-pressed={active}
              onClick={() => onChange(preset.iso)}
              className={cn(
                'rounded-lg px-2.5 py-1.5 text-xs font-medium transition',
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

      {loading && (
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Updating
        </span>
      )}
    </div>
  );
}

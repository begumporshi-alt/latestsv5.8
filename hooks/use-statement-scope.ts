'use client';

import { useEffect, useState } from 'react';
import { format, isValid, parseISO, startOfMonth } from 'date-fns';

import { localDateISO } from '@/lib/format';
import { normaliseRange, type DateRange } from '@/lib/date-range';

export type StatementMode = 'asOf' | 'range';

const ISO = 'yyyy-MM-dd';

/**
 * Date scope for the statement pages: either a single "as of" date or a closed
 * window.
 *
 * Mode is part of this hook rather than page state on purpose. If the page held
 * `mode` separately it would need an effect to switch modes after reading the
 * URL, and the fetch effect could then run once with the wrong scope — a wasted
 * round trip that also briefly renders the wrong numbers.
 *
 * `?from=&to=` opens in range mode; `?asOf=` opens as-of. Every setter rewrites
 * the URL with replaceState so the view is shareable and survives reload, and
 * clears the parameters belonging to the other mode so a stale `?asOf=` can
 * never shadow a range.
 */
export function useStatementScope() {
  const [mode, setModeState] = useState<StatementMode>('asOf');
  const [asOf, setAsOfState] = useState(localDateISO);
  const [range, setRangeState] = useState<DateRange>(() => ({
    from: format(startOfMonth(new Date()), ISO),
    to: localDateISO(),
  }));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const today = localDateISO();

    const pFrom = params.get('from');
    const pTo = params.get('to');
    const pAsOf = params.get('asOf');

    const parsedFrom = pFrom ? parseISO(pFrom) : null;
    const parsedTo = pTo ? parseISO(pTo) : null;
    const hasRange = (parsedFrom && isValid(parsedFrom)) || (parsedTo && isValid(parsedTo));

    if (hasRange) {
      setRangeState(prev =>
        normaliseRange({
          from: parsedFrom && isValid(parsedFrom) ? format(parsedFrom, ISO) : prev.from,
          to: parsedTo && isValid(parsedTo) ? format(parsedTo, ISO) : today,
        })
      );
      setModeState('range');
    } else if (pAsOf && isValid(parseISO(pAsOf))) {
      const iso = format(parseISO(pAsOf), ISO);
      setAsOfState(iso > today ? today : iso);
    }

    setReady(true);
  }, []);

  function writeUrl(mutate: (params: URLSearchParams) => void) {
    const url = new URL(window.location.href);
    mutate(url.searchParams);
    window.history.replaceState({}, '', url);
  }

  function setAsOf(next: string) {
    const today = localDateISO();
    const clamped = next > today ? today : next;
    setAsOfState(clamped);
    setModeState('asOf');
    writeUrl(params => {
      params.set('asOf', clamped);
      params.delete('from');
      params.delete('to');
    });
  }

  function setRange(next: DateRange) {
    const clamped = normaliseRange(next);
    setRangeState(clamped);
    setModeState('range');
    writeUrl(params => {
      params.set('from', clamped.from);
      params.set('to', clamped.to);
      params.delete('asOf');
    });
  }

  /**
   * Switching mode carries the anchor date across: a range becomes "as of" its
   * closing date, and an as-of date becomes the end of a window starting on the
   * 1st of that month. Round-trips without the numbers appearing to jump.
   */
  function setMode(next: StatementMode) {
    if (next === 'range') {
      const anchor = parseISO(asOf);
      const fallbackFrom = isValid(anchor) ? format(startOfMonth(anchor), ISO) : range.from;
      setRange({ from: range.from <= asOf ? range.from : fallbackFrom, to: asOf });
    } else {
      setAsOf(range.to);
    }
  }

  return { mode, setMode, asOf, setAsOf, range, setRange, ready };
}

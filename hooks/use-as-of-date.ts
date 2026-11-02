'use client';

import { useEffect, useState } from 'react';
import { format, isValid, parseISO } from 'date-fns';

import { localDateISO } from '@/lib/format';

/**
 * Shared "as of" state for point-in-time statements.
 *
 * - Reads `?asOf=` on mount and exposes `ready` so the first fetch can wait for
 *   it; otherwise a deep link costs a wasted round trip showing today first.
 * - Writes the chosen date back with replaceState, so the view can be shared,
 *   bookmarked or reloaded.
 * - Clamps future dates: there is nothing to report after today.
 *
 * `localDateISO()` is used rather than toISOString(), which returns yesterday
 * before 06:00 in Dhaka (see lib/format.ts).
 */
export function useAsOfDate() {
  const [asOf, setAsOfState] = useState(localDateISO);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get('asOf');
    if (param) {
      const parsed = parseISO(param);
      if (isValid(parsed)) {
        const iso = format(parsed, 'yyyy-MM-dd');
        setAsOfState(iso > localDateISO() ? localDateISO() : iso);
      }
    }
    setReady(true);
  }, []);

  function setAsOf(next: string) {
    const today = localDateISO();
    const clamped = next > today ? today : next;
    setAsOfState(clamped);

    const url = new URL(window.location.href);
    url.searchParams.set('asOf', clamped);
    window.history.replaceState({}, '', url);
  }

  return { asOf, setAsOf, ready };
}

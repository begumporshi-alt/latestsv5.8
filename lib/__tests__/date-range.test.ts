import {
  formatRangeLabel,
  normaliseRange,
  previousDayISO,
  rangeDayCount,
  resolveRangePresets,
} from '../date-range';

describe('previousDayISO', () => {
  it('returns the day before', () => {
    expect(previousDayISO('2026-10-10')).toBe('2026-10-09');
  });

  it('crosses a month boundary', () => {
    expect(previousDayISO('2026-10-01')).toBe('2026-09-30');
  });

  it('crosses a year boundary', () => {
    expect(previousDayISO('2026-01-01')).toBe('2025-12-31');
  });

  it('handles a leap day', () => {
    expect(previousDayISO('2024-03-01')).toBe('2024-02-29');
  });

  it('handles a non-leap February', () => {
    expect(previousDayISO('2026-03-01')).toBe('2026-02-28');
  });

  it('returns the input unchanged when it is not a date', () => {
    expect(previousDayISO('not-a-date')).toBe('not-a-date');
  });

  // The whole point of the helper: a 10–20 Oct window must open at the close of
  // 9 Oct, otherwise everything posted on the 10th is missing from the movement.
  it('never overlaps the first day of the window', () => {
    expect(previousDayISO('2026-10-10') < '2026-10-10').toBe(true);
  });
});

describe('rangeDayCount', () => {
  it('counts both ends inclusively', () => {
    expect(rangeDayCount({ from: '2026-10-10', to: '2026-10-20' })).toBe(11);
  });

  it('counts a single day as one', () => {
    expect(rangeDayCount({ from: '2026-10-20', to: '2026-10-20' })).toBe(1);
  });

  it('counts a whole month', () => {
    expect(rangeDayCount({ from: '2026-10-01', to: '2026-10-31' })).toBe(31);
  });

  it('counts across a year boundary', () => {
    expect(rangeDayCount({ from: '2025-12-28', to: '2026-01-03' })).toBe(7);
  });

  it('returns zero for unparseable dates', () => {
    expect(rangeDayCount({ from: 'x', to: 'y' })).toBe(0);
  });
});

describe('normaliseRange', () => {
  const today = new Date(2026, 10, 2); // 2 Nov 2026

  it('leaves a valid range alone', () => {
    expect(normaliseRange({ from: '2026-10-10', to: '2026-10-20' }, today)).toEqual({
      from: '2026-10-10',
      to: '2026-10-20',
    });
  });

  it('clamps an end date in the future', () => {
    expect(normaliseRange({ from: '2026-10-10', to: '2027-01-01' }, today)).toEqual({
      from: '2026-10-10',
      to: '2026-11-02',
    });
  });

  it('swaps a right-to-left selection instead of rejecting it', () => {
    expect(normaliseRange({ from: '2026-10-20', to: '2026-10-10' }, today)).toEqual({
      from: '2026-10-10',
      to: '2026-10-20',
    });
  });

  it('collapses to a single day when both ends are in the future', () => {
    expect(normaliseRange({ from: '2027-01-01', to: '2027-02-01' }, today)).toEqual({
      from: '2026-11-02',
      to: '2026-11-02',
    });
  });
});

describe('formatRangeLabel', () => {
  it('collapses a shared year', () => {
    expect(formatRangeLabel({ from: '2026-10-10', to: '2026-10-20' })).toBe('10 Oct – 20 Oct 2026');
  });

  it('spells out both years when they differ', () => {
    expect(formatRangeLabel({ from: '2025-12-28', to: '2026-01-03' })).toBe(
      '28 Dec 2025 – 3 Jan 2026'
    );
  });

  it('shows a single date when both ends match', () => {
    expect(formatRangeLabel({ from: '2026-10-20', to: '2026-10-20' })).toBe('20 October 2026');
  });

  it('falls back to the raw values when unparseable', () => {
    expect(formatRangeLabel({ from: 'x', to: 'y' })).toBe('x – y');
  });
});

describe('resolveRangePresets', () => {
  const now = new Date(2026, 10, 2); // 2 Nov 2026
  const presets = resolveRangePresets(now);
  const byId = (id: string) => presets.find(p => p.id === id)!;

  it('starts this month on the 1st and ends today', () => {
    expect(byId('this-month')).toMatchObject({ from: '2026-11-01', to: '2026-11-02' });
  });

  it('covers the whole of the previous month', () => {
    expect(byId('last-month')).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('returns 30 rolling days', () => {
    const preset = byId('last-30');
    expect(preset).toMatchObject({ from: '2026-10-04', to: '2026-11-02' });
    expect(rangeDayCount(preset)).toBe(30);
  });

  it('covers the whole of the previous calendar quarter', () => {
    expect(byId('last-quarter')).toMatchObject({ from: '2026-07-01', to: '2026-09-30' });
  });

  it('starts the year to date on 1 January', () => {
    expect(byId('year-to-date')).toMatchObject({ from: '2026-01-01', to: '2026-11-02' });
  });

  it('never returns a range that starts after it ends', () => {
    for (const preset of presets) {
      expect(preset.from <= preset.to).toBe(true);
    }
  });

  it('never returns a range ending in the future', () => {
    for (const preset of presets) {
      expect(preset.to <= '2026-11-02').toBe(true);
    }
  });

  it('resolves the previous quarter correctly from the first day of a quarter', () => {
    const q1 = resolveRangePresets(new Date(2026, 0, 1)); // 1 Jan 2026
    const lastQuarter = q1.find(p => p.id === 'last-quarter')!;
    expect(lastQuarter).toMatchObject({ from: '2025-10-01', to: '2025-12-31' });
  });
});

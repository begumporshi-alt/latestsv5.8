import { resolvePresets } from '../as-of-presets';

const at = (iso: string) => new Date(`${iso}T10:00:00`);
const isoFor = (nowIso: string, id: string) =>
  resolvePresets(at(nowIso)).find(p => p.id === id)?.iso;

describe('resolvePresets', () => {
  it('returns the four period-end presets in order', () => {
    expect(resolvePresets(at('2026-11-02')).map(p => p.id)).toEqual([
      'today',
      'month-end',
      'quarter-end',
      'year-end',
    ]);
  });

  it('resolves today to the current date', () => {
    expect(isoFor('2026-11-02', 'today')).toBe('2026-11-02');
  });

  it('resolves month end to the last day of the previous month', () => {
    expect(isoFor('2026-11-02', 'month-end')).toBe('2026-10-31');
  });

  it('crosses the year boundary for month end', () => {
    expect(isoFor('2026-01-15', 'month-end')).toBe('2025-12-31');
  });

  it('resolves quarter end to the previous calendar quarter', () => {
    expect(isoFor('2026-11-02', 'quarter-end')).toBe('2026-09-30');
    expect(isoFor('2026-07-01', 'quarter-end')).toBe('2026-06-30');
  });

  it('crosses the year boundary for quarter end', () => {
    expect(isoFor('2026-01-15', 'quarter-end')).toBe('2025-12-31');
    expect(isoFor('2026-03-31', 'quarter-end')).toBe('2025-12-31');
  });

  it('resolves year end to 31 December of the previous year', () => {
    expect(isoFor('2026-11-02', 'year-end')).toBe('2025-12-31');
    expect(isoFor('2026-12-31', 'year-end')).toBe('2025-12-31');
  });

  it('handles a leap day without rolling into March', () => {
    expect(isoFor('2024-02-29', 'month-end')).toBe('2024-01-31');
    expect(isoFor('2024-03-01', 'month-end')).toBe('2024-02-29');
  });

  it('never returns a date in the future', () => {
    const now = at('2026-11-02');
    for (const preset of resolvePresets(now)) {
      expect(preset.iso <= '2026-11-02').toBe(true);
    }
  });
});

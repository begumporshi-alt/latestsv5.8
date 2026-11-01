/**
 * Bounded waiting (lib/perf/within-budget).
 *
 * This exists because the POS grid could sit on its loading skeleton forever:
 * a wedged IndexedDB read never settles, so the `finally` that clears the
 * loading flag never ran and the cashier saw an empty shelf with no error.
 * These tests pin the four behaviours that matter, including the two that are
 * easy to get wrong — a late rejection becoming an unhandled rejection, and a
 * leaked timer holding the event loop open.
 */
import { withinBudget } from '../within-budget';

const never = <T,>() => new Promise<T>(() => {});
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('withinBudget', () => {
  test('returns the value when the work finishes inside the budget', async () => {
    const result = await withinBudget(Promise.resolve('fast'), 1_000, 'fallback');
    expect(result).toEqual({ value: 'fast', timedOut: false });
  });

  test('returns the fallback when the work never settles', async () => {
    const result = await withinBudget(never<string>(), 20, 'fallback');
    expect(result).toEqual({ value: 'fallback', timedOut: true });
  });

  test('returns the fallback when the work is merely slower than the budget', async () => {
    const slow = sleep(80).then(() => 'slow');
    const result = await withinBudget(slow, 20, 'fallback');
    expect(result.timedOut).toBe(true);
    expect(result.value).toBe('fallback');
    // The abandoned work still completes; it is not cancelled.
    await expect(slow).resolves.toBe('slow');
  });

  test('propagates a rejection that happens inside the budget', async () => {
    await expect(withinBudget(Promise.reject(new Error('boom')), 1_000, 'fallback')).rejects.toThrow('boom');
  });

  test('a rejection after the budget expired does not surface as unhandled', async () => {
    // The dangerous shape: the caller has already moved on, and `work` rejects
    // later with nothing listening to it.
    const lateFailure = sleep(60).then(() => {
      throw new Error('late');
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      const result = await withinBudget(lateFailure, 10, 'fallback');
      expect(result.timedOut).toBe(true);
      // Give the late rejection time to fire.
      await sleep(120);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('calls onExpire once, and only when the budget actually expires', async () => {
    const hit: string[] = [];
    await withinBudget(Promise.resolve(1), 1_000, 0, () => hit.push('expired'));
    expect(hit).toEqual([]);

    await withinBudget(never<number>(), 10, 0, () => hit.push('expired'));
    expect(hit).toEqual(['expired']);
  });

  test('a throwing onExpire does not break the fallback', async () => {
    const result = await withinBudget(never<number>(), 10, 42, () => {
      throw new Error('reporting failed');
    });
    expect(result).toEqual({ value: 42, timedOut: true });
  });

  test('clears its timer on a fast resolution', async () => {
    const before = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.().length;
    await withinBudget(Promise.resolve('x'), 60_000, 'fallback');
    const after = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.().length;
    // A leaked 60s timer would keep a handle alive and delay process exit.
    if (typeof before === 'number' && typeof after === 'number') {
      expect(after).toBeLessThanOrEqual(before);
    }
  });
});

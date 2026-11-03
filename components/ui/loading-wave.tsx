import { cn } from '@/lib/utils';

interface LoadingWaveProps {
  /** Bar width. Sized per card to approximate the figure it will replace, so
   *  the row does not visibly reflow when the number lands. */
  width?: string;
  /** Per-card offset into the sweep loop. Without it every bar in the grid
   *  pulses on the same beat, which reads as a glitch rather than as loading. */
  delayMs?: number;
  className?: string;
}

/**
 * Placeholder for a figure that has not arrived yet.
 *
 * A bare shimmer was rejected in favour of a travelling light band: at this
 * height (14px, under a 20px bold value) a sine squiggle reads as a sparkline
 * that failed to load, whereas a filled pill with a wave of light passing
 * through it reads unambiguously as "this number is on its way".
 *
 * The band is a separate element rather than a pseudo-element so the animation
 * can be offset per instance without generating a class per delay.
 */
export function LoadingWave({ width = '70%', delayMs = 0, className }: LoadingWaveProps) {
  return (
    <span
      aria-hidden="true"
      className={cn('loading-wave block h-3.5 overflow-hidden rounded-full', className)}
      style={{ width }}
    >
      <span
        className="loading-wave-sheen"
        style={delayMs ? { animationDelay: `${delayMs}ms` } : undefined}
      />
    </span>
  );
}

/**
 * The value slot a KPI figure occupies: same 28px line box as `text-xl`, so
 * swapping a wave for a number never changes the card's height.
 */
export function StatValueSlot({ children }: { children: React.ReactNode }) {
  return <div className="mt-0.5 flex h-7 items-center">{children}</div>;
}

/* ------------------------------------------------------------------ */
/* List + chart placeholders                                            */
/* ------------------------------------------------------------------ */

const LEADING: Record<string, string> = {
  avatar: 'w-6 h-6 rounded-full',
  icon: 'w-7 h-7 rounded-lg',
  thumb: 'w-9 h-9 rounded-lg',
  none: '',
};

interface LoadingRowsProps {
  rows?: number;
  /** Mirrors the row's real leading element so the row keeps its height. */
  leading?: 'avatar' | 'icon' | 'thumb' | 'none';
  /** Two-line rows (title + subtitle) rather than one. */
  lines?: 1 | 2;
  /** A right-aligned value column (amount, count). */
  trailing?: boolean;
  startDelay?: number;
}

/**
 * Row placeholder for the dashboard's list cards.
 *
 * The rows are shaped like the ones they stand in for — same leading element,
 * same line count — because an empty list collapses the card, and the whole
 * three-column grid then jumps when the data lands.
 */
export function LoadingRows({
  rows = 4,
  leading = 'none',
  lines = 1,
  trailing = false,
  startDelay = 0,
}: LoadingRowsProps) {
  return (
    <div className="space-y-2.5" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => {
        const delay = startDelay + i * 90;
        return (
          <div key={i} className="flex items-center gap-2.5">
            {leading !== 'none' && <div className={cn('shrink-0 bg-muted', LEADING[leading])} />}
            <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
              <div className={cn('flex items-center', lines === 2 ? 'h-4' : 'h-5')}>
                <LoadingWave width={lines === 2 ? '66%' : '58%'} delayMs={delay} />
              </div>
              {lines === 2 && (
                <div className="flex h-2.5 items-center">
                  <LoadingWave width="38%" delayMs={delay + 45} className="h-2" />
                </div>
              )}
            </div>
            {trailing && <LoadingWave width="16%" delayMs={delay} />}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Chart placeholder: the full plot area as one block, with the chart's own
 * dashed grid laid over it.
 *
 * A single narrow bar floating in the middle was tried first and read as a
 * progress bar; three stacked bars read as a bar chart that had already
 * loaded. A block with a grid is the only version that says "a chart is
 * coming" without implying a series.
 */
export function LoadingChart({ height = 240 }: { height?: number }) {
  return (
    <div className="relative" style={{ height }} aria-hidden="true">
      <LoadingWave width="100%" className="h-full w-full rounded-lg" />
      <div className="absolute inset-0 flex flex-col justify-between py-2 opacity-60">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="border-t border-dashed border-white" />
        ))}
      </div>
    </div>
  );
}

/**
 * Donut placeholder. 130px outer / 23px ring matches the real chart's
 * innerRadius 42 + outerRadius 65, so the legend beside it does not shift.
 */
export function LoadingDonut({ delayMs = 0 }: { delayMs?: number }) {
  return (
    <div className="flex items-center gap-4" aria-hidden="true">
      <div className="flex w-[140px] shrink-0 items-center justify-center">
        <div className="h-[130px] w-[130px] rounded-full border-[23px] border-muted" />
      </div>
      <div className="flex-1 space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="h-2 w-2 shrink-0 rounded-full bg-muted" />
            <LoadingWave width="58%" delayMs={delayMs + i * 90} className="h-2.5" />
            <LoadingWave width="13%" delayMs={delayMs + i * 90 + 45} className="ml-auto h-2.5" />
          </div>
        ))}
      </div>
    </div>
  );
}

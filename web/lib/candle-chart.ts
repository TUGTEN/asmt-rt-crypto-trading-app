/**
 * The one door into the chart library.
 *
 * `lightweight-charts` draws; it does not decide. Everything it is handed is
 * built here, from the candles our own aggregation produced (`lib/candles.ts`),
 * which is what `docs/SEAMS.md` Slice C means by "the lib only draws what our
 * code supplies". There is no fetch in this module, and the component that owns
 * the chart writes to its series only through `renderCandles`.
 *
 * The second job here is re-render manners (SPEC story 10). A forming bucket
 * arrives several times a second, and rebuilding a 120-candle series each time
 * is both wasteful and visibly different from moving one candle: so an
 * extension of what is already on screen goes in as a single `update()`, and
 * only a series that is *not* an extension is rebuilt with `setData()`.
 *
 * The library's types are imported for the drawing payloads only — no runtime
 * import — so this module stays a pure function of our candles and a test can
 * drive it with a recording stub instead of a canvas.
 */

import type { CandlestickData, HistogramData, Time, UTCTimestamp } from "lightweight-charts";

import { candleSeconds } from "@/lib/candles";
import { parseDecimal } from "@/lib/format";
import type { Candle } from "@/lib/protocol";

/** One drawn candlestick, in the library's shape. */
export type CandleBar = CandlestickData<Time>;
/** One drawn volume column, in the library's shape. */
export type VolumeBar = HistogramData<Time>;

/** The candle colours, read from the theme by the component (no hex lives here). */
export type CandleColors = { up: string; down: string };

/** The slice of a series this module needs: write the whole thing, or the tail. */
export type SeriesTarget<Bar> = {
  setData(bars: Bar[]): void;
  update(bar: Bar): void;
};

/** The two series the chart draws: price and volume. */
export type ChartTargets = {
  candles: SeriesTarget<CandleBar>;
  volume: SeriesTarget<VolumeBar>;
};

/**
 * What has to happen to bring the chart up to date: nothing, a single candle,
 * or the whole series.
 */
export type ChartPlan =
  | { kind: "none" }
  | { kind: "set"; candles: CandleBar[]; volume: VolumeBar[] }
  | { kind: "update"; candle: CandleBar; volume: VolumeBar | null };

/** Our candle as a drawn bar, or `null` when a value cannot be read as a number. */
export function toCandleBar(candle: Candle): CandleBar | null {
  const seconds = candleSeconds(candle.t);
  if (seconds === null) {
    return null;
  }
  const open = parseDecimal(candle.o);
  const high = parseDecimal(candle.h);
  const low = parseDecimal(candle.l);
  const close = parseDecimal(candle.c);
  if (open === null || high === null || low === null || close === null) {
    return null;
  }
  return { time: seconds as UTCTimestamp, open, high, low, close };
}

/**
 * The volume column for a candle, coloured by *our* open/close comparison
 * rather than by whatever the library decided the bar looks like.
 */
export function toVolumeBar(candle: Candle, colors: CandleColors): VolumeBar | null {
  const bar = toCandleBar(candle);
  const value = parseDecimal(candle.v);
  if (bar === null || value === null) {
    return null;
  }
  return { time: bar.time, value, color: bar.close >= bar.open ? colors.up : colors.down };
}

/** Whether `next` carries `previous` as its prefix (same buckets, same values). */
function extendsSeries(previous: readonly Candle[], next: readonly Candle[], length: number): boolean {
  for (let index = 0; index < length; index += 1) {
    const before = previous[index];
    const after = next[index];
    if (before === undefined || after === undefined) {
      return false;
    }
    if (
      before.t !== after.t ||
      before.o !== after.o ||
      before.h !== after.h ||
      before.l !== after.l ||
      before.c !== after.c ||
      before.v !== after.v
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Decide what the chart needs. `previous` is the series already drawn — the
 * adapter's own record, not the library's.
 */
export function planChartRender(previous: readonly Candle[], next: readonly Candle[]): ChartPlan {
  if (previous === next) {
    // The store keeps identity when nothing changed, so this is the common
    // quiet tick — and the cheap answer to "did anything move?".
    return { kind: "none" };
  }

  if (next.length === 0) {
    // An empty chart is a state of its own (SEAMS Slice C): clear it, so a
    // previous interval's candles can never linger on screen.
    return previous.length === 0 ? { kind: "none" } : { kind: "set", candles: [], volume: [] };
  }

  // An empty series is written whole rather than grown one candle at a time:
  // `update()` onto nothing is not a rebuild, it is a guess.
  if (previous.length === 0) {
    return { kind: "set", candles: collectBars(next), volume: [] };
  }

  if (next.length === previous.length + 1 && extendsSeries(previous, next, previous.length)) {
    const tail = next[next.length - 1];
    // Guard the common path too: a bar we cannot read is worth waiting a tick
    // for, not worth handing the library a NaN.
    const bar = toCandleBar(tail);
    return bar === null ? { kind: "none" } : { kind: "update", candle: bar, volume: null };
  }

  if (next.length === previous.length && extendsSeries(previous, next, next.length - 1)) {
    const tail = next[next.length - 1];
    const bar = toCandleBar(tail);
    if (bar === null) {
      return { kind: "none" };
    }
    return { kind: "update", candle: bar, volume: null };
  }

  return { kind: "set", candles: collectBars(next), volume: [] };
}

/** Our bars, skipping any candle the library could not draw. */
function collectBars(series: readonly Candle[]): CandleBar[] {
  const bars: CandleBar[] = [];
  for (const candle of series) {
    const bar = toCandleBar(candle);
    if (bar !== null) {
      bars.push(bar);
    }
  }
  return bars;
}

/**
 * Bring the chart up to date with our series, and nothing else.
 *
 * Returns the plan it applied so the caller can follow up on a rebuild (fitting
 * the visible range to a fresh interval) without deciding it twice.
 */
export function renderCandles(
  targets: ChartTargets,
  previous: readonly Candle[],
  next: readonly Candle[],
  colors: CandleColors,
): ChartPlan {
  const plan = planChartRender(previous, next);

  switch (plan.kind) {
    case "none":
      return plan;
    case "set": {
      const volume: VolumeBar[] = [];
      for (const candle of next) {
        const bar = toVolumeBar(candle, colors);
        if (bar !== null) {
          volume.push(bar);
        }
      }
      targets.candles.setData(plan.candles);
      targets.volume.setData(volume);
      return { ...plan, volume };
    }
    case "update": {
      const candle = next[next.length - 1];
      const volume = candle === undefined ? null : toVolumeBar(candle, colors);
      targets.candles.update(plan.candle);
      if (volume !== null) {
        targets.volume.update(volume);
      }
      return { kind: "update", candle: plan.candle, volume };
    }
  }
}

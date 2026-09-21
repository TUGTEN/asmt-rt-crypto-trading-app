/**
 * The candle series, as our own aggregation of what the backend sent.
 *
 * Two doors feed it — `GET /api/history` (finished buckets, oldest first) and
 * `candle` frames on the socket (finished buckets as they close, plus the one
 * still forming) — and this module is where they become one series with one
 * entry per bucket. `docs/SEAMS.md` Slice C asks for exactly that: duplicates
 * collapse, and the chart's series is our aggregation rather than the chart
 * library's opinion about it.
 *
 * The candles stay decimal *strings* here, exactly as the wire carried them;
 * `lib/candle-chart.ts` is the only place they become numbers, and only for
 * drawing. Plain functions over plain arrays: no React, no DOM, no chart, no
 * network.
 */

import type { Candle } from "@/lib/protocol";

/** Bucket length in milliseconds; the chart's axis and the feed agree on these. */
export const CANDLE_INTERVAL_MS = { "1s": 1000, "1m": 60_000 } as const;

/**
 * Where a candle's timestamp belongs on the chart's axis: epoch **seconds**,
 * which is the unit `lib/candle-chart.ts` hands the library. `null` when the
 * timestamp cannot be read, so a candle that cannot be placed is dropped
 * instead of being drawn at a made-up position.
 */
export function candleSeconds(t: string): number | null {
  const parsed = Date.parse(t);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return Math.floor(parsed / 1000);
}

/** Whether two candles are the same bucket with the same values. */
function sameCandle(a: Candle, b: Candle): boolean {
  return a.t === b.t && a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.v === b.v;
}

/**
 * Insert or replace one candle, keeping the series oldest-first with one entry
 * per bucket.
 *
 * Frames repeat: the socket re-sends the forming bucket on every tick, and a
 * reconnect can deliver a bucket the history request already covered. Both land
 * here and replace rather than append. A frame that changes nothing returns the
 * same array by identity — the store writes state on change, and the chart
 * redraws on identity, so a repeated frame costs neither.
 */
export function upsertCandle(series: readonly Candle[], candle: Candle): readonly Candle[] {
  const seconds = candleSeconds(candle.t);
  if (seconds === null) {
    return series;
  }

  const at = series.findIndex((entry) => entry.t === candle.t);
  if (at >= 0) {
    if (sameCandle(series[at], candle)) {
      return series;
    }
    const next = [...series];
    next[at] = candle;
    return next;
  }

  // The common case by far: the next bucket in order.
  const last = series[series.length - 1];
  if (last === undefined || seconds > (candleSeconds(last.t) ?? 0)) {
    return [...series, candle];
  }

  // Late or out-of-order: placed where its timestamp belongs, so the axis stays
  // monotonic whatever order the frames arrived in.
  const next = [...series];
  let insert = next.length;
  while (insert > 0 && (candleSeconds(next[insert - 1].t) ?? 0) > seconds) {
    insert -= 1;
  }
  next.splice(insert, 0, candle);
  return next;
}

/**
 * History plus the bucket still forming: the series the chart draws.
 *
 * One entry per timestamp, with a *finished* bucket outranking the same bucket
 * still forming — the completed frame is the feed's final aggregate for it, and
 * the two are the same bucket. Returns `history` untouched (by identity) when no
 * bucket is forming, which is the state between ticks.
 */
export function mergeSeries(history: readonly Candle[], active: Candle | null): readonly Candle[] {
  if (active === null) {
    return history;
  }
  if (history.some((entry) => entry.t === active.t)) {
    return history;
  }
  return [...history, active];
}

/**
 * The candle at a chart-axis second, or `null`.
 *
 * This is how inspection stays ours: the library reports the axis position the
 * pointer is over, and the readout is built from the candle this module holds —
 * never from the library's copy of the data.
 */
export function findCandleAtSeconds(series: readonly Candle[], seconds: number): Candle | null {
  if (!Number.isFinite(seconds)) {
    return null;
  }
  return series.find((entry) => candleSeconds(entry.t) === seconds) ?? null;
}

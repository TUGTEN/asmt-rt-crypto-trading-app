import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  planChartRender,
  renderCandles,
  type CandleBar,
  type ChartTargets,
  type VolumeBar,
} from "@/lib/candle-chart";
import { candleSeconds, mergeSeries, upsertCandle } from "@/lib/candles";
import type { Candle, CandleFrame } from "@/lib/protocol";

/**
 * The one door into the chart library.
 *
 * `docs/SEAMS.md` Slice C puts the rule this way: "hover/drag inspection reads
 * the aggregated candle values, not chart-library internals (the lib only draws
 * what our code supplies)". So this file drives the adapter with a fake pair of
 * series and asserts what the library is handed: our own OHLCV, nothing
 * recomputed, nothing invented, and no request of its own.
 *
 * It also pins the re-render manners: a live bucket extends the series with
 * `update()` (a single candle), and only a series that is not an extension of
 * what is on screen — an interval switch, a history refetch that disagrees, an
 * emptied chart — is rebuilt with `setData()`.
 */

const BASE = Date.parse("2026-09-19T14:18:11.000Z") / 1000;

function at(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function candle(seconds: number, close = "65100.00", open = "65000.00"): Candle {
  return {
    t: at(seconds),
    o: open,
    h: "65150.00",
    l: "64950.00",
    c: close,
    v: "0.250000",
  };
}

/** One frame as the socket delivers it, turned into the candle our store holds. */
function frameCandle(seconds: number, close: string, complete: boolean): Candle {
  const frame: CandleFrame = {
    type: "candle",
    interval: "1s",
    t: at(seconds),
    o: "65000.00",
    h: "65150.00",
    l: "64950.00",
    c: close,
    v: "0.250000",
    complete,
  };
  const { type, interval, complete: done, ...aggregated } = frame;
  expect(type).toBe("candle");
  expect(interval).toBe("1s");
  expect(done).toBe(complete);
  return aggregated;
}

type Recorded<Bar> = { sets: Bar[][]; updates: Bar[] };

function recording<Bar>(): Recorded<Bar> & { setData(bars: Bar[]): void; update(bar: Bar): void } {
  const record: Recorded<Bar> = { sets: [], updates: [] };
  return {
    ...record,
    get sets() {
      return record.sets;
    },
    get updates() {
      return record.updates;
    },
    setData(bars: Bar[]): void {
      record.sets.push(bars);
    },
    update(bar: Bar): void {
      record.updates.push(bar);
    },
  };
}

function targets(): ChartTargets & { candles: Recorded<CandleBar>; volume: Recorded<VolumeBar> } {
  const candles = recording<CandleBar>();
  const volume = recording<VolumeBar>();
  return { candles, volume };
}

const UP = "#2ecc8f";
const DOWN = "#f2555a";

describe("the chart's data path", () => {
  const fetchMock = vi.fn<() => Promise<Response>>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hands the library bars built from our aggregation, and never fetches", () => {
    // The wire frames go into the series the way the store builds it: history
    // through `upsertCandle`, the forming bucket through `mergeSeries`.
    const finished = upsertCandle([], frameCandle(BASE, "65100.00", true));
    const series = mergeSeries(finished, frameCandle(BASE + 1, "65200.00", false));
    const target = targets();

    renderCandles(target, [], series, { up: UP, down: DOWN });

    const bars = target.candles.sets[0];
    expect(bars).toHaveLength(2);
    expect(bars[0]).toEqual({
      time: BASE,
      open: 65000,
      high: 65150,
      low: 64950,
      close: 65100,
    });
    expect(bars[1].close).toBe(65200);
    // The library is a consumer: it fetched nothing to draw this.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("colours volume from our own open/close, not from the library's render", () => {
    const target = targets();
    const series = [candle(BASE, "65200.00"), candle(BASE + 1, "64900.00")];

    renderCandles(target, [], series, { up: UP, down: DOWN });

    expect(target.volume.sets[0]).toEqual([
      { time: BASE, value: 0.25, color: UP },
      { time: BASE + 1, value: 0.25, color: DOWN },
    ]);
  });

  it("extends the series with a single candle when the live bucket moves", () => {
    const first = [candle(BASE), candle(BASE + 1)];
    const next = [...first, candle(BASE + 2, "65300.00")];
    const target = targets();

    renderCandles(target, first, next, { up: UP, down: DOWN });

    expect(target.candles.sets).toEqual([]);
    expect(target.volume.sets).toEqual([]);
    expect(target.candles.updates).toEqual([
      { time: BASE + 2, open: 65000, high: 65150, low: 64950, close: 65300 },
    ]);
    expect(target.volume.updates).toHaveLength(1);
  });

  it("updates the forming bucket in place instead of rebuilding the series", () => {
    const first = [candle(BASE), candle(BASE + 1, "65100.00")];
    const next = [first[0], candle(BASE + 1, "65180.00")];
    const target = targets();

    renderCandles(target, first, next, { up: UP, down: DOWN });

    expect(target.candles.sets).toEqual([]);
    expect(target.candles.updates[0].close).toBe(65180);
  });

  it("rebuilds when the new series is not an extension of the old one", () => {
    const previous = [candle(BASE), candle(BASE + 1)];
    const switched = [candle(BASE + 500), candle(BASE + 560)];
    const target = targets();

    renderCandles(target, previous, switched, { up: UP, down: DOWN });

    expect(target.candles.sets[0]).toHaveLength(2);
    expect(target.candles.updates).toEqual([]);
  });

  it("clears the chart explicitly when there is nothing to draw", () => {
    const previous = [candle(BASE)];
    const target = targets();

    expect(planChartRender(previous, []).kind).toBe("set");
    renderCandles(target, previous, [], { up: UP, down: DOWN });

    expect(target.candles.sets).toEqual([[]]);
    expect(target.candles.updates).toEqual([]);
  });

  it("touches nothing when the series did not change", () => {
    const series = [candle(BASE)];
    const target = targets();

    expect(planChartRender(series, series).kind).toBe("none");
    renderCandles(target, series, series, { up: UP, down: DOWN });

    expect(target.candles.sets).toEqual([]);
    expect(target.candles.updates).toEqual([]);
  });

  it("skips a value it cannot read rather than handing the chart a NaN", () => {
    const target = targets();
    const broken = { ...candle(BASE + 1), c: "" };
    const series = [candle(BASE), broken];

    renderCandles(target, [], series, { up: UP, down: DOWN });

    expect(target.candles.sets[0]).toHaveLength(1);
    expect(target.volume.sets[0]).toHaveLength(1);
  });

  it("leaves the chart alone when the tail it would update is unreadable", () => {
    const first = [candle(BASE)];
    const broken = [{ ...candle(BASE), c: "nope" }];
    const target = targets();

    expect(planChartRender(first, broken).kind).toBe("none");
    renderCandles(target, first, broken, { up: UP, down: DOWN });

    expect(target.candles.updates).toEqual([]);
    expect(target.candles.sets).toEqual([]);
  });
});

describe("inspection", () => {
  it("resolves the crosshair's time back to our candle, not the library's copy", () => {
    const series = mergeSeries([candle(BASE), candle(BASE + 1)], candle(BASE + 2, "65400.00"));
    const target = targets();

    renderCandles(target, [], series, { up: UP, down: DOWN });
    const bar = target.candles.sets[0][2];

    // The library reports a time; the readout is built from the candle we own.
    const inspected = series.find((entry) => candleSeconds(entry.t) === Number(bar.time));
    expect(inspected).toBe(series[2]);
    expect(inspected?.v).toBe("0.250000");
  });
});

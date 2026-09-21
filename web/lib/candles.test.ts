import { describe, expect, it } from "vitest";

import { candleSeconds, findCandleAtSeconds, mergeSeries, upsertCandle } from "@/lib/candles";
import type { Candle, CandleFrame } from "@/lib/protocol";

/**
 * The candle series, before any chart library sees it.
 *
 * `docs/SEAMS.md` Slice C asks for two things this file pins: duplicate candles
 * collapse to one, and history plus the live bucket form a single series with
 * one entry per bucket. Everything here is a plain array transform — no React,
 * no DOM, no chart — which is what lets the drawing layer be a consumer of our
 * aggregation rather than a second opinion about it.
 */

/** The epoch second the bucket starts at, as the wire writes it. */
function at(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

const BASE = Date.parse("2026-09-19T14:18:11.000Z") / 1000;

function candle(seconds: number, close = "65100.00"): Candle {
  return {
    t: at(seconds),
    o: "65000.00",
    h: "65150.00",
    l: "64950.00",
    c: close,
    v: "0.250000",
  };
}

function history(seconds: number[]): Candle[] {
  return seconds.map((second) => candle(second));
}

describe("candleSeconds", () => {
  it("maps the wire timestamp to the second the chart axis uses", () => {
    expect(candleSeconds("2026-09-19T14:18:11Z")).toBe(BASE);
    expect(candleSeconds("2026-09-19T14:18:11.000Z")).toBe(BASE);
  });

  it("refuses to place a timestamp it cannot read on the axis", () => {
    expect(candleSeconds("")).toBeNull();
    expect(candleSeconds("not a time")).toBeNull();
    expect(candleSeconds("2026-13-45T99:99:99Z")).toBeNull();
  });
});

describe("upsertCandle", () => {
  it("collapses a duplicate bucket instead of drawing two candles for it", () => {
    const once = upsertCandle([], candle(BASE));
    const twice = upsertCandle(once, candle(BASE, "65200.00"));

    expect(twice).toHaveLength(1);
    expect(twice[0].c).toBe("65200.00");
  });

  it("appends the next bucket, and inserts a late one where its timestamp belongs", () => {
    const series = history([BASE, BASE + 2]);
    const appended = upsertCandle(series, candle(BASE + 3));
    const inserted = upsertCandle(appended, candle(BASE + 1));

    expect(inserted.map((entry) => candleSeconds(entry.t))).toEqual([
      BASE,
      BASE + 1,
      BASE + 2,
      BASE + 3,
    ]);
  });

  it("drops a candle whose timestamp cannot be placed on the axis", () => {
    const series = history([BASE]);
    expect(upsertCandle(series, { ...candle(BASE + 1), t: "nonsense" })).toBe(series);
  });

  it("keeps the same array when a repeated frame changes nothing", () => {
    const series = history([BASE]);
    // Identity matters: the store writes state on change, and the chart redraws
    // on identity. A re-sent identical bucket must cost neither.
    expect(upsertCandle(series, { ...series[0] })).toBe(series);
  });
});

describe("mergeSeries", () => {
  it("returns the history untouched when no bucket is forming", () => {
    const series = history([BASE, BASE + 1]);
    expect(mergeSeries(series, null)).toBe(series);
  });

  it("puts the live bucket after the finished ones", () => {
    const series = mergeSeries(history([BASE, BASE + 1]), candle(BASE + 2, "65300.00"));

    expect(series).toHaveLength(3);
    expect(candleSeconds(series[2].t)).toBe(BASE + 2);
    expect(series[2].c).toBe("65300.00");
  });

  it("keeps one entry per timestamp: a finished bucket outranks the same bucket still forming", () => {
    const finished = history([BASE]);
    const merged = mergeSeries(finished, candle(BASE, "99999.00"));

    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(finished[0]);
    expect(merged[0].c).toBe("65100.00");
  });

  it("never mutates the arrays it is given", () => {
    const finished = history([BASE]);
    const live = candle(BASE + 1);
    const snapshot = [...finished];

    mergeSeries(finished, live);
    upsertCandle(finished, candle(BASE + 5));

    expect(finished).toEqual(snapshot);
  });
});

describe("findCandleAtSeconds", () => {
  it("resolves the second the chart reports back to our own candle", () => {
    const series = mergeSeries(history([BASE, BASE + 1]), candle(BASE + 2));
    const target = series[1];

    expect(findCandleAtSeconds(series, candleSeconds(target.t) ?? -1)).toBe(target);
  });

  it("returns null for a second no candle covers", () => {
    const series = history([BASE]);
    expect(findCandleAtSeconds(series, BASE + 30)).toBeNull();
    expect(findCandleAtSeconds(series, Number.NaN)).toBeNull();
  });
});

describe("the wire shape", () => {
  it("reads candles exactly as `docs/PROTOCOL.md` writes them", () => {
    const frame: CandleFrame = {
      type: "candle",
      interval: "1s",
      t: "2026-09-19T14:18:11Z",
      o: "65000.00",
      h: "65150.00",
      l: "64950.00",
      c: "65100.00",
      v: "0.250000",
      complete: true,
    };
    const { type, interval, complete, ...aggregated } = frame;

    expect(type).toBe("candle");
    expect(interval).toBe("1s");
    expect(complete).toBe(true);
    expect(mergeSeries([], aggregated)).toEqual([aggregated]);
  });
});

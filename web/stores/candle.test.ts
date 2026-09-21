import { describe, expect, it } from "vitest";

import { candleSeconds } from "@/lib/candles";
import type { Candle, CandleFrame } from "@/lib/protocol";
import {
  applyCandleFrame,
  applyHistory,
  failHistory,
  invalidateHistory,
  requestHistory,
  selectActiveCandle,
  selectHasCandles,
  selectHistory,
  selectHistoryStatus,
  selectInterval,
  switchInterval,
  createCandleStore,
  INITIAL_CANDLE_STATE,
} from "@/stores/candle";

/**
 * The chart's live state, where the two doors onto the market meet.
 *
 * Two claims in `docs/SEAMS.md` Slice C are decided here and nowhere else:
 * a response that finishes after the interval changed is dropped (the request
 * id, plus the interval the response echoes), and duplicate candles collapse to
 * one. The store holds the fields; these functions are the writers, so the
 * socket can push a frame in without a React layer in its module graph.
 */

const BASE = Date.parse("2026-09-19T14:18:11.000Z") / 1000;

function at(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function candle(seconds: number, close = "65100.00"): Candle {
  return { t: at(seconds), o: "65000.00", h: "65150.00", l: "64950.00", c: close, v: "0.250000" };
}

function frame(seconds: number, close: string, complete: boolean): CandleFrame {
  return {
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
}

describe("the candle store", () => {
  it("starts on the shortest interval, with an explicit empty series", () => {
    expect(createCandleStore().getState()).toEqual({
      interval: "1s",
      history: [],
      activeCandle: null,
      requestId: 0,
      historyEpoch: 0,
      historyStatus: "loading",
      historyError: null,
    });
    expect(INITIAL_CANDLE_STATE.requestId).toBe(0);
  });

  it("drops the old interval's candles when the interval changes", () => {
    const store = createCandleStore();
    const id = requestHistory(store, "1s");
    applyHistory(store, id, { interval: "1s", candles: [candle(BASE)] });
    applyCandleFrame(store, frame(BASE + 1, "65200.00", false));

    switchInterval(store, "1m");

    expect(selectInterval(store.getState())).toBe("1m");
    // No ghost candles: the chart is empty and waiting, not showing 1s buckets.
    expect(selectHistory(store.getState())).toEqual([]);
    expect(selectActiveCandle(store.getState())).toBeNull();
    expect(selectHistoryStatus(store.getState())).toBe("loading");
    expect(selectHasCandles(store.getState())).toBe(false);
  });

  it("leaves the open interval alone when it is the one selected again", () => {
    const store = createCandleStore();
    const id = requestHistory(store, "1s");
    applyHistory(store, id, { interval: "1s", candles: [candle(BASE)] });

    switchInterval(store, "1s");

    expect(selectHistory(store.getState())).toHaveLength(1);
    expect(selectHistoryStatus(store.getState())).toBe("ready");
  });

  it("opens a fresh request id per request, and marks the series loading", () => {
    const store = createCandleStore();
    const first = requestHistory(store, "1s");
    const second = requestHistory(store, "1s");

    expect(second).toBe(first + 1);
    expect(selectHistoryStatus(store.getState())).toBe("loading");
  });

  it("keeps the candles on screen while re-reading the same interval", () => {
    const store = createCandleStore();
    const id = requestHistory(store, "1s");
    applyHistory(store, id, { interval: "1s", candles: [candle(BASE), candle(BASE + 1)] });

    const refresh = requestHistory(store, "1s");

    expect(refresh).toBe(id + 1);
    expect(selectHistory(store.getState())).toHaveLength(2);
    expect(selectHistoryStatus(store.getState())).toBe("refreshing");
  });

  it("lands history under the id that asked for it, and says so", () => {
    const store = createCandleStore();
    const id = requestHistory(store, "1s");

    applyHistory(store, id, { interval: "1s", candles: [candle(BASE), candle(BASE + 1)] });

    expect(selectHistory(store.getState()).map((entry) => candleSeconds(entry.t))).toEqual([
      BASE,
      BASE + 1,
    ]);
    expect(selectHistoryStatus(store.getState())).toBe("ready");
  });

  it("renders an empty history as ready-and-empty, not as a chart still loading", () => {
    const store = createCandleStore();
    const id = requestHistory(store, "1s");

    applyHistory(store, id, { interval: "1s", candles: [] });

    expect(selectHistory(store.getState())).toEqual([]);
    expect(selectHistoryStatus(store.getState())).toBe("ready");
    expect(selectHasCandles(store.getState())).toBe(false);
  });

  it("drops a response that finishes after a newer request started", () => {
    const store = createCandleStore();
    const stale = requestHistory(store, "1s");
    const current = requestHistory(store, "1s");

    applyHistory(store, stale, { interval: "1s", candles: [candle(BASE)] });
    expect(selectHistory(store.getState())).toEqual([]);

    applyHistory(store, current, { interval: "1s", candles: [candle(BASE + 5)] });
    expect(selectHistory(store.getState())).toHaveLength(1);
  });

  it("drops a response labelled with an interval the chart is not showing", () => {
    const store = createCandleStore();
    const id = requestHistory(store, "1s");

    applyHistory(store, id, { interval: "1m", candles: [candle(BASE)] });

    expect(selectHistory(store.getState())).toEqual([]);
    expect(selectHistoryStatus(store.getState())).toBe("loading");
  });

  it("collapses duplicates in the payload and drops a forming bucket the payload covers", () => {
    const store = createCandleStore();
    const id = requestHistory(store, "1s");
    applyHistory(store, id, { interval: "1s", candles: [candle(BASE)] });
    applyCandleFrame(store, frame(BASE + 1, "65200.00", false));
    requestHistory(store, "1s"); // a refresh keeps the forming bucket on screen

    applyHistory(store, id + 1, {
      interval: "1s",
      candles: [candle(BASE), candle(BASE), candle(BASE + 1), candle(BASE)],
    });

    expect(selectHistory(store.getState()).map((entry) => entry.t)).toEqual([
      at(BASE),
      at(BASE + 1),
    ]);
    // The bucket the payload holds is finished: it cannot also be forming.
    expect(selectActiveCandle(store.getState())).toBeNull();
  });

  it("keeps the last word on a failed request, and ignores a superseded failure", () => {
    const store = createCandleStore();
    const stale = requestHistory(store, "1s");
    const current = requestHistory(store, "1s");

    failHistory(store, stale, "an older request failed");
    expect(selectHistoryStatus(store.getState())).toBe("loading");

    failHistory(store, current, "history responded 500 Server Error");
    expect(selectHistoryStatus(store.getState())).toBe("error");
    expect(store.getState().historyError).toBe("history responded 500 Server Error");
  });
});

describe("live candle frames", () => {
  it("files a finished bucket into the history and keeps it unique", () => {
    const store = createCandleStore();
    const id = requestHistory(store, "1s");
    applyHistory(store, id, { interval: "1s", candles: [] });

    applyCandleFrame(store, frame(BASE, "65100.00", true));
    applyCandleFrame(store, frame(BASE, "65100.00", true));

    expect(selectHistory(store.getState())).toHaveLength(1);
    // A frame says nothing about the history request: that status has one writer.
    expect(selectHistoryStatus(store.getState())).toBe("ready");
  });

  it("replaces a repeated bucket instead of drawing two candles for it", () => {
    const store = createCandleStore();

    applyCandleFrame(store, frame(BASE, "65100.00", true));
    applyCandleFrame(store, frame(BASE, "65300.00", true));

    const history = selectHistory(store.getState());
    expect(history).toHaveLength(1);
    expect(history[0].c).toBe("65300.00");
  });

  it("does not touch state when a repeated frame carries the same values", () => {
    const store = createCandleStore();
    applyCandleFrame(store, frame(BASE, "65100.00", true));
    let writes = 0;
    const stop = store.subscribe(() => {
      writes += 1;
    });

    applyCandleFrame(store, frame(BASE, "65100.00", true));
    stop();

    expect(writes).toBe(0);
  });

  it("extends the forming bucket, and closes it when the finished frame lands", () => {
    const store = createCandleStore();

    applyCandleFrame(store, frame(BASE, "65100.00", false));
    expect(selectActiveCandle(store.getState())?.c).toBe("65100.00");

    applyCandleFrame(store, frame(BASE, "65250.00", false));
    expect(selectActiveCandle(store.getState())?.c).toBe("65250.00");
    expect(selectHistory(store.getState())).toEqual([]);

    applyCandleFrame(store, frame(BASE, "65250.00", true));
    expect(selectActiveCandle(store.getState())).toBeNull();
    expect(selectHistory(store.getState()).map((entry) => entry.c)).toEqual(["65250.00"]);
  });

  it("refuses to reopen a bucket that has already been completed", () => {
    const store = createCandleStore();
    applyCandleFrame(store, frame(BASE, "65100.00", true));

    applyCandleFrame(store, frame(BASE, "65999.00", false));

    expect(selectActiveCandle(store.getState())).toBeNull();
  });

  it("ignores a forming bucket older than the one on screen", () => {
    const store = createCandleStore();
    applyCandleFrame(store, frame(BASE + 2, "65200.00", false));

    applyCandleFrame(store, frame(BASE + 1, "64900.00", false));

    expect(selectActiveCandle(store.getState())?.t).toBe(at(BASE + 2));
  });

  it("ignores a frame for an interval the chart has left", () => {
    const store = createCandleStore();
    switchInterval(store, "1m");

    applyCandleFrame(store, frame(BASE, "65100.00", true));

    expect(selectHistory(store.getState())).toEqual([]);
    expect(selectActiveCandle(store.getState())).toBeNull();
  });

  it("keeps what is on screen when the session that fed it ended", () => {
    const store = createCandleStore();
    const id = requestHistory(store, "1s");
    applyHistory(store, id, { interval: "1s", candles: [candle(BASE)] });
    applyCandleFrame(store, frame(BASE + 1, "65200.00", false));

    invalidateHistory(store);

    // A reconnect is not a reason to blank the chart; it is a reason to re-read
    // the series, which the live epoch counter lets the history hook do.
    expect(store.getState().historyEpoch).toBe(1);
    expect(selectHistory(store.getState())).toHaveLength(1);
    expect(selectActiveCandle(store.getState())?.c).toBe("65200.00");
  });
});

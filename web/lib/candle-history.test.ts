import { describe, expect, it } from "vitest";

import { loadHistory } from "@/lib/candle-history";
import type { History, Interval } from "@/lib/protocol";
import { applyHistory, createCandleStore, requestHistory, switchInterval } from "@/stores/candle";

/**
 * Reading one interval's history, under a request id.
 *
 * `docs/SEAMS.md` Slice C: "a history response that finishes after the interval
 * changed is dropped (stale request id), never painted onto the new interval".
 * That promise is made of three orderings — a response superseded by a newer
 * request, a response whose interval the chart has left, and a response that
 * arrives after the caller gave up — so each one is scripted here, with the
 * fetcher's timing under the test's control and no network.
 */

const BASE = Date.parse("2026-09-19T14:18:11.000Z") / 1000;

function at(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function candle(seconds: number) {
  return {
    t: at(seconds),
    o: "65000.00",
    h: "65150.00",
    l: "64950.00",
    c: "65100.00",
    v: "0.250000",
  };
}

type Pending = {
  interval: Interval;
  signal: AbortSignal;
  resolve: (history: History) => void;
  reject: (error: unknown) => void;
};

/** A history request the test completes when it wants to. */
function deferredHistory() {
  const calls: Pending[] = [];
  const fetcher = (interval: Interval, _limit: number, signal: AbortSignal): Promise<History> =>
    new Promise<History>((resolve, reject) => {
      calls.push({ interval, signal, resolve, reject });
    });
  return {
    calls,
    fetcher,
    /** Answer the newest request as the backend would, echoing its interval. */
    answer(interval: Interval, candles: ReturnType<typeof candle>[]): void {
      const call = calls[calls.length - 1];
      if (call === undefined) {
        throw new Error("no history request was made");
      }
      call.resolve({ interval, candles });
    },
  };
}

describe("loadHistory", () => {
  it("lands the candles under the id it asked with", async () => {
    const store = createCandleStore();
    const history = deferredHistory();

    const loading = loadHistory({ store, interval: "1s", fetcher: history.fetcher });
    history.answer("1s", [candle(BASE), candle(BASE + 1)]);

    await expect(loading).resolves.toEqual({ kind: "landed", candles: 2 });
    expect(store.getState().history.map((entry) => entry.t)).toEqual([at(BASE), at(BASE + 1)]);
    expect(store.getState().historyStatus).toBe("ready");
  });

  it("drops a response that finishes after the interval changed", async () => {
    const store = createCandleStore();
    const history = deferredHistory();

    const loading = loadHistory({ store, interval: "1s", fetcher: history.fetcher });
    // The viewer flips to 1m while the 1s response is still in flight.
    switchInterval(store, "1m");
    history.answer("1s", [candle(BASE)]);

    await expect(loading).resolves.toEqual({ kind: "dropped" });
    expect(store.getState().history).toEqual([]);
    expect(store.getState().historyStatus).toBe("loading");
  });

  it("drops a response the history endpoint labelled with another interval", async () => {
    const store = createCandleStore();
    const history = deferredHistory();

    const loading = loadHistory({ store, interval: "1s", fetcher: history.fetcher });
    history.answer("1m", [candle(BASE)]);

    await expect(loading).resolves.toEqual({ kind: "dropped" });
    expect(store.getState().history).toEqual([]);
  });

  it("drops a response a newer request has superseded", async () => {
    const store = createCandleStore();
    const history = deferredHistory();

    const first = loadHistory({ store, interval: "1s", fetcher: history.fetcher });
    const second = loadHistory({ store, interval: "1s", fetcher: history.fetcher });
    const [older, newer] = history.calls;

    older.resolve({ interval: "1s", candles: [candle(BASE)] });
    await expect(first).resolves.toEqual({ kind: "dropped" });
    expect(store.getState().history).toEqual([]);

    newer.resolve({ interval: "1s", candles: [candle(BASE + 5)] });
    await expect(second).resolves.toEqual({ kind: "landed", candles: 1 });
    expect(store.getState().history.map((entry) => entry.t)).toEqual([at(BASE + 5)]);
  });

  it("reports a failure with the message the status panel shows", async () => {
    const store = createCandleStore();
    const history = deferredHistory();

    const loading = loadHistory({ store, interval: "1s", fetcher: history.fetcher });
    history.calls[0].reject(new TypeError("Failed to fetch"));

    await expect(loading).resolves.toEqual({
      kind: "failed",
      message: "backend unreachable (is it running, and does it allow this origin?)",
    });
    expect(store.getState().historyStatus).toBe("error");
    expect(store.getState().historyError).toMatch(/unreachable/);
  });

  it("stays silent when the caller aborted the request", async () => {
    const store = createCandleStore();
    const history = deferredHistory();
    const controller = new AbortController();

    const loading = loadHistory({
      store,
      interval: "1s",
      fetcher: history.fetcher,
      signal: controller.signal,
    });
    controller.abort();
    history.calls[0].reject(new DOMException("aborted", "AbortError"));

    await expect(loading).resolves.toEqual({ kind: "aborted" });
    // An unmount is not a failure, and the screen must not say it was one.
    expect(store.getState().historyStatus).toBe("loading");
    expect(store.getState().historyError).toBeNull();
  });

  it("keeps the candles on screen when a refresh for the same interval fails", async () => {
    const store = createCandleStore();
    const id = requestHistory(store, "1s");
    applyHistory(store, id, { interval: "1s", candles: [candle(BASE)] });
    const history = deferredHistory();

    const loading = loadHistory({ store, interval: "1s", fetcher: history.fetcher });
    expect(store.getState().historyStatus).toBe("refreshing");
    history.calls[0].reject(new Error("history responded 500 Server Error"));

    await expect(loading).resolves.toEqual({
      kind: "failed",
      message: "history responded 500 Server Error",
    });
    expect(store.getState().history).toHaveLength(1);
    expect(store.getState().historyStatus).toBe("error");
  });
});

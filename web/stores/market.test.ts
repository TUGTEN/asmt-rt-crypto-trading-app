import { describe, expect, it } from "vitest";

import type { Trade } from "@/lib/protocol";
import { createBookStore, selectHasData, selectStale } from "@/stores/book";
import { createConnStore, selectOverride, selectRttMs, selectTier } from "@/stores/conn";
import { createMarketStores } from "@/stores/market";

/**
 * The live state, at the level the panels see it.
 *
 * The reason these are three focused stores and not one object is re-render
 * cost: a pong every 2s must not re-render the book, and a book frame must not
 * re-render the tape. That promise is not "the store notifies nobody" — zustand
 * notifies every subscriber of the store that changed — it is that the slices a
 * panel did *not* select keep their identity, which is what `Object.is`
 * (zustand's default selector comparison) needs to bail out of a re-render.
 *
 * So these tests pin the substrate the panels rely on: one store per slice,
 * untouched slices preserved by reference, and the two freshness selectors that
 * decide whether cached values may be shown as live.
 */

const TRADE: Trade = {
  seq: 4097,
  ts: "2026-09-19T14:18:11.042Z",
  price: "65000.00",
  qty: "0.001000",
};

describe("market stores", () => {
  it("starts each focused store in the empty shape the screen renders", () => {
    const { book, candle, conn } = createMarketStores();

    expect(book.getState()).toEqual({
      book: null,
      mid: null,
      previousMid: null,
      sessionOpen: null,
      sessionHigh: null,
      sessionLow: null,
      trades: [],
      status: "connecting",
      syncing: false,
      lastFrameAt: null,
      gaps: 0,
      malformed: 0,
    });
    expect(conn.getState()).toEqual({
      tier: null,
      tierRate: null,
      rttMs: null,
      latencyMs: null,
      jitterMs: null,
      override: null,
    });
    // The chart's store: the interval it follows, nothing drawn yet, and the
    // request id that makes a late history response droppable.
    expect(candle.getState()).toEqual({
      interval: "1s",
      history: [],
      activeCandle: null,
      requestId: 0,
      historyEpoch: 0,
      historyStatus: "loading",
      historyError: null,
    });
  });

  it("keeps a write to one store away from every other store's subscribers", () => {
    const { book, candle, conn } = createMarketStores();
    const seen: string[] = [];
    const stops = [
      book.subscribe(() => seen.push("book")),
      conn.subscribe(() => seen.push("conn")),
      candle.subscribe(() => seen.push("candle")),
    ];

    book.setState({ status: "live" });
    expect(seen).toEqual(["book"]);
    // A book frame says nothing about the tier, and vice versa.
    expect(conn.getState().tier).toBeNull();

    conn.setState({ tier: "degraded" });
    expect(seen).toEqual(["book", "conn"]);
    expect(book.getState().status).toBe("live");

    for (const stop of stops) {
      stop();
    }
    book.setState({ status: "stale" });
    expect(seen).toEqual(["book", "conn"]);
  });

  it("preserves untouched slices by reference, so their selectors cannot change", () => {
    const book = createBookStore();
    const before = book.getState();

    book.setState({ trades: [TRADE] });
    const after = book.getState();

    expect(after.trades).toEqual([TRADE]);
    expect(after.book).toBe(before.book);
    expect(after.mid).toBe(before.mid);
    expect(after.previousMid).toBe(before.previousMid);
    // A new state object, not a mutation of the one already rendered.
    expect(after).not.toBe(before);
  });

  it("reads 'stale' from status and held data, never from the clock", () => {
    const book = createBookStore();

    // Nothing delivered yet: waiting, which is not the same as stale.
    expect(selectStale(book.getState())).toBe(false);
    expect(selectHasData(book.getState())).toBe(false);

    book.setState({ status: "live", trades: [TRADE] });
    expect(selectHasData(book.getState())).toBe(true);
    expect(selectStale(book.getState())).toBe(false);

    // Socket down with a tape on screen: cached values, labelled as cached.
    book.setState({ status: "stale" });
    expect(selectStale(book.getState())).toBe(true);

    // Socket down and nothing ever delivered: down, still not "stale".
    book.setState({ status: "down", trades: [] });
    expect(selectStale(book.getState())).toBe(false);
    expect(selectHasData(book.getState())).toBe(false);

    // A book image alone is enough to have something to be stale about.
    book.setState({ status: "stale", book: { seq: 7, bids: [], asks: [] } });
    expect(selectHasData(book.getState())).toBe(true);
    expect(selectStale(book.getState())).toBe(true);
  });

  it("keeps the debug override beside the backend's tier, not in place of it", () => {
    const conn = createConnStore();

    // The backend's answer stays readable while the override sits next to it:
    // which one wins is T4's policy, and this store does not pre-empt it.
    conn.setState({ tier: "full", override: "minimal" });
    expect(selectTier(conn.getState())).toBe("full");
    expect(conn.getState().override).toBe("minimal");

    conn.setState({ override: null });
    expect(conn.getState().override).toBeNull();
    expect(selectTier(conn.getState())).toBe("full");

    // The badge selects these one field at a time (T4): the override is the
    // client's own selection, the round trip is its own measurement, and the
    // tier next to them is still the backend's.
    conn.setState({ rttMs: 12.34, override: "degraded" });
    expect(selectOverride(conn.getState())).toBe("degraded");
    expect(selectRttMs(conn.getState())).toBe(12.34);
    expect(selectTier(conn.getState())).toBe("full");
  });
});

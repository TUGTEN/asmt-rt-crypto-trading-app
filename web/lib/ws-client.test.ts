import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FRAME_STALE_AFTER_MS,
  PING_INTERVAL_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  SNAPSHOT_RETRY_MS,
} from "@/lib/config";
import type { Level, Snapshot } from "@/lib/protocol";
import type { Scheduler } from "@/lib/retry";
import { followVisibility, type VisibilitySource } from "@/lib/visibility";
import { resetPaintMode, setPaintMode, SMOOTH_WINDOW_MS } from "@/lib/paint-throttle";
import { WsClient, type SocketLike } from "@/lib/ws-client";
import { createMarketStores, type MarketStores } from "@/stores/market";

/**
 * The socket client, driven by a script instead of a network.
 *
 * SEAMS Slice B is the promise that the book heals itself, and every step of
 * that story is externally visible: which frames go out, which snapshot is
 * adopted, and what the store says the screen is showing. So this file scripts
 * raw server frames (the same text `MessageEvent.data` carries), a manual clock,
 * a manual timer queue, and a snapshot request the test resolves — then asserts
 * the outgoing frames and the merged state. Nothing here sleeps.
 *
 * The pure decisions underneath are pinned separately: `lib/book-sync.test.ts`
 * for the merge, `lib/protocol.frames.test.ts` for the guards. This file is
 * about the client wiring them into a session: dial, buffer, refetch, retry,
 * report, reconnect.
 */

/** Epoch millis the manual clock starts at — also the first ping stamp. */
const START = Date.parse("2026-09-19T14:18:11.000Z");
const URL = "ws://localhost:8080/ws?topics=book,trades&interval=1s";

/** One level per side, tagged so a test can tell which image is on screen. */
function side(tag: number): Level[] {
  return [{ price: `${tag}.00`, qty: "1.000000" }];
}

/** Raw socket text, exactly what `MessageEvent.data` carries (protocol v2 tuples). */
function wireSide(tag: number): [string, string][] {
  return [[`${tag}.00`, "1.000000"]];
}

function bookFrame(seq: number, prevSeq: number | null, tag = seq): string {
  return JSON.stringify(["book", seq, prevSeq, wireSide(tag), wireSide(tag + 1)]);
}

function tradeFrame(seq: number, price = "65000.00"): string {
  return JSON.stringify(["trade", seq, "2026-09-19T14:18:11.042Z", price, "0.001000"]);
}

function pong(tSend: number, offsetMs: number): string {
  return JSON.stringify({ type: "pong", tSend, tRecv: new Date(tSend + offsetMs).toISOString() });
}

function candleFrame(t: string, close: string, complete: boolean): string {
  return JSON.stringify([
    "candle",
    "1s",
    t,
    "65000.00",
    "65300.00",
    "64900.00",
    close,
    "0.250000",
    complete,
  ]);
}

function snapshot(seq: number, tag = seq): Snapshot {
  return { seq, bids: side(tag), asks: side(tag + 1) };
}

async function flush(): Promise<void> {
  // A single await can leave continuations queued behind the one that resolved
  // the snapshot; a handful of turns drains the chain deterministically.
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
  }
}

type ManualTime = {
  now: number;
  /** Every delay asked for, in order — backoff and ping cadence as numbers. */
  delays: number[];
  pending: number;
  scheduler: Scheduler;
  /** Run everything due within `ms`, in time order, draining promises between. */
  advance(ms: number): Promise<void>;
  /** Let the promise chain settle without moving the clock. */
  settle(): Promise<void>;
};

function manualTime(start: number): ManualTime {
  const tasks = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;

  const time: ManualTime = {
    now: start,
    delays: [],
    get pending(): number {
      return tasks.size;
    },
    scheduler: {
      schedule(fn, ms) {
        const id = nextId;
        nextId += 1;
        tasks.set(id, { at: time.now + ms, fn });
        time.delays.push(ms);
        return () => {
          tasks.delete(id);
        };
      },
    },
    async advance(ms) {
      const until = time.now + ms;
      for (;;) {
        let due: { id: number; at: number; fn: () => void } | null = null;
        for (const [id, task] of tasks) {
          if (task.at <= until && (due === null || task.at < due.at)) {
            due = { id, at: task.at, fn: task.fn };
          }
        }
        if (due === null) {
          break;
        }
        tasks.delete(due.id);
        time.now = Math.max(time.now, due.at);
        due.fn();
        await flush();
      }
      time.now = until;
      await flush();
    },
    async settle() {
      await flush();
    },
  };
  return time;
}

type SnapshotCall = {
  signal: AbortSignal;
  resolve: (snapshot: Snapshot) => void;
  reject: (error: unknown) => void;
};

/** A snapshot request the test decides the outcome and the moment of. */
function snapshotSource() {
  const calls: SnapshotCall[] = [];
  const latest = (): SnapshotCall => {
    const call = calls[calls.length - 1];
    if (call === undefined) {
      throw new Error("no snapshot request was made");
    }
    return call;
  };
  return {
    calls,
    count: (): number => calls.length,
    latest,
    fetch: (signal: AbortSignal): Promise<Snapshot> =>
      new Promise<Snapshot>((resolve, reject) => {
        calls.push({ signal, resolve, reject });
        // A real fetch rejects on abort; the client relies on that to forget a
        // snapshot whose session has ended.
        signal.addEventListener("abort", () => reject(new Error("snapshot aborted")));
      }),
    resolve: (seq: number, tag = seq): void => {
      latest().resolve(snapshot(seq, tag));
    },
    fail: (): void => {
      latest().reject(new Error("snapshot failed"));
    },
  };
}

/** A socket the test opens, feeds, and drops by hand. */
class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  /** Server frames actually written to the wire, parsed back for assertions. */
  frames(): unknown[] {
    return this.sent.map((text) => JSON.parse(text) as unknown);
  }

  open(): void {
    this.onopen?.();
  }

  receive(frame: unknown): void {
    this.onmessage?.(frame);
  }

  drop(): void {
    this.onclose?.();
  }
}

function dialer() {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    connect: (url: string): SocketLike => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    latest(): FakeSocket {
      const socket = sockets[sockets.length - 1];
      if (socket === undefined) {
        throw new Error("no socket was dialed");
      }
      return socket;
    },
  };
}

/**
 * A `document` stand-in: the one flag, and listeners the test fires by hand.
 * `followVisibility` takes its readings from this object, so the visibility test
 * below runs against the real client with no DOM and no browser.
 */
function visibilitySource() {
  const listeners = new Set<() => void>();
  const state = { hidden: false };
  const source: VisibilitySource = {
    get hidden(): boolean {
      return state.hidden;
    },
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  return {
    source,
    switchTo(next: boolean): void {
      state.hidden = next;
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}

function harness(overrides: { maxResyncAttempts?: number; manageBook?: boolean; manageConn?: boolean; feedsChart?: boolean; smoothWindowMs?: number } = {}) {
  const stores = createMarketStores();
  const time = manualTime(START);
  const snapshots = snapshotSource();
  const dial = dialer();
  const client = new WsClient({
    url: URL,
    stores,
    connect: dial.connect,
    snapshot: snapshots.fetch,
    now: () => time.now,
    timers: time.scheduler,
    ...overrides,
  });
  return { client, stores, store: readStores(stores), time, snapshots, dial };
}

/**
 * The three focused stores, read as the one flat state these assertions are
 * about: which store a field lives in is a rendering concern, not a session one,
 * so the scripted frames are still asserted against the same field names.
 */
function readStores(stores: MarketStores) {
  return {
    get: () => ({
      ...stores.book.getState(),
      ...stores.conn.getState(),
      ...stores.candle.getState(),
    }),
  };
}

/** Start the client, open its socket, and land a first book on screen. */
async function connected(seq: number, overrides: { maxResyncAttempts?: number } = {}) {
  const h = harness(overrides);
  h.client.start();
  h.dial.latest().open();
  h.snapshots.resolve(seq);
  await h.time.settle();
  return h;
}

describe("WsClient", () => {
  it("dials the subscribed URL and holds frames that race the snapshot request", async () => {
    const h = harness();
    h.client.start();

    expect(h.dial.sockets).toHaveLength(1);
    expect(h.dial.latest().url).toBe(URL);
    expect(h.store.get().status).toBe("connecting");

    h.dial.latest().open();
    expect(h.snapshots.count()).toBe(1);
    expect(h.store.get().syncing).toBe(true);

    // The race this slice exists for: frames arrive before the snapshot does.
    h.dial.latest().receive(bookFrame(20, 19, 20));
    h.dial.latest().receive(bookFrame(21, 20, 21));

    expect(h.store.get().book).toBeNull();

    h.snapshots.resolve(21);
    await h.time.settle();

    const state = h.store.get();
    expect(state.book?.seq).toBe(21);
    expect(state.book?.bids[0].price).toBe("21.00");
    expect(state.syncing).toBe(false);
    expect(state.status).toBe("live");
  });

  it("replays only the buffered frames that are newer than the snapshot, in order", async () => {
    const h = harness();
    h.client.start();
    h.dial.latest().open();

    h.dial.latest().receive(bookFrame(20, 19, 20));
    h.dial.latest().receive(bookFrame(21, 20, 21)); // the snapshot already has this one
    h.dial.latest().receive(bookFrame(22, 21, 22));

    h.snapshots.resolve(21);
    await h.time.settle();

    const state = h.store.get();
    expect(state.book?.seq).toBe(22);
    // The frame's image, not the snapshot's: the newest chained frame wins.
    expect(state.book?.bids[0].price).toBe("22.00");
    expect(state.status).toBe("live");
  });

  it("pulls a fresh snapshot on a gap and resumes on it, never on the wrong base", async () => {
    const h = await connected(12);
    expect(h.store.get().book?.seq).toBe(12);

    h.dial.latest().receive(bookFrame(13, 12, 13));
    expect(h.store.get().book?.seq).toBe(13);

    // Frames 14 was missed: this frame's parent is not what we hold.
    h.dial.latest().receive(bookFrame(15, 14, 15));
    expect(h.store.get().book?.seq).toBe(13);
    expect(h.store.get().book?.bids[0].price).toBe("13.00");
    expect(h.store.get().gaps).toBe(1);

    await h.time.advance(0);
    expect(h.snapshots.count()).toBe(2);
    expect(h.store.get().syncing).toBe(true);
    expect(h.store.get().status).toBe("live");

    h.snapshots.resolve(40);
    await h.time.settle();
    expect(h.store.get().book?.seq).toBe(40);
    expect(h.store.get().syncing).toBe(false);

    h.dial.latest().receive(bookFrame(41, 40, 41));
    expect(h.store.get().book?.seq).toBe(41);
    expect(h.store.get().status).toBe("live");
  });

  it("rejects malformed frames and empty sides without crashing or corrupting the book", async () => {
    const h = await connected(5);
    const book = h.store.get().book;

    for (const garbage of [
      "not json",
      "",
      "{}",
      '{"type":"nope"}',
      // An empty side is not a book (SEAMS Slice B).
      '["book",9,8,[],[["1.00","1.000000"]]]',
    ]) {
      h.dial.latest().receive(garbage);
    }

    expect(h.store.get().malformed).toBe(5);
    expect(h.store.get().book).toBe(book);
    expect(h.store.get().status).toBe("live");

    // The stream is still good after the garbage.
    h.dial.latest().receive(bookFrame(6, 5, 6));
    expect(h.store.get().book?.seq).toBe(6);
  });

  it("streams trades newest-first and drops repeats and late arrivals", async () => {
    const h = await connected(1);

    for (const seq of [4097, 4098, 4099]) {
      h.dial.latest().receive(tradeFrame(seq));
    }
    expect(h.store.get().trades.map((trade) => trade.seq)).toEqual([4099, 4098, 4097]);

    h.dial.latest().receive(tradeFrame(4099)); // the same trade again
    h.dial.latest().receive(tradeFrame(4096)); // older than the tape's head
    expect(h.store.get().trades.map((trade) => trade.seq)).toEqual([4099, 4098, 4097]);
  });

  it("calls the screen live as soon as data arrives, book or tape", async () => {
    const h = harness();
    h.client.start();
    h.dial.latest().open();
    expect(h.store.get().status).toBe("connecting");

    h.dial.latest().receive(tradeFrame(1));

    expect(h.store.get().status).toBe("live");
    expect(h.store.get().lastFrameAt).toBe(START);
  });

  it("pings every 2s and reports the measured round trip", async () => {
    const h = harness();
    h.client.start();
    h.dial.latest().open();

    // The first ping goes out with the connection, so the first report 2s later
    // already has something to say.
    expect(h.dial.latest().frames()).toEqual([{ type: "ping", tSend: START }]);
    h.dial.latest().receive(bookFrame(2, 1, 2));
    h.snapshots.resolve(2);
    await h.time.settle();

    h.dial.latest().receive(pong(START, 12));
    expect(h.store.get().rttMs).toBe(12);
    expect(h.store.get().latencyMs).toBe(6);
    expect(h.store.get().jitterMs).toBeNull();

    await h.time.advance(PING_INTERVAL_MS);
    expect(h.dial.latest().frames().slice(1)).toEqual([
      { type: "ping", tSend: START + PING_INTERVAL_MS },
      { type: "report", latencyMs: 6, jitterMs: 0 },
    ]);

    // A second round trip is what turns jitter into a number, and the first
    // spread seeds it: |24 − 12|.
    h.dial.latest().receive(pong(START + PING_INTERVAL_MS, 24));
    expect(h.store.get().latencyMs).toBe(12);
    expect(h.store.get().jitterMs).toBe(12);

    await h.time.advance(PING_INTERVAL_MS);
    expect(h.dial.latest().frames().at(-1)).toEqual({
      type: "report",
      latencyMs: 12,
      jitterMs: 12,
    });

    // Now the EMA smooths: 0.5·|44 − 24| + 0.5·12.
    h.dial.latest().receive(pong(START + PING_INTERVAL_MS * 2, 44));
    expect(h.store.get().rttMs).toBe(44);
    expect(h.store.get().latencyMs).toBe(22);
    expect(h.store.get().jitterMs).toBe(16);
  });

  it("refuses to report a pong it cannot turn into a round trip", async () => {
    const h = await connected(1);

    h.dial.latest().receive(pong(START, -5)); // answered before it was asked
    expect(h.store.get().latencyMs).toBeNull();
    expect(h.store.get().malformed).toBe(0);
  });

  it("files candle frames into the chart's series and renders the tier it is told", async () => {
    const h = await connected(1);

    const socket = h.dial.latest();
    // A finished bucket, sent twice (a reconnect can deliver it again), then the
    // bucket still forming.
    socket.receive(candleFrame("2026-09-19T14:18:11Z", "65100.00", true));
    socket.receive(candleFrame("2026-09-19T14:18:11Z", "65100.00", true));
    socket.receive(candleFrame("2026-09-19T14:18:12Z", "65200.00", false));

    expect(h.store.get().history).toHaveLength(1);
    expect(h.store.get().history[0].c).toBe("65100.00");
    expect(h.store.get().activeCandle?.t).toBe("2026-09-19T14:18:12Z");
    expect(h.store.get().malformed).toBe(0);
    expect(h.store.get().book?.seq).toBe(1);

    socket.receive('{"type":"tier","tier":"degraded","rate":1}');
    expect(h.store.get().tier).toBe("degraded");
    expect(h.store.get().tierRate).toBe(1);
  });

  it("tells the chart to re-read its series after a reconnect, and not on the first dial", async () => {
    const h = await connected(1);
    expect(h.store.get().historyEpoch).toBe(0);

    h.dial.latest().drop();
    await h.time.advance(RECONNECT_BASE_MS);
    h.dial.latest().open();

    // The buckets that finished while the socket was down belong to no stream we
    // saw; the series has to be read again rather than trusted.
    expect(h.store.get().historyEpoch).toBe(1);
    expect(h.store.get().malformed).toBe(0);
  });

  it("keeps a failed snapshot from becoming a base: it retries and still buffers", async () => {
    const h = harness();
    h.client.start();
    h.dial.latest().open();

    h.dial.latest().receive(bookFrame(20, 19, 20));
    h.snapshots.fail();
    await h.time.settle();

    expect(h.store.get().book).toBeNull();
    expect(h.store.get().syncing).toBe(true);
    expect(h.time.delays.at(-1)).toBe(SNAPSHOT_RETRY_MS);

    h.dial.latest().receive(bookFrame(21, 20, 21));
    expect(h.store.get().book).toBeNull();

    await h.time.advance(SNAPSHOT_RETRY_MS);
    expect(h.snapshots.count()).toBe(2);
    h.snapshots.resolve(19);
    await h.time.settle();

    // 20 and 21 were waiting, and they chain onto the snapshot that just landed.
    expect(h.store.get().book?.seq).toBe(21);
    expect(h.store.get().syncing).toBe(false);
  });

  it("keeps cached values on screen and stays stale when the socket drops", async () => {
    const h = await connected(7);
    expect(h.store.get().status).toBe("live");

    h.dial.latest().drop();

    expect(h.store.get().status).toBe("stale");
    expect(h.store.get().book?.seq).toBe(7);
    expect(h.store.get().syncing).toBe(false);

    await h.time.advance(RECONNECT_BASE_MS);
    expect(h.dial.sockets).toHaveLength(2);
    // Resubscribing is dialing the same URL: topics and interval live in it.
    expect(h.dial.latest().url).toBe(URL);

    h.dial.latest().open();
    expect(h.snapshots.count()).toBe(2);
    h.snapshots.resolve(900);
    await h.time.settle();
    expect(h.store.get().book?.seq).toBe(900);
    expect(h.store.get().status).toBe("live");
  });

  it("backs off further on each failed dial, up to the cap", async () => {
    const h = harness();
    h.client.start();

    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      h.dial.latest().drop();
      const delay = h.time.delays.at(-1);
      if (delay === undefined) {
        throw new Error("no reconnect was scheduled");
      }
      delays.push(delay);
      await h.time.advance(delay);
    }

    expect(delays.slice(0, 5)).toEqual([
      RECONNECT_BASE_MS,
      RECONNECT_BASE_MS * 2,
      RECONNECT_BASE_MS * 4,
      RECONNECT_BASE_MS * 8,
      RECONNECT_BASE_MS * 16,
    ]);
    // Capped: a dead backend is not hammered, and the tab keeps trying.
    expect(delays.every((delay) => delay <= RECONNECT_MAX_MS)).toBe(true);
    expect(delays.at(-1)).toBe(RECONNECT_MAX_MS);
  });

  it("backs off when recovery cannot converge, and resets once a frame chains", async () => {
    const h = await connected(12, { maxResyncAttempts: 3 });

    for (let gap = 1; gap <= 3; gap += 1) {
      h.dial.latest().receive(bookFrame(15, 14, 15)); // never chains onto the base
      await h.time.advance(0);
      expect(h.time.delays.at(-1)).toBe(gap < 3 ? 0 : SNAPSHOT_RETRY_MS);
      h.snapshots.resolve(12);
      await h.time.settle();
    }

    expect(h.store.get().gaps).toBe(3);

    // The breaker waits instead of refetching again right away.
    const before = h.snapshots.count();
    await h.time.advance(0);
    expect(h.snapshots.count()).toBe(before);

    // A frame that chains is proof the feed and the book agree again.
    await h.time.advance(SNAPSHOT_RETRY_MS);
    h.snapshots.resolve(13);
    await h.time.settle();
    h.dial.latest().receive(bookFrame(14, 13, 14));
    expect(h.store.get().book?.seq).toBe(14);

    h.dial.latest().receive(bookFrame(20, 19, 20));
    expect(h.time.delays.at(-1)).toBe(0);
  });

  it("does not adopt a snapshot fetched for a session that has already ended", async () => {
    const h = harness();
    h.client.start();
    h.dial.latest().open();
    expect(h.snapshots.count()).toBe(1);

    h.dial.latest().drop();
    expect(h.snapshots.calls[0].signal.aborted).toBe(true);

    await h.time.advance(RECONNECT_BASE_MS);
    h.dial.latest().open();
    expect(h.snapshots.count()).toBe(2);

    h.snapshots.resolve(64);
    await h.time.settle();
    expect(h.store.get().book?.seq).toBe(64);
  });

  it("stops dead on unmount: the socket closes and nothing is left scheduled", async () => {
    const h = await connected(3);
    const socket = h.dial.latest();

    h.client.stop();
    expect(socket.closed).toBe(true);
    expect(h.time.pending).toBe(0);

    // A real socket still fires close after our close(); it must not reconnect.
    socket.drop();
    await h.time.advance(30_000);
    expect(h.dial.sockets).toHaveLength(1);
    expect(h.store.get().status).toBe("stale");
    expect(h.store.get().book?.seq).toBe(3);
  });

  it("forces each tier and clears back to automatic, one frame per action", async () => {
    const h = await connected(1);
    const socket = h.dial.latest();

    h.client.forceTier("degraded");
    expect(socket.frames().at(-1)).toEqual({ type: "force", tier: "degraded" });
    expect(h.store.get().override).toBe("degraded");

    // The tier on screen is the backend's frame, not the button that was clicked:
    // the frame is what says the forced tier is in force.
    socket.receive('{"type":"tier","tier":"degraded","rate":1}');
    expect(h.store.get().tier).toBe("degraded");
    expect(h.store.get().tierRate).toBe(1);

    h.client.forceTier("minimal");
    expect(socket.frames().at(-1)).toEqual({ type: "force", tier: "minimal" });

    h.client.forceTier("full");
    expect(socket.frames().at(-1)).toEqual({ type: "force", tier: "full" });

    // Clearing is the null frame PROTOCOL.md defines, and it leaves no override
    // behind: the next tier frame is the backend's own decision again.
    h.client.forceTier(null);
    expect(socket.frames().at(-1)).toEqual({ type: "force", tier: null });
    expect(h.store.get().override).toBeNull();

    socket.receive('{"type":"tier","tier":"degraded","rate":1}');
    expect(h.store.get().tier).toBe("degraded");
    expect(h.store.get().override).toBeNull();
  });

  it("re-asserts a standing override when the session redials", async () => {
    const h = await connected(1);
    h.client.forceTier("minimal");
    expect(h.dial.latest().frames().at(-1)).toEqual({ type: "force", tier: "minimal" });

    h.dial.latest().drop();
    await h.time.advance(RECONNECT_BASE_MS);
    h.dial.latest().open();

    // A reconnect is a new backend state machine (CONTEXT.md) with no override on
    // it, so the control's intent goes out again. Without this the badge would
    // read "forced" while the backend tiered automatically: stale-as-live in
    // miniature, which is exactly what this slice forbids.
    expect(h.dial.latest().frames()).toContainEqual({ type: "force", tier: "minimal" });
    expect(h.store.get().override).toBe("minimal");
  });

  it("pauses while the tab is hidden and dials a fresh session when it returns", async () => {
    const h = await connected(5);
    const tab = visibilitySource();
    const lifecycle = followVisibility(tab.source, h.client);

    // Bound to a visible tab: the session already running stays up, and the
    // lifecycle does not dial a second socket.
    expect(h.dial.sockets).toHaveLength(1);

    tab.switchTo(true);
    expect(h.dial.sockets[0].closed).toBe(true);
    expect(h.time.pending).toBe(0);
    // Cached values on screen, labelled as cached — a hidden tab is not live.
    expect(h.store.get().status).toBe("stale");

    // Anything the closed socket still had in flight cannot touch the screen.
    h.dial.sockets[0].receive(bookFrame(6, 5, 6));
    expect(h.store.get().book?.seq).toBe(5);

    tab.switchTo(false);
    expect(h.dial.sockets).toHaveLength(2);
    expect(h.dial.latest().url).toBe(URL);
    expect(h.store.get().status).toBe("stale");

    // The new session opens and re-syncs the book from a fresh snapshot: nothing
    // is live until frames on *this* socket land.
    h.dial.latest().open();
    expect(h.snapshots.count()).toBe(2);
    expect(h.store.get().status).toBe("stale");

    h.snapshots.resolve(7);
    await h.time.settle();
    expect(h.store.get().book?.seq).toBe(7);
    expect(h.store.get().status).toBe("live");

    // Unmounting disposes what the component owned: the listener and the session.
    lifecycle.dispose();
    expect(h.dial.latest().closed).toBe(true);
    expect(h.time.pending).toBe(0);
  });
});
describe("WsClient split sessions", () => {
  it("chart-only session never fetches a snapshot nor touches the book", async () => {
    const h = harness({ manageBook: false });
    h.client.start();
    h.dial.latest().open();
    await h.time.settle();

    // No snapshot for a session that never sees the book, and the book
    // store keeps its opening state instead of flipping to stale/connecting.
    expect(h.snapshots.count()).toBe(0);
    expect(h.store.get().book).toBeNull();
    expect(h.store.get().syncing).toBe(false);
    expect(h.store.get().status).toBe("connecting");

    // Book and trade frames are ignored, not buffered into a future base.
    h.dial.latest().receive(bookFrame(2, 1, 2));
    h.dial.latest().receive(tradeFrame(1));
    await h.time.settle();
    expect(h.store.get().book).toBeNull();
    expect(h.store.get().trades).toHaveLength(0);
    expect(h.store.get().status).toBe("connecting");

    // Candles and tiers still land: this half owns the chart.
    h.dial.latest().receive(candleFrame("2026-09-19T14:18:11Z", "65100.00", true));
    h.dial.latest().receive('{"type":"tier","tier":"degraded","rate":1}');
    expect(h.store.get().history).toHaveLength(1);
    expect(h.store.get().tier).toBe("degraded");

    // Ending the chart session leaves the book state alone: an interval
    // switch must not mark the market half's data stale.
    h.client.stop();
    expect(h.store.get().status).toBe("connecting");
    expect(h.store.get().history).toHaveLength(1);
  });

  it("chart-only session re-reads the series after a reconnect, without a snapshot", async () => {
    const h = harness({ manageBook: false });
    h.client.start();
    h.dial.latest().open();
    await h.time.settle();
    expect(h.store.get().historyEpoch).toBe(0);

    h.dial.latest().drop();
    await h.time.advance(RECONNECT_BASE_MS);
    h.dial.latest().open();
    await h.time.settle();

    // The buckets missed while down belong to no stream seen: re-read.
    expect(h.store.get().historyEpoch).toBe(1);
    // ...but still no book recovery on a session that never sees the book.
    expect(h.snapshots.count()).toBe(0);
    expect(h.store.get().book).toBeNull();
  });

  it("market-only session never pings, tiers, or invalidates the chart", async () => {
    const h = harness({ manageConn: false, feedsChart: false });
    h.client.start();
    h.dial.latest().open();
    // No ping on open without telemetry ...
    expect(h.dial.latest().frames()).toEqual([]);
    h.snapshots.resolve(9);
    await h.time.settle();

    // ... and none ever: the report loop belongs to the chart session.
    await h.time.advance(PING_INTERVAL_MS * 3);
    expect(h.dial.latest().frames()).toEqual([]);

    // Tier and pong frames are ignored, not rendered.
    h.dial.latest().receive('{"type":"tier","tier":"minimal","rate":0.25}');
    h.dial.latest().receive(pong(START, 12));
    expect(h.store.get().tier).toBeNull();
    expect(h.store.get().latencyMs).toBeNull();

    // Candles are ignored, not filed.
    h.dial.latest().receive(candleFrame("2026-09-19T14:18:11Z", "65100.00", true));
    expect(h.store.get().history).toHaveLength(0);
    // Six silent seconds tripped the frame-age watchdog above; one fresh print
    // proves the market half still ingests and flips the screen back to live.
    h.dial.latest().receive(tradeFrame(7));
    await h.time.settle();

    // The book still heals itself on this half.
    expect(h.store.get().book?.seq).toBe(9);
    expect(h.store.get().status).toBe("live");

    // A market reconnect resyncs the book but leaves the chart series alone.
    h.dial.latest().drop();
    await h.time.advance(RECONNECT_BASE_MS);
    h.dial.latest().open();
    expect(h.store.get().historyEpoch).toBe(0);
    h.snapshots.resolve(10);
    await h.time.settle();
    expect(h.store.get().book?.seq).toBe(10);
    expect(h.store.get().status).toBe("live");
  });

  it("market-only force records the intent without writing to the wire", async () => {
    const h = harness({ manageConn: false, feedsChart: false });
    h.client.start();
    h.dial.latest().open();
    h.snapshots.resolve(1);
    await h.time.settle();

    h.client.forceTier("minimal");
    expect(h.store.get().override).toBe("minimal");
    expect(h.dial.latest().frames()).toEqual([]);
  });

  it("ending the chart session leaves the shared book and tape live", async () => {
    // The hook's contract at the client level: an interval switch ends only
    // the chart half, so the book and the tape must stay live behind it.
    const stores = createMarketStores();
    const time = manualTime(START);
    const marketSnaps = snapshotSource();
    const chartSnaps = snapshotSource();
    const marketDial = dialer();
    const chartDial = dialer();
    const market = new WsClient({
      url: "ws://localhost:8080/ws?topics=book,trades&interval=1s",
      stores,
      connect: marketDial.connect,
      snapshot: marketSnaps.fetch,
      now: () => time.now,
      timers: time.scheduler,
      manageConn: false,
      feedsChart: false,
    });
    const chart = new WsClient({
      url: "ws://localhost:8080/ws?topics=chart&interval=1m",
      stores,
      connect: chartDial.connect,
      snapshot: chartSnaps.fetch,
      now: () => time.now,
      timers: time.scheduler,
      manageBook: false,
    });

    market.start();
    chart.start();
    marketDial.latest().open();
    chartDial.latest().open();
    marketSnaps.resolve(12);
    await time.settle();
    marketDial.latest().receive(tradeFrame(4097));

    expect(stores.book.getState().book?.seq).toBe(12);
    expect(stores.book.getState().trades).toHaveLength(1);
    expect(stores.book.getState().status).toBe("live");
    // The chart half redials without a book recovery of its own.
    expect(chartSnaps.count()).toBe(0);

    // The interval switch: the chart session ends, the market one never blinks.
    chart.stop();
    marketDial.latest().receive(bookFrame(13, 12, 13));
    marketDial.latest().receive(tradeFrame(4098));

    expect(stores.book.getState().book?.seq).toBe(13);
    expect(stores.book.getState().trades.map((trade) => trade.seq)).toEqual([4098, 4097]);
    expect(stores.book.getState().status).toBe("live");
    expect(stores.book.getState().syncing).toBe(false);

    market.stop();
    chart.stop();
  });
});

describe("WsClient paint throttle", () => {
  beforeEach(() => {
    resetPaintMode();
  });

  afterEach(() => {
    resetPaintMode();
  });


  function smoothHarness() {
    // The queue rides the harness clock: `time.advance` closes windows.
    return harness();
  }

  async function smoothConnected(seq: number) {
    setPaintMode("smooth");
    const h = smoothHarness();
    h.client.start();
    h.dial.latest().open();
    h.snapshots.resolve(seq);
    await h.time.settle();
    return h;
  }

  it("holds a window of smooth frames and paints one batch when it closes, in order", async () => {
    const h = await smoothConnected(10);
    const socket = h.dial.latest();

    socket.receive(bookFrame(11, 10, 11));
    socket.receive(bookFrame(12, 11, 12));

    // Nothing on screen until the window closes.
    expect(h.store.get().book?.seq).toBe(10);
    await h.time.advance(SMOOTH_WINDOW_MS - 1);
    expect(h.store.get().book?.seq).toBe(10);
    await h.time.advance(1);

    // FIFO through the merger: the chain is intact, no refetch.
    expect(h.store.get().book?.seq).toBe(12);
    expect(h.store.get().book?.bids[0]?.price).toBe("12.00");
    expect(h.snapshots.count()).toBe(1);
  });

  it("flipping to full mid-window paints queued frames before the new one", async () => {
    const h = await smoothConnected(10);
    const socket = h.dial.latest();

    socket.receive(bookFrame(11, 10, 11));
    setPaintMode("full");
    socket.receive(bookFrame(12, 11, 12));

    // Flush-then-dispatch: 11 lands before 12, so the chain never breaks.
    expect(h.store.get().book?.seq).toBe(12);
    expect(h.snapshots.count()).toBe(1);
  });

  it("stop drops the queued window and cancels its flush", async () => {
    const h = await smoothConnected(10);
    const socket = h.dial.latest();

    socket.receive(bookFrame(11, 10, 11));
    h.client.stop();

    // The window never closes onto the stores.
    await h.time.advance(SMOOTH_WINDOW_MS * 2);
    expect(h.store.get().book?.seq).toBe(10);
  });
});

describe("WsClient frame-age watchdog", () => {
  it("marks the screen stale when an open socket goes silent", async () => {
    const h = await connected(41);
    expect(h.store.get().status).toBe("live");
    const liveAt = h.store.get().lastFrameAt;
    // Just under the bar: still live.
    await h.time.advance(FRAME_STALE_AFTER_MS - 1);
    expect(h.store.get().status).toBe("live");
    // Past it with no frames: stale, even though the socket never closed.
    await h.time.advance(1001);
    expect(h.store.get().status).toBe("stale");
    expect(h.store.get().lastFrameAt).toBe(liveAt);
  });

  it("flips back to live on the next frame", async () => {
    const h = await connected(41);
    await h.time.advance(FRAME_STALE_AFTER_MS + 1000);
    expect(h.store.get().status).toBe("stale");
    h.dial.latest().receive(tradeFrame(1));
    await h.time.settle();
    expect(h.store.get().status).toBe("live");
  });

  it("stays live while frames keep arriving", async () => {
    const h = await connected(41);
    for (let seq = 1; seq <= 7; seq += 1) {
      await h.time.advance(1000);
      h.dial.latest().receive(tradeFrame(seq, "65001.00"));
      await h.time.settle();
      expect(h.store.get().status).toBe("live");
    }
  });

  it("never runs for chart-only sessions", async () => {
    const h = harness({ manageBook: false });
    h.client.start();
    h.dial.latest().open();
    await h.time.settle();
    await h.time.advance(FRAME_STALE_AFTER_MS + 2000);
    expect(h.store.get().status).toBe("connecting");
  });
});

/**
 * The market socket: dial, hold, heal, and report.
 *
 * T2's slice (SEAMS Slice B) in the browser is: open
 * `/ws?topics=book,trades,chart&interval=1s`, hold book frames until a snapshot
 * arrives, apply one only when it chains onto what we hold, refetch a snapshot
 * on a gap, stream trades into the tape, file candle frames into the chart's
 * series, and measure the round trip. Every *decision* in that sentence lives in
 * a pure module — `lib/book-sync.ts`, `lib/trade-tape.ts`, `lib/latency.ts`,
 * `lib/candles.ts`, `stores/candle.ts`, and the guards in `lib/protocol.ts`.
 * This file is the plumbing that joins them to a socket and to the frame shapes
 * in `docs/PROTOCOL.md`, and nothing else: no React, no DOM, no globals.
 *
 * The socket, the clock, the timers, the snapshot request, and the stores are
 * injected, so `lib/ws-client.test.ts` drives the whole client with scripted
 * frames and manual time. `lib/hooks/useMarketStream.ts` is the only React in the
 * path: this file pushes into the Zustand stores with `setState()` and imports
 * no rendering layer, which is what keeps the session testable and the stores
 * free to change shape without touching the wire.
 *
 * What "resubscribe" means here: the topics and the chart interval are the
 * socket URL's query string, so recovery is dialing the same URL again (with
 * backoff) and re-syncing the book from a fresh snapshot — CONTEXT.md makes a
 * reconnect a new session whose ordering ids say nothing about the new stream.
 *
 * The client never decides the delivery tier (the backend owns that): it only
 * reports what it measured, and — when the user asks for one through the
 * debug control — writes a `force` frame (T4). The tier on screen is always the
 * backend's answer to either of those, never a local guess.
 * Two sessions share one store set (`lib/hooks/useMarketStream.ts`): the market
 * session (book + trades) owns the book store and never redials on an interval
 * switch, while the chart session (candles) owns the conn store and redials with
 * the new `interval` query param. The flags below say which half this instance is;
 * every default is true, which is the old single-socket client.
 */

import { BookMerger } from "@/lib/book-sync";
import {
  MAX_RESYNC_ATTEMPTS,
  PING_INTERVAL_MS,
  FRAME_STALE_AFTER_MS,
  FRAME_STALE_CHECK_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  SNAPSHOT_RETRY_MS,
} from "@/lib/config";
import { midPrice, trackSession } from "@/lib/format";
import { LatencyTracker, roundTo1, rttFromPong } from "@/lib/latency";
import type {
  BookFrame,
  ClientFrame,
  PongFrame,
  ServerFrame,
  Snapshot,
  Tier,
} from "@/lib/protocol";
import {
  ProtocolError,
  fetchSnapshot,
  parseServerFrame,
  serializeClientFrame,
} from "@/lib/protocol";
import { browserScheduler, type Scheduler } from "@/lib/retry";
import { getPaintMode, PaintQueue, SMOOTH_WINDOW_MS } from "@/lib/paint-throttle";
import { TradeTape } from "@/lib/trade-tape";
import { selectHasData } from "@/stores/book";
import { applyCandleFrame, invalidateHistory } from "@/stores/candle";
import { setOverride } from "@/stores/conn";
import type { MarketStores } from "@/stores/market";

/**
 * The socket surface this client needs — the four things it does with a
 * `WebSocket`, named so a test can implement them in ten lines.
 *
 * There is deliberately no `onerror`: a socket error is always followed by
 * `close` (WebSocket spec), and letting `close` own recovery is what keeps a
 * failed dial from scheduling two reconnects.
 */
export type SocketLike = {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  /** Receives `MessageEvent.data` verbatim: usually text, possibly not JSON. */
  onmessage: ((data: unknown) => void) | null;
  onclose: (() => void) | null;
};

export type SocketFactory = (url: string) => SocketLike;

/**
 * Adapter for the real thing. Reading the handler fields at call time (rather
 * than copying them at construction) means handler assignment order never
 * matters, and `MessageEvent.data` is passed through untouched.
 */
export const browserSocketFactory: SocketFactory = (url) => {
  const socket = new WebSocket(url);
  const like: SocketLike = {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  socket.onopen = () => like.onopen?.();
  socket.onmessage = (event) => like.onmessage?.(event.data);
  socket.onclose = () => like.onclose?.();
  return like;
};

export type WsClientOptions = {
  /** Full socket URL, query string included (`buildWsUrl` in `lib/protocol.ts`). */
  url: string;
  /** The live state this session fills. Created per mount, injected like the socket. */
  stores: MarketStores;
  connect?: SocketFactory;
  snapshot?: (signal: AbortSignal) => Promise<Snapshot>;
  /** Epoch millis for the ping stamp; injected so RTT maths is deterministic. */
  now?: () => number;
  timers?: Scheduler;
  pingMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  snapshotRetryMs?: number;
  maxResyncAttempts?: number;
  /** Book + tape half. When false, book/trade frames are ignored, no snapshot is ever fetched, and the book store is never written. */
  manageBook?: boolean;
  /** Telemetry half. When false, there is no ping/report loop, tier/pong frames are ignored, and the conn store is never written. */
  manageConn?: boolean;
  /** Chart half. When false, candle frames are ignored and a reconnect never invalidates the chart's series. */
  feedsChart?: boolean;
  /** Smooth sampling window in ms; the client passes its own clock and timers. */
  smoothWindowMs?: number;
};

export class WsClient {
  private readonly url: string;
  private readonly stores: MarketStores;
  private readonly connect: SocketFactory;
  private readonly snapshot: (signal: AbortSignal) => Promise<Snapshot>;
  private readonly now: () => number;
  private readonly timers: Scheduler;
  private readonly pingMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly snapshotRetryMs: number;
  private readonly maxResyncAttempts: number;
  private readonly manageBook: boolean;
  private readonly manageConn: boolean;
  private readonly feedsChart: boolean;
  private readonly paints: PaintQueue<ServerFrame>;

  private readonly merger = new BookMerger();
  private readonly tape = new TradeTape();
  private readonly latency = new LatencyTracker();
  /** Cancel functions for everything this client has scheduled. */
  private readonly scheduled = new Set<() => void>();

  private socket: SocketLike | null = null;
  private snapshotRequest: AbortController | null = null;
  /** One snapshot request at a time, in flight or waiting to be retried. */
  private requestInFlight = false;
  private attempts = 0;
  /** Gaps since the last frame that actually chained — the refetch breaker. */
  private consecutiveGaps = 0;
  private malformed = 0;
  private gaps = 0;
  /** Sessions opened so far: the first dial has no series to heal, a reconnect does. */
  private sessions = 0;
  private running = false;

  constructor(options: WsClientOptions) {
    this.url = options.url;
    this.stores = options.stores;
    this.connect = options.connect ?? browserSocketFactory;
    this.snapshot = options.snapshot ?? fetchSnapshot;
    this.now = options.now ?? (() => Date.now());
    this.timers = options.timers ?? browserScheduler;
    this.pingMs = options.pingMs ?? PING_INTERVAL_MS;
    this.reconnectBaseMs = options.reconnectBaseMs ?? RECONNECT_BASE_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? RECONNECT_MAX_MS;
    this.snapshotRetryMs = options.snapshotRetryMs ?? SNAPSHOT_RETRY_MS;
    this.maxResyncAttempts = options.maxResyncAttempts ?? MAX_RESYNC_ATTEMPTS;
    this.manageBook = options.manageBook ?? true;
    this.manageConn = options.manageConn ?? true;
    this.feedsChart = options.feedsChart ?? true;
    this.paints = new PaintQueue<ServerFrame>(
      this.timers,
      this.now,
      (frame) => this.dispatchFrame(frame),
      options.smoothWindowMs ?? SMOOTH_WINDOW_MS,
    );
  }

  /**
   * The debug override (T4): force a delivery tier, or `null` to clear it.
   *
   * The store holds the user's *intent* — the selection the panel renders —
   * and the backend's answer to it arrives as an ordinary `tier` frame, so this
   * method never writes `tier`/`tierRate`: which tier is in force stays the
   * backend's decision (`CONTEXT.md`). `lib/tier-readout.ts` is what turns the
   * two facts side by side into the badge's wording.
   *
   * With no socket up the frame cannot go out, so the intent is recorded and
   * asserted when a session opens (`handleOpen`) — a selection that silently
   * evaporated, or that kept a label saying "forced" over a backend tiering
   * automatically, are both versions of presenting something stale as live.
   */
  forceTier(tier: Tier | null): void {
    setOverride(this.stores.conn, tier);
    // A session that does not own telemetry records the intent but sends
    // nothing: its backend tier throttles nothing, so forcing it is noise.
    if (this.manageConn) {
      this.send({ type: "force", tier });
    }
  }

  /** Dial and keep the connection up until `stop()`. */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.attempts = 0;
    this.open();
  }

  /** Close, and leave nothing scheduled: unmounting the screen ends the session. */
  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    const socket = this.socket;
    this.socket = null;
    this.abortSnapshotRequest();
    this.clearScheduled();
    // Queued paints die with the session: a reconnect resyncs from a snapshot
    // rather than replaying stale frames.
    this.paints.dispose();
    // The close event this triggers is ignored: `this.socket` is already null,
    // so no reconnect is scheduled after a deliberate stop.
    socket?.close();
    this.merger.reset();
    this.requestInFlight = false;
    if (this.manageBook) {
      this.stores.book.setState({ status: this.hasData ? "stale" : "down", syncing: false });
    }
  }

  private get hasData(): boolean {
    return selectHasData(this.stores.book.getState());
  }

  private open(): void {
    if (!this.running) {
      return;
    }
    const socket = this.connect(this.url);
    this.socket = socket;
    // Every handler checks that it still belongs to the live socket: a socket
    // that has been superseded (reconnect, stop) must not touch state.
    socket.onopen = () => {
      if (this.socket === socket) {
        this.handleOpen();
      }
    };
    socket.onmessage = (data) => {
      if (this.socket === socket) {
        this.handleMessage(data);
      }
    };
    socket.onclose = () => {
      if (this.socket === socket) {
        this.handleClose();
      }
    };
    // Dialing is not live: cached values stay visibly stale until frames land.
    if (this.manageBook) {
      this.stores.book.setState({ status: this.hasData ? "stale" : "connecting" });
    }
  }

  private handleOpen(): void {
    this.attempts = 0;
    // A reconnect is a new session (CONTEXT.md): the old book ids, the old
    // buffer, and the old round trips say nothing about this stream.
    this.merger.reset();
    this.latency.reset();
    this.consecutiveGaps = 0;
    // The chart's series is fed by this stream, so a new session inherits a
    // series with a hole in its tail: the buckets that finished while the socket
    // was down were only ever delivered to the stream that ended. The first dial
    // has nothing to heal — the history request the chart opens with is already
    // in flight — so the signal is sent on reconnects only.
    if (this.feedsChart && this.sessions > 0) {
      invalidateHistory(this.stores.candle);
    }
    this.sessions += 1;
    // Two stores, two writes: the book is syncing, and the round trips belonged
    // to the session that just ended.
    if (this.manageBook) {
      this.stores.book.setState({ syncing: true });
    }
    if (this.manageConn) {
      this.stores.conn.setState({ rttMs: null, latencyMs: null, jitterMs: null });
    }
    // Ping immediately so the first report 2s from now carries a real number
    // instead of begging the backend for a missed-report downgrade.
    if (this.manageConn) {
      this.ping();
    }
    // A standing debug override belongs to the user, not to the session that
    // ended: a reconnect is a new backend state machine with no override on it, so
    // it is sent again here. Without this the badge would claim "forced" while
    // the new session tiered automatically — stale-as-live, one field over.
    const override = this.stores.conn.getState().override;
    if (this.manageConn && override !== null) {
      this.send({ type: "force", tier: override });
    }
    if (this.manageBook) {
      void this.syncBook();
    }
    // Half-open sockets never close: without this the screen would say live
    // forever after a switch that strands the TCP session (no close frame, no
    // more frames). The previous session's timer died with it (`handleClose`
    // clears everything scheduled), so starting one here is exactly-once per
    // session.
    if (this.manageBook) {
      this.after(FRAME_STALE_CHECK_MS, () => this.checkFrames());
    }
  }

  private handleMessage(data: unknown): void {
    let frame: ServerFrame;
    try {
      frame = parseServerFrame(data);
    } catch (error) {
      if (!(error instanceof ProtocolError)) {
        // The guards only ever throw ProtocolError; anything else is our bug
        // and swallowing it here would hide it behind a silent screen.
        throw error;
      }
      // Malformed traffic is dropped and counted (SEAMS Slice B): a broken
      // frame must never reach the merge, and must never stop the stream.
      this.malformed += 1;
      this.stores.book.setState({ malformed: this.malformed });
      return;
    }

    // Paint throttle (SPEC story 10): smooth mode queues the parsed frame for
    // the next animation frame; full mode flushes anything queued first (a flip
    // mid-burst must not reorder) and dispatches inline, exactly as before.
    if (getPaintMode() === "smooth") {
      this.paints.enqueue(frame);
      return;
    }
    this.paints.flush();
    this.dispatchFrame(frame);
  }

  /**
   * One parsed frame into the stores: tape, book merge, tier, pong, candles.
   * Called inline at full rate, or in FIFO order from the paint queue when
   * smooth — the merger sees the identical sequence either way.
   */
  private dispatchFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case "trade":
        // A chart-only session never sees the tape: ignore, do not mark.
        if (!this.manageBook) {
          return;
        }
        if (this.tape.push(frame)) {
          this.stores.book.setState({ trades: this.tape.trades });
          this.markData();
        }
        return;
      case "book":
        // A chart-only session never sees the book: ignore, do not sync.
        if (!this.manageBook) {
          return;
        }
        this.handleBookFrame(frame);
        return;
      case "tier":
        // A market-only session's tier throttles nothing: ignore.
        if (!this.manageConn) {
          return;
        }
        // The backend's decision, rendered as-is: the client does not compute it.
        this.stores.conn.setState({ tier: frame.tier, tierRate: frame.rate });
        return;
      case "pong":
        // No ping loop here means no round trip to measure: ignore.
        if (!this.manageConn) {
          return;
        }
        this.handlePong(frame);
        return;
      case "candle":
        // A market-only session carries no candles: ignore, do not file.
        if (!this.feedsChart) {
          return;
        }
        // The chart's series, through the store that owns it: the frame decides
        // where a candle belongs (finished buckets into the history, the forming
        // one beside them), and a frame for an interval this session is not
        // subscribed to is dropped there rather than rendered by mistake.
        applyCandleFrame(this.stores.candle, frame);
        return;
    }
  }

  private handleBookFrame(frame: BookFrame): void {
    const outcome = this.merger.ingest(frame);
    switch (outcome.kind) {
      case "applied":
        // The feed chained onto what we hold: whatever recovery was in progress
        // worked, so the breaker starts over.
        this.consecutiveGaps = 0;
        this.adoptBook();
        this.markData();
        return;
      case "buffered":
        // Fresh transport, frozen book: `syncing` is what says so on screen.
        this.markData();
        return;
      case "gap":
        // Missed or out-of-order frames: the only safe move is a new snapshot.
        this.registerGap();
        return;
      case "awaiting-snapshot":
        // No base yet (the first snapshot has not landed): ask for one.
        this.scheduleSync();
        return;
      case "ignored":
        // A repeat or a late arrival: already in the image on screen.
        return;
    }
  }

  private handlePong(frame: PongFrame): void {
    const rtt = rttFromPong(frame.tSend, frame.tRecv);
    if (rtt === null) {
      // The fields are the ones PROTOCOL.md names, so this is not malformed
      // traffic — it is simply not a sample worth reporting.
      return;
    }
    const stats = this.latency.recordRtt(rtt);
    if (stats === null) {
      return;
    }
    this.stores.conn.setState({
      rttMs: stats.rttMs,
      latencyMs: stats.latencyMs,
      jitterMs: stats.jitterMs,
    });
  }

  private handleClose(): void {
    this.socket = null;
    this.abortSnapshotRequest();
    // Timers belong to the session that just ended.
    this.clearScheduled();
    this.merger.reset();
    this.requestInFlight = false;
    this.consecutiveGaps = 0;
    // The book and the tape stay on screen — that is the cached state the
    // `stale` label exists to be honest about.
    if (this.manageBook) {
      this.stores.book.setState({ status: this.hasData ? "stale" : "down", syncing: false });
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running) {
      return;
    }
    /*
     * Exponential backoff with a cap, and no jitter: one tab reconnecting to a
     * backend the user just killed, where a deterministic delay is easier to
     * demo and to reason about than a scattered one (`lib/config.ts`).
     */
    const delay = Math.min(this.reconnectBaseMs * 2 ** this.attempts, this.reconnectMaxMs);
    this.attempts += 1;
    this.after(delay, () => this.open());
  }

  /**
   * Fetch the book snapshot and adopt it. Concurrent calls collapse: one
   * request at a time is what makes the buffer meaningful.
   */
  private async syncBook(): Promise<void> {
    if (!this.running || this.socket === null || this.requestInFlight) {
      return;
    }
    this.requestInFlight = true;
    this.merger.beginSync();
    this.stores.book.setState({ syncing: true });

    const controller = new AbortController();
    this.snapshotRequest = controller;

    let snapshot: Snapshot;
    try {
      snapshot = await this.snapshot(controller.signal);
    } catch {
      if (this.snapshotRequest !== controller) {
        // Superseded by a reconnect or a stop: that session owns the retry.
        return;
      }
      this.snapshotRequest = null;
      this.requestInFlight = false;
      // `failSync` keeps the merger buffering: applying a frame onto a base we
      // could not establish is exactly the corrupt book this slice prevents.
      this.merger.failSync();
      this.after(this.snapshotRetryMs, () => void this.syncBook());
      return;
    }

    if (this.snapshotRequest !== controller) {
      return;
    }
    this.snapshotRequest = null;
    this.requestInFlight = false;

    const outcome = this.merger.endSync(snapshot);
    this.stores.book.setState({ syncing: false });
    this.adoptBook();
    this.markData();
    if (outcome.kind === "gap") {
      // The buffered frames could not be chained onto the snapshot either:
      // another gap, even though the snapshot itself is now the trusted base.
      this.registerGap();
    }
  }

  /**
   * The book did not chain onto the feed. Ask for a new snapshot — immediately
   * while recovery is converging, because a fresh base plus a live frame is what
   * heals — and back off once a run of gaps says the two sides disagree.
   * Without the breaker, a feed whose frames never chain would refetch at frame
   * rate for as long as it lasts.
   */
  private registerGap(): void {
    this.consecutiveGaps += 1;
    this.gaps += 1;
    this.stores.book.setState({ gaps: this.gaps });
    this.scheduleSync();
  }

  /** A gap was seen or there is no base: refetch, without stacking requests. */
  private scheduleSync(): void {
    if (this.requestInFlight) {
      return;
    }
    const delay = this.consecutiveGaps >= this.maxResyncAttempts ? this.snapshotRetryMs : 0;
    this.after(delay, () => void this.syncBook());
  }

  /** Put the merger's trusted image on screen, with the ticker's movement. */
  private adoptBook(): void {
    const book = this.merger.book;
    if (book === null) {
      return;
    }
    // Read before the patch: movement is against the previous image, and a
    // re-fetched snapshot with the same price must read as flat, not as a move.
    const prev = this.stores.book.getState();
    const mid = midPrice(book);
    const session = trackSession(
      { open: prev.sessionOpen, high: prev.sessionHigh, low: prev.sessionLow },
      mid,
    );
    this.stores.book.setState({
      book,
      mid,
      previousMid: prev.mid,
      sessionOpen: session.open,
      sessionHigh: session.high,
      sessionLow: session.low,
    });
  }

  /** Market data landed: the screen is live if the socket is up and we hold some. */
  private markData(): void {
    const status = this.socket === null ? (this.hasData ? "stale" : "down") : this.hasData ? "live" : "connecting";
    this.stores.book.setState({ lastFrameAt: this.now(), status });
  }

  /**
   * The frame-age watchdog (SPEC story 9): an open socket that stopped
   * delivering is a dead connection, not a quiet market. Past
   * `FRAME_STALE_AFTER_MS` of silence the cached values on screen are marked
   * stale; the next frame flips them back through `markData`. Chart-only
   * sessions never start this (they own no book, and candle delivery is
   * throttled by design at slow tiers).
   */
  private checkFrames(): void {
    if (!this.running || this.socket === null) {
      return;
    }
    const state = this.stores.book.getState();
    if (state.status === "live" && state.lastFrameAt !== null && this.now() - state.lastFrameAt > FRAME_STALE_AFTER_MS) {
      this.stores.book.setState({ status: "stale" });
    }
    this.after(FRAME_STALE_CHECK_MS, () => this.checkFrames());
  }

  /**
   * Ping, and report what the last ping measured. PROTOCOL.md fixes both at 2s
   * and the backend ignores reports until T4, which is why sending them early
   * costs nothing and reading them late costs a tier.
   */
  private ping(): void {
    if (this.socket === null) {
      return;
    }
    this.send({ type: "ping", tSend: this.now() });
    const stats = this.latency.stats;
    if (stats !== null) {
      // With only one round trip there is no spread to report; 0 is the honest
      // reading of that, and the next tick carries a real EMA.
      this.send({
        type: "report",
        latencyMs: roundTo1(stats.latencyMs),
        jitterMs: roundTo1(stats.jitterMs ?? 0),
      });
    }
    this.after(this.pingMs, () => this.ping());
  }

  private send(frame: ClientFrame): void {
    const socket = this.socket;
    if (socket === null) {
      return;
    }
    try {
      socket.send(serializeClientFrame(frame));
    } catch {
      // A send on a socket that is closing (or still connecting) throws; the
      // close handler owns recovery, so there is nothing useful to do here.
    }
  }

  private abortSnapshotRequest(): void {
    const controller = this.snapshotRequest;
    this.snapshotRequest = null;
    controller?.abort();
  }

  private after(ms: number, fn: () => void): void {
    let cancel: (() => void) | null = null;
    const run = (): void => {
      if (cancel !== null) {
        this.scheduled.delete(cancel);
      }
      fn();
    };
    cancel = this.timers.schedule(run, ms);
    this.scheduled.add(cancel);
  }

  private clearScheduled(): void {
    for (const cancel of [...this.scheduled]) {
      cancel();
    }
    this.scheduled.clear();
  }
}

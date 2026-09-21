/**
 * Paint throttle (SPEC story 10): receive fast, paint slow.
 *
 * The industry pattern (receive at feed rate, paint at display rate): every
 * frame is still *ingested* — the queue is FIFO, so the book merger sees the
 * identical ordered sequence and its `prevSeq` chaining never breaks — but the
 * store writes collapse from one task per socket message into one React batch
 * per sampling window (500ms). Finished candles stay byte-identical:
 * coalescing paints cannot corrupt data, only skip showing intermediate ones.
 *
 * Two halves, matching the repo's split: this module owns the mode and the
 * time-window queue (React-free and DOM-free — `WsClient` reads the mode per
 * message and drains through the queue); `hooks/usePaintThrottle.ts` owns the
 * owns the toggle state and the `localStorage` handle. The default is `full`
 * (today's behavior, untouched); `smooth` is opt-in from the navbar toggle.
 */

import type { BackendUrlStorage } from "@/lib/backend-url";
import type { Scheduler } from "@/lib/retry";

/** Where the user's choice lives between visits. */
export const PAINT_THROTTLE_STORAGE_KEY = "rt-crypto-trading:paint-throttle";

/** `full` paints every frame as it lands; `smooth` paints one batch per window. */
export type PaintMode = "full" | "smooth";

/**
 * What the app paints: the stored choice when it names a mode, otherwise the
 * full-rate default. A hand edit in devtools falls back instead of bricking
 * the screen.
 */
export function resolvePaintMode(stored: unknown): PaintMode {
  return stored === "smooth" ? "smooth" : "full";
}

/** Read the stored choice. `null` means "no choice yet" — paint full-rate. */
export function readStoredPaintMode(storage: BackendUrlStorage): string | null {
  try {
    return storage.getItem(PAINT_THROTTLE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Persist the choice. A refusal (quota, private mode) leaves the session on
 * the new mode without remembering it — worth less than breaking the switch.
 */
export function writeStoredPaintMode(storage: BackendUrlStorage, mode: PaintMode): void {
  try {
    storage.setItem(PAINT_THROTTLE_STORAGE_KEY, mode);
  } catch {
    // Session-only: paints still throttle, this browser just forgets.
  }
}

/**
 * The live mode `WsClient` reads per message. Module state (not a store) on
 * purpose: the client is React-free and must see a flip without a redial.
 * Starts `full`; the hook syncs the stored choice after mount, so the first
 * paint agrees with the server HTML and a burst before the sync paints at
 * full rate rather than inventing a third mode.
 */
let current: PaintMode = "full";
const listeners = new Set<() => void>();

/** The mode frames dispatch under right now. */
export function getPaintMode(): PaintMode {
  return current;
}

/** Flip the live mode and tell every subscriber (today only the toggle). */
export function setPaintMode(mode: PaintMode): void {
  if (current === mode) {
    return;
  }
  current = mode;
  for (const listener of [...listeners]) {
    listener();
  }
}

/** Test-only reset: production reaches `full` by starting there. */
export function resetPaintMode(): void {
  current = "full";
  listeners.clear();
}

/** Run `listener` on every flip; returns the unsubscribe function. */
export function subscribePaintMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The smooth sampling window: frames landing inside one window paint as a
 * single batch when it closes. 500ms halves book paints and quarters candle
 * paints at full tier — visibly calmer without feeling dead.
 */
export const SMOOTH_WINDOW_MS = 500;

/**
 * Insurance cap on queued frames. A 500ms window holds a handful of frames
 * at feed rate, so this only trips under a pathological burst — and then
 * dropping the oldest is safe: a broken book chain refetches a snapshot
 * (SEAMS Slice B), and candles are idempotent.
 */
export const PAINT_QUEUE_CAP = 256;

/**
 * Time-window frame queue: the actual throttle. Frames enqueue on arrival;
 * the first frame of a window schedules one flush at the window's close,
 * and the flush dispatches everything queued, oldest first, in one batch.
 * Order in, order out — the merger cannot tell throttled apart from
 * unthrottled except by timing. The clock and timers are injected (the
 * client passes its own), so tests assert windows as numbers.
 */
export class PaintQueue<T> {
  private queue: T[] = [];
  private cancelScheduled: (() => void) | null = null;
  private windowStart = 0;

  constructor(
    private readonly timers: Scheduler,
    private readonly now: () => number,
    private readonly dispatch: (frame: T) => void,
    private readonly windowMs: number = SMOOTH_WINDOW_MS,
  ) {}

  /** Frames waiting for the window to close. */
  get pending(): number {
    return this.queue.length;
  }

  /** Append a frame; the first of a window schedules its closing flush. */
  enqueue(frame: T): void {
    if (this.queue.length >= PAINT_QUEUE_CAP) {
      this.queue.shift();
    }
    if (this.queue.length === 0) {
      this.windowStart = this.now();
    }
    this.queue.push(frame);
    if (this.cancelScheduled === null) {
      const delay = Math.max(0, this.windowStart + this.windowMs - this.now());
      this.cancelScheduled = this.timers.schedule(() => {
        this.cancelScheduled = null;
        this.flush();
      }, delay);
    }
  }

  /** Dispatch everything queued, oldest first, in one batch. */
  flush(): void {
    if (this.queue.length === 0) {
      return;
    }
    const frames = this.queue;
    this.queue = [];
    for (const frame of frames) {
      this.dispatch(frame);
    }
  }

  /** Cancel the scheduled flush and drop the queue: the session ended, and a
   * reconnect resyncs from a snapshot rather than replaying stale frames. */
  dispose(): void {
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    this.queue = [];
  }
}

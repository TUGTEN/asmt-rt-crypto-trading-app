import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BackendUrlStorage } from "@/lib/backend-url";
import {
  getPaintMode,
  PAINT_QUEUE_CAP,
  PaintQueue,
  readStoredPaintMode,
  resetPaintMode,
  resolvePaintMode,
  setPaintMode,
  SMOOTH_WINDOW_MS,
  subscribePaintMode,
  writeStoredPaintMode,
} from "@/lib/paint-throttle";
import type { Scheduler } from "@/lib/retry";

/**
 * Paint throttle (SPEC story 10): the mode, the queue, and the window.
 *
 * The contract under test: `full` is the default everywhere (today's behavior
 * is untouched until the user flips the navbar toggle); the queue batches
 * one window into one flush, strictly FIFO (the book merger's `prevSeq`
 * chaining cannot tell throttled apart from unthrottled); the cap drops the
 * oldest; dispose cancels and drops. Nothing here sleeps.
 */

function memoryStorage(): BackendUrlStorage & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (key) => (key in data ? data[key]! : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

/** A clock plus timer queue the test advances by hand. */
function manualTimers(start = 0) {
  const tasks = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  let now = start;
  const timers: Scheduler = {
    schedule: (fn, ms) => {
      const id = nextId;
      nextId += 1;
      tasks.set(id, { at: now + ms, fn });
      return () => {
        tasks.delete(id);
      };
    },
  };
  return {
    timers,
    now: (): number => now,
    scheduled: (): number => tasks.size,
    advance: (ms: number): void => {
      const until = now + ms;
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
        now = Math.max(now, due.at);
        due.fn();
      }
      now = until;
    },
  };
}

describe("resolvePaintMode", () => {
  it("paints full-rate unless storage names smooth", () => {
    expect(resolvePaintMode("smooth")).toBe("smooth");
    for (const stored of [null, undefined, "", "full", "SMOOTH", " smooth ", 42, {}]) {
      expect(resolvePaintMode(stored)).toBe("full");
    }
  });
});

describe("stored paint mode", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();
    expect(readStoredPaintMode(storage)).toBeNull();
    writeStoredPaintMode(storage, "smooth");
    expect(readStoredPaintMode(storage)).toBe("smooth");
  });

  it("survives a refusing storage", () => {
    const refusing: BackendUrlStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(readStoredPaintMode(refusing)).toBeNull();
    expect(() => writeStoredPaintMode(refusing, "smooth")).not.toThrow();
  });
});

describe("live paint mode", () => {
  beforeEach(() => {
    resetPaintMode();
  });

  it("starts full and flips with notification", () => {
    expect(getPaintMode()).toBe("full");
    const seen: string[] = [];
    const stop = subscribePaintMode(() => {
      seen.push(getPaintMode());
    });
    setPaintMode("smooth");
    expect(getPaintMode()).toBe("smooth");
    expect(seen).toEqual(["smooth"]);
    setPaintMode("smooth");
    expect(seen).toEqual(["smooth"]);
    stop();
    setPaintMode("full");
    expect(seen).toEqual(["smooth"]);
  });
});

describe("PaintQueue", () => {
  it("holds a window of frames and paints one batch when it closes, oldest first", () => {
    const clock = manualTimers();
    const dispatched: number[] = [];
    const queue = new PaintQueue<number>(clock.timers, clock.now, (n) => {
      dispatched.push(n);
    });
    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    expect(clock.scheduled()).toBe(1);
    expect(queue.pending).toBe(3);
    clock.advance(SMOOTH_WINDOW_MS - 1);
    expect(dispatched).toEqual([]);
    clock.advance(1);
    expect(dispatched).toEqual([1, 2, 3]);
    expect(queue.pending).toBe(0);
    // A new window starts its own flush.
    queue.enqueue(4);
    expect(clock.scheduled()).toBe(1);
  });

  it("drops the oldest past the cap", () => {
    const clock = manualTimers();
    const dispatched: number[] = [];
    const queue = new PaintQueue<number>(clock.timers, clock.now, (n) => {
      dispatched.push(n);
    });
    for (let n = 1; n <= PAINT_QUEUE_CAP + 2; n += 1) {
      queue.enqueue(n);
    }
    expect(queue.pending).toBe(PAINT_QUEUE_CAP);
    clock.advance(SMOOTH_WINDOW_MS);
    expect(dispatched[0]).toBe(3);
    expect(dispatched).toHaveLength(PAINT_QUEUE_CAP);
  });

  it("dispose cancels the flush and drops the queue", () => {
    const clock = manualTimers();
    const dispatch = vi.fn();
    const queue = new PaintQueue<number>(clock.timers, clock.now, dispatch);
    queue.enqueue(1);
    queue.dispose();
    expect(clock.scheduled()).toBe(0);
    expect(queue.pending).toBe(0);
    clock.advance(SMOOTH_WINDOW_MS * 2);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("flushing empty dispatches nothing", () => {
    const clock = manualTimers();
    const dispatch = vi.fn();
    const queue = new PaintQueue<number>(clock.timers, clock.now, dispatch);
    queue.flush();
    expect(dispatch).not.toHaveBeenCalled();
    expect(clock.scheduled()).toBe(0);
  });
});

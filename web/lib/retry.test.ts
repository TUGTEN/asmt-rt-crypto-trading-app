import { describe, expect, it } from "vitest";

import { startRetryLoop, type RetryDecision, type Scheduler } from "@/lib/retry";

/**
 * The shape `useBackendConfig` and `useCandleHistory` used to own each, pinned
 * once: run now, run again after the delay on `"retry"`, and run nothing after
 * cancel — with the abort visible to the in-flight attempt either way.
 *
 * Time is a manual queue, the way `lib/ws-client.test.ts` drives backoff: the
 * retry cadence is asserted as numbers, never waited for.
 */

function manualScheduler(): {
  scheduler: Scheduler;
  delays: number[];
  pending: number;
  fire: () => void;
} {
  const pending = new Map<number, () => void>();
  let nextId = 1;
  const delays: number[] = [];
  return {
    scheduler: {
      schedule(fn, ms) {
        const id = nextId;
        nextId += 1;
        pending.set(id, fn);
        delays.push(ms);
        return () => {
          pending.delete(id);
        };
      },
    },
    delays,
    get pending(): number {
      return pending.size;
    },
    fire(): void {
      for (const fn of [...pending.values()]) {
        fn();
      }
      pending.clear();
    },
  };
}

/** Let the attempt's promise chain settle without moving the clock. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("startRetryLoop", () => {
  it("runs the task immediately, with a signal that is not aborted", async () => {
    const clock = manualScheduler();
    const seen: boolean[] = [];
    const cancel = startRetryLoop(
      async (signal) => {
        seen.push(signal.aborted);
        return "done";
      },
      3000,
      clock.scheduler,
    );
    await settle();

    expect(seen).toEqual([false]);
    expect(clock.pending).toBe(0);
    cancel();
  });

  it("schedules nothing once the task reports done", async () => {
    const clock = manualScheduler();
    let attempts = 0;
    const cancel = startRetryLoop(
      async () => {
        attempts += 1;
        return "done";
      },
      3000,
      clock.scheduler,
    );
    await settle();
    clock.fire();
    await settle();

    expect(attempts).toBe(1);
    expect(clock.delays).toEqual([]);
    cancel();
  });

  it("runs the task again after the delay while it reports retry", async () => {
    const clock = manualScheduler();
    let attempts = 0;
    const cancel = startRetryLoop(
      async (): Promise<RetryDecision> => {
        attempts += 1;
        return attempts < 3 ? "retry" : "done";
      },
      3000,
      clock.scheduler,
    );
    await settle();
    expect(attempts).toBe(1);

    clock.fire();
    await settle();
    expect(attempts).toBe(2);

    clock.fire();
    await settle();
    expect(attempts).toBe(3);
    expect(clock.delays).toEqual([3000, 3000]);
    expect(clock.pending).toBe(0);
    cancel();
  });

  it("retries a task that throws, the way a failed fetch retries", async () => {
    const clock = manualScheduler();
    let attempts = 0;
    const cancel = startRetryLoop(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("backend unreachable");
        }
        return "done";
      },
      3000,
      clock.scheduler,
    );
    await settle();
    clock.fire();
    await settle();

    expect(attempts).toBe(2);
    expect(clock.pending).toBe(0);
    cancel();
  });

  it("cancel aborts the in-flight attempt and drops the scheduled one", async () => {
    const clock = manualScheduler();
    const aborted: boolean[] = [];
    let attempts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = startRetryLoop(
      async (signal) => {
        attempts += 1;
        aborted.push(signal.aborted);
        if (attempts === 1) {
          await gate;
          aborted.push(signal.aborted);
          return "retry";
        }
        return "done";
      },
      3000,
      clock.scheduler,
    );
    await settle();
    cancel();
    release();
    await settle();
    clock.fire();
    await settle();

    // The attempt saw the abort, its late `"retry"` scheduled nothing, and a
    // second attempt never ran.
    expect(aborted).toEqual([false, true]);
    expect(attempts).toBe(1);
    expect(clock.pending).toBe(0);
  });

  it("settles a throw that lands after cancel instead of retrying it", async () => {
    const clock = manualScheduler();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = startRetryLoop(
      async () => {
        await gate;
        throw new Error("late failure");
      },
      3000,
      clock.scheduler,
    );
    await settle();
    cancel();
    release();
    await settle();

    expect(clock.delays).toEqual([]);
    expect(clock.pending).toBe(0);
  });
});

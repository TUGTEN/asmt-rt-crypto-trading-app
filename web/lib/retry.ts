/**
 * One async attempt, retried on a fixed cadence until it says it is done.
 *
 * `useBackendConfig` and `useCandleHistory` used to own this lifecycle each —
 * an `AbortController`, a `stopped` flag, a `setTimeout` retry, and the
 * cleanup that cancels all three. This module owns that shape once; the hooks
 * own only their task (what one attempt means) and their delay.
 *
 * React-free, like the rest of `lib/`: the driver returns a cancel function,
 * so an effect body is one construction and one `return cancel`. The clock is
 * injected — production passes `browserScheduler`, tests pass a manual queue —
 * which is what keeps the retry cadence assertable as numbers instead of
 * waited for (`lib/retry.test.ts`).
 */

/**
 * One-shot scheduling, injected. The production implementation is
 * `setTimeout`; tests get a manual queue so delays are asserted as numbers
 * instead of waited for.
 */
export type Scheduler = {
  /** Run `fn` after `ms`; returns the cancel function. */
  schedule: (fn: () => void, ms: number) => () => void;
};

export const browserScheduler: Scheduler = {
  schedule: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

/** What one attempt decided: stop retrying, or go again after the delay. */
export type RetryDecision = "done" | "retry";

/**
 * One attempt. Reads `signal` the way any abortable task does, and checks it
 * before touching outside state: an attempt that lands after the caller
 * stopped caring must not write.
 */
export type RetryTask = (signal: AbortSignal) => Promise<RetryDecision>;

/**
 * Run `task` now; whenever it reports `"retry"`, run it again after `retryMs`.
 * Returns the cancel function: it aborts the in-flight attempt and drops any
 * scheduled one, so nothing runs after the caller stopped caring.
 *
 * A task that throws is retried like a `"retry"` verdict — a failed fetch and
 * a failed attempt are the same thing to a loop whose job is "until it lands" —
 * except when the signal is already aborted, which always settles.
 */
export function startRetryLoop(
  task: RetryTask,
  retryMs: number,
  timers: Scheduler = browserScheduler,
): () => void {
  const controller = new AbortController();
  let cancelled = false;
  let cancelScheduled: (() => void) | null = null;

  const attempt = async (): Promise<void> => {
    let decision: RetryDecision;
    try {
      decision = await task(controller.signal);
    } catch {
      decision = controller.signal.aborted ? "done" : "retry";
    }
    if (cancelled || controller.signal.aborted) {
      return;
    }
    if (decision === "retry") {
      cancelScheduled = timers.schedule(() => {
        cancelScheduled = null;
        void attempt();
      }, retryMs);
    }
  };

  void attempt();

  return () => {
    cancelled = true;
    controller.abort();
    cancelScheduled?.();
    cancelScheduled = null;
  };
}

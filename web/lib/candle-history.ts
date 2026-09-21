/**
 * Reading one interval's history into the chart's store.
 *
 * This is the REST door onto the candle series, and it is deliberately a plain
 * async function rather than a query library: the series has exactly one home
 * (`stores/candle.ts`), so a second cache of the same candles would only be a
 * second thing to invalidate and a second way for the chart and the data to
 * disagree. The guards a cache would otherwise provide are explicit here and
 * pinned in `lib/candle-history.test.ts`:
 *
 * - the request id identifies this read; a response that finishes after a newer
 *   request started is dropped, not painted,
 * - the interval the response echoes has to be the one currently on screen, so a
 *   response for an interval the viewer has left cannot become ghost candles,
 * - a failure keeps whatever is on screen (a refresh that could not be read is
 *   not a reason to erase the chart) and reports why.
 *
 * No React, no timers, no retries: the caller (`lib/hooks/useCandleHistory.ts`)
 * owns when to read and when to read again, and this module owns what one read
 * means.
 */

import { HISTORY_LIMIT } from "@/lib/config";
import { describeError, fetchHistory, type History, type Interval } from "@/lib/protocol";
import { applyHistory, failHistory, requestHistory, type CandleStore } from "@/stores/candle";

/** How the history is read; injected so a test can hold the response. */
export type HistoryFetcher = (
  interval: Interval,
  limit: number,
  signal: AbortSignal,
) => Promise<History>;

export type LoadHistoryOptions = {
  store: CandleStore;
  /**
   * The interval to read. Defaults to the one the chart is following: the store
   * is the single answer to "which interval is on screen", so a caller cannot
   * accidentally read a different one than it is drawing.
   */
  interval?: Interval;
  limit?: number;
  fetcher?: HistoryFetcher;
  signal?: AbortSignal;
};

/** What one read did, so the caller can decide whether to read again. */
export type HistoryOutcome =
  | { kind: "landed"; candles: number }
  | { kind: "dropped" }
  | { kind: "failed"; message: string }
  | { kind: "aborted" };

/**
 * A signal that never fires, for callers with nothing to cancel: the request
 * still carries the deadline `lib/protocol.ts` gives every one of them.
 */
const NEVER_ABORTED = new AbortController().signal;

export async function loadHistory(options: LoadHistoryOptions): Promise<HistoryOutcome> {
  const { store, limit = HISTORY_LIMIT, fetcher = fetchHistory, signal } = options;
  const interval = options.interval ?? store.getState().interval;
  const requestId = requestHistory(store, interval);

  let history: History;
  try {
    history = await fetcher(interval, limit, signal ?? NEVER_ABORTED);
  } catch (error) {
    if (signal?.aborted === true) {
      // The caller stopped caring (unmount, interval switch): silence, not an
      // error message about a request nobody is waiting for.
      return { kind: "aborted" };
    }
    const message = describeError(error);
    if (requestId !== store.getState().requestId) {
      return { kind: "dropped" };
    }
    failHistory(store, requestId, message);
    return { kind: "failed", message };
  }

  const current = store.getState();
  if (requestId !== current.requestId || history.interval !== current.interval) {
    return { kind: "dropped" };
  }
  applyHistory(store, requestId, history);
  return { kind: "landed", candles: history.candles.length };
}

"use client";

/**
 * The chart's history read, as a React effect.
 *
 * Two things decide when to read: the interval the chart is following, and
 * `historyEpoch` — which moves when a session ends, because the buckets that
 * finished while the socket was down were never delivered to us (`stores/candle.ts`).
 * The read itself — request id, the interval the response echoes, what a failure
 * leaves on screen — is `lib/candle-history.ts`, a plain async function; this
 * hook owns only the lifecycle and the retry.
 *
 * The retry is `lib/retry.ts`, shared with `useBackendConfig`: the page is
 * often open before the backend is, and a series that never heals after a
 * blip would look like an empty market. The request is aborted on unmount or on the next interval, so
 * nothing lands late.
 */

import { useEffect } from "react";

import { loadHistory, type HistoryFetcher } from "@/lib/candle-history";
import { API_BASE_URL, HISTORY_RETRY_MS } from "@/lib/config";
import { fetchHistory, type Interval } from "@/lib/protocol";
import { startRetryLoop, type RetryTask } from "@/lib/retry";
import { useCandleStore } from "@/lib/hooks/useMarketStores";
import { selectHistoryEpoch, selectInterval, type CandleStore } from "@/stores/candle";

export function useCandleHistory(store: CandleStore, baseUrl: string = API_BASE_URL, fetcher?: HistoryFetcher): void {
  const interval = useCandleStore(store, selectInterval);
  const epoch = useCandleStore(store, selectHistoryEpoch);

  useEffect(() => {
    // One attempt, retried on a fixed cadence: the loop itself is
    // `lib/retry.ts` (shared with `useBackendConfig`), so this effect owns
    // only what one read means.
    const read: RetryTask = async (signal) => {
      const boundFetcher: HistoryFetcher = (i: Interval, limit: number, fetchSignal: AbortSignal) =>
        fetchHistory(i, limit, fetchSignal, baseUrl);
      const outcome = await loadHistory({ store, interval, fetcher: fetcher ?? boundFetcher, signal });
      return outcome.kind === "failed" ? "retry" : "done";
    };

    return startRetryLoop(read, HISTORY_RETRY_MS);
  }, [store, interval, epoch, baseUrl, fetcher]);
}

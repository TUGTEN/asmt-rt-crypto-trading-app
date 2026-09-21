"use client";

/**
 * Backend-owned configuration: symbol, intervals, seed (`GET /api/config`).
 *
 * Retried until it lands, because the page is often opened before the backend
 * finishes booting; the prompt says one command starts the backend, and this
 * keeps the screen correct either way.
 *
 * Takes the chooser's backend URL: switching hosts refetches from the new one
 * from a loading state, so the old host's symbol never poses as the new one's.
 */

import { useEffect, useState } from "react";

import type { BackendConfig } from "@/lib/protocol";
import { describeError, fetchBackendConfig } from "@/lib/protocol";
import { startRetryLoop, type RetryTask } from "@/lib/retry";

const CONFIG_RETRY_MS = 3000;

export type BackendConfigState = {
  config: BackendConfig | null;
  error: string | null;
  loading: boolean;
};

export function useBackendConfig(backendUrl: string): BackendConfigState {
  const [state, setState] = useState<BackendConfigState>({
    config: null,
    error: null,
    loading: true,
  });
  // A new host is a new market: drop the old host's identity during render,
  // so its symbol never poses as the new one's while the refetch is in flight.
  // (Adjusted during render — the effect below only fetches and subscribes.)
  const [prevUrl, setPrevUrl] = useState(backendUrl);
  if (prevUrl !== backendUrl) {
    setPrevUrl(backendUrl);
    setState({ config: null, error: null, loading: true });
  }
  useEffect(() => {
    // One attempt, retried on a fixed cadence: the loop itself is
    // `lib/retry.ts`, so this effect owns only what one read means.
    const load: RetryTask = async (signal) => {
      try {
        const config = await fetchBackendConfig(signal, backendUrl);
        if (signal.aborted) {
          return "done";
        }
        setState({ config, error: null, loading: false });
        return "done";
      } catch (error) {
        if (signal.aborted) {
          return "done";
        }
        setState({ config: null, error: describeError(error), loading: false });
        return "retry";
      }
    };

    return startRetryLoop(load, CONFIG_RETRY_MS);
  }, [backendUrl]);

  return state;
}

"use client";

/**
 * The watchlist's UI state: which symbol is selected and in what order the
 * rows stand.
 *
 * Thin over `lib/watchlist.ts` the way `useBackendUrl` is thin over
 * `lib/backend-url.ts`: the reorder math, the storage key, and the fallback
 * order are all pure and pinned in `lib/watchlist.test.ts`, and this hook
 * only holds the two `useState`s and writes the order back on every real
 * move. Selection defaults to the live symbol; only known symbols stick.
 */

import { useCallback, useEffect, useState } from "react";

import {
  DEFAULT_ORDER,
  KNOWN_SYMBOLS,
  LIVE_SYMBOL,
  moveSymbol,
  readStoredOrder,
  watchlistStorage,
  writeStoredOrder,
} from "@/lib/watchlist";

export function useWatchlist() {
  // Default order on the server and first paint so hydration agrees;
  // the stored order lands in the effect below (one reorder at most).
  const [order, setOrder] = useState<string[]>(() => [...DEFAULT_ORDER]);

  useEffect(() => {
    const stored = readStoredOrder(watchlistStorage());
    // Hydration boundary: stored order lands after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOrder((current) => (current.join("\0") === stored.join("\0") ? current : stored));
  }, []);
  const [selected, setSelected] = useState<string>(LIVE_SYMBOL);

  const select = useCallback((symbol: string) => {
    if (KNOWN_SYMBOLS.includes(symbol)) {
      setSelected(symbol);
    }
  }, []);

  const reorder = useCallback((from: number, to: number) => {
    setOrder((prev) => {
      const next = moveSymbol(prev, from, to);
      // The write is idempotent, so StrictMode's double-invoked updater is
      // harmless; the join check skips storage on invalid drops.
      if (next.join("") !== prev.join("")) {
        writeStoredOrder(watchlistStorage(), next);
      }
      return next;
    });
  }, []);

  return { order, selected, select, reorder };
}

"use client";

/**
 * The React edge of the live stores: one selector per slice.
 *
 * Zustand is framework-agnostic at the store end (`zustand/vanilla`, which is
 * why `lib/ws-client.ts` can push frames in without React in its module graph)
 * and a hook at this end. `useStore(store, selector)` re-renders the calling
 * component only when the value the selector returned changes by `Object.is` —
 * so a panel that renders the book does not re-render on a pong, and a panel
 * that renders latency does not re-render at frame rate.
 *
 * The store is a parameter rather than a module singleton because the stores are
 * created per mounted session (`stores/market.ts`): the selector hooks are the
 * thin binding, not the owner. Selectors stay module-level functions
 * (`stores/book.ts`, `stores/conn.ts`) so the subscription React holds is stable
 * across renders — an inline selector would be re-created on every render and
 * hand `useSyncExternalStore` a new snapshot reader each time.
 */

import { useStore } from "zustand";

import type { BookState, BookStore } from "@/stores/book";
import type { CandleState, CandleStore } from "@/stores/candle";
import type { ConnState, ConnStore } from "@/stores/conn";

export function useBookStore<T>(store: BookStore, selector: (state: BookState) => T): T {
  return useStore(store, selector);
}

export function useConnStore<T>(store: ConnStore, selector: (state: ConnState) => T): T {
  return useStore(store, selector);
}

/** The chart's slice: what the candles panel and the history hook select from. */
export function useCandleStore<T>(store: CandleStore, selector: (state: CandleState) => T): T {
  return useStore(store, selector);
}

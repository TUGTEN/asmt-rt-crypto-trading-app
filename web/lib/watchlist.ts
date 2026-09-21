/**
 * The watchlist bonus (SPEC "watchlist reordering", explicitly bonus): one
 * live symbol plus static reference rows the user can reorder.
 *
 * The spec covers a single BTC-USD market, so only BTC-USD streams — the
 * book, tape, ticker, and chart stay on it no matter what is selected. The
 * other rows are *temporary reference symbols* with fixed prices, labelled
 * simulated on screen: they exist so reordering, selection, and persistence
 * are demoable without a second feed. Nothing here touches the network; the
 * panel reads the live BTC mid from the book store and everything else from
 * this module.
 *
 * React-free like the rest of the pure layer: order is a `string[]` of
 * symbols, reordered by `moveSymbol`, merged with the known set by
 * `normalizeOrder`, and persisted through an injected storage so tests hand
 * it a memory stub instead of `window.localStorage`.
 */

import { isDecimalString, type DecimalString } from "@/lib/decimal";

/** The one symbol that streams. Selecting anything else parks the chart. */
export const LIVE_SYMBOL = "BTC-USD";

/** A temporary reference row: fixed price, never streamed, always simulated. */
export type TempSymbol = {
  symbol: string;
  /** Static reference price, decimal string like the wire's (`p2s`). */
  refPrice: DecimalString;
};

export const TEMP_SYMBOLS: readonly TempSymbol[] = [
  { symbol: "ETH-USD", refPrice: "3512.44" },
  { symbol: "SOL-USD", refPrice: "172.18" },
  { symbol: "DOGE-USD", refPrice: "0.32" },
];

/** Every symbol the list knows, live first. */
export const KNOWN_SYMBOLS: readonly string[] = [
  LIVE_SYMBOL,
  ...TEMP_SYMBOLS.map((entry) => entry.symbol),
];

/** The order a fresh browser opens on. */
export const DEFAULT_ORDER: readonly string[] = [...KNOWN_SYMBOLS];

export const WATCHLIST_ORDER_KEY = "rt-crypto-trading:watchlist-order";

/** Minimal storage surface, so tests can pass a memory stub. */
export type StorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

/**
 * Move one entry inside an order: the row at `from` lands at `to`, the rows
 * between shift to fill the gap. Out-of-range indices are a no-op rather
 * than a corrupt list — a drop outside the list must never blank it.
 */
export function moveSymbol(order: readonly string[], from: number, to: number): string[] {
  const next = [...order];
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    from >= next.length ||
    to >= next.length
  ) {
    return next;
  }
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Merge a stored order with the known set: keep the stored sequence for
 * symbols still known, drop anything unknown (a hand edit in devtools, a
 * symbol retired since), and append new symbols in `KNOWN_SYMBOLS` order so
 * a future addition lands at the end instead of vanishing.
 */
export function normalizeOrder(stored: readonly string[]): string[] {
  const known = new Set(KNOWN_SYMBOLS);
  const seen = new Set<string>();
  const next: string[] = [];
  for (const symbol of stored) {
    if (known.has(symbol) && !seen.has(symbol)) {
      seen.add(symbol);
      next.push(symbol);
    }
  }
  for (const symbol of KNOWN_SYMBOLS) {
    if (!seen.has(symbol)) {
      seen.add(symbol);
      next.push(symbol);
    }
  }
  return next;
}

/** Parse a stored order; garbage (or a non-list) falls back to the default. */
export function parseStoredOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_ORDER];
  }
  const symbols = raw.filter((entry): entry is string => typeof entry === "string");
  if (symbols.length === 0) {
    return [...DEFAULT_ORDER];
  }
  return normalizeOrder(symbols);
}

/** Read the persisted order, or the default when storage is empty/broken. */
export function readStoredOrder(storage: StorageLike | null): string[] {
  if (storage === null) {
    return [...DEFAULT_ORDER];
  }
  let raw: string | null = null;
  try {
    raw = storage.getItem(WATCHLIST_ORDER_KEY);
  } catch {
    return [...DEFAULT_ORDER];
  }
  if (raw === null) {
    return [...DEFAULT_ORDER];
  }
  try {
    return parseStoredOrder(JSON.parse(raw) as unknown);
  } catch {
    return [...DEFAULT_ORDER];
  }
}

/** Persist an order; a storage that refuses is ignored, never thrown. */
export function writeStoredOrder(storage: StorageLike | null, order: readonly string[]): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(WATCHLIST_ORDER_KEY, JSON.stringify([...order]));
  } catch {
    // Blocked storage (private mode, denied permission) leaves the order
    // in memory for the visit; the list still works, it just forgets.
  }
}

/**
 * The browser's storage, or `null` where there is none (server render,
 * blocked access). Called at event time, not import time, so the module
 * stays importable anywhere.
 */
export function watchlistStorage(): StorageLike | null {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return null;
  }
  return window.localStorage;
}

/** Look up a temp row's static price, or `null` for the live symbol. */
export function tempRefPrice(symbol: string): DecimalString | null {
  for (const entry of TEMP_SYMBOLS) {
    if (entry.symbol === symbol) {
      return entry.refPrice;
    }
  }
  return null;
}

/** True for rows whose prices are static references, never streamed. */
export function isTempSymbol(symbol: string): boolean {
  return symbol !== LIVE_SYMBOL && tempRefPrice(symbol) !== null;
}

/** The temp table itself is a constant: every ref price parses as decimal. */
export function tempSymbolsValid(): boolean {
  return TEMP_SYMBOLS.every((entry) => isDecimalString(entry.refPrice));
}

/**
 * The market data on screen, and the freshness label that goes with it.
 *
 * One frame in, one state out — the networking module never assembles a view
 * model and a component never assembles a book. Everything here is a plain
 * value, so the panels stay presentational and the state is readable in a test
 * or in the devtools without walking a class.
 *
 * `Live vs Stale` (CONTEXT.md) is the field this store exists to get right: the
 * book and the tape are *kept* when the socket drops (that is the whole point of
 * a stale-while-dark screen), and `status` is what stops those cached values
 * from being presented as live. Nothing here is ever recomputed from the clock —
 * the fields are the last accepted truth plus how fresh it is.
 *
 * React-free on purpose (`zustand/vanilla`): `lib/ws-client.ts` pushes frames in
 * with `setState()` without a rendering layer in its module graph. Panels read
 * it through the selector hooks in `lib/hooks/useMarketStores.ts`, and the
 * selectors below are stable module-level functions so a 4Hz frame does not
 * hand React a new subscriber on every render.
 */

import { createStore, type StoreApi } from "zustand/vanilla";

import type { Snapshot, Trade } from "@/lib/protocol";

export type ConnectionStatus = "connecting" | "live" | "stale" | "down";

export type BookState = {
  /** Last book image we could chain onto, or `null` before the first sync. */
  book: Snapshot | null;
  /** Mid price of that image — the headline number, from the book. */
  mid: number | null;
  /** Mid price of the image before it: what the ticker's movement compares. */
  previousMid: number | null;
  /** First mid seen this mount: the session-change baseline (hero strip). */
  sessionOpen: number | null;
  /** Highest mid seen this mount: session high, never a 24h claim. */
  sessionHigh: number | null;
  /** Lowest mid seen this mount: session low, never a 24h claim. */
  sessionLow: number | null;
  /** The tape, newest first, bounded by `TRADE_TAPE_SIZE`. */
  trades: readonly Trade[];
  /** `live` = socket up *and* data held; `stale` = cached values shown. */
  status: ConnectionStatus;
  /**
   * A snapshot refetch is in flight (or a failed one is being retried): the
   * book on screen is frozen and will jump forward once it lands.
   */
  syncing: boolean;
  /** Local epoch millis when market data last arrived, not when a ping did. */
  lastFrameAt: number | null;
  /** Gaps healed by refetching a snapshot: the book's recovery count. */
  gaps: number;
  /** Frames dropped by the protocol guard. Visible, because silence lies. */
  malformed: number;
};

const NO_TRADES: readonly Trade[] = [];

export const INITIAL_BOOK_STATE: BookState = {
  book: null,
  mid: null,
  previousMid: null,
  sessionOpen: null,
  sessionHigh: null,
  sessionLow: null,
  trades: NO_TRADES,
  status: "connecting",
  syncing: false,
  lastFrameAt: null,
  gaps: 0,
  malformed: 0,
};

export type BookStore = StoreApi<BookState>;

/** One store per mounted session: a remount starts from a clean market. */
export function createBookStore(): BookStore {
  return createStore<BookState>()(() => ({ ...INITIAL_BOOK_STATE }));
}

export const selectBook = (state: BookState): Snapshot | null => state.book;

/** The book's ordering id, or `null` before the first snapshot. */
export const selectBookSeq = (state: BookState): number | null => state.book?.seq ?? null;

export const selectMid = (state: BookState): number | null => state.mid;

export const selectPreviousMid = (state: BookState): number | null => state.previousMid;

/** Session baseline for the hero strip; `null` before the first mid. */
export const selectSessionOpen = (state: BookState): number | null => state.sessionOpen;

/** Session high; `null` before the first mid. */
export const selectSessionHigh = (state: BookState): number | null => state.sessionHigh;

/** Session low; `null` before the first mid. */
export const selectSessionLow = (state: BookState): number | null => state.sessionLow;
export const selectTrades = (state: BookState): readonly Trade[] => state.trades;

export const selectStatus = (state: BookState): ConnectionStatus => state.status;

export const selectSyncing = (state: BookState): boolean => state.syncing;

export const selectLastFrameAt = (state: BookState): number | null => state.lastFrameAt;

export const selectGaps = (state: BookState): number => state.gaps;

export const selectMalformed = (state: BookState): number => state.malformed;

/** Something has arrived: the book or the tape, whichever the feed delivered. */
export const selectHasData = (state: BookState): boolean =>
  state.book !== null || state.trades.length > 0;

/**
 * The values on screen are cached whenever the socket is not delivering — but a
 * screen with nothing at all is "waiting", not "stale".
 */
export const selectStale = (state: BookState): boolean =>
  state.status !== "live" && selectHasData(state);

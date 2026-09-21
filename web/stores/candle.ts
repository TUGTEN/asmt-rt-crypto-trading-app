/**
 * The chart's live state: the interval it follows, the series it draws, and the
 * history request that fills it.
 *
 * The candles area is fed by two doors — `GET /api/history` (finished buckets,
 * oldest first, loaded when the chart opens or the interval changes) and `candle`
 * frames on the socket (buckets as they close, plus the one still forming). Both
 * land in this store, which is why the series has one home instead of a query
 * cache and a live buffer that can disagree (`docs/DECISION-PRIMER.md` §3).
 *
 * - `interval` — the 1s/1m the chart is following (the WS subscription carries it),
 * - `history` — finished candles for that interval, oldest first, never `null`,
 * - `activeCandle` — the unfinished candle, extended by live frames,
 * - `requestId` — what makes a late response from a superseded request droppable,
 * - `historyEpoch` — a session ended, so the tail of `history` may have holes,
 * - `historyStatus`/`historyError` — what the *history request* last did, which is
 *   the only thing that can distinguish "no candles yet" from "no candles at all".
 *
 * The writers below are plain functions of the store rather than methods on the
 * state: the socket can push a frame in without a rendering layer in its module
 * graph (`lib/ws-client.ts` imports no React), a test can drive every guard by
 * hand, and the state stays a value that reads the same in devtools as in a
 * `toEqual`. React-free like the other two stores.
 */

import { createStore, type StoreApi } from "zustand/vanilla";

import { candleSeconds, upsertCandle } from "@/lib/candles";
import type { Candle, CandleFrame, History, Interval } from "@/lib/protocol";

/**
 * Where the history request stands. A chart with no candles on it has three very
 * different reasons to be empty, and `docs/SEAMS.md` Slice C asks for the empty
 * one to be explicit rather than a frozen or forever-loading chart:
 *
 * - `loading` — nothing on screen yet, a read is in flight,
 * - `refreshing` — candles are on screen and a read is in flight (a reconnect),
 * - `ready` — the read landed: draw what it returned, even if that is nothing,
 * - `error` — the read failed; `historyError` says why.
 */
export type HistoryStatus = "loading" | "refreshing" | "ready" | "error";

export type CandleState = {
  /** The interval the chart is following; the socket subscribes with it. */
  interval: Interval;
  /** Completed candles for `interval`, oldest first. Empty, never `null`. */
  history: readonly Candle[];
  /** The candle being built from live trades, or `null` before the first one. */
  activeCandle: Candle | null;
  /** Bumped per history request: a response under a dead id is dropped. */
  requestId: number;
  /** Bumped when a session ends: the series is re-read, not trusted. */
  historyEpoch: number;
  historyStatus: HistoryStatus;
  historyError: string | null;
};

export const INITIAL_CANDLE_STATE: CandleState = {
  interval: "1s",
  history: [],
  activeCandle: null,
  requestId: 0,
  historyEpoch: 0,
  historyStatus: "loading",
  historyError: null,
};

export type CandleStore = StoreApi<CandleState>;

export function createCandleStore(): CandleStore {
  return createStore<CandleState>()(() => ({ ...INITIAL_CANDLE_STATE }));
}

/*
 * ---------------------------------------------------------------------------
 * Selectors — module-level and stable, so a 4Hz candle frame does not hand
 * React a new subscriber on every render (`lib/hooks/useMarketStores.ts`).
 * ---------------------------------------------------------------------------
 */

export const selectInterval = (state: CandleState): Interval => state.interval;

export const selectHistory = (state: CandleState): readonly Candle[] => state.history;

export const selectActiveCandle = (state: CandleState): Candle | null => state.activeCandle;

export const selectHistoryStatus = (state: CandleState): HistoryStatus => state.historyStatus;

export const selectHistoryError = (state: CandleState): string | null => state.historyError;

/** Changes when the series has to be re-read; the history hook keys on it. */
export const selectHistoryEpoch = (state: CandleState): number => state.historyEpoch;

/** Something to draw — finished or forming. The chart's empty state keys on it. */
export const selectHasCandles = (state: CandleState): boolean =>
  state.history.length > 0 || state.activeCandle !== null;

/*
 * ---------------------------------------------------------------------------
 * Writers
 * ---------------------------------------------------------------------------
 */

/** One candle frame, stripped of the envelope that carried it. */
function toCandle(frame: CandleFrame): Candle {
  return { t: frame.t, o: frame.o, h: frame.h, l: frame.l, c: frame.c, v: frame.v };
}

function before(a: string, b: string): boolean {
  return (candleSeconds(a) ?? 0) < (candleSeconds(b) ?? 0);
}

/**
 * Follow another interval.
 *
 * The old interval's candles go with it: a chart that kept drawing 1s buckets
 * under a `1m` label would be showing a market that does not exist (SEAMS Slice
 * C — "no ghost candles"). The request id moves too, so a response already in
 * flight for the interval we just left cannot land on the new one.
 */
export function switchInterval(store: CandleStore, interval: Interval): void {
  const state = store.getState();
  if (state.interval === interval) {
    return;
  }
  store.setState({
    interval,
    history: [],
    activeCandle: null,
    requestId: state.requestId + 1,
    historyStatus: "loading",
    historyError: null,
  });
}

/**
 * Open a history request for `interval` and return the id its response must
 * carry.
 *
 * Re-reading the interval already on screen *keeps* what is drawn (status
 * `refreshing`): that is the reconnect path, where the candles finished while
 * the socket was down were never delivered, and blanking the chart to heal a
 * hole in its tail would be the worse trade. A request for a different
 * interval starts from an empty series by definition.
 */
export function requestHistory(store: CandleStore, interval: Interval): number {
  const state = store.getState();
  const refresh = state.interval === interval && state.history.length > 0;
  const requestId = state.requestId + 1;
  store.setState({
    interval,
    history: refresh ? state.history : [],
    activeCandle: refresh ? state.activeCandle : null,
    requestId,
    historyStatus: refresh ? "refreshing" : "loading",
    historyError: null,
  });
  return requestId;
}

/**
 * Land a response — if it is still the one the chart is waiting for.
 *
 * Two guards, because they catch different races: `requestId` catches a response
 * that a newer request superseded, and the echoed `interval` catches one whose
 * request was for the interval the chart has since left. Neither alone is
 * enough — an interval switch and a refresh can happen inside one round trip.
 */
export function applyHistory(store: CandleStore, requestId: number, history: History): void {
  const state = store.getState();
  if (requestId !== state.requestId || history.interval !== state.interval) {
    return;
  }

  // Folded through the same upsert the live frames use: a payload that repeats a
  // bucket collapses instead of drawing two candles for it.
  let series: readonly Candle[] = [];
  for (const candle of history.candles) {
    series = upsertCandle(series, candle);
  }

  // A bucket the payload holds is finished, so whatever was forming cannot be
  // forming any more; anything at or below the payload's last bucket is retired.
  const last = series[series.length - 1];
  const active = state.activeCandle;
  const stillForming = last === undefined || (active !== null && before(last.t, active.t));

  store.setState({
    history: series,
    activeCandle: stillForming ? active : null,
    historyStatus: "ready",
    historyError: null,
  });
}

/**
 * The request failed. Kept on screen whatever it failed for: a refresh that
 * could not be read is not a reason to erase the candles the chart already has.
 */
export function failHistory(store: CandleStore, requestId: number, message: string): void {
  if (requestId !== store.getState().requestId) {
    return;
  }
  store.setState({ historyStatus: "error", historyError: message });
}

/**
 * A `candle` frame arrived.
 *
 * The feed computes every OHLCV; this only decides where the candle belongs.
 * Frames for another interval are dropped (the subscription changed, the frame
 * was already in flight), a finished bucket replaces the forming one and closes
 * it, and a forming bucket older than the one on screen is ignored rather than
 * walking the chart backwards.
 */
export function applyCandleFrame(store: CandleStore, frame: CandleFrame): void {
  const state = store.getState();
  if (frame.interval !== state.interval) {
    return;
  }
  const candle = toCandle(frame);

  if (frame.complete) {
    const history = upsertCandle(state.history, candle);
    const activeCandle = state.activeCandle?.t === candle.t ? null : state.activeCandle;
    if (history === state.history && activeCandle === state.activeCandle) {
      // A repeat: this bucket is already on screen with these values.
      return;
    }
    store.setState({ history, activeCandle });
    return;
  }

  if (state.history.some((entry) => entry.t === candle.t)) {
    // A completed bucket cannot reopen; a frame this late is a duplicate.
    return;
  }
  const active = state.activeCandle;
  if (active !== null && before(candle.t, active.t)) {
    return;
  }
  store.setState({ activeCandle: candle });
}

/**
 * The session that fed this series ended — a reconnect is a new stream, and the
 * buckets that finished while the socket was down were never delivered.
 *
 * Nothing is thrown away here: the candles stay on screen and `historyEpoch`
 * moves, which is the signal `lib/hooks/useCandleHistory.ts` re-reads the
 * series on. Who re-reads it, and when, is the history request's business.
 */
export function invalidateHistory(store: CandleStore): void {
  const state = store.getState();
  store.setState({ historyEpoch: state.historyEpoch + 1 });
}

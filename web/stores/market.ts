/**
 * The live state, as one bundle of focused stores.
 *
 * Live state is split three ways on purpose (`docs/DECISION-PRIMER.md` §3):
 * `book` changes at frame rate, `conn` per pong and per tier change, `candle`
 * when the chart's frames arrive. One store per slice is what lets a panel select the
 * slice it renders and re-render on nothing else — a single market object would
 * re-render the connection panel at 4Hz.
 *
 * Created per mounted session rather than as a module singleton: the socket and
 * the state it fills share a lifetime, so a remount is a clean start instead of
 * a screen inheriting a dead session's numbers. `lib/ws-client.ts` takes this
 * bundle by injection, which is also how `lib/ws-client.test.ts` scripts it.
 */

import { createBookStore, type BookStore } from "@/stores/book";
import { createCandleStore, type CandleStore } from "@/stores/candle";
import { createConnStore, type ConnStore } from "@/stores/conn";

export type MarketStores = {
  book: BookStore;
  conn: ConnStore;
  /** The chart's series: interval, history, forming candle, request id. */
  candle: CandleStore;
};

export function createMarketStores(): MarketStores {
  return {
    book: createBookStore(),
    conn: createConnStore(),
    candle: createCandleStore(),
  };
}

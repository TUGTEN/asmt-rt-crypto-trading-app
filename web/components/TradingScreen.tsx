"use client";

/**
 * The client island: it owns the data sources (the market socket + backend
 * config) and hands plain values to presentational components. No `fetch` and
 * no `WebSocket` happens here — the network lives in `lib/ws-client.ts` and
 * `lib/candle-history.ts`, the live state in `stores/`, and the hooks in
 * `lib/hooks/`.
 *
 * Each pane below subscribes to the slices it renders and hands them down as
 * props. That is what keeps a pong from re-rendering the book, a book frame from
 * re-rendering the tape, and the 1s clock from re-rendering anything but the age
 * label it exists for: the panels stay presentational (props in, JSX out) and the
 * subscriptions sit with the panel they feed instead of at the top of the screen,
 * where one book frame re-rendered everything.
 *
 * The connection pane is the one that reads both stores, and it is allowed to
 * re-render on every frame: the age of the last frame is a number it renders.
 * The chart pane is the other: the forming candle changes several times a second,
 * and its series has to keep up without a canvas rebuild.
 */

import { useEffect, useMemo, useState } from "react";

import { BackendPanel } from "@/components/BackendPanel";
import { CandleChart } from "@/components/CandleChart";
import { ConnectionStatusPanel } from "@/components/ConnectionStatusPanel";
import { DebugPanel } from "@/components/DebugPanel";
import { OrderBookPanel } from "@/components/OrderBookPanel";
import { ParkedChartPanel } from "@/components/WatchlistPanel";
import { WatchlistTape } from "@/components/WatchlistTape";
import { RecentTrades } from "@/components/RecentTrades";
import { TierBadge } from "@/components/TierBadge";
import { BOOK_DEPTH } from "@/lib/config";
import { useBackendConfig } from "@/lib/hooks/useBackendConfig";
import { useBackendUrl } from "@/lib/hooks/useBackendUrl";
import { useCandleHistory } from "@/lib/hooks/useCandleHistory";
import { useBookStore, useCandleStore, useConnStore } from "@/lib/hooks/useMarketStores";
import { useMarketStream } from "@/lib/hooks/useMarketStream";
import { useNow } from "@/lib/hooks/useNow";
import { useWatchlist } from "@/lib/hooks/useWatchlist";
import { selectableIntervals, type Interval } from "@/lib/protocol";
import { LIVE_SYMBOL } from "@/lib/watchlist";
import {
  selectBook,
  selectBookSeq,
  selectGaps,
  selectLastFrameAt,
  selectMalformed,
  selectMid,
  selectPreviousMid,
  selectSessionHigh,
  selectSessionLow,
  selectSessionOpen,
  selectStale,
  selectStatus,
  selectSyncing,
  selectTrades,
} from "@/stores/book";
import { selectLatencyMs, selectOverride, selectTier } from "@/stores/conn";
import {
  selectActiveCandle,
  selectHistory,
  selectHistoryError,
  selectHistoryStatus,
  selectInterval,
  switchInterval,
} from "@/stores/candle";
import type { MarketStores } from "@/stores/market";


/** The top tape: the watchlist as a horizontal strip, highest in the hierarchy. */
function TapeStripPane({
  stores,
  order,
  selected,
  onSelect,
  onReorder,
}: {
  stores: MarketStores;
  order: readonly string[];
  selected: string;
  onSelect: (symbol: string) => void;
  onReorder: (from: number, to: number) => void;
}) {
  const mid = useBookStore(stores.book, selectMid);

  return (
    <WatchlistTape
      order={order}
      selected={selected}
      livePrice={mid === null ? null : mid.toFixed(2)}
      onSelect={onSelect}
      onReorder={onReorder}
    />
  );
}

/** The book image and the two labels about it: frozen while syncing, cached when stale. */
function BookPane({ stores }: { stores: MarketStores }) {
  const snapshot = useBookStore(stores.book, selectBook);
  const syncing = useBookStore(stores.book, selectSyncing);
  const stale = useBookStore(stores.book, selectStale);

  return <OrderBookPanel snapshot={snapshot} depth={BOOK_DEPTH} stale={stale} syncing={syncing} />;
}

function TapePane({ stores, expanded, onToggle }: { stores: MarketStores; expanded: boolean; onToggle: () => void }) {
  const trades = useBookStore(stores.book, selectTrades);
  const stale = useBookStore(stores.book, selectStale);

  return <RecentTrades trades={trades} stale={stale} expanded={expanded} onToggle={onToggle} />;
}

/**
 * The watchlist bonus: one live row plus static reference rows. The pane
 * subscribes to the book's mid for the BTC-USD row; every other row is a
 * fixed reference price from `lib/watchlist.ts`, never streamed. Order and
 * selection live in `useWatchlist` (persisted across visits); selecting a
 * temp row parks the chart area below, selecting BTC-USD unparks it.
 */

/**
 * The one pane that reads the second store: its whole job is the tier and the
 * round trips, which change on their own cadence. The clock lives here too —
 * it exists to recompute one age label, so it re-renders this pane and nothing
 * else once a second.
 */
function ConnectionPane({
  stores,
  marketUrl,
  chartUrl,
  configError,
}: {
  stores: MarketStores;
  marketUrl: string;
  chartUrl: string;
  configError: string | null;
}) {
  const now = useNow();
  const status = useBookStore(stores.book, selectStatus);
  const lastFrameAt = useBookStore(stores.book, selectLastFrameAt);
  const syncing = useBookStore(stores.book, selectSyncing);
  const bookSeq = useBookStore(stores.book, selectBookSeq);
  const gaps = useBookStore(stores.book, selectGaps);
  const malformed = useBookStore(stores.book, selectMalformed);
  const latencyMs = useConnStore(stores.conn, selectLatencyMs);

  return (
    <ConnectionStatusPanel
      status={status}
      marketUrl={marketUrl}
      chartUrl={chartUrl}
      lastFrameAt={lastFrameAt}
      now={now}
      syncing={syncing}
      bookSeq={bookSeq}
      latencyMs={latencyMs}
      gaps={gaps}
      malformed={malformed}
      configError={configError}
    />
  );
}

/**
 * The delivery readout: the badge IS the panel now — no heading, no chrome,
 * just what the connection is being served at (SPEC story 11). The DEBUG
 * override (stories 12–13) lives in the lower debug stack beside the backend
 * chooser, so this row stays watchlist + badge at equal heights whether
 * debug is open or not.
 */
function DeliveryPane({ stores }: { stores: MarketStores }) {
  return (
    <section
      aria-label="Delivery status"
      className="flex h-full min-h-0 flex-col justify-center rounded-lg border border-line bg-panel px-4 py-3"
    >
      <TierBadge store={stores.conn} />
    </section>
  );
}

/**
 * The chart pane: the one place the candles' store is read.
 *
 * It reads the slices the chart needs and hands them down as values, and it
 * starts the history read for whatever interval is open. Switching is a store
 * call rather than component state: the store owns dropping the old series and
 * moving the request id, and the new interval is what resubscribes the socket
 * (`lib/hooks/useMarketStream.ts`).
 */
function ChartPane({
  stores,
  intervals,
  backendUrl,
  symbol,
  theme,
}: {
  stores: MarketStores;
  intervals: Interval[];
  backendUrl: string;
  symbol: string | null;
  /** The color theme: the chart rebuilds its colors when it changes. */
  theme: "light" | "dark";
}) {
  const mid = useBookStore(stores.book, selectMid);
  const previousMid = useBookStore(stores.book, selectPreviousMid);
  const sessionOpen = useBookStore(stores.book, selectSessionOpen);
  const sessionHigh = useBookStore(stores.book, selectSessionHigh);
  const sessionLow = useBookStore(stores.book, selectSessionLow);
  const session = { open: sessionOpen, high: sessionHigh, low: sessionLow };
  const stale = useBookStore(stores.book, selectStale);
  const syncing = useBookStore(stores.book, selectSyncing);
  const interval = useCandleStore(stores.candle, selectInterval);
  const history = useCandleStore(stores.candle, selectHistory);
  const activeCandle = useCandleStore(stores.candle, selectActiveCandle);
  const status = useCandleStore(stores.candle, selectHistoryStatus);
  const error = useCandleStore(stores.candle, selectHistoryError);

  useCandleHistory(stores.candle, backendUrl);

  // The backend owns the interval list (`GET /api/config`): if the interval the
  // chart opened on is not one it serves, follow the first that it does rather
  // than subscribe to a stream nobody will send.
  useEffect(() => {
    if (intervals.length > 0 && !intervals.includes(interval)) {
      switchInterval(stores.candle, intervals[0]);
    }
  }, [intervals, interval, stores.candle]);

  return (
    <CandleChart
      theme={theme}
      interval={interval}
      intervals={intervals}
      onIntervalChange={(next) => switchInterval(stores.candle, next)}
      history={history}
      activeCandle={activeCandle}
      status={status}
      error={error}
      symbol={symbol}
      mid={mid}
      previousMid={previousMid}
      session={session}
      stale={stale}
      syncing={syncing}
    />
  );
}

export function TradingScreen({ debugVisible, theme }: { debugVisible: boolean; /** The color theme, drilled to the chart. */ theme: "light" | "dark" }) {
  const { backendUrl, defaultUrl, setBackendUrl, resetBackendUrl } = useBackendUrl();
  const { stores, marketUrl, chartUrl, forceTier } = useMarketStream(backendUrl);
  const { config, error: configError } = useBackendConfig(backendUrl);
  const { order, selected, select, reorder } = useWatchlist();
  const [showTrades, setShowTrades] = useState(true);
  // Tier override state lives at screen level: the control moved to the lower
  // debug stack, so the top row stays watchlist + badge at equal heights.
  const tier = useConnStore(stores.conn, selectTier);
  const override = useConnStore(stores.conn, selectOverride);

  // The intervals the backend advertises, restricted to the ones this client
  // understands. Memoised on the config, so the reconciliation above is not a
  // fresh array on every render.
  const intervals = useMemo(() => selectableIntervals(config), [config]);

  // The watchlist bonus: a temp row parks only the chart area — book, tape,
  // and ticker keep streaming BTC-USD — and unmounts its history read, so
  // returning to BTC-USD reloads the series fresh.
  const chartLive = selected === LIVE_SYMBOL;
  return (
    <main className="mx-auto flex w-full max-w-[1440px] flex-col gap-4 px-4 py-4 lg:px-8">
      {/*
       * Locked layout: two 12-col grids. Top row pairs the watchlist strip
       * (left, 8 at lg / 9 at xl) with the delivery badge (right, 4 at lg /
       * 3 at xl) at equal heights, so the row reads as one clean band.
       * Lower grid: chart + trades left, debug stack + book right. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-8 xl:col-span-9">
          <TapeStripPane
            stores={stores}
            order={order}
            selected={selected}
            onSelect={select}
            onReorder={reorder}
          />
        </div>
        <div className="flex min-w-0 flex-col lg:col-span-4 xl:col-span-3">
          <DeliveryPane stores={stores} />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-8 xl:col-span-9">
          {chartLive ? (
            <section
              aria-label="Chart"
              className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-panel p-4"
            >
              <ChartPane
                stores={stores}
                intervals={intervals}
                backendUrl={backendUrl}
                symbol={config?.symbol ?? null}
                theme={theme}
              />
            </section>
          ) : (
            <ParkedChartPanel symbol={selected} onBack={() => select(LIVE_SYMBOL)} />
          )}

          {/* Stretch the tape so its bottom edge aligns with the book's across columns. */}
          <section aria-label="Trade history" className="flex min-w-0 flex-1 flex-col">
            <TapePane stores={stores} expanded={showTrades} onToggle={() => setShowTrades((open) => !open)} />
          </section>
        </div>

        <div className="flex min-w-0 flex-col lg:col-span-4 xl:col-span-3">
          <div
            className={`debug-stack${debugVisible ? " open" : ""}`}
            aria-hidden={!debugVisible}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="flex min-w-0 flex-col gap-4 pb-4 [overflow-anchor:none]">
                <DebugPanel
                  tier={tier}
                  override={override}
                  onForce={(next) => forceTier(next)}
                  onClear={() => forceTier(null)}
                />
                <BackendPanel
                  backendUrl={backendUrl}
                  defaultUrl={defaultUrl}
                  onSelect={setBackendUrl}
                  onReset={resetBackendUrl}
                />
                <ConnectionPane
                  stores={stores}
                  marketUrl={marketUrl}
                  chartUrl={chartUrl}
                  configError={configError}
                />
              </div>
            </div>
          </div>
          <BookPane stores={stores} />
        </div>
      </div>
    </main>
  );
}

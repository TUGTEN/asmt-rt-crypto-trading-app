"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { API_BASE_URL, CHART_TOPICS, DEFAULT_INTERVAL, MARKET_TOPICS } from "@/lib/config";
import { useCandleStore } from "@/lib/hooks/useMarketStores";
import type { Tier } from "@/lib/protocol";
import { buildWsUrl, fetchSnapshot } from "@/lib/protocol";
import { documentVisibility, followVisibility } from "@/lib/visibility";
import { WsClient } from "@/lib/ws-client";
import { selectInterval } from "@/stores/candle";
import { setOverride } from "@/stores/conn";
import { createMarketStores, type MarketStores } from "@/stores/market";

export type MarketStream = {
  /** The per-mount live state; components select from it, never copy it. */
  stores: MarketStores;
  /** The URL the market socket dialed: book + trades, stable across interval switches. */
  marketUrl: string;
  /** The URL the chart socket dialed: candles for the interval now on screen. */
  chartUrl: string;
  /**
   * The debug control's wire write (T4): force `tier`, or `null` to clear the
   * override and let the backend's own decision stand again.
   */
  forceTier: (tier: Tier | null) => void;
};

/**
 * The screen's two data sources: one market socket and one chart socket, selecting from the stores.
 *
 * This is the thin React edge of the live slice. `lib/ws-client.ts` owns each
 * session (dial, buffer, gap recovery, ping, reconnect, the debug override) and
 * pushes into the Zustand stores; this hook creates one store set and two
 * sessions per mount, so unmounting closes both sockets, leaves no timer
 * behind, and leaves no state for the next mount to inherit.
 *
 * Three lifetimes are bound here, and all are the component's to dispose:
 *
 * - **The market session.** Dialed once per mount for book + trades. Its URL
 *   never mentions the chart interval, so switching 1s↔1m neither redials it
 *   nor freezes, clears, or relabels the book and the tape. Both URLs carry
 *   the chooser's backend, so switching hosts redials both sessions.
 * - **The chart session.** Dialed per interval for candles. The URL carries
 *   the interval on screen, so a switch tears this session down and dials the
 *   new one — and only the chart reloads behind it.
 * - **The tab's visibility.** `lib/visibility.ts` ends each session while the
 *   tab is hidden and dials a fresh one when it is visible again — a hidden tab
 *   is not live (`CONTEXT.md`), and this client's way of saying so is to have
 *   no stream running rather than a running stream labelled "cached".
 *
 * It deliberately returns the stores rather than the state: a panel subscribes
 * to its own slices with the selector hooks in
 * `lib/hooks/useMarketStores.ts`, so a 4Hz book frame is not a re-render of
 * the whole screen.
 */
export function useMarketStream(backendUrl: string = API_BASE_URL): MarketStream {
  // One set of stores per mount: lazy `useState` keeps its identity stable
  // across renders without touching a ref during render.
  const [stores] = useState(createMarketStores);
  const interval = useCandleStore(stores.candle, selectInterval);

  // The market subscription carries no chart interval (the backend still
  // requires a valid one on every /ws upgrade, so the default stands in
  // rather than the param being omitted) — but it does carry the chooser's
  // backend, so switching hosts redials it alongside the chart session.
  const marketUrl = useMemo(
    () => buildWsUrl(backendUrl, { topics: [...MARKET_TOPICS], interval: DEFAULT_INTERVAL }),
    [backendUrl],
  );
  // The interval on screen: what makes a switch redial the chart — and only
  // the chart — with the new `interval` query param.
  const chartUrl = useMemo(
    () => buildWsUrl(backendUrl, { topics: [...CHART_TOPICS], interval }),
    [backendUrl, interval],
  );

  // The live sessions, held in refs: click handlers need to reach them, but
  // nothing renders from them — the stores are what the screen reads, and refs
  // keep the clients out of the render path and out of the dependency lists.
  const market = useRef<WsClient | null>(null);
  const chart = useRef<WsClient | null>(null);


  // Recovery snapshots come from the chooser's backend, not the build default:
  // memoised so its identity only moves when the host does (an inline arrow
  // would redial on every render through the effect below).
  const fetchMarketSnapshot = useMemo(
    () => (signal: AbortSignal) => fetchSnapshot(signal, backendUrl),
    [backendUrl],
  );
  useEffect(() => {
    const session = new WsClient({ url: marketUrl, stores, snapshot: fetchMarketSnapshot, manageConn: false, feedsChart: false });
    market.current = session;
    // Visible: dial. Hidden: stay down, and dial a new session when the tab
    // comes back. Unmount: both the listener and the session go away.
    const lifecycle = followVisibility(documentVisibility(), session);
    return () => {
      lifecycle.dispose();
      if (market.current === session) {
        market.current = null;
      }
    };
  }, [stores, marketUrl, fetchMarketSnapshot]);

  useEffect(() => {
    const session = new WsClient({ url: chartUrl, stores, manageBook: false });
    chart.current = session;
    // Same lifecycle as the market session, keyed on the chart URL instead:
    // an interval switch ends this session and dials the next one.
    const lifecycle = followVisibility(documentVisibility(), session);
    return () => {
      lifecycle.dispose();
      if (chart.current === session) {
        chart.current = null;
      }
    };
  }, [stores, chartUrl]);

  const forceTier = useCallback(
    (tier: Tier | null) => {
      // The chart session owns telemetry: its backend tier is the one that
      // throttles delivery, so the override is written to that session.
      const session = chart.current;
      if (session === null) {
        // No session to write to (only reachable before the effect has run):
        // record the selection, which is what `WsClient.stop()`/`start()` assert
        // when a session does open.
        setOverride(stores.conn, tier);
        return;
      }
      session.forceTier(tier);
    },
    [stores],
  );

  return { stores, marketUrl, chartUrl, forceTier };
}

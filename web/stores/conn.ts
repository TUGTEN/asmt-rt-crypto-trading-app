/**
 * What the connection is entitled to and what it measured.
 *
 * The backend owns the tier (`CONTEXT.md`): `tier`/`tierRate` are the last
 * `tier` frame verbatim, and the client only ever reports what it measured.
 * `rttMs`/`latencyMs`/`jitterMs` are those measurements — `RTT = tRecv − tSend`,
 * `latency = RTT/2`, `jitter = EMA(|RTT − prev|)` (`docs/PROTOCOL.md`) — and are
 * written once per pong, so this store changes on a 2s cadence while the book
 * changes at frame rate. Separate stores are what keep that off the book's
 * subscribers.
 *
 * `override` is the debug control's selection, kept *beside* the backend's
 * answer rather than in place of it: `lib/ws-client.ts` asserts it as a `force`
 * frame and the backend answers with the ordinary `tier` frame above, so which
 * tier is actually delivered stays the backend's decision and `lib/tier-readout.ts`
 * is what says whether the override is in force yet.
 *
 * React-free for the same reason as `stores/book.ts`.
 */

import { createStore, type StoreApi } from "zustand/vanilla";

import type { Tier } from "@/lib/protocol";

export type ConnState = {
  /** The backend's decision, rendered as it arrives: never computed here. */
  tier: Tier | null;
  /** Chart frames per second the current tier delivers (`tier` frame's `rate`). */
  tierRate: number | null;
  rttMs: number | null;
  latencyMs: number | null;
  jitterMs: number | null;
  /** Debug override set by hand; `null` = the backend's tier stands (T4). */
  override: Tier | null;
};

export const INITIAL_CONN_STATE: ConnState = {
  tier: null,
  tierRate: null,
  rttMs: null,
  latencyMs: null,
  jitterMs: null,
  override: null,
};

export type ConnStore = StoreApi<ConnState>;

export function createConnStore(): ConnStore {
  return createStore<ConnState>()(() => ({ ...INITIAL_CONN_STATE }));
}

export const selectTier = (state: ConnState): Tier | null => state.tier;

export const selectTierRate = (state: ConnState): number | null => state.tierRate;

export const selectLatencyMs = (state: ConnState): number | null => state.latencyMs;

export const selectJitterMs = (state: ConnState): number | null => state.jitterMs;

/** The client's own round trip, shown beside the latency it reports. */
export const selectRttMs = (state: ConnState): number | null => state.rttMs;

/**
 * The debug control's standing selection (T4): the tier the user asked for,
 * or `null` while the backend's own decision stands. `lib/tier-readout.ts` turns
 * this and the announced tier into the badge's wording; this selector stays a
 * plain field read so a panel can subscribe to it and nothing else.
 */
export const selectOverride = (state: ConnState): Tier | null => state.override;

/**
 * Record the debug control's selection: the tier the user asked for, or
 * `null` while the backend's own decision stands.
 *
 * The one writer for `override`. `WsClient.forceTier` records the intent here
 * and sends the frame; the pre-effect branch of `useMarketStream`'s `forceTier`
 * records it here when no session exists yet to send through — both go through
 * this function so the intent can never be written two different ways.
 */
export function setOverride(store: ConnStore, override: Tier | null): void {
  store.setState({ override });
}

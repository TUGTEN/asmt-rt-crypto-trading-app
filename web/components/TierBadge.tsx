"use client";

/**
 * The delivery badge (SPEC story 11): what the backend is giving this
 * connection, and what the connection measured coming back.
 *
 * `docs/SEAMS.md` Slice A ends at "rendered active candle + tier badge", and
 * this is that badge. It is the one place the tier is allowed to be *computed*
 * into words — and `lib/tier-readout.ts` does that mapping as a pure function,
 * so what it says is pinned by tests rather than by this file's JSX.
 *
 * It subscribes to the connection store through selectors, one field at a time,
 * for the same reason `stores/conn.ts` exists separately from `stores/book.ts`:
 * the round trips land once per pong and the tier changes when the backend
 * announces one, so a book frame at 4Hz must not repaint this (and a tier change
 * must not repaint the book). Everything it renders is a value the backend sent
 * or the client measured — `tier`/`tierRate` are the last `tier` frame verbatim,
 * `RTT = tRecv − tSend`, `latency = RTT/2`, `jitter = EMA(|RTT − prev|)` — so no
 * number here is this component's own arithmetic.
 */

import { formatMs } from "@/lib/format";
import { useConnStore } from "@/lib/hooks/useMarketStores";
import { tierReadout, type TierSource } from "@/lib/tier-readout";
import {
  selectJitterMs,
  selectLatencyMs,
  selectOverride,
  selectRttMs,
  selectTier,
  selectTierRate,
  type ConnStore,
} from "@/stores/conn";

/** Tier tone: the slower the delivery, the more it reads as a warning. */
const TIER_TONE: Record<string, string> = {
  full: "border-live/60 text-live",
  degraded: "border-stale/60 text-stale",
  minimal: "border-ask/60 text-ask",
  "—": "border-line/70 text-faint",
};

const SOURCE_TONE: Record<TierSource, string> = {
  waiting: "text-faint",
  automatic: "text-muted",
  forced: "text-stale",
  pending: "text-stale",
};

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={`flex items-baseline gap-1.5${className ? ` ${className}` : ""}`}>
      <dt className="font-ui text-[10px] uppercase tracking-[0.14em] text-faint font-medium">{label}</dt>
      <dd className="font-mono text-[11px] text-ink-dim font-medium">{value}</dd>
    </div>
  );
}

export function TierBadge({ store }: { store: ConnStore }) {
  const tier = useConnStore(store, selectTier);
  const tierRate = useConnStore(store, selectTierRate);
  const override = useConnStore(store, selectOverride);
  const rttMs = useConnStore(store, selectRttMs);
  const latencyMs = useConnStore(store, selectLatencyMs);
  const jitterMs = useConnStore(store, selectJitterMs);

  // Derived, never stored: the readout is a function of the fields above, so a
  // single field change is enough to repaint it and nothing has to be kept in
  // sync by hand.
  const readout = tierReadout({ tier, tierRate, override });

  return (
    <div className="flex flex-col gap-3">
      {/* Two text lines fit always, so wrap states never move the dl below. */}
      <div className="flex min-h-[40px] flex-wrap content-start items-center gap-x-3 gap-y-2">
        {/* Fits `degraded`, the longest label — rate text never shifts horizontally. */}
        <span
          className={`min-w-[5.5rem] rounded border px-2 py-0.5 text-center font-ui text-[11px] uppercase tracking-[0.12em] font-semibold ${
            TIER_TONE[readout.tierLabel] ?? TIER_TONE["—"]
          }`}
        >
          {readout.tierLabel}
        </span>
        {/* Fits `0.25/s`, the longest rate — tabular figures keep shorter rates stable inside it. */}
        <span className="min-w-[3.5rem] font-mono text-[13px] text-ink">{readout.rateLabel}</span>
        <span className="font-ui text-[10px] uppercase tracking-[0.14em] text-faint">chart rate</span>
        <span className={`ml-auto font-ui text-[11px] ${SOURCE_TONE[readout.source]}`}>
          {readout.sourceLabel}
        </span>
      </div>
      <dl className="flex flex-wrap justify-between gap-x-5 gap-y-1 border-t border-line pt-2">
        <Stat label="rtt" value={formatMs(rttMs)} />
        <Stat label="latency" value={formatMs(latencyMs)} />
        <Stat label="jitter" value={formatMs(jitterMs)} />
      </dl>
    </div>
  );
}

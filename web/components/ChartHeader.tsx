"use client";

import { IntervalToggle } from "@/components/IntervalToggle";
import { formatPrice, formatQty, formatSigned, formatStamp, movement, percentChange } from "@/lib/format";
import { candleSeconds } from "@/lib/candles";
import type { SessionStats } from "@/lib/format";
import type { Candle, Interval } from "@/lib/protocol";

/**
 * The chart card's header, after the reference: asset name plus session-move
 * pill over the price in a left-aligned stack, an always-visible current
 * O/H/L/C/V row
 * in the middle (bottom-justified at rest inside a fixed h-14 stack tall
 * enough for labels + current + hover rows), a glowing status chip left and
 * the IntervalToggle right (`justify-between`) on the right's first row —
 * the chip's left edge meets the timestamp below it, the toggle hugs the
 * container's right edge, and neither moves when the word flips.
 *
 * Two rules keep it still. First, every price cell is fixed to two decimals
 * (zero-padded, textually — no float ever formats a price) plus the move pill
 * is fixed-width with a zero-padded rest state (`00.00%`), all set in
 * tabular figures, so a tick cannot change any cell's width. Second, hover
 * never moves the canvas: the middle column is a fixed h-14 flex-col
 * justify-end stack, so at rest the current row sits at the bottom (near the
 * big-price baseline) and on hover/pin it slides up as the hover slot below
 * it expands from h-0 to h-5 (overflow-hidden, ~200ms height/translate
 * transition) — internal motion only inside the fixed min-h-[76px] header.
 * The timestamp line always shows a stamp (the active bucket's at rest,
 * the hovered bucket's on hover) on ~the current row's line. A pinned readout
 * is marked by the chart's dotted line at its bucket plus the stamp's
 * bg-live/15 highlight — the stamp keeps unconditional px-1 in the live tone
 * (pinning toggles background only), no badge, no suffix, so pinning never
 * moves the header's text a pixel.
 * Presentational like the other panels: values in, JSX out.
 */

const COLS = ["O", "H", "L", "C", "V"] as const;

/** `formatPrice` plus a zero-padded second decimal: `"70,977.7"` -> `"70,977.70"`. */
function fixedPrice(value: string): string {
  const rendered = formatPrice(value);
  if (rendered === "—") {
    return rendered;
  }
  const dot = rendered.indexOf(".");
  if (dot === -1) {
    return `${rendered}.00`;
  }
  if (rendered.length - dot - 1 === 1) {
    return `${rendered}0`;
  }
  return rendered;
}

function Row({ values, dimmed }: {
  values: readonly [string, string, string, string, string];
  dimmed?: boolean;
}) {
  // min-w-0 lets truncate actually constrain the grid items: the V cell
  // renders the forming bucket's volume (trailing zeros trimmed), whose
  // length changes ~4x/sec — without min-w-0 the 1fr tracks breathe.
  return (
    <div className="grid grid-cols-5 gap-x-2">
      {values.map((value, index) => (
        <span
          key={COLS[index]}
          className={`truncate min-w-0 font-mono text-[13px] font-medium leading-5 tabular-nums ${
            dimmed === true ? "text-muted" : "text-ink-dim"
          }`}
        >
          {value}
        </span>
      ))}
    </div>
  );
}

export function ChartHeader({
  symbol,
  mid,
  previousMid,
  session,
  stale,
  active,
  hovered,
  pinned,
  syncing,
  historyError,
  interval,
  intervals,
  onIntervalChange,
}: {
  /** The market symbol, rendered uppercase as-traded (`BTC-USD`). */
  symbol: string | null;
  /** The live mid, or null before the first frame. */
  mid: number | null;
  /** The previous mid, for the tick direction. */
  previousMid: number | null;
  /** Mount-lifetime extremes — the fallback while no candle has formed. */
  session: SessionStats;
  /** The socket is down: these numbers are cached, not live. */
  stale: boolean;
  /** The forming bucket — the always-visible current O/H/L/C/V. */
  active: Candle | null;
  /** The hovered bucket, already resolved to null when it is the active one. */
  hovered: Candle | null;
  /** A click pinned the readout: the stamp highlights and the chart marks its bucket. */
  pinned: boolean;
  /** The interval the chart is following; the store owns the switch. */
  interval: Interval;
  /** Every interval the backend offers, for the toggle. */
  intervals: Interval[];
  /** Called with the clicked interval. */
  onIntervalChange: (interval: Interval) => void;
  /** A snapshot refetch is in flight: the header's numbers are frozen. */
  syncing: boolean;
  /** The history read failed: the chart shows live buckets over no history. */
  historyError: string | null;
}) {
  const tick = movement(previousMid, mid);
  const changePercent = percentChange(session.open, mid);
  const up = (changePercent ?? 0) >= 0;
  // Content-sized pill, zero-padded at rest (`00.00%`): nothing follows it, so
  // a magnitude crossing cannot shift any sibling.
  const pillText =
    changePercent === null
      ? ""
      : Number(changePercent.toFixed(2)) === 0
        ? "00.00%"
        : `${formatSigned(changePercent)}%`;
  const num = (value: number | null): string =>
    value === null
      ? "—"
      : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const name = symbol === null ? "—" : symbol.toUpperCase();
  // Feed-status chip: live only when nothing is wrong; the word names the fault.
  const live = !stale && !syncing && historyError === null;
  const faulted = !live;
  const word = stale ? "cached" : syncing ? "syncing" : historyError !== null ? "history error" : "live";

  const current: readonly [string, string, string, string, string] =
    active === null
      ? [num(session.open), num(session.high), num(session.low), num(mid), "—"]
      : [
          fixedPrice(active.o),
          fixedPrice(active.h),
          fixedPrice(active.l),
          fixedPrice(active.c),
          formatQty(active.v),
        ];
  const hovering = hovered !== null;
  const hoveredValues: readonly [string, string, string, string, string] =
    hovered === null
      ? ["—", "—", "—", "—", "—"]
      : [
          fixedPrice(hovered.o),
          fixedPrice(hovered.h),
          fixedPrice(hovered.l),
          fixedPrice(hovered.c),
          formatQty(hovered.v),
        ];
  const hoveredMs = hovered !== null ? (candleSeconds(hovered.t) ?? 0) * 1000 : null;
  const activeMs = active !== null ? (candleSeconds(active.t) ?? 0) * 1000 : null;
  const stamp =
    hoveredMs !== null
      ? formatStamp(hoveredMs)
      : activeMs !== null
        ? formatStamp(activeMs)
        : "—";
  // The wire's UTC ISO behind the local stamp, for the hover tooltip. The
  // stamp itself stays local: one clock on screen, the wall clock.
  const stampWireIso =
    hoveredMs !== null
      ? new Date(hoveredMs).toISOString()
      : activeMs !== null
        ? new Date(activeMs).toISOString()
        : null;

  return (
    <div
      className={`flex min-h-[76px] min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-3 transition-opacity ${
        stale ? "opacity-60" : ""
      }`}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-ui text-[13px] font-semibold tracking-[0.08em] text-ink">
            {name}
          </span>
          {changePercent === null ? null : (
            // Content-sized: the pill hugs the text; nothing follows it, so
            // magnitude crossings shift no sibling.
            <span
              className={`inline-block rounded-full px-2.5 py-0.5 text-center font-mono text-[12px] font-medium tabular-nums ${
                up ? "bg-bid/15 text-bid" : "bg-ask/15 text-ask"
              }`}
            >
              {pillText}
            </span>
          )}
          {/* Feed status lives beside the toggle in the right column's first row — that single location keeps a stale flicker from shifting the OHLCV rows. */}
        </div>
        <div
          className={`mt-1 font-mono text-[22px] font-semibold leading-none tabular-nums ${
            tick === "up" ? "text-bid" : tick === "down" ? "text-ask" : "text-ink"
          }`}
        >
          {mid === null ? "—" : num(mid)}
        </div>
      </div>

      <div className="flex h-14 min-w-0 flex-1 basis-56 flex-col justify-end">
        <div className="grid grid-cols-5 gap-x-2">
          {COLS.map((col) => (
            <span
              key={col}
              className="font-ui text-[11px] font-medium leading-4 tracking-[0.08em] text-muted"
            >
              {col}
            </span>
          ))}
        </div>
        {/*
         * Idle bottom-justify + slide-up: the fixed h-14 stack holds
         * labels + current + hover rows. At rest the hover slot collapses to
         * h-0 so the current row sits at the bottom (near the big-price
         * baseline); on hover/pin it expands to h-5 and the current row
         * rides up. Internal motion only — the outer min-h-[76px] never
         * changes, so the canvas below cannot budge.
         */}
        <Row values={current} />
        <div
          aria-live="polite"
          aria-atomic="true"
          className={`overflow-hidden transition-all motion-safe:duration-200 motion-reduce:transition-none ${
            hovering ? "h-5" : "h-0"
          }`}
        >
          <div
            aria-hidden={!hovering}
            className={`transition-all motion-safe:duration-200 motion-reduce:transition-none ${
              hovering ? "translate-y-0 opacity-100" : "translate-y-[4px] opacity-0"
            }`}
          >
            <Row values={hoveredValues} dimmed />
          </div>
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-start justify-center gap-1.5">
        <div className="flex w-full items-center justify-between gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-ui text-[11px] font-medium leading-4 whitespace-nowrap ${
              faulted
                ? "border-stale/30 bg-stale/15 text-stale"
                : "border-live/30 bg-live/15 text-live"
            }`}
          >
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full bg-current shadow-[0_0_6px_currentColor] ${
                live ? "animate-pulse" : ""
              }`}
            />
            {word}
          </span>
          <IntervalToggle intervals={intervals} active={interval} onSelect={onIntervalChange} />
        </div>
        {/* Right-column invariant: no conditional px/mx/border here — both rows stay pixel-left-aligned. */}
        <p className="truncate font-mono text-[11px] leading-5 whitespace-nowrap tabular-nums">
          <span
            className={`truncate rounded px-1 font-medium text-live ${pinned ? "bg-live/15" : "bg-transparent"}`}
            title={stampWireIso ?? undefined}
          >
            {stamp}
          </span>
        </p>
      </div>
    </div>
  );
}

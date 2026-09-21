"use client";

/**
 * The candles panel: the chart library drawing our series, and the readout that
 * explains it.
 *
 * The division of labour this component exists to enforce (`docs/SEAMS.md` Slice
 * C, "the lib only draws what our code supplies"):
 *
 * - `lib/candles.ts` owns the series — history plus the forming bucket, one entry
 *   per bucket,
 * - `lib/candle-chart.ts` is the only thing that writes to the library, and it
 *   writes bars built from those candles,
 * - the library draws, panning, zooming, and reporting which bucket the pointer is
 *   over — never deciding a price. There is no `fetch` in this file either; it
 *   receives plain values as props (`components/**` is linted against `fetch`).
 *
 * Manner notes (SPEC story 10): the chart is created once and the series is moved
 * imperatively from an effect, so a 4Hz bucket costs one `update()` rather than a
 * React render of a canvas; only the small inspection readout re-renders as the
 * pointer moves, and the pointer readout is resolved back to *our* candle.
 *
 * Pin manner (parked #17): a click pins the readout so a drag can pan without
 * the numbers moving, and the next click releases it. The latch is visible
 * where it was set — a dotted vertical line at the pinned bucket, drawn as an
 * overlay div positioned from `timeToCoordinate()` and re-subscribed on
 * visible-range changes so it tracks pans and zooms (hidden while the pinned
 * candle is scrolled out of view) — plus the header's stamp in the live tone.
 * The overlay is pointer-transparent, so showing it never disturbs the canvas
 * layout and clicking the chart stays the unpin path.
 * Keyboard inspection mirrors the click latch: focusing the wrapper exposes an
 * application role where arrows step one bucket (unpinning first so the readout
 * follows), Enter toggles the pin, and Escape clears pin and hover.
 *
 * Pinned-time stamp: a solid chip (`bg-bid` background, white text) centered on
 * the time-axis label row (same horizontal row as the axis tick labels) where
 * the pin line meets it, showing the pinned bucket's short local time —
 * centered on the line while visible (it rides the line horizontally as the
 * chart scrolls), but clamped into view when the pinned bucket scrolls out:
 * stuck to the left edge when pinned earlier than the visible range, to the
 * right edge when later — pointer-transparent, so showing it never disturbs
 * the canvas layout. The pin line keeps hiding out of view; only the label sticks.
 */

import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  type IChartApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";

import { ChartHeader } from "@/components/ChartHeader";
import { renderCandles, type CandleColors, type ChartTargets } from "@/lib/candle-chart";
import { candleSeconds, findCandleAtSeconds, mergeSeries } from "@/lib/candles";
import { formatClock, type SessionStats } from "@/lib/format";
import type { Candle, Interval } from "@/lib/protocol";
import type { HistoryStatus } from "@/stores/candle";

type CandleChartProps = {
  /** The interval the chart is following; the socket subscribes with it. */
  interval: Interval;
  /** Every interval the backend offers, for the toggle. */
  intervals: Interval[];
  /** Called with the clicked interval: the store owns the switch, not the chart. */
  onIntervalChange: (interval: Interval) => void;
  history: readonly Candle[];
  activeCandle: Candle | null;
  /** Where the history read stands — the chart's empty states hang off it. */
  status: HistoryStatus;
  error: string | null;
  /** The market symbol, for the header's asset name. */
  symbol: string | null;
  /** The live mid, for the header's big price. */
  mid: number | null;
  /** The previous mid, for the header's tick direction. */
  previousMid: number | null;
  /** Mount-lifetime extremes — the header's fallback before the first candle. */
  session: SessionStats;
  /** The socket is down: the header's numbers are cached, not live. */
  stale: boolean;
  /** A snapshot refetch is in flight — the header says `syncing`. */
  syncing: boolean;
  /** Active color theme; the chart rebuilds to re-resolve canvas tokens on switch. */
  theme: "light" | "dark";
};

/**
 * The chart's colours, read from the theme rather than repeated as hexes here —
 * `app/globals.css` is the one place a colour is chosen. The library draws on a
 * canvas, which cannot resolve `var(--…)`, so the tokens are resolved once at
 * mount; the fallbacks only matter if the theme is missing altogether.
 */
function themeColors(element: HTMLElement): CandleColors & { text: string; line: string; panel: string; canvas: string; ink: string } {
  const styles = getComputedStyle(element);
  const read = (token: string, fallback: string): string =>
    styles.getPropertyValue(token).trim() || fallback;
  return {
    up: read("--color-bid", "#0b7a55"),
    down: read("--color-ask", "#cf222e"),
    text: read("--color-muted", "#4d5f7d"),
    line: read("--color-line", "#d4dcea"),
    panel: read("--color-panel", "#ffffff"),
    canvas: read("--color-canvas", "#e8ecf4"),
    ink: read("--color-ink", "#0f1c33"),
  };
}

/**
 * The volume-column tint: `color` at ~50% alpha, as an `rgba()` string (the
 * `rgba()` form is what the library's own option docs use, so no reliance on
 * 8-digit-hex parsing). Falls back to the precomputed tint of the default hex
 * when the resolved token is not a 6-digit hex.
 */
function withHalfAlpha(color: string, fallbackRgba: string): string {
  const hex = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, 0.5)`;
  }
  return fallbackRgba;
}


/** What the empty chart is waiting for. Never a frozen chart, never a fake one. */
function EmptyState({
  status,
  interval,
  error,
}: {
  status: HistoryStatus;
  interval: Interval;
  error: string | null;
}) {
  const text =
    status === "error"
      ? `history could not be read — ${error ?? "unknown error"}. Retrying; the chart fills in as candles print.`
      : status === "ready"
        ? `no finished ${interval} candles yet. The feed closes a bucket every ${interval === "1s" ? "second" : "minute"}; the chart fills in as trades print.`
        : `loading ${interval} candles from /api/history…`;

  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6">
      <p
        className={`max-w-sm text-center font-mono text-[11px] font-medium leading-relaxed ${
          status === "error" ? "text-stale" : "text-faint"
        }`}
      >
        {text}
      </p>
    </div>
  );
}

export function CandleChart({
  interval,
  intervals,
  onIntervalChange,
  history,
  activeCandle,
  status,
  error,
  symbol,
  mid,
  previousMid,
  session,
  stale,
  syncing,
  theme,
}: CandleChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const targetsRef = useRef<ChartTargets | null>(null);
  /*
   * B7 — volume palette: the candle up/down theme colors at ~50% alpha.
   * Resolved once at mount next to the opaque candle palette. The adapter
   * (`lib/candle-chart.ts` `toVolumeBar`) paints every volume bar with a
   * per-bar `color` taken from the `colors` argument it is handed, so handing
   * it this palette (rather than the opaque candle palette) is what tints the
   * columns — a series-level up/down pair does not exist in
   * lightweight-charts v5 (`HistogramStyleOptions` exposes a single fallback
   * `color`; per-bar `color` always wins, verified in node_modules typings),
   * and threading a new parameter through the lib adapter is out of scope.
   */
  const volumeColorsRef = useRef<CandleColors>({
    up: "rgba(11, 122, 85, 0.5)",
    down: "rgba(207, 34, 46, 0.5)",
  });
  /** What the library is currently drawing: the adapter's record, not the library's. */
  const drawnRef = useRef<readonly Candle[]>([]);
  const pinnedRef = useRef(false);

  const [hoveredSeconds, setHoveredSeconds] = useState<number | null>(null);
  const [pinned, setPinned] = useState(false);
  /** X-coordinate of the pinned bucket's line; null while unpinned or scrolled out of view. */
  const [pinX, setPinX] = useState<number | null>(null);
  /** X-coordinate of the pinned-time chip; clamped into view so it sticks to the axis edge when the pinned bucket scrolls out. */
  const [pinLabelX, setPinLabelX] = useState<number | null>(null);

  // History plus the bucket still forming. One array, memoised on the two values
  // the store writes, so an unrelated store write cannot rebuild it.
  const series = useMemo(() => mergeSeries(history, activeCandle), [history, activeCandle]);

  /*
   * The readout is resolved against the series on every render rather than kept
   * as a candle of its own: a pinned readout then follows its bucket as the
   * bucket grows, and it disappears by itself when the bucket leaves the series
   * — an interval switch cannot leave a number on screen for a candle the chart
   * is no longer drawing.
   */
  const inspected =
    hoveredSeconds === null ? null : findCandleAtSeconds(series, hoveredSeconds);

  // The chart exists once per theme, for the life of the panel: React never touches the
  // canvas, and a new candle is not a reason to create one.
  /** Pin/hover inspection resets on theme switch (accepted — theme switches are rare, correctness of colors wins). */
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const colors = themeColors(container);
    volumeColorsRef.current = {
      up: withHalfAlpha(colors.up, "rgba(11, 122, 85, 0.5)"),
      down: withHalfAlpha(colors.down, "rgba(207, 34, 46, 0.5)"),
    };

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        attributionLogo: false,
        textColor: colors.text,
      },
      // Grid sits one surface step BELOW the panel in both modes (canvas is darker
      // than the panel on dark, lighter on light) — panel-alt glowed distractingly on dark.
      grid: { vertLines: { color: colors.canvas }, horzLines: { color: colors.canvas } },
      rightPriceScale: { borderColor: colors.line, scaleMargins: { top: 0.1, bottom: 0.28 } },
      timeScale: {
        borderColor: colors.line,
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 2,
      },
      crosshair: {
        // Dark chip preserves the library's default light label text on the light theme.
        horzLine: { labelVisible: true, labelBackgroundColor: colors.ink },
        vertLine: { labelVisible: true, labelBackgroundColor: colors.ink },
      },
      // The wire is UTC; the axis is the viewer's wall clock, so the tape,
      // the stamps, and the axis all agree with each other (and the clock on
      // the user's wall). Hovering a time shows the wire's UTC ISO string.
      localization: {
        locale: "en-US",
        timeFormatter: (time: Time) => (typeof time === "number" ? formatClock(time * 1000) : ""),
      },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      borderVisible: false,
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "",
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: false,
      // Fallback column only (see the volumeColorsRef note above): every bar
      // the adapter writes carries its own per-bar `color`, which wins over
      // this. Set it to the themed up tint anyway so no library-default blue
      // can ever show through on a bar without one.
      color: volumeColorsRef.current.up,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });

    chartRef.current = chart;
    targetsRef.current = { candles, volume };
    drawnRef.current = [];

    const handleMove = (param: MouseEventParams): void => {
      if (pinnedRef.current) {
        return;
      }
      // The library reports where on the axis the pointer is; the values come
      // from our series, never from the library's copy of the data.
      setHoveredSeconds(typeof param.time === "number" ? param.time : null);
    };
    const handleClick = (): void => {
      // A click pins the readout so a drag can pan without the numbers moving;
      // the next click releases it.
      pinnedRef.current = !pinnedRef.current;
      setPinned(pinnedRef.current);
    };
    chart.subscribeCrosshairMove(handleMove);
    chart.subscribeClick(handleClick);

    return () => {
      chart.unsubscribeCrosshairMove(handleMove);
      chart.unsubscribeClick(handleClick);
      chart.remove();
      chartRef.current = null;
      targetsRef.current = null;
      drawnRef.current = [];
    };
  }, [theme]);

  // Hand the library our series, through the one adapter that writes to it.
  // The volume half of the palette: the adapter's per-bar volume colors come
  // from this argument, so the translucent tints (not the opaque candle
  // colors) are what the columns are painted with.
  useEffect(() => {
    const targets = targetsRef.current;
    if (targets === null) {
      return;
    }
    const plan = renderCandles(targets, drawnRef.current, series, volumeColorsRef.current);
    drawnRef.current = series;
    if (plan.kind === "set") {
      // A rebuild is a new series (first paint, interval switch, a history
      // refetch): the old visible range means nothing against it.
      chartRef.current?.timeScale().fitContent();
    }
  }, [series]);

  // The pinned bucket's dotted line + its axis chip: positioned from the time
  // scale on every pin/bucket change and re-subscribed on visible-range changes
  // so they track pans and zooms. The line is null (hidden) while the bucket is
  // scrolled out of view; the chip instead clamps into view, sticking to the
  // edge the bucket left by.
  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null || !pinned || hoveredSeconds === null || inspected === null) {
      setPinX(null);
      setPinLabelX(null);
      return;
    }
    const update = (): void => {
      const current = chartRef.current;
      if (current === null) {
        return;
      }
      try {
        const x = current.timeScale().timeToCoordinate(hoveredSeconds as UTCTimestamp);
        setPinX(x ?? null);
        // ~34px half-label estimate: keeps the centered chip fully in view at either edge.
        const half = 34;
        if (x !== null && x !== undefined) {
          const width = containerRef.current?.clientWidth ?? null;
          setPinLabelX(
            width === null ? x : Math.min(Math.max(x, half), Math.max(width - half, half)),
          );
          return;
        }
        const containerWidth = containerRef.current?.clientWidth ?? null;
        if (containerWidth === null) {
          setPinLabelX(null);
          return;
        }
        try {
          const range = current.timeScale().getVisibleRange();
          if (range === null) {
            setPinLabelX(null);
            return;
          }
          const from = typeof range.from === "number" ? range.from : null;
          const to = typeof range.to === "number" ? range.to : null;
          if (from === null || to === null) {
            setPinLabelX(null);
            return;
          }
          if (hoveredSeconds < from) {
            setPinLabelX(half);
          } else if (hoveredSeconds > to) {
            setPinLabelX(containerWidth - half);
          } else {
            setPinLabelX(null);
          }
        } catch {
          setPinLabelX(null);
        }
      } catch {
        setPinX(null);
        setPinLabelX(null);
      }
    };
    update();
    chart.timeScale().subscribeVisibleTimeRangeChange(update);
    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(update);
    };
  }, [pinned, hoveredSeconds, inspected]);


  const hasCandles = series.length > 0;
  // The header's hovered row: the inspected bucket, unless it is the forming
  // one — the current row already shows that bucket, so a second row would
  // just duplicate it. A pinned readout whose bucket left the series drops
  // out by itself on the next render.
  const hoveredCandle =
    inspected !== null && inspected.t !== activeCandle?.t ? inspected : null;
  return (
    <>
      <h2 className="sr-only">{symbol ? `Price chart — ${symbol}` : "Price chart"}</h2>
      <ChartHeader
        symbol={symbol}
        mid={mid}
        previousMid={previousMid}
        session={session}
        stale={stale}
        active={activeCandle}
        hovered={hoveredCandle}
        pinned={pinned}
        syncing={syncing}
        historyError={error}
        interval={interval}
        intervals={intervals}
        onIntervalChange={onIntervalChange}
      />

      <div
        className="relative h-[clamp(240px,38vh,420px)] overflow-hidden rounded border border-line bg-panel-alt/40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-line"
        tabIndex={0}
        role="application"
        aria-label="Candle chart. Left and right arrows step through candles, Enter pins a candle, Escape clears."
        onKeyDown={(event) => {
          const buckets = series
            .map((candle) => candleSeconds(candle.t))
            .filter((value): value is number => value !== null)
            .sort((a, b) => a - b);
          if (buckets.length === 0) {
            return;
          }
          const first = buckets[0];
          const last = buckets[buckets.length - 1];
          if (first === undefined || last === undefined) {
            return;
          }
          const step = interval === "1m" ? 60 : 1;
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            if (pinnedRef.current) {
              pinnedRef.current = false;
              setPinned(false);
            }
            const base = hoveredSeconds ?? last;
            const delta = event.key === "ArrowLeft" ? -step : step;
            setHoveredSeconds(Math.min(Math.max(base + delta, first), last));
          } else if (event.key === "Home") {
            event.preventDefault();
            if (pinnedRef.current) {
              pinnedRef.current = false;
              setPinned(false);
            }
            setHoveredSeconds(first);
          } else if (event.key === "End") {
            event.preventDefault();
            if (pinnedRef.current) {
              pinnedRef.current = false;
              setPinned(false);
            }
            setHoveredSeconds(last);
          } else if (event.key === "Enter") {
            // Pinning nothing would latch the header stamp highlight with no
            // line on the chart — only toggle when a bucket is inspected.
            if (hoveredSeconds === null) {
              return;
            }
            event.preventDefault();
            pinnedRef.current = !pinnedRef.current;
            setPinned(pinnedRef.current);
          } else if (event.key === "Escape") {
            pinnedRef.current = false;
            setPinned(false);
            setHoveredSeconds(null);
          }
        }}
      >
        <div ref={containerRef} aria-hidden="true" className="absolute inset-0" />
        {/* The latch is visible where it was set: a dotted line at the pinned bucket, so showing it never disturbs the canvas layout. Chart clicks stay the unpin path. */}
        {pinned && inspected !== null && pinX !== null ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 border-l border-dotted border-live/70"
            style={{ left: pinX }}
          />
        ) : null}
        {/* The pinned bucket's short local time: a solid chip centered on the time-axis label row at the pin line; clamped into view (sticks to the edge) when the bucket scrolls out, unlike the pin line which hides. */}
        {pinned && inspected !== null && pinLabelX !== null ? (
          // bottom-[5px] puts the ~16px chip on the axis tick labels' centerline;
          // z-10 keeps it above the canvas-drawn labels it shares the row with.
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-[5px] z-10 rounded bg-bid px-1 font-mono text-[10px] font-semibold tabular-nums text-white"
            style={{ left: pinLabelX, transform: "translateX(-50%)" }}
          >
            {formatClock((candleSeconds(inspected.t) ?? 0) * 1000)}
          </div>
        ) : null}
        {hasCandles ? null : <EmptyState status={status} interval={interval} error={error} />}
      </div>
    </>
  );
}

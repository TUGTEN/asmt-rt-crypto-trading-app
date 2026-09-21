/**
 * Pure display helpers: no React, no fetching, no side effects.
 *
 * Two rules keep money maths honest:
 *
 * 1. Prices and quantities arrive as decimal strings and are *rendered from
 *    those strings* — `formatPrice("65123.45")` groups digits textually, so no
 *    float ever decides what a price looks like on screen.
 * 2. Aggregates (the book's cumulative size column) are summed in scaled
 *    integers, never in floating point.
 *
 * Numbers are only produced where a comparison is unavoidable — the mid price,
 * the movement since the previous poll, the spread — and they are display-only
 * values, never sent back anywhere.
 */

import type { Level, Snapshot } from "@/lib/protocol";
import { isDecimalString, splitDecimal } from "@/lib/decimal";

/** Backend `q2s` prints quantities with 6 decimals; keep sums in that scale. */
const QTY_DECIMALS = 6;

const UNSAFE = "—";

function groupDigits(digits: string): string {
  const negative = digits.startsWith("-");
  const body = negative ? digits.slice(1) : digits;
  return `${negative ? "-" : ""}${body.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/** `"65123.45"` -> `"65,123.45"`; invalid input renders as an em dash. */
export function formatPrice(value: string): string {
  const parts = splitDecimal(value);
  if (parts === null) {
    return UNSAFE;
  }
  return parts.fraction === null
    ? groupDigits(parts.whole)
    : `${groupDigits(parts.whole)}.${parts.fraction}`;
}

/** `"1.500000"` -> `"1.5"`, `"0.012345"` -> `"0.012345"` (trailing zeros dropped). */
export function formatQty(value: string): string {
  const parts = splitDecimal(value);
  if (parts === null) {
    return UNSAFE;
  }
  const trimmed = (parts.fraction ?? "").replace(/0+$/, "");
  return trimmed.length > 0 ? `${groupDigits(parts.whole)}.${trimmed}` : groupDigits(parts.whole);
}

/**
 * `"1.5"` -> `"1.500000"`: same value as `formatQty`, zero-padded to a fixed
 * width so a column of sizes never changes shape as prints come and go.
 * Padding with zeros adds no false precision — `0.5` and `0.500000` are the
 * same quantity — and the tail past the second decimal renders dimmed
 * (`splitFigure`), so the eye still lands on the significant figures first.
 */
export function formatQtyFixed(value: string, decimals = QTY_DECIMALS): string {
  const parts = splitDecimal(value);
  if (parts === null) {
    return UNSAFE;
  }
  const fraction = (parts.fraction ?? "").padEnd(decimals, "0").slice(0, decimals);
  return decimals === 0 ? groupDigits(parts.whole) : `${groupDigits(parts.whole)}.${fraction}`;
}

/** One figure split for emphasis: significant head, dimmable tail. */
export type FigureParts = { head: string; tail: string };

/**
 * Split a formatted figure (`"75,496.48"`, `"0.102196"`) into the significant
 * head (whole part plus two decimals) and the tail past it.
 * `"0.102196"` -> `{head: "0.10", tail: "2196"}`; `"75,496.48"` and `"—"`
 * have an empty tail. Pure and total, so the table emphasis is pinned by tests.
 */
export function splitFigure(formatted: string): FigureParts {
  const dot = formatted.indexOf(".");
  if (dot === -1) {
    return { head: formatted, tail: "" };
  }
  const cut = dot + 1 + 2;
  return { head: formatted.slice(0, cut), tail: formatted.slice(cut) };
}

/** Exact decimal comparison/aggregation support: decimal string -> scaled integer. */
function toScaled(value: string, decimals = QTY_DECIMALS): number | null {
  // The whole part carries the sign (`splitDecimal` keeps it), so the
  // scaled integer is the digits with the fraction padded to scale.
  const parts = splitDecimal(value);
  if (parts === null) {
    return null;
  }
  const fraction = parts.fraction ?? "";
  if (fraction.length > decimals) {
    return null;
  }
  const scaled = Number(`${parts.whole}${fraction.padEnd(decimals, "0")}`);
  return Number.isSafeInteger(scaled) ? scaled : null;
}

function fromScaled(scaled: number, decimals: number): string {
  const digits = Math.abs(scaled).toString().padStart(decimals + 1, "0");
  const cut = digits.length - decimals;
  return `${scaled < 0 ? "-" : ""}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

/**
 * Sum decimal strings without floating point, at the wire's 6-decimal quantity
 * scale; `null` if any input is invalid. Display code runs the total through
 * `formatQty`, which drops the trailing zeros this keeps for exactness.
 */
export function sumQty(values: string[]): string | null {
  let total = 0;
  for (const value of values) {
    const scaled = toScaled(value);
    if (scaled === null) {
      return null;
    }
    total += scaled;
  }
  return fromScaled(total, QTY_DECIMALS);
}

/**
 * Display-only numeric view of a decimal string; `null` if it is not one.
 *
 * The regex is not decoration: `Number("")` is `0`, and `Number(" ")` is too,
 * which would let a blank price compare as the cheapest ask on the book.
 */
export function parseDecimal(value: string): number | null {
  if (!isDecimalString(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extreme(levels: Level[], keep: (best: number, next: number) => boolean): Level | null {
  let best: Level | null = null;
  let bestValue = 0;
  for (const level of levels) {
    const value = parseDecimal(level.price);
    if (value === null) {
      continue;
    }
    if (best === null || keep(bestValue, value)) {
      best = level;
      bestValue = value;
    }
  }
  return best;
}

/** Highest-priced bid, whatever order the wire sent. */
export function bestBid(snapshot: Snapshot): Level | null {
  return extreme(snapshot.bids, (best, next) => next > best);
}

/** Lowest-priced ask, whatever order the wire sent. */
export function bestAsk(snapshot: Snapshot): Level | null {
  return extreme(snapshot.asks, (best, next) => next < best);
}

/**
 * The screen's "latest price". The book is the market's quote, so the headline
 * number is its mid; the tape beside it shows what actually printed. Both come
 * from the same socket, and neither is ever a value the client invented.
 */
export function midPrice(snapshot: Snapshot): number | null {
  const bid = bestBid(snapshot);
  const ask = bestAsk(snapshot);
  const bidValue = bid === null ? null : parseDecimal(bid.price);
  const askValue = ask === null ? null : parseDecimal(ask.price);
  if (bidValue === null && askValue === null) {
    return null;
  }
  if (bidValue === null) {
    return askValue;
  }
  if (askValue === null) {
    return bidValue;
  }
  return (bidValue + askValue) / 2;
}

/** Best ask minus best bid. */
export function spread(snapshot: Snapshot): number | null {
  const bid = bestBid(snapshot);
  const ask = bestAsk(snapshot);
  if (bid === null || ask === null) {
    return null;
  }
  const bidValue = parseDecimal(bid.price);
  const askValue = parseDecimal(ask.price);
  if (bidValue === null || askValue === null) {
    return null;
  }
  return askValue - bidValue;
}

export type Movement = "up" | "down" | "flat" | "unknown";

/** Movement of the latest poll against the previous one. */
export function movement(previous: number | null, latest: number | null): Movement {
  if (previous === null || latest === null) {
    return "unknown";
  }
  if (latest > previous) {
    return "up";
  }
  if (latest < previous) {
    return "down";
  }
  return "flat";
}

/** Absolute change, e.g. `+12.40` / `-3.00`. */
export function formatSigned(value: number, decimals = 2): string {
  const fixed = value.toFixed(decimals);
  if (Number(fixed) === 0) {
    return (0).toFixed(decimals);
  }
  return value > 0 ? `+${fixed}` : fixed;
}

export function formatPercent(value: number, decimals = 3): string {
  return `${formatSigned(value, decimals)}%`;
}

/** Percent change from `previous` to `latest`; `null` when undefined. */
export function percentChange(previous: number | null, latest: number | null): number | null {
  if (previous === null || latest === null || previous === 0) {
    return null;
  }
  return ((latest - previous) / previous) * 100;
}

/** Session extremes for the hero strip: open/high/low mids seen this mount. */
export type SessionStats = {
  open: number | null;
  high: number | null;
  low: number | null;
};

/**
 * Fold one mid into the session stats: the first mid opens the session,
 * later mids only stretch the extremes. Pure, so the hero's baseline is
 * pinned by tests rather than by the socket module.
 */
export function trackSession(prev: SessionStats, mid: number | null): SessionStats {
  if (mid === null) {
    return prev;
  }
  if (prev.open === null) {
    return { open: mid, high: mid, low: mid };
  }
  return {
    open: prev.open,
    high: prev.high === null ? mid : Math.max(prev.high, mid),
    low: prev.low === null ? mid : Math.min(prev.low, mid),
  };
}

/**
 * Wall-clock formatters: the wire speaks UTC (`RFC3339Nano` with ordering ids),
 * but the screen speaks the user's timezone — a clock the viewer has to
 * translate in their head is a clock they will misread.
 *
 * `formatClock` is the tape cell / axis label; `formatStamp` is the inspection
 * stamp, with the GMT offset on it so the zone is never ambiguous. Hovering
 * either shows the wire's UTC ISO string (the `title` attribute), so the
 * demo story stays one sentence: UTC on the wire, local on the glass.
 */
const LOCAL_CLOCK = new Intl.DateTimeFormat("en-US", {
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const LOCAL_DATE = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** `"GMT"`, `"GMT+2"`, `"GMT-5:30"` — the viewer's offset at that instant. */
function localTzLabel(epochMs: number): string {
  const offsetMin = -new Date(epochMs).getTimezoneOffset();
  if (offsetMin === 0) {
    return "GMT";
  }
  const sign = offsetMin > 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return minutes === 0 ? `GMT${sign}${hours}` : `GMT${sign}${hours}:${minutes.toString().padStart(2, "0")}`;
}

/** Epoch millis -> `"19:42:03"` in the viewer's timezone. */
export function formatClock(epochMs: number): string {
  return LOCAL_CLOCK.format(new Date(epochMs));
}

/**
 * Epoch millis -> `"2026-09-19 19:42:03 GMT+2"` in the viewer's timezone.
 *
 * The chart's inspection stamp: a clock on its own is ambiguous once the series
 * spans more than the part of the day that happens to be on screen, and the
 * `en-CA`-style date order is read the same way by every reader.
 */
export function formatStamp(epochMs: number): string {
  const date = new Date(epochMs);
  return `${LOCAL_DATE.format(date)} ${LOCAL_CLOCK.format(date)} ${localTzLabel(epochMs)}`;
}

/**
 * Millis on screen: `"12.3 ms"`, or an em dash when nothing was measured.
 *
 * One decimal, because these are round trips read off a screen and reported to
 * the backend rounded the same way (`lib/latency.ts`) — the panel and the
 * delivery badge must not disagree about the same measurement.
 */
export function formatMs(value: number | null): string {
  return value === null ? UNSAFE : `${value.toFixed(1)} ms`;
}

const MILLIS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/** `"2s ago"`, `"1m 05s ago"`; `now` is injected so the helper stays pure. */
export function formatAge(epochMs: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - epochMs) / MILLIS_PER_SECOND));
  if (seconds < 1) {
    return "just now";
  }
  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const rest = seconds % SECONDS_PER_MINUTE;
  return `${minutes}m ${rest.toString().padStart(2, "0")}s ago`;
}

/** One rendered row of the depth ladder. */
export type BookLevelView = {
  key: string;
  /** Formatted price, straight from the wire string. */
  price: string;
  /** Formatted size of this level. */
  qty: string;
  /** Formatted cumulative size from the top of the side down to here. */
  total: string;
  /** Bar width (0-100) for this row, against the deepest cumulative size. */
  depth: number;
};

/**
 * Turn a wire side into render rows: top `depth` levels, with cumulative size
 * summed in scaled integers and a bar width for the depth shading.
 */
export function bookLadder(levels: Level[], depth: number): BookLevelView[] {
  const shown = levels.slice(0, Math.max(0, depth));
  let running = 0;
  let runningValid = true;
  const rows = shown.map((level) => {
    const scaled = toScaled(level.qty);
    if (scaled === null) {
      runningValid = false;
    } else {
      running += scaled;
    }
    return {
      key: level.price,
      price: formatPrice(level.price),
      qty: formatQtyFixed(level.qty),
      total: runningValid ? formatQtyFixed(fromScaled(running, QTY_DECIMALS)) : UNSAFE,
      cumulative: runningValid ? running : null,
    };
  });
  const deepest = rows.reduce(
    (best, row) => (row.cumulative !== null && row.cumulative > best ? row.cumulative : best),
    0,
  );
  return rows.map((row) => ({
    key: row.key,
    price: row.price,
    qty: row.qty,
    total: row.total,
    depth:
      row.cumulative !== null && deepest > 0
        ? Math.min(100, Math.max(2, (row.cumulative / deepest) * 100))
        : 0,
  }));
}

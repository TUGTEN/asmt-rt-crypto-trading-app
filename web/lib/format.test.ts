import { describe, expect, it } from "vitest";

import {
  bestAsk,
  bestBid,
  bookLadder,
  formatAge,
  formatMs,
  formatPercent,
  formatPrice,
  formatQty,
  formatQtyFixed,
  formatSigned,
  formatClock,
  formatStamp,
  midPrice,
  movement,
  parseDecimal,
  percentChange,
  spread,
  splitFigure,
  sumQty,
  trackSession,
} from "@/lib/format";
import type { Level, Snapshot } from "@/lib/protocol";

function snapshot(bids: Level[], asks: Level[]): Snapshot {
  return { seq: 7, bids, asks };
}

const USD = (price: string, qty = "1.000000"): Level => ({ price, qty });

describe("formatPrice", () => {
  it("groups the wire's decimal string without going through a float", () => {
    expect(formatPrice("65123.45")).toBe("65,123.45");
    expect(formatPrice("999.99")).toBe("999.99");
    expect(formatPrice("1234567.8")).toBe("1,234,567.8");
    expect(formatPrice("0.12")).toBe("0.12");
  });

  it("keeps trailing decimals the wire sent (exact digits, not rounded)", () => {
    expect(formatPrice("65123.40")).toBe("65,123.40");
    expect(formatPrice("100")).toBe("100");
  });

  it("handles negatives and renders junk as an em dash instead of NaN", () => {
    expect(formatPrice("-1234.50")).toBe("-1,234.50");
    // `"1.2.3"` and `"65123."` are the traps: splitting on "." would render
    // them as "1.2" and "65,123." instead of admitting they are unreadable.
    for (const junk of ["", "abc", "1.2.3", "65123.", ".5", "1e3", "NaN"]) {
      expect(formatPrice(junk)).toBe("—");
      expect(formatQty(junk)).toBe("—");
    }
  });
});

describe("formatQty", () => {
  it("drops trailing zeros the backend pads quantities with", () => {
    expect(formatQty("1.500000")).toBe("1.5");
    expect(formatQty("0.012345")).toBe("0.012345");
    expect(formatQty("2.000000")).toBe("2");
    expect(formatQty("0.000000")).toBe("0");
  });

  it("groups large sizes and guards invalid input", () => {
    expect(formatQty("12345.678900")).toBe("12,345.6789");
    expect(formatQty("nope")).toBe("—");
  });
});

describe("formatQtyFixed", () => {
  // Fixed width stops the column jittering as prints come and go: every size
  // holds six decimals, so rows never change shape. Padding adds no false
  // precision — "1.5" and "1.500000" are the same quantity.
  it("pads sizes to a fixed width", () => {
    expect(formatQtyFixed("1.5")).toBe("1.500000");
    expect(formatQtyFixed("0.102196")).toBe("0.102196");
  });

  it("guards invalid input", () => {
    expect(formatQtyFixed("nope")).toBe("—");
  });
});

describe("splitFigure", () => {
  // The tail past the second decimal renders dimmed, so the eye lands on the
  // significant figures first; figures with no tail render as a single run.
  it("splits the significant head from the dimmable tail", () => {
    expect(splitFigure("0.102196")).toEqual({ head: "0.10", tail: "2196" });
    expect(splitFigure("75,496.48")).toEqual({ head: "75,496.48", tail: "" });
    expect(splitFigure("—")).toEqual({ head: "—", tail: "" });
  });
});

describe("sumQty", () => {
  it("sums decimal strings exactly where floats would drift", () => {
    // 0.1 + 0.2 in binary floating point is 0.30000000000000004.
    expect(Number(sumQty(["0.1", "0.2"]))).toBe(0.3);
    expect(sumQty(["0.032098", "0.056093"])).toBe("0.088191");
    // Totals keep the wire's 6-decimal scale; formatting drops the zeros.
    expect(sumQty([])).toBe("0.000000");
  });

  it("survives many small additions without visible drift", () => {
    const repeated = Array.from({ length: 10 }, () => "0.012345");
    expect(sumQty(repeated)).toBe("0.123450");
    // 0.0123450 * 10 is exact in scaled integers; the same sum in floats drifts.
    expect(repeated.reduce((total, qty) => total + Number(qty), 0)).not.toBe(0.12345);
  });

  it("returns null rather than a wrong number when an input is not decimal", () => {
    expect(sumQty(["1.0", "oops"])).toBeNull();
  });
});

describe("parseDecimal", () => {
  it("is display-only and explicit about failure", () => {
    expect(parseDecimal("65123.45")).toBe(65123.45);
    expect(parseDecimal("0")).toBe(0);
    expect(parseDecimal("")).toBeNull();
    expect(parseDecimal("abc")).toBeNull();
  });
});

describe("bestBid / bestAsk / midPrice / spread", () => {
  it("finds the best levels whatever order the wire sent", () => {
    const book = snapshot([USD("100.00"), USD("102.00"), USD("101.00")], [USD("109.00"), USD("107.00"), USD("108.00")]);
    expect(bestBid(book)?.price).toBe("102.00");
    expect(bestAsk(book)?.price).toBe("107.00");
    expect(midPrice(book)).toBe(104.5);
    expect(spread(book)).toBe(5);
  });

  it("derives the mid price from the top of the book, not from a level's index", () => {
    const book = snapshot([USD("65164.44")], [USD("65210.91")]);
    expect(midPrice(book)).toBeCloseTo((65164.44 + 65210.91) / 2, 6);
  });

  it("degenerates honestly on empty or one-sided books", () => {
    expect(midPrice(snapshot([], []))).toBeNull();
    expect(bestBid(snapshot([], []))).toBeNull();
    expect(midPrice(snapshot([USD("100.00")], []))).toBe(100);
    expect(spread(snapshot([USD("100.00")], []))).toBeNull();
    expect(midPrice(snapshot([USD("junk")], [USD("102.00")]))).toBe(102);
  });
});

describe("movement / percentChange / formatSigned / formatPercent", () => {
  it("compares each poll with the previous one", () => {
    expect(movement(100, 101)).toBe("up");
    expect(movement(100, 99)).toBe("down");
    expect(movement(100, 100)).toBe("flat");
    expect(movement(null, 100)).toBe("unknown");
    expect(movement(100, null)).toBe("unknown");
  });

  it("formats the change the way the ticker reads it", () => {
    expect(formatSigned(12.4)).toBe("+12.40");
    expect(formatSigned(-3)).toBe("-3.00");
    expect(formatSigned(-0.001)).toBe("0.00");
    expect(formatPercent(12.4)).toBe("+12.400%");
    expect(formatPercent(12.4, 2)).toBe("+12.40%");
  });

  it("refuses to divide by a zero or unknown previous price", () => {
    expect(percentChange(100, 101)).toBeCloseTo(1, 10);
    expect(percentChange(null, 101)).toBeNull();
    expect(percentChange(100, null)).toBeNull();
    expect(percentChange(0, 101)).toBeNull();
  });
});

describe("formatClock / formatStamp / formatAge", () => {
  // The screen speaks the viewer's timezone: build the expectation with
  // bare `Intl` formatters (no `timeZone`), so this passes in any zone.
  const clock = new Intl.DateTimeFormat("en-US", {
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const date = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  it("renders local wall-clock time, matching the tape, axis, and stamps", () => {
    const epochMs = Date.parse("2026-09-19T14:18:11Z");
    const when = new Date(epochMs);
    expect(formatClock(epochMs)).toBe(clock.format(when));
    const stamp = formatStamp(epochMs);
    // Date plus clock are the local wall time; the tail names the zone.
    expect(stamp.startsWith(`${date.format(when)} ${clock.format(when)} `)).toBe(true);
    // The zone rides on the stamp, so it is never ambiguous.
    expect(formatStamp(epochMs)).toMatch(/GMT([+-]\d{1,2}(:\d{2})?)?$/);
  });

  it("describes the age of a frame against an injected clock", () => {
    const t = Date.parse("2026-09-19T14:18:11Z");
    expect(formatAge(t, t)).toBe("just now");
    expect(formatAge(t, t + 2_000)).toBe("2s ago");
    expect(formatAge(t, t + 65_000)).toBe("1m 05s ago");
    // A frame from the future (clock skew) must not read as a negative age.
    expect(formatAge(t + 5_000, t)).toBe("just now");
  });
});

describe("formatMs", () => {
  it("writes a measurement to one decimal, and nothing as an em dash", () => {
    expect(formatMs(12.34)).toBe("12.3 ms");
    expect(formatMs(0)).toBe("0.0 ms");
    expect(formatMs(250)).toBe("250.0 ms");
    // No sample yet is not the same reading as a fast one.
    expect(formatMs(null)).toBe("—");
  });
});

describe("bookLadder", () => {
  const levels: Level[] = [
    USD("100.00", "1.000000"),
    USD("99.00", "2.500000"),
    USD("98.00", "0.500000"),
  ];

  it("shows the top N levels in wire order with cumulative size", () => {
    const rows = bookLadder(levels, 2);
    expect(rows.map((row) => row.price)).toEqual(["100.00", "99.00"]);
    expect(rows.map((row) => row.qty)).toEqual(["1.000000", "2.500000"]);
    expect(rows.map((row) => row.total)).toEqual(["1.000000", "3.500000"]);
  });

  it("scales the depth bar against the deepest cumulative size", () => {
    const rows = bookLadder(levels, 3);
    expect(rows[0].depth).toBeCloseTo((1 / 4) * 100, 6);
    expect(rows[2].depth).toBe(100);
  });

  it("never returns more rows than the book holds, and copes with an empty side", () => {
    expect(bookLadder(levels, 10)).toHaveLength(3);
    expect(bookLadder([], 10)).toEqual([]);
    expect(bookLadder(levels, 0)).toEqual([]);
  });

  it("marks totals unknown rather than wrong when a size is malformed", () => {
    const rows = bookLadder([USD("100.00", "1.000000"), USD("99.00", "junk")], 2);
    expect(rows[0].total).toBe("1.000000");
    expect(rows[1].total).toBe("—");
  });
});

describe("trackSession", () => {
  it("opens the session on the first mid", () => {
    expect(trackSession({ open: null, high: null, low: null }, 65000)).toEqual({
      open: 65000,
      high: 65000,
      low: 65000,
    });
  });

  it("stretches extremes without moving the baseline", () => {
    const opened = { open: 65000, high: 65000, low: 65000 };
    expect(trackSession(opened, 65100)).toEqual({ open: 65000, high: 65100, low: 65000 });
    expect(trackSession(opened, 64900)).toEqual({ open: 65000, high: 65000, low: 64900 });
  });

  it("ignores a null mid", () => {
    const opened = { open: 65000, high: 65100, low: 64900 };
    expect(trackSession(opened, null)).toEqual(opened);
  });
});

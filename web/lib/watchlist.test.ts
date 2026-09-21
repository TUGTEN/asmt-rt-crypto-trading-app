import { describe, expect, it } from "vitest";

import {
  DEFAULT_ORDER,
  KNOWN_SYMBOLS,
  LIVE_SYMBOL,
  TEMP_SYMBOLS,
  WATCHLIST_ORDER_KEY,
  isTempSymbol,
  moveSymbol,
  normalizeOrder,
  parseStoredOrder,
  readStoredOrder,
  tempRefPrice,
  tempSymbolsValid,
  writeStoredOrder,
  type StorageLike,
} from "@/lib/watchlist";

/** In-memory storage stub: the list persists without a browser. */
function memoryStorage(entries: Record<string, string> = {}): StorageLike & { dump: () => Record<string, string> } {
  const backing = { ...entries };
  return {
    getItem: (key: string) => (key in backing ? backing[key] : null),
    setItem: (key: string, value: string) => {
      backing[key] = value;
    },
    dump: () => ({ ...backing }),
  };
}

describe("moveSymbol", () => {
  it("moves a row to its new index and shifts the rows between", () => {
    expect(moveSymbol(["A", "B", "C", "D"], 0, 2)).toEqual(["B", "C", "A", "D"]);
    expect(moveSymbol(["A", "B", "C", "D"], 3, 0)).toEqual(["D", "A", "B", "C"]);
    expect(moveSymbol(["A", "B"], 1, 1)).toEqual(["A", "B"]);
  });

  it("leaves the list alone when an index is out of range", () => {
    const order = ["A", "B"];
    expect(moveSymbol(order, -1, 0)).toEqual(["A", "B"]);
    expect(moveSymbol(order, 0, 5)).toEqual(["A", "B"]);
    expect(moveSymbol(order, 2, 0)).toEqual(["A", "B"]);
    expect(moveSymbol(order, 0, 0)).toEqual(["A", "B"]);
  });

  it("does not mutate the order it was given", () => {
    const order = ["A", "B", "C"];
    moveSymbol(order, 0, 2);
    expect(order).toEqual(["A", "B", "C"]);
  });
});

describe("normalizeOrder", () => {
  it("keeps the stored sequence for symbols still known", () => {
    const reversed = [...KNOWN_SYMBOLS].reverse();
    expect(normalizeOrder(reversed)).toEqual(reversed);
  });

  it("drops unknown and duplicated symbols, then appends the missing known ones", () => {
    expect(normalizeOrder(["SOL-USD", "NOPE-USD", "SOL-USD"])).toEqual([
      "SOL-USD",
      LIVE_SYMBOL,
      ...TEMP_SYMBOLS.filter((entry) => entry.symbol !== "SOL-USD").map((entry) => entry.symbol),
    ]);
  });

  it("starts from the default when nothing was stored", () => {
    expect(normalizeOrder([])).toEqual([...DEFAULT_ORDER]);
  });
});

describe("stored order", () => {
  it("round-trips through the storage key", () => {
    const storage = memoryStorage();
    const order = ["SOL-USD", LIVE_SYMBOL, "ETH-USD", "DOGE-USD"];
    writeStoredOrder(storage, order);
    expect(storage.dump()[WATCHLIST_ORDER_KEY]).toBe(JSON.stringify(order));
    expect(readStoredOrder(storage)).toEqual(order);
  });

  it("falls back to the default on garbage, and never throws on hostile storage", () => {
    expect(parseStoredOrder(null)).toEqual([...DEFAULT_ORDER]);
    expect(parseStoredOrder("BTC-USD")).toEqual([...DEFAULT_ORDER]);
    expect(parseStoredOrder([])).toEqual([...DEFAULT_ORDER]);
    expect(parseStoredOrder([1, null])).toEqual([...DEFAULT_ORDER]);

    const empty = memoryStorage();
    expect(readStoredOrder(empty)).toEqual([...DEFAULT_ORDER]);
    expect(readStoredOrder(null)).toEqual([...DEFAULT_ORDER]);

    const broken: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readStoredOrder(broken)).toEqual([...DEFAULT_ORDER]);
    expect(() => writeStoredOrder(broken, [...DEFAULT_ORDER])).not.toThrow();
    expect(() => writeStoredOrder(null, [...DEFAULT_ORDER])).not.toThrow();
  });
});

describe("temp symbols", () => {
  it("names one live symbol plus static references, live first", () => {
    expect(LIVE_SYMBOL).toBe("BTC-USD");
    expect(KNOWN_SYMBOLS[0]).toBe(LIVE_SYMBOL);
    expect(TEMP_SYMBOLS.length).toBeGreaterThan(0);
    expect(tempSymbolsValid()).toBe(true);
  });

  it("resolves static prices for temps and null for the live symbol", () => {
    expect(tempRefPrice("ETH-USD")).toBe("3512.44");
    expect(tempRefPrice(LIVE_SYMBOL)).toBeNull();
    expect(tempRefPrice("NOPE-USD")).toBeNull();
    expect(isTempSymbol("SOL-USD")).toBe(true);
    expect(isTempSymbol(LIVE_SYMBOL)).toBe(false);
    expect(isTempSymbol("NOPE-USD")).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { API_BASE_URL } from "@/lib/config";
import {
  INTERVALS,
  ProtocolError,
  describeError,
  fetchBackendConfig,
  fetchHistory,
  fetchSnapshot,
  isDecimalString,
  isInterval,
  parseBackendConfig,
  parseHistory,
  parseSnapshot,
  selectableIntervals,
} from "@/lib/protocol";

/**
 * A payload captured verbatim from `GET /api/snapshot` (PORT=8080 SEED=42).
 * Guards are tested against the real wire shape, not a hand-rolled ideal.
 */
const WIRE_SNAPSHOT = `{
  "seq": 72,
  "bids": [
    ["65164.44","0.032098"],
    ["65156.08","0.056093"]
  ],
  "asks": [
    ["65210.91","0.047913"],
    ["65227.12","0.060249"]
  ]
}`;

const WIRE_CONFIG = `{"symbol":"BTC-USD","intervals":["1s","1m"],"seed":42,"protocol":2}`;

/**
 * Also captured verbatim, from `GET /api/history?interval=1s&limit=2`. The live
 * bucket is not in it: a history request returns finished buckets only, which is
 * what lets the socket own the candle still forming.
 */
const WIRE_HISTORY = `{
  "interval": "1s",
  "candles": [
    ["2026-09-19T16:45:15Z","64956.77","64956.77","64924.30","64932.46","0.093013"],
    ["2026-09-19T16:45:16Z","64922.15","64983.52","64922.15","64954.69","0.140839"]
  ]
}`;

function unknownFrom(json: string): unknown {
  const parsed: unknown = JSON.parse(json);
  return parsed;
}

describe("parseSnapshot", () => {
  it("accepts the payload the backend actually serves", () => {
    const snapshot = parseSnapshot(unknownFrom(WIRE_SNAPSHOT));
    expect(snapshot.seq).toBe(72);
    expect(snapshot.bids).toHaveLength(2);
    expect(snapshot.asks[0]).toEqual({ price: "65210.91", qty: "0.047913" });
    // Prices and sizes survive as strings: nothing is coerced to a float here.
    expect(typeof snapshot.bids[0].price).toBe("string");
  });

  it("ignores extra fields so the backend can widen the payload", () => {
    expect(parseSnapshot({ seq: 1, bids: [], asks: [], ts: "2026-09-19T14:18:11Z" }).seq).toBe(1);
  });

  it("rejects a non-object payload", () => {
    for (const payload of [null, undefined, 42, "{}", ["seq"]]) {
      expect(() => parseSnapshot(payload)).toThrow(ProtocolError);
    }
  });

  it("rejects an ordering id that is not a safe integer", () => {
    expect(() => parseSnapshot({ seq: 1.5, bids: [], asks: [] })).toThrow(/snapshot\.seq/);
    expect(() => parseSnapshot({ seq: "1", bids: [], asks: [] })).toThrow(/snapshot\.seq/);
    expect(() => parseSnapshot({ seq: Number.MAX_SAFE_INTEGER + 2, bids: [], asks: [] })).toThrow(
      /snapshot\.seq/,
    );
  });

  it("rejects a missing side instead of quietly showing an empty book", () => {
    expect(() => parseSnapshot({ seq: 1, bids: [] })).toThrow(/snapshot\.asks/);
    expect(() => parseSnapshot({ seq: 1, asks: [] })).toThrow(/snapshot\.bids/);
  });

  it("rejects non-array sides and non-tuple levels", () => {
    expect(() => parseSnapshot({ seq: 1, bids: {}, asks: [] })).toThrow(/snapshot\.bids/);
    expect(() => parseSnapshot({ seq: 1, bids: ["65164.44"], asks: [] })).toThrow(
      /snapshot\.bids\[0\] is not a \[price, qty\] tuple/,
    );
    expect(() => parseSnapshot({ seq: 1, bids: [null], asks: [] })).toThrow(/snapshot\.bids\[0\]/);
    expect(() =>
      parseSnapshot({ seq: 1, bids: [{ price: "1.00", qty: "1.000000" }], asks: [] }),
    ).toThrow(/snapshot\.bids\[0\] is not a \[price, qty\] tuple/);
    expect(() =>
      parseSnapshot({ seq: 1, bids: [["1.00", "1.000000", "extra"], []], asks: [] }),
    ).toThrow(/snapshot\.bids\[0\] is not a \[price, qty\] tuple/);
  });

  it("refuses to coerce a numeric price or a null size into a string", () => {
    expect(() => parseSnapshot({ seq: 1, bids: [[65164.44, "1"]], asks: [] })).toThrow(
      /bids\[0\]\[0\] is not a decimal string/,
    );
    expect(() => parseSnapshot({ seq: 1, bids: [["65164.44", null]], asks: [] })).toThrow(
      /bids\[0\]\[1\] is not a decimal string/,
    );
  });

  it("rejects decimal shapes the format helpers could not render", () => {
    for (const price of ["", "abc", "1e3", "65164.", ".5", "65,164.44", "NaN", "Infinity"]) {
      expect(() => parseSnapshot({ seq: 1, bids: [[price, "1"]], asks: [] })).toThrow(
        ProtocolError,
      );
    }
    expect(isDecimalString("-0.000001")).toBe(true);
    expect(isDecimalString("65164.44")).toBe(true);
  });
});

describe("parseBackendConfig", () => {
  it("accepts the payload the backend actually serves", () => {
    expect(parseBackendConfig(unknownFrom(WIRE_CONFIG))).toEqual({
      symbol: "BTC-USD",
      intervals: ["1s", "1m"],
      seed: 42,
      protocol: 2,
    });
  });

  it("rejects a config missing symbol, seed, or intervals", () => {
    expect(() => parseBackendConfig({ intervals: ["1s"], seed: 1 })).toThrow(/config\.symbol/);
    expect(() => parseBackendConfig({ symbol: "BTC-USD", seed: 1 })).toThrow(/config\.intervals/);
    expect(() => parseBackendConfig({ symbol: "BTC-USD", intervals: ["1s"] })).toThrow(
      /config\.seed/,
    );
    expect(() => parseBackendConfig({ symbol: "BTC-USD", intervals: [], seed: NaN })).toThrow(
      /config\.seed/,
    );
    expect(() => parseBackendConfig({ symbol: "BTC-USD", intervals: [1], seed: 42 })).toThrow(
      /non-string/,
    );
  });

  it("rejects a backend that does not speak the v2 tuple wire", () => {
    expect(() =>
      parseBackendConfig({ symbol: "BTC-USD", intervals: ["1s"], seed: 42 }),
    ).toThrow(/config\.protocol is undefined, want 2/);
    expect(() =>
      parseBackendConfig({ symbol: "BTC-USD", intervals: ["1s"], seed: 42, protocol: 1 }),
    ).toThrow(/config\.protocol is 1, want 2/);
    expect(() =>
      parseBackendConfig({ symbol: "BTC-USD", intervals: ["1s"], seed: 42, protocol: "2" }),
    ).toThrow(/config\.protocol is "2", want 2/);
  });
});

describe("selectableIntervals", () => {
  it("offers what the backend advertises, restricted to intervals we understand", () => {
    expect(
      selectableIntervals({ symbol: "BTC-USD", intervals: ["1s", "1m"], seed: 42, protocol: 2 }),
    ).toEqual(["1s", "1m"]);
    expect(
      selectableIntervals({ symbol: "BTC-USD", intervals: ["5s", "1m"], seed: 42, protocol: 2 }),
    ).toEqual(["1m"]);
  });

  it("falls back to the settled set when the config is unknown or useless", () => {
    expect(selectableIntervals(null)).toEqual([...INTERVALS]);
    expect(
      selectableIntervals({ symbol: "BTC-USD", intervals: [], seed: 42, protocol: 2 }),
    ).toEqual([...INTERVALS]);
    expect(
      selectableIntervals({ symbol: "BTC-USD", intervals: ["5s"], seed: 42, protocol: 2 }),
    ).toEqual([...INTERVALS]);
  });

  it("recognises only the settled interval names", () => {
    expect(isInterval("1s")).toBe(true);
    expect(isInterval("1m")).toBe(true);
    expect(isInterval("1h")).toBe(false);
  });
});

describe("request behaviour", () => {
  const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function reply(body: unknown, init: ResponseInit = { status: 200 }): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), init);
  }

  it("fetches the snapshot from the env-configured base URL and parses it", async () => {
    fetchMock.mockResolvedValue(reply(WIRE_SNAPSHOT));
    const snapshot = await fetchSnapshot(new AbortController().signal);

    expect(snapshot.seq).toBe(72);
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE_URL}/api/snapshot`);
  });

  it("turns an HTTP error into a ProtocolError that names the status", async () => {
    fetchMock.mockResolvedValue(reply({ error: "boom" }, { status: 500, statusText: "Server Error" }));
    await expect(fetchSnapshot(new AbortController().signal)).rejects.toThrow(/500 Server Error/);
  });

  it("rejects a body that is not JSON rather than rendering an empty screen", async () => {
    fetchMock.mockResolvedValue(reply("<html>proxy</html>"));
    await expect(fetchSnapshot(new AbortController().signal)).rejects.toThrow(/did not return JSON/);
  });

  it("propagates a payload that violates the guards", async () => {
    fetchMock.mockResolvedValue(reply({ seq: 1, bids: "nope", asks: [] }));
    await expect(fetchSnapshot(new AbortController().signal)).rejects.toThrow(/snapshot\.bids/);
  });

  it("fetches backend config from /api/config", async () => {
    fetchMock.mockResolvedValue(reply(WIRE_CONFIG));
    const config = await fetchBackendConfig(new AbortController().signal);

    expect(config.symbol).toBe("BTC-USD");
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE_URL}/api/config`);
  });

  it("asks /api/history for the interval and the limit it wants", async () => {
    fetchMock.mockResolvedValue(reply(WIRE_HISTORY));
    const history = await fetchHistory("1s", 120, new AbortController().signal);

    expect(history.candles).toHaveLength(2);
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE_URL}/api/history?interval=1s&limit=120`);
  });

  it("aims every REST read at the chosen backend, not the build default", async () => {
    const backend = "https://tunnel.example.com";
    fetchMock.mockResolvedValue(reply(WIRE_SNAPSHOT));
    await fetchSnapshot(new AbortController().signal, backend);
    expect(fetchMock.mock.calls[0][0]).toBe(`${backend}/api/snapshot`);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(reply(WIRE_CONFIG));
    await fetchBackendConfig(new AbortController().signal, backend);
    expect(fetchMock.mock.calls[0][0]).toBe(`${backend}/api/config`);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(reply(WIRE_HISTORY));
    await fetchHistory("1s", 120, new AbortController().signal, backend);
    expect(fetchMock.mock.calls[0][0]).toBe(`${backend}/api/history?interval=1s&limit=120`);
  });

  it("refuses a limit the backend would answer with a 400, before asking", async () => {
    await expect(fetchHistory("1s", 0, new AbortController().signal)).rejects.toThrow(
      /not a positive integer/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a history response labelled with another interval", async () => {
    fetchMock.mockResolvedValue(reply(WIRE_HISTORY));
    await expect(fetchHistory("1m", 120, new AbortController().signal)).rejects.toThrow(
      /not the 1m/,
    );
  });
});

describe("parseHistory", () => {
  it("accepts the payload the backend actually serves", () => {
    const history = parseHistory(unknownFrom(WIRE_HISTORY), "1s");

    expect(history.interval).toBe("1s");
    expect(history.candles).toHaveLength(2);
    expect(history.candles[0]).toEqual({
      t: "2026-09-19T16:45:15Z",
      o: "64956.77",
      h: "64956.77",
      l: "64924.30",
      c: "64932.46",
      v: "0.093013",
    });
    // Strings end to end: the aggregation never works on floats.
    expect(typeof history.candles[1].v).toBe("string");
  });

  it("accepts an empty series, which is a state and not an error", () => {
    expect(parseHistory({ interval: "1m", candles: [] }, "1m").candles).toEqual([]);
  });

  it("rejects a response for another interval instead of letting it paint the chart", () => {
    expect(() => parseHistory(unknownFrom(WIRE_HISTORY), "1m")).toThrow(
      /history\.interval is 1s, not the 1m/,
    );
  });

  it("rejects a payload missing its interval or its candles", () => {
    expect(() => parseHistory({ candles: [] }, "1s")).toThrow(ProtocolError);
    expect(() => parseHistory({ interval: "5s", candles: [] }, "1s")).toThrow(ProtocolError);
    expect(() => parseHistory({ interval: "1s" }, "1s")).toThrow(/history\.candles/);
    expect(() => parseHistory([{ interval: "1s", candles: [] }], "1s")).toThrow(ProtocolError);
  });

  it("rejects a candle whose OHLCV is not a decimal string, naming it", () => {
    expect(() =>
      parseHistory({ interval: "1s", candles: [["2026-09-19T16:45:15Z", 64956.77]] }, "1s"),
    ).toThrow(/history\.candles\[0\] is not a \[t,o,h,l,c,v\] tuple/);
    expect(() =>
      parseHistory({ interval: "1s", candles: [["", "1", "1", "1", "1", "1"]] }, "1s"),
    ).toThrow(/history\.candles\[0\]\[0\] is not an ISO-8601 timestamp/);
    expect(() =>
      parseHistory(
        { interval: "1s", candles: [["2026-09-19T16:45:15Z", 64956.77, "1", "1", "1", "1"]] },
        "1s",
      ),
    ).toThrow(/history\.candles\[0\]\[1\] is not a decimal string/);
    expect(() => parseHistory({ interval: "1s", candles: ["65200.00"] }, "1s")).toThrow(
      /history\.candles\[0\] is not a \[t,o,h,l,c,v\] tuple/,
    );
    expect(() =>
      parseHistory(
        { interval: "1s", candles: [{ t: "2026-09-19T16:45:15Z", o: "1" }] },
        "1s",
      ),
    ).toThrow(/history\.candles\[0\] is not a \[t,o,h,l,c,v\] tuple/);
  });
});

describe("describeError", () => {
  it("says 'unreachable' when the backend is not listening, and passes messages through", () => {
    expect(describeError(new TypeError("Failed to fetch"))).toBe(
      "backend unreachable (is it running, and does it allow this origin?)",
    );
    expect(describeError(new ProtocolError("snapshot.bids is not an array"))).toBe(
      "snapshot.bids is not an array",
    );
    expect(describeError(new DOMException("timed out", "TimeoutError"))).toBe("request timed out");
    expect(describeError("string thrown")).toBe("unknown error");
  });
});

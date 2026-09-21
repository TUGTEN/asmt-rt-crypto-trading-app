import { describe, expect, it } from "vitest";

import {
  ProtocolError,
  buildWsUrl,
  parseServerFrame,
  serializeClientFrame,
} from "@/lib/protocol";

/**
 * The WebSocket half of docs/PROTOCOL.md, tested from *scripted raw text* —
 * exactly what `MessageEvent.data` hands the client. Nothing here touches a
 * socket: the point is that a frame is either understood or rejected, with no
 * third state and no thrown `TypeError` escaping into the feed.
 *
 * Protocol v2: market data rides as tagged tuples, the control plane
 * (`tier`, `pong`) stays named-key objects.
 */

/** Frames written out as they appear on the wire, one per PROTOCOL.md shape. */
const WIRE_TIER = `{"type":"tier","tier":"full","rate":4}`;
const WIRE_TRADE = `["trade",4097,"2026-09-19T14:18:11.042Z","65210.09","0.003100"]`;
const WIRE_BOOK = `["book",1042,1041,[["65164.44","0.032098"],["65156.08","0.056093"]],[["65210.91","0.047913"],["65227.12","0.060249"]]]`;
const WIRE_PONG = `{"type":"pong","tSend":1737000000000,"tRecv":"2026-09-19T14:18:11.012Z"}`;
const WIRE_CANDLE = `["candle","1s","2026-09-19T14:18:11Z","65200.00","65210.09","65199.10","65210.09","0.440000",false]`;

function unknownFrom(json: string): unknown {
  const parsed: unknown = JSON.parse(json);
  return parsed;
}

describe("parseServerFrame", () => {
  it("reads a JSON text message, the way the socket delivers it", () => {
    const frame = parseServerFrame(WIRE_TRADE);
    expect(frame).toEqual({
      type: "trade",
      seq: 4097,
      ts: "2026-09-19T14:18:11.042Z",
      price: "65210.09",
      qty: "0.003100",
    });
  });

  it("accepts the tier frame the backend sends on connect", () => {
    const frame = parseServerFrame(WIRE_TIER);
    expect(frame).toEqual({ type: "tier", tier: "full", rate: 4 });
  });

  it("accepts a book tuple and keeps prevSeq as the parent claim", () => {
    const frame = parseServerFrame(WIRE_BOOK);
    expect(frame).toMatchObject({ type: "book", seq: 1042, prevSeq: 1041 });
    if (frame.type !== "book") {
      throw new Error("expected a book frame");
    }
    expect(frame.bids[0]).toEqual({ price: "65164.44", qty: "0.032098" });
    // Prices stay strings: parsing the frame is not a licence to float them.
    expect(typeof frame.asks[0].price).toBe("string");
  });

  it("accepts a pong and a candle tuple, decimal strings and all", () => {
    expect(parseServerFrame(WIRE_PONG)).toEqual({
      type: "pong",
      tSend: 1737000000000,
      tRecv: "2026-09-19T14:18:11.012Z",
    });
    expect(parseServerFrame(WIRE_CANDLE)).toMatchObject({
      type: "candle",
      interval: "1s",
      complete: false,
    });
  });

  it("ignores extra fields on control frames so the backend can widen them additively", () => {
    const widened = unknownFrom(
      `{"type":"tier","tier":"full","rate":4,"source":"tracer"}`,
    );
    expect(parseServerFrame(widened)).toEqual({ type: "tier", tier: "full", rate: 4 });
  });

  it("rejects market frames in the old named-key shape: positions are the contract now", () => {
    const side = [["1.00", "1.000000"]];
    expect(() =>
      parseServerFrame({ type: "trade", seq: 1, ts: "2026-09-19T14:18:11Z", price: "1.00", qty: "1.000000" }),
    ).toThrow(/v2 tuple wire/);
    expect(() => parseServerFrame({ type: "book", seq: 5, prevSeq: 4, bids: side, asks: side })).toThrow(
      /v2 tuple wire/,
    );
    expect(() =>
      parseServerFrame({
        type: "candle",
        interval: "1s",
        t: "2026-09-19T14:18:11Z",
        o: "1.00",
        h: "1.00",
        l: "1.00",
        c: "1.00",
        v: "1.000000",
        complete: false,
      }),
    ).toThrow(/v2 tuple wire/);
  });

  it("keeps a genesis prevSeq of 0 as the parent claim, and rejects a null one", () => {
    const side = [["1.00", "1.000000"]];
    expect(parseServerFrame(["book", 1, 0, side, side])).toMatchObject({
      type: "book",
      seq: 1,
      prevSeq: 0,
    });
    expect(() => parseServerFrame(["book", 5, null, side, side])).toThrow(ProtocolError);
  });

  it("rejects text that is not JSON", () => {
    for (const garbage of ["", "not json", "{\"type\":", "<html>", "[1,2"]) {
      expect(() => parseServerFrame(garbage)).toThrow(ProtocolError);
    }
  });

  it("rejects payloads that are not frames", () => {
    for (const payload of [
      null,
      undefined,
      42,
      true,
      ["trade"],
      ["nope", 1, 2],
      [],
      {},
      { type: 7 },
      { type: "nope" },
    ]) {
      expect(() => parseServerFrame(payload)).toThrow(ProtocolError);
    }
  });

  it("rejects a trade with a broken id, timestamp, price, or size", () => {
    const ts = "2026-09-19T14:18:11Z";
    const broken: unknown[][] = [
      ["trade", 1.5, ts, "1.00", "1.000000"],
      ["trade", "1", ts, "1.00", "1.000000"],
      ["trade", -1, ts, "1.00", "1.000000"],
      ["trade", Number.MAX_SAFE_INTEGER + 2, ts, "1.00", "1.000000"],
      ["trade", 1, "", "1.00", "1.000000"],
      ["trade", 1, "yesterday", "1.00", "1.000000"],
      ["trade", 1, 1737000000, "1.00", "1.000000"],
      ["trade", 1, ts, 65210.09, "1.000000"],
      ["trade", 1, ts, "6.5e4", "1.000000"],
      ["trade", 1, ts, "", "1.000000"],
      ["trade", 1, ts, "1.00", null],
      ["trade", 1, ts, "1.00", "abc"],
      ["trade", 1, ts, "1.00"],
      ["trade", 1, ts, "1.00", "1.000000", "extra"],
    ];
    for (const payload of broken) {
      expect(() => parseServerFrame(payload)).toThrow(ProtocolError);
    }
  });

  it("rejects a book tuple with a broken id pair or a broken side", () => {
    const level: unknown[] = ["1.00", "1.000000"];
    const good = (): unknown[] => ["book", 2, 1, [level], [["2.00", "2.000000"]]];
    const broken: unknown[][] = [
      ["book", "2", 1, [level], [level]],
      ["book", 2, -1, [level], [level]],
      ["book", 2, 1.5, [level], [level]],
      ["book", 2, "1", [level], [level]],
      ["book", 2, 1, {}, [level]],
      ["book", 2, 1, [level], "nope"],
      ["book", 2, 1, [[1, "1"]], [level]],
      ["book", 2, 1, [null], [level]],
      ["book", 2, 1, [["1.00"]], [level]],
      ["book", 2, 1, [level], [{ price: "1.00", qty: "1.000000" }]],
      ["book", 2, 1, [level]],
      ["book", 2, 1, [level], [level], "extra"],
    ];
    expect(parseServerFrame(good())).toMatchObject({ type: "book", seq: 2, prevSeq: 1 });
    for (const payload of broken) {
      expect(() => parseServerFrame(payload)).toThrow(ProtocolError);
    }
  });

  it("rejects empty sides: an empty book is not a book (SEAMS Slice B)", () => {
    const level: unknown[] = ["1.00", "1.000000"];
    const sides: [unknown, unknown][] = [
      [[], []],
      [[], [level]],
      [[level], []],
    ];
    for (const [bids, asks] of sides) {
      expect(() => parseServerFrame(["book", 2, 1, bids, asks])).toThrow(ProtocolError);
    }
  });

  it("rejects a tier frame with an unknown tier or a broken rate", () => {
    for (const payload of [
      { type: "tier", tier: "fast", rate: 4 },
      { type: "tier", rate: 4 },
      { type: "tier", tier: "full" },
      { type: "tier", tier: "full", rate: "4" },
      { type: "tier", tier: "full", rate: -1 },
      { type: "tier", tier: "full", rate: Number.NaN },
    ]) {
      expect(() => parseServerFrame(payload)).toThrow(ProtocolError);
    }
  });

  it("rejects a pong that echoes no usable send stamp", () => {
    for (const payload of [
      { type: "pong", tRecv: "2026-09-19T14:18:11Z" },
      { type: "pong", tSend: 1 },
      { type: "pong", tSend: "1", tRecv: "2026-09-19T14:18:11Z" },
      { type: "pong", tSend: 1, tRecv: "" },
      { type: "pong", tSend: 1, tRecv: 1737000000000 },
    ]) {
      expect(() => parseServerFrame(payload)).toThrow(ProtocolError);
    }
  });

  it("rejects a candle with an interval this client cannot render", () => {
    for (const payload of [
      ["candle", "1h", "x", "1", "1", "1", "1", "1", false],
      ["candle", "1s", "x", "1", "1", "1", "1", "1"],
      ["candle", "1s", "", "1", "1", "1", "1", "1", false],
      ["candle", "1s", "x", "1", "1", "1", "1", "1", "no"],
      ["candle", "1s", "x", 1, "1", "1", "1", "1", false],
    ]) {
      expect(() => parseServerFrame(payload)).toThrow(ProtocolError);
    }
  });

  it("names what was wrong, so a dropped frame is diagnosable", () => {
    expect(() => parseServerFrame(["book", "2", 1, [], []])).toThrow(/book\[1\]/);
    expect(() => parseServerFrame(["trade", 1, "2026-09-19T14:18:11Z", "x", "1"])).toThrow(
      /trade\[3\]/,
    );
  });
});

describe("buildWsUrl", () => {
  it("replaces the scheme and names the topics and interval", () => {
    expect(buildWsUrl("http://localhost:8080", { topics: ["book", "trades"], interval: "1s" })).toBe(
      "ws://localhost:8080/ws?topics=book,trades&interval=1s",
    );
  });

  it("uses wss over https and tolerates a trailing slash", () => {
    expect(buildWsUrl("https://api.example.com/", { topics: ["book"], interval: "1m" })).toBe(
      "wss://api.example.com/ws?topics=book&interval=1m",
    );
  });

  it("omits topics when none are requested (PROTOCOL's default is all)", () => {
    expect(buildWsUrl("http://localhost:8080", { topics: [], interval: "1s" })).toBe(
      "ws://localhost:8080/ws?interval=1s",
    );
  });

  it("refuses a base URL it cannot turn into a socket, and an unknown interval", () => {
    expect(() => buildWsUrl("localhost:8080", { topics: ["book"], interval: "1s" })).toThrow(
      ProtocolError,
    );
    expect(() => buildWsUrl("ftp://localhost:8080", { topics: ["book"], interval: "1s" })).toThrow(
      ProtocolError,
    );
    expect(() => buildWsUrl("http://localhost:8080", { topics: ["book"], interval: "5s" })).toThrow(
      /interval/,
    );
  });
});

describe("serializeClientFrame", () => {
  it("writes the ping the backend echoes back", () => {
    expect(serializeClientFrame({ type: "ping", tSend: 1737000000000 })).toBe(
      '{"type":"ping","tSend":1737000000000}',
    );
  });

  it("writes the latency report that drives tiering", () => {
    expect(serializeClientFrame({ type: "report", latencyMs: 12.3, jitterMs: 4.1 })).toBe(
      '{"type":"report","latencyMs":12.3,"jitterMs":4.1}',
    );
  });

  it("writes the debug override, including the null that clears it", () => {
    expect(serializeClientFrame({ type: "force", tier: "degraded" })).toBe(
      '{"type":"force","tier":"degraded"}',
    );
    expect(serializeClientFrame({ type: "force", tier: null })).toBe('{"type":"force","tier":null}');
  });
});

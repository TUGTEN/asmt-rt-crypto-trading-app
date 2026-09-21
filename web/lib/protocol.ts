/**
 * The wire protocol, in one place (protocol v2: compact tuples).
 *
 * Endpoints served by the backend (base URL from `NEXT_PUBLIC_API_URL`).
 * `docs/PROTOCOL.md` is the source of truth; this module mirrors its REST half.
 *
 *   GET  /api/config                      -> { symbol, intervals, seed, protocol: 2 }
 *   GET  /api/snapshot                    -> { seq, bids[[p,q]×10], asks }
 *   GET  /api/history?interval=&limit=    -> { interval, candles[[t,o,h,l,c,v]] }
 *   GET  /ws?topics=book,trades,chart     -> tier/trade/book/candle
 *
 * Market data crosses as positional tuples — `[\"trade\",seq,ts,price,qty]`,
 * `[\"book\",seq,prevSeq,bids,asks]`, `[\"candle\",interval,t,o,h,l,c,v,complete]`,
 * levels as `[price,qty]`, history candles as `[t,o,h,l,c,v]` — while the
 * control plane (`tier`, `pong`, client frames) and REST envelopes stay named-key
 * objects. Money stays decimal *strings* inside the tuples; only key names were
 * dropped, never the string encoding.
 *
 * Every payload crosses the boundary as `unknown` and is narrowed by a guard
 * before any component sees it: there are no `any` casts and no `as Snapshot`
 * assertions on the wire path. Prices and quantities stay decimal *strings*
 * end to end; they are only turned into numbers by `lib/format.ts`, and only
 * for display. The internal models (`Level`, `Candle`, `Trade`, `*Frame`) keep
 * named fields — only the JSON is positional.
 *
 * The WebSocket half lives here too: server frames are read by
 * `parseServerFrame` (which accepts the raw text a `MessageEvent` carries) and
 * client frames are written by `serializeClientFrame`, so every byte in both
 * directions is named in one file. A frame is either understood or rejected
 * with a `ProtocolError` that names the offending position — never a `TypeError`
 * from a bad `JSON.parse` or a half-built object.
 *
 * This module is deliberately React-free: `lib/ws-client.ts` drives the socket
 * and pushes into stores; both reuse these types, guards, and helpers.
 */

import { API_BASE_URL, REQUEST_TIMEOUT_MS } from "@/lib/config";
import { isDecimalString, type DecimalString } from "@/lib/decimal";

/** Intervals settled in CONTEXT.md; backend config may only offer a subset. */
export const INTERVALS = ["1s", "1m"] as const;

export type Interval = (typeof INTERVALS)[number];

export function isInterval(value: string): value is Interval {
  return (INTERVALS as readonly string[]).includes(value);
}

/** One price level of the book. `price` and `qty` are decimal strings. */
export type Level = { price: DecimalString; qty: DecimalString };

/** Point-in-time copy of the book: `seq` is the ordering id to trust. */
export type Snapshot = { seq: number; bids: Level[]; asks: Level[] };

export type BackendConfig = {
  symbol: string;
  /** Interval names advertised by the backend, e.g. `["1s", "1m"]`. */
  intervals: string[];
  seed: number;
  /** Wire version this client speaks: 2 = compact tuples (PROTOCOL.md). */
  protocol: number;
};

/** Thrown when a payload does not match the protocol, or a request fails. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/**
 * Quantities arrive with 6 decimals, prices with 2 (backend `q2s`/`p2s`).
 *
 * The guard itself lives in `lib/decimal.ts` — the one home for the wire's
 * decimal shape — and is re-exported here so the wire path keeps one surface.
 */
export { isDecimalString } from "@/lib/decimal";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One wire level: the `[price, qty]` tuple (protocol v2). Positions are the
 * contract — `[0]` is the price, `[1]` the size, both decimal strings.
 */
function parseLevel(value: unknown, where: string): Level {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new ProtocolError(`${where} is not a [price, qty] tuple`);
  }
  const [price, qty] = value;
  if (!isDecimalString(price)) {
    throw new ProtocolError(`${where}[0] is not a decimal string`);
  }
  if (!isDecimalString(qty)) {
    throw new ProtocolError(`${where}[1] is not a decimal string`);
  }
  return { price, qty };
}

function parseLevels(value: unknown, where: string): Level[] {
  if (!Array.isArray(value)) {
    throw new ProtocolError(`${where} is not an array`);
  }
  return value.map((entry, index) => parseLevel(entry, `${where}[${index}]`));
}

export function parseSnapshot(payload: unknown): Snapshot {
  if (!isRecord(payload)) {
    throw new ProtocolError("snapshot is not an object");
  }
  const { seq, bids, asks } = payload;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq)) {
    throw new ProtocolError("snapshot.seq is not an integer");
  }
  return {
    seq,
    bids: parseLevels(bids, "snapshot.bids"),
    asks: parseLevels(asks, "snapshot.asks"),
  };
}

/*
 * ---------------------------------------------------------------------------
 * WebSocket frames (docs/PROTOCOL.md)
 * ---------------------------------------------------------------------------
 */

/** Delivery tiers the backend owns; the client only renders the decision. */
export const TIERS = ["full", "degraded", "minimal"] as const;

export type Tier = (typeof TIERS)[number];

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

/** One market event: `seq` orders it, the rest describes it. */
export type Trade = { seq: number; ts: string; price: DecimalString; qty: DecimalString };

/**
 * A book frame is a *full* 10×10 image, not a diff (the tracer in
 * docs/PROTOCOL.md), so merging is a replacement — the ids are what make the
 * replacement safe: `prevSeq` is this frame's claim about its parent.
 * `prevSeq: null` means "no parent claim", which can never be chained onto a
 * book and therefore forces a snapshot.
 */
export type BookFrame = {
  type: "book";
  seq: number;
  prevSeq: number | null;
  bids: Level[];
  asks: Level[];
};

export type TradeFrame = Trade & { type: "trade" };

export type TierFrame = { type: "tier"; tier: Tier; rate: number };

export type PongFrame = { type: "pong"; tSend: number; tRecv: string };

export type CandleFrame = {
  type: "candle";
  interval: Interval;
  t: string;
  o: DecimalString;
  h: DecimalString;
  l: DecimalString;
  c: DecimalString;
  v: DecimalString;
  complete: boolean;
};

export type ServerFrame = TradeFrame | BookFrame | TierFrame | PongFrame | CandleFrame;

/**
 * One candle without its frame envelope: `{t,o,h,l,c,v}`, decimal strings.
 *
 * Both doors onto the market carry this shape — a `candle` frame on the socket
 * and an entry of `GET /api/history` — so the client has one candle type, and
 * the chart's series is built from the same values whichever door it arrived
 * through (`docs/SEAMS.md` Slice C).
 */
export type Candle = Omit<CandleFrame, "type" | "interval" | "complete">;

/** The `GET /api/history` payload: the interval it answers for, oldest-first. */
export type History = { interval: Interval; candles: Candle[] };

/** The frames this client is allowed to send (PROTOCOL "Client → server"). */
export type ClientFrame =
  | { type: "ping"; tSend: number }
  | { type: "report"; latencyMs: number; jitterMs: number }
  | { type: "force"; tier: Tier | null };

/** Ordering ids and echoed client stamps are non-negative safe integers. */
function parseCount(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolError(`${where} is not a non-negative integer`);
  }
  return value;
}

/**
 * Timestamps are UTC ISO-8601 (`time.RFC3339Nano`). An unparseable one is
 * rejected rather than rendered: a tape entry dated `""` is worse than a
 * dropped frame.
 */
function parseTimestamp(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0 || Number.isNaN(Date.parse(value))) {
    throw new ProtocolError(`${where} is not an ISO-8601 timestamp`);
  }
  return value;
}

/**
 * A book *side*: an array of decimal-string levels, and never empty. The tracer
 * always ships 10×10, so an empty side means the frame is broken — showing an
 * empty ladder would silently pass that breakage off as an empty book.
 */
function parseBookSide(value: unknown, where: string): Level[] {
  const levels = parseLevels(value, where);
  if (levels.length === 0) {
    throw new ProtocolError(`${where} is empty`);
  }
  return levels;
}

/**
 * One wire candle: the `[t,o,h,l,c,v]` tuple (protocol v2), shared by the
 * `candle` frame and a history entry — one reader means the two doors cannot
 * disagree about what a candle is. Positions `[1..5]` are OHLCV decimal strings.
 */
function parseCandleFields(value: unknown, where: string): Candle {
  if (!Array.isArray(value) || value.length !== 6) {
    throw new ProtocolError(`${where} is not a [t,o,h,l,c,v] tuple`);
  }
  const [t, o, h, l, c, v] = value;
  return {
    t: parseTimestamp(t, `${where}[0]`),
    o: requireDecimal(o, `${where}[1]`),
    h: requireDecimal(h, `${where}[2]`),
    l: requireDecimal(l, `${where}[3]`),
    c: requireDecimal(c, `${where}[4]`),
    v: requireDecimal(v, `${where}[5]`),
  };
}

/** `trade` tuple positions `[1..4]`: seq, ts, price, qty. */
function parseTradeTuple(tuple: unknown[], where: string): Trade {
  if (tuple.length !== 5) {
    throw new ProtocolError(`${where} has ${tuple.length} entries, want 5 [tag,seq,ts,price,qty]`);
  }
  const [, seq, ts, price, qty] = tuple;
  return {
    seq: parseCount(seq, `${where}[1]`),
    ts: parseTimestamp(ts, `${where}[2]`),
    price: requireDecimal(price, `${where}[3]`),
    qty: requireDecimal(qty, `${where}[4]`),
  };
}

function requireDecimal(value: unknown, where: string): DecimalString {
  if (!isDecimalString(value)) {
    throw new ProtocolError(`${where} is not a decimal string`);
  }
  return value;
}

/**
 * Narrow one server frame.
 *
 * `payload` is either the parsed JSON value or the raw text message itself —
 * a socket hands the client text, and JSON that fails to parse is just another
 * malformed frame. Market data arrives as tagged tuples (protocol v2); the
 * control plane (`tier`, `pong`) stays named-key objects whose extra fields are
 * ignored, so the backend may widen a control frame additively without a
 * client release. Tuple positions are versioned by `GET /api/config`
 * `"protocol"` instead — a market frame in the old object shape is rejected
 * with a migration error, never silently accepted.
 */
export function parseServerFrame(payload: unknown): ServerFrame {
  let value: unknown = payload;
  if (typeof payload === "string") {
    try {
      value = JSON.parse(payload) as unknown;
    } catch {
      throw new ProtocolError("frame is not JSON");
    }
  }
  if (Array.isArray(value)) {
    const [tag] = value;
    switch (tag) {
      case "trade":
        return { type: "trade", ...parseTradeTuple(value, "trade") };
      case "book": {
        if (value.length !== 5) {
          throw new ProtocolError(
            `book tuple has ${value.length} entries, want 5 [tag,seq,prevSeq,bids,asks]`,
          );
        }
        const [, seq, prevSeq, bids, asks] = value;
        return {
          type: "book",
          seq: parseCount(seq, "book[1]"),
          prevSeq: parseCount(prevSeq, "book[2]"),
          bids: parseBookSide(bids, "book[3]"),
          asks: parseBookSide(asks, "book[4]"),
        };
      }
      case "candle": {
        if (value.length !== 9) {
          throw new ProtocolError(
            `candle tuple has ${value.length} entries, want 9 [tag,interval,t,o,h,l,c,v,complete]`,
          );
        }
        const interval = value[1];
        if (typeof interval !== "string" || !isInterval(interval)) {
          throw new ProtocolError("candle[1] is not an interval this client renders");
        }
        const complete = value[8];
        if (typeof complete !== "boolean") {
          throw new ProtocolError("candle[8] is not a boolean");
        }
        return { type: "candle", interval, ...parseCandleFields(value.slice(2, 8), "candle"), complete };
      }
      default:
        throw new ProtocolError(`unknown frame tag ${JSON.stringify(tag)}`);
    }
  }
  if (!isRecord(value)) {
    throw new ProtocolError("frame is not an object or tuple");
  }
  const type = value.type;
  switch (type) {
    case "tier": {
      if (!isTier(value.tier)) {
        throw new ProtocolError("tier.tier is not full|degraded|minimal");
      }
      const rate = value.rate;
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
        throw new ProtocolError("tier.rate is not a non-negative number");
      }
      return { type, tier: value.tier, rate };
    }
    case "pong":
      return {
        type,
        tSend: parseCount(value.tSend, "pong.tSend"),
        tRecv: parseTimestamp(value.tRecv, "pong.tRecv"),
      };
    case "trade":
    case "book":
    case "candle":
      throw new ProtocolError(
        `${String(type)} frame arrived as named keys: this client speaks the v2 tuple wire`,
      );
    default:
      throw new ProtocolError(`unknown frame type ${JSON.stringify(type)}`);
  }
}

/**
 * Write one client frame as the exact JSON text to put on the socket.
 *
 * Key order is fixed by these literals so a test (or a recording) can assert
 * the outgoing bytes, and so the frames read the same every time.
 */
export function serializeClientFrame(frame: ClientFrame): string {
  switch (frame.type) {
    case "ping":
      return JSON.stringify({ type: "ping", tSend: frame.tSend });
    case "report":
      return JSON.stringify({
        type: "report",
        latencyMs: frame.latencyMs,
        jitterMs: frame.jitterMs,
      });
    case "force":
      return JSON.stringify({ type: "force", tier: frame.tier });
  }
}

/**
 * Build the socket URL from the REST base URL: same host and port, `ws:`/`wss:`
 * in place of `http:`/`https:`, topics and chart interval as query params.
 *
 * An empty topic list omits the param entirely, which PROTOCOL.md defines as
 * "all topics" — the client never guesses a subset it did not ask for.
 */
export function buildWsUrl(
  baseUrl: string,
  options: { topics: string[]; interval: string },
): string {
  if (!isInterval(options.interval)) {
    throw new ProtocolError(`interval ${JSON.stringify(options.interval)} is not 1s|1m`);
  }
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new ProtocolError(`API base URL ${JSON.stringify(baseUrl)} is not a URL`);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new ProtocolError(`API base URL scheme ${base.protocol} is not http(s)`);
  }
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/ws`;
  // Built as text rather than with URLSearchParams: PROTOCOL.md writes
  // `topics=book,trades`, URLSearchParams would percent-encode the comma to
  // `%2C`, and an unreadable URL in devtools and in the recording costs more
  // than the encoding buys. Both sides decode the same value either way.
  const query = options.topics.length > 0 ? [`topics=${options.topics.join(",")}`] : [];
  query.push(`interval=${options.interval}`);
  base.search = query.join("&");
  return base.toString();
}

export function parseBackendConfig(payload: unknown): BackendConfig {
  if (!isRecord(payload)) {
    throw new ProtocolError("config is not an object");
  }
  const { symbol, intervals, seed, protocol } = payload;
  if (typeof symbol !== "string" || symbol.length === 0) {
    throw new ProtocolError("config.symbol is not a string");
  }
  if (typeof seed !== "number" || !Number.isFinite(seed)) {
    throw new ProtocolError("config.seed is not a number");
  }
  // The tuple wire is a breaking change, checked last so a payload missing the
  // older fields still blames them first: a backend that does not announce
  // protocol 2 is speaking named keys this client no longer reads.
  if (!Array.isArray(intervals)) {
    throw new ProtocolError("config.intervals is not an array");
  }
  const names: string[] = [];
  for (const entry of intervals) {
    if (typeof entry !== "string") {
      throw new ProtocolError("config.intervals contains a non-string");
    }
    names.push(entry);
  }
  if (protocol !== 2) {
    throw new ProtocolError(
      `config.protocol is ${JSON.stringify(protocol)}, want 2 (the tuple wire)`,
    );
  }
  return { symbol, intervals: names, seed, protocol };
}

/**
 * Intervals the UI can offer: what the backend advertises, restricted to the
 * ones this client understands, falling back to the settled set.
 */
export function selectableIntervals(config: BackendConfig | null): Interval[] {
  const known = (config?.intervals ?? []).filter(isInterval);
  return known.length > 0 ? known : [...INTERVALS];
}

async function getJson(baseUrl: string, path: string, signal: AbortSignal): Promise<unknown> {
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.any([signal, deadline]),
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    const status = `${response.status} ${response.statusText}`.trim();
    throw new ProtocolError(`${path} responded ${status}`);
  }
  try {
    const payload: unknown = await response.json();
    return payload;
  } catch {
    throw new ProtocolError(`${path} did not return JSON`);
  }
}

export async function fetchSnapshot(signal: AbortSignal, baseUrl: string = API_BASE_URL): Promise<Snapshot> {
  return parseSnapshot(await getJson(baseUrl, "/api/snapshot", signal));
}

export async function fetchBackendConfig(signal: AbortSignal, baseUrl: string = API_BASE_URL): Promise<BackendConfig> {
  return parseBackendConfig(await getJson(baseUrl, "/api/config", signal));
}

/**
 * Read one `/api/history` payload, insisting it answers the interval we asked
 * for.
 *
 * `expected` is the ghost-candle guard at the earliest boundary there is: a
 * response that comes back labelled `1m` to a `1s` request is rejected here,
 * before any store or chart sees it, rather than being painted onto a chart
 * that is now showing something else.
 */
export function parseHistory(payload: unknown, expected: Interval): History {
  if (!isRecord(payload)) {
    throw new ProtocolError("history is not an object");
  }
  const { interval, candles } = payload;
  if (typeof interval !== "string" || !isInterval(interval)) {
    throw new ProtocolError("history.interval is not 1s|1m");
  }
  if (interval !== expected) {
    throw new ProtocolError(
      `history.interval is ${interval}, not the ${expected} this request was for`,
    );
  }
  if (!Array.isArray(candles)) {
    throw new ProtocolError("history.candles is not an array");
  }
  return {
    interval,
    candles: candles.map((entry, index) => parseCandleFields(entry, `history.candles[${index}]`)),
  };
}

/**
 * The candles a chart opens on: everything finished before now, oldest first.
 * The backend withholds the bucket still forming — that one arrives live over
 * the socket — so this request and the socket never overlap.
 */
export async function fetchHistory(interval: Interval, limit: number, signal: AbortSignal, baseUrl: string = API_BASE_URL): Promise<History> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new ProtocolError(`history limit ${limit} is not a positive integer`);
  }
  return parseHistory(
    await getJson(baseUrl, `/api/history?interval=${interval}&limit=${limit}`, signal),
    interval,
  );
}

/** Narrow an unknown failure into one honest line for the status panel. */
export function describeError(error: unknown): string {
  if (error instanceof ProtocolError) {
    return error.message;
  }
  if (error instanceof DOMException) {
    return error.name === "TimeoutError" ? "request timed out" : error.message;
  }
  if (error instanceof TypeError) {
    return "backend unreachable (is it running, and does it allow this origin?)";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "unknown error";
}

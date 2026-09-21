/**
 * Only the backend URL is env-based on this side: `NEXT_PUBLIC_API_URL` is
 * inlined at build time. The code default is the live API
 * (`https://pf-api.0kv.in`, NixOS + Cloudflare tunnel); local work overrides
 * it back to `http://localhost:8080` via the env var or the Backend panel.
 * The symbol, the intervals, and the seed are *backend-owned*
 * configuration — the UI reads them from `GET /api/config` instead of
 * duplicating them in code.
 */

export const DEFAULT_API_BASE_URL = "https://pf-api.0kv.in";
/** Trailing slashes would produce `//api/...`; normalise once. */
export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_API_BASE_URL
).replace(/\/+$/, "");

/**
 * A hung request must not stall recovery and leave the screen claiming to be
 * live, so every request carries its own deadline.
 */
export const REQUEST_TIMEOUT_MS = 4000;

/** The book depth the backend serves (and the screen must render). */
export const BOOK_DEPTH = 10;

/*
 * Bullet 1 (T2) timings and bounds. Every number here is a defensible default
 * rather than a physical constant: the README will say what each one buys.
 */

/** How often the client pings. The protocol fixes this at 2s. */
export const PING_INTERVAL_MS = 2000;

/**
 * Silence that convicts an open socket: the market session's book and tape
 * arrive at a few Hz in every tier, so seconds without a frame on a socket that
 * never closed is a dead connection (a WiFi switch strands TCP half-open),
 * not a quiet market. Until a close frame or this age says otherwise, the
 * screen would present cached values as live.
 */
export const FRAME_STALE_AFTER_MS = 5000;
/** How often the frame-age watchdog above runs — granular next to the 5s bar. */
export const FRAME_STALE_CHECK_MS = 1000;
/**
 * Reconnect backoff: first retry after this, doubling up to the cap. A dead
 * backend should not be hammered, and a backend that comes back should be
 * picked up within seconds.
 */
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 8000;

/** A failed recovery snapshot is retried after this long. */
export const SNAPSHOT_RETRY_MS = 750;

/**
 * Gaps healed by refetching back to back before the client slows down: each
 * immediate refetch is a fresh snapshot plus the frames in flight, so this is a
 * circuit breaker for a feed that keeps disagreeing with the book, not the
 * normal recovery path (which is a single refetch). The first frame that chains
 * resets it (`lib/ws-client.ts`).
 */
export const MAX_RESYNC_ATTEMPTS = 5;

/**
 * Book frames held while a recovery snapshot is in flight. The feed runs at a
 * few Hz, so this is tens of seconds of buffer; past it the oldest frames are
 * dropped, which the merge reports as a gap rather than guessing.
 */
export const BOOK_BUFFER_LIMIT = 64;

/** Trades kept in the tape (the panel shows the newest first). */
export const TRADE_TAPE_SIZE = 30;

/**
 * Jitter is an EMA of |RTT − prevRTT| (docs/PROTOCOL.md) so one spike decays
 * over a few probes instead of dominating the report that drives tiering.
 */
export const JITTER_EMA_ALPHA = 0.5;

/**
 * A round trip slower than this is a frozen tab or a stalled connection, not a
 * measurement: believing it would report latency the backend would tier on.
 */
export const MAX_RTT_MS = 60_000;

/** The chart topic's interval when nothing has been selected yet (1s, the shortest). */
export const DEFAULT_INTERVAL = "1s";

/** Topics of the market session: the book and the tape. Redialed only on drop. */
export const MARKET_TOPICS = ["book", "trades"];
/** Topics of the chart session: the candle series. Redialed on interval switch. */
export const CHART_TOPICS = ["chart"];

/**
 * How many finished candles `/api/history` is asked for — the same number the
 * backend serves by default (`api/main.go`). At 1s that is two minutes of price
 * action, at 1m two hours: enough that the chart opens with context, small
 * enough that the whole series is one cheap response.
 */
export const HISTORY_LIMIT = 120;

/**
 * A failed history read is retried after this long. The chart is often open
 * before the backend is (the same reason `useBackendConfig` retries), and a
 * series that never heals after a blip would look like an empty market.
 */
export const HISTORY_RETRY_MS = 3000;

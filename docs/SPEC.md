# Spec — Real-Time Cryptocurrency Trading Web App

## Problem Statement

Pitchfork is a polished real-time crypto trading demo: one simulated BTC-USD market with live
candles, a self-healing order book, and per-client adaptive delivery that
stays correct when a connection degrades. It ships as a
public repo plus a deployed URL plus a screen recording, with every part
explainable and modifiable in a technical walkthrough.

## Solution

Build the app as a sequence of tracer bullets: each bullet is a thin
end-to-end slice (seeded backend → protocol → screen) that is demoable on
its own and stays green as later bullets widen it. By the last bullet the
slices have grown into the full demo — live adaptive chart, healing
book, trusted history, tests, README, recording, URL.

## User Stories

1. As a viewer, I want to open one URL and see the trading screen with no
   setup, so that I can evaluate the app in seconds.
2. As a viewer, I want to see the symbol's latest price and its movement
   (up/down vs previous), so that the market feels alive at a glance.
3. As a viewer, I want a candlestick chart of the market, so that I can read
   price action visually.
4. As a viewer, I want to switch between 1s and 1m candle intervals, so that
   I can see both microstructure and trend.
5. As a viewer, I want history to load first and the active candle to keep
   updating live, so that there is never a dead chart.
6. As a viewer, I want to hover, click, or drag on a candle and read its
   timestamp plus OHLCV values, so that I can inspect what I see.
7. As a viewer, I want to see the top 10 bids and asks from a locally
   maintained book, so that I trust the depth display.
8. As a viewer, I want to see recent trades streaming, so that I can connect
   chart moves to market activity.
9. As a viewer, I want a clear connection status (live vs stale), so that I
   never mistake cached values for live ones.
   Settled: the always-visible minimal signals (header live/cached/syncing line,
   book notice, tape dim) carry this story alone; the full Connection panel
   (status dot, frame age, seq, gaps) stays debug-gated as extra detail.
10. As a viewer, I want the app to stay smooth while updates arrive several
    times per second, so that scrolling and chart gestures never jank.
   Settled: receive fast, paint slow — the navbar paint toggle paints one batch
   per 500ms window (`smooth`) or every frame (`full`, the default). Ingestion
   stays FIFO so the book chain and finished candles are identical either way.
11. As a viewer, I want the active delivery tier and effective update rate
    shown on screen, so that adaptive behavior is visible, not folklore.
12. As a viewer, I want a debug control that forces full, degraded, or
    minimal tier, so that I can see all three states without bad Wi-Fi.
13. As a viewer, I want automatic tiering to resume when the override is
    cleared, so that I trust the normal behavior too.
14. As a viewer, I want finished candles to be identical at every tier, so
    that I know throttling only slows delivery and never corrupts data.
15. As a viewer, I want tier changes to resist flapping on brief jitter, so
    that the state machine looks engineered, not twitchy.
16. As a viewer, I want to kill the connection and watch the app mark data
    stale, then reconnect and resubscribe into a correct state, so that I
    trust recovery.
17. As a viewer, I want the book to survive missed or out-of-order updates
    by refetching a snapshot, so that I never see a corrupt book.
18. As a viewer, I want interval switches to drop late responses from the
    previous interval, so that I never see ghost candles.
19. As a developer, I want one command that starts the backend and a clear
    statement of how a browser connects locally and deployed, so that setup
    never blocks evaluation.
20. As a developer, I want the feed to be repeatable from a seed with
    injectable scenarios (spike, halt, gap, burst), so that demos and tests
    are deterministic.
21. As a developer, I want REST history plus WS live feeds to agree with each
    other, so that there is one truth about the market.
22. As a developer, I want prices and quantities handled with exact decimal
    precision and consistent timestamps plus ordering ids, so that money math
    is never visibly wrong.
23. As a developer, I want automated tests for tier hysteresis and for
    book snapshot/delta recovery at minimum, so that the two hardest behaviors
    are pinned.
24. As a developer, I want UI, application state, networking, and backend
    feed logic in distinct modules with a documented state-management story,
    so that I can explain the architecture in a walkthrough.
25. As a developer, I want environment-based configuration for backend URL,
    intervals, seed, and tier thresholds, so that local and deployed behavior
    differ by config, not code.
26. As a developer, I want a README covering architecture, protocols,
    synchronization, latency measurement, tiering, reconnect behavior, debug
    controls, packages, run instructions, and limitations, so that the
    demo is complete on paper as well as on screen.

## Implementation Decisions

Built and demoed in tracer order. Each bullet proves the full path before
the next widens it; nothing merges that isn't demoable end to end.

- **Bullet 0 — walking skeleton.** Seeded BTC-USD generator emitting trades
  (timestamp, price, quantity, ordering id) → REST snapshot of the book →
  a page showing latest price and the top bids/asks. Proves: the generator
  runs, one command starts the backend, the browser connects, decimal strings
  and ordering ids cross the wire intact. No WebSocket yet.
- **Bullet 1 — the book heals itself.** WS deltas with id and parent id join
  the snapshot: client opens the socket first, buffers deltas, fetches the
  snapshot, discards buffered deltas at or below the snapshot id, applies
  newer ones only on parent-id match, and refetches on any mismatch.
  Recent-trades stream rides the same socket. Proves: snapshot/delta sync,
  the in-flight race, gap recovery. (Stories 7, 8, 17.)
- **Bullet 2 — history you can trust.** Deterministic history by replaying
  the seeded generator, cached client-side per interval and request id;
  live trades extend the active candle; 1s ↔ 1m switching drops late
  responses from the dead interval, collapses duplicates, and renders empty
  states explicitly. Chart library receives only our aggregated candles and
  draws them with hover/click/drag inspection. Proves: replay agrees with
  live aggregation, no ghost candles. (Stories 3–6, 18, 21.)
- **Bullet 3 — delivery that adapts.** Client ping-pong every 2s reports
  latency (`RTT/2`) and jitter (EMA of `|RTT − prev|`) over the socket; the
  backend owns a per-connection tier (full ≤150ms @4Hz, degraded ≤300ms @1Hz,
  minimal above @0.25Hz) with 3-down/5-up hysteresis and missed-report
  fallback; slower tiers combine trades into fewer updates while final
  OHLCV stays byte-identical. Tier plus chart rate render on screen with
  a debug override that yields to automatic when cleared. Proves: the
  headline feature — throttled delivery, uncorrupted candles. (Stories
  11–15.)
- **Bullet 4 — hardening.** Reconnect with resubscribe and stale-while-dark
  states; tab-visibility handling; malformed-message, empty-history, and
  duplicate-candle handling; disposal of connections, timers, and
  subscriptions; scenario injector (spike, halt, gap, burst) for demos and
  tests. Proves: every recovery story the spec names. (Stories 9, 10, 16,
  20.)
- **Bullet 5 — demo.** Tier-hysteresis and book-recovery tests pinned
  per slice; environment-based config for URLs, intervals, seed, and
  thresholds; public repo plus deployed URL; README with all mandated
  sections; recording covering live chart, interval change, book, forced
  tier, and disconnect recovery. Proves: the deliverables. (Stories 1, 19,
  22–26.)

Cross-cutting decisions held across all bullets: one BTC-USD market (no
second symbol, no watchlist); no database — determinism comes from
seed-plus-replay; a server-rendered shell composing client islands, with
REST history in an interval-keyed server-state cache, live book/candle/tier
in tiny observable stores, and a React-free networking module pushing into
stores; UTC ISO-8601 timestamps with ordering ids on every message; all
thresholds, rates, and intervals are configuration with documented rationale.

## Testing Decisions

- **Only external behavior is tested, never implementation details.**
  Assertions target outgoing socket frames, tier transitions, merged book
  states, and aggregated candles — not internal call order or store shape.
- **Each tracer bullet lands with its slice test.** Bullet 1 pins
  buffer-then-replay, gap-triggered refetch, and malformed/empty rejection
  with scripted ids. Bullet 2 pins replay agreement, late-response discard
  by request id, duplicate collapse, and empty states. Bullet 3 pins tier
  transitions with hysteresis, missed-report fallback, override precedence,
  and byte-identical candles across tiers from one seeded stream.
- **Prior art.** Greenfield repo — no existing tests to follow. The standing
  pattern is deterministic seeded fixtures plus scripted protocol inputs, so
  every test reads as: given a seed and a script, assert the externally
  visible outcome.

## Out of Scope

- Any real exchange integration, account, or live market data.
- User order entry (buy/sell), portfolios, balances, or authentication —
  the spec requires market display only.
- Watchlist with live prices for non-BTC symbols (bonus built as reorder-only: one live BTC-USD row plus static simulated reference rows; selecting a temp row parks the chart, order persists in `localStorage`).
- Persistent storage of any kind (no database by design).
- Backend hosting decision (parked: UI on Vercel, backend TBD) and the screen
  recording itself (produced after the build).
- Load, soak, and cross-browser testing beyond one modern desktop browser.

## Further Notes

- The demo narrative in one line per bullet: skeleton proves the wire;
  Bullet 1 proves recovery via ids-plus-snapshot; Bullet 2 proves replay
  agrees with live; Bullet 3 proves throttling slows delivery without
  corrupting candles; Bullet 4 proves every named edge case.
- Thresholds and rates are defensible defaults (interactive latency bands
  with asymmetric hysteresis), not physical constants — all are config, and
  the README will say why each number was chosen.
- If the backend host decision reopens exchange-style book semantics
  (e.g. a second symbol), that is a new spec, not an edit to this one.

# Pitchfork — real-time BTC-USD trading screen

One simulated BTC-USD market — seeded, no database, no exchange and no API keys —
rendered as a live trading screen: candlestick chart with history and a live
active candle, a self-healing top-10 order book, a streaming trade tape, and
per-connection **adaptive delivery** that stays correct when a connection
degrades. A browser opens one URL and sees the market move; the backend owns the
market and the delivery decision, and the UI shows both honestly, including when
it is not live.

- **UI (deployed):** https://pitchfork.0kv.in (Vercel, Root Directory `web`).
- **API (deployed):** https://pf-api.0kv.in (NixOS + Cloudflare tunnel, custom domain; Fly/Render deferred).
- **Gates:** `go test -race ./...` green (api), `npm test` / `typecheck` / `lint` / `build` green (web), `docker compose up --build` verified end to end.

| Document | What it is |
| --- | --- |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | **Source of truth for the wire** (REST + WS frames, gap rule, scenarios) |
| [`docs/SPEC.md`](docs/SPEC.md) | The spec this was built to: tracer bullets 0–5, stories, out-of-scope |
| [`docs/SEAMS.md`](docs/SEAMS.md) | The three testable vertical slices and where testing deliberately stops |
| [`CONTEXT.md`](CONTEXT.md) | Ubiquitous language (trade, book, delta, tier, live vs stale) |
| [`web/README.md`](web/README.md) | Frontend in depth: book merge, candle series, tiers, stores, tests |
| [`docs/RECORDING.md`](docs/RECORDING.md) | Shot list for the screen recording, with the commands to run |
| [`api/.env.example`](api/.env.example) | Every backend env var, annotated |

**Contents**

1. [One command](#one-command) · 2. [How a browser connects](#how-a-browser-connects-local-and-deployed) · 3. [Architecture](#architecture) · 4. [State management](#state-management) · 5. [Generated market data](#generated-market-data) · 6. [REST and WebSocket protocols](#rest-and-websocket-protocols) · 7. [Chart and book synchronization](#chart-and-book-synchronization) · 8. [Latency and jitter](#latency-and-jitter) · 9. [Tiers: thresholds, hysteresis, missing reports](#tiers-thresholds-hysteresis-missing-reports) · 10. [Reconnect, lifecycle, stale data](#reconnect-lifecycle-stale-data) · 11. [Debug controls](#debug-controls) · 12. [Configuration](#configuration) · 13. [Running it](#running-it) · 14. [Deployment](#deployment) · 15. [Packages used](#packages-used) · 16. [Known limitations](#known-limitations) · 17. [Repo map](#repo-map)

---

## One command

```bash
docker compose up --build      # → screen on http://localhost:3000, market on http://localhost:8080
```

Two small images are built (`api` 22 MB, `web` 292 MB), the API is waited on
until `/api/config` answers, then the screen is served. Open
<http://localhost:3000> — the chart, book and tape are live within a second or
two. `docker compose down` stops it.

No Docker? One script builds and runs both binaries (ADR-0002):

```bash
./scripts/run-local.sh          # → screen on http://localhost:3000, market on http://localhost:8080
# or: curl -sSL https://raw.githubusercontent.com/TUGTEN/pitchfork/main/scripts/run-local.sh | sh
```

Ctrl-C stops both. `PORT`/`WEB_PORT`/`SEED` override the defaults.

Backend only, without Docker:

```bash
cd api && go run .             # → http://localhost:8080  (serves no HTML: it is the market, not the page)
```

Prefer local dev servers? `cd api && go run .` in one terminal and
`cd web && npm install && npm run dev` in another — see
[Running it](#running-it).

## How a browser connects (local and deployed)

The screen is the only page; there is no server-side proxy. The **browser**
talks to the API directly, using `NEXT_PUBLIC_API_URL` plus the WS scheme
(`http` → `ws`, `https` → `wss`) for the two sockets (market + chart):

| | Page | API the browser is told to use | Sockets |
| --- | --- | --- | --- |
| Local dev | `http://localhost:3000` (`npm run dev`) | `https://pf-api.0kv.in` (the code default; `NEXT_PUBLIC_API_URL=http://localhost:8080` for a local backend) | market `wss://pf-api.0kv.in/ws?topics=book,trades&interval=1s` + chart `wss://pf-api.0kv.in/ws?topics=chart&interval=1s` (`1m` after a switch) |
| `docker compose up` | `http://localhost:3000` (container, port published) | `http://localhost:8080` (baked in at image build) | same as local dev but `ws://` |
| Deployed | https://pitchfork.0kv.in (Vercel) | https://pf-api.0kv.in (Vercel env var, same as the code default) | `wss://pf-api.0kv.in/ws?...` |

Two consequences worth stating plainly:

- `NEXT_PUBLIC_API_URL` is **inlined into the browser bundle at build time**
  (it is a `NEXT_PUBLIC_*` variable), so it is the host a fresh browser opens on —
  switching hosts afterwards needs no rebuild. The Backend panel (preset dropdown +
  free-form input) redials both sockets and refetches from the new host, and
  remembers the choice in `localStorage` for the next visit. The build-time value
  must still be an address *the browser* can reach (locally `npm run build` again,
  on Vercel a redeploy to change the default), which is why the compose file uses
  published host port and not the compose service name `api`.
- The API allows any origin (`Access-Control-Allow-Origin: *` in
  `api/main.go:withCORS`, plus `InsecureSkipVerify` on the WS upgrade). That is
  a deliberate trade for a read-only, credential-free market: there is nothing
  to protect and no allow-list to keep in sync with the UI's hostname.

If the page is opened with no backend reachable — a fresh Vercel deploy before
the env var is set, say — the screen says so (`down` / `connecting`, an explicit
empty chart) instead of showing invented data. That is the same
stale-vs-live discipline described in
[Reconnect, lifecycle, stale data](#reconnect-lifecycle-stale-data).

## Architecture

Two processes, one wire contract, nothing in between (no database, no cache
service, no message broker):

```
┌ api/ — Go 1.25, market + delivery (~1.8k LOC + ~2.1k of tests) ──────────────────────────┐
│                     env: PORT / SEED / SYMBOL / TIER_*                                   │
│                                                                                          │
│   feed.go    seeded GBM trade generator (100ms tick, 1-3 trades)                         │
│              + derived 10x10 book + one candle series per interval                       │
│              + scenario injector (spike / halt / gap / burst / clear)                    │
│   main.go    tick loop, REST routes, CORS, graceful shutdown                             │
│                GET  /api/config      symbol, intervals, seed                             │
│                GET  /api/snapshot    the book image (seq, 10x10)                         │
│                GET  /api/history     finished candles, oldest first                      │
│                GET  /api/scenario    armed/in-effect scenario or null                    │
│                POST /api/scenario    inject one scripted event                           │
│   ws.go      per-connection hub: tier frame, book frames with seq/                       │
│              prevSeq, trade frames, throttled candle frames, ping/                       │
│              pong echo, report/force intake                                              │
│   tier.go    ONE TierMachine per connection: full/degraded/minimal,                      │
│              asymmetric hysteresis, miss budget, forced override                         │
└──────────────────────────────────────────────────────────────────────────────────────────┘

        ▲ REST: decimal strings, RFC3339Nano   ▲ WS: JSON text frames
        │                                      │
┌ web/ — Next.js 16 + React 19, screen ────────────────────────────────────────────────────┐
│   app/page.tsx        server-rendered shell (static prerender, no fetch)                 │
│   components/         presentational only: props in, JSX out, no fetch                   │
│     TradingScreen.tsx the one client island: owns the session, hands                     │
│                       each pane its own slices of the stores                             │
│   lib/                networking + pure logic, React-free                                │
│     ws-client.ts      the session: dial, refetch, ping/report, reconnect                 │
│     book-sync.ts      the merge: buffer, chain on prevSeq, signal gaps                   │
│     candles.ts        the series: one entry per timestamp                                │
│     candle-chart.ts   the only writer to the chart library                               │
│     latency.ts        RTT / latency / jitter maths                                       │
│     protocol.ts       wire types, runtime guards, REST fetchers                          │
│     config.ts         env + timings, in one place                                        │
│   stores/             live state: three Zustand stores per session                       │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Backend.** `api/` is one Go module (`feed`) with the market and delivery logic
in five files, each with its tests beside it:

| File | Responsibility |
| --- | --- |
| `feed.go` | Seeded GBM trade generator, book derivation, candle aggregation per interval, trade log, scenario injector |
| `main.go` | Env config, 100ms tick loop, REST routes, CORS, graceful shutdown |
| `ws.go` | WS hub: session lifecycle, topics/interval subscription, tiered frame delivery, ping/pong, `report`/`force` intake |
| `tier.go` | The tier machine: bands, votes, hysteresis, miss budget, forced override |
| `*_test.go` | Behavior tests per slice: REST shapes, WS frames, tier transitions, book recovery, candles, scenarios |

**Frontend.** `web/` is Next.js App Router. The page is a statically
prerendered shell plus one client island (`components/TradingScreen.tsx`); the
panels under it are purely presentational, and **fetching and sockets live in
`lib/`, never in a component** — enforced by the lint config, not by convention
(see `web/eslint.config.mjs`). The trade-off is one extra indirection (a pane
receives values as props from a small hook) and the payoff is that the whole
live path is testable without a DOM: `lib/ws-client.ts` takes its socket,
timers, clock, snapshot request and stores by injection, and the tests drive it
with a script.

Where the tests stop is drawn on purpose in [`docs/SEAMS.md`](docs/SEAMS.md):
the three vertical slices (adaptive chart, self-healing book, trustworthy
history) are tested at the wire; transport plumbing, canvas rendering and
deployment are covered by running the app, not by assertions.

## State management

Four kinds of state, four different homes — this is the choice a reader
will ask about, so here is the reasoning in full (frontend depth in
[`web/README.md`](web/README.md#live-state-zustand)):

| State | Where it lives | Why |
| --- | --- | --- |
| Backend identity (`symbol`, `intervals`, `seed`) | `GET /api/config`, fetched once, cached in a hook | The UI must not duplicate backend config; if the symbol or the interval set changes server-side, the screen follows without a rebuild |
| REST history (per interval) | `lib/candle-history.ts` + a hook, guarded by request id and interval | It is a request/response, not a stream: a late response must be *droppable*, which is a property of the request, not of a store |
| Live market (book, tape, candles, tier, session health) | Three tiny **Zustand** vanilla stores created per mount (`stores/book.ts`, `candle.ts`, `conn.ts` via `stores/market.ts`) | Live state is written by a non-React module (the socket) and read by many independent panes at up to 10 Hz. Vanilla Zustand gives `setState` from outside React and per-field selectors, so a 2s pong cannot repaint the book and a book frame cannot repaint the tape |
| The chart's pixels | `lib/candle-chart.ts`, called imperatively from one effect | The forming candle changes several times a second; re-rendering a React tree (or rebuilding the series) that often is the jank the spec asks to avoid. The library is handed bars built from *our* candles and nothing else |

Three stores, not one market object, because the panels select from different
stores: `stores/market.test.ts` pins the property the layout depends on — a
write to one store leaves every other store's slices identical, which is what
lets a selector skip a re-render.

Session lifetime is state too: the stores are created by the same hook that
owns both sockets, so an unmount (or a remount) cannot inherit a dead session's
numbers, and a hidden tab disposes the whole thing (see
[Reconnect, lifecycle, stale data](#reconnect-lifecycle-stale-data)).

**Rejected alternatives.** A single global provider/context re-rendering the
screen per frame (the cheapest thing to write, and the reason a 4 Hz stream
janks); Redux or a state machine library (three sinks and two sockets do not need
actions, reducers and devtools); React Query for the socket (it models
request/response, and the whole point here is that the socket is a *stream* with
its own recovery rules); `socket.io` (a protocol of its own, on top of a wire
contract this project deliberately pins by hand in `docs/PROTOCOL.md`).

## Generated market data

One symbol, one market, no database — determinism comes from a seed.

- **Model.** Geometric Brownian motion at `tickSigma = 0.0002` (≈0.02 % per
  100 ms tick) around a $65,000 start, drawn from `math/rand` seeded with
  `SEED` (default 42). Every 100 ms the feed emits **1–3 trades** (`seq`, `ts`,
  `price`, `qty`), so the tape prints ~10–30 trades/second.
- **Exactness.** Money crosses the wire as **decimal strings** (`"65230.39"`,
  `"0.024371"`) and is formatted from scaled integers; the UI renders the
  strings and never re-rounds a float. Timestamps are UTC `RFC3339Nano`.
- **Ordering.** Every market message carries a monotonic `seq`. Trades and book
  images are numbered by *separate* counters (a trade id and a book id are not
  comparable), which is why the book frames carry `prevSeq` for their own chain.
- **Book.** Derived around the trade mid on every tick: 10 bids and 10 asks
  starting 3 bps out and stepping 2 bps per level, sizes exponential (mean
  ≈0.06 BTC), each level a decimal string. The full 10×10 image rides each
  frame in this build (ids still hold, so the client's gap detection is real —
  see [limitations](#known-limitations) for what the injector can and cannot
  provoke).
- **Candles.** The feed aggregates the same trade stream into one series per
  interval (`1s`, `1m`) with a live bucket plus finished buckets. `/api/history`
  and the WS candle stream read the **same** series, so REST history and the live
  chart cannot disagree (spec story 21).
- **Scenarios.** A named event can be scripted onto the seeded feed — `spike`
  (one ~10σ step: verified on the composed stack at +0.19 % between consecutive
  trades), `halt` (5 s with no trades, book still served), `gap` (the next book
  frame skips 5 seq numbers with a `prevSeq` no applied frame holds, so the
  client refetches `/api/snapshot` and resumes — a `seq` jump plus one more
  `refetched` in the Connection panel's recovery row), `burst` (~500 trades in a second), `clear` (disarm). It is
  a debug/demo control, not market data: see
  [Debug controls](#debug-controls) and
  [`docs/PROTOCOL.md`](docs/PROTOCOL.md#scenario-injector).

## REST and WebSocket protocols

[`docs/PROTOCOL.md`](docs/PROTOCOL.md) is the contract — change it there first,
in the same commit as both sides. Summary:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config` | `{"symbol","intervals","seed","protocol":2}` — what this deployment simulates (the UI's only source for symbol/intervals; `protocol: 2` is the tuple wire) |
| `GET /api/snapshot` | `{seq, bids[[p,q]×10], asks}` — the book image the merge re-bases on |
| `GET /api/history?interval=1s\|1m&limit=N` | `{interval, candles[[t,o,h,l,c,v]]}` oldest-first, `[]` never `null`; bad input → `400 {"error":"…"}` |
| `GET /api/active` | `{c1s, c1m, last}` — specified as an *optional* debug helper in PROTOCOL.md and **not implemented** here, because nothing consumes it (the chart takes history + frames, the tape takes `trade` frames) |
| `GET`/`POST /api/scenario` | Read/inject a scripted event; unknown name → `400` with the accepted vocabulary |
| `GET /ws?topics=book,trades,chart&interval=1s` | The stream: `tier`, `book`, `trade`, `candle`, `pong` frames |

Rules that shape everything else: decimal strings for money, UTC
`RFC3339Nano` timestamps, an ordering id on every market message, market data as
compact tuples (`[\"trade\",seq,ts,price,qty]`, `[\"book\",seq,prevSeq,bids,asks]` with
`[price,qty]` levels, `[\"candle\",interval,t,o,h,l,c,v,complete]`; history candles
`[t,o,h,l,c,v]`) versioned by `GET /api/config` `"protocol": 2`, additive fields
allowed on control frames and REST envelopes without a version bump, and `400` + JSON error for anything the
server cannot honour (never a silent fallback). The client narrows every payload
from `unknown` with a runtime guard, and unparsable frames are counted and
dropped rather than allowed to poison the stream.

## Chart and book synchronization

**Book — five rules, in `lib/book-sync.ts`, pinned by `lib/book-sync.test.ts`:**

1. **Buffer while the snapshot flies.** The socket opens first, so book frames
   arrive before `/api/snapshot` resolves; they are held, never applied.
2. **Drop what the snapshot already contains** (`seq ≤ snapshot.seq`), then
   replay the newer ones in order.
3. **Apply only on a parent match** — a frame lands when its `prevSeq` equals the
   last applied `seq`; a `prevSeq` of `null` claims no parent and never chains.
4. **Refetch on anything else.** A non-chaining frame is a `gap`: the image on
   screen freezes, a fresh snapshot is fetched, and the stream resumes on it. The
   unbased frame is never rendered.
5. **Bound the buffer and admit it.** Past the buffer limit the oldest frame is
   dropped, which surfaces as a gap rather than a book built on a hole.

A reconnect is a new session: the merger resets, an in-flight snapshot from the
dead session is aborted and its result ignored, and the book re-syncs from a
fresh snapshot. Consecutive gaps refetch immediately while recovery converges;
a run of gaps trips a circuit breaker (`MAX_RESYNC_ATTEMPTS`) that drops back to
the retry cadence, so a feed that keeps disagreeing cannot become a hot fetch
loop — the first frame that chains resets it. Triggering a break *on demand* is
what the injector's `gap` is for: the skipped ids arrive with a `prevSeq` no
applied frame holds, so the client refetches and resumes; killing the socket
shows the same recovery path when the whole session is lost, whose new session
re-syncs the book from a fresh snapshot.

**Chart — one series from two doors, in `stores/candle.ts` + `lib/candles.ts`:**

- History opens the chart (`/api/history`, 120 candles, oldest first). A
  response is accepted only if it echoes the interval currently on screen *and*
  still carries the request id that asked for it — so a response that lands after
  an interval switch is dropped rather than painted (the no-ghost-candles rule).
- Live `candle` frames extend it: a finished bucket replaces a forming bucket of
  the same timestamp, a forming frame becomes the forming bucket. One entry per
  timestamp, always; a duplicate collapses and a late bucket is inserted where
  its timestamp belongs.
- A reconnect bumps the history epoch and re-reads the series, because candle
  frames only ever reached the socket that just ended.
- Switching 1s↔1m ends only the chart session: the market socket (book + trades) is dialed once per mount and never mentions the chart interval, so the book and the tape stay live while the chart drops its old series, moves the request id, and reloads history on the new socket.
- The chart library only draws: `lib/candle-chart.ts` builds bars from our
  aggregation, and the hover/click/drag readout resolves back to *our* candle by
  timestamp, so no displayed OHLCV is the library's own arithmetic.

**The invariant that ties them together:** the tier changes *delivery*, never
*values*. The feed owns the aggregation; a slower tier holds finished candles
back until their delivery slot and re-sends the live candle only when it has
moved. `api/candle_test.go` and `api/tier_ws_test.go` assert that the same seeded
stream yields byte-identical final OHLCV at all three tiers.

## Latency and jitter

The client measures; the backend decides. Every 2 s (`PING_INTERVAL_MS`, fixed
by the protocol) the client sends `{"type":"ping","tSend":<ms>}`; the backend
echoes the stamp in a `pong`; the client computes

```
RTT     = tRecv − tSend                (tRecv is the backend's UTC timestamp)
latency = RTT / 2
jitter  = EMA(|RTT − prevRTT|)         (α = 0.5)
```

and reports `{"type":"report","latencyMs":…,"jitterMs":…}` on the same tick.
Half the RTT is the honest per-direction estimate for a symmetric link and the
number the tier bands are expressed in. The EMA keeps one spike from dominating
the report that drives tiering while still decaying within a few probes. A pong
that cannot be believed — unreadable stamp, a reply predating its ping, or a
round trip past `MAX_RTT_MS` (60 s: a frozen tab, not a measurement) — is
discarded rather than reported, and with only one sample jitter is reported as
`0`, which is the honest reading of no spread.

On screen: the Delivery panel shows the backend's announced tier and its
chart rate beside RTT / latency / jitter, so the adaptive behaviour is
visible rather than folklore.

## Tiers: thresholds, hysteresis, missing reports

One WebSocket connection is one tier state machine, owned by the backend
(`api/tier.go`); the client never computes its own tier.

| Tier | Probe that wants it | Chart delivery rate | What it means on screen |
| --- | --- | --- | --- |
| `full` | latency ≤ **150 ms** *and* jitter ≤ **50 ms** | **4 Hz** | The chart moves several times a second |
| `degraded` | latency ≤ **300 ms** | **1 Hz** | Visible step down; finished candles identical |
| `minimal` | anything slower | **0.25 Hz** | One chart update every 4 s; only the *rate* changed |

Scope, stated plainly: the tier throttles the **chart** stream (the live candle
and the finished candles queued behind its delivery slot) — the stream whose
rate the spec's story 11 puts on screen. The book frames and the tape keep
their own cadence in this build (one image per book change, one frame per trade,
bounded per pass), so forcing `minimal` slows the candles and the announced rate
without making the book lie about the market.

- **Hysteresis is asymmetric: 3 consecutive probes to step down, 5 to step up**,
  one tier at a time, votes reset whenever a probe disagrees. Downgrading is
  cheap and immediate-ish because a client that is slow is already missing
  freshness it cannot see; upgrading is slow because a client that is briefly
  lucky must not flap back into a rate it cannot hold. `api/tier_ws_test.go`
  pins both directions and that a single spike changes nothing.
- **Missing reports are a signal too.** A client that stops reporting — stalled
  tab, hung proxy, a socket kept alive by a router — can never report that it is
  slow, so silence counts: **3 empty probe windows → degraded, 6 → minimal**
  (`api/tier_ws_test.go:TestTierFallsBackWhenReportsStopArriving`). Any report
  resets the miss counter.
- **The debug override wins while it is set** and takes effect immediately (not
  at the next window), because a button someone just pressed has to move the
  badge now. Clearing it (`{"type":"force","tier":null}`) hands the decision
  back: the connection resumes wherever its probes put it, so clearing typically
  shows a tier you did not click — that is the point, and the badge switches from
  "forced" to "automatic".
- **A reconnect is a new state machine at `full`**, with no override on it — so
  the client re-sends a standing override when the session opens, otherwise the
  badge would keep reading "forced" over a backend that had gone back to
  automatic.
- **Every number above is configuration**: `TIER_FULL_MAX_MS`,
  `TIER_DEGRADED_MAX_MS`, `TIER_MAX_JITTER_MS`, `TIER_DOWN_VOTES`,
  `TIER_UP_VOTES`, `TIER_MISS_DEGRADED`, `TIER_MISS_MINIMAL`
  ([`api/.env.example`](api/.env.example)). The defaults are the shipped values;
  a malformed one is a startup error rather than a silent fallback, because the
  badge renders these numbers. `api/tier_ws_test.go:TestTierBandsComeFromConfig`
  proves the bands actually move the decision on the wire.

Why these numbers: 150 ms is the top of the "interactive" band (a round trip
under it is indistinguishable from immediate on a desktop screen), 300 ms is
where a live chart visibly lags the tape, and 50 ms of jitter on a link whose
latency is otherwise small means a contended Wi-Fi path — twitchy enough that
4 Hz delivery would arrive in bursts. None of them is a physical constant; they
are defended defaults, and they are config.

## Reconnect, lifecycle, stale data

- **Live** = connected, subscribed, and holding fresh data. **Stale** = cached
  values shown while disconnected, unsubscribed, or hidden from view. Cached
  values are dimmed and labelled; they are never presented as live
  (`CONTEXT.md`: Live vs Stale).
- **A dropped socket redials with capped exponential backoff** (500 ms doubling
  to 8 s, `RECONNECT_BASE_MS` / `RECONNECT_MAX_MS`). Because each session's
  topics *and* the chart interval live in its socket URL, redialing **is**
  resubscribing: a new market session re-syncs the book from a fresh snapshot,
  a new chart session re-reads history, and the merger starts clean.
- **A failed snapshot** keeps the merger buffering and retries
  (`SNAPSHOT_RETRY_MS`), so a blip during recovery does not leave the book
  permanently unbased.
- **A hidden tab stops rather than pretends.** `document.hidden` ends the
  session (both sockets closed, ping timer cancelled, stores marked stale); becoming
  visible dials new ones. A hidden tab catches no data, and its
  background-throttled timers would report readings the backend is entitled to
  tier on — "not running" is a stronger guarantee than "labelled cached".
- **Nothing leaks.** The listener, both sockets, every timer they scheduled, the
  stores and the chart instance are disposed by the hook that owns them
  (`lib/hooks/useMarketStream.ts`), so an unmount leaves nothing behind.

## Debug controls

**Tier override (in the UI).** The **DEBUG** panel's buttons ask the backend for
`full`, `degraded` or `minimal`, and *automatic* clears the override. The buttons
contain no tier logic: each click is one `force` frame, and the badge renders the
`tier` frame the backend answers with. The readout distinguishes three states
rather than flattering the client — `automatic`, `forced <tier> via debug
control`, or `asked for <tier> — not in force yet` when the frame has not
arrived (or the socket is down).

**Scenario injector (developer control, over REST).** It scripts one known
market event onto the seeded feed so a demo or a test does not have to wait for
it — the response is the injector's own state, so a control renders the truth
rather than what it last asked for:

```bash
curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"spike"}'   # one ~10σ step up on the next tick
curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"halt"}'    # 5s of silence, book still served
curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"gap"}'     # next book frame skips 5 seq ids (the `seq` readout jumps, the recovery row ticks one refetch)
curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"burst"}'   # ~500 trades in the next second
curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"clear"}'   # disarm (also ends a halt/burst now)
curl -s localhost:8080/api/scenario                                     # {"scenario":…|null}
```

There is **no injector button in the UI**, on purpose: it can move the market,
and the screen is a market view, not a trading cockpit. The recording drives it
from a terminal, which also shows the command that caused what the viewer sees.

**Watching the wire.** DevTools → Network → WS shows the JSON frames as they
arrive (tagged tuples for market data — `\"trade\"`/`\"book\"`/`\"candle\"` at index 0 —
named keys for the `tier`/`pong` control frames). For REST,
`curl -s localhost:8080/api/config | jq` and `curl -s
"localhost:8080/api/history?interval=1s&limit=3" | jq` are the fastest way to
see the decimal-string and ordering-id conventions.

## Configuration

**Backend** (every variable, with defaults, in
[`api/.env.example`](api/.env.example)):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP/WS port |
| `SEED` | `42` | Market seed: same seed, same trades, same candles |
| `SYMBOL` | `BTC-USD` | Symbol reported by `/api/config` and rendered on screen |
| `TIER_*` | 150 / 300 / 50 / 3 / 5 / 3 / 6 | The delivery bands and vote budgets above |

**Frontend** (one variable, plus compiled timings):

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `https://pf-api.0kv.in` | Backend base URL, inlined at build time ([`web/.env.example`](web/.env.example)) |

Everything else on the client — ping cadence, reconnect backoff, retry delays,
history depth, buffer bounds, tape size, jitter α — is a documented constant in
[`web/lib/config.ts`](web/lib/config.ts), quoted with its rationale in
[`web/README.md`](web/README.md#latency-tiers-and-reconnect). Those are
compile-time by intent: they are the client's own behaviour, and a deployment
that could change them without a rebuild would change the client's contract with
the backend's tiering.

Two deliberate asymmetries:

- **The interval set (`1s`, `1m`) is a code constant, not env.** It lives in one
  place (`api/main.go:intervals`), is advertised by `/api/config`, validated by
  `/api/history` and `/ws`, and reflected in the URL — the spec's "one source of
  truth". It is not an env var because the feed aggregates *exactly* those
  buckets: an interval the feed does not aggregate would serve an empty history,
  which is a worse lie than not offering it. Widening the set is a one-line
  change there plus the feed's accumulation.
- **The UI never duplicates backend config.** Symbol, intervals and seed come
  from `/api/config` at runtime; the only thing the frontend hardcodes is its
  own default backend URL.

**No hidden hosts.** In the application code that ships — `api/*.go`, `web/lib`,
`web/stores`, `web/components`, `web/app` — a check for `localhost`, `127.0.0.1`,
`:8080` and `:3000` finds exactly one occurrence: the documented default
`DEFAULT_API_BASE_URL` in [`web/lib/config.ts`](web/lib/config.ts). Everything
else comes from env (backend) or `GET /api/config` (frontend). The only other
places those strings appear are the container plumbing that has to name its own
loopback — the health probes in `api/Dockerfile`, `web/Dockerfile` and
`docker-compose.yml` — and the annotated defaults in the two `.env.example`
files.

## Running it

### One command (the demo path)

```bash
docker compose up --build        # API :8080, screen :3000
```

`docker compose` overrides what it needs and passes the rest through, so a
different market is one word:

```bash
SEED=7 TIER_FULL_MAX_MS=5 docker compose up --build   # new seed; a 5ms full band makes tiers move on a fast line
```

### Local dev (two processes, hot reload)

```bash
# terminal 1 — the market
cd api && go run .               # listening on :8080 — symbol=BTC-USD seed=42 intervals=1s,1m tick=100ms

# terminal 2 — the screen
cd web && npm install && npm run dev        # → http://localhost:3000
```

Copy `web/.env.example` to `web/.env.local` to point at a backend other than
`http://localhost:8080`. Backend env: export it (`PORT=9000 go run .`) — the app
does not read `.env` files by itself.

### Tests and gates

| Command | Where | Covers | Last run |
| --- | --- | --- | --- |
| `go test -race ./...` | `api/` | REST shapes, WS frames, tier hysteresis + miss fallback + override precedence + config-driven bands, book recovery, candles (incl. byte-identical across tiers), scenario injector | pass |
| `npm test` | `web/` | 232 tests over the pure layer: protocol guards, book merge, candle series, history request ids, latency maths, socket session, tier readout, tab lifecycle, store isolation, watchlist order | pass |
| `npm run typecheck` | `web/` | `tsc --noEmit` | pass |
| `npm run lint` | `web/` | eslint (incl. "no fetch in components") | pass |
| `npm run build` | `web/` | production build, deploy-clean with no special config | pass |
| `docker compose up --build` | repo root | the real thing: both images, API health, page served, WS handshake | pass |

The tests assert **external behaviour only** — outgoing frames, tier
transitions, merged book states, aggregated candles — never internal call order
or store shape. Both sides follow the same pattern: a deterministic seeded
fixture plus a scripted protocol, so every test reads as *given this seed and
this script, this is what a browser sees*.

## Deployment

Landed: the UI is on Vercel (https://pitchfork.0kv.in), the API on a NixOS box
behind a Cloudflare tunnel with a custom domain (https://pf-api.0kv.in). Nothing
here is blocked on it — the images and the config are the answer, and any host
takes the same code. Fly.io/Render as a container host is deferred (both errored).

### UI → Vercel

No `vercel.json`, no custom output, no Vercel-specific code is needed; the page
is a statically prerendered shell plus a client island.

1. Push the repo to a public GitHub remote (the app has no secrets to leak).
2. Vercel → **Add New… → Project → Import** the repository.
3. **Root Directory: `web`** (the repo root holds both halves of the project).
   Framework preset stays **Next.js**; leave build/install commands at their
   defaults.
4. **Settings → Environment Variables**: `NEXT_PUBLIC_API_URL` =
   `https://pf-api.0kv.in` for Production *and* Preview. Deploy. (Current
   production value; the code default in `web/lib/config.ts` matches.)
5. After the backend lands, set the variable and **redeploy**: it is inlined at
   build time, so a variable change alone does not move a running deployment.

Why there is no `output: "standalone"` in `next.config.ts`: standalone exists so
a self-hosted Node process can run without the full `node_modules` tree — the
Docker case, and `web/Dockerfile` is the only thing that switches it on. Asking
for it unconditionally broke Vercel builds on this Next line
([vercel/next.js#96646](https://github.com/vercel/next.js/issues/96646): the
Vercel builder's `onBuildComplete` looks for a trace file the adapter path no
longer emits), and a Vercel deployment does not need it. That is the whole
reason the switch is `BUILD_STANDALONE=1` rather than a static option.

Deploying without setting the variable is a valid thing to do and degrades
honestly: the browser falls back to the code default (`https://pf-api.0kv.in`); if
that is unreachable the screen shows `down` with an empty chart rather than inventing a market.

### API → NixOS + Cloudflare tunnel (live at https://pf-api.0kv.in)

The API runs as a plain process on a NixOS box listening on `:8080`; a
declarative `services.cloudflared` tunnel exposes it under the custom domain
`pf-api.0kv.in` (one hostname → `http://localhost:8080`, `default:
`http_status:404`). Cloudflare terminates TLS, so the browser's `https://` page
gets `wss://` with no extra work — same requirement as any container host
below, and the reason the UI never speaks raw `ws://` to a deployed backend.

What a container host has to provide instead, and nothing more: a container
that serves **one TCP port with WebSocket upgrade support**; no persistence,
no volume, no secrets, no cron. `api/Dockerfile` builds a 22 MB image, and
`docker compose up` is the same stack with both halves local, so the deploy
itself is `docker run -p 8080:8080 -e SEED=42 <image>` on any container host
(Fly.io, Railway, Render, or a small VM) with TLS in front, because the UI is
served over HTTPS and a `ws://` socket from an `https://` page is blocked by the
browser — the host must terminate TLS and expose `wss://`. Fly.io/Render are
deferred (both errored during setup); `api/fly.toml` stays as the starter.

Moving the backend later does not change any code path: it changes one environment
variable (`NEXT_PUBLIC_API_URL`) plus a redeploy of the UI, which is exactly the
"local and deployed differ by config, not code" acceptance criterion.

Both hosts are live (top of this file);
[`docs/RECORDING.md`](docs/RECORDING.md) is the shot list for the recording.

## Packages used

**Backend** (`api/go.mod`, module `feed`, Go directive 1.24 — built with 1.25):

| Package | Why |
| --- | --- |
| Go standard library | `net/http` for REST and the WS upgrade host, `encoding/json`, `math/rand` for the seeded generator, `context`/`os/signal` for graceful shutdown. The market logic is small enough that a framework would be more code, not less |
| [`nhooyr.io/websocket`](https://github.com/coder/websocket) v1.8.17 | The only dependency. Small, context-first (`Read`/`Write` take contexts, so deadlines and shutdown are the stdlib idiom), and it exposes the hijacked connection's lifecycle, which is what lets the hub close sessions cleanly on SIGTERM. Rejected: `gorilla/websocket` (larger API, its own deadline model) and `golang.org/x/net/websocket` (deprecated) |

**Frontend** (`web/package.json`):

| Package | Why |
| --- | --- |
| `next` 16.3.5 + `react`/`react-dom` 19.2.8 | App Router: a statically prerendered shell with one client island, zero-config Vercel deploys, and the project's lint rules out of the box |
| `zustand` ^5.0.15 | The live store: `setState` callable from the React-free socket module and per-field selectors, without a provider tree or a framework-sized API |
| `lightweight-charts` ^5.2.1 | Candlesticks with hover/click/drag inspection and a canvas that survives 4 Hz updates. Rejected: building candles on canvas by hand (time spent on pixels, not on sync) and heavier charting stacks (recharts et al. re-render React per frame) |
| `tailwindcss` ^4 (+ `@tailwindcss/postcss`) | The screen's design tokens and layout in the markup, so the components stay presentational |
| `vitest` ^3.2.7 | Fast, TS-native unit tests for the pure layer (~400 ms for 232 tests) |
| `typescript` ^5, `eslint` ^9 + `eslint-config-next` | Types on the wire path (no `any`; payloads narrowed from `unknown`) and the layering rule enforced by lint |

No database driver, no ORM, no message broker, no state-management framework, no
socket library on the client (`WebSocket` is the browser's).

## Known limitations

Honest list, roughly in the order a reader would hit them:

1. **One live symbol, display only.** Only BTC-USD streams — no order entry, no accounts,
   no balances, no authentication — the app shows market display only. The watchlist bonus
   is reorder-only: static simulated reference rows (ETH/SOL/DOGE) that park the chart
   when selected, with the order remembered in `localStorage`.
2. **No persistence.** The book, the tape and the candle series live in the
   backend process's memory: restarting the API starts a fresh market with the
   same seed but an empty history, so the chart opens with the explicit empty
   state ("nothing finished yet") and fills as candles close — about 2 minutes
   at `1s`, 2 hours at `1m` for the full 120-candle window.
3. **Determinism is same-run, not cross-run replay.** The seed makes a run
   reproducible trade-for-trade and the values are stable *within* a run, but
   candle timestamps are wall-clock buckets and history is accumulated as the
   process lives, not replayed from the seed on demand
   (`api/feed.go`, `TRACER NOTE`). Cross-run replay needs a virtual clock and a
   boot-time backfill — deliberately out of scope for this budget.
4. **Book frames carry the full 10×10 image**, not diffs. `seq`/`prevSeq` and
   the client's gap rule are real and pinned by tests (`web/lib/book-sync.test.ts`,
   `api/ws_test.go`), but the payload is the tracer version: diffs are the
   bandwidth optimisation a real venue would need and this demo does not.
5. **A silently half-open socket is not detected instantly.** If a path drops
   packets without a FIN, the client keeps its last frame on screen with the
   growing age label until the backend's 60 s idle reap closes the connection (a
   pong that never arrives is simply not reported). A client-side "no pong in
   N seconds → stale" rule would tighten this and is not in this build.
6. **Tier measurement is only as good as the browser's clock and the 2 s
   cadence.** Client-side timers are throttled in background tabs — which is why
   a hidden tab stops its session rather than reporting from a degraded timer.
7. **The interval set is fixed at `1s` and `1m`** (`api/main.go:intervals`), and
   the feedback loop between the two is one-way: the chart follows the toggle,
   and the toggle is not persisted in a URL or a cookie.
8. **No load, soak or cross-browser testing.** The target is one modern desktop
   browser; the burst scenario (~500 trades/s) is the only stress case, and it is
   a smoke test, not a benchmark.
9. **TLS is the host's job.** Local development and the compose demo are plain
    `http`/`ws`; a deployed UI needs a `wss://` backend (see
    [Deployment](#deployment)).
10. **The scenario injector has no UI.** It is a developer control over REST, by
    design (see [Debug controls](#debug-controls)) — a viewer of the page cannot
    trigger a market shock.

## Repo map

```
api/                     Go API: market generator, REST + WS, tier machine
  main.go  ws.go  tier.go  feed.go
  *_test.go              behavior tests per slice
  Dockerfile  .env.example
web/                     Next.js trading screen
  app/                   document shell + page (static prerender)
  components/            presentational panels + the one client island
  lib/                   networking + pure logic (React-free), hooks/ = React edges
  stores/                three Zustand stores per mounted session
  Dockerfile  .dockerignore  .env.example  vitest.config.ts
docs/
  PROTOCOL.md            wire contract (source of truth)
  SPEC.md                the spec, tracer bullets, stories, out of scope
  SEAMS.md               the three testable slices and where testing stops
  RECORDING.md           shot list for the screen recording
  DECISION-PRIMER.md     how the market model and thresholds were chosen
  agents/                issue-tracker and triage conventions
CONTEXT.md               ubiquitous language (glossary)
docker-compose.yml       one-command demo: api + web
```

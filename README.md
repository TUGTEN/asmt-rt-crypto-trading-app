# Pitchfork — real-time BTC-USD trading screen

One simulated BTC-USD market — a fixed seed, no database, no exchange, no API
keys — shown as a live trading screen: a candlestick chart with history and a
live candle, a self-healing top-10 order book, a streaming trade tape, and
per-connection **adaptive delivery** that stays correct when a connection
degrades. Open one URL and the market moves. The backend owns the market and
the delivery decision. The UI shows both, including when the screen is not
live. First-use words (*seed*, *book*, *tier*, *live* vs *stale*) are defined
in [`CONTEXT.md`](CONTEXT.md).

- **UI (deployed):** https://pitchfork.0kv.in (Vercel, Root Directory `web`).
- **API (deployed):** https://pf-api.0kv.in (NixOS + Cloudflare tunnel, custom domain; Fly/Render deferred).
- **Gates:** `go test -race ./...` green (api), `npm test` / `typecheck` / `lint` / `build` green (web), `docker compose up --build` verified end to end.
- **Demo:** [docs/assets/pitchfork-demo.webm](docs/assets/pitchfork-demo.webm) — 157 s silent take at 1920×1200 (<5 MB, no audio). What you are watching (story numbers from [`docs/SPEC.md`](docs/SPEC.md), full run sheet in [`docs/RECORDING.md`](docs/RECORDING.md)):
  - 0:00 live chart — ticker, growing candles, tape, shifting book (stories 2–6);
  - 0:24 interval switch 1s ⇄ 1m, no ghost candles (4, 18);
  - 0:48 book `gap` — `seq` jumps +6, one snapshot refetch (7, 17);
  - 1:00 forced tier minimal → degraded → automatic, candles unchanged (11–15);
  - 1:38 backend down — stale-while-dark, then reconnect + resubscribe + refetch (9, 16);
  - 2:04 injector trio — spike, halt, burst, clear (20).

| Document | What it is |
| --- | --- |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | **Source of truth for the wire** (REST + WS frames, gap rule, scenarios) |
| [`docs/SPEC.md`](docs/SPEC.md) | The spec this was built to: tracer bullets 0–5, stories, out-of-scope |
| [`docs/SEAMS.md`](docs/SEAMS.md) | The three testable vertical slices and where testing deliberately stops |
| [`CONTEXT.md`](CONTEXT.md) | Ubiquitous language (trade, book, delta, tier, live vs stale) |
| [`web/README.md`](web/README.md) | Frontend in depth: book merge, candle series, tiers, stores, tests |
| [`docs/RECORDING.md`](docs/RECORDING.md) | Automated recording pipeline (capture → render → web/webm) and the 6-shot run sheet |
| [`api/.env.example`](api/.env.example) | Every backend env var, annotated |

**Contents**

1. [One command](#one-command) · 2. [How a browser connects](#how-a-browser-connects-local-and-deployed) · 3. [Architecture](#architecture) · 4. [State management](#state-management) · 5. [Generated market data](#generated-market-data) · 6. [REST and WebSocket protocols](#rest-and-websocket-protocols) · 7. [Chart and book synchronization](#chart-and-book-synchronization) · 8. [Latency and jitter](#latency-and-jitter) · 9. [Tiers: thresholds, hysteresis, missing reports](#tiers-thresholds-hysteresis-missing-reports) · 10. [Reconnect, lifecycle, stale data](#reconnect-lifecycle-stale-data) · 11. [Debug controls](#debug-controls) · 12. [Configuration](#configuration) · 13. [Running it](#running-it) · 14. [Deployment](#deployment) · 15. [Packages used](#packages-used) · 16. [Known limitations](#known-limitations) · 17. [Repo map](#repo-map)

---

## One command

```bash
docker compose up --build      # → screen on http://localhost:3000, market on http://localhost:8080
```

This builds two small images (`api` 22 MB, `web` 292 MB), waits until
`/api/config` answers, then serves the screen. Open
<http://localhost:3000> — chart, book and tape are live in a second or two.
`docker compose down` stops it. A different market is one word:

```bash
SEED=7 TIER_FULL_MAX_MS=5 docker compose up --build   # new seed; a 5 ms full band moves tiers on a fast link
```

No Docker? One script builds and runs both binaries (ADR-0002):

```bash
./scripts/run-local.sh          # → screen on http://localhost:3000, market on http://localhost:8080
# or: curl -sSL https://raw.githubusercontent.com/TUGTEN/pitchfork/main/scripts/run-local.sh | sh
```

Ctrl-C stops both. `PORT`/`WEB_PORT`/`SEED` change the defaults.

Backend only, without Docker:

```bash
cd api && go run .             # → http://localhost:8080  (the market, not the page: it serves no HTML)
```

Local dev servers: `cd api && go run .` in one terminal,
`cd web && npm install && npm run dev` in another — see
[Running it](#running-it).

## How a browser connects (local and deployed)

The screen is the only page. There is no server proxy. The **browser**
uses `NEXT_PUBLIC_API_URL` plus the WS form of the scheme
(`http` → `ws`, `https` → `wss`) for the two sockets (market + chart):

| | Page | API the browser uses | Sockets |
| --- | --- | --- | --- |
| Local dev | `http://localhost:3000` (`npm run dev`) | `https://pf-api.0kv.in` (code default; `NEXT_PUBLIC_API_URL=http://localhost:8080` for a local backend) | market `wss://pf-api.0kv.in/ws?topics=book,trades&interval=1s` + chart `wss://pf-api.0kv.in/ws?topics=chart&interval=1s` (`1m` after a switch) |
| `docker compose up` | `http://localhost:3000` (container, published port) | `http://localhost:8080` (set at image build) | same, but `ws://` |
| Deployed | https://pitchfork.0kv.in (Vercel) | https://pf-api.0kv.in (Vercel env var, same as the code default) | `wss://pf-api.0kv.in/ws?...` |

Two results:

- `NEXT_PUBLIC_API_URL` is **set into the browser bundle at build time**, so
  a new host needs a rebuild (locally) or a redeploy (Vercel). After load, the
  Backend panel (preset list + free input) can redial any host with no rebuild
  and keeps the choice in `localStorage`. Details in
  [Configuration](#configuration).
- The API accepts any origin (`Access-Control-Allow-Origin: *` in
  `api/main.go:withCORS`, plus `InsecureSkipVerify` on the WS upgrade). This
  is a deliberate trade for a read-only market with no credentials: there is
  nothing to guard and no allow-list to keep in sync with the UI hostname.

With no backend, the screen says so (`down` / `connecting`, an empty chart).
It never shows invented data — the same
[stale-vs-live rule](#reconnect-lifecycle-stale-data) as everywhere else.

## Architecture

Two processes, one wire contract, nothing between them (no database, no
cache, no broker):

```
┌ api/ — Go 1.25, market + delivery ─────────────────────────────────────────┐
│                     env: PORT / SEED / SYMBOL / TIER_*                      │
│                                                                             │
│   feed.go    seeded GBM trade generator (100 ms tick, 1–3 trades)           │
│              + derived 10×10 book + one candle series per interval          │
│              + scenario injector (spike / halt / gap / burst / clear)       │
│   main.go    tick loop, REST routes, CORS, graceful shutdown                │
│                GET  /api/config      symbol, intervals, seed                │
│                GET  /api/snapshot    the book image (seq, 10×10)            │
│                GET  /api/history     finished candles, oldest first         │
│                GET  /api/scenario    armed/in-effect scenario or null       │
│                POST /api/scenario    inject one scripted event              │
│   ws.go      per-connection hub: tier frame, book frames with seq/          │
│              prevSeq, trade frames, throttled candle frames, ping/          │
│              pong echo, report/force intake                                 │
│   tier.go    ONE TierMachine per connection: full/degraded/minimal,         │
│              asymmetric hysteresis, miss budget, forced override            │
└─────────────────────────────────────────────────────────────────────────────┘

        ▲ REST: decimal strings, RFC3339Nano   ▲ WS: JSON text frames
        │                                      │
┌ web/ — Next.js 16 + React 19, screen ───────────────────────────────────────┐
│   app/page.tsx        server shell (static prerender, no fetch)             │
│   components/         presentational only: props in, JSX out, no fetch      │
│     TradingScreen.tsx the one client island: owns the session, hands       │
│                       each pane its slices of the stores                    │
│   lib/                networking + pure logic, React-free                   │
│     ws-client.ts      the session: dial, refetch, ping/report, reconnect    │
│     book-sync.ts      the merge: buffer, chain on prevSeq, signal gaps      │
│     candles.ts        the series: one entry per timestamp                   │
│     candle-chart.ts   the only writer to the chart library                  │
│     latency.ts        RTT / latency / jitter maths                          │
│     protocol.ts       wire types, runtime guards, REST fetchers             │
│     config.ts         env + timings, in one place                           │
│   stores/             live state: three Zustand stores per session          │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Backend.** `api/` is one Go module (`feed`). Each file has its tests next
to it: REST shapes, WS frames, tier changes, book recovery, candles,
scenarios.

**Frontend.** `web/` is Next.js App Router: a static shell plus one client
island. Fetching and sockets live in `lib/`, never in a component — the lint
config enforces this (`web/eslint.config.mjs`). The live path is testable
with no DOM: `lib/ws-client.ts` takes its socket, timers, clock, snapshot
call and stores by injection, and the tests drive it with a script.

[`docs/SEAMS.md`](docs/SEAMS.md) draws the test boundary: the three slices
(adaptive chart, self-healing book, trusted history) are tested at the wire.
Transport, canvas and deployment are covered by running the app.

## State management

Four kinds of state, four homes (frontend depth in
[`web/README.md`](web/README.md#live-state-zustand)):

| State | Home | Why |
| --- | --- | --- |
| Backend identity (`symbol`, `intervals`, `seed`) | `GET /api/config`, fetched once, kept in a hook | The UI must not copy backend config. If the server changes the symbol or intervals, the screen follows with no rebuild |
| REST history (per interval) | `lib/candle-history.ts` + a hook, guarded by request id and interval | A request/response is not a stream. A late response must be *droppable*, and that is a property of the request, not of a store |
| Live market (book, tape, candles, tier, session health) | Three small **Zustand** vanilla stores per mount (`stores/book.ts`, `candle.ts`, `conn.ts` via `stores/market.ts`) | A non-React module (the socket) writes at up to 10 Hz for many independent panes. Vanilla Zustand gives `setState` outside React and per-field selectors, so a 2 s pong cannot repaint the book |
| Chart pixels | `lib/candle-chart.ts`, called from one effect | The forming candle changes many times per second. Re-rendering React that often is the jank the spec forbids. The library gets bars built from *our* candles and nothing else |

Three stores, not one: panes select from different stores, and
`stores/market.test.ts` pins the property the layout needs — a write to one
store leaves the other stores unchanged, so a selector can skip a re-render.

Session life is state too. The hook that owns both sockets creates the
stores, so an unmount cannot inherit a dead session, and a hidden tab ends
the whole session (see
[Reconnect, lifecycle, stale data](#reconnect-lifecycle-stale-data)).

**Rejected:** one global context (re-renders the screen per frame — the 4 Hz
jank); Redux (three sinks and two sockets need no actions/reducers/devtools);
React Query for the socket (it models request/response, not a stream with
recovery rules); `socket.io` (its own protocol, over a wire contract this
project pins by hand in `docs/PROTOCOL.md`).

## Generated market data

One symbol, one market, no database. The seed is the fixture.

- **Model.** Geometric Brownian motion at `tickSigma = 0.0002` (≈0.02 % per
  100 ms tick) from $65,000, drawn from `math/rand` with `SEED` (default 42).
  Each 100 ms tick emits **1–3 trades** (`seq`, `ts`, `price`, `qty`): ~10–30
  trades/second on the tape.
- **Exactness.** Money crosses the wire as **decimal strings**
  (`"65230.39"`, `"0.024371"`), formatted from scaled integers. The UI shows
  the strings and never re-rounds a float. Time is UTC `RFC3339Nano`.
- **Order.** Each market message has a monotonic `seq`. Trades and book
  images use *separate* counters (a trade id means nothing next to a book
  id). Book frames carry `prevSeq` to chain their own line.
- **Book.** Derived from the trade mid on each tick: 10 bids and 10 asks from
  3 bps out in 2 bps steps, exponential sizes (mean ≈0.06 BTC), all as decimal
  strings. Each frame carries the full 10×10 image in this build — the ids
  still hold, so gap detection is real (see
  [limitations](#known-limitations)).
- **Candles.** The feed folds the same trade stream into one series per
  interval (`1s`, `1m`): a live bucket plus finished buckets. `/api/history`
  and the WS candle stream read the **same** series, so REST history and the
  live chart cannot disagree (story 21).
- **Scenarios.** A named event can be scripted onto the feed: `spike` (one
  ~10σ step, +0.19 % on the composed stack), `halt` (5 s of silence, book
  still served), `gap` (next book frame skips 5 ids — `seq` jumps, one
  refetch), `burst` (~500 trades in one second), `clear` (disarm). Full table
  in [`docs/PROTOCOL.md`](docs/PROTOCOL.md#scenario-injector); demo use in
  [Debug controls](#debug-controls).

## REST and WebSocket protocols

[`docs/PROTOCOL.md`](docs/PROTOCOL.md) is the contract. Change it first, in
the same commit as both sides. Summary:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config` | `{"symbol","intervals","seed","protocol":2}` — what this deployment simulates (the UI's only source for symbol/intervals) |
| `GET /api/snapshot` | `{seq, bids[[p,q]×10], asks}` — the book image the merge re-bases on |
| `GET /api/history?interval=1s\|1m&limit=N` | `{interval, candles[[t,o,h,l,c,v]]}` oldest-first, `[]` never `null`; bad input → `400 {"error":"…"}` |
| `GET /api/active` | Optional debug helper in PROTOCOL.md, **not implemented**: nothing uses it (chart = history + frames, tape = `trade` frames) |
| `GET`/`POST /api/scenario` | Read/inject a scripted event; unknown name → `400` with the accepted names |
| `GET /ws?topics=book,trades,chart&interval=1s` | The stream: `tier`, `book`, `trade`, `candle`, `pong` frames |

Rules: decimal strings for money, UTC `RFC3339Nano` time, an ordering id on
each market message. Market data uses compact tuples
(`["trade",seq,ts,price,qty]`, `["book",seq,prevSeq,bids,asks]`,
`["candle",interval,t,o,h,l,c,v,complete]`), versioned by `protocol: 2`.
Control frames and REST envelopes stay named-key objects and accept new
fields with no version change. The server answers `400` + JSON for anything
it cannot honour — never a silent fallback. The client narrows each payload
from `unknown` with a runtime guard; bad frames are counted and dropped, not
allowed to poison the stream.

## Chart and book synchronization

**Book — five rules** (`lib/book-sync.ts`, pinned by
`lib/book-sync.test.ts`):

1. **Buffer while the snapshot flies.** The socket opens first, so book
   frames arrive before `/api/snapshot` resolves. Hold them, never apply
   them.
2. **Drop what the snapshot covers** (`seq ≤ snapshot.seq`), then replay the
   newer frames in order.
3. **Apply only on a parent match** — a frame lands when its `prevSeq` is the
   last applied `seq`. A `null` `prevSeq` claims no parent and never chains.
4. **Refetch on anything else.** A non-chaining frame is a `gap`: freeze the
   image, fetch a fresh snapshot, resume on it. Never show the unbased
   frame.
5. **Bound the buffer.** Past the limit, drop the oldest frame — it surfaces
   as a gap, never as a book built on a hole.

A reconnect is a new session: the merger resets, an in-flight snapshot from
the dead session is aborted and ignored, and the book re-syncs from a fresh
snapshot. Repeat gaps refetch at once; a run of gaps trips a breaker
(`MAX_RESYNC_ATTEMPTS`) back to the retry pace, so a disagreeing feed cannot
cause a hot fetch loop. The first chaining frame resets it. `gap` triggers a
break on demand; killing the socket shows the same path when the whole
session is lost.

**Chart — one series from two doors** (`stores/candle.ts` +
`lib/candles.ts`):

- History opens the chart (`/api/history`, 120 candles, oldest first). A
  response counts only if it echoes the on-screen interval *and* the request
  id that asked for it — a late response after a switch is dropped, never
  painted (no ghost candles).
- Live `candle` frames extend it: a finished bucket replaces a forming bucket
  with the same time; one entry per time, always. Duplicates collapse; late
  buckets slot in by time.
- A reconnect bumps the history epoch and re-reads the series — candle frames
  only reached the socket that just ended.
- A 1s↔1m switch ends only the chart session. The market socket (book +
  trades) is dialled once per mount and never mentions the chart interval, so
  book and tape stay live while the chart reloads on its new socket.
- The chart library only draws: `lib/candle-chart.ts` builds bars from our
  aggregation, and hover/click/drag reads back *our* candle by time. No shown
  OHLCV is the library's own math.

**The invariant:** tier changes *delivery*, never *values*. The feed owns the
aggregation; a slow tier holds finished candles for their slot and re-sends
the live candle only when it moves. `api/candle_test.go` and
`api/tier_ws_test.go` prove the same seeded stream gives byte-identical final
OHLCV at all three tiers.

## Latency and jitter

The client measures; the backend decides. Each 2 s (`PING_INTERVAL_MS`, fixed
by the protocol) the client sends `{"type":"ping","tSend":<ms>}`. The backend
echoes the stamp in a `pong`. The client computes:

```
RTT     = tRecv − tSend                (tRecv is the backend UTC time)
latency = RTT / 2
jitter  = EMA(|RTT − prevRTT|)         (α = 0.5)
```

and reports `{"type":"report","latencyMs":…,"jitterMs":…}` on the same tick.
Half the RTT is the honest per-direction value for a symmetric link, and the
tier bands use it. The EMA keeps one spike from owning the report while still
fading in a few probes. An unbelievable pong — unreadable stamp, a reply
older than its ping, a trip past `MAX_RTT_MS` (60 s: a frozen tab, not a
reading) — is dropped, not reported. With one sample, jitter is `0`: the
honest reading of no spread.

The Delivery panel shows the backend tier and chart rate next to RTT /
latency / jitter, so adaptive behaviour is visible, not folklore.

## Tiers: thresholds, hysteresis, missing reports

One socket is one tier machine, owned by the backend (`api/tier.go`). The
client never computes its own tier.

| Tier | Probe that wants it | Chart rate | On screen |
| --- | --- | --- | --- |
| `full` | latency ≤ **150 ms** *and* jitter ≤ **50 ms** | **4 Hz** | Chart moves many times per second |
| `degraded` | latency ≤ **300 ms** | **1 Hz** | Visible step down; finished candles identical |
| `minimal` | anything slower | **0.25 Hz** | One chart update per 4 s; only the *rate* changed |

Scope: the tier throttles the **chart** stream only (story 11) — the live
candle and queued finished candles. Book frames and the tape keep their own
pace (one image per book change, one frame per trade, bounded per pass), so
`minimal` slows the candles and the announced rate without changing what the
book shows.

- **Hysteresis is asymmetric: 3 probes down, 5 up**, one tier at a time.
  Votes reset on a disagreeing probe. Down is fast because a slow client is
  already missing freshness; up is slow because a briefly lucky client must
  not flap into a rate it cannot hold. A lone spike changes nothing
  (`api/tier_ws_test.go`).
- **Silence is a signal.** A client that stops reporting — stalled tab, hung
  proxy — cannot report slowness, so it counts: **3 empty windows →
  degraded, 6 → minimal**
  (`api/tier_ws_test.go:TestTierFallsBackWhenReportsStopArriving`). Any
  report resets the miss count.
- **The debug override wins while set**, at once (not next window): a pressed
  button must move the badge now. Clearing (`{"type":"force","tier":null}`)
  hands back the decision — the probes place the connection, so clearing
  often shows an unclicked tier. That is the point; the badge flips from
  "forced" to "automatic".
- **A reconnect starts a new machine at `full`** with no override — so the
  client re-sends a standing override on open, or the badge would read
  "forced" over a backend back on automatic.
- **Each number is config**: `TIER_FULL_MAX_MS`, `TIER_DEGRADED_MAX_MS`,
  `TIER_MAX_JITTER_MS`, `TIER_DOWN_VOTES`, `TIER_UP_VOTES`,
  `TIER_MISS_DEGRADED`, `TIER_MISS_MINIMAL`
  ([`api/.env.example`](api/.env.example)). A bad value fails startup, never
  a silent fallback — the badge shows these numbers
  (`api/tier_ws_test.go:TestTierBandsComeFromConfig`).

Why these numbers: 150 ms tops "interactive" (faster is instant on a desktop
screen); 300 ms is where a chart visibly lags the tape; 50 ms jitter on an
otherwise fast link means contended Wi-Fi, where 4 Hz would arrive in bursts.
Defaults, not constants — and all config.

## Reconnect, lifecycle, stale data

- **Live** = connected, subscribed, holding fresh data. **Stale** = cached
  values on screen while disconnected, unsubscribed or hidden. Cached values
  are dimmed and labelled, never shown as live (`CONTEXT.md`: Live vs
  Stale).
- **A dropped socket redials with capped exponential backoff** (500 ms,
  doubling to 8 s: `RECONNECT_BASE_MS` / `RECONNECT_MAX_MS`). Topics *and*
  chart interval live in the socket URL, so redial **is** resubscribe: a new
  market session re-syncs the book from a fresh snapshot, a new chart session
  re-reads history, and the merger starts clean.
- **A failed snapshot** keeps the merger buffering and retries
  (`SNAPSHOT_RETRY_MS`): a blip in recovery never leaves the book unbased.
- **A hidden tab stops, not pretends.** `document.hidden` ends the session
  (both sockets, ping timer, stores marked stale); visible dials new ones. A
  hidden tab gathers no data, and its throttled timers would feed the backend
  false readings — "not running" beats "labelled cached".
- **Nothing leaks.** The hook that owns the session
  (`lib/hooks/useMarketStream.ts`) disposes listener, sockets, timers,
  stores and chart instance. An unmount leaves nothing behind.

## Debug controls

**Tier override (in the UI).** DEBUG panel buttons ask for `full`,
`degraded`, `minimal`; *automatic* clears the override. Each click is one
`force` frame; the badge shows the `tier` frame the backend returns. Three
states, never flattered: `automatic`, `forced <tier> via debug control`, or
`asked for <tier> — not in force yet` (frame not yet back, or socket down).

**Scenario injector (developer control, REST).** One known event on the
seeded feed, so a demo or test never waits for luck. The response is the
injector state, so a control shows the truth, not its last ask:

```bash
curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"spike"}'   # one ~10σ step up on the next tick
curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"halt"}'    # 5 s of silence, book still served
curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"gap"}'     # next book frame skips 5 ids (seq jumps, recovery +1 refetch)
curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"burst"}'   # ~500 trades in the next second
curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"clear"}'   # disarm (also ends halt/burst now)
curl -s localhost:8080/api/scenario                                     # {"scenario":…|null}
```

No injector button in the UI, on purpose: it moves the market, and the
screen is a market view, not a cockpit. The recording drives it from a
terminal, which shows the command behind each event.

**Wire watching.** DevTools → Network → WS shows frames as they arrive
(tagged tuples `“trade”`/`“book”`/`“candle”` at index 0; named keys for
`tier`/`pong`). For REST,
`curl -s localhost:8080/api/config | jq` and
`curl -s "localhost:8080/api/history?interval=1s&limit=3" | jq` show the
decimal-string and ordering-id rules fastest.

## Configuration

**Backend** (each var, with defaults, in
[`api/.env.example`](api/.env.example)):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP/WS port |
| `SEED` | `42` | Market seed: same seed, same trades, same candles |
| `SYMBOL` | `BTC-USD` | Symbol in `/api/config` and on screen |
| `TIER_*` | 150 / 300 / 50 / 3 / 5 / 3 / 6 | Delivery bands and vote budgets above |

**Frontend** (one var, plus fixed timings):

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `https://pf-api.0kv.in` | Backend base URL, set at build time ([`web/.env.example`](web/.env.example)) |

All other client numbers — ping pace, backoff, retry waits, history depth,
buffer bounds, tape size, jitter α — are fixed constants in
[`web/lib/config.ts`](web/lib/config.ts), with reasons in
[`web/README.md`](web/README.md#latency-tiers-and-reconnect). Fixed on
purpose: they are the client's own behaviour, and a deployment that changed
them with no rebuild would change the client's contract with backend
tiering.

Two deliberate asymmetries:

- **Intervals (`1s`, `1m`) are code, not env.** One place
  (`api/main.go:intervals`), published by `/api/config`, checked by
  `/api/history` and `/ws`, shown in the URL. The feed folds exactly these
  buckets: an interval it does not fold would serve empty history, which is a
  worse lie than not offering it.
- **The UI never copies backend config.** Symbol, intervals and seed come
  from `/api/config` at runtime; the frontend hard-codes only its default
  backend URL.

**No hidden hosts.** In shipped code — `api/*.go`, `web/lib`,
`web/stores`, `web/components`, `web/app` — `localhost`, `127.0.0.1`,
`:8080`, `:3000` occur exactly once: the default `DEFAULT_API_BASE_URL` in
[`web/lib/config.ts`](web/lib/config.ts). All else is env (backend) or
`/api/config` (frontend). The strings recur only in container plumbing that
names its own loopback (health probes in both Dockerfiles,
`docker-compose.yml`) and in the two `.env.example` defaults.

## Running it

### Local dev (two processes, hot reload)

```bash
# terminal 1 — the market
cd api && go run .               # :8080 — symbol=BTC-USD seed=42 intervals=1s,1m tick=100 ms

# terminal 2 — the screen
cd web && npm install && npm run dev        # → http://localhost:3000
```

Copy `web/.env.example` to `web/.env.local` to use a backend other than
`http://localhost:8080`. Backend env is by export (`PORT=9000 go run .`) —
the app reads no `.env` file itself.

### Tests and gates

| Command | Where | Covers | Last run |
| --- | --- | --- | --- |
| `go test -race ./...` | `api/` | REST shapes, WS frames, tier hysteresis + miss fallback + override precedence + config-driven bands, book recovery, candles (incl. byte-identical across tiers), scenario injector | pass |
| `npm test` | `web/` | 257 tests over the pure layer: protocol guards, book merge, candle series, history request ids, latency maths, socket session, tier readout, tab lifecycle, store isolation, watchlist order | pass |
| `npm run typecheck` | `web/` | `tsc --noEmit` | pass |
| `npm run lint` | `web/` | eslint (incl. "no fetch in components") | pass |
| `npm run build` | `web/` | production build, deploy-clean with no special config | pass |
| `docker compose up --build` | repo root | the real thing: both images, API health, page served, WS handshake | pass |

Tests assert **outside behaviour only** — outgoing frames, tier changes,
merged books, folded candles — never call order or store shape. Both sides
use the same shape: a fixed seed plus a scripted protocol, so each test
reads as *given this seed and this script, this is what a browser sees*.

## Deployment

Landed: UI on Vercel (https://pitchfork.0kv.in), API on a NixOS box through
a Cloudflare tunnel at a custom domain (https://pf-api.0kv.in). Nothing here
waits on hosting — the images and the config are the answer, and any host
takes the same code. Fly.io/Render as container host is deferred (both
errored).

### UI → Vercel

No `vercel.json`, no custom output, no Vercel-only code. The page is a static
shell plus a client island.

1. Push the repo to a public GitHub remote (no secrets to leak).
2. Vercel → **Add New… → Project → Import** the repository.
3. **Root Directory: `web`**. Keep preset **Next.js**; keep default
   build/install commands.
4. **Settings → Environment Variables**: `NEXT_PUBLIC_API_URL` =
   `https://pf-api.0kv.in` for Production *and* Preview. Deploy. (Matches the
   code default in `web/lib/config.ts`.)
5. After the backend lands, set the var and **redeploy**: it is set at build
   time, so a var change alone moves nothing.

No `output: "standalone"` in `next.config.ts`: standalone lets a self-hosted
Node run with no full `node_modules` tree — the Docker case, and only
`web/Dockerfile` turns it on (`BUILD_STANDALONE=1`). Always-on broke Vercel
builds on this Next line
([vercel/next.js#96646](https://github.com/vercel/next.js/issues/96646)), and
Vercel needs no standalone.

No var set is still valid: the browser falls back to the code default
(`https://pf-api.0kv.in`); if that fails, the screen shows `down` with an
empty chart. No invented market.

### API → NixOS + Cloudflare tunnel (live at https://pf-api.0kv.in)

The API runs as a plain process on a NixOS box on `:8080`. A declarative
`services.cloudflared` tunnel maps it to `pf-api.0kv.in` (one hostname →
`http://localhost:8080`). Cloudflare ends TLS, so the `https://` page gets
`wss://` with no extra work.

Any container host needs only this: **one TCP port with WS upgrade** — no
disk, no secrets, no cron. `api/Dockerfile` builds a 22 MB image, and
`docker compose up` is the same stack locally, so deploy is
`docker run -p 8080:8080 -e SEED=42 <image>` on any host (Fly.io, Railway,
Render, small VM) with TLS in front — the browser blocks `ws://` from an
`https://` page, so the host must end TLS and offer `wss://`. Fly.io/Render
are deferred (both errored in setup); `api/fly.toml` stays as the starter.

A later move changes no code path: one env var (`NEXT_PUBLIC_API_URL`) plus
a UI redeploy — the "local and deployed differ by config, not code" rule.

Both hosts are live (top of this file);
[`docs/RECORDING.md`](docs/RECORDING.md) is the automated pipeline that recorded the demo above.

## Packages used

**Backend** (`api/go.mod`, module `feed`, Go directive 1.24 — built with 1.25):

| Package | Why |
| --- | --- |
| Go standard library | `net/http` for REST and WS upgrade, `encoding/json`, `math/rand` for the seeded generator, `context`/`os/signal` for clean stop. The market logic is small — a framework would be more code, not less |
| [`nhooyr.io/websocket`](https://github.com/coder/websocket) v1.8.17 | The only dependency. Small, context-first (`Read`/`Write` take contexts, so waits and stop use stdlib form), and it shows the hijacked connection life-cycle for clean hub close on SIGTERM. Rejected: `gorilla/websocket` (larger API, own wait model), `golang.org/x/net/websocket` (deprecated) |

**Frontend** (`web/package.json`):

| Package | Why |
| --- | --- |
| `next` 16.3.5 + `react`/`react-dom` 19.2.8 | App Router: static shell with one client island, zero-config Vercel deploys, project lint rules in the box |
| `zustand` ^5.0.15 | The live store: `setState` callable from the React-free socket module, per-field selectors, no provider tree |
| `lightweight-charts` ^5.2.1 | Candlesticks with hover/click/drag and a canvas that holds 4 Hz updates. Rejected: hand-drawn canvas (pixels, not sync) and heavier stacks (re-render React per frame) |
| `tailwindcss` ^4 (+ `@tailwindcss/postcss`) | Design tokens and layout in the markup; components stay presentational |
| `vitest` ^3.2.7 | Fast, TS-native unit tests for the pure layer (~1.5 s for 257 tests) |
| `typescript` ^5, `eslint` ^9 + `eslint-config-next` | Types on the wire path (no `any`; payloads narrowed from `unknown`); lint enforces the layer rule |

No database driver, no ORM, no broker, no state framework, no client socket
library (the browser `WebSocket` is enough).

## Known limitations

Honest list, in the order a reader meets them:

1. **One live symbol, display only.** BTC-USD streams — no order entry, no
   accounts, no login. Watchlist bonus is reorder-only: static reference rows
   (ETH/SOL/DOGE) that park the chart when picked, order kept in
   `localStorage`.
2. **No persistence.** Book, tape and candles live in backend memory: a
   restart starts a fresh market with the same seed but empty history, so the
   chart opens with an explicit empty state ("nothing finished yet") and fills
   as candles close — ~2 minutes at `1s`, 2 hours at `1m` for 120 candles.
3. **Same-run determinism, not cross-run replay.** The seed fixes
   trade-for-trade values *in* a run, but candle times are wall-clock buckets
   and history folds as the process lives (`api/feed.go`, `TRACER NOTE`).
   Cross-run replay needs a virtual clock and boot backfill — out of scope.
4. **Book frames carry the full 10×10 image**, not diffs. `seq`/`prevSeq`
   and the gap rule are real and tested (`web/lib/book-sync.test.ts`,
   `api/ws_test.go`); diffs are the bandwidth cut a real venue needs and
   this demo does not.
5. **A half-open socket shows at once, not instantly.** A path that drops
   packets with no FIN keeps the last frame on screen with a growing age
   label until the backend 60 s idle reap closes it (a pong that never comes
   is simply not reported). A client "no pong in N seconds → stale" rule
   would tighten this; not in this build.
6. **Tier readings are only as good as the browser clock and the 2 s pace.**
   Background tabs throttle client timers — which is why a hidden tab ends
   its session instead of reporting from a weak timer.
7. **Intervals are fixed at `1s` and `1m`** (`api/main.go:intervals`), and
   the loop is one-way: the chart follows the toggle, and the toggle lives in
   no URL or cookie.
8. **No load, soak or cross-browser tests.** Target is one modern desktop
   browser; the burst scenario (~500 trades/s) is a smoke test, not a
   benchmark.
9. **TLS is the host's job.** Local and compose use plain `http`/`ws`; a
   deployed UI needs a `wss://` backend (see
   [Deployment](#deployment)).
10. **The injector has no UI.** Developer control over REST, by design (see
    [Debug controls](#debug-controls)) — a page viewer cannot shock the
    market.

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
  RECORDING.md           automated pipeline + 6-shot run sheet for the demo video
  agents/                issue-tracker and triage conventions
CONTEXT.md               ubiquitous language (glossary)
docker-compose.yml       one-command demo: api + web
```

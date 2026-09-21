# Pitchfork — real-time BTC-USD trading screen

One simulated BTC-USD market — fixed seed, no database, no exchange, no keys —
as a live screen: candlestick chart with history and a live candle, a
self-healing top-10 book, a trade tape, and per-connection **adaptive
delivery**. The backend owns the market and the delivery decision; the UI
shows both, including when not live. Terms (*seed*, *book*, *tier*, *live* vs
*stale*) are in [`CONTEXT.md`](CONTEXT.md).

- **UI (deployed):** https://pitchfork.0kv.in (Vercel, Root Directory `web`).
- **API (deployed):** https://pf-api.0kv.in (NixOS + Cloudflare tunnel; Fly/Render deferred).
- **Gates:** `go test -race ./...` (api), `npm test` / `typecheck` / `lint` / `build` (web), `docker compose up --build` — all green.
- **Demo:** [docs/assets/pitchfork-demo.webm](docs/assets/pitchfork-demo.webm) — 157 s silent take, 1920×1200, <5 MB. What you are watching (stories in [`docs/SPEC.md`](docs/SPEC.md), run sheet in [`docs/RECORDING.md`](docs/RECORDING.md)):
  - 0:00 live chart — ticker, candles, tape, book (2–6);
  - 0:24 interval 1s ⇄ 1m, no ghost candles (4, 18);
  - 0:48 book `gap` — `seq` +6, one refetch (7, 17);
  - 1:00 forced tier minimal → degraded → automatic (11–15);
  - 1:38 backend down — stale, then reconnect + refetch (9, 16);
  - 2:04 injector trio — spike, halt, burst, clear (20).

Detail homes: [`docs/PROTOCOL.md`](docs/PROTOCOL.md) = wire contract ·
[`docs/SPEC.md`](docs/SPEC.md) = spec · [`docs/SEAMS.md`](docs/SEAMS.md) =
test boundary · [`CONTEXT.md`](CONTEXT.md) = words ·
[`web/README.md`](web/README.md) = frontend depth ·
[`docs/RECORDING.md`](docs/RECORDING.md) = demo pipeline ·
[`api/.env.example`](api/.env.example) = backend env.

---

## One command

```bash
docker compose up --build      # → screen :3000, market :8080
```

Builds `api` (22 MB) + `web` (292 MB), waits for `/api/config`, serves the
screen — live in a second or two. `docker compose down` stops it.

```bash
SEED=7 TIER_FULL_MAX_MS=5 docker compose up --build   # new seed; narrow full band
./scripts/run-local.sh                                # no Docker: builds + runs both (Ctrl-C stops)
cd api && go run .                                    # backend only (the market, not the page)
```

`PORT`/`WEB_PORT`/`SEED` change the defaults. Local dev servers: `cd api &&
go run .` plus `cd web && npm install && npm run dev` (see
[Running it](#running-it)).

## How a browser connects (local and deployed)

No proxy: the **browser** talks to the API direct, via `NEXT_PUBLIC_API_URL`
(`http`→`ws`, `https`→`wss`) on two sockets (market: book+trades; chart:
candles). Local dev uses the code default `https://pf-api.0kv.in` (or
`NEXT_PUBLIC_API_URL=http://localhost:8080` for a local backend); compose
bakes in `http://localhost:8080`; deployed is https://pitchfork.0kv.in +
https://pf-api.0kv.in.

The URL is **set at build time**, so a new host needs a rebuild/redeploy —
but the Backend panel can redial any host at runtime (kept in
`localStorage`). The API accepts any origin (`Access-Control-Allow-Origin:
*`): deliberate for a read-only market with no credentials. No backend → the
screen shows `down` + empty chart, never invented data
([stale-vs-live](#reconnect-lifecycle-stale-data)).

## Architecture

Two processes, one wire contract, nothing between (no DB, cache, broker).

| Backend (`api/`, Go, module `feed`) | |
| --- | --- |
| `feed.go` | seeded GBM trades (100 ms tick, 1–3), derived 10×10 book, candle series, injector |
| `main.go` | tick loop, REST routes, CORS, shutdown |
| `ws.go` | hub: sessions, topics/interval, tiered delivery, ping/pong, report/force |
| `tier.go` | one machine per connection: bands, votes, miss budget, override |

| Frontend (`web/`, Next.js + React) | |
| --- | --- |
| `app/page.tsx` | static shell, no fetch |
| `components/` | presentational only; `TradingScreen.tsx` is the one client island |
| `lib/` | networking + pure logic: session, book merge, candle series, chart writer, maths, guards, config |
| `stores/` | three Zustand stores per session |

Fetching/sockets live in `lib/`, never in components (lint-enforced); the
live path is testable with no DOM (injected socket, timers, stores).
[`docs/SEAMS.md`](docs/SEAMS.md) marks the test boundary: the three slices
are wire-tested; transport, canvas, deployment are covered by running the
app.

## State management

| State | Home | Why |
| --- | --- | --- |
| Backend identity (symbol, intervals, seed) | `GET /api/config`, once | UI never copies backend config; server changes need no rebuild |
| REST history per interval | `lib/candle-history.ts` + hook, request-id guarded | Late responses must be *droppable* — a property of the request, not a store |
| Live market (book, tape, candles, tier, health) | three vanilla Zustand stores per mount | Non-React socket writes at ≤10 Hz; per-field selectors stop a pong repainting the book |
| Chart pixels | `lib/candle-chart.ts`, one effect | Per-second React re-renders are the jank the spec forbids |

Three stores (not one) so panes select independently — a write to one leaves
the others untouched. The socket-owning hook creates the stores, so no dead
session leaks into a remount. Rejected: global context (per-frame
re-renders), Redux (overkill), React Query (request/response, not streams),
`socket.io` (own protocol over our pinned wire).

## Generated market data

One symbol, no database; the seed is the fixture.

- **Model.** GBM at `tickSigma = 0.0002` from $65,000 (`math/rand`, `SEED`
  default 42). 1–3 trades per 100 ms tick → ~10–30 trades/s.
- **Exactness.** Money as **decimal strings** from scaled integers (UI never
  re-rounds); time as UTC `RFC3339Nano`.
- **Order.** Monotonic `seq` per message; trades and book use *separate*
  counters; book frames chain via `prevSeq`.
- **Book.** From trade mid each tick: 10 bids + 10 asks, 3 bps out in 2 bps
  steps, ~0.06 BTC mean. Full 10×10 image per frame (tracer; diffs deferred —
  see [limitations](#known-limitations)).
- **Candles.** One series per interval (`1s`, `1m`), shared by `/api/history`
  and WS — REST and live cannot disagree (story 21).
- **Scenarios.** Scripted feed events: `spike` (+~10σ), `halt` (5 s silence),
  `gap` (skip 5 book ids → refetch), `burst` (~500 trades/s), `clear`
  (disarm). Table in
  [`docs/PROTOCOL.md`](docs/PROTOCOL.md#scenario-injector).

## REST and WebSocket protocols

[`docs/PROTOCOL.md`](docs/PROTOCOL.md) is the contract — change it first,
same commit as both sides.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config` | `{"symbol","intervals","seed","protocol":2}` — UI's only source for symbol/intervals |
| `GET /api/snapshot` | `{seq, bids, asks}` — book image to re-base on |
| `GET /api/history?interval=1s\|1m&limit=N` | `{interval, candles[[t,o,h,l,c,v]]}`, oldest-first, `[]` never `null`; bad input → `400` |
| `GET /api/active` | optional helper, **not implemented** (nothing uses it) |
| `GET`/`POST /api/scenario` | read/inject an event; unknown name → `400` |
| `GET /ws?topics=…&interval=…` | stream: `tier`, `book`, `trade`, `candle`, `pong` |

Market data = compact tuples (`["trade",seq,ts,price,qty]`,
`["book",seq,prevSeq,bids,asks]`,
`["candle",interval,t,o,h,l,c,v,complete]`), versioned by `protocol: 2`;
control frames stay named-key objects (additive fields need no bump). Server
says `400` + JSON when it cannot honour — never silent fallback. Client
narrows each payload from `unknown`; bad frames are counted and dropped.

## Chart and book synchronization

**Book** (`lib/book-sync.ts`): buffer frames while the snapshot flies; drop
what it covers (`seq ≤ snapshot.seq`); apply only on parent match
(`prevSeq` = last `seq`); otherwise freeze + refetch (never show unbased
frames); bound the buffer (overflow surfaces as a gap). Reconnect = new
session: merger resets, dead snapshot aborted, fresh re-sync; repeat gaps
refetch at once, a gap run trips a breaker (`MAX_RESYNC_ATTEMPTS`) to stop
hot loops. `gap` triggers it on demand; a killed socket shows the same path.

**Chart** (`stores/candle.ts` + `lib/candles.ts`): history opens (120
candles); a response counts only for the on-screen interval + request id (no
ghost candles). Live frames extend it — one entry per time, duplicates
collapse, late buckets slot by time. Reconnect re-reads history. Interval
switch ends only the chart session; book + tape stay live. The library only
draws — hover reads *our* candle by time.

**Invariant:** tiers change *delivery*, never *values* — same seeded stream
gives byte-identical OHLCV at all tiers (`api/candle_test.go`,
`api/tier_ws_test.go`).

## Latency and jitter

Client measures, backend decides. Each 2 s the client pings
(`{"type":"ping","tSend"}`); backend echoes in `pong`:

```
RTT     = tRecv − tSend
latency = RTT / 2
jitter  = EMA(|RTT − prevRTT|), α = 0.5
```

Reported back each tick (`report` frame). Unbelievable pongs (bad stamp,
older than ping, >60 s trip) are dropped; one sample ⇒ jitter `0`. The
Delivery panel shows tier + chart rate beside RTT/latency/jitter.

## Tiers: thresholds, hysteresis, missing reports

One socket = one backend tier machine (`api/tier.go`).

| Tier | Wants | Chart rate | On screen |
| --- | --- | --- | --- |
| `full` | latency ≤ **150 ms** and jitter ≤ **50 ms** | **4 Hz** | moves many times per second |
| `degraded` | latency ≤ **300 ms** | **1 Hz** | step down; candles identical |
| `minimal` | slower | **0.25 Hz** | one update per 4 s; rate only |

Tier throttles the **chart only** (story 11); book + tape keep their pace.
**3 probes down, 5 up**, one tier at a time, votes reset on disagreement — a
lone spike changes nothing. Silence counts: **3 empty windows → degraded, 6
→ minimal**; any report resets. Debug override wins at once; clearing hands
back to probes (often an unclicked tier — the point). Reconnect starts at
`full` with no override, so the client re-sends a standing one. All numbers
are `TIER_*` env ([`api/.env.example`](api/.env.example)); bad values fail
startup. Rationale: 150 ms ≈ instant, 300 ms = visible lag, 50 ms jitter =
contended Wi-Fi. Defaults, not constants.

## Reconnect, lifecycle, stale data

- **Live** = connected + subscribed + fresh. **Stale** = cached values while
  down/unsubscribed/hidden — dimmed, labelled, never live.
- Dropped socket redials with capped backoff (500 ms → 8 s). Topics + chart
  interval live in the URL, so redial **is** resubscribe (fresh snapshot,
  re-read history).
- Failed snapshot keeps buffering + retries (`SNAPSHOT_RETRY_MS`).
- Hidden tab **ends** the session (throttled timers would feed false
  readings); visible dials new ones.
- Owning hook (`lib/hooks/useMarketStream.ts`) disposes everything — no
  leaks on unmount.

## Debug controls

DEBUG buttons ask `full`/`degraded`/`minimal` (one `force` frame each);
*automatic* clears. Badge shows the returned `tier`: `automatic`, `forced
<tier>`, or `asked — not in force yet`.

```bash
curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"spike"}'   # ~10σ step, next tick
curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"halt"}'    # 5 s silence, book served
curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"gap"}'     # skip 5 ids → refetch
curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"burst"}'   # ~500 trades in 1 s
curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"clear"}'   # disarm
curl -s localhost:8080/api/scenario                                     # armed now, or null
```

No UI button by design (screen = market view, not cockpit); the recording
drives it from a terminal. Wire-watch via DevTools → Network → WS, or
`curl -s localhost:8080/api/config | jq`.

## Configuration

| Backend var | Default | Meaning |
| --- | --- | --- |
| `PORT` / `SEED` / `SYMBOL` | `8080` / `42` / `BTC-USD` | port; same seed ⇒ same market; symbol on screen |
| `TIER_*` | 150 / 300 / 50 / 3 / 5 / 3 / 6 | bands + vote budgets (see Tiers) |

`NEXT_PUBLIC_API_URL` (default `https://pf-api.0kv.in`) is the only frontend
var — set at build time. Other client numbers (ping, backoff, depths,
bounds, jitter α) are fixed in [`web/lib/config.ts`](web/lib/config.ts):
client behaviour must not change without a rebuild. Intervals (`1s`, `1m`)
are code (`api/main.go:intervals`), not env — the feed folds exactly these.
Symbol/intervals/seed come from `/api/config` at runtime; the frontend
hard-codes only its default URL. `localhost`/`:8080`/`:3000` occur once in
shipped code (`DEFAULT_API_BASE_URL`); elsewhere only in container plumbing
and `.env.example` defaults.

## Running it

```bash
cd api && go run .                  # terminal 1 — the market (:8080)
cd web && npm install && npm run dev   # terminal 2 — the screen (:3000)
```

`web/.env.local` (from `.env.example`) points at another backend; backend
env is by export (`PORT=9000 go run .`).

| Command | Where | Covers |
| --- | --- | --- |
| `go test -race ./...` | `api/` | REST, WS frames, tiers, book recovery, candles, injector |
| `npm test` | `web/` | 257 pure-layer tests: guards, merge, series, maths, session, stores |
| `npm run typecheck` / `lint` / `build` | `web/` | `tsc`, eslint (no fetch in components), production build |
| `docker compose up --build` | root | both images, API health, page, WS handshake |

Tests assert outside behaviour only (frames, transitions, merged books,
candles) — seeded fixture + scripted protocol throughout.

## Deployment

UI on Vercel (https://pitchfork.0kv.in), API on NixOS via Cloudflare tunnel
(https://pf-api.0kv.in). Fly.io/Render deferred (both errored).

**UI → Vercel:** push to public GitHub (no secrets) → Import with Root
Directory `web` (Next.js preset, defaults) → set `NEXT_PUBLIC_API_URL` =
`https://pf-api.0kv.in` (Production + Preview) → deploy → redeploy after any
var change (build-time value). No `output: "standalone"` (only
`web/Dockerfile` needs it via `BUILD_STANDALONE=1`; always-on broke Vercel
builds, vercel/next.js#96646). No var = code default; unreachable backend ⇒
`down` + empty chart.

**API → NixOS + tunnel:** plain process on `:8080`,
`services.cloudflared` maps `pf-api.0kv.in` → localhost:8080; Cloudflare ends
TLS so the page gets `wss://`. Any container host needs one TCP port with WS
upgrade + TLS in front (`docker run -p 8080:8080 -e SEED=42 <image>`, 22 MB
image). Moving hosts = one env var + UI redeploy (config, not code).
[`docs/RECORDING.md`](docs/RECORDING.md) is the pipeline behind the demo.

## Packages used

| Backend (`api/go.mod`, Go 1.24/1.25) | Why |
| --- | --- |
| stdlib | `net/http`, `encoding/json`, `math/rand`, `context` — the market is small; a framework is more code |
| [`nhooyr.io/websocket`](https://github.com/coder/websocket) v1.8.17 | only dep: context-first, clean shutdown. Not gorilla (bigger), not x/net (deprecated) |

| Frontend (`web/package.json`) | Why |
| --- | --- |
| `next` 16 + `react` 19 | static shell + island, zero-config Vercel, lint rules in-box |
| `zustand` 5 | `setState` outside React, per-field selectors, no providers |
| `lightweight-charts` 5 | candles + hover/drag canvas at 4 Hz (not hand-rolled, not React-per-frame) |
| `tailwindcss` 4 | tokens + layout in markup |
| `vitest` 3 / `typescript` 5 / `eslint` 9 | 257 tests in ~1.5 s; no `any` on wire path; layer rule in lint |

No DB driver, ORM, broker, state framework, or socket library (browser
`WebSocket` suffices).

## Known limitations

1. **One symbol, display only** (BTC-USD; no orders/accounts). Watchlist is
   reorder-only static rows (order in `localStorage`).
2. **No persistence** — restart = fresh market, same seed, empty history
   (fills in ~2 min at `1s`, ~2 h at `1m`).
3. **Same-run determinism only** — candle times are wall-clock; cross-run
   replay needs a virtual clock (out of scope).
4. **Full 10×10 book frames**, not diffs — ids + gap rule real and tested;
   diffs are a venue optimisation.
5. **Half-open sockets linger** till the 60 s idle reap (no client
   no-pong rule yet).
6. **Tier readings follow the browser clock** at 2 s pace — hidden tabs end
   sessions instead of misreporting.
7. **Fixed `1s`/`1m` intervals**, one-way toggle, not in URL/cookie.
8. **No load/soak/cross-browser tests** (burst ≈500/s is smoke, not bench).
9. **TLS is the host's job** (local = plain `http`/`ws`).
10. **Injector is REST-only by design** — viewers cannot shock the market.

## Repo map

```
api/                     market generator, REST + WS, tier machine
  main.go  ws.go  tier.go  feed.go + *_test.go · Dockerfile · .env.example
web/                     Next.js screen: app/ · components/ · lib/ · stores/
  Dockerfile  .dockerignore  .env.example  vitest.config.ts
docs/                    PROTOCOL (wire) · SPEC · SEAMS · RECORDING (demo pipeline)
CONTEXT.md               ubiquitous language
docker-compose.yml       one-command demo: api + web
```

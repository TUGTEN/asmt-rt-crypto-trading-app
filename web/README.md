# web — trading screen (Next.js)

The browser half of the demo: bullets 1–3 of the spec, plus bullet 4's
tab lifecycle. The seeded market streams over a WebSocket into a self-healing
order book, a live trade tape, and a candlestick chart fed by REST history plus
live candle frames, with the connection's own health, its adaptive delivery tier,
and a DEBUG control for that tier on screen.

```bash
npm install
npm run dev        # http://localhost:3000
npm run test       # vitest, pure layer
npm run typecheck  # tsc --noEmit
npm run lint
npm run build && npm start
```

## Configuration

| Variable              | Default                 | Meaning                                        |
| --------------------- | ----------------------- | ---------------------------------------------- |
| `NEXT_PUBLIC_API_URL` | `https://pf-api.0kv.in` | Default backend base URL (localhost via `.env.local` or the Backend panel) |

`npm run dev` serves the UI on `localhost:3000` and the browser opens the socket
and the REST calls directly, so the backend must allow that origin (`CORS`).
Deployed, set `NEXT_PUBLIC_API_URL` to the public backend URL at build time —
that is the host a fresh browser opens on. Switching hosts afterwards needs no
rebuild: the Backend panel (preset dropdown + free-form input) redials both sockets
and refetches from the new host, and remembers the choice in `localStorage`
(`rt-crypto-trading:backend-url`) for the next visit. The socket
URL replaces the scheme (`http`→`ws`, `https`→`wss`) and appends
`/ws?topics=book,trades,chart&interval=1s` — the interval is the chart's, so
switching it is a resubscribe. The symbol, the intervals, and the seed are
**not** web config: they come from `GET /api/config`.

Copy `.env.example` to `.env.local` to point at a non-default backend.

## What it renders (bullets 1–3)

- Latest price = the book mid of the newest image, with movement and percentage
  change against the previous one, and a green/red flash.
- Top-10 bids and asks from the live book, with price, size, cumulative size,
  mid, spread and the book `seq`. While the socket is down the same levels stay
  on screen, dimmed and labelled **cached**.
- Recent trades, newest first, straight off the tape: local time (the wire's UTC
  stamp is one hover away via the `title` tooltip), price and size,
  each row coloured against the print before it. Repeats and late arrivals are
  dropped by ordering id.
- Connection panel: **live** (socket open *and* data held), **stale** (socket
  down, showing what it last delivered), **down** (nothing yet), **connecting**
  (dialing + first snapshot) — plus the socket URL, the age of the last frame,
  the book `seq`, measured latency and jitter, the delivery tier as the backend
  reports it, and how many recoveries and dropped frames the session has seen.
- Backend panel: the host the REST reads and both sockets dial — a preset dropdown
  (build default, local dev) plus a free-form input for tunnel / hosted backends.
  Switching redials and refetches immediately, validates before dialing, and is
  remembered in `localStorage`; Reset returns to the build default.
- A delivery panel: the **tier the backend is delivering on**, the **chart
  rate** that came with it, and the connection's own round trips (RTT /
  latency / jitter), beside a DEBUG control that forces `full`, `degraded`, or
  `minimal` and clears back to automatic. See *Tiers, the debug override, and tab
  visibility* below.
- A candles panel: `lightweight-charts` drawing our aggregated OHLCV series
  (history from `/api/history` merged with the live candle frames), a hover/click
  readout of the candle's timestamp and OHLCV, and an interval toggle (1s / 1m)
  that resubscribes the socket with the new chart interval.

## How the book stays correct

`docs/PROTOCOL.md` fixes the rules; `lib/book-sync.ts` implements them and
`lib/book-sync.test.ts` pins them with scripted ids:

1. **Buffer while the snapshot flies.** The socket opens first, so book frames
   start arriving before `/api/snapshot` resolves. They are held, never applied.
2. **Drop what the snapshot already contains.** Buffered frames with
   `seq ≤ snapshot.seq` are discarded; newer ones are replayed in order.
3. **Apply only on parent match.** A frame lands only if `prevSeq` equals the
   last applied `seq` (a `prevSeq` of `null` claims no parent, so it can never
   chain). A late repeat at or below the applied `seq` is ignored, not a gap.
4. **Refetch on anything else.** A frame that does not chain is a `gap`: the
   image on screen freezes, a fresh snapshot is fetched, and the book resumes on
   it. The unbased frame is never rendered.
5. **Bound the buffer, and say so.** Past `BOOK_BUFFER_LIMIT` frames the oldest
   is dropped, and the resulting chain break surfaces as a gap rather than a
   book built on a hole.

A reconnect is a new session (`CONTEXT.md`): the merger resets, an in-flight
snapshot from the dead session is aborted and its result ignored, and the book
is re-synced from a fresh snapshot. Book frames that arrive with no base at all
return `awaiting-snapshot`, which also triggers a fetch — so the client heals
from every imperfect start.

## The candles, and how they stay one series

Two doors feed the chart — REST history and live candle frames — and
`stores/candle.ts` is where they meet, so there is one series rather than two that
can disagree:

1. **History opens the chart.** `GET /api/history?interval=…&limit=120` returns
   finished buckets, oldest first (the bucket still forming is withheld: that one
   belongs to the socket). A response is accepted only if it echoes the interval
   currently on screen *and* still carries the request id that asked for it — so a
   response that finishes after an interval switch, or after a newer request
   started, is dropped rather than painted. That is the no-ghost-candles rule.
2. **Frames extend it.** A `candle` frame either files a finished bucket into the
   series (replacing any forming bucket with the same timestamp) or becomes the
   forming bucket. One entry per timestamp, always: a duplicate collapses, a late
   bucket is inserted where its timestamp belongs, and a bucket already completed
   cannot reopen.
3. **The library only draws.** `lib/candle-chart.ts` is the only thing that writes
   to `lightweight-charts`, and it writes bars built from our candles — a forming
   bucket is a single `update()`, never a rebuild. Hover, click-to-pin and drag
   read the candle our series holds at the axis position the library reports, so
   no displayed number is the library's own arithmetic.
4. **Empty is a state, not a blank.** A series with no candles says which of the
   three it is: still loading, nothing finished yet (with a retry if the read
   failed), or waiting for the feed.
5. **A reconnect re-reads.** Candle frames only ever reached the stream that just
   ended, so a new session bumps `historyEpoch` and the series is fetched again
   rather than trusted to be complete.

## Latency, tiers, and reconnect

- Every 2s the client sends `{"type":"ping","tSend":<ms>}` and, from the echo,
  computes `RTT = tRecv − tSend`, `latency = RTT/2`, `jitter = EMA(|RTT − prev|)`.
  The same tick reports `{"type":"report","latencyMs":…,"jitterMs":…}`. The
  backend owns the tier; the client only measures and reports. Reports with an
  implausible round trip (negative, or past `MAX_RTT_MS`) are not sent.
- A dropped socket keeps the last values on screen and marks them **stale**,
  then redials with capped exponential backoff (500ms doubling to 8s). Since the
  topics live in the URL, redialing *is* resubscribing.
- A snapshot request that fails keeps the merger buffering and is retried after
  `SNAPSHOT_RETRY_MS`. Consecutive gaps refetch immediately while recovery
  converges; once a run of gaps says client and feed disagree, the retries drop
  back to `SNAPSHOT_RETRY_MS` (`MAX_RESYNC_ATTEMPTS`) so a broken feed cannot
  become a hot fetch loop. The first frame that chains resets the breaker.

Timings are config, not constants (`lib/config.ts`): `PING_INTERVAL_MS` 2000
(fixed by the protocol), `RECONNECT_BASE_MS` 500 / `RECONNECT_MAX_MS` 8000,
`SNAPSHOT_RETRY_MS` 750, `MAX_RESYNC_ATTEMPTS` 5, `BOOK_BUFFER_LIMIT` 64,
`TRADE_TAPE_SIZE` 30, `JITTER_EMA_ALPHA` 0.5, `MAX_RTT_MS` 60000, `HISTORY_LIMIT`
120 (the chart's history window), `HISTORY_RETRY_MS` 3000.

## Tiers, the debug override, and tab visibility

**The tier is the backend's decision, rendered as it arrives.** `stores/conn.ts`
holds `tier` and `tierRate` exactly as the last `{"type":"tier"}` frame wrote
them, so nothing on screen is a rate this client computed from a tier name: if
the backend changes what `degraded` means, the badge follows the frame. The
active tier, its chart rate, and the round trips live in the Delivery panel
(`components/TierBadge.tsx`), which selects those fields individually — the tier
changes when the backend announces one and the round trips once per pong, so
neither repaints the book or the chart.

**The DEBUG control writes one frame and then waits to be told.** Its buttons
have no local tier logic: `WsClient.forceTier(tier)` records the selection in
`stores/conn.ts` beside the backend's answer and sends
`{"type":"force","tier":"…"}` — or `{"type":"force","tier":null}` for
*automatic*. The backend applies a forced tier immediately and answers with a
`tier` frame, which is what the badge renders. `lib/tier-readout.ts` (pure,
pinned by `lib/tier-readout.test.ts`) is the wording, and it keeps three facts
apart rather than flattering the client:

| selection | announced tier | badge says |
| --- | --- | --- |
| none | any | `automatic` — the backend's own decision |
| `minimal` | `minimal` | `forced minimal via debug control` |
| `minimal` | `full` (frame not back yet, or socket down) | `asked for minimal — not in force yet` |

**Clearing resumes automatic, on the machine's own tier.** `tier: null` hands the
decision back: the connection resumes wherever the probes the backend *has* seen
put it and climbs from there (a forced tier buys no upgrade and hides nothing —
`api/tier.go`). So clearing typically shows a tier you did not just click, which
is the point: the badge says `automatic` and stops claiming the override.

**The override survives a reconnect.** A reconnect is a new backend state machine
with no override on it, so a standing selection is re-sent the moment a session
opens (`WsClient.handleOpen`). Without that, the badge would keep reading
`forced` over a backend that had gone back to automatic — stale-as-live, one
field over.

**A hidden tab stops rather than pretends.** `lib/visibility.ts` binds the
session's lifetime to `document.hidden`: hidden ends the session (socket closed,
ping timer cancelled, stores marked **stale**), and becoming visible dials a
*new* one — which for this client is also the resubscribe, since the topics and
the chart interval are the socket URL's query string, with a fresh snapshot and a
re-read history behind it. The alternative (keep streaming and relabel the screen)
was rejected: a hidden tab is not being watched, its background-throttled timers
would report readings the backend is entitled to tier on, and *not running* is a
stronger guarantee than *labelled cached* — no stream can be presented as live if
there is no stream. The listener, the session, its socket, and every timer it
scheduled are disposed by the hook that owns them (`lib/hooks/useMarketStream.ts`),
so unmounting leaves nothing behind.

## Layout

```
app/
  layout.tsx           document shell, dark theme, metadata
  page.tsx             server component: static chrome + <TradingScreen/>
  globals.css          design tokens (@theme) + the price-flash animation
components/            presentational only — props in, JSX out, no fetch
  TradingScreen.tsx    "use client" island: one pane per panel, each selecting
                       its own slices from the stores
  CandleChart.tsx      the candles panel: the chart library drawing our series,
                       plus the hover/click OHLCV readout
  IntervalToggle.tsx   the 1s / 1m control (the store owns what a switch means)
  TierBadge.tsx        the delivery readout: backend tier + chart rate +
                       RTT/latency/jitter, selected field by field
  DebugPanel.tsx       the DEBUG tier-override control (reports clicks only)
lib/
  config.ts            env-based config and timings
  protocol.ts          wire types, runtime guards, REST fetchers (React-free)
  format.ts            pure display helpers (decimal-string safe)
  candles.ts           the series: upsert a bucket, merge history + live
  candle-chart.ts      the only writer to the chart library's series
  candle-history.ts    one history read: request id, interval guard, outcome
  ws-client.ts         the socket session: dial, refetch, ping, reconnect,
                       and the debug override's force frame
  tier-readout.ts      what the delivery badge says (pure derivation)
  visibility.ts        tab visibility as a session lifecycle (hidden = stopped)
  book-sync.ts         the merge: buffer, chain on prevSeq, signal gaps
  trade-tape.ts        the bounded recent-trades ring
  latency.ts           RTT / latency / jitter maths
  retry.ts             one attempt retried on a fixed cadence (React-free loop
                       shared by useBackendConfig and useCandleHistory)
  decimal.ts           the wire's decimal strings: one pattern, guard, and split
  hooks/               React edges (useMarketStream, useMarketStores,
                       useBackendConfig, useCandleHistory, useNow)
stores/                the live state: Zustand stores + their selectors
  book.ts              book image, mid, tape, status/syncing/gaps/malformed
  conn.ts              tier, delivery rate, rtt/latency/jitter, debug override
  candle.ts            interval, history, active candle, request id
  market.ts            createMarketStores(): one set per mounted session
```

## Live state (Zustand)

Live state lives in three focused Zustand stores (`stores/`), created per mount by
`createMarketStores()`: the socket and the state it fills share a lifetime, so a
remount is a clean start rather than a screen inheriting a dead session's numbers.
`lib/ws-client.ts` pushes frames in with `setState` and stays React-free — the
stores are `zustand/vanilla`, so no rendering layer enters its module graph — and
the React edges are the selector hooks in `lib/hooks/useMarketStores.ts`.

Panels select rather than copy: `useBookStore(stores.book, selectMid)` re-renders
on a new mid and on nothing else, so a 2s pong does not repaint the book or the
tape, and the 1s clock that ages the "last frame" label is scoped to the one panel
that shows it (`useNow` lives in the connection pane, not at the top of the
screen). The connection pane runs the other way and is honest about it: it exists
to show how the session is being delivered, so it selects `lastFrameAt`, `status`,
`syncing`, `bookSeq` and the counters from `stores/book.ts`, plus the tier and
round trips from `stores/conn.ts` — and a new frame is allowed to repaint it,
because the age of the last frame is a number it renders.

The chart pane takes the third route, which is the one that keeps a 4Hz candle
cheap: the chart is created once in an effect and the series is moved
imperatively through `lib/candle-chart.ts`, so a forming candle costs one
`update()` call and *no* React render of a canvas. Only the small inspection
readout re-renders as the pointer moves, and it is resolved back to our candle by
timestamp (`lib/candles.ts`) rather than to whatever the library holds.

That split is why there are three stores and not one market object;
`stores/market.test.ts` pins the property the panels rely on — a write to one
store leaves every other store's slices identical.

Backend state stays where it belongs: `/api/config` and the candle history are
REST fetches (`lib/protocol.ts`, `lib/candle-history.ts`) — the live book and tape
never travel that path, and the chart library never fetches at all.

The layering rule every ticket keeps: fetching and sockets live in `lib/`, never
in a component (the eslint config fails a `fetch` in `components/`); every
payload is narrowed from `unknown` by a guard, so nothing on the wire path is
`any`; prices and sizes stay decimal strings and are rendered from those strings,
with aggregates summed in scaled integers. `lib/ws-client.ts` and everything
below it are React-free — the stores included, which is why they import
`zustand/vanilla` — and take their socket, clock, timers, snapshot request, and
stores by injection, which is what makes them testable with a script.

## Tests

`npm run test` covers the pure layer — the parts where a mistake is a wrong
number on screen, not a wrong pixel:

- `protocol.test.ts` / `protocol.frames.test.ts` — REST payloads and every WS
  frame shape, including malformed JSON, wrong types, and empty book sides.
- `book-sync.test.ts` — the in-flight race, discard-at-or-below-snapshot, chain
  on `prevSeq`, gap signalling, buffer bounds, in-flight refetch, reset.
- `trade-tape.test.ts` — ring bounds, newest-first order, repeat/late rejection.
- `latency.test.ts` — RTT/latency/jitter, EMA smoothing, unusable samples.
- `ws-client.test.ts` — the session wiring: scripted frames and manual time
  drive the client through buffering, gap → refetch → resume, malformed traffic,
  snapshot failure and retry, ping/report cadence, backoff up to the cap, the
  resync breaker, cache-on-disconnect, stop-on-unmount, candle frames into the
  chart's store, and the re-read signal a reconnect sends. T4 adds the force
  sequence: one `force` frame per action (full/degraded/minimal, then the `null`
  that clears it), the tier frame that follows it, the override re-asserted on a
  reconnect, and a hidden tab whose session closes and dials again when it
  returns.
- `tier-readout.test.ts` — the badge's wording: the tier and rate are the
  backend's frame verbatim (a rate the client would have had to invent is never
  used), an override reads as `forced` only once the backend has announced it and
  as `pending` until then, and clearing returns to `automatic`.
- `visibility.test.ts` — the tab lifecycle: visible runs the session, hidden ends
  it, a tab hidden at mount never dials, repeat readings cannot redial, and
  dispose removes the listener and stops the session exactly once.
- `candles.test.ts` — the series: a duplicate bucket collapses to one entry, a
  late bucket is inserted where its timestamp belongs, a finished bucket outranks
  the same bucket still forming, and a candle the axis cannot place is dropped.
- `candle-chart.test.ts` — the chart's data path: the library is handed bars built
  from our aggregation and *fetches nothing itself*; a live bucket is an `update()`
  rather than a rebuild; an interval switch or an emptied series is a `setData()`;
  a value that cannot be read is skipped rather than drawn as `NaN`.
- `candle-history.test.ts` — one history read: a response that finishes after the
  interval changed, or after a newer request started, is dropped rather than
  painted; a failure keeps the candles on screen and reports why; an abort is not
  a failure.
- `stores/candle.test.ts` — the guards where the two doors meet: an interval
  switch drops the old series and moves the request id, a response labelled with
  another interval cannot land, a forming bucket is extended and then closed by
  its finished frame, and a repeated frame writes nothing at all.
- `stores/market.test.ts` — the live state: the per-session stores start empty,
  a write to one leaves the others' slices identical (what a selector needs to
  skip a re-render), and the two freshness selectors that decide when cached
  values may be shown.

`protocol.test.ts` also pins the `/api/history` payload: the interval echoed back
has to be the one asked for, and a candle that is not six decimal strings is
rejected by name.

Transport plumbing (the real `WebSocket` adapter, `setTimeout`), the chart
library's canvas, and rendering are covered by running the app against the seeded
backend — see `docs/SEAMS.md`, which draws that line on purpose.

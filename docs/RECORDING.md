# Recording — one take, five moments

The screen recording shows five moments: **live chart**,
**interval change**, **order book**, **forced tier**, and **disconnect
recovery**. The scenario injector (spike, halt, burst) is what makes the market
events reproducible on demand instead of waiting for luck; the disconnect shot is
the recovery demo. This file is the run sheet: what to set up, what to say, which
command to paste, and what the viewer should be able to point at afterwards.

Target: **3–4 minutes, one take**. Everything below is copy-paste; nothing needs
a second screen or a video editor.

---

## 0. Before you hit record

```bash
cd <repo>
docker compose up --build -d
docker compose ps                 # both services must say (healthy)
curl -s localhost:8080/api/config # {"symbol":"BTC-USD","intervals":["1s","1m"],"seed":42}
```

- [ ] Browser on <http://localhost:3000>, window **1440×900 or larger**, zoom 100 %.
- [ ] **One tab only.** A hidden tab is a *stopped* session by design (it ends its
      socket rather than pretending), so a second tab will quietly make the app
      look broken when you switch back.
- [ ] Terminal beside the browser, font big enough to read at 1080p, `cd`'d to the
      repo root. Keep the block in [§2](#2-commands-to-paste) ready.
- [ ] **Wait 60–90 s.** A fresh backend has no history (nothing is persisted), so
      the 1s chart is nearly empty for the first seconds and fills as candles
      close. Let it build ~60 candles before recording — an empty chart is an
      honest state, but a poor opening shot.
- [ ] Rehearse once off-camera: the two scenario curls, `docker compose stop api`,
      `docker compose start api`. Recovery is the shot that needs the most
      muscle memory.
- [ ] Decide where the finished file goes (unlisted YouTube, Loom, Drive) and add
      the link to the two `TBD` lines at the top of [`../README.md`](../README.md).

Sanity check the whole path once, if you like, without recording:

```bash
curl -s localhost:8080/api/snapshot | head -c 120          # book image
curl -s "localhost:8080/api/history?interval=1s&limit=2"   # finished candles
```

---

## 1. Run sheet

Times are targets, not rules. `SHOT` = what the camera sees, `CMD` = what you
paste, `PROVES` = the sentence for the walkthrough.

### Shot 1 — Live chart (0:00 → 0:30)

- **SHOT.** Open on the screen, cursor low and still. Price ticker moving with
  its up/down flash, candles growing bar by bar, trade tape printing, book
  levels shifting. Then hover one finished candle: the readout shows its
  timestamp + OHLCV.
- **CMD.** none.
- **SAY.** "One simulated BTC-USD market, seeded in the backend — same seed,
  same stream. No database: the seed is the fixture. The chart is history from
  REST plus the live candle over a WebSocket; hover reads the candle *our*
  aggregation holds, not the chart library's own numbers."
- **PROVES.** Stories 2–6: the market is alive and inspectable.

### Shot 2 — Interval change (0:30 → 1:00)

- **SHOT.** Click **1m**, let the chart re-seat, hover a 1m candle; click **1s**
  and let it come back.
- **CMD.** none.
- **SAY.** "Switching intervals drops the old series, moves the history request
  id and resubscribes the chart socket — the chart interval is part of its URL —
  while the book and the tape stay live on the market socket.
  A response for the interval you just left arrives late and is thrown away, so
  you never see ghost candles from the previous series."
- **PROVES.** Stories 4, 18: one series, no stale paint.

### Shot 3 — Order book (1:00 → 1:40)

- **SHOT.** Point at the book: 10 bids and 10 asks, price / size / cumulative
  size, mid, spread, and the book `seq` readout advancing one per tick. Then run
  the **gap** command: on the next tick the `seq` readout jumps by 6 — five ids
  skipped — the book refetches and keeps rendering, and the Connection panel's
  `recovery` row ticks up one refetch.
- **CMD.**

  ```bash
  curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"gap"}'
  ```

- **SAY.** "Each book frame claims its parent `seq`; the client applies a frame
  only when `prevSeq` is what it last applied, and refetches `/api/snapshot` on
  anything else. That command skipped five ids — you can see the `seq` readout
  jump *and* the `recovery` row tick up one refetch: the frame's `prevSeq` names
  an id that was never sent, so the client refused it, refetched, and resumed.
  The same shape is pinned by tests with scripted ids on both sides of the wire.
- **PROVES.** Stories 7, 17: the book is id-tracked and never built on a guess.

> The refetch itself lands within a tick on a local backend — the visible
> evidence is the `seq` jump plus the recovery counter, not a freeze. Shot 5
> shows the same code path when the whole session is lost.
### Shot 4 — Forced tier (1:40 → 2:30)

- **SHOT.** In the **DEBUG** panel (right column, under Delivery) click
  **minimal**: the badge reads *forced minimal*, the announced rate becomes
  0.25 Hz, and the chart visibly stops updating between ticks while the tape and
  book keep their cadence. Click **degraded**, then **automatic** — the badge
  stops claiming the override and the chart speeds back up. Point at the RTT /
  latency / jitter readout.
- **CMD.** none (the panel is the control).
- **SAY.** "The backend owns the tier; these buttons only send one `force` frame
  and then render the `tier` frame that comes back. The chart moves at 4, 1 or
  0.25 Hz — but the *candles* never change: the feed aggregates, the tier only
  decides when a frame is delivered. Clearing hands the decision back to the
  machine, which is why 'automatic' can show a tier you did not click. The
  panel reports RTT/2 as latency and an EMA of round-trip spread as jitter; those
  are what the bands are measured on."
- **PROVES.** Stories 11–15: adaptive delivery, visible because it is on screen.

### Shot 5 — Disconnect recovery (2:30 → 3:10)

- **SHOT.** Stop the backend: the connection status flips to **stale** (`socket
  down — showing the last values it delivered`), the book dims and reads
  `cached — the socket is down`, the age of the last frame climbs, the tape stops.
  Start it again: the client redials with backoff, resubscribes, refetches a
  snapshot, re-reads history, and the screen is live again. This is the book's
  re-sync path on a real break: watch the `seq` readout and the `recovery` row in
  the Connection panel.
- **CMD.**

  ```bash
  docker compose stop api        # screen goes stale, keeps showing the last values, labelled
  # ~5 seconds
  docker compose start api       # reconnect + resubscribe + fresh snapshot
  ```

- **SAY.** "Cached values stay on screen but are never labelled live. The redial
  is the resubscribe — topics and interval are each socket's URL. A fresh process
  means a fresh market from the same seed, so the price restarts near $65,000
  and history refills: nothing is persisted, by design, and the chart says so
  instead of drawing a line it does not have."
- **PROVES.** Stories 9, 16: stale-while-dark, then a correct reconnect.

### Shot 6 (bonus, 20s) — Scenario spike / halt / burst (3:10 → 3:40)

- **SHOT.** Run **spike**: a visible ~+0.2 % step on the next tick. Run **halt**:
  five seconds with no prints and flat candles while the book `seq` keeps
  advancing. Run **burst**: ~500 trades in a second flood the tape. Finish with
  **clear**.
- **CMD.**

  ```bash
  curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"spike"}'
  curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"halt"}'
  curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"burst"}'
  curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"clear"}'
  ```

- **SAY.** "These are the same events the tests use — a ten-sigma step, a
  silent tape, a print storm — so a demo of an edge case is one command instead
  of waiting for it to happen. `GET /api/scenario` reports what is armed, so the
  control renders the truth rather than what it last asked for."
- **PROVES.** Story 20: deterministic, injectable edge cases.

---

## 2. Commands to paste

```bash
# scenario injector (developer control; no UI button by design)
curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"spike"}'
curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"gap"}'
curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"halt"}'
curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"burst"}'
curl -s -X POST localhost:8080/api/scenario -d '{"scenario":"clear"}'
curl -s localhost:8080/api/scenario

# disconnect recovery, docker compose
docker compose stop api
docker compose start api

# disconnect recovery, if you are running `go run .` instead of compose
#   Ctrl-C in the api terminal, then:
cd api && go run .
```

Note: `spike` and `gap` are **one-shot** — they fire on the next tick (~100 ms)
and then report themselves as `null`. If you fumble the moment, just run the
command again; there is nothing to reset. `halt` and `burst` run for their
window and disarm on their own. Measured on the composed stack: a `spike` steps
the tape about +0.19 % between consecutive trades, a `gap` jumps the book `seq`
by 6 and ticks the Connection panel's recovery counter one refetch, a `halt`
silences the tape for 5 s while the book `seq` keeps advancing,
and a `burst` prints ~500 trades in a second.

---

## 3. Things that will make you re-record

- **A second tab.** It ends its own session by design; switching back shows a
  reconnect, not a bug. Record with one tab, or expect the reconnect and say so.
- **Recording too early.** Under ~30 s of uptime the chart is legitimately thin.
  Give it 60–90 s.
- **`minimal` tier left on.** A forced tier survives a reconnect (the client
  re-asserts it), so shot 5's recovery would come back at 0.25 Hz. Click
  **automatic** before the disconnect shot.
- **Cutting away between arming a scenario and its tick.** Arm it while the
  chart is on screen; the effect is within a tick.
- **Speaking over the recovery.** Leave the first five seconds after
  `docker compose stop api` silent-ish — the point is what the *screen* does
  while the backend is gone.

---

## 4. After the take

- [ ] File saved as e.g. `pitchfork-<date>.mp4` (no editing needed: the
      five moments are in order).
- [ ] Uploaded unlisted; link pasted into the two `TBD` lines at the top of
      [`../README.md`](../README.md) and into issue #7.
- [ ] Self-check against the spec:
      live chart ☐ · interval change ☐ · book ☐ · forced tier ☐ · disconnect
      recovery ☐ · (bonus) scenario spike/gap ☐.

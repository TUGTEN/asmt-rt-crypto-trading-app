# Recording — automated silent demo pipeline

Silent, automated take: Playwright drives the live screen through 6 shots
against the local stack, Remotion adds the narration bar, key badges and
click markers, ffmpeg encodes the shareable file. No spoken take, no second
screen, no editor.

- **Shareable:** [`assets/pitchfork-demo.webm`](assets/pitchfork-demo.webm)
  (157 s, 1920×1200 VP9, silent, 4.6 MB) — linked from the [`Demo` bullet at
  the top of the README](../README.md).
- **Regenerable intermediates** (gitignored, never committed):
  `recording/footage/take.mp4` (raw capture),
  `recording/out/pitchfork-demo.mp4` (2880×1800 master),
  `recording/out/pitchfork-demo-1080p.mp4` (1920×1200 H.264).

## 0. Prerequisites

```bash
docker compose up --build -d
# capture waits for ≥60 finished 1s candles by itself (~60–90 s on a fresh
# backend: history is in-memory), so there is nothing to time by hand.
```

Only scripts are committed (`capture.mjs`, `src/`, `package.json`,
`package-lock.json`, `tsconfig.json`, `remotion.config.ts`). Artefacts are
excluded in `.gitignore` (`recording/node_modules/`, `recording/footage/`,
`recording/public/`, `recording/out/`) — the dir would otherwise be ~760
MB.

## 1. Steps

```bash
cd recording
node capture.mjs   # Playwright drives the 6 shots; lossless PNG frames via CDP screencast
npm run render     # Remotion composites narration/clicks → out/pitchfork-demo.mp4
npm run web        # master → out/pitchfork-demo-1080p.mp4 (H.264, +faststart)
npm run webm       # 1080p → docs/assets/pitchfork-demo.webm (VP9 2-pass, <5 MB)
```

≈4 min capture + ~10 min render + a few min ffmpeg. `WEB_URL`/`API_URL` env
vars retarget a non-default stack. `webm` is two passes on purpose:
single-pass VP9 overshoots the 5 MB budget at any cap tried (VBR and CQ both
landed ~400+ kbps on this content), so the size is dialled in on the second
pass (`-b:v 200k` → 4.6 MB). The webm is cut from the **1080p** file, not the
2880×1800 master — 5 MB over 157 s is 254 kbps, and the retina master cannot
hold text together at that rate.

## 2. Shots (video time, from `recording/footage/events.json`)

| Shot | At | Shows | Proves (SPEC) |
| --- | --- | --- | --- |
| 1/6 Live BTC-USD · seed 42 | 0:00 | ticker, growing candles, tape, book; hover opens OHLCV | 2–6 |
| 2/6 Interval switch | 0:24 | 1s ⇄ 1m, late frames dropped | 4, 18 |
| 3/6 Book gap → refetch | 0:48 | `gap` skips 5 ids; `seq` +6, one refetch | 7, 17 |
| 4/6 Forced tier | 1:00 | minimal (0.25 Hz) → degraded → automatic, candles unchanged | 11–15 |
| 5/6 Backend down | 1:38 | **stale**, dimmed cache; restart → backoff, resubscribe, refetch | 9, 16 |
| 6/6 Injector trio | 2:04 | spike, halt, burst, clear — one command each | 20 |

Injector is REST-only, no UI button, by design
([PROTOCOL.md](PROTOCOL.md#scenario-injector)); capture drives it from the
side.

## 3. Two facts from debugging

1. **Resolution comes from `zoom: 2`, not DPR.** Headless Chromium caps the
   screencast at CSS pixels and ignores `deviceScaleFactor` (Playwright's own
   `recordVideo` pads gray + VP8 smears text). Capture uses a 2880×1800
   viewport with `html { zoom: 2 }`: the app lays out as 1440×900, rasterized
   2×.
2. **Narration keys to frames, not wall clock.** The screencast emits only on
   repaint, so silence collapsed time (8 s outage → 0.76 s). A 1 px repaint
   pump + frame-index keys hold video to wall clock within 0.01 s; all
   overlays in `src/Demo.tsx` position by video time (`vt` in `events.json`).

## 4. Re-record / clean

```bash
cd recording && node capture.mjs && npm run render && npm run web && npm run webm
rm -rf footage public out   # regenerable (~190 MB)
```

Then check the webm is still <5 MB and §2 times still match the new
`footage/events.json` before touching the README list.

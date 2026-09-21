# Test Seams — testable vertical slices

Each slice is a thin end-to-end behavior: seeded backend → protocol → screen.
Each is independently demoable on the recording and independently testable
with scripted inputs. Annotate or approve.

## Slice A — Live chart that adapts to my connection

**Path:** seeded trade stream → per-connection tier machine → WS chart
updates → client candle aggregation → rendered active candle + tier badge.

**Demoable:** force degraded/minimal from the debug control; the chart slows
(4Hz → 1Hz → 0.25Hz) while the finished candle's OHLCV stays identical to
full-tier.

**Testable assertions:**

- Scripted latency/jitter reports drive full → degraded → minimal and back;
  3 consecutive bad probes to step down, 5 good to step up (no flapping on a
  single spike).
- 3 missed reports → degraded, 6 → minimal; reconnect starts a fresh session.
- Forced tier beats automatic while set; clearing it resumes automatic.
- Same seeded stream at all three tiers → byte-identical final candles
  (combining trades into one update allowed; inventing values not).
- Disconnect → chart freezes and is badged stale, never presented as live.

## Slice B — Book that heals itself

**Path:** book generator → REST snapshot + WS deltas → client merge →
rendered top-10 bids/asks + connection status.

**Demoable:** kill the connection mid-stream (or inject a seq jump); the book
freezes, refetches a snapshot, resumes — visible as a brief stale flash, not
a corrupt book.

**Testable assertions:**

- Deltas arriving while the snapshot request flies are buffered; buffered
  deltas with `seq ≤ snapshot.seq` are discarded, newer ones applied in order.
- A delta with `prevSeq ≠ lastAppliedSeq` (missed/out-of-order) triggers a
  fresh snapshot + resume; the book never applies a delta onto the wrong base.
- Malformed messages and empty sides are rejected without crashing the merge;
  at least 10 bids + 10 asks render whenever the feed is healthy.

## Slice C — History I can trust when switching intervals

**Path:** history endpoint (deterministic replay from seed) → interval-keyed
query cache → chart with hover/click/drag inspection.

**Demoable:** flip 1s ↔ 1m on the recording; the chart swaps cleanly, hover
shows timestamp + OHLCV, no ghost candles from the previous interval.

**Testable assertions:**

- History for 1s and 1m regenerated from the same seed agrees with live
  aggregation over the same range.
- A history response that finishes after the interval changed is dropped
  (stale request id), never painted onto the new interval.
- Duplicate candles collapse to one; empty history renders an explicit empty
  state, not a frozen chart.
- Hover/drag inspection reads the aggregated candle values, not
  chart-library internals (the lib only draws what our code supplies).

## What is deliberately not sliced

Transport plumbing, reconnect backoff timers, store wiring, deployment, the
screen recording itself — thin glue above or below the slices, covered by the
demos, not by automated tests.

## Approve / adjust

- **Approve** → I write the full spec next and publish it with the
  `ready-for-agent` label.
- **Annotate** with slices to add, drop, or reshape.

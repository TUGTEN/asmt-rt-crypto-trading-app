import { describe, expect, it } from "vitest";

import { JITTER_EMA_ALPHA, MAX_RTT_MS } from "@/lib/config";
import { LatencyTracker, roundTo1, rttFromPong } from "@/lib/latency";

/**
 * RTT math from docs/PROTOCOL.md: `RTT = tRecv − tSend`, `latency = RTT/2`,
 * `jitter = EMA(|RTT − prevRTT|)`. These numbers are what the client reports
 * every 2s and what the backend tiers on, so they are pinned here rather than
 * sprinkled through the socket code.
 */

const T_SEND = Date.parse("2026-09-19T14:18:11.000Z");

function pongAt(offsetMs: number): string {
  return new Date(T_SEND + offsetMs).toISOString();
}

describe("rttFromPong", () => {
  it("measures the round trip from the echoed send stamp", () => {
    expect(rttFromPong(T_SEND, pongAt(12))).toBe(12);
    expect(rttFromPong(T_SEND, pongAt(0))).toBe(0);
  });

  it("refuses a stamp it cannot read, or one from before the ping", () => {
    expect(rttFromPong(T_SEND, "not a timestamp")).toBeNull();
    expect(rttFromPong(T_SEND, "")).toBeNull();
    expect(rttFromPong(T_SEND, pongAt(-5))).toBeNull();
  });

  it("refuses an implausible round trip instead of believing a frozen tab", () => {
    expect(rttFromPong(T_SEND, pongAt(MAX_RTT_MS))).toBe(MAX_RTT_MS);
    expect(rttFromPong(T_SEND, pongAt(MAX_RTT_MS + 1))).toBeNull();
  });
});

describe("LatencyTracker", () => {
  it("has no opinion before the first measurement", () => {
    const tracker = new LatencyTracker();
    expect(tracker.stats).toBeNull();
  });

  it("reports half the round trip as latency", () => {
    const tracker = new LatencyTracker();
    const stats = tracker.recordRtt(24);

    expect(stats).toEqual({ samples: 1, rttMs: 24, latencyMs: 12, jitterMs: null });
  });

  it("has no jitter until there are two round trips to compare", () => {
    const tracker = new LatencyTracker();
    tracker.recordRtt(24);
    // No previous sample means no spread: jitter is undefined, not zero.
    expect(tracker.stats?.jitterMs).toBeNull();

    expect(tracker.recordRtt(28)?.jitterMs).toBe(4);
    expect(tracker.stats).toEqual({ samples: 2, rttMs: 28, latencyMs: 14, jitterMs: 4 });
  });

  it("smooths jitter with an EMA, so one spike decays instead of sticking", () => {
    const tracker = new LatencyTracker();
    const alpha = JITTER_EMA_ALPHA;

    tracker.recordRtt(10);
    // The first comparison seeds the EMA with the spread itself (|20 − 10|).
    expect(tracker.recordRtt(20)?.jitterMs).toBe(10);
    // A steady round trip then decays it towards the new spread (0), at alpha
    // as the weight of each fresh observation.
    expect(tracker.recordRtt(20)?.jitterMs).toBe(10 * (1 - alpha));
    expect(tracker.recordRtt(20)?.jitterMs).toBe(10 * (1 - alpha) ** 2);
  });

  it("ignores an unusable sample without disturbing the last good numbers", () => {
    const tracker = new LatencyTracker();
    tracker.recordRtt(20);
    tracker.recordRtt(30);

    const before = tracker.stats;
    expect(tracker.recordRtt(Number.NaN)).toBeNull();
    expect(tracker.recordRtt(-1)).toBeNull();
    expect(tracker.recordRtt(Number.POSITIVE_INFINITY)).toBeNull();
    expect(tracker.stats).toEqual(before);
  });

  it("forgets its history on reset: a reconnect is a new session", () => {
    const tracker = new LatencyTracker();
    tracker.recordRtt(20);
    tracker.recordRtt(30);

    tracker.reset();

    expect(tracker.stats).toBeNull();
    expect(tracker.recordRtt(40)?.jitterMs).toBeNull();
  });
});

describe("roundTo1", () => {
  it("keeps reported numbers short enough to read on a recording", () => {
    expect(roundTo1(12.3456)).toBe(12.3);
    expect(roundTo1(4.06)).toBe(4.1);
    expect(roundTo1(-0.04)).toBe(-0);
  });
});

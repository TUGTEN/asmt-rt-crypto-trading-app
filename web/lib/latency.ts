/**
 * Round-trip measurement (docs/PROTOCOL.md, CONTEXT.md "RTT").
 *
 *   RTT     = tRecv − tSend
 *   latency = RTT / 2
 *   jitter  = EMA(|RTT − prevRTT|)
 *
 * The client measures and the backend decides the tier, so these numbers are
 * part of the wire contract, not a debug readout: they are pinned by tests and
 * reported every 2s by `lib/ws-client.ts`.
 *
 * Everything here is pure — no clock, no socket. A caller passes the `tSend` it
 * stamped and the `tRecv` the backend echoed back.
 */

import { JITTER_EMA_ALPHA, MAX_RTT_MS } from "@/lib/config";

export type LatencyStats = {
  /** Round trips accepted so far this session. */
  samples: number;
  rttMs: number;
  latencyMs: number;
  /** `null` until there are two round trips to compare — no spread, no jitter. */
  jitterMs: number | null;
};

/**
 * One measurement from a pong, or `null` when the pong cannot be believed:
 * an unreadable stamp, a reply that predates the ping (the backend echoed
 * someone else's stamp, or the clock moved), or a round trip so slow it is a
 * frozen tab rather than a network measurement.
 */
export function rttFromPong(tSend: number, tRecv: string): number | null {
  const receivedAt = Date.parse(tRecv);
  if (!Number.isFinite(receivedAt)) {
    return null;
  }
  const rtt = receivedAt - tSend;
  if (!Number.isFinite(rtt) || rtt < 0 || rtt > MAX_RTT_MS) {
    return null;
  }
  return rtt;
}

/** Reported numbers are read on screen, so one decimal is plenty. */
export function roundTo1(value: number): number {
  return Math.round(value * 10) / 10;
}

export class LatencyTracker {
  private readonly alpha: number;
  private count = 0;
  private lastRtt: number | null = null;
  private ema: number | null = null;

  constructor(alpha: number = JITTER_EMA_ALPHA) {
    if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
      throw new RangeError("jitter EMA alpha must be in (0, 1]");
    }
    this.alpha = alpha;
  }

  /** Record one round trip; returns the new stats, or `null` if it was unusable. */
  recordRtt(rttMs: number): LatencyStats | null {
    if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > MAX_RTT_MS) {
      return null;
    }
    if (this.lastRtt !== null) {
      const spread = Math.abs(rttMs - this.lastRtt);
      this.ema = this.ema === null ? spread : this.alpha * spread + (1 - this.alpha) * this.ema;
    }
    this.lastRtt = rttMs;
    this.count += 1;
    return this.stats;
  }

  get stats(): LatencyStats | null {
    if (this.lastRtt === null) {
      return null;
    }
    return {
      samples: this.count,
      rttMs: this.lastRtt,
      latencyMs: this.lastRtt / 2,
      jitterMs: this.ema,
    };
  }

  /** A reconnect is a new session: the old RTT says nothing about the new one. */
  reset(): void {
    this.count = 0;
    this.lastRtt = null;
    this.ema = null;
  }
}

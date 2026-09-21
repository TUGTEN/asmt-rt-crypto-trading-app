/**
 * The recent-trades ring behind the tape.
 *
 * Trades are the atomic truth of the market (CONTEXT.md), but the screen only
 * shows the recent few, so the tape is bounded by construction rather than by
 * trimming an ever-growing array on render. Newest first, because that is how
 * the tape reads.
 *
 * A repeated or late trade — `seq` at or below the newest one we hold — is
 * ignored: the ordering id already says we have seen it, and showing it twice
 * would make the tape disagree with the chart.
 */

import { TRADE_TAPE_SIZE } from "@/lib/config";
import type { Trade } from "@/lib/protocol";

export class TradeTape {
  private readonly limit: number;
  private entries: Trade[] = [];
  private newestSeq: number | null = null;

  constructor(limit: number = TRADE_TAPE_SIZE) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("tape limit must be a positive integer");
    }
    this.limit = limit;
  }

  /** Newest first — the tape's reading order. */
  get trades(): readonly Trade[] {
    return this.entries;
  }

  get size(): number {
    return this.entries.length;
  }

  get latestSeq(): number | null {
    return this.newestSeq;
  }

  /** Returns false when the trade was a repeat or a late arrival. */
  push(trade: Trade): boolean {
    if (this.newestSeq !== null && trade.seq <= this.newestSeq) {
      return false;
    }
    this.entries = [trade, ...this.entries].slice(0, this.limit);
    this.newestSeq = trade.seq;
    return true;
  }

  /** A reconnect is a new session: the tape starts empty. */
  reset(): void {
    this.entries = [];
    this.newestSeq = null;
  }
}

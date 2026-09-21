import { describe, expect, it } from "vitest";

import { TRADE_TAPE_SIZE } from "@/lib/config";
import { TradeTape } from "@/lib/trade-tape";
import type { Trade } from "@/lib/protocol";

/**
 * The trade tape is a bounded ring: newest first, at most `TRADE_TAPE_SIZE`
 * entries, and a repeat or a late arrival never appears twice (SPEC Bullet 1's
 * trade stream, `docs/CONTEXT.md` "Trade").
 */

function trade(seq: number): Trade {
  return {
    seq,
    ts: new Date(Date.UTC(2026, 8, 19, 14, 18, 11, seq)).toISOString(),
    price: `${65000 + seq}.00`,
    qty: "0.001000",
  };
}

describe("TradeTape", () => {
  it("starts empty", () => {
    const tape = new TradeTape();
    expect(tape.trades).toEqual([]);
    expect(tape.latestSeq).toBeNull();
    expect(tape.size).toBe(0);
  });

  it("lists the newest trade first", () => {
    const tape = new TradeTape();
    tape.push(trade(1));
    tape.push(trade(2));
    tape.push(trade(3));

    expect(tape.trades.map((entry) => entry.seq)).toEqual([3, 2, 1]);
    expect(tape.latestSeq).toBe(3);
  });

  it("keeps only the most recent window and forgets the oldest", () => {
    const tape = new TradeTape(30);
    for (let seq = 1; seq <= 35; seq += 1) {
      expect(tape.push(trade(seq))).toBe(true);
    }

    expect(tape.trades).toHaveLength(30);
    expect(tape.trades[0].seq).toBe(35);
    expect(tape.trades[29].seq).toBe(6);
    expect(tape.latestSeq).toBe(35);
  });

  it("defaults to the configured tape depth", () => {
    const tape = new TradeTape();
    for (let seq = 1; seq <= TRADE_TAPE_SIZE + 5; seq += 1) {
      tape.push(trade(seq));
    }
    expect(tape.trades).toHaveLength(TRADE_TAPE_SIZE);
  });

  it("ignores a repeat instead of showing the same trade twice", () => {
    const tape = new TradeTape();
    tape.push(trade(7));

    expect(tape.push(trade(7))).toBe(false);
    expect(tape.trades).toHaveLength(1);
  });

  it("ignores a late trade below the newest seq", () => {
    const tape = new TradeTape();
    tape.push(trade(10));

    expect(tape.push(trade(9))).toBe(false);
    expect(tape.trades.map((entry) => entry.seq)).toEqual([10]);
    expect(tape.latestSeq).toBe(10);
  });

  it("forgets everything on reset: a reconnect is a new session", () => {
    const tape = new TradeTape();
    tape.push(trade(1));
    tape.push(trade(2));

    tape.reset();

    expect(tape.trades).toEqual([]);
    expect(tape.latestSeq).toBeNull();
    // A fresh session's first trade is accepted even though its seq is low.
    expect(tape.push(trade(1))).toBe(true);
  });

  it("refuses a nonsense depth instead of holding every trade forever", () => {
    expect(() => new TradeTape(0)).toThrow();
    expect(() => new TradeTape(-3)).toThrow();
    expect(() => new TradeTape(2.5)).toThrow();
  });
});

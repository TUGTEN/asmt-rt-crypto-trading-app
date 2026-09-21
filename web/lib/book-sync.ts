/**
 * The book merge — the client half of "the book heals itself" (SPEC Bullet 1,
 * SEAMS Slice B).
 *
 * The backend ships full 10×10 book images with ids (`seq`, `prevSeq`), so the
 * merge is a replacement, and the ids are what make the replacement safe:
 * a frame lands only when its `prevSeq` is the `seq` we last applied. Anything
 * else — a jump forward, a frame that claims no parent, a frame older than what
 * we hold — is either ignored (it is history we already applied) or reported as
 * a `gap`, which is the caller's signal to refetch `/api/snapshot`.
 *
 * The in-flight race is handled here too: while a snapshot request flies, the
 * merger *buffers* frames instead of applying them, and the snapshot itself
 * resolves the buffer — dropping frames at or below its `seq` (already included
 * in the snapshot) and replaying the newer ones in order.
 *
 * This module is pure and React-free: no socket, no fetch, no clock. The
 * networking module (`lib/ws-client.ts`) decides *when* to refetch; the merger
 * only ever answers "this frame fits" or "this frame does not".
 */

import { BOOK_BUFFER_LIMIT } from "@/lib/config";
import type { BookFrame, Level, Snapshot } from "@/lib/protocol";

/** What the merge did with a frame — the externally visible outcome. */
export type MergeOutcome =
  /** Applied: the book on screen is now this frame's image. */
  | { kind: "applied"; seq: number }
  /** Held until the snapshot in flight lands. */
  | { kind: "buffered"; buffered: number }
  /** At or below the applied seq: a repeat or a late arrival, book untouched. */
  | { kind: "ignored"; seq: number }
  /** Does not chain onto the applied seq: refetch a snapshot (`lastAppliedSeq` may be null). */
  | { kind: "gap"; lastAppliedSeq: number | null; frameSeq: number }
  /** No base at all yet: nothing may be applied, refetch a snapshot. */
  | { kind: "awaiting-snapshot" };

/** What a fetched snapshot did, including how the buffer resolved against it. */
export type SyncOutcome =
  | { kind: "applied"; seq: number; discarded: number; replayed: number }
  | {
      kind: "gap";
      lastAppliedSeq: number | null;
      frameSeq: number;
      discarded: number;
      replayed: number;
    };

/** A frame's levels are shared with the store, so the merger keeps its own. */
function copyLevels(levels: Level[]): Level[] {
  return levels.map((level) => ({ price: level.price, qty: level.qty }));
}

function image(seq: number, bids: Level[], asks: Level[]): Snapshot {
  return { seq, bids: copyLevels(bids), asks: copyLevels(asks) };
}

export class BookMerger {
  private readonly bufferLimit: number;
  private base: Snapshot | null = null;
  private appliedSeq: number | null = null;
  private buffer: BookFrame[] = [];
  private inFlight = false;

  constructor(options: { bufferLimit?: number } = {}) {
    const limit = options.bufferLimit ?? BOOK_BUFFER_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("bufferLimit must be a positive integer");
    }
    this.bufferLimit = limit;
  }

  /** The book worth rendering: the last snapshot, plus every frame that chained onto it. */
  get book(): Snapshot | null {
    return this.base;
  }

  get lastAppliedSeq(): number | null {
    return this.appliedSeq;
  }

  get syncing(): boolean {
    return this.inFlight;
  }

  get buffered(): number {
    return this.buffer.length;
  }

  /** A snapshot request just went out: hold frames until it lands. */
  beginSync(): void {
    this.inFlight = true;
  }

  /**
   * Feed one live frame.
   *
   * Returns what happened, and never throws: a caller that drops malformed
   * traffic before this point still sees every valid frame answered.
   */
  ingest(frame: BookFrame): MergeOutcome {
    if (this.inFlight) {
      this.buffer.push(frame);
      // Over budget the *oldest* frame goes: it is the most likely to be
      // superseded by the snapshot in flight, and its loss surfaces as a gap
      // (a refetch) rather than as a book built on a hole.
      if (this.buffer.length > this.bufferLimit) {
        this.buffer.shift();
      }
      return { kind: "buffered", buffered: this.buffer.length };
    }
    return this.apply(frame);
  }

  /** The snapshot the request returned: adopt it, then replay the buffer. */
  endSync(snapshot: Snapshot): SyncOutcome {
    const buffered = this.buffer;
    this.buffer = [];
    this.inFlight = false;
    this.base = image(snapshot.seq, snapshot.bids, snapshot.asks);
    this.appliedSeq = snapshot.seq;
    let seq = snapshot.seq;

    let discarded = 0;
    let replayed = 0;
    for (const frame of buffered) {
      if (frame.seq <= snapshot.seq) {
        // The snapshot already contains this frame's change.
        discarded += 1;
        continue;
      }
      const outcome = this.apply(frame);
      if (outcome.kind === "applied") {
        seq = outcome.seq;
        replayed += 1;
        continue;
      }
      if (outcome.kind === "ignored") {
        continue;
      }
      return {
        kind: "gap",
        lastAppliedSeq: this.appliedSeq,
        frameSeq: frame.seq,
        discarded,
        replayed,
      };
    }
    return { kind: "applied", seq, discarded, replayed };
  }

  /**
   * The snapshot request failed. The base stays frozen and frames keep being
   * buffered: applying one onto a base we do not trust is exactly the corrupt
   * book this slice exists to prevent.
   */
  failSync(): void {
    this.inFlight = true;
  }

  /** A reconnect is a new session: no base, no buffer, and a fresh snapshot. */
  reset(): void {
    this.base = null;
    this.appliedSeq = null;
    this.buffer = [];
    this.inFlight = false;
  }

  private apply(frame: BookFrame): MergeOutcome {
    if (this.appliedSeq === null) {
      return { kind: "awaiting-snapshot" };
    }
    if (frame.seq <= this.appliedSeq) {
      return { kind: "ignored", seq: frame.seq };
    }
    if (frame.prevSeq !== this.appliedSeq) {
      return { kind: "gap", lastAppliedSeq: this.appliedSeq, frameSeq: frame.seq };
    }
    this.base = image(frame.seq, frame.bids, frame.asks);
    this.appliedSeq = frame.seq;
    return { kind: "applied", seq: frame.seq };
  }
}

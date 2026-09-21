import { describe, expect, it } from "vitest";

import { BookMerger } from "@/lib/book-sync";
import type { BookFrame, Level, Snapshot } from "@/lib/protocol";

/**
 * SEAMS Slice B / SPEC Bullet 1, as a scripted protocol: given a snapshot and a
 * sequence of frames, the merged book is either the one we trust or a signal to
 * refetch — never a frame applied onto the wrong base.
 *
 * Frames here are built by hand instead of parsed from text: the guards that
 * turn text into frames are pinned in `protocol.frames.test.ts`, and this file
 * is about what the *merge* does with a valid frame.
 */

/** One level per side, tagged so a test can tell which image is on screen. */
function side(tag: number): Level[] {
  return [{ price: `${tag}.00`, qty: "1.000000" }];
}

function frame(seq: number, prevSeq: number | null, tag = seq): BookFrame {
  return { type: "book", seq, prevSeq, bids: side(tag), asks: side(tag + 1) };
}

function snapshot(seq: number, tag = seq): Snapshot {
  return { seq, bids: side(tag), asks: side(tag + 1) };
}

/** The tag of the book image currently held, read off a level price. */
function tagOf(book: Snapshot | null): string | null {
  return book === null ? null : book.bids[0].price;
}

describe("BookMerger", () => {
  it("starts empty and refuses to apply a frame with no base to apply it to", () => {
    const merger = new BookMerger();
    expect(merger.book).toBeNull();
    expect(merger.lastAppliedSeq).toBeNull();

    expect(merger.ingest(frame(10, 9))).toEqual({ kind: "awaiting-snapshot" });
    expect(merger.book).toBeNull();
  });

  it("chains frames onto the snapshot and keeps the newest image", () => {
    const merger = new BookMerger();
    expect(merger.endSync(snapshot(10))).toMatchObject({ kind: "applied", seq: 10 });
    expect(tagOf(merger.book)).toBe("10.00");

    expect(merger.ingest(frame(11, 10))).toEqual({ kind: "applied", seq: 11 });
    expect(merger.ingest(frame(12, 11))).toEqual({ kind: "applied", seq: 12 });

    expect(merger.book?.seq).toBe(12);
    expect(tagOf(merger.book)).toBe("12.00");
    expect(merger.lastAppliedSeq).toBe(12);
  });

  it("signals a gap instead of applying a frame onto the wrong base", () => {
    const merger = new BookMerger();
    merger.endSync(snapshot(12));

    // 13 and 14 never arrived: this frame's parent is not what we hold.
    expect(merger.ingest(frame(15, 14))).toEqual({
      kind: "gap",
      lastAppliedSeq: 12,
      frameSeq: 15,
    });
    expect(merger.book?.seq).toBe(12);
    expect(tagOf(merger.book)).toBe("12.00");
  });

  it("rejects the gap injector's frame: the seq jumps while prevSeq names a skipped id", () => {
    // api/feed.go gapSkip=5: holding 638, the injected frame is {644 <- 643}.
    // 643 was never materialized, so the merge must refuse it and signal the
    // refetch — the client half of api/scenario_test.go's wire pin.
    const merger = new BookMerger();
    merger.endSync(snapshot(638));

    expect(merger.ingest(frame(644, 643))).toEqual({
      kind: "gap",
      lastAppliedSeq: 638,
      frameSeq: 644,
    });
    expect(merger.book?.seq).toBe(638);
  });

  it("signals a gap for a frame that claims no parent at all", () => {
    const merger = new BookMerger();
    merger.endSync(snapshot(12));

    expect(merger.ingest(frame(13, null))).toEqual({
      kind: "gap",
      lastAppliedSeq: 12,
      frameSeq: 13,
    });
    expect(merger.book?.seq).toBe(12);
  });

  it("ignores a late repeat below the applied seq without crying gap", () => {
    const merger = new BookMerger();
    merger.endSync(snapshot(12));
    merger.ingest(frame(13, 12));

    // A duplication of the frame we already applied, then a much older one.
    expect(merger.ingest(frame(13, 12))).toEqual({ kind: "ignored", seq: 13 });
    expect(merger.ingest(frame(11, 10))).toEqual({ kind: "ignored", seq: 11 });

    expect(merger.book?.seq).toBe(13);
    expect(tagOf(merger.book)).toBe("13.00");
  });

  it("buffers frames that arrive while the snapshot request is in flight", () => {
    const merger = new BookMerger();
    merger.endSync(snapshot(12));
    merger.ingest(frame(13, 12));

    merger.beginSync();
    expect(merger.syncing).toBe(true);

    expect(merger.ingest(frame(20, 19))).toEqual({ kind: "buffered", buffered: 1 });
    expect(merger.ingest(frame(21, 20))).toEqual({ kind: "buffered", buffered: 2 });

    // Nothing is applied while the request flies: the old base is frozen.
    expect(merger.book?.seq).toBe(13);
    expect(tagOf(merger.book)).toBe("13.00");
  });

  it("drops buffered frames at or below the snapshot seq and replays the rest in order", () => {
    const merger = new BookMerger();
    merger.beginSync();
    merger.ingest(frame(20, 19));
    merger.ingest(frame(21, 20));
    merger.ingest(frame(22, 21));

    // The snapshot the backend sent is already past 21: those frames are history.
    expect(merger.endSync(snapshot(21))).toEqual({
      kind: "applied",
      seq: 22,
      discarded: 2,
      replayed: 1,
    });
    expect(merger.syncing).toBe(false);
    expect(merger.book?.seq).toBe(22);
    expect(tagOf(merger.book)).toBe("22.00");
  });

  it("reports a gap when the buffer cannot be chained onto the fresh snapshot", () => {
    const merger = new BookMerger();
    merger.beginSync();
    merger.ingest(frame(30, 29));

    expect(merger.endSync(snapshot(21))).toEqual({
      kind: "gap",
      lastAppliedSeq: 21,
      frameSeq: 30,
      discarded: 0,
      replayed: 0,
    });
    // The snapshot is trusted — it is what makes the next refetch meaningful.
    expect(merger.book?.seq).toBe(21);
    expect(tagOf(merger.book)).toBe("21.00");
  });

  it("keeps a fresh snapshot even when its seq is behind, and stops buffering", () => {
    const merger = new BookMerger();
    merger.endSync(snapshot(900));
    merger.beginSync();
    expect(merger.endSync(snapshot(5))).toMatchObject({ kind: "applied", seq: 5 });
    expect(merger.syncing).toBe(false);
    expect(merger.book?.seq).toBe(5);
    expect(merger.ingest(frame(6, 5))).toEqual({ kind: "applied", seq: 6 });
  });

  it("keeps buffering after a failed snapshot request, so nothing lands unbased", () => {
    const merger = new BookMerger();
    merger.endSync(snapshot(19));
    merger.beginSync();
    merger.ingest(frame(20, 19));

    merger.failSync();
    expect(merger.syncing).toBe(true);
    expect(merger.ingest(frame(21, 20))).toEqual({ kind: "buffered", buffered: 2 });
    expect(merger.book?.seq).toBe(19);

    expect(merger.endSync(snapshot(19))).toMatchObject({ kind: "applied", seq: 21 });
    expect(merger.book?.seq).toBe(21);
    expect(tagOf(merger.book)).toBe("21.00");
  });

  it("never grows the buffer without bound, and says so instead of guessing", () => {
    const merger = new BookMerger({ bufferLimit: 4 });
    merger.beginSync();
    for (const seq of [40, 41, 42, 43, 44]) {
      merger.ingest(frame(seq, seq - 1));
    }

    expect(merger.buffered).toBe(4);
    // 40 was dropped to stay in budget, so 41 no longer chains onto 39.
    expect(merger.endSync(snapshot(39))).toMatchObject({ kind: "gap", lastAppliedSeq: 39 });
    expect(tagOf(merger.book)).toBe("39.00");
  });

  it("forgets base and buffer on reset: a reconnect is a new session", () => {
    const merger = new BookMerger();
    merger.endSync(snapshot(12));
    merger.ingest(frame(13, 12));
    merger.beginSync();
    merger.ingest(frame(14, 13));

    merger.reset();

    expect(merger.book).toBeNull();
    expect(merger.lastAppliedSeq).toBeNull();
    expect(merger.syncing).toBe(false);
    expect(merger.buffered).toBe(0);
    expect(merger.ingest(frame(14, 13))).toEqual({ kind: "awaiting-snapshot" });
  });

  it("handles an empty input stream: an untouched merger is a valid state", () => {
    const merger = new BookMerger();
    expect(merger.endSync(snapshot(1))).toEqual({
      kind: "applied",
      seq: 1,
      discarded: 0,
      replayed: 0,
    });
    expect(merger.buffered).toBe(0);
  });
});

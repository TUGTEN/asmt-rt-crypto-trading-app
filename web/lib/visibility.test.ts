import { describe, expect, it } from "vitest";

import { followVisibility, type Session, type VisibilitySource } from "@/lib/visibility";

/**
 * Tab visibility, driven by a script instead of a browser.
 *
 * The promise (`CONTEXT.md`, Live vs Stale) is that a hidden tab never shows
 * cached values as live. The client picks the strongest version of that: the
 * session *ends* while the tab is hidden and a fresh one is dialed when it comes
 * back — a new session, so a resubscribe and a re-synced book rather than a
 * stream nobody was watching. These tests pin the decisions that sentence needs:
 * who starts, who stops, what a duplicate event does, and what a dispose leaves
 * behind.
 */

/** A `document` stand-in: one flag, and listeners a test can fire by hand. */
class FakeDocument implements VisibilitySource {
  hidden = false;
  readonly listeners = new Set<() => void>();

  addEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners.delete(listener);
  }

  /** Move the tab and fire the event the browser would fire. */
  switchTo(next: boolean): void {
    this.hidden = next;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

/** A `WsClient` stand-in: what the lifecycle is allowed to do to it, recorded. */
function fakeSession() {
  const calls: string[] = [];
  const session: Session = {
    start: () => calls.push("start"),
    stop: () => calls.push("stop"),
  };
  return { calls, session };
}

describe("followVisibility", () => {
  it("runs the session while the tab is visible and ends it when it is hidden", () => {
    const source = new FakeDocument();
    const { calls, session } = fakeSession();

    followVisibility(source, session);
    expect(calls).toEqual(["start"]);

    source.switchTo(true);
    expect(calls).toEqual(["start", "stop"]);

    source.switchTo(false);
    expect(calls).toEqual(["start", "stop", "start"]);
  });

  it("never dials a session mounted in a hidden tab", () => {
    const source = new FakeDocument();
    source.hidden = true;
    const { calls, session } = fakeSession();

    const lifecycle = followVisibility(source, session);

    // The reading at bind time counts: a background tab has not dialed, and has
    // nothing on screen that could be mistaken for live.
    expect(calls).toEqual(["stop"]);
    expect(lifecycle.hidden).toBe(true);

    source.switchTo(false);
    expect(calls).toEqual(["stop", "start"]);
    expect(lifecycle.hidden).toBe(false);
  });

  it("ignores repeat events, so a duplicate reading cannot redial a session", () => {
    const source = new FakeDocument();
    const { calls, session } = fakeSession();
    followVisibility(source, session);

    source.switchTo(false); // visible -> visible, reported again
    source.switchTo(true);
    source.switchTo(true); // hidden -> hidden, reported again
    expect(calls).toEqual(["start", "stop"]);
  });

  it("removes its listener and ends the session on dispose, once", () => {
    const source = new FakeDocument();
    const { calls, session } = fakeSession();
    const lifecycle = followVisibility(source, session);

    source.switchTo(true);
    lifecycle.dispose();

    expect(calls).toEqual(["start", "stop", "stop"]);
    expect(source.listeners.size).toBe(0);

    // Late events from a listener that is gone, and a second dispose, must not
    // reach the session: the component that owned it has unmounted.
    lifecycle.dispose();
    source.switchTo(false);
    expect(calls).toEqual(["start", "stop", "stop"]);
  });
});

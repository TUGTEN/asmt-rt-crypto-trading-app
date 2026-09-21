/**
 * Tab visibility, as a lifecycle the market session follows.
 *
 * `CONTEXT.md` makes a hidden tab one of the three times the screen is *stale*,
 * and this module decides the strongest honest version of that: while the tab is
 * hidden the session is **not running at all**. The socket is closed, the ping
 * timer is cancelled, and the stores say `stale` (that is what `WsClient.stop()`
 * writes); becoming visible dials a *new* session, which is also how this client
 * resubscribes — the topics and the chart interval are the socket URL's query
 * string, so dialing again is subscribing again, and the book re-syncs from a
 * fresh snapshot because a reconnect is a new session.
 *
 * The alternative — keep the socket dialed and merely relabel the screen — was
 * rejected for two reasons. A hidden tab is not being watched, so its frames,
 * its chart, and its 2s ping loop are pure cost; and a backgrounded tab's timers
 * are throttled by the browser, so the probes such a tab *did* send would be
 * late and irregular, which the backend is entitled to tier on. Pausing means
 * there is no stream to present as live: no stale-as-live is possible, because
 * there is no live.
 *
 * The source is injected (three members of `document`), so the whole decision is
 * testable without a DOM, and the session is injected as the `{start, stop}` pair
 * `WsClient` already implements — this module never learns what a socket is.
 */

/** The slice of `document` this needs, named so a test can hand in an object. */
export type VisibilitySource = {
  /** `document.hidden`: background tab, or a minimized window. */
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

/** What a visibility-bound session has to be able to do; `WsClient` is one. */
export type Session = {
  start(): void;
  stop(): void;
};

export type VisibilityLifecycle = {
  /** What the source last said; `true` while the session is deliberately down. */
  readonly hidden: boolean;
  /** Stop following visibility and end the session. Idempotent. */
  dispose(): void;
};

export const VISIBILITY_EVENT = "visibilitychange";

/**
 * Bind a session's running lifetime to the tab's visibility.
 *
 * The reading at bind time counts too: a screen mounted in a hidden tab does not
 * dial until it is looked at. Repeat readings are ignored — browsers re-announce
 * visibility on `bfcache` restore and on window moves, and a session that
 * re-dialed on each announcement would be a reconnect storm with a wasted
 * snapshot behind every one.
 */
export function followVisibility(
  source: VisibilitySource,
  session: Session,
): VisibilityLifecycle {
  let hidden = source.hidden;
  let disposed = false;

  const onChange = (): void => {
    if (disposed) {
      return;
    }
    const next = source.hidden;
    if (next === hidden) {
      return;
    }
    hidden = next;
    if (next) {
      session.stop();
    } else {
      session.start();
    }
  };

  source.addEventListener(VISIBILITY_EVENT, onChange);
  // Apply the opening reading. A session stopped before it ever started has
  // nothing on screen to mark stale — `WsClient.stop()` is a no-op when it is not
  // running — which is why the hook does not start it first and then stop it.
  if (hidden) {
    session.stop();
  } else {
    session.start();
  }

  return {
    get hidden(): boolean {
      return hidden;
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      source.removeEventListener(VISIBILITY_EVENT, onChange);
      // Unmounting disposes what the component owns: the session, its socket,
      // and every timer it scheduled.
      session.stop();
    },
  };
}

/**
 * The production source. The only DOM in this module, and the only function here
 * that cannot run in a test process — everything above it takes its readings
 * from the object it is handed.
 */
export function documentVisibility(): VisibilitySource {
  return {
    get hidden(): boolean {
      return document.hidden;
    },
    addEventListener: (type, listener) => document.addEventListener(type, listener),
    removeEventListener: (type, listener) => document.removeEventListener(type, listener),
  };
}

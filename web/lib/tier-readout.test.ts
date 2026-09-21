import { describe, expect, it } from "vitest";

import { formatRate, tierReadout } from "@/lib/tier-readout";
import type { ConnState } from "@/stores/conn";
import { INITIAL_CONN_STATE } from "@/stores/conn";

/**
 * The delivery readout (SPEC story 11, Slice A), pinned as pure derivation.
 *
 * The badge is a component and components are covered by the app run; what is
 * pinned here is what it *says*, because the honesty rule of this slice lives in
 * this mapping: the tier and the rate are the backend's own numbers, rendered as
 * they arrive, and the debug override is shown as a separate fact beside them —
 * never folded into the tier, and never allowed to claim a decision the backend
 * has not announced.
 */

function conn(patch: Partial<ConnState>): ConnState {
  return { ...INITIAL_CONN_STATE, ...patch };
}

describe("tierReadout", () => {
  it("says it is waiting rather than guessing a tier before the first frame", () => {
    const readout = tierReadout(conn({}));

    expect(readout.tier).toBeNull();
    expect(readout.tierLabel).toBe("—");
    expect(readout.rateLabel).toBe("—");
    expect(readout.source).toBe("waiting");
    expect(readout.sourceLabel).toContain("waiting");
  });

  it("renders the backend's tier and the rate that came with it, verbatim", () => {
    const readout = tierReadout(conn({ tier: "degraded", tierRate: 1 }));

    expect(readout.tier).toBe("degraded");
    expect(readout.tierLabel).toBe("degraded");
    expect(readout.rate).toBe(1);
    expect(readout.rateLabel).toBe("1/s");
    expect(readout.source).toBe("automatic");
  });

  it("never recomputes the rate from a tier table", () => {
    // The rate is whatever the tier frame carried. If the backend changes what a
    // tier means (`lib/config.ts` is not the source of truth for it), the badge
    // follows the frame rather than a table this client invented.
    const readout = tierReadout(conn({ tier: "minimal", tierRate: 0.3 }));

    expect(readout.rateLabel).toBe("0.3/s");
  });

  it("calls the override forced only once the backend has announced it", () => {
    // The override is on the wire and the backend has not answered yet: the tier
    // in force is still the old one, and the readout says so instead of showing
    // the tier the user asked for as if it were delivering.
    const pending = tierReadout(conn({ tier: "full", tierRate: 4, override: "minimal" }));
    expect(pending.tier).toBe("full");
    expect(pending.tierLabel).toBe("full");
    expect(pending.source).toBe("pending");
    expect(pending.sourceLabel).toContain("minimal");

    // The tier frame arrives: now the override is the tier in force.
    const forced = tierReadout(conn({ tier: "minimal", tierRate: 0.25, override: "minimal" }));
    expect(forced.source).toBe("forced");
    expect(forced.sourceLabel).toContain("minimal");
    expect(forced.rateLabel).toBe("0.25/s");
  });

  it("resumes automatic when the override is cleared, on the backend's tier", () => {
    const cleared = tierReadout(conn({ tier: "minimal", tierRate: 0.25, override: null }));

    expect(cleared.override).toBeNull();
    expect(cleared.source).toBe("automatic");
    expect(cleared.tierLabel).toBe("minimal");
  });

  it("waits on the override too: a forced tier nobody has confirmed is not in force", () => {
    const readout = tierReadout(conn({ override: "degraded" }));

    expect(readout.source).toBe("pending");
    expect(readout.tierLabel).toBe("—");
  });
});

describe("formatRate", () => {
  it("writes the settled rates the way the backend names them", () => {
    expect(formatRate(4)).toBe("4/s");
    expect(formatRate(1)).toBe("1/s");
    expect(formatRate(0.25)).toBe("0.25/s");
    expect(formatRate(0.5)).toBe("0.5/s");
  });

  it("does not invent a reading when there is none", () => {
    expect(formatRate(null)).toBe("—");
  });
});

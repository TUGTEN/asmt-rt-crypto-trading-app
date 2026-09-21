/**
 * What the delivery badge says (SPEC story 11, `docs/SEAMS.md` Slice A).
 *
 * The tier is the backend's decision and the rate is the number that came with
 * the `tier` frame, so this module's whole job is to *say* those two things —
 * and to say them without flattering the client. `CONTEXT.md` has the backend
 * owning the tier and the client only measuring and reporting, which is why
 * nothing here derives a rate from a tier name or promotes the debug override to
 * "in force" before the backend has announced it.
 *
 * The debug override therefore reads as three distinct facts:
 *
 *   - `automatic` — no override is set; the tier in force is the backend's own.
 *   - `forced`    — an override is set *and* the announced tier is that tier.
 *   - `pending`   — an override was asked for and nothing has confirmed it yet
 *                   (the frame is in flight, or the socket is down).
 *
 * Pure and React-free, like `lib/format.ts`: the badge selects the values and
 * this decides what they mean, so the mapping is testable without a DOM.
 */

import type { Tier } from "@/lib/protocol";
import type { ConnState } from "@/stores/conn";

/** How the tier in force came about: the backend's policy, or the debug control. */
export type TierSource = "waiting" | "automatic" | "forced" | "pending";

export type TierReadout = {
  /** The tier the backend last announced, or `null` before the first frame. */
  tier: Tier | null;
  /** The tier word to render. */
  tierLabel: string;
  /** Chart updates per second the tier frame entitled this connection to. */
  rate: number | null;
  /** `"1/s"`, `"0.25/s"`; an em dash while no frame has arrived. */
  rateLabel: string;
  /** The debug selection, if any — shown beside the tier, never in place of it. */
  override: Tier | null;
  source: TierSource;
  /** One phrase for the badge, e.g. `"forced via debug control"`. */
  sourceLabel: string;
};

const UNSAFE = "—";

/** Rates are 4/1/0.25, but the frame decides: keep whatever precision it sent. */
export function formatRate(rate: number | null): string {
  if (rate === null) {
    return UNSAFE;
  }
  return `${rate}/s`;
}

/**
 * The fields the readout is a function of — all three of them, so the badge can
 * hand it exactly the values it selected and nothing else.
 */
export type TierFacts = Pick<ConnState, "tier" | "tierRate" | "override">;

export function tierReadout(state: TierFacts): TierReadout {
  const { tier, tierRate, override } = state;

  let source: TierSource;
  let sourceLabel: string;
  if (override === null) {
    source = tier === null ? "waiting" : "automatic";
    sourceLabel = tier === null ? "waiting for the first tier frame" : "automatic";
  } else if (tier === override) {
    source = "forced";
    sourceLabel = `forced ${override} via debug control`;
  } else {
    source = "pending";
    sourceLabel = `asked for ${override} — not in force yet`;
  }

  return {
    tier,
    tierLabel: tier ?? UNSAFE,
    rate: tierRate,
    rateLabel: formatRate(tierRate),
    override,
    source,
    sourceLabel,
  };
}

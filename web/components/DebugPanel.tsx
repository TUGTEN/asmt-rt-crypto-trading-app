"use client";

/**
 * The debug control (SPEC stories 12–13): force the delivery tier by hand, and
 * hand the decision back when you are done.
 *
 * What a click *does* is a wire write, so it belongs to the client: the buttons
 * only report the selection to `lib/ws-client.ts`, which sends
 * `{"type":"force","tier":"…"}` (or `{"type":"force","tier":null}` to clear) and
 * records the selection beside the backend's answer. Nothing here sets the tier
 * — the backend owns that, and it announces the change in the very next `tier`
 * frame, which is what the badge renders.
 *
 * The panel is labelled DEBUG, above the buttons, on purpose: a control that can
 * put a production-looking screen into a slower delivery tier must not be
 * mistakable for a feature. `lib/tier-readout.ts` supplies the same words the
 * badge uses, so "forced" here can never disagree with "forced" there.
 */

import { Panel } from "@/components/Panel";
import { tierReadout } from "@/lib/tier-readout";
import { TIERS, type Tier } from "@/lib/protocol";

type DebugPanelProps = {
  /** The tier the backend last announced, for context around the buttons. */
  tier: Tier | null;
  /** The standing selection: `null` while the backend's own decision stands. */
  override: Tier | null;
  /** Ask the backend for a tier. */
  onForce: (tier: Tier) => void;
  /** Clear the override: the backend resumes automatic (SPEC story 13). */
  onClear: () => void;
};

const BUTTON =
  "rounded px-2 py-1 font-mono text-[11px] font-medium transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-line";

export function DebugPanel({ tier, override, onForce, onClear }: DebugPanelProps) {
  // Clearing is the `{tier:null}` frame; the readout below says which of the
  // three states the override is in, using the badge's own wording.
  const readout = tierReadout({ tier, tierRate: null, override });

  return (
    <Panel
      title="Debug"
      hint="tier override"
      actions={
        <span className="rounded border border-stale/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-[0.18em] text-stale">
          DEBUG
        </span>
      }
    >

      <div
        role="group"
        aria-label="Force delivery tier"
        className="flex flex-wrap items-center gap-2"
      >
        <button
          type="button"
          aria-pressed={override === null}
          onClick={onClear}
          className={`${BUTTON} border ${
            override === null
              ? "border-line bg-line/60 text-ink"
              : "border-line/70 text-faint hover:text-muted"
          }`}
        >
          automatic
        </button>
        {TIERS.map((name) => {
          const selected = override === name;
          return (
            <button
              key={name}
              type="button"
              aria-pressed={selected}
              onClick={() => onForce(name)}
              className={`${BUTTON} border ${
                selected ? "border-stale/60 bg-stale/20 text-stale" : "border-line/70 text-faint hover:text-muted"
              }`}
            >
              {name}
            </button>
          );
        })}
      </div>

      <p className="mt-3 border-t border-line pt-3 font-mono text-[11px] font-medium text-muted">
        override:{" "}
        {override === null ? "none — the backend decides" : override} ·{" "}
        <span className="text-faint">{readout.sourceLabel}</span>
      </p>
    </Panel>
  );
}

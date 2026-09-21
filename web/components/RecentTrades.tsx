import { Figure } from "@/components/Figure";
import { Panel } from "@/components/Panel";
import {
  formatPrice,
  formatQtyFixed,
  formatClock,
  movement,
  parseDecimal,
} from "@/lib/format";
import type { Trade } from "@/lib/protocol";

type RecentTradesProps = {
  /** The tape, newest first — the order it came off the wire. */
  trades: readonly Trade[];
  /** The socket is not delivering: these prints are cached, not live. */
  stale: boolean;
  /** Collapsed when false: header + toggle stay mounted, body unmounts. */
  expanded: boolean;
  onToggle: () => void;
};

const TICK_TONE = {
  up: "text-bid",
  down: "text-ask",
  flat: "text-ink-dim",
  unknown: "text-ink-dim",
} as const;

const HEADERS = ["time", "price", "size"] as const;

function EmptyTape({ stale }: { stale: boolean }) {
  return (
    <div className="flex h-28 flex-col items-center justify-center gap-1 rounded border border-dashed border-line bg-panel-alt/50 px-6 text-center">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
        no trades on the tape
      </p>
      <p className="max-w-xs font-mono text-[11px] leading-relaxed text-faint">
        {stale
          ? "the socket is down — the tape resumes where the market resumes, from the next print"
          : "the tape fills as the socket delivers trades; each one carries its ordering id and UTC stamp"}
      </p>
    </div>
  );
}

/**
 * The trade tape: what actually printed, newest first.
 *
 * Trades are the atomic truth of the market (CONTEXT.md) and the ordering id is
 * what keeps this list honest — a repeat or a late arrival is dropped by the
 * tape, not de-duplicated here. Each row's colour compares it with the print
 * before it, so the tape reads as movement rather than a column of numbers.
 *
 * Figures go through <Figure>: fixed-width sizes stop the column jittering as
 * prints come and go, and the dimmed tail keeps the eye on the significant
 * figures first. Figure inherits the tick tone; only the tail drops to
 * text-faint.
 */
export function RecentTrades({ trades, stale, expanded, onToggle }: RecentTradesProps) {
  return (
    <Panel
      title="Recent trades"
      hint={trades.length === 0 ? "waiting for the tape" : `newest ${trades.length}`}
      actions={
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="rounded border border-line/70 px-2 py-1 font-mono text-[11px] text-faint transition-colors hover:text-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-line"
        >
          {expanded ? "hide" : "show"}
        </button>
      }
      className="flex h-full flex-col"
    >
      {expanded ? (
        trades.length === 0 ? (
          <EmptyTape stale={stale} />
        ) : (
        <div
          className={`flex-1 min-h-0 overflow-y-auto transition-opacity ${stale ? "opacity-60" : ""}`}
        >
          <table className="w-full border-collapse font-mono text-xs tabular-nums">
            <thead>
              <tr className="sticky top-0 bg-panel text-[10px] uppercase tracking-[0.12em] text-faint">
                {HEADERS.map((header, index) => (
                  <th
                    key={header}
                    scope="col"
                    className={`pb-1 font-medium ${index === 0 ? "text-left" : "text-right"}`}
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trades.map((trade, index) => {
                const previous = trades[index + 1];
                const tick = movement(
                  previous === undefined ? null : parseDecimal(previous.price),
                  parseDecimal(trade.price),
                );
                return (
                  <tr key={trade.seq} className="border-t border-line/60">
                    <td className="py-1 pr-2 font-medium text-faint" title={trade.ts}>
                      {formatClock(Date.parse(trade.ts))}
                    </td>
                    <td className={`py-1 pl-2 text-right ${TICK_TONE[tick]}`}>
                      <Figure value={formatPrice(trade.price)} />
                    </td>
                    <td className="py-1 pl-2 text-right font-medium text-ink-dim"><Figure value={formatQtyFixed(trade.qty)} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        )
      ) : null}
    </Panel>
  );
}

import type { Interval } from "@/lib/protocol";

type IntervalToggleProps = {
  /** The intervals the backend advertises, as labels. */
  intervals: Interval[];
  /** The interval the chart is following. */
  active: Interval;
  /** The store owns the switch; this control only reports the click. */
  onSelect: (interval: Interval) => void;
};

/**
 * Interval selector — wired to the chart's store since T3.
 *
 * The control is deliberately dumb: it reports which interval was clicked and
 * renders which one is open. Everything a switch *means* — dropping the previous
 * interval's candles so none can be mistaken for the new one's, moving the
 * request id so a response for the interval we left cannot land, resubscribing
 * the socket with the new chart interval — belongs to `stores/candle.ts` and
 * `lib/ws-client.ts`, and is pinned in `stores/candle.test.ts`.
 *
 * Clicking the open interval is a no-op rather than a reload: a switch that
 * cannot change anything should not look like it did.
 */
export function IntervalToggle({ intervals, active, onSelect }: IntervalToggleProps) {
  return (
    <div
      role="group"
      aria-label="Candle interval"
      className="flex items-center rounded border border-line/70 bg-panel-alt/50 p-0.5"
    >
      {intervals.map((interval) => {
        const selected = interval === active;
        return (
          <button
            key={interval}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(interval)}
            className={`rounded px-2 py-1 font-mono text-[11px] font-medium transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-line ${
              selected ? "bg-line text-ink" : "text-faint hover:text-muted"
            }`}
          >
            {interval}
          </button>
        );
      })}
    </div>
  );
}

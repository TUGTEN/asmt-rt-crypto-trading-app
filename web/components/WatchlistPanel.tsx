"use client";

/**
 * The chart's parked placeholder: what the chart area shows while a temp
 * watchlist chip is selected. An explicit parked state, never a chart
 * pretending to stream. The book, tape, and ticker keep showing BTC-USD —
 * only this pane parks — and one click returns to live.
 *
 * The reorderable surface itself moved to the top ticker tape
 * (`components/WatchlistTape.tsx`, horizontal dnd-kit); this file keeps only
 * the placeholder that the tape's selection drives.
 */

import { Panel } from "@/components/Panel";
import { LIVE_SYMBOL, tempRefPrice } from "@/lib/watchlist";

export function ParkedChartPanel({ symbol, onBack }: { symbol: string; onBack: () => void }) {
  const ref = tempRefPrice(symbol);
  return (
    <Panel title={`Chart — ${symbol}`} hint="parked">
      <div className="flex min-w-0 flex-col items-start gap-2 py-6">
        <p className="font-mono text-[12px] font-medium text-muted">
          {symbol} is a static reference{ref === null ? "" : ` (${ref}, simulated)`} — only{" "}
          {LIVE_SYMBOL} streams.
        </p>
        <p className="font-mono text-[11px] font-medium text-faint">
          Book, tape, and ticker below keep showing {LIVE_SYMBOL} live.
        </p>
        <button
          type="button"
          onClick={onBack}
          className="mt-1 rounded border border-line/70 px-2 py-1 font-mono text-[11px] font-medium text-muted transition-colors hover:bg-line/40 hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-line"
        >
          ← Back to {LIVE_SYMBOL} live
        </button>
      </div>
    </Panel>
  );
}

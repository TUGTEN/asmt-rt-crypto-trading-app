import { SiteShell } from "@/components/SiteShell";

/**
 * Server shell (T1 / bullet 0): static footer plus the client shell
 * (navbar + data screen). The page intentionally does not
 * touch the backend at build or request time — `next build` must succeed with
 * no backend running, and every fetch belongs to the browser.
 */
export default function Page() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteShell />

      <footer className="mt-auto border-t border-line px-4 py-4 lg:px-8">
        <p className="mx-auto w-full max-w-[1440px] font-mono text-[11px] font-medium text-faint">
          Seeded BTC-USD generator · prices and sizes cross the wire as decimal strings with
          ordering ids · book, trades, and candles stream over <span className="text-muted">/ws</span>,
          with gaps healed from <span className="text-muted">/api/snapshot</span> and the chart
          opened from <span className="text-muted">/api/history</span> · charting by
          <a
            className="text-muted underline decoration-dotted underline-offset-2 hover:text-ink"
            href="https://www.tradingview.com/"
            target="_blank"
            rel="noopener noreferrer"
          >
            TradingView
          </a>
          (<span className="text-muted">lightweight-charts</span>)
        </p>
      </footer>
    </div>
  );
}

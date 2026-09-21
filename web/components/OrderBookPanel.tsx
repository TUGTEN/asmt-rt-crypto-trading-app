import { Figure } from "@/components/Figure";
import { Panel } from "@/components/Panel";
import type { BookLevelView } from "@/lib/format";
import { bestAsk, bestBid, bookLadder, formatPrice, midPrice, spread } from "@/lib/format";
import type { Snapshot } from "@/lib/protocol";

type OrderBookPanelProps = {
  snapshot: Snapshot | null;
  depth: number;
  /** The socket is down or unsubscribed: these levels are cached, not live. */
  stale: boolean;
  /** A snapshot refetch is in flight: the image on screen is frozen. */
  syncing: boolean;
};

type Side = "bid" | "ask";

const SIDE_STYLE: Record<Side, { tone: string; bar: string }> = {
  bid: { tone: "text-bid", bar: "bg-bid/15" },
  ask: { tone: "text-ask", bar: "bg-ask/15" },
};

/** The price column carries the side: no group label row, the table stays compact. */
const SIDE_PRICE_HEADER: Record<Side, string> = {
  bid: "bids · price",
  ask: "asks · price",
};

const HEADERS = ["price", "size", "total"] as const;

function EmptyRows({ side, message }: { side: Side; message: string }) {
  return (
    <tr>
      <td
        colSpan={HEADERS.length}
        className={`px-2 py-6 text-center font-ui text-[11px] font-medium ${
          side === "bid" ? "text-bid/60" : "text-ask/60"
        }`}
      >
        {message}
      </td>
    </tr>
  );
}

/**
 * One side of the book: figures go through <Figure> so fixed-width sizes stop
 * the column jittering as levels come and go, and the dimmed tail keeps the
 * eye on the significant figures first. Figure inherits the row tone; only
 * the tail drops to text-faint.
 */
function BookSide({
  side,
  rows,
  emptyMessage,
}: {
  side: Side;
  rows: BookLevelView[];
  emptyMessage: string;
}) {
  const style = SIDE_STYLE[side];
  return (
    <div className="min-w-0">
      <table className="w-full border-collapse font-mono text-xs tabular-nums">
        <thead>
          <tr className="font-ui text-[10px] uppercase tracking-[0.12em] text-faint">
            <th scope="col" aria-label={side === "bid" ? "Bid prices" : "Ask prices"} className={`py-1 text-left font-medium ${style.tone}`}>
              {SIDE_PRICE_HEADER[side]}
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              size
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              total
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyRows side={side} message={emptyMessage} />
          ) : (
            rows.map((row, index) => (
              <tr
                key={row.key}
                className={`border-t border-line/60 ${index === 0 ? "bg-panel-alt/60 font-semibold" : ""}`}
              >
                <td className={`py-1 pr-2 ${style.tone}`}>
                  <span className="relative inline-block px-1">
                    <span
                      aria-hidden
                      className={`absolute inset-y-0 right-0 ${style.bar}`}
                      style={{ width: `${row.depth}%` }}
                    />
                    <span className="relative"><Figure value={row.price} /></span>
                  </span>
                </td>
                <td className="py-1 pl-2 text-right font-medium text-ink-dim"><Figure value={row.qty} /></td>
                <td className="py-1 pl-2 text-right font-medium text-faint"><Figure value={row.total} /></td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function OrderBookPanel({ snapshot, depth, stale, syncing }: OrderBookPanelProps) {
  const bids = snapshot === null ? [] : bookLadder(snapshot.bids, depth);
  const asks = snapshot === null ? [] : bookLadder(snapshot.asks, depth);
  const bid = snapshot === null ? null : bestBid(snapshot);
  const ask = snapshot === null ? null : bestAsk(snapshot);
  const spreadValue = snapshot === null ? null : spread(snapshot);
  const mid = snapshot === null ? null : midPrice(snapshot);
  const spreadPercent =
    spreadValue !== null && mid !== null && mid > 0 ? (spreadValue / mid) * 100 : null;

  return (
    <Panel
      title="Order book"
      hint={
        snapshot === null
          ? syncing
            ? "fetching /api/snapshot…"
            : "waiting for the first snapshot"
          : syncing
            ? `seq ${snapshot.seq} · refetching`
            : `seq ${snapshot.seq}`
      }
      className="min-h-0"
    >
      {syncing ? (
        <p className="mb-2 font-ui text-[11px] text-stale">
          {stale ? "refetching a snapshot" : "refetching a snapshot — the book resumes on it"}
        </p>
      ) : stale ? (
        <p className="mb-2 font-ui text-[11px] text-stale">cached — the socket is down</p>
      ) : null}

      {/*
       * Stacked like the reference: asks on top with the best ask at the
       * bottom, the spread band highlighted in the middle, bids below with
       * the best bid at the top — each side touches the band at its best.
       */}
      <div
        className={`flex flex-col gap-3 transition-opacity ${
          stale || syncing ? "opacity-60" : "opacity-100"
        }`}
      >
        <BookSide side="ask" rows={[...asks].reverse()} emptyMessage="no asks yet" />
        {/* Spread band: items-center so the taller middle column (spread + %)
         * does not push best ask / best bid to the bottom edge. */}
        <div className="grid grid-cols-3 items-center gap-2 rounded-md border border-line bg-panel-alt/70 px-3 py-2 text-center">
          <div className="flex flex-col gap-0.5">
            <span className="font-ui text-[10px] font-medium uppercase tracking-[0.16em] text-faint">Best ask</span>
            <span className="font-mono text-[15px] font-semibold text-ask tabular-nums">
              {ask === null ? "—" : formatPrice(ask.price)}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="font-ui text-[10px] font-medium uppercase tracking-[0.16em] text-faint">Spread</span>
            <span className="font-mono text-[15px] font-semibold text-ink tabular-nums">
              {spreadValue === null ? "—" : spreadValue.toFixed(2)}
            </span>
            <span className="font-mono text-[10px] font-medium text-faint tabular-nums">
              {spreadPercent === null ? "" : `${spreadPercent.toFixed(3)}%`}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="font-ui text-[10px] font-medium uppercase tracking-[0.16em] text-faint">Best bid</span>
            <span className="font-mono text-[15px] font-semibold text-bid tabular-nums">
              {bid === null ? "—" : formatPrice(bid.price)}
            </span>
          </div>
        </div>
        <BookSide side="bid" rows={bids} emptyMessage="no bids yet" />
      </div>
    </Panel>
  );
}

import { Panel } from "@/components/Panel";
import { formatAge, formatClock, formatMs } from "@/lib/format";
import type { ConnectionStatus } from "@/stores/book";

type ConnectionStatusPanelProps = {
  status: ConnectionStatus;
  /** The URL the market socket dialed: book + trades (query string included). */
  marketUrl: string;
  /** The URL the chart socket dialed: candles for the interval on screen. */
  chartUrl: string;
  /** Local epoch millis of the last accepted market frame — not of a ping. */
  lastFrameAt: number | null;
  /** The screen's clock; ages are computed from it, never read during render. */
  now: number;
  /** A snapshot refetch is in flight: the book on screen is frozen. */
  syncing: boolean;
  bookSeq: number | null;
  latencyMs: number | null;
  /** Gaps healed by refetching a snapshot. */
  gaps: number;
  /** Frames the protocol guard rejected. */
  malformed: number;
  /** `/api/config` failure, if any (retried in the background). */
  configError: string | null;
};

const STATUS_TONE: Record<ConnectionStatus, { dot: string; text: string; label: string }> = {
  live: { dot: "bg-live", text: "text-live", label: "live" },
  stale: { dot: "bg-stale", text: "text-stale", label: "stale" },
  down: { dot: "bg-ask", text: "text-ask", label: "down" },
  connecting: { dot: "bg-muted", text: "text-muted", label: "connecting" },
};


const TONES = {
  muted: "text-muted",
  ink: "text-ink-dim",
  good: "text-bid",
  bad: "text-ask",
  warn: "text-stale",
} as const;

function Row({ label, value, tone }: { label: string; value: string; tone?: keyof typeof TONES }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[10px] uppercase tracking-[0.14em] text-faint font-medium">{label}</dt>
      <dd title={value} className={`truncate font-mono text-[11px] font-medium ${tone === undefined ? TONES.ink : TONES[tone]}`}>
        {value}
      </dd>
    </div>
  );
}

/**
 * Connection, as the socket sees it.
 *
 * The one thing this panel may never do is call cached values live: the status
 * word, the tone, and the "last frame" age all come from the connection, so a
 * dead socket reads as dead even while the book and tape still show the last
 * thing that arrived (CONTEXT.md, Live vs Stale). Latency is the client's own
 * measurement, reported to the backend every 2s; tier and jitter live in the
 * always-visible badge, not here.
 */
export function ConnectionStatusPanel({
  status,
  marketUrl,
  chartUrl,
  lastFrameAt,
  now,
  syncing,
  bookSeq,
  latencyMs,
  gaps,
  malformed,
  configError,
}: ConnectionStatusPanelProps) {
  const tone = STATUS_TONE[status];
  const lastFrame =
    lastFrameAt === null
      ? "never"
      : `${formatClock(lastFrameAt)} local (${formatAge(lastFrameAt, now)})`;

  return (
    <Panel
      title="Connection"
      hint="book + trades + chart"
      actions={
        <span className={`flex items-center gap-2 font-mono text-[11px] font-medium ${tone.text}`}>
          <span
            className={`inline-block h-2 w-2 rounded-full ${tone.dot} ${
              status === "live" ? "animate-pulse" : ""
            }`}
            aria-hidden
          />
          {tone.label}
        </span>
      }
    >
      <dl className="flex flex-col gap-2">
        <Row label="book endpoint" value={marketUrl} />
        <Row label="chart endpoint" value={chartUrl} />
        <Row label="last frame" value={lastFrame} tone={status === "live" ? "ink" : "warn"} />
        <Row
          label="book"
          value={
            bookSeq === null
              ? syncing
                ? "fetching /api/snapshot…"
                : "no snapshot yet"
              : syncing
                ? `seq ${bookSeq} · refetching`
                : `seq ${bookSeq}`
          }
          tone={syncing ? "warn" : "ink"}
        />
        <Row label="latency" value={formatMs(latencyMs)} />
        <Row
          label="recovery"
          value={`${gaps} refetched · ${malformed} dropped`}
          tone={malformed === 0 ? "ink" : "warn"}
        />
      </dl>
      {configError === null ? null : (
        <p className="mt-3 border-t border-line pt-3 font-mono text-[11px] text-stale">
          /api/config: {configError}
        </p>
      )}
    </Panel>
  );
}

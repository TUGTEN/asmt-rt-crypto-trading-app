import type { ReactNode } from "react";

type PanelProps = {
  title: string;
  /** Small monospace note in the panel header, e.g. a seq or a source. */
  hint?: string;
  /** Interactive slot on the right of the header (toggles, controls). */
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
};

export function Panel({
  title,
  hint,
  actions,
  className = "",
  bodyClassName = "",
  children,
}: PanelProps) {
  return (
    <section
      className={`flex min-w-0 flex-col rounded-lg border border-line bg-panel shadow-sm ${className}`}
    >
      <header className="flex min-h-11 items-center justify-between gap-3 border-b border-line px-4 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
          {title}
        </h2>
        <div className="flex items-center gap-3">
          {hint ? <span className="font-mono text-[11px] text-faint font-medium">{hint}</span> : null}
          {actions}
        </div>
      </header>
      <div className={`min-w-0 flex-1 px-4 py-3 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

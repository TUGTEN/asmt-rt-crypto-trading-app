"use client";

import type { PaintMode } from "@/lib/paint-throttle";

/**
 * The navbar: brand over a /ws + debug-hint sub-line, the paint-rate toggle,
 * plus the debug toggle.
 * Hierarchy is brand-first (bold text-base) with the sub-line as secondary
 * chrome (text-xs); the bar is tall (py-4) with the same sticky/rounded
 * shell. Visibility state lives in the shell (`components/SiteShell.tsx`) so
 * the same toggle drives both this button and the debug stack in the right
 * rail. The backtick key hits the same callback through the shell's hook.
 */

export function Navbar({
  debugVisible,
  onToggleDebug,
  paintMode,
  onTogglePaint,
  themeMode,
  onToggleTheme,
}: {
  /** The debug stack is open: the button reads pressed. */
  debugVisible: boolean;
  /** Flip the shell's debug visibility (persisted, `?debug`-aware). */
  onToggleDebug: () => void;
  /** Smooth paints one batch per 500ms window (SMOOTH_WINDOW_MS); full paints every frame. */
  paintMode: PaintMode;
  /** Flip the paint mode (persisted, no redial). */
  onTogglePaint: () => void;
  /** The color theme: the button matching it reads pressed. */
  themeMode: "light" | "dark";
  /** Flip the color theme (persisted, dataset-switched). */
  onToggleTheme: () => void;
}) {
  return (
    <header className="sticky top-0 z-20">
      <div className="mx-auto w-full max-w-[1440px] px-4 lg:px-8">
        <div className="flex w-full flex-wrap items-center justify-between gap-2 rounded-b-xl border border-t-0 border-line bg-panel px-4 py-4">
          <h1 className="font-ui text-base font-bold tracking-[0.18em] text-ink uppercase">Pitchfork</h1>
          <div className="flex items-center gap-2">
            <div
              role="group"
              aria-label="Paint rate"
              title="full paints every frame; smooth paints one batch per 500ms"
              className="flex items-center rounded border border-line/70 bg-panel-alt/50 p-0.5"
            >
              {(["full", "smooth"] as const).map((mode) => {
                const selected = mode === paintMode;
                return (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      if (mode !== paintMode) {
                        onTogglePaint();
                      }
                    }}
                    className={`rounded px-2 py-1 font-mono text-[11px] font-medium transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-line ${
                      selected ? "bg-line text-ink" : "text-faint hover:text-muted"
                    }`}
                  >
                    {mode}
                  </button>
                );
              })}
            </div>
            <div
              role="group"
              aria-label="Color theme"
              title="light and dark terminal themes"
              className="flex items-center rounded border border-line/70 bg-panel-alt/50 p-0.5"
            >
              {(["light", "dark"] as const).map((mode) => {
                const selected = mode === themeMode;
                return (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      if (mode !== themeMode) {
                        onToggleTheme();
                      }
                    }}
                    className={`rounded px-2 py-1 font-mono text-[11px] font-medium transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-line ${
                      selected ? "bg-line text-ink" : "text-faint hover:text-muted"
                    }`}
                  >
                    {mode}
                  </button>
                );
              })}
            </div>
            <p className="font-ui text-xs font-medium text-faint">/ws · press ` for debug</p>
            <button
              type="button"
              onClick={onToggleDebug}
              title="Toggle debug controls (` key or ?debug=1)"
              aria-expanded={debugVisible}
              className="rounded border border-line/70 px-2 py-1 font-mono text-xs font-medium text-faint transition-colors hover:text-muted"
            >
              `
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}

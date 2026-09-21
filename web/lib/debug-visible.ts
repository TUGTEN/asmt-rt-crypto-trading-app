/**
 * Debug visibility (ADR-0003): the pure half of the `?debug`/backtick gate.
 *
 * The badge, stats, and stale ribbons stay always visible (exchange rubric);
 * only the DEBUG force panel and the backend switcher hide. This module owns
 * the two decisions a DOM test can pin without a browser: is `?debug=1`
 * present, and does this keypress count as a debug toggle?
 *
 * The hook in `hooks/useDebugVisible.ts` is the thin browser shell around
 * these helpers (URL read, backtick listener, localStorage persist).
 */

export const DEBUG_PARAM = "debug";

export const DEBUG_STORAGE_KEY = "rt-crypto-trading:debug-visible";

/** True when the search string carries `?debug=1` (or bare `?debug`). */
export function parseDebugParam(search: string): boolean {
  if (search.trim() === "") {
    return false;
  }
  try {
    const params = new URLSearchParams(search);
    if (!params.has(DEBUG_PARAM)) {
      return false;
    }
    const value = params.get(DEBUG_PARAM);
    return value === null || value === "" || value === "1" || value.toLowerCase() === "true";
  } catch {
    return false;
  }
}

/**
 * True when a `keydown` for the backtick should flip debug visibility:
 * the key is a backtick and the event did not start in editable content
 * (inputs, selects, textareas, contentEditable) where "`" is text.
 */
export function isDebugToggleKey(event: { key: string; target: unknown }): boolean {
  if (event.key !== "`") {
    return false;
  }
  const target = event.target as
    | { tagName?: unknown; isContentEditable?: unknown; closest?: unknown }
    | null
    | undefined;
  if (target === null || target === undefined || typeof target !== "object") {
    return true;
  }
  if (target.isContentEditable === true) {
    return false;
  }
  const tag = typeof target.tagName === "string" ? target.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
    return false;
  }
  return true;
}

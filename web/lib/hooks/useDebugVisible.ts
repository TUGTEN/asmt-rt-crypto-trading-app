"use client";

/**
 * The browser shell around `lib/debug-visible.ts` (ADR-0003).
 *
 * Closed on first paint so the server HTML agrees; `?debug=1` (when
 * present) else the persisted choice in `localStorage` lands after mount.
 * The backtick key flips it everywhere except editable content, and every
 * change persists for the next visit. The URL is left
 * alone after first paint so a toggle never navigates.
 */

import { useCallback, useEffect, useState } from "react";

import {
  DEBUG_STORAGE_KEY,
  isDebugToggleKey,
  parseDebugParam,
} from "@/lib/debug-visible";

function readStoredVisible(): boolean {
  if (parseDebugParam(window.location.search)) {
    return true;
  }
  try {
    return window.localStorage.getItem(DEBUG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function useDebugVisible(): { visible: boolean; toggle: () => void } {
  // Closed on the server and the first paint so hydration agrees; the
  // stored choice (or ?debug) lands in the effect below.
  const [visible, setVisible] = useState<boolean>(false);

  useEffect(() => {
    // Hydration boundary: stored/?debug state lands after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisible(readStoredVisible());
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(DEBUG_STORAGE_KEY, visible ? "1" : "0");
    } catch {
      // Persistence is a convenience; visibility must work without it.
    }
  }, [visible]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isDebugToggleKey(event)) {
        event.preventDefault();
        setVisible((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const toggle = useCallback(() => setVisible((current) => !current), []);

  return { visible, toggle };
}

"use client";

/**
 * The browser shell around the paint-throttle mode (`lib/paint-throttle.ts`).
 *
 * Full-rate on first paint so the server HTML agrees; the persisted choice
 * lands after mount. Every flip writes the live mode `WsClient` reads per
 * message and persists for the next visit — no redial, no rebuild.
 */

import { useCallback, useEffect, useState } from "react";

import {
  readStoredPaintMode,
  resolvePaintMode,
  setPaintMode,
  writeStoredPaintMode,
  type PaintMode,
} from "@/lib/paint-throttle";

export function usePaintThrottle(): { mode: PaintMode; toggle: () => void } {
  // Full-rate on the server and the first paint so hydration agrees; the
  // stored choice lands in the effect below.
  const [mode, setMode] = useState<PaintMode>("full");

  useEffect(() => {
    // Hydration boundary: the stored choice lands after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode(resolvePaintMode(readStoredPaintMode(window.localStorage)));
  }, []);

  useEffect(() => {
    // The mode WsClient dispatches under, kept in lockstep with the toggle.
    setPaintMode(mode);
    try {
      writeStoredPaintMode(window.localStorage, mode);
    } catch {
      // Persistence is a convenience; throttling must work without it.
    }
  }, [mode]);

  const toggle = useCallback(() => {
    setMode((current) => (current === "smooth" ? "full" : "smooth"));
  }, []);

  return { mode, toggle };
}


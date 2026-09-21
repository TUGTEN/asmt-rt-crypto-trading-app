"use client";

/**
 * The chooser's backend URL, as component state.
 *
 * Opens on the stored choice (`localStorage`, written by the last visit) or on
 * the build-time default when nothing usable is stored — `resolveBackendUrl`
 * is what keeps a hand-edited or stale value from bricking the screen. Setting
 * a URL validates it first (`normalizeBackendUrl` throws a `ProtocolError` the
 * chooser renders) and persists it, so a reload dials the same host; resetting
 * forgets the choice and returns to the default. `window` is only touched
 * inside effects and callbacks, so the server HTML always opens on the
 * build default and the stored host lands after mount (one redial).
 */

import { useCallback, useEffect, useState } from "react";

import type { BackendUrlStorage } from "@/lib/backend-url";
import {
  clearStoredBackendUrl,
  normalizeBackendUrl,
  readStoredBackendUrl,
  resolveBackendUrl,
  writeStoredBackendUrl,
} from "@/lib/backend-url";
import { API_BASE_URL } from "@/lib/config";

function safeStorage(): BackendUrlStorage | null {
  // Reading `window.localStorage` itself can throw where storage is blocked,
  // so every touch goes through here instead of a bare property read.
  try {
    if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
      return null;
    }
    return window.localStorage;
  } catch {
    return null;
  }
}

function readInitialBackendUrl(): string {
  const storage = safeStorage();
  if (storage === null) {
    return API_BASE_URL;
  }
  return resolveBackendUrl(readStoredBackendUrl(storage));
}

export type BackendUrlSelection = {
  /** The host every REST read and both sockets dial right now. */
  backendUrl: string;
  /** The build-time default the screen opens on with nothing stored. */
  defaultUrl: string;
  /**
   * Point the app at `raw`: validates, redials, persists. Throws the
   * `ProtocolError` `normalizeBackendUrl` names when the input is not an
   * `http(s)` URL — the chooser catches it and says so next to the input.
   */
  setBackendUrl: (raw: string) => void;
  /** Forget the choice: back to the build-time default, redialed. */
  resetBackendUrl: () => void;
};

export function useBackendUrl(): BackendUrlSelection {
  // Open on the build default so the server HTML and the first client paint
  // agree; the stored host (if any) lands in an effect below. The socket
  // layer redials on the change, so a stored host costs one redial, never
  // a hydration mismatch.
  const [backendUrl, setBackendUrlState] = useState(API_BASE_URL);

  useEffect(() => {
    const next = readInitialBackendUrl();
    // Hydration boundary: stored host lands after mount (one redial).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBackendUrlState((current) => (current === next ? current : next));
  }, []);

  const setBackendUrl = useCallback((raw: string) => {
    const next = normalizeBackendUrl(raw);
    setBackendUrlState(next);
    const storage = safeStorage();
    if (storage !== null) {
      writeStoredBackendUrl(storage, next);
    }
  }, []);

  const resetBackendUrl = useCallback(() => {
    setBackendUrlState(API_BASE_URL);
    const storage = safeStorage();
    if (storage !== null) {
      clearStoredBackendUrl(storage);
    }
  }, []);


  return { backendUrl, defaultUrl: API_BASE_URL, setBackendUrl, resetBackendUrl };
}

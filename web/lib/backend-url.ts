/**
 * The backend URL the browser talks to, as runtime state.
 *
 * `NEXT_PUBLIC_API_URL` is inlined at build time, so it can only ever be the
 * default a bundle opens on — not the host a user points at without a
 * rebuild. This module is the runtime half: normalise what the user typed,
 * resolve what is stored against that default, and read/write the stored value.
 * React-free on purpose, like the rest of the pure layer: the hook in
 * `lib/hooks/useBackendUrl.ts` owns the state and the `localStorage` handle,
 * the chooser in `components/BackendPanel.tsx` owns the input, and everything
 * here is pinned in `lib/backend-url.test.ts`.
 */

import { API_BASE_URL } from "@/lib/config";
import { ProtocolError } from "@/lib/protocol";

/** Where the user's choice lives between visits. */
export const BACKEND_URL_STORAGE_KEY = "rt-crypto-trading:backend-url";

/** The smallest `Storage` surface this module needs — `localStorage` qualifies. */
export type BackendUrlStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/**
 * Normalise a backend base URL the user typed or that came out of storage.
 *
 * Trims whitespace, drops trailing slashes (they would produce `//api/...`
 * downstream), and insists on an `http(s)` URL — the socket half derives
 * `ws(s)` from that scheme (`buildWsUrl`), so anything else fails here with a
 * named field rather than as a dead socket later. A path prefix survives: a
 * tunnel served under one keeps working for both REST and `/ws`.
 */
export function normalizeBackendUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ProtocolError("backend URL is empty");
  }
  const withoutSlashes = trimmed.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(withoutSlashes);
  } catch {
    throw new ProtocolError(`backend URL ${JSON.stringify(trimmed)} is not a URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ProtocolError(`backend URL scheme ${parsed.protocol} is not http(s)`);
  }
  return withoutSlashes;
}

/**
 * What the app dials: the stored choice when it is a usable URL, otherwise the
 * build-time default. A stored value from an older stricter parse (or a hand
 * edit in devtools) falls back instead of bricking the screen.
 */
export function resolveBackendUrl(stored: unknown): string {
  if (typeof stored !== "string" || stored.trim().length === 0) {
    return API_BASE_URL;
  }
  try {
    return normalizeBackendUrl(stored);
  } catch {
    return API_BASE_URL;
  }
}

/** Preset suggestions for the chooser: the build default plus local dev. */
export function presetBackendUrls(): string[] {
  const presets = [API_BASE_URL, "http://localhost:8080"];
  return [...new Set(presets)];
}

/**
 * Read the stored choice. `null` means "no choice yet" (or storage refused to
 * answer, e.g. private mode) — the caller dials the default either way.
 */
export function readStoredBackendUrl(storage: BackendUrlStorage): string | null {
  try {
    return storage.getItem(BACKEND_URL_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Persist the (already normalised) choice. A refusal (quota, private mode)
 * leaves the session on the new URL without remembering it — worth less than
 * breaking the switch over.
 */
export function writeStoredBackendUrl(storage: BackendUrlStorage, url: string): void {
  try {
    storage.setItem(BACKEND_URL_STORAGE_KEY, url);
  } catch {
    // Session-only: the sockets still redial, this browser just forgets.
  }
}

/** Forget the choice: the next load opens on the build-time default again. */
export function clearStoredBackendUrl(storage: BackendUrlStorage): void {
  try {
    storage.removeItem(BACKEND_URL_STORAGE_KEY);
  } catch {
    // Nothing to forget through.
  }
}

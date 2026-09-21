"use client";

/**
 * The backend chooser (HANDOFF item 4): point the app at another backend
 * without a rebuild.
 *
 * `NEXT_PUBLIC_API_URL` is inlined at build time, so it can only be the host a
 * fresh bundle opens on. This panel is the runtime half: a dropdown of presets
 * (the build default, local dev) plus a free-form input for anything else — a
 * NixOS tunnel, a fly.io/render deploy — so a host that did not exist when the
 * bundle was built is one paste away. Applying validates (`normalizeBackendUrl`
 * names the problem next to the input instead of failing as a dead socket),
 * redials both sessions (the URLs carry the host), refetches config and history
 * from it, and remembers the choice in `localStorage` for the next visit.
 *
 * Presentational like the other panels: values and two callbacks in, JSX out.
 * Validation wording comes from the pure layer, and no `fetch` happens here.
 */

import { useMemo, useRef, useState } from "react";

import { Panel } from "@/components/Panel";
import { normalizeBackendUrl, presetBackendUrls } from "@/lib/backend-url";
import { ProtocolError } from "@/lib/protocol";

type BackendPanelProps = {
  /** The host every REST read and both sockets dial right now. */
  backendUrl: string;
  /** The build-time default a fresh browser opens on. */
  defaultUrl: string;
  /** Point the app at a validated URL: redials, refetches, persists. */
  onSelect: (url: string) => void;
  /** Forget the choice and return to the build-time default. */
  onReset: () => void;
};

const CUSTOM = "custom";

function presetLabel(url: string, defaultUrl: string): string {
  if (url === defaultUrl) {
    return `Default (${url})`;
  }
  if (url === "http://localhost:8080") {
    return `Local dev (${url})`;
  }
  return url;
}

export function BackendPanel({ backendUrl, defaultUrl, onSelect, onReset }: BackendPanelProps) {
  const presets = useMemo(() => presetBackendUrls(), []);
  const [draft, setDraft] = useState(backendUrl);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // A switch that lands from elsewhere (today only reset) re-seeds the input
  // during render, so it never offers a stale host after the switch.
  const [prevUrl, setPrevUrl] = useState(backendUrl);
  if (prevUrl !== backendUrl) {
    setPrevUrl(backendUrl);
    setDraft(backendUrl);
    setError(null);
  }

  const selectedPreset = presets.includes(backendUrl) ? backendUrl : CUSTOM;

  const applyDraft = (): void => {
    try {
      onSelect(normalizeBackendUrl(draft));
      setError(null);
    } catch (unknown) {
      setError(unknown instanceof ProtocolError ? unknown.message : "backend URL is not usable");
    }
  };

  // Disabled while there is nothing new to dial: the draft already is the
  // host, or it is not a URL worth validating on every keystroke (submit says
  // so instead).
  const nothingToApply = (() => {
    try {
      return normalizeBackendUrl(draft) === backendUrl;
    } catch {
      return true;
    }
  })();

  return (
    <Panel title="Backend" hint="rest + socket host">
      <label
        htmlFor="backend-preset"
        className="mb-1 block text-[10px] uppercase tracking-[0.14em] text-faint font-medium"
      >
        Preset
      </label>
      <select
        id="backend-preset"
        value={selectedPreset}
        onChange={(event) => {
          const next = event.target.value;
          if (next === CUSTOM) {
            inputRef.current?.focus();
            return;
          }
          setDraft(next);
          setError(null);
          onSelect(next);
        }}
        className="mb-3 w-full rounded border border-line bg-panel px-2 py-1 font-mono text-[11px] font-medium text-ink-dim"
      >
        {presets.map((preset) => (
          <option key={preset} value={preset}>
            {presetLabel(preset, defaultUrl)}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          applyDraft();
        }}
      >
        <label
          htmlFor="backend-url"
          className="mb-1 block text-[10px] uppercase tracking-[0.14em] text-faint font-medium"
        >
          Backend URL
        </label>
        <div className="flex gap-2">
          <input
            ref={inputRef}
            id="backend-url"
            list="backend-url-presets"
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            placeholder={defaultUrl}
            className="min-w-0 flex-1 rounded border border-line bg-panel px-2 py-1 font-mono text-[11px] font-medium text-ink-dim placeholder:text-faint"
          />
          <datalist id="backend-url-presets">
            {presets.map((preset) => (
              <option key={preset} value={preset} />
            ))}
          </datalist>
          <button
            type="submit"
            disabled={nothingToApply}
            className="rounded border border-line px-2 py-1 font-mono text-[11px] font-medium text-ink-dim transition-colors hover:text-ink disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-line"
          >
            Connect
          </button>
          <button
            type="button"
            disabled={backendUrl === defaultUrl}
            onClick={() => {
              setDraft(defaultUrl);
              setError(null);
              onReset();
            }}
            className="rounded border border-line/70 px-2 py-1 font-mono text-[11px] font-medium text-faint transition-colors hover:text-muted disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-line"
          >
            Reset
          </button>
        </div>
      </form>
      {error === null ? null : (
        <p role="alert" className="mt-2 font-mono text-[11px] font-medium text-stale">
          {error}
        </p>
      )}
      <p className="mt-3 break-all border-t border-line pt-3 font-mono text-[11px] font-medium text-muted">
        dialing: <span className="text-ink-dim">{backendUrl}</span>{" "}
        <span className="text-faint">
          {backendUrl === defaultUrl ? "(build default)" : "(saved in this browser)"}
        </span>
      </p>
    </Panel>
  );
}

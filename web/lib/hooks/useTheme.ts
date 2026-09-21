"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";

/** Layout on the client, plain effect on the server (no DOM there). */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
/**
 * The browser shell around the color theme.
 *
 * Dark on first paint so the server HTML agrees; the persisted choice
 * lands after mount. Every flip writes `document.documentElement.dataset.theme`
 * (plus the `theme-color` meta) and persists for the next visit.
 *
 * Why `dataset.theme`: Tailwind v4 token utilities resolve `var(--color-*)`,
 * so overriding the vars under `[data-theme="dark"]` switches the whole UI
 * with no `dark:` variants needed.
 */

/** The color theme: the light terminal or the dark terminal. */
export type ThemeMode = "light" | "dark";

/** Where the user's choice lives between visits. */
export const THEME_STORAGE_KEY = "rt-crypto-trading:theme";

/** The `theme-color` meta values matching the canvas of each theme. */
export const THEME_COLOR: Record<ThemeMode, string> = {
  light: "#e8ecf4",
  dark: "#070b16",
};

/**
 * What the app paints: the stored choice when it names a theme, otherwise the
 * dark default. A hand edit in devtools falls back instead of bricking the
 * screen.
 */
export function resolveThemeMode(stored: unknown): ThemeMode {
  return stored === "light" ? "light" : "dark";
}

/** Read the stored choice. `null` means "no choice yet" — paint dark. */
function readStoredThemeMode(): string | null {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function useTheme(): { mode: ThemeMode; toggle: () => void } {
  // Dark on the server and the first paint so hydration agrees; the
  // stored choice lands in the effect below.
  const [mode, setMode] = useState<ThemeMode>("dark");
  useEffect(() => {
    // Hydration boundary: the stored choice lands after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode(resolveThemeMode(readStoredThemeMode()));
  }, []);

  // Layout, deliberately: the chart's creation effect is passive, and passive
  // effects run child-first — a parent *passive* flip would land after the child
  // already re-resolved the old tokens (inverted canvas every toggle). Parent
  // layout effects run before child passives, so the dataset is always the
  // incoming theme by the time the chart resolves it.
  useIsomorphicLayoutEffect(() => {
    // The dataset switch the `[data-theme="dark"]` token overrides read,
    // kept in lockstep with the toggle.
    document.documentElement.dataset.theme = mode;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", THEME_COLOR[mode]);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // Persistence is a convenience; theming must work without it.
    }
  }, [mode]);

  const toggle = useCallback(() => {
    setMode((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  return { mode, toggle };
}

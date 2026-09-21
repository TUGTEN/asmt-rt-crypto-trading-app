"use client";

import { Navbar } from "@/components/Navbar";
import { TradingScreen } from "@/components/TradingScreen";
import { useDebugVisible } from "@/lib/hooks/useDebugVisible";
import { usePaintThrottle } from "@/lib/hooks/usePaintThrottle";
import { useTheme } from "@/lib/hooks/useTheme";

/**
 * The client shell: navbar plus data screen, sharing one debug visibility and
 * one paint mode.
 * The hook lives here (not in the screen) because the toggle moved into the
 * navbar while the stack it opens still lives in the screen's right rail.
 */

export function SiteShell() {
  const { visible: debugVisible, toggle: toggleDebug } = useDebugVisible();
  const { mode: paintMode, toggle: togglePaint } = usePaintThrottle();
  const { mode: themeMode, toggle: toggleTheme } = useTheme();

  return (
    <>
      <Navbar
        debugVisible={debugVisible}
        onToggleDebug={toggleDebug}
        paintMode={paintMode}
        onTogglePaint={togglePaint}
        themeMode={themeMode}
        onToggleTheme={toggleTheme}
      />
      <TradingScreen debugVisible={debugVisible} theme={themeMode} />
    </>
  );
}

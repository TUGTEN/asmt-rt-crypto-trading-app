"use client";

/**
 * A coarse clock for relative ages ("last frame 3s ago").
 *
 * It renders nothing by itself: the age is computed from a timestamp the store
 * holds, and this only decides how often that label is recomputed. The poll loop
 * used to be the screen's clock; with a socket, nothing ticks on its own, and an
 * age frozen at "just now" while the feed is dead is exactly the dishonest
 * display this ticket exists to remove.
 */

import { useEffect, useState } from "react";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}

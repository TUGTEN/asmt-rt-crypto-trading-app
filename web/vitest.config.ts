import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Unit tests cover the pure layer only: decimal/format helpers, the runtime
 * wire-shape guards, and the Zustand stores the panels select from. All of them
 * are plain modules with no DOM, no React, and no network, so the node
 * environment and the `@/*` alias (mirroring tsconfig) are all the
 * configuration this needs.
 *
 * Anything above that layer — polling, rendering — is covered by running the
 * app against the seeded backend; see the T1 slice in docs/SEAMS.md.
 */
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname) },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "stores/**/*.test.ts", "components/**/*.test.tsx"],
  },
});

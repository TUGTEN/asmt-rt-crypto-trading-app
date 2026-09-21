import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Standalone output is for the container image (web/Dockerfile), and the
   * image build is the only thing that turns it on.
   *
   * Standalone exists so a self-hosted Node process can run without the full
   * node_modules tree — exactly the Docker case. A Vercel build serves the
   * same source from its own runtime and does not need it, and on this Next
   * line asking for standalone *broke* Vercel builds (vercel/next.js#96646:
   * the build ends in onBuildComplete looking for a trace file that is not
   * emitted when a deployment adapter is configured). So `npm run build` and
   * Vercel keep the default output, and only `BUILD_STANDALONE=1` — set by
   * web/Dockerfile — produces `.next/standalone`.
   */
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
};

export default nextConfig;

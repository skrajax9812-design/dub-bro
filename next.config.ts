import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static"],
  /**
   * The dev server is reached through a proxied preview origin
   * (<port>-<sandbox>.e2b.app). Next.js blocks cross-origin dev resources
   * (HMR + /_next/static chunks) by default, which silently kills hydration.
   */
  allowedDevOrigins: ["*.e2b.app", "*.arena.ai", "*.host-ai.app", "localhost", "127.0.0.1"],
};

export default nextConfig;

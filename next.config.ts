import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { validateFeatureDependencies, validateEnv, validateCountry } from "./config/validate";
import { siteConfig } from "./config/site.config";
import { resolveFeatures } from "./config/flag-variants";

// Throws -> the build fails. That is the point.
validateFeatureDependencies(resolveFeatures(siteConfig.features));
validateEnv(process.env, { phase: "build" });
validateCountry(siteConfig);

const nextConfig: NextConfig = {
  output: "standalone",
  // Redis-backed ISR. The handler guards against connecting during the build;
  // see docs/spikes/2026-09-07-phase-0-isr-cache-handler.md.
  cacheHandler: fileURLToPath(new URL("./cache-handler.mjs", import.meta.url)),
  cacheMaxMemorySize: 0,
};

export default nextConfig;

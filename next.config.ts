import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import {
  validateFeatureDependencies,
  validateEnv,
  validateCountry,
  validateProductionConfig,
} from "./config/validate";
import { siteConfig } from "./config/site.config";
import { resolveFeatures } from "./config/flag-variants";

// Throws -> the build fails. That is the point.
validateFeatureDependencies(resolveFeatures(siteConfig.features));
validateEnv(process.env, { phase: "build" });
validateCountry(siteConfig);
validateProductionConfig(
  { ...siteConfig, dataController: siteConfig.legal.dataController },
  process.env,
);

const NOINDEX_HEADER = "noindex, nofollow, noarchive, nosnippet, noimageindex";

const nextConfig: NextConfig = {
  output: "standalone",

  /**
   * Staging must never be indexed.
   *
   * Set here rather than in middleware: middleware runs in the Edge runtime,
   * which in standalone mode cannot resolve node:crypto and 500s every request.
   * headers() runs in Node and applies to every route, including assets.
   *
   * robots.txt alone is NOT enough — Google indexes URLs it is forbidden to
   * crawl, using anchor text alone, and those listings are slow to remove. The
   * header is the directive that actually prevents indexing; robots.txt just
   * discourages the crawl.
   *
   * SITE_ENV is a BUILD-TIME switch. Next evaluates headers() during
   * `next build` and writes the result into `.next/routes-manifest.json`; the
   * standalone server reads that file and never calls this function again. So
   * setting SITE_ENV at boot cannot add or remove this header — flipping
   * staging -> production means rebuilding the image with
   * `--build-arg SITE_ENV=production`. `app/robots.ts` is force-dynamic and
   * DOES follow a boot value, which is why changing only the runtime variable
   * produces the worst state of all: robots.txt says "Allow: /" while every
   * response still says noindex.
   *
   * Matches `siteEnv()` in lib/site-env.ts: production is opted into, and
   * anything else — unset included — gets the header.
   */
  async headers() {
    if (process.env.SITE_ENV === "production") return [];
    return [{ source: "/:path*", headers: [{ key: "X-Robots-Tag", value: NOINDEX_HEADER }] }];
  },

  // Redis-backed ISR. The handler guards against connecting during the build;
  // see docs/spikes/2026-09-07-phase-0-isr-cache-handler.md.
  cacheHandler: fileURLToPath(new URL("./cache-handler.mjs", import.meta.url)),
  cacheMaxMemorySize: 0,
};

export default nextConfig;

import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import {
  validateFeatureDependencies,
  validateEnv,
  validateCountry,
  validateProductionConfig,
  validateStatsRetention,
} from "./config/validate";
import { siteConfig } from "./config/site.config";
import { resolveFeatures } from "./config/flag-variants";
import { RESERVED_SLUGS } from "./lib/routing/slugify";

// Throws -> the build fails. That is the point.
validateFeatureDependencies(resolveFeatures(siteConfig.features));
validateEnv(process.env, { phase: "build" });
validateCountry(siteConfig);
validateStatsRetention(siteConfig);
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

  /**
   * Task 53 — the verified-only filter on a pillar page.
   *
   * `app/[...segments]/page.tsx` (the city/city-category/vertical/vertical-area
   * catch-all) deliberately never reads searchParams — see its own comment —
   * because doing so would opt the WHOLE route out of the ISR cache this
   * 5,000-page site depends on, not just requests that carry a query string.
   * `?verified=1` still needs real, server-filtered results and its own
   * noindex + canonical, which needs SOME per-request read of the query.
   *
   * The resolution: a second, sibling route, `app/verified/[...segments]`,
   * that reuses the exact same rendering code (imported directly, not
   * duplicated) with `verified` forced true, and is never in the ISR cache —
   * exactly like /search, which already made this trade-off for its own
   * filters. This rewrite sends `?verified=1` requests there transparently;
   * the browser's URL bar never changes.
   *
   * NOT middleware: middleware runs in the Edge runtime, which 500s in this
   * standalone build (see the `headers()` comment above) — `rewrites()` runs
   * in Node at request-routing time, same as `headers()`.
   *
   * Scoped with the exact RESERVED_SLUGS list the slug allocator already
   * uses to keep a city or vertical from colliding with a static route: a
   * request's first path segment is only eligible when it is NOT one of
   * those, so /search?verified=1, /admin/...?verified=1 and so on can never
   * be misrouted here — they are real routes and (via `afterFiles`, below)
   * are matched before this rewrite ever runs. `verified` itself is reserved
   * too, so a city can never be named `/verified`.
   */
  async rewrites() {
    return {
      afterFiles: [
        {
          source: `/:segments((?!(?:${RESERVED_SLUGS.join("|")})(?:/|$)).*)`,
          has: [{ type: "query", key: "verified", value: "1" }],
          destination: "/verified/:segments",
        },
      ],
    };
  },
};

export default nextConfig;

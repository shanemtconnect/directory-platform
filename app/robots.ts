import type { MetadataRoute } from "next";
import { isStaging, siteOrigin } from "@/lib/site-env";

/**
 * Dynamic, deliberately.
 *
 * A force-static route with no `revalidate` is cached FOREVER — and while the
 * ISR cache is now namespaced per build, so a deploy starts cold, "forever"
 * still outlives every restart of the same build, and a container restarted
 * with a corrected SITE_ENV would go on serving "Disallow: /" from Redis until
 * someone flushed it by hand. Anything whose output depends on an environment
 * variable must not be force-static. This response is a few hundred bytes;
 * rendering it per request costs nothing.
 *
 * Note that this is the ONLY half of the staging switch a boot value can move.
 * The `X-Robots-Tag: noindex` header comes from `next.config.ts` `headers()`,
 * which `next build` freezes into `routes-manifest.json` — see lib/site-env.ts.
 * Flipping staging -> production for real is a rebuild.
 */
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const base = siteOrigin();

  if (isStaging()) {
    // Belt to the X-Robots-Tag header's braces. No sitemap is advertised.
    return { rules: [{ userAgent: "*", disallow: "/" }] };
  }

  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/admin", "/account", "/api"] }],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}

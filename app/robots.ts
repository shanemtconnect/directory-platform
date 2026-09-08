import type { MetadataRoute } from "next";
import { siteConfig } from "@/config/site.config";
import { isStaging } from "@/lib/site-env";

/**
 * Dynamic, deliberately.
 *
 * The Redis ISR cache survives deploys — that is the entire point of it. But a
 * force-static route with no `revalidate` is cached FOREVER, so flipping
 * SITE_ENV from staging to production would keep serving "Disallow: /" until
 * someone flushed Redis by hand. Anything whose output depends on an env var
 * must not be force-static. This response is a few hundred bytes; rendering it
 * per request costs nothing.
 */
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? `https://${siteConfig.domain}`;

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

import { siteConfig } from "@/config/site.config";

export type SiteEnv = "production" | "staging";

/**
 * The site's absolute origin, with no trailing slash.
 *
 * ONE definition, because three things have to agree on it or the site
 * contradicts itself: `metadataBase` (which every canonical and og:url is
 * resolved against), the JSON-LD `@id`s, and the sitemap's `<loc>`s. Read at
 * call time rather than frozen into a module constant so tests and a
 * per-environment deploy can both set it.
 */
export function siteOrigin(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? `https://${siteConfig.domain}`).replace(/\/+$/, "");
}

/**
 * Staging sites must never be indexed.
 *
 * Note that robots.txt alone does NOT prevent indexing — Google can and does
 * index a URL it is forbidden to crawl, using only anchor text and external
 * links, and the resulting listing is impossible to clean up quickly. The
 * `X-Robots-Tag` response header is the directive that actually works, because
 * it is read from a page Google has fetched. We send both: the header to
 * prevent indexing, robots.txt to discourage the crawl in the first place.
 *
 * Indexing is OPTED INTO. Only the literal `"production"` is production;
 * everything else — `"staging"`, a typo, an empty string, an unset variable —
 * is staging. The two failure modes are not symmetrical: a production site that
 * forgot the variable serves `noindex` until someone notices and rebuilds,
 * which costs a day, while a staging site that forgot it gets its whole
 * duplicate copy of the directory indexed, which costs months to undo and
 * competes with the real site while it lasts.
 *
 * BUILD-TIME, not runtime. This function is read per request, but the
 * `X-Robots-Tag` header that does the actual work comes from `next.config.ts`
 * `headers()`, which Next evaluates during `next build` and freezes into
 * `.next/routes-manifest.json`. Flipping staging -> production is a REBUILD;
 * changing the environment variable alone leaves every response carrying
 * `noindex` while robots.txt claims otherwise. See lib/site-env.test.ts.
 */
export function siteEnv(): SiteEnv {
  return process.env.SITE_ENV === "production" ? "production" : "staging";
}

export const isStaging = (): boolean => siteEnv() === "staging";

export const NOINDEX_HEADER = "noindex, nofollow, noarchive, nosnippet, noimageindex";

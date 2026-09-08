export type SiteEnv = "production" | "staging";

/**
 * Staging sites must never be indexed.
 *
 * Note that robots.txt alone does NOT prevent indexing — Google can and does
 * index a URL it is forbidden to crawl, using only anchor text and external
 * links, and the resulting listing is impossible to clean up quickly. The
 * `X-Robots-Tag` response header is the directive that actually works, because
 * it is read from a page Google has fetched. We send both: the header to
 * prevent indexing, robots.txt to discourage the crawl in the first place.
 */
export function siteEnv(): SiteEnv {
  return process.env.SITE_ENV === "staging" ? "staging" : "production";
}

export const isStaging = (): boolean => siteEnv() === "staging";

export const NOINDEX_HEADER = "noindex, nofollow, noarchive, nosnippet, noimageindex";

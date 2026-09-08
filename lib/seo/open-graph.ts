import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";

type OpenGraphMetadata = NonNullable<Metadata["openGraph"]>;

/**
 * Next does not deep-merge a page's `openGraph` into the root layout's — it
 * REPLACES it wholesale. A page that sets `openGraph: { title, url }` and
 * nothing else loses `og:site_name`, `og:locale` and `og:image`, even though
 * every one of those is declared as a site-wide default in `app/layout.tsx`.
 *
 * Every page-level `openGraph` block goes through this helper instead of a
 * bare object literal, so the site-wide defaults are always restated and
 * nothing silently disappears from a page's social card.
 */
export function pageOpenGraph(overrides: OpenGraphMetadata): OpenGraphMetadata {
  return {
    siteName: siteConfig.name,
    // og:locale is underscored (en_GB), unlike the html lang attribute — same
    // rule as the root layout, kept in step because this replaces it.
    locale: siteConfig.locale.replace("-", "_"),
    type: "website",
    // The site-wide social card. A page that needs a different image (there
    // are none yet) passes its own `images` in overrides.
    images: ["/opengraph-image"],
    ...overrides,
  };
}

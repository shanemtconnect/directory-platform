import { siteConfig } from "@/config/site.config";
import type { FeatureMap, SiteMode } from "@/config/types";
import { features } from "./flags";
import { countryProfile } from "@/lib/geo/countries";

export interface NavEntry {
  readonly href: string;
  readonly label: string;
  readonly inNav: boolean;
  readonly inFooter: boolean;
  readonly inSitemap: boolean;
}

/**
 * THE single source for nav, footer, sitemap and breadcrumbs.
 *
 * Pure and parameterised so every flag combination is unit-testable without a
 * build. If a flag flips and a link survives anywhere in the UI, that link was
 * not reading from here — which is the bug, not the flag.
 */
/**
 * What the content section is CALLED. The route is always /blog; contentHub
 * only changes the wording, and the blog pages read it from here so the nav,
 * the breadcrumb, the H1 and the title can never disagree.
 */
export const contentLabel = (f: FeatureMap): string => (f.contentHub ? "Guides" : "Blog");

export function buildRoutes(f: FeatureMap, mode: SiteMode): NavEntry[] {
  const e = siteConfig.entity;

  const routes: NavEntry[] = [
    { href: "/", label: "Home", inNav: false, inFooter: false, inSitemap: true },
    { href: "/cities", label: "Locations", inNav: true, inFooter: true, inSitemap: true },
    { href: "/categories", label: e.Plural, inNav: true, inFooter: true, inSitemap: true },
    { href: "/search", label: "Search", inNav: true, inFooter: false, inSitemap: false },
    { href: "/add-listing", label: `Add your ${e.singular}`, inNav: true, inFooter: true, inSitemap: true },
    { href: "/pricing", label: "Pricing", inNav: true, inFooter: true, inSitemap: true },
    { href: "/advertise", label: "Advertise", inNav: false, inFooter: true, inSitemap: true },
    { href: "/trust", label: "Trust & safety", inNav: false, inFooter: true, inSitemap: true },
    { href: "/data-sources", label: "Where our data comes from", inNav: false, inFooter: true, inSitemap: true },
    // The legal pages. No flag turns these off — a site without them is not a
    // smaller site, it is a broken one. They are here so the sitemap and the
    // route-existence test see them; the footer renders them from
    // components/layout/legal-routes.ts, grouped with the copyright line
    // rather than mixed in with the browse links.
    { href: "/privacy", label: "Privacy", inNav: false, inFooter: false, inSitemap: true },
    { href: "/terms", label: "Terms", inNav: false, inFooter: false, inSitemap: true },
  ];

  // /areas is the REGION index on a niche-national site — the counties or
  // states the cities group into, at /areas/<region>. local-multi-vertical's
  // own /areas (its `areas` table, the neighbourhoods of one city) has no
  // page yet, so that mode still advertises nothing here, and app/areas 404s
  // there rather than serving a page nothing links to.
  if (mode === "niche-national") {
    const profile = countryProfile(siteConfig.country);
    routes.push({
      href: "/areas",
      label: `${e.Plural} by ${profile.regionLabel}`,
      inNav: false,
      inFooter: true,
      inSitemap: true,
    });
  }

  // contentHub REPLACES the flat blog rather than sitting beside it, so the two
  // can never both appear and split the same internal links. The flag changes
  // what the section is CALLED, never where it lives: /blog is the only route
  // that exists, and advertising /guides was a link to a 404.
  routes.push({
    href: "/blog",
    label: contentLabel(f),
    inNav: true,
    inFooter: true,
    inSitemap: true,
  });

  if (f.shortlist) routes.push({ href: "/shortlist", label: "Shortlist", inNav: true, inFooter: false, inSitemap: false });

  // Quote broadcast (Task 47): the page is app/get-quotes/page.tsx, added in
  // the same commit as this entry. Off means gone from every surface — the
  // page 404s, and a link to a 404 is what this file exists to prevent.
  if (f.quoteBroadcast) {
    routes.push({ href: "/get-quotes", label: "Get quotes", inNav: true, inFooter: true, inSitemap: true });
  }

  // Awards (Task 50): app/awards/page.tsx ships in the same commit as this
  // line. The index explains how awards work even before the first winner
  // exists, so it is advertised whenever the flag is on; it carries noindex
  // itself until there is something to index.
  if (f.awards) routes.push({ href: "/awards", label: "Awards", inNav: true, inFooter: true, inSitemap: true });

  // Jobs board (Task 49). Both pages exist under app/jobs and app/post-a-job;
  // the posting page is advertised from the footer and the board's own CTA,
  // not the header, which is already full.
  if (f.jobBoard) {
    routes.push({ href: "/jobs", label: "Jobs", inNav: true, inFooter: true, inSitemap: true });
    routes.push({ href: "/post-a-job", label: "Post a job", inNav: false, inFooter: true, inSitemap: true });
  }

  // costGuides, affiliates and utilityTool have no page yet. Until one
  // ships under app/, its flag advertises nothing: a nav, footer and
  // sitemap entry for /get-quotes was once a link to a 404 on every clone
  // that turned the flag on, found by scripts/verify-clone.sh.
  // navigation.test.ts holds every href here to a page on disk, so a route
  // is added back here in the same commit as its page and never before.

  return routes;
}

export const enabledRoutes = (): NavEntry[] => buildRoutes(features, siteConfig.siteMode);
export const contentSectionLabel = (): string => contentLabel(features);
export const navRoutes = (): NavEntry[] => enabledRoutes().filter((r) => r.inNav);
export const footerRoutes = (): NavEntry[] => enabledRoutes().filter((r) => r.inFooter);
export const sitemapRoutes = (): NavEntry[] => enabledRoutes().filter((r) => r.inSitemap);

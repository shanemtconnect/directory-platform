import { siteConfig } from "@/config/site.config";
import type { FeatureMap, SiteMode } from "@/config/types";
import { features } from "./flags";

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
  ];

  if (mode === "local-multi-vertical") {
    routes.push({ href: "/areas", label: "Areas", inNav: true, inFooter: true, inSitemap: true });
  }

  // contentHub REPLACES the flat blog rather than sitting beside it, so the two
  // can never both appear and split the same internal links. The flag changes
  // what the section is CALLED, never where it lives: /blog is the only route
  // that exists, and advertising /guides was a link to a 404.
  routes.push({
    href: "/blog",
    label: f.contentHub ? "Guides" : "Blog",
    inNav: true,
    inFooter: true,
    inSitemap: true,
  });

  if (f.shortlist) routes.push({ href: "/shortlist", label: "Shortlist", inNav: true, inFooter: false, inSitemap: false });
  if (f.costGuides) routes.push({ href: "/cost", label: "Costs", inNav: true, inFooter: true, inSitemap: true });
  if (f.quoteBroadcast) routes.push({ href: "/get-quotes", label: "Get quotes", inNav: true, inFooter: true, inSitemap: true });
  if (f.jobBoard) routes.push({ href: "/jobs", label: "Jobs", inNav: true, inFooter: true, inSitemap: true });
  if (f.awards) routes.push({ href: "/awards", label: "Awards", inNav: false, inFooter: true, inSitemap: true });
  if (f.affiliates) routes.push({ href: "/affiliates", label: "Affiliates", inNav: false, inFooter: true, inSitemap: true });
  if (f.utilityTool) routes.push({ href: "/tools", label: "Free tools", inNav: true, inFooter: true, inSitemap: true });

  return routes;
}

export const enabledRoutes = (): NavEntry[] => buildRoutes(features, siteConfig.siteMode);
export const navRoutes = (): NavEntry[] => enabledRoutes().filter((r) => r.inNav);
export const footerRoutes = (): NavEntry[] => enabledRoutes().filter((r) => r.inFooter);
export const sitemapRoutes = (): NavEntry[] => enabledRoutes().filter((r) => r.inSitemap);

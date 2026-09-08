import "./globals.css";
import type { ReactNode } from "react";
import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { siteOrigin } from "@/lib/site-env";
import { themeStyleVars } from "@/lib/theme";
import { fontStyleVars } from "@/lib/fonts";
import { JsonLd } from "@/components/seo/JsonLd";
import { organisationSchema, websiteSchema } from "@/lib/schema/builders";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { SiteFooter } from "@/components/layout/SiteFooter";

export const metadata: Metadata = {
  /**
   * Without this, a page's `alternates.canonical: "/pricing"` renders as
   * `href="/pricing"` — a relative canonical, which Google resolves against
   * whatever host served the page. Every staging or preview host then declares
   * itself canonical for the production URL. It is also what makes the OG image
   * and icon paths below resolve to absolute URLs.
   */
  metadataBase: new URL(siteOrigin()),
  title: { default: siteConfig.name, template: `%s | ${siteConfig.name}` },
  description: siteConfig.tagline,
  // Defaults, inherited by every page — but only by a page that does NOT set
  // its own `openGraph`. Next does not deep-merge a page's `openGraph` into
  // this one, it replaces it wholesale, so `og:site_name`/`og:locale`/
  // `og:image` below are lost the instant a page declares its own block. A
  // page that needs one builds it with lib/seo/open-graph.ts's
  // `pageOpenGraph()`, which restates these defaults so nothing is dropped.
  openGraph: {
    siteName: siteConfig.name,
    // og:locale is underscored (en_GB), unlike the html lang attribute.
    locale: siteConfig.locale.replace("-", "_"),
    type: "website",
  },
  twitter: { card: "summary_large_image" },
  // Generated from the theme, so a clone gets its own icon with no new file.
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }] },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    /*
     * The font vars go on last so the loaded families win.
     * `themeStyleVars` writes the configured NAME, which is the right answer
     * for a self-hosted family; `fontStyleVars` overwrites it with next/font's
     * generated family plus its size-adjusted fallback whenever the config
     * names one of the families lib/fonts.ts actually loads.
     */
    <html
      lang={siteConfig.locale}
      style={{ ...themeStyleVars(siteConfig.theme), ...fontStyleVars(siteConfig.theme) }}
    >
      <body>
        {/* Global identity nodes, emitted once. Page-level nodes reference these by @id. */}
        <JsonLd data={organisationSchema()} />
        <JsonLd data={websiteSchema()} />
        <a href="#main-content" className="skip-link">Skip to content</a>
        <SiteHeader />
        {/* Every route renders its own <main>; this is the skip link's target
            and what pushes the footer to the bottom of a short page. */}
        <div id="main-content" tabIndex={-1} className="flex flex-1 flex-col">
          {children}
        </div>
        <SiteFooter />
      </body>
    </html>
  );
}

import "./globals.css";
import type { ReactNode } from "react";
import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { siteOrigin } from "@/lib/site-env";
import { themeStyleVars } from "@/lib/theme";
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
  // Defaults, inherited by every page. A page that sets its own title and
  // description overrides these; the rest are the same site-wide.
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
    <html lang={siteConfig.locale} style={themeStyleVars(siteConfig.theme)}>
      <body>
        {/* Global identity nodes, emitted once. Page-level nodes reference these by @id. */}
        <JsonLd data={organisationSchema()} />
        <JsonLd data={websiteSchema()} />
        <SiteHeader />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}

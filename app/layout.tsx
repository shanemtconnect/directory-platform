import "./globals.css";
import type { ReactNode } from "react";
import { siteConfig } from "@/config/site.config";
import { themeStyleVars } from "@/lib/theme";
import { JsonLd } from "@/components/seo/JsonLd";
import { organisationSchema, websiteSchema } from "@/lib/schema/builders";

export const metadata = {
  title: { default: siteConfig.name, template: `%s | ${siteConfig.name}` },
  description: siteConfig.tagline,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={siteConfig.locale} style={themeStyleVars(siteConfig.theme)}>
      <body>
        {/* Global identity nodes, emitted once. Page-level nodes reference these by @id. */}
        <JsonLd data={organisationSchema()} />
        <JsonLd data={websiteSchema()} />
        {children}
      </body>
    </html>
  );
}

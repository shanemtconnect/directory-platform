import "./globals.css";
import type { ReactNode } from "react";
import { siteConfig } from "@/config/site.config";
import { themeStyleVars } from "@/lib/theme";

export const metadata = {
  title: { default: siteConfig.name, template: `%s | ${siteConfig.name}` },
  description: siteConfig.tagline,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={siteConfig.locale} style={themeStyleVars(siteConfig.theme)}>
      <body>{children}</body>
    </html>
  );
}

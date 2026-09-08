import { ImageResponse } from "next/og";
import { siteConfig } from "@/config/site.config";

/**
 * The site-wide social card.
 *
 * Next's file convention: this generates `/opengraph-image` and adds the
 * `og:image` and `twitter:image` tags to every page that does not override
 * them, which is why the root layout only has to declare the card TYPE.
 *
 * Composed from config — name, tagline, theme colours — so a clone gets its own
 * card without an image editor. Deliberately typeless in the type-face sense:
 * loading a webfont here would mean fetching it at build time, and the system
 * stack renders the same two lines perfectly well.
 */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = `${siteConfig.name} — ${siteConfig.tagline}`;

export default function OpengraphImage(): ImageResponse {
  const { primary, accent } = siteConfig.theme;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          background: primary,
          color: "#ffffff",
          padding: "80px",
        }}
      >
        <div style={{ fontSize: 82, fontWeight: 700, lineHeight: 1.1 }}>{siteConfig.name}</div>
        <div style={{ fontSize: 40, marginTop: 24, opacity: 0.9 }}>{siteConfig.tagline}</div>
        <div style={{ width: 220, height: 12, marginTop: 48, background: accent }} />
      </div>
    ),
    size,
  );
}

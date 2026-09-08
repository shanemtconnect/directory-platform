import { siteConfig } from "@/config/site.config";
import { escapeXml, truncate } from "@/lib/badge/svg";

/**
 * The favicon, drawn from config rather than checked in as a binary.
 *
 * A static `app/icon.svg` would carry this clone's initials and this clone's
 * brand colours as literals, so every clone would have to replace a file it
 * cannot edit as text. Generating it means a clone changes `shortName` and
 * `theme` in config/site.config.ts and gets its own icon for free.
 *
 * A route handler rather than the `icon.tsx` ImageResponse convention because
 * the output wanted here is a vector: an SVG favicon is a few hundred bytes,
 * stays crisp at every size, and needs no font loading at build time. The
 * <link> is declared by `metadata.icons` in the root layout.
 */
export const dynamic = "force-static";

const SIZE = 64;

/** Two characters at most: below ~28px a third is an unreadable smudge. */
function initials(): string {
  return truncate(siteConfig.shortName, 2).toUpperCase();
}

export function GET(): Response {
  const { primary, accent } = siteConfig.theme;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" role="img" aria-label="${escapeXml(siteConfig.name)}">`
    + `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="${escapeXml(primary)}"/>`
    + `<rect x="0" y="${SIZE - 6}" width="${SIZE}" height="6" fill="${escapeXml(accent)}"/>`
    + `<text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle"`
    + ` font-family="${escapeXml(siteConfig.theme.fontHeading)}, Georgia, serif"`
    + ` font-size="30" font-weight="700" fill="#ffffff">${escapeXml(initials())}</text>`
    + `</svg>`;

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      // Immutable in practice: it only changes when config does, which means a
      // redeploy. Long cache, because a favicon is requested on every visit.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

/**
 * Badge SVG rendering.
 *
 * The SVG is served to third-party sites and embeds attacker-controllable text
 * (a listing name typed by whoever submitted it). Everything interpolated into
 * the markup goes through escapeXml() — an unescaped `<` ends the <text>
 * element and turns a listing name into markup served from our own origin.
 */

export const BADGE_STYLES = ["dark", "light", "compact", "rating"] as const;
export type BadgeStyle = (typeof BADGE_STYLES)[number];

export const DEFAULT_BADGE_STYLE: BadgeStyle = "dark";

/** Unknown or absent style falls back to the default rather than 400ing. */
export function parseBadgeStyle(value: string | null | undefined): BadgeStyle {
  const v = (value ?? "").toLowerCase();
  return (BADGE_STYLES as readonly string[]).includes(v)
    ? (v as BadgeStyle)
    : DEFAULT_BADGE_STYLE;
}

/**
 * XML/HTML entity escape. `&` MUST be replaced first, or the ampersands this
 * function itself introduces get double-escaped.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Strips control characters, which are illegal in XML even when escaped. */
function sanitise(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

export function truncate(value: string, max: number): string {
  const s = sanitise(value);
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export type BadgeDimensions = { width: number; height: number };

const DIMENSIONS: Record<BadgeStyle, BadgeDimensions> = {
  dark: { width: 220, height: 64 },
  light: { width: 220, height: 64 },
  compact: { width: 180, height: 40 },
  rating: { width: 220, height: 78 },
};

export function badgeDimensions(style: BadgeStyle): BadgeDimensions {
  return DIMENSIONS[style];
}

type Palette = {
  bg: string;
  border: string;
  body: string;
  muted: string;
  accent: string;
};

const DARK: Palette = {
  bg: "#1E1B18",
  border: "#332E29",
  body: "#F5F1EC",
  muted: "#B9AFA4",
  accent: "#D4AF37",
};

const LIGHT: Palette = {
  bg: "#FFFFFF",
  border: "#E3DBD2",
  body: "#1E1B18",
  muted: "#6E645A",
  accent: "#8B5A3C",
};

export type BadgeInput = {
  siteName: string;
  listingName: string;
  style: BadgeStyle;
  /** True ONLY for claim_status = 'verified'. Never inferred from tier. */
  verified: boolean;
  ratingAvg?: string | number | null;
  ratingCount?: number | null;
};

const FONT =
  "ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif";

/** The tick, drawn rather than typed, so no font has to carry the glyph. */
function tick(x: number, y: number, colour: string): string {
  return (
    `<path d="M${x} ${y}l2.6 2.7L${x + 8.4} ${y - 4.2}" fill="none" stroke="${colour}" ` +
    `stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>`
  );
}

function stars(rating: number, x: number, y: number, on: string, off: string): string {
  const full = Math.round(rating);
  let out = "";
  for (let i = 0; i < 5; i++) {
    out +=
      `<path transform="translate(${x + i * 13} ${y}) scale(0.55)" ` +
      `d="M10 0l3.09 6.26L20 7.27l-5 4.87 1.18 6.88L10 15.77 3.82 19.02 5 12.14 0 7.27l6.91-1.01z" ` +
      `fill="${i < full ? on : off}"/>`;
  }
  return out;
}

/** Returns a complete standalone SVG document. The caller sets the mime type. */
export function renderBadgeSvg(input: BadgeInput): string {
  const { style } = input;
  const { width, height } = badgeDimensions(style);
  const p = style === "light" ? LIGHT : DARK;

  // Uppercase BEFORE escaping: toUpperCase() on escaped text turns &amp; into
  // the invalid entity &AMP;, which strict SVG parsers reject outright.
  const site = escapeXml(truncate(input.siteName, 34).toUpperCase());
  const name = escapeXml(truncate(input.listingName, style === "compact" ? 22 : 26));

  const ratingNum = input.ratingAvg == null ? null : Number(input.ratingAvg);
  const hasRating =
    ratingNum !== null && Number.isFinite(ratingNum) && (input.ratingCount ?? 0) > 0;

  const label = escapeXml(
    truncate(
      `${input.listingName} on ${input.siteName}${input.verified ? " - Verified" : ""}`,
      140,
    ),
  );

  const head =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}">` +
    `<title>${label}</title>` +
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" ` +
    `fill="${p.bg}" stroke="${p.border}"/>`;

  const body: string[] = [];

  if (style === "compact") {
    body.push(
      `<text x="12" y="17" font-family="${FONT}" font-size="9" font-weight="600" ` +
        `letter-spacing="0.6" fill="${p.muted}">${site}</text>`,
      `<text x="12" y="31" font-family="${FONT}" font-size="11" font-weight="700" ` +
        `fill="${p.body}">${name}</text>`,
    );
    if (input.verified) {
      body.push(
        `<circle cx="${width - 18}" cy="20" r="8.5" fill="none" stroke="${p.accent}" stroke-width="1.4"/>`,
        tick(width - 22.2, 20, p.accent),
      );
    }
  } else if (style === "rating") {
    body.push(
      `<text x="14" y="20" font-family="${FONT}" font-size="9" font-weight="600" ` +
        `letter-spacing="0.7" fill="${p.muted}">${site}</text>`,
      `<text x="14" y="38" font-family="${FONT}" font-size="13" font-weight="700" ` +
        `fill="${p.body}">${name}</text>`,
    );
    if (hasRating && ratingNum !== null) {
      body.push(
        stars(ratingNum, 14, 48, p.accent, p.border),
        `<text x="90" y="59" font-family="${FONT}" font-size="11" font-weight="600" ` +
          `fill="${p.muted}">${escapeXml(ratingNum.toFixed(1))} (${input.ratingCount ?? 0})</text>`,
      );
    } else {
      body.push(
        `<text x="14" y="59" font-family="${FONT}" font-size="11" fill="${p.muted}">No ratings yet</text>`,
      );
    }
    if (input.verified) {
      body.push(
        `<circle cx="${width - 20}" cy="26" r="9.5" fill="none" stroke="${p.accent}" stroke-width="1.5"/>`,
        tick(width - 24.6, 26, p.accent),
      );
    }
  } else {
    body.push(
      `<text x="14" y="22" font-family="${FONT}" font-size="9" font-weight="600" ` +
        `letter-spacing="0.7" fill="${p.muted}">${site}</text>`,
      `<text x="14" y="40" font-family="${FONT}" font-size="13" font-weight="700" ` +
        `fill="${p.body}">${name}</text>`,
      input.verified
        ? `<text x="14" y="55" font-family="${FONT}" font-size="10" font-weight="600" ` +
            `letter-spacing="0.4" fill="${p.accent}">VERIFIED</text>`
        : `<text x="14" y="55" font-family="${FONT}" font-size="10" ` +
            `letter-spacing="0.4" fill="${p.muted}">LISTED</text>`,
    );
    if (input.verified) {
      body.push(
        `<circle cx="${width - 22}" cy="32" r="11" fill="none" stroke="${p.accent}" stroke-width="1.6"/>`,
        tick(width - 27.2, 32, p.accent),
      );
    }
  }

  return `${head}${body.join("")}</svg>`;
}

/** For inline previews: a data: URI that needs no network round-trip. */
export function badgeSvgDataUri(input: BadgeInput): string {
  return `data:image/svg+xml;base64,${Buffer.from(renderBadgeSvg(input), "utf8").toString("base64")}`;
}

import { siteConfig } from "@/config/site.config";
import { siteUrl } from "@/lib/schema/builders";
import {
  badgeDimensions,
  escapeXml,
  type BadgeStyle,
} from "./svg";

/**
 * Copy-paste embed code.
 *
 * Two things matter here beyond looking tidy.
 *
 * 1. Escaping. The listing name and city both end up inside an HTML attribute
 *    and inside link text. The same escape the SVG uses applies — a name
 *    containing a quote would otherwise break out of alt="" and a name
 *    containing `<` would inject markup into whatever page pastes this.
 *
 * 2. Anchor-text variety. If every embed on the web carries identical anchor
 *    text, the link profile looks manufactured. Three branded variants are
 *    offered so the footprint reads naturally, and every one of them is
 *    branded — no exact-match commercial anchors.
 */

/** HTML escaping is the same set of five as XML. One function, one rule. */
export const escapeHtml = escapeXml;

export const UTM = "utm_source=badge&utm_medium=referral";

/** The image endpoint. `/badge/{listingId}?style={style}` */
export function badgeImageUrl(listingId: string, style: BadgeStyle): string {
  return siteUrl(`/badge/${encodeURIComponent(listingId)}?style=${style}`);
}

/**
 * The click endpoint. `/api/badge-click?id={listingId}`
 *
 * Only the tracked snippet variant points here, and `badges.click_count` only
 * ever moves for embeds that use it. The default snippet's anchor goes
 * straight to the listing and is invisible to the counter — deliberately, see
 * `badgeTrackedSnippetHtml`.
 */
export function badgeClickUrl(listingId: string): string {
  return siteUrl(`/api/badge-click?id=${encodeURIComponent(listingId)}`);
}

/** Where the badge points. Always the canonical listing page, always tagged. */
export function badgeTargetUrl(listingPath: string): string {
  const path = listingPath.startsWith("/") ? listingPath : `/${listingPath}`;
  return `${siteUrl(path)}?${UTM}`;
}

export type SnippetInput = {
  listingId: string;
  listingName: string;
  /** Canonical path of the listing page, e.g. `/bath/the-old-mill`. */
  listingPath: string;
  cityName: string;
  categoryName: string;
  style: BadgeStyle;
};

export type AnchorVariant = {
  key: "brand" | "descriptive" | "verified";
  label: string;
  text: string;
  html: string;
};

/**
 * Three branded anchor-text variants. Nouns come from siteConfig.entity so a
 * clone in another niche says the right word without a code change.
 */
export function anchorVariants(input: SnippetInput): AnchorVariant[] {
  const href = escapeHtml(badgeTargetUrl(input.listingPath));
  const site = siteConfig.name;
  const singular = siteConfig.entity.Singular;

  const texts: { key: AnchorVariant["key"]; label: string; text: string }[] = [
    {
      key: "brand",
      label: "Site name",
      text: site,
    },
    {
      key: "descriptive",
      label: "Category and place",
      text: `${input.categoryName} in ${input.cityName} on ${site}`,
    },
    {
      key: "verified",
      label: "Verified status",
      text: `${site} verified ${singular.toLowerCase()}`,
    },
  ];

  return texts.map((t) => ({
    ...t,
    html: `<a href="${href}" rel="noopener">${escapeHtml(t.text)}</a>`,
  }));
}

/**
 * The badge embed: an <a> wrapping an <img>. width/height are set so the host
 * page reserves the space and does not shift layout; loading="lazy" keeps it
 * off the critical path of a page we do not own.
 */
export function badgeSnippetHtml(input: SnippetInput): string {
  const { width, height } = badgeDimensions(input.style);
  const href = escapeHtml(badgeTargetUrl(input.listingPath));
  const src = escapeHtml(badgeImageUrl(input.listingId, input.style));
  const alt = escapeHtml(
    `${input.listingName} is listed on ${siteConfig.name}, the ${siteConfig.entity.singular} directory`,
  );
  const title = escapeHtml(`${input.listingName} on ${siteConfig.name}`);

  return [
    `<a href="${href}" title="${title}" rel="noopener">`,
    `  <img src="${src}"`,
    `       alt="${alt}"`,
    `       width="${width}" height="${height}" loading="lazy" decoding="async">`,
    `</a>`,
  ].join("\n");
}

/**
 * The tracked variant: the same image, but the anchor goes through
 * `/api/badge-click` instead of straight at the listing.
 *
 * This is offered as a choice rather than made the default, because the two
 * options are genuinely in tension and the owner is the one who should pick:
 *
 *   - the DEFAULT snippet's anchor is a real link to a real page, which is
 *     the whole point of a badge programme and the only version that passes
 *     any authority. It is also uncountable: the visitor goes from their site
 *     to ours without touching anything we can measure;
 *   - this variant is countable, and `rel="nofollow"` is on it because that
 *     is the honest label for a redirect through our own endpoint. A link
 *     laundered through a counter is not a citation, and dressing one up as
 *     the other is what gets a link programme treated as a scheme.
 *
 * So: `badges.click_count` stays at zero for every listing whose owner pasted
 * the default snippet. That number is "clicks on tracked embeds", not
 * "clicks", and anything rendering it has to say so.
 */
export function badgeTrackedSnippetHtml(input: SnippetInput): string {
  const { width, height } = badgeDimensions(input.style);
  const href = escapeHtml(badgeClickUrl(input.listingId));
  const src = escapeHtml(badgeImageUrl(input.listingId, input.style));
  const alt = escapeHtml(
    `${input.listingName} is listed on ${siteConfig.name}, the ${siteConfig.entity.singular} directory`,
  );
  const title = escapeHtml(`${input.listingName} on ${siteConfig.name}`);

  return [
    `<a href="${href}" title="${title}" rel="noopener nofollow">`,
    `  <img src="${src}"`,
    `       alt="${alt}"`,
    `       width="${width}" height="${height}" loading="lazy" decoding="async">`,
    `</a>`,
  ].join("\n");
}

/** The text-link alternative, for owners who would rather not embed an image. */
export function anchorSnippetHtml(input: SnippetInput, key: AnchorVariant["key"]): string {
  const variants = anchorVariants(input);
  const chosen = variants.find((v) => v.key === key) ?? variants[0];
  return chosen ? chosen.html : "";
}

/** Everything /advertise/badge needs for one style, in one object. */
export function badgeKit(input: SnippetInput) {
  return {
    style: input.style,
    dimensions: badgeDimensions(input.style),
    imageUrl: badgeImageUrl(input.listingId, input.style),
    targetUrl: badgeTargetUrl(input.listingPath),
    embed: badgeSnippetHtml(input),
    // The countable alternative. Offered, never substituted: see
    // badgeTrackedSnippetHtml for why the default keeps its direct anchor.
    trackedEmbed: badgeTrackedSnippetHtml(input),
    clickUrl: badgeClickUrl(input.listingId),
    anchors: anchorVariants(input),
  };
}

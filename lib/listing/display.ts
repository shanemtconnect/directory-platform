import type { TierSpec } from "@/config/types";

/**
 * What a listing page actually SHOWS, given its tier.
 *
 * It lives here rather than inside the component because the JSON-LD builder
 * needs the same answer. Markup must match visible content (global constraint
 * 11), and the only way to guarantee that is for the page and the markup to ask
 * one function — a free listing that renders a 300-character excerpt must not
 * hand Google the full 2,500-character description.
 */

export interface DescribableListing {
  readonly description: string | null;
  readonly shortDescription: string | null;
}

type DisplayTier = Pick<TierSpec, "descriptionDisplay" | "excerptChars" | "showSocial">;

export function displayedDescription(
  listing: DescribableListing,
  tier: DisplayTier,
): string | null {
  const text = listing.description ?? listing.shortDescription;
  if (text === null || text === "") return null;
  if (tier.descriptionDisplay === "full") return text;
  if (text.length <= tier.excerptChars) return text;
  return `${text.slice(0, tier.excerptChars).replace(/\s+\S*$/, "")}…`;
}

/**
 * `socials` is a jsonb column, so it can be anything. Only a genuine list of
 * strings, on a tier that renders the links, reaches `sameAs`.
 */
export function displayedSocials(socials: unknown, tier: DisplayTier): string[] {
  if (!tier.showSocial || !Array.isArray(socials)) return [];
  return socials.filter((s): s is string => typeof s === "string" && s !== "");
}

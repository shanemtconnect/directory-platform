import { siteConfig } from "@/config/site.config";
import type { AdPlacement, AdsConfig, TierName } from "@/config/types";
import type { PillarScope } from "@/lib/routing/scope";

/**
 * Whether a sponsor rail renders on a page, and as what.
 *
 * Pure and table-driven on purpose: every placement × page state × environment
 * is one row in `policy.test.ts`. The component calls this once and never
 * reasons about tiers or environments itself.
 *
 *   off          nothing renders
 *   placeholder  staging: a labelled "Sponsor slot" so the layout is visible
 *   show         production: house ads and live sponsor campaigns
 */
export type RailsDecision = "off" | "placeholder" | "show";

export interface PageListing {
  readonly tier: TierName;
  readonly claimStatus: "unclaimed" | "claimed" | "verified";
}

export interface RailsInput {
  readonly placement: AdPlacement;
  /** The listing a `listingDetail` page is about; null on every other page. */
  readonly listing: PageListing | null;
  readonly config?: AdsConfig;
  readonly env?: Record<string, string | undefined>;
}

/**
 * Placements that never carry a rail, whatever the config says. The home page
 * is the brand; the brief lists it under "never on" outright. `other` is the
 * name a page uses when it has no placement of its own — checkout, billing,
 * account, admin, auth, legal, errors — and those pages do not mount the
 * component at all, so this is belt and braces.
 */
const HARD_NEVER: readonly AdPlacement[] = ["home", "other"];

export const ADS_ENV_SWITCH = "ADS_ENABLED";

/**
 * The master switch, resolved: the env kill switch first, then the config.
 * `ADS_ENABLED=true` turns the rails on over a config that has them off —
 * that exists so a staging build of a clone whose config is still off can be
 * checked, and so the e2e suite can prove the production shape without a
 * config edit. Any other value defers to `siteConfig.ads.enabled`.
 */
export function adsEnabled(
  config: AdsConfig = siteConfig.ads,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env[ADS_ENV_SWITCH] ?? "").trim().toLowerCase();
  if (raw === "false") return false;
  if (raw === "true") return true;
  return config.enabled;
}

/** "unpaid-only": tier `free` AND not verified. A verified free listing is not unpaid. */
export function isUnpaidListing(listing: PageListing): boolean {
  return listing.tier === "free" && listing.claimStatus !== "verified";
}

export function decideSponsorRails(input: RailsInput): RailsDecision {
  const config = input.config ?? siteConfig.ads;
  const env = input.env ?? process.env;
  if (!adsEnabled(config, env)) return "off";
  if (HARD_NEVER.includes(input.placement)) return "off";

  const rule = config.placements[input.placement];
  if (rule === "never") return "off";
  if (input.placement === "listingDetail") {
    // A product rule, not a clone knob: the owner of a paid or verified page
    // bought that page. "always" here means every unpaid listing.
    if (input.listing === null || !isUnpaidListing(input.listing)) return "off";
  } else if (rule === "unpaid-only") {
    if (input.listing === null || !isUnpaidListing(input.listing)) return "off";
  }
  return env.SITE_ENV === "production" ? "show" : "placeholder";
}

/**
 * Which placement a pillar page is (I2). A city page is the town pillar; a
 * city × category page, a vertical page and a vertical × area page all list
 * one kind of business, which is what "type pages" means to an advertiser.
 */
export function placementForScope(scope: PillarScope): AdPlacement {
  switch (scope.type) {
    case "city":
      return "cityPillar";
    case "city-category":
    case "vertical":
    case "vertical-area":
      return "categoryPillar";
  }
}

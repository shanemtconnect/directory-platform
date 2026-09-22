export type TierName = "free" | "essential" | "premium";

export type CustomFieldType = "number" | "boolean" | "text" | "select" | "currency";

/**
 * The families the theme layer ships webfonts for.
 *
 * ONE list, here. A clone's font is chosen by the wizard (lib/clone/questions.ts)
 * and read by lib/theme.ts, and a second copy of the union in either place is a
 * font that can be written into a config nothing knows how to load.
 */
export type FontFamily =
  | "Fraunces"
  | "Inter"
  | "Playfair Display"
  | "Source Sans 3"
  | "DM Sans"
  | "Lora";

export interface CustomField {
  readonly key: string;
  readonly label: string;
  readonly type: CustomFieldType;
  readonly options?: readonly string[];
  readonly searchable?: boolean;
  readonly showInCard?: boolean;
  /** Minimum tier required for this field to be displayed publicly. */
  readonly tier?: TierName;
}

/**
 * NEVER tier-gated, on any site, at any tier — including unclaimed listings:
 * name, address, phone, opening hours, map pin, category, the enquiry form,
 * and reviews. Gating contact details on a directory kills the traffic that
 * makes the listings worth paying for. The upgrade levers are reach and
 * richness, never reachability.
 */
export interface TierSpec {
  /** Shown on /pricing. The page renders from this file, never from hardcoded HTML. */
  readonly label: string;
  readonly strapline: string;
  /** Marketing copy. Keep in step with the booleans below — these sell it, those enforce it. */
  readonly bullets: readonly string[];

  readonly rank: number;
  readonly priceAnnual: number;
  readonly priceMonthly: number;
  readonly trialDays: number;

  /** null = unlimited. */
  readonly maxImages: number | null;
  /**
   * Free tiers show a truncated excerpt and paid tiers show the whole thing.
   * The owner always writes the full description — seeing it cut off is the
   * upgrade prompt, and it beats refusing the input at write time.
   */
  readonly descriptionDisplay: "excerpt" | "full";
  readonly excerptChars: number;

  readonly adFree: boolean;
  readonly showWebsite: boolean;
  readonly showSocial: boolean;
  /** Price-from fields and current offers. */
  readonly showPricingAndOffers: boolean;
  readonly allowVideo: boolean;
  readonly allowPricingPackages: boolean;
  readonly allowFaq: boolean;
  readonly allowTeam: boolean;
  readonly allowGalleryAlbums: boolean;

  readonly homepageSlot: boolean;
  /** Eligible for editorial inclusion. Surfaced to admin; not automated. */
  readonly editorialFeature: boolean;

  readonly statsWindowDays: number;
  readonly allowStatsExport: boolean;

  /**
   * Verified is a subscription benefit. True on every paid tier. It still never
   * auto-grants the badge on payment alone — the owner must also pass the
   * control check from the claim evidence ladder.
   */
  readonly verificationIncluded: boolean;
}

export const FEATURE_FLAGS = [
  "reviews",
  "shortlist",
  "quoteBroadcast",
  "contentHub",
  "footerLinkMatrix",
  "claimOutreach",
  "costGuides",
  "jobBoard",
  "awards",
  "affiliates",
  "utilityTool",
  "storefrontExtras",
  "events",
  "bookings",
  "multiLocale",
] as const;

export type FeatureFlag = (typeof FEATURE_FLAGS)[number];
export type FeatureMap = { readonly [K in FeatureFlag]: boolean };

export type SiteMode = "niche-national" | "local-multi-vertical";

export interface SiteConfig {
  readonly name: string;
  readonly shortName: string;
  readonly domain: string;
  readonly tagline: string;
  readonly legalEntity: string;
  readonly supportEmail: string;

  /** Drives every noun in the UI. Nothing niche-specific belongs in a component. */
  readonly entity: {
    readonly singular: string;
    readonly plural: string;
    readonly Singular: string;
    readonly Plural: string;
    readonly verb: string;
    readonly ownerNoun: string;
  };

  readonly country: string;
  readonly locale: string;
  readonly currency: string;
  /** IANA zone. Pins the daily listing shuffle so it cannot flip on server-local midnight. */
  readonly timezone: string;
  /** "county" in the UK, "state" in the US. Disambiguation and schema only — never a URL. */
  readonly regionLabel: string;

  readonly schema: {
    readonly listingType: string;
    readonly organizationType: string;
    readonly priceRangeEnabled: boolean;
  };

  readonly theme: {
    readonly primary: string;
    readonly accent: string;
    readonly fontHeading: FontFamily;
    readonly fontBody: FontFamily;
    readonly radius: string;
  };

  readonly listing: {
    /** Input cap, same for every tier. Display is governed by `descriptionDisplay`. */
    readonly maxDescriptionChars: number;
  };

  readonly customFields: readonly CustomField[];
  readonly reviewCriteria: readonly { readonly key: string; readonly label: string }[];
  readonly tiers: { readonly [K in TierName]: TierSpec };

  readonly verification: {
    readonly requireVideoCall: boolean;
    /** Verified lapses when the subscription does. Always true today. */
    readonly expiresWithSubscription: boolean;
  };

  readonly siteMode: SiteMode;
  readonly features: FeatureMap;

  readonly seo: {
    readonly minListingsToIndex: number;
    readonly requireIntroCopyToIndex: boolean;
    readonly footerCitiesPerCategory: number;
  };

  readonly stats: {
    /**
     * How many days of `listing_stats_daily` the worker keeps; older rows are
     * deleted nightly. At least 30, and at least the longest tier
     * `statsWindowDays` — anything shorter would purge days an owner is still
     * shown. `config/validate.ts` refuses the build otherwise.
     */
    readonly retentionDays: number;
  };

  /**
   * The facts /privacy and /terms state about themselves.
   *
   * Those two pages are templates with the boilerplate written out and every
   * clone-specific claim marked "[Confirm with counsel]". These are the fields
   * that are safe to fill in from config — who the controller is, and when each
   * document was last revised. A stale "last updated" is worse than none, so it
   * is a value here rather than a build date.
   */
  readonly legal: {
    /** ISO date, e.g. "2026-09-08". Bump it whenever the policy text changes. */
    readonly privacyLastUpdated: string;
    readonly termsLastUpdated: string;
    /**
     * The entity that decides how personal data is used. Usually the same as
     * `legalEntity`, but not always — a site operated by one company on behalf
     * of another has two different answers, and only one of them is right.
     */
    readonly dataController: string;
  };

  /**
   * Featured spots — the three paid positions above the organic grid on every
   * city and city × category pillar page (and, once region pages exist, on
   * region pages). Owners of verified, paying listings bid a monthly amount
   * per spot; the top `positions` bids are shown and charged, the rest are
   * "outbid" and pay nothing. Floors are in major units of `currency` and set
   * the lowest bid a spot will take; a clone prices its own market here.
   */
  readonly featured: {
    readonly positions: number;
    readonly floors: {
      readonly city: number;
      readonly region: number;
    };
  };
}

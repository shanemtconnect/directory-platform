export type TierName = "free" | "essential" | "premium";

export type CustomFieldType = "number" | "boolean" | "text" | "select" | "currency";

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
  readonly rank: number;
  /** Owner-editable limits. Enforced server-side in the account UI, not just hidden. */
  readonly maxImages: number;
  readonly maxDescriptionChars: number;
  readonly showWebsite: boolean;
  readonly showSocial: boolean;
  readonly allowCustomFields: boolean;
  readonly allowVideo: boolean;
  readonly allowPricingPackages: boolean;
  readonly allowFaq: boolean;
  readonly allowTeam: boolean;
  readonly allowGalleryAlbums: boolean;
  /** How far back the owner dashboard shows stats. */
  readonly statsWindowDays: number;
  readonly allowStatsExport: boolean;
  /**
   * Verified is a subscription benefit. True on every paid tier. It still never
   * auto-grants the badge on payment alone — the owner must also pass the
   * control check from the claim evidence ladder.
   */
  readonly verificationIncluded: boolean;
  readonly homepageSlot?: boolean;
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
    readonly fontHeading: string;
    readonly fontBody: string;
    readonly radius: string;
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
}

import type { CustomField, SiteConfig } from "./types";

/**
 * THE ONLY FILE A CLONE EDITS.
 *
 * @template-config: replaced by `pnpm new-site` — this is the demo niche the
 * repository ships with. The wizard writes over it without --overwrite; the
 * config it writes does not carry this line, so a real clone's config is
 * never replaced by accident.
 *
 * Every value here is niche-specific. If a string in a component would need to
 * change when this repo is cloned for a different niche, it belongs in here or
 * in the database — never in the component.
 */
export const siteConfig = {
  name: "Which Wedding Venue",
  shortName: "WWV",
  domain: "whichweddingvenue.co.uk",
  tagline: "Find your perfect UK wedding venue",
  legalEntity: "TBC",
  supportEmail: "hello@example.co.uk",

  entity: {
    singular: "venue",
    plural: "venues",
    Singular: "Venue",
    Plural: "Venues",
    verb: "list",
    ownerNoun: "venue owner",
  },

  country: "GB",
  locale: "en-GB",
  currency: "GBP",
  timezone: "Europe/London",
  regionLabel: "county",

  schema: {
    listingType: "EventVenue",
    organizationType: "Organization",
    priceRangeEnabled: true,
  },

  theme: {
    primary: "#8B5A3C",
    accent: "#D4AF37",
    fontHeading: "Fraunces",
    fontBody: "Inter",
    radius: "0.75rem",
  },

  customFields: [
    { key: "capacity_seated", label: "Seated capacity", type: "number", searchable: true, showInCard: true },
    { key: "capacity_standing", label: "Standing capacity", type: "number", searchable: true },
    { key: "has_accommodation", label: "On-site accommodation", type: "boolean", searchable: true, showInCard: true },
    { key: "licensed_for_ceremonies", label: "Licensed for ceremonies", type: "boolean", searchable: true },
    { key: "price_from", label: "Prices from", type: "currency", tier: "essential" },
  ],

  reviewCriteria: [
    { key: "value", label: "Value for money" },
    { key: "service", label: "Service" },
    { key: "setting", label: "Setting" },
  ],

  listing: {
    maxDescriptionChars: 2500,
  },

  // /pricing renders from here. Monthly x 12 is exactly 12 months' worth, and
  // annual is exactly 10 x monthly, so "save 2 months" is literally true —
  // a price claim that is precisely accurate is worth more than the 9p.
  tiers: {
    free: {
      label: "Free",
      strapline: "Forever free",
      bullets: [
        "Basic listing with excerpt",
        "3 photos",
        "Contact enquiry form",
        "Enquiry notifications & portal management",
      ],
      rank: 10,
      priceAnnual: 0,
      priceMonthly: 0,
      trialDays: 0,
      maxImages: 3,
      descriptionDisplay: "excerpt",
      excerptChars: 300,
      adFree: false,
      showWebsite: false,
      showSocial: false,
      showPricingAndOffers: false,
      allowVideo: false,
      allowPricingPackages: false,
      allowFaq: false,
      allowTeam: false,
      allowGalleryAlbums: false,
      homepageSlot: false,
      editorialFeature: false,
      statsWindowDays: 30,
      allowStatsExport: false,
      verificationIncluded: false,
    },
    essential: {
      label: "Essential",
      strapline: "30-day free trial · Cancel anytime",
      bullets: [
        "Priority over free listings in search & category pages",
        "Full Venue description displayed",
        "10 photos",
        "Ad-free listing",
        "Website & social links",
        "Venue pricing information and offers displayed",
      ],
      rank: 20,
      priceAnnual: 99,
      priceMonthly: 9.9,
      trialDays: 30,
      maxImages: 10,
      descriptionDisplay: "full",
      excerptChars: 300,
      adFree: true,
      showWebsite: true,
      showSocial: true,
      showPricingAndOffers: true,
      allowVideo: false,
      allowPricingPackages: false,
      allowFaq: false,
      allowTeam: false,
      allowGalleryAlbums: false,
      homepageSlot: false,
      editorialFeature: false,
      statsWindowDays: 365,
      allowStatsExport: false,
      verificationIncluded: true,
    },
    premium: {
      label: "Premium",
      strapline: "30-day free trial · Cancel anytime",
      bullets: [
        "Everything in Essential, plus:",
        "Priority above Essential in search & category pages",
        "Listed on the homepage",
        "Featured in editorial blog posts",
        "Unlimited photos",
      ],
      rank: 30,
      priceAnnual: 249,
      priceMonthly: 24.9,
      trialDays: 30,
      maxImages: null,
      descriptionDisplay: "full",
      excerptChars: 300,
      adFree: true,
      showWebsite: true,
      showSocial: true,
      showPricingAndOffers: true,
      allowVideo: true,
      allowPricingPackages: true,
      allowFaq: true,
      allowTeam: true,
      allowGalleryAlbums: true,
      homepageSlot: true,
      editorialFeature: true,
      statsWindowDays: 365,
      allowStatsExport: true,
      verificationIncluded: true,
    },
  },

  verification: {
    requireVideoCall: false,
    expiresWithSubscription: true,
  },

  siteMode: "niche-national",

  features: {
    reviews: true,
    shortlist: true,
    quoteBroadcast: false,
    contentHub: true,
    footerLinkMatrix: true,
    claimOutreach: true,
    costGuides: false,
    jobBoard: false,
    awards: false,
    affiliates: false,
    utilityTool: false,
    storefrontExtras: false,
    events: false,
    bookings: false,
    multiLocale: false,
  },

  seo: {
    minListingsToIndex: 3,
    requireIntroCopyToIndex: true,
    footerCitiesPerCategory: 18,
  },

  quotes: {
    maxRecipients: 5,
  },

  stats: {
    // A year and a bit: covers the 365-day paid window with room for an
    // owner to compare this month against the same month last year.
    retentionDays: 400,
  },

  ads: {
    // Sponsor rails: house ads plus self-serve sponsors, never an ad network.
    // Off until the site has the traffic to sell; `pnpm new-site` asks.
    enabled: false,
    monthlyPrice: 49,
    placements: {
      home: "never",
      cityPillar: "always",
      categoryPillar: "always",
      listingDetail: "unpaid-only",
      search: "always",
      blog: "always",
      other: "never",
    },
  },

  legal: {
    privacyLastUpdated: "2026-09-08",
    termsLastUpdated: "2026-09-08",
    dataController: "TBC",
  },

  // Awards: one computed winner per town and category a year. A listing needs
  // this many published reviews to be in the running (see lib/db/queries/awards.ts).
  awards: {
    minReviews: 5,
  },
} as const satisfies SiteConfig;

/**
 * Widened accessors.
 *
 * `as const satisfies SiteConfig` is load-bearing — it keeps the literal types
 * the feature-flag tree-shaking depends on. The cost is that it narrows
 * `customFields` to a union of exact object shapes, so an optional key like
 * `searchable` or `showInCard` does not exist on members that omit it, and
 * `.filter(f => f.showInCard)` is a compile error rather than a false.
 *
 * That has now caught three separate pieces of work. Read fields through here
 * instead of reaching into the const.
 */
export const customFields: readonly CustomField[] = siteConfig.customFields;

export const searchableFields = (): readonly CustomField[] =>
  customFields.filter((f) => f.searchable === true);

export const cardFields = (): readonly CustomField[] =>
  customFields.filter((f) => f.showInCard === true);

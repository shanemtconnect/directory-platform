import type { SiteConfig } from "./types";

/**
 * THE ONLY FILE A CLONE EDITS.
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

  tiers: {
    free: {
      rank: 10,
      maxImages: 3,
      maxDescriptionChars: 300,
      showWebsite: false,
      showSocial: false,
      allowCustomFields: false,
      allowVideo: false,
      allowPricingPackages: false,
      allowFaq: false,
      allowTeam: false,
      allowGalleryAlbums: false,
      statsWindowDays: 30,
      allowStatsExport: false,
      verificationIncluded: false,
    },
    essential: {
      rank: 20,
      maxImages: 10,
      maxDescriptionChars: 1000,
      showWebsite: true,
      showSocial: true,
      allowCustomFields: true,
      allowVideo: false,
      allowPricingPackages: false,
      allowFaq: false,
      allowTeam: false,
      allowGalleryAlbums: false,
      statsWindowDays: 365,
      allowStatsExport: false,
      verificationIncluded: true,
    },
    premium: {
      rank: 30,
      maxImages: 100,
      maxDescriptionChars: 2500,
      showWebsite: true,
      showSocial: true,
      allowCustomFields: true,
      allowVideo: true,
      allowPricingPackages: true,
      allowFaq: true,
      allowTeam: true,
      allowGalleryAlbums: true,
      statsWindowDays: 365,
      allowStatsExport: true,
      verificationIncluded: true,
      homepageSlot: true,
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
} as const satisfies SiteConfig;

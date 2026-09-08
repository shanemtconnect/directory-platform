import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FEATURE_FLAGS, type FeatureMap } from "@/config/types";
import { ConfigError, validateCountry, validateFeatureDependencies } from "@/config/validate";
import type { Answers, CustomFieldAnswer } from "./questions";

/** Relative to the site root, so the wizard can target a clone in another directory. */
export const SITE_CONFIG_PATH = "config/site.config.ts";

/** The value a fresh checkout carries, and the one a production build must never see. */
export const PLACEHOLDER_LEGAL_ENTITY = "TBC";

export interface WriteConfigOptions {
  readonly targetDir: string;
  readonly dryRun?: boolean;
  readonly overwrite?: boolean;
  /** Lets the placeholder legal entity through, for a site that is not going live yet. */
  readonly allowPlaceholders?: boolean;
}

export interface WriteConfigResult {
  readonly path: string;
  readonly source: string;
  readonly written: boolean;
}

function str(value: string): string {
  return JSON.stringify(value);
}

function num(value: number | null): string {
  return value === null ? "null" : String(value);
}

function list(values: readonly string[], indent: string): string {
  if (values.length === 0) return "[]";
  return `[\n${values.map((v) => `${indent}  ${str(v)},`).join("\n")}\n${indent}]`;
}

export function featuresFrom(answers: Answers): FeatureMap {
  return Object.fromEntries(
    FEATURE_FLAGS.map((flag) => [flag, answers[`feature_${flag}`]]),
  ) as FeatureMap;
}

function renderCustomField(field: CustomFieldAnswer): string {
  const parts = [`key: ${str(field.key)}`, `label: ${str(field.label)}`, `type: ${str(field.type)}`];
  if (field.options !== undefined && field.options.length > 0) {
    parts.push(`options: [${field.options.map(str).join(", ")}]`);
  }
  if (field.searchable === true) parts.push("searchable: true");
  if (field.showInCard === true) parts.push("showInCard: true");
  if (field.tier !== undefined) parts.push(`tier: ${str(field.tier)}`);
  return `    { ${parts.join(", ")} },`;
}

function imagesBullet(cap: number | null): string {
  return cap === null ? "Unlimited photos" : `${cap} photos`;
}

function strapline(trialDays: number): string {
  return trialDays > 0 ? `${trialDays}-day free trial · Cancel anytime` : "Cancel anytime";
}

interface TierRender {
  readonly name: string;
  readonly label: string;
  readonly strapline: string;
  readonly bullets: readonly string[];
  readonly rank: number;
  readonly priceAnnual: number;
  readonly priceMonthly: number;
  readonly trialDays: number;
  readonly maxImages: number | null;
  readonly descriptionDisplay: "excerpt" | "full";
  readonly paid: boolean;
  readonly premium: boolean;
}

/**
 * The tier ladder is the same on every site; only the nouns, the prices and the
 * caps move. Contact details are never gated on any tier — the upgrade levers
 * are reach and richness, never reachability.
 */
function tiersFor(a: Answers): readonly TierRender[] {
  const Singular = a.entitySingularCapitalised;
  return [
    {
      name: "free",
      label: "Free",
      strapline: "Forever free",
      bullets: [
        "Basic listing with excerpt",
        imagesBullet(a.freeMaxImages),
        "Contact enquiry form",
        "Enquiry notifications & portal management",
      ],
      rank: 10,
      priceAnnual: 0,
      priceMonthly: 0,
      trialDays: 0,
      maxImages: a.freeMaxImages,
      descriptionDisplay: "excerpt",
      paid: false,
      premium: false,
    },
    {
      name: "essential",
      label: "Essential",
      strapline: strapline(a.trialDays),
      bullets: [
        "Priority over free listings in search & category pages",
        `Full ${Singular} description displayed`,
        imagesBullet(a.essentialMaxImages),
        "Ad-free listing",
        "Website & social links",
        `${Singular} pricing information and offers displayed`,
      ],
      rank: 20,
      priceAnnual: a.essentialPriceAnnual,
      priceMonthly: a.essentialPriceMonthly,
      trialDays: a.trialDays,
      maxImages: a.essentialMaxImages,
      descriptionDisplay: "full",
      paid: true,
      premium: false,
    },
    {
      name: "premium",
      label: "Premium",
      strapline: strapline(a.trialDays),
      bullets: [
        "Everything in Essential, plus:",
        "Priority above Essential in search & category pages",
        "Listed on the homepage",
        "Featured in editorial blog posts",
        imagesBullet(a.premiumMaxImages),
      ],
      rank: 30,
      priceAnnual: a.premiumPriceAnnual,
      priceMonthly: a.premiumPriceMonthly,
      trialDays: a.trialDays,
      maxImages: a.premiumMaxImages,
      descriptionDisplay: "full",
      paid: true,
      premium: true,
    },
  ];
}

function renderTier(t: TierRender): string {
  return `    ${t.name}: {
      label: ${str(t.label)},
      strapline: ${str(t.strapline)},
      bullets: ${list(t.bullets, "      ")},

      rank: ${t.rank},
      priceAnnual: ${t.priceAnnual},
      priceMonthly: ${t.priceMonthly},
      trialDays: ${t.trialDays},

      maxImages: ${num(t.maxImages)},
      descriptionDisplay: ${str(t.descriptionDisplay)},
      excerptChars: 300,

      adFree: ${t.paid},
      showWebsite: ${t.paid},
      showSocial: ${t.paid},
      showPricingAndOffers: ${t.paid},
      allowVideo: ${t.premium},
      allowPricingPackages: ${t.premium},
      allowFaq: ${t.premium},
      allowTeam: ${t.premium},
      allowGalleryAlbums: ${t.premium},

      homepageSlot: ${t.premium},
      editorialFeature: ${t.premium},

      statsWindowDays: ${t.paid ? 365 : 30},
      allowStatsExport: ${t.premium},

      verificationIncluded: ${t.paid},
    },`;
}

/** Pure: the same answers always render the same file, byte for byte. */
export function renderSiteConfig(a: Answers): string {
  const features = featuresFrom(a);
  const customFields =
    a.customFields.length === 0
      ? "  customFields: [],"
      : `  customFields: [\n${a.customFields.map(renderCustomField).join("\n")}\n  ],`;

  return `import type { SiteConfig } from "./types";

/**
 * THE ONLY FILE A CLONE EDITS.
 *
 * Generated by \`pnpm new-site\`. Every value here is niche-specific. If a string
 * in a component would need to change when this repo is cloned for a different
 * niche, it belongs in here or in the database — never in the component.
 */
export const siteConfig = {
  name: ${str(a.name)},
  shortName: ${str(a.shortName)},
  domain: ${str(a.domain)},
  tagline: ${str(a.tagline)},
  legalEntity: ${str(a.legalEntity)},
  supportEmail: ${str(a.supportEmail)},

  // Drives every noun in the UI. Nothing niche-specific belongs in a component.
  entity: {
    singular: ${str(a.entitySingular)},
    plural: ${str(a.entityPlural)},
    Singular: ${str(a.entitySingularCapitalised)},
    Plural: ${str(a.entityPluralCapitalised)},
    verb: ${str(a.entityVerb)},
    ownerNoun: ${str(a.entityOwnerNoun)},
  },

  country: ${str(a.country)},
  locale: ${str(a.locale)},
  currency: ${str(a.currency)},
  // IANA zone. Pins the daily shuffle so it cannot flip on server-local midnight.
  timezone: ${str(a.timezone)},
  // Disambiguation and markup only — never a URL.
  regionLabel: ${str(a.regionLabel)},

  schema: {
    listingType: ${str(a.schemaListingType)},
    organizationType: ${str(a.schemaOrganizationType)},
    priceRangeEnabled: ${a.schemaPriceRangeEnabled},
  },

  theme: {
    primary: ${str(a.themePrimary)},
    accent: ${str(a.themeAccent)},
    fontHeading: ${str(a.fontHeading)},
    fontBody: ${str(a.fontBody)},
    radius: ${str(a.themeRadius)},
  },

${customFields}

  reviewCriteria: [
${a.reviewCriteria.map((c) => `    { key: ${str(c.key)}, label: ${str(c.label)} },`).join("\n")}
  ],

  listing: {
    // Input cap, the same for every tier. Display is governed by descriptionDisplay.
    maxDescriptionChars: ${a.maxDescriptionChars},
  },

  // /pricing renders from here. Annual is exactly 10 x monthly, so "save two
  // months" is literally true — a price claim that is precisely accurate is
  // worth more than the rounding.
  tiers: {
${tiersFor(a).map(renderTier).join("\n")}
  },

  verification: {
    requireVideoCall: false,
    // Verified lapses when the subscription does.
    expiresWithSubscription: true,
  },

  siteMode: ${str(a.siteMode)},

  features: {
${FEATURE_FLAGS.map((f) => `    ${f}: ${features[f]},`).join("\n")}
  },

  seo: {
    minListingsToIndex: ${a.seoMinListingsToIndex},
    requireIntroCopyToIndex: ${a.seoRequireIntroCopyToIndex},
    footerCitiesPerCategory: ${a.seoFooterCitiesPerCategory},
  },
} as const satisfies SiteConfig;
`;
}

/**
 * Runs the same validators the build runs, before anything reaches disk. A
 * config that would fail `next build` is never written — finding out at deploy
 * time is the expensive way to learn it.
 */
export function writeSiteConfig(a: Answers, opts: WriteConfigOptions): WriteConfigResult {
  validateFeatureDependencies(featuresFrom(a));
  validateCountry({ country: a.country, currency: a.currency, locale: a.locale });

  if (a.legalEntity.trim() === PLACEHOLDER_LEGAL_ENTITY && opts.allowPlaceholders !== true) {
    throw new ConfigError(
      `The legal entity is still "${PLACEHOLDER_LEGAL_ENTITY}". A production build refuses to ` +
        `start on the placeholder, and the terms and privacy pages name it. Give the registered ` +
        `company or sole-trader name, or re-run with --allow-placeholders to defer it.`,
    );
  }

  const source = renderSiteConfig(a);
  const path = join(opts.targetDir, SITE_CONFIG_PATH);

  if (opts.dryRun === true) return { path, source, written: false };

  if (existsSync(path) && opts.overwrite !== true) {
    throw new ConfigError(
      `${path} already exists. Re-run with --overwrite to replace it, after checking there is ` +
        `nothing in it you meant to keep.`,
    );
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, "utf8");
  return { path, source, written: true };
}

import {
  FEATURE_FLAGS,
  type CustomFieldType,
  type FeatureFlag,
  type FontFamily,
  type SiteMode,
  type TierName,
} from "@/config/types";
import {
  COUNTRY_PROFILES,
  SUPPORTED_COUNTRIES,
  isSupportedCountry,
  type CountryProfile,
  type SupportedCountry,
} from "@/lib/geo/countries";

/**
 * The clone wizard's question schema.
 *
 * One list, in the order a human is asked. Everything the wizard writes —
 * config/site.config.ts, the seed CSVs, .env — is a pure function of the
 * answers, so a run is reproducible from an answers file and reviewable in a
 * diff. Nothing here knows what the directory is about: every example string
 * the wizard emits is built from the nouns the operator typed.
 */

/**
 * Re-exported, not redeclared: `config/types.ts` owns the union, because that
 * is what `SiteConfig["theme"]` is typed with. A wizard that offered a family
 * the config type does not accept would write a config that does not compile.
 */
export type { FontFamily };

export const FONT_FAMILIES: readonly FontFamily[] = [
  "Fraunces",
  "Inter",
  "Playfair Display",
  "Source Sans 3",
  "DM Sans",
  "Lora",
];

/**
 * Offered as a shortlist; anything else on schema.org is accepted as free text,
 * which is also why no type naming the current niche appears here — the
 * banned-string scanner is derived from that niche and would reject it.
 */
export const SCHEMA_LISTING_TYPES: readonly string[] = [
  "LocalBusiness",
  "Organization",
  "ProfessionalService",
  "HomeAndConstructionBusiness",
  "HealthAndBeautyBusiness",
  "AutomotiveBusiness",
  "FoodEstablishment",
  "LodgingBusiness",
  "Store",
  "SportsActivityLocation",
  "EntertainmentBusiness",
  "TouristAttraction",
  "EducationalOrganization",
];

export const ORGANIZATION_TYPES: readonly string[] = [
  "Organization",
  "LocalBusiness",
  "Corporation",
];

/**
 * The zone pins the daily listing shuffle, so it has to be a real IANA zone and
 * not the server's. Belongs in the country profile once `lib/geo/countries.ts`
 * grows a timezone field; kept here so this task does not edit that file.
 */
export const DEFAULT_TIMEZONE: Record<SupportedCountry, string> = {
  GB: "Europe/London",
  US: "America/New_York",
  AU: "Australia/Sydney",
  CA: "America/Toronto",
};

/** One line each, printed beside the prompt. A flag nobody can explain is a flag nobody should turn on. */
export const FEATURE_FLAG_DESCRIPTIONS: Record<FeatureFlag, string> = {
  reviews: "Public ratings and written reviews, with owner replies.",
  shortlist: "Visitors save entries to a shortlist and compare them side by side.",
  quoteBroadcast: "One enquiry form sends the same brief to every shortlisted owner. Needs shortlist. NOT BUILT YET: the flag is reserved and changes nothing today.",
  contentHub: "Editorial blog and guide pages served from content/blog.",
  footerLinkMatrix: "City x category link grid in the footer, capped by seo.footerCitiesPerCategory.",
  claimOutreach: "Email campaign inviting owners of unclaimed entries to claim them.",
  costGuides: "Price guide pages built from the currency and price-from fields. NOT BUILT YET: the flag is reserved and changes nothing today.",
  jobBoard: "A jobs section owners can post vacancies to. NOT BUILT YET: the flag is reserved and changes nothing today.",
  awards: "Annual awards computed from review volume and score. Needs reviews. NOT BUILT YET: the flag is reserved and changes nothing today.",
  affiliates: "Tracked outbound partner links and an affiliate disclosure block. NOT BUILT YET: the flag is reserved and changes nothing today.",
  utilityTool: "A niche calculator or planner tool on its own route. NOT BUILT YET: the flag is reserved and changes nothing today.",
  storefrontExtras: "Rich profile blocks: packages, FAQ, team and gallery albums.",
  events: "Dated events attached to an entry, with event markup.",
  bookings: "Availability calendar and booking requests handled on site.",
  multiLocale: "Serve more than one locale from the same deployment.",
  leadMarketplace: "Pay-per-lead: owners buy prepaid credit through PayPal and spend it on verified quote requests. Needs quoteBroadcast.",
};

export type SeedSource = "csv" | "template" | "skip";

export interface CustomFieldAnswer {
  readonly key: string;
  readonly label: string;
  readonly type: CustomFieldType;
  readonly options?: readonly string[];
  readonly searchable?: boolean;
  readonly showInCard?: boolean;
  readonly tier?: TierName;
}

export interface ReviewCriterionAnswer {
  readonly key: string;
  readonly label: string;
}

type FeatureAnswers = { readonly [K in FeatureFlag as `feature_${K}`]: boolean };

export interface Answers extends FeatureAnswers {
  readonly name: string;
  readonly shortName: string;
  readonly domain: string;
  readonly tagline: string;
  readonly legalEntity: string;
  readonly supportEmail: string;

  readonly entitySingular: string;
  readonly entityPlural: string;
  readonly entitySingularCapitalised: string;
  readonly entityPluralCapitalised: string;
  readonly entityVerb: string;
  readonly entityOwnerNoun: string;

  readonly country: string;
  readonly locale: string;
  readonly currency: string;
  readonly timezone: string;
  readonly regionLabel: string;

  readonly siteMode: SiteMode;
  readonly schemaListingType: string;
  readonly schemaOrganizationType: string;
  readonly schemaPriceRangeEnabled: boolean;

  readonly themePrimary: string;
  readonly themeAccent: string;
  readonly fontHeading: FontFamily;
  readonly fontBody: FontFamily;
  readonly themeRadius: string;

  readonly maxDescriptionChars: number;
  readonly customFields: readonly CustomFieldAnswer[];
  readonly reviewCriteria: readonly ReviewCriterionAnswer[];

  readonly essentialPriceMonthly: number;
  readonly essentialPriceAnnual: number;
  readonly premiumPriceMonthly: number;
  readonly premiumPriceAnnual: number;
  readonly trialDays: number;
  readonly freeMaxImages: number | null;
  readonly essentialMaxImages: number | null;
  readonly premiumMaxImages: number | null;

  readonly seoMinListingsToIndex: number;
  readonly seoRequireIntroCopyToIndex: boolean;
  readonly seoFooterCitiesPerCategory: number;
  readonly adsEnabled: boolean;

  readonly niche: string;
  readonly seedSource: SeedSource;
  readonly seedCitiesCsv: string;
  readonly seedCategoriesCsv: string;
  readonly seedListingsCsv: string;
}

export type PartialAnswers = Partial<Answers>;
export type AnswerValue = Answers[keyof Answers];

export type QuestionType = "text" | "choice" | "number" | "boolean" | "list" | "colour";

type Defaulted<T> = T | ((answers: PartialAnswers) => T);
type ItemOf<T> = T extends readonly (infer U)[] ? U : never;

interface QuestionBase<K extends keyof Answers> {
  readonly key: K;
  readonly prompt: string;
  /** Printed under the prompt. Explains the consequence, not the syntax. */
  readonly help?: string;
  readonly default: Defaulted<Answers[K]>;
  /** Returns a human-readable problem, or null when the value is fine. */
  readonly validate?: (value: Answers[K], answers: PartialAnswers) => string | null;
  /** Skipped entirely when this returns false — the key is then not an answer at all. */
  readonly when?: (answers: PartialAnswers) => boolean;
}

type QuestionFor<K extends keyof Answers> =
  | (QuestionBase<K> & { readonly type: "text" })
  | (QuestionBase<K> & { readonly type: "colour" })
  | (QuestionBase<K> & { readonly type: "boolean" })
  | (QuestionBase<K> & { readonly type: "number"; readonly nullable?: boolean })
  | (QuestionBase<K> & {
      readonly type: "choice";
      readonly choices: readonly string[];
      readonly allowOther?: boolean;
    })
  | (QuestionBase<K> & {
      readonly type: "list";
      readonly itemHint: string;
      readonly parseItem: (line: string) => ItemOf<Answers[K]>;
    });

export type Question = { [K in keyof Answers]: QuestionFor<K> }[keyof Answers];

// --- helpers -----------------------------------------------------------------

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function capitalise(value: string): string {
  return value.replace(/(^|\s)([a-z])/g, (_m, lead: string, ch: string) => lead + ch.toUpperCase());
}

function profileFor(answers: PartialAnswers): CountryProfile {
  const code = answers.country;
  return code !== undefined && isSupportedCountry(code) ? COUNTRY_PROFILES[code] : COUNTRY_PROFILES.GB;
}

/** The rule the pricing page's "save two months" claim rests on. */
export function annualFromMonthly(monthly: number): number {
  return Math.round(monthly * 10 * 100) / 100;
}

function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();
  return letters.slice(0, 4);
}

function nonEmpty(label: string) {
  return (value: string): string | null => (value.trim().length > 0 ? null : `${label} is required`);
}

const LOWER_NOUN = /^[a-z][a-z0-9 '-]*$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Custom field and review criterion keys become column keys and query params. */
const FIELD_KEY = /^[a-z][a-z0-9_]*$/;
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function lowerNoun(label: string) {
  return (value: string): string | null => {
    if (value.trim().length === 0) return `${label} is required`;
    return LOWER_NOUN.test(value)
      ? null
      : `${label} must be lower case — the UI capitalises it where it needs to`;
  };
}

function wholeNumber(label: string, min: number) {
  return (value: number | null): string | null => {
    if (value === null) return null;
    if (!Number.isFinite(value)) return `${label} must be a number`;
    if (!Number.isInteger(value)) return `${label} must be a whole number`;
    return value >= min ? null : `${label} must be ${min} or more`;
  };
}

function money(label: string) {
  return (value: number): string | null => {
    if (!Number.isFinite(value)) return `${label} must be a number`;
    if (value < 0) return `${label} must be 0 or more`;
    return Math.round(value * 100) === value * 100 ? null : `${label} must be a whole number of pence/cents`;
  };
}

const CUSTOM_FIELD_TYPES: readonly CustomFieldType[] = [
  "number",
  "boolean",
  "text",
  "select",
  "currency",
];
const TIER_NAMES: readonly TierName[] = ["free", "essential", "premium"];

function parseCustomField(line: string): CustomFieldAnswer {
  const [key = "", label = "", type = "text", ...flags] = line.split("|").map((p) => p.trim());
  const options = flags
    .filter((f) => f.startsWith("options="))
    .flatMap((f) => f.slice("options=".length).split(";").map((o) => o.trim()))
    .filter((o) => o.length > 0);
  const tier = TIER_NAMES.find((t) => flags.includes(t));
  return {
    key,
    label,
    type: (CUSTOM_FIELD_TYPES.find((t) => t === type) ?? type) as CustomFieldType,
    ...(options.length > 0 ? { options } : {}),
    ...(flags.includes("searchable") ? { searchable: true } : {}),
    ...(flags.includes("showInCard") ? { showInCard: true } : {}),
    ...(tier ? { tier } : {}),
  };
}

function validateCustomFields(fields: readonly CustomFieldAnswer[]): string | null {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const f of fields) {
    const where = f.key || "(blank key)";
    if (!FIELD_KEY.test(f.key)) problems.push(`"${where}" is not a valid field key (lower case, digits, underscores)`);
    if (seen.has(f.key)) problems.push(`"${where}" is listed twice`);
    seen.add(f.key);
    if (f.label.trim().length === 0) problems.push(`"${where}" has no label`);
    if (!CUSTOM_FIELD_TYPES.includes(f.type)) {
      problems.push(`"${where}" has unknown type "${f.type}" (one of ${CUSTOM_FIELD_TYPES.join(", ")})`);
    }
    if (f.type === "select" && (f.options === undefined || f.options.length === 0)) {
      problems.push(`"${where}" is a select with no options=`);
    }
    if (f.tier !== undefined && !TIER_NAMES.includes(f.tier)) {
      problems.push(`"${where}" has unknown tier "${f.tier}"`);
    }
  }
  return problems.length > 0 ? problems.join("; ") : null;
}

function parseReviewCriterion(line: string): ReviewCriterionAnswer {
  const [key = "", label = ""] = line.split("|").map((p) => p.trim());
  return { key: key || slugify(label), label: label || key };
}

function validateReviewCriteria(criteria: readonly ReviewCriterionAnswer[]): string | null {
  const problems: string[] = [];
  for (const c of criteria) {
    if (!FIELD_KEY.test(c.key)) problems.push(`"${c.key || "(blank)"}" is not a valid key`);
    if (c.label.trim().length === 0) problems.push(`"${c.key}" has no label`);
  }
  return problems.length > 0 ? problems.join("; ") : null;
}

// --- the questions -----------------------------------------------------------

const flagQuestions: readonly Question[] = FEATURE_FLAGS.map((flag) => {
  const on = ["reviews", "shortlist", "contentHub", "footerLinkMatrix", "claimOutreach"].includes(flag);
  const q: QuestionFor<`feature_${FeatureFlag}`> = {
    key: `feature_${flag}`,
    type: "boolean",
    prompt: `Enable ${flag}?`,
    help: FEATURE_FLAG_DESCRIPTIONS[flag],
    default: on,
  };
  return q;
});

export const QUESTIONS: readonly Question[] = [
  // --- identity ---
  {
    key: "name",
    type: "text",
    prompt: "Site name",
    help: "Shown in the header, the title tag and every email footer.",
    default: "",
    validate: nonEmpty("Site name"),
  },
  {
    key: "shortName",
    type: "text",
    prompt: "Short name",
    help: "Used where the full name will not fit — the mobile header and the PWA manifest.",
    default: (a) => initials(a.name ?? ""),
    validate: nonEmpty("Short name"),
  },
  {
    key: "domain",
    type: "text",
    prompt: "Domain",
    help: "Bare hostname. The wizard derives NEXT_PUBLIC_SITE_URL and every canonical from it.",
    default: "",
    validate: (v) =>
      HOSTNAME.test(v.trim().toLowerCase())
        ? null
        : "must be a bare hostname such as example.com — no scheme, no path",
  },
  {
    key: "legalEntity",
    type: "text",
    prompt: "Legal entity",
    help:
      "The company or sole trader that owns the site, exactly as registered. It appears on the " +
      "terms, the privacy notice and the invoices, and a production build refuses to start on TBC.",
    default: "TBC",
    validate: nonEmpty("Legal entity"),
  },
  {
    key: "supportEmail",
    type: "text",
    prompt: "Support email",
    default: (a) => (a.domain ? `hello@${a.domain}` : ""),
    validate: (v) => (EMAIL.test(v.trim()) ? null : "must be an email address"),
  },

  // --- the nouns every component reads ---
  {
    key: "entitySingular",
    type: "text",
    prompt: "One listed thing is a…",
    help: "Lower case. Every noun in the UI is derived from this — nothing is hardcoded in a component.",
    default: "",
    validate: lowerNoun("Singular noun"),
  },
  {
    key: "entityPlural",
    type: "text",
    prompt: "Many of them are…",
    default: (a) => (a.entitySingular ? `${a.entitySingular}s` : ""),
    validate: lowerNoun("Plural noun"),
  },
  {
    key: "entitySingularCapitalised",
    type: "text",
    prompt: "Capitalised singular",
    default: (a) => capitalise(a.entitySingular ?? ""),
    validate: nonEmpty("Capitalised singular"),
  },
  {
    key: "entityPluralCapitalised",
    type: "text",
    prompt: "Capitalised plural",
    default: (a) => capitalise(a.entityPlural ?? ""),
    validate: nonEmpty("Capitalised plural"),
  },
  {
    key: "entityVerb",
    type: "text",
    prompt: "What an owner does on the site",
    help: 'Fills "… your business free" in the calls to action.',
    default: "list",
    validate: lowerNoun("Verb"),
  },
  {
    key: "entityOwnerNoun",
    type: "text",
    prompt: "What you call the person who owns one",
    default: (a) => (a.entitySingular ? `${a.entitySingular} owner` : "owner"),
    validate: lowerNoun("Owner noun"),
  },

  // Asked after the nouns, because its default is built from them.
  {
    key: "tagline",
    type: "text",
    prompt: "Tagline",
    default: (a) => (a.entityPlural === undefined ? "" : `Find ${a.entityPlural} near you`),
    validate: nonEmpty("Tagline"),
  },

  // --- market ---
  {
    key: "country",
    type: "choice",
    prompt: "Country",
    help: "Sets the address format, the postcode rule, the phone prefix and the spelling.",
    choices: [...SUPPORTED_COUNTRIES],
    default: "GB",
    validate: (v) =>
      isSupportedCountry(v)
        ? null
        : `unsupported country "${v}" — add a profile in lib/geo/countries.ts first`,
  },
  {
    key: "locale",
    type: "text",
    prompt: "Locale",
    default: (a) => profileFor(a).defaultLocale,
    validate: (v, a) =>
      a.country === undefined || v.endsWith(a.country)
        ? null
        : `locale "${v}" does not match country "${a.country}"`,
  },
  {
    key: "currency",
    type: "text",
    prompt: "Currency",
    default: (a) => profileFor(a).defaultCurrency,
    validate: (v) => (/^[A-Z]{3}$/.test(v) ? null : "must be a three-letter ISO currency code"),
  },
  {
    key: "timezone",
    type: "text",
    prompt: "Timezone",
    help: "IANA zone. Pins the daily shuffle so ordering cannot flip on the server's local midnight.",
    default: (a) => DEFAULT_TIMEZONE[profileFor(a).code],
    validate: (v) => (/^[A-Za-z]+\/[A-Za-z_+-]+$/.test(v) ? null : "must be an IANA zone such as Europe/London"),
  },
  {
    key: "regionLabel",
    type: "text",
    prompt: "What you call a region",
    help: "Disambiguation and markup only. It never appears in a URL.",
    default: (a) => profileFor(a).regionLabel,
    validate: lowerNoun("Region label"),
  },
  {
    key: "siteMode",
    type: "choice",
    prompt: "Site shape",
    help:
      "niche-national: one kind of thing, many towns — /[city] is the pillar. " +
      "local-multi-vertical: one town, many kinds of business — /[vertical] is the pillar. " +
      "NOT BUILT YET: only niche-national has pages today.",
    choices: ["niche-national", "local-multi-vertical"],
    default: "niche-national",
  },

  // --- markup ---
  {
    key: "schemaListingType",
    type: "choice",
    prompt: "schema.org type for one listing",
    help: "Pick the narrowest type that is actually true. Anything on schema.org is accepted.",
    choices: SCHEMA_LISTING_TYPES,
    allowOther: true,
    default: "LocalBusiness",
    validate: (v) => (/^[A-Z][A-Za-z]+$/.test(v) ? null : "must be a schema.org type name"),
  },
  {
    key: "schemaOrganizationType",
    type: "choice",
    prompt: "schema.org type for the site itself",
    choices: ORGANIZATION_TYPES,
    allowOther: true,
    default: "Organization",
    validate: (v) => (/^[A-Z][A-Za-z]+$/.test(v) ? null : "must be a schema.org type name"),
  },
  {
    key: "schemaPriceRangeEnabled",
    type: "boolean",
    prompt: "Emit priceRange in the markup?",
    help: "Only turn this on if a price is actually rendered on the page.",
    default: true,
  },

  // --- theme ---
  {
    key: "themePrimary",
    type: "colour",
    prompt: "Primary colour",
    default: "#1F3A5F",
    validate: (v) => (HEX.test(v) ? null : "must be a hex colour such as #1F3A5F"),
  },
  {
    key: "themeAccent",
    type: "colour",
    prompt: "Accent colour",
    default: "#C2703D",
    validate: (v) => (HEX.test(v) ? null : "must be a hex colour such as #C2703D"),
  },
  {
    key: "fontHeading",
    type: "choice",
    prompt: "Heading font",
    choices: FONT_FAMILIES,
    default: "Fraunces",
  },
  {
    key: "fontBody",
    type: "choice",
    prompt: "Body font",
    choices: FONT_FAMILIES,
    default: "Inter",
  },
  {
    key: "themeRadius",
    type: "text",
    prompt: "Corner radius",
    default: "0.75rem",
    validate: (v) => (/^\d+(\.\d+)?(rem|px|em)$/.test(v) ? null : "must be a CSS length such as 0.75rem"),
  },

  // --- listing shape ---
  {
    key: "maxDescriptionChars",
    type: "number",
    prompt: "Longest description an owner may write",
    help: "The input cap, the same for every tier. What is displayed is governed by the tier.",
    default: 2500,
    validate: wholeNumber("Description cap", 200),
  },
  {
    key: "customFields",
    type: "list",
    prompt: "Custom fields",
    itemHint: "key|Label|type[|searchable][|showInCard][|options=a;b][|free|essential|premium]",
    help: "One per line, blank line to finish. Types: number, boolean, text, select, currency.",
    default: [],
    parseItem: parseCustomField,
    validate: validateCustomFields,
  },
  {
    key: "reviewCriteria",
    type: "list",
    prompt: "Review criteria",
    itemHint: "key|Label",
    help: "What a reviewer scores. Leave the default unless the niche needs its own axes.",
    default: [
      { key: "value", label: "Value for money" },
      { key: "service", label: "Service" },
      { key: "quality", label: "Quality" },
    ],
    parseItem: parseReviewCriterion,
    validate: validateReviewCriteria,
  },

  // --- pricing ---
  {
    key: "essentialPriceMonthly",
    type: "number",
    prompt: "Essential — price per month",
    default: 9.9,
    validate: money("Monthly price"),
  },
  {
    key: "essentialPriceAnnual",
    type: "number",
    prompt: "Essential — price per year",
    help: "Ten times the monthly price makes \"save two months\" literally true. Change it and the copy lies.",
    default: (a) => annualFromMonthly(a.essentialPriceMonthly ?? 0),
    validate: money("Annual price"),
  },
  {
    key: "premiumPriceMonthly",
    type: "number",
    prompt: "Premium — price per month",
    default: 24.9,
    validate: money("Monthly price"),
  },
  {
    key: "premiumPriceAnnual",
    type: "number",
    prompt: "Premium — price per year",
    default: (a) => annualFromMonthly(a.premiumPriceMonthly ?? 0),
    validate: money("Annual price"),
  },
  {
    key: "trialDays",
    type: "number",
    prompt: "Free trial length in days",
    default: 30,
    validate: wholeNumber("Trial length", 0),
  },
  {
    key: "freeMaxImages",
    type: "number",
    nullable: true,
    prompt: "Free — image cap",
    help: "A number, or \"unlimited\".",
    default: 3,
    validate: wholeNumber("Image cap", 0),
  },
  {
    key: "essentialMaxImages",
    type: "number",
    nullable: true,
    prompt: "Essential — image cap",
    default: 10,
    validate: wholeNumber("Image cap", 0),
  },
  {
    key: "premiumMaxImages",
    type: "number",
    nullable: true,
    prompt: "Premium — image cap",
    default: null,
    validate: wholeNumber("Image cap", 0),
  },

  // --- features ---
  ...flagQuestions,

  // --- seo ---
  {
    key: "seoMinListingsToIndex",
    type: "number",
    prompt: "Listings a town needs before its page may be indexed",
    help: "Thin town pages are how directories sink their own domain. Below this the page is noindex.",
    default: 3,
    validate: wholeNumber("Indexing threshold", 0),
  },
  {
    key: "seoRequireIntroCopyToIndex",
    type: "boolean",
    prompt: "Also require written intro copy before indexing a town?",
    default: true,
  },
  {
    key: "seoFooterCitiesPerCategory",
    type: "number",
    prompt: "Towns per category in the footer link grid",
    default: 18,
    validate: wholeNumber("Footer cap", 0),
  },

  // --- seed data ---
  {
    key: "adsEnabled",
    type: "boolean",
    prompt: "Show sponsor rails on unpaid pages?",
    help:
      "House ads and self-serve sponsors on pillar, search, blog and unpaid listing pages. " +
      "Never an ad network. Off until the site has traffic worth selling.",
    default: false,
  },
  {
    key: "niche",
    type: "text",
    prompt: "Seed directory name",
    help: "seeds/<name>/ holds the three CSVs, and `pnpm seed <name>` loads them.",
    default: (a) => slugify(a.entityPlural ?? ""),
    validate: (v) => (SLUG.test(v) ? null : "must be a lower-case slug such as my-directory"),
  },
  {
    key: "seedSource",
    type: "choice",
    prompt: "Where does the starting data come from?",
    help: "csv: files you already have. template: three example rows to edit. skip: nothing.",
    choices: ["csv", "template", "skip"],
    default: "template",
  },
  {
    key: "seedCitiesCsv",
    type: "text",
    prompt: "Path to your cities CSV",
    default: "",
    when: (a) => a.seedSource === "csv",
    validate: nonEmpty("Cities CSV path"),
  },
  {
    key: "seedCategoriesCsv",
    type: "text",
    prompt: "Path to your categories CSV",
    default: "",
    when: (a) => a.seedSource === "csv",
    validate: nonEmpty("Categories CSV path"),
  },
  {
    key: "seedListingsCsv",
    type: "text",
    prompt: "Path to your listings CSV",
    default: "",
    when: (a) => a.seedSource === "csv",
    validate: nonEmpty("Listings CSV path"),
  },
];

// --- driving the schema ------------------------------------------------------

export function isAsked(question: Question, answers: PartialAnswers): boolean {
  return question.when === undefined || question.when(answers);
}

export function resolveDefault(question: Question, answers: PartialAnswers): AnswerValue {
  const d: Defaulted<AnswerValue> = question.default;
  return typeof d === "function" ? d(answers) : d;
}

export function runValidate(
  question: Question,
  value: unknown,
  answers: PartialAnswers,
): string | null {
  const fn = question.validate as
    | ((v: unknown, a: PartialAnswers) => string | null)
    | undefined;
  return fn === undefined ? null : fn(value, answers);
}

const TRUTHY = new Set(["y", "yes", "true", "1", "on"]);
const FALSY = new Set(["n", "no", "false", "0", "off", ""]);

/** Turns one line of typed text into the answer's real type. */
export function coerceRaw(question: Question, raw: string): unknown {
  const text = raw.trim();
  switch (question.type) {
    case "boolean": {
      const lower = text.toLowerCase();
      if (TRUTHY.has(lower)) return true;
      if (FALSY.has(lower)) return false;
      return text;
    }
    case "number": {
      if (question.nullable === true && ["", "unlimited", "none", "null"].includes(text.toLowerCase())) {
        return null;
      }
      return Number(text);
    }
    case "list":
      return text.length === 0 ? [] : [question.parseItem(text)];
    default:
      return text;
  }
}

function setAnswer(answers: PartialAnswers, key: keyof Answers, value: unknown): void {
  (answers as Record<string, unknown>)[key] = value;
}

/**
 * Structural guard for the kinds whose coerced (or JSON-supplied) value can
 * silently take on the wrong shape and still serialise into `site.config.ts`
 * without error — an unrecognised boolean answer falls through `coerceRaw` as
 * its own raw text, a non-numeric string becomes `NaN`, and a value supplied
 * straight from a JSON answers file skips `coerceRaw` entirely. `choice` has
 * its own inline guard in `buildAnswers`; `text` questions are satisfied by
 * whatever `coerceRaw`'s default branch or a JSON string produces, so there
 * is no shape to police there.
 */
export function answerTypeError(question: Question, value: unknown): string | null {
  switch (question.type) {
    case "boolean":
      return typeof value === "boolean"
        ? null
        : `must be a yes/no answer (y, n, true, false, 1, 0) — got ${JSON.stringify(value)}`;
    case "number": {
      if (question.nullable === true && value === null) return null;
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : `must be a number — got ${JSON.stringify(value)}`;
    }
    case "colour":
      return typeof value === "string"
        ? null
        : `must be a colour string — got ${JSON.stringify(value)}`;
    case "list":
      return Array.isArray(value) ? null : `must be a list — got ${JSON.stringify(value)}`;
    default:
      return null;
  }
}

export type BuildResult = { readonly answers: Answers } | { readonly errors: readonly string[] };

/**
 * Walks the schema in order, filling each unanswered question from its default,
 * and reports every problem rather than the first — an operator fixing an
 * answers file one error per run gives up before the third one.
 */
export function buildAnswers(supplied: Readonly<Record<string, unknown>>): BuildResult {
  const errors: string[] = [];
  const known = new Set<string>(QUESTIONS.map((q) => q.key));
  for (const key of Object.keys(supplied)) {
    if (!known.has(key)) errors.push(`${key}: not a question the wizard asks — check the spelling`);
  }

  const acc: PartialAnswers = {};
  for (const question of QUESTIONS) {
    const key: string = question.key;
    const wasSupplied = Object.prototype.hasOwnProperty.call(supplied, key);

    if (!isAsked(question, acc)) {
      if (wasSupplied) errors.push(`${key}: answered, but that question is not asked for these answers`);
      continue;
    }

    let value: unknown;
    if (wasSupplied) {
      const raw = supplied[key];
      value = typeof raw === "string" ? coerceRaw(question, raw) : raw;
    } else {
      value = resolveDefault(question, acc);
    }

    if (question.type === "choice" && question.allowOther !== true) {
      if (typeof value !== "string" || !question.choices.includes(value)) {
        errors.push(`${key}: must be one of ${question.choices.join(", ")}`);
        continue;
      }
    }

    const typeProblem = answerTypeError(question, value);
    if (typeProblem !== null) {
      errors.push(`${key}: ${typeProblem}`);
      continue;
    }

    const problem = runValidate(question, value, acc);
    if (problem !== null) {
      errors.push(`${key}: ${problem}`);
      continue;
    }
    setAnswer(acc, question.key, value);
  }

  return errors.length > 0 ? { errors } : { answers: acc as Answers };
}

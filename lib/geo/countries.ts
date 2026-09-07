/**
 * Per-country differences, in one place.
 *
 * These directories run in the UK and the US, and possibly AU and CA. Every
 * difference between them that reaches the UI or validation lives here — a
 * clone sets `country` in site.config.ts and the rest follows. Nothing
 * downstream should branch on a country code directly.
 */
export interface CountryProfile {
  readonly code: SupportedCountry;
  readonly name: string;
  /** "county" in the UK, "state" in the US. Schema and disambiguation only — never a URL. */
  readonly regionLabel: string;
  readonly regionLabelPlural: string;
  readonly postcodeLabel: string;
  readonly postcodePattern: RegExp;
  readonly postcodeExample: string;
  readonly phoneCountryCode: string;
  /** Reserved-for-fiction numbers. Seed and demo data must use these. */
  readonly reservedPhoneExample: string;
  readonly addressFormat: "uk" | "us";
  readonly spelling: "en-GB" | "en-US";
  readonly defaultCurrency: string;
  readonly defaultLocale: string;
}

export const SUPPORTED_COUNTRIES = ["GB", "US", "AU", "CA"] as const;
export type SupportedCountry = (typeof SUPPORTED_COUNTRIES)[number];

export const COUNTRY_PROFILES: Record<SupportedCountry, CountryProfile> = {
  GB: {
    code: "GB",
    name: "United Kingdom",
    regionLabel: "county",
    regionLabelPlural: "counties",
    postcodeLabel: "postcode",
    // Covers mainland plus the Crown Dependencies (GY, JE, IM).
    postcodePattern: /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i,
    postcodeExample: "LS1 4DY",
    phoneCountryCode: "+44",
    reservedPhoneExample: "01632 960000",
    addressFormat: "uk",
    spelling: "en-GB",
    defaultCurrency: "GBP",
    defaultLocale: "en-GB",
  },
  US: {
    code: "US",
    name: "United States",
    regionLabel: "state",
    regionLabelPlural: "states",
    postcodeLabel: "ZIP code",
    postcodePattern: /^\d{5}(-\d{4})?$/,
    postcodeExample: "90210",
    phoneCountryCode: "+1",
    reservedPhoneExample: "(555) 010-0000",
    addressFormat: "us",
    spelling: "en-US",
    defaultCurrency: "USD",
    defaultLocale: "en-US",
  },
  AU: {
    code: "AU",
    name: "Australia",
    regionLabel: "state",
    regionLabelPlural: "states",
    postcodeLabel: "postcode",
    postcodePattern: /^\d{4}$/,
    postcodeExample: "2000",
    phoneCountryCode: "+61",
    reservedPhoneExample: "(02) 5550 0000",
    addressFormat: "us",
    spelling: "en-GB",
    defaultCurrency: "AUD",
    defaultLocale: "en-AU",
  },
  CA: {
    code: "CA",
    name: "Canada",
    regionLabel: "province",
    regionLabelPlural: "provinces",
    postcodeLabel: "postal code",
    postcodePattern: /^[A-Z]\d[A-Z]\s*\d[A-Z]\d$/i,
    postcodeExample: "K1A 0B1",
    phoneCountryCode: "+1",
    reservedPhoneExample: "(555) 010-0000",
    addressFormat: "us",
    spelling: "en-US",
    defaultCurrency: "CAD",
    defaultLocale: "en-CA",
  },
};

export function isSupportedCountry(code: string): code is SupportedCountry {
  return (SUPPORTED_COUNTRIES as readonly string[]).includes(code);
}

export function countryProfile(code: string): CountryProfile {
  if (!isSupportedCountry(code)) {
    throw new Error(
      `Unsupported country "${code}". Supported: ${SUPPORTED_COUNTRIES.join(", ")}. ` +
        `Add a profile in lib/geo/countries.ts before cloning into a new market.`,
    );
  }
  return COUNTRY_PROFILES[code];
}

export function validatePostcode(code: string, value: string): boolean {
  return countryProfile(code).postcodePattern.test(value.trim());
}

/**
 * Case- and space-insensitive form used for suppression and duplicate matching.
 * "LS1 1AA" and "ls11aa" must be the same key, or a removal request can be
 * defeated by retyping the postcode.
 */
export function normalisePostcode(value: string): string {
  return value.replace(/[\s-]+/g, "").toLowerCase();
}

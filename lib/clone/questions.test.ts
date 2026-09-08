import { describe, it, expect } from "vitest";
import {
  QUESTIONS,
  FONT_FAMILIES,
  FEATURE_FLAG_DESCRIPTIONS,
  SCHEMA_LISTING_TYPES,
  DEFAULT_TIMEZONE,
  resolveDefault,
  coerceRaw,
  runValidate,
  isAsked,
  buildAnswers,
  type PartialAnswers,
} from "./questions";
import { FEATURE_FLAGS } from "@/config/types";
import { SUPPORTED_COUNTRIES } from "@/lib/geo/countries";

function question(key: string) {
  const q = QUESTIONS.find((candidate) => candidate.key === key);
  if (!q) throw new Error(`no question for key "${key}"`);
  return q;
}

describe("QUESTIONS", () => {
  it("has a unique key, a prompt and a default for every question", () => {
    const keys = QUESTIONS.map((q) => q.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const q of QUESTIONS) {
      expect(q.prompt.length).toBeGreaterThan(0);
      expect(q.default).toBeDefined();
    }
  });

  it("covers the identity, entity, country, theme, tier and seo groups", () => {
    const keys = new Set<string>(QUESTIONS.map((q) => q.key));
    for (const k of [
      "name", "shortName", "domain", "tagline", "legalEntity", "supportEmail",
      "entitySingular", "entityPlural", "entitySingularCapitalised",
      "entityPluralCapitalised", "entityVerb", "entityOwnerNoun",
      "country", "locale", "currency", "timezone", "regionLabel",
      "siteMode", "schemaListingType", "schemaOrganizationType",
      "themePrimary", "themeAccent", "fontHeading", "fontBody", "themeRadius",
      "customFields", "reviewCriteria",
      "essentialPriceMonthly", "essentialPriceAnnual", "trialDays",
      "seoMinListingsToIndex", "seoFooterCitiesPerCategory",
      "niche", "seedSource",
    ]) {
      expect(keys.has(k)).toBe(true);
    }
  });

  it("asks one flag question per feature flag, each with a one-line description", () => {
    for (const flag of FEATURE_FLAGS) {
      const q = question(`feature_${flag}`);
      expect(q.type).toBe("boolean");
      const description = FEATURE_FLAG_DESCRIPTIONS[flag];
      expect(description.length).toBeGreaterThan(0);
      expect(description).not.toContain("\n");
    }
  });

  it("offers every supported country as a choice", () => {
    const q = question("country");
    if (q.type !== "choice") throw new Error("expected a choice question");
    expect(q.choices).toEqual([...SUPPORTED_COUNTRIES]);
    expect(q.allowOther).toBeFalsy();
  });

  it("offers common schema.org types but still allows a free-text type", () => {
    const q = question("schemaListingType");
    if (q.type !== "choice") throw new Error("expected a choice question");
    expect(q.choices).toEqual(SCHEMA_LISTING_TYPES);
    expect(q.allowOther).toBe(true);
  });

  it("restricts the fonts to the supported family list", () => {
    const q = question("fontHeading");
    if (q.type !== "choice") throw new Error("expected a choice question");
    expect(q.choices).toEqual(FONT_FAMILIES);
    expect(q.allowOther).toBeFalsy();
  });
});

describe("resolveDefault", () => {
  it("derives locale, currency, timezone and region label from the country profile", () => {
    const gb: PartialAnswers = { country: "GB" };
    expect(resolveDefault(question("locale"), gb)).toBe("en-GB");
    expect(resolveDefault(question("currency"), gb)).toBe("GBP");
    expect(resolveDefault(question("timezone"), gb)).toBe(DEFAULT_TIMEZONE.GB);
    expect(resolveDefault(question("regionLabel"), gb)).toBe("county");

    const us: PartialAnswers = { country: "US" };
    expect(resolveDefault(question("locale"), us)).toBe("en-US");
    expect(resolveDefault(question("currency"), us)).toBe("USD");
    expect(resolveDefault(question("regionLabel"), us)).toBe("state");
  });

  it("capitalises the entity nouns from the lower-case answers", () => {
    const a: PartialAnswers = { entitySingular: "studio", entityPlural: "studios" };
    expect(resolveDefault(question("entitySingularCapitalised"), a)).toBe("Studio");
    expect(resolveDefault(question("entityPluralCapitalised"), a)).toBe("Studios");
  });

  it("offers annual = 10 x monthly as the default annual price", () => {
    expect(resolveDefault(question("essentialPriceAnnual"), { essentialPriceMonthly: 9.9 })).toBe(99);
    expect(resolveDefault(question("premiumPriceAnnual"), { premiumPriceMonthly: 24.9 })).toBe(249);
  });

  it("derives the seed directory name from the plural entity noun", () => {
    expect(resolveDefault(question("niche"), { entityPlural: "recording studios" }))
      .toBe("recording-studios");
  });
});

describe("isAsked", () => {
  it("only asks for CSV paths when the seed data comes from CSV", () => {
    expect(isAsked(question("seedCitiesCsv"), { seedSource: "csv" })).toBe(true);
    expect(isAsked(question("seedCitiesCsv"), { seedSource: "template" })).toBe(false);
    expect(isAsked(question("seedCitiesCsv"), { seedSource: "skip" })).toBe(false);
  });

  it("asks unconditional questions regardless of earlier answers", () => {
    expect(isAsked(question("name"), {})).toBe(true);
  });
});

describe("coerceRaw", () => {
  it("parses numbers, booleans and colours from typed text", () => {
    expect(coerceRaw(question("trialDays"), "30")).toBe(30);
    expect(coerceRaw(question("feature_reviews"), "y")).toBe(true);
    expect(coerceRaw(question("feature_reviews"), "no")).toBe(false);
    expect(coerceRaw(question("themePrimary"), " #8B5A3C ")).toBe("#8B5A3C");
  });

  it("parses a repeatable custom field line into a structured field", () => {
    expect(coerceRaw(question("customFields"), "capacity|Capacity|number|searchable|showInCard"))
      .toEqual([
        { key: "capacity", label: "Capacity", type: "number", searchable: true, showInCard: true },
      ]);
  });

  it("parses a review criterion line", () => {
    expect(coerceRaw(question("reviewCriteria"), "value|Value for money"))
      .toEqual([{ key: "value", label: "Value for money" }]);
  });

  it("reads an unlimited image cap as null", () => {
    expect(coerceRaw(question("premiumMaxImages"), "unlimited")).toBeNull();
  });
});

describe("runValidate", () => {
  it("rejects a domain with a scheme or a path", () => {
    expect(runValidate(question("domain"), "https://example.com", {})).toMatch(/hostname/i);
    expect(runValidate(question("domain"), "example.com", {})).toBeNull();
  });

  it("rejects an email that is not an address", () => {
    expect(runValidate(question("supportEmail"), "nope", {})).toBeTruthy();
    expect(runValidate(question("supportEmail"), "hello@example.com", {})).toBeNull();
  });

  it("rejects a colour that is not a hex triple", () => {
    expect(runValidate(question("themePrimary"), "rebeccapurple", {})).toBeTruthy();
    expect(runValidate(question("themePrimary"), "#8B5A3C", {})).toBeNull();
  });

  it("rejects an entity noun that is capitalised where a lower-case noun belongs", () => {
    expect(runValidate(question("entitySingular"), "Studio", {})).toBeTruthy();
    expect(runValidate(question("entitySingular"), "studio", {})).toBeNull();
  });

  it("accepts a snake_case custom field key and rejects one with a space", () => {
    const ok = [{ key: "room_count", label: "Rooms", type: "number" }];
    const bad = [{ key: "room count", label: "Rooms", type: "number" }];
    expect(runValidate(question("customFields"), ok, {})).toBeNull();
    expect(runValidate(question("customFields"), bad, {})).toMatch(/field key/);
  });

  it("rejects a select custom field with no options", () => {
    const bad = [{ key: "size", label: "Size", type: "select" }];
    expect(runValidate(question("customFields"), bad, {})).toMatch(/no options/);
  });

  it("rejects a seed directory name that is not a slug", () => {
    expect(runValidate(question("niche"), "Recording Studios", {})).toBeTruthy();
    expect(runValidate(question("niche"), "recording-studios", {})).toBeNull();
  });

  it("rejects a negative price and a negative indexing threshold", () => {
    expect(runValidate(question("essentialPriceMonthly"), -1, {})).toBeTruthy();
    expect(runValidate(question("seoMinListingsToIndex"), -1, {})).toBeTruthy();
  });
});

describe("buildAnswers", () => {
  const supplied = {
    name: "Studio Finder",
    shortName: "SF",
    domain: "studiofinder.co.uk",
    tagline: "Find a room to record in",
    legalEntity: "Studio Finder Ltd",
    supportEmail: "hello@studiofinder.co.uk",
    entitySingular: "studio",
    entityPlural: "studios",
    entityVerb: "list",
    entityOwnerNoun: "studio owner",
    country: "GB",
    schemaListingType: "LocalBusiness",
  };

  it("fills every unanswered question from its default", () => {
    const result = buildAnswers(supplied);
    if ("errors" in result) throw new Error(result.errors.join("; "));
    expect(result.answers.locale).toBe("en-GB");
    expect(result.answers.currency).toBe("GBP");
    expect(result.answers.entitySingularCapitalised).toBe("Studio");
    expect(result.answers.regionLabel).toBe("county");
    expect(result.answers.niche).toBe("studios");
  });

  it("reports every validation failure rather than only the first", () => {
    const result = buildAnswers({ ...supplied, domain: "https://x.test", supportEmail: "nope" });
    if (!("errors" in result)) throw new Error("expected errors");
    expect(result.errors.length).toBe(2);
    expect(result.errors.join("\n")).toMatch(/domain/);
    expect(result.errors.join("\n")).toMatch(/supportEmail/);
  });

  it("rejects an unknown key so a typo in the answers file is not silently ignored", () => {
    const result = buildAnswers({ ...supplied, entitySingluar: "typo" });
    if (!("errors" in result)) throw new Error("expected errors");
    expect(result.errors.join("\n")).toMatch(/entitySingluar/);
  });

  it("rejects an answer for a question that was never asked", () => {
    const result = buildAnswers({ ...supplied, seedSource: "template", seedCitiesCsv: "/tmp/x.csv" });
    if (!("errors" in result)) throw new Error("expected errors");
    expect(result.errors.join("\n")).toMatch(/seedCitiesCsv/);
  });

  it("rejects an unsupported country before the config validators ever see it", () => {
    const result = buildAnswers({ ...supplied, country: "ZZ" });
    if (!("errors" in result)) throw new Error("expected errors");
    expect(result.errors.join("\n")).toMatch(/country/);
  });

  it("refuses an unrecognised boolean answer instead of writing it verbatim", () => {
    const result = buildAnswers({ ...supplied, feature_reviews: "maybe" });
    if (!("errors" in result)) throw new Error("expected errors");
    expect(result.errors.join("\n")).toMatch(/feature_reviews/);
    expect(result.errors.join("\n")).toMatch(/boolean|yes\/no/i);
  });

  it("refuses a number given where a boolean question expects one", () => {
    const result = buildAnswers({ ...supplied, schemaPriceRangeEnabled: 42 });
    if (!("errors" in result)) throw new Error("expected errors");
    expect(result.errors.join("\n")).toMatch(/schemaPriceRangeEnabled/);
  });

  it("refuses a non-numeric string on a number question", () => {
    const result = buildAnswers({ ...supplied, trialDays: "abc" });
    if (!("errors" in result)) throw new Error("expected errors");
    expect(result.errors.join("\n")).toMatch(/trialDays/);
  });

  it("refuses a boolean given where a number question expects a number", () => {
    const result = buildAnswers({ ...supplied, trialDays: true });
    if (!("errors" in result)) throw new Error("expected errors");
    expect(result.errors.join("\n")).toMatch(/trialDays/);
  });

  it("refuses a non-string value on a colour question", () => {
    const result = buildAnswers({ ...supplied, themePrimary: 42 });
    if (!("errors" in result)) throw new Error("expected errors");
    expect(result.errors.join("\n")).toMatch(/themePrimary/);
  });

  it("refuses a non-array value on a list question", () => {
    // A bare string is a valid one-line answer for a list question (coerceRaw
    // parses it as a single item) — the broken shape is anything that isn't a
    // string or an array, e.g. a JSON object or number.
    const result = buildAnswers({ ...supplied, customFields: 42 });
    if (!("errors" in result)) throw new Error("expected errors");
    expect(result.errors.join("\n")).toMatch(/customFields/);
  });
});

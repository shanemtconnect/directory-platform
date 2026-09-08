import { describe, it, expect } from "vitest";
import type { TierSpec, TierName } from "@/config/types";
import { siteConfig } from "@/config/site.config";
import {
  parseInterval,
  intervalPath,
  DEFAULT_INTERVAL,
  INTERVALS,
  priceFor,
  isFree,
  annualSaving,
  formatMoney,
  orderedTiers,
  comparisonRows,
  humanise,
  toCell,
  UNLIMITED,
} from "./pricing";

const base: TierSpec = {
  label: "Base",
  strapline: "s",
  bullets: [],
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
};

const tier = (over: Partial<TierSpec>): TierSpec => ({ ...base, ...over });

describe("parseInterval", () => {
  it("defaults to annual", () => {
    expect(parseInterval(undefined)).toBe("annual");
    expect(parseInterval("nonsense")).toBe("annual");
    expect(parseInterval("annual")).toBe("annual");
  });
  it("reads monthly", () => {
    expect(parseInterval("monthly")).toBe("monthly");
  });
  it("takes the first value of a repeated param", () => {
    expect(parseInterval(["monthly", "annual"])).toBe("monthly");
  });
});

describe("intervalPath", () => {
  it("gives the default interval the bare /pricing URL", () => {
    // The interval lives in the path, not a query string: reading searchParams
    // forces the route dynamic in Next 16 and drops it out of the ISR cache.
    expect(intervalPath(DEFAULT_INTERVAL)).toBe("/pricing");
    expect(DEFAULT_INTERVAL).toBe("annual");
  });

  it("gives every other interval its own path, with no query string", () => {
    expect(intervalPath("monthly")).toBe("/pricing/monthly");
    for (const i of INTERVALS) expect(intervalPath(i)).not.toContain("?");
  });
});

describe("priceFor", () => {
  it("picks the field matching the interval", () => {
    const t = tier({ priceAnnual: 99, priceMonthly: 9.9 });
    expect(priceFor(t, "annual")).toBe(99);
    expect(priceFor(t, "monthly")).toBe(9.9);
  });
});

describe("isFree", () => {
  it("is true only when both prices are zero", () => {
    expect(isFree(tier({}))).toBe(true);
    expect(isFree(tier({ priceMonthly: 9.9 }))).toBe(false);
  });
});

describe("annualSaving", () => {
  it("computes exactly two months when annual is ten times monthly", () => {
    const s = annualSaving(tier({ priceAnnual: 99, priceMonthly: 9.9 }));
    expect(s).not.toBeNull();
    expect(s?.months).toBe(2);
    expect(s?.amount).toBeCloseTo(19.8, 2);
  });

  it("does not drift on floats", () => {
    // 24.9 * 12 is 298.79999999999995 in binary floating point.
    const s = annualSaving(tier({ priceAnnual: 249, priceMonthly: 24.9 }));
    expect(s?.months).toBe(2);
    expect(s?.amount).toBeCloseTo(49.8, 2);
  });

  it("is null on a free plan", () => {
    expect(annualSaving(tier({}))).toBeNull();
  });

  it("is null when annual is not actually cheaper", () => {
    expect(annualSaving(tier({ priceAnnual: 120, priceMonthly: 10 }))).toBeNull();
    expect(annualSaving(tier({ priceAnnual: 130, priceMonthly: 10 }))).toBeNull();
  });

  it("reports a one-month saving when the clone prices it at eleven months", () => {
    expect(annualSaving(tier({ priceAnnual: 110, priceMonthly: 10 }))?.months).toBe(1);
  });

  it("matches the shipped config on every paid plan", () => {
    for (const [, spec] of orderedTiers(siteConfig.tiers)) {
      if (isFree(spec)) continue;
      expect(annualSaving(spec)?.months).toBe(2);
    }
  });
});

describe("formatMoney", () => {
  it("drops the decimals on a whole amount", () => {
    expect(formatMoney(99, "en-GB", "GBP")).toBe("£99");
  });
  it("keeps two decimals otherwise", () => {
    expect(formatMoney(9.9, "en-GB", "GBP")).toBe("£9.90");
  });
  it("follows the configured locale and currency", () => {
    expect(formatMoney(99, "de-DE", "EUR")).toContain("99");
    expect(formatMoney(99, "en-US", "USD")).toBe("$99");
  });
});

describe("orderedTiers", () => {
  it("sorts by rank, not by object key order", () => {
    const tiers = {
      premium: tier({ rank: 30 }),
      free: tier({ rank: 10 }),
      essential: tier({ rank: 20 }),
    } as { readonly [K in TierName]: TierSpec };
    expect(orderedTiers(tiers).map(([n]) => n)).toEqual(["free", "essential", "premium"]);
  });

  it("returns every configured plan", () => {
    expect(orderedTiers(siteConfig.tiers)).toHaveLength(Object.keys(siteConfig.tiers).length);
  });
});

describe("humanise", () => {
  it("splits camelCase into a sentence", () => {
    expect(humanise("allowGalleryAlbums")).toBe("Allow gallery albums");
    expect(humanise("excerpt")).toBe("Excerpt");
  });
});

describe("toCell", () => {
  it("passes booleans through as booleans", () => {
    expect(toCell(true)).toEqual({ kind: "bool", value: true });
  });
  it("renders null as unlimited", () => {
    expect(toCell(null)).toEqual({ kind: "text", text: UNLIMITED });
  });
  it("renders numbers and strings as text", () => {
    expect(toCell(10)).toEqual({ kind: "text", text: "10" });
    expect(toCell("full")).toEqual({ kind: "text", text: "Full" });
  });
});

describe("comparisonRows", () => {
  const rows = comparisonRows(siteConfig.tiers);

  it("omits the marketing and price keys", () => {
    const keys = rows.map((r) => r.key);
    for (const k of ["label", "strapline", "bullets", "rank", "priceAnnual", "priceMonthly", "trialDays"]) {
      expect(keys).not.toContain(k);
    }
  });

  it("covers every remaining capability key on the spec", () => {
    const specKeys = Object.keys(siteConfig.tiers.free);
    const omitted = 8; // the presentation keys above, plus excerptChars
    expect(rows).toHaveLength(specKeys.length - omitted);
  });

  it("gives every row one cell per plan, in rank order", () => {
    for (const row of rows) {
      expect(row.cells.map((c) => c.tier)).toEqual(["free", "essential", "premium"]);
    }
  });

  it("labels a known key and never leaves a label blank", () => {
    expect(rows.find((r) => r.key === "maxImages")?.label).toBe("Photos");
    for (const row of rows) expect(row.label.length).toBeGreaterThan(0);
  });

  it("reads unlimited photos off the top plan", () => {
    const row = rows.find((r) => r.key === "maxImages");
    expect(row?.cells.at(-1)?.cell).toEqual({ kind: "text", text: UNLIMITED });
  });

  it("is empty for an empty tier set", () => {
    expect(comparisonRows({} as { readonly [K in TierName]: TierSpec })).toEqual([]);
  });
});

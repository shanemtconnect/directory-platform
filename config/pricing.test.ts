import { describe, it, expect } from "vitest";
import { siteConfig } from "./site.config";
import type { TierName } from "./types";

const PAID: TierName[] = ["essential", "premium"];

describe("pricing config", () => {
  it("makes the 'save 2 months' claim literally true on every paid tier", () => {
    for (const name of PAID) {
      const t = siteConfig.tiers[name];
      // Paying monthly for a year costs 12 x monthly. The annual price must be
      // exactly 10 x monthly for "save 2 months" to be accurate.
      expect(t.priceAnnual).toBeCloseTo(t.priceMonthly * 10, 2);
      expect(t.priceMonthly * 12 - t.priceAnnual).toBeCloseTo(t.priceMonthly * 2, 2);
    }
  });

  it("prices the free tier at zero on both intervals with no trial", () => {
    const f = siteConfig.tiers.free;
    expect(f.priceAnnual).toBe(0);
    expect(f.priceMonthly).toBe(0);
    expect(f.trialDays).toBe(0);
  });

  it("ranks tiers strictly in ascending price order", () => {
    const { free, essential, premium } = siteConfig.tiers;
    expect(free.rank).toBeLessThan(essential.rank);
    expect(essential.rank).toBeLessThan(premium.rank);
    expect(free.priceAnnual).toBeLessThan(essential.priceAnnual);
    expect(essential.priceAnnual).toBeLessThan(premium.priceAnnual);
  });

  it("gives every tier the copy /pricing needs, so the page never hardcodes it", () => {
    for (const name of ["free", ...PAID] as TierName[]) {
      const t = siteConfig.tiers[name];
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.strapline.length).toBeGreaterThan(0);
      expect(t.bullets.length).toBeGreaterThan(0);
    }
  });

  it("offers the same trial on every paid tier", () => {
    expect(new Set(PAID.map((n) => siteConfig.tiers[n].trialDays)).size).toBe(1);
    expect(siteConfig.tiers.essential.trialDays).toBeGreaterThan(0);
  });

  it("bundles verification with every paid tier and no free tier", () => {
    expect(siteConfig.tiers.free.verificationIncluded).toBe(false);
    for (const name of PAID) expect(siteConfig.tiers[name].verificationIncluded).toBe(true);
  });

  it("keeps contact reachable on every tier — only richness is gated", () => {
    // No tier flag may withhold the enquiry form, phone or address. If one is
    // ever added, this test is where the argument has to happen.
    const gates = Object.keys(siteConfig.tiers.free);
    for (const forbidden of ["showPhone", "showAddress", "showEnquiryForm", "hideContact"]) {
      expect(gates).not.toContain(forbidden);
    }
  });

  it("escalates limits monotonically from free to premium", () => {
    const { free, essential, premium } = siteConfig.tiers;
    expect(free.maxImages).not.toBeNull();
    expect(essential.maxImages).not.toBeNull();
    expect(free.maxImages!).toBeLessThan(essential.maxImages!);
    expect(premium.maxImages).toBeNull(); // unlimited
    expect(free.descriptionDisplay).toBe("excerpt");
    expect(essential.descriptionDisplay).toBe("full");
    expect(premium.descriptionDisplay).toBe("full");
  });
});

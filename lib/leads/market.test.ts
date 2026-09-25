import { describe, expect, it } from "vitest";
import { siteConfig } from "@/config/site.config";
import {
  MAX_STANDING_ORDERS_PER_LISTING, REFUND_FLAG_RATE, REFUND_REASONS, currentPriceCents, decodeTerritory,
  encodeTerritory, floorCents, isRefundRateFlagged, noRefundReasons, orderCovers, refundRate, refundWindowOpen,
} from "./market";

const DAY = 86_400_000;
const T0 = new Date("2026-09-25T12:00:00Z");

describe("currentPriceCents", () => {
  it("is the listed price until half_price_at, then half of it, rounded up to a whole cent", () => {
    const lead = { priceCents: 2501, halfPriceAt: new Date(T0.getTime() + 7 * DAY) };
    expect(currentPriceCents(lead, T0)).toBe(2501);
    expect(currentPriceCents(lead, new Date(T0.getTime() + 7 * DAY - 1))).toBe(2501);
    expect(currentPriceCents(lead, new Date(T0.getTime() + 7 * DAY))).toBe(1251);
  });
});

describe("floorCents", () => {
  it("is the configured floor in minor units", () => {
    expect(floorCents()).toBe(Math.round(siteConfig.leads.floor * 100));
  });
});

describe("territory form values", () => {
  it("round-trips the three kinds", () => {
    const id = "3f1d7a2e-9b7c-4c1e-8f3a-2b5d6e7f8a9b";
    for (const t of [{ kind: "national" }, { kind: "region", id: "west-yorkshire" }, { kind: "city", id }] as const) {
      expect(decodeTerritory(encodeTerritory(t))).toEqual(t);
    }
  });

  it("refuses anything else", () => {
    for (const bad of ["", "city:", "city:not-a-uuid", "region:", "region:Bad Slug", "planet:mars", "national:x"]) {
      expect(decodeTerritory(bad)).toBeNull();
    }
  });
});

describe("refunds", () => {
  it("has exactly the D10 reasons", () => {
    expect(REFUND_REASONS.map((r) => r.value)).toEqual([
      "dead_phone", "wrong_person", "bounced", "spam", "never_asked", "wrong_area",
    ]);
  });

  it("prints the window in the no-refund list", () => {
    expect(noRefundReasons().join(" ")).toContain(`${siteConfig.leads.refundWindowDays} days`);
  });

  it("is open for refundWindowDays after the purchase, and closed after", () => {
    const days = siteConfig.leads.refundWindowDays;
    expect(refundWindowOpen(T0, new Date(T0.getTime() + days * DAY - 1))).toBe(true);
    expect(refundWindowOpen(T0, new Date(T0.getTime() + days * DAY))).toBe(false);
  });

  it("flags a buyer above a third, not at it", () => {
    expect(REFUND_FLAG_RATE).toBeCloseTo(1 / 3);
    expect(refundRate(0, 0)).toBe(0);
    expect(refundRate(3, 1)).toBeCloseTo(1 / 3);
    expect(isRefundRateFlagged(3, 1)).toBe(false);
    expect(isRefundRateFlagged(2, 1)).toBe(true);
    expect(isRefundRateFlagged(0, 0)).toBe(false);
  });

  it("caps standing orders at five per listing", () => {
    expect(MAX_STANDING_ORDERS_PER_LISTING).toBe(5);
  });
});

describe("orderCovers", () => {
  const lead = { cityId: "c1", regionSlug: "west-yorkshire", categoryId: "k1" };
  it("matches city, region or national, then the category list", () => {
    expect(orderCovers({ territories: [{ kind: "city", id: "c1" }], categoryIds: null }, lead)).toBe(true);
    expect(orderCovers({ territories: [{ kind: "region", id: "west-yorkshire" }], categoryIds: ["k1"] }, lead)).toBe(true);
    expect(orderCovers({ territories: [{ kind: "national" }], categoryIds: ["k2"] }, lead)).toBe(false);
    expect(orderCovers({ territories: [{ kind: "city", id: "c2" }], categoryIds: null }, lead)).toBe(false);
    expect(orderCovers({ territories: [{ kind: "region", id: "cornwall" }], categoryIds: null }, { ...lead, regionSlug: null })).toBe(false);
    expect(orderCovers({ territories: [{ kind: "national" }], categoryIds: ["k1"] }, { ...lead, categoryId: null })).toBe(false);
  });
});

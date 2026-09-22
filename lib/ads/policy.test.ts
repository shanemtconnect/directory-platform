import { describe, expect, it } from "vitest";
import { AD_PLACEMENTS, type AdPlacement, type AdsConfig } from "@/config/types";
import { siteConfig } from "@/config/site.config";
import { decideSponsorRails, type PageListing, type RailsDecision } from "./policy";

const ON: AdsConfig = { ...siteConfig.ads, enabled: true };
const OFF: AdsConfig = { ...siteConfig.ads, enabled: false };
const PROD = { SITE_ENV: "production" };
const STAGING = { SITE_ENV: "staging" };

const FREE_UNVERIFIED: PageListing = { tier: "free", claimStatus: "unclaimed" };
const FREE_CLAIMED: PageListing = { tier: "free", claimStatus: "claimed" };
const FREE_VERIFIED: PageListing = { tier: "free", claimStatus: "verified" };
const PAID: PageListing = { tier: "essential", claimStatus: "claimed" };
const PREMIUM_VERIFIED: PageListing = { tier: "premium", claimStatus: "verified" };

type Row = [AdPlacement, PageListing | null, RailsDecision];

/** The shipped placements × every page state, in production, config on. */
const PRODUCTION_TABLE: Row[] = [
  ["home", null, "off"],
  ["home", FREE_UNVERIFIED, "off"],
  ["cityPillar", null, "show"],
  ["categoryPillar", null, "show"],
  ["search", null, "show"],
  ["blog", null, "show"],
  ["other", null, "off"],
  ["listingDetail", null, "off"],
  ["listingDetail", FREE_UNVERIFIED, "show"],
  ["listingDetail", FREE_CLAIMED, "show"],
  ["listingDetail", FREE_VERIFIED, "off"],
  ["listingDetail", PAID, "off"],
  ["listingDetail", PREMIUM_VERIFIED, "off"],
];

describe("decideSponsorRails — production, config on", () => {
  it.each(PRODUCTION_TABLE)("%s with %j → %s", (placement, listing, expected) => {
    expect(decideSponsorRails({ placement, listing, config: ON, env: PROD })).toBe(expected);
  });
});

describe("decideSponsorRails — staging shows a placeholder wherever production would show", () => {
  it.each(PRODUCTION_TABLE)("%s with %j", (placement, listing, expected) => {
    const got = decideSponsorRails({ placement, listing, config: ON, env: STAGING });
    expect(got).toBe(expected === "show" ? "placeholder" : "off");
  });

  it("an unset SITE_ENV is staging", () => {
    expect(decideSponsorRails({ placement: "search", listing: null, config: ON, env: {} })).toBe("placeholder");
  });
});

describe("decideSponsorRails — switches", () => {
  it.each(AD_PLACEMENTS)("config off → off on %s, whatever the page", (placement) => {
    for (const listing of [null, FREE_UNVERIFIED, PAID]) {
      expect(decideSponsorRails({ placement, listing, config: OFF, env: PROD })).toBe("off");
    }
  });

  it("ADS_ENABLED=false kills everything even with the config on", () => {
    for (const placement of AD_PLACEMENTS) {
      expect(decideSponsorRails({
        placement, listing: FREE_UNVERIFIED, config: ON, env: { ...PROD, ADS_ENABLED: "false" },
      })).toBe("off");
    }
  });

  it("ADS_ENABLED=true turns the rails on over a config that has them off (staging/e2e verification)", () => {
    expect(decideSponsorRails({
      placement: "cityPillar", listing: null, config: OFF, env: { ...PROD, ADS_ENABLED: "true" },
    })).toBe("show");
    // but never on the home page or an unpaid-only placement with a paid listing
    expect(decideSponsorRails({
      placement: "home", listing: null, config: OFF, env: { ...PROD, ADS_ENABLED: "true" },
    })).toBe("off");
    expect(decideSponsorRails({
      placement: "listingDetail", listing: PAID, config: OFF, env: { ...PROD, ADS_ENABLED: "true" },
    })).toBe("off");
  });

  it("any other ADS_ENABLED value defers to the config", () => {
    expect(decideSponsorRails({ placement: "search", listing: null, config: ON, env: { ...PROD, ADS_ENABLED: "yes" } })).toBe("show");
    expect(decideSponsorRails({ placement: "search", listing: null, config: OFF, env: { ...PROD, ADS_ENABLED: "yes" } })).toBe("off");
  });
});

describe("decideSponsorRails — the config rule table", () => {
  const rules = (overrides: Partial<AdsConfig["placements"]>): AdsConfig => ({
    ...ON, placements: { ...ON.placements, ...overrides },
  });

  it("home is never shown, even if a clone's config says always", () => {
    expect(decideSponsorRails({ placement: "home", listing: null, config: rules({ home: "always" }), env: PROD })).toBe("off");
  });

  it("'always' on a listing page ignores the tier; 'never' on a pillar hides it", () => {
    expect(decideSponsorRails({ placement: "listingDetail", listing: PAID, config: rules({ listingDetail: "always" }), env: PROD })).toBe("show");
    expect(decideSponsorRails({ placement: "cityPillar", listing: null, config: rules({ cityPillar: "never" }), env: PROD })).toBe("off");
  });

  it("'unpaid-only' on a page without a listing is off", () => {
    expect(decideSponsorRails({ placement: "search", listing: null, config: rules({ search: "unpaid-only" }), env: PROD })).toBe("off");
  });
});

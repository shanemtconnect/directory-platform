import { describe, expect, it } from "vitest";
import { siteConfig } from "@/config/site.config";
import type { SponsorCardData } from "@/lib/db/queries/ads";
import { houseAds } from "./house";
import { MAX_PER_RAIL, buildInventory, type RailItem } from "./inventory";

const campaign = (n: number): SponsorCardData => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  name: `Sponsor ${n}`,
  logoPath: null,
  title: `Title ${n}`,
  blurb: `Blurb ${n}`,
  weight: 1,
});

const kinds = (items: readonly RailItem[]) => items.map((i) => i.kind);

describe("houseAds", () => {
  it("has the three cards, every noun from the config, no niche word literal", () => {
    const ads = houseAds();
    expect(ads.map((a) => a.id)).toEqual(["claim", "verify", "advertise"]);
    expect(ads[0]!.title).toBe(`Claim your ${siteConfig.entity.singular}`);
    expect(ads[2]!.href).toBe("/advertise/sponsor");
    for (const ad of ads) {
      expect(ad.title.length).toBeLessThanOrEqual(60);
      expect(ad.blurb.length).toBeLessThanOrEqual(120);
    }
  });
});

describe("buildInventory", () => {
  it("with no sponsors, the three house ads split across the rails and the inline slot takes the first", () => {
    const inv = buildInventory([], "seed");
    expect(kinds(inv.left)).toEqual(["house", "house"]);
    expect(kinds(inv.right)).toEqual(["house"]);
    expect(inv.inline).toMatchObject({ kind: "house", ad: { id: "claim" } });
  });

  it("house ads come first, then sponsors, never more than the cap per rail", () => {
    const many = Array.from({ length: 30 }, (_, i) => campaign(i));
    const inv = buildInventory(many, "seed");
    expect(inv.left).toHaveLength(MAX_PER_RAIL);
    expect(inv.right).toHaveLength(MAX_PER_RAIL);
    expect(kinds(inv.left).slice(0, 2)).toEqual(["house", "house"]);
    expect(kinds(inv.right)[0]).toBe("house");
    const sponsorIds = [...inv.left, ...inv.right]
      .filter((i): i is Extract<RailItem, { kind: "sponsor" }> => i.kind === "sponsor")
      .map((i) => i.campaign.id);
    expect(sponsorIds).toHaveLength(7);
    expect(new Set(sponsorIds).size).toBe(7);
    // the inline card is a paying sponsor when there is one
    expect(inv.inline?.kind).toBe("sponsor");
  });

  it("is stable for a seed", () => {
    const many = Array.from({ length: 12 }, (_, i) => campaign(i));
    expect(buildInventory(many, "a")).toEqual(buildInventory(many, "a"));
    expect(buildInventory(many, "a")).not.toEqual(buildInventory(many, "b"));
  });
});

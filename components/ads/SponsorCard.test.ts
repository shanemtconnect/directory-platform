import { describe, expect, it } from "vitest";
import { siteConfig } from "@/config/site.config";
import { elements, links, text } from "@/test/elements";
import { houseAds } from "@/lib/ads/house";
import { PlaceholderCard, SponsorCard } from "./SponsorCard";

const CAMPAIGN = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Acme Ltd",
  logoPath: null,
  title: "Acme does the thing",
  blurb: "Properly.",
  weight: 1,
};

describe("SponsorCard", () => {
  it("a sponsor card links through /out with rel=sponsored nofollow, says Sponsored, and carries the beacon marker", () => {
    const el = SponsorCard({ item: { kind: "sponsor", campaign: CAMPAIGN }, slot: "left" });
    expect(links(el)).toEqual([{ href: `/out/${CAMPAIGN.id}`, text: expect.stringContaining("Acme does the thing") }]);
    const anchor = [...elements(el)].find((e) => e.type === "a")!;
    expect((anchor.props as { rel: string }).rel).toBe("sponsored nofollow");
    expect(text(el)).toContain("Sponsored");
    expect(text(el)).toContain("A"); // the initial, no logo stored
    const marker = [...elements(el)].find((e) => (e.props as Record<string, unknown>)["data-dp-stat"] !== undefined)!;
    expect(marker.props).toMatchObject({ "data-dp-stat": "sponsor_impression", "data-dp-listing": CAMPAIGN.id });
    expect((el.props as Record<string, unknown>)["data-testid"]).toBe("sponsor-card-left");
  });

  it("a house card links to the site's own page, is labelled with the site, and never says Sponsored", () => {
    const ad = houseAds()[2]!;
    const el = SponsorCard({ item: { kind: "house", ad }, slot: "inline" });
    expect(links(el)[0]!.href).toBe("/advertise/sponsor");
    expect(text(el)).toContain(siteConfig.shortName);
    expect(text(el)).not.toContain("Sponsored");
    const anchor = [...elements(el)].find((e) => e.type === "a")!;
    expect((anchor.props as { rel?: string }).rel).toBeUndefined();
    expect([...elements(el)].some((e) => (e.props as Record<string, unknown>)["data-dp-stat"] !== undefined)).toBe(false);
  });

  it("a placeholder names itself and links nowhere", () => {
    const el = PlaceholderCard({ slot: "right" });
    expect(text(el)).toContain("Sponsor slot");
    expect(links(el)).toHaveLength(0);
  });
});

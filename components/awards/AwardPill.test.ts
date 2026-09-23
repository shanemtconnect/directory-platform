import { describe, it, expect } from "vitest";
import { elements, text } from "@/test/elements";
import { AwardPill } from "./AwardPill";
import { ListingAwards } from "./ListingAwards";
import { awardText } from "@/lib/db/queries/awards";

describe("AwardPill", () => {
  it("says the year in words, as a link when given somewhere to go", () => {
    const linked = AwardPill({ year: 2031, href: "/awards/2031/leeds" });
    expect(linked.type).toBe("a");
    expect(text(linked)).toBe("Winner 2031");
    expect((linked.props as { href: string }).href).toBe("/awards/2031/leeds");
    const plain = AwardPill({ year: 2031 });
    expect(plain.type).toBe("span");
    expect(text(plain)).toBe("Winner 2031");
  });
});

describe("ListingAwards", () => {
  const award = {
    awardId: "a1", year: 2031, cityName: "Leeds", citySlug: "leeds",
    categoryName: "Barn Venues", awardsPath: "/awards/2031/leeds",
  };

  it("renders nothing at all without an award", () => {
    expect(ListingAwards({ awards: [] })).toBeNull();
  });

  it("prints exactly the text the JSON-LD award carries, linked to the year's page", () => {
    const out = ListingAwards({ awards: [award] });
    expect(text(out)).toContain(awardText(award));
    const hrefs = [...elements(out)].map((el) => (el.props as { href?: string }).href).filter(Boolean);
    expect(hrefs).toContain("/awards/2031/leeds");
  });
});

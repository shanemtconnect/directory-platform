import { describe, expect, it } from "vitest";
import { links, text } from "@/test/elements";
import { siteConfig } from "@/config/site.config";
import { NeighbourhoodList } from "./NeighbourhoodList";

describe("NeighbourhoodList", () => {
  it("renders nothing when the town has no neighbourhood worth linking", () => {
    expect(NeighbourhoodList({ neighbourhoods: [], cityPath: "/leeds", place: "Leeds" })).toBeNull();
  });

  it("links each neighbourhood under its town, with its count", () => {
    const el = NeighbourhoodList({
      cityPath: "/leeds",
      place: "Leeds",
      neighbourhoods: [
        { id: "a", name: "Armley", slug: "armley", listingCount: 1 },
        { id: "h", name: "Headingley", slug: "headingley", listingCount: 12 },
      ],
    })!;
    expect(links(el)).toEqual([
      { href: "/leeds/armley", text: `${siteConfig.entity.Plural} in Armley` },
      { href: "/leeds/headingley", text: `${siteConfig.entity.Plural} in Headingley` },
    ]);
    expect(text(el)).toContain("Neighbourhoods in Leeds");
    expect(text(el)).toContain("(12)");
  });
});

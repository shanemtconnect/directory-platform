import { describe, expect, it } from "vitest";
import { elements, links } from "@/test/elements";
import type { PillarHeading } from "@/lib/db/queries/cities";
import { PillarPage } from "./PillarPage";

/**
 * The town-wide "by type" block (Task 52 review): its links and counts are
 * the TOWN's — /leeds/barn-venues, Leeds-wide totals — so on a neighbourhood
 * page it would claim "Barn Venues in Headingley (12)" about a page that is
 * not Headingley's, and repeat the town page's link block on every
 * neighbourhood. It renders on the town pages and nowhere under them.
 */

const town: PillarHeading = {
  faq: null, title: "Venues in Leeds", place: "Leeds", nounSingular: "venue", nounPlural: "venues",
  introHtml: null, isIndexable: true, listingCount: 12,
};
const neighbourhood: PillarHeading = {
  ...town, title: "Venues in Headingley, Leeds", place: "Headingley", isIndexable: false, listingCount: 2,
  parent: { name: "Leeds", slug: "leeds" },
};

const props = {
  featured: [], listings: [], nearby: [], faq: [], total: 0, page: 1, totalPages: 1,
  cityPath: "/leeds",
  categories: [{ id: "c1", name: "Barn Venues", slug: "barn-venues", listingCount: 12 }],
} as unknown as Omit<Parameters<typeof PillarPage>[0], "heading" | "basePath">;

const hasCategoryBlock = (el: ReturnType<typeof PillarPage>) =>
  [...elements(el)].some((e) => (e.props as { "data-testid"?: string })["data-testid"] === "category-links");

describe("PillarPage — the by-type block", () => {
  it("is on the town page, linking the town's category pages", () => {
    const el = PillarPage({ ...props, heading: town, basePath: "/leeds" });
    expect(hasCategoryBlock(el)).toBe(true);
    expect(links(el)).toContainEqual({ href: "/leeds/barn-venues", text: "Barn Venues in Leeds" });
  });

  it("is absent from a neighbourhood page, even if handed the town's categories", () => {
    const el = PillarPage({ ...props, heading: neighbourhood, basePath: "/leeds/headingley" });
    expect(hasCategoryBlock(el)).toBe(false);
    expect(links(el).map((l) => l.href)).not.toContain("/leeds/barn-venues");
  });
});

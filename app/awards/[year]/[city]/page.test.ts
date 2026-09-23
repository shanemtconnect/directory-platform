import { describe, it, expect, vi, beforeEach } from "vitest";
import { FEATURE_FLAGS } from "@/config/types";
import type { AwardWinnersPage } from "@/lib/db/queries/awards";
import { elements, links, text } from "@/test/elements";

class NotFound extends Error {}

const awardWinners = vi.fn<(year: number, city: string) => Promise<AwardWinnersPage | null>>();

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/db/client", () => ({ db: { marker: "the pool" } }));
vi.mock("@/lib/db/build-phase", () => ({ prerenderingWithoutDatabase: () => false }));
vi.mock("@/lib/db/queries/awards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/queries/awards")>()),
  awardWinners: (_db: unknown, _viewer: unknown, year: number, city: string) => awardWinners(year, city),
}));

function flags(awards: boolean) {
  const map = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, f === "reviews"])) as Record<string, boolean>;
  map.awards = awards;
  vi.doMock("@/lib/features/flags", () => ({ features: map, isEnabled: (f: string) => map[f] }));
}

const params = (year: string, city: string) => Promise.resolve({ year, city });

const PAGE: AwardWinnersPage = {
  year: 2031,
  city: { id: "c1", name: "Leeds", slug: "leeds", region: "West Yorkshire" },
  winners: [
    {
      awardId: "a1",
      category: { id: "k1", name: "Barn Venues", singular: "barn venue" },
      listing: { id: "l1", name: "The Old Barn", slug: "the-old-barn", path: "/leeds/the-old-barn", ratingAvg: "4.9", ratingCount: 7 },
    },
    {
      awardId: "a2",
      category: { id: "k2", name: "Marquee Hire", singular: "marquee hire" },
      listing: { id: "l2", name: "Big Top", slug: "big-top", path: "/leeds/big-top", ratingAvg: null, ratingCount: 0 },
    },
  ],
};

beforeEach(() => {
  vi.resetModules();
  awardWinners.mockReset().mockResolvedValue(null);
});

describe("/awards/[year]/[city] with the flag off", () => {
  it("is a 404 before any query runs", async () => {
    flags(false);
    const page = await import("./page");
    await expect(page.default({ params: params("2031", "leeds") })).rejects.toThrow(NotFound);
    expect(awardWinners).not.toHaveBeenCalled();
  });
});

describe("/awards/[year]/[city] with the flag on", () => {
  it("404s a bad year without a query and an unknown town after one", async () => {
    flags(true);
    const page = await import("./page");
    await expect(page.default({ params: params("nope", "leeds") })).rejects.toThrow(NotFound);
    expect(awardWinners).not.toHaveBeenCalled();
    await expect(page.default({ params: params("2031", "nowhere") })).rejects.toThrow(NotFound);
    expect(awardWinners).toHaveBeenCalledWith(2031, "nowhere");
  });

  it("renders one winner per category with a link to the listing and the year's pill", async () => {
    flags(true);
    awardWinners.mockResolvedValue(PAGE);
    const page = await import("./page");
    const out = await page.default({ params: params("2031", "leeds") });

    type Props = { "data-testid"?: string; href?: string; data?: { mainEntity?: { itemListElement: unknown[] } } };
    const props = (el: { props: unknown }) => el.props as Props;
    const winnerLinks = [...elements(out)].filter((el) => props(el)["data-testid"] === "award-winner-link");
    expect(winnerLinks.map((el) => props(el).href)).toEqual(["/leeds/the-old-barn", "/leeds/big-top"]);
    const pills = [...elements(out)].filter((el) => props(el)["data-testid"] === "award-pill");
    expect(pills).toHaveLength(2);
    expect(text(out)).toContain("Barn Venues");
    expect(text(out)).toContain("Rated 4.9 from 7 reviews");
    // No rating line for a winner whose rating is not on the page.
    expect(text(out)).not.toContain("Rated null");

    // The ItemList is exactly the winners shown.
    const jsonLd = [...elements(out)].find((el) => props(el).data?.mainEntity !== undefined);
    expect(props(jsonLd!).data?.mainEntity?.itemListElement).toHaveLength(2);
    expect(links(out).map((l) => l.href)).toContain("/leeds");
  });

  it("canonicalises to the year and town", async () => {
    flags(true);
    awardWinners.mockResolvedValue(PAGE);
    const page = await import("./page");
    const meta = await page.generateMetadata({ params: params("2031", "leeds") });
    expect(meta.alternates?.canonical).toBe("/awards/2031/leeds");
    expect(meta.title).toContain("Leeds");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { siteConfig } from "@/config/site.config";
import type { SpotLeaderboard } from "@/lib/db/queries/spots";
import { links, text } from "@/test/elements";

/**
 * The public leaderboard: who is featured where, in what order, and how many
 * of the positions are taken. Never an amount — the amounts are between each
 * bidder and the bidding page — and never indexed.
 */
class NotFound extends Error {}
const spotLeaderboard = vi.fn<() => Promise<SpotLeaderboard | null>>();

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/db/client", () => ({ db: { marker: "pool" } }));
vi.mock("@/lib/db/queries/spots", () => ({
  spotLeaderboard: (...args: unknown[]) => spotLeaderboard(...(args as [])),
}));

const SPOT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const BOARD: SpotLeaderboard = {
  spot: { id: SPOT, areaKind: "city", areaId: "c1", categoryId: "cat", positions: 3, floorCents: 5000, status: "open" },
  areaName: "Leeds",
  categoryName: "Barns",
  path: "/leeds/barns",
  featured: [
    { position: 1, name: "Alpha Hall", slug: "alpha-hall", citySlug: "leeds" },
    { position: 2, name: "Bravo Barn", slug: "bravo-barn", citySlug: "bradford" },
  ],
};

beforeEach(() => {
  spotLeaderboard.mockReset().mockResolvedValue(BOARD);
});

describe("/spots/[spotId]", () => {
  it("lists the featured listings by position with their own links, the free position, and the scarcity line — no amounts", async () => {
    const { default: Page } = await import("./page");
    const el = await Page({ params: Promise.resolve({ spotId: SPOT }) });
    const body = text(el);
    expect(body).toContain(`Featured ${siteConfig.entity.plural} for Barns in Leeds`);
    expect(body).toContain("2 of 3 taken");
    expect(body).toContain("Alpha Hall");
    expect(body).toContain("Bravo Barn");
    expect(body).not.toMatch(/[£$€]\s?\d/);
    expect(body).not.toContain("50");
    const hrefs = links(el).map((l) => l.href);
    expect(hrefs).toContain("/leeds/alpha-hall");
    expect(hrefs).toContain("/bradford/bravo-barn");
    expect(hrefs).toContain("/leeds/barns");
    expect(hrefs).toContain("/account");
  });

  it("is noindex and titled after the spot", async () => {
    const { generateMetadata } = await import("./page");
    const meta = await generateMetadata({ params: Promise.resolve({ spotId: SPOT }) });
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(String(meta.title)).toContain("Leeds");
  });

  it("404s for a spot that is not there, and for a malformed id without asking", async () => {
    spotLeaderboard.mockResolvedValue(null);
    const { default: Page } = await import("./page");
    await expect(Page({ params: Promise.resolve({ spotId: SPOT }) })).rejects.toThrow(NotFound);
    spotLeaderboard.mockClear();
    await expect(Page({ params: Promise.resolve({ spotId: "nope" }) })).rejects.toThrow(NotFound);
    expect(spotLeaderboard).not.toHaveBeenCalled();
  });

  it("a city spot without a category reads 'in <town>'; a closed spot is a 404", async () => {
    spotLeaderboard.mockResolvedValue({ ...BOARD, spot: { ...BOARD.spot, categoryId: null }, categoryName: null, path: "/leeds", featured: [] });
    const { default: Page } = await import("./page");
    const body = text(await Page({ params: Promise.resolve({ spotId: SPOT }) }));
    expect(body).toContain(`Featured ${siteConfig.entity.plural} in Leeds`);
    expect(body).toContain("0 of 3 taken");
    spotLeaderboard.mockResolvedValue({ ...BOARD, spot: { ...BOARD.spot, status: "closed" } });
    await expect(Page({ params: Promise.resolve({ spotId: SPOT }) })).rejects.toThrow(NotFound);
  });
});

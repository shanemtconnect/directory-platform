import { describe, it, expect, vi, beforeEach } from "vitest";
import { FEATURE_FLAGS } from "@/config/types";
import type { AwardCity } from "@/lib/db/queries/awards";
import { links, text } from "@/test/elements";

class NotFound extends Error {}

const awardCities = vi.fn<(year: number) => Promise<AwardCity[]>>();

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/db/client", () => ({ db: { marker: "the pool" } }));
vi.mock("@/lib/db/build-phase", () => ({ prerenderingWithoutDatabase: () => false }));
vi.mock("@/lib/db/queries/awards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/queries/awards")>()),
  awardCities: (_db: unknown, _viewer: unknown, year: number) => awardCities(year),
}));

function flags(awards: boolean) {
  const map = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, f === "reviews"])) as Record<string, boolean>;
  map.awards = awards;
  vi.doMock("@/lib/features/flags", () => ({ features: map, isEnabled: (f: string) => map[f] }));
}

const params = (year: string) => Promise.resolve({ year });

beforeEach(() => {
  vi.resetModules();
  awardCities.mockReset().mockResolvedValue([]);
});

describe("/awards/[year] with the flag off", () => {
  it("is a 404 before any query runs", async () => {
    flags(false);
    const page = await import("./page");
    await expect(page.default({ params: params("2031") })).rejects.toThrow(NotFound);
    expect(awardCities).not.toHaveBeenCalled();
  });
});

describe("/awards/[year] with the flag on", () => {
  it("404s a year that is not a year, without a query", async () => {
    flags(true);
    const page = await import("./page");
    for (const bad of ["abcd", "31", "02031", "1999"]) {
      await expect(page.default({ params: params(bad) })).rejects.toThrow(NotFound);
    }
    expect(awardCities).not.toHaveBeenCalled();
  });

  it("404s a year with no winners, and says noindex in its metadata", async () => {
    flags(true);
    const page = await import("./page");
    await expect(page.default({ params: params("2031") })).rejects.toThrow(NotFound);
    expect(awardCities).toHaveBeenCalledWith(2031);
    expect((await page.generateMetadata({ params: params("2031") })).robots).toMatchObject({ index: false });
  });

  it("lists the towns with a winner and links each town's page", async () => {
    flags(true);
    awardCities.mockResolvedValue([
      { cityId: "c1", name: "Leeds", slug: "leeds", region: "West Yorkshire", winners: 2 },
      { cityId: "c2", name: "York", slug: "york", region: "North Yorkshire", winners: 1 },
    ]);
    const page = await import("./page");
    const out = await page.default({ params: params("2031") });
    const hrefs = links(out).map((l) => l.href);
    expect(hrefs).toContain("/awards/2031/leeds");
    expect(hrefs).toContain("/awards/2031/york");
    expect(text(out)).toContain("2 winners");
    expect(text(out)).toContain("1 winner");

    const meta = await page.generateMetadata({ params: params("2031") });
    expect(meta.alternates?.canonical).toBe("/awards/2031");
    expect(meta.robots).toBeUndefined();
  });
});

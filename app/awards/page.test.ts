import { describe, it, expect, vi, beforeEach } from "vitest";
import { FEATURE_FLAGS } from "@/config/types";
import type { AwardYear } from "@/lib/db/queries/awards";
import { links, text } from "@/test/elements";

/**
 * /awards under both flag states (Task 50).
 *
 * The flag is a build-time constant, so each state is a fresh module graph:
 * `vi.doMock` of the flags module before the import, `vi.resetModules` in
 * between. What is pinned: off → 404 before any query; on → the years from
 * the query, noindex until there is a winner, index once there is.
 */

class NotFound extends Error {}

const awardYears = vi.fn<() => Promise<AwardYear[]>>();

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/db/client", () => ({ db: { marker: "the pool" } }));
vi.mock("@/lib/db/build-phase", () => ({ prerenderingWithoutDatabase: () => false }));
vi.mock("@/lib/db/queries/awards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/queries/awards")>()),
  awardYears: () => awardYears(),
}));

function flags(awards: boolean) {
  const map = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, f === "reviews"])) as Record<string, boolean>;
  map.awards = awards;
  vi.doMock("@/lib/features/flags", () => ({ features: map, isEnabled: (f: string) => map[f] }));
}

beforeEach(() => {
  vi.resetModules();
  awardYears.mockReset().mockResolvedValue([]);
});

describe("/awards with the flag off", () => {
  it("is a 404 before any query runs, page and metadata alike", async () => {
    flags(false);
    const page = await import("./page");
    await expect(page.default()).rejects.toThrow(NotFound);
    await expect(page.generateMetadata()).rejects.toThrow(NotFound);
    expect(awardYears).not.toHaveBeenCalled();
  });
});

describe("/awards with the flag on", () => {
  it("lists the years with winners and links each one", async () => {
    flags(true);
    awardYears.mockResolvedValue([
      { year: 2031, winners: 12, cities: 4 },
      { year: 2030, winners: 3, cities: 1 },
    ]);
    const page = await import("./page");
    const out = await page.default();
    const hrefs = links(out).map((l) => l.href);
    expect(hrefs).toContain("/awards/2031");
    expect(hrefs).toContain("/awards/2030");
    expect(text(out)).toContain("12 in 4 towns");
    expect(text(out)).toContain("3 in 1 town");
  });

  it("is indexable only once there is at least one winner", async () => {
    flags(true);
    const page = await import("./page");
    expect((await page.generateMetadata()).robots).toMatchObject({ index: false });

    awardYears.mockResolvedValue([{ year: 2031, winners: 1, cities: 1 }]);
    expect((await page.generateMetadata()).robots).toMatchObject({ index: true });
  });

  it("says so, in words from the config, when nothing has been decided", async () => {
    flags(true);
    const page = await import("./page");
    const out = await page.default();
    expect(text(out)).toContain("No awards have been decided yet");
    expect(links(out).map((l) => l.href)).not.toContain("/awards/2031");
  });
});

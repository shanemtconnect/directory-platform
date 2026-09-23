import { describe, it, expect, vi, beforeEach } from "vitest";
import { FEATURE_FLAGS } from "@/config/types";
import type { Viewer } from "@/lib/db/viewer";
import type { AdminAward, AdminAwardYear } from "@/lib/db/queries/awards";

/**
 * /admin/awards and /admin/awards/[year] (Task 50): the page's own gate, the
 * flag gate, and the wiring — same reasoning as /admin/reviews.
 */

class NotFound extends Error {}

const currentViewer = vi.fn<() => Promise<Viewer>>();
const adminAwardYears = vi.fn<() => Promise<AdminAwardYear[]>>();
const adminAwardsForYear = vi.fn<(year: number) => Promise<AdminAward[]>>();

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/db/client", () => ({ db: { marker: "the pool" } }));
vi.mock("@/lib/db/queries/admin/dashboard", () => {
  const counts = {
      pendingSubmissions: 0,
      citiesAwaitingIntro: 0,
      pendingClaims: 0,
      openReports: 0,
      openRemovals: 0,
      reviewsAwaitingModeration: 0,
    };
  return {
    adminQueueCounts: () => Promise.resolve(counts),
    // The nav reads the one-statement version (components/admin/nav-counts.ts).
    adminQueueCountsInOneQuery: () => Promise.resolve(counts),
  };
});
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/db/queries/awards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/queries/awards")>()),
  adminAwardYears: () => adminAwardYears(),
  adminAwardsForYear: (_db: unknown, _viewer: unknown, year: number) => adminAwardsForYear(year),
}));

function flags(awards: boolean) {
  const map = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, f === "reviews"])) as Record<string, boolean>;
  map.awards = awards;
  vi.doMock("@/lib/features/flags", () => ({ features: map, isEnabled: (f: string) => map[f] }));
}

const ADMIN: Viewer = { role: "admin", userId: "user_admin" };

beforeEach(() => {
  vi.resetModules();
  currentViewer.mockReset();
  adminAwardYears.mockReset().mockResolvedValue([]);
  adminAwardsForYear.mockReset().mockResolvedValue([]);
});

describe("/admin/awards", () => {
  it("404s with the flag off, even for an admin, before any query", async () => {
    flags(false);
    currentViewer.mockResolvedValue(ADMIN);
    const { default: page } = await import("./page");
    await expect(page()).rejects.toThrow(NotFound);
    expect(adminAwardYears).not.toHaveBeenCalled();
  });

  it.each<Viewer>([
    { role: "public" },
    { role: "user", userId: "user_1" },
    { role: "owner", userId: "user_2" },
  ])("404s for a $role viewer without running the query", async (viewer) => {
    flags(true);
    currentViewer.mockResolvedValue(viewer);
    const { default: page } = await import("./page");
    await expect(page()).rejects.toThrow(NotFound);
    expect(adminAwardYears).not.toHaveBeenCalled();
  });

  it("reads the years for an admin", async () => {
    flags(true);
    currentViewer.mockResolvedValue(ADMIN);
    const { default: page } = await import("./page");
    await page();
    expect(adminAwardYears).toHaveBeenCalled();
  });

  it("is never indexed", async () => {
    flags(true);
    const { metadata } = await import("./page");
    expect(metadata.robots).toMatchObject({ index: false });
  });
});

describe("/admin/awards/[year]", () => {
  const params = (year: string) => Promise.resolve({ year });

  it("404s with the flag off and for a non-admin, before any query", async () => {
    flags(false);
    currentViewer.mockResolvedValue(ADMIN);
    const { default: page } = await import("./[year]/page");
    await expect(page({ params: params("2031") })).rejects.toThrow(NotFound);

    vi.resetModules();
    flags(true);
    currentViewer.mockResolvedValue({ role: "owner", userId: "user_2" });
    const { default: gated } = await import("./[year]/page");
    await expect(gated({ params: params("2031") })).rejects.toThrow(NotFound);
    expect(adminAwardsForYear).not.toHaveBeenCalled();
  });

  it("404s a year that is not one, and reads the rows for a real one", async () => {
    flags(true);
    currentViewer.mockResolvedValue(ADMIN);
    const { default: page } = await import("./[year]/page");
    await expect(page({ params: params("nope") })).rejects.toThrow(NotFound);
    expect(adminAwardsForYear).not.toHaveBeenCalled();
    await page({ params: params("2031") });
    expect(adminAwardsForYear).toHaveBeenCalledWith(2031);
  });
});

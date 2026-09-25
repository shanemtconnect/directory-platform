import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Viewer } from "@/lib/db/viewer";
import type { AdminNeighbourhoodTown } from "@/lib/db/queries/neighbourhoods";

/**
 * /admin/neighbourhoods (Task 52): the module gate, the page's own admin gate
 * and the wiring — same reasoning as /admin/awards.
 */

class NotFound extends Error {}

const currentViewer = vi.fn<() => Promise<Viewer>>();
const adminNeighbourhoods = vi.fn<() => Promise<AdminNeighbourhoodTown[]>>();

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/db/client", () => ({ db: { marker: "the pool" } }));
vi.mock("@/lib/db/queries/admin/dashboard", () => {
  const counts = {
    pendingSubmissions: 0, citiesAwaitingIntro: 0, pendingClaims: 0,
    openReports: 0, openRemovals: 0, reviewsAwaitingModeration: 0,
  };
  return {
    adminQueueCounts: () => Promise.resolve(counts),
    adminQueueCountsInOneQuery: () => Promise.resolve(counts),
  };
});
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/db/queries/neighbourhoods", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/queries/neighbourhoods")>()),
  adminNeighbourhoods: () => adminNeighbourhoods(),
}));

const ADMIN: Viewer = { role: "admin", userId: "user_admin" };
const ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.NEIGHBOURHOODS_ENABLED = "true";
  currentViewer.mockReset();
  adminNeighbourhoods.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("/admin/neighbourhoods", () => {
  it("404s with the module off, even for an admin, before any query", async () => {
    process.env.NEIGHBOURHOODS_ENABLED = "false";
    currentViewer.mockResolvedValue(ADMIN);
    const { default: page } = await import("./page");
    await expect(page()).rejects.toThrow(NotFound);
    expect(adminNeighbourhoods).not.toHaveBeenCalled();
  });

  it.each<Viewer>([
    { role: "public" },
    { role: "user", userId: "user_1" },
    { role: "owner", userId: "user_2" },
  ])("404s for a $role viewer without running the query", async (viewer) => {
    currentViewer.mockResolvedValue(viewer);
    const { default: page } = await import("./page");
    await expect(page()).rejects.toThrow(NotFound);
    expect(adminNeighbourhoods).not.toHaveBeenCalled();
  });

  it("reads the neighbourhoods for an admin", async () => {
    currentViewer.mockResolvedValue(ADMIN);
    const { default: page } = await import("./page");
    await page();
    expect(adminNeighbourhoods).toHaveBeenCalled();
  });

  it("is never indexed", async () => {
    const { metadata } = await import("./page");
    expect(metadata.robots).toMatchObject({ index: false });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Viewer } from "@/lib/db/viewer";
import type { OpenReport } from "@/lib/db/queries/trust";

/**
 * The page's own gate.
 *
 * `app/admin/layout.tsx` gates the route, but the layout and the page render
 * CONCURRENTLY in the App Router — so a page that leaned on it would run its
 * query for a viewer the layout is about to 404. `listOpenReports` throws
 * FORBIDDEN for anyone but an admin, which means every 404 of this route would
 * also put a stack trace in the log. The self-gate is what stops that, and it
 * only stops it if the query is never reached.
 */

class NotFound extends Error {}

const currentViewer = vi.fn<() => Promise<Viewer>>();
const listOpenReports = vi.fn<() => Promise<OpenReport[]>>();

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/db/client", () => ({ db: { marker: "the pool" } }));
// The nav counts ride along with every console page; they are not what these tests pin.
const EMPTY_QUEUES = {
  pendingSubmissions: 0,
  citiesAwaitingIntro: 0,
  pendingClaims: 0,
  openReports: 0,
  openRemovals: 0,
  reviewsAwaitingModeration: 0,
};
vi.mock("@/lib/db/queries/admin/dashboard", () => ({
  adminQueueCounts: () => Promise.resolve(EMPTY_QUEUES),
  // The nav reads the one-statement version (components/admin/nav-counts.ts).
  adminQueueCountsInOneQuery: () => Promise.resolve(EMPTY_QUEUES),
}));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/db/queries/trust", () => ({ listOpenReports: () => listOpenReports() }));

beforeEach(() => {
  vi.resetModules();
  currentViewer.mockReset();
  listOpenReports.mockReset().mockResolvedValue([]);
});

describe("/admin/reports", () => {
  it.each<Viewer>([
    { role: "public" },
    { role: "user", userId: "user_1" },
    { role: "owner", userId: "user_2" },
  ])("404s for a $role viewer without running the query", async (viewer) => {
    currentViewer.mockResolvedValue(viewer);
    const { default: page } = await import("./page");

    await expect(page()).rejects.toThrow(NotFound);
    expect(listOpenReports).not.toHaveBeenCalled();
  });

  it("reads the open reports for an admin", async () => {
    currentViewer.mockResolvedValue({ role: "admin", userId: "user_admin" });
    const { default: page } = await import("./page");

    await page();

    expect(listOpenReports).toHaveBeenCalled();
  });

  it("is never indexed", async () => {
    const { metadata } = await import("./page");

    expect(metadata.robots).toMatchObject({ index: false });
  });
});

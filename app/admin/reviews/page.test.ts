import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Viewer } from "@/lib/db/viewer";
import type { ReviewAwaitingModeration } from "@/lib/db/queries/reviews";

/**
 * The page's own gate — same reasoning as /admin/reports: the layout and the
 * page render concurrently, so a page that leaned on the layout would run an
 * admin-only query for a viewer the layout is about to 404, and every 404 of
 * this route would put a FORBIDDEN stack trace in the log.
 */

class NotFound extends Error {}

const currentViewer = vi.fn<() => Promise<Viewer>>();
const listReviewsAwaitingModeration = vi.fn<() => Promise<ReviewAwaitingModeration[]>>();

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
vi.mock("@/lib/db/queries/reviews", () => ({
  listReviewsAwaitingModeration: () => listReviewsAwaitingModeration(),
}));

beforeEach(() => {
  vi.resetModules();
  currentViewer.mockReset();
  listReviewsAwaitingModeration.mockReset().mockResolvedValue([]);
});

describe("/admin/reviews", () => {
  it.each<Viewer>([
    { role: "public" },
    { role: "user", userId: "user_1" },
    { role: "owner", userId: "user_2" },
  ])("404s for a $role viewer without running the query", async (viewer) => {
    currentViewer.mockResolvedValue(viewer);
    const { default: page } = await import("./page");

    await expect(page()).rejects.toThrow(NotFound);
    expect(listReviewsAwaitingModeration).not.toHaveBeenCalled();
  });

  it("reads the queue for an admin", async () => {
    currentViewer.mockResolvedValue({ role: "admin", userId: "user_admin" });
    const { default: page } = await import("./page");

    await page();

    expect(listReviewsAwaitingModeration).toHaveBeenCalled();
  });

  it("is never indexed", async () => {
    const { metadata } = await import("./page");

    expect(metadata.robots).toMatchObject({ index: false });
  });
});

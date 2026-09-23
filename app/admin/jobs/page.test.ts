import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/db/viewer";
import type { PendingJob } from "@/lib/db/queries/job-board";

/**
 * The page's own gates: the flag (a 404 with the query never run) and the
 * role (same). The layout renders concurrently, so a page that leaned on it
 * would run an admin-only query for a viewer about to be 404'd.
 */

class NotFound extends Error {}

const currentViewer = vi.fn<() => Promise<Viewer>>();
const pendingJobs = vi.fn<() => Promise<PendingJob[]>>();
let flagOn = true;

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/db/client", () => ({ db: { marker: "the pool" } }));
vi.mock("@/lib/features/flags", () => ({
  get features() {
    return { jobBoard: flagOn };
  },
}));
vi.mock("@/lib/db/queries/admin/dashboard", () => ({
  adminQueueCounts: () =>
    Promise.resolve({
      pendingSubmissions: 0,
      citiesAwaitingIntro: 0,
      pendingClaims: 0,
      openReports: 0,
      openRemovals: 0,
      reviewsAwaitingModeration: 0,
    }),
}));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/db/queries/job-board", () => ({
  pendingJobs: () => pendingJobs(),
}));

beforeEach(() => {
  vi.resetModules();
  flagOn = true;
  currentViewer.mockReset();
  pendingJobs.mockReset().mockResolvedValue([]);
});

describe("/admin/jobs", () => {
  it("404s when the flag is off, before the viewer is even read", async () => {
    flagOn = false;
    currentViewer.mockResolvedValue({ role: "admin", userId: "user_admin" });
    const { default: page } = await import("./page");
    await expect(page()).rejects.toThrow(NotFound);
    expect(currentViewer).not.toHaveBeenCalled();
    expect(pendingJobs).not.toHaveBeenCalled();
  });

  it.each<Viewer>([
    { role: "public" },
    { role: "user", userId: "user_1" },
    { role: "owner", userId: "user_2" },
  ])("404s for a $role viewer without running the query", async (viewer) => {
    currentViewer.mockResolvedValue(viewer);
    const { default: page } = await import("./page");
    await expect(page()).rejects.toThrow(NotFound);
    expect(pendingJobs).not.toHaveBeenCalled();
  });

  it("reads the queue for an admin", async () => {
    currentViewer.mockResolvedValue({ role: "admin", userId: "user_admin" });
    const { default: page } = await import("./page");
    await expect(page()).resolves.toBeTruthy();
    expect(pendingJobs).toHaveBeenCalledTimes(1);
  });
});

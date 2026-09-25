import { describe, it, expect, vi } from "vitest";
import { navCountsFrom } from "./nav-counts";

describe("navCountsFrom", () => {
  it("keys every non-zero queue by its nav href and drops the zeros", () => {
    expect(
      navCountsFrom({
        pendingSubmissions: 3,
        citiesAwaitingIntro: 0,
        pendingClaims: 1,
        openReports: 0,
        openRemovals: 2,
        reviewsAwaitingModeration: 5,
        pendingLeadRefunds: 4,
      }),
    ).toEqual({
      "/admin/submissions": 3,
      "/admin/claims": 1,
      "/admin/removals": 2,
      "/admin/reviews": 5,
      "/admin/leads": 4,
    });
  });
});

describe("adminNavCounts", () => {
  it("reads the seven queues in one statement and keys them by href", async () => {
    vi.resetModules();
    const one = vi.fn().mockResolvedValue({
      pendingSubmissions: 2, citiesAwaitingIntro: 0, pendingClaims: 0,
      openReports: 1, openRemovals: 0, reviewsAwaitingModeration: 0, pendingLeadRefunds: 0,
    });
    const sequential = vi.fn();
    vi.doMock("@/lib/db/queries/admin/dashboard", () => ({
      adminQueueCountsInOneQuery: one,
      adminQueueCounts: sequential,
    }));
    const { adminNavCounts } = await import("./nav-counts");
    const tx = { marker: "tx" } as unknown as Parameters<typeof adminNavCounts>[0];
    const viewer = { role: "admin", userId: "u" } as const;

    expect(await adminNavCounts(tx, viewer)).toEqual({ "/admin/submissions": 2, "/admin/reports": 1 });
    expect(one).toHaveBeenCalledTimes(1);
    expect(one).toHaveBeenCalledWith(tx, viewer);
    expect(sequential).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/db/queries/admin/dashboard");
  });
});

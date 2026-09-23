import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Viewer } from "@/lib/db/viewer";
import type { AdminQuoteRequest } from "@/lib/db/queries/quotes";

class NotFound extends Error {}

const currentViewer = vi.fn<() => Promise<Viewer>>();
const listQuoteRequests = vi.fn<() => Promise<AdminQuoteRequest[]>>();

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/db/client", () => ({ db: { marker: "the pool" } }));
vi.mock("@/lib/db/queries/admin/dashboard", () => ({
  adminQueueCounts: () =>
    Promise.resolve({
      pendingSubmissions: 0, citiesAwaitingIntro: 0, pendingClaims: 0,
      openReports: 0, openRemovals: 0, reviewsAwaitingModeration: 0,
    }),
}));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/db/queries/quotes", () => ({ listQuoteRequests: () => listQuoteRequests() }));

beforeEach(() => {
  vi.resetModules();
  currentViewer.mockReset();
  listQuoteRequests.mockReset().mockResolvedValue([]);
});

describe("/admin/quotes", () => {
  it.each<Viewer>([
    { role: "public" },
    { role: "user", userId: "user_1" },
    { role: "owner", userId: "user_2" },
  ])("404s for a $role viewer without running the query", async (viewer) => {
    currentViewer.mockResolvedValue(viewer);
    const { default: page } = await import("./page");

    await expect(page()).rejects.toThrow(NotFound);
    expect(listQuoteRequests).not.toHaveBeenCalled();
  });

  it("reads the requests for an admin", async () => {
    currentViewer.mockResolvedValue({ role: "admin", userId: "user_admin" });
    const { default: page } = await import("./page");

    await page();

    expect(listQuoteRequests).toHaveBeenCalled();
  });

  it("is never indexed", async () => {
    const { metadata } = await import("./page");
    expect(metadata.robots).toMatchObject({ index: false });
  });
});

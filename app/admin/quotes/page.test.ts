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
vi.mock("@/lib/db/queries/admin/dashboard", () => {
  const counts = {
      pendingSubmissions: 0, citiesAwaitingIntro: 0, pendingClaims: 0,
      openReports: 0, openRemovals: 0, reviewsAwaitingModeration: 0,
    };
  return {
    adminQueueCounts: () => Promise.resolve(counts),
    // The nav reads the one-statement version (components/admin/nav-counts.ts).
    adminQueueCountsInOneQuery: () => Promise.resolve(counts),
  };
});
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

  it("marks a request still waiting for the requester's click, and one that expired unsent", async () => {
    currentViewer.mockResolvedValue({ role: "admin", userId: "user_admin" });
    const row = (id: string, status: AdminQuoteRequest["status"]): AdminQuoteRequest => ({
      id, createdAt: new Date("2026-09-25T10:00:00Z"), name: "Sam", email: "sam@example.co.uk", phone: null,
      message: "A job", cityName: "Bath", categoryName: "Barns", recipientCount: 2, wonCount: 0,
      isSpam: false, status,
    });
    listQuoteRequests.mockResolvedValue([
      row("11111111-1111-4111-8111-111111111111", "pending"),
      row("22222222-2222-4222-8222-222222222222", "expired"),
      row("33333333-3333-4333-8333-333333333333", "verified"),
    ]);
    const { default: page } = await import("./page");
    const { elements, text } = await import("@/test/elements");

    const tree = await page();
    const rows = [...elements(tree)].filter(
      (el) => (el.props as Record<string, unknown>)["data-testid"] === "quote-request-row",
    );

    expect(rows.map((r) => (r.props as Record<string, unknown>)["data-status"])).toEqual(["pending", "expired", "verified"]);
    expect(text(rows[0])).toMatch(/Awaiting the requester/);
    expect(text(rows[1])).toMatch(/Never confirmed/);
    expect(text(rows[2])).not.toMatch(/Awaiting|Never confirmed/);
  });

  it("is never indexed", async () => {
    const { metadata } = await import("./page");
    expect(metadata.robots).toMatchObject({ index: false });
  });
});

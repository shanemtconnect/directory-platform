import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { Viewer } from "@/lib/db/viewer";
import { elements, text } from "@/test/elements";

class NotFound extends Error {}
let flagOn = true;
const currentViewer = vi.fn<() => Promise<Viewer>>();
const adminRefundQueue = vi.fn();

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/features/flags", () => ({
  get features() {
    return { leadMarketplace: flagOn };
  },
}));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/actions/leads", () => ({ decideRefundAction: vi.fn(), adminDeleteLeadAction: vi.fn() }));
vi.mock("@/components/admin/nav-counts", () => ({ adminNavCounts: async () => ({}) }));
vi.mock("@/lib/db/queries/lead-market", () => ({
  adminLeadCounts: async () => ({ open: 3, sold: 2, expired: 1, pendingRefunds: 1 }),
  adminRefundQueue: (...a: unknown[]) => adminRefundQueue(...a),
  adminBuyers: async () => [],
  adminRecentLeads: async () => recent,
}));

let recent: unknown[] = [];
const ROW = {
  refundId: "r1", requestedAt: new Date(), reason: "dead_phone", note: "Unobtainable", leadId: "l1", firstName: "Sam",
  brief: "Eighty guests", cityName: "Leeds", priceCents: 2500, boughtAt: new Date(), buyerName: "Pat", buyerEmail: "pat@example.com",
  listingName: "Pat's Place", buyer: { purchases: 2, refundRequests: 1, rate: 0.5, flagged: true },
};

beforeEach(() => {
  vi.resetModules();
  flagOn = true;
  currentViewer.mockReset().mockResolvedValue({ role: "admin", userId: "a1" });
  adminRefundQueue.mockReset().mockResolvedValue([ROW]);
  recent = [];
});

async function render() {
  const { default: page } = await import("./page");
  return (await page({ searchParams: Promise.resolve({}) })) as ReactElement;
}

describe("/admin/leads", () => {
  it("is a 404 with the flag off and for anyone not an admin", async () => {
    flagOn = false;
    await expect(render()).rejects.toThrow(NotFound);
    flagOn = true;
    currentViewer.mockResolvedValue({ role: "owner", userId: "u" });
    await expect(render()).rejects.toThrow(NotFound);
    expect(adminRefundQueue).not.toHaveBeenCalled();
  });

  it("shows the queue with the buyer's rate flagged above a third, and both decisions", async () => {
    const tree = await render();
    const all = text(tree);
    expect(all).toContain("The phone number is dead or not in service");
    expect(all).toContain("50%");
    const flags = [...elements(tree)].filter((el) => (el.props as Record<string, unknown>)["data-testid"] === "refund-rate-flag");
    expect(flags).toHaveLength(1);
    expect(all).toContain("Approve refund");
    expect(all).toContain("Reject");
  });

  it("an unflagged buyer has no ⚠", async () => {
    adminRefundQueue.mockResolvedValue([{ ...ROW, buyer: { purchases: 3, refundRequests: 1, rate: 1 / 3, flagged: false } }]);
    const tree = await render();
    expect([...elements(tree)].some((el) => (el.props as Record<string, unknown>)["data-testid"] === "refund-rate-flag")).toBe(false);
  });

  it("marks a refunded sale and offers Delete only for unsold leads", async () => {
    const base = { createdAt: new Date(), source: "quote", firstName: "Sam", brief: "b", cityName: "Leeds", categoryName: null, priceCents: 2500 };
    recent = [
      { ...base, id: "sold1", status: "sold", soldToListingName: "Pat's Place", refunded: true },
      { ...base, id: "open1", status: "open", soldToListingName: null, refunded: false },
    ];
    const tree = await render();
    const rows = [...elements(tree)].filter((el) => (el.props as Record<string, unknown>)["data-testid"] === "recent-lead-row");
    expect(text(rows[0])).toContain("sold to Pat's Place · refunded");
    expect(text(rows[0])).not.toContain("Delete");
    expect(text(rows[1])).toContain("Delete");
  });
});

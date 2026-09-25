import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { Viewer } from "@/lib/db/viewer";
import { siteConfig } from "@/config/site.config";
import { text } from "@/test/elements";

class NotFound extends Error {}
let flagOn = true;
const currentViewer = vi.fn<() => Promise<Viewer>>();
const myPurchases = vi.fn();

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));
vi.mock("@/lib/features/flags", () => ({
  get features() {
    return { leadMarketplace: flagOn };
  },
}));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/actions/leads", () => ({
  saveStandingOrderAction: vi.fn(), setStandingOrderStatusAction: vi.fn(), deleteStandingOrderAction: vi.fn(), setLeadDigestAction: vi.fn(),
}));
vi.mock("@/lib/db/queries/lead-market", () => ({
  myPurchases: (...a: unknown[]) => myPurchases(...a),
  standingOrdersFor: async () => [{
    id: "o1", listingId: "l1", listingName: "Mine", territories: [{ kind: "national" }], categoryIds: null, priceCents: 3000,
    status: "paused", pausedReason: "no_credit", wonCount: 2, createdAt: new Date(),
  }],
  standingOrderOptions: async () => ({ regions: [{ slug: "west-yorkshire", name: "West Yorkshire" }], cities: [], categories: [] }),
  buyerContext: async () => ({ profileId: "p1", balanceCents: 1000, listings: [{ id: "l1", name: "Mine" }], digestOptOut: false }),
}));

beforeEach(() => {
  vi.resetModules();
  flagOn = true;
  currentViewer.mockReset().mockResolvedValue({ role: "owner", userId: "u1" });
  myPurchases.mockReset().mockResolvedValue([{
    purchaseId: "pu1", leadId: "le1", boughtAt: new Date(), priceCents: 2500, firstName: "Sam", brief: "Eighty guests",
    cityName: "Leeds", categoryName: null, listingName: "Mine", viaStandingOrder: true,
    refund: { id: "r1", status: "pending", reason: "bounced", decisionNote: null }, refundable: false, viewable: true,
  }]);
});

async function render() {
  const { default: page } = await import("./page");
  return (await page({ searchParams: Promise.resolve({}) })) as ReactElement;
}

describe("/account/leads", () => {
  it("is a 404 with the flag off, and sends a signed-out visitor to sign in", async () => {
    flagOn = false;
    await expect(render()).rejects.toThrow(NotFound);
    flagOn = true;
    currentViewer.mockResolvedValue({ role: "public" });
    await expect(render()).rejects.toThrow("NEXT_REDIRECT /login?next=/account/leads");
  });

  it("lists purchases with their refund state, and orders with their pause reason, the floor and the editor", async () => {
    const all = text(await render());
    expect(all).toContain("Sam in Leeds");
    expect(all).toContain("Reported, being checked");
    expect(all).toContain("Paused: not enough credit");
    expect(all).toContain("Everywhere");
    expect(all).toContain("Resume");
    expect(all).toContain("(the floor)");
    expect(all).toContain(String(siteConfig.leads.floor));
    expect(all).toContain("West Yorkshire");
  });
});

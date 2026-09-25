import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { Viewer } from "@/lib/db/viewer";
import { siteConfig } from "@/config/site.config";
import { elements, links, text } from "@/test/elements";

/**
 * /leads, /leads/page/<n> and /leads/<id>: flag-gated, signed-in only, and
 * no contact field anywhere on the board.
 */

class NotFound extends Error {}
let flagOn = true;
const currentViewer = vi.fn<() => Promise<Viewer>>();
const boardLeads = vi.fn();
const buyerContext = vi.fn();
const purchasedLead = vi.fn();

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
  permanentRedirect: (url: string) => {
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
vi.mock("@/lib/actions/leads", () => ({ buyLeadAction: vi.fn(), reportLeadAction: vi.fn() }));
vi.mock("@/lib/db/queries/lead-market", () => ({
  boardLeads: (...a: unknown[]) => boardLeads(...a),
  buyerContext: (...a: unknown[]) => buyerContext(...a),
  purchasedLead: (...a: unknown[]) => purchasedLead(...a),
}));

const LEAD = {
  id: "3f0c1a52-6d1e-4b8a-9c2f-1a2b3c4d5e6f", firstName: "Sam", brief: "Eighty guests in June.", cityName: "Leeds",
  categoryName: "Barn Venues", createdAt: new Date(), priceCents: 2500, halfPrice: false,
};
const CHEAP = { ...LEAD, id: "4f0c1a52-6d1e-4b8a-9c2f-1a2b3c4d5e6f", priceCents: 1250, halfPrice: true };

beforeEach(() => {
  vi.resetModules();
  flagOn = true;
  currentViewer.mockReset().mockResolvedValue({ role: "owner", userId: "u1" });
  boardLeads.mockReset().mockResolvedValue({ leads: [LEAD, CHEAP], total: 2, page: 1, pages: 1 });
  buyerContext.mockReset().mockResolvedValue({ profileId: "p1", balanceCents: 2000, listings: [{ id: "l1", name: "Mine" }], digestOptOut: false });
  purchasedLead.mockReset();
});

async function board(searchParams: Record<string, string> = {}) {
  const { default: page } = await import("./page");
  return (await page({ searchParams: Promise.resolve(searchParams) })) as ReactElement;
}

describe("/leads", () => {
  it("is a 404 with the flag off, and reads nothing", async () => {
    flagOn = false;
    await expect(board()).rejects.toThrow(NotFound);
    expect(boardLeads).not.toHaveBeenCalled();
  });

  it("shows a signed-out visitor the teaser with a sign-in link, and reads no leads", async () => {
    currentViewer.mockResolvedValue({ role: "public" });
    const tree = await board();
    const teaser = [...elements(tree)].find((n) => (n.props as { "data-testid"?: string })["data-testid"] === "lead-board-teaser");
    expect(teaser, "the signed-out board is a 200 teaser, not a redirect").toBeTruthy();
    expect(links(tree).map((l) => l.href)).toContain("/login?next=%2Fleads");
    expect(boardLeads).not.toHaveBeenCalled();
  });

  it("offers a buy button where credit covers the price and a top-up where it does not", async () => {
    const tree = await board();
    const rows = [...elements(tree)].filter((el) => (el.props as Record<string, unknown>)["data-testid"] === "lead-row");
    expect(rows).toHaveLength(2);
    const [dear, cheap] = rows;
    expect(links(dear).map((l) => l.href)).toContain("/account/credit");
    expect(text(dear)).toContain("Top up to buy");
    expect(text(cheap)).toContain("Buy for");
    expect(text(cheap)).toContain("(half price)");
    expect(text(tree)).toContain("Eighty guests in June.");
  });

  it("prints the refund and no-refund policy", async () => {
    const all = text(await board());
    expect(all).toContain("The phone number is dead or not in service");
    expect(all).toContain("The customer chose someone else");
    expect(all).toContain("never as cash");
  });

  it("says why a buy did not go through", async () => {
    expect(text(await board({ buy: "insufficient" }))).toContain("You do not have enough credit");
  });

  it("tells an account with no listing how to get one instead of showing buy buttons", async () => {
    buyerContext.mockResolvedValue({ profileId: "p1", balanceCents: 99_999, listings: [], digestOptOut: false });
    const all = text(await board());
    expect(all).toContain("Claim or add yours");
    expect(all).not.toContain("Buy for");
  });
});

describe("/leads/page/<n>", () => {
  it("sends page 1 to /leads and refuses junk", async () => {
    const { default: page } = await import("./page/[page]/page");
    await expect(page({ params: Promise.resolve({ page: "1" }), searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT /leads");
    await expect(page({ params: Promise.resolve({ page: "x" }), searchParams: Promise.resolve({}) })).rejects.toThrow(NotFound);
  });

  it("404s past the last page", async () => {
    const { default: page } = await import("./page/[page]/page");
    await expect(page({ params: Promise.resolve({ page: "4" }), searchParams: Promise.resolve({}) })).rejects.toThrow(NotFound);
  });
});

describe("/leads/<id>", () => {
  const params = { params: Promise.resolve({ id: LEAD.id }), searchParams: Promise.resolve({}) };

  it("is a 404 for anyone but the buyer", async () => {
    purchasedLead.mockResolvedValue(null);
    const { default: page } = await import("./[id]/page");
    await expect(page(params)).rejects.toThrow(NotFound);
  });

  it("shows the buyer the contact details and the report form while the window is open", async () => {
    purchasedLead.mockResolvedValue({
      leadId: LEAD.id, purchaseId: "pu1", boughtAt: new Date(), priceCents: 2500, firstName: "Sam", brief: "Eighty guests.",
      contact: { name: "Sam Requester", email: "sam@example.co.uk", phone: "01632 970001", message: "Eighty guests." },
      contactPurgedAt: null, cityName: "Leeds", categoryName: null, createdAt: new Date(), refund: null, refundable: true,
    });
    const { default: page } = await import("./[id]/page");
    const tree = (await page(params)) as ReactElement;
    const all = text(tree);
    expect(all).toContain("sam@example.co.uk");
    expect(all).toContain("01632 970001");
    expect(all).toContain("Report this lead");
    expect(links(tree).map((l) => l.href)).toContain("mailto:sam@example.co.uk");
  });

  it("after the purge, says the details have expired and points at the won email, showing only the brief", async () => {
    purchasedLead.mockResolvedValue({
      leadId: LEAD.id, purchaseId: "pu1", boughtAt: new Date(), priceCents: 2500, firstName: "Sam", brief: "Eighty guests.",
      contact: null, contactPurgedAt: new Date(), cityName: "Leeds", categoryName: null, createdAt: new Date(),
      refund: { id: "r1", status: "rejected", reason: "wrong_area", decisionNote: null }, refundable: false,
    });
    const { default: page } = await import("./[id]/page");
    const tree = (await page(params)) as ReactElement;
    const all = text(tree);
    expect(all).toContain("The contact details for this lead have expired");
    expect(all).toContain(`${siteConfig.leads.retainSoldDays} days`);
    expect(all).toContain("The email we sent you when you bought it has them.");
    expect(all).toContain("Sam in Leeds");
    expect(all).toContain("Eighty guests.");
    expect(links(tree).some((l) => l.href.startsWith("mailto:") || l.href.startsWith("tel:"))).toBe(false);
  });

  it("sends a signed-out visitor to sign in first", async () => {
    currentViewer.mockResolvedValue({ role: "public" });
    const { default: page } = await import("./[id]/page");
    await expect(page(params)).rejects.toThrow(`NEXT_REDIRECT /login?next=${encodeURIComponent(`/leads/${LEAD.id}`)}`);
    expect(purchasedLead).not.toHaveBeenCalled();
  });
});

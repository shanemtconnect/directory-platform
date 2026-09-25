import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/db/viewer";

/** The lead market's server actions: flag gate, sign-in gate, form parsing, and where each outcome lands. */

const q = {
  buyLead: vi.fn(),
  requestRefund: vi.fn(),
  createStandingOrder: vi.fn(),
  updateStandingOrder: vi.fn(),
  setStandingOrderStatus: vi.fn(),
  deleteStandingOrder: vi.fn(),
  decideRefund: vi.fn(),
  adminDeleteLead: vi.fn(),
  setLeadDigestOptOut: vi.fn(),
};
let viewer: Viewer = { role: "owner", userId: "u1" };
let flagOn = true;
const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT ${url}`);
});

vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/features/flags", () => ({
  get features() {
    return { leadMarketplace: flagOn };
  },
}));
vi.mock("@/lib/auth/viewer", () => ({
  currentViewer: async () => viewer,
  requireAdmin: async () => {
    if (viewer.role !== "admin") throw new Error("NOT_FOUND");
    return viewer;
  },
}));
vi.mock("@/lib/auth/profile", () => ({ ensureProfile: async () => ({ id: "p1", role: "owner" }) }));
vi.mock("@/lib/db/client", () => ({ db: { transaction: async (fn: (tx: unknown) => unknown) => fn({}) } }));
vi.mock("@/lib/db/queries/lead-market", () => Object.fromEntries(Object.entries(q).map(([k, f]) => [k, (...a: unknown[]) => f(...a)])));

const actions = await import("./leads");

const LEAD = "3f0c1a52-6d1e-4b8a-9c2f-1a2b3c4d5e6f";
const LISTING = "4f0c1a52-6d1e-4b8a-9c2f-1a2b3c4d5e6f";
const CITY = "5f0c1a52-6d1e-4b8a-9c2f-1a2b3c4d5e6f";
const CAT = "6f0c1a52-6d1e-4b8a-9c2f-1a2b3c4d5e6f";

function form(entries: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

beforeEach(() => {
  flagOn = true;
  viewer = { role: "owner", userId: "u1" };
  redirect.mockClear();
  for (const f of Object.values(q)) f.mockReset();
});

describe("flag and sign-in gates", () => {
  it("every action 404s with the flag off", async () => {
    flagOn = false;
    await expect(actions.buyLeadAction(form([]))).rejects.toThrow("NOT_FOUND");
    await expect(actions.reportLeadAction(form([]))).rejects.toThrow("NOT_FOUND");
    await expect(actions.saveStandingOrderAction(form([]))).rejects.toThrow("NOT_FOUND");
    await expect(actions.decideRefundAction(form([]))).rejects.toThrow("NOT_FOUND");
    expect(q.buyLead).not.toHaveBeenCalled();
  });

  it("a signed-out buyer is sent to sign in", async () => {
    viewer = { role: "public" };
    await expect(actions.buyLeadAction(form([["leadId", LEAD], ["listingId", LISTING]]))).rejects.toThrow("REDIRECT /login?next=/leads");
    expect(q.buyLead).not.toHaveBeenCalled();
  });
});

describe("buyLeadAction", () => {
  it("lands on the lead's page once bought", async () => {
    q.buyLead.mockResolvedValue({ outcome: "bought", purchaseId: "x" });
    await expect(actions.buyLeadAction(form([["leadId", LEAD], ["listingId", LISTING]]))).rejects.toThrow(`REDIRECT /leads/${LEAD}`);
    expect(q.buyLead).toHaveBeenCalledWith({}, viewer, LEAD, LISTING);
  });

  it("short of credit: back to the board with the top-up message", async () => {
    q.buyLead.mockResolvedValue({ outcome: "insufficient", balanceCents: 100, neededCents: 2500 });
    await expect(actions.buyLeadAction(form([["leadId", LEAD], ["listingId", LISTING], ["page", "3"]]))).rejects.toThrow("REDIRECT /leads/page/3?buy=insufficient");
  });
});

describe("reportLeadAction", () => {
  it("files the report and lands back on the lead", async () => {
    q.requestRefund.mockResolvedValue({ outcome: "requested", refundId: "r1" });
    await expect(actions.reportLeadAction(form([["leadId", LEAD], ["reason", "dead_phone"], ["note", "No ring tone"]]))).rejects.toThrow(`REDIRECT /leads/${LEAD}?report=requested`);
    expect(q.requestRefund).toHaveBeenCalledWith({}, viewer, { leadId: LEAD, reason: "dead_phone", note: "No ring tone" });
  });
});

describe("saveStandingOrderAction", () => {
  it("parses places, categories and a decimal price into a new order", async () => {
    q.createStandingOrder.mockResolvedValue({ outcome: "saved", id: "o1" });
    const f = form([
      ["listingId", LISTING], ["territories", `city:${CITY}`], ["territories", "region:west-yorkshire"],
      ["territories", "junk"], ["categories", CAT], ["price", "30.50"],
    ]);
    await expect(actions.saveStandingOrderAction(f)).rejects.toThrow("REDIRECT /account/leads?order=saved");
    expect(q.createStandingOrder).toHaveBeenCalledWith({}, viewer, {
      listingId: LISTING,
      territories: [{ kind: "city", id: CITY }, { kind: "region", id: "west-yorkshire" }],
      categoryIds: [CAT],
      priceCents: 3050,
    });
  });

  it("edits an existing order when it carries an id, and reports the first invalid field", async () => {
    q.updateStandingOrder.mockResolvedValue({ outcome: "invalid", errors: { price: "too low" } });
    const f = form([["orderId", LEAD], ["territories", "national"], ["price", "1"]]);
    await expect(actions.saveStandingOrderAction(f)).rejects.toThrow("REDIRECT /account/leads?order=invalid-price");
    expect(q.updateStandingOrder).toHaveBeenCalledWith({}, viewer, LEAD, { territories: [{ kind: "national" }], categoryIds: null, priceCents: 100 });
  });

  it("refuses a price that is not an amount without calling the query", async () => {
    await expect(actions.saveStandingOrderAction(form([["listingId", LISTING], ["territories", "national"], ["price", "-5"]]))).rejects.toThrow("REDIRECT /account/leads?order=invalid-price");
    expect(q.createStandingOrder).not.toHaveBeenCalled();
  });
});

describe("decideRefundAction", () => {
  it("is for admins only", async () => {
    await expect(actions.decideRefundAction(form([["refundId", LEAD], ["decision", "approve"]]))).rejects.toThrow("NOT_FOUND");
    expect(q.decideRefund).not.toHaveBeenCalled();
  });

  it("approves or rejects with the note", async () => {
    viewer = { role: "admin", userId: "a1" };
    q.decideRefund.mockResolvedValue({ outcome: "rejected" });
    await expect(actions.decideRefundAction(form([["refundId", LEAD], ["decision", "reject"], ["note", "Rang fine"]]))).rejects.toThrow("REDIRECT /admin/leads?refund=rejected");
    expect(q.decideRefund).toHaveBeenCalledWith({}, viewer, LEAD, { approve: false, note: "Rang fine", ip: null });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/db/viewer";

/**
 * Flag off: /account/credit and its return and cancel pages are 404s, and
 * the return page never reaches PayPal or the ledger.
 */

class NotFound extends Error {}

const currentViewer = vi.fn<() => Promise<Viewer>>();
const settleTopupOrder = vi.fn();
const creditBalance = vi.fn();
let flagOn = false;

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("@/lib/db/client", () => ({ db: { transaction: vi.fn() } }));
vi.mock("@/lib/features/flags", () => ({
  get features() {
    return { leadMarketplace: flagOn };
  },
}));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer(), requireAdmin: () => currentViewer() }));
vi.mock("@/lib/billing/credit-topup", async (orig) => ({
  ...(await orig<typeof import("@/lib/billing/credit-topup")>()),
  settleTopupOrder: (...a: unknown[]) => settleTopupOrder(...a),
}));
vi.mock("@/lib/db/queries/credits", () => ({
  creditBalance: (...a: unknown[]) => creditBalance(...a),
  creditLedgerFor: vi.fn(),
  adminAdjust: vi.fn(),
  profileIdByEmail: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  flagOn = false;
  currentViewer.mockReset().mockResolvedValue({ role: "user", userId: "u1" });
  settleTopupOrder.mockReset();
  creditBalance.mockReset();
});

describe("lead credit pages with the flag off", () => {
  it("/account/credit is a 404 and reads nothing", async () => {
    const { default: page } = await import("./page");
    await expect(page({ searchParams: Promise.resolve({}) })).rejects.toThrow(NotFound);
    expect(currentViewer).not.toHaveBeenCalled();
    expect(creditBalance).not.toHaveBeenCalled();
  });

  it("/account/credit/return is a 404 and settles nothing", async () => {
    const { default: page } = await import("./return/page");
    await expect(page({ searchParams: Promise.resolve({ token: "8TOPUP0127TN3647" }) })).rejects.toThrow(NotFound);
    expect(settleTopupOrder).not.toHaveBeenCalled();
  });

  it("/account/credit/cancelled is a 404", async () => {
    const { default: page } = await import("./cancelled/page");
    expect(() => page()).toThrow(NotFound);
  });

  it("the top-up action refuses", async () => {
    const { startTopupAction } = await import("@/lib/actions/credits");
    const form = new FormData();
    form.set("packCents", "5000");
    await expect(startTopupAction(form)).rejects.toThrow("NOT_FOUND");
  });
});

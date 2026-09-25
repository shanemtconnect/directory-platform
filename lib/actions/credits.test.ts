import { beforeEach, describe, expect, it, vi } from "vitest";

/** The admin adjust form: amounts are parsed exactly, never rounded, and bad ones never reach the ledger. */

const adminAdjust = vi.fn();
const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT ${url}`);
});

vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/features/flags", () => ({ features: { leadMarketplace: true } }));
vi.mock("@/lib/auth/viewer", () => ({
  currentViewer: async () => ({ role: "admin", userId: "admin_1" }),
  requireAdmin: async () => ({ role: "admin", userId: "admin_1" }),
}));
vi.mock("@/lib/db/client", () => ({ db: { transaction: async (fn: (tx: unknown) => unknown) => fn({}) } }));
vi.mock("@/lib/db/queries/credits", () => ({
  adminAdjust: (...a: unknown[]) => adminAdjust(...a),
  profileIdByEmail: vi.fn(),
}));

const { adminAdjustAction } = await import("./credits");

const USER = "3f0c1a52-6d1e-4b8a-9c2f-1a2b3c4d5e6f";

function form(amount: string): FormData {
  const f = new FormData();
  f.set("userId", USER);
  f.set("amount", amount);
  f.set("note", "Goodwill");
  return f;
}

beforeEach(() => {
  adminAdjust.mockReset().mockResolvedValue({ outcome: "adjusted", balanceCents: 0 });
  redirect.mockClear();
});

describe("adminAdjustAction", () => {
  it("passes an exact decimal through as whole cents", async () => {
    await expect(adminAdjustAction(form("-10.50"))).rejects.toThrow("REDIRECT /admin/credit?adjust=adjusted");
    expect(adminAdjust).toHaveBeenCalledWith({}, { role: "admin", userId: "admin_1" }, expect.objectContaining({ userId: USER, cents: -1050 }));
  });

  it.each(["10.005", "abc", "1e9", "99999999999999999999"])("refuses %s without touching the ledger", async (amount) => {
    await expect(adminAdjustAction(form(amount))).rejects.toThrow("REDIRECT /admin/credit?adjust=invalid-amount");
    expect(adminAdjust).not.toHaveBeenCalled();
  });
});

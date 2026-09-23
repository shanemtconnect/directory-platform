import { describe, it, expect, vi, beforeEach } from "vitest";
import { FEATURE_FLAGS } from "@/config/types";
import type { Viewer } from "@/lib/db/viewer";
import type { ComputeAwardsResult, RevokeAwardResult } from "@/lib/db/queries/awards";

/**
 * The two admin actions (Task 50): the admin gate runs first, the flag gate
 * second, the form is validated before a transaction opens, and the right
 * pages are busted afterwards. The query functions are mocked; their own
 * tests cover what they write.
 */

const requireAdmin = vi.fn<() => Promise<Viewer & { role: "admin" }>>();
const computeAwardsForYear = vi.fn<(year: number, opts: { ip?: string | null }) => Promise<ComputeAwardsResult>>();
const revokeAward = vi.fn<(awardId: string, input: { reason: string; ip: string | null }) => Promise<RevokeAwardResult>>();
const listingPaths = vi.fn<(id: string) => Promise<string[]>>();
const revalidatePath = vi.fn<(p: string) => void>();

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "203.0.113.9" })) }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("@/lib/db/client", () => ({
  db: { transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ marker: "tx" }) },
}));
vi.mock("@/lib/auth/viewer", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/queries/awards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/queries/awards")>()),
  computeAwardsForYear: (_tx: unknown, _viewer: unknown, year: number, opts: { ip?: string | null }) =>
    computeAwardsForYear(year, opts),
  revokeAward: (_tx: unknown, _viewer: unknown, awardId: string, input: { reason: string; ip: string | null }) =>
    revokeAward(awardId, input),
}));
vi.mock("@/lib/db/queries/paths", () => ({
  listingPaths: (_tx: unknown, _viewer: unknown, id: string) => listingPaths(id),
}));

function flags(awards: boolean) {
  const map = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, f === "reviews"])) as Record<string, boolean>;
  map.awards = awards;
  vi.doMock("@/lib/features/flags", () => ({ features: map, isEnabled: (f: string) => map[f] }));
}

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const AWARD = "11111111-1111-4111-8111-111111111111";
const IDLE = { status: "idle" as const };

beforeEach(() => {
  vi.resetModules();
  requireAdmin.mockReset().mockResolvedValue({ role: "admin", userId: "user_admin" });
  computeAwardsForYear.mockReset();
  revokeAward.mockReset();
  listingPaths.mockReset().mockResolvedValue(["/leeds/the-old-barn", "/leeds"]);
  revalidatePath.mockReset();
});

describe("computeAwardsAction", () => {
  it("requires an admin before anything else", async () => {
    flags(true);
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    const { computeAwardsAction } = await import("./admin-awards");
    await expect(computeAwardsAction(IDLE, form({ year: "2031" }))).rejects.toThrow("FORBIDDEN");
    expect(computeAwardsForYear).not.toHaveBeenCalled();
  });

  it("refuses with the flag off and refuses a bad year, without a transaction", async () => {
    flags(false);
    const off = await import("./admin-awards");
    expect((await off.computeAwardsAction(IDLE, form({ year: "2031" }))).status).toBe("error");

    vi.resetModules();
    flags(true);
    const on = await import("./admin-awards");
    expect((await on.computeAwardsAction(IDLE, form({ year: "20x1" }))).status).toBe("error");
    expect(computeAwardsForYear).not.toHaveBeenCalled();
  });

  it("computes the year and busts the index, the year, each town and each winner", async () => {
    flags(true);
    computeAwardsForYear.mockResolvedValue({
      year: 2031,
      skipped: 1,
      created: [{ awardId: AWARD, listingId: "l1", cityId: "c1", citySlug: "leeds", categoryId: "k1" }],
    });
    const { computeAwardsAction } = await import("./admin-awards");
    const state = await computeAwardsAction(IDLE, form({ year: "2031" }));
    expect(state.status).toBe("done");
    expect(state.message).toContain("1 award decided for 2031");
    // The admin's ip reaches the audit row (constraint 22).
    expect(computeAwardsForYear).toHaveBeenCalledWith(2031, { ip: "203.0.113.9" });
    const busted = revalidatePath.mock.calls.map((c) => c[0]);
    for (const p of ["/admin/awards", "/awards", "/awards/2031", "/awards/2031/leeds", "/leeds/the-old-barn", "/leeds"]) {
      expect(busted).toContain(p);
    }
  });

  it("reports an already-decided year and busts only the console", async () => {
    flags(true);
    computeAwardsForYear.mockResolvedValue({ year: 2031, skipped: 3, created: [] });
    const { computeAwardsAction } = await import("./admin-awards");
    const state = await computeAwardsAction(IDLE, form({ year: "2031" }));
    expect(state.status).toBe("done");
    expect(state.message).toContain("already decided");
    expect(revalidatePath.mock.calls.map((c) => c[0])).toEqual(["/admin/awards"]);
  });
});

describe("revokeAwardAction", () => {
  it("needs a reason, and a real id, before a transaction", async () => {
    flags(true);
    const { revokeAwardAction } = await import("./admin-awards");
    expect((await revokeAwardAction(IDLE, form({ awardId: AWARD, reason: "   " }))).status).toBe("error");
    expect((await revokeAwardAction(IDLE, form({ awardId: "nope", reason: "bought" }))).status).toBe("error");
    expect((await revokeAwardAction(IDLE, form({ awardId: AWARD, reason: "x".repeat(501) }))).status).toBe("error");
    expect(revokeAward).not.toHaveBeenCalled();
  });

  it("revokes with the reason and the ip, then busts the award pages and the listing", async () => {
    flags(true);
    revokeAward.mockResolvedValue({ outcome: "revoked", listingId: "l1", year: 2031, citySlug: "leeds" });
    const { revokeAwardAction } = await import("./admin-awards");
    const state = await revokeAwardAction(IDLE, form({ awardId: AWARD, reason: "Reviews were bought" }));
    expect(state.status).toBe("done");
    expect(revokeAward).toHaveBeenCalledWith(AWARD, { reason: "Reviews were bought", ip: "203.0.113.9" });
    const busted = revalidatePath.mock.calls.map((c) => c[0]);
    for (const p of ["/admin/awards", "/admin/awards/2031", "/awards", "/awards/2031", "/awards/2031/leeds", "/leeds/the-old-barn"]) {
      expect(busted).toContain(p);
    }
  });

  it("tells the admin when it was already revoked or is gone, and busts nothing", async () => {
    flags(true);
    const { revokeAwardAction } = await import("./admin-awards");
    revokeAward.mockResolvedValue({ outcome: "already-revoked" });
    expect((await revokeAwardAction(IDLE, form({ awardId: AWARD, reason: "again" }))).message).toContain("already revoked");
    revokeAward.mockResolvedValue({ outcome: "not-found" });
    expect((await revokeAwardAction(IDLE, form({ awardId: AWARD, reason: "gone" }))).status).toBe("error");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SponsorDecisionResult } from "@/lib/db/queries/ads";
import type { Viewer } from "@/lib/db/viewer";

const requireAdmin = vi.fn<() => Promise<Viewer>>();
const decideSponsorCampaign = vi.fn<(...a: unknown[]) => Promise<SponsorDecisionResult>>();
const notifySponsorDecided = vi.fn<(...a: unknown[]) => Promise<void>>();
const revalidatePath = vi.fn<(p: string) => void>();
const HANDLE = { marker: "tx" };

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "203.0.113.9" })) }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("@/lib/db/client", () => ({ db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(HANDLE) } }));
vi.mock("@/lib/auth/viewer", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/queries/ads", () => ({
  decideSponsorCampaign: (...a: unknown[]) => decideSponsorCampaign(...a),
}));
vi.mock("@/lib/email/notify", () => ({ notifySponsorDecided: (...a: unknown[]) => notifySponsorDecided(...a) }));

const ADMIN: Viewer = { role: "admin", userId: "u_admin" };
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return data;
}

beforeEach(() => {
  vi.resetModules();
  requireAdmin.mockReset().mockResolvedValue(ADMIN);
  decideSponsorCampaign.mockReset().mockResolvedValue({ outcome: "decided" });
  notifySponsorDecided.mockReset().mockResolvedValue();
  revalidatePath.mockReset();
});

describe("admin sponsor actions", () => {
  it("re-checks the admin before touching anything", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    const { approveSponsorAction } = await import("./admin-sponsors");
    await expect(approveSponsorAction({ status: "idle" }, form({ campaignId: ID }))).rejects.toThrow("FORBIDDEN");
    expect(decideSponsorCampaign).not.toHaveBeenCalled();
  });

  it("approve carries the ip, announces the decision, and revalidates the queue", async () => {
    const { approveSponsorAction } = await import("./admin-sponsors");
    const out = await approveSponsorAction({ status: "idle" }, form({ campaignId: ID }));
    expect(out).toEqual({ status: "done" });
    expect(decideSponsorCampaign).toHaveBeenCalledWith(HANDLE, ADMIN, ID, { decision: "approve", reason: "", ip: "203.0.113.9" });
    expect(notifySponsorDecided).toHaveBeenCalledWith(HANDLE, ADMIN, ID);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/sponsors");
  });

  it("reject passes the reason; a missing reason surfaces the query's refusal and mails nobody", async () => {
    const { rejectSponsorAction } = await import("./admin-sponsors");
    await rejectSponsorAction({ status: "idle" }, form({ campaignId: ID, reason: "Not a real business." }));
    expect(decideSponsorCampaign.mock.calls[0]![3]).toMatchObject({ decision: "reject", reason: "Not a real business." });
    decideSponsorCampaign.mockResolvedValue({ outcome: "reason-required" });
    notifySponsorDecided.mockClear();
    const out = await rejectSponsorAction({ status: "idle" }, form({ campaignId: ID, reason: "" }));
    expect(out.status).toBe("error");
    expect(notifySponsorDecided).not.toHaveBeenCalled();
  });

  it("pause, resume and end are not announced to the advertiser", async () => {
    const { pauseSponsorAction, resumeSponsorAction, endSponsorAction } = await import("./admin-sponsors");
    for (const act of [pauseSponsorAction, resumeSponsorAction, endSponsorAction]) {
      expect(await act({ status: "idle" }, form({ campaignId: ID }))).toEqual({ status: "done" });
    }
    expect(decideSponsorCampaign.mock.calls.map((c) => (c[3] as { decision: string }).decision)).toEqual(["pause", "resume", "end"]);
    expect(notifySponsorDecided).not.toHaveBeenCalled();
  });

  it("a malformed id is refused before the database", async () => {
    const { endSponsorAction } = await import("./admin-sponsors");
    expect((await endSponsorAction({ status: "idle" }, form({ campaignId: "nope" }))).status).toBe("error");
    expect(decideSponsorCampaign).not.toHaveBeenCalled();
  });
});

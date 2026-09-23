import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitResult } from "@/lib/spam/rate-limit";
import type { CreateSponsorResult } from "@/lib/db/queries/ads";
import type { StartSponsorCheckoutResult } from "@/lib/ads/billing";
import type { Viewer } from "@/lib/db/viewer";

class Redirect extends Error {
  constructor(public readonly to: string) { super("NEXT_REDIRECT"); }
}

const currentViewer = vi.fn<() => Promise<Viewer>>();
const createSponsorCampaign = vi.fn<(...a: unknown[]) => Promise<CreateSponsorResult>>();
const notifySponsorSubmitted = vi.fn<(...a: unknown[]) => Promise<void>>();
const startSponsorCheckout = vi.fn<(...a: unknown[]) => Promise<StartSponsorCheckoutResult>>();
const limitPublicWrite = vi.fn<(...a: unknown[]) => Promise<RateLimitResult>>();
const revalidatePath = vi.fn<(p: string) => void>();
const HANDLE = { marker: "tx" };

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "203.0.113.9" })) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Redirect(to); } }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("@/lib/db/client", () => ({ db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(HANDLE) } }));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/auth/profile", () => ({ ensureProfile: async () => ({ id: "profile-1", role: "user" }) }));
vi.mock("@/lib/billing/paypal", () => ({ getPayPalClient: () => null }));
vi.mock("@/lib/ads/billing", () => ({ startSponsorCheckout: (...a: unknown[]) => startSponsorCheckout(...a) }));
vi.mock("@/lib/db/queries/ads", () => ({
  createSponsorCampaign: (...a: unknown[]) => createSponsorCampaign(...a),
  setSponsorLogo: async () => true,
  updateSponsorCampaign: async () => "updated",
}));
vi.mock("@/lib/email/notify", () => ({ notifySponsorSubmitted: (...a: unknown[]) => notifySponsorSubmitted(...a) }));
vi.mock("@/lib/spam/write-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spam/write-limit")>()),
  limitPublicWrite: (...args: unknown[]) => limitPublicWrite(...args),
}));

const USER: Viewer = { role: "user", userId: "u_1" };
const CAMPAIGN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    for (const item of Array.isArray(v) ? v : [v]) data.append(k, item);
  }
  return data;
}

const GOOD = {
  name: "Acme", title: "Acme does it", blurb: "Well.", targetUrl: "https://acme.example/",
  placements: ["search", "cityPillar"],
};

beforeEach(() => {
  vi.resetModules();
  currentViewer.mockReset().mockResolvedValue(USER);
  createSponsorCampaign.mockReset().mockResolvedValue({ outcome: "created", campaignId: CAMPAIGN_ID });
  notifySponsorSubmitted.mockReset().mockResolvedValue();
  startSponsorCheckout.mockReset().mockResolvedValue({ outcome: "not-configured" });
  limitPublicWrite.mockReset().mockResolvedValue({ allowed: true, remaining: 4, retryAfterSeconds: 0 });
  revalidatePath.mockReset();
});

describe("createSponsorCampaignAction", () => {
  it("refuses a signed-out visitor before anything else", async () => {
    currentViewer.mockResolvedValue({ role: "public" });
    const { createSponsorCampaignAction } = await import("./sponsor");
    const out = await createSponsorCampaignAction({ status: "idle" }, form(GOOD));
    expect(out.status).toBe("error");
    expect(limitPublicWrite).not.toHaveBeenCalled();
    expect(createSponsorCampaign).not.toHaveBeenCalled();
  });

  it("is rate limited under the sponsor budget", async () => {
    limitPublicWrite.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 600 });
    const { createSponsorCampaignAction } = await import("./sponsor");
    const out = await createSponsorCampaignAction({ status: "idle" }, form(GOOD));
    expect(out).toMatchObject({ status: "error", message: expect.stringContaining("Too many") });
    expect(limitPublicWrite.mock.calls[0]![2]).toEqual({ limit: 5, windowSeconds: 3600 });
    expect(createSponsorCampaign).not.toHaveBeenCalled();
  });

  it("creates, queues the admin email in the same transaction, and reports submitted when billing is off", async () => {
    const { createSponsorCampaignAction } = await import("./sponsor");
    const out = await createSponsorCampaignAction({ status: "idle" }, form(GOOD));
    expect(out).toEqual({ status: "submitted" });
    expect(createSponsorCampaign.mock.calls[0]![2]).toMatchObject({
      profileId: "profile-1", name: "Acme", title: "Acme does it", placements: ["search", "cityPillar"],
      logoPath: null, ip: "203.0.113.9",
    });
    expect(notifySponsorSubmitted).toHaveBeenCalledWith(HANDLE, USER, CAMPAIGN_ID);
    expect(revalidatePath).toHaveBeenCalledWith("/advertise/sponsor");
  });

  it("names the invalid field and queues nothing", async () => {
    createSponsorCampaign.mockResolvedValue({ outcome: "invalid", field: "targetUrl" });
    const { createSponsorCampaignAction } = await import("./sponsor");
    const out = await createSponsorCampaignAction({ status: "idle" }, form({ ...GOOD, targetUrl: "ftp://x" }));
    expect(out).toMatchObject({ status: "error", field: "targetUrl" });
    expect(notifySponsorSubmitted).not.toHaveBeenCalled();
  });

  it("redirects to PayPal when the checkout returns an approval link", async () => {
    startSponsorCheckout.mockResolvedValue({ outcome: "approval", approveUrl: "https://paypal/approve" });
    const { createSponsorCampaignAction } = await import("./sponsor");
    await expect(createSponsorCampaignAction({ status: "idle" }, form(GOOD))).rejects.toMatchObject({ to: "https://paypal/approve" });
    expect(startSponsorCheckout.mock.calls[0]![1]).toMatchObject({ campaignId: CAMPAIGN_ID, profileId: "profile-1" });
  });

  it("rejects a logo that is not an image without creating anything", async () => {
    const { createSponsorCampaignAction } = await import("./sponsor");
    const data = form(GOOD);
    data.append("logo", new File([Buffer.from("not an image at all")], "logo.png", { type: "image/png" }));
    const out = await createSponsorCampaignAction({ status: "idle" }, data);
    expect(out).toMatchObject({ status: "error", field: "logo" });
    expect(createSponsorCampaign).not.toHaveBeenCalled();
  });
});

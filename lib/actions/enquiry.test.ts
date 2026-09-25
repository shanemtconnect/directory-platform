import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnquiryResult } from "@/lib/db/queries/enquiries";
import type { Lead } from "@/lib/db/queries/leads";
import type { RateLimitResult } from "@/lib/spam/rate-limit";

/**
 * The enquiry action's lead branch (Task 56), with the database mocked out.
 * Which listings qualify — published, unclaimed, no email — is proved against
 * a real transaction in lib/db/queries/leads.test.ts (`createEnquiryLead`).
 * Here: the branch only runs with the flag on, the enquiry itself is written
 * and notified exactly as before either way, and the visitor sees "sent".
 */

const LISTING = "11111111-1111-4111-8111-111111111111";
const HANDLE = { marker: "the transaction" };
const LEAD = { id: "22222222-2222-4222-8222-222222222222", status: "open" } as Lead;

const createEnquiry = vi.fn<(...a: unknown[]) => Promise<EnquiryResult>>();
const notifyEnquiry = vi.fn<(...a: unknown[]) => Promise<void>>();
const createEnquiryLead = vi.fn<(...a: unknown[]) => Promise<Lead | null>>();
const runAfterLeadCreated = vi.fn<(...a: unknown[]) => Promise<boolean>>();
const rateLimit = vi.fn<(...a: unknown[]) => Promise<RateLimitResult>>();
let leadMarketplace = false;

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "203.0.113.9" })),
}));
vi.mock("@/lib/db/client", () => ({
  db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(HANDLE) },
}));
vi.mock("@/lib/features/flags", () => ({
  isEnabled: (flag: string) => flag === "leadMarketplace" && leadMarketplace,
}));
vi.mock("@/lib/db/queries/enquiries", () => ({ createEnquiry: (...a: unknown[]) => createEnquiry(...a) }));
vi.mock("@/lib/db/queries/leads", () => ({ createEnquiryLead: (...a: unknown[]) => createEnquiryLead(...a) }));
vi.mock("@/lib/leads/hooks", () => ({ runAfterLeadCreated: (...a: unknown[]) => runAfterLeadCreated(...a) }));
vi.mock("@/lib/email/notify", () => ({ notifyEnquiry: (...a: unknown[]) => notifyEnquiry(...a) }));
vi.mock("@/lib/spam/rate-limit", () => ({ rateLimit: (...a: unknown[]) => rateLimit(...a) }));
vi.mock("@/lib/spam/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spam/turnstile")>()),
  verifyTurnstile: async () => ({ ok: true, skipped: true }),
}));

function form(): FormData {
  const f = new FormData();
  f.set("listingId", LISTING);
  f.set("name", "Jo Enquirer");
  f.set("email", "jo@example.co.uk");
  f.set("phone", "01632 960123");
  f.set("message", "Is the hall free on 3 May?");
  return f;
}

async function submit() {
  const { submitEnquiry } = await import("./enquiry");
  return submitEnquiry({ status: "idle" }, form());
}

beforeEach(() => {
  vi.resetModules();
  leadMarketplace = false;
  createEnquiry.mockReset().mockResolvedValue({ outcome: "created", enquiryId: "e1" });
  notifyEnquiry.mockReset().mockResolvedValue(undefined);
  createEnquiryLead.mockReset().mockResolvedValue(LEAD);
  runAfterLeadCreated.mockReset().mockResolvedValue(true);
  rateLimit.mockReset().mockResolvedValue({ allowed: true, remaining: 4, retryAfterSeconds: 0 });
});

describe("submitEnquiry — the lead branch", () => {
  it("with the flag off, writes and notifies the enquiry as before and makes no lead", async () => {
    expect(await submit()).toEqual({ status: "sent" });
    expect(createEnquiry).toHaveBeenCalledTimes(1);
    expect(notifyEnquiry).toHaveBeenCalledTimes(1);
    expect(createEnquiryLead).not.toHaveBeenCalled();
    expect(runAfterLeadCreated).not.toHaveBeenCalled();
  });

  it("with the flag on, offers the enquiry as a lead in the same transaction and still says sent", async () => {
    leadMarketplace = true;

    expect(await submit()).toEqual({ status: "sent" });
    expect(createEnquiry).toHaveBeenCalledTimes(1);
    expect(notifyEnquiry).toHaveBeenCalledTimes(1);
    expect(createEnquiryLead).toHaveBeenCalledWith(HANDLE, { role: "public" }, LISTING, {
      name: "Jo Enquirer", email: "jo@example.co.uk", phone: "01632 960123", message: "Is the hall free on 3 May?",
    });
    expect(runAfterLeadCreated).toHaveBeenCalledWith(HANDLE, { role: "public" }, LEAD);
  });

  it("runs no hook when the listing does not qualify, and makes no lead for an unknown listing", async () => {
    leadMarketplace = true;
    createEnquiryLead.mockResolvedValue(null);
    expect(await submit()).toEqual({ status: "sent" });
    expect(runAfterLeadCreated).not.toHaveBeenCalled();

    createEnquiry.mockResolvedValue({ outcome: "unknown-listing" });
    createEnquiryLead.mockClear();
    expect((await submit()).status).toBe("error");
    expect(createEnquiryLead).not.toHaveBeenCalled();
  });
});

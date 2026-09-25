import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnquiryResult } from "@/lib/db/queries/enquiries";
import type { RuleVerdict } from "@/lib/leads/rules";
import type { RateLimitResult } from "@/lib/spam/rate-limit";

/**
 * The enquiry action's lead branch (Task 56), with the database mocked out.
 *
 * With the lead marketplace on, an enquiry to a listing nobody reads
 * (unclaimed, no email — `enquiryLeadTarget`, proved in
 * lib/db/queries/leads.test.ts) sends the enquirer the verification email
 * and creates NO lead: the lead is made only when they confirm (D6). The
 * enquiry itself is written and notified exactly as before either way.
 */

const LISTING = "11111111-1111-4111-8111-111111111111";
const CITY = "33333333-3333-4333-8333-333333333333";
const HANDLE = { marker: "the transaction" };
const PENDING = { outcome: "created" as const, quoteRequestId: "44444444-4444-4444-8444-444444444444", recipientCount: 0, token: "tok" };

const createEnquiry = vi.fn<(...a: unknown[]) => Promise<EnquiryResult>>();
const notifyEnquiry = vi.fn<(...a: unknown[]) => Promise<void>>();
const notifyQuoteVerify = vi.fn<(...a: unknown[]) => Promise<void>>();
const enquiryLeadTarget = vi.fn<(...a: unknown[]) => Promise<{ cityId: string; categoryId: string | null } | null>>();
const createEnquiryLeadRequest = vi.fn<(...a: unknown[]) => Promise<typeof PENDING>>();
const checkLeadRules = vi.fn<(...a: unknown[]) => Promise<RuleVerdict>>();
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
vi.mock("@/lib/db/queries/leads", () => ({ enquiryLeadTarget: (...a: unknown[]) => enquiryLeadTarget(...a) }));
vi.mock("@/lib/db/queries/quotes", () => ({
  createEnquiryLeadRequest: (...a: unknown[]) => createEnquiryLeadRequest(...a),
}));
vi.mock("@/lib/leads/rules", () => ({ checkLeadRules: (...a: unknown[]) => checkLeadRules(...a) }));
vi.mock("@/lib/email/notify", () => ({
  notifyEnquiry: (...a: unknown[]) => notifyEnquiry(...a),
  notifyQuoteVerify: (...a: unknown[]) => notifyQuoteVerify(...a),
}));
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
  notifyQuoteVerify.mockReset().mockResolvedValue(undefined);
  enquiryLeadTarget.mockReset().mockResolvedValue({ cityId: CITY, categoryId: null });
  createEnquiryLeadRequest.mockReset().mockResolvedValue(PENDING);
  checkLeadRules.mockReset().mockResolvedValue("ok");
  rateLimit.mockReset().mockResolvedValue({ allowed: true, remaining: 4, retryAfterSeconds: 0 });
});

describe("submitEnquiry — the lead branch", () => {
  it("with the flag off, writes and notifies the enquiry as before and touches nothing lead-shaped", async () => {
    expect(await submit()).toEqual({ status: "sent" });
    expect(createEnquiry).toHaveBeenCalledTimes(1);
    expect(notifyEnquiry).toHaveBeenCalledTimes(1);
    expect(enquiryLeadTarget).not.toHaveBeenCalled();
    expect(createEnquiryLeadRequest).not.toHaveBeenCalled();
    expect(notifyQuoteVerify).not.toHaveBeenCalled();
  });

  it("with the flag on, sends the enquirer a verification link — no lead — and says to check their email", async () => {
    leadMarketplace = true;

    expect(await submit()).toEqual({ status: "sent", confirmByEmail: true });
    expect(createEnquiry).toHaveBeenCalledTimes(1);
    expect(notifyEnquiry).toHaveBeenCalledTimes(1);
    expect(createEnquiryLeadRequest).toHaveBeenCalledWith(HANDLE, { role: "public" }, {
      listingId: LISTING, cityId: CITY, categoryId: null, name: "Jo Enquirer", email: "jo@example.co.uk",
      phone: "01632 960123", message: "Is the hall free on 3 May?", ip: "203.0.113.9",
    });
    expect(notifyQuoteVerify).toHaveBeenCalledWith(HANDLE, { role: "public" }, PENDING);
  });

  it("sends no link for a listing someone reads, or an enquirer the lead rules refuse", async () => {
    leadMarketplace = true;
    enquiryLeadTarget.mockResolvedValue(null);
    expect(await submit()).toEqual({ status: "sent" });
    expect(checkLeadRules).not.toHaveBeenCalled();

    enquiryLeadTarget.mockResolvedValue({ cityId: CITY, categoryId: null });
    checkLeadRules.mockResolvedValue({ reason: "phone_invalid" });
    expect(await submit()).toEqual({ status: "sent" });
    expect(createEnquiryLeadRequest).not.toHaveBeenCalled();
    expect(notifyQuoteVerify).not.toHaveBeenCalled();
  });

  it("does nothing lead-shaped for an unknown listing", async () => {
    leadMarketplace = true;
    createEnquiry.mockResolvedValue({ outcome: "unknown-listing" });
    expect((await submit()).status).toBe("error");
    expect(enquiryLeadTarget).not.toHaveBeenCalled();
  });
});

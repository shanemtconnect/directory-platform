import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuoteRequestResult } from "@/lib/db/queries/quotes";
import type { RuleVerdict } from "@/lib/leads/rules";
import type { RateLimitResult } from "@/lib/spam/rate-limit";
import type { TurnstileResult } from "@/lib/spam/turnstile";

/**
 * The capture box's action, with the database mocked out. Its ladder is the
 * get-quotes form's — flag, honeypot, validate, budget, Turnstile, one
 * transaction — plus the lead rules, checked BEFORE anything is written so
 * the requester is told (D11), and a capture request that is never broadcast.
 */

const CITY = "11111111-1111-4111-8111-111111111111";
const CATEGORY = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const HANDLE = { marker: "the transaction" };

const createQuoteRequest = vi.fn<(...a: unknown[]) => Promise<QuoteRequestResult>>();
const notifyQuoteVerify = vi.fn<(...a: unknown[]) => Promise<void>>();
const checkLeadRules = vi.fn<(...a: unknown[]) => Promise<RuleVerdict>>();
const limitPublicWrite = vi.fn<(...a: unknown[]) => Promise<RateLimitResult>>();
const verifyTurnstile = vi.fn<(...a: unknown[]) => Promise<TurnstileResult>>();
const transaction = vi.fn(async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => await fn(HANDLE));
let leadMarketplace = true;

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "203.0.113.9" })),
}));
vi.mock("@/lib/db/client", () => ({ db: { transaction: (fn: never) => transaction(fn) } }));
vi.mock("@/lib/features/flags", () => ({
  isEnabled: (flag: string) => flag === "leadMarketplace" && leadMarketplace,
}));
vi.mock("@/lib/db/queries/quotes", () => ({ createQuoteRequest: (...a: unknown[]) => createQuoteRequest(...a) }));
vi.mock("@/lib/email/notify", () => ({ notifyQuoteVerify: (...a: unknown[]) => notifyQuoteVerify(...a) }));
vi.mock("@/lib/leads/rules", () => ({ checkLeadRules: (...a: unknown[]) => checkLeadRules(...a) }));
vi.mock("@/lib/spam/write-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spam/write-limit")>()),
  limitPublicWrite: (...a: unknown[]) => limitPublicWrite(...a),
}));
vi.mock("@/lib/spam/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spam/turnstile")>()),
  verifyTurnstile: (...a: unknown[]) => verifyTurnstile(...a),
}));
vi.mock("@/lib/spam/client-ip", () => ({
  clientIp: () => "203.0.113.9",
  rateLimitSubject: (ip: string | null) => ip,
}));

const good: Record<string, string> = {
  cityId: CITY,
  categoryId: CATEGORY,
  name: "Alex Capture",
  email: "alex@example.co.uk",
  phone: "01632 970123",
  message: "Office move next month, about ten desks.",
  consent: "on",
  "cf-turnstile-response": "tok",
};

async function submit(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  const { submitCaptureLead } = await import("./lead-capture");
  return submitCaptureLead({ status: "idle" }, f);
}

beforeEach(() => {
  vi.resetModules();
  leadMarketplace = true;
  createQuoteRequest.mockReset().mockResolvedValue({
    outcome: "created", quoteRequestId: REQUEST_ID, recipientCount: 0, token: "tok-raw",
  });
  notifyQuoteVerify.mockReset().mockResolvedValue(undefined);
  checkLeadRules.mockReset().mockResolvedValue("ok");
  limitPublicWrite.mockReset().mockResolvedValue({ allowed: true, remaining: 2, retryAfterSeconds: 0 });
  verifyTurnstile.mockReset().mockResolvedValue({ ok: true, skipped: false });
  transaction.mockClear();
});

describe("submitCaptureLead", () => {
  it("writes a capture request, queues the verification email only, and says check your email", async () => {
    expect(await submit(good)).toEqual({ status: "sent" });

    expect(checkLeadRules).toHaveBeenCalledWith(HANDLE, {
      email: "alex@example.co.uk", phone: "01632 970123", country: expect.any(String),
    });
    expect(createQuoteRequest).toHaveBeenCalledWith(HANDLE, { role: "public" }, {
      cityId: CITY, categoryId: CATEGORY, name: "Alex Capture", email: "alex@example.co.uk",
      phone: "01632 970123", message: "Office move next month, about ten desks.", ip: "203.0.113.9",
    }, { source: "capture" });
    expect(notifyQuoteVerify).toHaveBeenCalledWith(HANDLE, { role: "public" }, expect.objectContaining({ token: "tok-raw" }));
    expect(limitPublicWrite).toHaveBeenCalledWith("lead-capture", expect.any(Headers), { limit: 3, windowSeconds: 3600 });
  });

  it("refuses with the flag off, before anything else", async () => {
    leadMarketplace = false;
    expect((await submit(good)).status).toBe("error");
    expect(limitPublicWrite).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("pretends to succeed for the honeypot and writes nothing", async () => {
    expect(await submit({ ...good, company_website: "x" })).toEqual({ status: "sent" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("requires a phone, and validates before the budget and Turnstile", async () => {
    const state = await submit({ ...good, phone: "", consent: "" });
    expect(state.status).toBe("error");
    expect(state.fieldErrors).toMatchObject({ phone: expect.any(String), consent: expect.any(String) });
    expect(limitPublicWrite).not.toHaveBeenCalled();
    expect(verifyTurnstile).not.toHaveBeenCalled();
  });

  it("checks the budget before Turnstile", async () => {
    limitPublicWrite.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 1800 });
    const state = await submit(good);
    expect(state.message).toContain("30 minutes");
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a failed Turnstile without a transaction", async () => {
    verifyTurnstile.mockResolvedValue({ ok: false, skipped: false });
    expect((await submit(good)).status).toBe("error");
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each<[RuleVerdict, string, RegExp]>([
    [{ reason: "phone_invalid" }, "phone", /phone number/i],
    [{ reason: "disposable_email" }, "email", /email address/i],
  ])("maps %o onto the %s field and writes nothing", async (verdict, field, text) => {
    checkLeadRules.mockResolvedValue(verdict);
    const state = await submit(good);
    expect(state.status).toBe("error");
    expect(state.fieldErrors?.[field]).toMatch(text);
    expect(createQuoteRequest).not.toHaveBeenCalled();
    expect(notifyQuoteVerify).not.toHaveBeenCalled();
  });

  it("tells a repeat requester their earlier request stands, and writes nothing", async () => {
    checkLeadRules.mockResolvedValue({ reason: "duplicate" });
    const state = await submit(good);
    expect(state.status).toBe("error");
    expect(state.message).toMatch(/30 days/);
    expect(createQuoteRequest).not.toHaveBeenCalled();
  });

  it("refuses a blocklisted requester without saying why", async () => {
    checkLeadRules.mockResolvedValue({ reason: "blocklisted" });
    const state = await submit(good);
    expect(state.status).toBe("error");
    expect(state.message).not.toMatch(/block/i);
    expect(createQuoteRequest).not.toHaveBeenCalled();
  });

  it("maps an unknown town back onto its field", async () => {
    createQuoteRequest.mockResolvedValue({ outcome: "unknown-city" });
    const state = await submit(good);
    expect(state.fieldErrors?.cityId).toBeTruthy();
  });
});

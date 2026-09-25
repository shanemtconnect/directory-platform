import { beforeEach, describe, expect, it, vi } from "vitest";
import { siteConfig } from "@/config/site.config";
import type { Viewer } from "@/lib/db/viewer";
import type { QuoteRequestResult } from "@/lib/db/queries/quotes";
import type { RateLimitResult } from "@/lib/spam/rate-limit";
import type { TurnstileResult } from "@/lib/spam/turnstile";

/**
 * The action's gates, with the database mocked out.
 *
 * What the write does is `createQuoteRequest`, tested against a real
 * transaction in lib/db/queries/quotes.test.ts. What is only testable HERE is
 * the order of the gates in front of it and what reaches the query: the flag,
 * the honeypot, validation before the budget, the budget before Turnstile,
 * and the request address handed through for the audit row.
 */

const CITY = "11111111-1111-4111-8111-111111111111";
const CATEGORY = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";

const createQuoteRequest = vi.fn<(...a: unknown[]) => Promise<QuoteRequestResult>>();
const markQuoteOutcome = vi.fn<(...a: unknown[]) => Promise<boolean>>();
const flagQuoteRequestSpam = vi.fn<(...a: unknown[]) => Promise<boolean>>();
const notifyQuoteRequest = vi.fn<(...a: unknown[]) => Promise<void>>();
const notifyQuoteVerify = vi.fn<(...a: unknown[]) => Promise<void>>();
const limitPublicWrite = vi.fn<(...a: unknown[]) => Promise<RateLimitResult>>();
const verifyTurnstile = vi.fn<(...a: unknown[]) => Promise<TurnstileResult>>();
const currentViewer = vi.fn<() => Promise<Viewer>>();
const isEnabled = vi.fn<(flag: string) => boolean>();

const HANDLE = { marker: "the transaction" };
const transaction = vi.fn(
  async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => await fn(HANDLE),
);

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "203.0.113.9" })),
}));
vi.mock("@/lib/db/client", () => ({ db: { transaction: (fn: never) => transaction(fn) } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/features/flags", () => ({ isEnabled: (flag: string) => isEnabled(flag) }));
vi.mock("@/lib/auth/viewer", () => ({
  currentViewer: () => currentViewer(),
  requireAdmin: async () => {
    const v = await currentViewer();
    if (v.role !== "admin") throw new Error("FORBIDDEN");
    return v;
  },
}));
vi.mock("@/lib/db/queries/quotes", () => ({
  createQuoteRequest: (...args: unknown[]) => createQuoteRequest(...args),
  markQuoteOutcome: (...args: unknown[]) => markQuoteOutcome(...args),
  flagQuoteRequestSpam: (...args: unknown[]) => flagQuoteRequestSpam(...args),
}));
vi.mock("@/lib/email/notify", () => ({
  notifyQuoteRequest: (...args: unknown[]) => notifyQuoteRequest(...args),
  notifyQuoteVerify: (...args: unknown[]) => notifyQuoteVerify(...args),
}));
vi.mock("@/lib/spam/write-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spam/write-limit")>()),
  limitPublicWrite: (...args: unknown[]) => limitPublicWrite(...args),
}));
vi.mock("@/lib/spam/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spam/turnstile")>()),
  verifyTurnstile: (...args: unknown[]) => verifyTurnstile(...args),
}));
vi.mock("@/lib/spam/client-ip", () => ({
  clientIp: () => "203.0.113.9",
  rateLimitSubject: (ip: string | null) => ip,
}));

const allowed: RateLimitResult = { allowed: true, remaining: 2, retryAfterSeconds: 0 };
const blocked: RateLimitResult = { allowed: false, remaining: 0, retryAfterSeconds: 1800 };

const good: Record<string, string> = {
  cityId: CITY,
  categoryId: CATEGORY,
  name: "Sam Requester",
  email: "sam@example.co.uk",
  phone: "01632 960000",
  message: "Eighty people in June, with parking.",
  consent: "on",
  "cf-turnstile-response": "tok",
};

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function submit(fields: Record<string, string>) {
  const { submitQuoteRequest } = await import("./quotes");
  return submitQuoteRequest({ status: "idle" }, form(fields));
}

beforeEach(() => {
  vi.resetModules();
  // quoteBroadcast on, leadMarketplace off: the site as it was before leads.
  isEnabled.mockReset().mockImplementation((flag) => flag === "quoteBroadcast");
  createQuoteRequest.mockReset().mockResolvedValue({
    outcome: "created", quoteRequestId: REQUEST_ID, recipientCount: 4, token: "tok-raw",
  });
  markQuoteOutcome.mockReset().mockResolvedValue(true);
  flagQuoteRequestSpam.mockReset().mockResolvedValue(true);
  notifyQuoteRequest.mockReset().mockResolvedValue(undefined);
  notifyQuoteVerify.mockReset().mockResolvedValue(undefined);
  limitPublicWrite.mockReset().mockResolvedValue(allowed);
  verifyTurnstile.mockReset().mockResolvedValue({ ok: true, skipped: false });
  currentViewer.mockReset().mockResolvedValue({ role: "owner", userId: "user_owner" });
  transaction.mockClear();
});

describe("submitQuoteRequest", () => {
  it("writes the request with the ip, queues the VERIFICATION email in the same transaction, and reports the count", async () => {
    const state = await submit(good);

    expect(state).toEqual({ status: "sent", recipientCount: 4 });
    expect(createQuoteRequest).toHaveBeenCalledWith(HANDLE, { role: "public" }, {
      cityId: CITY,
      categoryId: CATEGORY,
      name: "Sam Requester",
      email: "sam@example.co.uk",
      phone: "01632 960000",
      message: "Eighty people in June, with parking.",
      ip: "203.0.113.9",
    }, { allowNoRecipients: false });
    expect(notifyQuoteVerify).toHaveBeenCalledWith(HANDLE, { role: "public" }, {
      outcome: "created", quoteRequestId: REQUEST_ID, recipientCount: 4, token: "tok-raw",
    });
    // Nobody but the requester is written to until the link is clicked.
    expect(notifyQuoteRequest).not.toHaveBeenCalled();
    expect(limitPublicWrite).toHaveBeenCalledWith("quote", expect.any(Headers), { limit: 3, windowSeconds: 3600 });
  });

  it("with the lead marketplace on, keeps a request nobody local can receive — it becomes a lead on the click", async () => {
    isEnabled.mockImplementation((flag) => flag === "quoteBroadcast" || flag === "leadMarketplace");
    createQuoteRequest.mockResolvedValue({ outcome: "created", quoteRequestId: REQUEST_ID, recipientCount: 0, token: "t" });

    const state = await submit(good);

    expect(state).toEqual({ status: "sent", recipientCount: 0 });
    expect(createQuoteRequest).toHaveBeenCalledWith(HANDLE, { role: "public" }, expect.any(Object), { allowNoRecipients: true });
  });

  it("with the lead marketplace on, tells the requester WHY when a no-recipient request could not become a lead for want of a phone", async () => {
    isEnabled.mockImplementation((flag) => flag === "quoteBroadcast" || flag === "leadMarketplace");
    createQuoteRequest.mockResolvedValue({ outcome: "lead-refused", reason: "phone_invalid", cityName: "Leeds" });

    const state = await submit({ ...good, phone: "" });

    expect(state.status).toBe("error");
    // Names the town and the entity, not a plain "give us a phone number" —
    // the person is never told a phone is needed until this refusal, so a
    // validation-slip wording would leave them guessing why.
    expect(state.message).toBe(
      `No listed ${siteConfig.entity.singular} in Leeds can take this request directly yet, so we need a phone number to pass it on.`,
    );
    expect(state.fieldErrors?.phone).toBe(state.message);
    // What was typed survives the refusal, so retrying costs one field, not the whole form.
    expect(state.values).toEqual({
      cityId: CITY, categoryId: CATEGORY, name: "Sam Requester", email: "sam@example.co.uk",
      phone: "", message: "Eighty people in June, with parking.", consent: true,
    });
    expect(createQuoteRequest).toHaveBeenCalledWith(HANDLE, { role: "public" }, expect.any(Object), { allowNoRecipients: true });
    // Handed the refusal, which queues nothing (notifyQuoteVerify ignores anything but "created").
    expect(notifyQuoteVerify).toHaveBeenCalledWith(HANDLE, { role: "public" }, { outcome: "lead-refused", reason: "phone_invalid", cityName: "Leeds" });

    // A different lead-rule reason keeps the shared, generic wording (leadRefusal).
    createQuoteRequest.mockResolvedValue({ outcome: "lead-refused", reason: "duplicate", cityName: "Leeds" });
    expect((await submit(good)).message).toMatch(/last 30 days/);
  });

  it("with the lead marketplace off, still refuses a request nobody can receive, as before", async () => {
    createQuoteRequest.mockResolvedValue({ outcome: "no-recipients" });

    const state = await submit({ ...good, phone: "" });

    expect(createQuoteRequest).toHaveBeenCalledWith(HANDLE, { role: "public" }, expect.any(Object), { allowNoRecipients: false });
    expect(state).toEqual({
      status: "error",
      message: "Nobody in that town and category can take a request right now. Try a nearby town.",
      values: {
        cityId: CITY, categoryId: CATEGORY, name: "Sam Requester", email: "sam@example.co.uk",
        phone: "", message: "Eighty people in June, with parking.", consent: true,
      },
    });
  });

  it("refuses when the feature flag is off, before anything else", async () => {
    isEnabled.mockReturnValue(false);

    const state = await submit(good);

    expect(state.status).toBe("error");
    expect(limitPublicWrite).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("pretends to succeed for the honeypot and writes nothing", async () => {
    const state = await submit({ ...good, company_website: "https://spam.example" });

    expect(state.status).toBe("sent");
    expect(transaction).not.toHaveBeenCalled();
    expect(limitPublicWrite).not.toHaveBeenCalled();
  });

  it("validates before spending the budget or the Turnstile token, and hands back what was typed", async () => {
    const state = await submit({ ...good, consent: "", message: "short" });

    expect(state.status).toBe("error");
    expect(state.fieldErrors).toMatchObject({ consent: expect.any(String), message: expect.any(String) });
    // A refused submit keeps every typed value, including the one that failed
    // validation — the visitor should not have to retype the whole form to
    // fix one field.
    expect(state.values).toEqual({
      cityId: CITY, categoryId: CATEGORY, name: "Sam Requester", email: "sam@example.co.uk",
      phone: "01632 960000", message: "short", consent: false,
    });
    expect(limitPublicWrite).not.toHaveBeenCalled();
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("checks the budget before Turnstile, and says how long to wait", async () => {
    limitPublicWrite.mockResolvedValue(blocked);

    const state = await submit(good);

    expect(state.status).toBe("error");
    expect(state.message).toContain("30 minutes");
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a failed Turnstile without opening a transaction", async () => {
    verifyTurnstile.mockResolvedValue({ ok: false, skipped: false, reason: "rejected" });

    const state = await submit(good);

    expect(state.status).toBe("error");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("tells the visitor when nobody can receive the request", async () => {
    createQuoteRequest.mockResolvedValue({ outcome: "no-recipients" });

    const state = await submit(good);

    expect(state.status).toBe("error");
    expect(state.message).toMatch(/nearby town/i);
  });

  it.each<QuoteRequestResult>([{ outcome: "unknown-city" }, { outcome: "unknown-category" }])(
    "maps $outcome back onto the field", async (result) => {
      createQuoteRequest.mockResolvedValue(result);

      const state = await submit(good);

      expect(state.status).toBe("error");
      expect(state.fieldErrors?.[result.outcome === "unknown-city" ? "cityId" : "categoryId"]).toBeTruthy();
      expect(state.values).toMatchObject({ name: "Sam Requester", email: "sam@example.co.uk" });
    },
  );
});

describe("markQuoteLead", () => {
  it("hands the owner, the id, the outcome and the ip to the query", async () => {
    const { markQuoteLead } = await import("./quotes");

    expect(await markQuoteLead(REQUEST_ID, "won")).toEqual({ ok: true });
    expect(markQuoteOutcome).toHaveBeenCalledWith(HANDLE, { role: "owner", userId: "user_owner" }, REQUEST_ID, "won", "203.0.113.9");
  });

  it("does nothing for a signed-out caller or a malformed id", async () => {
    const { markQuoteLead } = await import("./quotes");
    currentViewer.mockResolvedValue({ role: "public" });
    expect(await markQuoteLead(REQUEST_ID, "won")).toEqual({ ok: false });

    currentViewer.mockResolvedValue({ role: "owner", userId: "user_owner" });
    expect(await markQuoteLead("nope", "lost")).toEqual({ ok: false });
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("flagQuoteSpam", () => {
  it("re-checks the admin role itself rather than trusting the layout", async () => {
    const { flagQuoteSpam } = await import("./quotes");
    currentViewer.mockResolvedValue({ role: "owner", userId: "user_owner" });

    await expect(flagQuoteSpam(form({ quoteRequestId: REQUEST_ID, isSpam: "true" }))).rejects.toThrow("FORBIDDEN");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("flags with the admin viewer and the ip", async () => {
    const { flagQuoteSpam } = await import("./quotes");
    currentViewer.mockResolvedValue({ role: "admin", userId: "user_admin" });

    expect(await flagQuoteSpam(form({ quoteRequestId: REQUEST_ID, isSpam: "true" }))).toEqual({ ok: true });
    expect(flagQuoteRequestSpam).toHaveBeenCalledWith(HANDLE, { role: "admin", userId: "user_admin" }, REQUEST_ID, true, "203.0.113.9");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitResult } from "@/lib/spam/rate-limit";
import type { QuoteVerifyResult } from "@/lib/db/queries/quotes";
import type { Lead } from "@/lib/db/queries/leads";

/**
 * The route's wiring, with the database mocked out. What the click DOES to
 * the row — single use, the 48-hour expiry, the reused link — is proved
 * against a real transaction in lib/db/queries/quotes.test.ts
 * (`verifyQuoteToken`); what lead it makes, in lib/db/queries/leads.test.ts.
 * Here: what is queued and created for each outcome, the flags, the budget,
 * and where the requester lands.
 */

process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3215";

const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const HANDLE = { marker: "the transaction" };
const LEAD = { id: "44444444-4444-4444-8444-444444444444", status: "open" } as Lead;

const verifyQuoteToken = vi.fn<(...a: unknown[]) => Promise<QuoteVerifyResult>>();
const notifyQuoteRequest = vi.fn<(...a: unknown[]) => Promise<void>>();
const createLeadFromQuote = vi.fn<(...a: unknown[]) => Promise<Lead | null>>();
const createLeadFromCaptureRequest = vi.fn<(...a: unknown[]) => Promise<Lead | null>>();
const createLeadFromEnquiryRequest = vi.fn<(...a: unknown[]) => Promise<Lead | null>>();
const runAfterLeadCreated = vi.fn<(...a: unknown[]) => Promise<boolean>>();
const limitPublicWrite = vi.fn<(...a: unknown[]) => Promise<RateLimitResult>>();
let flags: Record<string, boolean> = {};

vi.mock("@/lib/db/client", () => ({
  db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(HANDLE) },
}));
vi.mock("@/lib/features/flags", () => ({ isEnabled: (flag: string) => flags[flag] === true }));
vi.mock("@/lib/db/queries/quotes", () => ({
  verifyQuoteToken: (...a: unknown[]) => verifyQuoteToken(...a),
}));
vi.mock("@/lib/db/queries/leads", () => ({
  createLeadFromQuote: (...a: unknown[]) => createLeadFromQuote(...a),
  createLeadFromCaptureRequest: (...a: unknown[]) => createLeadFromCaptureRequest(...a),
  createLeadFromEnquiryRequest: (...a: unknown[]) => createLeadFromEnquiryRequest(...a),
}));
vi.mock("@/lib/leads/hooks", () => ({
  runAfterLeadCreated: (...a: unknown[]) => runAfterLeadCreated(...a),
}));
vi.mock("@/lib/email/notify", () => ({
  notifyQuoteRequest: (...a: unknown[]) => notifyQuoteRequest(...a),
}));
vi.mock("@/lib/spam/write-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spam/write-limit")>()),
  limitPublicWrite: (...a: unknown[]) => limitPublicWrite(...a),
}));

const allowed: RateLimitResult = { allowed: true, remaining: 29, retryAfterSeconds: 0 };

/** The button on /get-quotes/verify/<token>: a POST to …/<token>/confirm. */
function click(token: string): [Request, { params: Promise<{ token: string }> }] {
  return [
    new Request(`http://localhost:3215/get-quotes/verify/${encodeURIComponent(token)}/confirm`, {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.7" },
    }),
    { params: Promise.resolve({ token: encodeURIComponent(token) }) },
  ];
}

async function POST(args: [Request, { params: Promise<{ token: string }> }]): Promise<Response> {
  const route = await import("./route");
  return route.POST(...args);
}

beforeEach(() => {
  vi.resetModules();
  flags = { quoteBroadcast: true, leadMarketplace: true };
  verifyQuoteToken.mockReset().mockResolvedValue({
    outcome: "verified", quoteRequestId: REQUEST_ID, source: "quote", recipientCount: 3,
  });
  notifyQuoteRequest.mockReset().mockResolvedValue(undefined);
  createLeadFromQuote.mockReset().mockResolvedValue(LEAD);
  createLeadFromCaptureRequest.mockReset().mockResolvedValue(LEAD);
  createLeadFromEnquiryRequest.mockReset().mockResolvedValue(LEAD);
  runAfterLeadCreated.mockReset().mockResolvedValue(true);
  limitPublicWrite.mockReset().mockResolvedValue(allowed);
});

describe("POST /get-quotes/verify/[token]/confirm", () => {
  it("has no GET: a scanner that follows the URL confirms nothing", async () => {
    const route = await import("./route");
    expect("GET" in route).toBe(false);
  });

  it("an enquiry's link makes the enquiry lead and emails nobody", async () => {
    verifyQuoteToken.mockResolvedValue({ outcome: "verified", quoteRequestId: REQUEST_ID, source: "enquiry", recipientCount: 0 });

    const res = await POST(click("tok-enquiry"));

    expect(res.headers.get("location")).toMatch(/state=verified$/);
    expect(notifyQuoteRequest).not.toHaveBeenCalled();
    expect(createLeadFromEnquiryRequest).toHaveBeenCalledWith(HANDLE, { role: "public" }, REQUEST_ID);
    expect(createLeadFromQuote).not.toHaveBeenCalled();
    expect(runAfterLeadCreated).toHaveBeenCalledWith(HANDLE, { role: "public" }, LEAD);
  });

  it("a valid link queues the delivery, makes the lead, runs the hook, and lands on the confirmed page", async () => {
    const res = await POST(click("tok-live"));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:3215/get-quotes/confirmed?state=verified");
    expect(verifyQuoteToken).toHaveBeenCalledWith(HANDLE, { role: "public" }, "tok-live");
    expect(notifyQuoteRequest).toHaveBeenCalledWith(HANDLE, { role: "public" }, REQUEST_ID);
    expect(createLeadFromQuote).toHaveBeenCalledWith(HANDLE, { role: "public" }, REQUEST_ID);
    expect(runAfterLeadCreated).toHaveBeenCalledWith(HANDLE, { role: "public" }, LEAD);
    expect(createLeadFromCaptureRequest).not.toHaveBeenCalled();
  });

  it("queues no delivery for a request with no recipients, and runs no hook when no lead was made", async () => {
    verifyQuoteToken.mockResolvedValue({ outcome: "verified", quoteRequestId: REQUEST_ID, source: "quote", recipientCount: 0 });
    createLeadFromQuote.mockResolvedValue(null);

    await POST(click("tok-live"));

    expect(notifyQuoteRequest).not.toHaveBeenCalled();
    expect(createLeadFromQuote).toHaveBeenCalled();
    expect(runAfterLeadCreated).not.toHaveBeenCalled();
  });

  it("a capture box's link makes a capture lead and emails nobody", async () => {
    verifyQuoteToken.mockResolvedValue({ outcome: "verified", quoteRequestId: REQUEST_ID, source: "capture", recipientCount: 0 });

    await POST(click("tok-capture"));

    expect(notifyQuoteRequest).not.toHaveBeenCalled();
    expect(createLeadFromCaptureRequest).toHaveBeenCalledWith(HANDLE, { role: "public" }, REQUEST_ID);
    expect(createLeadFromQuote).not.toHaveBeenCalled();
    expect(runAfterLeadCreated).toHaveBeenCalledWith(HANDLE, { role: "public" }, LEAD);
  });

  it("with the lead marketplace off, delivers exactly as before and creates no lead", async () => {
    flags = { quoteBroadcast: true, leadMarketplace: false };

    const res = await POST(click("tok-live"));

    expect(res.headers.get("location")).toMatch(/state=verified$/);
    expect(notifyQuoteRequest).toHaveBeenCalledTimes(1);
    expect(createLeadFromQuote).not.toHaveBeenCalled();
    expect(createLeadFromCaptureRequest).not.toHaveBeenCalled();
    expect(runAfterLeadCreated).not.toHaveBeenCalled();
  });

  it.each([
    [{ outcome: "already-verified", quoteRequestId: REQUEST_ID } as QuoteVerifyResult, "already"],
    [{ outcome: "expired" } as QuoteVerifyResult, "expired"],
    [{ outcome: "unknown" } as QuoteVerifyResult, "unknown"],
  ])("a %o link does nothing and lands on state=%s", async (result, state) => {
    verifyQuoteToken.mockResolvedValue(result);

    const res = await POST(click("tok-old"));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`http://localhost:3215/get-quotes/confirmed?state=${state}`);
    expect(notifyQuoteRequest).not.toHaveBeenCalled();
    expect(createLeadFromQuote).not.toHaveBeenCalled();
    expect(runAfterLeadCreated).not.toHaveBeenCalled();
  });

  it("decodes the token from the path before looking it up", async () => {
    await POST(click("a/b+c"));
    expect(verifyQuoteToken).toHaveBeenCalledWith(HANDLE, { role: "public" }, "a/b+c");
  });

  it("counts every click against its own bucket and refuses a client over it with 429", async () => {
    const { QUOTE_VERIFY_RATE_LIMIT } = await import("@/lib/spam/write-limit");
    const args = click("tok-guess");
    await POST(args);
    expect(limitPublicWrite).toHaveBeenCalledWith("quote-verify", args[0].headers, QUOTE_VERIFY_RATE_LIMIT);

    limitPublicWrite.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 30 });
    verifyQuoteToken.mockClear();
    const res = await POST(click("tok-guess"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(verifyQuoteToken).not.toHaveBeenCalled();
  });

  it("is a 404 when the site does not do quotes", async () => {
    flags = {};
    const res = await POST(click("tok-live"));
    expect(res.status).toBe(404);
    expect(verifyQuoteToken).not.toHaveBeenCalled();
  });
});

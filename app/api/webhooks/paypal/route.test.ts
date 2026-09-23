import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitResult } from "@/lib/spam/rate-limit";
import type { WebhookRequest, WebhookResult } from "@/lib/billing/process";

const processPayPalWebhook = vi.fn<(tx: unknown, req: WebhookRequest) => Promise<WebhookResult>>();
const limitPublicWrite = vi.fn<(...a: unknown[]) => Promise<RateLimitResult>>();
const revalidateListingPaths = vi.fn<(paths: readonly string[]) => void>();

vi.mock("@/lib/db/client", () => ({
  db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) },
  getDb: () => ({}),
}));
vi.mock("@/lib/billing/paypal", () => ({ getPayPalClient: () => ({}) }));
vi.mock("@/lib/billing/process", () => ({
  processPayPalWebhook: (tx: unknown, req: WebhookRequest) => processPayPalWebhook(tx, req),
}));
vi.mock("@/lib/spam/write-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spam/write-limit")>()),
  limitPublicWrite: (...args: unknown[]) => limitPublicWrite(...args),
}));
vi.mock("@/lib/revalidate/listing", () => ({
  revalidateListingPaths: (paths: readonly string[]) => revalidateListingPaths(paths),
}));

const allowed: RateLimitResult = { allowed: true, remaining: 99, retryAfterSeconds: 0 };
const blocked: RateLimitResult = { allowed: false, remaining: 0, retryAfterSeconds: 42 };

const EVENT = JSON.stringify({ id: "WH-EV-1", event_type: "BILLING.SUBSCRIPTION.ACTIVATED", resource: {} });

/** Content-Length is set explicitly: `new Request` does not compute one. */
function post(body: string, headers: Record<string, string | undefined> = {}): Request {
  const h: Record<string, string> = {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "x-forwarded-for": "198.51.100.7",
    "paypal-transmission-id": "t",
  };
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) delete h[k];
    else h[k] = v;
  }
  return new Request("http://localhost:3215/api/webhooks/paypal", { method: "POST", headers: h, body });
}

async function send(...args: Parameters<typeof post>): Promise<Response> {
  const { POST } = await import("./route");
  return POST(post(...args));
}

describe("POST /api/webhooks/paypal", () => {
  beforeEach(() => {
    processPayPalWebhook.mockReset();
    processPayPalWebhook.mockResolvedValue({ status: 200, outcome: "applied" });
    limitPublicWrite.mockReset();
    limitPublicWrite.mockResolvedValue(allowed);
    revalidateListingPaths.mockReset();
  });

  it("hands the processor the raw body and the signature headers", async () => {
    const res = await send(EVENT, { "paypal-transmission-sig": "sig" });

    expect(res.status).toBe(200);
    const req = processPayPalWebhook.mock.calls[0]![1];
    expect(req.raw).toBe(EVENT);
    expect(req.headers["paypal-transmission-sig"]).toBe("sig");
  });

  it("rejects a POST with no Content-Length before reading a byte", async () => {
    // PayPal always declares one. Anything that does not is a client this
    // endpoint has no reason to buffer for.
    const res = await send(EVENT, { "content-length": undefined });

    expect(res.status).toBe(413);
    expect(processPayPalWebhook).not.toHaveBeenCalled();
  });

  it("rejects a declared Content-Length over 256 KB before reading the body", async () => {
    const res = await send(EVENT, { "content-length": String(256 * 1024 + 1) });

    expect(res.status).toBe(413);
    expect(processPayPalWebhook).not.toHaveBeenCalled();
  });

  it("accepts a declared Content-Length of exactly the cap", async () => {
    const res = await send(EVENT, { "content-length": String(256 * 1024) });
    expect(res.status).toBe(200);
  });

  it("rejects a body whose real size is over the cap whatever the header claimed", async () => {
    const big = `{"pad":"${"x".repeat(256 * 1024)}"}`;
    const res = await send(big, { "content-length": "10" });

    expect(res.status).toBe(413);
    expect(processPayPalWebhook).not.toHaveBeenCalled();
  });

  it("counts every delivery against one per-address bucket, before verification", async () => {
    const { PAYPAL_WEBHOOK_RATE_LIMIT } = await import("@/lib/spam/write-limit");
    const request = post(EVENT);
    const { POST } = await import("./route");

    await POST(request);

    expect(limitPublicWrite).toHaveBeenCalledWith("paypal-webhook", request.headers, PAYPAL_WEBHOOK_RATE_LIMIT);
    expect(PAYPAL_WEBHOOK_RATE_LIMIT).toEqual({ limit: 300, windowSeconds: 60 });
    // The limiter ran before the processor, which is where verification lives.
    expect(limitPublicWrite.mock.invocationCallOrder[0]!)
      .toBeLessThan(processPayPalWebhook.mock.invocationCallOrder[0]!);
  });

  it("refuses a client over the limit with 429 and Retry-After, and verifies nothing", async () => {
    limitPublicWrite.mockResolvedValue(blocked);

    const res = await send(EVENT);

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(processPayPalWebhook).not.toHaveBeenCalled();
  });

  it("hands the paths the processor reports to the one revalidate helper, once the transaction is back", async () => {
    // `listingPaths` is read inside the transaction; `revalidatePath` is a
    // Next primitive that is legal in a route handler, and it runs here after
    // the transaction has committed so nothing re-caches the old row between
    // "marked stale" and "committed".
    const paths = ["/a-city/a-listing", "/a-city/a-listing/reviews", "/a-city", "/a-city/page/2", "/a-city/barns"];
    processPayPalWebhook.mockResolvedValue({ status: 200, outcome: "applied", revalidate: { paths } });

    await send(EVENT);

    expect(revalidateListingPaths).toHaveBeenCalledTimes(1);
    expect(revalidateListingPaths).toHaveBeenCalledWith(paths);
  });

  it("revalidates nothing when the processor applied nothing", async () => {
    processPayPalWebhook.mockResolvedValue({ status: 200, outcome: "ignored" });

    await send(EVENT);

    expect(revalidateListingPaths).not.toHaveBeenCalled();
  });

  it("refuses GET", async () => {
    const { GET } = await import("./route");
    expect(GET().status).toBe(405);
  });
});

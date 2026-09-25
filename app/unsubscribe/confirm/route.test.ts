import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitResult } from "@/lib/spam/rate-limit";

const recordUnsubscribe = vi.fn<(...a: unknown[]) => Promise<{ written: boolean }>>();
const deactivateSavedSearch = vi.fn<(...a: unknown[]) => Promise<boolean>>();
const limitPublicWrite = vi.fn<(...a: unknown[]) => Promise<RateLimitResult>>();
const HANDLE = { marker: "the transaction" };

vi.mock("@/lib/db/client", () => ({
  db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(HANDLE) },
}));
vi.mock("@/lib/db/queries/unsubscribes", () => ({
  recordUnsubscribe: (...args: unknown[]) => recordUnsubscribe(...args),
}));
vi.mock("@/lib/db/queries/saved-searches", () => ({
  deactivateSavedSearch: (...args: unknown[]) => deactivateSavedSearch(...args),
}));
vi.mock("@/lib/spam/write-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spam/write-limit")>()),
  limitPublicWrite: (...args: unknown[]) => limitPublicWrite(...args),
}));

const allowed: RateLimitResult = { allowed: true, remaining: 29, retryAfterSeconds: 0 };
const claim = { email: "owner@example.com", listingId: "33333333-3333-4333-8333-333333333333" };

async function post(token: string | null) {
  const { POST } = await import("./route");
  const body = new FormData();
  if (token !== null) body.set("t", token);
  return POST(new Request("https://example.co.uk/unsubscribe/confirm", {
    method: "POST", body, headers: { "x-forwarded-for": "203.0.113.9" },
  }));
}

beforeEach(() => {
  vi.resetModules();
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "unit-test-secret";
  recordUnsubscribe.mockReset().mockResolvedValue({ written: true });
  deactivateSavedSearch.mockReset().mockResolvedValue(true);
  limitPublicWrite.mockReset().mockResolvedValue(allowed);
});

describe("POST /unsubscribe/confirm", () => {
  it("writes the address the token names and lands on the done page", async () => {
    const { signUnsubscribe } = await import("@/lib/email/unsubscribe");
    const res = await post(signUnsubscribe(claim)!);

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://example.co.uk/unsubscribe?done=1");
    expect(recordUnsubscribe).toHaveBeenCalledWith(HANDLE, { role: "public" }, {
      ...claim, reason: "quote", ip: "203.0.113.9",
    });
  });

  it("turns off the one saved search a digest token names, and nothing else", async () => {
    const { signUnsubscribe } = await import("@/lib/email/unsubscribe");
    const searchId = "44444444-4444-4444-8444-444444444444";
    const res = await post(signUnsubscribe({ savedSearchId: searchId, email: "alerts@example.com" })!);

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://example.co.uk/unsubscribe?done=alerts");
    expect(deactivateSavedSearch).toHaveBeenCalledWith(HANDLE, { role: "public" }, searchId, "203.0.113.9");
    expect(recordUnsubscribe).not.toHaveBeenCalled();
  });

  it("refuses a tampered or missing token without writing", async () => {
    expect((await post("payload.badsignature")).status).toBe(400);
    expect((await post(null)).status).toBe(400);
    expect(recordUnsubscribe).not.toHaveBeenCalled();
    expect(deactivateSavedSearch).not.toHaveBeenCalled();
  });

  it("is rate limited before the token is read", async () => {
    limitPublicWrite.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 42 });
    const { signUnsubscribe } = await import("@/lib/email/unsubscribe");
    const res = await post(signUnsubscribe(claim)!);
    expect(res.status).toBe(429);
    expect(recordUnsubscribe).not.toHaveBeenCalled();
  });
});

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitResult } from "@/lib/spam/rate-limit";

/**
 * The action is tested at its seams: the request headers, the counter and
 * Better Auth are all mocked, because what matters here is not whether Better
 * Auth can mint a token but that the FORM behaves the same way whatever it
 * finds — a reply that varies with the address is an account-enumeration
 * oracle, and a form with no counter is a free emailer.
 */

const requestPasswordReset = vi.fn<(args: unknown) => Promise<unknown>>();
const rateLimit = vi.fn<(key: string | null, opts: unknown) => Promise<RateLimitResult>>();
const headerBag = new Headers({ "x-forwarded-for": "203.0.113.9" });

vi.mock("next/headers", () => ({ headers: async () => headerBag }));
vi.mock("@/lib/spam/rate-limit", () => ({
  rateLimit: (key: string | null, opts: unknown) => rateLimit(key, opts),
}));
vi.mock("@/lib/auth/server", () => ({
  getAuth: () => ({ api: { requestPasswordReset: (a: unknown) => requestPasswordReset(a) } }),
}));

const { requestPasswordResetAction } = await import("./actions");

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function form(email: string): FormData {
  const f = new FormData();
  f.set("email", email);
  return f;
}

const ALLOWED: RateLimitResult = { allowed: true, remaining: 4, retryAfterSeconds: 0 };
const BLOCKED: RateLimitResult = { allowed: false, remaining: 0, retryAfterSeconds: 1800 };

beforeEach(() => {
  requestPasswordReset.mockReset().mockResolvedValue({ status: true });
  rateLimit.mockReset().mockResolvedValue(ALLOWED);
});

describe("requestPasswordResetAction", () => {
  it("asks Better Auth for a reset and says a link may be on its way", async () => {
    const state = await requestPasswordResetAction({ status: "idle" }, form("sam@example.test"));
    expect(state.status).toBe("sent");
    expect(state.message).toMatch(/if that address has an account/i);
    expect(requestPasswordReset).toHaveBeenCalledTimes(1);
    expect(requestPasswordReset.mock.calls[0]![0]).toMatchObject({
      body: { email: "sam@example.test" },
    });
  });

  it("gives the same reply when Better Auth throws, so nothing about the address leaks", async () => {
    requestPasswordReset.mockRejectedValueOnce(new Error("database went away"));
    const state = await requestPasswordResetAction({ status: "idle" }, form("sam@example.test"));
    expect(state.status).toBe("sent");
  });

  it("counts the request under its own bucket, keyed by the proxy's client ip", async () => {
    await requestPasswordResetAction({ status: "idle" }, form("sam@example.test"));
    expect(rateLimit).toHaveBeenCalledTimes(2);
    const [key, opts] = rateLimit.mock.calls[0]!;
    expect(key).toBe("forgot-password:203.0.113.9");
    expect(opts).toEqual({ limit: 5, windowSeconds: 3600 });
  });

  it("refuses once the budget is spent, and never reaches Better Auth", async () => {
    rateLimit.mockResolvedValueOnce(BLOCKED);
    const state = await requestPasswordResetAction({ status: "idle" }, form("sam@example.test"));
    expect(state.status).toBe("error");
    expect(state.message).toMatch(/30 minutes/);
    expect(requestPasswordReset).not.toHaveBeenCalled();
    // The address bucket is never consulted for a request the ip bucket refused.
    expect(rateLimit).toHaveBeenCalledTimes(1);
  });

  it("also counts the request per address, under a hash rather than the address itself", async () => {
    await requestPasswordResetAction({ status: "idle" }, form("Sam@Example.test"));
    const [key, opts] = rateLimit.mock.calls[1]!;
    // sha256("sam@example.test") — lowercased first, so case cannot split the bucket.
    expect(key).toBe(`forgot-password:email:${sha256("sam@example.test")}`);
    expect(key).not.toContain("sam@");
    expect(key).not.toContain("Sam@");
    expect(opts).toEqual({ limit: 3, windowSeconds: 3600 });
  });

  it("once an address is over budget, says 'sent' anyway and mints nothing", async () => {
    // Three go through, the fourth is refused by the address bucket while the
    // ip bucket still has room.
    const seen = new Map<string, number>();
    rateLimit.mockImplementation(async (key) => {
      if (key === null || !key.startsWith("forgot-password:email:")) return ALLOWED;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return n > 3 ? BLOCKED : ALLOWED;
    });
    for (let i = 0; i < 3; i++) {
      await requestPasswordResetAction({ status: "idle" }, form("sam@example.test"));
    }
    expect(requestPasswordReset).toHaveBeenCalledTimes(3);

    const fourth = await requestPasswordResetAction({ status: "idle" }, form("sam@example.test"));
    expect(fourth.status).toBe("sent");
    expect(fourth.message).toMatch(/if that address has an account/i);
    expect(requestPasswordReset).toHaveBeenCalledTimes(3);

    // A different address is a different bucket.
    const other = await requestPasswordResetAction({ status: "idle" }, form("pat@example.test"));
    expect(other.status).toBe("sent");
    expect(requestPasswordReset).toHaveBeenCalledTimes(4);
    expect(requestPasswordReset.mock.calls[3]![0]).toMatchObject({
      body: { email: "pat@example.test" },
    });
  });

  it("rejects a malformed address before it costs a request", async () => {
    const state = await requestPasswordResetAction({ status: "idle" }, form("not an address"));
    expect(state.status).toBe("error");
    expect(rateLimit).not.toHaveBeenCalled();
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });

  it("strips line breaks from the address rather than passing them on", async () => {
    await requestPasswordResetAction({ status: "idle" }, form("sam@example.test\r\nbcc: x"));
    // Cleaned, then failed validation: never sent to Better Auth.
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });
});

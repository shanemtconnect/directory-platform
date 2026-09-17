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
    expect(rateLimit).toHaveBeenCalledTimes(1);
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

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { RateLimitResult } from "@/lib/spam/rate-limit";

const handler = vi.fn(async () => new Response("ok", { status: 200 }));
const limitPublicWrite = vi.fn<(...a: unknown[]) => Promise<RateLimitResult>>();

vi.mock("@/lib/auth/server", () => ({ getAuth: () => ({ handler }) }));
vi.mock("@/lib/spam/write-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spam/write-limit")>()),
  limitPublicWrite: (...args: unknown[]) => limitPublicWrite(...args),
}));

const allowed: RateLimitResult = { allowed: true, remaining: 19, retryAfterSeconds: 0 };
const blocked: RateLimitResult = { allowed: false, remaining: 0, retryAfterSeconds: 420 };

function signIn(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ email: "a@example.com", password: "hunter2hunter2" }),
  });
}

describe("POST /api/auth/[...all]", () => {
  beforeEach(() => {
    handler.mockClear();
    limitPublicWrite.mockReset();
  });

  it("passes an allowed request through to Better Auth", async () => {
    limitPublicWrite.mockResolvedValue(allowed);
    const { POST } = await import("./route");

    const res = await POST(signIn({ "x-forwarded-for": "198.51.100.7" }));

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("counts against one shared bucket, from the request's own headers", async () => {
    limitPublicWrite.mockResolvedValue(allowed);
    const { POST } = await import("./route");
    const { AUTH_RATE_LIMIT } = await import("@/lib/spam/write-limit");
    const request = signIn({ "x-forwarded-for": "198.51.100.7" });

    await POST(request);

    expect(limitPublicWrite).toHaveBeenCalledWith("auth", request.headers, AUTH_RATE_LIMIT);
  });

  it("answers 429 with Retry-After and never reaches Better Auth when blocked", async () => {
    limitPublicWrite.mockResolvedValue(blocked);
    const { POST } = await import("./route");

    const res = await POST(signIn({ "x-forwarded-for": "198.51.100.7" }));

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("420");
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not leak how far through the budget a caller is", async () => {
    limitPublicWrite.mockResolvedValue(blocked);
    const { POST } = await import("./route");

    const body = await (await POST(signIn())).text();

    expect(body).not.toContain("198.51.100.7");
    expect(body.toLowerCase()).toContain("too many");
  });

  it("leaves GET unmetered — it is the session read every page does", async () => {
    limitPublicWrite.mockResolvedValue(blocked);
    const { GET } = await import("./route");

    const res = await GET(new Request("http://localhost/api/auth/get-session"));

    expect(res.status).toBe(200);
    expect(limitPublicWrite).not.toHaveBeenCalled();
  });

  it("is 20 attempts per 10 minutes", async () => {
    const { AUTH_RATE_LIMIT } = await import("@/lib/spam/write-limit");
    expect(AUTH_RATE_LIMIT).toEqual({ limit: 20, windowSeconds: 600 });
  });
});

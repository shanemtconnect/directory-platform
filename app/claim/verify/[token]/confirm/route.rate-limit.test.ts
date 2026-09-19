import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitResult } from "@/lib/spam/rate-limit";

const verifyClaimToken = vi.fn<(...a: unknown[]) => Promise<{ outcome: string; path?: string }>>();
const limitPublicWrite = vi.fn<(...a: unknown[]) => Promise<RateLimitResult>>();

vi.mock("@/lib/db/client", () => ({
  db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) },
  getDb: () => ({}),
}));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: async () => ({ role: "public" }) }));
vi.mock("@/lib/db/queries/claims", () => ({
  verifyClaimToken: (...args: unknown[]) => verifyClaimToken(...args),
}));
vi.mock("@/lib/spam/write-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spam/write-limit")>()),
  limitPublicWrite: (...args: unknown[]) => limitPublicWrite(...args),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const allowed: RateLimitResult = { allowed: true, remaining: 29, retryAfterSeconds: 0 };
const blocked: RateLimitResult = { allowed: false, remaining: 0, retryAfterSeconds: 30 };

function confirm(token: string): [Request, { params: Promise<{ token: string }> }] {
  return [
    new Request(`http://localhost:3215/claim/verify/${token}/confirm`, {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.7" },
    }),
    { params: Promise.resolve({ token }) },
  ];
}

describe("POST /claim/verify/[token]/confirm", () => {
  beforeEach(() => {
    verifyClaimToken.mockReset();
    limitPublicWrite.mockReset();
    limitPublicWrite.mockResolvedValue(allowed);
  });

  it("applies the claim and sends the claimant to their account", async () => {
    verifyClaimToken.mockResolvedValue({ outcome: "approved", path: "/a-city/a-listing" });
    const { POST } = await import("./route");

    const res = await POST(...confirm("tok-live"));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:3215/account?claim=approved");
  });

  it("counts every confirm against the bucket the landing page uses", async () => {
    verifyClaimToken.mockResolvedValue({ outcome: "unknown" });
    const { CLAIM_VERIFY_RATE_LIMIT } = await import("@/lib/spam/write-limit");
    const [request, ctx] = confirm("tok-guessed");
    const { POST } = await import("./route");

    await POST(request, ctx);

    expect(limitPublicWrite).toHaveBeenCalledWith("claim-verify", request.headers, CLAIM_VERIFY_RATE_LIMIT);
    expect(CLAIM_VERIFY_RATE_LIMIT).toEqual({ limit: 30, windowSeconds: 60 });
  });

  it("refuses a client over the limit with 429 and looks nothing up", async () => {
    limitPublicWrite.mockResolvedValue(blocked);
    const { POST } = await import("./route");

    const res = await POST(...confirm("tok-guessed"));

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(verifyClaimToken).not.toHaveBeenCalled();
  });
});

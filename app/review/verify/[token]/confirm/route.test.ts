import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitResult } from "@/lib/spam/rate-limit";
import type { VerifyReviewResult } from "@/lib/db/queries/reviews";

process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3215";

const verifyReviewToken = vi.fn<(...a: unknown[]) => Promise<VerifyReviewResult>>();
const notifyReviewVerified = vi.fn<(...a: unknown[]) => Promise<void>>();
const limitPublicWrite = vi.fn<(...a: unknown[]) => Promise<RateLimitResult>>();

vi.mock("@/lib/db/client", () => ({
  db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) },
  getDb: () => ({}),
}));
vi.mock("@/lib/features/flags", () => ({ isEnabled: () => true }));
vi.mock("@/lib/db/queries/reviews", () => ({
  verifyReviewToken: (...args: unknown[]) => verifyReviewToken(...args),
}));
vi.mock("@/lib/email/notify", () => ({
  notifyReviewVerified: (...args: unknown[]) => notifyReviewVerified(...args),
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
    new Request(`http://localhost:3215/review/verify/${token}/confirm`, {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.7" },
    }),
    { params: Promise.resolve({ token }) },
  ];
}

describe("POST /review/verify/[token]/confirm", () => {
  beforeEach(() => {
    verifyReviewToken.mockReset();
    notifyReviewVerified.mockReset();
    notifyReviewVerified.mockResolvedValue(undefined);
    limitPublicWrite.mockReset();
    limitPublicWrite.mockResolvedValue(allowed);
  });

  it("confirms and sends the reviewer to their review", async () => {
    verifyReviewToken.mockResolvedValue({
      outcome: "verified", reviewId: "r", listingId: "l", path: "/a-city/a-listing",
      status: "published", flaggedReason: null, repeat: false,
    });
    const { POST } = await import("./route");

    const res = await POST(...confirm("tok-live"));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:3215/a-city/a-listing/reviews");
  });

  it("counts every confirm against the bucket the landing page uses", async () => {
    verifyReviewToken.mockResolvedValue({ outcome: "unknown-token" });
    const { REVIEW_VERIFY_RATE_LIMIT } = await import("@/lib/spam/write-limit");
    const [request, ctx] = confirm("tok-guessed");
    const { POST } = await import("./route");

    await POST(request, ctx);

    expect(limitPublicWrite).toHaveBeenCalledWith("review-verify", request.headers, REVIEW_VERIFY_RATE_LIMIT);
    expect(REVIEW_VERIFY_RATE_LIMIT).toEqual({ limit: 30, windowSeconds: 60 });
  });

  it("refuses a client over the limit with 429 and looks nothing up", async () => {
    limitPublicWrite.mockResolvedValue(blocked);
    const { POST } = await import("./route");

    const res = await POST(...confirm("tok-guessed"));

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(verifyReviewToken).not.toHaveBeenCalled();
    expect(notifyReviewVerified).not.toHaveBeenCalled();
  });
});

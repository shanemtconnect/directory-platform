import { describe, expect, it, vi, beforeEach } from "vitest";
import type { RateLimitResult } from "@/lib/spam/rate-limit";

const recordOutreachClick = vi.fn<(...a: unknown[]) => Promise<{ listingId: string } | null>>();
const rateLimit = vi.fn<(...a: unknown[]) => Promise<RateLimitResult>>();

vi.mock("@/lib/db/client", () => ({ db: {}, getDb: () => ({}) }));
vi.mock("@/lib/db/queries/outreach", () => ({
  recordOutreachClick: (...args: unknown[]) => recordOutreachClick(...args),
}));
vi.mock("@/lib/spam/rate-limit", () => ({ rateLimit: (...args: unknown[]) => rateLimit(...args) }));

const LISTING = "11111111-1111-4111-8111-111111111111";
const allowed: RateLimitResult = { allowed: true, remaining: 9, retryAfterSeconds: 0 };
const blocked: RateLimitResult = { allowed: false, remaining: 0, retryAfterSeconds: 30 };

function open(token: string, headers: Record<string, string> = {}): [Request, { params: Promise<{ token: string }> }] {
  return [
    new Request(`http://localhost:3214/claim/outreach/${token}`, { headers }),
    { params: Promise.resolve({ token }) },
  ];
}

describe("GET /claim/outreach/[token]", () => {
  beforeEach(() => {
    recordOutreachClick.mockReset();
    rateLimit.mockReset();
    rateLimit.mockResolvedValue(allowed);
  });

  it("marks the click and 302s to the claim flow", async () => {
    recordOutreachClick.mockResolvedValue({ listingId: LISTING });
    const { GET } = await import("./route");

    const res = await GET(...open("tok-live"));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/claim/${LISTING}?via=outreach`);
    expect(recordOutreachClick).toHaveBeenCalledWith(expect.anything(), expect.anything(), "tok-live");
  });

  it("never lets a token be cached or leak through the referer", async () => {
    // The token is a bearer credential: a shared CDN cache or a referer header
    // handing it to the next site is the whole listing claimed by a stranger.
    recordOutreachClick.mockResolvedValue({ listingId: LISTING });
    const { GET } = await import("./route");
    const res = await GET(...open("tok-live"));
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("404s an unknown token rather than saying which half was wrong", async () => {
    recordOutreachClick.mockResolvedValue(null);
    const { GET } = await import("./route");
    const res = await GET(...open("tok-guessed"));
    expect(res.status).toBe(404);
  });

  it("rate-limits guesses by client IP", async () => {
    rateLimit.mockResolvedValue(blocked);
    const { GET } = await import("./route");

    const res = await GET(...open("tok-guessed", { "x-forwarded-for": "198.51.100.7" }));

    expect(res.status).toBe(429);
    expect(recordOutreachClick).not.toHaveBeenCalled();
  });
});

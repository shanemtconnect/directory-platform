import { describe, expect, it, vi, beforeEach } from "vitest";
import type { RateLimitResult } from "@/lib/spam/rate-limit";
import type { BadgeListing } from "@/lib/db/queries/badges";

const badgeListing = vi.fn<(...a: unknown[]) => Promise<BadgeListing | null>>();
const recordBadgeClick = vi.fn(async () => {});
const rateLimit = vi.fn<(...a: unknown[]) => Promise<RateLimitResult>>();

vi.mock("@/lib/db/client", () => ({ db: {}, getDb: () => ({}) }));
vi.mock("@/lib/db/queries/badges", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/queries/badges")>()),
  badgeListing: (...args: unknown[]) => badgeListing(...args),
}));
vi.mock("@/lib/badge/counters", () => ({
  recordBadgeClick: (...args: unknown[]) => recordBadgeClick(...(args as [])),
}));
vi.mock("@/lib/spam/rate-limit", () => ({ rateLimit: (...args: unknown[]) => rateLimit(...args) }));
// `after` runs its callback inline outside a request scope, which is what a
// unit test wants: the assertion happens after the handler resolves.
vi.mock("next/server", () => ({ after: (fn: () => unknown) => void fn() }));

const ROW: BadgeListing = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "The Old Mill",
  slug: "the-old-mill",
  claimStatus: "verified",
  ratingAvg: "4.8",
  ratingCount: 27,
  citySlug: "leeds",
  cityName: "Leeds",
  categoryName: "Barn Venues",
};

const allowed: RateLimitResult = { allowed: true, remaining: 99, retryAfterSeconds: 0 };
const blocked: RateLimitResult = { allowed: false, remaining: 0, retryAfterSeconds: 42 };

function click(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3214/api/badge-click${query}`, { headers });
}

describe("GET /api/badge-click", () => {
  beforeEach(() => {
    badgeListing.mockReset();
    recordBadgeClick.mockClear();
    rateLimit.mockReset();
    rateLimit.mockResolvedValue(allowed);
  });

  it("302s to the listing with the badge's utm tags and counts the click", async () => {
    badgeListing.mockResolvedValue(ROW);
    const { GET } = await import("./route");

    const res = await GET(click(`?id=${ROW.id}`, { "x-forwarded-for": "198.51.100.7" }));

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/leeds/the-old-mill");
    expect(location).toContain("utm_source=badge");
    expect(recordBadgeClick).toHaveBeenCalledWith(ROW.id);
  });

  it("is never cached — a redirect held by a CDN counts one click for ever", async () => {
    badgeListing.mockResolvedValue(ROW);
    const { GET } = await import("./route");
    const res = await GET(click(`?id=${ROW.id}`));
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("404s for a listing that is not published, and counts nothing", async () => {
    badgeListing.mockResolvedValue(null);
    const { GET } = await import("./route");

    const res = await GET(click(`?id=${ROW.id}`));

    expect(res.status).toBe(404);
    expect(recordBadgeClick).not.toHaveBeenCalled();
  });

  it("400s when the id is missing or malformed, without touching the database", async () => {
    const { GET } = await import("./route");
    for (const query of ["", "?id=", "?id=not-a-uuid"]) {
      const res = await GET(click(query));
      expect(res.status).toBe(400);
    }
    expect(badgeListing).not.toHaveBeenCalled();
  });

  it("rate-limits by client IP", async () => {
    rateLimit.mockResolvedValue(blocked);
    const { GET } = await import("./route");

    const res = await GET(click(`?id=${ROW.id}`, { "x-forwarded-for": "9.9.9.9, 198.51.100.7" }));

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    // The LAST hop is the one our proxy wrote; the left of the list is attacker-controlled.
    expect(rateLimit).toHaveBeenCalledWith("badge-click:198.51.100.7", expect.anything());
    expect(badgeListing).not.toHaveBeenCalled();
  });

  it("serves the redirect even when counting the click fails", async () => {
    badgeListing.mockResolvedValue(ROW);
    recordBadgeClick.mockRejectedValueOnce(new Error("redis is down"));
    const { GET } = await import("./route");

    const res = await GET(click(`?id=${ROW.id}`));

    expect(res.status).toBe(302);
  });
});

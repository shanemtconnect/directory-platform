import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitResult } from "@/lib/spam/rate-limit";
import type { StatEvent } from "@/lib/stats/counters";
import type { FeaturedClickEvent } from "@/lib/spots/clicks";

process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3245";

const recordStats = vi.fn<(events: StatEvent[]) => Promise<number>>();
const claimDailyView = vi.fn<(ip: string, listingId: string) => Promise<boolean>>();
const recordFeaturedClicks = vi.fn<(events: readonly FeaturedClickEvent[]) => Promise<number>>();
const limitPublicWrite = vi.fn<(...a: unknown[]) => Promise<RateLimitResult>>();

vi.mock("@/lib/stats/counters", () => ({
  recordStats: (events: StatEvent[]) => recordStats(events),
  claimDailyView: (ip: string, listingId: string) => claimDailyView(ip, listingId),
}));
vi.mock("@/lib/spots/clicks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spots/clicks")>()),
  recordFeaturedClicks: (events: readonly FeaturedClickEvent[]) => recordFeaturedClicks(events),
}));
vi.mock("@/lib/spam/write-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spam/write-limit")>()),
  limitPublicWrite: (...args: unknown[]) => limitPublicWrite(...args),
}));

const allowed: RateLimitResult = { allowed: true, remaining: 99, retryAfterSeconds: 0 };
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const LISTING = "11111111-1111-4111-8111-111111111111";
const SPOT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function beacon(body: unknown): Request {
  return new Request("http://localhost:3245/api/beacon", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": BROWSER, "x-forwarded-for": "198.51.100.7" },
    body: JSON.stringify(body),
  });
}
async function post(body: unknown): Promise<Response> {
  const { POST } = await import("./route");
  return POST(beacon(body));
}

describe("POST /api/beacon — featured clicks (Task 45)", () => {
  beforeEach(() => {
    recordStats.mockReset().mockResolvedValue(1);
    claimDailyView.mockReset().mockResolvedValue(true);
    recordFeaturedClicks.mockReset().mockResolvedValue(1);
    limitPublicWrite.mockReset().mockResolvedValue(allowed);
  });

  it("counts a click for the spot it was in, once per pair, capped, never as a listing stat", async () => {
    const res = await post({
      events: [
        { listingId: LISTING, metric: "featured_click", spotId: SPOT },
        { listingId: LISTING.toUpperCase(), metric: "featured_click", spotId: SPOT },
        { listingId: LISTING, metric: "featured_click" },
        { listingId: LISTING, metric: "featured_click", spotId: "not-a-uuid" },
        { listingId: LISTING, metric: "impression" },
      ],
    });
    expect(res.status).toBe(204);
    expect(recordFeaturedClicks).toHaveBeenCalledWith([{ spotId: SPOT, listingId: LISTING }]);
    expect(recordStats).toHaveBeenCalledWith([{ listingId: LISTING, metric: "impression" }]);
  });

  it("a beacon of clicks alone is not a bad request", async () => {
    const res = await post({ listingId: LISTING, metric: "featured_click", spotId: SPOT });
    expect(res.status).toBe(204);
    expect(recordFeaturedClicks).toHaveBeenCalledTimes(1);
    expect(recordStats).not.toHaveBeenCalled();
  });

  it("stops at the cap", async () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      listingId: `${i}${LISTING.slice(1)}`, metric: "featured_click", spotId: SPOT,
    }));
    await post({ events });
    expect(recordFeaturedClicks.mock.calls[0]![0]).toHaveLength(3);
  });
});

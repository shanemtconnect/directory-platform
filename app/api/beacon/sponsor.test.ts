import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitResult } from "@/lib/spam/rate-limit";
import type { StatEvent } from "@/lib/stats/counters";

process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3243";

const recordStats = vi.fn<(events: StatEvent[]) => Promise<number>>();
const claimDailyView = vi.fn<(ip: string, listingId: string) => Promise<boolean>>();
const recordSponsorImpressions = vi.fn<(ids: readonly string[]) => Promise<number>>();
const limitPublicWrite = vi.fn<(...a: unknown[]) => Promise<RateLimitResult>>();

vi.mock("@/lib/stats/counters", () => ({
  recordStats: (events: StatEvent[]) => recordStats(events),
  claimDailyView: (ip: string, listingId: string) => claimDailyView(ip, listingId),
}));
vi.mock("@/lib/ads/counters", () => ({
  recordSponsorImpressions: (ids: readonly string[]) => recordSponsorImpressions(ids),
}));
vi.mock("@/lib/spam/write-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spam/write-limit")>()),
  limitPublicWrite: (...args: unknown[]) => limitPublicWrite(...args),
}));

const allowed: RateLimitResult = { allowed: true, remaining: 99, retryAfterSeconds: 0 };
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const LISTING = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAMPAIGN_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function beacon(body: unknown): Request {
  return new Request("http://localhost:3243/api/beacon", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": BROWSER,
      "x-forwarded-for": "198.51.100.7",
    },
    body: JSON.stringify(body),
  });
}

async function post(body: unknown): Promise<Response> {
  const { POST } = await import("./route");
  return POST(beacon(body));
}

describe("POST /api/beacon — sponsor impressions (Task 43)", () => {
  beforeEach(() => {
    recordStats.mockReset().mockResolvedValue(1);
    claimDailyView.mockReset().mockResolvedValue(true);
    recordSponsorImpressions.mockReset().mockResolvedValue(1);
    limitPublicWrite.mockReset().mockResolvedValue(allowed);
  });

  it("counts a sponsor impression beside the listing events, once per campaign", async () => {
    const res = await post({
      events: [
        { listingId: LISTING, metric: "view" },
        { listingId: CAMPAIGN, metric: "sponsor_impression" },
        { listingId: CAMPAIGN.toUpperCase(), metric: "sponsor_impression" },
        { listingId: CAMPAIGN_2, metric: "sponsor_impression" },
      ],
    });
    expect(res.status).toBe(204);
    expect(recordStats).toHaveBeenCalledWith([{ listingId: LISTING, metric: "view" }]);
    expect(recordSponsorImpressions).toHaveBeenCalledWith([CAMPAIGN, CAMPAIGN_2]);
  });

  it("a page of nothing but sponsor cards is still a valid beacon", async () => {
    const res = await post({ events: [{ listingId: CAMPAIGN, metric: "sponsor_impression" }] });
    expect(res.status).toBe(204);
    expect(recordStats).not.toHaveBeenCalled();
    expect(recordSponsorImpressions).toHaveBeenCalledWith([CAMPAIGN]);
  });

  it("never accepts a sponsor click, and drops a malformed campaign id", async () => {
    const res = await post({
      events: [
        { listingId: CAMPAIGN, metric: "sponsor_click" },
        { listingId: "not-a-uuid", metric: "sponsor_impression" },
      ],
    });
    expect(res.status).toBe(400);
    expect(recordSponsorImpressions).not.toHaveBeenCalled();
  });

  it("caps how many campaigns one beacon may name", async () => {
    const { MAX_BEACON_SPONSOR_IMPRESSIONS } = await import("@/lib/ads/keys");
    const events = Array.from({ length: MAX_BEACON_SPONSOR_IMPRESSIONS + 5 }, (_, i) => ({
      listingId: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
      metric: "sponsor_impression",
    }));
    await post({ events });
    expect(recordSponsorImpressions.mock.calls[0]![0]).toHaveLength(MAX_BEACON_SPONSOR_IMPRESSIONS);
  });
});

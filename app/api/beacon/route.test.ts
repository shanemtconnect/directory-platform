import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitResult } from "@/lib/spam/rate-limit";
import type { StatEvent } from "@/lib/stats/counters";

// `siteOrigin()` reads this at call time; the Origin check compares against it.
process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3215";

const recordStats = vi.fn<(events: StatEvent[]) => Promise<number>>();
const limitPublicWrite = vi.fn<(...a: unknown[]) => Promise<RateLimitResult>>();

vi.mock("@/lib/stats/counters", () => ({
  recordStats: (events: StatEvent[]) => recordStats(events),
}));
vi.mock("@/lib/spam/write-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spam/write-limit")>()),
  limitPublicWrite: (...args: unknown[]) => limitPublicWrite(...args),
}));

const allowed: RateLimitResult = { allowed: true, remaining: 99, retryAfterSeconds: 0 };
const blocked: RateLimitResult = { allowed: false, remaining: 0, retryAfterSeconds: 42 };

const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const LISTING = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function beacon(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3215/api/beacon", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": BROWSER,
      "x-forwarded-for": "198.51.100.7",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function post(...args: Parameters<typeof beacon>): Promise<Response> {
  const { POST } = await import("./route");
  return POST(beacon(...args));
}

describe("POST /api/beacon", () => {
  beforeEach(() => {
    recordStats.mockReset();
    recordStats.mockResolvedValue(1);
    limitPublicWrite.mockReset();
    limitPublicWrite.mockResolvedValue(allowed);
  });

  it("counts a single view and answers 204 with no body", async () => {
    const res = await post({ listingId: LISTING, metric: "view" });

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(recordStats).toHaveBeenCalledWith([{ listingId: LISTING, metric: "view" }]);
  });

  it("counts a batch of impressions in one call", async () => {
    // One page of cards is one beacon, not one request per card.
    const res = await post({
      events: [
        { listingId: LISTING, metric: "impression" },
        { listingId: OTHER, metric: "impression" },
      ],
    });

    expect(res.status).toBe(204);
    expect(recordStats).toHaveBeenCalledWith([
      { listingId: LISTING, metric: "impression" },
      { listingId: OTHER, metric: "impression" },
    ]);
  });

  it("is never cached", async () => {
    const res = await post({ listingId: LISTING, metric: "view" });
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects a metric that is not view or impression", async () => {
    // Enquiries and shortlist saves are counted inside the transaction that
    // writes the row. Accepting them here would let anyone inflate the number
    // an owner is shown at renewal.
    for (const metric of ["enquiry", "shortlist_add", "badge_click", "views", ""]) {
      const res = await post({ listingId: LISTING, metric });
      expect(res.status, metric).toBe(400);
    }
    expect(recordStats).not.toHaveBeenCalled();
  });

  it("rejects a listing id that is not a uuid", async () => {
    const res = await post({ listingId: "../../admin", metric: "view" });

    expect(res.status).toBe(400);
    expect(recordStats).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON, or is not an object", async () => {
    expect((await post("not json at all")).status).toBe(400);
    expect((await post([1, 2, 3])).status).toBe(400);
    expect((await post(null)).status).toBe(400);
    expect(recordStats).not.toHaveBeenCalled();
  });

  it("rejects an oversized body without parsing it", async () => {
    const res = await post(`{"events":[${'{"listingId":"x"},'.repeat(2000)}{}]}`);

    expect(res.status).toBe(413);
    expect(recordStats).not.toHaveBeenCalled();
  });

  it("caps how many events one beacon may carry", async () => {
    const events = Array.from({ length: 200 }, () => ({ listingId: LISTING, metric: "impression" }));

    const res = await post({ events });

    expect(res.status).toBe(204);
    const { MAX_BEACON_EVENTS } = await import("@/lib/stats/keys");
    expect(recordStats.mock.calls[0]![0]).toHaveLength(MAX_BEACON_EVENTS);
  });

  it("drops the invalid entries of a batch and counts the rest", async () => {
    const res = await post({
      events: [
        { listingId: "nope", metric: "view" },
        { listingId: LISTING, metric: "impression" },
        { listingId: OTHER, metric: "enquiry" },
      ],
    });

    expect(res.status).toBe(204);
    expect(recordStats).toHaveBeenCalledWith([{ listingId: LISTING, metric: "impression" }]);
  });
});

describe("POST /api/beacon — who is counted", () => {
  beforeEach(() => {
    recordStats.mockReset();
    recordStats.mockResolvedValue(1);
    limitPublicWrite.mockReset();
    limitPublicWrite.mockResolvedValue(allowed);
  });

  it("ignores a crawler without counting anything", async () => {
    const res = await post(
      { listingId: LISTING, metric: "view" },
      { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
    );

    // 204, not 403: a crawler told it was blocked is a crawler that retries.
    expect(res.status).toBe(204);
    expect(recordStats).not.toHaveBeenCalled();
  });

  it("ignores a request with no user agent", async () => {
    const request = new Request("http://localhost:3215/api/beacon", {
      method: "POST",
      body: JSON.stringify({ listingId: LISTING, metric: "view" }),
    });
    const { POST } = await import("./route");

    expect((await POST(request)).status).toBe(204);
    expect(recordStats).not.toHaveBeenCalled();
  });

  it("checks the bot filter before spending a Redis round trip on the rate limit", async () => {
    await post({ listingId: LISTING, metric: "view" }, { "user-agent": "curl/8.7.1" });

    expect(limitPublicWrite).not.toHaveBeenCalled();
  });

  it("ignores a beacon posted from another origin", async () => {
    // The page that sends this is ours. A POST carrying somebody else's Origin
    // is an embed inflating a listing's numbers.
    const res = await post(
      { listingId: LISTING, metric: "view" },
      { origin: "https://not-our-site.example" },
    );

    expect(res.status).toBe(204);
    expect(recordStats).not.toHaveBeenCalled();
  });

  it("counts a beacon carrying our own origin", async () => {
    const res = await post(
      { listingId: LISTING, metric: "view" },
      { origin: "http://localhost:3215" },
    );

    expect(res.status).toBe(204);
    expect(recordStats).toHaveBeenCalled();
  });
});

describe("POST /api/beacon — rate limit", () => {
  beforeEach(() => {
    recordStats.mockReset();
    recordStats.mockResolvedValue(1);
    limitPublicWrite.mockReset();
  });

  it("counts every beacon against one per-IP bucket", async () => {
    limitPublicWrite.mockResolvedValue(allowed);
    const { BEACON_RATE_LIMIT } = await import("@/lib/spam/write-limit");
    const request = beacon({ listingId: LISTING, metric: "view" });
    const { POST } = await import("./route");

    await POST(request);

    expect(limitPublicWrite).toHaveBeenCalledWith("beacon", request.headers, BEACON_RATE_LIMIT);
  });

  it("refuses a client over the limit and says when to come back", async () => {
    limitPublicWrite.mockResolvedValue(blocked);

    const res = await post({ listingId: LISTING, metric: "view" });

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(recordStats).not.toHaveBeenCalled();
  });
});

describe("/api/beacon — other methods", () => {
  it("refuses GET", async () => {
    const { GET } = await import("./route");
    const res = await GET();

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

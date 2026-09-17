import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitResult } from "@/lib/spam/rate-limit";
import type { StatEvent } from "@/lib/stats/counters";

// `siteOrigin()` reads this at call time; the Origin check compares against it.
process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3215";

const recordStats = vi.fn<(events: StatEvent[]) => Promise<number>>();
const claimDailyView = vi.fn<(ip: string, listingId: string) => Promise<boolean>>();
const limitPublicWrite = vi.fn<(...a: unknown[]) => Promise<RateLimitResult>>();

vi.mock("@/lib/stats/counters", () => ({
  recordStats: (events: StatEvent[]) => recordStats(events),
  claimDailyView: (ip: string, listingId: string) => claimDailyView(ip, listingId),
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
    claimDailyView.mockReset();
    claimDailyView.mockResolvedValue(true);
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

  it("rejects a declared Content-Length over the limit before reading the body", async () => {
    // A well-formed, well-under-limit body — the only thing wrong is the
    // header. If the route reads the body before checking this, it would
    // reach `recordStats`; it must not.
    const res = await post(
      { listingId: LISTING, metric: "view" },
      { "content-length": "999999" },
    );

    expect(res.status).toBe(413);
    expect(recordStats).not.toHaveBeenCalled();
  });

  it("rejects a body whose UTF-8 byte length exceeds the limit even when its UTF-16 length does not", async () => {
    // Each "中" is one UTF-16 code unit (`.length` counts it once) but three
    // UTF-8 bytes. 6000 of them is 6000 chars — comfortably under the 16 KB
    // cap by a naive `.length` check — but 18,000 bytes on the wire.
    const raw = "中".repeat(6000);
    const res = await post(raw);

    expect(res.status).toBe(413);
    expect(recordStats).not.toHaveBeenCalled();
  });

  it("caps how many impressions one beacon may carry, and drops the rest silently", async () => {
    // 200 distinct listings, every one a valid impression. A page never
    // renders that many cards, so past the cap this is a forged batch — but
    // the script that overshoots is ours, so the tail is dropped, not the
    // whole beacon: still 204, still counted up to the cap.
    const events = Array.from({ length: 200 }, (_, i) => ({
      listingId: `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`,
      metric: "impression",
    }));

    const res = await post({ events });

    expect(res.status).toBe(204);
    const { MAX_BEACON_IMPRESSIONS } = await import("@/lib/stats/keys");
    expect(recordStats.mock.calls[0]![0]).toHaveLength(MAX_BEACON_IMPRESSIONS);
    expect(recordStats.mock.calls[0]![0][0]).toEqual({ listingId: events[0]!.listingId, metric: "impression" });
  });

  it("counts a repeated (listing, metric) pair once per beacon", async () => {
    // The same card listed a hundred times is one impression of one card,
    // whatever the body says — and the same id in a different case is the
    // same listing.
    const res = await post({
      events: [
        { listingId: LISTING, metric: "impression" },
        { listingId: LISTING, metric: "impression" },
        { listingId: LISTING.toUpperCase(), metric: "impression" },
        { listingId: OTHER, metric: "impression" },
        { listingId: LISTING, metric: "view" },
      ],
    });

    expect(res.status).toBe(204);
    expect(recordStats).toHaveBeenCalledWith([
      { listingId: LISTING, metric: "impression" },
      { listingId: OTHER, metric: "impression" },
      { listingId: LISTING, metric: "view" },
    ]);
  });

  it("counts at most one view per beacon", async () => {
    // One beacon is one page, and one page is one view. The endpoint used to
    // take a hundred, which multiplied the rate limit by a hundred.
    const res = await post({
      events: [
        { listingId: LISTING, metric: "view" },
        { listingId: OTHER, metric: "view" },
        { listingId: "33333333-3333-4333-8333-000000000000", metric: "view" },
        { listingId: OTHER, metric: "impression" },
      ],
    });

    expect(res.status).toBe(204);
    expect(recordStats).toHaveBeenCalledWith([
      { listingId: LISTING, metric: "view" },
      { listingId: OTHER, metric: "impression" },
    ]);
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
    claimDailyView.mockReset();
    claimDailyView.mockResolvedValue(true);
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

describe("POST /api/beacon — one view per address per listing per day", () => {
  beforeEach(() => {
    recordStats.mockReset();
    recordStats.mockResolvedValue(1);
    claimDailyView.mockReset();
    claimDailyView.mockResolvedValue(true);
    limitPublicWrite.mockReset();
    limitPublicWrite.mockResolvedValue(allowed);
  });

  it("asks the guard about the view, keyed by the client address and the listing", async () => {
    await post({ listingId: LISTING, metric: "view" });

    expect(claimDailyView).toHaveBeenCalledWith("198.51.100.7", LISTING);
    expect(recordStats).toHaveBeenCalledWith([{ listingId: LISTING, metric: "view" }]);
  });

  it("drops the view when the address has already been counted today, keeps the impressions, still 204", async () => {
    claimDailyView.mockResolvedValue(false);

    const res = await post({
      events: [
        { listingId: LISTING, metric: "view" },
        { listingId: OTHER, metric: "impression" },
      ],
    });

    expect(res.status).toBe(204);
    expect(recordStats).toHaveBeenCalledWith([{ listingId: OTHER, metric: "impression" }]);
  });

  it("drops a view-only beacon to nothing without telling the client", async () => {
    claimDailyView.mockResolvedValue(false);

    const res = await post({ listingId: LISTING, metric: "view" });

    expect(res.status).toBe(204);
    expect(recordStats).not.toHaveBeenCalled();
  });

  it("does not consult the guard for a beacon with no view in it", async () => {
    await post({ listingId: LISTING, metric: "impression" });

    expect(claimDailyView).not.toHaveBeenCalled();
  });

  it("counts normally when the client address is unknown", async () => {
    // No proxy header, no address to key a mark under. Counting is the right
    // default: a shared bucket for every unidentified visitor would let one
    // person's view stop everybody else's.
    const request = new Request("http://localhost:3215/api/beacon", {
      method: "POST",
      headers: { "user-agent": BROWSER },
      body: JSON.stringify({ listingId: LISTING, metric: "view" }),
    });
    const { POST } = await import("./route");

    expect((await POST(request)).status).toBe(204);
    expect(claimDailyView).not.toHaveBeenCalled();
    expect(recordStats).toHaveBeenCalledWith([{ listingId: LISTING, metric: "view" }]);
  });
});

describe("POST /api/beacon — rate limit", () => {
  beforeEach(() => {
    recordStats.mockReset();
    recordStats.mockResolvedValue(1);
    claimDailyView.mockReset();
    claimDailyView.mockResolvedValue(true);
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

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitResult } from "@/lib/spam/rate-limit";

const sponsorCampaignForClick = vi.fn<(...a: unknown[]) => Promise<{ id: string; targetUrl: string } | null>>();
const recordSponsorStat = vi.fn<(id: string, metric: string) => Promise<boolean>>();
const claimDailyClick = vi.fn<(ip: string, id: string) => Promise<boolean>>();
const limitPublicWrite = vi.fn<(...a: unknown[]) => Promise<RateLimitResult>>();
const afterCalls: Promise<unknown>[] = [];
const after = vi.fn<(fn: () => unknown) => void>((fn) => { afterCalls.push(Promise.resolve(fn())); });
const settled = () => Promise.all(afterCalls);

vi.mock("next/server", () => ({ after: (fn: () => void) => after(fn) }));
vi.mock("@/lib/db/client", () => ({ db: { marker: "the pool" } }));
vi.mock("@/lib/db/queries/ads", () => ({
  sponsorCampaignForClick: (...args: unknown[]) => sponsorCampaignForClick(...args),
}));
vi.mock("@/lib/ads/counters", () => ({
  recordSponsorStat: (id: string, metric: string) => recordSponsorStat(id, metric),
  claimDailyClick: (ip: string, id: string) => claimDailyClick(ip, id),
}));
vi.mock("@/lib/spam/write-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spam/write-limit")>()),
  limitPublicWrite: (...args: unknown[]) => limitPublicWrite(...args),
}));

const allowed: RateLimitResult = { allowed: true, remaining: 29, retryAfterSeconds: 0 };
const blocked: RateLimitResult = { allowed: false, remaining: 0, retryAfterSeconds: 17 };
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

async function get(id: string, headers: Record<string, string> = {}): Promise<Response> {
  const { GET } = await import("./route");
  const request = new Request(`http://localhost:3243/out/${id}`, {
    headers: { "x-forwarded-for": "198.51.100.7", "user-agent": BROWSER, ...headers },
  });
  return GET(request, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.resetModules();
  sponsorCampaignForClick.mockReset().mockResolvedValue({ id: ID, targetUrl: "https://acme.example/l?fbclid=1&utm_source=dir" });
  recordSponsorStat.mockReset().mockResolvedValue(true);
  claimDailyClick.mockReset().mockResolvedValue(true);
  afterCalls.length = 0;
  limitPublicWrite.mockReset().mockResolvedValue(allowed);
  after.mockClear();
});

describe("GET /out/[id]", () => {
  it("302s to the cleaned target, counts the click after the response, never caches", async () => {
    const res = await get(ID);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://acme.example/l?utm_source=dir");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(after).toHaveBeenCalledTimes(1);
    await settled();
    expect(claimDailyClick).toHaveBeenCalledWith("198.51.100.7", ID);
    expect(recordSponsorStat).toHaveBeenCalledWith(ID, "click");
    expect(sponsorCampaignForClick.mock.calls[0]![2]).toBe(ID);
  });

  it("lower-cases the id before the lookup", async () => {
    await get(ID.toUpperCase());
    expect(sponsorCampaignForClick.mock.calls[0]![2]).toBe(ID);
  });

  it("404s a malformed id without touching the rate limit or the database", async () => {
    const res = await get("not-a-uuid");
    expect(res.status).toBe(404);
    expect(limitPublicWrite).not.toHaveBeenCalled();
    expect(sponsorCampaignForClick).not.toHaveBeenCalled();
  });

  it("404s an unknown or inactive campaign and counts nothing", async () => {
    sponsorCampaignForClick.mockResolvedValue(null);
    const res = await get(ID);
    expect(res.status).toBe(404);
    expect(recordSponsorStat).not.toHaveBeenCalled();
  });

  it("404s rather than redirect to a target that is no longer safe", async () => {
    sponsorCampaignForClick.mockResolvedValue({ id: ID, targetUrl: "javascript:alert(1)" });
    expect((await get(ID)).status).toBe(404);
    expect(recordSponsorStat).not.toHaveBeenCalled();
  });

  it("429s with Retry-After under the 30/min budget", async () => {
    limitPublicWrite.mockResolvedValue(blocked);
    const res = await get(ID);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
    const [feature, , budget] = limitPublicWrite.mock.calls[0]!;
    expect(feature).toBe("sponsor-click");
    expect(budget).toEqual({ limit: 30, windowSeconds: 60 });
    expect(sponsorCampaignForClick).not.toHaveBeenCalled();
  });

  it("a crawler or unfurler is redirected but never counted (I5)", async () => {
    const res = await get(ID, { "user-agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" });
    expect(res.status).toBe(302);
    await settled();
    expect(after).not.toHaveBeenCalled();
    expect(recordSponsorStat).not.toHaveBeenCalled();
  });

  it("a second click from the same address today is redirected but not counted again (I5)", async () => {
    claimDailyClick.mockResolvedValue(false);
    const res = await get(ID);
    expect(res.status).toBe(302);
    await settled();
    expect(recordSponsorStat).not.toHaveBeenCalled();
  });

  it("with no address to key on, the click is counted", async () => {
    const res = await get(ID, { "x-forwarded-for": "" });
    expect(res.status).toBe(302);
    await settled();
    expect(claimDailyClick).not.toHaveBeenCalled();
    expect(recordSponsorStat).toHaveBeenCalledWith(ID, "click");
  });
});

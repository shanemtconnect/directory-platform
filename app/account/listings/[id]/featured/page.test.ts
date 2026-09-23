import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/db/viewer";
import type { BidHistoryEntry, BiddingListing, BidRow, SpotArea, SpotKey, SpotRow } from "@/lib/db/queries/spots";
import { elements, links, text } from "@/test/elements";

/**
 * What Task 45 adds to the owner's bidding page: the email's one-click link
 * prefills the amount on its spot, each held position shows its clicks, each
 * spot links its public leaderboard, and the bids' history is on the page.
 */
class NotFound extends Error {}
const currentViewer = vi.fn<() => Promise<Viewer>>();
const listingForBidding = vi.fn<() => Promise<BiddingListing | null>>();
const spotsForKeys = vi.fn<() => Promise<Map<string, SpotRow>>>();
const spotBids = vi.fn<() => Promise<BidRow[]>>();
const describeSpotKeys = vi.fn<(tx: unknown, viewer: unknown, keys: readonly SpotKey[]) => Promise<SpotArea[]>>();
const featuredClicksForListing = vi.fn<() => Promise<Map<string, number>>>();
const bidHistory = vi.fn<() => Promise<BidHistoryEntry[]>>();

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/db/client", () => ({ db: { marker: "pool" } }));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/auth/profile", () => ({ ensureProfile: async () => ({ id: "44444444-4444-4444-8444-444444444444" }) }));
vi.mock("@/lib/billing/paypal", () => ({ billingConfigured: () => false }));
vi.mock("@/lib/billing/featured-plan", () => ({ featuredPlanIdFor: () => null }));
vi.mock("@/lib/db/queries/spots", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/queries/spots")>()),
  listingForBidding: () => listingForBidding(),
  spotsForKeys: () => spotsForKeys(),
  spotBids: () => spotBids(),
  describeSpotKeys: (tx: unknown, viewer: unknown, keys: readonly SpotKey[]) => describeSpotKeys(tx, viewer, keys),
  currentFeaturedSubscription: async () => null,
  recentRaiseExpiry: async () => null,
  searchCities: async () => [],
  featuredClicksForListing: () => featuredClicksForListing(),
  bidHistory: () => bidHistory(),
}));

const LISTING = "33333333-3333-4333-8333-333333333333";
const CITY = "11111111-1111-4111-8111-111111111111";
const CAT = "22222222-2222-4222-8222-222222222222";
const SPOT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const listing: BiddingListing = {
  id: LISTING, name: "The Old Hall", cityId: CITY, cityName: "Leeds", citySlug: "leeds", cityPath: "/leeds",
  region: null, categoryIds: [CAT], eligible: true, reason: null,
};
const townSpot: SpotRow = { id: SPOT, areaKind: "city", areaId: CITY, categoryId: null, positions: 3, floorCents: 5000, status: "open" };
const ownBid: BidRow = {
  id: "bid-1", listingId: LISTING, amountCents: 6000, amountSetAt: new Date(), status: "active", position: 2,
  createdAt: new Date(), pendingAmountCents: null, subscriptionId: null,
};

beforeEach(() => {
  currentViewer.mockReset().mockResolvedValue({ role: "owner", userId: "u1" });
  listingForBidding.mockReset().mockResolvedValue(listing);
  spotsForKeys.mockReset().mockResolvedValue(new Map([[`city:${CITY}:-`, townSpot]]));
  spotBids.mockReset().mockResolvedValue([ownBid]);
  describeSpotKeys.mockReset().mockImplementation(async (_tx, _v, keys) =>
    keys.map((key) => ({ key, areaName: "Leeds", categoryName: key.categoryId === null ? null : "Barns" })),
  );
  featuredClicksForListing.mockReset().mockResolvedValue(new Map([[SPOT, 12]]));
  bidHistory.mockReset().mockResolvedValue([
    { at: new Date("2026-09-20T10:00:00Z"), action: "spots.bid_placed", bidId: "bid-1", key: { areaKind: "city", areaId: CITY, categoryId: null }, amountCents: 6000, meta: {} },
    { at: new Date("2026-09-21T10:00:00Z"), action: "spots.bid_lowered", bidId: "bid-1", key: { areaKind: "city", areaId: CITY, categoryId: null }, amountCents: 5500, meta: {} },
  ]);
});

async function render(query: Record<string, string> = {}) {
  const { default: Page } = await import("./page");
  return Page({ params: Promise.resolve({ id: LISTING }), searchParams: Promise.resolve(query) });
}

describe("featured page (Task 45)", () => {
  it("shows clicks beside a held position, links each spot's leaderboard, and lists the history", async () => {
    const el = await render();
    const body = text(el);
    expect(body).toContain("12 clicks in 30 days");
    expect(links(el).map((l) => l.href)).toContain(`/spots/${SPOT}`);
    expect(body).toContain("Your bid history");
    expect(body).toContain("Bid placed");
    expect(body).toContain("Bid lowered");
  });

  it("prefills the amount from the email's link on that spot only, and says so", async () => {
    const el = await render({ bid: `city:${CITY}:-`, amount: "88" });
    const forms = [...elements(el)].filter((e) => "defaultAmount" in (e.props as Record<string, unknown>));
    const town = forms.find((f) => (f.props as { keyString: string }).keyString === `city:${CITY}:-`)!;
    const cat = forms.find((f) => (f.props as { keyString: string }).keyString === `city:${CITY}:${CAT}`)!;
    expect((town.props as { defaultAmount: number }).defaultAmount).toBe(88);
    expect((cat.props as { defaultAmount: number }).defaultAmount).toBe(50);
    expect([...elements(el)].some((e) => (e.props as Record<string, unknown>)["data-testid"] === "prefill-notice")).toBe(true);
  });

  it("ignores a prefill that is not a whole positive amount", async () => {
    const el = await render({ bid: `city:${CITY}:-`, amount: "12.5" });
    const town = [...elements(el)].find((e) => (e.props as { keyString?: string }).keyString === `city:${CITY}:-` && "defaultAmount" in (e.props as object))!;
    expect((town.props as { defaultAmount: number }).defaultAmount).toBe(60);
    expect([...elements(el)].some((e) => (e.props as Record<string, unknown>)["data-testid"] === "prefill-notice")).toBe(false);
  });
});

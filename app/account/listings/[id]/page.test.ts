import { describe, it, expect, vi, beforeEach } from "vitest";
import { siteConfig } from "@/config/site.config";
import type { Viewer } from "@/lib/db/viewer";
import type { OwnerListingDetail } from "@/lib/db/queries/owner";
import type { ListingStatsResult } from "@/lib/db/queries/stats";
import { elements } from "@/test/elements";

/**
 * The owner's edit page is where the ROI panel lives.
 *
 * The beacon counters exist so an owner can see what the listing did; a panel
 * with no caller is a feature nobody has. What is only testable here is the
 * wiring: the page asks `listingStats` for the tier's own window, hands the
 * answer to the panel, and treats a refusal from either gate as a 404 rather
 * than a 403 — "you may not see this" confirms the row exists and is somebody's.
 */

class NotFound extends Error {}

const currentViewer = vi.fn<() => Promise<Viewer>>();
const ownerListing = vi.fn<() => Promise<OwnerListingDetail | null>>();
const listingStats = vi.fn<() => Promise<ListingStatsResult | null>>();

const DB = { marker: "the pool" };

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/db/client", () => ({ db: DB }));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/db/queries/owner", () => ({
  ownerListing: (...args: unknown[]) => ownerListing(...(args as [])),
}));
vi.mock("@/lib/db/queries/stats", () => ({
  listingStats: (...args: unknown[]) => listingStats(...(args as [])),
}));

const OWNER: Viewer = { role: "owner", userId: "user_owner" };
const LISTING_ID = "33333333-3333-4333-8333-333333333333";

const LISTING: OwnerListingDetail = {
  id: LISTING_ID,
  name: "The Old Hall",
  path: "/richmond/the-old-hall",
  status: "published",
  tier: "premium",
  claimStatus: "claimed",
  enquiryCount: 2,
  description: null,
  phone: null,
  website: null,
  socials: null,
  openingHours: null,
};

const STATS: ListingStatsResult = {
  listingId: LISTING_ID,
  listingName: "The Old Hall",
  tier: "premium",
  windowDays: 365,
  requestedDays: 365,
  capDays: 365,
  capped: false,
  days: [],
  totals: { views: 0, impressions: 0, enquiries: 0, shortlistAdds: 0, badgeClicks: 0 },
};

async function render() {
  const { default: page } = await import("./page");
  return await page({ params: Promise.resolve({ id: LISTING_ID }) });
}

beforeEach(() => {
  vi.resetModules();
  currentViewer.mockReset().mockResolvedValue(OWNER);
  ownerListing.mockReset().mockResolvedValue(LISTING);
  listingStats.mockReset().mockResolvedValue(STATS);
});

describe("/account/listings/[id]", () => {
  it("asks for the stats over the tier's own window, through the owner-gated query", async () => {
    await render();

    expect(listingStats).toHaveBeenCalledWith(
      DB,
      OWNER,
      LISTING_ID,
      siteConfig.tiers.premium.statsWindowDays,
    );
  });

  it("mounts the ROI panel with what the query returned", async () => {
    const { ListingStats } = await import("@/components/stats/ListingStats");
    const tree = await render();

    const panel = [...elements(tree)].find((el) => el.type === ListingStats);
    expect(panel).toBeDefined();
    expect((panel!.props as { stats: ListingStatsResult }).stats).toBe(STATS);
  });

  it("404s for a listing this viewer does not own, without asking for its stats", async () => {
    ownerListing.mockResolvedValue(null);

    await expect(render()).rejects.toThrow(NotFound);
    expect(listingStats).not.toHaveBeenCalled();
  });

  it("404s when the stats query refuses the viewer", async () => {
    listingStats.mockResolvedValue(null);

    await expect(render()).rejects.toThrow(NotFound);
  });
});

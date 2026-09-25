import { beforeEach, describe, expect, it, vi } from "vitest";
import { elements } from "@/test/elements";
import type { PublicListing } from "@/lib/db/queries/listings";

/**
 * The catch-all's pillar branch, with every query mocked — resolveRoute and
 * pillarHeading always resolve to a fixed city scope, so these tests exercise
 * exactly the wiring `renderCatchAll`/`buildCatchAllMetadata` do themselves:
 * which query result goes into which prop, and what `verified` changes in
 * the metadata. `PillarPage`, `Pagination` and `VerifiedToggle` are real
 * (unmocked) — `elements()` walks into them, so a test can find what THEY
 * rendered, not just what the route passed them.
 */

class NotFound extends Error {}

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  permanentRedirect: (to: string) => {
    throw new Error(`PERMANENT_REDIRECT ${to}`);
  },
}));
vi.mock("@/lib/db/client", () => ({ db: { marker: "the pool" } }));
vi.mock("@/lib/features/flags", () => ({ features: { awards: false, reviews: false } }));

const resolveRoute = vi.fn();
vi.mock("@/lib/routing/resolve", () => ({ resolveRoute: (...a: unknown[]) => resolveRoute(...a) }));

const pillarHeading = vi.fn();
vi.mock("@/lib/db/queries/cities", () => ({ pillarHeading: (...a: unknown[]) => pillarHeading(...a) }));

const listListings = vi.fn();
const countListings = vi.fn();
vi.mock("@/lib/db/queries/listings", () => ({
  listListings: (...a: unknown[]) => listListings(...a),
  countListings: (...a: unknown[]) => countListings(...a),
  PER_PAGE: 24,
}));

vi.mock("@/lib/db/queries/indexes", () => ({
  categoriesInCity: () => Promise.resolve([]),
  nearbyCities: () => Promise.resolve([]),
}));
// Task 52's neighbourhood block: off here, and mocked so the real module
// (which imports from the fully-mocked listings module) never loads.
vi.mock("@/lib/geo/neighbourhoods", () => ({ neighbourhoodsEnabled: () => false }));
vi.mock("@/lib/db/queries/neighbourhoods", () => ({ cityNeighbourhoods: () => Promise.resolve([]) }));
vi.mock("@/lib/db/queries/spots", () => ({
  // Empty bids: the Featured section falls back to the premium row, which is
  // exactly the case the review found broken.
  featuredForScope: () => Promise.resolve([]),
}));
vi.mock("@/lib/db/queries/awards", () => ({
  awardYearsForListings: () => Promise.resolve(new Map()),
  awardText: () => "",
  listingAwards: () => Promise.resolve([]),
}));

const CITY_ID = "11111111-1111-1111-1111-111111111111";
const SCOPE = { type: "city" as const, cityId: CITY_ID };

function pillarResult(page = 1) {
  return { kind: "pillar" as const, scope: SCOPE, page };
}

const HEADING = {
  faq: [],
  title: "Venues in Leeds",
  place: "Leeds",
  nounSingular: "venue",
  nounPlural: "venues",
  introHtml: null,
  isIndexable: true,
  listingCount: 2,
};

function listing(id: string, tier: PublicListing["tier"], claimStatus: PublicListing["claimStatus"]): PublicListing {
  return {
    id, createdAt: new Date(), updatedAt: new Date(), name: `Listing ${id}`, slug: id,
    cityId: CITY_ID, areaId: null, verticalId: "v", primaryCategoryId: "cat",
    status: "published", tier, claimStatus, ownerId: null,
    addressLine1: null, addressLine2: null, postcode: null, lat: null, lng: null,
    phone: null, email: null, website: null, socials: null,
    shortDescription: null, description: null, offers: null, openingHours: null, timezone: null,
    customFields: null, priceRange: null, rankBoost: 0, backlinkBoost: 0,
    ratingAvg: null, ratingCount: 0, verifiedAt: null, verifiedExpiresAt: null, verifiedBy: null,
    viewCount: 0, enquiryCount: 0, source: "seed", sourceUrl: null, importedAt: null, publishedAt: null,
  } as PublicListing;
}

const verifiedFree = listing("verified-free", "free", "verified");
// Pays for premium, but has not (yet) been verified — the exact scenario the
// review flagged: this listing must stay in Featured even when the grid is
// filtered to verified-only.
const premiumUnverified = listing("premium-unverified", "premium", "unclaimed");

beforeEach(() => {
  vi.resetModules();
  resolveRoute.mockReset().mockResolvedValue(pillarResult());
  pillarHeading.mockReset().mockResolvedValue(HEADING);
  listListings.mockReset().mockImplementation((_tx, _viewer, _scope, opts: { verified?: boolean } = {}) =>
    Promise.resolve(opts.verified ? [verifiedFree] : [premiumUnverified, verifiedFree]),
  );
  countListings.mockReset().mockImplementation((_tx, _viewer, _scope, opts: { verified?: boolean } = {}) =>
    Promise.resolve(opts.verified ? 1 : 2),
  );
});

async function findPillarPage(node: unknown) {
  const { PillarPage } = await import("@/components/pillar/PillarPage");
  const found = [...elements(node as never)].find((el) => el.type === PillarPage);
  if (!found) throw new Error("PillarPage was not rendered");
  return found.props as {
    featured: PublicListing[];
    listings: PublicListing[];
    verified: boolean;
    hasVerified: boolean;
  };
}

describe("renderCatchAll — pillar, verified=1", () => {
  it("keeps an unverified premium listing in Featured — the premium row is built from the UNFILTERED page 1, never the filtered grid", async () => {
    const { renderCatchAll } = await import("./page");
    const jsx = await renderCatchAll(
      { params: Promise.resolve({ segments: ["leeds"] }) },
      { verified: true },
    );
    const props = await findPillarPage(jsx);

    expect(props.verified).toBe(true);
    // The grid itself IS filtered.
    expect(props.listings.map((l) => l.id)).toEqual(["verified-free"]);
    // But Featured (the premium fallback) still carries the unverified payer.
    expect(props.featured.map((l) => l.id)).toContain("premium-unverified");
  });

  it("on the unfiltered route, the premium row is unchanged (no second query, same rows)", async () => {
    const { renderCatchAll } = await import("./page");
    const jsx = await renderCatchAll({ params: Promise.resolve({ segments: ["leeds"] }) }, { verified: false });
    const props = await findPillarPage(jsx);

    expect(props.featured.map((l) => l.id)).toContain("premium-unverified");
    // Only ONE listListings call for page 1 when unfiltered — the extra
    // "unfiltered premium source" query only runs when verified is true.
    const page1Calls = listListings.mock.calls.filter(
      (c) => (c[3] as { page?: number } | undefined)?.page === 1,
    );
    expect(page1Calls).toHaveLength(1);
  });

  it("does not run the extra unfiltered query on page 2 (no premium row there regardless)", async () => {
    resolveRoute.mockResolvedValue(pillarResult(2));
    countListings.mockImplementation((_tx: unknown, _viewer: unknown, _scope: unknown, opts: { verified?: boolean } = {}) =>
      Promise.resolve(opts.verified ? 30 : 30),
    );
    const { renderCatchAll } = await import("./page");
    await renderCatchAll({ params: Promise.resolve({ segments: ["leeds", "page", "2"] }) }, { verified: true });

    const page1Calls = listListings.mock.calls.filter(
      (c) => (c[3] as { page?: number } | undefined)?.page === 1,
    );
    expect(page1Calls).toHaveLength(0);
  });

  it("the toggle is hidden when the scope has zero verified listings", async () => {
    countListings.mockImplementation((_tx: unknown, _viewer: unknown, _scope: unknown, opts: { verified?: boolean } = {}) =>
      Promise.resolve(opts.verified ? 0 : 2),
    );
    const { renderCatchAll } = await import("./page");
    const jsx = await renderCatchAll({ params: Promise.resolve({ segments: ["leeds"] }) }, { verified: false });
    const props = await findPillarPage(jsx);

    expect(props.hasVerified).toBe(false);
    const { VerifiedToggle } = await import("@/components/pillar/VerifiedToggle");
    const toggle = [...elements(jsx)].find((el) => el.type === VerifiedToggle);
    expect(toggle, "VerifiedToggle must still mount — it decides for itself whether to render").toBeTruthy();
    expect((toggle!.props as { hasVerified: boolean }).hasVerified).toBe(false);
  });
});

describe("renderCatchAll — verified=1 on a non-pillar kind redirects to the clean URL", () => {
  it("a listing page reached with verified=1 redirects, dropping the param — no ISR bypass on 5,000 listing URLs via the query string", async () => {
    resolveRoute.mockResolvedValue({ kind: "listing", listingId: "l1" });
    const { renderCatchAll } = await import("./page");
    await expect(
      renderCatchAll({ params: Promise.resolve({ segments: ["leeds", "some-venue"] }) }, { verified: true }),
    ).rejects.toThrow("REDIRECT /leeds/some-venue");
  });

  it("a reviews page reached with verified=1 redirects too", async () => {
    resolveRoute.mockResolvedValue({ kind: "listing-reviews", listingId: "l1", parentId: "l1", page: 1 });
    const { renderCatchAll } = await import("./page");
    await expect(
      renderCatchAll({ params: Promise.resolve({ segments: ["leeds", "some-venue", "reviews"] }) }, { verified: true }),
    ).rejects.toThrow("REDIRECT /leeds/some-venue/reviews");
  });

  it("the same listing kind is untouched when verified is false — this is a verified-only redirect, not a new general rule", async () => {
    resolveRoute.mockResolvedValue({ kind: "listing", listingId: "l1" });
    vi.doMock("@/lib/db/queries/listing-detail", () => ({
      getListingDetail: () => Promise.resolve(null),
      relatedListings: () => Promise.resolve([]),
    }));
    const { renderCatchAll } = await import("./page");
    // Falls through to the real "listing" branch (not the new redirect
    // guard) and 404s the normal way, because getListingDetail is null here
    // — proving the guard did NOT fire.
    await expect(
      renderCatchAll({ params: Promise.resolve({ segments: ["leeds", "some-venue"] }) }, { verified: false }),
    ).rejects.toThrow(NotFound);
  });
});

describe("buildCatchAllMetadata — pillar, verified=1", () => {
  it("forces noindex and keeps the canonical on the unfiltered URL, even though the city itself is indexable", async () => {
    const { buildCatchAllMetadata } = await import("./page");
    const metadata = await buildCatchAllMetadata(
      { params: Promise.resolve({ segments: ["leeds"] }) },
      { verified: true },
    );

    expect(HEADING.isIndexable).toBe(true); // the precondition this test is about
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe("/leeds");
  });

  it("the unfiltered metadata for the same indexable city carries no noindex override", async () => {
    const { buildCatchAllMetadata } = await import("./page");
    const metadata = await buildCatchAllMetadata(
      { params: Promise.resolve({ segments: ["leeds"] }) },
      { verified: false },
    );

    expect(metadata.robots).toBeUndefined();
    expect(metadata.alternates?.canonical).toBe("/leeds");
  });

  it("noindexes the verified view even under a city that is not indexable on its own", async () => {
    pillarHeading.mockResolvedValue({ ...HEADING, isIndexable: false });
    const { buildCatchAllMetadata } = await import("./page");
    const metadata = await buildCatchAllMetadata(
      { params: Promise.resolve({ segments: ["leeds"] }) },
      { verified: true },
    );

    expect(metadata.robots).toEqual({ index: false, follow: true });
  });
});

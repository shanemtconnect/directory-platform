import type { BidRow, BiddingListing, CityMatch, SpotArea, SpotKey, SpotRow } from "@/lib/db/queries/spots";
import { citySpotKey, regionSpotKey, spotKeyString } from "@/lib/db/queries/spots";
import { minimumToEnter, minimumToTakeFirst, type SpotStanding } from "./rank";

/**
 * The owner's bidding table, as data.
 *
 * Which spots a listing is offered, in what order, and what each one costs
 * to enter or to lead — computed from rows the page has already read, so the
 * page is a loop and this is testable without one.
 */

export type SpotGroup = "here" | "region" | "other";

export interface SpotKeyRef {
  readonly key: SpotKey;
  readonly group: SpotGroup;
}

/**
 * This city and its category spots first, then the region's, then any
 * "other area" the owner searched for. Category-less spots lead each group.
 */
export function spotKeysFor(listing: BiddingListing, others: readonly CityMatch[] = []): SpotKeyRef[] {
  const out: SpotKeyRef[] = [];
  const withCategories = (make: (categoryId: string | null) => SpotKey, group: SpotGroup) => {
    out.push({ key: make(null), group });
    for (const categoryId of listing.categoryIds) out.push({ key: make(categoryId), group });
  };
  withCategories((c) => citySpotKey(listing.cityId, c), "here");
  if (listing.region !== null) {
    const region = listing.region;
    withCategories((c) => regionSpotKey(region, c), "region");
  }
  const seenRegions = new Set(listing.region === null ? [] : [regionSpotKey(listing.region, null).areaId]);
  for (const city of others) {
    if (city.id === listing.cityId) continue;
    withCategories((c) => citySpotKey(city.id, c), "other");
    if (city.region !== null) {
      const key = regionSpotKey(city.region, null);
      if (!seenRegions.has(key.areaId)) {
        seenRegions.add(key.areaId);
        const region = city.region;
        withCategories((c) => regionSpotKey(region, c), "other");
      }
    }
  }
  return out;
}

export interface SpotTableRow {
  readonly key: SpotKey;
  readonly keyString: string;
  readonly group: SpotGroup;
  readonly spotId: string | null;
  readonly areaName: string;
  readonly categoryName: string | null;
  readonly closed: boolean;
  readonly positions: number;
  readonly floorCents: number;
  /** The featured amounts, highest first — public. */
  readonly top: readonly number[];
  readonly yourAmountCents: number | null;
  readonly yourPendingCents: number | null;
  readonly yourPosition: number | null;
  readonly yourStatus: BidRow["status"] | null;
  readonly minToTakeFirstCents: number;
  readonly minToEnterCents: number;
}

export interface TableInput {
  readonly listing: BiddingListing;
  readonly keys: readonly SpotKeyRef[];
  readonly spots: ReadonlyMap<string, SpotRow>;
  readonly bidsBySpot: ReadonlyMap<string, readonly BidRow[]>;
  readonly areas: readonly SpotArea[];
  readonly config: { readonly positions: number; readonly floors: { readonly city: number; readonly region: number } };
}

export function buildSpotTable(input: TableInput): SpotTableRow[] {
  const names = new Map(input.areas.map((a) => [spotKeyString(a.key), a]));
  return input.keys.map(({ key, group }) => {
    const keyString = spotKeyString(key);
    const spot = input.spots.get(keyString) ?? null;
    const bids = spot === null ? [] : (input.bidsBySpot.get(spot.id) ?? []);
    const own = bids.find((b) => b.listingId === input.listing.id) ?? null;
    const featured = bids
      .filter((b) => b.status === "active" && b.position !== null)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const positions = spot?.positions ?? input.config.positions;
    const floorCents = spot?.floorCents ?? Math.round(input.config.floors[key.areaKind] * 100);
    const standing: SpotStanding = {
      floorCents,
      positions,
      featured: featured.filter((b) => b.listingId !== input.listing.id).map((b) => b.amountCents),
    };
    const area = names.get(keyString);
    return {
      key,
      keyString,
      group,
      spotId: spot?.id ?? null,
      areaName: area?.areaName ?? key.areaId,
      categoryName: area?.categoryName ?? null,
      closed: spot?.status === "closed",
      positions,
      floorCents,
      top: featured.map((b) => b.amountCents),
      yourAmountCents: own?.amountCents ?? null,
      yourPendingCents: own?.pendingAmountCents ?? null,
      yourPosition: own?.position ?? null,
      yourStatus: own?.status ?? null,
      minToTakeFirstCents: minimumToTakeFirst(standing),
      minToEnterCents: minimumToEnter(standing),
    };
  });
}

/** What the listing is billed a month: its featured positions, and nothing else. */
export function monthlyTotalCents(rows: readonly SpotTableRow[]): number {
  return rows.reduce(
    (sum, r) => sum + (r.yourStatus === "active" && r.yourPosition !== null ? (r.yourAmountCents ?? 0) : 0),
    0,
  );
}

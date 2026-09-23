import { siteConfig } from "@/config/site.config";
import {
  allSpots,
  describeSpotKeys,
  isUnsubscribed,
  listingForSystem,
  publishedCityAreas,
  regionSpotKey,
  citySpotKey,
  spotBids,
  spotFills,
  spotKeyString,
  spotPaths,
  spotsForKeys,
  type SpotKey,
  type SpotRow,
} from "@/lib/db/queries/spots";
import type { TestDb } from "@/lib/db/types";
import type { Viewer } from "@/lib/db/viewer";
import { minimumToEnter } from "./rank";
import { spotKeysFor } from "./table";

/**
 * Where there is room (Task 45): the numbers behind the monthly digest, the
 * admin availability table and the CSV.
 *
 * A spot that has never been bid on has no row — `ensureSpot` creates it
 * lazily — but it is still a place with three empty positions at the
 * configured floor. So an "empty spot" is either a row with fewer featured
 * bids than positions, or a page (a published city, a region) with no row
 * at all. Category spots without a row are NOT invented: every city times
 * every category is not an outreach list, it is noise.
 */

const SYSTEM: Viewer = { role: "admin", userId: "00000000-0000-0000-0000-000000000000" };

export interface ListingAvailability {
  readonly listingName: string;
  readonly ownerEmail: string | null;
  readonly unsubscribed: boolean;
  /** Spots on this listing's pages with room that the listing does not already hold. */
  readonly emptyCount: number;
  /** The cheapest way into one of them, in minor units. */
  readonly fromCents: number;
}

const floorFor = (key: SpotKey) => Math.round(siteConfig.featured.floors[key.areaKind] * 100);

/**
 * For one listing: how many of its spots (its town, its town × categories,
 * its region, its region × categories) have a free position it is not in,
 * and the cheapest entry among them. Null for a listing that may not bid.
 */
export async function availabilityForListing(
  tx: TestDb,
  _viewer: Viewer,
  listingId: string,
): Promise<ListingAvailability | null> {
  const listing = await listingForSystem(tx, SYSTEM, listingId);
  if (listing === null || !listing.eligible) return null;
  const keys = spotKeysFor(listing);
  const spots = await spotsForKeys(tx, SYSTEM, keys.map((k) => k.key));
  let emptyCount = 0;
  let fromCents = Number.POSITIVE_INFINITY;
  for (const { key } of keys) {
    const spot = spots.get(spotKeyString(key)) ?? null;
    if (spot?.status === "closed") continue;
    const bids = spot === null ? [] : await spotBids(tx, SYSTEM, spot.id);
    const featured = bids.filter((b) => b.status === "active" && b.position !== null);
    if (featured.some((b) => b.listingId === listing.id)) continue;
    const positions = spot?.positions ?? siteConfig.featured.positions;
    if (featured.length >= positions) continue;
    emptyCount += 1;
    const entry = minimumToEnter({
      floorCents: spot?.floorCents ?? floorFor(key),
      positions,
      featured: featured.map((b) => b.amountCents),
    });
    fromCents = Math.min(fromCents, entry);
  }
  const ownerEmail = listing.ownerEmail;
  return {
    listingName: listing.name,
    ownerEmail,
    unsubscribed: ownerEmail === null ? false : await isUnsubscribed(tx, SYSTEM, ownerEmail),
    emptyCount,
    fromCents: emptyCount === 0 ? 0 : fromCents,
  };
}

export interface EmptySpotRow {
  /** Null for a page with no spot row yet. */
  readonly spotId: string | null;
  readonly key: SpotKey;
  readonly keyString: string;
  readonly areaName: string;
  readonly categoryName: string | null;
  readonly status: SpotRow["status"];
  readonly positions: number;
  readonly floorCents: number;
  readonly filled: number;
  readonly topCents: number | null;
  /** The public page the spot sits on, when it can be named cheaply. */
  readonly path: string | null;
}

/**
 * The site-wide table: every spot row, plus a virtual row for every
 * published city and every region without one. Closed spots are in it
 * (the admin table shows them) — callers wanting the outreach list filter
 * `status === "open" && filled < positions`.
 */
export async function emptySpotsReport(tx: TestDb, _viewer: Viewer): Promise<EmptySpotRow[]> {
  const [rows, fills, areas] = await Promise.all([allSpots(tx, SYSTEM), spotFills(tx, SYSTEM), publishedCityAreas(tx, SYSTEM)]);
  const keys: SpotKey[] = rows.map((r) => ({ areaKind: r.areaKind, areaId: r.areaId, categoryId: r.categoryId }));
  const have = new Set(keys.map(spotKeyString));
  const virtual: SpotKey[] = [];
  const regions = new Set<string>();
  for (const city of areas) {
    const key = citySpotKey(city.id, null);
    if (!have.has(spotKeyString(key))) virtual.push(key);
    if (city.region !== null) regions.add(city.region);
  }
  for (const region of [...regions].sort()) {
    const key = regionSpotKey(region, null);
    if (!have.has(spotKeyString(key))) virtual.push(key);
  }
  const names = new Map((await describeSpotKeys(tx, SYSTEM, [...keys, ...virtual])).map((a) => [spotKeyString(a.key), a]));
  const citySlug = new Map(areas.map((c) => [c.id, c.slug]));
  const out: EmptySpotRow[] = [];
  for (const r of rows) {
    const key: SpotKey = { areaKind: r.areaKind, areaId: r.areaId, categoryId: r.categoryId };
    const keyString = spotKeyString(key);
    const fill = fills.get(r.id) ?? { filled: 0, topCents: null };
    const area = names.get(keyString);
    out.push({
      spotId: r.id,
      key,
      keyString,
      areaName: area?.areaName ?? r.areaId,
      categoryName: area?.categoryName ?? null,
      status: r.status,
      positions: r.positions,
      floorCents: r.floorCents,
      filled: fill.filled,
      topCents: fill.topCents,
      path: (await spotPaths(tx, SYSTEM, r.id))[0] ?? null,
    });
  }
  for (const key of virtual) {
    const keyString = spotKeyString(key);
    const area = names.get(keyString);
    out.push({
      spotId: null,
      key,
      keyString,
      areaName: area?.areaName ?? key.areaId,
      categoryName: null,
      status: "open",
      positions: siteConfig.featured.positions,
      floorCents: floorFor(key),
      filled: 0,
      topCents: null,
      path: key.areaKind === "city" ? `/${citySlug.get(key.areaId) ?? ""}` : `/areas/${key.areaId}`,
    });
  }
  return out.sort((a, b) => a.areaName.localeCompare(b.areaName) || (a.categoryName ?? "").localeCompare(b.categoryName ?? ""));
}

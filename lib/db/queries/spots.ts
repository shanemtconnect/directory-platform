import { and, asc, eq, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { siteConfig } from "@/config/site.config";
import {
  cities,
  featuredBids,
  featuredSpots,
  featuredSubscriptions,
  listingCategories,
  listings,
  slugs,
  subscriptions,
} from "@/lib/db/schema";
import { now } from "@/lib/clock";
import { ensureProfile } from "@/lib/auth/profile";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";
import type { PillarScope } from "@/lib/routing/scope";
import { slugify } from "@/lib/routing/slugify";
import type { BidStatus, ChargeableBid, RankableBid, RankedBid } from "@/lib/spots/rank";
import { writeAuditAs } from "./audit";
import { LIVE_SUBSCRIPTION_STATUSES } from "./billing";
import { publicListingColumns, publishedListings, type PublicListing } from "./listings";

/**
 * Every database access featured spots make.
 *
 * `lib/spots/rank.ts` decides; this file reads and writes. Nothing here
 * ranks, prices or recomputes a quantity — it hands the rows to the pure
 * functions and writes what they hand back. What it does own is the gates:
 * the owner's listing through `owner_id = profiles.id` (constraint 24), the
 * public row through `publishedListings` (constraint 7), and the system
 * writes behind `isAdmin` (the webhook and the sync job).
 *
 * `listings.tier` is not written here, ever. Featured placement is separate
 * state (`featured_bids.position`) and a separate subscription.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const FEATURED_PROVIDER = "paypal";

/** A featured subscription that is still, or may still become, billing. */
export const LIVE_FEATURED_STATUSES = ["approval_pending", "active", "past_due"] as const;

function assertSignedIn(viewer: Viewer): void {
  if (viewer.role === "public") throw new Error("FORBIDDEN");
}

function assertWorker(viewer: Viewer): void {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
}

/* ---------------------------------------------------------------------- spots */

export type AreaKind = "city" | "region";

export interface SpotKey {
  readonly areaKind: AreaKind;
  /** The city's uuid, or `slugify(region)`. */
  readonly areaId: string;
  readonly categoryId: string | null;
}

export function citySpotKey(cityId: string, categoryId: string | null): SpotKey {
  return { areaKind: "city", areaId: cityId, categoryId };
}

/** Regions have no table; `cities.region` is the group and its slug the key. */
export function regionSpotKey(region: string, categoryId: string | null): SpotKey {
  return { areaKind: "region", areaId: slugify(region), categoryId };
}

/** The unique index treats a null category as the nil uuid; so does this. */
export function spotKeyString(key: SpotKey): string {
  return `${key.areaKind}:${key.areaId}:${key.categoryId ?? "-"}`;
}

export interface SpotRow {
  readonly id: string;
  readonly areaKind: AreaKind;
  readonly areaId: string;
  readonly categoryId: string | null;
  readonly positions: number;
  readonly floorCents: number;
  readonly status: "open" | "closed";
}

const spotColumns = {
  id: featuredSpots.id,
  areaKind: featuredSpots.areaKind,
  areaId: featuredSpots.areaId,
  categoryId: featuredSpots.categoryId,
  positions: featuredSpots.positions,
  floorCents: featuredSpots.floorCents,
  status: featuredSpots.status,
} as const;

function toSpot(row: {
  id: string;
  areaKind: string;
  areaId: string;
  categoryId: string | null;
  positions: number;
  floorCents: number;
  status: string;
}): SpotRow {
  return {
    id: row.id,
    areaKind: row.areaKind as AreaKind,
    areaId: row.areaId,
    categoryId: row.categoryId,
    positions: row.positions,
    floorCents: row.floorCents,
    status: row.status as SpotRow["status"],
  };
}

function keyWhere(key: SpotKey) {
  return and(
    eq(featuredSpots.areaKind, key.areaKind),
    eq(featuredSpots.areaId, key.areaId),
    key.categoryId === null
      ? sql`${featuredSpots.categoryId} is null`
      : eq(featuredSpots.categoryId, key.categoryId),
  );
}

export async function findSpot(tx: TestDb, _viewer: Viewer, key: SpotKey): Promise<SpotRow | null> {
  const [row] = await tx.select(spotColumns).from(featuredSpots).where(keyWhere(key)).limit(1);
  return row ? toSpot(row) : null;
}

export async function spotById(tx: TestDb, _viewer: Viewer, spotId: string): Promise<SpotRow | null> {
  if (!UUID.test(spotId)) return null;
  const [row] = await tx.select(spotColumns).from(featuredSpots).where(eq(featuredSpots.id, spotId)).limit(1);
  return row ? toSpot(row) : null;
}

/** Keyed by `spotKeyString`. Keys with no row are simply absent. */
export async function spotsForKeys(
  tx: TestDb,
  _viewer: Viewer,
  keys: readonly SpotKey[],
): Promise<Map<string, SpotRow>> {
  const out = new Map<string, SpotRow>();
  if (keys.length === 0) return out;
  const rows = await tx
    .select(spotColumns)
    .from(featuredSpots)
    .where(or(...keys.map(keyWhere)));
  for (const row of rows) {
    const spot = toSpot(row);
    out.set(spotKeyString(spot), spot);
  }
  return out;
}

/** Floor and capacity come from the config at creation; an admin may later override the row. */
export function floorCentsFor(areaKind: AreaKind): number {
  return Math.round(siteConfig.featured.floors[areaKind] * 100);
}

/**
 * The spot exists from the first bid on it. Created lazily rather than for
 * every city × category on the site: a spot nobody has bid on is a row
 * nobody reads.
 */
export async function ensureSpot(tx: TestDb, viewer: Viewer, key: SpotKey): Promise<SpotRow> {
  assertSignedIn(viewer);
  const existing = await findSpot(tx, viewer, key);
  if (existing !== null) return existing;
  await tx
    .insert(featuredSpots)
    .values({
      areaKind: key.areaKind,
      areaId: key.areaId,
      categoryId: key.categoryId,
      positions: siteConfig.featured.positions,
      floorCents: floorCentsFor(key.areaKind),
    })
    .onConflictDoNothing();
  const created = await findSpot(tx, viewer, key);
  if (created === null) throw new Error("ensureSpot: spot vanished");
  return created;
}

/* ---------------------------------------------------------------- eligibility */

export type IneligibleReason = "not-published" | "not-verified" | "no-subscription";

export interface BiddingListing {
  readonly id: string;
  readonly name: string;
  readonly cityId: string;
  readonly cityName: string;
  readonly citySlug: string;
  readonly cityPath: string;
  readonly region: string | null;
  /** Primary first, then every extra category. */
  readonly categoryIds: readonly string[];
  readonly eligible: boolean;
  readonly reason: IneligibleReason | null;
}

/**
 * The owner's listing and whether it may bid.
 *
 * Null for a listing this profile does not own — the same answer as "does
 * not exist" (constraint 24). Eligibility is the brief's rule: published,
 * Verified, and on a live Essential or Premium plan. It is returned rather
 * than enforced here so the page can say WHY, and re-checked by the engine
 * before any bid is written.
 */
export async function listingForBidding(
  tx: TestDb,
  viewer: Viewer,
  input: { listingId: string; profileId: string },
): Promise<BiddingListing | null> {
  assertSignedIn(viewer);
  if (!UUID.test(input.listingId) || !UUID.test(input.profileId)) return null;

  const [row] = await tx
    .select({
      id: listings.id,
      name: listings.name,
      status: listings.status,
      claimStatus: listings.claimStatus,
      primaryCategoryId: listings.primaryCategoryId,
      cityId: listings.cityId,
      cityName: cities.name,
      citySlug: cities.slug,
      region: cities.region,
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(and(eq(listings.id, input.listingId), eq(listings.ownerId, input.profileId)))
    .limit(1);
  if (!row) return null;

  const extra = await tx
    .select({ categoryId: listingCategories.categoryId })
    .from(listingCategories)
    .where(eq(listingCategories.listingId, row.id));
  const categoryIds = [
    row.primaryCategoryId,
    ...extra.map((c) => c.categoryId).filter((c) => c !== row.primaryCategoryId),
  ];

  const [live] = await tx
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.listingId, row.id),
        inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
        inArray(subscriptions.tier, ["essential", "premium"]),
      ),
    )
    .limit(1);

  const reason: IneligibleReason | null =
    row.status !== "published"
      ? "not-published"
      : row.claimStatus !== "verified"
        ? "not-verified"
        : live === undefined
          ? "no-subscription"
          : null;

  return {
    id: row.id,
    name: row.name,
    cityId: row.cityId,
    cityName: row.cityName,
    citySlug: row.citySlug,
    cityPath: `/${row.citySlug}`,
    region: row.region,
    categoryIds,
    eligible: reason === null,
    reason,
  };
}

export interface CityMatch {
  readonly id: string;
  readonly name: string;
  readonly region: string | null;
}

/** "Other areas": published cities whose name starts with what the owner typed. */
export async function searchCities(tx: TestDb, viewer: Viewer, q: string): Promise<CityMatch[]> {
  assertSignedIn(viewer);
  const needle = q.trim().toLowerCase();
  if (needle.length < 2) return [];
  return tx
    .select({ id: cities.id, name: cities.name, region: cities.region })
    .from(cities)
    .where(and(eq(cities.isPublished, true), sql`lower(${cities.name}) like ${`${needle}%`}`))
    .orderBy(asc(cities.name))
    .limit(12);
}

/* ---------------------------------------------------------------------- bids */

export interface BidRow extends RankableBid {
  readonly pendingAmountCents: number | null;
  readonly position: number | null;
  readonly subscriptionId: string | null;
}

const bidColumns = {
  id: featuredBids.id,
  listingId: featuredBids.listingId,
  amountCents: featuredBids.amountCents,
  pendingAmountCents: featuredBids.pendingAmountCents,
  createdAt: featuredBids.createdAt,
  status: featuredBids.status,
  position: featuredBids.position,
  subscriptionId: featuredBids.subscriptionId,
} as const;

function toBid(row: {
  id: string;
  listingId: string;
  amountCents: number;
  pendingAmountCents: number | null;
  createdAt: Date;
  status: string;
  position: number | null;
  subscriptionId: string | null;
}): BidRow {
  return { ...row, status: row.status as BidStatus };
}

/** Every uncancelled bid on a spot. Amounts are public — the owner page shows the top three. */
export async function spotBids(tx: TestDb, _viewer: Viewer, spotId: string): Promise<BidRow[]> {
  if (!UUID.test(spotId)) return [];
  const rows = await tx
    .select(bidColumns)
    .from(featuredBids)
    .where(and(eq(featuredBids.spotId, spotId), ne(featuredBids.status, "cancelled")))
    .orderBy(asc(featuredBids.createdAt));
  return rows.map(toBid);
}

export interface OwnerBid extends BidRow {
  readonly spotId: string;
}

/** The owner's own uncancelled bids across every spot. */
export async function listingBids(
  tx: TestDb,
  viewer: Viewer,
  input: { listingId: string; profileId: string },
): Promise<OwnerBid[]> {
  assertSignedIn(viewer);
  if (!UUID.test(input.listingId) || !UUID.test(input.profileId)) return [];
  const rows = await tx
    .select({ ...bidColumns, spotId: featuredBids.spotId })
    .from(featuredBids)
    .innerJoin(listings, eq(listings.id, featuredBids.listingId))
    .where(
      and(
        eq(featuredBids.listingId, input.listingId),
        eq(listings.ownerId, input.profileId),
        ne(featuredBids.status, "cancelled"),
      ),
    );
  return rows.map((r) => ({ ...toBid(r), spotId: r.spotId }));
}

export interface InsertBidInput {
  readonly spotId: string;
  readonly listingId: string;
  readonly subscriptionId: string;
  readonly amountCents: number;
  readonly status: "pending" | "active";
  readonly ip: string | null;
}

export async function insertBid(tx: TestDb, viewer: Viewer, input: InsertBidInput): Promise<string> {
  assertSignedIn(viewer);
  const [row] = await tx
    .insert(featuredBids)
    .values({
      spotId: input.spotId,
      listingId: input.listingId,
      subscriptionId: input.subscriptionId,
      amountCents: input.amountCents,
      status: input.status,
    })
    .returning({ id: featuredBids.id });
  const id = row!.id;
  await writeAuditAs(tx, await actorFor(tx, viewer), {
    entityType: "featured_bid",
    action: "spots.bid_placed",
    entityId: id,
    meta: { spotId: input.spotId, listingId: input.listingId, amountCents: input.amountCents, status: input.status },
    ip: input.ip,
  });
  return id;
}

/** A raise: nothing ranks until PayPal confirms the higher quantity. */
export async function setBidPending(
  tx: TestDb,
  viewer: Viewer,
  input: { bidId: string; pendingAmountCents: number; ip: string | null },
): Promise<void> {
  assertSignedIn(viewer);
  await tx
    .update(featuredBids)
    .set({ pendingAmountCents: input.pendingAmountCents, updatedAt: now() })
    .where(eq(featuredBids.id, input.bidId));
  await writeAuditAs(tx, await actorFor(tx, viewer), {
    entityType: "featured_bid",
    action: "spots.bid_raise_requested",
    entityId: input.bidId,
    meta: { pendingAmountCents: input.pendingAmountCents },
    ip: input.ip,
  });
}

/** A lowering: takes effect now. Any pending raise is dropped with it. */
export async function setBidAmount(
  tx: TestDb,
  viewer: Viewer,
  input: { bidId: string; amountCents: number; ip: string | null },
): Promise<void> {
  assertSignedIn(viewer);
  await tx
    .update(featuredBids)
    .set({ amountCents: input.amountCents, pendingAmountCents: null, updatedAt: now() })
    .where(eq(featuredBids.id, input.bidId));
  await writeAuditAs(tx, await actorFor(tx, viewer), {
    entityType: "featured_bid",
    action: "spots.bid_lowered",
    entityId: input.bidId,
    meta: { amountCents: input.amountCents },
    ip: input.ip,
  });
}

export async function cancelBid(
  tx: TestDb,
  viewer: Viewer,
  input: { bidId: string; ip: string | null },
): Promise<void> {
  assertSignedIn(viewer);
  const at = now();
  await tx
    .update(featuredBids)
    .set({ status: "cancelled", position: null, pendingAmountCents: null, cancelledAt: at, updatedAt: at })
    .where(eq(featuredBids.id, input.bidId));
  await writeAuditAs(tx, await actorFor(tx, viewer), {
    entityType: "featured_bid",
    action: "spots.bid_cancelled",
    entityId: input.bidId,
    ip: input.ip,
  });
}

/**
 * The ranking, written back. `rankBids` hands back every confirmed bid with
 * its position; the ones with a position are `active`, the rest `outbid`.
 * Pending bids are not in the list and are untouched.
 */
export async function applyRanking(
  tx: TestDb,
  viewer: Viewer,
  spotId: string,
  ranked: readonly RankedBid[],
): Promise<void> {
  assertWorker(viewer);
  const at = now();
  for (const bid of ranked) {
    await tx
      .update(featuredBids)
      .set({
        position: bid.position,
        status: bid.position === null ? "outbid" : "active",
        updatedAt: at,
      })
      .where(and(eq(featuredBids.id, bid.id), eq(featuredBids.spotId, spotId)));
  }
}

/**
 * PayPal has confirmed this listing's subscription: every pending bid is now
 * a real one and every pending raise is applied. Returns the spots touched,
 * for the re-rank that has to follow.
 */
export async function confirmListingBids(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
): Promise<string[]> {
  assertWorker(viewer);
  const at = now();
  const rows = await tx
    .update(featuredBids)
    .set({
      status: sql`case when ${featuredBids.status} = 'pending' then 'active' else ${featuredBids.status} end`,
      amountCents: sql`coalesce(${featuredBids.pendingAmountCents}, ${featuredBids.amountCents})`,
      pendingAmountCents: null,
      updatedAt: at,
    })
    .where(
      and(
        eq(featuredBids.listingId, listingId),
        or(eq(featuredBids.status, "pending"), isNotNull(featuredBids.pendingAmountCents)),
      ),
    )
    .returning({ spotId: featuredBids.spotId });
  return [...new Set(rows.map((r) => r.spotId))];
}

/** Every uncancelled bid of a listing goes; returns the spots to re-rank. */
export async function cancelListingBids(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
  meta: { reason: string; eventId?: string },
): Promise<string[]> {
  assertWorker(viewer);
  const at = now();
  const rows = await tx
    .update(featuredBids)
    .set({ status: "cancelled", position: null, pendingAmountCents: null, cancelledAt: at, updatedAt: at })
    .where(and(eq(featuredBids.listingId, listingId), ne(featuredBids.status, "cancelled")))
    .returning({ id: featuredBids.id, spotId: featuredBids.spotId });
  for (const row of rows) {
    await writeAuditAs(tx, null, {
      entityType: "featured_bid",
      action: "spots.bid_cancelled",
      entityId: row.id,
      meta: { listingId, ...meta },
    });
  }
  return [...new Set(rows.map((r) => r.spotId))];
}

/** What `quantityFor` needs: the listing's uncancelled bids with their standing. */
export async function chargeableBidsForListing(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
): Promise<ChargeableBid[]> {
  assertWorker(viewer);
  const rows = await tx
    .select({ amountCents: featuredBids.amountCents, status: featuredBids.status, position: featuredBids.position })
    .from(featuredBids)
    .where(and(eq(featuredBids.listingId, listingId), ne(featuredBids.status, "cancelled")))
    .orderBy(asc(featuredBids.createdAt));
  return rows.map((r) => ({ amountCents: r.amountCents, status: r.status as BidStatus, position: r.position }));
}

/** Every listing with an uncancelled bid in any of these spots. */
export async function listingsInSpots(
  tx: TestDb,
  viewer: Viewer,
  spotIds: readonly string[],
): Promise<string[]> {
  assertWorker(viewer);
  if (spotIds.length === 0) return [];
  const rows = await tx
    .selectDistinct({ listingId: featuredBids.listingId })
    .from(featuredBids)
    .where(and(inArray(featuredBids.spotId, [...spotIds]), ne(featuredBids.status, "cancelled")));
  return rows.map((r) => r.listingId);
}

/* -------------------------------------------------------------- subscriptions */

export type FeaturedSubscriptionStatus =
  | "approval_pending"
  | "active"
  | "past_due"
  | "cancelled"
  | "suspended"
  | "expired";

export interface FeaturedSubscription {
  readonly id: string;
  readonly listingId: string;
  readonly profileId: string | null;
  readonly providerSubscriptionId: string | null;
  readonly providerPlanId: string | null;
  readonly status: FeaturedSubscriptionStatus;
  readonly quantity: number;
  readonly requestedQuantity: number;
  readonly reviseRequestedAt: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly createdAt: Date;
}

const subColumns = {
  id: featuredSubscriptions.id,
  listingId: featuredSubscriptions.listingId,
  profileId: featuredSubscriptions.userId,
  providerSubscriptionId: featuredSubscriptions.providerSubscriptionId,
  providerPlanId: featuredSubscriptions.providerPlanId,
  status: featuredSubscriptions.status,
  quantity: featuredSubscriptions.quantity,
  requestedQuantity: featuredSubscriptions.requestedQuantity,
  reviseRequestedAt: featuredSubscriptions.reviseRequestedAt,
  currentPeriodEnd: featuredSubscriptions.currentPeriodEnd,
  createdAt: featuredSubscriptions.createdAt,
} as const;

function toSub(row: Omit<FeaturedSubscription, "status"> & { status: string }): FeaturedSubscription {
  return { ...row, status: row.status as FeaturedSubscriptionStatus };
}

/** The one live featured subscription of a listing, if any. Worker or owner (through the listing). */
export async function currentFeaturedSubscription(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
  profileId?: string,
): Promise<FeaturedSubscription | null> {
  assertSignedIn(viewer);
  if (!UUID.test(listingId)) return null;
  const ownerGate =
    isAdmin(viewer)
      ? sql`true`
      : profileId !== undefined && UUID.test(profileId)
        ? eq(listings.ownerId, profileId)
        : sql`false`;
  const [row] = await tx
    .select(subColumns)
    .from(featuredSubscriptions)
    .innerJoin(listings, eq(listings.id, featuredSubscriptions.listingId))
    .where(
      and(
        eq(featuredSubscriptions.listingId, listingId),
        inArray(featuredSubscriptions.status, [...LIVE_FEATURED_STATUSES]),
        ownerGate,
      ),
    )
    .orderBy(sql`${featuredSubscriptions.createdAt} desc`)
    .limit(1);
  return row ? toSub(row) : null;
}

export async function createFeaturedSubscription(
  tx: TestDb,
  viewer: Viewer,
  input: { listingId: string; profileId: string; planId: string; quantity: number; ip: string | null },
): Promise<string> {
  assertSignedIn(viewer);
  const [row] = await tx
    .insert(featuredSubscriptions)
    .values({
      listingId: input.listingId,
      userId: input.profileId,
      provider: FEATURED_PROVIDER,
      providerPlanId: input.planId,
      status: "approval_pending",
      quantity: 0,
      requestedQuantity: input.quantity,
    })
    .returning({ id: featuredSubscriptions.id });
  const id = row!.id;
  await writeAuditAs(tx, input.profileId, {
    entityType: "featured_subscription",
    action: "spots.checkout_started",
    entityId: id,
    meta: { listingId: input.listingId, quantity: input.quantity },
    ip: input.ip,
  });
  return id;
}

export async function attachFeaturedProvider(
  tx: TestDb,
  viewer: Viewer,
  id: string,
  providerSubscriptionId: string,
): Promise<void> {
  assertSignedIn(viewer);
  await tx
    .update(featuredSubscriptions)
    .set({ providerSubscriptionId, updatedAt: now() })
    .where(eq(featuredSubscriptions.id, id));
}

export interface FeaturedSubscriptionPatch {
  readonly status?: FeaturedSubscriptionStatus;
  readonly quantity?: number;
  readonly requestedQuantity?: number;
  readonly reviseRequestedAt?: Date | null;
  readonly currentPeriodEnd?: Date | null;
}

export async function updateFeaturedSubscription(
  tx: TestDb,
  viewer: Viewer,
  id: string,
  patch: FeaturedSubscriptionPatch,
  audit: { action: string; meta?: Record<string, unknown>; actorId?: string | null; ip?: string | null },
): Promise<void> {
  assertSignedIn(viewer);
  await tx
    .update(featuredSubscriptions)
    .set({ ...patch, updatedAt: now() })
    .where(eq(featuredSubscriptions.id, id));
  await writeAuditAs(tx, audit.actorId ?? null, {
    entityType: "featured_subscription",
    action: audit.action,
    entityId: id,
    meta: { ...patch, ...(audit.meta ?? {}) },
    ip: audit.ip ?? null,
  });
}

/** The webhook's lookup: PayPal's id first, our own id (custom_id) second. */
export async function featuredSubscriptionForEvent(
  tx: TestDb,
  viewer: Viewer,
  input: { providerSubscriptionId: string | null; customId: string | null },
): Promise<FeaturedSubscription | null> {
  assertWorker(viewer);
  const where =
    input.providerSubscriptionId !== null
      ? eq(featuredSubscriptions.providerSubscriptionId, input.providerSubscriptionId)
      : input.customId !== null && UUID.test(input.customId)
        ? eq(featuredSubscriptions.id, input.customId)
        : null;
  if (where === null) return null;
  const [row] = await tx.select(subColumns).from(featuredSubscriptions).where(where).limit(1);
  return row ? toSub(row) : null;
}

/** The owner's own subscription by PayPal's id — the return page's gate. */
export async function featuredSubscriptionForOwnerByProviderId(
  tx: TestDb,
  viewer: Viewer,
  input: { providerSubscriptionId: string; profileId: string },
): Promise<FeaturedSubscription | null> {
  assertSignedIn(viewer);
  if (!UUID.test(input.profileId)) return null;
  const [row] = await tx
    .select(subColumns)
    .from(featuredSubscriptions)
    .innerJoin(listings, eq(listings.id, featuredSubscriptions.listingId))
    .where(
      and(
        eq(featuredSubscriptions.providerSubscriptionId, input.providerSubscriptionId),
        eq(listings.ownerId, input.profileId),
      ),
    )
    .limit(1);
  return row ? toSub(row) : null;
}

/**
 * What the hourly sync looks at: a live row whose confirmed quantity does not
 * match what its bids require, whose paid period ran out past the grace, or
 * that has sat unapproved for a day.
 */
export async function featuredSubscriptionsForSync(
  tx: TestDb,
  viewer: Viewer,
  opts: { graceDays: number; pendingHours: number; limit: number },
): Promise<FeaturedSubscription[]> {
  assertWorker(viewer);
  const at = now();
  const lapsedBefore = new Date(at.getTime() - opts.graceDays * 86_400_000);
  const pendingBefore = new Date(at.getTime() - opts.pendingHours * 3_600_000);
  const rows = await tx
    .select(subColumns)
    .from(featuredSubscriptions)
    .where(
      and(
        isNotNull(featuredSubscriptions.providerSubscriptionId),
        or(
          and(
            inArray(featuredSubscriptions.status, ["active", "past_due"]),
            or(
              ne(featuredSubscriptions.quantity, featuredSubscriptions.requestedQuantity),
              lt(featuredSubscriptions.currentPeriodEnd, lapsedBefore),
            ),
          ),
          and(
            eq(featuredSubscriptions.status, "approval_pending"),
            lt(featuredSubscriptions.createdAt, pendingBefore),
          ),
        ),
      ),
    )
    .orderBy(asc(featuredSubscriptions.updatedAt))
    .limit(opts.limit);
  return rows.map(toSub);
}

/* ------------------------------------------------------------------ rendering */

export interface FeaturedListing extends PublicListing {
  readonly position: number;
}

/**
 * The featured row of a pillar page: the spot's active, positioned bids in
 * position order, joined through `publishedListings` so an archived listing
 * that still holds a position is not shown. Nothing here re-ranks — the
 * position column is what the engine wrote.
 */
export async function featuredForScope(
  tx: TestDb,
  viewer: Viewer,
  scope: PillarScope,
): Promise<FeaturedListing[]> {
  let key: SpotKey;
  switch (scope.type) {
    case "city":
      key = citySpotKey(scope.cityId, null);
      break;
    case "city-category":
      key = citySpotKey(scope.cityId, scope.categoryId);
      break;
    default:
      return [];
  }
  const rows = await tx
    .select({ ...publicListingColumns, position: featuredBids.position })
    .from(featuredBids)
    .innerJoin(featuredSpots, eq(featuredSpots.id, featuredBids.spotId))
    .innerJoin(listings, eq(listings.id, featuredBids.listingId))
    .where(
      and(
        keyWhere(key),
        eq(featuredSpots.status, "open"),
        eq(featuredBids.status, "active"),
        isNotNull(featuredBids.position),
        publishedListings(viewer),
      ),
    )
    .orderBy(asc(featuredBids.position));
  return rows.map((r) => ({ ...r, position: r.position as number }));
}

/**
 * The ISR pages a spot's ranking appears on. A city spot is the city pillar;
 * a city × category spot is that category's pillar inside the city (when the
 * category is routed there); a region spot is the region page.
 */
export async function spotPaths(tx: TestDb, viewer: Viewer, spotId: string): Promise<string[]> {
  const spot = await spotById(tx, viewer, spotId);
  if (spot === null) return [];
  if (spot.areaKind === "region") return [`/areas/${spot.areaId}`];

  const [city] = await tx.select({ slug: cities.slug }).from(cities).where(eq(cities.id, spot.areaId)).limit(1);
  if (!city) return [];
  if (spot.categoryId === null) return [`/${city.slug}`];

  const [cat] = await tx
    .select({ slug: slugs.slug })
    .from(slugs)
    .where(
      and(eq(slugs.parentScope, spot.areaId), eq(slugs.kind, "category"), eq(slugs.entityId, spot.categoryId)),
    )
    .limit(1);
  return cat ? [`/${city.slug}/${cat.slug}`] : [];
}

/* -------------------------------------------------------------------- helpers */

/** The owner's profile for the audit row; the system viewer records nobody. */
async function actorFor(tx: TestDb, viewer: Viewer): Promise<string | null> {
  if (viewer.role === "public" || isAdmin(viewer)) return null;
  return (await ensureProfile(tx, viewer)).id;
}

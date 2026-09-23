import { and, asc, desc, eq, gte, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { siteConfig } from "@/config/site.config";
import {
  auditLog,
  categories,
  cities,
  featuredBids,
  featuredClicksDaily,
  featuredSpots,
  featuredSubscriptions,
  listingCategories,
  listings,
  profiles,
  slugs,
  subscriptions,
  unsubscribes,
  user,
} from "@/lib/db/schema";
import { now } from "@/lib/clock";
import { ensureProfile } from "@/lib/auth/profile";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";
import type { PillarScope } from "@/lib/routing/scope";
import { slugify } from "@/lib/routing/slugify";
import type { BidStatus, ChargeableBid, RankableBid, RankedBid } from "@/lib/spots/rank";
import type { FeaturedClickDelta } from "@/lib/spots/clicks";
import { dayKey, isDayKey } from "@/lib/stats/keys";
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
export const LIVE_FEATURED_STATUSES = ["approval_pending", "active", "past_due", "paused"] as const;

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
  const needle = q.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
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
  readonly createdAt: Date;
  readonly pendingAmountCents: number | null;
  readonly position: number | null;
  readonly subscriptionId: string | null;
}

const bidColumns = {
  id: featuredBids.id,
  listingId: featuredBids.listingId,
  amountCents: featuredBids.amountCents,
  amountSetAt: featuredBids.amountSetAt,
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
  amountSetAt: Date;
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
      // Through lib/clock: the tie-break and the expiry are both provable.
      createdAt: now(),
      amountSetAt: now(),
      updatedAt: now(),
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
    .set({ amountCents: input.amountCents, amountSetAt: now(), pendingAmountCents: null, updatedAt: now() })
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
      // A confirmed raise is a NEW amount: it queues behind everyone who
      // already held that amount (I1).
      amountSetAt: sql`case when ${featuredBids.pendingAmountCents} is null then ${featuredBids.amountSetAt} else ${at.toISOString()}::timestamptz end`,
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
  | "paused"
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
  readonly pausedAt: Date | null;
  readonly approveUrl: string | null;
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
  pausedAt: featuredSubscriptions.pausedAt,
  approveUrl: featuredSubscriptions.approveUrl,
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
      // Through lib/clock, so the sync's "unapproved for a day" is provable.
      createdAt: now(),
      updatedAt: now(),
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
  provider: { providerSubscriptionId: string; approveUrl: string | null },
): Promise<void> {
  assertSignedIn(viewer);
  await tx
    .update(featuredSubscriptions)
    .set({ ...provider, updatedAt: now() })
    .where(eq(featuredSubscriptions.id, id));
}

export interface FeaturedSubscriptionPatch {
  readonly status?: FeaturedSubscriptionStatus;
  readonly quantity?: number;
  readonly requestedQuantity?: number;
  readonly reviseRequestedAt?: Date | null;
  readonly pausedAt?: Date | null;
  readonly approveUrl?: string | null;
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
  opts: { graceDays: number; pendingHours: number; pausedDays: number; limit: number },
): Promise<FeaturedSubscription[]> {
  assertWorker(viewer);
  const at = now();
  const lapsedBefore = new Date(at.getTime() - opts.graceDays * 86_400_000);
  const pendingBefore = new Date(at.getTime() - opts.pendingHours * 3_600_000);
  const pausedBefore = new Date(at.getTime() - opts.pausedDays * 86_400_000);
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
              // An unapproved revise (a raise, a second-spot bid, a decrease).
              lt(featuredSubscriptions.reviseRequestedAt, pendingBefore),
            ),
          ),
          and(
            eq(featuredSubscriptions.status, "approval_pending"),
            lt(featuredSubscriptions.createdAt, pendingBefore),
          ),
          // Paused for a whole cycle: nothing featured for a month.
          and(eq(featuredSubscriptions.status, "paused"), lt(featuredSubscriptions.pausedAt, pausedBefore)),
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
  /** The listing's OWN city — a listing featured on another town's page still links home. */
  readonly citySlug: string;
  /** The spot the position is in: the click beacon and the leaderboard link name it (Task 45). */
  readonly spotId: string;
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
  switch (scope.type) {
    case "city":
      return featuredForSpotKey(tx, viewer, citySpotKey(scope.cityId, null));
    case "city-category":
      return featuredForSpotKey(tx, viewer, citySpotKey(scope.cityId, scope.categoryId));
    default:
      return [];
  }
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

/* ------------------------------------------------------- appended: bidding */

/** Whether a spot's area is real: a published city, or a region some city is in. */
export async function spotAreaExists(tx: TestDb, _viewer: Viewer, key: SpotKey): Promise<boolean> {
  if (key.areaKind === "city") {
    if (!UUID.test(key.areaId)) return false;
    const [row] = await tx
      .select({ id: cities.id })
      .from(cities)
      .where(and(eq(cities.id, key.areaId), eq(cities.isPublished, true)))
      .limit(1);
    return row !== undefined;
  }
  const rows = await tx
    .selectDistinct({ region: cities.region })
    .from(cities)
    .where(and(isNotNull(cities.region), eq(cities.isPublished, true)));
  return rows.some((r) => r.region !== null && slugify(r.region) === key.areaId);
}

/** A raise or a first bid the buyer has not yet approved at PayPal. */
export async function hasPendingBids(tx: TestDb, viewer: Viewer, listingId: string): Promise<boolean> {
  assertWorker(viewer);
  const [row] = await tx
    .select({ id: featuredBids.id })
    .from(featuredBids)
    .where(
      and(
        eq(featuredBids.listingId, listingId),
        or(eq(featuredBids.status, "pending"), isNotNull(featuredBids.pendingAmountCents)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export interface SpotArea {
  readonly key: SpotKey;
  readonly areaName: string;
  readonly categoryName: string | null;
}

/**
 * Names for the owner's table: the city or region, and the category. Every
 * key is answered — an unknown id gets its raw key back rather than a hole
 * in the table.
 */
export async function describeSpotKeys(
  tx: TestDb,
  _viewer: Viewer,
  keys: readonly SpotKey[],
): Promise<SpotArea[]> {
  const cityIds = [...new Set(keys.filter((k) => k.areaKind === "city").map((k) => k.areaId))].filter((id) =>
    UUID.test(id),
  );
  const categoryIds = [...new Set(keys.map((k) => k.categoryId).filter((c): c is string => c !== null))];
  const cityRows =
    cityIds.length === 0
      ? []
      : await tx.select({ id: cities.id, name: cities.name }).from(cities).where(inArray(cities.id, cityIds));
  const catRows =
    categoryIds.length === 0
      ? []
      : await tx
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(inArray(categories.id, categoryIds));
  const regionRows = await tx
    .selectDistinct({ region: cities.region })
    .from(cities)
    .where(isNotNull(cities.region));
  const cityName = new Map(cityRows.map((c) => [c.id, c.name]));
  const catName = new Map(catRows.map((c) => [c.id, c.name]));
  const regionName = new Map(
    regionRows.filter((r): r is { region: string } => r.region !== null).map((r) => [slugify(r.region), r.region]),
  );
  return keys.map((key) => ({
    key,
    areaName:
      key.areaKind === "city" ? (cityName.get(key.areaId) ?? key.areaId) : (regionName.get(key.areaId) ?? key.areaId),
    categoryName: key.categoryId === null ? null : (catName.get(key.categoryId) ?? null),
  }));
}

/** The listing's uncancelled bids, for the system (no owner in the loop). */
export async function listingBidsForSystem(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
): Promise<OwnerBid[]> {
  assertWorker(viewer);
  const rows = await tx
    .select({ ...bidColumns, spotId: featuredBids.spotId })
    .from(featuredBids)
    .where(and(eq(featuredBids.listingId, listingId), ne(featuredBids.status, "cancelled")));
  return rows.map((r) => ({ ...toBid(r), spotId: r.spotId }));
}

/* ------------------------------------------------ appended: re-review fixes */

/**
 * Row lock on the listing for the length of a bid transaction (I8). Two
 * first bids on two spots serialise here, so the second sees the first's
 * subscription instead of creating a second one; the partial unique index
 * `featured_subscriptions_live_key` is the backstop.
 */
export async function lockListing(tx: TestDb, viewer: Viewer, listingId: string): Promise<void> {
  assertSignedIn(viewer);
  if (!UUID.test(listingId)) return;
  await tx.execute(sql`select id from ${listings} where ${listings.id} = ${listingId} for update`);
}

/** "Cancel my raise": the pending amount goes, the current bid stands. */
export async function clearPendingRaise(
  tx: TestDb,
  viewer: Viewer,
  input: { bidId: string; ip: string | null },
): Promise<void> {
  assertSignedIn(viewer);
  await tx
    .update(featuredBids)
    .set({ pendingAmountCents: null, updatedAt: now() })
    .where(eq(featuredBids.id, input.bidId));
  await writeAuditAs(tx, await actorFor(tx, viewer), {
    entityType: "featured_bid",
    action: "spots.raise_withdrawn",
    entityId: input.bidId,
    ip: input.ip,
  });
}

export const RAISE_EXPIRED_ACTION = "spots.raise_expired";

/**
 * An unapproved raise or pending bid has waited long enough (I6): pending
 * bids are cancelled, pending raises dropped. One audit row per bid, so the
 * owner page can say what happened. Returns the spots touched.
 */
export async function expirePendingBids(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
  meta: { reason: string },
): Promise<string[]> {
  assertWorker(viewer);
  const at = now();
  const dropped = await tx
    .update(featuredBids)
    .set({ pendingAmountCents: null, updatedAt: at })
    .where(and(eq(featuredBids.listingId, listingId), isNotNull(featuredBids.pendingAmountCents)))
    .returning({ id: featuredBids.id, spotId: featuredBids.spotId, amountCents: featuredBids.amountCents });
  const cancelled = await tx
    .update(featuredBids)
    .set({ status: "cancelled", position: null, cancelledAt: at, updatedAt: at })
    .where(and(eq(featuredBids.listingId, listingId), eq(featuredBids.status, "pending")))
    .returning({ id: featuredBids.id, spotId: featuredBids.spotId, amountCents: featuredBids.amountCents });
  for (const row of [...dropped, ...cancelled]) {
    await writeAuditAs(tx, null, {
      entityType: "featured_bid",
      action: RAISE_EXPIRED_ACTION,
      entityId: row.id,
      meta: { listingId, spotId: row.spotId, ...meta },
    });
  }
  return [...new Set([...dropped, ...cancelled].map((r) => r.spotId))];
}

/** Whether an expiry happened recently, so the owner page can say so. Owner-gated. */
export async function recentRaiseExpiry(
  tx: TestDb,
  viewer: Viewer,
  input: { listingId: string; profileId: string; withinDays: number },
): Promise<Date | null> {
  assertSignedIn(viewer);
  if (!UUID.test(input.listingId) || !UUID.test(input.profileId)) return null;
  const since = new Date(now().getTime() - input.withinDays * 86_400_000);
  const [row] = await tx
    .select({ at: auditLog.createdAt })
    .from(auditLog)
    .innerJoin(listings, eq(listings.id, sql`(${auditLog.meta}->>'listingId')::uuid`))
    .where(
      and(
        eq(auditLog.action, RAISE_EXPIRED_ACTION),
        eq(listings.id, input.listingId),
        eq(listings.ownerId, input.profileId),
        gte(auditLog.createdAt, since),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return row?.at ?? null;
}

/* -------------------------------------------------- appended: Task 45 notify */

/**
 * Claims the right to email the owner about this bid: true when the bid has
 * not been notified within the window, in which case the mark is set to now.
 * One UPDATE, so two re-ranks in one instant cannot both claim it.
 */
export async function markOutbidNotified(
  tx: TestDb,
  viewer: Viewer,
  bidId: string,
  windowMs: number,
): Promise<boolean> {
  assertWorker(viewer);
  const at = now();
  const since = new Date(at.getTime() - windowMs);
  const rows = await tx
    .update(featuredBids)
    .set({ outbidNotifiedAt: at, updatedAt: at })
    .where(
      and(
        eq(featuredBids.id, bidId),
        or(sql`${featuredBids.outbidNotifiedAt} is null`, lt(featuredBids.outbidNotifiedAt, since)),
      ),
    )
    .returning({ id: featuredBids.id });
  return rows.length > 0;
}

export interface OutbidNotification {
  readonly bidId: string;
  readonly listingId: string;
  readonly listingName: string;
  readonly ownerEmail: string | null;
  readonly status: BidStatus;
  readonly position: number | null;
  readonly amountCents: number;
  readonly spot: SpotRow;
  readonly spotKey: SpotKey;
  readonly areaName: string;
  readonly categoryName: string | null;
  /** The OTHER listings' featured amounts, highest first — what the minimums derive from. */
  readonly featuredOthers: number[];
}

/**
 * Everything the outbid email needs, re-read at send time: the bid as it
 * stands now, the owner's account address, and the spot's standing.
 */
export async function outbidNotification(
  tx: TestDb,
  viewer: Viewer,
  bidId: string,
): Promise<OutbidNotification | null> {
  assertWorker(viewer);
  if (!UUID.test(bidId)) return null;
  const [row] = await tx
    .select({
      bidId: featuredBids.id,
      spotId: featuredBids.spotId,
      listingId: featuredBids.listingId,
      listingName: listings.name,
      ownerEmail: user.email,
      status: featuredBids.status,
      position: featuredBids.position,
      amountCents: featuredBids.amountCents,
    })
    .from(featuredBids)
    .innerJoin(listings, eq(listings.id, featuredBids.listingId))
    .leftJoin(profiles, eq(profiles.id, listings.ownerId))
    .leftJoin(user, eq(user.id, profiles.userId))
    .where(eq(featuredBids.id, bidId))
    .limit(1);
  if (!row) return null;
  const spot = await spotById(tx, viewer, row.spotId);
  if (spot === null) return null;
  const key: SpotKey = { areaKind: spot.areaKind, areaId: spot.areaId, categoryId: spot.categoryId };
  const [area] = await describeSpotKeys(tx, viewer, [key]);
  const bids = await spotBids(tx, viewer, spot.id);
  return {
    bidId: row.bidId,
    listingId: row.listingId,
    listingName: row.listingName,
    ownerEmail: row.ownerEmail?.trim() ? row.ownerEmail : null,
    status: row.status as BidStatus,
    position: row.position,
    amountCents: row.amountCents,
    spot,
    spotKey: key,
    areaName: area?.areaName ?? spot.areaId,
    categoryName: area?.categoryName ?? null,
    featuredOthers: bids
      .filter((b) => b.listingId !== row.listingId && b.status === "active" && b.position !== null)
      .map((b) => b.amountCents)
      .sort((a, b) => b - a),
  };
}

/* --------------------------------------------- appended: Task 45 availability */

export interface SystemListing extends BiddingListing {
  readonly ownerEmail: string | null;
}

/**
 * `listingForBidding` for the system: no owner in the loop, the owner's
 * account address alongside. Same eligibility rule, so the digest writes
 * only to listings that could actually bid.
 */
export async function listingForSystem(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
): Promise<SystemListing | null> {
  assertWorker(viewer);
  if (!UUID.test(listingId)) return null;
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
      ownerEmail: user.email,
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .leftJoin(profiles, eq(profiles.id, listings.ownerId))
    .leftJoin(user, eq(user.id, profiles.userId))
    .where(eq(listings.id, listingId))
    .limit(1);
  if (!row) return null;
  const extra = await tx
    .select({ categoryId: listingCategories.categoryId })
    .from(listingCategories)
    .where(eq(listingCategories.listingId, row.id));
  const categoryIds = [row.primaryCategoryId, ...extra.map((c) => c.categoryId).filter((c) => c !== row.primaryCategoryId)];
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
    row.status !== "published" ? "not-published" : row.claimStatus !== "verified" ? "not-verified" : live === undefined ? "no-subscription" : null;
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
    ownerEmail: row.ownerEmail?.trim() ? row.ownerEmail : null,
  };
}

/** Every listing the digest may write to: published, Verified, on a live paid plan, with an owner address. */
export async function eligibleListingIds(tx: TestDb, viewer: Viewer): Promise<string[]> {
  assertWorker(viewer);
  const rows = await tx
    .selectDistinct({ id: listings.id })
    .from(listings)
    .innerJoin(profiles, eq(profiles.id, listings.ownerId))
    .innerJoin(user, eq(user.id, profiles.userId))
    .innerJoin(subscriptions, eq(subscriptions.listingId, listings.id))
    .where(
      and(
        eq(listings.status, "published"),
        eq(listings.claimStatus, "verified"),
        inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
        inArray(subscriptions.tier, ["essential", "premium"]),
        sql`nullif(trim(${user.email}), '') is not null`,
      ),
    )
    .orderBy(asc(listings.id));
  return rows.map((r) => r.id);
}

/** Whether this address has opted out of marketing mail (`unsubscribes`). */
export async function isUnsubscribed(tx: TestDb, viewer: Viewer, email: string): Promise<boolean> {
  assertWorker(viewer);
  const [row] = await tx
    .select({ id: unsubscribes.id })
    .from(unsubscribes)
    .where(eq(unsubscribes.addressNormalised, email.trim().toLowerCase()))
    .limit(1);
  return row !== undefined;
}

/** Every spot row there is, for the admin table. */
export async function allSpots(tx: TestDb, viewer: Viewer): Promise<SpotRow[]> {
  assertWorker(viewer);
  const rows = await tx.select(spotColumns).from(featuredSpots).orderBy(asc(featuredSpots.areaKind), asc(featuredSpots.areaId));
  return rows.map(toSpot);
}

export interface SpotFill {
  readonly filled: number;
  readonly topCents: number | null;
}

/** Per spot: how many positions are held and the highest featured amount. */
export async function spotFills(tx: TestDb, viewer: Viewer): Promise<Map<string, SpotFill>> {
  assertWorker(viewer);
  const rows = await tx
    .select({
      spotId: featuredBids.spotId,
      filled: sql<number>`count(*)::int`,
      topCents: sql<number | null>`max(${featuredBids.amountCents})::int`,
    })
    .from(featuredBids)
    .where(and(eq(featuredBids.status, "active"), isNotNull(featuredBids.position)))
    .groupBy(featuredBids.spotId);
  return new Map(rows.map((r) => [r.spotId, { filled: r.filled, topCents: r.topCents }]));
}

export interface PublishedCityArea {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly region: string | null;
}

/** Published cities with their region — the areas an empty spot can be virtual for. */
export async function publishedCityAreas(tx: TestDb, viewer: Viewer): Promise<PublishedCityArea[]> {
  assertWorker(viewer);
  return tx
    .select({ id: cities.id, name: cities.name, slug: cities.slug, region: cities.region })
    .from(cities)
    .where(eq(cities.isPublished, true))
    .orderBy(asc(cities.name));
}

/** Whether the monthly digest has already been queued for this `YYYY-MM` (its audit mark). */
export async function digestSentForMonth(tx: TestDb, viewer: Viewer, month: string): Promise<boolean> {
  assertWorker(viewer);
  const [row] = await tx
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.action, "spots.digest_sent"), sql`${auditLog.meta}->>'month' = ${month}`))
    .limit(1);
  return row !== undefined;
}

/* ---------------------------------------------- appended: Task 45 clicks */

/** Additive upsert; a delta for a spot or listing that is gone is dropped, not fatal. */
export async function applyFeaturedClickDeltas(
  tx: TestDb,
  viewer: Viewer,
  deltas: readonly FeaturedClickDelta[],
): Promise<number> {
  assertWorker(viewer);
  const valid = deltas.filter((d) => UUID.test(d.spotId) && UUID.test(d.listingId) && isDayKey(d.day) && d.clicks > 0);
  if (valid.length === 0) return 0;
  const rows = sql.join(
    valid.map((d) => sql`(${d.spotId}::uuid, ${d.listingId}::uuid, ${d.day}::date, ${Math.trunc(d.clicks)}::int)`),
    sql`, `,
  );
  const written = (await tx.execute(sql`
    insert into featured_clicks_daily (spot_id, listing_id, day, clicks)
    select v.spot_id, v.listing_id, v.day, v.clicks
      from (values ${rows}) as v(spot_id, listing_id, day, clicks)
      join featured_spots s on s.id = v.spot_id
      join listings l on l.id = v.listing_id
    on conflict (spot_id, listing_id, day) do update set
      clicks     = featured_clicks_daily.clicks + excluded.clicks,
      updated_at = now()
    returning featured_clicks_daily.id
  `)) as unknown as unknown[];
  return written.length;
}

/**
 * The owner's featured clicks per spot over the last `days` days. Scoped by
 * the listing's owner (constraint 24): somebody else's listing reads as an
 * empty map.
 */
export async function featuredClicksForListing(
  tx: TestDb,
  viewer: Viewer,
  input: { listingId: string; profileId: string; days: number },
  at: Date = now(),
): Promise<Map<string, number>> {
  assertSignedIn(viewer);
  if (!UUID.test(input.listingId) || !UUID.test(input.profileId)) return new Map();
  const since = new Date(at.getTime() - input.days * 24 * 60 * 60 * 1000);
  const rows = await tx
    .select({ spotId: featuredClicksDaily.spotId, clicks: sql<number>`sum(${featuredClicksDaily.clicks})::int` })
    .from(featuredClicksDaily)
    .innerJoin(listings, eq(listings.id, featuredClicksDaily.listingId))
    .where(
      and(
        eq(featuredClicksDaily.listingId, input.listingId),
        eq(listings.ownerId, input.profileId),
        gte(featuredClicksDaily.day, dayKey(since)),
      ),
    )
    .groupBy(featuredClicksDaily.spotId);
  return new Map(rows.map((r) => [r.spotId, r.clicks]));
}

/* ------------------------------------------ appended: Task 45 leaderboard */

/** The featured row for any spot key — the region page's mount and the leaderboard share it. */
export async function featuredForSpotKey(
  tx: TestDb,
  viewer: Viewer,
  key: SpotKey,
): Promise<FeaturedListing[]> {
  const rows = await tx
    .select({ ...publicListingColumns, position: featuredBids.position, citySlug: cities.slug, spotId: featuredSpots.id })
    .from(featuredBids)
    .innerJoin(featuredSpots, eq(featuredSpots.id, featuredBids.spotId))
    .innerJoin(listings, eq(listings.id, featuredBids.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
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

export interface LeaderboardEntry {
  readonly position: number;
  readonly name: string;
  readonly slug: string;
  readonly citySlug: string;
}

export interface SpotLeaderboard {
  readonly spot: SpotRow;
  readonly areaName: string;
  readonly categoryName: string | null;
  /** The public page the spot sits on, when it can be named. */
  readonly path: string | null;
  /** Position order; published listings only; NO amounts. */
  readonly featured: LeaderboardEntry[];
}

/**
 * The public leaderboard: positions and names, nothing about money. A
 * closed spot still answers (the page says it is closed); a spot that does
 * not exist is null.
 */
export async function spotLeaderboard(
  tx: TestDb,
  viewer: Viewer,
  spotId: string,
): Promise<SpotLeaderboard | null> {
  const spot = await spotById(tx, viewer, spotId);
  if (spot === null) return null;
  const key: SpotKey = { areaKind: spot.areaKind, areaId: spot.areaId, categoryId: spot.categoryId };
  const [area] = await describeSpotKeys(tx, viewer, [key]);
  const rows = await tx
    .select({ position: featuredBids.position, name: listings.name, slug: listings.slug, citySlug: cities.slug })
    .from(featuredBids)
    .innerJoin(listings, eq(listings.id, featuredBids.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(
      and(
        eq(featuredBids.spotId, spot.id),
        eq(featuredBids.status, "active"),
        isNotNull(featuredBids.position),
        publishedListings(viewer),
      ),
    )
    .orderBy(asc(featuredBids.position));
  return {
    spot,
    areaName: area?.areaName ?? spot.areaId,
    categoryName: area?.categoryName ?? null,
    path: (await spotPaths(tx, viewer, spot.id))[0] ?? null,
    featured: rows.map((r) => ({ position: r.position as number, name: r.name, slug: r.slug, citySlug: r.citySlug })),
  };
}

/* ----------------------------------------------- appended: Task 45 upsell */

export interface UpsellCandidate {
  readonly listingId: string;
  readonly listingName: string;
  /** The cheapest bid that would take a position now, in minor units. */
  readonly fromCents: number;
}

/**
 * The signed-in owner's listing that belongs on this page but is not
 * featured on it: the first of the viewer's eligible listings in the area
 * (and category, for a category spot) with no active positioned bid on the
 * spot. Null for anybody with nothing to be upsold — which is what the
 * public strip renders as nothing.
 */
export async function upsellCandidate(
  tx: TestDb,
  viewer: Viewer,
  profileId: string,
  key: SpotKey,
): Promise<UpsellCandidate | null> {
  assertSignedIn(viewer);
  if (!UUID.test(profileId)) return null;
  const rows = await tx
    .select({
      id: listings.id,
      name: listings.name,
      cityId: listings.cityId,
      region: cities.region,
      primaryCategoryId: listings.primaryCategoryId,
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .innerJoin(subscriptions, eq(subscriptions.listingId, listings.id))
    .where(
      and(
        eq(listings.ownerId, profileId),
        eq(listings.status, "published"),
        eq(listings.claimStatus, "verified"),
        inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
        inArray(subscriptions.tier, ["essential", "premium"]),
      ),
    )
    .orderBy(asc(listings.createdAt));
  const inArea = rows.filter((r) =>
    key.areaKind === "city" ? r.cityId === key.areaId : r.region !== null && slugify(r.region) === key.areaId,
  );
  if (inArea.length === 0) return null;
  const spot = await findSpot(tx, viewer, key);
  const bids = spot === null ? [] : await spotBids(tx, viewer, spot.id);
  const featured = bids.filter((b) => b.status === "active" && b.position !== null);
  for (const r of inArea) {
    if (key.categoryId !== null && r.primaryCategoryId !== key.categoryId) {
      const [extra] = await tx
        .select({ id: listingCategories.listingId })
        .from(listingCategories)
        .where(and(eq(listingCategories.listingId, r.id), eq(listingCategories.categoryId, key.categoryId)))
        .limit(1);
      if (extra === undefined) continue;
    }
    if (featured.some((b) => b.listingId === r.id)) continue;
    const positions = spot?.positions ?? siteConfig.featured.positions;
    const floorCents = spot?.floorCents ?? floorCentsFor(key.areaKind);
    const lowest = featured.length === 0 ? null : Math.min(...featured.map((b) => b.amountCents));
    const fromCents =
      lowest === null || featured.length < positions ? floorCents : Math.max(floorCents, lowest + UNIT_CENTS_LOCAL);
    return { listingId: r.id, listingName: r.name, fromCents };
  }
  return null;
}

/** One major unit; `lib/spots/rank.ts` owns the constant, repeated here to keep this module free of that import at load. */
const UNIT_CENTS_LOCAL = 100;

/* ---------------------------------------------- appended: Task 45 history */

export interface BidHistoryEntry {
  readonly at: Date;
  /** `spots.bid_placed`, `spots.bid_raise_requested`, `spots.bid_lowered`, `spots.bid_cancelled`, `spots.raise_withdrawn`, `spots.raise_expired`. */
  readonly action: string;
  readonly bidId: string;
  readonly key: SpotKey;
  /** The amount the row recorded, when it did. */
  readonly amountCents: number | null;
  readonly meta: Record<string, unknown>;
}

/**
 * The owner's bid history: every audit row written against one of the
 * listing's bids (cancelled ones included), newest first. Scoped by the
 * listing's owner (constraint 24).
 */
export async function bidHistory(
  tx: TestDb,
  viewer: Viewer,
  input: { listingId: string; profileId: string; limit?: number },
): Promise<BidHistoryEntry[]> {
  assertSignedIn(viewer);
  if (!UUID.test(input.listingId) || !UUID.test(input.profileId)) return [];
  const rows = await tx
    .select({
      at: auditLog.createdAt,
      action: auditLog.action,
      bidId: featuredBids.id,
      meta: auditLog.meta,
      areaKind: featuredSpots.areaKind,
      areaId: featuredSpots.areaId,
      categoryId: featuredSpots.categoryId,
    })
    .from(auditLog)
    .innerJoin(featuredBids, eq(featuredBids.id, auditLog.entityId))
    .innerJoin(featuredSpots, eq(featuredSpots.id, featuredBids.spotId))
    .innerJoin(listings, eq(listings.id, featuredBids.listingId))
    .where(
      and(
        eq(auditLog.entityType, "featured_bid"),
        eq(featuredBids.listingId, input.listingId),
        eq(listings.ownerId, input.profileId),
      ),
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(input.limit ?? 50);
  return rows.map((r) => {
    const meta = (r.meta ?? {}) as Record<string, unknown>;
    const amount = [meta.amountCents, meta.pendingAmountCents].find((v): v is number => typeof v === "number") ?? null;
    return {
      at: r.at,
      action: r.action,
      bidId: r.bidId,
      key: { areaKind: r.areaKind as AreaKind, areaId: r.areaId, categoryId: r.categoryId },
      amountCents: amount,
      meta,
    };
  });
}

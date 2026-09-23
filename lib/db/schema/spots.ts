import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, integer, timestamp, uniqueIndex, index, check,
} from "drizzle-orm/pg-core";
import { base } from "./_base";
import { categories } from "./geo";
import { listings } from "./listings";
import { profiles } from "./ownership";

/**
 * Featured spots: the paid positions above the organic grid.
 *
 * A SPOT is a place on the site where up to `positions` listings can be
 * featured — a city page, a city × category page, or (once region pages
 * exist) a region page. Owners of verified, paying listings BID a monthly
 * amount for a spot; the top `positions` bids are shown and charged, the rest
 * are "outbid" and pay nothing for that spot. The ranking itself lives in
 * `lib/spots/rank.ts` and is written back to `featured_bids.position` on
 * every change, so the pillar page reads a column rather than re-ranking.
 *
 * Money for featured placement is a SEPARATE PayPal subscription from the
 * listing's tier subscription (`subscriptions`): one per listing, on a
 * "$1 per unit, monthly" plan, whose quantity is the sum of that listing's
 * featured bids. `listings.tier` is never touched by any of this — it stays
 * owned by `applyEffect` in lib/db/queries/billing.ts. Featured placement is
 * its own state and its own row.
 */

/**
 * `area_id` is text rather than a uuid because a region has no table of its
 * own: it is a `cities.region` group, addressed by `slugify(region)` — the
 * same key the region pages use. A city spot stores the city's uuid as text.
 * The unique index treats a null category as one fixed value so "the city
 * page's spot" can exist exactly once beside "the city × category spots".
 */
export const featuredSpots = pgTable("featured_spots", {
  ...base,
  areaKind: text("area_kind").notNull(),
  areaId: text("area_id").notNull(),
  categoryId: uuid("category_id").references(() => categories.id),
  positions: integer("positions").notNull().default(3),
  /** The lowest bid this spot accepts, in minor units. From the config at creation. */
  floorCents: integer("floor_cents").notNull(),
  status: text("status").notNull().default("open"),
}, (t) => [
  uniqueIndex("featured_spots_key").on(
    t.areaKind,
    t.areaId,
    sql`coalesce(${t.categoryId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
  ),
  check("featured_spots_area_kind_check", sql`${t.areaKind} in ('city', 'region')`),
  check("featured_spots_status_check", sql`${t.status} in ('open', 'closed')`),
  check("featured_spots_positions_check", sql`${t.positions} >= 1`),
  check("featured_spots_floor_check", sql`${t.floorCents} >= 0`),
]);

/**
 * One per listing: the PayPal subscription that pays for every featured
 * position the listing holds. `quantity` is what PayPal has CONFIRMED it
 * bills (from the ACTIVATED/UPDATED webhook or a reconcile);
 * `requested_quantity` is what the listing's featured bids add up to right
 * now. The two differ while a revision is waiting for the buyer's approval —
 * PayPal's revise call requires it — and the hourly sync re-requests the
 * revision until they agree. Both are whole units of the plan (one unit =
 * one major unit of the site currency).
 */
export const featuredSubscriptions = pgTable("featured_subscriptions", {
  ...base,
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  /** profiles.id of the owner who started it (constraint 21). */
  userId: uuid("user_id").references(() => profiles.id),
  provider: text("provider").notNull().default("paypal"),
  providerSubscriptionId: text("provider_subscription_id"),
  providerPlanId: text("provider_plan_id"),
  /**
   * `paused` is OUR suspension: every bid the listing holds is outbid, so
   * PayPal is told to suspend (no consent needed) and told to activate again
   * when a bid re-enters. PayPal's own SUSPENDED (payment failure) is
   * `suspended` and is a lapse.
   */
  status: text("status").notNull(),
  /** Confirmed by PayPal: only ever written from a payload that carries a quantity. */
  quantity: integer("quantity").notNull().default(0),
  /** The quantity last ASKED of PayPal (create or revise). */
  requestedQuantity: integer("requested_quantity").notNull().default(0),
  reviseRequestedAt: timestamp("revise_requested_at", { withTimezone: true }),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  /**
   * Where the buyer approves the subscription (first time) or its latest
   * revision. Kept so an owner who closed the PayPal tab can be sent back to
   * it from the bidding page instead of starting a second subscription.
   */
  approveUrl: text("approve_url"),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
}, (t) => [
  index("featured_subscriptions_listing_idx").on(t.listingId),
  uniqueIndex("featured_subscriptions_provider_sub_key").on(t.providerSubscriptionId),
  // One live subscription per listing: two first bids racing on two spots
  // must not become two PayPal subscriptions.
  uniqueIndex("featured_subscriptions_live_key")
    .on(t.listingId)
    .where(sql`${t.status} in ('approval_pending', 'active', 'past_due', 'paused')`),
  check(
    "featured_subscriptions_status_check",
    sql`${t.status} in ('approval_pending', 'active', 'past_due', 'paused', 'cancelled', 'suspended', 'expired')`,
  ),
  check("featured_subscriptions_quantity_check", sql`${t.quantity} >= 0`),
  check("featured_subscriptions_requested_check", sql`${t.requestedQuantity} >= 0`),
]);

/**
 * A listing's bid on a spot. `amount_cents` is the bid that ranks;
 * `pending_amount_cents` is a raise waiting for PayPal to confirm the higher
 * quantity — a raise is not applied until the money behind it is, while a
 * lowering or a cancellation takes effect at once (nothing to confirm; the
 * buyer is paying less). `position` is derived: 1..positions while the bid is
 * among the featured, null while outbid, rewritten by every re-rank.
 *
 * At most one uncancelled bid per listing per spot: a listing has one place
 * in a spot's ranking, and a second row would be a second charge.
 */
export const featuredBids = pgTable("featured_bids", {
  ...base,
  spotId: uuid("spot_id").notNull().references(() => featuredSpots.id, { onDelete: "cascade" }),
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  subscriptionId: uuid("subscription_id").references(() => featuredSubscriptions.id),
  amountCents: integer("amount_cents").notNull(),
  /**
   * When `amount_cents` was last set — the tie-break. A raise resets it, so
   * raising to match the leader lands BEHIND the leader rather than jumping
   * the queue on the bid's original date.
   */
  amountSetAt: timestamp("amount_set_at", { withTimezone: true }).notNull().defaultNow(),
  pendingAmountCents: integer("pending_amount_cents"),
  status: text("status").notNull().default("pending"),
  position: integer("position"),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
}, (t) => [
  index("featured_bids_spot_idx").on(t.spotId, t.status),
  index("featured_bids_listing_idx").on(t.listingId),
  uniqueIndex("featured_bids_live_key")
    .on(t.spotId, t.listingId)
    .where(sql`${t.status} <> 'cancelled'`),
  check("featured_bids_amount_check", sql`${t.amountCents} > 0`),
  check(
    "featured_bids_status_check",
    sql`${t.status} in ('pending', 'active', 'outbid', 'cancelled')`,
  ),
  check("featured_bids_position_check", sql`${t.position} is null or ${t.position} >= 1`),
]);

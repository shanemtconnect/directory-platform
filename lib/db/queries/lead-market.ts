import { and, asc, count, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import {
  categories, cities, leadBlocklist, leadPurchases, leadRefunds, leadStandingOrders, leads, listings, profiles, user,
} from "@/lib/db/schema";
import type { Territory } from "@/lib/db/schema/lead-market";
import { ensureProfile } from "@/lib/auth/profile";
import { now } from "@/lib/clock";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";
import { regionSlug } from "@/lib/routing/slugs";
import { notifyLeadRefundDecided } from "@/lib/email/notify";
import {
  BLOCKLIST_MONTHS, MAX_STANDING_ORDERS_PER_LISTING, blocklistsOnRefund, currentPriceCents, floorCents, isRefundRateFlagged,
  isRefundReason, orderCovers, refundRate, refundWindowOpen, type LeadPlace, type RefundReason,
} from "@/lib/leads/market";
import { InsufficientCredit, creditBalance, debitForPurchase, refundToCredit } from "./credits";
import { writeAudit } from "./audit";

/**
 * The lead market's data layer (Task 58, flag `leadMarketplace`).
 *
 * PII discipline: after a sale a lead's contact fields (name, email, phone,
 * message) are read in exactly two places — `purchasedLead` below, for the
 * buyer's own /leads/<id> page, and the worker's `leadWonNotification` for
 * the won email. Every list here (the board, a buyer's purchases, the admin
 * queue and lead list) selects `first_name` and `brief` and nothing else a
 * seller could be reached by.
 *
 * `profileId` is `profiles.id` (the credit ledger's key); `authUserId` is
 * Better Auth's `user.id`, which `leads.buyer_user_id` references.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

/** Leads per board page. */
export const BOARD_PAGE_SIZE = 20;
/** The dearest a standing order may bid for one lead: 10,000 in major units. */
export const MAX_ORDER_CENTS = 10_000 * 100;

type SignedIn = Exclude<Viewer, { role: "public" }>;

function assertSignedIn(viewer: Viewer): asserts viewer is SignedIn {
  if (viewer.role === "public") throw new Error("FORBIDDEN");
}

function assertAdmin(viewer: Viewer): void {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
}

/* ------------------------------------------------------------------ sale */

export interface LockedLead {
  readonly id: string;
  readonly cityId: string;
  readonly categoryId: string | null;
  readonly priceCents: number;
  readonly halfPriceAt: Date;
}

/**
 * `SELECT … FOR UPDATE` on an open, unexpired lead. The row lock is what
 * makes a sale single: a second buyer (or allocation) blocks here until the
 * first commits, then reads `sold` and gets null.
 */
export async function lockOpenLead(tx: TestDb, leadId: string, at: Date = now()): Promise<LockedLead | null> {
  if (!UUID.test(leadId)) return null;
  const [row] = await tx
    .select({
      id: leads.id, status: leads.status, expiresAt: leads.expiresAt, cityId: leads.cityId,
      categoryId: leads.categoryId, priceCents: leads.priceCents, halfPriceAt: leads.halfPriceAt,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .for("update");
  if (!row || row.status !== "open" || row.expiresAt.getTime() <= at.getTime()) return null;
  return row;
}

export interface SaleInput {
  readonly leadId: string;
  readonly profileId: string;
  readonly listingId: string;
  readonly standingOrderId: string | null;
  readonly priceCents: number;
  readonly ledgerId: string;
}

/**
 * The one way a lead is sold, board or standing order: the purchase row
 * (unique per lead — a second sale fails here even if every other guard were
 * skipped), the lead marked `sold`, and the audit line. The caller holds the
 * lead's row lock and has already debited the buyer.
 */
export async function recordSale(tx: TestDb, viewer: Viewer, input: SaleInput, at: Date = now()): Promise<string> {
  const [buyer] = await tx.select({ authUserId: profiles.userId }).from(profiles).where(eq(profiles.id, input.profileId));
  const [purchase] = await tx
    .insert(leadPurchases)
    .values({
      leadId: input.leadId,
      userId: input.profileId,
      listingId: input.listingId,
      standingOrderId: input.standingOrderId,
      priceCents: input.priceCents,
      ledgerId: input.ledgerId,
      revealedAt: at,
      createdAt: at,
      updatedAt: at,
    })
    .returning({ id: leadPurchases.id });
  await tx
    .update(leads)
    .set({ status: "sold", soldAt: at, soldToListingId: input.listingId, buyerUserId: buyer?.authUserId ?? null, updatedAt: at })
    .where(eq(leads.id, input.leadId));
  await writeAudit(tx, viewer, {
    action: "lead.sold",
    entityType: "lead",
    entityId: input.leadId,
    meta: {
      purchaseId: purchase!.id, via: input.standingOrderId === null ? "board" : "standing_order",
      standingOrderId: input.standingOrderId, priceCents: input.priceCents, listingId: input.listingId,
    },
  });
  return purchase!.id;
}

/* ------------------------------------------------------------------- board */

export interface BoardLead {
  readonly id: string;
  readonly firstName: string;
  readonly brief: string;
  readonly cityName: string;
  readonly categoryName: string | null;
  readonly createdAt: Date;
  /** Halved after `half_price_at` (D9). */
  readonly priceCents: number;
  readonly halfPrice: boolean;
}

export interface BoardPage {
  readonly leads: BoardLead[];
  readonly total: number;
  readonly page: number;
  readonly pages: number;
}

const openAt = (at: Date) => and(eq(leads.status, "open"), gt(leads.expiresAt, at));

/**
 * The board: open leads, newest first, signed-in viewers only. First name,
 * town, category, brief, age and today's price — never a contact field.
 */
export async function boardLeads(tx: TestDb, viewer: Viewer, opts: { page: number }, at: Date = now()): Promise<BoardPage> {
  assertSignedIn(viewer);
  const page = Math.max(1, Math.floor(opts.page));
  const [{ total } = { total: 0 }] = await tx.select({ total: count() }).from(leads).where(openAt(at));
  const rows = await tx
    .select({
      id: leads.id, firstName: leads.firstName, brief: leads.brief, cityName: cities.name,
      categoryName: categories.name, createdAt: leads.createdAt, priceCents: leads.priceCents, halfPriceAt: leads.halfPriceAt,
    })
    .from(leads)
    .innerJoin(cities, eq(cities.id, leads.cityId))
    .leftJoin(categories, eq(categories.id, leads.categoryId))
    .where(openAt(at))
    .orderBy(desc(leads.createdAt), desc(leads.id))
    .limit(BOARD_PAGE_SIZE)
    .offset((page - 1) * BOARD_PAGE_SIZE);
  return {
    leads: rows.map(({ halfPriceAt, priceCents, ...r }) => ({
      ...r,
      priceCents: currentPriceCents({ priceCents, halfPriceAt }, at),
      halfPrice: at.getTime() >= halfPriceAt.getTime(),
    })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / BOARD_PAGE_SIZE)),
  };
}

export interface BuyerContext {
  readonly profileId: string;
  readonly balanceCents: number;
  /** The viewer's published listings: what a lead can be bought for. */
  readonly listings: { id: string; name: string }[];
  /** Whether the weekly board digest is off for this account. */
  readonly digestOptOut: boolean;
}

export async function buyerContext(tx: TestDb, viewer: Viewer): Promise<BuyerContext> {
  assertSignedIn(viewer);
  const profile = await ensureProfile(tx, viewer);
  const owned = await tx
    .select({ id: listings.id, name: listings.name })
    .from(listings)
    .where(and(eq(listings.ownerId, profile.id), eq(listings.status, "published")))
    .orderBy(asc(listings.name));
  const [prefs] = await tx.select({ off: profiles.leadDigestOptOut }).from(profiles).where(eq(profiles.id, profile.id));
  return { profileId: profile.id, balanceCents: await creditBalance(tx, profile.id), listings: owned, digestOptOut: prefs?.off ?? false };
}

export type BuyResult =
  | { outcome: "bought"; purchaseId: string }
  | { outcome: "insufficient"; balanceCents: number; neededCents: number }
  | { outcome: "gone" }
  | { outcome: "not-your-listing" };

/**
 * Buys an open lead off the board for one of the viewer's published
 * listings, at today's price, from their credit. The lead row is locked
 * first, so of two buyers pressing at once one wins and the other is told
 * it has gone. Short of credit → `insufficient` and nothing written: the
 * debit refuses before it writes (never a partial debit).
 */
export async function buyLead(tx: TestDb, viewer: Viewer, leadId: string, listingId: string, at: Date = now()): Promise<BuyResult> {
  assertSignedIn(viewer);
  if (!UUID.test(listingId)) return { outcome: "not-your-listing" };
  const profile = await ensureProfile(tx, viewer);
  const [listing] = await tx
    .select({ id: listings.id })
    .from(listings)
    .where(and(eq(listings.id, listingId), eq(listings.ownerId, profile.id), eq(listings.status, "published")))
    .limit(1);
  if (!listing) return { outcome: "not-your-listing" };

  const lead = await lockOpenLead(tx, leadId, at);
  if (lead === null) return { outcome: "gone" };
  const price = currentPriceCents(lead, at);

  let ledgerId: string;
  try {
    ({ entryId: ledgerId } = await debitForPurchase(tx, viewer, { userId: profile.id, cents: price, leadId: lead.id }));
  } catch (e) {
    if (e instanceof InsufficientCredit) return { outcome: "insufficient", balanceCents: e.balanceCents, neededCents: e.neededCents };
    throw e;
  }
  const purchaseId = await recordSale(tx, viewer, {
    leadId: lead.id, profileId: profile.id, listingId, standingOrderId: null, priceCents: price, ledgerId,
  }, at);
  return { outcome: "bought", purchaseId };
}

/* --------------------------------------------------------- the buyer's side */

export interface RefundState {
  readonly id: string;
  readonly status: "pending" | "approved" | "rejected";
  readonly reason: RefundReason;
  readonly decisionNote: string | null;
}

export interface MyPurchase {
  readonly purchaseId: string;
  readonly leadId: string;
  readonly boughtAt: Date;
  readonly priceCents: number;
  readonly firstName: string;
  readonly brief: string;
  readonly cityName: string;
  readonly categoryName: string | null;
  readonly listingName: string | null;
  readonly viaStandingOrder: boolean;
  readonly refund: RefundState | null;
  /** Reportable now: inside the window and not reported yet. */
  readonly refundable: boolean;
  /** Whether the lead still exists for its page (an admin may have deleted it). */
  readonly viewable: boolean;
}

function refundOf(r: { id: string | null; status: RefundState["status"] | null; reason: RefundReason | null; decisionNote: string | null }): RefundState | null {
  return r.id === null || r.status === null || r.reason === null ? null : { id: r.id, status: r.status, reason: r.reason, decisionNote: r.decisionNote };
}

/** The viewer's purchases, newest first. First name and brief only: the details live on each lead's page. */
export async function myPurchases(tx: TestDb, viewer: Viewer, at: Date = now()): Promise<MyPurchase[]> {
  assertSignedIn(viewer);
  const profile = await ensureProfile(tx, viewer);
  const rows = await tx
    .select({
      purchaseId: leadPurchases.id, leadId: leadPurchases.leadId, boughtAt: leadPurchases.createdAt,
      priceCents: leadPurchases.priceCents, standingOrderId: leadPurchases.standingOrderId,
      firstName: leads.firstName, brief: leads.brief, status: leads.status, cityName: cities.name,
      categoryName: categories.name, listingName: listings.name,
      refundId: leadRefunds.id, refundStatus: leadRefunds.status, refundReason: leadRefunds.reason, decisionNote: leadRefunds.decisionNote,
    })
    .from(leadPurchases)
    .innerJoin(leads, eq(leads.id, leadPurchases.leadId))
    .innerJoin(cities, eq(cities.id, leads.cityId))
    .leftJoin(categories, eq(categories.id, leads.categoryId))
    .leftJoin(listings, eq(listings.id, leadPurchases.listingId))
    .leftJoin(leadRefunds, eq(leadRefunds.purchaseId, leadPurchases.id))
    .where(eq(leadPurchases.userId, profile.id))
    .orderBy(desc(leadPurchases.createdAt));
  return rows.map((r) => {
    const refund = refundOf({ id: r.refundId, status: r.refundStatus, reason: r.refundReason, decisionNote: r.decisionNote });
    return {
      purchaseId: r.purchaseId, leadId: r.leadId, boughtAt: r.boughtAt, priceCents: r.priceCents,
      firstName: r.firstName, brief: r.brief, cityName: r.cityName, categoryName: r.categoryName,
      listingName: r.listingName, viaStandingOrder: r.standingOrderId !== null, refund,
      refundable: refund === null && r.status === "sold" && refundWindowOpen(r.boughtAt, at),
      viewable: r.status === "sold",
    };
  });
}

export interface PurchasedLead {
  readonly leadId: string;
  readonly purchaseId: string;
  readonly boughtAt: Date;
  readonly priceCents: number;
  readonly name: string;
  readonly email: string;
  readonly phone: string | null;
  readonly message: string;
  readonly cityName: string;
  readonly categoryName: string | null;
  readonly createdAt: Date;
  readonly refund: RefundState | null;
  readonly refundable: boolean;
}

/**
 * The full lead — the one page read of its contact details — for the
 * account that bought it, and nobody else (null → the page 404s, so an id
 * says nothing about whether the lead exists).
 */
export async function purchasedLead(tx: TestDb, viewer: Viewer, leadId: string, at: Date = now()): Promise<PurchasedLead | null> {
  if (viewer.role === "public" || !UUID.test(leadId)) return null;
  const profile = await ensureProfile(tx, viewer);
  const [r] = await tx
    .select({
      leadId: leads.id, purchaseId: leadPurchases.id, boughtAt: leadPurchases.createdAt, priceCents: leadPurchases.priceCents,
      name: leads.name, email: leads.email, phone: leads.phone, message: leads.message, cityName: cities.name,
      categoryName: categories.name, createdAt: leads.createdAt,
      refundId: leadRefunds.id, refundStatus: leadRefunds.status, refundReason: leadRefunds.reason, decisionNote: leadRefunds.decisionNote,
    })
    .from(leadPurchases)
    .innerJoin(leads, eq(leads.id, leadPurchases.leadId))
    .innerJoin(cities, eq(cities.id, leads.cityId))
    .leftJoin(categories, eq(categories.id, leads.categoryId))
    .leftJoin(leadRefunds, eq(leadRefunds.purchaseId, leadPurchases.id))
    .where(and(eq(leadPurchases.leadId, leadId), eq(leadPurchases.userId, profile.id), eq(leads.status, "sold")))
    .limit(1);
  if (!r) return null;
  const refund = refundOf({ id: r.refundId, status: r.refundStatus, reason: r.refundReason, decisionNote: r.decisionNote });
  return {
    leadId: r.leadId, purchaseId: r.purchaseId, boughtAt: r.boughtAt, priceCents: r.priceCents, name: r.name,
    email: r.email, phone: r.phone, message: r.message, cityName: r.cityName, categoryName: r.categoryName,
    createdAt: r.createdAt, refund, refundable: refund === null && refundWindowOpen(r.boughtAt, at),
  };
}

export type RefundRequestResult =
  | { outcome: "requested"; refundId: string }
  | { outcome: "invalid-reason" }
  | { outcome: "not-found" }
  | { outcome: "already-reported" }
  | { outcome: "window-closed" };

/** A buyer's "report a bad lead" (D10): within `refundWindowDays` of buying, once per purchase. */
export async function requestRefund(
  tx: TestDb,
  viewer: Viewer,
  input: { leadId: string; reason: string; note: string },
  at: Date = now(),
): Promise<RefundRequestResult> {
  assertSignedIn(viewer);
  if (!isRefundReason(input.reason)) return { outcome: "invalid-reason" };
  if (!UUID.test(input.leadId)) return { outcome: "not-found" };
  const profile = await ensureProfile(tx, viewer);
  const [purchase] = await tx
    .select({ id: leadPurchases.id, boughtAt: leadPurchases.createdAt, status: leads.status })
    .from(leadPurchases)
    .innerJoin(leads, eq(leads.id, leadPurchases.leadId))
    .where(and(eq(leadPurchases.leadId, input.leadId), eq(leadPurchases.userId, profile.id)))
    .for("update", { of: leadPurchases })
    .limit(1);
  if (!purchase || purchase.status !== "sold") return { outcome: "not-found" };
  const [existing] = await tx.select({ id: leadRefunds.id }).from(leadRefunds).where(eq(leadRefunds.purchaseId, purchase.id)).limit(1);
  if (existing) return { outcome: "already-reported" };
  if (!refundWindowOpen(purchase.boughtAt, at)) return { outcome: "window-closed" };

  const note = input.note.trim().slice(0, 1000);
  const [row] = await tx
    .insert(leadRefunds)
    .values({ purchaseId: purchase.id, reason: input.reason, note: note === "" ? null : note, createdAt: at, updatedAt: at })
    .returning({ id: leadRefunds.id });
  await writeAudit(tx, viewer, {
    action: "lead.refund_requested", entityType: "lead", entityId: input.leadId,
    meta: { refundId: row!.id, purchaseId: purchase.id, reason: input.reason },
  });
  return { outcome: "requested", refundId: row!.id };
}

/* --------------------------------------------------------- standing orders */

export interface StandingOrderInput {
  readonly listingId: string;
  readonly territories: readonly Territory[];
  /** Null or empty = every category. */
  readonly categoryIds: readonly string[] | null;
  readonly priceCents: number;
}

export type StandingOrderField = "listing" | "territories" | "categories" | "price";

export type StandingOrderResult =
  | { outcome: "saved"; id: string }
  | { outcome: "invalid"; errors: Partial<Record<StandingOrderField, string>> }
  | { outcome: "limit" }
  | { outcome: "not-found" };

export interface StandingOrderRow {
  readonly id: string;
  readonly listingId: string;
  readonly listingName: string;
  readonly territories: Territory[];
  readonly categoryIds: string[] | null;
  readonly priceCents: number;
  readonly status: "active" | "paused";
  readonly pausedReason: string | null;
  readonly wonCount: number;
  readonly createdAt: Date;
}

/** The viewer's standing orders, by listing then age. */
export async function standingOrdersFor(tx: TestDb, viewer: Viewer): Promise<StandingOrderRow[]> {
  assertSignedIn(viewer);
  const profile = await ensureProfile(tx, viewer);
  const rows = await tx
    .select({
      id: leadStandingOrders.id, listingId: leadStandingOrders.listingId, listingName: listings.name,
      territories: leadStandingOrders.territories, categoryIds: leadStandingOrders.categoryIds,
      priceCents: leadStandingOrders.priceCents, status: leadStandingOrders.status,
      pausedReason: leadStandingOrders.pausedReason, wonCount: leadStandingOrders.wonCount, createdAt: leadStandingOrders.createdAt,
    })
    .from(leadStandingOrders)
    .innerJoin(listings, eq(listings.id, leadStandingOrders.listingId))
    .where(eq(leadStandingOrders.userId, profile.id))
    .orderBy(asc(listings.name), asc(leadStandingOrders.createdAt));
  return rows.map((r) => ({ ...r, categoryIds: r.categoryIds ?? null }));
}

export interface TerritoryOptions {
  readonly regions: { slug: string; name: string }[];
  readonly cities: { id: string; name: string; region: string | null }[];
  readonly categories: { id: string; name: string }[];
}

/** What the standing-order editor offers: published towns, their regions, active categories. */
export async function standingOrderOptions(tx: TestDb): Promise<TerritoryOptions> {
  const towns = await tx
    .select({ id: cities.id, name: cities.name, region: cities.region })
    .from(cities)
    .where(eq(cities.isPublished, true))
    .orderBy(asc(cities.name));
  const regions = new Map<string, string>();
  for (const t of towns) if (t.region) regions.set(regionSlug(t.region), t.region);
  const cats = await tx
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(eq(categories.isActive, true))
    .orderBy(asc(categories.name));
  return {
    regions: [...regions].map(([slug, name]) => ({ slug, name })).sort((a, b) => a.name.localeCompare(b.name)),
    cities: towns,
    categories: cats,
  };
}

async function validateOrder(
  tx: TestDb,
  input: StandingOrderInput,
): Promise<{ errors: Partial<Record<StandingOrderField, string>>; territories: Territory[]; categoryIds: string[] | null }> {
  const errors: Partial<Record<StandingOrderField, string>> = {};
  const floor = floorCents();
  if (!Number.isInteger(input.priceCents) || input.priceCents < floor) {
    errors.price = "The price must be at least the floor.";
  } else if (input.priceCents > MAX_ORDER_CENTS) {
    errors.price = "That price is higher than the site allows.";
  }

  const seen = new Set<string>();
  const territories = input.territories.filter((t) => {
    const key = t.kind === "national" ? "national" : `${t.kind}:${t.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const options = await standingOrderOptions(tx);
  const cityIds = new Set(options.cities.map((c) => c.id));
  const regionSlugs = new Set(options.regions.map((r) => r.slug));
  if (territories.length === 0) {
    errors.territories = "Choose at least one town, region or the whole country.";
  } else if (territories.some((t) => (t.kind === "city" && !cityIds.has(t.id)) || (t.kind === "region" && !regionSlugs.has(t.id)))) {
    errors.territories = "One of those places is not on the site.";
  }

  const wanted = [...new Set(input.categoryIds ?? [])];
  const categoryIds = wanted.length === 0 ? null : wanted;
  if (categoryIds !== null) {
    const known = new Set(options.categories.map((c) => c.id));
    if (categoryIds.some((id) => !known.has(id))) errors.categories = "One of those categories is not on the site.";
  }
  return { errors, territories, categoryIds };
}

async function ownedListingId(tx: TestDb, profileId: string, listingId: string): Promise<string | null> {
  if (!UUID.test(listingId)) return null;
  const [row] = await tx
    .select({ id: listings.id })
    .from(listings)
    .where(and(eq(listings.id, listingId), eq(listings.ownerId, profileId)))
    .limit(1);
  return row?.id ?? null;
}

/** A new standing order on one of the viewer's listings, at most five per listing. Audited. */
export async function createStandingOrder(tx: TestDb, viewer: Viewer, input: StandingOrderInput, at: Date = now()): Promise<StandingOrderResult> {
  assertSignedIn(viewer);
  const profile = await ensureProfile(tx, viewer);
  const listingId = await ownedListingId(tx, profile.id, input.listingId);
  if (listingId === null) return { outcome: "invalid", errors: { listing: "Choose one of your listings." } };
  const { errors, territories, categoryIds } = await validateOrder(tx, input);
  if (Object.keys(errors).length > 0) return { outcome: "invalid", errors };

  // Serialise creates on one listing so two tabs cannot both take the fifth slot.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`standing-orders:${listingId}`}))`);
  const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(leadStandingOrders).where(eq(leadStandingOrders.listingId, listingId));
  if (n >= MAX_STANDING_ORDERS_PER_LISTING) return { outcome: "limit" };

  const [row] = await tx
    .insert(leadStandingOrders)
    .values({ userId: profile.id, listingId, territories, categoryIds, priceCents: input.priceCents, createdAt: at, updatedAt: at })
    .returning({ id: leadStandingOrders.id });
  await writeAudit(tx, viewer, {
    action: "lead.standing_order_created", entityType: "lead_standing_order", entityId: row!.id,
    meta: { listingId, territories, categoryIds, priceCents: input.priceCents },
  });
  return { outcome: "saved", id: row!.id };
}

async function ownOrder(tx: TestDb, profileId: string, id: string) {
  if (!UUID.test(id)) return null;
  const [row] = await tx
    .select({ id: leadStandingOrders.id, listingId: leadStandingOrders.listingId, status: leadStandingOrders.status })
    .from(leadStandingOrders)
    .where(and(eq(leadStandingOrders.id, id), eq(leadStandingOrders.userId, profileId)))
    .for("update")
    .limit(1);
  return row ?? null;
}

/** Changes an order's places, categories and price. Its listing stays; so does its status. */
export async function updateStandingOrder(
  tx: TestDb, viewer: Viewer, id: string, input: Omit<StandingOrderInput, "listingId">, at: Date = now(),
): Promise<StandingOrderResult> {
  assertSignedIn(viewer);
  const profile = await ensureProfile(tx, viewer);
  const order = await ownOrder(tx, profile.id, id);
  if (order === null) return { outcome: "not-found" };
  const { errors, territories, categoryIds } = await validateOrder(tx, { ...input, listingId: order.listingId });
  if (Object.keys(errors).length > 0) return { outcome: "invalid", errors };
  await tx
    .update(leadStandingOrders)
    .set({ territories, categoryIds, priceCents: input.priceCents, updatedAt: at })
    .where(eq(leadStandingOrders.id, order.id));
  await writeAudit(tx, viewer, {
    action: "lead.standing_order_updated", entityType: "lead_standing_order", entityId: order.id,
    meta: { territories, categoryIds, priceCents: input.priceCents },
  });
  return { outcome: "saved", id: order.id };
}

/** Pause (the owner's own pause) or resume — resuming clears a no-credit pause too. */
export async function setStandingOrderStatus(
  tx: TestDb, viewer: Viewer, id: string, status: "active" | "paused", at: Date = now(),
): Promise<StandingOrderResult> {
  assertSignedIn(viewer);
  const profile = await ensureProfile(tx, viewer);
  const order = await ownOrder(tx, profile.id, id);
  if (order === null) return { outcome: "not-found" };
  await tx
    .update(leadStandingOrders)
    .set({ status, pausedReason: status === "paused" ? "user" : null, updatedAt: at })
    .where(eq(leadStandingOrders.id, order.id));
  await writeAudit(tx, viewer, {
    action: status === "paused" ? "lead.standing_order_paused" : "lead.standing_order_resumed",
    entityType: "lead_standing_order", entityId: order.id, meta: { reason: status === "paused" ? "user" : null },
  });
  return { outcome: "saved", id: order.id };
}

export async function deleteStandingOrder(tx: TestDb, viewer: Viewer, id: string): Promise<StandingOrderResult> {
  assertSignedIn(viewer);
  const profile = await ensureProfile(tx, viewer);
  const order = await ownOrder(tx, profile.id, id);
  if (order === null) return { outcome: "not-found" };
  await tx.delete(leadStandingOrders).where(eq(leadStandingOrders.id, order.id));
  await writeAudit(tx, viewer, {
    action: "lead.standing_order_deleted", entityType: "lead_standing_order", entityId: order.id, meta: { listingId: order.listingId },
  });
  return { outcome: "saved", id: order.id };
}

/* ------------------------------------------------------------------- admin */

export interface AdminLeadCounts {
  readonly open: number;
  readonly sold: number;
  readonly expired: number;
  readonly pendingRefunds: number;
}

export async function adminLeadCounts(tx: TestDb, viewer: Viewer): Promise<AdminLeadCounts> {
  assertAdmin(viewer);
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select
      (select count(*)::int from ${leads} where ${leads.status} = 'open') as open,
      (select count(*)::int from ${leads} where ${leads.status} = 'sold') as sold,
      (select count(*)::int from ${leads} where ${leads.status} = 'expired') as expired,
      (select count(*)::int from ${leadRefunds} where ${leadRefunds.status} = 'pending') as pending_refunds
  `);
  const row = rows[0] ?? {};
  const n = (k: string) => Number(row[k] ?? 0);
  return { open: n("open"), sold: n("sold"), expired: n("expired"), pendingRefunds: n("pending_refunds") };
}

export interface BuyerRefundStats {
  readonly purchases: number;
  readonly refundRequests: number;
  readonly rate: number;
  /** D10: above a third — shown with a ⚠, never acted on automatically. */
  readonly flagged: boolean;
}

const buyerPurchases = (profileId: unknown) =>
  sql<number>`(select count(*)::int from ${leadPurchases} bp where bp.user_id = ${profileId})`;
const buyerRequests = (profileId: unknown) =>
  sql<number>`(select count(*)::int from ${leadRefunds} br join ${leadPurchases} bpp on bpp.id = br.purchase_id where bpp.user_id = ${profileId})`;

function statsOf(purchases: number, requests: number): BuyerRefundStats {
  return { purchases, refundRequests: requests, rate: refundRate(purchases, requests), flagged: isRefundRateFlagged(purchases, requests) };
}

export interface RefundQueueRow {
  readonly refundId: string;
  readonly requestedAt: Date;
  readonly reason: RefundReason;
  readonly note: string | null;
  readonly leadId: string;
  readonly firstName: string;
  readonly brief: string;
  readonly cityName: string;
  readonly priceCents: number;
  readonly boughtAt: Date;
  readonly buyerName: string | null;
  readonly buyerEmail: string | null;
  readonly listingName: string | null;
  readonly buyer: BuyerRefundStats;
}

/** Pending bad-lead reports, oldest first, each with its buyer's refund rate. */
export async function adminRefundQueue(tx: TestDb, viewer: Viewer): Promise<RefundQueueRow[]> {
  assertAdmin(viewer);
  const rows = await tx
    .select({
      refundId: leadRefunds.id, requestedAt: leadRefunds.createdAt, reason: leadRefunds.reason, note: leadRefunds.note,
      leadId: leads.id, firstName: leads.firstName, brief: leads.brief, cityName: cities.name,
      priceCents: leadPurchases.priceCents, boughtAt: leadPurchases.createdAt, buyerName: user.name, buyerEmail: user.email,
      listingName: listings.name,
      purchases: buyerPurchases(leadPurchases.userId), requests: buyerRequests(leadPurchases.userId),
    })
    .from(leadRefunds)
    .innerJoin(leadPurchases, eq(leadPurchases.id, leadRefunds.purchaseId))
    .innerJoin(leads, eq(leads.id, leadPurchases.leadId))
    .innerJoin(cities, eq(cities.id, leads.cityId))
    .innerJoin(profiles, eq(profiles.id, leadPurchases.userId))
    .leftJoin(user, eq(user.id, profiles.userId))
    .leftJoin(listings, eq(listings.id, leadPurchases.listingId))
    .where(eq(leadRefunds.status, "pending"))
    .orderBy(asc(leadRefunds.createdAt));
  return rows.map(({ purchases, requests, ...r }) => ({ ...r, buyer: statsOf(Number(purchases), Number(requests)) }));
}

export interface BuyerRow extends BuyerRefundStats {
  readonly profileId: string;
  readonly name: string | null;
  readonly email: string | null;
}

/** Every account that has bought a lead, most refund-prone first. */
export async function adminBuyers(tx: TestDb, viewer: Viewer): Promise<BuyerRow[]> {
  assertAdmin(viewer);
  const rows = await tx
    .select({
      profileId: leadPurchases.userId, name: user.name, email: user.email,
      purchases: sql<number>`count(distinct ${leadPurchases.id})::int`,
      requests: sql<number>`count(distinct ${leadRefunds.id})::int`,
    })
    .from(leadPurchases)
    .innerJoin(profiles, eq(profiles.id, leadPurchases.userId))
    .leftJoin(user, eq(user.id, profiles.userId))
    .leftJoin(leadRefunds, eq(leadRefunds.purchaseId, leadPurchases.id))
    .groupBy(leadPurchases.userId, user.name, user.email)
    .limit(200);
  return rows
    .map(({ purchases, requests, ...r }) => ({ ...r, ...statsOf(Number(purchases), Number(requests)) }))
    .sort((a, b) => b.rate - a.rate || b.purchases - a.purchases);
}

export interface AdminLeadRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly status: "open" | "sold" | "expired" | "deleted";
  readonly source: "quote" | "capture" | "enquiry";
  readonly firstName: string;
  readonly brief: string;
  readonly cityName: string;
  readonly categoryName: string | null;
  readonly priceCents: number;
  readonly soldToListingName: string | null;
}

/** The newest leads that still exist, for the admin list. First name and brief only. */
export async function adminRecentLeads(tx: TestDb, viewer: Viewer, limit = 100): Promise<AdminLeadRow[]> {
  assertAdmin(viewer);
  return tx
    .select({
      id: leads.id, createdAt: leads.createdAt, status: leads.status, source: leads.source, firstName: leads.firstName,
      brief: leads.brief, cityName: cities.name, categoryName: categories.name, priceCents: leads.priceCents,
      soldToListingName: listings.name,
    })
    .from(leads)
    .innerJoin(cities, eq(cities.id, leads.cityId))
    .leftJoin(categories, eq(categories.id, leads.categoryId))
    .leftJoin(listings, eq(listings.id, leads.soldToListingId))
    .where(sql`${leads.status} <> 'deleted'`)
    .orderBy(desc(leads.createdAt))
    .limit(limit);
}

/** Takes a lead off the board (or out of its buyer's reach). The sweep removes the row later. Audited. */
export async function adminDeleteLead(tx: TestDb, viewer: Viewer, leadId: string, at: Date = now()): Promise<boolean> {
  assertAdmin(viewer);
  if (!UUID.test(leadId)) return false;
  const rows = await tx
    .update(leads)
    .set({ status: "deleted", updatedAt: at })
    .where(and(eq(leads.id, leadId), sql`${leads.status} <> 'deleted'`))
    .returning({ id: leads.id });
  if (rows.length === 0) return false;
  await writeAudit(tx, viewer, { action: "lead.deleted", entityType: "lead", entityId: leadId });
  return true;
}

export type RefundDecision =
  | { outcome: "approved"; balanceCents: number }
  | { outcome: "rejected" }
  | { outcome: "already-decided" }
  | { outcome: "not-found" }
  | { outcome: "note-required" };

function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

/**
 * The admin's call on a bad-lead report (D10). Approve: the price goes back
 * as credit (`refundToCredit`, idempotent per refund), the lead's phone and
 * email are blocklisted for 12 months when the reason is the requester's
 * doing (`blocklistsOnRefund` — not `wrong_area` or `bounced`), and
 * `lead.refund_approved` is audited. The lead itself stays `sold` — a refund re-opens nothing, and
 * nobody else is offered a lead that has just been reported as bad. Reject:
 * a note is required, so the buyer is told why. Either way the buyer is
 * emailed.
 */
export async function decideRefund(
  tx: TestDb,
  viewer: Viewer,
  refundId: string,
  input: { approve: boolean; note: string; ip?: string | null },
  at: Date = now(),
): Promise<RefundDecision> {
  assertAdmin(viewer);
  if (!UUID.test(refundId)) return { outcome: "not-found" };
  const note = input.note.trim().slice(0, 1000);
  if (!input.approve && note === "") return { outcome: "note-required" };

  const [row] = await tx
    .select({
      status: leadRefunds.status, reason: leadRefunds.reason, purchaseId: leadPurchases.id, userId: leadPurchases.userId,
      priceCents: leadPurchases.priceCents, leadId: leads.id, phone: leads.phoneNormalised, email: leads.emailNormalised,
    })
    .from(leadRefunds)
    .innerJoin(leadPurchases, eq(leadPurchases.id, leadRefunds.purchaseId))
    .innerJoin(leads, eq(leads.id, leadPurchases.leadId))
    .where(eq(leadRefunds.id, refundId))
    .for("update", { of: leadRefunds })
    .limit(1);
  if (!row) return { outcome: "not-found" };
  if (row.status !== "pending") return { outcome: "already-decided" };

  const actorId = viewer.role === "admin" && viewer.userId !== "00000000-0000-0000-0000-000000000000"
    ? (await ensureProfile(tx, viewer)).id
    : null;
  await tx
    .update(leadRefunds)
    .set({ status: input.approve ? "approved" : "rejected", decidedBy: actorId, decidedAt: at, decisionNote: note === "" ? null : note, updatedAt: at })
    .where(eq(leadRefunds.id, refundId));

  let balanceCents = 0;
  if (input.approve) {
    ({ balanceCents } = await refundToCredit(tx, viewer, { userId: row.userId, cents: row.priceCents, leadId: row.leadId, refundId }));
    const until = addMonths(at, BLOCKLIST_MONTHS);
    const entries = !blocklistsOnRefund(row.reason) ? [] : [
      ...(row.phone ? [{ kind: "phone" as const, value: row.phone }] : []),
      ...(row.email ? [{ kind: "email" as const, value: row.email }] : []),
    ];
    for (const e of entries) {
      await tx
        .insert(leadBlocklist)
        .values({ ...e, reason: `refund:${row.reason}`, leadId: row.leadId, expiresAt: until })
        .onConflictDoUpdate({
          target: [leadBlocklist.kind, leadBlocklist.value],
          // Never shortens an existing entry, and never turns a permanent one temporary.
          set: {
            expiresAt: sql`case when ${leadBlocklist.expiresAt} is null then null else greatest(${leadBlocklist.expiresAt}, excluded.expires_at) end`,
            reason: sql`excluded.reason`,
            leadId: sql`excluded.lead_id`,
            updatedAt: at,
          },
        });
    }
  }
  await writeAudit(tx, viewer, {
    action: input.approve ? "lead.refund_approved" : "lead.refund_rejected",
    entityType: "lead",
    entityId: row.leadId,
    meta: {
      refundId, purchaseId: row.purchaseId, reason: row.reason, cents: row.priceCents, note: note === "" ? null : note,
      blocklisted: input.approve && blocklistsOnRefund(row.reason),
    },
    ip: input.ip ?? null,
  });
  await notifyLeadRefundDecided(tx, viewer, refundId);
  return input.approve ? { outcome: "approved", balanceCents } : { outcome: "rejected" };
}

/* ------------------------------------------------------------------- sweep */

/** How long an expired lead's row is kept before it is deleted. */
export const DELETE_AFTER_EXPIRY_DAYS = 7;

/**
 * `leads.sweep` (hourly): an open lead past `expires_at` becomes `expired`
 * (it leaves the board); an expired or admin-deleted lead that was never
 * bought is deleted outright seven days after `expires_at`. A bought lead
 * is never deleted here — its purchase, and any refund, point at it.
 */
export async function sweepLeads(tx: TestDb, viewer: Viewer, at: Date = now()): Promise<{ expired: number; deleted: number }> {
  assertAdmin(viewer);
  const expired = await tx
    .update(leads)
    .set({ status: "expired", updatedAt: at })
    .where(and(eq(leads.status, "open"), lte(leads.expiresAt, at)))
    .returning({ id: leads.id });
  const cutoff = new Date(at.getTime() - DELETE_AFTER_EXPIRY_DAYS * DAY_MS);
  const deleted = await tx
    .delete(leads)
    .where(and(
      inArray(leads.status, ["expired", "deleted"]),
      lte(leads.expiresAt, cutoff),
      sql`not exists (select 1 from ${leadPurchases} where ${leadPurchases.leadId} = ${leads.id})`,
    ))
    .returning({ id: leads.id });
  return { expired: expired.length, deleted: deleted.length };
}

/* ------------------------------------------------------------------ digest */

/** Open leads with what coverage needs: city, its region slug, category. */
export async function openLeadPlaces(tx: TestDb, at: Date = now(), limit = 5000): Promise<(LeadPlace & { id: string; createdAt: Date })[]> {
  const rows = await tx
    .select({ id: leads.id, cityId: leads.cityId, region: cities.region, categoryId: leads.categoryId, createdAt: leads.createdAt })
    .from(leads)
    .innerJoin(cities, eq(cities.id, leads.cityId))
    .where(openAt(at))
    .orderBy(asc(leads.createdAt))
    .limit(limit);
  return rows.map(({ region, ...r }) => ({ ...r, regionSlug: region ? regionSlug(region) : null }));
}

/** How far back a purchase keeps an account on the weekly digest. */
export const DIGEST_PURCHASE_DAYS = 90;

/**
 * Who gets the weekly board digest: accounts with an active standing order
 * or a purchase in the last 90 days, that have not opted out.
 */
export async function boardDigestRecipients(tx: TestDb, viewer: Viewer, at: Date = now()): Promise<string[]> {
  assertAdmin(viewer);
  const since = new Date(at.getTime() - DIGEST_PURCHASE_DAYS * DAY_MS);
  const rows = await tx
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(
      eq(profiles.leadDigestOptOut, false),
      sql`(exists (select 1 from ${leadStandingOrders} where ${leadStandingOrders.userId} = ${profiles.id} and ${leadStandingOrders.status} = 'active')
        or exists (select 1 from ${leadPurchases} where ${leadPurchases.userId} = ${profiles.id} and ${leadPurchases.createdAt} >= ${since.toISOString()}::timestamptz))`,
    ));
  return rows.map((r) => r.id);
}

export interface BoardDigest {
  readonly email: string;
  readonly name: string | null;
  /** Open leads their active standing orders cover — or, with none active, in their listings' towns. */
  readonly openCount: number;
}

/**
 * One account's digest, computed at send time. Null when the account has
 * opted out, has no address, or has nothing to be told about.
 */
export async function boardDigestFor(tx: TestDb, viewer: Viewer, profileId: string, at: Date = now()): Promise<BoardDigest | null> {
  assertAdmin(viewer);
  if (!UUID.test(profileId)) return null;
  const [account] = await tx
    .select({ email: user.email, name: user.name, optOut: profiles.leadDigestOptOut })
    .from(profiles)
    .innerJoin(user, eq(user.id, profiles.userId))
    .where(eq(profiles.id, profileId))
    .limit(1);
  if (!account || account.optOut || !account.email) return null;

  const orders = await tx
    .select({ territories: leadStandingOrders.territories, categoryIds: leadStandingOrders.categoryIds })
    .from(leadStandingOrders)
    .where(and(eq(leadStandingOrders.userId, profileId), eq(leadStandingOrders.status, "active")));
  const territories = orders.length > 0
    ? orders.map((o) => ({ territories: o.territories, categoryIds: o.categoryIds ?? null }))
    : (await tx
        .selectDistinct({ cityId: listings.cityId })
        .from(listings)
        .where(and(eq(listings.ownerId, profileId), eq(listings.status, "published"))))
        .map((l) => ({ territories: [{ kind: "city", id: l.cityId }] as Territory[], categoryIds: null }));
  if (territories.length === 0) return null;

  const open = await openLeadPlaces(tx, at);
  const openCount = open.filter((lead) => territories.some((o) => orderCovers(o, lead))).length;
  if (openCount === 0) return null;
  return { email: account.email, name: account.name, openCount };
}

/**
 * The digest's opt-out, from its unsubscribe link (no sign-in, so the
 * token's address must still be the account's) or from the account page.
 */
export async function setLeadDigestOptOut(
  tx: TestDb,
  viewer: Viewer,
  input: { profileId: string; email?: string; optOut: boolean },
): Promise<boolean> {
  if (!UUID.test(input.profileId)) return false;
  if (viewer.role !== "public" && !isAdmin(viewer)) {
    const own = await ensureProfile(tx, viewer);
    if (own.id !== input.profileId) throw new Error("FORBIDDEN");
  } else if (viewer.role === "public") {
    if (input.email === undefined || !input.optOut) throw new Error("FORBIDDEN");
    const [row] = await tx
      .select({ email: user.email })
      .from(profiles)
      .innerJoin(user, eq(user.id, profiles.userId))
      .where(eq(profiles.id, input.profileId))
      .limit(1);
    if (!row || row.email.trim().toLowerCase() !== input.email.trim().toLowerCase()) return false;
  }
  const rows = await tx
    .update(profiles)
    .set({ leadDigestOptOut: input.optOut, updatedAt: now() })
    .where(eq(profiles.id, input.profileId))
    .returning({ id: profiles.id });
  return rows.length > 0;
}

/* ------------------------------------------------------ worker read-backs */

export interface LeadWonNotification {
  readonly email: string;
  readonly buyerName: string | null;
  readonly listingName: string | null;
  readonly priceCents: number;
  readonly leadId: string;
  readonly name: string;
  readonly leadEmail: string;
  readonly phone: string | null;
  readonly message: string;
  readonly cityName: string;
  readonly categoryName: string | null;
}

/**
 * The won email's data — the second of the two reads of a sold lead's
 * contact details. Admin (worker) only. Null when the lead is no longer
 * sold (deleted since) or the buyer has no address.
 */
export async function leadWonNotification(tx: TestDb, viewer: Viewer, purchaseId: string): Promise<LeadWonNotification | null> {
  assertAdmin(viewer);
  if (!UUID.test(purchaseId)) return null;
  const [r] = await tx
    .select({
      email: user.email, buyerName: user.name, listingName: listings.name, priceCents: leadPurchases.priceCents,
      leadId: leads.id, name: leads.name, leadEmail: leads.email, phone: leads.phone, message: leads.message,
      cityName: cities.name, categoryName: categories.name, status: leads.status,
    })
    .from(leadPurchases)
    .innerJoin(leads, eq(leads.id, leadPurchases.leadId))
    .innerJoin(cities, eq(cities.id, leads.cityId))
    .leftJoin(categories, eq(categories.id, leads.categoryId))
    .innerJoin(profiles, eq(profiles.id, leadPurchases.userId))
    .innerJoin(user, eq(user.id, profiles.userId))
    .leftJoin(listings, eq(listings.id, leadPurchases.listingId))
    .where(eq(leadPurchases.id, purchaseId))
    .limit(1);
  if (!r || r.status !== "sold" || !r.email) return null;
  const { status: _status, ...rest } = r;
  return rest;
}

export interface LeadTopupNotification {
  readonly email: string;
  readonly name: string | null;
  readonly listingName: string;
  readonly priceCents: number;
  readonly balanceCents: number;
}

/** The top-up email's data; null unless the order is still paused for credit. Admin (worker) only. */
export async function leadTopupNotification(tx: TestDb, viewer: Viewer, standingOrderId: string): Promise<LeadTopupNotification | null> {
  assertAdmin(viewer);
  if (!UUID.test(standingOrderId)) return null;
  const [r] = await tx
    .select({
      email: user.email, name: user.name, listingName: listings.name, priceCents: leadStandingOrders.priceCents,
      userId: leadStandingOrders.userId, status: leadStandingOrders.status, pausedReason: leadStandingOrders.pausedReason,
    })
    .from(leadStandingOrders)
    .innerJoin(listings, eq(listings.id, leadStandingOrders.listingId))
    .innerJoin(profiles, eq(profiles.id, leadStandingOrders.userId))
    .innerJoin(user, eq(user.id, profiles.userId))
    .where(eq(leadStandingOrders.id, standingOrderId))
    .limit(1);
  if (!r || r.status !== "paused" || r.pausedReason !== "no_credit" || !r.email) return null;
  return { email: r.email, name: r.name, listingName: r.listingName, priceCents: r.priceCents, balanceCents: await creditBalance(tx, r.userId) };
}

export interface LeadRefundNotification {
  readonly email: string;
  readonly name: string | null;
  readonly status: "approved" | "rejected";
  readonly reason: RefundReason;
  readonly decisionNote: string | null;
  readonly priceCents: number;
  readonly leadId: string;
  readonly firstName: string;
  readonly brief: string;
}

/** The refund decision email's data; null while undecided. Admin (worker) only. */
export async function leadRefundNotification(tx: TestDb, viewer: Viewer, refundId: string): Promise<LeadRefundNotification | null> {
  assertAdmin(viewer);
  if (!UUID.test(refundId)) return null;
  const [r] = await tx
    .select({
      email: user.email, name: user.name, status: leadRefunds.status, reason: leadRefunds.reason, decisionNote: leadRefunds.decisionNote,
      priceCents: leadPurchases.priceCents, leadId: leads.id, firstName: leads.firstName, brief: leads.brief,
    })
    .from(leadRefunds)
    .innerJoin(leadPurchases, eq(leadPurchases.id, leadRefunds.purchaseId))
    .innerJoin(leads, eq(leads.id, leadPurchases.leadId))
    .innerJoin(profiles, eq(profiles.id, leadPurchases.userId))
    .innerJoin(user, eq(user.id, profiles.userId))
    .where(eq(leadRefunds.id, refundId))
    .limit(1);
  if (!r || r.status === "pending" || !r.email) return null;
  return { ...r, status: r.status };
}

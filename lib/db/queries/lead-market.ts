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
  BLOCKLIST_MONTHS, MAX_STANDING_ORDERS_PER_LISTING, currentPriceCents, floorCents, isRefundRateFlagged,
  isRefundReason, refundRate, refundWindowOpen, type LeadPlace, type RefundReason,
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
}

export async function buyerContext(tx: TestDb, viewer: Viewer): Promise<BuyerContext> {
  assertSignedIn(viewer);
  const profile = await ensureProfile(tx, viewer);
  const owned = await tx
    .select({ id: listings.id, name: listings.name })
    .from(listings)
    .where(and(eq(listings.ownerId, profile.id), eq(listings.status, "published")))
    .orderBy(asc(listings.name));
  return { profileId: profile.id, balanceCents: await creditBalance(tx, profile.id), listings: owned };
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

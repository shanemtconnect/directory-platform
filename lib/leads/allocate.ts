import { and, asc, desc, eq, sql } from "drizzle-orm";
import { cities, leadStandingOrders, listings } from "@/lib/db/schema";
import { now } from "@/lib/clock";
import type { Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";
import { regionSlug } from "@/lib/routing/slugs";
import { InsufficientCredit, creditBalance, debitForPurchase } from "@/lib/db/queries/credits";
import { lockOpenLead, recordSale } from "@/lib/db/queries/lead-market";
import { writeAudit } from "@/lib/db/queries/audit";
import { notifyLeadTopup, notifyLeadWon } from "@/lib/email/notify";

/**
 * Allocation (Task 58, D8): the instant a lead exists, it goes to ONE
 * standing order — the best-paying one that covers it and can pay.
 *
 * Candidates are active orders whose territories include the lead's city,
 * that city's region slug, or national, and whose `category_ids` is null or
 * includes the lead's category, on a listing still published and still
 * owned by the order's account. Ranked `price_cents desc, created_at asc`.
 * The first candidate whose balance covers its price is debited its own
 * price (`debitForPurchase`, which re-checks the balance under the account's
 * lock) and the sale recorded; the buyer is queued the won email with the
 * contact details. Every candidate that could NOT pay is paused
 * (`paused_reason = no_credit`) and queued one top-up email — paused, it is
 * not a candidate again, so it is never mailed twice for the same shortfall.
 * Nobody → the lead stays open on the board.
 *
 * Called from `afterLeadCreated` inside the confirm route's savepoint, and
 * from the hourly `leads.retry_allocate`.
 */

/**
 * Allocation debits on the buyer's behalf, so it acts as the system. Same
 * authority as `BILLING_SYSTEM_VIEWER` (lib/billing/process.ts), declared
 * here so request-path code has no ready-made admin viewer to import. The
 * nil UUID can never match a row's owner_id.
 */
const ALLOCATION_VIEWER: Viewer = { role: "admin", userId: "00000000-0000-0000-0000-000000000000" };

export type AllocationResult =
  | { outcome: "sold"; purchaseId: string; standingOrderId: string; userId: string }
  | { outcome: "open"; paused: string[] }
  | { outcome: "not-open" };

export async function allocateLead(tx: TestDb, viewer: Viewer, leadId: string, at: Date = now()): Promise<AllocationResult> {
  const lead = await lockOpenLead(tx, leadId, at);
  if (lead === null) return { outcome: "not-open" };

  const [city] = await tx.select({ region: cities.region }).from(cities).where(eq(cities.id, lead.cityId));
  const region = city?.region ? regionSlug(city.region) : null;

  const covers = sql.join(
    [
      sql`${leadStandingOrders.territories} @> ${JSON.stringify([{ kind: "city", id: lead.cityId }])}::jsonb`,
      sql`${leadStandingOrders.territories} @> '[{"kind":"national"}]'::jsonb`,
      ...(region ? [sql`${leadStandingOrders.territories} @> ${JSON.stringify([{ kind: "region", id: region }])}::jsonb`] : []),
    ],
    sql` or `,
  );
  const category = lead.categoryId === null
    ? sql`${leadStandingOrders.categoryIds} is null`
    : sql`(${leadStandingOrders.categoryIds} is null or ${leadStandingOrders.categoryIds} @> ${JSON.stringify([lead.categoryId])}::jsonb)`;

  const candidates = await tx
    .select({
      id: leadStandingOrders.id, userId: leadStandingOrders.userId, listingId: leadStandingOrders.listingId,
      priceCents: leadStandingOrders.priceCents,
    })
    .from(leadStandingOrders)
    .innerJoin(listings, and(
      eq(listings.id, leadStandingOrders.listingId),
      eq(listings.ownerId, leadStandingOrders.userId),
      eq(listings.status, "published"),
    ))
    .where(and(eq(leadStandingOrders.status, "active"), sql`(${covers})`, category))
    .orderBy(desc(leadStandingOrders.priceCents), asc(leadStandingOrders.createdAt), asc(leadStandingOrders.id))
    .for("update", { of: leadStandingOrders });

  let won: AllocationResult | null = null;
  const paused: string[] = [];
  for (const c of candidates) {
    if (won === null) {
      try {
        const { entryId } = await debitForPurchase(tx, ALLOCATION_VIEWER, { userId: c.userId, cents: c.priceCents, leadId: lead.id });
        const purchaseId = await recordSale(tx, viewer, {
          leadId: lead.id, profileId: c.userId, listingId: c.listingId, standingOrderId: c.id, priceCents: c.priceCents, ledgerId: entryId,
        }, at);
        await tx
          .update(leadStandingOrders)
          .set({ wonCount: sql`${leadStandingOrders.wonCount} + 1`, updatedAt: at })
          .where(eq(leadStandingOrders.id, c.id));
        await notifyLeadWon(tx, viewer, purchaseId);
        won = { outcome: "sold", purchaseId, standingOrderId: c.id, userId: c.userId };
        continue;
      } catch (e) {
        if (!(e instanceof InsufficientCredit)) throw e;
      }
    } else {
      // Ranked below the winner: it could not have bought this lead anyway,
      // but an order that cannot pay its own price can buy none, so say so now.
      if ((await creditBalance(tx, c.userId)) >= c.priceCents) continue;
    }
    await pauseForCredit(tx, viewer, c.id, at);
    paused.push(c.id);
  }
  return won ?? { outcome: "open", paused };
}

async function pauseForCredit(tx: TestDb, viewer: Viewer, standingOrderId: string, at: Date): Promise<void> {
  await tx
    .update(leadStandingOrders)
    .set({ status: "paused", pausedReason: "no_credit", updatedAt: at })
    .where(eq(leadStandingOrders.id, standingOrderId));
  await writeAudit(tx, viewer, {
    action: "lead.standing_order_paused", entityType: "lead_standing_order", entityId: standingOrderId, meta: { reason: "no_credit" },
  });
  await notifyLeadTopup(tx, viewer, standingOrderId);
}

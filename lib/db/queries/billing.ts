import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  auditLog,
  cities,
  listings,
  processedEvents,
  profiles,
  subscriptions,
  user,
  verificationChecks,
} from "@/lib/db/schema";
import { now } from "@/lib/clock";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { TierName } from "@/config/types";
import type { Interval } from "@/lib/pricing";
import type { CurrentSubscription, Effect } from "@/lib/billing/webhooks";
import type { TestDb } from "@/test/db";

/**
 * Every database access billing makes.
 *
 * The state machine in `lib/billing/webhooks.ts` decides; this file writes. The
 * split is deliberate: the transitions are the part that has to be provable
 * against recorded payloads, and the writes are the part that has to be
 * provably scoped to the right owner.
 *
 * `listings.tier` is written HERE and nowhere else (global constraint 31) —
 * it is the ranking input in `lib/db/sort.ts`, so a second writer is a
 * position somebody did not pay for.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PROVIDER = "paypal";

/**
 * There is no shared audit helper on this branch, so this is the private one
 * (the controller unifies them on merge). Every owner and webhook mutation
 * below calls it inside the caller's transaction — global constraint 22.
 */
export async function writeBillingAudit(
  tx: TestDb,
  input: {
    actorId: string | null;
    action: string;
    entityId: string | null;
    meta: Record<string, unknown>;
    ip?: string | null;
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    actorId: input.actorId,
    action: input.action,
    entityType: "subscription",
    entityId: input.entityId,
    meta: input.meta,
    ip: input.ip ?? null,
  });
}

function assertWorker(viewer: Viewer): void {
  // Webhook and job paths only. These rows carry other people's billing state.
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
}

function assertSignedIn(viewer: Viewer): void {
  if (viewer.role === "public") throw new Error("FORBIDDEN");
}

/* ------------------------------------------------------------------ checkout */

export interface CheckoutListing {
  readonly id: string;
  readonly name: string;
  readonly tier: TierName;
  readonly claimStatus: "unclaimed" | "claimed" | "verified";
  readonly path: string;
  readonly cityPath: string;
}

/**
 * The owner gate for the whole checkout flow.
 *
 * Ownership is `listings.owner_id = profiles.id` AND a claim that has actually
 * been granted: an `owner_id` on an unclaimed row is a claim in progress, and
 * buying a plan for a listing you have not been given is how somebody else's
 * business ends up on your card.
 *
 * Takes `FOR UPDATE` on the listing row. Two checkouts for one listing — a
 * double-clicked submit, or a second tab while the return page is activating
 * the first — are serialised on it inside the caller's transaction, so the
 * live-subscription check that follows reads committed state rather than a
 * moment before it. Only the listing is locked (`of`), not the joined city.
 */
export async function listingForCheckout(
  tx: TestDb,
  viewer: Viewer,
  input: { listingId: string; profileId: string },
): Promise<CheckoutListing | null> {
  assertSignedIn(viewer);
  if (!UUID.test(input.listingId) || !UUID.test(input.profileId)) return null;

  const [row] = await tx
    .select({
      id: listings.id,
      name: listings.name,
      tier: listings.tier,
      claimStatus: listings.claimStatus,
      slug: listings.slug,
      citySlug: cities.slug,
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(
      and(
        eq(listings.id, input.listingId),
        eq(listings.ownerId, input.profileId),
        ne(listings.claimStatus, "unclaimed"),
      ),
    )
    .limit(1)
    .for("update", { of: listings });
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    tier: row.tier,
    claimStatus: row.claimStatus,
    path: `/${row.citySlug}/${row.slug}`,
    cityPath: `/${row.citySlug}`,
  };
}

/** Statuses under which a listing is being billed, or about to be retried. */
export const LIVE_SUBSCRIPTION_STATUSES = ["active", "past_due"] as const;

/**
 * The subscription that already pays for this listing, if any. Owner-scoped
 * through the listing join, and meant to be read AFTER `listingForCheckout`
 * has taken the row lock. A plan change is a later task; a second live
 * subscription for one listing is two bills for one position.
 */
export async function liveSubscriptionForListing(
  tx: TestDb,
  viewer: Viewer,
  input: { listingId: string; profileId: string },
): Promise<{ id: string; status: string } | null> {
  assertSignedIn(viewer);
  if (!UUID.test(input.listingId) || !UUID.test(input.profileId)) return null;
  const [row] = await tx
    .select({ id: subscriptions.id, status: subscriptions.status })
    .from(subscriptions)
    .innerJoin(listings, eq(listings.id, subscriptions.listingId))
    .where(
      and(
        eq(subscriptions.listingId, input.listingId),
        eq(listings.ownerId, input.profileId),
        inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface CreatePendingInput {
  listingId: string;
  profileId: string;
  tier: TierName;
  interval: Interval;
  providerPlanId: string;
  ip: string | null;
  couponCode?: string | null;
}

/**
 * The row exists BEFORE PayPal does, so its id can be handed over as
 * `custom_id` and come back on every webhook. Nothing about the listing
 * changes here — an approval that is never completed must leave no trace of a
 * tier nobody paid for.
 */
export async function createPendingSubscription(
  tx: TestDb,
  viewer: Viewer,
  input: CreatePendingInput,
): Promise<string> {
  assertSignedIn(viewer);
  const [row] = await tx
    .insert(subscriptions)
    .values({
      listingId: input.listingId,
      userId: input.profileId,
      provider: PROVIDER,
      providerPlanId: input.providerPlanId,
      tier: input.tier,
      interval: input.interval,
      status: "approval_pending",
    })
    .returning({ id: subscriptions.id });

  const id = row!.id;
  await writeBillingAudit(tx, {
    actorId: input.profileId,
    action: "billing.checkout_started",
    entityId: id,
    meta: {
      listingId: input.listingId,
      tier: input.tier,
      interval: input.interval,
      coupon: input.couponCode ?? null,
    },
    ip: input.ip,
  });
  return id;
}

export async function attachProviderSubscription(
  tx: TestDb,
  viewer: Viewer,
  id: string,
  providerSubscriptionId: string,
): Promise<void> {
  assertSignedIn(viewer);
  await tx
    .update(subscriptions)
    .set({ providerSubscriptionId, updatedAt: now() })
    .where(eq(subscriptions.id, id));
}

/* ------------------------------------------------------------------ webhooks */

/**
 * The unique index on (provider, event_id) IS the idempotency mechanism.
 * `onConflictDoNothing` turns a redelivery into `false` rather than a second
 * run of the same transition — and PayPal redelivers freely.
 */
export async function recordProcessedEvent(
  tx: TestDb,
  viewer: Viewer,
  input: { eventId: string; payload: unknown },
): Promise<boolean> {
  assertWorker(viewer);
  const inserted = await tx
    .insert(processedEvents)
    .values({
      provider: PROVIDER,
      eventId: input.eventId,
      payload: input.payload as Record<string, unknown>,
      processedAt: now(),
    })
    .onConflictDoNothing()
    .returning({ id: processedEvents.id });
  return inserted.length > 0;
}

export interface SubscriptionForEvent extends CurrentSubscription {
  readonly listingPath: string;
  readonly cityPath: string;
  readonly listingClaimStatus: "unclaimed" | "claimed" | "verified";
  readonly profileId: string | null;
}

export async function subscriptionForEvent(
  tx: TestDb,
  viewer: Viewer,
  input: { providerSubscriptionId: string | null; customId: string | null },
): Promise<SubscriptionForEvent | null> {
  assertWorker(viewer);

  // The provider id first, our own id as the fallback: an ACTIVATED event can
  // arrive before the redirect that stores the provider id has been followed.
  const where =
    input.providerSubscriptionId !== null
      ? eq(subscriptions.providerSubscriptionId, input.providerSubscriptionId)
      : input.customId !== null && UUID.test(input.customId)
        ? eq(subscriptions.id, input.customId)
        : null;
  if (where === null) return null;

  const [row] = await tx
    .select({
      id: subscriptions.id,
      listingId: subscriptions.listingId,
      profileId: subscriptions.userId,
      tier: subscriptions.tier,
      interval: subscriptions.interval,
      status: subscriptions.status,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      trialEndsAt: subscriptions.trialEndsAt,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      listingSlug: listings.slug,
      citySlug: cities.slug,
      listingClaimStatus: listings.claimStatus,
    })
    .from(subscriptions)
    .innerJoin(listings, eq(listings.id, subscriptions.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(where)
    .limit(1);
  if (!row) return null;

  return {
    id: row.id,
    listingId: row.listingId,
    profileId: row.profileId,
    tier: row.tier,
    interval: row.interval,
    status: row.status,
    currentPeriodEnd: row.currentPeriodEnd,
    trialEndsAt: row.trialEndsAt,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    listingClaimStatus: row.listingClaimStatus,
    listingPath: `/${row.citySlug}/${row.listingSlug}`,
    cityPath: `/${row.citySlug}`,
  };
}

export interface AppliedEffect {
  readonly listingPath: string;
  readonly cityPath: string;
}

/** Verification checks that are still live. A closed one may be reopened. */
const OPEN_CHECK_STATES = ["open", "docs_pending", "call_scheduled", "passed"] as const;

/**
 * Applies one decided transition. Caller supplies the transaction so the
 * subscription, the listing, the verification check and the audit row all land
 * together or not at all.
 */
export async function applyEffect(
  tx: TestDb,
  viewer: Viewer,
  sub: SubscriptionForEvent,
  effect: Effect,
  meta: { eventId: string },
): Promise<AppliedEffect> {
  assertWorker(viewer);
  const at = now();

  await tx
    .update(subscriptions)
    .set({
      status: effect.status,
      tier: effect.tier,
      interval: effect.interval,
      currentPeriodEnd: effect.currentPeriodEnd,
      trialEndsAt: effect.trialEndsAt,
      cancelAtPeriodEnd: effect.cancelAtPeriodEnd,
      ...(effect.providerPlanId === null ? {} : { providerPlanId: effect.providerPlanId }),
      updatedAt: at,
    })
    .where(eq(subscriptions.id, sub.id));

  // The ONLY writer of listings.tier.
  await tx
    .update(listings)
    .set({
      tier: effect.listingTier,
      // The badge lapses with the subscription, so the listing carries the same
      // date the subscription does.
      verifiedExpiresAt: effect.listingTier === "free" ? null : effect.currentPeriodEnd,
      updatedAt: at,
    })
    .where(eq(listings.id, sub.listingId));

  if (effect.dropVerified) {
    // Only ever downwards. 'verified' is granted by a passed check, never here.
    await tx
      .update(listings)
      .set({ claimStatus: "claimed", verifiedExpiresAt: null, updatedAt: at })
      .where(and(eq(listings.id, sub.listingId), eq(listings.claimStatus, "verified")));
  }

  if (effect.openVerificationCheck) {
    const existing = await tx
      .select({ id: verificationChecks.id })
      .from(verificationChecks)
      .where(
        and(
          eq(verificationChecks.listingId, sub.listingId),
          inArray(verificationChecks.status, [...OPEN_CHECK_STATES]),
        ),
      )
      .limit(1);
    if (existing.length === 0) {
      await tx.insert(verificationChecks).values({
        listingId: sub.listingId,
        subscriptionId: sub.id,
        userId: sub.profileId,
        status: "open",
      });
    }
  }

  await writeBillingAudit(tx, {
    // A webhook has no human actor. The row records the event that caused it.
    actorId: null,
    action: `billing.${effect.action}`,
    entityId: sub.id,
    meta: {
      eventId: meta.eventId,
      listingId: sub.listingId,
      status: effect.status,
      listingTier: effect.listingTier,
      currentPeriodEnd: effect.currentPeriodEnd?.toISOString() ?? null,
    },
  });

  return { listingPath: sub.listingPath, cityPath: sub.cityPath };
}

/* ------------------------------------------------------------------- account */

export interface OwnerSubscription {
  readonly id: string;
  readonly listingId: string;
  readonly listingName: string;
  readonly listingPath: string;
  readonly cityPath: string;
  readonly tier: TierName;
  readonly interval: Interval;
  readonly status: string;
  readonly trialEndsAt: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly providerSubscriptionId: string | null;
}

const OWNER_COLUMNS = {
  id: subscriptions.id,
  listingId: subscriptions.listingId,
  listingName: listings.name,
  listingSlug: listings.slug,
  citySlug: cities.slug,
  tier: subscriptions.tier,
  interval: subscriptions.interval,
  status: subscriptions.status,
  trialEndsAt: subscriptions.trialEndsAt,
  currentPeriodEnd: subscriptions.currentPeriodEnd,
  cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
  providerSubscriptionId: subscriptions.providerSubscriptionId,
};

type OwnerRow = {
  id: string; listingId: string; listingName: string; listingSlug: string; citySlug: string;
  tier: TierName; interval: Interval; status: string; trialEndsAt: Date | null;
  currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean; providerSubscriptionId: string | null;
};

const toOwnerSubscription = (row: OwnerRow): OwnerSubscription => ({
  id: row.id,
  listingId: row.listingId,
  listingName: row.listingName,
  listingPath: `/${row.citySlug}/${row.listingSlug}`,
  cityPath: `/${row.citySlug}`,
  tier: row.tier,
  interval: row.interval,
  status: row.status,
  trialEndsAt: row.trialEndsAt,
  currentPeriodEnd: row.currentPeriodEnd,
  cancelAtPeriodEnd: row.cancelAtPeriodEnd,
  providerSubscriptionId: row.providerSubscriptionId,
});

/**
 * The owner gate is the JOIN, not the page: a subscription is visible when the
 * LISTING it pays for is owned by this profile. Matching on
 * `subscriptions.user_id` alone would keep showing a plan to somebody who has
 * since transferred the listing away.
 */
export async function ownerSubscriptions(
  tx: TestDb,
  viewer: Viewer,
  profileId: string,
): Promise<OwnerSubscription[]> {
  assertSignedIn(viewer);
  if (!UUID.test(profileId)) return [];
  const rows = await tx
    .select(OWNER_COLUMNS)
    .from(subscriptions)
    .innerJoin(listings, eq(listings.id, subscriptions.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(eq(listings.ownerId, profileId))
    .orderBy(desc(subscriptions.createdAt));
  return (rows as OwnerRow[]).map(toOwnerSubscription);
}

export async function subscriptionForOwner(
  tx: TestDb,
  viewer: Viewer,
  input: { id: string; profileId: string },
): Promise<OwnerSubscription | null> {
  assertSignedIn(viewer);
  if (!UUID.test(input.id) || !UUID.test(input.profileId)) return null;
  const [row] = await tx
    .select(OWNER_COLUMNS)
    .from(subscriptions)
    .innerJoin(listings, eq(listings.id, subscriptions.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(and(eq(subscriptions.id, input.id), eq(listings.ownerId, input.profileId)))
    .limit(1);
  return row ? toOwnerSubscription(row as OwnerRow) : null;
}

/**
 * The checkout return page's lookup. PayPal hands the buyer back with its own
 * `subscription_id` on the query string; this resolves it to a row ONLY when
 * the signed-in profile owns the listing it pays for. Any other id — a guess,
 * or somebody else's — is null before a PayPal call or an audit row can
 * happen, and the page renders the same thing for "not yours" and "not
 * found".
 */
export async function subscriptionForOwnerByProviderId(
  tx: TestDb,
  viewer: Viewer,
  input: { providerSubscriptionId: string; profileId: string },
): Promise<OwnerSubscription | null> {
  assertSignedIn(viewer);
  if (!UUID.test(input.profileId) || input.providerSubscriptionId.trim() === "") return null;
  const [row] = await tx
    .select(OWNER_COLUMNS)
    .from(subscriptions)
    .innerJoin(listings, eq(listings.id, subscriptions.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(
      and(
        eq(subscriptions.providerSubscriptionId, input.providerSubscriptionId.trim()),
        eq(listings.ownerId, input.profileId),
      ),
    )
    .limit(1);
  return row ? toOwnerSubscription(row as OwnerRow) : null;
}

/**
 * Marks the row as cancelling. The PayPal call is made by the action; this is
 * the part that has to be owner-scoped and audited. Returns false when the
 * subscription is not this profile's, so the caller can refuse without
 * revealing whether the id exists.
 */
export async function requestCancellation(
  tx: TestDb,
  viewer: Viewer,
  input: { subscriptionId: string; profileId: string; ip: string | null },
): Promise<boolean> {
  assertSignedIn(viewer);
  const owned = await subscriptionForOwner(tx, viewer, {
    id: input.subscriptionId,
    profileId: input.profileId,
  });
  if (owned === null) return false;

  await tx
    .update(subscriptions)
    .set({ cancelAtPeriodEnd: true, updatedAt: now() })
    .where(eq(subscriptions.id, input.subscriptionId));

  await writeBillingAudit(tx, {
    actorId: input.profileId,
    action: "billing.cancel_requested",
    entityId: input.subscriptionId,
    meta: { listingId: owned.listingId, periodEnd: owned.currentPeriodEnd?.toISOString() ?? null },
    ip: input.ip,
  });
  return true;
}

export interface Invoice {
  readonly id: string;
  readonly amount: string;
  readonly currency: string;
  readonly paidAt: Date;
  readonly providerSubscriptionId: string;
}

/**
 * There is no invoices table, and deliberately so: PayPal already holds the
 * record, and the completed-sale events we have stored are a copy of it that
 * cannot drift. `processed_events.payload` is the invoice history.
 */
export async function invoiceHistory(
  tx: TestDb,
  viewer: Viewer,
  providerSubscriptionIds: readonly string[],
): Promise<Invoice[]> {
  assertSignedIn(viewer);
  const ids = providerSubscriptionIds.filter((v) => v !== "");
  if (ids.length === 0) return [];

  const rows = await tx
    .select({
      id: sql<string>`${processedEvents.payload} -> 'resource' ->> 'id'`,
      amount: sql<string>`${processedEvents.payload} -> 'resource' -> 'amount' ->> 'total'`,
      currency: sql<string>`${processedEvents.payload} -> 'resource' -> 'amount' ->> 'currency'`,
      paidAt: sql<string>`${processedEvents.payload} -> 'resource' ->> 'create_time'`,
      subscriptionId: sql<string>`${processedEvents.payload} -> 'resource' ->> 'billing_agreement_id'`,
    })
    .from(processedEvents)
    .where(
      and(
        eq(processedEvents.provider, PROVIDER),
        sql`${processedEvents.payload} ->> 'event_type' = 'PAYMENT.SALE.COMPLETED'`,
        sql`${processedEvents.payload} -> 'resource' ->> 'billing_agreement_id' in ${ids}`,
      ),
    );

  return rows
    .filter((r) => r.id !== null && r.paidAt !== null)
    .map((r) => ({
      id: r.id,
      amount: r.amount ?? "0.00",
      currency: r.currency ?? "",
      paidAt: new Date(r.paidAt),
      providerSubscriptionId: r.subscriptionId,
    }))
    .sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime());
}

/* ---------------------------------------------------------------------- jobs */

export const REMINDER_ACTION = "billing.renewal_reminder";

export interface ReminderTarget {
  readonly subscriptionId: string;
  readonly listingId: string;
  readonly listingName: string;
  readonly listingPath: string;
  readonly tier: TierName;
  readonly interval: Interval;
  readonly currentPeriodEnd: Date;
  readonly offsetDays: number;
  readonly email: string | null;
}

const DAY_MS = 86_400_000;

/**
 * Who a renewal notice goes to: the account that is about to be charged
 * (`subscriptions.user_id` -> profiles -> Better Auth user), and only if that
 * is missing, the listing's public address. The listing's email is the
 * enquiry inbox — info@, or whoever answered the phone when the row was
 * scraped — and a charge notice in the wrong inbox is a chargeback.
 */
const PAYER_EMAIL = sql<string | null>`coalesce(${user.email}, ${listings.email})`;

/**
 * Subscriptions renewing on the day `offsetDays` from today.
 *
 * The window is a whole UTC DAY, aligned to midnight rather than to the moment
 * the job happens to tick. A now-relative window silently loses every
 * subscription whose renewal time of day has already gone by: a plan ending at
 * 09:00 is 29.9 days away at noon, so it falls in no bucket at all and the
 * 30-day reminder is never sent. Aligning to the day means "30 days before"
 * means the date, which is what the email says anyway.
 *
 * Dedupe is an `audit_log` row per (subscription, offset, period end) rather
 * than a new table. Three reasons: eight tasks are writing migrations in
 * parallel and this needs none; the audit row is the record that the email was
 * sent, which we want anyway; and keying on the PERIOD END means next year's
 * 30-day reminder for the same subscription is a different key and goes out.
 */
export async function dueRenewalReminders(
  tx: TestDb,
  viewer: Viewer,
  input: { offsetDays: number },
): Promise<ReminderTarget[]> {
  assertWorker(viewer);
  const at = now();
  const dayStart = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const from = new Date(dayStart + input.offsetDays * DAY_MS);
  const to = new Date(from.getTime() + DAY_MS);

  const rows = await tx
    .select({
      subscriptionId: subscriptions.id,
      listingId: subscriptions.listingId,
      listingName: listings.name,
      listingSlug: listings.slug,
      citySlug: cities.slug,
      tier: subscriptions.tier,
      interval: subscriptions.interval,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      email: PAYER_EMAIL,
    })
    .from(subscriptions)
    .innerJoin(listings, eq(listings.id, subscriptions.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .leftJoin(profiles, eq(profiles.id, subscriptions.userId))
    .leftJoin(user, eq(user.id, profiles.userId))
    .where(
      and(
        eq(subscriptions.status, "active"),
        eq(subscriptions.cancelAtPeriodEnd, false),
        isNotNull(subscriptions.currentPeriodEnd),
        gte(subscriptions.currentPeriodEnd, from),
        lt(subscriptions.currentPeriodEnd, to),
      ),
    )
    .orderBy(asc(subscriptions.currentPeriodEnd));

  const targets = rows.map((r) => ({
    subscriptionId: r.subscriptionId,
    listingId: r.listingId,
    listingName: r.listingName,
    listingPath: `/${r.citySlug}/${r.listingSlug}`,
    tier: r.tier,
    interval: r.interval,
    currentPeriodEnd: r.currentPeriodEnd!,
    offsetDays: input.offsetDays,
    email: r.email,
  }));
  if (targets.length === 0) return [];

  const already = await tx
    .select({ entityId: auditLog.entityId, meta: auditLog.meta })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, REMINDER_ACTION),
        inArray(
          auditLog.entityId,
          targets.map((t) => t.subscriptionId),
        ),
      ),
    );

  const sent = new Set(
    already.map((row) => {
      const meta = (row.meta ?? {}) as { offsetDays?: number; periodEnd?: string };
      return `${row.entityId}:${meta.offsetDays}:${meta.periodEnd}`;
    }),
  );

  return targets.filter(
    (t) =>
      !sent.has(`${t.subscriptionId}:${t.offsetDays}:${t.currentPeriodEnd.toISOString()}`),
  );
}

export async function markReminderSent(
  tx: TestDb,
  viewer: Viewer,
  target: ReminderTarget,
): Promise<void> {
  assertWorker(viewer);
  await writeBillingAudit(tx, {
    actorId: null,
    action: REMINDER_ACTION,
    entityId: target.subscriptionId,
    meta: {
      offsetDays: target.offsetDays,
      periodEnd: target.currentPeriodEnd.toISOString(),
      listingId: target.listingId,
    },
  });
}

export interface ReminderContext {
  readonly subscriptionId: string;
  readonly listingName: string;
  readonly listingPath: string;
  readonly email: string | null;
  readonly tier: TierName;
  readonly interval: Interval;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly status: string;
}

/**
 * Re-read when the queued reminder actually runs, rather than copied into the
 * job payload. A subscription cancelled between the tick that queued the email
 * and the tick that sends it must not still be reminded to renew.
 */
export async function reminderContext(
  tx: TestDb,
  viewer: Viewer,
  subscriptionId: string,
): Promise<ReminderContext | null> {
  assertWorker(viewer);
  if (!UUID.test(subscriptionId)) return null;
  const [row] = await tx
    .select({
      subscriptionId: subscriptions.id,
      listingName: listings.name,
      listingSlug: listings.slug,
      citySlug: cities.slug,
      email: PAYER_EMAIL,
      tier: subscriptions.tier,
      interval: subscriptions.interval,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      status: subscriptions.status,
    })
    .from(subscriptions)
    .innerJoin(listings, eq(listings.id, subscriptions.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .leftJoin(profiles, eq(profiles.id, subscriptions.userId))
    .leftJoin(user, eq(user.id, profiles.userId))
    .where(eq(subscriptions.id, subscriptionId))
    .limit(1);
  if (!row) return null;
  return {
    subscriptionId: row.subscriptionId,
    listingName: row.listingName,
    listingPath: `/${row.citySlug}/${row.listingSlug}`,
    email: row.email,
    tier: row.tier,
    interval: row.interval,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    status: row.status,
  };
}

export interface StaleSubscription {
  readonly id: string;
  readonly listingId: string;
  readonly providerSubscriptionId: string;
  readonly currentPeriodEnd: Date | null;
}

/**
 * Rows whose paid period ran out more than `graceDays` ago and that still have
 * something to lose or restore. Either a renewal webhook never arrived or the
 * subscription really has gone; only PayPal can say which, which is what the
 * sync job asks.
 *
 * Two kinds of row qualify:
 *   - `active` / `past_due`: the row says paid, the date says not. The usual
 *     case — a missed renewal, or a real lapse.
 *   - `cancelled` / `suspended` whose LISTING still carries a paid tier: a
 *     mid-period cancellation keeps the tier until the period ends, and this
 *     query is how the sync job finds it on the day to perform the lapse.
 *
 * A cancelled row whose listing is already free is done. Without the listing
 * join it would be selected every hour for ever — one PayPal call and one
 * audit row per tick, and with the batch ordered by period end the oldest dead
 * rows would crowd out the stale active ones the job exists for.
 */
export async function staleSubscriptionsForSync(
  tx: TestDb,
  viewer: Viewer,
  input: { graceDays: number; limit?: number },
): Promise<StaleSubscription[]> {
  assertWorker(viewer);
  const cutoff = new Date(now().getTime() - input.graceDays * DAY_MS);
  const rows = await tx
    .select({
      id: subscriptions.id,
      listingId: subscriptions.listingId,
      providerSubscriptionId: subscriptions.providerSubscriptionId,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
    })
    .from(subscriptions)
    .innerJoin(listings, eq(listings.id, subscriptions.listingId))
    .where(
      and(
        or(
          inArray(subscriptions.status, ["active", "past_due"]),
          and(
            inArray(subscriptions.status, ["cancelled", "suspended"]),
            ne(listings.tier, "free"),
          ),
        ),
        isNotNull(subscriptions.providerSubscriptionId),
        isNotNull(subscriptions.currentPeriodEnd),
        lte(subscriptions.currentPeriodEnd, cutoff),
      ),
    )
    .orderBy(asc(subscriptions.currentPeriodEnd))
    .limit(input.limit ?? 50);

  return rows.map((r) => ({
    id: r.id,
    listingId: r.listingId,
    providerSubscriptionId: r.providerSubscriptionId!,
    currentPeriodEnd: r.currentPeriodEnd,
  }));
}

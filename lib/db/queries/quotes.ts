import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { siteConfig } from "@/config/site.config";
import type { TierName } from "@/config/types";
import {
  categories, cities, listings, profiles, quoteRecipients, quoteRequests, user,
} from "@/lib/db/schema";
import { publishedListings } from "@/lib/db/queries/listings";
import { listingRankOrder } from "@/lib/db/sort";
import { now } from "@/lib/clock";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";
import { recordStat } from "@/lib/stats/counters";
import { writeAudit } from "./audit";
import { ownedByViewer } from "./owner";

/**
 * The quote broadcast (feature flag `quoteBroadcast`).
 *
 * One visitor describes a job once and it goes to up to
 * `siteConfig.quotes.maxRecipients` published listings in that town and
 * category, best-ranked first. The recipients are chosen HERE, at write time,
 * and stored: the email the worker sends later and the leads page an owner
 * opens next week must both name the same businesses, and a ranking re-run
 * at either point would not.
 *
 * The contact details are the product. A free listing is told a request
 * arrived and nothing more — the upgrade is what reveals the job and the
 * requester. `quoteContactVisible` is the one place that rule is written, and
 * the leads page applies it to the listing's CURRENT tier, so upgrading
 * reveals the requests that were already waiting rather than only new ones.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Which tiers see the job text and the requester's contact details. */
export function quoteContactVisible(tier: TierName): boolean {
  return tier !== "free";
}

function assertSignedIn(viewer: Viewer): asserts viewer is Exclude<Viewer, { role: "public" }> {
  if (viewer.role === "public") throw new Error("FORBIDDEN");
}

function assertAdmin(viewer: Viewer): void {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
}

/**
 * Where a quote request is delivered, following the enquiry rule: a claimed
 * listing is written to at the account that claimed it, an unclaimed one at
 * the address we hold for it. Null when there is nowhere to send.
 */
const deliveryAddress = (): SQL<string | null> => sql<string | null>`
  case
    when ${listings.claimStatus} <> 'unclaimed' and nullif(trim(${user.email}), '') is not null
      then trim(${user.email})
    else nullif(trim(${listings.email}), '')
  end`;

const normalised = (address: SQL<string | null>): SQL<string | null> =>
  sql<string | null>`lower(${address})`;

const unsubscribed = (address: SQL<string | null>): SQL<boolean> => sql<boolean>`exists (
  select 1 from unsubscribes u where u.address_normalised = ${normalised(address)}
)`;

export interface QuoteCandidate {
  listingId: string;
  tier: TierName;
  /** Resolved delivery address; never null for a candidate. */
  email: string;
}

/**
 * The listings one request goes to.
 *
 * Published, in the town and category asked for, with somewhere to send it
 * and no unsubscribe on that address — ranked by the one ranking expression
 * the pillar pages use, so a paid or verified listing is chosen first, and
 * deduplicated by address so a business with two listings hears once. The
 * dedupe is done here rather than in SQL because the ranking is an ORDER BY
 * of four expressions, and the candidate pool is small.
 */
export async function selectQuoteRecipients(
  tx: TestDb,
  viewer: Viewer,
  opts: { cityId: string; categoryId: string; limit: number },
): Promise<QuoteCandidate[]> {
  const limit = Math.max(0, Math.trunc(opts.limit));
  if (limit === 0 || !UUID.test(opts.cityId) || !UUID.test(opts.categoryId)) return [];

  const address = deliveryAddress();
  const rows = await tx
    .select({ listingId: listings.id, tier: listings.tier, email: address })
    .from(listings)
    .leftJoin(profiles, eq(profiles.id, listings.ownerId))
    .leftJoin(user, eq(user.id, profiles.userId))
    .where(and(
      publishedListings(viewer),
      eq(listings.cityId, opts.cityId),
      eq(listings.primaryCategoryId, opts.categoryId),
      sql`${address} is not null`,
      sql`not ${unsubscribed(address)}`,
    ))
    .orderBy(...listingRankOrder(siteConfig.timezone))
    // Room to dedupe by address and still fill the cap.
    .limit(limit * 4);

  const seen = new Set<string>();
  const chosen: QuoteCandidate[] = [];
  for (const row of rows) {
    if (row.email === null) continue;
    const key = row.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    chosen.push({ listingId: row.listingId, tier: row.tier, email: row.email });
    if (chosen.length === limit) break;
  }
  return chosen;
}

export interface QuoteRequestInput {
  cityId: string;
  categoryId: string;
  name: string;
  email: string;
  phone: string | null;
  message: string;
  /** Null when no proxy header identified the sender. Never a placeholder. */
  ip: string | null;
}

export type QuoteRequestResult =
  | { outcome: "created"; quoteRequestId: string; recipientCount: number }
  | { outcome: "unknown-city" }
  | { outcome: "unknown-category" }
  /** Nothing published in that town and category has an address. Nothing was written. */
  | { outcome: "no-recipients" };

/**
 * The write. Caller supplies the transaction so the request, its recipients,
 * the audit row and the queued notification land together.
 *
 * A request nobody can receive is refused rather than stored: telling the
 * visitor it was "sent to 0 businesses" is a lie, and a row with no
 * recipients is a row no page would ever show.
 */
export async function createQuoteRequest(
  tx: TestDb,
  viewer: Viewer,
  input: QuoteRequestInput,
  opts: { maxRecipients?: number } = {},
): Promise<QuoteRequestResult> {
  if (!UUID.test(input.cityId)) return { outcome: "unknown-city" };
  if (!UUID.test(input.categoryId)) return { outcome: "unknown-category" };

  const [city] = await tx
    .select({ id: cities.id })
    .from(cities)
    .where(and(eq(cities.id, input.cityId), eq(cities.isPublished, true)))
    .limit(1);
  if (!city) return { outcome: "unknown-city" };

  const [category] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, input.categoryId), eq(categories.isActive, true)))
    .limit(1);
  if (!category) return { outcome: "unknown-category" };

  const recipients = await selectQuoteRecipients(tx, viewer, {
    cityId: input.cityId,
    categoryId: input.categoryId,
    limit: opts.maxRecipients ?? siteConfig.quotes.maxRecipients,
  });
  if (recipients.length === 0) return { outcome: "no-recipients" };

  const at = now();
  const [row] = await tx
    .insert(quoteRequests)
    .values({
      name: input.name,
      email: input.email,
      phone: input.phone,
      message: input.message,
      cityId: input.cityId,
      categoryId: input.categoryId,
      ip: input.ip,
      consentAt: at,
    })
    .returning({ id: quoteRequests.id });
  const quoteRequestId = row!.id;

  await tx.insert(quoteRecipients).values(
    recipients.map((r) => ({
      quoteRequestId,
      listingId: r.listingId,
      // What the EMAIL carried. The leads page reads the current tier instead.
      contactMasked: !quoteContactVisible(r.tier),
    })),
  );

  // The owner ROI counter, one per listing chosen. Redis, never a row here;
  // the worker folds it into listing_stats_daily. Never throws.
  for (const r of recipients) await recordStat(r.listingId, "quote_request", at);

  // A public write with a fan-out: the audit row is the record of where it
  // came from and how far it went. The actor is null — nobody is signed in.
  await writeAudit(tx, viewer, {
    action: "quote.requested",
    entityType: "quote_request",
    entityId: quoteRequestId,
    meta: {
      cityId: input.cityId,
      categoryId: input.categoryId,
      recipients: recipients.map((r) => r.listingId),
    },
    ip: input.ip,
  });

  return { outcome: "created", quoteRequestId, recipientCount: recipients.length };
}

export interface QuoteNotificationRecipient {
  listingId: string;
  listingName: string;
  /** Site-relative path to the public page. */
  path: string;
  /** Resolved as `selectQuoteRecipients` resolves it. Null when it has since gone. */
  email: string | null;
  /** True when the address has unsubscribed — possibly since the request was written. */
  unsubscribed: boolean;
  /** Whether this recipient's email carries the job and the contact details. */
  contactVisible: boolean;
}

export interface QuoteNotification {
  requester: { name: string; email: string; phone: string | null };
  message: string;
  cityName: string;
  categoryName: string;
  recipients: QuoteNotificationRecipient[];
}

/**
 * What the worker needs to send one request. Worker-only: it reads the
 * requester's address and the recipients' delivery addresses.
 *
 * Re-resolves each address at send time rather than trusting anything
 * stored, so a listing claimed between the request and the tick is written
 * to at the account that now holds it, and an unsubscribe in between is
 * honoured.
 */
export async function quoteNotification(
  tx: TestDb,
  viewer: Viewer,
  quoteRequestId: string,
): Promise<QuoteNotification | null> {
  assertAdmin(viewer);
  if (!UUID.test(quoteRequestId)) return null;

  const [request] = await tx
    .select({
      name: quoteRequests.name,
      email: quoteRequests.email,
      phone: quoteRequests.phone,
      message: quoteRequests.message,
      isSpam: quoteRequests.isSpam,
      cityName: cities.name,
      categoryName: categories.name,
    })
    .from(quoteRequests)
    .innerJoin(cities, eq(cities.id, quoteRequests.cityId))
    .innerJoin(categories, eq(categories.id, quoteRequests.categoryId))
    .where(eq(quoteRequests.id, quoteRequestId))
    .limit(1);
  if (!request) return null;
  // A request an admin has flagged before the tick ran is not sent. Same
  // shape as an unnotifiable enquiry: null, and the job completes.
  if (request.isSpam || request.email === null || request.message === null) return null;

  const address = deliveryAddress();
  const rows = await tx
    .select({
      listingId: listings.id,
      listingName: listings.name,
      listingSlug: listings.slug,
      citySlug: cities.slug,
      tier: listings.tier,
      email: address,
      unsubscribed: unsubscribed(address),
    })
    .from(quoteRecipients)
    .innerJoin(listings, eq(listings.id, quoteRecipients.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .leftJoin(profiles, eq(profiles.id, listings.ownerId))
    .leftJoin(user, eq(user.id, profiles.userId))
    .where(eq(quoteRecipients.quoteRequestId, quoteRequestId))
    .orderBy(quoteRecipients.createdAt, listings.name);

  return {
    requester: { name: request.name ?? request.email, email: request.email, phone: request.phone },
    message: request.message,
    cityName: request.cityName,
    categoryName: request.categoryName,
    recipients: rows.map((r) => ({
      listingId: r.listingId,
      listingName: r.listingName,
      path: `/${r.citySlug}/${r.listingSlug}`,
      email: r.email,
      unsubscribed: r.unsubscribed,
      contactVisible: quoteContactVisible(r.tier),
    })),
  };
}

export type QuoteOutcome = "open" | "won" | "lost";

export interface OwnerQuoteLead {
  /** The recipient row — what the owner marks won or lost. */
  id: string;
  createdAt: Date;
  cityName: string;
  categoryName: string;
  outcome: QuoteOutcome;
  outcomeAt: Date | null;
  /** False on the free tier: `job` and `requester` are then null. */
  contactVisible: boolean;
  job: string | null;
  requester: { name: string | null; email: string; phone: string | null } | null;
}

/**
 * One listing's quote requests, for its owner. Newest first.
 *
 * Visibility is decided from the listing's tier NOW, not from
 * `contact_masked`: that column records what the email said, and an owner
 * who upgrades this morning is owed the requests that arrived last week.
 * Projected column by column — the row also holds the requester's IP.
 */
export async function ownerQuoteLeads(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
): Promise<OwnerQuoteLead[]> {
  assertSignedIn(viewer);
  if (!UUID.test(listingId)) return [];

  const rows = await tx
    .select({
      id: quoteRecipients.id,
      createdAt: quoteRecipients.createdAt,
      outcome: quoteRecipients.outcome,
      outcomeAt: quoteRecipients.outcomeAt,
      tier: listings.tier,
      name: quoteRequests.name,
      email: quoteRequests.email,
      phone: quoteRequests.phone,
      message: quoteRequests.message,
      cityName: cities.name,
      categoryName: categories.name,
    })
    .from(quoteRecipients)
    .innerJoin(quoteRequests, eq(quoteRequests.id, quoteRecipients.quoteRequestId))
    .innerJoin(listings, eq(listings.id, quoteRecipients.listingId))
    .innerJoin(cities, eq(cities.id, quoteRequests.cityId))
    .innerJoin(categories, eq(categories.id, quoteRequests.categoryId))
    .where(and(
      eq(quoteRecipients.listingId, listingId),
      eq(quoteRequests.isSpam, false),
      ownedByViewer(viewer),
    ))
    .orderBy(desc(quoteRecipients.createdAt));

  return rows.map((r) => {
    const contactVisible = quoteContactVisible(r.tier) && r.email !== null;
    return {
      id: r.id,
      createdAt: r.createdAt,
      cityName: r.cityName,
      categoryName: r.categoryName,
      outcome: r.outcome,
      outcomeAt: r.outcomeAt,
      contactVisible,
      job: contactVisible ? r.message : null,
      requester: contactVisible && r.email !== null
        ? { name: r.name, email: r.email, phone: r.phone }
        : null,
    };
  });
}

/**
 * The owner's verdict on one lead. Returns whether anything changed, so the
 * caller can tell "not yours" from "done" without a second query.
 *
 * Only a listing that can SEE the lead may judge it: a free-tier owner marking
 * a request they were never shown as lost would be recording a guess.
 */
export async function markQuoteOutcome(
  tx: TestDb,
  viewer: Viewer,
  recipientId: string,
  outcome: Exclude<QuoteOutcome, "open">,
  /** The request address, for the audit row. `null` only off a request. */
  ip: string | null,
): Promise<boolean> {
  assertSignedIn(viewer);
  if (!UUID.test(recipientId)) return false;

  const at = now();
  const owned = sql`exists (
    select 1 from ${listings}
    where ${listings.id} = ${quoteRecipients.listingId}
      and ${listings.tier} <> 'free'
      and ${ownedByViewer(viewer)}
  )`;

  const updated = await tx
    .update(quoteRecipients)
    .set({ outcome, outcomeAt: at, updatedAt: at })
    .where(and(
      eq(quoteRecipients.id, recipientId),
      sql`${quoteRecipients.outcome} <> ${outcome}`,
      owned,
    ))
    .returning({ id: quoteRecipients.id });
  if (updated.length === 0) return false;

  // Global constraint 22: an owner mutation writes its audit row. Won/lost is
  // the honest conversion figure the broadcast is later judged by.
  await writeAudit(tx, viewer, {
    action: outcome === "won" ? "quote.marked_won" : "quote.marked_lost",
    entityType: "quote_recipient",
    entityId: recipientId,
    meta: null,
    ip,
  });
  return true;
}

export interface AdminQuoteRequest {
  id: string;
  createdAt: Date;
  name: string | null;
  email: string | null;
  phone: string | null;
  message: string | null;
  cityName: string;
  categoryName: string;
  recipientCount: number;
  wonCount: number;
  isSpam: boolean;
}

/** The console's read-only list, newest first. The IP stays in the row. */
export async function listQuoteRequests(
  tx: TestDb,
  viewer: Viewer,
  opts: { limit?: number } = {},
): Promise<AdminQuoteRequest[]> {
  assertAdmin(viewer);
  const limit = Math.min(500, Math.max(1, Math.trunc(opts.limit ?? 100)));

  return tx
    .select({
      id: quoteRequests.id,
      createdAt: quoteRequests.createdAt,
      name: quoteRequests.name,
      email: quoteRequests.email,
      phone: quoteRequests.phone,
      message: quoteRequests.message,
      cityName: cities.name,
      categoryName: categories.name,
      recipientCount: sql<number>`(
        select count(*)::int from ${quoteRecipients}
        where ${quoteRecipients.quoteRequestId} = ${quoteRequests.id}
      )`,
      wonCount: sql<number>`(
        select count(*)::int from ${quoteRecipients}
        where ${quoteRecipients.quoteRequestId} = ${quoteRequests.id}
          and ${quoteRecipients.outcome} = 'won'
      )`,
      isSpam: quoteRequests.isSpam,
    })
    .from(quoteRequests)
    .innerJoin(cities, eq(cities.id, quoteRequests.cityId))
    .innerJoin(categories, eq(categories.id, quoteRequests.categoryId))
    .orderBy(desc(quoteRequests.createdAt))
    .limit(limit);
}

/**
 * The admin's one write. A flagged request drops off every owner's leads
 * page and is not sent if the worker has not reached it yet; the row itself
 * stays, because the flag is a judgement and judgements get reversed.
 */
export async function flagQuoteRequestSpam(
  tx: TestDb,
  viewer: Viewer,
  quoteRequestId: string,
  isSpam: boolean,
  ip: string | null,
): Promise<boolean> {
  assertAdmin(viewer);
  if (!UUID.test(quoteRequestId)) return false;

  const updated = await tx
    .update(quoteRequests)
    .set({ isSpam, updatedAt: now() })
    .where(and(eq(quoteRequests.id, quoteRequestId), eq(quoteRequests.isSpam, !isSpam)))
    .returning({ id: quoteRequests.id });
  if (updated.length === 0) return false;

  await writeAudit(tx, viewer, {
    action: isSpam ? "quote.flagged_spam" : "quote.unflagged_spam",
    entityType: "quote_request",
    entityId: quoteRequestId,
    meta: null,
    ip,
  });
  return true;
}

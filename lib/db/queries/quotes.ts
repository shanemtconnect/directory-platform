import { randomBytes } from "node:crypto";
import { and, desc, eq, lte, sql, type SQL } from "drizzle-orm";
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
import { hashToken } from "@/lib/security/token-hash";
import { QUOTE_VERIFY_TTL_HOURS } from "@/lib/quotes/verify-ttl";
import { checkLeadRules, type LeadRejection } from "@/lib/leads/rules";
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

/** Re-exported: the verify route, the worker and the tests read it from here. */
export { QUOTE_VERIFY_TTL_HOURS };

export type QuoteRequestResult =
  /**
   * `token` is the raw verification token: 32 random bytes, base64url. It
   * exists here and in the verification job's payload, and nowhere else —
   * the row holds its SHA-256.
   */
  | { outcome: "created"; quoteRequestId: string; recipientCount: number; token: string }
  | { outcome: "unknown-city" }
  | { outcome: "unknown-category" }
  /** Nothing published in that town and category has an address. Nothing was written. */
  | { outcome: "no-recipients" }
  /**
   * Lead marketplace on, nobody local can receive it — so its only
   * destination is a lead — and the lead rules refuse it (D11). Nothing was
   * written; the requester is told why now, not after a click that would
   * have gone nowhere.
   */
  | { outcome: "lead-refused"; reason: LeadRejection };

/**
 * The write. Caller supplies the transaction so the request, its recipients,
 * the audit row and the queued verification email land together.
 *
 * The request is written PENDING (Task 56): recipients are chosen now, so
 * the businesses a requester is told about are the ones that get it, but
 * nobody is emailed and nothing appears on a leads page until the
 * requester clicks the link (`verifyQuoteToken`).
 *
 * A request nobody can receive is refused rather than stored: telling the
 * visitor it was "sent to 0 businesses" is a lie, and a row with no
 * recipients is a row no page would ever show. The exception is the lead
 * marketplace (`allowNoRecipients`), where such a request becomes a lead on
 * the click — and a capture box (`source: "capture"`), which is never
 * broadcast at all.
 */
export async function createQuoteRequest(
  tx: TestDb,
  viewer: Viewer,
  input: QuoteRequestInput,
  opts: { maxRecipients?: number; allowNoRecipients?: boolean; source?: "quote" | "capture" } = {},
): Promise<QuoteRequestResult> {
  const source = opts.source ?? "quote";
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

  const recipients = source === "capture"
    ? []
    : await selectQuoteRecipients(tx, viewer, {
      cityId: input.cityId,
      categoryId: input.categoryId,
      limit: opts.maxRecipients ?? siteConfig.quotes.maxRecipients,
    });
  if (recipients.length === 0 && source === "quote") {
    if (opts.allowNoRecipients !== true) return { outcome: "no-recipients" };
    // Kept only if it can become a lead: a phone the rules accept (the form's
    // phone is optional, a lead's is not), no throwaway inbox, no blocklist,
    // no duplicate. Checked again at the click; this is where the requester
    // can still be told.
    const verdict = await checkLeadRules(tx, {
      email: input.email, phone: input.phone, country: siteConfig.country,
    });
    if (verdict !== "ok") return { outcome: "lead-refused", reason: verdict.reason };
  }

  const at = now();
  const { token, ...verify } = mintVerifyLink(at);
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
      status: "pending",
      source,
      ...verify,
    })
    .returning({ id: quoteRequests.id });
  const quoteRequestId = row!.id;

  if (recipients.length > 0) {
    await tx.insert(quoteRecipients).values(
      recipients.map((r) => ({
        quoteRequestId,
        listingId: r.listingId,
        // What the EMAIL carried. The leads page reads the current tier instead.
        contactMasked: !quoteContactVisible(r.tier),
      })),
    );
  }

  // A public write with a fan-out: the audit row is the record of where it
  // came from and how far it went. The actor is null — nobody is signed in.
  await writeAudit(tx, viewer, {
    action: "quote.requested",
    entityType: "quote_request",
    entityId: quoteRequestId,
    meta: {
      cityId: input.cityId,
      categoryId: input.categoryId,
      source,
      recipients: recipients.map((r) => r.listingId),
    },
    ip: input.ip,
  });

  return { outcome: "created", quoteRequestId, recipientCount: recipients.length, token };
}

/**
 * A verification link: 32 random bytes, base64url, for the email; its
 * SHA-256 and a 48-hour expiry for the row. The raw token is returned once
 * and never stored.
 */
function mintVerifyLink(at: Date): { token: string; verifyTokenHash: string; verifyExpiresAt: Date } {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    verifyTokenHash: hashToken(token),
    verifyExpiresAt: new Date(at.getTime() + QUOTE_VERIFY_TTL_HOURS * 3_600_000),
  };
}

export interface EnquiryLeadRequestInput {
  listingId: string;
  cityId: string;
  categoryId: string | null;
  name: string;
  email: string;
  phone: string | null;
  message: string;
  ip: string | null;
}

/**
 * The verification link for an enquiry that will become a lead (D5, D6).
 *
 * An enquiry to an unclaimed listing with no address reaches nobody, so
 * with the lead marketplace on it is offered as a lead — but only once the
 * enquirer confirms, like every other lead. This row is the pending
 * confirmation: source `enquiry`, the target listing, the enquirer's
 * details, no recipients. The enquiry row itself (lib/db/queries/enquiries)
 * is written exactly as before; the caller queues `notifyQuoteVerify`.
 */
export async function createEnquiryLeadRequest(
  tx: TestDb,
  viewer: Viewer,
  input: EnquiryLeadRequestInput,
): Promise<Extract<QuoteRequestResult, { outcome: "created" }>> {
  const at = now();
  const { token, ...verify } = mintVerifyLink(at);
  const [row] = await tx
    .insert(quoteRequests)
    .values({
      name: input.name,
      email: input.email,
      phone: input.phone,
      message: input.message,
      cityId: input.cityId,
      categoryId: input.categoryId,
      listingId: input.listingId,
      ip: input.ip,
      consentAt: at,
      status: "pending",
      source: "enquiry",
      ...verify,
    })
    .returning({ id: quoteRequests.id });

  await writeAudit(tx, viewer, {
    action: "quote.requested",
    entityType: "quote_request",
    entityId: row!.id,
    meta: { source: "enquiry", listingId: input.listingId, recipients: [] },
    ip: input.ip,
  });
  return { outcome: "created", quoteRequestId: row!.id, recipientCount: 0, token };
}

export type QuoteVerifyResult =
  | {
    outcome: "verified";
    quoteRequestId: string;
    source: "quote" | "capture" | "enquiry";
    /** How many listings the request is now delivered to. */
    recipientCount: number;
  }
  /** The link was used before. Nothing changed. */
  | { outcome: "already-verified"; quoteRequestId: string }
  /** Older than `QUOTE_VERIFY_TTL_HOURS`, or swept by the worker. */
  | { outcome: "expired" }
  /** No such link, or a request an admin has flagged. */
  | { outcome: "unknown" };

/** A base64url token is 43 characters; anything far longer is not ours. */
const MAX_TOKEN_CHARS = 128;

/** The digest lookup both the preview and the click start from. */
async function rowForToken(tx: TestDb, raw: string) {
  if (raw === "" || raw.length > MAX_TOKEN_CHARS) return null;
  const [row] = await tx
    .select({
      id: quoteRequests.id,
      status: quoteRequests.status,
      source: quoteRequests.source,
      isSpam: quoteRequests.isSpam,
      expiresAt: quoteRequests.verifyExpiresAt,
    })
    .from(quoteRequests)
    .where(eq(quoteRequests.verifyTokenHash, hashToken(raw)))
    .limit(1);
  if (!row || row.isSpam || row.status === "spam") return null;
  return row;
}

export type QuoteTokenPreview =
  | { outcome: "live"; source: "quote" | "capture" | "enquiry" }
  | { outcome: "already-verified" }
  | { outcome: "expired" }
  | { outcome: "unknown" };

/**
 * What the landing page (`/get-quotes/verify/<token>`) shows, WITHOUT
 * spending the link. The page is a GET, and mail scanners, link rewriters
 * and previewers GET every link in a message; only the POST behind the
 * page's button (`verifyQuoteToken`) confirms anything. Writes nothing — an
 * expired link is reported, and the sweep or the POST marks it.
 */
export async function previewQuoteToken(
  tx: TestDb,
  _viewer: Viewer,
  raw: string,
): Promise<QuoteTokenPreview> {
  const row = await rowForToken(tx, raw);
  if (!row) return { outcome: "unknown" };
  if (row.status === "verified") return { outcome: "already-verified" };
  if (row.status === "expired") return { outcome: "expired" };
  if (row.expiresAt === null || row.expiresAt.getTime() <= now().getTime()) return { outcome: "expired" };
  return { outcome: "live", source: row.source };
}

/**
 * The click. Single use: the pending → verified step is one conditional
 * UPDATE, so two clicks racing each other verify once, and the loser is told
 * "already verified". The digest is kept on the row so a later click is
 * recognised rather than reported as a link we have never seen.
 *
 * Verification is where the request starts to count: the owner ROI counter
 * is bumped here, one per recipient, not at submit — an unconfirmed request
 * reached nobody. The caller enqueues the delivery (`notifyQuoteRequest`)
 * and creates any lead, in the same transaction.
 */
export async function verifyQuoteToken(
  tx: TestDb,
  viewer: Viewer,
  raw: string,
): Promise<QuoteVerifyResult> {
  const row = await rowForToken(tx, raw);
  if (!row) return { outcome: "unknown" };
  if (row.status === "verified") return { outcome: "already-verified", quoteRequestId: row.id };
  if (row.status === "expired") return { outcome: "expired" };

  const at = now();
  if (row.expiresAt === null || row.expiresAt.getTime() <= at.getTime()) {
    await tx
      .update(quoteRequests)
      .set({ status: "expired", updatedAt: at })
      .where(and(eq(quoteRequests.id, row.id), eq(quoteRequests.status, "pending")));
    return { outcome: "expired" };
  }

  const updated = await tx
    .update(quoteRequests)
    .set({ status: "verified", verifiedAt: at, updatedAt: at })
    .where(and(eq(quoteRequests.id, row.id), eq(quoteRequests.status, "pending")))
    .returning({ id: quoteRequests.id });
  if (updated.length === 0) return { outcome: "already-verified", quoteRequestId: row.id };

  const recipients = await tx
    .select({ listingId: quoteRecipients.listingId })
    .from(quoteRecipients)
    .where(eq(quoteRecipients.quoteRequestId, row.id));
  // The owner ROI counter, one per listing chosen. Redis, never a row here;
  // the worker folds it into listing_stats_daily. Never throws.
  for (const r of recipients) await recordStat(r.listingId, "quote_request", at);

  await writeAudit(tx, viewer, {
    action: "quote.verified",
    entityType: "quote_request",
    entityId: row.id,
    meta: { recipients: recipients.length },
  });

  return {
    outcome: "verified",
    quoteRequestId: row.id,
    source: row.source,
    recipientCount: recipients.length,
  };
}

export interface QuoteVerification {
  name: string | null;
  email: string;
  cityName: string;
  /** Null for an enquiry to a listing with no primary category. */
  categoryName: string | null;
  /** The enquiry's target listing, for `source = 'enquiry'`. */
  listingName: string | null;
  status: "pending" | "verified" | "expired" | "spam";
  source: "quote" | "capture" | "enquiry";
  /** The digest of the live link; the job's token must hash to it. */
  tokenHash: string | null;
  expiresAt: Date | null;
}

/** What the worker needs for the verification email. Worker-only. */
export async function quoteVerification(
  tx: TestDb,
  viewer: Viewer,
  quoteRequestId: string,
): Promise<QuoteVerification | null> {
  assertAdmin(viewer);
  if (!UUID.test(quoteRequestId)) return null;

  const [row] = await tx
    .select({
      name: quoteRequests.name,
      email: quoteRequests.email,
      cityName: cities.name,
      categoryName: categories.name,
      listingName: listings.name,
      status: quoteRequests.status,
      source: quoteRequests.source,
      tokenHash: quoteRequests.verifyTokenHash,
      expiresAt: quoteRequests.verifyExpiresAt,
    })
    .from(quoteRequests)
    .innerJoin(cities, eq(cities.id, quoteRequests.cityId))
    .leftJoin(categories, eq(categories.id, quoteRequests.categoryId))
    .leftJoin(listings, eq(listings.id, quoteRequests.listingId))
    .where(eq(quoteRequests.id, quoteRequestId))
    .limit(1);
  if (!row || row.email === null) return null;
  return { ...row, email: row.email };
}

/**
 * The worker's hourly sweep: every pending request whose link has lapsed is
 * marked expired, so it drops out of the admin's "unconfirmed" count and a
 * late click is told the link has expired. Returns how many it expired.
 */
export async function expireQuoteRequests(tx: TestDb, viewer: Viewer): Promise<number> {
  assertAdmin(viewer);
  const at = now();
  const rows = await tx
    .update(quoteRequests)
    .set({ status: "expired", updatedAt: at })
    .where(and(eq(quoteRequests.status, "pending"), lte(quoteRequests.verifyExpiresAt, at)))
    .returning({ id: quoteRequests.id });
  return rows.length;
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
      status: quoteRequests.status,
      cityName: cities.name,
      categoryName: categories.name,
    })
    .from(quoteRequests)
    .innerJoin(cities, eq(cities.id, quoteRequests.cityId))
    .innerJoin(categories, eq(categories.id, quoteRequests.categoryId))
    .where(eq(quoteRequests.id, quoteRequestId))
    .limit(1);
  if (!request) return null;
  // Only a request its sender has confirmed is delivered (D6). The job is
  // enqueued by the click, so this only bites on a hand-queued job — which
  // is exactly when it must.
  if (request.status !== "verified") return null;
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
      // Unconfirmed requests reached nobody, and are not on anybody's page.
      eq(quoteRequests.status, "verified"),
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
  /** `pending` until the requester clicks; `expired` if they never did. */
  status: "pending" | "verified" | "expired" | "spam";
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
      status: quoteRequests.status,
    })
    .from(quoteRequests)
    .innerJoin(cities, eq(cities.id, quoteRequests.cityId))
    .innerJoin(categories, eq(categories.id, quoteRequests.categoryId))
    // An `enquiry` row is an enquirer's verification link, not a quote
    // request; the enquiry itself is on the listing's enquiries.
    .where(sql`${quoteRequests.source} <> 'enquiry'`)
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

import { and, eq, sql } from "drizzle-orm";
import { categories, cities, listings, slugs } from "@/lib/db/schema";
import { recomputeCityIndexability } from "@/lib/db/queries/indexing";
import { writeAudit } from "@/lib/db/queries/audit";
import { notifyDecision } from "@/lib/email/notify";
import { now } from "@/lib/clock";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { ListingStatus } from "@/lib/db/queries/submissions";
import type { TestDb } from "@/test/db";

/**
 * The moderation queue: reading it, and the two decisions that empty it.
 *
 * A submission is a `listings` row in `status: 'pending'` (see
 * lib/db/queries/submissions.ts), so approval is a status change rather than a
 * copy step. Everything here is admin-only and throws rather than returning an
 * empty list for anybody else: an unpublished row's contents and a submitter's
 * address are not "nothing to see", and a silent empty page is how a broken
 * gate goes unnoticed.
 *
 * Each decision does four things — status, gate, audit, notification — and the
 * caller supplies ONE handle so they land together. A published listing with no
 * audit row, or a submitter emailed about an approval that rolled back, are
 * both worse than the decision not happening at all.
 */

export const SUBMISSIONS_PER_PAGE = 25;

function assertAdmin(viewer: Viewer): void {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
}

/** What `createSubmission` stored in `custom_fields.submission`. */
interface StoredSubmission {
  submitterName?: unknown;
  submitterEmail?: unknown;
  requestedTier?: unknown;
  submittedCity?: unknown;
  submittedRegion?: unknown;
  submittedAt?: unknown;
}

function stored(customFields: unknown): StoredSubmission {
  const fields = customFields as { submission?: StoredSubmission } | null;
  return fields?.submission ?? {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export interface PendingSubmission {
  id: string;
  name: string;
  cityName: string;
  categoryName: string;
  /** Who to write back to. Null on rows that arrived any other way. */
  submitterEmail: string | null;
  /** What they ASKED for. The row itself is always on `free` until paid. */
  requestedTier: string | null;
  createdAt: Date;
}

export interface SubmissionQueue {
  rows: PendingSubmission[];
  total: number;
  page: number;
  pageCount: number;
}

/**
 * Oldest first. A moderation queue is a queue: the submission that has been
 * waiting longest is the one that is costing us a submitter's patience.
 */
export async function pendingSubmissions(
  tx: TestDb,
  viewer: Viewer,
  page: number,
): Promise<SubmissionQueue> {
  assertAdmin(viewer);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(listings)
    .where(eq(listings.status, "pending"));
  const total = counted?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / SUBMISSIONS_PER_PAGE));
  const current = Math.min(Math.max(1, Math.trunc(page)), pageCount);

  const rows = await tx
    .select({
      id: listings.id,
      name: listings.name,
      cityName: cities.name,
      categoryName: categories.name,
      submittedByEmail: listings.submittedByEmail,
      customFields: listings.customFields,
      createdAt: listings.createdAt,
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .innerJoin(categories, eq(categories.id, listings.primaryCategoryId))
    .where(eq(listings.status, "pending"))
    .orderBy(listings.createdAt, listings.id)
    .limit(SUBMISSIONS_PER_PAGE)
    .offset((current - 1) * SUBMISSIONS_PER_PAGE);

  return {
    rows: rows.map((row) => {
      const submission = stored(row.customFields);
      return {
        id: row.id,
        name: row.name,
        cityName: row.cityName,
        categoryName: row.categoryName,
        submitterEmail: row.submittedByEmail ?? str(submission.submitterEmail),
        requestedTier: str(submission.requestedTier),
        createdAt: row.createdAt,
      };
    }),
    total,
    page: current,
    pageCount,
  };
}

export interface SubmissionDetail extends PendingSubmission {
  status: ListingStatus;
  citySlug: string;
  slug: string;
  /** The category's per-city routing slug — `/${citySlug}/${categorySlug}` is its pillar page. */
  categorySlug: string | null;
  addressLine1: string | null;
  postcode: string | null;
  phone: string | null;
  website: string | null;
  description: string | null;
  rejectedReason: string | null;
  submitterName: string | null;
  /** The town and county as TYPED, which may not match the city it resolved to. */
  submittedCity: string | null;
  submittedRegion: string | null;
}

export async function submissionDetail(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
): Promise<SubmissionDetail | null> {
  assertAdmin(viewer);

  const [row] = await tx
    .select({
      id: listings.id,
      name: listings.name,
      slug: listings.slug,
      status: listings.status,
      cityName: cities.name,
      citySlug: cities.slug,
      categoryName: categories.name,
      categorySlug: slugs.slug,
      addressLine1: listings.addressLine1,
      postcode: listings.postcode,
      phone: listings.phone,
      website: listings.website,
      description: listings.description,
      rejectedReason: listings.rejectedReason,
      submittedByEmail: listings.submittedByEmail,
      customFields: listings.customFields,
      createdAt: listings.createdAt,
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .innerJoin(categories, eq(categories.id, listings.primaryCategoryId))
    // The category's slug is per-city (a global category can route into many
    // cities under different slugs), so the pillar page URL needs this join
    // rather than `categories.slug` — left, not inner: a category that somehow
    // never got routed into this city should not hide the rest of the detail.
    .leftJoin(
      slugs,
      and(
        eq(slugs.parentScope, sql`${listings.cityId}::text`),
        eq(slugs.entityId, listings.primaryCategoryId),
        eq(slugs.kind, "category"),
      ),
    )
    .where(eq(listings.id, listingId))
    .limit(1);
  if (!row) return null;

  const submission = stored(row.customFields);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    cityName: row.cityName,
    citySlug: row.citySlug,
    categoryName: row.categoryName,
    categorySlug: row.categorySlug,
    addressLine1: row.addressLine1,
    postcode: row.postcode,
    phone: row.phone,
    website: row.website,
    description: row.description,
    rejectedReason: row.rejectedReason,
    submitterEmail: row.submittedByEmail ?? str(submission.submitterEmail),
    submitterName: str(submission.submitterName),
    requestedTier: str(submission.requestedTier),
    submittedCity: str(submission.submittedCity),
    submittedRegion: str(submission.submittedRegion),
    createdAt: row.createdAt,
  };
}

export type DecisionResult =
  | { outcome: "approved" | "rejected"; listingId: string }
  | { outcome: "unknown-listing" }
  /** Somebody else got there first. The queue is shared; two admins are normal. */
  | { outcome: "not-pending"; status: ListingStatus }
  | { outcome: "reason-required" };

export interface DecisionOptions {
  /** The admin's IP, for the audit row. Null when no proxy header gave one. */
  ip: string | null;
}

/**
 * Reads the row and refuses anything that is not still pending.
 *
 * Without this a second click — a double submit, a stale tab, a colleague on
 * the same queue — re-runs the decision and sends the submitter a second email
 * about it. `FOR UPDATE` is what makes that a real claim rather than a check:
 * two admins deciding the same row at the same instant would otherwise both
 * read 'pending' before either wrote, and both would send.
 */
async function claimPending(
  tx: TestDb,
  listingId: string,
): Promise<{ cityId: string; publishedAt: Date | null } | DecisionResult> {
  const [row] = await tx
    .select({
      status: listings.status,
      cityId: listings.cityId,
      publishedAt: listings.publishedAt,
    })
    .from(listings)
    .where(eq(listings.id, listingId))
    .limit(1)
    .for("update");
  if (!row) return { outcome: "unknown-listing" };
  if (row.status !== "pending") return { outcome: "not-pending", status: row.status };
  return { cityId: row.cityId, publishedAt: row.publishedAt };
}

export async function approveSubmission(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
  opts: DecisionOptions,
): Promise<DecisionResult> {
  assertAdmin(viewer);

  const claimed = await claimPending(tx, listingId);
  if ("outcome" in claimed) return claimed;

  await tx
    .update(listings)
    .set({
      status: "published",
      updatedAt: now(),
      // Stamped once, the first time it goes live. A republish after a takedown
      // is not a new publication date — see setListingStatus, which keys on the
      // column for the same reason.
      ...(claimed.publishedAt === null ? { publishedAt: now() } : {}),
      // An approval settles an earlier "no". Leaving the reason behind would
      // show a live listing still carrying the note that turned it down.
      rejectedReason: null,
    })
    .where(eq(listings.id, listingId));

  // Global constraint 9: the count moved, so the gate is recomputed here rather
  // than by a later job. A city that has just earned indexing earns it now.
  await recomputeCityIndexability(tx, viewer, claimed.cityId);

  await writeAudit(tx, viewer, {
    action: "submission.approved",
    entityType: "listing",
    entityId: listingId,
    meta: { from: "pending", to: "published" },
    ip: opts.ip,
  });

  await notifyDecision(tx, viewer, { listingId, decision: "approved" });

  return { outcome: "approved", listingId };
}

export async function rejectSubmission(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
  reason: string,
  opts: DecisionOptions,
): Promise<DecisionResult> {
  assertAdmin(viewer);

  // Checked before the row is read so a blank reason never counts as a look at
  // the queue: the submitter is owed a sentence, not a status change.
  const trimmed = reason.trim();
  if (trimmed === "") return { outcome: "reason-required" };

  const claimed = await claimPending(tx, listingId);
  if ("outcome" in claimed) return claimed;

  await tx
    .update(listings)
    .set({ status: "rejected", rejectedReason: trimmed, updatedAt: now() })
    .where(eq(listings.id, listingId));

  // The row never counted towards the city while it was pending, so this cannot
  // move the number. It runs anyway, for the reason createSubmission gives: the
  // rule is that every status write recomputes, not that the ones we think can
  // matter do.
  await recomputeCityIndexability(tx, viewer, claimed.cityId);

  await writeAudit(tx, viewer, {
    action: "submission.rejected",
    entityType: "listing",
    entityId: listingId,
    meta: { from: "pending", to: "rejected", reason: trimmed },
    ip: opts.ip,
  });

  await notifyDecision(tx, viewer, { listingId, decision: "rejected" });

  return { outcome: "rejected", listingId };
}

import { and, desc, eq } from "drizzle-orm";
import { siteConfig } from "@/config/site.config";
import { now } from "@/lib/clock";
import { ensureProfile } from "@/lib/auth/profile";
import { normaliseName } from "@/lib/import/guardrails";
import { normalisePostcode } from "@/lib/geo/countries";
import { removalDueAt } from "@/lib/trust/working-days";
import {
  auditLog,
  cities,
  listings,
  removalRequests,
  reports,
  suppressions,
} from "@/lib/db/schema";
import type { reportReason } from "@/lib/db/schema/enums";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import { publishedListings } from "./listings";
import { setListingStatus } from "./submissions";
import type { TestDb } from "@/test/db";

/**
 * The trust-and-safety queue: reports, removal requests, and the suppression
 * list that makes a removal stick.
 *
 * Two audiences, and the split is the point. The two `create*` functions are
 * reachable by anyone on the internet and so are gated on the same
 * published-only base query as every other public read — a listing nobody can
 * see is not a listing anybody can report. Everything else is admin-only:
 * these rows carry a reporter's email, a requester's name and their reason for
 * wanting off the site, which is personal data about someone who came to us
 * asking for less exposure, not more.
 *
 * The decisions write an `audit_log` row in the same handle as the change
 * (global constraint 22). There is no shared `writeAudit` yet, so this file
 * has a private one; it is a straight insert and merges into the shared helper
 * without a behaviour change.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReportReason = (typeof reportReason.enumValues)[number];

/**
 * Who the requester says they are. Not proof of anything — an admin still
 * decides — but it changes how a request reads: an owner asking to be delisted
 * is a business decision, a subject asking is a privacy one.
 */
export const REMOVAL_RELATIONSHIPS = ["owner", "employee", "subject", "other"] as const;
export type RemovalRelationship = (typeof REMOVAL_RELATIONSHIPS)[number];

/** What the suppression row says it is for, in an admin's own words. */
export const REMOVAL_SUPPRESSION_REASON = "Removal request actioned";

function assertAdmin(viewer: Viewer): void {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
}

/**
 * Every decision below writes one of these on the same handle as the change it
 * describes, so a rolled-back decision cannot leave a record saying it
 * happened. `actorId` is a `profiles.id` (global constraint 21), never the
 * Better Auth user id.
 */
async function writeAudit(
  tx: TestDb,
  input: {
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    meta: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(auditLog).values(input);
}

/* ------------------------------------------------------------------ reports */

export interface ReportInput {
  listingId: string;
  reason: ReportReason;
  detail: string | null;
  /** Optional: a correction is worth having even from someone who won't be chased. */
  reporterEmail: string | null;
  /** Null when no proxy header identified the sender. Never a placeholder. */
  ip: string | null;
}

export type ReportResult =
  | { outcome: "created"; reportId: string }
  | { outcome: "unknown-listing" };

export async function createReport(
  tx: TestDb,
  viewer: Viewer,
  input: ReportInput,
): Promise<ReportResult> {
  // Shape-checked before it reaches Postgres: a malformed uuid raises an
  // exception there, which would turn a bad link into a 500.
  if (!UUID.test(input.listingId)) return { outcome: "unknown-listing" };

  const [target] = await tx
    .select({ id: listings.id })
    .from(listings)
    .where(and(eq(listings.id, input.listingId), publishedListings(viewer)))
    .limit(1);
  if (!target) return { outcome: "unknown-listing" };

  const [row] = await tx
    .insert(reports)
    .values({
      listingId: input.listingId,
      reason: input.reason,
      detail: input.detail,
      reporterEmail: input.reporterEmail,
      ip: input.ip,
    })
    .returning({ id: reports.id });

  return { outcome: "created", reportId: row!.id };
}

/* --------------------------------------------------------- removal requests */

export interface RemovalRequestInput {
  listingId: string;
  requesterName: string;
  requesterEmail: string;
  relationship: RemovalRelationship;
  reason: string | null;
  ip: string | null;
}

export type RemovalRequestResult =
  | { outcome: "created"; removalRequestId: string; dueAt: Date }
  | { outcome: "unknown-listing" };

/**
 * `due_at` is written here rather than computed when the queue is read, so the
 * deadline a requester was promised is the deadline the queue reports even if
 * the SLA is changed later. Five WORKING days, in the site's own timezone —
 * see lib/trust/working-days.ts.
 */
export async function createRemovalRequest(
  tx: TestDb,
  viewer: Viewer,
  input: RemovalRequestInput,
): Promise<RemovalRequestResult> {
  if (!UUID.test(input.listingId)) return { outcome: "unknown-listing" };

  const [target] = await tx
    .select({ id: listings.id })
    .from(listings)
    .where(and(eq(listings.id, input.listingId), publishedListings(viewer)))
    .limit(1);
  if (!target) return { outcome: "unknown-listing" };

  const dueAt = removalDueAt(now(), siteConfig.timezone);

  const [row] = await tx
    .insert(removalRequests)
    .values({
      listingId: input.listingId,
      requesterName: input.requesterName,
      requesterEmail: input.requesterEmail,
      relationship: input.relationship,
      // The IP belongs on the audit trail of a decision, not on a row whose
      // whole purpose is that somebody wants less of their data held. The
      // reason they gave is kept because an admin has to act on it.
      reason: input.reason,
      dueAt,
    })
    .returning({ id: removalRequests.id });

  return { outcome: "created", removalRequestId: row!.id, dueAt };
}

/* ------------------------------------------------------------- admin queues */

export interface OpenReport {
  id: string;
  createdAt: Date;
  listingId: string;
  listingName: string;
  /** Site-relative path to the public page, for the admin's "look at it" link. */
  listingPath: string;
  reason: ReportReason;
  detail: string | null;
  reporterEmail: string | null;
}

export async function listOpenReports(tx: TestDb, viewer: Viewer): Promise<OpenReport[]> {
  assertAdmin(viewer);

  const rows = await tx
    .select({
      id: reports.id,
      createdAt: reports.createdAt,
      listingId: reports.listingId,
      listingName: listings.name,
      listingSlug: listings.slug,
      citySlug: cities.slug,
      reason: reports.reason,
      detail: reports.detail,
      reporterEmail: reports.reporterEmail,
    })
    .from(reports)
    .innerJoin(listings, eq(listings.id, reports.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(eq(reports.status, "open"))
    .orderBy(desc(reports.createdAt));

  return rows.map(({ listingSlug, citySlug, ...row }) => ({
    ...row,
    listingPath: `/${citySlug}/${listingSlug}`,
  }));
}

export interface OpenRemovalRequest {
  id: string;
  createdAt: Date;
  /** Null only on rows filed before `due_at` existed; the SLA is unknowable then. */
  dueAt: Date | null;
  listingId: string;
  listingName: string;
  listingPath: string;
  requesterName: string | null;
  requesterEmail: string | null;
  relationship: string | null;
  reason: string | null;
}

/**
 * Ordered by deadline, not by arrival: the queue exists to stop us breaching a
 * five-working-day promise, and the oldest request is not always the nearest
 * to breaching it.
 */
export async function listOpenRemovalRequests(
  tx: TestDb,
  viewer: Viewer,
): Promise<OpenRemovalRequest[]> {
  assertAdmin(viewer);

  const rows = await tx
    .select({
      id: removalRequests.id,
      createdAt: removalRequests.createdAt,
      dueAt: removalRequests.dueAt,
      listingId: removalRequests.listingId,
      listingName: listings.name,
      listingSlug: listings.slug,
      citySlug: cities.slug,
      requesterName: removalRequests.requesterName,
      requesterEmail: removalRequests.requesterEmail,
      relationship: removalRequests.relationship,
      reason: removalRequests.reason,
    })
    .from(removalRequests)
    .innerJoin(listings, eq(listings.id, removalRequests.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(eq(removalRequests.status, "open"))
    .orderBy(removalRequests.dueAt, removalRequests.createdAt);

  return rows.map(({ listingSlug, citySlug, ...row }) => ({
    ...row,
    listingPath: `/${citySlug}/${listingSlug}`,
  }));
}

/* ----------------------------------------------------------------- decisions */

export type ReportDecision = "actioned" | "dismissed";
export type RemovalDecision = "actioned" | "rejected";

export type DecisionResult =
  | { outcome: "updated"; id: string }
  /** Already decided. A second click must not file a second suppression. */
  | { outcome: "not-open" }
  | { outcome: "unknown" }
  | { outcome: "forbidden" };

export async function actionReport(
  tx: TestDb,
  viewer: Viewer,
  reportId: string,
  decision: ReportDecision,
): Promise<DecisionResult> {
  if (!isAdmin(viewer)) return { outcome: "forbidden" };
  if (!UUID.test(reportId)) return { outcome: "unknown" };

  const [row] = await tx
    .select({ id: reports.id, status: reports.status, listingId: reports.listingId })
    .from(reports)
    .where(eq(reports.id, reportId))
    .limit(1);
  if (!row) return { outcome: "unknown" };
  if (row.status !== "open") return { outcome: "not-open" };

  const actor = await ensureProfile(tx, viewer);

  await tx
    .update(reports)
    .set({ status: decision, updatedAt: now() })
    .where(eq(reports.id, reportId));

  await writeAudit(tx, {
    actorId: actor.id,
    action: `report.${decision}`,
    entityType: "report",
    entityId: reportId,
    meta: { listingId: row.listingId },
  });

  return { outcome: "updated", id: reportId };
}

/**
 * The takedown.
 *
 * 'actioned' does three things that have to happen together or not at all: the
 * listing goes to `status = 'removed'`, a suppression row is written, and the
 * request is closed. The suppression is the half people forget — without it
 * the next import of the same public register puts the business straight back
 * on the site and the person has to ask us twice.
 *
 * The caller supplies the handle, so wrapping all three in one transaction is
 * the caller's job (and the server action does).
 */
export async function actionRemovalRequest(
  tx: TestDb,
  viewer: Viewer,
  removalRequestId: string,
  decision: RemovalDecision,
): Promise<DecisionResult> {
  if (!isAdmin(viewer)) return { outcome: "forbidden" };
  if (!UUID.test(removalRequestId)) return { outcome: "unknown" };

  const [row] = await tx
    .select({
      id: removalRequests.id,
      status: removalRequests.status,
      listingId: removalRequests.listingId,
      listingName: listings.name,
      postcode: listings.postcode,
      email: listings.email,
      phone: listings.phone,
    })
    .from(removalRequests)
    .innerJoin(listings, eq(listings.id, removalRequests.listingId))
    .where(eq(removalRequests.id, removalRequestId))
    .limit(1);
  if (!row) return { outcome: "unknown" };
  if (row.status !== "open") return { outcome: "not-open" };

  const actor = await ensureProfile(tx, viewer);
  let suppressionId: string | null = null;

  if (decision === "actioned") {
    await setListingStatus(tx, viewer, row.listingId, "removed");

    // Normalised with the importer's OWN functions, not with a second copy of
    // the rules. `checkSuppressed` compares `normaliseName(row.name)` against
    // this column and `normalisePostcode(row.postcode)` against that one; a
    // suppression written any other way is a guard that never fires.
    const [written] = await tx
      .insert(suppressions)
      .values({
        nameNormalised: normaliseName(row.listingName),
        postcodeNormalised: row.postcode === null ? null : normalisePostcode(row.postcode),
        // Stored as held, not normalised: the importer normalises both sides in
        // SQL when it matches on phone, and lowercases both sides on email.
        email: row.email,
        phone: row.phone,
        reason: REMOVAL_SUPPRESSION_REASON,
        createdBy: actor.id,
      })
      .returning({ id: suppressions.id });
    suppressionId = written!.id;
  }

  await tx
    .update(removalRequests)
    .set({
      status: decision,
      actionedBy: actor.id,
      actionedAt: now(),
      updatedAt: now(),
    })
    .where(eq(removalRequests.id, removalRequestId));

  await writeAudit(tx, {
    actorId: actor.id,
    action: `removal_request.${decision}`,
    entityType: "removal_request",
    entityId: removalRequestId,
    meta: { listingId: row.listingId, suppressionId },
  });

  return { outcome: "updated", id: removalRequestId };
}

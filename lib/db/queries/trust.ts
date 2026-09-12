import { and, desc, eq } from "drizzle-orm";
import { siteConfig } from "@/config/site.config";
import { now } from "@/lib/clock";
import { ensureProfile } from "@/lib/auth/profile";
import { normaliseName } from "@/lib/import/guardrails";
import { normalisePostcode } from "@/lib/geo/countries";
import { notifyRemovalDecision } from "@/lib/email/notify";
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
const REMOVAL_SUPPRESSION_REASON = "Removal request actioned";

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
    /**
     * The moderator's own IP (global constraint 22), not the reporter's or
     * requester's — that one, if we hold it at all, sits on the row the
     * decision is about. Null rather than defaulted: an admin action taken
     * from somewhere the caller could not read a proxy header is a fact
     * worth keeping, not a reason to write a placeholder.
     */
    ip: string | null;
  },
): Promise<void> {
  await tx.insert(auditLog).values(input);
}

/* ------------------------------------------------------------- the target */

export interface TrustTarget {
  id: string;
  name: string;
  /** Site-relative path to the public page, so the form can link back to it. */
  path: string;
}

/**
 * The listing a report or removal form is about, or null.
 *
 * Behind the same published-only gate as the writes, so /report/<id> for a
 * listing nobody can see is a 404 rather than a form that fails on submit —
 * and so the id in a URL cannot be used to probe whether an unpublished
 * listing exists.
 */
export async function trustTarget(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
): Promise<TrustTarget | null> {
  if (!UUID.test(listingId)) return null;

  const [row] = await tx
    .select({
      id: listings.id,
      name: listings.name,
      listingSlug: listings.slug,
      citySlug: cities.slug,
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(and(eq(listings.id, listingId), publishedListings(viewer)))
    .limit(1);
  if (!row) return null;

  return { id: row.id, name: row.name, path: `/${row.citySlug}/${row.listingSlug}` };
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
  opts: { ip: string | null },
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
    ip: opts.ip,
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
  opts: { ip: string | null },
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
    // Checked rather than assumed: the viewer is an admin and the listing was
    // just joined, so neither refusal is reachable — but a takedown that
    // quietly suppressed a listing it had not actually removed would be the
    // worst possible way to find out that changed.
    const change = await setListingStatus(tx, viewer, row.listingId, "removed");
    if (change.outcome !== "changed") return { outcome: "unknown" };

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
    ip: opts.ip,
  });

  // Enqueued here, not left to the caller: every removal page promises "we
  // email you when it is done", and Task 16's admin pages should not have to
  // remember that promise to keep it. Same transaction as the decision, so a
  // rolled-back decision cannot leave a notification behind it.
  await notifyRemovalDecision(tx, viewer, removalRequestId, decision);

  return { outcome: "updated", id: removalRequestId };
}

/* --------------------------------------------------- notification read models */

/**
 * What the worker sends from. Admin-only, like every other read here: these
 * carry a reporter's address and a requester's name.
 *
 * The job payload is an id, so these re-read the row at send time — a payload
 * cannot go stale and personal data is not copied into a queue that outlives
 * the thing it describes.
 */

export interface ReportNotification {
  listingName: string;
  /** Site-relative path to the public page. */
  listingPath: string;
  reason: ReportReason;
  detail: string | null;
  reporterEmail: string | null;
}

export async function reportNotification(
  tx: TestDb,
  viewer: Viewer,
  reportId: string,
): Promise<ReportNotification | null> {
  assertAdmin(viewer);
  if (!UUID.test(reportId)) return null;

  const [row] = await tx
    .select({
      reason: reports.reason,
      detail: reports.detail,
      reporterEmail: reports.reporterEmail,
      listingName: listings.name,
      listingSlug: listings.slug,
      citySlug: cities.slug,
    })
    .from(reports)
    .innerJoin(listings, eq(listings.id, reports.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(eq(reports.id, reportId))
    .limit(1);
  if (!row) return null;

  return {
    listingName: row.listingName,
    listingPath: `/${row.citySlug}/${row.listingSlug}`,
    reason: row.reason,
    detail: row.detail,
    reporterEmail: row.reporterEmail,
  };
}

export interface RemovalNotification {
  listingName: string;
  listingPath: string;
  requesterName: string;
  requesterEmail: string;
  relationship: RemovalRelationship;
  reason: string | null;
  dueAt: Date;
}

export async function removalNotification(
  tx: TestDb,
  viewer: Viewer,
  removalRequestId: string,
): Promise<RemovalNotification | null> {
  assertAdmin(viewer);
  if (!UUID.test(removalRequestId)) return null;

  const [row] = await tx
    .select({
      requesterName: removalRequests.requesterName,
      requesterEmail: removalRequests.requesterEmail,
      relationship: removalRequests.relationship,
      reason: removalRequests.reason,
      dueAt: removalRequests.dueAt,
      listingName: listings.name,
      listingSlug: listings.slug,
      citySlug: cities.slug,
    })
    .from(removalRequests)
    .innerJoin(listings, eq(listings.id, removalRequests.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(eq(removalRequests.id, removalRequestId))
    .limit(1);
  if (!row) return null;

  // The columns are nullable and the form's validation is not the database's.
  // Without an address there is nobody to acknowledge, and without a deadline
  // there is no SLA to state — a row like that is not notifiable.
  if (row.requesterEmail === null || row.dueAt === null) return null;

  return {
    listingName: row.listingName,
    listingPath: `/${row.citySlug}/${row.listingSlug}`,
    // The address identifies the requester well enough if the name is missing.
    requesterName: row.requesterName ?? row.requesterEmail,
    requesterEmail: row.requesterEmail,
    // A text column, so the value is checked rather than cast. Only the four
    // ever reach it through the form; anything else is described as "other"
    // rather than blocking a takedown notification over a label.
    relationship: isRelationship(row.relationship) ? row.relationship : "other",
    reason: row.reason,
    dueAt: row.dueAt,
  };
}

function isRelationship(value: string | null): value is RemovalRelationship {
  return value !== null && (REMOVAL_RELATIONSHIPS as readonly string[]).includes(value);
}

export interface RemovalDecisionNotification {
  listingName: string;
  requesterName: string;
  requesterEmail: string;
}

/**
 * What the "we email you when it is done" email needs, read fresh at send
 * time rather than filtered by status — by the time the worker runs, the
 * request this is about is no longer open.
 */
export async function removalDecisionNotification(
  tx: TestDb,
  viewer: Viewer,
  removalRequestId: string,
): Promise<RemovalDecisionNotification | null> {
  assertAdmin(viewer);
  if (!UUID.test(removalRequestId)) return null;

  const [row] = await tx
    .select({
      requesterName: removalRequests.requesterName,
      requesterEmail: removalRequests.requesterEmail,
      listingName: listings.name,
    })
    .from(removalRequests)
    .innerJoin(listings, eq(listings.id, removalRequests.listingId))
    .where(eq(removalRequests.id, removalRequestId))
    .limit(1);
  if (!row) return null;
  // The column is nullable and the form's validation is not the database's.
  // Without an address there is nobody to tell.
  if (row.requesterEmail === null) return null;

  return {
    listingName: row.listingName,
    requesterName: row.requesterName ?? row.requesterEmail,
    requesterEmail: row.requesterEmail,
  };
}

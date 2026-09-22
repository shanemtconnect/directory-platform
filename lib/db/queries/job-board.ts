import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { siteConfig } from "@/config/site.config";
import { categories, cities, jobs, listings } from "@/lib/db/schema";
import { now } from "@/lib/clock";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";
import { writeAudit, writeAuditAs } from "@/lib/db/queries/audit";
import { notifyJobDecided, notifyJobSubmitted } from "@/lib/email/notify-jobs";

/**
 * Every database access the jobs board makes (Task 49, flag `jobBoard`).
 *
 * The board's tables (`jobs`, `job_applications`) ship on every site; the
 * flag decides whether any page reads them. Three rules shape this file:
 *
 *  - The PUBLIC gate is `openJobs()`: status 'published' and not past
 *    `expires_at`. Every public read builds on it, and — unlike listings — it
 *    does not widen for an admin. /jobs is an ISR-cached page; an admin's
 *    view of it would be written into the cache everyone reads back.
 *  - A post is either FREE (a Verified listing's owner, or a zero price) or
 *    it OWES a payment. Payment is provider-neutral in the columns and
 *    settled by `markJobPaid`, which is idempotent by construction: a webhook
 *    and a return page both land on it and the second one finds it done.
 *  - Nothing about applications is stored beyond a count. The apply button is
 *    a mailto: or an external link; `recordJobApply` counts the press.
 *
 * Every admin decision and every worker write puts a row in `audit_log` in
 * the same transaction (global constraint 22).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

export const JOBS_PER_PAGE = 20;

function assertAdmin(viewer: Viewer): void {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
}

function assertSignedIn(viewer: Viewer): void {
  if (viewer.role === "public") throw new Error("FORBIDDEN");
}

/** The one public gate. Deliberately viewer-blind — see the file comment. */
function openJobs() {
  return and(eq(jobs.status, "published"), or(isNull(jobs.expiresAt), gt(jobs.expiresAt, now())));
}

export const jobPath = (id: string): string => `/jobs/${id}`;

/* ------------------------------------------------------------- public reads */

export interface JobFilters {
  readonly citySlug?: string | null;
  readonly categorySlug?: string | null;
}

export interface PublicJobCard {
  readonly id: string;
  readonly title: string;
  readonly companyName: string | null;
  readonly cityName: string | null;
  readonly citySlug: string | null;
  readonly categoryName: string | null;
  readonly categorySlug: string | null;
  readonly budgetMin: string | null;
  readonly budgetMax: string | null;
  readonly publishedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly path: string;
}

const cardColumns = {
  id: jobs.id,
  title: jobs.title,
  companyName: jobs.companyName,
  cityName: cities.name,
  citySlug: cities.slug,
  categoryName: categories.name,
  categorySlug: categories.slug,
  budgetMin: jobs.budgetMin,
  budgetMax: jobs.budgetMax,
  publishedAt: jobs.publishedAt,
  expiresAt: jobs.expiresAt,
};

function filterClause(filters: JobFilters) {
  const clauses = [openJobs()];
  if (filters.citySlug) clauses.push(eq(cities.slug, filters.citySlug));
  if (filters.categorySlug) clauses.push(eq(categories.slug, filters.categorySlug));
  return and(...clauses);
}

function withCard<T extends Record<string, unknown>>(row: T & { id: string }): T & { path: string } {
  return { ...row, path: jobPath(row.id) };
}

/** Open jobs, newest first. `page` is 1-based; the route has already bounded it. */
export async function listOpenJobs(
  tx: TestDb,
  _viewer: Viewer,
  opts: JobFilters & { page: number },
): Promise<PublicJobCard[]> {
  const page = Math.max(1, Math.floor(opts.page));
  const rows = await tx
    .select(cardColumns)
    .from(jobs)
    .leftJoin(cities, eq(cities.id, jobs.cityId))
    .leftJoin(categories, eq(categories.id, jobs.categoryId))
    .where(filterClause(opts))
    .orderBy(desc(jobs.publishedAt), desc(jobs.id))
    .limit(JOBS_PER_PAGE)
    .offset((page - 1) * JOBS_PER_PAGE);
  return rows.map(withCard);
}

export async function countOpenJobs(tx: TestDb, _viewer: Viewer, filters: JobFilters): Promise<number> {
  const [row] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(jobs)
    .leftJoin(cities, eq(cities.id, jobs.cityId))
    .leftJoin(categories, eq(categories.id, jobs.categoryId))
    .where(filterClause(filters));
  return row?.total ?? 0;
}

export interface JobFilterOption {
  readonly name: string;
  readonly slug: string;
  readonly count: number;
}

/** The towns and categories with at least one open job — the filter links. */
export async function jobFilterOptions(
  tx: TestDb,
  _viewer: Viewer,
): Promise<{ cities: JobFilterOption[]; categories: JobFilterOption[] }> {
  const count = sql<number>`count(*)::int`;
  const byCity = await tx
    .select({ name: cities.name, slug: cities.slug, count })
    .from(jobs)
    .innerJoin(cities, eq(cities.id, jobs.cityId))
    .where(openJobs())
    .groupBy(cities.id, cities.name, cities.slug)
    .orderBy(cities.name);
  const byCategory = await tx
    .select({ name: categories.name, slug: categories.slug, count })
    .from(jobs)
    .innerJoin(categories, eq(categories.id, jobs.categoryId))
    .where(openJobs())
    .groupBy(categories.id, categories.name, categories.slug)
    .orderBy(categories.name);
  return { cities: byCity, categories: byCategory };
}

export interface ResolvedJobFilters {
  readonly city: { name: string; slug: string } | null;
  readonly category: { name: string; slug: string } | null;
}

/**
 * Names for the filter slugs in a URL. Null when a slug names nothing we
 * hold — the route 404s rather than rendering an empty page under a made-up
 * heading. A town with no open jobs still resolves: that page says so.
 */
export async function resolveJobFilters(
  tx: TestDb,
  _viewer: Viewer,
  filters: JobFilters,
): Promise<ResolvedJobFilters | null> {
  let city: ResolvedJobFilters["city"] = null;
  let category: ResolvedJobFilters["category"] = null;

  if (filters.citySlug) {
    const [row] = await tx
      .select({ name: cities.name, slug: cities.slug })
      .from(cities)
      .where(and(eq(cities.slug, filters.citySlug), eq(cities.isPublished, true)))
      .limit(1);
    if (!row) return null;
    city = row;
  }
  if (filters.categorySlug) {
    const [row] = await tx
      .select({ name: categories.name, slug: categories.slug })
      .from(categories)
      .where(and(eq(categories.slug, filters.categorySlug), eq(categories.isActive, true)))
      .limit(1);
    if (!row) return null;
    category = row;
  }
  return { city, category };
}

export interface PublicJob extends PublicJobCard {
  readonly description: string | null;
  readonly applyMethod: "email" | "url" | null;
  readonly applyEmail: string | null;
  readonly applyUrl: string | null;
  readonly cityRegion: string | null;
  /** False once it has expired: the page renders a "closed" notice and no markup. */
  readonly open: boolean;
}

/**
 * A job page. Published and expired both render — the expired one as closed,
 * so a link that was shared stays a page rather than a 404 — and anything
 * still pending or removed is nobody's business but the admin queue's.
 */
export async function getPublicJob(tx: TestDb, _viewer: Viewer, id: string): Promise<PublicJob | null> {
  if (!UUID.test(id)) return null;
  const [row] = await tx
    .select({
      ...cardColumns,
      description: jobs.description,
      applyMethod: jobs.applyMethod,
      applyEmail: jobs.applyEmail,
      applyUrl: jobs.applyUrl,
      cityRegion: cities.region,
      status: jobs.status,
    })
    .from(jobs)
    .leftJoin(cities, eq(cities.id, jobs.cityId))
    .leftJoin(categories, eq(categories.id, jobs.categoryId))
    .where(and(eq(jobs.id, id), or(eq(jobs.status, "published"), eq(jobs.status, "expired"))))
    .limit(1);
  if (!row) return null;
  const { status, applyMethod, ...rest } = row;
  const lapsed = row.expiresAt !== null && row.expiresAt.getTime() <= now().getTime();
  return withCard({
    ...rest,
    applyMethod: applyMethod === "email" || applyMethod === "url" ? applyMethod : null,
    open: status === "published" && !lapsed,
  });
}

/** Counts a press on Apply. Nothing else about the applicant is kept. */
export async function recordJobApply(tx: TestDb, _viewer: Viewer, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const updated = await tx
    .update(jobs)
    .set({ applyCount: sql`${jobs.applyCount} + 1` })
    .where(and(eq(jobs.id, id), openJobs()))
    .returning({ id: jobs.id });
  return updated.length > 0;
}

/* ----------------------------------------------------------------- posting */

export interface CreateJobInput {
  readonly title: string;
  readonly description: string;
  readonly companyName: string;
  readonly posterName: string;
  readonly posterEmail: string;
  readonly cityId: string;
  readonly categoryId: string;
  readonly budgetMin: number | null;
  readonly budgetMax: number | null;
  readonly applyMethod: "email" | "url";
  readonly applyEmail: string | null;
  readonly applyUrl: string | null;
  /** A Verified listing the poster owns, for a free post. Null otherwise. */
  readonly listingId: string | null;
  /** profiles.id of a signed-in poster. Null for a stranger. */
  readonly posterProfileId: string | null;
  readonly ip: string | null;
}

export type CreateJobResult =
  | { outcome: "created"; jobId: string; free: boolean }
  | { outcome: "unknown-city" }
  | { outcome: "unknown-category" }
  /** The listing named is not a published, Verified listing this profile owns. */
  | { outcome: "not-verified-listing" };

export interface PosterListing {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly verified: boolean;
}

/**
 * The signed-in poster's published listings, with whether each is Verified.
 * Owner gate: `listings.owner_id = profiles.id` (global constraint 24). The
 * page uses the Verified ones as the free-post picker and the others for the
 * "verify to post free" upsell.
 */
export async function posterListings(tx: TestDb, viewer: Viewer, profileId: string): Promise<PosterListing[]> {
  assertSignedIn(viewer);
  if (!UUID.test(profileId)) return [];
  const rows = await tx
    .select({
      id: listings.id,
      name: listings.name,
      slug: listings.slug,
      citySlug: cities.slug,
      claimStatus: listings.claimStatus,
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(and(eq(listings.ownerId, profileId), eq(listings.status, "published")))
    .orderBy(listings.name);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    path: `/${r.citySlug}/${r.slug}`,
    verified: r.claimStatus === "verified",
  }));
}

/** Whether a price is charged at all. Zero means the payment step does not exist. */
export const jobPostingIsFree = (): boolean => siteConfig.jobs.price <= 0;

export async function createJob(tx: TestDb, viewer: Viewer, input: CreateJobInput): Promise<CreateJobResult> {
  if (!UUID.test(input.cityId)) return { outcome: "unknown-city" };
  if (!UUID.test(input.categoryId)) return { outcome: "unknown-category" };

  const [city] = await tx.select({ id: cities.id }).from(cities).where(eq(cities.id, input.cityId)).limit(1);
  if (!city) return { outcome: "unknown-city" };
  const [category] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, input.categoryId), eq(categories.isActive, true)))
    .limit(1);
  if (!category) return { outcome: "unknown-category" };

  let free = jobPostingIsFree();
  let listingId: string | null = null;
  if (input.listingId !== null) {
    // The free path. Ownership AND Verified, both checked here and not on the
    // form: the listing id is a hidden field anyone can edit.
    if (viewer.role === "public" || input.posterProfileId === null) return { outcome: "not-verified-listing" };
    if (!UUID.test(input.listingId) || !UUID.test(input.posterProfileId)) return { outcome: "not-verified-listing" };
    const [owned] = await tx
      .select({ id: listings.id })
      .from(listings)
      .where(
        and(
          eq(listings.id, input.listingId),
          eq(listings.ownerId, input.posterProfileId),
          eq(listings.claimStatus, "verified"),
          eq(listings.status, "published"),
        ),
      )
      .limit(1);
    if (!owned) return { outcome: "not-verified-listing" };
    listingId = owned.id;
    free = true;
  }

  const [row] = await tx
    .insert(jobs)
    .values({
      title: input.title,
      description: input.description,
      companyName: input.companyName,
      posterName: input.posterName,
      posterEmail: input.posterEmail,
      posterProfileId: input.posterProfileId,
      cityId: city.id,
      categoryId: category.id,
      budgetMin: input.budgetMin === null ? null : input.budgetMin.toFixed(2),
      budgetMax: input.budgetMax === null ? null : input.budgetMax.toFixed(2),
      applyMethod: input.applyMethod,
      applyEmail: input.applyMethod === "email" ? input.applyEmail : null,
      applyUrl: input.applyMethod === "url" ? input.applyUrl : null,
      listingId,
      status: "pending",
      paymentStatus: free ? "free" : "pending",
      ip: input.ip,
    })
    .returning({ id: jobs.id });
  const jobId = row!.id;

  // A paid post reaches the queue when the capture lands (markJobPaid tells
  // the admin then); telling them about an unpaid one is noise.
  if (free) await notifyJobSubmitted(tx, viewer, jobId);

  return { outcome: "created", jobId, free };
}

/* ----------------------------------------------------------------- payment */

/** Records the provider's order on the row it pays for. Called inside the posting transaction. */
export async function attachJobOrder(
  tx: TestDb,
  _viewer: Viewer,
  input: { jobId: string; providerOrderId: string },
): Promise<void> {
  await tx
    .update(jobs)
    .set({ providerOrderId: input.providerOrderId, updatedAt: now() })
    .where(and(eq(jobs.id, input.jobId), eq(jobs.paymentStatus, "pending")));
}

export interface JobForOrder {
  readonly id: string;
  readonly paymentStatus: string;
  readonly status: string;
}

export async function jobForOrder(tx: TestDb, viewer: Viewer, providerOrderId: string): Promise<JobForOrder | null> {
  assertAdmin(viewer);
  const [row] = await tx
    .select({ id: jobs.id, paymentStatus: jobs.paymentStatus, status: jobs.status })
    .from(jobs)
    .where(eq(jobs.providerOrderId, providerOrderId))
    .limit(1);
  return row ?? null;
}

export type MarkPaidResult =
  | { outcome: "paid"; jobId: string }
  | { outcome: "already-paid"; jobId: string }
  | { outcome: "unknown-order" };

/**
 * Settles the payment. Idempotent: `FOR UPDATE` on the row, and a row that is
 * already paid is reported as such and left alone — the return page and the
 * webhook both call this and only one of them gets to write.
 */
export async function markJobPaid(
  tx: TestDb,
  viewer: Viewer,
  input: { providerOrderId: string; captureId: string | null; eventId: string | null },
): Promise<MarkPaidResult> {
  assertAdmin(viewer);
  const [row] = await tx
    .select({ id: jobs.id, paymentStatus: jobs.paymentStatus })
    .from(jobs)
    .where(eq(jobs.providerOrderId, input.providerOrderId))
    .limit(1)
    .for("update");
  if (!row) return { outcome: "unknown-order" };
  if (row.paymentStatus === "paid" || row.paymentStatus === "free") {
    return { outcome: "already-paid", jobId: row.id };
  }

  await tx
    .update(jobs)
    .set({
      paymentStatus: "paid",
      providerCaptureId: input.captureId,
      paidAt: now(),
      updatedAt: now(),
    })
    .where(eq(jobs.id, row.id));

  // No human behind a capture: the actor is null and the event is the record.
  await writeAuditAs(tx, null, {
    action: "job.paid",
    entityType: "job",
    entityId: row.id,
    meta: { providerOrderId: input.providerOrderId, captureId: input.captureId, eventId: input.eventId },
  });

  // Now it is something the admin should look at.
  await notifyJobSubmitted(tx, viewer, row.id);

  return { outcome: "paid", jobId: row.id };
}

/* ------------------------------------------------------------------- admin */

export interface PendingJob extends PublicJobCard {
  readonly description: string | null;
  readonly posterName: string | null;
  readonly posterEmail: string | null;
  readonly paymentStatus: string;
  readonly listingId: string | null;
  readonly createdAt: Date;
}

/** Pending AND settled: an unpaid post is not the admin's to decide yet. */
function awaitingDecision() {
  return and(eq(jobs.status, "pending"), or(eq(jobs.paymentStatus, "free"), eq(jobs.paymentStatus, "paid")));
}

export async function pendingJobs(tx: TestDb, viewer: Viewer): Promise<PendingJob[]> {
  assertAdmin(viewer);
  const rows = await tx
    .select({
      ...cardColumns,
      description: jobs.description,
      posterName: jobs.posterName,
      posterEmail: jobs.posterEmail,
      paymentStatus: jobs.paymentStatus,
      listingId: jobs.listingId,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .leftJoin(cities, eq(cities.id, jobs.cityId))
    .leftJoin(categories, eq(categories.id, jobs.categoryId))
    .where(awaitingDecision())
    .orderBy(jobs.createdAt);
  return rows.map(withCard);
}

export async function countPendingJobs(tx: TestDb, viewer: Viewer): Promise<number> {
  assertAdmin(viewer);
  const [row] = await tx.select({ total: sql<number>`count(*)::int` }).from(jobs).where(awaitingDecision());
  return row?.total ?? 0;
}

export type JobDecisionResult =
  | { outcome: "approved" | "rejected"; jobId: string }
  | { outcome: "unknown-job" }
  | { outcome: "not-pending"; status: string }
  | { outcome: "unpaid" }
  | { outcome: "reason-required" };

export interface JobDecisionOptions {
  /** The admin's IP, for the audit row. */
  readonly ip: string | null;
}

/** Locks the row so two admins deciding at once cannot both send a decision email. */
async function claimPending(
  tx: TestDb,
  jobId: string,
): Promise<{ paymentStatus: string } | JobDecisionResult> {
  if (!UUID.test(jobId)) return { outcome: "unknown-job" };
  const [row] = await tx
    .select({ status: jobs.status, paymentStatus: jobs.paymentStatus })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1)
    .for("update");
  if (!row) return { outcome: "unknown-job" };
  if (row.status !== "pending") return { outcome: "not-pending", status: row.status };
  return { paymentStatus: row.paymentStatus };
}

export async function approveJob(
  tx: TestDb,
  viewer: Viewer,
  jobId: string,
  opts: JobDecisionOptions,
): Promise<JobDecisionResult> {
  assertAdmin(viewer);
  const claimed = await claimPending(tx, jobId);
  if ("outcome" in claimed) return claimed;
  if (claimed.paymentStatus === "pending") return { outcome: "unpaid" };

  const at = now();
  const expiresAt = new Date(at.getTime() + siteConfig.jobs.durationDays * DAY_MS);
  await tx
    .update(jobs)
    .set({ status: "published", publishedAt: at, expiresAt, rejectedReason: null, updatedAt: at })
    .where(eq(jobs.id, jobId));

  await writeAudit(tx, viewer, {
    action: "job.approved",
    entityType: "job",
    entityId: jobId,
    meta: { from: "pending", to: "published", expiresAt: expiresAt.toISOString() },
    ip: opts.ip,
  });
  await notifyJobDecided(tx, viewer, jobId);
  return { outcome: "approved", jobId };
}

export async function rejectJob(
  tx: TestDb,
  viewer: Viewer,
  jobId: string,
  opts: JobDecisionOptions & { reason: string },
): Promise<JobDecisionResult> {
  assertAdmin(viewer);
  const reason = opts.reason.trim();
  if (reason === "") return { outcome: "reason-required" };
  const claimed = await claimPending(tx, jobId);
  if ("outcome" in claimed) return claimed;

  await tx
    .update(jobs)
    .set({ status: "removed", rejectedReason: reason, updatedAt: now() })
    .where(eq(jobs.id, jobId));

  await writeAudit(tx, viewer, {
    action: "job.rejected",
    entityType: "job",
    entityId: jobId,
    meta: { from: "pending", to: "removed", reason },
    ip: opts.ip,
  });
  await notifyJobDecided(tx, viewer, jobId);
  return { outcome: "rejected", jobId };
}

/* ------------------------------------------------------------------ worker */

/** Published jobs past their date become 'expired'. Returns the ids it moved. */
export async function expireDueJobs(tx: TestDb, viewer: Viewer): Promise<string[]> {
  assertAdmin(viewer);
  const at = now();
  const moved = await tx
    .update(jobs)
    .set({ status: "expired", updatedAt: at })
    .where(and(eq(jobs.status, "published"), lte(jobs.expiresAt, at)))
    .returning({ id: jobs.id });
  for (const { id } of moved) {
    await writeAuditAs(tx, null, {
      action: "job.expired",
      entityType: "job",
      entityId: id,
      meta: { from: "published", to: "expired" },
    });
  }
  return moved.map((m) => m.id);
}

export interface JobDueReminder {
  readonly id: string;
  readonly expiresAt: Date;
}

/**
 * Open jobs closing within `reminderDays` that have not been reminded. The
 * window is inclusive at the far edge and excludes anything already past —
 * that is the expiry job's business, not a reminder's.
 */
export async function jobsDueReminder(tx: TestDb, viewer: Viewer): Promise<JobDueReminder[]> {
  assertAdmin(viewer);
  const at = now();
  const edge = new Date(at.getTime() + siteConfig.jobs.reminderDays * DAY_MS);
  const rows = await tx
    .select({ id: jobs.id, expiresAt: jobs.expiresAt })
    .from(jobs)
    .where(
      and(
        eq(jobs.status, "published"),
        isNull(jobs.reminderSentAt),
        gt(jobs.expiresAt, at),
        lte(jobs.expiresAt, edge),
      ),
    )
    .orderBy(jobs.expiresAt);
  return rows.flatMap((r) => (r.expiresAt === null ? [] : [{ id: r.id, expiresAt: r.expiresAt }]));
}

export async function markJobReminderSent(tx: TestDb, viewer: Viewer, jobId: string): Promise<void> {
  assertAdmin(viewer);
  await tx.update(jobs).set({ reminderSentAt: now() }).where(and(eq(jobs.id, jobId), isNull(jobs.reminderSentAt)));
}

export interface JobNotifyContext {
  readonly id: string;
  readonly title: string;
  readonly companyName: string | null;
  readonly posterName: string | null;
  readonly posterEmail: string | null;
  readonly status: string;
  readonly expiresAt: Date | null;
  readonly rejectedReason: string | null;
  readonly path: string;
}

/** What the emails say. Re-read at send time, never carried in the payload. */
export async function jobNotifyContext(tx: TestDb, viewer: Viewer, jobId: string): Promise<JobNotifyContext | null> {
  assertAdmin(viewer);
  if (!UUID.test(jobId)) return null;
  const [row] = await tx
    .select({
      id: jobs.id,
      title: jobs.title,
      companyName: jobs.companyName,
      posterName: jobs.posterName,
      posterEmail: jobs.posterEmail,
      status: jobs.status,
      expiresAt: jobs.expiresAt,
      rejectedReason: jobs.rejectedReason,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  return row ? withCard(row) : null;
}

/* ------------------------------------------------------------------- paths */

/**
 * The ISR pages a change to one job leaves stale: the board, the job, and the
 * filter pages it sits on. Paginated pages are left to their revalidate
 * window — a board is not a pillar page, and a job that is a page late on
 * /jobs/page/3 costs nobody anything.
 */
export async function jobPaths(tx: TestDb, _viewer: Viewer, jobId: string): Promise<string[]> {
  const paths = ["/jobs"];
  if (!UUID.test(jobId)) return paths;
  const [row] = await tx
    .select({ citySlug: cities.slug, categorySlug: categories.slug })
    .from(jobs)
    .leftJoin(cities, eq(cities.id, jobs.cityId))
    .leftJoin(categories, eq(categories.id, jobs.categoryId))
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!row) return paths;
  paths.push(jobPath(jobId));
  if (row.citySlug) paths.push(`/jobs/in/${row.citySlug}`);
  if (row.citySlug && row.categorySlug) paths.push(`/jobs/in/${row.citySlug}/${row.categorySlug}`);
  if (row.categorySlug) paths.push(`/jobs/category/${row.categorySlug}`);
  return paths;
}

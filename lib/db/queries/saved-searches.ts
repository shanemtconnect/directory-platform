import { createHash } from "node:crypto";
import { and, count, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { jobQueue, profiles, savedSearches, user } from "@/lib/db/schema";
import { ensureProfile } from "@/lib/auth/profile";
import { now } from "@/lib/clock";
import { isAdmin, PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";
import { writeAudit } from "@/lib/db/queries/audit";
import { search, SEARCH_PER_PAGE, type SearchParams } from "@/lib/db/queries/search";
import { JOBS_PER_PAGE, listOpenJobs, type JobFilters } from "@/lib/db/queries/job-board";
import { NOTIFY_SAVED_SEARCH } from "@/lib/email/notify";

/**
 * Saved searches and the alert digests built from them (Task 54, flag
 * `savedSearches`).
 *
 * `params` is OPAQUE here. It is whatever the page handed the query —
 * `SearchParams` for /search, `JobFilters` for /jobs — canonicalised and
 * stored, then passed straight back to that same query with `createdAfter`
 * added. Nothing in this file names a filter, so the search can grow one
 * (Task 53's `verified`) without a saved search noticing.
 *
 * `user_id` references `profiles.id`, like every other "who" column; every
 * read and write a person makes is scoped to their own profile here, not by
 * the caller.
 */

export const MAX_SAVED_SEARCHES = 10;
/** The most matches one digest looks at. A digest past this says "and N more" with N capped. */
export const MAX_MATCHES_SCANNED = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR_MS = 3_600_000;
const DUE_AFTER_MS = { daily: 24 * HOUR_MS, weekly: 7 * 24 * HOUR_MS } as const;

export type SavedSearchKind = (typeof savedSearches.$inferSelect)["kind"];
export type SavedSearchFrequency = (typeof savedSearches.$inferSelect)["frequency"];
export type SavedSearch = typeof savedSearches.$inferSelect;
export type SavedSearchParams = Record<string, unknown>;

/* ------------------------------------------------------------ canonical form */

/**
 * Empty values dropped (a blank select is "any", not a filter) and object
 * keys sorted, recursively. Two spellings of one search are one object.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = canonical((value as Record<string, unknown>)[key]);
      if (v === undefined || v === null || v === "") continue;
      if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) continue;
      out[key] = v;
    }
    return out;
  }
  return value;
}

export function canonicalParams(params: SavedSearchParams): string {
  return JSON.stringify(canonical(params));
}

/** sha256 of the canonical JSON — the unique key's third column. */
export function paramsHash(params: SavedSearchParams): string {
  return createHash("sha256").update(canonicalParams(params), "utf8").digest("hex");
}

/* ------------------------------------------------------------ a person's own */

async function ownerId(tx: TestDb, viewer: Viewer): Promise<string> {
  if (viewer.role === "public") throw new Error("FORBIDDEN");
  return (await ensureProfile(tx, viewer)).id;
}

export async function listSavedSearches(tx: TestDb, viewer: Viewer): Promise<SavedSearch[]> {
  const profileId = await ownerId(tx, viewer);
  return tx
    .select()
    .from(savedSearches)
    .where(eq(savedSearches.userId, profileId))
    .orderBy(desc(savedSearches.createdAt), desc(savedSearches.id));
}

export interface CreateSavedSearchInput {
  kind: SavedSearchKind;
  params: SavedSearchParams;
  label: string;
  frequency?: SavedSearchFrequency;
}

export type CreateSavedSearchResult =
  | { outcome: "created"; id: string }
  /** Already saved. Re-activated if the one-click unsubscribe had turned it off. */
  | { outcome: "existing"; id: string }
  | { outcome: "limit" };

export async function createSavedSearch(
  tx: TestDb,
  viewer: Viewer,
  input: CreateSavedSearchInput,
): Promise<CreateSavedSearchResult> {
  const profileId = await ownerId(tx, viewer);
  const params = canonical(input.params) as SavedSearchParams;
  const hash = paramsHash(params);
  const key = and(
    eq(savedSearches.userId, profileId),
    eq(savedSearches.kind, input.kind),
    eq(savedSearches.paramsHash, hash),
  );

  const reactivate = async (): Promise<CreateSavedSearchResult | null> => {
    const [existing] = await tx
      .update(savedSearches)
      .set({ isActive: true, updatedAt: now() })
      .where(key)
      .returning({ id: savedSearches.id });
    return existing ? { outcome: "existing", id: existing.id } : null;
  };

  const found = await reactivate();
  if (found) return found;

  const [{ n } = { n: 0 }] = await tx
    .select({ n: count() })
    .from(savedSearches)
    .where(eq(savedSearches.userId, profileId));
  if (n >= MAX_SAVED_SEARCHES) return { outcome: "limit" };

  const [created] = await tx
    .insert(savedSearches)
    .values({
      userId: profileId,
      kind: input.kind,
      params,
      paramsHash: hash,
      label: input.label,
      frequency: input.frequency ?? "weekly",
      // The first digest is what arrives after this moment, not the back catalogue.
      lastSeenCreatedAt: now(),
    })
    .onConflictDoNothing()
    .returning({ id: savedSearches.id });
  if (created) return { outcome: "created", id: created.id };
  // Lost a race with the same save from another tab.
  return (await reactivate()) ?? { outcome: "limit" };
}

export async function deleteSavedSearch(tx: TestDb, viewer: Viewer, id: string): Promise<boolean> {
  const profileId = await ownerId(tx, viewer);
  if (!UUID.test(id)) return false;
  const rows = await tx
    .delete(savedSearches)
    .where(and(eq(savedSearches.id, id), eq(savedSearches.userId, profileId)))
    .returning({ id: savedSearches.id });
  return rows.length > 0;
}

export async function setSavedSearchFrequency(
  tx: TestDb,
  viewer: Viewer,
  id: string,
  frequency: SavedSearchFrequency,
): Promise<boolean> {
  const profileId = await ownerId(tx, viewer);
  if (!UUID.test(id)) return false;
  const rows = await tx
    .update(savedSearches)
    .set({ frequency, updatedAt: now() })
    .where(and(eq(savedSearches.id, id), eq(savedSearches.userId, profileId)))
    .returning({ id: savedSearches.id });
  return rows.length > 0;
}

/* ------------------------------------------------------------- the dispatch */

/**
 * Active searches whose digest is due at `at`: never sent, or a daily one
 * last sent 24 h ago or more, or a weekly one 7 d ago or more. Only for an
 * owner whose address is verified — an unverified sign-up must not be a way
 * to point digests at somebody else's inbox — and never one that already
 * has a digest waiting in the queue, so a slow queue cannot double up.
 */
export async function dueSavedSearches(tx: TestDb, at: Date): Promise<SavedSearch[]> {
  const dailyBefore = new Date(at.getTime() - DUE_AFTER_MS.daily);
  const weeklyBefore = new Date(at.getTime() - DUE_AFTER_MS.weekly);
  const rows = await tx
    .select({ search: savedSearches })
    .from(savedSearches)
    .innerJoin(profiles, eq(profiles.id, savedSearches.userId))
    .innerJoin(user, eq(user.id, profiles.userId))
    .where(and(
      eq(savedSearches.isActive, true),
      eq(user.emailVerified, true),
      or(
        isNull(savedSearches.lastSentAt),
        and(eq(savedSearches.frequency, "daily"), lte(savedSearches.lastSentAt, dailyBefore)),
        and(eq(savedSearches.frequency, "weekly"), lte(savedSearches.lastSentAt, weeklyBefore)),
      ),
      sql`not exists (
        select 1 from ${jobQueue}
        where ${jobQueue.kind} = ${NOTIFY_SAVED_SEARCH}
          and ${jobQueue.status} = 'pending'
          and ${jobQueue.payload} ->> 'savedSearchId' = ${savedSearches.id}::text
      )`,
    ))
    .orderBy(savedSearches.createdAt);
  return rows.map((r) => r.search);
}

/** One new listing or job, as a digest line. */
export interface Match {
  id: string;
  title: string;
  /** Site-relative; the template makes it absolute. */
  path: string;
  /** The town, when there is one. */
  place: string | null;
  createdAt: Date;
}

/**
 * What is NEW for a search: rows created strictly after `since`, through
 * the very query the page runs — the public viewer's, so a pending, removed
 * or expired row can never appear. Newest first, at most
 * MAX_MATCHES_SCANNED.
 */
export async function newMatchesFor(
  tx: TestDb,
  saved: Pick<SavedSearch, "kind" | "params">,
  since: Date,
): Promise<Match[]> {
  const out: Match[] = [];

  if (saved.kind === "listings") {
    for (let page = 1; out.length < MAX_MATCHES_SCANNED; page++) {
      const result = await search(tx, PUBLIC_VIEWER, {
        ...(saved.params as SearchParams),
        page,
        createdAfter: since,
      });
      for (const r of result.rows) {
        out.push({ id: r.id, title: r.name, path: `/${r.citySlug}/${r.slug}`, place: r.cityName, createdAt: r.createdAt });
      }
      if (result.rows.length < SEARCH_PER_PAGE || page >= result.totalPages) break;
    }
  } else {
    for (let page = 1; out.length < MAX_MATCHES_SCANNED; page++) {
      const rows = await listOpenJobs(tx, PUBLIC_VIEWER, {
        ...(saved.params as JobFilters),
        page,
        createdAfter: since,
      });
      for (const j of rows) {
        out.push({ id: j.id, title: j.title, path: j.path, place: j.cityName, createdAt: j.createdAt });
      }
      if (rows.length < JOBS_PER_PAGE) break;
    }
  }

  return out
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id))
    .slice(0, MAX_MATCHES_SCANNED);
}

/* ------------------------------------------------------------ the worker */

function assertWorker(viewer: Viewer): void {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
}

/**
 * The search and where its digest goes, re-read at send time. Null when it
 * has been deleted or unsubscribed, or its owner's address is not verified —
 * there is nobody to send to.
 */
export async function savedSearchForDigest(
  tx: TestDb,
  viewer: Viewer,
  id: string,
): Promise<{ search: SavedSearch; email: string; name: string } | null> {
  assertWorker(viewer);
  if (!UUID.test(id)) return null;
  const [row] = await tx
    .select({ search: savedSearches, email: user.email, name: user.name })
    .from(savedSearches)
    .innerJoin(profiles, eq(profiles.id, savedSearches.userId))
    .innerJoin(user, eq(user.id, profiles.userId))
    .where(and(eq(savedSearches.id, id), eq(savedSearches.isActive, true), eq(user.emailVerified, true)))
    .limit(1);
  return row ?? null;
}

/** After a digest: when it went, and the newest `created_at` it covered. */
export async function markSavedSearchSent(
  tx: TestDb,
  viewer: Viewer,
  id: string,
  input: { sentAt: Date; lastSeenCreatedAt: Date },
): Promise<void> {
  assertWorker(viewer);
  await tx
    .update(savedSearches)
    .set({ lastSentAt: input.sentAt, lastSeenCreatedAt: input.lastSeenCreatedAt, updatedAt: now() })
    .where(eq(savedSearches.id, id));
}

/**
 * The one-click unsubscribe. The signed token (lib/email/unsubscribe.ts) is
 * the proof, so the public viewer may do this; the row is turned off, not
 * deleted, and saving the search again turns it back on. True only when
 * this call changed something.
 */
export async function deactivateSavedSearch(
  tx: TestDb,
  viewer: Viewer,
  id: string,
  ip: string | null,
): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const rows = await tx
    .update(savedSearches)
    .set({ isActive: false, updatedAt: now() })
    .where(and(eq(savedSearches.id, id), eq(savedSearches.isActive, true)))
    .returning({ id: savedSearches.id });
  if (rows.length === 0) return false;
  await writeAudit(tx, viewer, {
    action: "saved_search.unsubscribed",
    entityType: "saved_search",
    entityId: id,
    ip,
  });
  return true;
}

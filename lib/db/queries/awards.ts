import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { siteConfig } from "@/config/site.config";
import { awards, categories, cities, listings, profiles, user } from "@/lib/db/schema";
import { now } from "@/lib/clock";
import { isAdmin, PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { publishedListings } from "@/lib/db/queries/listings";
import { writeAudit } from "@/lib/db/queries/audit";
import { notifyAwardWon } from "@/lib/email/notify";
import type { TestDb } from "@/lib/db/types";

/**
 * Awards (Task 50).
 *
 * An award here is COMPUTED and nothing else: not voted, not nominated, not
 * for sale. Once a year each town × category that has at least three rated,
 * published listings gets one winner — the listing with the highest published
 * rating among those with at least `siteConfig.awards.minReviews` published
 * reviews. Ties go to the listing with more reviews, then to the older
 * listing. The whole method fits in `winnerCandidates` below, and
 * `AWARDS_METHODOLOGY_VERSION` is stamped on every row so a later change to
 * the rule is visible on the rows it did not apply to.
 *
 * Three rules follow from "computed":
 *  - Nothing here writes `listings.rating_avg` / `rating_count`. Those belong
 *    to `recomputeListingRating` in reviews.ts and are only ever read here.
 *  - A run is idempotent. A slot (year × town × category) that already has a
 *    row — revoked or not — is left alone, and the unique index
 *    `awards_year_city_category_key` holds the same line at the database.
 *  - Everything public reads active rows on published listings only: a
 *    revoked award and a taken-down winner both vanish from every page, the
 *    badge and the listing's markup without anyone touching a second table.
 */

export const AWARDS_METHODOLOGY_VERSION = "2026.1";

/** A town × category needs this many rated, published listings before there is a contest at all. */
export const AWARDS_MIN_RATED_LISTINGS = 3;

/** The review floor a winner has to clear when the config does not say. */
export const DEFAULT_AWARDS_MIN_REVIEWS = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The configured review floor: `siteConfig.awards.minReviews`, the default when unset, never below one. */
export function awardsMinReviews(
  configured: { readonly minReviews: number } | undefined = siteConfig.awards,
): number {
  const value = configured?.minReviews;
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_AWARDS_MIN_REVIEWS;
  return Math.max(1, Math.floor(value));
}

/**
 * A year as it arrives in a URL. Four digits and plausible: a route that
 * accepted "02026" or "20260" would serve the same page under two URLs.
 */
export function parseAwardYear(value: string): number | null {
  if (!/^\d{4}$/.test(value)) return null;
  const year = Number(value);
  return year >= 2000 && year < 2200 ? year : null;
}

/** The calendar year `at` falls in, in the site's timezone — not the server's. */
export function awardYearFor(at: Date, timezone: string = siteConfig.timezone): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric" }).format(at));
}

/** Where the winners of a year in a town are listed. */
export const awardsCityPath = (year: number, citySlug: string): string => `/awards/${year}/${citySlug}`;

/**
 * The award as text — what the listing page prints beside the pill and what
 * its LocalBusiness node carries as `award`. One function so they cannot
 * differ (global constraint 11: markup matches visible content).
 */
export function awardText(a: { year: number; categoryName: string; cityName: string }): string {
  return `${siteConfig.name} ${a.year} winner — ${a.categoryName}, ${a.cityName}`;
}

function forbid(): never {
  throw new Error("FORBIDDEN");
}

/* ------------------------------------------------------------------ compute */

export interface CreatedAward {
  awardId: string;
  listingId: string;
  cityId: string;
  citySlug: string;
  categoryId: string;
}

export interface ComputeAwardsResult {
  year: number;
  /** Rows written by this run. */
  created: CreatedAward[];
  /** Slots that had a winner (or a revoked one) already and were left alone. */
  skipped: number;
}

interface Candidate {
  listing_id: string;
  city_id: string;
  city_slug: string;
  category_id: string;
}

/**
 * THE method, as one query: rated published listings, grouped into contests
 * of at least `AWARDS_MIN_RATED_LISTINGS`, ranked inside each contest by
 * average, then count, then age (then id, so two rows created in the same
 * millisecond still order deterministically), floor applied, first row wins.
 *
 * `publishedListings(PUBLIC_VIEWER)` on purpose, not the caller's viewer: the
 * caller is an admin, for whom that gate is `true`, and an award computed over
 * pending and removed rows would be an award to a listing nobody can see.
 */
async function winnerCandidates(tx: TestDb, minReviews: number): Promise<Candidate[]> {
  const rows = (await tx.execute(sql`
    with rated as (
      select ${listings.id} as id,
             ${listings.cityId} as city_id,
             ${listings.primaryCategoryId} as category_id,
             ${listings.ratingAvg} as rating_avg,
             ${listings.ratingCount} as rating_count,
             ${listings.createdAt} as created_at
      from ${listings}
      where ${publishedListings(PUBLIC_VIEWER)}
        and ${listings.ratingCount} > 0
        and ${listings.ratingAvg} is not null
    ),
    contested as (
      select city_id, category_id
      from rated
      group by city_id, category_id
      having count(*) >= ${AWARDS_MIN_RATED_LISTINGS}
    ),
    ranked as (
      select r.id, r.city_id, r.category_id,
             row_number() over (
               partition by r.city_id, r.category_id
               order by r.rating_avg desc, r.rating_count desc, r.created_at asc, r.id asc
             ) as rn
      from rated r
      join contested c on c.city_id = r.city_id and c.category_id = r.category_id
      where r.rating_count >= ${minReviews}
    )
    select ranked.id as listing_id, ranked.city_id, ${cities.slug} as city_slug, ranked.category_id
    from ranked
    join ${cities} on ${cities.id} = ranked.city_id
    where ranked.rn = 1
    order by ranked.city_id, ranked.category_id
  `)) as unknown as Candidate[];
  return Array.from(rows);
}

/**
 * Computes the year's awards. Admin (or the worker) only.
 *
 * Runs inside the caller's transaction: the rows, the winner emails
 * (`notifyAwardWon`, one queued job per award) and the audit row all commit
 * together or not at all. Calling it twice for the same year is safe — see the
 * module comment — and `skipped` says how many slots the second run found
 * already decided.
 */
export async function computeAwardsForYear(
  tx: TestDb,
  viewer: Viewer,
  year: number,
  opts: {
    minReviews?: number;
    /** The admin's address for the audit row (constraint 22). Null from the worker. */
    ip?: string | null;
  } = {},
): Promise<ComputeAwardsResult> {
  if (!isAdmin(viewer)) forbid();
  if (!Number.isInteger(year)) throw new Error(`Not a year: ${String(year)}`);
  const minReviews = opts.minReviews ?? awardsMinReviews();

  const candidates = await winnerCandidates(tx, minReviews);

  const existing = await tx
    .select({ cityId: awards.cityId, categoryId: awards.categoryId })
    .from(awards)
    .where(eq(awards.year, year));
  const taken = new Set(existing.map((e) => `${e.cityId}:${e.categoryId}`));

  const fresh = candidates.filter((c) => !taken.has(`${c.city_id}:${c.category_id}`));
  const skipped = candidates.length - fresh.length;

  const created: CreatedAward[] = [];
  if (fresh.length > 0) {
    const stamp = now();
    const inserted = await tx
      .insert(awards)
      .values(
        fresh.map((c) => ({
          year,
          cityId: c.city_id,
          categoryId: c.category_id,
          listingId: c.listing_id,
          rank: 1,
          methodologyVersion: AWARDS_METHODOLOGY_VERSION,
          publishedAt: stamp,
        })),
      )
      // Belt and braces with the NOT-IN filter above: two runs racing past the
      // read would otherwise both insert, and the unique index says no.
      .onConflictDoNothing()
      .returning({ awardId: awards.id, listingId: awards.listingId, cityId: awards.cityId, categoryId: awards.categoryId });

    const slugByCity = new Map(fresh.map((c) => [c.city_id, c.city_slug]));
    for (const row of inserted) {
      created.push({
        awardId: row.awardId,
        listingId: row.listingId,
        cityId: row.cityId!,
        citySlug: slugByCity.get(row.cityId!) ?? "",
        categoryId: row.categoryId!,
      });
      await notifyAwardWon(tx, viewer, row.awardId);
    }
  }

  await writeAudit(tx, viewer, {
    action: "awards.computed",
    entityType: "awards",
    ip: opts.ip ?? null,
    meta: {
      year,
      created: created.length,
      skipped,
      minReviews,
      methodologyVersion: AWARDS_METHODOLOGY_VERSION,
    },
  });

  return { year, created, skipped };
}

/* ------------------------------------------------------------------- revoke */

export type RevokeAwardResult =
  | { outcome: "revoked"; listingId: string; year: number; citySlug: string }
  | { outcome: "already-revoked" }
  | { outcome: "not-found" };

/**
 * Takes an award back. Admin only; the reason is required and the row, the
 * reason and the admin's IP all go to `audit_log` on the same handle
 * (global constraint 22). The row stays so the slot is not re-awarded.
 */
export async function revokeAward(
  tx: TestDb,
  viewer: Viewer,
  awardId: string,
  input: { reason: string; ip: string | null },
): Promise<RevokeAwardResult> {
  if (!isAdmin(viewer)) forbid();
  if (!UUID.test(awardId)) return { outcome: "not-found" };

  const [row] = await tx
    .select({
      id: awards.id,
      year: awards.year,
      listingId: awards.listingId,
      revokedAt: awards.revokedAt,
      citySlug: cities.slug,
    })
    .from(awards)
    .innerJoin(cities, eq(cities.id, awards.cityId))
    .where(eq(awards.id, awardId))
    .limit(1);
  if (!row) return { outcome: "not-found" };
  if (row.revokedAt !== null) return { outcome: "already-revoked" };

  // The reason is the record. The action checks too, but a caller that
  // forgets must not be able to revoke silently.
  const reason = input.reason.trim();
  if (reason === "") throw new Error("A revoke needs a reason");
  await tx
    .update(awards)
    .set({ revokedAt: now(), revokeReason: reason, updatedAt: now() })
    .where(eq(awards.id, awardId));

  await writeAudit(tx, viewer, {
    action: "award.revoked",
    entityType: "award",
    entityId: awardId,
    meta: { reason, year: row.year, listingId: row.listingId },
    ip: input.ip,
  });

  return { outcome: "revoked", listingId: row.listingId, year: row.year, citySlug: row.citySlug };
}

/* ------------------------------------------------------------- public reads */

/**
 * The public gate, in one place: an active award on a listing the viewer may
 * see. Every read below is built on it.
 */
function activeAwards(viewer: Viewer) {
  return and(isNull(awards.revokedAt), publishedListings(viewer));
}

export interface AwardYear {
  year: number;
  winners: number;
  cities: number;
}

/** Years with at least one active winner, newest first. The /awards index. */
export async function awardYears(tx: TestDb, viewer: Viewer): Promise<AwardYear[]> {
  const rows = await tx
    .select({
      year: awards.year,
      winners: sql<number>`count(*)::int`,
      cities: sql<number>`count(distinct ${awards.cityId})::int`,
    })
    .from(awards)
    .innerJoin(listings, eq(listings.id, awards.listingId))
    .where(activeAwards(viewer))
    .groupBy(awards.year)
    .orderBy(desc(awards.year));
  return rows;
}

export interface AwardCity {
  cityId: string;
  name: string;
  slug: string;
  region: string | null;
  winners: number;
}

/** Towns with at least one active winner in the year, alphabetical. The /awards/[year] page. */
export async function awardCities(tx: TestDb, viewer: Viewer, year: number): Promise<AwardCity[]> {
  return tx
    .select({
      cityId: cities.id,
      name: cities.name,
      slug: cities.slug,
      region: cities.region,
      winners: sql<number>`count(*)::int`,
    })
    .from(awards)
    .innerJoin(listings, eq(listings.id, awards.listingId))
    .innerJoin(cities, eq(cities.id, awards.cityId))
    .where(and(eq(awards.year, year), activeAwards(viewer)))
    .groupBy(cities.id, cities.name, cities.slug, cities.region)
    .orderBy(asc(cities.name));
}

export interface AwardWinner {
  awardId: string;
  category: { id: string; name: string; singular: string };
  listing: {
    id: string;
    name: string;
    slug: string;
    /** The listing's public URL: /[city]/[listing]. */
    path: string;
    ratingAvg: string | null;
    ratingCount: number;
  };
}

export interface AwardWinnersPage {
  year: number;
  city: { id: string; name: string; slug: string; region: string | null };
  winners: AwardWinner[];
}

/**
 * The winners of a year in a town, by category name. Null when there is not
 * at least one, so the page 404s rather than rendering an empty, indexable
 * shell — an awards page with no award on it is a thin page by definition.
 */
export async function awardWinners(
  tx: TestDb,
  viewer: Viewer,
  year: number,
  citySlug: string,
): Promise<AwardWinnersPage | null> {
  const rows = await tx
    .select({
      awardId: awards.id,
      cityId: cities.id,
      cityName: cities.name,
      cityRegion: cities.region,
      categoryId: categories.id,
      categoryName: categories.name,
      categorySingular: categories.singular,
      listingId: listings.id,
      listingName: listings.name,
      listingSlug: listings.slug,
      ratingAvg: listings.ratingAvg,
      ratingCount: listings.ratingCount,
    })
    .from(awards)
    .innerJoin(listings, eq(listings.id, awards.listingId))
    .innerJoin(cities, eq(cities.id, awards.cityId))
    .innerJoin(categories, eq(categories.id, awards.categoryId))
    .where(and(eq(awards.year, year), eq(cities.slug, citySlug), activeAwards(viewer)))
    .orderBy(asc(categories.name), asc(listings.name));
  const first = rows[0];
  if (!first) return null;

  return {
    year,
    city: { id: first.cityId, name: first.cityName, slug: citySlug, region: first.cityRegion },
    winners: rows.map((r) => ({
      awardId: r.awardId,
      category: { id: r.categoryId, name: r.categoryName, singular: r.categorySingular },
      listing: {
        id: r.listingId,
        name: r.listingName,
        slug: r.listingSlug,
        path: `/${citySlug}/${r.listingSlug}`,
        ratingAvg: r.ratingAvg,
        ratingCount: r.ratingCount,
      },
    })),
  };
}

export interface ListingAward {
  awardId: string;
  year: number;
  cityName: string;
  citySlug: string;
  categoryName: string;
  /** The page the pill links to: the year's winners in the listing's town. */
  awardsPath: string;
}

/** A listing's active awards, newest year first. What the listing page and its markup render. */
export async function listingAwards(tx: TestDb, viewer: Viewer, listingId: string): Promise<ListingAward[]> {
  if (!UUID.test(listingId)) return [];
  const rows = await tx
    .select({
      awardId: awards.id,
      year: awards.year,
      cityName: cities.name,
      citySlug: cities.slug,
      categoryName: categories.name,
    })
    .from(awards)
    .innerJoin(listings, eq(listings.id, awards.listingId))
    .innerJoin(cities, eq(cities.id, awards.cityId))
    .innerJoin(categories, eq(categories.id, awards.categoryId))
    .where(and(eq(awards.listingId, listingId), activeAwards(viewer)))
    .orderBy(desc(awards.year));
  return rows.map((r) => ({ ...r, awardsPath: awardsCityPath(r.year, r.citySlug) }));
}

/** Award years per listing for a page of cards, newest first. Listings with none are absent from the map. */
export async function awardYearsForListings(
  tx: TestDb,
  viewer: Viewer,
  listingIds: readonly string[],
): Promise<Map<string, number[]>> {
  const ids = listingIds.filter((id) => UUID.test(id));
  const out = new Map<string, number[]>();
  if (ids.length === 0) return out;
  const rows = await tx
    .select({ listingId: awards.listingId, year: awards.year })
    .from(awards)
    .innerJoin(listings, eq(listings.id, awards.listingId))
    .where(and(inArray(awards.listingId, ids), activeAwards(viewer)))
    .orderBy(desc(awards.year));
  for (const r of rows) out.set(r.listingId, [...(out.get(r.listingId) ?? []), r.year]);
  return out;
}

/** The badge route's question: may this listing show the "award-<year>" style? */
export async function hasAwardForYear(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
  year: number,
): Promise<boolean> {
  if (!UUID.test(listingId)) return false;
  const [row] = await tx
    .select({ id: awards.id })
    .from(awards)
    .innerJoin(listings, eq(listings.id, awards.listingId))
    .where(and(eq(awards.listingId, listingId), eq(awards.year, year), activeAwards(viewer)))
    .limit(1);
  return row !== undefined;
}

/* ------------------------------------------------------------- notification */

export interface AwardNotification {
  awardId: string;
  year: number;
  listingName: string;
  listingPath: string;
  cityName: string;
  citySlug: string;
  categoryName: string;
  /**
   * Owner's account address first; the listing's own address second, but
   * only once the listing is claimed; otherwise nobody. Same rule as the
   * enquiry email (worker/jobs/notify.ts): an unclaimed listing's contact
   * address is one we hold, not one anybody asked us to write to.
   */
  recipient: string | null;
  revoked: boolean;
}

/**
 * Everything the winner email needs, re-read at send time. Admin-gated: it
 * turns an id into somebody's email address, and only the worker holds one.
 */
export async function awardNotification(
  tx: TestDb,
  viewer: Viewer,
  awardId: string,
): Promise<AwardNotification | null> {
  if (!isAdmin(viewer)) forbid();
  if (!UUID.test(awardId)) return null;
  const [row] = await tx
    .select({
      awardId: awards.id,
      year: awards.year,
      revokedAt: awards.revokedAt,
      listingName: listings.name,
      listingSlug: listings.slug,
      listingEmail: listings.email,
      claimStatus: listings.claimStatus,
      cityName: cities.name,
      citySlug: cities.slug,
      categoryName: categories.name,
      ownerEmail: user.email,
    })
    .from(awards)
    .innerJoin(listings, eq(listings.id, awards.listingId))
    .innerJoin(cities, eq(cities.id, awards.cityId))
    .innerJoin(categories, eq(categories.id, awards.categoryId))
    .leftJoin(profiles, eq(profiles.id, listings.ownerId))
    .leftJoin(user, eq(user.id, profiles.userId))
    .where(eq(awards.id, awardId))
    .limit(1);
  if (!row) return null;

  const owner = row.ownerEmail?.trim() ?? "";
  const listed = row.claimStatus === "unclaimed" ? "" : (row.listingEmail?.trim() ?? "");
  return {
    awardId: row.awardId,
    year: row.year,
    listingName: row.listingName,
    listingPath: `/${row.citySlug}/${row.listingSlug}`,
    cityName: row.cityName,
    citySlug: row.citySlug,
    categoryName: row.categoryName,
    recipient: owner !== "" ? owner : listed !== "" ? listed : null,
    revoked: row.revokedAt !== null,
  };
}

/* -------------------------------------------------------------- admin reads */

export interface AdminAwardYear {
  year: number;
  winners: number;
  revoked: number;
}

/** Every year with a row, active and revoked counted apart. */
export async function adminAwardYears(tx: TestDb, viewer: Viewer): Promise<AdminAwardYear[]> {
  if (!isAdmin(viewer)) forbid();
  return tx
    .select({
      year: awards.year,
      winners: sql<number>`count(*) filter (where ${awards.revokedAt} is null)::int`,
      revoked: sql<number>`count(*) filter (where ${awards.revokedAt} is not null)::int`,
    })
    .from(awards)
    .groupBy(awards.year)
    .orderBy(desc(awards.year));
}

export interface AdminAward {
  awardId: string;
  year: number;
  listingId: string;
  listingName: string;
  listingPath: string;
  listingStatus: typeof listings.$inferSelect.status;
  cityName: string;
  citySlug: string;
  categoryName: string;
  ratingAvg: string | null;
  ratingCount: number;
  publishedAt: Date | null;
  revokedAt: Date | null;
  revokeReason: string | null;
}

/** Every award row for a year, whatever its state, by town then category. */
export async function adminAwardsForYear(tx: TestDb, viewer: Viewer, year: number): Promise<AdminAward[]> {
  if (!isAdmin(viewer)) forbid();
  const rows = await tx
    .select({
      awardId: awards.id,
      year: awards.year,
      listingId: listings.id,
      listingName: listings.name,
      listingSlug: listings.slug,
      listingStatus: listings.status,
      cityName: cities.name,
      citySlug: cities.slug,
      categoryName: categories.name,
      ratingAvg: listings.ratingAvg,
      ratingCount: listings.ratingCount,
      publishedAt: awards.publishedAt,
      revokedAt: awards.revokedAt,
      revokeReason: awards.revokeReason,
    })
    .from(awards)
    .innerJoin(listings, eq(listings.id, awards.listingId))
    .innerJoin(cities, eq(cities.id, awards.cityId))
    .innerJoin(categories, eq(categories.id, awards.categoryId))
    .where(eq(awards.year, year))
    .orderBy(asc(cities.name), asc(categories.name));
  return rows.map(({ listingSlug, ...r }) => ({ ...r, listingPath: `/${r.citySlug}/${listingSlug}` }));
}

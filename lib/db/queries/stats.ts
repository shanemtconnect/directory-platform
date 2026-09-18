import { and, eq, gte, lt, lte, sql } from "drizzle-orm";
import { listingStatsDaily, listings, profiles } from "@/lib/db/schema";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";
import type { TierName } from "@/config/types";
import { siteConfig } from "@/config/site.config";
import { now } from "@/lib/clock";
import { dayRange, isDayKey, isUuid } from "@/lib/stats/keys";
import type { StatDelta } from "@/lib/stats/counters";

/**
 * The owner ROI numbers: the read side of the stats pipeline, and the write
 * the worker's flush performs.
 *
 * Both live here rather than in `lib/stats/` because constraint 6 is absolute
 * — every database access in this codebase goes through `lib/db/queries/`, and
 * the flush job is not an exception just because it runs on a cron.
 */

/** One day's counts. Zero-filled: a day with no traffic is a row of zeros. */
export interface StatsDay {
  /** `YYYY-MM-DD` in the site's timezone. */
  day: string;
  views: number;
  impressions: number;
  enquiries: number;
  shortlistAdds: number;
  badgeClicks: number;
}

export type StatsTotals = Omit<StatsDay, "day">;

/**
 * What `components/stats/ListingStats.tsx` renders, and what Task 17's owner
 * pages pass into it. Everything the component needs to explain itself —
 * including why the window is as long as it is — is in here, so the component
 * never reaches for the config or the clock of its own accord.
 */
export interface ListingStatsResult {
  listingId: string;
  listingName: string;
  tier: TierName;
  /** Days actually returned. */
  windowDays: number;
  /** Days the caller asked for, before the tier cap. */
  requestedDays: number;
  /** `siteConfig.tiers[tier].statsWindowDays`. */
  capDays: number;
  /** True when the tier cap shortened the window — the upgrade prompt's cue. */
  capped: boolean;
  days: StatsDay[];
  totals: StatsTotals;
}

/**
 * A ceiling independent of the tier cap.
 *
 * `statsWindowDays` is niche config and a clone can set it to anything; this
 * is the guard that stops a typo turning an owner page into a full scan of
 * `listing_stats_daily`.
 */
export const MAX_STATS_WINDOW_DAYS = 730;

/**
 * `applyStatDeltas` folds a Redis drain straight into `listing_stats_daily`,
 * bypassing every visibility filter the read side applies — exactly what the
 * worker's flush needs, and exactly what a public or owner viewer must never
 * be able to trigger. See `lib/db/queries/jobs.ts` for the same gate on the
 * job queue.
 */
function assertWorker(viewer: Viewer): void {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
}

function zeroDay(day: string): StatsDay {
  return { day, views: 0, impressions: 0, enquiries: 0, shortlistAdds: 0, badgeClicks: 0 };
}

/**
 * A listing's daily stats, gated to its owner and to admins.
 *
 * Ownership is `listings.owner_id = profiles.id` of the signed-in user
 * (constraint 24), resolved by a join rather than by `ensureProfile`: this is
 * a read, and a read path that inserts a row is a read path that writes on
 * every crawl of a page it is mounted on.
 *
 * Deliberately not behind `publishedListings()`. Every other public query
 * filters to published rows; this one must not, because an owner whose listing
 * is archived or pending still needs the history of the months they paid for.
 * The gate here is ownership, not visibility.
 *
 * @returns null for the public viewer, a non-owner, an unknown listing or a
 *   malformed id — one indistinguishable answer, so this cannot be used to
 *   probe which listing ids exist.
 */
export async function listingStats(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
  days: number,
): Promise<ListingStatsResult | null> {
  if (viewer.role === "public") return null;
  if (!isUuid(listingId)) return null;

  const [row] = await tx
    .select({
      id: listings.id,
      name: listings.name,
      tier: listings.tier,
      ownerUserId: profiles.userId,
    })
    .from(listings)
    .leftJoin(profiles, eq(profiles.id, listings.ownerId))
    .where(eq(listings.id, listingId))
    .limit(1);

  if (!row) return null;
  if (viewer.role !== "admin" && row.ownerUserId !== viewer.userId) return null;

  const capDays = Math.min(
    MAX_STATS_WINDOW_DAYS,
    Math.max(1, Math.floor(siteConfig.tiers[row.tier].statsWindowDays)),
  );
  // `Math.max(1, …)` before the cap, so NaN and negatives land on one day
  // rather than on an empty window or a reversed range.
  const requested = Number.isFinite(days) ? Math.max(1, Math.floor(days)) : 1;
  const windowDays = Math.min(requested, capDays);

  const range = dayRange(now(), windowDays);
  const first = range[0]!;
  const last = range.at(-1)!;

  const rows = await tx
    .select({
      day: listingStatsDaily.day,
      views: listingStatsDaily.views,
      impressions: listingStatsDaily.impressions,
      enquiries: listingStatsDaily.enquiries,
      shortlistAdds: listingStatsDaily.shortlistAdds,
      badgeClicks: listingStatsDaily.badgeClicks,
    })
    .from(listingStatsDaily)
    .where(and(
      eq(listingStatsDaily.listingId, listingId),
      gte(listingStatsDaily.day, first),
      lte(listingStatsDaily.day, last),
    ));

  const byDay = new Map(rows.map((r) => [r.day, r]));
  const totals: StatsTotals = {
    views: 0, impressions: 0, enquiries: 0, shortlistAdds: 0, badgeClicks: 0,
  };
  const filled = range.map((day) => {
    const found = byDay.get(day);
    if (!found) return zeroDay(day);
    totals.views += found.views;
    totals.impressions += found.impressions;
    totals.enquiries += found.enquiries;
    totals.shortlistAdds += found.shortlistAdds;
    totals.badgeClicks += found.badgeClicks;
    return found;
  });

  return {
    listingId: row.id,
    listingName: row.name,
    tier: row.tier,
    windowDays,
    requestedDays: Number.isFinite(days) ? Math.max(1, Math.floor(days)) : 1,
    capDays,
    capped: windowDays < requested,
    days: filled,
    totals,
  };
}

/**
 * The flush's write: add a batch of drained counters to `listing_stats_daily`.
 *
 * Additive, never a replace. The job runs every five minutes, so the second
 * run of a day is adding to the first four minutes' counts; `set views =
 * excluded.views` would silently reset the day to the last five minutes.
 *
 * One statement for the whole batch, and the `join listings` is what makes it
 * safe: a delta for a listing deleted since the counter was written would
 * otherwise raise a foreign-key violation and take the entire batch — every
 * other listing's counts included — down with it.
 *
 * The join takes published listings only. The beacon accepts any well-formed
 * uuid, so a delta can name a listing that is pending, rejected or archived;
 * nothing public renders those, so a view against one is a stale cache or a
 * forgery, and a row here would be a number nobody earned. Reading history
 * (`listingStats`) is deliberately NOT gated the same way: months a listing
 * was live stay visible to its owner after it comes down.
 *
 * The same batch also moves `listings.view_count`, which is the lifetime
 * total — the number the admin and owner tables sort by. Nothing else writes
 * it: a page view is never a database write (that is the whole pipeline),
 * so the flush is the one place "views, ever" can be kept true. The views
 * are summed per listing first so a batch straddling midnight is one UPDATE
 * per listing, not one per day, and the same published-only join applies.
 *
 * @returns how many (listing, day) rows were written.
 */
export async function applyStatDeltas(
  tx: TestDb,
  viewer: Viewer,
  deltas: StatDelta[],
): Promise<number> {
  assertWorker(viewer);

  const valid = deltas.filter((d) =>
    isUuid(d.listingId)
    && isDayKey(d.day)
    && (d.views > 0 || d.impressions > 0 || d.enquiries > 0
      || d.shortlistAdds > 0 || d.badgeClicks > 0));
  if (valid.length === 0) return 0;

  const rows = sql.join(
    valid.map((d) => sql`(
      ${d.listingId}::uuid, ${d.day}::date,
      ${Math.trunc(d.views)}::int, ${Math.trunc(d.impressions)}::int,
      ${Math.trunc(d.enquiries)}::int, ${Math.trunc(d.shortlistAdds)}::int,
      ${Math.trunc(d.badgeClicks)}::int
    )`),
    sql`, `,
  );

  const written = (await tx.execute(sql`
    insert into listing_stats_daily
      (listing_id, day, views, impressions, enquiries, shortlist_adds, badge_clicks)
    select v.listing_id, v.day, v.views, v.impressions, v.enquiries, v.shortlist_adds, v.badge_clicks
      from (values ${rows})
        as v(listing_id, day, views, impressions, enquiries, shortlist_adds, badge_clicks)
      join listings l on l.id = v.listing_id and l.status = 'published'
    on conflict (listing_id, day) do update set
      views          = listing_stats_daily.views          + excluded.views,
      impressions    = listing_stats_daily.impressions    + excluded.impressions,
      enquiries      = listing_stats_daily.enquiries      + excluded.enquiries,
      shortlist_adds = listing_stats_daily.shortlist_adds + excluded.shortlist_adds,
      badge_clicks   = listing_stats_daily.badge_clicks   + excluded.badge_clicks,
      updated_at     = now()
    returning listing_stats_daily.id
  `)) as unknown as unknown[];

  const lifetime = new Map<string, number>();
  for (const d of valid) {
    const views = Math.trunc(d.views);
    if (views > 0) lifetime.set(d.listingId, (lifetime.get(d.listingId) ?? 0) + views);
  }
  if (lifetime.size > 0) {
    const totals = sql.join(
      [...lifetime].map(([listingId, views]) => sql`(${listingId}::uuid, ${views}::int)`),
      sql`, `,
    );
    await tx.execute(sql`
      update listings l
         set view_count = l.view_count + v.views
        from (values ${totals}) as v(listing_id, views)
       where l.id = v.listing_id and l.status = 'published'
    `);
  }

  return written.length;
}

/**
 * The retention purge's write: delete every `listing_stats_daily` row whose
 * day is before `cutoffDay` (exclusive — the cutoff day itself is the oldest
 * day kept). The worker computes the cutoff from `siteConfig.stats.retentionDays`
 * (`worker/jobs/purge-stats.ts`); this only does the delete, and refuses a
 * cutoff that is not a `YYYY-MM-DD` so nothing but a date reaches the WHERE.
 *
 * Nothing else is touched: `listings.view_count` is the lifetime total and
 * outlives the daily rows on purpose.
 *
 * @returns how many rows went.
 */
export async function purgeStatsBefore(
  tx: TestDb,
  viewer: Viewer,
  cutoffDay: string,
): Promise<number> {
  assertWorker(viewer);
  if (!isDayKey(cutoffDay)) throw new Error(`purgeStatsBefore: not a day: ${cutoffDay}`);
  const gone = await tx
    .delete(listingStatsDaily)
    .where(lt(listingStatsDaily.day, cutoffDay))
    .returning({ id: listingStatsDaily.id });
  return gone.length;
}

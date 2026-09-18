import { and, eq, sql } from "drizzle-orm";
import { badges, categories, cities, listings } from "@/lib/db/schema";
import { domainOfWebsite } from "@/lib/claims/domain";
import { writeAuditAs } from "@/lib/db/queries/audit";
import { publishedListings } from "@/lib/db/queries/listings";
import { now } from "@/lib/clock";
import { isAdmin, PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";

/**
 * The one lookup behind the embeddable badge, used by both the SVG route and
 * the "get your badge" page.
 *
 * The badge is served to third-party websites, which makes it the most public
 * thing here: an unpublished, rejected or removed listing must not be able to
 * display one. Same rule as every other public read — published only, unless
 * the viewer is an admin.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BadgeListing {
  id: string;
  name: string;
  slug: string;
  claimStatus: typeof listings.$inferSelect.claimStatus;
  ratingAvg: string | null;
  ratingCount: number;
  citySlug: string;
  cityName: string;
  /** Null when the listing has no primary category. */
  categoryName: string | null;
}

export async function badgeListing(
  tx: TestDb,
  viewer: Viewer,
  id: string,
): Promise<BadgeListing | null> {
  // The id comes from a URL or a query string, so it is checked before it
  // reaches a uuid column: Postgres answers a malformed one with an exception.
  if (!UUID.test(id)) return null;

  const [row] = await tx
    .select({
      id: listings.id,
      name: listings.name,
      slug: listings.slug,
      claimStatus: listings.claimStatus,
      ratingAvg: listings.ratingAvg,
      ratingCount: listings.ratingCount,
      citySlug: cities.slug,
      cityName: cities.name,
      categoryName: categories.name,
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .leftJoin(categories, eq(categories.id, listings.primaryCategoryId))
    .where(and(eq(listings.id, id), publishedListings(viewer)))
    .limit(1);

  return row ?? null;
}

// ---------------------------------------------------------------------------
// Backlink registration, the check schedule, and the counter flush.
// ---------------------------------------------------------------------------

/**
 * What a verified backlink is worth in the ranking.
 *
 * It is written to `listings.backlink_boost`, NOT to `rank_boost`. Sharing
 * `rank_boost` forced the reward to be a clamped delta (0..5) so a weekly job
 * could not stack it — and that clamp was applied to the admin's own value,
 * so a deliberate +40 came back as 5 and a -10 penalty was floored to 0 the
 * first time a badge verified. This column has one writer and one meaning, so
 * the value is simply SET rather than added: five when the link is there, zero
 * when it is not, however many times the job runs. `lib/db/sort.ts` adds the
 * two columns.
 *
 * `listings.tier` is billing's and nothing else writes it (constraint 31).
 */
export const BACKLINK_RANK_BOOST = 5;

/** A verified link is re-checked weekly; one we have never seen work, daily. */
export const BACKLINK_RECHECK_VERIFIED_HOURS = 24 * 7;
export const BACKLINK_RECHECK_UNVERIFIED_HOURS = 24;

/** Badges per job run. The fetches are sequential and each can take 10s. */
const DUE_BATCH = 100;

function forbid(): never {
  throw new Error("FORBIDDEN");
}

export interface RegisterBacklinkInput {
  listingId: string;
  /** The page on the owner's own site carrying the badge. */
  url: string;
  /**
   * `profiles.id` of whoever is acting — never `viewer.userId`, which is
   * Better Auth's text id (constraint 21). It is also the ownership check:
   * `listings.owner_id` holds a profile id (constraint 24).
   */
  actorProfileId: string | null;
  ip?: string | null;
}

/**
 * The longest URL the field accepts. Nothing a page carrying a badge lives at
 * needs more, and the worker's fetcher has to hold whatever is stored.
 */
export const BACKLINK_URL_MAX_LENGTH = 2048;

/**
 * Every way a registration can be refused, as a value the form renders.
 *
 * These are answers to a person typing into a field, not programming errors,
 * so they come back rather than being thrown — a thrown "domain mismatch"
 * would reach the owner as a generic failure with the reason in a server log
 * they cannot read. The two things that ARE thrown (`FORBIDDEN` for the public
 * viewer and a malformed id) can only be reached by a caller that skipped the
 * session gate or the form.
 */
export type RegisterBacklinkResult =
  | { outcome: "registered"; badgeId: string; url: string }
  | { outcome: "not-owner" }
  | { outcome: "too-long" }
  | { outcome: "invalid-url" }
  | { outcome: "wrong-scheme" }
  /** The listing's `website` column is empty or is not a public domain. */
  | { outcome: "no-website" }
  | { outcome: "domain-mismatch"; expected: string };

/**
 * Records where an owner has embedded their badge, so the worker can go and
 * look for the link.
 *
 * The page has to be on the listing's own domain — the apex, `www`, or a
 * subdomain of the domain in `listings.website`, judged on label boundaries by
 * the same rules the claim ladder uses (`lib/claims/domain.ts`). A backlink
 * from anywhere else is not the business linking to its own listing, it is a
 * page somebody else controls, and rewarding it with a ranking boost would
 * turn the badge into a link-buying scheme with extra steps.
 *
 * Changing the URL resets the verification. Carrying `backlink_verified`
 * across a URL change would let anyone hold a permanent +5 by verifying once
 * and then pointing the field at a page nobody has checked. Re-registering
 * the SAME URL keeps the flag and the boost but clears `last_checked_at`, so
 * "check now" on the owner page makes the badge due on the next hourly run
 * instead of in a week.
 */
export async function registerBacklink(
  tx: TestDb,
  viewer: Viewer,
  input: RegisterBacklinkInput,
): Promise<RegisterBacklinkResult> {
  if (viewer.role === "public") forbid();
  if (!UUID.test(input.listingId)) forbid();

  // Length first, on the raw input: a 3 MB string is refused for being 3 MB,
  // not handed to the URL parser to find out what else is wrong with it.
  const raw = input.url.trim();
  if (raw.length > BACKLINK_URL_MAX_LENGTH) return { outcome: "too-long" };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { outcome: "invalid-url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { outcome: "wrong-scheme" };
  const href = url.toString();

  const [listing] = await tx
    .select({ id: listings.id, ownerId: listings.ownerId, website: listings.website })
    .from(listings)
    .where(eq(listings.id, input.listingId))
    .limit(1);
  if (!listing) forbid();

  if (!isAdmin(viewer)) {
    // The page enforces nothing; this does (constraint 24).
    if (input.actorProfileId === null || listing.ownerId !== input.actorProfileId) {
      return { outcome: "not-owner" };
    }
  }

  const expected = domainOfWebsite(listing.website);
  if (expected === null) return { outcome: "no-website" };
  const host = domainOfWebsite(href);
  if (host === null || (host !== expected && !host.endsWith(`.${expected}`))) {
    return { outcome: "domain-mismatch", expected };
  }

  const [existing] = await tx
    .select({
      id: badges.id,
      backlinkUrl: badges.backlinkUrl,
      backlinkVerified: badges.backlinkVerified,
    })
    .from(badges)
    .where(eq(badges.listingId, input.listingId))
    .limit(1);

  let badgeId: string;
  if (!existing) {
    const [created] = await tx
      .insert(badges)
      .values({ listingId: input.listingId, backlinkUrl: href })
      .returning({ id: badges.id });
    badgeId = created!.id;
  } else {
    badgeId = existing.id;
    const changed = existing.backlinkUrl !== href;
    await tx
      .update(badges)
      .set(
        changed
          ? { backlinkUrl: href, backlinkVerified: false, lastCheckedAt: null }
          : { backlinkUrl: href, lastCheckedAt: null },
      )
      .where(eq(badges.id, badgeId));
    if (changed && existing.backlinkVerified) await removeBacklinkBoost(tx, input.listingId);
  }

  // Constraint 22: an owner mutation, audited in the same transaction.
  await writeAuditAs(tx, input.actorProfileId, {
    action: "badge.backlink.register",
    entityType: "listing",
    entityId: input.listingId,
    meta: { url: href },
    ip: input.ip ?? null,
  });

  return { outcome: "registered", badgeId, url: href };
}

export interface DueBadge {
  id: string;
  listingId: string;
  backlinkUrl: string;
  backlinkVerified: boolean;
  /** Enough to rebuild the canonical listing URL the link has to point at. */
  citySlug: string;
  listingSlug: string;
}

/**
 * The badges whose backlink is due a look.
 *
 * Unpublished listings are excluded: a badge on a removed listing is not a
 * link we want to reward, and re-checking it is a fetch of somebody else's
 * site for nothing.
 */
export async function badgesDueForCheck(
  tx: TestDb,
  viewer: Viewer,
  opts: { at: Date; limit?: number },
): Promise<DueBadge[]> {
  if (!isAdmin(viewer)) forbid();
  const limit = opts.limit ?? DUE_BATCH;

  const rows = await tx
    .select({
      id: badges.id,
      listingId: badges.listingId,
      backlinkUrl: badges.backlinkUrl,
      backlinkVerified: badges.backlinkVerified,
      citySlug: cities.slug,
      listingSlug: listings.slug,
    })
    .from(badges)
    .innerJoin(listings, eq(listings.id, badges.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(
      and(
        // The worker's viewer is an admin, for whom the gate is open; only a
        // published listing's badge is worth checking.
        publishedListings(PUBLIC_VIEWER),
        sql`coalesce(trim(${badges.backlinkUrl}), '') <> ''`,
        sql`(
          ${badges.lastCheckedAt} is null
          or ${badges.lastCheckedAt} < ${opts.at.toISOString()}::timestamptz - (
            case when ${badges.backlinkVerified}
              then ${sql.raw(String(BACKLINK_RECHECK_VERIFIED_HOURS))}
              else ${sql.raw(String(BACKLINK_RECHECK_UNVERIFIED_HOURS))} end
          ) * interval '1 hour'
        )`,
      ),
    )
    // Never-checked first, then stalest. A badge cannot be starved by newer ones.
    .orderBy(sql`${badges.lastCheckedAt} asc nulls first`)
    .limit(limit);

  return rows.map((r) => ({ ...r, backlinkUrl: r.backlinkUrl! }));
}

async function removeBacklinkBoost(tx: TestDb, listingId: string): Promise<void> {
  await tx
    .update(listings)
    .set({ backlinkBoost: 0 })
    .where(eq(listings.id, listingId));
}

/**
 * Stamps the outcome of one backlink check.
 *
 * The boost is SET, not added, so re-running the job is a no-op: a link
 * verified for a year is worth exactly +5, not +260. It still only writes on a
 * transition, which keeps the listing row out of the update path on the
 * overwhelmingly common "nothing changed" check.
 */
export async function recordBacklinkCheck(
  tx: TestDb,
  viewer: Viewer,
  opts: { badgeId: string; verified: boolean; at?: Date },
): Promise<{ changed: boolean }> {
  if (!isAdmin(viewer)) forbid();
  if (!UUID.test(opts.badgeId)) return { changed: false };

  const [badge] = await tx
    .select({
      id: badges.id,
      listingId: badges.listingId,
      backlinkVerified: badges.backlinkVerified,
    })
    .from(badges)
    .where(eq(badges.id, opts.badgeId))
    .limit(1);
  if (!badge) return { changed: false };

  // Stamped whatever happened: a failed check is still a check, and without
  // the stamp the job picks the same dead URL up on every single run.
  await tx
    .update(badges)
    .set({ backlinkVerified: opts.verified, lastCheckedAt: opts.at ?? now() })
    .where(eq(badges.id, badge.id));

  const changed = badge.backlinkVerified !== opts.verified;
  if (changed) {
    await tx
      .update(listings)
      .set({ backlinkBoost: opts.verified ? BACKLINK_RANK_BOOST : 0 })
      .where(eq(listings.id, badge.listingId));
  }
  return { changed };
}

export interface BadgeCounterDelta {
  listingId: string;
  impressions: number;
  clicks: number;
}

/**
 * Applies a flush of the Redis impression/click counters.
 *
 * The listing ids come from a public URL, so unknown and malformed ones are
 * dropped rather than thrown on: the counters have already been taken out of
 * Redis by the time this runs, and an exception here would lose the whole
 * batch over one hotlinked piece of rubbish.
 */
export async function applyBadgeCounters(
  tx: TestDb,
  viewer: Viewer,
  deltas: BadgeCounterDelta[],
): Promise<number> {
  if (!isAdmin(viewer)) forbid();

  let applied = 0;
  for (const delta of deltas) {
    const impressions = Math.max(0, Math.trunc(delta.impressions));
    const clicks = Math.max(0, Math.trunc(delta.clicks));
    if (impressions === 0 && clicks === 0) continue;
    if (!UUID.test(delta.listingId)) continue;

    const [existing] = await tx
      .select({ id: badges.id })
      .from(badges)
      .where(eq(badges.listingId, delta.listingId))
      .limit(1);

    if (existing) {
      await tx
        .update(badges)
        .set({
          impressionCount: sql`${badges.impressionCount} + ${impressions}`,
          clickCount: sql`${badges.clickCount} + ${clicks}`,
        })
        .where(eq(badges.id, existing.id));
      applied++;
      continue;
    }

    // No badge row yet — the SVG route serves any published listing. Insert
    // one, but only for a listing that exists, or the FK throws.
    const [listing] = await tx
      .select({ id: listings.id })
      .from(listings)
      .where(eq(listings.id, delta.listingId))
      .limit(1);
    if (!listing) continue;

    await tx
      .insert(badges)
      .values({ listingId: delta.listingId, impressionCount: impressions, clickCount: clicks });
    applied++;
  }
  return applied;
}

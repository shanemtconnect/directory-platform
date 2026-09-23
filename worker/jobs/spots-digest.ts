import { siteConfig } from "@/config/site.config";
import { now } from "@/lib/clock";
import { writeAuditAs } from "@/lib/db/queries/audit";
import { digestSentForMonth, eligibleListingIds } from "@/lib/db/queries/spots";
import { notifySpotDigest } from "@/lib/email/notify";
import { availabilityForListing, emptySpotsReport } from "@/lib/spots/availability";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { Db } from "@/lib/db/client";
import type { TestDb } from "@/lib/db/types";

/**
 * The monthly availability digest (Task 45, requirement 2).
 *
 * Fires every Monday at 09:00 in the SITE's zone and keeps only the first
 * Monday of the month — node-cron's day-of-month and day-of-week fields do
 * not intersect the way the requirement needs, so the job decides. Once per
 * month, marked by an audit row (`spots.digest_sent`, meta.month), so a
 * worker restarted on the morning does not send it twice.
 *
 * What it queues, not sends: one `notify.spot.digest` job per verified,
 * paying listing whose pages have a free spot it does not hold, and one for
 * the admin. The worker recomputes each at send time and honours
 * `unsubscribes` (also checked here, so an opted-out address is never even
 * queued).
 */

export const SPOTS_DIGEST_CRON = "0 9 * * 1";
export const DIGEST_SENT_ACTION = "spots.digest_sent";

export function spotsDigestCronOptions(): { timezone: string } {
  return { timezone: siteConfig.timezone };
}

interface ZonedDay {
  readonly month: string;
  readonly day: number;
  readonly weekday: string;
}

function zonedDay(at: Date, timezone: string): ZonedDay {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { month: `${get("year")}-${get("month")}`, day: Number(get("day")), weekday: get("weekday") };
}

export function isFirstMonday(at: Date, timezone: string): boolean {
  const d = zonedDay(at, timezone);
  return d.weekday === "Mon" && d.day <= 7;
}

export interface SpotsDigestResult {
  readonly skipped?: "not-first-monday" | "already-sent";
  readonly queued: number;
  readonly admin: boolean;
}

export async function runSpotsDigest(
  db: Db | TestDb,
  opts: { readonly force?: boolean } = {},
): Promise<SpotsDigestResult> {
  const tx = db as TestDb;
  const at = now();
  const { month } = zonedDay(at, siteConfig.timezone);
  if (!opts.force && !isFirstMonday(at, siteConfig.timezone)) {
    return { skipped: "not-first-monday", queued: 0, admin: false };
  }
  if (!opts.force && (await digestSentForMonth(tx, ADMIN_VIEWER, month))) {
    return { skipped: "already-sent", queued: 0, admin: false };
  }

  let queued = 0;
  for (const listingId of await eligibleListingIds(tx, ADMIN_VIEWER)) {
    const a = await availabilityForListing(tx, ADMIN_VIEWER, listingId);
    if (a === null || a.emptyCount === 0 || a.ownerEmail === null || a.unsubscribed) continue;
    await notifySpotDigest(tx, ADMIN_VIEWER, { listingId });
    queued += 1;
  }
  const report = await emptySpotsReport(tx, ADMIN_VIEWER);
  const admin = report.some((r) => r.status === "open" && r.filled < r.positions);
  if (admin) await notifySpotDigest(tx, ADMIN_VIEWER, { admin: true });

  await writeAuditAs(tx, null, {
    action: DIGEST_SENT_ACTION,
    entityType: "featured_spot",
    meta: { month, queued, admin },
  });
  return { queued, admin };
}

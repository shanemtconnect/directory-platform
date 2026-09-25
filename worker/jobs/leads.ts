import { and, eq, sql } from "drizzle-orm";
import { siteConfig } from "@/config/site.config";
import { now } from "@/lib/clock";
import { auditLog } from "@/lib/db/schema";
import { writeAuditAs } from "@/lib/db/queries/audit";
import { boardDigestFor, boardDigestRecipients, openLeadPlaces, sweepLeads } from "@/lib/db/queries/lead-market";
import { retryAllocation } from "@/lib/leads/allocate";
import { notifyLeadBoardDigest } from "@/lib/email/notify";
import { ADMIN_VIEWER } from "@/worker/viewer";
import { db as client, type Db } from "@/lib/db/client";
import type { TestDb } from "@/lib/db/types";

/**
 * The lead market's crons (Task 58). worker/index.ts schedules them only
 * with `leadMarketplace` on.
 *
 *  - `leads.sweep`, hourly: open leads past `expires_at` leave the board
 *    (`expired`); unsold expired or deleted rows go 7 days after expiry; a
 *    sold lead's contact details are purged `retainSoldDays` after the sale.
 *  - `leads.retry_allocate`, hourly: open leads are offered to standing
 *    orders created, edited or resumed in the last run's window.
 *  - `leads.board_digest`, Mondays 09:00 in the site's zone: one digest job
 *    per account with an active order or a purchase in 90 days. Marked by an
 *    audit row per week, so a restart on the morning does not send twice.
 */

export const LEADS_SWEEP_CRON = "13 * * * *";
export const LEADS_RETRY_CRON = "43 * * * *";
export const LEADS_DIGEST_CRON = "0 9 * * 1";
export const DIGEST_SENT_ACTION = "leads.board_digest_sent";

/** An hour between runs plus ten minutes' slack, so an order saved just before a late tick is not missed. */
export const RETRY_LOOKBACK_MS = 70 * 60_000;

export function leadsDigestCronOptions(): { timezone: string } {
  return { timezone: siteConfig.timezone };
}

export async function runLeadsSweep(
  db: Db | TestDb, at: Date = now(),
): Promise<{ expired: number; deleted: number; purged: number }> {
  const out = await sweepLeads(db as TestDb, ADMIN_VIEWER, at);
  if (out.expired + out.deleted + out.purged > 0) {
    console.log(`[worker] leads.sweep expired ${out.expired}, deleted ${out.deleted}, purged ${out.purged} sold lead(s)' contact details`);
  }
  return out;
}

/**
 * The leads are found on the job's transaction (which holds only the job's
 * own lock), then each is allocated in a transaction of its own on the
 * shared client and committed before the next — see `retryAllocation`.
 */
export async function runLeadsRetryAllocate(db: Db | TestDb, at: Date = now()): Promise<{ checked: number; sold: number }> {
  const out = await retryAllocation(db as TestDb, ADMIN_VIEWER, {
    since: new Date(at.getTime() - RETRY_LOOKBACK_MS),
    at,
    each: (fn) => client.transaction(async (t) => fn(t as unknown as TestDb)),
  });
  if (out.checked > 0) console.log(`[worker] leads.retry_allocate checked ${out.checked}, sold ${out.sold}`);
  return out;
}

/** The Monday (in the site's zone) of the week `at` falls in, as YYYY-MM-DD. */
export function weekOf(at: Date, timezone: string = siteConfig.timezone): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day"))));
  const back = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  day.setUTCDate(day.getUTCDate() - Math.max(0, back));
  return day.toISOString().slice(0, 10);
}

export async function dispatchBoardDigest(
  db: Db | TestDb,
  at: Date = now(),
): Promise<{ skipped?: "already-sent"; queued: number }> {
  const tx = db as TestDb;
  const week = weekOf(at);
  const [sent] = await tx
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.action, DIGEST_SENT_ACTION), sql`${auditLog.meta}->>'week' = ${week}`))
    .limit(1);
  if (sent) return { skipped: "already-sent", queued: 0 };

  // One read of the open leads for the whole run; each recipient's count is
  // worked out from it here and carried in the job, and an account with
  // nothing open in its places is not queued at all.
  const open = await openLeadPlaces(tx, at);
  let queued = 0;
  for (const profileId of await boardDigestRecipients(tx, ADMIN_VIEWER, at)) {
    const digest = await boardDigestFor(tx, ADMIN_VIEWER, profileId, at, open);
    if (digest === null) continue;
    await notifyLeadBoardDigest(tx, ADMIN_VIEWER, profileId, digest.openCount);
    queued++;
  }
  await writeAuditAs(tx, null, { action: DIGEST_SENT_ACTION, entityType: "lead", meta: { week, queued } });
  return { queued };
}

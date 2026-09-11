import { asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { auditLog, profiles, user } from "@/lib/db/schema";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/test/db";

/**
 * Reading the audit trail.
 *
 * Newest first and capped: this is the page somebody opens when they want to
 * know what just happened, and an unbounded read of a table that grows with
 * every admin action is a page that gets slower for ever.
 *
 * The actor is resolved through `profiles` to the account's own name or
 * address, because `actor_id` is a uuid nobody can read. A null actor is a real
 * answer — a public submission parks itself in this table — and is shown as
 * such rather than as an empty cell that looks like a bug.
 */

export const AUDIT_PAGE_SIZE = 200;

function assertAdmin(viewer: Viewer): void {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
}

export interface AuditEntry {
  id: string;
  createdAt: Date;
  action: string;
  entityType: string | null;
  entityId: string | null;
  /** The actor's name, falling back to the account address. Null for nobody. */
  actor: string | null;
  meta: unknown;
  ip: string | null;
}

export async function recentAudit(
  tx: TestDb,
  viewer: Viewer,
  entityType: string | null,
): Promise<AuditEntry[]> {
  assertAdmin(viewer);

  const rows = await tx
    .select({
      id: auditLog.id,
      createdAt: auditLog.createdAt,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      meta: auditLog.meta,
      ip: auditLog.ip,
      actorName: profiles.name,
      actorEmail: user.email,
    })
    .from(auditLog)
    .leftJoin(profiles, eq(profiles.id, auditLog.actorId))
    .leftJoin(user, eq(user.id, profiles.userId))
    .where(entityType === null ? sql`true` : eq(auditLog.entityType, entityType))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(AUDIT_PAGE_SIZE);

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    actor: row.actorName ?? row.actorEmail ?? null,
    meta: row.meta,
    ip: row.ip,
  }));
}

/** What the filter can offer. Derived from the rows, so it is never stale. */
export async function auditEntityTypes(tx: TestDb, viewer: Viewer): Promise<string[]> {
  assertAdmin(viewer);

  const rows = await tx
    .selectDistinct({ entityType: auditLog.entityType })
    .from(auditLog)
    .where(isNotNull(auditLog.entityType))
    .orderBy(asc(auditLog.entityType));

  return rows.map((r) => r.entityType).filter((t): t is string => t !== null);
}

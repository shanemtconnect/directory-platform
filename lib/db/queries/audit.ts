import { auditLog } from "@/lib/db/schema";
import { ensureProfile } from "@/lib/auth/profile";
import type { Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";

/**
 * The one way anything writes `audit_log`.
 *
 * Global constraint 22: every admin or owner mutation writes an audit row in
 * the SAME transaction as the change. Callers therefore pass the transaction
 * handle they are already inside — a row that survives a rolled-back mutation
 * is a lie about what happened, and a mutation that survives a failed audit
 * write is a change nobody can account for.
 *
 * Constraint 21: `actor_id` is a uuid referencing `profiles.id`, while Better
 * Auth's `user.id` is text. `ensureProfile` is the only bridge between them, so
 * it is the only thing that resolves an actor here. A viewer nobody signed in
 * as leaves the column null rather than inventing an actor.
 */

export interface AuditInput {
  /** Dotted and past tense: `submission.approved`, `city.intro_saved`. */
  action: string;
  entityType?: string | null;
  /** A uuid, or null for an action against something with no row of its own. */
  entityId?: string | null;
  meta?: Record<string, unknown> | null;
  ip?: string | null;
}

/**
 * The worker's viewer (`worker/viewer.ts`) and the billing system viewer carry
 * the nil UUID: a real UUID so comparisons cannot break, and one no `user` row
 * will ever have. Resolving it through `ensureProfile` would try to insert a
 * profile for a user that does not exist, so it is recognised here and written
 * as "nobody" — the same null a webhook or a purge job records.
 */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export async function writeAudit(
  tx: TestDb,
  viewer: Viewer,
  input: AuditInput,
): Promise<string> {
  const actorId =
    viewer.role === "public" || viewer.userId === NIL_UUID
      ? null
      : (await ensureProfile(tx, viewer)).id;
  return writeAuditAs(tx, actorId, input);
}

/**
 * The same row, for a caller that has already resolved the actor.
 *
 * Most mutations hold the claimant's or owner's `profiles.id` from an earlier
 * lookup in the same transaction, and the system paths (webhooks, reminders,
 * purges) have no viewer at all — `actorId` is null there by design, never a
 * placeholder. Everything that reaches `audit_log` ends in this insert.
 */
export async function writeAuditAs(
  tx: TestDb,
  actorId: string | null,
  input: AuditInput,
): Promise<string> {
  const [row] = await tx
    .insert(auditLog)
    .values({
      actorId,
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      meta: input.meta ?? null,
      ip: input.ip ?? null,
    })
    .returning({ id: auditLog.id });
  return row!.id;
}

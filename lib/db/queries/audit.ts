import { auditLog } from "@/lib/db/schema";
import { ensureProfile } from "@/lib/auth/profile";
import type { Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/test/db";

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

export async function writeAudit(
  tx: TestDb,
  viewer: Viewer,
  input: AuditInput,
): Promise<string> {
  const actorId = viewer.role === "public" ? null : (await ensureProfile(tx, viewer)).id;

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

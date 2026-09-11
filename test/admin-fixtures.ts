import { randomUUID } from "node:crypto";
import { user } from "@/lib/db/schema";
import type { Viewer } from "@/lib/db/viewer";
import type { TestDb } from "./db";

/**
 * A signed-in viewer with a real `user` row behind it.
 *
 * `profiles.user_id` has a foreign key to Better Auth's `user` table, so any
 * test that reaches `ensureProfile` — which every audited admin mutation does —
 * needs the account to exist first. The role is the VIEWER's, not a column:
 * `profiles.role` still defaults to 'user', which is the point of constraint 23
 * being a query-layer check rather than a row lookup.
 */
export async function makeViewer(
  tx: TestDb,
  role: "admin" | "owner" | "user" = "admin",
): Promise<Viewer & { userId: string }> {
  const userId = `user_${randomUUID()}`;
  await tx.insert(user).values({
    id: userId,
    name: "Test Person",
    email: `${userId}@example.test`,
  });
  return { role, userId };
}

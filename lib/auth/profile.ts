import { eq } from "drizzle-orm";
import { profiles } from "@/lib/db/schema";
import type { Db } from "@/lib/db/client";
import type { Viewer } from "@/lib/db/viewer";

/**
 * Better Auth's `user.id` is text; every "who did this" column in our own
 * tables (claims.user_id, subscriptions.user_id, audit_log.actor_id,
 * removal_requests.actioned_by, …) is a uuid that references `profiles.id`.
 *
 * This is the one place that bridges the two. It creates the profile row on
 * first sight so a freshly signed-up user can act immediately; the role is
 * never set here — it comes from the row and defaults to 'user'.
 */
export async function ensureProfile(
  db: Db,
  viewer: Viewer,
): Promise<{ id: string; role: "user" | "owner" | "admin" }> {
  if (viewer.role === "public") throw new Error("ensureProfile: no signed-in user");
  const [existing] = await db
    .select({ id: profiles.id, role: profiles.role })
    .from(profiles)
    .where(eq(profiles.userId, viewer.userId))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(profiles)
    .values({ userId: viewer.userId })
    .onConflictDoNothing()
    .returning({ id: profiles.id, role: profiles.role });
  if (created) return created;
  // Lost a race with a concurrent insert — read the winner.
  const [winner] = await db
    .select({ id: profiles.id, role: profiles.role })
    .from(profiles)
    .where(eq(profiles.userId, viewer.userId))
    .limit(1);
  if (!winner) throw new Error("ensureProfile: profile vanished");
  return winner;
}

import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { profiles } from "@/lib/db/schema";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { getAuth } from "./server";

/**
 * Resolves the request's session into the `Viewer` every query function takes.
 *
 * Role comes from OUR `profiles` table, never from the session or anything the
 * client can influence. A missing profile row is treated as a plain user, so a
 * newly signed-up account can never arrive as an admin by default.
 */
export async function currentViewer(): Promise<Viewer> {
  // `headers()` FIRST. Reading it is what marks the render dynamic; building the
  // auth instance opens a database connection. In the other order a prerender
  // of /account or /admin reached for the database before Next had been told
  // the route could not be static, and `next build` failed on a page that is
  // per-request by definition.
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session?.user) return PUBLIC_VIEWER;

  const [profile] = await db
    .select({ role: profiles.role })
    .from(profiles)
    .where(eq(profiles.userId, session.user.id))
    .limit(1);

  const userId = session.user.id;
  switch (profile?.role) {
    case "admin":
      return { role: "admin", userId };
    case "owner":
      return { role: "owner", userId };
    default:
      return { role: "user", userId };
  }
}

export async function requireAdmin(): Promise<Viewer & { role: "admin" }> {
  const viewer = await currentViewer();
  if (viewer.role !== "admin") throw new Error("FORBIDDEN");
  return viewer;
}

import { randomUUID } from "node:crypto";
import { profiles, user } from "@/lib/db/schema";
import type { TestDb } from "@/test/db";
import type { Viewer } from "@/lib/db/viewer";

/**
 * Shared by photos.test.ts and photos.race.test.ts. `idPrefix` lets the race
 * test mark the user it commits so test/race.ts can sweep it up.
 */
export async function owner(tx: TestDb, role: "user" | "owner" | "admin" = "owner", idPrefix = "u_") {
  const userId = `${idPrefix}${randomUUID()}`;
  await tx.insert(user).values({
    id: userId, name: "Jo", email: `${userId}@example.test`, emailVerified: true,
  });
  const [profile] = await tx.insert(profiles).values({ userId, role }).returning({ id: profiles.id });
  return { userId, profileId: profile!.id, viewer: { role, userId } as Viewer };
}

export const key = (listingId: string, n: number) =>
  `listings/${listingId}/photo-${n.toString(16).padStart(16, "0")}.jpg`;

export const IP = "203.0.113.7";

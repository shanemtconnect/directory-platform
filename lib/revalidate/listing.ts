import { revalidatePath } from "next/cache";

/**
 * Bust every cached page a listing decision left stale.
 *
 * The list comes from `listingPaths` in lib/db/queries/paths.ts — the listing
 * page, its reviews page, the city pillar, the city's paginated pages and the
 * category pillar inside the city — and is read INSIDE the transaction that
 * makes the change, before the change where the change shrinks the published
 * count. This is the other half: called once that transaction has returned,
 * so nothing re-caches the old row between "marked stale" and "committed".
 *
 * Every caller inside the Next process goes through here rather than naming
 * paths itself, so the day a page is added to the list it is added for all
 * of them: the admin actions (approve, reject, takedown, review moderation,
 * claim decision), the owner's edit and review reply, the two magic-link
 * confirm routes (review verify, claim verify), the PayPal webhook and the
 * checkout return page. The callers that do not run as an admin get their
 * list from the query that authorised them — `resolveListingPaths`, the
 * same list without the viewer gate — as a `paths` field on its result. The
 * worker has its own route to the same end (lib/revalidate/client.ts).
 */
export function revalidateListingPaths(paths: readonly string[]): void {
  for (const path of new Set(paths)) revalidatePath(path);
}

/**
 * The pages a featured spot's ranking appears on — its city pillar, its
 * category pillar or its region page — from `spotPaths` in
 * lib/db/queries/spots.ts. Server actions call it after their transaction
 * has committed, for the same reason as `revalidateListingPaths` above.
 */
export async function revalidateSpotPaths(spotIds: readonly string[]): Promise<void> {
  const { db } = await import("@/lib/db/client");
  const { spotPaths } = await import("@/lib/db/queries/spots");
  const { PUBLIC_VIEWER } = await import("@/lib/db/viewer");
  const paths: string[] = [];
  for (const id of new Set(spotIds)) paths.push(...(await spotPaths(db, PUBLIC_VIEWER, id)));
  revalidateListingPaths(paths);
}

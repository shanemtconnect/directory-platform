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
 * Every server action that approves, rejects, takes down, moderates a review
 * on or approves a claim for a listing goes through here rather than naming
 * paths itself, so the day a page is added to the list it is added for all
 * of them. The worker has its own route to the same end (lib/revalidate/
 * client.ts); this one is for code that runs inside the Next process.
 */
export function revalidateListingPaths(paths: readonly string[]): void {
  for (const path of new Set(paths)) revalidatePath(path);
}

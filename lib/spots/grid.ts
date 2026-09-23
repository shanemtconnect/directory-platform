import type { PublicListing } from "@/lib/db/queries/listings";

/**
 * The organic grid with the featured listings taken out.
 *
 * A listing that holds a featured position is already on the page, above
 * the grid; showing it again below is a double listing. The page's ItemList
 * is built from the full rows, not from this — the featured cards are
 * visible content and stay in the markup.
 */
export function excludeFeatured<T extends Pick<PublicListing, "id">>(
  rows: readonly T[],
  featured: readonly Pick<PublicListing, "id">[],
): T[] {
  if (featured.length === 0) return [...rows];
  const ids = new Set(featured.map((f) => f.id));
  return rows.filter((r) => !ids.has(r.id));
}

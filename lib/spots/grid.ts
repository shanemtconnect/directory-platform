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

/** How many premium-tier cards the pre-existing row shows. */
export const PREMIUM_ROW_SIZE = 3;

export interface PageRows<T> {
  /** The organic grid, featured bids removed. */
  readonly grid: T[];
  /**
   * The premium-tier row — built from the GRID, so a premium listing that
   * also holds a bid is not on the page twice, and empty whenever the paid
   * row is showing: one Featured section per page (I3).
   */
  readonly premium: T[];
}

export function pageRows<T extends Pick<PublicListing, "id" | "tier">>(
  rows: readonly T[],
  featured: readonly Pick<PublicListing, "id">[],
  premiumRowEnabled: boolean,
): PageRows<T> {
  const grid = excludeFeatured(rows, featured);
  const premium =
    featured.length > 0 || !premiumRowEnabled
      ? []
      : grid.filter((l) => l.tier === "premium").slice(0, PREMIUM_ROW_SIZE);
  return { grid, premium };
}

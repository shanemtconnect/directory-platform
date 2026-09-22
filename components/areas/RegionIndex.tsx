import type { RegionRow } from "@/lib/db/queries/areas";
import { siteConfig } from "@/config/site.config";
import { regionPath } from "@/lib/routing/regions";

/**
 * /areas — every region that has earned a link, busiest first.
 *
 * Counts beside each name are the two the region page itself is headed by, so
 * the index and the page it links to agree.
 */
export function RegionIndex({ regions, heading }: { regions: RegionRow[]; heading: string }) {
  const e = siteConfig.entity;
  return (
    <main>
      <h1>{heading}</h1>
      {regions.length === 0 ? (
        <p>No locations are listed yet.</p>
      ) : (
        <ul className="link-grid" data-testid="region-list">
          {regions.map((r) => (
            <li key={r.slug}>
              <a href={regionPath(r.slug)}>{r.name}</a>{" "}
              <span>
                ({r.cityCount} {r.cityCount === 1 ? "location" : "locations"} ·{" "}
                {r.listingCount} {r.listingCount === 1 ? e.singular : e.plural})
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

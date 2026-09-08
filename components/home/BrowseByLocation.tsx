import { siteConfig } from "@/config/site.config";
import type { CityIndexRow } from "@/lib/db/queries/indexes";

/**
 * Every link here goes to a city pillar page. `topCities` guarantees the rows
 * are indexable — this component must not be handed a list from anywhere else.
 */
export function BrowseByLocation({ cities }: { cities: CityIndexRow[] }) {
  const e = siteConfig.entity;

  return (
    <section aria-labelledby="browse-by-location">
      <h2 id="browse-by-location">Browse by location</h2>
      {cities.length === 0 ? (
        <p>No locations are listed yet.</p>
      ) : (
        <>
          <ul data-testid="home-cities" className="link-grid">
            {cities.map((c) => (
              <li key={c.id}>
                <a href={`/${c.slug}`}>
                  {e.Plural} in {c.name}
                </a>{" "}
                <span>({c.listingCount})</span>
              </li>
            ))}
          </ul>
          <p className="mt-6 mb-0">
            <a href="/cities" className="btn btn-secondary">All locations</a>
          </p>
        </>
      )}
    </section>
  );
}

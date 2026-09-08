import { siteConfig } from "@/config/site.config";
import type { CategoryIndexRow } from "@/lib/db/queries/indexes";

/** Category pages only appear here once they have published listings behind them. */
export function BrowseByType({ categories }: { categories: CategoryIndexRow[] }) {
  const e = siteConfig.entity;

  return (
    <section aria-labelledby="browse-by-type">
      <h2 id="browse-by-type">Browse by type</h2>
      {categories.length === 0 ? (
        <p>No types have {e.plural} yet.</p>
      ) : (
        <>
          <ul data-testid="home-categories" className="link-grid">
            {categories.map((c) => (
              <li key={c.id}>
                <a href={`/categories/${c.slug}`}>{c.name}</a>{" "}
                <span>({c.listingCount})</span>
              </li>
            ))}
          </ul>
          <p className="mt-6 mb-0">
            <a href="/categories" className="btn btn-secondary">All {e.plural}</a>
          </p>
        </>
      )}
    </section>
  );
}

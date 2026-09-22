import type { RegionPage, RegionListingRow, RegionCategoryRow } from "@/lib/db/queries/areas";
import { siteConfig } from "@/config/site.config";
import { Pagination } from "@/components/pillar/Pagination";
import { Breadcrumbs, type Crumb } from "@/components/seo/Breadcrumbs";

interface Props {
  region: RegionPage;
  trail: readonly Crumb[];
  title: string;
  /** Rendered on page 1 only; see lib/areas/intro.ts. */
  intro: string;
  listings: RegionListingRow[];
  categories: RegionCategoryRow[];
  total: number;
  page: number;
  totalPages: number;
  basePath: string;
}

/**
 * The region pillar: a hub over the city pages in one county or state.
 *
 * Order is deliberate. The cities come FIRST because they are the pages that
 * rank — a region page's job is to pass authority down to them — and the
 * region's own listing runs beneath. A thin city is named with its count but
 * not linked: it is real, its listings are in the list below, and linking a
 * page we have told Google to ignore is the one thing the index blocks never
 * do. The cities are on every page of the pagination for the same reason
 * they are on every page of a city pillar: page 2 is a landing page too.
 */
export function RegionPillar({
  region, trail, title, intro, listings, categories, total, page, totalPages, basePath,
}: Props) {
  const e = siteConfig.entity;
  const isFirstPage = page === 1;

  return (
    <main>
      <Breadcrumbs trail={trail} />
      <h1>{title}</h1>
      {!isFirstPage && (
        <p data-testid="page-indicator" className="text-muted">Page {page} of {totalPages}</p>
      )}
      {isFirstPage && <p data-testid="intro" className="mt-4 text-lg">{intro}</p>}

      {region.cities.length > 0 && (
        <section aria-labelledby="locations" data-testid="region-city-grid">
          <h2 id="locations">Locations in {region.name}</h2>
          <ul className="link-grid">
            {region.cities.map((c) => (
              <li key={c.id} data-indexable={c.isIndexable}>
                {c.isIndexable ? <a href={`/${c.slug}`}>{c.name}</a> : <span>{c.name}</span>}{" "}
                <span>({c.listingCount})</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {categories.length > 0 && (
        <section aria-labelledby="by-type" data-testid="region-categories">
          <h2 id="by-type">{e.Plural} in {region.name} by type</h2>
          <ul className="link-grid">
            {categories.map((c) => (
              <li key={c.id}>
                <a href={`/categories/${c.slug}`}>{c.name}</a>{" "}
                <span>({c.listingCount})</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="all">
        <h2 id="all">
          {total} {total === 1 ? e.singular : e.plural} in {region.name}
        </h2>
        {listings.length === 0 ? (
          <p>No {e.plural} listed in {region.name} yet.</p>
        ) : (
          <ul data-testid="listing-grid" className="card-grid">
            {listings.map((r) => (
              <li
                key={r.listing.id}
                data-tier={r.listing.tier}
                data-claim-status={r.listing.claimStatus}
                className="card card-hover flex flex-col gap-2"
              >
                {/* /[city]/[listing]: the region is never a segment of a listing URL. */}
                <a
                  href={`/${r.citySlug}/${r.listing.slug}`}
                  className="font-heading text-lg leading-snug font-semibold text-ink no-underline hover:text-primary hover:underline"
                >
                  {r.listing.name}
                </a>
                <span data-testid="listing-city" className="text-sm text-muted">{r.cityName}</span>
                {r.listing.claimStatus === "verified" && (
                  <span data-testid="verified-badge" className="text-sm">Verified</span>
                )}
                {r.listing.shortDescription && <p className="mb-0">{r.listing.shortDescription}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Pagination basePath={basePath} page={page} totalPages={totalPages} />

      <section data-testid="add-cta" className="card bg-raised">
        <h2 className="mt-0">Own a {e.singular} in {region.name}?</h2>
        <p className="mb-4 text-muted">Adding it costs nothing and takes a few minutes.</p>
        <p className="mb-0">
          <a href="/add-listing" className="btn btn-primary">Add your {e.singular}</a>
        </p>
      </section>
    </main>
  );
}

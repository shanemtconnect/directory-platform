import type { PublicListing as Listing } from "@/lib/db/queries/listings";
import type { PillarHeading } from "@/lib/db/queries/cities";
import type { CategoryIndexRow, CityIndexRow } from "@/lib/db/queries/indexes";
import { siteConfig } from "@/config/site.config";
import { sanitiseRichText } from "@/lib/html/sanitise";
import { Pagination } from "./Pagination";
import { ListingCard } from "./ListingCard";
import { FeaturedRow } from "./FeaturedRow";
import { FeaturedUpsell } from "./FeaturedUpsell";
import { VerifiedToggle } from "./VerifiedToggle";
import type { FeaturedListing } from "@/lib/db/queries/spots";
import { ListingMap } from "@/components/map/ListingMap";
import { NeighbourhoodList } from "./NeighbourhoodList";
import type { NeighbourhoodLink } from "@/lib/db/queries/neighbourhoods";


export interface FaqEntry { question: string; answer: string }

interface Props {
  heading: PillarHeading;
  featured: Listing[];
  /** The spot's featured bids (lib/spots), page 1 only. Not in `listings`. */
  featuredBids?: readonly FeaturedListing[];
  listings: Listing[];
  categories: CategoryIndexRow[];
  nearby: CityIndexRow[];
  faq: FaqEntry[];
  /**
   * How many listings are in THIS page's scope — the category's count on
   * /city/category, not the whole city's. The heading, the list and the
   * ItemList's numberOfItems have to be three views of one number.
   */
  total: number;
  page: number;
  totalPages: number;
  basePath: string;
  cityPath: string;
  /** Award years per listing id (Task 50), read by the route from the `awards` table. */
  awardYears?: ReadonlyMap<string, readonly number[]>;
  /** The page's featured spot as `areaKind:areaId:categoryId|-` (Task 45): mounts the owner upsell strip. */
  spotKey?: string;
  /** The town's neighbourhood links (Task 52) — the town pillar only; empty hides the block. */
  neighbourhoods?: readonly NeighbourhoodLink[];
  /** Whether THIS render is the `?verified=1` view (Task 53). Default false: every caller but the verified route omits it. */
  verified?: boolean;
  /** Whether the scope has at least one verified listing — gates the toggle. Default false: unaffected callers never show it. */
  hasVerified?: boolean;
}

/**
 * The city pillar page — the ranking asset. Structure follows the brief's §5.1
 * order, and every block earns its place:
 *
 *  - the featured row is what a paid tier actually buys, visibly
 *  - category sub-links and nearby cities ARE the internal linking engine; a
 *    directory with neither is a set of orphan pages
 *  - the FAQ block is the only FAQPage markup on the site, so it must reflect
 *    what is visibly on the page
 */
export function PillarPage({
  heading, featured, featuredBids = [], listings, categories, nearby, faq,
  total, page, totalPages, basePath, cityPath, awardYears, spotKey, neighbourhoods = [],
  verified = false, hasVerified = false,
}: Props) {
  const e = siteConfig.entity;
  const isFirstPage = page === 1;

  return (
    <main>
      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted">
        <a href="/">Home</a> ›{" "}
        {/* A neighbourhood sits under its town (Task 52): Home › Town › Neighbourhood. */}
        {heading.parent && (
          <>
            <a href={`/${heading.parent.slug}`}>{heading.parent.name}</a> ›{" "}
          </>
        )}
        <span>{heading.place}</span>
      </nav>

      <h1>{heading.title}</h1>
      {!isFirstPage && (
        <p data-testid="page-indicator" className="text-muted">Page {page} of {totalPages}</p>
      )}

      {/* Intro copy only on page 1 — repeating it across paginated URLs is
          duplicate content on the pages least able to afford it. */}
      {isFirstPage && heading.introHtml && (
        <div
          data-testid="intro"
          className="prose mt-4 text-lg"
          // Stored HTML, so it goes through the allow-list on the way out. The
          // seed escapes its own inputs, but this is the last point that can
          // still be sure — and the editor that will write this copy next has
          // not been built yet.
          dangerouslySetInnerHTML={{ __html: sanitiseRichText(heading.introHtml) }}
        />
      )}

      {/* ONE Featured section: the paid spots when any bid holds a position
          (lib/spots), otherwise the premium-tier row the page always had.
          The route builds `featured` from the grid, so nothing is on the page
          twice. Empty spot and no premium: no row, no placeholder. */}
      {isFirstPage && featuredBids.length > 0 && (
        <FeaturedRow
          featured={featuredBids}
          nounPlural={heading.nounPlural}
          place={heading.place}
        />
      )}

      {/* Client-side, outside the cached tree's knowledge of who is looking:
          renders nothing unless the visitor owns a listing on this page that
          is not featured here (Task 45). Page 1, where the row is. */}
      {isFirstPage && spotKey !== undefined && (
        <FeaturedUpsell
          spotKey={spotKey}
          nounSingular={heading.nounSingular}
          locale={siteConfig.locale}
          currency={siteConfig.currency}
        />
      )}

      {isFirstPage && featuredBids.length === 0 && featured.length > 0 && (
        <section aria-labelledby="featured" data-testid="featured">
          <h2 id="featured">Featured {heading.nounPlural} in {heading.place}</h2>
          <ul className="card-grid">
            {featured.map((l) => (
              <ListingCard key={l.id} listing={l} basePath={cityPath} featured awardYears={awardYears?.get(l.id)} />
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="all">
        {/* The scope's OWN total and the scope's OWN noun. Reading the city's
            listingCount here made /leeds/{category} claim every listing in
            Leeds above a list of one category's, contradicting both the list
            below it and the ItemList's numberOfItems. */}
        <h2 id="all">
          {total} {total === 1 ? heading.nounSingular : heading.nounPlural} in {heading.place}
        </h2>
        {/* Task 53: query-param filter, not a path — the base (unfiltered)
            page is what Pagination's `basePath` already is, and turning the
            filter ON always starts back at page 1 of it. */}
        <VerifiedToggle
          active={verified}
          hasVerified={hasVerified}
          onHref={`${basePath}?verified=1`}
          offHref={basePath}
          nounPlural={heading.nounPlural}
        />
        {listings.length === 0 ? (
          verified ? (
            <p data-testid="empty-verified">
              No verified {heading.nounPlural} in {heading.place} yet —{" "}
              <a href={basePath}>see all</a>.
            </p>
          ) : (
            <p>No {heading.nounPlural} listed in {heading.place} yet.</p>
          )
        ) : (
          <ul data-testid="listing-grid" className="card-grid">
            {listings.map((l) => (
              <ListingCard key={l.id} listing={l} basePath={cityPath} awardYears={awardYears?.get(l.id)} />
            ))}
          </ul>
        )}
      </section>

      {/* Below the listings, deliberately: the map lazy-loads and must never
          block LCP or be required to see them. If tiles fail it collapses. */}
      <ListingMap
        pins={listings.map((l) => ({
          id: l.id, name: l.name, lat: l.lat, lng: l.lng,
          href: `${cityPath}/${l.slug}`,
        }))}
      />

      <Pagination basePath={basePath} page={page} totalPages={totalPages} verified={verified} />

      {/* The TOWN's category pages and counts: never under a neighbourhood
          (Task 52), where they would read as the neighbourhood's own and
          repeat the town page's link block on every neighbourhood. */}
      {categories.length > 0 && !heading.parent && (
        <section aria-labelledby="by-type" data-testid="category-links">
          <h2 id="by-type">{e.Plural} in {heading.place} by type</h2>
          <ul className="link-grid">
            {categories.map((c) => (
              <li key={c.id}>
                <a href={`${cityPath}/${c.slug}`}>{c.name} in {heading.place}</a>{" "}
                <span>({c.listingCount})</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <NeighbourhoodList neighbourhoods={neighbourhoods} cityPath={cityPath} place={heading.place} />

      {nearby.length > 0 && (
        <section aria-labelledby="nearby" data-testid="nearby-cities">
          <h2 id="nearby">Nearby locations</h2>
          <ul className="link-grid">
            {nearby.map((c) => (
              <li key={c.id}>
                <a href={`/${c.slug}`}>{e.Plural} in {c.name}</a>{" "}
                <span>({c.listingCount})</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {faq.length > 0 && (
        <section aria-labelledby="faq" data-testid="faq">
          <h2 id="faq">Frequently asked questions</h2>
          <dl className="prose">
            {faq.map((f) => (
              <div key={f.question} className="border-t border-line py-4">
                <dt className="font-heading font-semibold">{f.question}</dt>
                <dd className="mt-1 ml-0 text-muted">{f.answer}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section data-testid="add-cta" className="card bg-raised">
        <h2 className="mt-0">Own a {e.singular} in {heading.place}?</h2>
        <p className="mb-4 text-muted">
          Adding it costs nothing and takes a few minutes.
        </p>
        <p className="mb-0">
          <a href="/add-listing" className="btn btn-primary">Add your {e.singular}</a>
        </p>
      </section>
    </main>
  );
}

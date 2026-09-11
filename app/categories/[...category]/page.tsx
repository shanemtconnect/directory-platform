import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { db } from "@/lib/db/client";
import { siteConfig } from "@/config/site.config";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { PER_PAGE } from "@/lib/db/queries/listings";
import {
  getCategoryBySlug,
  listCategoryListings,
  countCategoryListings,
  citiesForCategory,
} from "@/lib/db/queries/category-page";
import { listSwitcherCities } from "@/lib/db/queries/cities";
import { Pagination } from "@/components/pillar/Pagination";
import { LocationSwitcher } from "@/components/location/LocationSwitcher";
import { cityScopedHref } from "@/components/location/switcher-links";
import { JsonLd } from "@/components/seo/JsonLd";
import { pillarSchema, breadcrumbSchema } from "@/lib/schema/builders";
import { categoryEarnsIndexing } from "@/lib/db/queries/sitemap";
import { pageOpenGraph } from "@/lib/seo/open-graph";
import { normalisePathSegments } from "@/lib/routing/resolve";

export const revalidate = 3600;

/**
 * Deliberately empty — and load-bearing.
 *
 * A dynamic route with no generateStaticParams is treated as fully dynamic:
 * it re-renders on every request and never enters the Redis ISR cache, which
 * on a directory this size is the difference between a cached site and a
 * database hammered by every crawl. Exporting this, even empty, marks the
 * route as statically generated with dynamicParams, so a page renders once on
 * first request and is then cached under `revalidate`.
 *
 * Empty rather than enumerated because the image is built in CI with no
 * DATABASE_URL, and the first-request cost is a single render per page.
 */
export async function generateStaticParams(): Promise<{ category: string[] }[]> {
  return [];
}

/**
 * A catch-all rather than a single segment because pagination lives in the
 * PATH — /categories/[slug]/page/2. Reading searchParams would force the route
 * dynamic in Next 16 and drop it out of the ISR cache entirely, which is the
 * same trade-off the city pillar makes in app/[...segments].
 */
interface Props {
  params: Promise<{ category: string[] }>;
}

const BASE = "/categories";

type Parsed =
  | { kind: "page"; slug: string; page: number }
  | { kind: "redirect"; to: string }
  | { kind: "not-found" };

/**
 * The same two canonicalisation rules the city catch-all applies, from the same
 * helper: /categories/Some-Slug 301s to /categories/some-slug, and
 * /categories/some-slug/page/1 301s to /categories/some-slug.
 *
 * This route used to 404 the first and serve the second as a second copy of
 * page 1 — so a link with a capital letter in it was a dead end, and the
 * category page had a duplicate of itself at a second URL. Both are duplicate-
 * content rules about URL shape, not about cities, which is why the helper is
 * shared rather than reimplemented here (`normalisePathSegments` also owns the
 * "one spelling of a page number" rule: "1e0", "0x2" and "02" are 404s).
 */
function parseSegments(segments: string[]): Parsed {
  const normalised = normalisePathSegments(BASE, segments);
  if (normalised.kind === "redirect") return { kind: "redirect", to: normalised.to };
  if (normalised.kind === "not-found") return { kind: "not-found" };

  // A national category page is exactly one segment. /categories/a/b is not a
  // deeper page, it is a URL nothing generated.
  if (normalised.segments.length !== 1) return { kind: "not-found" };
  const slug = normalised.segments[0];
  if (slug === undefined || slug === "") return { kind: "not-found" };
  return { kind: "page", slug, page: normalised.page };
}

export default async function CategoryNationalPage({ params }: Props) {
  const { category: segments } = await params;
  const parsed = parseSegments(segments);
  // next/navigation cannot emit a 301 from a server component; 308 is the same
  // permanent signal and is what the city catch-all serves too.
  if (parsed.kind === "redirect") permanentRedirect(parsed.to);
  if (parsed.kind !== "page") notFound();

  const category = await getCategoryBySlug(db as never, PUBLIC_VIEWER, parsed.slug);
  if (!category) notFound();

  const [rows, total, locations, switcherCities] = await Promise.all([
    listCategoryListings(db as never, PUBLIC_VIEWER, category.id, { page: parsed.page }),
    countCategoryListings(db as never, PUBLIC_VIEWER, category.id),
    citiesForCategory(db as never, PUBLIC_VIEWER, category.id),
    listSwitcherCities(db as never, PUBLIC_VIEWER),
  ]);

  /*
   * A category's route inside a city comes from the SLUG REGISTRY, not from
   * `categories.slug`: the per-city entry can be disambiguated on collision, so
   * building /{city}/{national slug} produces a 404 exactly when one happened.
   * `citiesForCategory` has already joined the registry, so it is the authority
   * on where this category lives in each city — and a city missing from it has
   * nothing published under this category, which is not somewhere to send
   * anyone. The switcher therefore offers the intersection: cities allowed to
   * be linked at all, that this category actually has a page in.
   */
  const routedIn = new Map(locations.map((c) => [c.id, c.categorySlug]));
  const switchable = switcherCities.filter((c) => routedIn.has(c.id));

  const basePath = `/categories/${category.slug}`;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  // A page number past the end has nothing on it and must not be a soft 404.
  if (parsed.page > totalPages) notFound();

  const e = siteConfig.entity;
  const isFirstPage = parsed.page === 1;
  // The category's own nouns, so the count agrees with the H1 above it.
  const noun = total === 1 ? category.singular : category.plural;
  const pagePath = isFirstPage ? basePath : `${basePath}/page/${parsed.page}`;

  return (
    <>
      <JsonLd
        data={pillarSchema({
          // Page N is its own document with its own listings; asserting page
          // 1's url/@id makes the two collide.
          title: category.name,
          path: pagePath,
          // The description renders on page 1 only, so only page 1 claims it.
          description: isFirstPage ? category.description : null,
          items: rows.map((r) => ({
            name: r.listing.name,
            path: `/${r.citySlug}/${r.listing.slug}`,
          })),
        })}
      />
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: e.Plural, path: "/categories" },
          { name: category.name, path: basePath },
        ])}
      />
      <main>
        <nav aria-label="Breadcrumb">
          <a href="/">Home</a> › <a href="/categories">{e.Plural}</a> › <span>{category.name}</span>
        </nav>

        <h1>{category.name}</h1>

        {/*
          Constraint 18: this changes nothing about THIS URL. Every entry is an
          <a href> to a city page that already exists and already returns
          exactly this, whether it is reached from here or typed in.
        */}
        <LocationSwitcher
          label={`See ${category.name} in`}
          cities={switchable}
          hrefFor={(city) => cityScopedHref(city.slug, routedIn.get(city.id))}
          testId="category-location-switcher"
        />
        {!isFirstPage && (
          <p data-testid="page-indicator">
            Page {parsed.page} of {totalPages}
          </p>
        )}

        {/* Description only on page 1 — repeating it across paginated URLs is
            duplicate content on the pages least able to carry it. */}
        {isFirstPage && category.description && (
          <p data-testid="category-description">{category.description}</p>
        )}

        <section aria-labelledby="all">
          <h2 id="all">
            {total} {noun} nationwide
          </h2>
          {rows.length === 0 ? (
            <p>Nothing is listed under {category.name} yet.</p>
          ) : (
            <ul data-testid="listing-grid">
              {rows.map((r) => (
                <li key={r.listing.id} data-tier={r.listing.tier} data-claim-status={r.listing.claimStatus}>
                  <a href={`/${r.citySlug}/${r.listing.slug}`}>{r.listing.name}</a>{" "}
                  <span data-testid="listing-city">{r.cityName}</span>
                  {r.listing.claimStatus === "verified" && (
                    <span data-testid="verified-badge"> · Verified</span>
                  )}
                  {r.listing.shortDescription && <p>{r.listing.shortDescription}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <Pagination basePath={basePath} page={parsed.page} totalPages={totalPages} />

        {/* The internal-linking block. citiesForCategory has already dropped
            every city that is not indexable, so nothing here spends crawl
            budget on a page we have told Google to ignore. */}
        {locations.length > 0 && (
          <section aria-labelledby="by-location" data-testid="by-location">
            <h2 id="by-location">{category.name} by location</h2>
            <ul>
              {locations.map((c) => (
                <li key={c.id}>
                  <a href={`/${c.slug}/${c.categorySlug}`}>
                    {category.name} in {c.name}
                  </a>{" "}
                  <span>({c.listingCount})</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}

/**
 * A category with nothing published under it renders and works, but is
 * noindex,follow — an empty collection page is exactly the thin content that
 * drags a directory's whole domain down.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { category: segments } = await params;
  const parsed = parseSegments(segments);
  // No metadata for a URL that redirects or 404s — the page function is what
  // serves the redirect, and metadata for a page nobody lands on is noise.
  if (parsed.kind !== "page") return {};

  const category = await getCategoryBySlug(db as never, PUBLIC_VIEWER, parsed.slug);
  if (!category) return {};

  const total = await countCategoryListings(db as never, PUBLIC_VIEWER, category.id);

  const basePath = `/categories/${category.slug}`;
  const onPageOne = parsed.page === 1;
  // Page N canonicalises to itself, not to page 1 — see the catch-all route.
  const path = onPageOne ? basePath : `${basePath}/page/${parsed.page}`;
  const title = onPageOne ? category.name : `${category.name} — page ${parsed.page}`;

  const base =
    category.description ?? `Browse ${category.plural} across every town and city we cover.`;

  return {
    title,
    description: onPageOne ? base : `${base} — page ${parsed.page}`,
    alternates: { canonical: path },
    openGraph: pageOpenGraph({ title, url: path }),
    // The SAME rule the sitemap applies, so a category cannot be advertised
    // in one place and noindexed in the other.
    robots: categoryEarnsIndexing(total) ? undefined : { index: false, follow: true },
  };
}

import { notFound, permanentRedirect, redirect } from "next/navigation";
import type { Metadata } from "next";
import { db } from "@/lib/db/client";
import { siteConfig } from "@/config/site.config";
import { resolveRoute } from "@/lib/routing/resolve";
import { listListings, countListings, PER_PAGE } from "@/lib/db/queries/listings";
import { pillarHeading } from "@/lib/db/queries/cities";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { PillarPage } from "@/components/pillar/PillarPage";
import { ListingDetail } from "@/components/listing/ListingDetail";
import { JsonLd } from "@/components/seo/JsonLd";
import { getListingDetail, relatedListings } from "@/lib/db/queries/listing-detail";
import { awardText, awardYearsForListings, listingAwards } from "@/lib/db/queries/awards";
import {
  listingSchema, pillarSchema, breadcrumbSchema, faqSchema, reviewsPageSchema,
  neighbourhoodPillarSchema, type RenderedReview,
} from "@/lib/schema/builders";
import { cityNeighbourhoods } from "@/lib/db/queries/neighbourhoods";
import { neighbourhoodsEnabled } from "@/lib/geo/neighbourhoods";
import { features } from "@/lib/features/flags";
import { guardFeature } from "@/lib/features/guard";
import {
  reviewSummary, listPublishedReviews, countPublishedReviews, REVIEWS_PER_PAGE,
  type PublicReview,
} from "@/lib/db/queries/reviews";
import { ReviewsPage } from "@/components/reviews/ReviewsPage";
import { categoriesInCity, nearbyCities } from "@/lib/db/queries/indexes";
import { featuredForScope } from "@/lib/db/queries/spots";
import { pageRows } from "@/lib/spots/grid";
import { displayedDescription, displayedSocials } from "@/lib/listing/display";
import { galleryImages } from "@/lib/media/public-url";
import { pageOpenGraph } from "@/lib/seo/open-graph";
import type { FaqEntry } from "@/components/pillar/PillarPage";
import { SponsorRails } from "@/components/ads/SponsorRails";
import { placementForScope } from "@/lib/ads/policy";

export const revalidate = 3600;

/**
 * Deliberately empty.
 *
 * A catch-all with no generateStaticParams is treated as fully dynamic — the
 * route renders on every request and never enters the ISR cache, which for a
 * 5,000-page directory is the difference between a cached site and a database
 * hammered on every crawl. Exporting this (even empty) marks the route as
 * statically generated with dynamicParams, so a page renders on first request
 * and is then cached in Redis under `revalidate`.
 *
 * Empty rather than enumerated because the Docker image is built in CI with no
 * DATABASE_URL. Pre-rendering the top cities at build would need one, and the
 * first-request cost is a single render per page.
 */
export async function generateStaticParams(): Promise<{ segments: string[] }[]> {
  return [];
}

interface Props {
  params: Promise<{ segments: string[] }>;
}

// No searchParams: reading them forces the route dynamic in Next 16, which
// would keep the city pillar pages out of the ISR cache entirely. Pagination
// lives in the path instead — /[city]/page/2.
/**
 * FAQ is admin-edited jsonb. Anything malformed is dropped rather than thrown —
 * a bad FAQ entry must not 500 the most important page on the site.
 */
function parseFaq(value: unknown): FaqEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const q = (item as Record<string, unknown>).question;
    const a = (item as Record<string, unknown>).answer;
    if (typeof q !== "string" || typeof a !== "string") return [];
    if (q.trim() === "" || a.trim() === "") return [];
    return [{ question: q, answer: a }];
  });
}

/** Schema descriptions are plain text; intro copy is stored as HTML. */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The reviews a page RENDERS, in the shape the JSON-LD builder takes.
 *
 * Built from the same array that is handed to the component, never from a
 * separate query: markup that asserts a review the page did not show is the
 * thing the whole module is careful about.
 */
function renderedReviews(reviews: PublicReview[]): RenderedReview[] {
  return reviews.map((r) => ({
    author: r.displayName ?? "Anonymous",
    rating: r.rating,
    title: r.title,
    body: r.body,
    published: r.createdAt,
  }));
}

/** Strips any trailing /page/N so pagination links build from the clean path. */
function pillarBasePath(segments: string[]): string {
  const rest =
    segments.length >= 2 && segments[segments.length - 2] === "page"
      ? segments.slice(0, -2)
      : segments;
  return `/${rest.join("/")}`;
}

export default async function CatchAllPage({ params }: Props) {
  const { segments } = await params;

  const result = await resolveRoute(db as never, segments, siteConfig.siteMode);

  switch (result.kind) {
    case "not-found":
      notFound();

    case "redirect":
      // A 410 row is a tombstone: the URL is gone, not moved, and it stores its
      // own path, so redirecting to it would loop.
      if (result.status === 410) notFound();
      if (result.status === 301 || result.status === 308) permanentRedirect(result.to);
      redirect(result.to);

    case "listing": {
      const detail = await getListingDetail(db as never, PUBLIC_VIEWER, result.listingId);
      if (!detail) notFound();

      const related = await relatedListings(
        db as never, PUBLIC_VIEWER, result.listingId, detail.listing.cityId,
      );
      const cityPath = `/${segments[0]}`;
      const path = `/${segments.join("/")}`;

      // `features.reviews` is a build-time constant, so with the flag off this
      // query, the block and the rating markup are all tree-shaken away.
      const reviews = features.reviews
        ? await reviewSummary(db as never, PUBLIC_VIEWER, result.listingId)
        : null;

      // Awards (Task 50): from the table and nowhere else, only with the flag
      // on. The same rows feed the block on the page and the `award` markup.
      const awards = features.awards
        ? await listingAwards(db as never, PUBLIC_VIEWER, result.listingId)
        : [];

      return (
        <>
          <JsonLd
            data={listingSchema({
              // Exactly the lines ListingAwards renders, or nothing.
              awards: awards.map(awardText),
              listing: detail.listing,
              city: detail.city,
              category: detail.category,
              path,
              // Exactly what ListingDetail renders, from the same helper: the
              // excerpt on a free tier, the socials only where they are shown.
              description: displayedDescription(detail.listing, siteConfig.tiers[detail.listing.tier]),
              sameAs: displayedSocials(detail.listing.socials, siteConfig.tiers[detail.listing.tier]),
              // Exactly the photos the Gallery renders, from the same helper:
              // live derivatives only, never an unprocessed original. Empty
              // when none is live, and `prune` then omits `image` entirely.
              imageUrls: galleryImages(detail.images, detail.listing.name).map((i) => i.full),
              // The rating is passed ONLY when the page is rendering the
              // summary block below it — same numbers, same query, one
              // decision. A count of zero renders nothing and asserts nothing.
              ...(reviews && reviews.count > 0 && reviews.average !== null
                ? {
                    rating: { value: reviews.average, count: reviews.count },
                    reviews: renderedReviews(reviews.recent),
                  }
                : {}),
            })}
          />
          <JsonLd
            data={breadcrumbSchema([
              { name: "Home", path: "/" },
              { name: detail.city.name, path: cityPath },
              { name: detail.listing.name, path },
            ])}
          />
          <SponsorRails
            placement="listingDetail"
            listing={{ tier: detail.listing.tier, claimStatus: detail.listing.claimStatus }}
          />
          <ListingDetail
            detail={detail}
            related={related}
            cityPath={cityPath}
            reviews={reviews}
            reviewsPath={`${path}/reviews`}
            leaveReviewPath={`/leave-review/${detail.listing.id}`}
            awards={awards}
          />
        </>
      );
    }

    case "listing-reviews": {
      // First line, before any query: with the flag off this URL is a 404 and
      // nothing below it exists.
      guardFeature("reviews");

      const detail = await getListingDetail(db as never, PUBLIC_VIEWER, result.listingId);
      if (!detail) notFound();

      const [rows, total] = await Promise.all([
        listPublishedReviews(db as never, PUBLIC_VIEWER, result.listingId, { page: result.page }),
        countPublishedReviews(db as never, PUBLIC_VIEWER, result.listingId),
      ]);

      const totalPages = Math.max(1, Math.ceil(total / REVIEWS_PER_PAGE));
      // Same rule as the pillar pages: a page past the end has nothing on it
      // and must 404 rather than render an empty, indexable page.
      if (result.page > totalPages) notFound();

      const cityPath = `/${segments[0]}`;
      const listingPath = `/${segments[0]}/${segments[1]}`;
      const basePath = pillarBasePath(segments);
      const pagePath = result.page === 1 ? basePath : `${basePath}/page/${result.page}`;
      const schema = reviewsPageSchema({
        listingName: detail.listing.name,
        listingPath,
        path: pagePath,
        reviews: renderedReviews(rows),
      });

      return (
        <>
          {schema && <JsonLd data={schema} />}
          <JsonLd
            data={breadcrumbSchema([
              { name: "Home", path: "/" },
              { name: detail.city.name, path: cityPath },
              { name: detail.listing.name, path: listingPath },
              { name: "Reviews", path: basePath },
            ])}
          />
          <ReviewsPage
            listingName={detail.listing.name}
            listingPath={listingPath}
            cityName={detail.city.name}
            cityPath={cityPath}
            reviews={rows}
            total={total}
            average={detail.listing.ratingAvg === null ? null : Number(detail.listing.ratingAvg)}
            page={result.page}
            totalPages={totalPages}
            basePath={basePath}
            leaveReviewPath={`/leave-review/${detail.listing.id}`}
          />
        </>
      );
    }

    case "pillar": {
      const heading = await pillarHeading(db as never, PUBLIC_VIEWER, result.scope, siteConfig.entity);
      if (!heading) notFound();

      const cityId = "cityId" in result.scope ? result.scope.cityId : null;

      // The town pillar lists its neighbourhoods (Task 52); nothing else does,
      // and nothing does with the module off.
      const withNeighbourhoods = result.scope.type === "city" && neighbourhoodsEnabled();

      const [rows, total, categories, nearby, featuredBids, neighbourhoods] = await Promise.all([
        listListings(db as never, PUBLIC_VIEWER, result.scope, { page: result.page }),
        countListings(db as never, PUBLIC_VIEWER, result.scope),
        cityId ? categoriesInCity(db as never, PUBLIC_VIEWER, cityId) : Promise.resolve([]),
        cityId ? nearbyCities(db, PUBLIC_VIEWER, cityId) : Promise.resolve([]),
        // Page 1 only: the paid row sits above the grid and nowhere else.
        result.page === 1 ? featuredForScope(db as never, PUBLIC_VIEWER, result.scope) : Promise.resolve([]),
        withNeighbourhoods && cityId
          ? cityNeighbourhoods(db as never, PUBLIC_VIEWER, cityId)
          : Promise.resolve([]),
      ]);

      // A featured listing is not listed twice, and the page has ONE
      // Featured section: the paid row when any bid holds a position, the
      // premium-tier row otherwise (from the grid, never from `rows`). The
      // ItemList below keeps every row it is handed — the featured cards are
      // on the page too.
      const { grid, premium } = pageRows(
        rows,
        featuredBids,
        result.page === 1 && siteConfig.tiers.premium.homepageSlot,
      );

      const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
      // A page number past the end has nothing on it and must not be a soft 404
      // — /leeds/page/999 rendered an empty, indexable page.
      if (result.page > totalPages) notFound();


      // Awards (Task 50): the "Winner <year>" pill on each card, from the
      // table, one query for the page. Empty (and tree-shaken) with the flag off.
      const awardYears = features.awards
        ? await awardYearsForListings(db as never, PUBLIC_VIEWER, rows.map((l) => l.id))
        : new Map<string, number[]>();

      const faq = parseFaq(heading.faq);

      const basePath = pillarBasePath(segments);
      const cityPath = `/${segments[0]}`;
      // Page 2 is its own URL with its own listings on it. Identifying it as
      // page 1 tells Google both pages are the same document.
      const pagePath = result.page === 1 ? basePath : `${basePath}/page/${result.page}`;

      const collection = {
        title: heading.title,
        path: pagePath,
        // The intro renders on page 1 only, so only page 1 describes
        // itself with it.
        description:
          result.page === 1 && heading.introHtml ? stripTags(heading.introHtml) : null,
        // A listing lives at /city/slug, never under the category or
        // neighbourhood segment — /leeds/{category}/{listing} is a 404.
        items: rows.map((l) => ({ name: l.name, path: `${cityPath}/${l.slug}` })),
      };
      // A neighbourhood (Task 52) names its town in the breadcrumb and in
      // `containedInPlace`, both from the same row the visible crumb uses.
      const town = heading.parent ? { name: heading.parent.name, path: `/${heading.parent.slug}` } : null;

      return (
        <>
          <JsonLd
            data={
              town
                ? neighbourhoodPillarSchema({ ...collection, neighbourhood: heading.place, city: town })
                : pillarSchema(collection)
            }
          />
          <JsonLd
            data={breadcrumbSchema([
              { name: "Home", path: "/" },
              ...(town ? [town] : []),
              { name: heading.place, path: basePath },
            ])}
          />
          {faq.length > 0 && <JsonLd data={faqSchema(faq)} />}
          <SponsorRails placement={placementForScope(result.scope)} />
          <PillarPage
            heading={heading}
            featured={premium}
            featuredBids={featuredBids}
            listings={grid}
            categories={categories}
            nearby={nearby}
            faq={faq}
            total={total}
            page={result.page}
            totalPages={totalPages}
            basePath={basePath}
            cityPath={cityPath}
            awardYears={awardYears}
            neighbourhoods={neighbourhoods}
            spotKey={
              // A neighbourhood has no featured spot of its own; offering the
              // town's there would sell a position the page does not show.
              cityId === null || result.scope.type === "city-area"
                ? undefined
                : `city:${cityId}:${result.scope.type === "city-category" ? result.scope.categoryId : "-"}`
            }
          />
        </>
      );
    }
  }
}

/** Trimmed to a length a SERP will actually show, on a word boundary. */
function metaDescription(text: string, max = 155): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

/**
 * Every kind the resolver can return gets its own metadata.
 *
 * Previously only pillars did, so every listing page on the site — the majority
 * of the URLs — shipped the bare site name as its title and the site tagline as
 * its description, and nothing carried a canonical at all.
 *
 * A city that has not earned indexing renders and works, but is noindex,follow
 * and stays out of the sitemap. This is the single most important SEO rule in
 * the build — thin one-listing city pages drag the whole domain down.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { segments } = await params;
  const result = await resolveRoute(db as never, segments, siteConfig.siteMode);

  if (result.kind === "listing") {
    const detail = await getListingDetail(db as never, PUBLIC_VIEWER, result.listingId);
    if (!detail) return {};

    const { listing, city, category } = detail;
    const noun = category?.singular ?? siteConfig.entity.Singular;
    const title = `${listing.name} — ${noun} in ${city.name}`;
    // The description the PAGE shows, so the snippet and the page agree.
    const shown = displayedDescription(listing, siteConfig.tiers[listing.tier]);
    const path = `/${city.slug}/${listing.slug}`;

    return {
      title,
      description: shown ? metaDescription(shown) : undefined,
      alternates: { canonical: path },
      openGraph: pageOpenGraph({ title, url: path }),
    };
  }

  if (result.kind === "listing-reviews") {
    if (!features.reviews) return {};
    const detail = await getListingDetail(db as never, PUBLIC_VIEWER, result.listingId);
    if (!detail) return {};

    const total = await countPublishedReviews(db as never, PUBLIC_VIEWER, result.listingId);
    const basePath = `/${detail.city.slug}/${detail.listing.slug}/reviews`;
    const onPageOne = result.page === 1;
    const path = onPageOne ? basePath : `${basePath}/page/${result.page}`;
    const title = onPageOne
      ? `Reviews of ${detail.listing.name}`
      : `Reviews of ${detail.listing.name} — page ${result.page}`;

    return {
      title,
      description:
        total > 0
          ? metaDescription(
              `Read ${total} verified ${total === 1 ? "review" : "reviews"} of ${detail.listing.name} in ${detail.city.name}.`,
            )
          : undefined,
      alternates: { canonical: path },
      openGraph: pageOpenGraph({ title, url: path }),
      // A reviews page with no reviews on it has nothing to rank for and would
      // be a thin duplicate of the listing page on every listing that has none
      // — which, on a young directory, is most of them.
      robots: total === 0 ? { index: false, follow: true } : undefined,
    };
  }

  if (result.kind !== "pillar") return {};

  const heading = await pillarHeading(db as never, PUBLIC_VIEWER, result.scope, siteConfig.entity);
  if (!heading) return {};

  const basePath = pillarBasePath(segments);
  const onPageOne = result.page === 1;
  // Page N is its own canonical. Pointing it at page 1 asks Google to drop
  // every listing that only appears on page N.
  const path = onPageOne ? basePath : `${basePath}/page/${result.page}`;
  const title = onPageOne ? heading.title : `${heading.title} — page ${result.page}`;

  const intro = heading.introHtml ? metaDescription(stripTags(heading.introHtml)) : null;
  const description = intro === null
    ? undefined
    : onPageOne ? intro : `${intro} — page ${result.page}`;

  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: pageOpenGraph({ title, url: path }),
    robots: heading.isIndexable ? undefined : { index: false, follow: true },
  };
}

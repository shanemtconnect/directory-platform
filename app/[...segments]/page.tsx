import { notFound, permanentRedirect, redirect } from "next/navigation";
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
import { listingSchema, pillarSchema, breadcrumbSchema, faqSchema } from "@/lib/schema/builders";
import { categoriesInCity, nearbyCities } from "@/lib/db/queries/indexes";
import type { FaqEntry } from "@/components/pillar/PillarPage";

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

/** Images live on the Cloudflare-proxied R2 domain; schema.org needs absolutes. */
function absoluteMediaUrl(path: string | null): string | null {
  const base = process.env.NEXT_PUBLIC_MEDIA_URL;
  if (!base || !path) return null;
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

/** Schema descriptions are plain text; intro copy is stored as HTML. */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
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

      return (
        <>
          <JsonLd
            data={listingSchema({
              listing: detail.listing,
              city: detail.city,
              category: detail.category,
              path,
              imageUrls: detail.images
                .map((i) => absoluteMediaUrl(i.storagePath))
                .filter((u): u is string => u !== null),
              // No rating is passed: reviews land in Phase 6, and until the
              // rating is visible on the page it must not be in the markup.
            })}
          />
          <JsonLd
            data={breadcrumbSchema([
              { name: "Home", path: "/" },
              { name: detail.city.name, path: cityPath },
              { name: detail.listing.name, path },
            ])}
          />
          <ListingDetail detail={detail} related={related} cityPath={cityPath} />
        </>
      );
    }

    case "pillar": {
      const heading = await pillarHeading(
        db as never, PUBLIC_VIEWER, result.scope, siteConfig.entity.Plural,
      );
      if (!heading) notFound();

      const cityId = "cityId" in result.scope ? result.scope.cityId : null;

      const [rows, total, categories, nearby] = await Promise.all([
        listListings(db as never, PUBLIC_VIEWER, result.scope, { page: result.page }),
        countListings(db as never, PUBLIC_VIEWER, result.scope),
        cityId ? categoriesInCity(db as never, PUBLIC_VIEWER, cityId) : Promise.resolve([]),
        cityId ? nearbyCities(db as never, cityId) : Promise.resolve([]),
      ]);

      const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
      // A page number past the end has nothing on it and must not be a soft 404
      // — /leeds/page/999 rendered an empty, indexable page.
      if (result.page > totalPages) notFound();

      // Premium listings shown as a featured row on page 1. They also appear in
      // the main grid — the row is prominence, not a separate inventory.
      const featured = result.page === 1
        ? rows.filter((l) => l.tier === "premium" && siteConfig.tiers.premium.homepageSlot).slice(0, 3)
        : [];

      const faq = parseFaq(heading.faq);

      const basePath = pillarBasePath(segments);
      return (
        <>
          <JsonLd
            data={pillarSchema({
              title: heading.title,
              path: basePath,
              description: heading.introHtml ? stripTags(heading.introHtml) : null,
              items: rows.map((l) => ({ name: l.name, path: `${basePath}/${l.slug}` })),
            })}
          />
          <JsonLd
            data={breadcrumbSchema([
              { name: "Home", path: "/" },
              { name: heading.place, path: basePath },
            ])}
          />
          {faq.length > 0 && <JsonLd data={faqSchema(faq)} />}
          <PillarPage
            heading={heading}
            featured={featured}
            listings={rows}
            categories={categories}
            nearby={nearby}
            faq={faq}
            page={result.page}
            totalPages={totalPages}
            basePath={basePath}
            cityPath={`/${segments[0]}`}
          />
        </>
      );
    }
  }
}

/**
 * A city that has not earned indexing renders and works, but is noindex,follow
 * and stays out of the sitemap. This is the single most important SEO rule in
 * the build — thin one-listing city pages drag the whole domain down.
 */
export async function generateMetadata({ params }: Props) {
  const { segments } = await params;
  const result = await resolveRoute(db as never, segments, siteConfig.siteMode);
  if (result.kind !== "pillar") return {};

  const heading = await pillarHeading(
    db as never, PUBLIC_VIEWER, result.scope, siteConfig.entity.Plural,
  );
  if (!heading) return {};

  return {
    title: heading.title,
    robots: heading.isIndexable ? undefined : { index: false, follow: true },
  };
}

import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { siteConfig } from "@/config/site.config";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { PER_PAGE } from "@/lib/db/queries/listings";
import {
  regionBySlug, listRegionListings, countRegionListings, topCategoriesInRegion,
  type RegionPage,
} from "@/lib/db/queries/areas";
import { redirects } from "@/lib/db/schema";
import { countryProfile } from "@/lib/geo/countries";
import { JsonLd } from "@/components/seo/JsonLd";
import { regionPillarSchema } from "@/lib/schema/builders";
import { pageOpenGraph } from "@/lib/seo/open-graph";
import { regionIntro } from "@/lib/areas/intro";
import { RegionPillar } from "@/components/areas/RegionPillar";
import {
  REGION_BASE, parseRegionSegments, regionPagePath, regionPath,
} from "@/lib/routing/regions";

export const revalidate = 3600;

/** Deliberately empty — see app/categories/[...category]/page.tsx for why. */
export async function generateStaticParams(): Promise<{ region: string[] }[]> {
  return [];
}

interface Props {
  params: Promise<{ region: string[] }>;
}

const e = siteConfig.entity;
const profile = countryProfile(siteConfig.country);
const INDEX_TITLE = `${e.Plural} by ${profile.regionLabel}`;

type Resolved =
  | { kind: "page"; region: RegionPage; page: number }
  | { kind: "redirect"; to: string }
  | { kind: "not-found" };

/**
 * Path rules first, then the lookup, then the redirects table.
 *
 * A region that no longer resolves — renamed, or its last city unpublished —
 * falls through to `redirects`, which is where `renameRegion` wrote the 301.
 * Same order as the city catch-all: an exact redirect row is only consulted
 * once resolution has failed, so a live page is never shadowed by a stale
 * row.
 */
async function resolve(segments: string[]): Promise<Resolved> {
  if (siteConfig.siteMode !== "niche-national") return { kind: "not-found" };

  const parsed = parseRegionSegments(segments);
  if (parsed.kind !== "page") return parsed;

  const region = await regionBySlug(db as never, PUBLIC_VIEWER, parsed.slug);
  if (region) return { kind: "page", region, page: parsed.page };

  const [row] = await db
    .select({ to: redirects.toPath, status: redirects.statusCode })
    .from(redirects)
    .where(eq(redirects.fromPath, regionPath(parsed.slug)))
    .limit(1);
  // A 410 row is a tombstone that stores its own path; 404 rather than loop.
  if (row && row.status !== 410) return { kind: "redirect", to: row.to };
  return { kind: "not-found" };
}

const titleFor = (region: RegionPage, page: number): string =>
  page === 1 ? `${e.Plural} in ${region.name}` : `${e.Plural} in ${region.name} — page ${page}`;

export default async function RegionRoute({ params }: Props) {
  const { region: segments } = await params;
  const resolved = await resolve(segments);
  // next/navigation cannot emit a 301 from a server component; 308 is the
  // same permanent signal the city catch-all serves.
  if (resolved.kind === "redirect") permanentRedirect(resolved.to);
  if (resolved.kind !== "page") notFound();
  const { region, page } = resolved;

  const [rows, total, categories] = await Promise.all([
    listRegionListings(db as never, PUBLIC_VIEWER, region.names, { page }),
    countRegionListings(db as never, PUBLIC_VIEWER, region.names),
    topCategoriesInRegion(db as never, PUBLIC_VIEWER, region.names),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  // Past the end there is nothing on the page; a soft 404 must not be indexable.
  if (page > totalPages) notFound();

  const basePath = regionPath(region.slug);
  const pagePath = regionPagePath(region.slug, page);
  const title = titleFor(region, page);
  const intro = regionIntro({
    region: region.name,
    country: profile.name,
    regionLabel: profile.regionLabel,
    entity: e,
    listingCount: total,
    cityCount: region.cities.length,
  });

  return (
    <>
      <JsonLd
        data={regionPillarSchema({
          title,
          region: region.name,
          // Page N is its own document with its own listings on it.
          path: pagePath,
          // The intro renders on page 1 only, so only page 1 describes itself with it.
          description: page === 1 ? intro : null,
          // /[city]/[listing] — never under /areas.
          items: rows.map((r) => ({ name: r.listing.name, path: `/${r.citySlug}/${r.listing.slug}` })),
        })}
      />
      <RegionPillar
        region={region}
        trail={[
          { name: "Home", path: "/" },
          { name: INDEX_TITLE, path: REGION_BASE },
          { name: region.name, path: basePath },
        ]}
        title={title}
        intro={intro}
        listings={rows}
        categories={categories}
        total={total}
        page={page}
        totalPages={totalPages}
        basePath={basePath}
      />
    </>
  );
}

/**
 * noindex,follow until at least one city in the region has earned indexing —
 * the region page's own gate (lib/db/queries/areas.ts). Page N canonicalises
 * to itself, never to page 1.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { region: segments } = await params;
  const resolved = await resolve(segments);
  if (resolved.kind !== "page") return {};
  const { region, page } = resolved;

  const total = await countRegionListings(db as never, PUBLIC_VIEWER, region.names);
  const path = regionPagePath(region.slug, page);
  const title = titleFor(region, page);
  const intro = regionIntro({
    region: region.name,
    country: profile.name,
    regionLabel: profile.regionLabel,
    entity: e,
    listingCount: total,
    cityCount: region.cities.length,
  });

  return {
    title,
    description: page === 1 ? intro : `${intro} — page ${page}`,
    alternates: { canonical: path },
    openGraph: pageOpenGraph({ title, url: path }),
    robots: region.isIndexable ? undefined : { index: false, follow: true },
  };
}

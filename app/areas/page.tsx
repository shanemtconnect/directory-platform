import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { prerenderingWithoutDatabase } from "@/lib/db/build-phase";
import { siteConfig } from "@/config/site.config";
import { listRegions } from "@/lib/db/queries/areas";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { countryProfile } from "@/lib/geo/countries";
import { JsonLd } from "@/components/seo/JsonLd";
import { Breadcrumbs } from "@/components/seo/Breadcrumbs";
import { pillarSchema } from "@/lib/schema/builders";
import { pageOpenGraph } from "@/lib/seo/open-graph";
import { RegionIndex } from "@/components/areas/RegionIndex";
import { REGION_BASE, regionPath } from "@/lib/routing/regions";

export const revalidate = 3600;

const e = siteConfig.entity;
const profile = countryProfile(siteConfig.country);
/** The same words the footer link uses (lib/features/navigation.ts). */
const TITLE = `${e.Plural} by ${profile.regionLabel}`;

/**
 * /areas — the region index. ISR like /cities, and for the same reason
 * (see the note there on `prerenderingWithoutDatabase`).
 *
 * Only on niche-national: `cities.region` is that mode's concept. On a
 * local-multi-vertical clone this route is not advertised anywhere and 404s,
 * rather than rendering an orphan page over the wrong table.
 */
async function regions() {
  if (siteConfig.siteMode !== "niche-national") notFound();
  return prerenderingWithoutDatabase() ? [] : listRegions(db as never, PUBLIC_VIEWER);
}

export default async function AreasIndex() {
  const rows = await regions();

  return (
    <>
      <JsonLd
        data={pillarSchema({
          title: TITLE,
          path: REGION_BASE,
          items: rows.map((r) => ({ name: r.name, path: regionPath(r.slug) })),
        })}
      />
      <Breadcrumbs trail={[{ name: "Home", path: "/" }, { name: TITLE, path: REGION_BASE }]} />
      <RegionIndex regions={rows} heading={TITLE} />
    </>
  );
}

/**
 * Indexable exactly when something on it is: `listRegions` returns the
 * regions with at least one indexable city, so an empty list is a page with
 * nothing to rank for.
 */
export async function generateMetadata(): Promise<Metadata> {
  const rows = await regions();
  return {
    title: TITLE,
    description: `Browse ${e.plural} by ${profile.regionLabel} across ${profile.name}.`,
    alternates: { canonical: REGION_BASE },
    openGraph: pageOpenGraph({ title: TITLE, url: REGION_BASE }),
    robots: rows.length > 0 ? undefined : { index: false, follow: true },
  };
}

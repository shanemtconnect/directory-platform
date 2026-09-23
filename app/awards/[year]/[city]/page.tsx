import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { prerenderingWithoutDatabase } from "@/lib/db/build-phase";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import {
  awardWinners, awardsCityPath, parseAwardYear, type AwardWinnersPage,
} from "@/lib/db/queries/awards";
import { guardFeature } from "@/lib/features/guard";
import { Breadcrumbs } from "@/components/seo/Breadcrumbs";
import { JsonLd } from "@/components/seo/JsonLd";
import { pillarSchema } from "@/lib/schema/builders";
import { AwardsIntro } from "@/components/awards/AwardsIntro";
import { AwardPill } from "@/components/awards/AwardPill";

export const revalidate = 3600;
export const dynamicParams = true;

/** Empty for the same reason app/[...segments] is: the image is built with no database. */
export async function generateStaticParams(): Promise<{ year: string; city: string }[]> {
  return [];
}

interface Props {
  params: Promise<{ year: string; city: string }>;
}

/**
 * /awards/[year]/[city] — the winners by category (Task 50). 404 unless there
 * is at least one, so every URL that renders has something worth indexing.
 * The ItemList is the winners on the page, in the order they are shown, and
 * nothing else: no ratings are asserted here, they live on the listing page.
 */

async function load(params: Props["params"]): Promise<AwardWinnersPage | null> {
  const { year: rawYear, city } = await params;
  const year = parseAwardYear(rawYear);
  if (year === null) return null;
  if (prerenderingWithoutDatabase()) return null;
  return awardWinners(db as never, PUBLIC_VIEWER, year, city);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  guardFeature("awards");
  const data = await load(params);
  if (!data) return { title: "Not found", robots: { index: false, follow: false } };
  return {
    title: `${data.year} award winners in ${data.city.name}`,
    description: `The highest-rated ${siteConfig.entity.plural} in ${data.city.name} for ${data.year}, one per category, computed from published reviews.`,
    alternates: { canonical: awardsCityPath(data.year, data.city.slug) },
  };
}

export default async function AwardCityPage({ params }: Props) {
  guardFeature("awards");
  const data = await load(params);
  if (!data) notFound();
  const { year, city, winners } = data;
  const path = awardsCityPath(year, city.slug);
  const e = siteConfig.entity;

  return (
    <>
      <JsonLd
        data={pillarSchema({
          title: `${year} award winners in ${city.name}`,
          path,
          items: winners.map((w) => ({ name: w.listing.name, path: w.listing.path })),
        })}
      />
      <main>
        <Breadcrumbs
          trail={[
            { name: "Home", path: "/" },
            { name: "Awards", path: "/awards" },
            { name: `${year} winners`, path: `/awards/${year}` },
            { name: city.name, path },
          ]}
        />
        <h1>{year} award winners in {city.name}</h1>
        <AwardsIntro />
        <ul className="card-grid" data-testid="award-winners">
          {winners.map((w) => (
            <li key={w.awardId} className="card flex flex-col gap-2" data-category={w.category.id}>
              <h2 className="m-0 text-base font-semibold text-muted">{w.category.name}</h2>
              <a
                href={w.listing.path}
                className="font-heading text-lg leading-snug font-semibold text-ink no-underline hover:text-primary hover:underline"
                data-testid="award-winner-link"
              >
                {w.listing.name}
              </a>
              <AwardPill year={year} />
              {w.listing.ratingAvg !== null && w.listing.ratingCount > 0 && (
                <p className="mb-0 text-sm text-muted">
                  Rated {w.listing.ratingAvg} from {w.listing.ratingCount}{" "}
                  {w.listing.ratingCount === 1 ? "review" : "reviews"}
                </p>
              )}
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted">
          <a href={`/${city.slug}`}>All {e.plural} in {city.name}</a>
          {" · "}
          <a href={`/awards/${year}`}>Every town with a {year} winner</a>
        </p>
      </main>
    </>
  );
}

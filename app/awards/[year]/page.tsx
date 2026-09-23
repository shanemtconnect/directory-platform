import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { prerenderingWithoutDatabase } from "@/lib/db/build-phase";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { awardCities, awardsCityPath, parseAwardYear, type AwardCity } from "@/lib/db/queries/awards";
import { guardFeature } from "@/lib/features/guard";
import { Breadcrumbs } from "@/components/seo/Breadcrumbs";
import { AwardsIntro } from "@/components/awards/AwardsIntro";

export const revalidate = 3600;
export const dynamicParams = true;

/** Empty for the same reason app/[...segments] is: the image is built with no database. */
export async function generateStaticParams(): Promise<{ year: string }[]> {
  return [];
}

interface Props {
  params: Promise<{ year: string }>;
}

/**
 * /awards/[year] — the towns with a winner that year (Task 50). A year with
 * no winner is a 404, never an empty page: the URL exists when the content
 * does, which is also what makes it safe to index whenever it renders.
 */

async function load(params: Props["params"]): Promise<{ year: number; cities: AwardCity[] } | null> {
  const year = parseAwardYear((await params).year);
  if (year === null) return null;
  const cities = prerenderingWithoutDatabase() ? [] : await awardCities(db as never, PUBLIC_VIEWER, year);
  if (cities.length === 0) return null;
  return { year, cities };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  guardFeature("awards");
  const data = await load(params);
  if (!data) return { title: "Not found", robots: { index: false, follow: false } };
  return {
    title: `${data.year} ${siteConfig.name} award winners`,
    description: `The highest-rated ${siteConfig.entity.plural} of ${data.year} in ${data.cities.length} ${data.cities.length === 1 ? "town" : "towns"}, computed from published reviews.`,
    alternates: { canonical: `/awards/${data.year}` },
  };
}

export default async function AwardYearPage({ params }: Props) {
  guardFeature("awards");
  const data = await load(params);
  if (!data) notFound();
  const { year, cities } = data;

  return (
    <main>
      <Breadcrumbs
        trail={[
          { name: "Home", path: "/" },
          { name: "Awards", path: "/awards" },
          { name: `${year} winners`, path: `/awards/${year}` },
        ]}
      />
      <h1>{year} {siteConfig.name} award winners</h1>
      <AwardsIntro />
      <ul className="link-grid" data-testid="award-cities">
        {cities.map((c) => (
          <li key={c.cityId}>
            <a href={awardsCityPath(year, c.slug)}>{c.name}</a>{" "}
            <span className="text-muted">
              ({c.winners} {c.winners === 1 ? "winner" : "winners"})
            </span>
          </li>
        ))}
      </ul>
    </main>
  );
}

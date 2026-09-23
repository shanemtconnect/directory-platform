import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { prerenderingWithoutDatabase } from "@/lib/db/build-phase";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { awardYears, type AwardYear } from "@/lib/db/queries/awards";
import { guardFeature } from "@/lib/features/guard";
import { Breadcrumbs } from "@/components/seo/Breadcrumbs";
import { AwardsIntro } from "@/components/awards/AwardsIntro";

export const revalidate = 3600;

/**
 * /awards — the years (Task 50).
 *
 * ISR like the other index pages. Indexable only once there is a winner to
 * show: a page that says "no awards yet" is a thin page, so until then it
 * carries noindex and is left out of nothing else (the nav still links it,
 * because the explanation of how awards work is worth a click even before
 * the first one exists).
 */

async function years(): Promise<AwardYear[]> {
  return prerenderingWithoutDatabase() ? [] : awardYears(db as never, PUBLIC_VIEWER);
}

export async function generateMetadata(): Promise<Metadata> {
  guardFeature("awards");
  const list = await years();
  return {
    title: `${siteConfig.name} awards`,
    description: `The highest-rated ${siteConfig.entity.plural} in every town, by year — computed from published reviews.`,
    alternates: { canonical: "/awards" },
    robots: list.length > 0 ? { index: true, follow: true } : { index: false, follow: true },
  };
}

export default async function AwardsIndex() {
  guardFeature("awards");
  const list = await years();
  const e = siteConfig.entity;

  return (
    <main>
      <Breadcrumbs trail={[{ name: "Home", path: "/" }, { name: "Awards", path: "/awards" }]} />
      <h1>{siteConfig.name} awards</h1>
      <AwardsIntro />
      {list.length === 0 ? (
        <p data-testid="awards-empty">
          No awards have been decided yet. The first winners are announced once enough {e.plural}{" "}
          have been reviewed.
        </p>
      ) : (
        <ul className="link-grid" data-testid="award-years">
          {list.map((y) => (
            <li key={y.year}>
              <a href={`/awards/${y.year}`}>{y.year} winners</a>{" "}
              <span className="text-muted">
                ({y.winners} in {y.cities} {y.cities === 1 ? "town" : "towns"})
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

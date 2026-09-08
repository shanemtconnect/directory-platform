import type { Metadata } from "next";
import { db } from "@/lib/db/client";
import { siteConfig } from "@/config/site.config";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { topCities, topCategories, featuredListings } from "@/lib/db/queries/homepage";
import { countryProfile } from "@/lib/geo/countries";
import { JsonLd } from "@/components/seo/JsonLd";
import { breadcrumbSchema } from "@/lib/schema/builders";
import { HomeSearch } from "@/components/home/HomeSearch";
import { BrowseByLocation } from "@/components/home/BrowseByLocation";
import { BrowseByType } from "@/components/home/BrowseByType";
import { FeaturedListings } from "@/components/home/FeaturedListings";

export const revalidate = 3600;

// `absolute` because the root layout's title template would otherwise render
// the site name twice on its own homepage.
export const metadata: Metadata = {
  title: { absolute: `${siteConfig.name} — ${siteConfig.tagline}` },
  description: siteConfig.tagline,
};

export default async function HomePage() {
  const e = siteConfig.entity;
  const profile = countryProfile(siteConfig.country);

  const [cities, categories, featured] = await Promise.all([
    topCities(db as never, PUBLIC_VIEWER),
    topCategories(db as never, PUBLIC_VIEWER),
    featuredListings(db as never, PUBLIC_VIEWER),
  ]);

  return (
    <>
      {/* Organization and WebSite are emitted once in the root layout. */}
      <JsonLd data={breadcrumbSchema([{ name: "Home", path: "/" }])} />

      <main>
        <header>
          <h1>{siteConfig.name}</h1>
          <p>{siteConfig.tagline}</p>
          <p>
            Compare {e.plural} across {profile.name} by location and by type, then
            enquire directly.
          </p>
        </header>

        <HomeSearch cities={cities} />

        <FeaturedListings listings={featured} />

        <BrowseByLocation cities={cities} />

        <BrowseByType categories={categories} />

        <section aria-labelledby="add-listing-cta">
          <h2 id="add-listing-cta">Are you a {e.ownerNoun}?</h2>
          <p>
            {`Add your ${e.singular} and start receiving enquiries.`}
          </p>
          <p>
            <a href="/add-listing">{`Add your ${e.singular}`}</a>
          </p>
        </section>
      </main>
    </>
  );
}

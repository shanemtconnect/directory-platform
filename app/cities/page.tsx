import type { Metadata } from "next";
import { db } from "@/lib/db/client";
import { siteConfig } from "@/config/site.config";
import { listCities } from "@/lib/db/queries/indexes";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { countryProfile } from "@/lib/geo/countries";
import { JsonLd } from "@/components/seo/JsonLd";
import { Breadcrumbs } from "@/components/seo/Breadcrumbs";
import { pillarSchema } from "@/lib/schema/builders";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: `${siteConfig.entity.Plural} by location`,
  description: `Browse ${siteConfig.entity.plural} by town and city.`,
  alternates: { canonical: "/cities" },
};

export default async function CitiesIndex() {
  const cities = await listCities(db as never, PUBLIC_VIEWER);
  const e = siteConfig.entity;
  const profile = countryProfile(siteConfig.country);

  // Group by region for scannability. Region never appears in a URL — it is a
  // display and disambiguation device only.
  const byRegion = new Map<string, typeof cities>();
  for (const city of cities) {
    const key = city.region ?? "Other";
    byRegion.set(key, [...(byRegion.get(key) ?? []), city]);
  }
  const regions = [...byRegion.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <>
      <JsonLd
        data={pillarSchema({
          title: `${e.Plural} by location`,
          path: "/cities",
          items: cities.map((c) => ({ name: c.name, path: `/${c.slug}` })),
        })}
      />
      <main>
        <Breadcrumbs trail={[{ name: "Home", path: "/" }, { name: "Locations", path: "/cities" }]} />
        <h1>{e.Plural} by location</h1>
        {cities.length === 0 ? (
          <p>No locations are listed yet.</p>
        ) : (
          regions.map(([region, list]) => (
            <section key={region}>
              <h2>{region === "Other" ? profile.name : region}</h2>
              <ul className="link-grid">
                {list.map((c) => (
                  <li key={c.id}>
                    <a href={`/${c.slug}`}>{c.name}</a>{" "}
                    <span>({c.listingCount})</span>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </main>
    </>
  );
}

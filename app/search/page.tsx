import type { Metadata } from "next";
import { db } from "@/lib/db/client";
import { siteConfig } from "@/config/site.config";
import type { CustomField } from "@/config/types";
import { search } from "@/lib/db/queries/search";
import { listCities, listCategories } from "@/lib/db/queries/indexes";
import { listSwitcherCities } from "@/lib/db/queries/cities";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { Pagination } from "@/components/pillar/Pagination";
import { LocationSwitcher } from "@/components/location/LocationSwitcher";
import { searchCityHref } from "@/components/location/switcher-links";
import { StatsBeacon } from "@/components/stats/StatsBeacon";
import { SponsorRails } from "@/components/ads/SponsorRails";

// Search is a utility page, not an indexable asset. Faceted URLs are a classic
// source of near-duplicate thin pages, so it is noindexed and excluded from the
// sitemap rather than left to compete with the pillar pages it should feed.
export const metadata: Metadata = {
  title: "Search",
  // Query-less canonical: every faceted variant of this page is the same page.
  alternates: { canonical: "/search" },
  robots: { index: false, follow: true },
};

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export default async function SearchPage({ searchParams }: Props) {
  const sp = await searchParams;
  const e = siteConfig.entity;
  const customFields: readonly CustomField[] = siteConfig.customFields;
  const facets = customFields.filter((f) => f.searchable === true);

  const fields: Record<string, string> = {};
  for (const f of facets) {
    const v = one(sp[f.key]);
    if (v) fields[f.key] = v;
  }

  const params = {
    q: one(sp.q),
    city: one(sp.city),
    category: one(sp.category),
    fields,
    page: Number(one(sp.page) ?? "1") || 1,
  };

  // The switcher takes the facet as the slug it already is, so it resolves the
  // current city itself and this query runs alongside the other three rather
  // than waiting on listCities to hand it an id.
  const [results, cities, categories, switcherCities] = await Promise.all([
    search(db as never, PUBLIC_VIEWER, params),
    listCities(db as never, PUBLIC_VIEWER),
    listCategories(db as never, PUBLIC_VIEWER),
    listSwitcherCities(db as never, PUBLIC_VIEWER, { currentCitySlug: params.city ?? null }),
  ]);

  // Preserve every active filter in pagination links.
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.city) qs.set("city", params.city);
  if (params.category) qs.set("category", params.category);
  for (const [k, v] of Object.entries(fields)) qs.set(k, v);
  const basePath = `/search${qs.toString() ? `?${qs}` : ""}`;

  return (
    <>
    <SponsorRails placement="search" />
    <main>
      <h1>Search {e.plural}</h1>

      <form
        method="get"
        action="/search"
        data-testid="search-form"
        className="card grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        <p className="mb-0">
          <label htmlFor="q">Keyword</label>
          <input id="q" name="q" type="search" defaultValue={params.q ?? ""}
            placeholder={`Search ${e.plural}`} className="max-w-none" />
        </p>

        <p className="mb-0">
          <label htmlFor="city">Location</label>
          <select id="city" name="city" defaultValue={params.city ?? ""} className="max-w-none">
            <option value="">Anywhere</option>
            {cities.map((c) => <option key={c.id} value={c.slug}>{c.name}</option>)}
          </select>
        </p>

        <p className="mb-0">
          <label htmlFor="category">Type</label>
          <select id="category" name="category" defaultValue={params.category ?? ""} className="max-w-none">
            <option value="">Any type</option>
            {categories.map((c) => <option key={c.id} value={c.slug}>{c.name}</option>)}
          </select>
        </p>

        {facets.map((f) => (
          <p key={f.key} className="mb-0">
            <label htmlFor={f.key}>{f.label}</label>
            {f.type === "boolean" ? (
              <select id={f.key} name={f.key} defaultValue={fields[f.key] ?? ""} className="max-w-none">
                <option value="">Any</option>
                <option value="true">Yes</option>
              </select>
            ) : (
              <input id={f.key} name={f.key} type="number" min={0}
                defaultValue={fields[f.key] ?? ""} placeholder="Minimum" className="max-w-none" />
            )}
          </p>
        ))}

        <button type="submit" className="btn btn-primary sm:col-span-2 sm:w-fit lg:col-span-1">
          Search
        </button>
      </form>

      {/*
        The city facet as links rather than a second select: a `<select>` needs
        the form submitted to go anywhere, and one click is the whole point.
        Each href is this same search with one facet changed — /search is
        noindex,follow and canonicalises to itself, so no faceted URL here can
        become a competing document.
      */}
      <LocationSwitcher
        label="Narrow to"
        cities={switcherCities}
        hrefFor={(city) => searchCityHref(city.slug, { ...fields, q: params.q, category: params.category })}
        className="mt-6"
        testId="search-location-switcher"
      />

      <p data-testid="result-count" className="mt-8 font-medium">
        {results.total} {results.total === 1 ? e.singular : e.plural} found
      </p>

      {results.rows.length === 0 ? (
        <p>
          Nothing matched. Try removing a filter, or{" "}
          <a href="/cities">browse by location</a>.
        </p>
      ) : (
        <ul data-testid="search-results" className="card-grid">
          {results.rows.map((r) => (
            <li key={r.id} data-tier={r.tier} className="card card-hover flex flex-col gap-1">
              <a
                href={`/${r.citySlug}/${r.slug}`}
                className="font-heading text-lg leading-snug font-semibold text-ink no-underline hover:text-primary hover:underline"
              >
                {r.name}
              </a>
              <span className="text-sm text-muted">{r.cityName}</span>
              {r.shortDescription && (
                <p className="mt-1 mb-0 text-sm text-muted">{r.shortDescription}</p>
              )}
              {/* Every result is an impression; one beacon carries the page. */}
              <StatsBeacon listingId={r.id} metric="impression" />
            </li>
          ))}
        </ul>
      )}

      <Pagination basePath={basePath} page={results.page} totalPages={results.totalPages} searchStyle />
    </main>
    </>
  );
}

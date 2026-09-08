import type { Metadata } from "next";
import { db } from "@/lib/db/client";
import { siteConfig } from "@/config/site.config";
import type { CustomField } from "@/config/types";
import { search } from "@/lib/db/queries/search";
import { listCities, listCategories } from "@/lib/db/queries/indexes";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { Pagination } from "@/components/pillar/Pagination";

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

  const [results, cities, categories] = await Promise.all([
    search(db as never, PUBLIC_VIEWER, params),
    listCities(db as never, PUBLIC_VIEWER),
    listCategories(db as never, PUBLIC_VIEWER),
  ]);

  // Preserve every active filter in pagination links.
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.city) qs.set("city", params.city);
  if (params.category) qs.set("category", params.category);
  for (const [k, v] of Object.entries(fields)) qs.set(k, v);
  const basePath = `/search${qs.toString() ? `?${qs}` : ""}`;

  return (
    <main>
      <h1>Search {e.plural}</h1>

      <form method="get" action="/search" data-testid="search-form">
        <p>
          <label htmlFor="q">Keyword</label>
          <input id="q" name="q" type="search" defaultValue={params.q ?? ""}
            placeholder={`Search ${e.plural}`} />
        </p>

        <p>
          <label htmlFor="city">Location</label>
          <select id="city" name="city" defaultValue={params.city ?? ""}>
            <option value="">Anywhere</option>
            {cities.map((c) => <option key={c.id} value={c.slug}>{c.name}</option>)}
          </select>
        </p>

        <p>
          <label htmlFor="category">Type</label>
          <select id="category" name="category" defaultValue={params.category ?? ""}>
            <option value="">Any type</option>
            {categories.map((c) => <option key={c.id} value={c.slug}>{c.name}</option>)}
          </select>
        </p>

        {facets.map((f) => (
          <p key={f.key}>
            <label htmlFor={f.key}>{f.label}</label>
            {f.type === "boolean" ? (
              <select id={f.key} name={f.key} defaultValue={fields[f.key] ?? ""}>
                <option value="">Any</option>
                <option value="true">Yes</option>
              </select>
            ) : (
              <input id={f.key} name={f.key} type="number" min={0}
                defaultValue={fields[f.key] ?? ""} placeholder="Minimum" />
            )}
          </p>
        ))}

        <button type="submit">Search</button>
      </form>

      <p data-testid="result-count">
        {results.total} {results.total === 1 ? e.singular : e.plural} found
      </p>

      {results.rows.length === 0 ? (
        <p>
          Nothing matched. Try removing a filter, or{" "}
          <a href="/cities">browse by location</a>.
        </p>
      ) : (
        <ul data-testid="search-results">
          {results.rows.map((r) => (
            <li key={r.id} data-tier={r.tier}>
              <a href={`/${r.citySlug}/${r.slug}`}>{r.name}</a>
              <span> — {r.cityName}</span>
              {r.shortDescription && <p>{r.shortDescription}</p>}
            </li>
          ))}
        </ul>
      )}

      <Pagination basePath={basePath} page={results.page} totalPages={results.totalPages} searchStyle />
    </main>
  );
}

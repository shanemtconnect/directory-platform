import { siteConfig } from "@/config/site.config";
import type { CityIndexRow } from "@/lib/db/queries/indexes";

/**
 * A plain GET form posting to /search. No client JS: the homepage is the most
 * cached page on the site and the search page already does the work. Field
 * names must stay in step with app/search/page.tsx — `q` and `city`.
 */
export function HomeSearch({ cities }: { cities: CityIndexRow[] }) {
  const e = siteConfig.entity;

  return (
    <search className="mb-10 block">
      <form
        method="get"
        action="/search"
        data-testid="home-search"
        className="card grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        <p className="mb-0">
          <label htmlFor="home-q">Keyword</label>
          <input
            id="home-q"
            name="q"
            type="search"
            placeholder={`Search ${e.plural}`}
            className="max-w-none"
          />
        </p>

        <p className="mb-0">
          <label htmlFor="home-city">Location</label>
          <select id="home-city" name="city" defaultValue="" className="max-w-none">
            <option value="">Anywhere</option>
            {cities.map((c) => (
              <option key={c.id} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </p>

        <button type="submit" className="btn btn-primary">Search {e.plural}</button>
      </form>
    </search>
  );
}

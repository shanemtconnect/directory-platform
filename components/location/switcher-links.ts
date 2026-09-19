/**
 * Where the location switcher points.
 *
 * Separate from the component because these are the only decisions in it worth
 * arguing about, and a function is testable where a rendered tree is not (the
 * suite is node-environment; see components/pillar/page-window.ts for the same
 * split).
 *
 * Constraint 18, in both functions: a switcher link is a link to a canonical
 * URL that already exists. It never carries state that would make that URL
 * return something different from what a visitor arriving cold would get.
 */

/**
 * A city pillar, or the same category inside a different city.
 *
 * The switcher switches PLACE. Dropping the category on the way would quietly
 * turn "see this category in York" into "see everything in York", which is a
 * different page and a worse answer to what was clicked.
 */
export function cityScopedHref(citySlug: string, categorySlug?: string): string {
  return categorySlug ? `/${citySlug}/${categorySlug}` : `/${citySlug}`;
}

/**
 * The search page's city facet, pre-filled.
 *
 * Every other active filter survives, because switching location is not
 * starting again. The page number does not: results are ranked per query, so
 * page 3 of one city has nothing to do with page 3 of another, and carrying it
 * over lands the visitor on a page that is frequently empty.
 *
 * `city` is written last so the query string reads with the thing that changed
 * at the end, and so a stale `city` in the incoming filters is overwritten
 * rather than duplicated.
 */
export function searchCityHref(
  citySlug: string,
  filters: Record<string, string | undefined>,
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (key === "city" || key === "page") continue;
    if (value === undefined || value === "") continue;
    qs.set(key, value);
  }
  qs.set("city", citySlug);
  return `/search?${qs.toString()}`;
}

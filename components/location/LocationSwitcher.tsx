import type { SwitcherCity } from "@/lib/db/queries/cities";

/**
 * "See this somewhere else" — a `<details>` full of real links.
 *
 * Deliberately not a `<select>` and deliberately not client code. A select
 * needs JavaScript to go anywhere, so its options are invisible to a crawler
 * and dead when the bundle fails; these are `<a href>`s to URLs that already
 * exist, which is the same reason pagination in this repo is a path and not a
 * query parameter.
 *
 * Global constraint 18: the switcher never changes what a canonical URL
 * returns. There is no state here, no cookie, no rewrite — clicking one is
 * indistinguishable from typing the destination in, which is what makes it
 * safe to render inside an ISR-cached shell.
 *
 * `hrefFor` is the caller's, because where "the same page, elsewhere" points
 * is the page's business: a category page keeps its category, search keeps its
 * filters, the header just goes to the city.
 */
export interface LocationSwitcherProps {
  /** What the summary asks, e.g. "See Barn Halls in". Never a niche word. */
  label: string;
  cities: SwitcherCity[];
  hrefFor: (city: SwitcherCity) => string;
  className?: string;
  /**
   * The open list. In page flow it can push the content below it down; in the
   * header bar it must not, so the header passes an absolutely positioned
   * panel instead of the component guessing which it is in.
   */
  panelClassName?: string;
  /** Distinguishes the header's copy from the page's in tests. */
  testId?: string;
}

export function LocationSwitcher({
  label,
  cities,
  hrefFor,
  className,
  panelClassName = "mt-2 flex list-none flex-wrap gap-x-4 gap-y-1 text-sm",
  testId = "location-switcher",
}: LocationSwitcherProps) {
  const current = cities.find((c) => c.isCurrent) ?? null;
  const elsewhere = cities.filter((c) => !c.isCurrent);
  // Nowhere to switch to is not a switcher. Rendering an empty disclosure is a
  // control that lies about having options behind it.
  if (elsewhere.length === 0) return null;

  return (
    <details className={className} data-testid={testId}>
      <summary className="btn btn-secondary inline-flex min-h-11 cursor-pointer list-none items-center text-sm marker:content-['']">
        {label}
        {current ? <span className="ml-1 font-semibold">{current.name}</span> : null}
        <span aria-hidden="true"> ▾</span>
      </summary>
      <ul className={panelClassName}>
        {current && (
          <li key={current.id}>
            {/* The place you already are, stated rather than linked: a link to
                the page you are on is a crawl loop and a dead click. */}
            <span aria-current="true" className="font-semibold text-ink">
              {current.name}
            </span>
          </li>
        )}
        {elsewhere.map((city) => (
          <li key={city.id}>
            <a
              href={hrefFor(city)}
              className="inline-flex min-h-11 items-center text-ink no-underline hover:text-primary hover:underline"
            >
              {city.name}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}

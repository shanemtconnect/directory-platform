import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";

export const metadata: Metadata = {
  title: "Page not found",
  // A 404 has nothing to offer a search result, and Google ignores the tag on
  // one anyway — this is for the internal-link crawl, which should keep going.
  robots: { index: false, follow: true },
};

/**
 * Rendered inside the root layout, so it keeps the header and the footer.
 *
 * A 404 without the site chrome is a dead end: no nav, no footer links, no way
 * back in for a visitor who followed a stale link, and nothing for a crawler to
 * follow either. The three links below are the site's three entry points, and
 * they are here rather than only in the chrome because a person who has just
 * hit a wall should not have to go looking.
 */
export default function NotFound() {
  const e = siteConfig.entity;

  return (
    <main>
      <div className="prose py-6">
        <p className="font-heading text-sm font-semibold tracking-widest text-muted uppercase">
          404
        </p>
        <h1 className="mt-2">We can&rsquo;t find that page</h1>
        <p className="text-lg text-muted">
          The address may be mistyped, or the {e.singular} that used to be here may have been
          removed. Nothing else is broken — start again from one of these.
        </p>

        <ul className="mt-8 grid list-none gap-3 p-0 sm:grid-cols-3">
          <li>
            <a href="/cities" className="card card-hover block h-full no-underline">
              <span className="font-heading font-semibold text-ink">Browse by location</span>
              <span className="mt-1 block text-sm text-muted">
                Every town and city we cover.
              </span>
            </a>
          </li>
          <li>
            <a href="/categories" className="card card-hover block h-full no-underline">
              <span className="font-heading font-semibold text-ink">Browse by type</span>
              <span className="mt-1 block text-sm text-muted">
                Every kind of {e.singular} on the site.
              </span>
            </a>
          </li>
          <li>
            <a href="/search" className="card card-hover block h-full no-underline">
              <span className="font-heading font-semibold text-ink">Search</span>
              <span className="mt-1 block text-sm text-muted">
                Find a {e.singular} by name, place or type.
              </span>
            </a>
          </li>
        </ul>

        <p className="mt-8 text-sm text-muted">
          Followed a link from another site and think it should work?{" "}
          <a href={`mailto:${siteConfig.supportEmail}?subject=${encodeURIComponent("Broken link")}`}>
            Tell us where it came from
          </a>{" "}
          and we&rsquo;ll point it somewhere sensible.
        </p>
      </div>
    </main>
  );
}

import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: true },
};

/**
 * The 404 page, rendered inside the root layout — so it carries the header and
 * the footer like every other page.
 *
 * Without this file Next serves its own built-in 404, which renders outside the
 * layout entirely: no nav, no footer link matrix, no `<main>` and no heading. A
 * visitor who followed a stale link lands on a dead end with nothing to click,
 * and a crawler that reaches one finds nothing to follow — on a directory whose
 * URLs change whenever a listing is renamed, that is a page type worth building.
 *
 * `follow` rather than `nofollow`: the links out of here are the whole point.
 */
export default function NotFound() {
  const e = siteConfig.entity;

  return (
    <main>
      <h1>Page not found</h1>
      <p>
        That page has moved or never existed. Nothing is broken — the address is
        just not one we serve.
      </p>
      <ul>
        <li>
          <a href="/">Start again from the home page</a>
        </li>
        <li>
          <a href="/cities">Browse {e.plural} by location</a>
        </li>
        <li>
          <a href="/categories">Browse {e.plural} by type</a>
        </li>
        <li>
          <a href="/search">Search for a {e.singular}</a>
        </li>
      </ul>
    </main>
  );
}

/**
 * The "Verified only" toggle above a pillar grid.
 *
 * A plain `<a href>`, not client state: the filtered view is a real,
 * server-rendered URL (`?verified=1`, routed to the dynamic sibling of this
 * page by a next.config.ts rewrite — see Pagination's `verified` doc), so
 * there is nothing to hydrate.
 *
 * Hidden unless the scope has at least one verified listing to show — a
 * toggle that always empties the grid teaches a visitor to stop trusting it
 * — except while it is already active, so a visitor can always get back.
 */
export function VerifiedToggle({
  active,
  hasVerified,
  onHref,
  offHref,
  nounPlural,
}: {
  active: boolean;
  hasVerified: boolean;
  /** Where turning the filter ON goes to. */
  onHref: string;
  /** Where turning the filter OFF goes to. */
  offHref: string;
  nounPlural: string;
}) {
  if (!hasVerified && !active) return null;

  return (
    <p data-testid="verified-toggle" className="mb-4">
      {active ? (
        <a href={offHref} aria-current="true">
          ✓ Verified {nounPlural} only — show all
        </a>
      ) : (
        // nofollow: this link is the one thing on an ISR-cached, crawled
        // pillar page that points at the uncached verified view — a crawler
        // must not walk it (see Pagination's own `rel` doc for the rest of
        // that view). noindex on the destination is a separate concern.
        <a href={onHref} rel="nofollow">
          Show verified {nounPlural} only
        </a>
      )}
    </p>
  );
}

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
        <a href={offHref} aria-pressed="true">
          ✓ Verified {nounPlural} only — show all
        </a>
      ) : (
        <a href={onHref} aria-pressed="false">
          Show verified {nounPlural} only
        </a>
      )}
    </p>
  );
}

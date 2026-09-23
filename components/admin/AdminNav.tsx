import type { NavCounts } from "./nav-counts";

/**
 * The console's own navigation.
 *
 * It lives here rather than in the site header on purpose: /admin is a
 * `noindex` staff area behind a 404 gate, and a link to it in the public header
 * — rendered conditionally or not — is a link that has to be got right on every
 * page for every role. One sub-nav inside the gate cannot leak.
 *
 * `counts` is optional and keyed by href (see nav-counts.ts). A link with a
 * count shows it as a badge and reads it out as "3 waiting"; a link without
 * one is just the label, so a page that has not loaded the counts still
 * renders the same nav.
 */
const LINKS: { href: string; label: string }[] = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/submissions", label: "Submissions" },
  { href: "/admin/claims", label: "Claims" },
  { href: "/admin/reviews", label: "Reviews" },
  { href: "/admin/cities", label: "Towns" },
  { href: "/admin/reports", label: "Reports" },
  { href: "/admin/removals", label: "Removals" },
  { href: "/admin/sponsors", label: "Sponsors" },
  { href: "/admin/audit", label: "Audit log" },
];

export function AdminNav({ current, counts }: { current: string; counts?: NavCounts }) {
  return (
    <nav aria-label="Admin" data-testid="admin-nav" className="admin-nav mb-6 border-b border-line">
      <ul className="m-0 flex list-none gap-1 p-0">
        {LINKS.map((link) => {
          const active = link.href === current;
          const count = counts?.[link.href];
          return (
            <li key={link.href} className="m-0">
              <a
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={
                  "inline-flex min-h-11 items-center px-3 py-2 text-sm font-semibold no-underline " +
                  (active
                    ? "border-b-2 border-primary text-ink"
                    : "border-b-2 border-transparent text-muted")
                }
              >
                {link.label}
                {count !== undefined && (
                  <span className="nav-count" data-testid="nav-count">
                    <span aria-hidden="true">{count}</span>
                    <span className="sr-only">{count} waiting</span>
                  </span>
                )}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The console's own navigation.
 *
 * It lives here rather than in the site header on purpose: /admin is a
 * `noindex` staff area behind a 404 gate, and a link to it in the public header
 * — rendered conditionally or not — is a link that has to be got right on every
 * page for every role. One sub-nav inside the gate cannot leak.
 */
const LINKS: { href: string; label: string }[] = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/submissions", label: "Submissions" },
  { href: "/admin/cities", label: "Towns" },
  { href: "/admin/audit", label: "Audit log" },
];

export function AdminNav({ current }: { current: string }) {
  return (
    <nav aria-label="Admin" data-testid="admin-nav" className="mb-6 border-b border-line">
      <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
        {LINKS.map((link) => {
          const active = link.href === current;
          return (
            <li key={link.href} className="m-0">
              <a
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={
                  "inline-block px-3 py-2 text-sm font-semibold no-underline " +
                  (active
                    ? "border-b-2 border-primary text-ink"
                    : "border-b-2 border-transparent text-muted")
                }
              >
                {link.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

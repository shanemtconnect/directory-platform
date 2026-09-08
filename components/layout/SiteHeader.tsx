import { siteConfig } from "@/config/site.config";
import { navRoutes, type NavEntry } from "@/lib/features/navigation";
import { Container } from "./Container";

/**
 * Every link here comes from `navRoutes()`. There is deliberately no local list
 * to fall out of step with it: if a feature flag flips off and its link is
 * still in the header, the header was not reading from the single source, which
 * is the bug rather than the flag.
 *
 * Two of those routes are promoted out of the list into controls of their own —
 * search into a form, and the add CTA into a button — because they are the two
 * things this header exists to do. `PROMOTED` is what keeps them from also
 * appearing as plain links beside themselves.
 */
const PROMOTED = new Set(["/search", "/add-listing"]);

/**
 * The sign-in link cannot depend on the session.
 *
 * The header renders inside the ISR-cached shell, so a "Your account" rendered
 * for a signed-in visitor would be written into the cache that everyone else,
 * crawlers included, then reads back. It is a fixed link to /login; the account
 * routes redirect there on their own when there is no session.
 */
const SIGN_IN = { href: "/login", label: "Sign in" } as const;

function NavLinks({ routes, className }: { routes: NavEntry[]; className: string }) {
  return (
    <ul className={className}>
      {routes.map((route) => (
        <li key={route.href}>
          <a
            href={route.href}
            className="inline-flex min-h-11 items-center rounded-[var(--radius-token)] px-2 text-ink no-underline hover:text-primary hover:underline"
          >
            {route.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

function SearchField({ id, className }: { id: string; className: string }) {
  const e = siteConfig.entity;
  return (
    <form
      method="get"
      action="/search"
      role="search"
      data-testid="header-search"
      className={className}
    >
      <label htmlFor={id} className="sr-only">
        Search {e.plural}
      </label>
      <input
        id={id}
        name="q"
        type="search"
        placeholder={`Search ${e.plural}`}
        className="min-h-11 w-full min-w-0 rounded-[var(--radius-token)] border border-line bg-canvas px-3 py-2 text-ink placeholder:text-muted"
      />
      <button
        type="submit"
        className="btn btn-secondary shrink-0"
      >
        Search
      </button>
    </form>
  );
}

export function SiteHeader() {
  const routes = navRoutes();
  const inline = routes.filter((r) => !PROMOTED.has(r.href));
  const e = siteConfig.entity;

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface">
      <Container className="flex flex-wrap items-center gap-x-4 gap-y-3 py-3">
        <a
          href="/"
          rel="home"
          className="mr-auto font-heading text-lg font-semibold tracking-tight text-ink no-underline sm:text-xl"
        >
          {siteConfig.name}
        </a>

        {/* Desktop: the routes inline, then the two promoted controls. */}
        <nav aria-label="Primary" className="hidden md:block">
          <NavLinks routes={inline} className="flex list-none items-center gap-1 text-sm" />
        </nav>

        <SearchField
          id="site-search"
          className="hidden items-center gap-2 lg:flex lg:w-64 xl:w-72"
        />

        <a
          href={SIGN_IN.href}
          className="hidden min-h-11 items-center px-2 text-sm text-ink no-underline hover:text-primary hover:underline md:inline-flex"
        >
          {SIGN_IN.label}
        </a>

        <a href="/add-listing" className="btn btn-primary text-sm">
          Add your {e.singular}
        </a>

        {/*
          Mobile menu. A <details> and nothing else: no state, no bundle, and it
          opens on a device where the JavaScript failed. The links inside repeat
          the desktop bar's because one nav cannot be two layouts at once — same
          hrefs, same anchor text, rendered from the same `routes` array above.
        */}
        <details className="group relative md:hidden" data-testid="mobile-nav">
          <summary className="btn btn-secondary cursor-pointer list-none text-sm marker:content-['']">
            Menu
          </summary>
          <div className="absolute right-0 z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-[var(--radius-token)] border border-line bg-surface p-4 shadow-lg">
            <nav aria-label="Primary, mobile">
              <NavLinks routes={routes} className="flex list-none flex-col gap-1" />
            </nav>
            <a
              href={SIGN_IN.href}
              className="mt-1 inline-flex min-h-11 items-center px-2 text-ink no-underline hover:text-primary hover:underline"
            >
              {SIGN_IN.label}
            </a>
            <SearchField id="mobile-search" className="mt-3 flex items-center gap-2" />
          </div>
        </details>
      </Container>
    </header>
  );
}

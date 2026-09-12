import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { navRoutes, type NavEntry } from "@/lib/features/navigation";
import { listSwitcherCities, type SwitcherCity } from "@/lib/db/queries/cities";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { LocationSwitcher } from "@/components/location/LocationSwitcher";
import { cityScopedHref } from "@/components/location/switcher-links";
import { Container } from "./Container";
import { isFooterMatrixSuppressed } from "./footer-matrix-flag";

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

/**
 * How many locations the header offers.
 *
 * The header is in every cached page in the site, so this list is paid for on
 * every URL twice over — once in the desktop bar and once in the mobile panel.
 * The busiest dozen is a shortcut; the full list is /cities, which is already
 * in the nav, and is where a visitor who wants to browse should end up.
 */
const HEADER_CITIES = 12;

/**
 * The header cannot know which city page it is on — it renders above the route
 * — so it offers locations without a current one, and PUBLIC_VIEWER for the
 * same reason the footer does: the shell is ISR-cached, so anything rendered
 * for an admin is written into the cache everyone else reads back.
 *
 * A failed query costs the switcher, never the page. /pricing and /login do not
 * otherwise touch the database and are not worth a 500 for a nav control.
 *
 * Skipped entirely on a 404 or an error page, on the same flag the footer's
 * matrix uses (footer-matrix-flag.ts). Those two pages carry their own list of
 * ways back in, and the error page in particular may be rendering BECAUSE the
 * database just failed — which is the worst moment to ask it for twelve cities.
 *
 * The `await` before the flag is read is load-bearing, and is the one thing
 * here that differs from the footer. `app/layout.tsx` renders <SiteHeader />
 * BEFORE {children}, and the flag is set by the special page as it renders; the
 * footer, declared after {children}, can simply read it. Yielding once lets the
 * rest of the tree render up to its own first await — which is past the point
 * where `app/not-found.tsx` calls `suppressFooterMatrix()` — before we decide.
 */
async function loadCities(): Promise<SwitcherCity[]> {
  await Promise.resolve();
  if (isFooterMatrixSuppressed()) return [];
  try {
    return await listSwitcherCities(db as never, PUBLIC_VIEWER, { limit: HEADER_CITIES });
  } catch (error) {
    console.error("header location switcher query failed", error);
    return [];
  }
}

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

export async function SiteHeader() {
  const routes = navRoutes();
  const inline = routes.filter((r) => !PROMOTED.has(r.href));
  const e = siteConfig.entity;
  const cities = await loadCities();
  // The header has no current city to name — it renders above the route — so
  // the label has to carry the whole meaning on its own.
  const switcherLabel = "Browse by location";

  return (
    // `relative` so the mobile panel below can anchor to the whole bar rather
    // than to the little <details> at the end of it, which would push it off
    // the side of a 390px screen.
    <header className="relative z-40 border-b border-line bg-surface md:sticky md:top-0">
      <Container className="flex flex-nowrap items-center gap-3 py-3">
        <a
          href="/"
          rel="home"
          className="mr-auto truncate font-heading text-lg font-semibold tracking-tight text-ink no-underline sm:text-xl"
        >
          {siteConfig.name}
        </a>

        {/* Desktop: the routes inline, then the two promoted controls. */}
        <nav aria-label="Primary" className="hidden md:block">
          <NavLinks routes={inline} className="flex list-none items-center gap-1 text-sm" />
        </nav>

        {/*
          The compact switcher. Hidden below lg because the bar already carries
          the nav, the search field and two CTAs at md; the mobile panel below
          renders the same links for every width this one does not cover.

          The open list is absolutely positioned so opening it drops a panel
          over the page rather than growing the header and pushing the whole
          document down — the same reason the mobile menu is positioned.
        */}
        <LocationSwitcher
          label={switcherLabel}
          cities={cities}
          hrefFor={(city) => cityScopedHref(city.slug)}
          className="hidden shrink-0 lg:block"
          panelClassName="absolute right-0 z-50 mt-2 grid max-h-80 w-56 list-none grid-cols-1 gap-1 overflow-y-auto rounded-[var(--radius-token)] border border-line bg-surface p-3 text-sm shadow-lg"
          testId="header-location-switcher"
        />

        {/*
          Visible from md up so there is a search entry point at every width the
          mobile <details> menu (md:hidden, below) does not cover — narrow at
          md/lg where the inline nav and the two CTAs already crowd the bar,
          full width once xl gives it room.
        */}
        <SearchField
          id="site-search"
          className="hidden min-w-0 items-center gap-2 md:flex md:w-36 lg:w-48 xl:w-64"
        />

        <a
          href={SIGN_IN.href}
          className="hidden min-h-11 shrink-0 items-center px-2 text-sm text-ink no-underline hover:text-primary hover:underline md:inline-flex"
        >
          {SIGN_IN.label}
        </a>

        <a href="/add-listing" className="btn btn-primary hidden shrink-0 text-sm md:inline-flex">
          Add your {e.singular}
        </a>

        {/*
          Mobile menu. A <details> and nothing else: no state, no bundle, and it
          opens on a device where the JavaScript failed. The links inside repeat
          the desktop bar's because one nav cannot be two layouts at once — same
          hrefs, same anchor text, rendered from the same `routes` array above.
        */}
        <details className="shrink-0 md:hidden" data-testid="mobile-nav">
          <summary className="btn btn-secondary cursor-pointer list-none text-sm marker:content-['']">
            Menu
          </summary>
          <div className="absolute inset-x-0 top-full z-50 border-b border-line bg-surface p-4 shadow-lg">
            <nav aria-label="Primary, mobile">
              <NavLinks routes={routes} className="flex list-none flex-col gap-1" />
            </nav>
            <a
              href={SIGN_IN.href}
              className="inline-flex min-h-11 items-center px-2 text-ink no-underline hover:text-primary hover:underline"
            >
              {SIGN_IN.label}
            </a>
            <LocationSwitcher
              label={switcherLabel}
              cities={cities}
              hrefFor={(city) => cityScopedHref(city.slug)}
              className="mt-3"
              testId="mobile-location-switcher"
            />
            <SearchField id="mobile-search" className="mt-3 flex items-center gap-2" />
            <a href="/add-listing" className="btn btn-primary mt-4 w-full text-sm">
              Add your {e.singular}
            </a>
          </div>
        </details>
      </Container>
    </header>
  );
}

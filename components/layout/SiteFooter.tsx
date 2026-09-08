import { db } from "@/lib/db/client";
import { siteConfig } from "@/config/site.config";
import { features } from "@/lib/features/flags";
import { footerRoutes } from "@/lib/features/navigation";
import { getFooterMatrix, type FooterCategoryBlock } from "@/lib/db/queries/footer";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { now } from "@/lib/clock";
import { Container } from "./Container";
import { LEGAL_ROUTES } from "./legal-routes";
import { isFooterMatrixSuppressed } from "./footer-matrix-flag";

const LINK = "text-ink/80 no-underline hover:text-primary hover:underline";

/**
 * The matrix is what gives a directory crawl depth: a link on every page to the
 * top cities of every category, so a page four clicks deep in the taxonomy is
 * one click from anywhere. `getFooterMatrix` guarantees every one of those
 * targets is indexable and uses the city-scoped route — see its doc comment.
 *
 * PUBLIC_VIEWER unconditionally: the footer renders inside the ISR-cached
 * shell, so an admin-specific matrix would be written into the cache that
 * anonymous visitors and crawlers then read.
 *
 * A failure here must not take a page down. /pricing and /advertise touch no
 * other database query, and a footer is not worth a 500 on them.
 */
async function loadMatrix(): Promise<FooterCategoryBlock[]> {
  if (!features.footerLinkMatrix) return [];
  try {
    return await getFooterMatrix(db as never, PUBLIC_VIEWER);
  } catch (error) {
    console.error("footer matrix query failed", error);
    return [];
  }
}

export async function SiteFooter() {
  const routes = footerRoutes();
  // Skip the query entirely on a 404/error page: it's set by app/not-found.tsx
  // and app/error.tsx via footer-matrix-flag.ts before this renders (see that
  // file for why), and there is no point spending a database round trip on a
  // matrix that will not be shown — least of all on the error page, which may
  // be rendering because the database is the thing that just failed.
  const suppressMatrix = isFooterMatrixSuppressed();
  const matrix = suppressMatrix ? [] : await loadMatrix();
  /*
   * The shell is ISR-cached, so this year is the year the page was last
   * rendered rather than today's. Every route that reaches here revalidates
   * within the hour, so the worst case is a stale copyright line for the first
   * hour of the first of January — which is a better trade than shipping no
   * date, and much better than forcing every page dynamic to render one.
   */
  const year = now().getFullYear();

  return (
    <footer className="mt-auto border-t border-line bg-raised text-sm text-ink/80">
      <Container className="py-10">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-sm">
            <p className="font-heading text-base font-semibold text-ink">{siteConfig.name}</p>
            <p className="mt-1">{siteConfig.tagline}</p>
            <p className="mt-3">
              <a href={`mailto:${siteConfig.supportEmail}`} className={LINK}>
                {siteConfig.supportEmail}
              </a>
            </p>
          </div>

          <nav aria-label="Footer">
            <ul className="grid list-none grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-1 md:grid-cols-2">
              {routes.map((route) => (
                <li key={route.href}>
                  <a href={route.href} className={LINK}>
                    {route.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        {matrix.length > 0 && (
          <nav
            aria-label={`${siteConfig.entity.Plural} by location`}
            data-testid="footer-link-matrix"
            className="mt-10 border-t border-line pt-8"
          >
            {/*
              One <details> per category, closed by default. The matrix is
              ~360 links across every category on every page load — worth
              having for crawl depth, not worth ~2,800px of scroll for a
              visitor who only wants one of them. `<summary>` stays plain text
              (interactive content, like the category link below, is not
              valid inside it) with the link to the category itself as the
              first item in the list once it's open.
            */}
            <div className="grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
              {matrix.map((block) => (
                <details key={block.id} className="border-b border-line py-3 first:pt-0">
                  <summary className="cursor-pointer list-none font-heading text-base font-semibold text-ink marker:content-['']">
                    {block.name}
                  </summary>
                  <ul className="mt-2 list-none space-y-1">
                    <li>
                      <a href={block.href} className={LINK}>
                        All {block.name}
                      </a>
                    </li>
                    {block.cities.map((city) => (
                      <li key={city.href}>
                        <a href={city.href} className={LINK}>
                          {block.name} in {city.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          </nav>
        )}

        <div className="mt-10 flex flex-col gap-3 border-t border-line pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p>
            &copy; {year} {siteConfig.legalEntity}. All rights reserved.
          </p>
          <ul className="flex list-none flex-wrap gap-x-6 gap-y-2">
            {LEGAL_ROUTES.map((route) => (
              <li key={route.href}>
                <a href={route.href} className={LINK}>
                  {route.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </Container>
    </footer>
  );
}

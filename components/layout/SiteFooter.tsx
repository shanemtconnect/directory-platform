import { db } from "@/lib/db/client";
import { siteConfig } from "@/config/site.config";
import { features } from "@/lib/features/flags";
import { footerRoutes } from "@/lib/features/navigation";
import { getFooterMatrix, type FooterCategoryBlock } from "@/lib/db/queries/footer";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";

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
  const matrix = await loadMatrix();

  return (
    <footer>
      <nav aria-label="Footer">
        <ul>
          {routes.map((route) => (
            <li key={route.href}>
              <a href={route.href}>{route.label}</a>
            </li>
          ))}
        </ul>
      </nav>

      {matrix.length > 0 && (
        <nav aria-label={`${siteConfig.entity.Plural} by location`} data-testid="footer-link-matrix">
          {matrix.map((block) => (
            <section key={block.id}>
              <h2>
                <a href={block.href}>{block.name}</a>
              </h2>
              <ul>
                {block.cities.map((city) => (
                  <li key={city.href}>
                    <a href={city.href}>
                      {block.name} in {city.name}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
      )}

      {/* No year: the shell is ISR-cached, so a rendered year would freeze at
          whenever the page was last built and be wrong every January. */}
      <p>&copy; {siteConfig.name}</p>
    </footer>
  );
}

import { siteConfig } from "@/config/site.config";
import { navRoutes } from "@/lib/features/navigation";

/**
 * Every link here comes from `navRoutes()`. There is deliberately no local list
 * to fall out of step with it: if a feature flag flips off and its link is
 * still in the header, the header was not reading from the single source, which
 * is the bug rather than the flag.
 */
export function SiteHeader() {
  const routes = navRoutes();

  return (
    <header>
      <a href="/" rel="home">{siteConfig.name}</a>
      <nav aria-label="Primary">
        <ul>
          {routes.map((route) => (
            <li key={route.href}>
              <a href={route.href}>{route.label}</a>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}

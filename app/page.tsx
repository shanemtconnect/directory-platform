import { siteConfig } from "@/config/site.config";
import { navRoutes } from "@/lib/features/navigation";

export default function HomePage() {
  return (
    <main>
      <h1>{siteConfig.name}</h1>
      <p>{siteConfig.tagline}</p>
      <nav>
        <ul>
          {navRoutes().map((r) => (
            <li key={r.href}>
              <a href={r.href}>{r.label}</a>
            </li>
          ))}
        </ul>
      </nav>
    </main>
  );
}

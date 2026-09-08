import type { Metadata } from "next";
import { db } from "@/lib/db/client";
import { siteConfig } from "@/config/site.config";
import { listCategories } from "@/lib/db/queries/indexes";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { JsonLd } from "@/components/seo/JsonLd";
import { Breadcrumbs } from "@/components/seo/Breadcrumbs";
import { pillarSchema } from "@/lib/schema/builders";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: `All ${siteConfig.entity.plural}`,
  description: `Browse every type of ${siteConfig.entity.singular}.`,
  alternates: { canonical: "/categories" },
};

export default async function CategoriesIndex() {
  const categories = await listCategories(db as never, PUBLIC_VIEWER);
  const e = siteConfig.entity;

  return (
    <>
      <JsonLd
        data={pillarSchema({
          title: `All ${e.plural}`,
          path: "/categories",
          items: categories.map((c) => ({ name: c.name, path: `/categories/${c.slug}` })),
        })}
      />
      <main>
        <Breadcrumbs trail={[{ name: "Home", path: "/" }, { name: e.Plural, path: "/categories" }]} />
        <h1>All {e.plural}</h1>
        {categories.length === 0 ? (
          <p>No categories have listings yet.</p>
        ) : (
          <ul className="link-grid">
            {categories.map((c) => (
              <li key={c.id}>
                <a href={`/categories/${c.slug}`}>{c.name}</a> <span>({c.listingCount})</span>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}

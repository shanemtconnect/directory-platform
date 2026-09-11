import type { Metadata } from "next";
import { db } from "@/lib/db/client";
import { siteConfig } from "@/config/site.config";
import { currentViewer } from "@/lib/auth/viewer";
import { adminCities } from "@/lib/db/queries/admin/cities";
import { AdminNav } from "@/components/admin/AdminNav";
import { CityRow } from "@/components/admin/CityRow";

export const metadata: Metadata = {
  title: "Towns",
  robots: { index: false, follow: false },
};

export default async function AdminCitiesPage() {
  const viewer = await currentViewer();
  const cities = await adminCities(db, viewer);
  const waiting = cities.filter((c) => c.isPublished && !c.hasIntro).length;

  // Published-without-copy first: those are the pages the gate is holding back,
  // and they are the only reason to open this screen. One list rather than a
  // "waiting" section above a full one, because the same town cannot appear
  // twice — each row carries form field ids, and duplicates break the labels.
  const ordered = [...cities].sort((a, b) => {
    const rank = (c: (typeof cities)[number]) => (c.isPublished && !c.hasIntro ? 0 : 1);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });

  return (
    <main>
      <AdminNav current="/admin/cities" />
      <h1>Towns</h1>
      <p className="text-muted">
        {cities.length} in total, {waiting} published without intro copy. A town is indexable on{" "}
        {siteConfig.seo.minListingsToIndex} published {siteConfig.entity.plural} AND intro copy —
        those without copy are listed first.
      </p>

      {ordered.map((city) => (
        <CityRow key={city.id} city={city} />
      ))}
    </main>
  );
}

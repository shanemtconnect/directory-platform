import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { siteConfig } from "@/config/site.config";
import { currentViewer } from "@/lib/auth/viewer";
import { adminNeighbourhoods } from "@/lib/db/queries/neighbourhoods";
import { neighbourhoodsEnabled, NEIGHBOURHOOD_CSV_COLUMNS } from "@/lib/geo/neighbourhoods";
import { AdminNav } from "@/components/admin/AdminNav";
import { adminNavCounts } from "@/components/admin/nav-counts";
import { PageHeader } from "@/components/ui/PageHeader";
import {
  AssignNowForm,
  ImportNeighbourhoodsForm,
  NeighbourhoodTowns,
} from "@/components/admin/NeighbourhoodsConsole";

export const metadata: Metadata = {
  title: "Neighbourhoods",
  robots: { index: false, follow: false },
};

export default async function AdminNeighbourhoodsPage() {
  // First, before any query: with the module off this page does not exist.
  if (!neighbourhoodsEnabled()) notFound();
  const viewer = await currentViewer();
  // The layout gates this route too. Repeated here so a query never runs for
  // a viewer it will refuse (see /admin/reviews).
  if (viewer.role !== "admin") notFound();
  const [towns, counts] = await Promise.all([
    adminNeighbourhoods(db as never, viewer),
    adminNavCounts(db, viewer),
  ]);
  const { minListings, defaultRadiusKm } = siteConfig.geo.neighbourhoods;

  return (
    <main>
      <AdminNav current="/admin/neighbourhoods" counts={counts} />
      <PageHeader
        title="Neighbourhoods"
        lede={`Neighbourhoods under each town, at /town/neighbourhood. Each ${siteConfig.entity.singular} joins the nearest neighbourhood whose radius reaches it, every night or when you press "Assign listings now". A neighbourhood page is indexed once it has ${minListings} published ${siteConfig.entity.plural}.`}
      />
      <ImportNeighbourhoodsForm header={NEIGHBOURHOOD_CSV_COLUMNS.join(",")} defaultRadiusKm={defaultRadiusKm} />
      <AssignNowForm />
      <NeighbourhoodTowns towns={towns} minListings={minListings} />
    </main>
  );
}

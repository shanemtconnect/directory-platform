import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { now } from "@/lib/clock";
import { siteConfig } from "@/config/site.config";
import { currentViewer } from "@/lib/auth/viewer";
import { guardFeature } from "@/lib/features/guard";
import { adminAwardYears, awardYearFor } from "@/lib/db/queries/awards";
import { AdminNav } from "@/components/admin/AdminNav";
import { adminNavCounts } from "@/components/admin/nav-counts";
import { PageHeader } from "@/components/ui/PageHeader";
import { AwardYearsTable, ComputeAwardsForm } from "@/components/admin/AwardsConsole";

export const metadata: Metadata = {
  title: "Awards",
  robots: { index: false, follow: false },
};

export default async function AdminAwardsPage() {
  guardFeature("awards");
  const viewer = await currentViewer();
  // The layout gates this route too. Repeated here so a query never runs for
  // a viewer it will refuse (see /admin/reviews).
  if (viewer.role !== "admin") notFound();
  const [years, counts] = await Promise.all([
    adminAwardYears(db, viewer),
    adminNavCounts(db, viewer),
  ]);

  return (
    <main>
      <AdminNav current="/admin/awards" counts={counts} />
      <PageHeader
        title="Awards"
        lede={`One computed winner per town and category a year, from published reviews. Nothing here is editorial: you can compute a year and revoke a winner, and that is all — the public pages show only what the ${siteConfig.entity.plural} earned.`}
      />
      <ComputeAwardsForm defaultYear={awardYearFor(now())} />
      <section aria-labelledby="years">
        <h2 id="years">Years</h2>
        <AwardYearsTable years={years} />
      </section>
    </main>
  );
}

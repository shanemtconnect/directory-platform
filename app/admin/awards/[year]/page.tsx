import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { guardFeature } from "@/lib/features/guard";
import { adminAwardsForYear, parseAwardYear } from "@/lib/db/queries/awards";
import { AdminNav } from "@/components/admin/AdminNav";
import { adminNavCounts } from "@/components/admin/nav-counts";
import { PageHeader } from "@/components/ui/PageHeader";
import { AwardRows } from "@/components/admin/AwardsConsole";

export const metadata: Metadata = {
  title: "Awards",
  robots: { index: false, follow: false },
};

interface Props {
  params: Promise<{ year: string }>;
}

export default async function AdminAwardYearPage({ params }: Props) {
  guardFeature("awards");
  const viewer = await currentViewer();
  if (viewer.role !== "admin") notFound();
  const year = parseAwardYear((await params).year);
  if (year === null) notFound();

  const [rows, counts] = await Promise.all([
    adminAwardsForYear(db, viewer, year),
    adminNavCounts(db, viewer),
  ]);
  const active = rows.filter((r) => r.revokedAt === null).length;

  return (
    <main>
      <AdminNav current="/admin/awards" counts={counts} />
      <PageHeader
        title={`${year} awards`}
        back={{ href: "/admin/awards", label: "All years" }}
        lede={
          rows.length === 0
            ? `Nothing was awarded for ${year}.`
            : `${active} standing, ${rows.length - active} revoked. Revoking takes the award off the listing and the winners page and does not re-award the slot.`
        }
      />
      <p className="text-sm text-muted">
        {active > 0 && <a href={`/awards/${year}`}>See the public {year} page</a>}
      </p>
      <AwardRows year={year} rows={rows} />
    </main>
  );
}

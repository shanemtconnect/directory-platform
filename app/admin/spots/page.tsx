import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { emptySpotsReport } from "@/lib/spots/availability";
import { AdminNav } from "@/components/admin/AdminNav";
import { SpotTable } from "@/components/admin/SpotTable";
import { adminNavCounts } from "@/components/admin/nav-counts";
import { PageHeader } from "@/components/ui/PageHeader";
import type { TestDb } from "@/lib/db/types";

/**
 * `/admin/spots` — featured-spot availability (Task 45, requirement 5).
 *
 * Every spot row plus a virtual row per published city and region without
 * one, filled/positions, the top amount and the floor; close/open and the
 * floor override per spot; the CSV of empty spots for outreach.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Featured spots",
  robots: { index: false, follow: false },
};

export default async function AdminSpotsPage() {
  const viewer = await currentViewer();
  if (viewer.role !== "admin") notFound();
  const handle = db as unknown as TestDb;
  const [rows, counts] = await Promise.all([emptySpotsReport(handle, viewer), adminNavCounts(handle, viewer)]);
  const empty = rows.filter((r) => r.status === "open" && r.filled < r.positions).length;
  const taken = rows.reduce((n, r) => n + r.filled, 0);
  const e = siteConfig.entity;
  return (
    <main>
      <AdminNav current="/admin/spots" counts={counts} />
      <PageHeader
        title="Featured spots"
        lede={`${rows.length} spots, ${empty} with room, ${taken} positions held by paying ${e.plural}. Closing a spot cancels every bid on it and stops their billing; a floor change binds new bids only.`}
      >
        <p>
          <a href="/admin/spots/export" className="btn btn-secondary" data-testid="admin-spots-export">
            Download empty spots (CSV)
          </a>
        </p>
      </PageHeader>
      <SpotTable rows={rows} />
    </main>
  );
}

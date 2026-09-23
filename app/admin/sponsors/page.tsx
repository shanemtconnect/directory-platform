import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { listSponsorQueue, pendingSponsorCount } from "@/lib/db/queries/ads";
import { sponsorLogoUrl } from "@/lib/ads/logo";
import { AdminNav } from "@/components/admin/AdminNav";
import { SponsorQueue } from "@/components/admin/SponsorQueue";
import { adminNavCounts } from "@/components/admin/nav-counts";
import { PageHeader } from "@/components/ui/PageHeader";
import type { TestDb } from "@/lib/db/types";

export const metadata: Metadata = {
  title: "Sponsors",
  robots: { index: false, follow: false },
};

export default async function AdminSponsorsPage() {
  const viewer = await currentViewer();
  if (viewer.role !== "admin") notFound();
  const handle = db as unknown as TestDb;
  const [campaigns, counts, pending] = await Promise.all([
    listSponsorQueue(handle, viewer),
    adminNavCounts(handle, viewer),
    pendingSponsorCount(handle, viewer),
  ]);
  const logoUrls: Record<string, string> = {};
  for (const c of campaigns) {
    const url = sponsorLogoUrl(c.logoPath);
    if (url !== null) logoUrls[c.id] = url;
  }
  const navCounts = pending > 0 ? { ...counts, "/admin/sponsors": pending } : counts;
  return (
    <main>
      <AdminNav current="/admin/sponsors" counts={navCounts} />
      <PageHeader
        title="Sponsor campaigns"
        lede={
          campaigns.length === 0
            ? "Nothing is waiting."
            : `${pending} waiting for a decision, ${campaigns.length - pending} live or paused. Every card is shown exactly as a reader would see it.`
        }
      />
      <SponsorQueue campaigns={campaigns} logoUrls={logoUrls} />
    </main>
  );
}

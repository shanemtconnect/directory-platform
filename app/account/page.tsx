import type { Metadata } from "next";
import { currentViewer } from "@/lib/auth/viewer";
import { siteConfig } from "@/config/site.config";

export const metadata: Metadata = {
  title: "Your account",
  robots: { index: false, follow: false },
};

export default async function AccountPage() {
  const viewer = await currentViewer();
  const e = siteConfig.entity;
  return (
    <main>
      <h1>Your account</h1>
      <p data-testid="viewer-role">Signed in as: {viewer.role}</p>
      <p>
        You haven&rsquo;t claimed a {e.singular} yet. Find your {e.singular} and
        claim it to manage the listing.
      </p>
      <p><a href="/search">Find your {e.singular}</a></p>
    </main>
  );
}

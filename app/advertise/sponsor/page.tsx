import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import type { AdPlacement } from "@/config/types";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ensureProfile } from "@/lib/auth/profile";
import { loginPath } from "@/lib/auth/next";
import { formatMoney } from "@/lib/pricing";
import { adsEnabled } from "@/lib/ads/policy";
import { sponsorPlanId } from "@/lib/ads/billing";
import { sponsorLogosConfigured } from "@/lib/ads/logo";
import { billingConfigured } from "@/lib/billing/paypal";
import { advertiserCampaigns, SPONSORABLE_PLACEMENTS } from "@/lib/db/queries/ads";
import { SPONSOR_BLURB_MAX, SPONSOR_TITLE_MAX } from "@/lib/db/schema";
import { SponsorForm } from "@/components/ads/SponsorForm";
import { SponsorCampaignList } from "@/components/ads/SponsorCampaignList";
import { PageHeader } from "@/components/ui/PageHeader";
import { Notice } from "@/components/ui/Notice";
import type { TestDb } from "@/lib/db/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sponsor this site",
  robots: { index: false, follow: false },
};

const HERE = "/advertise/sponsor";

function placementLabels(): { key: AdPlacement; label: string }[] {
  const e = siteConfig.entity;
  const labels: Record<AdPlacement, string> = {
    home: "Home",
    cityPillar: "Town pages",
    categoryPillar: `${e.Singular} type pages`,
    listingDetail: `Free ${e.singular} pages`,
    search: "Search results",
    blog: "Guides and posts",
    other: "Elsewhere",
  };
  return SPONSORABLE_PLACEMENTS.map((key) => ({ key, label: labels[key] }));
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SponsorPage({ searchParams }: Props) {
  const viewer = await currentViewer();
  if (viewer.role === "public") redirect(loginPath(HERE));
  const sp = await searchParams;
  const profile = await ensureProfile(db, viewer);
  const campaigns = await advertiserCampaigns(db as unknown as TestDb, viewer, profile.id);
  const price = formatMoney(siteConfig.ads.monthlyPrice, siteConfig.locale, siteConfig.currency);
  const cardPayments = billingConfigured() && sponsorPlanId() !== null;
  const paymentLabel = cardPayments
    ? `${price} a month, billed through PayPal. You will be sent to PayPal to approve it; the campaign goes live once an admin has checked it.`
    : `${price} a month. Card payments are not set up on this site yet — submit the campaign and we will arrange payment by email before it goes live.`;

  return (
    <main>
      <PageHeader
        title={`Sponsor ${siteConfig.name}`}
        lede={`A card in the sponsor rails beside the ${siteConfig.entity.plural} people are comparing. ${price} a month, cancel any time.`}
        back={{ href: "/advertise", label: "Advertising" }}
      />
      {!adsEnabled() && (
        <Notice variant="status" testId="sponsor-rails-off">
          Sponsor rails are not switched on for this site yet. You can still submit a campaign; it
          will show when they are.
        </Notice>
      )}
      {sp.cancelled !== undefined && (
        <Notice variant="status" testId="sponsor-cancelled">
          PayPal approval was cancelled. Your campaign is saved below; edit it or try the payment again later.
        </Notice>
      )}
      <h2>What you get</h2>
      <ul>
        <li>A card with your logo, a headline and a line of copy, in rotation with the other sponsors.</li>
        <li>A link straight to your site, marked as sponsored so search engines treat it correctly.</li>
        <li>Impressions and clicks counted daily. No third-party ad network, no tracking of readers.</li>
      </ul>
      <h2>Your campaigns</h2>
      {campaigns.length === 0 ? (
        <p className="text-muted" data-testid="sponsor-none">You have not submitted a campaign yet.</p>
      ) : (
        <SponsorCampaignList campaigns={campaigns} titleMax={SPONSOR_TITLE_MAX} blurbMax={SPONSOR_BLURB_MAX} />
      )}
      <h2>Submit a campaign</h2>
      <SponsorForm
        placements={placementLabels()}
        paymentLabel={paymentLabel}
        titleMax={SPONSOR_TITLE_MAX}
        blurbMax={SPONSOR_BLURB_MAX}
        logoEnabled={sponsorLogosConfigured()}
      />
    </main>
  );
}

import { siteConfig } from "@/config/site.config";
import type { RailItem } from "@/lib/ads/inventory";
import { sponsorInitial, sponsorLogoUrl } from "@/lib/ads/logo";
import { StatsBeacon } from "@/components/stats/StatsBeacon";
import { SPONSOR_BEACON_METRIC } from "@/lib/ads/keys";

/**
 * One card on a rail. A sponsor card links through `/out/<id>` with
 * `rel="sponsored nofollow"` and carries the impression beacon marker; a
 * house card links straight to the site's own page and is labelled with the
 * site's name, because it is not sponsored and must not say it is.
 */
export interface SponsorCardProps {
  item: RailItem;
  /** Where on the page this copy sits; part of the test id only. */
  slot: "left" | "right" | "inline";
}

function Logo({ name, logoPath }: { name: string; logoPath: string | null }) {
  const url = sponsorLogoUrl(logoPath);
  if (url !== null) {
    return <img src={url} alt="" width={48} height={48} className="sponsor-logo" loading="lazy" />;
  }
  return (
    <span className="sponsor-logo sponsor-initial" aria-hidden="true">
      {sponsorInitial(name)}
    </span>
  );
}

export function SponsorCard({ item, slot }: SponsorCardProps) {
  if (item.kind === "house") {
    const { ad } = item;
    return (
      <article className="card sponsor-card" data-testid={`sponsor-card-${slot}`} data-kind="house">
        <a href={ad.href} className="sponsor-card-link">
          <span className="sponsor-label">{siteConfig.shortName}</span>
          <strong className="sponsor-title">{ad.title}</strong>
          <span className="sponsor-blurb">{ad.blurb}</span>
        </a>
      </article>
    );
  }
  const { campaign } = item;
  return (
    <article
      className="card sponsor-card"
      data-testid={`sponsor-card-${slot}`}
      data-kind="sponsor"
      data-campaign={campaign.id}
    >
      <a href={`/out/${campaign.id}`} rel="sponsored nofollow" className="sponsor-card-link">
        <Logo name={campaign.name} logoPath={campaign.logoPath} />
        <span className="sponsor-label">Sponsored</span>
        <strong className="sponsor-title">{campaign.title}</strong>
        <span className="sponsor-blurb">{campaign.blurb}</span>
        <span className="sponsor-name">{campaign.name}</span>
      </a>
      <StatsBeacon listingId={campaign.id} metric={SPONSOR_BEACON_METRIC} />
    </article>
  );
}

export function PlaceholderCard({ slot }: { slot: SponsorCardProps["slot"] }) {
  return (
    <article className="card sponsor-card sponsor-placeholder" data-testid={`sponsor-card-${slot}`} data-kind="placeholder">
      <span className="sponsor-label">Sponsor slot</span>
      <span className="sponsor-blurb">Shown here on the live site.</span>
    </article>
  );
}

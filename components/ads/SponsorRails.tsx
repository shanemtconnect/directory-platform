import type { ReactNode } from "react";
import type { AdPlacement } from "@/config/types";
import { db } from "@/lib/db/client";
import { now } from "@/lib/clock";
import { activeSponsorCampaigns } from "@/lib/db/queries/ads";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { buildInventory, type RailInventory, type RailItem } from "@/lib/ads/inventory";
import { decideSponsorRails, type PageListing } from "@/lib/ads/policy";
import { rotationSeed } from "@/lib/ads/rotation";
import { currentBuildId } from "@/lib/observability/build-id";
import { dayKey } from "@/lib/stats/keys";
import type { TestDb } from "@/lib/db/types";
import { features } from "@/lib/features/flags";
import { LeadCaptureBox } from "@/components/leads/LeadCaptureBox";
import { PlaceholderCard, SponsorCard } from "./SponsorCard";

/**
 * Two fixed side rails at ≥ 1280px, one inline card at 768–1279px, nothing
 * below 768px — all CSS, no client JS. The policy decides whether anything
 * renders; the inventory decides what; this file only lays it out.
 *
 * Server component. It reads the database, so a page that mounts it stays
 * ISR-cached and the rotation is stable for the cache window (seeded by
 * build id + day).
 */
export interface SponsorRailsProps {
  placement: AdPlacement;
  /** The listing a detail page is about — the "unpaid-only" rule needs its tier. */
  listing?: PageListing | null;
}

function Rail({ side, items, house = null }: { side: "left" | "right"; items: readonly RailItem[]; house?: ReactNode }) {
  if (items.length === 0 && house === null) return null;
  return (
    <div className={`sponsor-rail sponsor-rail-${side}`} data-testid={`sponsor-rail-${side}`}>
      {house}
      {items.map((item) => (
        <SponsorCard
          key={item.kind === "house" ? `house-${item.ad.id}` : item.campaign.id}
          item={item}
          slot={side}
        />
      ))}
    </div>
  );
}

/**
 * The site's own slot at the top of the left rail: the lead-capture box when
 * the lead marketplace is on (Task 56), nothing otherwise. A build-time
 * constant, so a flag-off build carries no trace of it.
 */
function captureSlot(): ReactNode {
  return features.leadMarketplace ? <LeadCaptureBox variant="rail" /> : null;
}

function Rails({ inventory }: { inventory: RailInventory }) {
  return (
    <aside className="sponsor-rails" aria-label="Sponsored" data-testid="sponsor-rails" data-state="live">
      <Rail side="left" items={inventory.left} house={captureSlot()} />
      <Rail side="right" items={inventory.right} />
      {inventory.inline !== null && (
        <div className="sponsor-inline" data-testid="sponsor-inline">
          <SponsorCard item={inventory.inline} slot="inline" />
        </div>
      )}
    </aside>
  );
}

function Placeholder() {
  return (
    <aside className="sponsor-rails" aria-label="Sponsor slots" data-testid="sponsor-rails" data-state="placeholder">
      <div className="sponsor-rail sponsor-rail-left" data-testid="sponsor-rail-left">
        {captureSlot()}
        <PlaceholderCard slot="left" />
      </div>
      <div className="sponsor-rail sponsor-rail-right" data-testid="sponsor-rail-right">
        <PlaceholderCard slot="right" />
      </div>
      <div className="sponsor-inline" data-testid="sponsor-inline">
        <PlaceholderCard slot="inline" />
      </div>
    </aside>
  );
}

export async function SponsorRails({ placement, listing = null }: SponsorRailsProps) {
  const decision = decideSponsorRails({ placement, listing });
  if (decision === "off") return null;
  if (decision === "placeholder") return <Placeholder />;
  const at = now();
  const campaigns = await activeSponsorCampaigns(db as unknown as TestDb, PUBLIC_VIEWER, { placement, at });
  const inventory = buildInventory(campaigns, rotationSeed(currentBuildId(), dayKey(at)));
  return <Rails inventory={inventory} />;
}

import { cache } from "react";
import type { BeaconMetric } from "@/lib/stats/keys";
import { BEACON_SCRIPT } from "./beacon-script";

/**
 * Marks a listing as seen, so `/api/beacon` can count it.
 *
 * Mount it once per listing on a page: `metric="view"` on a listing's own
 * page, `metric="impression"` on each card in a list. Every marker on the page
 * is collected into ONE POST, so a grid of twenty cards costs one request, not
 * twenty.
 *
 * Why a marker and a script rather than a server-side increment: the pillar
 * and listing pages are ISR-cached. A `recordStat()` call in the render would
 * count cache MISSES — one number per regeneration, no matter how many people
 * were served the stored HTML — which makes a popular listing read as less
 * visited than an unpopular one. The only place that can count a reader is the
 * reader's browser.
 *
 * What it is not: an analytics product. No cookie, no id, no identifier of any
 * kind, no third-party request, nothing stored in the browser.
 */

/**
 * Per-request, so the script is inlined ONCE however many cards render.
 *
 * `cache()` is React's per-request memo, so every `StatsBeacon` in one render
 * shares this object and only the first claims the slot. The script guards
 * itself client-side as well (`window.__dpBeacon`), so if a render ever
 * escapes one cache scope the duplicate is inert rather than a second POST.
 */
const scriptSlot = cache((): { taken: boolean } => ({ taken: false }));

function claimScript(): boolean {
  const slot = scriptSlot();
  if (slot.taken) return false;
  slot.taken = true;
  return true;
}

export interface StatsBeaconProps {
  listingId: string;
  /**
   * `view` — this page is about this listing.
   * `impression` — this listing appeared in a list on this page.
   */
  metric?: BeaconMetric;
}

export function StatsBeacon({ listingId, metric = "view" }: StatsBeaconProps) {
  return (
    <>
      <span hidden data-dp-stat={metric} data-dp-listing={listingId} />
      {claimScript() && (
        // The only inline script on the site. See beacon-script.ts for what is
        // in it and why it is not a client component.
        <script dangerouslySetInnerHTML={{ __html: BEACON_SCRIPT }} />
      )}
    </>
  );
}

import type { SponsorCardData } from "@/lib/db/queries/ads";
import { houseAds, type HouseAd } from "./house";
import { rotate } from "./rotation";

/**
 * What one page's rails carry, in order: house ads first, then the rotation
 * of live sponsor campaigns, up to `MAX_PER_RAIL` per rail. Two side rails
 * take alternate items; the tablet inline slot takes the first paid card if
 * there is one, else the first house ad.
 */
export const MAX_PER_RAIL = 5;
export const RAIL_COUNT = 2;

export type RailItem =
  | { readonly kind: "house"; readonly ad: HouseAd }
  | { readonly kind: "sponsor"; readonly campaign: SponsorCardData };

export interface RailInventory {
  readonly left: readonly RailItem[];
  readonly right: readonly RailItem[];
  readonly inline: RailItem | null;
}

export function buildInventory(
  campaigns: readonly SponsorCardData[],
  seed: string,
  house: readonly HouseAd[] = houseAds(),
): RailInventory {
  const capacity = MAX_PER_RAIL * RAIL_COUNT;
  const ordered: RailItem[] = house.map((ad) => ({ kind: "house", ad }));
  const room = Math.max(0, capacity - ordered.length);
  for (const campaign of rotate(campaigns, seed, room)) {
    ordered.push({ kind: "sponsor", campaign });
  }
  const left: RailItem[] = [];
  const right: RailItem[] = [];
  ordered.forEach((item, i) => (i % 2 === 0 ? left : right).push(item));
  const inline = ordered.find((i) => i.kind === "sponsor") ?? ordered[0] ?? null;
  return { left: left.slice(0, MAX_PER_RAIL), right: right.slice(0, MAX_PER_RAIL), inline };
}

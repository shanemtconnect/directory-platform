import type { TierName, TierSpec } from "@/config/types";

/**
 * Pure pricing helpers. No React, no config import — everything is passed in,
 * so a clone that edits config/site.config.ts changes the page without anyone
 * touching this file, and the maths stays unit-testable in isolation.
 */

export type Interval = "annual" | "monthly";

export const INTERVALS: readonly Interval[] = ["annual", "monthly"] as const;

/** Anything we do not recognise falls back to annual — the cheaper headline. */
export function parseInterval(raw: string | string[] | undefined): Interval {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === "monthly" ? "monthly" : "annual";
}

/** Money is compared in minor units so 24.9 * 12 does not drift into 298.79999. */
const minor = (amount: number): number => Math.round(amount * 100);

export function priceFor(tier: TierSpec, interval: Interval): number {
  return interval === "annual" ? tier.priceAnnual : tier.priceMonthly;
}

export function isFree(tier: TierSpec): boolean {
  return minor(tier.priceAnnual) === 0 && minor(tier.priceMonthly) === 0;
}

export interface AnnualSaving {
  /** Cash saved over twelve months, in major units. */
  readonly amount: number;
  /** How many months of the monthly price that saving is worth. */
  readonly months: number;
}

/**
 * Derived, never asserted. If a clone sets annual to 11x monthly the page says
 * "1 month", and if it sets it above 12x the saving is null and nothing is
 * claimed at all. A price claim is only worth making when it is arithmetic.
 */
export function annualSaving(tier: TierSpec): AnnualSaving | null {
  const monthly = minor(tier.priceMonthly);
  const annual = minor(tier.priceAnnual);
  if (monthly <= 0 || annual <= 0) return null;

  const saved = monthly * 12 - annual;
  if (saved <= 0) return null;

  return {
    amount: saved / 100,
    months: Math.round((saved / monthly) * 100) / 100,
  };
}

export function formatMoney(amount: number, locale: string, currency: string): string {
  const whole = Number.isInteger(amount);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(amount);
}

/** Config order is an object literal; rank is the contract. Sort by it. */
export function orderedTiers(
  tiers: { readonly [K in TierName]: TierSpec },
): readonly (readonly [TierName, TierSpec])[] {
  return (Object.entries(tiers) as [TierName, TierSpec][]).sort(
    ([, a], [, b]) => a.rank - b.rank,
  );
}

/* ---------------------------------------------------------------- comparison */

/**
 * Keys that sell the plan rather than describe a capability. They already have
 * a home in the cards, so they are not rows in the comparison table.
 */
const PRESENTATION_KEYS: readonly string[] = [
  "label",
  "strapline",
  "bullets",
  "rank",
  "priceAnnual",
  "priceMonthly",
  "trialDays",
  "excerptChars",
];

/**
 * Human labels for the capability keys. A clone that adds a key to TierSpec and
 * forgets to add a label still gets a readable row from humanise(), so the
 * table can never silently drop a capability.
 */
const LABELS: Record<string, string> = {
  maxImages: "Photos",
  descriptionDisplay: "Description shown",
  adFree: "Ad-free listing",
  showWebsite: "Website link",
  showSocial: "Social links",
  showPricingAndOffers: "Prices and offers shown",
  allowVideo: "Video",
  allowPricingPackages: "Packages",
  allowFaq: "FAQs",
  allowTeam: "Team profiles",
  allowGalleryAlbums: "Gallery albums",
  homepageSlot: "Homepage placement",
  editorialFeature: "Eligible for editorial features",
  statsWindowDays: "Stats history (days)",
  allowStatsExport: "Stats export",
  verificationIncluded: "Verification included",
};

export function humanise(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export type CellValue =
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "text"; readonly text: string };

export const UNLIMITED = "Unlimited";

export function toCell(value: unknown): CellValue {
  if (typeof value === "boolean") return { kind: "bool", value };
  if (value === null) return { kind: "text", text: UNLIMITED };
  if (typeof value === "number") return { kind: "text", text: String(value) };
  if (typeof value === "string") return { kind: "text", text: humanise(value) };
  return { kind: "text", text: "—" };
}

export interface ComparisonRow {
  readonly key: string;
  readonly label: string;
  readonly cells: readonly { readonly tier: TierName; readonly cell: CellValue }[];
}

/**
 * Built by walking the TierSpec keys themselves, not by a hand-written list, so
 * a capability added to the type shows up on the page automatically.
 */
export function comparisonRows(
  tiers: { readonly [K in TierName]: TierSpec },
): readonly ComparisonRow[] {
  const ordered = orderedTiers(tiers);
  const first = ordered[0];
  if (first === undefined) return [];

  const keys = Object.keys(first[1]).filter((k) => !PRESENTATION_KEYS.includes(k));

  return keys.map((key) => ({
    key,
    label: LABELS[key] ?? humanise(key),
    cells: ordered.map(([name, spec]) => ({
      tier: name,
      cell: toCell((spec as unknown as Record<string, unknown>)[key]),
    })),
  }));
}

import { siteConfig } from "@/config/site.config";
import type { CustomField, TierName } from "@/config/types";

/**
 * Which custom fields the comparison table shows, and how a jsonb value turns
 * into something readable.
 *
 * `showInCard` is the config's own answer to "which of these actually helps
 * someone choose", so the comparison table uses exactly that set rather than
 * inventing a second list that drifts from it.
 */
export const comparisonFields: readonly CustomField[] = siteConfig.customFields.filter(
  (f) => f.showInCard === true,
);

/**
 * A field with a `tier` is a paid display benefit. Showing it for a listing
 * that has not paid for it would give away the thing being sold, so the gate
 * applies here exactly as it does anywhere else the field is rendered.
 */
export function fieldVisibleForTier(field: CustomField, listingTier: TierName): boolean {
  if (!field.tier) return true;
  return siteConfig.tiers[listingTier].rank >= siteConfig.tiers[field.tier].rank;
}

const numberFormat = new Intl.NumberFormat(siteConfig.locale);
const currencyFormat = new Intl.NumberFormat(siteConfig.locale, {
  style: "currency",
  currency: siteConfig.currency,
  maximumFractionDigits: 0,
});

/**
 * Returns null when there is nothing worth printing, so callers can render a
 * single consistent placeholder instead of "null", "undefined" or an empty
 * cell that reads as a missing column.
 */
export function formatFieldValue(field: CustomField, raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;

  switch (field.type) {
    case "boolean": {
      if (typeof raw === "boolean") return raw ? "Yes" : "No";
      if (raw === "true") return "Yes";
      if (raw === "false") return "No";
      return null;
    }
    case "number":
    case "currency": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) return null;
      return field.type === "currency" ? currencyFormat.format(n) : numberFormat.format(n);
    }
    case "text":
    case "select": {
      if (typeof raw === "string") return raw.trim() || null;
      if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
      return null;
    }
  }
}

/** Pulls one field's display value off a listing's `custom_fields` jsonb. */
export function readField(
  field: CustomField,
  customFields: Record<string, unknown> | null,
  listingTier: TierName,
): string | null {
  if (!fieldVisibleForTier(field, listingTier)) return null;
  if (!customFields) return null;
  return formatFieldValue(field, customFields[field.key]);
}

import { siteConfig } from "@/config/site.config";
import { formatMoney } from "@/lib/pricing";

/** Minor units of the site currency, as the pages and emails print them. */
export function formatCredit(cents: number): string {
  return formatMoney(cents / 100, siteConfig.locale, siteConfig.currency);
}

/** How each ledger kind reads in a table. */
export const CREDIT_KIND_LABELS = {
  topup: "Top-up",
  purchase: "Lead bought",
  refund: "Refund",
  adjust: "Adjustment",
} as const;

/** The largest single admin adjustment, either way: 100,000 in major units. */
export const MAX_ADJUST_CENTS = 100_000 * 100;

const AMOUNT = /^([+-]?)(\d{1,6})(?:\.(\d{1,2}))?$/;

/**
 * An admin's typed amount ("10", "-10.5") as whole cents, parsed from the
 * string rather than through a float, so "10.005" is refused instead of
 * rounded and nothing past `MAX_ADJUST_CENTS` reaches an integer column.
 * Null for anything else.
 */
export function parseCreditAmount(input: string): number | null {
  const match = AMOUNT.exec(input.trim());
  if (match === null) return null;
  const [, sign, whole, fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (cents > MAX_ADJUST_CENTS) return null;
  return sign === "-" ? -cents : cents;
}

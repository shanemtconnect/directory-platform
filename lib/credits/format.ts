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

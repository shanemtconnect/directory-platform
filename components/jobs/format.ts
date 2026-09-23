import { siteConfig } from "@/config/site.config";
import { formatMoney } from "@/lib/pricing";

/** "22 October 2026" in the site's locale and zone. */
export function formatJobDate(value: Date): string {
  return new Intl.DateTimeFormat(siteConfig.locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: siteConfig.timezone,
  }).format(value);
}

/**
 * The budget line, or null when the poster gave none. Numeric columns come
 * back as strings; a blank pair renders nothing rather than "£0".
 */
export function formatBudget(min: string | null, max: string | null): string | null {
  const lo = min === null ? null : Number(min);
  const hi = max === null ? null : Number(max);
  const money = (n: number) => formatMoney(n, siteConfig.locale, siteConfig.currency);
  if (lo !== null && hi !== null) return lo === hi ? money(lo) : `${money(lo)} – ${money(hi)}`;
  if (lo !== null) return `From ${money(lo)}`;
  if (hi !== null) return `Up to ${money(hi)}`;
  return null;
}

/** What a non-verified poster pays, as the pages say it. */
export function formatJobPrice(): string {
  return formatMoney(siteConfig.jobs.price, siteConfig.locale, siteConfig.currency);
}

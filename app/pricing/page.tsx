import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { PricingContent } from "@/components/pricing/PricingContent";

export const revalidate = 3600;

export const metadata: Metadata = {
  // No site name: the root layout's title template appends it, and hardcoding
  // it here rendered the site name twice — "Pricing — {site} | {site}".
  title: "Pricing",
  alternates: { canonical: "/pricing" },
  description: `What it costs to ${siteConfig.entity.verb} on ${siteConfig.name}. Every plan keeps your contact details, enquiry form and map pin free to everyone.`,
};

/**
 * The annual view, which is the default because it is the cheaper headline.
 *
 * The interval used to live in `?interval=`, which meant reading searchParams,
 * which forces a route dynamic in Next 16 — so the `revalidate` above was dead
 * and the page the money arrives through re-rendered on every request. It is a
 * path now: this file and /pricing/monthly, both genuinely static.
 */
export default function PricingPage() {
  return <PricingContent interval="annual" />;
}

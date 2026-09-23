import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { PricingContent } from "@/components/pricing/PricingContent";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Pricing",
  /**
   * Canonical to /pricing, not to itself.
   *
   * The two pages are the same plans with one number swapped, so left to
   * compete they would split the signals of the page the money arrives
   * through. This URL exists so the toggle works without JavaScript and so a
   * monthly view is linkable — not so it can rank alongside its own annual
   * twin.
   */
  alternates: { canonical: "/pricing" },
  description: `What it costs to ${siteConfig.entity.verb} on ${siteConfig.name}. Every plan keeps your contact details, enquiry form and map pin free to everyone.`,
};

export default function PricingMonthlyPage() {
  return <PricingContent interval="monthly" />;
}
